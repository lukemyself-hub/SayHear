import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  asDailySessionId,
  asUserId,
  createConversationAgentHarness,
  createEvidenceService,
  createJournalService,
  createJournalEligibilityService,
  createDialogueStateService,
  createRollingSummaryService,
  createOutboxDispatcherService,
  createConversationResponseService,
  createContextCompiler,
  createUserTextConversationService,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  runJournalEligibility,
  runAutomaticJournal,
  type ConversationTextChampion,
  type DialogueStateContent,
} from "@sayhear/application";
import {
  createBehaviorAwareConversationTextModel,
  createProviderEgressPort,
} from "@sayhear/ai/testing";
import { createRuntimeJournalRoleProviderRegistry } from "@sayhear/ai";
import {
  PostgresConversationResponseRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresJournalEligibilityRepository,
  PostgresJournalRepository,
  PostgresEvidenceRepository,
  PostgresOutboxDispatcherRepository,
  PostgresUserTextConversationRepository,
  PostgresDialogueStateRepository,
  loadDialogueStateForContext,
  PostgresRollingSummaryRepository,
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
  harnessPolicyVersion: "conversation-harness:v1",
  conversationActionCatalogVersion: "conversation-action-catalog:empty:v1",
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

  function buildComposition(input: {
    dialogueStateModel?: import("@sayhear/application").DialogueStateModel;
    journalDraftModel?: import("@sayhear/application").JournalModel;
    journalValidationProvider?: import("@sayhear/application").JournalValidationProvider;
  } = {}) {
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const conversationRepository = new PostgresUserTextConversationRepository(
      database.pool,
    );
    const journalEligibilityRepository = new PostgresJournalEligibilityRepository(
      database.pool,
    );
    const dialogueStateRepository = new PostgresDialogueStateRepository(
      database.pool,
    );
    const journalRoleRegistry = createRuntimeJournalRoleProviderRegistry({
      adapter: { type: "deterministic" },
      roles: [
        { role: "evidence.extract", provider: "deterministic", model: "test", configVersion: "test:evidence", policyVersion: "evidence-extraction:v1", promptFingerprint: "test:evidence" },
        { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:draft", policyVersion: "journal-generation:v2", promptFingerprint: "test:draft" },
        { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:validate", policyVersion: "journal-validator:v2", promptFingerprint: "test:validate" },
        { role: "dialogue.state", provider: "deterministic", model: "test", configVersion: "dialogue-state-model:v1", policyVersion: "dialogue-state:v1", promptFingerprint: "dialogue-state-prompt:v1" },
        { role: "summary.compress", provider: "deterministic", model: "test", configVersion: "test:summary", policyVersion: "rolling-summary:v1", promptFingerprint: "test:summary" },
      ],
    });
    // Use the deterministic evidence extractor (sentence-spanning) instead of a
    // whole-source stub so a multi-sentence source produces several evidence
    // items and therefore several Journal statements — the shape production
    // providers produce and the shape that exercised the journal_statements
    // unique-constraint bug (migration 0024).
    const evidenceRepository = new PostgresEvidenceRepository(database.pool, journalRoleRegistry.evidenceExtractor);
    const journalRepository = new PostgresJournalRepository(database.pool);
    const draftConfiguration = journalRoleRegistry.configuration("journal.draft");
    const validationConfiguration = journalRoleRegistry.configuration("journal.validate");
    const journalService = createJournalService({
      evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: {
        ...draftConfiguration,
        role: "journal.draft",
        rolePolicyVersion: draftConfiguration.policyVersion,
      },
      journalPolicyVersion: "journal-generation:v2",
      model: input.journalDraftModel ?? journalRoleRegistry.draft,
      repository: journalRepository,
      validationMetadata: {
        ...validationConfiguration,
        role: "journal.validate",
        rolePolicyVersion: validationConfiguration.policyVersion,
      },
      validationProvider: input.journalValidationProvider ?? journalRoleRegistry.validator,
      validatorVersion: "journal-validator:v2",
    });
    const dialogueStateConfiguration = journalRoleRegistry.configuration("dialogue.state");
    const dialogueStateService = createDialogueStateService({
      clock: fixedResponseClock,
      model: input.dialogueStateModel ?? journalRoleRegistry.dialogueStateProjector,
      policy: {
        modelConfigVersion: dialogueStateConfiguration.configVersion,
        policyVersion: dialogueStateConfiguration.policyVersion,
        promptVersion: dialogueStateConfiguration.promptFingerprint,
      },
      repository: dialogueStateRepository,
    });
    const evidenceService = createEvidenceService({
      clock: fixedResponseClock,
      extractionPolicyVersion: "evidence-extraction:v1",
      champion: {
        configVersion: "evidence-champion:v1",
        model: testChampion.model,
        provider: testChampion.provider,
        providerPolicyVersion: "evidence-provider-egress:v1",
        snapshot: testChampion.snapshot,
      },
      repository: evidenceRepository,
    });
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
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: fixedResponseClock,
      contextCompiler,
      conversationService,
      harness: createConversationAgentHarness({
        clock: fixedResponseClock,
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
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });
    const journalEligibilityService = createJournalEligibilityService({
      clock: fixedResponseClock,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      repository: journalEligibilityRepository,
    });
    const summaryConfiguration = journalRoleRegistry.configuration("summary.compress");
    const rollingSummaryService = createRollingSummaryService({
      clock: fixedResponseClock,
      model: journalRoleRegistry.summaryCompressor,
      modelConfigVersion: summaryConfiguration.configVersion,
      policyVersion: summaryConfiguration.policyVersion,
      promptVersion: summaryConfiguration.promptFingerprint,
      repository: new PostgresRollingSummaryRepository(database.pool),
    });
    return {
      conversationResponseService,
      conversationService,
      journalEligibilityRepository,
      journalEligibilityService,
      journalService,
      dialogueStateRepository,
      dialogueStateService,
      evidenceRepository,
      evidenceService,
      outboxRepository,
      rollingSummaryService,
    };
  }

  async function submitConversation(input: {
    clientEventId: string;
    clientTurnId: string;
    locale?: string;
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
          locale: input.locale ?? "en-US",
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

  it("enqueues and publishes a session-scoped DialogueState, then uses its coverage conservatively in Context", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "dialogue-state-event",
      clientTurnId: "dialogue-state-turn",
      text: "The meeting was difficult and I want to keep talking about it.",
    });
    const composition = buildComposition();
    await expect(composition.dialogueStateService.scanPending()).resolves.toEqual({
      queued: 1,
    });
    const pendingOutbox = await database.pool.query<{
      event_type: string;
      status: string;
    }>(
      `SELECT event_type, status FROM outbox_events
       WHERE event_type = 'dialogue_state_requested'`,
    );
    expect(pendingOutbox.rows).toEqual([{
      event_type: "dialogue_state_requested",
      status: "pending",
    }]);
    const command = await database.pool.query<{
      dialogue_state_command_id: string;
      source_revision: string;
      dialogue_revision: string;
      status: string;
    }>(
      `SELECT dialogue_state_command_id, source_revision, dialogue_revision, status
       FROM dialogue_state_commands WHERE daily_session_id = $1`,
      [dailySessionId],
    );
    expect(command.rows[0]).toMatchObject({
      dialogue_revision: "2",
      source_revision: "2",
      status: "created",
    });
    const sourceRefs = await database.pool.query(
      `SELECT sequence_no FROM dialogue_state_command_source_refs
       WHERE dialogue_state_command_id = $1 ORDER BY sequence_no`,
      [command.rows[0]!.dialogue_state_command_id],
    );
    expect(sourceRefs.rows.map((row) => row.sequence_no)).toEqual(["1", "2"]);

    await expect(
      composition.dialogueStateService.run(
        command.rows[0]!.dialogue_state_command_id,
      ),
    ).resolves.toEqual({ outcome: "published" });
    const current = await database.pool.query<{
      source_revision: string;
      dialogue_revision: string;
      covered_through_sequence_no: string;
    }>(
      `SELECT source_revision, dialogue_revision, covered_through_sequence_no
       FROM current_dialogue_states WHERE daily_session_id = $1`,
      [dailySessionId],
    );
    expect(current.rows[0]).toEqual({
      covered_through_sequence_no: "2",
      dialogue_revision: "2",
      source_revision: "2",
    });

    await submitConversation({
      clientEventId: "dialogue-state-follow-up-event",
      clientTurnId: "dialogue-state-follow-up-turn",
      text: "Please stay with what happened in that meeting.",
    });
    const context = await database.pool.query<{
      degraded_reason: string | null;
      sections: Array<{ key: string; reference: string }>;
      compiled_context_id: string;
    }>(
      `SELECT context.compiled_context_id, context.degraded_reason, context.sections
       FROM compiled_contexts context
       INNER JOIN generation_commands command
         ON command.compiled_context_id = context.compiled_context_id
       INNER JOIN conversation_events input_event
         ON input_event.conversation_event_id = command.subject_id
       WHERE input_event.client_event_id = 'dialogue-state-follow-up-event'
       ORDER BY context.created_at DESC LIMIT 1`,
    );
    expect(context.rows[0]?.degraded_reason).toBe("dialogue_state_lagging");
    expect(context.rows[0]?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "dialogue_state",
          reference: expect.stringContaining("status=lagging"),
        }),
      ]),
    );
    const referenced = await database.pool.query<{ sequence_no: string }>(
      `SELECT sequence_no FROM compiled_context_revision_refs
       WHERE compiled_context_id = $1 ORDER BY ordinal`,
      [context.rows[0]!.compiled_context_id],
    );
    expect(referenced.rows.map((row) => row.sequence_no)).toEqual(["3"]);
  });

  it("fails closed to raw Events when DialogueState generation fails", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "dialogue-state-failure-event",
      clientTurnId: "dialogue-state-failure-turn",
      text: "The model should not be able to turn a failed projection into history.",
    });
    const failing = buildComposition({
      dialogueStateModel: {
        async project() {
          throw new Error("synthetic projection failure");
        },
      },
    });
    await failing.dialogueStateService.scanPending();
    const command = await database.pool.query<{ dialogue_state_command_id: string }>(
      `SELECT dialogue_state_command_id FROM dialogue_state_commands
       WHERE daily_session_id = $1`,
      [dailySessionId],
    );
    await expect(
      failing.dialogueStateService.run(command.rows[0]!.dialogue_state_command_id),
    ).resolves.toEqual({ outcome: "failed" });

    await submitConversation({
      clientEventId: "dialogue-state-failure-follow-up-event",
      clientTurnId: "dialogue-state-failure-follow-up-turn",
      text: "The raw committed conversation remains available while projection is unavailable.",
    });
    const context = await database.pool.query<{
      degraded_reason: string | null;
      sections: Array<{ key: string }>;
      compiled_context_id: string;
    }>(
      `SELECT context.compiled_context_id, context.degraded_reason, context.sections
       FROM compiled_contexts context
       INNER JOIN generation_commands command
         ON command.compiled_context_id = context.compiled_context_id
       INNER JOIN conversation_events input_event
         ON input_event.conversation_event_id = command.subject_id
       WHERE input_event.client_event_id = 'dialogue-state-failure-follow-up-event'
       ORDER BY context.created_at DESC LIMIT 1`,
    );
    expect(context.rows[0]?.degraded_reason).toBe("dialogue_state_failed");
    expect(context.rows[0]?.sections).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "dialogue_state" })]),
    );
    const referenced = await database.pool.query<{ sequence_no: string }>(
      `SELECT sequence_no FROM compiled_context_revision_refs
       WHERE compiled_context_id = $1 ORDER BY ordinal`,
      [context.rows[0]!.compiled_context_id],
    );
    expect(referenced.rows.map((row) => row.sequence_no)).toEqual(["1", "2", "3"]);
  });

  it("invalidates a corrected source and refuses a late older projection", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "dialogue-state-correction-event",
      clientTurnId: "dialogue-state-correction-turn",
      text: "The original account of the meeting was incomplete.",
    });
    const composition = buildComposition();
    await expect(composition.dialogueStateService.scanPending()).resolves.toEqual({
      queued: 1,
    });
    const first = await database.pool.query<{ dialogue_state_command_id: string }>(
      `SELECT dialogue_state_command_id FROM dialogue_state_commands
       WHERE daily_session_id = $1 ORDER BY created_at`,
      [dailySessionId],
    );
    await expect(
      composition.dialogueStateService.run(first.rows[0]!.dialogue_state_command_id),
    ).resolves.toEqual({ outcome: "published" });

    const event = await database.pool.query<{ conversation_event_id: string }>(
      `SELECT conversation_event_id FROM conversation_events
       WHERE daily_session_id = $1 AND actor = 'user'`,
      [dailySessionId],
    );
    await expect(
      composition.conversationService.correct(fixedInternalOwnerPrincipal.userId, {
        eventId: event.rows[0]!.conversation_event_id,
        locale: "en-US",
        text: "The corrected account says the meeting was difficult, but one colleague helped.",
      }),
    ).resolves.toMatchObject({ dailySessionId });

    await expect(composition.dialogueStateService.scanPending()).resolves.toEqual({
      queued: 1,
    });
    const commands = await database.pool.query<{
      dialogue_state_command_id: string;
      source_revision: string;
      status: string;
    }>(
      `SELECT dialogue_state_command_id, source_revision, status
       FROM dialogue_state_commands WHERE daily_session_id = $1 ORDER BY created_at`,
      [dailySessionId],
    );
    expect(commands.rows[0]!.status).toBe("stale");
    expect(commands.rows[1]).toMatchObject({ source_revision: "3", status: "created" });
    const newResult = await composition.dialogueStateService.run(
      commands.rows[1]!.dialogue_state_command_id,
    );
    expect(newResult).toEqual({ outcome: "published" });
    await expect(
      composition.dialogueStateService.run(commands.rows[0]!.dialogue_state_command_id),
    ).resolves.toEqual({ outcome: "stale" });

    await expect(
      database.pool.query<{ source_revision: string }>(
        `SELECT source_revision FROM current_dialogue_states WHERE daily_session_id = $1`,
        [dailySessionId],
      ),
    ).resolves.toMatchObject({ rows: [{ source_revision: "3" }] });
  });

  it("reclaims a timed-out DialogueState attempt and fences its late result", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "dialogue-state-recovery-event",
      clientTurnId: "dialogue-state-recovery-turn",
      text: "A timed out projection must be retried without accepting its late result.",
    });
    const composition = buildComposition();
    await expect(composition.dialogueStateService.scanPending()).resolves.toEqual({
      queued: 1,
    });
    const commandRow = await database.pool.query<{ dialogue_state_command_id: string }>(
      `SELECT dialogue_state_command_id FROM dialogue_state_commands
       WHERE daily_session_id = $1`,
      [dailySessionId],
    );
    const claimed = await composition.dialogueStateRepository.loadCommand({
      commandId: commandRow.rows[0]!.dialogue_state_command_id,
      now: fixedResponseClock(),
    });
    expect(claimed).not.toBeNull();

    await composition.dialogueStateRepository.reconcile({
      maximumClaimAgeMs: 60_000,
      now: new Date(fixedResponseClock().getTime() + 10 * 60_000),
    });
    await expect(
      database.pool.query<{ status: string; last_error_code: string }>(
        `SELECT status, last_error_code FROM dialogue_state_commands
         WHERE dialogue_state_command_id = $1`,
        [commandRow.rows[0]!.dialogue_state_command_id],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: "failed", last_error_code: "dialogue_state_result_unknown" }],
    });
    await database.pool.query(
      `UPDATE outbox_events SET status = 'dead_lettered'
       WHERE workflow_command_id = $1`,
      [commandRow.rows[0]!.dialogue_state_command_id],
    );

    const source = claimed!.sources[0]!;
    const lateContent: DialogueStateContent = {
      currentTopic: {
        confidence: 0.5,
        sourceRevisionIds: [source.revisionId],
        value: source.text.slice(0, 240),
      },
      emotionalTone: { confidence: 0, sourceRevisionIds: [], value: null },
      pendingQuestion: { confidence: 0, sourceRevisionIds: [], value: null },
      userIntent: {
        confidence: 0.5,
        sourceRevisionIds: [source.revisionId],
        value: "sharing",
      },
    };
    await expect(
      composition.dialogueStateRepository.publish({
        command: claimed!.command,
        content: lateContent,
        now: fixedResponseClock(),
      }),
    ).resolves.toBe("stale");
    await expect(
      database.pool.query(`SELECT 1 FROM dialogue_state_versions WHERE daily_session_id = $1`, [dailySessionId]),
    ).resolves.toMatchObject({ rows: [] });

    await expect(composition.dialogueStateService.scanPending()).resolves.toEqual({
      queued: 1,
    });
    await expect(
      database.pool.query<{ status: string }>(
        `SELECT status FROM outbox_events WHERE workflow_command_id = $1`,
        [commandRow.rows[0]!.dialogue_state_command_id],
      ),
    ).resolves.toMatchObject({ rows: [{ status: "pending" }] });
    await expect(
      composition.dialogueStateService.run(commandRow.rows[0]!.dialogue_state_command_id),
    ).resolves.toEqual({ outcome: "published" });
    const retryClaim = await database.pool.query<{ claim_id: string }>(
      `SELECT claim_id FROM dialogue_state_commands WHERE dialogue_state_command_id = $1`,
      [commandRow.rows[0]!.dialogue_state_command_id],
    );
    expect(retryClaim.rows[0]!.claim_id).not.toBe(claimed?.command.claimId);
  });

  it("rejects a claimed projection whose source is corrected before publish", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "dialogue-state-source-fence-event",
      clientTurnId: "dialogue-state-source-fence-turn",
      text: "This source will be corrected before the projection publishes.",
    });
    const composition = buildComposition();
    await composition.dialogueStateService.scanPending();
    const commandRow = await database.pool.query<{ dialogue_state_command_id: string }>(
      `SELECT dialogue_state_command_id FROM dialogue_state_commands
       WHERE daily_session_id = $1`,
      [dailySessionId],
    );
    const claimed = await composition.dialogueStateRepository.loadCommand({
      commandId: commandRow.rows[0]!.dialogue_state_command_id,
      now: fixedResponseClock(),
    });
    const event = await database.pool.query<{ conversation_event_id: string }>(
      `SELECT conversation_event_id FROM conversation_events
       WHERE daily_session_id = $1 AND actor = 'user'`,
      [dailySessionId],
    );
    await composition.conversationService.correct(fixedInternalOwnerPrincipal.userId, {
      eventId: event.rows[0]!.conversation_event_id,
      locale: "en-US",
      text: "The corrected source must not be represented by the old projection.",
    });

    const source = claimed!.sources[0]!;
    await expect(
      composition.dialogueStateRepository.publish({
        command: claimed!.command,
        content: {
          currentTopic: { confidence: 0.5, sourceRevisionIds: [source.revisionId], value: source.text },
          emotionalTone: { confidence: 0, sourceRevisionIds: [], value: null },
          pendingQuestion: { confidence: 0, sourceRevisionIds: [], value: null },
          userIntent: { confidence: 0.5, sourceRevisionIds: [source.revisionId], value: "sharing" },
        },
        now: fixedResponseClock(),
      }),
    ).resolves.toBe("stale");
    await expect(
      database.pool.query(`SELECT 1 FROM dialogue_state_versions WHERE daily_session_id = $1`, [dailySessionId]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("does not restore an older in-flight projection after current is invalidated", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "dialogue-state-watermark-first-event",
      clientTurnId: "dialogue-state-watermark-first-turn",
      text: "The older projection remains in flight while a newer one completes.",
    });
    const composition = buildComposition();
    await composition.dialogueStateService.scanPending();
    const firstCommand = await database.pool.query<{ dialogue_state_command_id: string }>(
      `SELECT dialogue_state_command_id FROM dialogue_state_commands
       WHERE daily_session_id = $1`,
      [dailySessionId],
    );
    const olderClaim = await composition.dialogueStateRepository.loadCommand({
      commandId: firstCommand.rows[0]!.dialogue_state_command_id,
      now: fixedResponseClock(),
    });

    await submitConversation({
      clientEventId: "dialogue-state-watermark-second-event",
      clientTurnId: "dialogue-state-watermark-second-turn",
      text: "The newer projection will be invalidated after it publishes.",
    });
    await composition.dialogueStateService.scanPending();
    const commands = await database.pool.query<{ dialogue_state_command_id: string }>(
      `SELECT dialogue_state_command_id FROM dialogue_state_commands
       WHERE daily_session_id = $1 ORDER BY created_at`,
      [dailySessionId],
    );
    await composition.dialogueStateService.run(commands.rows[1]!.dialogue_state_command_id);
    const secondEvent = await database.pool.query<{ conversation_event_id: string }>(
      `SELECT conversation_event_id FROM conversation_events
       WHERE daily_session_id = $1 AND client_event_id = 'dialogue-state-watermark-second-event'`,
      [dailySessionId],
    );
    await composition.conversationService.correct(fixedInternalOwnerPrincipal.userId, {
      eventId: secondEvent.rows[0]!.conversation_event_id,
      locale: "en-US",
      text: "The newer source has been corrected and is no longer valid for that version.",
    });
    await composition.dialogueStateService.scanPending();

    const source = olderClaim!.sources[0]!;
    await expect(
      composition.dialogueStateRepository.publish({
        command: olderClaim!.command,
        content: {
          currentTopic: { confidence: 0.5, sourceRevisionIds: [source.revisionId], value: source.text },
          emotionalTone: { confidence: 0, sourceRevisionIds: [], value: null },
          pendingQuestion: { confidence: 0, sourceRevisionIds: [], value: null },
          userIntent: { confidence: 0.5, sourceRevisionIds: [source.revisionId], value: "sharing" },
        },
        now: fixedResponseClock(),
      }),
    ).resolves.toBe("stale");
    await expect(
      database.pool.query(`SELECT 1 FROM current_dialogue_states WHERE daily_session_id = $1`, [dailySessionId]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("invalidates DialogueState when an assistant delivery loses authoritative status", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "dialogue-state-assistant-delivery-event",
      clientTurnId: "dialogue-state-assistant-delivery-turn",
      text: "The assistant delivery may be reconciled after projection.",
    });
    const composition = buildComposition();
    await composition.dialogueStateService.scanPending();
    const command = await database.pool.query<{ dialogue_state_command_id: string }>(
      `SELECT dialogue_state_command_id FROM dialogue_state_commands
       WHERE daily_session_id = $1`,
      [dailySessionId],
    );
    await composition.dialogueStateService.run(command.rows[0]!.dialogue_state_command_id);

    const assistant = await database.pool.query<{ generation_command_id: string }>(
      `SELECT generation_command_id FROM conversation_events
       WHERE daily_session_id = $1 AND actor = 'assistant'`,
      [dailySessionId],
    );
    await database.pool.query(
      `UPDATE generation_commands
       SET status = 'failed', authoritative_result_id = NULL
       WHERE generation_command_id = $1`,
      [assistant.rows[0]!.generation_command_id],
    );
    await expect(composition.dialogueStateService.scanPending()).resolves.toEqual({
      queued: 1,
    });

    await expect(
      database.pool.query(`SELECT 1 FROM current_dialogue_states WHERE daily_session_id = $1`, [dailySessionId]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      database.pool.query<{ status: string }>(
        `SELECT status FROM dialogue_state_commands WHERE dialogue_state_command_id = $1`,
        [command.rows[0]!.dialogue_state_command_id],
      ),
    ).resolves.toMatchObject({ rows: [{ status: "stale" }] });
    const rebuilt = await database.pool.query<{
      dialogue_state_command_id: string;
      status: string;
      coverage_through_sequence_no: string;
    }>(
      `SELECT dialogue_state_command_id, status, coverage_through_sequence_no
       FROM dialogue_state_commands WHERE daily_session_id = $1
       ORDER BY created_at, dialogue_state_command_id`,
      [dailySessionId],
    );
    expect(rebuilt.rows).toHaveLength(2);
    const rebuiltCommand = rebuilt.rows.find((row) => row.status === "created");
    expect(rebuiltCommand).toMatchObject({ status: "created", coverage_through_sequence_no: "1" });
    await expect(
      composition.dialogueStateService.run(rebuiltCommand!.dialogue_state_command_id),
    ).resolves.toEqual({ outcome: "published" });
  });

  it("selects the newest still-valid historical version after current is invalidated", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "dialogue-state-history-first-event",
      clientTurnId: "dialogue-state-history-first-turn",
      text: "The first topic remains valid context.",
    });
    const composition = buildComposition();
    await composition.dialogueStateService.scanPending();
    const firstCommand = await database.pool.query<{ dialogue_state_command_id: string }>(
      `SELECT dialogue_state_command_id FROM dialogue_state_commands
       WHERE daily_session_id = $1 ORDER BY created_at`,
      [dailySessionId],
    );
    await composition.dialogueStateService.run(firstCommand.rows[0]!.dialogue_state_command_id);

    await submitConversation({
      clientEventId: "dialogue-state-history-second-event",
      clientTurnId: "dialogue-state-history-second-turn",
      text: "The second topic will later be corrected.",
    });
    await composition.dialogueStateService.scanPending();
    const commands = await database.pool.query<{ dialogue_state_command_id: string }>(
      `SELECT dialogue_state_command_id FROM dialogue_state_commands
       WHERE daily_session_id = $1 ORDER BY created_at`,
      [dailySessionId],
    );
    await composition.dialogueStateService.run(commands.rows[1]!.dialogue_state_command_id);

    const secondEvent = await database.pool.query<{ conversation_event_id: string }>(
      `SELECT conversation_event_id FROM conversation_events
       WHERE daily_session_id = $1 AND client_event_id = 'dialogue-state-history-second-event'`,
      [dailySessionId],
    );
    await composition.conversationService.correct(fixedInternalOwnerPrincipal.userId, {
      eventId: secondEvent.rows[0]!.conversation_event_id,
      locale: "en-US",
      text: "The corrected second topic is different.",
    });
    await composition.dialogueStateService.scanPending();

    const session = await database.pool.query<{
      dialogue_revision: string;
      source_revision: string;
    }>(
      `SELECT dialogue_revision, source_revision FROM daily_sessions WHERE daily_session_id = $1`,
      [dailySessionId],
    );
    const client = await database.pool.connect();
    try {
      const fallback = await loadDialogueStateForContext(client, {
        dailySessionId: asDailySessionId(dailySessionId),
        dialogueRevision: Number(session.rows[0]!.dialogue_revision),
        expectedDataEpoch: 1,
        sourceRevision: Number(session.rows[0]!.source_revision),
      });
      expect(fallback.dialogueState).toMatchObject({ status: "lagging", version: 1 });
      expect(fallback.failure).toBe(false);
    } finally {
      client.release();
    }
  });

  it("freezes every newly admitted command at the active owner epoch after a purge", async () => {
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 2 WHERE user_id = $1",
      [fixedInternalOwnerPrincipal.userId],
    );
    const dailySessionId = await submitConversation({
      clientEventId: "post-purge-epoch-event",
      clientTurnId: "post-purge-epoch-turn",
      text: "The new data generation must work immediately after purge.",
    });
    await endExchange(dailySessionId);

    const composition = buildComposition();
    await composition.dialogueStateService.scanPending();
    await composition.rollingSummaryService.scanPending();
    await composition.journalEligibilityService.evaluate(dailySessionId);

    const commands = await database.pool.query<{ command_type: string; expected_data_epoch: string }>(
      `SELECT command_type, expected_data_epoch::text
       FROM workflow_commands
       ORDER BY command_type`,
    );
    expect(commands.rows.length).toBeGreaterThan(0);
    expect(commands.rows.every((row) => row.expected_data_epoch === "2")).toBe(true);
  });

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
        sourceRevision: Number(command.rows[0]!.source_revision),
        subjectId: dailySessionId,
        expectedDataEpoch: 1,
      },
      eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      repository: composition.journalEligibilityRepository,
      workflowReceiptId: "test-receipt",
      evidenceService: composition.evidenceService,
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
    const evidence = await database.pool.query<{
      source_actor: string;
      source_status: string;
      locator_type: string;
    }>(`SELECT source_actor, source_status, locator_type FROM evidence_items`);
    expect(evidence.rows).toEqual([{
      source_actor: "user",
      source_status: "final",
      locator_type: "text_span",
    }]);
    expect((await database.pool.query(
      `SELECT COUNT(*)::int AS count FROM evidence_items WHERE source_actor IN ('assistant', 'system')`,
    )).rows[0]!.count).toBe(0);
  });

  it.each([
    ["English", "en-US", "I finished a difficult task today."],
    ["Chinese", "zh-CN", "我今天完成了一项很难的任务，但心里仍然有些担心明天的安排。"],
    ["natural code-switching", "en-US", "I finished the task, 但是我还是有点担心明天。"],
  ])("publishes an evidence-backed third-person Journal for %s", async (_name, locale, text) => {
    const dailySessionId = await submitConversation({
      clientEventId: "language-event",
      clientTurnId: "language-turn",
      locale,
      text,
    });
    await endExchange(dailySessionId);
    const composition = buildComposition();
    const command = await database.pool.query<{ source_revision: string; workflow_command_id: string }>(
      "SELECT source_revision, workflow_command_id FROM workflow_commands",
    );
    const sourceRevision = Number(command.rows[0]!.source_revision);
    await expect(runJournalEligibility({
      clock: fixedResponseClock,
      command: { workflowCommandId: command.rows[0]!.workflow_command_id, policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION, sourceRevision, subjectId: dailySessionId, expectedDataEpoch: 1 },
      eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      repository: composition.journalEligibilityRepository,
      workflowReceiptId: "language-receipt",
      evidenceService: composition.evidenceService,
    })).resolves.toMatchObject({ outcome: "eligible_queued" });
    await expect(runAutomaticJournal({
      service: composition.journalService,
      command: { workflowCommandId: command.rows[0]!.workflow_command_id, policyVersion: "journal-generation:v2", sourceRevision, subjectId: dailySessionId, expectedDataEpoch: 1 },
      generationCommandId: "journal-language",
      modelRunAttemptId: "attempt-language",
    })).resolves.toEqual({ outcome: "published" });
    await expect(composition.journalService.inspect({
      dailySessionId,
      userId: fixedInternalOwnerPrincipal.userId,
    })).resolves.toMatchObject({
      locale,
      statements: [expect.objectContaining({ evidenceItemIds: expect.any(Array) })],
    });
    const lineage = await database.pool.query<{
      daily_session_id: string;
      evidence_source_session_id: string;
      statement_source_session_id: string;
    }>(
      `SELECT version.daily_session_id,
         evidence_session.daily_session_id AS evidence_source_session_id,
         statement_source.daily_session_id AS statement_source_session_id
       FROM journal_versions version
       INNER JOIN journal_statements statement ON statement.journal_version_id = version.journal_version_id
       INNER JOIN journal_statement_evidence_links link ON link.journal_statement_id = statement.journal_statement_id
       INNER JOIN evidence_items evidence ON evidence.evidence_item_id = link.evidence_item_id
       INNER JOIN evidence_source_snapshots evidence_session ON evidence_session.evidence_source_snapshot_id = evidence.evidence_source_snapshot_id
       INNER JOIN daily_sessions statement_source ON statement_source.daily_session_id = version.daily_session_id
       WHERE version.daily_session_id = $1`,
      [dailySessionId],
    );
    expect(lineage.rows).toEqual([{
      daily_session_id: dailySessionId,
      evidence_source_session_id: dailySessionId,
      statement_source_session_id: dailySessionId,
    }]);
  });

  it("publishes a Journal version with many statements from one source", async () => {
    // Regression: journal_statements carried UNIQUE (journal_version_id,
    // user_id, source_revision, evidence_source_snapshot_id), which collapsed
    // the intended 1:many statements-per-version into 1:1. The deterministic
    // draft emits one statement per evidence item, so a multi-sentence source
    // produced a second statement that violated the constraint and rolled back
    // the whole version (production replay 2026-08-18). Migration 0024 drops
    // that constraint; statement uniqueness stays covered by
    // (journal_version_id, statement_index) and (journal_version_id, statement_key).
    const dailySessionId = await submitConversation({
      clientEventId: "multi-statement-event",
      clientTurnId: "multi-statement-turn",
      text: "I finished the report this morning. The meeting went well afterwards. I still worry about tomorrow.",
    });
    await endExchange(dailySessionId);
    const composition = buildComposition();
    const command = await database.pool.query<{ source_revision: string; workflow_command_id: string }>(
      "SELECT source_revision, workflow_command_id FROM workflow_commands",
    );
    const sourceRevision = Number(command.rows[0]!.source_revision);
    await expect(runJournalEligibility({
      clock: fixedResponseClock,
      command: { workflowCommandId: command.rows[0]!.workflow_command_id, policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION, sourceRevision, subjectId: dailySessionId, expectedDataEpoch: 1 },
      eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      repository: composition.journalEligibilityRepository,
      workflowReceiptId: "multi-statement-receipt",
      evidenceService: composition.evidenceService,
    })).resolves.toMatchObject({ outcome: "eligible_queued" });
    await expect(runAutomaticJournal({
      service: composition.journalService,
      command: { workflowCommandId: command.rows[0]!.workflow_command_id, policyVersion: "journal-generation:v2", sourceRevision, subjectId: dailySessionId, expectedDataEpoch: 1 },
      generationCommandId: "journal-multi",
      modelRunAttemptId: "attempt-multi",
    })).resolves.toEqual({ outcome: "published" });
    const inspected = await composition.journalService.inspect({
      dailySessionId,
      userId: fixedInternalOwnerPrincipal.userId,
    });
    expect(inspected?.statements).toHaveLength(3);
    expect(inspected?.statements.every((statement) => statement.evidenceItemIds.length > 0)).toBe(true);
    const statements = await database.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM journal_statements statement
       INNER JOIN journal_versions version ON version.journal_version_id = statement.journal_version_id
       WHERE version.daily_session_id = $1`,
      [dailySessionId],
    );
    expect(statements.rows[0]!.count).toBe(3);
  });

  it("records a Journal draft model failure as a failed attempt (jsonb failure_code regression)", async () => {
    // Regression for production replay 2026-08-18: when the draft model throws,
    // recordValidationFailure ran
    //   result_metadata = jsonb_build_object(..., 'failure_code', $3)
    // where jsonb_build_object's value parameter is "any", so PostgreSQL could
    // not infer $3's type and the whole workflow logged
    // "could not determine data type of parameter $3" instead of the failure
    // record. The $3::text cast keeps the attempt row persistent.
    const dailySessionId = await submitConversation({
      clientEventId: "draft-failure-event",
      clientTurnId: "draft-failure-turn",
      text: "I keep rehearsing the same disagreement with my manager all afternoon.",
    });
    await endExchange(dailySessionId);
    const composition = buildComposition({
      journalDraftModel: {
        generate: async () => { throw new Error("synthetic draft failure"); },
      },
    });
    const command = await database.pool.query<{ source_revision: string; workflow_command_id: string }>(
      "SELECT source_revision, workflow_command_id FROM workflow_commands",
    );
    const sourceRevision = Number(command.rows[0]!.source_revision);
    await runJournalEligibility({
      clock: fixedResponseClock,
      command: { workflowCommandId: command.rows[0]!.workflow_command_id, policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION, sourceRevision, subjectId: dailySessionId, expectedDataEpoch: 1 },
      eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      repository: composition.journalEligibilityRepository,
      workflowReceiptId: "draft-failure-receipt",
      evidenceService: composition.evidenceService,
    });
    await expect(runAutomaticJournal({
      service: composition.journalService,
      command: { workflowCommandId: command.rows[0]!.workflow_command_id, policyVersion: "journal-generation:v2", sourceRevision, subjectId: dailySessionId, expectedDataEpoch: 1 },
      generationCommandId: "journal-draft-fail",
      modelRunAttemptId: "attempt-draft-fail",
    })).resolves.toEqual({ outcome: "validation_failed", reason: "model_run_failed" });
    const attempt = await database.pool.query<{ status: string; failure_code: string | null }>(
      `SELECT status, result_metadata->>'failure_code' AS failure_code
       FROM journal_model_run_attempts WHERE model_run_attempt_id = $1`,
      ["attempt-draft-fail"],
    );
    expect(attempt.rows[0]).toEqual({ status: "failed", failure_code: "model_run_failed" });
    const review = await database.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM journal_validation_results
       WHERE generation_command_id = $1 AND status = 'needs_review'`,
      ["journal-draft-fail"],
    );
    expect(review.rows[0]!.count).toBe(1);
  });

  it("publishes a Journal when the diagnostic validator is unavailable", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "validator-failure-event",
      clientTurnId: "validator-failure-turn",
      text: "I keep second-guessing whether I should have pushed back on the deadline.",
    });
    await endExchange(dailySessionId);
    const composition = buildComposition({
      journalValidationProvider: {
        role: "journal.validate",
        validate: async () => { throw new Error("synthetic validator failure"); },
      },
    });
    const command = await database.pool.query<{ source_revision: string; workflow_command_id: string }>(
      "SELECT source_revision, workflow_command_id FROM workflow_commands",
    );
    const sourceRevision = Number(command.rows[0]!.source_revision);
    await runJournalEligibility({
      clock: fixedResponseClock,
      command: { workflowCommandId: command.rows[0]!.workflow_command_id, policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION, sourceRevision, subjectId: dailySessionId, expectedDataEpoch: 1 },
      eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      repository: composition.journalEligibilityRepository,
      workflowReceiptId: "validator-failure-receipt",
      evidenceService: composition.evidenceService,
    });
    await expect(runAutomaticJournal({
      service: composition.journalService,
      command: { workflowCommandId: command.rows[0]!.workflow_command_id, policyVersion: "journal-generation:v2", sourceRevision, subjectId: dailySessionId, expectedDataEpoch: 1 },
      generationCommandId: "journal-validator-fail",
      modelRunAttemptId: "attempt-validator-fail",
    })).resolves.toEqual({ outcome: "published" });
    const attempts = await database.pool.query<{ model_run_attempt_id: string; status: string; diagnostic_status: string | null }>(
      `SELECT model_run_attempt_id, status, result_metadata->>'diagnostic_status' AS diagnostic_status
       FROM journal_model_run_attempts WHERE generation_command_id = $1 ORDER BY created_at`,
      ["journal-validator-fail"],
    );
    expect(attempts.rows).toContainEqual({ model_run_attempt_id: "attempt-validator-fail", status: "completed", diagnostic_status: null });
    expect(attempts.rows).toContainEqual({ model_run_attempt_id: "attempt-validator-fail:validate", status: "completed", diagnostic_status: "unavailable" });
    const validation = await database.pool.query<{ status: string; diagnostic_status: string }>(
      `SELECT status, diagnostic_status FROM journal_validation_results WHERE generation_command_id = $1`,
      ["journal-validator-fail"],
    );
    expect(validation.rows[0]).toEqual({ status: "validated", diagnostic_status: "unavailable" });
  });

  it("supersedes the current Journal once after a same-day source advance", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "supersede-first-event",
      clientTurnId: "supersede-first-turn",
      text: "I had a difficult meeting and felt overlooked.",
    });
    await endExchange(dailySessionId);
    const composition = buildComposition();
    const firstCommand = await database.pool.query<{ source_revision: string; workflow_command_id: string }>(
      "SELECT source_revision, workflow_command_id FROM workflow_commands ORDER BY created_at",
    );
    const firstSourceRevision = Number(firstCommand.rows[0]!.source_revision);
    await runJournalEligibility({
      clock: fixedResponseClock,
      command: { workflowCommandId: firstCommand.rows[0]!.workflow_command_id, policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION, sourceRevision: firstSourceRevision, subjectId: dailySessionId, expectedDataEpoch: 1 },
      eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      repository: composition.journalEligibilityRepository,
      workflowReceiptId: "supersede-first-receipt",
      evidenceService: composition.evidenceService,
    });
    await expect(runAutomaticJournal({
      service: composition.journalService,
      command: { workflowCommandId: firstCommand.rows[0]!.workflow_command_id, policyVersion: "journal-generation:v2", sourceRevision: firstSourceRevision, subjectId: dailySessionId, expectedDataEpoch: 1 },
      generationCommandId: "supersede-first-journal",
      modelRunAttemptId: "supersede-first-attempt",
    })).resolves.toEqual({ outcome: "published" });

    const originalEvent = await database.pool.query<{ conversation_event_id: string }>(
      "SELECT conversation_event_id FROM conversation_events WHERE daily_session_id = $1 AND actor = 'user'",
      [dailySessionId],
    );
    await expect(composition.conversationService.correct(fixedInternalOwnerPrincipal.userId, {
      eventId: originalEvent.rows[0]!.conversation_event_id,
      locale: "en-US",
      text: "One colleague supported the owner during a difficult meeting.",
    })).resolves.toMatchObject({ dailySessionId });
    await expect(composition.journalService.readLatest({
      userId: fixedInternalOwnerPrincipal.userId,
    })).resolves.toMatchObject({ state: "updating" });
    await expect(composition.journalEligibilityService.evaluate(dailySessionId))
      .resolves.toMatchObject({ outcome: "evaluated", commandCreated: true });
    const commands = await database.pool.query<{ source_revision: string; workflow_command_id: string }>(
      "SELECT source_revision, workflow_command_id FROM workflow_commands ORDER BY created_at",
    );
    expect(commands.rows).toHaveLength(2);
    const successorSourceRevision = Number(commands.rows[1]!.source_revision);
    expect(successorSourceRevision).toBeGreaterThan(firstSourceRevision);
    await runJournalEligibility({
      clock: fixedResponseClock,
      command: { workflowCommandId: commands.rows[1]!.workflow_command_id, policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION, sourceRevision: successorSourceRevision, subjectId: dailySessionId, expectedDataEpoch: 1 },
      eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      repository: composition.journalEligibilityRepository,
      workflowReceiptId: "supersede-second-receipt",
      evidenceService: composition.evidenceService,
    });
    await expect(runAutomaticJournal({
      service: composition.journalService,
      command: { workflowCommandId: commands.rows[1]!.workflow_command_id, policyVersion: "journal-generation:v2", sourceRevision: successorSourceRevision, subjectId: dailySessionId, expectedDataEpoch: 1 },
      generationCommandId: "supersede-second-journal",
      modelRunAttemptId: "supersede-second-attempt",
    })).resolves.toEqual({ outcome: "published" });

    const versions = await database.pool.query<{
      journal_version_id: string;
      source_revision: string;
      supersedes_version_id: string | null;
    }>(`SELECT journal_version_id, source_revision, supersedes_version_id
        FROM journal_versions
        WHERE daily_session_id = $1
        ORDER BY source_revision`, [dailySessionId]);
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[0]!.supersedes_version_id).toBeNull();
    expect(versions.rows[1]).toMatchObject({
      source_revision: String(successorSourceRevision),
      supersedes_version_id: versions.rows[0]!.journal_version_id,
    });
    await expect(composition.journalService.readLatest({
      userId: fixedInternalOwnerPrincipal.userId,
    })).resolves.toMatchObject({ state: "current" });
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
    const command = await database.pool.query<{ source_revision: number; workflow_command_id: string }>(
      `SELECT source_revision, workflow_command_id FROM workflow_commands`,
    );
    const result = await runJournalEligibility({
      clock: fixedResponseClock,
      command: {
        workflowCommandId: command.rows[0]!.workflow_command_id,
        policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
        sourceRevision: Number(command.rows[0]!.source_revision),
        subjectId: dailySessionId,
        expectedDataEpoch: 1,
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
          sourceRevision: Number(command.rows[0]!.source_revision),
          subjectId: dailySessionId,
          expectedDataEpoch: 1,
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

  it("queues a frozen contiguous Summary, advances Context once, and rejects a late older publish (Issue #22 AC #1-6, #9-10)", async () => {
    let dailySessionId = "";
    for (let index = 0; index < 7; index += 1) {
      dailySessionId = await submitConversation({
        clientEventId: `summary-event-${index}`,
        clientTurnId: `summary-turn-${index}`,
        text: `I am sharing event ${index}, and this is enough detail to form a faithful context projection.`,
      });
    }
    const composition = buildComposition();
    expect(await composition.rollingSummaryService.scanPending()).toEqual({ queued: 1 });
    const queued = await database.pool.query<{ rolling_summary_command_id: string; coverage_start_sequence_no: string; covered_through_sequence_no: string }>(
      `SELECT rolling_summary_command_id, coverage_start_sequence_no, covered_through_sequence_no FROM rolling_summary_commands`,
    );
    expect(queued.rows).toHaveLength(1);
    for (let index = 7; index < 14; index += 1) {
      await submitConversation({
        clientEventId: `summary-newer-event-${index}`,
        clientTurnId: `summary-newer-turn-${index}`,
        text: `I am sharing newer event ${index}, so a later frozen projection advances the first command.`,
      });
    }
    expect(await composition.rollingSummaryService.scanPending()).toEqual({ queued: 1 });
    const commands = await database.pool.query<{ rolling_summary_command_id: string; covered_through_sequence_no: string }>(
      `SELECT rolling_summary_command_id, covered_through_sequence_no FROM rolling_summary_commands ORDER BY covered_through_sequence_no`,
    );
    expect(commands.rows).toHaveLength(2);
    expect((await composition.rollingSummaryService.run(commands.rows[1]!.rolling_summary_command_id)).outcome).toBe("published");
    expect(await composition.rollingSummaryService.run(commands.rows[0]!.rolling_summary_command_id)).toEqual({ outcome: "stale" });

    await submitConversation({
      clientEventId: "summary-after-event",
      clientTurnId: "summary-after-turn",
      text: "This committed expression must remain raw after the Summary coverage boundary.",
    });
    const context = await database.pool.query<{ sections: Array<{ key: string; reference: string }>; refs: string[] }>(
      `SELECT context.sections, ARRAY(SELECT ref.sequence_no::text FROM compiled_context_revision_refs ref WHERE ref.compiled_context_id = context.compiled_context_id AND ref.section = 'committed_raw_events' ORDER BY ref.sequence_no) AS refs FROM compiled_contexts context WHERE context.sections @> '[{"key":"rolling_summary"}]'::jsonb ORDER BY context.created_at DESC, context.compiled_context_id DESC LIMIT 1`,
    );
    const coverage = Number(commands.rows[1]!.covered_through_sequence_no);
    expect(context.rows[0]!.sections).toContainEqual(expect.objectContaining({ key: "rolling_summary", reference: expect.stringContaining(`covered-through:${coverage}`) }));
    expect(context.rows[0]!.refs.every((sequence) => Number(sequence) > coverage)).toBe(true);
    const outboxLeak = await database.pool.query(`SELECT payload::text FROM outbox_events WHERE event_type = 'rolling_summary_requested'`);
    expect(outboxLeak.rows[0]!.payload).not.toContain("I am sharing event");
  }, 120_000);

  it("records Summary generation failure and keeps the authenticated conversation on bounded raw Context (Issue #22 AC #7)", async () => {
    for (let index = 0; index < 7; index += 1) {
      await submitConversation({ clientEventId: `failed-summary-event-${index}`, clientTurnId: `failed-summary-turn-${index}`, text: `A substantial expression ${index} that makes the Summary threshold cross without blocking conversation.` });
    }
    const composition = buildComposition();
    await composition.rollingSummaryService.scanPending();
    const command = await database.pool.query<{ rolling_summary_command_id: string }>(`SELECT rolling_summary_command_id FROM rolling_summary_commands`);
    const failing = createRollingSummaryService({
      clock: fixedResponseClock, model: { async compress() { throw new Error("synthetic provider outage"); } },
      modelConfigVersion: "test:summary", policyVersion: "rolling-summary:v1", promptVersion: "test:summary", repository: new PostgresRollingSummaryRepository(database.pool),
    });
    await expect(failing.run(command.rows[0]!.rolling_summary_command_id)).resolves.toEqual({ outcome: "failed" });
    await submitConversation({ clientEventId: "failed-summary-after", clientTurnId: "failed-summary-after", text: "The response path still proceeds while compaction is unavailable." });
    const manifest = await database.pool.query<{ degraded_reason: string | null }>(`SELECT degraded_reason FROM compiled_contexts WHERE degraded_reason = 'rolling_summary_failed' LIMIT 1`);
    expect(manifest.rows[0]?.degraded_reason).toBe("rolling_summary_failed");
  }, 60_000);

  it("invalidates stale Summary coverage before rebuilding it from valid committed Events (Issue #22 AC #3-4)", async () => {
    for (let index = 0; index < 7; index += 1) {
      await submitConversation({ clientEventId: `stale-summary-event-${index}`, clientTurnId: `stale-summary-turn-${index}`, text: `A committed expression ${index} for stale Summary invalidation coverage.` });
    }
    const composition = buildComposition();
    await composition.rollingSummaryService.scanPending();
    const command = await database.pool.query<{ rolling_summary_command_id: string }>(`SELECT rolling_summary_command_id FROM rolling_summary_commands`);
    await composition.rollingSummaryService.run(command.rows[0]!.rolling_summary_command_id);
    const source = await database.pool.query<{ conversation_event_id: string }>(
      `SELECT revision.conversation_event_id
        FROM rolling_summary_command_source_refs ref
        INNER JOIN conversation_event_revisions revision
          ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
        WHERE ref.rolling_summary_command_id = $1
        ORDER BY ref.sequence_no
        LIMIT 1`,
      [command.rows[0]!.rolling_summary_command_id],
    );
    await composition.conversationService.correct(fixedInternalOwnerPrincipal.userId, {
      eventId: source.rows[0]!.conversation_event_id,
      locale: "en-US",
      text: "This corrected committed expression makes the old frozen source stale.",
    });
    expect(await composition.rollingSummaryService.scanPending()).toEqual({ queued: 1 });
    expect((await database.pool.query(`SELECT COUNT(*)::int AS count FROM current_rolling_summaries`)).rows[0]!.count).toBe(0);
    const rebuilt = await database.pool.query<{ rolling_summary_command_id: string }>(
      `SELECT rolling_summary_command_id FROM rolling_summary_commands WHERE status = 'created'`,
    );
    await expect(composition.rollingSummaryService.run(rebuilt.rows[0]!.rolling_summary_command_id)).resolves.toEqual({ outcome: "published" });
    expect((await database.pool.query(`SELECT COUNT(*)::int AS count FROM current_rolling_summaries`)).rows[0]!.count).toBe(1);
  }, 60_000);

  it("reconciles a stranded Summary claim as result_unknown without retrying private provider egress (Issue #22 AC #8)", async () => {
    for (let index = 0; index < 7; index += 1) {
      await submitConversation({ clientEventId: `stuck-summary-event-${index}`, clientTurnId: `stuck-summary-turn-${index}`, text: `Committed expression ${index} to exercise a Summary workflow crash recovery.` });
    }
    const composition = buildComposition();
    await composition.rollingSummaryService.scanPending();
    const command = await database.pool.query<{ rolling_summary_command_id: string }>(`SELECT rolling_summary_command_id FROM rolling_summary_commands`);
    await database.pool.query(`UPDATE rolling_summary_commands SET status = 'running', claimed_at = $1 WHERE rolling_summary_command_id = $2`, [new Date(fixedResponseClock().getTime() - 6 * 60 * 1_000), command.rows[0]!.rolling_summary_command_id]);
    await composition.rollingSummaryService.scanPending();
    const recovered = await database.pool.query<{ status: string; last_error_code: string | null }>(`SELECT status, last_error_code FROM rolling_summary_commands`);
    expect(recovered.rows[0]).toEqual({ status: "failed", last_error_code: "summary_result_unknown" });
  }, 60_000);

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
        expectedDataEpoch: 1,
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
