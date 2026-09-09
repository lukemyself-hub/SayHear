import { randomUUID } from "node:crypto";

import { asUserId, runEpisodeMaintenance } from "@sayhear/application";
import { createServerComposition } from "../server-composition";

/**
 * Episode maintenance workflow (issue #197): one `episode_maintenance`
 * command runs the owner's bounded sweep passes — 30-day unresolved
 * candidate staleness, 7-day terminal content purge, and the impact review
 * pass that pauses and revalidates invalidated EpisodeVersions. Only
 * allowlisted fields cross Workflow history.
 */
export async function episodeMaintenanceWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<{
  staledCandidates: number;
  alreadyTerminalCandidates: number;
  purgedTerminalCandidates: number;
  pausedVersions: number;
  revalidatedVersions: number;
  supersededVersions: number;
}> {
  "use workflow";
  return await runEpisodeMaintenanceStep(input);
}

async function runEpisodeMaintenanceStep(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<{
  staledCandidates: number;
  alreadyTerminalCandidates: number;
  purgedTerminalCandidates: number;
  pausedVersions: number;
  revalidatedVersions: number;
  supersededVersions: number;
}> {
  "use step";
  const composition = await createServerComposition();
  const policyVersion =
    composition.episodeBuilderPolicyVersion ?? input.policyVersion;
  if (policyVersion !== input.policyVersion) {
    throw new Error(
      `Episode maintenance command policy ${input.policyVersion} does not match runtime policy ${policyVersion}.`,
    );
  }
  return runEpisodeMaintenance({
    clock: composition.clock,
    repository: composition.episodeRepository,
    userId: asUserId(input.subjectId),
    policyVersion: input.policyVersion,
    dedupeFingerprintSecret: composition.dedupeFingerprintSecret,
  });
}
