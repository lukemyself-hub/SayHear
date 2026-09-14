import {
  ONE_A_3B_G2_BUNDLE_ROLES,
  ONE_A_3B_G2_DEFERRED_ROLES,
  ONE_A_3B_G2_ENABLED_ROLES,
  type OneA3bModelRole,
} from "./model-role-contract";
import {
  ONE_A_3B_ROLE_POLICY_VERSION,
  createModelRoleRegistry,
  ModelRoleConfigurationError,
  type ModelRoleConfigurationSnapshot,
} from "./model-role-runtime";
import { EPISODE_BUILDER_POLICY_VERSION } from "./episode/types";
import {
  OPEN_LOOP_EXTRACTION_POLICY_VERSION,
  OPEN_LOOP_FORMATION_POLICY_VERSION,
} from "./open-loop/types";
import { NARRATIVE_VALIDATION_POLICY_VERSION } from "./narrative-validation/types";
import {
  PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION,
  PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
} from "./proactive-followup/types";
import {
  PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
  PURGE_SURFACE_REGISTRY_VERSION,
  PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
} from "./purge-surface-registry";
import { REFLECTION_READINESS_POLICY_VERSION } from "./reflection/types";
import { sha256Hex } from "./one-a-3b-release";

export const ONE_A_3B_G2_RELEASE_MANIFEST_VERSION =
  "1a3b-g2-release:v1" as const;
export const ONE_A_3B_G2_CONTINUATION_LEDGER_VERSION =
  "1a3b-g2-continuation-ledger:v1" as const;

/**
 * G2 is the second direct-cutover stage. Open Loop and Proactive follow-up
 * merge as one bundle on top of the switched G1 roles; Bio stays deferred
 * for G3 even though its read schema already exists.
 */
export {
  ONE_A_3B_G2_BUNDLE_ROLES,
  ONE_A_3B_G2_DEFERRED_ROLES,
  ONE_A_3B_G2_ENABLED_ROLES,
} from "./model-role-contract";

export const ONE_A_3B_G2_REQUIRED_ACCEPTANCE_CRITERIA = [
  "AC-O01",
  "AC-P01",
  "AC-P02",
  "AC-X01",
  "AC-X04",
  "AC-L02",
  "AC-W01",
  "AC-D01",
  "AC-M01",
] as const;

export type OneA3bG2AcceptanceCriterion =
  (typeof ONE_A_3B_G2_REQUIRED_ACCEPTANCE_CRITERIA)[number];

export type OneA3bG2EvidenceSource =
  | "local"
  | "ci"
  | "hosted"
  | "provider"
  | "human";

export type OneA3bG2EvidenceStatus = "verified" | "pending" | "blocked";

function isG2EvidenceStatus(value: unknown): value is OneA3bG2EvidenceStatus {
  return value === "verified" || value === "pending" || value === "blocked";
}

export type OneA3bG2Evidence = Readonly<{
  criterion: OneA3bG2AcceptanceCriterion;
  fixtureIds: readonly string[];
  command: string;
  artifactSha256: string | null;
  artifactPath: string | null;
  owner: string;
  source: OneA3bG2EvidenceSource;
  status: OneA3bG2EvidenceStatus;
  note?: string;
}>;

export type OneA3bG2ContinuationCalibration = Readonly<{
  ledgerPath: string;
  ledgerSha256: string;
  ledgerVersion: typeof ONE_A_3B_G2_CONTINUATION_LEDGER_VERSION;
  f3ManifestFingerprint: string;
  totalCases: 15;
  englishCases: 8;
  chineseCases: 5;
  codeSwitchCases: 2;
  netPreference: number;
  localeRegressions: number;
  protectedCategoryRegressions: number;
  humanOwner: "Luke";
  status: OneA3bG2EvidenceStatus;
  note?: string;
}>;

export type OneA3bG2MigrationPin = Readonly<{
  name: string;
  sha256: string;
}>;

export type OneA3bG2ReleaseManifest = Readonly<{
  version: typeof ONE_A_3B_G2_RELEASE_MANIFEST_VERSION;
  stage: "g2";
  status: "blocked" | "ready_for_cutover" | "active" | "rolled_back";
  createdAt: string;
  gitCommit: string;
  baseG1ReleaseFingerprint: string;
  schema: Readonly<{
    migrations: readonly OneA3bG2MigrationPin[];
    fingerprint: string;
    purgeMarkerMigrations: readonly OneA3bG2MigrationPin[];
    purgeMarkerFingerprint: string;
    purgeSurfaceRegistryVersion: typeof PURGE_SURFACE_REGISTRY_VERSION;
    externalIntegrationManifestVersion: typeof PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION;
    workflowSubjectManifestVersion: typeof PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION;
  }>;
  policyBundle: Readonly<{
    modelRolePolicyVersion: typeof ONE_A_3B_ROLE_POLICY_VERSION;
    episodeBuilderPolicyVersion: typeof EPISODE_BUILDER_POLICY_VERSION;
    reflectionReadinessPolicyVersion: typeof REFLECTION_READINESS_POLICY_VERSION;
    narrativeValidationPolicyVersion: typeof NARRATIVE_VALIDATION_POLICY_VERSION;
    openLoopExtractionPolicyVersion: typeof OPEN_LOOP_EXTRACTION_POLICY_VERSION;
    openLoopFormationPolicyVersion: typeof OPEN_LOOP_FORMATION_POLICY_VERSION;
    proactivePolicyBundleVersion: typeof PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION;
    proactiveSelectionPolicyVersion: typeof PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION;
    fallbackMode: "disabled";
    bundleScope: "open_loop_proactive";
    futureStages: "bio_only";
    fingerprint: string;
  }>;
  roles: Readonly<{
    configurations: readonly ModelRoleConfigurationSnapshot[];
    enabledRoles: readonly OneA3bModelRole[];
    bundleRoles: typeof ONE_A_3B_G2_BUNDLE_ROLES;
    deferredRoles: typeof ONE_A_3B_G2_DEFERRED_ROLES;
    configurationFingerprint: string;
  }>;
  fixture: Readonly<{
    f3ManifestPath: string;
    f3ManifestSha256: string;
    f3ManifestFingerprint: string;
    fixtureSeed: number;
    sampleSeed: number;
    fingerprint: string;
  }>;
  continuationCalibration: OneA3bG2ContinuationCalibration;
  commands: readonly string[];
  evidence: readonly OneA3bG2Evidence[];
  cutoverState: "disabled" | "active" | "rolled_back";
  releaseIdentityFingerprint: string;
  fingerprint: string;
}>;

export type OneA3bG2ReleaseManifestInput = Readonly<{
  gitCommit: string;
  baseG1ReleaseFingerprint: string;
  migrations: readonly OneA3bG2MigrationPin[];
  purgeMarkerMigrations: readonly OneA3bG2MigrationPin[];
  roleConfigurations: readonly ModelRoleConfigurationSnapshot[];
  fixture: Readonly<{
    f3ManifestPath: string;
    f3ManifestSha256: string;
    f3ManifestFingerprint: string;
    fixtureSeed: number;
    sampleSeed: number;
  }>;
  continuationCalibration: OneA3bG2ContinuationCalibration;
  commands: readonly string[];
  evidence: readonly OneA3bG2Evidence[];
  cutoverState?: "disabled" | "active" | "rolled_back";
  createdAt?: string;
}>;

export type OneA3bG2ReleaseManifestVerification = Readonly<{
  mismatches: readonly string[];
  passed: boolean;
}>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("Release manifest contains a non-serializable value.");
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Release manifest contains a non-serializable value.");
}

function safeStableJson(value: unknown): string | null {
  try {
    return stableJson(value);
  } catch {
    return null;
  }
}

function safeSha256Hex(value: unknown): string | null {
  try {
    return sha256Hex(value);
  } catch {
    return null;
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be non-empty.`);
  }
}

function requireSha256(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase SHA-256 hex digest.`);
  }
}

function requireFingerprint(value: string, field: string): void {
  if (!FINGERPRINT_PATTERN.test(value)) {
    throw new Error(`${field} must be a sha256-prefixed fingerprint.`);
  }
}

function requireInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
}

function sortedMigrations(
  migrations: readonly OneA3bG2MigrationPin[],
): readonly OneA3bG2MigrationPin[] {
  const sorted = migrations
    .map((migration) => ({ ...migration }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const [index, migration] of sorted.entries()) {
    requireNonEmpty(migration.name, "migration.name");
    if (!MIGRATION_NAME_PATTERN.test(migration.name)) {
      throw new Error(`migration ${migration.name} has an invalid filename.`);
    }
    requireSha256(migration.sha256, `migration ${migration.name}.sha256`);
    if (sorted[index - 1]?.name === migration.name) {
      throw new Error(`migration ${migration.name} is listed more than once.`);
    }
  }
  if (sorted.length === 0) {
    throw new Error("At least one migration must be frozen in the G2 manifest.");
  }
  return sorted;
}

function isG2Role(role: OneA3bModelRole): boolean {
  return (ONE_A_3B_G2_ENABLED_ROLES as readonly string[]).includes(role);
}

function isBundleRole(role: OneA3bModelRole): boolean {
  return (ONE_A_3B_G2_BUNDLE_ROLES as readonly string[]).includes(role);
}

function isDeferredRole(role: OneA3bModelRole): boolean {
  return (ONE_A_3B_G2_DEFERRED_ROLES as readonly string[]).includes(role);
}

function sortedConfigurations(
  configurations: readonly ModelRoleConfigurationSnapshot[],
): readonly ModelRoleConfigurationSnapshot[] {
  for (const configuration of configurations) {
    if (isDeferredRole(configuration.role)) {
      throw new Error(
        `G2 cannot enable deferred model role ${configuration.role}.`,
      );
    }
    if (!isG2Role(configuration.role)) {
      throw new Error(
        `G2 model role ${configuration.role} is not part of the second release stage.`,
      );
    }
  }
  const present = new Set(configurations.map((configuration) => configuration.role));
  const bundlePresent = ONE_A_3B_G2_BUNDLE_ROLES.filter((role) =>
    present.has(role),
  );
  if (bundlePresent.length === 1) {
    throw new Error(
      `G2 must enable open_loop.extract and proactive.followup as a single bundle; found only ${bundlePresent[0]}.`,
    );
  }
  return [...configurations].sort((left, right) => left.role.localeCompare(right.role));
}

function validateFixture(input: OneA3bG2ReleaseManifestInput["fixture"]): void {
  requireNonEmpty(input.f3ManifestPath, "fixture.f3ManifestPath");
  requireSha256(input.f3ManifestSha256, "fixture.f3ManifestSha256");
  requireFingerprint(input.f3ManifestFingerprint, "fixture.f3ManifestFingerprint");
  requireInteger(input.fixtureSeed, "fixture.fixtureSeed");
  requireInteger(input.sampleSeed, "fixture.sampleSeed");
}

/**
 * AC-X01 needs a strictly positive overall preference for the candidate,
 * with no net regression in any locale or protected category. Either side
 * may still lose single pairs; only the aggregates gate the release.
 */
export function continuationPreferencePasses(input: Readonly<{
  netPreference: number;
  localeRegressions: number;
  protectedCategoryRegressions: number;
}>): boolean {
  return (
    Number.isSafeInteger(input.netPreference) &&
    Number.isSafeInteger(input.localeRegressions) &&
    Number.isSafeInteger(input.protectedCategoryRegressions) &&
    input.netPreference > 0 &&
    input.localeRegressions === 0 &&
    input.protectedCategoryRegressions === 0
  );
}

function validateContinuationCalibration(
  input: OneA3bG2ContinuationCalibration,
  fixture: OneA3bG2ReleaseManifestInput["fixture"],
): void {
  requireNonEmpty(input.ledgerPath, "continuationCalibration.ledgerPath");
  requireSha256(input.ledgerSha256, "continuationCalibration.ledgerSha256");
  requireFingerprint(
    input.f3ManifestFingerprint,
    "continuationCalibration.f3ManifestFingerprint",
  );
  if (input.ledgerVersion !== ONE_A_3B_G2_CONTINUATION_LEDGER_VERSION) {
    throw new Error(
      `continuationCalibration.ledgerVersion must be ${ONE_A_3B_G2_CONTINUATION_LEDGER_VERSION}.`,
    );
  }
  if (input.f3ManifestFingerprint !== fixture.f3ManifestFingerprint) {
    throw new Error(
      "continuationCalibration must belong to the frozen F3 manifest.",
    );
  }
  if (input.totalCases !== 15) {
    throw new Error("continuationCalibration.totalCases must be exactly 15.");
  }
  if (input.englishCases !== 8) {
    throw new Error("continuationCalibration.englishCases must be exactly 8.");
  }
  if (input.chineseCases !== 5) {
    throw new Error("continuationCalibration.chineseCases must be exactly 5.");
  }
  if (input.codeSwitchCases !== 2) {
    throw new Error("continuationCalibration.codeSwitchCases must be exactly 2.");
  }
  requireInteger(input.netPreference, "continuationCalibration.netPreference");
  requireInteger(input.localeRegressions, "continuationCalibration.localeRegressions");
  requireInteger(
    input.protectedCategoryRegressions,
    "continuationCalibration.protectedCategoryRegressions",
  );
  if (input.humanOwner !== "Luke") {
    throw new Error("continuationCalibration.humanOwner must be Luke.");
  }
  if (!isG2EvidenceStatus(input.status)) {
    throw new Error("continuationCalibration has an invalid status.");
  }
  if (
    input.status === "verified" &&
    !continuationPreferencePasses(input)
  ) {
    if (input.netPreference <= 0) {
      throw new Error(
        "continuationCalibration cannot be verified without a strictly positive net preference.",
      );
    }
    if (input.localeRegressions !== 0) {
      throw new Error(
        "continuationCalibration cannot be verified with a locale regression.",
      );
    }
    throw new Error(
      "continuationCalibration cannot be verified with a protected-category regression.",
    );
  }
  if (input.status !== "verified") {
    requireNonEmpty(input.note ?? "", "continuationCalibration.note");
  }
}

function validateEvidence(evidence: readonly OneA3bG2Evidence[]): void {
  const expected = new Set<string>(ONE_A_3B_G2_REQUIRED_ACCEPTANCE_CRITERIA);
  const seen = new Set<string>();
  for (const entry of evidence) {
    if (!expected.has(entry.criterion)) {
      throw new Error(`Evidence criterion ${entry.criterion} is not required by G2.`);
    }
    if (seen.has(entry.criterion)) {
      throw new Error(`G2 evidence has duplicate criterion ${entry.criterion}.`);
    }
    seen.add(entry.criterion);
    if (entry.fixtureIds.length === 0 || entry.fixtureIds.some((id) => typeof id !== "string" || id.trim() === "")) {
      throw new Error(`${entry.criterion} must list at least one fixture ID.`);
    }
    requireNonEmpty(entry.command, `${entry.criterion}.command`);
    requireNonEmpty(entry.owner, `${entry.criterion}.owner`);
    if (
      entry.criterion === "AC-X01" &&
      entry.status === "verified" &&
      entry.owner !== "Luke"
    ) {
      throw new Error(
        "AC-X01 verifies Luke adjudication and must be owned by Luke.",
      );
    }
    if (!isG2EvidenceStatus(entry.status)) {
      throw new Error(`${entry.criterion} has an invalid evidence status.`);
    }
    const requiredSource =
      entry.criterion === "AC-X01"
        ? "human"
        : entry.criterion === "AC-M01"
          ? "provider"
          : entry.criterion === "AC-W01"
            ? "hosted"
            : null;
    if (requiredSource && entry.source !== requiredSource) {
      throw new Error(
        `${entry.criterion} evidence must come from the ${requiredSource} evidence source.`,
      );
    }
    if (
      entry.criterion === "AC-X04" &&
      entry.source !== "local" &&
      entry.source !== "ci"
    ) {
      throw new Error(
        "AC-X04 evidence must come from local or ci automated evidence.",
      );
    }
    if (
      entry.status !== "verified" &&
      entry.status !== "pending" &&
      entry.status !== "blocked"
    ) {
      throw new Error(`${entry.criterion} has an invalid evidence status.`);
    }
    if (entry.status === "verified") {
      if (entry.artifactSha256 === null) {
        throw new Error(`${entry.criterion} is verified without an artifact hash.`);
      }
      requireSha256(entry.artifactSha256, `${entry.criterion}.artifactSha256`);
      requireNonEmpty(
        entry.artifactPath ?? "",
        `${entry.criterion}.artifactPath`,
      );
    } else {
      requireNonEmpty(entry.note ?? "", `${entry.criterion}.note`);
    }
  }
  const missing = ONE_A_3B_G2_REQUIRED_ACCEPTANCE_CRITERIA.filter(
    (criterion) => !seen.has(criterion),
  );
  if (missing.length > 0) {
    throw new Error(`G2 evidence is missing: ${missing.join(", ")}.`);
  }
}

function enabledRolesMatchG2(roles: readonly OneA3bModelRole[]): boolean {
  return (
    roles.length === ONE_A_3B_G2_ENABLED_ROLES.length &&
    roles.every((role, index) => role === ONE_A_3B_G2_ENABLED_ROLES[index])
  );
}

function evidenceIsComplete(evidence: readonly OneA3bG2Evidence[]): boolean {
  return evidence.every((entry) => entry.status === "verified");
}

function continuationCalibrationIsComplete(
  calibration: Readonly<{
    status: OneA3bG2EvidenceStatus;
    totalCases: number;
    englishCases: number;
    chineseCases: number;
    codeSwitchCases: number;
    netPreference: number;
    localeRegressions: number;
    protectedCategoryRegressions: number;
  }>,
): boolean {
  return (
    calibration.status === "verified" &&
    calibration.totalCases === 15 &&
    calibration.englishCases === 8 &&
    calibration.chineseCases === 5 &&
    calibration.codeSwitchCases === 2 &&
    continuationPreferencePasses(calibration)
  );
}

/**
 * Stable deployable identity for a G2 release. It covers only immutable
 * inputs — exact commit, the switched G1 fingerprint, sorted migration pins,
 * registry versions, frozen policy bundle, exact role configurations, and
 * frozen F3 fixture pins — and deliberately excludes evidence, human
 * outcomes, commands, timestamps, status, cutover state, and the full
 * content-addressed fingerprint. AC-D01 binds this identity so deployment
 * evidence can be produced before the full manifest (which contains that
 * evidence) is frozen.
 */
export function buildG2ReleaseIdentityFingerprint(input: Readonly<{
  gitCommit: string;
  baseG1ReleaseFingerprint: string;
  migrations: readonly OneA3bG2MigrationPin[];
  purgeMarkerMigrations: readonly OneA3bG2MigrationPin[];
  roleConfigurations: readonly ModelRoleConfigurationSnapshot[];
  fixture: Readonly<{
    f3ManifestSha256: string;
    f3ManifestFingerprint: string;
    fixtureSeed: number;
    sampleSeed: number;
  }>;
}>): string {
  if (!GIT_COMMIT_PATTERN.test(input.gitCommit)) {
    throw new Error("release identity gitCommit must be a full 40-character commit.");
  }
  requireFingerprint(input.baseG1ReleaseFingerprint, "release identity baseG1ReleaseFingerprint");
  const orderedMigrations = sortedMigrations(input.migrations);
  const orderedPurgeMarkerMigrations = sortedMigrations(input.purgeMarkerMigrations);
  const orderedConfigurations = sortedConfigurations(input.roleConfigurations);
  return `sha256:${sha256Hex({
    version: ONE_A_3B_G2_RELEASE_MANIFEST_VERSION,
    stage: "g2",
    gitCommit: input.gitCommit,
    baseG1ReleaseFingerprint: input.baseG1ReleaseFingerprint,
    schema: {
      migrations: orderedMigrations,
      purgeMarkerMigrations: orderedPurgeMarkerMigrations,
      purgeSurfaceRegistryVersion: PURGE_SURFACE_REGISTRY_VERSION,
      externalIntegrationManifestVersion:
        PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
      workflowSubjectManifestVersion: PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
    },
    policyBundle: {
      modelRolePolicyVersion: ONE_A_3B_ROLE_POLICY_VERSION,
      episodeBuilderPolicyVersion: EPISODE_BUILDER_POLICY_VERSION,
      reflectionReadinessPolicyVersion: REFLECTION_READINESS_POLICY_VERSION,
      narrativeValidationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
      openLoopExtractionPolicyVersion: OPEN_LOOP_EXTRACTION_POLICY_VERSION,
      openLoopFormationPolicyVersion: OPEN_LOOP_FORMATION_POLICY_VERSION,
      proactivePolicyBundleVersion: PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION,
      proactiveSelectionPolicyVersion: PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
      fallbackMode: "disabled",
      bundleScope: "open_loop_proactive",
      futureStages: "bio_only",
    },
    roles: {
      configurations: orderedConfigurations,
      enabledRoles: [...ONE_A_3B_G2_ENABLED_ROLES],
      bundleRoles: [...ONE_A_3B_G2_BUNDLE_ROLES],
      deferredRoles: [...ONE_A_3B_G2_DEFERRED_ROLES],
    },
    fixture: {
      f3ManifestSha256: input.fixture.f3ManifestSha256,
      f3ManifestFingerprint: input.fixture.f3ManifestFingerprint,
      fixtureSeed: input.fixture.fixtureSeed,
      sampleSeed: input.fixture.sampleSeed,
    },
  })}`;
}

function manifestFingerprint(
  manifest: Omit<OneA3bG2ReleaseManifest, "fingerprint">,
): string {
  return `sha256:${sha256Hex({
    ...manifest,
    createdAt: "volatile",
  })}`;
}

function expectedStatus(input: Readonly<{
  cutoverState: OneA3bG2ReleaseManifest["cutoverState"];
  enabledRoles: readonly OneA3bModelRole[];
  evidence: readonly OneA3bG2Evidence[];
  continuationCalibration: Readonly<{
    status: OneA3bG2EvidenceStatus;
    totalCases: number;
    englishCases: number;
    chineseCases: number;
    codeSwitchCases: number;
    netPreference: number;
    localeRegressions: number;
    protectedCategoryRegressions: number;
  }>;
}>): OneA3bG2ReleaseManifest["status"] {
  const complete =
    enabledRolesMatchG2(input.enabledRoles) &&
    evidenceIsComplete(input.evidence) &&
    continuationCalibrationIsComplete(input.continuationCalibration);
  if (input.cutoverState === "active") return complete ? "active" : "blocked";
  if (input.cutoverState === "rolled_back") return complete ? "rolled_back" : "blocked";
  return complete ? "ready_for_cutover" : "blocked";
}

/**
 * Build the content-addressed G2 release record. This function records
 * incomplete evidence as blocked state; it never turns an unexecuted check
 * into a pass so that a later Provider, hosted, or human run can fill the
 * same shape.
 */
export function buildOneA3bG2ReleaseManifest(
  input: OneA3bG2ReleaseManifestInput,
): OneA3bG2ReleaseManifest {
  if (!GIT_COMMIT_PATTERN.test(input.gitCommit)) {
    throw new Error("gitCommit must be a full 40-character lowercase commit.");
  }
  requireFingerprint(input.baseG1ReleaseFingerprint, "baseG1ReleaseFingerprint");
  const migrationPins = sortedMigrations(input.migrations);
  const purgeMarkerMigrationPins = sortedMigrations(input.purgeMarkerMigrations);
  const configurations = sortedConfigurations(input.roleConfigurations);
  const registry = createModelRoleRegistry(configurations);
  validateFixture(input.fixture);
  validateContinuationCalibration(input.continuationCalibration, input.fixture);
  if (input.commands.length === 0 || input.commands.some((command) => command.trim() === "")) {
    throw new Error("G2 manifest must record at least one reproduction command.");
  }
  validateEvidence(input.evidence);
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (Number.isNaN(new Date(createdAt).getTime())) {
    throw new Error("createdAt must be a valid ISO timestamp.");
  }
  const cutoverState = input.cutoverState ?? "disabled";
  if (
    cutoverState !== "disabled" &&
    cutoverState !== "active" &&
    cutoverState !== "rolled_back"
  ) {
    throw new Error("cutoverState must be disabled, active, or rolled_back.");
  }
  const policyBundle = {
    modelRolePolicyVersion: ONE_A_3B_ROLE_POLICY_VERSION,
    episodeBuilderPolicyVersion: EPISODE_BUILDER_POLICY_VERSION,
    reflectionReadinessPolicyVersion: REFLECTION_READINESS_POLICY_VERSION,
    narrativeValidationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
    openLoopExtractionPolicyVersion: OPEN_LOOP_EXTRACTION_POLICY_VERSION,
    openLoopFormationPolicyVersion: OPEN_LOOP_FORMATION_POLICY_VERSION,
    proactivePolicyBundleVersion: PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION,
    proactiveSelectionPolicyVersion: PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
    fallbackMode: "disabled" as const,
    bundleScope: "open_loop_proactive" as const,
    futureStages: "bio_only" as const,
  } as const;
  const manifestWithoutHash = {
    version: ONE_A_3B_G2_RELEASE_MANIFEST_VERSION,
    stage: "g2" as const,
    status: expectedStatus({
      cutoverState,
      enabledRoles: registry.enabledRoles,
      evidence: input.evidence,
      continuationCalibration: input.continuationCalibration,
    }),
    createdAt,
    gitCommit: input.gitCommit,
    baseG1ReleaseFingerprint: input.baseG1ReleaseFingerprint,
    schema: {
      migrations: migrationPins,
      fingerprint: sha256Hex(migrationPins),
      purgeMarkerMigrations: purgeMarkerMigrationPins,
      purgeMarkerFingerprint: sha256Hex(purgeMarkerMigrationPins),
      purgeSurfaceRegistryVersion: PURGE_SURFACE_REGISTRY_VERSION,
      externalIntegrationManifestVersion:
        PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
      workflowSubjectManifestVersion: PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
    },
    policyBundle: {
      ...policyBundle,
      fingerprint: sha256Hex(policyBundle),
    },
    roles: {
      configurations,
      enabledRoles: registry.enabledRoles,
      bundleRoles: ONE_A_3B_G2_BUNDLE_ROLES,
      deferredRoles: ONE_A_3B_G2_DEFERRED_ROLES,
      configurationFingerprint: sha256Hex(configurations),
    },
    fixture: {
      ...input.fixture,
      fingerprint: sha256Hex(input.fixture),
    },
    continuationCalibration: { ...input.continuationCalibration },
    commands: [...input.commands],
    evidence: input.evidence.map((entry) => ({
      ...entry,
      fixtureIds: [...entry.fixtureIds],
    })),
    cutoverState,
    releaseIdentityFingerprint: buildG2ReleaseIdentityFingerprint({
      gitCommit: input.gitCommit,
      baseG1ReleaseFingerprint: input.baseG1ReleaseFingerprint,
      migrations: migrationPins,
      purgeMarkerMigrations: purgeMarkerMigrationPins,
      roleConfigurations: configurations,
      fixture: input.fixture,
    }),
  } satisfies Omit<OneA3bG2ReleaseManifest, "fingerprint">;
  if (
    cutoverState === "active" &&
    manifestWithoutHash.status !== "active"
  ) {
    throw new Error("G2 cannot become active until every gate is verified.");
  }
  if (
    cutoverState === "rolled_back" &&
    manifestWithoutHash.status !== "rolled_back"
  ) {
    throw new Error("G2 rollback records require the complete frozen evidence set.");
  }
  return {
    ...manifestWithoutHash,
    fingerprint: manifestFingerprint(manifestWithoutHash),
  };
}

function pushIf(mismatches: string[], condition: boolean, message: string): void {
  if (condition) mismatches.push(message);
}

function verifyMigrations(
  value: unknown,
  mismatches: string[],
): readonly OneA3bG2MigrationPin[] {
  if (!Array.isArray(value)) {
    mismatches.push("schema migrations are not an array");
    return [];
  }
  const migrations: OneA3bG2MigrationPin[] = [];
  for (const valueEntry of value) {
    if (!isRecord(valueEntry)) {
      mismatches.push("schema migrations contain a non-object entry");
      continue;
    }
    migrations.push({
      name: typeof valueEntry.name === "string" ? valueEntry.name : "",
      sha256: typeof valueEntry.sha256 === "string" ? valueEntry.sha256 : "",
    });
  }
  const sorted = [...migrations].sort((left, right) => left.name.localeCompare(right.name));
  const migrationsJson = safeStableJson(migrations);
  const sortedMigrationsJson = safeStableJson(sorted);
  pushIf(
    mismatches,
    migrationsJson === null ||
      sortedMigrationsJson === null ||
      migrationsJson !== sortedMigrationsJson,
    "schema migrations are not sorted by filename",
  );
  const names = new Set<string>();
  for (const migration of migrations) {
    if (!MIGRATION_NAME_PATTERN.test(migration.name)) {
      mismatches.push(`invalid migration filename: ${migration.name}`);
    }
    if (names.has(migration.name)) {
      mismatches.push(`duplicate migration filename: ${migration.name}`);
    }
    names.add(migration.name);
    if (!SHA256_PATTERN.test(migration.sha256)) {
      mismatches.push(`invalid migration hash: ${migration.name}`);
    }
  }
  if (migrations.length === 0) mismatches.push("schema migrations are empty");
  return migrations;
}

function verifyEvidence(value: unknown, mismatches: string[]): OneA3bG2Evidence[] {
  if (!Array.isArray(value)) {
    mismatches.push("G2 evidence is not an array");
    return [];
  }
  const evidence: OneA3bG2Evidence[] = [];
  const required = new Set<string>(ONE_A_3B_G2_REQUIRED_ACCEPTANCE_CRITERIA);
  const sources = new Set<OneA3bG2EvidenceSource>([
    "local",
    "ci",
    "hosted",
    "provider",
    "human",
  ]);
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) {
      mismatches.push("G2 evidence contains a non-object entry");
      continue;
    }
    const criterion = typeof raw.criterion === "string" ? raw.criterion : "";
    const status = raw.status;
    const source = raw.source;
    const entry = raw as Partial<OneA3bG2Evidence>;
    if (!required.has(criterion)) mismatches.push(`unexpected G2 criterion: ${criterion}`);
    if (seen.has(criterion)) mismatches.push(`duplicate G2 criterion: ${criterion}`);
    seen.add(criterion);
    if (
      !Array.isArray(entry.fixtureIds) ||
      entry.fixtureIds.length === 0 ||
      entry.fixtureIds.some(
        (fixtureId) =>
          typeof fixtureId !== "string" || fixtureId.trim() === "",
      )
    ) {
      mismatches.push(`${criterion} has no fixture IDs`);
    }
    if (typeof entry.command !== "string" || entry.command.trim() === "") {
      mismatches.push(`${criterion} has no reproduction command`);
    }
    if (typeof entry.owner !== "string" || entry.owner.trim() === "") {
      mismatches.push(`${criterion} has no evidence owner`);
    }
    if (typeof source !== "string" || !sources.has(source as OneA3bG2EvidenceSource)) {
      mismatches.push(`${criterion} has an invalid evidence source`);
    }
    const requiredSource =
      criterion === "AC-X01"
        ? "human"
        : criterion === "AC-M01"
          ? "provider"
          : criterion === "AC-W01"
            ? "hosted"
            : null;
    if (requiredSource && source !== requiredSource) {
      mismatches.push(`${criterion} evidence is not ${requiredSource}`);
    }
    if (
      criterion === "AC-X04" &&
      source !== "local" &&
      source !== "ci"
    ) {
      mismatches.push("AC-X04 evidence is not automated local or ci evidence");
    }
    pushIf(
      mismatches,
      criterion === "AC-X01" &&
        status === "verified" &&
        entry.owner !== "Luke",
      "AC-X01 verifies Luke adjudication and must be owned by Luke",
    );
    if (!isG2EvidenceStatus(status)) {
      mismatches.push(`${criterion} has an invalid evidence status`);
    } else if (status === "verified") {
      if (typeof entry.artifactSha256 !== "string" || !SHA256_PATTERN.test(entry.artifactSha256)) {
        mismatches.push(`${criterion} verified evidence has no valid artifact hash`);
      }
      if (typeof entry.artifactPath !== "string" || entry.artifactPath.trim() === "") {
        mismatches.push(`${criterion} verified evidence has no artifact path`);
      }
    } else if (status === "pending" || status === "blocked") {
      if (typeof entry.note !== "string" || entry.note.trim() === "") {
        mismatches.push(`${criterion} incomplete evidence has no note`);
      }
    }
    if (required.has(criterion) && isG2EvidenceStatus(status)) {
      evidence.push(entry as OneA3bG2Evidence);
    }
  }
  for (const criterion of ONE_A_3B_G2_REQUIRED_ACCEPTANCE_CRITERIA) {
    if (!seen.has(criterion)) mismatches.push(`missing G2 criterion: ${criterion}`);
  }
  return evidence;
}

/** Verify an untrusted JSON manifest before it can open a runtime switch. */
export function verifyOneA3bG2ReleaseManifest(
  value: unknown,
): OneA3bG2ReleaseManifestVerification {
  const mismatches: string[] = [];
  if (!isRecord(value)) {
    return { mismatches: ["G2 release manifest is not an object"], passed: false };
  }
  pushIf(
    mismatches,
    value.version !== ONE_A_3B_G2_RELEASE_MANIFEST_VERSION,
    "unsupported G2 release manifest version",
  );
  pushIf(mismatches, value.stage !== "g2", "release manifest stage is not g2");
  pushIf(
    mismatches,
    typeof value.gitCommit !== "string" || !GIT_COMMIT_PATTERN.test(value.gitCommit),
    "gitCommit is not a full 40-character lowercase commit",
  );
  pushIf(
    mismatches,
    typeof value.baseG1ReleaseFingerprint !== "string" ||
      !FINGERPRINT_PATTERN.test(value.baseG1ReleaseFingerprint),
    "base G1 release fingerprint is not a sha256-prefixed fingerprint",
  );
  pushIf(
    mismatches,
    typeof value.createdAt !== "string" || Number.isNaN(new Date(String(value.createdAt)).getTime()),
    "createdAt is not a valid timestamp",
  );

  const schema = isRecord(value.schema) ? value.schema : null;
  if (!schema) {
    mismatches.push("schema section is missing");
  }
  const migrations = verifyMigrations(schema?.migrations, mismatches);
  const purgeMarkerMigrations = verifyMigrations(
    schema?.purgeMarkerMigrations,
    mismatches,
  );
  if (schema) {
    pushIf(
      mismatches,
      schema.fingerprint !== safeSha256Hex(migrations),
      "schema fingerprint does not match its migration hashes",
    );
    pushIf(
      mismatches,
      schema.purgeMarkerFingerprint !== safeSha256Hex(purgeMarkerMigrations),
      "purge-marker schema fingerprint does not match its migration hashes",
    );
    pushIf(
      mismatches,
      schema.purgeSurfaceRegistryVersion !== PURGE_SURFACE_REGISTRY_VERSION,
      "schema Purge Surface Registry version is not the released version",
    );
    pushIf(
      mismatches,
      schema.externalIntegrationManifestVersion !==
        PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
      "schema external integration manifest version is not the released version",
    );
    pushIf(
      mismatches,
      schema.workflowSubjectManifestVersion !==
        PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
      "schema Workflow subject manifest version is not the released version",
    );
  }

  const policyBundle = isRecord(value.policyBundle) ? value.policyBundle : null;
  const expectedPolicyBundle = {
    modelRolePolicyVersion: ONE_A_3B_ROLE_POLICY_VERSION,
    episodeBuilderPolicyVersion: EPISODE_BUILDER_POLICY_VERSION,
    reflectionReadinessPolicyVersion: REFLECTION_READINESS_POLICY_VERSION,
    narrativeValidationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
    openLoopExtractionPolicyVersion: OPEN_LOOP_EXTRACTION_POLICY_VERSION,
    openLoopFormationPolicyVersion: OPEN_LOOP_FORMATION_POLICY_VERSION,
    proactivePolicyBundleVersion: PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION,
    proactiveSelectionPolicyVersion: PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
    fallbackMode: "disabled",
    bundleScope: "open_loop_proactive",
    futureStages: "bio_only",
  } as const;
  if (!policyBundle) {
    mismatches.push("policy bundle is missing");
  } else {
    for (const [key, expected] of Object.entries(expectedPolicyBundle)) {
      if (policyBundle[key] !== expected) {
        mismatches.push(`policy bundle ${key} is not frozen to ${expected}`);
      }
    }
    pushIf(
      mismatches,
      policyBundle.fingerprint !== sha256Hex(expectedPolicyBundle),
      "policy bundle fingerprint does not match its frozen values",
    );
  }

  const roles = isRecord(value.roles) ? value.roles : null;
  let enabledRoles: readonly OneA3bModelRole[] = [];
  let configurations: readonly ModelRoleConfigurationSnapshot[] = [];
  if (!roles) {
    mismatches.push("role section is missing");
  } else {
    const rawConfigurations = roles.configurations;
    if (!Array.isArray(rawConfigurations)) {
      mismatches.push("role configurations are not an array");
    } else {
      configurations = rawConfigurations as ModelRoleConfigurationSnapshot[];
      try {
        const registry = createModelRoleRegistry(configurations);
        enabledRoles = registry.enabledRoles;
      } catch (error) {
        mismatches.push(
          error instanceof ModelRoleConfigurationError
            ? error.message
            : "role configuration is invalid",
        );
      }
    }
    const enabledRolesJson = safeStableJson(roles.enabledRoles);
    const actualEnabledRolesJson = safeStableJson(enabledRoles);
    const bundleRolesJson = safeStableJson(roles.bundleRoles);
    const expectedBundleRolesJson = safeStableJson(ONE_A_3B_G2_BUNDLE_ROLES);
    const deferredRolesJson = safeStableJson(roles.deferredRoles);
    const expectedDeferredRolesJson = safeStableJson(ONE_A_3B_G2_DEFERRED_ROLES);
    pushIf(
      mismatches,
      enabledRolesJson === null ||
        actualEnabledRolesJson === null ||
        enabledRolesJson !== actualEnabledRolesJson,
      "enabled role list does not match role configurations",
    );
    pushIf(
      mismatches,
      bundleRolesJson === null ||
        expectedBundleRolesJson === null ||
        bundleRolesJson !== expectedBundleRolesJson,
      "bundle role list does not declare the single Open Loop / Proactive bundle",
    );
    pushIf(
      mismatches,
      deferredRolesJson === null ||
        expectedDeferredRolesJson === null ||
        deferredRolesJson !== expectedDeferredRolesJson,
      "deferred role list does not keep Bio closed",
    );
    pushIf(
      mismatches,
      roles.configurationFingerprint !== safeSha256Hex(configurations),
      "role configuration fingerprint does not match its pins",
    );
    pushIf(
      mismatches,
      enabledRoles.some((role) => isDeferredRole(role)),
      "a deferred role is enabled in the G2 manifest",
    );
    pushIf(
      mismatches,
      !enabledRoles.every((role) => isG2Role(role)),
      "a non-G2 role is enabled in the G2 manifest",
    );
    const bundlePresent = ONE_A_3B_G2_BUNDLE_ROLES.filter((role) =>
      enabledRoles.includes(role),
    );
    pushIf(
      mismatches,
      bundlePresent.length === 1,
      "the Open Loop / Proactive bundle is split in the G2 manifest",
    );
  }

  const fixture = isRecord(value.fixture) ? value.fixture : null;
  if (!fixture) {
    mismatches.push("fixture section is missing");
  } else {
    pushIf(mismatches, typeof fixture.f3ManifestPath !== "string" || fixture.f3ManifestPath.trim() === "", "F3 manifest path is missing");
    pushIf(mismatches, typeof fixture.f3ManifestSha256 !== "string" || !SHA256_PATTERN.test(fixture.f3ManifestSha256), "F3 manifest hash is invalid");
    pushIf(mismatches, typeof fixture.f3ManifestFingerprint !== "string" || !FINGERPRINT_PATTERN.test(fixture.f3ManifestFingerprint), "F3 manifest fingerprint is invalid");
    pushIf(mismatches, typeof fixture.fixtureSeed !== "number" || !Number.isSafeInteger(fixture.fixtureSeed) || fixture.fixtureSeed < 0, "fixture seed is invalid");
    pushIf(mismatches, typeof fixture.sampleSeed !== "number" || !Number.isSafeInteger(fixture.sampleSeed) || fixture.sampleSeed < 0, "sample seed is invalid");
    pushIf(
      mismatches,
      fixture.fingerprint !== safeSha256Hex({
        f3ManifestPath: fixture.f3ManifestPath,
        f3ManifestSha256: fixture.f3ManifestSha256,
        f3ManifestFingerprint: fixture.f3ManifestFingerprint,
        fixtureSeed: fixture.fixtureSeed,
        sampleSeed: fixture.sampleSeed,
      }),
      "fixture fingerprint does not match its pins",
    );
  }

  const continuationCalibration = isRecord(value.continuationCalibration)
    ? value.continuationCalibration
    : null;
  let continuationStatus: OneA3bG2EvidenceStatus = "blocked";
  let continuationTotalCases = 0;
  let continuationEnglishCases = 0;
  let continuationChineseCases = 0;
  let continuationCodeSwitchCases = 0;
  let continuationNetPreference = 0;
  let continuationLocaleRegressions = -1;
  let continuationProtectedCategoryRegressions = -1;
  if (!continuationCalibration) {
    mismatches.push("continuation calibration section is missing");
  } else {
    pushIf(
      mismatches,
      typeof continuationCalibration.ledgerPath !== "string" ||
        continuationCalibration.ledgerPath.trim() === "",
      "continuation calibration ledger path is missing",
    );
    pushIf(
      mismatches,
      typeof continuationCalibration.ledgerSha256 !== "string" ||
        !SHA256_PATTERN.test(continuationCalibration.ledgerSha256),
      "continuation calibration ledger hash is invalid",
    );
    pushIf(
      mismatches,
      continuationCalibration.ledgerVersion !==
        ONE_A_3B_G2_CONTINUATION_LEDGER_VERSION,
      "continuation calibration ledger version is not the released version",
    );
    const frozenF3Fingerprint =
      fixture && typeof fixture.f3ManifestFingerprint === "string"
        ? fixture.f3ManifestFingerprint
        : null;
    pushIf(
      mismatches,
      typeof continuationCalibration.f3ManifestFingerprint !== "string" ||
        !FINGERPRINT_PATTERN.test(continuationCalibration.f3ManifestFingerprint) ||
        continuationCalibration.f3ManifestFingerprint !== frozenF3Fingerprint,
      "continuation calibration does not belong to the frozen F3 manifest",
    );
    continuationTotalCases =
      typeof continuationCalibration.totalCases === "number"
        ? continuationCalibration.totalCases
        : 0;
    continuationEnglishCases =
      typeof continuationCalibration.englishCases === "number"
        ? continuationCalibration.englishCases
        : 0;
    continuationChineseCases =
      typeof continuationCalibration.chineseCases === "number"
        ? continuationCalibration.chineseCases
        : 0;
    continuationCodeSwitchCases =
      typeof continuationCalibration.codeSwitchCases === "number"
        ? continuationCalibration.codeSwitchCases
        : 0;
    continuationNetPreference =
      typeof continuationCalibration.netPreference === "number"
        ? continuationCalibration.netPreference
        : 0;
    continuationLocaleRegressions =
      typeof continuationCalibration.localeRegressions === "number"
        ? continuationCalibration.localeRegressions
        : -1;
    continuationProtectedCategoryRegressions =
      typeof continuationCalibration.protectedCategoryRegressions === "number"
        ? continuationCalibration.protectedCategoryRegressions
        : -1;
    pushIf(
      mismatches,
      continuationTotalCases !== 15,
      "continuation calibration must contain exactly 15 cases",
    );
    pushIf(
      mismatches,
      continuationEnglishCases !== 8,
      "continuation calibration must contain exactly 8 English cases",
    );
    pushIf(
      mismatches,
      continuationChineseCases !== 5,
      "continuation calibration must contain exactly 5 Chinese cases",
    );
    pushIf(
      mismatches,
      continuationCodeSwitchCases !== 2,
      "continuation calibration must contain exactly 2 code-switch cases",
    );
    pushIf(
      mismatches,
      !Number.isSafeInteger(continuationNetPreference) ||
        continuationNetPreference < 0,
      "continuation calibration net preference is invalid",
    );
    pushIf(
      mismatches,
      !Number.isSafeInteger(continuationLocaleRegressions) ||
        continuationLocaleRegressions < 0,
      "continuation calibration locale regression count is invalid",
    );
    pushIf(
      mismatches,
      !Number.isSafeInteger(continuationProtectedCategoryRegressions) ||
        continuationProtectedCategoryRegressions < 0,
      "continuation calibration protected-category regression count is invalid",
    );
    pushIf(
      mismatches,
      continuationCalibration.humanOwner !== "Luke",
      "continuation calibration human owner is not Luke",
    );
    const status = continuationCalibration.status;
    if (!isG2EvidenceStatus(status)) {
      mismatches.push("continuation calibration has an invalid status");
    } else {
      continuationStatus = status;
      pushIf(
        mismatches,
        status === "verified" &&
          !continuationPreferencePasses({
            netPreference: continuationNetPreference,
            localeRegressions: continuationLocaleRegressions,
            protectedCategoryRegressions:
              continuationProtectedCategoryRegressions,
          }),
        "continuation calibration cannot be verified without a strictly positive net preference and zero locale or protected-category regressions",
      );
      pushIf(
        mismatches,
        status !== "verified" &&
          (typeof continuationCalibration.note !== "string" ||
            continuationCalibration.note.trim() === ""),
        "incomplete continuation calibration has no note",
      );
    }
  }

  const commands = value.commands;
  pushIf(
    mismatches,
    !Array.isArray(commands) || commands.length === 0 || commands.some((command) => typeof command !== "string" || command.trim() === ""),
    "G2 manifest commands are missing",
  );
  const evidence = verifyEvidence(value.evidence, mismatches);
  const cutoverState = value.cutoverState;
  pushIf(
    mismatches,
    cutoverState !== "disabled" && cutoverState !== "active" && cutoverState !== "rolled_back",
    "G2 cutover state is invalid",
  );
  const expected = expectedStatus({
    cutoverState: cutoverState as OneA3bG2ReleaseManifest["cutoverState"],
    enabledRoles,
    evidence,
    continuationCalibration: {
      status: continuationStatus,
      totalCases: continuationTotalCases,
      englishCases: continuationEnglishCases,
      chineseCases: continuationChineseCases,
      codeSwitchCases: continuationCodeSwitchCases,
      netPreference: continuationNetPreference,
      localeRegressions: continuationLocaleRegressions,
      protectedCategoryRegressions: continuationProtectedCategoryRegressions,
    },
  });
  pushIf(mismatches, value.status !== expected, `G2 status must be ${expected}`);

  let expectedIdentity: string | null = null;
  try {
    expectedIdentity = buildG2ReleaseIdentityFingerprint({
      gitCommit: typeof value.gitCommit === "string" ? value.gitCommit : "",
      baseG1ReleaseFingerprint:
        typeof value.baseG1ReleaseFingerprint === "string"
          ? value.baseG1ReleaseFingerprint
          : "",
      migrations: migrations as readonly OneA3bG2MigrationPin[],
      purgeMarkerMigrations: purgeMarkerMigrations as readonly OneA3bG2MigrationPin[],
      roleConfigurations: configurations as readonly ModelRoleConfigurationSnapshot[],
      fixture: {
        f3ManifestSha256:
          isRecord(value.fixture) && typeof value.fixture.f3ManifestSha256 === "string"
            ? (value.fixture.f3ManifestSha256 as string)
            : "",
        f3ManifestFingerprint:
          isRecord(value.fixture) && typeof value.fixture.f3ManifestFingerprint === "string"
            ? (value.fixture.f3ManifestFingerprint as string)
            : "",
        fixtureSeed:
          isRecord(value.fixture) && typeof value.fixture.fixtureSeed === "number"
            ? (value.fixture.fixtureSeed as number)
            : -1,
        sampleSeed:
          isRecord(value.fixture) && typeof value.fixture.sampleSeed === "number"
            ? (value.fixture.sampleSeed as number)
            : -1,
      },
    });
  } catch {
    // Malformed identity inputs stay as a verification mismatch below.
  }
  pushIf(
    mismatches,
    typeof (value as Record<string, unknown>).releaseIdentityFingerprint !== "string" ||
      (value as Record<string, unknown>).releaseIdentityFingerprint !== expectedIdentity,
    "release identity fingerprint does not match its immutable inputs",
  );

  const { fingerprint: actualFingerprint, ...withoutFingerprint } = value as Record<string, unknown> & { fingerprint?: unknown };
  let expectedFingerprint: string | null = null;
  try {
    expectedFingerprint = manifestFingerprint(
      withoutFingerprint as Omit<OneA3bG2ReleaseManifest, "fingerprint">,
    );
  } catch {
    // Keep malformed untrusted JSON as a verification mismatch instead of
    // allowing a canonicalization exception to escape the verifier.
  }
  pushIf(
    mismatches,
    typeof actualFingerprint !== "string" ||
      actualFingerprint !== expectedFingerprint,
    "release manifest fingerprint does not match its content",
  );
  return { mismatches, passed: mismatches.length === 0 };
}
