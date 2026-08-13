import { randomUUID } from "node:crypto";

import { runJournalEligibility, type WorkflowStarter } from "@sayhear/application";
import { start } from "workflow/api";

import { createServerComposition } from "../server-composition";

/**
 * 1A.2 Journal Eligibility Workflow application entrypoint.
 *
 * The directive function below is the durable-at-least-once wrapper deployed to
 * the Vercel platform. Its single step delegates to the directly-callable
 * application entrypoint `runJournalEligibility()`, which owns all deterministic
 * domain logic and idempotent commit. The system test exercises the application
 * entrypoint directly; platform-level durability/replay/queue is verified in
 * issue #29 (ADR-0066 layering decision).
 *
 * Step input/output is restricted by `assertWorkflowSafe` to IDs, revisions,
 * policy, event kind, status and allowlisted error codes — never conversation
 * text or rendered Prompt content (architecture 13.3, canary system test).
 */
export async function journalEligibilityWorkflow(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
}): Promise<{
  dailySessionId: string;
  outcome: "no_activity" | "insufficient_expression" | "eligible_queued";
  workflowReceiptId: string;
}> {
  "use workflow";
  return await runEligibilityStep(input);
}

async function runEligibilityStep(input: {
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
}) {
  "use step";
  const composition = createServerComposition();
  const policy =
    await composition.journalEligibilityService.resolvePolicyForStep();
  return runJournalEligibility({
    clock: composition.clock,
    repository: composition.journalEligibilityRepository,
    eligibilityPolicyVersion: policy.policyVersion,
    minimumSubstantiveExpressionLength:
      policy.minimumSubstantiveExpressionLength,
    evidenceService: composition.evidenceService,
    workflowReceiptId: `wf-${randomUUID()}`,
    command: input,
  });
}

/**
 * Build the `WorkflowStarter` the outbox dispatcher calls. It starts the
 * production Workflow entrypoint via the `workflow` SDK `start()` and returns
 * the run receipt. `start()` is invoked OUTSIDE the claiming transaction (AC #6).
 */
export function createJournalEligibilityWorkflowStarter(): WorkflowStarter {
  return async (input) => {
    const run = await start(journalEligibilityWorkflow, [
      {
        workflowCommandId: input.workflowCommandId,
        subjectId: input.subjectId,
        sourceRevision: input.sourceRevision,
        policyVersion: input.policyVersion,
      },
    ]);
    return { workflowReceiptId: run.runId };
  };
}
