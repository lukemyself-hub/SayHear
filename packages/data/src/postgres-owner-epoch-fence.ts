import type { PoolClient } from "pg";

/**
 * Lock the authoritative owner row and capture its current epoch for a new
 * Durable Command. Callers must keep the same transaction open through the
 * command/outbox writes so a Full Purge cannot advance the owner between the
 * admission check and the frozen payload.
 */
export async function lockActiveOwnerEpoch(
  client: PoolClient,
  userId: string,
): Promise<number | null> {
  const result = await client.query<{ status: string; data_epoch: string }>(
    `SELECT status, data_epoch::text AS data_epoch
     FROM app_users
     WHERE user_id = $1
     FOR UPDATE`,
    [userId],
  );
  const owner = result.rows[0];
  if (!owner || owner.status !== "active") return null;
  return Number(owner.data_epoch);
}
