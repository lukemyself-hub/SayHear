import type {
  ConversationRetryTurn,
  InterruptedConversationResponse,
  InteractionTurnStatus,
  RecordConversationRetryInput,
  RecordConversationRetryRepositoryResult,
  RecordUserTextTurnInput,
  RecordUserTextTurnRepositoryResult,
  UserTextConversationRepository,
  UserTextMessage,
  UserTextTurn,
} from "@sayhear/application";
import {
  asConversationEventId,
  asConversationEventRevisionId,
  asDailySessionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  evaluatePrivateWriteGate,
  type PrivateWriteGateReason,
  type UserId,
} from "@sayhear/domain";
import type { Pool, PoolClient } from "pg";

import { findLatestBackupPolicyEvidence } from "./postgres-backup-policy-evidence";
import { createUuidV7 } from "./uuid-v7";

const retryableTransactionCodes = new Set(["40001", "40P01", "55P03"]);
const maximumTransactionAttempts = 3;

type ExistingTurnRow = Readonly<{
  generation_command_id: string | null;
  model_run_attempt_id: string | null;
  client_event_id: string;
  client_turn_id: string;
  daily_session_id: string;
  interaction_turn_id: string;
  locale: string;
  logical_date: string;
  revision_id: string;
  sequence_no: string;
  status: InteractionTurnStatus;
  text: string;
  timezone_at_start: string;
  turn_sequence_no: string;
  conversation_event_id: string;
}>;

type DailySessionRow = Readonly<{
  activity_state: "active" | "quiescent" | "finalized";
  current_continuous_exchange_no: number;
  daily_session_id: string;
  logical_date: string;
  next_event_sequence_no: string;
  next_turn_sequence_no: string;
  timezone_at_start: string;
}>;

type ExistingRetryRow = Readonly<{
  generation_command_id: string;
  interaction_turn_id: string;
  model_run_attempt_id: string;
  retry_action_event_id: string;
  retry_of_interaction_turn_id: string;
  status: InteractionTurnStatus;
  turn_sequence_no: string;
}>;

type OriginalRetrySourceRow = DailySessionRow &
  Readonly<{
    command_status: string;
    input_revision_id: string;
    locale: string;
    original_turn_id: string;
    subject_id: string;
    turn_status: InteractionTurnStatus;
  }>;

export class PostgresUserTextConversationRepository
  implements UserTextConversationRepository
{
  public constructor(private readonly pool: Pool) {}

  public async recordConversationRetry(
    input: RecordConversationRetryInput,
  ): Promise<RecordConversationRetryRepositoryResult> {
    for (let attempt = 1; attempt <= maximumTransactionAttempts; attempt += 1) {
      const client = await this.pool.connect();
      try {
        return await this.recordRetryInTransaction(client, input);
      } catch (error) {
        await rollbackQuietly(client);
        if (
          (!isRetryableTransactionError(error) &&
            !isRetryRecordRace(error)) ||
          attempt === maximumTransactionAttempts
        ) {
          throw error;
        }
        await delayWithJitter(attempt);
      } finally {
        client.release();
      }
    }

    throw new Error("The bounded Retry transaction loop exited unexpectedly.");
  }

  public async recordUserTextTurn(
    input: RecordUserTextTurnInput,
  ): Promise<RecordUserTextTurnRepositoryResult> {
    for (let attempt = 1; attempt <= maximumTransactionAttempts; attempt += 1) {
      const client = await this.pool.connect();
      try {
        return await this.recordInTransaction(client, input);
      } catch (error) {
        await rollbackQuietly(client);
        if (
          !isRetryableTransactionError(error) ||
          attempt === maximumTransactionAttempts
        ) {
          throw error;
        }
        await delayWithJitter(attempt);
      } finally {
        client.release();
      }
    }

    throw new Error("The bounded transaction retry loop exited unexpectedly.");
  }

  public async listInterruptedResponses(
    userId: UserId,
  ): Promise<readonly InterruptedConversationResponse[]> {
    const result = await this.pool.query<{
      interaction_turn_id: string;
      logical_date: string;
      retry_status: "available" | "retried" | "retrying";
      sequence_no: string;
    }>(
      `
        SELECT
          interrupted_turn.interaction_turn_id,
          session.logical_date::text,
          primary_event.sequence_no,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM interaction_turns retry_turn
              WHERE retry_turn.user_id = interrupted_turn.user_id
                AND retry_turn.retry_of_interaction_turn_id =
                  interrupted_turn.interaction_turn_id
                AND retry_turn.status IN ('settled', 'interrupted')
            ) THEN 'retried'
            WHEN EXISTS (
              SELECT 1
              FROM interaction_turns retry_turn
              WHERE retry_turn.user_id = interrupted_turn.user_id
                AND retry_turn.retry_of_interaction_turn_id =
                  interrupted_turn.interaction_turn_id
                AND retry_turn.status IN ('open', 'responding')
            ) THEN 'retrying'
            ELSE 'available'
          END AS retry_status
        FROM active_internal_owner owner
        INNER JOIN interaction_turns interrupted_turn
          ON interrupted_turn.user_id = owner.user_id
        INNER JOIN generation_commands command
          ON command.interaction_turn_id =
            interrupted_turn.interaction_turn_id
          AND command.user_id = interrupted_turn.user_id
        INNER JOIN conversation_events primary_event
          ON primary_event.interaction_turn_id =
            interrupted_turn.interaction_turn_id
          AND primary_event.user_id = interrupted_turn.user_id
          AND primary_event.actor = 'user'
        INNER JOIN daily_sessions session
          ON session.daily_session_id = interrupted_turn.daily_session_id
          AND session.user_id = interrupted_turn.user_id
        WHERE owner.user_id = $1
          AND interrupted_turn.status = 'interrupted'
          AND command.status = 'interrupted'
          AND command.authoritative_result_id IS NULL
        ORDER BY session.logical_date, primary_event.sequence_no
      `,
      [userId],
    );

    return result.rows.map((row) => ({
      logicalDate: row.logical_date,
      retryStatus: row.retry_status,
      sequence: Number(row.sequence_no),
      turnId: asInteractionTurnId(row.interaction_turn_id),
    }));
  }

  public async listUserTextMessages(
    userId: UserId,
  ): Promise<readonly UserTextMessage[]> {
    const result = await this.pool.query<{
      actor: "user" | "assistant";
      conversation_event_id: string;
      locale: string;
      logical_date: string;
      revision_id: string;
      sequence_no: string;
      text: string;
    }>(
      `
        SELECT
          event.actor,
          event.conversation_event_id,
          revision.locale,
          session.logical_date::text,
          revision.conversation_event_revision_id AS revision_id,
          event.sequence_no,
          revision.canonical_text AS text
        FROM active_internal_owner owner
        INNER JOIN conversation_events event
          ON event.user_id = owner.user_id
        INNER JOIN conversation_event_revisions revision
          ON revision.conversation_event_revision_id = event.current_revision_id
          AND revision.user_id = event.user_id
        INNER JOIN daily_sessions session
          ON session.daily_session_id = event.daily_session_id
          AND session.user_id = event.user_id
        WHERE owner.user_id = $1
          AND event.actor IN ('user', 'assistant')
          AND event.lifecycle_status = 'active'
          AND revision.content_purged_at IS NULL
        ORDER BY session.logical_date, event.sequence_no
      `,
      [userId],
    );

    return result.rows.map((row) => ({
      actor: row.actor,
      eventId: asConversationEventId(row.conversation_event_id),
      locale: row.locale,
      logicalDate: row.logical_date,
      revisionId: asConversationEventRevisionId(row.revision_id),
      sequence: Number(row.sequence_no),
      text: row.text,
    }));
  }

  private async recordRetryInTransaction(
    client: PoolClient,
    input: RecordConversationRetryInput,
  ): Promise<RecordConversationRetryRepositoryResult> {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");

    const owner = await client.query<{
      active: boolean;
      data_epoch: string;
      status: string;
    }>(
      `
        SELECT identity.active, owner.status, owner.data_epoch
        FROM app_users owner
        INNER JOIN internal_owner_identities identity
          ON identity.user_id = owner.user_id
          AND identity.owner_slot = 1
        WHERE owner.user_id = $1
        FOR UPDATE OF owner, identity
      `,
      [input.userId],
    );
    const ownerRow = owner.rows[0];
    if (ownerRow?.active !== true || ownerRow.status !== "active") {
      await client.query("ROLLBACK");
      return { outcome: "owner_denied" };
    }

    const intentKey = `conversation-retry/${input.retryRequestId}`;
    const existing = (
      await client.query<ExistingRetryRow>(
        `
          SELECT
            retry_turn.interaction_turn_id,
            retry_turn.retry_of_interaction_turn_id,
            retry_turn.turn_sequence_no,
            retry_turn.status,
            retry_action.conversation_event_id AS retry_action_event_id,
            command.generation_command_id,
            attempt.model_run_attempt_id
          FROM generation_commands command
          INNER JOIN interaction_turns retry_turn
            ON retry_turn.interaction_turn_id = command.interaction_turn_id
            AND retry_turn.user_id = command.user_id
          INNER JOIN conversation_events retry_action
            ON retry_action.interaction_turn_id =
              retry_turn.interaction_turn_id
            AND retry_action.user_id = retry_turn.user_id
            AND retry_action.actor = 'user'
            AND retry_action.event_type = 'retry_action'
          INNER JOIN model_run_attempts attempt
            ON attempt.generation_command_id =
              command.generation_command_id
            AND attempt.user_id = command.user_id
            AND attempt.attempt_no = 1
          WHERE command.user_id = $1
            AND command.intent_key = $2
          LIMIT 1
        `,
        [input.userId, intentKey],
      )
    ).rows[0];
    if (existing) {
      await client.query("COMMIT");
      if (existing.retry_of_interaction_turn_id !== input.originalTurnId) {
        return { outcome: "idempotency_conflict" };
      }
      return {
        outcome: "recorded",
        retry: mapRetry(existing, input.retryRequestId, true),
      };
    }

    const gate = evaluatePrivateWriteGate({
      evidence: await findLatestBackupPolicyEvidence(client),
      expectedConfigurationFingerprint: input.expectedConfigurationFingerprint,
      expectedPolicyVersion: input.expectedBackupPolicyVersion,
      now: input.now,
    });
    if (!gate.allowed) {
      await client.query("ROLLBACK");
      return {
        outcome: "write_denied",
        reason: asClosedGateReason(gate.reason),
      };
    }

    let source = (
      await client.query<OriginalRetrySourceRow>(
        `
          SELECT
            original_turn.interaction_turn_id AS original_turn_id,
            original_turn.status AS turn_status,
            original_command.status AS command_status,
            original_command.subject_id,
            original_command.input_revision_id,
            original_command.locale,
            session.daily_session_id,
            session.logical_date::text,
            session.timezone_at_start,
            session.activity_state,
            session.current_continuous_exchange_no,
            session.next_turn_sequence_no,
            session.next_event_sequence_no
          FROM interaction_turns original_turn
          INNER JOIN generation_commands original_command
            ON original_command.interaction_turn_id =
              original_turn.interaction_turn_id
            AND original_command.user_id = original_turn.user_id
          INNER JOIN daily_sessions session
            ON session.daily_session_id = original_turn.daily_session_id
            AND session.user_id = original_turn.user_id
          WHERE original_turn.interaction_turn_id = $1
            AND original_turn.user_id = $2
            AND original_command.authoritative_result_id IS NULL
          FOR UPDATE OF original_turn, original_command, session
        `,
        [input.originalTurnId, input.userId],
      )
    ).rows[0];
    if (
      !source ||
      source.turn_status !== "interrupted" ||
      source.command_status !== "interrupted" ||
      source.activity_state === "finalized"
    ) {
      await client.query("ROLLBACK");
      return { outcome: "retry_not_allowed" };
    }

    if (source.activity_state === "quiescent") {
      source = (
        await client.query<OriginalRetrySourceRow>(
          `
            UPDATE daily_sessions
            SET
              activity_state = 'active',
              current_continuous_exchange_no =
                current_continuous_exchange_no + 1,
              updated_at = $1
            WHERE daily_session_id = $2
              AND user_id = $3
              AND activity_state = 'quiescent'
            RETURNING
              $4::uuid AS original_turn_id,
              'interrupted'::text AS turn_status,
              'interrupted'::text AS command_status,
              $5::uuid AS subject_id,
              $6::uuid AS input_revision_id,
              $7::text AS locale,
              daily_session_id,
              logical_date::text,
              timezone_at_start,
              activity_state,
              current_continuous_exchange_no,
              next_turn_sequence_no,
              next_event_sequence_no
          `,
          [
            input.now,
            source.daily_session_id,
            input.userId,
            source.original_turn_id,
            source.subject_id,
            source.input_revision_id,
            source.locale,
          ],
        )
      ).rows[0];
      if (!source) {
        throw new Error("The Retry Daily Session reactivation failed.");
      }
    }

    const interactionTurnId = createUuidV7(input.now);
    const retryActionEventId = createUuidV7(input.now);
    const generationCommandId = createUuidV7(input.now);
    const modelRunAttemptId = createUuidV7(input.now);
    const turnSequence = Number(source.next_turn_sequence_no);
    const eventSequence = Number(source.next_event_sequence_no);
    const clientRetryKey = `conversation-retry/${input.retryRequestId}`;

    await client.query(
      `
        INSERT INTO interaction_turns (
          interaction_turn_id,
          user_id,
          daily_session_id,
          client_turn_id,
          turn_sequence_no,
          continuous_exchange_no,
          status,
          retry_of_interaction_turn_id,
          started_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $8, $8)
      `,
      [
        interactionTurnId,
        input.userId,
        source.daily_session_id,
        clientRetryKey,
        turnSequence,
        source.current_continuous_exchange_no,
        input.originalTurnId,
        input.now,
      ],
    );
    await client.query(
      `
        INSERT INTO conversation_events (
          conversation_event_id,
          user_id,
          daily_session_id,
          interaction_turn_id,
          sequence_no,
          client_event_id,
          actor,
          channel,
          event_type,
          lifecycle_status,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'user', 'text', 'retry_action', 'active', $7)
      `,
      [
        retryActionEventId,
        input.userId,
        source.daily_session_id,
        interactionTurnId,
        eventSequence,
        clientRetryKey,
        input.now,
      ],
    );
    await client.query(
      `
        INSERT INTO generation_commands (
          generation_command_id,
          user_id,
          interaction_turn_id,
          operation_type,
          intent_key,
          subject_type,
          subject_id,
          input_revision_kind,
          input_revision_id,
          prompt_version,
          product_policy_version,
          safety_policy_version,
          relationship_policy_version,
          locale_policy_version,
          locale,
          provider,
          model,
          model_snapshot,
          model_config_version,
          provider_policy_version,
          consent_policy_version,
          freshness_policy,
          expected_data_epoch,
          status,
          created_at
        )
        VALUES (
          $1, $2, $3, 'conversation.text', $4, 'conversation_event', $5,
          'conversation_event_revision', $6, $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19, $20, 'prepared', $21
        )
      `,
      [
        generationCommandId,
        input.userId,
        interactionTurnId,
        intentKey,
        source.subject_id,
        source.input_revision_id,
        input.generationPolicy.promptVersion,
        input.generationPolicy.productPolicyVersion,
        input.generationPolicy.safetyPolicyVersion,
        input.generationPolicy.relationshipPolicyVersion,
        input.generationPolicy.localePolicyVersion,
        source.locale,
        input.generationPolicy.provider,
        input.generationPolicy.model,
        input.generationPolicy.modelSnapshot,
        input.generationPolicy.modelConfigVersion,
        input.generationPolicy.providerPolicyVersion,
        input.generationPolicy.consentPolicyVersion,
        input.generationPolicy.freshnessPolicy,
        ownerRow.data_epoch,
        input.now,
      ],
    );
    await client.query(
      `
        INSERT INTO model_run_attempts (
          model_run_attempt_id,
          user_id,
          generation_command_id,
          attempt_no,
          operation_type,
          provider,
          model,
          model_snapshot,
          prompt_version,
          status,
          created_at
        )
        VALUES (
          $1, $2, $3, 1, 'conversation.text', $4, $5, $6, $7, 'prepared', $8
        )
      `,
      [
        modelRunAttemptId,
        input.userId,
        generationCommandId,
        input.generationPolicy.provider,
        input.generationPolicy.model,
        input.generationPolicy.modelSnapshot,
        input.generationPolicy.promptVersion,
        input.now,
      ],
    );
    await client.query(
      `
        UPDATE daily_sessions
        SET
          next_turn_sequence_no = next_turn_sequence_no + 1,
          next_event_sequence_no = next_event_sequence_no + 1,
          last_activity_at = $1,
          updated_at = $1
        WHERE daily_session_id = $2
          AND user_id = $3
      `,
      [input.now, source.daily_session_id, input.userId],
    );
    await client.query("COMMIT");

    return {
      outcome: "recorded",
      retry: {
        generation: {
          attemptId: asModelRunAttemptId(modelRunAttemptId),
          commandId: asGenerationCommandId(generationCommandId),
        },
        originalTurnId: input.originalTurnId,
        replayed: false,
        retryActionEventId: asConversationEventId(retryActionEventId),
        retryRequestId: input.retryRequestId,
        turn: {
          id: asInteractionTurnId(interactionTurnId),
          sequence: turnSequence,
          status: "open",
        },
      },
    };
  }

  private async recordInTransaction(
    client: PoolClient,
    input: RecordUserTextTurnInput,
  ): Promise<RecordUserTextTurnRepositoryResult> {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");

    const owner = await client.query<{
      active: boolean;
      data_epoch: string;
      status: string;
    }>(
      `
        SELECT identity.active, owner.status, owner.data_epoch
        FROM app_users owner
        INNER JOIN internal_owner_identities identity
          ON identity.user_id = owner.user_id
          AND identity.owner_slot = 1
        WHERE owner.user_id = $1
        FOR UPDATE OF owner, identity
      `,
      [input.userId],
    );
    const ownerRow = owner.rows[0];
    if (ownerRow?.active !== true || ownerRow.status !== "active") {
      await client.query("ROLLBACK");
      return { outcome: "owner_denied" };
    }

    const existing = await findExistingTurns(client, input);
    if (existing.length > 1) {
      await client.query("COMMIT");
      return { outcome: "idempotency_conflict" };
    }
    if (existing[0]) {
      if (
        !existing[0].generation_command_id ||
        !existing[0].model_run_attempt_id
      ) {
        const gate = evaluatePrivateWriteGate({
          evidence: await findLatestBackupPolicyEvidence(client),
          expectedConfigurationFingerprint:
            input.expectedConfigurationFingerprint,
          expectedPolicyVersion: input.expectedBackupPolicyVersion,
          now: input.now,
        });
        if (!gate.allowed) {
          await client.query("ROLLBACK");
          return {
            outcome: "write_denied",
            reason: asClosedGateReason(gate.reason),
          };
        }
      }
      const existingTurn =
        existing[0].generation_command_id &&
        existing[0].model_run_attempt_id
          ? existing[0]
          : await addGenerationToLegacyTurn(
              client,
              input,
              ownerRow.data_epoch,
              existing[0],
            );
      await client.query("COMMIT");
      return {
        outcome: "recorded",
        turn: mapTurn(existingTurn, true),
      };
    }

    const gate = evaluatePrivateWriteGate({
      evidence: await findLatestBackupPolicyEvidence(client),
      expectedConfigurationFingerprint: input.expectedConfigurationFingerprint,
      expectedPolicyVersion: input.expectedBackupPolicyVersion,
      now: input.now,
    });
    if (!gate.allowed) {
      await client.query("ROLLBACK");
      return {
        outcome: "write_denied",
        reason: asClosedGateReason(gate.reason),
      };
    }

    let currentSession = (
      await client.query<DailySessionRow>(
        `
          SELECT
            daily_session_id,
            logical_date::text,
            timezone_at_start,
            activity_state,
            current_continuous_exchange_no,
            next_turn_sequence_no,
            next_event_sequence_no
          FROM daily_sessions
          WHERE user_id = $1
            AND activity_state = 'active'
          ORDER BY started_at DESC, daily_session_id DESC
          LIMIT 1
          FOR UPDATE
        `,
        [input.userId],
      )
    ).rows[0];

    if (!currentSession) {
      await client.query(
      `
        INSERT INTO daily_sessions (
          daily_session_id,
          user_id,
          logical_date,
          timezone_at_start,
          started_at,
          last_activity_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $5, $5, $5)
        ON CONFLICT (user_id, logical_date) DO NOTHING
      `,
        [
          createUuidV7(input.now),
          input.userId,
          input.logicalDate,
          input.timezone,
          input.now,
        ],
      );
      currentSession = (
        await client.query<DailySessionRow>(
          `
            SELECT
              daily_session_id,
              logical_date::text,
              timezone_at_start,
              activity_state,
              current_continuous_exchange_no,
              next_turn_sequence_no,
              next_event_sequence_no
            FROM daily_sessions
            WHERE user_id = $1
              AND logical_date = $2
            FOR UPDATE
          `,
          [input.userId, input.logicalDate],
        )
      ).rows[0];
    }
    if (!currentSession) {
      throw new Error("The Daily Session could not be established.");
    }
    if (currentSession.activity_state === "finalized") {
      throw new Error("A finalized Daily Session cannot accept a new User Event.");
    }
    if (currentSession.activity_state === "quiescent") {
      currentSession = (
        await client.query<DailySessionRow>(
          `
            UPDATE daily_sessions
            SET
              activity_state = 'active',
              current_continuous_exchange_no =
                current_continuous_exchange_no + 1,
              updated_at = $1
            WHERE daily_session_id = $2
              AND user_id = $3
              AND activity_state = 'quiescent'
            RETURNING
              daily_session_id,
              logical_date::text,
              timezone_at_start,
              activity_state,
              current_continuous_exchange_no,
              next_turn_sequence_no,
              next_event_sequence_no
          `,
          [input.now, currentSession.daily_session_id, input.userId],
        )
      ).rows[0];
      if (!currentSession) {
        throw new Error("The Daily Session reactivation compare-and-set failed.");
      }
    }

    const interactionTurnId = createUuidV7(input.now);
    const conversationEventId = createUuidV7(input.now);
    const revisionId = createUuidV7(input.now);
    const generationCommandId = createUuidV7(input.now);
    const modelRunAttemptId = createUuidV7(input.now);
    const turnSequence = Number(currentSession.next_turn_sequence_no);
    const eventSequence = Number(currentSession.next_event_sequence_no);

    await client.query(
      `
        INSERT INTO interaction_turns (
          interaction_turn_id,
          user_id,
          daily_session_id,
          client_turn_id,
          turn_sequence_no,
          continuous_exchange_no,
          status,
          started_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $7, $7)
      `,
      [
        interactionTurnId,
        input.userId,
        currentSession.daily_session_id,
        input.clientTurnId,
        turnSequence,
        currentSession.current_continuous_exchange_no,
        input.now,
      ],
    );
    await client.query(
      `
        INSERT INTO conversation_events (
          conversation_event_id,
          user_id,
          daily_session_id,
          interaction_turn_id,
          sequence_no,
          client_event_id,
          actor,
          channel,
          event_type,
          lifecycle_status,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'user', 'text', 'message', 'active', $7)
      `,
      [
        conversationEventId,
        input.userId,
        currentSession.daily_session_id,
        interactionTurnId,
        eventSequence,
        input.clientEventId,
        input.now,
      ],
    );
    await client.query(
      `
        INSERT INTO conversation_event_revisions (
          conversation_event_revision_id,
          user_id,
          conversation_event_id,
          revision,
          locale,
          canonical_text,
          transcript_status,
          created_by,
          created_at
        )
        VALUES ($1, $2, $3, 1, $4, $5, 'final', 'client', $6)
      `,
      [
        revisionId,
        input.userId,
        conversationEventId,
        input.locale,
        input.text,
        input.now,
      ],
    );
    const currentRevision = await client.query(
      `
        UPDATE conversation_events
        SET current_revision_id = $1
        WHERE conversation_event_id = $2
          AND user_id = $3
          AND current_revision_id IS NULL
      `,
      [revisionId, conversationEventId, input.userId],
    );
    if (currentRevision.rowCount !== 1) {
      throw new Error("The User Event current Revision compare-and-set failed.");
    }
    await client.query(
      `
        INSERT INTO generation_commands (
          generation_command_id,
          user_id,
          interaction_turn_id,
          operation_type,
          intent_key,
          subject_type,
          subject_id,
          input_revision_kind,
          input_revision_id,
          prompt_version,
          product_policy_version,
          safety_policy_version,
          relationship_policy_version,
          locale_policy_version,
          locale,
          provider,
          model,
          model_snapshot,
          model_config_version,
          provider_policy_version,
          consent_policy_version,
          freshness_policy,
          expected_data_epoch,
          status,
          created_at
        )
        VALUES (
          $1, $2, $3, 'conversation.text', $4, 'conversation_event', $5,
          'conversation_event_revision', $6, $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19, $20, 'prepared', $21
        )
      `,
      [
        generationCommandId,
        input.userId,
        interactionTurnId,
        `conversation-response/${conversationEventId}`,
        conversationEventId,
        revisionId,
        input.generationPolicy.promptVersion,
        input.generationPolicy.productPolicyVersion,
        input.generationPolicy.safetyPolicyVersion,
        input.generationPolicy.relationshipPolicyVersion,
        input.generationPolicy.localePolicyVersion,
        input.locale,
        input.generationPolicy.provider,
        input.generationPolicy.model,
        input.generationPolicy.modelSnapshot,
        input.generationPolicy.modelConfigVersion,
        input.generationPolicy.providerPolicyVersion,
        input.generationPolicy.consentPolicyVersion,
        input.generationPolicy.freshnessPolicy,
        ownerRow.data_epoch,
        input.now,
      ],
    );
    await client.query(
      `
        INSERT INTO model_run_attempts (
          model_run_attempt_id,
          user_id,
          generation_command_id,
          attempt_no,
          operation_type,
          provider,
          model,
          model_snapshot,
          prompt_version,
          status,
          created_at
        )
        VALUES (
          $1, $2, $3, 1, 'conversation.text', $4, $5, $6, $7, 'prepared', $8
        )
      `,
      [
        modelRunAttemptId,
        input.userId,
        generationCommandId,
        input.generationPolicy.provider,
        input.generationPolicy.model,
        input.generationPolicy.modelSnapshot,
        input.generationPolicy.promptVersion,
        input.now,
      ],
    );
    await client.query(
      `
        UPDATE daily_sessions
        SET
          next_turn_sequence_no = next_turn_sequence_no + 1,
          next_event_sequence_no = next_event_sequence_no + 1,
          dialogue_revision = dialogue_revision + 1,
          source_revision = source_revision + 1,
          last_activity_at = $1,
          updated_at = $1
        WHERE daily_session_id = $2
          AND user_id = $3
      `,
      [input.now, currentSession.daily_session_id, input.userId],
    );
    await client.query("COMMIT");

    return {
      outcome: "recorded",
      turn: {
        dailySession: {
          id: asDailySessionId(currentSession.daily_session_id),
          logicalDate: currentSession.logical_date,
          timezoneAtStart: currentSession.timezone_at_start,
        },
        message: {
          id: asConversationEventId(conversationEventId),
          locale: input.locale,
          revisionId: asConversationEventRevisionId(revisionId),
          sequence: eventSequence,
          text: input.text,
        },
        generation: {
          attemptId: asModelRunAttemptId(modelRunAttemptId),
          commandId: asGenerationCommandId(generationCommandId),
        },
        replayed: false,
        turn: {
          id: asInteractionTurnId(interactionTurnId),
          sequence: turnSequence,
          status: "open",
        },
      },
    };
  }
}

async function findExistingTurns(
  client: PoolClient,
  input: Pick<
    RecordUserTextTurnInput,
    "clientEventId" | "clientTurnId" | "userId"
  >,
): Promise<readonly ExistingTurnRow[]> {
  const result = await client.query<ExistingTurnRow>(
    `
      SELECT
        session.daily_session_id,
        session.logical_date::text,
        session.timezone_at_start,
        turn.interaction_turn_id,
        turn.client_turn_id,
        turn.turn_sequence_no,
        turn.status,
        command.generation_command_id,
        attempt.model_run_attempt_id,
        event.conversation_event_id,
        event.client_event_id,
        event.sequence_no,
        revision.conversation_event_revision_id AS revision_id,
        revision.locale,
        revision.canonical_text AS text
      FROM interaction_turns turn
      INNER JOIN daily_sessions session
        ON session.daily_session_id = turn.daily_session_id
        AND session.user_id = turn.user_id
      INNER JOIN conversation_events event
        ON event.interaction_turn_id = turn.interaction_turn_id
        AND event.user_id = turn.user_id
        AND event.actor = 'user'
      LEFT JOIN generation_commands command
        ON command.interaction_turn_id = turn.interaction_turn_id
        AND command.user_id = turn.user_id
      LEFT JOIN model_run_attempts attempt
        ON attempt.generation_command_id = command.generation_command_id
        AND attempt.user_id = command.user_id
        AND attempt.attempt_no = 1
      INNER JOIN conversation_event_revisions revision
        ON revision.conversation_event_revision_id = event.current_revision_id
        AND revision.user_id = event.user_id
      WHERE turn.user_id = $1
        AND (
          turn.client_turn_id = $2
          OR event.client_event_id = $3
        )
      ORDER BY turn.interaction_turn_id
      LIMIT 2
    `,
    [input.userId, input.clientTurnId, input.clientEventId],
  );
  return result.rows;
}

function mapTurn(row: ExistingTurnRow, replayed: boolean): UserTextTurn {
  if (!row.generation_command_id || !row.model_run_attempt_id) {
    throw new Error("The User Turn has no Generation identity.");
  }
  return {
    dailySession: {
      id: asDailySessionId(row.daily_session_id),
      logicalDate: row.logical_date,
      timezoneAtStart: row.timezone_at_start,
    },
    message: {
      id: asConversationEventId(row.conversation_event_id),
      locale: row.locale,
      revisionId: asConversationEventRevisionId(row.revision_id),
      sequence: Number(row.sequence_no),
      text: row.text,
    },
    generation: {
      attemptId: asModelRunAttemptId(row.model_run_attempt_id),
      commandId: asGenerationCommandId(row.generation_command_id),
    },
    replayed,
    turn: {
      id: asInteractionTurnId(row.interaction_turn_id),
      sequence: Number(row.turn_sequence_no),
      status: row.status,
    },
  };
}

function mapRetry(
  row: ExistingRetryRow,
  retryRequestId: RecordConversationRetryInput["retryRequestId"],
  replayed: boolean,
): ConversationRetryTurn {
  return {
    generation: {
      attemptId: asModelRunAttemptId(row.model_run_attempt_id),
      commandId: asGenerationCommandId(row.generation_command_id),
    },
    originalTurnId: asInteractionTurnId(
      row.retry_of_interaction_turn_id,
    ),
    replayed,
    retryActionEventId: asConversationEventId(row.retry_action_event_id),
    retryRequestId,
    turn: {
      id: asInteractionTurnId(row.interaction_turn_id),
      sequence: Number(row.turn_sequence_no),
      status: row.status,
    },
  };
}

async function addGenerationToLegacyTurn(
  client: PoolClient,
  input: RecordUserTextTurnInput,
  expectedDataEpoch: string,
  row: ExistingTurnRow,
): Promise<ExistingTurnRow> {
  if (row.generation_command_id || row.model_run_attempt_id) {
    throw new Error("The legacy User Turn has partial Generation identity.");
  }
  const generationCommandId = createUuidV7(input.now);
  const modelRunAttemptId = createUuidV7(input.now);
  await client.query(
    `
      INSERT INTO generation_commands (
        generation_command_id,
        user_id,
        interaction_turn_id,
        operation_type,
        intent_key,
        subject_type,
        subject_id,
        input_revision_kind,
        input_revision_id,
        prompt_version,
        product_policy_version,
        safety_policy_version,
        relationship_policy_version,
        locale_policy_version,
        locale,
        provider,
        model,
        model_snapshot,
        model_config_version,
        provider_policy_version,
        consent_policy_version,
        freshness_policy,
        expected_data_epoch,
        status,
        created_at
      )
      VALUES (
        $1, $2, $3, 'conversation.text', $4, 'conversation_event', $5,
        'conversation_event_revision', $6, $7, $8, $9, $10, $11, $12,
        $13, $14, $15, $16, $17, $18, $19, $20, 'prepared', $21
      )
    `,
    [
      generationCommandId,
      input.userId,
      row.interaction_turn_id,
      `conversation-response/${row.conversation_event_id}`,
      row.conversation_event_id,
      row.revision_id,
      input.generationPolicy.promptVersion,
      input.generationPolicy.productPolicyVersion,
      input.generationPolicy.safetyPolicyVersion,
      input.generationPolicy.relationshipPolicyVersion,
      input.generationPolicy.localePolicyVersion,
      row.locale,
      input.generationPolicy.provider,
      input.generationPolicy.model,
      input.generationPolicy.modelSnapshot,
      input.generationPolicy.modelConfigVersion,
      input.generationPolicy.providerPolicyVersion,
      input.generationPolicy.consentPolicyVersion,
      input.generationPolicy.freshnessPolicy,
      expectedDataEpoch,
      input.now,
    ],
  );
  await client.query(
    `
      INSERT INTO model_run_attempts (
        model_run_attempt_id,
        user_id,
        generation_command_id,
        attempt_no,
        operation_type,
        provider,
        model,
        model_snapshot,
        prompt_version,
        status,
        created_at
      )
      VALUES (
        $1, $2, $3, 1, 'conversation.text', $4, $5, $6, $7, 'prepared', $8
      )
    `,
    [
      modelRunAttemptId,
      input.userId,
      generationCommandId,
      input.generationPolicy.provider,
      input.generationPolicy.model,
      input.generationPolicy.modelSnapshot,
      input.generationPolicy.promptVersion,
      input.now,
    ],
  );
  return {
    ...row,
    generation_command_id: generationCommandId,
    model_run_attempt_id: modelRunAttemptId,
  };
}

function asClosedGateReason(
  reason: PrivateWriteGateReason,
): Exclude<PrivateWriteGateReason, "backup_evidence_current"> {
  if (reason === "backup_evidence_current") {
    throw new Error("An allowed private-write gate cannot be treated as closed.");
  }
  return reason;
}

function isRetryableTransactionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    retryableTransactionCodes.has(error.code)
  );
}

function isRetryRecordRace(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}

async function delayWithJitter(attempt: number): Promise<void> {
  const maximumDelayMs = 10 * 2 ** (attempt - 1);
  const delayMs = Math.floor(Math.random() * maximumDelayMs);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
