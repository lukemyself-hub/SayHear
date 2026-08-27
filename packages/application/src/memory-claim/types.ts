import type {
  DailySessionId,
  MemoryCandidateId,
  MemoryClaimId,
  MemoryClaimVersionId,
  UserId,
} from "@sayhear/domain";

import type { ClaimKind, PredicateRegistryEntry } from "../predicate-registry/types";

/**
 * Memory Claim domain types (SPEC #107 "Claims and admission", architecture
 * §7.10, grilling decisions #93–#99). Vocabulary follows CONTEXT.md: Memory
 * Claim, MemoryClaimVersion, MemoryCandidate, Contested Memory Claim, Dormant
 * AI Impression, Rejected Memory Candidate, Successor Memory Candidate,
 * Materially New Evidence, Terminal Candidate Audit Envelope.
 */

/** Versioned admission / disposition policy for this slice. */
export const MEMORY_ADMISSION_POLICY_VERSION = "memory-admission:v1";

/** Forget fence policy (whole-Claim scope here; Qualifier scope joins #120). */
export const MEMORY_FORGET_POLICY_VERSION = "memory-forget:v1";

/**
 * Global impression evidence floor (ADR-0039): at least two independent User
 * Evidence items from two different Daily Sessions. Registry evidence policies
 * may only raise this floor — never lower it; a policy id the admission layer
 * does not know fails closed to this floor.
 */
export const IMPRESSION_MIN_EVIDENCE_ITEMS = 2;
export const IMPRESSION_MIN_DAILY_SESSIONS = 2;

/** Uniform impression review cycle to `dormant` (ADR-0041). */
export const IMPRESSION_REVIEW_CYCLE_DAYS = 30;

/** `needs_predicate_review` candidates go stale after 30 days (ADR-0048). */
export const NEEDS_PREDICATE_REVIEW_DEADLINE_DAYS = 30;

/** Candidates waiting for a registry release go stale after 90 days (ADR-0050). */
export const REGISTRY_RELEASE_WAIT_DAYS = 90;

/** Terminal candidate derived semantics expire after 7 days (ADR-0051). */
export const TERMINAL_CONTENT_EXPIRY_DAYS = 7;

/** Key version of the keyed terminal dedupe fingerprint (ADR-0051). */
export const DEDUPE_FINGERPRINT_KEY_VERSION = "dedupe-fingerprint-key:v1";

export type ClaimVersionStatus =
  | "active"
  | "review_due"
  | "dormant"
  | "superseded"
  | "retracted";

export type EpistemicStatus = "confirmed" | "inferred" | "contested";

export type TemporalStatus = "current" | "ended" | "unknown";

export type BoundaryPrecision =
  | "exact"
  | "month"
  | "year"
  | "approximate"
  | "unknown";

/**
 * Whether the proposal rests on a direct, explicit user statement (the only
 * path to `objective + confirmed`, ADR-0038) or on model inference (the only
 * path to `impression + inferred`, ADR-0039).
 */
export type CandidateBasis = "directly_stated" | "inferred";

export type CandidateStatus =
  | "proposed"
  | "needs_entity_resolution"
  | "needs_predicate_review"
  | "awaiting_registry_release"
  | "accepted"
  | "rejected"
  | "stale"
  | "deleted";

export type CandidateResolutionStatus = "mapped" | "ambiguous" | "unmapped";

export type ReproposalPolicy =
  | "material_change_allowed"
  | "explicit_reconsideration_only"
  | "blocked_while_policy_active";

export type SuccessorTrigger =
  | "materially_new_evidence"
  | "explicit_reconsideration";

export type ClaimTypedValue = string | readonly string[];

export type TemporalBounds = Readonly<{
  temporalStatus: TemporalStatus;
  validFrom: Date | null;
  validFromPrecision: BoundaryPrecision;
  validTo: Date | null;
  validToPrecision: BoundaryPrecision;
}>;

export type CandidateLineage = Readonly<{
  extractionPolicyVersion: string;
  generationCommandId: string | null;
  authoritativeModelAttemptId: string | null;
  modelVersion: string | null;
  promptVersion: string | null;
  sourceReflectionVersionId: string | null;
}>;

/**
 * One evidence item as the admission layer may see it: joined with its source
 * snapshot so cross-session counting uses the real Daily Session boundary.
 * evidence_items themselves are structurally user-actor and final/corrected
 * only (migration 0010); the fields are re-checked here as defense in depth.
 */
export type AdmissibleEvidence = Readonly<{
  evidenceItemId: string;
  dailySessionId: DailySessionId;
  sourceRevisionId: string;
  sourceActor: "user";
  sourceStatus: "final" | "corrected";
  status: "active";
}>;

/** A MemoryCandidate proposal as extraction / consolidation submits it. */
export type MemoryCandidateProposal = Readonly<{
  userId: UserId;
  candidateKind: ClaimKind;
  basis: CandidateBasis;
  resolution:
    | Readonly<{
        status: "mapped";
        predicateId: string;
        registryVersion: number;
        typedValue: ClaimTypedValue;
        mappingConfidence: number | null;
      }>
    | Readonly<{
        status: "ambiguous" | "unmapped";
        proposedConcept: string;
      }>;
  subjectEntityId: string | null;
  subjectEntityMentionId: string | null;
  objectEntityId: string | null;
  objectEntityMentionId: string | null;
  scopeKey: string;
  temporal: TemporalBounds;
  evidenceItemIds: readonly string[];
  lineage: CandidateLineage;
}>;

export type MemoryCandidateRecord = Readonly<{
  memoryCandidateId: MemoryCandidateId;
  userId: UserId;
  candidateKind: ClaimKind;
  basis: CandidateBasis;
  subjectEntityId: string | null;
  objectEntityId: string | null;
  resolutionStatus: CandidateResolutionStatus;
  predicateId: string | null;
  predicateRegistryVersion: number | null;
  proposedConcept: string | null;
  mappingConfidence: number | null;
  proposedObjectValue: ClaimTypedValue;
  proposedScopeKey: string;
  temporal: TemporalBounds;
  extractionPolicyVersion: string;
  /** Runtime lineage carried onto promoted ClaimVersions (ADR-0074). */
  generationCommandId: string | null;
  authoritativeModelAttemptId: string | null;
  modelVersion: string | null;
  promptVersion: string | null;
  sourceReflectionVersionId: string | null;
  status: CandidateStatus;
  reviewDueAt: Date | null;
  registryReleaseDueAt: Date | null;
  dispositionReasonCode: string | null;
  dispositionPolicyVersion: string | null;
  decidedAt: Date | null;
  terminalEffectiveAt: Date | null;
  terminalContentExpiresAt: Date | null;
  reproposalPolicy: ReproposalPolicy | null;
  predecessorCandidateId: MemoryCandidateId | null;
  successorTrigger: SuccessorTrigger | null;
  materialChangeReasonCodes: readonly string[] | null;
  createdAt: Date;
}>;

export type MemoryClaimRecord = Readonly<{
  memoryClaimId: MemoryClaimId;
  userId: UserId;
  canonicalKey: string;
  subjectEntityId: string;
  objectEntityId: string | null;
  predicateId: string;
  scopeKey: string;
  currentVersionId: MemoryClaimVersionId | null;
  createdAt: Date;
  deletedAt: Date | null;
}>;

export type MemoryClaimVersionRecord = Readonly<{
  memoryClaimVersionId: MemoryClaimVersionId;
  memoryClaimId: MemoryClaimId;
  revision: number;
  kind: ClaimKind;
  epistemicStatus: EpistemicStatus;
  status: ClaimVersionStatus;
  subjectEntityVersionId: string;
  objectEntityVersionId: string | null;
  typedValue: ClaimTypedValue;
  confidence: number | null;
  temporal: TemporalBounds;
  lastObservedAt: Date;
  supersedesVersionId: MemoryClaimVersionId | null;
  createdBy: string;
  modelVersion: string | null;
  promptVersion: string | null;
  predicateRegistryVersion: number;
  createdAt: Date;
}>;

/** How the deterministic resolver resolved the proposal against Claim state. */
export type ConflictResolution =
  | "initial_admission"
  | "claim_reuse_new_interval"
  | "temporal_or_correction_supersede"
  | "value_coexist"
  | "contested_conflict"
  | "contested_resolved"
  | "direct_statement_reactivates"
  | "dormancy_requalified";

/**
 * Deterministic admission decision (ADR-0038 / ADR-0039 / ADR-0040 / ADR-0041 /
 * ADR-0046). Pure — the repository executes the plan in one transaction.
 */
export type ClaimAdmissionPlan =
  | Readonly<{
      action: "promote";
      conflictResolution: ConflictResolution;
      claimAction: "create_claim" | "new_version";
      canonicalKey: string;
      kind: ClaimKind;
      epistemicStatus: "confirmed" | "inferred";
      versionStatus: "active";
      subjectEntityId: string;
      subjectEntityVersionId: string;
      objectEntityId: string | null;
      objectEntityVersionId: string | null;
      predicateId: string;
      scopeKey: string;
      typedValue: ClaimTypedValue;
      temporal: TemporalBounds;
      supersedesVersionId: MemoryClaimVersionId | null;
      reasonCodes: readonly string[];
    }>
  | Readonly<{
      action: "contested";
      conflictResolution: "contested_conflict";
      claimAction: "new_version";
      canonicalKey: string;
      kind: ClaimKind;
      epistemicStatus: "contested";
      versionStatus: "review_due";
      subjectEntityVersionId: string;
      objectEntityVersionId: string | null;
      typedValue: ClaimTypedValue;
      temporal: TemporalBounds;
      supersedesVersionId: MemoryClaimVersionId | null;
      reasonCodes: readonly string[];
    }>
  | Readonly<{
      action: "reinforce_current";
      conflictResolution: "contested_resolved" | null;
      attachToVersionId: MemoryClaimVersionId;
      linkRole: "support" | "counter";
      reasonCodes: readonly string[];
    }>
  | Readonly<{
      action: "needs_entity_resolution";
      reasonCodes: readonly string[];
    }>
  | Readonly<{
      action: "below_impression_floor";
      reasonCodes: readonly string[];
      floor: Readonly<{ minEvidenceItems: number; minDailySessions: number }>;
      actual: Readonly<{ evidenceItems: number; dailySessions: number }>;
    }>
  | Readonly<{
      action: "pending_conflict";
      reasonCodes: readonly string[];
    }>
  | Readonly<{
      action: "blocked_forget_fence";
      reasonCodes: readonly string[];
    }>
  | Readonly<{
      action: "reject";
      reasonCode: AdmissionRejectionCode;
    }>;

/** Deterministic policy rejection codes; all are terminal (ADR-0046). */
export type AdmissionRejectionCode =
  | "predicate_not_active"
  | "predicate_unmapped"
  | "registry_version_mismatch"
  | "claim_kind_not_allowed_by_registry"
  | "subject_kind_not_allowed"
  | "kind_basis_mismatch"
  | "typed_value_invalid"
  | "temporal_status_not_supported"
  | "evidence_missing"
  | "evidence_ineligible"
  | "relationship_object_missing"
  | "relationship_object_unbound"
  | "subject_not_self_entity"
  | "relationship_parties_identical";

/**
 * Deterministic disposition write for a terminal candidate. `stale`
 * dispositions take `terminal_effective_at` from the ORIGINAL policy deadline
 * (never from sweeper time, ADR-0051).
 */
export type CandidateDispositionPlan = Readonly<{
  status: "rejected" | "stale";
  dispositionReasonCode: string;
  dispositionPolicyVersion: string;
  reproposalPolicy: ReproposalPolicy;
  terminalEffectiveAt: Date;
  terminalContentExpiresAt: Date;
  dedupeFingerprint: string;
}>;

/** Reason codes for the deterministic material-change evaluator (ADR-0052). */
export type MaterialChangeReasonCode =
  | "inferred_to_directly_stated"
  | "cross_session_floor_newly_met"
  | "entity_resolution_uniquely_resolved"
  | "predicate_resolution_uniquely_resolved"
  | "target_refined_by_new_evidence";

export type MaterialChangeEvaluation = Readonly<{
  material: boolean;
  reasonCodes: readonly MaterialChangeReasonCode[];
  nonMaterialReasonCodes: readonly string[];
}>;

export type ImpressionDormancyPlan = Readonly<{
  outcome: "go_dormant" | "remain_active" | "not_applicable";
  reviewDeadline: Date | null;
  latestQualifyingEvidenceAt: Date | null;
}>;

/** Registry entry lookup the admission layer depends on. */
export type RegistryEntryLookup = Readonly<{
  entryFor(predicateId: string): PredicateRegistryEntry | null;
  registryVersion(): number;
}>;
