import { assertWorkflowSafe } from "@sayhear/application/workflow-contract";
import type { CandidateRemapResult } from "@sayhear/application/candidate-review-workflow";

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
  assertWorkflowSafe(input, "input");
  return await runRemapStep(input.workflowCommandId);
}

async function runRemapStep(
  workflowCommandId: string,
): Promise<CandidateRemapResult> {
  "use step";
  const { asWorkflowCommandId } = await import("@sayhear/application/ids");
  const { runCandidateRemapWorkflow } = await import(
    "@sayhear/application/candidate-review-workflow"
  );
  const { createServerComposition } = await import("../server-composition");
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
