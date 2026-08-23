/**
 * The session-scoped Curiosity Stop Signal projection (issue #74, ADR-0111,
 * architecture 08-10 §9.1, CONTEXT.md "Curiosity Stop Signal").
 *
 * The projection records question directions the user has stopped for the rest
 * of the day's Daily Session. The Conversation Text Champion may PROPOSE a
 * stop-signal change — suppression ("short response / avoided / refused /
 * topic changed"), the
 * blanket "stop asking questions" form, or a release — but every commit and
 * release decision below is deterministic code: the proposal carries only the
 * semantic claim, and the evidence envelope (which committed Event revisions
 * ground it) is attached and validated deterministically at commit time.
 *
 * Scope rules (CONTEXT.md): a single-direction suppression persists across
 * Continuous Exchange boundaries within the day's session and releases only
 * when the user re-opens the topic, supplies new substantive content, or
 * explicitly re-invites questioning — never by time, turn count, or model
 * confidence. The blanket form is scoped to the current Continuous Exchange.
 * The projection is keyed by Daily Session, so the next day's session starts
 * with no suppression.
 *
 * Records keep a minimal envelope (ADR-0101 discipline): bounded model-authored
 * direction labels, signal enums, and Event revision references only — never
 * user or assistant content. The `proactiveFollowupUsage` slot is established
 * alongside the suppressed directions but stays unwritten until 1A.3b
 * introduces proactive follow-ups; the validator enforces that it stays null.
 */

import type { ConversationEventRevisionId } from "@sayhear/domain";

import type { ConversationFunctionDefinition } from "./conversation-action-catalog";

export const CURIOSITY_STOP_SIGNAL_POLICY_VERSION = "curiosity-stop-signal:v1";

export const CURIOSITY_STOP_SIGNAL_MAX_PROPOSALS_PER_TURN = 4;
export const CURIOSITY_STOP_SIGNAL_MAX_ACTIVE_DIRECTIONS = 8;
export const CURIOSITY_STOP_SIGNAL_MAX_TRACKED_DIRECTIONS = 24;
export const CURIOSITY_STOP_SIGNAL_MAX_DIRECTION_LABEL_LENGTH = 120;

/** How the user stopped the direction (the model's semantic proposal). */
export type CuriosityStopSignalKind =
  | "short_response"
  | "avoided"
  | "refused"
  | "topic_changed";

export const CURIOSITY_STOP_SIGNAL_KINDS = Object.freeze([
  "short_response",
  "avoided",
  "refused",
  "topic_changed",
] as const) satisfies readonly CuriosityStopSignalKind[];

/**
 * The only release paths (CONTEXT.md): the user re-opens the topic, supplies
 * new substantive content, or explicitly re-invites questioning. Time, turn
 * count, and model confidence are deliberately absent.
 */
export type CuriosityStopSignalReleaseReason =
  | "user_reopened"
  | "new_substantive_content"
  | "explicit_reinvitation";

export const CURIOSITY_STOP_SIGNAL_RELEASE_REASONS = Object.freeze([
  "user_reopened",
  "new_substantive_content",
  "explicit_reinvitation",
] as const) satisfies readonly CuriosityStopSignalReleaseReason[];

/**
 * What the model may propose. This is a proposal only — deterministic code in
 * {@link applyCuriosityStopSignalProposals} decides whether it commits.
 */
export type CuriosityStopSignalProposal =
  | Readonly<{
      direction: string;
      kind: "suppress_direction";
      signalKind: CuriosityStopSignalKind;
    }>
  | Readonly<{
      kind: "release_direction";
      releaseReason: CuriosityStopSignalReleaseReason;
      direction: string;
    }>
  | Readonly<{ kind: "suppress_all_questions" }>
  | Readonly<{ kind: "release_all_questions" }>;

/**
 * The deterministic evidence envelope attached at commit time. Revision
 * references only — no user or assistant content is ever duplicated here.
 */
export type CuriosityStopSignalEvidence = Readonly<{
  /** The user Event revision that carried the stop or release signal. */
  triggerUserEventRevisionId: ConversationEventRevisionId;
  /** The assistant question Event revision the user stopped, when one exists. */
  questionAssistantEventRevisionId: ConversationEventRevisionId | null;
}>;

export type SuppressedQuestionDirection = Readonly<{
  committedInExchangeNo: number;
  direction: string;
  evidence: CuriosityStopSignalEvidence;
  releasedBy: Readonly<{
    reason: CuriosityStopSignalReleaseReason;
    triggerUserEventRevisionId: ConversationEventRevisionId;
  }> | null;
  signalKind: CuriosityStopSignalKind;
}>;

export type BlanketQuestionStop = Readonly<{
  evidence: CuriosityStopSignalEvidence;
  exchangeNo: number;
  releasedBy: Readonly<{
    reason: CuriosityStopSignalReleaseReason;
    triggerUserEventRevisionId: ConversationEventRevisionId;
  }> | null;
}>;

export type CuriosityStopSignalContent = Readonly<{
  blanketStop: BlanketQuestionStop | null;
  /**
   * The proactive-follow-up usage projection slot (architecture 08-10 §9.1:
   * `proactive_followup_used_in_exchange`). Established here, intentionally
   * unwritten until 1A.3b introduces proactive follow-ups.
   */
  proactiveFollowupUsage: null;
  suppressedDirections: readonly SuppressedQuestionDirection[];
}>;

export type CurrentCuriosityStopSignal = Readonly<{
  content: CuriosityStopSignalContent;
  policyVersion: string;
  sourceRevision: number;
  id: string;
  versionNo: number;
}>;

export const EMPTY_CURIOSITY_STOP_SIGNAL_CONTENT: CuriosityStopSignalContent =
  Object.freeze({
    blanketStop: null,
    proactiveFollowupUsage: null,
    suppressedDirections: Object.freeze([]),
  });

export type CuriosityStopSignalProposalOutcome =
  | Readonly<{ index: number; outcome: "committed" }>
  | Readonly<{ index: number; outcome: "rejected"; reason: string }>;

export type AppliedCuriosityStopSignalProposals = Readonly<{
  content: CuriosityStopSignalContent;
  committedAny: boolean;
  outcomes: readonly CuriosityStopSignalProposalOutcome[];
}>;

/**
 * The deterministic projection state that is active for a compile: direction
 * suppressions survive Continuous Exchange boundaries within the session; the
 * blanket form applies only while `currentExchangeNo` matches its exchange.
 */
export type ActiveCuriosityStopSignal = Readonly<{
  blanketStop: BlanketQuestionStop | null;
  suppressedDirections: readonly SuppressedQuestionDirection[];
}>;

export function activeCuriosityStopSignal(
  content: CuriosityStopSignalContent,
  currentExchangeNo: number,
): ActiveCuriosityStopSignal {
  return {
    blanketStop: blanketQuestionStopActive(content, currentExchangeNo),
    suppressedDirections: content.suppressedDirections.filter(
      (direction) => direction.releasedBy === null,
    ),
  };
}

export function blanketQuestionStopActive(
  content: CuriosityStopSignalContent,
  currentExchangeNo: number,
): BlanketQuestionStop | null {
  const blanket = content.blanketStop;
  if (!blanket || blanket.releasedBy !== null) return null;
  return blanket.exchangeNo === currentExchangeNo ? blanket : null;
}

export function hasActiveCuriosityStopSignal(
  content: CuriosityStopSignalContent,
  currentExchangeNo: number,
): boolean {
  const active = activeCuriosityStopSignal(content, currentExchangeNo);
  return (
    active.suppressedDirections.length > 0 || active.blanketStop !== null
  );
}

/**
 * Deterministic direction-label identity. The model authors free-form labels;
 * commits and releases match on this normalized form (whitespace-collapsed,
 * case-insensitive) so "work ", "Work", and "work" are the same direction
 * without any semantic matching.
 */
export function normalizeDirectionLabel(direction: string): string {
  return direction.trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Apply model proposals to the projection deterministically. Every rule is
 * code, not model judgment:
 *
 * - A direction suppression requires a preceding assistant question (the
 *   stopped thing must be a question direction) and evidence is attached from
 *   the committing turn, so the model cannot cite or fabricate it.
 * - Duplicate active suppressions are rejected — the commit is idempotent
 *   under technical retries of the same turn.
 * - The blanket form is stamped with the current Continuous Exchange and is
 *   inactive for any later exchange without any write.
 * - Releases require an exactly-matching active entry; the release evidence is
 *   the triggering user Event revision of the committing turn.
 * - The proactive-follow-up usage slot must stay unwritten.
 */
export function applyCuriosityStopSignalProposals(input: {
  content: CuriosityStopSignalContent;
  currentExchangeNo: number;
  currentUserEventRevisionId: ConversationEventRevisionId;
  /** Supplied by the transaction boundary for deterministic release checks. */
  currentUserText?: string;
  precedingAssistantQuestion: Readonly<{
    containsQuestion: boolean;
    revisionId: ConversationEventRevisionId;
  }> | null;
  proposals: readonly CuriosityStopSignalProposal[];
}): AppliedCuriosityStopSignalProposals {
  validateCuriosityStopSignalContent(input.content);
  const outcomes: CuriosityStopSignalProposalOutcome[] = [];
  const suppressedDirections = input.content.suppressedDirections.map(
    (direction) => ({ ...direction }),
  );
  let blanketStop = input.content.blanketStop
    ? { ...input.content.blanketStop }
    : null;

  const evidence: CuriosityStopSignalEvidence = {
    triggerUserEventRevisionId: input.currentUserEventRevisionId,
    questionAssistantEventRevisionId:
      input.precedingAssistantQuestion?.revisionId ?? null,
  };

  for (const [index, proposal] of input.proposals.entries()) {
    if (proposal.kind === "suppress_direction") {
      const direction = normalizeDirectionLabel(proposal.direction);
      if (!isValidDirectionLabel(direction)) {
        outcomes.push({ index, outcome: "rejected", reason: "invalid_direction" });
        continue;
      }
      if (input.precedingAssistantQuestion?.containsQuestion !== true) {
        outcomes.push({
          index,
          outcome: "rejected",
          reason: "no_preceding_question",
        });
        continue;
      }
      if (
        suppressedDirections.some(
          (entry) =>
            entry.releasedBy === null &&
            normalizeDirectionLabel(entry.direction) === direction,
        )
      ) {
        outcomes.push({
          index,
          outcome: "rejected",
          reason: "already_suppressed",
        });
        continue;
      }
      if (
        suppressedDirections.length >=
        CURIOSITY_STOP_SIGNAL_MAX_TRACKED_DIRECTIONS
      ) {
        outcomes.push({ index, outcome: "rejected", reason: "capacity" });
        continue;
      }
      if (
        suppressedDirections.filter((entry) => entry.releasedBy === null)
          .length >= CURIOSITY_STOP_SIGNAL_MAX_ACTIVE_DIRECTIONS
      ) {
        outcomes.push({ index, outcome: "rejected", reason: "capacity" });
        continue;
      }
      suppressedDirections.push({
        committedInExchangeNo: input.currentExchangeNo,
        direction,
        evidence,
        releasedBy: null,
        signalKind: proposal.signalKind,
      });
      outcomes.push({ index, outcome: "committed" });
      continue;
    }
    if (proposal.kind === "release_direction") {
      const direction = normalizeDirectionLabel(proposal.direction);
      const entry = suppressedDirections.find(
        (candidate) =>
          candidate.releasedBy === null &&
          normalizeDirectionLabel(candidate.direction) === direction,
      );
      if (!entry) {
        outcomes.push({
          index,
          outcome: "rejected",
          reason: "not_suppressed",
        });
        continue;
      }
      if (
        input.currentUserText !== undefined &&
        !releaseEvidenceMatches({
          direction,
          reason: proposal.releaseReason,
          userText: input.currentUserText,
        })
      ) {
        outcomes.push({
          index,
          outcome: "rejected",
          reason: "missing_user_release_evidence",
        });
        continue;
      }
      entry.releasedBy = {
        reason: proposal.releaseReason,
        triggerUserEventRevisionId: input.currentUserEventRevisionId,
      };
      outcomes.push({ index, outcome: "committed" });
      continue;
    }
    if (proposal.kind === "suppress_all_questions") {
      if (
        input.currentUserText !== undefined &&
        !containsBlanketQuestionStop(input.currentUserText)
      ) {
        outcomes.push({
          index,
          outcome: "rejected",
          reason: "missing_blanket_stop_evidence",
        });
        continue;
      }
      if (
        blanketStop !== null &&
        blanketStop.releasedBy === null &&
        blanketStop.exchangeNo === input.currentExchangeNo
      ) {
        outcomes.push({
          index,
          outcome: "rejected",
          reason: "already_suppressed",
        });
        continue;
      }
      blanketStop = {
        evidence,
        exchangeNo: input.currentExchangeNo,
        releasedBy: null,
      };
      outcomes.push({ index, outcome: "committed" });
      continue;
    }
    // release_all_questions
    if (
      blanketStop === null ||
      blanketStop.releasedBy !== null ||
      blanketStop.exchangeNo !== input.currentExchangeNo
    ) {
      outcomes.push({
        index,
        outcome: "rejected",
        reason: "not_suppressed",
      });
      continue;
    }
    if (
      input.currentUserText !== undefined &&
      !containsExplicitQuestionReinvitation(input.currentUserText)
    ) {
      outcomes.push({
        index,
        outcome: "rejected",
        reason: "missing_reinvitation_evidence",
      });
      continue;
    }
    blanketStop.releasedBy = {
      reason: "explicit_reinvitation",
      triggerUserEventRevisionId: input.currentUserEventRevisionId,
    };
    outcomes.push({ index, outcome: "committed" });
  }

  const content: CuriosityStopSignalContent = {
    blanketStop,
    proactiveFollowupUsage: null,
    suppressedDirections,
  };
  validateCuriosityStopSignalContent(content);
  return {
    committedAny: outcomes.some((outcome) => outcome.outcome === "committed"),
    content,
    outcomes,
  };
}

/**
 * Structural validation of persisted content. The projection records are a
 * minimal envelope: bounded direction labels, signal enums, revision
 * references, and nothing else.
 */
export function validateCuriosityStopSignalContent(
  content: CuriosityStopSignalContent,
): void {
  if (!Array.isArray(content.suppressedDirections)) {
    throw new Error("CuriosityStopSignal suppressedDirections must be an array.");
  }
  if (content.suppressedDirections.length > CURIOSITY_STOP_SIGNAL_MAX_TRACKED_DIRECTIONS) {
    throw new Error("CuriosityStopSignal exceeds the tracked-direction bound.");
  }
  const activeLabels = new Set<string>();
  for (const entry of content.suppressedDirections) {
    if (!isValidDirectionLabel(normalizeDirectionLabel(entry.direction))) {
      throw new Error("CuriosityStopSignal direction is outside the bounded policy.");
    }
    if (!CURIOSITY_STOP_SIGNAL_KINDS.includes(entry.signalKind)) {
      throw new Error("CuriosityStopSignal signal kind is outside the bounded policy.");
    }
    if (!Number.isInteger(entry.committedInExchangeNo) || entry.committedInExchangeNo < 1) {
      throw new Error("CuriosityStopSignal exchange number must be positive.");
    }
    if (!entry.evidence?.triggerUserEventRevisionId) {
      throw new Error("CuriosityStopSignal entries require trigger evidence.");
    }
    if (entry.releasedBy !== null) {
      if (!CURIOSITY_STOP_SIGNAL_RELEASE_REASONS.includes(entry.releasedBy.reason)) {
        throw new Error("CuriosityStopSignal release reason is outside the bounded policy.");
      }
      if (!entry.releasedBy.triggerUserEventRevisionId) {
        throw new Error("CuriosityStopSignal releases require trigger evidence.");
      }
    } else {
      const label = normalizeDirectionLabel(entry.direction);
      if (activeLabels.has(label)) {
        throw new Error("CuriosityStopSignal active directions must be unique.");
      }
      activeLabels.add(label);
    }
  }
  const blanket = content.blanketStop;
  if (blanket !== null) {
    if (!Number.isInteger(blanket.exchangeNo) || blanket.exchangeNo < 1) {
      throw new Error("CuriosityStopSignal blanket exchange number must be positive.");
    }
    if (!blanket.evidence?.triggerUserEventRevisionId) {
      throw new Error("CuriosityStopSignal blanket requires trigger evidence.");
    }
  }
  if (content.proactiveFollowupUsage !== null) {
    throw new Error(
      "The proactive-follow-up usage slot stays unwritten until 1A.3b.",
    );
  }
}

function isValidDirectionLabel(direction: string): boolean {
  return (
    direction.length > 0 &&
    direction.length <= CURIOSITY_STOP_SIGNAL_MAX_DIRECTION_LABEL_LENGTH &&
    !directionViolationPattern.test(direction)
  );
}

function releaseEvidenceMatches(input: {
  direction: string;
  reason: CuriosityStopSignalReleaseReason;
  userText: string;
}): boolean {
  if (input.reason === "explicit_reinvitation") {
    return containsExplicitQuestionReinvitation(input.userText);
  }
  const normalizedText = normalizeDirectionLabel(input.userText);
  return (
    normalizedText.includes(input.direction) &&
    !containsStopSignal(input.userText)
  );
}

function containsBlanketQuestionStop(text: string): boolean {
  return /(?:\b(?:stop|no more|don't|do not|please stop)\s+(?:asking|questions?)\b|别再问|别问了|不要再问|先别提问)/iu.test(
    text,
  );
}

function containsExplicitQuestionReinvitation(text: string): boolean {
  return /(?:\b(?:ask me|ask away|you can ask|go ahead and ask|feel free to ask|question me)\b|可以问我|你可以问|继续问|再问吧)/iu.test(
    text,
  );
}

function containsStopSignal(text: string): boolean {
  return /(?:\b(?:stop asking|don't want to talk about|do not want to talk about|rather not|never mind|let's not|not now)\b|别再问|别问了|不想谈|不要再说|不想聊|不想说|换个话题|聊点别的)/iu.test(
    text,
  );
}

/**
 * Direction labels are model-authored strings compiled into model input, so
 * they must not smuggle instructions (same discipline as the DialogueState
 * boundary-violation pattern).
 */
const directionViolationPattern =
  /(?:ignore|disregard|override)\s+(?:the\s+)?(?:above|previous|all|instructions?)|(?:system|developer)\s+(?:prompt|message|instruction)|(?:you\s+(?:must|should|are\s+required))\s+to\s+(?:ask|question|continue|pursue)|(?:必须|应该|需要)\s*(?:继续?追问|提问|询问)|忽略|无视(?:以上|之前|所有)(?:指令|规则|指示)/i;

/**
 * Render the projection's active state as the compiled `curiosity_stop_signal`
 * section. The rendered string is also the section reference, so the Provider
 * Egress re-derivation replays exactly the state frozen at compile time.
 */
export function renderCuriosityStopSignal(input: {
  active: ActiveCuriosityStopSignal;
  policyVersion: string;
}): string {
  const lines = [
    `Curiosity Stop Signal (deterministic Daily-Session projection; policy ${input.policyVersion}):`,
  ];
  if (input.active.suppressedDirections.length > 0) {
    lines.push(
      "The user has stopped these question directions for the rest of today's session. Do not question them again unless the user re-opens the topic or adds new substantive content:",
    );
    for (const direction of input.active.suppressedDirections) {
      lines.push(`- ${direction.direction} (${direction.signalKind})`);
    }
  }
  if (input.active.blanketStop !== null) {
    lines.push(
      "The user asked to stop asking questions: ask no ordinary follow-up questions for the rest of this Continuous Exchange.",
    );
  }
  lines.push(
    "A complete response that asks zero questions is always valid.",
  );
  return lines.join("\n");
}

/**
 * The provider function through which the Conversation Text Champion proposes
 * stop-signal changes alongside an ordinary text response. This is not a
 * Conversation Action (ADR-0090: one Action is one user-intent semantic) — it
 * is a behavior-proposal channel whose commits are deterministic.
 */
export const CURIOSITY_STOP_SIGNAL_FUNCTION: ConversationFunctionDefinition =
  Object.freeze({
    description:
      "Propose changes to the Curiosity Stop Signal projection when the user avoids, refuses, or changes away from a question direction, asks you to stop asking questions, or later re-opens a stopped topic / offers new substantive content / explicitly invites questions again. Proposals are committed only by deterministic code; a preceding assistant question is required to suppress a direction.",
    name: "curiosity_stop_signal",
    parameters: Object.freeze({
      additionalProperties: false,
      properties: Object.freeze({
        proposals: Object.freeze({
          additionalProperties: false,
          items: Object.freeze({
            additionalProperties: false,
            properties: Object.freeze({
              direction: Object.freeze({
                description:
                  "Short label of the question direction, e.g. 'work pressure'. Required for suppress_direction and release_direction.",
                maxLength: CURIOSITY_STOP_SIGNAL_MAX_DIRECTION_LABEL_LENGTH,
                type: "string",
              }),
              kind: Object.freeze({
                description: "The proposed stop-signal change.",
                enum: Object.freeze([
                  "suppress_direction",
                  "release_direction",
                  "suppress_all_questions",
                  "release_all_questions",
                ]),
                type: "string",
              }),
              release_reason: Object.freeze({
                description:
                  "Why the direction may be questioned again. Required for release proposals.",
                enum: Object.freeze([
                  "user_reopened",
                  "new_substantive_content",
                  "explicit_reinvitation",
                ]),
                type: "string",
              }),
              signal_kind: Object.freeze({
                description:
                  "How the user stopped the direction. Required for suppress proposals.",
                enum: Object.freeze([
                  "short_response",
                  "avoided",
                  "refused",
                  "topic_changed",
                ]),
                type: "string",
              }),
            }),
            required: Object.freeze(["kind"]),
            type: "object",
          }),
          maxItems: CURIOSITY_STOP_SIGNAL_MAX_PROPOSALS_PER_TURN,
          minItems: 1,
          type: "array",
        }),
      }),
      required: Object.freeze(["proposals"]),
      type: "object",
    }),
    strict: true,
  });

/**
 * Normalize a provider-native `curiosity_stop_signal` tool call into validated
 * proposals. Structural failures are invalid responses (fail closed); semantic
 * rejections happen later inside the deterministic commit.
 */
export function normalizeCuriosityStopSignalCall(input: {
  rawArguments: string;
}): { proposals: readonly CuriosityStopSignalProposal[] } | { invalid: true } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawArguments);
  } catch {
    return { invalid: true };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.proposals)) {
    return { invalid: true };
  }
  const rawProposals = parsed.proposals;
  if (
    rawProposals.length === 0 ||
    rawProposals.length > CURIOSITY_STOP_SIGNAL_MAX_PROPOSALS_PER_TURN
  ) {
    return { invalid: true };
  }
  const proposals: CuriosityStopSignalProposal[] = [];
  for (const raw of rawProposals) {
    if (!isRecord(raw) || typeof raw.kind !== "string") {
      return { invalid: true };
    }
    if (raw.kind === "suppress_direction") {
      if (
        typeof raw.direction !== "string" ||
        typeof raw.signal_kind !== "string"
      ) {
        return { invalid: true };
      }
      const direction = normalizeDirectionLabel(raw.direction);
      if (
        !direction ||
        direction.length > CURIOSITY_STOP_SIGNAL_MAX_DIRECTION_LABEL_LENGTH
      ) {
        return { invalid: true };
      }
      if (
        !CURIOSITY_STOP_SIGNAL_KINDS.includes(
          raw.signal_kind as CuriosityStopSignalKind,
        )
      ) {
        return { invalid: true };
      }
      proposals.push({
        direction,
        kind: "suppress_direction",
        signalKind: raw.signal_kind as CuriosityStopSignalKind,
      });
      continue;
    }
    if (raw.kind === "release_direction") {
      if (
        typeof raw.direction !== "string" ||
        typeof raw.release_reason !== "string"
      ) {
        return { invalid: true };
      }
      const direction = normalizeDirectionLabel(raw.direction);
      if (
        !direction ||
        direction.length > CURIOSITY_STOP_SIGNAL_MAX_DIRECTION_LABEL_LENGTH
      ) {
        return { invalid: true };
      }
      if (
        !CURIOSITY_STOP_SIGNAL_RELEASE_REASONS.includes(
          raw.release_reason as CuriosityStopSignalReleaseReason,
        )
      ) {
        return { invalid: true };
      }
      proposals.push({
        direction,
        kind: "release_direction",
        releaseReason: raw.release_reason as CuriosityStopSignalReleaseReason,
      });
      continue;
    }
    if (raw.kind === "suppress_all_questions") {
      proposals.push({ kind: "suppress_all_questions" });
      continue;
    }
    if (raw.kind === "release_all_questions") {
      proposals.push({ kind: "release_all_questions" });
      continue;
    }
    return { invalid: true };
  }
  return { proposals };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
