import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  DETERMINISTIC_STUB_REPLY_CHUNKS,
  type CapturedProviderRequest,
  type ProviderFault,
  type ProviderStub,
} from "./provider-stub";

/**
 * The acceptance run's side of the egress tap (T08 #321).
 *
 * In a real-model run the app under test uses its production OpenCode Go
 * adapter. `egress-tap.mjs`, loaded into the app process, shows this gate each
 * request body before it leaves. The gate records it, and then either
 *
 *   - answers it locally in the Chat Completions wire format (history seeding
 *     replays the reply the fixture says was given then; an injected fault
 *     answers with the fault), or
 *   - tells the tap to send it to the real Provider unchanged, and later
 *     receives a copy of what the Provider answered.
 *
 * Which of the two happened is recorded per request (`transport`), so a reply
 * that did not come from the real model can never be scored as one. A scripted
 * Decision (`setHistoryReview` / `setToolCall`) has no effect here: in a
 * real-model run the model makes its own Decision.
 */

/** The only model the OpenCode Go adapter accepts in a response. */
export const OPENCODE_GO_MODEL = "deepseek-v4.1-flash";
export const REAL_MODEL_IDENTITY = `opencode-go/${OPENCODE_GO_MODEL}`;

export type GateTransport = "served" | "live" | "fault";

/**
 * A copy of one real Provider answer. Times are milliseconds on the app
 * process's monotonic clock, counted from the adapter's `fetch` call.
 */
export type GateResponse = Readonly<{
  endedMs: number;
  finishReason: string | null;
  firstByteMs: number | null;
  /** First visible answer text (not reasoning, not a tool call). */
  firstContentMs: number | null;
  firstReasoningMs: number | null;
  model: string | null;
  outcome: "complete" | "cancelled" | "error";
  providerRequestId: string | null;
  /** `reasoning_content` the Provider streamed; the product discards it. */
  reasoning: string;
  /** When the request left for the Provider (the tap's own overhead before it). */
  sentMs: number;
  status: number | null;
  text: string;
  toolCalls: readonly Readonly<{ arguments: string; name: string }>[];
  /** Null when the Provider reported no usage: unknown, never zero. */
  usage: Readonly<{
    cachedTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
  }> | null;
}>;

export type GateRequest = CapturedProviderRequest &
  Readonly<{
    instructions: string;
    messages: readonly Readonly<{ role: string; text: string }>[];
    /** What the real Provider answered; null unless `transport` is `live` and it has ended. */
    response: GateResponse | null;
    toolsOffered: readonly string[];
    transport: GateTransport;
  }>;

export type GateUsage = Readonly<{
  inputTokens: number;
  liveRequests: number;
  outputTokens: number;
  /** Live requests whose usage the Provider never reported (failed, cut off). */
  requestsWithUnknownUsage: number;
}>;

export type ProviderGate = Omit<ProviderStub, "requests"> &
  Readonly<{
    requests(): readonly GateRequest[];
    /**
     * After seeding: requests that no local answer claims go to the real
     * Provider. Off by default, so nothing is paid for until the run says so.
     */
    setLive(live: boolean): void;
    /** Resolves when every live request has reported how it ended. */
    settled(timeoutMs?: number): Promise<void>;
    /** Token usage of every live request so far, for the cost ledger. */
    usage(): GateUsage;
  }>;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Instructions, messages and offered tools of a Chat Completions request. */
function describeChatRequest(
  body: unknown,
): Pick<GateRequest, "instructions" | "messages" | "toolsOffered"> {
  const all = (
    Array.isArray(record(body)?.["messages"]) ? (record(body)!["messages"] as unknown[]) : []
  )
    .map(record)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const system = all[0]?.["role"] === "system" ? all[0] : null;
  const tools = record(body)?.["tools"];
  return {
    instructions: typeof system?.["content"] === "string" ? system["content"] : "",
    messages: all.slice(system ? 1 : 0).map((entry) => ({
      role: String(entry["role"]),
      text:
        typeof entry["content"] === "string"
          ? entry["content"]
          : JSON.stringify(entry["tool_calls"] ?? entry["content"] ?? null),
    })),
    toolsOffered: (Array.isArray(tools) ? tools : [])
      .map((tool) => record(record(tool)?.["function"])?.["name"])
      .filter((name): name is string => typeof name === "string"),
  };
}

/** Reduce the copied Chat Completions stream to what the report needs. */
export function summarizeProviderAnswer(input: {
  chunks: readonly Readonly<{ atMs: number; text: string }>[];
  endedMs: number;
  outcome: GateResponse["outcome"];
  providerRequestId: string | null;
  sentMs: number;
  status: number | null;
}): GateResponse {
  let text = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let model: string | null = null;
  let usage: GateResponse["usage"] = null;
  let firstContentMs: number | null = null;
  let firstReasoningMs: number | null = null;
  const calls = new Map<number, { arguments: string; name: string }>();
  let pending = "";
  for (const chunk of input.chunks) {
    pending += chunk.text;
    let boundary: number;
    while ((boundary = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, boundary).trim();
      pending = pending.slice(boundary + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let event: Record<string, unknown> | null;
      try {
        event = record(JSON.parse(data));
      } catch {
        event = null;
      }
      if (!event) continue;
      if (typeof event["model"] === "string") model = event["model"];
      const reported = record(event["usage"]);
      if (reported) {
        usage = {
          cachedTokens:
            count(record(reported["prompt_tokens_details"])?.["cached_tokens"]) ??
            count(reported["prompt_cache_hit_tokens"]),
          inputTokens: count(reported["prompt_tokens"]),
          outputTokens: count(reported["completion_tokens"]),
          reasoningTokens: count(
            record(reported["completion_tokens_details"])?.["reasoning_tokens"],
          ),
          totalTokens: count(reported["total_tokens"]),
        };
      }
      const choice = record((Array.isArray(event["choices"]) ? event["choices"] : [])[0]);
      const delta = record(choice?.["delta"]);
      if (typeof delta?.["content"] === "string" && delta["content"].length > 0) {
        text += delta["content"];
        firstContentMs ??= chunk.atMs;
      }
      if (
        typeof delta?.["reasoning_content"] === "string" &&
        delta["reasoning_content"].length > 0
      ) {
        reasoning += delta["reasoning_content"];
        firstReasoningMs ??= chunk.atMs;
      }
      for (const fragment of Array.isArray(delta?.["tool_calls"]) ? delta["tool_calls"] : []) {
        const part = record(fragment);
        const index = count(part?.["index"]) ?? 0;
        const call = calls.get(index) ?? { arguments: "", name: "" };
        const fn = record(part?.["function"]);
        if (typeof fn?.["name"] === "string") call.name += fn["name"];
        if (typeof fn?.["arguments"] === "string") call.arguments += fn["arguments"];
        calls.set(index, call);
      }
      if (typeof choice?.["finish_reason"] === "string") finishReason = choice["finish_reason"];
    }
  }
  return {
    endedMs: input.endedMs,
    finishReason,
    firstByteMs: input.chunks[0]?.atMs ?? null,
    firstContentMs,
    firstReasoningMs,
    model,
    outcome: input.outcome,
    providerRequestId: input.providerRequestId,
    reasoning,
    sentMs: input.sentMs,
    status: input.status,
    text,
    toolCalls: [...calls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map((entry) => entry[1]),
    usage,
  };
}

export async function startProviderGate(): Promise<ProviderGate> {
  type Entry = { -readonly [K in keyof GateRequest]: GateRequest[K] };
  const captured: Entry[] = [];
  let stepLabel: string | null = null;
  let historicalReply: string | null = null;
  let live = false;
  let fault: ProviderFault | null = null;
  /** Live requests that have not yet reported how they ended. */
  const open = new Set<number>();

  const server: Server = createServer((request, response) => {
    void (async () => {
      const rawBody = await readBody(request);
      const observed = /^\/observed\/(\d+)$/.exec(request.url ?? "");
      if (request.method === "POST" && observed) {
        const entry = captured[Number(observed[1]) - 1];
        if (entry?.transport === "live") {
          entry.response = summarizeProviderAnswer(JSON.parse(rawBody));
          open.delete(entry.sequence);
        }
        response.writeHead(204).end();
        return;
      }
      if (request.method !== "POST" || request.url !== "/preflight") {
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
      const entry: Entry = {
        ...describeChatRequest(body),
        body,
        durationMs: null,
        rawBody,
        receivedAtMonotonicMs: performance.now(),
        response: null,
        sequence,
        stepLabel,
        transport: "served",
      };
      captured.push(entry);
      response.on("close", () => {
        entry.durationMs = performance.now() - entry.receivedAtMonotonicMs;
      });

      // Injected faults are answered here and never reach the Provider. Only
      // the two that need no scripted answer exist in this mode: an HTTP error
      // status, and a Provider that does not answer for a while.
      const active = fault;
      if (active?.httpStatus !== undefined) {
        entry.transport = "fault";
        response
          .writeHead(active.httpStatus, { "x-acceptance-disposition": "served" })
          .end();
        return;
      }
      if (active?.delayBeforeFirstChunkMs) {
        entry.transport = "fault";
        const gaveUp = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), active.delayBeforeFirstChunkMs);
          response.once("close", () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        if (gaveUp) return;
        entry.transport = "served";
      }

      // A turn of seeded history is always replayed, even after seeding.
      if (live && historicalReply === null) {
        entry.transport = "live";
        open.add(sequence);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ disposition: "live", sequence }));
        return;
      }

      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/event-stream",
        "x-acceptance-disposition": "served",
        "x-request-id": `gate-request-${sequence}`,
      });
      const send = (chunk: Record<string, unknown>) =>
        response.write(
          `data: ${JSON.stringify({ id: `gate-response-${sequence}`, model: OPENCODE_GO_MODEL, ...chunk })}\n\n`,
        );
      const chunks =
        historicalReply === null ? DETERMINISTIC_STUB_REPLY_CHUNKS : [historicalReply];
      for (const [index, content] of chunks.entries()) {
        send({
          choices: [
            {
              delta: { content },
              ...(index === chunks.length - 1 ? { finish_reason: "stop" } : {}),
              index: 0,
            },
          ],
        });
      }
      send({ choices: [], usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 } });
      response.write("data: [DONE]\n\n");
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
    setFault(next: ProviderFault | null) {
      fault = next;
    },
    setHistoricalReply(text) {
      historicalReply = text;
    },
    // A real-model run makes its own Decision; scripts never act here.
    setHistoryReview() {},
    setLive(next) {
      live = next;
    },
    setStepLabel(label) {
      stepLabel = label;
    },
    setToolCall() {},
    async settled(timeoutMs = 5_000) {
      for (let waited = 0; open.size > 0 && waited < timeoutMs; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    usage() {
      const liveRequests = captured.filter((entry) => entry.transport === "live");
      return {
        inputTokens: liveRequests.reduce(
          (total, entry) => total + (entry.response?.usage?.inputTokens ?? 0),
          0,
        ),
        liveRequests: liveRequests.length,
        outputTokens: liveRequests.reduce(
          (total, entry) => total + (entry.response?.usage?.outputTokens ?? 0),
          0,
        ),
        requestsWithUnknownUsage: liveRequests.filter(
          (entry) =>
            entry.response?.usage?.inputTokens == null ||
            entry.response.usage.outputTokens == null,
        ).length,
      };
    },
  };
}
