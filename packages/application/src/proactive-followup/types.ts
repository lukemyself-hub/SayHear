/**
 * C2's deterministic contract (SPEC #193 §7, ADR-0043/0044).
 *
 * The selector receives already selected, trust-fenced lanes. It never scans
 * all Memory, creates a message, or asks a model to rank candidates. Durable
 * data below is intentionally an owner-scoped lineage envelope: no user or
 * Assistant text is copied into a manifest, use, or disposition.
 */

export const PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION =
  "proactive-followup-selection:v1" as const;
export const PROACTIVE_FOLLOWUP_SUPPRESSION_POLICY_VERSION =
  "proactive-followup-suppression:v1" as const;
export const PROACTIVE_FOLLOWUP_COMMIT_POLICY_VERSION =
  "proactive-followup-commit:v1" as const;
export const PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION =
  "proactive-followup-policy-bundle:v7" as const;
export const PROACTIVE_FOLLOWUP_OPPORTUNITY_POLICY_VERSION =
  "proactive-followup-opportunity:v2" as const;
export const PROACTIVE_FOLLOWUP_USE_SCHEMA_VERSION =
  "proactive-followup-use:v1" as const;
export const PROACTIVE_FOLLOWUP_EXPRESSION_PROMPT_VERSION =
  "proactive-followup-prompt:v6" as const;
export const PROACTIVE_FOLLOWUP_EXPRESSION_POLICY_VERSION =
  "proactive-followup-expression:v4" as const;
export const PROACTIVE_FOLLOWUP_REASON_CODE_SCHEMA_VERSION =
  "proactive-followup-reason-codes:v2" as const;
export const PROACTIVE_FOLLOWUP_MANIFEST_VERSION =
  "proactive-followup-selection-manifest:v2" as const;
export const PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION =
  "open-loop-read:v2" as const;
export const PROACTIVE_FOLLOWUP_MEMORY_LANE_MANIFEST_VERSIONS = [
  "memory-retrieval:v1",
  "person-portrait:v1",
] as const;

/** Mechanical confidence floor; changing it requires a new policy version. */
export const PROACTIVE_FOLLOWUP_DIALOGUE_CONFIDENCE_FLOOR = 0.7;
export const PROACTIVE_FOLLOWUP_MAX_CANDIDATES = 32;

export const PROACTIVE_FOLLOWUP_TARGET_KINDS = [
  "open_loop",
  "memory_claim",
] as const;
export type ProactiveFollowupTargetKind =
  (typeof PROACTIVE_FOLLOWUP_TARGET_KINDS)[number];

export const PROACTIVE_FOLLOWUP_OPPORTUNITY_KINDS = [
  "greeting",
  "open_start",
  "natural_gap",
  "current_topic",
  "direct_task",
  "urgent_or_high_risk",
] as const;
export type ProactiveFollowupOpportunityKind =
  (typeof PROACTIVE_FOLLOWUP_OPPORTUNITY_KINDS)[number];

export const PROACTIVE_FOLLOWUP_STOP_SIGNALS = [
  "no_stop_signal",
  "short_response",
  "evaded",
  "refused",
  "topic_changed",
  "ambiguous_closure",
] as const;
export type ProactiveFollowupStopSignal =
  (typeof PROACTIVE_FOLLOWUP_STOP_SIGNALS)[number];

export const PROACTIVE_FOLLOWUP_SUPPRESSION_REASONS = [
  "short_response",
  "evaded",
  "topic_changed",
  "refused",
  "ambiguous_closure",
] as const;
export type ProactiveFollowupSuppressionReason =
  (typeof PROACTIVE_FOLLOWUP_SUPPRESSION_REASONS)[number];

export const PROACTIVE_FOLLOWUP_RELEASE_REASONS = [
  "cooldown_elapsed",
  "user_reopened",
  "new_direct_evidence",
  "target_specific_permission",
  "target_terminal_or_expired",
] as const;
export type ProactiveFollowupReleaseReason =
  (typeof PROACTIVE_FOLLOWUP_RELEASE_REASONS)[number];

export type ProactiveFollowupTextLocator = Readonly<{
  kind: "assistant_event_revision";
  assistantEventRevisionId: string;
  segment: "proactive_followup";
  ordinal: 0;
}>;

export type ProactiveFollowupCandidate = Readonly<{
  targetKind: ProactiveFollowupTargetKind;
  targetId: string;
  targetVersionId: string;
  source: "open_loop" | "person_portrait" | "query_retrieval";
  /** Existing lane order; it is not a salience score. */
  sourceRank: number | null;
  /** Open Loop schedule/evidence time, or Memory evidence time. */
  evidenceAt: string;
  /** Open Loop's frozen expected time anchor, when present. */
  expectedStartAt?: string | null;
  expectedEndAt?: string | null;
  expectedTimePrecision?: string | null;
  expectedTimeZone?: string | null;
  /** Direct source Event lineage, supplied only by the Open Loop lane. */
  sourceEventRevisionId?: string;
  openLoopKind?: "upcoming_event" | "awaited_outcome" | null;
  /** Open Loop's frozen finite expiry. */
  expiresAt?: string | null;
  subjectRole?: "user" | "other" | "unknown";
  /** Existing retrieval fence codes, when the upstream lane can provide them. */
  trustFenceResults?: readonly string[];
  sensitive: boolean;
  lastUsedAt: string | null;
  current: boolean;
  eligible: boolean;
  trustFence: "valid" | "invalid";
  mentionedInExchange: boolean;
  formedInCurrentTurn: boolean;
}>;

export type ProactiveFollowupLaneSnapshot = Readonly<{
  name: "open_loop" | "memory";
  enabled: boolean;
  status: "complete" | "incomplete" | "unavailable";
  /** A missing, stale, or invalid watermark makes the enabled lane unreadable. */
  watermark: Readonly<{
    sourceRevision: number;
    coveredThroughSequence: number;
  }> | null;
  manifestVersion: string;
  integrity: "valid" | "invalid";
  candidates: readonly ProactiveFollowupCandidate[];
}>;

export type ProactiveFollowupDialogueSnapshot = Readonly<{
  status: "current" | "lagging";
  coveredThroughSequence: number;
  currentEventSequence: number;
  currentEventRevisionId: string;
  currentRequestRequiresFocus: Readonly<{
    value: boolean | null;
    confidence: number;
    sourceRevisionIds: readonly string[];
  }>;
  proactiveFollowupOpportunity?: Readonly<{
    value: ProactiveFollowupOpportunityKind | null;
    confidence: number;
    sourceRevisionIds: readonly string[];
  }>;
}>;

export type ProactiveFollowupStateSnapshot = Readonly<{
  stateId: string;
  stateVersionId: string;
  targetKind: ProactiveFollowupTargetKind;
  targetId: string;
  targetVersionId: string;
  eligibilityStatus: "eligible" | "suppressed";
  suppressionReason: ProactiveFollowupSuppressionReason | null;
  consecutiveSoftStopCount: number;
  suppressedUntilAt: string | null;
  lastPromptEventRevisionId: string | null;
  lastResponseEventRevisionId: string | null;
  lastUsedAt: string | null;
  releaseReason: ProactiveFollowupReleaseReason | null;
}>;

export type ProactiveFollowupSelectionInput = Readonly<{
  userId: string;
  dailySessionId: string;
  continuousExchangeNo: number;
  currentUserEventRevisionId: string;
  currentUserEventSequence: number;
  currentSourceRevision: number;
  opportunity: ProactiveFollowupOpportunityKind | null;
  ordinaryQuestionAlreadyAsked: boolean;
  dialogue: ProactiveFollowupDialogueSnapshot;
  lanes: readonly ProactiveFollowupLaneSnapshot[];
  states: readonly ProactiveFollowupStateSnapshot[];
  now: Date;
}>;

export type ProactiveFollowupRankTuple = readonly [
  /** non-sensitive first */
  sensitivity: 0 | 1,
  /** opportunity-specific lane precedence */
  lane: 0 | 1,
  /** Existing lane order or the Open Loop time-first profile. */
  withinLane: string,
  /** never-used first */
  usage: 0 | 1,
  /** least recently used; ISO epoch sentinel means never used */
  lastUsedAt: string,
  /** newest evidence first after the preceding deterministic keys */
  evidenceAt: string,
  /** final stable tie-breaker */
  stableId: string,
];

export type ProactiveFollowupManifestCandidate = Readonly<{
  targetKind: ProactiveFollowupTargetKind;
  targetId: string;
  targetVersionId: string;
  sensitivity: 0 | 1;
  sourceLane: ProactiveFollowupCandidate["source"];
  sourceRank: number | null;
  trustFenceResults: readonly string[];
  mentionedInExchange: boolean;
  formedFromCurrentEvent: boolean;
  eligibilityReason: "never_suppressed" | "eligible" | "suppressed" | "excluded";
  rankTuple: ProactiveFollowupRankTuple | null;
  stateVersionId: string | null;
  suppressionReason: ProactiveFollowupSuppressionReason | null;
  consecutiveSoftStopCount: number;
  suppressedUntilAt: string | null;
  lastUseAt: string | null;
  eligible: boolean;
  selectionReasonCodes: readonly string[];
  rejectionReasonCodes: readonly string[];
  exclusionReason: string | null;
}>;

export type ProactiveFollowupSelectionManifest = Readonly<{
  manifestVersion: typeof PROACTIVE_FOLLOWUP_MANIFEST_VERSION;
  policyBundleVersion: typeof PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION;
  opportunityPolicyVersion: typeof PROACTIVE_FOLLOWUP_OPPORTUNITY_POLICY_VERSION;
  selectionPolicyVersion: typeof PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION;
  suppressionPolicyVersion: typeof PROACTIVE_FOLLOWUP_SUPPRESSION_POLICY_VERSION;
  useSchemaVersion: typeof PROACTIVE_FOLLOWUP_USE_SCHEMA_VERSION;
  expressionPromptVersion: typeof PROACTIVE_FOLLOWUP_EXPRESSION_PROMPT_VERSION;
  expressionPolicyVersion: typeof PROACTIVE_FOLLOWUP_EXPRESSION_POLICY_VERSION;
  reasonCodeSchemaVersion: typeof PROACTIVE_FOLLOWUP_REASON_CODE_SCHEMA_VERSION;
  userId: string;
  dailySessionId: string;
  continuousExchangeNo: number;
  currentUserEventRevisionId: string;
  currentUserEventSequence: number;
  currentSourceRevision: number;
  opportunity: ProactiveFollowupOpportunityKind | null;
  opportunityMode: ProactiveFollowupOpportunityKind | null;
  proactiveFollowupOpportunity: Readonly<{
    value: ProactiveFollowupOpportunityKind | null;
    confidence: number;
    sourceRevisionIds: readonly string[];
    freshness: "current" | "stale";
  }>;
  currentRequestRequiresFocus: Readonly<{
    value: boolean | null;
    confidence: number;
    sourceRevisionIds: readonly string[];
    freshness: "current" | "stale";
  }>;
  opportunityGateResults: readonly Readonly<{
    gate: string;
    passed: boolean;
    reason: string | null;
  }>[];
  decision: "selected" | "none";
  reason: string;
  lanes: readonly Readonly<{
    name: ProactiveFollowupLaneSnapshot["name"];
    enabled: boolean;
    status: ProactiveFollowupLaneSnapshot["status"];
    watermark: ProactiveFollowupLaneSnapshot["watermark"];
    completeness: ProactiveFollowupLaneSnapshot["status"];
    timingMs: number | null;
    degradedReason: string | null;
    manifestVersion: string;
    integrity: ProactiveFollowupLaneSnapshot["integrity"];
    candidateCount: number;
  }>[];
  laneWatermarks: readonly Readonly<{
    lane: ProactiveFollowupLaneSnapshot["name"];
    sourceRevision: number | null;
    coveredThroughSequence: number | null;
    completeness: ProactiveFollowupLaneSnapshot["status"];
    timingMs: number | null;
    degradedReason: string | null;
  }>[];
  candidates: readonly ProactiveFollowupManifestCandidate[];
  selectedTarget: Readonly<{
    targetKind: ProactiveFollowupTargetKind;
    targetId: string;
    targetVersionId: string;
  }> | null;
  stableTieBreak: string | null;
  reservationId: string | null;
  reservationStatus: "not_reserved" | "active" | "committed" | "released" | "abandoned";
}>;

export type ProactiveFollowupTarget = Readonly<{
  targetKind: ProactiveFollowupTargetKind;
  targetId: string;
  targetVersionId: string;
  source: ProactiveFollowupCandidate["source"];
  sensitive: boolean;
}>;

export type ProactiveFollowupSelectionResult = Readonly<
  | {
      outcome: "selected";
      target: ProactiveFollowupTarget;
      manifest: ProactiveFollowupSelectionManifest;
    }
  | {
      outcome: "none";
      reason: string;
      manifest: ProactiveFollowupSelectionManifest;
    }
>;

export type ProactiveFollowupDispositionInput = Readonly<{
  userId: string;
  now: Date;
  timeZone: string;
  signal: ProactiveFollowupStopSignal;
  targetKind: ProactiveFollowupTargetKind;
  targetId: string;
  targetVersionId: string;
  currentUserEventRevisionId: string;
  currentUserEventSequence: number;
  currentUserEventExchangeNo: number;
  use: Readonly<{
    useId: string;
    userId: string;
    targetKind: ProactiveFollowupTargetKind;
    targetId: string;
    targetVersionId: string;
    promptUserEventRevisionId: string;
    promptUserEventSequence: number;
    exchangeNo: number;
    finalTextLocator: ProactiveFollowupTextLocator;
  }>;
  state: ProactiveFollowupStateSnapshot | null;
}>;

export type ProactiveFollowupStateTransition = Readonly<{
  outcome: "unchanged" | "suppressed";
  state: ProactiveFollowupStateSnapshot | null;
  suppressionUntilAt: string | null;
  suppressionReason: ProactiveFollowupSuppressionReason | null;
}>;

export type ProactiveFollowupReleaseInput = Readonly<{
  now: Date;
  reason: Exclude<ProactiveFollowupReleaseReason, "cooldown_elapsed" | "target_terminal_or_expired">;
  targetKind: ProactiveFollowupTargetKind;
  targetId: string;
  targetVersionId: string;
  currentUserEventRevisionId: string;
  currentUserEventSequence: number;
  /** Required for target-specific permission; generic permission is rejected. */
  permissionTargetId: string | null;
  state: ProactiveFollowupStateSnapshot;
}>;

export type ProactiveFollowupReleaseResult = Readonly<{
  outcome: "released" | "unchanged" | "rejected";
  reason: string;
  state: ProactiveFollowupStateSnapshot;
}>;
