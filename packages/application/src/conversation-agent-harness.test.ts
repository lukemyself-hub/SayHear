import { describe, expect, it, vi } from "vitest";

import {
  asCompiledContextId,
  asConversationEventId,
  asConversationEventRevisionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asUserId,
} from "@sayhear/domain";

import {
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
} from "./conversation-action-catalog";
import {
  createConversationAgentHarness,
  type ConversationAgentHarnessRepository,
  type ConversationHarnessEvent,
} from "./conversation-agent-harness";
import {
  ProviderDispatchError,
  type ProviderDispatchErrorCategory,
  type ProviderEgressPort,
} from "./conversation-model";
import type { CompleteResponseMetadata } from "./conversation-response";
import type {
  ProactiveFollowupSegmentPlan,
  ProactiveFollowupSegmentStage,
} from "./proactive-followup";

const userId = asUserId("01984477-1f9a-7d25-9d97-e588769566c0");
const interactionTurnId = asInteractionTurnId(
  "01984477-1f9a-7d25-9d97-e588769566c1",
);
const generationCommandId = asGenerationCommandId(
  "01984477-1f9a-7d25-9d97-e588769566c2",
);
const compiledContextId = asCompiledContextId(
  "01984477-1f9a-7d25-9d97-e588769566c3",
);
const modelRunAttemptId = asModelRunAttemptId(
  "01984477-1f9a-7d25-9d97-e588769566c4",
);
const assistantEventId = asConversationEventId(
  "01984477-1f9a-7d25-9d97-e588769566c5",
);
const assistantRevisionId = asConversationEventRevisionId(
  "01984477-1f9a-7d25-9d97-e588769566c6",
);
const requestEventRevisionId = asConversationEventRevisionId(
  "01984477-1f9a-7d25-9d97-e588769566c7",
);
const segmentGenerationCommandId = asGenerationCommandId(
  "01984477-1f9a-7d25-9d97-e588769566c8",
);
const segmentCompiledContextId = asCompiledContextId(
  "01984477-1f9a-7d25-9d97-e588769566c9",
);
const segmentModelRunAttemptId = asModelRunAttemptId(
  "01984477-1f9a-7d25-9d97-e588769566ca",
);

const fixedClock = () => new Date("2026-08-11T12:00:00.000Z");
const completedMetadata: CompleteResponseMetadata = {
  costMicros: 0,
  finishReason: "completed",
  inputTokens: 4,
  modelSnapshot: "gpt-5.4",
  outputTokens: 3,
  providerRequestId: "deterministic-request",
};

function baseCommand() {
  return {
    catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
    catalogVersion: EMPTY_CONVERSATION_ACTION_CATALOG.version,
    compiledContextId,
    generationCommandId,
    harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
    interactionTurnId,
    modelRunAttemptId,
    requestEventRevisionId,
    userId,
  };
}

function proactivePlan(): ProactiveFollowupSegmentPlan {
  return {
    expectedDataEpoch: 7,
    interactionTurnId,
    mainGenerationCommandId: generationCommandId,
    promptUserEventRevisionId: requestEventRevisionId,
    promptUserEventSequence: 12,
    policyBundle: { source: "test" },
    policyBundleVersion: "proactive-followup-policy-bundle:v3",
    promptPolicyVersion: "proactive-followup-prompt:v3",
    reservationId: "01984477-1f9a-7d25-9d97-e588769566cb",
    segmentCompiledContextId,
    segmentGenerationCommandId,
    segmentModelRunAttemptId,
    selectionPolicyVersion: "proactive-followup-selection:v1",
    targetId: "01984477-1f9a-7d25-9d97-e588769566cc",
    targetKind: "open_loop",
    targetVersionId: "01984477-1f9a-7d25-9d97-e588769566cd",
    userId,
  };
}

describe("Conversation Agent Harness — ordinary Decision (issue #24)", () => {
  it("streams the Final Response and commits exactly one Assistant Event", async () => {
    const egressPort: ProviderEgressPort = {
      async *stream() {
        yield { delta: "I hear you.", type: "delta" } as const;
        yield { ...completedMetadata, type: "completed" } as const;
      },
    };
    let commitCalls = 0;
    const repository: ConversationAgentHarnessRepository = {
      async claimResponseExecution() {
        return "owner";
      },
      async loadResponse() {
        throw new Error("unexpected loadResponse");
      },
      async commitCompleteResponse() {
        commitCalls += 1;
        return {
          eventId: assistantEventId,
          outcome: "committed",
          revisionId: assistantRevisionId,
        };
      },
      async settleResponseFailure() {
        throw new Error("unexpected settleResponseFailure");
      },
      async claimStaleResponseExecution() {
        throw new Error("unexpected claimStaleResponseExecution");
      },
    };
    const harness = createConversationAgentHarness({
      clock: fixedClock,
      egressPort,
      repository,
    });

    const events: ConversationHarnessEvent[] = [];
    for await (const event of harness.runDecision(baseCommand())) {
      events.push(event);
    }

    expect(events).toEqual([
      { delta: "I hear you.", type: "decision_delta" },
      {
        assistantEventId,
        assistantEventRevisionId: assistantRevisionId,
        type: "decision_committed",
      },
    ]);
    expect(commitCalls).toBe(1);
  });

  it("generates one hidden proactive segment after a statement and commits it with the main response", async () => {
    const egressPort: ProviderEgressPort = {
      async *stream() {
        yield { delta: "I hear you.", type: "delta" } as const;
        yield { ...completedMetadata, type: "completed" } as const;
      },
    };
    const plan = proactivePlan();
    const preparedInputs: string[] = [];
    let generated = 0;
    let committedSegment: unknown;
    const proactiveFollowupStage: ProactiveFollowupSegmentStage = {
      async prepare(input) {
        preparedInputs.push(input.mainText);
        return plan;
      },
      async generate() {
        generated += 1;
        return {
          outcome: "emit" as const,
          metadata: completedMetadata,
          output: {
            decision: "emit" as const,
            content: "I’m glad you shared that.",
            expressionKind: "acknowledgment" as const,
            targetRef: {
              targetId: plan.targetId,
              targetKind: plan.targetKind,
              targetVersionId: plan.targetVersionId,
            },
          },
        };
      },
      async abandon() {
        throw new Error("unexpected abandon");
      },
    };
    const repository: ConversationAgentHarnessRepository = {
      async claimResponseExecution() {
        return "owner";
      },
      async loadResponse() {
        throw new Error("unexpected loadResponse");
      },
      async commitCompleteResponse(input) {
        committedSegment = input.proactiveSegment;
        return {
          eventId: assistantEventId,
          outcome: "committed",
          revisionId: assistantRevisionId,
          segment: "committed" as const,
        };
      },
      async settleResponseFailure() {
        throw new Error("unexpected settleResponseFailure");
      },
      async claimStaleResponseExecution() {
        throw new Error("unexpected claimStaleResponseExecution");
      },
    };
    const harness = createConversationAgentHarness({
      clock: fixedClock,
      egressPort,
      proactiveFollowupStage,
      repository,
    });

    const events: ConversationHarnessEvent[] = [];
    for await (const event of harness.runDecision(baseCommand())) {
      events.push(event);
    }

    expect(preparedInputs).toEqual(["I hear you."]);
    expect(generated).toBe(1);
    expect(committedSegment).toEqual(
      expect.objectContaining({ plan, generation: expect.any(Object) }),
    );
    expect(events).toEqual([
      { delta: "I hear you.", type: "decision_delta" },
      { delta: "I’m glad you shared that.", type: "decision_segment_delta" },
      {
        assistantEventId,
        assistantEventRevisionId: assistantRevisionId,
        type: "decision_committed",
      },
    ]);
  });

  it("does not prepare a proactive segment when the main response already asks a question", async () => {
    const egressPort: ProviderEgressPort = {
      async *stream() {
        yield { delta: "What would help most?", type: "delta" } as const;
        yield { ...completedMetadata, type: "completed" } as const;
      },
    };
    let prepareCalls = 0;
    const proactiveFollowupStage: ProactiveFollowupSegmentStage = {
      async prepare() {
        prepareCalls += 1;
        throw new Error("must not prepare");
      },
      async generate() {
        throw new Error("must not generate");
      },
      async abandon() {
        throw new Error("must not abandon");
      },
    };
    const repository: ConversationAgentHarnessRepository = {
      async claimResponseExecution() {
        return "owner";
      },
      async loadResponse() {
        throw new Error("unexpected loadResponse");
      },
      async commitCompleteResponse() {
        return {
          eventId: assistantEventId,
          outcome: "committed",
          revisionId: assistantRevisionId,
        };
      },
      async settleResponseFailure() {
        throw new Error("unexpected settleResponseFailure");
      },
      async claimStaleResponseExecution() {
        throw new Error("unexpected claimStaleResponseExecution");
      },
    };
    const harness = createConversationAgentHarness({
      clock: fixedClock,
      egressPort,
      proactiveFollowupStage,
      repository,
    });

    const events = [] as ConversationHarnessEvent[];
    for await (const event of harness.runDecision(baseCommand())) {
      events.push(event);
    }

    expect(prepareCalls).toBe(0);
    expect(events.some((event) => event.type === "decision_segment_delta")).toBe(
      false,
    );
  });

  it("does not expose a segment unless the response transaction confirms it", async () => {
    const egressPort: ProviderEgressPort = {
      async *stream() {
        yield { delta: "I hear you.", type: "delta" } as const;
        yield { ...completedMetadata, type: "completed" } as const;
      },
    };
    const plan = proactivePlan();
    const proactiveFollowupStage: ProactiveFollowupSegmentStage = {
      async prepare() {
        return plan;
      },
      async generate() {
        return {
          outcome: "emit" as const,
          metadata: completedMetadata,
          output: {
            decision: "emit" as const,
            content: "I’m glad you shared that.",
            expressionKind: "acknowledgment" as const,
            targetRef: {
              targetId: plan.targetId,
              targetKind: plan.targetKind,
              targetVersionId: plan.targetVersionId,
            },
          },
        };
      },
      async abandon() {
        throw new Error("unexpected abandon");
      },
    };
    const repository: ConversationAgentHarnessRepository = {
      async claimResponseExecution() {
        return "owner";
      },
      async loadResponse() {
        throw new Error("unexpected loadResponse");
      },
      async commitCompleteResponse() {
        return {
          eventId: assistantEventId,
          outcome: "committed",
          revisionId: assistantRevisionId,
          // An omitted segment is a successful main-response commit, not a
          // permission to reveal the segment generated above.
          segment: "omitted" as const,
        };
      },
      async settleResponseFailure() {
        throw new Error("unexpected settleResponseFailure");
      },
      async claimStaleResponseExecution() {
        throw new Error("unexpected claimStaleResponseExecution");
      },
    };
    const harness = createConversationAgentHarness({
      clock: fixedClock,
      egressPort,
      proactiveFollowupStage,
      repository,
    });

    const events: ConversationHarnessEvent[] = [];
    for await (const event of harness.runDecision(baseCommand())) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "decision_segment_delta")).toBe(
      false,
    );
    expect(events.some((event) => event.type === "decision_committed")).toBe(
      true,
    );
  });

  it("commits only the main response when the segment stage chooses omit", async () => {
    const egressPort: ProviderEgressPort = {
      async *stream() {
        yield { delta: "I hear you.", type: "delta" } as const;
        yield { ...completedMetadata, type: "completed" } as const;
      },
    };
    const plan = proactivePlan();
    const abandon = vi.fn(async () => {});
    let committedSegment: unknown = "not-set";
    const proactiveFollowupStage: ProactiveFollowupSegmentStage = {
      async prepare() {
        return plan;
      },
      async generate() {
        return {
          outcome: "omit" as const,
          reason: "duplicates_main_response" as const,
        };
      },
      abandon,
    };
    const repository: ConversationAgentHarnessRepository = {
      async claimResponseExecution() {
        return "owner";
      },
      async loadResponse() {
        throw new Error("unexpected loadResponse");
      },
      async commitCompleteResponse(input) {
        committedSegment = input.proactiveSegment;
        return {
          eventId: assistantEventId,
          outcome: "committed",
          revisionId: assistantRevisionId,
        };
      },
      async settleResponseFailure() {
        throw new Error("unexpected settleResponseFailure");
      },
      async claimStaleResponseExecution() {
        throw new Error("unexpected claimStaleResponseExecution");
      },
    };
    const harness = createConversationAgentHarness({
      clock: fixedClock,
      egressPort,
      proactiveFollowupStage,
      repository,
    });

    const events: ConversationHarnessEvent[] = [];
    for await (const event of harness.runDecision(baseCommand())) events.push(event);

    expect(committedSegment).toBeUndefined();
    expect(abandon).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "decision_segment_delta")).toBe(
      false,
    );
    expect(events.some((event) => event.type === "decision_committed")).toBe(
      true,
    );
  });

  it("preserves the main response when segment validation fails and abandons once", async () => {
    const egressPort: ProviderEgressPort = {
      async *stream() {
        yield { delta: "I hear you.", type: "delta" } as const;
        yield { ...completedMetadata, type: "completed" } as const;
      },
    };
    const plan = proactivePlan();
    const abandoned: string[] = [];
    let committedSegment: unknown = "not-set";
    const proactiveFollowupStage: ProactiveFollowupSegmentStage = {
      async prepare() {
        return plan;
      },
      async generate() {
        return {
          outcome: "emit" as const,
          metadata: completedMetadata,
          output: {
            decision: "emit" as const,
            content: "This has the wrong target.",
            expressionKind: "acknowledgment" as const,
            targetRef: {
              targetId: "wrong-target",
              targetKind: plan.targetKind,
              targetVersionId: plan.targetVersionId,
            },
          },
        };
      },
      async abandon(_plan, reason) {
        abandoned.push(reason);
      },
    };
    const repository: ConversationAgentHarnessRepository = {
      async claimResponseExecution() {
        return "owner";
      },
      async loadResponse() {
        throw new Error("unexpected loadResponse");
      },
      async commitCompleteResponse(input) {
        committedSegment = input.proactiveSegment;
        return {
          eventId: assistantEventId,
          outcome: "committed",
          revisionId: assistantRevisionId,
        };
      },
      async settleResponseFailure() {
        throw new Error("unexpected settleResponseFailure");
      },
      async claimStaleResponseExecution() {
        throw new Error("unexpected claimStaleResponseExecution");
      },
    };
    const harness = createConversationAgentHarness({
      clock: fixedClock,
      egressPort,
      proactiveFollowupStage,
      repository,
    });

    const events: ConversationHarnessEvent[] = [];
    for await (const event of harness.runDecision(baseCommand())) {
      events.push(event);
    }

    expect(abandoned).toEqual(["invalid_output"]);
    expect(committedSegment).toBeUndefined();
    expect(events.some((event) => event.type === "decision_segment_delta")).toBe(
      false,
    );
    expect(events.some((event) => event.type === "decision_committed")).toBe(
      true,
    );
  });

  it("does not retry a failed segment and preserves the main response", async () => {
    const egressPort: ProviderEgressPort = {
      async *stream() {
        yield { delta: "I hear you.", type: "delta" } as const;
        yield { ...completedMetadata, type: "completed" } as const;
      },
    };
    const plan = proactivePlan();
    const abandoned: string[] = [];
    let generateCalls = 0;
    const proactiveFollowupStage: ProactiveFollowupSegmentStage = {
      async prepare() {
        return plan;
      },
      async generate() {
        generateCalls += 1;
        throw new Error("provider unavailable");
      },
      async abandon(_plan, reason) {
        abandoned.push(reason);
      },
    };
    const repository: ConversationAgentHarnessRepository = {
      async claimResponseExecution() {
        return "owner";
      },
      async loadResponse() {
        throw new Error("unexpected loadResponse");
      },
      async commitCompleteResponse(input) {
        expect(input.proactiveSegment).toBeUndefined();
        return {
          eventId: assistantEventId,
          outcome: "committed",
          revisionId: assistantRevisionId,
        };
      },
      async settleResponseFailure() {
        throw new Error("unexpected settleResponseFailure");
      },
      async claimStaleResponseExecution() {
        throw new Error("unexpected claimStaleResponseExecution");
      },
    };
    const harness = createConversationAgentHarness({
      clock: fixedClock,
      egressPort,
      proactiveFollowupStage,
      repository,
    });

    const events: ConversationHarnessEvent[] = [];
    for await (const event of harness.runDecision(baseCommand())) {
      events.push(event);
    }

    expect(generateCalls).toBe(1);
    expect(abandoned).toEqual(["generation_failed"]);
    expect(events.some((event) => event.type === "decision_committed")).toBe(
      true,
    );
  });

  it("fails closed with no Assistant Event when output is interrupted mid-stream", async () => {
    const egressPort: ProviderEgressPort = {
      async *stream() {
        yield { delta: "partial", type: "delta" } as const;
        throw new ProviderDispatchError("unavailable");
      },
    };
    let commitCalls = 0;
    let settledInterrupted: boolean | null = null;
    const repository: ConversationAgentHarnessRepository = {
      async claimResponseExecution() {
        return "owner";
      },
      async loadResponse() {
        throw new Error("unexpected loadResponse");
      },
      async commitCompleteResponse() {
        commitCalls += 1;
        return { outcome: "fence_rejected" };
      },
      async settleResponseFailure(input) {
        settledInterrupted = input.interrupted;
        return { category: input.category, outcome: "settled", status: "interrupted" };
      },
      async claimStaleResponseExecution() {
        throw new Error("unexpected claimStaleResponseExecution");
      },
    };
    const harness = createConversationAgentHarness({
      clock: fixedClock,
      egressPort,
      jitter: () => 0.5,
      repository,
    });

    const events: ConversationHarnessEvent[] = [];
    for await (const event of harness.runDecision(baseCommand())) {
      events.push(event);
    }

    expect(commitCalls).toBe(0);
    // The partial delta reached the stream before the interruption; the Turn
    // then fails as interrupted with no Assistant Event committed.
    expect(events).toEqual([
      { delta: "partial", type: "decision_delta" },
      { category: "unavailable", interrupted: true, type: "decision_failed" },
    ]);
    expect(settledInterrupted).toBe(true);
  });

  it("retries under the same Decision Command when no token may have been shown", async () => {
    let attempt = 0;
    const egressPort: ProviderEgressPort = {
      async *stream() {
        attempt += 1;
        if (attempt === 1) {
          // Fail before any delta — no token may have been shown.
          throw new ProviderDispatchError("rate_limited");
        }
        yield { delta: "Recovered.", type: "delta" } as const;
        yield { ...completedMetadata, type: "completed" } as const;
      },
    };
    const claimCalls: string[] = [];
    const repository: ConversationAgentHarnessRepository = {
      async claimResponseExecution() {
        return "owner";
      },
      async loadResponse() {
        throw new Error("unexpected loadResponse");
      },
      async commitCompleteResponse() {
        return {
          eventId: assistantEventId,
          outcome: "committed",
          revisionId: assistantRevisionId,
        };
      },
      async settleResponseFailure(input) {
        return {
          category: input.category,
          outcome: "retry_scheduled",
          retryAt: new Date("2026-08-11T12:00:01.000Z"),
        };
      },
      async claimStaleResponseExecution(input) {
        claimCalls.push(input.expectedModelRunAttemptId);
        return {
          generationCommandId,
          modelRunAttemptId: asModelRunAttemptId(
            "01984477-1f9a-7d25-9d97-e588769566c7",
          ),
          outcome: "execute",
          retried: true,
          turnId: interactionTurnId,
          userId,
        };
      },
    };
    const harness = createConversationAgentHarness({
      clock: fixedClock,
      delay: async () => undefined,
      egressPort,
      jitter: () => 0.5,
      repository,
    });

    const events: ConversationHarnessEvent[] = [];
    for await (const event of harness.runDecision(baseCommand())) {
      events.push(event);
    }

    // The retry reused the same Decision Command and only added a new
    // ModelRunAttempt; the user sees a single committed Final Response.
    expect(attempt).toBe(2);
    expect(claimCalls).toEqual([modelRunAttemptId]);
    expect(events.some((event) => event.type === "decision_committed")).toBe(true);
  });

  it("fails closed without committing when the model selects a tool against the empty Catalog (AC8)", async () => {
    const egressPort: ProviderEgressPort = {
      async *stream() {
        yield {
          rawArguments: '{"journal_id":"sh.journal.private"}',
          rawFunctionName: "regenerate_journal",
          type: "tool_call",
        } as const;
        yield { delta: "Done.", type: "delta" } as const;
        yield { ...completedMetadata, type: "completed" } as const;
      },
    };
    let commitCalls = 0;
    let settledCategory: ProviderDispatchErrorCategory | null = null;
    const repository: ConversationAgentHarnessRepository = {
      async claimResponseExecution() {
        return "owner";
      },
      async loadResponse() {
        throw new Error("unexpected loadResponse");
      },
      async commitCompleteResponse() {
        commitCalls += 1;
        return { outcome: "fence_rejected" };
      },
      async settleResponseFailure(input) {
        settledCategory = input.category;
        return { category: input.category, outcome: "settled", status: "failed" };
      },
      async claimStaleResponseExecution() {
        throw new Error("unexpected claimStaleResponseExecution");
      },
    };
    const harness = createConversationAgentHarness({
      clock: fixedClock,
      egressPort,
      jitter: () => 0.5,
      repository,
    });

    const events: ConversationHarnessEvent[] = [];
    for await (const event of harness.runDecision(baseCommand())) {
      events.push(event);
    }

    // No Assistant Event is committed and no fabricated success reaches the
    // user; the provider-native function name never appears in the stream.
    expect(commitCalls).toBe(0);
    expect(events).toEqual([
      { category: "invalid_response", interrupted: false, type: "decision_failed" },
    ]);
    expect(settledCategory).toBe("invalid_response");
    expect(
      JSON.stringify(events).includes("regenerate_journal"),
    ).toBe(false);
  });
});
