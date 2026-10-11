import {
  ProviderDispatchError,
  type ConversationResponseService,
  type UserId,
} from "@sayhear/application";

import { createNdjsonConversationResponse } from "./ndjson-response";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

export function createConversationResponseHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  /**
   * End-to-end request budget (ADR-0151: 30 seconds), enforced by the service
   * at every step and backstopped here (issue #319).
   */
  requestBudgetMs?: number;
  service: ConversationResponseService;
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

    const input = {
      clientEventId: asRequestString(body.clientEventId),
      clientTurnId: asRequestString(body.clientTurnId),
      locale: asRequestString(body.locale),
      text: asRequestString(body.text),
      timezone: asRequestString(body.timezone),
    };
    return createNdjsonConversationResponse({
      events: (signal) =>
        dependencies.service.respond(principal.userId, input, signal),
      onFailure(error) {
        // Surface the egress failure server-side. Without this, the only
        // signal is the graceful `response_failed` event the client sees,
        // leaving the root cause (e.g. a blocked provider policy) invisible.
        console.error(
          "conversation_response_failed",
          error instanceof ProviderDispatchError
            ? {
                name: error.name,
                category: error.category,
                message: error.message,
              }
            : {
                name: error instanceof Error ? error.name : typeof error,
                message: error instanceof Error ? error.message : String(error),
              },
        );
      },
      ...(dependencies.requestBudgetMs === undefined
        ? {}
        : { requestBudgetMs: dependencies.requestBudgetMs }),
    });
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRequestString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
