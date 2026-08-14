import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
  createContextCompiler,
  createConversationActionGateway,
  createJournalService,
  createJournalRegenerationActionHandler,
  createUserTextConversationService,
  runJournalRegenerationWorkflow,
} from "@sayhear/application";
import {
  PostgresConversationActionRepository,
  PostgresConversationResponseRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresJournalRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const now = new Date();
const policy = Object.freeze({
  consentPolicyVersion: null,
  freshnessPolicy: "source_valid:v1" as const,
  chineseLocalePackVersion: "locale-pack-zh:v1",
  englishLocalePackVersion: "locale-pack-en:v1",
  harnessPolicyVersion: ACTION_ENABLED_CONVERSATION_HARNESS_POLICY.version,
  conversationActionCatalogVersion:
    JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
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

describe("Journal regeneration Action admission system seam", () => {
  let database: IsolatedPostgresSchema;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(database.pool).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "action-test-owner",
      userId: fixedInternalOwnerPrincipal.userId,
    });
  }, 20_000);

  beforeEach(async () => {
    await database.pool.query(`
      TRUNCATE TABLE
        conversation_action_payloads,
        conversation_action_receipts,
        conversation_action_executions,
        conversation_action_handles,
        current_rolling_summaries,
        rolling_summary_versions,
        rolling_summary_command_source_refs,
        rolling_summary_commands,
        journal_statement_evidence_links,
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
    await database.pool.query("UPDATE app_users SET status = 'active', data_epoch = 1");
    await new PostgresInternalOwnerAccessRepository(database.pool).recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: "sha256:expected",
      databaseRetentionDays: 30,
      evidenceReference: "synthetic backup evidence",
      policyVersion: "neon-production-v1",
      pitrRetentionDays: 7,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2026-08-27T00:00:00.000Z"),
      verifiedAt: new Date("2026-08-13T00:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  it("atomically admits once, creates one pending Journal command/outbox, and clears recovery payload", async () => {
    const conversationService = createUserTextConversationService({
      clock: () => now,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: policy,
      inactivityPolicy: {
        timeoutMs: 1_800_000,
        version: "continuous-exchange-inactivity:v1",
      },
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const turn = await conversationService.submit(fixedInternalOwnerPrincipal.userId, {
      clientEventId: "action-event-1",
      clientTurnId: "action-turn-1",
      locale: "en-US",
      text: "The Journal should reflect this day more clearly.",
      timezone: "America/Los_Angeles",
    });
    const journalGenerationCommandId = "01984477-31e1-7595-92c6-06889cb0fdde";
    const journalAttemptId = "01984477-31e1-7595-92c6-06889cb0fdff";
    const snapshotId = "01984477-31e1-7595-92c6-06889cb0fe00";
    const journalId = "01984477-31e1-7595-92c6-06889cb0fe01";
    const versionId = "01984477-31e1-7595-92c6-06889cb0fe02";
    await database.pool.query(
      `INSERT INTO evidence_source_snapshots (
        evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
        extraction_policy_version, command_id, attempt_id, champion_config_version,
        champion_provider, champion_model, champion_snapshot,
        champion_provider_policy_version, created_at
      ) VALUES ($1, $2, $3, 1, 'evidence-extraction:v2', 'seed', 'seed',
        'test', 'openai', 'test', 'test', 'test', $4)`,
      [snapshotId, fixedInternalOwnerPrincipal.userId, turn.dailySession.id, now],
    );
    await database.pool.query(
      `INSERT INTO journal_generation_commands (
        generation_command_id, user_id, daily_session_id, source_revision,
        generation_policy_version, expected_data_epoch, created_at
      ) VALUES ($1, $2, $3, 1, 'journal-generation:v2', 1, $4)`,
      [journalGenerationCommandId, fixedInternalOwnerPrincipal.userId, turn.dailySession.id, now],
    );
    const evidenceItemId = "01984477-31e1-7595-92c6-06889cb0fe03";
    await database.pool.query(
      `INSERT INTO evidence_items (
        evidence_item_id, user_id, evidence_source_snapshot_id,
        source_event_id, source_revision_id, source_actor, source_status,
        locator_type, locator_key, extraction_policy_version, evidence_role,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision',
        $6, 'evidence-extraction:v2', 'factual_support', $7)`,
      [evidenceItemId, fixedInternalOwnerPrincipal.userId, snapshotId, turn.message.id, turn.message.revisionId, `revision:${turn.message.revisionId}`, now],
    );
    await database.pool.query(
      `INSERT INTO journal_model_run_attempts (
        model_run_attempt_id, generation_command_id, status, created_at
      ) VALUES ($1, $2, 'completed', $3)`,
      [journalAttemptId, journalGenerationCommandId, now],
    );
    await database.pool.query(
      `INSERT INTO journals (journal_id, user_id, daily_session_id, current_version_id, created_at)
       VALUES ($1, $2, $3, NULL, $4)`,
      [journalId, fixedInternalOwnerPrincipal.userId, turn.dailySession.id, now],
    );
    await database.pool.query(
      `INSERT INTO journal_versions (
        journal_version_id, journal_id, user_id, daily_session_id, source_revision,
        generation_policy_version, validator_version, locale, evidence_source_snapshot_id,
        status, generation_command_id, model_run_attempt_id, generation_kind, created_at
      ) VALUES ($1, $2, $3, $4, 1, 'journal-generation:v2', 'journal-validator:v1',
        'en-US', $5, 'published', $6, $7, 'automatic', $8)`,
      [versionId, journalId, fixedInternalOwnerPrincipal.userId, turn.dailySession.id, snapshotId, journalGenerationCommandId, journalAttemptId, now],
    );
    await database.pool.query(
      "UPDATE journals SET current_version_id = $1 WHERE journal_id = $2",
      [versionId, journalId],
    );

    const responseRepository = new PostgresConversationResponseRepository(database.pool);
    expect(
      await responseRepository.claimResponseExecution({
        generationCommandId: turn.generation.commandId,
        modelRunAttemptId: turn.generation.attemptId,
        userId: fixedInternalOwnerPrincipal.userId,
      }),
    ).toBe("owner");
    const context = await createContextCompiler({
      clock: () => now,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "action-test-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    }).compile({
      generationCommandId: turn.generation.commandId,
      interactionTurnId: turn.turn.id,
      userId: fixedInternalOwnerPrincipal.userId,
    });
    const handle = context.actionReferenceHandles?.[0];
    expect(handle?.handle).toMatch(/^shh-handle-/);

    const actionRepository = new PostgresConversationActionRepository(
      database.pool,
      "action-payload-test-secret",
    );
    const gateway = createConversationActionGateway({
      handler: createJournalRegenerationActionHandler({
        generationPolicyVersion: "journal-generation:v2",
      }),
      repository: actionRepository,
    });
    const request = {
      actionKind: "regenerate_journal" as const,
      arguments: {
        guidance: "Make the turning point clearer.",
        journalHandle: handle!.handle,
      },
      requestEventRevisionId: turn.message.revisionId,
      schemaVersion: "regenerate-journal:v1" as const,
    };
    const actionContext = {
      compiledContextId: context.id,
      decisionCommandId: turn.generation.commandId,
      requestEventRevisionId: turn.message.revisionId,
      userId: fixedInternalOwnerPrincipal.userId,
    };
    const first = await gateway.admit({
      catalog: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
      context: actionContext,
      proposal: request,
    });
    const second = await gateway.admit({
      catalog: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
      context: actionContext,
      proposal: request,
    });
    expect(first).toMatchObject({ admission: "accepted", execution: "pending", receiptSequence: 1 });
    expect(second).toEqual(first);

    const counts = await database.pool.query<{
      actions: string;
      commands: string;
      outbox: string;
      payloads: string;
      regeneration_commands: string;
      finalization_commands: string;
      decision_commands: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM conversation_action_executions) AS actions,
        (SELECT COUNT(*) FROM conversation_action_payloads) AS payloads,
        (SELECT COUNT(*) FROM journal_generation_commands WHERE generation_kind = 'regeneration') AS regeneration_commands,
        (SELECT COUNT(*) FROM generation_commands WHERE generation_stage = 'action_finalization') AS finalization_commands,
        (SELECT COUNT(*) FROM generation_commands WHERE generation_stage = 'decision') AS decision_commands,
        (SELECT COUNT(*) FROM workflow_commands WHERE command_type = 'journal_regeneration') AS commands,
        (SELECT COUNT(*) FROM outbox_events WHERE event_type = 'journal_regeneration_requested') AS outbox
    `);
    expect(counts.rows[0]).toEqual({ actions: "1", commands: "1", outbox: "1", payloads: "0", regeneration_commands: "1", finalization_commands: "1", decision_commands: "1" });
    const finalization = await database.pool.query<{
      generation_stage: string;
      action_execution_id: string;
      status: string;
    }>(
      `SELECT generation_stage, action_execution_id, status
       FROM generation_commands
       WHERE generation_stage = 'action_finalization'`,
    );
    expect(finalization.rows[0]).toMatchObject({
      generation_stage: "action_finalization",
      action_execution_id: first.actionExecutionId,
      status: "prepared",
    });
    await database.pool.query(
      `UPDATE daily_sessions
       SET activity_state = 'quiescent', quiescent_reason = 'explicit_user_end'
       WHERE daily_session_id = $1`,
      [turn.dailySession.id],
    );
    const journalService = createJournalService({
      journalPolicyVersion: "journal-generation:v2",
      validatorVersion: "journal-validator:v1",
      evidenceExtractionPolicyVersion: "evidence-extraction:v2",
      generationMetadata: {
        role: "journal.draft",
        provider: "deterministic",
        model: "test",
        configVersion: "test:v1",
        rolePolicyVersion: "journal-generation:v2",
        promptFingerprint: "test",
      },
      validationMetadata: {
        role: "journal.validate",
        provider: "deterministic",
        model: "test",
        configVersion: "test:v1",
        rolePolicyVersion: "journal-validator:v1",
        promptFingerprint: "test",
      },
      validationProvider: {
        role: "journal.validate",
        validate: async () => ({ valid: true }),
      },
      model: {
        generate: async (input) => ({
          locale: input.locale,
          statements: [{
            id: "regenerated-statement",
            text: "The owner described the day with a clearer turning point.",
            epistemicStatus: "supported_expression" as const,
            evidenceItemIds: [evidenceItemId],
          }],
        }),
      },
      repository: new PostgresJournalRepository(database.pool),
    });
    await expect(runJournalRegenerationWorkflow({
      actionRepository,
      journalService,
      workflowCommandId: (await database.pool.query<{ workflow_command_id: string }>(
        "SELECT workflow_command_id FROM workflow_commands WHERE command_type = 'journal_regeneration'",
      )).rows[0]!.workflow_command_id,
    })).resolves.toMatchObject({ outcome: "published" });
    const published = await database.pool.query<{
      generation_kind: string;
      supersedes_version_id: string | null;
      journal_version_id: string;
    }>(
      `SELECT version.generation_kind, version.supersedes_version_id,
          version.journal_version_id
       FROM journal_versions version
       WHERE version.generation_kind = 'regeneration'`,
    );
    expect(published.rows).toHaveLength(1);
    expect(published.rows[0]).toMatchObject({
      generation_kind: "regeneration",
      supersedes_version_id: versionId,
    });
    const actionState = await database.pool.query<{
      execution_status: string;
      receipt_sequence: number[];
    }>(
      `SELECT execution.execution_status,
          ARRAY_AGG(receipt.receipt_sequence ORDER BY receipt.receipt_sequence)
            AS receipt_sequence
       FROM conversation_action_executions execution
       INNER JOIN conversation_action_receipts receipt
         ON receipt.action_execution_id = execution.action_execution_id
       WHERE execution.action_execution_id = $1
       GROUP BY execution.execution_status`,
      [first.actionExecutionId],
    );
    expect(actionState.rows[0]).toEqual({
      execution_status: "succeeded",
      receipt_sequence: [1, 2, 3],
    });
    const outbox = await database.pool.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox_events WHERE event_type = 'journal_regeneration_requested'",
    );
    expect(outbox.rows[0]?.payload).not.toHaveProperty("guidance");
    const commandBeforePurge = await database.pool.query<{
      action_execution_id: string;
      guidance_ciphertext: Buffer | null;
    }>(
      `SELECT action_execution_id, guidance_ciphertext
       FROM journal_generation_commands
       WHERE generation_kind = 'regeneration'`,
    );
    expect(commandBeforePurge.rows[0]?.guidance_ciphertext).not.toBeNull();
    await database.pool.query(
      `UPDATE conversation_action_executions
       SET execution_status = 'succeeded'
       WHERE action_execution_id = $1`,
      [commandBeforePurge.rows[0]?.action_execution_id],
    );
    expect(
      await actionRepository.purgeExpiredGuidance(new Date(now.getTime() + 1_000)),
    ).toBe(1);
    const commandAfterPurge = await database.pool.query<{
      guidance_ciphertext: Buffer | null;
      guidance_content_purged_at: Date | null;
    }>(
      `SELECT guidance_ciphertext, guidance_content_purged_at
       FROM journal_generation_commands
       WHERE generation_kind = 'regeneration'`,
    );
    expect(commandAfterPurge.rows[0]).toEqual({
      guidance_ciphertext: null,
      guidance_content_purged_at: expect.any(Date),
    });
  });
});
