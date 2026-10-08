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
  type ContextCompilerRepository,
  type ContextPolicyVersions,
  type ContextSourceSnapshot,
} from "./context-compiler";
import {
  decodeRecentContextReference,
  encodeRecentContextReference,
  RECENT_CONTEXT_REFERENCE_VERSION,
  RECENT_CONTEXT_SECTION_KEY,
  RECENT_CONTEXT_SELECTION_POLICY_VERSION,
  RecentContextReferenceError,
  resolveRecentContextWindow,
  selectRecentContext,
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
          revisionId: 6,
          sequence: 1,
          text: "An unrelated earlier exchange",
        }),
        item({
          dailySessionId: session,
          exclusion: { controlId: "forget-1", reason: "forget_association" },
          expressedAt: "2026-10-07T12:01:00.000Z",
          revisionId: 7,
          sequence: 2,
          text: "This is the forgotten source",
        }),
        item({
          actor: "assistant",
          dailySessionId: session,
          expressedAt: "2026-10-07T12:02:00.000Z",
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
    const selection = selectRecentContext({
      frozenAt: new Date("2026-08-13T19:00:00.000Z"),
      items: [
        item({
          dailySessionId: session,
          expressedAt: "2026-08-12T10:00:00.000Z",
          revisionId: 10,
          sequence: 1,
          text: "x".repeat(2_000),
        }),
        item({
          actor: "assistant",
          dailySessionId: session,
          expressedAt: "2026-08-12T10:01:00.000Z",
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

  it("orders identical instants by sequence within a session and identity across sessions", () => {
    const sessionA = asDailySessionId(`${U}000000000040`);
    const sessionB = asDailySessionId(`${U}000000000041`);
    const sameInstant = "2026-08-13T18:00:00.000Z";
    const selection = selectRecentContext({
      frozenAt: new Date("2026-08-13T19:00:00.000Z"),
      items: [
        item({
          actor: "assistant",
          dailySessionId: sessionA,
          expressedAt: sameInstant,
          revisionId: 14,
          sequence: 2,
          text: "assistant reply",
        }),
        item({
          dailySessionId: sessionA,
          expressedAt: sameInstant,
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
});
