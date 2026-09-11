import { assertWorkflowSafe } from "@sayhear/application/workflow-contract";
import { ENTITY_IDENTITY_REVALIDATION_POLICY_VERSION } from "@sayhear/application/entity-identity-revalidation";

/**
 * Durable wrapper for the targeted reverse-lineage pass created by #121.
 * Workflow history carries IDs, revisions, policy, and status only; the step
 * reads the owner-scoped Journal/Claim fences from Postgres.
 */
export async function entityIdentityRevalidationWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}) {
  "use workflow";
  assertWorkflowSafe(input, "input");
  if (input.policyVersion !== ENTITY_IDENTITY_REVALIDATION_POLICY_VERSION) {
    throw new Error(
      "Entity identity revalidation command policy does not match runtime policy.",
    );
  }
  return await runEntityIdentityRevalidationStep(input.workflowCommandId);
}

async function runEntityIdentityRevalidationStep(workflowCommandId: string) {
  "use step";
  const { runEntityIdentityRevalidationWorkflow } = await import(
    "@sayhear/application/entity-identity-revalidation"
  );
  const { createServerComposition } = await import("../server-composition");
  const composition = createServerComposition();
  return runEntityIdentityRevalidationWorkflow({
    repository: composition.entityIdentityRevalidationRepository,
    workflowCommandId,
  });
}
