import { describe, expect, it } from "vitest";

import {
  mergeJournalDateEntries,
  type JournalDateEntry,
} from "../apps/web/app/internal/journal-date-list-state";

function entry(
  dailySessionId: string,
  logicalDate: string,
): JournalDateEntry {
  return { dailySessionId, logicalDate, state: "current" };
}

describe("mergeJournalDateEntries", () => {
  it("appends new entries after the existing ones in order", () => {
    expect(
      mergeJournalDateEntries(
        [entry("a", "2026-10-06")],
        [entry("b", "2026-10-05"), entry("c", "2026-10-04")],
      ),
    ).toEqual([
      entry("a", "2026-10-06"),
      entry("b", "2026-10-05"),
      entry("c", "2026-10-04"),
    ]);
  });

  it("drops entries already present (overlapping page boundary)", () => {
    const merged = mergeJournalDateEntries(
      [entry("a", "2026-10-06"), entry("b", "2026-10-05")],
      [entry("b", "2026-10-05"), entry("c", "2026-10-04")],
    );
    expect(merged.map((value) => value.dailySessionId)).toEqual(["a", "b", "c"]);
  });

  it("drops duplicates within the incoming page itself", () => {
    const merged = mergeJournalDateEntries(
      [],
      [entry("a", "2026-10-06"), entry("a", "2026-10-06")],
    );
    expect(merged).toHaveLength(1);
  });

  it("returns the current list unchanged for an empty page", () => {
    const current = [entry("a", "2026-10-06")];
    expect(mergeJournalDateEntries(current, [])).toEqual(current);
  });
});
