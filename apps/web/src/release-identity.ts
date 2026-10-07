import { timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@sayhear/application";

/**
 * The content-free identity an acceptance deployment reports about itself.
 *
 * ADR-0144 requires the hosted acceptance evidence to prove it came from the
 * approved isolated project rather than trusting the verifier process's
 * environment variables. This endpoint answers with the deployment's own
 * commit, Vercel project/team and hashed database targets only: it never
 * returns a connection string, credential, or other private value.
 */
export const HOSTED_RELEASE_IDENTITY_VERSION =
  "1a3b-g1-hosted-release-identity:v1";

type Environment = Readonly<Record<string, string | undefined>>;

/** Normalize a Postgres URL to a credential-free target identity. */
export function normalizeDatabaseIdentity(value: string): string {
  const url = new URL(value);
  return `${url.hostname.replace(/-pooler(?=\.)/, "")}:${url.port || "5432"}${url.pathname}`;
}

export type HostedReleaseIdentity = Readonly<{
  businessTargetHash: string;
  commit: string;
  environment: string | null;
  projectId: string;
  purgeMarkerTargetHash: string;
  teamId: string | null;
  version: string;
}>;

export function buildHostedReleaseIdentity(
  environment: Environment,
): HostedReleaseIdentity {
  const databaseUrl = environment.DATABASE_URL?.trim();
  const markerUrl = environment.PURGE_MARKER_DATABASE_URL?.trim();
  if (!databaseUrl || !markerUrl) {
    throw new Error(
      "Hosted release identity requires both business and purge-marker databases.",
    );
  }
  if (normalizeDatabaseIdentity(databaseUrl) === normalizeDatabaseIdentity(markerUrl)) {
    throw new Error(
      "Hosted release identity requires distinct business and purge-marker databases.",
    );
  }
  const commit =
    environment.SAYHEAR_DEPLOYED_GIT_COMMIT_SHA?.trim() ||
    environment.VERCEL_GIT_COMMIT_SHA?.trim();
  if (!commit) {
    throw new Error("Hosted release identity requires the deployed commit.");
  }
  const projectId =
    environment.SAYHEAR_HOSTED_PROJECT_ID?.trim() ||
    environment.VERCEL_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error("Hosted release identity requires the Vercel project id.");
  }
  return {
    businessTargetHash: sha256Hex(normalizeDatabaseIdentity(databaseUrl)),
    commit,
    environment: environment.VERCEL_ENV?.trim() || null,
    projectId,
    purgeMarkerTargetHash: sha256Hex(normalizeDatabaseIdentity(markerUrl)),
    teamId:
      environment.SAYHEAR_HOSTED_TEAM_ID?.trim() ||
      environment.VERCEL_ORG_ID?.trim() ||
      null,
    version: HOSTED_RELEASE_IDENTITY_VERSION,
  };
}

/** Existing Cron operator credential may read only this content-free witness. */
export function isReleaseIdentityOperatorRequest(request: Request, secret: string | undefined): boolean {
  const header = request.headers.get("authorization");
  if (!secret || !header) return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
