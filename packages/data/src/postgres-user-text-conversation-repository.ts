import type {
  ConversationDateEntry,
  ConversationRetryTurn,
  ConversationSessionRef,
  CurrentConversationIdentity,
  InterruptedConversationResponse,
  InteractionTurnStatus,
  InactivityPolicy,
  RecordConversationRetryInput,
  RecordConversationRetryRepositoryResult,
  RecordUserTextTurnInput,
  RecordUserTextTurnRepositoryResult,
  UserTextConversationRepository,
  UserTextMessage,
  UserTextTurn,
} from "@sayhear/application";
import { resolveLocalePackVersion } from "@sayhear/application";
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
  created_at: Date;
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
  closure_policy_version: string;
  current_continuous_exchange_no: number;
  daily_session_id: string;
  logical_date: string;
  next_event_sequence_no: string;
  next_turn_sequence_no: string;
  timezone_at_start: string;
}>;

type CurrentConversationRow = Readonly<{
  activity_state: string;
  daily_session_id: string;
  logical_date: string;
  started_at: Date;
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

  public async correctUserEvent(input: { eventId: import("@sayhear/domain").ConversationEventId; locale: string; now: Date; text: string; userId: UserId; fastPathExtractionPolicyVersion: string | null }): Promise<{ dailySessionId: import("@sayhear/domain").DailySessionId } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const event = await client.query<{ conversation_event_id: string; daily_session_id: string; revision: number; current_revision_id: string | null; data_epoch: string }>(
        `SELECT event.conversation_event_id, event.daily_session_id,
            revision.revision, event.current_revision_id, owner.data_epoch::text
         FROM conversation_events event
         INNER JOIN conversation_event_revisions revision
           ON revision.conversation_event_revision_id = event.current_revision_id
         INNER JOIN app_users owner ON owner.user_id = event.user_id
         INNER JOIN daily_sessions session
           ON session.daily_session_id = event.daily_session_id
           AND session.user_id = event.user_id
         WHERE event.conversation_event_id = $1 AND event.user_id = $2
           AND event.actor = 'user' AND event.lifecycle_status = 'active'
           AND revision.content_purged_at IS NULL AND owner.status = 'active'
         FOR UPDATE OF session, owner, event, revision`, [input.eventId, input.userId],
      );
      const row = event.rows[0];
      if (!row) { await client.query("ROLLBACK"); return null; }
      const revisionId = createUuidV7(input.now);
      await client.query(
        `INSERT INTO conversation_event_revisions (
           conversation_event_revision_id, user_id, conversation_event_id, revision,
           locale, canonical_text, transcript_status, created_by, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'corrected', 'user_correction', $7)`,
        [revisionId, input.userId, row.conversation_event_id, row.revision + 1, input.locale, input.text, input.now],
      );
      const updated = await client.query(
        `UPDATE conversation_events SET current_revision_id = $1
         WHERE conversation_event_id = $2 AND user_id = $3`,
        [revisionId, row.conversation_event_id, input.userId],
      );
      if (updated.rowCount !== 1) throw new Error("The User Event correction compare-and-set failed.");
      // Fast path (issue #113): a correction produces a new revision and a new
      // command, and retires the old revision's derivatives in the same
      // transaction — old extraction outputs stop serving session-local
      // context immediately.
      if (row.current_revision_id !== null) {
        await retireFastPathDerivatives(client, {
          userId: input.userId,
          retiredRevisionId: row.current_revision_id,
          now: input.now,
        });
      }
      await insertFastPathExtractionCommand(client, {
        userId: input.userId,
        revisionId,
        revisionOrdinal: row.revision + 1,
        policyVersion: input.fastPathExtractionPolicyVersion,
        dataEpoch: row.data_epoch,
        now: input.now,
      });
      await client.query("COMMIT");
      return { dailySessionId: asDailySessionId(row.daily_session_id) };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  public async endContinuousExchangeExplicitly(
    input: Parameters<
      UserTextConversationRepository["endContinuousExchangeExplicitly"]
    >[0],
  ): ReturnType<
    UserTextConversationRepository["endContinuousExchangeExplicitly"]
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ended = await client.query<{
        current_continuous_exchange_no: number;
        daily_session_id: string;
      }>(
        `
          UPDATE daily_sessions
          SET
            activity_state = 'quiescent',
            quiescent_at = $1,
            quiescent_reason = 'explicit_user_end',
            updated_at = $1
          WHERE daily_session_id = $2
            AND user_id = $3
            AND activity_state = 'active'
          RETURNING daily_session_id, current_continuous_exchange_no
        `,
        [input.endedAt, input.dailySessionId, input.userId],
      );
      const endedRow = ended.rows[0];
      if (endedRow) {
        await client.query(
          `
            UPDATE continuous_exchange_inactivity_evaluations
            SET evaluated_at = $1, outcome = 'not_active'
            WHERE daily_session_id = $2
              AND user_id = $3
              AND continuous_exchange_no = $4
              AND outcome IS NULL
          `,
          [
            input.endedAt,
            endedRow.daily_session_id,
            input.userId,
            endedRow.current_continuous_exchange_no,
          ],
        );
        await client.query("COMMIT");
        return {
          end: {
            dailySessionId: asDailySessionId(endedRow.daily_session_id),
            endedBy: "explicit_user_end",
            replayed: false,
            state: "quiescent",
          },
          outcome: "ended",
        };
      }

      const existing = await client.query<{
        activity_state: string;
        daily_session_id: string;
        quiescent_reason: string | null;
      }>(
        `
          SELECT daily_session_id, activity_state, quiescent_reason
          FROM daily_sessions
          WHERE daily_session_id = $1
            AND user_id = $2
          FOR UPDATE
        `,
        [input.dailySessionId, input.userId],
      );
      const existingRow = existing.rows[0];
      if (
        existingRow?.activity_state !== "quiescent" ||
        existingRow.quiescent_reason !== "explicit_user_end"
      ) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      await client.query("COMMIT");
      return {
        end: {
          dailySessionId: asDailySessionId(existingRow.daily_session_id),
          endedBy: "explicit_user_end",
          replayed: true,
          state: "quiescent",
        },
        outcome: "ended",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

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
      created_at: Date;
      generation_command_id: string | null;
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
          event.created_at,
          event.generation_command_id,
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
      createdAt: row.created_at.toISOString(),
      eventId: asConversationEventId(row.conversation_event_id),
      generationCommandId: row.generation_command_id
        ? asGenerationCommandId(row.generation_command_id)
        : null,
      locale: row.locale,
      logicalDate: row.logical_date,
      revisionId: asConversationEventRevisionId(row.revision_id),
      sequence: Number(row.sequence_no),
      text: row.text,
    }));
  }

  public async findCurrentWritableConversation(
    userId: UserId,
  ): Promise<CurrentConversationIdentity | null> {
    const result = await this.pool.query<CurrentConversationRow>(
      `
        SELECT
          session.daily_session_id,
          session.logical_date::text,
          session.timezone_at_start,
          session.activity_state,
          session.started_at
        FROM active_internal_owner owner
        INNER JOIN daily_sessions session
          ON session.user_id = owner.user_id
        WHERE owner.user_id = $1
          AND session.activity_state = 'active'
        ORDER BY session.started_at DESC, session.daily_session_id DESC
        LIMIT 1
      `,
      [userId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      activityState: "active",
      dailySessionId: asDailySessionId(row.daily_session_id),
      logicalDate: row.logical_date,
      startedAt: row.started_at,
      timezoneAtStart: row.timezone_at_start,
    };
  }

  public async listInterruptedResponsesForSession(input: {
    dailySessionId: import("@sayhear/domain").DailySessionId;
    userId: UserId;
  }): Promise<readonly InterruptedConversationResponse[]> {
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
          AND interrupted_turn.daily_session_id = $2
          AND interrupted_turn.status = 'interrupted'
          AND command.status = 'interrupted'
          AND command.authoritative_result_id IS NULL
        ORDER BY session.logical_date, primary_event.sequence_no
      `,
      [input.userId, input.dailySessionId],
    );

    return result.rows.map((row) => ({
      logicalDate: row.logical_date,
      retryStatus: row.retry_status,
      sequence: Number(row.sequence_no),
      turnId: asInteractionTurnId(row.interaction_turn_id),
    }));
  }

  public async listRecentUserTextMessages(input: {
    dailySessionId: import("@sayhear/domain").DailySessionId;
    limit: number;
    userId: UserId;
  }): Promise<readonly UserTextMessage[]> {
    const result = await this.pool.query<{
      actor: "user" | "assistant";
      conversation_event_id: string;
      created_at: Date;
      generation_command_id: string | null;
      locale: string;
      logical_date: string;
      revision_id: string;
      sequence_no: string;
      text: string;
    }>(
      `
        SELECT
          recent.actor,
          recent.conversation_event_id,
          recent.created_at,
          recent.generation_command_id,
          recent.locale,
          recent.logical_date,
          recent.revision_id,
          recent.sequence_no,
          recent.text
        FROM (
          SELECT
            event.actor,
            event.conversation_event_id,
            event.created_at,
            event.generation_command_id,
            revision.locale,
            session.logical_date::text AS logical_date,
            revision.conversation_event_revision_id AS revision_id,
            event.sequence_no,
            revision.canonical_text AS text
          FROM active_internal_owner owner
          INNER JOIN conversation_events event
            ON event.user_id = owner.user_id
          INNER JOIN conversation_event_revisions revision
            ON revision.conversation_event_revision_id =
              event.current_revision_id
            AND revision.user_id = event.user_id
          INNER JOIN daily_sessions session
            ON session.daily_session_id = event.daily_session_id
            AND session.user_id = event.user_id
          WHERE owner.user_id = $1
            AND event.daily_session_id = $2
            AND event.actor IN ('user', 'assistant')
            AND event.lifecycle_status = 'active'
            AND revision.content_purged_at IS NULL
          ORDER BY event.sequence_no DESC
          LIMIT $3
        ) recent
        ORDER BY recent.sequence_no ASC
      `,
      [input.userId, input.dailySessionId, input.limit],
    );

    return result.rows.map((row) => ({
      actor: row.actor,
      createdAt: row.created_at.toISOString(),
      eventId: asConversationEventId(row.conversation_event_id),
      generationCommandId: row.generation_command_id
        ? asGenerationCommandId(row.generation_command_id)
        : null,
      locale: row.locale,
      logicalDate: row.logical_date,
      revisionId: asConversationEventRevisionId(row.revision_id),
      sequence: Number(row.sequence_no),
      text: row.text,
    }));
  }

  public async findConversationSessionByDate(input: {
    logicalDate: string;
    userId: UserId;
  }): Promise<ConversationSessionRef | null> {
    const result = await this.pool.query<{
      daily_session_id: string;
      logical_date: string;
    }>(
      `
        SELECT
          session.daily_session_id,
          session.logical_date::text
        FROM active_internal_owner owner
        INNER JOIN daily_sessions session
          ON session.user_id = owner.user_id
        WHERE owner.user_id = $1
          AND session.logical_date = $2::date
        LIMIT 1
      `,
      [input.userId, input.logicalDate],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      dailySessionId: asDailySessionId(row.daily_session_id),
      logicalDate: row.logical_date,
    };
  }

  public async findConversationSessionById(input: {
    dailySessionId: import("@sayhear/domain").DailySessionId;
    userId: UserId;
  }): Promise<ConversationSessionRef | null> {
    const result = await this.pool.query<{
      daily_session_id: string;
      logical_date: string;
    }>(
      `
        SELECT
          session.daily_session_id,
          session.logical_date::text
        FROM active_internal_owner owner
        INNER JOIN daily_sessions session
          ON session.user_id = owner.user_id
        WHERE owner.user_id = $1
          AND session.daily_session_id = $2
        LIMIT 1
      `,
      [input.userId, input.dailySessionId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      dailySessionId: asDailySessionId(row.daily_session_id),
      logicalDate: row.logical_date,
    };
  }

  public async listConversationDates(input: {
    beforeDailySessionId: import("@sayhear/domain").DailySessionId | null;
    beforeLogicalDate: string | null;
    limit: number;
    userId: UserId;
  }): Promise<
    Readonly<{ entries: readonly ConversationDateEntry[]; hasMore: boolean }>
  > {
    const result = await this.pool.query<{
      daily_session_id: string;
      logical_date: string;
    }>(
      `
        SELECT
          session.daily_session_id,
          session.logical_date::text
        FROM active_internal_owner owner
        INNER JOIN daily_sessions session
          ON session.user_id = owner.user_id
        WHERE owner.user_id = $1
          AND session.activity_state <> 'active'
          AND (
            $2::date IS NULL
            OR (session.logical_date, session.daily_session_id)
              < ($2::date, $3::uuid)
          )
        ORDER BY session.logical_date DESC, session.daily_session_id DESC
        LIMIT $4
      `,
      [
        input.userId,
        input.beforeLogicalDate,
        input.beforeDailySessionId,
        input.limit + 1,
      ],
    );
    const hasMore = result.rows.length > input.limit;
    return {
      entries: result.rows.slice(0, input.limit).map((row) => ({
        dailySessionId: asDailySessionId(row.daily_session_id),
        logicalDate: row.logical_date,
      })),
      hasMore,
    };
  }

  public async listOlderUserTextMessages(input: {
    beforeSequence: number;
    dailySessionId: import("@sayhear/domain").DailySessionId;
    limit: number;
    userId: UserId;
  }): Promise<
    Readonly<{ hasMore: boolean; messages: readonly UserTextMessage[] }>
  > {
    const result = await this.pool.query<{
      actor: "user" | "assistant";
      conversation_event_id: string;
      created_at: Date;
      generation_command_id: string | null;
      locale: string;
      logical_date: string;
      revision_id: string;
      sequence_no: string;
      text: string;
    }>(
      `
        SELECT
          recent.actor,
          recent.conversation_event_id,
          recent.created_at,
          recent.generation_command_id,
          recent.locale,
          recent.logical_date,
          recent.revision_id,
          recent.sequence_no,
          recent.text
        FROM (
          SELECT
            event.actor,
            event.conversation_event_id,
            event.created_at,
            event.generation_command_id,
            revision.locale,
            session.logical_date::text AS logical_date,
            revision.conversation_event_revision_id AS revision_id,
            event.sequence_no,
            revision.canonical_text AS text
          FROM active_internal_owner owner
          INNER JOIN conversation_events event
            ON event.user_id = owner.user_id
          INNER JOIN conversation_event_revisions revision
            ON revision.conversation_event_revision_id =
              event.current_revision_id
            AND revision.user_id = event.user_id
          INNER JOIN daily_sessions session
            ON session.daily_session_id = event.daily_session_id
            AND session.user_id = event.user_id
          WHERE owner.user_id = $1
            AND event.daily_session_id = $2
            AND event.actor IN ('user', 'assistant')
            AND event.lifecycle_status = 'active'
            AND revision.content_purged_at IS NULL
            AND event.sequence_no < $3
          ORDER BY event.sequence_no DESC
          LIMIT $4
        ) recent
        ORDER BY recent.sequence_no ASC
      `,
      [
        input.userId,
        input.dailySessionId,
        input.beforeSequence,
        input.limit + 1,
      ],
    );
    const hasMore = result.rows.length > input.limit;
    // `rows` is ascending, so the newest `limit` messages are the tail.
    const kept = result.rows.slice(
      Math.max(0, result.rows.length - input.limit),
    );
    return {
      hasMore,
      messages: kept.map((row) => ({
        actor: row.actor,
        createdAt: row.created_at.toISOString(),
        eventId: asConversationEventId(row.conversation_event_id),
        generationCommandId: row.generation_command_id
          ? asGenerationCommandId(row.generation_command_id)
          : null,
        locale: row.locale,
        logicalDate: row.logical_date,
        revisionId: asConversationEventRevisionId(row.revision_id),
        sequence: Number(row.sequence_no),
        text: row.text,
      })),
    };
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

    await ensureInactivityPolicy(client, input.inactivityPolicy, input.now);

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
            session.closure_policy_version,
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
              closure_policy_version = $8,
              quiescent_at = NULL,
              quiescent_reason = NULL,
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
              closure_policy_version,
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
            input.inactivityPolicy.version,
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
          output_format_version,
          persona_contract_invariant_version,
          canonical_persona_version,
          persona_behavior_anchors_version,
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
          harness_policy_version,
          conversation_action_catalog_version,
          expected_data_epoch,
          status,
          created_at
        )
        VALUES (
          $1, $2, $3, 'conversation.text', $4, 'conversation_event', $5,
          'conversation_event_revision', $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
          'prepared', $27
        )
      `,
      [
        generationCommandId,
        input.userId,
        interactionTurnId,
        intentKey,
        source.subject_id,
        source.input_revision_id,
        input.generationPolicy.taskInstructionVersion,
        input.generationPolicy.outputFormatVersion,
        input.generationPolicy.personaContractInvariantVersion,
        input.generationPolicy.canonicalPersonaVersion,
        input.generationPolicy.personaBehaviorAnchorsVersion,
        input.generationPolicy.productPolicyVersion,
        input.generationPolicy.safetyPolicyVersion,
        input.generationPolicy.relationshipPolicyVersion,
        resolveLocalePackVersion({
          chineseLocalePackVersion:
            input.generationPolicy.chineseLocalePackVersion,
          englishLocalePackVersion:
            input.generationPolicy.englishLocalePackVersion,
          locale: source.locale,
        }),
        source.locale,
        input.generationPolicy.provider,
        input.generationPolicy.model,
        input.generationPolicy.modelSnapshot,
        input.generationPolicy.modelConfigVersion,
        input.generationPolicy.providerPolicyVersion,
        input.generationPolicy.consentPolicyVersion,
        input.generationPolicy.freshnessPolicy,
        input.generationPolicy.harnessPolicyVersion,
        input.generationPolicy.conversationActionCatalogVersion,
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
        input.generationPolicy.taskInstructionVersion,
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
      [input.now, source.daily_session_id, input.userId],
    );
    await scheduleInactivityEvaluation(client, {
      dailySessionId: source.daily_session_id,
      now: input.now,
      userId: input.userId,
    });
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

    await ensureInactivityPolicy(client, input.inactivityPolicy, input.now);

    let currentSession = (
      await client.query<DailySessionRow>(
        `
          SELECT
            daily_session_id,
            logical_date::text,
            timezone_at_start,
            activity_state,
            closure_policy_version,
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
          closure_policy_version,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $5, $6, $5, $5)
        ON CONFLICT (user_id, logical_date) DO NOTHING
      `,
        [
          createUuidV7(input.now),
          input.userId,
          input.logicalDate,
          input.timezone,
          input.now,
          input.inactivityPolicy.version,
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
              closure_policy_version,
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
              closure_policy_version = $4,
              quiescent_at = NULL,
              quiescent_reason = NULL,
              updated_at = $1
            WHERE daily_session_id = $2
              AND user_id = $3
              AND activity_state = 'quiescent'
            RETURNING
              daily_session_id,
              logical_date::text,
              timezone_at_start,
              activity_state,
              closure_policy_version,
              current_continuous_exchange_no,
              next_turn_sequence_no,
              next_event_sequence_no
          `,
          [
            input.now,
            currentSession.daily_session_id,
            input.userId,
            input.inactivityPolicy.version,
          ],
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
          output_format_version,
          persona_contract_invariant_version,
          canonical_persona_version,
          persona_behavior_anchors_version,
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
          harness_policy_version,
          conversation_action_catalog_version,
          expected_data_epoch,
          status,
          created_at
        )
        VALUES (
          $1, $2, $3, 'conversation.text', $4, 'conversation_event', $5,
          'conversation_event_revision', $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
          'prepared', $27
        )
      `,
      [
        generationCommandId,
        input.userId,
        interactionTurnId,
        `conversation-response/${conversationEventId}`,
        conversationEventId,
        revisionId,
        input.generationPolicy.taskInstructionVersion,
        input.generationPolicy.outputFormatVersion,
        input.generationPolicy.personaContractInvariantVersion,
        input.generationPolicy.canonicalPersonaVersion,
        input.generationPolicy.personaBehaviorAnchorsVersion,
        input.generationPolicy.productPolicyVersion,
        input.generationPolicy.safetyPolicyVersion,
        input.generationPolicy.relationshipPolicyVersion,
        resolveLocalePackVersion({
          chineseLocalePackVersion:
            input.generationPolicy.chineseLocalePackVersion,
          englishLocalePackVersion:
            input.generationPolicy.englishLocalePackVersion,
          locale: input.locale,
        }),
        input.locale,
        input.generationPolicy.provider,
        input.generationPolicy.model,
        input.generationPolicy.modelSnapshot,
        input.generationPolicy.modelConfigVersion,
        input.generationPolicy.providerPolicyVersion,
        input.generationPolicy.consentPolicyVersion,
        input.generationPolicy.freshnessPolicy,
        input.generationPolicy.harnessPolicyVersion,
        input.generationPolicy.conversationActionCatalogVersion,
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
        input.generationPolicy.taskInstructionVersion,
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
    await scheduleInactivityEvaluation(client, {
      dailySessionId: currentSession.daily_session_id,
      now: input.now,
      userId: input.userId,
    });
    // Fast path (issue #113): the committed final User Event revision carries
    // exactly one idempotent extraction command + outbox row in this same
    // transaction; the current reply never waits on it.
    await insertFastPathExtractionCommand(client, {
      userId: input.userId,
      revisionId,
      revisionOrdinal: 1,
      policyVersion: input.fastPathExtractionPolicyVersion,
      dataEpoch: ownerRow.data_epoch,
      now: input.now,
    });
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
          // `conversation_events.created_at` for this User Event was written
          // from the same `input.now`, so this is the read contract's instant.
          createdAt: input.now.toISOString(),
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
        event.created_at,
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
      createdAt: row.created_at.toISOString(),
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
        output_format_version,
        persona_contract_invariant_version,
        canonical_persona_version,
        persona_behavior_anchors_version,
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
        harness_policy_version,
        conversation_action_catalog_version,
        expected_data_epoch,
        status,
        created_at
      )
      VALUES (
        $1, $2, $3, 'conversation.text', $4, 'conversation_event', $5,
        'conversation_event_revision', $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
        'prepared', $27
      )
    `,
    [
      generationCommandId,
      input.userId,
      row.interaction_turn_id,
      `conversation-response/${row.conversation_event_id}`,
      row.conversation_event_id,
      row.revision_id,
      input.generationPolicy.taskInstructionVersion,
      input.generationPolicy.outputFormatVersion,
      input.generationPolicy.personaContractInvariantVersion,
      input.generationPolicy.canonicalPersonaVersion,
      input.generationPolicy.personaBehaviorAnchorsVersion,
      input.generationPolicy.productPolicyVersion,
      input.generationPolicy.safetyPolicyVersion,
      input.generationPolicy.relationshipPolicyVersion,
      resolveLocalePackVersion({
        chineseLocalePackVersion:
          input.generationPolicy.chineseLocalePackVersion,
        englishLocalePackVersion:
          input.generationPolicy.englishLocalePackVersion,
        locale: row.locale,
      }),
      row.locale,
      input.generationPolicy.provider,
      input.generationPolicy.model,
      input.generationPolicy.modelSnapshot,
      input.generationPolicy.modelConfigVersion,
      input.generationPolicy.providerPolicyVersion,
      input.generationPolicy.consentPolicyVersion,
      input.generationPolicy.freshnessPolicy,
      input.generationPolicy.harnessPolicyVersion,
      input.generationPolicy.conversationActionCatalogVersion,
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
      input.generationPolicy.taskInstructionVersion,
      input.now,
    ],
  );
  return {
    ...row,
    generation_command_id: generationCommandId,
    model_run_attempt_id: modelRunAttemptId,
  };
}

async function ensureInactivityPolicy(
  client: PoolClient,
  policy: InactivityPolicy,
  now: Date,
): Promise<void> {
  if (
    typeof policy.version !== "string" ||
    policy.version.length === 0 ||
    policy.version.length > 200 ||
    !Number.isSafeInteger(policy.timeoutMs) ||
    policy.timeoutMs <= 0
  ) {
    throw new Error("The inactivity policy configuration is invalid.");
  }
  await client.query(
    `
      INSERT INTO continuous_exchange_inactivity_policies (
        policy_version,
        timeout_ms,
        created_at
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (policy_version) DO NOTHING
    `,
    [policy.version, policy.timeoutMs, now],
  );
  const stored = await client.query<{ timeout_ms: string }>(
    `
      SELECT timeout_ms
      FROM continuous_exchange_inactivity_policies
      WHERE policy_version = $1
    `,
    [policy.version],
  );
  if (Number(stored.rows[0]?.timeout_ms) !== policy.timeoutMs) {
    throw new Error(
      "An inactivity policy version cannot be reused with a different timeout.",
    );
  }
}

async function scheduleInactivityEvaluation(
  client: PoolClient,
  input: {
    dailySessionId: string;
    now: Date;
    userId: UserId;
  },
): Promise<void> {
  const scheduled = await client.query(
    `
      INSERT INTO continuous_exchange_inactivity_evaluations (
        inactivity_evaluation_id,
        user_id,
        daily_session_id,
        continuous_exchange_no,
        policy_version,
        expected_dialogue_revision,
        due_at,
        created_at
      )
      SELECT
        $1,
        session.user_id,
        session.daily_session_id,
        session.current_continuous_exchange_no,
        session.closure_policy_version,
        session.dialogue_revision,
        $2::timestamptz + policy.timeout_ms * INTERVAL '1 millisecond',
        $2
      FROM daily_sessions session
      INNER JOIN continuous_exchange_inactivity_policies policy
        ON policy.policy_version = session.closure_policy_version
      WHERE session.daily_session_id = $3
        AND session.user_id = $4
        AND session.activity_state = 'active'
      ON CONFLICT (
        daily_session_id,
        continuous_exchange_no,
        expected_dialogue_revision
      ) DO NOTHING
    `,
    [createUuidV7(input.now), input.now, input.dailySessionId, input.userId],
  );
  if (scheduled.rowCount !== 1) {
    throw new Error(
      "The inactivity evaluation was not scheduled with the User Event.",
    );
  }
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

// ── Fast-path extraction command helpers (issue #113) ──────────────────────

/**
 * Create the idempotent fast-path extraction WorkflowCommand + outbox row for
 * one committed final / corrected User Event revision, inside the caller's
 * transaction. The stable unique key
 * (fast_path_extraction, conversation_event_revision, revision ordinal, policy
 * version) absorbs replays; `null` policy (the switch is off) creates nothing.
 */
async function insertFastPathExtractionCommand(
  client: PoolClient,
  input: {
    userId: string;
    revisionId: string;
    revisionOrdinal: number;
    policyVersion: string | null;
    dataEpoch: string;
    now: Date;
  },
): Promise<void> {
  if (input.policyVersion === null) return;
  const policy = await client.query(
    `SELECT 1 FROM fast_path_extraction_policies WHERE policy_version = $1`,
    [input.policyVersion],
  );
  if (policy.rowCount !== 1) {
    throw new Error("Fast path extraction policy is unavailable or has drifted.");
  }
  const commandId = createUuidV7(input.now);
  await client.query(
    `INSERT INTO workflow_commands (
       workflow_command_id, command_type, subject_type, subject_id,
       source_revision, policy_version, expected_data_epoch, status, created_at
     ) VALUES ($1, 'fast_path_extraction', 'conversation_event_revision', $2,
       $3, $4, $5, 'created', $6)
     ON CONFLICT DO NOTHING`,
    [
      commandId,
      input.revisionId,
      input.revisionOrdinal,
      input.policyVersion,
      input.dataEpoch,
      input.now,
    ],
  );
  const command = await client.query<{ workflow_command_id: string }>(
    `SELECT workflow_command_id FROM workflow_commands
     WHERE command_type = 'fast_path_extraction'
       AND subject_type = 'conversation_event_revision'
       AND subject_id = $1 AND source_revision = $2 AND policy_version = $3`,
    [input.revisionId, input.revisionOrdinal, input.policyVersion],
  );
  await client.query(
    `INSERT INTO outbox_events (
       outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
       aggregate_revision, aggregate_data_epoch, aggregate_coverage,
       event_type, status, next_attempt_at, attempt_count,
       payload, created_at
     ) VALUES ($1, $2, 'conversation_event_revision', $3, $4, $5, 0,
       'fast_path_extraction_requested', 'pending', $6, 0, $7, $6)
     ON CONFLICT DO NOTHING`,
    [
      createUuidV7(input.now),
      command.rows[0]!.workflow_command_id,
      input.revisionId,
      input.revisionOrdinal,
      Number(input.dataEpoch),
      input.now,
      JSON.stringify({
        policyVersion: input.policyVersion,
        expectedDataEpoch: Number(input.dataEpoch),
      }),
    ],
  );
}

/**
 * Retire the superseded revision's fast-path derivatives (runs, session
 * items, and candidates citing its evidence) — corrections produce new
 * revisions and new commands, and the old revision's derivatives stop
 * serving (SPEC story 28 / architecture 12.1).
 */
async function retireFastPathDerivatives(
  client: PoolClient,
  input: { userId: string; retiredRevisionId: string; now: Date },
): Promise<void> {
  await client.query(
    `UPDATE fast_path_extraction_runs
     SET status = 'retired', retired_at = $1, updated_at = $1
     WHERE user_id = $2 AND event_revision_id = $3
       AND status = 'extracted'`,
    [input.now, input.userId, input.retiredRevisionId],
  );
  await client.query(
    `UPDATE fast_path_session_items
     SET retired_at = $1
     WHERE user_id = $2 AND event_revision_id = $3 AND retired_at IS NULL`,
    [input.now, input.userId, input.retiredRevisionId],
  );
  await client.query(
    `UPDATE memory_candidates candidate
     SET status = 'deleted',
         disposition_reason_code = 'source_revision_superseded'
     WHERE candidate.user_id = $1
       AND candidate.status IN ('proposed', 'needs_entity_resolution', 'needs_predicate_review')
       AND EXISTS (
         SELECT 1 FROM memory_candidate_evidence_links link
         JOIN evidence_items item ON item.evidence_item_id = link.evidence_item_id
         WHERE link.memory_candidate_id = candidate.memory_candidate_id
           AND link.user_id = $1
           AND item.source_revision_id = $2
       )`,
    [input.userId, input.retiredRevisionId],
  );
}
