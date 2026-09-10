import {
  assertCandidateGovernanceWorkflowSafe,
  runPredicateRegistryReleaseWorkflow,
  type PredicateRegistryReleaseResult,
} from "@sayhear/application/candidate-review-workflow";
import { start } from "workflow/api";

import { createServerComposition } from "../server-composition";

/**
 * Registry release handler (SPEC #193 §8.4, ADR-0122): the release migration
 * transaction published the awaiting ProposalVersions and wrote ONE
 * `predicate_registry_released` outbox event. This workflow inserts the
 * idempotent per-candidate remap commands — the scan derives Candidates from
 * the published ProposalVersions themselves, so a missed event cannot strand
 * a release, and the recovery scan re-runs the same idempotent scan.
 * Payloads carry only the Registry version — never private content.
 */
export async function predicateRegistryReleaseWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<PredicateRegistryReleaseResult> {
  "use workflow";
  assertCandidateGovernanceWorkflowSafe(input);
  return await runReleaseStep(input.sourceRevision);
}

async function runReleaseStep(
  releasedRegistryVersion: number,
): Promise<PredicateRegistryReleaseResult> {
  "use step";
  const composition = createServerComposition();
  return runPredicateRegistryReleaseWorkflow({
    repository: composition.candidateReviewWorkflowRepository,
    registryVersion: releasedRegistryVersion,
  });
}
