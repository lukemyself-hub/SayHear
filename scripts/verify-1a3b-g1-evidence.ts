import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ONE_A_3B_F3_VALIDATOR_LEDGER_VERSION,
  verifyOneA3bF3ReleaseArtifacts,
  verifyOneA3bG1EvidenceArtifact,
  verifyOneA3bG1RoleConfigurationsAgainstF3,
  type OneA3bG1ReleaseManifestInput,
} from "@sayhear/application";

import {
  verifyManifest,
  type AcceptanceManifest,
} from "../eval/continuation-acceptance-1a3b/manifest";
import {
  validateValidatorLedger,
} from "../eval/continuation-acceptance-1a3b/review-package";
import {
  sha256,
  type FixtureCatalog,
  type ValidatorAdjudicationLedger,
} from "../eval/continuation-acceptance-1a3b/protocol";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Refuse release verification or database pin changes from another checkout. */
export function assertRepositoryCommit(
  expectedCommit: string,
  root = repositoryRoot,
): void {
  let actualCommit: string;
  try {
    actualCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      `Unable to verify the release checkout commit: ${error instanceof Error ? error.message : "git rev-parse failed"}`,
    );
  }
  if (actualCommit !== expectedCommit) {
    throw new Error(
      `Release manifest targets commit ${expectedCommit}, but the current checkout is ${actualCommit}.`,
    );
  }
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryFile(
  root: string,
  relativePath: string,
  label: string,
): string {
  if (relativePath.trim() === "" || isAbsolute(relativePath)) {
    throw new Error(`${label} must be a repository-relative path.`);
  }
  const resolved = resolve(root, relativePath);
  const fromRoot = relative(root, resolved);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} must stay inside the repository.`);
  }
  return resolved;
}

function parseJson<T>(bytes: Uint8Array, label: string): T {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }
}

function evidenceDeploymentId(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result = (value as Record<string, unknown>).result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const deploymentId = (result as Record<string, unknown>).deploymentId;
  return typeof deploymentId === "string" && deploymentId.trim() !== ""
    ? deploymentId
    : null;
}

async function readJson<T>(path: string, label: string): Promise<T> {
  return parseJson(await readFile(path), label);
}

type G1EvidenceInput = Pick<
  OneA3bG1ReleaseManifestInput,
  | "gitCommit"
  | "fixture"
  | "validatorCalibration"
  | "evidence"
  | "roleConfigurations"
>;

function verifyEvidenceValues(
  input: G1EvidenceInput,
  root: string,
  f3ManifestBytes: Uint8Array,
  ledgerBytes: Uint8Array,
  f3Manifest: AcceptanceManifest,
  ledger: ValidatorAdjudicationLedger,
  catalog: FixtureCatalog,
): Readonly<{ acceptedCases: number; totalCases: number }> {
  const manifestVerification = verifyManifest(f3Manifest);
  if (!manifestVerification.passed) {
    throw new Error(
      `F3 manifest verification failed: ${manifestVerification.mismatches.join("; ")}`,
    );
  }
  const sharedF3Mismatches = verifyOneA3bF3ReleaseArtifacts({
    manifest: f3Manifest,
    catalog,
    ledger,
  });
  if (sharedF3Mismatches.length > 0) {
    throw new Error(
      `F3 release artifact verification failed: ${sharedF3Mismatches.join("; ")}`,
    );
  }
  const rolePinMismatches = verifyOneA3bG1RoleConfigurationsAgainstF3(
    input.roleConfigurations,
    f3Manifest,
  );
  if (rolePinMismatches.length > 0) {
    throw new Error(
      `G1 role configurations are not the evaluated F3 pins: ${rolePinMismatches.join("; ")}`,
    );
  }
  if (sha256Bytes(f3ManifestBytes) !== input.fixture.f3ManifestSha256) {
    throw new Error("F3 manifest bytes do not match fixture.f3ManifestSha256.");
  }
  if (f3Manifest.fingerprint !== input.fixture.f3ManifestFingerprint) {
    throw new Error("F3 manifest fingerprint does not match the G1 fixture pin.");
  }
  if (f3Manifest.gitCommit !== input.gitCommit) {
    throw new Error("F3 manifest commit does not match the G1 release commit.");
  }
  if (
    f3Manifest.fixtureSeed !== input.fixture.fixtureSeed ||
    f3Manifest.sampleSeed !== input.fixture.sampleSeed
  ) {
    throw new Error("F3 manifest seeds do not match the G1 fixture pins.");
  }
  if (sha256(catalog) !== f3Manifest.catalog.sha256) {
    throw new Error("F3 fixture catalog does not match the F3 manifest.");
  }
  if (ledger.manifestFingerprint !== f3Manifest.fingerprint) {
    throw new Error("Validator calibration ledger does not belong to the F3 manifest.");
  }
  if (
    ledger.version !== ONE_A_3B_F3_VALIDATOR_LEDGER_VERSION ||
    typeof ledger.decidedAt !== "string" ||
    Number.isNaN(new Date(ledger.decidedAt).getTime())
  ) {
    throw new Error("Validator calibration ledger must be the dated released ledger format.");
  }
  if (sha256Bytes(ledgerBytes) !== input.validatorCalibration.ledgerSha256) {
    throw new Error(
      "Validator calibration ledger bytes do not match validatorCalibration.ledgerSha256.",
    );
  }

  const summary = validateValidatorLedger({ catalog, ledger });
  if (
    summary.total !== input.validatorCalibration.totalCases ||
    summary.accepted !== input.validatorCalibration.acceptedCases ||
    summary.maxRejects !== input.validatorCalibration.maxRejects
  ) {
    throw new Error(
      `Validator calibration counts do not match the ledger (${summary.accepted}/${summary.total}, maxRejects ${summary.maxRejects}).`,
    );
  }
  let hostedCanaryDeploymentId: string | null = null;
  let releaseDeploymentId: string | null = null;
  for (const entry of input.evidence) {
    if (entry.status !== "verified") continue;
    const artifactPath = repositoryFile(
      root,
      entry.artifactPath ?? "",
      `${entry.criterion}.artifactPath`,
    );
    const artifactBytes = readFileSync(artifactPath);
    if (sha256Bytes(artifactBytes) !== entry.artifactSha256) {
      throw new Error(
        `${entry.criterion} artifact bytes do not match its artifactSha256.`,
      );
    }
    const artifactValue = parseJson<unknown>(artifactBytes, `${entry.criterion} evidence artifact`);
    const artifactMismatches = verifyOneA3bG1EvidenceArtifact({
      value: artifactValue,
      evidence: entry,
      gitCommit: input.gitCommit,
      f3ManifestFingerprint: f3Manifest.fingerprint,
      fixtureCatalogSha256: f3Manifest.catalog.sha256.slice("sha256:".length),
      knownFixtureIds: new Set(catalog.scenarios.map((fixture) => fixture.id)),
    });
    if (artifactMismatches.length > 0) {
      throw new Error(
        `${entry.criterion} evidence artifact is invalid: ${artifactMismatches.join("; ")}`,
      );
    }
    if (entry.criterion === "AC-W01") {
      hostedCanaryDeploymentId = evidenceDeploymentId(artifactValue);
    } else if (entry.criterion === "AC-D01") {
      releaseDeploymentId = evidenceDeploymentId(artifactValue);
    }
  }
  if (
    !hostedCanaryDeploymentId ||
    !releaseDeploymentId ||
    hostedCanaryDeploymentId !== releaseDeploymentId
  ) {
    throw new Error(
      "AC-W01 hosted Workflow evidence and AC-D01 release evidence must bind the same deployment ID.",
    );
  }
  return { acceptedCases: summary.accepted, totalCases: summary.total };
}

/**
 * Verify the actual F3 files referenced by a G1 release input. The application
 * manifest intentionally stores paths and hashes; this script is the
 * filesystem boundary that proves those references point at the real,
 * synthetic, Luke-owned 18-case ledger rather than a self-attested count.
 */
export async function verifyG1EvidenceFiles(
  input: G1EvidenceInput,
  root = repositoryRoot,
  options: Readonly<{ requireComparisonReady?: boolean }> = {},
): Promise<Readonly<{ acceptedCases: number; totalCases: number }>> {
  const f3ManifestPath = repositoryFile(
    root,
    input.fixture.f3ManifestPath,
    "fixture.f3ManifestPath",
  );
  const ledgerPath = repositoryFile(
    root,
    input.validatorCalibration.ledgerPath,
    "validatorCalibration.ledgerPath",
  );
  const catalogPath = repositoryFile(
    root,
    "eval/continuation-acceptance-1a3b/fixtures.json",
    "F3 fixture catalog path",
  );
  const [f3ManifestBytes, ledgerBytes] = await Promise.all([
    readFile(f3ManifestPath),
    readFile(ledgerPath),
  ]);
  const f3Manifest = await readJson<AcceptanceManifest>(
    f3ManifestPath,
    "F3 manifest",
  );
  const ledger = await readJson<ValidatorAdjudicationLedger>(
    ledgerPath,
    "validator calibration ledger",
  );
  const catalog = await readJson<FixtureCatalog>(catalogPath, "F3 fixture catalog");

  if (
    options.requireComparisonReady === true &&
    (f3Manifest.status !== "ready_for_evaluation" ||
      f3Manifest.comparisonAllowed !== true)
  ) {
    throw new Error(
      "G1 activation requires an F3 manifest with a clean incumbent and comparisonAllowed=true.",
    );
  }

  return verifyEvidenceValues(
    input,
    root,
    f3ManifestBytes,
    ledgerBytes,
    f3Manifest,
    ledger,
    catalog,
  );
}

/**
 * Synchronous counterpart used by server startup. Active G1 cannot be opened
 * from a JSON blob whose evidence fields merely claim to be verified; the
 * deployed checkout must contain the exact hashed F3 artifacts.
 */
export function verifyG1EvidenceFilesSync(
  input: G1EvidenceInput,
  root = repositoryRoot,
): Readonly<{ acceptedCases: number; totalCases: number }> {
  const f3ManifestPath = repositoryFile(
    root,
    input.fixture.f3ManifestPath,
    "fixture.f3ManifestPath",
  );
  const ledgerPath = repositoryFile(
    root,
    input.validatorCalibration.ledgerPath,
    "validatorCalibration.ledgerPath",
  );
  const catalogPath = repositoryFile(
    root,
    "eval/continuation-acceptance-1a3b/fixtures.json",
    "F3 fixture catalog path",
  );
  const f3ManifestBytes = readFileSync(f3ManifestPath);
  const ledgerBytes = readFileSync(ledgerPath);
  const catalogBytes = readFileSync(catalogPath);
  return verifyEvidenceValues(
    input,
    root,
    f3ManifestBytes,
    ledgerBytes,
    parseJson<AcceptanceManifest>(f3ManifestBytes, "F3 manifest"),
    parseJson<ValidatorAdjudicationLedger>(ledgerBytes, "validator calibration ledger"),
    parseJson<FixtureCatalog>(catalogBytes, "F3 fixture catalog"),
  );
}
