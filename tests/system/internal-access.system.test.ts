import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createInternalAccessHandler } from "../../apps/web/src/internal-access-handler";
import {
  asGenerationCommandId,
  asUserId,
  CANONICAL_PERSONA_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  createContextCompiler,
  createContinuousExchangeService,
  createConversationAgentHarness,
  createConversationResponseService,
  createInternalInspectionService,
  createInternalOwnerAccessService,
  createUserTextConversationService,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  ENGLISH_LOCALE_PACK_VERSION,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  ProviderDispatchError,
  renderMinimumHighRiskResponse,
  validateMinimumHighRiskResponse,
  type ConversationResponseRepository,
  type ConversationTextModel,
} from "@sayhear/application";
import {
  createDeterministicConversationTextModel,
  createProviderEgressPort,
} from "@sayhear/ai/testing";
import {
  createPostgresAuthAdapter,
  PostgresContinuousExchangeRepository,
  PostgresConversationResponseRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresInternalInspectionRepository,
  PostgresUserTextConversationRepository,
  purgeMarkerMigrationsDirectory,
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
const testPurgeMarkerDatabaseUrl = process.env.TEST_PURGE_MARKER_DATABASE_URL;
if (!testDatabaseUrl || !testPurgeMarkerDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL and TEST_PURGE_MARKER_DATABASE_URL are required; the system seam never falls back to a mock database.",
  );
}
if (testDatabaseUrl === testPurgeMarkerDatabaseUrl) {
  throw new Error(
    "TEST_PURGE_MARKER_DATABASE_URL must be a separate database outside the business backup domain.",
  );
}
const testGenerationPolicy = Object.freeze({
  consentPolicyVersion: null,
  freshnessPolicy: "source_valid:v1" as const,
  chineseLocalePackVersion: "locale-pack-zh:v1",
  englishLocalePackVersion: "locale-pack-en:v1",
  harnessPolicyVersion: "conversation-harness:v1",
  conversationActionCatalogVersion: "conversation-action-catalog:empty:v1",
  model: "gpt-5.4",
  modelConfigVersion: "conversation-text-champion:v1",
  modelSnapshot: "gpt-5.4",
  outputFormatVersion: "conversation-output:v1",
  canonicalPersonaVersion: "canonical-persona:v1",
  personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
  personaContractInvariantVersion: "persona-contract-invariant:v1",
  productPolicyVersion: "product-policy:v1",
  taskInstructionVersion: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
});
const testChampion = Object.freeze({
  configVersion: "conversation-text-champion:v1",
  consentPolicyVersion: null,
  contextLimit: 1_000_000,
  dataRegion: "test",
  model: "gpt-5.4",
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  retentionMode: "store-disabled",
  snapshot: "gpt-5.4",
  streaming: true as const,
  supportedLocales: Object.freeze(["en", "zh"]),
  trainingPolicy: "test",
});
const fixedResponseClock = () => new Date("2026-07-27T16:00:00.000Z");

function createTestContextCompiler(
  repository: PostgresConversationResponseRepository,
  rawEventTokenBudget = 4_000,
) {
  return createContextCompiler({
    clock: fixedResponseClock,
    compilerVersion: "context-compiler:v1",
    contentHmacSecret: "test-context-integrity-secret",
    rawEventTokenBudget,
    repository,
  });
}

function authSessionTokenHash(sessionToken: string): Buffer {
  return createHash("sha256").update(sessionToken, "utf8").digest();
}

/**
 * Builds the Conversation Agent Harness for system-seam tests. The Service now
 * compiles Context and delegates Decision execution to the Harness
 * (issue #24), so tests construct the Harness the same way the production
 * server composition does: a Provider Egress Port wrapped in the bounded
 * Harness, the empty Catalog, and the initial Harness Policy.
 */
function createTestHarness(options: {
  clock: () => Date;
  delay?: (delayMs: number) => Promise<void>;
  egressPort: ReturnType<typeof createProviderEgressPort>;
  jitter?: () => number;
  repository: ConversationResponseRepository;
}) {
  return createConversationAgentHarness({
    clock: options.clock,
    ...(options.delay ? { delay: options.delay } : {}),
    egressPort: options.egressPort,
    ...(options.jitter ? { jitter: options.jitter } : {}),
    repository: options.repository,
  });
}

describe("Authenticated Internal Text Conversation System Seam", () => {
  const sessionCookieName = "sayhear.session-token";
  const sessionToken = "request-path-session-token";
  let database: IsolatedPostgresSchema;
  let markerDatabase: IsolatedPostgresSchema;
  let nextServer: RunningNextServer | undefined;

  // A real disposable PostgreSQL service can need longer than a local socket
  // to create an isolated schema, apply every migration, and boot Next.
  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    markerDatabase = await createIsolatedPostgresSchema(
      testPurgeMarkerDatabaseUrl,
    );
    await runMigrations(markerDatabase.pool, {
      migrationsDirectory: purgeMarkerMigrationsDirectory,
    });
    const repository = new PostgresInternalOwnerAccessRepository(database.pool);
    await repository.provisionInternalOwner({
      issuer: "https://github.com",
      subject: "test-owner",
      userId: fixedInternalOwnerPrincipal.userId,
    });
    nextServer = await startNextTestServer(
      database.connectionString,
      markerDatabase.connectionString,
    );
  }, 60_000);

  beforeEach(async () => {
    await database.pool.query(`
      TRUNCATE TABLE
        retrieval_run_candidates,
        retrieval_runs,
        claim_retrieval_projections,
        relationship_resolver_hints,
        memory_claim_version_qualifier_evidence,
        memory_claim_version_qualifiers,
        memory_impression_vetoes,
        memory_correction_followups,
        memory_claim_corrections,
        memory_consolidation_diffs,
        memory_consolidation_runs,
        fast_path_session_items,
        entity_resolve_gate_outcomes,
        entity_clarification_proposals,
        fast_path_extraction_runs,
        entity_mention_candidates,
        memory_forget_reversals,
        memory_forget_evidence_exclusions,
        memory_forget_requests,
        memory_candidate_evidence_links,
        memory_candidates,
        claim_evidence_links,
        memory_claim_versions,
        memory_claims,
        entity_mentions,
        entity_labels,
        user_self_entities,
        entity_versions,
        entities,
        owner_purge_receipts,
        owner_purge_orders,
        conversation_action_payloads,
        conversation_action_receipts,
        conversation_action_executions,
        conversation_action_handles,
        current_rolling_summaries,
        rolling_summary_versions,
        rolling_summary_command_source_refs,
        rolling_summary_commands,
        journal_statement_evidence_links,
        journal_diagnostic_findings,
        journal_statements,
        journal_validation_results,
        journal_versions,
        journals,
        journal_model_run_attempts,
        journal_generation_commands,
        journal_workflow_outcomes,
        dialogue_state_command_source_refs,
        dialogue_state_versions,
        current_curiosity_stop_signals,
        safety_posture_alerts,
        current_safety_postures,
        safety_postures,
        curiosity_stop_signals,
        current_dialogue_states,
        dialogue_state_commands,
        evidence_lineage,
        evidence_model_run_attempts,
        evidence_items,
        evidence_source_snapshots,
        daily_session_date_outcomes,
        outbox_events,
        workflow_commands,
        sensitive_access_audits,
        internal_diagnostic_access_grants,
        provider_egress_consents,
        provider_egress_dispositions,
        compiled_context_revision_refs,
        compiled_contexts,
        model_run_attempts,
        generation_commands,
        continuous_exchange_inactivity_evaluations,
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
    await database.pool.query(
      "UPDATE provider_egress_policy_versions SET status = 'active'",
    );
    await database.pool.query(
      `
        DELETE FROM provider_egress_policy_versions
        WHERE policy_version <> 'openai-conversation-text:v1'
      `,
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
    await markerDatabase.dispose();
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
      validUntil: new Date("2027-08-27T16:00:00.000Z"),
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
      validUntil: new Date("2027-08-27T16:00:00.000Z"),
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
      validUntil: new Date("2027-08-27T16:00:00.000Z"),
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
    // Journal, Replay, Voice and other future verticals still do not exist as
    // tables. The 1A.2 foundations DO exist now, and the 1A.3a substrates
    // exist (#110 Entity identity, #112 Memory Claim admission), so the scope
    // guard subtracts those known substrate tables before matching future
    // vertical prefixes.
    const memoryClaimSubstrate = new Set([
      "memory_claims",
      "memory_claim_versions",
      "memory_claim_version_qualifiers",
      "memory_claim_version_qualifier_evidence",
      "claim_evidence_links",
      "memory_candidates",
      "memory_candidate_evidence_links",
      "memory_forget_requests",
      "memory_forget_evidence_exclusions",
      "memory_forget_reversals",
      "memory_claim_corrections",
      "memory_impression_vetoes",
      "memory_correction_followups",
      "memory_consolidation_runs",
      "memory_consolidation_diffs",
      "memory_consolidation_policies",
    ]);
    const outOfScopeRelations = (
      await database.pool.query<{ table_name: string }>(
        `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name ILIKE ANY(ARRAY[
              'episode%',
              'reflection%',
              'memory%',
              'profile%',
              'open_loop%',
              'replay%',
              'voice%',
              'audio%',
              'transcript%',
              'delivery%',
              'summary%'
            ])
          ORDER BY table_name
        `,
      )
    ).rows.filter((row) => !memoryClaimSubstrate.has(row.table_name));
    expect(outOfScopeRelations).toEqual([]);
    // The Entity tables exist as the 1A.3a substrate, but mention resolution
    // is driven by the memory fast path (#113), not the conversation turn
    // seam: an ordinary conversation must not write any Entity-domain rows.
    const entityDomainTotals = await database.pool.query<{ total: string }>(
      `SELECT (
         (SELECT count(*) FROM entities)
         + (SELECT count(*) FROM entity_versions)
         + (SELECT count(*) FROM entity_labels)
         + (SELECT count(*) FROM entity_mentions)
         + (SELECT count(*) FROM entity_mention_candidates)
         + (SELECT count(*) FROM user_self_entities)
       ) AS total`,
    );
    expect(entityDomainTotals.rows[0]).toEqual({ total: "0" });
    // An in-flight active conversation must not produce any eligibility rows —
    // eligibility fires only after a deterministic Continuous Exchange End.
    const eligibilityFoundationTotals = await database.pool.query<{
      commands: string;
      date_outcomes: string;
      outbox: string;
      evidence_snapshots: string;
      journals: string;
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM workflow_commands) AS commands,
        (SELECT COUNT(*)::text FROM outbox_events) AS outbox,
        (SELECT COUNT(*)::text FROM daily_session_date_outcomes) AS date_outcomes,
        (SELECT COUNT(*)::text FROM evidence_source_snapshots) AS evidence_snapshots,
        (SELECT COUNT(*)::text FROM journals) AS journals
    `);
    expect(eligibilityFoundationTotals.rows[0]).toEqual({
      // The fast path (issue #113) creates exactly one idempotent extraction
      // command + outbox row for the single committed User Event; no
      // eligibility / journal machinery fires in this scenario.
      commands: "1",
      date_outcomes: "0",
      evidence_snapshots: "0",
      journals: "0",
      outbox: "1",
    });
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
      validUntil: new Date("2027-08-27T16:00:00.000Z"),
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
      output_format_version: string;
      persona_version: string;
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
        command.output_format_version,
        command.persona_version,
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
      output_format_version: testGenerationPolicy.outputFormatVersion,
      persona_version: null,
      prompt_version: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
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
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
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
      harness: createTestHarness({
        clock: fixedResponseClock,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: fixedResponseClock,
          contextCompiler: createTestContextCompiler(responseRepository),
          model: createDeterministicConversationTextModel({
            chunks: ["must not run"],
          }),
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
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

  it("activates the versioned Minimum High-Risk Response through the real Web/BFF path", async () => {
    if (!nextServer) {
      throw new Error("The Next test server is not running.");
    }
    await openPrivateWrites();
    const response = await fetch(
      `${nextServer.origin}/api/internal/conversation/responses`,
      {
        body: JSON.stringify({
          clientEventId: "high-risk-bff-event",
          clientTurnId: "high-risk-bff-turn",
          locale: "en-US",
          text: "I want to kill myself tonight.",
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
    const events = await readNdjson(response);
    expect(events.map((event) => event.type)).toEqual([
      "user_committed",
      "assistant_delta",
      "assistant_committed",
    ]);
    const safetyResponse = events
      .filter((event) => event.type === "assistant_delta")
      .map((event) => String(event.delta ?? ""))
      .join("");
    expect(safetyResponse).toBe(
      renderMinimumHighRiskResponse({ kind: "self_harm", locale: "en-US" }),
    );
    expect(
      validateMinimumHighRiskResponse(safetyResponse).violations,
    ).toEqual([]);
    expect(safetyResponse).not.toContain("That sounds like");

    const authoritative = await database.pool.query<{
      assistant_events: string;
      attempt_status: string;
      command_status: string;
      safety_policy_version: string;
      turn_status: string;
    }>(`
      SELECT
        command.status AS command_status,
        command.safety_policy_version,
        attempt.status AS attempt_status,
        turn.status AS turn_status,
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
    `);
    expect(authoritative.rows[0]).toEqual({
      assistant_events: "1",
      attempt_status: "succeeded",
      command_status: "succeeded",
      safety_policy_version: "minimum-high-risk-response:v1",
      turn_status: "settled",
    });
  });

  it("exposes content-free Provider egress metadata through ordinary inspection", async () => {
    if (!nextServer) {
      throw new Error("The Next test server is not running.");
    }
    await openPrivateWrites();
    const privateMarker = "PRIVATE_CANARY_ISSUE_8";
    const conversation = await fetch(
      `${nextServer.origin}/api/internal/conversation/responses`,
      {
        body: JSON.stringify({
          clientEventId: "inspection-event",
          clientTurnId: "inspection-turn",
          locale: "en-US",
          text: privateMarker,
          timezone: "America/Los_Angeles",
        }),
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
        method: "POST",
      },
    );
    const conversationEvents = await readNdjson(conversation);
    const generationCommandId = conversationEvents[0]?.generationCommandId;
    const modelRunAttemptId = conversationEvents[0]?.modelRunAttemptId;

    const inspection = await fetch(
      `${nextServer.origin}/api/internal/inspection/generation?generation_command_id=${generationCommandId}`,
      {
        headers: {
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
      },
    );

    expect(inspection.status).toBe(200);
    const metadata = await inspection.json();
    expect(metadata).toMatchObject({
      attemptStatus: "succeeded",
      commandStatus: "succeeded",
      compiledContext: {
        compilerVersion: "context-compiler:v1",
        // The compile never waits on the fast path: the committed User Event's
        // extraction command is still pending (issue #113).
        degradedReason: "fast_path_pending",
        dialogueRevision: 1,
        id: expect.any(String),
        integrity: {
          algorithm: "hmac-sha256",
          keyVersion: "context-integrity:v1",
        },
        locale: "en-US",
        policyVersions: {
          localePolicyVersion: ENGLISH_LOCALE_PACK_VERSION,
          outputFormatVersion: "conversation-output:v1",
          canonicalPersonaVersion: CANONICAL_PERSONA_VERSION,
          personaBehaviorAnchorsVersion: PERSONA_BEHAVIOR_ANCHORS_VERSION,
          personaContractInvariantVersion: "persona-contract-invariant:v1",
          productPolicyVersion: testGenerationPolicy.productPolicyVersion,
          relationshipPolicyVersion:
            testGenerationPolicy.relationshipPolicyVersion,
          safetyPolicyVersion: testGenerationPolicy.safetyPolicyVersion,
          taskInstructionVersion: testGenerationPolicy.taskInstructionVersion,
        },
        referencedEvents: [
          {
            actor: "user",
            estimatedTokens: expect.any(Number),
            revisionId: conversationEvents[0]?.userEventRevisionId,
            section: "current_user_input",
            selectionOrder: null,
            sequence: 1,
          },
        ],
        sectionBudgets: {
          committedRawEvents: 4_000,
        },
        dialogueState: null,
        safetyPosture: {
          posture: null,
          state: "default",
        },
        sections: expect.arrayContaining([
          expect.objectContaining({
            key: "product_policy",
            reference: "product-policy:v1",
            truncatable: false,
          }),
          expect.objectContaining({
            key: "persona_contract_invariant",
            reference: "persona-contract-invariant:v1",
            truncatable: false,
          }),
          expect.objectContaining({
            key: "canonical_persona",
            reference: CANONICAL_PERSONA_VERSION,
            truncatable: false,
          }),
          expect.objectContaining({
            key: "persona_behavior_anchors",
            reference: PERSONA_BEHAVIOR_ANCHORS_VERSION,
            truncatable: false,
          }),
          expect.objectContaining({
            key: "task_instruction",
            reference: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
            truncatable: false,
          }),
          expect.objectContaining({
            key: "output_format",
            reference: "conversation-output:v1",
            truncatable: false,
          }),
          expect.objectContaining({
            key: "daily_session",
            reference: expect.stringContaining(
              ":closure:continuous-exchange-inactivity:v1:",
            ),
            truncatable: false,
          }),
          expect.objectContaining({
            budgetTokens: 4_000,
            key: "committed_raw_events",
            truncatable: true,
          }),
          expect.objectContaining({
            key: "current_user_input",
            reference: conversationEvents[0]?.userEventRevisionId,
            truncatable: false,
          }),
        ]),
        sourceRevision: 1,
        totalTokens: expect.any(Number),
      },
      costMicros: 0,
      conversationActionCatalogVersion: "conversation-action-catalog:memory-trust-actions:v1",
      disposition: "completed",
      freshnessPolicy: "source_valid:v1",
      generationCommandId,
      harnessPolicyVersion: "conversation-harness:v3",
      inputTokens: expect.any(Number),
      model: "gpt-5.4",
      modelRunAttemptId,
      outputTokens: expect.any(Number),
      provider: "openai",
      providerPolicyVersion: "openai-conversation-text:v1",
      providerRequestId: "deterministic-request",
      role: "conversation.text",
    });
    expect(metadata.sourceRevisionId).toBe(
      conversationEvents[0]?.userEventRevisionId,
    );
    expect(metadata.dispatchLatencyMs).toBeGreaterThanOrEqual(0);
    expect(metadata.providerLatencyMs).toBeGreaterThanOrEqual(0);
    await expect(
      database.pool.query(
        `
          UPDATE provider_egress_dispositions
          SET provider_policy_version = 'conversation-text-champion:v1'
          WHERE model_run_attempt_id = $1
        `,
        [modelRunAttemptId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect(JSON.stringify(metadata)).not.toMatch(
      /PRIVATE_CANARY_ISSUE_8|content_hmac|contentHmac|test-context-integrity-secret/,
    );
    const operationalRecords = await database.pool.query<{ record: string }>(
      `
        SELECT row_to_json(command)::text AS record
        FROM generation_commands command
        UNION ALL
        SELECT row_to_json(attempt)::text
        FROM model_run_attempts attempt
        UNION ALL
        SELECT row_to_json(egress)::text
        FROM provider_egress_dispositions egress
        UNION ALL
        SELECT row_to_json(audit)::text
        FROM sensitive_access_audits audit
      `,
    );
    expect(JSON.stringify(operationalRecords.rows)).not.toMatch(
      /PRIVATE_CANARY_ISSUE_8|PROVIDER_CREDENTIAL_CANARY/,
    );
    const controlledContentRecords = await database.pool.query<{
      record: string;
    }>(
      `
        SELECT revision.canonical_text AS record
        FROM conversation_event_revisions revision
        UNION ALL
        SELECT context.section_budgets::text
        FROM compiled_contexts context
      `,
    );
    expect(JSON.stringify(controlledContentRecords.rows)).not.toContain(
      "PROVIDER_CREDENTIAL_CANARY",
    );
    expect(nextServer.output()).not.toMatch(
      /PRIVATE_CANARY_ISSUE_8|PROVIDER_CREDENTIAL_CANARY/,
    );
  });

  it("requires elevated capability and recent step-up for conversation content inspection", async () => {
    if (!nextServer) {
      throw new Error("The Next test server is not running.");
    }
    await openPrivateWrites();
    const privateMarker = "SENSITIVE_INSPECTION_CANARY";
    const conversation = await fetch(
      `${nextServer.origin}/api/internal/conversation/responses`,
      {
        body: JSON.stringify({
          clientEventId: "sensitive-inspection-event",
          clientTurnId: "sensitive-inspection-turn",
          locale: "en-US",
          text: privateMarker,
          timezone: "America/Los_Angeles",
        }),
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
        method: "POST",
      },
    );
    const conversationEvents = await readNdjson(conversation);
    const generationCommandId = conversationEvents[0]?.generationCommandId;
    const inspectionUrl =
      `${nextServer.origin}/api/internal/inspection/conversation-content` +
      `?generation_command_id=${generationCommandId}`;
    const authenticatedRequest = {
      headers: {
        cookie: `${sessionCookieName}=${sessionToken}`,
      },
    };

    const withoutCapability = await fetch(
      inspectionUrl,
      authenticatedRequest,
    );
    expect(withoutCapability.status).toBe(403);
    expect(await withoutCapability.json()).toEqual({
      error: "elevated_capability_required",
    });

    await database.pool.query(
      `
        INSERT INTO internal_diagnostic_access_grants (
          session_token_hash,
          capability,
          status,
          step_up_authenticated_at,
          updated_at
        )
        VALUES (
          $1,
          'conversation_content:read',
          'active',
          '2026-07-27T15:49:59.000Z',
          $2
        )
      `,
      [authSessionTokenHash(sessionToken), fixedResponseClock()],
    );
    const otherSessionToken = "other-sensitive-inspection-session";
    await createPostgresAuthAdapter(database.pool).createSession({
      expires: new Date("2099-01-01T00:00:00.000Z"),
      sessionToken: otherSessionToken,
      userId: fixedInternalOwnerPrincipal.userId,
    });
    const otherSession = await fetch(inspectionUrl, {
      headers: {
        cookie: `${sessionCookieName}=${otherSessionToken}`,
      },
    });
    expect(otherSession.status).toBe(403);
    expect(await otherSession.json()).toEqual({
      error: "elevated_capability_required",
    });

    const staleStepUp = await fetch(inspectionUrl, authenticatedRequest);
    expect(staleStepUp.status).toBe(403);
    expect(await staleStepUp.json()).toEqual({
      error: "recent_step_up_required",
    });

    await database.pool.query(
      `
        UPDATE internal_diagnostic_access_grants
        SET step_up_authenticated_at = '2026-07-27T15:55:00.000Z',
            updated_at = $1
        WHERE session_token_hash = $2
          AND capability = 'conversation_content:read'
      `,
      [fixedResponseClock(), authSessionTokenHash(sessionToken)],
    );
    const allowed = await fetch(inspectionUrl, authenticatedRequest);
    expect(allowed.status).toBe(200);
    const content = await allowed.json();
    expect(content.generationCommandId).toBe(generationCommandId);
    expect(content.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "user",
          text: privateMarker,
        }),
      ]),
    );
    const unknownGenerationCommandId =
      "019f9f1c-1d91-7000-8000-000000000008";
    const unknownTarget = await fetch(
      `${nextServer.origin}/api/internal/inspection/conversation-content` +
        `?generation_command_id=${unknownGenerationCommandId}`,
      authenticatedRequest,
    );
    expect(unknownTarget.status).toBe(404);
    expect(await unknownTarget.json()).toEqual({ error: "not_found" });

    const audits = await database.pool.query<{
      capability: string;
      disposition: string;
      reason: string;
      target_id: string;
    }>(
      `
        SELECT capability, target_id::text, disposition, reason
        FROM sensitive_access_audits
        ORDER BY accessed_at, sensitive_access_audit_id
      `,
    );
    expect(audits.rows).toHaveLength(5);
    expect(audits.rows).toEqual(
      expect.arrayContaining([
        {
          capability: "conversation_content:read",
          disposition: "denied",
          reason: "elevated_capability_required",
          target_id: generationCommandId,
        },
        {
          capability: "conversation_content:read",
          disposition: "denied",
          reason: "recent_step_up_required",
          target_id: generationCommandId,
        },
        {
          capability: "conversation_content:read",
          disposition: "allowed",
          reason: "authorized",
          target_id: generationCommandId,
        },
        {
          capability: "conversation_content:read",
          disposition: "denied",
          reason: "target_not_found",
          target_id: unknownGenerationCommandId,
        },
      ]),
    );
    expect(JSON.stringify(audits.rows)).not.toContain(privateMarker);
  });

  it.each([
    {
      fence: "the Internal Owner is deleting",
      sql: `
        UPDATE app_users
        SET status = 'deleting', updated_at = $2
        WHERE user_id = $1
      `,
    },
    {
      fence: "the source Event is invalid",
      sql: `
        UPDATE conversation_events
        SET lifecycle_status = 'deleted', deleted_at = $2
        WHERE user_id = $1
          AND actor = 'user'
      `,
    },
    {
      fence: "the owner data epoch advances",
      sql: `
        UPDATE app_users
        SET data_epoch = data_epoch + 1, updated_at = $2
        WHERE user_id = $1
      `,
    },
  ])("blocks private payload before dispatch when $fence", async ({ sql }) => {
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
      validUntil: new Date("2027-08-27T16:00:00.000Z"),
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
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: fixedResponseClock,
      contextCompiler: {
        async compile(input) {
          const context = await compiler.compile(input);
          await database.pool.query(sql, [
            fixedInternalOwnerPrincipal.userId,
            fixedResponseClock(),
          ]);
          return context;
        },
        renderPermittedPayload: compiler.renderPermittedPayload,
      },
      conversationService: createUserTextConversationService({
        clock: fixedResponseClock,
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        repository: new PostgresUserTextConversationRepository(database.pool),
      }),
      harness: createTestHarness({
        clock: fixedResponseClock,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: fixedResponseClock,
          contextCompiler: compiler,
          model,
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
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

  it("blocks Provider dispatch when the frozen Provider policy is disabled", async () => {
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
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: fixedResponseClock,
      contextCompiler: {
        async compile(input) {
          const context = await compiler.compile(input);
          await database.pool.query(
            `
              UPDATE provider_egress_policy_versions
              SET status = 'disabled'
              WHERE policy_version = 'openai-conversation-text:v1'
            `,
          );
          return context;
        },
        renderPermittedPayload: compiler.renderPermittedPayload,
      },
      conversationService: createUserTextConversationService({
        clock: fixedResponseClock,
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        repository: new PostgresUserTextConversationRepository(database.pool),
      }),
      harness: createTestHarness({
        clock: fixedResponseClock,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: fixedResponseClock,
          contextCompiler: compiler,
          model,
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });
    const response = await createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    })(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify({
          clientEventId: "provider-policy-event",
          clientTurnId: "provider-policy-turn",
          locale: "en-US",
          text: "This payload is fenced by the Provider policy.",
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
    const disposition = await database.pool.query<{
      status: string;
    }>("SELECT status FROM provider_egress_dispositions");
    expect(disposition.rows).toEqual([{ status: "blocked" }]);
    if (!nextServer) {
      throw new Error("The Next test server is not running.");
    }
    const metadataResponse = await fetch(
      `${nextServer.origin}/api/internal/inspection/generation` +
        `?generation_command_id=${events[0]?.generationCommandId}`,
      {
        headers: {
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
      },
    );
    expect(metadataResponse.status).toBe(200);
    expect(await metadataResponse.json()).toMatchObject({
      costMicros: null,
      disposition: "blocked",
      inputTokens: null,
      outputTokens: null,
      provider: "openai",
      providerPolicyVersion: "openai-conversation-text:v1",
      providerRequestId: null,
      role: "conversation.text",
      sourceRevisionId: events[0]?.userEventRevisionId,
    });
  });

  it("rejects an authoritative commit when applicable Provider consent is revoked", async () => {
    await openPrivateWrites();
    const providerPolicyVersion = "openai-conversation-text-consent:v1";
    const consentPolicyVersion = "internal-provider-consent:v1";
    await database.pool.query(
      `
        INSERT INTO provider_egress_policy_versions (
          policy_version,
          provider,
          role,
          model_config_version,
          consent_policy_version,
          status
        )
        VALUES ($1, 'openai', 'conversation.text', $2, $3, 'active')
      `,
      [
        providerPolicyVersion,
        testChampion.configVersion,
        consentPolicyVersion,
      ],
    );
    await database.pool.query(
      `
        INSERT INTO provider_egress_consents (
          user_id,
          provider,
          role,
          consent_policy_version,
          status,
          granted_at
        )
        VALUES ($1, 'openai', 'conversation.text', $2, 'active', $3)
      `,
      [
        fixedInternalOwnerPrincipal.userId,
        consentPolicyVersion,
        fixedResponseClock(),
      ],
    );

    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const model = {
      async *stream() {
        yield { delta: "Visible but not authoritative.", type: "delta" as const };
        await database.pool.query(
          `
            UPDATE provider_egress_consents
            SET status = 'revoked', revoked_at = $1
            WHERE user_id = $2
              AND provider = 'openai'
              AND role = 'conversation.text'
              AND consent_policy_version = $3
          `,
          [
            fixedResponseClock(),
            fixedInternalOwnerPrincipal.userId,
            consentPolicyVersion,
          ],
        );
        yield {
          costMicros: 0,
          finishReason: "completed",
          inputTokens: 8,
          modelSnapshot: "gpt-5.4",
          outputTokens: 8,
          providerRequestId: "provider-request-consent-revoked",
          type: "completed" as const,
        };
      },
    } satisfies ConversationTextModel;
    const service = createConversationResponseService({
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
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
        generationPolicy: {
          ...testGenerationPolicy,
          consentPolicyVersion,
          providerPolicyVersion,
        },
        repository: new PostgresUserTextConversationRepository(database.pool),
      }),
      harness: createTestHarness({
        clock: fixedResponseClock,
        egressPort: createProviderEgressPort({
          champion: {
            ...testChampion,
            consentPolicyVersion,
            providerPolicyVersion,
          },
          clock: fixedResponseClock,
          contextCompiler: createTestContextCompiler(responseRepository),
          model,
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });
    const response = await createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    })(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify({
          clientEventId: "consent-fence-event",
          clientTurnId: "consent-fence-turn",
          locale: "en-US",
          text: "This response loses consent before commit.",
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
    expect(events[2]?.category).toBe("policy_blocked");
    const assistantEvents = await database.pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM conversation_events
        WHERE actor = 'assistant'
      `,
    );
    expect(assistantEvents.rows[0]?.count).toBe("0");
  });

  it.each([
    {
      fence: "the Internal Owner starts deleting",
      sql: `
        UPDATE app_users
        SET status = 'deleting', updated_at = $2
        WHERE user_id = $1
      `,
    },
    {
      fence: "the source Event becomes invalid",
      sql: `
        UPDATE conversation_events
        SET lifecycle_status = 'deleted', deleted_at = $2
        WHERE user_id = $1
          AND actor = 'user'
      `,
    },
    {
      fence: "the owner data epoch advances",
      sql: `
        UPDATE app_users
        SET data_epoch = data_epoch + 1, updated_at = $2
        WHERE user_id = $1
      `,
    },
  ])("keeps visible output transient when $fence before commit", async ({ sql }) => {
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
      validUntil: new Date("2027-08-27T16:00:00.000Z"),
      verifiedAt: new Date("2026-07-27T15:00:00.000Z"),
    });
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const model = {
      async *stream() {
        yield { delta: "Visible but not authoritative.", type: "delta" as const };
        await database.pool.query(sql, [
          fixedInternalOwnerPrincipal.userId,
          fixedResponseClock(),
        ]);
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
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: fixedResponseClock,
      contextCompiler,
      conversationService: createUserTextConversationService({
        clock: fixedResponseClock,
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        repository: new PostgresUserTextConversationRepository(database.pool),
      }),
      harness: createTestHarness({
        clock: fixedResponseClock,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: fixedResponseClock,
          contextCompiler,
          model,
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
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
        catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
        clock: fixedResponseClock,
        contextCompiler: createContextCompiler({
          clock: fixedResponseClock,
          compilerVersion: "context-compiler:v1",
          contentHmacSecret: "test-context-integrity-secret",
          rawEventTokenBudget: 4_000,
          repository: responseRepository,
        }),
        conversationService,
        harness: createTestHarness({
          clock: fixedResponseClock,
          egressPort: createProviderEgressPort({
            champion: testChampion,
            clock: fixedResponseClock,
            contextCompiler: createTestContextCompiler(responseRepository),
            model,
            repository: responseRepository,
          }),
          repository: responseRepository,
        }),
        harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
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
      dialogue_revision: "5",
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
          catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
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
          harness: createTestHarness({
            clock: fixedResponseClock,
            egressPort: createProviderEgressPort({
              champion: testChampion,
              clock: fixedResponseClock,
              contextCompiler: createTestContextCompiler(responseRepository),
              model,
              repository: responseRepository,
            }),
            repository: responseRepository,
          }),
          harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
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
    const afterCompletionWithoutDelta = await submit(
      createHandler(
        createDeterministicConversationTextModel({
          chunks: [],
          failAfterCompletion: true,
        }),
      ),
      "after-completion-without-delta",
    );
    expect(afterCompletionWithoutDelta.map((event) => event.type)).toEqual([
      "user_committed",
      "response_interrupted",
    ]);

    const states = await database.pool.query<{
      assistant_events: string;
      attempt_count: string;
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
          FROM model_run_attempts command_attempt
          WHERE command_attempt.generation_command_id =
            command.generation_command_id
        ) AS attempt_count,
        (
          SELECT COUNT(*)::text
          FROM conversation_events
          WHERE actor = 'assistant'
        ) AS assistant_events
      FROM interaction_turns turn
      INNER JOIN generation_commands command
        ON command.interaction_turn_id = turn.interaction_turn_id
      INNER JOIN LATERAL (
        SELECT latest_attempt.*
        FROM model_run_attempts latest_attempt
        WHERE latest_attempt.generation_command_id =
          command.generation_command_id
        ORDER BY latest_attempt.attempt_no DESC
        LIMIT 1
      ) attempt ON TRUE
      ORDER BY turn.turn_sequence_no
    `);
    expect(states.rows).toEqual([
      {
        assistant_events: "0",
        attempt_count: "3",
        attempt_status: "failed",
        command_status: "failed",
        turn_status: "failed",
      },
      {
        assistant_events: "0",
        attempt_count: "1",
        attempt_status: "result_unknown",
        command_status: "interrupted",
        turn_status: "interrupted",
      },
      {
        assistant_events: "0",
        attempt_count: "1",
        attempt_status: "result_unknown",
        command_status: "interrupted",
        turn_status: "interrupted",
      },
    ]);
  });

  it("uses the same bounded jittered recovery command for a retryable request-path failure", async () => {
    await openPrivateWrites();
    let currentTime = new Date("2026-07-27T16:00:00.000Z");
    let dispatchCount = 0;
    const model: ConversationTextModel = {
      async *stream() {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          throw new ProviderDispatchError("rate_limited");
        }
        yield { delta: "Recovered on the request path.", type: "delta" };
        yield {
          costMicros: 0,
          finishReason: "completed",
          inputTokens: 1,
          modelSnapshot: testChampion.snapshot,
          outputTokens: 1,
          providerRequestId: "request-path-retry-2",
          type: "completed",
        };
      },
    };
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const conversationService = createUserTextConversationService({
      clock: () => currentTime,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const contextCompiler = createContextCompiler({
      clock: () => currentTime,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    const service = createConversationResponseService({
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: () => currentTime,
      contextCompiler,
      conversationService,
      harness: createTestHarness({
        clock: () => currentTime,
        delay: async (delayMs) => {
          currentTime = new Date(currentTime.getTime() + delayMs);
        },
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: () => currentTime,
          contextCompiler,
          model,
          repository: responseRepository,
        }),
        jitter: () => 0.5,
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });

    const events: Record<string, unknown>[] = [];
    for await (const event of service.respond(
      fixedInternalOwnerPrincipal.userId,
      {
        clientEventId: "request-path-recovery-event",
        clientTurnId: "request-path-recovery-turn",
        locale: "en-US",
        text: "Retry the same frozen request.",
        timezone: "America/Los_Angeles",
      },
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "user_committed",
      "assistant_delta",
      "assistant_committed",
    ]);

    const attempts = await database.pool.query<{
      attempt_no: number;
      error_category: string | null;
      recovery_policy_version: string;
      retry_not_before: Date | null;
      retry_of_model_run_attempt_id: string | null;
      status: string;
    }>(
      `
        SELECT
          attempt.attempt_no,
          attempt.status,
          attempt.error_category,
          attempt.retry_not_before,
          attempt.retry_of_model_run_attempt_id::text,
          command.recovery_policy_version
        FROM generation_commands command
        INNER JOIN model_run_attempts attempt
          ON attempt.generation_command_id =
            command.generation_command_id
        WHERE command.generation_command_id = $1
        ORDER BY attempt.attempt_no
      `,
      [events[0]?.generationCommandId],
    );
    expect(attempts.rows).toMatchObject([
      {
        attempt_no: 1,
        error_category: "rate_limited",
        recovery_policy_version: "conversation-response-recovery:v1",
        retry_not_before: new Date("2026-07-27T16:00:00.250Z"),
        retry_of_model_run_attempt_id: null,
        status: "failed",
      },
      {
        attempt_no: 2,
        error_category: null,
        recovery_policy_version: "conversation-response-recovery:v1",
        retry_not_before: null,
        retry_of_model_run_attempt_id: events[0]?.modelRunAttemptId,
        status: "succeeded",
      },
    ]);
    const inspection = await createInternalInspectionService({
      clock: () => currentTime,
      policyVersion: "sensitive-inspection:v1",
      repository: new PostgresInternalInspectionRepository(database.pool),
      stepUpMaxAgeMs: 10 * 60 * 1_000,
    }).getGenerationMetadata(
      fixedInternalOwnerPrincipal.userId,
      asGenerationCommandId(String(events[0]?.generationCommandId)),
    );
    expect(inspection.recovery).toMatchObject({
      attempts: [
        {
          attemptNo: 1,
          errorCategory: "rate_limited",
          recoveryStatus: "retried",
          retryNotBefore: new Date("2026-07-27T16:00:00.250Z"),
          retryOfModelRunAttemptId: null,
          status: "failed",
        },
        {
          attemptNo: 2,
          errorCategory: null,
          recoveryStatus: "recovered",
          retryNotBefore: null,
          retryOfModelRunAttemptId: events[0]?.modelRunAttemptId,
          status: "succeeded",
        },
      ],
      checkedAt: new Date("2026-07-27T16:00:00.250Z"),
      nextRecoveryAt: null,
      policyVersion: "conversation-response-recovery:v1",
      status: "recovered",
    });
    expect(JSON.stringify(inspection.recovery)).not.toContain(
      "Retry the same frozen request.",
    );
    expect(dispatchCount).toBe(2);
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
      validUntil: new Date("2027-08-27T16:00:00.000Z"),
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
      const events = await readNdjson(response);
      expect(events.at(-1)?.type).toBe("assistant_committed");
      return events;
    };
    const firstTurnEvents = await submit(
      "context-first-event",
      "context-first-turn",
      "The first committed expression.",
    );
    const secondTurnEvents = await submit(
      "context-second-event",
      "context-second-turn",
      "The second committed expression.",
    );
    const secondCommandId = secondTurnEvents[0]?.generationCommandId;
    const contextInspection = await fetch(
      `${nextServer.origin}/api/internal/inspection/generation` +
        `?generation_command_id=${secondCommandId}`,
      {
        headers: {
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
      },
    );
    expect(contextInspection.status).toBe(200);
    const contextMetadata = await contextInspection.json();
    expect(contextMetadata.compiledContext.referencedEvents).toEqual([
      {
        actor: "user",
        estimatedTokens: expect.any(Number),
        revisionId: firstTurnEvents[0]?.userEventRevisionId,
        section: "committed_raw_events",
        selectionOrder: 1,
        sequence: 1,
      },
      {
        actor: "assistant",
        estimatedTokens: expect.any(Number),
        revisionId: firstTurnEvents.at(-1)?.revisionId,
        section: "committed_raw_events",
        selectionOrder: 0,
        sequence: 2,
      },
      {
        actor: "user",
        estimatedTokens: expect.any(Number),
        revisionId: secondTurnEvents[0]?.userEventRevisionId,
        section: "current_user_input",
        selectionOrder: null,
        sequence: 3,
      },
    ]);

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

  it("records an inspectable degradation when only the newest history fits", async () => {
    await openPrivateWrites();
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const contextCompiler = createTestContextCompiler(responseRepository, 1);
    const service = createConversationResponseService({
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: fixedResponseClock,
      contextCompiler,
      conversationService: createUserTextConversationService({
        clock: fixedResponseClock,
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        repository: new PostgresUserTextConversationRepository(database.pool),
      }),
      harness: createTestHarness({
        clock: fixedResponseClock,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: fixedResponseClock,
          contextCompiler,
          model: createDeterministicConversationTextModel({
            chunks: ["OK"],
          }),
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });
    const handler = createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    });
    const submit = async (
      clientEventId: string,
      clientTurnId: string,
      text: string,
    ) =>
      readNdjson(
        await handler(
          new Request("http://localhost/api/internal/conversation/responses", {
            body: JSON.stringify({
              clientEventId,
              clientTurnId,
              locale: "en-US",
              text,
              timezone: "America/Los_Angeles",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        ),
      );

    const firstTurn = await submit(
      "budget-first-event",
      "budget-first-turn",
      "This older User Event cannot fit in a one-token history budget.",
    );
    const secondTurn = await submit(
      "budget-second-event",
      "budget-second-turn",
      "This current input is never truncated by the history budget.",
    );
    const secondGenerationCommandId =
      secondTurn[0]?.generationCommandId;
    if (typeof secondGenerationCommandId !== "string") {
      throw new Error("The second GenerationCommand was not returned.");
    }
    const metadata =
      await new PostgresInternalInspectionRepository(
        database.pool,
      ).findGenerationMetadata({
        generationCommandId: asGenerationCommandId(
          secondGenerationCommandId,
        ),
        userId: fixedInternalOwnerPrincipal.userId,
      });

    expect(metadata?.compiledContext).toMatchObject({
      degradedReason: "raw_event_budget_exceeded",
      referencedEvents: [
        {
          actor: "assistant",
          revisionId: firstTurn.at(-1)?.revisionId,
          section: "committed_raw_events",
          selectionOrder: 0,
          sequence: 2,
        },
        {
          actor: "user",
          revisionId: secondTurn[0]?.userEventRevisionId,
          section: "current_user_input",
          selectionOrder: null,
          sequence: 3,
        },
      ],
      sectionBudgets: {
        committedRawEvents: 1,
      },
      sections: expect.arrayContaining([
        expect.objectContaining({
          budgetTokens: 1,
          key: "committed_raw_events",
          selectedTokens: 1,
          truncatable: true,
        }),
        expect.objectContaining({
          key: "current_user_input",
          truncatable: false,
        }),
      ]),
    });
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
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: fixedResponseClock,
      contextCompiler: compiler,
      conversationService: createUserTextConversationService({
        clock: fixedResponseClock,
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        repository: new PostgresUserTextConversationRepository(database.pool),
      }),
      harness: createTestHarness({
        clock: fixedResponseClock,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: fixedResponseClock,
          contextCompiler: compiler,
          model,
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
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
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
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
      harness: createTestHarness({
        clock: fixedResponseClock,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: fixedResponseClock,
          contextCompiler: createTestContextCompiler(responseRepository),
          model: createDeterministicConversationTextModel({
            chunks: ["must not start"],
          }),
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
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
      validUntil: new Date("2027-08-27T16:00:00.000Z"),
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
      current_continuous_exchange_no: number;
      daily_sessions: string;
      dialogue_revision: string;
      interaction_turns: string;
      maximum_turn_exchange_no: number;
      minimum_turn_exchange_no: number;
      source_revision: string;
      user_events: string;
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM daily_sessions) AS daily_sessions,
        (SELECT COUNT(*)::text FROM interaction_turns) AS interaction_turns,
        (SELECT COUNT(*)::text FROM conversation_events) AS user_events,
        (
          SELECT MIN(continuous_exchange_no)
          FROM interaction_turns
        ) AS minimum_turn_exchange_no,
        (
          SELECT MAX(continuous_exchange_no)
          FROM interaction_turns
        ) AS maximum_turn_exchange_no,
        current_continuous_exchange_no,
        dialogue_revision::text,
        source_revision::text
      FROM daily_sessions
    `);
    expect(authoritative.rows[0]).toEqual({
      current_continuous_exchange_no: 1,
      daily_sessions: "1",
      dialogue_revision: "2",
      interaction_turns: "2",
      maximum_turn_exchange_no: 1,
      minimum_turn_exchange_no: 1,
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
      validUntil: new Date("2027-08-27T16:00:00.000Z"),
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

  it("keeps Daily Session logical date and starting timezone immutable", async () => {
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
      validUntil: new Date("2026-12-01T00:00:00.000Z"),
      verifiedAt: new Date("2026-10-31T00:00:00.000Z"),
    });
    const service = createUserTextConversationService({
      clock: () => new Date("2026-11-01T08:30:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const turn = await service.submit(fixedInternalOwnerPrincipal.userId, {
      clientEventId: "dst-session-event",
      clientTurnId: "dst-session-turn",
      locale: "zh-CN",
      text: "这段交流开始于夏令时重复出现的小时。",
      timezone: "America/Los_Angeles",
    });
    expect(turn.dailySession.logicalDate).toBe("2026-11-01");
    expect(turn.dailySession.timezoneAtStart).toBe("America/Los_Angeles");
    const repeatedHour = await createUserTextConversationService({
      clock: () => new Date("2026-11-01T09:30:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    }).submit(fixedInternalOwnerPrincipal.userId, {
      clientEventId: "dst-repeated-hour-event",
      clientTurnId: "dst-repeated-hour-turn",
      locale: "en-US",
      text: "The repeated local hour remains on the same date.",
      timezone: "America/Los_Angeles",
    });
    expect(repeatedHour.dailySession.id).toBe(turn.dailySession.id);
    expect(repeatedHour.dailySession.logicalDate).toBe("2026-11-01");

    await expect(
      database.pool.query(
        `
          UPDATE daily_sessions
          SET logical_date = '2026-11-02'
          WHERE daily_session_id = $1
        `,
        [turn.dailySession.id],
      ),
    ).rejects.toThrow("Daily Session ownership fields are immutable");
    await expect(
      database.pool.query(
        `
          UPDATE daily_sessions
          SET timezone_at_start = 'America/New_York'
          WHERE daily_session_id = $1
        `,
        [turn.dailySession.id],
      ),
    ).rejects.toThrow("Daily Session ownership fields are immutable");
  });

  it("keeps published inactivity and response-recovery policy versions immutable", async () => {
    await expect(
      database.pool.query(
        `
          UPDATE continuous_exchange_inactivity_policies
          SET timeout_ms = 60000
          WHERE policy_version = 'continuous-exchange-inactivity:v1'
        `,
      ),
    ).rejects.toThrow("Inactivity policy versions are immutable");
    await expect(
      database.pool.query(
        `
          UPDATE conversation_response_recovery_policies
          SET recovery_window_ms = 60000
          WHERE policy_version = 'conversation-response-recovery:v1'
        `,
      ),
    ).rejects.toThrow(
      "Conversation response recovery policy versions are immutable",
    );
  });

  it("ends the active exchange explicitly without creating an Assistant Event or model dispatch", async () => {
    if (!nextServer) {
      throw new Error("The Next test server is not running.");
    }
    await openPrivateWrites();
    const turnResponse = await fetch(
      `${nextServer.origin}/api/internal/conversation/turns`,
      {
        body: JSON.stringify({
          clientEventId: "explicit-end-event",
          clientTurnId: "explicit-end-turn",
          locale: "en-US",
          text: "That is everything I wanted to write.",
          timezone: "America/Los_Angeles",
        }),
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
        method: "POST",
      },
    );
    expect(turnResponse.status).toBe(200);
    const turn = await turnResponse.json();

    const end = async () =>
      fetch(`${nextServer?.origin}/api/internal/conversation/exchanges/end`, {
        body: JSON.stringify({ dailySessionId: turn.dailySession.id }),
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookieName}=${sessionToken}`,
        },
        method: "POST",
      });
    const firstEnd = await end();
    expect(firstEnd.status).toBe(200);
    expect(await firstEnd.json()).toEqual({
      dailySessionId: turn.dailySession.id,
      endedBy: "explicit_user_end",
      replayed: false,
      state: "quiescent",
    });
    const repeatedEnd = await end();
    expect(repeatedEnd.status).toBe(200);
    expect(await repeatedEnd.json()).toEqual({
      dailySessionId: turn.dailySession.id,
      endedBy: "explicit_user_end",
      replayed: true,
      state: "quiescent",
    });

    const state = await database.pool.query<{
      activity_state: string;
      assistant_events: string;
      egress_dispatches: string;
      quiescent_at: Date | null;
    }>(
      `
        SELECT
          session.activity_state,
          session.quiescent_at,
          (
            SELECT COUNT(*)::text
            FROM conversation_events
            WHERE actor = 'assistant'
          ) AS assistant_events,
          (
            SELECT COUNT(*)::text
            FROM provider_egress_dispositions
          ) AS egress_dispatches
        FROM daily_sessions session
        WHERE session.daily_session_id = $1
      `,
      [turn.dailySession.id],
    );
    expect(state.rows[0]).toEqual({
      activity_state: "quiescent",
      assistant_events: "0",
      egress_dispatches: "0",
      quiescent_at: new Date("2026-07-27T16:00:00.000Z"),
    });
  });

  it("increments the exchange number only when same-day activity returns from quiescent", async () => {
    await openPrivateWrites();
    const repository = new PostgresUserTextConversationRepository(database.pool);
    const createConversationAt = (now: string) =>
      createUserTextConversationService({
        clock: () => new Date(now),
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        repository,
      });
    const firstService = createConversationAt("2026-07-27T16:00:00.000Z");
    const first = await firstService.submit(
      fixedInternalOwnerPrincipal.userId,
      {
        clientEventId: "same-day-exchange-1-event",
        clientTurnId: "same-day-exchange-1-turn",
        locale: "en-US",
        text: "The first exchange.",
        timezone: "America/Los_Angeles",
      },
    );
    await firstService.endContinuousExchange(
      fixedInternalOwnerPrincipal.userId,
      { dailySessionId: first.dailySession.id },
    );
    const second = await createConversationAt(
      "2026-07-27T17:00:00.000Z",
    ).submit(fixedInternalOwnerPrincipal.userId, {
      clientEventId: "same-day-exchange-2-event",
      clientTurnId: "same-day-exchange-2-turn",
      locale: "en-US",
      text: "The second exchange.",
      timezone: "America/Los_Angeles",
    });
    expect(second.dailySession.id).toBe(first.dailySession.id);

    const state = await database.pool.query<{
      current_continuous_exchange_no: number;
      turn_exchange_numbers: number[];
    }>(
      `
        SELECT
          session.current_continuous_exchange_no,
          ARRAY_AGG(
            turn.continuous_exchange_no
            ORDER BY turn.turn_sequence_no
          ) AS turn_exchange_numbers
        FROM daily_sessions session
        INNER JOIN interaction_turns turn
          ON turn.daily_session_id = session.daily_session_id
        WHERE session.daily_session_id = $1
        GROUP BY session.daily_session_id
      `,
      [first.dailySession.id],
    );
    expect(state.rows[0]).toEqual({
      current_continuous_exchange_no: 2,
      turn_exchange_numbers: [1, 2],
    });
  });

  it("creates a new-date Daily Session only after the crossed-midnight exchange ends", async () => {
    await openPrivateWrites();
    const repository = new PostgresUserTextConversationRepository(database.pool);
    const createConversationAt = (now: string) =>
      createUserTextConversationService({
        clock: () => new Date(now),
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        repository,
      });
    const beforeMidnight = await createConversationAt(
      "2026-07-28T06:55:00.000Z",
    ).submit(fixedInternalOwnerPrincipal.userId, {
      clientEventId: "new-date-before-midnight-event",
      clientTurnId: "new-date-before-midnight-turn",
      locale: "en-US",
      text: "This starts before midnight.",
      timezone: "America/Los_Angeles",
    });
    const afterMidnight = createConversationAt(
      "2026-07-28T07:10:00.000Z",
    );
    await afterMidnight.endContinuousExchange(
      fixedInternalOwnerPrincipal.userId,
      { dailySessionId: beforeMidnight.dailySession.id },
    );
    const nextExchange = await afterMidnight.submit(
      fixedInternalOwnerPrincipal.userId,
      {
        clientEventId: "new-date-after-midnight-event",
        clientTurnId: "new-date-after-midnight-turn",
        locale: "en-US",
        text: "This starts after the earlier exchange ended.",
        timezone: "America/Los_Angeles",
      },
    );

    expect(beforeMidnight.dailySession.logicalDate).toBe("2026-07-27");
    expect(nextExchange.dailySession.logicalDate).toBe("2026-07-28");
    expect(nextExchange.dailySession.id).not.toBe(
      beforeMidnight.dailySession.id,
    );
  });

  it("does not let a model-generated closing statement end the exchange", async () => {
    await openPrivateWrites();
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const service = createConversationResponseService({
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
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
      harness: createTestHarness({
        clock: fixedResponseClock,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: fixedResponseClock,
          contextCompiler: createTestContextCompiler(responseRepository),
          model: createDeterministicConversationTextModel({
            chunks: ["It is okay to stop here. Goodbye for now."],
          }),
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });
    const streamEvents = [];
    for await (const event of service.respond(
      fixedInternalOwnerPrincipal.userId,
      {
        clientEventId: "model-closing-event",
        clientTurnId: "model-closing-turn",
        locale: "en-US",
        text: "I think I am done for now.",
        timezone: "America/Los_Angeles",
      },
    )) {
      streamEvents.push(event);
    }
    expect(streamEvents.at(-1)?.type).toBe("assistant_committed");

    const state = await database.pool.query<{
      activity_state: string;
      assistant_events: string;
      egress_dispatches: string;
    }>(`
      SELECT
        session.activity_state,
        (
          SELECT COUNT(*)::text
          FROM conversation_events
          WHERE actor = 'assistant'
        ) AS assistant_events,
        (
          SELECT COUNT(*)::text
          FROM provider_egress_dispositions
          WHERE status = 'completed'
        ) AS egress_dispatches
      FROM daily_sessions session
    `);
    expect(state.rows[0]).toEqual({
      activity_state: "active",
      assistant_events: "1",
      egress_dispatches: "1",
    });
  });

  it("revision-fences due inactivity and lets repeated scanners converge without side effects", async () => {
    await openPrivateWrites();
    const inactivityPolicy = Object.freeze({
      timeoutMs: 30 * 60 * 1_000,
      version: "continuous-exchange-inactivity:v1",
    });
    const createConversationAt = (now: string) =>
      createUserTextConversationService({
        clock: () => new Date(now),
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        inactivityPolicy,
        repository: new PostgresUserTextConversationRepository(database.pool),
      });
    const first = await createConversationAt(
      "2026-07-27T16:00:00.000Z",
    ).submit(fixedInternalOwnerPrincipal.userId, {
      clientEventId: "inactivity-event-1",
      clientTurnId: "inactivity-turn-1",
      locale: "en-US",
      text: "I may come back to this.",
      timezone: "America/Los_Angeles",
    });
    await createConversationAt("2026-07-27T16:10:00.000Z").submit(
      fixedInternalOwnerPrincipal.userId,
      {
        clientEventId: "inactivity-event-2",
        clientTurnId: "inactivity-turn-2",
        locale: "en-US",
        text: "One more detail before I go.",
        timezone: "America/Los_Angeles",
      },
    );

    const recoveryRepository = new PostgresContinuousExchangeRepository(
      database.pool,
    );
    const evaluations = await database.pool.query<{
      inactivity_evaluation_id: string;
    }>(`
      SELECT inactivity_evaluation_id
      FROM continuous_exchange_inactivity_evaluations
      ORDER BY due_at
    `);
    const staleEvaluation = await createContinuousExchangeService({
      clock: () => new Date("2026-07-27T16:31:00.000Z"),
      repository: recoveryRepository,
    }).evaluateInactivity(
      evaluations.rows[0]?.inactivity_evaluation_id ?? "",
    );
    expect(staleEvaluation).toEqual({
      outcome: "stale_revision",
      replayed: false,
    });
    const stillActive = await database.pool.query<{
      activity_state: string;
    }>(
      `
        SELECT activity_state
        FROM daily_sessions
        WHERE daily_session_id = $1
      `,
      [first.dailySession.id],
    );
    expect(stillActive.rows[0]?.activity_state).toBe("active");

    const dueScan = await createContinuousExchangeService({
      clock: () => new Date("2026-07-27T16:41:00.000Z"),
      repository: recoveryRepository,
    }).scanDueInactivity();
    expect(dueScan).toEqual({
      applied: 1,
      processed: 1,
      stale: 0,
    });
    const repeatedScan = await createContinuousExchangeService({
      clock: () => new Date("2026-07-27T17:00:00.000Z"),
      repository: recoveryRepository,
    }).scanDueInactivity();
    expect(repeatedScan).toEqual({
      applied: 0,
      processed: 0,
      stale: 0,
    });

    const state = await database.pool.query<{
      activity_state: string;
      assistant_events: string;
      egress_dispatches: string;
      evaluation_outcomes: string[];
      policy_versions: string[];
      quiescent_at: Date | null;
    }>(
      `
        SELECT
          session.activity_state,
          session.quiescent_at,
          ARRAY_AGG(evaluation.outcome ORDER BY evaluation.due_at)
            AS evaluation_outcomes,
          ARRAY_AGG(evaluation.policy_version ORDER BY evaluation.due_at)
            AS policy_versions,
          (
            SELECT COUNT(*)::text
            FROM conversation_events
            WHERE actor = 'assistant'
          ) AS assistant_events,
          (
            SELECT COUNT(*)::text
            FROM provider_egress_dispositions
          ) AS egress_dispatches
        FROM daily_sessions session
        INNER JOIN continuous_exchange_inactivity_evaluations evaluation
          ON evaluation.daily_session_id = session.daily_session_id
        WHERE session.daily_session_id = $1
        GROUP BY session.daily_session_id
      `,
      [first.dailySession.id],
    );
    expect(state.rows[0]).toEqual({
      activity_state: "quiescent",
      assistant_events: "0",
      egress_dispatches: "0",
      evaluation_outcomes: ["stale_revision", "applied"],
      policy_versions: [
        "continuous-exchange-inactivity:v1",
        "continuous-exchange-inactivity:v1",
      ],
      quiescent_at: new Date("2026-07-27T16:41:00.000Z"),
    });
  });

  it("makes an older inactivity evaluation stale when a Retry Event resumes activity", async () => {
    await openPrivateWrites();
    const inactivityPolicy = Object.freeze({
      timeoutMs: 30 * 60 * 1_000,
      version: "continuous-exchange-inactivity:v1",
    });
    const createConversationAt = (now: string) =>
      createUserTextConversationService({
        clock: () => new Date(now),
        expectedBackupPolicyVersion: "neon-production-v1",
        expectedConfigurationFingerprint: "sha256:expected",
        generationPolicy: testGenerationPolicy,
        inactivityPolicy,
        repository: new PostgresUserTextConversationRepository(database.pool),
      });
    const original = await createConversationAt(
      "2026-07-27T16:00:00.000Z",
    ).submit(fixedInternalOwnerPrincipal.userId, {
      clientEventId: "retry-inactivity-event",
      clientTurnId: "retry-inactivity-turn",
      locale: "en-US",
      text: "Please keep this open while I retry.",
      timezone: "America/Los_Angeles",
    });
    await database.pool.query(
      `
        UPDATE interaction_turns
        SET status = 'interrupted', updated_at = $1
        WHERE interaction_turn_id = $2
      `,
      [new Date("2026-07-27T16:05:00.000Z"), original.turn.id],
    );
    await database.pool.query(
      `
        UPDATE generation_commands
        SET status = 'interrupted'
        WHERE interaction_turn_id = $1
      `,
      [original.turn.id],
    );

    await createConversationAt("2026-07-27T16:10:00.000Z").retry(
      fixedInternalOwnerPrincipal.userId,
      {
        originalTurnId: original.turn.id,
        retryRequestId: "retry-inactivity-request",
      },
    );

    const evaluations = await database.pool.query<{
      expected_dialogue_revision: string;
      inactivity_evaluation_id: string;
    }>(`
      SELECT
        inactivity_evaluation_id,
        expected_dialogue_revision::text
      FROM continuous_exchange_inactivity_evaluations
      ORDER BY due_at
    `);
    expect(
      evaluations.rows.map((row) => row.expected_dialogue_revision),
    ).toEqual(["1", "2"]);

    const staleEvaluation = await createContinuousExchangeService({
      clock: () => new Date("2026-07-27T16:31:00.000Z"),
      repository: new PostgresContinuousExchangeRepository(database.pool),
    }).evaluateInactivity(
      evaluations.rows[0]?.inactivity_evaluation_id ?? "",
    );
    expect(staleEvaluation).toEqual({
      outcome: "stale_revision",
      replayed: false,
    });
    const state = await database.pool.query<{
      activity_state: string;
      dialogue_revision: string;
    }>(
      `
        SELECT activity_state, dialogue_revision::text
        FROM daily_sessions
        WHERE daily_session_id = $1
      `,
      [original.dailySession.id],
    );
    expect(state.rows[0]).toEqual({
      activity_state: "active",
      dialogue_revision: "2",
    });
  });

  it("keeps an inactivity evaluation's authoritative snapshot immutable", async () => {
    await openPrivateWrites();
    const conversation = createUserTextConversationService({
      clock: () => new Date("2026-07-27T16:00:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    await conversation.submit(fixedInternalOwnerPrincipal.userId, {
      clientEventId: "immutable-evaluation-event",
      clientTurnId: "immutable-evaluation-turn",
      locale: "en-US",
      text: "Freeze this inactivity decision.",
      timezone: "America/Los_Angeles",
    });
    const evaluation = await database.pool.query<{
      inactivity_evaluation_id: string;
    }>(`
      SELECT inactivity_evaluation_id
      FROM continuous_exchange_inactivity_evaluations
    `);

    await expect(
      database.pool.query(
        `
          UPDATE continuous_exchange_inactivity_evaluations
          SET
            expected_dialogue_revision = expected_dialogue_revision + 1,
            due_at = due_at + INTERVAL '1 minute'
          WHERE inactivity_evaluation_id = $1
        `,
        [evaluation.rows[0]?.inactivity_evaluation_id],
      ),
    ).rejects.toMatchObject({
      code: "55000",
      message: "Inactivity evaluation snapshots are immutable",
    });
  });

  it("exposes one authenticated scheduled scanner over PostgreSQL authoritative state", async () => {
    if (!nextServer) {
      throw new Error("The Next test server is not running.");
    }
    await openPrivateWrites();
    const conversation = createUserTextConversationService({
      clock: () => new Date("2026-07-27T15:00:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      inactivityPolicy: {
        timeoutMs: 30 * 60 * 1_000,
        version: "continuous-exchange-inactivity:v1",
      },
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    await conversation.submit(fixedInternalOwnerPrincipal.userId, {
      clientEventId: "scheduled-scanner-event",
      clientTurnId: "scheduled-scanner-turn",
      locale: "en-US",
      text: "This exchange can expire.",
      timezone: "America/Los_Angeles",
    });

    const unauthorized = await fetch(
      `${nextServer.origin}/api/internal/recovery/scan`,
    );
    expect(unauthorized.status).toBe(401);
    const scanned = await fetch(
      `${nextServer.origin}/api/internal/recovery/scan`,
      {
        headers: {
          authorization: "Bearer system-test-recovery-scanner-secret",
        },
      },
    );
    expect(scanned.status).toBe(200);
    expect(await scanned.json()).toEqual({
      consolidation: {
        daily: 0,
        reArmed: 0,
        sweeper: 0,
        weekly: 0,
      },
      eligibility: {
        commandsCreated: 0,
        evaluated: 0,
      },
      dialogueState: {
        queued: 1,
      },
      inactivity: {
        applied: 0,
        processed: 1,
        stale: 1,
      },
      purge: {
        remaining: 0,
        retried: 0,
      },
      outbox: {
        dispatched: 1,
        failed: 0,
        reclaimed: 0,
      },
      rollingSummary: {
        queued: 0,
      },
      responses: {
        committed: 1,
        interrupted: 0,
        processed: 1,
        retried: 0,
        terminal: 0,
      },
    });
  });

  it("recovers a stale Text Turn whose process stopped before Provider dispatch", async () => {
    await openPrivateWrites();
    const conversationRepository =
      new PostgresUserTextConversationRepository(database.pool);
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const conversationService = createUserTextConversationService({
      clock: () => new Date("2026-07-27T16:00:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: conversationRepository,
    });
    const abandoned = await conversationService.submit(
      fixedInternalOwnerPrincipal.userId,
      {
        clientEventId: "recovery-before-dispatch-event",
        clientTurnId: "recovery-before-dispatch-turn",
        locale: "en-US",
        text: "Please recover this prepared response.",
        timezone: "America/Los_Angeles",
      },
    );
    await database.pool.query(
      `
        UPDATE model_run_attempts
        SET attempt_no = 3
        WHERE generation_command_id = $1
      `,
      [abandoned.generation.commandId],
    );
    const recoveryClock = () => new Date("2026-07-27T16:10:00.000Z");
    const contextCompiler = createContextCompiler({
      clock: recoveryClock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    const recovery = createConversationResponseService({
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: recoveryClock,
      contextCompiler,
      conversationService,
      harness: createTestHarness({
        clock: recoveryClock,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: recoveryClock,
          contextCompiler,
          model: createDeterministicConversationTextModel({
            chunks: ["Recovered once."],
          }),
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });

    const overlappingScans = await Promise.all([
      recovery.scanStaleResponses(),
      recovery.scanStaleResponses(),
    ]);
    expect(
      overlappingScans.reduce(
        (total, scan) => ({
          committed: total.committed + scan.committed,
          interrupted: total.interrupted + scan.interrupted,
          processed: total.processed + scan.processed,
          retried: total.retried + scan.retried,
          terminal: total.terminal + scan.terminal,
        }),
        {
          committed: 0,
          interrupted: 0,
          processed: 0,
          retried: 0,
          terminal: 0,
        },
      ),
    ).toEqual({
      committed: 1,
      interrupted: 0,
      processed: 1,
      retried: 0,
      terminal: 0,
    });
    expect(await recovery.scanStaleResponses()).toEqual({
      committed: 0,
      interrupted: 0,
      processed: 0,
      retried: 0,
      terminal: 0,
    });

    const recovered = await database.pool.query<{
      assistant_events: string;
      attempt_count: string;
      command_status: string;
      turn_status: string;
    }>(
      `
        SELECT
          turn.status AS turn_status,
          command.status AS command_status,
          (
            SELECT COUNT(*)::text
            FROM model_run_attempts attempt
            WHERE attempt.generation_command_id =
              command.generation_command_id
          ) AS attempt_count,
          (
            SELECT COUNT(*)::text
            FROM conversation_events event
            WHERE event.generation_command_id =
              command.generation_command_id
              AND event.actor = 'assistant'
          ) AS assistant_events
        FROM interaction_turns turn
        INNER JOIN generation_commands command
          ON command.interaction_turn_id = turn.interaction_turn_id
        WHERE turn.interaction_turn_id = $1
      `,
      [abandoned.turn.id],
    );
    expect(recovered.rows[0]).toEqual({
      assistant_events: "1",
      attempt_count: "1",
      command_status: "succeeded",
      turn_status: "settled",
    });
  });

  it("prevents a stale caller from claiming a scanner-created retry attempt", async () => {
    await openPrivateWrites();
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const conversationService = createUserTextConversationService({
      clock: () => new Date("2026-07-27T16:00:00.000Z"),
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const stale = await conversationService.submit(
      fixedInternalOwnerPrincipal.userId,
      {
        clientEventId: "stale-execution-claim-event",
        clientTurnId: "stale-execution-claim-turn",
        locale: "en-US",
        text: "Only the latest attempt may claim this command.",
        timezone: "America/Los_Angeles",
      },
    );
    await database.pool.query(
      `
        UPDATE generation_commands
        SET status = 'running'
        WHERE generation_command_id = $1
      `,
      [stale.generation.commandId],
    );
    await database.pool.query(
      `
        UPDATE model_run_attempts
        SET
          status = 'running',
          started_at = '2026-07-27T16:00:00.000Z'
        WHERE model_run_attempt_id = $1
      `,
      [stale.generation.attemptId],
    );

    const recovery =
      await responseRepository.claimStaleResponseExecution({
        expectedModelRunAttemptId: stale.generation.attemptId,
        generationCommandId: stale.generation.commandId,
        now: new Date("2026-07-27T16:10:00.000Z"),
        userId: fixedInternalOwnerPrincipal.userId,
      });
    expect(recovery).toMatchObject({
      outcome: "execute",
      retried: true,
    });
    if (recovery.outcome !== "execute") {
      throw new Error("The stale response was not claimed for recovery.");
    }

    expect(
      await responseRepository.claimResponseExecution({
        generationCommandId: stale.generation.commandId,
        modelRunAttemptId: stale.generation.attemptId,
        userId: fixedInternalOwnerPrincipal.userId,
      }),
    ).toBe("shared");
    expect(
      await database.pool.query<{ status: string }>(
        `
          SELECT status
          FROM generation_commands
          WHERE generation_command_id = $1
        `,
        [stale.generation.commandId],
      ),
    ).toMatchObject({ rows: [{ status: "prepared" }] });
    expect(
      await responseRepository.claimResponseExecution({
        generationCommandId: recovery.generationCommandId,
        modelRunAttemptId: recovery.modelRunAttemptId,
        userId: recovery.userId,
      }),
    ).toBe("owner");
  });

  it("retries one stale pre-output Provider dispatch under the frozen GenerationCommand", async () => {
    await openPrivateWrites();
    let currentTime = new Date("2026-07-27T16:00:00.000Z");
    let releaseAbandonedAttempt: (() => void) | undefined;
    let reportAbandonedDispatch: (() => void) | undefined;
    let releaseRecoveryAttempt: (() => void) | undefined;
    let reportRecoveryDispatch: (() => void) | undefined;
    const abandonedDispatchStarted = new Promise<void>((resolve) => {
      reportAbandonedDispatch = resolve;
    });
    const abandonedAttemptReleased = new Promise<void>((resolve) => {
      releaseAbandonedAttempt = resolve;
    });
    const recoveryDispatchStarted = new Promise<void>((resolve) => {
      reportRecoveryDispatch = resolve;
    });
    const recoveryAttemptReleased = new Promise<void>((resolve) => {
      releaseRecoveryAttempt = resolve;
    });
    let dispatchCount = 0;
    const model: ConversationTextModel = {
      async *stream() {
        dispatchCount += 1;
        if (dispatchCount === 1) {
          reportAbandonedDispatch?.();
          await abandonedAttemptReleased;
          yield {
            delta: "This superseded token must never become visible.",
            type: "delta",
          };
          yield {
            costMicros: 0,
            finishReason: "completed",
            inputTokens: 1,
            modelSnapshot: testChampion.snapshot,
            outputTokens: 1,
            providerRequestId: "superseded-recovery-attempt-1",
            type: "completed",
          };
          return;
        }
        reportRecoveryDispatch?.();
        await recoveryAttemptReleased;
        yield { delta: "Recovered from the timed-out dispatch.", type: "delta" };
        yield {
          costMicros: 0,
          finishReason: "completed",
          inputTokens: 1,
          modelSnapshot: testChampion.snapshot,
          outputTokens: 1,
          providerRequestId: "recovery-attempt-2",
          type: "completed",
        };
      },
    };
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const conversationService = createUserTextConversationService({
      clock: () => currentTime,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const contextCompiler = createContextCompiler({
      clock: () => currentTime,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    const service = createConversationResponseService({
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: () => currentTime,
      contextCompiler,
      conversationService,
      harness: createTestHarness({
        clock: () => currentTime,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: () => currentTime,
          contextCompiler,
          model,
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });
    const requestPath = service
      .respond(fixedInternalOwnerPrincipal.userId, {
        clientEventId: "recovery-before-token-event",
        clientTurnId: "recovery-before-token-turn",
        locale: "en-US",
        text: "Recover without changing the frozen request.",
        timezone: "America/Los_Angeles",
      })
      [Symbol.asyncIterator]();
    const committed = await requestPath.next();
    const abandonedResult = requestPath.next();
    await abandonedDispatchStarted;

    currentTime = new Date("2026-07-27T16:10:00.000Z");
    const recoveryScan = service.scanStaleResponses();
    await recoveryDispatchStarted;
    releaseAbandonedAttempt?.();
    expect(await abandonedResult).toMatchObject({
      value: {
        type: "response_failed",
      },
    });

    const inFlightRetry = await database.pool.query<{
      attempt_statuses: string[];
      command_status: string;
      turn_status: string;
    }>(
      `
        SELECT
          turn.status AS turn_status,
          command.status AS command_status,
          ARRAY_AGG(attempt.status ORDER BY attempt.attempt_no)
            AS attempt_statuses
        FROM interaction_turns turn
        INNER JOIN generation_commands command
          ON command.interaction_turn_id = turn.interaction_turn_id
        INNER JOIN model_run_attempts attempt
          ON attempt.generation_command_id =
            command.generation_command_id
        WHERE command.generation_command_id = $1
        GROUP BY turn.status, command.status
      `,
      [committed.value?.generationCommandId],
    );
    expect(inFlightRetry.rows[0]).toEqual({
      attempt_statuses: ["result_unknown", "running"],
      command_status: "running",
      turn_status: "responding",
    });

    releaseRecoveryAttempt?.();
    expect(await recoveryScan).toEqual({
      committed: 1,
      interrupted: 0,
      processed: 1,
      retried: 1,
      terminal: 0,
    });

    const recovered = await database.pool.query<{
      assistant_events: string;
      attempt_nos: number[];
      attempt_statuses: string[];
      command_id: string;
      frozen_models: string[];
      frozen_prompts: string[];
      retry_sources: Array<string | null>;
    }>(
      `
        SELECT
          command.generation_command_id AS command_id,
          ARRAY_AGG(attempt.attempt_no ORDER BY attempt.attempt_no)
            AS attempt_nos,
          ARRAY_AGG(attempt.status ORDER BY attempt.attempt_no)
            AS attempt_statuses,
          ARRAY_AGG(attempt.model ORDER BY attempt.attempt_no)
            AS frozen_models,
          ARRAY_AGG(attempt.prompt_version ORDER BY attempt.attempt_no)
            AS frozen_prompts,
          ARRAY_AGG(
            attempt.retry_of_model_run_attempt_id::text
            ORDER BY attempt.attempt_no
          ) AS retry_sources,
          (
            SELECT COUNT(*)::text
            FROM conversation_events event
            WHERE event.generation_command_id =
              command.generation_command_id
              AND event.actor = 'assistant'
          ) AS assistant_events
        FROM generation_commands command
        INNER JOIN model_run_attempts attempt
          ON attempt.generation_command_id =
            command.generation_command_id
        WHERE command.generation_command_id = $1
        GROUP BY command.generation_command_id
      `,
      [committed.value?.generationCommandId],
    );
    expect(recovered.rows[0]).toMatchObject({
      assistant_events: "1",
      attempt_nos: [1, 2],
      attempt_statuses: ["result_unknown", "succeeded"],
      command_id: committed.value?.generationCommandId,
      frozen_models: [testGenerationPolicy.model, testGenerationPolicy.model],
      frozen_prompts: [
        testGenerationPolicy.taskInstructionVersion,
        testGenerationPolicy.taskInstructionVersion,
      ],
    });
    expect(recovered.rows[0]?.retry_sources[0]).toBeNull();
    expect(recovered.rows[0]?.retry_sources[1]).toBe(
      committed.value?.modelRunAttemptId,
    );
    expect(dispatchCount).toBe(2);
  });

  it("interrupts a stale response after visible output without retrying or regenerating", async () => {
    await openPrivateWrites();
    let currentTime = new Date("2026-07-27T16:00:00.000Z");
    let releaseVisibleAttempt: (() => void) | undefined;
    let reportVisibleDispatch: (() => void) | undefined;
    const visibleDispatchStarted = new Promise<void>((resolve) => {
      reportVisibleDispatch = resolve;
    });
    const visibleAttemptReleased = new Promise<void>((resolve) => {
      releaseVisibleAttempt = resolve;
    });
    let dispatchCount = 0;
    const model: ConversationTextModel = {
      async *stream() {
        dispatchCount += 1;
        yield { delta: "Visible before the process stopped.", type: "delta" };
        reportVisibleDispatch?.();
        await visibleAttemptReleased;
        yield {
          costMicros: 0,
          finishReason: "completed",
          inputTokens: 1,
          modelSnapshot: testChampion.snapshot,
          outputTokens: 1,
          providerRequestId: "late-visible-attempt",
          type: "completed",
        };
      },
    };
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const conversationService = createUserTextConversationService({
      clock: () => currentTime,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const contextCompiler = createContextCompiler({
      clock: () => currentTime,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    const service = createConversationResponseService({
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: () => currentTime,
      contextCompiler,
      conversationService,
      harness: createTestHarness({
        clock: () => currentTime,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: () => currentTime,
          contextCompiler,
          model,
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });
    const requestPath = service
      .respond(fixedInternalOwnerPrincipal.userId, {
        clientEventId: "recovery-after-visible-event",
        clientTurnId: "recovery-after-visible-turn",
        locale: "en-US",
        text: "Do not regenerate output I may already have seen.",
        timezone: "America/Los_Angeles",
      })
      [Symbol.asyncIterator]();
    const committed = await requestPath.next();
    expect((await requestPath.next()).value).toMatchObject({
      delta: "Visible before the process stopped.",
      type: "assistant_delta",
    });
    const lateCompletion = requestPath.next();
    await visibleDispatchStarted;

    currentTime = new Date("2026-07-27T16:10:00.000Z");
    expect(await service.scanStaleResponses()).toEqual({
      committed: 0,
      interrupted: 1,
      processed: 1,
      retried: 0,
      terminal: 0,
    });
    releaseVisibleAttempt?.();
    expect(await lateCompletion).toMatchObject({
      value: {
        type: "response_interrupted",
      },
    });

    const interrupted = await database.pool.query<{
      assistant_events: string;
      attempt_count: string;
      attempt_status: string;
      command_status: string;
      turn_status: string;
    }>(
      `
        SELECT
          turn.status AS turn_status,
          command.status AS command_status,
          attempt.status AS attempt_status,
          (
            SELECT COUNT(*)::text
            FROM model_run_attempts command_attempt
            WHERE command_attempt.generation_command_id =
              command.generation_command_id
          ) AS attempt_count,
          (
            SELECT COUNT(*)::text
            FROM conversation_events event
            WHERE event.generation_command_id =
              command.generation_command_id
              AND event.actor = 'assistant'
          ) AS assistant_events
        FROM interaction_turns turn
        INNER JOIN generation_commands command
          ON command.interaction_turn_id = turn.interaction_turn_id
        INNER JOIN model_run_attempts attempt
          ON attempt.generation_command_id =
            command.generation_command_id
        WHERE command.generation_command_id = $1
      `,
      [committed.value?.generationCommandId],
    );
    expect(interrupted.rows[0]).toEqual({
      assistant_events: "0",
      attempt_count: "1",
      attempt_status: "interrupted",
      command_status: "interrupted",
      turn_status: "interrupted",
    });
    expect(dispatchCount).toBe(1);
  });

  it("converges Provider-completed work lost before authoritative commit without reconstructing text", async () => {
    await openPrivateWrites();
    let currentTime = new Date("2026-07-27T16:00:00.000Z");
    let releaseCommit: (() => void) | undefined;
    let reportCommitStarted: (() => void) | undefined;
    const commitStarted = new Promise<void>((resolve) => {
      reportCommitStarted = resolve;
    });
    const commitReleased = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const blockingCommitRepository: ConversationResponseRepository = {
      claimResponseExecution:
        responseRepository.claimResponseExecution.bind(responseRepository),
      claimStaleResponseExecution:
        responseRepository.claimStaleResponseExecution.bind(responseRepository),
      commitCompleteResponse: async (input) => {
        reportCommitStarted?.();
        await commitReleased;
        return responseRepository.commitCompleteResponse(input);
      },
      listStaleResponseExecutions:
        responseRepository.listStaleResponseExecutions.bind(responseRepository),
      loadResponse: responseRepository.loadResponse.bind(responseRepository),
      settleResponseFailure:
        responseRepository.settleResponseFailure.bind(responseRepository),
    };
    const conversationService = createUserTextConversationService({
      clock: () => currentTime,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const contextCompiler = createContextCompiler({
      clock: () => currentTime,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    const service = createConversationResponseService({
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: () => currentTime,
      contextCompiler,
      conversationService,
      harness: createTestHarness({
        clock: () => currentTime,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: () => currentTime,
          contextCompiler,
          model: createDeterministicConversationTextModel({
            chunks: ["Never reconstruct this body."],
          }),
          repository: responseRepository,
        }),
        repository: blockingCommitRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: blockingCommitRepository,
    });
    const requestPath = service
      .respond(fixedInternalOwnerPrincipal.userId, {
        clientEventId: "recovery-before-commit-event",
        clientTurnId: "recovery-before-commit-turn",
        locale: "en-US",
        text: "Treat the lost completion conservatively.",
        timezone: "America/Los_Angeles",
      })
      [Symbol.asyncIterator]();
    const committed = await requestPath.next();
    expect((await requestPath.next()).value?.type).toBe("assistant_delta");
    const blockedCommit = requestPath.next();
    await commitStarted;

    currentTime = new Date("2026-07-27T16:10:00.000Z");
    expect(await service.scanStaleResponses()).toEqual({
      committed: 0,
      interrupted: 1,
      processed: 1,
      retried: 0,
      terminal: 0,
    });
    releaseCommit?.();
    await blockedCommit;

    const recovered = await database.pool.query<{
      assistant_events: string;
      attempt_status: string;
      command_status: string;
      provider_completed_at: Date | null;
      turn_status: string;
    }>(
      `
        SELECT
          turn.status AS turn_status,
          command.status AS command_status,
          attempt.status AS attempt_status,
          attempt.provider_completed_at,
          (
            SELECT COUNT(*)::text
            FROM conversation_events event
            WHERE event.generation_command_id =
              command.generation_command_id
              AND event.actor = 'assistant'
          ) AS assistant_events
        FROM interaction_turns turn
        INNER JOIN generation_commands command
          ON command.interaction_turn_id = turn.interaction_turn_id
        INNER JOIN model_run_attempts attempt
          ON attempt.generation_command_id =
            command.generation_command_id
        WHERE command.generation_command_id = $1
      `,
      [committed.value?.generationCommandId],
    );
    expect(recovered.rows[0]).toMatchObject({
      assistant_events: "0",
      attempt_status: "result_unknown",
      command_status: "interrupted",
      provider_completed_at: new Date("2026-07-27T16:00:00.000Z"),
      turn_status: "interrupted",
    });
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
      validUntil: new Date("2027-08-27T16:00:00.000Z"),
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
  output(): string;
  stop(): Promise<void>;
}>;

async function startNextTestServer(
  databaseUrl: string,
  purgeMarkerDatabaseUrl: string,
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
        PURGE_MARKER_DATABASE_URL: purgeMarkerDatabaseUrl,
        GITHUB_CLIENT_ID: "system-test-client",
        GITHUB_CLIENT_SECRET: "system-test-client-secret",
        NEXTAUTH_SECRET: "system-test-server-only-secret",
        NEXTAUTH_URL: origin,
        NODE_ENV: "development",
        OPENAI_API_KEY: "PROVIDER_CREDENTIAL_CANARY",
        SAYHEAR_AUTH_SECRET_SOURCE: "managed",
        SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "sha256:expected",
        SAYHEAR_BACKUP_POLICY_VERSION: "neon-production-v1",
        SAYHEAR_CONTEXT_HMAC_SECRET: "system-test-context-integrity-secret",
        SAYHEAR_DEPLOYMENT: "test",
        SAYHEAR_PROVIDER_ADAPTER: "deterministic",
        // Pin the deterministic adapter's champion metadata: local .env files
        // (apps/web/.env symlinks the repo root .env) may carry a real
        // production model override, and the egress claim requires the frozen
        // command to match the runtime champion field-by-field — otherwise
        // recovery fails closed as policy_blocked/terminal.
        SAYHEAR_CONVERSATION_TEXT_MODEL: "gpt-5.4",
        SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT: "gpt-5.4",
        CRON_SECRET: "system-test-recovery-scanner-secret",
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
          output: output.read,
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
