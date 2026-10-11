import { describe, expect, it } from "vitest";
import { asConversationEventRevisionId, asDailySessionId } from "@sayhear/domain";

import {
  HISTORY_RECALL_DEFAULT_POLICY,
  selectHistoryRecall,
  type HistoryQueryProposal,
  type HistoryRecallSourceItem,
  type HistoryRecallSourceSnapshot,
} from "./history-recall";

const proposal: HistoryQueryProposal = {
  endDate: "2026-08-20",
  kind: "review_dates",
  sourceScope: "conversation_text",
  startDate: "2026-08-20",
  timeBasis: "expressed_date",
};

let counter = 0;
const at = (hhmm: string, date = "2026-08-20") => `${date}T${hhmm}:00.000Z`;
const row = (
  hhmm: string,
  actor: "user" | "assistant",
  text: string,
  extra: Partial<HistoryRecallSourceItem> = {},
): HistoryRecallSourceItem => {
  counter += 1;
  return {
    actor,
    dailySessionId: asDailySessionId("00000000-0000-7000-8000-000000000001"),
    exclusion: null,
    expressedAt: at(hhmm),
    expressionTimezone: "UTC",
    expressionTimezoneSource: "request",
    generatingUserRevisionId: null,
    localDate: "2026-08-20",
    revisionId: asConversationEventRevisionId(
      `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    ),
    sequence: counter,
    text,
    ...extra,
  };
};

const select = (
  items: HistoryRecallSourceItem[],
  maxContextTokens: number,
  over: Partial<HistoryRecallSourceSnapshot> = {},
  proposalOver: Partial<HistoryQueryProposal> = {},
  planOver: Record<string, unknown> = {},
) =>
  selectHistoryRecall({
    plan: {
      cutoff: "2026-08-21T02:00:00.000Z",
      dateCount: 1,
      endDate: "2026-08-20",
      localDates: ["2026-08-20"],
      readEndDate: "2026-08-20",
      readStartDate: "2026-08-20",
      startDate: "2026-08-20",
      timeBasis: proposalOver.timeBasis ?? "expressed_date",
      timezone: "UTC",
      ...planOver,
    },
    policy: { ...HISTORY_RECALL_DEFAULT_POLICY, maxContextTokens },
    proposal: { ...proposal, ...proposalOver },
    snapshot: {
      currentConversationRows: 0,
      enumerationComplete: true,
      failure: null,
      items,
      pages: 1,
      readLatencyMs: 1,
      ...over,
    },
  });

describe("history recall time-block coverage", () => {
  it("keeps every time block alive when a late long block would take the whole budget", () => {
    const early1 = row("01:00", "user", "a".repeat(40));
    const early2 = row("04:00", "user", "b".repeat(40));
    const late = Array.from({ length: 10 }, (_, index) =>
      row(`14:${String(index).padStart(2, "0")}`, "user", `${"c".repeat(399)}${index}`),
    );
    const result = select([early1, early2, ...late], 400);
    const picked = new Set(result.itemRefs.map((ref) => String(ref.revisionId)));
    expect(picked.has(String(early1.revisionId))).toBe(true);
    expect(picked.has(String(early2.revisionId))).toBe(true);
    expect(late.some((entry) => picked.has(String(entry.revisionId)))).toBe(true);
    expect(result.coverage.selectedTokens).toBeLessThanOrEqual(400);
    expect(result.coverage).toMatchObject({ blocks: 3, blocksCovered: 3 });
    expect(result.status).toBe("partial");
    const times = result.itemRefs.map((ref) => ref.expressedAt);
    expect(times).toEqual(times.toSorted());
  });

  it("gives up the assistant's replies before any of the person's own words", () => {
    const user1 = row("01:00", "user", "u".repeat(160));
    const reply = row("01:01", "assistant", "r".repeat(160), {
      generatingUserRevisionId: user1.revisionId,
    });
    const user2 = row("01:02", "user", "v".repeat(160));
    const result = select([user1, reply, user2], 90);
    expect(result.itemRefs.map((ref) => ref.actor)).toEqual(["user", "user"]);
    expect(result.coverage.omitted).toEqual({ assistant_context_trimmed: 1 });
    expect(result.status).toBe("completed");
  });

  it("drops an identical repeated message instead of spending budget twice", () => {
    const result = select(
      [row("01:00", "user", "z".repeat(40)), row("01:05", "user", "z".repeat(40))],
      1_000,
    );
    expect(result.itemRefs).toHaveLength(1);
    expect(result.coverage.omitted).toEqual({ duplicate_text: 1 });
    expect(result.status).toBe("completed");
  });

  it("reports how far an unfinished read got", () => {
    const rows = [row("01:00", "user", "aaaaaaaa"), row("02:00", "user", "bbbbbbbb")];
    const result = select(rows, 1_000, { enumerationComplete: false });
    expect(result.status).toBe("partial");
    expect(result.coverage.readThrough).toBe(at("02:00"));
    expect(select(rows, 1_000).coverage.readThrough).toBeNull();
  });

  it("never calls an experienced date complete, because the event date is not recorded", () => {
    const rows = [row("01:00", "user", "aaaaaaaa")];
    const result = select(rows, 1_000, {}, { timeBasis: "experienced_date" });
    expect(result.status).toBe("partial");
    expect(result.coverage.limits).toEqual(["experience_time_not_recorded"]);
    expect(result.coverage.timeBasis).toBe("experienced_date");
    expect(select(rows, 1_000).coverage.limits).toEqual([]);
  });

  it("lists only the dates that hold messages for a wide range", () => {
    const result = select(
      [row("01:00", "user", "hello")],
      1_000,
      {},
      { startDate: "2026-08-01" },
      { dateCount: 20, localDates: [], startDate: "2026-08-01", readStartDate: "2026-08-01" },
    );
    expect(result.coverage.perDate.map((entry) => entry.localDate)).toEqual(["2026-08-20"]);
  });
});
