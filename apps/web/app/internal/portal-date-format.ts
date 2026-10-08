/**
 * Pure logical-date formatting for the Portal shell.
 *
 * These helpers live outside `portal-conversation.ts` on purpose. That module
 * imports `localDateAt` from `@sayhear/application`, and the application barrel
 * reads `node:perf_hooks` / `node:crypto`; a client component importing it for
 * a label would pull those Node builtins into the browser bundle and fail the
 * `[app-client]` chunk. Nothing here may import server code.
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
 * Formats a logical date for the module lists. Same-year dates keep the
 * compact form used by the reference design; a different year is included so
 * the date stays unambiguous across a year boundary.
 */
export function formatShortLogicalDate(
  logicalDate: string,
  referenceYear: number,
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(logicalDate);
  if (!match) {
    return logicalDate;
  }
  const [, year, month, day] = match;
  const monthDay = `${Number(month)}月${Number(day)}日`;
  return Number(year) === referenceYear ? monthDay : `${Number(year)}年${monthDay}`;
}
