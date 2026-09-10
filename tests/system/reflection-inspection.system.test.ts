import { createHash } from "node:crypto";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

import {
  asBioCoverageUnitId,
  asBioId,
  asBioVersionId,
  asEvidenceItemId,
  asMemoryCandidateId,
  asMemoryClaimVersionId,
  asReflectionAtomicPropositionId,
  asReflectionId,
  asReflectionStatementId,
  asReflectionVersionId,
} from "@sayhear/domain";
import {
  createReflectionInspectionService,
  type ReflectionInspectionService,
} from "@sayhear/application";
import {
  PostgresReflectionInspectionRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";
import type { Pool } from "pg";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const systemDescribe = testDatabaseUrl ? describe : describe.skip;

const OWNER = fixedInternalOwnerPrincipal.userId;
const NOW = new Date("2026-09-10T12:00:00.000Z");
const SESSION_TOKEN = "reflection-inspection-system-session";
const SESSION_HASH = createHash("sha256").update(SESSION_TOKEN).digest();

const ID = Object.freeze({
  dailySession: "01984500-0000-7000-8000-000000000001",
  interactionTurn: "01984500-0000-7000-8000-000000000002",
  event: "01984500-0000-7000-8000-000000000003",
  eventRevision: "01984500-0000-7000-8000-000000000004",
  evidenceSnapshot: "01984500-0000-7000-8000-000000000005",
  evidenceItem: "01984500-0000-7000-8000-000000000006",
  reflection: "01984500-0000-7000-8000-000000000007",
  reflectionVersion: "01984500-0000-7000-8000-000000000008",
  statement: "01984500-0000-7000-8000-000000000009",
  proposition: "01984500-0000-7000-8000-00000000000a",
  candidate: "01984500-0000-7000-8000-00000000000b",
  claim: "01984500-0000-7000-8000-00000000000c",
  claimVersion: "01984500-0000-7000-8000-00000000000d",
  entity: "01984500-0000-7000-8000-00000000000e",
  entityVersion: "01984500-0000-7000-8000-00000000000f",
  bio: "01984500-0000-7000-8000-000000000010",
  bioVersion: "01984500-0000-7000-8000-000000000011",
  coverageUnit: "01984500-0000-7000-8000-000000000012",
  reflectionCommand: "01984500-0000-7000-8000-000000000013",
  reflectionAttempt: "01984500-0000-7000-8000-000000000014",
  validatorRequest: "01984500-0000-7000-8000-000000000015",
  validatorResult: "01984500-0000-7000-8000-000000000016",
  workflowCommand: "01984500-0000-7000-8000-000000000017",
  consolidationRun: "01984500-0000-7000-8000-000000000018",
  consolidationDiff: "01984500-0000-7000-8000-000000000019",
  candidateProposal: "01984500-0000-7000-8000-00000000001a",
  evidenceLink: "01984500-0000-7000-8000-00000000001b",
  bioClaimLink: "01984500-0000-7000-8000-00000000001c",
  candidateEvidenceLink: "01984500-0000-7000-8000-00000000001d",
} as const);

const unknownClaimVersionId = asMemoryClaimVersionId(
  "01984500-0000-7000-8000-000000000020",
);

const INSPECTION_DOMAIN_SNAPSHOT_QUERIES = [
  ["bios", "SELECT * FROM bios"] as const,
  ["bio_claim_links", "SELECT * FROM bio_claim_links"] as const,
  ["bio_coverage_members", "SELECT * FROM bio_coverage_members"] as const,
  ["bio_coverage_units", "SELECT * FROM bio_coverage_units"] as const,
  ["bio_versions", "SELECT * FROM bio_versions"] as const,
  ["conversation_events", "SELECT * FROM conversation_events"] as const,
  ["conversation_event_revisions", "SELECT * FROM conversation_event_revisions"] as const,
  ["daily_sessions", "SELECT * FROM daily_sessions"] as const,
  ["entities", "SELECT * FROM entities"] as const,
  ["entity_versions", "SELECT * FROM entity_versions"] as const,
  ["evidence_source_snapshots", "SELECT * FROM evidence_source_snapshots"] as const,
  ["evidence_items", "SELECT * FROM evidence_items"] as const,
  ["generation_commands", "SELECT * FROM generation_commands"] as const,
  ["memory_candidate_evidence_links", "SELECT * FROM memory_candidate_evidence_links"] as const,
  ["memory_candidates", "SELECT * FROM memory_candidates"] as const,
  ["memory_claim_versions", "SELECT * FROM memory_claim_versions"] as const,
  ["memory_claims", "SELECT * FROM memory_claims"] as const,
  ["memory_consolidation_diffs", "SELECT * FROM memory_consolidation_diffs"] as const,
  ["model_run_attempts", "SELECT * FROM model_run_attempts"] as const,
  ["narrative_validator_requests", "SELECT * FROM narrative_validator_requests"] as const,
  ["narrative_validator_results", "SELECT * FROM narrative_validator_results"] as const,
  ["reflection_atomic_propositions", "SELECT * FROM reflection_atomic_propositions"] as const,
  ["reflection_candidate_proposals", "SELECT * FROM reflection_candidate_proposals"] as const,
  ["reflection_statement_evidence_links", "SELECT * FROM reflection_statement_evidence_links"] as const,
  ["reflection_statements", "SELECT * FROM reflection_statements"] as const,
  ["reflection_versions", "SELECT * FROM reflection_versions"] as const,
  ["reflections", "SELECT * FROM reflections"] as const,
] as const;

async function inspectionDomainSnapshot(pool: Pool): Promise<string> {
  const rows = await Promise.all(
    INSPECTION_DOMAIN_SNAPSHOT_QUERIES.map(async ([tableName, query]) => {
      const result = await pool.query<{ digest: string; row_count: string }>(
        `SELECT count(*)::text AS row_count,
                md5(COALESCE(string_agg(
                  to_jsonb(snapshot_row)::text,
                  '|' ORDER BY to_jsonb(snapshot_row)::text
                ), '')) AS digest
         FROM (${query}) AS snapshot_row`,
      );
      return { digest: result.rows[0]?.digest, rowCount: result.rows[0]?.row_count, tableName };
    }),
  );
  return JSON.stringify(rows);
}

systemDescribe("Reflection Inspector — 1A.3b A4 (issue #202)", () => {
  let database: IsolatedPostgresSchema | undefined;
  let service: ReflectionInspectionService;

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
       ) VALUES (1, 'system-test', 'reflection-inspector', $1, TRUE, $2)`,
      [OWNER, NOW],
    );
    await database.pool.query(
      `INSERT INTO auth_sessions (
         session_token_hash, user_id, expires_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $4)`,
      [SESSION_HASH, OWNER, new Date("2099-01-01T00:00:00.000Z"), NOW],
    );
    await database.pool.query(
      `INSERT INTO internal_diagnostic_access_grants (
         session_token_hash, capability, status, step_up_authenticated_at,
         updated_at
       ) VALUES
         ($1, 'reflection_inspection:read', 'active', NULL, $2),
         ($1, 'conversation_content:read', 'active', $2, $2)`,
      [SESSION_HASH, NOW],
    );
    await database.pool.query(
      `INSERT INTO provider_egress_policy_versions (
         policy_version, provider, role, model_config_version, status, created_at
       ) VALUES ($1, 'system-test', 'reflection.daily', 'reflection-inspector:v1',
         'active', $2)`,
      ["reflection-inspector-egress:v1", NOW],
    );

    await database.pool.query(
      `INSERT INTO daily_sessions (
         daily_session_id, user_id, logical_date, timezone_at_start,
         started_at, last_activity_at, activity_state,
         current_continuous_exchange_no, dialogue_revision, source_revision,
         next_turn_sequence_no, next_event_sequence_no, quiescent_at,
         created_at, updated_at
       ) VALUES ($1, $2, '2026-09-09', 'UTC', $3, $3, 'quiescent',
         1, 0, 1, 2, 2, $3, $3, $3)`,
      [ID.dailySession, OWNER, NOW],
    );
    await database.pool.query(
      `INSERT INTO interaction_turns (
         interaction_turn_id, user_id, daily_session_id, client_turn_id,
         turn_sequence_no, continuous_exchange_no, status, started_at,
         settled_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'reflection-inspection-turn', 1, 1, 'settled',
         $4, $4, $4, $4)`,
      [ID.interactionTurn, OWNER, ID.dailySession, NOW],
    );
    await database.pool.query(
      `INSERT INTO conversation_events (
         conversation_event_id, user_id, daily_session_id, interaction_turn_id,
         sequence_no, client_event_id, actor, channel, event_type,
         lifecycle_status, created_at
       ) VALUES ($1, $2, $3, $4, 1, 'reflection-inspection-event', 'user',
         'text', 'message', 'active', $5)`,
      [ID.event, OWNER, ID.dailySession, ID.interactionTurn, NOW],
    );
    await database.pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, canonical_text, locale, transcript_status, created_by,
         created_at
       ) VALUES ($1, $2, $3, 1,
         'I started fixing radios this week.', 'en-US', 'final', 'client', $4)`,
      [ID.eventRevision, OWNER, ID.event, NOW],
    );
    await database.pool.query(
      `UPDATE conversation_events
       SET current_revision_id = $2
       WHERE conversation_event_id = $1 AND user_id = $3`,
      [ID.event, ID.eventRevision, OWNER],
    );
    await database.pool.query(
      `INSERT INTO evidence_source_snapshots (
         evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
         extraction_policy_version, command_id, attempt_id,
         champion_config_version, champion_provider, champion_model,
         champion_snapshot, champion_provider_policy_version, created_at
       ) VALUES ($1, $2, $3, 1, 'evidence-extraction:v2', 'system-test',
         'system-test', 'reflection-inspector:v1', 'openai', 'synthetic-model',
         'synthetic-model@fixture', 'reflection-inspector-egress:v1', $4)`,
      [ID.evidenceSnapshot, OWNER, ID.dailySession, NOW],
    );
    await database.pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id,
         source_event_id, source_revision_id, source_actor, source_status,
         locator_type, locator_key, extraction_policy_version, evidence_role,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'text_span',
         '0:34', 'evidence-extraction:v2', 'factual_support', $6)`,
      [
        ID.evidenceItem,
        OWNER,
        ID.evidenceSnapshot,
        ID.event,
        ID.eventRevision,
        NOW,
      ],
    );

    await database.pool.query(
      `INSERT INTO entities (entity_id, user_id, created_at)
       VALUES ($1, $2, $3)`,
      [ID.entity, OWNER, NOW],
    );
    await database.pool.query(
      `INSERT INTO entity_versions (
         entity_version_id, entity_id, user_id, revision, entity_kind_id,
         status, created_at
       ) VALUES ($1, $2, $3, 1, 'person', 'active', $4)`,
      [ID.entityVersion, ID.entity, OWNER, NOW],
    );
    await database.pool.query(
      `UPDATE entities
       SET current_version_id = $2
       WHERE entity_id = $1 AND user_id = $3`,
      [ID.entity, ID.entityVersion, OWNER],
    );

    await database.pool.query(
      `INSERT INTO generation_commands (
         generation_command_id, user_id, operation_type, intent_key,
         subject_type, subject_id, model_role, schema_version, prompt_version,
         product_policy_version, safety_policy_version,
         relationship_policy_version, locale_policy_version, locale, provider,
         model, model_snapshot, model_config_version, freshness_policy,
         output_format_version, harness_policy_version,
         conversation_action_catalog_version, role_policy_version, rollout_pin,
         provider_policy_version, source_revision, parameter_snapshot,
         fallback_mode, expected_data_epoch, status, created_at
       ) VALUES ($1, $2, 'reflection.daily', 'reflection-inspector-system-test',
         'daily_session', $3, 'reflection.daily', 'reflection-output-schema:v1',
         'reflection-daily:system-test:v1', 'product-policy:v1',
         'minimum-high-risk-response:v1', 'relationship-boundary:v1',
         'locale-policy:v1', 'en', 'system-test', 'synthetic-model',
         'synthetic-model@fixture', 'reflection-inspector:v1', 'exact_head:v1',
         'reflection-output:v1', 'conversation-harness:v1',
         'memory-trust-actions-catalog:v1', '1a3b-model-role-policy:v1',
         'reflection-inspector-pin:v1', 'reflection-inspector-egress:v1', 1,
         '{}'::jsonb, 'disabled', 1, 'succeeded', $4)`,
      [ID.reflectionCommand, OWNER, ID.dailySession, NOW],
    );
    await database.pool.query(
      `INSERT INTO model_run_attempts (
         model_run_attempt_id, user_id, generation_command_id, attempt_no,
         operation_type, provider, model, model_snapshot, prompt_version,
         attempt_kind, status, created_at
       ) VALUES ($1, $2, $3, 1, 'reflection.daily', 'system-test',
         'synthetic-model', 'synthetic-model@fixture',
         'reflection-daily:system-test:v1', 'initial', 'succeeded', $4)`,
      [ID.reflectionAttempt, OWNER, ID.reflectionCommand, NOW],
    );
    await database.pool.query(
      `INSERT INTO narrative_validator_requests (
         narrative_validator_request_id, user_id, artifact_kind, draft_ref,
         draft_locale, draft_text, generator_manifest, source_manifest,
         planned_coverage, request_fingerprint, validation_policy_version,
         prompt_version, schema_version, created_at
       ) VALUES ($1, $2, 'reflection', $3, 'en',
         'You have been fixing radios this week.', '{}'::jsonb, '{}'::jsonb,
         '{}'::jsonb, 'reflection-inspector-request',
         'narrative-validation:v1', 'narrative-validate:system-test:v1',
         'narrative-findings:v1', $4)`,
      [ID.validatorRequest, OWNER, `draft:${ID.reflectionVersion}`, NOW],
    );
    await database.pool.query(
      `INSERT INTO narrative_validator_results (
         narrative_validator_result_id, narrative_validator_request_id,
         user_id, generation_command_id, model_run_attempt_id, verdict,
         blocking_findings, advisory_findings, coverage,
         validation_policy_version, schema_version, prompt_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'accepted', '[]'::jsonb,
         '[]'::jsonb, '{"coveredKeys":["reflection.proposition"],"uncoveredPlannedKeys":[]}'::jsonb, 'narrative-validation:v1',
         'narrative-findings:v1', 'narrative-validate:system-test:v1', $6)`,
      [
        ID.validatorResult,
        ID.validatorRequest,
        OWNER,
        ID.reflectionCommand,
        ID.reflectionAttempt,
        NOW,
      ],
    );

    await database.pool.query(
      `INSERT INTO reflections (
         reflection_id, user_id, scope_type, daily_session_id, created_at
       ) VALUES ($1, $2, 'daily_session', $3, $4)`,
      [ID.reflection, OWNER, ID.dailySession, NOW],
    );
    await database.pool.query(
      `INSERT INTO reflection_versions (
         reflection_version_id, reflection_id, user_id, revision, scope_type,
         source_revision, claim_baseline_digest, schedule_policy_version,
         policy_version, prompt_version, schema_version, locale, status,
         degraded_episode_reason, statements, candidate_proposals,
         generation_command_id, authoritative_model_attempt_id,
         validator_request_id, validator_result_id, committed_at,
         status_effective_at, created_at
       ) VALUES ($1, $2, $3, 1, 'daily_session', 1, 'baseline-digest',
         'reflection-readiness:v1', 'reflection-admission:v1',
         'reflection-daily:system-test:v1', 'reflection-output-schema:v1',
         'en', 'committed', 'raw_event_budget_exceeded', '{}'::jsonb,
         '{}'::jsonb, $4, $5, $6, $7, $8, $8, $8)`,
      [
        ID.reflectionVersion,
        ID.reflection,
        OWNER,
        ID.reflectionCommand,
        ID.reflectionAttempt,
        ID.validatorRequest,
        ID.validatorResult,
        NOW,
      ],
    );
    await database.pool.query(
      `UPDATE reflections
       SET current_version_id = $2
       WHERE reflection_id = $1 AND user_id = $3`,
      [ID.reflection, ID.reflectionVersion, OWNER],
    );
    await database.pool.query(
      `INSERT INTO reflection_statements (
         reflection_statement_id, reflection_version_id, user_id,
         statement_index, statement_kind, statement_text
       ) VALUES ($1, $2, $3, 0, 'day_observation',
         'You have been fixing radios this week.')`,
      [ID.statement, ID.reflectionVersion, OWNER],
    );
    await database.pool.query(
      `INSERT INTO reflection_atomic_propositions (
         reflection_atomic_proposition_id, reflection_statement_id, user_id,
         proposition_index, normalized_proposition, proposition_kind,
         epistemic_rendering, baseline_claim_ids
       ) VALUES ($1, $2, $3, 0, 'user fixes radios', 'fact', 'confirmed',
         '[]'::jsonb)`,
      [ID.proposition, ID.statement, OWNER],
    );
    await database.pool.query(
      `INSERT INTO reflection_statement_evidence_links (
         reflection_statement_evidence_link_id,
         reflection_atomic_proposition_id, user_id, evidence_item_id, created_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [ID.evidenceLink, ID.proposition, OWNER, ID.evidenceItem, NOW],
    );

    await database.pool.query(
      `INSERT INTO memory_candidates (
         memory_candidate_id, user_id, candidate_kind, basis,
         subject_entity_id, predicate_id, predicate_registry_version,
         predicate_resolution_status, proposed_object_value, proposed_scope_key,
         proposed_temporal_status, proposed_valid_from_precision,
         proposed_valid_to_precision, source_reflection_version_id,
         extraction_policy_version, status, created_at
       ) VALUES ($1, $2, 'objective', 'directly_stated', $3, 'sh.memory.hobby',
         1, 'mapped', '"radio repair"'::jsonb, '', 'current', 'unknown',
         'unknown', $4, 'reflection-inspector-system-test:v1', 'accepted', $5)`,
      [ID.candidate, OWNER, ID.entity, ID.reflectionVersion, NOW],
    );
    await database.pool.query(
      `INSERT INTO reflection_candidate_proposals (
         reflection_candidate_proposal_id, reflection_version_id, user_id,
         memory_candidate_id, outcome, reason_code, created_at
       ) VALUES ($1, $2, $3, $4, 'created', 'system-test', $5)`,
      [ID.candidateProposal, ID.reflectionVersion, OWNER, ID.candidate, NOW],
    );
    await database.pool.query(
      `INSERT INTO memory_candidate_evidence_links (
         memory_candidate_evidence_link_id, memory_candidate_id, user_id,
         evidence_item_id, created_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [ID.candidateEvidenceLink, ID.candidate, OWNER, ID.evidenceItem, NOW],
    );
    await database.pool.query(
      `INSERT INTO memory_claims (
         memory_claim_id, user_id, canonical_key, subject_entity_id,
         predicate_id, scope_key, created_at
       ) VALUES ($1, $2, 'self|sh.memory.hobby||radio-repair', $3,
         'sh.memory.hobby', '', $4)`,
      [ID.claim, OWNER, ID.entity, NOW],
    );
    await database.pool.query(
      `INSERT INTO memory_claim_versions (
         memory_claim_version_id, memory_claim_id, user_id, revision, kind,
         epistemic_status, status, subject_entity_version_id, typed_value,
         temporal_status, valid_from_precision, valid_to_precision,
         last_observed_at, created_by, predicate_registry_version, created_at
       ) VALUES ($1, $2, $3, 1, 'objective', 'confirmed', 'active', $4,
         '"radio repair"'::jsonb, 'current', 'unknown', 'unknown', $5,
         'admission', 1, $5)`,
      [ID.claimVersion, ID.claim, OWNER, ID.entityVersion, NOW],
    );
    await database.pool.query(
      `UPDATE memory_claims
       SET current_version_id = $2
       WHERE memory_claim_id = $1 AND user_id = $3`,
      [ID.claim, ID.claimVersion, OWNER],
    );
    await database.pool.query(
      `INSERT INTO workflow_commands (
         workflow_command_id, command_type, subject_type, subject_id,
         source_revision, policy_version, expected_data_epoch,
         coverage_through_sequence_no, intent_key, status, created_at
       ) VALUES ($1, 'daily_consolidation', 'memory_claim', $2, 1,
         'memory-consolidation:v1', 1, 0, 'reflection-inspection-consolidation',
         'created', $3)`,
      [ID.workflowCommand, ID.claim, NOW],
    );
    await database.pool.query(
      `INSERT INTO memory_consolidation_runs (
         memory_consolidation_run_id, user_id, consolidation_kind, anchor_date,
         policy_version, workflow_command_id, expected_data_epoch, status,
         created_at, updated_at
       ) VALUES ($1, $2, 'daily', '2026-09-09', 'memory-consolidation:v1',
         $3, 1, 'consolidated', $4, $4)`,
      [ID.consolidationRun, OWNER, ID.workflowCommand, NOW],
    );
    await database.pool.query(
      `INSERT INTO memory_consolidation_diffs (
         memory_consolidation_diff_id, memory_consolidation_run_id, user_id,
         diff_index, diff_kind, memory_candidate_id, memory_claim_id,
         outcome, reason_code, created_at
       ) VALUES ($1, $2, $3, 0, 'reinforce_existing', $4, $5,
         'reinforced', 'system-test', $6)`,
      [
        ID.consolidationDiff,
        ID.consolidationRun,
        OWNER,
        ID.candidate,
        ID.claim,
        NOW,
      ],
    );

    await database.pool.query(
      `INSERT INTO bios (
         bio_id, user_id, current_source_revision, current_data_epoch,
         created_at, updated_at
       ) VALUES ($1, $2, 1, 1, $3, $3)`,
      [ID.bio, OWNER, NOW],
    );
    await database.pool.query(
      `INSERT INTO bio_versions (
         bio_version_id, bio_id, user_id, revision, status, source_revision,
         expected_data_epoch, source_manifest, presentation_locale,
         generation_command_id, writer_model_run_attempt_id,
         validator_generation_command_id, validator_model_run_attempt_id,
         created_at
       ) VALUES ($1, $2, $3, 1, 'published', 1, 1, '{}'::jsonb, 'en-US',
         $4, $5, $4, $5, $6)`,
      [ID.bioVersion, ID.bio, OWNER, ID.reflectionCommand, ID.reflectionAttempt, NOW],
    );
    await database.pool.query(
      `UPDATE bios
       SET current_version_id = $2
       WHERE bio_id = $1 AND user_id = $3`,
      [ID.bio, ID.bioVersion, OWNER],
    );
    await database.pool.query(
      `INSERT INTO bio_claim_links (
         bio_claim_link_id, bio_version_id, bio_id, user_id,
         memory_claim_version_id, link_role, support_status,
         source_revision, expected_data_epoch, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'input', 'eligible', 1, 1, $6)`,
      [ID.bioClaimLink, ID.bioVersion, ID.bio, OWNER, ID.claimVersion, NOW],
    );
    await database.pool.query(
      `INSERT INTO bio_coverage_units (
         bio_coverage_unit_id, bio_version_id, bio_id, user_id, unit_key,
         disposition, coverage_policy_version, source_revision,
         expected_data_epoch, created_at
       ) VALUES ($1, $2, $3, $4, 'claim:radio-repair', 'covered',
         'bio-coverage:v1', 1, 1, $5)`,
      [ID.coverageUnit, ID.bioVersion, ID.bio, OWNER, NOW],
    );
    await database.pool.query(
      `INSERT INTO bio_coverage_members (
         bio_coverage_unit_id, bio_version_id, user_id,
         memory_claim_version_id, created_at
       ) VALUES ($1, $2, $3, $4, $5)`,
      [ID.coverageUnit, ID.bioVersion, OWNER, ID.claimVersion, NOW],
    );

    const repository = new PostgresReflectionInspectionRepository(
      database.pool,
      "reflection-inspection-system-secret",
      () => NOW,
    );
    service = createReflectionInspectionService({
      clock: () => NOW,
      repository,
    });
  }, 60_000);

  afterAll(async () => {
    await database?.dispose();
  });

  it("traces the real Reflection lineage without writing until Evidence expansion", async () => {
    await service.authorize(OWNER, SESSION_HASH.toString("hex"));

    const beforeDomain = await inspectionDomainSnapshot(database!.pool);
    const beforeAudit = await database!.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM sensitive_access_audits",
    );
    const reflections = await service.listReflections(OWNER, {}, 25);
    expect(reflections.items).toHaveLength(1);
    expect(reflections.items[0]).toMatchObject({
      currentOutcome: null,
      currentVersionId: asReflectionVersionId(ID.reflectionVersion),
      reflectionId: asReflectionId(ID.reflection),
    });

    const versions = await service.listVersions(
      OWNER,
      asReflectionId(ID.reflection),
      asReflectionVersionId(ID.reflectionVersion),
    );
    expect(versions).toMatchObject({ outcome: "ok" });
    if (versions.outcome !== "ok") throw new Error("Version fixture unavailable");
    expect(versions.items[0]).toMatchObject({
      contentState: "available",
      current: true,
      degradedEpisodeReason: "raw_event_budget_exceeded",
      status: "committed",
    });
    expect(versions.items[0]?.metadata).toMatchObject({
      authoritativeModelAttemptId: ID.reflectionAttempt,
      generationCommandId: ID.reflectionCommand,
      modelConfigVersion: "reflection-inspector:v1",
      modelRole: "reflection.daily",
      validationPolicyVersion: "narrative-validation:v1",
      validationCoveredKeys: ["reflection.proposition"],
      validationUncoveredPlannedKeys: [],
      validationVerdict: "accepted",
    });

    const statements = await service.listStatements(
      OWNER,
      asReflectionVersionId(ID.reflectionVersion),
      asReflectionVersionId(ID.reflectionVersion),
    );
    expect(statements).toMatchObject({ outcome: "ok" });
    if (statements.outcome !== "ok") throw new Error("Statement fixture unavailable");

    const propositions = await service.listPropositions(
      OWNER,
      asReflectionStatementId(ID.statement),
      asReflectionVersionId(ID.reflectionVersion),
    );
    expect(propositions).toMatchObject({ outcome: "ok" });
    if (propositions.outcome !== "ok") throw new Error("Proposition fixture unavailable");

    const evidence = await service.listEvidenceLinks(
      OWNER,
      asReflectionAtomicPropositionId(ID.proposition),
      asReflectionVersionId(ID.reflectionVersion),
    );
    expect(evidence).toMatchObject({ outcome: "ok" });
    if (evidence.outcome !== "ok") throw new Error("Evidence fixture unavailable");
    expect(evidence.items[0]).toMatchObject({
      evidenceItemId: asEvidenceItemId(ID.evidenceItem),
      locatorType: "text_span",
      sourceOutcome: "available",
      sourceStatus: "final",
      logicalDate: "2026-09-09",
    });

    const candidates = await service.listCandidates(
      OWNER,
      asReflectionVersionId(ID.reflectionVersion),
      asReflectionVersionId(ID.reflectionVersion),
    );
    expect(candidates).toMatchObject({ outcome: "ok" });
    if (candidates.outcome !== "ok") throw new Error("Candidate fixture unavailable");
    expect(candidates.items[0]).toMatchObject({
      candidateId: asMemoryCandidateId(ID.candidate),
      candidateEvidenceItemIds: [asEvidenceItemId(ID.evidenceItem)],
      candidateStatus: "accepted",
      outcome: "created",
    });

    const claims = await service.listClaimImpacts(
      OWNER,
      asMemoryCandidateId(ID.candidate),
    );
    expect(claims).toMatchObject({ outcome: "ok" });
    if (claims.outcome !== "ok") throw new Error("Claim fixture unavailable");
    expect(claims.items[0]).toMatchObject({
      claimVersionId: asMemoryClaimVersionId(ID.claimVersion),
      eligibility: "eligible",
      isCurrentVersion: true,
    });

    const bio = await service.listBioImpacts(
      OWNER,
      asMemoryClaimVersionId(ID.claimVersion),
    );
    expect(bio).toMatchObject({ outcome: "ok" });
    if (bio.outcome !== "ok") throw new Error("Bio fixture unavailable");
    expect(bio.items[0]).toMatchObject({
      bioId: asBioId(ID.bio),
      bioVersionId: asBioVersionId(ID.bioVersion),
      bioCoverageUnitId: asBioCoverageUnitId(ID.coverageUnit),
      coverageDisposition: "covered",
      current: true,
      linkRole: "input",
      supportStatus: "eligible",
    });

    const afterRead = await database!.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM sensitive_access_audits",
    );
    expect(afterRead.rows[0]?.count).toBe(beforeAudit.rows[0]?.count);
    expect(await inspectionDomainSnapshot(database!.pool)).toBe(beforeDomain);

    const expanded = await service.expandEvidence(
      OWNER,
      SESSION_HASH.toString("hex"),
      asEvidenceItemId(ID.evidenceItem),
    );
    expect(expanded).toEqual({
      outcome: "allowed",
      evidenceItemId: asEvidenceItemId(ID.evidenceItem),
      locale: "en-US",
      logicalDate: "2026-09-09",
      locatorKey: "0:34",
      locatorType: "text_span",
      sourceEventId: ID.event,
      sourceRevisionId: ID.eventRevision,
      sourceStatus: "final",
      text: "I started fixing radios this week.",
    });
    const afterExpansion = await database!.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM sensitive_access_audits",
    );
    expect(Number(afterExpansion.rows[0]?.count)).toBe(
      Number(afterRead.rows[0]?.count) + 1,
    );
    expect(await inspectionDomainSnapshot(database!.pool)).toBe(beforeDomain);
  });

  it("returns typed state-change and empty-Bio outcomes", async () => {
    const stateChanged = await service.listStatements(
      OWNER,
      asReflectionVersionId(ID.reflectionVersion),
      asReflectionVersionId("01984500-0000-7000-8000-000000000021"),
    );
    expect(stateChanged).toMatchObject({
      outcome: "state_changed",
      currentVersionId: asReflectionVersionId(ID.reflectionVersion),
    });

    const noBio = await service.listBioImpacts(OWNER, unknownClaimVersionId);
    expect(noBio).toMatchObject({ outcome: "ok", items: [] });
  });
});
