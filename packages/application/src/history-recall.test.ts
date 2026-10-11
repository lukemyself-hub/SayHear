import { describe, expect, it } from "vitest";
import {
  asConversationEventRevisionId,
  asDailySessionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asUserId,
} from "@sayhear/domain";

import {
  HISTORY_RECALL_DEFAULT_POLICY,
  createHistoryRecallGateway,
  normalizeHistoryReviewCall,
  resolveHistoryQueryPlan,
  selectHistoryRecall,
  type HistoryQueryProposal,
  type HistoryRecallRepository,
  type HistoryRecallSourceItem,
  type HistoryRecallSourceSnapshot,
} from "./history-recall";

const proposal = (startDate: string, endDate = startDate): HistoryQueryProposal => ({
  endDate,
  kind: "review_dates",
  sourceScope: "conversation_text",
  startDate,
  timeBasis: "expressed_date",
});

describe("history review proposal", () => {
  it("accepts a bounded date proposal and defaults the end date", () => {
    expect(
      normalizeHistoryReviewCall({ rawArguments: '{"start_date":"2026-08-20"}' }),
    ).toEqual({ proposal: proposal("2026-08-20") });
  });

  it("rejects any key outside the proposal vocabulary and malformed dates", () => {
    for (const rawArguments of [
      '{"start_date":"2026-08-20","user_id":"x"}',
      '{"start_date":"2026-08-20","sql":"select 1"}',
      '{"start_date":"2026-08-20","cursor":"abc"}',
      '{"start_date":"2026-02-30"}',
      '{"start_date":"yesterday"}',
      '{"start_date":"2026-08-20","time_basis":"occurred"}',
      "not json",
      "[]",
    ]) {
      expect(normalizeHistoryReviewCall({ rawArguments })).toEqual({ invalid: true });
    }
  });
});

describe("history review time basis", () => {
  it("keeps the expressed date and the experienced date as different questions", () => {
    expect(
      normalizeHistoryReviewCall({
        rawArguments: '{"start_date":"2026-09-16","time_basis":"experienced_date"}',
      }),
    ).toEqual({ proposal: { ...proposal("2026-09-16"), timeBasis: "experienced_date" } });
    expect(
      normalizeHistoryReviewCall({ rawArguments: '{"start_date":"2026-09-16"}' }),
    ).toEqual({ proposal: proposal("2026-09-16") });
  });
});

describe("history query plan", () => {
  const cutoff = new Date("2026-09-15T02:10:00.000Z");
  const resolve = (p: HistoryQueryProposal, timezone: string | null = "Asia/Shanghai") =>
    resolveHistoryQueryPlan({ cutoff, policy: HISTORY_RECALL_DEFAULT_POLICY, proposal: p, timezone });

  it("resolves the local dates in the request timezone", () => {
    expect(resolve(proposal("2026-08-20", "2026-08-21"))).toMatchObject({
      ok: true,
      plan: { localDates: ["2026-08-20", "2026-08-21"], timezone: "Asia/Shanghai" },
    });
  });

  it("accepts a wide range of dates but only itemizes a short one", () => {
    expect(resolve(proposal("2026-08-25", "2026-09-14"))).toMatchObject({
      ok: true,
      plan: { dateCount: 21, localDates: [] },
    });
    expect(resolve(proposal("2026-09-10", "2026-09-12"))).toMatchObject({
      ok: true,
      plan: { dateCount: 3, localDates: ["2026-09-10", "2026-09-11", "2026-09-12"] },
    });
  });

  it("reads an experienced date through the days it may be retold, up to the request day", () => {
    const experienced = { ...proposal("2026-09-10"), timeBasis: "experienced_date" as const };
    expect(resolve(experienced)).toMatchObject({
      ok: true,
      plan: { readEndDate: "2026-09-15", readStartDate: "2026-09-10", timeBasis: "experienced_date" },
    });
    const old = { ...proposal("2026-08-01"), timeBasis: "experienced_date" as const };
    expect(resolve(old)).toMatchObject({
      ok: true,
      plan: { readEndDate: "2026-08-15", readStartDate: "2026-08-01" },
    });
    expect(resolve(proposal("2026-09-10"))).toMatchObject({
      plan: { readEndDate: "2026-09-10", readStartDate: "2026-09-10" },
    });
  });

  it("fails closed without a timezone, with reversed, too wide or future ranges", () => {
    expect(resolve(proposal("2026-08-20"), null)).toEqual({ code: "timezone_unavailable", ok: false });
    expect(resolve(proposal("2026-08-21", "2026-08-20"))).toEqual({ code: "date_range_reversed", ok: false });
    expect(resolve(proposal("2026-01-01", "2026-09-10"))).toEqual({ code: "date_range_too_wide", ok: false });
    expect(resolve(proposal("2026-09-16"))).toEqual({ code: "date_in_future", ok: false });
    // 02:10Z is already the 15th in Shanghai but still the 14th in Honolulu.
    expect(resolve(proposal("2026-09-15"), "Pacific/Honolulu")).toEqual({ code: "date_in_future", ok: false });
  });
});

let counter = 0;
const item = (
  localDate: string,
  actor: "user" | "assistant",
  text: string,
  extra: Partial<HistoryRecallSourceItem> = {},
): HistoryRecallSourceItem => {
  counter += 1;
  return {
    actor,
    dailySessionId: asDailySessionId("00000000-0000-7000-8000-000000000001"),
    exclusion: null,
    expressedAt: `${localDate}T10:00:${String(counter).padStart(2, "0")}.000Z`,
    expressionTimezone: "Asia/Shanghai",
    expressionTimezoneSource: "request",
    generatingUserRevisionId: null,
    localDate,
    revisionId: asConversationEventRevisionId(
      `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    ),
    sequence: counter,
    text,
    ...extra,
  };
};

const planFor = (dates: string[]) => ({
  cutoff: "2026-09-15T02:10:00.000Z",
  dateCount: dates.length,
  endDate: dates.at(-1)!,
  localDates: dates,
  readEndDate: dates.at(-1)!,
  readStartDate: dates[0]!,
  startDate: dates[0]!,
  timeBasis: "expressed_date" as const,
  timezone: "Asia/Shanghai",
});

const snapshot = (
  items: HistoryRecallSourceItem[],
  over: Partial<HistoryRecallSourceSnapshot> = {},
): HistoryRecallSourceSnapshot => ({
  currentConversationRows: 0,
  enumerationComplete: true,
  failure: null,
  items,
  pages: 1,
  readLatencyMs: 3,
  ...over,
});

describe("history recall selection and coverage", () => {
  const select = (
    snap: HistoryRecallSourceSnapshot,
    dates = ["2026-08-20"],
    policy = HISTORY_RECALL_DEFAULT_POLICY,
  ) =>
    selectHistoryRecall({
      plan: planFor(dates),
      policy,
      proposal: proposal(dates[0]!, dates.at(-1)!),
      snapshot: snap,
    });

  it("completes when everything fits and reports an empty range as empty, not as no record", () => {
    const full = select(snapshot([item("2026-08-20", "user", "hello there")]));
    expect(full.status).toBe("completed");
    expect(full.coverage.perDate).toEqual([
      { enumeratedRows: 1, localDate: "2026-08-20", selectedRows: 1, state: "complete" },
    ]);
    const empty = select(snapshot([]));
    expect(empty.status).toBe("completed");
    expect(empty.coverage.perDate[0]?.state).toBe("empty");
    expect(empty.itemRefs).toEqual([]);
  });

  it("is partial when enumeration is incomplete, and unread dates are not called empty", () => {
    const result = select(
      snapshot([item("2026-08-20", "user", "a")], { enumerationComplete: false }),
      ["2026-08-20", "2026-08-21"],
    );
    expect(result.status).toBe("partial");
    expect(result.coverage.perDate.map((d) => d.state)).toEqual(["partial", "unread"]);
  });

  it("separates enumerated from injected coverage under the token budget", () => {
    const policy = { ...HISTORY_RECALL_DEFAULT_POLICY, maxContextTokens: 5 };
    const result = select(
      snapshot([
        item("2026-08-20", "user", "x".repeat(16)),
        item("2026-08-20", "user", "y".repeat(16)),
      ]),
      ["2026-08-20"],
      policy,
    );
    expect(result.status).toBe("partial");
    expect(result.coverage).toMatchObject({
      enumeratedRows: 2,
      omitted: { budget_exhausted: 1 },
      selectedRows: 1,
    });
  });

  it("drops control-excluded rows and the assistant reply generated for them", () => {
    const user = item("2026-08-20", "user", "", {
      exclusion: { controlId: "c1", reason: "forget_association" },
    });
    const reply = item("2026-08-20", "assistant", "echo of the forgotten thing", {
      generatingUserRevisionId: user.revisionId,
    });
    const keep = item("2026-08-20", "user", "independent");
    const result = select(snapshot([user, reply, keep]));
    expect(result.itemRefs.map((ref) => ref.revisionId)).toEqual([keep.revisionId]);
    expect(result.coverage.omitted).toEqual({ forget_association: 1 });
    expect(result.status).toBe("completed");
  });

  it("turns a source failure into a failed result with a content-free code", () => {
    const result = select(snapshot([], { failure: { code: "source_read_timeout" } }));
    expect(result).toMatchObject({
      failureCode: "source_read_timeout",
      itemRefs: [],
      status: "failed",
    });
  });
});

describe("history recall gateway", () => {
  const userId = asUserId("00000000-0000-7000-8000-0000000000aa");
  const decisionCommandId = asGenerationCommandId("00000000-0000-7000-8000-0000000000d1");
  const requestRevision = asConversationEventRevisionId("00000000-0000-7000-8000-0000000000e1");
  const facts = {
    cutoff: new Date("2026-09-15T02:10:00.000Z"),
    dailySessionId: asDailySessionId("00000000-0000-7000-8000-0000000000f1"),
    expectedDataEpoch: 1,
    inputRevisionId: requestRevision,
    interactionTurnId: asInteractionTurnId("00000000-0000-7000-8000-0000000000b1"),
    requestTimezone: "Asia/Shanghai" as string | null,
    sessionTimezone: null,
  };
  const answer = {
    generationCommandId: asGenerationCommandId("00000000-0000-7000-8000-0000000000d2"),
    modelRunAttemptId: asModelRunAttemptId("00000000-0000-7000-8000-0000000000a2"),
  };

  function build(
    overrides: {
      facts?: typeof facts | null;
      read?: () => Promise<HistoryRecallSourceSnapshot>;
    } = {},
  ) {
    const commits: unknown[] = [];
    const reads: unknown[] = [];
    const repository: HistoryRecallRepository = {
      commitHistoryRecall: async (input) => {
        commits.push(input);
        return { answer, outcome: "committed" };
      },
      listPendingHistoryAnswers: async () => [],
      loadDecisionFacts: async () =>
        overrides.facts === undefined ? facts : overrides.facts,
    };
    const gateway = createHistoryRecallGateway({
      clock: () => new Date("2026-09-15T02:10:05.000Z"),
      repository,
      source: {
        readHistoryRange: async (request) => {
          reads.push(request);
          return overrides.read
            ? overrides.read()
            : snapshot([item("2026-08-20", "user", "hello")]);
        },
      },
    });
    const admit = () =>
      gateway.admit({
        context: {
          decisionCommandId,
          modelRunAttemptId: asModelRunAttemptId("00000000-0000-7000-8000-0000000000a1"),
          requestEventRevisionId: requestRevision,
          userId,
        },
        proposal: proposal("2026-08-20"),
      });
    return { admit, commits, reads };
  }

  it("reads with the frozen owner and epoch, then freezes the result with the answer command", async () => {
    const { admit, commits, reads } = build();
    expect(await admit()).toMatchObject({ answer, status: "completed" });
    expect(reads).toEqual([expect.objectContaining({ expectedDataEpoch: 1, userId })]);
    expect(commits).toHaveLength(1);
  });

  it("fails closed for a command that is not this owner's, and never reads", async () => {
    const { admit, commits, reads } = build({ facts: null });
    expect(await admit()).toEqual({ outcome: "fence_rejected" });
    expect(reads).toHaveLength(0);
    expect(commits).toHaveLength(0);
  });

  it("freezes a failed result when the source throws, still creating the honest answer stage", async () => {
    const { admit, commits } = build({
      read: async () => {
        throw new Error("boom");
      },
    });
    expect(await admit()).toMatchObject({ failureCode: "source_read_threw", status: "failed" });
    expect(commits).toHaveLength(1);
  });

  it("freezes a failed plan without reading when the range cannot be planned", async () => {
    const { admit, commits, reads } = build({ facts: { ...facts, requestTimezone: null } });
    expect(await admit()).toMatchObject({ failureCode: "timezone_unavailable", status: "failed" });
    expect(reads).toHaveLength(0);
    expect(commits).toHaveLength(1);
  });
});
