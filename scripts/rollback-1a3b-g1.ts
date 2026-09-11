import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPostgresPool,
  PostgresModelRoleCommandRepository,
} from "@sayhear/data";

import {
  verifyOneA3bG1ReleaseManifest,
  type OneA3bModelRole,
  type OneA3bG1ReleaseManifest,
} from "@sayhear/application";
import { assertRepositoryCommit } from "./verify-1a3b-g1-evidence";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const G1_ROLES = [
  "episode.build",
  "reflection.daily",
  "reflection.weekly",
  "narrative.validate",
] as const satisfies readonly OneA3bModelRole[];

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required server configuration: ${name}`);
  }
  return value;
}

function requiredOption(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = index === -1 ? undefined : arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(
      "Usage: pnpm release:g1:rollback --manifest <active-manifest.json> --roles episode.build,reflection.daily,reflection.weekly,narrative.validate",
    );
  }
  return value;
}

function readManifest(path: string): OneA3bG1ReleaseManifest {
  const manifestPath = isAbsolute(path) ? path : resolve(repositoryRoot, path);
  const fromRoot = relative(repositoryRoot, manifestPath);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error("--manifest must point to a file inside the repository.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read --manifest: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
  const verification = verifyOneA3bG1ReleaseManifest(parsed);
  if (!verification.passed) {
    throw new Error(
      `The rollback manifest is invalid: ${verification.mismatches.join("; ")}`,
    );
  }
  const manifest = parsed as OneA3bG1ReleaseManifest;
  if (manifest.status !== "active" || manifest.cutoverState !== "active") {
    throw new Error("Rollback requires the active G1 release manifest and cutover state.");
  }
  return manifest;
}

function parseRoles(value: string): readonly OneA3bModelRole[] {
  const roles = value.split(",").map((role) => role.trim());
  if (
    roles.length !== G1_ROLES.length ||
    roles.some(
      (role) =>
        !G1_ROLES.includes(role as (typeof G1_ROLES)[number]),
    )
  ) {
    throw new Error(
      `Rollback must revoke the complete G1 role set exactly once: ${G1_ROLES.join(", ")}.`,
    );
  }
  const unique = [...new Set(roles)] as OneA3bModelRole[];
  if (unique.length !== G1_ROLES.length) {
    throw new Error(
      `Rollback must revoke the complete G1 role set exactly once: ${G1_ROLES.join(", ")}.`,
    );
  }
  return unique;
}

const arguments_ = process.argv.slice(2);
const manifest = readManifest(requiredOption(arguments_, "--manifest"));
assertRepositoryCommit(manifest.gitCommit, repositoryRoot);
const roles = parseRoles(requiredOption(arguments_, "--roles"));
if (
  roles.length !== manifest.roles.enabledRoles.length ||
  roles.some((role) => !manifest.roles.enabledRoles.includes(role))
) {
  throw new Error("Rollback roles must match the active manifest's complete G1 role set.");
}
const pool = createPostgresPool({
  applicationName: "sayhear-rollback-g1",
  connectionString: requiredEnvironment("DATABASE_URL"),
});

try {
  const revoked = await new PostgresModelRoleCommandRepository(
    pool,
    manifest.schema,
    manifest.fingerprint,
  ).revokeActiveRolloutPins({
    now: new Date(),
    roles,
    configurations: manifest.roles.configurations,
    manifestFingerprint: manifest.fingerprint,
  });
  console.log(`[g1-rollback] revoked ${revoked} active rollout pin(s) for ${roles.join(", ")}.`);
} finally {
  await pool.end();
}
