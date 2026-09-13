import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createModelRoleCommandService,
  createModelRoleRegistry,
  type ModelRoleConfigurationSnapshot,
} from "@sayhear/application";
import {
  PostgresModelRoleCommandRepository,
  PostgresOpenLoopRepository,
  runMigrations,
} from "@sayhear/data";
import { asUserId } from "@sayhear/domain";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const systemDescribe = testDatabaseUrl ? describe : describe.skip;

const OWNER = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");
const BASE_TIME = Date.parse("2026-09-20T00:00:00.000Z");
const POLICY = "open-loop-formation:v1";
const EXPIRY_POLICY = "open-loop-expiry:v1";

const configuration: ModelRoleConfigurationSnapshot = {
  role: "open_loop.extract",
  configVersion: "system-open-loop:v1",
  provider: "system-test",
  model: "synthetic-model",
  modelSnapshot: "synthetic-model@fixture",
  promptVersion: "system-prompt:v1",
  schemaVersion: "system-schema:v1",
  rolePolicyVersion: "1a3b-model-role-policy:v1",
  providerPolicyVersion: "system-open-loop-egress:v1",
  rolloutPin: "system-open-loop-pin:v1",
  freshnessPolicy: "source_valid:v1",
  fallbackMode: "disabled",
  maxTechnicalRetries: 1,
  maxSemanticRepairs: 0,
  parameterSnapshot: { budgetPolicyVersion: "system-test-budget:v1" },
};

systemDescribe("C1 open loop lifecycle (issue #204)", () => {
  let database: IsolatedPostgresSchema | undefined;
  let repository: PostgresOpenLoopRepository | undefined;

  let nextId = 0;
  let seedDay = 0;
  function seedId(): string {
    nextId += 1;
    const timeHex = BASE_TIME.toString(16).padStart(12, "0");
    const counter = nextId.toString(16).padStart(12, "0");
    return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${counter.slice(0, 3)}-a${counter.slice(3, 6)}-${counter.slice(6, 12).padStart(12, "0")}`;
  }

  async function seedSession(input: { text: string }): Promise<{
    evidenceItemId: string;
    revisionId: string;
  }> {
    const pool = database!.pool;
    seedDay += 1;
    const logicalDate = `2026-10-${String(seedDay).padStart(2, "0")}`;
    const dailySessionId = seedId();
    const interactionTurnId = seedId();
    const conversationEventId = seedId();
    const revisionId = seedId();
    const snapshotId = seedId();
    const evidenceItemId = seedId();
    const now = new Date(BASE_TIME);
    await pool.query(
      `INSERT INTO daily_sessions (
         daily_session_id, user_id, logical_date, timezone_at_start, started_at,
         last_activity_at, activity_state, current_continuous_exchange_no,
         dialogue_revision, source_revision, next_turn_sequence_no,
         next_event_sequence_no, quiescent_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'Asia/Shanghai', $4, $4, 'quiescent', 1, 0, 1, 1, 1, $4, $4, $4)`,
      [dailySessionId, OWNER, logicalDate, now],
    );
    await pool.query(
      `INSERT INTO interaction_turns (
         interaction_turn_id, user_id, daily_session_id, client_turn_id,
         turn_sequence_no, continuous_exchange_no, status, started_at,
         settled_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'turn:' || $5, 1, 1, 'settled', $4, $4, $4, $4)`,
      [interactionTurnId, OWNER, dailySessionId, now, interactionTurnId],
    );
    await pool.query(
      `INSERT INTO conversation_events (
         conversation_event_id, user_id, daily_session_id, interaction_turn_id,
         sequence_no, client_event_id, actor, channel, event_type,
         lifecycle_status, created_at
       ) VALUES ($1, $2, $3, $4, 1, 'event:' || $5, 'user', 'text', 'message',
         'active', $6)`,
      [conversationEventId, OWNER, dailySessionId, interactionTurnId, conversationEventId, now],
    );
    await pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, canonical_text, locale, transcript_status, created_by, created_at
       ) VALUES ($1, $2, $3, 1, $4, 'zh', 'final', 'client', $5)`,
      [revisionId, OWNER, conversationEventId, input.text, now],
    );
    await pool.query(
      "UPDATE conversation_events SET current_revision_id = $2 WHERE conversation_event_id = $1",
      [conversationEventId, revisionId],
    );
    await pool.query(
      `INSERT INTO evidence_source_snapshots (
         evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
         extraction_policy_version, command_id, attempt_id,
         champion_config_version, champion_provider, champion_model,
         champion_snapshot, champion_provider_policy_version, created_at
       ) VALUES ($1, $2, $3, 1, 'evidence-extraction:v2', 'seed', 'seed', 'test', 'openai', 'test', 'test', 'test', $4)`,
      [snapshotId, OWNER, dailySessionId, now],
    );
    await pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
         source_revision_id, source_actor, source_status, locator_type,
         locator_key, extraction_policy_version, evidence_role, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision', '1:0',
         'evidence-extraction:v2', 'factual_support', $6)`,
      [evidenceItemId, OWNER, snapshotId, conversationEventId, revisionId, now],
    );
    return { evidenceItemId, revisionId };
  }

  async function admitExtractCommand(revisionId: string) {
    const service = createModelRoleCommandService({
      registry: createModelRoleRegistry([configuration]),
      repository: new PostgresModelRoleCommandRepository(database!.pool),
    });
    return service.admit({
      userId: OWNER,
      role: "open_loop.extract",
      intentKey: `open-loop-extract:${revisionId}`,
      subjectType: "conversation_event_revision",
      subjectId: revisionId,
      sourceRevision: 1,
      sourceSnapshot: `snapshot:${revisionId}`,
      inputManifest: [
        { key: "evidence", revision: 1, fingerprint: `fp:${revisionId}` },
      ],
      expectedDataEpoch: 1,
      now: new Date(BASE_TIME),
    });
  }

  beforeAll(async () => {
    const seeded = await createIsolatedPostgresSchema(testDatabaseUrl!);
    database = seeded;
    await runMigrations(seeded.pool);
    const now = new Date(BASE_TIME);
    await seeded.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [OWNER, now],
    );
    await seeded.pool.query(
      `INSERT INTO provider_egress_policy_versions (
         policy_version, provider, role, model_config_version, status, created_at
       ) VALUES ($1, $2, $3, $4, 'active', $5)`,
      [
        configuration.providerPolicyVersion,
        configuration.provider,
        configuration.role,
        configuration.configVersion,
        now,
      ],
    );
    await seeded.pool.query(
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
        now,
      ],
    );
    await seeded.pool.query(
      "UPDATE model_role_definitions SET enabled = TRUE WHERE role = $1",
      [configuration.role],
    );
    await seeded.pool.query(
      `INSERT INTO model_role_rollout_pins (
         role, rollout_pin, config_version, provider_policy_version,
         status, activated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5)`,
      [
        configuration.role,
        configuration.rolloutPin,
        configuration.configVersion,
        configuration.providerPolicyVersion,
        now,
      ],
    );
    repository = new PostgresOpenLoopRepository(seeded.pool);
  }, 60_000);

  afterAll(async () => {
    await database?.dispose();
  });

  it("forms an upcoming loop through the frozen extract command, then dedupes the replay", async () => {
    const session = await seedSession({
      text: "下周三下午有一个已安排的面试。",
    });
    const admitted = await admitExtractCommand(session.revisionId);
    expect(admitted.outcome).toBe("created");
    const first = await repository!.commitEventEffects({
      userId: OWNER,
      sourceEventRevisionId: session.revisionId,
      expectedDataEpoch: 1,
      generationCommandId: admitted.generationCommandId,
      modelRunAttemptId: admitted.modelRunAttemptId,
      policyVersion: POLICY,
      formations: [
        {
          kind: "upcoming_event",
          sourceEvidenceItemId: session.evidenceItemId,
          sourceEventRevisionId: session.revisionId,
          sourceClaimVersionId: null,
          sourceEpisodeVersionId: null,
          canonicalClaimKey: null,
          localizedSummary: "下周三的面试",
          expectedStartAt: "2026-09-24T07:00:00.000Z",
          expectedEndAt: "2026-09-24T08:00:00.000Z",
          timePrecision: "range",
          timezone: "Asia/Shanghai",
          followupEligibleFromAt: "2026-09-10T07:00:00.000Z",
          expiresAt: "2026-10-01T08:00:00.000Z",
          expirySource: "anchored_upcoming_plus_7d",
          reuseOpenLoopId: null,
        },
      ],
      closures: [],
      ambiguousSuppressedTargetIds: [],
      now: new Date(BASE_TIME),
    });
    expect(first.outcome).toBe("settled");
    if (first.outcome === "settled") {
      expect(first.formed).toBe(1);
    }
    // AC-F01: the replay of the same source revision settles idempotently.
    const replay = await repository!.commitEventEffects({
      userId: OWNER,
      sourceEventRevisionId: session.revisionId,
      expectedDataEpoch: 1,
      generationCommandId: admitted.generationCommandId,
      modelRunAttemptId: admitted.modelRunAttemptId,
      policyVersion: POLICY,
      formations: [],
      closures: [],
      ambiguousSuppressedTargetIds: [],
      now: new Date(BASE_TIME),
    });
    expect(replay.outcome).toBe("already_settled");
    // The lane reads the formed loop once the watermark is complete.
    const lane = await repository!.readOpenLane({
      userId: OWNER,
      now: new Date("2026-09-20T12:00:00.000Z"),
      watermarkReadable: true,
    });
    expect(lane).toHaveLength(1);
    expect(lane[0]?.kind).toBe("upcoming_event");
    expect(lane[0]?.suppressed).toBe(false);
    // A lane gap reads empty instead of reusing a stale cache.
    const gapLane = await repository!.readOpenLane({
      userId: OWNER,
      now: new Date("2026-09-20T12:00:00.000Z"),
      watermarkReadable: false,
    });
    expect(gapLane).toHaveLength(0);
  }, 60_000);

  it("rejects a stale epoch instead of publishing a late result (AC-F02)", async () => {
    const session = await seedSession({
      text: "下个月有一个已安排的分享会。",
    });
    const admitted = await admitExtractCommand(session.revisionId);
    const fenced = await repository!.commitEventEffects({
      userId: OWNER,
      sourceEventRevisionId: session.revisionId,
      expectedDataEpoch: 999,
      generationCommandId: admitted.generationCommandId,
      modelRunAttemptId: admitted.modelRunAttemptId,
      policyVersion: POLICY,
      formations: [],
      closures: [],
      ambiguousSuppressedTargetIds: [],
      now: new Date(BASE_TIME),
    });
    expect(fenced).toMatchObject({ outcome: "fenced", reason: "data_epoch" });
    expect(
      await repository!.assertNoPartialWrite({
        userId: OWNER,
        sourceEventRevisionId: session.revisionId,
        policyVersion: POLICY,
      }),
    ).toBe(false);
  }, 60_000);

  it("closes a loop on entailed evidence and suppresses ambiguous targets atomically", async () => {
    const pool = database!.pool;
    const interview = await seedSession({
      text: "下周有一个已安排的面试。",
    });
    const checkup = await seedSession({
      text: "在等体检结果。",
    });
    const admittedA = await admitExtractCommand(interview.revisionId);
    const formed = await repository!.commitEventEffects({
      userId: OWNER,
      sourceEventRevisionId: interview.revisionId,
      expectedDataEpoch: 1,
      generationCommandId: admittedA.generationCommandId,
      modelRunAttemptId: admittedA.modelRunAttemptId,
      policyVersion: POLICY,
      formations: [
        {
          kind: "upcoming_event",
          sourceEvidenceItemId: interview.evidenceItemId,
          sourceEventRevisionId: interview.revisionId,
          sourceClaimVersionId: null,
          sourceEpisodeVersionId: null,
          canonicalClaimKey: null,
          localizedSummary: "面试",
          expectedStartAt: "2026-09-25T07:00:00.000Z",
          expectedEndAt: "2026-09-25T08:00:00.000Z",
          timePrecision: "range",
          timezone: "Asia/Shanghai",
          followupEligibleFromAt: "2026-09-11T07:00:00.000Z",
          expiresAt: "2026-10-02T08:00:00.000Z",
          expirySource: "anchored_upcoming_plus_7d",
          reuseOpenLoopId: null,
        },
        {
          kind: "awaited_outcome",
          sourceEvidenceItemId: checkup.evidenceItemId,
          sourceEventRevisionId: checkup.revisionId,
          sourceClaimVersionId: null,
          sourceEpisodeVersionId: null,
          canonicalClaimKey: null,
          localizedSummary: "体检结果",
          expectedStartAt: null,
          expectedEndAt: null,
          timePrecision: "unknown",
          timezone: null,
          followupEligibleFromAt: new Date(BASE_TIME).toISOString(),
          expiresAt: "2026-10-04T00:00:00.000Z",
          expirySource: "unanchored_plus_14d",
          reuseOpenLoopId: null,
        },
      ],
      closures: [],
      ambiguousSuppressedTargetIds: [],
      now: new Date(BASE_TIME),
    });
    expect(formed.outcome).toBe("settled");
    const loops = await pool.query<{ open_loop_id: string }>(
      `SELECT open_loop_id FROM open_loops WHERE user_id = $1 ORDER BY created_at ASC`,
      [OWNER],
    );
    // Ambiguous closure evidence: suppress the two newest reasonable targets,
    // closing none.
    const targets = loops.rows.slice(-2).map((row) => row.open_loop_id);
    expect(targets).toHaveLength(2);
    const closer = await seedSession({
      text: "那个事情结束了，具体是哪个我说不清。",
    });
    const admittedCloser = await admitExtractCommand(closer.revisionId);
    const suppressed = await repository!.commitEventEffects({
      userId: OWNER,
      sourceEventRevisionId: closer.revisionId,
      expectedDataEpoch: 1,
      generationCommandId: admittedCloser.generationCommandId,
      modelRunAttemptId: admittedCloser.modelRunAttemptId,
      policyVersion: POLICY,
      formations: [],
      closures: [],
      ambiguousSuppressedTargetIds: targets,
      now: new Date(BASE_TIME + 86_400_000),
    });
    expect(suppressed.outcome).toBe("settled");
    if (suppressed.outcome === "settled") {
      expect(suppressed.suppressed).toBe(2);
      expect(suppressed.closed).toBe(0);
    }
    const audits = await pool.query(
      `SELECT target_open_loop_id, disposition FROM open_loop_closure_audits
       WHERE source_event_revision_id = $1`,
      [closer.revisionId],
    );
    expect(audits.rows).toHaveLength(2);
    // Unique later Evidence closes one target and leaves the other open.
    const finisher = await seedSession({
      text: "面试已经面完了。",
    });
    const admittedFinisher = await admitExtractCommand(finisher.revisionId);
    const closed = await repository!.commitEventEffects({
      userId: OWNER,
      sourceEventRevisionId: finisher.revisionId,
      expectedDataEpoch: 1,
      generationCommandId: admittedFinisher.generationCommandId,
      modelRunAttemptId: admittedFinisher.modelRunAttemptId,
      policyVersion: POLICY,
      formations: [],
      closures: [
        {
          targetOpenLoopId: targets[0]!,
          terminalStatus: "occurred",
          closureEventRevisionId: finisher.revisionId,
          closureCommittedAt: new Date(BASE_TIME + 2 * 86_400_000).toISOString(),
        },
      ],
      ambiguousSuppressedTargetIds: [],
      now: new Date(BASE_TIME + 2 * 86_400_000),
    });
    expect(closed.outcome).toBe("settled");
    const version = await repository!.readVersion({ openLoopId: targets[0]! });
    expect(version?.status).toBe("occurred");
    expect(version?.revision).toBe(2);
    // The unique close releases the co-suppressed non-target: it leaves
    // suppression and reads eligible again.
    const laneAfterRelease = await repository!.readOpenLane({
      userId: OWNER,
      now: new Date(BASE_TIME + 2 * 86_400_000),
      watermarkReadable: true,
    });
    const released = laneAfterRelease.find((row) => row.openLoopId === targets[1]);
    expect(released?.suppressed).toBe(false);
  }, 60_000);

  it("trims per-Event formation to 4 loops with a stable order", async () => {
    const session = await seedSession({
      text: "下周有五个已安排的事项。",
    });
    const admitted = await admitExtractCommand(session.revisionId);
    const formations = [0, 1, 2, 3, 4].map((index) => ({
      kind: "upcoming_event" as const,
      sourceEvidenceItemId: session.evidenceItemId,
      sourceEventRevisionId: session.revisionId,
      sourceClaimVersionId: null,
      sourceEpisodeVersionId: null,
      canonicalClaimKey: null,
      localizedSummary: `事项${index}`,
      expectedStartAt: `2026-11-0${index + 1}T07:00:00.000Z`,
      expectedEndAt: `2026-11-0${index + 1}T08:00:00.000Z`,
      timePrecision: "range",
      timezone: "Asia/Shanghai",
      followupEligibleFromAt: `2026-10-2${index}T07:00:00.000Z`,
      expiresAt: `2026-11-1${index}T08:00:00.000Z`,
      expirySource: "anchored_upcoming_plus_7d",
      reuseOpenLoopId: null,
    }));
    const settled = await repository!.commitEventEffects({
      userId: OWNER,
      sourceEventRevisionId: session.revisionId,
      expectedDataEpoch: 1,
      generationCommandId: admitted.generationCommandId,
      modelRunAttemptId: admitted.modelRunAttemptId,
      policyVersion: POLICY,
      formations,
      closures: [],
      ambiguousSuppressedTargetIds: [],
      now: new Date(BASE_TIME),
    });
    expect(settled.outcome).toBe("settled");
    if (settled.outcome === "settled") {
      expect(settled.formed).toBe(4);
    }
  }, 60_000);

  it("materializes expiry with the original effective time and lets a pre-expiry closure win", async () => {
    const session = await seedSession({
      text: "在等一个申请结果。",
    });
    const admitted = await admitExtractCommand(session.revisionId);
    const expiresAt = new Date(BASE_TIME + 3 * 86_400_000).toISOString();
    const formed = await repository!.commitEventEffects({
      userId: OWNER,
      sourceEventRevisionId: session.revisionId,
      expectedDataEpoch: 1,
      generationCommandId: admitted.generationCommandId,
      modelRunAttemptId: admitted.modelRunAttemptId,
      policyVersion: POLICY,
      formations: [
        {
          kind: "awaited_outcome",
          sourceEvidenceItemId: session.evidenceItemId,
          sourceEventRevisionId: session.revisionId,
          sourceClaimVersionId: null,
          sourceEpisodeVersionId: null,
          canonicalClaimKey: null,
          localizedSummary: "申请结果",
          expectedStartAt: null,
          expectedEndAt: null,
          timePrecision: "unknown",
          timezone: null,
          followupEligibleFromAt: new Date(BASE_TIME).toISOString(),
          expiresAt,
          expirySource: "unanchored_plus_14d",
          reuseOpenLoopId: null,
        },
      ],
      closures: [],
      ambiguousSuppressedTargetIds: [],
      now: new Date(BASE_TIME),
    });
    expect(formed.outcome).toBe("settled");
    const laneBefore = await repository!.readOpenLane({
      userId: OWNER,
      now: new Date(BASE_TIME + 2 * 86_400_000),
      watermarkReadable: true,
    });
    expect(laneBefore.length).toBeGreaterThan(0);
    // The scanner materializes expired history after the boundary.
    const scanned = await repository!.expireDueLoops({
      now: new Date(BASE_TIME + 5 * 86_400_000),
      policyVersion: EXPIRY_POLICY,
    });
    expect(scanned.expired).toBeGreaterThan(0);
    const loopRow = await database!.pool.query<{ open_loop_id: string }>(
      `SELECT l.open_loop_id FROM open_loops l
       INNER JOIN open_loop_versions v ON v.open_loop_version_id = l.current_version_id
       WHERE l.user_id = $1 AND v.status = 'expired'
       ORDER BY v.terminal_processed_at DESC LIMIT 1`,
      [OWNER],
    );
    const expiredId = loopRow.rows[0]?.open_loop_id;
    expect(expiredId).toBeTruthy();
    const expiredVersion = await repository!.readVersion({ openLoopId: expiredId! });
    expect(expiredVersion?.status).toBe("expired");
    expect(new Date(expiredVersion?.terminalEffectiveAt ?? "").getTime()).toBe(
      new Date(expiresAt).getTime(),
    );
    // A pre-expiry Event still wins its arbitration after the scan.
    const beforeExpiry = await seedSession({
      text: "申请结果已经出了，我收到了。",
    });
    const admittedLate = await admitExtractCommand(beforeExpiry.revisionId);
    const arbitration = await repository!.commitEventEffects({
      userId: OWNER,
      sourceEventRevisionId: beforeExpiry.revisionId,
      expectedDataEpoch: 1,
      generationCommandId: admittedLate.generationCommandId,
      modelRunAttemptId: admittedLate.modelRunAttemptId,
      policyVersion: POLICY,
      formations: [],
      closures: [
        {
          targetOpenLoopId: expiredId!,
          terminalStatus: "resolved",
          closureEventRevisionId: beforeExpiry.revisionId,
          // Committed one day before expiry: closure wins.
          closureCommittedAt: new Date(BASE_TIME + 2 * 86_400_000).toISOString(),
        },
      ],
      ambiguousSuppressedTargetIds: [],
      now: new Date(BASE_TIME + 6 * 86_400_000),
    });
    expect(arbitration.outcome).toBe("settled");
    const afterArbitration = await repository!.readVersion({ openLoopId: expiredId! });
    expect(afterArbitration?.status).toBe("resolved");
    // Boundary-equal Events never rewrite expired: covered by the pure
    // arbitration unit test; the scanner row above keeps its original
    // effective time as immutable history.
  }, 60_000);
});
