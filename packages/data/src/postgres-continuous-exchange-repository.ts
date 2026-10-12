import type {
  ContinuousExchangeRepository,
  InactivityEvaluationOutcome,
} from "@sayhear/application";
import {
  asInactivityEvaluationId,
  type InactivityEvaluationId,
} from "@sayhear/domain";
import type { Pool } from "pg";

export type RecoveryDerivedLatency = Readonly<{
  oldestPendingSeconds: number;
  pendingSessions: number;
}>;

type EvaluationRow = Readonly<{
  continuous_exchange_no: number;
  daily_session_id: string;
  due_at: Date;
  expected_dialogue_revision: string;
  outcome: InactivityEvaluationOutcome | null;
  user_id: string;
}>;

export class PostgresContinuousExchangeRepository
  implements ContinuousExchangeRepository
{
  public constructor(private readonly pool: Pool) {}

  public async listDueInactivityEvaluationIds(input: {
    dueAt: Date;
    limit: number;
  }): Promise<readonly InactivityEvaluationId[]> {
    const due = await this.pool.query<{ inactivity_evaluation_id: string }>(
      `
        SELECT inactivity_evaluation_id
        FROM continuous_exchange_inactivity_evaluations
        WHERE outcome IS NULL
          AND due_at <= $1
        ORDER BY due_at, inactivity_evaluation_id
        LIMIT $2
      `,
      [input.dueAt, input.limit],
    );
    return due.rows.map((row) =>
      asInactivityEvaluationId(row.inactivity_evaluation_id),
    );
  }

  public async evaluateInactivity(
    input: Parameters<ContinuousExchangeRepository["evaluateInactivity"]>[0],
  ): ReturnType<ContinuousExchangeRepository["evaluateInactivity"]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const evaluation = await client.query<EvaluationRow>(
        `
          SELECT
            user_id,
            daily_session_id,
            continuous_exchange_no,
            expected_dialogue_revision,
            due_at,
            outcome
          FROM continuous_exchange_inactivity_evaluations
          WHERE inactivity_evaluation_id = $1
          FOR UPDATE
        `,
        [input.inactivityEvaluationId],
      );
      const row = evaluation.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      if (row.outcome !== null) {
        await client.query("COMMIT");
        return { outcome: row.outcome, replayed: true };
      }
      if (row.due_at.getTime() > input.evaluatedAt.getTime()) {
        await client.query("COMMIT");
        return { outcome: "not_due" };
      }

      const session = await client.query<{
        activity_state: "active" | "finalized" | "quiescent";
        current_continuous_exchange_no: number;
        dialogue_revision: string;
      }>(
        `
          SELECT
            activity_state,
            current_continuous_exchange_no,
            dialogue_revision
          FROM daily_sessions
          WHERE daily_session_id = $1
            AND user_id = $2
          FOR UPDATE
        `,
        [row.daily_session_id, row.user_id],
      );
      const sessionRow = session.rows[0];
      if (!sessionRow) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }

      let outcome: InactivityEvaluationOutcome;
      if (sessionRow.activity_state !== "active") {
        outcome = "not_active";
      } else if (
        sessionRow.current_continuous_exchange_no !==
          row.continuous_exchange_no ||
        sessionRow.dialogue_revision !== row.expected_dialogue_revision
      ) {
        outcome = "stale_revision";
      } else {
        const ended = await client.query(
          `
            UPDATE daily_sessions
            SET
              activity_state = 'quiescent',
              quiescent_at = $1,
              quiescent_reason = 'inactivity_timeout',
              updated_at = $1
            WHERE daily_session_id = $2
              AND user_id = $3
              AND activity_state = 'active'
              AND current_continuous_exchange_no = $4
              AND dialogue_revision = $5
          `,
          [
            input.evaluatedAt,
            row.daily_session_id,
            row.user_id,
            row.continuous_exchange_no,
            row.expected_dialogue_revision,
          ],
        );
        if (ended.rowCount !== 1) {
          throw new Error(
            "The inactivity evaluation compare-and-set failed after locking.",
          );
        }
        outcome = "applied";
      }

      await client.query(
        `
          UPDATE continuous_exchange_inactivity_evaluations
          SET evaluated_at = $1, outcome = $2
          WHERE inactivity_evaluation_id = $3
            AND outcome IS NULL
        `,
        [input.evaluatedAt, outcome, input.inactivityEvaluationId],
      );
      await client.query("COMMIT");
      return { outcome, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
