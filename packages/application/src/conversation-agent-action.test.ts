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
  ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
} from "./conversation-action-catalog";
import {
  createConversationAgentHarness,
  type ConversationAgentHarnessRepository,
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
const actionProposal = {
  actionKind: "regenerate_journal" as const,
  arguments: { journalHandle: "shh-handle-test" },
  requestEventRevisionId: requestRevisionId,
  schemaVersion: "regenerate-journal:v1" as const,
};

function command() {
  return {
    actionReferenceHandles: [
      {
        actionKinds: ["regenerate_journal"],
        handle: "shh-handle-test",
        targetKind: "journal" as const,
      },
    ],
    catalog: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
    catalogVersion: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
    compiledContextId: asCompiledContextId(
      "01984477-1f9a-7d25-9d97-e588769566c2",
    ),
    generationCommandId: asGenerationCommandId(
      "01984477-1f9a-7d25-9d97-e588769566c3",
    ),
    harnessPolicy: ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
    interactionTurnId: asInteractionTurnId(
      "01984477-1f9a-7d25-9d97-e588769566c4",
    ),
    modelRunAttemptId: asModelRunAttemptId(
      "01984477-1f9a-7d25-9d97-e588769566c5",
    ),
    requestEventRevisionId: requestRevisionId,
    userId,
  };
}

function repository(): ConversationAgentHarnessRepository {
  return {
    async claimResponseExecution() {
      return "owner";
    },
    async claimStaleResponseExecution() {
      throw new Error("unexpected recovery");
    },
    async commitCompleteResponse() {
      throw new Error("Action Decision must not commit an Assistant Event");
    },
    async loadResponse() {
      throw new Error("unexpected replay");
    },
    async settleResponseFailure() {
      throw new Error("unexpected failure");
    },
  };
}

function gateway(receipts: ConversationActionReceipt[]): ConversationActionGateway {
  return {
    async admit() {
      const receipt: ConversationActionReceipt = {
        actionExecutionId: "01984477-1f9a-7d25-9d97-e588769566c6",
        actionKind: "regenerate_journal",
        admission: "accepted",
        catalogVersion: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
        disposition: null,
        execution: "pending",
        receiptSequence: 1,
        schemaVersion: "regenerate-journal:v1",
      };
      receipts.push(receipt);
      return receipt;
    },
  };
}

describe("Conversation Agent Harness Action boundary", () => {
  it("admits one normalized Action and never claims Journal completion", async () => {
    const receipts: ConversationActionReceipt[] = [];
    const egressPort: ProviderEgressPort = {
      async *stream() {
        yield { proposal: actionProposal, type: "action_proposal" } as const;
        yield {
          costMicros: 0,
          finishReason: "tool_call",
          inputTokens: 1,
          modelSnapshot: "test",
          outputTokens: 0,
          providerRequestId: null,
          type: "completed",
        } as const;
      },
    };
    const harness = createConversationAgentHarness({
      actionGateway: gateway(receipts),
      clock: () => new Date("2026-08-14T00:00:00.000Z"),
      egressPort,
      repository: repository(),
    });

    const events = [];
    for await (const event of harness.runDecision(command())) events.push(event);

    expect(receipts).toHaveLength(1);
    expect(events).toEqual([{ receipt: receipts[0], type: "action_admitted" }]);
  });

  it("runs Action Finalization with tools disabled and commits the final response", async () => {
    let toolsDisabled: boolean | undefined;
    const egressPort: ProviderEgressPort = {
      async *stream(input) {
        toolsDisabled = input.toolsDisabled;
        yield { delta: "The Journal is now expressed more clearly.", type: "delta" } as const;
        yield {
          costMicros: 0,
          finishReason: "completed",
          inputTokens: 1,
          modelSnapshot: "test",
          outputTokens: 1,
          providerRequestId: null,
          type: "completed",
        } as const;
      },
    };
    const harness = createConversationAgentHarness({
      clock: () => new Date("2026-08-14T00:00:00.000Z"),
      egressPort,
      repository: {
        ...repository(),
        async commitCompleteResponse() {
          return {
            eventId: asConversationEventId("01984477-1f9a-7d25-9d97-e588769566c7"),
            outcome: "committed" as const,
            revisionId: asConversationEventRevisionId("01984477-1f9a-7d25-9d97-e588769566c8"),
          };
        },
      },
    });

    const events = [];
    for await (const event of harness.runFinalization!({
      ...command(),
      harnessPolicy: {
        ...ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
        maxStateChangingActions: 0,
        toolsDisabled: true,
      },
    })) events.push(event);

    expect(toolsDisabled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "decision_committed" });
  });
});
