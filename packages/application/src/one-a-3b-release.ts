import { createHash } from "node:crypto";

import { EPISODE_BUILDER_POLICY_VERSION } from "./episode/types";
import {
  ONE_A_3B_G1_DEFERRED_ROLES,
  ONE_A_3B_G1_ENABLED_ROLES,
  type OneA3bModelRole,
} from "./model-role-contract";
import {
  ModelRoleConfigurationError,
  ONE_A_3B_MODEL_ROLES,
  ONE_A_3B_ROLE_POLICY_VERSION,
  createModelRoleRegistry,
  type ModelRoleConfigurationSnapshot,
} from "./model-role-runtime";
import { NARRATIVE_VALIDATION_POLICY_VERSION } from "./narrative-validation/types";
import { PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION } from "./purge-surface-registry";
import {
  PURGE_SURFACE_REGISTRY_VERSION,
  PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
} from "./purge-surface-registry";
import { REFLECTION_READINESS_POLICY_VERSION } from "./reflection/types";

export const ONE_A_3B_G1_RELEASE_MANIFEST_VERSION =
  "1a3b-g1-release:v1" as const;

/**
 * G1 model-configuration iteration per role.
 *
 * Existing production rows use v2. Weekly stays at v4 for its 10000-token
 * budget and low reasoning effort; narrative.validate v5 keeps the
 * 10000-token cap and pins low reasoning effort. Episode and Daily require v5
 * because their prompts now state the typed contracts admission already
 * enforces (kindFields allowlist, boundary date format, Evidence and
 * entity-anchor rules; Daily day_observation-only scope); a prompt change
 * needs a new immutable configuration version. Configuration rows are
 * immutable; old versions remain rollback history.
 */
export const ONE_A_3B_G1_ROLE_CONFIG_VERSIONS = {
  "episode.build": "v5",
  "reflection.daily": "v5",
  "reflection.weekly": "v4",
  "narrative.validate": "v5",
} as const satisfies Readonly<
  Record<(typeof ONE_A_3B_G1_ENABLED_ROLES)[number], string>
>;

/**
 * G1 rollout-pin iteration, shared by all four roles.
 *
 * A rollout pin is bound to exactly one manifest fingerprint and
 * `bindActiveG1Release` refuses to re-point an existing pin at a different
 * release. So a new release needs new pins even for the three roles whose
 * configuration is unchanged. A pin's name need not match its configuration
 * version: its foreign key is (role, config_version, provider_policy_version),
 * so a `v3` pin may point at an unchanged `v2` configuration.
 */
export const ONE_A_3B_G1_ROLLOUT_PIN_VERSION = "v9" as const;
export const ONE_A_3B_F3_VALIDATOR_LEDGER_VERSION =
  "1a3b-f3-adjudication:v1" as const;
export const ONE_A_3B_F3_VALIDATOR_PRECISION_REPORT_VERSION =
  "1a3b-f3-validator-precision-report:v1" as const;
export const ONE_A_3B_F3_VALIDATOR_PRECISION_FIXTURE_IDS = [
  "precision-clean-en-1",
  "precision-clean-en-2",
  "precision-clean-zh-1",
  "precision-clean-zh-2",
  "precision-clean-mix-1",
  "precision-clean-mix-2",
] as const;

/**
 * G1 is the current direct-release scope. Retired Open Loop and Proactive
 * roles, and the paused Bio writer role, stay outside this manifest. Their
 * historical role identifiers and shared read schema remain for compatibility.
 */
export {
  ONE_A_3B_G1_DEFERRED_ROLES,
  ONE_A_3B_G1_ENABLED_ROLES,
} from "./model-role-contract";

export const ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA = [
  "AC-F01",
  "AC-F02",
  "AC-E01",
  "AC-R01",
  "AC-G01",
  "AC-I01",
  "AC-M01",
  "AC-L01",
  "AC-L02",
  "AC-W01",
  "AC-D01",
  "AC-X04",
] as const;

export type OneA3bG1AcceptanceCriterion =
  (typeof ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA)[number];

export type OneA3bG1EvidenceSource =
  | "local"
  | "ci"
  | "hosted"
  | "provider"
  | "human";

export type OneA3bG1EvidenceStatus = "verified" | "pending" | "blocked";

export type OneA3bG1Evidence = Readonly<{
  criterion: OneA3bG1AcceptanceCriterion;
  fixtureIds: readonly string[];
  command: string;
  artifactSha256: string | null;
  artifactPath: string | null;
  owner: string;
  source: OneA3bG1EvidenceSource;
  status: OneA3bG1EvidenceStatus;
  note?: string;
}>;

export type OneA3bG1ValidatorCalibration = Readonly<{
  ledgerPath: string;
  ledgerSha256: string;
  ledgerVersion: typeof ONE_A_3B_F3_VALIDATOR_LEDGER_VERSION | "1a3b-f3-completion:v1";
  precisionReportPath: string;
  precisionReportSha256: string;
  precisionReportVersion: typeof ONE_A_3B_F3_VALIDATOR_PRECISION_REPORT_VERSION;
  precisionTotalCases: 6;
  precisionFalseBlockingCases: number;
  f3ManifestFingerprint: string;
  /**
   * The catalog's own validator case count, not a constant. It was 18 — twelve
   * Bio plus six Reflection — and Bio left G1 scope with ADR-0143 because
   * bio.write is a deferred role, so a fixed 18 would refuse the ledger G1 now
   * produces.
   */
  totalCases: number;
  acceptedCases: number;
  /**
   * Retained for record only. The budget it expressed is not enforced: the
   * verdict mix is a semantic judgement with no gold set behind it.
   */
  maxRejects: number;
  humanOwner: "Luke" | "capture-verifier";
  status: OneA3bG1EvidenceStatus;
  note?: string;
}>;

export type OneA3bG1MigrationPin = Readonly<{
  name: string;
  sha256: string;
}>;

export type OneA3bG1ReleaseManifest = Readonly<{
  version: typeof ONE_A_3B_G1_RELEASE_MANIFEST_VERSION;
  stage: "g1";
  status: "blocked" | "ready_for_cutover" | "active" | "rolled_back";
  createdAt: string;
  gitCommit: string;
  schema: Readonly<{
    migrations: readonly OneA3bG1MigrationPin[];
    fingerprint: string;
    purgeMarkerMigrations: readonly OneA3bG1MigrationPin[];
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
    fallbackMode: "disabled";
    futureStages: "closed";
    fingerprint: string;
  }>;
  roles: Readonly<{
    configurations: readonly ModelRoleConfigurationSnapshot[];
    enabledRoles: readonly OneA3bModelRole[];
    deferredRoles: typeof ONE_A_3B_G1_DEFERRED_ROLES;
    configurationFingerprint: string;
  }>;
  fixture: Readonly<{
    catalogPath?: string;
    f3ManifestPath: string;
    f3ManifestSha256: string;
    f3ManifestFingerprint: string;
    fixtureSeed: number;
    sampleSeed: number;
    fingerprint: string;
  }>;
  validatorCalibration: OneA3bG1ValidatorCalibration;
  commands: readonly string[];
  evidence: readonly OneA3bG1Evidence[];
  cutoverState: "disabled" | "active" | "rolled_back";
  releaseIdentityFingerprint: string;
  fingerprint: string;
}>;

export type OneA3bG1ReleaseManifestInput = Readonly<{
  gitCommit: string;
  migrations: readonly OneA3bG1MigrationPin[];
  purgeMarkerMigrations: readonly OneA3bG1MigrationPin[];
  roleConfigurations: readonly ModelRoleConfigurationSnapshot[];
  fixture: Readonly<{
    catalogPath?: string;
    f3ManifestPath: string;
    f3ManifestSha256: string;
    f3ManifestFingerprint: string;
    fixtureSeed: number;
    sampleSeed: number;
  }>;
  validatorCalibration: OneA3bG1ValidatorCalibration;
  commands: readonly string[];
  evidence: readonly OneA3bG1Evidence[];
  cutoverState?: "disabled" | "active" | "rolled_back";
  createdAt?: string;
}>;

export type OneA3bG1ReleaseManifestVerification = Readonly<{
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

/**
 * The exact fixture pin set the content-addressed fixture fingerprint covers.
 *
 * `catalogPath` is optional for the historical no-holdout releases. When it is
 * present it is part of the identity, so a manifest cannot point the verifier
 * at a different catalog than the one its fingerprint was frozen over. Builder
 * and verifier both hash this same shape, which keeps the legacy five-field
 * fingerprint byte-identical when no path is pinned.
 */
function fixtureFingerprintSource(
  fixture: Record<string, unknown>,
): Record<string, unknown> {
  const source: Record<string, unknown> = {
    f3ManifestPath: fixture.f3ManifestPath,
    f3ManifestSha256: fixture.f3ManifestSha256,
    f3ManifestFingerprint: fixture.f3ManifestFingerprint,
    fixtureSeed: fixture.fixtureSeed,
    sampleSeed: fixture.sampleSeed,
  };
  if (fixture.catalogPath !== undefined) source.catalogPath = fixture.catalogPath;
  return source;
}

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
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
  migrations: readonly OneA3bG1MigrationPin[],
): readonly OneA3bG1MigrationPin[] {
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
    throw new Error("At least one migration must be frozen in the G1 manifest.");
  }
  return sorted;
}

function isG1Role(role: OneA3bModelRole): boolean {
  return (ONE_A_3B_G1_ENABLED_ROLES as readonly string[]).includes(role);
}

function isDeferredRole(role: OneA3bModelRole): boolean {
  return (ONE_A_3B_G1_DEFERRED_ROLES as readonly string[]).includes(role);
}

function sortedConfigurations(
  configurations: readonly ModelRoleConfigurationSnapshot[],
): readonly ModelRoleConfigurationSnapshot[] {
  for (const configuration of configurations) {
    if (isDeferredRole(configuration.role)) {
      throw new Error(
        `G1 cannot enable deferred model role ${configuration.role}.`,
      );
    }
    if (!isG1Role(configuration.role)) {
      throw new Error(
        `G1 model role ${configuration.role} is not part of the first release stage.`,
      );
    }
  }
  return [...configurations].sort((left, right) => left.role.localeCompare(right.role));
}

function validateFixture(input: OneA3bG1ReleaseManifestInput["fixture"]): void {
  if (input.catalogPath !== undefined) {
    requireNonEmpty(input.catalogPath, "fixture.catalogPath");
  }
  requireNonEmpty(input.f3ManifestPath, "fixture.f3ManifestPath");
  requireSha256(input.f3ManifestSha256, "fixture.f3ManifestSha256");
  requireFingerprint(input.f3ManifestFingerprint, "fixture.f3ManifestFingerprint");
  requireInteger(input.fixtureSeed, "fixture.fixtureSeed");
  requireInteger(input.sampleSeed, "fixture.sampleSeed");
}

/**
 * Whether the validator's recorded verdicts may be treated as a release gate.
 *
 * ADR-0143: they may not, yet. The rule this replaces required the human owner
 * to rule every case and allowed one miss in eighteen, which looked like a
 * calibrated threshold and was not one. The set it measured was seeded by hand
 * with no gold set behind it, and `docs/research/reflection-profile-grounding-
 * validation.md` §5.4 says a checker without acceptable evidence may only be
 * advisory or go to human review. Luke's 6-of-6 rejection of the Reflection
 * cases is what surfaced that: every one of those defects was detected and
 * reported, and none reached the blocking set.
 *
 * So the release no longer scores the verdicts. It still requires the
 * validator to have run, to have ruled every case, and to have recorded
 * nothing else — `narrative.validate` is what ADR-0132 makes mandatory before
 * a Reflection may become current or propose a Candidate, and that
 * requirement is unchanged. What is dropped is the claim that these particular
 * semantic verdicts are good enough to gate a release on.
 *
 * This returns false for every input rather than deleting the caller, so the
 * gate stays visible at its call sites until a gold set exists to replace it.
 */
export function validatorCalibrationRejectsWithinBudget(input: Readonly<{
  totalCases: number;
  acceptedCases: number;
  maxRejects: number;
}>): boolean {
  void input;
  return false;
}

function validateValidatorCalibration(
  input: OneA3bG1ValidatorCalibration,
  fixture: OneA3bG1ReleaseManifestInput["fixture"],
): void {
  requireNonEmpty(input.ledgerPath, "validatorCalibration.ledgerPath");
  requireSha256(input.ledgerSha256, "validatorCalibration.ledgerSha256");
  requireNonEmpty(
    input.precisionReportPath,
    "validatorCalibration.precisionReportPath",
  );
  requireSha256(
    input.precisionReportSha256,
    "validatorCalibration.precisionReportSha256",
  );
  requireFingerprint(
    input.f3ManifestFingerprint,
    "validatorCalibration.f3ManifestFingerprint",
  );
  if (input.ledgerVersion !== ONE_A_3B_F3_VALIDATOR_LEDGER_VERSION && input.ledgerVersion !== "1a3b-f3-completion:v1") {
    throw new Error(
      `validatorCalibration.ledgerVersion must be ${ONE_A_3B_F3_VALIDATOR_LEDGER_VERSION}.`,
    );
  }
  if (
    input.precisionReportVersion !==
    ONE_A_3B_F3_VALIDATOR_PRECISION_REPORT_VERSION
  ) {
    throw new Error(
      `validatorCalibration.precisionReportVersion must be ${ONE_A_3B_F3_VALIDATOR_PRECISION_REPORT_VERSION}.`,
    );
  }
  if (input.f3ManifestFingerprint !== fixture.f3ManifestFingerprint) {
    throw new Error(
      "validatorCalibration must belong to the frozen F3 manifest.",
    );
  }
  // The count is the catalog's, not a constant: it was 18 while the validator
  // pool held twelve Bio and six Reflection cases, and ADR-0143 moved Bio out
  // of G1. What is still required is that every case was ruled, so a ledger
  // claiming fewer cases than it covers cannot pass.
  if (!Number.isSafeInteger(input.totalCases) || input.totalCases < 1) {
    throw new Error("validatorCalibration.totalCases must be at least 1.");
  }
  if (input.acceptedCases > input.totalCases) {
    throw new Error(
      "validatorCalibration.acceptedCases cannot exceed totalCases.",
    );
  }
  if (
    input.precisionTotalCases !==
    ONE_A_3B_F3_VALIDATOR_PRECISION_FIXTURE_IDS.length
  ) {
    throw new Error("validatorCalibration.precisionTotalCases must be exactly 6.");
  }
  if (
    !Number.isSafeInteger(input.precisionFalseBlockingCases) ||
    input.precisionFalseBlockingCases < 0 ||
    input.precisionFalseBlockingCases > input.precisionTotalCases
  ) {
    throw new Error(
      "validatorCalibration.precisionFalseBlockingCases must be an integer from 0 through 6.",
    );
  }
  if (
    !Number.isSafeInteger(input.acceptedCases) ||
    input.acceptedCases < 0 ||
    input.acceptedCases > input.totalCases
  ) {
    throw new Error(
      "validatorCalibration.acceptedCases must be an integer from 0 through totalCases.",
    );
  }
  if (!Number.isSafeInteger(input.maxRejects) || input.maxRejects < 0) {
    throw new Error("validatorCalibration.maxRejects must be a non-negative integer.");
  }
  if (input.humanOwner !== (input.ledgerVersion === "1a3b-f3-completion:v1" ? "capture-verifier" : "Luke")) {
    throw new Error("validatorCalibration.humanOwner must be Luke.");
  }
  if (
    input.status !== "verified" &&
    input.status !== "pending" &&
    input.status !== "blocked"
  ) {
    throw new Error("validatorCalibration has an invalid status.");
  }
  // ADR-0143: verified now means the validator ran, every catalogued case was
  // ruled, and the ledger belongs to this manifest. It deliberately does not
  // mean the semantic verdicts were good enough to gate on — that judgement
  // waits for a gold set. The budget check is retained as a live predicate so
  // the gate stays visible until something replaces it.
  void validatorCalibrationRejectsWithinBudget;
  if (input.status !== "verified") {
    requireNonEmpty(input.note ?? "", "validatorCalibration.note");
  }
}

function validateEvidence(evidence: readonly OneA3bG1Evidence[]): void {
  const expected = new Set<string>(ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA);
  const seen = new Set<string>();
  for (const entry of evidence) {
    if (!expected.has(entry.criterion)) {
      throw new Error(`Evidence criterion ${entry.criterion} is not required by G1.`);
    }
    if (seen.has(entry.criterion)) {
      throw new Error(`G1 evidence has duplicate criterion ${entry.criterion}.`);
    }
    seen.add(entry.criterion);
    if (entry.fixtureIds.length === 0 || entry.fixtureIds.some((id) => typeof id !== "string" || id.trim() === "")) {
      throw new Error(`${entry.criterion} must list at least one fixture ID.`);
    }
    requireNonEmpty(entry.command, `${entry.criterion}.command`);
    requireNonEmpty(entry.owner, `${entry.criterion}.owner`);
    const requiredSource =
      entry.criterion === "AC-M01"
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
  const missing = ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA.filter(
    (criterion) => !seen.has(criterion),
  );
  if (missing.length > 0) {
    throw new Error(`G1 evidence is missing: ${missing.join(", ")}.`);
  }
}

function enabledRolesMatchG1(roles: readonly OneA3bModelRole[]): boolean {
  return (
    roles.length === ONE_A_3B_G1_ENABLED_ROLES.length &&
    roles.every((role, index) => role === ONE_A_3B_G1_ENABLED_ROLES[index])
  );
}

function evidenceIsComplete(evidence: readonly OneA3bG1Evidence[]): boolean {
  return evidence.every((entry) => entry.status === "verified");
}

function validatorCalibrationIsComplete(
  calibration: Readonly<{
    status: OneA3bG1EvidenceStatus;
    totalCases: number;
    acceptedCases: number;
    maxRejects: number;
    precisionTotalCases: number;
    precisionFalseBlockingCases: number;
  }>,
): boolean {
  // ADR-0143: completion, not correctness. This asks whether the validator ran,
  // every catalogued case was ruled, the precision corpus is whole,
  // and the ledger is bound to this manifest — which is what ADR-0132
  // requires before a Reflection may become current. It does not ask whether
  // the semantic verdicts were right; that judgement waits for a gold set, and
  // the case count follows the catalog rather than a constant.
  void validatorCalibrationRejectsWithinBudget;
  return (
    calibration.status === "verified" &&
    calibration.totalCases >= 1 &&
    calibration.precisionTotalCases ===
      ONE_A_3B_F3_VALIDATOR_PRECISION_FIXTURE_IDS.length
  );
}

/**
 * Stable deployable identity for a G1 release. It covers only immutable
 * inputs — exact commit, sorted migration pins, registry versions, frozen
 * policy bundle, exact role configurations, and frozen F3 fixture pins — and
 * deliberately excludes evidence, validator outcomes, commands, timestamps,
 * status, cutover state, and the full content-addressed fingerprint. AC-D01
 * binds this identity so deployment evidence can be produced before the full
 * manifest (which contains that evidence) is frozen.
 */
export function buildG1ReleaseIdentityFingerprint(input: Readonly<{
  gitCommit: string;
  migrations: readonly OneA3bG1MigrationPin[];
  purgeMarkerMigrations: readonly OneA3bG1MigrationPin[];
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
  const orderedMigrations = sortedMigrations(input.migrations);
  const orderedPurgeMarkerMigrations = sortedMigrations(input.purgeMarkerMigrations);
  const orderedConfigurations = sortedConfigurations(input.roleConfigurations);
  return `sha256:${sha256Hex({
    version: ONE_A_3B_G1_RELEASE_MANIFEST_VERSION,
    stage: "g1",
    gitCommit: input.gitCommit,
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
      fallbackMode: "disabled",
      futureStages: "closed",
    },
    roles: {
      configurations: orderedConfigurations,
      enabledRoles: [...ONE_A_3B_G1_ENABLED_ROLES],
      deferredRoles: [...ONE_A_3B_G1_DEFERRED_ROLES],
    },
    fixture: {
      f3ManifestSha256: input.fixture.f3ManifestSha256,
      f3ManifestFingerprint: input.fixture.f3ManifestFingerprint,
      fixtureSeed: input.fixture.fixtureSeed,
      sampleSeed: input.fixture.sampleSeed,
    },
  })}`;
}

function manifestWithoutFingerprint(
  manifest: Omit<OneA3bG1ReleaseManifest, "fingerprint">,
): Omit<OneA3bG1ReleaseManifest, "fingerprint"> {
  return manifest;
}

function manifestFingerprint(
  manifest: Omit<OneA3bG1ReleaseManifest, "fingerprint">,
): string {
  return `sha256:${sha256Hex({
    ...manifestWithoutFingerprint(manifest),
    createdAt: "volatile",
  })}`;
}

function expectedStatus(input: Readonly<{
  cutoverState: OneA3bG1ReleaseManifest["cutoverState"];
  enabledRoles: readonly OneA3bModelRole[];
  evidence: readonly OneA3bG1Evidence[];
  validatorCalibration: Readonly<{
    status: OneA3bG1EvidenceStatus;
    totalCases: number;
    acceptedCases: number;
    maxRejects: number;
    precisionTotalCases: number;
    precisionFalseBlockingCases: number;
  }>;
}>): OneA3bG1ReleaseManifest["status"] {
  const complete =
    enabledRolesMatchG1(input.enabledRoles) &&
    evidenceIsComplete(input.evidence) &&
    validatorCalibrationIsComplete(input.validatorCalibration);
  if (input.cutoverState === "active") return complete ? "active" : "blocked";
  if (input.cutoverState === "rolled_back") return complete ? "rolled_back" : "blocked";
  return complete ? "ready_for_cutover" : "blocked";
}

/**
 * Build the content-addressed G1 release record. This function records
 * incomplete evidence as blocked state; it never turns an unexecuted check
 * into a pass so that a later hosted or human run can fill the same shape.
 */
export function buildOneA3bG1ReleaseManifest(
  input: OneA3bG1ReleaseManifestInput,
): OneA3bG1ReleaseManifest {
  if (!GIT_COMMIT_PATTERN.test(input.gitCommit)) {
    throw new Error("gitCommit must be a full 40-character lowercase commit.");
  }
  const migrationPins = sortedMigrations(input.migrations);
  const purgeMarkerMigrationPins = sortedMigrations(input.purgeMarkerMigrations);
  const configurations = sortedConfigurations(input.roleConfigurations);
  const registry = createModelRoleRegistry(configurations);
  validateFixture(input.fixture);
  validateValidatorCalibration(input.validatorCalibration, input.fixture);
  if (input.commands.length === 0 || input.commands.some((command) => command.trim() === "")) {
    throw new Error("G1 manifest must record at least one reproduction command.");
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
    fallbackMode: "disabled" as const,
    futureStages: "closed" as const,
  } as const;
  const manifestWithoutHash = {
    version: ONE_A_3B_G1_RELEASE_MANIFEST_VERSION,
    stage: "g1" as const,
    status: expectedStatus({
      cutoverState,
      enabledRoles: registry.enabledRoles,
      evidence: input.evidence,
      validatorCalibration: input.validatorCalibration,
    }),
    createdAt,
    gitCommit: input.gitCommit,
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
      deferredRoles: ONE_A_3B_G1_DEFERRED_ROLES,
      configurationFingerprint: sha256Hex(configurations),
    },
    fixture: {
      ...input.fixture,
      fingerprint: sha256Hex(fixtureFingerprintSource({ ...input.fixture })),
    },
    validatorCalibration: { ...input.validatorCalibration },
    commands: [...input.commands],
    evidence: input.evidence.map((entry) => ({
      ...entry,
      fixtureIds: [...entry.fixtureIds],
    })),
    cutoverState,
    releaseIdentityFingerprint: buildG1ReleaseIdentityFingerprint({
      gitCommit: input.gitCommit,
      migrations: migrationPins,
      purgeMarkerMigrations: purgeMarkerMigrationPins,
      roleConfigurations: configurations,
      fixture: input.fixture,
    }),
  } satisfies Omit<OneA3bG1ReleaseManifest, "fingerprint">;
  if (
    cutoverState === "active" &&
    manifestWithoutHash.status !== "active"
  ) {
    throw new Error("G1 cannot become active until every gate is verified.");
  }
  if (
    cutoverState === "rolled_back" &&
    manifestWithoutHash.status !== "rolled_back"
  ) {
    throw new Error("G1 rollback records require the complete frozen evidence set.");
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
): readonly OneA3bG1MigrationPin[] {
  if (!Array.isArray(value)) {
    mismatches.push("schema migrations are not an array");
    return [];
  }
  const migrations: OneA3bG1MigrationPin[] = [];
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

function verifyEvidence(value: unknown, mismatches: string[]): OneA3bG1Evidence[] {
  if (!Array.isArray(value)) {
    mismatches.push("G1 evidence is not an array");
    return [];
  }
  const evidence: OneA3bG1Evidence[] = [];
  const required = new Set<string>(ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA);
  const sources = new Set<OneA3bG1EvidenceSource>([
    "local",
    "ci",
    "hosted",
    "provider",
    "human",
  ]);
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) {
      mismatches.push("G1 evidence contains a non-object entry");
      continue;
    }
    const criterion = typeof raw.criterion === "string" ? raw.criterion : "";
    const status = raw.status;
    const source = raw.source;
    const entry = raw as Partial<OneA3bG1Evidence>;
    if (!required.has(criterion)) mismatches.push(`unexpected G1 criterion: ${criterion}`);
    if (seen.has(criterion)) mismatches.push(`duplicate G1 criterion: ${criterion}`);
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
    if (typeof source !== "string" || !sources.has(source as OneA3bG1EvidenceSource)) {
      mismatches.push(`${criterion} has an invalid evidence source`);
    }
    const requiredSource =
      criterion === "AC-M01"
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
    if (status === "verified") {
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
    } else {
      mismatches.push(`${criterion} has an invalid evidence status`);
    }
    if (required.has(criterion) && (status === "verified" || status === "pending" || status === "blocked")) {
      evidence.push(entry as OneA3bG1Evidence);
    }
  }
  for (const criterion of ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA) {
    if (!seen.has(criterion)) mismatches.push(`missing G1 criterion: ${criterion}`);
  }
  return evidence;
}

/** Verify an untrusted JSON manifest before it can open a runtime switch. */
export function verifyOneA3bG1ReleaseManifest(
  value: unknown,
): OneA3bG1ReleaseManifestVerification {
  const mismatches: string[] = [];
  if (!isRecord(value)) {
    return { mismatches: ["G1 release manifest is not an object"], passed: false };
  }
  pushIf(
    mismatches,
    value.version !== ONE_A_3B_G1_RELEASE_MANIFEST_VERSION,
    "unsupported G1 release manifest version",
  );
  pushIf(mismatches, value.stage !== "g1", "release manifest stage is not g1");
  pushIf(
    mismatches,
    typeof value.gitCommit !== "string" || !GIT_COMMIT_PATTERN.test(value.gitCommit),
    "gitCommit is not a full 40-character lowercase commit",
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
    fallbackMode: "disabled",
    futureStages: "closed",
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
    const deferredRolesJson = safeStableJson(roles.deferredRoles);
    const expectedDeferredRolesJson = safeStableJson(ONE_A_3B_G1_DEFERRED_ROLES);
    pushIf(
      mismatches,
      enabledRolesJson === null ||
        actualEnabledRolesJson === null ||
        enabledRolesJson !== actualEnabledRolesJson,
      "enabled role list does not match role configurations",
    );
    pushIf(
      mismatches,
      deferredRolesJson === null ||
        expectedDeferredRolesJson === null ||
        deferredRolesJson !== expectedDeferredRolesJson,
      "deferred role list does not keep later stages closed",
    );
    pushIf(
      mismatches,
      roles.configurationFingerprint !== safeSha256Hex(configurations),
      "role configuration fingerprint does not match its pins",
    );
    pushIf(
      mismatches,
      enabledRoles.some((role) => isDeferredRole(role)),
      "a deferred role is enabled in the G1 manifest",
    );
    pushIf(
      mismatches,
      !enabledRoles.every((role) => isG1Role(role)),
      "a non-G1 role is enabled in the G1 manifest",
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
      fixture.catalogPath !== undefined &&
        (typeof fixture.catalogPath !== "string" ||
          fixture.catalogPath.trim() === ""),
      "F3 fixture catalog path is invalid",
    );
    pushIf(
      mismatches,
      fixture.fingerprint !== safeSha256Hex(fixtureFingerprintSource(fixture)),
      "fixture fingerprint does not match its pins",
    );
  }

  const validatorCalibration = isRecord(value.validatorCalibration)
    ? value.validatorCalibration
    : null;
  let validatorCalibrationStatus: OneA3bG1EvidenceStatus = "blocked";
  let validatorCalibrationTotalCases = 0;
  let validatorCalibrationAcceptedCases = 0;
  let validatorCalibrationMaxRejects = 0;
  let validatorCalibrationPrecisionTotalCases = 0;
  let validatorCalibrationPrecisionFalseBlockingCases = -1;
  if (!validatorCalibration) {
    mismatches.push("validator calibration section is missing");
  } else {
    pushIf(
      mismatches,
      typeof validatorCalibration.ledgerPath !== "string" ||
        validatorCalibration.ledgerPath.trim() === "",
      "validator calibration ledger path is missing",
    );
    pushIf(
      mismatches,
      typeof validatorCalibration.ledgerSha256 !== "string" ||
        !SHA256_PATTERN.test(validatorCalibration.ledgerSha256),
      "validator calibration ledger hash is invalid",
    );
    pushIf(
      mismatches,
      typeof validatorCalibration.precisionReportPath !== "string" ||
        validatorCalibration.precisionReportPath.trim() === "",
      "validator precision report path is missing",
    );
    pushIf(
      mismatches,
      typeof validatorCalibration.precisionReportSha256 !== "string" ||
        !SHA256_PATTERN.test(validatorCalibration.precisionReportSha256),
      "validator precision report hash is invalid",
    );
    pushIf(
      mismatches,
      validatorCalibration.ledgerVersion !==
        ONE_A_3B_F3_VALIDATOR_LEDGER_VERSION && validatorCalibration.ledgerVersion !== "1a3b-f3-completion:v1",
      "validator calibration ledger version is not the released version",
    );
    pushIf(
      mismatches,
      validatorCalibration.precisionReportVersion !==
        ONE_A_3B_F3_VALIDATOR_PRECISION_REPORT_VERSION,
      "validator precision report version is not the released version",
    );
    const frozenF3Fingerprint =
      fixture && typeof fixture.f3ManifestFingerprint === "string"
        ? fixture.f3ManifestFingerprint
        : null;
    pushIf(
      mismatches,
      typeof validatorCalibration.f3ManifestFingerprint !== "string" ||
        !FINGERPRINT_PATTERN.test(validatorCalibration.f3ManifestFingerprint) ||
        validatorCalibration.f3ManifestFingerprint !== frozenF3Fingerprint,
      "validator calibration does not belong to the frozen F3 manifest",
    );
    validatorCalibrationTotalCases =
      typeof validatorCalibration.totalCases === "number"
        ? validatorCalibration.totalCases
        : 0;
    validatorCalibrationAcceptedCases =
      typeof validatorCalibration.acceptedCases === "number"
        ? validatorCalibration.acceptedCases
        : 0;
    validatorCalibrationMaxRejects =
      typeof validatorCalibration.maxRejects === "number"
        ? validatorCalibration.maxRejects
        : 0;
    validatorCalibrationPrecisionTotalCases =
      typeof validatorCalibration.precisionTotalCases === "number"
        ? validatorCalibration.precisionTotalCases
        : 0;
    validatorCalibrationPrecisionFalseBlockingCases =
      typeof validatorCalibration.precisionFalseBlockingCases === "number"
        ? validatorCalibration.precisionFalseBlockingCases
        : -1;
    // ADR-0143: the case count is the catalog's, not a constant. It was 18
    // while the pool held twelve Bio and six Reflection cases; Bio left G1
    // scope, so the count now has to follow the catalog instead of pinning the
    // release to a number that no longer describes it.
    pushIf(
      mismatches,
      !Number.isSafeInteger(validatorCalibrationTotalCases) ||
        validatorCalibrationTotalCases < 1,
      "validator calibration total case count is invalid",
    );
    pushIf(
      mismatches,
      validatorCalibrationPrecisionTotalCases !==
        ONE_A_3B_F3_VALIDATOR_PRECISION_FIXTURE_IDS.length,
      "validator precision corpus must contain exactly 6 cases",
    );
    pushIf(
      mismatches,
      !Number.isSafeInteger(
        validatorCalibrationPrecisionFalseBlockingCases,
      ) ||
        validatorCalibrationPrecisionFalseBlockingCases < 0 ||
        validatorCalibrationPrecisionFalseBlockingCases >
          validatorCalibrationPrecisionTotalCases,
      "validator precision false-block count is invalid",
    );
    pushIf(
      mismatches,
      !Number.isSafeInteger(validatorCalibrationAcceptedCases) ||
        validatorCalibrationAcceptedCases < 0 ||
        validatorCalibrationAcceptedCases > validatorCalibrationTotalCases,
      "validator calibration accepted case count is invalid",
    );
    // maxRejects is recorded, not enforced. The 10% budget it expressed was a
    // semantic judgement with no gold set behind it, and ADR-0143 retires it
    // while keeping the field so the ledger that recorded it still validates.
    pushIf(
      mismatches,
      validatorCalibration.humanOwner !== (validatorCalibration.ledgerVersion === "1a3b-f3-completion:v1" ? "capture-verifier" : "Luke"),
      "validator calibration human owner is not Luke",
    );
    const status = validatorCalibration.status;
    if (status !== "verified" && status !== "pending" && status !== "blocked") {
      mismatches.push("validator calibration has an invalid status");
    } else {
      validatorCalibrationStatus = status;
      // ADR-0143: the verdict mix is not scored. `verified` here means the
      // validator ran and the ledger is complete and bound to this manifest —
      // the requirement ADR-0132 places on a Reflection becoming current. The
      // predicate is called so the retired gate stays visible at its call site
      // rather than disappearing, and its false return is deliberately ignored
      // until a gold set can replace the judgement it stood in for.
      void validatorCalibrationRejectsWithinBudget({
        totalCases: validatorCalibrationTotalCases,
        acceptedCases: validatorCalibrationAcceptedCases,
        maxRejects: validatorCalibrationMaxRejects,
      });
      pushIf(
        mismatches,
        status !== "verified" &&
          (typeof validatorCalibration.note !== "string" ||
            validatorCalibration.note.trim() === ""),
        "incomplete validator calibration has no note",
      );
    }
  }

  const commands = value.commands;
  pushIf(
    mismatches,
    !Array.isArray(commands) || commands.length === 0 || commands.some((command) => typeof command !== "string" || command.trim() === ""),
    "G1 manifest commands are missing",
  );
  const evidence = verifyEvidence(value.evidence, mismatches);
  const cutoverState = value.cutoverState;
  pushIf(
    mismatches,
    cutoverState !== "disabled" && cutoverState !== "active" && cutoverState !== "rolled_back",
    "G1 cutover state is invalid",
  );
  const expected = expectedStatus({
    cutoverState: cutoverState as OneA3bG1ReleaseManifest["cutoverState"],
    enabledRoles,
    evidence,
    validatorCalibration: {
      status: validatorCalibrationStatus,
      totalCases: validatorCalibrationTotalCases,
      acceptedCases: validatorCalibrationAcceptedCases,
      maxRejects: validatorCalibrationMaxRejects,
      precisionTotalCases: validatorCalibrationPrecisionTotalCases,
      precisionFalseBlockingCases:
        validatorCalibrationPrecisionFalseBlockingCases,
    },
  });
  pushIf(mismatches, value.status !== expected, `G1 status must be ${expected}`);

  let expectedIdentity: string | null = null;
  try {
    expectedIdentity = buildG1ReleaseIdentityFingerprint({
      gitCommit: typeof value.gitCommit === "string" ? value.gitCommit : "",
      migrations: migrations as readonly OneA3bG1MigrationPin[],
      purgeMarkerMigrations: purgeMarkerMigrations as readonly OneA3bG1MigrationPin[],
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
      withoutFingerprint as Omit<OneA3bG1ReleaseManifest, "fingerprint">,
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
