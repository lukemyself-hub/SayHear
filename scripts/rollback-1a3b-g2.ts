import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPostgresPool,
  PostgresModelRoleCommandRepository,
} from "@sayhear/data";

import {
  ONE_A_3B_G2_BUNDLE_ROLES,
  verifyOneA3bG2ReleaseManifest,
  type OneA3bModelRole,
  type OneA3bG2ReleaseManifest,
} from "@sayhear/application";
import { assertRepositoryCommit } from "./verify-1a3b-g1-evidence";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const G2_BUNDLE_ROLES = [
  ...ONE_A_3B_G2_BUNDLE_ROLES,
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
      "Usage: pnpm release:g2:rollback --manifest <active-manifest.json> --roles open_loop.extract,proactive.followup",
    );
  }
  return value;
}

function readManifest(path: string): OneA3bG2ReleaseManifest {
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
  const verification = verifyOneA3bG2ReleaseManifest(parsed);
  if (!verification.passed) {
    throw new Error(
      `The rollback manifest is invalid: ${verification.mismatches.join("; ")}`,
    );
  }
  const manifest = parsed as OneA3bG2ReleaseManifest;
  if (manifest.status !== "active" || manifest.cutoverState !== "active") {
    throw new Error("Rollback requires the active G2 release manifest and cutover state.");
  }
  return manifest;
}

function parseRoles(value: string): readonly OneA3bModelRole[] {
  const roles = value.split(",").map((role) => role.trim());
  if (
    roles.length !== G2_BUNDLE_ROLES.length ||
    roles.some(
      (role) =>
        !G2_BUNDLE_ROLES.includes(role as (typeof G2_BUNDLE_ROLES)[number]),
    )
  ) {
    throw new Error(
      `Rollback must revoke the complete G2 bundle exactly once: ${G2_BUNDLE_ROLES.join(", ")}.`,
    );
  }
  const unique = [...new Set(roles)] as OneA3bModelRole[];
  if (unique.length !== G2_BUNDLE_ROLES.length) {
    throw new Error(
      `Rollback must revoke the complete G2 bundle exactly once: ${G2_BUNDLE_ROLES.join(", ")}.`,
    );
  }
  return unique;
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const manifest = readManifest(requiredOption(arguments_, "--manifest"));
  assertRepositoryCommit(manifest.gitCommit, repositoryRoot);
  const roles = parseRoles(requiredOption(arguments_, "--roles"));
  const bundleConfigurations = manifest.roles.configurations.filter(
    (configuration) =>
      (G2_BUNDLE_ROLES as readonly string[]).includes(configuration.role),
  );
  if (
    roles.length !== bundleConfigurations.length ||
    roles.some((role) =>
      !bundleConfigurations.some(
        (configuration) => configuration.role === role,
      )
    )
  ) {
    throw new Error("Rollback roles must match the active manifest's complete G2 bundle.");
  }
  const pool = createPostgresPool({
    applicationName: "sayhear-rollback-g2",
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
      configurations: bundleConfigurations,
      manifestFingerprint: manifest.fingerprint,
    });
    console.log(`[g2-rollback] revoked ${revoked} active rollout pin(s) for ${roles.join(", ")}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    `[g2-rollback] ${error instanceof Error ? error.message : "rollback failed"}`,
  );
  process.exitCode = 1;
});
