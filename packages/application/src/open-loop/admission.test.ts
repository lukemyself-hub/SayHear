import { describe, expect, it } from "vitest";

import { asEvidenceItemId, asOpenLoopId } from "@sayhear/domain";

import {
  arbitrateClosureVsExpiry,
  canReformTerminalLoop,
  isOpenLoopEligibleForFollowup,
  isOpenLoopLaneReadable,
  isOpenLoopSummaryReadable,
  openLoopDedupeFingerprint,
  planOpenLoopClosure,
  planOpenLoopFormation,
  selectFormationCandidates,
} from "./admission";
import {
  OPEN_LOOP_NEAR_TERM_LEXICAL_ALLOWLIST_V1,
  computeOpenLoopSchedule,
  isNearTermLexicalHit,
  validateExpectedWindow,
} from "./policy";
import { isKindStatusPairValid } from "./types";

const EVIDENCE_ITEM = asEvidenceItemId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");
const LOOP_A = asOpenLoopId("01984477-1f9a-7b25-a5cc-83c3b21fbc69");
const LOOP_B = asOpenLoopId("01984477-1f9a-7b25-a5cc-83c3b21fbc70");

function baseProposal(overrides: Record<string, unknown> = {}) {
  return {
    kind: "upcoming_event",
    evidenceItemId: EVIDENCE_ITEM,
    evidenceRevisionId: "rev-1",
    hasRealAnchor: true,
    isTaskLike: false,
    userTimeExpression: "2026-10-02",
    expectedWindow: {
      startAt: "2026-10-02T09:00:00.000Z",
      endAt: "2026-10-02T11:00:00.000Z",
      precision: "range" as const,
      timezone: "Asia/Shanghai",
    },
    proposalIndex: 0,
    ...overrides,
  };
}

describe("open loop kind/status pairing", () => {
  it("pairs upcoming_event only with occurred and awaited_outcome only with resolved", () => {
    expect(isKindStatusPairValid("upcoming_event", "occurred")).toBe(true);
    expect(isKindStatusPairValid("upcoming_event", "resolved")).toBe(false);
    expect(isKindStatusPairValid("awaited_outcome", "resolved")).toBe(true);
    expect(isKindStatusPairValid("awaited_outcome", "occurred")).toBe(false);
    expect(isKindStatusPairValid("upcoming_event", "canceled")).toBe(true);
    expect(isKindStatusPairValid("awaited_outcome", "expired")).toBe(true);
    expect(isKindStatusPairValid("upcoming_event", "retracted")).toBe(true);
  });
});

describe("non-task boundary", () => {
  it("rejects dated tasks even when a date is present", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({ isTaskLike: true }),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
      identityCandidates: [],
    });
    expect(plan.action).toBe("skip");
    if (plan.action === "skip") {
      expect(plan.reasonCode).toBe("task_like_rejected");
    }
  });

  it("rejects proposals without a reality anchor", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({ hasRealAnchor: false }),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
      identityCandidates: [],
    });
    expect(plan).toMatchObject({ action: "skip", reasonCode: "no_real_anchor" });
  });
});

describe("versioned near-term lexical allowlist", () => {
  it("publishes a frozen allowlist version and never fabricates dates", () => {
    expect(OPEN_LOOP_NEAR_TERM_LEXICAL_ALLOWLIST_V1.policyVersion).toBe(
      "open-loop-near-term-lexical:v1",
    );
    expect(isNearTermLexicalHit("快了")).toBe(true);
    expect(isNearTermLexicalHit("soon")).toBe(true);
    expect(isNearTermLexicalHit("明年夏天")).toBe(false);
    expect(isNearTermLexicalHit(null)).toBe(false);
  });

  it("treats allowlisted fuzzy expressions as unanchored 14-day loops", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({
        userTimeExpression: "快了",
        expectedWindow: null,
      }),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
      identityCandidates: [],
    });
    expect(plan.action).toBe("create_loop");
    if (plan.action === "create_loop") {
      expect(plan.expirySource).toBe("unanchored_plus_14d");
    }
  });
});

describe("time windows, horizon and DST", () => {
  it("rejects a date-only UTC-midnight window that starts before the Los Angeles day", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({
        kind: "awaited_outcome",
        userTimeExpression: "September 23, 2026",
        expectedWindow: {
          startAt: "2026-09-23T00:00:00.000Z",
          endAt: "2026-09-24T00:00:00.000Z",
          precision: "date",
          timezone: "America/Los_Angeles",
        },
      }),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "America/Los_Angeles",
      identityCandidates: [],
    });
    expect(plan).toMatchObject({ action: "skip", reasonCode: "no_real_anchor" });
  });

  it("waits until a Los Angeles date-only deadline passes before selecting an awaited outcome", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({
        kind: "awaited_outcome",
        userTimeExpression: "by September 23, 2026",
        expectedWindow: {
          startAt: "2026-09-23T07:00:00.000Z",
          endAt: "2026-09-24T07:00:00.000Z",
          precision: "date",
          timezone: "America/Los_Angeles",
        },
      }),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "America/Los_Angeles",
      identityCandidates: [],
    });
    expect(plan.action).toBe("create_loop");
    if (plan.action === "create_loop") {
      expect(plan.expectedStartAt).toBe("2026-09-23T07:00:00.000Z");
      expect(plan.precision).toBe("date");
      expect(plan.followupEligibleFromAt).toBe("2026-09-24T07:00:00.000Z");
    }
  });

  it("uses the direct Event deadline when the proposal drops the word by", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({
        kind: "awaited_outcome",
        userTimeExpression: "September 23, 2026",
        expectedWindow: {
          startAt: "2026-09-23T07:00:00.000Z",
          endAt: "2026-09-24T07:00:00.000Z",
          precision: "date",
          timezone: "America/Los_Angeles",
        },
      }),
      sourceUserText: "I submitted my print; they promised an answer by September 23, 2026.",
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "America/Los_Angeles",
      identityCandidates: [],
    });
    expect(plan.action).toBe("create_loop");
    if (plan.action === "create_loop") {
      expect(plan.followupEligibleFromAt).toBe("2026-09-24T07:00:00.000Z");
    }
  });

  it("honors a later deadline occurrence of the same date in direct User text", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({
        kind: "awaited_outcome",
        userTimeExpression: "September 23, 2026",
        expectedWindow: {
          startAt: "2026-09-23T07:00:00.000Z",
          endAt: "2026-09-24T07:00:00.000Z",
          precision: "date",
          timezone: "America/Los_Angeles",
        },
      }),
      sourceUserText: "I submitted on September 23, 2026; they will answer by September 23, 2026.",
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "America/Los_Angeles",
      identityCandidates: [],
    });
    expect(plan.action).toBe("create_loop");
    if (plan.action === "create_loop") {
      expect(plan.followupEligibleFromAt).toBe("2026-09-24T07:00:00.000Z");
    }
  });

  it("rejects a proposed date that is absent from an unknown-subject User Event", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({
        kind: "awaited_outcome",
        userTimeExpression: "September 23, 2026",
        expectedWindow: {
          startAt: "2026-09-23T07:00:00.000Z",
          endAt: "2026-09-24T07:00:00.000Z",
          precision: "date",
          timezone: "America/Los_Angeles",
        },
      }),
      sourceUserText: "Someone contacted someone about a kiln slot, but I do not know whose request it was or whether anyone replied.",
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "America/Los_Angeles",
      identityCandidates: [],
    });
    expect(plan).toMatchObject({ action: "skip", reasonCode: "no_real_anchor" });
  });

  it("keeps a correctly bounded Shanghai date closed until its local start", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({
        kind: "awaited_outcome",
        userTimeExpression: "2026-09-23",
        expectedWindow: {
          startAt: "2026-09-22T16:00:00.000Z",
          endAt: "2026-09-23T16:00:00.000Z",
          precision: "date",
          timezone: "Asia/Shanghai",
        },
      }),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
      identityCandidates: [],
    });
    expect(plan.action).toBe("create_loop");
    if (plan.action === "create_loop") {
      expect(plan.timezone).toBe("Asia/Shanghai");
      expect(plan.precision).toBe("date");
      expect(plan.followupEligibleFromAt).toBe("2026-09-22T16:00:00.000Z");
      expect(isOpenLoopEligibleForFollowup({
        followupEligibleFromAt: plan.followupEligibleFromAt,
        expiresAt: plan.expiresAt,
        now: new Date("2026-09-22T15:59:59.999Z"),
      })).toBe(false);
    }
  });

  it("waits past a Shanghai date-only deadline stated in Chinese", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({
        kind: "awaited_outcome",
        userTimeExpression: "2026 年 9 月 23 日前确认",
        expectedWindow: {
          startAt: "2026-09-22T16:00:00.000Z",
          endAt: "2026-09-23T16:00:00.000Z",
          precision: "date",
          timezone: "Asia/Shanghai",
        },
      }),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
      identityCandidates: [],
    });
    expect(plan.action).toBe("create_loop");
    if (plan.action === "create_loop") {
      expect(plan.followupEligibleFromAt).toBe("2026-09-23T16:00:00.000Z");
    }
  });

  it("uses the Evidence session timezone for a bounded window", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({
        kind: "awaited_outcome",
        expectedWindow: {
          startAt: "2026-09-23T00:00:00.000Z",
          endAt: "2026-09-23T03:00:00.000Z",
          precision: "range",
          timezone: "UTC",
        },
      }),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "America/Los_Angeles",
      identityCandidates: [],
    });
    expect(plan).toMatchObject({ action: "skip", reasonCode: "no_real_anchor" });
  });

  it("keeps a date-only window on the Los Angeles spring-forward day at local midnight", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({
        kind: "awaited_outcome",
        userTimeExpression: "March 8, 2026",
        expectedWindow: {
          startAt: "2026-03-08T08:00:00.000Z",
          endAt: "2026-03-09T07:00:00.000Z",
          precision: "date",
          timezone: "America/Los_Angeles",
        },
      }),
      evidenceCommittedAt: "2026-03-01T00:00:00.000Z",
      evidenceTimeZone: "America/Los_Angeles",
      identityCandidates: [],
    });
    expect(plan.action).toBe("create_loop");
    if (plan.action === "create_loop") {
      expect(plan.followupEligibleFromAt).toBe("2026-03-08T08:00:00.000Z");
      expect(plan.expectedEndAt).toBe("2026-03-09T07:00:00.000Z");
    }
  });

  it("keeps exact instants end-free and expires them from the instant", () => {
    const validated = validateExpectedWindow({
      window: {
        startAt: "2026-10-02T09:00:00.000Z",
        endAt: null,
        precision: "instant",
        timezone: "Asia/Shanghai",
      },
      kind: "upcoming_event",
    });
    expect(validated).toMatchObject({ anchored: true, endAt: null });
    if ("error" in validated) {
      throw new Error("expected an anchored instant window");
    }
    const schedule = computeOpenLoopSchedule({
      kind: "upcoming_event",
      anchored: validated,
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
    });
    expect(schedule).toMatchObject({ expirySource: "anchored_upcoming_plus_7d" });
  });

  it("rejects anchored windows wider than 31 local calendar days", () => {
    const validated = validateExpectedWindow({
      window: {
        startAt: "2026-01-01T00:00:00.000Z",
        endAt: "2026-03-15T00:00:00.000Z",
        precision: "range",
        timezone: "Asia/Shanghai",
      },
      kind: "upcoming_event",
    });
    expect(validated).toMatchObject({ error: "time_window_too_wide" });
  });

  it("rejects expiry beyond Evidence + 360 local days", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({
        expectedWindow: {
          startAt: "2027-10-01T09:00:00.000Z",
          endAt: "2027-10-02T09:00:00.000Z",
          precision: "range",
          timezone: "Asia/Shanghai",
        },
      }),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
      identityCandidates: [],
    });
    expect(plan).toMatchObject({ action: "skip", reasonCode: "horizon_exceeded" });
  });

  it("applies 7-day anchored grace to upcoming events and 14-day to awaited outcomes", () => {
    const upcoming = computeOpenLoopSchedule({
      kind: "upcoming_event",
      anchored: {
        anchored: true,
        startAt: "2026-10-02T01:00:00.000Z",
        endAt: "2026-10-02T03:00:00.000Z",
        precision: "range",
        timezone: "Asia/Shanghai",
      },
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
    });
    const awaited = computeOpenLoopSchedule({
      kind: "awaited_outcome",
      anchored: {
        anchored: true,
        startAt: "2026-10-02T01:00:00.000Z",
        endAt: "2026-10-02T03:00:00.000Z",
        precision: "range",
        timezone: "Asia/Shanghai",
      },
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
    });
    expect(upcoming).toMatchObject({ expirySource: "anchored_upcoming_plus_7d" });
    expect(awaited).toMatchObject({ expirySource: "anchored_awaited_plus_14d" });
    if (!("error" in upcoming) && !("error" in awaited)) {
      expect(new Date(upcoming.expiresAt).getTime()).toBeLessThan(
        new Date(awaited.expiresAt).getTime(),
      );
    }
  });

  it("separates formation from follow-up eligibility (future loops exist but are not selectable)", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal(),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
      identityCandidates: [],
    });
    expect(plan.action).toBe("create_loop");
    if (plan.action === "create_loop") {
      // Expected window starts 2026-10-02; eligibility opens 14 days before.
      expect(plan.followupEligibleFromAt).toBe("2026-09-18T09:00:00.000Z");
      expect(
        isOpenLoopEligibleForFollowup({
          followupEligibleFromAt: plan.followupEligibleFromAt,
          expiresAt: plan.expiresAt,
          now: new Date("2026-09-10T00:00:00.000Z"),
        }),
      ).toBe(false);
      expect(
        isOpenLoopEligibleForFollowup({
          followupEligibleFromAt: plan.followupEligibleFromAt,
          expiresAt: plan.expiresAt,
          now: new Date("2026-09-20T00:00:00.000Z"),
        }),
      ).toBe(true);
    }
  });

  it("adds calendar days across a DST transition without a fixed 24h substitution", () => {
    // America/New_York springs forward on 2026-03-08: +7 calendar days keeps
    // the wall time, which is one absolute hour less than 7x24h.
    const schedule = computeOpenLoopSchedule({
      kind: "upcoming_event",
      anchored: {
        anchored: true,
        startAt: "2026-03-02T15:00:00.000Z",
        endAt: "2026-03-03T15:00:00.000Z",
        precision: "range",
        timezone: "America/New_York",
      },
      evidenceCommittedAt: "2026-02-20T00:00:00.000Z",
      evidenceTimeZone: "America/New_York",
    });
    expect(schedule).not.toMatchObject({ error: expect.anything() });
    if (!("error" in schedule)) {
      const end = new Date("2026-03-03T15:00:00.000Z").getTime();
      const expiry = new Date(schedule.expiresAt).getTime();
      // 7x24h would be exactly 604800000ms; calendar arithmetic across the
      // spring-forward Sunday is one hour shorter.
      expect(expiry - end).toBe(604800000 - 3600000);
    }
  });
});

describe("identity: proof versus technical idempotency", () => {
  it("reuses a loop on a unique explicit binding", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({ explicitLoopBinding: LOOP_A }),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
      identityCandidates: [
        {
          openLoopId: LOOP_A,
          kind: "upcoming_event",
          canonicalClaimKey: null,
          expectedStartAt: "2026-10-02T09:00:00.000Z",
          expectedEndAt: "2026-10-02T11:00:00.000Z",
        },
      ],
    });
    expect(plan).toMatchObject({ action: "reuse_loop", openLoopId: LOOP_A });
  });

  it("skips on ambiguous identity instead of merging or duplicating", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({
        canonicalClaimKey: "claim-1",
      }),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
      identityCandidates: [
        {
          openLoopId: LOOP_A,
          kind: "upcoming_event",
          canonicalClaimKey: "claim-1",
          expectedStartAt: "2026-10-02T09:00:00.000Z",
          expectedEndAt: "2026-10-02T11:00:00.000Z",
        },
        {
          openLoopId: LOOP_B,
          kind: "upcoming_event",
          canonicalClaimKey: "claim-1",
          expectedStartAt: "2026-10-02T09:30:00.000Z",
          expectedEndAt: "2026-10-02T11:30:00.000Z",
        },
      ],
    });
    expect(plan).toMatchObject({
      action: "skip",
      reasonCode: "ambiguous_loop_identity",
    });
  });

  it("skips identity-proof-free proposals when a similar candidate exists", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal(),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
      identityCandidates: [
        {
          openLoopId: LOOP_A,
          kind: "upcoming_event",
          canonicalClaimKey: null,
          expectedStartAt: "2026-10-02T09:00:00.000Z",
          expectedEndAt: "2026-10-02T11:00:00.000Z",
        },
      ],
    });
    expect(plan).toMatchObject({
      action: "skip",
      reasonCode: "ambiguous_loop_identity",
    });
  });

  it("creates a new loop for a claim key unknown to every candidate", () => {
    const plan = planOpenLoopFormation({
      proposal: baseProposal({ canonicalClaimKey: "fresh-claim" }),
      evidenceCommittedAt: "2026-09-20T00:00:00.000Z",
      evidenceTimeZone: "Asia/Shanghai",
      identityCandidates: [
        {
          openLoopId: LOOP_A,
          kind: "upcoming_event",
          canonicalClaimKey: "other-claim",
          expectedStartAt: "2026-10-02T09:00:00.000Z",
          expectedEndAt: "2026-10-02T11:00:00.000Z",
        },
      ],
    });
    expect(plan.action).toBe("create_loop");
  });
});

describe("closure, ambiguous suppression and arbitration", () => {
  const snapshot = [
    { openLoopId: LOOP_A, kind: "upcoming_event" as const, status: "open" as const },
    { openLoopId: LOOP_B, kind: "upcoming_event" as const, status: "open" as const },
  ];

  it("closes one target on entailed evidence with a valid kind/status pair", () => {
    const plan = planOpenLoopClosure({
      proposals: [
        {
          targetOpenLoopId: LOOP_A,
          proposedStatus: "occurred",
          closureEvidenceRevisionId: "rev-9",
          closureCommittedAt: "2026-10-03T00:00:00.000Z",
          entailsTerminal: true,
          explicitCancel: false,
          targetKind: "upcoming_event",
        },
      ],
      openLoopSnapshot: snapshot,
    });
    expect(plan).toMatchObject({ action: "close", targetOpenLoopId: LOOP_A });
  });

  it("suppresses all reasonable targets atomically on ambiguous closure", () => {    const plan = planOpenLoopClosure({
      proposals: [
        {
          targetOpenLoopId: LOOP_A,
          proposedStatus: "occurred",
          closureEvidenceRevisionId: "rev-9",
          closureCommittedAt: "2026-10-03T00:00:00.000Z",
          entailsTerminal: true,
          explicitCancel: false,
          targetKind: "upcoming_event",
        },
        {
          targetOpenLoopId: LOOP_B,
          proposedStatus: "occurred",
          closureEvidenceRevisionId: "rev-9",
          closureCommittedAt: "2026-10-03T00:00:00.000Z",
          entailsTerminal: true,
          explicitCancel: false,
          targetKind: "upcoming_event",
        },
      ],
      openLoopSnapshot: snapshot,
    });
    expect(plan).toMatchObject({
      action: "ambiguous_suppress",
      disposition: "ambiguous_closure",
    });
    if (plan.action === "ambiguous_suppress") {
      expect(plan.targetOpenLoopIds).toEqual([LOOP_A, LOOP_B].sort());
    }
  });

  it("refuses implicit cancel language without explicit cancel wording", () => {
    const plan = planOpenLoopClosure({
      proposals: [
        {
          targetOpenLoopId: LOOP_A,
          proposedStatus: "canceled",
          closureEvidenceRevisionId: "rev-9",
          closureCommittedAt: "2026-10-03T00:00:00.000Z",
          entailsTerminal: true,
          explicitCancel: false,
          targetKind: "upcoming_event",
        },
      ],
      openLoopSnapshot: snapshot,
    });
    expect(plan).toMatchObject({
      action: "no_close",
      reasonCode: "cancel_not_explicit",
    });
  });

  it("ignores caller-asserted kinds that mismatch the snapshot kind", () => {
    const plan = planOpenLoopClosure({
      proposals: [
        {
          targetOpenLoopId: LOOP_A,
          proposedStatus: "resolved",
          closureEvidenceRevisionId: "rev-9",
          closureCommittedAt: "2026-10-03T00:00:00.000Z",
          entailsTerminal: true,
          explicitCancel: false,
          targetKind: "awaited_outcome",
        },
      ],
      openLoopSnapshot: snapshot,
    });
    expect(plan).toMatchObject({
      action: "no_close",
      reasonCode: "no_reasonable_target",
    });
  });

  it("adjudicates expiry races by committed_at, with boundary-equal keeping expired", () => {
    expect(
      arbitrateClosureVsExpiry({
        closureCommittedAt: "2026-10-01T00:00:00.000Z",
        expiresAt: "2026-10-02T00:00:00.000Z",
      }),
    ).toBe("closure_wins");
    expect(
      arbitrateClosureVsExpiry({
        closureCommittedAt: "2026-10-02T00:00:00.000Z",
        expiresAt: "2026-10-02T00:00:00.000Z",
      }),
    ).toBe("expiry_wins");
    expect(
      arbitrateClosureVsExpiry({
        closureCommittedAt: "2026-10-03T00:00:00.000Z",
        expiresAt: "2026-10-02T00:00:00.000Z",
      }),
    ).toBe("expiry_wins");
  });
});

describe("capacity, watermark, retention and revival", () => {
  it("caps new loops at 4 per event with a stable sort and no eviction", () => {
    const candidates = [0, 1, 2, 3, 4, 5].map((index) => ({
      proposalIndex: index,
      followupEligibleFromAt: "2026-09-20T00:00:00.000Z",
      expiresAt: `2026-10-0${index + 1}T00:00:00.000Z`,
      evidenceLocator: `loc-${index}`,
    }));
    const { selected, skipped } = selectFormationCandidates({
      candidates,
      currentOpenCount: 0,
    });
    expect(selected).toHaveLength(4);
    expect(skipped).toHaveLength(2);
    expect(selected[0]?.evidenceLocator).toBe("loc-0");
  });

  it("caps owners at 128 current open loops including suppressed ones", () => {
    const candidates = [0, 1].map((index) => ({
      proposalIndex: index,
      followupEligibleFromAt: "2026-09-20T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      evidenceLocator: `loc-${index}`,
    }));
    const full = selectFormationCandidates({
      candidates,
      currentOpenCount: 128,
    });
    expect(full.selected).toHaveLength(0);
    const freed = selectFormationCandidates({
      candidates,
      currentOpenCount: 128,
      freedByClosureCount: 2,
    });
    expect(freed.selected).toHaveLength(2);
  });

  it("reads the lane only with a complete watermark", () => {
    expect(
      isOpenLoopLaneReadable({
        snapshotSettledThroughCommittedAt: "2026-09-20T00:00:00.000Z",
        maxFinalEventCommittedAt: "2026-09-21T00:00:00.000Z",
        hasPendingInvalidation: false,
      }),
    ).toBe(false);
    expect(
      isOpenLoopLaneReadable({
        snapshotSettledThroughCommittedAt: "2026-09-21T00:00:00.000Z",
        maxFinalEventCommittedAt: "2026-09-21T00:00:00.000Z",
        hasPendingInvalidation: true,
      }),
    ).toBe(false);
    expect(
      isOpenLoopLaneReadable({
        snapshotSettledThroughCommittedAt: "2026-09-21T00:00:00.000Z",
        maxFinalEventCommittedAt: "2026-09-21T00:00:00.000Z",
        hasPendingInvalidation: false,
      }),
    ).toBe(true);
  });

  it("enforces the 30-day non-current summary grace at read time", () => {
    expect(
      isOpenLoopSummaryReadable({
        status: "open",
        leftOpenAt: null,
        now: new Date("2026-12-01T00:00:00.000Z"),
      }),
    ).toBe(true);
    expect(
      isOpenLoopSummaryReadable({
        status: "expired",
        leftOpenAt: "2026-10-01T00:00:00.000Z",
        now: new Date("2026-10-20T00:00:00.000Z"),
      }),
    ).toBe(true);
    expect(
      isOpenLoopSummaryReadable({
        status: "expired",
        leftOpenAt: "2026-10-01T00:00:00.000Z",
        now: new Date("2026-11-05T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  it("never revives occurred/resolved/canceled and only reforms expired/retracted on new unique evidence", () => {
    expect(
      canReformTerminalLoop({
        terminalStatus: "occurred",
        hasNewUniquelyMatchingDirectEvidence: true,
      }),
    ).toBe(false);
    expect(
      canReformTerminalLoop({
        terminalStatus: "expired",
        hasNewUniquelyMatchingDirectEvidence: false,
      }),
    ).toBe(false);
    expect(
      canReformTerminalLoop({
        terminalStatus: "retracted",
        hasNewUniquelyMatchingDirectEvidence: true,
      }),
    ).toBe(true);
  });

  it("binds dedupe fingerprints to owner, target, evidence and policy", () => {
    const fingerprint = openLoopDedupeFingerprint({
      userId: "01984477-1f9a-7b25-a5cc-83c3b21fbc68",
      semanticTarget: "upcoming_event|new|2026-10-02|rev-1",
      evidenceRevisionIds: ["rev-1"],
      policyVersion: "open-loop-formation:v1",
      secret: "test-secret",
    });
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      openLoopDedupeFingerprint({
        userId: "01984477-1f9a-7b25-a5cc-83c3b21fbc68",
        semanticTarget: "x",
        evidenceRevisionIds: [],
        policyVersion: "v1",
        secret: "  ",
      }),
    ).toThrow();
  });
});
