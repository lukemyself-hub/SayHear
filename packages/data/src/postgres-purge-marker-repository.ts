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
 * (issue #27, architecture 20.6).
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
        ON CONFLICT (user_id, data_epoch) DO NOTHING
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

  public async findMarker(input: {
    userId: UserId;
    dataEpoch: number;
  }): Promise<PurgeMarkerSnapshot | null> {
    const result = await this.pool.query<MarkerRow>(
      `
        SELECT data_epoch::text, status, purged_at,
          backup_retention_until, receipts, written_at
        FROM purge_markers
        WHERE user_id = $1 AND data_epoch = $2
      `,
      [input.userId, input.dataEpoch],
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
}
