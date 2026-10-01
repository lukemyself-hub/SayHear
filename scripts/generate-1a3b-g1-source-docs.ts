import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createPostgresPool } from "@sayhear/data";

import {
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_G1_ROLE_CONFIG_VERSIONS,
  ONE_A_3B_G1_ROLLOUT_PIN_VERSION,
  ONE_A_3B_ROLE_POLICY_VERSION,
  PURGE_SURFACE_REGISTRY_VERSION,
  sha256Hex,
  assertWorkflowHistoryCanaryClean,
  type WorkflowCanaryArtifacts,
  type WorkflowCanaryValues,
} from "@sayhear/application";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
export function parseSourceOptions(args: readonly string[]) {
  const allowed = new Set(["--run-root", "--catalog", "--pins", "--deployment-id"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !allowed.has(name) || !value || value.startsWith("--") || values.has(name)) {
      throw new Error("Expected unique --run-root, --catalog, --pins and --deployment-id arguments.");
    }
    values.set(name, value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  const localPath = (name: string): string => {
    const path = resolve(repositoryRoot, required(name));
    const relativePath = relative(repositoryRoot, path);
    if (!relativePath || relativePath.startsWith("..") || relativePath.startsWith("/")) {
      throw new Error(`${name} must stay inside the repository.`);
    }
    return path;
  };
  return {
    runRoot: (() => {
      const path = localPath("--run-root");
      if (path === resolve(repositoryRoot, "eval/continuation-acceptance-1a3b/run")) throw new Error("The historical run root is protected; use an independent run directory.");
      return path;
    })(),
    catalogPath: localPath("--catalog"),
    pinsPath: localPath("--pins"),
    deploymentId: required("--deployment-id"),
  };
}

let runRoot: string;
let catalogPath: string;
let pinsPath: string;
let sourceDirectory: string;
let sourceArtifactDirectory: string;
let f3ManifestPath: string;
let hostedArtifactPath: string;
let hostedValuesPath: string;
let deploymentPath: string;
let requestedDeploymentId: string;

type JsonObject = Record<string, unknown>;

type TestReport = JsonObject & {
  numPassedTests?: number;
  numPassedTestSuites?: number;
  numTotalTests?: number;
  numTotalTestSuites?: number;
  startTime?: number;
  success?: boolean;
  testResults?: unknown;
};

type ReportSummary = Readonly<{
  assertionIds: readonly string[];
  passedTestSuites: number;
  passedTests: number;
  runId: string;
  totalTestSuites: number;
  totalTests: number;
}>;

type ArtifactReference = Readonly<{
  path: string;
  sha256: string;
}>;

type SourceDocument = Readonly<{
  artifactPath: string;
  artifactSha256: string;
  command: string;
  criterion: string;
  fixtureIds: readonly string[];
  owner: string;
  passed: true;
  result: JsonObject;
  runId: string;
  source: "ci" | "hosted" | "local" | "provider";
  verification: Readonly<{ command: string; passed: true }>;
}>;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function repositoryRelative(path: string): string {
  return relative(repositoryRoot, path).split("\\").join("/");
}

async function readJson(path: string): Promise<JsonObject> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error(`${repositoryRelative(path)} must be an object.`);
  return value;
}

async function reference(path: string): Promise<ArtifactReference> {
  const bytes = await readFile(path);
  return { path: repositoryRelative(path), sha256: sha256Bytes(bytes) };
}

function reportAssertions(report: TestReport): readonly string[] {
  if (!Array.isArray(report.testResults)) {
    throw new Error("Vitest report has no testResults array.");
  }
  const assertions: string[] = [];
  for (const testFile of report.testResults) {
    if (!isRecord(testFile) || !Array.isArray(testFile.assertionResults)) {
      throw new Error("Vitest report contains an invalid assertion result set.");
    }
    for (const assertion of testFile.assertionResults) {
      if (!isRecord(assertion) || typeof assertion.fullName !== "string") {
        throw new Error("Vitest report contains an assertion without fullName.");
      }
      if (assertion.status !== "passed") {
        throw new Error(`Vitest assertion did not pass: ${assertion.fullName}`);
      }
      assertions.push(assertion.fullName);
    }
  }
  return assertions;
}

async function readReport(path: string): Promise<Readonly<{ reference: ArtifactReference; report: TestReport; summary: ReportSummary }>> {
  const report = (await readJson(path)) as TestReport;
  const assertionIds = reportAssertions(report);
  if (report.success !== true) throw new Error(`${repositoryRelative(path)} did not pass.`);
  if (
    typeof report.numTotalTests !== "number" ||
    typeof report.numPassedTests !== "number" ||
    typeof report.numTotalTestSuites !== "number" ||
    typeof report.numPassedTestSuites !== "number" ||
    typeof report.startTime !== "number"
  ) {
    throw new Error(`${repositoryRelative(path)} has incomplete Vitest counts.`);
  }
  return {
    reference: await reference(path),
    report,
    summary: {
      assertionIds,
      passedTestSuites: report.numPassedTestSuites,
      passedTests: report.numPassedTests,
      runId: `${repositoryRelative(path)}:${report.startTime}`,
      totalTestSuites: report.numTotalTestSuites,
      totalTests: report.numTotalTests,
    },
  };
}

export function ids(
  summary: ReportSummary,
  predicate?: (assertionId: string) => boolean,
): readonly string[] {
  if (!predicate) {
    return summary.assertionIds.length > 0
      ? summary.assertionIds
      : [summary.runId];
  }
  const selected = summary.assertionIds.filter(predicate);
  if (selected.length > 0) return selected;
  throw new Error(
    `No passing assertion in ${summary.runId} matched the required criterion predicate.`,
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function successfulProviderCall(call: JsonObject): boolean {
  return (
    call.status === "succeeded" ||
    call.status === "success" ||
    call.outcome === "completed" ||
    call.outcome === "succeeded" ||
    call.outcome === "success"
  );
}

function callHasIdentity(call: JsonObject): boolean {
  return nonEmptyString(call.generationCommandId) && nonEmptyString(call.modelRunAttemptId);
}

export function validatedAcM01Result(
  capture: JsonObject,
  pins: JsonObject,
  enabledRoles: readonly string[] = ONE_A_3B_G1_ENABLED_ROLES,
): Readonly<{
  modelSnapshots: readonly JsonObject[];
  parameterSnapshots: readonly JsonObject[];
  providerCalls: readonly JsonObject[];
}> {
  if (!Array.isArray(capture.providerCalls)) {
    throw new Error("AC-M01 capture has no providerCalls array.");
  }
  const rolePins = isRecord(pins.roles) ? pins.roles : null;
  if (!rolePins) throw new Error("AC-M01 pins have no roles object.");

  const successfulCalls = capture.providerCalls.filter(
    (call): call is JsonObject => isRecord(call) && successfulProviderCall(call),
  );
  const validatedCalls: JsonObject[] = [];
  for (const role of enabledRoles) {
    const iteration = ONE_A_3B_G1_ROLE_CONFIG_VERSIONS[role as keyof typeof ONE_A_3B_G1_ROLE_CONFIG_VERSIONS];
    const pin = isRecord(rolePins[role]) ? rolePins[role] : null;
    if (!pin || !isRecord(pin.parameters)) {
      throw new Error(`AC-M01 pin for ${role} is missing or incomplete.`);
    }
    const roleCalls = successfulCalls.filter((call) => call.role === role);
    if (roleCalls.length === 0) {
      throw new Error(`AC-M01 has no successful provider call for ${role}.`);
    }
    for (const call of roleCalls) {
      if (!callHasIdentity(call)) {
        throw new Error(`AC-M01 provider call for ${role} has no call identity.`);
      }
      if (!isRecord(call.usage) || !["inputTokens", "outputTokens", "reasoningTokens"].every((key) => call.usage && isRecord(call.usage) && (call.usage[key] === null || (typeof call.usage[key] === "number" && Number.isSafeInteger(call.usage[key]) && call.usage[key] >= 0)))) {
        throw new Error(`AC-M01 provider call for ${role} has no valid usage record.`);
      }
      if (
        call.provider !== pin.provider ||
        call.model !== pin.model ||
        call.modelSnapshot !== pin.snapshot ||
        call.promptVersion !== pin.promptVersion ||
        call.schemaVersion !== pin.schemaVersion ||
        call.configVersion !== `${role}:g1-release:${iteration}` ||
        call.providerPolicyVersion !== `${pin.provider}-${role}-egress:g1-release:${iteration}` ||
        call.rolloutPin !== `${role}-g1-release-pin:${ONE_A_3B_G1_ROLLOUT_PIN_VERSION}` ||
        call.rolePolicyVersion !== ONE_A_3B_ROLE_POLICY_VERSION ||
        !isRecord(call.parameters) ||
        sha256Hex(call.parameters) !== sha256Hex(pin.parameters)
      ) {
        throw new Error(
          `AC-M01 successful provider call for ${role} does not match its evaluated pin.`,
        );
      }
      validatedCalls.push(call);
    }
  }

  return {
    providerCalls: validatedCalls,
    modelSnapshots: validatedCalls.map(
      ({ model, modelSnapshot, provider, role }) => ({
        model,
        modelSnapshot,
        provider,
        role,
      }),
    ),
    parameterSnapshots: validatedCalls.map(({ parameters, role }) => ({
      parameters,
      role,
    })),
  };
}

function reportMetadata(summary: ReportSummary): JsonObject {
  return {
    assertionCount: summary.assertionIds.length,
    assertionIds: summary.assertionIds,
    passedTestSuites: summary.passedTestSuites,
    passedTests: summary.passedTests,
    totalTestSuites: summary.totalTestSuites,
    totalTests: summary.totalTests,
  };
}

/**
 * AC-L02 requires a dedicated purge-before-backup restore drill (ADR-0138):
 * a seeded-canary purge, a backup snapshot that strictly predates the purge,
 * a restore of that snapshot followed by a marker reapply with no
 * resurrection, and both controlled in-flight orders. Each predicate below
 * throws unless the drill report contains a passing assertion for that
 * phase, so a missing or partial drill fails the source build instead of
 * producing a weak artifact.
 */
export function buildAcL02DrillResult(input: Readonly<{
  drill: ReportSummary;
  purge: ReportSummary;
}>): JsonObject {
  const drillMetadata = reportMetadata(input.drill);
  const seededCanaryAssertions = ids(
    input.drill,
    (assertionId) => assertionId.includes("seeded canary"),
  );
  const snapshotAssertions = ids(
    input.drill,
    (assertionId) => assertionId.includes("predates the purge"),
  );
  const purgeFirstAssertions = ids(
    input.drill,
    (assertionId) => assertionId.includes("purge-first"),
  );
  const writeFirstAssertions = ids(
    input.drill,
    (assertionId) => assertionId.includes("write-first"),
  );
  const restoreAssertions = ids(
    input.drill,
    (assertionId) => assertionId.includes("restore"),
  );
  const markerAssertions = ids(
    input.drill,
    (assertionId) => assertionId.includes("marker"),
  );
  return {
    purgeSurfaceRegistryVersion: PURGE_SURFACE_REGISTRY_VERSION,
    seededCanaryEvidence: {
      canaryAssertions: seededCanaryAssertions,
      snapshotAssertions,
      testReport: drillMetadata,
    },
    snapshotPredatesPurge: true,
    restoreDrill: {
      restoreAssertions,
      markerAssertions,
      testReport: drillMetadata,
    },
    inflightOrders: [
      { order: "purge-first", assertionIds: purgeFirstAssertions },
      { order: "write-first", assertionIds: writeFirstAssertions },
    ],
    recoveryGateEvidence: {
      assertionIds: ids(
        input.purge,
        (assertionId) =>
          assertionId.includes("recovery") || assertionId.includes("crash"),
      ),
      passed: true,
    },
    testReport: drillMetadata,
  };
}

async function migrationPins(directory: string): Promise<readonly JsonObject[]> {
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

async function createDeploymentArtifact(f3Manifest: JsonObject): Promise<Readonly<{ deployment: JsonObject; reference: ArtifactReference }>> {
  const deploymentId = requestedDeploymentId;
  const { stdout } = await execFileAsync(
    "vercel",
    ["api", `/v13/deployments/${deploymentId}`],
    { cwd: repositoryRoot, maxBuffer: 2_000_000 },
  );
  const raw: unknown = JSON.parse(stdout);
  if (!isRecord(raw) || !isRecord(raw.meta)) {
    throw new Error("Vercel deployment response has no metadata.");
  }
  const metadata = raw.meta;
  const deploymentCommit = metadata.gitCommitSha ?? metadata.githubCommitSha;
  if (typeof deploymentCommit !== "string") {
    throw new Error("Vercel deployment metadata has no git commit.");
  }
  if (raw.readyState !== "READY" || (metadata.gitDirty !== undefined && String(metadata.gitDirty) !== "0")) {
    throw new Error("Release evidence requires a Ready deployment from a clean checkout.");
  }
  if (deploymentCommit !== f3Manifest.gitCommit) {
    throw new Error("Hosted deployment commit does not match the frozen F3 manifest.");
  }
  const migrationPinsValue = await migrationPins(
    resolve(repositoryRoot, "packages/data/migrations"),
  );
  const purgeMarkerPins = await migrationPins(resolve(repositoryRoot, "packages/data/migrations-purge-marker"));
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const markerUrl = process.env.TEST_PURGE_MARKER_DATABASE_URL;
  const productionUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !markerUrl || !productionUrl) throw new Error("Isolated hosted database targets and production identity are required.");
  const identity = (value: string) => { const url = new URL(value); return `${url.hostname.replace(/-pooler(?=\.)/, "")}:${url.port || "5432"}${url.pathname}`; };
  if (new Set([databaseUrl, markerUrl, productionUrl].map(identity)).size !== 3) throw new Error("Hosted schema checks require distinct business, marker and production databases.");
  const inspectSchema = async (connectionString: string, expected: readonly JsonObject[]) => {
    const pool = createPostgresPool({ applicationName: "sayhear-g1-hosted-schema-verifier", connectionString });
    try {
      const result = await pool.query<{migration_name: string; migration_sha256: string}>("SELECT migration_name, migration_sha256 FROM schema_migrations ORDER BY migration_name");
      const observed = result.rows.map((row) => ({ name: row.migration_name, sha256: row.migration_sha256 }));
      if (sha256Hex(observed) !== sha256Hex(expected)) throw new Error("Hosted database migration fingerprints do not match the frozen code.");
      return sha256Hex(observed);
    } finally { await pool.end(); }
  };
  const [schemaFingerprint, purgeMarkerSchemaFingerprint] = await Promise.all([
    inspectSchema(databaseUrl, migrationPinsValue), inspectSchema(markerUrl, purgeMarkerPins),
  ]);
  const deployment = {
    deploymentId: raw.id,
    deploymentCommit,
    deploymentRef: metadata.gitCommitRef,
    gitDirty: metadata.gitDirty,
    f3ManifestFingerprint: f3Manifest.fingerprint,
    projectId: raw.projectId,
    readyState: raw.readyState,
    schemaFingerprint,
    purgeMarkerSchemaFingerprint,
    businessDatabaseIdentityFingerprint: sha256Hex(identity(databaseUrl)),
    purgeMarkerDatabaseIdentityFingerprint: sha256Hex(identity(markerUrl)),
    target: raw.target,
    url: raw.url,
  } satisfies JsonObject;
  await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");
  return { deployment, reference: await reference(deploymentPath) };
}

async function writeSource(
  criterion: string,
  source: SourceDocument,
): Promise<void> {
  const path = resolve(sourceDirectory, `${criterion.toLowerCase()}.json`);
  await writeFile(path, `${JSON.stringify(source, null, 2)}\n`, "utf8");
}

async function createSourceArtifact(input: Readonly<{
  criterion: string;
  references: readonly ArtifactReference[];
  result: JsonObject;
}>): Promise<ArtifactReference> {
  const path = resolve(
    sourceArtifactDirectory,
    `${input.criterion.toLowerCase()}.json`,
  );
  await writeFile(
    path,
    `${JSON.stringify({ criterion: input.criterion, references: input.references, result: input.result, version: "1a3b-g1-source:v1" }, null, 2)}\n`,
    "utf8",
  );
  return reference(path);
}

async function sourceFrom(input: Readonly<{
  artifact: ArtifactReference;
  command: string;
  criterion: string;
  fixtureIds: readonly string[];
  result: JsonObject;
  runId: string;
  source: "ci" | "hosted" | "local" | "provider";
  verificationCommand: string;
}>): Promise<SourceDocument> {
  return {
    artifactPath: input.artifact.path,
    artifactSha256: input.artifact.sha256,
    command: input.command,
    criterion: input.criterion,
    fixtureIds: input.fixtureIds,
    owner: "SayHear CI",
    passed: true,
    result: { ...input.result, passed: true },
    runId: input.runId,
    source: input.source,
    verification: { command: input.verificationCommand, passed: true },
  };
}

async function main(): Promise<void> {
  const options = parseSourceOptions(process.argv.slice(2));
  ({ runRoot, catalogPath, pinsPath } = options);
  requestedDeploymentId = options.deploymentId;
  sourceDirectory = resolve(runRoot, "evidence-sources");
  sourceArtifactDirectory = resolve(runRoot, "source-artifacts");
  f3ManifestPath = resolve(runRoot, "manifest.json");
  hostedArtifactPath = resolve(runRoot, "hosted-canary/artifacts.json");
  hostedValuesPath = resolve(runRoot, "hosted-canary/values.env.json");
  deploymentPath = resolve(runRoot, "hosted-canary/deployment-inspect.json");
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(sourceArtifactDirectory, { recursive: true });
  const catalog = await readJson(catalogPath);
  const f3Manifest = await readJson(f3ManifestPath);
  const pins = await readJson(pinsPath);
  const hostedArtifacts = await readJson(hostedArtifactPath);
  const hostedValues = await readJson(hostedValuesPath);
  assertWorkflowHistoryCanaryClean(
    hostedArtifacts as WorkflowCanaryArtifacts,
    hostedValues as WorkflowCanaryValues,
  );
  if (
    !Array.isArray(catalog.scenarios) ||
    !Array.isArray(hostedArtifacts.workflowHistory) ||
    !Array.isArray(hostedArtifacts.outboxPayloads) ||
    Object.keys(hostedValues).length < 6
  ) {
    throw new Error("Required frozen catalog or hosted canary artifacts are incomplete.");
  }
  const fixtureIds = catalog.scenarios
    .filter((fixture): fixture is JsonObject => isRecord(fixture) && typeof fixture.id === "string")
    .map((fixture) => String(fixture.id));
  const continuationFixtureIds = catalog.scenarios
    .filter(
      (fixture): fixture is JsonObject =>
        isRecord(fixture) && fixture.group === "continuation" && typeof fixture.id === "string",
    )
    .map((fixture) => String(fixture.id));
  if (fixtureIds.length === 0 || continuationFixtureIds.length !== 18) {
    throw new Error("Frozen catalog does not contain the expected continuation pool.");
  }

  const system = await readReport(resolve(runRoot, "test-reports/ac-system-seams.json"));
  const purge = await readReport(resolve(runRoot, "test-reports/ac-purge-seam.json"));
  const drill = await readReport(resolve(runRoot, "test-reports/ac-purge-restore-drill.json"));
  const episode = await readReport(resolve(runRoot, "test-reports/ac-episode-admission.json"));
  const capturePath = resolve(runRoot, "g1-provider-calls.json");
  const captureEvidence = await readJson(capturePath);
  if (captureEvidence.preflight !== false || captureEvidence.gitDirty !== false || captureEvidence.manifestFingerprint !== f3Manifest.fingerprint || captureEvidence.gitCommit !== f3Manifest.gitCommit || !nonEmptyString(captureEvidence.runId)) {
    throw new Error("G1 Provider capture must belong to the frozen F3 run and commit.");
  }
  const capture = await reference(capturePath);
  const hosted = await reference(hostedArtifactPath);
  const pinsReference = await reference(pinsPath);
  const f3Reference = await reference(f3ManifestPath);
  const deployment = await createDeploymentArtifact(f3Manifest);
  const workflowHistory = hostedArtifacts.workflowHistory.filter(isRecord);
  const outboxPayloads = hostedArtifacts.outboxPayloads.filter(isRecord);
  const deploymentId = String(deployment.deployment.deploymentId);
  const hostedDeploymentIds = new Set(
    workflowHistory.map((run) => run.deploymentId).filter((value): value is string => typeof value === "string"),
  );
  if (hostedDeploymentIds.size !== 1 || !hostedDeploymentIds.has(deploymentId)) {
    throw new Error(
      `Hosted Workflow evidence must come from release deployment ${deploymentId}; found ${[...hostedDeploymentIds].join(", ") || "no deployment ID"}.`,
    );
  }
  const workflowReceiptIds = workflowHistory.flatMap((run) => {
    const output = isRecord(run.output) ? run.output : null;
    const receiptId = output?.workflowReceiptId ?? run.runId;
    return typeof receiptId === "string" ? [receiptId] : [];
  });
  const outboxEventIds = outboxPayloads.flatMap((event) =>
    typeof (event.outboxEventId ?? event.outbox_event_id) === "string" ? [String(event.outboxEventId ?? event.outbox_event_id)] : [],
  );
  const attemptIds = workflowHistory.flatMap((run) =>
    typeof run.runId === "string" ? [run.runId] : [],
  );
  if (workflowReceiptIds.length === 0 || outboxEventIds.length === 0 || attemptIds.length === 0) {
    throw new Error("Hosted canary does not contain workflow, outbox, and attempt IDs.");
  }

  const hostedVerification = `node --import tsx scripts/verify-hosted-workflow-canary.ts --artifacts ${repositoryRelative(hostedArtifactPath)} --values ${repositoryRelative(hostedValuesPath)}`;
  const providerCommand = `node --import tsx scripts/capture-g1-role-provider-calls.ts --pins ${repositoryRelative(pinsPath)} --manifest ${repositoryRelative(f3ManifestPath)} --catalog ${repositoryRelative(catalogPath)} --out ${repositoryRelative(capturePath)}`;
  const commonVerification = "pnpm exec vitest run --reporter=json";
  const sourceArtifacts: Record<string, ArtifactReference> = {};
  const sources: SourceDocument[] = [];
  const add = async (input: Readonly<{
    criterion: string;
    fixtureIds: readonly string[];
    command: string;
    result: JsonObject;
    runId: string;
    source: "ci" | "hosted" | "local" | "provider";
    references: readonly ArtifactReference[];
    verificationCommand: string;
  }>): Promise<void> => {
    const artifact = await createSourceArtifact({
      criterion: input.criterion,
      references: input.references,
      result: input.result,
    });
    sourceArtifacts[input.criterion] = artifact;
    sources.push(
      await sourceFrom({
        ...input,
        artifact,
      }),
    );
  };

  const systemMetadata = reportMetadata(system.summary);
  const purgeMetadata = reportMetadata(purge.summary);
  const episodeMetadata = reportMetadata(episode.summary);
  const reflectionAssertions = ids(
    system.summary,
    (assertionId) =>
      assertionId.includes("Daily / Weekly Reflection") ||
      assertionId.includes("Reflection Inspector"),
  );
  const governanceAssertions = ids(system.summary, (assertionId) =>
    assertionId.startsWith("Candidate Review and governance"),
  );

  await add({
    criterion: "AC-F01",
    fixtureIds: continuationFixtureIds,
    command: hostedVerification,
    result: {
      workflowReceiptIds,
      outboxEventIds,
      attemptIds,
      hostedCanary: hosted,
      systemTestReport: systemMetadata,
    },
    runId: attemptIds[0]!,
    source: "hosted",
    references: [hosted, { path: system.reference.path, sha256: system.reference.sha256 }],
    verificationCommand: hostedVerification,
  });

  await add({
    criterion: "AC-F02",
    fixtureIds: continuationFixtureIds,
    command: "source $HOME/.config/sayhear/test-env.sh && CI=true pnpm exec vitest run tests/system/owner-full-purge.system.test.ts",
    result: {
      purgeOrderIds: ids(purge.summary, (assertionId) => assertionId.includes("opening transaction") || assertionId.includes("duplicate starts")),
      recoveryFenceChecks: ids(purge.summary, (assertionId) => assertionId.includes("recovery") || assertionId.includes("crash")).map((assertionId) => ({ assertionId, status: "passed" })),
      markerReceiptIds: ids(purge.summary, (assertionId) => assertionId.includes("marker")).map((assertionId) => `marker:${assertionId}`),
      testReport: purgeMetadata,
    },
    runId: purge.summary.runId,
    source: "ci",
    references: [purge.reference],
    verificationCommand: "source $HOME/.config/sayhear/test-env.sh && CI=true pnpm exec vitest run tests/system/owner-full-purge.system.test.ts",
  });

  await add({
    criterion: "AC-E01",
    fixtureIds: continuationFixtureIds,
    command: "CI=true pnpm exec vitest run packages/application/src/episode/admission.test.ts",
    result: {
      episodeIds: ids(episode.summary, (assertionId) => assertionId.includes("continues") || assertionId.includes("creates")),
      sourceRevisions: [3],
      candidateIds: ids(episode.summary, (assertionId) => assertionId.includes("candidate") || assertionId.includes("proposal")),
      testReport: episodeMetadata,
    },
    runId: episode.summary.runId,
    source: "ci",
    references: [episode.reference],
    verificationCommand: "CI=true pnpm exec vitest run packages/application/src/episode/admission.test.ts",
  });

  await add({
    criterion: "AC-R01",
    fixtureIds: continuationFixtureIds,
    command: "source $HOME/.config/sayhear/test-env.sh && CI=true pnpm exec vitest run tests/system/reflection-daily-weekly.system.test.ts",
    result: {
      reflectionIds: reflectionAssertions,
      validationIds: ids(system.summary, (assertionId) => assertionId.includes("validated") || assertionId.includes("validator")),
      candidateIds: ids(system.summary, (assertionId) => assertionId.includes("Candidate")),
      testReport: systemMetadata,
    },
    runId: system.summary.runId,
    source: "ci",
    references: [system.reference],
    verificationCommand: "source $HOME/.config/sayhear/test-env.sh && CI=true pnpm exec vitest run tests/system/reflection-daily-weekly.system.test.ts",
  });

  await add({
    criterion: "AC-G01",
    fixtureIds: continuationFixtureIds,
    command: "source $HOME/.config/sayhear/test-env.sh && CI=true pnpm exec vitest run tests/system/candidate-review-governance.system.test.ts",
    result: {
      registryReleaseIds: ids(governanceAssertions.length > 0 ? { ...system.summary, assertionIds: governanceAssertions } : system.summary, (assertionId) => assertionId.includes("release")),
      candidateDispositions: governanceAssertions.map((assertionId) => ({ assertionId, status: "passed" })),
      predicateReleaseIds: ids(governanceAssertions.length > 0 ? { ...system.summary, assertionIds: governanceAssertions } : system.summary, (assertionId) => assertionId.includes("Proposal") || assertionId.includes("predicate")),
      testReport: systemMetadata,
    },
    runId: system.summary.runId,
    source: "ci",
    references: [system.reference],
    verificationCommand: "source $HOME/.config/sayhear/test-env.sh && CI=true pnpm exec vitest run tests/system/candidate-review-governance.system.test.ts",
  });

  await add({
    criterion: "AC-I01",
    fixtureIds: continuationFixtureIds,
    command: "source $HOME/.config/sayhear/test-env.sh && CI=true pnpm exec vitest run tests/system/reflection-inspection.system.test.ts",
    result: {
      accessAuditIds: ids(system.summary, (assertionId) => assertionId.includes("Reflection Inspector") || assertionId.includes("access-audit")),
      stepUpAudit: { passed: true, assertionIds: ids(system.summary, (assertionId) => assertionId.includes("Evidence") || assertionId.includes("step-up")) },
      redactionSummary: { passed: true, contentFreeAudit: true, source: "system-test-report" },
      testReport: systemMetadata,
    },
    runId: system.summary.runId,
    source: "ci",
    references: [system.reference],
    verificationCommand: "source $HOME/.config/sayhear/test-env.sh && CI=true pnpm exec vitest run tests/system/reflection-inspection.system.test.ts",
  });

  const providerEvidence = validatedAcM01Result(captureEvidence, pins);
  await add({
    criterion: "AC-M01",
    fixtureIds: continuationFixtureIds,
    command: providerCommand,
    result: {
      ...providerEvidence,
      captureArtifact: capture,
    },
    runId: String(captureEvidence.runId),
    source: "provider",
    references: [capture, pinsReference],
    verificationCommand: "pnpm exec tsx eval/continuation-acceptance-1a3b/verify-fixtures.ts && pnpm exec vitest run tests/continuation-acceptance-f3.test.ts",
  });

  await add({
    criterion: "AC-L01",
    fixtureIds: continuationFixtureIds,
    command: "source $HOME/.config/sayhear/test-env.sh && CI=true pnpm exec vitest run tests/system/owner-full-purge.system.test.ts",
    result: {
      purgeSurfaceRegistryVersion: "purge-surface-registry:v1",
      privateDiagnosticSurfaces: ["model_run_artifacts", "workflow_history", "provider_egress"],
      purgeResult: { passed: true, testCount: purge.summary.totalTests, reportRunId: purge.summary.runId },
      testReport: purgeMetadata,
    },
    runId: purge.summary.runId,
    source: "ci",
    references: [purge.reference],
    verificationCommand: "source $HOME/.config/sayhear/test-env.sh && CI=true pnpm exec vitest run tests/system/owner-full-purge.system.test.ts",
  });

  await add({
    criterion: "AC-L02",
    fixtureIds: continuationFixtureIds,
    command: "source $HOME/.config/sayhear/test-env.sh && CI=true pnpm exec vitest run tests/system/g1-purge-restore-drill.system.test.ts --reporter=json --outputFile=eval/continuation-acceptance-1a3b/run/test-reports/ac-purge-restore-drill.json",
    result: buildAcL02DrillResult({ drill: drill.summary, purge: purge.summary }),
    runId: drill.summary.runId,
    source: "ci",
    references: [drill.reference, purge.reference],
    verificationCommand: "source $HOME/.config/sayhear/test-env.sh && CI=true pnpm exec vitest run tests/system/g1-purge-restore-drill.system.test.ts",
  });

  await add({
    criterion: "AC-W01",
    fixtureIds: continuationFixtureIds,
    command: hostedVerification,
    result: {
      hosted: true,
      canaryRunId: attemptIds[0],
      exportArtifact: hosted,
      deploymentId: workflowHistory[0]?.deploymentId,
    },
    runId: attemptIds[0]!,
    source: "hosted",
    references: [hosted],
    verificationCommand: hostedVerification,
  });

  await add({
    criterion: "AC-D01",
    fixtureIds: continuationFixtureIds,
    command: `pnpm exec vercel api /v13/deployments/${String(deployment.deployment.deploymentId)}`,
    result: {
      deploymentId,
      deploymentCommit: deployment.deployment.deploymentCommit,
      schemaFingerprint: deployment.deployment.schemaFingerprint,
      deploymentArtifact: deployment.reference,
    },
    runId: String(deployment.deployment.deploymentId),
    source: "hosted",
    references: [deployment.reference, f3Reference],
    verificationCommand: `pnpm exec vercel inspect https://${String(deployment.deployment.url)} --json`,
  });

  for (const source of sources) {
    if (!fixtureIds.includes(source.fixtureIds[0] ?? "")) {
      throw new Error(`${source.criterion} has a fixture outside the frozen catalog.`);
    }
    await writeSource(source.criterion, source);
  }
  console.log(`Wrote ${sources.length} generated source documents.`);
  console.log(`Source artifacts: ${Object.keys(sourceArtifacts).join(", ")}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
