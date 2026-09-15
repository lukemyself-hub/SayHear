import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OPEN_LOOP_EXTRACTION_POLICY_VERSION } from "@sayhear/application";
import {
  PostgresOpenLoopRepository,
  PostgresProactiveFollowupRepository,
  runMigrations,
} from "@sayhear/data";
import { asUserId } from "@sayhear/domain";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const systemDescribe = testDatabaseUrl ? describe : describe.skip;

const OWNER = asUserId("01984477-5f9a-7b25-a5cc-83c3b21fbc68");
const BASE_TIME = Date.parse("2026-09-20T00:00:00.000Z");

systemDescribe("proactive.followup crash path (issue #207 layer 2c)", () => {
  let database: IsolatedPostgresSchema | undefined;
  let proactive: PostgresProactiveFollowupRepository | undefined;
  let openLoop: PostgresOpenLoopRepository | undefined;

  let nextId = 0;
  let seedDay = 0;
  function seedId(): string {
    nextId += 1;
    const timeHex = BASE_TIME.toString(16).padStart(12, "0");
    const counter = nextId.toString(16).padStart(12, "0");
    return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${counter.slice(0, 3)}-a${counter.slice(3, 6)}-${counter.slice(6, 12).padStart(12, "0")}`;
  }

  async function seedTurn(): Promise<{
    dailySessionId: string;
    interactionTurnId: string;
    conversationEventId: string;
    revisionId: string;
  }> {
    const pool = database!.pool;
    const now = new Date(BASE_TIME);
    seedDay += 1;
    const logicalDate = `2026-10-${String(seedDay).padStart(2, "0")}`;
    const dailySessionId = seedId();
    const interactionTurnId = seedId();
    const conversationEventId = seedId();
    const revisionId = seedId();
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
       ) VALUES ($1, $2, $3, 1, 'remind me about the dentist', 'en', 'final', 'client', $4)`,
      [revisionId, OWNER, conversationEventId, now],
    );
    await pool.query(
      "UPDATE conversation_events SET current_revision_id = $2 WHERE conversation_event_id = $1",
      [conversationEventId, revisionId],
    );
    return { dailySessionId, interactionTurnId, conversationEventId, revisionId };
  }

  async function seedMainCommand(input: {
    interactionTurnId: string;
    conversationEventId: string;
    revisionId: string;
  }): Promise<string> {
    const commandId = seedId();
    const now = new Date(BASE_TIME);
    await database!.pool.query(
      `INSERT INTO generation_commands (
         generation_command_id, user_id, interaction_turn_id, operation_type,
         intent_key, subject_type, subject_id, input_revision_kind,
         input_revision_id, prompt_version, product_policy_version,
         safety_policy_version, relationship_policy_version,
         locale_policy_version, locale, provider, model, model_snapshot,
         model_config_version, freshness_policy, expected_data_epoch,
         status, created_at, provider_policy_version, output_format_version,
         harness_policy_version, conversation_action_catalog_version
       ) VALUES (
         $1, $2, $3, 'conversation.text', 'main:' || $7, 'conversation_event',
         $4, 'conversation_event_revision', $5, 'system-prompt:v1',
         'product-policy:v1', 'minimum-high-risk-response:v1',
         'relationship-boundary:v1', 'english-locale:v1', 'en-US',
         'system-test', 'synthetic-model', 'synthetic-model@fixture',
         'system-config:v1', 'source_valid:v1', 1, 'running', $6,
         'system-test-egress:v1', 'conversation-output:v1', 'test-harness:v1',
         'test-catalog:v1'
       )`,
      [
        commandId,
        OWNER,
        input.interactionTurnId,
        input.conversationEventId,
        input.revisionId,
        now,
        commandId,
      ],
    );
    return commandId;
  }

  async function seedSegmentCommand(input: {
    conversationEventId: string;
    status: "prepared" | "succeeded";
  }): Promise<string> {
    const commandId = seedId();
    const now = new Date(BASE_TIME);
    await database!.pool.query(
      `INSERT INTO generation_commands (
         generation_command_id, user_id, operation_type, model_role,
         generation_stage, intent_key, subject_type, subject_id,
         prompt_version, product_policy_version, safety_policy_version,
         relationship_policy_version, locale_policy_version, locale,
         provider, model, model_snapshot, model_config_version,
         freshness_policy, expected_data_epoch, status, created_at,
         provider_policy_version, output_format_version,
         harness_policy_version, conversation_action_catalog_version
       ) VALUES (
         $1, $2, 'proactive.followup', 'proactive.followup',
         'proactive_followup', 'segment:' || $6, 'conversation_event',
         $3, 'proactive-followup-prompt:v1', 'product-policy:v1',
         'minimum-high-risk-response:v1', 'relationship-boundary:v1',
         'english-locale:v1', 'en-US', 'system-test', 'synthetic-model',
         'synthetic-model@fixture', 'system-config:v1', 'source_valid:v1',
         1, $4, $5, 'system-test-egress:v1', 'conversation-output:v1',
         'test-harness:v1', 'test-catalog:v1'
       )`,
      [commandId, OWNER, input.conversationEventId, input.status, now, commandId],
    );
    return commandId;
  }

  async function seedReservation(input: {
    dailySessionId: string;
    mainCommandId: string;
    segmentCommandId: string;
  }): Promise<string> {
    const reservationId = seedId();
    const now = new Date(BASE_TIME);
    await database!.pool.query(
      `INSERT INTO proactive_followup_reservations (
         proactive_followup_reservation_id, user_id, daily_session_id,
         continuous_exchange_no, main_generation_command_id,
         segment_generation_command_id, target_kind, target_id,
         target_version_id, selection_manifest, selection_policy_version,
         status, expected_data_epoch, created_at
       ) VALUES (
         $1, $2, $3, 1, $4, $5, 'open_loop', $6, $7, '{}'::jsonb,
         'proactive-followup-selection:v1', 'active', 1, $8
       )`,
      [
        reservationId,
        OWNER,
        input.dailySessionId,
        input.mainCommandId,
        input.segmentCommandId,
        seedId(),
        seedId(),
        now,
      ],
    );
    return reservationId;
  }

  // Neon cold-start plus the full migration chain exceeds the default
  // 10s hook budget; the suite itself stays fast once the schema exists.
  beforeAll(async () => {
    const seeded = await createIsolatedPostgresSchema(testDatabaseUrl!);
    database = seeded;
    await runMigrations(seeded.pool);
    await seeded.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [OWNER, new Date(BASE_TIME)],
    );
    await seeded.pool.query(
      `INSERT INTO provider_egress_policy_versions (
         policy_version, provider, role, model_config_version, status, created_at
       ) VALUES ('system-test-egress:v1', 'system-test', 'proactive.followup',
         'system-config:v1', 'active', $1)`,
      [new Date(BASE_TIME)],
    );
    proactive = new PostgresProactiveFollowupRepository(seeded.pool);
    openLoop = new PostgresOpenLoopRepository(seeded.pool);
  }, 120_000);

  afterAll(async () => {
    await database?.dispose();
    database = undefined;
  });

  it("resolves the stage turn context from the request revision", async () => {
    const turn = await seedTurn();
    const mainCommandId = await seedMainCommand(turn);
    const context = await proactive!.readTurnContext({
      userId: String(OWNER),
      requestEventRevisionId: turn.revisionId,
      mainGenerationCommandId: mainCommandId,
    });
    expect(context).toMatchObject({
      dailySessionId: turn.dailySessionId,
      continuousExchangeNo: 1,
      currentUserEventSequence: 1,
      currentSourceRevision: 1,
      dialogueRevision: 0,
      expectedDataEpoch: 1,
      timeZone: "Asia/Shanghai",
      interactionTurnId: turn.interactionTurnId,
      locale: "en-US",
    });
    await expect(
      proactive!.readTurnContext({
        userId: String(OWNER),
        requestEventRevisionId: seedId(),
        mainGenerationCommandId: mainCommandId,
      }),
    ).resolves.toBeNull();
  });

  it("reports no dialogue projection and an unsettled lane for a fresh turn", async () => {
    const turn = await seedTurn();
    await expect(
      proactive!.readDialogueSnapshot({
        userId: String(OWNER),
        dailySessionId: turn.dailySessionId,
        dialogueRevision: 0,
        sourceRevision: 1,
        currentUserEventSequence: 1,
        requestEventRevisionId: turn.revisionId,
      }),
    ).resolves.toBeNull();
    await expect(
      openLoop!.hasUnsettledExtraction({
        userId: String(OWNER),
        policyVersion: OPEN_LOOP_EXTRACTION_POLICY_VERSION,
        throughSequence: 1,
      }),
    ).resolves.toBe(true);
    await expect(
      openLoop!.readLoopFormation({ userId: String(OWNER), openLoopIds: [] }),
    ).resolves.toEqual({});
    await expect(
      openLoop!.readCurrentSummary({
        userId: String(OWNER),
        openLoopId: seedId(),
        now: new Date(BASE_TIME),
      }),
    ).resolves.toBeNull();
    await expect(
      proactive!.listUsesAwaitingDisposition({ userId: String(OWNER) }),
    ).resolves.toEqual([]);
  });

  it("reclaims the active reservation through the segment command", async () => {
    const turn = await seedTurn();
    const mainCommandId = await seedMainCommand(turn);
    const segmentCommandId = await seedSegmentCommand({
      conversationEventId: turn.conversationEventId,
      status: "prepared",
    });
    const reservationId = await seedReservation({
      dailySessionId: turn.dailySessionId,
      mainCommandId,
      segmentCommandId,
    });
    const now = new Date(BASE_TIME);
    await expect(
      proactive!.abandonSegmentByCommand({
        userId: String(OWNER),
        segmentGenerationCommandId: segmentCommandId,
        now,
      }),
    ).resolves.toEqual({ outcome: "abandoned" });
    const status = await database!.pool.query(
      `SELECT status FROM proactive_followup_reservations
       WHERE proactive_followup_reservation_id = $1`,
      [reservationId],
    );
    expect(status.rows[0]?.status).toBe("abandoned");
    await expect(
      proactive!.abandonSegmentByCommand({
        userId: String(OWNER),
        segmentGenerationCommandId: segmentCommandId,
        now,
      }),
    ).resolves.toEqual({ outcome: "not_found" });
  });

  it("converges only reservations behind terminal segment commands", async () => {
    const turn = await seedTurn();
    const mainCommandId = await seedMainCommand(turn);
    const terminalSegmentId = await seedSegmentCommand({
      conversationEventId: turn.conversationEventId,
      status: "succeeded",
    });
    const terminalReservationId = await seedReservation({
      dailySessionId: turn.dailySessionId,
      mainCommandId,
      segmentCommandId: terminalSegmentId,
    });
    const liveSegmentId = await seedSegmentCommand({
      conversationEventId: turn.conversationEventId,
      status: "prepared",
    });
    const liveReservationId = seedId();
    await database!.pool.query(
      `INSERT INTO proactive_followup_reservations (
         proactive_followup_reservation_id, user_id, daily_session_id,
         continuous_exchange_no, main_generation_command_id,
         segment_generation_command_id, target_kind, target_id,
         target_version_id, selection_manifest, selection_policy_version,
         status, expected_data_epoch, created_at
       ) VALUES (
         $1, $2, $3, 2, $4, $5, 'open_loop', $6, $7, '{}'::jsonb,
         'proactive-followup-selection:v1', 'active', 1, $8
       )`,
      [
        liveReservationId,
        OWNER,
        turn.dailySessionId,
        mainCommandId,
        liveSegmentId,
        seedId(),
        seedId(),
        new Date(BASE_TIME),
      ],
    );
    // The global variant converges every owner in bounded batches; a single
    // owner here proves the terminal-status join (the per-owner variant
    // keeps its existing coverage).
    await expect(
      proactive!.reconcileTerminalReservationsGlobal({
        now: new Date(BASE_TIME),
      }),
    ).resolves.toBeGreaterThanOrEqual(1);
    const statuses = await database!.pool.query(
      `SELECT proactive_followup_reservation_id AS id, status
       FROM proactive_followup_reservations
       WHERE proactive_followup_reservation_id = ANY($1::uuid[])`,
      [[terminalReservationId, liveReservationId]],
    );
    const byId = Object.fromEntries(
      statuses.rows.map((row: { id: string; status: string }) => [row.id, row.status]),
    );
    expect(byId[terminalReservationId]).toBe("abandoned");
    expect(byId[liveReservationId]).toBe("active");
  });
});
