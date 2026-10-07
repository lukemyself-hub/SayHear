/**
 * Pure, DOM-free integration helpers for the Internal Portal (SPEC #260
 * ticket #269).
 *
 * Two concerns live here:
 * 1. The tools rail must not drop the entry the reader already selected
 *    (AC-19). Restoring it is in-memory only, for one page session; nothing is
 *    written to `localStorage`/`sessionStorage`.
 * 2. The read-only history page explains where an interrupted response came
 *    from before sending the reader into the current writable conversation.
 *
 * Product safety notes:
 * - A fresh page session starts with empty memory, so a direct navigation to a
 *   bare tool URL still shows the empty/selection state.
 * - The history guidance states the source date and never claims the retry
 *   rewrites the historical Daily Session.
 */

export const TOOL_BASE_PATHS = [
  "/internal/context-inspector",
  "/internal/reflection-inspector",
  "/internal/candidate-review",
] as const;

/** The bare route the tools rail falls back to when nothing is remembered. */
export const DEFAULT_TOOL_HREF = TOOL_BASE_PATHS[0];

export type ToolLocation = Readonly<{ pathname: string; search: string }>;

export function isToolPath(pathname: string): boolean {
  return TOOL_BASE_PATHS.some(
    (base) => pathname === base || pathname.startsWith(`${base}/`),
  );
}

/**
 * Normalizes an address into a tool location, or `null` when the path is not a
 * tool route. `search` is kept verbatim (only the leading `?` is fixed up) so
 * the committed URL contract is never rewritten.
 */
export function toToolLocation(
  pathname: string,
  search: string,
): ToolLocation | null {
  if (!isToolPath(pathname)) {
    return null;
  }
  const normalizedSearch =
    search.length === 0 ? "" : search.startsWith("?") ? search : `?${search}`;
  return { pathname, search: normalizedSearch };
}

export function toolLocationHref(location: ToolLocation): string {
  return `${location.pathname}${location.search}`;
}

export type ToolNavigationMemory = Readonly<{
  lastActive(): ToolLocation | null;
  remember(location: ToolLocation | null): void;
  rememberedFor(pathname: string): ToolLocation | null;
}>;

/**
 * In-memory (never persisted) store of the last selected entry per tool route.
 * A page reload creates a new, empty store, so the rail and the tool list fall
 * back to the bare URLs.
 */
export function createToolNavigationMemory(): ToolNavigationMemory {
  const remembered = new Map<string, ToolLocation>();
  let lastActive: ToolLocation | null = null;
  return {
    lastActive: () => lastActive,
    remember(location) {
      if (location !== null && isToolPath(location.pathname)) {
        remembered.set(location.pathname, location);
        lastActive = location;
      }
    },
    rememberedFor: (pathname) => remembered.get(pathname) ?? null,
  };
}

/**
 * Where the tools rail should navigate. When the reader is already inside a
 * tool, keep the exact current URL so a selected entry is not lost; from
 * another module reuse the in-memory last selection; otherwise open the default
 * bare tool route.
 */
export function resolveToolsRailHref(input: {
  current: ToolLocation | null;
  lastActive: ToolLocation | null;
}): string {
  if (input.current !== null) {
    return toolLocationHref(input.current);
  }
  if (input.lastActive !== null) {
    return toolLocationHref(input.lastActive);
  }
  return DEFAULT_TOOL_HREF;
}

/**
 * Where one tool entry in the module list should navigate. The active tool
 * keeps its current selection; another tool restores its own last selection;
 * with no memory the committed bare URL is used.
 */
export function resolveToolEntryHref(input: {
  base: string;
  current: ToolLocation | null;
  remembered: ToolLocation | null;
}): string {
  if (input.current !== null && input.current.pathname === input.base) {
    return toolLocationHref(input.current);
  }
  if (
    input.remembered !== null &&
    input.remembered.pathname === input.base
  ) {
    return toolLocationHref(input.remembered);
  }
  return input.base;
}

/** Formats `YYYY-MM-DD` as `2026年10月6日`; malformed values pass through. */
export function formatPortalDate(logicalDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(logicalDate);
  if (!match) {
    return logicalDate;
  }
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}

/** Whether a value is a plain `YYYY-MM-DD` logical date. */
export function isLogicalDateValue(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * The Journal rail target. It preserves the date the reader last selected in
 * this page session (in-memory, never storage) and falls back to the committed
 * bare `/internal/journals` URL.
 */
export function journalRailHref(logicalDate: string | null): string {
  return isLogicalDateValue(logicalDate)
    ? `/internal/journals?date=${encodeURIComponent(logicalDate)}`
    : "/internal/journals";
}

export type InterruptedHistoryGuidance = Readonly<{
  actionLabel: string;
  message: string;
}>;

/**
 * Guidance shown on an interrupted item in read-only history. The retry itself
 * belongs to the current writable conversation; this page never appends to or
 * reactivates the historical Daily Session, so the action only navigates there
 * and says which date the interruption came from.
 */
export function interruptedHistoryGuidance(
  logicalDate: string,
): InterruptedHistoryGuidance {
  return {
    actionLabel: "前往当前交流",
    message: `这次中断发生在 ${formatPortalDate(logicalDate)}。可在当前可写交流中重新发起；此历史记录不会被改写。`,
  };
}
