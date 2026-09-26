import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PROACTIVE_FOLLOWUP_EXPRESSION_PROMPT_VERSION,
  PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION,
  PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
  selectProactiveFollowupTarget,
} from "@sayhear/application";
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

const OWNER = "01984477-1f9a-7b25-a5cc-83c3b21fbc68";
const BASE_TIME = new Date("2026-09-11T12:00:00.000Z");

function fixtureId(number: number): string {
  return `01990000-0000-7000-8000-${number.toString(16).padStart(12, "0")}`;
}

const SESSION_ID = fixtureId(1);
const PROMPT_TURN_ID = fixtureId(2);
const SEGMENT_TURN_ID = fixtureId(3);
const TRIGGER_TURN_ID = fixtureId(4);
const PROMPT_EVENT_ID = fixtureId(5);
const ASSISTANT_EVENT_ID = fixtureId(6);
const TRIGGER_EVENT_ID = fixtureId(7);
const PROMPT_REVISION_ID = fixtureId(8);
const ASSISTANT_REVISION_ID = fixtureId(9);
const TRIGGER_REVISION_ID = fixtureId(10);
const MAIN_COMMAND_ID = fixtureId(11);
const SEGMENT_COMMAND_ID = fixtureId(12);
const SEGMENT_CONTEXT_ID = fixtureId(13);
const ATTEMPT_ID = fixtureId(14);
const SNAPSHOT_ID = fixtureId(15);
const EVIDENCE_ID = fixtureId(16);
const OPEN_LOOP_ID = fixtureId(17);
const OPEN_LOOP_VERSION_ID = fixtureId(18);
const COOLDOWN_TARGET_ID = fixtureId(19);
const COOLDOWN_TARGET_VERSION_ID = fixtureId(20);
const COOLDOWN_STATE_ID = fixtureId(21);
const COOLDOWN_STATE_VERSION_ID = fixtureId(22);
const LATER_TRIGGER_TURN_ID = fixtureId(23);
const LATER_TRIGGER_EVENT_ID = fixtureId(24);
const LATER_TRIGGER_REVISION_ID = fixtureId(25);

systemDescribe("C2 proactive follow-up PostgreSQL seam (issue #205)", () => {
  let database: IsolatedPostgresSchema | undefined;
  let repository: PostgresProactiveFollowupRepository;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl!);
    await runMigrations(database.pool);

    await database.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [OWNER, BASE_TIME],
    );
    await database.pool.query(
      `INSERT INTO daily_sessions (
         daily_session_id, user_id, logical_date, timezone_at_start,
         started_at, last_activity_at, activity_state,
         current_continuous_exchange_no, dialogue_revision, source_revision,
         next_turn_sequence_no, next_event_sequence_no, created_at, updated_at
       ) VALUES ($1, $2, '2026-09-11', 'UTC', $3, $3, 'active', 1, 1, 1, 4, 4, $3, $3)`,
      [SESSION_ID, OWNER, BASE_TIME],
    );
    await database.pool.query(
      `INSERT INTO interaction_turns (
         interaction_turn_id, user_id, daily_session_id, client_turn_id,
         turn_sequence_no, continuous_exchange_no, status, started_at,
         settled_at, created_at, updated_at
       ) VALUES
         ($1, $4, $5, 'prompt', 1, 1, 'settled', $3, $3, $3, $3),
         ($2, $4, $5, 'segment', 2, 1, 'settled', $3, $3, $3, $3),
         ($6, $4, $5, 'trigger', 3, 1, 'settled', $3, $3, $3, $3)`,
      [PROMPT_TURN_ID, SEGMENT_TURN_ID, BASE_TIME, OWNER, SESSION_ID, TRIGGER_TURN_ID],
    );
    await database.pool.query(
      `INSERT INTO conversation_events (
         conversation_event_id, user_id, daily_session_id,
         interaction_turn_id, sequence_no, client_event_id, actor, channel,
         event_type, lifecycle_status, created_at
       ) VALUES
         ($1, $4, $5, $6, 1, 'prompt', 'user', 'text', 'user_message', 'active', $3),
         ($2, $4, $5, $7, 2, 'assistant', 'assistant', 'text', 'assistant_response', 'active', $3),
         ($8, $4, $5, $9, 3, 'trigger', 'user', 'text', 'user_message', 'active', $3)`,
      [
        PROMPT_EVENT_ID,
        ASSISTANT_EVENT_ID,
        BASE_TIME,
        OWNER,
        SESSION_ID,
        PROMPT_TURN_ID,
        SEGMENT_TURN_ID,
        TRIGGER_EVENT_ID,
        TRIGGER_TURN_ID,
      ],
    );
    await database.pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, locale, canonical_text, transcript_status, created_by,
         created_at
       ) VALUES
         ($1, $5, $6, 1, 'en', 'Synthetic current user prompt.', 'final', 'client', $4),
         ($2, $5, $7, 1, 'en', 'Synthetic proactive follow-up.', 'final', 'provider', $4),
         ($3, $5, $8, 1, 'en', 'Synthetic short response.', 'final', 'client', $4)`,
      [
        PROMPT_REVISION_ID,
        ASSISTANT_REVISION_ID,
        TRIGGER_REVISION_ID,
        BASE_TIME,
        OWNER,
        PROMPT_EVENT_ID,
        ASSISTANT_EVENT_ID,
        TRIGGER_EVENT_ID,
      ],
    );
    await database.pool.query(
      `UPDATE conversation_events
       SET current_revision_id = CASE conversation_event_id
         WHEN $1::uuid THEN $4::uuid
         WHEN $2::uuid THEN $5::uuid
         WHEN $3::uuid THEN $6::uuid
       END
       WHERE conversation_event_id IN ($1::uuid, $2::uuid, $3::uuid)`,
      [
        PROMPT_EVENT_ID,
        ASSISTANT_EVENT_ID,
        TRIGGER_EVENT_ID,
        PROMPT_REVISION_ID,
        ASSISTANT_REVISION_ID,
        TRIGGER_REVISION_ID,
      ],
    );
    await database.pool.query(
      `INSERT INTO generation_commands (
         generation_command_id, user_id, interaction_turn_id, operation_type,
         intent_key, subject_type, subject_id, input_revision_kind,
         input_revision_id, prompt_version, product_policy_version,
         safety_policy_version, relationship_policy_version,
         locale_policy_version, locale, provider, model, model_snapshot,
         model_config_version, provider_policy_version, freshness_policy,
         expected_data_epoch, status,
         created_at, settled_at, output_format_version, persona_version,
         harness_policy_version, conversation_action_catalog_version,
         source_revision, source_snapshot, input_manifest, parameter_snapshot,
         fallback_mode
       ) VALUES
         ($1, $3, $4, 'conversation.text', 'main', 'conversation_event', $6,
          'conversation_event_revision', $7, 'prompt:v1', 'product:v1',
          'safety:v1', 'relationship:v1', 'locale:v1', 'en', 'synthetic',
          'synthetic-model', 'synthetic-model@fixture', 'config:v1',
          'openai-conversation-text:v1', 'source_valid:v1', 1, 'succeeded', $9, $9, 'output:v1',
          'persona:v1', 'harness:v1', 'catalog:v1', 1, $8, '{}'::jsonb,
          '{}'::jsonb, 'disabled'),
         ($2, $3, $5, 'conversation.text', 'segment', 'conversation_event', $6,
          'conversation_event_revision', $7, 'prompt:v1', 'product:v1',
          'safety:v1', 'relationship:v1', 'locale:v1', 'en', 'synthetic',
          'synthetic-model', 'synthetic-model@fixture', 'config:v1',
          'openai-conversation-text:v1', 'source_valid:v1', 1, 'succeeded', $9, $9, 'output:v1',
          'persona:v1', 'harness:v1', 'catalog:v1', 1, $8, '{}'::jsonb,
          '{}'::jsonb, 'disabled')`,
      [
        MAIN_COMMAND_ID,
        SEGMENT_COMMAND_ID,
        OWNER,
        PROMPT_TURN_ID,
        SEGMENT_TURN_ID,
        PROMPT_EVENT_ID,
        PROMPT_REVISION_ID,
        "source:fixture",
        BASE_TIME,
      ],
    );
    await database.pool.query(
      `UPDATE conversation_events
       SET generation_command_id = $2
       WHERE conversation_event_id = $1`,
      [ASSISTANT_EVENT_ID, MAIN_COMMAND_ID],
    );
    await database.pool.query(
      `INSERT INTO compiled_contexts (
         compiled_context_id, user_id, generation_command_id,
         compiler_version, dialogue_revision, source_revision, locale,
         section_budgets, total_tokens, content_hmac, created_at,
         policy_versions, sections, integrity_algorithm, integrity_key_version
       ) VALUES ($1, $2, $3, 'context:v1', 1, 1, 'en', '{}'::jsonb, 1,
                 'synthetic-hmac', $4, '{}'::jsonb, '[]'::jsonb,
                 'hmac-sha256', 'synthetic-key')`,
      [SEGMENT_CONTEXT_ID, OWNER, SEGMENT_COMMAND_ID, BASE_TIME],
    );
    await database.pool.query(
      `INSERT INTO model_run_attempts (
         model_run_attempt_id, user_id, generation_command_id, attempt_no,
         operation_type, provider, model, model_snapshot, prompt_version,
         status, started_at, completed_at, created_at
       ) VALUES ($1, $2, $3, 1, 'conversation.text', 'synthetic',
                 'synthetic-model', 'synthetic-model@fixture', 'prompt:v1',
                 'succeeded', $4, $4, $4)`,
      [ATTEMPT_ID, OWNER, MAIN_COMMAND_ID, BASE_TIME],
    );
    await database.pool.query(
      `INSERT INTO evidence_source_snapshots (
         evidence_source_snapshot_id, user_id, daily_session_id,
         source_revision, extraction_policy_version, command_id, attempt_id,
         champion_config_version, champion_provider, champion_model,
         champion_snapshot, champion_provider_policy_version, created_at
       ) VALUES ($1, $2, $3, 1, 'synthetic-evidence:v1', 'fixture-command',
                 'fixture-attempt', 'fixture-config', 'openai', 'fixture-model',
                 'fixture-model@fixture', 'fixture-policy:v1', $4)`,
      [SNAPSHOT_ID, OWNER, SESSION_ID, BASE_TIME],
    );
    await database.pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id,
         source_event_id, source_revision_id, source_actor, source_status,
         locator_type, locator_key, extraction_policy_version, evidence_role,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision',
                 '1:0', 'synthetic-evidence:v1', 'factual_support', $6)`,
      [EVIDENCE_ID, OWNER, SNAPSHOT_ID, PROMPT_EVENT_ID, PROMPT_REVISION_ID, BASE_TIME],
    );
    await database.pool.query(
      `INSERT INTO open_loops (
         open_loop_id, user_id, open_loop_kind, created_at
       ) VALUES ($1, $2, 'upcoming_event', $3)`,
      [OPEN_LOOP_ID, OWNER, BASE_TIME],
    );
    await database.pool.query(
      `INSERT INTO open_loop_versions (
         open_loop_version_id, open_loop_id, user_id, revision,
         open_loop_kind, source_evidence_item_id, source_event_revision_id,
         canonical_claim_key, localized_summary, expected_start_at,
         time_precision, timezone, followup_eligible_from_at, expires_at,
         expiry_source, status, policy_version, generation_command_id,
         model_run_attempt_id, created_at
       ) VALUES ($1, $2, $3, 1, 'upcoming_event', $4, $5,
                 'synthetic-key', 'Synthetic open loop.', $6, 'instant', 'UTC',
                 $7, $8, 'anchored_upcoming_plus_7d', 'open',
                 'open-loop-formation:v1', $9, $10, $11)`,
      [
        OPEN_LOOP_VERSION_ID,
        OPEN_LOOP_ID,
        OWNER,
        EVIDENCE_ID,
        PROMPT_REVISION_ID,
        new Date(BASE_TIME.getTime() + 60 * 60 * 1000),
        BASE_TIME,
        new Date(BASE_TIME.getTime() + 24 * 60 * 60 * 1000),
        MAIN_COMMAND_ID,
        ATTEMPT_ID,
        BASE_TIME,
      ],
    );
    await database.pool.query(
      `UPDATE open_loops SET current_version_id = $2 WHERE open_loop_id = $1`,
      [OPEN_LOOP_ID, OPEN_LOOP_VERSION_ID],
    );
    await database.pool.query(
      `INSERT INTO proactive_followup_states (
         proactive_followup_state_id, user_id, target_kind, target_id,
         current_version_id, created_at
       ) VALUES ($1, $2, 'open_loop', $3, NULL, $4)`,
      [
        COOLDOWN_STATE_ID,
        OWNER,
        COOLDOWN_TARGET_ID,
        BASE_TIME,
      ],
    );
    await database.pool.query(
      `INSERT INTO proactive_followup_state_versions (
         proactive_followup_state_version_id, proactive_followup_state_id,
         user_id, revision, target_kind, target_id, target_version_id,
         eligibility_status, suppression_reason, consecutive_soft_stop_count,
         suppressed_until_at, policy_version, created_at
       ) VALUES ($1, $2, $3, 1, 'open_loop', $4, $5, 'suppressed',
                 'short_response', $6, $7, 'proactive-followup-suppression:v1', $8)`,
      [
        COOLDOWN_STATE_VERSION_ID,
        COOLDOWN_STATE_ID,
        OWNER,
        COOLDOWN_TARGET_ID,
        COOLDOWN_TARGET_VERSION_ID,
        1,
        new Date(BASE_TIME.getTime() + 7 * 24 * 60 * 60 * 1000),
        BASE_TIME,
      ],
    );
    await database.pool.query(
      `UPDATE proactive_followup_states
       SET current_version_id = $2
       WHERE proactive_followup_state_id = $1 AND user_id = $3`,
      [COOLDOWN_STATE_ID, COOLDOWN_STATE_VERSION_ID, OWNER],
    );

    repository = new PostgresProactiveFollowupRepository(database.pool);
  }, 20_000);

  afterAll(async () => {
    await database?.dispose();
  });

  function selectionManifest() {
    const result = selectProactiveFollowupTarget({
      userId: OWNER,
      dailySessionId: SESSION_ID,
      continuousExchangeNo: 1,
      currentUserEventRevisionId: PROMPT_REVISION_ID,
      currentUserEventSequence: 1,
      currentSourceRevision: 1,
      opportunity: "open_start",
      ordinaryQuestionAlreadyAsked: false,
      dialogue: {
        status: "current",
        coveredThroughSequence: 1,
        currentEventSequence: 1,
        currentEventRevisionId: PROMPT_REVISION_ID,
        currentRequestRequiresFocus: {
          value: false,
          confidence: 1,
          sourceRevisionIds: [PROMPT_REVISION_ID],
        },
        proactiveFollowupOpportunity: {
          value: "open_start",
          confidence: 1,
          sourceRevisionIds: [PROMPT_REVISION_ID],
        },
      },
      lanes: [
        {
          name: "open_loop",
          enabled: true,
          status: "complete",
          watermark: { sourceRevision: 1, coveredThroughSequence: 1 },
          manifestVersion: "open-loop-read:v2",
          integrity: "valid",
          candidates: [
            {
              targetKind: "open_loop",
              targetId: OPEN_LOOP_ID,
              targetVersionId: OPEN_LOOP_VERSION_ID,
              source: "open_loop",
              sourceRank: null,
              evidenceAt: BASE_TIME.toISOString(),
              expectedStartAt: new Date(BASE_TIME.getTime() + 60 * 60 * 1000).toISOString(),
              expiresAt: new Date(BASE_TIME.getTime() + 24 * 60 * 60 * 1000).toISOString(),
              sensitive: false,
              lastUsedAt: null,
              current: true,
              eligible: true,
              trustFence: "valid",
              mentionedInExchange: false,
              formedInCurrentTurn: false,
            },
          ],
        },
      ],
      states: [],
      now: BASE_TIME,
    });
    expect(result.outcome).toBe("selected");
    if (result.outcome !== "selected") throw new Error(result.reason);
    return result.manifest;
  }

  it("serializes one reservation per exchange under concurrent calls", async () => {
    const input = {
      userId: OWNER,
      expectedDataEpoch: 1,
      dailySessionId: SESSION_ID,
      continuousExchangeNo: 1,
      mainGenerationCommandId: MAIN_COMMAND_ID,
      target: {
        targetKind: "open_loop" as const,
        targetId: OPEN_LOOP_ID,
        targetVersionId: OPEN_LOOP_VERSION_ID,
      },
      manifest: selectionManifest(),
      now: BASE_TIME,
    };
    const results = await Promise.all([
      repository.reserveSelection(input),
      repository.reserveSelection(input),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "already_reserved",
      "reserved",
    ]);
    const reservationIds = results.flatMap((result) =>
      "reservationId" in result ? [result.reservationId] : [],
    );
    expect(new Set(reservationIds).size).toBe(1);
    const firstReservationId = reservationIds[0]!;
    await database!.pool.query(
      `UPDATE proactive_followup_reservations
       SET status = 'abandoned', terminal_at = $2
       WHERE proactive_followup_reservation_id = $1 AND user_id = $3`,
      [firstReservationId, BASE_TIME, OWNER],
    );
    const retry = await repository.reserveSelection(input);
    expect(retry.outcome).toBe("reserved");
    if (retry.outcome !== "reserved") {
      throw new Error("reason" in retry ? retry.reason : "retry_not_reserved");
    }
    expect(retry.reservationId).not.toBe(firstReservationId);
  });

  it("commits a typed use idempotently and records the next-event cooldown", async () => {
    const reservation = await database!.pool.query<{ proactive_followup_reservation_id: string }>(
      `SELECT proactive_followup_reservation_id
       FROM proactive_followup_reservations
       WHERE user_id = $1 AND daily_session_id = $2 AND continuous_exchange_no = 1
         AND status = 'active'`,
      [OWNER, SESSION_ID],
    );
    const reservationId = reservation.rows[0]!.proactive_followup_reservation_id;
    const useInput = {
      userId: OWNER,
      expectedDataEpoch: 1,
      reservationId,
      mainGenerationCommandId: MAIN_COMMAND_ID,
      segmentGenerationCommandId: SEGMENT_COMMAND_ID,
      compiledContextId: SEGMENT_CONTEXT_ID,
      promptUserEventRevisionId: PROMPT_REVISION_ID,
      promptUserEventSequence: 1,
      assistantEventId: ASSISTANT_EVENT_ID,
      assistantEventRevisionId: ASSISTANT_REVISION_ID,
      targetKind: "open_loop" as const,
      targetId: OPEN_LOOP_ID,
      targetVersionId: OPEN_LOOP_VERSION_ID,
      expressionKind: "question" as const,
      finalTextLocator: {
        kind: "assistant_event_revision" as const,
        assistantEventRevisionId: ASSISTANT_REVISION_ID,
        segment: "proactive_followup" as const,
        ordinal: 0 as const,
      },
      selectionPolicyVersion: PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
      promptPolicyVersion: PROACTIVE_FOLLOWUP_EXPRESSION_PROMPT_VERSION,
      policyBundleVersion: PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION,
      policyBundle: { fixture: true },
      now: BASE_TIME,
    };
    await database!.pool.query(
      `UPDATE proactive_followup_reservations
       SET selection_manifest = jsonb_set(
         selection_manifest, '{policyBundleVersion}', '"tampered"'::jsonb
       )
       WHERE proactive_followup_reservation_id = $1 AND user_id = $2`,
      [reservationId, OWNER],
    );
    expect(await repository.commitUse(useInput)).toEqual({
      outcome: "fenced",
      reason: "manifest_lineage",
    });
    await database!.pool.query(
      `UPDATE proactive_followup_reservations
       SET selection_manifest = jsonb_set(
         selection_manifest, '{policyBundleVersion}', to_jsonb($2::text)
       )
       WHERE proactive_followup_reservation_id = $1 AND user_id = $3`,
      [reservationId, PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION, OWNER],
    );
    const committed = await repository.commitUse(useInput);
    expect(committed.outcome).toBe("committed");
    if (!("useId" in committed)) throw new Error(committed.reason);
    expect(await repository.commitUse({ ...useInput, useId: committed.useId })).toEqual({
      outcome: "already_committed",
      useId: committed.useId,
    });

    const dispositionInput = {
      userId: OWNER,
      expectedDataEpoch: 1,
      useId: committed.useId,
      targetKind: "open_loop" as const,
      targetId: OPEN_LOOP_ID,
      targetVersionId: OPEN_LOOP_VERSION_ID,
      triggerUserEventRevisionId: TRIGGER_REVISION_ID,
      triggerUserEventSequence: 3,
      signal: "short_response" as const,
      finalTextLocator: useInput.finalTextLocator,
      timeZone: "UTC",
      now: BASE_TIME,
    };
    const disposition = await repository.recordDisposition(dispositionInput);
    expect(disposition.outcome).toBe("recorded");
    if (!("stateVersionId" in disposition)) throw new Error(disposition.reason);
    expect(await repository.recordDisposition(dispositionInput)).toEqual({
      outcome: "already_recorded",
      stateVersionId: disposition.stateVersionId,
    });

    await database!.pool.query(
      `INSERT INTO interaction_turns (
         interaction_turn_id, user_id, daily_session_id, client_turn_id,
         turn_sequence_no, continuous_exchange_no, status, started_at,
         settled_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'later-trigger', 4, 1, 'settled', $4, $4, $4, $4)`,
      [LATER_TRIGGER_TURN_ID, OWNER, SESSION_ID, BASE_TIME],
    );
    await database!.pool.query(
      `INSERT INTO conversation_events (
         conversation_event_id, user_id, daily_session_id,
         interaction_turn_id, sequence_no, client_event_id, actor, channel,
         event_type, lifecycle_status, created_at
       ) VALUES ($1, $2, $3, $4, 4, 'later-trigger', 'user', 'text',
                 'user_message', 'active', $5)`,
      [LATER_TRIGGER_EVENT_ID, OWNER, SESSION_ID, LATER_TRIGGER_TURN_ID, BASE_TIME],
    );
    await database!.pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, locale, canonical_text, transcript_status, created_by,
         created_at
       ) VALUES ($1, $2, $3, 1, 'en', 'Synthetic later response.', 'final', 'client', $4)`,
      [LATER_TRIGGER_REVISION_ID, OWNER, LATER_TRIGGER_EVENT_ID, BASE_TIME],
    );
    await database!.pool.query(
      `UPDATE conversation_events SET current_revision_id = $2
       WHERE conversation_event_id = $1`,
      [LATER_TRIGGER_EVENT_ID, LATER_TRIGGER_REVISION_ID],
    );
    expect(
      await repository.recordDisposition({
        ...dispositionInput,
        triggerUserEventRevisionId: LATER_TRIGGER_REVISION_ID,
        triggerUserEventSequence: 4,
      }),
    ).toEqual({ outcome: "fenced", reason: "trigger_event_not_next" });

    const state = await repository.readState({
      userId: OWNER,
      targetKind: "open_loop",
      targetId: OPEN_LOOP_ID,
      now: new Date("2026-09-18T12:00:00.000Z"),
    });
    expect(state).toMatchObject({
      eligibilityStatus: "eligible",
      suppressionReason: null,
      consecutiveSoftStopCount: 1,
      releaseReason: "cooldown_elapsed",
    });
    const persisted = await database!.pool.query<{ count: string; manifest: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM proactive_followup_state_versions
          WHERE user_id = $1 AND target_id = $2) AS count,
         selection_manifest::text AS manifest
       FROM proactive_followup_reservations
       WHERE user_id = $1 AND proactive_followup_reservation_id = $3`,
      [OWNER, OPEN_LOOP_ID, reservationId],
    );
    expect(persisted.rows[0]?.count).toBe("2");
    expect(persisted.rows[0]?.manifest).not.toContain("Synthetic");
  });

  it("materializes a due state without creating a conversation event", async () => {
    const before = await database!.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM conversation_events WHERE user_id = $1",
      [OWNER],
    );
    const state = await repository.readState({
      userId: OWNER,
      targetKind: "open_loop",
      targetId: COOLDOWN_TARGET_ID,
      now: new Date("2026-09-18T12:00:00.000Z"),
    });
    expect(state).toMatchObject({
      eligibilityStatus: "eligible",
      releaseReason: "cooldown_elapsed",
    });
    const after = await database!.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM conversation_events WHERE user_id = $1",
      [OWNER],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("allows registry child-first clearing of the two deferred pointer cycles", async () => {
    await database!.pool.query("BEGIN");
    try {
      await database!.pool.query(
        "DELETE FROM proactive_followup_dispositions WHERE user_id = $1",
        [OWNER],
      );
      await database!.pool.query(
        "DELETE FROM proactive_followup_uses WHERE user_id = $1",
        [OWNER],
      );
      await database!.pool.query(
        "DELETE FROM proactive_followup_reservations WHERE user_id = $1",
        [OWNER],
      );
      await database!.pool.query(
        "DELETE FROM proactive_followup_state_versions WHERE user_id = $1",
        [OWNER],
      );
      await database!.pool.query(
        "DELETE FROM proactive_followup_states WHERE user_id = $1",
        [OWNER],
      );
      await database!.pool.query("COMMIT");
    } catch (error) {
      await database!.pool.query("ROLLBACK");
      throw error;
    }
    const remaining = await database!.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM proactive_followup_states WHERE user_id = $1
       UNION ALL
       SELECT COUNT(*)::text FROM proactive_followup_uses WHERE user_id = $1`,
      [OWNER],
    );
    expect(remaining.rows.map((row) => row.count)).toEqual(["0", "0"]);
  });
});
