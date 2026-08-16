import { createPostgresPool } from "../pool";
import {
  purgeMarkerMigrationsDirectory,
  runMigrations,
} from "../migrations";

const businessDatabaseUrl = process.env.DATABASE_URL;
// The purge marker store is a separate database on the same PostgreSQL
// instance, outside the business backup domain (issue #27, architecture
// 20.6). Each configured database migrates independently, so the marker
// store can be provisioned on its own (`PURGE_MARKER_DATABASE_URL=...
// pnpm db:migrate`).
const purgeMarkerDatabaseUrl = process.env.PURGE_MARKER_DATABASE_URL;

if (!businessDatabaseUrl && !purgeMarkerDatabaseUrl) {
  throw new Error(
    "Missing required server configuration: DATABASE_URL (or set PURGE_MARKER_DATABASE_URL to migrate only the purge marker store).",
  );
}
if (
  businessDatabaseUrl &&
  purgeMarkerDatabaseUrl &&
  businessDatabaseUrl.trim() === purgeMarkerDatabaseUrl.trim()
) {
  throw new Error(
    "PURGE_MARKER_DATABASE_URL must point to a separate database, not the business DATABASE_URL.",
  );
}

if (businessDatabaseUrl) {
  const pool = createPostgresPool({
    applicationName: "sayhear-migrate",
    connectionString: businessDatabaseUrl,
  });
  try {
    await runMigrations(pool);
    console.log("SayHear database migrations are current.");
  } finally {
    await pool.end();
  }
}

if (purgeMarkerDatabaseUrl) {
  const purgeMarkerPool = createPostgresPool({
    applicationName: "sayhear-migrate-purge-marker",
    connectionString: purgeMarkerDatabaseUrl,
  });
  try {
    await runMigrations(purgeMarkerPool, {
      migrationsDirectory: purgeMarkerMigrationsDirectory,
    });
    console.log("SayHear purge marker store migrations are current.");
  } finally {
    await purgeMarkerPool.end();
  }
}
