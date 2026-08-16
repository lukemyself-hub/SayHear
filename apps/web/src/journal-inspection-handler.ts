import { asDailySessionId, asUserId, RecoveryGateClosedError, SensitiveInspectionDeniedError, type JournalService, type UserId } from "@sayhear/application";

export function createJournalInspectionHandler(dependencies: {
  authenticate(request: Request): Promise<{ authSessionId: string; userId: UserId } | null>;
  authorize(userId: UserId, authSessionId: string): Promise<void>;
  service: JournalService;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return Response.json({ error: "unauthorized" }, { status: 401 });
    try { await dependencies.authorize(principal.userId, principal.authSessionId); }
    catch (error) {
      if (error instanceof SensitiveInspectionDeniedError) return Response.json({ error: error.reason }, { status: 403 });
      if (error instanceof RecoveryGateClosedError) return Response.json({ error: "recovery_gate_closed", status: error.result.status }, { status: 503 });
      throw error;
    }
    const url = new URL(request.url);
    if (url.searchParams.has("user_id") || url.searchParams.has("owner_id")) {
      return Response.json({ error: "client_owner_identifier_not_allowed" }, { status: 400 });
    }
    const dailySessionId = url.searchParams.get("daily_session_id");
    if (!dailySessionId) return Response.json({ error: "daily_session_id_required" }, { status: 400 });
    try {
      const journal = await dependencies.service.inspect({
        dailySessionId: asDailySessionId(dailySessionId),
        userId: asUserId(principal.userId),
      });
      return journal ? Response.json(journal) : Response.json({ error: "not_found" }, { status: 404 });
    } catch {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  };
}
