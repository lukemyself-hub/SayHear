import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { HistoryReviewScript } from "./fixture";

/**
 * Deterministic stand-in for the external Conversation Provider (T00 #313).
 *
 * This is the ONLY substituted part of the chat path: a loopback HTTP server
 * that speaks the OpenAI-compatible Responses API (`POST /responses`, SSE)
 * consumed by the production `responses-api` adapter. SayHear's own Harness,
 * Context Compiler, Provider Egress, persistence and HTTP edge all run
 * unmodified. Every request body the Provider would have received is recorded
 * verbatim, so "what actually left SayHear" is observed at the real boundary
 * instead of inferred from internal selectors.
 *
 * The reply is a fixed, deliberately content-free sentence. It is never
 * derived from the request, the fixture or the oracle: a stub reply is not a
 * model answer and must not be scored as one.
 */

/** The read-only history review function SayHear offers the Decision (#314). */
export const HISTORY_REVIEW_FUNCTION_NAME = "review_conversation_history";

export const DETERMINISTIC_STUB_MODEL = "acceptance-deterministic-stub";

/** Split into several deltas so stream timing and partial delivery are real. */
export const DETERMINISTIC_STUB_REPLY_CHUNKS: readonly string[] = Object.freeze([
  "(deterministic stub reply; ",
  "not a model answer; ",
  "do not score its wording.)",
]);

export type ProviderFault = Readonly<{
  /** Delay before the first byte of the response, in real milliseconds. */
  delayBeforeFirstChunkMs?: number;
  /** Delay between successive chunks, in real milliseconds. */
  delayBetweenChunksMs?: number;
  /** Close the stream without `response.completed` after this many chunks. */
  failAfterChunks?: number;
  /** Answer with this HTTP status instead of a stream. */
  httpStatus?: number;
}>;

export type CapturedProviderRequest = Readonly<{
  body: unknown;
  /**
   * How long the stub held this request open, in real milliseconds (arrival to
   * the response closing), including any fault delay. It is the stand-in
   * Provider's own time, which lets a latency report separate it from
   * SayHear's. Null while the request is still open.
   */
  durationMs: number | null;
  /** Raw request text, kept so oracle-leak scans cannot be defeated by escaping. */
  rawBody: string;
  receivedAtMonotonicMs: number;
  sequence: number;
  /** Label of the scenario step that was active when the request arrived. */
  stepLabel: string | null;
}>;

export type ProviderStub = Readonly<{
  baseUrl: string;
  requests(): readonly CapturedProviderRequest[];
  setFault(fault: ProviderFault | null): void;
  /**
   * While history is being loaded, the stub replays the reply the fixture says
   * was given at the time. `null` restores the fixed stub sentence.
   */
  setHistoricalReply(text: string | null): void;
  /**
   * Script the next Decision: if (and only if) the request offers the
   * read-only history review function, answer with a call to it carrying
   * these local dates instead of text.
   */
  setHistoryReview(script: HistoryReviewScript | null): void;
  setStepLabel(label: string | null): void;
  /**
   * Script the next Decision: if (and only if) the request offers a Function
   * with this name, answer with a call to it carrying these JSON arguments
   * instead of text. Used to reproduce a Trust Action selection (#312).
   */
  setToolCall(script: Readonly<{ argumentsJson: string; name: string }> | null): void;
  stop(): Promise<void>;
}>;

const USAGE = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
});

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startProviderStub(): Promise<ProviderStub> {
  const captured: CapturedProviderRequest[] = [];
  let fault: ProviderFault | null = null;
  let stepLabel: string | null = null;
  let historicalReply: string | null = null;
  let historyReview: HistoryReviewScript | null = null;
  let toolCall: Readonly<{ argumentsJson: string; name: string }> | null = null;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const rawBody = await readBody(request);
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      let body: unknown = null;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = null;
      }
      const sequence = captured.length + 1;
      const entry: { -readonly [K in keyof CapturedProviderRequest]: CapturedProviderRequest[K] } = {
        body,
        durationMs: null,
        rawBody,
        receivedAtMonotonicMs: performance.now(),
        sequence,
        stepLabel,
      };
      captured.push(entry);
      const arrived = entry.receivedAtMonotonicMs;
      response.on("close", () => {
        entry.durationMs = performance.now() - arrived;
      });
      const active = fault;
      if (active?.httpStatus !== undefined) {
        response.writeHead(active.httpStatus).end();
        return;
      }
      if (active?.delayBeforeFirstChunkMs) {
        await sleep(active.delayBeforeFirstChunkMs);
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/event-stream",
        "x-request-id": `stub-request-${sequence}`,
      });
      const send = (event: Record<string, unknown>) =>
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      const offersHistoryReview =
        Array.isArray((body as { tools?: unknown } | null)?.tools) &&
        ((body as { tools: Array<{ name?: unknown }> }).tools).some(
          (tool) => tool?.name === HISTORY_REVIEW_FUNCTION_NAME,
        );
      if (historyReview !== null && offersHistoryReview) {
        const args = JSON.stringify(
          "searchTerms" in historyReview
            ? {
                ...(historyReview.endDate ? { end_date: historyReview.endDate } : {}),
                ...(historyReview.people ? { people: historyReview.people } : {}),
                search_terms: historyReview.searchTerms,
                ...(historyReview.startDate ? { start_date: historyReview.startDate } : {}),
              }
            : {
                end_date: historyReview.endDate,
                start_date: historyReview.startDate,
                ...(historyReview.timeBasis ? { time_basis: historyReview.timeBasis } : {}),
              },
        );
        send({
          item: { arguments: "", call_id: `stub-call-${sequence}`, name: HISTORY_REVIEW_FUNCTION_NAME, type: "function_call" },
          type: "response.output_item.added",
        });
        send({ arguments: args, type: "response.function_call_arguments.done" });
        send({
          response: { id: `stub-response-${sequence}`, model: DETERMINISTIC_STUB_MODEL, usage: USAGE },
          type: "response.completed",
        });
        response.end();
        return;
      }
      const offersToolCall =
        toolCall !== null &&
        Array.isArray((body as { tools?: unknown } | null)?.tools) &&
        ((body as { tools: Array<{ name?: unknown }> }).tools).some(
          (tool) => tool?.name === toolCall!.name,
        );
      if (toolCall !== null && offersToolCall) {
        send({
          item: { arguments: "", call_id: `stub-call-${sequence}`, name: toolCall.name, type: "function_call" },
          type: "response.output_item.added",
        });
        send({ arguments: toolCall.argumentsJson, type: "response.function_call_arguments.done" });
        send({
          response: { id: `stub-response-${sequence}`, model: DETERMINISTIC_STUB_MODEL, usage: USAGE },
          type: "response.completed",
        });
        response.end();
        return;
      }
      const chunks =
        historicalReply === null ? DETERMINISTIC_STUB_REPLY_CHUNKS : [historicalReply];
      for (const [index, delta] of chunks.entries()) {
        if (active?.failAfterChunks !== undefined && index >= active.failAfterChunks) {
          response.destroy();
          return;
        }
        if (index > 0 && active?.delayBetweenChunksMs) {
          await sleep(active.delayBetweenChunksMs);
        }
        if (response.destroyed) return;
        send({ delta, type: "response.output_text.delta" });
      }
      send({
        response: {
          id: `stub-response-${sequence}`,
          model: DETERMINISTIC_STUB_MODEL,
          usage: USAGE,
        },
        type: "response.completed",
      });
      response.end();
    })().catch(() => {
      response.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => [...captured],
    setFault(next) {
      fault = next;
    },
    setHistoricalReply(text) {
      historicalReply = text;
    },
    setHistoryReview(script) {
      historyReview = script;
    },
    setToolCall(script) {
      toolCall = script;
    },
    setStepLabel(label) {
      stepLabel = label;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
