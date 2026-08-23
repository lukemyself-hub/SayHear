import {
  ProviderDispatchError,
  classifyConversationTurnSignal,
  detectMinimumHighRiskSignal,
  renderMinimumHighRiskResponse,
  renderSafetyPostureResponseAnchor,
  SAFETY_POSTURE_ACTIVE_MARKER,
  type ConversationTextMessage,
  type ConversationTextModel,
  type ConversationTurnSignal,
  type CuriosityStopSignalProposal,
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
   * Deterministic scripting seam for the Curiosity Stop Signal proposal
   * channel (issue #74): when it returns proposals for the current user
   * message, the model emits one provider-native `curiosity_stop_signal`
   * tool call before its deltas. System tests drive suppression / release
   * turns statefully without a live provider; the Egress Port normalizes the
   * call and only deterministic code commits it.
   */
  stopSignalProposals?: (turn: {
    locale: string;
    signal: ConversationTurnSignal;
    text: string;
  }) => readonly CuriosityStopSignalProposal[] | null;
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
      const regenerationHandle = findRegenerationHandle(request.instructions);
      if (
        currentMessage &&
        request.functions?.some(
          (definition) => definition.name === "regenerate_journal",
        ) &&
        regenerationHandle &&
        isSupportedRegenerationRequest(currentMessage.text)
      ) {
        yield {
          rawArguments: JSON.stringify({
            guidance: currentMessage.text,
            journalHandle: regenerationHandle,
          }),
          rawFunctionName: "regenerate_journal",
          type: "tool_call",
        };
        yield {
          costMicros: 0,
          finishReason: "tool_call",
          inputTokens: request.messages.reduce(
            (total, message) => total + Math.ceil([...message.text].length / 4),
            0,
          ),
          modelSnapshot: request.model,
          outputTokens: 0,
          providerRequestId: "deterministic-action-request",
          type: "completed",
        };
        return;
      }
      const history = currentMessage
        ? request.messages.filter((message) => message !== currentMessage)
        : [...request.messages];
      const selection = selectConversationBehavior({
        locale: request.locale,
        ...(currentMessage ? { message: currentMessage } : {}),
      });
      const signal =
        selection.kind === "understanding" ? selection.signal : "engaged";
      const scriptedProposals = input.stopSignalProposals?.({
        locale: request.locale,
        signal,
        text: currentMessage?.text ?? "",
      });
      if (scriptedProposals && scriptedProposals.length > 0) {
        yield {
          rawArguments: JSON.stringify({
            proposals: scriptedProposals.map(serializeProposal),
          }),
          rawFunctionName: "curiosity_stop_signal",
          type: "tool_call",
        };
      }
      // The deterministic Champion reflects the compiled Safety Posture the
      // way it reads the frozen Action Reference Handles: while the compiled
      // instructions mark the posture active (issue #76), every ordinary
      // response keeps the real-world support anchor. The Minimum High-Risk
      // Response already carries the anchor on its own activation turn.
      const postureActive = request.instructions.includes(
        SAFETY_POSTURE_ACTIVE_MARKER,
      );
      const responderChunks =
        selection.kind === "minimum_high_risk"
          ? [selection.text]
          : input.responder({
              history: history.map((message) => ({
                role: message.role,
                text: message.text,
              })),
              locale: request.locale,
              signal,
              text: currentMessage?.text ?? "",
            });
      const chunks =
        postureActive && selection.kind !== "minimum_high_risk"
          ? [
              ...responderChunks,
              renderSafetyPostureResponseAnchor({ locale: request.locale }),
            ]
          : responderChunks;

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

function serializeProposal(
  proposal: CuriosityStopSignalProposal,
): Record<string, string> {
  if (proposal.kind === "suppress_direction") {
    return {
      direction: proposal.direction,
      kind: "suppress_direction",
      signal_kind: proposal.signalKind,
    };
  }
  if (proposal.kind === "release_direction") {
    return {
      direction: proposal.direction,
      kind: "release_direction",
      release_reason: proposal.releaseReason,
    };
  }
  return { kind: proposal.kind };
}

function findRegenerationHandle(instructions: string): string | null {
  return instructions.match(/- regenerate_journal:\s+(\S+)/)?.[1] ?? null;
}

function isSupportedRegenerationRequest(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase();
  if (!normalized) return false;
  const boundedExpressionSignal =
    /(wording|expression|written|clearer|clarity|organ(?:i|a)z|emphasis|重点|表达|措辞|清楚|组织)/i;
  const explicitRegenerationSignal =
    /\b(regenerat(?:e|ion)|re-?write|rewrite|redo|reroll|try again|do it again|make)\b|重新生成|重写|再来一次|换一种|写得更清楚|写得清楚/i;
  if (
    /(delete|remove|erase|first person|use\s+["']?i|style|poetic|formal|funny|romantic|candidate|option|version|reroll|again and again|add|include|invent|promoted|promotion|fact|event|事实|事件|错误|不对|删除|删掉|第一人称|我的口吻|风格|诗意|候选|增加|加入)/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (/\b(and|then)\b|以及|并且|同时/.test(normalized) &&
      /(delete|remove|erase|事实|错误|删除|删掉|第一人称|风格|candidate|option)/i.test(normalized)) {
    return false;
  }
  if (/^(i )?(don't|do not) like (this|it)|^not happy with (this|it)$|^不喜欢(这个|这篇)?$/.test(normalized)) {
    return false;
  }
  return explicitRegenerationSignal.test(normalized) && boundedExpressionSignal.test(normalized);
}
