/**
 * Egress tap for real-model acceptance runs (T08 #321).
 *
 * Loaded into the app under test with `node --import` (see `app-server.ts`).
 * It is plain JavaScript because the app process has no TypeScript loader.
 *
 * The app keeps its production OpenCode Go adapter and that adapter's fixed
 * HTTPS endpoint; nothing here changes the request, the endpoint, TLS
 * verification or the credential. The tap only sits on the process's own
 * `fetch` and, for requests to that one endpoint:
 *
 *   1. shows the acceptance run the request body before anything leaves
 *      (`POST <gate>/preflight`, body only — never the headers, so the
 *      credential stays with the Provider request);
 *   2. if the run answers locally (history seeding, an injected fault), hands
 *      that answer back and never contacts the Provider;
 *   3. otherwise sends the original request unchanged and copies what the
 *      Provider answered, with arrival times, to the run
 *      (`POST <gate>/observed/<sequence>`).
 *
 * It fails closed: if the run cannot be shown a request, the request is not
 * sent, so no paid call can go unobserved or unbilled in the ledger.
 */

export const OPENCODE_GO_ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";

export const GATE_VARIABLE = "SAYHEAR_ACCEPTANCE_EGRESS_GATE";

function urlOf(resource) {
  if (typeof resource === "string") return resource;
  if (resource instanceof URL) return resource.href;
  return typeof resource?.url === "string" ? resource.url : "";
}

/**
 * @param {{ gateUrl: string, original: typeof fetch }} input
 * @returns {typeof fetch}
 */
export function createTappedFetch(input) {
  const { gateUrl, original } = input;
  return async function tappedFetch(resource, init) {
    if (urlOf(resource) !== OPENCODE_GO_ENDPOINT) return original(resource, init);
    if (typeof init?.body !== "string") {
      throw new TypeError("Acceptance egress tap: the Provider request body is not text.");
    }
    const started = performance.now();
    const preflight = await original(`${gateUrl}/preflight`, {
      body: init.body,
      headers: { "content-type": "application/json" },
      method: "POST",
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (preflight.headers.get("x-acceptance-disposition") === "served") return preflight;
    const directive = await preflight.json().catch(() => null);
    if (directive?.disposition !== "live" || !Number.isInteger(directive.sequence)) {
      throw new TypeError("Acceptance egress tap: the run did not answer this request.");
    }

    // Times are relative to the moment the adapter called fetch, on this
    // process's monotonic clock.
    const chunks = [];
    const decoder = new TextDecoder();
    let reported = false;
    const report = (outcome, status, providerRequestId) => {
      if (reported) return;
      reported = true;
      void original(`${gateUrl}/observed/${directive.sequence}`, {
        body: JSON.stringify({
          chunks,
          endedMs: performance.now() - started,
          outcome,
          providerRequestId,
          sentMs,
          status,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
    };

    const sentMs = performance.now() - started;
    let response;
    try {
      response = await original(resource, init);
    } catch (error) {
      report("error", null, null);
      throw error;
    }
    const providerRequestId = response.headers.get("x-request-id");
    if (!response.body) {
      report("complete", response.status, providerRequestId);
      return response;
    }
    const reader = response.body.getReader();
    const copied = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            report("complete", response.status, providerRequestId);
            controller.close();
            return;
          }
          chunks.push({
            atMs: performance.now() - started,
            text: decoder.decode(value, { stream: true }),
          });
          controller.enqueue(value);
        } catch (error) {
          report("error", response.status, providerRequestId);
          controller.error(error);
        }
      },
      cancel(reason) {
        report("cancelled", response.status, providerRequestId);
        return reader.cancel(reason);
      },
    });
    return new Response(copied, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

// Installed only when the acceptance run names its loopback gate.
const configuredGate = globalThis.process?.env?.[GATE_VARIABLE];
if (configuredGate) {
  const gate = new URL(configuredGate);
  if (gate.protocol !== "http:" || gate.hostname !== "127.0.0.1") {
    throw new Error(`${GATE_VARIABLE} must be a loopback http origin.`);
  }
  globalThis.fetch = createTappedFetch({
    gateUrl: gate.origin,
    original: globalThis.fetch,
  });
}
