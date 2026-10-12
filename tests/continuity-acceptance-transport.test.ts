import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createOpenCodeGoConversationTextModel } from "@sayhear/ai";
import { describe, expect, it } from "vitest";

import { createAcceptanceClient } from "../eval/continuity-acceptance-301/src/client";
import {
  OPENCODE_GO_ENDPOINT,
  createTappedFetch,
} from "../eval/continuity-acceptance-301/src/egress-tap.mjs";
import { startProviderGate } from "../eval/continuity-acceptance-301/src/provider-gate";

/**
 * T08 #321: the real-model transport. The app under test keeps its production
 * OpenCode Go adapter and its fixed HTTPS endpoint. The only addition is a tap
 * on the app process's own `fetch`: it shows the acceptance run every request
 * body that is about to leave for the Provider, lets the run answer history
 * seeding locally, and copies what the Provider answered. It never weakens
 * TLS and never hands the credential to anything but the Provider.
 */

type Call = { body: string | null; headers: Record<string, string>; url: string };

function recordingFetch(
  answer: (call: Call) => Response | Promise<Response>,
): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (async (resource: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        body: typeof init?.body === "string" ? init.body : null,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        url: String(resource),
      };
      calls.push(call);
      return answer(call);
    }) as typeof fetch,
  };
}

const GATE = "http://127.0.0.1:45678";
const PROVIDER_INIT: RequestInit = {
  body: JSON.stringify({ messages: [{ content: "hello", role: "user" }], model: "deepseek-v4.1-flash" }),
  headers: { authorization: "Bearer provider-credential", "content-type": "application/json" },
  method: "POST",
  redirect: "error",
};

describe("egress tap on the app's own fetch", () => {
  it("leaves every request that is not for the Provider endpoint untouched", async () => {
    const upstream = recordingFetch(() => new Response("ok"));
    const tapped = createTappedFetch({ gateUrl: GATE, original: upstream.fetch });
    const response = await tapped("https://example.invalid/anything", { method: "GET" });
    expect(await response.text()).toBe("ok");
    expect(upstream.calls.map((call) => call.url)).toEqual(["https://example.invalid/anything"]);
  });

  it("shows the run the request body, and nothing else, before anything leaves", async () => {
    const upstream = recordingFetch((call) =>
      call.url.startsWith(GATE)
        ? new Response("data: [DONE]\n\n", { headers: { "x-acceptance-disposition": "served" } })
        : new Response("must not be reached", { status: 500 }),
    );
    const tapped = createTappedFetch({ gateUrl: GATE, original: upstream.fetch });
    const response = await tapped(OPENCODE_GO_ENDPOINT, PROVIDER_INIT);

    // The run answered locally: the Provider was never contacted.
    expect(await response.text()).toBe("data: [DONE]\n\n");
    expect(upstream.calls).toHaveLength(1);
    const preflight = upstream.calls[0]!;
    expect(preflight.url).toBe(`${GATE}/preflight`);
    expect(preflight.body).toBe(PROVIDER_INIT.body);
    // The credential stays with the Provider request; the run never sees it.
    expect(JSON.stringify(preflight.headers)).not.toContain("provider-credential");
    expect(preflight.headers["authorization"]).toBeUndefined();
  });

  it("sends a live request unchanged and copies the Provider's answer to the run", async () => {
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';
    const upstream = recordingFetch((call) => {
      if (call.url === `${GATE}/preflight`) return Response.json({ disposition: "live", sequence: 7 });
      if (call.url.startsWith(`${GATE}/observed/`)) return new Response(null, { status: 204 });
      return new Response(sse, { headers: { "x-request-id": "req-1" }, status: 200 });
    });
    const tapped = createTappedFetch({ gateUrl: GATE, original: upstream.fetch });
    const response = await tapped(OPENCODE_GO_ENDPOINT, PROVIDER_INIT);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(await response.text()).toBe(sse);
    // The copy is posted after the stream ends; let that settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const [, live, observed] = upstream.calls;
    // The Provider received exactly what the adapter built.
    expect(live!.url).toBe(OPENCODE_GO_ENDPOINT);
    expect(live!.body).toBe(PROVIDER_INIT.body);
    expect(live!.headers["authorization"]).toBe("Bearer provider-credential");
    expect(observed!.url).toBe(`${GATE}/observed/7`);
    const report = JSON.parse(observed!.body!) as {
      chunks: { atMs: number; text: string }[];
      outcome: string;
      providerRequestId: string | null;
      status: number;
    };
    expect(report.status).toBe(200);
    expect(report.outcome).toBe("complete");
    expect(report.providerRequestId).toBe("req-1");
    expect(report.chunks.map((chunk) => chunk.text).join("")).toBe(sse);
    expect(JSON.stringify(observed)).not.toContain("provider-credential");
  });

  it("reports a Provider error status and a stream the app gave up on", async () => {
    const reports: Record<string, unknown>[] = [];
    const upstream = recordingFetch((call) => {
      if (call.url === `${GATE}/preflight`) return Response.json({ disposition: "live", sequence: reports.length + 1 });
      if (call.url.startsWith(`${GATE}/observed/`)) {
        reports.push(JSON.parse(call.body!) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      return reports.length === 0
        ? new Response("rate limited", { status: 429 })
        : new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              },
            }),
          );
    });
    const tapped = createTappedFetch({ gateUrl: GATE, original: upstream.fetch });

    const refused = await tapped(OPENCODE_GO_ENDPOINT, PROVIDER_INIT);
    expect(refused.status).toBe(429);
    await refused.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reports[0]).toMatchObject({ outcome: "cancelled", status: 429 });

    const abandoned = await tapped(OPENCODE_GO_ENDPOINT, PROVIDER_INIT);
    const reader = abandoned.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reports[1]).toMatchObject({ outcome: "cancelled", status: 200 });
    expect((reports[1]!["chunks"] as { text: string }[])[0]!.text).toBe("data: first\n\n");
  });

  it("does not send a request the run could not be shown", async () => {
    const upstream = recordingFetch((call) => {
      if (call.url.startsWith(GATE)) throw new TypeError("fetch failed");
      return new Response("must not be reached");
    });
    const tapped = createTappedFetch({ gateUrl: GATE, original: upstream.fetch });
    await expect(tapped(OPENCODE_GO_ENDPOINT, PROVIDER_INIT)).rejects.toThrow(TypeError);
    expect(upstream.calls.every((call) => call.url.startsWith(GATE))).toBe(true);

    // A request whose failure the run must still learn about.
    const failing = recordingFetch((call) => {
      if (call.url === `${GATE}/preflight`) return Response.json({ disposition: "live", sequence: 3 });
      if (call.url.startsWith(`${GATE}/observed/`)) return new Response(null, { status: 204 });
      throw new TypeError("network down");
    });
    await expect(
      createTappedFetch({ gateUrl: GATE, original: failing.fetch })(OPENCODE_GO_ENDPOINT, PROVIDER_INIT),
    ).rejects.toThrow("network down");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(JSON.parse(failing.calls.at(-1)!.body!)).toMatchObject({ outcome: "error", status: null });
  });
});

/**
 * A real model's reply cannot be slowed down by script, so "the person
 * cancels while the answer is still being prepared" is a cancel after a fixed
 * time rather than after a scripted number of deltas.
 */
describe("acceptance client cancellation by elapsed time", () => {
  it("abandons the request after the given time and reports it as a client abort", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(`${JSON.stringify({ generationCommandId: "command-1", type: "user_committed" })}\n`);
      // The answer is never sent: the reply is still being prepared.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const client = createAcceptanceClient({ origin: `http://127.0.0.1:${port}`, sessionToken: "token" });
      const observed = await client.chat({
        abortAfterMs: 150,
        clientEventId: "event",
        clientTurnId: "turn",
        locale: "en-US",
        text: "What did I tell you?",
        timezone: "UTC",
      });
      expect(observed.clientAborted).toBe(true);
      expect(observed.terminalEvent).toBeNull();
      expect(observed.generationCommandId).toBe("command-1");
      expect(observed.timing.streamClosedMs).toBeGreaterThanOrEqual(140);
      expect(observed.timing.streamClosedMs).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * The gate is the run's side of the tap. These tests drive it with the
 * product's real OpenCode Go adapter, so "the wire shape the adapter accepts"
 * is checked by the adapter itself rather than restated here.
 */
describe("provider gate behind the tap", () => {
  const PROVIDER_SSE = [
    { choices: [{ delta: { reasoning_content: "thinking" }, index: 0 }], id: "chatcmpl-1", model: "deepseek-v4.1-flash" },
    { choices: [{ delta: { content: "Hel" }, index: 0 }], id: "chatcmpl-1", model: "deepseek-v4.1-flash" },
    { choices: [{ delta: { content: "lo." }, finish_reason: "stop", index: 0 }], id: "chatcmpl-1", model: "deepseek-v4.1-flash" },
    {
      choices: [],
      id: "chatcmpl-1",
      model: "deepseek-v4.1-flash",
      usage: { completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 4 }, prompt_tokens: 120, total_tokens: 129 },
    },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");

  async function harness() {
    const gate = await startProviderGate();
    const providerCalls: string[] = [];
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "provider-credential",
      fetchImplementation: createTappedFetch({
        gateUrl: gate.baseUrl,
        original: (async (resource: RequestInfo | URL, init?: RequestInit) => {
          if (String(resource).startsWith(gate.baseUrl)) return fetch(resource, init);
          providerCalls.push(String(init?.body));
          return new Response(PROVIDER_SSE, { headers: { "x-request-id": "req-live-1" } });
        }) as typeof fetch,
      }),
    });
    const ask = async (text: string) => {
      let reply = "";
      for await (const event of model.stream({
        instructions: "You are SayHear.",
        locale: "en-US",
        messages: [{ revisionId: "rev-1" as never, role: "user", text }],
        model: "deepseek-v4.1-flash",
        providerSessionId: "session-hash",
      })) {
        if (event.type === "delta") reply += event.delta;
      }
      return reply;
    };
    return { ask, gate, providerCalls };
  }

  it("answers history seeding locally in the adapter's own wire format", async () => {
    const { ask, gate, providerCalls } = await harness();
    try {
      gate.setStepLabel("seed:one");
      gate.setHistoricalReply("That sounds like a long day.");
      expect(await ask("I walked home in the rain.")).toBe("That sounds like a long day.");
      expect(providerCalls).toEqual([]);
      const [request] = gate.requests();
      expect(request).toMatchObject({
        instructions: "You are SayHear.",
        messages: [{ role: "user", text: "I walked home in the rain." }],
        response: null,
        stepLabel: "seed:one",
        transport: "served",
      });
      expect(JSON.stringify(gate.requests())).not.toContain("provider-credential");
    } finally {
      await gate.stop();
    }
  });

  it("lets a live request through once seeding is over and keeps what the Provider answered", async () => {
    const { ask, gate, providerCalls } = await harness();
    try {
      gate.setLive(true);
      gate.setStepLabel("t1");
      expect(await ask("Morning.")).toBe("Hello.");
      await gate.settled();
      expect(providerCalls).toHaveLength(1);
      const [request] = gate.requests();
      expect(request!.transport).toBe("live");
      expect(request!.response).toMatchObject({
        finishReason: "stop",
        model: "deepseek-v4.1-flash",
        outcome: "complete",
        providerRequestId: "req-live-1",
        reasoning: "thinking",
        status: 200,
        text: "Hello.",
        toolCalls: [],
        usage: { inputTokens: 120, outputTokens: 9, reasoningTokens: 4, totalTokens: 129 },
      });
      expect(request!.response!.firstContentMs).toBeGreaterThanOrEqual(0);
      expect(gate.usage()).toEqual({
        inputTokens: 120,
        liveRequests: 1,
        outputTokens: 9,
        requestsWithUnknownUsage: 0,
      });
    } finally {
      await gate.stop();
    }
  });

  it("injects a Provider fault without contacting the Provider", async () => {
    const { ask, gate, providerCalls } = await harness();
    try {
      gate.setLive(true);
      gate.setFault({ httpStatus: 503 });
      await expect(ask("Morning.")).rejects.toMatchObject({ category: "unavailable" });
      expect(providerCalls).toEqual([]);
      expect(gate.requests()[0]!.transport).toBe("fault");

      // A Provider that never answers: the request waits at the gate, is not
      // sent, and ends when the app gives up on it.
      gate.setFault({ delayBeforeFirstChunkMs: 60_000 });
      const controller = new AbortController();
      const stalled = createTappedFetch({ gateUrl: gate.baseUrl, original: fetch })(
        OPENCODE_GO_ENDPOINT,
        { ...PROVIDER_INIT, signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 50);
      await expect(stalled).rejects.toThrow();
      expect(gate.requests()[1]!.transport).toBe("fault");
      expect(gate.usage().liveRequests).toBe(0);
    } finally {
      await gate.stop();
    }
  });
});
