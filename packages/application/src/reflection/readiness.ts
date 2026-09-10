import { createHash } from "node:crypto";

/**
 * Q2 readiness + window math for Daily / Weekly Reflection (issue #199,
 * SPEC 5.1). Deterministic, pure: no conversation text crosses this module —
 * only IDs, local dates, revision numbers, and outcome enums.
 */

/** ISO week start (Monday) of a local YYYY-MM-DD date. */
export function weekStartDateOf(date: string): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`invalid local date: ${date}`);
  }
  const offsetToMonday = (base.getUTCDay() + 6) % 7;
  return addDaysToDateString(date, -offsetToMonday);
}

/** Adds calendar days to a local YYYY-MM-DD date. */
export function addDaysToDateString(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`invalid local date: ${date}`);
  }
  const next = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return next.toISOString().slice(0, 10);
}

/** Local YYYY-MM-DD at `now` under an IANA timezone. */
export function localDateAt(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

/** ISO week label `YYYY-Www` for a local date (Monday-start weeks). */
export function isoWeekIdentifier(date: string): string {
  const monday = weekStartDateOf(date);
  // ISO week-numbering year: dates in the first days of January may belong to
  // week 52/53 of the previous year, so the anchor is the week's Thursday.
  const thursday = addDaysToDateString(monday, 3);
  const thursdayDate = new Date(`${thursday}T00:00:00.000Z`);
  const yearStart = new Date(Date.UTC(thursdayDate.getUTCFullYear(), 0, 1));
  const weekNumber =
    Math.round(
      (thursdayDate.getTime() - yearStart.getTime()) / (7 * 24 * 60 * 60 * 1000),
    ) + 1;
  return `${thursdayDate.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

/** The seven consecutive local dates of the Monday-start week. */
export function weekWindowDates(monday: string): readonly string[] {
  return Array.from({ length: 7 }, (_item, index) =>
    addDaysToDateString(monday, index),
  );
}

/**
 * Stable week-window identity: deterministic UUID from owner + week
 * identifier, so a baseline-only change reuses the same logical Reflection.
 */
export function weekWindowId(userId: string, weekIdentifier: string): string {
  const digest = createHash("sha1")
    .update(`sayhear-week-window:v1\n${userId}\n${weekIdentifier}`)
    .digest("hex");
  // UUID v5 shape from the SHA-1 digest (RFC 4122 namespace hashing).
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    ((parseInt(digest.slice(16, 18), 16) & 0x3f) | 0x80)
      .toString(16)
      .padStart(2, "0") + digest.slice(18, 20),
    digest.slice(20, 32),
  ].join("-");
}

/** Numeric ordinal of a local date; the Weekly workflow-command revision. */
export function dateOrdinal(date: string): number {
  return Number(date.replace(/-/g, ""));
}

// ---- Day readiness (Q2) ------------------------------------------------------

export type DailyJournalReadiness =
  | "no_activity"
  | "settled_skipped"
  | "settled_published"
  | "settled_final_failure"
  | "waiting";

export type DayReadinessInputs = Readonly<{
  /** journal_eligibility date outcome, or null when not yet evaluated. */
  dateOutcome: "no_activity" | "insufficient_expression" | "eligible_queued" | "journal_available" | null;
  /** Latest journal workflow outcome for the session, or null when running. */
  journalOutcome: "published" | "needs_review" | "retryable_failed" | null;
  /**
   * Whether the journal workflow command has settled (no further retry) —
   * only then does `needs_review` count as the final failure (Q2).
   */
  journalCommandSettled: boolean;
  activityState: "active" | "quiescent";
  hasActiveEvidence: boolean;
}>;

/**
 * Q2 (accepted): Journal 成功、明确跳过或最终失败均允许 Daily 继续；正常
 * running / retryable 仍等待，不新增任意 timeout。`needs_review` 只在其
 * Command 已终止且不再 retry 时才算最终失败。无交流日期没有 Reflection。
 */
export function classifyDailyJournalReadiness(
  inputs: DayReadinessInputs,
): DailyJournalReadiness {
  if (!inputs.hasActiveEvidence || inputs.activityState !== "quiescent") {
    return "no_activity";
  }
  if (inputs.dateOutcome === null) {
    return "waiting";
  }
  if (inputs.dateOutcome === "no_activity") {
    return "no_activity";
  }
  if (inputs.dateOutcome === "insufficient_expression") {
    return "settled_skipped";
  }
  // From here the Journal workflow is running or settled; the outcome row
  // decides (Q2): published or terminal needs_review both release the day.
  if (inputs.journalOutcome === "published") {
    return "settled_published";
  }
  if (
    inputs.journalOutcome === "needs_review" &&
    inputs.journalCommandSettled
  ) {
    return "settled_final_failure";
  }
  // retryable rows and the no-outcome-yet case stay waiting (no invented
  // timeouts).
  return "waiting";
}

// ---- Episode interval (Q2) ---------------------------------------------------

export type EpisodeGateInputs = Readonly<{
  episodeRunUpdatedAt: Date | null;
  episodeRunStatus:
    | "built"
    | "stale_source"
    | "fenced"
    | "retryable_failed"
    | "failed"
    | null;
  sessionQuiescentAt: Date | null;
  now: Date;
  intervalMinutes: number;
}>;

export type EpisodeGateOutcome = Readonly<{
  enrichmentAvailable: boolean;
  /** Non-null degraded reason recorded on the version when defaulting. */
  degradedReason: string | null;
  ready: boolean;
}>;

/**
 * Q2: Episode Builder 先运行；Reflection 在其 target time 加 30 分钟间隔后
 * 尝试；缺失或失败的 Episode enrichment 不阻塞 Reflection，必须记录 degraded
 * reason；到期可缺省。
 */
export function classifyEpisodeGate(inputs: EpisodeGateInputs): EpisodeGateOutcome {
  if (inputs.episodeRunStatus === "built" && inputs.episodeRunUpdatedAt) {
    const readyAt =
      inputs.episodeRunUpdatedAt.getTime() +
      inputs.intervalMinutes * 60 * 1000;
    if (inputs.now.getTime() < readyAt) {
      return { enrichmentAvailable: true, degradedReason: null, ready: false };
    }
    return { enrichmentAvailable: true, degradedReason: null, ready: true };
  }
  if (
    inputs.episodeRunStatus !== null &&
    inputs.episodeRunStatus !== "retryable_failed" &&
    inputs.episodeRunUpdatedAt
  ) {
    // Terminal Episode failure at this head: default after the interval.
    const readyAt =
      inputs.episodeRunUpdatedAt.getTime() +
      inputs.intervalMinutes * 60 * 1000;
    if (inputs.now.getTime() < readyAt) {
      return {
        enrichmentAvailable: false,
        degradedReason: null,
        ready: false,
      };
    }
    return {
      enrichmentAvailable: false,
      degradedReason: `episode_${inputs.episodeRunStatus}`,
      ready: true,
    };
  }
  if (inputs.episodeRunStatus === "retryable_failed") {
    return { enrichmentAvailable: false, degradedReason: null, ready: false };
  }
  // No episode run yet: the builder is pending or not queued; default after
  // the interval from day close.
  if (inputs.sessionQuiescentAt) {
    const readyAt =
      inputs.sessionQuiescentAt.getTime() +
      inputs.intervalMinutes * 60 * 1000;
    if (inputs.now.getTime() < readyAt) {
      return { enrichmentAvailable: false, degradedReason: null, ready: false };
    }
  }
  return {
    enrichmentAvailable: false,
    degradedReason: "episode_build_pending",
    ready: true,
  };
}
