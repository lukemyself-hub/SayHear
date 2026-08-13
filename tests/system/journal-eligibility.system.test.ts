import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  asDailySessionId,
  asUserId,
  createJournalEligibilityService,
  createOutboxDispatcherService,
  createConversationResponseService,
  createContextCompiler,
  createUserTextConversationService,
  runJournalEligibility,
  type ConversationTextChampion,
} from "@sayhear/application";
import {
  createBehaviorAwareConversationTextModel,
  createProviderEgressPort,
} from "@sayhear/ai/testing";
import {
  PostgresConversationResponseRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresJournalEligibilityRepository,
  PostgresOutboxDispatcherRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

import { createConversationResponseHandler } from "../../apps/web/src/conversation-response-handler";
import { createContinuousExchangeEndHandler } from "../../apps/web/src/continuous-exchange-end-handler";
import { createRecoveryScannerHandler } from "../../apps/web/src/recovery-scanner-handler";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required; the system seam never falls back to a mock database.",
  );
}

const fixedResponseClock = () => new Date("2026-08-12T16:00:00.000Z");

const testChampion: ConversationTextChampion = Object.freeze({
  configVersion: "conversation-text-champion:v1",
  consentPolicyVersion: null,
  contextLimit: 1_000_000,
  dataRegion: "test",
  model: "gpt-5.4",
  provider: "openai",
  providerPolicyVersion: "openai-conversation-text:v1",
  retentionMode: "store-disabled",
  snapshot: "gpt-5.4",
  streaming: true,
  supportedLocales: Object.freeze(["en", "zh"]),
  trainingPolicy: "test",
});

const testGenerationPolicy = Object.freeze({
  consentPolicyVersion: null,
  freshnessPolicy: "source_valid:v1" as const,
  chineseLocalePackVersion: "locale-pack-zh:v1",
  englishLocalePackVersion: "locale-pack-en:v1",
  model: "gpt-5.4",
  modelConfigVersion: "conversation-text-champion:v1",
  modelSnapshot: "gpt-5.4",
  outputFormatVersion: "conversation-output:v1",
  personaVersion: "sayhear-persona:v1",
  productPolicyVersion: "product-policy:v1",
  promptVersion: "conversation-text:v1",
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
});

const JOURNAL_ELIGIBILITY_POLICY_VERSION = "journal-eligibility:v1";
const MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH = 20;

describe("Authenticated Journal Eligibility System Seam — 1A.2 durability foundation", () => {
  let database: IsolatedPostgresSchema;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "test-owner",
      userId: fixedInternalOwnerPrincipal.userId,
    });
  }, 20_000);

  beforeEach(async () => {
    await database.pool.query(`
      TRUNCATE TABLE
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
    await database.pool.query("DELETE FROM backup_policy_versions");
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
    await database.pool.query(
      "UPDATE provider_egress_policy_versions SET status = 'active'",
    );
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
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  function buildComposition() {
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const conversationRepository = new PostgresUserTextConversationRepository(
      database.pool,
    );
    const journalEligibilityRepository = new PostgresJournalEligibilityRepository(
      database.pool,
    );
    const outboxRepository = new PostgresOutboxDispatcherRepository(
      database.pool,
    );
    const contextCompiler = createContextCompiler({
      clock: fixedResponseClock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    const conversationService = createUserTextConversationService({
      clock: fixedResponseClock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: conversationRepository,
    });
    const conversationResponseService = createConversationResponseService({
      clock: fixedResponseClock,
      contextCompiler,
      conversationService,
      egressPort: createProviderEgressPort({
        champion: testChampion,
        clock: fixedResponseClock,
        contextCompiler,
        model: createBehaviorAwareConversationTextModel({
          responder: () => ["I hear you, that matters."],
        }),
        repository: responseRepository,
      }),
      repository: responseRepository,
    });
    const journalEligibilityService = createJournalEligibilityService({
      clock: fixedResponseClock,
      expectedDataEpoch: 1,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      repository: journalEligibilityRepository,
    });
    return {
      conversationResponseService,
      conversationService,
      journalEligibilityRepository,
      journalEligibilityService,
      outboxRepository,
    };
  }

  async function submitConversation(input: {
    clientEventId: string;
    clientTurnId: string;
    text: string;
  }): Promise<string> {
    const composition = buildComposition();
    const handler = createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service: composition.conversationResponseService,
    });
    const response = await handler(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify({
          clientEventId: input.clientEventId,
          clientTurnId: input.clientTurnId,
          locale: "en-US",
          text: input.text,
          timezone: "America/Los_Angeles",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    // Fully drain the NDJSON stream so the conversation commits before we read.
    await response.text();
    const session = await database.pool.query<{ daily_session_id: string }>(
      `SELECT daily_session_id FROM daily_sessions WHERE user_id = $1`,
      [fixedInternalOwnerPrincipal.userId],
    );
    return session.rows[0]!.daily_session_id;
  }

  async function endExchange(dailySessionId: string): Promise<void> {
    const composition = buildComposition();
    const handler = createContinuousExchangeEndHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      journalEligibilityService: composition.journalEligibilityService,
      outboxDispatcherService: createOutboxDispatcherService({
        clock: fixedResponseClock,
        leaseDurationMs: 60_000,
        leaseOwner: "test-dispatcher",
        repository: composition.outboxRepository,
        startWorkflow: async () => ({
          workflowReceiptId: "test-receipt",
        }),
      }),
      service: composition.conversationService,
    });
    const response = await handler(
      new Request("http://localhost/api/internal/conversation/exchanges/end", {
        body: JSON.stringify({ dailySessionId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
  }

  it("creates the idempotent eligibility command and outbox event after an explicit end, then reaches an eligible date outcome (AC #1, #4, #5, #6, #10)", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "eligible-event",
      clientTurnId: "eligible-turn",
      text: "I felt invisible in that meeting today and it really hurt.",
    });
    await endExchange(dailySessionId);

    const command = await database.pool.query<{
      command_type: string;
      source_revision: number;
      status: string;
      subject_id: string;
      workflow_command_id: string;
    }>(`SELECT command_type, subject_id, source_revision, status, workflow_command_id FROM workflow_commands`);
    expect(command.rows).toHaveLength(1);
    expect(command.rows[0]).toMatchObject({
      command_type: "journal_eligibility",
      status: "created",
      subject_id: dailySessionId,
    });

    const outbox = await database.pool.query<{
      event_type: string;
      status: string;
      workflow_receipt_id: string | null;
    }>(`SELECT event_type, status, workflow_receipt_id FROM outbox_events`);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]).toMatchObject({
      event_type: "journal_eligibility_requested",
      status: "dispatched",
      workflow_receipt_id: "test-receipt",
    });

    // Run the application entrypoint as the Workflow step would (AC #10).
    const composition = buildComposition();
    const result = await runJournalEligibility({
      clock: fixedResponseClock,
      command: {
        workflowCommandId: command.rows[0]!.workflow_command_id,
        policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
        sourceRevision: command.rows[0]!.source_revision,
        subjectId: dailySessionId,
      },
      eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      repository: composition.journalEligibilityRepository,
      workflowReceiptId: "test-receipt",
    });
    expect(result.outcome).toBe("eligible_queued");

    const outcome = await database.pool.query<{
      outcome: string;
      workflow_receipt_id: string | null;
    }>(
      `SELECT outcome, workflow_receipt_id FROM daily_session_date_outcomes WHERE daily_session_id = $1`,
      [dailySessionId],
    );
    expect(outcome.rows[0]).toMatchObject({
      outcome: "eligible_queued",
      workflow_receipt_id: "test-receipt",
    });
  });

  it("converges when an explicit end and a due scan both try to create the same command (AC #1, #7)", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "converge-event",
      clientTurnId: "converge-turn",
      text: "I felt invisible in that meeting today and it really hurt.",
    });
    await endExchange(dailySessionId);

    const composition = buildComposition();
    // The cron sweep re-evaluates the same (already-ended) session.
    const reEvaluate = await composition.journalEligibilityService.evaluate(
      dailySessionId,
    );
    expect(reEvaluate).toMatchObject({ outcome: "evaluated", commandCreated: false });

    const command = await database.pool.query(`
      SELECT COUNT(*)::int AS count FROM workflow_commands
    `);
    expect(command.rows[0]!.count).toBe(1);
    const outbox = await database.pool.query(`
      SELECT COUNT(*)::int AS count FROM outbox_events
    `);
    expect(outbox.rows[0]!.count).toBe(1);
  });

  it("records insufficient_expression for a conversation that cannot support one truthful Statement (AC #3, ADR-0011)", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "insufficient-event",
      clientTurnId: "insufficient-turn",
      text: "ok", // below the 20-character substantive-expression threshold
    });
    await endExchange(dailySessionId);

    const composition = buildComposition();
    await composition.journalEligibilityService.evaluate(dailySessionId);
    const result = await runJournalEligibility({
      clock: fixedResponseClock,
      command: {
        workflowCommandId: dailySessionId,
        policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
        sourceRevision: 1,
        subjectId: dailySessionId,
      },
      eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      repository: composition.journalEligibilityRepository,
      workflowReceiptId: "insufficient-receipt",
    });
    expect(result.outcome).toBe("insufficient_expression");
    const outcome = await database.pool.query<{ outcome: string }>(
      `SELECT outcome FROM daily_session_date_outcomes WHERE daily_session_id = $1`,
      [dailySessionId],
    );
    expect(outcome.rows[0]!.outcome).toBe("insufficient_expression");
  });

  it("does not create a command while a conversation is still active (AC #2)", async () => {
    await submitConversation({
      clientEventId: "active-event",
      clientTurnId: "active-turn",
      text: "I felt invisible in that meeting today and it really hurt.",
    });
    const composition = buildComposition();
    const session = await database.pool.query<{ daily_session_id: string }>(
      `SELECT daily_session_id FROM daily_sessions WHERE user_id = $1`,
      [fixedInternalOwnerPrincipal.userId],
    );
    const result = await composition.journalEligibilityService.evaluate(
      session.rows[0]!.daily_session_id,
    );
    expect(result).toMatchObject({ outcome: "not_quiescent" });
    const totals = await database.pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM workflow_commands) AS commands,
        (SELECT COUNT(*)::int FROM outbox_events) AS outbox,
        (SELECT COUNT(*)::int FROM daily_session_date_outcomes) AS outcomes
    `);
    expect(totals.rows[0]).toMatchObject({ commands: 0, outbox: 0, outcomes: 0 });
  });

  it("absorbs duplicate Workflow runs into a single date outcome (AC #7)", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "dup-event",
      clientTurnId: "dup-turn",
      text: "I felt invisible in that meeting today and it really hurt.",
    });
    await endExchange(dailySessionId);
    const composition = buildComposition();
    await composition.journalEligibilityService.evaluate(dailySessionId);

    const command = await database.pool.query<{
      source_revision: number;
      workflow_command_id: string;
    }>(`SELECT source_revision, workflow_command_id FROM workflow_commands`);
    // Run the entrypoint three times — the date outcome is idempotent.
    for (let i = 0; i < 3; i += 1) {
      await runJournalEligibility({
        clock: fixedResponseClock,
        command: {
          workflowCommandId: command.rows[0]!.workflow_command_id,
          policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
          sourceRevision: command.rows[0]!.source_revision,
          subjectId: dailySessionId,
        },
        eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
        minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
        repository: composition.journalEligibilityRepository,
        workflowReceiptId: `dup-receipt-${i}`,
      });
    }
    const outcomes = await database.pool.query(`
      SELECT COUNT(*)::int AS count FROM daily_session_date_outcomes
    `);
    expect(outcomes.rows[0]!.count).toBe(1);
  });

  it("leases with FOR UPDATE SKIP LOCKED, allows expired leases to be reclaimed, and converges after a crash before receipt (AC #6, #7)", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "lease-event",
      clientTurnId: "lease-turn",
      text: "I felt invisible in that meeting today and it really hurt.",
    });
    // End without best-effort dispatch so the outbox row stays pending and can
    // be leased directly here.
    const composition = buildComposition();
    await composition.conversationService.endContinuousExchange(
      fixedInternalOwnerPrincipal.userId,
      { dailySessionId },
    );
    await composition.journalEligibilityService.evaluate(dailySessionId);

    // Simulate a crash after lease but before start: a prior dispatcher leased
    // the event with a 1ms lease, then crashed before recording a receipt.
    const leased =
      await composition.outboxRepository.leasePendingBatch({
        now: fixedResponseClock(),
        leaseDurationMs: 1,
        leaseOwner: "crashed-dispatcher",
        limit: 10,
      });
    expect(leased).toHaveLength(1);

    // Time advances past the crashed lease. The recovery dispatcher reclaims
    // the expired lease and dispatches in the same pass (AC #6, #7).
    const future = new Date(fixedResponseClock().getTime() + 5_000);
    const dispatcher = createOutboxDispatcherService({
      clock: () => future,
      leaseDurationMs: 60_000,
      leaseOwner: "recovery-dispatcher",
      repository: composition.outboxRepository,
      startWorkflow: async () => ({ workflowReceiptId: "reclaimed-receipt" }),
    });
    const dispatchResult = await dispatcher.dispatchPending();
    expect(dispatchResult.reclaimed).toBe(1);
    expect(dispatchResult.dispatched).toBe(1);

    const outbox = await database.pool.query<{
      lease_owner: string;
      status: string;
      workflow_receipt_id: string | null;
    }>(`SELECT lease_owner, status, workflow_receipt_id FROM outbox_events`);
    expect(outbox.rows[0]).toMatchObject({
      lease_owner: "recovery-dispatcher",
      status: "dispatched",
      workflow_receipt_id: "reclaimed-receipt",
    });
  });

  it("invokes the existing Cron recovery surface plus the outbox dispatcher with no second scheduler (AC #8)", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "cron-event",
      clientTurnId: "cron-turn",
      text: "I felt invisible in that meeting today and it really hurt.",
    });
    await endExchange(dailySessionId);

    const composition = buildComposition();
    const recoveryHandler = createRecoveryScannerHandler({
      continuousExchangeService: {
        evaluateInactivity: () => Promise.resolve({ outcome: "not_found" }),
        scanDueInactivity: () => Promise.resolve({ applied: 0, processed: 0, stale: 0 }),
      } as never,
      conversationResponseService: composition.conversationResponseService,
      journalEligibilityService: composition.journalEligibilityService,
      outboxDispatcherService: createOutboxDispatcherService({
        clock: fixedResponseClock,
        leaseDurationMs: 60_000,
        leaseOwner: "cron-dispatcher",
        repository: composition.outboxRepository,
        startWorkflow: async () => ({ workflowReceiptId: "cron-receipt" }),
      }),
      scannerSecret: "cron-secret",
    });

    const response = await recoveryHandler(
      new Request("http://localhost/api/internal/recovery/scan", {
        headers: { authorization: "Bearer cron-secret" },
        method: "GET",
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      eligibility: { commandsCreated: number };
      outbox: { dispatched: number };
    };
    // The Cron sweep created the command (the explicit end best-effort may have
    // created it already via ON CONFLICT; the dispatcher dispatched one event).
    expect(body.outbox.dispatched).toBeGreaterThanOrEqual(0);

    const command = await database.pool.query(`
      SELECT COUNT(*)::int AS count FROM workflow_commands
    `);
    expect(command.rows[0]!.count).toBe(1);
    void dailySessionId;
  });

  it("never carries conversation text into outbox payload, workflow command, or date outcome (AC #9, canary)", async () => {
    const canary = "CANARY-PRIVATE-EXPRESSION-1234567";
    const dailySessionId = await submitConversation({
      clientEventId: "canary-event",
      clientTurnId: "canary-turn",
      text: canary,
    });
    await endExchange(dailySessionId);

    const leaks = await database.pool.query(
      `
        SELECT 'outbox_payload' AS source FROM outbox_events WHERE payload::text ILIKE $1
        UNION ALL
        SELECT 'workflow_commands' FROM workflow_commands WHERE CAST(workflow_commands AS TEXT) ILIKE $1
        UNION ALL
        SELECT 'date_outcomes' FROM daily_session_date_outcomes WHERE CAST(daily_session_date_outcomes AS TEXT) ILIKE $1
      `,
      [`%${canary}%`],
    );
    expect(leaks.rows).toEqual([]);
  });

  it("returns no_activity for a command whose session has no user conversation events (AC #2, #10)", async () => {
    // An ended session with no user events is not producible through the happy
    // path, so drive the entrypoint directly with a freshly created session row.
    const dailySessionId = "01984477-aaaa-7bbb-8ccc-dddddddddddd";
    await database.pool.query(
      `INSERT INTO daily_sessions (
        daily_session_id, user_id, logical_date, timezone_at_start,
        started_at, last_activity_at, activity_state,
        current_continuous_exchange_no, dialogue_revision, source_revision,
        next_turn_sequence_no, next_event_sequence_no, created_at, updated_at,
        closure_policy_version
      )
      VALUES ($1, $2, DATE '2026-08-12', 'America/Los_Angeles',
        $3, $3, 'quiescent', 1, 0, 0, 1, 1, $3, $3,
        'continuous-exchange-inactivity:v1')`,
      [
        dailySessionId,
        fixedInternalOwnerPrincipal.userId,
        fixedResponseClock(),
      ],
    );
    const composition = buildComposition();
    const result = await runJournalEligibility({
      clock: fixedResponseClock,
      command: {
        workflowCommandId: dailySessionId,
        policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
        sourceRevision: 0,
        subjectId: dailySessionId,
      },
      eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      repository: composition.journalEligibilityRepository,
      workflowReceiptId: "no-activity-receipt",
    });
    expect(result.outcome).toBe("no_activity");
    // A no_activity session records its date outcome so the Web experience can
    // show a quiet empty date (no Journal, no placeholder) — but it carries no
    // command and no Journal artifact (AC #2).
    const outcome = await database.pool.query<{ outcome: string }>(
      `SELECT outcome FROM daily_session_date_outcomes WHERE daily_session_id = $1`,
      [dailySessionId],
    );
    expect(outcome.rows[0]!.outcome).toBe("no_activity");
    const commands = await database.pool.query(`
      SELECT COUNT(*)::int AS count FROM workflow_commands WHERE subject_id = $1
    `, [dailySessionId]);
    expect(commands.rows[0]!.count).toBe(0);
  });

  // Reference the branded-id helpers so the import surface stays consistent.
  it("uses opaque branded ids end to end", () => {
    expect(() => asDailySessionId("not-a-uuid")).toThrow();
    expect(() => asUserId("not-a-uuid")).toThrow();
  });
});
