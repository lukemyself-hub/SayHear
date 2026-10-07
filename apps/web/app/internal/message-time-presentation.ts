/**
 * Pure presentation and interaction-decision helpers for persisted message
 * times (SPEC #260 ticket #264).
 *
 * All functions are DOM-free and side-effect free so timezone rendering,
 * cross-midnight date suffixes, missing/invalid time handling and the
 * tap-to-toggle guard stay unit-testable.
 *
 * Product safety notes:
 * - The only accepted source is the server-persisted instant
 *   (`conversation_events.created_at`). A missing or unparseable value renders
 *   nothing rather than a fabricated receive/render/refresh time.
 * - Formatting never changes `logical_date` (Daily Session ownership); it only
 *   decides how to label the already-persisted instant in the reader's
 *   timezone.
 */

/** A tap longer than this is treated as a long-press (selection/copy), not a toggle. */
export const MESSAGE_TIME_LONG_PRESS_MS = 500;
/** Pointer movement beyond this is a drag/scroll, not a toggle. */
export const MESSAGE_TIME_DRAG_THRESHOLD_PX = 8;

type ZonedCalendarParts = Readonly<{
  day: string;
  hour: string;
  minute: string;
  month: string;
  year: string;
}>;

const calendarFormatters = new Map<string, Intl.DateTimeFormat>();
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function calendarFormatter(timezone: string): Intl.DateTimeFormat {
  const key = `calendar:${timezone}`;
  let formatter = calendarFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric",
    });
    calendarFormatters.set(key, formatter);
  }
  return formatter;
}

function timeFormatter(timezone: string): Intl.DateTimeFormat {
  const key = `time:${timezone}`;
  let formatter = timeFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      timeZone: timezone,
    });
    timeFormatters.set(key, formatter);
  }
  return formatter;
}

/** The calendar fields of `instant` in `timezone`, or null for an invalid zone. */
function zonedParts(
  instant: Date,
  timezone: string,
): ZonedCalendarParts | null {
  try {
    const values = Object.fromEntries(
      calendarFormatter(timezone)
        .formatToParts(instant)
        .map((part) => [part.type, part.value]),
    );
    return {
      day: values.day ?? "",
      hour: values.hour ?? "",
      minute: values.minute ?? "",
      month: values.month ?? "",
      year: values.year ?? "",
    };
  } catch {
    return null;
  }
}

function dateKey(parts: ZonedCalendarParts): string {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Formats a persisted message instant for display in `timezone` as `HH:MM`.
 * When the message's local calendar date differs from `now`'s local calendar
 * date (a cross-midnight read), the month/day—or full date across a year
 * boundary—is prepended. Returns null when the instant is missing or invalid;
 * callers must render nothing in that case instead of inventing a time.
 */
export function formatMessageTimestamp(input: {
  createdAt: string | null | undefined;
  now: Date;
  timezone: string;
}): string | null {
  if (typeof input.createdAt !== "string" || input.createdAt.length === 0) {
    return null;
  }
  const created = new Date(input.createdAt);
  if (Number.isNaN(created.getTime())) {
    return null;
  }
  const createdParts = zonedParts(created, input.timezone);
  const nowParts = zonedParts(input.now, input.timezone);
  if (createdParts === null || nowParts === null) {
    return null;
  }
  let time: string;
  try {
    time = timeFormatter(input.timezone).format(created);
  } catch {
    return null;
  }
  if (dateKey(createdParts) === dateKey(nowParts)) {
    return time;
  }
  const date =
    createdParts.year === nowParts.year
      ? `${Number(createdParts.month)}月${Number(createdParts.day)}日`
      : `${Number(createdParts.year)}年${Number(createdParts.month)}月${Number(createdParts.day)}日`;
  return `${date} ${time}`;
}

export type MessageTimeTargetKind = "interactive" | "other";

/**
 * Whether a tap/click on a message body should toggle its time. It never
 * toggles when there is no persisted time, when the target is a link/button,
 * when the reader has an active text selection, when the gesture was a
 * long-press or drag, or on a hover-capable pointer (desktop hover already
 * reveals the time and moving away hides it again).
 */
export function shouldToggleMessageTime(input: {
  coarsePointer: boolean;
  durationMs: number;
  hasSelection: boolean;
  hasTime: boolean;
  movedPx: number;
  pointerType: string;
  targetKind: MessageTimeTargetKind;
}): boolean {
  if (!input.hasTime) {
    return false;
  }
  if (input.targetKind !== "other") {
    return false;
  }
  if (input.hasSelection) {
    return false;
  }
  if (input.durationMs >= MESSAGE_TIME_LONG_PRESS_MS) {
    return false;
  }
  if (input.movedPx > MESSAGE_TIME_DRAG_THRESHOLD_PX) {
    return false;
  }
  return input.pointerType === "touch" || input.coarsePointer;
}

/** Whether a persisted instant can be rendered at all (missing/invalid => false). */
export function hasRenderableMessageTime(
  createdAt: string | null | undefined,
): boolean {
  return (
    typeof createdAt === "string" &&
    createdAt.length > 0 &&
    !Number.isNaN(new Date(createdAt).getTime())
  );
}

/**
 * The server commit instant carried by a streamed commit event, accepted only
 * when it is a parseable ISO-8601 value. Anything else yields `undefined` so the
 * message renders no time; the client never substitutes `Date.now()` or any
 * other receive/render time for a missing authoritative instant.
 */
export function eventMessageCreatedAt(value: unknown): string | undefined {
  return hasRenderableMessageTime(
    typeof value === "string" ? value : undefined,
  )
    ? (value as string)
    : undefined;
}
