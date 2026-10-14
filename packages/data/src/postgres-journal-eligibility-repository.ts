import { PostgresJournalWorkflowRecovery } from "./postgres-journal-workflow-recovery";
import { retryPostgresTransaction } from "./postgres-transaction-retry";
import type {
  JournalEligibilityDateOutcome,
  JournalEligibilityEvaluationResult,
  JournalEligibilityRepository,
  JournalEligibilitySessionSnapshot,
} from "@sayhear/application";
import {
  asDailySessionId,
  asUserId,
  asWorkflowCommandId,
  type DailySessionId,
  type UserId,
  type WorkflowCommandId,
} from "@sayhear/domain";
import type { Pool } from "pg";

import { lockSessionOwnerEpoch } from "./postgres-owner-epoch-fence";
import { createUuidV7 } from "./uuid-v7";

type EligibilitySessionRow = Readonly<{
  daily_session_id: string;
  user_id: string;
  logical_date: Date;
  source_revision: number;
  longest_user_expression_length: number;
  user_conversation_event_count: number;
}>;

export class PostgresJournalEligibilityRepository
  implements JournalEligibilityRepository
{
  public constructor(private readonly pool: Pool) {}

  public async evaluateEligibility(
    input: Parameters<JournalEligibilityRepository["evaluateEligibility"]>[0],
  ): ReturnType<JournalEligibilityRepository["evaluateEligibility"]> {
    return retryPostgresTransaction(() => this.evaluateEligibilityOnce(input));
  }

  private async evaluateEligibilityOnce(
    input: Parameters<JournalEligibilityRepository["evaluateEligibility"]>[0],
  ): ReturnType<JournalEligibilityRepository["evaluateEligibility"]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ownerEpoch = await lockSessionOwnerEpoch(client, input.dailySessionId);
      const locked = await client.query<{
        daily_session_id: string;
        user_id: string;
        logical_date: Date;
        source_revision: number;
        activity_state: string;
      }>(
        `
          SELECT daily_session_id, user_id, logical_date, source_revision,
            activity_state
          FROM daily_sessions
          WHERE daily_session_id = $1
          FOR UPDATE
        `,
        [input.dailySessionId],
      );
      const lockedRow = locked.rows[0];
      if (!lockedRow) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      // The Daily Session must be quiescent before eligibility can be durable.
      // An in-flight active conversation never produces a command (AC #2/#10).
      if (lockedRow.activity_state === "active") {
        await client.query("ROLLBACK");
        return { outcome: "not_quiescent" };
      }
      // §13.4 concurrency fence: lock the owning User and capture its current
      // epoch in the SAME transaction. A user whose data_epoch advances after
      // this point cannot invalidate this command admission without waiting on
      // the owner lock.
      if (ownerEpoch === null) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      // Compute the longest substantive user expression + event count in a
      // separate read (kept out of the FOR UPDATE query above).
      const expression = await client.query<{
        longest_user_expression_length: number;
        user_conversation_event_count: number;
      }>(
        `
          SELECT COALESCE(
            MAX(CHAR_LENGTH(BTRIM(revision.canonical_text))),
            0
          ) AS longest_user_expression_length,
          COUNT(*)::int AS user_conversation_event_count
          FROM conversation_events event
          LEFT JOIN conversation_event_revisions revision
            ON revision.conversation_event_revision_id = event.current_revision_id
          WHERE event.daily_session_id = $1
            AND event.user_id = $2
            AND event.actor = 'user'
            AND event.lifecycle_status = 'active'
        `,
        [lockedRow.daily_session_id, lockedRow.user_id],
      );
      const sessionRow: EligibilitySessionRow = {
        daily_session_id: lockedRow.daily_session_id,
        user_id: lockedRow.user_id,
        logical_date: lockedRow.logical_date,
        source_revision: Number(lockedRow.source_revision),
        longest_user_expression_length:
          expression.rows[0]?.longest_user_expression_length ?? 0,
        user_conversation_event_count:
          expression.rows[0]?.user_conversation_event_count ?? 0,
      };

      const workflowCommandId = createUuidV7(input.evaluatedAt);
      const created = await client.query<{ workflow_command_id: string }>(
        `
          INSERT INTO workflow_commands (
            workflow_command_id,
            command_type,
            subject_type,
            subject_id,
            source_revision,
            policy_version,
            expected_data_epoch,
            coverage_through_sequence_no,
            intent_key,
            status,
            created_at
          )
          VALUES ($1, 'journal_eligibility', 'daily_session', $2, $3, $4, $5, 0, '', 'created', $6)
          ON CONFLICT
            (command_type, subject_type, subject_id, source_revision, policy_version,
             expected_data_epoch, coverage_through_sequence_no, intent_key)
          DO UPDATE SET workflow_command_id = workflow_commands.workflow_command_id
          RETURNING workflow_command_id,
            (xmax = 0) AS inserted
        `,
        [
          workflowCommandId,
          input.dailySessionId,
          sessionRow.source_revision,
          input.policyVersion,
          ownerEpoch,
          input.evaluatedAt,
        ],
      );
      const commandId = asWorkflowCommandId(
        created.rows[0]!.workflow_command_id,
      );
      const inserted = (created.rows[0] as unknown as { inserted: boolean })
        .inserted;

      if (inserted) {
        // Outbox event committed in the SAME transaction as the command (AC #5).
        await client.query(
          `
            INSERT INTO outbox_events (
              outbox_event_id,
              workflow_command_id,
              aggregate_type,
              aggregate_id,
              aggregate_revision,
              aggregate_data_epoch,
              event_type,
              status,
              next_attempt_at,
              attempt_count,
              payload,
              created_at
            )
            VALUES ($1, $2, 'daily_session', $3, $4, $5,
              'journal_eligibility_requested', 'pending', $6, 0, $7::jsonb, $8)
          `,
          [
            createUuidV7(input.evaluatedAt),
            commandId,
            input.dailySessionId,
            sessionRow.source_revision,
            ownerEpoch,
            input.evaluatedAt,
            JSON.stringify({
              workflowCommandId: commandId,
              subjectType: "daily_session",
              subjectId: input.dailySessionId,
              sourceRevision: sessionRow.source_revision,
              policyVersion: input.policyVersion,
              expectedDataEpoch: ownerEpoch,
              eventType: "journal_eligibility_requested",
              status: "pending",
            }),
            input.evaluatedAt,
          ],
        );
      }

      await client.query("COMMIT");
      const result: JournalEligibilityEvaluationResult = {
        commandCreated: inserted,
        workflowCommandId: commandId,
      };
      return { outcome: "evaluated", result };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async listQuiescentSessionsNeedingEligibility(input: {
    limit: number;
  }): Promise<readonly DailySessionId[]> {
    await new PostgresJournalWorkflowRecovery(this.pool).recoverDue();
    const rows = await this.pool.query<{ daily_session_id: string }>(
      `
        SELECT session.daily_session_id
        FROM daily_sessions session
        LEFT JOIN daily_session_date_outcomes outcome
          ON outcome.daily_session_id = session.daily_session_id
        WHERE session.activity_state = 'quiescent'
          AND (
            outcome.daily_session_id IS NULL
            OR outcome.source_revision < session.source_revision
          )
        ORDER BY session.quiescent_at NULLS LAST, session.daily_session_id
        LIMIT $1
      `,
      [input.limit],
    );
    return rows.rows.map((row) => asDailySessionId(row.daily_session_id));
  }

  public async readEligibilitySnapshot(input: {
    dailySessionId: DailySessionId;
    policyVersion: string;
  }): Promise<JournalEligibilitySessionSnapshot | null> {
    const row = await this.pool.query<EligibilitySessionRow>(
      `
        SELECT
          session.daily_session_id,
          session.user_id,
          session.logical_date,
          session.source_revision,
          COALESCE(
            MAX(
              CASE
                WHEN event.actor = 'user'
                  AND event.lifecycle_status = 'active'
                  THEN CHAR_LENGTH(BTRIM(revision.canonical_text))
                ELSE 0
              END
            ),
            0
          ) AS longest_user_expression_length,
          COUNT(event.conversation_event_id)
            FILTER (
              WHERE event.actor = 'user'
                AND event.lifecycle_status = 'active'
            )::int AS user_conversation_event_count
        FROM daily_sessions session
        LEFT JOIN conversation_events event
          ON event.daily_session_id = session.daily_session_id
            AND event.user_id = session.user_id
        LEFT JOIN conversation_event_revisions revision
          ON revision.conversation_event_revision_id = event.current_revision_id
        WHERE session.daily_session_id = $1
        GROUP BY session.daily_session_id, session.user_id, session.logical_date, session.source_revision
      `,
      [input.dailySessionId],
    );
    void input.policyVersion;
    const snapshot = row.rows[0];
    if (!snapshot) {
      return null;
    }
    return {
      dailySessionId: asDailySessionId(snapshot.daily_session_id),
      userId: asUserId(snapshot.user_id),
      logicalDate: snapshot.logical_date.toISOString().slice(0, 10),
      sourceRevision: Number(snapshot.source_revision),
      longestUserExpressionLength: snapshot.longest_user_expression_length,
      userConversationEventCount: snapshot.user_conversation_event_count,
    };
  }

  public async recordDateOutcome(input: {
    dailySessionId: DailySessionId;
    userId: UserId;
    expectedDataEpoch: number;
    logicalDate: string;
    outcome: JournalEligibilityDateOutcome;
    eligibilityPolicyVersion: string;
    sourceRevision: number;
    workflowReceiptId: string;
    computedAt: Date;
  }): Promise<{ applied: boolean }> {
    return retryPostgresTransaction(() => this.recordDateOutcomeOnce(input));
  }

  private async recordDateOutcomeOnce(input: {
    dailySessionId: DailySessionId;
    userId: UserId;
    expectedDataEpoch: number;
    logicalDate: string;
    outcome: JournalEligibilityDateOutcome;
    eligibilityPolicyVersion: string;
    sourceRevision: number;
    workflowReceiptId: string;
    computedAt: Date;
  }): Promise<{ applied: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // §13.4 concurrency fence: the date outcome is an authoritative write, so
      // the owning User is locked and re-checked for active + data_epoch in the
      // same transaction as the outcome CAS.
      const owner = await client.query<{ status: string; data_epoch: string }>(
        `
          SELECT status, data_epoch::text AS data_epoch
          FROM app_users
          WHERE user_id = $1
          FOR UPDATE
        `,
        [input.userId],
      );
      if (
        !owner.rows[0] ||
        owner.rows[0].status !== "active" ||
        Number(owner.rows[0].data_epoch) !== input.expectedDataEpoch
      ) {
        await client.query("ROLLBACK");
        return { applied: false };
      }
      // Monotonic projection guard (§13.4): a late replay may only advance the
      // outcome to an equal or higher source revision — it must never overwrite
      // the canonical row backwards. When the WHERE guard filters the conflict
      // update out, RETURNING yields no row.
      const result = await client.query(
        `
          INSERT INTO daily_session_date_outcomes (
            daily_session_id,
            user_id,
            logical_date,
            outcome,
            eligibility_policy_version,
            source_revision,
            workflow_receipt_id,
            computed_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (daily_session_id) DO UPDATE
            SET outcome = EXCLUDED.outcome,
                eligibility_policy_version = EXCLUDED.eligibility_policy_version,
                source_revision = EXCLUDED.source_revision,
                workflow_receipt_id = EXCLUDED.workflow_receipt_id,
                computed_at = EXCLUDED.computed_at
            WHERE daily_session_date_outcomes.source_revision <= EXCLUDED.source_revision
          RETURNING daily_session_id
        `,
        [
          input.dailySessionId,
          input.userId,
          input.logicalDate,
          input.outcome,
          input.eligibilityPolicyVersion,
          input.sourceRevision,
          input.workflowReceiptId,
          input.computedAt,
        ],
      );
      await client.query("COMMIT");
      return { applied: result.rowCount === 1 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async findDateOutcome(input: {
    dailySessionId: DailySessionId;
  }) {
    const row = await this.pool.query<{
      daily_session_id: string;
      logical_date: Date;
      outcome: JournalEligibilityDateOutcome;
      eligibility_policy_version: string;
      source_revision: number;
      workflow_receipt_id: string | null;
    }>(
      `
        SELECT daily_session_id, logical_date, outcome,
          eligibility_policy_version, source_revision, workflow_receipt_id
        FROM daily_session_date_outcomes
        WHERE daily_session_id = $1
      `,
      [input.dailySessionId],
    );
    const outcome = row.rows[0];
    if (!outcome) {
      return null;
    }
    return {
      dailySessionId: asDailySessionId(outcome.daily_session_id),
      logicalDate: outcome.logical_date.toISOString().slice(0, 10),
      outcome: outcome.outcome,
      eligibilityPolicyVersion: outcome.eligibility_policy_version,
      sourceRevision: outcome.source_revision,
      workflowReceiptId: outcome.workflow_receipt_id,
    };
  }
}
