import type { ReflectionBuildEntrypointResult } from "@sayhear/application";

/**
 * Daily Reflection workflow (issue #199, SPEC 5.3): one `reflection_daily`
 * command freezes the session input, runs the `reflection.daily` role,
 * validates through the shared `narrative.validate` role, and commits the
 * fenced current version plus `propose_new` Candidates. Only allowlisted
 * fields cross Workflow history.
 */
export async function reflectionDailyWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  ownerId: string;
  sourceRevision: number;
  claimBaselineDigest: string;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<ReflectionBuildEntrypointResult> {
  "use workflow";
  return await runReflectionDailyStep(input);
}

async function runReflectionDailyStep(input: {
  workflowCommandId: string;
  subjectId: string;
  ownerId: string;
  sourceRevision: number;
  claimBaselineDigest: string;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<ReflectionBuildEntrypointResult> {
  "use step";
  const { randomUUID } = await import("node:crypto");
  const { asUserId, runReflectionDailyBuild } = await import(
    "@sayhear/application"
  );
  const { createServerComposition } = await import("../server-composition");
  const composition = await createServerComposition();
  await composition.modelRoleCommandService.verifyActiveG1Release?.();
  await composition.recoveryGate.requireOpen(asUserId(input.ownerId));
  const policyVersion =
    composition.reflectionReadinessPolicyVersion ?? input.policyVersion;
  if (policyVersion !== input.policyVersion) {
    throw new Error(
      `Reflection daily command policy ${input.policyVersion} does not match runtime policy ${policyVersion}.`,
    );
  }
  const dependencies = await composition.reflectionEntrypointDependencies(
    `wf-${randomUUID()}`,
  );
  return runReflectionDailyBuild({
    dependencies,
    command: {
      workflowCommandId: input.workflowCommandId,
      subjectId: input.subjectId,
      sourceRevision: input.sourceRevision,
      claimBaselineDigest: input.claimBaselineDigest,
      policyVersion: input.policyVersion,
      expectedDataEpoch: input.expectedDataEpoch,
      scope: "daily",
      weekIdentifier: null,
      windowStartDate: null,
      windowEndDate: null,
      sourceDigest: null,
    },
    recoveryGate: composition.recoveryGate,
    recoveryOwnerId: asUserId(input.ownerId),
  });
}
