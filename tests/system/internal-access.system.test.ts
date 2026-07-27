import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createInternalAccessHandler } from "../../apps/web/src/internal-access-handler";
import {
  asUserId,
  createInternalOwnerAccessService,
  createUserTextConversationService,
} from "@sayhear/application";
import {
  createPostgresAuthAdapter,
  PostgresInternalOwnerAccessRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";
import { createUserTextTurnHandler } from "../../apps/web/src/user-text-turn-handler";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required; the system seam never falls back to a mock database.",
  );
}

describe("Authenticated Internal Text Conversation System Seam", () => {
  const sessionCookieName = "sayhear.session-token";
  const sessionToken = "request-path-session-token";
  let database: IsolatedPostgresSchema;
  let nextServer: RunningNextServer | undefined;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);
    await repository.provisionInternalOwner({
      issuer: "https://github.com",
      subject: "test-owner",
      userId: fixedInternalOwnerPrincipal.userId,
    });
    nextServer = await startNextTestServer(database.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await database.pool.query(`
      TRUNCATE TABLE
        conversation_event_revisions,
        conversation_events,
        interaction_turns,
        daily_sessions
    `);
    await database.pool.query("DELETE FROM auth_sessions");
    await database.pool.query("DELETE FROM backup_policy_versions");
    await createPostgresAuthAdapter(database.pool).createSession({
      expires: new Date("2099-01-01T00:00:00.000Z"),
      sessionToken,
      userId: fixedInternalOwnerPrincipal.userId,
    });
  });

  afterAll(async () => {
    await nextServer?.stop();
    await database.dispose();
  }, 10_000);

  it("keeps private writes blocked when backup evidence is absent", async () => {
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);
    const service = createInternalOwnerAccessService({
      clock: () => new Date("2026-07-27T16:00:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      repository,
    });
    const handler = createInternalAccessHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    });

    const response = await handler(new Request("http://localhost/internal/access"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      privateWrites: {
        allowed: false,
        reason: "backup_evidence_missing",
      },
    });
  });

  it("opens private writes for the current verified backup policy", async () => {
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);
    await repository.recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: "sha256:expected",
      databaseRetentionDays: 30,
      evidenceReference: "synthetic backup console evidence",
      policyVersion: "neon-production-v1",
      pitrRetentionDays: 7,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2026-08-27T16:00:00.000Z"),
      verifiedAt: new Date("2026-07-27T15:00:00.000Z"),
    });
    const service = createInternalOwnerAccessService({
      clock: () => new Date("2026-07-27T16:00:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      repository,
    });
    const handler = createInternalAccessHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    });

    const response = await handler(new Request("http://localhost/internal/access"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      privateWrites: {
        allowed: true,
        reason: "backup_evidence_current",
      },
    });
  });

  it("rejects an unconfigured GitHub identity without provisioning a user", async () => {
    const adapter = createPostgresAuthAdapter(database.pool);

    expect(
      await adapter.getUserByAccount({
        provider: "github",
        providerAccountId: "not-the-owner",
      }),
    ).toBeNull();
    await expect(
      adapter.createUser({
        email: "stranger@example.invalid",
        emailVerified: null,
        image: null,
        name: "Stranger",
      }),
    ).rejects.toThrow("pre-provisioned");

    const users = await database.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM app_users",
    );
    expect(users.rows[0]?.count).toBe("1");
  });

  it("rejects client-supplied owner identifiers at the BFF boundary", async () => {
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);
    const service = createInternalOwnerAccessService({
      clock: () => new Date("2026-07-27T16:00:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      repository,
    });
    const handler = createInternalAccessHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    });

    const response = await handler(
      new Request(
        "http://localhost/internal/access?user_id=01984477-59a9-7d20-9d97-e588769566a0",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "client_owner_identifier_not_allowed",
    });
  });

  it("derives the owner through the real Next/Auth.js/PostgreSQL request path", async () => {
    if (!nextServer) {
      throw new Error("The Next test server is not running.");
    }
    const unauthorized = await fetch(`${nextServer.origin}/api/internal/access`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${nextServer.origin}/api/internal/access`, {
      headers: {
        cookie: `${sessionCookieName}=${sessionToken}`,
      },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      privateWrites: {
        allowed: false,
        reason: "backup_evidence_missing",
      },
    });
  });

  it("rejects unauthorized, client-owned, and backup-gated User Text writes", async () => {
    if (!nextServer) {
      throw new Error("The Next test server is not running.");
    }
    const payload = {
      clientEventId: "client-event-rejected",
      clientTurnId: "client-turn-rejected",
      locale: "en-US",
      text: "This must not be persisted.",
      timezone: "America/Los_Angeles",
    };
    const unauthorized = await fetch(
      `${nextServer.origin}/api/internal/conversation/turns`,
      {
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(unauthorized.status).toBe(401);

    const clientOwned = await fetch(
      `${nextServer.origin}/api/internal/conversation/turns`,
      {
        body: JSON.stringify({
          ...payload,
          user_id: "01984477-59a9-7d20-9d97-e588769566a0",
        }),
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
        method: "POST",
      },
    );
    expect(clientOwned.status).toBe(400);
    expect(await clientOwned.json()).toEqual({
      error: "client_owner_identifier_not_allowed",
    });

    const backupGated = await fetch(
      `${nextServer.origin}/api/internal/conversation/turns`,
      {
        body: JSON.stringify(payload),
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
        method: "POST",
      },
    );
    expect(backupGated.status).toBe(409);
    expect(await backupGated.json()).toEqual({
      error: "private_writes_blocked",
      reason: "backup_evidence_missing",
    });

    const privateRecords = await database.pool.query<{ count: string }>(`
      SELECT (
        (SELECT COUNT(*) FROM daily_sessions)
        + (SELECT COUNT(*) FROM interaction_turns)
        + (SELECT COUNT(*) FROM conversation_events)
        + (SELECT COUNT(*) FROM conversation_event_revisions)
      )::text AS count
    `);
    expect(privateRecords.rows[0]?.count).toBe("0");
  });

  it("records one visible authoritative User Text Event across ten repeated submissions", async () => {
    if (!nextServer) {
      throw new Error("The Next test server is not running.");
    }
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);
    await repository.recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: "sha256:expected",
      databaseRetentionDays: 30,
      evidenceReference: "synthetic backup console evidence",
      policyVersion: "neon-production-v1",
      pitrRetentionDays: 7,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2026-08-27T16:00:00.000Z"),
      verifiedAt: new Date("2026-07-27T15:00:00.000Z"),
    });
    const payload = {
      clientEventId: "client-event-0001",
      clientTurnId: "client-turn-0001",
      locale: "en-US",
      text: "I finally made room to breathe today.",
      timezone: "America/Los_Angeles",
    };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${nextServer?.origin}/api/internal/conversation/turns`, {
          body: JSON.stringify(payload),
          headers: {
            "content-type": "application/json",
            cookie: `${sessionCookieName}=${sessionToken}`,
          },
          method: "POST",
        }),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const results = await Promise.all(responses.map((response) => response.json()));
    expect(new Set(results.map((result) => result.turn.id))).toHaveLength(1);
    expect(new Set(results.map((result) => result.message.id))).toHaveLength(1);
    expect(new Set(results.map((result) => result.message.revisionId))).toHaveLength(
      1,
    );

    await database.pool.query("DELETE FROM backup_policy_versions");
    const replayAfterGateClosed = await fetch(
      `${nextServer.origin}/api/internal/conversation/turns`,
      {
        body: JSON.stringify(payload),
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
        method: "POST",
      },
    );
    expect(replayAfterGateClosed.status).toBe(200);
    expect((await replayAfterGateClosed.json()).turn.id).toBe(results[0].turn.id);

    const visibleConversation = await fetch(`${nextServer.origin}/internal`, {
      headers: {
        cookie: `${sessionCookieName}=${sessionToken}`,
      },
    });
    expect(visibleConversation.status).toBe(200);
    expect(await visibleConversation.text()).toContain(
      "I finally made room to breathe today.",
    );

    const authoritative = await database.pool.query<{
      daily_sessions: string;
      interaction_turns: string;
      user_events: string;
      current_revisions: string;
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM daily_sessions) AS daily_sessions,
        (SELECT COUNT(*)::text FROM interaction_turns) AS interaction_turns,
        (
          SELECT COUNT(*)::text
          FROM conversation_events
          WHERE actor = 'user'
        ) AS user_events,
        (
          SELECT COUNT(*)::text
          FROM conversation_event_revisions revision
          INNER JOIN conversation_events event
            ON event.current_revision_id = revision.conversation_event_revision_id
          WHERE event.actor = 'user'
        ) AS current_revisions
    `);
    expect(authoritative.rows[0]).toEqual({
      current_revisions: "1",
      daily_sessions: "1",
      interaction_turns: "1",
      user_events: "1",
    });
    const outOfScopeRelations = await database.pool.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
        ORDER BY table_name
      `,
      [
        [
          "journal_versions",
          "entities",
          "memory_claims",
          "replay_runs",
          "voice_sessions",
          "outbox_events",
          "workflow_commands",
          "session_summary_versions",
          "dialogue_state_versions",
        ],
      ],
    );
    expect(outOfScopeRelations.rows).toEqual([]);
    const openTransactions = await database.pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM pg_stat_activity
      WHERE application_name = 'sayhear-web'
        AND state = 'idle in transaction'
    `);
    expect(openTransactions.rows[0]?.count).toBe("0");
    await expect(
      database.pool.query(`
        UPDATE conversation_event_revisions
        SET canonical_text = 'silently overwritten'
      `),
    ).rejects.toThrow("immutable");
  });

  it("reuses the same-day Session and keeps Turn, Event, and Revision identities distinct", async () => {
    if (!nextServer) {
      throw new Error("The Next test server is not running.");
    }
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);
    await repository.recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: "sha256:expected",
      databaseRetentionDays: 30,
      evidenceReference: "synthetic backup console evidence",
      policyVersion: "neon-production-v1",
      pitrRetentionDays: 7,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2026-08-27T16:00:00.000Z"),
      verifiedAt: new Date("2026-07-27T15:00:00.000Z"),
    });
    const submit = async (payload: {
      clientEventId: string;
      clientTurnId: string;
      text: string;
    }) => {
      const response = await fetch(
        `${nextServer?.origin}/api/internal/conversation/turns`,
        {
          body: JSON.stringify({
            ...payload,
            locale: "en-US",
            timezone: "America/Los_Angeles",
          }),
          headers: {
            "content-type": "application/json",
            cookie: `${sessionCookieName}=${sessionToken}`,
          },
          method: "POST",
        },
      );
      expect(response.status).toBe(200);
      return response.json();
    };

    const first = await submit({
      clientEventId: "client-event-1001",
      clientTurnId: "client-turn-1001",
      text: "First same-day expression.",
    });
    const second = await submit({
      clientEventId: "client-event-1002",
      clientTurnId: "client-turn-1002",
      text: "Second same-day expression.",
    });
    const repeatedTurn = await submit({
      clientEventId: "a-new-event-key-that-must-not-create-an-event",
      clientTurnId: "client-turn-1002",
      text: "This payload must not replace the original expression.",
    });

    expect(second.dailySession.id).toBe(first.dailySession.id);
    expect(first.turn.sequence).toBe(1);
    expect(second.turn.sequence).toBe(2);
    expect(second.message.sequence).toBe(2);
    expect(repeatedTurn.turn.id).toBe(second.turn.id);
    expect(repeatedTurn.message.id).toBe(second.message.id);
    expect(repeatedTurn.message.text).toBe("Second same-day expression.");
    const conflictingKeys = await fetch(
      `${nextServer.origin}/api/internal/conversation/turns`,
      {
        body: JSON.stringify({
          clientEventId: "client-event-1002",
          clientTurnId: "client-turn-1001",
          locale: "en-US",
          text: "Conflicting keys must not select either existing identity.",
          timezone: "America/Los_Angeles",
        }),
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
        method: "POST",
      },
    );
    expect(conflictingKeys.status).toBe(409);
    expect(await conflictingKeys.json()).toEqual({
      error: "idempotency_key_conflict",
    });
    const uuidV7 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const persistentIds = [
      first.dailySession.id,
      first.turn.id,
      first.message.id,
      first.message.revisionId,
      second.turn.id,
      second.message.id,
      second.message.revisionId,
    ];
    expect(persistentIds.every((id) => uuidV7.test(id))).toBe(true);
    expect(new Set(persistentIds)).toHaveLength(persistentIds.length);

    const authoritative = await database.pool.query<{
      daily_sessions: string;
      dialogue_revision: string;
      interaction_turns: string;
      source_revision: string;
      user_events: string;
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM daily_sessions) AS daily_sessions,
        (SELECT COUNT(*)::text FROM interaction_turns) AS interaction_turns,
        (SELECT COUNT(*)::text FROM conversation_events) AS user_events,
        dialogue_revision::text,
        source_revision::text
      FROM daily_sessions
    `);
    expect(authoritative.rows[0]).toEqual({
      daily_sessions: "1",
      dialogue_revision: "2",
      interaction_turns: "2",
      source_revision: "2",
      user_events: "2",
    });

    const otherEventRevisionId = "01984477-59a9-7d20-9d97-e588769566a1";
    await database.pool.query(
      `
        INSERT INTO conversation_event_revisions (
          conversation_event_revision_id,
          user_id,
          conversation_event_id,
          revision,
          locale,
          canonical_text,
          transcript_status,
          created_by,
          created_at
        )
        VALUES ($1, $2, $3, 2, 'en-US', 'corrected', 'corrected', 'user_correction', NOW())
      `,
      [
        otherEventRevisionId,
        fixedInternalOwnerPrincipal.userId,
        second.message.id,
      ],
    );
    await expect(
      database.pool.query(
        `
          UPDATE conversation_events
          SET current_revision_id = $1
          WHERE conversation_event_id = $2
        `,
        [otherEventRevisionId, first.message.id],
      ),
    ).rejects.toThrow("conversation_events_current_revision_fk");

    const otherDailySessionId = "01984477-59a9-7d20-9d97-e588769566a2";
    await database.pool.query(
      `
        INSERT INTO daily_sessions (
          daily_session_id,
          user_id,
          logical_date,
          timezone_at_start,
          started_at,
          last_activity_at,
          activity_state,
          created_at,
          updated_at
        )
        VALUES ($1, $2, '2026-07-28', 'America/Los_Angeles', NOW(), NOW(), 'quiescent', NOW(), NOW())
      `,
      [otherDailySessionId, fixedInternalOwnerPrincipal.userId],
    );
    await expect(
      database.pool.query(
        `
          UPDATE conversation_events
          SET daily_session_id = $1
          WHERE conversation_event_id = $2
        `,
        [otherDailySessionId, first.message.id],
      ),
    ).rejects.toThrow("conversation_events_interaction_turn_session_fk");
  });

  it("keeps a cross-midnight active exchange in its original Daily Session", async () => {
    if (!nextServer) {
      throw new Error("The Next test server is not running.");
    }
    const accessRepository = new PostgresInternalOwnerAccessRepository(
      database.pool,
    );
    await accessRepository.recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: "sha256:expected",
      databaseRetentionDays: 30,
      evidenceReference: "synthetic backup console evidence",
      policyVersion: "neon-production-v1",
      pitrRetentionDays: 7,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2026-08-27T16:00:00.000Z"),
      verifiedAt: new Date("2026-07-27T15:00:00.000Z"),
    });
    const firstResponse = await fetch(
      `${nextServer.origin}/api/internal/conversation/turns`,
      {
        body: JSON.stringify({
          clientEventId: "before-midnight-event",
          clientTurnId: "before-midnight-turn",
          locale: "en-US",
          text: "The exchange starts before midnight.",
          timezone: "America/Los_Angeles",
        }),
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
        method: "POST",
      },
    );
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();

    const conversationService = createUserTextConversationService({
      clock: () => new Date("2026-07-28T08:30:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const afterMidnight = await createUserTextTurnHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service: conversationService,
    })(
      new Request("http://localhost/api/internal/conversation/turns", {
        body: JSON.stringify({
          clientEventId: "after-midnight-event",
          clientTurnId: "after-midnight-turn",
          locale: "en-US",
          text: "The same active exchange continues after midnight.",
          timezone: "America/Los_Angeles",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(afterMidnight.status).toBe(200);
    const second = await afterMidnight.json();
    expect(second.dailySession.id).toBe(first.dailySession.id);
    expect(second.dailySession.logicalDate).toBe("2026-07-27");
  });

  it("reactivates a same-day quiescent Session in the User Event transaction", async () => {
    const accessRepository = new PostgresInternalOwnerAccessRepository(
      database.pool,
    );
    await accessRepository.recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: "sha256:expected",
      databaseRetentionDays: 30,
      evidenceReference: "synthetic backup console evidence",
      policyVersion: "neon-production-v1",
      pitrRetentionDays: 7,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2026-08-27T16:00:00.000Z"),
      verifiedAt: new Date("2026-07-27T15:00:00.000Z"),
    });
    const dailySessionId = "01984477-59a9-7d20-9d97-e588769566a3";
    await database.pool.query(
      `
        INSERT INTO daily_sessions (
          daily_session_id,
          user_id,
          logical_date,
          timezone_at_start,
          started_at,
          last_activity_at,
          activity_state,
          current_continuous_exchange_no,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          '2026-07-27',
          'America/Los_Angeles',
          '2026-07-27T15:00:00.000Z',
          '2026-07-27T15:30:00.000Z',
          'quiescent',
          1,
          '2026-07-27T15:00:00.000Z',
          '2026-07-27T15:30:00.000Z'
        )
      `,
      [dailySessionId, fixedInternalOwnerPrincipal.userId],
    );
    const service = createUserTextConversationService({
      clock: () => new Date("2026-07-27T16:00:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const response = await createUserTextTurnHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    })(
      new Request("http://localhost/api/internal/conversation/turns", {
        body: JSON.stringify({
          clientEventId: "reactivated-event",
          clientTurnId: "reactivated-turn",
          locale: "en-US",
          text: "I came back with one more thing from today.",
          timezone: "America/Los_Angeles",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.dailySession.id).toBe(dailySessionId);

    const state = await database.pool.query<{
      activity_state: string;
      current_continuous_exchange_no: number;
      turn_exchange_no: number;
    }>(
      `
        SELECT
          session.activity_state,
          session.current_continuous_exchange_no,
          turn.continuous_exchange_no AS turn_exchange_no
        FROM daily_sessions session
        INNER JOIN interaction_turns turn
          ON turn.daily_session_id = session.daily_session_id
        WHERE session.daily_session_id = $1
      `,
      [dailySessionId],
    );
    expect(state.rows[0]).toEqual({
      activity_state: "active",
      current_continuous_exchange_no: 2,
      turn_exchange_no: 2,
    });
  });

  it("keeps the pre-provisioned owner identity immutable", async () => {
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);

    await expect(
      repository.provisionInternalOwner({
        issuer: "https://github.com",
        subject: "test-owner",
        userId: asUserId("01984477-59a9-7d20-9d97-e588769566a0"),
      }),
    ).rejects.toThrow("already provisioned");

    const users = await database.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM app_users",
    );
    expect(users.rows[0]?.count).toBe("1");
  });

  it("creates and revokes a PostgreSQL-backed Auth.js session without storing the raw token", async () => {
    const adapter = createPostgresAuthAdapter(database.pool, {
      clock: () => new Date("2026-07-27T16:00:00.000Z"),
    });
    const expires = new Date("2026-07-28T16:00:00.000Z");

    await adapter.createSession({
      expires,
      sessionToken: "synthetic-session-token",
      userId: fixedInternalOwnerPrincipal.userId,
    });

    const { getSessionAndUser } = adapter;
    expect(await getSessionAndUser("synthetic-session-token")).toEqual({
      session: {
        expires,
        sessionToken: "synthetic-session-token",
        userId: fixedInternalOwnerPrincipal.userId,
      },
      user: {
        email: null,
        emailVerified: null,
        id: fixedInternalOwnerPrincipal.userId,
        image: null,
        name: "Internal Owner",
      },
    });
    const storedToken = await database.pool.query<{ stores_raw: boolean }>(
      `
        SELECT session_token_hash = convert_to($1, 'UTF8') AS stores_raw
        FROM auth_sessions
        LIMIT 1
      `,
      ["synthetic-session-token"],
    );
    expect(storedToken.rows[0]?.stores_raw).toBe(false);

    const expiredAdapter = createPostgresAuthAdapter(database.pool, {
      clock: () => new Date("2026-07-29T16:00:00.000Z"),
    });
    expect(
      await expiredAdapter.getSessionAndUser("synthetic-session-token"),
    ).toBeNull();

    await adapter.deleteSession("synthetic-session-token");
    expect(await getSessionAndUser("synthetic-session-token")).toBeNull();
  });
});

type RunningNextServer = Readonly<{
  origin: string;
  stop(): Promise<void>;
}>;

async function startNextTestServer(
  databaseUrl: string,
): Promise<RunningNextServer> {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const webDirectory = fileURLToPath(
    new URL("../../apps/web/", import.meta.url),
  );
  const nextBinary = fileURLToPath(
    new URL("../../apps/web/node_modules/next/dist/bin/next", import.meta.url),
  );
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBinary, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: webDirectory,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        GITHUB_CLIENT_ID: "system-test-client",
        GITHUB_CLIENT_SECRET: "system-test-client-secret",
        NEXTAUTH_SECRET: "system-test-server-only-secret",
        NEXTAUTH_URL: origin,
        NODE_ENV: "development",
        SAYHEAR_AUTH_SECRET_SOURCE: "managed",
        SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "sha256:expected",
        SAYHEAR_BACKUP_POLICY_VERSION: "neon-production-v1",
        SAYHEAR_DEPLOYMENT: "test",
        SAYHEAR_TEST_NOW: "2026-07-27T16:00:00.000Z",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = captureOutput(child);

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Next test server exited early.\n${output.read()}`);
    }
    try {
      const response = await fetch(`${origin}/api/internal/access`);
      if (response.status === 401) {
        return {
          origin,
          async stop() {
            await stopChild(child);
          },
        };
      }
    } catch {
      // The listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await stopChild(child);
  throw new Error(`Next test server did not become ready.\n${output.read()}`);
}

function captureOutput(child: ChildProcess): { read(): string } {
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  return {
    read: () => output,
  };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const forceStop = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(forceStop);
      resolve();
    });
  });
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local port for the Next test server.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}
