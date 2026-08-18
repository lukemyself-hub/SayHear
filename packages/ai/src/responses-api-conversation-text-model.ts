import {
  ProviderDispatchError,
  type ConversationTextModel,
  type ProviderDispatchErrorCategory,
} from "@sayhear/application";

type ResponsesApiStreamEvent = Readonly<
  { type: string } & Record<string, unknown>
>;

/**
 * A provider-agnostic Conversation Text adapter for any Provider that exposes an
 * OpenAI-compatible Responses API (`POST {baseUrl}/responses`, SSE streaming with
 * `response.output_text.delta` / `response.completed`). OpenAI and DeepSeek are
 * two configurations of this client; the Provider identity is carried by the
 * caller's baseUrl/apiKey/model and recorded as a lineage label upstream.
 */
export function createResponsesApiConversationTextModel(input: {
  apiKey: string;
  baseUrl: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}): ConversationTextModel {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const { baseUrl } = input;
  const timeoutMs = input.timeoutMs ?? 60_000;

  return {
    async *stream(request) {
      const deadlineSignal = AbortSignal.timeout(timeoutMs);
      const dispatchSignal = request.signal
        ? AbortSignal.any([request.signal, deadlineSignal])
        : deadlineSignal;
      try {
        const response = await fetchImplementation(`${baseUrl}/responses`, {
          body: JSON.stringify({
            input: request.messages.map((message) => ({
              content: message.text,
              role: message.role,
            })),
            instructions: request.instructions,
            model: request.model,
            store: false,
            stream: true,
            ...(request.functions && request.functions.length > 0
              ? {
                  tool_choice: "auto",
                  tools: request.functions.map((definition) => ({
                    function: {
                      description: definition.description,
                      name: definition.name,
                      parameters: definition.parameters,
                      strict: definition.strict,
                    },
                    type: "function",
                  })),
                }
              : {}),
          }),
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            "content-type": "application/json",
          },
          method: "POST",
          signal: dispatchSignal,
        });

        if (!response.ok) {
          await response.body?.cancel();
          // Carry the concrete HTTP status (never the response body) so an
          // incident log can distinguish a gateway 504 from a rate-limit 429
          // or a config 4xx. Incident 2026-08-18 reported only
          // category=timeout, which hid whether DeepSeek rejected the request
          // or the platform cut the stream.
          throw new ProviderDispatchError(
            categoryForStatus(response.status),
            `Provider returned HTTP ${response.status}.`,
          );
        }
        if (!response.body) {
          throw new ProviderDispatchError("invalid_response");
        }

        let completed = false;
        let functionName: string | null = null;
        let functionArguments = "";
        let functionCallEmitted = false;
        let functionCallStarted = false;
        let functionCallOutputItemDone = false;
        for await (const event of parseServerSentEvents(response.body)) {
          if (event.type === "response.output_text.delta") {
            const delta = event.delta;
            if (typeof delta !== "string") {
              throw new ProviderDispatchError("invalid_response");
            }
            yield { delta, type: "delta" };
          } else if (event.type === "response.output_item.added") {
            const item = isRecord(event.item) ? event.item : null;
            if (
              item &&
              item.type === "function_call" &&
              typeof item.name === "string"
            ) {
              if (functionCallStarted) {
                throw new ProviderDispatchError("invalid_response");
              }
              functionCallStarted = true;
              functionName = item.name;
              if (typeof item.arguments === "string") {
                functionArguments = item.arguments;
              }
            }
          } else if (event.type === "response.function_call_arguments.delta") {
            if (typeof event.delta !== "string") {
              throw new ProviderDispatchError("invalid_response");
            }
            functionArguments += event.delta;
          } else if (event.type === "response.function_call_arguments.done") {
            if (
              typeof event.arguments !== "string" ||
              !functionName ||
              functionCallEmitted
            ) {
              throw new ProviderDispatchError("invalid_response");
            }
            functionArguments = event.arguments;
            functionCallEmitted = true;
            yield {
              rawArguments: functionArguments,
              rawFunctionName: functionName,
              type: "tool_call",
            };
          } else if (event.type === "response.output_item.done") {
            const item = isRecord(event.item) ? event.item : null;
            if (item && item.type === "function_call") {
              if (
                functionCallOutputItemDone ||
                typeof item.name !== "string"
              ) {
                throw new ProviderDispatchError("invalid_response");
              }
              functionCallOutputItemDone = true;
              if (!functionCallStarted) functionCallStarted = true;
              const argumentsValue = item.arguments;
              if (functionCallEmitted) continue;
              if (typeof argumentsValue !== "string") {
                throw new ProviderDispatchError("invalid_response");
              }
              functionCallEmitted = true;
              yield {
                rawArguments: argumentsValue,
                rawFunctionName: item.name,
                type: "tool_call",
              };
            }
          } else if (event.type === "response.completed") {
            const completedResponse = event.response;
            if (!isRecord(completedResponse)) {
              throw new ProviderDispatchError("invalid_response");
            }
            const usage = isRecord(completedResponse.usage)
              ? completedResponse.usage
              : null;
            completed = true;
            yield {
              costMicros: null,
              finishReason: "completed",
              inputTokens: asOptionalNumber(usage?.input_tokens),
              modelSnapshot:
                typeof completedResponse.model === "string"
                  ? completedResponse.model
                  : request.model,
              outputTokens: asOptionalNumber(usage?.output_tokens),
              providerRequestId:
                response.headers.get("x-request-id") ??
                (typeof completedResponse.id === "string"
                  ? completedResponse.id
                  : null) ??
                null,
              type: "completed",
            };
          } else if (
            event.type === "error" ||
            event.type === "response.failed" ||
            event.type === "response.incomplete"
          ) {
            throw new ProviderDispatchError("invalid_response");
          }
        }
        if (!completed) {
          throw new ProviderDispatchError("invalid_response");
        }
      } catch (error) {
        if (error instanceof ProviderDispatchError) {
          throw error;
        }
        if (request.signal?.aborted) {
          throw new ProviderDispatchError("aborted");
        }
        if (deadlineSignal.aborted) {
          throw new ProviderDispatchError("timeout");
        }
        throw new ProviderDispatchError(
          error instanceof TypeError ? "unavailable" : "unknown",
        );
      }
    },
  };
}

async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<ResponsesApiStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(result.value, { stream: true });
      }
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new ProviderDispatchError("invalid_response");
          }
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            !("type" in parsed) ||
            typeof parsed.type !== "string"
          ) {
            throw new ProviderDispatchError("invalid_response");
          }
          yield parsed as ResponsesApiStreamEvent;
        }
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
      if (result.done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function categoryForStatus(status: number): ProviderDispatchErrorCategory {
  if (status === 401 || status === 403) {
    return "authentication";
  }
  if (status === 400 || status === 404 || status === 422) {
    return "configuration";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 408 || status === 504) {
    return "timeout";
  }
  if (status >= 500) {
    return "unavailable";
  }
  return "invalid_response";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
