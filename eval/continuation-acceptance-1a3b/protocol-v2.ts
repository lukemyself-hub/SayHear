/**
 * Issue #207 G2 evaluation protocol v2 (causal continuation review).
 *
 * This module is deliberately separate from `protocol.ts`: v1 artifacts and
 * validators stay frozen as failed audit evidence, and nothing here accepts a
 * v1 file. See `docs/plans/issue-207-g2-evaluation-redesign-plan.md`.
 */
import type { BundlePin, F3Pins, LanguageVariant, RolePin } from "./protocol";
import { sha256 } from "./protocol";

export const F3_V2_CATALOG_VERSION = "1a3b-g2-continuation:v2" as const;
export const F3_V2_SCENES_VERSION = "1a3b-g2-scenes:v2" as const;
export const F3_V2_MAIN_RUN_VERSION = "1a3b-g2-main-capture:v2" as const;
export const F3_V2_ARM_RUN_VERSION = "1a3b-g2-arm-run:v2" as const;
export const F3_V2_LEDGER_VERSION = "1a3b-g2-treatment-ledger:v2" as const;
export const F3_V2_VERIFICATION_VERSION =
  "1a3b-g2-treatment-verification:v2" as const;
export const F3_V2_MANIFEST_VERSION = "1a3b-g2-manifest:v2" as const;
export const F3_V2_PACKAGE_VERSION = "1a3b-g2-review-package:v2" as const;
export const F3_V2_EXPRESSION_RUN_VERSION =
  "1a3b-g2-expression-run:v2" as const;
export const F3_V2_EXPRESSION_DECISION_VERSION =
  "1a3b-g2-expression-decision:v2" as const;

export const V2_FAMILIES = [
  "positive_open_loop",
  "positive_memory",
  "stateful_suppression",
  "correct_zero",
  "competing_pool",
] as const;
export type V2Family = (typeof V2_FAMILIES)[number];

export const V2_ZERO_REASONS = [
  "focus_required_by_opportunity",
  "dialogue_state_not_ready",
  "lane_not_readable",
  "no_eligible_target",
  "ordinary_question_present",
] as const;
export type V2ZeroReason = (typeof V2_ZERO_REASONS)[number];

export const V2_DISPOSITION_SIGNALS = [
  "no_stop_signal",
  "short_response",
  "evaded",
  "refused",
  "topic_changed",
] as const;
export type V2DispositionSignal = (typeof V2_DISPOSITION_SIGNALS)[number];

export const V2_PROTECTED_CATEGORIES = [
  "high_risk",
  "refusal",
  "short_answer",
  "topic_change",
  "direct_task",
] as const;
export type V2ProtectedCategory = (typeof V2_PROTECTED_CATEGORIES)[number];

/** A declared target: an extraction-formed loop or a seeded Memory Claim. */
export type V2TargetRef =
  | Readonly<{
      kind: "open_loop";
      /** 0 = the first frozen historical Event; 1..n = scene turn number. */
      sourceTurn: number;
      /** 0-based index among loops formed from that Event. */
      ordinal: number;
    }>
  | Readonly<{ kind: "memory_claim"; memoryId: string }>;

export type V2TurnExpectation = Readonly<{
  /** Disposition expected when this turn settles the previous turn's use. */
  disposition?: Readonly<{
    signal: V2DispositionSignal;
    target: V2TargetRef;
  }>;
  /** Cooldown release expected while reading state on this turn. */
  release?: Readonly<{ target: V2TargetRef; reason: "cooldown_elapsed" }>;
  /** Selection outcome expected on this turn. */
  selection: "segment" | "none";
  /** Required when selection is segment. */
  target?: V2TargetRef;
  /** Required when selection is none. */
  zeroReason?: V2ZeroReason;
  /**
   * Operator-only candidate-level exclusion that must be visible in the
   * selection manifest for this turn.
   */
  excludedTarget?: V2TargetRef;
  excludedReason?: V2CandidateExclusionReason;
  /** The target must be suppressed after this turn's disposition. */
  suppressedAfter?: V2TargetRef;
}>;

export const V2_CANDIDATE_EXCLUSION_REASONS = [
  "target_not_current",
  "candidate_not_eligible",
  "trust_fence",
  "mentioned_in_exchange",
  "formed_in_current_turn",
  "state_version_mismatch",
  "suppressed",
  "invalid_rank_input",
] as const;
export type V2CandidateExclusionReason =
  (typeof V2_CANDIDATE_EXCLUSION_REASONS)[number];

export type V2Turn = Readonly<{
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
  /** This turn's Event stays extraction-pending (incomplete lane control). */
  incompleteLane?: boolean;
  /** Advance the deterministic capture clock by whole days before this turn. */
  clockAdvanceDays?: number;
  expect: V2TurnExpectation;
}>;

export type V2MemorySeed = Readonly<{
  id: string;
  kind: "objective_memory" | "ai_impression";
  text: string;
  /** Registry sensitivity class; v1 production registry has no sensitive rows. */
  sensitive: boolean;
  evidenceIds: readonly string[];
}>;

export type V2PortraitSeed = Readonly<{
  id: string;
  claimId: string;
  kind: "objective_memory" | "ai_impression";
  text: string;
  sensitive: boolean;
}>;

export type V2Scene = Readonly<{
  id: string;
  family: V2Family;
  languageVariant: LanguageVariant;
  locale: string;
  timezone: string;
  /** Topic identity for deterministic diversity checks. */
  topic: string;
  description: string;
  coverageTags: readonly string[];
  protectedCategories: readonly V2ProtectedCategory[];
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
    target: V2TargetRef;
    suppressionReason: V2DispositionSignal;
    suppressedUntilAt: string | null;
  }>[];
  /** Historical User Events extracted before the reviewed turns. */
  historicalEvents: readonly Readonly<{ locale: string; text: string }>[];
  memory: readonly V2MemorySeed[];
  portrait: readonly V2PortraitSeed[];
  /**
   * Operator-only: eligible losing candidates that must be present in the
   * reconstructed pool at the declared segment turn.
   */
  competitors?: readonly V2TargetRef[];
  turns: readonly V2Turn[];
}>;

export type V2SceneFile = Readonly<{
  version: typeof F3_V2_SCENES_VERSION;
  synthetic: true;
  family: V2Family;
  scenes: readonly V2Scene[];
}>;

export type V2CatalogManifest = Readonly<{
  version: typeof F3_V2_CATALOG_VERSION;
  synthetic: true;
  syntheticNotice: string;
  sceneFiles: readonly Readonly<{ path: string; sha256: string }>[];
}>;

export type V2RunTurn = Readonly<{
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

export type V2ArmRun = Readonly<{
  version: typeof F3_V2_ARM_RUN_VERSION;
  format: typeof F3_V2_ARM_RUN_VERSION;
  synthetic: true;
  sourceKind: "synthetic-eval";
  arm: "off" | "on";
  group: "continuation";
  catalogVersion: typeof F3_V2_CATALOG_VERSION;
  configId: string;
  configurationFingerprint: string;
  evaluatorCommit: string;
  scenarios: readonly Readonly<{
    fixtureId: string;
    turns: readonly V2RunTurn[];
  }>[];
}>;

export type V2MainResponse = Readonly<{
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

export type V2MainRun = Readonly<{
  version: typeof F3_V2_MAIN_RUN_VERSION;
  format: typeof F3_V2_MAIN_RUN_VERSION;
  synthetic: true;
  sourceKind: "synthetic-eval";
  group: "continuation";
  catalogVersion: typeof F3_V2_CATALOG_VERSION;
  cleanIncumbentManifestFingerprint: string;
  cleanIncumbentCommit: string;
  conversationConfigId: string;
  conversationConfigurationFingerprint: string;
  evaluatorCommit: string;
  responses: readonly V2MainResponse[];
}>;

/** Per-turn treatment facts. Every field is operator-only evidence. */
export type V2LedgerTurn = Readonly<{
  sequenceInScenario: number;
  userInputFingerprint: string;
  controlledMainResponseFingerprint: string;
  off: Readonly<{
    finalResponseFingerprint: string;
    g2CodePathEntered: false;
  }>;
  on: Readonly<{
    finalResponseFingerprint: string;
    openLoopLane: V2LedgerLane;
    memoryLane: V2LedgerLane;
    candidates: readonly V2LedgerCandidate[];
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
    suppressionStateAfterTurn: readonly V2LedgerState[];
    releaseOutcome: string | null;
    componentVersions: Readonly<Record<string, string>>;
  }>;
}>;

export type V2LedgerLane = Readonly<{
  status: string;
  watermark: Readonly<{
    sourceRevision: number;
    coveredThroughSequence: number;
  }> | null;
  manifestVersion: string;
  integrity: string;
}>;

export type V2LedgerCandidate = Readonly<{
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

export type V2LedgerState = Readonly<{
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

export type V2LedgerScenario = Readonly<{
  fixtureId: string;
  caseKind: "positive" | "stateful" | "correct_zero";
  family: V2Family;
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
    ref: V2TargetRef;
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
  turns: readonly V2LedgerTurn[];
}>;

export type V2TreatmentLedger = Readonly<{
  version: typeof F3_V2_LEDGER_VERSION;
  format: typeof F3_V2_LEDGER_VERSION;
  synthetic: true;
  catalogVersion: typeof F3_V2_CATALOG_VERSION;
  configId: string;
  configurationFingerprint: string;
  evaluatorCommit: string;
  scenarios: readonly V2LedgerScenario[];
}>;

export type V2TreatmentVerification = Readonly<{
  version: typeof F3_V2_VERIFICATION_VERSION;
  format: typeof F3_V2_VERIFICATION_VERSION;
  synthetic: true;
  passed: boolean;
  catalogSha256: string;
  ledgerSha256: string;
  offRunSha256: string;
  onRunSha256: string;
  checkedScenarioCount: number;
  failureCount: number;
  failures: readonly string[];
  eligibleScenarioIds: readonly string[];
}>;

export type V2ExpressionRunScenario = Readonly<{
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

export type V2ExpressionRun = Readonly<{
  version: typeof F3_V2_EXPRESSION_RUN_VERSION;
  format: typeof F3_V2_EXPRESSION_RUN_VERSION;
  synthetic: true;
  sourceKind: "synthetic-eval";
  /** Targets and main responses are frozen from the v2 fixture pool. */
  fixtureCatalogVersion: typeof F3_V2_CATALOG_VERSION;
  configurations: readonly Readonly<{
    configId: string;
    rolePin: Readonly<Record<string, unknown>>;
    fingerprint: string;
  }>[];
  scenarios: readonly V2ExpressionRunScenario[];
}>;

export type V2ExpressionDecision = Readonly<{
  version: typeof F3_V2_EXPRESSION_DECISION_VERSION;
  format: typeof F3_V2_EXPRESSION_DECISION_VERSION;
  synthetic: true;
  expressionRunSha256: string;
  blindProtocol: "blind-pairwise:v2";
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

export type V2ExpressionSelectionManifest = Readonly<{
  version: typeof F3_V2_EXPRESSION_DECISION_VERSION;
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

export function matchesV2TargetRef(
  left: V2TargetRef,
  right: V2TargetRef,
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

/**
 * The v2 pin set. Roles and shared bundles are carried over verbatim from the
 * frozen v1 pins; the continuation arms are the OFF incumbent and the ON
 * candidate, and the expression block records the two DeepSeek expression
 * configurations the blind review decides between.
 */
export type V2Pins = Readonly<{
  version: "1a3b-g2-pins:v2";
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

export function v2ConfigurationFingerprint(
  pins: V2Pins,
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
