import { describe, expect, it } from "vitest";
import {
  asConversationEventRevisionId,
  asDailySessionId,
} from "@sayhear/domain";

import {
  HISTORY_RECALL_DEFAULT_POLICY,
  normalizeHistoryReviewCall,
  renderHistoryRecallReceipt,
  type HistoryRecallSourceItem,
} from "./history-recall";
import {
  buildExperienceGroups,
  expandPersonGroupsWithVerifiedAliases,
  rankExperienceHits,
  resolveExperienceSearchPlan,
  searchPatternsOf,
  selectExperienceSearch,
  type ExperienceHit,
} from "./history-experience-search";

const policy = HISTORY_RECALL_DEFAULT_POLICY;
const cutoff = new Date("2026-09-15T02:10:00.000Z");

describe("experience search proposal", () => {
  it("accepts keywords with optional people and an optional bounded date range", () => {
    expect(
      normalizeHistoryReviewCall({
        rawArguments: JSON.stringify({
          people: ["表姐"],
          search_terms: ["钢琴", " Piano ", "钢琴"],
        }),
      }),
    ).toEqual({
      proposal: {
        endDate: null,
        kind: "search_experience",
        people: ["表姐"],
        sourceScope: "conversation_text",
        startDate: null,
        terms: ["钢琴", "Piano"],
        timeBasis: "expressed_date",
      },
    });
    expect(
      normalizeHistoryReviewCall({
        rawArguments: '{"search_terms":["gym"],"start_date":"2026-06-01","end_date":"2026-06-30"}',
      }),
    ).toMatchObject({
      proposal: { endDate: "2026-06-30", kind: "search_experience", startDate: "2026-06-01" },
    });
  });

  it("rejects empty, oversized, control-character and unknown-key proposals", () => {
    for (const rawArguments of [
      '{"search_terms":[]}',
      '{"search_terms":["a"]}',
      '{"search_terms":["ok","ok","ok","ok","ok","ok","ok"]}',
      `{"search_terms":["${"x".repeat(40)}"]}`,
      '{"search_terms":["a\\u0000b"]}',
      '{"search_terms":["钢琴"],"sql":"select 1"}',
      '{"search_terms":["钢琴"],"people":["a","b","c","d"]}',
      '{"search_terms":["钢琴"],"end_date":"2026-06-01"}',
      '{"people":["x"]}',
    ]) {
      expect(normalizeHistoryReviewCall({ rawArguments })).toEqual({ invalid: true });
    }
  });
});

describe("experience search plan", () => {
  const proposal = (over: Record<string, unknown> = {}) => {
    const parsed = normalizeHistoryReviewCall({
      rawArguments: JSON.stringify({ search_terms: ["钢琴", "弹琴"], ...over }),
    });
    if (!("proposal" in parsed) || parsed.proposal.kind !== "search_experience") {
      throw new Error("fixture proposal must normalize");
    }
    return parsed.proposal;
  };
  const resolve = (p = proposal(), timezone: string | null = "Asia/Shanghai") =>
    resolveExperienceSearchPlan({ cutoff, policy, proposal: p, timezone });

  it("normalizes width and case and adds traditional/simplified variants", () => {
    const result = resolve(proposal({ search_terms: ["ＰＩＡＮＯ", "鳳梨"] }));
    if (!result.ok) throw new Error("plan");
    expect(result.plan.groups.map((g) => g.variants)).toEqual([
      ["piano"],
      ["鳳梨", "凤梨"],
    ]);
  });

  it("fails closed without a timezone, for future or oversized ranges", () => {
    expect(resolve(proposal(), null)).toEqual({ code: "timezone_unavailable", ok: false });
    expect(resolve(proposal({ end_date: "2026-09-20", start_date: "2026-09-16" }))).toEqual({
      code: "date_in_future",
      ok: false,
    });
    expect(resolve(proposal({ end_date: "2026-09-10", start_date: "2024-01-01" }))).toEqual({
      code: "date_range_too_wide",
      ok: false,
    });
  });

  it("builds substring patterns for CJK and word-boundary patterns for ASCII", () => {
    const result = resolve(proposal({ search_terms: ["钢琴", "piano"] }));
    if (!result.ok) throw new Error("plan");
    expect(searchPatternsOf(result.plan)).toEqual([
      { group: 0, kind: "substring", value: "钢琴" },
      { group: 1, kind: "word", value: "(^|[^a-z0-9])piano($|[^a-z0-9])" },
    ]);
  });

  it("expands a person cue only through a unique verified alias, never by label alone", () => {
    const result = resolve(proposal({ people: ["小李"] }));
    if (!result.ok) throw new Error("plan");
    const unique = expandPersonGroupsWithVerifiedAliases(result.plan, [
      { entityId: "e1", label: "李明", labelKind: "primary" },
      { entityId: "e1", label: "小李", labelKind: "alias" },
    ]);
    expect(unique.plan.groups.find((g) => g.role === "person")!.variants).toEqual(
      expect.arrayContaining(["小李", "李明"]),
    );
    const ambiguous = expandPersonGroupsWithVerifiedAliases(result.plan, [
      { entityId: "e1", label: "小李", labelKind: "alias" },
      { entityId: "e2", label: "小李", labelKind: "alias" },
      { entityId: "e2", label: "李华", labelKind: "primary" },
    ]);
    expect(ambiguous.ambiguousCues).toBe(1);
    expect(ambiguous.plan.groups.find((g) => g.role === "person")!.variants).toEqual(["小李"]);
  });
});

let counter = 0;
const SESSION_A = asDailySessionId("00000000-0000-7000-8000-00000000000a");
const SESSION_B = asDailySessionId("00000000-0000-7000-8000-00000000000b");
const event = (
  at: string,
  actor: "user" | "assistant",
  text: string,
  over: Partial<HistoryRecallSourceItem> & { matchedGroups?: number[] } = {},
): ExperienceHit => {
  counter += 1;
  return {
    actor,
    dailySessionId: SESSION_A,
    exclusion: null,
    expressedAt: at,
    expressionTimezone: "Asia/Shanghai",
    expressionTimezoneSource: "request",
    generatingUserRevisionId: null,
    localDate: at.slice(0, 10),
    matchedGroups: [],
    revisionId: asConversationEventRevisionId(
      `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    ),
    sequence: counter,
    text,
    ...over,
  };
};

describe("experience groups and selection", () => {
  const planResult = resolveExperienceSearchPlan({
    cutoff,
    policy,
    proposal: {
      endDate: null,
      kind: "search_experience",
      people: [],
      sourceScope: "conversation_text",
      startDate: null,
      terms: ["钢琴"],
      timeBasis: "expressed_date",
    },
    timezone: "Asia/Shanghai",
  });
  if (!planResult.ok) throw new Error("plan");
  const plan = planResult.plan;
  const hitsSnapshot = (hits: ExperienceHit[], over = {}) => ({
    failure: null,
    hits,
    oldestScannedAt: "2026-06-01T00:00:00.000Z",
    readLatencyMs: 4,
    scanComplete: true,
    scannedRows: 50,
    ...over,
  });

  it("keeps two similar experiences as separate groups, newest-first by rank ties", () => {
    const first = event("2026-06-13T08:40:00.000Z", "user", "弹了钢琴", { matchedGroups: [0] });
    const second = event("2026-07-20T08:40:00.000Z", "user", "又弹了钢琴", {
      dailySessionId: SESSION_B,
      matchedGroups: [0],
    });
    const ranked = rankExperienceHits(plan, hitsSnapshot([first, second]));
    const groups = buildExperienceGroups(ranked.eligible, policy);
    expect(groups.groups).toHaveLength(2);
    expect(groups.groups[0]!.hits[0]!.revisionId).toBe(second.revisionId);
    expect(groups.omittedHits).toBe(0);
  });

  it("merges hits of the same session within the context window into one group", () => {
    const a = event("2026-06-13T08:40:00.000Z", "user", "钢琴一", { matchedGroups: [0] });
    const b = event("2026-06-13T08:50:00.000Z", "user", "钢琴二", { matchedGroups: [0] });
    const groups = buildExperienceGroups(rankExperienceHits(plan, hitsSnapshot([a, b])).eligible, policy);
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0]!.hits).toHaveLength(2);
  });

  it("drops control-excluded hits and counts them; they never become candidates", () => {
    const hit = event("2026-06-13T08:40:00.000Z", "user", "", {
      exclusion: { controlId: "c", reason: "forget_association" },
      matchedGroups: [0],
    });
    const ranked = rankExperienceHits(plan, hitsSnapshot([hit]));
    expect(ranked.eligible).toEqual([]);
    expect(ranked.omitted).toEqual({ forget_association: 1 });
  });

  it("selects the hit turn and the adjacent turn with their assistant replies, and records coverage", () => {
    const hit = event("2026-06-13T08:40:00.000Z", "user", "弹了钢琴", { matchedGroups: [0] });
    const reply = event("2026-06-13T08:40:05.000Z", "assistant", "嗯", {
      generatingUserRevisionId: hit.revisionId,
    });
    const next = event("2026-06-13T08:46:00.000Z", "user", "手指酸");
    const nextReply = event("2026-06-13T08:46:05.000Z", "assistant", "值得", {
      generatingUserRevisionId: next.revisionId,
    });
    const far = event("2026-06-13T12:00:00.000Z", "user", "晚饭");
    const snap = hitsSnapshot([hit]);
    const groups = buildExperienceGroups(rankExperienceHits(plan, snap).eligible, policy);
    const result = selectExperienceSearch({
      context: [hit, reply, next, nextReply, far],
      groups: groups.groups,
      hits: snap,
      omittedHits: groups.omittedHits,
      omittedByControl: {},
      plan,
      policy,
      proposal: planProposal(),
    });
    expect(result.itemRefs.map((r) => [r.role, r.actor, r.group])).toEqual([
      ["match", "user", 1],
      ["context", "assistant", 1],
      ["context", "user", 1],
      ["context", "assistant", 1],
    ]);
    expect(result.status).toBe("completed");
    expect(result.coverage.search).toMatchObject({
      matchedRows: 1,
      outcome: "candidates",
      scanComplete: true,
      selectedGroups: 1,
    });
  });

  it("reports no match as its own outcome and never as 'never discussed'", () => {
    const snap = hitsSnapshot([]);
    const result = selectExperienceSearch({
      context: [],
      groups: [],
      hits: snap,
      omittedHits: 0,
      omittedByControl: {},
      plan,
      policy,
      proposal: planProposal(),
    });
    expect(result.status).toBe("completed");
    expect(result.coverage.search?.outcome).toBe("no_match");
    const text = renderHistoryRecallReceipt({
      droppedAtCompile: 0,
      injectedRows: 0,
      policyVersion: policy.version,
      result,
      version: 1,
    });
    expect(text).toMatch(/does not prove/i);
    expect(text).toMatch(/earliest|first time/i);
  });

  it("marks truncated scans as insufficient coverage and keeps the status partial", () => {
    const result = selectExperienceSearch({
      context: [],
      groups: [],
      hits: hitsSnapshot([], { scanComplete: false }),
      omittedHits: 0,
      omittedByControl: {},
      plan,
      policy,
      proposal: planProposal(),
    });
    expect(result.status).toBe("partial");
    expect(result.coverage.search?.outcome).toBe("insufficient_coverage");
  });

  function planProposal() {
    return {
      endDate: null,
      kind: "search_experience" as const,
      people: [],
      sourceScope: "conversation_text" as const,
      startDate: null,
      terms: ["钢琴"],
      timeBasis: "expressed_date" as const,
    };
  }
});

describe("latest statement of a changing matter (issue #318)", () => {
  const planResult = resolveExperienceSearchPlan({
    cutoff,
    policy,
    proposal: {
      endDate: null,
      kind: "search_experience",
      people: [],
      sourceScope: "conversation_text",
      startDate: null,
      terms: ["入职", "offer"],
      timeBasis: "expressed_date",
    },
    timezone: "Asia/Shanghai",
  });
  if (!planResult.ok) throw new Error("plan");
  const plan = planResult.plan;
  const session = (n: number) =>
    asDailySessionId(`00000000-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`);

  it("keeps the person's newest statement even when older ones match more clues and fill every slot", () => {
    const older = [1, 2, 3, 4].map((n) =>
      event(`2026-0${n + 1}-10T08:40:00.000Z`, "user", `offer 入职 ${n}`, {
        dailySessionId: session(n),
        matchedGroups: [0, 1],
      }),
    );
    const newest = event("2026-08-10T08:40:00.000Z", "user", "入职日期改了", {
      dailySessionId: session(9),
      matchedGroups: [0],
    });
    const ranked = rankExperienceHits(plan, { hits: [...older, newest] });
    const built = buildExperienceGroups(ranked.eligible, policy);
    expect(built.groups).toHaveLength(policy.search.maxGroups);
    expect(
      built.groups.some((group) =>
        group.hits.some((hit) => hit.revisionId === newest.revisionId),
      ),
    ).toBe(true);
    expect(built.omittedHits).toBe(2);
  });
});
