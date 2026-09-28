import { createPostgresPool, PostgresModelRoleCommandRepository } from "@sayhear/data";

import {
  assertSafeRuntimeConfiguration,
  resolveOneA3bG1ReleaseManifest,
} from "./runtime-config.ts";

const deployment = assertSafeRuntimeConfiguration(process.env);
const g1WriteSwitchesEnabled =
  process.env.SAYHEAR_EPISODE_BUILD_ENABLED === "true" &&
  process.env.SAYHEAR_REFLECTION_ENABLED === "true";

if (deployment === "production" && g1WriteSwitchesEnabled) {
  const manifest = resolveOneA3bG1ReleaseManifest(process.env);
  if (!manifest || !process.env.DATABASE_URL) {
    throw new Error("Production G1 startup requires its manifest and DATABASE_URL.");
  }
  const pool = createPostgresPool({
    applicationName: "sayhear-g1-startup-verification",
    connectionString: process.env.DATABASE_URL,
  });
  try {
    await new PostgresModelRoleCommandRepository(
      pool,
      manifest.schema,
      manifest.fingerprint,
    ).verifyActiveG1Release({ configurations: manifest.roles.configurations });
  } finally {
    await pool.end();
  }
}
