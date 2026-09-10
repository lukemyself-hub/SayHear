import type {
  CandidateReviewAuditId,
  MemoryCandidateId,
  PredicateChangeProposalCandidateLinkId,
  PredicateChangeProposalId,
  PredicateChangeProposalVersionId,
  UserId,
} from "@sayhear/domain";

import type { MemoryCandidateRecord, ClaimTypedValue, CandidateDispositionPlan } from "../memory-claim/types";
import type { AdmitCandidateOutcome } from "../memory-claim/service";

/**
 * Candidate Review and Predicate Registry governance types (SPEC #193 §8,
 * ADR-0046–0053, ADR-0122). The Candidate Review Module exposes the single
 * typed review interface (`map_existing`, `reject`,
 * `approve_for_registry_change`); the Predicate Registry Governance Module
 * owns Proposal `cancel` and Proposal-level explicit reconsideration. Both
 * are synchronous typed operator commands over conditional database updates:
 * no durable workflow is created for a human disposition (ADR-0122).
 */

export const CANDIDATE_REVIEW_POLICY_VERSION = "candidate-review:v1";

/** Closed rejection reason vocabulary (SPEC §8.1 `candidate_disposition_reason:v1`). */
export const CANDIDATE_DISPOSITION_REASON_VERSION =
  "candidate_disposition_reason:v1";

/**
 * Candidate-specific rejection reasons: terminal for the Candidate and never
 * creating a Proposal. Only `concept_no_product_value` delegates to the
 * Governance Module (ADR-0053).
 */
export type CandidateDispositionReasonCode =
  | "insufficient_evidence"
  | "entity_scope_unresolved"
  | "sensitive_inference_violation"
  | "value_schema_mismatch"
  | "duplicate_concept"
  | "concept_no_product_value";

export const CANDIDATE_SPECIFIC_REJECTION_REASONS: readonly Exclude<
  CandidateDispositionReasonCode,
  "concept_no_product_value"
>[] = [
  "insufficient_evidence",
  "entity_scope_unresolved",
  "sensitive_inference_violation",
  "value_schema_mismatch",
  "duplicate_concept",
];

/** The one rejection reason that creates/associates a rejected ProposalVersion. */
export const PRODUCT_VALUE_REJECTION_REASON = "concept_no_product_value" as const;

export type ProposalVersionStatus =
  | "awaiting_release"
  | "published"
  | "rejected"
  | "canceled";

export type ProposalDecisionScope = "registry_change" | "product_value_rejection";

/**
 * Fixed operator-facing outcome/error codes (SPEC §8.5). The Portal maps each
 * code to natural language; model-generated explanations are never surfaced.
 */
export type CandidateReviewErrorCode =
  | "unauthorized"
  | "step_up_required"
  | "recent_step_up_required"
  | "candidate_not_found"
  | "already_disposed"
  | "review_deadline_passed"
  | "predicate_not_active"
  | "predicate_deprecated"
  | "value_schema_mismatch"
  | "proposal_not_found"
  | "proposal_not_awaiting_release"
  | "proposal_not_rejected"
  | "reconsideration_blocked_by_rejected_version"
  | "linked_proposal_rejected"
  | "invalid_reason_code"
  /**
   * Draft hygiene extension (SPEC §8.3: length limits, reviewer attestation
   * and private-content exclusion on the write path). The §8.5 list is the
   * minimum; this code covers reviewer draft rejections that carry no
   * private content and must never reach the Portal as raw detail.
   */
  | "proposal_draft_rejected";

export type CandidateReviewAuthDenialReason =
  | "elevated_capability_required"
  | "recent_step_up_required";

/** Operator principal identity recorded on commands and audits (reviewer). */
export type ReviewerPrincipal = Readonly<{
  userId: UserId;
  authSessionId: string;
}>;

/**
 * Reviewer-authored, user-content-free draft of a generic Predicate concept.
 * The label must be rewritten (never the model's `proposedConcept`), the
 * value schema is a draft for the next Registry release, and the examples
 * are synthetic only. No field may carry a subject user, Evidence, typed
 * user value, Entity reference, verbatim text, time or place.
 */
export type ProposalEntryDraft = Readonly<{
  baseRegistryVersion: number;
  proposedPredicateIdentity: string;
  label: string;
  definition: string;
  valueSchemaDraft: unknown;
  syntheticExamples: Readonly<{
    positive: readonly string[];
    negative: readonly string[];
  }>;
  rationale: string;
  /** Reviewer attestation: the draft carries no private content. */
  attestation: boolean;
}>;

/**
 * The reviewer-facing draft omits the base Registry version: the service
 * stamps it from the live Registry snapshot, so callers can never pin a
 * stale or fabricated review baseline.
 */
export type ReviewerProposalDraft = Omit<ProposalEntryDraft, "baseRegistryVersion">;

/** Fixed review deadline (ADR-0048) — 30 days from entering review state. */
export const REVIEW_DEADLINE_DAYS = 30;
/** Fixed release-wait deadline (ADR-0050) — 90 days from approve commit. */
export const REGISTRY_RELEASE_WAIT_DAYS = 90;
/** Fixed step-up window for review commands (SPEC §8.5). */
export const REVIEW_STEP_UP_MAX_AGE_MS = 10 * 60 * 1_000;

export type ReviewStage =
  | "needs_review"
  | "awaiting_release"
  | "terminal_grace"
  | "successor";

export type CandidateReviewQueueEntry = Readonly<{
  candidate: MemoryCandidateRecord;
  stage: ReviewStage;
  linkedProposalId: PredicateChangeProposalId | null;
  linkedProposalStatus: ProposalVersionStatus | null;
  /**
   * §8.3: the linked Proposal's current version is rejected — the entry is
   * gated out of mapping/admission until a legal superseding version exists.
   */
  governanceBlocked: boolean;
}>;

export type CandidateReviewCommandResult = Readonly<{
  outcome: CandidateReviewErrorCode | "applied";
  /** The real after-state; renders must use it, never prompt text. */
  candidateAfter: MemoryCandidateRecord | null;
}>;

export type MapExistingOutcome = CandidateReviewCommandResult &
  Readonly<{ admission?: AdmitCandidateOutcome }>;

export type RejectOutcome = CandidateReviewCommandResult;

export type ApproveOutcome = CandidateReviewCommandResult & Readonly<{
  proposalVersionId: PredicateChangeProposalVersionId | null;
}>;

export type CancelOutcome = Readonly<{
  outcome:
    | "applied"
    | "already_canceled"
    | "proposal_not_found"
    | "proposal_not_awaiting_release";
  staledCandidateCount: number;
}>;

export type ReconsiderOutcome = Readonly<{
  outcome:
    | "applied"
    | "proposal_not_found"
    | "proposal_not_rejected"
    | "proposal_draft_rejected";
  versionAfter: PredicateChangeProposalVersionRecord | null;
}>;

export type PredicateChangeProposalRecord = Readonly<{
  predicateChangeProposalId: PredicateChangeProposalId;
  currentVersionId: PredicateChangeProposalVersionId | null;
  createdAt: Date;
}>;

export type PredicateChangeProposalVersionRecord = Readonly<{
  predicateChangeProposalVersionId: PredicateChangeProposalVersionId;
  predicateChangeProposalId: PredicateChangeProposalId;
  revision: number;
  baseRegistryVersion: number;
  proposedPredicateIdentity: string;
  label: string;
  definition: string;
  valueSchemaDraft: unknown;
  syntheticExamples: Readonly<{
    positive: readonly string[];
    negative: readonly string[];
  }>;
  governanceRationale: string;
  reviewerPrincipalId: string;
  reasonCode: string | null;
  status: ProposalVersionStatus;
  decisionScope: ProposalDecisionScope;
  supersedesVersionId: PredicateChangeProposalVersionId | null;
  createdAt: Date;
  publishedRegistryVersion: number | null;
  publishedAt: Date | null;
}>;

export type PredicateChangeProposalCandidateLinkRecord = Readonly<{
  predicateChangeProposalCandidateLinkId: PredicateChangeProposalCandidateLinkId;
  userId: UserId;
  memoryCandidateId: MemoryCandidateId;
  predicateChangeProposalId: PredicateChangeProposalId;
  createdAt: Date;
}>;

export type CandidateReviewAuditRecord = Readonly<{
  candidateReviewAuditId: CandidateReviewAuditId;
  userId: UserId;
  command:
    | "map_existing"
    | "reject"
    | "approve_for_registry_change"
    | "cancel"
    | "reconsider"
    | "queue_read"
    | "proposal_read";
  targetType: "memory_candidate" | "predicate_change_proposal";
  targetId: string | null;
  disposition: "allowed" | "denied";
  reason: string | null;
  operatorPrincipalId: string;
  policyVersion: string;
  recordedAt: Date;
}>;

/**
 * Thrown when the operator session lacks the `candidate_review` capability,
 * a fresh step-up, or the Internal Owner identity. The typed code — not a
 * model-generated explanation — is what reaches the Portal.
 */
export class CandidateReviewAuthError extends Error {
  public constructor(
    public readonly code: Extract<
      CandidateReviewErrorCode,
      "unauthorized" | "step_up_required" | "recent_step_up_required"
    >,
    public readonly denialReason: CandidateReviewAuthDenialReason | null,
  ) {
    super(`Candidate review command failed closed: ${code}.`);
    this.name = "CandidateReviewAuthError";
  }
}

export type CandidateReviewRepository = Readonly<{
  authorizeCandidateReview(input: {
    userId: UserId;
    authSessionId: string;
    capability: "candidate_review";
    now: Date;
    policyVersion: string;
    requireStepUp: boolean;
    stepUpMaxAgeMs: number;
  }): Promise<
    | { outcome: "allowed" }
    | { outcome: "denied"; reason: CandidateReviewAuthDenialReason }
  >;
  recordCandidateReviewAudit(input: {
    userId: UserId;
    command:
      | "map_existing"
      | "reject"
      | "approve_for_registry_change"
      | "cancel"
      | "reconsider"
      | "queue_read"
      | "proposal_read";
    targetType: "memory_candidate" | "predicate_change_proposal";
    /** NULL for the queue-view read (there is no single target row). */
    targetId: string | null;
    disposition: "allowed" | "denied";
    reason: string | null;
    operatorPrincipalId: string;
    policyVersion: string;
    now: Date;
  }): Promise<void>;

  // ── Candidate review reads ──
  findCandidate(
    userId: UserId,
    candidateId: MemoryCandidateId,
  ): Promise<MemoryCandidateRecord | null>;
  listCandidateEvidenceRevisionIds(
    userId: UserId,
    candidateId: MemoryCandidateId,
  ): Promise<readonly string[]>;
  findCurrentEntityLabels(
    userId: UserId,
    entityIds: readonly string[],
  ): Promise<Readonly<Record<string, string>>>;
  listReviewQueue(userId: UserId, now: Date): Promise<
    readonly CandidateReviewQueueEntry[]
  >;

  // ── Candidate review CAS writes (one transaction each) ──
  /**
   * Conditioned map (ADR-0122 single-row compare-and-set): only a
   * `needs_predicate_review` Candidate whose authoritative review deadline
   * has not passed moves to the mapped state inside the same transaction
   * that records the decision. Losing concurrent submitters observe no
   * updated row and read back `already_disposed`; replays read the
   * committed outcome without extending any deadline.
   */
  casMapExisting(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    predicateId: string;
    registryVersion: number;
    typedValue: ClaimTypedValue | null;
    decidedAt: Date;
  }): Promise<boolean>;
  /**
   * Release-driven remap CAS (SPEC §8.4): only a still-
   * `awaiting_registry_release` Candidate can be remapped against the
   * released Registry version. Losers and already-terminal Candidates
   * report no update so the workflow never resurrects them (ADR-0046).
   */
  casRemapCandidate(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    predicateId: string;
    registryVersion: number;
    typedValue: ClaimTypedValue;
  }): Promise<boolean>;
  /**
   * Conditioned terminal disposition with the deadline inside the WHERE
   * (ADR-0122: decided_at <= review_due_at, the exact symmetry of ADR-0050's
   * published_at <= registry_release_due_at). A late command fails closed
   * with `review_deadline_passed` even when the sweeper has not run yet.
   * The product-value delegation (proposal version + owner-scoped link)
   * commits in the SAME transaction as the disposition.
   */
  casRejectCandidate(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    plan: CandidateDispositionPlan;
    reviewerPrincipalId: string;
    governance:
      | Readonly<{ action: "none" }>
      | Readonly<{ action: "create"; draft: ProposalEntryDraft }>
      | Readonly<{
          action: "associate";
          proposalId: PredicateChangeProposalId;
        }>;
    decidedAt: Date;
  }): Promise<
    | { outcome: "rejected" }
    | { outcome: "not_eligible" }
    | { outcome: "review_deadline_passed" }
  >;
  /**
   * Conditioned approve-for-release (one transaction): awaiting Proposal
   * create-or-associate, the owner-scoped link, the disposition record and
   * the 90-day release deadline all commit atomically.
   */
  casApproveForRegistryChange(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    reviewerPrincipalId: string;
    mode:
      | Readonly<{ action: "create"; draft: ProposalEntryDraft }>
      | Readonly<{ action: "associate"; proposalId: PredicateChangeProposalId }>;
    decidedAt: Date;
  }): Promise<
    | { outcome: "approved"; proposalVersionId: PredicateChangeProposalVersionId }
    | { outcome: "not_eligible" }
    | { outcome: "review_deadline_passed" }
    | { outcome: "proposal_not_found" }
    | { outcome: "proposal_not_awaiting_release" }
  >;

  // ── Governance reads ──
  findProposal(
    proposalId: PredicateChangeProposalId,
  ): Promise<PredicateChangeProposalRecord | null>;
  findCurrentProposalVersion(
    proposalId: PredicateChangeProposalId,
  ): Promise<PredicateChangeProposalVersionRecord | null>;
  listProposalVersions(
    proposalId: PredicateChangeProposalId,
  ): Promise<readonly PredicateChangeProposalVersionRecord[]>;
  findCandidateLink(
    userId: UserId,
    candidateId: MemoryCandidateId,
  ): Promise<PredicateChangeProposalCandidateLinkRecord | null>;

  // ── Governance commands (one transaction each) ──
  /**
   * CAS `awaiting_release -> canceled` and, in the SAME transaction, stale
   * every still-`awaiting_registry_release` linked Candidate with reason
   * `registry_release_canceled` and terminal_effective_at = cancel commit
   * time (ADR-0122). Terminal Candidates stay unchanged; replays read the
   * canceled version without re-staling anyone.
   */
  casCancelProposal(input: {
    proposalId: PredicateChangeProposalId;
    now: Date;
  }): Promise<
    | { outcome: "canceled"; staledCandidateCount: number }
    | { outcome: "already_canceled" }
    | { outcome: "not_awaiting_release" }
    | { outcome: "not_found" }
  >;
  /**
   * Proposal-level explicit reconsideration (ADR-0053): append an immutable
   * superseding `awaiting_release` version; the rejected version stays
   * untouched. Fails closed unless the current version is the rejected
   * product-value judgment.
   */
  appendReconsideredProposalVersion(input: {
    proposalId: PredicateChangeProposalId;
    draft: ProposalEntryDraft;
    reviewerPrincipalId: string;
    baseRegistryVersion: number;
    decidedAt: Date;
  }): Promise<
    | { outcome: "applied"; version: PredicateChangeProposalVersionRecord }
    | { outcome: "not_rejected" }
    | { outcome: "not_found" }
  >;
}>;
