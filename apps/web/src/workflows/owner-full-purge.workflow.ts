import { assertWorkflowSafe } from "@sayhear/application/workflow-contract";
import type { WorkflowStarter } from "@sayhear/application";
import { start } from "workflow/api";

type OwnerFullPurgeManifestInput = {
  purgeSurfaceRegistryVersion?: unknown;
  externalIntegrationManifestVersion?: unknown;
  workflowSubjectManifestVersion?: unknown;
};

export function assertOwnerFullPurgeManifest(
  input: OwnerFullPurgeManifestInput,
): asserts input is OwnerFullPurgeManifestInput & {
  purgeSurfaceRegistryVersion: string;
  externalIntegrationManifestVersion: string;
  workflowSubjectManifestVersion: string;
} {
  if (
    typeof input.purgeSurfaceRegistryVersion !== "string" ||
    input.purgeSurfaceRegistryVersion.trim().length === 0 ||
    typeof input.externalIntegrationManifestVersion !== "string" ||
    input.externalIntegrationManifestVersion.trim().length === 0 ||
    typeof input.workflowSubjectManifestVersion !== "string" ||
    input.workflowSubjectManifestVersion.trim().length === 0
  ) {
    throw new Error(
      "Owner Full Purge workflow requires all frozen manifest versions.",
    );
  }
}

/**
 * 1A.3b / issue #194: Internal Owner Full Purge propagation Workflow entrypoint.
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
  purgeSurfaceRegistryVersion: string;
  externalIntegrationManifestVersion: string;
  workflowSubjectManifestVersion: string;
}): Promise<{
  outcome:
    | "retention_pending"
    | "needs_attention"
    | "no_order"
    | "epoch_mismatch"
    | "registry_mismatch";
}> {
  "use workflow";
  assertWorkflowSafe(input, "input");
  assertOwnerFullPurgeManifest(input);
  const result = await runPurgeStep(input);
  assertWorkflowSafe(result, "result");
  return result;
}

async function runPurgeStep(input: {
  workflowCommandId: string;
  subjectId: string;
  expectedDataEpoch: number;
  purgeSurfaceRegistryVersion: string;
  externalIntegrationManifestVersion: string;
  workflowSubjectManifestVersion: string;
}): Promise<{
  outcome:
    | "retention_pending"
    | "needs_attention"
    | "no_order"
    | "epoch_mismatch"
    | "registry_mismatch";
}> {
  "use step";
  assertOwnerFullPurgeManifest(input);
  const { asUserId } = await import("@sayhear/application/ids");
  const { createServerComposition } = await import("../server-composition");
  const composition = createServerComposition();
  const result = await composition.ownerPurgeService.propagateForOwner({
    expectedDataEpoch: input.expectedDataEpoch,
    purgeSurfaceRegistryVersion: input.purgeSurfaceRegistryVersion,
    externalIntegrationManifestVersion:
      input.externalIntegrationManifestVersion,
    workflowSubjectManifestVersion: input.workflowSubjectManifestVersion,
    userId: asUserId(input.subjectId),
  });
  if ("outcome" in result) {
    return { outcome: result.outcome };
  }
  return { outcome: result.status === "retention_pending" ? "retention_pending" : "needs_attention" };
}

export function createOwnerFullPurgeWorkflowStarter(): WorkflowStarter {
  return async (input) => {
    assertOwnerFullPurgeManifest(input);
    const run = await start(ownerFullPurgeWorkflow, [
      {
        workflowCommandId: input.workflowCommandId,
        subjectId: input.subjectId,
        expectedDataEpoch: input.expectedDataEpoch,
        purgeSurfaceRegistryVersion: input.purgeSurfaceRegistryVersion,
        externalIntegrationManifestVersion:
          input.externalIntegrationManifestVersion,
        workflowSubjectManifestVersion: input.workflowSubjectManifestVersion,
      },
    ]);
    return { workflowReceiptId: run.runId };
  };
}
