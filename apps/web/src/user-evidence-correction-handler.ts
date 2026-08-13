import { InvalidUserTextTurnError, type JournalEligibilityService, type UserId, type UserTextConversationService } from "@sayhear/application";

export function createUserEvidenceCorrectionHandler(dependencies: {
  authenticate(request: Request): Promise<{ userId: UserId } | null>;
  conversationService: UserTextConversationService;
  journalEligibilityService: JournalEligibilityService;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return Response.json({ error: "unauthorized" }, { status: 401 });
    let body: Record<string, unknown>;
    try {
      const candidate: unknown = await request.json();
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error();
      body = candidate as Record<string, unknown>;
    } catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
    try {
      const corrected = await dependencies.conversationService.correct(principal.userId, {
        eventId: typeof body.eventId === "string" ? body.eventId : "",
        locale: typeof body.locale === "string" ? body.locale : "",
        text: typeof body.text === "string" ? body.text : "",
      });
      // A quiescent same-day session immediately converges on the normal,
      // idempotent exact-head command; an active session waits for its end.
      await dependencies.journalEligibilityService.evaluate(corrected.dailySessionId);
      return Response.json(corrected);
    } catch (error) {
      if (error instanceof InvalidUserTextTurnError) return Response.json({ error: "invalid_correction", message: error.message }, { status: 400 });
      throw error;
    }
  };
}
