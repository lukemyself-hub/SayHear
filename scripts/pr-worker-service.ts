// Bounded service-observation adapter for the coordinator-owned remediation
// helper (#368). It observes real OpenCode V2 liveness and requests stop; it
// never dispatches work, never decides ownership, and keeps no second ledger.
// Absence of a session is evidence only under an identity captured before
// dispatch, so every fresh read is bracketed by two /api/info reads.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const PR_WORKER_SERVICE_USER = "opencode";
export const PR_WORKER_SERVICE_DEFAULT_BASE_URL = "http://127.0.0.1:4096";
export const PR_WORKER_SERVICE_DEFAULT_TIMEOUT_MS = 2_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_CREDENTIAL_LENGTH = 512;
const MAX_TIMEOUT_MS = 30_000;

export type PrWorkerServiceFailureCode =
  | "endpoint_not_loopback" | "credential_unavailable" | "credential_permissions"
  | "transport_failed" | "timeout" | "invalid_timeout" | "authentication_failed" | "unexpected_status"
  | "redirect_refused" | "malformed_payload" | "instance_changed" | "session_unknown"
  | "session_not_running" | "expected_identity_missing" | "service_identity_changed";

export type PrWorkerServiceIdentity = Readonly<{ pid: number; version: string }>;
export type PrWorkerServiceFetchInit = {
  method: string;
  headers: Record<string, string>;
  redirect: "manual";
  signal: AbortSignal;
  body?: string;
};
export type PrWorkerServiceFetch = (input: string, init: PrWorkerServiceFetchInit) => Promise<Response>;
export type PrWorkerServiceConfig = {
  baseUrl?: string;
  credentialFile?: string;
  timeoutMs?: number;
  fetch?: PrWorkerServiceFetch;
};
export type PrWorkerObservation =
  | Readonly<{ known: true; service: PrWorkerServiceIdentity; target: "running" | "stopped" }>
  | Readonly<{ known: false; service: PrWorkerServiceIdentity | null; reason: PrWorkerServiceFailureCode; detail: string }>;
export type PrWorkerProbeResult = Readonly<{
  state: "running" | "stopped" | "unknown";
  service: PrWorkerServiceIdentity | null;
  reason: PrWorkerServiceFailureCode | null;
  detail: string | null;
}>;
export type PrWorkerStopResult = Readonly<{
  outcome: "stopped" | "running" | "unknown";
  service: PrWorkerServiceIdentity | null;
  reason: PrWorkerServiceFailureCode | null;
  detail: string | null;
}>;
export type PrWorkerServiceIdentityCapture =
  | Readonly<{ ok: true; service: PrWorkerServiceIdentity }>
  | Readonly<{ ok: false; reason: PrWorkerServiceFailureCode; detail: string }>;
export type PrWorkerTargetInput = { expectedService: PrWorkerServiceIdentity | null; sessionId: string | null };

type ServiceFailure = Readonly<{ code: PrWorkerServiceFailureCode; detail: string }>;
type HttpReply = { ok: true; body: unknown } | { ok: false; failure: ServiceFailure };
type IdentityReply = { ok: true; identity: PrWorkerServiceIdentity } | { ok: false; failure: ServiceFailure };
type ResolvedConfig = { baseUrl: URL | null; credentialFile: string; timeoutMs: number; fetchImpl: PrWorkerServiceFetch };

export function prWorkerServiceCredentialFile(): string {
  return join(homedir(), ".config", "opencode", "delegate-service", "password");
}

function unknown(reason: PrWorkerServiceFailureCode, detail: string, service: PrWorkerServiceIdentity | null = null): PrWorkerObservation {
  return { known: false, service, reason, detail };
}

/** The credential may only ever travel to a plain-http loopback origin. */
function loopbackHttpBaseUrl(baseUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  const bare = url.pathname === "" || url.pathname === "/";
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(host) && bare && url.search === "" && url.hash === ""
    ? url
    : null;
}

async function readServicePassword(file: string): Promise<{ ok: true; password: string } | { ok: false; failure: ServiceFailure }> {
  const unusable: ServiceFailure = { code: "credential_unavailable", detail: "credential file is not readable" };
  let raw: string;
  try {
    const stats = await stat(file);
    if (!stats.isFile()) {
      return { ok: false, failure: unusable };
    }
    if ((stats.mode & 0o077) !== 0) {
      return { ok: false, failure: { code: "credential_permissions", detail: "credential file is readable beyond its owner" } };
    }
    raw = await readFile(file, "utf8");
  } catch {
    return { ok: false, failure: unusable };
  }
  const password = raw.trim();
  if (password.length === 0 || password.length > MAX_CREDENTIAL_LENGTH) {
    return { ok: false, failure: { code: "credential_unavailable", detail: "credential file holds no usable password" } };
  }
  return { ok: true, password };
}

function resolveConfig(config: PrWorkerServiceConfig): ResolvedConfig {
  const fallback = globalThis.fetch as PrWorkerServiceFetch | undefined;
  return {
    baseUrl: loopbackHttpBaseUrl(config.baseUrl ?? PR_WORKER_SERVICE_DEFAULT_BASE_URL),
    credentialFile: config.credentialFile ?? prWorkerServiceCredentialFile(),
    timeoutMs: config.timeoutMs ?? PR_WORKER_SERVICE_DEFAULT_TIMEOUT_MS,
    fetchImpl: config.fetch ?? fallback ?? (() => Promise.reject(new Error("fetch unavailable"))),
  };
}

async function requestJson(
  baseUrl: URL, fetchImpl: PrWorkerServiceFetch, password: string, timeoutMs: number, path: string, method: "GET" | "POST",
): Promise<HttpReply> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    return { ok: false, failure: { code: "invalid_timeout", detail: "service timeout must be a positive integer within its bound" } };
  }
  const authorization = `Basic ${Buffer.from(`${PR_WORKER_SERVICE_USER}:${password}`, "utf8").toString("base64")}`;
  const accept: Record<string, string> = { authorization, accept: "application/json" };
  const init: PrWorkerServiceFetchInit = {
    method,
    headers: method === "POST" ? { ...accept, "content-type": "application/json" } : accept,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    ...(method === "POST" ? { body: "{}" } : {}),
  };
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, baseUrl).toString(), init);
  } catch (error) {
    // Diagnostics stay fixed strings; the password and response bodies never appear.
    const name = (error as { name?: unknown })?.name;
    return name === "TimeoutError" || name === "AbortError"
      ? { ok: false, failure: { code: "timeout", detail: "service request exceeded its timeout budget" } }
      : { ok: false, failure: { code: "transport_failed", detail: "service request failed at transport level" } };
  }
  if (response.status >= 300 && response.status < 400) {
    // Redirects are never followed, so no credential can reach another origin.
    return { ok: false, failure: { code: "redirect_refused", detail: "service responded with a redirect" } };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, failure: { code: "authentication_failed", detail: "service rejected the local credential" } };
  }
  if (!response.ok) {
    return { ok: false, failure: { code: "unexpected_status", detail: "service returned an unexpected status" } };
  }
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, failure: { code: "malformed_payload", detail: "service returned unparsable JSON" } };
  }
}

function isIdentity(value: unknown): value is PrWorkerServiceIdentity {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { pid, version } = value as Record<string, unknown>;
  const pidOk = typeof pid === "number" && Number.isInteger(pid) && pid > 0;
  return pidOk && typeof version === "string" && version.length > 0;
}

function parseIdentity(body: unknown): IdentityReply {
  return isIdentity(body)
    ? { ok: true, identity: { pid: body.pid, version: body.version } }
    : { ok: false, failure: { code: "malformed_payload", detail: "service info lacks a usable identity" } };
}

function parseActiveMap(body: unknown): { ok: true; active: ReadonlyMap<string, string> } | { ok: false; failure: ServiceFailure } {
  const malformed: ServiceFailure = { code: "malformed_payload", detail: "active sessions payload is malformed" };
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof record.data !== "object" || record.data === null || Array.isArray(record.data)) {
    return { ok: false, failure: malformed };
  }
  const active = new Map<string, string>();
  for (const [sessionId, entry] of Object.entries(record.data)) {
    const state = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    if (typeof state.type !== "string" || state.type.length === 0) {
      return { ok: false, failure: malformed };
    }
    active.set(sessionId, state.type);
  }
  return { ok: true, active };
}

function sameInstance(left: PrWorkerServiceIdentity, right: PrWorkerServiceIdentity): boolean {
  return left.pid === right.pid && left.version === right.version;
}

async function readIdentity(
  baseUrl: URL, fetchImpl: PrWorkerServiceFetch, password: string, timeoutMs: number,
): Promise<IdentityReply> {
  const reply = await requestJson(baseUrl, fetchImpl, password, timeoutMs, "/api/info", "GET");
  return reply.ok ? parseIdentity(reply.body) : reply;
}

/**
 * Captures the service identity before any session exists or dispatch occurs.
 * Reads /api/info twice on the same instance so a restart torn across the
 * preflight cannot be mistaken for a stable coordinator target.
 */
export async function capturePrWorkerServiceIdentity(
  config: PrWorkerServiceConfig,
): Promise<PrWorkerServiceIdentityCapture> {
  const { baseUrl, credentialFile, timeoutMs, fetchImpl } = resolveConfig(config);
  if (baseUrl === null) {
    return { ok: false, reason: "endpoint_not_loopback", detail: "service base URL must be loopback http" };
  }
  const credential = await readServicePassword(credentialFile);
  if (!credential.ok) {
    return { ok: false, reason: credential.failure.code, detail: credential.failure.detail };
  }
  const before = await readIdentity(baseUrl, fetchImpl, credential.password, timeoutMs);
  if (!before.ok) {
    return { ok: false, reason: before.failure.code, detail: before.failure.detail };
  }
  const after = await readIdentity(baseUrl, fetchImpl, credential.password, timeoutMs);
  if (!after.ok) {
    return { ok: false, reason: after.failure.code, detail: after.failure.detail };
  }
  if (!sameInstance(before.identity, after.identity)) {
    return { ok: false, reason: "instance_changed", detail: "service instance changed during identity capture" };
  }
  return { ok: true, service: before.identity };
}

/** One fresh bracketed observation of a known session on one instance. */
export async function observePrWorkerSession(config: PrWorkerServiceConfig, sessionId: string | null): Promise<PrWorkerObservation> {
  const { baseUrl, credentialFile, timeoutMs, fetchImpl } = resolveConfig(config);
  if (baseUrl === null) {
    return unknown("endpoint_not_loopback", "service base URL must be loopback http");
  }
  const credential = await readServicePassword(credentialFile);
  if (!credential.ok) {
    return unknown(credential.failure.code, credential.failure.detail);
  }
  if (sessionId === null || sessionId.length === 0) {
    return unknown("session_unknown", "no known session is bound to this observation");
  }
  const before = await readIdentity(baseUrl, fetchImpl, credential.password, timeoutMs);
  if (!before.ok) {
    return unknown(before.failure.code, before.failure.detail);
  }
  const active = await requestJson(baseUrl, fetchImpl, credential.password, timeoutMs, "/api/session/active", "GET");
  if (!active.ok) {
    return unknown(active.failure.code, active.failure.detail, before.identity);
  }
  const after = await readIdentity(baseUrl, fetchImpl, credential.password, timeoutMs);
  if (!after.ok) {
    return unknown(after.failure.code, after.failure.detail, before.identity);
  }
  if (!sameInstance(before.identity, after.identity)) {
    return unknown("instance_changed", "service instance changed during the observation", after.identity);
  }
  const parsed = parseActiveMap(active.body);
  if (!parsed.ok) {
    return unknown(parsed.failure.code, parsed.failure.detail, before.identity);
  }
  const state = parsed.active.get(sessionId);
  if (state === "running" || state === undefined) {
    return { known: true, service: before.identity, target: state === undefined ? "stopped" : "running" };
  }
  return unknown("session_not_running", "bound session is not in a running state", before.identity);
}

/**
 * Probes a dispatched session against the identity captured before dispatch.
 * Without that identity, an absent session proves nothing.
 */
export async function probePrWorkerSession(
  config: PrWorkerServiceConfig, input: PrWorkerTargetInput,
): Promise<PrWorkerProbeResult> {
  const expected = input.expectedService;
  if (!isIdentity(expected)) {
    return { state: "unknown", service: null, reason: "expected_identity_missing", detail: "no expected identity was captured" };
  }
  const observation = await observePrWorkerSession(config, input.sessionId);
  if (!observation.known) {
    return { state: "unknown", service: observation.service, reason: observation.reason, detail: observation.detail };
  }
  if (!sameInstance(expected, observation.service)) {
    return {
      state: "unknown",
      service: observation.service,
      reason: "service_identity_changed",
      detail: "observed service is not the expected instance",
    };
  }
  return { state: observation.target, service: observation.service, reason: null, detail: null };
}

/**
 * Requests stop for a known session on the expected instance. The interrupt
 * ACK is never treated as proof: only a fresh bracketed read reports a stop.
 */
export async function requestPrWorkerSessionStop(
  config: PrWorkerServiceConfig, input: PrWorkerTargetInput,
): Promise<PrWorkerStopResult> {
  const before = await probePrWorkerSession(config, input);
  const sessionId = input.sessionId;
  if (before.state === "unknown" || before.service === null || sessionId === null) {
    const reason = before.reason ?? "session_unknown";
    return { outcome: "unknown", service: before.service, reason, detail: before.detail ?? "no known session is bound" };
  }
  const { baseUrl, credentialFile, timeoutMs, fetchImpl } = resolveConfig(config);
  if (baseUrl === null) {
    return { outcome: "unknown", service: before.service, reason: "endpoint_not_loopback", detail: "service base URL must be loopback http" };
  }
  const credential = await readServicePassword(credentialFile);
  if (!credential.ok) {
    return { outcome: "unknown", service: before.service, reason: credential.failure.code, detail: credential.failure.detail };
  }
  const path = `/api/session/${encodeURIComponent(sessionId)}/interrupt`;
  const interrupt = await requestJson(baseUrl, fetchImpl, credential.password, timeoutMs, path, "POST");
  if (!interrupt.ok) {
    return { outcome: "unknown", service: before.service, reason: interrupt.failure.code, detail: interrupt.failure.detail };
  }
  const after = await probePrWorkerSession(config, input);
  if (after.state === "unknown") {
    return { outcome: "unknown", service: after.service, reason: after.reason, detail: after.detail };
  }
  const stopped = after.state === "stopped";
  return {
    outcome: stopped ? "stopped" : "running",
    service: after.service,
    reason: null,
    detail: stopped ? null : "interrupt acknowledged but session is still running",
  };
}