import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import {
  verifyOneA3bG1ReleaseManifest,
  type OneA3bG1ReleaseManifest,
} from "@sayhear/application";
import {
  assertRepositoryCommit,
  verifyG1EvidenceFiles,
} from "./verify-1a3b-g1-evidence";

const repositoryRoot = resolve(import.meta.dirname, "..");

function requiredOption(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = index === -1 ? undefined : arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Usage: pnpm release:g1:verify --manifest <manifest.json>`);
  }
  return value;
}

async function main(): Promise<void> {
  const manifestPath = resolve(
    repositoryRoot,
    requiredOption(process.argv.slice(2), "--manifest"),
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const verification = verifyOneA3bG1ReleaseManifest(manifest);
  if (!verification.passed) {
    throw new Error(`G1 release manifest verification failed: ${verification.mismatches.join("; ")}`);
  }
  const verifiedManifest = manifest as OneA3bG1ReleaseManifest;
  assertRepositoryCommit(verifiedManifest.gitCommit, repositoryRoot);
  await verifyG1EvidenceFiles({
    gitCommit: verifiedManifest.gitCommit,
    fixture: verifiedManifest.fixture,
    validatorCalibration: verifiedManifest.validatorCalibration,
    evidence: verifiedManifest.evidence,
    roleConfigurations: verifiedManifest.roles.configurations,
  }, repositoryRoot, { requireComparisonReady: true });
  console.log("[g1-manifest] verified");
}

main().catch((error: unknown) => {
  console.error(
    `[g1-manifest] ${error instanceof Error ? error.message : "verification failed"}`,
  );
  process.exitCode = 1;
});
