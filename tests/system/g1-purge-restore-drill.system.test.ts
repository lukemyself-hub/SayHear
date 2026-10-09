import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createOwnerFullPurgeService,
  PURGE_SURFACE_REGISTRY_VERSION,
} from "@sayhear/application";
import {
  PostgresEntityRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresOwnerPurgeRepository,
  PostgresPurgeMarkerRepository,
  purgeMarkerMigrationsDirectory,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const testPurgeMarkerDatabaseUrl = process.env.TEST_PURGE_MARKER_DATABASE_URL;
const databasesReady =
  Boolean(testDatabaseUrl) &&
  Boolean(testPurgeMarkerDatabaseUrl) &&
  testDatabaseUrl !== testPurgeMarkerDatabaseUrl;
const systemDescribe = databasesReady ? describe : describe.skip;

const OWNER = fixedInternalOwnerPrincipal.userId;
// The drill clock must stay behind the real wall clock: the purge marker
// repository stamps writtenAt with wall-clock time, and a marker whose
// purgedAt lies in the future fails snapshot validation by design.
const BASE_TIME = new Date("2026-09-10T10:00:00.000Z");
let clockNowMs = BASE_TIME.getTime();
const clock = () => new Date(clockNowMs);

// Dedicated canary identities for the G1 AC-L02 drill. They never collide
// with the owner-full-purge suite (which uses 11111111/22222222 prefixes).
const D1 = "44444444-4444-7444-8444-444444444401";
const N1 = "44444444-4444-7444-8444-444444444402";
const V1 = "44444444-4444-7444-8444-444444444403";
const R1 = "44444444-4444-7444-8444-444444444404";
const GC1 = "44444444-4444-7444-8444-444444444405";
const MA1 = "44444444-4444-7444-8444-444444444406";
const PD1 = "44444444-4444-7444-8444-444444444407";
// A restored backup replays rows; it never mutates the purge tombstone in
// place (the revision immutability trigger rejects that, by design). The
// restore therefore inserts the backed-up content as a new revision row.
const R_RESTORED = "44444444-4444-7444-8444-444444444408";
const CANARY_TEXT =
  "g1-acl02-seeded-canary: the owner discussed a dentist appointment next Thursday.";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

type CanarySnapshot = Readonly<{
  snapshotAt: string;
  canaries: ReadonlyArray<
    Readonly<{ id: string; sha256: string; table: string }>
  >;
}>;

systemDescribe("G1 AC-L02 purge-before-backup restore drill", () => {
  let database: IsolatedPostgresSchema;
  let markerDatabase: IsolatedPostgresSchema;
  let purgeRepository: PostgresOwnerPurgeRepository;
  let markerRepository: PostgresPurgeMarkerRepository;
  let purgeService: ReturnType<typeof createOwnerFullPurgeService>;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl!);
    await runMigrations(database.pool);
    markerDatabase = await createIsolatedPostgresSchema(
      testPurgeMarkerDatabaseUrl!,
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
  }, 60_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME.getTime();
    await database.pool.query(`
      TRUNCATE TABLE
        conversation_event_generation_command_links,
        proactive_followup_dispositions,
        proactive_followup_uses,
        proactive_followup_reservations,
        proactive_followup_state_versions,
        proactive_followup_states,
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
      validUntil: new Date("2026-10-10T10:00:00.000Z"),
      verifiedAt: new Date("2026-09-01T15:00:00.000Z"),
    });

    purgeRepository = new PostgresOwnerPurgeRepository(database.pool);
    markerRepository = new PostgresPurgeMarkerRepository(markerDatabase.pool);
    purgeService = createOwnerFullPurgeService({
      clock,
      markerRepository,
      providerRetentionDays: 30,
      repository: purgeRepository,
    });
  }, 60_000);

  afterAll(async () => {
    await database?.dispose();
    await markerDatabase?.dispose();
  }, 60_000);

  async function seedCanaryChain(): Promise<void> {
    const t0 = "2026-09-09T15:00:00.000Z";
    const t1 = "2026-09-09T15:01:00.000Z";
    await database.pool.query(`
      INSERT INTO daily_sessions (
        daily_session_id, user_id, logical_date, timezone_at_start, started_at,
        last_activity_at, activity_state, current_continuous_exchange_no,
        dialogue_revision, source_revision, next_turn_sequence_no,
        next_event_sequence_no, created_at, updated_at, quiescent_at,
        quiescent_reason
      ) VALUES (
        '${D1}', '${OWNER}', '2026-09-09', 'UTC', '${t0}', '${t1}',
        'finalized', 1, 1, 1, 2, 3, '${t0}', '${t1}', '${t1}',
        'explicit_user_end'
      );
      INSERT INTO interaction_turns (
        interaction_turn_id, user_id, daily_session_id, client_turn_id,
        turn_sequence_no, continuous_exchange_no, status, started_at,
        settled_at, created_at, updated_at
      ) VALUES (
        '${N1}', '${OWNER}', '${D1}', 'g1-acl02-turn', 1, 1, 'settled',
        '${t0}', '${t1}', '${t0}', '${t1}'
      );
      INSERT INTO conversation_events (
        conversation_event_id, user_id, daily_session_id, interaction_turn_id,
        sequence_no, client_event_id, actor, channel, event_type,
        lifecycle_status, created_at
      ) VALUES (
        '${V1}', '${OWNER}', '${D1}', '${N1}', 1, 'g1-acl02-event', 'user',
        'text', 'user_message', 'active', '${t0}'
      );
      INSERT INTO conversation_event_revisions (
        conversation_event_revision_id, user_id, conversation_event_id,
        revision, locale, canonical_text, transcript_status, created_by,
        created_at
      ) VALUES (
        '${R1}', '${OWNER}', '${V1}', 1, 'en', '${CANARY_TEXT}',
        'final', 'client', '${t0}'
      );
      UPDATE conversation_events SET current_revision_id = '${R1}'
        WHERE conversation_event_id = '${V1}';
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
        '${GC1}', '${OWNER}', '${N1}', 'conversation.text', 'g1-acl02-intent',
        'conversation_event', '${V1}', 'conversation_event_revision', '${R1}',
        'conversation-text:v1', 'product-policy:v1',
        'minimum-high-risk-response:v1', 'relationship-boundary:v1',
        'locale-pack-en:v1', 'en', 'openai', 'gpt-5.4', 'gpt-5.4',
        'conversation-text-champion:v1', 'source_valid:v1', 1, 'succeeded',
        '${t0}', '${t1}', 'conversation-output:v1', 'sayhear-persona:v1',
        'conversation-harness:v1', 'conversation-action-catalog:empty:v1',
        'openai-conversation-text:v1'
      );
      INSERT INTO model_run_attempts (
        model_run_attempt_id, user_id, generation_command_id, attempt_no,
        operation_type, provider, model, model_snapshot, prompt_version,
        status, started_at, completed_at, created_at
      ) VALUES (
        '${MA1}', '${OWNER}', '${GC1}', 1, 'conversation.text', 'openai',
        'gpt-5.4', 'gpt-5.4', 'conversation-text:v1', 'succeeded', '${t0}',
        '${t1}', '${t0}'
      );
      INSERT INTO provider_egress_dispositions (
        provider_egress_disposition_id, user_id, model_run_attempt_id,
        provider, model, role, provider_policy_version, expected_data_epoch,
        status, checked_at, dispatched_at, completed_at
      ) VALUES (
        '${PD1}', '${OWNER}', '${MA1}', 'openai', 'gpt-5.4',
        'conversation.text', 'openai-conversation-text:v1', 1, 'completed',
        '${t0}', '${t0}', '${t1}'
      );
    `);
  }

  function captureSnapshot(): CanarySnapshot {
    return {
      snapshotAt: clock().toISOString(),
      canaries: [
        {
          table: "conversation_event_revisions",
          id: R1,
          sha256: sha256Hex(CANARY_TEXT),
        },
        {
          table: "generation_commands",
          id: GC1,
          sha256: sha256Hex(`${GC1}:conversation.text:1`),
        },
      ],
    };
  }

  async function countRows(sql: string): Promise<number> {
    const result = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM (${sql}) AS counted`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

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

  it("AC-L02 drill seeded canary capture: pre-purge backup snapshot predates the purge", async () => {
    await seedCanaryChain();
    const snapshot = captureSnapshot();

    // The backup snapshot is taken before the purge starts; the drill clock
    // advances so the ordering is explicit, not inferred from equal timestamps.
    clockNowMs += 1_000;
    const { order } = await startPurgeOrder();

    expect(snapshot.canaries).toHaveLength(2);
    expect(new Date(snapshot.snapshotAt).getTime()).toBeLessThan(
      order.requestedAt.getTime(),
    );
    expect(await countRows("SELECT 1 FROM conversation_events")).toBe(1);
    expect(
      await countRows(
        `SELECT 1 FROM conversation_event_revisions WHERE conversation_event_revision_id = '${R1}' AND canonical_text = '${CANARY_TEXT}'`,
      ),
    ).toBe(1);
  }, 60_000);

  it("AC-L02 drill purge-first inflight order: stale epoch writes are fenced after the purge", async () => {
    await seedCanaryChain();
    const { order } = await startPurgeOrder();
    const result = await purgeService.propagate({
      ownerPurgeOrderId: order.ownerPurgeOrderId,
    });
    expect(result.status).toBe("retention_pending");

    // Order A (purge first, late result after): an in-flight write carrying
    // the pre-purge epoch is rejected before it can create a row.
    const entityRepository = new PostgresEntityRepository(database.pool);
    await expect(
      entityRepository.ensureSelfEntity({
        expectedDataEpoch: 1,
        now: clock(),
        userId: OWNER,
      }),
    ).rejects.toThrow(/fenced by the owner data epoch/);
    expect(await countRows("SELECT 1 FROM generation_commands")).toBe(0);
    expect(await countRows("SELECT 1 FROM model_run_attempts")).toBe(0);
  }, 60_000);

  it("AC-L02 drill write-first inflight order: pre-purge canaries are cleared with no resurrection", async () => {
    await seedCanaryChain();
    const { order } = await startPurgeOrder();
    const result = await purgeService.propagate({
      ownerPurgeOrderId: order.ownerPurgeOrderId,
    });
    expect(result.status).toBe("retention_pending");

    // Order B (result first, purge after): everything written before the
    // purge is cleared; revisions survive only as content-free tombstones.
    for (const table of [
      "conversation_events",
      "interaction_turns",
      "daily_sessions",
      "generation_commands",
      "model_run_attempts",
      "provider_egress_dispositions",
    ]) {
      expect(await countRows(`SELECT 1 FROM ${table}`)).toBe(0);
    }
    const revisions = await database.pool.query<{
      canonical_text: string;
      content_purged_at: Date | null;
    }>(
      "SELECT canonical_text, content_purged_at FROM conversation_event_revisions WHERE user_id = $1",
      [OWNER],
    );
    expect(revisions.rows).toHaveLength(1);
    expect(revisions.rows[0]).toMatchObject({ canonical_text: "" });
    expect(revisions.rows[0]?.content_purged_at).not.toBeNull();
    const owner = await database.pool.query<{
      status: string;
      data_epoch: string;
    }>("SELECT status, data_epoch::text FROM app_users WHERE user_id = $1", [
      OWNER,
    ]);
    expect(owner.rows[0]).toMatchObject({ status: "active", data_epoch: "2" });
  }, 60_000);

  it("AC-L02 drill restore and marker reapply: pre-purge backup restore cannot resurrect content past the marker gate", async () => {
    await seedCanaryChain();
    const snapshot = captureSnapshot();
    clockNowMs += 1_000;
    const { order } = await startPurgeOrder();
    const first = await purgeService.propagate({
      ownerPurgeOrderId: order.ownerPurgeOrderId,
    });
    expect(first.status).toBe("retention_pending");

    // The external marker is authoritative and lives outside the business
    // backup domain. Traffic stays blocked on the advanced epoch.
    const markerBefore = await markerRepository.findMarker({
      dataEpoch: 2,
      userId: OWNER,
    });
    expect(markerBefore).not.toBeNull();

    // Simulate restoring the pre-purge backup: the snapshot rows replay into
    // the purged database, including the canary content as a new revision.
    await seedCanaryChainRestored();
    const restored = await database.pool.query<{ canonical_text: string }>(
      "SELECT canonical_text FROM conversation_event_revisions WHERE conversation_event_revision_id = $1",
      [R_RESTORED],
    );
    expect(restored.rows).toHaveLength(1);
    expect(sha256Hex(restored.rows[0]?.canonical_text ?? "")).toBe(
      snapshot.canaries[0]?.sha256,
    );

    // Before the marker is reapplied, stale-epoch traffic is still fenced.
    const entityRepository = new PostgresEntityRepository(database.pool);
    await expect(
      entityRepository.ensureSelfEntity({
        expectedDataEpoch: 1,
        now: clock(),
        userId: OWNER,
      }),
    ).rejects.toThrow(/fenced by the owner data epoch/);

    // Reapplying the marker reopens the order and immediately drives a
    // fresh marker-sourced clear pass to convergence; only then may traffic
    // resume. The drill clock stays frozen so retention horizons are
    // recomputed deterministically and the marker stays byte-identical.
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
    const reopened = await purgeRepository.findLatestOrder({ userId: OWNER });
    expect(reopened?.status).toBe("retention_pending");

    // The restored canary content did not resurrect: rows are cleared again
    // and every revision (original and restored) is a content-free tombstone.
    for (const table of [
      "conversation_events",
      "interaction_turns",
      "daily_sessions",
      "generation_commands",
      "model_run_attempts",
      "provider_egress_dispositions",
    ]) {
      expect(await countRows(`SELECT 1 FROM ${table}`)).toBe(0);
    }
    const tombstones = await database.pool.query<{
      canonical_text: string;
      content_purged_at: Date | null;
    }>(
      "SELECT canonical_text, content_purged_at FROM conversation_event_revisions WHERE user_id = $1",
      [OWNER],
    );
    expect(tombstones.rows).toHaveLength(2);
    for (const tombstone of tombstones.rows) {
      expect(tombstone).toMatchObject({ canonical_text: "" });
      expect(tombstone.content_purged_at).not.toBeNull();
    }

    // The marker still pins epoch 2 with the frozen registry version.
    const markerAfter = await markerRepository.findMarker({
      dataEpoch: 2,
      userId: OWNER,
    });
    expect(markerAfter).toMatchObject({
      dataEpoch: 2,
      status: "retention_pending",
    });
    expect(markerAfter?.backupRetentionUntil).toEqual(
      markerBefore?.backupRetentionUntil,
    );
    expect(PURGE_SURFACE_REGISTRY_VERSION).toBe(
      "purge-surface-registry:v1",
    );
  }, 120_000);

  it("keeps the purge-marker schema contract exact and fails closed on an unregistered migration", async () => {
    const applied = await markerDatabase.pool.query<{
      migration_name: string;
      migration_sha256: string;
    }>(
      `SELECT migration_name, migration_sha256
       FROM schema_migrations
       ORDER BY migration_name`,
    );
    const pins = applied.rows.map((row) => ({
      name: row.migration_name,
      sha256: row.migration_sha256,
    }));
    const contract = {
      purgeMarkerMigrations: pins,
      purgeMarkerFingerprint: `sha256:${"a".repeat(64)}`,
    };
    const exact = new PostgresPurgeMarkerRepository(
      markerDatabase.pool,
      contract,
    );
    await expect(exact.findLatestMarker({ userId: OWNER })).resolves.toBeNull();

    await markerDatabase.pool.query(
      `INSERT INTO schema_migrations (migration_name, migration_sha256)
       VALUES ('9999_unregistered.sql', $1)`,
      ["a".repeat(64)],
    );
    try {
      await expect(exact.findLatestMarker({ userId: OWNER })).rejects.toThrow(
        /Purge-marker schema does not match the frozen G1 migration contract/,
      );
    } finally {
      await markerDatabase.pool.query(
        "DELETE FROM schema_migrations WHERE migration_name = '9999_unregistered.sql'",
      );
    }
  }, 60_000);

  async function seedCanaryChainRestored(): Promise<void> {
    // The purge tombstoned the R1 revision row instead of deleting it, and
    // the immutability trigger forbids rewriting that tombstone. A restored
    // backup therefore replays the backed-up content as a new revision row
    // while re-inserting the cleared parent chain.
    const t0 = "2026-09-09T15:00:00.000Z";
    const t1 = "2026-09-09T15:01:00.000Z";
    await database.pool.query(`
      INSERT INTO daily_sessions (
        daily_session_id, user_id, logical_date, timezone_at_start, started_at,
        last_activity_at, activity_state, current_continuous_exchange_no,
        dialogue_revision, source_revision, next_turn_sequence_no,
        next_event_sequence_no, created_at, updated_at, quiescent_at,
        quiescent_reason
      ) VALUES (
        '${D1}', '${OWNER}', '2026-09-09', 'UTC', '${t0}', '${t1}',
        'finalized', 1, 1, 1, 2, 3, '${t0}', '${t1}', '${t1}',
        'explicit_user_end'
      );
      INSERT INTO interaction_turns (
        interaction_turn_id, user_id, daily_session_id, client_turn_id,
        turn_sequence_no, continuous_exchange_no, status, started_at,
        settled_at, created_at, updated_at
      ) VALUES (
        '${N1}', '${OWNER}', '${D1}', 'g1-acl02-turn', 1, 1, 'settled',
        '${t0}', '${t1}', '${t0}', '${t1}'
      );
      INSERT INTO conversation_events (
        conversation_event_id, user_id, daily_session_id, interaction_turn_id,
        sequence_no, client_event_id, actor, channel, event_type,
        lifecycle_status, created_at
      ) VALUES (
        '${V1}', '${OWNER}', '${D1}', '${N1}', 1, 'g1-acl02-event', 'user',
        'text', 'user_message', 'active', '${t0}'
      );
      INSERT INTO conversation_event_revisions (
        conversation_event_revision_id, user_id, conversation_event_id,
        revision, locale, canonical_text, transcript_status, created_by,
        created_at
      ) VALUES (
        '${R_RESTORED}', '${OWNER}', '${V1}', 2, 'en', '${CANARY_TEXT}',
        'final', 'client', '${t1}'
      );
      UPDATE conversation_events SET current_revision_id = '${R_RESTORED}'
        WHERE conversation_event_id = '${V1}';
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
        '${GC1}', '${OWNER}', '${N1}', 'conversation.text', 'g1-acl02-intent',
        'conversation_event', '${V1}', 'conversation_event_revision', '${R_RESTORED}',
        'conversation-text:v1', 'product-policy:v1',
        'minimum-high-risk-response:v1', 'relationship-boundary:v1',
        'locale-pack-en:v1', 'en', 'openai', 'gpt-5.4', 'gpt-5.4',
        'conversation-text-champion:v1', 'source_valid:v1', 1, 'succeeded',
        '${t0}', '${t1}', 'conversation-output:v1', 'sayhear-persona:v1',
        'conversation-harness:v1', 'conversation-action-catalog:empty:v1',
        'openai-conversation-text:v1'
      );
      INSERT INTO model_run_attempts (
        model_run_attempt_id, user_id, generation_command_id, attempt_no,
        operation_type, provider, model, model_snapshot, prompt_version,
        status, started_at, completed_at, created_at
      ) VALUES (
        '${MA1}', '${OWNER}', '${GC1}', 1, 'conversation.text', 'openai',
        'gpt-5.4', 'gpt-5.4', 'conversation-text:v1', 'succeeded', '${t0}',
        '${t1}', '${t0}'
      );
      INSERT INTO provider_egress_dispositions (
        provider_egress_disposition_id, user_id, model_run_attempt_id,
        provider, model, role, provider_policy_version, expected_data_epoch,
        status, checked_at, dispatched_at, completed_at
      ) VALUES (
        '${PD1}', '${OWNER}', '${MA1}', 'openai', 'gpt-5.4',
        'conversation.text', 'openai-conversation-text:v1', 1, 'completed',
        '${t0}', '${t0}', '${t1}'
      );
    `);
  }
});
