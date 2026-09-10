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
  PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
  PURGE_SURFACE_REGISTRY_VERSION,
  PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
  type PurgeMarkerRepository,
} from "@sayhear/application";
import {
  PostgresDialogueStateRepository,
  PostgresEntityRepository,
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
const SELF_ENTITY_ID = "22222222-2222-7222-8222-222222222201";
const SELF_ENTITY_VERSION_ID = "22222222-2222-7222-8222-222222222202";
const PERSON_ENTITY_ID = "22222222-2222-7222-8222-222222222203";
const PERSON_ENTITY_VERSION_ID = "22222222-2222-7222-8222-222222222204";
const ENTITY_LABEL_EN_ID = "22222222-2222-7222-8222-222222222205";
const ENTITY_LABEL_ZH_ID = "22222222-2222-7222-8222-222222222206";
const ENTITY_MENTION_ID = "22222222-2222-7222-8222-222222222207";
const ENTITY_MENTION_CANDIDATE_ID = "22222222-2222-7222-8222-222222222208";
const MEMORY_CLAIM_ID = "22222222-2222-7222-8222-222222222209";
const MEMORY_CLAIM_VERSION_ID = "22222222-2222-7222-8222-22222222220a";
const QUALIFIER_ID = "22222222-2222-7222-8222-22222222220b";
const QUALIFIER_EVIDENCE_ID = "22222222-2222-7222-8222-22222222220c";
const CLAIM_EVIDENCE_LINK_ID = "22222222-2222-7222-8222-22222222220d";
const MEMORY_CANDIDATE_ID = "22222222-2222-7222-8222-22222222220e";
const CANDIDATE_EVIDENCE_LINK_ID = "22222222-2222-7222-8222-22222222220f";
const FORGET_REQUEST_ID = "22222222-2222-7222-8222-222222222210";
const FORGET_EXCLUSION_ID = "22222222-2222-7222-8222-222222222211";
const FORGET_REVERSAL_ID = "22222222-2222-7222-8222-222222222212";
const RESOLVER_HINT_ID = "22222222-2222-7222-8222-222222222213";
const RETRIEVAL_PROJECTION_ID = "22222222-2222-7222-8222-222222222214";
const RETRIEVAL_RUN_ID = "22222222-2222-7222-8222-222222222215";
const RETRIEVAL_CANDIDATE_ID = "22222222-2222-7222-8222-222222222216";
const FAST_PATH_WORKFLOW_ID = "22222222-2222-7222-8222-222222222217";
const FAST_PATH_OUTBOX_ID = "22222222-2222-7222-8222-222222222218";
const FAST_PATH_RUN_ID = "22222222-2222-7222-8222-222222222219";
const FAST_PATH_ITEM_ID = "22222222-2222-7222-8222-22222222221a";
const ENTITY_GATE_OUTCOME_ID = "22222222-2222-7222-8222-22222222221b";
const ENTITY_CLARIFICATION_ID = "22222222-2222-7222-8222-22222222221c";
const CONSOLIDATION_WORKFLOW_ID = "22222222-2222-7222-8222-22222222221d";
const CONSOLIDATION_OUTBOX_ID = "22222222-2222-7222-8222-22222222221e";
const CONSOLIDATION_RUN_ID = "22222222-2222-7222-8222-22222222221f";
const CONSOLIDATION_DIFF_ID = "22222222-2222-7222-8222-222222222220";
const ACTION_EXECUTION_ID = "22222222-2222-7222-8222-222222222221";
const ACTION_RECEIPT_ID = "22222222-2222-7222-8222-222222222222";
const CORRECTION_WORKFLOW_ID = "22222222-2222-7222-8222-222222222223";
const CORRECTION_OUTBOX_ID = "22222222-2222-7222-8222-222222222224";
const CORRECTION_FOLLOWUP_ID = "22222222-2222-7222-8222-222222222225";
const CLAIM_CORRECTION_ID = "22222222-2222-7222-8222-222222222226";
const IMPRESSION_VETO_ID = "22222222-2222-7222-8222-222222222227";
const SAFETY_POSTURE_ID = "22222222-2222-7222-8222-222222222228";
const SAFETY_POSTURE_ALERT_ID = "22222222-2222-7222-8222-222222222229";
const BIO_ID = "22222222-2222-7222-8222-222222222230";
const BIO_VERSION_ID = "22222222-2222-7222-8222-222222222231";
const BIO_STATEMENT_ID = "22222222-2222-7222-8222-222222222232";
const BIO_PROPOSITION_ID = "22222222-2222-7222-8222-222222222233";
const BIO_COVERAGE_UNIT_ID = "22222222-2222-7222-8222-222222222234";
const BIO_CLAIM_LINK_ID = "22222222-2222-7222-8222-222222222235";
const BIO_FINDING_ID = "22222222-2222-7222-8222-222222222236";
const ACTION_HANDLE = "purge-test-memory-handle";
const OTHER_OWNER = "33333333-3333-7333-8333-333333333301";
const OTHER_SESSION = "33333333-3333-7333-8333-333333333302";
const OTHER_WORKFLOW = "33333333-3333-7333-8333-333333333303";
const OTHER_OUTBOX = "33333333-3333-7333-8333-333333333304";
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
    INSERT INTO safety_postures (
      safety_posture_id, user_id, daily_session_id, version_no,
      source_revision, policy_version, content, committed_generation_command_id,
      created_at
    ) VALUES (
      '${SAFETY_POSTURE_ID}', '${OWNER}', '${S1}', 1, 1, 'safety-posture:v1',
      '{"state":"active","kind":"imminent_danger","cleanTurnCount":0,"evidence":{"activatedUserEventRevisionId":"${R1}","lastTurnUserEventRevisionId":"${R1}"}}'::jsonb,
      '${G1}', '${t1}'
    );
    INSERT INTO current_safety_postures (
      daily_session_id, safety_posture_id, user_id, source_revision, version_no,
      updated_at
    ) VALUES ('${S1}', '${SAFETY_POSTURE_ID}', '${OWNER}', 1, 1, '${t1}');
    INSERT INTO safety_posture_alerts (
      safety_posture_alert_id, user_id, daily_session_id, generation_command_id,
      policy_version, reason, occurred_at, created_at
    ) VALUES (
      '${SAFETY_POSTURE_ALERT_ID}', '${OWNER}', '${S1}', '${G1}',
      'safety-posture:v1', 'detector_failure', '${t1}', '${t1}'
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

async function seedMemoryPurgeData(pool: IsolatedPostgresSchema["pool"]) {
  const createdAt = "2026-08-12T15:02:00.000Z";
  const expiresAt = "2026-08-19T15:02:00.000Z";
  await pool.query(
    `
      INSERT INTO entities (entity_id, user_id, created_at)
      VALUES
        ('${SELF_ENTITY_ID}', '${OWNER}', '${createdAt}'),
        ('${PERSON_ENTITY_ID}', '${OWNER}', '${createdAt}');
      INSERT INTO user_self_entities (user_id, entity_id, created_at)
      VALUES ('${OWNER}', '${SELF_ENTITY_ID}', '${createdAt}');
      INSERT INTO entity_versions (
        entity_version_id, entity_id, user_id, revision, entity_kind_id,
        status, created_at
      ) VALUES
        ('${SELF_ENTITY_VERSION_ID}', '${SELF_ENTITY_ID}', '${OWNER}', 1,
          'sh.entity.person', 'active', '${createdAt}'),
        ('${PERSON_ENTITY_VERSION_ID}', '${PERSON_ENTITY_ID}', '${OWNER}', 1,
          'sh.entity.person', 'active', '${createdAt}');
      UPDATE entities SET current_version_id = (CASE entity_id
        WHEN '${SELF_ENTITY_ID}' THEN '${SELF_ENTITY_VERSION_ID}'
        WHEN '${PERSON_ENTITY_ID}' THEN '${PERSON_ENTITY_VERSION_ID}'
      END)::uuid
      WHERE user_id = '${OWNER}';
      INSERT INTO entity_labels (
        entity_label_id, entity_id, user_id, locale, label,
        normalized_label, label_kind, is_current, source_evidence_id, created_at
      ) VALUES
        ('${ENTITY_LABEL_EN_ID}', '${PERSON_ENTITY_ID}', '${OWNER}', 'en',
          'Morgan', 'morgan', 'alias', TRUE, '${EI1}', '${createdAt}'),
        ('${ENTITY_LABEL_ZH_ID}', '${PERSON_ENTITY_ID}', '${OWNER}', 'zh',
          '摩根', '摩根', 'alias', TRUE, '${EI1}', '${createdAt}');
      INSERT INTO entity_mentions (
        entity_mention_id, user_id, conversation_event_id, event_revision_id,
        evidence_id, locator_type, mention_kind, resolved_entity_id,
        resolution_status, confidence, resolver_policy_version, created_at
      ) VALUES (
        '${ENTITY_MENTION_ID}', '${OWNER}', '${E1}', '${R1}', '${EI1}',
        'whole_revision', 'named', '${PERSON_ENTITY_ID}', 'resolved', 0.98,
        'entity-resolve:v1', '${createdAt}'
      );
      INSERT INTO entity_mention_candidates (
        entity_mention_candidate_id, entity_mention_id, user_id,
        candidate_entity_id, matched_label, candidate_kind, edit_distance,
        created_at
      ) VALUES (
        '${ENTITY_MENTION_CANDIDATE_ID}', '${ENTITY_MENTION_ID}', '${OWNER}',
        '${PERSON_ENTITY_ID}', 'Morgan', 'near_form', 0, '${createdAt}'
      );
      INSERT INTO memory_claims (
        memory_claim_id, user_id, canonical_key, subject_entity_id,
        object_entity_id, predicate_id, scope_key, created_at
      ) VALUES (
        '${MEMORY_CLAIM_ID}', '${OWNER}',
        'self|person|sh.relationship.family|default', '${SELF_ENTITY_ID}',
        '${PERSON_ENTITY_ID}', 'sh.relationship.family', 'default', '${createdAt}'
      );
      INSERT INTO memory_claim_versions (
        memory_claim_version_id, memory_claim_id, user_id, revision, kind,
        epistemic_status, status, subject_entity_version_id,
        object_entity_version_id, typed_value, confidence, temporal_status,
        valid_from_precision, valid_to_precision, last_observed_at,
        created_by, model_version, prompt_version,
        predicate_registry_version, created_at
      ) VALUES (
        '${MEMORY_CLAIM_VERSION_ID}', '${MEMORY_CLAIM_ID}', '${OWNER}', 1,
        'objective', 'confirmed', 'active', '${SELF_ENTITY_VERSION_ID}',
        '${PERSON_ENTITY_VERSION_ID}', '"family"'::jsonb, 0.99, 'current',
        'unknown', 'unknown', '${createdAt}', 'memory_admission',
        'memory-model:v1', 'memory-prompt:v1', 1, '${createdAt}'
      );
      UPDATE memory_claims
      SET current_version_id = '${MEMORY_CLAIM_VERSION_ID}'
      WHERE memory_claim_id = '${MEMORY_CLAIM_ID}';
      INSERT INTO memory_claim_version_qualifiers (
        memory_claim_version_qualifier_id, memory_claim_version_id, user_id,
        axis_id, role_side, typed_value, created_by, created_at
      ) VALUES (
        '${QUALIFIER_ID}', '${MEMORY_CLAIM_VERSION_ID}', '${OWNER}',
        'kinship_term', 'canonical_subject', '"family"'::jsonb,
        'memory_admission', '${createdAt}'
      );
      INSERT INTO memory_claim_version_qualifier_evidence (
        memory_claim_version_qualifier_evidence_id,
        memory_claim_version_qualifier_id, user_id, evidence_item_id, created_at
      ) VALUES (
        '${QUALIFIER_EVIDENCE_ID}', '${QUALIFIER_ID}', '${OWNER}', '${EI1}',
        '${createdAt}'
      );
      INSERT INTO claim_evidence_links (
        claim_evidence_link_id, memory_claim_version_id, user_id,
        evidence_item_id, link_role, created_at
      ) VALUES (
        '${CLAIM_EVIDENCE_LINK_ID}', '${MEMORY_CLAIM_VERSION_ID}', '${OWNER}',
        '${EI1}', 'support', '${createdAt}'
      );
      INSERT INTO memory_candidates (
        memory_candidate_id, user_id, candidate_kind, basis,
        subject_entity_id, subject_entity_mention_id, object_entity_id,
        predicate_id, predicate_registry_version, predicate_resolution_status,
        proposed_object_value, proposed_scope_key, proposed_temporal_status,
        proposed_valid_from_precision, proposed_valid_to_precision,
        extraction_policy_version, created_at
      ) VALUES (
        '${MEMORY_CANDIDATE_ID}', '${OWNER}', 'objective', 'directly_stated',
        '${SELF_ENTITY_ID}', '${ENTITY_MENTION_ID}', '${PERSON_ENTITY_ID}',
        'sh.relationship.family', 1, 'mapped', '"family"'::jsonb, 'default',
        'current', 'unknown', 'unknown', 'fast-path-extraction:v1', '${createdAt}'
      );
      INSERT INTO memory_candidate_evidence_links (
        memory_candidate_evidence_link_id, memory_candidate_id, user_id,
        evidence_item_id, created_at
      ) VALUES (
        '${CANDIDATE_EVIDENCE_LINK_ID}', '${MEMORY_CANDIDATE_ID}', '${OWNER}',
        '${EI1}', '${createdAt}'
      );
      INSERT INTO memory_forget_requests (
        memory_forget_request_id, user_id, request_event_revision_id,
        target_claim_id, target_scope, status, applied_claim_version_id,
        forget_policy_version, created_at
      ) VALUES (
        '${FORGET_REQUEST_ID}', '${OWNER}', '${R1}', '${MEMORY_CLAIM_ID}',
        'whole_claim', 'applied', '${MEMORY_CLAIM_VERSION_ID}',
        'memory-forget:v1', '${createdAt}'
      );
      INSERT INTO memory_forget_evidence_exclusions (
        memory_forget_evidence_exclusion_id, user_id, memory_forget_request_id,
        evidence_item_id, exclusion_scope, status, created_at
      ) VALUES (
        '${FORGET_EXCLUSION_ID}', '${OWNER}', '${FORGET_REQUEST_ID}', '${EI1}',
        'whole_claim', 'active', '${createdAt}'
      );
      INSERT INTO memory_forget_reversals (
        memory_forget_reversal_id, user_id, memory_forget_request_id,
        request_event_revision_id, reversal_evidence_id, status,
        applied_claim_version_id, forget_policy_version, created_at
      ) VALUES (
        '${FORGET_REVERSAL_ID}', '${OWNER}', '${FORGET_REQUEST_ID}', '${R1}',
        '${EI1}', 'active', '${MEMORY_CLAIM_VERSION_ID}', 'memory-forget:v1',
        '${createdAt}'
      );
      INSERT INTO relationship_resolver_hints (
        relationship_resolver_hint_id, user_id, memory_claim_id,
        memory_claim_version_id, resolved_entity_id, context_entity_id,
        view_direction, locale, temporal_form, role_side, role_term,
        role_source, phrase, rebuilt_at
      ) VALUES (
        '${RESOLVER_HINT_ID}', '${OWNER}', '${MEMORY_CLAIM_ID}',
        '${MEMORY_CLAIM_VERSION_ID}', '${PERSON_ENTITY_ID}', '${SELF_ENTITY_ID}',
        'forward', 'en', 'current', 'canonical_subject', 'family',
        'predicate_label', 'Morgan is family', '${createdAt}'
      );
      INSERT INTO claim_retrieval_projections (
        claim_retrieval_projection_id, user_id, memory_claim_id,
        memory_claim_version_id, locale, view_direction, retrieval_text,
        lexical_terms, projection_policy_version, status, created_at
      ) VALUES (
        '${RETRIEVAL_PROJECTION_ID}', '${OWNER}', '${MEMORY_CLAIM_ID}',
        '${MEMORY_CLAIM_VERSION_ID}', 'en', 'forward', 'Morgan is family',
        ARRAY['morgan', 'family'], 'memory-retrieval:v1', 'active', '${createdAt}'
      );
      INSERT INTO retrieval_runs (
        retrieval_run_id, user_id, daily_session_id, source_event_revision_id,
        compiled_context_id, retrieval_policy_version,
        query_construction_policy_version, projection_policy_version,
        query_source_refs, normalized_query_terms, lane_plan, deadline_ms,
        status, duration_ms, timings, started_at, completed_at
      ) VALUES (
        '${RETRIEVAL_RUN_ID}', '${OWNER}', '${S1}', '${R1}', '${CC1}',
        'memory-retrieval:v1', 'context-query:v1', 'memory-retrieval:v1',
        '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 200, 'completed', 4,
        '{}'::jsonb, '${createdAt}', '${createdAt}'
      );
      INSERT INTO retrieval_run_candidates (
        retrieval_run_candidate_id, retrieval_run_id, user_id,
        memory_claim_version_id, claim_retrieval_projection_id,
        retrieval_lane, matched_fields, matched_terms, trust_fence_results,
        rank_components, final_rank, selected_section, selection_reason_codes,
        rejection_reason_codes, created_at
      ) VALUES (
        '${RETRIEVAL_CANDIDATE_ID}', '${RETRIEVAL_RUN_ID}', '${OWNER}',
        '${MEMORY_CLAIM_VERSION_ID}', '${RETRIEVAL_PROJECTION_ID}',
        'structured_exact', '[]'::jsonb, '["family"]'::jsonb, '[]'::jsonb,
        '{}'::jsonb, 1, 'objective_memory', ARRAY['eligible'], ARRAY[]::text[],
        '${createdAt}'
      );
      INSERT INTO workflow_commands (
        workflow_command_id, command_type, subject_type, subject_id,
        source_revision, policy_version, expected_data_epoch, status,
        created_at
      ) VALUES
        ('${FAST_PATH_WORKFLOW_ID}', 'fast_path_extraction',
          'conversation_event_revision', '${R1}', 1,
          'fast-path-extraction:v1', 1, 'dispatched', '${createdAt}'),
        ('${CONSOLIDATION_WORKFLOW_ID}', 'daily_consolidation', 'app_user',
          '${OWNER}', 20260812, 'memory-consolidation:v1', 1, 'completed', '${createdAt}'),
        ('${CORRECTION_WORKFLOW_ID}', 'memory_correction_followup', 'memory_claim',
          '${MEMORY_CLAIM_ID}', 1, 'memory-correction:v1', 1, 'completed', '${createdAt}');
      INSERT INTO outbox_events (
        outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
        aggregate_revision, event_type, status, next_attempt_at, lease_owner,
        lease_expires_at, attempt_count, workflow_receipt_id, payload,
        created_at, aggregate_coverage, aggregate_data_epoch
      ) VALUES
        ('${FAST_PATH_OUTBOX_ID}', '${FAST_PATH_WORKFLOW_ID}',
          'conversation_event_revision', '${R1}', 1,
          'fast_path_extraction_requested', 'dispatched', '${createdAt}',
          'sayhear-memory-test', '${expiresAt}', 1, 'memory-wf-fast', '{}',
          '${createdAt}', 0, 1),
        ('${CONSOLIDATION_OUTBOX_ID}', '${CONSOLIDATION_WORKFLOW_ID}',
          'app_user', '${OWNER}', 20260812, 'daily_consolidation_requested',
          'dispatched', '${createdAt}', 'sayhear-memory-test', '${expiresAt}',
          1, 'memory-wf-consolidation', '{}', '${createdAt}', 0, 1),
        ('${CORRECTION_OUTBOX_ID}', '${CORRECTION_WORKFLOW_ID}', 'memory_claim',
          '${MEMORY_CLAIM_ID}', 1, 'memory_correction_followup_requested',
          'dispatched', '${createdAt}', 'sayhear-memory-test', '${expiresAt}',
          1, 'memory-wf-correction', '{}', '${createdAt}', 0, 1);
      INSERT INTO fast_path_extraction_runs (
        fast_path_run_id, user_id, daily_session_id, event_revision_id,
        event_conversation_event_id, extraction_policy_version,
        workflow_command_id, model_attempt_id, memory_extract_config_version,
        memory_extract_model_version, memory_extract_prompt_version, status,
        event_committed_at, extracted_at, visibility_lag_ms,
        visibility_target_met, item_count, mention_count, candidate_count,
        created_at, updated_at
      ) VALUES (
        '${FAST_PATH_RUN_ID}', '${OWNER}', '${S1}', '${R1}', '${E1}',
        'fast-path-extraction:v1', '${FAST_PATH_WORKFLOW_ID}', '${M1}',
        'memory-extract-config:v1', 'memory-extract-model:v1',
        'memory-extract-prompt:v1', 'extracted', '${createdAt}', '${createdAt}',
        10, TRUE, 1, 1, 1, '${createdAt}', '${createdAt}'
      );
      INSERT INTO fast_path_session_items (
        fast_path_item_id, user_id, daily_session_id, event_revision_id,
        fast_path_run_id, item_class, summary, memory_candidate_id,
        entity_mention_id, evidence_item_id, dedupe_key, created_at
      ) VALUES (
        '${FAST_PATH_ITEM_ID}', '${OWNER}', '${S1}', '${R1}',
        '${FAST_PATH_RUN_ID}', 'person', 'Morgan family context',
        '${MEMORY_CANDIDATE_ID}', '${ENTITY_MENTION_ID}', '${EI1}',
        'memory-purge-fixture', '${createdAt}'
      );
      INSERT INTO entity_resolve_gate_outcomes (
        entity_resolve_gate_outcome_id, user_id, entity_mention_id,
        gate_policy_version, resolver_policy_version, t_auto, verdict,
        selected_entity_id, confidence, candidate_count, committed, created_at
      ) VALUES (
        '${ENTITY_GATE_OUTCOME_ID}', '${OWNER}', '${ENTITY_MENTION_ID}',
        'entity-resolve-gate:v1', 'entity-resolve:v1', 0.9, 'match',
        '${PERSON_ENTITY_ID}', 0.98, 1, TRUE, '${createdAt}'
      );
      INSERT INTO entity_clarification_proposals (
        entity_clarification_proposal_id, user_id, daily_session_id,
        event_revision_id, entity_mention_id, topic_key, semantic_impact,
        status, question_text, created_at
      ) VALUES (
        '${ENTITY_CLARIFICATION_ID}', '${OWNER}', '${S1}', '${R1}',
        '${ENTITY_MENTION_ID}', 'family', 'relationship_attribution',
        'committed', 'Which Morgan do you mean?', '${createdAt}'
      );
      INSERT INTO memory_consolidation_runs (
        memory_consolidation_run_id, user_id, consolidation_kind, anchor_date,
        policy_version, workflow_command_id, expected_data_epoch,
        model_attempt_id, consolidate_config_version,
        consolidate_model_version, consolidate_prompt_version, status,
        diff_count, promoted_count, created_at, updated_at
      ) VALUES (
        '${CONSOLIDATION_RUN_ID}', '${OWNER}', 'daily', '2026-08-12',
        'memory-consolidation:v1', '${CONSOLIDATION_WORKFLOW_ID}', 1, '${M1}',
        'consolidate-config:v1', 'consolidate-model:v1', 'consolidate-prompt:v1',
        'consolidated', 1, 1, '${createdAt}', '${createdAt}'
      );
      INSERT INTO memory_consolidation_diffs (
        memory_consolidation_diff_id, memory_consolidation_run_id, user_id,
        diff_index, diff_kind, memory_candidate_id, memory_claim_id, outcome,
        reason_code, created_at
      ) VALUES (
        '${CONSOLIDATION_DIFF_ID}', '${CONSOLIDATION_RUN_ID}', '${OWNER}', 0,
        'reinforce_existing', '${MEMORY_CANDIDATE_ID}', '${MEMORY_CLAIM_ID}',
        'reinforced', 'fixture', '${createdAt}'
      );
      INSERT INTO conversation_action_executions (
        action_execution_id, user_id, decision_command_id,
        request_event_revision_id, action_kind, schema_version, catalog_version,
        target_kind, daily_session_id, source_revision, expected_data_epoch,
        idempotency_key, admission_status, execution_status, disposition,
        created_at, resolved_claim_id, resolved_claim_version_id,
        resolved_qualifier_id
      ) VALUES (
        '${ACTION_EXECUTION_ID}', '${OWNER}', '${G1}', '${R1}',
        'memory_forget', 'memory-action:v1', 'conversation-action-catalog:v1',
        'relationship_qualifier', '${S1}', 1, 1, 'memory-purge-action',
        'accepted', 'succeeded', 'applied', '${createdAt}', '${MEMORY_CLAIM_ID}',
        '${MEMORY_CLAIM_VERSION_ID}', '${QUALIFIER_ID}'
      );
      INSERT INTO conversation_action_receipts (
        action_receipt_id, action_execution_id, receipt_sequence,
        admission_status, execution_status, disposition, created_at, receipt_key,
        resolved_claim_id, resolved_claim_version_id, resolved_qualifier_id,
        disposition_detail
      ) VALUES (
        '${ACTION_RECEIPT_ID}', '${ACTION_EXECUTION_ID}', 1, 'accepted',
        'succeeded', 'applied', '${createdAt}', 'admission', '${MEMORY_CLAIM_ID}',
        '${MEMORY_CLAIM_VERSION_ID}', '${QUALIFIER_ID}', '{}'::jsonb
      );
      INSERT INTO conversation_action_payloads (
        action_execution_id, payload_schema_version, ciphertext, expires_at
      ) VALUES (
        '${ACTION_EXECUTION_ID}', 'memory-action:v1', decode('00', 'hex'), '${expiresAt}'
      );
      INSERT INTO conversation_action_handles (
        handle, compiled_context_id, user_id, generation_command_id, action_kind,
        target_kind, source_revision, expected_data_epoch, created_at, expires_at,
        target_claim_id, target_claim_version_id, target_qualifier_id
      ) VALUES (
        '${ACTION_HANDLE}', '${CC1}', '${OWNER}', '${G1}', 'memory_forget',
        'relationship_qualifier', 1, 1, '${createdAt}', '${expiresAt}',
        '${MEMORY_CLAIM_ID}', '${MEMORY_CLAIM_VERSION_ID}', '${QUALIFIER_ID}'
      );
      UPDATE workflow_commands
      SET action_execution_id = '${ACTION_EXECUTION_ID}'
      WHERE workflow_command_id = '${CORRECTION_WORKFLOW_ID}';
      INSERT INTO memory_claim_corrections (
        memory_claim_correction_id, user_id, request_event_revision_id,
        target_claim_id, deactivated_claim_version_id, target_scope,
        corrected_fact_recorded, correction_policy_version, created_at
      ) VALUES (
        '${CLAIM_CORRECTION_ID}', '${OWNER}', '${R1}', '${MEMORY_CLAIM_ID}',
        '${MEMORY_CLAIM_VERSION_ID}', 'whole_claim', FALSE,
        'memory-correction:v1', '${createdAt}'
      );
      INSERT INTO memory_impression_vetoes (
        memory_impression_veto_id, user_id, memory_claim_id,
        vetoed_claim_version_id, request_event_revision_id, status,
        impression_correction_policy_version, created_at
      ) VALUES (
        '${IMPRESSION_VETO_ID}', '${OWNER}', '${MEMORY_CLAIM_ID}',
        '${MEMORY_CLAIM_VERSION_ID}', '${R1}', 'active', 'memory-correction:v1',
        '${createdAt}'
      );
      INSERT INTO memory_correction_followups (
        memory_correction_followup_id, user_id, workflow_command_id,
        action_execution_id, target_claim_id, affected_journal_statement_count,
        followup_policy_version, created_at
      ) VALUES (
        '${CORRECTION_FOLLOWUP_ID}', '${OWNER}', '${CORRECTION_WORKFLOW_ID}',
        '${ACTION_EXECUTION_ID}', '${MEMORY_CLAIM_ID}', 1,
        'memory-correction-followup:v1', '${createdAt}'
      );
    `,
  );
}

async function seedOtherOwnerWorkflowData(pool: IsolatedPostgresSchema["pool"]) {
  const startedAt = "2026-08-12T15:03:00.000Z";
  await pool.query(`
    INSERT INTO app_users (user_id, status, data_epoch)
    VALUES ('${OTHER_OWNER}', 'active', 1);
    INSERT INTO daily_sessions (
      daily_session_id, user_id, logical_date, timezone_at_start, started_at,
      last_activity_at, activity_state, current_continuous_exchange_no,
      dialogue_revision, source_revision, next_turn_sequence_no,
      next_event_sequence_no, created_at, updated_at
    ) VALUES (
      '${OTHER_SESSION}', '${OTHER_OWNER}', '2026-08-12', 'UTC', '${startedAt}',
      '${startedAt}', 'active', 1, 0, 0, 1, 1, '${startedAt}', '${startedAt}'
    );
    INSERT INTO workflow_commands (
      workflow_command_id, command_type, subject_type, subject_id,
      source_revision, policy_version, expected_data_epoch, status, created_at
    ) VALUES (
      '${OTHER_WORKFLOW}', 'journal_eligibility', 'daily_session',
      '${OTHER_SESSION}', 0, 'journal-eligibility:v1', 1, 'created', '${startedAt}'
    );
    INSERT INTO outbox_events (
      outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
      aggregate_revision, event_type, status, next_attempt_at, attempt_count,
      payload, created_at, aggregate_coverage, aggregate_data_epoch
    ) VALUES (
      '${OTHER_OUTBOX}', '${OTHER_WORKFLOW}', 'daily_session', '${OTHER_SESSION}',
      0, 'journal_eligibility_requested', 'pending', '${startedAt}', 0,
      '{}'::jsonb, '${startedAt}', 0, 1
    );
  `);
}

describe("Internal Owner Full Purge system seam — 1A.3a operator-only purge", () => {
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
        narrative_validator_results,
        narrative_validator_requests,
        episode_impact_reviews,
        episode_build_runs,
        episode_version_entity_links,
        episode_evidence_links,
        episode_candidate_entity_links,
        episode_candidate_evidence_links,
        episode_candidates,
        episode_versions,
        episodes,
        open_loop_closure_audits,
        open_loop_expiry_runs,
        open_loop_run_outcomes,
        open_loop_versions,
        open_loops,
        entity_identity_revalidation_runs,
        journal_identity_review_fences,
        journal_statement_entity_links,
        entity_identity_corrections,
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
        candidate_review_audits,
        predicate_change_proposal_candidate_links,
        claim_evidence_links,
        memory_claim_versions,
        memory_claims,
        entity_mentions,
        entity_labels,
        user_self_entities,
        entity_versions,
        entities,
        owner_purge_operational_metadata,
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
        reflection_runs,
        reflection_candidate_proposals,
        reflection_statement_evidence_links,
        reflection_atomic_propositions,
        reflection_statements,
        reflection_versions,
        reflections,
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
    expect(order.purgeSurfaceRegistryVersion).toBe(
      PURGE_SURFACE_REGISTRY_VERSION,
    );

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
    const workflowVersion = await database.pool.query<{
      purge_surface_registry_version: string;
    }>(
      "SELECT purge_surface_registry_version FROM workflow_commands WHERE command_type = 'owner_full_purge'",
    );
    expect(workflowVersion.rows[0]?.purge_surface_registry_version).toBe(
      PURGE_SURFACE_REGISTRY_VERSION,
    );

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

  it("fails closed when an owner-scoped table is added after the registry is loaded", async () => {
    await database.pool.query(
      `CREATE TABLE unregistered_private_surface (
         unregistered_private_surface_id UUID PRIMARY KEY,
         user_id UUID NOT NULL REFERENCES app_users(user_id)
       )`,
    );
    try {
      await expect(
        purgeRepository.startOrder({
          confirmation: "PURGE",
          now: clock(),
          policyVersion: "owner-full-purge:v1",
          userId: OWNER,
        }),
      ).rejects.toThrow(/database_inventory_mismatch/);
      await expect(
        database.pool.query(
          "SELECT status, data_epoch::text FROM app_users WHERE user_id = $1",
          [OWNER],
        ),
      ).resolves.toMatchObject({
        rows: [{ status: "active", data_epoch: "1" }],
      });
    } finally {
      await database.pool.query("DROP TABLE unregistered_private_surface");
    }
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
      "journal_statement_entity_links",
      "journal_identity_review_fences",
      "entity_identity_corrections",
      "entity_identity_revalidation_runs",
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
      "safety_posture_alerts",
      "current_safety_postures",
      "safety_postures",
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
    const audit = await database.pool.query<{
      target_type: string;
      target_id: string | null;
    }>(
      "SELECT target_type, target_id FROM sensitive_access_audits WHERE user_id = $1",
      [OWNER],
    );
    expect(audit.rows).toEqual([
      { target_type: "purged_owner", target_id: null },
    ]);
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

    const operationalMetadataBeforeSweep = await countRows(
      `SELECT 1 FROM owner_purge_operational_metadata
       WHERE owner_purge_order_id = '${order.ownerPurgeOrderId}'`,
    );
    expect(operationalMetadataBeforeSweep).toBeGreaterThan(0);
    expect(
      await countRows(
        `SELECT 1 FROM owner_purge_operational_metadata
         WHERE owner_purge_order_id = '${order.ownerPurgeOrderId}'
           AND surface_id IN (
             'generation_commands', 'model_run_attempts',
             'workflow_commands', 'outbox_events',
             'provider_egress_dispositions'
           )`,
      ),
    ).toBeGreaterThan(0);

    // Redacted access envelopes remain readable until the inclusive 30-day
    // deadline, then the late sweeper removes them using the original purge
    // effective time.
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;
    await expect(
      purgeRepository.sweepExpiredMetadata({
        now: new Date(BASE_TIME.getTime() + thirtyDaysMs - 1),
      }),
    ).resolves.toEqual({ deleted: 0 });
    await expect(
      purgeRepository.sweepExpiredMetadata({
        now: new Date(BASE_TIME.getTime() + thirtyDaysMs),
      }),
    ).resolves.toEqual({ deleted: operationalMetadataBeforeSweep + 1 });
    expect(await countRows("SELECT 1 FROM sensitive_access_audits")).toBe(0);
    expect(await countRows("SELECT 1 FROM owner_purge_operational_metadata")).toBe(0);
  });

  it("clears the typed Bio aggregate and every owner-scoped Bio child surface", async () => {
    const createdAt = BASE_TIME.toISOString();
    await database.pool.query(`
      INSERT INTO bios (
        bio_id, user_id, current_source_revision, current_data_epoch,
        created_at, updated_at
      ) VALUES (
        '${BIO_ID}', '${OWNER}', 8, 1, '${createdAt}', '${createdAt}'
      );
      INSERT INTO bio_versions (
        bio_version_id, bio_id, user_id, revision, status, source_revision,
        expected_data_epoch, source_manifest, presentation_locale,
        generation_command_id, writer_model_run_attempt_id,
        validator_generation_command_id, validator_model_run_attempt_id,
        created_at
      ) VALUES (
        '${BIO_VERSION_ID}', '${BIO_ID}', '${OWNER}', 1, 'published', 8, 1,
        '{"source":"synthetic"}'::jsonb, 'en-US', '${G1}', '${M1}',
        '${G1}', '${M1}', '${createdAt}'
      );
      UPDATE bios
      SET current_version_id = '${BIO_VERSION_ID}'
      WHERE bio_id = '${BIO_ID}' AND user_id = '${OWNER}';
      INSERT INTO bio_statements (
        bio_statement_id, bio_version_id, bio_id, user_id, ordinal,
        section_key, statement_key, statement_text, created_at
      ) VALUES (
        '${BIO_STATEMENT_ID}', '${BIO_VERSION_ID}', '${BIO_ID}', '${OWNER}',
        0, 'identity', 'synthetic.identity', 'Synthetic statement', '${createdAt}'
      );
      INSERT INTO bio_atomic_propositions (
        bio_atomic_proposition_id, bio_version_id, bio_id, user_id,
        proposition_key, proposition_text, created_at
      ) VALUES (
        '${BIO_PROPOSITION_ID}', '${BIO_VERSION_ID}', '${BIO_ID}', '${OWNER}',
        'synthetic.proposition', 'Synthetic proposition', '${createdAt}'
      );
      INSERT INTO bio_claim_links (
        bio_claim_link_id, bio_version_id, bio_id, user_id,
        memory_claim_version_id, link_role, support_status,
        source_revision, expected_data_epoch, created_at
      ) VALUES (
        '${BIO_CLAIM_LINK_ID}', '${BIO_VERSION_ID}', '${BIO_ID}', '${OWNER}',
        '${MEMORY_CLAIM_VERSION_ID}', 'support', 'eligible', 8, 1, '${createdAt}'
      );
      INSERT INTO bio_coverage_units (
        bio_coverage_unit_id, bio_version_id, bio_id, user_id, unit_key,
        disposition, coverage_policy_version, source_revision,
        expected_data_epoch, created_at
      ) VALUES (
        '${BIO_COVERAGE_UNIT_ID}', '${BIO_VERSION_ID}', '${BIO_ID}', '${OWNER}',
        'synthetic.background', 'covered', 'bio-coverage:v1', 8, 1, '${createdAt}'
      );
      INSERT INTO bio_coverage_members (
        bio_coverage_unit_id, bio_version_id, user_id,
        memory_claim_version_id, created_at
      ) VALUES (
        '${BIO_COVERAGE_UNIT_ID}', '${BIO_VERSION_ID}', '${OWNER}',
        '${MEMORY_CLAIM_VERSION_ID}', '${createdAt}'
      );
      INSERT INTO bio_validation_findings (
        bio_validation_finding_id, bio_version_id, bio_id, user_id,
        bio_statement_id, bio_atomic_proposition_id, finding_code,
        severity, disposition, created_at
      ) VALUES (
        '${BIO_FINDING_ID}', '${BIO_VERSION_ID}', '${BIO_ID}', '${OWNER}',
        '${BIO_STATEMENT_ID}', '${BIO_PROPOSITION_ID}', 'synthetic.warning',
        'warning', 'open', '${createdAt}'
      );
    `);

    const { order } = await startPurgeOrder();
    await expect(
      purgeService.propagate({ ownerPurgeOrderId: order.ownerPurgeOrderId }),
    ).resolves.toMatchObject({ status: "retention_pending" });

    for (const table of [
      "bios",
      "bio_versions",
      "bio_statements",
      "bio_atomic_propositions",
      "bio_claim_links",
      "bio_coverage_units",
      "bio_coverage_members",
      "bio_validation_findings",
    ]) {
      expect(await countRows(`SELECT 1 FROM ${table}`)).toBe(0);
    }
  });

  it("purges the Entity, Memory, fast-path, relationship, retrieval, and Inspector data face while retaining only contentless identity envelopes", async () => {
    await seedMemoryPurgeData(database.pool);
    await seedOtherOwnerWorkflowData(database.pool);
    const { order } = await startPurgeOrder();

    await expect(
      purgeService.propagate({ ownerPurgeOrderId: order.ownerPurgeOrderId }),
    ).resolves.toMatchObject({ status: "retention_pending" });

    for (const table of [
      "entity_labels",
      "entity_mentions",
      "entity_mention_candidates",
      "memory_candidates",
      "memory_candidate_evidence_links",
      "memory_forget_requests",
      "memory_forget_evidence_exclusions",
      "memory_forget_reversals",
      "relationship_resolver_hints",
      "claim_evidence_links",
      "memory_claim_version_qualifier_evidence",
      "claim_retrieval_projections",
      "retrieval_run_candidates",
      "retrieval_runs",
      "fast_path_session_items",
      "entity_resolve_gate_outcomes",
      "entity_clarification_proposals",
      "fast_path_extraction_runs",
      "memory_consolidation_diffs",
      "memory_consolidation_runs",
      "memory_claim_corrections",
      "memory_impression_vetoes",
      "memory_correction_followups",
      "conversation_action_handles",
      "conversation_action_payloads",
      "conversation_action_receipts",
      "conversation_action_executions",
    ]) {
      expect(await countRows(`SELECT 1 FROM ${table}`)).toBe(0);
    }
    for (const workflowCommandId of [
      WC1,
      FAST_PATH_WORKFLOW_ID,
      CONSOLIDATION_WORKFLOW_ID,
      CORRECTION_WORKFLOW_ID,
    ]) {
      expect(
        await countRows(
          `SELECT 1 FROM workflow_commands
           WHERE workflow_command_id = '${workflowCommandId}'`,
        ),
      ).toBe(0);
    }
    for (const outboxEventId of [
      OE1,
      FAST_PATH_OUTBOX_ID,
      CONSOLIDATION_OUTBOX_ID,
      CORRECTION_OUTBOX_ID,
    ]) {
      expect(
        await countRows(
          `SELECT 1 FROM outbox_events
           WHERE outbox_event_id = '${outboxEventId}'`,
        ),
      ).toBe(0);
    }

    const purgedClaim = await database.pool.query<{
      canonical_key: string | null;
      content_purged_at: Date | null;
      current_version_id: string | null;
      deleted_at: Date | null;
      object_entity_id: string | null;
      predicate_id: string | null;
      scope_key: string | null;
      subject_entity_id: string | null;
    }>(
      `SELECT canonical_key, content_purged_at, current_version_id, deleted_at,
              object_entity_id, predicate_id, scope_key, subject_entity_id
       FROM memory_claims
       WHERE memory_claim_id = $1 AND user_id = $2`,
      [MEMORY_CLAIM_ID, OWNER],
    );
    expect(purgedClaim.rows[0]).toMatchObject({
      canonical_key: null,
      current_version_id: null,
      object_entity_id: null,
      predicate_id: null,
      scope_key: null,
      subject_entity_id: null,
    });
    expect(purgedClaim.rows[0]?.content_purged_at).not.toBeNull();
    expect(purgedClaim.rows[0]?.deleted_at).not.toBeNull();

    const purgedClaimVersion = await database.pool.query<{
      content_purged_at: Date | null;
      object_entity_version_id: string | null;
      subject_entity_version_id: string | null;
      temporal_status: string | null;
      typed_value: unknown;
      valid_from: Date | null;
      valid_from_precision: string | null;
      valid_to: Date | null;
      valid_to_precision: string | null;
    }>(
      `SELECT content_purged_at, object_entity_version_id,
              subject_entity_version_id, temporal_status, typed_value,
              valid_from, valid_from_precision, valid_to, valid_to_precision
       FROM memory_claim_versions
       WHERE memory_claim_version_id = $1 AND user_id = $2`,
      [MEMORY_CLAIM_VERSION_ID, OWNER],
    );
    expect(purgedClaimVersion.rows[0]).toMatchObject({
      object_entity_version_id: null,
      subject_entity_version_id: null,
      temporal_status: null,
      typed_value: null,
      valid_from: null,
      valid_from_precision: null,
      valid_to: null,
      valid_to_precision: null,
    });
    expect(purgedClaimVersion.rows[0]?.content_purged_at).not.toBeNull();
    expect(purgedClaimVersion.rows[0]?.typed_value).toBeNull();

    const purgedQualifier = await database.pool.query<{
      content_purged_at: Date | null;
      typed_value: unknown;
    }>(
      `SELECT content_purged_at, typed_value
       FROM memory_claim_version_qualifiers
       WHERE memory_claim_version_qualifier_id = $1 AND user_id = $2`,
      [QUALIFIER_ID, OWNER],
    );
    expect(purgedQualifier.rows[0]?.content_purged_at).not.toBeNull();
    expect(purgedQualifier.rows[0]?.typed_value).toBeNull();

    const entities = await database.pool.query<{
      entity_id: string;
      current_version_id: string | null;
      deleted_at: Date | null;
    }>(
      `SELECT entity_id, current_version_id, deleted_at
       FROM entities
       WHERE user_id = $1
       ORDER BY entity_id`,
      [OWNER],
    );
    expect(entities.rows).toEqual([
      {
        entity_id: SELF_ENTITY_ID,
        current_version_id: SELF_ENTITY_VERSION_ID,
        deleted_at: null,
      },
      {
        entity_id: PERSON_ENTITY_ID,
        current_version_id: null,
        deleted_at: expect.any(Date),
      },
    ]);

    const selfBinding = await database.pool.query<{
      entity_id: string;
      status: string;
      content_purged_at: Date | null;
    }>(
      `SELECT binding.entity_id, version.status, version.content_purged_at
       FROM user_self_entities binding
       JOIN entities entity ON entity.entity_id = binding.entity_id
       JOIN entity_versions version ON version.entity_version_id = entity.current_version_id
       WHERE binding.user_id = $1`,
      [OWNER],
    );
    expect(selfBinding.rows).toEqual([
      {
        entity_id: SELF_ENTITY_ID,
        status: "active",
        content_purged_at: null,
      },
    ]);

    const purgedEntityVersion = await database.pool.query<{
      content_purged_at: Date | null;
    }>(
      `SELECT content_purged_at
       FROM entity_versions
       WHERE entity_version_id = $1 AND user_id = $2`,
      [PERSON_ENTITY_VERSION_ID, OWNER],
    );
    expect(purgedEntityVersion.rows[0]?.content_purged_at).not.toBeNull();

    // The shared GIN / FTS indexes remain schema-level rebuildable structures;
    // only this owner's projection rows disappear.
    const retrievalIndexes = await database.pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'claim_retrieval_projections'
         AND indexname IN (
           'claim_retrieval_projections_lexical_terms_idx',
           'claim_retrieval_projections_english_search_idx'
         )
       ORDER BY indexname`,
    );
    expect(retrievalIndexes.rows.map((row) => row.indexname)).toEqual([
      "claim_retrieval_projections_english_search_idx",
      "claim_retrieval_projections_lexical_terms_idx",
    ]);

    const vectorColumns = await database.pool.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND udt_name = 'vector'`,
    );
    expect(vectorColumns.rows).toHaveLength(0);

    // The polymorphic workflow table remains tenant-isolated even while this
    // owner loses all of its command and outbox records.
    expect(
      await countRows(
        `SELECT 1 FROM daily_sessions WHERE user_id = '${OTHER_OWNER}'`,
      ),
    ).toBe(1);
    expect(
      await countRows(
        `SELECT 1 FROM workflow_commands WHERE workflow_command_id = '${OTHER_WORKFLOW}'`,
      ),
    ).toBe(1);
    expect(
      await countRows(
        `SELECT 1 FROM outbox_events WHERE outbox_event_id = '${OTHER_OUTBOX}'`,
      ),
    ).toBe(1);
  });

  it("reapplies an external marker to an old backup without resurrecting memory or Inspector traces", async () => {
    await seedMemoryPurgeData(database.pool);
    // Model the restored backup carrying the terminal order that originally
    // produced the marker. Reapply must reopen this order for a fresh clear /
    // verify pass instead of treating the terminal row as already complete.
    await database.pool.query(
      `INSERT INTO owner_purge_orders (
         owner_purge_order_id, user_id, from_data_epoch, data_epoch,
         status, confirmation, policy_version,
         purge_surface_registry_version, external_integration_manifest_version,
         workflow_subject_manifest_version, requested_at,
         active_system_deleted_at, retention_pending_at, last_attempt_at
       ) VALUES (
         gen_random_uuid(), '${OWNER}', 1, 2, 'retention_pending', 'PURGE',
         'recovery-marker-reapply:v1', '${PURGE_SURFACE_REGISTRY_VERSION}',
         '${PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION}',
         '${PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION}',
         '${BASE_TIME.toISOString()}', '${BASE_TIME.toISOString()}',
         '${BASE_TIME.toISOString()}', '${BASE_TIME.toISOString()}'
       )`,
    );
    const providerRetentionUntil = new Date(
      BASE_TIME.getTime() + 30 * 24 * 60 * 60 * 1_000,
    );
    await markerRepository.writeMarker({
      userId: OWNER,
      dataEpoch: 2,
      purgedAt: BASE_TIME,
      backupRetentionUntil: new Date(
        BASE_TIME.getTime() + 20 * 24 * 60 * 60 * 1_000,
      ),
      receipts: [
        {
          destination: "business_database",
          destinationDisposition: "verified_deleted",
          providerRetentionUntil: null,
        },
        ...[
          "conversation.text",
          "evidence.extract",
          "journal.draft",
          "journal.validate",
          "summary.compress",
          "dialogue.state",
          "memory.extract",
          "memory.consolidate",
        ].map((role) => ({
          destination: `provider:${role}`,
          destinationDisposition: "retention_pending",
          providerRetentionUntil,
        })),
      ],
    });
    const markerBefore = await markerRepository.findMarker({
      dataEpoch: 2,
      userId: OWNER,
    });

    clockNowMs = BASE_TIME.getTime() + 5 * 24 * 60 * 60 * 1_000;
    await expect(
      purgeRepository.reapplyMarker({
        backupRetentionUntil: markerBefore?.backupRetentionUntil ?? null,
        userId: OWNER,
        dataEpoch: 2,
        purgedAt: markerBefore?.purgedAt ?? BASE_TIME,
        receipts: markerBefore?.receipts ?? [],
        now: clock(),
      }),
    ).resolves.toEqual({ outcome: "reapplied" });

    expect(
      await countRows(
        `SELECT 1 FROM memory_claims
         WHERE user_id = '${OWNER}' AND content_purged_at IS NULL`,
      ),
    ).toBe(0);
    const reappliedOrder = await purgeRepository.findLatestOrder({
      userId: OWNER,
    });
    expect(reappliedOrder?.activeSystemDeletedAt).toEqual(BASE_TIME);
    expect(reappliedOrder?.backupRetentionUntil).toEqual(
      new Date(BASE_TIME.getTime() + 20 * 24 * 60 * 60 * 1_000),
    );
    expect(
      await countRows(
        `SELECT 1 FROM retrieval_run_candidates
         WHERE user_id = '${OWNER}'`,
      ),
    ).toBe(0);
    expect(
      await countRows(
        `SELECT 1 FROM relationship_resolver_hints
         WHERE user_id = '${OWNER}'`,
      ),
    ).toBe(0);
    expect(
      await countRows(
        `SELECT 1 FROM claim_retrieval_projections
         WHERE user_id = '${OWNER}'`,
      ),
    ).toBe(0);
    expect(
      await countRows(
        `SELECT 1 FROM entities
         WHERE user_id = '${OWNER}' AND entity_id = '${PERSON_ENTITY_ID}'
           AND (current_version_id IS NOT NULL OR deleted_at IS NULL)`,
      ),
    ).toBe(0);
    expect(
      await countRows(
        `SELECT 1 FROM workflow_commands
         WHERE subject_id IN ('${S1}', '${MEMORY_CLAIM_ID}', '${PERSON_ENTITY_ID}', '${OWNER}')`,
      ),
    ).toBe(0);
    expect(
      await countRows(
        `SELECT 1 FROM user_self_entities
         WHERE user_id = '${OWNER}'`,
      ),
    ).toBe(1);
    await expect(markerRepository.findMarker({ dataEpoch: 2, userId: OWNER })).resolves.toEqual(
      markerBefore,
    );

    const owner = await database.pool.query<{
      status: string;
      data_epoch: string;
    }>(
      "SELECT status, data_epoch::text FROM app_users WHERE user_id = $1",
      [OWNER],
    );
    expect(owner.rows[0]).toMatchObject({ status: "active", data_epoch: "2" });
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

    // Fast-path entity writes carry the frozen epoch all the way into their
    // transaction. The owner lock rejects both provisioning and mention
    // resolution once the purge has advanced the owner out of the active
    // state, before either path can create a row.
    const entityRepository = new PostgresEntityRepository(database.pool);
    await expect(
      entityRepository.ensureSelfEntity({
        expectedDataEpoch: 1,
        now: clock(),
        userId: OWNER,
      }),
    ).rejects.toThrow(/fenced by the owner data epoch/);
    await expect(
      entityRepository.resolveMentions({
        eventRevisionId: R1,
        expectedDataEpoch: 1,
        now: clock(),
        proposals: [],
        resolverPolicyVersion: "entity-resolution:v2",
        userId: OWNER,
      }),
    ).rejects.toThrow(/fenced by the owner data epoch/);

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
    // The race winner is scheduling-dependent; the contract is that both
    // calls converge on ONE order with exactly one created=true (issue #27).
    const [winner, loser] = first.created ? [first, second] : [second, first];
    expect(loser.created).toBe(false);
    expect(loser.order.ownerPurgeOrderId).toBe(winner.order.ownerPurgeOrderId);

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

  it("concurrent propagation reuses the durable purge time and marker receipts", async () => {
    const { order } = await startPurgeOrder();
    let writeCount = 0;
    let releaseFirstWrite: () => void = () => undefined;
    let resolveSecondWrite: () => void = () => undefined;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const secondWriteFinished = new Promise<void>((resolve) => {
      resolveSecondWrite = resolve;
    });
    const concurrentMarkerRepository: PurgeMarkerRepository = {
      findLatestMarker: (input) => markerRepository.findLatestMarker(input),
      writeMarker: async (input) => {
        writeCount += 1;
        if (writeCount === 1) {
          await firstWriteBlocked;
        }
        await markerRepository.writeMarker(input);
        if (writeCount === 2) {
          resolveSecondWrite();
        }
      },
    };
    const concurrentPurgeService = createOwnerFullPurgeService({
      clock,
      markerRepository: concurrentMarkerRepository,
      providerRetentionDays: 30,
      repository: purgeRepository,
    });

    const first = concurrentPurgeService.propagate({
      ownerPurgeOrderId: order.ownerPurgeOrderId,
    });
    const second = concurrentPurgeService.propagate({
      ownerPurgeOrderId: order.ownerPurgeOrderId,
    });
    await secondWriteFinished;
    releaseFirstWrite();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "retention_pending" },
      { status: "retention_pending" },
    ]);

    const marker = await markerRepository.findMarker({
      dataEpoch: order.dataEpoch,
      userId: OWNER,
    });
    expect(marker?.purgedAt).toEqual(BASE_TIME);
    expect(marker?.backupRetentionUntil).toEqual(
      new Date(BASE_TIME.getTime() + 30 * 24 * 60 * 60 * 1_000),
    );
    expect(marker?.receipts.filter((receipt) =>
      receipt.destination.startsWith("provider:"),
    )).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerRetentionUntil: new Date(
            BASE_TIME.getTime() + 30 * 24 * 60 * 60 * 1_000,
          ),
        }),
      ]),
    );
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
    clockNowMs = BASE_TIME.getTime() + 5 * 24 * 60 * 60 * 1_000;
    await purgeService.propagate({ ownerPurgeOrderId: order.ownerPurgeOrderId });
    const marker = await markerRepository.findMarker({
      dataEpoch: 2,
      userId: OWNER,
    });
    expect(marker?.status).toBe("retention_pending");
    expect(marker?.purgedAt).toEqual(BASE_TIME);
    expect(marker?.backupRetentionUntil).toEqual(
      new Date(BASE_TIME.getTime() + 30 * 24 * 60 * 60 * 1_000),
    );
    expect(marker?.receipts.filter((receipt) => receipt.destination.startsWith("provider:"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerRetentionUntil: new Date(
            BASE_TIME.getTime() + 30 * 24 * 60 * 60 * 1_000,
          ),
        }),
      ]),
    );
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
      reason: "verification_failed",
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

  it("rejects non-allowlisted purge attention reasons at the repository boundary", async () => {
    const { order } = await startPurgeOrder();
    await expect(
      purgeRepository.markNeedsAttention({
        now: clock(),
        ownerPurgeOrderId: order.ownerPurgeOrderId,
        reason: "provider response contained private text" as never,
      }),
    ).rejects.toThrow("allowlisted error code");

    const unchanged = await purgeRepository.findOrder({
      ownerPurgeOrderId: order.ownerPurgeOrderId,
    });
    expect(unchanged?.status).toBe("requested");
    expect(unchanged?.needsAttentionReason).toBeNull();
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
