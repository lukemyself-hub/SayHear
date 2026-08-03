import {
  ProviderDispatchError,
  type ConversationResponseService,
  type ConversationResponseStreamEvent,
  type UserId,
} from "@sayhear/application";

type AuthenticatedPrincipal = Readonly<{ userId: UserId }>;

export function createConversationResponseHandler(dependencies: {
  authenticate(request: Request): Promise<AuthenticatedPrincipal | null>;
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
    const abortController = new AbortController();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        abortController.abort();
      },
      start(controller) {
        void (async () => {
          try {
            for await (const event of dependencies.service.respond(
              principal.userId,
              input,
              abortController.signal,
            )) {
              controller.enqueue(encoder.encode(serializeEvent(event)));
            }
          } catch (error) {
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
                    name:
                      error instanceof Error ? error.name : typeof error,
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
            );
            abortController.abort();
            try {
              controller.enqueue(
                encoder.encode(
                  serializeEvent({
                    category: "unknown",
                    type: "response_failed",
                  }),
                ),
              );
            } catch {
              // Cancellation may already have closed the response stream.
            }
          } finally {
            try {
              controller.close();
            } catch {
              // The client may already have canceled the stream.
            }
          }
        })();
      },
    });

    return new Response(stream, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/x-ndjson; charset=utf-8",
      },
      status: 200,
    });
  };
}

function serializeEvent(event: ConversationResponseStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRequestString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
