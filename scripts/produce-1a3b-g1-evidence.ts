/**
 * Assemble the twelve typed G1 evidence artifacts from independently verified
 * source documents. A source document is either one JSON object or an entry in
 * `evidence`/`entries` with criterion, fixtureIds, command, owner, source,
 * runId, artifactPath, artifactSha256, verification `{ passed, command }`,
 * and a metadata-only `result` containing that criterion's required fields.
 * Missing or self-attested evidence is reported as blocked, never promoted.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  ONE_A_3B_G1_EVIDENCE_CONTRACTS,
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA,
  ONE_A_3B_G1_ROLE_CONFIG_VERSIONS,
  ONE_A_3B_G1_ROLLOUT_PIN_VERSION,
  ONE_A_3B_F3_VALIDATOR_PRECISION_REPORT_VERSION,
  ONE_A_3B_ROLE_POLICIES,
  ONE_A_3B_ROLE_POLICY_VERSION,
  buildG1ReleaseIdentityFingerprint,
  verifyOneA3bF3ReleaseArtifacts,
  verifyOneA3bG1EvidenceArtifact,
  verifyOneA3bG1RoleConfigurationsAgainstF3,
  type ModelRoleConfigurationSnapshot,
  type OneA3bG1AcceptanceCriterion,
  type OneA3bG1Evidence,
  type OneA3bG1EvidenceSource,
  type OneA3bG1ValidatorCalibration,
} from "@sayhear/application";

import {
  validateValidatorLedger,
} from "../eval/continuation-acceptance-1a3b/review-package";
import {
  verifySyntheticSourceBoundary,
} from "../eval/continuation-acceptance-1a3b/manifest";
import {
  sha256,
  type FixtureCatalog,
  type ValidatorAdjudicationLedger,
} from "../eval/continuation-acceptance-1a3b/protocol";
import { verifyValidatorPrecisionReport } from "./verify-1a3b-g1-evidence";

const execFileAsync = promisify(execFile);

const repositoryRoot = resolve(import.meta.dirname, "..");
const defaultCatalogPath =
  "eval/continuation-acceptance-1a3b/fixtures.json";
const defaultF3ManifestPath =
  "eval/continuation-acceptance-1a3b/run/manifest.json";
const defaultLedgerPath =
  "eval/continuation-acceptance-1a3b/run/validator-ledger.json";
const defaultPrecisionReportPath =
  "eval/continuation-acceptance-1a3b/run/validator-precision-report.json";
const defaultSourceBundlePath =
  "eval/continuation-acceptance-1a3b/run/g1-evidence-sources.json";
const defaultSourceDirectory =
  "eval/continuation-acceptance-1a3b/run/evidence-sources";
const defaultEvidenceDirectory =
  "eval/continuation-acceptance-1a3b/run/evidence";
const defaultManifestInputPath =
  "eval/continuation-acceptance-1a3b/run/g1-release-manifest-input.json";
const defaultReportPath =
  "eval/continuation-acceptance-1a3b/run/g1-evidence-production-report.json";
const defaultHardGatePath =
  "eval/continuation-acceptance-1a3b/run/continuation-incumbent-hard-gates.json";
const defaultHostedArtifactPath =
  "eval/continuation-acceptance-1a3b/run/hosted-canary/artifacts.json";
const defaultHostedValuesPath =
  "eval/continuation-acceptance-1a3b/run/hosted-canary/values.env.json";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const EVIDENCE_SOURCES = new Set<OneA3bG1EvidenceSource>([
  "local",
  "ci",
  "hosted",
  "provider",
  "human",
]);

type JsonObject = Record<string, unknown>;

type Options = Readonly<{
  catalogPath: string;
  f3ManifestPath: string;
  ledgerPath: string;
  precisionReportPath: string;
  sourceBundlePath: string;
  sourceDirectory: string;
  evidenceDirectory: string;
  manifestInputPath: string;
  reportPath: string;
  hardGatePath: string;
  hostedArtifactPath: string;
  hostedValuesPath: string;
}>;

type ReadDocument = Readonly<{
  path: string;
  bytes: Uint8Array | null;
  value: unknown;
  error: string | null;
}>;

type ValidatorCheck = Readonly<{
  acceptedCases: number | null;
  ledgerSha256: string | null;
  maxRejects: number | null;
  note: string | null;
  rejectedCases: number | null;
  precisionFalseBlockingCases: number | null;
  precisionReportSha256: string | null;
  precisionTotalCases: number | null;
  status: "verified" | "blocked";
  totalCases: number | null;
}>;

type RoleCheck = Readonly<{
  configurations: readonly ModelRoleConfigurationSnapshot[];
  mismatches: readonly string[];
}>;

type HardGateCheck = Readonly<{
  artifactSha256: string | null;
  failures: readonly string[];
  note: string | null;
  passed: boolean;
  path: string;
}>;

type HostedCanaryCheck = Readonly<{
  artifactSha256: string | null;
  canaryRunId: string | null;
  note: string | null;
  passed: boolean;
  path: string;
}>;

type SourceEvidence = Readonly<{
  artifactPath: string;
  artifactSha256: string;
  command: string;
  criterion: OneA3bG1AcceptanceCriterion;
  fixtureIds: readonly string[];
  owner: string;
  result: JsonObject;
  runId: string;
  source: OneA3bG1EvidenceSource;
  verificationCommand: string;
}>;

type SourceCollection = Readonly<{
  errors: readonly string[];
  files: readonly string[];
  sources: ReadonlyMap<OneA3bG1AcceptanceCriterion, SourceEvidence>;
}>;

type Preflight = Readonly<{
  catalogSha256: string | null;
  currentCommit: string | null;
  f3Manifest: JsonObject | null;
  f3Mismatches: readonly string[];
  f3Ready: boolean;
  fixtureIds: ReadonlySet<string>;
  fixtureSeed: number | null;
  f3ManifestFingerprint: string | null;
  f3ManifestSha256: string | null;
  hardGate: HardGateCheck;
  hostedCanary: HostedCanaryCheck;
  roleCheck: RoleCheck;
  sampleSeed: number | null;
  validator: ValidatorCheck;
}>;

type CriterionReport = Readonly<{
  criterion: OneA3bG1AcceptanceCriterion;
  fixtureIds: readonly string[];
  note: string;
  sourceArtifactPath: string | null;
  status: "blocked" | "verified";
}>;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function stringArray(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => !nonEmptyString(entry))
  ) {
    return null;
  }
  return value;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function relativeRepositoryPath(path: string): string {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function repositoryPath(value: string, label: string): string {
  const path = resolve(repositoryRoot, value);
  const fromRoot = relative(repositoryRoot, path);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    fromRoot.split(sep).includes("..")
  ) {
    throw new Error(`${label} must stay inside the repository.`);
  }
  return path;
}

function option(
  arguments_: readonly string[],
  name: string,
  fallback: string,
): string {
  const index = arguments_.indexOf(name);
  if (index === -1) return fallback;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function parseOptions(arguments_: readonly string[]): Options {
  const knownFlags = new Set([
    "--catalog",
    "--manifest",
    "--ledger",
    "--precision-report",
    "--sources",
    "--source-dir",
    "--evidence-dir",
    "--manifest-input",
    "--report",
    "--hard-gates",
    "--hosted-artifacts",
    "--hosted-values",
  ]);
  for (const argument of arguments_) {
    if (argument.startsWith("--") && !knownFlags.has(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return {
    catalogPath: option(arguments_, "--catalog", defaultCatalogPath),
    f3ManifestPath: option(
      arguments_,
      "--manifest",
      defaultF3ManifestPath,
    ),
    ledgerPath: option(arguments_, "--ledger", defaultLedgerPath),
    precisionReportPath: option(
      arguments_,
      "--precision-report",
      defaultPrecisionReportPath,
    ),
    sourceBundlePath: option(
      arguments_,
      "--sources",
      defaultSourceBundlePath,
    ),
    sourceDirectory: option(
      arguments_,
      "--source-dir",
      defaultSourceDirectory,
    ),
    evidenceDirectory: option(
      arguments_,
      "--evidence-dir",
      defaultEvidenceDirectory,
    ),
    manifestInputPath: option(
      arguments_,
      "--manifest-input",
      defaultManifestInputPath,
    ),
    reportPath: option(arguments_, "--report", defaultReportPath),
    hardGatePath: option(
      arguments_,
      "--hard-gates",
      defaultHardGatePath,
    ),
    hostedArtifactPath: option(
      arguments_,
      "--hosted-artifacts",
      defaultHostedArtifactPath,
    ),
    hostedValuesPath: option(
      arguments_,
      "--hosted-values",
      defaultHostedValuesPath,
    ),
  };
}

async function readJsonDocument(
  value: string,
  label: string,
  required: boolean,
): Promise<ReadDocument> {
  let path: string;
  try {
    path = repositoryPath(value, label);
  } catch (error) {
    return {
      path: value,
      bytes: null,
      value: null,
      error: error instanceof Error ? error.message : `${label} has an invalid path.`,
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = isRecord(error) ? error.code : null;
    if (code === "ENOENT" && !required) {
      return { path, bytes: null, value: null, error: null };
    }
    return {
      path,
      bytes: null,
      value: null,
      error: `${label} could not be read: ${
        error instanceof Error ? error.message : "read failed"
      }`,
    };
  }
  try {
    return {
      path,
      bytes,
      value: JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown,
      error: null,
    };
  } catch (error) {
    return {
      path,
      bytes,
      value: null,
      error: `${label} is not valid JSON: ${
        error instanceof Error ? error.message : "parse failed"
      }`,
    };
  }
}

async function gitOutput(...arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...arguments_], {
    cwd: repositoryRoot,
  });
  return result.stdout.trim();
}

function stripSha256Prefix(value: string | null): string | null {
  if (!value?.startsWith("sha256:")) return null;
  const hash = value.slice("sha256:".length);
  return SHA256_PATTERN.test(hash) ? hash : null;
}

function objectString(value: JsonObject, key: string): string | null {
  const entry = value[key];
  return nonEmptyString(entry) ? entry : null;
}

function objectNumber(value: JsonObject, key: string): number | null {
  const entry = value[key];
  return typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0
    ? entry
    : null;
}

function catalogFixtureIds(value: unknown): ReadonlySet<string> {
  if (!isRecord(value) || !Array.isArray(value.scenarios)) return new Set();
  return new Set(
    value.scenarios.flatMap((entry) => {
      const id = isRecord(entry) ? entry.id : null;
      return nonEmptyString(id) ? [id] : [];
    }),
  );
}

function f3ManifestFingerprint(value: JsonObject): string | null {
  const fingerprint = objectString(value, "fingerprint");
  return fingerprint && FINGERPRINT_PATTERN.test(fingerprint)
    ? fingerprint
    : null;
}

function f3ManifestInteger(value: JsonObject, key: string): number | null {
  const result = objectNumber(value, key);
  return result;
}

function roleConfigurationsFromF3(value: JsonObject): RoleCheck {
  const mismatches: string[] = [];
  const configurations: ModelRoleConfigurationSnapshot[] = [];
  const pinnedConfiguration = isRecord(value.pinnedConfiguration)
    ? value.pinnedConfiguration
    : null;
  const rolePins = pinnedConfiguration && isRecord(pinnedConfiguration.roles)
    ? pinnedConfiguration.roles
    : null;
  if (!rolePins) {
    return {
      configurations: [],
      mismatches: ["F3 role pins are missing."],
    };
  }

  for (const role of ONE_A_3B_G1_ENABLED_ROLES) {
    const pin = isRecord(rolePins[role]) ? rolePins[role] : null;
    if (!pin) {
      mismatches.push(`F3 is missing the evaluated pin for ${role}.`);
      continue;
    }
    const parameters = isRecord(pin.parameters) ? pin.parameters : null;
    const provider = objectString(pin, "provider");
    const model = objectString(pin, "model");
    const modelSnapshot = objectString(pin, "snapshot");
    const promptVersion = objectString(pin, "promptVersion");
    const schemaVersion = objectString(pin, "schemaVersion");
    const maxTechnicalRetries = objectNumber(pin, "maxTechnicalRetries");
    if (
      !parameters ||
      !provider ||
      !model ||
      !modelSnapshot ||
      !promptVersion ||
      !schemaVersion ||
      (maxTechnicalRetries !== 0 && maxTechnicalRetries !== 1)
    ) {
      mismatches.push(`F3 pin for ${role} is incomplete.`);
      continue;
    }
    const policy = ONE_A_3B_ROLE_POLICIES[role];
    if (maxTechnicalRetries !== policy.maxTechnicalRetries) {
      mismatches.push(`F3 pin for ${role} disagrees with its frozen retry policy.`);
      continue;
    }
    const configIteration = ONE_A_3B_G1_ROLE_CONFIG_VERSIONS[role];
    configurations.push({
      role,
      configVersion: `${role}:g1-release:${configIteration}`,
      provider,
      model,
      modelSnapshot,
      promptVersion,
      schemaVersion,
      rolePolicyVersion: ONE_A_3B_ROLE_POLICY_VERSION,
      providerPolicyVersion: `${provider}-${role}-egress:g1-release:${configIteration}`,
      rolloutPin: `${role}-g1-release-pin:${ONE_A_3B_G1_ROLLOUT_PIN_VERSION}`,
      freshnessPolicy: policy.freshnessPolicy,
      fallbackMode: "disabled",
      maxTechnicalRetries: policy.maxTechnicalRetries,
      maxSemanticRepairs: policy.maxSemanticRepairs,
      parameterSnapshot: parameters,
    });
  }
  return { configurations, mismatches };
}

async function validatorCheck(
  catalogDocument: ReadDocument,
  ledgerDocument: ReadDocument,
  precisionReportDocument: ReadDocument,
  manifestFingerprint: string | null,
): Promise<ValidatorCheck> {
  const ledgerSha256 = ledgerDocument.bytes
    ? sha256Bytes(ledgerDocument.bytes)
    : null;
  const base: ValidatorCheck = {
    acceptedCases: null,
    ledgerSha256,
    maxRejects: null,
    note: null,
    precisionFalseBlockingCases: null,
    precisionReportSha256: precisionReportDocument.bytes
      ? sha256Bytes(precisionReportDocument.bytes)
      : null,
    precisionTotalCases: null,
    rejectedCases: null,
    status: "blocked",
    totalCases: null,
  };
  if (
    !isRecord(catalogDocument.value) ||
    !isRecord(ledgerDocument.value) ||
    !isRecord(precisionReportDocument.value) ||
    !manifestFingerprint
  ) {
    return {
      ...base,
      note: "Validator catalog, ledger, precision report, or F3 fingerprint is unavailable.",
    };
  }
  const catalog = catalogDocument.value as FixtureCatalog;
  const ledger = ledgerDocument.value as ValidatorAdjudicationLedger;
  try {
    const summary = validateValidatorLedger({ catalog, ledger });
    const decidedAt = objectString(ledger, "decidedAt");
    if (!decidedAt || Number.isNaN(new Date(decidedAt).getTime())) {
      return {
        ...base,
        acceptedCases: summary.accepted,
        ledgerSha256,
        maxRejects: summary.maxRejects,
        note: "Validator ledger does not have a valid decision timestamp.",
        rejectedCases: summary.rejected,
        totalCases: summary.total,
      };
    }
    if (nonEmptyString(ledger._instructions)) {
      return {
        ...base,
        acceptedCases: summary.accepted,
        ledgerSha256,
        maxRejects: summary.maxRejects,
        note: "Validator ledger is still a prefill; Luke must finalize the adjudication and remove _instructions.",
        rejectedCases: summary.rejected,
        totalCases: summary.total,
      };
    }
    const precisionSummary = verifyValidatorPrecisionReport({
      report: precisionReportDocument.value,
      manifestFingerprint,
    });
    return {
      acceptedCases: summary.accepted,
      ledgerSha256,
      maxRejects: summary.maxRejects,
      note: null,
      precisionFalseBlockingCases: precisionSummary.falseBlockingCases,
      precisionReportSha256: base.precisionReportSha256,
      precisionTotalCases: precisionSummary.totalCases,
      rejectedCases: summary.rejected,
      status: "verified",
      totalCases: summary.total,
    };
  } catch (error) {
    return {
      ...base,
      note: error instanceof Error ? error.message : "Validator ledger failed validation.",
    };
  }
}

async function hardGateCheck(pathValue: string): Promise<HardGateCheck> {
  let path: string;
  try {
    path = repositoryPath(pathValue, "hard-gate artifact");
  } catch (error) {
    return {
      artifactSha256: null,
      failures: [],
      note: error instanceof Error ? error.message : "Invalid hard-gate path.",
      passed: false,
      path: pathValue,
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    return {
      artifactSha256: null,
      failures: [],
      note: `Hard-gate artifact is unavailable: ${
        error instanceof Error ? error.message : "read failed"
      }`,
      passed: false,
      path: relativeRepositoryPath(path),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    return {
      artifactSha256: sha256Bytes(bytes),
      failures: [],
      note: "Hard-gate artifact is not valid JSON.",
      passed: false,
      path: relativeRepositoryPath(path),
    };
  }
  if (!isRecord(value)) {
    return {
      artifactSha256: sha256Bytes(bytes),
      failures: [],
      note: "Hard-gate artifact must be an object.",
      passed: false,
      path: relativeRepositoryPath(path),
    };
  }
  const failures = Array.isArray(value.failures)
    ? value.failures.filter((entry): entry is string => typeof entry === "string")
    : [];
  const checkedFixtureCount = objectNumber(value, "checkedFixtureCount");
  // The 18-fixture count already refuses a report that checked nothing, which
  // is how a non-Continuation comparison used to satisfy AC-X04 vacuously.
  // Requiring `applicable` as well makes that intent explicit at the artifact
  // boundary rather than relying on the count alone.
  const passed =
    value.passed === true &&
    value.applicable === true &&
    failures.length === 0 &&
    checkedFixtureCount === 18;
  return {
    artifactSha256: sha256Bytes(bytes),
    failures,
    note: passed
      ? null
      : value.applicable !== true
        ? "Hard-gate artifact is not an applicable report."
        : failures.length > 0
          ? `Hard-gate artifact reports ${failures.length} failure(s).`
          : "Hard-gate artifact is not a passed complete 18-fixture report.",
    passed,
    path: relativeRepositoryPath(path),
  };
}

function findWorkflowRunId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = findWorkflowRunId(entry);
      if (result) return result;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of [
    "workflowRunId",
    "workflowId",
    "workflowCommandId",
    "workflow_id",
    "workflow_command_id",
    "workflow_run_id",
    "runId",
  ]) {
    const candidate = value[key];
    if (nonEmptyString(candidate)) return candidate;
  }
  for (const entry of Object.values(value)) {
    const result = findWorkflowRunId(entry);
    if (result) return result;
  }
  return null;
}

async function hostedCanaryCheck(
  artifactValue: string,
  valuesValue: string,
): Promise<HostedCanaryCheck> {
  let artifactPath: string;
  let valuesPath: string;
  try {
    artifactPath = repositoryPath(artifactValue, "hosted canary artifacts");
    valuesPath = repositoryPath(valuesValue, "hosted canary values");
  } catch (error) {
    return {
      artifactSha256: null,
      canaryRunId: null,
      note: error instanceof Error ? error.message : "Invalid hosted canary path.",
      passed: false,
      path: artifactValue,
    };
  }
  let artifactBytes: Uint8Array;
  let valuesBytes: Uint8Array;
  try {
    [artifactBytes, valuesBytes] = await Promise.all([
      readFile(artifactPath),
      readFile(valuesPath),
    ]);
  } catch (error) {
    return {
      artifactSha256: null,
      canaryRunId: null,
      note: `Hosted canary export is unavailable: ${
        error instanceof Error ? error.message : "read failed"
      }`,
      passed: false,
      path: relativeRepositoryPath(artifactPath),
    };
  }
  let values: unknown;
  try {
    values = JSON.parse(Buffer.from(valuesBytes).toString("utf8")) as unknown;
    if (!isRecord(values)) throw new Error("values must be an object");
  } catch (error) {
    return {
      artifactSha256: sha256Bytes(artifactBytes),
      canaryRunId: null,
      note: `Hosted canary values are invalid: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
      passed: false,
      path: relativeRepositoryPath(artifactPath),
    };
  }
  const requiredValues = [
    "actionPayload",
    "contentHmac",
    "privateBody",
    "rawProviderError",
    "renderedPrompt",
    "secret",
  ];
  if (requiredValues.some((key) => !nonEmptyString(values[key]))) {
    return {
      artifactSha256: sha256Bytes(artifactBytes),
      canaryRunId: null,
      note: "Hosted canary values must contain all six non-empty configured values.",
      passed: false,
      path: relativeRepositoryPath(artifactPath),
    };
  }
  let artifacts: unknown;
  try {
    artifacts = JSON.parse(Buffer.from(artifactBytes).toString("utf8")) as unknown;
  } catch {
    return {
      artifactSha256: sha256Bytes(artifactBytes),
      canaryRunId: null,
      note: "Hosted canary artifacts are not valid JSON.",
      passed: false,
      path: relativeRepositoryPath(artifactPath),
    };
  }
  if (!isRecord(artifacts)) {
    return {
      artifactSha256: sha256Bytes(artifactBytes),
      canaryRunId: null,
      note: "Hosted canary artifacts must be an object.",
      passed: false,
      path: relativeRepositoryPath(artifactPath),
    };
  }

  try {
    const result = await execFileAsync(
      "pnpm",
      ["canary:workflow"],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          SAYHEAR_WORKFLOW_CANARY_ARTIFACTS_FILE: artifactPath,
          SAYHEAR_WORKFLOW_CANARY_VALUES: JSON.stringify(values),
        },
        maxBuffer: 1_000_000,
        timeout: 30_000,
      },
    );
    void result;
  } catch (error) {
    return {
      artifactSha256: sha256Bytes(artifactBytes),
      canaryRunId: null,
      note: error instanceof Error ? error.message : "Hosted Workflow canary failed.",
      passed: false,
      path: relativeRepositoryPath(artifactPath),
    };
  }

  const canaryRunId = findWorkflowRunId(artifacts.workflowHistory);
  if (!canaryRunId) {
    return {
      artifactSha256: sha256Bytes(artifactBytes),
      canaryRunId: null,
      note: "Hosted canary passed privacy scanning but has no workflow history run ID.",
      passed: false,
      path: relativeRepositoryPath(artifactPath),
    };
  }
  return {
    artifactSha256: sha256Bytes(artifactBytes),
    canaryRunId,
    note: null,
    passed: true,
    path: relativeRepositoryPath(artifactPath),
  };
}

async function buildPreflight(options: Options): Promise<Preflight> {
  const [
    catalogDocument,
    f3ManifestDocument,
    ledgerDocument,
    precisionReportDocument,
  ] =
    await Promise.all([
      readJsonDocument(options.catalogPath, "F3 fixture catalog", true),
      readJsonDocument(options.f3ManifestPath, "F3 manifest", true),
      readJsonDocument(options.ledgerPath, "validator ledger", true),
      readJsonDocument(
        options.precisionReportPath,
        "validator precision report",
        true,
      ),
    ]);
  const f3Mismatches: string[] = [];
  if (catalogDocument.error) f3Mismatches.push(catalogDocument.error);
  if (f3ManifestDocument.error) f3Mismatches.push(f3ManifestDocument.error);
  if (ledgerDocument.error) f3Mismatches.push(ledgerDocument.error);
  if (precisionReportDocument.error) {
    f3Mismatches.push(precisionReportDocument.error);
  }

  const catalog = isRecord(catalogDocument.value)
    ? (catalogDocument.value as FixtureCatalog)
    : null;
  const f3Manifest = isRecord(f3ManifestDocument.value)
    ? f3ManifestDocument.value
    : null;
  const fixtureIds = catalogFixtureIds(catalogDocument.value);
  const catalogSha256 = catalogDocument.value
    ? stripSha256Prefix(sha256(catalogDocument.value))
    : null;
  let currentCommit: string | null = null;
  try {
    currentCommit = await gitOutput("rev-parse", "HEAD");
    if (!GIT_COMMIT_PATTERN.test(currentCommit)) {
      f3Mismatches.push("Current checkout did not return a full git commit.");
      currentCommit = null;
    }
  } catch (error) {
    f3Mismatches.push(
      `Unable to read the current git commit: ${
        error instanceof Error ? error.message : "git failed"
      }`,
    );
  }

  let roleCheck: RoleCheck = { configurations: [], mismatches: [] };
  if (f3Manifest) {
    f3Mismatches.push(
      ...verifyOneA3bF3ReleaseArtifacts({
        manifest: f3Manifest,
        catalog: catalogDocument.value,
        ledger: ledgerDocument.value,
      }),
    );
    roleCheck = roleConfigurationsFromF3(f3Manifest);
    f3Mismatches.push(...roleCheck.mismatches);
    f3Mismatches.push(
      ...verifyOneA3bG1RoleConfigurationsAgainstF3(
        roleCheck.configurations,
        f3Manifest,
      ),
    );
    if (f3Manifest.status !== "ready_for_evaluation") {
      f3Mismatches.push(
        `F3 manifest status is ${String(f3Manifest.status)}; a clean incumbent rebaseline is required.`,
      );
    }
    if (f3Manifest.comparisonAllowed !== true) {
      f3Mismatches.push(
        "F3 comparisonAllowed is false; candidate comparison evidence cannot be accepted.",
      );
    }
    const manifestCommit = objectString(f3Manifest, "gitCommit");
    if (currentCommit && manifestCommit !== currentCommit) {
      f3Mismatches.push(
        `F3 manifest targets ${manifestCommit ?? "no commit"}, but the current checkout is ${currentCommit}.`,
      );
    }
  }

  const validator = await validatorCheck(
    catalogDocument,
    ledgerDocument,
    precisionReportDocument,
    f3Manifest ? f3ManifestFingerprint(f3Manifest) : null,
  );
  const hardGate = await hardGateCheck(options.hardGatePath);
  const hostedCanary = await hostedCanaryCheck(
    options.hostedArtifactPath,
    options.hostedValuesPath,
  );
  const f3Ready =
    f3Mismatches.length === 0 &&
    f3Manifest !== null &&
    f3Manifest.status === "ready_for_evaluation" &&
    f3Manifest.comparisonAllowed === true;

  return {
    catalogSha256,
    currentCommit,
    f3Manifest,
    f3Mismatches,
    f3Ready,
    fixtureIds,
    fixtureSeed: f3Manifest ? f3ManifestInteger(f3Manifest, "fixtureSeed") : null,
    f3ManifestFingerprint: f3Manifest
      ? f3ManifestFingerprint(f3Manifest)
      : null,
    f3ManifestSha256: f3ManifestDocument.bytes
      ? sha256Bytes(f3ManifestDocument.bytes)
      : null,
    hardGate,
    hostedCanary,
    roleCheck,
    sampleSeed: f3Manifest ? f3ManifestInteger(f3Manifest, "sampleSeed") : null,
    validator,
  };
}

function sourceDocumentValues(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  if (nonEmptyString(value.criterion)) return [value];
  if (Array.isArray(value.evidence)) return value.evidence;
  if (Array.isArray(value.entries)) return value.entries;
  return [];
}

async function sourceFiles(
  options: Options,
): Promise<Readonly<{ bundle: string | null; directory: readonly string[]; errors: readonly string[] }>> {
  const errors: string[] = [];
  let bundle: string | null = null;
  try {
    const path = repositoryPath(options.sourceBundlePath, "G1 source bundle");
    await access(path);
    bundle = path;
  } catch (error) {
    if (isRecord(error) && error.code !== "ENOENT") {
      errors.push(
        `G1 source bundle is unavailable: ${
          error instanceof Error ? error.message : "invalid path"
        }`,
      );
    }
  }
  const directory: string[] = [];
  try {
    const path = repositoryPath(options.sourceDirectory, "G1 source directory");
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        directory.push(resolve(path, entry.name));
      }
    }
  } catch (error) {
    if (isRecord(error) && error.code !== "ENOENT") {
      errors.push(
        `G1 source directory is unavailable: ${
          error instanceof Error ? error.message : "invalid path"
        }`,
      );
    }
  }
  return { bundle, directory: directory.sort(), errors };
}

async function parseSourceEvidence(
  value: unknown,
  path: string,
  fixtureIds: ReadonlySet<string>,
): Promise<Readonly<{ errors: readonly string[]; source: SourceEvidence | null }>> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { errors: ["source document must be an object"], source: null };
  }
  const criterionValue = objectString(value, "criterion");
  if (
    !criterionValue ||
    !(ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA as readonly string[]).includes(
      criterionValue,
    )
  ) {
    errors.push("source document has an unknown criterion");
  }
  const criterion = criterionValue as OneA3bG1AcceptanceCriterion;
  const fixtureIdList = stringArray(value.fixtureIds);
  if (!fixtureIdList) {
    errors.push("source document must list non-empty fixtureIds");
  } else if (
    fixtureIds.size > 0 &&
    fixtureIdList.some((fixtureId) => !fixtureIds.has(fixtureId))
  ) {
    errors.push("source document contains a fixture ID outside the frozen catalog");
  }
  const command = objectString(value, "command");
  const owner = objectString(value, "owner");
  const runId = objectString(value, "runId");
  const sourceValue = objectString(value, "source");
  if (!command) errors.push("source document has no reproduction command");
  if (!owner) errors.push("source document has no evidence owner");
  if (!runId) errors.push("source document has no source run ID");
  if (!sourceValue || !EVIDENCE_SOURCES.has(sourceValue as OneA3bG1EvidenceSource)) {
    errors.push("source document has an invalid evidence source");
  }
  if (value.passed !== true) {
    errors.push("source document must contain an explicit passed=true result");
  }
  const verification = isRecord(value.verification) ? value.verification : null;
  const verificationCommand = verification
    ? objectString(verification, "command")
    : null;
  if (verification?.passed !== true || !verificationCommand) {
    errors.push("source document must record a passing verifier command");
  }
  const result = isRecord(value.result) ? value.result : null;
  if (!result || result.passed !== true) {
    errors.push("source document result must contain an explicit passed=true result");
  }
  const artifactPathValue = objectString(value, "artifactPath");
  const artifactSha256 = objectString(value, "artifactSha256");
  if (!artifactPathValue || !artifactSha256 || !SHA256_PATTERN.test(artifactSha256)) {
    errors.push("source document must hash its repository-local source artifact");
  }

  let artifactPath = "";
  let artifactBytes = new Uint8Array();
  if (artifactPathValue && artifactSha256 && SHA256_PATTERN.test(artifactSha256)) {
    try {
      artifactPath = repositoryPath(artifactPathValue, "source artifact");
      artifactBytes = await readFile(artifactPath);
      if (sha256Bytes(artifactBytes) !== artifactSha256) {
        errors.push("source artifact bytes do not match artifactSha256");
      }
    } catch (error) {
      errors.push(
        `source artifact is unavailable: ${
          error instanceof Error ? error.message : "read failed"
        }`,
      );
    }
  }
  if (result) {
    errors.push(
      ...verifySyntheticSourceBoundary(
        result,
        `${relativeRepositoryPath(path)}/result`,
      ),
    );
    if (criterionValue === "AC-W01") {
      const exportArtifact = isRecord(result.exportArtifact)
        ? result.exportArtifact
        : null;
      const exportPathValue = exportArtifact
        ? objectString(exportArtifact, "path")
        : null;
      const exportHash = exportArtifact
        ? objectString(exportArtifact, "sha256")
        : null;
      if (
        !exportPathValue ||
        !exportHash ||
        !SHA256_PATTERN.test(exportHash)
      ) {
        errors.push("AC-W01 exportArtifact must contain a repository path and SHA-256 hash");
      } else {
        try {
          const exportPath = repositoryPath(exportPathValue, "AC-W01 export artifact");
          const exportBytes = await readFile(exportPath);
          if (sha256Bytes(exportBytes) !== exportHash) {
            errors.push("AC-W01 exportArtifact hash does not match its file");
          }
        } catch (error) {
          errors.push(
            `AC-W01 export artifact is unavailable: ${
              error instanceof Error ? error.message : "read failed"
            }`,
          );
        }
      }
    }
  }
  if (errors.length > 0 || !criterionValue || !fixtureIdList || !command || !owner || !runId || !sourceValue || !result || !verificationCommand) {
    return { errors, source: null };
  }
  return {
    errors: [],
    source: {
      artifactPath: relativeRepositoryPath(artifactPath),
      artifactSha256,
      command,
      criterion,
      fixtureIds: fixtureIdList,
      owner,
      result,
      runId,
      source: sourceValue as OneA3bG1EvidenceSource,
      verificationCommand,
    },
  };
}

async function collectSources(
  options: Options,
  fixtureIds: ReadonlySet<string>,
): Promise<SourceCollection> {
  const files = await sourceFiles(options);
  const errors = [...files.errors];
  const candidates: { path: string; value: unknown }[] = [];
  if (files.bundle) {
    const document = await readJsonDocument(
      relativeRepositoryPath(files.bundle),
      "G1 source bundle",
      true,
    );
    if (document.error) {
      errors.push(document.error);
    } else {
      const values = sourceDocumentValues(document.value);
      if (values.length === 0) {
        errors.push(
          "G1 source bundle must contain an evidence array or source document",
        );
      }
      for (const value of values) {
        candidates.push({ path: document.path, value });
      }
    }
  }
  for (const path of files.directory) {
    const document = await readJsonDocument(
      relativeRepositoryPath(path),
      `G1 source ${relativeRepositoryPath(path)}`,
      true,
    );
    if (document.error) {
      errors.push(document.error);
    } else {
      const values = sourceDocumentValues(document.value);
      if (values.length === 0) {
        errors.push(
          `${relativeRepositoryPath(path)} must contain a source document`,
        );
      }
      for (const value of values) {
        candidates.push({ path, value });
      }
    }
  }

  const sources = new Map<OneA3bG1AcceptanceCriterion, SourceEvidence>();
  for (const candidate of candidates) {
    const parsed = await parseSourceEvidence(
      candidate.value,
      candidate.path,
      fixtureIds,
    );
    if (parsed.errors.length > 0) {
      errors.push(
        `${relativeRepositoryPath(candidate.path)}: ${parsed.errors.join("; ")}`,
      );
      continue;
    }
    if (!parsed.source) {
      errors.push(`${relativeRepositoryPath(candidate.path)}: invalid source document`);
      continue;
    }
    if (sources.has(parsed.source.criterion)) {
      errors.push(`duplicate source evidence for ${parsed.source.criterion}`);
      continue;
    }
    sources.set(parsed.source.criterion, parsed.source);
  }
  return {
    errors,
    files: [
      ...(files.bundle ? [relativeRepositoryPath(files.bundle)] : []),
      ...files.directory.map(relativeRepositoryPath),
    ],
    sources,
  };
}

async function currentMigrationPins(
  directory: string,
): Promise<readonly { name: string; sha256: string }[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(
    names.map(async (name) => ({
      name,
      sha256: sha256Bytes(await readFile(resolve(directory, name))),
    })),
  );
}

/**
 * Release identity for AC-D01 binding. It covers only immutable deployable
 * inputs so deployment evidence can reference it before the full manifest
 * (which contains that evidence) is frozen. Returns null while preflight or
 * migration pins are incomplete so callers stay blocked instead of guessing.
 */
async function buildReleaseIdentity(
  preflight: Preflight,
): Promise<string | null> {
  try {
    if (
      !preflight.currentCommit ||
      !preflight.f3ManifestFingerprint ||
      !preflight.f3ManifestSha256 ||
      preflight.fixtureSeed === null ||
      preflight.sampleSeed === null ||
      preflight.roleCheck.configurations.length === 0 ||
      preflight.roleCheck.mismatches.length > 0
    ) {
      return null;
    }
    const [migrations, purgeMarkerMigrations] = await Promise.all([
      currentMigrationPins(resolve(repositoryRoot, "packages/data/migrations")),
      currentMigrationPins(
        resolve(repositoryRoot, "packages/data/migrations-purge-marker"),
      ),
    ]);
    return buildG1ReleaseIdentityFingerprint({
      gitCommit: preflight.currentCommit,
      migrations,
      purgeMarkerMigrations,
      roleConfigurations: preflight.roleCheck.configurations,
      fixture: {
        f3ManifestSha256: preflight.f3ManifestSha256,
        f3ManifestFingerprint: preflight.f3ManifestFingerprint,
        fixtureSeed: preflight.fixtureSeed,
        sampleSeed: preflight.sampleSeed,
      },
    });
  } catch {
    return null;
  }
}

function sourceSpecificErrors(
  source: SourceEvidence | undefined,
  criterion: OneA3bG1AcceptanceCriterion,
  preflight: Preflight,
  releaseIdentity: string | null,
): readonly string[] {
  if (!source) return [];
  const errors: string[] = [];
  const contract = ONE_A_3B_G1_EVIDENCE_CONTRACTS[criterion];
  for (const key of contract.requiredResultKeys) {
    // AC-D01 identity is producer-injected from immutable inputs (see
    // buildReleaseIdentity); the deployment source only observes the Vercel
    // deployment and must not fabricate it.
    if (criterion === "AC-D01" && key === "releaseIdentityFingerprint") continue;
    if (!(key in source.result)) {
      errors.push(`${criterion} source result is missing ${key}`);
    }
  }
  if (
    criterion === "AC-D01" &&
    "releaseIdentityFingerprint" in source.result &&
    source.result.releaseIdentityFingerprint !== releaseIdentity
  ) {
    errors.push("AC-D01 source release identity does not match the computed release identity");
  }
  if (criterion === "AC-M01") {
    const providerCalls = source.result.providerCalls;
    if (
      !Array.isArray(providerCalls) ||
      providerCalls.length === 0 ||
      providerCalls.some(
        (entry) => !isRecord(entry) || entry.provider !== "deepseek",
      )
    ) {
      errors.push("AC-M01 source must contain real DeepSeek provider calls");
    }
  }
  if (criterion === "AC-W01") {
    if (source.source !== "hosted") {
      errors.push("AC-W01 source must be hosted");
    }
    if (!preflight.hostedCanary.passed) {
      errors.push(
        `Hosted Workflow canary is not verified: ${preflight.hostedCanary.note ?? "unknown failure"}`,
      );
    }
    if (
      preflight.hostedCanary.artifactSha256 &&
      source.result.exportArtifact &&
      isRecord(source.result.exportArtifact) &&
      source.result.exportArtifact.sha256 !== preflight.hostedCanary.artifactSha256
    ) {
      errors.push("AC-W01 export artifact is not the verified hosted canary export");
    }
  }
  if (criterion === "AC-X04") {
    if (source.source !== "local" && source.source !== "ci") {
      errors.push("AC-X04 source must be local or CI automation");
    }
    if (!preflight.hardGate.passed) {
      errors.push(
        `AC-X04 raw hard-gate report is not a pass: ${preflight.hardGate.note ?? "unknown failure"}`,
      );
    }
    if (source.result.confirmedHardFailures !== 0) {
      errors.push("AC-X04 source must report zero confirmed hard failures");
    }
    if (
      preflight.hardGate.artifactSha256 &&
      source.result.rawArtifactHash !== preflight.hardGate.artifactSha256
    ) {
      errors.push("AC-X04 rawArtifactHash does not match the raw hard-gate artifact");
    }
  }
  if (
    preflight.f3Ready &&
    preflight.currentCommit &&
    preflight.f3ManifestFingerprint &&
    preflight.catalogSha256
  ) {
    const provisionalEvidence: OneA3bG1Evidence = {
      criterion,
      fixtureIds: source.fixtureIds,
      command: source.command,
      artifactSha256: "0".repeat(64),
      artifactPath: `${defaultEvidenceDirectory}/${criterion.toLowerCase()}.json`,
      owner: source.owner,
      source: source.source,
      status: "verified",
    };
    if (criterion === "AC-D01" && !releaseIdentity) {
      errors.push("AC-D01 release identity is unavailable from immutable inputs");
    }
    errors.push(
      ...verifyOneA3bG1EvidenceArtifact({
        value: evidenceArtifactValue({
          evidence: provisionalEvidence,
          f3ManifestFingerprint: preflight.f3ManifestFingerprint,
          fixtureCatalogSha256: preflight.catalogSha256,
          source,
          gitCommit: preflight.currentCommit,
          releaseIdentityFingerprint: releaseIdentity,
        }),
        evidence: provisionalEvidence,
        gitCommit: preflight.currentCommit,
        f3ManifestFingerprint: preflight.f3ManifestFingerprint,
        fixtureCatalogSha256: preflight.catalogSha256,
        knownFixtureIds: preflight.fixtureIds,
      }),
    );
  }
  return errors;
}

function criterionNote(
  criterion: OneA3bG1AcceptanceCriterion,
  source: SourceEvidence | undefined,
  preflight: Preflight,
  sourceErrors: readonly string[],
): string {
  const blockers: string[] = [];
  if (!preflight.f3Ready) {
    blockers.push(
      `F3 preflight: ${preflight.f3Mismatches[0] ?? "manifest is not comparison-ready"}`,
    );
  }
  if (preflight.validator.status !== "verified") {
    blockers.push(
      `validator calibration: ${preflight.validator.note ?? "ledger is not verified"}`,
    );
  }
  if (!source) {
    blockers.push(
      `no verified evidence source; add one under ${defaultSourceDirectory}`,
    );
  }
  if (sourceErrors.length > 0) blockers.push(...sourceErrors);
  if (criterion === "AC-X04" && !preflight.hardGate.passed) {
    blockers.push(
      `raw hard-gate report: ${preflight.hardGate.note ?? "not verified"}`,
    );
  }
  if (criterion === "AC-W01" && !preflight.hostedCanary.passed) {
    blockers.push(
      `hosted canary: ${preflight.hostedCanary.note ?? "not verified"}`,
    );
  }
  if (blockers.length > 0) return blockers.join("; ");
  return `Verified source ${source?.artifactPath ?? ""} is ready for assembly.`;
}

function criterionReports(
  sources: SourceCollection,
  preflight: Preflight,
  releaseIdentity: string | null,
): readonly CriterionReport[] {
  return ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA.map((criterion) => {
    const source = sources.sources.get(criterion);
    const errors = sourceSpecificErrors(source, criterion, preflight, releaseIdentity);
    const sourceReady = source !== undefined && errors.length === 0;
    const verified =
      preflight.f3Ready &&
      preflight.validator.status === "verified" &&
      sourceReady;
    return {
      criterion,
      fixtureIds: source?.fixtureIds ?? [],
      note: criterionNote(criterion, source, preflight, errors),
      sourceArtifactPath: source?.artifactPath ?? null,
      status: verified ? "verified" : "blocked",
    };
  });
}

function evidenceArtifactValue(input: Readonly<{
  evidence: OneA3bG1Evidence;
  f3ManifestFingerprint: string;
  fixtureCatalogSha256: string;
  source: SourceEvidence;
  gitCommit: string;
  releaseIdentityFingerprint: string | null;
}>): JsonObject {
  const contract = ONE_A_3B_G1_EVIDENCE_CONTRACTS[input.evidence.criterion];
  const resultFields: JsonObject = {};
  for (const key of contract.requiredResultKeys) {
    // AC-D01 identity is always the producer-computed value so a source
    // document cannot fabricate the binding.
    if (input.evidence.criterion === "AC-D01" && key === "releaseIdentityFingerprint") {
      resultFields[key] = input.releaseIdentityFingerprint;
      continue;
    }
    resultFields[key] = input.source.result[key];
  }
  const result: JsonObject = {
    ...resultFields,
    sourceArtifactPath: input.source.artifactPath,
    sourceArtifactSha256: input.source.artifactSha256,
    verificationCommand: input.source.verificationCommand,
    passed: true,
    criterion: input.evidence.criterion,
    evidenceKind: contract.evidenceKind,
    assertionIds: [...contract.requiredAssertionIds],
    fixtureIds: [...input.evidence.fixtureIds],
    gitCommit: input.gitCommit,
    f3ManifestFingerprint: input.f3ManifestFingerprint,
    fixtureCatalogSha256: input.fixtureCatalogSha256,
    runId: input.source.runId,
    command: input.evidence.command,
  };
  return {
    version: "1a3b-g1-evidence:v1",
    criterion: input.evidence.criterion,
    gitCommit: input.gitCommit,
    f3ManifestFingerprint: input.f3ManifestFingerprint,
    fixtureCatalogSha256: input.fixtureCatalogSha256,
    fixtureIds: [...input.evidence.fixtureIds],
    command: input.evidence.command,
    runId: input.source.runId,
    status: "passed",
    result,
  };
}

async function writeEvidenceArtifacts(input: Readonly<{
  evidenceDirectory: string;
  f3ManifestFingerprint: string;
  fixtureCatalogSha256: string;
  gitCommit: string;
  preflight: Preflight;
  sources: SourceCollection;
  releaseIdentityFingerprint: string | null;
}>): Promise<readonly OneA3bG1Evidence[]> {
  const evidenceDirectory = repositoryPath(
    input.evidenceDirectory,
    "G1 evidence directory",
  );
  await mkdir(evidenceDirectory, { recursive: true });
  const evidence: OneA3bG1Evidence[] = [];
  const stagingDirectory = await mkdtemp(
    resolve(dirname(evidenceDirectory), ".g1-evidence-staging-"),
  );
  const pendingWrites: {
    evidence: OneA3bG1Evidence;
    finalPath: string;
    stagingPath: string;
  }[] = [];

  try {
    for (const criterion of ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA) {
      const source = input.sources.sources.get(criterion);
      if (!source) throw new Error(`Missing verified source ${criterion}.`);
      const artifactPath = resolve(
        evidenceDirectory,
        `${criterion.toLowerCase()}.json`,
      );
      const evidenceWithoutHash: OneA3bG1Evidence = {
        criterion,
        fixtureIds: source.fixtureIds,
        command: source.command,
        artifactSha256: "0".repeat(64),
        artifactPath: relativeRepositoryPath(artifactPath),
        owner: source.owner,
        source: source.source,
        status: "verified",
      };
      if (criterion === "AC-D01" && !input.releaseIdentityFingerprint) {
        throw new Error("AC-D01 release identity is unavailable from immutable inputs.");
      }
      const artifact = evidenceArtifactValue({
        evidence: evidenceWithoutHash,
        f3ManifestFingerprint: input.f3ManifestFingerprint,
        fixtureCatalogSha256: input.fixtureCatalogSha256,
        source,
        gitCommit: input.gitCommit,
        releaseIdentityFingerprint: input.releaseIdentityFingerprint,
      });
      const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
      const stagingPath = resolve(stagingDirectory, basename(artifactPath));
      await writeFile(stagingPath, bytes);
      const writtenBytes = await readFile(stagingPath);
      const artifactSha256 = sha256Bytes(writtenBytes);
      const finalEvidence: OneA3bG1Evidence = {
        ...evidenceWithoutHash,
        artifactSha256,
      };
      const mismatches = verifyOneA3bG1EvidenceArtifact({
        value: artifact,
        evidence: finalEvidence,
        gitCommit: input.gitCommit,
        f3ManifestFingerprint: input.f3ManifestFingerprint,
        fixtureCatalogSha256: input.fixtureCatalogSha256,
        knownFixtureIds: input.preflight.fixtureIds,
      });
      if (mismatches.length > 0) {
        throw new Error(`${criterion} artifact is invalid: ${mismatches.join("; ")}`);
      }
      pendingWrites.push({
        evidence: finalEvidence,
        finalPath: artifactPath,
        stagingPath,
      });
    }

    for (const pending of pendingWrites) {
      await rename(pending.stagingPath, pending.finalPath);
      const finalBytes = await readFile(pending.finalPath);
      if (sha256Bytes(finalBytes) !== pending.evidence.artifactSha256) {
        throw new Error(
          `${pending.evidence.criterion} artifact hash changed after finalizing.`,
        );
      }
      evidence.push(pending.evidence);
    }
    return evidence;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

function validatorCalibration(
  options: Options,
  preflight: Preflight,
): OneA3bG1ValidatorCalibration {
  if (
    !preflight.f3ManifestFingerprint ||
    !preflight.validator.ledgerSha256 ||
    !preflight.validator.precisionReportSha256 ||
    preflight.validator.totalCases === null ||
    preflight.validator.acceptedCases === null ||
    preflight.validator.maxRejects === null ||
    preflight.validator.precisionTotalCases === null ||
    preflight.validator.precisionFalseBlockingCases === null
  ) {
    throw new Error("Validator calibration cannot be assembled from incomplete preflight data.");
  }
  return {
    ledgerPath: relativeRepositoryPath(
      repositoryPath(options.ledgerPath, "validator ledger"),
    ),
    ledgerSha256: preflight.validator.ledgerSha256,
    ledgerVersion: "1a3b-f3-adjudication:v1",
    precisionReportPath: relativeRepositoryPath(
      repositoryPath(options.precisionReportPath, "validator precision report"),
    ),
    precisionReportSha256: preflight.validator.precisionReportSha256,
    precisionReportVersion: ONE_A_3B_F3_VALIDATOR_PRECISION_REPORT_VERSION,
    precisionTotalCases: preflight.validator.precisionTotalCases as 6,
    precisionFalseBlockingCases:
      preflight.validator.precisionFalseBlockingCases,
    f3ManifestFingerprint: preflight.f3ManifestFingerprint,
    totalCases: 18,
    acceptedCases: preflight.validator.acceptedCases,
    maxRejects: preflight.validator.maxRejects,
    humanOwner: "Luke",
    status: "verified",
  };
}

async function writeManifestInput(input: Readonly<{
  evidence: readonly OneA3bG1Evidence[];
  options: Options;
  preflight: Preflight;
  sources: SourceCollection;
}>): Promise<void> {
  if (
    !input.preflight.currentCommit ||
    !input.preflight.f3ManifestFingerprint ||
    !input.preflight.f3ManifestSha256 ||
    !input.preflight.catalogSha256 ||
    input.preflight.fixtureSeed === null ||
    input.preflight.sampleSeed === null ||
    !input.preflight.f3Manifest
  ) {
    throw new Error("G1 manifest input cannot be assembled from incomplete F3 lineage.");
  }
  const inputValue = {
    gitCommit: input.preflight.currentCommit,
    roleConfigurations: input.preflight.roleCheck.configurations,
    fixture: {
      f3ManifestPath: relativeRepositoryPath(
        repositoryPath(input.options.f3ManifestPath, "F3 manifest"),
      ),
      f3ManifestSha256: input.preflight.f3ManifestSha256,
      f3ManifestFingerprint: input.preflight.f3ManifestFingerprint,
      fixtureSeed: input.preflight.fixtureSeed,
      sampleSeed: input.preflight.sampleSeed,
    },
    validatorCalibration: validatorCalibration(input.options, input.preflight),
    commands: [
      "pnpm exec tsx scripts/produce-1a3b-g1-evidence.ts",
      "pnpm exec tsx eval/continuation-acceptance-1a3b/verify-fixtures.ts",
      "pnpm canary:workflow",
      ...[...input.sources.sources.values()].map(
        (source) => source.verificationCommand,
      ),
      ...input.evidence.map((entry) => entry.command),
    ],
    evidence: input.evidence,
    cutoverState: "disabled",
    createdAt: new Date().toISOString(),
  };
  const path = repositoryPath(
    input.options.manifestInputPath,
    "G1 manifest input",
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(inputValue, null, 2)}\n`, "utf8");
}

function reportValue(input: Readonly<{
  options: Options;
  preflight: Preflight;
  sources: SourceCollection;
  criteria: readonly CriterionReport[];
  manifestInputWritten: boolean;
  evidenceWritten: readonly string[];
  assemblyError: string | null;
}>): JsonObject {
  const blocked = input.criteria.filter((entry) => entry.status === "blocked");
  const ready =
    blocked.length === 0 &&
    input.sources.errors.length === 0 &&
    input.manifestInputWritten &&
    input.assemblyError === null;
  return {
    version: "1a3b-g1-evidence-production-report:v1",
    generatedAt: new Date().toISOString(),
    runId: `g1-evidence-producer-${Date.now()}`,
    status: ready ? "ready" : "blocked",
    preflight: {
      currentCommit: input.preflight.currentCommit,
      f3Manifest: {
        path: input.options.f3ManifestPath,
        fingerprint: input.preflight.f3ManifestFingerprint,
        sha256: input.preflight.f3ManifestSha256,
        catalogSha256: input.preflight.catalogSha256,
        status: input.preflight.f3Manifest?.status ?? null,
        comparisonAllowed: input.preflight.f3Manifest?.comparisonAllowed ?? null,
        ready: input.preflight.f3Ready,
        mismatches: input.preflight.f3Mismatches,
      },
      validator: input.preflight.validator,
      hardGate: input.preflight.hardGate,
      hostedCanary: input.preflight.hostedCanary,
      roleMismatches: input.preflight.roleCheck.mismatches,
    },
    sources: {
      discoveredFiles: input.sources.files,
      validCriteria: [...input.sources.sources.keys()],
      errors: input.sources.errors,
    },
    criteria: input.criteria,
    output: {
      evidenceDirectory: input.options.evidenceDirectory,
      evidenceArtifactsWritten: input.evidenceWritten,
      manifestInputPath: input.options.manifestInputPath,
      manifestInputWritten: input.manifestInputWritten,
      assemblyError: input.assemblyError,
    },
    nextSteps:
      ready
        ? ["Run pnpm release:g1:build with the generated manifest input."]
        : [
            "Produce a clean incumbent rebaseline on the current checkout and rebuild the F3 manifest with comparisonAllowed=true.",
            "Replace the validator prefill with Luke's final dated adjudication before treating calibration as verified.",
            "Collect one independently verified, hashed source document for every missing G1 criterion; do not hand-edit passed results.",
            "Resolve the hosted canary and raw hard-gate failures before assembling AC-W01 or AC-X04.",
          ],
  };
}

async function writeReport(pathValue: string, value: JsonObject): Promise<string> {
  const path = repositoryPath(pathValue, "G1 production report");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return relativeRepositoryPath(path);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const preflight = await buildPreflight(options);
  const sources = await collectSources(options, preflight.fixtureIds);
  const releaseIdentity = await buildReleaseIdentity(preflight);
  const criteria = criterionReports(sources, preflight, releaseIdentity);
  let evidence: readonly OneA3bG1Evidence[] = [];
  let manifestInputWritten = false;
  let evidenceWritten: readonly string[] = [];
  let assemblyError: string | null = null;

  const allCriteriaVerified =
    sources.errors.length === 0 &&
    criteria.every((entry) => entry.status === "verified");
  if (allCriteriaVerified) {
    if (
      !preflight.currentCommit ||
      !preflight.f3ManifestFingerprint ||
      !preflight.catalogSha256
    ) {
      throw new Error("All G1 evidence is marked ready but F3 lineage is incomplete.");
    }
    try {
      evidence = await writeEvidenceArtifacts({
        evidenceDirectory: options.evidenceDirectory,
        f3ManifestFingerprint: preflight.f3ManifestFingerprint,
        fixtureCatalogSha256: preflight.catalogSha256,
        gitCommit: preflight.currentCommit,
        preflight,
        sources,
        releaseIdentityFingerprint: releaseIdentity,
      });
      evidenceWritten = evidence.map((entry) => entry.artifactPath!);
      await writeManifestInput({ evidence, options, preflight, sources });
      manifestInputWritten = true;
    } catch (error) {
      assemblyError =
        error instanceof Error ? error.message : "G1 evidence assembly failed.";
    }
  }

  const report = reportValue({
    options,
    preflight,
    sources,
    criteria,
    manifestInputWritten,
    evidenceWritten,
    assemblyError,
  });
  const reportPath = await writeReport(options.reportPath, report);
  const ready =
    criteria.every((entry) => entry.status === "verified") &&
    sources.errors.length === 0 &&
    manifestInputWritten &&
    assemblyError === null;
  if (!ready) {
    console.error(`[g1-evidence] blocked; report ${reportPath}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[g1-evidence] ready; report ${reportPath}`);
  console.log(`[g1-evidence] wrote ${evidence.length} evidence artifacts`);
}

main().catch((error: unknown) => {
  console.error(
    `[g1-evidence] ${error instanceof Error ? error.message : "production failed"}`,
  );
  process.exitCode = 1;
});
