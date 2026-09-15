import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import {
  verifyOneA3bG2ReleaseManifest,
  type OneA3bG2ReleaseManifest,
} from "@sayhear/application";
import { assertRepositoryCommit } from "./verify-1a3b-g1-evidence";

const repositoryRoot = resolve(import.meta.dirname, "..");

function requiredOption(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = index === -1 ? undefined : arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Usage: pnpm release:g2:verify --manifest <manifest.json>`);
  }
  return value;
}

async function main(): Promise<void> {
  const manifestPath = resolve(
    repositoryRoot,
    requiredOption(process.argv.slice(2), "--manifest"),
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const verification = verifyOneA3bG2ReleaseManifest(manifest);
  if (!verification.passed) {
    throw new Error(`G2 release manifest verification failed: ${verification.mismatches.join("; ")}`);
  }
  const verifiedManifest = manifest as OneA3bG2ReleaseManifest;
  assertRepositoryCommit(verifiedManifest.gitCommit, repositoryRoot);
  // Layer 2a scope: structural verification plus checkout binding only.
  // Evidence-file re-hashing lands with layer-3 evidence production.
  console.log("[g2-manifest] verified");
}

main().catch((error: unknown) => {
  console.error(
    `[g2-manifest] ${error instanceof Error ? error.message : "verification failed"}`,
  );
  process.exitCode = 1;
});
