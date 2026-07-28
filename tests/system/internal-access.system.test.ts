import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createInternalAccessHandler } from "../../apps/web/src/internal-access-handler";
import {
  asUserId,
  createContextCompiler,
  createConversationResponseService,
  createInternalOwnerAccessService,
  createUserTextConversationService,
  type ConversationTextModel,
} from "@sayhear/application";
import {
  createDeterministicConversationTextModel,
  createProviderEgressPort,
} from "@sayhear/ai";
import {
  createPostgresAuthAdapter,
  PostgresConversationResponseRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";
import { createConversationResponseHandler } from "../../apps/web/src/conversation-response-handler";
import { createConversationRetryHandler } from "../../apps/web/src/conversation-retry-handler";
import { createUserTextTurnHandler } from "../../apps/web/src/user-text-turn-handler";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required; the system seam never falls back to a mock database.",
  );
}
const testGenerationPolicy = Object.freeze({
  freshnessPolicy: "source_valid:v1" as const,
  localePolicyVersion: "locale-pack:v1",
  model: "gpt-5.4",
  modelConfigVersion: "conversation-text-champion:v1",
  modelSnapshot: "gpt-5.4",
  productPolicyVersion: "product-policy:v1",
  promptVersion: "conversation-text:v1",
  provider: "openai" as const,
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
});
const testChampion = Object.freeze({
  configVersion: "conversation-text-champion:v1",
  contextLimit: 1_000_000,
  dataRegion: "test",
  model: "gpt-5.4",
  provider: "openai" as const,
  retentionMode: "store-disabled",
  snapshot: "gpt-5.4",
  streaming: true as const,
  supportedLocales: Object.freeze(["en", "zh"]),
  trainingPolicy: "test",
});
const fixedResponseClock = () => new Date("2026-07-27T16:00:00.000Z");

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
        provider_egress_dispositions,
        compiled_context_revision_refs,
        compiled_contexts,
        model_run_attempts,
        generation_commands,
        conversation_event_revisions,
        conversation_events,
        interaction_turns,
        daily_sessions
    `);
    await database.pool.query("DELETE FROM auth_sessions");
    await database.pool.query("DELETE FROM backup_policy_versions");
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
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

  async function openPrivateWrites(): Promise<void> {
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).recordBackupPolicyEvidence({
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
  }

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

  it("streams one Complete Assistant Response and commits it authoritatively", async () => {
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

    const response = await fetch(
      `${nextServer.origin}/api/internal/conversation/responses`,
      {
        body: JSON.stringify({
          clientEventId: "client-event-response-0001",
          clientTurnId: "client-turn-response-0001",
          locale: "en-US",
          text: "Today felt heavier than I expected.",
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
    expect(response.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    const streamEvents = await readNdjson(response);
    expect(
      streamEvents.map((event) => event.type),
      JSON.stringify(streamEvents),
    ).toEqual([
      "user_committed",
      "assistant_delta",
      "assistant_delta",
      "assistant_committed",
    ]);
    expect(
      streamEvents
        .filter((event) => event.type === "assistant_delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe("That sounds like a lot to carry.");

    const authoritative = await database.pool.query<{
      assistant_events: string;
      assistant_revisions: string;
      attempt_status: string;
      authoritative_result_id: string | null;
      command_status: string;
      cost_micros: string | null;
      dialogue_revision: string;
      egress_status: string;
      expected_data_epoch: string;
      freshness_policy: string;
      input_revision_id: string;
      locale: string;
      model_config_version: string;
      prompt_version: string;
      turn_status: string;
      user_events: string;
    }>(`
      SELECT
        (
          SELECT COUNT(*)::text
          FROM conversation_events
          WHERE actor = 'user'
        ) AS user_events,
        (
          SELECT COUNT(*)::text
          FROM conversation_events
          WHERE actor = 'assistant'
        ) AS assistant_events,
        (
          SELECT COUNT(*)::text
          FROM conversation_event_revisions revision
          INNER JOIN conversation_events event
            ON event.current_revision_id = revision.conversation_event_revision_id
          WHERE event.actor = 'assistant'
        ) AS assistant_revisions,
        command.input_revision_id::text,
        command.prompt_version,
        command.model_config_version,
        command.locale,
        command.freshness_policy,
        command.expected_data_epoch::text,
        command.status AS command_status,
        command.authoritative_result_id::text,
        attempt.status AS attempt_status,
        attempt.cost_micros::text,
        egress.status AS egress_status,
        turn.status AS turn_status,
        session.dialogue_revision::text
      FROM generation_commands command
      INNER JOIN model_run_attempts attempt
        ON attempt.generation_command_id = command.generation_command_id
      INNER JOIN provider_egress_dispositions egress
        ON egress.model_run_attempt_id = attempt.model_run_attempt_id
      INNER JOIN interaction_turns turn
        ON turn.interaction_turn_id = command.interaction_turn_id
      INNER JOIN daily_sessions session
        ON session.daily_session_id = turn.daily_session_id
    `);
    expect(authoritative.rows[0]).toMatchObject({
      assistant_events: "1",
      assistant_revisions: "1",
      attempt_status: "succeeded",
      command_status: "succeeded",
      cost_micros: "0",
      dialogue_revision: "2",
      egress_status: "completed",
      expected_data_epoch: "1",
      freshness_policy: "source_valid:v1",
      locale: "en-US",
      model_config_version: "conversation-text-champion:v1",
      prompt_version: "conversation-text:v1",
      turn_status: "settled",
      user_events: "1",
    });
    expect(authoritative.rows[0]?.authoritative_result_id).not.toBeNull();
    expect(authoritative.rows[0]?.input_revision_id).toBe(
      streamEvents[0]?.userEventRevisionId,
    );

    const replay = await fetch(
      `${nextServer.origin}/api/internal/conversation/responses`,
      {
        body: JSON.stringify({
          clientEventId: "client-event-response-0001",
          clientTurnId: "client-turn-response-0001",
          locale: "en-US",
          text: "Today felt heavier than I expected.",
          timezone: "America/Los_Angeles",
        }),
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
        method: "POST",
      },
    );
    const replayEvents = await readNdjson(replay);
    expect(replayEvents.map((event) => event.type)).toEqual([
      "user_committed",
      "assistant_delta",
      "assistant_committed",
    ]);
    expect(replayEvents[1]?.delta).toBe("That sounds like a lot to carry.");
    expect(replayEvents[2]).toMatchObject({
      eventId: streamEvents[3]?.eventId,
      revisionId: streamEvents[3]?.revisionId,
    });
    const replayCardinality = await database.pool.query<{
      assistant_events: string;
      attempts: string;
      egresses: string;
    }>(`
      SELECT
        (
          SELECT COUNT(*)::text
          FROM conversation_events
          WHERE actor = 'assistant'
        ) AS assistant_events,
        (SELECT COUNT(*)::text FROM model_run_attempts) AS attempts,
        (SELECT COUNT(*)::text FROM provider_egress_dispositions) AS egresses
    `);
    expect(replayCardinality.rows[0]).toEqual({
      assistant_events: "1",
      attempts: "1",
      egresses: "1",
    });

    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const canceledReplay = createConversationResponseService({
      clock: fixedResponseClock,
      contextCompiler: createContextCompiler({
        clock: fixedResponseClock,
        compilerVersion: "context-compiler:v1",
        contentHmacSecret: "test-context-integrity-secret",
        rawEventTokenBudget: 4_000,
        repository: responseRepository,
      }),
      conversationService: createUserTextConversationService({
        clock: fixedResponseClock,
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        repository: new PostgresUserTextConversationRepository(database.pool),
      }),
      egressPort: createProviderEgressPort({
        champion: testChampion,
        clock: fixedResponseClock,
        model: createDeterministicConversationTextModel({
          chunks: ["must not run"],
        }),
        repository: responseRepository,
      }),
      repository: responseRepository,
    })
      .respond(fixedInternalOwnerPrincipal.userId, {
        clientEventId: "client-event-response-0001",
        clientTurnId: "client-turn-response-0001",
        locale: "en-US",
        text: "Today felt heavier than I expected.",
        timezone: "America/Los_Angeles",
      })
      [Symbol.asyncIterator]();
    expect((await canceledReplay.next()).value?.type).toBe("user_committed");
    await canceledReplay.return?.();
    const completedAudit = await database.pool.query<{ status: string }>(
      "SELECT status FROM provider_egress_dispositions",
    );
    expect(completedAudit.rows[0]?.status).toBe("completed");
  });

  it("rejects a stale source before provider dispatch", async () => {
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
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const compiler = createContextCompiler({
      clock: fixedResponseClock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    let providerCalls = 0;
    const model = {
      async *stream() {
        providerCalls += 1;
        yield { delta: "must not leave SayHear", type: "delta" as const };
        yield {
          costMicros: 0,
          finishReason: "completed",
          inputTokens: 1,
          modelSnapshot: "gpt-5.4",
          outputTokens: 1,
          providerRequestId: "must-not-exist",
          type: "completed" as const,
        };
      },
    } satisfies ConversationTextModel;
    const service = createConversationResponseService({
      clock: fixedResponseClock,
      contextCompiler: {
        async compile(input) {
          const context = await compiler.compile(input);
          await database.pool.query(
            `
              UPDATE app_users
              SET data_epoch = data_epoch + 1
              WHERE user_id = $1
            `,
            [fixedInternalOwnerPrincipal.userId],
          );
          return context;
        },
      },
      conversationService: createUserTextConversationService({
        clock: fixedResponseClock,
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        repository: new PostgresUserTextConversationRepository(database.pool),
      }),
      egressPort: createProviderEgressPort({
        champion: testChampion,
        clock: fixedResponseClock,
        model,
        repository: responseRepository,
      }),
      repository: responseRepository,
    });
    const response = await createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    })(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify({
          clientEventId: "pre-dispatch-fence-event",
          clientTurnId: "pre-dispatch-fence-turn",
          locale: "en-US",
          text: "This source becomes stale before egress.",
          timezone: "America/Los_Angeles",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    const events = await readNdjson(response);
    expect(events.map((event) => event.type)).toEqual([
      "user_committed",
      "response_failed",
    ]);
    expect(events[1]?.category).toBe("policy_blocked");
    expect(providerCalls).toBe(0);
    const state = await database.pool.query<{
      assistant_events: string;
      attempt_status: string;
      command_status: string;
      egress_status: string;
    }>(`
      SELECT
        command.status AS command_status,
        attempt.status AS attempt_status,
        egress.status AS egress_status,
        (
          SELECT COUNT(*)::text
          FROM conversation_events
          WHERE actor = 'assistant'
        ) AS assistant_events
      FROM generation_commands command
      INNER JOIN model_run_attempts attempt
        ON attempt.generation_command_id = command.generation_command_id
      INNER JOIN provider_egress_dispositions egress
        ON egress.model_run_attempt_id = attempt.model_run_attempt_id
    `);
    expect(state.rows[0]).toEqual({
      assistant_events: "0",
      attempt_status: "failed",
      command_status: "failed",
      egress_status: "blocked",
    });
  });

  it("keeps visible partial output transient when the commit fence closes", async () => {
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
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const model = {
      async *stream() {
        yield { delta: "Visible but not authoritative.", type: "delta" as const };
        await database.pool.query(
          `
            UPDATE app_users
            SET data_epoch = data_epoch + 1
            WHERE user_id = $1
          `,
          [fixedInternalOwnerPrincipal.userId],
        );
        yield {
          costMicros: 0,
          finishReason: "completed",
          inputTokens: 8,
          modelSnapshot: "gpt-5.4",
          outputTokens: 8,
          providerRequestId: "provider-request-fenced",
          type: "completed" as const,
        };
      },
    } satisfies ConversationTextModel;
    const contextCompiler = createContextCompiler({
      clock: fixedResponseClock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    const service = createConversationResponseService({
      clock: fixedResponseClock,
      contextCompiler,
      conversationService: createUserTextConversationService({
        clock: fixedResponseClock,
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        repository: new PostgresUserTextConversationRepository(database.pool),
      }),
      egressPort: createProviderEgressPort({
        champion: testChampion,
        clock: fixedResponseClock,
        model,
        repository: responseRepository,
      }),
      repository: responseRepository,
    });
    const response = await createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    })(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify({
          clientEventId: "commit-fence-event",
          clientTurnId: "commit-fence-turn",
          locale: "en-US",
          text: "This source becomes stale after dispatch.",
          timezone: "America/Los_Angeles",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    const events = await readNdjson(response);
    expect(events.map((event) => event.type)).toEqual([
      "user_committed",
      "assistant_delta",
      "response_interrupted",
    ]);
    expect(events[1]?.delta).toBe("Visible but not authoritative.");
    expect(events[2]?.category).toBe("policy_blocked");
    const state = await database.pool.query<{
      assistant_events: string;
      attempt_status: string;
      command_status: string;
      dialogue_revision: string;
      turn_status: string;
    }>(`
      SELECT
        command.status AS command_status,
        attempt.status AS attempt_status,
        turn.status AS turn_status,
        session.dialogue_revision::text,
        (
          SELECT COUNT(*)::text
          FROM conversation_events
          WHERE actor = 'assistant'
        ) AS assistant_events
      FROM generation_commands command
      INNER JOIN model_run_attempts attempt
        ON attempt.generation_command_id = command.generation_command_id
      INNER JOIN interaction_turns turn
        ON turn.interaction_turn_id = command.interaction_turn_id
      INNER JOIN daily_sessions session
        ON session.daily_session_id = turn.daily_session_id
    `);
    expect(state.rows[0]).toEqual({
      assistant_events: "0",
      attempt_status: "interrupted",
      command_status: "interrupted",
      dialogue_revision: "1",
      turn_status: "interrupted",
    });
    const persistedChunkRelations = await database.pool.query<{
      table_name: string;
    }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name ILIKE ANY(ARRAY['%chunk%', '%stream%'])
    `);
    expect(persistedChunkRelations.rows).toEqual([]);
  });

  it("keeps an interrupted Turn immutable and retries it once through a linked Turn", async () => {
    await openPrivateWrites();
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const conversationService = createUserTextConversationService({
      clock: fixedResponseClock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const createService = (model: ConversationTextModel) =>
      createConversationResponseService({
        clock: fixedResponseClock,
        contextCompiler: createContextCompiler({
          clock: fixedResponseClock,
          compilerVersion: "context-compiler:v1",
          contentHmacSecret: "test-context-integrity-secret",
          rawEventTokenBudget: 4_000,
          repository: responseRepository,
        }),
        conversationService,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: fixedResponseClock,
          model,
          repository: responseRepository,
        }),
        repository: responseRepository,
      });

    const interruptedService = createService(
      createDeterministicConversationTextModel({
        chunks: ["Visible prefix.", " Must not become authoritative."],
        failAfterChunks: 1,
      }),
    );
    const originalRequest = {
      clientEventId: "interrupted-original-event",
      clientTurnId: "interrupted-original-turn",
      locale: "en-US",
      text: "Please stay with what I just said.",
      timezone: "America/Los_Angeles",
    };
    const interruptedResponse = await createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service: interruptedService,
    })(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify(originalRequest),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const interruptedEvents = await readNdjson(interruptedResponse);
    expect(interruptedEvents.map((event) => event.type)).toEqual([
      "user_committed",
      "assistant_delta",
      "response_interrupted",
    ]);
    expect(interruptedEvents[1]?.delta).toBe("Visible prefix.");
    const originalTurnId = interruptedEvents[0]?.turnId;
    expect(typeof originalTurnId).toBe("string");
    expect(
      await conversationService.listInterruptedResponses(
        fixedInternalOwnerPrincipal.userId,
      ),
    ).toEqual([
      {
        logicalDate: "2026-07-27",
        retryStatus: "available",
        sequence: 1,
        turnId: originalTurnId,
      },
    ]);

    let successfulProviderCalls = 0;
    const successfulModel = {
      async *stream() {
        successfulProviderCalls += 1;
        yield { delta: "A new, complete answer.", type: "delta" as const };
        yield {
          costMicros: 0,
          finishReason: "completed",
          inputTokens: 8,
          modelSnapshot: "gpt-5.4",
          outputTokens: 6,
          providerRequestId: "retry-provider-request",
          type: "completed" as const,
        };
      },
    } satisfies ConversationTextModel;
    const retryService = createService(successfulModel);

    const originalReplay = await createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service: retryService,
    })(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify(originalRequest),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(
      (await readNdjson(originalReplay)).map((event) => event.type),
    ).toEqual(["user_committed", "response_interrupted"]);
    expect(successfulProviderCalls).toBe(0);

    const nextTextResponse = await createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service: retryService,
    })(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify({
          clientEventId: "after-interruption-event",
          clientTurnId: "after-interruption-turn",
          locale: "en-US",
          text: "This is the next Text Turn.",
          timezone: "America/Los_Angeles",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(
      (await readNdjson(nextTextResponse)).at(-1)?.type,
    ).toBe("assistant_committed");
    expect(successfulProviderCalls).toBe(1);
    const nextTextContext = await database.pool.query<{ text: string }>(
      `
        SELECT revision.canonical_text AS text
        FROM interaction_turns turn
        INNER JOIN generation_commands command
          ON command.interaction_turn_id = turn.interaction_turn_id
        INNER JOIN compiled_context_revision_refs ref
          ON ref.compiled_context_id = command.compiled_context_id
        INNER JOIN conversation_event_revisions revision
          ON revision.conversation_event_revision_id =
            ref.conversation_event_revision_id
        WHERE turn.client_turn_id = $1
        ORDER BY ref.ordinal
      `,
      ["after-interruption-turn"],
    );
    expect(nextTextContext.rows.map((row) => row.text)).toEqual([
      "Please stay with what I just said.",
      "This is the next Text Turn.",
    ]);
    expect(
      nextTextContext.rows.some((row) => row.text.includes("Visible prefix.")),
    ).toBe(false);

    const retryRequest = {
      originalTurnId,
      retryRequestId: "stable-retry-request-0001",
    };
    const retryHandler = createConversationRetryHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service: retryService,
    });
    const retryResponse = await retryHandler(
      new Request("http://localhost/api/internal/conversation/retries", {
        body: JSON.stringify(retryRequest),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const retryEvents = await readNdjson(retryResponse);
    expect(retryEvents.map((event) => event.type)).toEqual([
      "retry_committed",
      "assistant_delta",
      "assistant_committed",
    ]);
    expect(retryEvents[0]).toMatchObject({
      originalTurnId,
      retryRequestId: "stable-retry-request-0001",
    });
    expect(retryEvents[0]?.turnId).not.toBe(originalTurnId);
    expect(retryEvents[1]?.delta).toBe("A new, complete answer.");
    expect(successfulProviderCalls).toBe(2);
    expect(
      await conversationService.listInterruptedResponses(
        fixedInternalOwnerPrincipal.userId,
      ),
    ).toEqual([
      {
        logicalDate: "2026-07-27",
        retryStatus: "retried",
        sequence: 1,
        turnId: originalTurnId,
      },
    ]);

    const idempotentReplay = await retryHandler(
      new Request("http://localhost/api/internal/conversation/retries", {
        body: JSON.stringify(retryRequest),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const replayEvents = await readNdjson(idempotentReplay);
    expect(replayEvents.map((event) => event.type)).toEqual([
      "retry_committed",
      "assistant_delta",
      "assistant_committed",
    ]);
    expect(replayEvents[0]?.turnId).toBe(retryEvents[0]?.turnId);
    expect(successfulProviderCalls).toBe(2);

    const state = await database.pool.query<{
      assistant_events: string;
      dialogue_revision: string;
      event_revisions: string;
      retry_action_events: string;
      retry_command_id: string;
      retry_intent: string;
      retry_of_turn_id: string;
      retry_turn_id: string;
    }>(`
      SELECT
        retry_turn.interaction_turn_id::text AS retry_turn_id,
        retry_turn.retry_of_interaction_turn_id::text AS retry_of_turn_id,
        retry_command.generation_command_id::text AS retry_command_id,
        retry_command.intent_key AS retry_intent,
        session.dialogue_revision::text,
        (
          SELECT COUNT(*)::text
          FROM conversation_events
          WHERE actor = 'assistant'
        ) AS assistant_events,
        (
          SELECT COUNT(*)::text
          FROM conversation_events
          WHERE event_type = 'retry_action'
        ) AS retry_action_events,
        (
          SELECT COUNT(*)::text
          FROM conversation_event_revisions
        ) AS event_revisions
      FROM interaction_turns retry_turn
      INNER JOIN generation_commands retry_command
        ON retry_command.interaction_turn_id = retry_turn.interaction_turn_id
      INNER JOIN daily_sessions session
        ON session.daily_session_id = retry_turn.daily_session_id
      WHERE retry_turn.retry_of_interaction_turn_id IS NOT NULL
    `);
    expect(state.rows[0]).toMatchObject({
      assistant_events: "2",
      dialogue_revision: "4",
      event_revisions: "4",
      retry_action_events: "1",
      retry_intent: "conversation-retry/stable-retry-request-0001",
      retry_of_turn_id: originalTurnId,
      retry_turn_id: retryEvents[0]?.turnId,
    });
    expect(state.rows[0]?.retry_command_id).not.toBe(
      interruptedEvents[0]?.generationCommandId,
    );

    const originalState = await database.pool.query<{
      assistant_results: string;
      command_status: string;
      turn_status: string;
    }>(
      `
        SELECT
          original_turn.status AS turn_status,
          original_command.status AS command_status,
          (
            SELECT COUNT(*)::text
            FROM conversation_events assistant
            WHERE assistant.generation_command_id =
              original_command.generation_command_id
          ) AS assistant_results
        FROM interaction_turns original_turn
        INNER JOIN generation_commands original_command
          ON original_command.interaction_turn_id =
            original_turn.interaction_turn_id
        WHERE original_turn.interaction_turn_id = $1
      `,
      [originalTurnId],
    );
    expect(originalState.rows[0]).toEqual({
      assistant_results: "0",
      command_status: "interrupted",
      turn_status: "interrupted",
    });

    const retryContext = await database.pool.query<{ text: string }>(
      `
        SELECT revision.canonical_text AS text
        FROM generation_commands command
        INNER JOIN compiled_context_revision_refs ref
          ON ref.compiled_context_id = command.compiled_context_id
        INNER JOIN conversation_event_revisions revision
          ON revision.conversation_event_revision_id =
            ref.conversation_event_revision_id
        WHERE command.intent_key = $1
        ORDER BY ref.ordinal
      `,
      ["conversation-retry/stable-retry-request-0001"],
    );
    expect(retryContext.rows.map((row) => row.text)).toEqual([
      "Please stay with what I just said.",
    ]);
    expect(
      retryContext.rows.some((row) => row.text.includes("Visible prefix.")),
    ).toBe(false);
  });

  it("classifies deterministic faults before visibility and after Provider completion", async () => {
    await openPrivateWrites();
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const createHandler = (model: ConversationTextModel) =>
      createConversationResponseHandler({
        authenticate: async () => fixedInternalOwnerPrincipal,
        service: createConversationResponseService({
          clock: fixedResponseClock,
          contextCompiler: createContextCompiler({
            clock: fixedResponseClock,
            compilerVersion: "context-compiler:v1",
            contentHmacSecret: "test-context-integrity-secret",
            rawEventTokenBudget: 4_000,
            repository: responseRepository,
          }),
          conversationService: createUserTextConversationService({
            clock: fixedResponseClock,
            expectedBackupPolicyVersion: "neon-production-v1",
            expectedConfigurationFingerprint: "sha256:expected",
            generationPolicy: testGenerationPolicy,
            repository: new PostgresUserTextConversationRepository(database.pool),
          }),
          egressPort: createProviderEgressPort({
            champion: testChampion,
            clock: fixedResponseClock,
            model,
            repository: responseRepository,
          }),
          repository: responseRepository,
        }),
      });
    const submit = async (
      handler: ReturnType<typeof createConversationResponseHandler>,
      suffix: string,
    ) =>
      readNdjson(
        await handler(
          new Request("http://localhost/api/internal/conversation/responses", {
            body: JSON.stringify({
              clientEventId: `fault-event-${suffix}`,
              clientTurnId: `fault-turn-${suffix}`,
              locale: "en-US",
              text: `Synthetic fault ${suffix}.`,
              timezone: "America/Los_Angeles",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        ),
      );

    const beforeOutput = await submit(
      createHandler(
        createDeterministicConversationTextModel({
          chunks: ["must not be visible"],
          failAfterChunks: 0,
        }),
      ),
      "before-output",
    );
    expect(beforeOutput.map((event) => event.type)).toEqual([
      "user_committed",
      "response_failed",
    ]);

    const afterCompletion = await submit(
      createHandler(
        createDeterministicConversationTextModel({
          chunks: ["Visible completed prefix."],
          failAfterCompletion: true,
        }),
      ),
      "after-completion",
    );
    expect(afterCompletion.map((event) => event.type)).toEqual([
      "user_committed",
      "assistant_delta",
      "response_interrupted",
    ]);

    const states = await database.pool.query<{
      assistant_events: string;
      attempt_status: string;
      command_status: string;
      turn_status: string;
    }>(`
      SELECT
        turn.status AS turn_status,
        command.status AS command_status,
        attempt.status AS attempt_status,
        (
          SELECT COUNT(*)::text
          FROM conversation_events
          WHERE actor = 'assistant'
        ) AS assistant_events
      FROM interaction_turns turn
      INNER JOIN generation_commands command
        ON command.interaction_turn_id = turn.interaction_turn_id
      INNER JOIN model_run_attempts attempt
        ON attempt.generation_command_id = command.generation_command_id
      ORDER BY turn.turn_sequence_no
    `);
    expect(states.rows).toEqual([
      {
        assistant_events: "0",
        attempt_status: "failed",
        command_status: "failed",
        turn_status: "failed",
      },
      {
        assistant_events: "0",
        attempt_status: "interrupted",
        command_status: "interrupted",
        turn_status: "interrupted",
      },
    ]);
  });

  it("compiles the next turn only from committed User and Assistant revisions", async () => {
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
    const submit = async (
      clientEventId: string,
      clientTurnId: string,
      text: string,
    ) => {
      const response = await fetch(
        `${nextServer?.origin}/api/internal/conversation/responses`,
        {
          body: JSON.stringify({
            clientEventId,
            clientTurnId,
            locale: "en-US",
            text,
            timezone: "America/Los_Angeles",
          }),
          headers: {
            "content-type": "application/json",
            cookie: `${sessionCookieName}=${sessionToken}`,
          },
          method: "POST",
        },
      );
      expect((await readNdjson(response)).at(-1)?.type).toBe(
        "assistant_committed",
      );
    };
    await submit(
      "context-first-event",
      "context-first-turn",
      "The first committed expression.",
    );
    await submit(
      "context-second-event",
      "context-second-turn",
      "The second committed expression.",
    );

    const references = await database.pool.query<{
      actor: string;
      ordinal: number;
      text: string;
    }>(`
      SELECT ref.actor, ref.ordinal, revision.canonical_text AS text
      FROM generation_commands command
      INNER JOIN interaction_turns turn
        ON turn.interaction_turn_id = command.interaction_turn_id
      INNER JOIN compiled_context_revision_refs ref
        ON ref.compiled_context_id = command.compiled_context_id
      INNER JOIN conversation_event_revisions revision
        ON revision.conversation_event_revision_id =
          ref.conversation_event_revision_id
      WHERE turn.turn_sequence_no = 2
      ORDER BY ref.ordinal
    `);
    expect(references.rows).toEqual([
      {
        actor: "user",
        ordinal: 0,
        text: "The first committed expression.",
      },
      {
        actor: "assistant",
        ordinal: 1,
        text: "That sounds like a lot to carry.",
      },
      {
        actor: "user",
        ordinal: 2,
        text: "The second committed expression.",
      },
    ]);
  });

  it("does not let concurrent idempotent responses settle shared work", async () => {
    await openPrivateWrites();
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const compiler = createContextCompiler({
      clock: fixedResponseClock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    let releaseProvider: (() => void) | undefined;
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    let providerCalls = 0;
    const model = {
      async *stream() {
        providerCalls += 1;
        markProviderStarted?.();
        await providerRelease;
        yield { delta: "One authoritative response.", type: "delta" as const };
        yield {
          costMicros: 0,
          finishReason: "completed",
          inputTokens: 4,
          modelSnapshot: "gpt-5.4",
          outputTokens: 6,
          providerRequestId: "single-provider-request",
          type: "completed" as const,
        };
      },
    } satisfies ConversationTextModel;
    const service = createConversationResponseService({
      clock: fixedResponseClock,
      contextCompiler: compiler,
      conversationService: createUserTextConversationService({
        clock: fixedResponseClock,
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        repository: new PostgresUserTextConversationRepository(database.pool),
      }),
      egressPort: createProviderEgressPort({
        champion: testChampion,
        clock: fixedResponseClock,
        model,
        repository: responseRepository,
      }),
      repository: responseRepository,
    });
    const handler = createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    });
    const createRequest = () =>
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify({
          clientEventId: "concurrent-response-event",
          clientTurnId: "concurrent-response-turn",
          locale: "en-US",
          text: "Only one request may own this response.",
          timezone: "America/Los_Angeles",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

    const firstResponse = await handler(createRequest());
    const secondResponse = await handler(createRequest());
    const firstEventsPromise = readNdjson(firstResponse);
    const secondEventsPromise = readNdjson(secondResponse);
    await providerStarted;
    const canceledShared = service
      .respond(fixedInternalOwnerPrincipal.userId, {
        clientEventId: "concurrent-response-event",
        clientTurnId: "concurrent-response-turn",
        locale: "en-US",
        text: "Only one request may own this response.",
        timezone: "America/Los_Angeles",
      })
      [Symbol.asyncIterator]();
    expect((await canceledShared.next()).value?.type).toBe("user_committed");
    await canceledShared.return?.();
    const activeOwner = await database.pool.query<{
      attempt_status: string;
      command_status: string;
    }>(`
      SELECT
        command.status AS command_status,
        attempt.status AS attempt_status
      FROM generation_commands command
      INNER JOIN model_run_attempts attempt
        ON attempt.generation_command_id = command.generation_command_id
    `);
    expect(activeOwner.rows[0]).toEqual({
      attempt_status: "running",
      command_status: "running",
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const nonOwnerEvents = await Promise.race([
        firstEventsPromise,
        secondEventsPromise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("The non-owner response did not finish.")),
            1_000,
          );
        }),
      ]);
      expect(nonOwnerEvents.at(-1)?.type).toBe("response_failed");
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      releaseProvider?.();
    }
    const [firstEvents, secondEvents] = await Promise.all([
      firstEventsPromise,
      secondEventsPromise,
    ]);

    expect(providerCalls).toBe(1);
    expect(
      [firstEvents, secondEvents].filter(
        (events) => events.at(-1)?.type === "assistant_committed",
      ),
    ).toHaveLength(1);
    const state = await database.pool.query<{
      assistant_events: string;
      attempt_status: string;
      command_status: string;
      contexts: string;
      egresses: string;
    }>(`
      SELECT
        command.status AS command_status,
        attempt.status AS attempt_status,
        (SELECT COUNT(*)::text FROM compiled_contexts) AS contexts,
        (SELECT COUNT(*)::text FROM provider_egress_dispositions) AS egresses,
        (
          SELECT COUNT(*)::text
          FROM conversation_events
          WHERE actor = 'assistant'
        ) AS assistant_events
      FROM generation_commands command
      INNER JOIN model_run_attempts attempt
        ON attempt.generation_command_id = command.generation_command_id
    `);
    expect(state.rows[0]).toEqual({
      assistant_events: "1",
      attempt_status: "succeeded",
      command_status: "succeeded",
      contexts: "1",
      egresses: "1",
    });
  });

  it("settles prepared work when a response stream consumer cancels", async () => {
    await openPrivateWrites();
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const service = createConversationResponseService({
      clock: fixedResponseClock,
      contextCompiler: createContextCompiler({
        clock: fixedResponseClock,
        compilerVersion: "context-compiler:v1",
        contentHmacSecret: "test-context-integrity-secret",
        rawEventTokenBudget: 4_000,
        repository: responseRepository,
      }),
      conversationService: createUserTextConversationService({
        clock: fixedResponseClock,
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        repository: new PostgresUserTextConversationRepository(database.pool),
      }),
      egressPort: createProviderEgressPort({
        champion: testChampion,
        clock: fixedResponseClock,
        model: createDeterministicConversationTextModel({
          chunks: ["must not start"],
        }),
        repository: responseRepository,
      }),
      repository: responseRepository,
    });
    const stream = service.respond(fixedInternalOwnerPrincipal.userId, {
      clientEventId: "cancel-before-dispatch-event",
      clientTurnId: "cancel-before-dispatch-turn",
      locale: "en-US",
      text: "The consumer will cancel after my event commits.",
      timezone: "America/Los_Angeles",
    })[Symbol.asyncIterator]();

    expect((await stream.next()).value?.type).toBe("user_committed");
    await stream.return?.();

    const state = await database.pool.query<{
      attempt_error: string;
      attempt_status: string;
      command_status: string;
      egresses: string;
      turn_status: string;
    }>(`
      SELECT
        command.status AS command_status,
        attempt.status AS attempt_status,
        attempt.error_category AS attempt_error,
        turn.status AS turn_status,
        (SELECT COUNT(*)::text FROM provider_egress_dispositions) AS egresses
      FROM generation_commands command
      INNER JOIN model_run_attempts attempt
        ON attempt.generation_command_id = command.generation_command_id
      INNER JOIN interaction_turns turn
        ON turn.interaction_turn_id = command.interaction_turn_id
    `);
    expect(state.rows[0]).toEqual({
      attempt_error: "aborted",
      attempt_status: "failed",
      command_status: "failed",
      egresses: "0",
      turn_status: "failed",
    });
  });

  it("lazily adds generation identity when replaying a pre-0003 User Turn", async () => {
    await openPrivateWrites();
    const repository = new PostgresUserTextConversationRepository(database.pool);
    const service = createUserTextConversationService({
      clock: fixedResponseClock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository,
    });
    const input = {
      clientEventId: "legacy-event-key",
      clientTurnId: "legacy-turn-key",
      locale: "en-US",
      text: "This turn existed before response generation.",
      timezone: "America/Los_Angeles",
    };
    const original = await service.submit(
      fixedInternalOwnerPrincipal.userId,
      input,
    );
    await database.pool.query("DELETE FROM model_run_attempts");
    await database.pool.query("DELETE FROM generation_commands");
    await database.pool.query("DELETE FROM backup_policy_versions");

    await expect(
      service.submit(fixedInternalOwnerPrincipal.userId, input),
    ).rejects.toMatchObject({
      reason: "backup_evidence_missing",
    });
    const blockedBackfill = await database.pool.query<{
      attempts: string;
      commands: string;
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM generation_commands) AS commands,
        (SELECT COUNT(*)::text FROM model_run_attempts) AS attempts
    `);
    expect(blockedBackfill.rows[0]).toEqual({
      attempts: "0",
      commands: "0",
    });
    await openPrivateWrites();

    const replayed = await service.submit(
      fixedInternalOwnerPrincipal.userId,
      input,
    );

    expect(replayed.replayed).toBe(true);
    expect(replayed.turn.id).toBe(original.turn.id);
    expect(replayed.message.id).toBe(original.message.id);
    expect(replayed.generation.commandId).toBeTruthy();
    expect(replayed.generation.attemptId).toBeTruthy();
    const state = await database.pool.query<{
      attempts: string;
      commands: string;
      events: string;
      turns: string;
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM interaction_turns) AS turns,
        (SELECT COUNT(*)::text FROM conversation_events) AS events,
        (SELECT COUNT(*)::text FROM generation_commands) AS commands,
        (SELECT COUNT(*)::text FROM model_run_attempts) AS attempts
    `);
    expect(state.rows[0]).toEqual({
      attempts: "1",
      commands: "1",
      events: "1",
      turns: "1",
    });
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
      generationPolicy: testGenerationPolicy,
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
      generationPolicy: testGenerationPolicy,
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
        SAYHEAR_CONTEXT_HMAC_SECRET: "system-test-context-integrity-secret",
        SAYHEAR_DEPLOYMENT: "test",
        SAYHEAR_PROVIDER_ADAPTER: "deterministic",
        SAYHEAR_TEST_PROVIDER_CHUNKS: JSON.stringify([
          "That sounds like ",
          "a lot to carry.",
        ]),
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

async function readNdjson(
  response: Response,
): Promise<readonly Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
