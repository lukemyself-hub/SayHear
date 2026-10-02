import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EVIDENCE_STEP_UP_MAX_AGE_MS,
  PostgresEvidenceStepUpRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const systemDescribe = testDatabaseUrl ? describe : describe.skip;

const OWNER = fixedInternalOwnerPrincipal.userId;
const NOW = new Date("2026-10-02T12:00:00.000Z");
const CALLBACK_NOW = new Date(NOW.getTime() + 30_000);
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
const GITHUB_SUBJECT = "github-subject-1";
const WRONG_SUBJECT = "github-subject-other";
const POLICY_TABLES = [
  "sensitive_access_audits",
  "memory_candidates",
  "reflections",
  "bios",
] as const;

systemDescribe("Evidence step-up writer — ADR-0129", () => {
  let database: IsolatedPostgresSchema | undefined;
  let repository: PostgresEvidenceStepUpRepository;

  async function createSession(input?: {
    conversation?: "active" | "revoked";
    expiresAt?: Date;
    reflection?: boolean;
    stepUpAt?: Date | null;
  }): Promise<string> {
    const token = `evidence-step-up-${randomUUID()}`;
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    await database!.pool.query(
      `INSERT INTO auth_sessions (
         session_token_hash, user_id, expires_at, created_at, updated_at
       ) VALUES (decode($1, 'hex'), $2, $3, $4, $4)`,
      [hash, OWNER, input?.expiresAt ?? FAR_FUTURE, NOW],
    );
    if (input?.reflection !== false) {
      await database!.pool.query(
        `INSERT INTO internal_diagnostic_access_grants (
           session_token_hash, capability, status, step_up_authenticated_at,
           updated_at
         ) VALUES (decode($1, 'hex'), 'reflection_inspection:read', 'active',
           NULL, $2)`,
        [hash, NOW],
      );
    }
    if (input?.conversation) {
      await database!.pool.query(
        `INSERT INTO internal_diagnostic_access_grants (
           session_token_hash, capability, status, step_up_authenticated_at,
           updated_at
         ) VALUES (decode($1, 'hex'), 'conversation_content:read', $2, $3, $4)`,
        [hash, input.conversation, input.stepUpAt ?? null, NOW],
      );
    }
    return hash;
  }

  async function conversationGrant(
    authSessionId: string,
  ): Promise<{ status: string; stepUpAt: Date | null } | null> {
    const result = await database!.pool.query<{
      status: string;
      step_up_authenticated_at: Date | null;
    }>(
      `SELECT status, step_up_authenticated_at
       FROM internal_diagnostic_access_grants
       WHERE session_token_hash = decode($1, 'hex')
         AND capability = 'conversation_content:read'`,
      [authSessionId],
    );
    const row = result.rows[0];
    return row
      ? { status: row.status, stepUpAt: row.step_up_authenticated_at }
      : null;
  }

  async function policyCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of POLICY_TABLES) {
      const result = await database!.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      counts[table] = Number(result.rows[0]?.count ?? "0");
    }
    return counts;
  }

  function completion(authSessionId: string, overrides?: {
    dataEpoch?: number;
    issuedAt?: Date;
    now?: Date;
    providerAccountId?: string;
  }) {
    return repository.completeEvidenceStepUp({
      authSessionId,
      dataEpoch: overrides?.dataEpoch ?? 1,
      issuedAt: overrides?.issuedAt ?? NOW,
      now: overrides?.now ?? CALLBACK_NOW,
      providerAccountId: overrides?.providerAccountId ?? GITHUB_SUBJECT,
      userId: OWNER,
    });
  }

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl!);
    await runMigrations(database.pool);
    await database.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [OWNER, NOW],
    );
    await database.pool.query(
      `INSERT INTO internal_owner_identities (
         owner_slot, issuer, subject, user_id, active, created_at
       ) VALUES (1, 'https://github.com', $1, $2, TRUE, $3)`,
      [GITHUB_SUBJECT, OWNER, NOW],
    );
    repository = new PostgresEvidenceStepUpRepository(database.pool);
  }, 60_000);

  afterAll(async () => {
    await database?.dispose();
  });

  it("issues an intent only for the live owner session with reflection access", async () => {
    const allowed = await createSession();
    expect(
      await repository.readStepUpIssuerContext({
        authSessionId: allowed,
        now: NOW,
        userId: OWNER,
      }),
    ).toEqual({ outcome: "allowed", dataEpoch: 1 });

    const withoutReflection = await createSession({ reflection: false });
    expect(
      await repository.readStepUpIssuerContext({
        authSessionId: withoutReflection,
        now: NOW,
        userId: OWNER,
      }),
    ).toEqual({ outcome: "denied", reason: "step_up_not_permitted" });

    expect(
      await repository.readStepUpIssuerContext({
        authSessionId: allowed,
        now: NOW,
        userId: "01984477-1f9a-7b25-a5cc-83c3b21fbc69",
      }),
    ).toEqual({ outcome: "denied", reason: "step_up_not_permitted" });
  });

  it("creates the source grant only after a verified completion", async () => {
    const session = await createSession();
    expect(await conversationGrant(session)).toBeNull();

    expect(await completion(session)).toEqual({ outcome: "elevated" });

    const grant = await conversationGrant(session);
    expect(grant?.status).toBe("active");
    expect(grant?.stepUpAt?.getTime()).toBe(CALLBACK_NOW.getTime());
  });

  it("fences a replay of the same intent", async () => {
    const session = await createSession();
    expect(await completion(session)).toEqual({ outcome: "elevated" });
    const first = await conversationGrant(session);

    expect(
      await completion(session, {
        now: new Date(CALLBACK_NOW.getTime() + 10_000),
      }),
    ).toEqual({ outcome: "denied", reason: "replay" });

    const after = await conversationGrant(session);
    expect(after?.stepUpAt?.getTime()).toBe(first?.stepUpAt?.getTime());
  });

  it("serializes concurrent callbacks so exactly one elevates", async () => {
    const session = await createSession();
    const results = await Promise.all([completion(session), completion(session)]);
    expect(results.filter((result) => result.outcome === "elevated")).toHaveLength(
      1,
    );
    expect(
      results.filter(
        (result) => result.outcome === "denied" && result.reason === "replay",
      ),
    ).toHaveLength(1);
    const rows = await database!.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM internal_diagnostic_access_grants
       WHERE session_token_hash = decode($1, 'hex')
         AND capability = 'conversation_content:read'`,
      [session],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("fails closed for wrong identity, epoch, session, grant and expiry", async () => {
    const wrongIdentity = await createSession();
    expect(
      await completion(wrongIdentity, { providerAccountId: WRONG_SUBJECT }),
    ).toEqual({ outcome: "denied", reason: "identity_unverified" });
    expect(await conversationGrant(wrongIdentity)).toBeNull();

    const wrongEpoch = await createSession();
    expect(await completion(wrongEpoch, { dataEpoch: 2 })).toEqual({
      outcome: "denied",
      reason: "epoch_mismatch",
    });
    expect(await conversationGrant(wrongEpoch)).toBeNull();

    const expiredSession = await createSession({
      expiresAt: new Date(NOW.getTime() - 60_000),
    });
    expect(await completion(expiredSession)).toEqual({
      outcome: "denied",
      reason: "session_mismatch",
    });

    const noReflection = await createSession({ reflection: false });
    expect(await completion(noReflection)).toEqual({
      outcome: "denied",
      reason: "authorization_revoked",
    });

    const expiredIntent = await createSession();
    expect(
      await completion(expiredIntent, {
        issuedAt: new Date(NOW.getTime() - EVIDENCE_STEP_UP_MAX_AGE_MS - 1_000),
        now: NOW,
      }),
    ).toEqual({ outcome: "denied", reason: "intent_expired" });
    expect(await conversationGrant(expiredIntent)).toBeNull();
  });

  it("never reactivates a revoked source grant", async () => {
    const session = await createSession({ conversation: "revoked" });
    expect(await completion(session)).toEqual({
      outcome: "denied",
      reason: "grant_revoked",
    });
    const grant = await conversationGrant(session);
    expect(grant?.status).toBe("revoked");
    expect(grant?.stepUpAt).toBeNull();
  });

  it("writes no audit rows and no unrelated product state", async () => {
    const before = await policyCounts();
    const session = await createSession();
    expect(await completion(session)).toEqual({ outcome: "elevated" });
    const denied = await createSession();
    expect(
      await completion(denied, { providerAccountId: WRONG_SUBJECT }),
    ).toEqual({ outcome: "denied", reason: "identity_unverified" });
    expect(await policyCounts()).toEqual(before);
  });
});
