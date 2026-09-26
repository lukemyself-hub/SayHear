import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  OPEN_LOOP_EXTRACTION_POLICY_VERSION,
  createModelRoleCommandService,
  createModelRoleRegistry,
  createOpenLoopExtractionScanService,
  runOpenLoopExtractAttempt,
  type ModelRoleConfigurationSnapshot,
  type OpenLoopExtractModelProvider,
} from "@sayhear/application";
import {
  PostgresModelRoleCommandRepository,
  PostgresOpenLoopRepository,
  runMigrations,
} from "@sayhear/data";
import { asEvidenceItemId, asUserId } from "@sayhear/domain";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const systemDescribe = testDatabaseUrl ? describe : describe.skip;

const OWNER = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");
const BASE_TIME = Date.parse("2026-09-20T00:00:00.000Z");
const LANE_POLICY = OPEN_LOOP_EXTRACTION_POLICY_VERSION;
const G2_FINGERPRINT = `sha256:${"e".repeat(64)}`;

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

systemDescribe("open_loop.extract lane (issue #207 layer 2b)", () => {
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

  async function seedSession(input: { text: string; timeZone?: string }): Promise<{
    conversationEventId: string;
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
       ) VALUES ($1, $2, $3, $5, $4, $4, 'quiescent', 1, 0, 1, 1, 1, $4, $4, $4)`,
      [dailySessionId, OWNER, logicalDate, now, input.timeZone ?? "Asia/Shanghai"],
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
    return { conversationEventId, evidenceItemId, revisionId };
  }

  function commandService() {
    return createModelRoleCommandService({
      registry: createModelRoleRegistry([configuration]),
      repository: new PostgresModelRoleCommandRepository(
        database!.pool,
        undefined,
        undefined,
        G2_FINGERPRINT,
      ),
    });
  }

  function scanService() {
    return createOpenLoopExtractionScanService({
      clock: () => new Date(BASE_TIME),
      policyVersion: LANE_POLICY,
      repository: repository!,
      modelRoleCommandService: commandService(),
      enabled: true,
    });
  }

  function fakeProvider(
    revisionId: string,
    evidenceItemId: string,
    datedOutcome?: Readonly<{
      startAt: string;
      endAt: string;
      timeZone: string;
      timeExpression: string;
    }>,
  ): OpenLoopExtractModelProvider {
    return {
      role: "open_loop.extract",
      extractProposals: async () => ({
        proposals: [
          {
            kind: datedOutcome ? "awaited_outcome" : "upcoming_event",
            evidenceItemId: asEvidenceItemId(evidenceItemId),
            evidenceRevisionId: revisionId,
            hasRealAnchor: true,
            isTaskLike: false,
            userTimeExpression: datedOutcome?.timeExpression ?? "下周三下午",
            expectedWindow: datedOutcome ? {
              startAt: datedOutcome.startAt,
              endAt: datedOutcome.endAt,
              precision: "date",
              timezone: datedOutcome.timeZone,
            } : null,
            proposalIndex: 0,
          },
        ],
        closures: [],
      }),
    };
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
         release_fingerprint, status, activated_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
      [
        configuration.role,
        configuration.rolloutPin,
        configuration.configVersion,
        configuration.providerPolicyVersion,
        G2_FINGERPRINT,
        now,
      ],
    );
    repository = new PostgresOpenLoopRepository(seeded.pool);
  }, 60_000);

  afterAll(async () => {
    await database?.dispose();
  });

  it("lists, snapshots, admits, and extracts one Event end to end", async () => {
    const session = await seedSession({
      text: "下周三下午有一个已安排的面试。",
    });

    const pending = await repository!.listEventsNeedingExtraction({
      policyVersion: LANE_POLICY,
      limit: 50,
    });
    expect(pending.map((entry) => entry.eventRevisionId)).toContain(
      session.revisionId,
    );

    const frozen = await repository!.readExtractionSnapshot({
      eventRevisionId: session.revisionId,
    });
    expect(frozen.outcome).toBe("ready");
    if (frozen.outcome !== "ready") return;
    expect(frozen.snapshot.userText).toBe("下周三下午有一个已安排的面试。");
    expect(frozen.snapshot.evidence).toHaveLength(1);

    const scan = await scanService().scanPending();
    expect(scan.extractionsQueued).toBeGreaterThanOrEqual(1);

    const service = commandService();
    const admitted = await service.admit({
      userId: OWNER,
      role: "open_loop.extract",
      intentKey: `open-loop-extract:${session.revisionId}:probe`,
      subjectType: "conversation_event_revision",
      subjectId: session.revisionId,
      sourceRevision: 1,
      sourceSnapshot: `snapshot:${session.revisionId}:probe`,
      inputManifest: [
        { key: "evidence", revision: 1, fingerprint: `fp:${session.revisionId}` },
      ],
      expectedDataEpoch: 1,
      now: new Date(BASE_TIME),
    });
    expect(admitted.outcome).toBe("created");

    const subject = await repository!.readAttemptEventRevision({
      userId: OWNER,
      generationCommandId: String(admitted.generationCommandId),
    });
    expect(subject).toEqual({
      outcome: "ready",
      eventRevisionId: session.revisionId,
    });

    const result = await runOpenLoopExtractAttempt({
      clock: () => new Date(BASE_TIME),
      repository: repository!,
      modelRoleCommandService: service,
      openLoopExtractProvider: fakeProvider(
        session.revisionId,
        session.evidenceItemId,
      ),
      command: {
        workflowCommandId: "01984477-6f9a-7b25-a5cc-83c3b21fbc68",
        eventRevisionId: session.revisionId,
        sourceRevision: 1,
        generationCommandId: String(admitted.generationCommandId),
        modelRunAttemptId: String(admitted.modelRunAttemptId),
        attemptNo: 1,
        attemptKind: "initial",
        rolloutPin: configuration.rolloutPin,
        policyVersion: LANE_POLICY,
        expectedDataEpoch: 1,
      },
    });
    expect(result.outcome).toBe("extracted");
    expect(result.formedCount).toBe(1);
    expect(result.errorCode).toBeNull();

    // The settled run closes the lane: the scan converges to zero.
    await expect(
      repository!.listEventsNeedingExtraction({
        policyVersion: LANE_POLICY,
        limit: 50,
      }),
    ).resolves.toEqual([]);
  });

  it("keeps a direct User outcome out of the Los Angeles selector until the local deadline passes", async () => {
    const text = "I asked Mara at the Harbor archive about my scan request; she said the answer would arrive by September 23, 2026, and I have not heard back yet.";
    const session = await seedSession({ text, timeZone: "America/Los_Angeles" });
    const service = commandService();
    const admitted = await service.admit({
      userId: OWNER,
      role: "open_loop.extract",
      intentKey: `open-loop-extract:${session.revisionId}:local-date`,
      subjectType: "conversation_event_revision",
      subjectId: session.revisionId,
      sourceRevision: 1,
      sourceSnapshot: `snapshot:${session.revisionId}:local-date`,
      inputManifest: [
        { key: "evidence", revision: 1, fingerprint: `fp:${session.revisionId}` },
      ],
      expectedDataEpoch: 1,
      now: new Date(BASE_TIME),
    });
    expect(admitted.outcome).toBe("created");
    if (admitted.outcome !== "created") return;

    const result = await runOpenLoopExtractAttempt({
      clock: () => new Date(BASE_TIME),
      repository: repository!,
      modelRoleCommandService: service,
      openLoopExtractProvider: fakeProvider(session.revisionId, session.evidenceItemId, {
        startAt: "2026-09-23T07:00:00.000Z",
        endAt: "2026-09-24T07:00:00.000Z",
        timeZone: "America/Los_Angeles",
        timeExpression: "by September 23, 2026",
      }),
      command: {
        workflowCommandId: seedId(),
        eventRevisionId: session.revisionId,
        sourceRevision: 1,
        generationCommandId: String(admitted.generationCommandId),
        modelRunAttemptId: String(admitted.modelRunAttemptId),
        attemptNo: 1,
        attemptKind: "initial",
        rolloutPin: configuration.rolloutPin,
        policyVersion: LANE_POLICY,
        expectedDataEpoch: 1,
      },
    });
    expect(result).toMatchObject({ outcome: "extracted", formedCount: 1 });
    const before = await repository!.readOpenLane({
      userId: OWNER,
      now: new Date("2026-09-24T06:59:59.999Z"),
      watermarkReadable: true,
    });
    const after = await repository!.readOpenLane({
      userId: OWNER,
      now: new Date("2026-09-24T07:00:00.000Z"),
      watermarkReadable: true,
    });
    const formed = after.find((loop) =>
      loop.expectedStartAt !== null &&
      Date.parse(loop.expectedStartAt) === Date.parse("2026-09-23T07:00:00.000Z"),
    );
    expect(before.some((loop) => loop.openLoopId === formed?.openLoopId)).toBe(false);
    expect(formed).toMatchObject({ timePrecision: "date", timezone: "America/Los_Angeles" });
    if (!formed) return;
    await expect(repository!.readSourceEvidence({
      userId: OWNER,
      openLoopId: String(formed.openLoopId),
      openLoopVersionId: formed.openLoopVersionId,
      expectedSourceEventRevisionId: session.revisionId,
    })).resolves.toMatchObject({ eventRevisionId: session.revisionId, text });
  }, 60_000);

  it("treats a superseded revision as stale and lists only the current head", async () => {
    const session = await seedSession({ text: "旧版本。" });
    const pool = database!.pool;
    const revisionId2 = seedId();
    const now = new Date(BASE_TIME);
    await pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, canonical_text, locale, transcript_status, created_by, created_at
       ) VALUES ($1, $2, $3, 2, '新版本。', 'zh', 'corrected', 'client', $4)`,
      [revisionId2, OWNER, session.conversationEventId, now],
    );
    await pool.query(
      "UPDATE conversation_events SET current_revision_id = $2 WHERE conversation_event_id = $1",
      [session.conversationEventId, revisionId2],
    );

    await expect(
      repository!.readExtractionSnapshot({
        eventRevisionId: session.revisionId,
      }),
    ).resolves.toEqual({ outcome: "stale" });

    const pending = await repository!.listEventsNeedingExtraction({
      policyVersion: LANE_POLICY,
      limit: 50,
    });
    const ids = pending.map((entry) => entry.eventRevisionId);
    expect(ids).not.toContain(session.revisionId);
    expect(ids).toContain(revisionId2);
  });
});
