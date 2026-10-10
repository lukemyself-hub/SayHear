/**
 * HTTP client for the acceptance runner (T00 #313). It talks only to the same
 * authenticated routes the Portal uses: the NDJSON chat stream, the history
 * read endpoints and the controlled generation Inspector. It holds no database
 * handle and never calls a Provider.
 */

export const SESSION_COOKIE_NAME = "sayhear.session-token";

export type StreamEventRecord = Readonly<{
  elapsedMs: number;
  event: Readonly<Record<string, unknown>>;
}>;

export type ChatSubmission = Readonly<{
  /** Abort the client connection after this many assistant deltas. */
  abortAfterDeltas?: number;
  clientEventId: string;
  clientTurnId: string;
  locale: string;
  text: string;
  timeoutMs?: number;
  timezone: string;
}>;

/**
 * `clientObservedEndToEndMs` etc. are CLI network timings. They say when bytes
 * reached this process, not when a person saw rendered text in a browser; the
 * report labels them accordingly (browser timing is T08's scope).
 */
export type ChatObservation = Readonly<{
  clientAborted: boolean;
  events: readonly StreamEventRecord[];
  generationCommandId: string | null;
  httpStatus: number;
  streamedText: string;
  /** Last terminal-looking event type, or null for a truncated stream. */
  terminalEvent: string | null;
  timing: Readonly<{
    acceptedMs: number | null;
    committedMs: number | null;
    /**
     * First non-whitespace assistant text. A first delta is only a candidate
     * for "first meaningful response"; the semantic judgement needs the delta
     * timeline below.
     */
    firstVisibleTextMs: number | null;
    streamClosedMs: number;
  }>;
}>;

export type HistoryMessage = Readonly<{
  actor: string;
  createdAt?: string;
  sequence?: number;
  text: string;
}> &
  Readonly<Record<string, unknown>>;

export type HistoryDate = Readonly<{
  dailySessionId: string;
  logicalDate: string;
}> &
  Readonly<Record<string, unknown>>;

export type AcceptanceClient = Readonly<{
  chat(submission: ChatSubmission): Promise<ChatObservation>;
  dates(): Promise<readonly HistoryDate[]>;
  inspect(generationCommandId: string): Promise<Readonly<Record<string, unknown>>>;
  messages(dailySessionId: string): Promise<readonly HistoryMessage[]>;
}>;

const TERMINAL_EVENTS = new Set([
  "assistant_committed",
  "response_failed",
  "response_interrupted",
]);

export function createAcceptanceClient(input: {
  origin: string;
  sessionToken: string;
}): AcceptanceClient {
  const headers = {
    "content-type": "application/json",
    cookie: `${SESSION_COOKIE_NAME}=${input.sessionToken}`,
  };

  async function getJson(pathAndQuery: string): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(pathAndQuery, input.origin), {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`SayHear HTTP ${response.status} for ${pathAndQuery.split("?")[0]}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async function pages<T>(
    route: string,
    key: string,
    query: Record<string, string>,
  ): Promise<T[]> {
    const rows: T[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 200; page += 1) {
      const parameters = new URLSearchParams(query);
      if (cursor !== null) parameters.set("cursor", cursor);
      const data = await getJson(`${route}?${parameters}`);
      const batch = data[key];
      const next = data["nextCursor"];
      if (!Array.isArray(batch) || !(next === null || typeof next === "string")) {
        throw new Error(`Invalid SayHear history page from ${route}.`);
      }
      rows.push(...(batch as T[]));
      if (next === null) return rows;
      if (seen.has(next)) throw new Error("Repeated history cursor; read stopped.");
      seen.add(next);
      cursor = next;
    }
    throw new Error("History exceeds 200 pages; refusing to return a partial read.");
  }

  return {
    async chat(submission) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        submission.timeoutMs ?? 30_000,
      );
      // Timing starts before the request leaves this process.
      const started = performance.now();
      const events: StreamEventRecord[] = [];
      let streamedText = "";
      let deltaCount = 0;
      let acceptedMs: number | null = null;
      let firstVisibleTextMs: number | null = null;
      let committedMs: number | null = null;
      let terminalEvent: string | null = null;
      let generationCommandId: string | null = null;
      let clientAborted = false;
      let httpStatus = 0;
      try {
        const response = await fetch(
          new URL("/api/internal/conversation/responses", input.origin),
          {
            body: JSON.stringify({
              clientEventId: submission.clientEventId,
              clientTurnId: submission.clientTurnId,
              locale: submission.locale,
              text: submission.text,
              timezone: submission.timezone,
            }),
            headers,
            method: "POST",
            signal: controller.signal,
          },
        );
        httpStatus = response.status;
        if (!response.ok || !response.body) {
          await response.body?.cancel();
        } else {
          const decoder = new TextDecoder();
          let pending = "";
          const accept = (line: string) => {
            if (!line.trim()) return;
            const event = JSON.parse(line) as Record<string, unknown>;
            const elapsedMs = performance.now() - started;
            events.push({ elapsedMs, event });
            const type = String(event["type"]);
            if (acceptedMs === null) acceptedMs = elapsedMs;
            if (typeof event["generationCommandId"] === "string") {
              generationCommandId = event["generationCommandId"];
            }
            if (type === "assistant_delta" && typeof event["delta"] === "string") {
              streamedText += event["delta"];
              deltaCount += 1;
              if (firstVisibleTextMs === null && streamedText.trim()) {
                firstVisibleTextMs = elapsedMs;
              }
            }
            if (type === "assistant_committed") committedMs = elapsedMs;
            if (TERMINAL_EVENTS.has(type)) terminalEvent = type;
          };
          reading: for await (const chunk of response.body) {
            pending += decoder.decode(chunk as Uint8Array, { stream: true });
            let boundary: number;
            while ((boundary = pending.indexOf("\n")) !== -1) {
              accept(pending.slice(0, boundary));
              pending = pending.slice(boundary + 1);
              if (
                submission.abortAfterDeltas !== undefined &&
                deltaCount >= submission.abortAfterDeltas &&
                terminalEvent === null
              ) {
                clientAborted = true;
                controller.abort();
                break reading;
              }
            }
          }
          if (!clientAborted) {
            pending += decoder.decode();
            if (pending.trim()) accept(pending);
          }
        }
      } catch (error) {
        if (!clientAborted && !controller.signal.aborted) throw error;
        clientAborted = true;
      } finally {
        clearTimeout(timeout);
      }
      return {
        clientAborted,
        events,
        generationCommandId,
        httpStatus,
        streamedText,
        terminalEvent,
        timing: {
          acceptedMs,
          committedMs,
          firstVisibleTextMs,
          streamClosedMs: performance.now() - started,
        },
      };
    },
    dates: () => pages<HistoryDate>("/api/internal/conversation/dates", "entries", {}),
    inspect: (generationCommandId) =>
      getJson(
        `/api/internal/inspection/generation?${new URLSearchParams({
          generation_command_id: generationCommandId,
        })}`,
      ),
    messages: (dailySessionId) =>
      pages<HistoryMessage>("/api/internal/conversation/messages", "messages", {
        // The API requires an exclusive position for its first older page.
        beforeSequence: String(Number.MAX_SAFE_INTEGER),
        dailySessionId,
      }),
  };
}
