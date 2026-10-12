import type { ConversationResponseStreamEvent } from "@sayhear/application";

/** Slack after the budget before the boundary gives up on the service. */
export const WATCHDOG_GRACE_MS = 500;

/**
 * Streams conversation events to the client as NDJSON (the Web/BFF transport
 * shared by the chat and Retry routes).
 *
 * `requestBudgetMs` is the end-to-end budget of the request (ADR-0152: 30
 * seconds). The service enforces it at every step; this boundary adds its own
 * last line of defense: if the service has still not finished shortly after
 * the budget (for example a database call that never returns), the stream
 * ends with an explicit timeout and the service is told to cancel, instead of
 * the connection staying open (issue #319). A client disconnect cancels the
 * service as well.
 */
export function createNdjsonConversationResponse(input: {
  events(signal: AbortSignal): AsyncIterable<ConversationResponseStreamEvent>;
  /** Called with the unexpected failure; must not throw. */
  onFailure(error: unknown): void;
  requestBudgetMs?: number;
}): Response {
  const abortController = new AbortController();
  const encoder = new TextEncoder();
  let closed = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      closed = true;
      clearTimeout(watchdog);
      abortController.abort();
    },
    start(controller) {
      const send = (event: ConversationResponseStreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      if (input.requestBudgetMs !== undefined) {
        watchdog = setTimeout(() => {
          if (closed) return;
          closed = true;
          abortController.abort();
          try {
            send({ category: "timeout", type: "response_failed" });
            controller.close();
          } catch {
            // The client may already have gone away.
          }
        }, input.requestBudgetMs + WATCHDOG_GRACE_MS);
        watchdog.unref?.();
      }
      void (async () => {
        try {
          for await (const event of input.events(abortController.signal)) {
            if (closed) break;
            send(event);
          }
        } catch (error) {
          input.onFailure(error);
          abortController.abort();
          if (!closed) {
            try {
              send({ category: "unknown", type: "response_failed" });
            } catch {
              // Cancellation may already have closed the response stream.
            }
          }
        } finally {
          clearTimeout(watchdog);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // The client may already have canceled the stream.
            }
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
}
