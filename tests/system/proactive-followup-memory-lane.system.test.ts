import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  PostgresProactiveFollowupRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const systemDescribe = testDatabaseUrl ? describe : describe.skip;

const OWNER = "01984477-1f9a-7b25-a5cc-83c3b21fbc6a";
const OTHER_USER = "01984477-1f9a-7b25-a5cc-83c3b21fbc6b";
const BASE_TIME = new Date("2026-09-12T12:00:00.000Z");

function fixtureId(number: number): string {
  return `01991000-0000-7000-8000-${number.toString(16).padStart(12, "0")}`;
}

const SESSION_ID = fixtureId(1);
const TURN_ID = fixtureId(2);
const EVENT_ID = fixtureId(3);
const REVISION_ID = fixtureId(4);
const COMMAND_ID = fixtureId(5);
const CONTEXT_ID = fixtureId(6);
const RUN_ID = fixtureId(7);
const POLICY_VERSION = "memory-lane-system:v1";

const SELF_ENTITY_ID = fixtureId(10);
const SELF_ENTITY_VERSION_ID = fixtureId(11);
const OTHER_ENTITY_ID = fixtureId(12);
const OTHER_ENTITY_VERSION_ID = fixtureId(13);

const CLAIM_ID = fixtureId(20);
const CLAIM_VERSION_ID = fixtureId(21);
const PROJECTION_ID = fixtureId(22);
const EVIDENCE_SNAPSHOT_ID = fixtureId(23);
const EVIDENCE_ID = fixtureId(24);

const PURGED_CLAIM_ID = fixtureId(30);
const PURGED_CLAIM_VERSION_ID = fixtureId(31);
const PURGED_PROJECTION_ID = fixtureId(32);

const SENSITIVE_CLAIM_ID = fixtureId(40);
const SENSITIVE_CLAIM_VERSION_ID = fixtureId(41);
const SENSITIVE_PROJECTION_ID = fixtureId(42);
const SENSITIVE_PREDICATE_ID = "sh.health.condition";

const PORTRAIT_CLAIM_ID = fixtureId(50);
const PORTRAIT_CLAIM_VERSION_ID = fixtureId(51);
const PORTRAIT_PROJECTION_ID = fixtureId(52);

const EMPTY_COMMAND_ID = fixtureId(70);
const EMPTY_CONTEXT_ID = fixtureId(71);
const EMPTY_RUN_ID = fixtureId(72);
const MISSING_CONTEXT_COMMAND_ID = fixtureId(73);
const EMPTY_TURN_ID = fixtureId(74);
const MISSING_TURN_ID = fixtureId(75);

const COLLEAGUE_OF = "sh.relationship.colleague";
const TRAIL_PROJECT = "sh.project.trail";

async function seedEntity(
  pool: Pool,
  entityId: string,
  versionId: string,
  userId: string,
  label: string,
  labelId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO entities (entity_id, user_id, created_at)
     VALUES ($1, $2, $3)`,
    [entityId, userId, BASE_TIME],
  );
  await pool.query(
    `INSERT INTO entity_versions (
       entity_version_id, entity_id, user_id, revision, entity_kind_id,
       status, created_at
     ) VALUES ($1, $2, $3, 1, 'sh.entity.person', 'active', $4)`,
    [versionId, entityId, userId, BASE_TIME],
  );
  await pool.query(
    `UPDATE entities SET current_version_id = $3
     WHERE entity_id = $1 AND user_id = $2`,
    [entityId, userId, versionId],
  );
  await pool.query(
    `INSERT INTO entity_labels (
       entity_label_id, entity_id, user_id, locale, label, normalized_label,
       label_kind, is_current, created_at
     ) VALUES ($1, $2, $3, 'en', $4, $4, 'primary', TRUE, $5)`,
    [labelId, entityId, userId, label, BASE_TIME],
  );
}

async function seedClaim(
  pool: Pool,
  input: {
    claimId: string;
    claimVersionId: string;
    projectionId: string;
    linkId: string;
    predicateId: string;
    objectEntityId: string | null;
    objectEntityVersionId: string | null;
    retrievalText: string;
    evidenceId: string;
    contentPurged: boolean;
  },
): Promise<void> {
  if (input.contentPurged) {
    await pool.query(
      `INSERT INTO memory_claims (
         memory_claim_id, user_id, canonical_key, subject_entity_id,
         object_entity_id, predicate_id, scope_key, created_at, deleted_at,
         content_purged_at
       ) VALUES ($1, $2, NULL, NULL, NULL, NULL, NULL, $3, $3, $3)`,
      [input.claimId, OWNER, BASE_TIME],
    );
    await pool.query(
      `INSERT INTO memory_claim_versions (
         memory_claim_version_id, memory_claim_id, user_id, revision, kind,
         epistemic_status, status, subject_entity_version_id,
         object_entity_version_id, typed_value, temporal_status,
         valid_from_precision, valid_to_precision, last_observed_at,
         created_by, predicate_registry_version, created_at, content_purged_at
       ) VALUES ($1, $2, $3, 1, 'objective', 'confirmed', 'active', NULL,
                 NULL, NULL, NULL, NULL, NULL, $4, 'admission', 1, $4, $4)`,
      [input.claimVersionId, input.claimId, OWNER, BASE_TIME],
    );
    await pool.query(
      `INSERT INTO claim_retrieval_projections (
         claim_retrieval_projection_id, user_id, memory_claim_id,
         memory_claim_version_id, locale, view_direction, retrieval_text,
         lexical_terms, projection_policy_version, status, created_at,
         content_purged_at
       ) VALUES ($1, $2, $3, $4, 'en', 'self', $5, ARRAY['term'],
                 'projection:v1', 'active', $6, $6)`,
      [
        input.projectionId,
        OWNER,
        input.claimId,
        input.claimVersionId,
        input.retrievalText,
        BASE_TIME,
      ],
    );
    return;
  }
  await pool.query(
    `INSERT INTO memory_claims (
       memory_claim_id, user_id, canonical_key, subject_entity_id,
       object_entity_id, predicate_id, scope_key, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, '', $7)`,
    [
      input.claimId,
      OWNER,
      `canonical:${input.claimId}`,
      SELF_ENTITY_ID,
      input.objectEntityId,
      input.predicateId,
      BASE_TIME,
    ],
  );
  await pool.query(
    `INSERT INTO memory_claim_versions (
       memory_claim_version_id, memory_claim_id, user_id, revision, kind,
       epistemic_status, status, subject_entity_version_id,
       object_entity_version_id, typed_value, temporal_status,
       valid_from_precision, valid_to_precision, last_observed_at,
       created_by, predicate_registry_version, created_at
     ) VALUES ($1, $2, $3, 1, 'objective', 'confirmed', 'active', $4,
               $5, '""'::jsonb, 'current', 'unknown', 'unknown', $6,
               'admission', 1, $6)`,
    [
      input.claimVersionId,
      input.claimId,
      OWNER,
      SELF_ENTITY_VERSION_ID,
      input.objectEntityVersionId,
      BASE_TIME,
    ],
  );
  await pool.query(
    `UPDATE memory_claims SET current_version_id = $2
     WHERE memory_claim_id = $1 AND user_id = $3`,
    [input.claimId, input.claimVersionId, OWNER],
  );
  await pool.query(
    `INSERT INTO claim_retrieval_projections (
       claim_retrieval_projection_id, user_id, memory_claim_id,
       memory_claim_version_id, locale, view_direction, retrieval_text,
       lexical_terms, projection_policy_version, status, created_at
     ) VALUES ($1, $2, $3, $4, 'en', 'self', $5, ARRAY['term'],
               'projection:v1', 'active', $6)`,
    [
      input.projectionId,
      OWNER,
      input.claimId,
      input.claimVersionId,
      input.retrievalText,
      BASE_TIME,
    ],
  );
  await pool.query(
    `INSERT INTO claim_evidence_links (
       claim_evidence_link_id, memory_claim_version_id, user_id,
       evidence_item_id, link_role, status, created_at
     ) VALUES ($1, $2, $3, $4, 'support', 'active', $5)`,
    [input.linkId, input.claimVersionId, OWNER, input.evidenceId, BASE_TIME],
  );
}

async function insertCandidate(
  pool: Pool,
  input: {
    candidateId: string;
    runId: string;
    claimVersionId: string;
    projectionId: string;
    rank: number | null;
    selectedSection: "objective_memory" | "person_portrait" | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO retrieval_run_candidates (
       retrieval_run_candidate_id, retrieval_run_id, user_id,
       memory_claim_version_id, claim_retrieval_projection_id,
       retrieval_lane, matched_fields, matched_terms, trust_fence_results,
       rank_components, final_rank, selected_section, created_at
     ) VALUES ($1, $2, $3, $4, $5, 'structured_exact', '[]'::jsonb,
               '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, $6, $7, $8)`,
    [
      input.candidateId,
      input.runId,
      OWNER,
      input.claimVersionId,
      input.projectionId,
      input.rank,
      input.selectedSection,
      BASE_TIME,
    ],
  );
}

systemDescribe("proactive follow-up Memory lane PostgreSQL reader", () => {
  let database: IsolatedPostgresSchema | undefined;
  let repository: PostgresProactiveFollowupRepository;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl!);
    await runMigrations(database.pool);
    repository = new PostgresProactiveFollowupRepository(database.pool);
    const pool = database.pool;

    await pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $3, $3), ($2, 'active', 1, $3, $3)`,
      [OWNER, OTHER_USER, BASE_TIME],
    );
    await pool.query(
      `INSERT INTO daily_sessions (
         daily_session_id, user_id, logical_date, timezone_at_start,
         started_at, last_activity_at, activity_state,
         current_continuous_exchange_no, dialogue_revision, source_revision,
         next_turn_sequence_no, next_event_sequence_no, created_at, updated_at
       ) VALUES ($1, $2, '2026-09-12', 'UTC', $3, $3, 'active', 1, 1, 1, 2, 2, $3, $3)`,
      [SESSION_ID, OWNER, BASE_TIME],
    );
    await pool.query(
      `INSERT INTO interaction_turns (
         interaction_turn_id, user_id, daily_session_id, client_turn_id,
         turn_sequence_no, continuous_exchange_no, status, started_at,
         settled_at, created_at, updated_at
       ) VALUES
         ($1, $2, $3, 'memory-lane', 1, 1, 'settled', $4, $4, $4, $4),
         ($5, $2, $3, 'memory-lane-empty', 2, 1, 'settled', $4, $4, $4, $4),
         ($6, $2, $3, 'memory-lane-missing', 3, 1, 'settled', $4, $4, $4, $4)`,
      [TURN_ID, OWNER, SESSION_ID, BASE_TIME, EMPTY_TURN_ID, MISSING_TURN_ID],
    );
    await pool.query(
      `INSERT INTO conversation_events (
         conversation_event_id, user_id, daily_session_id, interaction_turn_id,
         sequence_no, client_event_id, actor, channel, event_type,
         lifecycle_status, created_at
       ) VALUES ($1, $2, $3, $4, 1, 'memory-lane', 'user', 'text',
                 'user_message', 'active', $5)`,
      [EVENT_ID, OWNER, SESSION_ID, TURN_ID, BASE_TIME],
    );
    await pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, locale, canonical_text, transcript_status, created_by,
         created_at
       ) VALUES ($1, $2, $3, 1, 'en', 'Synthetic memory lane seed.', 'final',
                 'client', $4)`,
      [REVISION_ID, OWNER, EVENT_ID, BASE_TIME],
    );
    await pool.query(
      `UPDATE conversation_events SET current_revision_id = $2
       WHERE conversation_event_id = $1`,
      [EVENT_ID, REVISION_ID],
    );
    await pool.query(
      `INSERT INTO generation_commands (
         generation_command_id, user_id, interaction_turn_id, operation_type,
         intent_key, subject_type, subject_id, input_revision_kind,
         input_revision_id, prompt_version, product_policy_version,
         safety_policy_version, relationship_policy_version,
         locale_policy_version, locale, provider, model, model_snapshot,
         model_config_version, provider_policy_version, freshness_policy,
         expected_data_epoch, status, created_at, settled_at,
         output_format_version, persona_version, harness_policy_version,
         conversation_action_catalog_version, source_revision, source_snapshot,
         input_manifest, parameter_snapshot, fallback_mode
       ) VALUES
         ($1, $3, $4, 'conversation.text', 'main', 'conversation_event', $6,
          'conversation_event_revision', $7, 'prompt:v1', 'product:v1',
          'safety:v1', 'relationship:v1', 'locale:v1', 'en', 'synthetic',
          'synthetic-model', 'synthetic-model@fixture', 'config:v1',
          'openai-conversation-text:v1', 'source_valid:v1', 1, 'succeeded',
          $8, $8, 'output:v1', 'persona:v1', 'harness:v1', 'catalog:v1', 1,
          'source:fixture', '{}'::jsonb, '{}'::jsonb, 'disabled'),
         ($2, $3, $5, 'conversation.text', 'main-empty', 'conversation_event', $6,
          'conversation_event_revision', $7, 'prompt:v1', 'product:v1',
          'safety:v1', 'relationship:v1', 'locale:v1', 'en', 'synthetic',
          'synthetic-model', 'synthetic-model@fixture', 'config:v1',
          'openai-conversation-text:v1', 'source_valid:v1', 1, 'succeeded',
          $8, $8, 'output:v1', 'persona:v1', 'harness:v1', 'catalog:v1', 1,
          'source:fixture', '{}'::jsonb, '{}'::jsonb, 'disabled')`,
      [
        COMMAND_ID,
        EMPTY_COMMAND_ID,
        OWNER,
        TURN_ID,
        EMPTY_TURN_ID,
        EVENT_ID,
        REVISION_ID,
        BASE_TIME,
      ],
    );
    await pool.query(
      `INSERT INTO generation_commands (
         generation_command_id, user_id, interaction_turn_id, operation_type,
         intent_key, subject_type, subject_id, input_revision_kind,
         input_revision_id, prompt_version, product_policy_version,
         safety_policy_version, relationship_policy_version,
         locale_policy_version, locale, provider, model, model_snapshot,
         model_config_version, provider_policy_version, freshness_policy,
         expected_data_epoch, status, created_at, settled_at,
         output_format_version, persona_version, harness_policy_version,
         conversation_action_catalog_version, source_revision, source_snapshot,
         input_manifest, parameter_snapshot, fallback_mode
       ) VALUES ($1, $2, $3, 'conversation.text', 'main-missing', 'conversation_event',
                 $4, 'conversation_event_revision', $5, 'prompt:v1',
                 'product:v1', 'safety:v1', 'relationship:v1', 'locale:v1',
                 'en', 'synthetic', 'synthetic-model',
                 'synthetic-model@fixture', 'config:v1',
                 'openai-conversation-text:v1', 'source_valid:v1', 1,
                 'succeeded', $6, $6, 'output:v1', 'persona:v1', 'harness:v1',
                 'catalog:v1', 1, 'source:fixture', '{}'::jsonb, '{}'::jsonb,
                 'disabled')`,
      [
        MISSING_CONTEXT_COMMAND_ID,
        OWNER,
        MISSING_TURN_ID,
        EVENT_ID,
        REVISION_ID,
        BASE_TIME,
      ],
    );
    for (const [contextId, commandId] of [
      [CONTEXT_ID, COMMAND_ID],
      [EMPTY_CONTEXT_ID, EMPTY_COMMAND_ID],
    ] as const) {
      await pool.query(
        `INSERT INTO compiled_contexts (
           compiled_context_id, user_id, generation_command_id,
           compiler_version, dialogue_revision, source_revision, locale,
           section_budgets, total_tokens, content_hmac, created_at,
           policy_versions, sections, integrity_algorithm, integrity_key_version
         ) VALUES ($1, $2, $3, 'context:v1', 1, 1, 'en', '{}'::jsonb, 1,
                   'synthetic-hmac', $4, '{}'::jsonb, '[]'::jsonb,
                   'hmac-sha256', 'synthetic-key')`,
        [contextId, OWNER, commandId, BASE_TIME],
      );
    }
    await pool.query(
      `UPDATE generation_commands SET compiled_context_id = CASE generation_command_id
         WHEN $1::uuid THEN $3::uuid
         WHEN $2::uuid THEN $4::uuid
       END
       WHERE generation_command_id IN ($1::uuid, $2::uuid)`,
      [COMMAND_ID, EMPTY_COMMAND_ID, CONTEXT_ID, EMPTY_CONTEXT_ID],
    );
    await pool.query(
      `INSERT INTO retrieval_policies (
         policy_version, deadline_ms, candidate_limit_per_lane, created_at
       ) VALUES ($1, 10000, 25, $2)`,
      [POLICY_VERSION, BASE_TIME],
    );
    for (const [runId, contextId] of [
      [RUN_ID, CONTEXT_ID],
      [EMPTY_RUN_ID, EMPTY_CONTEXT_ID],
    ] as const) {
      await pool.query(
        `INSERT INTO retrieval_runs (
           retrieval_run_id, user_id, daily_session_id,
           source_event_revision_id, compiled_context_id,
           retrieval_policy_version, query_construction_policy_version,
           projection_policy_version, query_source_refs,
           normalized_query_terms, lane_plan, deadline_ms, status,
           degraded_reason_codes, duration_ms, timings, started_at,
           completed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'query:v1', 'projection:v1',
                   '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 10000, 'completed',
                   '{}', 5, '{}'::jsonb, $7, $7)`,
        [
          runId,
          OWNER,
          SESSION_ID,
          REVISION_ID,
          contextId,
          POLICY_VERSION,
          BASE_TIME,
        ],
      );
    }

    await seedEntity(
      pool,
      SELF_ENTITY_ID,
      SELF_ENTITY_VERSION_ID,
      OWNER,
      "Alex",
      fixtureId(80),
    );
    await seedEntity(
      pool,
      OTHER_ENTITY_ID,
      OTHER_ENTITY_VERSION_ID,
      OWNER,
      "Sam",
      fixtureId(81),
    );

    await pool.query(
      `INSERT INTO predicate_registry_entries (
         predicate_id, registry_version, definition_version, status,
         allowed_claim_kinds, sensitivity_class, allowed_subject_kind_ids,
         object_value_schema, scope_schema, value_cardinality,
         temporal_semantics, evidence_policy_id, created_at
       ) VALUES
         ($1, 1, 1, 'active', '["objective"]'::jsonb, 'standard',
          '["sh.entity.person"]'::jsonb, '{}'::jsonb, '{}'::jsonb, 'single',
          '{}'::jsonb, 'policy:v1', $4),
         ($2, 1, 1, 'active', '["objective"]'::jsonb, 'sensitive',
          '["sh.entity.person"]'::jsonb, '{}'::jsonb, '{}'::jsonb, 'single',
          '{}'::jsonb, 'policy:v1', $4),
         ($3, 1, 1, 'active', '["objective"]'::jsonb, 'standard',
          '["sh.entity.person"]'::jsonb, '{}'::jsonb, '{}'::jsonb, 'single',
          '{}'::jsonb, 'policy:v1', $4)`,
      [COLLEAGUE_OF, SENSITIVE_PREDICATE_ID, TRAIL_PROJECT, BASE_TIME],
    );
    await pool.query(
      `INSERT INTO evidence_source_snapshots (
         evidence_source_snapshot_id, user_id, daily_session_id,
         source_revision, extraction_policy_version, command_id, attempt_id,
         champion_config_version, champion_provider, champion_model,
         champion_snapshot, champion_provider_policy_version, created_at
       ) VALUES ($1, $2, $3, 1, 'synthetic-evidence:v1', 'fixture-command',
                 'fixture-attempt', 'fixture-config', 'deepseek',
                 'fixture-model', 'fixture-model@fixture', 'fixture-policy:v1',
                 $4)`,
      [EVIDENCE_SNAPSHOT_ID, OWNER, SESSION_ID, BASE_TIME],
    );
    await pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id,
         source_event_id, source_revision_id, source_actor, source_status,
         locator_type, locator_key, extraction_policy_version, evidence_role,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision',
                 '1:0', 'synthetic-evidence:v1', 'factual_support', $6)`,
      [
        EVIDENCE_ID,
        OWNER,
        EVIDENCE_SNAPSHOT_ID,
        EVENT_ID,
        REVISION_ID,
        BASE_TIME,
      ],
    );

    await seedClaim(pool, {
      claimId: CLAIM_ID,
      claimVersionId: CLAIM_VERSION_ID,
      projectionId: PROJECTION_ID,
      linkId: fixtureId(120),
      predicateId: COLLEAGUE_OF,
      objectEntityId: OTHER_ENTITY_ID,
      objectEntityVersionId: OTHER_ENTITY_VERSION_ID,
      retrievalText: "Works with Sam on the trail project.",
      evidenceId: EVIDENCE_ID,
      contentPurged: false,
    });
    await seedClaim(pool, {
      claimId: PURGED_CLAIM_ID,
      claimVersionId: PURGED_CLAIM_VERSION_ID,
      projectionId: PURGED_PROJECTION_ID,
      linkId: fixtureId(121),
      predicateId: TRAIL_PROJECT,
      objectEntityId: null,
      objectEntityVersionId: null,
      retrievalText: "Cares about the trail project.",
      evidenceId: EVIDENCE_ID,
      contentPurged: true,
    });
    await seedClaim(pool, {
      claimId: SENSITIVE_CLAIM_ID,
      claimVersionId: SENSITIVE_CLAIM_VERSION_ID,
      projectionId: SENSITIVE_PROJECTION_ID,
      linkId: fixtureId(122),
      predicateId: SENSITIVE_PREDICATE_ID,
      objectEntityId: null,
      objectEntityVersionId: null,
      retrievalText: "Has a sensitive condition.",
      evidenceId: EVIDENCE_ID,
      contentPurged: false,
    });
    await seedClaim(pool, {
      claimId: PORTRAIT_CLAIM_ID,
      claimVersionId: PORTRAIT_CLAIM_VERSION_ID,
      projectionId: PORTRAIT_PROJECTION_ID,
      linkId: fixtureId(123),
      predicateId: TRAIL_PROJECT,
      objectEntityId: null,
      objectEntityVersionId: null,
      retrievalText: "Values the trail project.",
      evidenceId: EVIDENCE_ID,
      contentPurged: false,
    });

    await insertCandidate(pool, {
      candidateId: fixtureId(130),
      runId: RUN_ID,
      claimVersionId: CLAIM_VERSION_ID,
      projectionId: PROJECTION_ID,
      rank: 1,
      selectedSection: "objective_memory",
    });
    await insertCandidate(pool, {
      candidateId: fixtureId(131),
      runId: RUN_ID,
      claimVersionId: PURGED_CLAIM_VERSION_ID,
      projectionId: PURGED_PROJECTION_ID,
      rank: 2,
      selectedSection: "objective_memory",
    });
    await insertCandidate(pool, {
      candidateId: fixtureId(132),
      runId: RUN_ID,
      claimVersionId: SENSITIVE_CLAIM_VERSION_ID,
      projectionId: SENSITIVE_PROJECTION_ID,
      rank: 3,
      selectedSection: "objective_memory",
    });
    await insertCandidate(pool, {
      candidateId: fixtureId(133),
      runId: RUN_ID,
      claimVersionId: PORTRAIT_CLAIM_VERSION_ID,
      projectionId: PORTRAIT_PROJECTION_ID,
      rank: 4,
      selectedSection: "person_portrait",
    });
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  it("returns the selected current claims of the turn's retrieval run", async () => {
    const read = await repository.readMemoryLaneCandidates({
      userId: OWNER,
      mainGenerationCommandId: COMMAND_ID,
    });
    expect(read).not.toBeNull();
    expect(read?.sourceRevision).toBe(1);
    expect(read?.candidates).toHaveLength(4);
    expect(read?.candidates[0]).toMatchObject({
      claimId: CLAIM_ID,
      claimVersionId: CLAIM_VERSION_ID,
      source: "query_retrieval",
      sourceRank: 1,
      summaryText: "Works with Sam on the trail project.",
      current: true,
      eligible: true,
      trustFence: "valid",
      sensitive: false,
      evidenceAt: BASE_TIME.toISOString(),
    });
    const portrait = read?.candidates.find(
      (candidate) => candidate.claimVersionId === PORTRAIT_CLAIM_VERSION_ID,
    );
    expect(portrait).toMatchObject({
      source: "person_portrait",
      sourceRank: 4,
      eligible: true,
    });
    const sensitive = read?.candidates.find(
      (candidate) => candidate.claimVersionId === SENSITIVE_CLAIM_VERSION_ID,
    );
    expect(sensitive).toMatchObject({ sensitive: true, eligible: true });
    const purged = read?.candidates.find(
      (candidate) => candidate.claimVersionId === PURGED_CLAIM_VERSION_ID,
    );
    expect(purged).toMatchObject({
      eligible: false,
      trustFence: "invalid",
      current: false,
    });
  });

  it("never leaks another user's lane", async () => {
    const foreignRead = await repository.readMemoryLaneCandidates({
      userId: OTHER_USER,
      mainGenerationCommandId: COMMAND_ID,
    });
    expect(foreignRead).toBeNull();
  });

  it("filters to one claim version when a summary is requested", async () => {
    const read = await repository.readMemoryLaneCandidates({
      userId: OWNER,
      mainGenerationCommandId: COMMAND_ID,
      claimVersionId: PORTRAIT_CLAIM_VERSION_ID,
    });
    expect(read?.candidates).toHaveLength(1);
    expect(read?.candidates[0]?.summaryText).toBe("Values the trail project.");
  });

  it("returns a complete, empty read when the run selected nothing", async () => {
    const read = await repository.readMemoryLaneCandidates({
      userId: OWNER,
      mainGenerationCommandId: EMPTY_COMMAND_ID,
    });
    expect(read).toEqual({ sourceRevision: 1, candidates: [] });
  });

  it("returns null when the command has no compiled context or retrieval run", async () => {
    await expect(
      repository.readMemoryLaneCandidates({
        userId: OWNER,
        mainGenerationCommandId: MISSING_CONTEXT_COMMAND_ID,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.readMemoryLaneCandidates({
        userId: OWNER,
        mainGenerationCommandId: fixtureId(999),
      }),
    ).resolves.toBeNull();
  });
});
