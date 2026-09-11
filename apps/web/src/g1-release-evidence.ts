import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  verifyOneA3bF3ReleaseArtifacts,
  verifyOneA3bG1EvidenceArtifact,
  verifyOneA3bG1RoleConfigurationsAgainstF3,
  type OneA3bG1ReleaseManifest,
} from "@sayhear/application";

type JsonObject = Record<string, unknown>;

const F3_MANIFEST_VERSION = "1a3b-f3-manifest:v1";
const F3_CATALOG_VERSION = "1a3b-f3-fixtures:v1";
const F3_LEDGER_VERSION = "1a3b-f3-adjudication:v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Cannot hash a non-JSON value.");
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryFile(root: string, path: unknown, label: string): string {
  if (typeof path !== "string" || path.trim() === "" || isAbsolute(path)) {
    throw new Error(`${label} must be a repository-relative path.`);
  }
  const resolved = resolve(root, path);
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

function readJson(path: string, label: string): JsonObject {
  const bytes = readFileSync(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed;
}

function rejectProductionSource(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectProductionSource(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
    if (
      [
        "database",
        "databaseurl",
        "connectionstring",
        "connectionurl",
        "privatesource",
        "productionsource",
        "productiondata",
        "providercredential",
        "credential",
        "apikey",
        "accesstoken",
        "userid",
      ].includes(normalized)
    ) {
      throw new Error(`${path}.${key} is not allowed in a synthetic release artifact.`);
    }
    rejectProductionSource(entry, `${path}.${key}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

/**
 * Verify the evidence bytes that an active G1 server is about to trust. The
 * release CLI performs the full F3 verifier; this server-side copy deliberately
 * has no eval-package import so the web project can fail closed at startup.
 */
export function verifyActiveG1Evidence(
  manifest: OneA3bG1ReleaseManifest,
  roots: readonly string[],
): Readonly<{ acceptedCases: number; totalCases: number }> {
  let lastError: unknown;
  for (const root of roots) {
    try {
      return verifyActiveG1EvidenceAtRoot(manifest, root);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `G1 evidence files could not be verified in any deployed checkout: ${lastError instanceof Error ? lastError.message : "verification failed"}`,
  );
}

function verifyActiveG1EvidenceAtRoot(
  manifest: OneA3bG1ReleaseManifest,
  root: string,
): Readonly<{ acceptedCases: number; totalCases: number }> {
  const f3ManifestPath = repositoryFile(
    root,
    manifest.fixture.f3ManifestPath,
    "fixture.f3ManifestPath",
  );
  const ledgerPath = repositoryFile(
    root,
    manifest.validatorCalibration.ledgerPath,
    "validatorCalibration.ledgerPath",
  );
  const catalogPath = repositoryFile(
    root,
    "eval/continuation-acceptance-1a3b/fixtures.json",
    "F3 fixture catalog path",
  );
  const f3ManifestBytes = readFileSync(f3ManifestPath);
  const ledgerBytes = readFileSync(ledgerPath);
  const f3Manifest = readJson(f3ManifestPath, "F3 manifest");
  const ledger = readJson(ledgerPath, "validator calibration ledger");
  const catalog = readJson(catalogPath, "F3 fixture catalog");

  rejectProductionSource(f3Manifest, "F3 manifest");
  rejectProductionSource(ledger, "validator calibration ledger");
  rejectProductionSource(catalog, "F3 fixture catalog");
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
  if (
    f3Manifest.status !== "ready_for_evaluation" ||
    f3Manifest.comparisonAllowed !== true
  ) {
    throw new Error(
      "Active G1 requires an F3 manifest with a clean incumbent and comparisonAllowed=true.",
    );
  }
  const rolePinMismatches = verifyOneA3bG1RoleConfigurationsAgainstF3(
    manifest.roles.configurations,
    f3Manifest,
  );
  if (rolePinMismatches.length > 0) {
    throw new Error(
      `G1 role configurations are not the evaluated F3 pins: ${rolePinMismatches.join("; ")}`,
    );
  }
  if (sha256Bytes(f3ManifestBytes) !== manifest.fixture.f3ManifestSha256) {
    throw new Error("F3 manifest bytes do not match the G1 fixture pin.");
  }
  if (sha256Bytes(ledgerBytes) !== manifest.validatorCalibration.ledgerSha256) {
    throw new Error("Validator ledger bytes do not match the G1 calibration pin.");
  }
  if (f3Manifest.version !== F3_MANIFEST_VERSION) {
    throw new Error("F3 manifest version is not the released version.");
  }
  const { fingerprint: f3Fingerprint, ...f3WithoutFingerprint } = f3Manifest;
  if (
    typeof f3Fingerprint !== "string" ||
    sha256({ ...f3WithoutFingerprint, createdAt: "volatile" }) !== f3Fingerprint
  ) {
    throw new Error("F3 manifest fingerprint does not match its content.");
  }
  if (f3Fingerprint !== manifest.fixture.f3ManifestFingerprint) {
    throw new Error("F3 manifest fingerprint does not match the G1 fixture pin.");
  }
  if (f3Manifest.gitCommit !== manifest.gitCommit) {
    throw new Error("F3 manifest commit does not match the G1 release commit.");
  }
  if (
    f3Manifest.fixtureSeed !== manifest.fixture.fixtureSeed ||
    f3Manifest.sampleSeed !== manifest.fixture.sampleSeed
  ) {
    throw new Error("F3 manifest seeds do not match the G1 fixture pins.");
  }
  if (
    !isRecord(f3Manifest.catalog) ||
    f3Manifest.catalog.version !== F3_CATALOG_VERSION ||
    f3Manifest.catalog.sha256 !== sha256(catalog)
  ) {
    throw new Error("F3 fixture catalog does not match the F3 manifest.");
  }
  const f3CatalogFingerprint = requiredString(
    isRecord(f3Manifest.catalog) ? f3Manifest.catalog.sha256 : "",
    "F3 catalog fingerprint",
  );
  const f3ManifestFingerprint = requiredString(
    f3Fingerprint,
    "F3 manifest fingerprint",
  );

  if (
    ledger.version !== F3_LEDGER_VERSION ||
    ledger.group !== "validator" ||
    ledger.manifestFingerprint !== f3Fingerprint ||
    ledger.adjudicator !== "Luke" ||
    typeof ledger.decidedAt !== "string" ||
    Number.isNaN(new Date(ledger.decidedAt).getTime()) ||
    !Array.isArray(ledger.entries)
  ) {
    throw new Error("Validator calibration ledger is not a dated Luke ledger for this F3 manifest.");
  }
  const scenarios = Array.isArray(catalog.scenarios) ? catalog.scenarios : [];
  const validatorIds = scenarios
    .filter((scenario) => isRecord(scenario) && scenario.group === "validator")
    .map((scenario) => requiredString(scenario.id, "validator fixture ID"));
  if (validatorIds.length !== 18) {
    throw new Error("F3 validator catalog must contain exactly 18 fixtures.");
  }
  const expectedIds = new Set(validatorIds);
  const seenIds = new Set<string>();
  let acceptedCases = 0;
  for (const entry of ledger.entries) {
    if (!isRecord(entry)) throw new Error("Validator ledger contains a non-object entry.");
    const fixtureId = requiredString(entry.fixtureId, "validator ledger fixture ID");
    if (!expectedIds.has(fixtureId) || seenIds.has(fixtureId)) {
      throw new Error(`Validator ledger has an unknown or duplicate fixture ${fixtureId}.`);
    }
    if (entry.verdict !== "accepted" && entry.verdict !== "rejected") {
      throw new Error(`Validator ledger has an invalid verdict for ${fixtureId}.`);
    }
    if ("machineVerdict" in entry) {
      throw new Error("Machine verdicts cannot replace Luke's adjudication.");
    }
    seenIds.add(fixtureId);
    if (entry.verdict === "accepted") acceptedCases += 1;
  }
  if (seenIds.size !== expectedIds.size) {
    throw new Error("Validator calibration ledger does not cover all 18 F3 fixtures.");
  }
  if (
    acceptedCases !== manifest.validatorCalibration.acceptedCases ||
    manifest.validatorCalibration.totalCases !== 18
  ) {
    throw new Error("Validator calibration counts do not match the G1 manifest.");
  }

  const artifactPaths = new Set<string>();
  const knownFixtureIds = new Set(
    scenarios.flatMap((scenario) =>
      isRecord(scenario) && typeof scenario.id === "string" ? [scenario.id] : [],
    ),
  );
  for (const entry of manifest.evidence) {
    if (entry.status !== "verified") {
      throw new Error(`${entry.criterion} is not verified in the active G1 manifest.`);
    }
    if (
      typeof entry.artifactSha256 !== "string" ||
      !SHA256_PATTERN.test(entry.artifactSha256) ||
      typeof entry.artifactPath !== "string" ||
      entry.artifactPath.trim() === ""
    ) {
      throw new Error(`${entry.criterion} has no content-addressed evidence artifact.`);
    }
    const artifactPath = repositoryFile(
      root,
      entry.artifactPath,
      `${entry.criterion}.artifactPath`,
    );
    if (artifactPaths.has(artifactPath)) {
      throw new Error(`G1 evidence artifact ${entry.artifactPath} is reused.`);
    }
    artifactPaths.add(artifactPath);
    if (sha256Bytes(readFileSync(artifactPath)) !== entry.artifactSha256) {
      throw new Error(`${entry.criterion} artifact bytes do not match its hash.`);
    }
    const artifactMismatches = verifyOneA3bG1EvidenceArtifact({
      value: readJson(artifactPath, `${entry.criterion} evidence artifact`),
      evidence: entry,
      gitCommit: manifest.gitCommit,
      f3ManifestFingerprint,
      fixtureCatalogSha256: f3CatalogFingerprint,
      knownFixtureIds,
    });
    if (artifactMismatches.length > 0) {
      throw new Error(
        `${entry.criterion} evidence artifact is invalid: ${artifactMismatches.join("; ")}`,
      );
    }
  }

  return { acceptedCases, totalCases: seenIds.size };
}
