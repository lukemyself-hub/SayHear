import { createPostgresPool } from "../pool";
import {
  purgeMarkerMigrationsDirectory,
  runMigrations,
} from "../migrations";
import { requiredEnvironment } from "./environment";

const pool = createPostgresPool({
  applicationName: "sayhear-migrate",
  connectionString: requiredEnvironment("DATABASE_URL"),
});

try {
  await runMigrations(pool);
  console.log("SayHear database migrations are current.");

  // The purge marker store is a separate database on the same PostgreSQL
  // instance, outside the business backup domain (issue #27, architecture
  // 20.6). Migrate it with its own minimal migration path whenever it is
  // configured; without it the operator purge endpoint fails closed at
  // runtime configuration load.
  const purgeMarkerDatabaseUrl = process.env.PURGE_MARKER_DATABASE_URL;
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
} finally {
  await pool.end();
}
