import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ONE_A_3B_G2_BUNDLE_ROLES,
  verifyOneA3bG2ReleaseManifest,
  type OneA3bG2ReleaseManifest,
} from "@sayhear/application";
import {
  createPostgresPool,
  PostgresModelRoleCommandRepository,
} from "@sayhear/data";

import { assertRepositoryCommit } from "./verify-1a3b-g1-evidence";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required server configuration: ${name}`);
  }
  return value;
}

function requiredManifestPath(arguments_: readonly string[]): string {
  const index = arguments_.indexOf("--manifest");
  const value = index === -1 ? undefined : arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("Usage: pnpm release:g2:activate --manifest <active-manifest.json>");
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
      `The activation manifest is invalid: ${verification.mismatches.join("; ")}`,
    );
  }
  const manifest = parsed as OneA3bG2ReleaseManifest;
  if (manifest.status !== "active" || manifest.cutoverState !== "active") {
    throw new Error("Activation requires an active G2 release manifest and cutover state.");
  }
  return manifest;
}

async function main(): Promise<void> {
  const manifest = readManifest(
    requiredManifestPath(process.argv.slice(2)),
  );
  assertRepositoryCommit(manifest.gitCommit, repositoryRoot);
  // Layer 2a scope: structural verification only; evidence-file re-hashing
  // lands with layer-3 evidence production before any real activation.
  const bundleConfigurations = manifest.roles.configurations.filter(
    (configuration) =>
      (ONE_A_3B_G2_BUNDLE_ROLES as readonly string[]).includes(
        configuration.role,
      ),
  );
  const pool = createPostgresPool({
    applicationName: "sayhear-activate-g2",
    connectionString: requiredEnvironment("DATABASE_URL"),
  });

  try {
    const activated = await new PostgresModelRoleCommandRepository(
      pool,
      manifest.schema,
    ).bindActiveG2Release({
      configurations: bundleConfigurations,
      manifestFingerprint: manifest.fingerprint,
      baseG1ReleaseFingerprint: manifest.baseG1ReleaseFingerprint,
      now: new Date(),
    });
    console.log(
      `[g2-activate] activated ${activated} rollout pin(s) for ${manifest.fingerprint}.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    `[g2-activate] ${error instanceof Error ? error.message : "activation failed"}`,
  );
  process.exitCode = 1;
});
