import type { UserId } from "@sayhear/domain";

import type { ModelRoleFailureCode } from "../model-role-runtime";
import type {
  ProactiveFollowupOmitReason,
  ProactiveFollowupSegmentModelOutput,
  ProactiveFollowupSegmentOutput,
} from "./segment";
import type {
  ProactiveFollowupOpportunityKind,
  ProactiveFollowupStopSignal,
  ProactiveFollowupTargetKind,
  ProactiveFollowupTextLocator,
} from "./types";

/**
 * Role-scoped producer seam for `proactive.followup` (issue #207 layer 2c,
 * SPEC ch.7, ADR-0044 / ADR-0132).
 *
 * One frozen role owns both model calls so no other role's contract is
 * touched: segment generation renders the isolated optional segment from the
 * frozen main response and pinned target, and disposition classification
 * proposes the next-event stop signal against the committed use. Deterministic
 * code owns selection, reservation, pre-display revalidation, the atomic use
 * commit, and suppression state; the model output is never persisted.
 *
 * `proactive.followup` never retries (ADR-0132): any failure omits the
 * segment and preserves the main response.
 */
export type ProactiveFollowupModelProvider = Readonly<{
  role: "proactive.followup";
  generateSegment(
    request: ProactiveFollowupSegmentModelRequest,
  ): Promise<ProactiveFollowupSegmentModelOutput>;
  classifyDisposition(
    request: ProactiveFollowupDispositionModelRequest,
  ): Promise<ProactiveFollowupDispositionModelOutput>;
}>;

export type ProactiveFollowupSegmentModelRequest = Readonly<{
  userId: UserId;
  locale: string;
  /** Frozen main-response text the segment must accompany. */
  mainText: string;
  /** Current User Event, needed to judge whether the target is a natural addition. */
  currentUserText: string;
  currentTime: string;
  sessionTimeZone: string;
  targetKind: ProactiveFollowupTargetKind;
  targetId: string;
  targetVersionId: string;
  /**
   * The reference the model must echo exactly (issue #207 egress smoke:
   * deepseek-flash intermittently emitted a bare ID string when the
   * payload carried the identity only as separate fields, so v2
   * supplies the assembled object). Mirrors the disposition locator fix.
   */
  targetRef: Readonly<{
    targetKind: ProactiveFollowupTargetKind;
    targetId: string;
    targetVersionId: string;
  }>;
  /** Deterministic target rendering; null when the lane carries none. */
  targetSummary: string | null;
  targetContext: Readonly<{
    source: "open_loop" | "person_portrait" | "query_retrieval";
    evidenceAt: string;
    expectedStartAt: string | null;
    expiresAt: string | null;
    openLoopKind: "upcoming_event" | "awaited_outcome" | null;
    subjectRole: "user" | "other" | "unknown";
  }>;
  targetSensitive: boolean;
  opportunity: ProactiveFollowupOpportunityKind;
}>;

export type ProactiveFollowupDispositionModelRequest = Readonly<{
  userId: UserId;
  locale: string;
  /** The next user event text after the committed use. */
  userText: string;
  /** The committed segment text the user is responding to. */
  segmentText: string;
  use: Readonly<{
    useId: string;
    assistantEventRevisionId: string;
    targetKind: ProactiveFollowupTargetKind;
    targetId: string;
    targetVersionId: string;
  }>;
  /**
   * The locator the model must echo exactly (issue #207 egress smoke:
   * deepseek-flash guessed a `use` echo when the payload carried no
   * locator, so v2 supplies it). The application validator checks the
   * echo field-by-field; the model never invents locator constants.
   */
  finalTextLocator: ProactiveFollowupTextLocator;
}>;

/**
 * The model may propose only the five next-event signals (SPEC §7.3).
 * `ambiguous_closure` is recorded by deterministic code on ambiguous closure
 * evidence, never proposed by the model.
 */
export const PROACTIVE_FOLLOWUP_MODEL_DISPOSITION_SIGNALS = [
  "no_stop_signal",
  "short_response",
  "evaded",
  "refused",
  "topic_changed",
] as const satisfies readonly ProactiveFollowupStopSignal[];

export type ProactiveFollowupModelDispositionSignal =
  (typeof PROACTIVE_FOLLOWUP_MODEL_DISPOSITION_SIGNALS)[number];

export type ProactiveFollowupDispositionModelOutput = Readonly<{
  signal: string;
  /** Echo of the committed use locator; deterministic code rechecks it. */
  finalTextLocator: ProactiveFollowupTextLocator;
}>;

export type ProactiveFollowupSegmentModelValidation =
  | Readonly<{ outcome: "valid" }>
  | Readonly<{
      outcome: "invalid";
      reason: "decision" | "empty" | "target_ref" | "expression_kind" | "omit_reason";
    }>;

export function validateProactiveFollowupSegmentModelOutput(input: Readonly<{
  request: ProactiveFollowupSegmentModelRequest;
  output: ProactiveFollowupSegmentModelOutput;
}>): ProactiveFollowupSegmentModelValidation {
  if (
    input.output.targetRef.targetKind !== input.request.targetKind ||
    input.output.targetRef.targetId !== input.request.targetId ||
    input.output.targetRef.targetVersionId !== input.request.targetVersionId
  ) {
    return { outcome: "invalid", reason: "target_ref" };
  }
  if (input.output.decision === "omit") {
    const reasons: readonly ProactiveFollowupOmitReason[] = [
      "no_genuine_opportunity",
      "duplicates_main_response",
      "insufficient_grounding",
      "timing_not_natural",
    ];
    return reasons.includes(input.output.reason)
      ? { outcome: "valid" }
      : { outcome: "invalid", reason: "omit_reason" };
  }
  if (input.output.decision !== "emit") {
    return { outcome: "invalid", reason: "decision" };
  }
  if (input.output.content.trim().length === 0) {
    return { outcome: "invalid", reason: "empty" };
  }
  if (
    input.output.expressionKind !== "question" &&
    input.output.expressionKind !== "acknowledgment"
  ) {
    return { outcome: "invalid", reason: "expression_kind" };
  }
  return { outcome: "valid" };
}

export type ProactiveFollowupDispositionModelValidation =
  | Readonly<{ outcome: "valid" }>
  | Readonly<{ outcome: "invalid"; reason: "signal" | "locator" }>;

export function validateProactiveFollowupDispositionModelOutput(input: Readonly<{
  request: ProactiveFollowupDispositionModelRequest;
  output: ProactiveFollowupDispositionModelOutput;
}>): ProactiveFollowupDispositionModelValidation {
  if (
    !(PROACTIVE_FOLLOWUP_MODEL_DISPOSITION_SIGNALS as readonly string[]).includes(
      input.output.signal,
    )
  ) {
    return { outcome: "invalid", reason: "signal" };
  }
  const locator = input.output.finalTextLocator;
  const expected = input.request.finalTextLocator;
  if (
    locator.kind !== expected.kind ||
    locator.assistantEventRevisionId !== expected.assistantEventRevisionId ||
    locator.segment !== expected.segment ||
    locator.ordinal !== expected.ordinal
  ) {
    return { outcome: "invalid", reason: "locator" };
  }
  return { outcome: "valid" };
}

/**
 * Transport categories map onto the 1A.3b typed failure codes, mirroring the
 * Open Loop extractor. Every code is terminal for this role: ADR-0132 gives
 * `proactive.followup` zero technical retries, so the caller omits the
 * segment (or skips disposition) and preserves the main response.
 */
export function classifyProactiveFollowupProviderError(
  error: unknown,
): ModelRoleFailureCode {
  const category =
    typeof error === "object" && error !== null && "category" in error
      ? String((error as { category?: unknown }).category)
      : "";
  switch (category) {
    case "timeout":
      return "timeout";
    case "rate_limited":
      return "rate_limited";
    case "unavailable":
      return "server_error";
    case "authentication":
      return "authentication";
    case "configuration":
      return "configuration";
    case "policy_blocked":
      return "business_fence";
    case "invalid_response":
      return "schema_incompatible";
    default:
      return "result_unknown";
  }
}
