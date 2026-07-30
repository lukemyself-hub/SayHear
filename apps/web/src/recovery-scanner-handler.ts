import type {
  ContinuousExchangeService,
  ConversationResponseService,
} from "@sayhear/application";

export function createRecoveryScannerHandler(dependencies: {
  conversationResponseService: ConversationResponseService;
  scannerSecret: string;
  continuousExchangeService: ContinuousExchangeService;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (
      !dependencies.scannerSecret ||
      request.headers.get("authorization") !==
        `Bearer ${dependencies.scannerSecret}`
    ) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    return Response.json({
      responses:
        await dependencies.conversationResponseService.scanStaleResponses(),
      inactivity:
        await dependencies.continuousExchangeService.scanDueInactivity(),
    });
  };
}
