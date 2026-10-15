/**
 * Isolation gate for the acceptance runner (T00 #313).
 *
 * Seeding and resetting are destructive, so "is this safe?" is never answered
 * by a flag the operator types. It is answered by three independent facts:
 *
 *  1. configuration identity — the target comes only from dedicated
 *     acceptance/test variables, is on loopback, has a synthetic database name
 *     and is not the application's own configured database. Host, port and
 *     database are the ones the PostgreSQL driver resolves from the connection
 *     string (a `?host=` parameter replaces the URL's host), and a string that
 *     carries a redirecting parameter (host, hostaddr, port, service) or no
 *     host at all is refused;
 *  2. database identity — the run works inside a schema it created itself and
 *     stamped with its own run identity (`acceptance_run_identity`);
 *  3. seed capability — that stamp records the capability the loader needs,
 *     and the only owner in the schema is this run's synthetic identity.
 */

import { resolvePostgresConnectionTarget } from "@sayhear/test-support";

export class IsolationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IsolationError";
  }
}

export const SYNTHETIC_ISSUER = "https://acceptance.sayhear.invalid";
export const SEED_CAPABILITY = "synthetic-history:v1";

export function syntheticSubject(runId: string): string {
  return `continuity-acceptance:${runId}`;
}

export type IsolationTarget = Readonly<{
  databaseName: string;
  databaseUrl: string;
  markerDatabaseName: string;
  markerDatabaseUrl: string;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SYNTHETIC_DATABASE_NAME =
  /^sayhear_(test|acceptance|marker|purge_marker_test)(_[a-z0-9_]+)?$/;

type ParsedTarget = Readonly<{ host: string; name: string; port: string }>;

/**
 * Connection-string parameters that redirect the connection away from the
 * host and port the URL shows. A target that carries one is refused outright,
 * whatever it resolves to, so the gate never has to out-guess the driver.
 */
const REDIRECTING_PARAMETERS = new Set(["host", "hostaddr", "port", "service"]);

const canonicalHost = (host: string): string =>
  host === "localhost" ? "127.0.0.1" : host === "::1" ? "[::1]" : host;

/**
 * The host, port and database the driver would connect to, or null when the
 * string cannot be read as a PostgreSQL URL.
 */
function driverTarget(raw: string): ParsedTarget | null {
  try {
    const target = resolvePostgresConnectionTarget(raw);
    return {
      host: canonicalHost(target.host),
      name: target.database,
      port: target.port || "5432",
    };
  } catch {
    return null;
  }
}

function parse(label: string, raw: string | undefined): ParsedTarget {
  if (!raw) {
    throw new IsolationError(
      `${label} is not set. The acceptance runner only uses SAYHEAR_ACCEPTANCE_DATABASE_URL / SAYHEAR_ACCEPTANCE_MARKER_DATABASE_URL (or TEST_DATABASE_URL / TEST_PURGE_MARKER_DATABASE_URL); it never falls back to DATABASE_URL.`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IsolationError(`${label} is not a valid database URL.`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new IsolationError(`${label} must be a PostgreSQL URL.`);
  }
  for (const parameter of url.searchParams.keys()) {
    if (REDIRECTING_PARAMETERS.has(parameter.toLowerCase())) {
      throw new IsolationError(
        `${label} carries the connection parameter ${JSON.stringify(parameter.toLowerCase())}, which can redirect the connection to another server; the acceptance runner refuses it. Put the host and port in the URL itself.`,
      );
    }
  }
  if (url.hostname === "") {
    throw new IsolationError(
      `${label} names no host; the acceptance runner needs an explicit loopback host and does not take one from the environment.`,
    );
  }
  // Judge where the driver will really connect, not what the URL shows.
  const resolved = driverTarget(raw);
  if (resolved === null) {
    throw new IsolationError(`${label} is not a valid database URL.`);
  }
  const name = resolved.name;
  // Messages name only host and database: credentials are never echoed.
  if (!LOOPBACK_HOSTS.has(resolved.host)) {
    throw new IsolationError(
      `${label} points at host ${resolved.host}; the acceptance runner only seeds a loopback PostgreSQL.`,
    );
  }
  if (
    resolved.host !== canonicalHost(url.hostname) ||
    resolved.port !== (url.port || "5432")
  ) {
    throw new IsolationError(
      `${label} does not connect to the host and port it shows; the acceptance runner refuses it.`,
    );
  }
  if (!SYNTHETIC_DATABASE_NAME.test(name)) {
    throw new IsolationError(
      `${label} names database ${JSON.stringify(name)}, which is not a synthetic test database (expected sayhear_test*, sayhear_acceptance*, sayhear_marker* or sayhear_purge_marker_test*).`,
    );
  }
  return resolved;
}

function sameDatabase(left: ParsedTarget, raw: string | undefined): boolean {
  if (!raw) return false;
  const other = driverTarget(raw);
  return (
    other !== null &&
    other.host === left.host &&
    other.port === left.port &&
    other.name === left.name
  );
}

export function resolveIsolationTarget(environment: Environment): IsolationTarget {
  const databaseUrl =
    environment["SAYHEAR_ACCEPTANCE_DATABASE_URL"] ?? environment["TEST_DATABASE_URL"];
  const markerDatabaseUrl =
    environment["SAYHEAR_ACCEPTANCE_MARKER_DATABASE_URL"] ??
    environment["TEST_PURGE_MARKER_DATABASE_URL"];
  const database = parse("The acceptance database URL", databaseUrl);
  const marker = parse("The acceptance purge-marker database URL", markerDatabaseUrl);
  if (
    database.host === marker.host &&
    database.port === marker.port &&
    database.name === marker.name
  ) {
    throw new IsolationError(
      "The purge-marker store must be a separate database from the acceptance database.",
    );
  }
  for (const [label, target] of [
    ["acceptance database", database],
    ["acceptance purge-marker database", marker],
  ] as const) {
    if (
      sameDatabase(target, environment["DATABASE_URL"]) ||
      sameDatabase(target, environment["PURGE_MARKER_DATABASE_URL"])
    ) {
      throw new IsolationError(
        `The ${label} is the same database as the configured application database; refusing to seed it.`,
      );
    }
  }
  return {
    databaseName: database.name,
    databaseUrl: databaseUrl!,
    markerDatabaseName: marker.name,
    markerDatabaseUrl: markerDatabaseUrl!,
  };
}

export type RunOwnership = Readonly<{
  issuer: string;
  ownerCount: number;
  runId: string;
  seedCapability: string | null;
  subject: string;
}>;

/**
 * The loader may only write where this exact run stamped its identity and
 * where the single owner is this run's synthetic one. A real owner (any
 * non-`.invalid` issuer), another run's schema, or an unstamped schema fails.
 */
export function assertSyntheticOwner(
  ownership: RunOwnership | null,
  runId: string,
): void {
  if (ownership === null) {
    throw new IsolationError(
      "The target schema carries no acceptance run identity; refusing to seed or reset it.",
    );
  }
  if (ownership.runId !== runId) {
    throw new IsolationError(
      "The target schema belongs to a different acceptance run; refusing to seed or reset it.",
    );
  }
  if (ownership.seedCapability !== SEED_CAPABILITY) {
    throw new IsolationError(
      `The target schema does not grant the ${SEED_CAPABILITY} seed capability.`,
    );
  }
  if (
    ownership.issuer !== SYNTHETIC_ISSUER ||
    ownership.subject !== syntheticSubject(runId)
  ) {
    throw new IsolationError(
      "The owner in the target schema is not this run's synthetic identity; refusing to touch a real owner.",
    );
  }
  if (ownership.ownerCount !== 1) {
    throw new IsolationError(
      "The target schema holds users other than this run's synthetic owner.",
    );
  }
}
