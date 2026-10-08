import {
  assertTestDatabasesAreReady,
  formatTestDatabaseReadiness,
  probeTestDatabase,
  resolveTestDatabaseEnvironment,
  type TestDatabaseReadiness,
} from "./test-databases.ts";

async function main(): Promise<void> {
  const resolved = resolveTestDatabaseEnvironment(process.env);
  const readiness: TestDatabaseReadiness = {
    business: {
      target: resolved.business.target,
      ...(await probeTestDatabase(resolved.business)),
    },
    purgeMarker: {
      target: resolved.purgeMarker.target,
      ...(await probeTestDatabase(resolved.purgeMarker)),
    },
  };
  assertTestDatabasesAreReady(readiness);
  console.log(formatTestDatabaseReadiness(readiness));
}

main().catch((error: unknown) => {
  console.error(
    `::error::${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});