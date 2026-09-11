import type { WorkflowStarter } from "@sayhear/application";
import { assertWorkflowSafe } from "@sayhear/application/workflow-contract";
import { start } from "workflow/api";

/**
 * The idempotent async follow-up of a committed `memory_correction` (issue
 * #119): targeted JournalStatement revalidation under one Receipt sequence.
 * The visible reply claims only the synchronous correction; this workflow's
 * completion receipts land afterwards (ADR-0066 / ADR-0099).
 */
export async function memoryCorrectionFollowupWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}) {
  "use workflow";
  assertWorkflowSafe(input, "input");
  return await runMemoryCorrectionFollowupStep(input.workflowCommandId);
}

async function runMemoryCorrectionFollowupStep(workflowCommandId: string) {
  "use step";
  const { runMemoryCorrectionFollowupWorkflow } = await import(
    "@sayhear/application/memory-trust-followup"
  );
  const { createServerComposition } = await import("../server-composition");
  const composition = createServerComposition();
  return runMemoryCorrectionFollowupWorkflow({
    repository: composition.memoryCorrectionFollowupRepository,
    workflowCommandId,
  });
}
