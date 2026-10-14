import type { Pool, PoolClient } from "pg";
import { lockSessionOwnerEpoch } from "./postgres-owner-epoch-fence";
import { retryPostgresTransaction } from "./postgres-transaction-retry";

export type JournalWorkflowIdentity = Readonly<{
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  expectedDataEpoch: number;
}>;

export class PostgresJournalWorkflowRecovery {
  public constructor(private readonly pool: Pool, private readonly leaseDurationMs = 300_000) {}

  private async transaction<T>(identity: JournalWorkflowIdentity | null, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    return retryPostgresTransaction(async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        if (identity) {
          await lockSessionOwnerEpoch(client, identity.subjectId);
          await client.query("SELECT daily_session_id FROM daily_sessions WHERE daily_session_id = $1 FOR UPDATE", [identity.subjectId]);
        } else {
          await client.query("SELECT user_id FROM app_users ORDER BY user_id FOR UPDATE");
        }
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    });
  }

  public async claim(identity: JournalWorkflowIdentity, token: string): Promise<boolean> {
    return this.transaction(identity, async (client) => {
      const result = await client.query(
        `INSERT INTO journal_workflow_outcomes (workflow_command_id, user_id, daily_session_id, source_revision,
         expected_data_epoch, outcome, created_at, attempt_count, lease_token, lease_expires_at)
         SELECT $1, session.user_id, session.daily_session_id, $3, $4, 'retryable_failed', CURRENT_TIMESTAMP,
           1, $5, CURRENT_TIMESTAMP + ($6::bigint * INTERVAL '1 millisecond')
         FROM daily_sessions session INNER JOIN app_users owner ON owner.user_id = session.user_id
         WHERE session.daily_session_id = $2 AND session.source_revision = $3
           AND session.activity_state = 'quiescent' AND owner.status = 'active' AND owner.data_epoch = $4
         ON CONFLICT (workflow_command_id) DO UPDATE SET
           attempt_count = journal_workflow_outcomes.attempt_count + 1,
           lease_token = EXCLUDED.lease_token, lease_expires_at = EXCLUDED.lease_expires_at, next_attempt_at = NULL
         WHERE journal_workflow_outcomes.outcome = 'retryable_failed'
           AND journal_workflow_outcomes.attempt_count < 3
           AND (journal_workflow_outcomes.lease_expires_at IS NULL OR journal_workflow_outcomes.lease_expires_at <= CURRENT_TIMESTAMP)
           AND (journal_workflow_outcomes.next_attempt_at IS NULL OR journal_workflow_outcomes.next_attempt_at <= CURRENT_TIMESTAMP)
         RETURNING workflow_command_id`,
        [identity.workflowCommandId, identity.subjectId, identity.sourceRevision, identity.expectedDataEpoch, token, this.leaseDurationMs],
      );
      return result.rowCount === 1;
    });
  }

  public async settle(identity: JournalWorkflowIdentity, token: string, outcome: "published" | "needs_review" | "retryable_failed", reason: string | null): Promise<void> {
    await this.transaction(identity, async (client) => {
      await client.query(
        `UPDATE journal_workflow_outcomes SET
           outcome = CASE WHEN $3 = 'retryable_failed' AND attempt_count >= 3 THEN 'needs_review' ELSE $3 END,
           reason = CASE WHEN $3 = 'retryable_failed' AND attempt_count >= 3 THEN 'retry_budget_exhausted' ELSE $4 END,
           next_attempt_at = CASE WHEN $3 = 'retryable_failed' AND attempt_count < 3 THEN CURRENT_TIMESTAMP + INTERVAL '1 minute' ELSE NULL END,
           lease_token = NULL, lease_expires_at = NULL
         WHERE workflow_command_id = $1 AND lease_token = $2`,
        [identity.workflowCommandId, token, outcome, reason],
      );
      await client.query(
        `UPDATE workflow_commands command SET status = CASE WHEN failure.outcome = 'published' THEN 'completed' ELSE 'dead_lettered' END
         FROM journal_workflow_outcomes failure WHERE command.workflow_command_id::text = failure.workflow_command_id
           AND failure.workflow_command_id = $1 AND failure.lease_token IS NULL
           AND failure.outcome IN ('published', 'needs_review')`, [identity.workflowCommandId],
      );
    });
  }

  public async recoverDue(): Promise<void> {
    await this.transaction(null, (client) => client.query(`INSERT INTO journal_workflow_outcomes (workflow_command_id,user_id,daily_session_id,source_revision,expected_data_epoch,outcome,reason,created_at,next_attempt_at)
      SELECT command.workflow_command_id::text, session.user_id, session.daily_session_id, command.source_revision,
        command.expected_data_epoch, 'retryable_failed', 'workflow_interrupted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM workflow_commands command INNER JOIN daily_sessions session ON session.daily_session_id = command.subject_id
      INNER JOIN app_users owner ON owner.user_id = session.user_id
      INNER JOIN daily_session_date_outcomes date_outcome ON date_outcome.daily_session_id = session.daily_session_id
      WHERE command.command_type = 'journal_eligibility' AND command.status = 'dispatched'
        AND command.dispatched_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        AND date_outcome.outcome = 'eligible_queued' AND session.source_revision = command.source_revision
        AND owner.status = 'active' AND owner.data_epoch = command.expected_data_epoch
      ON CONFLICT (workflow_command_id) DO NOTHING`));
    const candidates = await this.pool.query<JournalWorkflowIdentity>(
      `SELECT workflow_command_id AS "workflowCommandId", daily_session_id AS "subjectId",
         source_revision::int AS "sourceRevision", expected_data_epoch::int AS "expectedDataEpoch"
       FROM journal_workflow_outcomes
       WHERE outcome = 'retryable_failed'
         AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
         AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
       ORDER BY user_id, daily_session_id LIMIT 100`,
    );
    for (const identity of candidates.rows) await this.transaction(identity, async (client) => {
      const result = await client.query<{ attempt_count: number }>(
        `SELECT attempt_count FROM journal_workflow_outcomes WHERE workflow_command_id = $1 AND outcome = 'retryable_failed'
          AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
          AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP) FOR UPDATE`, [identity.workflowCommandId],
      );
      if (!result.rows[0]) return;
      const published = await client.query(`SELECT 1 FROM journals journal INNER JOIN journal_versions version
        ON version.journal_version_id = journal.current_version_id WHERE journal.daily_session_id = $1
          AND version.source_revision = $2 AND journal.deleted_at IS NULL`, [identity.subjectId, identity.sourceRevision]);
      if (published.rowCount === 1) {
        await client.query("UPDATE journal_workflow_outcomes SET outcome = 'published', reason = NULL, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL WHERE workflow_command_id = $1", [identity.workflowCommandId]);
        await client.query("UPDATE workflow_commands SET status = 'completed' WHERE workflow_command_id = $1", [identity.workflowCommandId]);
        return;
      }
      const valid = await client.query(
        `SELECT 1 FROM daily_sessions session INNER JOIN app_users owner ON owner.user_id = session.user_id
         WHERE session.daily_session_id = $1 AND session.source_revision = $2
           AND owner.status = 'active' AND owner.data_epoch = $3`,
        [identity.subjectId, identity.sourceRevision, identity.expectedDataEpoch],
      );
      if (result.rows[0].attempt_count >= 3 || valid.rowCount !== 1) {
        await client.query(`UPDATE journal_workflow_outcomes SET outcome = 'needs_review', reason = $2,
          lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL WHERE workflow_command_id = $1`,
          [identity.workflowCommandId, valid.rowCount === 1 ? "retry_budget_exhausted" : "stale_or_fenced"]);
        await client.query("UPDATE workflow_commands SET status = 'dead_lettered' WHERE workflow_command_id = $1", [identity.workflowCommandId]);
        return;
      }
      await client.query("UPDATE journal_workflow_outcomes SET lease_token = NULL, lease_expires_at = NULL WHERE workflow_command_id = $1", [identity.workflowCommandId]);
      await client.query(`UPDATE outbox_events SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
        next_attempt_at = CURRENT_TIMESTAMP, workflow_receipt_id = NULL WHERE workflow_command_id = $1 AND status = 'dispatched'`, [identity.workflowCommandId]);
      await client.query("UPDATE workflow_commands SET status = 'created' WHERE workflow_command_id = $1 AND status = 'dispatched'", [identity.workflowCommandId]);
    });
  }

  public async retryForDate(input: { userId: string; logicalDate: string }): Promise<boolean> {
    const identities = await this.pool.query<JournalWorkflowIdentity>(
      `SELECT failure.workflow_command_id AS "workflowCommandId", failure.daily_session_id AS "subjectId",
        failure.source_revision::int AS "sourceRevision", failure.expected_data_epoch::int AS "expectedDataEpoch"
       FROM journal_workflow_outcomes failure INNER JOIN daily_sessions session ON session.daily_session_id = failure.daily_session_id
       WHERE failure.user_id = $1 AND session.logical_date = $2::date AND failure.outcome = 'needs_review'
         AND failure.reason = 'retry_budget_exhausted'
       ORDER BY failure.created_at DESC LIMIT 1`, [input.userId, input.logicalDate],
    );
    const identity = identities.rows[0];
    if (!identity) return false;
    return this.transaction(identity, async (client) => {
      const updated = await client.query(
        `UPDATE journal_workflow_outcomes failure SET outcome = 'retryable_failed', reason = NULL, attempt_count = 0,
          next_attempt_at = CURRENT_TIMESTAMP, lease_token = NULL, lease_expires_at = NULL
         FROM daily_sessions session, app_users owner
         WHERE failure.workflow_command_id = $1 AND failure.outcome = 'needs_review' AND failure.lease_token IS NULL
           AND failure.reason = 'retry_budget_exhausted' AND session.daily_session_id = failure.daily_session_id
           AND session.user_id = $2 AND owner.user_id = session.user_id AND owner.status = 'active'
           AND owner.data_epoch = failure.expected_data_epoch AND session.source_revision = failure.source_revision
           AND session.activity_state = 'quiescent' RETURNING failure.workflow_command_id`, [identity.workflowCommandId, input.userId],
      );
      if (updated.rowCount !== 1) return false;
      await client.query(`UPDATE outbox_events SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
        next_attempt_at = CURRENT_TIMESTAMP, workflow_receipt_id = NULL WHERE workflow_command_id = $1 AND status IN ('dispatched', 'dead_lettered')`, [identity.workflowCommandId]);
      await client.query("UPDATE workflow_commands SET status = 'created' WHERE workflow_command_id = $1", [identity.workflowCommandId]);
      return true;
    });
  }
}
