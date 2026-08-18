import { randomUUID } from "node:crypto";

import {
  runAutomaticJournal,
  runJournalEligibility,
  type WorkflowStarter,
} from "@sayhear/application";
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
  expectedDataEpoch: number;
}): Promise<{
  dailySessionId: string;
  outcome: "no_activity" | "insufficient_expression" | "eligible_queued" | "journal_available" | "published" | "needs_review" | "retryable_failed" | "stale_superseded";
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
  expectedDataEpoch: number;
}) {
  "use step";
  const composition = createServerComposition();
  const policy =
    await composition.journalEligibilityService.resolvePolicyForStep();
  if (input.policyVersion !== policy.policyVersion) {
    throw new Error("Journal eligibility command policy does not match runtime policy.");
  }
  const eligibility = await runJournalEligibility({
    clock: composition.clock,
    repository: composition.journalEligibilityRepository,
    eligibilityPolicyVersion: policy.policyVersion,
    minimumSubstantiveExpressionLength:
      policy.minimumSubstantiveExpressionLength,
    workflowReceiptId: `wf-${randomUUID()}`,
    command: input,
    recoveryGate: composition.recoveryGate,
  });
  if (eligibility.outcome === "eligible_queued") {
    const evidenceAttemptId = randomUUID();
    let evidence: Awaited<ReturnType<typeof composition.evidenceService.freeze>>;
    try {
      evidence = await composition.evidenceService.freeze({
        dailySessionId: input.subjectId,
        sourceRevision: input.sourceRevision,
        expectedDataEpoch: input.expectedDataEpoch,
        commandId: input.workflowCommandId,
        attemptId: evidenceAttemptId,
      });
    } catch (error) {
      await composition.journalRepository.recordWorkflowOutcome?.({
        dailySessionId: input.subjectId, userId: null, sourceRevision: input.sourceRevision,
        expectedDataEpoch: input.expectedDataEpoch, workflowCommandId: input.workflowCommandId,
        outcome: "retryable_failed", reason: "evidence_provider_failed",
      });
      return { ...eligibility, outcome: "retryable_failed" as const };
    }
    if (evidence.outcome !== "frozen") {
      await composition.journalRepository.recordWorkflowOutcome?.({
        dailySessionId: input.subjectId, userId: null, sourceRevision: input.sourceRevision,
        expectedDataEpoch: input.expectedDataEpoch, workflowCommandId: input.workflowCommandId,
        outcome: evidence.outcome === "not_eligible" ? "needs_review" : "retryable_failed", reason: evidence.outcome,
      });
      return { ...eligibility, outcome: evidence.outcome === "not_eligible" ? "needs_review" as const : "retryable_failed" as const };
    }
    if (evidence.outcome === "frozen") {
      let journal: Awaited<ReturnType<typeof runAutomaticJournal>>;
      try {
        journal = await runAutomaticJournal({
          service: composition.journalService,
          command: { ...input, policyVersion: composition.journalGenerationPolicyVersion },
          generationCommandId: `${input.workflowCommandId}:journal`,
          modelRunAttemptId: randomUUID(),
        });
      } catch {
        await composition.journalRepository.recordWorkflowOutcome?.({
          dailySessionId: input.subjectId, userId: evidence.snapshot.userId, sourceRevision: input.sourceRevision,
          expectedDataEpoch: input.expectedDataEpoch, workflowCommandId: input.workflowCommandId,
          outcome: "retryable_failed", reason: "journal_generation_failed",
        });
        return { ...eligibility, outcome: "retryable_failed" as const };
      }
      if (journal.outcome !== "published") {
        await composition.journalRepository.recordWorkflowOutcome?.({
          dailySessionId: input.subjectId, userId: evidence.snapshot.userId, sourceRevision: input.sourceRevision,
          expectedDataEpoch: input.expectedDataEpoch, workflowCommandId: input.workflowCommandId,
          outcome: journal.outcome === "validation_failed" ? "needs_review" : "retryable_failed", reason: journal.reason ?? journal.outcome,
        });
        return { ...eligibility, outcome: journal.outcome === "validation_failed" ? "needs_review" as const : "retryable_failed" as const };
      }
      await composition.journalRepository.recordWorkflowOutcome?.({
        dailySessionId: input.subjectId, userId: evidence.snapshot.userId, sourceRevision: input.sourceRevision,
        expectedDataEpoch: input.expectedDataEpoch, workflowCommandId: input.workflowCommandId,
        outcome: "published", reason: null,
      });
      return { ...eligibility, outcome: "published" as const };
    }
  }
  return eligibility;
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
        expectedDataEpoch: input.expectedDataEpoch,
      },
    ]);
    return { workflowReceiptId: run.runId };
  };
}
