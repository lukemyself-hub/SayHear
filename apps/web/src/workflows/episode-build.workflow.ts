import { randomUUID } from "node:crypto";

import { asUserId, runEpisodeBuild } from "@sayhear/application";
import { createServerComposition } from "../server-composition";

/**
 * Daily Episode Builder workflow (issue #197): one `episode_build` command
 * runs the full deterministic build for one quiescent Daily Session. Only
 * allowlisted fields cross Workflow history.
 */
export async function episodeBuildWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  ownerId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<{
  dailySessionId: string;
  outcome:
    | "built"
    | "stale_superseded"
    | "fenced"
    | "retryable_failed"
    | "failed";
  candidateCount: number;
  acceptedCount: number;
  unresolvedCount: number;
  rejectedCount: number;
  errorCode: string | null;
}> {
  "use workflow";
  return await runEpisodeBuildStep(input);
}

async function runEpisodeBuildStep(input: {
  workflowCommandId: string;
  subjectId: string;
  ownerId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<{
  dailySessionId: string;
  outcome:
    | "built"
    | "stale_superseded"
    | "fenced"
    | "retryable_failed"
    | "failed";
  candidateCount: number;
  acceptedCount: number;
  unresolvedCount: number;
  rejectedCount: number;
  errorCode: string | null;
}> {
  "use step";
  const composition = await createServerComposition();
  await composition.modelRoleCommandService.verifyActiveG1Release?.();
  await composition.recoveryGate.requireOpen(asUserId(input.ownerId));
  const policyVersion =
    composition.episodeBuilderPolicyVersion ?? input.policyVersion;
  if (policyVersion !== input.policyVersion) {
    throw new Error(
      `Episode build command policy ${input.policyVersion} does not match runtime policy ${policyVersion}.`,
    );
  }
  const dependencies = await composition.episodeEntrypointDependencies(
    `wf-${randomUUID()}`,
  );
  return runEpisodeBuild({
    clock: dependencies.clock,
    repository: dependencies.repository,
    modelRoleCommandService: dependencies.modelRoleCommandService,
    providerEgress: dependencies.providerEgress,
    episodeBuildProvider: dependencies.episodeBuildProvider,
    dedupeFingerprintSecret: dependencies.dedupeFingerprintSecret,
    workflowReceiptId: `wf-${randomUUID()}`,
    command: {
      workflowCommandId: input.workflowCommandId,
      subjectId: input.subjectId,
      sourceRevision: input.sourceRevision,
      policyVersion: input.policyVersion,
      expectedDataEpoch: input.expectedDataEpoch,
    },
    recoveryGate: composition.recoveryGate,
    recoveryOwnerId: asUserId(input.ownerId),
  });
}
