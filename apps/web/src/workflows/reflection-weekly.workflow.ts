import { randomUUID } from "node:crypto";

import {
  runReflectionWeeklyBuild,
  type ReflectionBuildEntrypointResult,
} from "@sayhear/application";
import { createServerComposition } from "../server-composition";

/**
 * Weekly Reflection workflow (issue #199, SPEC 5.3): one `reflection_weekly`
 * command runs the `reflection.weekly` role over the frozen composite window
 * identity (per-day heads + Evidence / Episode / Summary / claim-baseline
 * manifest digests), validates through the shared `narrative.validate` role,
 * and commits the fenced current version plus `propose_new` Candidates.
 */
export async function reflectionWeeklyWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  weekIdentifier: string;
  windowStartDate: string;
  windowEndDate: string;
  sourceDigest: string;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<ReflectionBuildEntrypointResult> {
  "use workflow";
  return await runReflectionWeeklyStep(input);
}

async function runReflectionWeeklyStep(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  weekIdentifier: string;
  windowStartDate: string;
  windowEndDate: string;
  sourceDigest: string;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<ReflectionBuildEntrypointResult> {
  "use step";
  const composition = await createServerComposition();
  const policyVersion =
    composition.reflectionReadinessPolicyVersion ?? input.policyVersion;
  if (policyVersion !== input.policyVersion) {
    throw new Error(
      `Reflection weekly command policy ${input.policyVersion} does not match runtime policy ${policyVersion}.`,
    );
  }
  const dependencies = await composition.reflectionEntrypointDependencies(
    `wf-${randomUUID()}`,
  );
  return runReflectionWeeklyBuild({
    dependencies,
    command: {
      workflowCommandId: input.workflowCommandId,
      subjectId: input.subjectId,
      sourceRevision: input.sourceRevision,
      claimBaselineDigest: "",
      policyVersion: input.policyVersion,
      expectedDataEpoch: input.expectedDataEpoch,
      scope: "weekly",
      weekIdentifier: input.weekIdentifier,
      windowStartDate: input.windowStartDate,
      windowEndDate: input.windowEndDate,
      sourceDigest: input.sourceDigest,
    },
    recoveryGate: composition.recoveryGate,
  });
}
