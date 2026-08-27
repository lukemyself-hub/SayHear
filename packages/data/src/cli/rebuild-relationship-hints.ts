import { asMemoryClaimId, asUserId } from "@sayhear/domain";

import { loadPredicateRegistrySnapshot } from "@sayhear/application";

import { createPostgresPool } from "../pool";
import {
  PostgresMemoryClaimRepository,
  rebuildRelationshipResolverHintsWithin,
} from "../postgres-memory-claim-repository";
import { requiredEnvironment } from "./environment";

// Rebuildable-projection maintenance entry (ADR-0027, #115): regenerate every
// relationship claim's Resolver Hint rows from its CURRENT version. Safe to
// re-run — the rebuild deletes + reinserts each claim's rows, and hints are
// non-authoritative projections that never feed identity or Evidence.
const pool = createPostgresPool({
  applicationName: "sayhear-rebuild-relationship-hints",
  connectionString: requiredEnvironment("DATABASE_URL"),
});

try {
  const repository = new PostgresMemoryClaimRepository(pool);
  const claims = await repository.listRelationshipClaims();
  const snapshot = loadPredicateRegistrySnapshot(1);
  const userId = asUserId(requiredEnvironment("SAYHEAR_INTERNAL_OWNER_USER_ID"));
  let rebuiltRows = 0;
  for (const claim of claims) {
    const entry = snapshot.entries.find(
      (candidate) => candidate.predicateId === claim.predicateId,
    );
    if (!entry) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await rebuildRelationshipResolverHintsWithin(client, {
        userId,
        claimId: claim.memoryClaimId,
        hints: {
          entry,
          projections: snapshot.relationshipProjections,
          localizations: snapshot.localizations,
        },
        now: new Date(),
      });
      await client.query("COMMIT");
      rebuiltRows += rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  console.log(
    `Rebuilt ${rebuiltRows} Resolver Hint rows across ${claims.length} relationship claims.`,
  );
} finally {
  await pool.end();
}
