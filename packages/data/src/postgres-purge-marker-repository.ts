import {
  matchFrozenPrefixSchemaContract,
  registeredSchemaExtensions,
  type PurgeMarkerRepository,
  type PurgeMarkerSnapshot,
  type OneA3bG1ReleaseManifest,
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
  public constructor(
    private readonly pool: Pool,
    private readonly schemaContract?: Pick<
      OneA3bG1ReleaseManifest["schema"],
      "purgeMarkerMigrations" | "purgeMarkerFingerprint"
    >,
  ) {}

  private async assertSchemaContract(): Promise<void> {
    if (!this.schemaContract) return;
    const applied = await this.pool.query<{
      migration_name: string;
      migration_sha256: string;
    }>(
      `SELECT migration_name, migration_sha256
       FROM schema_migrations
       ORDER BY migration_name`,
    );
    const match = matchFrozenPrefixSchemaContract({
      expected: this.schemaContract.purgeMarkerMigrations,
      applied: applied.rows.map((row) => ({
        name: row.migration_name,
        sha256: row.migration_sha256,
      })),
      extensions: registeredSchemaExtensions("purge-marker"),
    });
    if (!match.matches) {
      throw new Error(
        `Purge-marker schema does not match the frozen G1 migration contract ${this.schemaContract.purgeMarkerFingerprint}.`,
      );
    }
  }

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
    await this.assertSchemaContract();
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
    await this.assertSchemaContract();
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
