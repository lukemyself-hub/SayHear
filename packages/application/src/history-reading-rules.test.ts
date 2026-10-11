import { describe, expect, it } from "vitest";

import {
  EMPTY_HISTORY_RECALL_COVERAGE,
  HISTORY_READING_RULES_VERSION,
  HISTORY_REVIEW_FUNCTION,
  renderHistoryRecallReceipt,
  type HistoryQueryProposal,
  type HistoryRecallReceiptSnapshot,
} from "./history-recall";

/**
 * Issue #318: every path that quotes older messages (date review, older
 * search, natural continuation) carries the same reading contract, so past vs
 * present, corrections, plans, assistant lines, one-off feelings and
 * relevance are read the same way regardless of how the messages were found.
 */

const proposals: Readonly<Record<string, HistoryQueryProposal>> = {
  continuation: {
    continuation: { basis: ["current_input"] },
    kind: "search_experience",
    people: [],
    searchTerms: ["offer"],
  },
  date: {
    endDate: "2026-09-14",
    kind: "review_dates",
    sourceScope: "conversation_text",
    startDate: "2026-09-14",
    timeBasis: "expressed_date",
  },
  search: { kind: "search_experience", people: [], searchTerms: ["offer"] },
} as unknown as Record<string, HistoryQueryProposal>;

function snapshot(
  proposal: HistoryQueryProposal,
  injectedRows: number,
): HistoryRecallReceiptSnapshot {
  return {
    droppedAtCompile: 0,
    injectedRows,
    policyVersion: "history-recall:test",
    result: {
      coverage: { ...EMPTY_HISTORY_RECALL_COVERAGE, selectedRows: injectedRows },
      failureCode: null,
      plan: null,
      proposal,
      status: "completed",
    },
    version: 1,
  };
}

describe("history review function guidance", () => {
  it("covers a feeling or situation that touches something they told you earlier, with clues taken from the current message and no trigger for unrelated trips", () => {
    const text = HISTORY_REVIEW_FUNCTION.description;
    expect(text).toMatch(/how they feel/i);
    expect(text).toMatch(/what the person told you before matters to/i);
    expect(text).toMatch(/words that literally appear in the current message/i);
    expect(text).toMatch(/not .*because .*related by topic only|unrelated/i);
  });
});

describe("history reading rules", () => {
  for (const [name, proposal] of Object.entries(proposals)) {
    it(`reach the model on the ${name} path when messages are quoted`, () => {
      const text = renderHistoryRecallReceipt(snapshot(proposal, 2));
      expect(text).toContain(`History reading rules (${HISTORY_READING_RULES_VERSION})`);
      expect(text).toMatch(/latest statement/i);
      expect(text).toMatch(/corrected/i);
      expect(text).toMatch(/called off/i);
      expect(text).toMatch(/assistant lines/i);
      expect(text).toMatch(/not a trait|one moment/i);
      expect(text).toMatch(/unrelated/i);
      expect(text).toMatch(/motive/i);
    });

    it(`stay out of the ${name} path when nothing is quoted`, () => {
      const text = renderHistoryRecallReceipt(snapshot(proposal, 0));
      expect(text).not.toContain("History reading rules");
    });
  }

  it("is one identical block on every path", () => {
    const block = (text: string) =>
      text.slice(text.indexOf("History reading rules"));
    const blocks = Object.values(proposals).map((proposal) =>
      block(renderHistoryRecallReceipt(snapshot(proposal, 2))),
    );
    expect(new Set(blocks).size).toBe(1);
  });
});
