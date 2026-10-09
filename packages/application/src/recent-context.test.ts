import {
  asCompiledContextId,
  asConversationEventRevisionId,
  asDailySessionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asUserId,
} from "@sayhear/domain";
import { describe, expect, it } from "vitest";

import {
  CompiledContextIntegrityError,
  createContextCompiler,
  LEGACY_CONTEXT_COMPILER_VERSION,
  RECENT_CONTEXT_COMPILER_VERSION,
  type ContextCompilerRepository,
  type ContextPolicyVersions,
  type ContextSourceSnapshot,
} from "./context-compiler";
import {
  decodeRecentContextReference,
  encodeRecentContextReference,
  localDateOf,
  RECENT_CONTEXT_REFERENCE_VERSION,
  RECENT_CONTEXT_SECTION_KEY,
  RECENT_CONTEXT_SELECTION_POLICY_VERSION,
  RecentContextReferenceError,
  resolveRecentContextWindow,
  selectRecentContext,
  shiftLocalDate,
  type RecentContextSelectionPolicy,
  type RecentContextSourceItem,
  type RecentContextSourcePort,
} from "./recent-context";

const POLICY: RecentContextSelectionPolicy = {
  budgets: {
    maxCandidateBytes: 1_000_000,
    maxCandidateRows: 1_000,
    maxContextTokens: 400,
    maxSingleEventTokens: 100,
    readTimeoutMs: 1_000,
  },
  version: "recent-context-selection-policy:v1",
  windowDays: 7,
};

const TZ = "America/Los_Angeles";
const U = "01984477-59a9-7d20-9d97-";

function rev(n: number) {
  return asConversationEventRevisionId(
    `${U}${n.toString(16).padStart(12, "0")}`,
  );
}

function item(
  overrides: Partial<Omit<RecentContextSourceItem, "revisionId">> & {
    revisionId: number;
    text: string;
  },
): RecentContextSourceItem {
  const { revisionId, ...rest } = overrides;
  return {
    actor: "user",
    dailySessionId: asDailySessionId(`${U}000000000001`),
    exclusion: null,
    expressedAt: "2026-08-13T18:00:00.000Z",
    occurredAt: null,
    sequence: 1,
    ...rest,
    revisionId: rev(revisionId),
  };
}

function select(
  items: readonly RecentContextSourceItem[],
  overrides: Partial<Parameters<typeof selectRecentContext>[0]> = {},
) {
  return selectRecentContext({
    frozenAt: new Date("2026-08-13T19:00:00.000Z"),
    items,
    policy: POLICY,
    timezone: TZ,
    windowEndLocalDate: "2026-08-13",
    windowStartLocalDate: "2026-08-07",
    ...overrides,
  });
}

function revisionIds(selection: ReturnType<typeof selectRecentContext>) {
  return selection.selected.map((event) => String(event.revisionId));
}

function omissionFor(
  selection: ReturnType<typeof selectRecentContext>,
  revisionId: string,
) {
  return selection.omitted.find(
    (omission) => String(omission.revisionId ?? "") === revisionId,
  );
}

describe("recent-context selector (#293)", () => {
  it("freezes a seven-local-day window and never pads empty days", () => {
    expect(
      resolveRecentContextWindow({
        frozenAt: new Date("2026-08-13T19:00:00.000Z"),
        timezone: TZ,
        windowDays: 7,
      }),
    ).toEqual({
      windowEndLocalDate: "2026-08-13",
      windowStartLocalDate: "2026-08-07",
    });
  });

  it("keeps today first, one representative per earlier day, then budget fills", () => {
    const selection = select([
      item({
        expressedAt: "2026-08-06T18:00:00.000Z",
        revisionId: 1,
        text: "too old",
      }),
      item({
        expressedAt: "2026-08-08T18:00:00.000Z",
        revisionId: 2,
        text: "a",
      }),
      item({
        expressedAt: "2026-08-10T16:00:00.000Z",
        revisionId: 3,
        text: "b",
      }),
      item({
        expressedAt: "2026-08-13T17:00:00.000Z",
        revisionId: 4,
        text: "c",
      }),
      item({
        expressedAt: "2026-08-13T18:30:00.000Z",
        revisionId: 5,
        text: "d",
      }),
    ]);

    expect(revisionIds(selection)).toEqual(
      [rev(2), rev(3), rev(4), rev(5)].map(String),
    );
    expect(selection.selected.map((event) => event.selectionReason)).toEqual([
      "day_representation",
      "day_representation",
      "today",
      "today",
    ]);
    expect(omissionFor(selection, String(rev(1)))).toEqual({
      controlId: null,
      reason: "outside_window",
      revisionId: String(rev(1)),
    });
  });

  it("does not restore an excluded user or its adjacent assistant (probe regression)", () => {
    const session = asDailySessionId(`${U}000000000020`);
    const turnExcluded = asInteractionTurnId(`${U}000000000027`);
    const turnUnrelated = asInteractionTurnId(`${U}000000000026`);
    const selection = selectRecentContext({
      cutoff: {
        currentInputRevisionId: rev(0x999),
        currentInputSequence: 99,
        dailySessionId: asDailySessionId(`${U}000000000021`),
        expressedAt: "2026-10-08T12:00:00.000Z",
      },
      frozenAt: new Date("2026-10-08T12:00:00.000Z"),
      items: [
        item({
          dailySessionId: session,
          expressedAt: "2026-10-07T12:00:00.000Z",
          interactionTurnId: turnUnrelated,
          revisionId: 6,
          sequence: 1,
          text: "An unrelated earlier exchange",
        }),
        item({
          dailySessionId: session,
          exclusion: { controlId: "forget-1", reason: "forget_association" },
          expressedAt: "2026-10-07T12:01:00.000Z",
          interactionTurnId: turnExcluded,
          revisionId: 7,
          sequence: 2,
          text: "This is the forgotten source",
        }),
        item({
          actor: "assistant",
          dailySessionId: session,
          expressedAt: "2026-10-07T12:02:00.000Z",
          interactionTurnId: turnExcluded,
          revisionId: 8,
          sequence: 3,
          text: "Repeating the forgotten source",
        }),
        item({
          dailySessionId: session,
          expressedAt: "2026-10-08T13:00:00.000Z",
          revisionId: 9,
          sequence: 4,
          text: "A later input that must not be read",
        }),
      ],
      policy: {
        ...POLICY,
        budgets: { ...POLICY.budgets, maxContextTokens: 200 },
      },
      timezone: "UTC",
      windowEndLocalDate: "2026-10-08",
      windowStartLocalDate: "2026-10-02",
    });

    const selected = selection.selected.map((event) => String(event.revisionId));
    expect(selected).toEqual([String(rev(6))]);
    expect(selected).not.toContain(String(rev(8)));
    expect(selected).not.toContain(String(rev(9)));
    expect(omissionFor(selection, String(rev(8)))).toMatchObject({
      reason: "assistant_of_excluded_user",
    });
    expect(omissionFor(selection, String(rev(9)))).toMatchObject({
      reason: "after_cutoff",
    });
  });

  it("does not restore an assistant whose associated user was budget-omitted", () => {
    const session = asDailySessionId(`${U}000000000030`);
    const turn = asInteractionTurnId(`${U}000000000031`);
    const selection = selectRecentContext({
      frozenAt: new Date("2026-08-13T19:00:00.000Z"),
      items: [
        item({
          dailySessionId: session,
          expressedAt: "2026-08-12T10:00:00.000Z",
          interactionTurnId: turn,
          revisionId: 10,
          sequence: 1,
          text: "x".repeat(2_000),
        }),
        item({
          actor: "assistant",
          dailySessionId: session,
          expressedAt: "2026-08-12T10:01:00.000Z",
          interactionTurnId: turn,
          revisionId: 11,
          sequence: 2,
          text: "short echo",
        }),
      ],
      policy: POLICY,
      timezone: "UTC",
      windowEndLocalDate: "2026-08-13",
      windowStartLocalDate: "2026-08-07",
    });

    expect(revisionIds(selection)).toEqual([]);
    expect(omissionFor(selection, String(rev(10)))).toMatchObject({
      reason: "single_event_over_budget",
    });
    expect(omissionFor(selection, String(rev(11)))).toMatchObject({
      reason: "assistant_of_omitted_user",
    });
  });

  it("binds an assistant to its canonical generating command input, not a nearer user (#294)", () => {
    const session = asDailySessionId(`${U}000000000050`);
    const turnA = asInteractionTurnId(`${U}0000000000a5`);
    const turnB = asInteractionTurnId(`${U}0000000000b5`);
    const selection = selectRecentContext({
      frozenAt: new Date("2026-08-13T19:00:00.000Z"),
      items: [
        item({
          dailySessionId: session,
          expressedAt: "2026-08-12T10:00:00.000Z",
          interactionTurnId: turnA,
          revisionId: 20,
          sequence: 1,
          text: "x".repeat(2_000),
        }),
        item({
          dailySessionId: session,
          expressedAt: "2026-08-12T10:01:00.000Z",
          interactionTurnId: turnB,
          revisionId: 21,
          sequence: 2,
          text: "eligible intervening user",
        }),
        item({
          actor: "assistant",
          dailySessionId: session,
          expressedAt: "2026-08-12T10:02:00.000Z",
          generationCommandId: "cmd-delayed-a1",
          generatingUserRevisionId: rev(20),
          interactionTurnId: turnA,
          revisionId: 22,
          sequence: 3,
          text: "reply generated by the omitted user",
        }),
      ],
      policy: POLICY,
      timezone: "UTC",
      windowEndLocalDate: "2026-08-13",
      windowStartLocalDate: "2026-08-07",
    });

    // The assistant's command input is the omitted U1, so the nearer eligible
    // U2 must not make it selectable by structural adjacency alone.
    expect(revisionIds(selection)).toEqual([String(rev(21))]);
    expect(omissionFor(selection, String(rev(22)))).toMatchObject({
      reason: "assistant_of_omitted_user",
    });
  });

  it("keeps a retried assistant bound to the original input, not the nearest user (#294)", () => {
    const session = asDailySessionId(`${U}000000000060`);
    const turnOriginal = asInteractionTurnId(`${U}0000000000a6`);
    const turnOther = asInteractionTurnId(`${U}0000000000b6`);
    // The explicit-retry turn carries no user revision of its own.
    const turnRetry = asInteractionTurnId(`${U}0000000000c6`);
    const selection = selectRecentContext({
      frozenAt: new Date("2026-08-13T19:00:00.000Z"),
      items: [
        item({
          dailySessionId: session,
          expressedAt: "2026-08-12T10:00:00.000Z",
          interactionTurnId: turnOriginal,
          revisionId: 30,
          sequence: 1,
          text: "x".repeat(2_000),
        }),
        item({
          dailySessionId: session,
          expressedAt: "2026-08-12T10:01:00.000Z",
          interactionTurnId: turnOther,
          revisionId: 31,
          sequence: 2,
          text: "eligible intervening user",
        }),
        item({
          actor: "assistant",
          dailySessionId: session,
          expressedAt: "2026-08-12T10:02:00.000Z",
          generationCommandId: "cmd-retry-a1",
          generatingUserRevisionId: rev(30),
          interactionTurnId: turnRetry,
          revisionId: 32,
          sequence: 3,
          text: "retry reply generated for the original input",
        }),
      ],
      policy: POLICY,
      timezone: "UTC",
      windowEndLocalDate: "2026-08-13",
      windowStartLocalDate: "2026-08-07",
    });

    expect(revisionIds(selection)).toEqual([String(rev(31))]);
    expect(omissionFor(selection, String(rev(32)))).toMatchObject({
      reason: "assistant_of_omitted_user",
    });
  });

  it("fails a modern assistant closed when its command input is unresolved (#294)", () => {
    const session = asDailySessionId(`${U}000000000070`);
    const turnB = asInteractionTurnId(`${U}0000000000b7`);
    const selection = selectRecentContext({
      frozenAt: new Date("2026-08-13T19:00:00.000Z"),
      items: [
        item({
          dailySessionId: session,
          expressedAt: "2026-08-12T10:00:00.000Z",
          interactionTurnId: turnB,
          revisionId: 41,
          sequence: 1,
          text: "eligible user",
        }),
        item({
          actor: "assistant",
          dailySessionId: session,
          expressedAt: "2026-08-12T10:01:00.000Z",
          generationCommandId: "cmd-orphaned",
          generatingUserRevisionId: null,
          interactionTurnId: turnB,
          revisionId: 42,
          sequence: 2,
          text: "assistant whose generating input does not resolve",
        }),
      ],
      policy: POLICY,
      timezone: "UTC",
      windowEndLocalDate: "2026-08-13",
      windowStartLocalDate: "2026-08-07",
    });

    expect(revisionIds(selection)).toEqual([String(rev(41))]);
    expect(omissionFor(selection, String(rev(42)))).toMatchObject({
      reason: "unreferenced_assistant",
    });
  });

  it("falls back to the same turn only for a legacy assistant with no command (#294)", () => {
    const session = asDailySessionId(`${U}000000000080`);
    const turnA = asInteractionTurnId(`${U}0000000000a8`);
    const turnB = asInteractionTurnId(`${U}0000000000b8`);
    const selection = selectRecentContext({
      frozenAt: new Date("2026-08-13T19:00:00.000Z"),
      items: [
        item({
          dailySessionId: session,
          exclusion: { controlId: "forget-legacy", reason: "forget_association" },
          expressedAt: "2026-08-12T10:00:00.000Z",
          interactionTurnId: turnA,
          revisionId: 50,
          sequence: 1,
          text: "legacy forgotten source",
        }),
        item({
          dailySessionId: session,
          expressedAt: "2026-08-12T10:01:00.000Z",
          interactionTurnId: turnB,
          revisionId: 51,
          sequence: 2,
          text: "eligible intervening user",
        }),
        item({
          actor: "assistant",
          dailySessionId: session,
          expressedAt: "2026-08-12T10:02:00.000Z",
          generationCommandId: null,
          interactionTurnId: turnA,
          revisionId: 52,
          sequence: 3,
          text: "legacy reply for the forgotten source",
        }),
      ],
      policy: POLICY,
      timezone: "UTC",
      windowEndLocalDate: "2026-08-13",
      windowStartLocalDate: "2026-08-07",
    });

    expect(revisionIds(selection)).toEqual([String(rev(51))]);
    expect(omissionFor(selection, String(rev(52)))).toMatchObject({
      reason: "assistant_of_excluded_user",
    });
  });

  it("omits a legacy assistant with neither command nor same-turn identity (#294)", () => {
    const session = asDailySessionId(`${U}000000000090`);
    const turnB = asInteractionTurnId(`${U}0000000000b9`);
    const selection = selectRecentContext({
      frozenAt: new Date("2026-08-13T19:00:00.000Z"),
      items: [
        item({
          dailySessionId: session,
          expressedAt: "2026-08-12T10:00:00.000Z",
          interactionTurnId: turnB,
          revisionId: 60,
          sequence: 1,
          text: "eligible user",
        }),
        item({
          actor: "assistant",
          dailySessionId: session,
          expressedAt: "2026-08-12T10:01:00.000Z",
          generationCommandId: null,
          interactionTurnId: null,
          revisionId: 61,
          sequence: 2,
          text: "legacy assistant without identity",
        }),
      ],
      policy: POLICY,
      timezone: "UTC",
      windowEndLocalDate: "2026-08-13",
      windowStartLocalDate: "2026-08-07",
    });

    expect(revisionIds(selection)).toEqual([String(rev(60))]);
    expect(omissionFor(selection, String(rev(61)))).toMatchObject({
      reason: "unreferenced_assistant",
    });
  });

  it("tries another complete user expression for a day when the newest cannot fit", () => {
    const selection = selectRecentContext({
      frozenAt: new Date("2026-08-13T19:00:00.000Z"),
      items: [
        item({
          expressedAt: "2026-08-12T10:00:00.000Z",
          revisionId: 12,
          sequence: 1,
          text: "a complete earlier expression",
        }),
        item({
          expressedAt: "2026-08-12T11:00:00.000Z",
          revisionId: 13,
          sequence: 2,
          text: "y".repeat(2_000),
        }),
      ],
      policy: POLICY,
      timezone: "UTC",
      windowEndLocalDate: "2026-08-13",
      windowStartLocalDate: "2026-08-07",
    });

    expect(revisionIds(selection)).toEqual([String(rev(12))]);
    expect(selection.selected[0]?.selectionReason).toBe("day_representation");
  });

  it("reserves the cheapest complete expression per prior date before newest fill (#294)", () => {
    const nearDates = ["2026-08-12", "2026-08-11", "2026-08-10"];
    const farDates = ["2026-08-09", "2026-08-08", "2026-08-07"];
    const items = [
      ...nearDates.map((localDate, index) =>
        item({
          expressedAt: `${localDate}T10:00:00.000Z`,
          revisionId: 100 + index,
          sequence: 1,
          text: "x".repeat(2_400),
        }),
      ),
      ...farDates.map((localDate, index) =>
        item({
          expressedAt: `${localDate}T10:00:00.000Z`,
          revisionId: 200 + index,
          sequence: 1,
          text: "y".repeat(200),
        }),
      ),
    ];
    const selection = select(items, {
      policy: {
        ...POLICY,
        budgets: {
          ...POLICY.budgets,
          maxContextTokens: 1_200,
          maxSingleEventTokens: 600,
        },
      },
      windowEndLocalDate: "2026-08-13",
      windowStartLocalDate: "2026-08-07",
    });

    // Greedy nearest-first would spend 600+600 on the near dates and starve
    // the far dates. The cheapest floor covers all three far dates first.
    const selectedDates = new Set(
      selection.selected.map((event) =>
        event.expressedAt.slice(0, 10),
      ),
    );
    expect(selectedDates.size).toBe(4);
    for (const localDate of farDates) {
      expect(selectedDates.has(localDate)).toBe(true);
    }
  });

  it("does not report truncation when candidates exactly equal the cap (#294)", () => {
    const exact = select([item({ revisionId: 1, text: "a" })], {
      candidateBytes: 400,
      candidateRows: 400,
      policy: {
        ...POLICY,
        budgets: {
          ...POLICY.budgets,
          maxCandidateBytes: 400,
          maxCandidateRows: 400,
        },
      },
    });
    expect(exact.counts.truncated).toBe(false);

    const over = select([item({ revisionId: 1, text: "a" })], {
      candidateBytes: 401,
      candidateRows: 401,
      policy: {
        ...POLICY,
        budgets: {
          ...POLICY.budgets,
          maxCandidateBytes: 400,
          maxCandidateRows: 400,
        },
      },
    });
    expect(over.counts.truncated).toBe(true);
  });

  it("records honest per-date coverage when the read was bounded (#294)", () => {
    const selection = select(
      [
        item({
          expressedAt: "2026-08-12T10:00:00.000Z",
          revisionId: 1,
          sequence: 1,
          text: "z".repeat(2_000),
        }),
      ],
      {
        perDate: [
          {
            candidateRows: 2,
            empty: false,
            localDate: "2026-08-12",
            readBounded: false,
          },
          {
            candidateRows: 5,
            empty: false,
            localDate: "2026-08-11",
            readBounded: true,
          },
          {
            candidateRows: 0,
            empty: true,
            localDate: "2026-08-10",
            readBounded: false,
          },
        ],
        policy: POLICY,
        windowEndLocalDate: "2026-08-13",
        windowStartLocalDate: "2026-08-07",
      },
    );

    expect(selection.omitted).toContainEqual({
      controlId: null,
      reason: "date_budget_excluded",
      revisionId: null,
    });
    expect(selection.omitted).toContainEqual({
      controlId: null,
      reason: "date_read_bounded",
      revisionId: null,
    });
    // The genuinely empty date never produces a padded omission.
    expect(selection.perDate).toHaveLength(3);
  });

  it("does not misattribute a control-excluded date as a budget exclusion (#294)", () => {
    const selection = select(
      [
        item({
          exclusion: { controlId: "control-1", reason: "forget_association" },
          expressedAt: "2026-08-12T10:00:00.000Z",
          revisionId: 1,
          sequence: 1,
          text: "explicitly forgotten",
        }),
      ],
      {
        perDate: [
          {
            candidateRows: 1,
            empty: false,
            localDate: "2026-08-12",
            readBounded: false,
          },
        ],
        policy: POLICY,
        windowEndLocalDate: "2026-08-13",
        windowStartLocalDate: "2026-08-07",
      },
    );

    expect(selection.omitted).toContainEqual({
      controlId: "control-1",
      reason: "explicit_control",
      revisionId: String(rev(1)),
    });
    // The item-level control reason already explains the gap; the date must
    // not be double-reported as a budget exclusion.
    expect(
      selection.omitted.some(
        (omission) => omission.reason === "date_budget_excluded",
      ),
    ).toBe(false);
  });

  it("does not double-report a read-bounded date as a budget exclusion (#294)", () => {
    const selection = select([], {
      perDate: [
        {
          candidateRows: 5,
          empty: false,
          localDate: "2026-08-11",
          readBounded: true,
        },
      ],
      policy: POLICY,
      windowEndLocalDate: "2026-08-13",
      windowStartLocalDate: "2026-08-07",
    });

    expect(selection.omitted).toContainEqual({
      controlId: null,
      reason: "date_read_bounded",
      revisionId: null,
    });
    // `date_read_bounded` already explains the gap.
    expect(
      selection.omitted.some(
        (omission) => omission.reason === "date_budget_excluded",
      ),
    ).toBe(false);
  });

  it("reports date_budget_excluded only when a candidate was budget-dropped (#294)", () => {
    const selection = select(
      [
        item({
          expressedAt: "2026-08-12T10:00:00.000Z",
          revisionId: 1,
          sequence: 1,
          text: "z".repeat(2_000),
        }),
      ],
      {
        perDate: [
          {
            candidateRows: 1,
            empty: false,
            localDate: "2026-08-12",
            readBounded: false,
          },
        ],
        policy: POLICY,
        windowEndLocalDate: "2026-08-13",
        windowStartLocalDate: "2026-08-07",
      },
    );

    expect(selection.omitted).toContainEqual({
      controlId: null,
      reason: "single_event_over_budget",
      revisionId: String(rev(1)),
    });
    expect(selection.omitted).toContainEqual({
      controlId: null,
      reason: "date_budget_excluded",
      revisionId: null,
    });
  });

  it("orders identical instants by sequence within a session and identity across sessions", () => {
    const sessionA = asDailySessionId(`${U}000000000040`);
    const sessionB = asDailySessionId(`${U}000000000041`);
    const turnA = asInteractionTurnId(`${U}000000000042`);
    const sameInstant = "2026-08-13T18:00:00.000Z";
    const selection = selectRecentContext({
      frozenAt: new Date("2026-08-13T19:00:00.000Z"),
      items: [
        item({
          actor: "assistant",
          dailySessionId: sessionA,
          expressedAt: sameInstant,
          interactionTurnId: turnA,
          revisionId: 14,
          sequence: 2,
          text: "assistant reply",
        }),
        item({
          dailySessionId: sessionA,
          expressedAt: sameInstant,
          interactionTurnId: turnA,
          revisionId: 15,
          sequence: 1,
          text: "user first",
        }),
        item({
          dailySessionId: sessionB,
          expressedAt: sameInstant,
          revisionId: 16,
          sequence: 1,
          text: "other session",
        }),
      ],
      policy: POLICY,
      timezone: "UTC",
      windowEndLocalDate: "2026-08-13",
      windowStartLocalDate: "2026-08-07",
    });

    // Within session A the user (sequence 1) precedes the assistant (2);
    // across sessions the stable revision identity breaks the tie.
    expect(revisionIds(selection)).toEqual(
      [rev(15), rev(14), rev(16)].map(String),
    );
    const a = selection.selected.filter(
      (event) => event.dailySessionId === sessionA,
    );
    expect(a.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("deduplicates revisions already frozen into the compile (current input)", () => {
    const current = rev(0x600);
    const selection = selectRecentContext({
      excludeRevisionIds: [current],
      frozenAt: new Date("2026-08-13T19:00:00.000Z"),
      items: [
        item({
          expressedAt: "2026-08-13T18:00:00.000Z",
          revisionId: 0x600,
          text: "today's current input",
        }),
        item({
          expressedAt: "2026-08-13T17:00:00.000Z",
          revisionId: 18,
          text: "kept",
        }),
      ],
      policy: POLICY,
      timezone: "UTC",
      windowEndLocalDate: "2026-08-13",
      windowStartLocalDate: "2026-08-07",
    });

    expect(revisionIds(selection)).toEqual([String(rev(18))]);
    expect(omissionFor(selection, String(current))).toMatchObject({
      reason: "duplicate_revision",
    });
  });

  it("is deterministic under input reordering", () => {
    const items = [
      item({ expressedAt: "2026-08-13T18:00:00.000Z", revisionId: 19, text: "b" }),
      item({ expressedAt: "2026-08-13T17:00:00.000Z", revisionId: 20, text: "a" }),
      item({ expressedAt: "2026-08-12T10:00:00.000Z", revisionId: 21, text: "c" }),
    ];
    expect(select([...items].reverse())).toEqual(select(items));
  });
});

describe("recent-context frozen reference (#293)", () => {
  it("round-trips the full versioned budget, cutoff and counts metadata", () => {
    const cutoff = {
      currentInputRevisionId: rev(0x600),
      currentInputSequence: 9,
      dailySessionId: asDailySessionId(`${U}000000000050`),
      expressedAt: "2026-08-13T19:00:00.000Z",
    };
    const selection = select([item({ revisionId: 22, text: "yesterday" })], {
      candidateBytes: 123,
      candidateRows: 4,
      cutoff,
      excludeRevisionIds: [rev(0x600)],
      truncated: true,
    });
    const decoded = decodeRecentContextReference(
      encodeRecentContextReference(selection),
    );
    expect(decoded.version).toBe(RECENT_CONTEXT_REFERENCE_VERSION);
    expect(decoded.selectorVersion).toBe(
      RECENT_CONTEXT_SELECTION_POLICY_VERSION,
    );
    expect(decoded.budgets).toEqual(POLICY.budgets);
    expect(decoded.counts).toEqual({
      candidateBytes: 123,
      candidateRows: 4,
      selectedCount: 1,
      truncated: true,
    });
    expect(decoded.cutoff).toEqual({
      currentInputRevisionId: String(cutoff.currentInputRevisionId),
      currentInputSequence: 9,
      dailySessionId: String(cutoff.dailySessionId),
      expressedAt: cutoff.expressedAt,
    });
    expect(decoded.excludedRevisionIds).toEqual([String(rev(0x600))]);
    expect(decoded.windowDays).toBe(POLICY.windowDays);
    expect(decoded.selected[0]).toMatchObject({
      revisionId: String(rev(22)),
      selectionOrder: 0,
      selectionReason: "today",
    });
  });

  it("round-trips the recorded read latency and reads v3 without it (#295)", () => {
    const selection = select([item({ revisionId: 24, text: "yesterday" })], {
      readLatencyMs: 137,
    });
    const decoded = decodeRecentContextReference(
      encodeRecentContextReference(selection),
    );
    expect(decoded.readLatencyMs).toBe(137);
    expect(decoded.wireVersion).toBe(RECENT_CONTEXT_REFERENCE_VERSION);

    // A #294 v3 reference had no read latency; it stays readable and reports
    // the honest "not recorded" state instead of fabricating a value. `version`
    // is normalized for existing consumers but `wireVersion` preserves the
    // actual encoded format so the Inspector is not misled.
    const legacy = JSON.parse(
      encodeRecentContextReference(selection).slice("recent-context:".length),
    ) as Record<string, unknown>;
    delete legacy["readLatencyMs"];
    legacy["version"] = 3;
    const decodedLegacy = decodeRecentContextReference(
      `recent-context:${JSON.stringify(legacy)}`,
    );
    expect(decodedLegacy.readLatencyMs).toBeNull();
    expect(decodedLegacy.version).toBe(RECENT_CONTEXT_REFERENCE_VERSION);
    expect(decodedLegacy.wireVersion).toBe(3);
    expect(decodedLegacy.selected).toHaveLength(1);
  });

  it("rejects unknown and inconsistent frozen references", () => {
    const valid = JSON.parse(
      encodeRecentContextReference(
        select([item({ revisionId: 23, text: "x" })]),
      ).slice("recent-context:".length),
    ) as Record<string, unknown>;
    const withOverrides = (overrides: Record<string, unknown>): string =>
      `recent-context:${JSON.stringify({ ...valid, ...overrides })}`;
    const firstSelected = (valid["selected"] as { revisionId: string }[])[0]!;

    expect(() => decodeRecentContextReference("not-a-reference")).toThrow(
      RecentContextReferenceError,
    );
    expect(() => decodeRecentContextReference("recent-context:{")).toThrow(
      RecentContextReferenceError,
    );
    expect(() =>
      decodeRecentContextReference(withOverrides({ version: 99 })),
    ).toThrow(RecentContextReferenceError);
    expect(() =>
      decodeRecentContextReference(
        withOverrides({ selectorVersion: "recent-context-selection:v9" }),
      ),
    ).toThrow(RecentContextReferenceError);
    expect(() =>
      decodeRecentContextReference(
        withOverrides({ windowEndLocalDate: "2026-08-14" }),
      ),
    ).toThrow(RecentContextReferenceError);
    expect(() =>
      decodeRecentContextReference(withOverrides({ budgetTokens: 1 })),
    ).toThrow(RecentContextReferenceError);
    expect(() =>
      decodeRecentContextReference(
        withOverrides({
          budgets: { ...(valid["budgets"] as object), maxSingleEventTokens: 999 },
        }),
      ),
    ).toThrow(RecentContextReferenceError);
    expect(() =>
      decodeRecentContextReference(
        withOverrides({
          omitted: [
            {
              controlId: null,
              reason: "duplicate_revision",
              revisionId: firstSelected.revisionId,
            },
          ],
        }),
      ),
    ).toThrow(RecentContextReferenceError);
    // A v3 failure is exclusive: a source failure can never coexist with a
    // frozen selected body, so a grafted failure+selected manifest is rejected
    // instead of replaying deleted/unauthorized background.
    const failureWithSelected = () =>
      decodeRecentContextReference(
        withOverrides({
          failure: { code: "source_read_timeout", detail: null },
        }),
      );
    expect(failureWithSelected).toThrow(RecentContextReferenceError);
    expect(failureWithSelected).toThrow("failure_with_selected");
  });
});

const policyVersions: ContextPolicyVersions = {
  canonicalPersonaVersion: "canonical-persona:v1",
  localePolicyVersion: "locale-pack-en:v1",
  outputFormatVersion: "conversation-output:v1",
  personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
  personaContractInvariantVersion: "persona-contract-invariant:v1",
  productPolicyVersion: "product-policy:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
  taskInstructionVersion: "task-instruction-decision:v1",
};

describe("Context Compiler — recent-source freeze/replay (#293)", () => {
  const userId = asUserId(`${U}000000000060`);
  const currentSessionId = asDailySessionId(`${U}000000000061`);
  const earlierSessionId = asDailySessionId(`${U}000000000062`);
  const currentInputRevisionId = rev(0x600);
  const recentRevisionId = rev(0x601);
  const generationCommandId = asGenerationCommandId(`${U}000000000063`);
  const interactionTurnId = asInteractionTurnId(`${U}000000000064`);
  const commandCreatedAt = new Date("2026-08-13T19:00:00.000Z");
  const RECENT_CONTEXT_POLICY_VERSION = "recent-context-governance:test-active";

  // #295: the governance row must name the runtime actually wired here —
  // the recent-aware compiler, the v2 selector, this policy's selection
  // version and budgets — or the compile treats the path as disabled.
  function matchingGovernance() {
    return {
      budgetTokens: POLICY.budgets.maxContextTokens,
      compilerVersion: RECENT_CONTEXT_COMPILER_VERSION,
      maxCandidateBytes: POLICY.budgets.maxCandidateBytes,
      maxCandidateRows: POLICY.budgets.maxCandidateRows,
      maxSingleEventTokens: POLICY.budgets.maxSingleEventTokens,
      policyVersion: RECENT_CONTEXT_POLICY_VERSION,
      readTimeoutMs: POLICY.budgets.readTimeoutMs,
      selectionPolicyVersion: POLICY.version,
      selectorPolicyVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
    };
  }

  function buildSource(
    extraEvents: ContextSourceSnapshot["events"] = [],
  ): ContextSourceSnapshot {
    return {
      commandCreatedAt,
      dailySession: {
        activityState: "active",
        closurePolicyVersion: "daily-session-inactivity:v1",
        continuousExchangeNo: 1,
        id: currentSessionId,
        timezone: TZ,
      },
      dialogueRevision: 1,
      events: [
        ...extraEvents,
        {
          actor: "user",
          locale: "en-US",
          revisionId: currentInputRevisionId,
          sequence: 9,
          text: "today",
        },
      ],
      expectedDataEpoch: 7,
      generationStage: "decision",
      inputRevisionId: currentInputRevisionId,
      locale: "en-US",
      policyVersions,
      // #295: these tests exercise the enabled path, so the compile snapshot
      // carries an active immutable governance row that matches the wired
      // runtime. Without it the compiler treats the recent path as disabled
      // and emits no selection.
      recentContextPolicy: matchingGovernance(),
      sourceRevision: 2,
    };
  }

  function sourcePort(
    items: readonly RecentContextSourceItem[],
  ): RecentContextSourcePort {
    return {
      async loadRecentContextSource(request) {
        return {
          candidateBytes: items.reduce(
            (total, entry) => total + entry.text.length,
            0,
          ),
          candidateRows: items.length,
          failure: null,
          items,
          policyVersion: POLICY.version,
          selectorVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
          timezone: request.timezone,
          truncated: false,
          windowEndLocalDate: request.windowEndLocalDate,
          windowStartLocalDate: request.windowStartLocalDate,
        };
      },
    };
  }

  function createCompilerWithRecent(
    items: readonly RecentContextSourceItem[],
    extraEvents: ContextSourceSnapshot["events"] = [],
  ) {
    let saved:
      | Parameters<ContextCompilerRepository["saveCompiledContext"]>[0]
      | undefined;
    const compiler = createContextCompiler({
      clock: () => new Date("2026-08-14T09:00:00.000Z"),
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "recent-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      recentContext: { policy: POLICY, source: sourcePort(items) },
      repository: {
        async loadContextSource() {
          return buildSource(extraEvents);
        },
        async saveCompiledContext(input) {
          saved = input;
          return {
            degradedReason: input.degradedReason,
            dialogueRevision: input.dialogueRevision,
            id: asCompiledContextId(`${U}000000000065`),
            locale: input.locale,
            referencedRevisionIds: input.referencedEvents.map(
              (event) => event.revisionId,
            ),
            sourceRevision: input.sourceRevision,
            statistics: {
              rawEventBudgetTokens: input.sectionBudgets.committedRawEvents,
              selectedEventCount: input.referencedEvents.length,
              totalTokens: input.totalTokens,
            },
          };
        },
      },
    });
    return { compiler, saved: () => saved };
  }

  it("freezes recent refs with cross-session metadata and replays them first", async () => {
    const { compiler, saved } = createCompilerWithRecent([
      item({
        dailySessionId: earlierSessionId,
        expressedAt: "2026-08-12T18:00:00.000Z",
        occurredAt: "2026-08-12T18:00:00.000Z",
        revisionId: 0x601,
        sequence: 4,
        text: "yesterday",
      }),
    ]);
    await compiler.compile({ generationCommandId, interactionTurnId, userId });
    const manifest = saved();
    if (!manifest) throw new Error("The test manifest was not captured.");

    const recentRefs = manifest.referencedEvents.filter(
      (event) => event.section === RECENT_CONTEXT_SECTION_KEY,
    );
    expect(recentRefs).toHaveLength(1);
    expect(recentRefs[0]).toMatchObject({
      dailySessionId: earlierSessionId,
      expressedAt: "2026-08-12T18:00:00.000Z",
      revisionId: recentRevisionId,
      selectionReason: "day_representation",
    });
    const section = manifest.sections.find(
      (candidate) => candidate.key === RECENT_CONTEXT_SECTION_KEY,
    );
    expect(section?.reference).toMatch(/^recent-context:/);

    const payload = compiler.renderPermittedPayload({
      ...manifest,
      generationStage: "decision",
    });
    expect(payload.messages.map((message) => message.revisionId)).toEqual([
      recentRevisionId,
      currentInputRevisionId,
    ]);
    expect(payload.instructions).not.toContain("yesterday");
  });

  it("excludes events committed after the admitted command cutoff", async () => {
    // The retry clock is a day later than the admitted command. An event that
    // committed in between must not enter the recent projection.
    const { compiler, saved } = createCompilerWithRecent(
      [
        item({
          dailySessionId: earlierSessionId,
          expressedAt: "2026-08-13T20:00:00.000Z",
          revisionId: 30,
          sequence: 4,
          text: "after the admitted command",
        }),
      ],
      [
        {
          actor: "user",
          locale: "en-US",
          revisionId: rev(0x602),
          sequence: 5,
          text: "intervening",
        },
      ],
    );
    await compiler.compile({ generationCommandId, interactionTurnId, userId });
    const manifest = saved();
    if (!manifest) throw new Error("The test manifest was not captured.");
    expect(
      manifest.referencedEvents.some(
        (event) => event.section === RECENT_CONTEXT_SECTION_KEY,
      ),
    ).toBe(false);
    const section = manifest.sections.find(
      (candidate) => candidate.key === RECENT_CONTEXT_SECTION_KEY,
    );
    const decoded = decodeRecentContextReference(section?.reference ?? "");
    expect(decoded.omitted).toContainEqual({
      controlId: null,
      reason: "after_cutoff",
      revisionId: String(rev(30)),
    });
  });

  it("fails the whole payload closed when the frozen reference is tampered", async () => {
    const { compiler, saved } = createCompilerWithRecent([
      item({
        dailySessionId: earlierSessionId,
        expressedAt: "2026-08-12T18:00:00.000Z",
        revisionId: 0x601,
        sequence: 4,
        text: "yesterday",
      }),
    ]);
    await compiler.compile({ generationCommandId, interactionTurnId, userId });
    const manifest = saved();
    if (!manifest) throw new Error("The test manifest was not captured.");

    const sections = manifest.sections.map((section) =>
      section.key === RECENT_CONTEXT_SECTION_KEY
        ? {
            ...section,
            reference: section.reference.replace(
              String(recentRevisionId),
              String(rev(0x699)),
            ),
          }
        : section,
    );
    expect(() =>
      compiler.renderPermittedPayload({
        ...manifest,
        generationStage: "decision",
        sections,
      }),
    ).toThrow(CompiledContextIntegrityError);
  });

  it("keeps the same-day compiler unchanged when no recent dependency is wired", async () => {
    let saved:
      | Parameters<ContextCompilerRepository["saveCompiledContext"]>[0]
      | undefined;
    const compiler = createContextCompiler({
      clock: () => commandCreatedAt,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "recent-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: {
        async loadContextSource() {
          return buildSource();
        },
        async saveCompiledContext(input) {
          saved = input;
          return {
            degradedReason: input.degradedReason,
            dialogueRevision: input.dialogueRevision,
            id: asCompiledContextId(`${U}000000000066`),
            locale: input.locale,
            referencedRevisionIds: input.referencedEvents.map(
              (event) => event.revisionId,
            ),
            sourceRevision: input.sourceRevision,
            statistics: {
              rawEventBudgetTokens: input.sectionBudgets.committedRawEvents,
              selectedEventCount: input.referencedEvents.length,
              totalTokens: input.totalTokens,
            },
          };
        },
      },
    });
    await compiler.compile({ generationCommandId, interactionTurnId, userId });
    expect(
      saved?.sections.some(
        (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
      ),
    ).toBe(false);
  });

  it("stamps the recent-aware version and accepts a genuine legacy replay (#294)", async () => {
    const recent = createCompilerWithRecent([]);
    await recent.compiler.compile({ generationCommandId, interactionTurnId, userId });
    const recentManifest = recent.saved();
    if (!recentManifest) throw new Error("The recent manifest was not captured.");
    expect(recentManifest.compilerVersion).toBe(
      RECENT_CONTEXT_COMPILER_VERSION,
    );

    let legacyManifest:
      | Parameters<ContextCompilerRepository["saveCompiledContext"]>[0]
      | undefined;
    const legacy = createContextCompiler({
      clock: () => commandCreatedAt,
      compilerVersion: LEGACY_CONTEXT_COMPILER_VERSION,
      contentHmacSecret: "recent-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: {
        async loadContextSource() {
          return buildSource();
        },
        async saveCompiledContext(input) {
          legacyManifest = input;
          return {
            degradedReason: input.degradedReason,
            dialogueRevision: input.dialogueRevision,
            id: asCompiledContextId(`${U}000000000067`),
            locale: input.locale,
            referencedRevisionIds: input.referencedEvents.map(
              (event) => event.revisionId,
            ),
            sourceRevision: input.sourceRevision,
            statistics: {
              rawEventBudgetTokens: input.sectionBudgets.committedRawEvents,
              selectedEventCount: input.referencedEvents.length,
              totalTokens: input.totalTokens,
            },
          };
        },
      },
    });
    await legacy.compile({ generationCommandId, interactionTurnId, userId });
    if (!legacyManifest) throw new Error("The legacy manifest was not captured.");
    expect(legacyManifest.compilerVersion).toBe(LEGACY_CONTEXT_COMPILER_VERSION);

    // A genuine legacy v1 manifest (no recent metadata) stays replayable.
    const payload = recent.compiler.renderPermittedPayload({
      ...legacyManifest,
      generationStage: "decision",
    });
    expect(payload.messages.map((message) => message.revisionId)).toEqual([
      currentInputRevisionId,
    ]);

    // The legacy compiler fails closed on the recent-aware manifest.
    expect(() =>
      legacy.renderPermittedPayload({
        ...recentManifest,
        generationStage: "decision",
      }),
    ).toThrow(CompiledContextIntegrityError);
  });
});

/**
 * Issue #296: the frozen seven-local-day window must stay correct when the UTC
 * offset changes inside the window. These tests use the real ICU zone data of
 * the pinned runtime (not a mock) with a fixed clock, so the cross-day matrix
 * genuinely covers a spring-forward gap and a DST-at-midnight zone.
 */
describe("recent-context window across DST transitions (#296)", () => {
  const HOUR_MS = 60 * 60 * 1_000;

  /**
   * Offset (local wall clock minus UTC) of `instant` in `timezone`, in ms.
   * Uses `Intl` only, so it is independent of the process timezone.
   */
  function zoneOffsetMs(instant: Date, timezone: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      year: "numeric",
    }).formatToParts(instant);
    const value = (type: string) =>
      parts.find((part) => part.type === type)?.value ?? "";
    const hour = value("hour") === "24" ? "00" : value("hour");
    const wallClockAsUtc = Date.UTC(
      Number(value("year")),
      Number(value("month")) - 1,
      Number(value("day")),
      Number(hour),
      Number(value("minute")),
      Number(value("second")),
    );
    return wallClockAsUtc - instant.getTime();
  }

  function wallClockAsUtc(instant: Date, timezone: string): number {
    return instant.getTime() + zoneOffsetMs(instant, timezone);
  }

  /**
   * The UTC instant of local midnight for `localDate`, matching PostgreSQL's
   * `timestamp AT TIME ZONE` semantics: the normal offset is used, and when the
   * local midnight falls in a spring-forward gap the offset in effect
   * immediately before the gap is used instead (the instant after the skipped
   * hour).
   */
  function localMidnightInstant(localDate: string, timezone: string): Date {
    const [year, month, day] = localDate.split("-").map(Number);
    const wallMidnightAsUtc = Date.UTC(year!, month! - 1, day!);
    for (const probe of [
      wallMidnightAsUtc - 24 * HOUR_MS,
      wallMidnightAsUtc,
      wallMidnightAsUtc + 24 * HOUR_MS,
    ]) {
      const offset = zoneOffsetMs(new Date(probe), timezone);
      const candidate = new Date(wallMidnightAsUtc - offset);
      if (
        zoneOffsetMs(candidate, timezone) === offset &&
        wallClockAsUtc(candidate, timezone) === wallMidnightAsUtc
      ) {
        return candidate;
      }
    }
    const offsetBeforeGap = zoneOffsetMs(
      new Date(wallMidnightAsUtc - 60_000),
      timezone,
    );
    return new Date(wallMidnightAsUtc - offsetBeforeGap);
  }

  function localDatesInWindow(windowStart: string, windowEnd: string): string[] {
    const dates: string[] = [];
    for (
      let date = windowStart;
      date <= windowEnd;
      date = shiftLocalDate(date, 1)
    ) {
      dates.push(date);
    }
    return dates;
  }

  /**
   * Asserts the window enumerates exactly seven distinct local dates and that
   * every day's UTC midnight boundary maps back to that same local date while
   * one millisecond earlier still maps to the previous date, so no local day is
   * dropped or duplicated across the offset change.
   */
  function expectUnbrokenDayBoundaries(
    windowStart: string,
    windowEnd: string,
    timezone: string,
  ): void {
    const dates = localDatesInWindow(windowStart, windowEnd);
    expect(dates).toHaveLength(7);
    expect(new Set(dates).size).toBe(7);
    for (const date of dates) {
      const start = localMidnightInstant(date, timezone);
      expect(localDateOf(start, timezone)).toBe(date);
      expect(localDateOf(new Date(start.getTime() - 1), timezone)).toBe(
        shiftLocalDate(date, -1),
      );
    }
    const exclusiveEnd = localMidnightInstant(
      shiftLocalDate(windowEnd, 1),
      timezone,
    );
    expect(localDateOf(new Date(exclusiveEnd.getTime() - 1), timezone)).toBe(
      windowEnd,
    );
    expect(localDateOf(exclusiveEnd, timezone)).toBe(
      shiftLocalDate(windowEnd, 1),
    );
  }

  it("freezes seven local dates across the 2026-03-08 spring-forward", () => {
    const frozenAt = new Date("2026-03-10T18:00:00.000Z");
    const window = resolveRecentContextWindow({
      frozenAt,
      timezone: TZ,
      windowDays: 7,
    });
    expect(window).toEqual({
      windowEndLocalDate: "2026-03-10",
      windowStartLocalDate: "2026-03-04",
    });
    expect(
      localDatesInWindow(
        window.windowStartLocalDate,
        window.windowEndLocalDate,
      ),
    ).toEqual([
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);

    // The window start is still PST (UTC-8); the window end is PDT (UTC-7);
    // the exclusive end is the start of the next local day.
    expect(localMidnightInstant("2026-03-04", TZ).toISOString()).toBe(
      "2026-03-04T08:00:00.000Z",
    );
    expect(localMidnightInstant("2026-03-10", TZ).toISOString()).toBe(
      "2026-03-10T07:00:00.000Z",
    );
    expect(localMidnightInstant("2026-03-11", TZ).toISOString()).toBe(
      "2026-03-11T07:00:00.000Z",
    );
    // 2026-03-08 is the 23-hour spring-forward day.
    expect(
      localMidnightInstant("2026-03-09", TZ).getTime() -
        localMidnightInstant("2026-03-08", TZ).getTime(),
    ).toBe(23 * HOUR_MS);

    expectUnbrokenDayBoundaries(
      window.windowStartLocalDate,
      window.windowEndLocalDate,
      TZ,
    );
  });

  it("keeps every local day across the 2026-09-06 Santiago midnight spring-forward", () => {
    const timezone = "America/Santiago";
    const frozenAt = new Date("2026-09-08T18:00:00.000Z");
    const window = resolveRecentContextWindow({
      frozenAt,
      timezone,
      windowDays: 7,
    });
    expect(window).toEqual({
      windowEndLocalDate: "2026-09-08",
      windowStartLocalDate: "2026-09-02",
    });

    // This zone skips local midnight itself: 2026-09-06T00:00 local does not
    // exist, and PostgreSQL resolves it to 04:00Z (offset before the gap).
    expect(localMidnightInstant("2026-09-02", timezone).toISOString()).toBe(
      "2026-09-02T04:00:00.000Z",
    );
    expect(localMidnightInstant("2026-09-06", timezone).toISOString()).toBe(
      "2026-09-06T04:00:00.000Z",
    );
    expect(localMidnightInstant("2026-09-09", timezone).toISOString()).toBe(
      "2026-09-09T03:00:00.000Z",
    );
    // 2026-09-06 is the 23-hour spring-forward day.
    expect(
      localMidnightInstant("2026-09-07", timezone).getTime() -
        localMidnightInstant("2026-09-06", timezone).getTime(),
    ).toBe(23 * HOUR_MS);

    expectUnbrokenDayBoundaries(
      window.windowStartLocalDate,
      window.windowEndLocalDate,
      timezone,
    );
  });
});
