import { asUserId } from "@sayhear/domain";

import { createPostgresPool } from "../pool";
import { PostgresInternalOwnerAccessRepository } from "../postgres-internal-owner-access-repository";
import { requiredEnvironment } from "./environment";

const pool = createPostgresPool({
  applicationName: "sayhear-provision-owner",
  connectionString: requiredEnvironment("DATABASE_URL"),
});

try {
  const repository = new PostgresInternalOwnerAccessRepository(pool);
  await repository.provisionInternalOwner({
    issuer: requiredEnvironment("SAYHEAR_INTERNAL_OWNER_ISSUER"),
    subject: requiredEnvironment("SAYHEAR_INTERNAL_OWNER_SUBJECT"),
    userId: asUserId(requiredEnvironment("SAYHEAR_INTERNAL_OWNER_USER_ID")),
  });
  console.log("The Internal Owner identity mapping is provisioned.");
} finally {
  await pool.end();
}
