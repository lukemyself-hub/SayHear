import { assertHostedWorkflowCanaryEvidence, type WorkflowCanaryArtifacts, type WorkflowCanaryValues } from "./hosted-workflow-canary-gate";
import { verifyCompletionCapture } from "./validator-completion";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
  ONE_A_3B_F3_VALIDATOR_PRECISION_FIXTURE_IDS,
  ONE_A_3B_F3_VALIDATOR_PRECISION_REPORT_VERSION,
  buildG1ReleaseIdentityFingerprint,
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

/**
 * Refuse release verification or database pin changes from a checkout that
 * does not contain the accepted commit.
 *
 * ADR-0148: a new UI or server commit with unchanged G1 configuration reuses
 * the accepted manifest and pins. The operator may therefore verify or roll
 * back from a later commit, as long as the manifest's acceptance commit is in
 * the current checkout history. The accepted commit itself still passes.
 */
export function assertRepositoryIncludesCommit(
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
  if (actualCommit === expectedCommit) return;
  let containsAcceptedCommit = false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", expectedCommit, "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    containsAcceptedCommit = true;
  } catch {
    containsAcceptedCommit = false;
  }
  if (!containsAcceptedCommit) {
    throw new Error(
      `Release manifest targets commit ${expectedCommit}, which is not contained in the current checkout ${actualCommit}.`,
    );
  }
}

/**
 * @deprecated Use {@link assertRepositoryIncludesCommit}. Kept so existing
 * release tooling keeps one exact implementation.
 */
export const assertRepositoryCommit = assertRepositoryIncludesCommit;

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

export function verifyValidatorPrecisionReport(input: Readonly<{
  report: unknown;
  manifestFingerprint: string;
  expectedFixtureIds?: readonly string[] | undefined;
  expectedCapture?: Parameters<typeof verifyCompletionCapture>[0]["expected"];
  configuration?: Parameters<typeof verifyCompletionCapture>[0]["configuration"];
}>): Readonly<{ falseBlockingCases: number; totalCases: number }> {
  if (input.report === null || typeof input.report !== "object" || Array.isArray(input.report)) {
    throw new Error("Validator precision report must be an object.");
  }
  const report = input.report as Record<string, unknown>;
  if (input.expectedCapture && (
    report.gitCommit !== input.expectedCapture.gitCommit || report.gitDirty !== false ||
    report.catalogSha256 !== input.expectedCapture.catalogSha256 ||
    report.pinsFingerprint !== input.expectedCapture.pinsFingerprint ||
    (input.configuration && (
      report.provider !== input.configuration.provider || report.model !== input.configuration.model ||
      report.modelSnapshot !== input.configuration.modelSnapshot || report.promptVersion !== input.configuration.promptVersion ||
      report.schemaVersion !== input.configuration.schemaVersion ||
      sha256(report.parameters) !== sha256(input.configuration.parameterSnapshot)
    ))
  )) throw new Error("Precision capture does not match the frozen code and role identity.");
  if (report.version !== ONE_A_3B_F3_VALIDATOR_PRECISION_REPORT_VERSION) {
    throw new Error("Validator precision report version is not the released version.");
  }
  if (report.manifestFingerprint !== input.manifestFingerprint) {
    throw new Error("Validator precision report does not belong to the F3 manifest.");
  }
  if (!Array.isArray(report.cases)) {
    throw new Error("Validator precision report cases must be an array.");
  }

  const expectedIds = new Set<string>(
    input.expectedFixtureIds ?? ONE_A_3B_F3_VALIDATOR_PRECISION_FIXTURE_IDS,
  );
  if (expectedIds.size !== 6 || (input.expectedFixtureIds && input.expectedFixtureIds.length !== 6)) {
    throw new Error("Frozen precision catalog must contain six unique fixture IDs.");
  }
  const seenIds = new Set<string>();
  let falseBlockingCases = 0;
  for (const value of report.cases) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Validator precision report contains a non-object case.");
    }
    const entry = value as Record<string, unknown>;
    if (input.expectedCapture && (
      typeof entry.generationCommandId !== "string" || !entry.generationCommandId ||
      typeof entry.modelRunAttemptId !== "string" || !entry.modelRunAttemptId
    )) throw new Error("Precision capture has no real command/attempt identity.");
    const fixtureId = typeof entry.fixtureId === "string" ? entry.fixtureId : "";
    if (!expectedIds.has(fixtureId) || seenIds.has(fixtureId)) {
      throw new Error(
        `Validator precision report has an unknown or duplicate fixture ${fixtureId}.`,
      );
    }
    seenIds.add(fixtureId);
    if (entry.outcome !== "completed") {
      throw new Error(`Validator precision fixture ${fixtureId} is not completed.`);
    }
    if (entry.verdict !== "accepted" && entry.verdict !== "blocked") {
      throw new Error(`Validator precision fixture ${fixtureId} has an invalid verdict.`);
    }
    if (
      !Array.isArray(entry.blockingFindingCodes) ||
      entry.blockingFindingCodes.some((code) => typeof code !== "string")
    ) {
      throw new Error(
        `Validator precision fixture ${fixtureId} has invalid blocking finding codes.`,
      );
    }
    if (entry.verdict === "blocked" || entry.blockingFindingCodes.length > 0) {
      falseBlockingCases += 1;
    }
  }
  if (seenIds.size !== expectedIds.size) {
    throw new Error("Validator precision report does not cover every frozen fixture exactly once.");
  }
  // ADR-0143: verdict mix is observational; completed, identified cases gate.
  return { falseBlockingCases, totalCases: seenIds.size };
}

export function verifyValidatorPrecisionReportArtifact(input: Readonly<{
  bytes: Uint8Array;
  expectedSha256: string;
  manifestFingerprint: string;
  expectedFixtureIds?: readonly string[] | undefined;
  expectedCapture?: Parameters<typeof verifyCompletionCapture>[0]["expected"];
  configuration?: Parameters<typeof verifyCompletionCapture>[0]["configuration"];
}>): Readonly<{ falseBlockingCases: number; totalCases: number }> {
  if (sha256Bytes(input.bytes) !== input.expectedSha256) {
    throw new Error(
      "Validator precision report bytes do not match validatorCalibration.precisionReportSha256.",
    );
  }
  return verifyValidatorPrecisionReport({
    report: parseJson<unknown>(input.bytes, "validator precision report"),
    manifestFingerprint: input.manifestFingerprint,
    expectedFixtureIds: input.expectedFixtureIds,
    expectedCapture: input.expectedCapture,
    configuration: input.configuration,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Re-scan linked raw data at the final verifier, not only a passed summary. */
export function verifyHostedCanaryArtifact(value: unknown, root: string): void {
  if (!isRecord(value) || !isRecord(value.result)) throw new Error("Hosted canary result is missing.");
  const result = value.result;
  const readReference = (reference: unknown, name: string): unknown => {
    if (!isRecord(reference) || typeof reference.path !== "string" || typeof reference.sha256 !== "string") throw new Error(`Hosted ${name} reference is missing.`);
    const bytes = readFileSync(repositoryFile(root, reference.path, `hosted ${name}`));
    if (sha256Bytes(bytes) !== reference.sha256) throw new Error(`Hosted ${name} bytes do not match their hash.`);
    return parseJson<unknown>(bytes, `hosted ${name}`);
  };
  const runIds = result.expectedRunIds;
  if (typeof result.deploymentId !== "string" || !Array.isArray(runIds) || !runIds.length || runIds.some(id => typeof id !== "string" || !/^wrun_[A-Za-z0-9]+$/.test(id)) || new Set(runIds).size !== runIds.length) throw new Error("Hosted canary lacks deployment and complete run-set pins.");
  assertHostedWorkflowCanaryEvidence(
    readReference(result.exportArtifact, "export") as WorkflowCanaryArtifacts,
    readReference(result.canaryValuesArtifact, "values") as WorkflowCanaryValues,
    { deploymentId: result.deploymentId, runIds: runIds as string[] },
  );
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

function evidenceReleaseIdentity(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result = (value as Record<string, unknown>).result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const identity = (result as Record<string, unknown>).releaseIdentityFingerprint;
  return typeof identity === "string" && identity.trim() !== "" ? identity : null;
}

function currentMigrationPinsSync(directory: string): readonly { name: string; sha256: string }[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      sha256: createHash("sha256")
        .update(readFileSync(resolve(directory, name)))
        .digest("hex"),
    }));
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
  precisionReportBytes: Uint8Array,
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
    (ledger.version !== ONE_A_3B_F3_VALIDATOR_LEDGER_VERSION && ledger.version !== "1a3b-f3-completion:v1") ||
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
  const precisionSummary = verifyValidatorPrecisionReportArtifact({
    bytes: precisionReportBytes,
    expectedSha256: input.validatorCalibration.precisionReportSha256,
    manifestFingerprint: f3Manifest.fingerprint,
    expectedFixtureIds: catalog.precisionDrafts?.map((draft) => draft.id),
    expectedCapture: {
      catalogSha256: f3Manifest.catalog.sha256,
      gitCommit: f3Manifest.gitCommit,
      pinsFingerprint: f3Manifest.pins.sha256,
    },
    configuration: input.roleConfigurations.find(configuration => configuration.role === "narrative.validate"),
  });
  if (
    input.validatorCalibration.precisionReportVersion !==
      ONE_A_3B_F3_VALIDATOR_PRECISION_REPORT_VERSION ||
    precisionSummary.totalCases !== input.validatorCalibration.precisionTotalCases ||
    precisionSummary.falseBlockingCases !==
      input.validatorCalibration.precisionFalseBlockingCases
  ) {
    throw new Error("Validator precision report summary does not match the G1 calibration pin.");
  }

  verifyCompletionCapture({
    ledger,
    catalog,
    root,
    configuration: input.roleConfigurations.find(
      (configuration) => configuration.role === "narrative.validate",
    ),
    expected: {
      catalogSha256: f3Manifest.catalog.sha256,
      gitCommit: f3Manifest.gitCommit,
      pinsFingerprint: f3Manifest.pins.sha256,
    },
  });
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
  const expectedReleaseIdentity = buildG1ReleaseIdentityFingerprint({
    gitCommit: input.gitCommit,
    migrations: currentMigrationPinsSync(resolve(root, "packages/data/migrations")),
    purgeMarkerMigrations: currentMigrationPinsSync(
      resolve(root, "packages/data/migrations-purge-marker"),
    ),
    roleConfigurations: input.roleConfigurations,
    fixture: input.fixture,
  });
  let hostedCanaryDeploymentId: string | null = null;
  let releaseDeploymentId: string | null = null;
  let releaseIdentity: string | null = null;
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
      verifyHostedCanaryArtifact(artifactValue, root);
      hostedCanaryDeploymentId = evidenceDeploymentId(artifactValue);
    } else if (entry.criterion === "AC-D01") {
      releaseDeploymentId = evidenceDeploymentId(artifactValue);
      releaseIdentity = evidenceReleaseIdentity(artifactValue);
    }
  }
  if (!releaseIdentity || releaseIdentity !== expectedReleaseIdentity) {
    throw new Error(
      "AC-D01 release evidence must bind the computed release identity fingerprint.",
    );
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
  const precisionReportPath = repositoryFile(
    root,
    input.validatorCalibration.precisionReportPath,
    "validatorCalibration.precisionReportPath",
  );
  const catalogPath = repositoryFile(
    root,
    input.fixture.catalogPath ?? "eval/continuation-acceptance-1a3b/fixtures.json",
    "F3 fixture catalog path",
  );
  const [f3ManifestBytes, ledgerBytes, precisionReportBytes] = await Promise.all([
    readFile(f3ManifestPath),
    readFile(ledgerPath),
    readFile(precisionReportPath),
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
    precisionReportBytes,
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
  const precisionReportPath = repositoryFile(
    root,
    input.validatorCalibration.precisionReportPath,
    "validatorCalibration.precisionReportPath",
  );
  const catalogPath = repositoryFile(
    root,
    input.fixture.catalogPath ?? "eval/continuation-acceptance-1a3b/fixtures.json",
    "F3 fixture catalog path",
  );
  const f3ManifestBytes = readFileSync(f3ManifestPath);
  const ledgerBytes = readFileSync(ledgerPath);
  const precisionReportBytes = readFileSync(precisionReportPath);
  const catalogBytes = readFileSync(catalogPath);
  return verifyEvidenceValues(
    input,
    root,
    f3ManifestBytes,
    ledgerBytes,
    precisionReportBytes,
    parseJson<AcceptanceManifest>(f3ManifestBytes, "F3 manifest"),
    parseJson<ValidatorAdjudicationLedger>(ledgerBytes, "validator calibration ledger"),
    parseJson<FixtureCatalog>(catalogBytes, "F3 fixture catalog"),
  );
}
