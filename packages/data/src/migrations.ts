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
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const migrationName of migrationNames) {
      const applied = await client.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE migration_name = $1) AS exists",
        [migrationName],
      );

      if (applied.rows[0]?.exists) {
        continue;
      }

      const sql = await readFile(join(migrationsDirectory, migrationName), "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (migration_name) VALUES ($1)",
        [migrationName],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
