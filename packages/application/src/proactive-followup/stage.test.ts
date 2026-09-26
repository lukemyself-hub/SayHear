import { describe, expect, it, vi } from "vitest";

import {
  asCompiledContextId,
  asConversationEventRevisionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asUserId,
} from "@sayhear/domain";

import { ProviderDispatchError } from "../conversation-model";
import {
  createProactiveFollowupSegmentStage,
  InvalidProactiveFollowupSegmentError,
  type ProactiveFollowupStageReaders,
  type ProactiveFollowupReservationStore,
  type ProactiveFollowupTurnContext,
} from "./stage";
import { validateProactiveFollowupSegmentOutput } from "./segment";
import type {
  ProactiveFollowupDialogueSnapshot,
  ProactiveFollowupLaneSnapshot,
} from "./types";

const USER = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");
const REVISION = "01984477-2f9a-7b25-a5cc-83c3b21fbc68";
const MAIN_COMMAND = asGenerationCommandId(
  "01984477-3f9a-7b25-a5cc-83c3b21fbc68",
);
const SEGMENT_COMMAND = asGenerationCommandId(
  "01984477-4f9a-7b25-a5cc-83c3b21fbc68",
);
const SEGMENT_ATTEMPT = asModelRunAttemptId(
  "01984477-5f9a-7b25-a5cc-83c3b21fbc68",
);

function turnContext(): ProactiveFollowupTurnContext {
  return {
    dailySessionId: "session-1",
    continuousExchangeNo: 2,
    currentUserEventSequence: 5,
    currentSourceRevision: 1,
    dialogueRevision: 0,
    expectedDataEpoch: 7,
    timeZone: "Asia/Shanghai",
    interactionTurnId: "turn-1",
    locale: "en-US",
  };
}

function dialogue(): ProactiveFollowupDialogueSnapshot {
  return {
    status: "current",
    coveredThroughSequence: 5,
    currentEventSequence: 5,
    currentEventRevisionId: REVISION,
    currentRequestRequiresFocus: {
      value: false,
      confidence: 0.9,
      sourceRevisionIds: [REVISION],
    },
    proactiveFollowupOpportunity: {
      value: "natural_gap",
      confidence: 0.9,
      sourceRevisionIds: [REVISION],
    },
  };
}

function openLane(): ProactiveFollowupLaneSnapshot {
  return {
    name: "open_loop",
    enabled: true,
    status: "complete",
    watermark: { sourceRevision: 1, coveredThroughSequence: 5 },
    manifestVersion: "open-loop-read:v2",
    integrity: "valid",
    candidates: [
      {
        targetKind: "open_loop",
        targetId: "loop-1",
        targetVersionId: "loop-version-1",
        source: "open_loop",
        sourceRank: null,
        sourceEventRevisionId: "source-event-revision-1",
        evidenceAt: "2026-09-10T00:00:00.000Z",
        expectedStartAt: "2026-09-20T00:00:00.000Z",
        expiresAt: "2026-09-27T00:00:00.000Z",
        sensitive: false,
        lastUsedAt: null,
        current: true,
        eligible: true,
        trustFence: "valid",
        mentionedInExchange: false,
        formedInCurrentTurn: false,
      },
    ],
  };
}

function memoryLane(
  overrides: Partial<ProactiveFollowupLaneSnapshot> = {},
): ProactiveFollowupLaneSnapshot {
  return {
    name: "memory",
    enabled: true,
    status: "complete",
    watermark: { sourceRevision: 1, coveredThroughSequence: 5 },
    manifestVersion: "memory-retrieval:v1",
    integrity: "valid",
    candidates: [
      {
        targetKind: "memory_claim",
        targetId: "claim-1",
        targetVersionId: "claim-version-1",
        source: "query_retrieval",
        sourceRank: 1,
        evidenceAt: "2026-09-12T00:00:00.000Z",
        sensitive: false,
        lastUsedAt: null,
        current: true,
        eligible: true,
        trustFence: "valid",
        mentionedInExchange: false,
        formedInCurrentTurn: false,
      },
    ],
    ...overrides,
  };
}

function readers(
  overrides: Partial<ProactiveFollowupStageReaders> = {},
): ProactiveFollowupStageReaders {
  return {
    readTurnContext: async () => turnContext(),
    readDialogue: async () => dialogue(),
    readOpenLane: async () => openLane(),
    readStates: async () => [],
    readEventRevisionText: async () => ({ text: "user text" }),
    readOpenLoopSourceEvidence: async () => ({
      eventRevisionId: "source-event-revision-1",
      revision: 1,
      text: "I am waiting to hear whether the lease renewal was approved.",
    }),
    listUsesAwaitingDisposition: async () => [],
    readTargetSummary: async () => "Flight to Berlin next Friday",
    ...overrides,
  };
}

function reservations(
  overrides: Partial<ProactiveFollowupReservationStore> = {},
): ProactiveFollowupReservationStore {
  return {
    reserveSelection: vi.fn(async () => ({
      outcome: "reserved" as const,
      reservationId: "reservation-1",
      targetKind: "open_loop" as const,
      targetId: "loop-1",
      targetVersionId: "loop-version-1",
    })),
    bindSegmentCommand: async () => ({ outcome: "bound" }),
    abandonSegment: async () => {},
    releaseOmittedSegment: async () => ({ outcome: "released" as const }),
    recordDisposition: async () => ({ outcome: "recorded", stateVersionId: null }),
    ...overrides,
  };
}

const configuration = {
  role: "proactive.followup",
  configVersion: "proactive:config:v1",
  provider: "deepseek",
  model: "synthetic-model",
  modelSnapshot: "synthetic-model@2026-09-15",
  promptVersion: "proactive-prompt:v1",
  schemaVersion: "proactive-schema:v1",
  rolePolicyVersion: "1a3b-model-role-policy:v1",
  providerPolicyVersion: "proactive-egress:v1",
  rolloutPin: "proactive-rollout:v1",
  freshnessPolicy: "exact_head:v1",
  fallbackMode: "disabled",
  maxTechnicalRetries: 0,
  maxSemanticRepairs: 0,
  parameterSnapshot: {},
} as const;

function commandService(
  overrides: Record<string, unknown> = {},
): {
  admit: ReturnType<typeof vi.fn>;
  configuration: ReturnType<typeof vi.fn>;
  discardAttempt: ReturnType<typeof vi.fn>;
  recordAttemptResult: ReturnType<typeof vi.fn>;
} {
  return {
    admit: vi.fn(async () => ({
      outcome: "created",
      generationCommandId: SEGMENT_COMMAND,
      modelRunAttemptId: SEGMENT_ATTEMPT,
      workflowCommandId: null,
      attemptNo: 1,
      attemptKind: "initial",
      intentKey: "intent",
    })),
    configuration: vi.fn(() => configuration),
    discardAttempt: vi.fn(async () => ({ outcome: "discarded" })),
    recordAttemptResult: vi.fn(async () => ({ outcome: "completed" })),
    ...overrides,
  };
}

function egress() {
  return {
    dispatch: vi.fn(async <T>(input: { execute: () => Promise<T> }) =>
      input.execute(),
    ),
  };
}

function provider(
  overrides: Record<string, unknown> = {},
): {
  role: "proactive.followup";
  generateSegment: ReturnType<typeof vi.fn>;
  classifyDisposition: ReturnType<typeof vi.fn>;
} {
  return {
    role: "proactive.followup",
    generateSegment: vi.fn(async (request: {
      targetId: string;
      targetKind: "open_loop" | "memory_claim";
      targetVersionId: string;
    }) => ({
      decision: "emit" as const,
      content: "How did the Berlin flight go?",
      expressionKind: "question" as const,
      targetRef: {
        targetId: request.targetId,
        targetKind: request.targetKind,
        targetVersionId: request.targetVersionId,
      },
    })),
    classifyDisposition: vi.fn(async () => ({
      signal: "short_response",
      finalTextLocator: {
        kind: "assistant_event_revision",
        assistantEventRevisionId: "assistant-revision-1",
        segment: "proactive_followup",
        ordinal: 0,
      },
    })),
    ...overrides,
  };
}

function compiler() {
  return {
    compileSegmentContext: vi.fn(async () =>
      asCompiledContextId("01984477-6f9a-7b25-a5cc-83c3b21fbc68"),
    ),
  };
}

function prepareInput() {
  return {
    interactionTurnId: asInteractionTurnId(
      "01984477-0f9a-7b25-a5cc-83c3b21fbc68",
    ),
    mainGenerationCommandId: MAIN_COMMAND,
    mainText: "That sounds like a full week already.",
    now: new Date("2026-09-15T10:00:00.000Z"),
    ordinaryQuestionAlreadyAsked: false,
    requestEventRevisionId: asConversationEventRevisionId(REVISION),
    userId: USER,
  };
}

function stage(overrides: {
  readerOverrides?: Partial<ProactiveFollowupStageReaders>;
  reservationOverrides?: Partial<ProactiveFollowupReservationStore>;
  commandOverrides?: Record<string, unknown>;
  providerOverrides?: Record<string, unknown>;
}) {
  const commands = commandService(overrides.commandOverrides);
  const egressPort = egress();
  const modelProvider = provider(overrides.providerOverrides);
  const compilerPort = compiler();
  const reservationStore = reservations(overrides.reservationOverrides);
  const readerPorts = readers(overrides.readerOverrides);
  const segmentStage = createProactiveFollowupSegmentStage({
    clock: () => new Date("2026-09-15T10:00:00.000Z"),
    modelRoleCommandService:
      commands as unknown as Parameters<
        typeof createProactiveFollowupSegmentStage
      >[0]["modelRoleCommandService"],
    providerEgress:
      egressPort as unknown as Parameters<
        typeof createProactiveFollowupSegmentStage
      >[0]["providerEgress"],
    provider:
      modelProvider as unknown as Parameters<
        typeof createProactiveFollowupSegmentStage
      >[0]["provider"],
    readers: readerPorts,
    reservations: reservationStore,
    compiler:
      compilerPort as unknown as Parameters<
        typeof createProactiveFollowupSegmentStage
      >[0]["compiler"],
  });
  return { segmentStage, commands, egressPort, modelProvider, compilerPort, reservationStore };
}

describe("proactive.followup segment stage (issue #207 layer 2c)", () => {
  it("prepares a plan and generates the isolated segment", async () => {
    const { segmentStage, modelProvider } = stage({});

    const plan = await segmentStage.prepare(prepareInput());
    expect(plan).not.toBeNull();
    expect(plan?.targetId).toBe("loop-1");
    expect(plan?.reservationId).toBe("reservation-1");
    expect(plan?.segmentGenerationCommandId).toBe(SEGMENT_COMMAND);

    const generation = await segmentStage.generate(plan!);
    expect(generation.outcome).toBe("emit");
    if (generation.outcome !== "emit") throw new Error("expected emit");
    expect(generation.output.expressionKind).toBe("question");
    expect(generation.output.targetRef.targetId).toBe("loop-1");
    expect(generation.metadata.modelSnapshot).toBe(
      "synthetic-model@2026-09-15",
    );
    expect(modelProvider.generateSegment).toHaveBeenCalledTimes(1);
    expect(modelProvider.generateSegment.mock.calls[0]?.[0]).toMatchObject({
      mainText: "That sounds like a full week already.",
      targetSummary: "Flight to Berlin next Friday",
      sourceUserText:
        "I am waiting to hear whether the lease renewal was approved.",
    });
  });

  it.each(["current_topic", "direct_task", "urgent_or_high_risk"] as const)(
    "does not call the expression provider for %s",
    async (opportunity) => {
      const { segmentStage, modelProvider, commands, reservationStore } = stage({
        readerOverrides: {
          readDialogue: async () => ({
            ...dialogue(),
            proactiveFollowupOpportunity: {
              value: opportunity,
              confidence: 0.95,
              sourceRevisionIds: [REVISION],
            },
          }),
        },
      });

      await expect(segmentStage.prepare(prepareInput())).resolves.toBeNull();
      expect(commands.admit).not.toHaveBeenCalled();
      expect(reservationStore.reserveSelection).not.toHaveBeenCalled();
      expect(modelProvider.generateSegment).not.toHaveBeenCalled();
    },
  );

  it("fails closed when opportunity evidence is stale or below the confidence floor", async () => {
    for (const opportunity of [
      {
        value: "greeting" as const,
        confidence: 0.69,
        sourceRevisionIds: [REVISION],
      },
      {
        value: "greeting" as const,
        confidence: 0.99,
        sourceRevisionIds: ["another-event-revision"],
      },
    ]) {
      const { segmentStage, commands, modelProvider } = stage({
        readerOverrides: {
          readDialogue: async () => ({
            ...dialogue(),
            proactiveFollowupOpportunity: opportunity,
          }),
        },
      });

      await expect(segmentStage.prepare(prepareInput())).resolves.toBeNull();
      expect(commands.admit).not.toHaveBeenCalled();
      expect(modelProvider.generateSegment).not.toHaveBeenCalled();
    }
  });

  it("settles a grounded omit without consuming or abandoning the selection", async () => {
    const releaseOmittedSegment = vi.fn(async () => ({
      outcome: "released" as const,
    }));
    const abandonSegment = vi.fn(async () => {});
    const { segmentStage, commands, modelProvider } = stage({
      providerOverrides: {
        generateSegment: vi.fn(async (request: {
          targetId: string;
          targetKind: "open_loop" | "memory_claim";
          targetVersionId: string;
        }) => ({
          decision: "omit" as const,
          reason: "duplicates_main_response" as const,
          targetRef: {
            targetId: request.targetId,
            targetKind: request.targetKind,
            targetVersionId: request.targetVersionId,
          },
        })),
      },
      reservationOverrides: { abandonSegment, releaseOmittedSegment },
    });

    const plan = await segmentStage.prepare(prepareInput());
    const generation = await segmentStage.generate(plan!);

    expect(generation).toEqual({
      outcome: "omit",
      reason: "duplicates_main_response",
    });
    expect(commands.recordAttemptResult).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "succeeded" }),
    );
    expect(releaseOmittedSegment).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation-1" }),
    );
    expect(abandonSegment).not.toHaveBeenCalled();
    expect(modelProvider.generateSegment).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTime: "2026-09-15T10:00:00.000Z",
        currentUserText: "user text",
        sessionTimeZone: "Asia/Shanghai",
      }),
    );
  });

  it.each([
    {
      locale: "en-US", userText: "Hi, I have a moment.", mainText: "Good to see you.",
      decision: "emit" as const, content: "Did you hear about the lease renewal?",
    },
    {
      locale: "zh-CN", userText: "让我安静一会儿。", mainText: "好，先歇一会儿。",
      decision: "omit" as const, reason: "timing_not_natural" as const,
    },
    {
      locale: "en-US", userText: "Hi, 今天想安静一下。", mainText: "Take your time.",
      decision: "omit" as const, reason: "timing_not_natural" as const,
    },
    {
      locale: "zh-CN", userText: "你好。", mainText: "你提过租约续签，后来批下来了吗？",
      decision: "omit" as const, reason: "duplicates_main_response" as const,
    },
  ])("passes the frozen $locale turn and selected Evidence through typed $decision", async (scenario) => {
    const releaseOmittedSegment = vi.fn(async () => ({ outcome: "released" as const }));
    const { segmentStage, modelProvider } = stage({
      readerOverrides: {
        readTurnContext: async () => ({ ...turnContext(), locale: scenario.locale }),
        readEventRevisionText: async () => ({ text: scenario.userText }),
      },
      reservationOverrides: { releaseOmittedSegment },
      providerOverrides: {
        generateSegment: vi.fn(async (request: { targetRef: { targetKind: "open_loop"; targetId: string; targetVersionId: string } }) =>
          scenario.decision === "emit"
            ? { decision: "emit" as const, content: scenario.content, expressionKind: "question" as const, targetRef: request.targetRef }
            : { decision: "omit" as const, reason: scenario.reason, targetRef: request.targetRef }),
      },
    });
    const plan = await segmentStage.prepare({ ...prepareInput(), mainText: scenario.mainText });
    expect(plan).not.toBeNull();
    const result = await segmentStage.generate(plan!);
    expect(modelProvider.generateSegment).toHaveBeenCalledWith(expect.objectContaining({
      currentUserText: scenario.userText,
      mainText: scenario.mainText,
      sourceUserText: "I am waiting to hear whether the lease renewal was approved.",
      targetRef: { targetKind: "open_loop", targetId: "loop-1", targetVersionId: "loop-version-1" },
    }));
    expect(result.outcome).toBe(scenario.decision);
    if (result.outcome === "emit") {
      expect(validateProactiveFollowupSegmentOutput({ mainText: scenario.mainText, output: result.output, plan: plan! }))
        .toEqual({ outcome: "valid" });
      expect(releaseOmittedSegment).not.toHaveBeenCalled();
    } else {
      expect(releaseOmittedSegment).toHaveBeenCalledTimes(1);
    }
  });

  it("returns null without admitting a command when the lane is closed", async () => {
    const { segmentStage, commands } = stage({
      commandOverrides: { configuration: vi.fn(() => null) },
    });

    await expect(segmentStage.prepare(prepareInput())).resolves.toBeNull();
    expect(commands.admit).not.toHaveBeenCalled();
  });

  it("returns null when an ordinary question already covers the response", async () => {
    const { segmentStage, commands } = stage({});

    await expect(
      segmentStage.prepare({ ...prepareInput(), ordinaryQuestionAlreadyAsked: true }),
    ).resolves.toBeNull();
    expect(commands.admit).not.toHaveBeenCalled();
  });

  it("discards the admitted command when the exchange is already reserved", async () => {
    const { segmentStage, commands } = stage({
      reservationOverrides: {
        reserveSelection: async () => ({
          outcome: "fenced",
          reason: "exchange_already_reserved",
        }),
      },
    });

    await expect(segmentStage.prepare(prepareInput())).resolves.toBeNull();
    expect(commands.admit).toHaveBeenCalledTimes(1);
    expect(commands.discardAttempt).toHaveBeenCalledTimes(1);
  });

  it("rejects provider output that breaks the frozen expression schema", async () => {
    const { segmentStage } = stage({
      providerOverrides: {
        generateSegment: vi.fn(async () => ({
          decision: "emit",
          content: "",
          expressionKind: "question",
          targetRef: {
            targetId: "loop-1",
            targetKind: "open_loop",
            targetVersionId: "loop-version-1",
          },
        })),
      },
    });

    const plan = await segmentStage.prepare(prepareInput());
    await expect(segmentStage.generate(plan!)).rejects.toBeInstanceOf(
      InvalidProactiveFollowupSegmentError,
    );
  });

  it("abandons the reservation and discards the command", async () => {
    const abandoned: string[] = [];
    const { segmentStage, commands } = stage({
      reservationOverrides: {
        abandonSegment: async (input: { reservationId: string }) => {
          abandoned.push(input.reservationId);
        },
      },
    });

    const plan = await segmentStage.prepare(prepareInput());
    await segmentStage.abandon(plan!, "generation_failed");

    expect(abandoned).toEqual(["reservation-1"]);
    expect(commands.discardAttempt).toHaveBeenCalledTimes(1);
    // A lost frozen input fails closed instead of reusing stale text.
    await expect(segmentStage.generate(plan!)).rejects.toBeInstanceOf(
      InvalidProactiveFollowupSegmentError,
    );
  });

  it("settles the pending disposition before selecting, without blocking on egress fences", async () => {
    const recordDisposition = vi.fn(
      async (_input: unknown) =>
        ({ outcome: "recorded" as const, stateVersionId: null }),
    );
    const { segmentStage, modelProvider } = stage({
      readerOverrides: {
        listUsesAwaitingDisposition: async () => [
          {
            useId: "use-1",
            assistantEventRevisionId: "assistant-revision-1",
            targetKind: "open_loop" as const,
            targetId: "loop-1",
            targetVersionId: "loop-version-1",
            promptUserEventSequence: 3,
            promptDailySessionId: "session-1",
          },
        ],
      },
      reservationOverrides: { recordDisposition },
    });

    const plan = await segmentStage.prepare(prepareInput());
    expect(plan).not.toBeNull();
    expect(modelProvider.classifyDisposition).toHaveBeenCalledTimes(1);
    expect(recordDisposition).toHaveBeenCalledTimes(1);
    const recorded = recordDisposition.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(recorded).toMatchObject({
      useId: "use-1",
      signal: "short_response",
      triggerUserEventSequence: 5,
    });
  });

  it("selects an eligible Memory Claim from the wired memory lane", async () => {
    const reserveSelection = vi.fn(async (reserveInput: {
      target: {
        targetKind: string;
        targetId: string;
        targetVersionId: string;
      };
    }) => ({
      outcome: "reserved" as const,
      reservationId: "reservation-memory",
      targetKind: reserveInput.target.targetKind as "memory_claim",
      targetId: reserveInput.target.targetId,
      targetVersionId: reserveInput.target.targetVersionId,
    }));
    const { segmentStage } = stage({
      readerOverrides: {
        readMemoryLane: async () => memoryLane(),
      },
      reservationOverrides: { reserveSelection },
    });

    const plan = await segmentStage.prepare(prepareInput());
    expect(plan).not.toBeNull();
    expect(plan?.targetKind).toBe("memory_claim");
    expect(plan?.targetId).toBe("claim-1");
    expect(plan?.reservationId).toBe("reservation-memory");
    expect(reserveSelection).toHaveBeenCalledTimes(1);
    const reserved = reserveSelection.mock.calls[0]?.[0];
    expect(reserved).toMatchObject({
      target: {
        targetKind: "memory_claim",
        targetId: "claim-1",
        targetVersionId: "claim-version-1",
      },
    });
  });

  it("fails closed when the memory lane is incomplete", async () => {
    const reserveSelection = vi.fn();
    const { segmentStage } = stage({
      readerOverrides: {
        readMemoryLane: async () =>
          memoryLane({ status: "incomplete", watermark: null }),
      },
      reservationOverrides: { reserveSelection },
    });

    await expect(segmentStage.prepare(prepareInput())).resolves.toBeNull();
    expect(reserveSelection).not.toHaveBeenCalled();
  });

  it("fails closed when the memory lane watermark trails the current turn", async () => {
    const { segmentStage } = stage({
      readerOverrides: {
        readMemoryLane: async () =>
          memoryLane({
            watermark: { sourceRevision: 1, coveredThroughSequence: 4 },
          }),
      },
    });

    await expect(segmentStage.prepare(prepareInput())).resolves.toBeNull();
  });

  it("still selects when disposition dispatch is fenced", async () => {
    const fenced = createProactiveFollowupSegmentStage({
      clock: () => new Date("2026-09-15T10:00:00.000Z"),
      modelRoleCommandService: commandService() as never,
      providerEgress: {
        dispatch: vi.fn(async () => {
          throw new ProviderDispatchError("policy_blocked", "fenced", false);
        }),
      } as never,
      provider: provider() as never,
      readers: readers({
        listUsesAwaitingDisposition: async () => [
          {
            useId: "use-1",
            assistantEventRevisionId: "assistant-revision-1",
            targetKind: "open_loop" as const,
            targetId: "loop-1",
            targetVersionId: "loop-version-1",
            promptUserEventSequence: 3,
            promptDailySessionId: "session-1",
          },
        ],
      }),
      reservations: reservations(),
      compiler: compiler() as never,
    });

    const plan = await fenced.prepare(prepareInput());
    expect(plan).not.toBeNull();
  });

  it("records a failed attempt when disposition classification is invalid", async () => {
    const recordAttemptResult = vi.fn(async (_input: unknown) => ({
      outcome: "completed",
    }));
    const fenced = createProactiveFollowupSegmentStage({
      clock: () => new Date("2026-09-15T10:00:00.000Z"),
      modelRoleCommandService: commandService({
        recordAttemptResult,
      }) as never,
      providerEgress: egress() as never,
      provider: provider({
        classifyDisposition: vi.fn(async () => ({
          signal: "ambiguous_closure",
          finalTextLocator: {
            kind: "assistant_event_revision",
            assistantEventRevisionId: "assistant-revision-1",
            segment: "proactive_followup",
            ordinal: 0,
          },
        })),
      }) as never,
      readers: readers({
        listUsesAwaitingDisposition: async () => [
          {
            useId: "use-1",
            assistantEventRevisionId: "assistant-revision-1",
            targetKind: "open_loop" as const,
            targetId: "loop-1",
            targetVersionId: "loop-version-1",
            promptUserEventSequence: 3,
            promptDailySessionId: "session-1",
          },
        ],
      }),
      reservations: reservations(),
      compiler: compiler() as never,
    });

    const plan = await fenced.prepare(prepareInput());
    expect(plan).not.toBeNull();
    expect(recordAttemptResult).toHaveBeenCalledTimes(1);
    const recorded = recordAttemptResult.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(recorded).toMatchObject({
      outcome: "failed",
      failureCode: "schema_incompatible",
    });
  });
});
