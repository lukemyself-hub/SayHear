import { createHash } from "node:crypto";

import {
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA,
  type OneA3bG1AcceptanceCriterion,
  type OneA3bG1Evidence,
} from "./one-a-3b-release";
import type { ModelRoleConfigurationSnapshot } from "./model-role-runtime";

type JsonObject = Record<string, unknown>;

const F3_MANIFEST_VERSION = "1a3b-f3-manifest:v1";
const F3_PINS_VERSION = "1a3b-f3-pins:v2";
const F3_CATALOG_VERSION = "1a3b-f3-fixtures:v1";
/**
 * The #252 acceptance holdout. A separately authored catalog, so it carries its
 * own version and can never be confused with the spent one in release
 * evidence. The two are deliberately different strings rather than one version
 * with a different content hash.
 */
const F3_HOLDOUT_CATALOG_VERSION = "1a3b-f3-holdout-fixtures:v1";
const F3_CATALOG_VERSIONS: readonly string[] = [
  F3_CATALOG_VERSION,
  F3_HOLDOUT_CATALOG_VERSION,
];
const F3_LEDGER_VERSION = "1a3b-f3-adjudication:v1";
const F3_ROLES = [
  "episode.build",
  "open_loop.extract",
  "reflection.daily",
  "reflection.weekly",
  "bio.write",
  "narrative.validate",
  "proactive.followup",
] as const;
const F3_LANGUAGE_VARIANTS = ["en", "zh", "code_switch"] as const;
const F3_VALIDATOR_ERROR_CLASSES = [
  "unsupported",
  "contradiction",
  "epistemic_upgrade",
  "material_absence",
  "manifest_mismatch",
  "ambiguity",
] as const;
const F3_VALIDATOR_ARTIFACT_KINDS = ["bio", "reflection"] as const;
const F3_CONTINUATION_PROTECTED_CATEGORIES = [
  "high_risk",
  "refusal",
  "short_answers",
  "topic_change",
  "direct_task",
] as const;
const F3_CONTINUATION_SAMPLE_QUOTAS = {
  code_switch: 2,
  en: 8,
  zh: 5,
} as const;
const F3_BIO_SAMPLE_QUOTAS = {
  code_switch: 5,
  en: 5,
  zh: 5,
} as const;
const F3_VALIDATOR_QUOTAS = {
  code_switch: 6,
  en: 6,
  zh: 6,
} as const;
const F3_CONTINUATION_FORCED_COVERAGE = [
  "open_loop_question",
  "memory_acknowledgment",
  "greeting_or_pause",
  "direct_task",
  "high_risk",
  "sensitive_target",
  "stop_signal",
  "incomplete_lane",
  "surveillance",
  "repetition_boundary",
] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

type EvidenceResultFieldKind =
  | "non-empty-string"
  | "sha256-hex"
  | "manifest-fingerprint"
  | "git-commit"
  | "non-empty-string-array"
  | "non-empty-number-array"
  | "non-empty-array"
  | "non-empty-object-array"
  | "object"
  | "content-addressed-artifact"
  | "raw-alert-check"
  | "true"
  | "zero";

type OneA3bG1EvidenceContract = Readonly<{
  evidenceKind: string;
  requiredAssertionIds: readonly string[];
  requiredResultKeys: readonly string[];
  resultFieldKinds: Readonly<Record<string, EvidenceResultFieldKind>>;
}>;

export const ONE_A_3B_G1_EVIDENCE_CONTRACTS: Readonly<
  Record<OneA3bG1AcceptanceCriterion, OneA3bG1EvidenceContract>
> = {
  "AC-F01": {
    evidenceKind: "durable-workflow-ledger",
    requiredAssertionIds: ["workflow_receipt", "outbox_receipt", "attempt_fence"],
    requiredResultKeys: ["workflowReceiptIds", "outboxEventIds", "attemptIds"],
    resultFieldKinds: {
      workflowReceiptIds: "non-empty-string-array",
      outboxEventIds: "non-empty-string-array",
      attemptIds: "non-empty-string-array",
    },
  },
  "AC-F02": {
    evidenceKind: "recovery-reapply-ledger",
    requiredAssertionIds: ["recovery_reapply", "epoch_fence", "purge_marker"],
    requiredResultKeys: ["purgeOrderIds", "recoveryFenceChecks", "markerReceiptIds"],
    resultFieldKinds: {
      purgeOrderIds: "non-empty-string-array",
      recoveryFenceChecks: "non-empty-array",
      markerReceiptIds: "non-empty-string-array",
    },
  },
  "AC-E01": {
    evidenceKind: "episode-lineage-ledger",
    requiredAssertionIds: ["episode_proposals", "episode_commit_fence", "episode_lineage"],
    requiredResultKeys: ["episodeIds", "sourceRevisions", "candidateIds"],
    resultFieldKinds: {
      episodeIds: "non-empty-string-array",
      sourceRevisions: "non-empty-number-array",
      candidateIds: "non-empty-string-array",
    },
  },
  "AC-R01": {
    evidenceKind: "reflection-lineage-ledger",
    requiredAssertionIds: ["reflection_validation", "reflection_current_cas", "candidate_fence"],
    requiredResultKeys: ["reflectionIds", "validationIds", "candidateIds"],
    resultFieldKinds: {
      reflectionIds: "non-empty-string-array",
      validationIds: "non-empty-string-array",
      candidateIds: "non-empty-string-array",
    },
  },
  "AC-G01": {
    evidenceKind: "governance-disposition-ledger",
    requiredAssertionIds: ["governance_registry", "candidate_disposition", "predicate_release"],
    requiredResultKeys: ["registryReleaseIds", "candidateDispositions", "predicateReleaseIds"],
    resultFieldKinds: {
      registryReleaseIds: "non-empty-string-array",
      candidateDispositions: "non-empty-object-array",
      predicateReleaseIds: "non-empty-string-array",
    },
  },
  "AC-I01": {
    evidenceKind: "inspector-access-ledger",
    requiredAssertionIds: ["inspector_access", "evidence_expand_step_up", "access_audit"],
    requiredResultKeys: ["accessAuditIds", "stepUpAudit", "redactionSummary"],
    resultFieldKinds: {
      accessAuditIds: "non-empty-string-array",
      stepUpAudit: "object",
      redactionSummary: "object",
    },
  },
  "AC-M01": {
    evidenceKind: "provider-identity-ledger",
    requiredAssertionIds: ["provider_identity", "model_snapshot", "parameter_pin"],
    requiredResultKeys: ["providerCalls", "modelSnapshots", "parameterSnapshots"],
    resultFieldKinds: {
      providerCalls: "non-empty-object-array",
      modelSnapshots: "non-empty-object-array",
      parameterSnapshots: "non-empty-object-array",
    },
  },
  "AC-L01": {
    evidenceKind: "full-purge-ledger",
    requiredAssertionIds: ["purge_surface_registry", "private_diagnostics", "full_purge"],
    requiredResultKeys: ["purgeSurfaceRegistryVersion", "privateDiagnosticSurfaces", "purgeResult"],
    resultFieldKinds: {
      purgeSurfaceRegistryVersion: "non-empty-string",
      privateDiagnosticSurfaces: "non-empty-array",
      purgeResult: "object",
    },
  },
  "AC-L02": {
    evidenceKind: "inflight-purge-order-ledger",
    requiredAssertionIds: ["inflight_before_purge", "inflight_after_purge", "recovery_gate"],
    requiredResultKeys: [
      "purgeSurfaceRegistryVersion",
      "seededCanaryEvidence",
      "snapshotPredatesPurge",
      "restoreDrill",
      "inflightOrders",
      "recoveryGateEvidence",
    ],
    resultFieldKinds: {
      purgeSurfaceRegistryVersion: "non-empty-string",
      seededCanaryEvidence: "object",
      snapshotPredatesPurge: "true",
      restoreDrill: "object",
      inflightOrders: "non-empty-array",
      recoveryGateEvidence: "object",
    },
  },
  "AC-W01": {
    evidenceKind: "hosted-canary-ledger",
    requiredAssertionIds: ["hosted_canary", "workflow_history", "outbox_receipt"],
    requiredResultKeys: ["hosted", "canaryRunId", "deploymentId", "exportArtifact"],
    resultFieldKinds: {
      hosted: "true",
      canaryRunId: "non-empty-string",
      deploymentId: "non-empty-string",
      exportArtifact: "content-addressed-artifact",
    },
  },
  "AC-D01": {
    evidenceKind: "deployment-release-ledger",
    requiredAssertionIds: ["deployment_commit", "migration_fingerprint", "runtime_switch"],
    requiredResultKeys: ["deploymentId", "deploymentCommit", "schemaFingerprint", "releaseIdentityFingerprint"],
    resultFieldKinds: {
      deploymentId: "non-empty-string",
      deploymentCommit: "git-commit",
      schemaFingerprint: "sha256-hex",
      releaseIdentityFingerprint: "manifest-fingerprint",
    },
  },
  "AC-X04": {
    evidenceKind: "deterministic-hard-gate-ledger",
    requiredAssertionIds: ["raw_failure_artifact", "deterministic_zero_failures", "automated_alerts"],
    requiredResultKeys: ["confirmedHardFailures", "rawArtifactHash", "automatedAlertCheck"],
    resultFieldKinds: {
      confirmedHardFailures: "zero",
      rawArtifactHash: "sha256-hex",
      automatedAlertCheck: "raw-alert-check",
    },
  },
};

export type OneA3bG1EvidenceArtifactResult = Readonly<{
  passed: true;
  criterion: OneA3bG1AcceptanceCriterion;
  evidenceKind: string;
  assertionIds: readonly string[];
  fixtureIds: readonly string[];
  gitCommit: string;
  f3ManifestFingerprint: string;
  fixtureCatalogSha256: string;
  runId: string;
  command: string;
  [key: string]: unknown;
}>;

export type OneA3bG1EvidenceArtifact = Readonly<{
  version: "1a3b-g1-evidence:v1";
  criterion: OneA3bG1AcceptanceCriterion;
  gitCommit: string;
  f3ManifestFingerprint: string;
  fixtureCatalogSha256: string;
  fixtureIds: readonly string[];
  command: string;
  runId: string;
  status: "passed";
  result: OneA3bG1EvidenceArtifactResult;
}>;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function evidenceResultFieldMatches(
  value: unknown,
  kind: EvidenceResultFieldKind,
): boolean {
  switch (kind) {
    case "non-empty-string":
      return nonEmpty(value);
    case "sha256-hex":
      return typeof value === "string" && SHA256_PATTERN.test(value);
    case "manifest-fingerprint":
      return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
    case "git-commit":
      return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
    case "non-empty-string-array":
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((entry) => nonEmpty(entry))
      );
    case "non-empty-number-array":
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(
          (entry) => typeof entry === "number" && Number.isFinite(entry),
        )
      );
    case "non-empty-array":
      return Array.isArray(value) && value.length > 0;
    case "non-empty-object-array":
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((entry) => isRecord(entry))
      );
    case "object":
      return isRecord(value) && Object.keys(value).length > 0;
    case "content-addressed-artifact": {
      if (!isRecord(value) || !nonEmpty(value.path)) return false;
      const hash = value.sha256 ?? value.artifactSha256;
      return typeof hash === "string" && SHA256_PATTERN.test(hash);
    }
    case "raw-alert-check":
      return (
        isRecord(value) &&
        value.source === "raw-artifact" &&
        value.confirmedHardFailures === 0
      );
    case "true":
      return value === true;
    case "zero":
      return value === 0;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("non-JSON value");
}

function sha256Fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function safeSha256Fingerprint(value: unknown): string | null {
  try {
    return sha256Fingerprint(value);
  } catch {
    return null;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

type F3LanguageVariant = (typeof F3_LANGUAGE_VARIANTS)[number];
type F3SampleCandidate = Readonly<{
  category: string;
  coverageTags: readonly string[];
  id: string;
  languageVariant: F3LanguageVariant;
}>;

function emptyLanguageCounts(): Record<F3LanguageVariant, number> {
  return { code_switch: 0, en: 0, zh: 0 };
}

function shuffledF3<T>(values: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return values
    .map((value, index) => ({ index, key: random(), value }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map(({ value }) => value);
}

type F3ForcedRequirement =
  | { kind: "category"; key: (typeof F3_CONTINUATION_PROTECTED_CATEGORIES)[number] }
  | { kind: "tag"; key: (typeof F3_CONTINUATION_FORCED_COVERAGE)[number] };

function expectedContinuationSample(
  candidates: readonly F3SampleCandidate[],
  sampleSeed: number,
): Readonly<{
  eligibleCounts: Record<F3LanguageVariant, number>;
  forcedCoverage: Record<string, string>;
  protectedCoverage: Record<string, string>;
  scenarioIds: readonly string[];
  selectedCounts: Record<F3LanguageVariant, number>;
}> {
  const eligibleCounts = emptyLanguageCounts();
  for (const candidate of candidates) {
    eligibleCounts[candidate.languageVariant] += 1;
  }
  const ordered = shuffledF3(candidates, sampleSeed);
  const selected: F3SampleCandidate[] = [];
  const selectedIds = new Set<string>();
  const selectedCounts = emptyLanguageCounts();
  const hasRoom = (candidate: F3SampleCandidate): boolean =>
    selectedCounts[candidate.languageVariant] <
    F3_CONTINUATION_SAMPLE_QUOTAS[candidate.languageVariant];
  const add = (candidate: F3SampleCandidate): void => {
    selected.push(candidate);
    selectedIds.add(candidate.id);
    selectedCounts[candidate.languageVariant] += 1;
  };
  const requirements: readonly F3ForcedRequirement[] = [
    ...F3_CONTINUATION_FORCED_COVERAGE.map((key) => ({
      kind: "tag" as const,
      key,
    })),
    ...F3_CONTINUATION_PROTECTED_CATEGORIES.map((key) => ({
      kind: "category" as const,
      key,
    })),
  ];
  const satisfies = (
    candidate: F3SampleCandidate,
    requirement: F3ForcedRequirement,
  ): boolean =>
    requirement.kind === "tag"
      ? candidate.coverageTags.includes(requirement.key)
      : candidate.category === requirement.key;
  const covers = (requirement: F3ForcedRequirement): boolean =>
    selected.some((candidate) => satisfies(candidate, requirement));
  const uniquelyCovers = (
    candidate: F3SampleCandidate,
    requirement: F3ForcedRequirement,
  ): boolean =>
    satisfies(candidate, requirement) &&
    selected.filter((entry) => satisfies(entry, requirement)).length === 1;

  for (const requirement of requirements) {
    if (covers(requirement)) continue;
    const available = ordered.filter(
      (candidate) =>
        !selectedIds.has(candidate.id) && satisfies(candidate, requirement),
    );
    const direct = available.find(hasRoom);
    if (direct) {
      add(direct);
      continue;
    }
    let swapped = false;
    for (const candidate of available) {
      const victimIndex = selected.findIndex(
        (victim) =>
          victim.languageVariant === candidate.languageVariant &&
          !requirements.some((coveredRequirement) =>
            uniquelyCovers(victim, coveredRequirement),
          ),
      );
      if (victimIndex < 0) continue;
      const [victim] = selected.splice(victimIndex, 1);
      if (!victim) continue;
      selectedIds.delete(victim.id);
      add(candidate);
      swapped = true;
      break;
    }
    if (!swapped) {
      throw new Error(`cannot satisfy F3 coverage ${requirement.key}`);
    }
  }
  for (const candidate of ordered) {
    if (selected.length >= 15) break;
    if (!selectedIds.has(candidate.id) && hasRoom(candidate)) add(candidate);
  }
  if (selected.length !== 15) {
    throw new Error("F3 continuation sample cannot satisfy its fixed quotas");
  }
  const forcedCoverage: Record<string, string> = {};
  for (const tag of F3_CONTINUATION_FORCED_COVERAGE) {
    const bearer = selected.find((candidate) =>
      candidate.coverageTags.includes(tag),
    );
    if (!bearer) throw new Error(`F3 coverage ${tag} was lost`);
    forcedCoverage[tag] = bearer.id;
  }
  const protectedCoverage: Record<string, string> = {};
  for (const category of F3_CONTINUATION_PROTECTED_CATEGORIES) {
    const bearer = selected.find((candidate) => candidate.category === category);
    if (!bearer) throw new Error(`F3 category ${category} was lost`);
    protectedCoverage[category] = bearer.id;
  }
  return {
    eligibleCounts,
    forcedCoverage,
    protectedCoverage,
    scenarioIds: ordered
      .filter((candidate) => selectedIds.has(candidate.id))
      .map((candidate) => candidate.id),
    selectedCounts,
  };
}

function expectedFixedLanguageSample(
  candidates: readonly F3SampleCandidate[],
  sampleSeed: number,
): readonly string[] {
  const selectedCounts = emptyLanguageCounts();
  const selected: string[] = [];
  for (const candidate of shuffledF3(candidates, sampleSeed)) {
    if (
      selectedCounts[candidate.languageVariant] >=
      F3_BIO_SAMPLE_QUOTAS[candidate.languageVariant]
    ) {
      continue;
    }
    selected.push(candidate.id);
    selectedCounts[candidate.languageVariant] += 1;
  }
  return selected;
}

function noProductionSource(
  value: unknown,
  path: string,
  mismatches: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      noProductionSource(entry, `${path}[${index}]`, mismatches),
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
      mismatches.push(`${path}.${key} is not allowed in a synthetic artifact`);
    }
    noProductionSource(entry, `${path}.${key}`, mismatches);
  }
}

function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
  mismatches: string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    mismatches.push(`${label} must contain exactly ${expected.join(", ")}`);
  }
}

function verifyF3RolePin(
  value: unknown,
  role: string,
  mismatches: string[],
): void {
  if (!isRecord(value)) {
    mismatches.push(`${role} F3 pin must be an object`);
    return;
  }
  for (const field of [
    "provider",
    "model",
    "snapshot",
    "promptVersion",
    "schemaVersion",
    "policyVersion",
  ]) {
    if (!nonEmpty(value[field])) mismatches.push(`${role} F3 pin is missing ${field}`);
  }
  if (!["deepseek", "openai", "deterministic"].includes(String(value.provider))) {
    mismatches.push(`${role} F3 pin has an unsupported provider`);
  }
  if (!isRecord(value.parameters)) {
    mismatches.push(`${role} F3 pin parameters must be an object`);
  }
  if (value.fallback !== "none") mismatches.push(`${role} F3 pin fallback must be none`);
  if (value.maxTechnicalRetries !== 0 && value.maxTechnicalRetries !== 1) {
    mismatches.push(`${role} F3 pin retry count must be 0 or 1`);
  }
}

function verifyF3Pins(value: unknown, mismatches: string[]): void {
  if (!isRecord(value)) {
    mismatches.push("F3 pinnedConfiguration must be an object");
    return;
  }
  if (value.version !== F3_PINS_VERSION) mismatches.push("unsupported F3 pins version");
  if (value.syntheticOnly !== true) mismatches.push("F3 pins must be synthetic-only");
  if (!isRecord(value.roles)) {
    mismatches.push("F3 pins.roles must be an object");
  } else {
    exactKeys(value.roles, F3_ROLES, "F3 pins.roles", mismatches);
    for (const role of F3_ROLES) verifyF3RolePin(value.roles[role], role, mismatches);
  }
  if (!isRecord(value.shared)) {
    mismatches.push("F3 pins.shared must be an object");
  } else {
    for (const key of [
      "events",
      "memory",
      "retrieval",
      "portrait",
      "persona",
      "locale",
      "safety",
      "conversation",
    ]) {
      if (!nonEmpty(value.shared[key])) mismatches.push(`F3 pins.shared is missing ${key}`);
    }
  }
  const continuation = isRecord(value.continuation) ? value.continuation : null;
  if (!continuation || !isRecord(continuation.arms)) {
    mismatches.push("F3 continuation arms are required");
  } else {
    if (
      JSON.stringify(continuation.allowedDifferenceKeys) !==
      JSON.stringify(["open_loop_bundle", "proactive_bundle"])
    ) {
      mismatches.push("F3 continuation must freeze only its two allowed differences");
    }
    const arms = continuation.arms;
    const incumbent = isRecord(arms.incumbent) ? arms.incumbent : null;
    const candidate = isRecord(arms.candidate) ? arms.candidate : null;
    if (!incumbent || !candidate) {
      mismatches.push("F3 continuation incumbent and candidate arms are required");
    } else {
      if (!nonEmpty(incumbent.id) || !nonEmpty(candidate.id) || incumbent.id === candidate.id) {
        mismatches.push("F3 continuation arm IDs must be distinct and non-empty");
      }
      for (const arm of [incumbent, candidate]) {
        for (const key of ["openLoop", "proactive"]) {
          if (!isRecord(arm[key])) mismatches.push(`F3 continuation ${key} bundle is required`);
        }
      }
    }
  }
  const bio = isRecord(value.bio) ? value.bio : null;
  if (!bio || !Array.isArray(bio.configurations) || bio.configurations.length < 2) {
    mismatches.push("F3 pins require two Bio configurations");
  } else {
    const ids = new Set<string>();
    for (const configuration of bio.configurations) {
      if (!isRecord(configuration)) {
        mismatches.push("F3 Bio configuration must be an object");
        continue;
      }
      if (!nonEmpty(configuration.id) || ids.has(configuration.id)) {
        mismatches.push("F3 Bio configuration IDs must be distinct and non-empty");
      }
      if (nonEmpty(configuration.id)) ids.add(configuration.id);
      verifyF3RolePin(configuration.writer, "bio.write", mismatches);
      verifyF3RolePin(configuration.validator, "narrative.validate", mismatches);
    }
  }
  if (!isRecord(value.validator)) {
    mismatches.push("F3 validator configuration is required");
  } else {
    verifyF3RolePin(value.validator.configuration, "narrative.validate", mismatches);
  }
}

function verifySharedInputs(value: unknown, mismatches: string[]): void {
  if (!isRecord(value)) {
    mismatches.push("F3 catalog.sharedInputs must be an object");
    return;
  }
  for (const [id, input] of Object.entries(value)) {
    if (!isRecord(input)) {
      mismatches.push(`F3 shared input ${id} must be an object`);
      continue;
    }
    for (const field of ["events", "memory", "retrieval", "portrait"]) {
      if (!Array.isArray(input[field])) mismatches.push(`F3 shared input ${id} is missing ${field}`);
    }
    if (!isRecord(input.config)) mismatches.push(`F3 shared input ${id} is missing config`);
    const events = Array.isArray(input.events) ? input.events : [];
    const memory = Array.isArray(input.memory) ? input.memory : [];
    const eventIds = new Set(
      events.flatMap((entry) => (isRecord(entry) && nonEmpty(entry.id) ? [entry.id] : [])),
    );
    const memoryIds = new Set(
      memory.flatMap((entry) => (isRecord(entry) && nonEmpty(entry.id) ? [entry.id] : [])),
    );
    for (const entry of memory) {
      if (!isRecord(entry) || !Array.isArray(entry.evidenceIds)) continue;
      for (const evidenceId of entry.evidenceIds) {
        if (typeof evidenceId !== "string" || !eventIds.has(evidenceId)) {
          mismatches.push(`F3 shared input ${id} has memory evidence outside events`);
        }
      }
    }
    for (const entry of Array.isArray(input.retrieval) ? input.retrieval : []) {
      if (isRecord(entry) && nonEmpty(entry.memoryId) && !memoryIds.has(entry.memoryId)) {
        mismatches.push(`F3 shared input ${id} has retrieval outside memory`);
      }
    }
    for (const entry of Array.isArray(input.portrait) ? input.portrait : []) {
      if (isRecord(entry) && nonEmpty(entry.claimId) && !memoryIds.has(entry.claimId)) {
        mismatches.push(`F3 shared input ${id} has portrait outside memory`);
      }
    }
  }
}

function verifyScenario(
  scenario: JsonObject,
  sharedInputs: JsonObject | null,
  ids: Set<string>,
  counts: { bio: number; continuation: number; validator: number },
  bioByLanguage: Record<string, number>,
  validatorByLanguage: Record<string, number>,
  validatorKindsByLanguage: Record<string, Record<string, number>>,
  continuationTags: Set<string>,
  mismatches: string[],
): void {
  const id = nonEmpty(scenario.id) ? scenario.id : "<missing-id>";
  if (ids.has(id)) mismatches.push(`duplicate F3 fixture ID ${id}`);
  ids.add(id);
  if (!F3_LANGUAGE_VARIANTS.includes(scenario.languageVariant as never)) {
    mismatches.push(`${id} has an unsupported language variant`);
  }
  if (!nonEmpty(scenario.inputRef) || !nonEmpty(scenario.locale) || !nonEmpty(scenario.timezone)) {
    mismatches.push(`${id} is missing F3 input identity fields`);
  }
  if (sharedInputs && nonEmpty(scenario.inputRef) && !sharedInputs[scenario.inputRef]) {
    mismatches.push(`${id} references missing shared input ${scenario.inputRef}`);
  }
  const language = nonEmpty(scenario.languageVariant) ? scenario.languageVariant : "unknown";
  if (scenario.group === "continuation") {
    counts.continuation += 1;
    if (Array.isArray(scenario.coverageTags)) {
      for (const tag of scenario.coverageTags) continuationTags.add(String(tag));
    } else {
      mismatches.push(`${id} needs F3 continuation coverage tags`);
    }
    if (!isRecord(scenario.hardGate)) mismatches.push(`${id} needs an F3 hard gate`);
    else {
      if (scenario.hardGate.maxQuestions !== 0 && scenario.hardGate.maxQuestions !== 1) {
        mismatches.push(`${id} has an invalid F3 question bound`);
      }
      for (const key of ["requiredTokens", "forbiddenTokens"]) {
        if (!Array.isArray(scenario.hardGate[key])) mismatches.push(`${id} is missing ${key}`);
      }
    }
    if (!Array.isArray(scenario.turns) || scenario.turns.length === 0) {
      mismatches.push(`${id} needs F3 continuation turns`);
    }
  } else if (scenario.group === "bio_naturalness") {
    counts.bio += 1;
    bioByLanguage[language] = (bioByLanguage[language] ?? 0) + 1;
    if (!nonEmpty(scenario.prompt) || !Array.isArray(scenario.turns) || scenario.turns.length === 0) {
      mismatches.push(`${id} needs an F3 Bio prompt and turns`);
    }
  } else if (scenario.group === "validator") {
    counts.validator += 1;
    validatorByLanguage[language] = (validatorByLanguage[language] ?? 0) + 1;
    if (!F3_VALIDATOR_ERROR_CLASSES.includes(scenario.validatorErrorClass as never)) {
      mismatches.push(`${id} has an unknown F3 validator error class`);
    }
    if (!F3_VALIDATOR_ARTIFACT_KINDS.includes(scenario.artifactKind as never)) {
      mismatches.push(`${id} has an unknown F3 validator artifact kind`);
    }
    const kinds = validatorKindsByLanguage[language] ?? {};
    const kind = nonEmpty(scenario.artifactKind) ? scenario.artifactKind : "unknown";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    validatorKindsByLanguage[language] = kinds;
    if (!nonEmpty(scenario.draftText) || !Array.isArray(scenario.sourceClaimIds) || scenario.sourceClaimIds.length === 0) {
      mismatches.push(`${id} needs an F3 validator draft and source claims`);
    }
    const sharedCandidate =
      sharedInputs && nonEmpty(scenario.inputRef)
        ? sharedInputs[scenario.inputRef]
        : null;
    const shared: JsonObject | null = isRecord(sharedCandidate)
      ? sharedCandidate
      : null;
    const knownMemoryIds = new Set(
      shared && Array.isArray(shared.memory)
        ? shared.memory.flatMap((entry: unknown) => (isRecord(entry) && nonEmpty(entry.id) ? [entry.id] : []))
        : [],
    );
    if (Array.isArray(scenario.sourceClaimIds)) {
      for (const claimId of scenario.sourceClaimIds) {
        if (typeof claimId !== "string" || !knownMemoryIds.has(claimId)) {
          mismatches.push(`${id} references a validator source claim outside frozen Memory`);
        }
      }
    }
  } else {
    mismatches.push(`${id} has an unknown F3 fixture group`);
  }
}

/** Exported for the holdout catalog contract test. */
export function verifyF3Catalog(value: unknown, mismatches: string[]): Set<string> {
  const scenarioIds = new Set<string>();
  if (!isRecord(value)) {
    mismatches.push("F3 catalog must be an object");
    return scenarioIds;
  }
  if (typeof value.version !== "string" || !F3_CATALOG_VERSIONS.includes(value.version)) {
    mismatches.push("unsupported F3 catalog version");
  }
  if (value.synthetic !== true) mismatches.push("F3 catalog must be synthetic-only");
  if (!nonEmpty(value.syntheticNotice) || !value.syntheticNotice.toLowerCase().includes("synthetic")) {
    mismatches.push("F3 catalog must explain that all fixtures are synthetic");
  }
  verifySharedInputs(value.sharedInputs, mismatches);
  const sharedInputs = isRecord(value.sharedInputs) ? value.sharedInputs : null;
  if (!Array.isArray(value.scenarios)) {
    mismatches.push("F3 catalog.scenarios must be an array");
    return scenarioIds;
  }
  const counts = { bio: 0, continuation: 0, validator: 0 };
  const bioByLanguage: Record<string, number> = {};
  const validatorByLanguage: Record<string, number> = {};
  const validatorKindsByLanguage: Record<string, Record<string, number>> = {};
  const continuationTags = new Set<string>();
  for (const scenario of value.scenarios) {
    if (!isRecord(scenario)) {
      mismatches.push("F3 catalog contains a non-object scenario");
      continue;
    }
    verifyScenario(
      scenario,
      sharedInputs,
      scenarioIds,
      counts,
      bioByLanguage,
      validatorByLanguage,
      validatorKindsByLanguage,
      continuationTags,
      mismatches,
    );
  }
  if (counts.continuation !== 18) mismatches.push("F3 continuation pool must contain 18 fixtures");
  if (counts.bio !== 15) mismatches.push("F3 Bio naturalness set must contain 15 fixtures");
  if (counts.validator !== 18) mismatches.push("F3 validator set must contain 18 fixtures");
  for (const language of F3_LANGUAGE_VARIANTS) {
    if (bioByLanguage[language] !== 5) mismatches.push(`F3 Bio ${language} quota must be 5`);
    if (validatorByLanguage[language] !== 6) mismatches.push(`F3 validator ${language} quota must be 6`);
    if (validatorKindsByLanguage[language]?.bio !== 4) mismatches.push(`F3 validator ${language}/bio quota must be 4`);
    if (validatorKindsByLanguage[language]?.reflection !== 2) mismatches.push(`F3 validator ${language}/reflection quota must be 2`);
  }
  for (const tag of F3_CONTINUATION_FORCED_COVERAGE) {
    if (!continuationTags.has(tag)) mismatches.push(`F3 continuation pool has no fixture for ${tag}`);
  }
  for (const errorClass of F3_VALIDATOR_ERROR_CLASSES) {
    if (!value.scenarios.some((scenario) => isRecord(scenario) && scenario.group === "validator" && scenario.validatorErrorClass === errorClass)) {
      mismatches.push(`F3 validator pool has no ${errorClass} fixture`);
    }
  }
  return scenarioIds;
}

function verifyF3Baseline(manifest: JsonObject, mismatches: string[]): void {
  const baseline = isRecord(manifest.baseline) ? manifest.baseline : null;
  if (!baseline) {
    mismatches.push("F3 manifest baseline reference is required");
    return;
  }
  const historicalIncumbent = isRecord(baseline.historicalIncumbent)
    ? baseline.historicalIncumbent
    : null;
  if (!historicalIncumbent) {
    mismatches.push("F3 baseline historical incumbent is required");
  } else {
    if (historicalIncumbent.issue !== 166) {
      mismatches.push("F3 baseline historical incumbent must be Issue #166");
    }
    if (
      !nonEmpty(historicalIncumbent.manifestPath) ||
      !nonEmpty(historicalIncumbent.artifactPath) ||
      !/^[a-f0-9]{40}$/.test(String(historicalIncumbent.runCommit ?? ""))
    ) {
      mismatches.push("F3 baseline historical incumbent is missing its frozen lineage");
    }
  }
  if (
    !Array.isArray(baseline.historicalFindingIssues) ||
    baseline.historicalFindingIssues.length !== 2 ||
    !baseline.historicalFindingIssues.includes(166) ||
    !baseline.historicalFindingIssues.includes(186)
  ) {
    mismatches.push(
      "F3 baseline must retain the confirmed Issue #186 findings alongside Issue #166",
    );
  }
  const current = isRecord(baseline.currentIncumbent)
    ? baseline.currentIncumbent
    : null;
  if (!current) {
    mismatches.push("F3 baseline current incumbent is required");
    return;
  }
  const comparisonAllowed =
    current.status === "clean" && current.confirmedHardGateFailures === 0;
  if (current.status === "clean") {
    if (
      !/^[a-f0-9]{40}$/.test(String(current.commit ?? "")) ||
      !nonEmpty(current.manifestPath) ||
      current.confirmedHardGateFailures !== 0
    ) {
      mismatches.push(
        "a clean F3 incumbent needs a commit, manifest path, and zero hard-gate failures",
      );
    }
  } else if (current.status === "requires-clean-rebaseline") {
    if (
      current.commit !== null ||
      current.manifestPath !== null ||
      current.confirmedHardGateFailures !== null
    ) {
      mismatches.push(
        "a F3 incumbent requiring clean rebaseline cannot carry clean incumbent claims",
      );
    }
  } else {
    mismatches.push("F3 baseline current incumbent has an unsupported status");
  }
  if (manifest.comparisonAllowed !== comparisonAllowed) {
    mismatches.push("F3 baseline and comparisonAllowed are inconsistent");
  }
  if (manifest.status !== (comparisonAllowed ? "ready_for_evaluation" : "blocked_requires_clean_incumbent")) {
    mismatches.push("F3 baseline status is not derived from the current incumbent");
  }
}

function verifyF3Sampling(
  manifest: JsonObject,
  catalog: JsonObject,
  mismatches: string[],
): void {
  const sampleSeed = manifest.sampleSeed;
  if (typeof sampleSeed !== "number" || !Number.isSafeInteger(sampleSeed)) {
    mismatches.push("F3 sampleSeed must be an integer");
    return;
  }
  if (!Number.isSafeInteger(manifest.fixtureSeed)) {
    mismatches.push("F3 fixtureSeed must be an integer");
  }
  const scenarios = Array.isArray(catalog.scenarios)
    ? catalog.scenarios.filter(isRecord)
    : [];
  const continuationCandidates: F3SampleCandidate[] = scenarios.flatMap((scenario) => {
    if (
      scenario.group !== "continuation" ||
      !nonEmpty(scenario.id) ||
      !F3_LANGUAGE_VARIANTS.includes(scenario.languageVariant as F3LanguageVariant) ||
      !Array.isArray(scenario.coverageTags) ||
      scenario.coverageTags.some((tag) => typeof tag !== "string")
    ) {
      return [];
    }
    return [
      {
        category: nonEmpty(scenario.category) ? scenario.category : "",
        coverageTags: scenario.coverageTags as string[],
        id: scenario.id,
        languageVariant: scenario.languageVariant as F3LanguageVariant,
      },
    ];
  });
  const bioCandidates: F3SampleCandidate[] = scenarios.flatMap((scenario) => {
    if (
      scenario.group !== "bio_naturalness" ||
      !nonEmpty(scenario.id) ||
      !F3_LANGUAGE_VARIANTS.includes(scenario.languageVariant as F3LanguageVariant)
    ) {
      return [];
    }
    return [
      {
        category: "",
        coverageTags: [],
        id: scenario.id,
        languageVariant: scenario.languageVariant as F3LanguageVariant,
      },
    ];
  });

  const continuation = isRecord(manifest.continuation) ? manifest.continuation : null;
  const continuationSample = continuation && isRecord(continuation.sample)
    ? continuation.sample
    : null;
  if (!continuation || !continuationSample) {
    mismatches.push("F3 continuation sample is required");
  } else {
    if (continuation.hardGateScope !== "full_pool") {
      mismatches.push("F3 continuation hard-gate scope must be full_pool");
    }
    if (continuation.poolCount !== continuationCandidates.length || continuation.poolCount !== 18) {
      mismatches.push("F3 continuation pool count is not bound to the catalog");
    }
    try {
      const expected = expectedContinuationSample(
        continuationCandidates,
        sampleSeed,
      );
      if (continuationSample.strategy !== "stratified-random-v1") {
        mismatches.push("F3 continuation sample strategy is not pinned");
      }
      if (continuationSample.sampleSeed !== sampleSeed) {
        mismatches.push("F3 continuation sample seed is not bound to the manifest");
      }
      if (!sameJson(continuationSample.quotas, F3_CONTINUATION_SAMPLE_QUOTAS)) {
        mismatches.push("F3 continuation language quotas are not the released quotas");
      }
      if (!sameJson(continuationSample.eligibleCounts, expected.eligibleCounts)) {
        mismatches.push("F3 continuation eligible counts do not match the catalog");
      }
      if (!sameJson(continuationSample.selectedCounts, expected.selectedCounts)) {
        mismatches.push("F3 continuation selected counts do not match the released quotas");
      }
      if (!sameJson(continuationSample.forcedCoverage, expected.forcedCoverage)) {
        mismatches.push("F3 continuation forced coverage is not the deterministic selection");
      }
      if (!sameJson(continuationSample.protectedCoverage, expected.protectedCoverage)) {
        mismatches.push("F3 continuation protected coverage is not the deterministic selection");
      }
      if (!sameJson(continuationSample.scenarioIds, expected.scenarioIds)) {
        mismatches.push("F3 continuation scenario IDs are not the deterministic sample");
      }
    } catch (error) {
      mismatches.push(
        `F3 continuation sample cannot be recomputed: ${error instanceof Error ? error.message : "invalid sample"}`,
      );
    }
  }

  const bio = isRecord(manifest.bio) ? manifest.bio : null;
  if (!bio) {
    mismatches.push("F3 Bio sample is required");
  } else {
    if (bio.total !== 15) mismatches.push("F3 Bio total must be 15");
    if (!sameJson(bio.sampleQuotas, F3_BIO_SAMPLE_QUOTAS)) {
      mismatches.push("F3 Bio sample quotas are not the released quotas");
    }
    const expectedBioIds = expectedFixedLanguageSample(
      bioCandidates,
      sampleSeed,
    );
    if (!sameJson(bio.sampleIds, expectedBioIds)) {
      mismatches.push("F3 Bio sample IDs are not the deterministic sample");
    }
  }

  const validator = isRecord(manifest.validator) ? manifest.validator : null;
  const expectedValidatorByLanguage = {
    code_switch: { bio: 4, reflection: 2 },
    en: { bio: 4, reflection: 2 },
    zh: { bio: 4, reflection: 2 },
  } as const;
  if (!validator) {
    mismatches.push("F3 validator sample is required");
  } else {
    if (validator.total !== 18) mismatches.push("F3 validator total must be 18");
    if (!sameJson(validator.byLanguage, expectedValidatorByLanguage)) {
      mismatches.push("F3 validator language and artifact-kind quotas are not released");
    }
  }
}

function verifyF3Ledger(
  value: unknown,
  validatorIds: Set<string>,
  manifestFingerprint: string | null,
  mismatches: string[],
): void {
  if (!isRecord(value)) {
    mismatches.push("F3 validator ledger must be an object");
    return;
  }
  if (value.version !== F3_LEDGER_VERSION || value.group !== "validator") {
    mismatches.push("F3 validator ledger has an unsupported version or group");
  }
  if (manifestFingerprint !== null && value.manifestFingerprint !== manifestFingerprint) {
    mismatches.push("F3 validator ledger is not bound to the F3 manifest");
  }
  if (value.adjudicator !== "Luke") mismatches.push("F3 validator ledger must be adjudicated by Luke");
  if (!nonEmpty(value.decidedAt) || Number.isNaN(new Date(value.decidedAt).getTime())) {
    mismatches.push("F3 validator ledger must have a valid decision timestamp");
  }
  if (!Array.isArray(value.entries)) {
    mismatches.push("F3 validator ledger entries must be an array");
    return;
  }
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!isRecord(entry) || !nonEmpty(entry.fixtureId)) {
      mismatches.push("F3 validator ledger contains an invalid fixture entry");
      continue;
    }
    if (!validatorIds.has(entry.fixtureId) || seen.has(entry.fixtureId)) {
      mismatches.push(`F3 validator ledger has an unknown or duplicate fixture ${entry.fixtureId}`);
    }
    if (entry.verdict !== "accepted" && entry.verdict !== "rejected") {
      mismatches.push(`F3 validator ledger has an invalid verdict for ${entry.fixtureId}`);
    }
    if ("machineVerdict" in entry) mismatches.push("F3 validator ledger cannot contain machine verdicts");
    seen.add(entry.fixtureId);
  }
  if (seen.size !== validatorIds.size) mismatches.push("F3 validator ledger must cover all 18 fixtures");
}

/** Common semantic checks used by both the release CLI and server startup. */
export function verifyOneA3bF3ReleaseArtifacts(input: Readonly<{
  manifest: unknown;
  catalog: unknown;
  ledger: unknown;
}>): readonly string[] {
  const mismatches: string[] = [];
  noProductionSource(input.manifest, "F3 manifest", mismatches);
  noProductionSource(input.catalog, "F3 catalog", mismatches);
  noProductionSource(input.ledger, "F3 validator ledger", mismatches);
  if (!isRecord(input.manifest)) {
    mismatches.push("F3 manifest must be an object");
    return mismatches;
  }
  if (input.manifest.version !== F3_MANIFEST_VERSION) mismatches.push("unsupported F3 manifest version");
  if (!FINGERPRINT_PATTERN.test(String(input.manifest.fingerprint ?? ""))) {
    mismatches.push("F3 manifest fingerprint is missing or malformed");
  } else {
    const { fingerprint: _fingerprint, ...withoutFingerprint } = input.manifest;
    if (
      safeSha256Fingerprint({
        ...withoutFingerprint,
        createdAt: "volatile",
      }) !== input.manifest.fingerprint
    ) {
      mismatches.push("F3 manifest fingerprint does not match its content");
    }
  }
  const comparisonAllowed = input.manifest.comparisonAllowed;
  const status = input.manifest.status;
  if (typeof comparisonAllowed !== "boolean" || comparisonAllowed !== (status === "ready_for_evaluation")) {
    mismatches.push("F3 manifest status and comparisonAllowed disagree");
  }
  verifyF3Baseline(input.manifest, mismatches);
  verifyF3Pins(input.manifest.pinnedConfiguration, mismatches);
  const pins = isRecord(input.manifest.pins) ? input.manifest.pins : null;
  if (!pins) {
    mismatches.push("F3 manifest pins hash is required");
  } else {
    if (pins.version !== F3_PINS_VERSION) mismatches.push("F3 manifest pins version is not frozen");
    if (
      pins.sha256 !== safeSha256Fingerprint(input.manifest.pinnedConfiguration)
    ) {
      mismatches.push("F3 manifest pins hash does not match pinnedConfiguration");
    }
  }
  const validatorIds = new Set<string>();
  const catalogIds = verifyF3Catalog(input.catalog, mismatches);
  if (!isRecord(input.catalog)) return mismatches;
  const catalogReference = isRecord(input.manifest.catalog)
    ? input.manifest.catalog
    : null;
  if (!catalogReference) {
    mismatches.push("F3 manifest catalog hash is required");
  } else {
    if (
      typeof catalogReference.version !== "string" ||
      !F3_CATALOG_VERSIONS.includes(catalogReference.version)
    ) {
      mismatches.push("F3 manifest catalog version is not frozen");
    }
    if (catalogReference.sha256 !== safeSha256Fingerprint(input.catalog)) {
      mismatches.push("F3 manifest catalog hash does not match the catalog");
    }
  }
  verifyF3Sampling(input.manifest, input.catalog, mismatches);
  if (Array.isArray(input.catalog.scenarios)) {
    for (const scenario of input.catalog.scenarios) {
      if (isRecord(scenario) && scenario.group === "validator" && nonEmpty(scenario.id)) {
        validatorIds.add(scenario.id);
      }
    }
  }
  if (catalogIds.size !== 51) mismatches.push("F3 catalog must contain 51 unique scenarios");
  verifyF3Ledger(
    input.ledger,
    validatorIds,
    nonEmpty(input.manifest.fingerprint) ? input.manifest.fingerprint : null,
    mismatches,
  );
  return mismatches;
}

/** Match active G1 transport pins to the exact role pins used by F3. */
export function verifyOneA3bG1RoleConfigurationsAgainstF3(
  configurations: readonly ModelRoleConfigurationSnapshot[],
  f3Manifest: unknown,
): readonly string[] {
  const mismatches: string[] = [];
  if (!isRecord(f3Manifest) || !isRecord(f3Manifest.pinnedConfiguration) || !isRecord(f3Manifest.pinnedConfiguration.roles)) {
    return ["F3 role pins are missing; G1 configurations cannot be activated."];
  }
  if (configurations.length !== ONE_A_3B_G1_ENABLED_ROLES.length) {
    mismatches.push("G1 must contain exactly the four enabled role configurations");
  }
  const seen = new Set<string>();
  for (const configuration of configurations) {
    if (seen.has(configuration.role)) mismatches.push(`duplicate G1 configuration ${configuration.role}`);
    seen.add(configuration.role);
    if (!(ONE_A_3B_G1_ENABLED_ROLES as readonly string[]).includes(configuration.role)) {
      mismatches.push(`${configuration.role} is not an enabled G1 role`);
      continue;
    }
    const pin = f3Manifest.pinnedConfiguration.roles[configuration.role];
    if (!isRecord(pin)) {
      mismatches.push(`F3 is missing the evaluated pin for ${configuration.role}`);
      continue;
    }
    const comparisons: readonly [string, unknown, unknown][] = [
      ["provider", configuration.provider, pin.provider],
      ["model", configuration.model, pin.model],
      ["modelSnapshot", configuration.modelSnapshot, pin.snapshot],
      ["promptVersion", configuration.promptVersion, pin.promptVersion],
      ["schemaVersion", configuration.schemaVersion, pin.schemaVersion],
      ["parameterSnapshot", configuration.parameterSnapshot, pin.parameters],
      ["maxTechnicalRetries", configuration.maxTechnicalRetries, pin.maxTechnicalRetries],
    ];
    for (const [field, actual, expected] of comparisons) {
      let equal = false;
      try {
        equal = canonicalJson(actual) === canonicalJson(expected);
      } catch {
        equal = false;
      }
      if (!equal) mismatches.push(`${configuration.role}.${field} does not match the F3 evaluated pin`);
    }
    if (pin.fallback !== "none" || configuration.fallbackMode !== "disabled") {
      mismatches.push(`${configuration.role} must disable fallback in both G1 and F3`);
    }
  }
  for (const role of ONE_A_3B_G1_ENABLED_ROLES) {
    if (!seen.has(role)) mismatches.push(`G1 is missing ${role}`);
  }
  return mismatches;
}

/** Verify the content-addressed, typed result envelope for one G1 criterion. */
export function verifyOneA3bG1EvidenceArtifact(input: Readonly<{
  value: unknown;
  evidence: OneA3bG1Evidence;
  gitCommit: string;
  f3ManifestFingerprint: string;
  fixtureCatalogSha256: string;
  knownFixtureIds: ReadonlySet<string>;
}>): readonly string[] {
  const mismatches: string[] = [];
  noProductionSource(input.value, "G1 evidence artifact", mismatches);
  if (!isRecord(input.value)) return [...mismatches, "G1 evidence artifact must be an object"];
  const artifact = input.value;
  if (artifact.version !== "1a3b-g1-evidence:v1") mismatches.push("unsupported G1 evidence artifact version");
  if (artifact.criterion !== input.evidence.criterion) mismatches.push(`${input.evidence.criterion} artifact criterion is not bound to its manifest entry`);
  if (artifact.gitCommit !== input.gitCommit) mismatches.push(`${input.evidence.criterion} artifact commit is not bound to the release commit`);
  if (artifact.f3ManifestFingerprint !== input.f3ManifestFingerprint) mismatches.push(`${input.evidence.criterion} artifact is not bound to the F3 manifest`);
  if (artifact.fixtureCatalogSha256 !== input.fixtureCatalogSha256) mismatches.push(`${input.evidence.criterion} artifact is not bound to the F3 catalog`);
  if (artifact.command !== input.evidence.command) mismatches.push(`${input.evidence.criterion} artifact command is not bound to the manifest command`);
  if (typeof artifact.gitCommit !== "string" || !/^[a-f0-9]{40}$/.test(artifact.gitCommit)) mismatches.push(`${input.evidence.criterion} artifact commit has an invalid format`);
  if (typeof artifact.f3ManifestFingerprint !== "string" || !FINGERPRINT_PATTERN.test(artifact.f3ManifestFingerprint)) mismatches.push(`${input.evidence.criterion} artifact F3 fingerprint has an invalid format`);
  if (typeof artifact.fixtureCatalogSha256 !== "string" || !SHA256_PATTERN.test(artifact.fixtureCatalogSha256)) mismatches.push(`${input.evidence.criterion} artifact catalog hash has an invalid format`);
  if (artifact.status !== "passed" || !nonEmpty(artifact.runId)) mismatches.push(`${input.evidence.criterion} artifact must record a passed run ID`);
  if (!Array.isArray(artifact.fixtureIds) || artifact.fixtureIds.length !== input.evidence.fixtureIds.length) {
    mismatches.push(`${input.evidence.criterion} artifact fixture IDs do not match the manifest`);
  } else {
    const actual = new Set<string>();
    for (const fixtureId of artifact.fixtureIds) {
      if (typeof fixtureId !== "string" || !input.knownFixtureIds.has(fixtureId) || actual.has(fixtureId)) {
        mismatches.push(`${input.evidence.criterion} artifact has an unknown or duplicate fixture ID`);
      }
      actual.add(String(fixtureId));
    }
    const expected = new Set(input.evidence.fixtureIds);
    if (actual.size !== expected.size || [...expected].some((fixtureId) => !actual.has(fixtureId))) {
      mismatches.push(`${input.evidence.criterion} artifact fixture IDs are not the exact manifest set`);
    }
  }
  if (!isRecord(artifact.result) || artifact.result.passed !== true) {
    mismatches.push(`${input.evidence.criterion} artifact result must be an explicit pass`);
  } else {
    const contract = ONE_A_3B_G1_EVIDENCE_CONTRACTS[input.evidence.criterion];
    if (artifact.result.runId !== artifact.runId) mismatches.push(`${input.evidence.criterion} artifact result run ID is not immutable lineage`);
    if (artifact.result.command !== artifact.command) mismatches.push(`${input.evidence.criterion} artifact result command is not immutable lineage`);
    if (artifact.result.criterion !== artifact.criterion) mismatches.push(`${input.evidence.criterion} artifact result criterion is not immutable lineage`);
    if (artifact.result.gitCommit !== artifact.gitCommit) mismatches.push(`${input.evidence.criterion} artifact result commit is not immutable lineage`);
    if (artifact.result.f3ManifestFingerprint !== artifact.f3ManifestFingerprint) mismatches.push(`${input.evidence.criterion} artifact result F3 fingerprint is not immutable lineage`);
    if (artifact.result.fixtureCatalogSha256 !== artifact.fixtureCatalogSha256) mismatches.push(`${input.evidence.criterion} artifact result catalog hash is not immutable lineage`);
    if (!sameJson(artifact.result.fixtureIds, artifact.fixtureIds)) mismatches.push(`${input.evidence.criterion} artifact result fixture IDs are not immutable lineage`);
    if (artifact.result.evidenceKind !== contract.evidenceKind) {
      mismatches.push(`${input.evidence.criterion} artifact result has the wrong evidence kind`);
    }
    if (
      !Array.isArray(artifact.result.assertionIds) ||
      !sameJson(artifact.result.assertionIds, contract.requiredAssertionIds)
    ) {
      mismatches.push(`${input.evidence.criterion} artifact result does not cover its criterion assertions`);
    }
    for (const key of contract.requiredResultKeys) {
      const value = artifact.result[key];
      const kind = contract.resultFieldKinds[key];
      if (!kind || !evidenceResultFieldMatches(value, kind)) {
        mismatches.push(
          `${input.evidence.criterion} artifact result ${key} has an invalid type or format`,
        );
      }
    }
    if (
      input.evidence.criterion === "AC-X04" &&
      artifact.result.confirmedHardFailures !== 0
    ) {
      mismatches.push("AC-X04 artifact must report zero confirmed deterministic hard failures");
    }
    if (
      input.evidence.criterion === "AC-W01" &&
      artifact.result.hosted !== true
    ) {
      mismatches.push("AC-W01 artifact must report a hosted canary");
    }
    if (
      input.evidence.criterion === "AC-D01" &&
      artifact.result.deploymentCommit !== input.gitCommit
    ) {
      mismatches.push("AC-D01 artifact deployment commit is not bound to the release commit");
    }
  }
  return mismatches;
}

export { FINGERPRINT_PATTERN, SHA256_PATTERN };
