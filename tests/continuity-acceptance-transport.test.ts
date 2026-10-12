import { describe, expect, it } from "vitest";

import {
  OPENCODE_GO_ENDPOINT,
  createTappedFetch,
} from "../eval/continuity-acceptance-301/src/egress-tap.mjs";

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
