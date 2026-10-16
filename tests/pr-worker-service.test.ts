import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  capturePrWorkerServiceIdentity,
  observePrWorkerSession,
  probePrWorkerSession,
  requestPrWorkerSessionStop,
  type PrWorkerServiceFetch,
  type PrWorkerServiceFetchInit,
  type PrWorkerServiceIdentity,
} from "../scripts/pr-worker-service.ts";

// Deterministic offline fixtures: the fake fetch is the only thing that can
// reach the network, and the credential file is a real temp file with mode
// 0600. No test may read the real ~/.config/opencode credential path.
const SERVICE: PrWorkerServiceIdentity = { pid: 22931, version: "2.0.30" };
const SESSION = "ses_worker_1";
const PASSWORD = "fixture-password-do-not-log";

type Reply = { status?: number; body?: unknown; text?: string; fail?: Error };

type Call = { url: string; init: PrWorkerServiceFetchInit };

function fakeFetch(routes: Array<{ method: string; path: string; replies: Reply[] }>): {
  calls: Call[];
  fetchImpl: PrWorkerServiceFetch;
} {
  const calls: Call[] = [];
  const used = new Map<string, number>();
  const fetchImpl: PrWorkerServiceFetch = (url, init) => {
    const parsed = new URL(url);
    const key = `${init.method} ${parsed.pathname}`;
    const route = routes.find((candidate) => `${candidate.method} ${candidate.path}` === key);
    if (route === undefined) {
      return Promise.reject(new Error(`unexpected request ${key}`));
    }
    calls.push({ url, init });
    const index = used.get(key) ?? 0;
    used.set(key, index + 1);
    const reply = route.replies[Math.min(index, route.replies.length - 1)] ?? {};
    if (reply.fail !== undefined) {
      return Promise.reject(reply.fail);
    }
    const status = reply.status ?? 200;
    const body = reply.text ?? JSON.stringify(reply.body ?? {});
    return Promise.resolve(new Response(body, { status }));
  };
  return { calls, fetchImpl };
}

function jsonReply(body: unknown): Reply {
  return { body };
}

let directory: string;
let credentialFile: string;

beforeEach(async () => {
  directory = await mkdtemp(join(realpathSync(tmpdir()), "pr-worker-service-"));
  credentialFile = join(directory, "password");
  await writeFile(credentialFile, `${PASSWORD}\n`, { mode: 0o600 });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function config(fetchImpl: PrWorkerServiceFetch, baseUrl = "http://127.0.0.1:4096") {
  return { baseUrl, credentialFile, fetch: fetchImpl, timeoutMs: 500 };
}

function observationRoutes(active: unknown, identities: PrWorkerServiceIdentity[] = [SERVICE]) {
  return [
    { method: "GET", path: "/api/info", replies: identities.map(jsonReply) },
    { method: "GET", path: "/api/session/active", replies: [jsonReply(active)] },
    { method: "GET", path: "/api/info", replies: identities.map(jsonReply) },
  ];
}

describe("observePrWorkerSession reports known states only from one bracketed instance", () => {
  it("reports running for a known session under a stable instance", async () => {
    const fake = fakeFetch(observationRoutes({ data: { [SESSION]: { type: "running" } } }));
    const observation = await observePrWorkerSession(config(fake.fetchImpl), SESSION);
    expect(observation).toEqual({ known: true, service: SERVICE, target: "running" });
    expect(fake.calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /api/info",
      "GET /api/session/active",
      "GET /api/info",
    ]);
    for (const call of fake.calls) {
      expect(call.init.redirect).toBe("manual");
      expect(new URL(call.url).hostname).toBe("127.0.0.1");
      expect(call.init.headers.authorization).toBe(
        `Basic ${Buffer.from(`opencode:${PASSWORD}`, "utf8").toString("base64")}`,
      );
    }
  });

  it("reports stopped only when the session is absent from a valid fresh map", async () => {
    const fake = fakeFetch(observationRoutes({ data: { ses_other: { type: "running" } } }));
    const observation = await observePrWorkerSession(config(fake.fetchImpl), SESSION);
    expect(observation).toEqual({ known: true, service: SERVICE, target: "stopped" });
  });

  it("rejects an observation torn by a service restart during the read", async () => {
    const restarted: PrWorkerServiceIdentity = { pid: 22999, version: "2.0.30" };
    const fake = fakeFetch([
      { method: "GET", path: "/api/info", replies: [jsonReply(SERVICE), jsonReply(restarted)] },
      { method: "GET", path: "/api/session/active", replies: [jsonReply({ data: {} })] },
    ]);
    const observation = await observePrWorkerSession(config(fake.fetchImpl), SESSION);
    expect(observation.known).toBe(false);
    expect(observation.known === false && observation.reason).toBe("instance_changed");
  });

  it("refuses to conclude anything when no known session is bound", async () => {
    const fake = fakeFetch(observationRoutes({ data: {} }));
    const observation = await observePrWorkerSession(config(fake.fetchImpl), null);
    expect(observation.known).toBe(false);
    expect(observation.known === false && observation.reason).toBe("session_unknown");
    expect(fake.calls).toHaveLength(0);
  });

  it("treats a malformed active map and an unknown session state as unknown", async () => {
    const malformed = fakeFetch(observationRoutes({ data: { [SESSION]: "running" } }));
    const malformedResult = await observePrWorkerSession(config(malformed.fetchImpl), SESSION);
    expect(malformedResult.known === false && malformedResult.reason).toBe("malformed_payload");

    const oddState = fakeFetch(observationRoutes({ data: { [SESSION]: { type: "waiting" } } }));
    const oddResult = await observePrWorkerSession(config(oddState.fetchImpl), SESSION);
    expect(oddResult.known === false && oddResult.reason).toBe("session_not_running");
  });

  it.each([
    ["a remote http host", "http://service.example.com:4096"],
    ["a https loopback URL", "https://127.0.0.1:4096"],
    ["a loopback URL with a path prefix", "http://127.0.0.1:4096/proxy"],
    ["an unparsable base URL", "not-a-url"],
  ])("refuses %s before any credential is read", async (_label, baseUrl) => {
    const fake = fakeFetch(observationRoutes({ data: {} }));
    const result = await observePrWorkerSession(config(fake.fetchImpl, baseUrl), SESSION);
    expect(result.known === false && result.reason).toBe("endpoint_not_loopback");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("probePrWorkerSession requires the identity captured before dispatch", () => {
  it("reports running and stopped only for the expected instance", async () => {
    const running = fakeFetch(observationRoutes({ data: { [SESSION]: { type: "running" } } }));
    await expect(probePrWorkerSession(config(running.fetchImpl), { expectedService: SERVICE, sessionId: SESSION })).resolves.toMatchObject({ state: "running", reason: null });

    const stopped = fakeFetch(observationRoutes({ data: {} }));
    await expect(probePrWorkerSession(config(stopped.fetchImpl), { expectedService: SERVICE, sessionId: SESSION })).resolves.toMatchObject({ state: "stopped", reason: null });
  });

  it("reports unknown without an expected identity even when the session is absent", async () => {
    const fake = fakeFetch(observationRoutes({ data: {} }));
    const result = await probePrWorkerSession(config(fake.fetchImpl), { expectedService: null, sessionId: SESSION });
    expect(result.state).toBe("unknown");
    expect(result.reason).toBe("expected_identity_missing");
    expect(fake.calls).toHaveLength(0);
  });

  it("reports unknown when the service pid or version changed under the session", async () => {
    for (const drifted of [{ pid: 22932, version: "2.0.30" }, { pid: 22931, version: "2.1.0" }]) {
      const fake = fakeFetch(observationRoutes({ data: {} }, [drifted]));
      const result = await probePrWorkerSession(config(fake.fetchImpl), { expectedService: SERVICE, sessionId: SESSION });
      expect(result.state).toBe("unknown");
      expect(result.reason).toBe("service_identity_changed");
    }
  });

  it("reports unknown for authentication, transport and timeout failures", async () => {
    const authed = fakeFetch([
      { method: "GET", path: "/api/info", replies: [{ status: 401, body: { error: "unauthorized" } }] },
    ]);
    await expect(probePrWorkerSession(config(authed.fetchImpl), { expectedService: SERVICE, sessionId: SESSION })).resolves.toMatchObject({ state: "unknown", reason: "authentication_failed" });

    const refused = fakeFetch([
      { method: "GET", path: "/api/info", replies: [{ fail: new TypeError("connect ECONNREFUSED") }] },
    ]);
    await expect(probePrWorkerSession(config(refused.fetchImpl), { expectedService: SERVICE, sessionId: SESSION })).resolves.toMatchObject({ state: "unknown", reason: "transport_failed" });

    const slow = fakeFetch([
      { method: "GET", path: "/api/info", replies: [{ fail: Object.assign(new Error("aborted"), { name: "TimeoutError" }) }] },
    ]);
    const timedOut = await probePrWorkerSession(config(slow.fetchImpl), { expectedService: SERVICE, sessionId: SESSION });
    expect(timedOut).toMatchObject({ state: "unknown", reason: "timeout" });
    expect(slow.calls[0]?.init.signal.aborted).toBe(false);
  });
});

describe("requestPrWorkerSessionStop never treats the interrupt ACK as a stop", () => {
  it("reports running when the interrupt is acknowledged but the session is still active", async () => {
    const routes = [
      { method: "GET", path: "/api/info", replies: [jsonReply(SERVICE)] },
      { method: "GET", path: "/api/session/active", replies: [jsonReply({ data: { [SESSION]: { type: "running" } } })] },
      { method: "POST", path: `/api/session/${SESSION}/interrupt`, replies: [{ status: 200, body: { ok: true } }] },
    ];
    const fake = fakeFetch(routes);
    const result = await requestPrWorkerSessionStop(config(fake.fetchImpl), { expectedService: SERVICE, sessionId: SESSION });
    expect(result.outcome).toBe("running");
    expect(result.reason).toBeNull();
    const post = fake.calls.find((call) => call.init.method === "POST");
    expect(post?.init.body).toBe("{}");
    expect(post?.init.redirect).toBe("manual");
  });

  it("reports stopped only after a fresh bracketed read confirms absence", async () => {
    const routes = [
      { method: "GET", path: "/api/info", replies: [jsonReply(SERVICE)] },
      { method: "GET", path: "/api/session/active", replies: [jsonReply({ data: { [SESSION]: { type: "running" } } }), jsonReply({ data: {} })] },
      { method: "POST", path: `/api/session/${SESSION}/interrupt`, replies: [{ status: 200, body: { ok: true } }] },
    ];
    const fake = fakeFetch(routes);
    const result = await requestPrWorkerSessionStop(config(fake.fetchImpl), { expectedService: SERVICE, sessionId: SESSION });
    expect(result).toMatchObject({ outcome: "stopped", service: SERVICE, reason: null, detail: null });
  });

  it("preserves unknown when the stop request itself fails", async () => {
    const routes = [
      { method: "GET", path: "/api/info", replies: [jsonReply(SERVICE)] },
      { method: "GET", path: "/api/session/active", replies: [jsonReply({ data: { [SESSION]: { type: "running" } } })] },
      { method: "POST", path: `/api/session/${SESSION}/interrupt`, replies: [{ status: 500, body: { error: "boom" } }] },
    ];
    const fake = fakeFetch(routes);
    const result = await requestPrWorkerSessionStop(config(fake.fetchImpl), { expectedService: SERVICE, sessionId: SESSION });
    expect(result.outcome).toBe("unknown");
    expect(result.reason).toBe("unexpected_status");
    // No confirmation read follows a failed stop request.
    expect(fake.calls.filter((call) => new URL(call.url).pathname === "/api/session/active")).toHaveLength(1);
  });

  it("refuses a stop when the session or expected identity is unknown", async () => {
    const fake = fakeFetch(observationRoutes({ data: {} }));
    const result = await requestPrWorkerSessionStop(config(fake.fetchImpl), { expectedService: null, sessionId: SESSION });
    expect(result.outcome).toBe("unknown");
    expect(result.reason).toBe("expected_identity_missing");
    expect(fake.calls.some((call) => call.init.method === "POST")).toBe(false);

    const drifted = fakeFetch(observationRoutes({ data: {} }, [{ pid: 22999, version: "2.0.30" }]));
    const refused = await requestPrWorkerSessionStop(config(drifted.fetchImpl), { expectedService: SERVICE, sessionId: SESSION });
    expect(refused.outcome).toBe("unknown");
    expect(refused.reason).toBe("service_identity_changed");
    expect(drifted.calls.some((call) => call.init.method === "POST")).toBe(false);
  });

  it("refuses a redirect instead of forwarding the credential off-origin", async () => {
    const routes = [
      { method: "GET", path: "/api/info", replies: [{ status: 302, body: { location: "https://attacker.invalid/collect" } }] },
    ];
    const fake = fakeFetch(routes);
    const result = await probePrWorkerSession(config(fake.fetchImpl), { expectedService: SERVICE, sessionId: SESSION });
    expect(result.reason).toBe("redirect_refused");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.init.redirect).toBe("manual");
    expect(fake.calls.every((call) => new URL(call.url).hostname === "127.0.0.1")).toBe(true);
  });
});

describe("credentials stay out of results and require owner-only file mode", () => {
  it("never exposes the password in public observation output", async () => {
    const fake = fakeFetch(observationRoutes({ data: { [SESSION]: { type: "running" } } }));
    const observation = await observePrWorkerSession(config(fake.fetchImpl), SESSION);
    const probe = await probePrWorkerSession(config(fake.fetchImpl), { expectedService: SERVICE, sessionId: SESSION });
    expect(JSON.stringify({ observation, probe })).not.toContain(PASSWORD);
  });

  it("never exposes the password in failure diagnostics", async () => {
    const rejected = fakeFetch([
      { method: "GET", path: "/api/info", replies: [{ status: 401, body: { error: "unauthorized" } }] },
    ]);
    const authenticated = await probePrWorkerSession(config(rejected.fetchImpl), { expectedService: SERVICE, sessionId: SESSION });
    expect(authenticated.reason).toBe("authentication_failed");

    const malformed = fakeFetch([
      { method: "GET", path: "/api/info", replies: [{ text: "not-json" }] },
    ]);
    const unparsable = await probePrWorkerSession(config(malformed.fetchImpl), { expectedService: SERVICE, sessionId: SESSION });
    expect(unparsable.reason).toBe("malformed_payload");

    const broken = fakeFetch([
      { method: "GET", path: "/api/info", replies: [{ fail: new TypeError(`connect failed for opencode:${PASSWORD}`) }] },
    ]);
    const refused = await probePrWorkerSession(config(broken.fetchImpl), { expectedService: SERVICE, sessionId: SESSION });
    expect(refused.reason).toBe("transport_failed");

    for (const result of [authenticated, unparsable, refused]) {
      expect(result.detail).toBeTypeOf("string");
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
    }
  });

  it("refuses a credential file readable beyond its owner", async () => {
    await chmod(credentialFile, 0o644);
    const fake = fakeFetch(observationRoutes({ data: {} }));
    const observation = await observePrWorkerSession(config(fake.fetchImpl), SESSION);
    expect(observation.known === false && observation.reason).toBe("credential_permissions");
    expect(JSON.stringify(observation)).not.toContain(PASSWORD);
    expect(fake.calls).toHaveLength(0);
  });

  it("reports an absent credential file as unknown without contacting the service", async () => {
    const fake = fakeFetch(observationRoutes({ data: {} }));
    const observation = await observePrWorkerSession(
      { ...config(fake.fetchImpl), credentialFile: join(directory, "absent") },
      SESSION,
    );
    expect(observation.known === false && observation.reason).toBe("credential_unavailable");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("capturePrWorkerServiceIdentity captures the pre-dispatch target", () => {
  it("captures the stable identity with two info reads and no session lookup", async () => {
    const fake = fakeFetch([
      { method: "GET", path: "/api/info", replies: [jsonReply(SERVICE), jsonReply(SERVICE)] },
    ]);
    const captured = await capturePrWorkerServiceIdentity(config(fake.fetchImpl));
    expect(captured).toEqual({ ok: true, service: SERVICE });
    expect(fake.calls.map((call) => `${call.init.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /api/info",
      "GET /api/info",
    ]);
    expect(fake.calls.some((call) => new URL(call.url).pathname === "/api/session/active")).toBe(false);
  });

  it("rejects identity drift between the two info reads", async () => {
    const restarted: PrWorkerServiceIdentity = { pid: 22999, version: "2.0.30" };
    const fake = fakeFetch([
      { method: "GET", path: "/api/info", replies: [jsonReply(SERVICE), jsonReply(restarted)] },
    ]);
    const captured = await capturePrWorkerServiceIdentity(config(fake.fetchImpl));
    expect(captured.ok).toBe(false);
    expect(captured.ok === false && captured.reason).toBe("instance_changed");
    expect(fake.calls).toHaveLength(2);
  });

  it("fails safely for credential, transport and malformed identity reads", async () => {
    const denied = fakeFetch([
      { method: "GET", path: "/api/info", replies: [jsonReply(SERVICE), jsonReply(SERVICE)] },
    ]);
    await chmod(credentialFile, 0o644);
    const permissions = await capturePrWorkerServiceIdentity(config(denied.fetchImpl));
    expect(permissions.ok === false && permissions.reason).toBe("credential_permissions");
    expect(denied.calls).toHaveLength(0);
    await chmod(credentialFile, 0o600);

    const refused = fakeFetch([
      { method: "GET", path: "/api/info", replies: [{ fail: new TypeError("connect ECONNREFUSED") }] },
    ]);
    const transport = await capturePrWorkerServiceIdentity(config(refused.fetchImpl));
    expect(transport.ok === false && transport.reason).toBe("transport_failed");

    const malformed = fakeFetch([
      { method: "GET", path: "/api/info", replies: [jsonReply({ pid: SERVICE.pid }), jsonReply(SERVICE)] },
    ]);
    const unusable = await capturePrWorkerServiceIdentity(config(malformed.fetchImpl));
    expect(unusable.ok === false && unusable.reason).toBe("malformed_payload");

    for (const result of [permissions, transport, unusable]) {
      expect(result.ok === false && result.detail).toBeTypeOf("string");
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
    }
  });

  it("never exposes the password in capture output", async () => {
    const fake = fakeFetch([
      { method: "GET", path: "/api/info", replies: [jsonReply(SERVICE), jsonReply(SERVICE)] },
    ]);
    const captured = await capturePrWorkerServiceIdentity(config(fake.fetchImpl));
    expect(JSON.stringify(captured)).not.toContain(PASSWORD);
    expect(fake.calls.every((call) => new URL(call.url).hostname === "127.0.0.1")).toBe(true);
  });
});

describe("invalid timeout fails as structured unknown without service calls", () => {
  it.each([[-1], [0], [Number.NaN], [Number.POSITIVE_INFINITY], [0.5], [30_001]])(
    "reports invalid_timeout for timeout %s across capture/observe/probe/stop",
    async (timeoutMs) => {
      const captureFake = fakeFetch(observationRoutes({ data: {} }));
      const captureCfg = { ...config(captureFake.fetchImpl), timeoutMs };
      const captured = await capturePrWorkerServiceIdentity(captureCfg);
      expect(captured.ok === false && captured.reason).toBe("invalid_timeout");
      expect(captureFake.calls).toHaveLength(0);

      const observeFake = fakeFetch(observationRoutes({ data: { [SESSION]: { type: "running" } } }));
      const observeCfg = { ...config(observeFake.fetchImpl), timeoutMs };
      const observation = await observePrWorkerSession(observeCfg, SESSION);
      expect(observation.known === false && observation.reason).toBe("invalid_timeout");
      expect(observeFake.calls).toHaveLength(0);

      const probeFake = fakeFetch(observationRoutes({ data: { [SESSION]: { type: "running" } } }));
      const probeCfg = { ...config(probeFake.fetchImpl), timeoutMs };
      const probed = await probePrWorkerSession(probeCfg, { expectedService: SERVICE, sessionId: SESSION });
      expect(probed.state).toBe("unknown");
      expect(probed.reason).toBe("invalid_timeout");
      expect(probeFake.calls).toHaveLength(0);

      const stopFake = fakeFetch(observationRoutes({ data: { [SESSION]: { type: "running" } } }));
      const stopCfg = { ...config(stopFake.fetchImpl), timeoutMs };
      const stopped = await requestPrWorkerSessionStop(stopCfg, { expectedService: SERVICE, sessionId: SESSION });
      expect(stopped.outcome).toBe("unknown");
      expect(stopped.reason).toBe("invalid_timeout");
      expect(stopFake.calls).toHaveLength(0);

      for (const result of [captured, observation, probed, stopped]) {
        expect(JSON.stringify(result)).not.toContain(PASSWORD);
      }
    },
  );
});