import { describe, expect, it } from "vitest";

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
