import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Account, NextAuthOptions } from "next-auth";

import {
  EVIDENCE_STEP_UP_MAX_AGE_MS,
  type EvidenceStepUpCompletionResult,
  type EvidenceStepUpIssuerContext,
} from "@sayhear/data";

/**
 * ADR-0129 bounded Evidence step-up.
 *
 * Reading Reflection prose only needs the owner-scoped
 * `reflection_inspection:read` capability, but expanding the exact user
 * Evidence behind a Reflection Statement requires the
 * `conversation_content:read` capability and a step-up completed within ten
 * minutes. This module is the missing normal entry point: a short-lived,
 * HMAC-signed intent cookie is paired with a real GitHub OAuth roundtrip so
 * the capability is elevated only for the live owner session.
 *
 * It is deliberately not a password/MFA/auth_time guarantee: the fresh
 * `prompt=select_account` OAuth roundtrip proves control of the GitHub
 * identity bound to the Internal Owner, and the write happens in the same
 * atomic transaction that re-verifies the signed intent, the live session and
 * the data epoch.
 */

export const EVIDENCE_STEP_UP_INTENT_COOKIE = "sayhear.evidence-step-up-intent";
export const EVIDENCE_STEP_UP_CALLBACK_PATH = "/api/auth/callback/github";
export const EVIDENCE_STEP_UP_RETURN_PATH = "/internal/reflection-inspector";
export const EVIDENCE_STEP_UP_CAPABILITY = "conversation_content:read";
export const EVIDENCE_STEP_UP_INTENT_TTL_SECONDS =
  EVIDENCE_STEP_UP_MAX_AGE_MS / 1_000;

const INTENT_VERSION = 1;
const HMAC_DOMAIN = "sayhear:evidence-step-up-intent:v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_HASH_PATTERN = /^[0-9a-f]{64}$/;

export type EvidenceStepUpIntent = Readonly<{
  capability: typeof EVIDENCE_STEP_UP_CAPABILITY;
  dataEpoch: number;
  issuedAt: string;
  liveSessionHash: string;
  nonce: string;
  userId: string;
  version: typeof INTENT_VERSION;
}>;

export type EvidenceStepUpPrincipal = Readonly<{
  authSessionId: string;
  userId: string;
}>;

export type EvidenceStepUpIssuerRepository = Readonly<{
  readStepUpIssuerContext(input: {
    authSessionId: string;
    now: Date;
    userId: string;
  }): Promise<EvidenceStepUpIssuerContext>;
}>;

export type EvidenceStepUpCompletionPort = Readonly<{
  completeEvidenceStepUp(input: {
    authSessionId: string;
    dataEpoch: number;
    issuedAt: Date;
    now: Date;
    providerAccountId: string;
    userId: string;
  }): Promise<EvidenceStepUpCompletionResult>;
}>;

export type EvidenceStepUpCallbackOutcome =
  | Readonly<{ outcome: "ignored"; reason: "no_intent" | "intent_invalid" }>
  | Readonly<{
      outcome: "denied";
      reason:
        | "completion_error"
        | "identity_mismatch"
        | "session_mismatch"
        | "session_missing"
        | "unverified_provider";
    }>
  | EvidenceStepUpCompletionResult;

function intentMac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret)
    .update(HMAC_DOMAIN)
    .update("\0")
    .update(payload)
    .digest();
}

function isEvidenceStepUpIntent(value: unknown): value is EvidenceStepUpIntent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const intent = value as Record<string, unknown>;
  return (
    intent.version === INTENT_VERSION &&
    intent.capability === EVIDENCE_STEP_UP_CAPABILITY &&
    typeof intent.userId === "string" &&
    UUID_PATTERN.test(intent.userId) &&
    typeof intent.liveSessionHash === "string" &&
    SESSION_HASH_PATTERN.test(intent.liveSessionHash) &&
    typeof intent.dataEpoch === "number" &&
    Number.isInteger(intent.dataEpoch) &&
    intent.dataEpoch > 0 &&
    typeof intent.nonce === "string" &&
    intent.nonce.length > 0 &&
    typeof intent.issuedAt === "string" &&
    Number.isFinite(Date.parse(intent.issuedAt))
  );
}

export function signEvidenceStepUpIntent(input: {
  intent: EvidenceStepUpIntent;
  secret: string;
}): string {
  const payload = Buffer.from(
    JSON.stringify(input.intent),
    "utf8",
  ).toString("base64url");
  const mac = intentMac(input.secret, payload).toString("base64url");
  return `${payload}.${mac}`;
}

export function verifyEvidenceStepUpIntent(input: {
  now: Date;
  secret: string;
  value: string;
}): EvidenceStepUpIntent | null {
  const separator = input.value.indexOf(".");
  if (separator <= 0) {
    return null;
  }
  const payload = input.value.slice(0, separator);
  const providedMac = Buffer.from(input.value.slice(separator + 1), "base64url");
  const expectedMac = intentMac(input.secret, payload);
  if (
    providedMac.length !== expectedMac.length ||
    !timingSafeEqual(providedMac, expectedMac)
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isEvidenceStepUpIntent(parsed)) {
    return null;
  }

  const issuedAt = Date.parse(parsed.issuedAt);
  const now = input.now.getTime();
  if (now <= issuedAt || now - issuedAt > EVIDENCE_STEP_UP_MAX_AGE_MS) {
    return null;
  }
  return parsed;
}

export function serializeEvidenceStepUpIntentCookie(input: {
  maxAgeSeconds: number;
  secure: boolean;
  value: string;
}): string {
  return cookieAttributeString({
    httpOnly: true,
    maxAgeSeconds: input.maxAgeSeconds,
    path: EVIDENCE_STEP_UP_CALLBACK_PATH,
    secure: input.secure,
    value: input.value,
  });
}

export function clearEvidenceStepUpIntentCookie(input: {
  secure: boolean;
}): string {
  return cookieAttributeString({
    httpOnly: true,
    maxAgeSeconds: 0,
    path: EVIDENCE_STEP_UP_CALLBACK_PATH,
    secure: input.secure,
    value: "",
  });
}

function cookieAttributeString(input: {
  httpOnly: boolean;
  maxAgeSeconds: number;
  path: string;
  secure: boolean;
  value: string;
}): string {
  const attributes = [
    `${EVIDENCE_STEP_UP_INTENT_COOKIE}=${input.value}`,
    `Path=${input.path}`,
    `Max-Age=${input.maxAgeSeconds}`,
    "SameSite=Lax",
  ];
  if (input.httpOnly) {
    attributes.push("HttpOnly");
  }
  if (input.secure) {
    attributes.push("Secure");
  }
  if (input.maxAgeSeconds === 0) {
    attributes.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  return attributes.join("; ");
}

function readRequestCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator).trim() !== name) {
      continue;
    }
    const value = pair.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return false;
  }
  return request.headers.get("sec-fetch-site") !== "cross-site";
}

/**
 * Request-scoped POST handler that issues the signed step-up intent cookie.
 * It requires the caller's normal owner session, an active
 * `reflection_inspection:read` grant, and a same-origin request. It accepts no
 * client identity, capability or redirect fields.
 */
export function createEvidenceStepUpIntentHandler(dependencies: {
  authenticate(request: Request): Promise<EvidenceStepUpPrincipal | null>;
  clock(): Date;
  repository: EvidenceStepUpIssuerRepository;
  secret: string;
  secureCookie: boolean;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    if (!isSameOriginRequest(request)) {
      return Response.json(
        { error: "cross_site_request_rejected" },
        { status: 403 },
      );
    }
    let body = "";
    try {
      body = await request.text();
    } catch {
      body = "";
    }
    if (body.trim() !== "") {
      return Response.json(
        { error: "unexpected_request_body" },
        { status: 400 },
      );
    }
    if (dependencies.secret.length === 0) {
      return Response.json({ error: "step_up_unavailable" }, { status: 503 });
    }

    const principal = await dependencies.authenticate(request);
    if (principal === null) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const now = dependencies.clock();
    const context = await dependencies.repository.readStepUpIssuerContext({
      authSessionId: principal.authSessionId,
      now,
      userId: principal.userId,
    });
    if (context.outcome !== "allowed") {
      return Response.json(
        { error: "step_up_not_permitted" },
        { status: 403 },
      );
    }

    const intent: EvidenceStepUpIntent = {
      capability: EVIDENCE_STEP_UP_CAPABILITY,
      dataEpoch: context.dataEpoch,
      issuedAt: now.toISOString(),
      liveSessionHash: principal.authSessionId,
      nonce: randomBytes(32).toString("base64url"),
      userId: principal.userId,
      version: INTENT_VERSION,
    };
    const headers = new Headers({
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    headers.append(
      "set-cookie",
      serializeEvidenceStepUpIntentCookie({
        maxAgeSeconds: EVIDENCE_STEP_UP_INTENT_TTL_SECONDS,
        secure: dependencies.secureCookie,
        value: signEvidenceStepUpIntent({
          intent,
          secret: dependencies.secret,
        }),
      }),
    );
    return new Response(JSON.stringify({ outcome: "challenge_issued" }), {
      headers,
      status: 200,
    });
  };
}

/**
 * Verifies the signed intent against the real OAuth callback message and the
 * live session cookie, then asks the completion port to persist the step-up.
 * It never logs intent values.
 */
export async function completeEvidenceStepUpFromGithubCallback(input: {
  account:
    | Pick<Account, "provider" | "providerAccountId" | "type">
    | null
    | undefined;
  clock(): Date;
  completion: EvidenceStepUpCompletionPort;
  intentCookieValue: string | null;
  secret: string;
  sessionCookieValue: string | null;
  userId: string | null | undefined;
}): Promise<EvidenceStepUpCallbackOutcome> {
  if (!input.intentCookieValue) {
    return { outcome: "ignored", reason: "no_intent" };
  }
  const now = input.clock();
  const intent = verifyEvidenceStepUpIntent({
    now,
    secret: input.secret,
    value: input.intentCookieValue,
  });
  if (intent === null) {
    return { outcome: "ignored", reason: "intent_invalid" };
  }
  if (!input.userId || input.userId !== intent.userId) {
    return { outcome: "denied", reason: "identity_mismatch" };
  }
  if (
    input.account?.type !== "oauth" ||
    input.account.provider !== "github" ||
    !input.account.providerAccountId
  ) {
    return { outcome: "denied", reason: "unverified_provider" };
  }
  if (!input.sessionCookieValue) {
    return { outcome: "denied", reason: "session_missing" };
  }
  const liveSessionHash = createHash("sha256")
    .update(input.sessionCookieValue, "utf8")
    .digest("hex");
  if (liveSessionHash !== intent.liveSessionHash) {
    return { outcome: "denied", reason: "session_mismatch" };
  }

  try {
    return await input.completion.completeEvidenceStepUp({
      authSessionId: liveSessionHash,
      dataEpoch: intent.dataEpoch,
      issuedAt: new Date(intent.issuedAt),
      now,
      providerAccountId: input.account.providerAccountId,
      userId: intent.userId,
    });
  } catch {
    return { outcome: "denied", reason: "completion_error" };
  }
}

/**
 * Builds a request-local `NextAuthOptions` whose `events.signIn` is bound to
 * exactly one callback request. No global mutable or cross-request state is
 * involved; ordinary sign-in paths keep the base options unchanged.
 */
export function requestScopedEvidenceStepUpAuthOptions(input: {
  authOptions: NextAuthOptions;
  clock(): Date;
  completion: EvidenceStepUpCompletionPort;
  request: Request;
  secret: string;
  sessionCookieName: string | null;
}): NextAuthOptions {
  const originalEvents = input.authOptions.events;
  return {
    ...input.authOptions,
    events: {
      ...originalEvents,
      async signIn(message) {
        await originalEvents?.signIn?.(message);
        if (input.secret.length === 0 || !input.sessionCookieName) {
          return;
        }
        await completeEvidenceStepUpFromGithubCallback({
          account: message.account,
          clock: input.clock,
          completion: input.completion,
          intentCookieValue: readRequestCookie(
            input.request,
            EVIDENCE_STEP_UP_INTENT_COOKIE,
          ),
          secret: input.secret,
          sessionCookieValue: readRequestCookie(
            input.request,
            input.sessionCookieName,
          ),
          userId: message.user?.id,
        });
      },
    },
  };
}

/**
 * Unconditionally clears the one-use intent cookie on the callback response,
 * whether the completion succeeded or failed.
 */
export function appendEvidenceStepUpIntentCookieClear(
  response: Response,
  input: { secure: boolean },
): Response {
  response.headers.append(
    "set-cookie",
    clearEvidenceStepUpIntentCookie({ secure: input.secure }),
  );
  return response;
}
