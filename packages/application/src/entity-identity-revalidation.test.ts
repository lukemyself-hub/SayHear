import { describe, expect, it } from "vitest";

import {
  ENTITY_IDENTITY_REVALIDATION_POLICY_VERSION,
  runEntityIdentityRevalidationWorkflow,
  type EntityIdentityRevalidationRepository,
} from "./entity-identity-revalidation";

function createRepository(operation: "merge" | "split") {
  let claimed = false;
  const receipts: Array<{
    disposition: string;
    execution: "running" | "succeeded";
    receiptKey: string;
  }> = [];
  let outcome:
    | {
        affectedClaimIds: readonly string[];
        affectedJournalStatementIds: readonly string[];
        outcome: string;
      }
    | undefined;
  const repository: EntityIdentityRevalidationRepository = {
    async readRevalidationCommand() {
      return {
        actionExecutionId: "action-1",
        expectedDataEpoch: 1,
        operation,
        policyVersion: ENTITY_IDENTITY_REVALIDATION_POLICY_VERSION,
        sourceEntityId: "entity-1",
        sourceEntityVersionId: "entity-version-1",
        userId: "user-1",
        workflowCommandId: "workflow-1",
      };
    },
    async claimRevalidationRun() {
      if (claimed) return "replayed";
      claimed = true;
      return "execute";
    },
    async listAffectedLineage() {
      return {
        affectedClaimIds: ["claim-1"],
        affectedJournalStatementIds: ["statement-1"],
      };
    },
    async recordRevalidationOutcome(input) {
      outcome = {
        affectedClaimIds: input.affectedClaimIds,
        affectedJournalStatementIds: input.affectedJournalStatementIds,
        outcome: input.outcome,
      };
      return input.outcome;
    },
    async appendRevalidationReceipt(input) {
      receipts.push(input);
    },
  };
  return { get outcome() { return outcome; }, receipts, repository };
}

describe("runEntityIdentityRevalidationWorkflow (issue #121)", () => {
  it("revalidates targeted lineage once and makes a replay a no-op", async () => {
    const fake = createRepository("merge");

    const first = await runEntityIdentityRevalidationWorkflow({
      repository: fake.repository,
      workflowCommandId: "workflow-1",
    });
    const second = await runEntityIdentityRevalidationWorkflow({
      repository: fake.repository,
      workflowCommandId: "workflow-1",
    });

    expect(first).toEqual({
      affectedClaimCount: 1,
      affectedJournalStatementCount: 1,
      outcome: "completed",
      revalidationOutcome: "no_change",
    });
    expect(second).toEqual({
      affectedClaimCount: 0,
      affectedJournalStatementCount: 0,
      outcome: "replayed",
    });
    expect(fake.outcome).toEqual({
      affectedClaimIds: ["claim-1"],
      affectedJournalStatementIds: ["statement-1"],
      outcome: "no_change",
    });
    expect(fake.receipts).toEqual([
      {
        actionExecutionId: "action-1",
        disposition: "identity_revalidation_processing",
        execution: "running",
        receiptKey: "execution:identity-revalidation:processing",
      },
      {
        actionExecutionId: "action-1",
        disposition: "identity_revalidation_no_change",
        execution: "succeeded",
        receiptKey: "execution:identity-revalidation:completed",
      },
    ]);
  });

  it("keeps split lineage fenced as still ambiguous", async () => {
    const fake = createRepository("split");

    await runEntityIdentityRevalidationWorkflow({
      repository: fake.repository,
      workflowCommandId: "workflow-1",
    });

    expect(fake.outcome?.outcome).toBe("still_ambiguous");
    expect(fake.receipts[1]).toMatchObject({
      disposition: "identity_revalidation_still_ambiguous",
      execution: "succeeded",
    });
  });
});
