import { createPostgresPool } from "../pool";
import { runMigrations } from "../migrations";
import { requiredEnvironment } from "./environment";

const pool = createPostgresPool({
  applicationName: "sayhear-migrate",
  connectionString: requiredEnvironment("DATABASE_URL"),
});

try {
  await runMigrations(pool);
  console.log("SayHear database migrations are current.");
} finally {
  await pool.end();
}
