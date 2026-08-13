import { describe, expect, it } from "vitest";

import { createBoundedJournalExport, MAX_JOURNAL_EXPORT_CHARACTERS } from "../apps/web/app/internal/journal-export";

describe("bounded Journal export", () => {
  const journal = (text: string) => ({
    dailySessionId: "01984477-31e1-7595-92c6-06889cb0fdde",
    logicalDate: "2026-08-12",
    state: "current" as const,
    version: { locale: "en-US", statements: [{ id: "s", text, epistemicStatus: "supported_expression" as const, evidenceItemIds: ["e"] }] },
  });

  it("exports exactly one current Journal without Account Data", () => {
    expect(createBoundedJournalExport(journal("The owner described a walk."))).toEqual({
      content: "2026-08-12\n\nThe owner described a walk.\n",
      fileName: "sayhear-journal-2026-08-12.txt",
    });
  });

  it("refuses an oversized Journal rather than silently truncating it", () => {
    expect(createBoundedJournalExport(journal("x".repeat(MAX_JOURNAL_EXPORT_CHARACTERS)))).toBeNull();
  });
});
