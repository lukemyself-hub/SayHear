import type { ConversationResponseService, UserId } from "@sayhear/application";

import { createNdjsonConversationResponse } from "./ndjson-response";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

export function createConversationRetryHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
  /** End-to-end request budget, as for the chat route (issue #319). */
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
      originalTurnId: asRequestString(body.originalTurnId),
      retryRequestId: asRequestString(body.retryRequestId),
    };
    return createNdjsonConversationResponse({
      events: (signal) =>
        dependencies.service.retry(principal.userId, input, signal),
      onFailure() {
        // The terminal event already tells the client; nothing private is logged.
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
