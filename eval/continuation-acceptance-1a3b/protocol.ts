import { createHash } from "node:crypto";

import {
  BLIND_PAIRWISE_PROTOCOL_V2,
  PAIRWISE_SAMPLE_PROTECTED_CATEGORIES,
} from "../blind-pairwise/protocol";

export const F3_CATALOG_VERSION = "1a3b-f3-fixtures:v1" as const;
/**
 * A separately authored catalog for the #252 acceptance holdout. It is a
 * distinct version rather than a re-run of the spent catalog, so the two can
 * never be confused in release evidence.
 */
export const F3_HOLDOUT_CATALOG_VERSION = "1a3b-f3-holdout-fixtures:v1" as const;
export const F3_MANIFEST_VERSION = "1a3b-f3-manifest:v1" as const;
export const F3_RUN_VERSION = "1a3b-f3-synthetic-run:v1" as const;
export const F3_REVIEW_PACKAGE_VERSION = "1a3b-f3-review-package:v1" as const;
export const F3_LEDGER_VERSION = "1a3b-f3-adjudication:v1" as const;
export const F3_BIO_INSPECTION_VERSION = "1a3b-f3-bio-inspection:v1" as const;
export const F3_PAIRWISE_PROTOCOL = BLIND_PAIRWISE_PROTOCOL_V2;

/**
 * The Continuation pool's two arms, which answer two different questions.
 *
 * The incumbent arm runs the real production conversation seam — Context
 * Compiler, Conversation Agent Harness, Runtime Provider Egress — so its hard
 * gates describe the conversation the product actually has. That is the arm a
 * G1 release certifies.
 *
 * The candidate arm turns the G2 Open Loop bundle on through `open_loop.extract`
 * and exists to measure whether that bundle degrades ordinary dialogue. G1 does
 * not ship the bundle, so this arm is never a G1 acceptance source, and a
 * release that cites it is citing a comparison about a configuration it does not
 * contain. Both live here so a capture, a report, and the G1 evidence producer
 * cannot disagree about which arm is which.
 */
export const F3_INCUMBENT_CONFIG_ID = "continuation-incumbent-1a3a" as const;
export const F3_BUNDLE_CANDIDATE_CONFIG_ID = "continuation-bundle-1a3b-v1" as const;

/**
 * The only arm a G1 release may cite for AC-X04.
 */
export const G1_ACCEPTANCE_HARD_GATE_CONFIG_ID = F3_INCUMBENT_CONFIG_ID;

export const F3_GROUPS = [
  "continuation",
  "bio_naturalness",
  "validator",
] as const;
export type F3Group = (typeof F3_GROUPS)[number];

export const LANGUAGE_VARIANTS = ["en", "zh", "code_switch"] as const;
export type LanguageVariant = (typeof LANGUAGE_VARIANTS)[number];

export const CONTINUATION_SAMPLE_QUOTAS: Readonly<
  Record<Exclude<LanguageVariant, never>, number>
> = Object.freeze({
  code_switch: 2,
  en: 8,
  zh: 5,
});

export const BIO_SAMPLE_QUOTAS: Readonly<Record<LanguageVariant, number>> =
  Object.freeze({
    code_switch: 5,
    en: 5,
    zh: 5,
  });

export const VALIDATOR_QUOTAS: Readonly<Record<LanguageVariant, number>> =
  Object.freeze({
    code_switch: 6,
    en: 6,
    zh: 6,
  });

/** F3-specific coverage that must survive the 15-scenario Continuation sample. */
export const CONTINUATION_FORCED_COVERAGE = Object.freeze([
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
] as const);

export type ContinuationCoverageTag =
  (typeof CONTINUATION_FORCED_COVERAGE)[number];

/** ADR-0114 categories that must be represented in the 15-case sample. */
export const CONTINUATION_PROTECTED_CATEGORIES =
  PAIRWISE_SAMPLE_PROTECTED_CATEGORIES;
export type ContinuationProtectedCategory =
  (typeof CONTINUATION_PROTECTED_CATEGORIES)[number];

export const VALIDATOR_ERROR_CLASSES = Object.freeze([
  "unsupported",
  "contradiction",
  "epistemic_upgrade",
  "material_absence",
  "manifest_mismatch",
  "ambiguity",
] as const);
export type ValidatorErrorClass = (typeof VALIDATOR_ERROR_CLASSES)[number];

export const VALIDATOR_ARTIFACT_KINDS = ["bio", "reflection"] as const;
export type ValidatorArtifactKind = (typeof VALIDATOR_ARTIFACT_KINDS)[number];

export type SyntheticInput = Readonly<{
  locale: string;
  text: string;
  timezone: string;
}>;

export type SyntheticTurn = Readonly<{
  sequenceInScenario: number;
  userInput: SyntheticInput;
}>;

export type FrozenSharedInput = Readonly<{
  events: readonly Readonly<{
    id: string;
    locale: string;
    sourceRevision: string;
    text: string;
  }>[];
  memory: readonly Readonly<{
    evidenceIds: readonly string[];
    id: string;
    kind: "objective_memory" | "ai_impression" | "person_portrait";
    text: string;
  }>[];
  retrieval: readonly Readonly<{
    id: string;
    memoryId: string;
    rank: number;
    reason: string;
    selected: boolean;
  }>[];
  portrait: readonly Readonly<{
    claimId: string;
    id: string;
    kind: "objective_memory" | "ai_impression";
    text: string;
  }>[];
  config: Readonly<{
    conversation: string;
    locale: string;
    persona: string;
    safety: string;
  }>;
}>;

export type HardGateExpectation = Readonly<{
  forbiddenTokens: readonly string[];
  maxQuestions: 0 | 1;
  requiredTokens: readonly string[];
}>;

type FixtureBase = Readonly<{
  category: string;
  description: string;
  id: string;
  inputRef: string;
  languageVariant: LanguageVariant;
  locale: string;
  timezone: string;
}>;

export type ContinuationFixture = FixtureBase &
  Readonly<{
    artifactKind?: never;
    coverageTags: readonly ContinuationCoverageTag[];
    group: "continuation";
    hardGate: HardGateExpectation;
    turns: readonly SyntheticTurn[];
  }>;

export type BioNaturalnessFixture = FixtureBase &
  Readonly<{
    artifactKind?: never;
    group: "bio_naturalness";
    prompt: string;
    turns: readonly SyntheticTurn[];
  }>;

export type ValidatorFixture = FixtureBase &
  Readonly<{
    artifactKind: ValidatorArtifactKind;
    draftText: string;
    /**
     * What the seeded defect is supposed to produce, declared per case.
     *
     * This was `"blocking"` for every case regardless of artifact kind, and the
     * review builder then derived the expected machine verdict from the kind
     * instead — `bio ? "blocked" : "accepted"`. The two together meant the
     * expectation for a Reflection case was "this has a blocking-class defect,
     * and a validator that accepts it is behaving as expected". That is how
     * 6 of 6 Reflection cases came back accepted and matched, which is how a
     * kind-keyed pass read as a calibration result.
     *
     * ADR-0143 makes the declared severity the only source of truth: with no
     * gold set, no seeded defect may be expected to block.
     */
    expectedOutcome: "advisory" | "blocking";
    group: "validator";
    sourceClaimIds: readonly string[];
    validatorErrorClass: ValidatorErrorClass;
  }>;

export type Fixture =
  | ContinuationFixture
  | BioNaturalnessFixture
  | ValidatorFixture;

/**
 * A clean draft used by the zero-false-blocking precision set. It cites a claim
 * from the same catalog's `sharedInputs`, so a holdout can carry its own
 * precision drafts instead of reusing the ones the capture script hardcodes.
 */
export type PrecisionDraft = Readonly<{
  id: string;
  locale: string;
  inputRef: string;
  claimId: string;
  draftText: string;
}>;

export type FixtureCatalog = Readonly<{
  scenarios: readonly Fixture[];
  sharedInputs: Readonly<Record<string, FrozenSharedInput>>;
  synthetic: true;
  syntheticNotice: string;
  /**
   * Optional. When present, `--precision` uses these drafts instead of the
   * capture script's built-in set, which is bound to the spent catalog's claim
   * IDs. Absent means the built-in set is used, which is what the incumbent
   * catalog relies on; its bytes are hashed into already-produced release
   * fingerprints and must not change.
   */
  precisionDrafts?: readonly PrecisionDraft[];
  version: typeof F3_CATALOG_VERSION | typeof F3_HOLDOUT_CATALOG_VERSION;
}>;

export type SampleCandidate = Readonly<{
  category: string;
  coverageTags: readonly string[];
  id: string;
  languageVariant: LanguageVariant;
}>;

export type ContinuationSample = Readonly<{
  eligibleCounts: Readonly<Record<LanguageVariant, number>>;
  forcedCoverage: Readonly<Record<ContinuationCoverageTag, string>>;
  protectedCoverage: Readonly<Record<ContinuationProtectedCategory, string>>;
  quotas: Readonly<Record<LanguageVariant, number>>;
  sampleSeed: number;
  scenarioIds: readonly string[];
  selectedCounts: Readonly<Record<LanguageVariant, number>>;
  strategy: "stratified-random-v1";
}>;

export type RoleName =
  | "episode.build"
  | "open_loop.extract"
  | "reflection.daily"
  | "reflection.weekly"
  | "bio.write"
  | "narrative.validate"
  | "proactive.followup";

export const MODEL_ROLES: readonly RoleName[] = Object.freeze([
  "episode.build",
  "open_loop.extract",
  "reflection.daily",
  "reflection.weekly",
  "bio.write",
  "narrative.validate",
  "proactive.followup",
]);

export type RolePin = Readonly<{
  fallback: "none";
  maxTechnicalRetries: 0 | 1;
  model: string;
  parameters: Readonly<Record<string, boolean | number | string>>;
  policyVersion: string;
  promptVersion: string;
  provider: "deepseek" | "openai" | "opencode-go" | "deterministic";
  schemaVersion: string;
  snapshot: string;
}>;

export type BundlePin = Readonly<{
  configVersion: string;
  policyVersion: string;
  promptVersion: string;
  schemaVersion: string;
}>;

export type F3Pins = Readonly<{
  bio: Readonly<{
    configurations: readonly Readonly<{
      id: string;
      validator: RolePin;
      writer: RolePin;
    }>[];
  }>;
  continuation: Readonly<{
    allowedDifferenceKeys: readonly ["open_loop_bundle", "proactive_bundle"];
    arms: Readonly<{
      candidate: Readonly<{
        id: string;
        openLoop: BundlePin;
        proactive: BundlePin;
      }>;
      incumbent: Readonly<{
        id: string;
        openLoop: BundlePin;
        proactive: BundlePin;
      }>;
    }>;
  }>;
  roles: Readonly<Record<RoleName, RolePin>>;
  shared: Readonly<{
    conversation: string;
    events: string;
    locale: string;
    memory: string;
    persona: string;
    portrait: string;
    retrieval: string;
    safety: string;
  }>;
  syntheticOnly: true;
  validator: Readonly<{ configuration: RolePin }>;
  version: "1a3b-f3-pins:v3";
}>;

export type BaselineReference = Readonly<{
  currentIncumbent: Readonly<{
    commit: string | null;
    confirmedHardGateFailures: number | null;
    manifestPath: string | null;
    status: "clean" | "requires-clean-rebaseline";
  }>;
  historicalFindings: readonly Readonly<{
    confirmed: true;
    issue: 186;
    name: string;
  }>[];
  historicalIncumbent: Readonly<{
    artifactPath: string;
    issue: 166;
    manifestPath: string;
    runCommit: string;
  }>;
  synthetic: true;
  version: "1a3b-f3-baseline-reference:v1";
}>;

export type SyntheticRunTurn = SyntheticTurn &
  Readonly<{ assistantText: string }>;

export type SyntheticRun = Readonly<{
  arm: string;
  catalogVersion: string;
  configurationFingerprint: string;
  configId: string;
  format: typeof F3_RUN_VERSION;
  group: "continuation" | "bio_naturalness";
  scenarios: readonly Readonly<{
    fixtureId: string;
    promptFingerprint: string | null;
    sharedInputFingerprint: string;
    turns: readonly SyntheticRunTurn[];
  }>[];
  sourceKind: "synthetic-eval";
  synthetic: true;
  version: typeof F3_RUN_VERSION;
}>;

export type PairwiseChoice = "A" | "tie" | "B";

export type PairwiseScores = Readonly<{
  protocol: typeof F3_PAIRWISE_PROTOCOL;
  scenarios: readonly Readonly<{
    overallChoice: PairwiseChoice;
    scenarioId: string;
    turns: readonly Readonly<{
      choice: PairwiseChoice;
      sequenceInScenario: number;
    }>[];
  }>[];
  scoredAt: string;
  scorer: string;
}>;

export type PairScenario = Readonly<{
  category: string;
  coverageTags: readonly string[];
  description: string;
  scenarioId: string;
  turns: readonly Readonly<{
    responseA: string;
    responseB: string;
    sequenceInScenario: number;
    userInput: SyntheticInput;
  }>[];
  languageVariant: LanguageVariant;
}>;

export type PairwiseSampling = Readonly<{
  eligibleCounts: Readonly<Record<LanguageVariant, number>>;
  protectedCoverage: Readonly<Record<string, string>>;
  quotas: Readonly<Record<LanguageVariant, number>>;
  sampleSeed: number;
  selectedCounts: Readonly<Record<LanguageVariant, number>>;
  strategy: "stratified-random-v1";
}>;

export type PairsFile = Readonly<{
  baselineSource: "synthetic blinded arm A";
  candidateSource: "synthetic blinded arm B";
  excludedScenarios: readonly Readonly<{ id: string; reason: string }>[];
  excludedTurns: readonly Readonly<{
    id: string;
    reason: string;
    sequenceInScenario: number;
  }>[];
  generatedAt: string;
  protocol: typeof F3_PAIRWISE_PROTOCOL;
  sampling: PairwiseSampling;
  scenarios: readonly PairScenario[];
  seed: number;
}>;

export type SealedIdentities = Readonly<{
  armOrder: readonly [string, string];
  generatedAt: string;
  mapping: Readonly<Record<string, Readonly<{ A: string; B: string }>>>;
  protocol: typeof F3_PAIRWISE_PROTOCOL;
  seed: number;
}>;

export type InputSummaryEntry = Readonly<{
  fixtureId: string;
  intentionalDifference: Readonly<{
    keys: readonly string[];
    statement: string;
  }>;
  sharedInput: Readonly<{
    components: Readonly<Record<"conversation" | "events" | "locale" | "memory" | "persona" | "portrait" | "retrieval" | "safety", string>>;
    fingerprint: string;
  }>;
}>;

export type InputSummary = Readonly<{
  catalogVersion: string;
  entries: readonly InputSummaryEntry[];
  group: "continuation" | "bio_naturalness";
  version: "1a3b-f3-input-summary:v1";
}>;

export type ReviewPackage = Readonly<{
  hardGateReport: Readonly<{
    /**
     * Whether the deterministic hard gates applied to this comparison at all.
     * False for the Bio naturalness comparison. It is recorded separately from
     * `passed` so a gate that never ran cannot be read as a gate that passed.
     */
    applicable: boolean;
    checkedFixtureCount: number;
    /**
     * Which arm, or arms, the report covers. A release must be able to tell an
     * AC-X04 report about the conversation it ships from one about a bundle it
     * does not, and the report is otherwise indistinguishable from the other.
     * Stripped before the package reaches a reviewer, so naming the arm cannot
     * reveal which response came from which side.
     */
    configId: string;
    failures: readonly string[];
    passed: boolean;
  }>;
  inputSummary: InputSummary;
  manifestFingerprint: string;
  pairs: PairsFile;
  packageFingerprint: string;
  sealed: SealedIdentities;
  version: typeof F3_REVIEW_PACKAGE_VERSION;
}>;

export type ValidatorAdjudicationLedger = Readonly<{
  /**
   * Prefill marker written by the review-page builder. While it is present the
   * ledger is still a blank form, so the G1 evidence producer refuses it rather
   * than reading unfilled verdicts as a human ruling.
   */
  _instructions?: string;
  adjudicator: string;
  decidedAt: string;
  entries: readonly Readonly<{
    fixtureId: string;
    note?: string;
    verdict: "accepted" | "rejected";
  }>[];
  group: "validator";
  manifestFingerprint: string;
  /**
   * Gate rule (2026-09-12): calibration misses share a 10% error budget;
   * precision false-blocks stay zero-tolerance and are tracked separately.
   * Optional for backwards compatibility; defaults to 0. Tooling refuses a
   * budget above floor(10% of total entries).
   */
  maxRejects?: number;
  capturePath?: string;
  captureSha256?: string;
  version: typeof F3_LEDGER_VERSION | "1a3b-f3-completion:v1";
}>;

export type BioInspectionLedger = Readonly<{
  adjudicator: string;
  configurationId: string;
  decidedAt: string;
  entries: readonly Readonly<{
    fixtureId: string;
    note?: string;
    verdict: "acceptable" | "unacceptable";
  }>[];
  group: "bio_naturalness";
  manifestFingerprint: string;
  reviewPackageFingerprint: string;
  version: typeof F3_BIO_INSPECTION_VERSION;
}>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable JSON used for every reproducibility and artifact fingerprint. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error(`Cannot hash value of type ${typeof value}.`);
}

export function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(values: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  return values
    .map((value, index) => ({ index, key: random(), value }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map(({ value }) => value);
}

export function armAssignment(seed: number, ordinal: number): "A" | "B" {
  return mulberry32(seed + ordinal * 7)() < 0.5 ? "A" : "B";
}

export function countQuestions(text: string): number {
  return [...text].filter((character) => character === "?" || character === "？")
    .length;
}

export function containsToken(text: string, token: string): boolean {
  return text.toLocaleLowerCase().includes(token.toLocaleLowerCase());
}

/** Fingerprint the exact pinned configuration a synthetic adapter claims to have run. */
export function configurationFingerprint(
  pins: F3Pins,
  group: "continuation" | "bio_naturalness",
  configId: string,
): string {
  const selectedConfiguration =
    group === "continuation"
      ? Object.values(pins.continuation.arms).find((arm) => arm.id === configId)
      : pins.bio.configurations.find((configuration) => configuration.id === configId);
  if (!selectedConfiguration) {
    throw new Error(`Unknown ${group} configuration ${configId}.`);
  }
  return sha256({
    configId,
    group,
    roles: pins.roles,
    selectedConfiguration,
    shared: pins.shared,
    validator: pins.validator,
  });
}
