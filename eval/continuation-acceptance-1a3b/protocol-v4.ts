/**
 * Issue #207 G2 evaluation protocol v4 (causal continuation review).
 *
 * This module is deliberately separate from `protocol.ts`: v1 artifacts and
 * validators stay frozen as failed audit evidence, and nothing here accepts a
 * v1 file. See `docs/plans/issue-207-g2-evaluation-redesign-plan.md`.
 */
import type { BundlePin, F3Pins, LanguageVariant, RolePin } from "./protocol";
import { sha256 } from "./protocol";

export const F3_V4_CATALOG_VERSION = "1a3b-g2-continuation:v4" as const;
export const F3_V4_SCENES_VERSION = "1a3b-g2-scenes:v4" as const;
export const F3_V4_MAIN_RUN_VERSION = "1a3b-g2-main-capture:v4" as const;
export const F3_V4_ARM_RUN_VERSION = "1a3b-g2-arm-run:v4" as const;
export const F3_V4_LEDGER_VERSION = "1a3b-g2-treatment-ledger:v4" as const;
export const F3_V4_VERIFICATION_VERSION =
  "1a3b-g2-treatment-verification:v4" as const;
export const F3_V4_MANIFEST_VERSION = "1a3b-g2-manifest:v4" as const;
export const F3_V4_PACKAGE_VERSION = "1a3b-g2-review-package:v4" as const;
export const F3_V4_EXPRESSION_RUN_VERSION =
  "1a3b-g2-expression-run:v4" as const;
export const F3_V4_EXPRESSION_DECISION_VERSION =
  "1a3b-g2-expression-decision:v4" as const;

export const V4_FAMILIES = [
  "positive_open_loop",
  "positive_memory",
  "stateful_suppression",
  "omission_contract",
  "correct_zero",
  "competing_pool",
] as const;
export type V4Family = (typeof V4_FAMILIES)[number];

export const V4_ZERO_REASONS = [
  "focus_required_by_opportunity",
  "dialogue_state_not_ready",
  "lane_not_readable",
  "no_eligible_target",
  "ordinary_question_present",
] as const;
export type V4ZeroReason = (typeof V4_ZERO_REASONS)[number];

export const V4_DISPOSITION_SIGNALS = [
  "no_stop_signal",
  "short_response",
  "evaded",
  "refused",
  "topic_changed",
] as const;
export type V4DispositionSignal = (typeof V4_DISPOSITION_SIGNALS)[number];

export const V4_PROTECTED_CATEGORIES = [
  "high_risk",
  "refusal",
  "short_answer",
  "topic_change",
  "direct_task",
] as const;
export type V4ProtectedCategory = (typeof V4_PROTECTED_CATEGORIES)[number];

/** A declared target: an extraction-formed loop or a seeded Memory Claim. */
export type V4TargetRef =
  | Readonly<{
      kind: "open_loop";
      /** 0 = the first frozen historical Event; 1..n = scene turn number. */
      sourceTurn: number;
      /** 0-based index among loops formed from that Event. */
      ordinal: number;
    }>
  | Readonly<{ kind: "memory_claim"; memoryId: string }>;

export type V4TurnExpectation = Readonly<{
  /** Disposition expected when this turn settles the previous turn's use. */
  disposition?: Readonly<{
    signal: V4DispositionSignal;
    target: V4TargetRef;
  }>;
  /** Cooldown release expected while reading state on this turn. */
  release?: Readonly<{ target: V4TargetRef; reason: "cooldown_elapsed" }>;
  /** Selection outcome expected on this turn. */
  selection: "segment" | "none";
  /** Required when selection is segment. */
  target?: V4TargetRef;
  /** Required when selection is none. */
  zeroReason?: V4ZeroReason;
  /**
   * Operator-only candidate-level exclusion that must be visible in the
   * selection manifest for this turn.
   */
  excludedTarget?: V4TargetRef;
  excludedReason?: V4CandidateExclusionReason;
  /** The target must be suppressed after this turn's disposition. */
  suppressedAfter?: V4TargetRef;
}>;

export const V4_CANDIDATE_EXCLUSION_REASONS = [
  "target_not_current",
  "candidate_not_eligible",
  "trust_fence",
  "mentioned_in_exchange",
  "formed_in_current_turn",
  "state_version_mismatch",
  "suppressed",
  "invalid_rank_input",
] as const;
export type V4CandidateExclusionReason =
  (typeof V4_CANDIDATE_EXCLUSION_REASONS)[number];

export type V4Turn = Readonly<{
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
  mentionedTargets?: readonly V4TargetRef[];
  expect: V4TurnExpectation;
}>;

export type V4MemorySeed = Readonly<{
  id: string;
  kind: "objective_memory" | "ai_impression";
  text: string;
  /** Registry sensitivity class; v1 production registry has no sensitive rows. */
  sensitive: boolean;
  evidenceIds: readonly string[];
}>;

export type V4PortraitSeed = Readonly<{
  id: string;
  claimId: string;
  kind: "objective_memory" | "ai_impression";
  text: string;
  sensitive: boolean;
}>;

export type V4Scene = Readonly<{
  id: string;
  family: V4Family;
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
  protectedCategories: readonly V4ProtectedCategory[];
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
    target: V4TargetRef;
    suppressionReason: V4DispositionSignal;
    suppressedUntilAt: string | null;
  }>[];
  /** Historical User Events extracted before the reviewed turns. */
  historicalEvents: readonly Readonly<{ locale: string; text: string }>[];
  memory: readonly V4MemorySeed[];
  portrait: readonly V4PortraitSeed[];
  /**
   * Operator-only: eligible losing candidates that must be present in the
   * reconstructed pool at the declared segment turn.
   */
  competitors?: readonly V4TargetRef[];
  turns: readonly V4Turn[];
}>;

export type V4SceneFile = Readonly<{
  version: typeof F3_V4_SCENES_VERSION;
  synthetic: true;
  family: V4Family;
  scenes: readonly V4Scene[];
}>;

export type V4CatalogManifest = Readonly<{
  version: typeof F3_V4_CATALOG_VERSION;
  synthetic: true;
  syntheticNotice: string;
  sceneFiles: readonly Readonly<{ path: string; sha256: string }>[];
}>;

export type V4RunTurn = Readonly<{
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

export type V4ArmRun = Readonly<{
  version: typeof F3_V4_ARM_RUN_VERSION;
  format: typeof F3_V4_ARM_RUN_VERSION;
  synthetic: true;
  sourceKind: "synthetic-eval";
  arm: "off" | "on";
  group: "continuation";
  catalogVersion: typeof F3_V4_CATALOG_VERSION;
  domainTime: string;
  configId: string;
  configurationFingerprint: string;
  evaluatorCommit: string;
  scenarios: readonly Readonly<{
    fixtureId: string;
    turns: readonly V4RunTurn[];
  }>[];
}>;

export type V4MainResponse = Readonly<{
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

export type V4MainRun = Readonly<{
  version: typeof F3_V4_MAIN_RUN_VERSION;
  format: typeof F3_V4_MAIN_RUN_VERSION;
  synthetic: true;
  sourceKind: "synthetic-eval";
  group: "continuation";
  catalogVersion: typeof F3_V4_CATALOG_VERSION;
  domainTime: string;
  cleanIncumbentManifestFingerprint: string;
  cleanIncumbentCommit: string;
  conversationConfigId: string;
  conversationConfigurationFingerprint: string;
  evaluatorCommit: string;
  responses: readonly V4MainResponse[];
}>;

/** Per-turn treatment facts. Every field is operator-only evidence. */
export type V4LedgerTurn = Readonly<{
  sequenceInScenario: number;
  userInputFingerprint: string;
  controlledMainResponseFingerprint: string;
  off: Readonly<{
    finalResponseFingerprint: string;
    g2CodePathEntered: false;
  }>;
  on: Readonly<{
    finalResponseFingerprint: string;
    openLoopLane: V4LedgerLane;
    memoryLane: V4LedgerLane;
    candidates: readonly V4LedgerCandidate[];
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
    suppressionStateAfterTurn: readonly V4LedgerState[];
    releaseOutcome: string | null;
    componentVersions: Readonly<Record<string, string>>;
  }>;
}>;

export type V4LedgerLane = Readonly<{
  status: string;
  watermark: Readonly<{
    sourceRevision: number;
    coveredThroughSequence: number;
  }> | null;
  manifestVersion: string;
  integrity: string;
}>;

export type V4LedgerCandidate = Readonly<{
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

export type V4LedgerState = Readonly<{
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

export type V4LedgerScenario = Readonly<{
  fixtureId: string;
  caseKind: "positive" | "stateful" | "omission_audit" | "correct_zero";
  family: V4Family;
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
    ref: V4TargetRef;
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
  turns: readonly V4LedgerTurn[];
}>;

export type V4TreatmentLedger = Readonly<{
  version: typeof F3_V4_LEDGER_VERSION;
  format: typeof F3_V4_LEDGER_VERSION;
  synthetic: true;
  catalogVersion: typeof F3_V4_CATALOG_VERSION;
  domainTime: string;
  configId: string;
  configurationFingerprint: string;
  evaluatorCommit: string;
  scenarios: readonly V4LedgerScenario[];
}>;

export type V4TreatmentVerification = Readonly<{
  version: typeof F3_V4_VERIFICATION_VERSION;
  format: typeof F3_V4_VERIFICATION_VERSION;
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
  actualEmitScenarioIds: readonly string[];
  actualOmissionAuditScenarioIds: readonly string[];
  inputFingerprints: readonly Readonly<{
    path: string;
    rawSha256: string;
    canonicalJsonSha256: string;
  }>[];
}>;

export type V4ExpressionRunScenario = Readonly<{
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

export type V4ExpressionRun = Readonly<{
  version: typeof F3_V4_EXPRESSION_RUN_VERSION;
  format: typeof F3_V4_EXPRESSION_RUN_VERSION;
  synthetic: true;
  sourceKind: "synthetic-eval";
  /** Targets and main responses are frozen from the v4 fixture pool. */
  fixtureCatalogVersion: typeof F3_V4_CATALOG_VERSION;
  configurations: readonly Readonly<{
    configId: string;
    rolePin: Readonly<Record<string, unknown>>;
    fingerprint: string;
  }>[];
  scenarios: readonly V4ExpressionRunScenario[];
}>;

export type V4ExpressionDecision = Readonly<{
  version: typeof F3_V4_EXPRESSION_DECISION_VERSION;
  format: typeof F3_V4_EXPRESSION_DECISION_VERSION;
  synthetic: true;
  expressionRunSha256: string;
  blindProtocol: "blind-pairwise:g2-v4";
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

export type V4ExpressionSelectionManifest = Readonly<{
  version: typeof F3_V4_EXPRESSION_DECISION_VERSION;
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

export function matchesV4TargetRef(
  left: V4TargetRef,
  right: V4TargetRef,
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

export function v4TargetWasMentioned(
  turns: readonly V4Turn[],
  currentSequence: number,
  target: V4TargetRef,
): boolean {
  return turns.some(
    (turn) =>
      turn.sequenceInScenario <= currentSequence &&
      (turn.mentionedTargets ?? []).some((mentioned) =>
        matchesV4TargetRef(mentioned, target),
      ),
  );
}

/**
 * The v4 pin set. Roles and shared bundles are carried over verbatim from the
 * frozen v1 pins; the continuation arms are the OFF incumbent and the ON
 * candidate, and the expression block records the two DeepSeek expression
 * single verified expression configuration selected under the bounded G2
 * exception; any later competing pin restores full comparison requirements.
 */
export type V4Pins = Readonly<{
  version: "1a3b-g2-pins:v4";
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

export function v4ConfigurationFingerprint(
  pins: V4Pins,
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
