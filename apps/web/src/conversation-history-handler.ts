import {
  ConversationSessionNotFoundError,
  InvalidConversationCursorError,
  InvalidUserTextTurnError,
  RecoveryGateClosedError,
  type UserId,
  type UserTextConversationService,
} from "@sayhear/application";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

function rejectsClientOwnerIdentifier(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.searchParams.has("user_id") || url.searchParams.has("owner_id")) {
    return Response.json(
      { error: "client_owner_identifier_not_allowed" },
      { status: 400 },
    );
  }
  return null;
}

function recoveryGateResponse(error: unknown): Response | null {
  if (error instanceof RecoveryGateClosedError) {
    return Response.json(
      { error: "recovery_gate_closed", status: error.result.status },
      { status: 503 },
    );
  }
  return null;
}

/**
 * Read-only pagination of the owner's Daily Session date list. The first page
 * is server-rendered by the internal layout; this endpoint continues it with
 * the opaque cursor the service returns.
 */
export function createConversationDatesHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  service: UserTextConversationService;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const clientOwner = rejectsClientOwnerIdentifier(request);
    if (clientOwner !== null) {
      return clientOwner;
    }

    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    try {
      return Response.json(
        await dependencies.service.listConversationDates(principal.userId, {
          cursor,
        }),
      );
    } catch (error) {
      const gate = recoveryGateResponse(error);
      if (gate !== null) {
        return gate;
      }
      if (error instanceof InvalidConversationCursorError) {
        return Response.json({ error: "invalid_cursor" }, { status: 400 });
      }
      throw error;
    }
  };
}

/**
 * Reads messages older than a position within one owner-owned Daily Session.
 * `beforeSequence` seeds the first older page from the server-rendered recent
 * batch; `cursor` continues it. A session that is not the principal's own
 * fails with 404 instead of silently returning an empty page.
 */
export function createConversationMessagesHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  service: UserTextConversationService;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const clientOwner = rejectsClientOwnerIdentifier(request);
    if (clientOwner !== null) {
      return clientOwner;
    }

    const url = new URL(request.url);
    const rawDailySessionId = url.searchParams.get("dailySessionId") ?? "";
    const cursor = url.searchParams.get("cursor");
    const rawBeforeSequence = url.searchParams.get("beforeSequence");
    let beforeSequence: number | null = null;
    if (rawBeforeSequence !== null && rawBeforeSequence.length > 0) {
      const parsed = Number(rawBeforeSequence);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return Response.json(
          { error: "invalid_before_sequence" },
          { status: 400 },
        );
      }
      beforeSequence = parsed;
    }

    try {
      return Response.json(
        await dependencies.service.listOlderMessages(principal.userId, {
          beforeSequence,
          cursor,
          dailySessionId: rawDailySessionId,
        }),
      );
    } catch (error) {
      const gate = recoveryGateResponse(error);
      if (gate !== null) {
        return gate;
      }
      if (error instanceof ConversationSessionNotFoundError) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      if (error instanceof InvalidConversationCursorError) {
        return Response.json({ error: "invalid_cursor" }, { status: 400 });
      }
      if (error instanceof InvalidUserTextTurnError) {
        return Response.json(
          { error: "invalid_daily_session_id" },
          { status: 400 },
        );
      }
      throw error;
    }
  };
}
