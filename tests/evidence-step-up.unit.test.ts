import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { EvidenceStepUpIssuerContext } from "@sayhear/data";

import {
  EVIDENCE_STEP_UP_CALLBACK_PATH,
  EVIDENCE_STEP_UP_INTENT_COOKIE,
  EVIDENCE_STEP_UP_RETURN_PATH,
  appendEvidenceStepUpIntentCookieClear,
  completeEvidenceStepUpFromGithubCallback,
  createEvidenceStepUpIntentHandler,
  requestScopedEvidenceStepUpAuthOptions,
  signEvidenceStepUpIntent,
  verifyEvidenceStepUpIntent,
  type EvidenceStepUpCompletionPort,
  type EvidenceStepUpIntent,
} from "../apps/web/src/content-step-up";

const SECRET = "evidence-step-up-unit-secret";
const USER_ID = "01984477-1f9a-7b25-a5cc-83c3b21fbc68";
const SESSION_TOKEN = "evidence-step-up-live-session";
const SESSION_HASH = createHash("sha256")
  .update(SESSION_TOKEN, "utf8")
  .digest("hex");
const NOW = new Date("2026-10-02T12:00:00.000Z");
const CALLBACK_NOW = new Date(NOW.getTime() + 30_000);
const ORIGIN = "https://sayhear.test";
const STEP_UP_URL = `${ORIGIN}/api/internal/inspection/evidence-step-up`;
const ISSUER_ALLOWED: EvidenceStepUpIssuerContext = {
  outcome: "allowed",
  dataEpoch: 3,
};

function readSetCookies(response: Response): string[] {
  const combined = response.headers.get("set-cookie");
  return combined ? [combined] : [];
}

function intent(
  overrides: Partial<EvidenceStepUpIntent> = {},
): EvidenceStepUpIntent {
  return {
    capability: "conversation_content:read",
    dataEpoch: 3,
    issuedAt: NOW.toISOString(),
    liveSessionHash: SESSION_HASH,
    nonce: "unit-nonce",
    userId: USER_ID,
    version: 1,
    ...overrides,
  };
}

function signed(overrides: Partial<EvidenceStepUpIntent> = {}): string {
  return signEvidenceStepUpIntent({ intent: intent(overrides), secret: SECRET });
}

function githubAccount(providerAccountId = "github-subject-1") {
  return { provider: "github", providerAccountId, type: "oauth" } as const;
}

function completionPort(
  result: Awaited<
    ReturnType<EvidenceStepUpCompletionPort["completeEvidenceStepUp"]>
  > = { outcome: "elevated" },
) {
  const completeEvidenceStepUp = vi.fn(async () => result);
  return { completeEvidenceStepUp } satisfies EvidenceStepUpCompletionPort;
}

function postRequest(input?: {
  body?: string;
  origin?: string | null;
  url?: string;
}): Request {
  const headers = new Headers();
  const origin = input?.origin === undefined ? ORIGIN : input.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  return new Request(input?.url ?? STEP_UP_URL, {
    ...(input?.body === undefined ? {} : { body: input.body }),
    headers,
    method: "POST",
  });
}

describe("Evidence step-up intent signing", () => {
  it("round-trips a signed intent within its lifetime", () => {
    const value = signed();
    expect(verifyEvidenceStepUpIntent({ now: CALLBACK_NOW, secret: SECRET, value })).toEqual(
      intent(),
    );
  });

  it("rejects a tampered payload, wrong secret and malformed value", () => {
    const value = signed();
    const [payload] = value.split(".");
    const tampered = `${payload}.${"A".repeat(43)}`;
    expect(
      verifyEvidenceStepUpIntent({ now: CALLBACK_NOW, secret: SECRET, value: tampered }),
    ).toBeNull();
    expect(
      verifyEvidenceStepUpIntent({
        now: CALLBACK_NOW,
        secret: "different-secret",
        value,
      }),
    ).toBeNull();
    expect(
      verifyEvidenceStepUpIntent({ now: CALLBACK_NOW, secret: SECRET, value: "not-valid" }),
    ).toBeNull();
  });

  it("rejects expired and future-dated intents", () => {
    const expired = signed({
      issuedAt: new Date(NOW.getTime() - 6 * 60 * 1_000).toISOString(),
    });
    expect(
      verifyEvidenceStepUpIntent({ now: CALLBACK_NOW, secret: SECRET, value: expired }),
    ).toBeNull();
    const future = signed({
      issuedAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    expect(
      verifyEvidenceStepUpIntent({ now: CALLBACK_NOW, secret: SECRET, value: future }),
    ).toBeNull();
  });

  it("rejects an intent that smuggles a different capability or user", () => {
    const wrongCapability = signEvidenceStepUpIntent({
      intent: { ...intent(), capability: "candidate_review" as never },
      secret: SECRET,
    });
    expect(
      verifyEvidenceStepUpIntent({
        now: CALLBACK_NOW,
        secret: SECRET,
        value: wrongCapability,
      }),
    ).toBeNull();
    const wrongUser = signed({ userId: "not-a-uuid" });
    expect(
      verifyEvidenceStepUpIntent({ now: CALLBACK_NOW, secret: SECRET, value: wrongUser }),
    ).toBeNull();
  });
});

describe("Evidence step-up callback completion", () => {
  const baseInput = {
    account: githubAccount(),
    clock: () => CALLBACK_NOW,
    intentCookieValue: signed(),
    secret: SECRET,
    sessionCookieValue: SESSION_TOKEN,
    userId: USER_ID,
  };

  it("elevates only after a verified GitHub callback for the live session", async () => {
    const completion = completionPort();
    const outcome = await completeEvidenceStepUpFromGithubCallback({
      ...baseInput,
      completion,
    });
    expect(outcome).toEqual({ outcome: "elevated" });
    expect(completion.completeEvidenceStepUp).toHaveBeenCalledWith({
      authSessionId: SESSION_HASH,
      dataEpoch: 3,
      issuedAt: NOW,
      now: CALLBACK_NOW,
      providerAccountId: "github-subject-1",
      userId: USER_ID,
    });
  });

  it("grants nothing for ordinary sign-in without an intent", async () => {
    const completion = completionPort();
    const outcome = await completeEvidenceStepUpFromGithubCallback({
      ...baseInput,
      completion,
      intentCookieValue: null,
    });
    expect(outcome).toEqual({ outcome: "ignored", reason: "no_intent" });
    expect(completion.completeEvidenceStepUp).not.toHaveBeenCalled();
  });

  it("ignores invalid, expired and tampered intents", async () => {
    const badMac = completionPort();
    expect(
      await completeEvidenceStepUpFromGithubCallback({
        ...baseInput,
        completion: badMac,
        intentCookieValue: `${signed().split(".")[0]}.deadbeef`,
      }),
    ).toEqual({ outcome: "ignored", reason: "intent_invalid" });
    const expired = completionPort();
    expect(
      await completeEvidenceStepUpFromGithubCallback({
        ...baseInput,
        completion: expired,
        intentCookieValue: signed({
          issuedAt: new Date(NOW.getTime() - 10 * 60 * 1_000).toISOString(),
        }),
      }),
    ).toEqual({ outcome: "ignored", reason: "intent_invalid" });
    expect(badMac.completeEvidenceStepUp).not.toHaveBeenCalled();
    expect(expired.completeEvidenceStepUp).not.toHaveBeenCalled();
  });

  it("rejects a mismatched verified user or non-GitHub account", async () => {
    const wrongUser = completionPort();
    expect(
      await completeEvidenceStepUpFromGithubCallback({
        ...baseInput,
        completion: wrongUser,
        userId: "01984477-1f9a-7b25-a5cc-83c3b21fbc69",
      }),
    ).toEqual({ outcome: "denied", reason: "identity_mismatch" });
    const wrongProvider = completionPort();
    expect(
      await completeEvidenceStepUpFromGithubCallback({
        ...baseInput,
        completion: wrongProvider,
        account: { provider: "email", providerAccountId: "x", type: "email" },
      }),
    ).toEqual({ outcome: "denied", reason: "unverified_provider" });
    const missingAccount = completionPort();
    expect(
      await completeEvidenceStepUpFromGithubCallback({
        ...baseInput,
        account: null,
        completion: missingAccount,
      }),
    ).toEqual({ outcome: "denied", reason: "unverified_provider" });
    expect(wrongUser.completeEvidenceStepUp).not.toHaveBeenCalled();
    expect(wrongProvider.completeEvidenceStepUp).not.toHaveBeenCalled();
    expect(missingAccount.completeEvidenceStepUp).not.toHaveBeenCalled();
  });

  it("rejects a missing or different live session cookie", async () => {
    const missing = completionPort();
    expect(
      await completeEvidenceStepUpFromGithubCallback({
        ...baseInput,
        completion: missing,
        sessionCookieValue: null,
      }),
    ).toEqual({ outcome: "denied", reason: "session_missing" });
    const mismatch = completionPort();
    expect(
      await completeEvidenceStepUpFromGithubCallback({
        ...baseInput,
        completion: mismatch,
        sessionCookieValue: "another-session",
      }),
    ).toEqual({ outcome: "denied", reason: "session_mismatch" });
    expect(missing.completeEvidenceStepUp).not.toHaveBeenCalled();
    expect(mismatch.completeEvidenceStepUp).not.toHaveBeenCalled();
  });

  it("surfaces a fail-closed completion denial or error", async () => {
    const denied = completionPort({ outcome: "denied", reason: "replay" });
    expect(
      await completeEvidenceStepUpFromGithubCallback({
        ...baseInput,
        completion: denied,
      }),
    ).toEqual({ outcome: "denied", reason: "replay" });
    const failing: EvidenceStepUpCompletionPort = {
      completeEvidenceStepUp: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    };
    expect(
      await completeEvidenceStepUpFromGithubCallback({
        ...baseInput,
        completion: failing,
      }),
    ).toEqual({ outcome: "denied", reason: "completion_error" });
  });
});

describe("Evidence step-up intent issuer", () => {
  function issuer(overrides?: {
    authenticate?: () => Promise<{ authSessionId: string; userId: string } | null>;
    context?: EvidenceStepUpIssuerContext;
  }) {
    const repository = {
      readStepUpIssuerContext: vi.fn(async () =>
        overrides?.context ?? ISSUER_ALLOWED,
      ),
    };
    const handler = createEvidenceStepUpIntentHandler({
      authenticate:
        overrides?.authenticate ??
        (async () => ({ authSessionId: SESSION_HASH, userId: USER_ID })),
      clock: () => NOW,
      repository,
      secret: SECRET,
      secureCookie: true,
    });
    return { handler, repository };
  }

  it("rejects cross-site and origin-less requests before any read", async () => {
    const { handler, repository } = issuer();
    const crossSite = await handler(postRequest({ origin: "https://evil.test" }));
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({
      error: "cross_site_request_rejected",
    });
    const noOrigin = await handler(postRequest({ origin: null }));
    expect(noOrigin.status).toBe(403);
    expect(repository.readStepUpIssuerContext).not.toHaveBeenCalled();
  });

  it("rejects any client-supplied body and unauthenticated callers", async () => {
    const { handler, repository } = issuer();
    const withBody = await handler(
      postRequest({ body: JSON.stringify({ userId: USER_ID }) }),
    );
    expect(withBody.status).toBe(400);
    expect(await withBody.json()).toEqual({
      error: "unexpected_request_body",
    });
    const unauthenticated = issuer({
      authenticate: async () => null,
    });
    const response = await unauthenticated.handler(postRequest());
    expect(response.status).toBe(401);
    expect(repository.readStepUpIssuerContext).not.toHaveBeenCalled();
  });

  it("issues a short-lived HttpOnly callback-path intent cookie", async () => {
    const { handler } = issuer();
    const response = await handler(postRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "challenge_issued" });
    const setCookie = readSetCookies(response);
    const cookie = setCookie.find((value) =>
      value.startsWith(`${EVIDENCE_STEP_UP_INTENT_COOKIE}=`),
    );
    expect(cookie).toBeDefined();
    expect(cookie).toContain(`Path=${EVIDENCE_STEP_UP_CALLBACK_PATH}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=300");
    const value = cookie!.slice(
      `${EVIDENCE_STEP_UP_INTENT_COOKIE}=`.length,
      cookie!.indexOf(";"),
    );
    expect(
      verifyEvidenceStepUpIntent({ now: CALLBACK_NOW, secret: SECRET, value }),
    ).toMatchObject({ dataEpoch: 3, liveSessionHash: SESSION_HASH, userId: USER_ID });
  });

  it("rejects callers without the reflection inspection grant", async () => {
    const { handler } = issuer({
      context: { outcome: "denied", reason: "step_up_not_permitted" },
    });
    const response = await handler(postRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "step_up_not_permitted" });
  });
});

describe("Request-scoped auth options binding", () => {
  it("binds completion to one callback request and preserves base events", async () => {
    const completion = completionPort();
    const baseSignIn = vi.fn(async () => {});
    const baseOptions: Parameters<
      typeof requestScopedEvidenceStepUpAuthOptions
    >[0]["authOptions"] = {
      events: { signIn: baseSignIn },
      providers: [],
    };
    const request = new Request(
      `${ORIGIN}${EVIDENCE_STEP_UP_CALLBACK_PATH}?code=one&state=two`,
      {
        headers: {
          cookie: `${EVIDENCE_STEP_UP_INTENT_COOKIE}=${signed()}; sayhear.session-token=${SESSION_TOKEN}`,
        },
      },
    );
    const options = requestScopedEvidenceStepUpAuthOptions({
      authOptions: baseOptions,
      clock: () => CALLBACK_NOW,
      completion,
      request,
      secret: SECRET,
      sessionCookieName: "sayhear.session-token",
    });
    await options.events?.signIn?.({
      account: githubAccount(),
      user: { id: USER_ID },
    } as never);
    expect(baseSignIn).toHaveBeenCalledTimes(1);
    expect(completion.completeEvidenceStepUp).toHaveBeenCalledTimes(1);
    expect(completion.completeEvidenceStepUp).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "github-subject-1" }),
    );
  });

  it("clears the intent cookie on any callback response", () => {
    const response = new Response(null, { status: 302 });
    const cleared = appendEvidenceStepUpIntentCookieClear(response, {
      secure: true,
    });
    const setCookie = readSetCookies(cleared);
    expect(setCookie.join("\n")).toContain(
      `${EVIDENCE_STEP_UP_INTENT_COOKIE}=;`,
    );
    expect(setCookie.join("\n")).toContain("Max-Age=0");
    expect(EVIDENCE_STEP_UP_RETURN_PATH).toBe("/internal/reflection-inspector");
  });
});
