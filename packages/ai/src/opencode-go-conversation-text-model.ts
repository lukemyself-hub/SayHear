import {
  ProviderDispatchError,
  type ConversationFunctionDefinition,
  type ConversationTextModel,
  type ConversationTextModelRequest,
  type ModelRoleCallUsage,
  type ProviderDispatchErrorCategory,
  type ProviderResponseFailure,
} from "@sayhear/application";

/**
 * The OpenCode Go Chat Completions transport. OpenCode Go exposes DeepSeek V4.1
 * Flash behind an OpenAI-compatible Chat Completions endpoint rather than the
 * Responses API the rest of the runtime uses, so the frozen application
 * configuration (camelCase `maxOutputTokens`, `reasoning.effort`) is translated
 * to the wire shape here and nowhere else.
 *
 * The endpoint is fixed to the documented Go route. There is no baseUrl input,
 * so a misconfiguration cannot silently point the transport at a different
 * Provider, and no caller can retarget it at a non-Go host.
 */
const OPENCODE_GO_ENDPOINT =
  "https://opencode.ai/zen/go/v1/chat/completions";

/** The only model this transport is allowed to request. */
const OPENCODE_GO_MODEL = "deepseek-v4.1-flash";

/** The transport's honest, stable User-Agent. It never impersonates a client. */
const OPENCODE_GO_USER_AGENT = "SayHear/1.0";

/** Bounds the opaque session header so it can never be a request body. */
const PROVIDER_SESSION_ID_MAX_LENGTH = 200;

/**
 * Request fields the transport owns. A frozen `parameters` snapshot must never
 * override them, because doing so would silently change the wire contract the
 * release pinned.
 */
const PROTECTED_REQUEST_KEYS = new Set([
  "input",
  "instructions",
  "messages",
  "model",
  "store",
  "stream",
  "stream_options",
  "tool_choice",
  "tools",
]);

/**
 * Wire fields that only exist on the Responses API. Forwarding one would send
 * an unknown field to Chat Completions, so they are rejected rather than
 * leaked.
 */
const RESPONSES_ONLY_PARAMETER_KEYS = new Set([
  "include",
  "max_output_tokens",
  "previous_response_id",
]);

/**
 * Release manifests persist provider-neutral camelCase names; Chat Completions
 * uses snake_case. `maxOutputTokens` is the only frozen cap alias.
 */
const CHAT_PARAMETER_ALIASES: Readonly<Record<string, string>> = {
  maxOutputTokens: "max_tokens",
};

/** The reasoning efforts OpenCode Go documents for DeepSeek V4.1 Flash. */
const REASONING_EFFORTS = new Set(["low", "high", "max"]);

/** Terminal finish reasons this transport recognizes as a successful end. */
const RECOGNIZED_FINISH_REASONS = new Set(["stop", "tool_calls"]);

/**
 * A Chat Completions adapter for the OpenCode Go endpoint. It implements the
 * existing `ConversationTextModel` contract so the harness and Egress Port are
 * unchanged; only the wire protocol differs.
 */
export function createOpenCodeGoConversationTextModel(input: {
  apiKey: string;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}): ConversationTextModel {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const timeoutMs = input.timeoutMs ?? 60_000;

  return {
    async *stream(request) {
      // The transport refuses to request any model but the pinned Go model.
      // This is a configuration failure, never a silent model substitution.
      if (request.model !== OPENCODE_GO_MODEL) {
        throw new ProviderDispatchError(
          "configuration",
          `OpenCode Go requires the pinned model ${OPENCODE_GO_MODEL}.`,
        );
      }
      // A caller-owned opaque session identity is mandatory. There is no
      // random fallback and no shared sentinel: an absent identity would make
      // every request indistinguishable at the Provider, which is exactly the
      // privacy boundary this header must not erase.
      const providerSessionId = request.providerSessionId;
      if (
        typeof providerSessionId !== "string" ||
        !isHeaderSafeSessionId(providerSessionId)
      ) {
        throw new ProviderDispatchError(
          "configuration",
          "OpenCode Go requires a non-empty, bounded, header-safe providerSessionId.",
        );
      }

      const deadlineSignal = AbortSignal.timeout(timeoutMs);
      const dispatchSignal = request.signal
        ? AbortSignal.any([request.signal, deadlineSignal])
        : deadlineSignal;

      // Usage is observed per actual Provider call but reported once per
      // logical call, after both calls when a continuation ran. Counters stay
      // in the outer scope so a late protocol/EOF/abort failure can still
      // report the spend it already saw.
      let firstUsage: Record<string, unknown> | null = null;
      let secondUsage: Record<string, unknown> | null = null;
      let secondCallStarted = false;
      let usageReported = false;
      // PROTOTYPE ONLY: usage of the earlier steps of a structure-3 tool loop.
      const prototypeUsages: Record<string, unknown>[] = [];
      const currentAggregate = (): ModelRoleCallUsage | null => {
        const usages: (ModelRoleCallUsage | null)[] = [
          ...prototypeUsages.map((usage) => normalizedUsage(usage)),
          firstUsage === null ? null : normalizedUsage(firstUsage),
        ];
        if (secondCallStarted) {
          usages.push(secondUsage === null ? null : normalizedUsage(secondUsage));
        }
        return aggregateUsage(usages);
      };
      const reportUsage = (): void => {
        if (usageReported) return;
        const aggregate = currentAggregate();
        if (aggregate === null) return;
        usageReported = true;
        try {
          request.onUsage?.(aggregate);
        } catch {
          // A reporting callback must never change the transport outcome.
        }
      };

      try {
        // PROTOTYPE ONLY (structure 3): the history lookup is answered inside
        // this model conversation as a tool result, for up to maxSteps lookups.
        const prototypeLoop = request.prototypeLoop;
        const prototypeExtraMessages: Record<string, unknown>[] = [];
        let prototypeLookups = 0;
        let firstOutcome: ChatStreamOutcome | null = null;
        const functions = request.functions ?? [];
        const toolsOffered =
          request.toolsDisabled !== true && functions.length > 0;
        for (;;) {
        firstUsage = null;
        const prototypeExhausted =
          prototypeLoop !== undefined && prototypeLookups >= prototypeLoop.maxSteps;
        const response = await fetchImplementation(OPENCODE_GO_ENDPOINT, {
          body: JSON.stringify(
            chatRequestBody(
              request,
              prototypeExtraMessages,
              prototypeExhausted ? prototypeLoop.functionName : undefined,
            ),
          ),
          headers: chatHeaders(input.apiKey, providerSessionId),
          method: "POST",
          // A redirect is never followed: the endpoint is fixed and an
          // injected redirect could exfiltrate the credential to another host.
          redirect: "error",
          signal: dispatchSignal,
        });

        if (!response.ok) {
          await response.body?.cancel();
          // The concrete HTTP status (never the response body) is carried so
          // an incident log can distinguish auth, rate-limit, and gateway
          // failures without echoing Provider text.
          throw new ProviderDispatchError(
            categoryForStatus(response.status),
            `Provider returned HTTP ${response.status}.`,
          );
        }
        if (!response.body) {
          throw new ProviderDispatchError("invalid_response");
        }

        let stepOutcome: ChatStreamOutcome | null = null;
        for await (const item of parseChatCompletion({
          body: response.body,
          expectedModel: OPENCODE_GO_MODEL,
          headerRequestId: response.headers.get("x-request-id"),
          onUsageObserved: (observed) => {
            firstUsage = observed;
          },
          toolsOffered,
        })) {
          if (item.type === "delta") {
            yield { delta: item.delta, type: "delta" };
          } else {
            stepOutcome = item.outcome;
          }
        }
        if (stepOutcome === null) {
          throw new ProviderDispatchError("invalid_response");
        }
        const settled: ChatStreamOutcome = stepOutcome;
        const stepCalls = sortedToolCalls(settled.toolCalls).map(([, call]) => call);
        const historyCalls = prototypeLoop
          ? stepCalls.filter((call) => call.name === prototypeLoop.functionName)
          : [];
        if (
          prototypeLoop === undefined ||
          historyCalls.length === 0 ||
          settled.emittedTextLength > 0 ||
          prototypeExhausted
        ) {
          // Final step: any leftover lookup call is dropped, never surfaced.
          firstOutcome =
            historyCalls.length === 0
              ? settled
              : {
                  ...settled,
                  toolCalls: new Map(
                    [...settled.toolCalls].filter(
                      ([, call]) => call.name !== prototypeLoop!.functionName,
                    ),
                  ),
                };
          break;
        }
        if (firstUsage !== null) prototypeUsages.push(firstUsage);
        for (const call of stepCalls) {
          if (call.id === null) throw new ProviderDispatchError("invalid_response");
        }
        prototypeExtraMessages.push({
          content: null,
          reasoning_content: "",
          role: "assistant",
          tool_calls: stepCalls.map((call) => ({
            function: { arguments: call.arguments, name: call.name },
            id: call.id,
            type: "function",
          })),
        });
        for (const call of stepCalls) {
          let output: string;
          if (call.name !== prototypeLoop.functionName) {
            output =
              "Not done in this step. If it is still needed, call it again on its own after the lookup.";
          } else if (prototypeLookups >= prototypeLoop.maxSteps) {
            output =
              "The lookup limit for this reply is reached. Reply now from what you already have.";
          } else {
            prototypeLookups += 1;
            output = await prototypeLoop.execute(call.arguments);
          }
          prototypeExtraMessages.push({ content: output, role: "tool", tool_call_id: call.id });
        }
        }
        if (firstOutcome === null) {
          throw new ProviderDispatchError("invalid_response");
        }

        // A `visibleReplyRequired` selection is a proposal channel whose reply
        // must arrive in the same logical generation. It is buffered, and if
        // the first response carried no visible text the adapter makes exactly
        // one bounded continuation round trip with tools omitted so the user
        // still receives a reply before the buffered call. Every other call is
        // surfaced immediately, exactly as before.
        const visibleReplyFunctions = new Set(
          functions
            .filter((definition) => definition.visibleReplyRequired === true)
            .map((definition) => definition.name),
        );
        const buffered: ToolCallAccumulator[] = [];
        const immediate: ToolCallAccumulator[] = [];
        for (const [, call] of sortedToolCalls(firstOutcome.toolCalls)) {
          if (visibleReplyFunctions.has(call.name)) {
            buffered.push(call);
          } else {
            immediate.push(call);
          }
        }

        let continuationDeltas: readonly string[] = [];
        let continuationRequestId: string | null = null;
        if (buffered.length > 0 && firstOutcome.emittedTextLength === 0) {
          // The continuation echoes the Provider-issued call identity; there
          // is no fabrication fallback, so a call without an id fails closed.
          for (const call of buffered) {
            if (call.id === null) {
              throw new ProviderDispatchError("invalid_response");
            }
          }
          secondCallStarted = true;
          const continuation = await dispatchChatContinuation({
            apiKey: input.apiKey,
            dispatchSignal,
            fetchImplementation,
            onUsageObserved: (observed) => {
              secondUsage = observed;
            },
            providerSessionId,
            prototypeExtraMessages,
            request,
            toolCalls: buffered,
          });
          // Both responses must agree on the model identity; a mismatch is a
          // failure, never a hidden substitution.
          if (continuation.modelSnapshot !== firstOutcome.modelSnapshot) {
            throw new ProviderDispatchError("invalid_response");
          }
          continuationDeltas = continuation.deltas;
          continuationRequestId = continuation.providerRequestId;
        }

        reportUsage();
        for (const delta of continuationDeltas) {
          yield { delta, type: "delta" };
        }
        for (const call of buffered) {
          yield {
            rawArguments: call.arguments,
            rawFunctionName: call.name,
            type: "tool_call",
          };
        }
        for (const call of immediate) {
          yield {
            rawArguments: call.arguments,
            rawFunctionName: call.name,
            type: "tool_call",
          };
        }

        const aggregate = currentAggregate();
        yield {
          costMicros: null,
          finishReason: "completed",
          inputTokens: aggregate?.inputTokens ?? null,
          modelSnapshot: firstOutcome.modelSnapshot,
          outputTokens: aggregate?.outputTokens ?? null,
          providerRequestId:
            continuationRequestId ?? firstOutcome.providerRequestId,
          reasoningTokens: aggregate?.reasoningTokens ?? null,
          // Reported only: an absent split or total stays absent rather than
          // becoming an invented zero or a derived sum.
          ...(aggregate?.cachedTokens == null
            ? {}
            : { cachedTokens: aggregate.cachedTokens }),
          ...(aggregate?.totalTokens == null
            ? {}
            : { totalTokens: aggregate.totalTokens }),
          type: "completed",
        };
      } catch (error) {
        // A late protocol/EOF/abort failure still reports any usage already
        // observed, at most once, before the error is classified.
        reportUsage();
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

type ToolCallAccumulator = {
  arguments: string;
  id: string | null;
  name: string;
};

type ChatStreamOutcome = Readonly<{
  emittedTextLength: number;
  finishReason: string;
  modelSnapshot: string;
  providerRequestId: string | null;
  toolCalls: ReadonlyMap<number, ToolCallAccumulator>;
}>;

type ChatStreamItem =
  | Readonly<{ delta: string; type: "delta" }>
  | Readonly<{ outcome: ChatStreamOutcome; type: "result" }>;

/**
 * Parse and validate one Chat Completions response. It yields visible text
 * deltas live and, on a valid terminal, exactly one result item. Any malformed,
 * truncated, unauthorized, or unterminated stream throws a typed failure
 * instead of yielding a result.
 */
async function* parseChatCompletion(input: {
  body: ReadableStream<Uint8Array>;
  expectedModel: string;
  headerRequestId: string | null;
  onUsageObserved: (usage: Record<string, unknown>) => void;
  toolsOffered: boolean;
}): AsyncIterable<ChatStreamItem> {
  let sawDone = false;
  let finishReason: string | null = null;
  let modelSnapshot: string | null = null;
  let providerRequestId = input.headerRequestId;
  let usage: Record<string, unknown> | null = null;
  let emittedTextLength = 0;
  // Tool calls are assembled by delta index until the terminal event, so a
  // partial call is never surfaced. `id` is tracked only to reject a stream
  // that reassigns one call's identity mid-flight.
  const toolCalls = new Map<number, ToolCallAccumulator>();

  for await (const item of parseChatSse(input.body)) {
    if (item.type === "done") {
      sawDone = true;
      // Stop reading immediately: a framed `[DONE]` is the terminal signal.
      // Breaking lets the parser's `return` path cancel and release the reader
      // instead of waiting for socket EOF.
      break;
    }
    const chunk = item.value;
    // Parse any validly reported usage before every other check. A terminal
    // chunk can carry a valid usage record alongside a streamed error, an
    // unexpected model, or invalid choices; capturing the spend first is what
    // lets the failure path report the exact known counters at most once. An
    // unknown or absent counter stays null and is never invented or summed.
    if (chunk.usage !== undefined && chunk.usage !== null) {
      if (!isRecord(chunk.usage)) {
        throw new ProviderDispatchError("invalid_response");
      }
      usage = chunk.usage;
      input.onUsageObserved(usage);
    }
    // A streamed error payload is a terminal Provider failure. Its body is
    // never inspected or echoed.
    if (chunk.error !== undefined && chunk.error !== null) {
      throw new ProviderDispatchError("invalid_response");
    }
    if (
      chunk.id !== undefined &&
      chunk.id !== null &&
      typeof chunk.id !== "string"
    ) {
      throw new ProviderDispatchError("invalid_response");
    }
    if (typeof chunk.id === "string") {
      providerRequestId = providerRequestId ?? chunk.id;
    }
    if (chunk.model !== undefined) {
      if (typeof chunk.model !== "string") {
        throw new ProviderDispatchError("invalid_response");
      }
      if (modelSnapshot === null) {
        // The first Provider-reported model identity must be exactly the
        // pinned model. A different id is a substituted or renamed model, not
        // a value to pass through for a later comparison: rejecting it here
        // fails the very first call for every caller (conversation, Journal,
        // and each G1 role) instead of letting an honest-looking completion
        // escape with a model nobody authorized.
        if (chunk.model !== input.expectedModel) {
          throw new ProviderDispatchError("invalid_response");
        }
        modelSnapshot = chunk.model;
      } else if (modelSnapshot !== chunk.model) {
        // Conflicting model identities inside one stream cannot be resolved
        // into a single snapshot; surface the failure instead of fabricating
        // one.
        throw new ProviderDispatchError("invalid_response");
      }
    }

    const choices = chunk.choices;
    if (!Array.isArray(choices)) {
      throw new ProviderDispatchError("invalid_response");
    }
    if (choices.length > 1) {
      throw new ProviderDispatchError("invalid_response");
    }
    if (choices.length === 0) continue;
    const choice = choices[0];
    if (!isRecord(choice)) {
      throw new ProviderDispatchError("invalid_response");
    }
    if (choice.index !== 0) {
      throw new ProviderDispatchError("invalid_response");
    }

    const delta = choice.delta;
    if (delta !== undefined && delta !== null && !isRecord(delta)) {
      throw new ProviderDispatchError("invalid_response");
    }
    if (isRecord(delta)) {
      const content = delta.content;
      if (content !== undefined && content !== null) {
        if (typeof content !== "string") {
          throw new ProviderDispatchError("invalid_response");
        }
        if (content.length > 0) {
          emittedTextLength += content.length;
          yield { delta: content, type: "delta" };
        }
      }
      // `reasoning_content` is discarded completely: it is neither emitted as
      // visible text nor persisted, and it is never re-injected as a
      // historical assistant field.
      if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
        if (!input.toolsOffered) {
          // No tools were offered, so a tool call is unauthorized.
          throw new ProviderDispatchError("invalid_response");
        }
        if (!Array.isArray(delta.tool_calls)) {
          throw new ProviderDispatchError("invalid_response");
        }
        for (const fragment of delta.tool_calls) {
          accumulateToolCall(fragment, toolCalls);
        }
      }
    }

    const choiceFinishReason = choice.finish_reason;
    if (choiceFinishReason !== undefined && choiceFinishReason !== null) {
      if (typeof choiceFinishReason !== "string") {
        throw new ProviderDispatchError("invalid_response");
      }
      if (finishReason !== null && finishReason !== choiceFinishReason) {
        throw new ProviderDispatchError("invalid_response");
      }
      finishReason = choiceFinishReason;
    }
  }

  // A completion requires the `[DONE]` sentinel, a Provider-reported model
  // identity, and a terminal finish reason. EOF without any of them is an
  // incomplete stream, never a success.
  if (!sawDone || modelSnapshot === null || finishReason === null) {
    throw new ProviderDispatchError("invalid_response");
  }
  if (finishReason === "length") {
    // `length` is the Chat Completions signal that the pinned cap cut the
    // generation short. It is a content-free failure carrying the same usage a
    // success would, so the next versioned budget can be chosen from evidence
    // rather than a guess.
    throw new ProviderDispatchError(
      "invalid_response",
      "The Provider reported that it stopped at the pinned output budget.",
      true,
      outputBudgetFailure(usage, emittedTextLength),
    );
  }
  if (!RECOGNIZED_FINISH_REASONS.has(finishReason)) {
    // Any other terminal reason (content_filter, an unknown safety stop) is
    // rejected rather than reported as a completed turn.
    throw new ProviderDispatchError("invalid_response");
  }
  if (finishReason === "tool_calls") {
    if (toolCalls.size === 0) {
      throw new ProviderDispatchError("invalid_response");
    }
  } else if (toolCalls.size > 0 || emittedTextLength === 0) {
    // A `stop` stream that carried tool fragments, or that produced only
    // reasoning and no visible text, is not a usable turn.
    throw new ProviderDispatchError("invalid_response");
  }
  for (const [, call] of sortedToolCalls(toolCalls)) {
    if (call.name === "") {
      throw new ProviderDispatchError("invalid_response");
    }
  }

  yield {
    outcome: {
      emittedTextLength,
      finishReason,
      modelSnapshot,
      providerRequestId: providerRequestId ?? null,
      toolCalls,
    },
    type: "result",
  };
}

/**
 * The one bounded continuation round trip after a call-only
 * `visibleReplyRequired` selection. It reuses the same fixed endpoint, model,
 * frozen parameters, opaque session header, and overall abort deadline, omits
 * tools entirely, and echoes the original assistant tool calls plus their
 * recorded outputs. The visible reply it streams is yielded before the
 * buffered call by the caller.
 */
async function dispatchChatContinuation(input: {
  apiKey: string;
  dispatchSignal: AbortSignal;
  fetchImplementation: typeof fetch;
  onUsageObserved: (usage: Record<string, unknown>) => void;
  providerSessionId: string;
  prototypeExtraMessages?: readonly Record<string, unknown>[];
  request: ConversationTextModelRequest;
  toolCalls: readonly ToolCallAccumulator[];
}): Promise<{
  deltas: readonly string[];
  modelSnapshot: string;
  providerRequestId: string | null;
}> {
  const response = await input.fetchImplementation(OPENCODE_GO_ENDPOINT, {
    body: JSON.stringify(
      chatContinuationBody(input.request, input.toolCalls, input.prototypeExtraMessages ?? []),
    ),
    headers: chatHeaders(input.apiKey, input.providerSessionId),
    method: "POST",
    redirect: "error",
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
  let outcome: ChatStreamOutcome | null = null;
  for await (const item of parseChatCompletion({
    body: response.body,
    expectedModel: OPENCODE_GO_MODEL,
    headerRequestId: response.headers.get("x-request-id"),
    onUsageObserved: input.onUsageObserved,
    toolsOffered: false,
  })) {
    if (item.type === "delta") {
      deltas.push(item.delta);
    } else {
      outcome = item.outcome;
    }
  }
  if (outcome === null) {
    throw new ProviderDispatchError("invalid_response");
  }
  return {
    deltas,
    modelSnapshot: outcome.modelSnapshot,
    providerRequestId: outcome.providerRequestId,
  };
}

function chatHeaders(
  apiKey: string,
  providerSessionId: string,
): Record<string, string> {
  return {
    accept: "text/event-stream",
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "user-agent": OPENCODE_GO_USER_AGENT,
    "x-opencode-session": providerSessionId,
  };
}

/**
 * Build the Chat Completions body from the frozen request. The request object
 * itself is never mutated: instructions become the system message, user and
 * assistant messages keep their order, and only historical assistant messages
 * carry the empty `reasoning_content` the public OpenCode transform emits (no
 * reasoning is ever invented or persisted).
 */
function prototypeInstructions(request: ConversationTextModelRequest): string {
  return request.prototypePreface
    ? `${request.instructions}\n\n${request.prototypePreface}`
    : request.instructions;
}

function chatRequestBody(
  request: ConversationTextModelRequest,
  prototypeExtraMessages: readonly Record<string, unknown>[] = [],
  prototypeOmitFunction?: string,
): Record<string, unknown> {
  const functions = (request.functions ?? []).filter(
    (definition) => definition.name !== prototypeOmitFunction,
  );
  const toolsOffered = request.toolsDisabled !== true && functions.length > 0;
  return {
    ...translateParameters(request.parameters),
    messages: [
      { content: prototypeInstructions(request), role: "system" },
      ...request.messages.map((message) =>
        message.role === "assistant"
          ? {
              content: message.text,
              reasoning_content: "",
              role: "assistant",
            }
          : { content: message.text, role: "user" },
      ),
      ...prototypeExtraMessages,
    ],
    model: OPENCODE_GO_MODEL,
    stream: true,
    stream_options: { include_usage: true },
    ...(toolsOffered
      ? {
          tool_choice: "auto",
          tools: functions.map(toChatTool),
        }
      : {}),
  };
}

/**
 * Build the single continuation body: the original conversation, then the
 * assistant tool calls exactly as the Provider issued them (ids, names,
 * arguments), then their recorded outputs. Tools and tool_choice are omitted so
 * the Provider must answer with the visible reply.
 */
function chatContinuationBody(
  request: ConversationTextModelRequest,
  toolCalls: readonly ToolCallAccumulator[],
  prototypeExtraMessages: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    ...translateParameters(request.parameters),
    messages: [
      { content: prototypeInstructions(request), role: "system" },
      ...request.messages.map((message) =>
        message.role === "assistant"
          ? {
              content: message.text,
              reasoning_content: "",
              role: "assistant",
            }
          : { content: message.text, role: "user" },
      ),
      ...prototypeExtraMessages,
      {
        content: null,
        reasoning_content: "",
        role: "assistant",
        tool_calls: toolCalls.map((call) => ({
          function: { arguments: call.arguments, name: call.name },
          id: call.id,
          type: "function",
        })),
      },
      ...toolCalls.map((call) => ({
        content: "recorded",
        role: "tool",
        tool_call_id: call.id,
      })),
    ],
    model: OPENCODE_GO_MODEL,
    stream: true,
    stream_options: { include_usage: true },
  };
}

/**
 * Translate the frozen camelCase parameter snapshot to the Chat Completions
 * wire shape. The cap and reasoning effort are translated, never clamped or
 * coerced: an unrecognized effort is a configuration failure, and a field that
 * would override a transport-owned key is rejected rather than silently
 * dropped or leaked.
 */
function translateParameters(
  parameters: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters ?? {})) {
    if (key === "reasoning") continue;
    if (
      PROTECTED_REQUEST_KEYS.has(key) ||
      RESPONSES_ONLY_PARAMETER_KEYS.has(key)
    ) {
      throw new ProviderDispatchError(
        "configuration",
        `Chat Completions parameter ${key} cannot override the frozen request.`,
      );
    }
    const wireKey = CHAT_PARAMETER_ALIASES[key] ?? key;
    if (wireKey in result) {
      throw new ProviderDispatchError(
        "configuration",
        `Chat Completions parameter ${wireKey} was supplied more than once.`,
      );
    }
    result[wireKey] = value;
  }

  const reasoning = parameters?.reasoning;
  if (reasoning !== undefined) {
    if (
      !isRecord(reasoning) ||
      typeof reasoning.effort !== "string" ||
      !REASONING_EFFORTS.has(reasoning.effort)
    ) {
      throw new ProviderDispatchError(
        "configuration",
        "reasoning.effort must be one of low, high, or max.",
      );
    }
    if ("reasoning_effort" in result || "thinking" in result) {
      throw new ProviderDispatchError(
        "configuration",
        "reasoning conflicts with an explicit reasoning_effort or thinking parameter.",
      );
    }
    result.reasoning_effort = reasoning.effort;
    result.thinking = { type: "enabled" };
  }

  return result;
}

function toChatTool(
  definition: ConversationFunctionDefinition,
): Record<string, unknown> {
  // Chat Completions nests the definition under `function`; the flat Responses
  // shape is rejected with HTTP 400.
  return {
    function: {
      description: definition.description,
      name: definition.name,
      parameters: definition.parameters,
      strict: definition.strict,
    },
    type: "function",
  };
}

/**
 * Accumulate one streamed tool-call fragment. Fragments are grouped by their
 * non-negative integer index; a fragment that reassigns a recorded id or name
 * is a conflict and fails the stream. Arguments are concatenated exactly as
 * received, so the assembled call is never a partial argument string.
 */
function accumulateToolCall(
  fragment: unknown,
  toolCalls: Map<number, ToolCallAccumulator>,
): void {
  if (!isRecord(fragment)) {
    throw new ProviderDispatchError("invalid_response");
  }
  const index = fragment.index;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    throw new ProviderDispatchError("invalid_response");
  }
  const state = toolCalls.get(index) ?? {
    arguments: "",
    id: null,
    name: "",
  };
  if (fragment.id !== undefined && fragment.id !== null) {
    if (typeof fragment.id !== "string") {
      throw new ProviderDispatchError("invalid_response");
    }
    if (state.id !== null && state.id !== fragment.id) {
      throw new ProviderDispatchError("invalid_response");
    }
    state.id = fragment.id;
  }
  const fn = fragment.function;
  if (fn !== undefined && fn !== null) {
    if (!isRecord(fn)) {
      throw new ProviderDispatchError("invalid_response");
    }
    if (fn.name !== undefined && fn.name !== null) {
      if (typeof fn.name !== "string") {
        throw new ProviderDispatchError("invalid_response");
      }
      if (state.name !== "" && state.name !== fn.name) {
        throw new ProviderDispatchError("invalid_response");
      }
      state.name = fn.name;
    }
    if (fn.arguments !== undefined && fn.arguments !== null) {
      if (typeof fn.arguments !== "string") {
        throw new ProviderDispatchError("invalid_response");
      }
      state.arguments += fn.arguments;
    }
  }
  toolCalls.set(index, state);
}

function sortedToolCalls(
  toolCalls: ReadonlyMap<number, ToolCallAccumulator>,
): readonly [number, ToolCallAccumulator][] {
  return [...toolCalls.entries()].sort(([left], [right]) => left - right);
}

type ChatSseItem =
  | Readonly<{ type: "chunk"; value: Record<string, unknown> }>
  | Readonly<{ type: "done" }>;

/**
 * Frame a Chat Completions SSE body. The parser is tolerant of arbitrary
 * network chunk boundaries, CRLF or LF framing, split UTF-8 sequences,
 * multiline `data:` fields, and a final event with no trailing blank line. It
 * yields a `done` item for `[DONE]`; malformed JSON is a typed failure. On any
 * early consumer return the reader is cancelled and released.
 */
async function* parseChatSse(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<ChatSseItem> {
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
        const item = parseChatSseBlock(block);
        if (item) yield item;
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
      if (result.done) break;
    }
    // Final framing: an event that arrived without its blank-line terminator.
    if (buffer.trim() !== "") {
      const item = parseChatSseBlock(buffer);
      buffer = "";
      if (item) yield item;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already closed or errored; releasing the lock is enough.
    }
    reader.releaseLock();
  }
}

function parseChatSseBlock(block: string): ChatSseItem | null {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return { type: "done" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ProviderDispatchError("invalid_response");
  }
  if (!isRecord(parsed)) {
    throw new ProviderDispatchError("invalid_response");
  }
  return { type: "chunk", value: parsed };
}

/**
 * A `length` finish is the Chat Completions proof that the frozen cap cut the
 * generation short. It carries the same content-free usage as a success so the
 * failure is accountable; `outputLength` is a character count, never text. The
 * Provider's literal reason is `length`, kept distinct from the Responses
 * API's `max_output_tokens` so evidence records what was actually reported.
 */
function outputBudgetFailure(
  usage: Record<string, unknown> | null,
  outputLength: number,
): ProviderResponseFailure {
  return {
    cachedTokens: cachedTokensFrom(usage),
    inputTokens: safeTokenCount(usage?.prompt_tokens),
    kind: "output_budget_exhausted",
    outputLength,
    outputTokens: safeTokenCount(usage?.completion_tokens),
    providerReason: "length",
    reasoningTokens: reasoningTokensFrom(usage),
    totalTokens: safeTokenCount(usage?.total_tokens),
  };
}

/**
 * The five content-free counters, with any unknown field kept `null`. This is
 * the same shape the completed event reports and the only shape the usage
 * callback receives.
 */
function normalizedUsage(usage: Record<string, unknown>): ModelRoleCallUsage {
  return {
    cachedTokens: cachedTokensFrom(usage),
    inputTokens: safeTokenCount(usage.prompt_tokens),
    outputTokens: safeTokenCount(usage.completion_tokens),
    reasoningTokens: reasoningTokensFrom(usage),
    totalTokens: safeTokenCount(usage.total_tokens),
  };
}

/**
 * Aggregate one logical call's counters across its actual Provider calls. A
 * counter is summed only when every call reported a known safe count; if any
 * call is missing (no usage record, or an unknown counter), that counter stays
 * `null` rather than becoming an invented zero. All calls missing usage yields
 * no report at all.
 */
function aggregateUsage(
  usages: readonly (ModelRoleCallUsage | null)[],
): ModelRoleCallUsage | null {
  if (usages.length === 0 || usages.every((usage) => usage === null)) {
    return null;
  }
  return {
    cachedTokens: sumKnownCount(usages, (usage) => usage.cachedTokens),
    inputTokens: sumKnownCount(usages, (usage) => usage.inputTokens),
    outputTokens: sumKnownCount(usages, (usage) => usage.outputTokens),
    reasoningTokens: sumKnownCount(usages, (usage) => usage.reasoningTokens),
    totalTokens: sumKnownCount(usages, (usage) => usage.totalTokens),
  };
}

function sumKnownCount(
  usages: readonly (ModelRoleCallUsage | null)[],
  pick: (usage: ModelRoleCallUsage) => number | null,
): number | null {
  let sum = 0;
  for (const usage of usages) {
    if (usage === null) return null;
    const value = pick(usage);
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

/** Cached input tokens live under `usage.prompt_tokens_details.cached_tokens`. */
function cachedTokensFrom(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  const details = usage.prompt_tokens_details;
  if (!isRecord(details)) return null;
  return safeTokenCount(details.cached_tokens);
}

/** Reasoning tokens live under `usage.completion_tokens_details`. */
function reasoningTokensFrom(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  const details = usage.completion_tokens_details;
  if (!isRecord(details)) return null;
  return safeTokenCount(details.reasoning_tokens);
}

/**
 * A token counter enters the completed event only as a finite, non-negative,
 * safe integer. Anything else is unknown (`null`), never a zero or a derived
 * total.
 */
function safeTokenCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

/**
 * The opaque session header must be non-empty, bounded, and printable ASCII.
 * A value carrying CR/LF or non-ASCII is rejected so it can never inject a
 * header or leave the header grammar.
 */
function isHeaderSafeSessionId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= PROVIDER_SESSION_ID_MAX_LENGTH &&
    // Visible ASCII with no spaces: a token, not free text.
    /^[\x21-\x7E]+$/.test(value)
  );
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
