import { localDateAt } from "@sayhear/application";

/**
 * Presentation-only helpers for the current-conversation status line. The
 * authoritative ownership still comes from the server read; these functions
 * only decide how to label a `logical_date` the server already returned and
 * never infer which session is writable.
 */

/** Formats a `YYYY-MM-DD` logical date as `2026年10月6日`. */
export function formatLogicalDate(logicalDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(logicalDate);
  if (!match) {
    return logicalDate;
  }
  const [, year, month, day] = match;
  return `${Number(year)}年${Number(month)}月${Number(day)}日`;
}

/**
 * Whether the Daily Session's logical date is still the owner's current local
 * date in the timezone captured when the exchange started. Invalid timezones
 * fail closed to `false` so the UI shows the actual date instead of "今天".
 */
export function isCurrentLocalDate(input: {
  logicalDate: string;
  now: Date;
  timezone: string;
}): boolean {
  try {
    return localDateAt(input.now, input.timezone) === input.logicalDate;
  } catch {
    return false;
  }
}

/**
 * The muted chat status line: `<date> · 今天` while the owned session is the
 * owner's current local date, otherwise `<date> · 继续交流` for a cross-midnight
 * exchange that still belongs to an earlier date.
 */
export function conversationStatusLine(input: {
  logicalDate: string;
  now: Date;
  timezone: string;
}): string {
  const note = isCurrentLocalDate(input) ? "今天" : "继续交流";
  return `${formatLogicalDate(input.logicalDate)} · ${note}`;
}

/**
 * The module list's "current conversation" entry. It is only "今天" when the
 * authoritative active session is on the owner's current local date; an open
 * cross-midnight exchange keeps its actual owning date.
 */
export function currentConversationEntryLabel(input: {
  logicalDate: string;
  now: Date;
  timezone: string;
}): string {
  return isCurrentLocalDate(input)
    ? "今天"
    : `${formatLogicalDate(input.logicalDate)} · 继续交流`;
}
