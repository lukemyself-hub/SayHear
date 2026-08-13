import type {
  ContinuousExchangeService,
  ConversationResponseService,
  JournalEligibilityService,
  OutboxDispatcherService,
  RollingSummaryService,
} from "@sayhear/application";

export function createRecoveryScannerHandler(dependencies: {
  conversationResponseService: ConversationResponseService;
  scannerSecret: string;
  continuousExchangeService: ContinuousExchangeService;
  journalEligibilityService: JournalEligibilityService;
  outboxDispatcherService: OutboxDispatcherService;
  rollingSummaryService?: RollingSummaryService;
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
    const rollingSummary = dependencies.rollingSummaryService
      ? await dependencies.rollingSummaryService.scanPending()
      : { queued: 0 };
    const outbox = await dependencies.outboxDispatcherService.dispatchPending();

    return Response.json({
      inactivity,
      responses,
      eligibility,
      rollingSummary,
      outbox,
    });
  };
}
