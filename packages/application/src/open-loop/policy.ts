import type {
  OpenLoopExpectedWindow,
  OpenLoopExpirySource,
  OpenLoopKind,
  OpenLoopTimePrecision,
} from "./types";
import { OPEN_LOOP_NEAR_TERM_LEXICAL_POLICY_VERSION } from "./types";

/**
 * Versioned near-term lexical allowlist (SPEC 6.2). Only an exact,
 * case-insensitive hit on these frozen surfaces may enter the unanchored
 * 14-day policy. The model must not invent near-term or fabricate a date from
 * any other fuzzy expression; rejected wide/far expressions never auto-active
 * later without new User Evidence.
 */
export const OPEN_LOOP_NEAR_TERM_LEXICAL_ALLOWLIST_V1: Readonly<{
  policyVersion: typeof OPEN_LOOP_NEAR_TERM_LEXICAL_POLICY_VERSION;
  zh: readonly string[];
  en: readonly string[];
}> = {
  policyVersion: OPEN_LOOP_NEAR_TERM_LEXICAL_POLICY_VERSION,
  zh: [
    "快了",
    "最近几天",
    "这几天",
    "过几天",
    "快出了",
    "马上",
    "近期",
    "这阵子",
  ],
  en: [
    "soon",
    "in the next few days",
    "coming up soon",
    "any day now",
    "in the near term",
    "shortly",
  ],
};

export function isNearTermLexicalHit(
  userTimeExpression: string | null | undefined,
): boolean {
  if (!userTimeExpression) {
    return false;
  }
  const normalized = userTimeExpression.trim().toLowerCase();
  if (normalized === "") {
    return false;
  }
  return (
    OPEN_LOOP_NEAR_TERM_LEXICAL_ALLOWLIST_V1.zh.some(
      (entry) => entry.toLowerCase() === normalized,
    ) ||
    OPEN_LOOP_NEAR_TERM_LEXICAL_ALLOWLIST_V1.en.some(
      (entry) => entry.toLowerCase() === normalized,
    )
  );
}

// ---- IANA timezone calendar-day arithmetic (DST-safe) -----------------------

function getTimeZoneOffsetMs(timeZone: string, utcDate: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(utcDate);
  const get = (type: string): number => {
    const part = parts.find((entry) => entry.type === type);
    return Number(part?.value ?? "0");
  };
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - utcDate.getTime();
}

/** Resolve a zoned wall time to a UTC instant (iterated offset fixpoint). */
export function zonedWallTimeToUtc(input: Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  timeZone: string;
}>): Date {
  let guess = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    input.second,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = getTimeZoneOffsetMs(
      input.timeZone,
      new Date(guess),
    );
    const next = Date.UTC(
      input.year,
      input.month - 1,
      input.day,
      input.hour,
      input.minute,
      input.second,
    ) - offset;
    if (next === guess) {
      return new Date(guess);
    }
    guess = next;
  }
  return new Date(guess);
}

export function zonedYmd(input: Readonly<{ instant: Date; timeZone: string }>): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(input.instant);
}

function zonedWallParts(
  instant: Date,
  timeZone: string,
): Readonly<{ year: number; month: number; day: number; hour: number; minute: number; second: number }> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Add N local calendar days in an IANA timezone. DST transitions change the
 * absolute instant by definition; a fixed 24h addition is never substituted.
 */
export function addCalendarDaysInTimeZone(
  instantIso: string,
  days: number,
  timeZone: string,
): string {
  const instant = new Date(instantIso);
  if (Number.isNaN(instant.getTime())) {
    throw new Error("addCalendarDaysInTimeZone requires a valid instant.");
  }
  try {
    void Intl.DateTimeFormat(undefined, { timeZone });
  } catch {
    throw new Error(`Unknown IANA timezone: ${timeZone}.`);
  }
  const wall = zonedWallParts(instant, timeZone);
  const shiftedUtcDate = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day + days, wall.hour, wall.minute, wall.second),
  );
  const shiftedY = shiftedUtcDate.getUTCFullYear();
  const shiftedM = shiftedUtcDate.getUTCMonth() + 1;
  const shiftedD = shiftedUtcDate.getUTCDate();
  return zonedWallTimeToUtc({
    year: shiftedY,
    month: shiftedM,
    day: shiftedD,
    hour: wall.hour,
    minute: wall.minute,
    second: wall.second,
    timeZone,
  }).toISOString();
}

/** Whole local-calendar-day difference between two instants in a timezone. */
export function diffCalendarDaysInTimeZone(
  fromIso: string,
  toIso: string,
  timeZone: string,
): number {
  const fromDay = zonedYmd({ instant: new Date(fromIso), timeZone });
  const toDay = zonedYmd({ instant: new Date(toIso), timeZone });
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`);
  return Math.round((toMs - fromMs) / 86_400_000);
}

// ---- Expected-window validation ---------------------------------------------

export type ValidatedExpectedWindow =
  | Readonly<{ anchored: false }>
  | Readonly<{
      anchored: true;
      startAt: string;
      /** Exact instants keep a null end; ranges use exclusive end. */
      endAt: string | null;
      precision: OpenLoopTimePrecision;
      timezone: string;
    }>;

/**
 * Validate one frozen expected window. Exact instants keep a null end;
 * date-only / bounded ranges are half-open [start, end) in the frozen IANA
 * timezone. Windows wider than 31 local calendar days are rejected, never
 * truncated into a fabricated reality.
 */
export function validateExpectedWindow(input: Readonly<{
  window: OpenLoopExpectedWindow | null | undefined;
  kind: OpenLoopKind;
  evidenceTimeZone?: string;
}>): ValidatedExpectedWindow | Readonly<{ error: "time_window_too_wide" | "time_invalid" }> {
  const window = input.window;
  if (!window || window.startAt === null) {
    return { anchored: false };
  }
  const precision = window.precision;
  if (precision === "approximate" || precision === "unknown") {
    return { anchored: false };
  }
  if (!window.timezone) {
    return { error: "time_invalid" };
  }
  if (input.evidenceTimeZone && window.timezone !== input.evidenceTimeZone) {
    return { error: "time_invalid" };
  }
  try {
    void Intl.DateTimeFormat(undefined, { timeZone: window.timezone });
  } catch {
    return { error: "time_invalid" };
  }
  const start = window.startAt ? new Date(window.startAt) : null;
  if (!start || Number.isNaN(start.getTime())) {
    return { error: "time_invalid" };
  }
  if (precision === "instant") {
    if (window.endAt !== null) {
      return { error: "time_invalid" };
    }
    return {
      anchored: true,
      startAt: start.toISOString(),
      endAt: null,
      precision,
      timezone: window.timezone,
    };
  }
  if (!window.endAt) {
    return { error: "time_invalid" };
  }
  const end = new Date(window.endAt);
  if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
    return { error: "time_invalid" };
  }
  if (precision === "date") {
    const startWall = zonedWallParts(start, window.timezone);
    const endWall = zonedWallParts(end, window.timezone);
    if (
      startWall.hour !== 0 || startWall.minute !== 0 || startWall.second !== 0 ||
      endWall.hour !== 0 || endWall.minute !== 0 || endWall.second !== 0 ||
      start.getUTCMilliseconds() !== 0 || end.getUTCMilliseconds() !== 0 ||
      diffCalendarDaysInTimeZone(start.toISOString(), end.toISOString(), window.timezone) !== 1
    ) {
      return { error: "time_invalid" };
    }
  }
  const widthDays = diffCalendarDaysInTimeZone(
    start.toISOString(),
    end.toISOString(),
    window.timezone,
  );
  if (widthDays > 31) {
    return { error: "time_window_too_wide" };
  }
  return {
    anchored: true,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    precision,
    timezone: window.timezone,
  };
}

// ---- Expiry + follow-up eligibility ------------------------------------------

export type OpenLoopSchedule = Readonly<{
  followupEligibleFromAt: string;
  expiresAt: string;
  expirySource: OpenLoopExpirySource;
}>;

/**
 * Compute the frozen schedule exactly once. Anchored upcoming events expire at
 * range-end + 7 local days, anchored awaited outcomes at +14, unanchored
 * either kind at Evidence time + 14. Follow-up eligibility starts 14 days
 * before an upcoming window, at the window start for an awaited outcome, or
 * at Evidence time without an anchor. Expected-time arrival never implies
 * completion. Expiry beyond Evidence + 360 local days rejects the proposal.
 */
export function computeOpenLoopSchedule(input: Readonly<{
  kind: OpenLoopKind;
  anchored: ValidatedExpectedWindow;
  evidenceCommittedAt: string;
  evidenceTimeZone: string;
  dateOnlyDeadline?: boolean;
}>): OpenLoopSchedule | Readonly<{ error: "horizon_exceeded" | "time_invalid" }> {
  const evidenceTime = new Date(input.evidenceCommittedAt);
  if (Number.isNaN(evidenceTime.getTime())) {
    return { error: "time_invalid" };
  }
  const evidenceTz = input.evidenceTimeZone || "UTC";
  try {
    void Intl.DateTimeFormat(undefined, { timeZone: evidenceTz });
  } catch {
    return { error: "time_invalid" };
  }
  if (!input.anchored.anchored) {
    const expiresAt = addCalendarDaysInTimeZone(
      evidenceTime.toISOString(),
      14,
      evidenceTz,
    );
    if (
      diffCalendarDaysInTimeZone(
        evidenceTime.toISOString(),
        expiresAt,
        evidenceTz,
      ) > 360
    ) {
      return { error: "horizon_exceeded" };
    }
    return {
      followupEligibleFromAt: evidenceTime.toISOString(),
      expiresAt,
      expirySource: "unanchored_plus_14d",
    };
  }
  const windowEnd = new Date(input.anchored.endAt ?? input.anchored.startAt);
  const windowStart = new Date(input.anchored.startAt);
  const tz = input.anchored.timezone;
  const graceDays = input.kind === "upcoming_event" ? 7 : 14;
  const expiresAt = addCalendarDaysInTimeZone(
    windowEnd.toISOString(),
    graceDays,
    tz,
  );
  if (
    diffCalendarDaysInTimeZone(
      evidenceTime.toISOString(),
      expiresAt,
      evidenceTz,
    ) > 360
  ) {
    return { error: "horizon_exceeded" };
  }
  const followupEligibleFromAt =
    input.kind === "upcoming_event"
      ? addCalendarDaysInTimeZone(windowStart.toISOString(), -14, tz)
      : input.anchored.precision === "date" &&
          input.anchored.endAt !== null &&
          input.dateOnlyDeadline
        ? input.anchored.endAt
      : windowStart.toISOString();
  return {
    followupEligibleFromAt,
    expiresAt,
    expirySource:
      input.kind === "upcoming_event"
        ? "anchored_upcoming_plus_7d"
        : "anchored_awaited_plus_14d",
  };
}
