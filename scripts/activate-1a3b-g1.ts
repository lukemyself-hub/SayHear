import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyOneA3bG1ReleaseManifest,
  type OneA3bG1ReleaseManifest,
} from "@sayhear/application";
import {
  createPostgresPool,
  PostgresModelRoleCommandRepository,
} from "@sayhear/data";

import {
  assertRepositoryCommit,
  verifyG1EvidenceFiles,
} from "./verify-1a3b-g1-evidence";

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
    throw new Error("Usage: pnpm release:g1:activate --manifest <active-manifest.json>");
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
      `The activation manifest is invalid: ${verification.mismatches.join("; ")}`,
    );
  }
  const manifest = parsed as OneA3bG1ReleaseManifest;
  if (manifest.status !== "active" || manifest.cutoverState !== "active") {
    throw new Error("Activation requires an active G1 release manifest and cutover state.");
  }
  return manifest;
}

async function main(): Promise<void> {
  const manifest = readManifest(
    requiredManifestPath(process.argv.slice(2)),
  );
  assertRepositoryCommit(manifest.gitCommit, repositoryRoot);
  await verifyG1EvidenceFiles(
    {
      gitCommit: manifest.gitCommit,
      fixture: manifest.fixture,
      validatorCalibration: manifest.validatorCalibration,
      evidence: manifest.evidence,
      roleConfigurations: manifest.roles.configurations,
    },
    repositoryRoot,
    { requireComparisonReady: true },
  );
  const pool = createPostgresPool({
    applicationName: "sayhear-activate-g1",
    connectionString: requiredEnvironment("DATABASE_URL"),
  });

  try {
    const bound = await new PostgresModelRoleCommandRepository(
      pool,
      manifest.schema,
    ).bindActiveG1Release({
      configurations: manifest.roles.configurations,
      manifestFingerprint: manifest.fingerprint,
      now: new Date(),
    });
    console.log(
      `[g1-activate] bound ${bound} active rollout pin(s) to ${manifest.fingerprint}.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    `[g1-activate] ${error instanceof Error ? error.message : "activation failed"}`,
  );
  process.exitCode = 1;
});
