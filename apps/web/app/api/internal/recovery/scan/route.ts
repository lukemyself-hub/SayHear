import { runPredicateRegistryReleaseWorkflow } from "@sayhear/application/candidate-review-workflow";
import { createRecoveryScannerHandler } from "../../../../../src/recovery-scanner-handler";
import { createServerComposition } from "../../../../../src/server-composition";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const composition = createServerComposition();
  return createRecoveryScannerHandler({
    continuousExchangeService: composition.continuousExchangeService,
    conversationResponseService: composition.conversationResponseService,
    journalEligibilityService: composition.journalEligibilityService,
    dialogueStateService: composition.dialogueStateService,
    rollingSummaryService: composition.rollingSummaryService,
    ownerPurgeService: composition.ownerPurgeService,
    memoryConsolidationService: composition.memoryConsolidationService,
    episodeBuilderScanService: composition.episodeBuilderScanService,
    reflectionSchedulerScanService: composition.reflectionSchedulerScanService,
    // Candidate Review backstop (SPEC #193 §8.4, ADR-0122): the same
    // idempotent published-Proposal scan as the release workflow re-runs
    // here, so a missed release outbox event or an unfinished remap
    // converges without any second scheduler.
    candidateReviewRecoveryService: {
      scanPendingRemaps: async () => {
        const released = await runPredicateRegistryReleaseWorkflow({
          repository: composition.candidateReviewWorkflowRepository,
        });
        return { remapCommandsCreated: released.remapCommandsCreated };
      },
    },
    outboxDispatcherService: composition.outboxDispatcherService,
    scannerSecret: composition.recoveryScannerSecret,
  })(request);
}
