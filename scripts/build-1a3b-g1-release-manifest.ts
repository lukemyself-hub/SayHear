import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

import {
  buildOneA3bG1ReleaseManifest,
  type OneA3bG1ReleaseManifestInput,
} from "@sayhear/application";
import {
  repositoryRoot,
  verifyG1EvidenceFiles,
} from "./verify-1a3b-g1-evidence";

const execFileAsync = promisify(execFile);
const migrationDirectory = resolve(repositoryRoot, "packages/data/migrations");
const purgeMarkerMigrationDirectory = resolve(
  repositoryRoot,
  "packages/data/migrations-purge-marker",
);
const defaultOutput = resolve(
  repositoryRoot,
  "eval/continuation-acceptance-1a3b/run/g1-release-manifest.json",
);

type InputDocument = Omit<
  OneA3bG1ReleaseManifestInput,
  "gitCommit" | "migrations" | "purgeMarkerMigrations"
> & {
  gitCommit?: string;
};

function option(arguments_: readonly string[], name: string): string | null {
  const index = arguments_.indexOf(name);
  if (index === -1) return null;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function gitOutput(...arguments_: string[]): Promise<string> {
  const result = await execFileAsync("git", arguments_, { cwd: repositoryRoot });
  return result.stdout.trim();
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function currentMigrationPins(directory: string) {
  const sqlFiles = (await readdir(directory)).filter((name) =>
    name.endsWith(".sql"),
  );
  const invalidNames = sqlFiles.filter(
    (name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name),
  );
  if (invalidNames.length > 0) {
    throw new Error(
      `Migration directory contains invalid SQL filenames: ${invalidNames.join(", ")}`,
    );
  }
  const names = sqlFiles.sort((left, right) => left.localeCompare(right));
  return Promise.all(
    names.map(async (name) => {
      const contents = await readFile(resolve(directory, name));
      return { name, sha256: sha256Bytes(contents) };
    }),
  );
}

async function readInput(path: string): Promise<InputDocument> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read G1 manifest input ${path}: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("G1 manifest input must be a JSON object.");
  }
  return parsed as InputDocument;
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const inputPath = option(arguments_, "--input");
  if (!inputPath) {
    throw new Error(
      "Usage: pnpm release:g1:build --input <review-input.json> [--output <manifest.json>] [--git-commit <sha>]",
    );
  }
  const outputPath = resolve(
    repositoryRoot,
    option(arguments_, "--output") ?? defaultOutput,
  );
  const input = await readInput(inputPath);
  const explicitCommit = option(arguments_, "--git-commit") ?? input.gitCommit;
  const workingTreeStatus = await gitOutput("status", "--short");
  if (workingTreeStatus !== "") {
    throw new Error(
      "The working tree must be clean before freezing a G1 release manifest.",
    );
  }
  const currentCommit = await gitOutput("rev-parse", "HEAD");
  const gitCommit = explicitCommit ?? currentCommit;
  if (gitCommit !== currentCommit) {
    throw new Error(
      `The requested G1 commit ${gitCommit} is not the current checkout ${currentCommit}.`,
    );
  }
  await verifyG1EvidenceFiles({
    gitCommit,
    fixture: input.fixture,
    validatorCalibration: input.validatorCalibration,
    evidence: input.evidence,
    roleConfigurations: input.roleConfigurations,
  });
  const manifest = buildOneA3bG1ReleaseManifest({
    ...input,
    gitCommit,
    migrations: await currentMigrationPins(migrationDirectory),
    purgeMarkerMigrations: await currentMigrationPins(
      purgeMarkerMigrationDirectory,
    ),
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `[g1-manifest] ${manifest.status}; git ${manifest.gitCommit}; fingerprint ${manifest.fingerprint}`,
  );
  console.log(`[g1-manifest] wrote ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(
    `[g1-manifest] ${error instanceof Error ? error.message : "build failed"}`,
  );
  process.exitCode = 1;
});
