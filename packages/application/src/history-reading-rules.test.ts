import { describe, expect, it } from "vitest";

import {
  EMPTY_HISTORY_RECALL_COVERAGE,
  HISTORY_READING_RULES_VERSION,
  HISTORY_REVIEW_FUNCTION,
  decodeHistoryRecallReceipt,
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
    readingRulesVersion: HISTORY_READING_RULES_VERSION,
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

/**
 * Review fix J: a message the person corrected keeps its original place in the
 * timeline, so a later, unassociated restatement of the old value used to look
 * like "the latest statement". The correction is now marked with when it was
 * made, and the rules say it wins over anything written before that moment.
 */
describe("the person's own correction is visible to the reply (history-reading:v2)", () => {
  const V1_BLOCK = [
    "History reading rules (history-reading:v1), the same on every reply that uses earlier messages:",
    "- Time: each quoted message carries when it was said, not necessarily when the thing happened. Do not turn a message's time into an event date; if their words give no date, leave it undated.",
    "- Past and present: when they later said something different about the same matter, the latest statement is how it is now and the earlier one is how it was then. Speak of the earlier one in the past tense and never as current.",
    "- Corrections: if they themselves later corrected a date, number or name, use the corrected one and do not offer the earlier one as a possibility. Their own correction is the only thing that settles it; a new remark that does not correct anything changes nothing else they said.",
    "- Plans: a plan they later called off did not happen: do not ask how it went. A plan with no later word is still only a plan: do not say how it turned out.",
    "- Their words only: assistant lines are your own earlier replies; they never prove what the person said, felt or meant. Add no reasons, no other people's motives, and no details they did not give, for example why someone left or why someone said something.",
    "- One moment is not a trait: a feeling or remark from one time describes that time. Do not present it as who they are, as a lasting pattern, or as a label such as a diagnosis, orientation, belief or trauma.",
    "- Relevance: use an earlier message only when it helps with what they are saying now. Do not bring up an unrelated earlier thing just because it was found, and do not mention history in every reply. If you connect an earlier statement to how they feel now, offer it as your own tentative reading, not as a fact about them.",
    "- Same you: keep your usual voice and limits. Receive what they said now first; give no advice or verdict unless they ask.",
  ].join("\n");

  it("is version 3", () => {
    expect(HISTORY_READING_RULES_VERSION).toBe("history-reading:v3");
  });

  for (const [name, proposal] of Object.entries(proposals)) {
    it(`points the reply at the marks on the messages themselves on the ${name} path, not at a numbered table`, () => {
      const text = renderHistoryRecallReceipt({
        ...snapshot(proposal, 3),
        corrections: [
          { correctedAt: "2026-09-12T11:40:00.000Z", messageIndex: 1, timezone: "Asia/Shanghai" },
        ],
      });
      // Where the quoted messages are and how to recognise them.
      expect(text).toContain('"[Earlier message."');
      expect(text).toMatch(/first line .*says when it was said/i);
      expect(text).not.toMatch(/Times list/);
      // Corrections are read off the message, never by position.
      expect(text).not.toMatch(/Message \d+ is the person's own correction/);
      expect(text).not.toMatch(/marked above/);
    });
  }

  it("tells the reply never to read a mark out", () => {
    const text = renderHistoryRecallReceipt(snapshot(proposals["date"]!, 2));
    expect(text).toMatch(/bracketed first line .*note for you.*never .*(read|repeat|quote)/i);
  });

  it("says the corrected wording stands and a message noted as written before the correction is not a later change of mind", () => {
    const text = renderHistoryRecallReceipt(snapshot(proposals["date"]!, 2));
    expect(text).toMatch(/says it is their corrected wording.* what they stand by/i);
    expect(text).toMatch(/before (that|the) correction.*not a later change of mind/i);
    // "The latest statement is how it is now" holds only without a correction.
    expect(text).toMatch(/no correction .*latest statement is how it is now/i);
    // A restatement is still theirs: nothing tells the reply to drop or hide it.
    expect(text).not.toMatch(/ignore|hide|remove/i);
  });

  it("replays a result frozen with v2 with the numbered correction line and the Times-list wording", () => {
    const text = renderHistoryRecallReceipt({
      ...snapshot(proposals["date"]!, 2),
      corrections: [
        { correctedAt: "2026-09-12T11:40:00.000Z", messageIndex: 1, timezone: "Asia/Shanghai" },
      ],
      readingRulesVersion: "history-reading:v2",
    });
    expect(text).toContain(
      "Message 1 is the person's own correction of what they first wrote at that point; they made the correction at 2026-09-12 19:40 (Asia/Shanghai).",
    );
    expect(text).toContain("(each has its own time in the Times list)");
    expect(text).toContain("History reading rules (history-reading:v2)");
    expect(text).toContain("- Corrections: a message marked above as the person's own correction is what they stand by");
    expect(text).not.toContain("[Earlier message.");
  });

  it("replays a result frozen before this version with the v1 rules, byte for byte", () => {
    const { readingRulesVersion: _unused, ...frozen } = snapshot(proposals["date"]!, 2);
    const text = renderHistoryRecallReceipt(frozen);
    expect(text.slice(text.indexOf("History reading rules"))).toBe(V1_BLOCK);
    expect(
      renderHistoryRecallReceipt({ ...frozen, readingRulesVersion: "history-reading:v1" }),
    ).toBe(text);
  });

  it("refuses a frozen result that names reading rules this build does not know", () => {
    const encoded = JSON.stringify({
      ...snapshot(proposals["date"]!, 2),
      readingRulesVersion: "history-reading:v9",
    });
    expect(() => decodeHistoryRecallReceipt(encoded)).toThrow();
  });
});
