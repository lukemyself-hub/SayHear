import type {
  MemoryCandidateId,
  PredicateChangeProposalId,
  UserId,
} from "@sayhear/domain";

import {
  addDays,
  candidateSemanticTarget,
  dedupeFingerprint,
} from "../memory-claim/admission";
import {
  DEDUPE_FINGERPRINT_KEY_VERSION,
  MEMORY_ADMISSION_POLICY_VERSION,
  TERMINAL_CONTENT_EXPIRY_DAYS,
} from "../memory-claim/types";
import type {
  CandidateDispositionPlan,
  ClaimTypedValue,
  MemoryCandidateRecord,
  RegistryEntryLookup,
} from "../memory-claim/types";
import type { AdmitCandidateOutcome, MemoryClaimService } from "../memory-claim/service";

import {
  CANDIDATE_DISPOSITION_REASON_VERSION,
  CANDIDATE_REVIEW_POLICY_VERSION,
  PRODUCT_VALUE_REJECTION_REASON,
  REVIEW_DEADLINE_DAYS,
  REVIEW_STEP_UP_MAX_AGE_MS,
  CandidateReviewAuthError,
  type ApproveOutcome,
  type CandidateReviewErrorCode,
  type CandidateReviewQueueEntry,
  type CandidateReviewRepository,
  type CandidateDispositionReasonCode,
  type MapExistingOutcome,
  type ProposalEntryDraft,
  type RejectOutcome,
  type ReviewerProposalDraft,
} from "./types";
import { asPredicateChangeProposalId } from "@sayhear/domain";

/**
 * Candidate Review Module (SPEC #193 §8.1, ADR-0122): the single typed
 * review interface over `needs_predicate_review` MemoryCandidates. Commands
 * are synchronous typed operator commands over conditional database updates
 * — no durable workflow is created for a human disposition. Every command
 * derives the owner from the database session, re-verifies the
 * `candidate_review` capability, the recent step-up, the Candidate state and
 * the authoritative review deadline in the same transaction, and appends a
 * content-free audit. The returned `(outcome, candidate state after)` pair
 * is what callers render — never a prompt or message text.
 */

export type CandidateReviewService = Readonly<{
  listReviewQueue(input: {
    userId: UserId;
    authSessionId: string;
  }): Promise<readonly CandidateReviewQueueEntry[]>;
  mapExisting(input: {
    userId: UserId;
    authSessionId: string;
    candidateId: MemoryCandidateId;
    predicateId: string;
    typedValue?: ClaimTypedValue;
  }): Promise<MapExistingOutcome>;
  reject(input: {
    userId: UserId;
    authSessionId: string;
    candidateId: MemoryCandidateId;
    reasonCode: CandidateDispositionReasonCode;
    /**
     * Required for `concept_no_product_value` (ADR-0053): create a rejected
     * ProposalVersion from the reviewer draft, or associate the Candidate
     * with a reviewer-selected already-rejected Proposal. Never present for
     * candidate-specific reasons.
     */
    proposal?:
      | Readonly<{ action: "create"; draft: ReviewerProposalDraft }>
      | Readonly<{ action: "associate"; proposalId: string }>;
  }): Promise<RejectOutcome>;
  approveForRegistryChange(input: {
    userId: UserId;
    authSessionId: string;
    candidateId: MemoryCandidateId;
    mode:
      | Readonly<{ action: "create"; draft: ReviewerProposalDraft }>
      | Readonly<{ action: "associate"; proposalId: string }>;
  }): Promise<ApproveOutcome>;
  /**
   * Release-driven remap (SPEC §8.4, ADR-0122): re-enter normal mapping and
   * deterministic admission after a Registry release. The mapping target is
   * the reviewer-owned Proposal's proposed Predicate identity — never a
   * text-similarity guess (ADR-0122). This is reconciliation work — no
   * operator auth, no audit, no deadline extension. A Candidate that already
   * went stale (30/90-day sweeper or cancel) never re-enters.
   */
  runRemap(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
  }): Promise<RemapOutcome>;
}>;

export type RemapOutcome =
  | "converged"
  | "no_longer_eligible"
  | "governance_blocked"
  | "still_unmapped";

export function createCandidateReviewService(dependencies: {
  repository: CandidateReviewRepository;
  registry: RegistryEntryLookup;
  memoryClaimService: MemoryClaimService;
  clock: () => Date;
  dedupeFingerprintSecret: string;
}): CandidateReviewService {
  const { repository, registry, memoryClaimService, clock } = dependencies;
  if (!dependencies.dedupeFingerprintSecret) {
    throw new Error("dedupeFingerprintSecret must be non-empty.");
  }
  const secret = dependencies.dedupeFingerprintSecret;

  async function authorize(
    input: { userId: UserId; authSessionId: string },
    requireStepUp: boolean,
    command:
      | "map_existing"
      | "reject"
      | "approve_for_registry_change"
      | "cancel"
      | "reconsider"
      | "queue_read"
      | "proposal_read",
    targetType: "memory_candidate" | "predicate_change_proposal",
    targetId: string | null,
  ): Promise<void> {
    const now = clock();
    const result = await repository.authorizeCandidateReview({
      userId: input.userId,
      authSessionId: input.authSessionId,
      capability: "candidate_review",
      now,
      policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
      requireStepUp,
      stepUpMaxAgeMs: REVIEW_STEP_UP_MAX_AGE_MS,
    });
    if (result.outcome === "allowed") {
      await repository.recordCandidateReviewAudit({
        userId: input.userId,
        command,
        targetType,
        targetId,
        disposition: "allowed",
        reason: null,
        operatorPrincipalId: input.userId,
        policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
        now,
      });
      return;
    }
    const code: Extract<
      CandidateReviewErrorCode,
      "step_up_required" | "recent_step_up_required"
    > =
      result.reason === "elevated_capability_required"
        ? "step_up_required"
        : "recent_step_up_required";
    await repository.recordCandidateReviewAudit({
      userId: input.userId,
      command,
      targetType,
      targetId,
      disposition: "denied",
      reason: code,
      operatorPrincipalId: input.userId,
      policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
      now,
    });
    throw new CandidateReviewAuthError(code, result.reason);
  }

  /** Plan a review rejection disposition (ADR-0046 / ADR-0051 / ADR-0053). */
  function planReviewRejection(input: {
    userId: UserId;
    reasonCode: CandidateDispositionReasonCode;
    semanticTarget: string;
    evidenceRevisionIds: readonly string[];
    now: Date;
  }): CandidateDispositionPlan {
    const isGovernance =
      input.reasonCode === PRODUCT_VALUE_REJECTION_REASON;
    return {
      status: "rejected",
      dispositionReasonCode: input.reasonCode,
      dispositionPolicyVersion: MEMORY_ADMISSION_POLICY_VERSION,
      reproposalPolicy: isGovernance
        ? "explicit_reconsideration_only"
        : "material_change_allowed",
      terminalEffectiveAt: input.now,
      terminalContentExpiresAt: addDays(input.now, TERMINAL_CONTENT_EXPIRY_DAYS),
      dedupeFingerprint: dedupeFingerprint({
        secret,
        userId: input.userId,
        semanticTarget: input.semanticTarget,
        evidenceRevisionIds: input.evidenceRevisionIds,
        policyVersion: MEMORY_ADMISSION_POLICY_VERSION,
      }),
    };
  }

  function rejectOutcomeFor(
    result: Awaited<
      ReturnType<CandidateReviewRepository["casRejectCandidate"]>
    >,
    candidateAfter: MemoryCandidateRecord | null,
  ): RejectOutcome {
    if (result.outcome === "rejected") {
      return { outcome: "applied", candidateAfter };
    }
    if (result.outcome === "review_deadline_passed") {
      return { outcome: "review_deadline_passed", candidateAfter };
    }
    return { outcome: "already_disposed", candidateAfter };
  }

  return {
    async listReviewQueue(input) {
      await authorize(
        input,
        false,
        "queue_read",
        "memory_candidate",
        null,
      );
      return repository.listReviewQueue(input.userId, clock());
    },

    async mapExisting(input) {
      await authorize(
        input,
        true,
        "map_existing",
        "memory_candidate",
        input.candidateId,
      );
      const now = clock();
      const candidate = await repository.findCandidate(
        input.userId,
        input.candidateId,
      );
      if (!candidate) {
        return { outcome: "candidate_not_found", candidateAfter: null };
      }
      if (candidate.status !== "needs_predicate_review") {
        return { outcome: "already_disposed", candidateAfter: candidate };
      }
      // Reviewer mapping may only select a predicate that is active in the
      // current Registry and fits the value schema (SPEC §8.1).
      const entry = registry.entryFor(input.predicateId);
      if (!entry) {
        return { outcome: "predicate_not_active", candidateAfter: candidate };
      }
      if (entry.status === "deprecated" || entry.status === "retired") {
        return { outcome: "predicate_deprecated", candidateAfter: candidate };
      }
      if (entry.status !== "active") {
        return { outcome: "predicate_not_active", candidateAfter: candidate };
      }
      if (!entry.allowedClaimKinds.includes(candidate.candidateKind)) {
        return { outcome: "value_schema_mismatch", candidateAfter: candidate };
      }
      const mapped = await repository.casMapExisting({
        userId: input.userId,
        candidateId: input.candidateId,
        predicateId: input.predicateId,
        registryVersion: registry.registryVersion(),
        typedValue: input.typedValue ?? null,
        decidedAt: now,
      });
      if (!mapped) {
        // Re-read the authoritative state after losing the race.
        const after = await repository.findCandidate(
          input.userId,
          input.candidateId,
        );
        if (!after) {
          return { outcome: "candidate_not_found", candidateAfter: null };
        }
        if (
          after.status !== "needs_predicate_review" &&
          after.status !== "proposed"
        ) {
          return { outcome: "already_disposed", candidateAfter: after };
        }
        return { outcome: "review_deadline_passed", candidateAfter: after };
      }
      // Normal mapping + deterministic admission (SPEC §8.1). The map CAS
      // already committed; admission converges through its own guarded
      // transactions, and the recovery scan backstops any interrupted run.
      let admission: AdmitCandidateOutcome | null = null;
      try {
        admission = await memoryClaimService.admitCandidate({
          userId: input.userId,
          candidateId: input.candidateId,
        });
      } catch {
        admission = null;
      }
      const candidateAfter = await repository.findCandidate(
        input.userId,
        input.candidateId,
      );
      return {
        outcome: "applied",
        candidateAfter,
        ...(admission ? { admission } : {}),
      };
    },

    async reject(input) {
      await authorize(
        input,
        true,
        "reject",
        "memory_candidate",
        input.candidateId,
      );
      const now = clock();
      const candidate = await repository.findCandidate(
        input.userId,
        input.candidateId,
      );
      if (!candidate) {
        return { outcome: "candidate_not_found", candidateAfter: null };
      }
      if (candidate.status !== "needs_predicate_review") {
        return { outcome: "already_disposed", candidateAfter: candidate };
      }
      if (
        input.reasonCode === PRODUCT_VALUE_REJECTION_REASON &&
        !input.proposal
      ) {
        return { outcome: "invalid_reason_code", candidateAfter: candidate };
      }
      if (
        input.reasonCode !== PRODUCT_VALUE_REJECTION_REASON &&
        input.proposal
      ) {
        return { outcome: "invalid_reason_code", candidateAfter: candidate };
      }
      let governance:
        | Readonly<{ action: "none" }>
        | Readonly<{ action: "create"; draft: ProposalEntryDraft }>
        | Readonly<{
            action: "associate";
            proposalId: PredicateChangeProposalId;
          }> = { action: "none" };
      if (input.proposal?.action === "create") {
        const labels = await repository.findCurrentEntityLabels(
          input.userId,
          [candidate.subjectEntityId, candidate.objectEntityId].filter(
            (value): value is string => value !== null,
          ),
        );
        const draftCheck = validateProposalEntryDraft({
          draft: input.proposal.draft,
          candidate,
          entityLabels: labels,
        });
        if (!draftCheck.ok) {
          return {
            outcome: draftCheck.code,
            candidateAfter: candidate,
          };
        }
        governance = {
          action: "create",
          draft: {
            ...input.proposal.draft,
            baseRegistryVersion: registry.registryVersion(),
          },
        };
      } else if (input.proposal?.action === "associate") {
        governance = {
          action: "associate",
          proposalId: asPredicateChangeProposalId(input.proposal.proposalId),
        };
      }
      const evidenceRevisionIds =
        await repository.listCandidateEvidenceRevisionIds(
          input.userId,
          input.candidateId,
        );
      const plan = planReviewRejection({
        userId: input.userId,
        reasonCode: input.reasonCode,
        semanticTarget: candidateSemanticTarget(candidate),
        evidenceRevisionIds,
        now,
      });
      const result = await repository.casRejectCandidate({
        userId: input.userId,
        candidateId: input.candidateId,
        plan,
        reviewerPrincipalId: input.userId,
        governance,
        decidedAt: now,
      });
      const candidateAfter = await repository.findCandidate(
        input.userId,
        input.candidateId,
      );
      return rejectOutcomeFor(result, candidateAfter);
    },

    async approveForRegistryChange(input) {
      await authorize(
        input,
        true,
        "approve_for_registry_change",
        "memory_candidate",
        input.candidateId,
      );
      const now = clock();
      const candidate = await repository.findCandidate(
        input.userId,
        input.candidateId,
      );
      if (!candidate) {
        return {
          outcome: "candidate_not_found",
          candidateAfter: null,
          proposalVersionId: null,
        };
      }
      if (candidate.status !== "needs_predicate_review") {
        return {
          outcome: "already_disposed",
          candidateAfter: candidate,
          proposalVersionId: null,
        };
      }
      if (input.mode.action === "create") {
        const labels = await repository.findCurrentEntityLabels(
          input.userId,
          [candidate.subjectEntityId, candidate.objectEntityId].filter(
            (value): value is string => value !== null,
          ),
        );
        const draftCheck = validateProposalEntryDraft({
          draft: input.mode.draft,
          candidate,
          entityLabels: labels,
        });
        if (!draftCheck.ok) {
          return {
            outcome: draftCheck.code,
            candidateAfter: candidate,
            proposalVersionId: null,
          };
        }
      }
      const result = await repository.casApproveForRegistryChange({
        userId: input.userId,
        candidateId: input.candidateId,
        reviewerPrincipalId: input.userId,
        mode:
          input.mode.action === "create"
            ? {
                action: "create",
                draft: {
                  ...input.mode.draft,
                  baseRegistryVersion: registry.registryVersion(),
                },
              }
            : {
                action: "associate",
                proposalId: asPredicateChangeProposalId(
                  input.mode.proposalId,
                ),
              },
        decidedAt: now,
      });
      const candidateAfter = await repository.findCandidate(
        input.userId,
        input.candidateId,
      );
      if (result.outcome === "approved") {
        return {
          outcome: "applied",
          candidateAfter,
          proposalVersionId: result.proposalVersionId,
        };
      }
      if (result.outcome === "not_eligible") {
        return {
          outcome: "already_disposed",
          candidateAfter,
          proposalVersionId: null,
        };
      }
      return {
        outcome: result.outcome,
        candidateAfter,
        proposalVersionId: null,
      };
    },

    async runRemap(input) {
      const candidate = await repository.findCandidate(
        input.userId,
        input.candidateId,
      );
      if (!candidate || candidate.status !== "awaiting_registry_release") {
        return "no_longer_eligible";
      }
      const link = await repository.findCandidateLink(
        input.userId,
        input.candidateId,
      );
      if (!link) {
        return "still_unmapped";
      }
      const current = await repository.findCurrentProposalVersion(
        link.predicateChangeProposalId,
      );
      if (!current) {
        return "still_unmapped";
      }
      // §8.3: a currently-rejected Proposal blocks mapping, admission and
      // Claim promotion; only a legal superseding version lifts the block.
      if (current.status === "rejected") {
        return "governance_blocked";
      }
      if (current.status !== "published") {
        return "still_unmapped";
      }
      const entry = registry.entryFor(current.proposedPredicateIdentity);
      if (!entry || entry.status !== "active") {
        return "still_unmapped";
      }
      const remapped = await repository.casRemapCandidate({
        userId: input.userId,
        candidateId: input.candidateId,
        predicateId: entry.predicateId,
        registryVersion: registry.registryVersion(),
        typedValue: candidate.proposedObjectValue,
      });
      if (!remapped) {
        // The sweeper or a cancel moved the Candidate to terminal between
        // the read and the CAS: never resurrect it (ADR-0046 / ADR-0050).
        return "no_longer_eligible";
      }
      await memoryClaimService.admitCandidate({
        userId: input.userId,
        candidateId: input.candidateId,
      });
      return "converged";
    },
  };
}

const PROPOSAL_IDENTITY_PATTERN = /^sh\.[a-z_]+\.[a-z_]+$/;

const DRAFT_FIELD_LIMITS = Object.freeze({
  label: 120,
  definition: 2_000,
  rationale: 1_000,
  example: 200,
  examplesPerSide: 20,
});

export type ProposalDraftRejectionCode = Extract<
  CandidateReviewErrorCode,
  "proposal_draft_rejected"
>;

/**
 * Reviewer draft hygiene (SPEC §8.3): the reviewer rewrites the concept
 * label (never the model's `proposed_concept`), attests the draft, and the
 * write path rejects length violations and private content smuggled into
 * free text. The check is deterministic — LLM-assisted drafting stays
 * allowed, but the human approves the final generic material.
 */
export function validateProposalEntryDraft(input: {
  draft: ReviewerProposalDraft;
  /** Candidate context for private-content needles; null for proposal-level drafts. */
  candidate:
    | Pick<
        MemoryCandidateRecord,
        "proposedConcept" | "proposedObjectValue" | "proposedScopeKey"
      >
    | null;
  entityLabels: Readonly<Record<string, string>>;
}): { ok: true } | { ok: false; code: ProposalDraftRejectionCode; detail: string } {
  const { draft, candidate } = input;
  const proposedConcept = candidate?.proposedConcept?.trim() ?? "";
  const proposedObjectValue = candidate?.proposedObjectValue ?? "";
  if (!draft.attestation) {
    return {
      ok: false,
      code: "proposal_draft_rejected",
      detail: "Reviewer attestation is required for a governance draft.",
    };
  }
  if (
    !draft.proposedPredicateIdentity ||
    !PROPOSAL_IDENTITY_PATTERN.test(draft.proposedPredicateIdentity)
  ) {
    return {
      ok: false,
      code: "proposal_draft_rejected",
      detail: "Proposed Predicate identity must use the sh.<domain>.<name> form.",
    };
  }
  if (!draft.label.trim() || draft.label.length > DRAFT_FIELD_LIMITS.label) {
    return {
      ok: false,
      code: "proposal_draft_rejected",
      detail: "Entry label is empty or too long.",
    };
  }
  if (
    !draft.definition.trim() ||
    draft.definition.length > DRAFT_FIELD_LIMITS.definition
  ) {
    return {
      ok: false,
      code: "proposal_draft_rejected",
      detail: "Entry definition is empty or too long.",
    };
  }
  if (
    !draft.rationale.trim() ||
    draft.rationale.length > DRAFT_FIELD_LIMITS.rationale
  ) {
    return {
      ok: false,
      code: "proposal_draft_rejected",
      detail: "Reviewer rationale is empty or too long.",
    };
  }
  if (draft.valueSchemaDraft === null || typeof draft.valueSchemaDraft !== "object") {
    return {
      ok: false,
      code: "proposal_draft_rejected",
      detail: "Value schema draft must be a JSON object.",
    };
  }
  if (
    draft.syntheticExamples.positive.length > DRAFT_FIELD_LIMITS.examplesPerSide ||
    draft.syntheticExamples.negative.length > DRAFT_FIELD_LIMITS.examplesPerSide
  ) {
    return {
      ok: false,
      code: "proposal_draft_rejected",
      detail: "Too many synthetic examples.",
    };
  }
  for (const example of [
    ...draft.syntheticExamples.positive,
    ...draft.syntheticExamples.negative,
  ]) {
    if (!example.trim() || example.length > DRAFT_FIELD_LIMITS.example) {
      return {
        ok: false,
        code: "proposal_draft_rejected",
        detail: "Synthetic examples must be non-empty short strings.",
      };
    }
  }
  // The concept label must be rewritten, never the model's proposal.
  if (
    proposedConcept &&
    draft.label.trim().toLowerCase() === proposedConcept.toLowerCase()
  ) {
    return {
      ok: false,
      code: "proposal_draft_rejected",
      detail: "Entry label must be rewritten by the reviewer, not copied.",
    };
  }
  // No private content smuggled into any free-text field: the model-derived
  // proposal text, the typed value, the scope key, and current Entity labels
  // (private references) must not appear verbatim inside the draft.
  const haystack = [
    draft.label,
    draft.definition,
    draft.rationale,
    ...draft.syntheticExamples.positive,
    ...draft.syntheticExamples.negative,
  ]
    .join("\n")
    .toLowerCase();
  const proposedValueText =
    typeof proposedObjectValue === "string" ? proposedObjectValue : null;
  const needles: readonly string[] = [
    proposedConcept,
    proposedValueText === "" || proposedValueText === null
      ? null
      : proposedValueText,
    (candidate?.proposedScopeKey || null),
    ...Object.values(input.entityLabels).filter((label) => label.trim() !== ""),
  ].filter((value): value is string => value !== null && value.trim() !== "");
  for (const needle of needles) {
    if (haystack.includes(needle.toLowerCase())) {
      return {
        ok: false,
        code: "proposal_draft_rejected",
        detail: "Governance draft must not embed candidate or Entity content.",
      };
    }
  }
  return { ok: true };
}

export { CANDIDATE_DISPOSITION_REASON_VERSION, CANDIDATE_REVIEW_POLICY_VERSION };
