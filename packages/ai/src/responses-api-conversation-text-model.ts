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
          throw new ProviderDispatchError(categoryForStatus(response.status));
        }
        if (!response.body) {
          throw new ProviderDispatchError("invalid_response");
        }

        let completed = false;
        for await (const event of parseServerSentEvents(response.body)) {
          if (event.type === "response.output_text.delta") {
            const delta = event.delta;
            if (typeof delta !== "string") {
              throw new ProviderDispatchError("invalid_response");
            }
            yield { delta, type: "delta" };
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
