import type {
  ContinuousExchangeService,
  ConversationResponseService,
  DialogueStateService,
  JournalEligibilityService,
  MemoryConsolidationScanService,
  OutboxDispatcherService,
  OwnerFullPurgeService,
  RollingSummaryService,
} from "@sayhear/application";

export function createRecoveryScannerHandler(dependencies: {
  conversationResponseService: ConversationResponseService;
  scannerSecret: string;
  continuousExchangeService: ContinuousExchangeService;
  journalEligibilityService: JournalEligibilityService;
  outboxDispatcherService: OutboxDispatcherService;
  dialogueStateService?: DialogueStateService;
  rollingSummaryService?: RollingSummaryService;
  ownerPurgeService?: OwnerFullPurgeService;
  memoryConsolidationService?: MemoryConsolidationScanService;
  episodeBuilderScanService?: {
    scanPending(): Promise<Readonly<{ buildsQueued: number; maintenanceQueued: number }>>;
  };
  reflectionSchedulerScanService?: {
    scanPending(): Promise<
      Readonly<{
        dailyQueued: number;
        weeklyQueued: number;
        maintenanceQueued: number;
      }>
    >;
  };
  /**
   * G2 extract-lane trigger (issue #207 layer 2b): idempotent per-Event
   * extraction admissions, dispatched below with the rest of the outbox.
   * The service itself stays closed until the G2 bundle switches open.
   */
  openLoopExtractionScanService?: {
    scanPending(): Promise<Readonly<{ extractionsQueued: number }>>;
  };
  /**
   * G2 proactive-lane maintenance (issue #207 layer 2c): converges active
   * reservations whose segment commands already terminalized (crashed turns
   * the workflow never redelivered). No second scheduler; runs with the
   * existing cron surface.
   */
  proactiveFollowupMaintenanceService?: {
    scan(): Promise<Readonly<{ reconciled: number }>>;
  };
  /**
   * Candidate Review release/remap backstop (SPEC #193 §8.4, ADR-0122):
   * re-runs the idempotent published-Proposal scan, so a missed release
   * outbox event or an unfinished remap converges without any second
   * scheduler.
   */
  candidateReviewRecoveryService?: {
    scanPendingRemaps(): Promise<Readonly<{ remapCommandsCreated: number }>>;
  };
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (
      !dependencies.scannerSecret ||
      request.headers.get("authorization") !==
        `Bearer ${dependencies.scannerSecret}`
    ) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    try {
      // The Cron route runs the existing recovery surface first, then the same
      // outbox dispatcher — no second scheduler service is introduced (AC #8).
      const responses =
        await dependencies.conversationResponseService.scanStaleResponses();
      await dependencies.conversationResponseService.scanPendingActionFinalizations?.();
      const inactivity =
        await dependencies.continuousExchangeService.scanDueInactivity();
      const eligibility =
        await dependencies.journalEligibilityService.scanPendingEligibility();
      const dialogueState = dependencies.dialogueStateService
        ? await dependencies.dialogueStateService.scanPending()
        : { queued: 0 };
      const rollingSummary = dependencies.rollingSummaryService
        ? await dependencies.rollingSummaryService.scanPending()
        : { queued: 0 };
      // Stuck or needs_attention purge orders are auto-retried here before the
      // dispatcher runs, so cancelled owner commands are already terminal.
      const purge = dependencies.ownerPurgeService
        ? await dependencies.ownerPurgeService.scanPendingOrders({
            now: new Date(),
          })
        : { retried: 0, remaining: 0 };
      // Slow-path scheduling (issue #114): the scan only creates the idempotent
      // due commands (daily / weekly consolidation + candidate sweeper); the
      // dispatcher below runs them. Cron never decides consolidation due-ness
      // itself — the domain layer computes it from the clock and timezone.
      const consolidation = dependencies.memoryConsolidationService
        ? await dependencies.memoryConsolidationService.scanPending()
        : { daily: 0, weekly: 0, sweeper: 0, reArmed: 0 };
      // Episode Builder daily eligibility (issue #197): idempotent episode
      // build commands plus the maintenance sweep, dispatched below.
      const episode = dependencies.episodeBuilderScanService
        ? await dependencies.episodeBuilderScanService.scanPending()
        : { buildsQueued: 0, maintenanceQueued: 0 };
      // Daily / Weekly Reflection scheduling (issue #199): idempotent
      // reflection build + maintenance commands, dispatched below.
      const reflection = dependencies.reflectionSchedulerScanService
        ? await dependencies.reflectionSchedulerScanService.scanPending()
        : { dailyQueued: 0, weeklyQueued: 0, maintenanceQueued: 0 };
      // G2 Open Loop extraction scheduling (issue #207): idempotent
      // per-Event extract commands, dispatched below.
      const openLoopExtraction = dependencies.openLoopExtractionScanService
        ? await dependencies.openLoopExtractionScanService.scanPending()
        : { extractionsQueued: 0 };
      // G2 proactive reservation maintenance (issue #207): idempotent
      // terminal-reservation convergence, dispatched below.
      const proactiveFollowupMaintenance =
        dependencies.proactiveFollowupMaintenanceService
          ? await dependencies.proactiveFollowupMaintenanceService.scan()
          : { reconciled: 0 };
      // Candidate Review governance backstop (SPEC #193 §8.4): idempotent
      // remap commands for published-but-unremapped awaiting Candidates,
      // dispatched below with the rest of the outbox.
      const candidateRemaps = dependencies.candidateReviewRecoveryService
        ? await dependencies.candidateReviewRecoveryService.scanPendingRemaps()
        : { remapCommandsCreated: 0 };
      const outbox = await dependencies.outboxDispatcherService.dispatchPending();

      return Response.json({
        inactivity,
        responses,
        eligibility,
        dialogueState,
        rollingSummary,
        purge,
        consolidation,
        episode,
        reflection,
        openLoopExtraction,
        proactiveFollowupMaintenance,
        candidateRemaps,
        outbox,
      });
    } catch (error) {
      const diagnosticCode = classifyRecoveryScanFailure(error);
      console.error("[sayhear.recovery.scan.error]", {
        diagnosticCode,
      });
      return Response.json(
        { error: "recovery_scan_failed", diagnosticCode },
        { status: 500 },
      );
    }
  };
}

function classifyRecoveryScanFailure(error: unknown):
  | "schema_drift"
  | "database_unavailable"
  | "unknown" {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : null;
  if (code === "42703" || code === "42P01" || code === "42883") {
    return "schema_drift";
  }
  if (
    code?.startsWith("08") ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENETUNREACH" ||
    code === "EAI_AGAIN"
  ) {
    return "database_unavailable";
  }
  return "unknown";
}
