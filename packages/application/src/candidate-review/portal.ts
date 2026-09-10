import type {
  MemoryCandidateId,
  UserId,
} from "@sayhear/domain";

import {
  CANDIDATE_REVIEW_POLICY_VERSION,
  REVIEW_STEP_UP_MAX_AGE_MS,
  CandidateReviewAuthError,
  type CandidateEvidenceExcerpt,
  type CandidateReviewAuthDenialReason,
  type CandidateReviewErrorCode,
  type CandidateReviewQueueEntry,
  type ReviewStage,
} from "./types";

/**
 * Candidate Review Portal reads (SPEC #193 §8.5, work package B2).
 *
 * The Portal owns queue queries, the four lifecycle views, deadline-pressure
 * ordering and sensitive Evidence expansion. It never performs a domain write:
 * every operator control (`map_existing`, `reject`, `approve_for_registry_change`,
 * `cancel`, `reconsider`) goes through the B1 Candidate Review / Governance
 * services. The Portal holds the review repository for reads only — it never
 * calls a `cas*` conditional write.
 *
 * Queue payloads carry candidate semantics (concept, typed value, deadlines,
 * predecessor / disposition / trigger) behind the `candidate_review`
 * capability without step-up (ADR-0122 queue-browsing exception). User Evidence
 * verbatim is never copied into the queue; it is only returned by
 * `readCandidateEvidence`, which requires the capability, a 10-minute step-up
 * and a successful content-free audit.
 */

export const CANDIDATE_REVIEW_PORTAL_POLICY_VERSION =
  CANDIDATE_REVIEW_POLICY_VERSION;

export type PortalQueueEntry = Readonly<{
  candidateId: string;
  stage: ReviewStage;
  status: string;
  candidateKind: string;
  basis: string;
  predicateId: string | null;
  proposedConcept: string | null;
  proposedObjectValue: unknown;
  proposedScopeKey: string;
  reviewDueAt: string | null;
  registryReleaseDueAt: string | null;
  terminalContentExpiresAt: string | null;
  /** Milliseconds from `now` to the view's authoritative deadline; null when none. */
  deadlineRemainingMs: number | null;
  /** Which deadline the remaining time is measured against. */
  deadlineKind: "review_30d" | "release_90d" | "terminal_7d" | null;
  predecessorCandidateId: string | null;
  successorTrigger: string | null;
  materialChangeReasonCodes: readonly string[] | null;
  dispositionReasonCode: string | null;
  decidedAt: string | null;
  linkedProposalId: string | null;
  linkedProposalStatus: string | null;
  governanceBlocked: boolean;
}>;

export type PortalQueueViews = Readonly<{
  needsReview: readonly PortalQueueEntry[];
  awaitingRelease: readonly PortalQueueEntry[];
  terminalGrace: readonly PortalQueueEntry[];
  successor: readonly PortalQueueEntry[];
  total: number;
  fetchedAt: string;
}>;

export type { CandidateEvidenceExcerpt } from "./types";

/**
 * Read-only view of the review repository for the Portal. The Portal never
 * holds the `cas*` conditional writes: operator controls go through the B1
 * Candidate Review / Governance services. Structural typing lets the
 * composition pass the full Postgres repository while the Portal type only
 * exposes reads.
 */
export type CandidateReviewPortalRepository = Readonly<{
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
    targetId: string | null;
    disposition: "allowed" | "denied";
    reason: string | null;
    operatorPrincipalId: string;
    policyVersion: string;
    now: Date;
  }): Promise<void>;
  findCandidate(
    userId: UserId,
    candidateId: MemoryCandidateId,
  ): Promise<CandidateReviewQueueEntry["candidate"] | null>;
  listReviewQueue(
    userId: UserId,
    now: Date,
  ): Promise<readonly CandidateReviewQueueEntry[]>;
  readCandidateEvidenceExcerpts(
    userId: UserId,
    candidateId: MemoryCandidateId,
  ): Promise<readonly CandidateEvidenceExcerpt[]>;
}>;

export type CandidateReviewPortalService = Readonly<{
  listPortalQueue(input: {
    userId: UserId;
    authSessionId: string;
  }): Promise<PortalQueueViews>;
  readCandidateEvidence(input: {
    userId: UserId;
    authSessionId: string;
    candidateId: MemoryCandidateId;
  }): Promise<
    | { outcome: "found"; excerpts: readonly CandidateEvidenceExcerpt[] }
    | { outcome: "candidate_not_found" }
  >;
}>;

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function deadlineFor(
  stage: ReviewStage,
  candidate: CandidateReviewQueueEntry["candidate"],
): { at: Date | null; kind: PortalQueueEntry["deadlineKind"] } {
  if (stage === "needs_review") {
    return { at: candidate.reviewDueAt, kind: "review_30d" };
  }
  if (stage === "awaiting_release") {
    return { at: candidate.registryReleaseDueAt, kind: "release_90d" };
  }
  if (stage === "terminal_grace") {
    return { at: candidate.terminalContentExpiresAt, kind: "terminal_7d" };
  }
  // Successor entries are live review candidates with a predecessor: the
  // authoritative pressure is still the 30-day review deadline when present,
  // otherwise the release deadline.
  if (candidate.reviewDueAt) {
    return { at: candidate.reviewDueAt, kind: "review_30d" };
  }
  return { at: candidate.registryReleaseDueAt, kind: "release_90d" };
}

function toPortalEntry(
  entry: CandidateReviewQueueEntry,
  now: Date,
): PortalQueueEntry {
  const { at, kind } = deadlineFor(entry.stage, entry.candidate);
  return {
    candidateId: entry.candidate.memoryCandidateId,
    stage: entry.stage,
    status: entry.candidate.status,
    candidateKind: entry.candidate.candidateKind,
    basis: entry.candidate.basis,
    predicateId: entry.candidate.predicateId,
    proposedConcept: entry.candidate.proposedConcept,
    proposedObjectValue: entry.candidate.proposedObjectValue,
    proposedScopeKey: entry.candidate.proposedScopeKey,
    reviewDueAt: toIso(entry.candidate.reviewDueAt),
    registryReleaseDueAt: toIso(entry.candidate.registryReleaseDueAt),
    terminalContentExpiresAt: toIso(entry.candidate.terminalContentExpiresAt),
    deadlineRemainingMs: at ? at.getTime() - now.getTime() : null,
    deadlineKind: at ? kind : null,
    predecessorCandidateId: entry.candidate.predecessorCandidateId,
    successorTrigger: entry.candidate.successorTrigger,
    materialChangeReasonCodes: entry.candidate.materialChangeReasonCodes,
    dispositionReasonCode: entry.candidate.dispositionReasonCode,
    decidedAt: toIso(entry.candidate.decidedAt),
    linkedProposalId: entry.linkedProposalId,
    linkedProposalStatus: entry.linkedProposalStatus,
    governanceBlocked: entry.governanceBlocked,
  };
}

/**
 * Stable deadline-pressure ordering (SPEC §8.5: first by `review_due_at`,
 * then by `registry_release_due_at` pressure): earliest review deadline
 * first, then earliest release deadline, then earliest terminal expiry, with
 * stable candidate id breaking ties. No model salience, no importance score.
 */
export function sortPortalEntriesByDeadlinePressure(
  entries: readonly PortalQueueEntry[],
): PortalQueueEntry[] {
  const key = (iso: string | null): number =>
    iso === null ? Number.MAX_SAFE_INTEGER : Date.parse(iso);
  return [...entries].sort((left, right) => {
    const review = key(left.reviewDueAt) - key(right.reviewDueAt);
    if (review !== 0) return review;
    const release =
      key(left.registryReleaseDueAt) - key(right.registryReleaseDueAt);
    if (release !== 0) return release;
    const terminal =
      key(left.terminalContentExpiresAt) -
      key(right.terminalContentExpiresAt);
    if (terminal !== 0) return terminal;
    return left.candidateId < right.candidateId
      ? -1
      : left.candidateId > right.candidateId
        ? 1
        : 0;
  });
}

export function createCandidateReviewPortalService(dependencies: {
  repository: CandidateReviewPortalRepository;
  clock: () => Date;
}): CandidateReviewPortalService {
  const { repository, clock } = dependencies;

  async function authorizeQueueRead(input: {
    userId: UserId;
    authSessionId: string;
  }): Promise<void> {
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
    if (result.outcome === "allowed") {
      await repository.recordCandidateReviewAudit({
        userId: input.userId,
        command: "queue_read",
        targetType: "memory_candidate",
        targetId: null,
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
      command: "queue_read",
      targetType: "memory_candidate",
      targetId: null,
      disposition: "denied",
      reason: code,
      operatorPrincipalId: input.userId,
      policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
      now,
    });
    throw new CandidateReviewAuthError(code, result.reason);
  }

  return {
    async listPortalQueue(input) {
      await authorizeQueueRead(input);
      const now = clock();
      const queue = await repository.listReviewQueue(input.userId, now);
      const entries = queue.map((entry) => toPortalEntry(entry, now));
      const needsReview = sortPortalEntriesByDeadlinePressure(
        entries.filter((entry) => entry.stage === "needs_review"),
      );
      const awaitingRelease = sortPortalEntriesByDeadlinePressure(
        entries.filter((entry) => entry.stage === "awaiting_release"),
      );
      const terminalGrace = sortPortalEntriesByDeadlinePressure(
        entries.filter((entry) => entry.stage === "terminal_grace"),
      );
      const successor = sortPortalEntriesByDeadlinePressure(
        entries.filter((entry) => entry.stage === "successor"),
      );
      return {
        needsReview,
        awaitingRelease,
        terminalGrace,
        successor,
        total: entries.length,
        fetchedAt: now.toISOString(),
      };
    },

    async readCandidateEvidence(input) {
      const now = clock();
      const authorized = await repository.authorizeCandidateReview({
        userId: input.userId,
        authSessionId: input.authSessionId,
        capability: "candidate_review",
        now,
        policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
        requireStepUp: true,
        stepUpMaxAgeMs: REVIEW_STEP_UP_MAX_AGE_MS,
      });
      if (authorized.outcome === "denied") {
        const code: Extract<
          CandidateReviewErrorCode,
          "step_up_required" | "recent_step_up_required"
        > =
          authorized.reason === "elevated_capability_required"
            ? "step_up_required"
            : "recent_step_up_required";
        await repository.recordCandidateReviewAudit({
          userId: input.userId,
          command: "queue_read",
          targetType: "memory_candidate",
          targetId: input.candidateId,
          disposition: "denied",
          reason: code,
          operatorPrincipalId: input.userId,
          policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
          now,
        });
        throw new CandidateReviewAuthError(code, authorized.reason);
      }
      const candidate = await repository.findCandidate(
        input.userId,
        input.candidateId,
      );
      if (!candidate) {
        await repository.recordCandidateReviewAudit({
          userId: input.userId,
          command: "queue_read",
          targetType: "memory_candidate",
          targetId: input.candidateId,
          disposition: "denied",
          reason: "candidate_not_found",
          operatorPrincipalId: input.userId,
          policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
          now,
        });
        return { outcome: "candidate_not_found" };
      }
      await repository.recordCandidateReviewAudit({
        userId: input.userId,
        command: "queue_read",
        targetType: "memory_candidate",
        targetId: input.candidateId,
        disposition: "allowed",
        reason: null,
        operatorPrincipalId: input.userId,
        policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
        now,
      });
      const excerpts = await repository.readCandidateEvidenceExcerpts(
        input.userId,
        input.candidateId,
      );
      return { outcome: "found", excerpts };
    },
  };
}
