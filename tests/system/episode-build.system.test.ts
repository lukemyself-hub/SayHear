import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EPISODE_ADMISSION_POLICY_VERSION, episodeDedupeFingerprint, type EpisodeProposal, type ModelRoleConfigurationSnapshot } from "@sayhear/application";
import { asDailySessionId, asEvidenceItemId, asGenerationCommandId, asModelRunAttemptId } from "@sayhear/domain";
import { PostgresEpisodeRepository, PostgresReflectionRepository, runMigrations } from "@sayhear/data";
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

  /**
   * Appends a second user ConversationEvent (a later turn) to an existing
   * quiescent session and attaches its Evidence item to the same immutable
   * snapshot. This lets one frozen build input carry two Evidence items whose
   * source revisions differ, so two proposals can cite genuinely different
   * Evidence sets within a single batch.
   */
  async function seedSecondSessionEvidence(input: {
    dailySessionId: ReturnType<typeof asDailySessionId>;
    sourceRevision: number;
    sequenceNo: number;
    canonicalText: string;
  }): Promise<{
    evidenceItemId: ReturnType<typeof asEvidenceItemId>;
    revisionId: string;
    conversationEventId: string;
  }> {
    const interactionTurnId = seedId();
    const conversationEventId = seedId();
    const revisionId = seedId();
    const evidenceItemId = seedId();
    const now = new Date(BASE_TIME);
    await database!.pool.query(
      `INSERT INTO interaction_turns (
         interaction_turn_id, user_id, daily_session_id, client_turn_id,
         turn_sequence_no, continuous_exchange_no, status, started_at,
         settled_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 1, 'settled', $6, $6, $6, $6)`,
      [
        interactionTurnId,
        OWNER,
        input.dailySessionId,
        `turn:${interactionTurnId}`,
        input.sequenceNo,
        now,
      ],
    );
    await database!.pool.query(
      `INSERT INTO conversation_events (
         conversation_event_id, user_id, daily_session_id, interaction_turn_id,
         sequence_no, client_event_id, actor, channel, event_type,
         lifecycle_status, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'user', 'text', 'message',
         'active', $7)`,
      [
        conversationEventId,
        OWNER,
        input.dailySessionId,
        interactionTurnId,
        input.sequenceNo,
        `event:${conversationEventId}`,
        now,
      ],
    );
    await database!.pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, canonical_text, locale, transcript_status, created_by, created_at
       ) VALUES ($1, $2, $3, 1, $4, 'en-US', 'final', 'client', $5)`,
      [revisionId, OWNER, conversationEventId, input.canonicalText, now],
    );
    await database!.pool.query(
      "UPDATE conversation_events SET current_revision_id = $2 WHERE conversation_event_id = $1",
      [conversationEventId, revisionId],
    );
    await database!.pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
         source_revision_id, source_actor, source_status, locator_type,
         locator_key, extraction_policy_version, evidence_role, created_at
       ) VALUES (
         $1, $2,
         (SELECT evidence_source_snapshot_id FROM evidence_source_snapshots
          WHERE daily_session_id = $3 AND source_revision = $4
          ORDER BY created_at DESC, evidence_source_snapshot_id LIMIT 1),
         $5, $6, 'user', 'final', 'whole_revision', '1:0',
         'evidence-extraction:v2', 'factual_support', $7)`,
      [
        evidenceItemId,
        OWNER,
        input.dailySessionId,
        input.sourceRevision,
        conversationEventId,
        revisionId,
        now,
      ],
    );
    return {
      evidenceItemId: asEvidenceItemId(evidenceItemId),
      revisionId,
      conversationEventId,
    };
  }

  /** Marks a seeded session journal-published so Reflection readiness passes. */
  async function seedJournalReadiness(dailySessionId: string): Promise<void> {
    await database!.pool.query(
      `INSERT INTO daily_session_date_outcomes (
         daily_session_id, user_id, logical_date, outcome,
         eligibility_policy_version, source_revision, workflow_receipt_id,
         computed_at
       ) VALUES (
         $1, $2,
         (SELECT logical_date FROM daily_sessions WHERE daily_session_id = $1),
         'journal_available', 'journal-eligibility:v1', 1, 'seed', $3)`,
      [dailySessionId, OWNER, new Date(BASE_TIME)],
    );
    await database!.pool.query(
      `INSERT INTO journal_workflow_outcomes (
         workflow_command_id, user_id, daily_session_id, source_revision,
         expected_data_epoch, outcome, reason, created_at
       ) VALUES ($1, $2, $3, 1, 1, 'published', NULL, $4)`,
      [seedId(), OWNER, dailySessionId, new Date(BASE_TIME)],
    );
  }

  /** Seeds an owner Entity with a current version so it is anchor-resolvable. */
  async function seedResolvableEntity(): Promise<string> {
    const entityId = seedId();
    const entityVersionId = seedId();
    await database!.pool.query(
      "INSERT INTO entities (entity_id, user_id, created_at) VALUES ($1, $2, $3)",
      [entityId, OWNER, new Date(BASE_TIME)],
    );
    await database!.pool.query(
      `INSERT INTO entity_versions (
         entity_version_id, entity_id, user_id, revision, entity_kind_id,
         status, created_at
       ) VALUES ($1, $2, $3, 1, 'person', 'active', $4)`,
      [entityVersionId, entityId, OWNER, new Date(BASE_TIME)],
    );
    await database!.pool.query(
      "UPDATE entities SET current_version_id = $2 WHERE entity_id = $1 AND user_id = $3",
      [entityId, entityVersionId, OWNER],
    );
    return entityId;
  }

  /** Resolves the Episode that owns a version linked to one Evidence item. */
  async function episodeIdForEvidence(evidenceItemId: string): Promise<string | null> {
    const result = await database!.pool.query<{ episode_id: string }>(
      `SELECT DISTINCT v.episode_id
       FROM episode_versions v
       INNER JOIN episode_evidence_links l
         ON l.episode_version_id = v.episode_version_id
       WHERE l.evidence_item_id = $1`,
      [evidenceItemId],
    );
    return result.rows[0]?.episode_id ?? null;
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
    // Idempotent replay must not duplicate links: only the accepted create
    // candidate cites Evidence; the rejected proposal cites nothing.
    expect((await database!.pool.query("SELECT count(*)::int AS count FROM episode_candidate_evidence_links")).rows[0].count).toBe(1);
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

    // Each immutable version owns exactly its admitted Evidence link. The
    // predecessor's revision was corrected, so it is no longer valid and the
    // successor carries only its newly admitted citation (never a stale copy).
    const versionLinks = await database!.pool.query(
      `SELECT v.revision, l.evidence_item_id
       FROM episode_evidence_links l
       INNER JOIN episode_versions v ON v.episode_version_id = l.episode_version_id
       ORDER BY v.revision, l.evidence_item_id`,
    );
    expect(versionLinks.rows).toEqual([
      { revision: 1, evidence_item_id: session.evidenceItemId },
      { revision: 2, evidence_item_id: continued.evidenceItemId },
    ]);
    const candidateLinkCounts = await database!.pool.query(
      `SELECT c.status, count(l.episode_candidate_evidence_link_id)::int AS links
       FROM episode_candidates c
       LEFT JOIN episode_candidate_evidence_links l
         ON l.episode_candidate_id = c.episode_candidate_id
       GROUP BY c.episode_candidate_id, c.status ORDER BY c.status, c.source_revision`,
    );
    expect(candidateLinkCounts.rows).toEqual([
      { status: "accepted", links: 1 },
      { status: "accepted", links: 1 },
      { status: "rejected", links: 0 },
    ]);

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

  it("persists owner Entity anchors on both the candidate and the created version", async () => {
    const session = await seedSession({ logicalDate: "2026-09-12" });
    const entityId = await seedResolvableEntity();
    const { generationCommandId, modelRunAttemptId } = await seedRunningGeneration({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });
    const repository = new PostgresEpisodeRepository(database!.pool);
    expect(await repository.commitEpisodeAdmission({
      userId: OWNER,
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
      expectedDataEpoch: 1,
      generationCommandId,
      modelRunAttemptId,
      policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
      dedupeFingerprintSecret: "synthetic-episode-secret",
      proposals: [{
        proposedKind: "sh.episode.trip",
        label: "Entity anchored trip",
        temporalAnchor: { start: { date: "2026-09-12", precision: "exact" } },
        phase: "planned",
        kindFields: { destination: "Kyoto" },
        citedEvidenceItemIds: [session.evidenceItemId],
        entityAnchorIds: [entityId],
        realWorldOccurrence: true,
        explicitNewOccurrence: true,
      }],
    })).toMatchObject({ outcome: "committed", acceptedCount: 1 });

    const episodeId = await episodeIdForEvidence(session.evidenceItemId);
    expect(episodeId).not.toBeNull();
    expect((await database!.pool.query(
      `SELECT l.entity_id
       FROM episode_version_entity_links l
       INNER JOIN episode_versions v ON v.episode_version_id = l.episode_version_id
       WHERE v.episode_id = $1`,
      [episodeId],
    )).rows).toEqual([{ entity_id: entityId }]);
    expect((await database!.pool.query(
      `SELECT l.entity_id
       FROM episode_candidate_entity_links l
       INNER JOIN episode_candidates c ON c.episode_candidate_id = l.episode_candidate_id
       WHERE c.daily_session_id = $1`,
      [session.dailySessionId],
    )).rows).toEqual([{ entity_id: entityId }]);
  });

  it("never links unknown or cross-owner refs while still linking a rejected candidate's valid citations", async () => {
    const session = await seedSession({ logicalDate: "2026-09-13" });
    const foreignOwner = seedId();
    await database!.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [foreignOwner, new Date(BASE_TIME)],
    );
    const foreignEntityId = seedId();
    await database!.pool.query(
      "INSERT INTO entities (entity_id, user_id, created_at) VALUES ($1, $2, $3)",
      [foreignEntityId, foreignOwner, new Date(BASE_TIME)],
    );
    const unknownEvidenceId = seedId();
    const { generationCommandId, modelRunAttemptId } = await seedRunningGeneration({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });
    const repository = new PostgresEpisodeRepository(database!.pool);
    const committed = await repository.commitEpisodeAdmission({
      userId: OWNER,
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
      expectedDataEpoch: 1,
      generationCommandId,
      modelRunAttemptId,
      policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
      dedupeFingerprintSecret: "synthetic-episode-secret",
      proposals: [
        {
          proposedKind: "sh.episode.trip",
          label: "Unknown evidence",
          temporalAnchor: { start: { date: "2026-09-13", precision: "exact" } },
          phase: "planned",
          kindFields: { destination: "Osaka" },
          citedEvidenceItemIds: [asEvidenceItemId(unknownEvidenceId)],
          realWorldOccurrence: true,
        },
        {
          proposedKind: "sh.episode.trip",
          label: "Cross-owner entity",
          temporalAnchor: { start: { date: "2026-09-13", precision: "exact" } },
          phase: "planned",
          kindFields: { destination: "Nara" },
          citedEvidenceItemIds: [session.evidenceItemId],
          entityAnchorIds: [foreignEntityId],
          realWorldOccurrence: true,
          explicitNewOccurrence: true,
        },
      ],
    });
    expect(committed).toMatchObject({
      outcome: "committed",
      acceptedCount: 0,
      rejectedCount: 2,
    });
    // The valid owner citation on the second rejected candidate is linked; the
    // unknown Evidence and the cross-owner Entity are never linked.
    expect((await database!.pool.query(
      `SELECT l.evidence_item_id
       FROM episode_candidate_evidence_links l
       INNER JOIN episode_candidates c ON c.episode_candidate_id = l.episode_candidate_id
       WHERE c.daily_session_id = $1`,
      [session.dailySessionId],
    )).rows).toEqual([{ evidence_item_id: session.evidenceItemId }]);
    expect((await database!.pool.query(
      `SELECT count(*)::int AS count
       FROM episode_candidate_entity_links l
       INNER JOIN episode_candidates c ON c.episode_candidate_id = l.episode_candidate_id
       WHERE c.daily_session_id = $1`,
      [session.dailySessionId],
    )).rows[0].count).toBe(0);
    // No Episode/version may be created for a build that accepted nothing.
    expect(await episodeIdForEvidence(session.evidenceItemId)).toBeNull();
  });

  it("carries still-valid predecessor Evidence and Entity links into the successor version", async () => {
    const first = await seedSession({ logicalDate: "2026-09-20" });
    const entityId = await seedResolvableEntity();
    const firstGeneration = await seedRunningGeneration({
      dailySessionId: first.dailySessionId,
      sourceRevision: 1,
    });
    const repository = new PostgresEpisodeRepository(database!.pool);
    // A distinct kind keeps admission's same-kind uniqueness test scoped to
    // this Episode even though the shared test schema accumulates other trips.
    const createProposal: EpisodeProposal = {
      proposedKind: "sh.episode.project_phase",
      label: "Radio restoration",
      temporalAnchor: { start: { date: "2026-09-20", precision: "exact" } },
      phase: "planned",
      kindFields: { project: "Radio restoration" },
      citedEvidenceItemIds: [first.evidenceItemId],
      entityAnchorIds: [entityId],
      realWorldOccurrence: true,
      explicitNewOccurrence: true,
    };
    expect(await repository.commitEpisodeAdmission({
      userId: OWNER,
      dailySessionId: first.dailySessionId,
      sourceRevision: 1,
      expectedDataEpoch: 1,
      generationCommandId: firstGeneration.generationCommandId,
      modelRunAttemptId: firstGeneration.modelRunAttemptId,
      policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
      dedupeFingerprintSecret: "synthetic-episode-secret",
      proposals: [createProposal],
    })).toMatchObject({ outcome: "committed", acceptedCount: 1 });

    // A later day's session continues the Episode with new Evidence. The first
    // Evidence stays valid, so it must be carried forward; the Entity anchor is
    // carried even though the continuation proposal omits it.
    const second = await seedSession({ logicalDate: "2026-09-21" });
    const secondGeneration = await seedRunningGeneration({
      dailySessionId: second.dailySessionId,
      sourceRevision: 1,
    });
    const continuationInput = {
      userId: OWNER,
      dailySessionId: second.dailySessionId,
      sourceRevision: 1,
      expectedDataEpoch: 1,
      generationCommandId: secondGeneration.generationCommandId,
      modelRunAttemptId: secondGeneration.modelRunAttemptId,
      policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
      dedupeFingerprintSecret: "synthetic-episode-secret",
      proposals: [{
        ...createProposal,
        phase: "ongoing" as const,
        temporalAnchor: { start: { date: "2026-09-21", precision: "exact" as const } },
        citedEvidenceItemIds: [second.evidenceItemId],
        entityAnchorIds: [],
        explicitNewOccurrence: false,
      }],
    };
    expect(await repository.commitEpisodeAdmission(continuationInput)).toMatchObject({
      outcome: "committed",
      acceptedCount: 1,
    });

    const episodeId = await episodeIdForEvidence(first.evidenceItemId);
    expect(episodeId).not.toBeNull();
    const versions = await database!.pool.query(
      "SELECT episode_version_id, revision FROM episode_versions WHERE episode_id = $1 ORDER BY revision",
      [episodeId],
    );
    expect(versions.rows).toHaveLength(2);
    const successorVersionId = versions.rows[1]!.episode_version_id;
    const successorEvidence = await database!.pool.query(
      `SELECT evidence_item_id FROM episode_evidence_links
       WHERE episode_version_id = $1 ORDER BY evidence_item_id`,
      [successorVersionId],
    );
    expect(new Set(successorEvidence.rows.map((row) => row.evidence_item_id)))
      .toEqual(new Set([first.evidenceItemId, second.evidenceItemId]));
    expect((await database!.pool.query(
      "SELECT entity_id FROM episode_version_entity_links WHERE episode_version_id = $1",
      [successorVersionId],
    )).rows).toEqual([{ entity_id: entityId }]);

    // Replaying the continuation is idempotent and adds no duplicate links.
    expect(await repository.commitEpisodeAdmission(continuationInput)).toMatchObject({
      outcome: "already_built",
    });
    expect((await database!.pool.query(
      `SELECT count(*)::int AS count
       FROM episode_evidence_links l
       INNER JOIN episode_versions v ON v.episode_version_id = l.episode_version_id
       WHERE v.episode_id = $1`,
      [episodeId],
    )).rows[0].count).toBe(3);
  });

  it("chains two same-batch continuations of one Episode without a revision conflict", async () => {
    const first = await seedSession({ logicalDate: "2026-09-22" });
    const entityId = await seedResolvableEntity();
    const firstGeneration = await seedRunningGeneration({
      dailySessionId: first.dailySessionId,
      sourceRevision: 1,
    });
    const repository = new PostgresEpisodeRepository(database!.pool);
    // A distinct kind keeps admission's same-kind uniqueness test scoped to
    // this Episode even though the shared test schema accumulates other
    // episodes from earlier tests.
    const createProposal: EpisodeProposal = {
      proposedKind: "sh.episode.project_phase",
      label: "Radio restoration",
      temporalAnchor: { start: { date: "2026-09-22", precision: "exact" } },
      phase: "planned",
      kindFields: { project: "Radio restoration" },
      citedEvidenceItemIds: [first.evidenceItemId],
      entityAnchorIds: [entityId],
      realWorldOccurrence: true,
      explicitNewOccurrence: true,
    };
    expect(await repository.commitEpisodeAdmission({
      userId: OWNER,
      dailySessionId: first.dailySessionId,
      sourceRevision: 1,
      expectedDataEpoch: 1,
      generationCommandId: firstGeneration.generationCommandId,
      modelRunAttemptId: firstGeneration.modelRunAttemptId,
      policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
      dedupeFingerprintSecret: "synthetic-episode-secret",
      proposals: [createProposal],
    })).toMatchObject({ outcome: "committed", acceptedCount: 1 });

    const episodeId = await episodeIdForEvidence(first.evidenceItemId);
    expect(episodeId).not.toBeNull();
    const revisionOne = (await database!.pool.query<{ episode_version_id: string; revision: number }>(
      "SELECT episode_version_id, revision FROM episode_versions WHERE episode_id = $1 ORDER BY revision",
      [episodeId],
    )).rows[0]!;
    expect(revisionOne.revision).toBe(1);

    // The batch session freezes two distinct Evidence items (each with its
    // own revision id), so the two continuation proposals cite genuinely
    // different Evidence sets and therefore carry different dedupe
    // fingerprints.
    const second = await seedSession({ logicalDate: "2026-09-23" });
    const secondEvidence = await seedSecondSessionEvidence({
      dailySessionId: second.dailySessionId,
      sourceRevision: 1,
      sequenceNo: 2,
      canonicalText: "I am still restoring the radio and just replaced the dial.",
    });
    const secondGeneration = await seedRunningGeneration({
      dailySessionId: second.dailySessionId,
      sourceRevision: 1,
    });
    const continuationBase: EpisodeProposal = {
      proposedKind: "sh.episode.project_phase",
      label: "Radio restoration",
      temporalAnchor: { start: { date: "2026-09-23", precision: "exact" } },
      phase: "ongoing",
      kindFields: { project: "Radio restoration" },
      entityAnchorIds: [entityId],
      realWorldOccurrence: true,
      explicitNewOccurrence: false,
      citedEvidenceItemIds: [second.evidenceItemId],
    };
    const secondContinuation: EpisodeProposal = {
      ...continuationBase,
      citedEvidenceItemIds: [secondEvidence.evidenceItemId],
    };

    // Two proposals in ONE batch both deterministically plan
    // continue_episode for E. The second must chain onto the first's
    // successor instead of colliding on (episode_id, revision).
    expect(await repository.commitEpisodeAdmission({
      userId: OWNER,
      dailySessionId: second.dailySessionId,
      sourceRevision: 1,
      expectedDataEpoch: 1,
      generationCommandId: secondGeneration.generationCommandId,
      modelRunAttemptId: secondGeneration.modelRunAttemptId,
      policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
      dedupeFingerprintSecret: "synthetic-episode-secret",
      proposals: [continuationBase, secondContinuation],
    })).toMatchObject({ outcome: "committed", acceptedCount: 2 });

    const versions = await database!.pool.query<{
      episode_version_id: string;
      revision: number;
      status: string;
      supersedes_version_id: string | null;
    }>(
      `SELECT episode_version_id, revision, status, supersedes_version_id
       FROM episode_versions WHERE episode_id = $1 ORDER BY revision`,
      [episodeId],
    );
    expect(versions.rows).toHaveLength(3);
    expect(versions.rows[0]).toMatchObject({
      revision: 1,
      status: "superseded",
      supersedes_version_id: null,
    });
    expect(versions.rows[1]).toMatchObject({
      revision: 2,
      status: "superseded",
      supersedes_version_id: versions.rows[0]!.episode_version_id,
    });
    expect(versions.rows[2]).toMatchObject({
      revision: 3,
      status: "current",
      supersedes_version_id: versions.rows[1]!.episode_version_id,
    });
    const revisionThreeId = versions.rows[2]!.episode_version_id;
    expect((await database!.pool.query<{ current_version_id: string }>(
      "SELECT current_version_id FROM episodes WHERE episode_id = $1",
      [episodeId],
    )).rows[0]!.current_version_id).toBe(revisionThreeId);

    const accepted = await database!.pool.query<{ proposed_existing_episode_id: string | null }>(
      `SELECT proposed_existing_episode_id FROM episode_candidates
       WHERE daily_session_id = $1 AND status = 'accepted'`,
      [second.dailySessionId],
    );
    expect(accepted.rows).toHaveLength(2);
    expect(accepted.rows.every((row) => row.proposed_existing_episode_id === episodeId)).toBe(true);

    // Revision 3's links are revision 1's links unioned with both proposals'
    // citations, deduped within the frozen owner refs.
    const revisionThreeEvidence = await database!.pool.query<{ evidence_item_id: string }>(
      `SELECT evidence_item_id FROM episode_evidence_links
       WHERE episode_version_id = $1 ORDER BY evidence_item_id`,
      [revisionThreeId],
    );
    expect(new Set(revisionThreeEvidence.rows.map((row) => row.evidence_item_id)))
      .toEqual(new Set([
        first.evidenceItemId,
        second.evidenceItemId,
        secondEvidence.evidenceItemId,
      ]));
    expect(new Set((await database!.pool.query<{ evidence_item_id: string }>(
      `SELECT evidence_item_id FROM episode_evidence_links
       WHERE episode_version_id = $1`,
      [versions.rows[1]!.episode_version_id],
    )).rows.map((row) => row.evidence_item_id)))
      .toEqual(new Set([first.evidenceItemId, second.evidenceItemId]));
    expect((await database!.pool.query(
      "SELECT entity_id FROM episode_version_entity_links WHERE episode_version_id = $1",
      [revisionThreeId],
    )).rows).toEqual([{ entity_id: entityId }]);

    // The batch run row records the real counters for both continuations.
    expect((await database!.pool.query<{
      candidate_count: number;
      accepted_count: number;
    }>(
      `SELECT candidate_count, accepted_count FROM episode_build_runs
       WHERE daily_session_id = $1`,
      [second.dailySessionId],
    )).rows[0]).toMatchObject({ candidate_count: 2, accepted_count: 2 });

    // Each successor stores its own content: the create is planned, both
    // continuations are ongoing.
    expect((await database!.pool.query<{ phase: string; temporal_date: string }>(
      `SELECT content ->> 'phase' AS phase,
              content #>> '{temporalAnchor,start,date}' AS temporal_date
       FROM episode_versions WHERE episode_id = $1 ORDER BY revision`,
      [episodeId],
    )).rows).toEqual([
      { phase: "planned", temporal_date: "2026-09-22" },
      { phase: "ongoing", temporal_date: "2026-09-23" },
      { phase: "ongoing", temporal_date: "2026-09-23" },
    ]);
  });

  it("chains three same-batch continuations onto strictly increasing revisions", async () => {
    const first = await seedSession({ logicalDate: "2026-09-24" });
    const entityId = await seedResolvableEntity();
    const firstGeneration = await seedRunningGeneration({
      dailySessionId: first.dailySessionId,
      sourceRevision: 1,
    });
    const repository = new PostgresEpisodeRepository(database!.pool);
    const createProposal: EpisodeProposal = {
      proposedKind: "sh.episode.project_phase",
      label: "Kiln restoration",
      temporalAnchor: { start: { date: "2026-09-24", precision: "exact" } },
      phase: "planned",
      kindFields: { project: "Kiln restoration" },
      citedEvidenceItemIds: [first.evidenceItemId],
      entityAnchorIds: [entityId],
      realWorldOccurrence: true,
      explicitNewOccurrence: true,
    };
    expect(await repository.commitEpisodeAdmission({
      userId: OWNER,
      dailySessionId: first.dailySessionId,
      sourceRevision: 1,
      expectedDataEpoch: 1,
      generationCommandId: firstGeneration.generationCommandId,
      modelRunAttemptId: firstGeneration.modelRunAttemptId,
      policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
      dedupeFingerprintSecret: "synthetic-episode-secret",
      proposals: [createProposal],
    })).toMatchObject({ outcome: "committed", acceptedCount: 1 });

    const episodeId = await episodeIdForEvidence(first.evidenceItemId);
    expect(episodeId).not.toBeNull();

    // One later batch carries three continuations of the same Episode, each
    // citing a different Evidence item so every proposal has its own dedupe
    // fingerprint. The second and third must chain onto the in-batch
    // successor: revisions 2 → 3 → 4 with no unique-constraint collision.
    const second = await seedSession({ logicalDate: "2026-09-25" });
    const evidenceA = await seedSecondSessionEvidence({
      dailySessionId: second.dailySessionId,
      sourceRevision: 1,
      sequenceNo: 2,
      canonicalText: "The kiln brickwork is going back in today.",
    });
    const evidenceB = await seedSecondSessionEvidence({
      dailySessionId: second.dailySessionId,
      sourceRevision: 1,
      sequenceNo: 3,
      canonicalText: "We fired the kiln for a first test batch.",
    });
    const evidenceC = await seedSecondSessionEvidence({
      dailySessionId: second.dailySessionId,
      sourceRevision: 1,
      sequenceNo: 4,
      canonicalText: "The kiln door latch needed one more adjustment.",
    });
    const secondGeneration = await seedRunningGeneration({
      dailySessionId: second.dailySessionId,
      sourceRevision: 1,
    });
    const continuationBase: EpisodeProposal = {
      proposedKind: "sh.episode.project_phase",
      label: "Kiln restoration",
      temporalAnchor: { start: { date: "2026-09-25", precision: "exact" } },
      phase: "ongoing",
      kindFields: { project: "Kiln restoration" },
      entityAnchorIds: [entityId],
      realWorldOccurrence: true,
      explicitNewOccurrence: false,
      citedEvidenceItemIds: [evidenceA.evidenceItemId],
    };
    expect(await repository.commitEpisodeAdmission({
      userId: OWNER,
      dailySessionId: second.dailySessionId,
      sourceRevision: 1,
      expectedDataEpoch: 1,
      generationCommandId: secondGeneration.generationCommandId,
      modelRunAttemptId: secondGeneration.modelRunAttemptId,
      policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
      dedupeFingerprintSecret: "synthetic-episode-secret",
      proposals: [
        continuationBase,
        { ...continuationBase, citedEvidenceItemIds: [evidenceB.evidenceItemId] },
        { ...continuationBase, citedEvidenceItemIds: [evidenceC.evidenceItemId] },
      ],
    })).toMatchObject({ outcome: "committed", acceptedCount: 3 });

    const versions = await database!.pool.query<{
      episode_version_id: string;
      revision: number;
      status: string;
      supersedes_version_id: string | null;
    }>(
      `SELECT episode_version_id, revision, status, supersedes_version_id
       FROM episode_versions WHERE episode_id = $1 ORDER BY revision`,
      [episodeId],
    );
    expect(versions.rows).toHaveLength(4);
    expect(versions.rows.map((row) => row.revision)).toEqual([1, 2, 3, 4]);
    expect(versions.rows.map((row) => row.status)).toEqual([
      "superseded",
      "superseded",
      "superseded",
      "current",
    ]);
    expect(versions.rows.map((row) => row.supersedes_version_id)).toEqual([
      null,
      versions.rows[0]!.episode_version_id,
      versions.rows[1]!.episode_version_id,
      versions.rows[2]!.episode_version_id,
    ]);
    expect((await database!.pool.query<{ current_version_id: string }>(
      "SELECT current_version_id FROM episodes WHERE episode_id = $1",
      [episodeId],
    )).rows[0]!.current_version_id).toBe(versions.rows[3]!.episode_version_id);

    // Links grow monotonically along the chain: revision 2 gets the create
    // Evidence plus A, revision 3 adds B, revision 4 adds C.
    async function evidenceIdsFor(episodeVersionId: string): Promise<Set<string>> {
      const rows = await database!.pool.query<{ evidence_item_id: string }>(
        `SELECT evidence_item_id FROM episode_evidence_links
         WHERE episode_version_id = $1`,
        [episodeVersionId],
      );
      return new Set(rows.rows.map((row) => row.evidence_item_id));
    }
    expect(await evidenceIdsFor(versions.rows[1]!.episode_version_id))
      .toEqual(new Set([first.evidenceItemId, evidenceA.evidenceItemId]));
    expect(await evidenceIdsFor(versions.rows[2]!.episode_version_id))
      .toEqual(new Set([
        first.evidenceItemId,
        evidenceA.evidenceItemId,
        evidenceB.evidenceItemId,
      ]));
    expect(await evidenceIdsFor(versions.rows[3]!.episode_version_id))
      .toEqual(new Set([
        first.evidenceItemId,
        evidenceA.evidenceItemId,
        evidenceB.evidenceItemId,
        evidenceC.evidenceItemId,
      ]));
    expect((await database!.pool.query(
      "SELECT entity_id FROM episode_version_entity_links WHERE episode_version_id = $1",
      [versions.rows[3]!.episode_version_id],
    )).rows).toEqual([{ entity_id: entityId }]);

    const accepted = await database!.pool.query<{ proposed_existing_episode_id: string | null }>(
      `SELECT proposed_existing_episode_id FROM episode_candidates
       WHERE daily_session_id = $1 AND status = 'accepted'`,
      [second.dailySessionId],
    );
    expect(accepted.rows).toHaveLength(3);
    expect(accepted.rows.every((row) => row.proposed_existing_episode_id === episodeId)).toBe(true);

    expect((await database!.pool.query<{
      candidate_count: number;
      accepted_count: number;
    }>(
      `SELECT candidate_count, accepted_count FROM episode_build_runs
       WHERE daily_session_id = $1`,
      [second.dailySessionId],
    )).rows[0]).toMatchObject({ candidate_count: 3, accepted_count: 3 });
  });

  it("lets Reflection read the newly built Episode through the real repository", async () => {
    const session = await seedSession({ logicalDate: "2026-09-14" });
    await seedJournalReadiness(session.dailySessionId);
    const { generationCommandId, modelRunAttemptId } = await seedRunningGeneration({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });
    const repository = new PostgresEpisodeRepository(database!.pool);
    expect(await repository.commitEpisodeAdmission({
      userId: OWNER,
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
      expectedDataEpoch: 1,
      generationCommandId,
      modelRunAttemptId,
      policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
      dedupeFingerprintSecret: "synthetic-episode-secret",
      proposals: [{
        proposedKind: "sh.episode.trip",
        label: "Reflection visible trip",
        temporalAnchor: { start: { date: "2026-09-14", precision: "exact" } },
        phase: "planned",
        kindFields: { destination: "Sapporo" },
        citedEvidenceItemIds: [session.evidenceItemId],
        realWorldOccurrence: true,
        explicitNewOccurrence: true,
      }],
    })).toMatchObject({ outcome: "committed", acceptedCount: 1 });
    const episodeId = await episodeIdForEvidence(session.evidenceItemId);
    expect(episodeId).not.toBeNull();
    // Backdate the built run so the 30-minute Episode interval has elapsed;
    // Reflection must read the freshly persisted links, not a manual seed.
    await database!.pool.query(
      "UPDATE episode_build_runs SET created_at = $1, updated_at = $1 WHERE daily_session_id = $2",
      [new Date(BASE_TIME), session.dailySessionId],
    );

    const reflection = new PostgresReflectionRepository(database!.pool, {
      entryFor: () => null,
      registryVersion: () => 1,
    });
    const digest = await reflection.readDailyBaselineDigest({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });
    expect(digest).not.toBeNull();
    const snapshot = await reflection.readDailySnapshot({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
      claimBaselineDigest: digest!,
      policyVersion: "reflection-readiness:v1",
    });
    expect(snapshot.outcome).toBe("evaluated");
    if (snapshot.outcome !== "evaluated") {
      throw new Error(`unexpected reflection snapshot outcome: ${snapshot.outcome}`);
    }
    expect(snapshot.frozen.episodes.map((item) => item.episodeId))
      .toEqual([episodeId]);
  });

  // Runs last: it revokes the shared v1 pin and binds v2, so any test that
  // needs the original pin must be declared before it.
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
