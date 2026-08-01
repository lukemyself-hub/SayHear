import {
  ProviderDispatchError,
  detectMinimumHighRiskSignal,
  renderMinimumHighRiskResponse,
  type ConversationTextModel,
  type ConversationTextMessage,
} from "@sayhear/application";

/**
 * The behavior the deterministic Champion selects for a turn.
 *
 * - `understanding`: an ordinary 1A.1 Understanding Response from the responder.
 * - `minimum_high_risk`: the versioned Minimum High-Risk Response that pauses
 *   ordinary listening, follow-up, and advice.
 */
type ConversationBehaviorSelection =
  | Readonly<{ kind: "understanding" }>
  | Readonly<{ kind: "minimum_high_risk"; text: string }>;

/**
 * The ordinary Understanding Response input the behavior-aware Champion passes to
 * its responder for a turn that did not activate the Minimum High-Risk Response.
 */
export type ConversationUnderstandingTurn = Readonly<{
  history: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
  locale: string;
  text: string;
}>;

/**
 * Select the deterministic Champion behavior for a turn. A real high-risk signal
 * always activates the versioned Minimum High-Risk Response; otherwise the turn
 * receives an Understanding Response. The selection is shared by the
 * behavior-aware Champion and the minimum synthetic evaluation set.
 */
function selectConversationBehavior(input: {
  locale: string;
  message?: ConversationTextMessage;
}): ConversationBehaviorSelection {
  const text = input.message?.text ?? "";
  const signal = detectMinimumHighRiskSignal({ locale: input.locale, text });
  if (signal.kind !== null) {
    return {
      kind: "minimum_high_risk",
      text: renderMinimumHighRiskResponse({ kind: signal.kind, locale: input.locale }),
    };
  }
  return { kind: "understanding" };
}

/**
 * A deterministic Conversation Text Champion that applies the versioned 1A.1
 * behavior policy. It routes an explicit high-risk signal to the versioned
 * Minimum High-Risk Response and asks the provided responder for every ordinary
 * Understanding Response, so the same detection path runs through the real
 * in-process Egress Port.
 */
export function createBehaviorAwareConversationTextModel(input: {
  responder: (turn: ConversationUnderstandingTurn) => readonly string[];
  failAfterCompletion?: boolean;
  failAfterChunks?: number;
}): ConversationTextModel {
  return {
    async *stream(request) {
      let emitted = 0;
      const failBeforeEmit =
        input.failAfterChunks !== undefined && emitted >= input.failAfterChunks;
      if (failBeforeEmit) {
        throw new ProviderDispatchError("unavailable");
      }

      const currentMessage = [...request.messages]
        .reverse()
        .find((message) => message.role === "user");
      const history = currentMessage
        ? request.messages.filter((message) => message !== currentMessage)
        : [...request.messages];
      const selection = selectConversationBehavior({
        locale: request.locale,
        ...(currentMessage ? { message: currentMessage } : {}),
      });
      const chunks =
        selection.kind === "minimum_high_risk"
          ? [selection.text]
          : input.responder({
              history: history.map((message) => ({
                role: message.role,
                text: message.text,
              })),
              locale: request.locale,
              text: currentMessage?.text ?? "",
            });

      for (const chunk of chunks) {
        if (request.signal?.aborted) {
          throw new ProviderDispatchError("aborted");
        }
        if (
          input.failAfterChunks !== undefined &&
          emitted >= input.failAfterChunks
        ) {
          throw new ProviderDispatchError("unavailable");
        }
        emitted += 1;
        yield { delta: chunk, type: "delta" };
      }
      if (
        input.failAfterChunks !== undefined &&
        emitted >= input.failAfterChunks
      ) {
        throw new ProviderDispatchError("unavailable");
      }
      yield {
        costMicros: 0,
        finishReason: "completed",
        inputTokens: request.messages.reduce(
          (total, message) => total + Math.ceil([...message.text].length / 4),
          0,
        ),
        modelSnapshot: request.model,
        outputTokens: Math.ceil(chunks.join("").length / 4),
        providerRequestId: "deterministic-request",
        type: "completed",
      };
      if (input.failAfterCompletion) {
        throw new ProviderDispatchError("unavailable");
      }
    },
  };
}
