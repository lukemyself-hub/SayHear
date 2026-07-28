import {
  ContinuousExchangeNotFoundError,
  InvalidUserTextTurnError,
  type UserId,
  type UserTextConversationService,
} from "@sayhear/application";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

export function createContinuousExchangeEndHandler(dependencies: {
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

    try {
      const end = await dependencies.service.endContinuousExchange(
        principal.userId,
        {
          dailySessionId:
            typeof body.dailySessionId === "string"
              ? body.dailySessionId
              : "",
        },
      );
      return Response.json(end);
    } catch (error) {
      if (error instanceof InvalidUserTextTurnError) {
        return Response.json(
          { error: "invalid_continuous_exchange_end" },
          { status: 400 },
        );
      }
      if (error instanceof ContinuousExchangeNotFoundError) {
        return Response.json(
          { error: "continuous_exchange_not_found" },
          { status: 404 },
        );
      }
      throw error;
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
