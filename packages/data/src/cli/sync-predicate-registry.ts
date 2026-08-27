import { loadPredicateRegistrySnapshot } from "@sayhear/application";

import {
  PostgresPredicateRegistryRepository,
} from "../postgres-predicate-registry-repository";
import { createPostgresPool } from "../pool";
import { requiredEnvironment } from "./environment";

// Owner release entry for the code-owned Predicate Registry (§7.10.1; SPEC
// #107 AC 8). Safe to re-run: the sync converges the released version's rows
// to the TypeScript snapshot and never touches other registry_versions.
const pool = createPostgresPool({
  applicationName: "sayhear-sync-predicate-registry",
  connectionString: requiredEnvironment("DATABASE_URL"),
});

try {
  const registry = loadPredicateRegistrySnapshot(1);
  const repository = new PostgresPredicateRegistryRepository(pool);
  const result = await repository.syncPredicateRegistry(registry, new Date());
  console.log(
    `Predicate Registry v${result.registryVersion} synced: ${result.entries} entries, ` +
      `${result.localizations} localizations, ${result.relationshipProjections} projections, ` +
      `${result.relations} relations.`,
  );
} finally {
  await pool.end();
}
