import { RecoveryGateClosedError, type UserId, type RecoveryGate } from "@sayhear/application";

export function createJournalRetryHandler(dependencies: {
  authenticate(request: Request): Promise<{ userId: UserId } | null>;
  recoveryGate: RecoveryGate;
  retryForDate(input: { userId: string; logicalDate: string }): Promise<boolean>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const principal = await dependencies.authenticate(request);
    if (!principal) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "invalid_origin" }, { status: 403 });
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: "invalid_request" }, { status: 400 }); }
    if (typeof body !== "object" || body === null || !("logicalDate" in body) || typeof body.logicalDate !== "string" || Object.keys(body).some((key) => key !== "logicalDate") || !/^\d{4}-\d{2}-\d{2}$/.test(body.logicalDate)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const date = new Date(`${body.logicalDate}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== body.logicalDate) return Response.json({ error: "invalid_request" }, { status: 400 });
    try {
      await dependencies.recoveryGate.requireOpen(principal.userId);
      const queued = await dependencies.retryForDate({ userId: principal.userId, logicalDate: body.logicalDate });
      return Response.json({ queued }, { status: queued ? 202 : 409 });
    } catch (error) {
      if (error instanceof RecoveryGateClosedError) return Response.json({ error: "recovery_gate_closed" }, { status: 503 });
      throw error;
    }
  };
}
