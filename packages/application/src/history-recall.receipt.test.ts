import { describe, expect, it } from "vitest";

import {
  EMPTY_HISTORY_RECALL_COVERAGE,
  renderHistoryRecallReceipt,
  type HistoryQueryPlan,
  type HistoryQueryProposal,
  type HistoryRecallCoverage,
  type HistoryRecallReceiptSnapshot,
  type HistoryRecallResult,
} from "./history-recall";

const proposal: HistoryQueryProposal = {
  endDate: "2026-09-14",
  kind: "review_dates",
  sourceScope: "conversation_text",
  startDate: "2026-09-14",
  timeBasis: "expressed_date",
};
const plan: HistoryQueryPlan = {
  cutoff: "2026-09-15T02:30:00.000Z",
  dateCount: 1,
  endDate: "2026-09-14",
  localDates: ["2026-09-14"],
  readEndDate: "2026-09-14",
  readStartDate: "2026-09-14",
  startDate: "2026-09-14",
  timeBasis: "expressed_date",
  timezone: "Asia/Shanghai",
};

function snapshot(
  status: HistoryRecallResult["status"],
  coverage: Partial<HistoryRecallCoverage>,
  over: {
    droppedAtCompile?: number;
    failureCode?: HistoryRecallResult["failureCode"];
    plan?: HistoryQueryPlan | null;
    proposal?: HistoryQueryProposal;
  } = {},
): HistoryRecallReceiptSnapshot {
  return {
    droppedAtCompile: over.droppedAtCompile ?? 0,
    injectedRows: coverage.selectedRows ?? 0,
    policyVersion: "history-recall:v2",
    result: {
      coverage: { ...EMPTY_HISTORY_RECALL_COVERAGE, ...coverage },
      failureCode: over.failureCode ?? null,
      plan: over.plan === undefined ? plan : over.plan,
      proposal: over.proposal ?? proposal,
      status,
    },
    version: 1,
  };
}

const guidance = (snap: HistoryRecallReceiptSnapshot) =>
  renderHistoryRecallReceipt(snap)
    .split("\n")
    .filter((line) => line.startsWith("Answer guidance"))
    .join("\n");

describe("history recall answer guidance", () => {
  const complete = snapshot("completed", {
    enumerationComplete: true,
    perDate: [{ enumeratedRows: 4, localDate: "2026-09-14", selectedRows: 4, state: "complete" }],
    selectedRows: 4,
  });
  const empty = snapshot("completed", {
    enumerationComplete: true,
    perDate: [{ enumeratedRows: 0, localDate: "2026-09-14", selectedRows: 0, state: "empty" }],
  });
  const trimmed = snapshot("partial", {
    enumerationComplete: true,
    omitted: { budget_exhausted: 3 },
    perDate: [{ enumeratedRows: 9, localDate: "2026-09-14", selectedRows: 6, state: "partial" }],
    selectedRows: 6,
  });
  const unfinished = snapshot("partial", {
    enumerationComplete: false,
    perDate: [{ enumeratedRows: 9, localDate: "2026-09-14", selectedRows: 9, state: "partial" }],
    readThrough: "2026-09-14T10:30:00.000Z",
    selectedRows: 9,
  });
  const failed = snapshot("failed", {}, { failureCode: "source_read_timeout" });

  it("tells the four outcomes apart in what the reply should say", () => {
    const texts = [complete, empty, trimmed, failed].map(guidance);
    expect(new Set(texts).size).toBe(4);
    expect(guidance(empty)).toContain("did not find saved messages");
    expect(guidance(failed)).toContain("could not look it up right now");
    expect(guidance(failed)).not.toContain("did not find saved messages");
    expect(guidance(complete)).toContain("every saved message");
    expect(guidance(trimmed)).toContain("only part");
  });

  it("names where an unfinished read stopped, in the person's own clock", () => {
    const text = renderHistoryRecallReceipt(unfinished);
    expect(text).toContain("Read through 2026-09-14 18:30");
    expect(guidance(unfinished)).toContain("after that point");
  });

  it("explains that an experienced date is not recorded and cannot be proven complete", () => {
    const experienced = snapshot(
      "partial",
      {
        enumerationComplete: true,
        limits: ["experience_time_not_recorded"],
        perDate: [{ enumeratedRows: 3, localDate: "2026-09-14", selectedRows: 3, state: "complete" }],
        selectedRows: 3,
        timeBasis: "experienced_date",
      },
      {
        plan: { ...plan, readEndDate: "2026-09-15", timeBasis: "experienced_date" },
        proposal: { ...proposal, timeBasis: "experienced_date" },
      },
    );
    const text = renderHistoryRecallReceipt(experienced);
    expect(text).toContain("when the person said things");
    expect(guidance(experienced)).toContain("not recorded");
    expect(guidance(experienced)).toContain("do not claim");
    expect(text).toContain("2026-09-14 to 2026-09-15");
  });

  it("never leaks internal vocabulary into the instructions for the reply", () => {
    for (const snap of [complete, empty, trimmed, unfinished, failed]) {
      expect(guidance(snap)).not.toMatch(/policy|receipt|section|token|coverage|status|database|window/i);
    }
  });
});
