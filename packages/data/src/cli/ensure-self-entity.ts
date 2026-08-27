import { asUserId } from "@sayhear/domain";

import { createPostgresPool } from "../pool";
import { PostgresEntityRepository } from "../postgres-entity-repository";
import { requiredEnvironment } from "./environment";

// The owner-backoff entry into the one shared ensure-self-entity path
// (SPEC #107, AC 2): run once when the Internal Owner enters 1A.3a, and safe
// to re-run — provisioning converges to the existing binding and never
// creates a second Self Entity.
const pool = createPostgresPool({
  applicationName: "sayhear-ensure-self-entity",
  connectionString: requiredEnvironment("DATABASE_URL"),
});

try {
  const repository = new PostgresEntityRepository(pool);
  const binding = await repository.ensureSelfEntity({
    userId: asUserId(requiredEnvironment("SAYHEAR_INTERNAL_OWNER_USER_ID")),
    now: new Date(),
  });
  console.log(
    binding.created
      ? `Self Entity provisioned: ${binding.entityId}`
      : `Self Entity already present: ${binding.entityId}`,
  );
} finally {
  await pool.end();
}
