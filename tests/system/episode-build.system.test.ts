import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EPISODE_ADMISSION_POLICY_VERSION, episodeDedupeFingerprint, type EpisodeProposal, type ModelRoleConfigurationSnapshot } from "@sayhear/application";
import { asDailySessionId, asEvidenceItemId, asGenerationCommandId, asModelRunAttemptId } from "@sayhear/domain";
import { PostgresEpisodeRepository, runMigrations } from "@sayhear/data";
import { createIsolatedPostgresSchema, fixedInternalOwnerPrincipal, type IsolatedPostgresSchema } from "@sayhear/test-support";
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const systemDescribe = testDatabaseUrl ? describe : describe.skip;
const OWNER = fixedInternalOwnerPrincipal.userId;
const BASE_TIME = Date.parse("2026-09-09T08:00:00.000Z");
const G1_FINGERPRINT = `sha256:${"d".repeat(64)}`;
const configuration: ModelRoleConfigurationSnapshot = {
  role: "episode.build", configVersion: "system-episode:v1", provider: "system-test",
  model: "synthetic-model", modelSnapshot: "synthetic-model@fixture",
  promptVersion: "episode-build:system-test:v1", schemaVersion: "episode-proposal:v1",
  rolePolicyVersion: "1a3b-model-role-policy:v1", providerPolicyVersion: "system-episode-egress:v1",
  rolloutPin: "system-episode-pin:v1", freshnessPolicy: "exact_head:v1",
  fallbackMode: "disabled", maxTechnicalRetries: 1, maxSemanticRepairs: 0, parameterSnapshot: {},
};
async function seedRoleConfiguration(
  pool: IsolatedPostgresSchema["pool"],
  configuration: ModelRoleConfigurationSnapshot,
): Promise<void> {
  await pool.query(
    `INSERT INTO provider_egress_policy_versions (
       policy_version, provider, role, model_config_version, status, created_at
     ) VALUES ($1, $2, $3, $4, 'active', $5)`,
    [
      configuration.providerPolicyVersion,
      configuration.provider,
      configuration.role,
      configuration.configVersion,
      new Date(BASE_TIME),
    ],
  );
  await pool.query(
    `INSERT INTO model_role_configurations (
       role, config_version, provider, model, model_snapshot, prompt_version,
       schema_version, role_policy_version, provider_policy_version,
       freshness_policy, fallback_mode, max_technical_retries,
       max_semantic_repairs, parameter_snapshot, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
    [
      configuration.role,
      configuration.configVersion,
      configuration.provider,
      configuration.model,
      configuration.modelSnapshot,
      configuration.promptVersion,
      configuration.schemaVersion,
      configuration.rolePolicyVersion,
      configuration.providerPolicyVersion,
      configuration.freshnessPolicy,
      configuration.fallbackMode,
      configuration.maxTechnicalRetries,
      configuration.maxSemanticRepairs,
      JSON.stringify(configuration.parameterSnapshot),
      new Date(BASE_TIME),
    ],
  );
  await pool.query(
    "UPDATE model_role_definitions SET enabled = TRUE WHERE role = $1",
    [configuration.role],
  );
  await pool.query(
    `INSERT INTO model_role_rollout_pins (
       role, rollout_pin, config_version, provider_policy_version,
       release_fingerprint, status, activated_at
     ) VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
    [
      configuration.role,
      configuration.rolloutPin,
      configuration.configVersion,
      configuration.providerPolicyVersion,
      G1_FINGERPRINT,
      new Date(BASE_TIME),
    ],
  );
}

systemDescribe("Episode admission transaction", () => {
  let database: IsolatedPostgresSchema | undefined;
  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl!);
    await runMigrations(database.pool);
    await database.pool.query(`INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at) VALUES ($1, 'active', 1, $2, $2)`, [OWNER, new Date(BASE_TIME)]);
    await seedRoleConfiguration(database.pool, configuration);
  }, 30_000);
  afterAll(async () => { await database?.dispose(); });
  let sequence = 0;
  function seedId(): string {
    sequence += 1;
    return `01990000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
  }
  /** Seeds one quiescent session with one whole-revision Evidence item. */
  async function seedSession(input: { logicalDate: string }): Promise<{
    dailySessionId: ReturnType<typeof asDailySessionId>;
    evidenceItemId: ReturnType<typeof asEvidenceItemId>;
    revisionId: string;
    conversationEventId: string;
  }> {
    const dailySessionId = seedId();
    const interactionTurnId = seedId();
    const conversationEventId = seedId();
    const revisionId = seedId();
    const snapshotId = seedId();
    const evidenceItemId = seedId();
    const now = new Date(BASE_TIME);
    await database!.pool.query(
      `INSERT INTO daily_sessions (
         daily_session_id, user_id, logical_date, timezone_at_start, started_at,
         last_activity_at, activity_state, current_continuous_exchange_no,
         dialogue_revision, source_revision, next_turn_sequence_no,
         next_event_sequence_no, quiescent_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'UTC', $4, $4, 'quiescent', 1, 0, 1, 1, 1, $4, $4, $4)`,
      [dailySessionId, OWNER, input.logicalDate, now],
    );
    await database!.pool.query(
      `INSERT INTO interaction_turns (
         interaction_turn_id, user_id, daily_session_id, client_turn_id,
         turn_sequence_no, continuous_exchange_no, status, started_at,
         settled_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'turn:' || $5, 1, 1, 'settled', $4, $4, $4, $4)`,
      [interactionTurnId, OWNER, dailySessionId, now, interactionTurnId],
    );
    await database!.pool.query(
      `INSERT INTO conversation_events (
         conversation_event_id, user_id, daily_session_id, interaction_turn_id,
         sequence_no, client_event_id, actor, channel, event_type,
         lifecycle_status, created_at
       ) VALUES ($1, $2, $3, $4, 1, 'event:' || $5, 'user', 'text', 'message',
         'active', $6)`,
      [conversationEventId, OWNER, dailySessionId, interactionTurnId, conversationEventId, now],
    );
    await database!.pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, canonical_text, locale, transcript_status, created_by, created_at
       ) VALUES ($1, $2, $3, 1, 'I fly to Tokyo on September 9 for a business trip.', 'en-US',
         'final', 'client', $4)`,
      [revisionId, OWNER, conversationEventId, now],
    );
    await database!.pool.query(
      "UPDATE conversation_events SET current_revision_id = $2 WHERE conversation_event_id = $1",
      [conversationEventId, revisionId],
    );
    await database!.pool.query(
      `INSERT INTO evidence_source_snapshots (
         evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
         extraction_policy_version, command_id, attempt_id,
         champion_config_version, champion_provider, champion_model,
         champion_snapshot, champion_provider_policy_version, created_at
       ) VALUES ($1, $2, $3, 1, 'evidence-extraction:v2', 'seed', 'seed', 'test', 'openai', 'test', 'test', 'test', $4)`,
      [snapshotId, OWNER, dailySessionId, now],
    );
    await database!.pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
         source_revision_id, source_actor, source_status, locator_type,
         locator_key, extraction_policy_version, evidence_role, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision', '1:0',
         'evidence-extraction:v2', 'factual_support', $6)`,
      [evidenceItemId, OWNER, snapshotId, conversationEventId, revisionId, now],
    );
    return {
      dailySessionId: asDailySessionId(dailySessionId),
      evidenceItemId: asEvidenceItemId(evidenceItemId),
      revisionId,
      conversationEventId,
    };
  }

  /**
   * Appends a corrected whole-revision Evidence item, advances the conversation
   * event head, and advances the session source revision. Evidence snapshots
   * are immutable, so an advancing head is a new snapshot, never an UPDATE.
   */
  async function advanceSourceRevision(input: {
    dailySessionId: ReturnType<typeof asDailySessionId>;
    conversationEventId: string;
    sourceRevision: number;
    canonicalText: string;
  }): Promise<{
    evidenceItemId: ReturnType<typeof asEvidenceItemId>;
    revisionId: string;
  }> {
    const revisionId = seedId();
    const snapshotId = seedId();
    const evidenceItemId = seedId();
    const now = new Date(BASE_TIME);
    await database!.pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, canonical_text, locale, transcript_status, created_by, created_at
       ) VALUES ($1, $2, $3, 2, $4, 'en-US', 'corrected', 'client', $5)`,
      [revisionId, OWNER, input.conversationEventId, input.canonicalText, now],
    );
    await database!.pool.query(
      "UPDATE conversation_events SET current_revision_id = $2 WHERE conversation_event_id = $1",
      [input.conversationEventId, revisionId],
    );
    await database!.pool.query(
      `INSERT INTO evidence_source_snapshots (
         evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
         extraction_policy_version, command_id, attempt_id,
         champion_config_version, champion_provider, champion_model,
         champion_snapshot, champion_provider_policy_version, created_at
       ) VALUES ($1, $2, $3, $4, 'evidence-extraction:v2', 'seed-advanced', 'seed-advanced', 'test', 'openai', 'test', 'test', 'test', $5)`,
      [snapshotId, OWNER, input.dailySessionId, input.sourceRevision, now],
    );
    await database!.pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
         source_revision_id, source_actor, source_status, locator_type,
         locator_key, extraction_policy_version, evidence_role, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'user', 'corrected', 'whole_revision', '1:0',
         'evidence-extraction:v2', 'factual_support', $6)`,
      [evidenceItemId, OWNER, snapshotId, input.conversationEventId, revisionId, now],
    );
    await database!.pool.query(
      "UPDATE daily_sessions SET source_revision = $2 WHERE daily_session_id = $1",
      [input.dailySessionId, input.sourceRevision],
    );
    return { evidenceItemId: asEvidenceItemId(evidenceItemId), revisionId };
  }

  /** Seeds a running episode.build command and its first running attempt. */
  async function seedRunningGeneration(input: {
    dailySessionId: ReturnType<typeof asDailySessionId>;
    sourceRevision: number;
    rolloutPin?: string;
    configVersion?: string;
    providerPolicyVersion?: string;
  }): Promise<{
    generationCommandId: ReturnType<typeof asGenerationCommandId>;
    modelRunAttemptId: ReturnType<typeof asModelRunAttemptId>;
  }> {
    const generationCommandId = asGenerationCommandId(seedId());
    const modelRunAttemptId = asModelRunAttemptId(seedId());
    const intentKey = `rotated-draft:${seedId()}`;
    const rolloutPin = input.rolloutPin ?? "system-episode-pin:v1";
    const configVersion = input.configVersion ?? "system-episode:v1";
    const providerPolicyVersion =
      input.providerPolicyVersion ?? "system-episode-egress:v1";
    const now = new Date(BASE_TIME);
    await database!.pool.query(
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
       ) VALUES ($1, $2, 'episode.build', $5, 'daily_session',
         $3, 'episode.build', 'reflection-output-schema:v1',
         'episode-build:system-test:v1', 'product-policy:v1',
         'minimum-high-risk-response:v1', 'relationship-boundary:v1',
         'locale-policy:v1', 'en', 'system-test', 'synthetic-model',
         'synthetic-model@fixture', $8,
         'exact_head:v1', 'reflection-output:v1',
         'conversation-harness:v1', 'memory-trust-actions-catalog:v1',
          '1a3b-model-role-policy:v1', $7,
          $9, $4, '{}'::jsonb, 'disabled', 1,
          'running', $6)`,
      [generationCommandId, OWNER, input.dailySessionId, input.sourceRevision, intentKey, now, rolloutPin, configVersion, providerPolicyVersion],
    );
    await database!.pool.query(
      `INSERT INTO model_run_attempts (
         model_run_attempt_id, user_id, generation_command_id, attempt_no,
         operation_type, provider, model, model_snapshot, prompt_version,
         attempt_kind, status, created_at
       ) VALUES ($1, $2, $3, 1, 'episode.build', 'system-test',
         'synthetic-model', 'synthetic-model@fixture',
         'episode-build:system-test:v1', 'initial', 'running', $4)`,
      [modelRunAttemptId, OWNER, generationCommandId, now],
    );
    return { generationCommandId, modelRunAttemptId };
  }

  it("commits valid Episodes alongside rejected proposals and preserves rejection retention and replay fences", async () => {
    const session = await seedSession({ logicalDate: "2026-09-09" });
    const { generationCommandId, modelRunAttemptId } = await seedRunningGeneration({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });

    const proposal: EpisodeProposal = {
      proposedKind: "sh.episode.trip", label: "Tokyo business trip",
      temporalAnchor: { start: { date: "2026-09-09", precision: "exact" } },
      phase: "planned", kindFields: { destination: "Tokyo" },
      citedEvidenceItemIds: [session.evidenceItemId], realWorldOccurrence: true,
    };
    const input = {
      userId: OWNER, dailySessionId: session.dailySessionId, sourceRevision: 1,
      expectedDataEpoch: 1, generationCommandId, modelRunAttemptId,
      policyVersion: EPISODE_ADMISSION_POLICY_VERSION, dedupeFingerprintSecret: "synthetic-episode-secret",
      proposals: [proposal, { ...proposal, label: "Unsupported trip", temporalAnchor: { start: { date: "2026-10-01", precision: "exact" as const } }, kindFields: { destination: "Osaka" }, citedEvidenceItemIds: [] }],
    };
    const repository = new PostgresEpisodeRepository(database!.pool);
    expect(await repository.commitEpisodeAdmission(input)).toMatchObject({
      outcome: "committed", acceptedCount: 1, rejectedCount: 1, candidateCount: 2,
    });
    const candidates = await database!.pool.query(`SELECT status, reproposal_policy, disposition_reason_code, disposition_policy_version, terminal_effective_at, terminal_content_expires_at, decided_at, dedupe_fingerprint FROM episode_candidates ORDER BY status`);
    expect(candidates.rows).toHaveLength(2);
    expect(candidates.rows[0]).toMatchObject({ status: "accepted", reproposal_policy: null });
    expect(candidates.rows[0].dedupe_fingerprint).toBe(episodeDedupeFingerprint({
      userId: OWNER, semanticTarget: "sh.episode.trip|new|2026-09-09|exact|",
      evidenceRevisionIds: [session.revisionId], policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
      secret: input.dedupeFingerprintSecret,
    }));
    expect(candidates.rows[1]).toMatchObject({ status: "rejected", reproposal_policy: "material_change_allowed", disposition_policy_version: EPISODE_ADMISSION_POLICY_VERSION });
    const rejected = candidates.rows[1]!;
    expect(rejected.disposition_reason_code).toBeTruthy();
    expect(rejected.dedupe_fingerprint).toBeTruthy();
    expect(rejected.decided_at).toEqual(rejected.terminal_effective_at);
    expect(rejected.terminal_content_expires_at.getTime()).toBeGreaterThan(rejected.terminal_effective_at.getTime());
    expect((await database!.pool.query("SELECT status FROM episode_versions")).rows).toEqual([{ status: "current" }]);
    expect(await repository.commitEpisodeAdmission(input)).toMatchObject({ outcome: "already_built" });
    expect((await database!.pool.query("SELECT count(*)::int AS count FROM episode_candidates")).rows[0].count).toBe(2);
    expect(await repository.commitEpisodeAdmission({ ...input, expectedDataEpoch: 2 })).toEqual({ outcome: "fenced", reason: "data_epoch" });
    const continued = await advanceSourceRevision({
      dailySessionId: session.dailySessionId,
      conversationEventId: session.conversationEventId,
      sourceRevision: 2,
      canonicalText: "I am still on the Tokyo business trip.",
    });
    const continuation = await seedRunningGeneration({
      dailySessionId: session.dailySessionId,
      sourceRevision: 2,
    });
    expect(await repository.commitEpisodeAdmission({
      ...input,
      sourceRevision: 2,
      generationCommandId: continuation.generationCommandId,
      modelRunAttemptId: continuation.modelRunAttemptId,
      proposals: [{
        ...proposal,
        phase: "ongoing",
        citedEvidenceItemIds: [continued.evidenceItemId],
      }],
    })).toMatchObject({ outcome: "committed", acceptedCount: 1 });

    const versions = await database!.pool.query("SELECT episode_version_id, episode_id, revision, status, supersedes_version_id FROM episode_versions ORDER BY revision");
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[0]).toMatchObject({ revision: 1, status: "superseded", supersedes_version_id: null });
    expect(versions.rows[1]).toMatchObject({ revision: 2, status: "current", supersedes_version_id: versions.rows[0].episode_version_id });

    // Committing the continuation must not disturb the earlier rejection's
    // terminal envelope: retention survives later successful builds.
    const retainedRejection = await database!.pool.query("SELECT status, reproposal_policy, terminal_effective_at, terminal_content_expires_at, decided_at FROM episode_candidates WHERE status = 'rejected'");
    expect(retainedRejection.rows).toHaveLength(1);
    expect(retainedRejection.rows[0]).toMatchObject({ status: "rejected", reproposal_policy: "material_change_allowed" });
    expect(retainedRejection.rows[0].terminal_content_expires_at).not.toBeNull();

    // The continuation fingerprint binds the keyed fence to the advanced
    // Evidence revision and the continued Episode identity, not a new target.
    const continuedCandidate = await database!.pool.query("SELECT status, dedupe_fingerprint FROM episode_candidates WHERE source_revision = 2");
    expect(continuedCandidate.rows).toHaveLength(1);
    expect(continuedCandidate.rows[0]).toMatchObject({ status: "accepted" });
    expect(continuedCandidate.rows[0].dedupe_fingerprint).toBe(episodeDedupeFingerprint({
      userId: OWNER,
      semanticTarget: `sh.episode.trip|${versions.rows[0].episode_id}|2026-09-09|exact|`,
      evidenceRevisionIds: [continued.revisionId],
      policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
      secret: input.dedupeFingerprintSecret,
    }));
  });

  it("fences a late episode.build attempt after its pin is revoked and re-bound", async () => {
    const session = await seedSession({ logicalDate: "2026-09-10" });
    const proposal: EpisodeProposal = {
      proposedKind: "sh.episode.trip", label: "Tokyo business trip",
      temporalAnchor: { start: { date: "2026-09-10", precision: "exact" } },
      phase: "planned", kindFields: { destination: "Tokyo" },
      citedEvidenceItemIds: [session.evidenceItemId], realWorldOccurrence: true,
      explicitNewOccurrence: true,
    };
    const admissionInput = {
      userId: OWNER, dailySessionId: session.dailySessionId, sourceRevision: 1,
      expectedDataEpoch: 1, policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
      dedupeFingerprintSecret: "synthetic-episode-secret",
      proposals: [proposal],
    };
    // The late callback froze under the v1 pin before rollback.
    const stale = await seedRunningGeneration({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });
    // Rollback revokes v1 and binds the new v2 pin for the same role.
    await database!.pool.query(
      "UPDATE model_role_rollout_pins SET status = 'revoked', revoked_at = $1 WHERE role = 'episode.build' AND status = 'active'",
      [new Date(BASE_TIME)],
    );
    await seedRoleConfiguration(database!.pool, {
      ...configuration,
      configVersion: "system-episode:v2",
      providerPolicyVersion: "system-episode-egress:v2",
      rolloutPin: "system-episode-pin:v2",
    });
    const repository = new PostgresEpisodeRepository(database!.pool);
    expect(await repository.commitEpisodeAdmission({
      ...admissionInput,
      generationCommandId: stale.generationCommandId,
      modelRunAttemptId: stale.modelRunAttemptId,
    })).toEqual({ outcome: "fenced", reason: "attempt_settled" });
    expect((await database!.pool.query(
      "SELECT count(*)::int AS count FROM episode_candidates WHERE daily_session_id = $1",
      [session.dailySessionId],
    )).rows[0].count).toBe(0);
    // A fresh attempt frozen under the newly active pin commits.
    const fresh = await seedRunningGeneration({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
      rolloutPin: "system-episode-pin:v2",
      configVersion: "system-episode:v2",
      providerPolicyVersion: "system-episode-egress:v2",
    });
    expect(await repository.commitEpisodeAdmission({
      ...admissionInput,
      generationCommandId: fresh.generationCommandId,
      modelRunAttemptId: fresh.modelRunAttemptId,
    })).toMatchObject({ outcome: "committed", acceptedCount: 1 });
    expect((await database!.pool.query(
      "SELECT status FROM episode_candidates WHERE daily_session_id = $1",
      [session.dailySessionId],
    )).rows).toEqual([{ status: "accepted" }]);
  });
});
