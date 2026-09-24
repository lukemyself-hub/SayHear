/**
 * Issue #207 G2 evaluation protocol v5 (causal continuation review).
 *
 * This module is deliberately separate from `protocol.ts`: v1 artifacts and
 * validators stay frozen as failed audit evidence, and nothing here accepts a
 * v1 file. See `docs/plans/issue-207-g2-evaluation-redesign-plan.md`.
 */
import type { BundlePin, F3Pins, LanguageVariant, RolePin } from "./protocol";
import { sha256 } from "./protocol";

export const F3_V5_CATALOG_VERSION = "1a3b-g2-continuation:v5" as const;
export const F3_V5_SCENES_VERSION = "1a3b-g2-scenes:v5" as const;
export const F3_V5_MAIN_RUN_VERSION = "1a3b-g2-main-capture:v5" as const;
export const F3_V5_ARM_RUN_VERSION = "1a3b-g2-arm-run:v5" as const;
export const F3_V5_LEDGER_VERSION = "1a3b-g2-treatment-ledger:v5" as const;
export const F3_V5_VERIFICATION_VERSION =
  "1a3b-g2-treatment-verification:v5" as const;
export const F3_V5_MANIFEST_VERSION = "1a3b-g2-manifest:v5" as const;
export const F3_V5_PACKAGE_VERSION = "1a3b-g2-review-package:v5" as const;
export const F3_V5_EXPRESSION_RUN_VERSION =
  "1a3b-g2-expression-run:v5" as const;
export const F3_V5_EXPRESSION_DECISION_VERSION =
  "1a3b-g2-expression-decision:v5" as const;

export const V5_FAMILIES = [
  "positive_open_loop",
  "positive_memory",
  "stateful_suppression",
  "omission_contract",
  "correct_zero",
  "competing_pool",
] as const;
export type V5Family = (typeof V5_FAMILIES)[number];

export const V5_ZERO_REASONS = [
  "focus_required_by_opportunity",
  "dialogue_state_not_ready",
  "lane_not_readable",
  "no_eligible_target",
  "ordinary_question_present",
] as const;
export type V5ZeroReason = (typeof V5_ZERO_REASONS)[number];

export const V5_DISPOSITION_SIGNALS = [
  "no_stop_signal",
  "short_response",
  "evaded",
  "refused",
  "topic_changed",
] as const;
export type V5DispositionSignal = (typeof V5_DISPOSITION_SIGNALS)[number];

export const V5_PROTECTED_CATEGORIES = [
  "high_risk",
  "refusal",
  "short_answer",
  "topic_change",
  "direct_task",
] as const;
export type V5ProtectedCategory = (typeof V5_PROTECTED_CATEGORIES)[number];

/** A declared target: an extraction-formed loop or a seeded Memory Claim. */
export type V5TargetRef =
  | Readonly<{
      kind: "open_loop";
      /** 0 = the first frozen historical Event; 1..n = scene turn number. */
      sourceTurn: number;
      /** 0-based index among loops formed from that Event. */
      ordinal: number;
    }>
  | Readonly<{ kind: "memory_claim"; memoryId: string }>;

export type V5TurnExpectation = Readonly<{
  /** Disposition expected when this turn settles the previous turn's use. */
  disposition?: Readonly<{
    signal: V5DispositionSignal;
    target: V5TargetRef;
  }>;
  /** Cooldown release expected while reading state on this turn. */
  release?: Readonly<{ target: V5TargetRef; reason: "cooldown_elapsed" }>;
  /** Selection outcome expected on this turn. */
  selection: "segment" | "none";
  /** Required when selection is segment. */
  target?: V5TargetRef;
  /** Required when selection is none. */
  zeroReason?: V5ZeroReason;
  /**
   * Operator-only candidate-level exclusion that must be visible in the
   * selection manifest for this turn.
   */
  excludedTarget?: V5TargetRef;
  excludedReason?: V5CandidateExclusionReason;
  /** The target must be suppressed after this turn's disposition. */
  suppressedAfter?: V5TargetRef;
}>;

export const V5_CANDIDATE_EXCLUSION_REASONS = [
  "target_not_current",
  "candidate_not_eligible",
  "trust_fence",
  "mentioned_in_exchange",
  "formed_in_current_turn",
  "state_version_mismatch",
  "suppressed",
  "invalid_rank_input",
] as const;
export type V5CandidateExclusionReason =
  (typeof V5_CANDIDATE_EXCLUSION_REASONS)[number];

export type V5Turn = Readonly<{
  sequenceInScenario: number;
  userInput: Readonly<{
    locale: string;
    text: string;
    timezone: string;
  }>;
  /**
   * Operator-only: the dialogue focus signal fed to the stage for this turn.
   */
  focusRequired: boolean;
  /** Synthetic, Event-bound DialogueState output for this exact user revision. */
  opportunity:
    | "natural_gap"
    | "greeting"
    | "open_start"
    | "current_topic"
    | "direct_task"
    | "urgent_or_high_risk"
    | null;
  /** This turn's Event stays extraction-pending (incomplete lane control). */
  incompleteLane?: boolean;
  /** Advance the deterministic capture clock by whole days before this turn. */
  clockAdvanceDays?: number;
  /** Operator-declared targets already raised in this Continuous Exchange. */
  mentionedTargets?: readonly V5TargetRef[];
  expect: V5TurnExpectation;
}>;

export type V5MemorySeed = Readonly<{
  id: string;
  kind: "objective_memory" | "ai_impression";
  text: string;
  /** Registry sensitivity class; v1 production registry has no sensitive rows. */
  sensitive: boolean;
  evidenceIds: readonly string[];
}>;

export type V5PortraitSeed = Readonly<{
  id: string;
  claimId: string;
  kind: "objective_memory" | "ai_impression";
  text: string;
  sensitive: boolean;
}>;

export type V5Scene = Readonly<{
  id: string;
  family: V5Family;
  languageVariant: LanguageVariant;
  locale: string;
  timezone: string;
  /** Topic identity for deterministic diversity checks. */
  topic: string;
  description: string;
  /** Reviewer track intent and rationale are operator-only fixture metadata. */
  reviewIntent: "pairwise_candidate" | "omission_audit" | "contract_only";
  rationale: string;
  expectedOmissionReason?:
    | "no_genuine_opportunity"
    | "duplicates_main_response"
    | "insufficient_grounding"
    | "timing_not_natural";
  coverageTags: readonly string[];
  protectedCategories: readonly V5ProtectedCategory[];
  /** Turn-level evidence for every claimed protected slice. */
  protectedTurnSequences?: Readonly<Partial<Record<V5ProtectedCategory, number>>>;
  /** Conservative selection opportunity for this scene. Default natural_gap. */
  opportunity?:
    | "natural_gap"
    | "greeting"
    | "open_start"
    | "current_topic"
    | "direct_task"
    | "urgent_or_high_risk";
  /** Operator-only: force the Memory lane unavailable for this scene. */
  memoryLaneUnavailable?: boolean;
  /**
   * Operator-only: pre-existing suppression state from before the scene
   * (accepted synthetic domain setup, never mid-scene fabrication).
   */
  initialStates?: readonly Readonly<{
    target: V5TargetRef;
    suppressionReason: V5DispositionSignal;
    suppressedUntilAt: string | null;
  }>[];
  /** Historical User Events extracted before the reviewed turns. */
  historicalEvents: readonly Readonly<{ locale: string; text: string }>[];
  memory: readonly V5MemorySeed[];
  portrait: readonly V5PortraitSeed[];
  /**
   * Operator-only: eligible losing candidates that must be present in the
   * reconstructed pool at the declared segment turn.
   */
  competitors?: readonly V5TargetRef[];
  turns: readonly V5Turn[];
}>;

export type V5SceneFile = Readonly<{
  version: typeof F3_V5_SCENES_VERSION;
  synthetic: true;
  family: V5Family;
  scenes: readonly V5Scene[];
}>;

export type V5CatalogManifest = Readonly<{
  version: typeof F3_V5_CATALOG_VERSION;
  synthetic: true;
  purpose: "calibration" | "formal";
  calibrationRound?: 1 | 2;
  /** Frozen positive-sample sizes computed from the independent calibration run. */
  plannedPositiveCounts?: Readonly<Partial<Record<
    "positive_open_loop" | "positive_memory" | "stateful_suppression" | "competing_pool",
    number
  >>>;
  /** All formal records are preregistered into this ordered, at-most-three-batch plan. */
  batches?: readonly Readonly<{ id: string; sceneIds: readonly string[] }>[];
  syntheticNotice: string;
  sceneFiles: readonly Readonly<{ path: string; sha256: string }>[];
}>;

export type V5RunTurn = Readonly<{
  sequenceInScenario: number;
  userInput: Readonly<{
    locale: string;
    text: string;
    timezone: string;
  }>;
  /** Final assistant turn text as committed by that arm. */
  assistantText: string;
  /** Main response before any G2 composition (both arms must match). */
  preCompositionMainText: string;
}>;

export type V5ArmRun = Readonly<{
  version: typeof F3_V5_ARM_RUN_VERSION;
  format: typeof F3_V5_ARM_RUN_VERSION;
  synthetic: true;
  sourceKind: "synthetic-eval";
  arm: "off" | "on";
  group: "continuation";
  catalogVersion: typeof F3_V5_CATALOG_VERSION;
  domainTime: string;
  configId: string;
  configurationFingerprint: string;
  evaluatorCommit: string;
  /** Ordered pre-registered formal batches represented by this run. */
  executedBatchIds: readonly string[];
  scenarios: readonly Readonly<{
    fixtureId: string;
    turns: readonly V5RunTurn[];
  }>[];
}>;

export type V5MainResponse = Readonly<{
  fixtureId: string;
  sequenceInScenario: number;
  userInputFingerprint: string;
  text: string;
  /** Provider evidence: role pins used to produce this response. */
  provider: string;
  model: string;
  modelSnapshot: string;
  promptFingerprint: string;
}>;

export type V5MainRun = Readonly<{
  version: typeof F3_V5_MAIN_RUN_VERSION;
  format: typeof F3_V5_MAIN_RUN_VERSION;
  synthetic: true;
  sourceKind: "synthetic-eval";
  group: "continuation";
  catalogVersion: typeof F3_V5_CATALOG_VERSION;
  domainTime: string;
  cleanIncumbentManifestFingerprint: string;
  cleanIncumbentCommit: string;
  conversationConfigId: string;
  conversationConfigurationFingerprint: string;
  evaluatorCommit: string;
  /** Ordered pre-registered formal batches represented by this run. */
  executedBatchIds: readonly string[];
  responses: readonly V5MainResponse[];
}>;

/** Per-turn treatment facts. Every field is operator-only evidence. */
export type V5LedgerTurn = Readonly<{
  sequenceInScenario: number;
  userInputFingerprint: string;
  controlledMainResponseFingerprint: string;
  off: Readonly<{
    finalResponseFingerprint: string;
    g2CodePathEntered: false;
  }>;
  on: Readonly<{
    finalResponseFingerprint: string;
    openLoopLane: V5LedgerLane;
    memoryLane: V5LedgerLane;
    candidates: readonly V5LedgerCandidate[];
    selectionManifestVersion: string | null;
    selectionOutcome: "selected" | "none" | "not_reached";
    selectionReason: string | null;
    selectedTargetRef: string | null;
    ordinaryQuestionCount: number | null;
    reservationOutcome: string | null;
    segmentCommandId: string | null;
    segmentProviderCallCount: number;
    dispositionProviderCallCount: number;
    segmentOutcome: "committed" | "omitted" | "failed" | "not_reached";
    segmentText: string | null;
    segmentOmitReason:
      | "no_genuine_opportunity"
      | "duplicates_main_response"
      | "insufficient_grounding"
      | "timing_not_natural"
      | null;
    segmentFingerprint: string | null;
    preDisplayOutcome: string | null;
    typedUseOutcome: string | null;
    dispositionOutcome: string | null;
    suppressionStateAfterTurn: readonly V5LedgerState[];
    releaseOutcome: string | null;
    componentVersions: Readonly<Record<string, string>>;
  }>;
}>;

export type V5LedgerLane = Readonly<{
  status: string;
  watermark: Readonly<{
    sourceRevision: number;
    coveredThroughSequence: number;
  }> | null;
  manifestVersion: string;
  integrity: string;
}>;

export type V5LedgerCandidate = Readonly<{
  targetRef: string;
  lane: string;
  rankTuple: readonly (string | number | null)[] | null;
  current: boolean;
  eligible: boolean;
  sensitive: boolean;
  trustFence: string;
  stateVersion: string | null;
  suppressionReason: string | null;
  suppressedUntilAt: string | null;
  lastUsedAt: string | null;
  formedInCurrentTurn: boolean;
  mentionedInExchange: boolean;
  exclusionReason: string | null;
}>;

export type V5LedgerState = Readonly<{
  targetKind: string;
  targetId: string;
  targetVersionId: string;
  eligibilityStatus: string;
  suppressionReason: string | null;
  consecutiveSoftStopCount: number;
  suppressedUntilAt: string | null;
  lastUsedAt: string;
  releaseReason: string | null;
}>;

export type V5LedgerScenario = Readonly<{
  fixtureId: string;
  caseKind: "positive" | "stateful" | "omission_audit" | "correct_zero";
  family: V5Family;
  expectedTreatment: string;
  cleanIncumbentManifestFingerprint: string;
  cleanIncumbentCommit: string;
  openLoopExtractAttempts: number;
  openLoopProposalCount: number;
  openLoopAcceptedCount: number;
  openLoopSkipped: readonly string[];
  /** Every loop formed in the scene, with the operator ref it maps to. */
  formedTargetRefs: readonly Readonly<{
    targetId: string;
    ref: V5TargetRef;
  }>[];
  /** Formation schedules, kept for schedule/expiry diagnostics. */
  formedLoopSchedules: readonly Readonly<{
    targetId: string;
    kind: string;
    expectedStartAt: string | null;
    followupEligibleFromAt: string;
    expiresAt: string;
    closed: boolean;
    sourceEventRevisionId: string;
  }>[];
  turns: readonly V5LedgerTurn[];
}>;

export type V5TreatmentLedger = Readonly<{
  version: typeof F3_V5_LEDGER_VERSION;
  format: typeof F3_V5_LEDGER_VERSION;
  synthetic: true;
  catalogVersion: typeof F3_V5_CATALOG_VERSION;
  domainTime: string;
  configId: string;
  configurationFingerprint: string;
  evaluatorCommit: string;
  /** Ordered pre-registered formal batches represented by this ledger. */
  executedBatchIds: readonly string[];
  scenarios: readonly V5LedgerScenario[];
}>;

export type V5BatchMergeManifest = Readonly<{
  version: "1a3b-g2-batch-merge:v5";
  executedBatchIds: readonly string[];
  batches: readonly Readonly<{
    id: string;
    main: Readonly<{ path: string; rawSha256: string; canonicalJsonSha256: string }>;
    off: Readonly<{ path: string; rawSha256: string; canonicalJsonSha256: string }>;
    on: Readonly<{ path: string; rawSha256: string; canonicalJsonSha256: string }>;
    ledger: Readonly<{ path: string; rawSha256: string; canonicalJsonSha256: string }>;
  }>[];
  manifestSha256: string;
}>;

export type V5TreatmentVerification = Readonly<{
  version: typeof F3_V5_VERIFICATION_VERSION;
  format: typeof F3_V5_VERIFICATION_VERSION;
  synthetic: true;
  passed: boolean;
  reviewReady: boolean;
  sampleReady: boolean;
  executedBatchIds: readonly string[];
  pendingSampleQuotas: readonly string[];
  catalogSha256: string;
  ledgerSha256: string;
  offRunSha256: string;
  onRunSha256: string;
  checkedScenarioCount: number;
  failureCount: number;
  failures: readonly string[];
  eligibleScenarioIds: readonly string[];
  actualEmitScenarioIds: readonly string[];
  actualOmissionAuditScenarioIds: readonly string[];
  predeclaredOpportunityTurnIds: readonly string[];
  committedOpportunityTurnIds: readonly string[];
  recall: Readonly<{ numerator: number; denominator: number; ratio: number }>;
  recallFunnel: Readonly<{
    predeclaredPositiveTurns: number;
    mainOrdinaryQuestionSkips: number;
    nonQuestionStageSkips: number;
    incompleteOpportunityViews: number;
    executableOpportunities: number;
    expectedEligibleSelections: number;
    providerCalls: number;
    committedEmits: number;
    typedOmits: number;
    failures: number;
    notReached: number;
  }>;
  inputFingerprints: readonly Readonly<{
    path: string;
    rawSha256: string;
    canonicalJsonSha256: string;
  }>[];
}>;

export type V5ExpressionRunScenario = Readonly<{
  inputId: string;
  locale: string;
  targetKind: "open_loop" | "memory_claim";
  targetSummary: string;
  targetSensitive: boolean;
  opportunity: "natural_gap" | "greeting" | "open_start" | "current_topic";
  mainText: string;
  configs: readonly Readonly<{
    configId: string;
    content: string;
    expressionKind: "question" | "acknowledgment";
    provider: string;
    model: string;
    modelSnapshot: string;
    promptVersion: string;
    schemaVersion: string;
    fingerprint: string;
  }>[];
}>;

export type V5ExpressionRun = Readonly<{
  version: typeof F3_V5_EXPRESSION_RUN_VERSION;
  format: typeof F3_V5_EXPRESSION_RUN_VERSION;
  synthetic: true;
  sourceKind: "synthetic-eval";
  /** Targets and main responses are frozen from the v5 fixture pool. */
  fixtureCatalogVersion: typeof F3_V5_CATALOG_VERSION;
  configurations: readonly Readonly<{
    configId: string;
    rolePin: Readonly<Record<string, unknown>>;
    fingerprint: string;
  }>[];
  scenarios: readonly V5ExpressionRunScenario[];
}>;

export type V5ExpressionDecision = Readonly<{
  version: typeof F3_V5_EXPRESSION_DECISION_VERSION;
  format: typeof F3_V5_EXPRESSION_DECISION_VERSION;
  synthetic: true;
  expressionRunSha256: string;
  blindProtocol: "blind-pairwise:g2-v5";
  scorer: string;
  decidedAt: string;
  winnerConfigId: string;
  scores: Readonly<{
    scenarioId: string;
    overallChoice: "A" | "B" | "tie";
    turns: readonly Readonly<{
      sequenceInScenario: number;
      choice: "A" | "B" | "tie";
    }>[];
  }>[];
  assignment: readonly Readonly<{
    inputId: string;
    a: string;
    b: string;
  }>[];
}>;

export type V5ExpressionSelectionManifest = Readonly<{
  version: typeof F3_V5_EXPRESSION_DECISION_VERSION;
  expressionRunSha256: string | null;
  winnerConfigId: string;
  winnerRolePinSha256: string;
  decisionSha256: string;
  authorizationSha256?: string;
  decision?: Readonly<{
    kind: string;
    decidedAt: string;
    reason: string;
  }>;
  /**
   * ADR-0136 bounded exception: records the human approval that defers the
   * two-configuration comparison instead of pointing at a comparison run.
   */
  waiver?: Readonly<{
    approvedBy: string;
    approvedAt: string;
    reason: string;
    adrAmendment: string;
  }>;
}>;

export function matchesV5TargetRef(
  left: V5TargetRef,
  right: V5TargetRef,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "memory_claim" && right.kind === "memory_claim") {
    return left.memoryId === right.memoryId;
  }
  if (left.kind === "open_loop" && right.kind === "open_loop") {
    return (
      left.sourceTurn === right.sourceTurn && left.ordinal === right.ordinal
    );
  }
  return false;
}

export function v5RecordsMatchExactSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length ||
      new Set(expected).size !== expected.length) return false;
  const actualSet = new Set(actual);
  return expected.every((entry) => actualSet.has(entry));
}

export function v5TargetWasMentioned(
  turns: readonly V5Turn[],
  currentSequence: number,
  target: V5TargetRef,
): boolean {
  return turns.some(
    (turn) =>
      turn.sequenceInScenario <= currentSequence &&
      (turn.mentionedTargets ?? []).some((mentioned) =>
        matchesV5TargetRef(mentioned, target),
      ),
  );
}

/**
 * The v5 pin set. Roles and shared bundles are carried over verbatim from the
 * frozen v1 pins; the continuation arms are the OFF incumbent and the ON
 * candidate, and the expression block records the two DeepSeek expression
 * single verified expression configuration selected under the bounded G2
 * exception; any later competing pin restores full comparison requirements.
 */
export type V5Pins = Readonly<{
  version: "1a3b-g2-pins:v5";
  syntheticOnly: true;
  shared: F3Pins["shared"];
  roles: F3Pins["roles"];
  continuation: Readonly<{
    allowedDifferenceKeys: readonly string[];
    arms: Readonly<{
      off: Readonly<{ id: string; openLoop: BundlePin; proactive: BundlePin }>;
      on: Readonly<{ id: string; openLoop: BundlePin; proactive: BundlePin }>;
    }>;
  }>;
  expression: Readonly<{
    selectedConfigId: string | null;
    configurations: readonly Readonly<{ id: string; pin: RolePin }>[];
  }>;
  validator: F3Pins["validator"];
}>;

export function v5ConfigurationFingerprint(
  pins: V5Pins,
  configId: string,
): string {
  const selectedConfiguration = Object.values(pins.continuation.arms).find(
    (arm) => arm.id === configId,
  );
  if (!selectedConfiguration) {
    throw new Error(`Unknown continuation configuration ${configId}.`);
  }
  return sha256({
    configId,
    expression: pins.expression,
    group: "continuation",
    roles: pins.roles,
    selectedConfiguration,
    shared: pins.shared,
    validator: pins.validator,
  });
}
