/**
 * Reflection maintenance workflow (issue #199): one `reflection_maintenance`
 * command runs the owner's bounded passes — reverse-lineage staleness from
 * Evidence invalidation and the read-time retention purge (7 / 30 days,
 * ADR-0130). Only allowlisted fields cross Workflow history.
 */
export async function reflectionMaintenanceWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<{ staledVersions: number; expiredContent: number }> {
  "use workflow";
  return await runReflectionMaintenanceStep(input);
}

async function runReflectionMaintenanceStep(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<{ staledVersions: number; expiredContent: number }> {
  "use step";
  const { asUserId, runReflectionMaintenance } = await import(
    "@sayhear/application"
  );
  const { createServerComposition } = await import("../server-composition");
  const composition = await createServerComposition();
  const policyVersion =
    composition.reflectionReadinessPolicyVersion ?? input.policyVersion;
  if (policyVersion !== input.policyVersion) {
    throw new Error(
      `Reflection maintenance command policy ${input.policyVersion} does not match runtime policy ${policyVersion}.`,
    );
  }
  const result = await runReflectionMaintenance({
    clock: composition.clock,
    repository: composition.reflectionRepository,
    userId: asUserId(input.subjectId),
    policyVersion: input.policyVersion,
  });
  return {
    staledVersions: result.staledVersions,
    expiredContent: result.expiredContent,
  };
}
