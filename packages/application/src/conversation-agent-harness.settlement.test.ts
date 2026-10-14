import { describe, expect, it } from "vitest";

import {
  asCompiledContextId,
  asConversationEventRevisionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asUserId,
} from "@sayhear/domain";

import {
  ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
} from "./conversation-action-catalog";
import {
  createConversationAgentHarness,
  type ConversationAgentHarnessRepository,
  type ConversationHarnessEvent,
} from "./conversation-agent-harness";
import type {
  ConversationActionGateway,
  ConversationActionReceipt,
} from "./conversation-action-gateway";
import type { ProviderEgressPort } from "./conversation-model";

const userId = asUserId("01984477-1f9a-7d25-9d97-e588769566c0");
const requestRevisionId = asConversationEventRevisionId(
  "01984477-1f9a-7d25-9d97-e588769566c1",
);
const proposal = {
  actionKind: "regenerate_journal" as const,
  arguments: { journalHandle: "shh-handle-test" },
  requestEventRevisionId: requestRevisionId,
  schemaVersion: "regenerate-journal:v1" as const,
};
const command = {
  actionReferenceHandles: [
    {
      actionKinds: ["regenerate_journal"],
      handle: "shh-handle-test",
      targetKind: "journal" as const,
    },
  ],
  catalog: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
  catalogVersion: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
  compiledContextId: asCompiledContextId("01984477-1f9a-7d25-9d97-e588769566c2"),
  generationCommandId: asGenerationCommandId("01984477-1f9a-7d25-9d97-e588769566c3"),
  harnessPolicy: ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
  interactionTurnId: asInteractionTurnId("01984477-1f9a-7d25-9d97-e588769566c4"),
  modelRunAttemptId: asModelRunAttemptId("01984477-1f9a-7d25-9d97-e588769566c5"),
  requestEventRevisionId: requestRevisionId,
  userId,
};

const toolOnlyDecision: ProviderEgressPort = {
  async *stream() {
    yield { proposal, type: "action_proposal" } as const;
    yield {
      costMicros: null,
      finishReason: "tool_call",
      inputTokens: 6_430,
      modelSnapshot: "test",
      outputTokens: 11_919,
      providerRequestId: null,
      type: "completed",
    } as const;
  },
};

function receipt(
  overrides: Partial<ConversationActionReceipt>,
): ConversationActionReceipt {
  return {
    actionExecutionId: "01984477-1f9a-7d25-9d97-e588769566c6",
    actionKind: "regenerate_journal",
    admission: "accepted",
    catalogVersion: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
    disposition: null,
    execution: "pending",
    receiptSequence: 1,
    schemaVersion: "regenerate-journal:v1",
    ...overrides,
  };
}

function build(admitted: ConversationActionReceipt) {
  const calls = { decisionSettled: 0, failures: [] as string[] };
  const repository: ConversationAgentHarnessRepository = {
    async claimResponseExecution() {
      return "owner";
    },
    async claimStaleResponseExecution() {
      throw new Error("unexpected recovery");
    },
    async commitActionDecision() {
      calls.decisionSettled += 1;
    },
    async commitCompleteResponse() {
      throw new Error("a Decision that ended in an Action commits no Assistant Event");
    },
    async loadResponse() {
      throw new Error("unexpected replay");
    },
    async settleResponseFailure(input) {
      calls.failures.push(input.category);
      return { category: input.category, outcome: "settled", status: "failed" };
    },
  };
  const gateway: ConversationActionGateway = {
    async admit() {
      return admitted;
    },
  };
  const harness = createConversationAgentHarness({
    actionGateway: gateway,
    clock: () => new Date("2026-09-12T16:00:00.000Z"),
    egressPort: toolOnlyDecision,
    repository,
  });
  return { calls, harness };
}

async function collect(iterable: AsyncIterable<ConversationHarnessEvent>) {
  const events: ConversationHarnessEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Conversation Agent Harness — Decision settlement after a tool call (issue #319)", () => {
  it("settles the Decision when the Action is admitted but needs clarification and a reply is owed", async () => {
    // #312: a misfired Trust Action ended in clarification_required /
    // target_not_found and the Decision command stayed running forever.
    const { calls, harness } = build(
      receipt({
        admission: "clarification_required",
        disposition: "target_not_found",
        execution: "not_started",
        finalization: {
          generationCommandId: "01984477-1f9a-7d25-9d97-e588769566c7",
          modelRunAttemptId: "01984477-1f9a-7d25-9d97-e588769566c8",
        },
      }),
    );
    const events = await collect(harness.runDecision(command));
    expect(events.map((event) => event.type)).toEqual(["action_admitted"]);
    expect(calls.decisionSettled).toBe(1);
    expect(calls.failures).toEqual([]);
  });

  it("settles the Decision as a failed turn when the Action is turned down and no reply is owed", async () => {
    const { calls, harness } = build(
      receipt({ admission: "unsupported", execution: "not_started" }),
    );
    const events = await collect(harness.runDecision(command));
    expect(events.map((event) => event.type)).toEqual(["action_admitted"]);
    // Nothing will ever answer this turn, so it must not stay running.
    expect(calls.decisionSettled + calls.failures.length).toBe(1);
  });
});
