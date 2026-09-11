import { addCalendarDaysInTimeZone } from "../open-loop/policy";
import {
  PROACTIVE_FOLLOWUP_SUPPRESSION_POLICY_VERSION,
  type ProactiveFollowupDispositionInput,
  type ProactiveFollowupReleaseInput,
  type ProactiveFollowupReleaseResult,
  type ProactiveFollowupStateSnapshot,
  type ProactiveFollowupStateTransition,
  type ProactiveFollowupStopSignal,
} from "./types";

/** The policy is intentionally a table, not a model prompt or a timer lease. */
export const PROACTIVE_FOLLOWUP_COOLDOWN_DAYS = Object.freeze({
  topic_changed: [1, 7, 30],
  short_response: [7, 30],
  evaded: [30],
} as const);

const SOFT_SIGNALS = new Set<ProactiveFollowupStopSignal>([
  "short_response",
  "evaded",
  "topic_changed",
]);

function isoNow(input: Date): string {
  if (!Number.isFinite(input.getTime())) {
    throw new Error("Proactive follow-up disposition requires a valid clock.");
  }
  return input.toISOString();
}

function assertUseMatches(input: ProactiveFollowupDispositionInput): void {
  if (
    input.userId !== input.use.userId ||
    input.use.targetKind !== input.targetKind ||
    input.use.targetId !== input.targetId ||
    input.use.targetVersionId !== input.targetVersionId ||
    input.use.promptUserEventSequence >= input.currentUserEventSequence ||
    input.use.promptUserEventRevisionId === input.currentUserEventRevisionId
  ) {
    throw new Error("Proactive follow-up disposition failed its use/event fence.");
  }
  if (
    input.use.finalTextLocator.kind !== "assistant_event_revision" ||
    input.use.finalTextLocator.segment !== "proactive_followup" ||
    input.use.finalTextLocator.ordinal !== 0
  ) {
    throw new Error("Proactive follow-up disposition has an invalid text locator.");
  }
}

function stateForTarget(
  state: ProactiveFollowupStateSnapshot | null,
  input: Pick<
    ProactiveFollowupDispositionInput,
    "targetKind" | "targetId" | "targetVersionId"
  >,
): ProactiveFollowupStateSnapshot | null {
  if (!state) return null;
  if (
    state.targetKind !== input.targetKind ||
    state.targetId !== input.targetId ||
    state.targetVersionId !== input.targetVersionId
  ) {
    throw new Error("Proactive follow-up state target/version fence failed.");
  }
  return state;
}

function cooldownDays(
  signal: "short_response" | "evaded" | "topic_changed",
  nextSoftStopCount: number,
): number | null {
  const schedule = PROACTIVE_FOLLOWUP_COOLDOWN_DAYS[signal];
  return schedule[nextSoftStopCount - 1] ?? null;
}

function nextState(
  input: ProactiveFollowupDispositionInput,
  state: ProactiveFollowupStateSnapshot | null,
  suppressionReason: Exclude<ProactiveFollowupStopSignal, "no_stop_signal">,
  count: number,
  suppressedUntilAt: string | null,
): ProactiveFollowupStateSnapshot | null {
  if (!state) return null;
  return {
    ...state,
    eligibilityStatus: "suppressed",
    suppressionReason,
    consecutiveSoftStopCount: count,
    suppressedUntilAt,
    lastPromptEventRevisionId: input.use.promptUserEventRevisionId,
    lastResponseEventRevisionId: input.currentUserEventRevisionId,
    lastUsedAt: input.now.toISOString(),
    releaseReason: null,
  };
}

/**
 * Apply the next User Event's typed signal. A missing state is the lazy
 * never-suppressed state: a valid stop creates it in the data transaction.
 */
export function planProactiveFollowupDisposition(
  input: ProactiveFollowupDispositionInput,
): ProactiveFollowupStateTransition {
  assertUseMatches(input);
  const state = stateForTarget(input.state, input);
  if (input.signal === "no_stop_signal") {
    return {
      outcome: "unchanged",
      state,
      suppressionUntilAt: state?.suppressedUntilAt ?? null,
      suppressionReason: state?.suppressionReason ?? null,
    };
  }
  const now = isoNow(input.now);
  if (state && state.eligibilityStatus === "suppressed") {
    throw new Error("A suppressed target cannot receive a second disposition use.");
  }
  const previousCount = state?.consecutiveSoftStopCount ?? 0;
  const nextCount = SOFT_SIGNALS.has(input.signal) ? previousCount + 1 : previousCount;
  const days = SOFT_SIGNALS.has(input.signal)
    ? cooldownDays(
        input.signal as "short_response" | "evaded" | "topic_changed",
        nextCount,
      )
    : null;
  const suppressedUntilAt = days === null
    ? null
    : addCalendarDaysInTimeZone(now, days, input.timeZone);
  return {
    outcome: "suppressed",
    state: nextState(
      input,
      state,
      input.signal,
      nextCount,
      suppressedUntilAt,
    ),
    suppressionUntilAt: suppressedUntilAt,
    suppressionReason: input.signal,
  };
}

function releaseState(
  state: ProactiveFollowupStateSnapshot,
  reason: ProactiveFollowupReleaseResult["reason"],
  targetVersionId: string,
): ProactiveFollowupStateSnapshot {
  return {
    ...state,
    targetVersionId,
    eligibilityStatus: "eligible",
    suppressionReason: null,
    suppressedUntilAt: null,
    releaseReason: reason as ProactiveFollowupStateSnapshot["releaseReason"],
  };
}

/**
 * Only target-specific user action can release an indefinite stop. In
 * particular, a generic "ask me questions" permission is not accepted.
 */
export function planProactiveFollowupRelease(
  input: ProactiveFollowupReleaseInput,
): ProactiveFollowupReleaseResult {
  if (!Number.isFinite(input.now.getTime())) {
    return { outcome: "rejected", reason: "invalid_clock", state: input.state };
  }
  if (
    input.state.targetKind !== input.targetKind ||
    input.state.targetId !== input.targetId ||
    (input.reason !== "new_direct_evidence" &&
      input.state.targetVersionId !== input.targetVersionId)
  ) {
    return { outcome: "rejected", reason: "target_version_fence", state: input.state };
  }
  if (input.state.eligibilityStatus !== "suppressed") {
    return { outcome: "unchanged", reason: "already_eligible", state: input.state };
  }
  if (
    input.reason === "target_specific_permission" &&
    input.permissionTargetId !== input.targetId
  ) {
    return { outcome: "rejected", reason: "permission_not_target_specific", state: input.state };
  }
  if (input.currentUserEventSequence < 1 || input.currentUserEventRevisionId === "") {
    return { outcome: "rejected", reason: "invalid_trigger_event", state: input.state };
  }
  return {
    outcome: "released",
    reason: input.reason,
    state: releaseState(input.state, input.reason, input.targetVersionId),
  };
}

/** Cooldown release has no Event, command, message, or reselection promise. */
export function planProactiveFollowupCooldownRelease(input: Readonly<{
  now: Date;
  state: ProactiveFollowupStateSnapshot;
}>): ProactiveFollowupReleaseResult {
  if (!Number.isFinite(input.now.getTime())) {
    return { outcome: "rejected", reason: "invalid_clock", state: input.state };
  }
  if (input.state.eligibilityStatus !== "suppressed") {
    return { outcome: "unchanged", reason: "already_eligible", state: input.state };
  }
  if (
    input.state.suppressedUntilAt === null ||
    Date.parse(input.state.suppressedUntilAt) > input.now.getTime()
  ) {
    return { outcome: "unchanged", reason: "cooldown_not_due", state: input.state };
  }
  return {
    outcome: "released",
    reason: "cooldown_elapsed",
    state: releaseState(
      input.state,
      "cooldown_elapsed",
      input.state.targetVersionId,
    ),
  };
}

export { PROACTIVE_FOLLOWUP_SUPPRESSION_POLICY_VERSION };

