import type { PredicateChangeProposalId, UserId } from "@sayhear/domain";

import {
  CANDIDATE_REVIEW_POLICY_VERSION,
  REVIEW_STEP_UP_MAX_AGE_MS,
  CandidateReviewAuthError,
  type CancelOutcome,
  type CandidateReviewErrorCode,
  type CandidateReviewAuthDenialReason,
  type CandidateReviewRepository,
  type PredicateChangeProposalVersionRecord,
  type ReconsiderOutcome,
  type ReviewerProposalDraft,
} from "./types";
import { validateProposalEntryDraft } from "./review";

/**
 * Predicate Registry Governance Module (SPEC #193 §8.1–8.3, ADR-0050 /
 * ADR-0053 / ADR-0122): owns the Proposal lifecycle — `cancel` of an
 * awaiting-release Proposal and Proposal-level explicit reconsideration —
 * plus the typed link validation for review-time association.
 *
 * The module never publishes the Registry and never creates a Memory Claim:
 * Registry release stays a code/migration handoff (ADR-0122), and Claims are
 * created only by deterministic admission (ADR-0049). Proposal versions are
 * append-only and immutable; only a legal superseding version lifts a
 * product-value governance block.
 */

export type PredicateGovernanceService = Readonly<{
  cancel(input: {
    userId: UserId;
    authSessionId: string;
    proposalId: PredicateChangeProposalId;
  }): Promise<CancelOutcome>;
  reconsider(input: {
    userId: UserId;
    authSessionId: string;
    proposalId: PredicateChangeProposalId;
    draft: ReviewerProposalDraft;
  }): Promise<ReconsiderOutcome>;
  /** Typed read for B2/A4: full immutable version history. */
  describeProposal(input: {
    userId: UserId;
    authSessionId: string;
    proposalId: PredicateChangeProposalId;
  }): Promise<
    | {
        outcome: "found";
        proposal: Awaited<
          ReturnType<CandidateReviewRepository["findProposal"]>
        >;
        versions: readonly PredicateChangeProposalVersionRecord[];
      }
    | { outcome: "not_found" }
  >;
  /**
   * Governance gate over `matched_governance` citations (SPEC §8.3): only the
   * CURRENT ProposalVersion is validated; a current rejected version blocks
   * queue entry, mapping, admission and Claim promotion until a legal
   * superseding version exists. No text-similarity auto-matching.
   */
  assertProposalAllowsGovernedUse(input: {
    proposalId: PredicateChangeProposalId;
  }): Promise<
    | { outcome: "allowed"; version: PredicateChangeProposalVersionRecord }
    | { outcome: "proposal_not_found" }
    | { outcome: "reconsideration_blocked_by_rejected_version" }
  >;
}>;

/** Re-exported for the module index (types.ts owns the definition). */
export type { CancelOutcome } from "./types";

export function createPredicateGovernanceService(dependencies: {
  repository: CandidateReviewRepository;
  clock: () => Date;
  registryVersion: () => number;
}): PredicateGovernanceService {
  const { repository, clock } = dependencies;

  async function authorize(
    input: { userId: UserId; authSessionId: string },
    command: "cancel" | "reconsider",
    proposalId: PredicateChangeProposalId,
  ): Promise<void> {
    const now = clock();
    const result = await repository.authorizeCandidateReview({
      userId: input.userId,
      authSessionId: input.authSessionId,
      capability: "candidate_review",
      now,
      policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
      requireStepUp: true,
      stepUpMaxAgeMs: REVIEW_STEP_UP_MAX_AGE_MS,
    });
    if (result.outcome === "allowed") {
      await repository.recordCandidateReviewAudit({
        userId: input.userId,
        command,
        targetType: "predicate_change_proposal",
        targetId: proposalId,
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
      targetType: "predicate_change_proposal",
      targetId: proposalId,
      disposition: "denied",
      reason: code,
      operatorPrincipalId: input.userId,
      policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
      now,
    });
    throw new CandidateReviewAuthError(code, result.reason);
  }

  return {
    async cancel(input) {
      await authorize(input, "cancel", input.proposalId);
      const result = await repository.casCancelProposal({
        proposalId: input.proposalId,
        now: clock(),
      });
      if (result.outcome === "canceled") {
        return {
          outcome: "applied",
          staledCandidateCount: result.staledCandidateCount,
        };
      }
      if (result.outcome === "already_canceled") {
        return { outcome: "already_canceled", staledCandidateCount: 0 };
      }
      if (result.outcome === "not_found") {
        return { outcome: "proposal_not_found", staledCandidateCount: 0 };
      }
      return { outcome: "proposal_not_awaiting_release", staledCandidateCount: 0 };
    },

    async reconsider(input) {
      await authorize(input, "reconsider", input.proposalId);
      const proposal = await repository.findProposal(input.proposalId);
      if (!proposal) {
        return { outcome: "proposal_not_found", versionAfter: null };
      }
      const current = await repository.findCurrentProposalVersion(
        input.proposalId,
      );
      if (!current || current.status !== "rejected") {
        return { outcome: "proposal_not_rejected", versionAfter: current };
      }
      const draftCheck = validateProposalEntryDraft({
        draft: input.draft,
        candidate: null,
        entityLabels: {},
      });
      if (!draftCheck.ok) {
        return { outcome: "proposal_draft_rejected", versionAfter: current };
      }
      const result = await repository.appendReconsideredProposalVersion({
        proposalId: input.proposalId,
        draft: {
          ...input.draft,
          baseRegistryVersion: dependencies.registryVersion(),
        },
        reviewerPrincipalId: input.userId,
        baseRegistryVersion: dependencies.registryVersion(),
        decidedAt: clock(),
      });
      if (result.outcome === "applied") {
        return { outcome: "applied", versionAfter: result.version };
      }
      if (result.outcome === "not_found") {
        return { outcome: "proposal_not_found", versionAfter: null };
      }
      return { outcome: "proposal_not_rejected", versionAfter: current };
    },

    async describeProposal(input) {
      // Proposal reads are governance reads: capability without step-up
      // (ADR-0122 queue-browsing exception), content-free audit only.
      const now = clock();
      const result = await repository.authorizeCandidateReview({
        userId: input.userId,
        authSessionId: input.authSessionId,
        capability: "candidate_review",
        now,
        policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
        requireStepUp: false,
        stepUpMaxAgeMs: REVIEW_STEP_UP_MAX_AGE_MS,
      });
      if (result.outcome === "denied") {
        const reason: CandidateReviewAuthDenialReason = result.reason;
        await repository.recordCandidateReviewAudit({
          userId: input.userId,
          command: "proposal_read",
          targetType: "predicate_change_proposal",
          targetId: input.proposalId,
          disposition: "denied",
          reason: reason === "elevated_capability_required" ? "step_up_required" : "recent_step_up_required",
          operatorPrincipalId: input.userId,
          policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
          now,
        });
        throw new CandidateReviewAuthError(
          reason === "elevated_capability_required"
            ? "step_up_required"
            : "recent_step_up_required",
          reason,
        );
      }
      await repository.recordCandidateReviewAudit({
        userId: input.userId,
        command: "proposal_read",
        targetType: "predicate_change_proposal",
        targetId: input.proposalId,
        disposition: "allowed",
        reason: null,
        operatorPrincipalId: input.userId,
        policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
        now,
      });
      const proposal = await repository.findProposal(input.proposalId);
      if (!proposal) {
        return { outcome: "not_found" };
      }
      const versions = await repository.listProposalVersions(input.proposalId);
      return { outcome: "found", proposal, versions };
    },

    async assertProposalAllowsGovernedUse(input) {
      const current = await repository.findCurrentProposalVersion(
        input.proposalId,
      );
      if (!current) {
        return { outcome: "proposal_not_found" };
      }
      if (current.status === "rejected") {
        return { outcome: "reconsideration_blocked_by_rejected_version" };
      }
      return { outcome: "allowed", version: current };
    },
  };
}
