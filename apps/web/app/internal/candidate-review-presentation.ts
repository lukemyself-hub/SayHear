/**
 * Presentation-only helpers for the Candidate Review portal.
 *
 * These functions format values the BFF already returned and classify the
 * fixed outcome codes for display tone. They never infer a deadline, an
 * ownership date or a disposition: the authoritative queue stays the
 * `/api/internal/review/queue` payload and every command keeps its capability,
 * step-up, deadline and CAS semantics on the server.
 */

export type CandidateDeadlineField = Readonly<{
  /** Which authoritative deadline the remaining time is measured against. */
  kind: string | null;
  /** Milliseconds from the queue snapshot to the deadline; null when none. */
  remainingMs: number | null;
  /** `<kind> · <remaining>` for the always-visible deadline line. */
  label: string;
  /** True when the snapshot already shows the deadline elapsed. */
  overdue: boolean;
}>;

export function shortCandidateId(candidateId: string): string {
  return candidateId.length > 8 ? `${candidateId.slice(0, 8)}…` : candidateId;
}

export function formatDeadlineRemaining(ms: number | null): string {
  if (ms === null) {
    return "—";
  }
  if (ms < 0) {
    return "已过期";
  }
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return `${days} 日 ${hours} 小时`;
}

export function formatCandidateTimestamp(iso: string | null): string {
  return iso ?? "—";
}

export function isDeadlineOverdue(ms: number | null): boolean {
  return ms !== null && ms < 0;
}

/**
 * The always-visible deadline line. The literal `deadlineKind` code stays in
 * the text so the field that existed before the visual redesign is never lost.
 */
export function candidateDeadlineField(input: {
  deadlineKind: string | null;
  deadlineRemainingMs: number | null;
}): CandidateDeadlineField {
  return {
    remainingMs: input.deadlineRemainingMs,
    kind: input.deadlineKind,
    label: `${input.deadlineKind ?? "—"} · ${formatDeadlineRemaining(
      input.deadlineRemainingMs,
    )}`,
    overdue: isDeadlineOverdue(input.deadlineRemainingMs),
  };
}

export function formatProposedObjectValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "（无）";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return "（无法序列化）";
  }
}

export type CandidateLowFrequencyField = Readonly<{
  label: string;
  value: string;
}>;

/**
 * Low-frequency identifiers and raw JSON that stay collapsed by default. They
 * are candidate semantics the queue already returns, never verbatim Evidence.
 */
export function candidateLowFrequencyFields(input: {
  basis: string;
  candidateId: string;
  candidateKind: string;
  decidedAt: string | null;
  proposedObjectValue: unknown;
  proposedScopeKey: string;
}): readonly CandidateLowFrequencyField[] {
  return [
    { label: "Candidate ID", value: input.candidateId },
    { label: "Candidate 类型", value: input.candidateKind },
    { label: "依据", value: input.basis },
    { label: "Scope key", value: input.proposedScopeKey || "—" },
    { label: "决定时间", value: formatCandidateTimestamp(input.decidedAt) },
    {
      label: "提议对象值 (JSON)",
      value: formatProposedObjectValue(input.proposedObjectValue),
    },
  ];
}

export type CandidateReviewOutcomeTone = "success" | "failure";

/**
 * Only `applied` is a success. Every other fixed code (including the idempotent
 * `already_*` replays) is a failure tone so the portal never paints a redraw as
 * a fresh success.
 */
export function candidateReviewOutcomeTone(
  outcome: string,
): CandidateReviewOutcomeTone {
  return outcome === "applied" ? "success" : "failure";
}

const AUTH_FAILURE_OUTCOMES: ReadonlySet<string> = new Set([
  "recent_step_up_required",
  "step_up_required",
  "unauthorized",
]);

/**
 * Whether a fixed outcome means the protected display must be cleared because
 * the session lost its capability or the recovery gate closed.
 */
export function candidateReviewAuthFailure(outcome: string): boolean {
  return AUTH_FAILURE_OUTCOMES.has(outcome);
}
