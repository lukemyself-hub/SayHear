/**
 * Pure, DOM-free state helpers for the Journal date list (SPEC #260).
 *
 * The cursor pagination can legitimately return an entry that is already on
 * screen (a repeated cursor fetch or an overlapping page boundary), so the
 * client must dedupe by `dailySessionId` before appending. Duplicates would
 * otherwise render the same date twice and produce duplicate React keys.
 */

export type JournalDateEntry = Readonly<{
  dailySessionId: string;
  logicalDate: string;
  state: "current" | "outdated" | "updating";
}>;

/**
 * Appends `earlier` entries to `current`, preserving order and first-wins
 * semantics: an entry whose `dailySessionId` is already present is skipped.
 */
export function mergeJournalDateEntries(
  current: readonly JournalDateEntry[],
  earlier: readonly JournalDateEntry[],
): readonly JournalDateEntry[] {
  const seen = new Set(current.map((entry) => entry.dailySessionId));
  const merged = [...current];
  for (const entry of earlier) {
    if (!seen.has(entry.dailySessionId)) {
      seen.add(entry.dailySessionId);
      merged.push(entry);
    }
  }
  return merged;
}
