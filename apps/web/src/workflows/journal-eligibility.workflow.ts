import type { WorkflowStarter } from "@sayhear/application";
import { start } from "workflow/api";

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
  console.info("[journal-eligibility] step started", {
    workflowCommandId: input.workflowCommandId,
  });
  const { randomUUID } = await import("node:crypto");
  const { runAutomaticJournal, runJournalEligibility } = await import(
    "@sayhear/application"
  );
  const { createServerComposition } = await import("../server-composition");
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
    const leaseToken = randomUUID();
    if (!await composition.journalWorkflowRecovery.claim(input, leaseToken)) {
      return { ...eligibility, outcome: "retryable_failed" as const };
    }
    const settle = async (outcome: "published" | "needs_review" | "retryable_failed", reason: string | null) =>
      composition.journalWorkflowRecovery.settle(input, leaseToken, outcome, reason);
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
      // Content-free execution identity links runtime diagnostics to the
      // failed command without logging Provider bodies or arbitrary errors.
      console.error(
        "[journal-eligibility] evidence freeze threw:",
        { workflowCommandId: input.workflowCommandId, category: databaseFailure(error) ? "database_failure" : "evidence_provider_failed" },
      );
      await settle("retryable_failed", databaseFailure(error) ? "database_failure" : "evidence_provider_failed");
      if (databaseFailure(error)) throw error;
      return { ...eligibility, outcome: "retryable_failed" as const };
    }
    if (evidence.outcome !== "frozen") {
      // `not_eligible` is not a generation failure: the date list already
      // surfaces an insufficient-expression day through `date_outcome`, so it
      // keeps its terminal `needs_review` row and never becomes a failed
      // generation with a retry action. Every other non-frozen outcome is
      // transient, so it settles `retryable_failed` and lets the bounded
      // three-attempt budget converge on the one terminal shape the recovery
      // scan, date list, notice and retry action all accept
      // (`needs_review` + `retry_budget_exhausted`). A fresh terminal row
      // carrying a raw reason would be invisible to every one of them.
      await settle(evidence.outcome === "not_eligible" ? "needs_review" : "retryable_failed", evidence.outcome);
      return { ...eligibility, outcome: evidence.outcome === "not_eligible" ? "needs_review" as const : "retryable_failed" as const };
    }
    if (evidence.outcome === "frozen") {
      let journal: Awaited<ReturnType<typeof runAutomaticJournal>>;
      try {
        journal = await runAutomaticJournal({
          service: composition.journalService,
          command: { ...input, leaseToken, policyVersion: composition.journalGenerationPolicyVersion },
          generationCommandId: `${input.workflowCommandId}:journal`,
          modelRunAttemptId: randomUUID(),
        });
      } catch (error) {
        console.error(
          "[journal-eligibility] journal generation threw:",
          { workflowCommandId: input.workflowCommandId, category: "journal_generation_failed" },
        );
        await settle("retryable_failed", databaseFailure(error) ? "database_failure" : "journal_generation_failed");
        if (databaseFailure(error)) throw error;
        return { ...eligibility, outcome: "retryable_failed" as const };
      }
      if (journal.outcome !== "published") {
        // No non-published Journal outcome is terminal on its own. Each one is
        // transient under the bounded budget, so every failure settles
        // `retryable_failed` and converges on `needs_review` +
        // `retry_budget_exhausted` once the three attempts are spent.
        await settle("retryable_failed", journal.reason ?? journal.outcome);
        return { ...eligibility, outcome: "retryable_failed" as const };
      }
      await settle("published", null);
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

function databaseFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") return false;
  return ["40P01", "40001", "55P03", "57014", "ECONNRESET", "ECONNREFUSED"].includes(error.code) || error.code.startsWith("08");
}

runEligibilityStep.maxRetries = 2;
