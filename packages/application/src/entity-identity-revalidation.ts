/**
 * Reverse-lineage revalidation after an Entity identity correction (#121).
 * The synchronous action owns the identity and Claim fences; this module owns
 * the small, replay-safe workflow seam that observes only the affected rows.
 */
export const ENTITY_IDENTITY_REVALIDATION_POLICY_VERSION =
  "entity-identity-revalidation:v1";

export type EntityIdentityRevalidationOperation = "merge" | "split" | "promote";

export type EntityIdentityRevalidationCommand = Readonly<{
  actionExecutionId: string;
  expectedDataEpoch: number;
  operation: EntityIdentityRevalidationOperation;
  policyVersion: string;
  sourceEntityId: string;
  sourceEntityVersionId: string;
  userId: string;
  workflowCommandId: string;
}>;

export type EntityIdentityRevalidationOutcome =
  | "no_change"
  | "correction_required"
  | "still_ambiguous";

export type EntityIdentityRevalidationRepository = Readonly<{
  readRevalidationCommand(input: {
    workflowCommandId: string;
  }): Promise<EntityIdentityRevalidationCommand | null>;
  /** Claims exactly one run for the durable WorkflowCommand. */
  claimRevalidationRun(input: {
    actionExecutionId: string;
    sourceEntityId: string;
    sourceEntityVersionId: string;
    userId: string;
    workflowCommandId: string;
  }): Promise<"execute" | "replayed">;
  listAffectedLineage(input: {
    actionExecutionId: string;
    sourceEntityId: string;
    sourceEntityVersionId: string;
    userId: string;
  }): Promise<Readonly<{
    affectedClaimIds: readonly string[];
    affectedJournalStatementIds: readonly string[];
  }> >;
  recordRevalidationOutcome(input: {
    affectedClaimIds: readonly string[];
    affectedJournalStatementIds: readonly string[];
    outcome: EntityIdentityRevalidationOutcome;
    workflowCommandId: string;
  }): Promise<EntityIdentityRevalidationOutcome>;
  appendRevalidationReceipt(input: {
    actionExecutionId: string;
    disposition: string;
    execution: "running" | "succeeded";
    receiptKey: string;
  }): Promise<void>;
}>;

export type EntityIdentityRevalidationResult = Readonly<{
  affectedClaimCount: number;
  affectedJournalStatementCount: number;
  outcome: "completed" | "replayed";
  revalidationOutcome?: EntityIdentityRevalidationOutcome;
}>;

/**
 * The runner is deliberately conservative: split lineage remains ambiguous,
 * while merge/promote starts with a no-change attempt and lets the repository
 * downgrade the outcome when any targeted Claim cannot be safely restored.
 * The repository records the exact targeted fence transition atomically.
 */
export async function runEntityIdentityRevalidationWorkflow(input: {
  repository: EntityIdentityRevalidationRepository;
  workflowCommandId: string;
}): Promise<EntityIdentityRevalidationResult> {
  const command = await input.repository.readRevalidationCommand({
    workflowCommandId: input.workflowCommandId,
  });
  if (!command) {
    throw new Error(
      `Entity identity revalidation command ${input.workflowCommandId} does not exist.`,
    );
  }
  if (command.policyVersion !== ENTITY_IDENTITY_REVALIDATION_POLICY_VERSION) {
    throw new Error(
      "Entity identity revalidation command policy does not match runtime policy.",
    );
  }
  const claim = await input.repository.claimRevalidationRun({
    actionExecutionId: command.actionExecutionId,
    sourceEntityId: command.sourceEntityId,
    sourceEntityVersionId: command.sourceEntityVersionId,
    userId: command.userId,
    workflowCommandId: command.workflowCommandId,
  });
  if (claim === "replayed") {
    return {
      affectedClaimCount: 0,
      affectedJournalStatementCount: 0,
      outcome: "replayed",
    };
  }

  await input.repository.appendRevalidationReceipt({
    actionExecutionId: command.actionExecutionId,
    disposition: "identity_revalidation_processing",
    execution: "running",
    receiptKey: "execution:identity-revalidation:processing",
  });
  const lineage = await input.repository.listAffectedLineage({
    actionExecutionId: command.actionExecutionId,
    sourceEntityId: command.sourceEntityId,
    sourceEntityVersionId: command.sourceEntityVersionId,
    userId: command.userId,
  });
  const revalidationOutcome: EntityIdentityRevalidationOutcome =
    command.operation === "split" ? "still_ambiguous" : "no_change";
  const recordedOutcome = await input.repository.recordRevalidationOutcome({
    affectedClaimIds: lineage.affectedClaimIds,
    affectedJournalStatementIds: lineage.affectedJournalStatementIds,
    outcome: revalidationOutcome,
    workflowCommandId: command.workflowCommandId,
  });
  await input.repository.appendRevalidationReceipt({
    actionExecutionId: command.actionExecutionId,
    disposition: `identity_revalidation_${recordedOutcome}`,
    execution: "succeeded",
    receiptKey: "execution:identity-revalidation:completed",
  });
  return {
    affectedClaimCount: lineage.affectedClaimIds.length,
    affectedJournalStatementCount: lineage.affectedJournalStatementIds.length,
    outcome: "completed",
    revalidationOutcome: recordedOutcome,
  };
}
