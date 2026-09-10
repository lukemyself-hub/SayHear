import {
  assertCandidateRemapWorkflowSafe,
  runCandidateRemapWorkflow,
  type CandidateRemapResult,
} from "@sayhear/application/candidate-review-workflow";
import { asWorkflowCommandId } from "@sayhear/application";
import { start } from "workflow/api";

import { createServerComposition } from "../server-composition";

/**
 * Release-driven Candidate remap (SPEC #193 §8.4, ADR-0122): re-enter normal
 * mapping and deterministic admission after a Registry release. The command
 * identity
 * `candidate-remap/<candidate-id>/<registry-version>/<policy-version>`
 * is the idempotency anchor; replays converge. Already-stale or canceled
 * Candidates never re-enter (ADR-0046 / ADR-0050), and no model or Web
 * surface participates — this is background reconciliation work.
 */
export async function candidateRemapWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}): Promise<CandidateRemapResult> {
  "use workflow";
  assertCandidateRemapWorkflowSafe(input);
  return await runRemapStep(input.workflowCommandId);
}

async function runRemapStep(
  workflowCommandId: string,
): Promise<CandidateRemapResult> {
  "use step";
  const composition = createServerComposition();
  return runCandidateRemapWorkflow({
    repository: composition.candidateReviewWorkflowRepository,
    workflowCommandId: asWorkflowCommandId(workflowCommandId),
    runRemap: async (remapInput) => {
      const outcome = await composition.candidateReviewService.runRemap({
        userId: remapInput.userId,
        candidateId: remapInput.candidateId,
      });
      return outcome;
    },
  });
}
