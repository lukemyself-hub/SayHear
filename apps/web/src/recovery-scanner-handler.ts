import type {
  ContinuousExchangeService,
  ConversationResponseService,
  DialogueStateService,
  JournalEligibilityService,
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
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (
      !dependencies.scannerSecret ||
      request.headers.get("authorization") !==
        `Bearer ${dependencies.scannerSecret}`
    ) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    // The Cron route runs the existing recovery surface first, then the same
    // outbox dispatcher — no second scheduler service is introduced (AC #8).
    const responses =
      await dependencies.conversationResponseService.scanStaleResponses();
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
    const outbox = await dependencies.outboxDispatcherService.dispatchPending();

    return Response.json({
      inactivity,
      responses,
      eligibility,
      dialogueState,
      rollingSummary,
      purge,
      outbox,
    });
  };
}
