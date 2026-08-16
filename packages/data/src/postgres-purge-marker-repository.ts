import type {
  PurgeMarkerRepository,
  PurgeMarkerSnapshot,
} from "@sayhear/application";
import type { UserId } from "@sayhear/domain";
import type { Pool } from "pg";

type MarkerRow = Readonly<{
  data_epoch: string;
  status: string;
  purged_at: Date;
  backup_retention_until: Date | null;
  receipts: unknown;
  written_at: Date;
}>;

/**
 * Purge marker store backed by a SEPARATE PostgreSQL database
 * (PURGE_MARKER_DATABASE_URL) outside the business database's backup domain.
 * The marker carries only the deletion epoch, time, and content-free receipts
 * (issue #28, architecture 20.6).
 */
export class PostgresPurgeMarkerRepository implements PurgeMarkerRepository {
  public constructor(private readonly pool: Pool) {}

  public async writeMarker(input: {
    userId: UserId;
    dataEpoch: number;
    purgedAt: Date;
    backupRetentionUntil: Date | null;
    receipts: readonly Readonly<{
      destination: string;
      destinationDisposition: string;
      providerRetentionUntil: Date | null;
    }>[];
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO purge_markers (
          user_id, data_epoch, status, purged_at,
          backup_retention_until, receipts
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (user_id) DO UPDATE
        SET data_epoch = EXCLUDED.data_epoch,
            status = EXCLUDED.status,
            purged_at = EXCLUDED.purged_at,
            backup_retention_until = EXCLUDED.backup_retention_until,
            receipts = EXCLUDED.receipts,
            written_at = EXCLUDED.written_at
        WHERE purge_markers.data_epoch < EXCLUDED.data_epoch
      `,
      [
        input.userId,
        input.dataEpoch,
        "retention_pending",
        input.purgedAt,
        input.backupRetentionUntil,
        JSON.stringify(
          input.receipts.map((receipt) => ({
            destination: receipt.destination,
            destinationDisposition: receipt.destinationDisposition,
            ...(receipt.providerRetentionUntil
              ? {
                  providerRetentionUntil:
                    receipt.providerRetentionUntil.toISOString(),
                }
              : {}),
          })),
        ),
      ],
    );
  }

  public async findLatestMarker(input: {
    userId: UserId;
  }): Promise<PurgeMarkerSnapshot | null> {
    const result = await this.pool.query<MarkerRow>(
      `
        SELECT data_epoch::text, status, purged_at,
          backup_retention_until, receipts, written_at
        FROM purge_markers
        WHERE user_id = $1
        ORDER BY data_epoch DESC
        LIMIT 1
      `,
      [input.userId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      backupRetentionUntil: row.backup_retention_until,
      dataEpoch: Number(row.data_epoch),
      purgedAt: row.purged_at,
      receipts: Array.isArray(row.receipts)
        ? (row.receipts as Readonly<Record<string, unknown>>[]).map(
            (receipt) => ({
              destination: String(receipt.destination ?? ""),
              destinationDisposition: String(
                receipt.destinationDisposition ?? "unknown",
              ),
              providerRetentionUntil: receipt.providerRetentionUntil
                ? new Date(String(receipt.providerRetentionUntil))
                : null,
            }),
          )
        : [],
      status: row.status as "active_system_deleted" | "retention_pending",
      writtenAt: row.written_at,
    };
  }

  public async findMarker(input: {
    userId: UserId;
    dataEpoch: number;
  }): Promise<PurgeMarkerSnapshot | null> {
    const marker = await this.findLatestMarker({ userId: input.userId });
    return marker?.dataEpoch === input.dataEpoch ? marker : null;
  }
}
