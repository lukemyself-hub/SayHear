import {
  ProviderDispatchError,
  type ConversationTextModel,
  type ProviderDispatchErrorCategory,
} from "@sayhear/application";

type ResponsesApiStreamEvent = Readonly<
  { type: string } & Record<string, unknown>
>;

const PROTECTED_REQUEST_KEYS = new Set([
  "input",
  "instructions",
  "model",
  "store",
  "stream",
  "tools",
  "tool_choice",
]);

// Release manifests use the provider-neutral camelCase parameter names that
// are persisted in the model-role ledger. Responses APIs use wire-level
// snake_case names for the same fields. Keep this translation at the transport
// boundary so the frozen application configuration remains unchanged.
const RESPONSES_PARAMETER_ALIASES: Readonly<Record<string, string>> = {
  maxOutputTokens: "max_output_tokens",
};

function providerParameters(
  parameters: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (PROTECTED_REQUEST_KEYS.has(key)) continue;
    const wireKey = RESPONSES_PARAMETER_ALIASES[key] ?? key;
    if (wireKey in result && wireKey !== key) {
      throw new ProviderDispatchError(
        "configuration",
        `Responses API parameter ${wireKey} was supplied more than once.`,
      );
    }
    result[wireKey] = value;
  }
  return result;
}

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
            ...providerParameters(request.parameters),
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
                  // The Responses API carries function tools flat (name,
                  // description, parameters directly on the tool object);
                  // the nested chat-completions `function` wrapper is
                  // rejected with HTTP 400 by both OpenAI and DeepSeek.
                  tool_choice: "auto",
                  tools: request.functions.map((definition) => ({
                    description: definition.description,
                    name: definition.name,
                    parameters: definition.parameters,
                    strict: definition.strict,
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
        // A call to a `visibleReplyRequired` function is buffered until the
        // stream ends: if the Provider answered with the call alone (DeepSeek's
        // reasoning champion leaves the message inside reasoning), the adapter
        // continues the tool loop once below so the decision still carries
        // user-visible text; otherwise the call is surfaced at stream end,
        // after any text, which keeps the harness's text-before-proposal
        // ordering intact.
        let callIdForContinuation: string | null = null;
        let textEmitted = false;
        const visibleReplyFunctions = new Set(
          (request.functions ?? [])
            .filter((definition) => definition.visibleReplyRequired === true)
            .map((definition) => definition.name),
        );
        let pendingBufferedCall: {
          rawArguments: string;
          rawFunctionName: string;
        } | null = null;
        for await (const event of parseServerSentEvents(response.body)) {
          if (event.type === "response.output_text.delta") {
            const delta = event.delta;
            if (typeof delta !== "string") {
              throw new ProviderDispatchError("invalid_response");
            }
            textEmitted = true;
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
              if (typeof item.call_id === "string") {
                callIdForContinuation = item.call_id;
              } else if (typeof item.id === "string") {
                callIdForContinuation = item.id;
              }
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
            if (visibleReplyFunctions.has(functionName)) {
              pendingBufferedCall = {
                rawArguments: functionArguments,
                rawFunctionName: functionName,
              };
            } else {
              yield {
                rawArguments: functionArguments,
                rawFunctionName: functionName,
                type: "tool_call",
              };
            }
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
              if (typeof item.call_id === "string") {
                callIdForContinuation = item.call_id;
              }
              const argumentsValue = item.arguments;
              if (functionCallEmitted) continue;
              if (typeof argumentsValue !== "string") {
                throw new ProviderDispatchError("invalid_response");
              }
              functionCallEmitted = true;
              if (visibleReplyFunctions.has(item.name)) {
                pendingBufferedCall = {
                  rawArguments: argumentsValue,
                  rawFunctionName: item.name,
                };
              } else {
                yield {
                  rawArguments: argumentsValue,
                  rawFunctionName: item.name,
                  type: "tool_call",
                };
              }
            }
          } else if (event.type === "response.completed") {
            const completedResponse = event.response;
            if (!isRecord(completedResponse)) {
              throw new ProviderDispatchError("invalid_response");
            }
            const usage = isRecord(completedResponse.usage)
              ? completedResponse.usage
              : null;
            if (typeof completedResponse.model !== "string") {
              throw new ProviderDispatchError("invalid_response");
            }
            completed = true;

            // Call-only answer for a visibleReplyRequired function: finish
            // the tool loop with one function_call_output round trip so the
            // user still receives a visible reply, then surface the buffered
            // call and a single merged completed event. One ModelRunAttempt
            // stays one logical generation with summed usage.
            let finalUsage = usage;
            let providerRequestId =
              response.headers.get("x-request-id") ??
              (typeof completedResponse.id === "string"
                ? completedResponse.id
                : null) ??
              null;
            if (pendingBufferedCall && !textEmitted) {
              const continuation = await dispatchContinuation({
                apiKey: input.apiKey,
                baseUrl,
                dispatchSignal,
                fetchImplementation,
                functionName: pendingBufferedCall.rawFunctionName,
                rawArguments: pendingBufferedCall.rawArguments,
                callId: callIdForContinuation,
                instructions: request.instructions,
                messages: request.messages,
                model: request.model,
                ...(request.parameters
                  ? { parameters: request.parameters }
                  : {}),
              });
              for await (const delta of continuation.deltas) {
                textEmitted = true;
                yield { delta, type: "delta" };
              }
              if (continuation.usage) {
                finalUsage = {
                  input_tokens:
                    (asOptionalNumber(usage?.input_tokens) ?? 0) +
                    (asOptionalNumber(continuation.usage.input_tokens) ?? 0),
                  output_tokens:
                    (asOptionalNumber(usage?.output_tokens) ?? 0) +
                    (asOptionalNumber(continuation.usage.output_tokens) ?? 0),
                };
              }
              providerRequestId = continuation.providerRequestId ?? providerRequestId;
            }
            if (pendingBufferedCall) {
              yield { ...pendingBufferedCall, type: "tool_call" };
            }
            yield {
              costMicros: null,
              finishReason: "completed",
              inputTokens: asOptionalNumber(finalUsage?.input_tokens),
              modelSnapshot: completedResponse.model,
              outputTokens: asOptionalNumber(finalUsage?.output_tokens),
              providerRequestId,
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

/**
 * One bounded continuation round trip after a call-only response: the original
 * messages plus the function call and its recorded output, with tools omitted
 * so the Provider must answer with the visible reply.
 */
async function dispatchContinuation(input: {
  apiKey: string;
  baseUrl: string;
  dispatchSignal: AbortSignal;
  fetchImplementation: typeof fetch;
  functionName: string;
  rawArguments: string;
  callId: string | null;
  instructions: string;
  messages: readonly Readonly<{
    role: "user" | "assistant";
    text: string;
  }>[];
  model: string;
  parameters?: Readonly<Record<string, unknown>>;
}): Promise<{
  deltas: string[];
  providerRequestId: string | null;
  usage: Record<string, unknown> | null;
}> {
  const callId = input.callId ?? "call_continuation";
  const response = await input.fetchImplementation(`${input.baseUrl}/responses`, {
    body: JSON.stringify({
      input: [
        ...input.messages.map((message) => ({
          content: message.text,
          role: message.role,
        })),
        {
          arguments: input.rawArguments,
          call_id: callId,
          name: input.functionName,
          type: "function_call",
        },
        { call_id: callId, output: "recorded", type: "function_call_output" },
      ],
      instructions: input.instructions,
      model: input.model,
      ...providerParameters(input.parameters),
      store: false,
      stream: true,
    }),
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: input.dispatchSignal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderDispatchError(
      categoryForStatus(response.status),
      `Provider returned HTTP ${response.status}.`,
    );
  }
  if (!response.body) {
    throw new ProviderDispatchError("invalid_response");
  }
  const deltas: string[] = [];
  let usage: Record<string, unknown> | null = null;
  let sawCompleted = false;
  for await (const event of parseServerSentEvents(response.body)) {
    if (event.type === "response.output_text.delta") {
      if (typeof event.delta !== "string") {
        throw new ProviderDispatchError("invalid_response");
      }
      deltas.push(event.delta);
    } else if (event.type === "response.completed") {
      const completedResponse = event.response;
      if (!isRecord(completedResponse)) {
        throw new ProviderDispatchError("invalid_response");
      }
      sawCompleted = true;
      usage = isRecord(completedResponse.usage)
        ? completedResponse.usage
        : null;
    } else if (
      event.type === "error" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      throw new ProviderDispatchError("invalid_response");
    }
  }
  if (!sawCompleted) {
    throw new ProviderDispatchError("invalid_response");
  }
  return {
    deltas,
    providerRequestId: response.headers.get("x-request-id"),
    usage,
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
