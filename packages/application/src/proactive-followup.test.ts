import { describe, expect, it } from "vitest";

import {
  planProactiveFollowupCooldownRelease,
  planProactiveFollowupDisposition,
  planProactiveFollowupRelease,
  selectProactiveFollowupTarget,
  type ProactiveFollowupCandidate,
  type ProactiveFollowupSelectionInput,
  type ProactiveFollowupStateSnapshot,
} from "./proactive-followup";

const NOW = new Date("2026-09-11T12:00:00.000Z");

function candidate(
  overrides: Partial<ProactiveFollowupCandidate> = {},
): ProactiveFollowupCandidate {
  return {
    targetKind: "open_loop",
    targetId: "loop-1",
    targetVersionId: "loop-version-1",
    source: "open_loop",
    sourceRank: null,
    evidenceAt: "2026-09-10T12:00:00.000Z",
    expectedStartAt: null,
    expiresAt: "2026-10-01T12:00:00.000Z",
    sensitive: false,
    lastUsedAt: null,
    current: true,
    eligible: true,
    trustFence: "valid",
    mentionedInExchange: false,
    formedInCurrentTurn: false,
    ...overrides,
  };
}

function selectionInput(
  overrides: Partial<ProactiveFollowupSelectionInput> = {},
): ProactiveFollowupSelectionInput {
  return {
    userId: "user-1",
    dailySessionId: "session-1",
    continuousExchangeNo: 3,
    currentUserEventRevisionId: "user-revision-2",
    currentUserEventSequence: 2,
    currentSourceRevision: 8,
    opportunity: "natural_gap",
    ordinaryQuestionAlreadyAsked: false,
    dialogue: {
      status: "current",
      coveredThroughSequence: 2,
      currentEventSequence: 2,
      currentEventRevisionId: "user-revision-2",
      currentRequestRequiresFocus: {
        value: false,
        confidence: 0.91,
        sourceRevisionIds: ["user-revision-2"],
      },
    },
    lanes: [
      {
        name: "open_loop",
        enabled: true,
        status: "complete",
        watermark: { sourceRevision: 8, coveredThroughSequence: 2 },
        manifestVersion: "open-loop-read:v1",
        integrity: "valid",
        candidates: [candidate()],
      },
      {
        name: "memory",
        enabled: true,
        status: "complete",
        watermark: { sourceRevision: 8, coveredThroughSequence: 2 },
        manifestVersion: "memory-retrieval:v1",
        integrity: "valid",
        candidates: [
          candidate({
            targetKind: "memory_claim",
            targetId: "claim-1",
            targetVersionId: "claim-version-1",
            source: "person_portrait",
            sourceRank: 0,
            evidenceAt: "2026-09-09T12:00:00.000Z",
          }),
        ],
      },
    ],
    states: [],
    now: NOW,
    ...overrides,
  };
}

function state(
  overrides: Partial<ProactiveFollowupStateSnapshot> = {},
): ProactiveFollowupStateSnapshot {
  return {
    stateId: "state-1",
    stateVersionId: "state-version-1",
    targetKind: "open_loop",
    targetId: "loop-1",
    targetVersionId: "loop-version-1",
    eligibilityStatus: "eligible",
    suppressionReason: null,
    consecutiveSoftStopCount: 0,
    suppressedUntilAt: null,
    lastPromptEventRevisionId: "user-revision-1",
    lastResponseEventRevisionId: "assistant-revision-1",
    lastUsedAt: null,
    releaseReason: null,
    ...overrides,
  };
}

describe("C2 deterministic target selection", () => {
  it("chooses Memory first in a natural gap and Open Loop first at open start", () => {
    const naturalGap = selectProactiveFollowupTarget(selectionInput());
    expect(naturalGap.outcome).toBe("selected");
    if (naturalGap.outcome === "selected") {
      expect(naturalGap.target.targetId).toBe("claim-1");
      expect(
        naturalGap.manifest.candidates.find(
          (item) => item.targetId === "claim-1",
        )?.rankTuple?.slice(0, 2),
      ).toEqual([0, 0]);
    }

    const openStart = selectProactiveFollowupTarget(
      selectionInput({ opportunity: "open_start" }),
    );
    expect(openStart.outcome).toBe("selected");
    if (openStart.outcome === "selected") {
      expect(openStart.target.targetId).toBe("loop-1");
    }
  });

  it("prioritizes non-sensitive and never-used targets without salience scoring", () => {
    const result = selectProactiveFollowupTarget(
      selectionInput({
        lanes: [
          {
            name: "memory",
            enabled: true,
            status: "complete",
            watermark: { sourceRevision: 8, coveredThroughSequence: 2 },
            manifestVersion: "memory-retrieval:v1",
            integrity: "valid",
            candidates: [
              candidate({
                targetKind: "memory_claim",
                targetId: "sensitive-new",
                targetVersionId: "v1",
                source: "query_retrieval",
                sourceRank: 0,
                sensitive: true,
              }),
              candidate({
                targetKind: "memory_claim",
                targetId: "ordinary-used",
                targetVersionId: "v1",
                source: "query_retrieval",
                sourceRank: 1,
                lastUsedAt: "2026-09-10T12:00:00.000Z",
              }),
              candidate({
                targetKind: "memory_claim",
                targetId: "ordinary-new",
                targetVersionId: "v1",
                source: "query_retrieval",
                sourceRank: 1,
              }),
            ],
          },
        ],
      }),
    );
    expect(result.outcome).toBe("selected");
    if (result.outcome === "selected") {
      expect(result.target.targetId).toBe("ordinary-new");
    }
  });

  it("replays the frozen within-lane profiles before usage fairness", () => {
    const openLoopResult = selectProactiveFollowupTarget(
      selectionInput({
        opportunity: "open_start",
        lanes: [
          {
            name: "open_loop",
            enabled: true,
            status: "complete",
            watermark: { sourceRevision: 8, coveredThroughSequence: 2 },
            manifestVersion: "open-loop-read:v1",
            integrity: "valid",
            candidates: [
              candidate({
                targetId: "later",
                expectedStartAt: "2026-09-20T12:00:00.000Z",
                lastUsedAt: "2026-09-10T12:00:00.000Z",
              }),
              candidate({
                targetId: "earlier",
                expectedStartAt: "2026-09-15T12:00:00.000Z",
              }),
            ],
          },
        ],
      }),
    );
    expect(openLoopResult).toMatchObject({
      outcome: "selected",
      target: { targetId: "earlier" },
    });

    const memoryResult = selectProactiveFollowupTarget(
      selectionInput({
        lanes: [
          {
            name: "memory",
            enabled: true,
            status: "complete",
            watermark: { sourceRevision: 8, coveredThroughSequence: 2 },
            manifestVersion: "memory-retrieval:v1",
            integrity: "valid",
            candidates: [
              candidate({
                targetKind: "memory_claim",
                targetId: "rank-2",
                targetVersionId: "v1",
                source: "query_retrieval",
                sourceRank: 2,
              }),
              candidate({
                targetKind: "memory_claim",
                targetId: "rank-1",
                targetVersionId: "v1",
                source: "person_portrait",
                sourceRank: 1,
              }),
            ],
          },
        ],
      }),
    );
    expect(memoryResult).toMatchObject({
      outcome: "selected",
      target: { targetId: "rank-1" },
    });
  });

  it("fails closed for focus, ordinary questions, stale dialogue, or a bad lane", () => {
    expect(
      selectProactiveFollowupTarget(
        selectionInput({ opportunity: "direct_task" }),
      ),
    ).toMatchObject({ outcome: "none", reason: "focus_required_by_opportunity" });
    expect(
      selectProactiveFollowupTarget(
        selectionInput({ ordinaryQuestionAlreadyAsked: true }),
      ),
    ).toMatchObject({ outcome: "none", reason: "ordinary_question_present" });
    expect(
      selectProactiveFollowupTarget(
        selectionInput({
          dialogue: {
            ...selectionInput().dialogue,
            currentRequestRequiresFocus: {
              value: false,
              confidence: 0.69,
              sourceRevisionIds: ["user-revision-2"],
            },
          },
        }),
      ),
    ).toMatchObject({ outcome: "none", reason: "dialogue_state_not_ready" });
    expect(
      selectProactiveFollowupTarget(
        selectionInput({
          lanes: selectionInput().lanes.map((lane) =>
            lane.name === "memory"
              ? { ...lane, manifestVersion: "unknown:v1" }
              : lane,
          ),
        }),
      ),
    ).toMatchObject({ outcome: "none", reason: "lane_not_readable" });
  });

  it("ignores disabled lanes and rejects candidates assigned to the wrong lane", () => {
    const disabledLane = {
      name: "memory" as const,
      enabled: false,
      status: "unavailable" as const,
      watermark: null,
      manifestVersion: "unknown:v1",
      integrity: "invalid" as const,
      candidates: [
        candidate({
          targetKind: "memory_claim",
          targetId: "disabled-memory",
          targetVersionId: "v1",
          source: "person_portrait",
          sourceRank: 0,
        }),
      ],
    };
    const ignored = selectProactiveFollowupTarget(
      selectionInput({
        lanes: [
          selectionInput().lanes[0]!,
          disabledLane,
        ],
      }),
    );
    expect(ignored).toMatchObject({
      outcome: "selected",
      target: { targetId: "loop-1" },
    });

    const wrongLane = selectProactiveFollowupTarget(
      selectionInput({
        lanes: [
          {
            ...selectionInput().lanes[0]!,
            candidates: [
              candidate({
                targetKind: "memory_claim",
                source: "person_portrait",
                sourceRank: 0,
              }),
            ],
          },
        ],
      }),
    );
    expect(wrongLane).toMatchObject({
      outcome: "none",
      reason: "lane_not_readable",
    });
  });

  it("excludes same-exchange mentions, same-turn loops, and suppressed versions", () => {
    const result = selectProactiveFollowupTarget(
      selectionInput({
        lanes: selectionInput().lanes.map((lane) => ({
          ...lane,
          candidates: lane.candidates.map((item) => ({
            ...item,
            mentionedInExchange: true,
            formedInCurrentTurn: true,
          })),
        })),
        states: [
          state({
            targetKind: "memory_claim",
            targetId: "claim-1",
            targetVersionId: "claim-version-1",
            eligibilityStatus: "suppressed",
            suppressionReason: "refused",
          }),
        ],
      }),
    );
    expect(result).toMatchObject({ outcome: "none", reason: "no_eligible_target" });
    if (result.outcome === "none") {
      expect(result.manifest.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ exclusionReason: "mentioned_in_exchange" }),
        ]),
      );
    }
  });
});

describe("C2 suppression and release policy", () => {
  const use = {
    useId: "use-1",
    userId: "user-1",
    targetKind: "open_loop" as const,
    targetId: "loop-1",
    targetVersionId: "loop-version-1",
    promptUserEventRevisionId: "user-revision-1",
    promptUserEventSequence: 1,
    exchangeNo: 3,
    finalTextLocator: {
      kind: "assistant_event_revision" as const,
      assistantEventRevisionId: "assistant-revision-1",
      segment: "proactive_followup" as const,
      ordinal: 0 as const,
    },
  };

  it("uses local calendar-day cooldowns and becomes indefinite after escalation", () => {
    const plan = (count: number, signal: "topic_changed" | "short_response" | "evaded") =>
      planProactiveFollowupDisposition({
        userId: "user-1",
        now: NOW,
        timeZone: "Asia/Shanghai",
        signal,
        targetKind: "open_loop",
        targetId: "loop-1",
        targetVersionId: "loop-version-1",
        currentUserEventRevisionId: "user-revision-2",
        currentUserEventSequence: 2,
        use,
        state: state({ consecutiveSoftStopCount: count }),
      });

    expect(plan(0, "topic_changed").suppressionUntilAt).toBe(
      "2026-09-12T12:00:00.000Z",
    );
    expect(plan(1, "topic_changed").suppressionUntilAt).toBe(
      "2026-09-18T12:00:00.000Z",
    );
    expect(plan(2, "topic_changed").suppressionUntilAt).toBe(
      "2026-10-11T12:00:00.000Z",
    );
    expect(plan(3, "topic_changed").suppressionUntilAt).toBeNull();
    expect(plan(1, "short_response").suppressionUntilAt).toBe(
      "2026-10-11T12:00:00.000Z",
    );
    expect(plan(0, "evaded").suppressionUntilAt).toBe(
      "2026-10-11T12:00:00.000Z",
    );
  });

  it("treats refusal and ambiguous closure as indefinite suppression", () => {
    for (const signal of ["refused", "ambiguous_closure"] as const) {
      const result = planProactiveFollowupDisposition({
        userId: "user-1",
        now: NOW,
        timeZone: "UTC",
        signal,
        targetKind: "open_loop",
        targetId: "loop-1",
        targetVersionId: "loop-version-1",
        currentUserEventRevisionId: "user-revision-2",
        currentUserEventSequence: 2,
        use,
        state: null,
      });
      expect(result).toMatchObject({
        outcome: "suppressed",
        suppressionUntilAt: null,
        suppressionReason: signal,
        state: null,
      });
    }
  });

  it("releases exactly at the cooldown boundary and rejects generic permission", () => {
    const suppressed = state({
      eligibilityStatus: "suppressed",
      suppressionReason: "topic_changed",
      suppressedUntilAt: "2026-09-12T12:00:00.000Z",
    });
    expect(
      planProactiveFollowupCooldownRelease({
        now: new Date("2026-09-12T12:00:00.000Z"),
        state: suppressed,
      }),
    ).toMatchObject({ outcome: "released", reason: "cooldown_elapsed" });
    expect(
      planProactiveFollowupRelease({
        now: NOW,
        reason: "target_specific_permission",
        targetKind: "open_loop",
        targetId: "loop-1",
        targetVersionId: "loop-version-1",
        currentUserEventRevisionId: "user-revision-2",
        currentUserEventSequence: 2,
        permissionTargetId: null,
        state: { ...suppressed, suppressedUntilAt: null },
      }),
    ).toMatchObject({ outcome: "rejected", reason: "permission_not_target_specific" });

    const released = planProactiveFollowupRelease({
      now: NOW,
      reason: "user_reopened",
      targetKind: "open_loop",
      targetId: "loop-1",
      targetVersionId: "loop-version-1",
      currentUserEventRevisionId: "user-revision-2",
      currentUserEventSequence: 2,
      permissionTargetId: null,
      state: { ...suppressed, consecutiveSoftStopCount: 3 },
    });
    expect(released).toMatchObject({
      outcome: "released",
      state: { consecutiveSoftStopCount: 0 },
    });
  });

  it("does not invent a state row for a no-stop signal", () => {
    const result = planProactiveFollowupDisposition({
      userId: "user-1",
      now: NOW,
      timeZone: "UTC",
      signal: "no_stop_signal",
      targetKind: "open_loop",
      targetId: "loop-1",
      targetVersionId: "loop-version-1",
      currentUserEventRevisionId: "user-revision-2",
      currentUserEventSequence: 2,
      use,
      state: null,
    });
    expect(result).toEqual({
      outcome: "unchanged",
      state: null,
      suppressionUntilAt: null,
      suppressionReason: null,
    });
  });
});
