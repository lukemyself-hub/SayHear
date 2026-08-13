import {
  ProviderDispatchError,
  classifyConversationTurnSignal,
  detectMinimumHighRiskSignal,
  renderMinimumHighRiskResponse,
  type ConversationTextMessage,
  type ConversationTextModel,
  type ConversationTurnSignal,
} from "@sayhear/application";

import { streamDeterministicDeltas } from "./deterministic-stream";

/**
 * The behavior the deterministic Champion selects for a turn.
 *
 * - `understanding`: an ordinary 1A.1 Understanding Response from the responder,
 *   paired with the classified turn signal so the responder can stop the prior
 *   line of questioning after a short response, avoidance, refusal, or topic
 *   change.
 * - `minimum_high_risk`: the versioned Minimum High-Risk Response that pauses
 *   ordinary listening, follow-up, and advice.
 */
type ConversationBehaviorSelection =
  | Readonly<{ kind: "understanding"; signal: ConversationTurnSignal }>
  | Readonly<{ kind: "minimum_high_risk"; text: string }>;

/**
 * The ordinary Understanding Response input the behavior-aware Champion passes to
 * its responder for a turn that did not activate the Minimum High-Risk Response.
 * `signal` carries the follow-up rule so the responder stops pressing after a
 * short response, avoidance, refusal, or topic change.
 */
export type ConversationUnderstandingTurn = Readonly<{
  history: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
  locale: string;
  signal: ConversationTurnSignal;
  text: string;
}>;

/**
 * Select the deterministic Champion behavior for a turn. A real high-risk signal
 * always activates the versioned Minimum High-Risk Response; otherwise the turn
 * receives an Understanding Response and the classified turn signal steers the
 * follow-up rule. The selection is shared by the behavior-aware Champion and the
 * minimum synthetic evaluation set.
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
  return {
    kind: "understanding",
    signal: classifyConversationTurnSignal({ locale: input.locale, text }),
  };
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
  /**
   * When set, the model emits one provider-native `tool_call` event before any
   * delta. Fault-injection seam for the Harness fail-closed contract
   * (issue #24 AC8): a tool_call against an empty Conversation Action Catalog
   * must fail closed and never produce a fabricated success response.
   */
  emitToolCall?: Readonly<{ rawArguments: string; rawFunctionName: string }>;
}): ConversationTextModel {
  return {
    async *stream(request) {
      if (input.emitToolCall) {
        yield {
          rawArguments: input.emitToolCall.rawArguments,
          rawFunctionName: input.emitToolCall.rawFunctionName,
          type: "tool_call",
        };
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
              signal: selection.signal,
              text: currentMessage?.text ?? "",
            });

      yield* streamDeterministicDeltas(
        request,
        chunks,
        input.failAfterChunks,
      );
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
