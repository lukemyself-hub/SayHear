import { MEMORY_CORRECTION_POLICY_VERSION } from "./memory-trust-actions";

/**
 * The idempotent async follow-up of a committed `memory_correction` (issue
 * #119, SPEC #107 "Trust actions", ADR-0066 / ADR-0099): targeted
 * JournalStatement revalidation under one Receipt sequence. The visible
 * reply claims only the synchronous correction; this workflow records which
 * journal statements rest on the corrected claim's evidence so the journal
 * layer can re-check them — it never rewrites journal content and never
 * blocks publication. Replays converge on the workflow command identity.
 */
export const MEMORY_CORRECTION_FOLLOWUP_POLICY_VERSION =
  "memory-correction-followup:v1";

export type MemoryCorrectionFollowupCommand = Readonly<{
  actionExecutionId: string;
  policyVersion: string;
  targetClaimId: string;
  userId: string;
  workflowCommandId: string;
}>;

export type MemoryCorrectionFollowupRepository = Readonly<{
  readFollowupCommand(input: {
    workflowCommandId: string;
  }): Promise<MemoryCorrectionFollowupCommand | null>;
  /**
   * The idempotency anchor: claims the run by inserting the follow-up row
   * for this workflow command. Returns `"replayed"` when the run already
   * happened (or is happening) under this command.
   */
  claimFollowupRun(input: {
    actionExecutionId: string;
    targetClaimId: string;
    userId: string;
    workflowCommandId: string;
  }): Promise<"execute" | "replayed">;
  listAffectedJournalStatementIds(input: {
    claimId: string;
    userId: string;
  }): Promise<readonly string[]>;
  recordFollowupOutcome(input: {
    affectedJournalStatementIds: readonly string[];
    workflowCommandId: string;
  }): Promise<void>;
  /**
   * Appends a follow-up Progress / Completion Receipt to the same immutable
   * Receipt sequence the synchronous correction produced.
   */
  appendFollowupReceipt(input: {
    actionExecutionId: string;
    disposition: string;
    execution: "running" | "succeeded";
    receiptKey: string;
  }): Promise<void>;
}>;

export type MemoryCorrectionFollowupResult = Readonly<{
  affectedJournalStatementCount: number;
  outcome: "completed" | "replayed";
}>;

export async function runMemoryCorrectionFollowupWorkflow(input: {
  repository: MemoryCorrectionFollowupRepository;
  workflowCommandId: string;
}): Promise<MemoryCorrectionFollowupResult> {
  const command = await input.repository.readFollowupCommand({
    workflowCommandId: input.workflowCommandId,
  });
  if (!command) {
    throw new Error(
      `Memory correction follow-up command ${input.workflowCommandId} does not exist.`,
    );
  }
  if (command.policyVersion !== MEMORY_CORRECTION_FOLLOWUP_POLICY_VERSION) {
    throw new Error(
      "Memory correction follow-up command policy does not match runtime policy.",
    );
  }
  const claim = await input.repository.claimFollowupRun({
    actionExecutionId: command.actionExecutionId,
    targetClaimId: command.targetClaimId,
    userId: command.userId,
    workflowCommandId: command.workflowCommandId,
  });
  if (claim === "replayed") {
    return { affectedJournalStatementCount: 0, outcome: "replayed" };
  }
  await input.repository.appendFollowupReceipt({
    actionExecutionId: command.actionExecutionId,
    disposition: "followup_processing",
    execution: "running",
    receiptKey: "execution:followup:processing",
  });
  const affectedJournalStatementIds =
    await input.repository.listAffectedJournalStatementIds({
      claimId: command.targetClaimId,
      userId: command.userId,
    });
  await input.repository.recordFollowupOutcome({
    affectedJournalStatementIds,
    workflowCommandId: command.workflowCommandId,
  });
  await input.repository.appendFollowupReceipt({
    actionExecutionId: command.actionExecutionId,
    disposition: "followup_completed",
    execution: "succeeded",
    receiptKey: "execution:followup:completed",
  });
  return {
    affectedJournalStatementCount: affectedJournalStatementIds.length,
    outcome: "completed",
  };
}

/** Kept adjacent for policy co-location with the correction that spawned it. */
export { MEMORY_CORRECTION_POLICY_VERSION };
