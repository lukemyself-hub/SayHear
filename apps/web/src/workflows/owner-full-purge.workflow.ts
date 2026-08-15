import { asUserId, type WorkflowStarter } from "@sayhear/application";
import { start } from "workflow/api";

import { createServerComposition } from "../server-composition";

/**
 * 1A.2 / issue #27: Internal Owner Full Purge propagation Workflow entrypoint.
 *
 * The outbox dispatcher leases the `owner_full_purge_requested` event created
 * by the opening transaction and starts this durable wrapper. Its single step
 * delegates to the idempotent application walker `propagateForOwner()`, which
 * owns every compare-and-set state transition; Workflow retries, the recovery
 * scan, and duplicate starts converge on the same effects.
 *
 * Step input/output carries only IDs, the frozen epoch, status and allowlisted
 * outcome codes — never conversation, Journal, or Evidence content
 * (architecture 13.3).
 */
export async function ownerFullPurgeWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  expectedDataEpoch: number;
}): Promise<{
  outcome: "retention_pending" | "needs_attention" | "no_order" | "epoch_mismatch";
}> {
  "use workflow";
  return await runPurgeStep(input);
}

async function runPurgeStep(input: {
  workflowCommandId: string;
  subjectId: string;
  expectedDataEpoch: number;
}): Promise<{
  outcome: "retention_pending" | "needs_attention" | "no_order" | "epoch_mismatch";
}> {
  "use step";
  const composition = createServerComposition();
  const result = await composition.ownerPurgeService.propagateForOwner({
    expectedDataEpoch: input.expectedDataEpoch,
    userId: asUserId(input.subjectId),
  });
  if ("outcome" in result) {
    return { outcome: result.outcome };
  }
  return { outcome: result.status === "retention_pending" ? "retention_pending" : "needs_attention" };
}

export function createOwnerFullPurgeWorkflowStarter(): WorkflowStarter {
  return async (input) => {
    const run = await start(ownerFullPurgeWorkflow, [
      {
        workflowCommandId: input.workflowCommandId,
        subjectId: input.subjectId,
        expectedDataEpoch: input.expectedDataEpoch,
      },
    ]);
    return { workflowReceiptId: run.runId };
  };
}
