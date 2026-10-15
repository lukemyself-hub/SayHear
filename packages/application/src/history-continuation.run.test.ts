import { describe, expect, it } from "vitest";
import {
  asConversationEventRevisionId,
  asDailySessionId,
  asUserId,
} from "@sayhear/domain";

import type { HistoryContinuationSignals } from "./history-continuation";
import {
  runExperienceSearch,
  searchPatternsOf,
  type ExperienceSearchSourcePort,
} from "./history-experience-search";
import {
  HISTORY_RECALL_DEFAULT_POLICY,
  normalizeHistoryReviewCall,
  renderHistoryRecallReceipt,
  type HistoryExperienceSearchProposal,
  type HistoryRecallSourceItem,
} from "./history-recall";

type Row = { at: string; session: string; text: string };

/** A source over a handful of rows that matches clues the way the SQL does. */
function fakeSource(rows: readonly Row[]) {
  const reads: string[] = [];
  const items = rows.map((row, index): HistoryRecallSourceItem => ({
    actor: "user",
    dailySessionId: asDailySessionId(`00000000-0000-7000-8000-${row.session.padStart(12, "0")}`),
    exclusion: null,
    expressedAt: row.at,
    expressionTimezone: "Europe/London",
    expressionTimezoneSource: "request",
    generatingUserRevisionId: null,
    localDate: row.at.slice(0, 10),
    revisionId: asConversationEventRevisionId(`00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`),
    sequence: index + 1,
    text: row.text,
  }));
  const source: ExperienceSearchSourcePort = {
    lookupVerifiedAliases: async () => [],
    readContext: async () => ({ failure: null, items }),
    searchHits: async ({ plan }) => {
      reads.push("hits");
      const patterns = searchPatternsOf(plan);
      const hits = items.flatMap((item) => {
        const text = item.text.toLowerCase();
        const matched = [
          ...new Set(
            patterns
              .filter((p) =>
                p.kind === "word" ? new RegExp(p.value).test(text) : text.includes(p.value),
              )
              .map((p) => p.group),
          ),
        ];
        return matched.length > 0 ? [{ ...item, matchedGroups: matched }] : [];
      });
      return {
        failure: null,
        hits,
        oldestScannedAt: "2026-01-01T00:00:00.000Z",
        readLatencyMs: 1,
        scanComplete: true,
        scannedRows: items.length,
      };
    },
  };
  return { reads, source };
}

const ROWS: readonly Row[] = [
  { at: "2026-06-02T18:30:00.000Z", session: "1", text: "I posted my entry for the juried ceramics show: three stoneware bowls." },
  { at: "2026-09-17T08:10:00.000Z", session: "2", text: "Sent my application for the archive post at the records office." },
];

const signals = (over: Partial<HistoryContinuationSignals> = {}): HistoryContinuationSignals => ({
  adjacentUserTexts: [],
  currentInputText: "And a letter came. They finally wrote back.",
  dialogueState: null,
  ...over,
});

const proposalOf = (args: Record<string, unknown>): HistoryExperienceSearchProposal => {
  const parsed = normalizeHistoryReviewCall({ rawArguments: JSON.stringify(args) });
  if (!("proposal" in parsed) || parsed.proposal.kind !== "search_experience") throw new Error("proposal");
  return parsed.proposal;
};

const run = (
  args: Record<string, unknown>,
  s: HistoryContinuationSignals,
  rows: readonly Row[] = ROWS,
) => {
  const fake = fakeSource(rows);
  return {
    fake,
    result: runExperienceSearch({
      cutoff: new Date("2026-09-23T19:23:00.000Z"),
      expectedDataEpoch: 1,
      policy: HISTORY_RECALL_DEFAULT_POLICY,
      proposal: proposalOf(args),
      requestRevisionId: asConversationEventRevisionId("00000000-0000-7000-8000-0000000000ff"),
      signals: s,
      source: fake.source,
      timezone: "Europe/London",
      userId: asUserId("00000000-0000-7000-8000-0000000000aa"),
    }),
  };
};

describe("continuation search", () => {
  it("fails closed, without reading, when every named signal is unavailable", async () => {
    const { fake, result } = run(
      { continuation_basis: ["dialogue_state"], search_terms: ["bowls", "entry"] },
      signals(),
    );
    const outcome = await result;
    expect(outcome).toMatchObject({
      coverage: { continuation: { basis: [], basisRejected: ["dialogue_state"], verdict: "none" } },
      failureCode: "continuation_basis_unavailable",
      status: "failed",
    });
    expect(fake.reads).toEqual([]);
  });

  it("drops an unavailable signal but keeps the valid ones, and records both", async () => {
    const { result } = run(
      { continuation_basis: ["current_input", "dialogue_state"], search_terms: ["bowls", "entry"] },
      signals(),
    );
    const outcome = await result;
    expect(outcome.coverage.continuation).toMatchObject({
      basis: ["current_input"],
      basisRejected: ["dialogue_state"],
      dialogueState: "unavailable",
    });
  });

  it("does not search at all when the only clues are greetings or thanks", async () => {
    const { fake, result } = run(
      { continuation_basis: ["current_input"], search_terms: ["hello", "thanks", "你好"] },
      signals({ currentInputText: "hello, thanks" }),
    );
    const outcome = await result;
    expect(outcome).toMatchObject({ failureCode: "search_terms_unusable", status: "failed" });
    expect(fake.reads).toEqual([]);
  });

  it("finds a single supported earlier matter and says to continue from it without asking to retell", async () => {
    const { result } = run(
      { continuation_basis: ["current_input", "adjacent_user"], search_terms: ["bowls", "entry"] },
      signals({ adjacentUserTexts: ["First time I threw anything decent since I sent those bowls away."] }),
    );
    const outcome = await result;
    expect(outcome.coverage.continuation).toMatchObject({ anchoredClues: 1, verdict: "single" });
    const receipt = renderHistoryRecallReceipt({
      droppedAtCompile: 0,
      injectedRows: 1,
      policyVersion: "x",
      result: outcome,
      version: 1,
    });
    expect(receipt).toContain("without asking them to tell it again");
    expect(receipt).not.toContain("ONE short");
  });

  it("keeps two fitting matters apart and asks one question when nothing in the current talk separates them", async () => {
    const { result } = run(
      { continuation_basis: ["current_input"], search_terms: ["entry", "application"] },
      signals({ currentInputText: "I finally got a reply!" }),
    );
    const outcome = await result;
    expect(outcome.coverage.continuation).toMatchObject({ anchoredClues: 0, verdict: "tied" });
    expect(outcome.itemRefs.map((ref) => ref.group)).toEqual([1, 2]);
    const receipt = renderHistoryRecallReceipt({
      droppedAtCompile: 0,
      injectedRows: 2,
      policyVersion: "x",
      result: outcome,
      version: 1,
    });
    expect(receipt).toContain("exactly ONE short");
    expect(receipt).toContain("do not pick the most recent");
  });

  it("names a leader only when the current talk's own words point at exactly one matter", async () => {
    const { result } = run(
      { continuation_basis: ["current_input", "adjacent_user"], search_terms: ["bowls", "application"] },
      signals({ adjacentUserTexts: ["Threw anything decent since I sent those bowls away."] }),
    );
    const outcome = await result;
    expect(outcome.coverage.continuation).toMatchObject({ leadingGroup: 1, verdict: "leading" });
    expect(outcome.coverage.continuation!.occasions).toEqual([
      { anchoredSupport: 1, group: 1, support: 1 },
      { anchoredSupport: 0, group: 2, support: 1 },
    ]);
  });

  it("falls back to an ordinary reply, not an apology, when nothing is found", async () => {
    const { result } = run(
      { continuation_basis: ["current_input"], search_terms: ["marathon", "running"] },
      signals(),
    );
    const outcome = await result;
    expect(outcome.coverage.search?.outcome).toBe("no_match");
    const receipt = renderHistoryRecallReceipt({
      droppedAtCompile: 0,
      injectedRows: 0,
      policyVersion: "x",
      result: outcome,
      version: 1,
    });
    expect(receipt).toContain("Reply to what they just said as you normally would");
    expect(receipt).not.toContain("could not look it up");
  });
});
