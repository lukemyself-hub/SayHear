import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  asGenerationCommandId,
  asUserId,
  createInternalOwnerAccessService,
  createInternalInspectionService,
  createJournalEligibilityService,
  createDialogueStateService,
  createOwnerFullPurgeService,
  createRollingSummaryService,
  InternalInspectionNotFoundError,
  OwnerPurgeConfirmationError,
} from "@sayhear/application";
import {
  PostgresDialogueStateRepository,
  PostgresInternalInspectionRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresJournalEligibilityRepository,
  PostgresJournalRepository,
  PostgresOwnerPurgeRepository,
  PostgresPurgeMarkerRepository,
  PostgresRollingSummaryRepository,
  purgeMarkerMigrationsDirectory,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

import { createOperatorFullPurgeHandler } from "../../apps/web/src/operator-full-purge-handler";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testPurgeMarkerDatabaseUrl = process.env.TEST_PURGE_MARKER_DATABASE_URL;
if (!testDatabaseUrl || !testPurgeMarkerDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL and TEST_PURGE_MARKER_DATABASE_URL are required; the purge seam never falls back to a mock database.",
  );
}
if (testDatabaseUrl === testPurgeMarkerDatabaseUrl) {
  throw new Error(
    "TEST_PURGE_MARKER_DATABASE_URL must be a separate database outside the business backup domain.",
  );
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const BASE_TIME = new Date("2026-08-14T10:00:00.000Z");
let clockNowMs = BASE_TIME.getTime();
const clock = () => new Date(clockNowMs);

// Fixed identifiers so assertions can reference seeded rows directly.
const S1 = "11111111-1111-7111-8111-111111111111";
const T1 = "11111111-1111-7111-8111-111111111112";
const E1 = "11111111-1111-7111-8111-111111111113";
const E2 = "11111111-1111-7111-8111-111111111114";
const R1 = "11111111-1111-7111-8111-111111111115";
const R2 = "11111111-1111-7111-8111-111111111116";
const G1 = "11111111-1111-7111-8111-111111111117";
const M1 = "11111111-1111-7111-8111-111111111118";
const CC1 = "11111111-1111-7111-8111-111111111119";
const ES1 = "11111111-1111-7111-8111-11111111111a";
const EI1 = "11111111-1111-7111-8111-11111111111b";
const J1 = "11111111-1111-7111-8111-11111111111c";
const JV1 = "11111111-1111-7111-8111-11111111111d";
const JS1 = "11111111-1111-7111-8111-11111111111e";
const RS1 = "11111111-1111-7111-8111-11111111111f";
const RSV1 = "11111111-1111-7111-8111-111111111120";
const RS2 = "11111111-1111-7111-8111-111111111121";
const DS1 = "11111111-1111-7111-8111-111111111122";
const DSV1 = "11111111-1111-7111-8111-111111111123";
const DS2 = "11111111-1111-7111-8111-111111111124";
const WC1 = "11111111-1111-7111-8111-111111111125";
const OE1 = "11111111-1111-7111-8111-111111111126";
const SESSION_TOKEN_HASH = createHash("sha256")
  .update("purge-test-session-token", "utf8")
  .digest();
const POST_PURGE_SESSION_HASH = createHash("sha256")
  .update("post-purge-session", "utf8")
  .digest();

const JOURNAL_POLICY = "journal-generation:v2";
const VALIDATOR_POLICY = "journal-validator:v2";
const EVIDENCE_POLICY = "evidence-extraction:v2";

async function seedOwnerData(pool: IsolatedPostgresSchema["pool"]) {
  const t0 = "2026-08-12T15:00:00.000Z";
  const t1 = "2026-08-12T15:01:00.000Z";
  await pool.query(`
    INSERT INTO daily_sessions (
      daily_session_id, user_id, logical_date, timezone_at_start, started_at,
      last_activity_at, activity_state, current_continuous_exchange_no,
      dialogue_revision, source_revision, next_turn_sequence_no,
      next_event_sequence_no, created_at, updated_at, quiescent_at,
      quiescent_reason
    ) VALUES (
      '${S1}', '${OWNER}', '2026-08-12', 'UTC', '${t0}', '${t1}',
      'finalized', 1, 1, 1, 2, 3, '${t0}', '${t1}', '${t1}',
      'explicit_user_end'
    );
    INSERT INTO interaction_turns (
      interaction_turn_id, user_id, daily_session_id, client_turn_id,
      turn_sequence_no, continuous_exchange_no, status, started_at,
      settled_at, created_at, updated_at
    ) VALUES (
      '${T1}', '${OWNER}', '${S1}', 'ct-1', 1, 1, 'settled', '${t0}',
      '${t1}', '${t0}', '${t1}'
    );
    INSERT INTO conversation_events (
      conversation_event_id, user_id, daily_session_id, interaction_turn_id,
      sequence_no, client_event_id, actor, channel, event_type,
      lifecycle_status, created_at
    ) VALUES
      ('${E1}', '${OWNER}', '${S1}', '${T1}', 1, 'ce-1', 'user', 'text',
        'user_message', 'active', '${t0}'),
      ('${E2}', '${OWNER}', '${S1}', '${T1}', 2, 'ce-2', 'assistant', 'text',
        'assistant_response', 'active', '${t1}');
    INSERT INTO conversation_event_revisions (
      conversation_event_revision_id, user_id, conversation_event_id,
      revision, locale, canonical_text, transcript_status, created_by,
      created_at
    ) VALUES
      ('${R1}', '${OWNER}', '${E1}', 1, 'en',
        'Today I finally shipped the purge design after weeks of careful privacy work.',
        'final', 'client', '${t0}'),
      ('${R2}', '${OWNER}', '${E2}', 1, 'en',
        'That sounds like meaningful progress on something you care about.',
        'final', 'provider', '${t1}');
    UPDATE conversation_events SET current_revision_id = '${R1}'
      WHERE conversation_event_id = '${E1}';
    UPDATE conversation_events SET current_revision_id = '${R2}'
      WHERE conversation_event_id = '${E2}';
    INSERT INTO generation_commands (
      generation_command_id, user_id, interaction_turn_id, operation_type,
      intent_key, subject_type, subject_id, input_revision_kind,
      input_revision_id, prompt_version, product_policy_version,
      safety_policy_version, relationship_policy_version,
      locale_policy_version, locale, provider, model, model_snapshot,
      model_config_version, freshness_policy, expected_data_epoch, status,
      created_at, settled_at, output_format_version, persona_version,
      harness_policy_version, conversation_action_catalog_version,
      provider_policy_version
    ) VALUES (
      '${G1}', '${OWNER}', '${T1}', 'conversation.text', 'intent-1',
      'conversation_event', '${E1}', 'conversation_event_revision', '${R1}',
      'conversation-text:v1', 'product-policy:v1',
      'minimum-high-risk-response:v1', 'relationship-boundary:v1',
      'locale-pack-en:v1', 'en', 'openai', 'gpt-5.4', 'gpt-5.4',
      'conversation-text-champion:v1', 'source_valid:v1', 1, 'succeeded',
      '${t0}', '${t1}', 'conversation-output:v1', 'sayhear-persona:v1',
      'conversation-harness:v1', 'conversation-action-catalog:empty:v1',
      'openai-conversation-text:v1'
    );
    INSERT INTO compiled_contexts (
      compiled_context_id, user_id, generation_command_id, compiler_version,
      dialogue_revision, source_revision, locale, section_budgets,
      total_tokens, content_hmac, created_at, policy_versions, sections,
      integrity_algorithm, integrity_key_version
    ) VALUES (
      '${CC1}', '${OWNER}', '${G1}', 'context-compiler:v1', 1, 1, 'en',
      '{"committedRawEvents": 100}', 42, 'hmac', '${t0}',
      '{"personaVersion":"sayhear-persona:v1"}', '[]', 'hmac-sha256',
      'context-integrity:legacy'
    );
    INSERT INTO compiled_context_revision_refs (
      compiled_context_id, user_id, conversation_event_revision_id, ordinal,
      actor, estimated_tokens, sequence_no, section, selection_order
    ) VALUES
      ('${CC1}', '${OWNER}', '${R1}', 0, 'user', 20, 1,
        'committed_raw_events', 0),
      ('${CC1}', '${OWNER}', '${R2}', 1, 'assistant', 12, 2,
        'committed_raw_events', 1);
    UPDATE generation_commands SET compiled_context_id = '${CC1}',
      authoritative_result_id = '${R2}'
      WHERE generation_command_id = '${G1}';
    UPDATE conversation_events SET generation_command_id = '${G1}'
      WHERE conversation_event_id = '${E2}';
    INSERT INTO model_run_attempts (
      model_run_attempt_id, user_id, generation_command_id, attempt_no,
      operation_type, provider, model, model_snapshot, prompt_version,
      status, started_at, completed_at, created_at
    ) VALUES (
      '${M1}', '${OWNER}', '${G1}', 1, 'conversation.text', 'openai',
      'gpt-5.4', 'gpt-5.4', 'conversation-text:v1', 'succeeded', '${t0}',
      '${t1}', '${t0}'
    );
    INSERT INTO provider_egress_dispositions (
      provider_egress_disposition_id, user_id, model_run_attempt_id,
      provider, model, role, provider_policy_version, expected_data_epoch,
      status, checked_at, dispatched_at, completed_at
    ) VALUES (
      '11111111-1111-7111-8111-111111111127', '${OWNER}', '${M1}', 'openai',
      'gpt-5.4', 'conversation.text', 'openai-conversation-text:v1', 1,
      'completed', '${t0}', '${t0}', '${t1}'
    );
    INSERT INTO provider_egress_consents (
      user_id, provider, role, consent_policy_version, status, granted_at
    ) VALUES (
      '${OWNER}', 'openai', 'conversation.text', 'api-data-controls:v1',
      'active', '${t0}'
    );
    INSERT INTO auth_sessions (
      session_token_hash, user_id, expires_at
    ) VALUES (
      decode('${SESSION_TOKEN_HASH.toString("hex")}', 'hex'), '${OWNER}',
      '2026-08-21T10:00:00.000Z'
    );
    INSERT INTO internal_diagnostic_access_grants (
      session_token_hash, capability, status, step_up_authenticated_at,
      updated_at
    ) VALUES (
      decode('${SESSION_TOKEN_HASH.toString("hex")}', 'hex'),
      'conversation_content:read', 'active', '2026-08-14T09:59:00.000Z',
      '2026-08-14T09:59:00.000Z'
    );
    INSERT INTO sensitive_access_audits (
      sensitive_access_audit_id, user_id, capability, target_type, target_id,
      disposition, reason, policy_version, accessed_at
    ) VALUES (
      '11111111-1111-7111-8111-111111111128', '${OWNER}',
      'conversation_content:read', 'generation_command', '${G1}', 'allowed',
      'authorized', 'sensitive-inspection:v1', '${t0}'
    );
    INSERT INTO evidence_source_snapshots (
      evidence_source_snapshot_id, user_id, daily_session_id,
      source_revision, extraction_policy_version, command_id, attempt_id,
      champion_config_version, champion_provider, champion_model,
      champion_snapshot, champion_provider_policy_version, created_at
    ) VALUES (
      '${ES1}', '${OWNER}', '${S1}', 1, '${EVIDENCE_POLICY}', 'cmd-1',
      'att-1', 'conversation-text-champion:v1', 'openai', 'gpt-5.4',
      'gpt-5.4', 'openai-conversation-text:v1', '${t1}'
    );
    INSERT INTO evidence_items (
      evidence_item_id, user_id, evidence_source_snapshot_id,
      source_event_id, source_revision_id, source_actor, source_status,
      locator_type, locator_key, extraction_policy_version, evidence_role,
      status, created_at
    ) VALUES (
      '${EI1}', '${OWNER}', '${ES1}', '${E1}', '${R1}', 'user', 'final',
      'whole_revision', 'whole', '${EVIDENCE_POLICY}', 'factual_support',
      'active', '${t1}'
    );
    INSERT INTO evidence_lineage (
      evidence_item_id, command_id, attempt_id, created_at
    ) VALUES ('${EI1}', 'cmd-1', 'att-1', '${t1}');
    INSERT INTO evidence_model_run_attempts (
      evidence_model_run_attempt_id, evidence_source_snapshot_id, role,
      provider, model, config_version, extraction_policy_version,
      prompt_fingerprint, status, created_at
    ) VALUES (
      '11111111-1111-7111-8111-111111111129', '${ES1}', 'evidence.extract',
      'openai', 'gpt-5.4', 'conversation-text-champion:v1:evidence',
      '${EVIDENCE_POLICY}', 'evidence-extract:spans:v2', 'completed', '${t1}'
    );
    INSERT INTO journal_generation_commands (
      generation_command_id, user_id, daily_session_id, source_revision,
      generation_policy_version, expected_data_epoch, created_at
    ) VALUES ('jg-1', '${OWNER}', '${S1}', 1, '${JOURNAL_POLICY}', 1, '${t1}');
    INSERT INTO journal_model_run_attempts (
      model_run_attempt_id, generation_command_id, role, provider, model,
      status, created_at
    ) VALUES
      ('ja-1', 'jg-1', 'journal.draft', 'openai', 'gpt-5.4', 'completed',
        '${t1}'),
      ('ja-2', 'jg-1', 'journal.validate', 'openai', 'gpt-5.4', 'completed',
        '${t1}');
    INSERT INTO journals (
      journal_id, user_id, daily_session_id, created_at
    ) VALUES ('${J1}', '${OWNER}', '${S1}', '${t1}');
    INSERT INTO journal_versions (
      journal_version_id, journal_id, user_id, daily_session_id,
      source_revision, generation_policy_version, validator_version, locale,
      evidence_source_snapshot_id, status, generation_command_id,
      model_run_attempt_id, created_at
    ) VALUES (
      '${JV1}', '${J1}', '${OWNER}', '${S1}', 1, '${JOURNAL_POLICY}',
      '${VALIDATOR_POLICY}', 'en', '${ES1}', 'published', 'jg-1', 'ja-1',
      '${t1}'
    );
    UPDATE journals SET current_version_id = '${JV1}'
      WHERE journal_id = '${J1}';
    INSERT INTO journal_statements (
      journal_statement_id, journal_version_id, statement_index,
      statement_key, statement_text, user_id,
      source_revision, evidence_source_snapshot_id
    ) VALUES (
      '${JS1}', '${JV1}', 0, 'shipped', 'The owner shipped a privacy design.',
      '${OWNER}', 1, '${ES1}'
    );
    INSERT INTO journal_statement_evidence_links (
      journal_statement_id, evidence_item_id, user_id, source_revision,
      evidence_source_snapshot_id, evidence_role
    ) VALUES (
      '${JS1}', '${EI1}', '${OWNER}', 1, '${ES1}', 'factual_support'
    );
    INSERT INTO journal_validation_results (
      journal_validation_result_id, journal_version_id, daily_session_id,
      source_revision, generation_command_id, model_run_attempt_id,
      programmatic_valid, status, validator_version, created_at
    ) VALUES (
      '11111111-1111-7111-8111-11111111112a', '${JV1}', '${S1}', 1, 'jg-1',
      'ja-1', TRUE, 'validated', '${VALIDATOR_POLICY}', '${t1}'
    );
    INSERT INTO daily_session_date_outcomes (
      daily_session_id, user_id, logical_date, outcome,
      eligibility_policy_version, source_revision, computed_at
    ) VALUES (
      '${S1}', '${OWNER}', '2026-08-12', 'journal_available',
      'journal-eligibility:v1', 1, '${t1}'
    );
    INSERT INTO rolling_summary_commands (
      rolling_summary_command_id, user_id, daily_session_id,
      expected_data_epoch, source_revision, dialogue_revision,
      coverage_start_sequence_no, covered_through_sequence_no,
      policy_version, minimum_uncovered_event_count,
      minimum_uncovered_token_count, prompt_version, model_config_version,
      status, claimed_at, created_at
    ) VALUES
      ('${RS1}', '${OWNER}', '${S1}', 1, 1, 1, 1, 2, 'rolling-summary:v1',
        12, 3000, 'rolling-summary:neutral-structured:v1',
        'conversation-text-champion:v1:summary', 'published', '${t1}', '${t1}'),
      ('${RS2}', '${OWNER}', '${S1}', 1, 1, 1, 1, 1, 'rolling-summary:v1',
        12, 3000, 'rolling-summary:neutral-structured:v1',
        'conversation-text-champion:v1:summary', 'created', NULL, '${t1}');
    INSERT INTO rolling_summary_command_source_refs (
      rolling_summary_command_id, conversation_event_revision_id, sequence_no
    ) VALUES
      ('${RS1}', '${R1}', 1), ('${RS1}', '${R2}', 2),
      ('${RS2}', '${R1}', 1);
    INSERT INTO rolling_summary_versions (
      rolling_summary_version_id, rolling_summary_command_id, user_id,
      daily_session_id, version_no, covered_through_sequence_no, content,
      created_at
    ) VALUES (
      '${RSV1}', '${RS1}', '${OWNER}', '${S1}', 1, 2, '{}', '${t1}'
    );
    INSERT INTO current_rolling_summaries (
      daily_session_id, rolling_summary_version_id, user_id,
      covered_through_sequence_no, updated_at
    ) VALUES ('${S1}', '${RSV1}', '${OWNER}', 2, '${t1}');
    INSERT INTO dialogue_state_commands (
      dialogue_state_command_id, user_id, daily_session_id,
      expected_data_epoch, source_revision, dialogue_revision,
      coverage_through_sequence_no, policy_version, prompt_version,
      model_config_version, status, coverage_key, created_at
    ) VALUES
      ('${DS1}', '${OWNER}', '${S1}', 1, 1, 1, 2, 'dialogue-state:v1',
        'dialogue-state-prompt:v1', 'dialogue-state-model:v1', 'published',
        2, '${t1}'),
      ('${DS2}', '${OWNER}', '${S1}', 1, 1, 1, 1, 'dialogue-state:v1',
        'dialogue-state-prompt:v1', 'dialogue-state-model:v1', 'created',
        1, '${t1}');
    INSERT INTO dialogue_state_command_source_refs (
      dialogue_state_command_id, conversation_event_revision_id, sequence_no
    ) VALUES
      ('${DS1}', '${R1}', 1), ('${DS1}', '${R2}', 2),
      ('${DS2}', '${R1}', 1);
    INSERT INTO dialogue_state_versions (
      dialogue_state_version_id, dialogue_state_command_id, user_id,
      daily_session_id, version_no, source_revision, dialogue_revision,
      covered_through_sequence_no, content, created_at
    ) VALUES (
      '${DSV1}', '${DS1}', '${OWNER}', '${S1}', 1, 1, 1, 2, '{}', '${t1}'
    );
    INSERT INTO current_dialogue_states (
      daily_session_id, dialogue_state_version_id, user_id, source_revision,
      dialogue_revision, covered_through_sequence_no, updated_at
    ) VALUES ('${S1}', '${DSV1}', '${OWNER}', 1, 1, 2, '${t1}');
    INSERT INTO continuous_exchange_inactivity_evaluations (
      inactivity_evaluation_id, user_id, daily_session_id,
      continuous_exchange_no, policy_version, expected_dialogue_revision,
      due_at, evaluated_at, outcome, created_at
    ) VALUES (
      '11111111-1111-7111-8111-11111111112b', '${OWNER}', '${S1}', 1,
      'continuous-exchange-inactivity:v1', 1, '${t1}', '${t1}', 'applied',
      '${t0}'
    );
    INSERT INTO workflow_commands (
      workflow_command_id, command_type, subject_type, subject_id,
      source_revision, policy_version, expected_data_epoch, status,
      created_at
    ) VALUES (
      '${WC1}', 'journal_eligibility', 'daily_session', '${S1}', 1,
      'journal-eligibility:v1', 1, 'dispatched', '${t1}'
    );
    INSERT INTO outbox_events (
      outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
      aggregate_revision, event_type, status, next_attempt_at, lease_owner,
      lease_expires_at, attempt_count, workflow_receipt_id, payload,
      created_at, aggregate_coverage, aggregate_data_epoch
    ) VALUES (
      '${OE1}', '${WC1}', 'daily_session', '${S1}', 1,
      'journal_eligibility_requested', 'leased', '${t1}', 'sayhear-cron',
      '2026-08-12T16:00:00.000Z', 1, 'wf-run-1', '{}', '${t1}', 0, 1
    );
  `);
}

describe("Internal Owner Full Purge system seam — 1A.2 operator-only purge", () => {
  let database: IsolatedPostgresSchema;
  let markerDatabase: IsolatedPostgresSchema;
  let purgeRepository: PostgresOwnerPurgeRepository;
  let markerRepository: PostgresPurgeMarkerRepository;
  let purgeService: ReturnType<typeof createOwnerFullPurgeService>;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    markerDatabase = await createIsolatedPostgresSchema(
      testPurgeMarkerDatabaseUrl,
    );
    await runMigrations(markerDatabase.pool, {
      migrationsDirectory: purgeMarkerMigrationsDirectory,
    });
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "test-owner",
      userId: OWNER,
    });
  }, 20_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME.getTime();
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
        daily_sessions,
        auth_sessions
    `);
    await database.pool.query("DELETE FROM backup_policy_versions");
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
    await markerDatabase.pool.query("TRUNCATE TABLE purge_markers");
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
      validUntil: new Date("2026-09-14T10:00:00.000Z"),
      verifiedAt: new Date("2026-07-27T15:00:00.000Z"),
    });

    purgeRepository = new PostgresOwnerPurgeRepository(database.pool);
    markerRepository = new PostgresPurgeMarkerRepository(markerDatabase.pool);
    purgeService = createOwnerFullPurgeService({
      clock,
      markerRepository,
      providerRetentionDays: 30,
      repository: purgeRepository,
    });
    await seedOwnerData(database.pool);
  });

  afterAll(async () => {
    await database?.dispose();
    await markerDatabase?.dispose();
  }, 10_000);

  async function startPurgeOrder() {
    const started = await purgeRepository.startOrder({
      confirmation: "PURGE",
      now: clock(),
      policyVersion: "owner-full-purge:v1",
      userId: OWNER,
    });
    if (started.outcome !== "started") {
      throw new Error(`unexpected start outcome: ${started.outcome}`);
    }
    return started;
  }

  async function countRows(sql: string): Promise<number> {
    const result = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM (${sql}) AS counted`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  it("opening transaction marks deleting, advances the epoch, revokes access and egress, and blocks normal writes", async () => {
    const { order } = await startPurgeOrder();
    expect(order.status).toBe("requested");
    expect(order.fromDataEpoch).toBe(1);
    expect(order.dataEpoch).toBe(2);

    const owner = await database.pool.query<{
      status: string;
      data_epoch: string;
    }>(
      "SELECT status, data_epoch::text FROM app_users WHERE user_id = $1",
      [OWNER],
    );
    expect(owner.rows[0]).toMatchObject({ status: "deleting", data_epoch: "2" });

    // Sessions revoked; diagnostic grants cascaded away.
    expect(await countRows("SELECT 1 FROM auth_sessions")).toBe(0);
    expect(
      await countRows("SELECT 1 FROM internal_diagnostic_access_grants"),
    ).toBe(0);
    // Undispatched egress authorization revoked.
    const consent = await database.pool.query(
      "SELECT status FROM provider_egress_consents WHERE user_id = $1",
      [OWNER],
    );
    expect(consent.rows[0]?.status).toBe("revoked");
    // One idempotent deletion command + outbox event.
    expect(
      await countRows(
        "SELECT 1 FROM workflow_commands WHERE command_type = 'owner_full_purge'",
      ),
    ).toBe(1);
    expect(
      await countRows(
        "SELECT 1 FROM outbox_events WHERE event_type = 'owner_full_purge_requested'",
      ),
    ).toBe(1);

    // Normal reads/writes fail the owner fence: eligibility command creation
    // and journal generation are rejected for a non-active owner.
    const eligibilityService = createJournalEligibilityService({
      clock,
      minimumSubstantiveExpressionLength: 20,
      policyVersion: "journal-eligibility:v1",
      repository: new PostgresJournalEligibilityRepository(database.pool),
    });
    await expect(eligibilityService.evaluate(S1)).resolves.toEqual({
      outcome: "not_found",
    });
    const journalRepository = new PostgresJournalRepository(database.pool);
    await expect(
      journalRepository.startGeneration({
        dailySessionId: S1,
        expectedDataEpoch: 1,
        generationCommandId: "fence-jg",
        generationPolicyVersion: JOURNAL_POLICY,
        model: "gpt-5.4",
        modelRunAttemptId: "fence-ja",
        configVersion: "conversation-text-champion:v1",
        promptFingerprint: "journal-draft:evidence-only:v2",
        provider: "openai",
        role: "journal.draft",
        rolePolicyVersion: JOURNAL_POLICY,
        sourceRevision: 1,
        userId: OWNER,
      }),
    ).resolves.toEqual({ accepted: false, generationCommandId: "fence-jg" });
  });

  it("propagation clears every owner-scoped surface, writes receipts and the external marker, revives the owner, and never claims fully_expired", async () => {
    const { order } = await startPurgeOrder();
    const result = await purgeService.propagate({
      ownerPurgeOrderId: order.ownerPurgeOrderId,
    });
    expect(result.status).toBe("retention_pending");

    // Every owner-scoped surface introduced through 1A.2 is cleared.
    for (const table of [
      "daily_sessions",
      "interaction_turns",
      "conversation_events",
      "generation_commands",
      "model_run_attempts",
      "compiled_contexts",
      "compiled_context_revision_refs",
      "provider_egress_dispositions",
      "provider_egress_consents",
      "continuous_exchange_inactivity_evaluations",
      "evidence_source_snapshots",
      "evidence_items",
      "evidence_lineage",
      "evidence_model_run_attempts",
      "journals",
      "journal_versions",
      "journal_diagnostic_findings",
      "journal_statements",
      "journal_statement_evidence_links",
      "journal_validation_results",
      "journal_generation_commands",
      "journal_model_run_attempts",
      "rolling_summary_commands",
      "rolling_summary_versions",
      "current_rolling_summaries",
      "dialogue_state_commands",
      "dialogue_state_versions",
      "current_dialogue_states",
      "daily_session_date_outcomes",
      "workflow_commands",
      "outbox_events",
      "auth_sessions",
    ]) {
      expect(await countRows(`SELECT 1 FROM ${table}`)).toBe(0);
    }

    // Conversation Event Revisions survive as content-free tombstones.
    const revisions = await database.pool.query<{
      canonical_text: string;
      content_purged_at: Date | null;
    }>(
      "SELECT canonical_text, content_purged_at FROM conversation_event_revisions WHERE user_id = $1",
      [OWNER],
    );
    expect(revisions.rows).toHaveLength(2);
    for (const revision of revisions.rows) {
      expect(revision.canonical_text).toBe("");
      expect(revision.content_purged_at).not.toBeNull();
    }

    // Allowlisted de-identified operational metadata survives its subject.
    expect(
      await countRows("SELECT 1 FROM sensitive_access_audits"),
    ).toBeGreaterThan(0);
    expect(
      await countRows("SELECT 1 FROM backup_policy_versions"),
    ).toBeGreaterThan(0);
    const owner = await database.pool.query<{
      status: string;
      data_epoch: string;
    }>(
      "SELECT status, data_epoch::text FROM app_users WHERE user_id = $1",
      [OWNER],
    );
    // Owner revival at the advanced epoch — old data cannot resurrect.
    expect(owner.rows[0]).toMatchObject({ status: "active", data_epoch: "2" });

    // Content-free receipts per destination, provider retention from policy.
    const receipts = await purgeRepository.listReceipts({
      ownerPurgeOrderId: order.ownerPurgeOrderId,
    });
    const byDestination = new Map(
      receipts.map((receipt) => [receipt.destination, receipt]),
    );
    expect(byDestination.get("business_database")).toMatchObject({
      destinationDisposition: "verified_deleted",
    });
    expect(byDestination.get("purge_marker_store")).toMatchObject({
      destinationDisposition: "verified_deleted",
    });
    for (const role of [
      "conversation.text",
      "evidence.extract",
      "journal.draft",
      "journal.validate",
    ]) {
      expect(byDestination.get(`provider:${role}`)).toMatchObject({
        destinationDisposition: "retention_pending",
        providerDisposition: "retention_pending",
      });
      expect(
        byDestination.get(`provider:${role}`)?.providerRetentionUntil,
      ).not.toBeNull();
    }
    // The backup horizon comes from the latest verified window (30 days).
    expect(
      byDestination.get("business_database")?.backupRetentionUntil,
    ).toEqual(new Date(BASE_TIME.getTime() + 30 * 24 * 60 * 60 * 1_000));

    // The purge marker lives OUTSIDE the business database.
    await expect(
      database.pool.query("SELECT 1 FROM purge_markers"),
    ).rejects.toThrow();
    const marker = await markerRepository.findMarker({
      dataEpoch: 2,
      userId: OWNER,
    });
    expect(marker).not.toBeNull();
    expect(marker?.status).toBe("retention_pending");
    expect(marker?.backupRetentionUntil).toEqual(
      new Date(BASE_TIME.getTime() + 30 * 24 * 60 * 60 * 1_000),
    );
    expect(
      marker?.receipts.some(
        (receipt) => receipt.destination === "business_database",
      ),
    ).toBe(true);

    // The terminal state is retention_pending — never fully_expired (1A.2).
    const finalOrder = await purgeRepository.findOrder({
      ownerPurgeOrderId: order.ownerPurgeOrderId,
    });
    expect(finalOrder?.status).toBe("retention_pending");
    expect(finalOrder?.retentionPendingAt).not.toBeNull();
    expect(finalOrder?.activeSystemDeletedAt).not.toBeNull();
    expect(finalOrder?.needsAttentionReason).toBeNull();
  });

  it("keeps the external purge marker at the per-owner high-water epoch", async () => {
    await markerRepository.writeMarker({
      userId: OWNER,
      dataEpoch: 2,
      purgedAt: BASE_TIME,
      backupRetentionUntil: null,
      receipts: [],
    });
    await markerRepository.writeMarker({
      userId: OWNER,
      dataEpoch: 1,
      purgedAt: new Date(BASE_TIME.getTime() + 1_000),
      backupRetentionUntil: null,
      receipts: [],
    });
    await markerRepository.writeMarker({
      userId: OWNER,
      dataEpoch: 3,
      purgedAt: new Date(BASE_TIME.getTime() + 2_000),
      backupRetentionUntil: null,
      receipts: [],
    });

    await expect(markerRepository.findLatestMarker({ userId: OWNER })).resolves.toMatchObject({
      dataEpoch: 3,
    });
  });

  it("concurrency drill: journal publication and projection current-pointer writes cannot resurrect after the deletion epoch advances", async () => {
    const { order } = await startPurgeOrder();

    // In-flight Journal publication frozen at epoch 1 fails the fence.
    const journalRepository = new PostgresJournalRepository(database.pool);
    await expect(
      journalRepository.publish({
        dailySessionId: S1,
        expectedDataEpoch: 1,
        generationCommandId: "drill-jg",
        generationPolicyVersion: JOURNAL_POLICY,
        locale: "en",
        modelRunAttemptId: "drill-ja",
        diagnosticStatus: "available",
        diagnosticFindings: [],
        sourceRevision: 1,
        sourceSnapshotId: ES1,
        statements: [
          {
            id: "drill-statement",
            text: "A resurrection attempt that must never publish.",
            evidenceItemIds: [EI1],
          },
        ],
        userId: OWNER,
        validationAttemptId: "drill-jv",
        validatorConfigVersion: "conversation-text-champion:v1:journal-validate",
        validatorModel: "gpt-5.4",
        validatorPolicyVersion: VALIDATOR_POLICY,
        validatorPromptFingerprint: "journal-validate:diagnostic:v3",
        validatorProvider: "openai",
        validatorRole: "journal.validate",
        validatorVersion: VALIDATOR_POLICY,
      }),
    ).resolves.toEqual({ outcome: "fenced" });
    expect(
      await countRows(
        `SELECT 1 FROM journal_versions WHERE journal_version_id NOT IN ('${JV1}')`,
      ),
    ).toBe(0);

    // Rolling Summary and DialogueState projection runs frozen at epoch 1 are
    // stale, never call the Provider, and never move a current pointer.
    const neverCallModel = () => {
      throw new Error("the purge fence must prevent any new Provider call");
    };
    const rollingSummaryService = createRollingSummaryService({
      clock,
      model: { compress: neverCallModel },
      modelConfigVersion: "conversation-text-champion:v1:summary",
      policyVersion: "rolling-summary:v1",
      promptVersion: "rolling-summary:neutral-structured:v1",
      repository: new PostgresRollingSummaryRepository(database.pool),
    });
    await expect(rollingSummaryService.run(RS2)).resolves.toEqual({
      outcome: "stale",
    });
    const dialogueStateService = createDialogueStateService({
      clock,
      model: { project: neverCallModel },
      policy: {
        modelConfigVersion: "dialogue-state-model:v1",
        policyVersion: "dialogue-state:v1",
        promptVersion: "dialogue-state-prompt:v1",
      },
      repository: new PostgresDialogueStateRepository(database.pool),
    });
    await expect(dialogueStateService.run(DS2)).resolves.toEqual({
      outcome: "stale",
    });

    // No new projection version or current-pointer movement happened.
    expect(await countRows("SELECT 1 FROM rolling_summary_versions")).toBe(1);
    expect(await countRows("SELECT 1 FROM dialogue_state_versions")).toBe(1);
    expect(
      await countRows(
        "SELECT 1 FROM current_rolling_summaries WHERE rolling_summary_version_id = '" + RSV1 + "'",
      ),
    ).toBe(1);
    expect(
      await countRows(
        "SELECT 1 FROM current_dialogue_states WHERE dialogue_state_version_id = '" + DSV1 + "'",
      ),
    ).toBe(1);

    // Completing the purge clears everything; a second propagation converges.
    await purgeService.propagate({ ownerPurgeOrderId: order.ownerPurgeOrderId });
    await purgeService.propagate({ ownerPurgeOrderId: order.ownerPurgeOrderId });
    expect(await countRows("SELECT 1 FROM rolling_summary_versions")).toBe(0);
    expect(await countRows("SELECT 1 FROM dialogue_state_versions")).toBe(0);
    expect(await countRows("SELECT 1 FROM journal_versions")).toBe(0);
  });

  it("duplicate starts converge on one order without duplicate destructive effects", async () => {
    const [first, second] = await Promise.all([
      purgeRepository.startOrder({
        confirmation: "PURGE",
        now: clock(),
        policyVersion: "owner-full-purge:v1",
        userId: OWNER,
      }),
      purgeRepository.startOrder({
        confirmation: "PURGE",
        now: clock(),
        policyVersion: "owner-full-purge:v1",
        userId: OWNER,
      }),
    ]);
    expect(first.outcome).toBe("started");
    expect(second.outcome).toBe("started");
    if (first.outcome !== "started" || second.outcome !== "started") {
      throw new Error("both starts must converge");
    }
    expect(second.created).toBe(false);
    expect(second.order.ownerPurgeOrderId).toBe(first.order.ownerPurgeOrderId);

    expect(await countRows("SELECT 1 FROM owner_purge_orders")).toBe(1);
    expect(
      await countRows(
        "SELECT 1 FROM workflow_commands WHERE command_type = 'owner_full_purge'",
      ),
    ).toBe(1);
    // The epoch advanced exactly once.
    const owner = await database.pool.query<{ data_epoch: string }>(
      "SELECT data_epoch::text FROM app_users WHERE user_id = $1",
      [OWNER],
    );
    expect(owner.rows[0]?.data_epoch).toBe("2");

    // The cancelled in-flight work is terminal and reason-recorded before the
    // clear step removes the rows entirely.
    await purgeService.propagate({
      ownerPurgeOrderId: first.order.ownerPurgeOrderId,
    });
    expect(await countRows("SELECT 1 FROM workflow_commands")).toBe(0);
  });

  it("a crash between the clear transaction and the marker write converges with identical marker receipts", async () => {
    const { order } = await startPurgeOrder();
    // Simulate the crash window: the access-revoke and clear transactions
    // committed, but the marker was never written.
    await purgeRepository.transitionToAccessRevoked({
      now: clock(),
      ownerPurgeOrderId: order.ownerPurgeOrderId,
    });
    const cleared = await purgeRepository.transitionToPropagatingAndClear({
      now: clock(),
      ownerPurgeOrderId: order.ownerPurgeOrderId,
      providerRetentionUntil: new Date(
        BASE_TIME.getTime() + 30 * 24 * 60 * 60 * 1_000,
      ),
    });
    expect(cleared.outcome).toBe("cleared");
    expect(await markerRepository.findMarker({ dataEpoch: 2, userId: OWNER })).toBeNull();

    // The retry converges, and the marker mirrors the durable provider
    // receipts written by the earlier clear transaction.
    await purgeService.propagate({ ownerPurgeOrderId: order.ownerPurgeOrderId });
    const marker = await markerRepository.findMarker({
      dataEpoch: 2,
      userId: OWNER,
    });
    expect(marker?.status).toBe("retention_pending");
    const destinations = marker?.receipts.map((receipt) => receipt.destination);
    for (const role of [
      "conversation.text",
      "evidence.extract",
      "journal.draft",
      "journal.validate",
    ]) {
      expect(destinations).toContain(`provider:${role}`);
    }
    expect(destinations).toContain("business_database");

    const finalOrder = await purgeRepository.findOrder({
      ownerPurgeOrderId: order.ownerPurgeOrderId,
    });
    expect(finalOrder?.status).toBe("retention_pending");
  });

  it("needs_attention orders are auto-retried by the recovery scan and converge", async () => {
    const { order } = await startPurgeOrder();
    await purgeRepository.markNeedsAttention({
      now: clock(),
      ownerPurgeOrderId: order.ownerPurgeOrderId,
      reason: "verification_failed:drill",
    });
    const scan = await purgeService.scanPendingOrders({ now: clock() });
    expect(scan.retried).toBe(1);
    expect(scan.remaining).toBe(0);

    const finalOrder = await purgeRepository.findOrder({
      ownerPurgeOrderId: order.ownerPurgeOrderId,
    });
    expect(finalOrder?.status).toBe("retention_pending");

    // Terminal orders never regress and are not retried again.
    const idleScan = await purgeService.scanPendingOrders({ now: clock() });
    expect(idleScan.retried).toBe(0);
  });

  it("sensitive inspection of purged content fails closed even after re-authentication", async () => {
    const inspectionService = createInternalInspectionService({
      clock,
      policyVersion: "sensitive-inspection:v1",
      repository: new PostgresInternalInspectionRepository(database.pool),
      stepUpMaxAgeMs: 10 * 60 * 1_000,
    });

    // Before the purge, a fresh step-up grant can inspect the command.
    const before = await inspectionService.inspectConversationContent(
      OWNER,
      SESSION_TOKEN_HASH.toString("hex"),
      asGenerationCommandId(G1),
    );
    expect(before.events).toHaveLength(2);

    const { order } = await startPurgeOrder();
    await purgeService.propagate({ ownerPurgeOrderId: order.ownerPurgeOrderId });

    // The owner is revived; a brand-new session + grant still cannot read the
    // purged content: the command (and its content) no longer exists.
    await database.pool.query(
      `INSERT INTO auth_sessions (session_token_hash, user_id, expires_at)
       VALUES (decode($1, 'hex'), $2, '2026-08-21T10:00:00.000Z')`,
      [POST_PURGE_SESSION_HASH.toString("hex"), OWNER],
    );
    await database.pool.query(
      `INSERT INTO internal_diagnostic_access_grants (
         session_token_hash, capability, status, step_up_authenticated_at,
         updated_at
       ) VALUES (decode($1, 'hex'), 'conversation_content:read', 'active', $2, $2)`,
      [POST_PURGE_SESSION_HASH.toString("hex"), clock()],
    );
    await expect(
      inspectionService.inspectConversationContent(
        OWNER,
        POST_PURGE_SESSION_HASH.toString("hex"),
        asGenerationCommandId(G1),
      ),
    ).rejects.toBeInstanceOf(InternalInspectionNotFoundError);

    // Journal reads of the purged session fail closed as well.
    const journalRepository = new PostgresJournalRepository(database.pool);
    expect(
      await journalRepository.readCurrent({
        dailySessionId: S1,
        userId: OWNER,
      }),
    ).toBeNull();
  });

  it("operator endpoint: confirmation, idempotent duplicate, content-free inspection, and access control", async () => {
    const accessService = createInternalOwnerAccessService({
      clock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      repository: new PostgresInternalOwnerAccessRepository(database.pool),
    });
    const handler = createOperatorFullPurgeHandler({
      accessService,
      authenticate: async () => ({ userId: OWNER }),
      service: purgeService,
    });

    // Unauthenticated and non-owner callers are rejected.
    const anonymous = createOperatorFullPurgeHandler({
      accessService,
      authenticate: async () => null,
      service: purgeService,
    });
    expect((await anonymous(new Request("http://test/api"))).status).toBe(401);
    const foreign = createOperatorFullPurgeHandler({
      accessService,
      authenticate: async () => ({
        userId: asUserId("33333333-3333-7333-8333-333333333333"),
      }),
      service: purgeService,
    });
    expect(
      (
        await foreign(
          new Request("http://test/api", {
            method: "POST",
            body: JSON.stringify({ confirm: "PURGE" }),
          }),
        )
      ).status,
    ).toBe(403);

    // Client-supplied owner identifiers are rejected.
    expect(
      (
        await handler(
          new Request("http://test/api?user_id=someone", { method: "POST", body: JSON.stringify({ confirm: "PURGE" }) }),
        )
      ).status,
    ).toBe(400);

    // Wrong or missing confirmation never creates an order.
    expect(
      (await handler(new Request("http://test/api", { method: "POST", body: JSON.stringify({ confirm: "nope" }) }))).status,
    ).toBe(400);
    expect(
      (await handler(new Request("http://test/api", { method: "POST", body: JSON.stringify({}) }))).status,
    ).toBe(400);
    expect(await countRows("SELECT 1 FROM owner_purge_orders")).toBe(0);
    await expect(
      purgeService.start({ confirmation: "nope", userId: OWNER }),
    ).rejects.toThrow(OwnerPurgeConfirmationError);

    // A confirmed start purges and reports content-free state.
    const started = await handler(
      new Request("http://test/api", {
        method: "POST",
        body: JSON.stringify({ confirm: "PURGE" }),
      }),
    );
    expect(started.status).toBe(200);
    const startedBody = (await started.json()) as {
      created: boolean;
      order: { status: string };
      receipts: { destination: string }[];
    };
    expect(startedBody.created).toBe(true);
    expect(startedBody.order.status).toBe("retention_pending");
    expect(
      startedBody.receipts.some((r) => r.destination === "business_database"),
    ).toBe(true);

    // After revival, the same endpoint returns inspection state, and a
    // duplicate start is a new epoch's order — never a regression.
    const inspected = await handler(new Request("http://test/api"));
    expect(inspected.status).toBe(200);
    const inspectedBody = (await inspected.json()) as {
      created: boolean;
      order: { status: string } | null;
    };
    expect(inspectedBody.created).toBe(false);
    expect(inspectedBody.order?.status).toBe("retention_pending");

    const second = await handler(
      new Request("http://test/api", {
        method: "POST",
        body: JSON.stringify({ confirm: "PURGE" }),
      }),
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      created: boolean;
      order: { dataEpoch: number };
    };
    expect(secondBody.created).toBe(true);
    expect(secondBody.order.dataEpoch).toBe(3);
  });
});
