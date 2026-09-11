import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

const migrationsRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

export const businessMigrationsDirectory = migrationsRoot;
export const purgeMarkerMigrationsDirectory = join(
  migrationsRoot,
  "../migrations-purge-marker",
);

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function runMigrations(
  pool: Pool,
  options: Readonly<{ migrationsDirectory?: string }> = {},
): Promise<void> {
  const migrationsDirectory =
    options.migrationsDirectory ?? businessMigrationsDirectory;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_name TEXT PRIMARY KEY,
        migration_sha256 TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Existing databases created before migration hashes were recorded cannot
    // be proven to match the current SQL. Leave them closed rather than
    // blessing a self-attested backfill.
    await client.query(
      "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS migration_sha256 TEXT",
    );

    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const migrationName of migrationNames) {
      const sql = await readFile(join(migrationsDirectory, migrationName));
      const migrationSha256 = sha256Bytes(sql);
      const applied = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM schema_migrations WHERE migration_name = $1
         ) AS exists`,
        [migrationName],
      );

      if (applied.rows[0]?.exists) {
        const recorded = await client.query<{ migration_sha256: string | null }>(
          "SELECT migration_sha256 FROM schema_migrations WHERE migration_name = $1",
          [migrationName],
        );
        const recordedSha256 = recorded.rows[0]?.migration_sha256;
        if (recordedSha256 === null || recordedSha256 === undefined) {
          throw new Error(
            `Migration ${migrationName} has no recorded hash; refusing exact-schema verification.`,
          );
        } else if (recordedSha256 !== migrationSha256) {
          throw new Error(
            `Migration ${migrationName} changed after it was applied.`,
          );
        }
        continue;
      }

      await client.query(sql.toString("utf8"));
      await client.query(
        "INSERT INTO schema_migrations (migration_name, migration_sha256) VALUES ($1, $2)",
        [migrationName, migrationSha256],
      );
    }

    await client.query(
      "ALTER TABLE schema_migrations ALTER COLUMN migration_sha256 SET NOT NULL",
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
