import type {
  LeasedOutboxEvent,
  OutboxDispatcherRepository,
} from "@sayhear/application";
import {
  asDailySessionId,
  asOutboxEventId,
  asWorkflowCommandId,
  type DailySessionId,
  type OutboxEventId,
} from "@sayhear/domain";
import type { Pool, QueryResultRow } from "pg";

type OutboxRow = Readonly<{
  outbox_event_id: string;
  workflow_command_id: string;
  aggregate_id: string;
  // aggregate_revision is BIGINT, which node-postgres always returns as a
  // string regardless of the value's size.
  aggregate_revision: string;
  event_type: string;
  payload: unknown;
}>;

function mapLeased(row: OutboxRow): LeasedOutboxEvent {
  let payload: Record<string, unknown> = {};
  if (typeof row.payload === "string") {
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  } else if (typeof row.payload === "object" && row.payload !== null) {
    payload = row.payload as Record<string, unknown>;
  }
  return {
    outboxEventId: asOutboxEventId(row.outbox_event_id),
    workflowCommandId: asWorkflowCommandId(row.workflow_command_id),
    aggregateId: asDailySessionId(row.aggregate_id) as DailySessionId,
    // Production incident 2026-08-17: leaking the BIGINT string here made the
    // Journal eligibility Workflow receive sourceRevision="20", so the strict
    // stale fence (20 !== "20") threw on every durable retry and the Journal
    // never published.
    aggregateRevision: Number(row.aggregate_revision),
    eventType: row.event_type,
    payload,
  };
}

export class PostgresOutboxDispatcherRepository
  implements OutboxDispatcherRepository
{
  public constructor(private readonly pool: Pool) {}

  public async leasePendingBatch(input: {
    now: Date;
    leaseDurationMs: number;
    leaseOwner: string;
    limit: number;
  }): Promise<readonly LeasedOutboxEvent[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const leased = await client.query<OutboxRow>(
        `
          SELECT outbox_event_id, workflow_command_id,
            aggregate_id, aggregate_revision, event_type, payload
          FROM outbox_events
          WHERE status = 'pending'
            AND next_attempt_at <= $1
          ORDER BY next_attempt_at, outbox_event_id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        `,
        [input.now, input.limit],
      );
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseDurationMs);
      for (const row of leased.rows) {
        await client.query<QueryResultRow>(
          `
            UPDATE outbox_events
            SET status = 'leased',
                lease_owner = $1,
                lease_expires_at = $2,
                attempt_count = attempt_count + 1
            WHERE outbox_event_id = $3
              AND status = 'pending'
          `,
          [input.leaseOwner, leaseExpiresAt, row.outbox_event_id],
        );
      }
      await client.query("COMMIT");
      return leased.rows.map(mapLeased);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async reclaimExpiredLeases(input: {
    now: Date;
    leaseDurationMs: number;
    leaseOwner: string;
    limit: number;
  }): Promise<readonly LeasedOutboxEvent[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<OutboxRow>(
        `
          SELECT outbox_event_id, workflow_command_id,
            aggregate_id, aggregate_revision, event_type, payload
          FROM outbox_events
          WHERE status = 'leased'
            AND lease_expires_at < $1
          ORDER BY lease_expires_at, outbox_event_id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        `,
        [input.now, input.limit],
      );
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseDurationMs);
      const reclaimed: OutboxRow[] = [];
      for (const row of expired.rows) {
        const update = await client.query<QueryResultRow>(
          `
            UPDATE outbox_events
            SET status = 'leased',
                lease_owner = $1,
                lease_expires_at = $2,
                attempt_count = attempt_count + 1
            WHERE outbox_event_id = $3
              AND status = 'leased'
              AND lease_expires_at < $4
            RETURNING outbox_event_id
          `,
          [input.leaseOwner, leaseExpiresAt, row.outbox_event_id, input.now],
        );
        if (update.rowCount === 1) {
          reclaimed.push(row);
        }
      }
      await client.query("COMMIT");
      return reclaimed.map(mapLeased);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async markDispatched(input: {
    outboxEventId: OutboxEventId;
    workflowReceiptId: string;
  }): Promise<void> {
    // Only the lease holder may record a receipt. A reclaim race that re-leased
    // this row to another owner must not overwrite the first receipt (AC #7).
    await this.pool.query<QueryResultRow>(
      `
        UPDATE outbox_events
        SET status = 'dispatched',
            workflow_receipt_id = $1,
            last_error_code = NULL
        WHERE outbox_event_id = $2
          AND status = 'leased'
      `,
      [input.workflowReceiptId, input.outboxEventId],
    );
  }

  public async markFailed(input: {
    outboxEventId: OutboxEventId;
    errorCode: string;
    nextAttemptAt: Date;
  }): Promise<void> {
    await this.pool.query<QueryResultRow>(
      `
        UPDATE outbox_events
        SET status = 'pending',
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_attempt_at = $1,
            last_error_code = $2
        WHERE outbox_event_id = $3
          AND status = 'leased'
      `,
      [input.nextAttemptAt, input.errorCode, input.outboxEventId],
    );
  }
}
