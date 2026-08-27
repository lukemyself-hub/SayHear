import { describe, expect, it } from "vitest";

import {
  asCompiledContextId,
  asConversationEventRevisionId,
  asGenerationCommandId,
  asUserId,
} from "@sayhear/domain";

import {
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
} from "./conversation-action-catalog";
import {
  createConversationActionGateway,
  createJournalRegenerationActionHandler,
  type ConversationActionGatewayRepository,
  type ConversationActionReceipt,
} from "./conversation-action-gateway";
import type { ActionReferenceBinding } from "./conversation-action-handles";

const userId = asUserId("01984477-59a9-7d20-9d97-e588769566c0");
const contextId = asCompiledContextId(
  "01984477-59a9-7d20-9d97-e588769566c1",
);
const commandId = asGenerationCommandId(
  "01984477-59a9-7d20-9d97-e588769566c2",
);
const eventRevisionId = asConversationEventRevisionId(
  "01984477-59a9-7d20-9d97-e588769566c3",
);

const handle: ActionReferenceBinding = {
  actionKinds: ["regenerate_journal"],
  compiledContextId: contextId,
  currentVersionId: "journal-version-1",
  dailySessionId: "daily-session-1",
  expectedDataEpoch: 1,
  generationCommandId: commandId,
  handle: "opaque-journal-handle",
  ownerId: userId,
  sourceRevision: 7,
  targetId: "journal-1",
  targetKind: "journal",
  targetVersionId: "journal-version-1",
};

const context = {
  compiledContextId: contextId,
  decisionCommandId: commandId,
  requestEventRevisionId: eventRevisionId,
  userId,
};

function proposal(guidance?: string) {
  return {
    actionKind: "regenerate_journal" as const,
    arguments: {
      journalHandle: handle.handle,
      ...(guidance === undefined ? {} : { guidance }),
    },
    requestEventRevisionId: eventRevisionId,
    schemaVersion: "regenerate-journal:v1" as const,
  };
}

function repository(options: {
  currentVersionId?: string | null;
  inFlight?: boolean;
} = {}): ConversationActionGatewayRepository {
  const receipts: ConversationActionReceipt[] = [];
  const resolved = {
    ...handle,
    currentVersionId:
      options.currentVersionId === undefined
        ? handle.currentVersionId
        : options.currentVersionId,
  };
  return {
    async commitAccepted(input) {
      input.prepare();
      const receipt = acceptedReceipt();
      receipts.push(receipt);
      return receipt;
    },
    async commitNonAccepted(input) {
      const receipt: ConversationActionReceipt = {
        actionExecutionId: `execution-${receipts.length + 1}`,
        actionKind: input.definition?.actionKind ?? "unknown",
        admission: input.admission,
        catalogVersion:
          JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
        disposition: input.disposition,
        execution: "not_started",
        receiptSequence: 1,
        schemaVersion: input.schemaVersion,
      };
      receipts.push(receipt);
      return receipt;
    },
    async findByIdempotencyKey() {
      return receipts[0] ?? null;
    },
    async hasInFlightTarget() {
      return options.inFlight ?? false;
    },
    async resolveHandle() {
      return resolved;
    },
  };
}

function acceptedReceipt(): ConversationActionReceipt {
  return {
    actionExecutionId: "execution-1",
    actionKind: "regenerate_journal",
    admission: "accepted",
    catalogVersion:
      JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
    disposition: null,
    execution: "pending",
    receiptSequence: 1,
    schemaVersion: "regenerate-journal:v1",
  };
}

describe("Journal regeneration Action Gateway", () => {
  it("accepts a current-head request and passes bounded guidance to the typed handler", async () => {
    let preparedGuidance: string | null = null;
    const gateway = createConversationActionGateway({
      handlers: [
        {
          ...createJournalRegenerationActionHandler({
            generationPolicyVersion: "journal-generation:v2",
          }),
          prepare(input) {
            const prepared = createJournalRegenerationActionHandler({
              generationPolicyVersion: "journal-generation:v2",
            }).prepare(input);
            if (prepared.mode === "durable_workflow") {
              preparedGuidance = prepared.guidance;
            }
            return prepared;
          },
        },
      ],
      repository: repository(),
    });

    const result = await gateway.admit({
      catalog: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
      context,
      proposal: proposal("Make the turning point clearer."),
    });

    expect(result).toMatchObject({ admission: "accepted", execution: "pending" });
    expect(preparedGuidance).toBe("Make the turning point clearer.");
  });

  it("does not auto-rebind when the Journal current Version advanced", async () => {
    let accepted = false;
    const base = repository({ currentVersionId: "journal-version-2" });
    const gateway = createConversationActionGateway({
      handlers: [
        createJournalRegenerationActionHandler({
          generationPolicyVersion: "journal-generation:v2",
        }),
      ],
      repository: {
        ...base,
        async commitAccepted(input) {
          accepted = true;
          return base.commitAccepted(input);
        },
      },
    });

    const result = await gateway.admit({
      catalog: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
      context,
      proposal: proposal(),
    });

    expect(result).toMatchObject({
      admission: "clarification_required",
      disposition: "exact_head_advanced",
      execution: "not_started",
    });
    expect(accepted).toBe(false);
  });

  it("rejects a second in-flight regeneration without queueing it", async () => {
    const gateway = createConversationActionGateway({
      handlers: [
        createJournalRegenerationActionHandler({
          generationPolicyVersion: "journal-generation:v2",
        }),
      ],
      repository: repository({ inFlight: true }),
    });

    const result = await gateway.admit({
      catalog: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
      context,
      proposal: proposal(),
    });

    expect(result).toMatchObject({
      admission: "rejected",
      disposition: "rate_limited_in_flight",
      execution: "not_started",
    });
  });
});
