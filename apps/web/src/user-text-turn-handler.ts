import {
  InvalidUserTextTurnError,
  UserTextIdempotencyConflictError,
  UserTextOwnerDeniedError,
  UserTextPrivateWriteDeniedError,
  type UserId,
  type UserTextConversationService,
} from "@sayhear/application";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

export function createUserTextTurnHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  service: UserTextConversationService;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    if (!isRecord(body)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if ("user_id" in body || "owner_id" in body || "userId" in body) {
      return Response.json(
        { error: "client_owner_identifier_not_allowed" },
        { status: 400 },
      );
    }

    try {
      const turn = await dependencies.service.submit(principal.userId, {
        clientEventId: asRequestString(body.clientEventId),
        clientTurnId: asRequestString(body.clientTurnId),
        locale: asRequestString(body.locale),
        text: asRequestString(body.text),
        timezone: asRequestString(body.timezone),
      });
      return Response.json(turn);
    } catch (error) {
      if (error instanceof InvalidUserTextTurnError) {
        return Response.json(
          { error: "invalid_user_text_turn", message: error.message },
          { status: 400 },
        );
      }
      if (error instanceof UserTextOwnerDeniedError) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      if (error instanceof UserTextIdempotencyConflictError) {
        return Response.json(
          { error: "idempotency_key_conflict" },
          { status: 409 },
        );
      }
      if (error instanceof UserTextPrivateWriteDeniedError) {
        return Response.json(
          { error: "private_writes_blocked", reason: error.reason },
          { status: 409 },
        );
      }
      throw error;
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRequestString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
