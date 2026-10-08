import { createPostgresPool } from "../../packages/data/src/pool.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export type TestDatabaseTarget = Readonly<{
  target: string;
  url: string;
}>;

export type TestDatabaseEnvironment = Readonly<{
  business: TestDatabaseTarget;
  purgeMarker: TestDatabaseTarget;
}>;

/**
 * Credential-free identity of a test database, in the same shape the deployed
 * two-database guard uses (`normalizeDatabaseIdentity`): a pooled endpoint and
 * its direct twin, or an explicit and a defaulted port, are one database.
 */
export function normalizeTestDatabaseTarget(value: string): string {
  const url = new URL(value);
  return `${url.hostname.replace(/-pooler(?=\.)/, "")}:${url.port || "5432"}${url.pathname}`;
}

function requireTestDatabaseUrl(
  environment: Environment,
  variable: string,
): string {
  const value = environment[variable]?.trim();
  if (!value) {
    throw new Error(
      `${variable} is required; the CI database check never falls back to a shared or in-memory database.`,
    );
  }
  return value;
}

/**
 * Resolve the two independent test databases a PR validation run needs. The
 * business and Purge Marker stores are separate databases by contract (issue
 * #27, architecture 20.6), so a misconfigured pair must fail before any system
 * suite runs rather than silently skipping the suites that prove the split.
 */
export function resolveTestDatabaseEnvironment(
  environment: Environment,
): TestDatabaseEnvironment {
  const businessUrl = requireTestDatabaseUrl(
    environment,
    "TEST_DATABASE_URL",
  );
  const purgeMarkerUrl = requireTestDatabaseUrl(
    environment,
    "TEST_PURGE_MARKER_DATABASE_URL",
  );
  const business = {
    target: normalizeTestDatabaseTarget(businessUrl),
    url: businessUrl,
  };
  const purgeMarker = {
    target: normalizeTestDatabaseTarget(purgeMarkerUrl),
    url: purgeMarkerUrl,
  };
  if (business.target === purgeMarker.target) {
    throw new Error(
      `TEST_PURGE_MARKER_DATABASE_URL must name a separate database; both variables resolve to ${business.target}.`,
    );
  }
  return { business, purgeMarker };
}

export type TestDatabaseProbe = Readonly<{
  database: string;
  leftoverTestSchemas: number;
}>;

export type TestDatabaseProbes = Readonly<{
  business: TestDatabaseProbe;
  purgeMarker: TestDatabaseProbe;
}>;

export type TestDatabaseReadiness = Readonly<{
  business: TestDatabaseProbe & { target: string };
  purgeMarker: TestDatabaseProbe & { target: string };
}>;

/**
 * The pre-run contract for the two independent temporary PostgreSQL services.
 * A reachable connection is not enough: the server itself has to report two
 * different databases, and neither may still hold `sayhear_test_*` schemas from
 * an earlier aborted run, because a stale schema would hand a system suite a
 * database that is not its own.
 */
export function assertTestDatabasesAreReady(
  probes: TestDatabaseProbes,
): void {
  const { business, purgeMarker } = probes;
  if (business.database === purgeMarker.database) {
    throw new Error(
      `Both test database variables reach the same database ${business.database}; the business and Purge Marker stores must be separate.`,
    );
  }
  for (const [role, probe] of [
    ["business", business],
    ["Purge Marker", purgeMarker],
  ] as const) {
    if (probe.leftoverTestSchemas > 0) {
      throw new Error(
        `The ${role} test database ${probe.database} still holds ${probe.leftoverTestSchemas} leftover sayhear_test_* schema(s) from an earlier run; start from empty databases.`,
      );
    }
  }
}

/** Credential-free one-line summary, so CI output never echoes a password. */
export function formatTestDatabaseReadiness(
  readiness: TestDatabaseReadiness,
): string {
  return [
    `business test database ${readiness.business.target} reported database=${readiness.business.database}`,
    `purge marker test database ${readiness.purgeMarker.target} reported database=${readiness.purgeMarker.database}`,
  ].join("; ");
}

/** Bound the TCP connect so an unreachable runner fails instead of hanging. */
function withConnectDeadline(url: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("connectionTimeoutMillis")) {
    parsed.searchParams.set("connectionTimeoutMillis", "5000");
  }
  return parsed.toString();
}

export async function probeTestDatabase(
  target: TestDatabaseTarget,
): Promise<TestDatabaseProbe> {
  const pool = createPostgresPool({
    applicationName: "sayhear-ci-test-database-check",
    connectionString: withConnectDeadline(target.url),
  });
  try {
    const result = await pool.query<{
      database: string;
      leftover_test_schemas: string;
    }>(
      "select current_database() as database, (select count(*) from information_schema.schemata where schema_name like 'sayhear\\_test\\_%') as leftover_test_schemas",
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("the probe query returned no row");
    }
    return {
      database: row.database,
      leftoverTestSchemas: Number(row.leftover_test_schemas),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The test database ${target.target} is unreachable: ${reason}`,
      { cause: error },
    );
  } finally {
    await pool.end();
  }
}