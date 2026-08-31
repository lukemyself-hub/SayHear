import {
  asMemoryCandidateId,
  asMemoryClaimId,
  asMemoryClaimVersionId,
  type DailySessionId,
  type MemoryCandidateId,
  type MemoryClaimId,
  type MemoryClaimVersionId,
  type UserId,
} from "@sayhear/domain";

import {
  candidateSemanticTarget,
  claimCanonicalKey,
  dedupeFingerprint,
  planClaimAdmission,
  planImpressionDormancy,
  planRejectionDisposition,
  planStaleDisposition,
  predicateReviewDeadline,
} from "./admission";
import {
  MEMORY_ADMISSION_POLICY_VERSION,
  type AdmissionRejectionCode,
  type AdmissibleEvidence,
  type CandidateDispositionPlan,
  type ClaimAdmissionPlan,
  type ClaimVersionQualifierRecord,
  type MemoryCandidateProposal,
  type MemoryCandidateRecord,
  type MemoryClaimRecord,
  type MemoryClaimVersionRecord,
  type RegistryEntryLookup,
  type RelationshipHintProjectionInputs,
} from "./types";
import type { RelationshipResolverHintRecord } from "../relationship-resolver-hints";
import type { ResolverHintLocale } from "../relationship-resolver-hints";
import type { RetrievalProjectionMaterial } from "../memory-retrieval/types";

/**
 * Memory Claim service (SPEC #107 "Claims and admission"): the write-side
 * gatekeeper that turns MemoryCandidates into Claims through deterministic
 * admission only. Model proposals never become state here — every transition
 * is planned by pure validators (admission.ts) and executed transactionally
 * by the repository. Forget (whole-Claim scope) and Reversal follow
 * ADR-0035; Qualifier scope joins with #115 / #120.
 */

export class MemoryCandidateNotFoundError extends Error {
  public constructor(candidateId: string) {
    super(`MemoryCandidate ${candidateId} does not exist for this user.`);
  }
}

export class MemoryClaimNotFoundError extends Error {
  public constructor(claimId: string) {
    super(`MemoryClaim ${claimId} does not exist for this user.`);
  }
}

export class CandidateEvidenceMissingError extends Error {
  public constructor(evidenceItemIds: readonly string[]) {
    super(
      `Candidate evidence references unknown EvidenceItems: ${evidenceItemIds.join(", ")}.`,
    );
  }
}

/** Fail-closed integrity error: admission needs the one active Self Entity. */
export class SelfEntityMissingError extends Error {
  public constructor(userId: string) {
    super(
      `User ${userId} has no active Self Entity; memory admission fails closed until ensure-self-entity converges.`,
    );
  }
}

export class CandidateNotAdmissibleError extends Error {
  public constructor(candidateId: string, status: string) {
    super(
      `MemoryCandidate ${candidateId} with status ${status} is not admissible; only proposed / needs_entity_resolution candidates may run admission.`,
    );
  }
}

export type MemoryClaimRepository = Readonly<{
  // candidates — reads
  findCandidate(
    userId: UserId,
    candidateId: MemoryCandidateId,
  ): Promise<MemoryCandidateRecord | null>;
  findTerminalCandidateByFingerprint(
    userId: UserId,
    fingerprint: string,
  ): Promise<Readonly<{ memoryCandidateId: MemoryCandidateId; dispositionReasonCode: string }> | null>;
  listCandidateEvidenceItemIds(
    userId: UserId,
    candidateId: MemoryCandidateId,
  ): Promise<readonly string[]>;
  // candidates — writes
  insertCandidate(input: {
    proposal: MemoryCandidateProposal;
    status: "proposed" | "needs_predicate_review";
    reviewDueAt: Date | null;
    now: Date;
  }): Promise<MemoryCandidateId>;
  insertCandidateEvidenceLinks(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    evidenceItemIds: readonly string[];
    now: Date;
  }): Promise<void>;
  /** Guarded terminal write: false when the candidate is already terminal (or missing). */
  recordCandidateDisposition(
    userId: UserId,
    candidateId: MemoryCandidateId,
    plan: CandidateDispositionPlan,
    decidedAt: Date,
  ): Promise<boolean>;
  /** Guarded status transition; false when the candidate is not in an admissible state. */
  transitionCandidate(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    fromStatuses: readonly ("proposed" | "needs_entity_resolution")[];
    toStatus: "proposed" | "needs_entity_resolution" | "accepted";
  }): Promise<boolean>;
  // evidence
  describeEvidence(
    userId: UserId,
    evidenceItemIds: readonly string[],
  ): Promise<readonly AdmissibleEvidence[]>;
  // entity substrate
  findSelfEntity(userId: UserId): Promise<Readonly<{ entityId: string }> | null>;
  findCurrentEntityVersions(
    userId: UserId,
    entityIds: readonly string[],
  ): Promise<Readonly<Record<string, Readonly<{ entityVersionId: string; status: string; entityKindId: string }> | null>>>;
  // claims — reads
  findClaimByCanonicalKey(
    userId: UserId,
    canonicalKey: string,
  ): Promise<Readonly<{ memoryClaimId: MemoryClaimId; currentVersionId: MemoryClaimVersionId | null }> | null>;
  loadClaim(userId: UserId, claimId: MemoryClaimId): Promise<MemoryClaimRecord | null>;
  loadClaimVersion(
    userId: UserId,
    versionId: MemoryClaimVersionId,
  ): Promise<MemoryClaimVersionRecord | null>;
  listClaimVersions(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<readonly MemoryClaimVersionRecord[]>;
  listClaimEvidenceItemIds(userId: UserId, claimId: MemoryClaimId): Promise<readonly string[]>;
  // #115: Relationship Qualifiers and Resolver Hint projection reads
  findCurrentPrimaryLabels(
    userId: UserId,
    entityIds: readonly string[],
  ): Promise<Readonly<Record<string, Readonly<{ zh: string | null; en: string | null }>>>>;
  listClaimVersionQualifiers(
    userId: UserId,
    versionId: MemoryClaimVersionId,
  ): Promise<readonly ClaimVersionQualifierRecord[]>;
  listClaimQualifiers(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<readonly ClaimVersionQualifierRecord[]>;
  listRelationshipResolverHints(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<readonly RelationshipResolverHintRecord[]>;
  listResolverHintsForEntity(
    userId: UserId,
    entityId: string,
    locale: ResolverHintLocale,
  ): Promise<readonly RelationshipResolverHintRecord[]>;
  listActiveExcludedEvidenceIds(userId: UserId, claimId: MemoryClaimId): Promise<readonly string[]>;
  listActiveExcludedQualifierKeys(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<readonly Readonly<{
    axisId: string;
    roleSide: "canonical_subject" | "counterpart";
  }>[] >;
  listExcludedQualifierEvidence(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<readonly Readonly<{
    axisId: string;
    roleSide: "canonical_subject" | "counterpart";
    evidenceItemIds: readonly string[];
  }>[] >;
  findAppliedWholeClaimForget(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<Readonly<{ requestId: string }> | null>;
  latestEvidenceAtForVersion(
    userId: UserId,
    versionId: MemoryClaimVersionId,
  ): Promise<Date | null>;
  /**
   * Terminal MemoryCandidate with the same semantic target under a
   * governance reproposal policy — the ADR-0046 gate that ordinary new
   * Evidence cannot override an explicit-reconsideration rejection.
   */
  findTerminalGovernanceBlock(
    userId: UserId,
    semanticTarget: {
      predicateId: string;
      proposedConcept: string;
      subjectEntityId: string | null;
      objectEntityId: string | null;
      scopeKey: string;
      objectValueJson: string;
    },
  ): Promise<Readonly<{ dispositionReasonCode: string }> | null>;
  // claims — transactional plan executors
  executeClaimAdmissionPlan(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    plan: ClaimAdmissionPlan;
    evidenceItemIds: readonly string[];
    lineage: MemoryCandidateProposal["lineage"];
    relationshipHints: RelationshipHintProjectionInputs | null;
    /** #116: retrieval projection material; null leaves maintenance absent. */
    retrievalProjection?: RetrievalProjectionMaterial | null;
    now: Date;
  }): Promise<Readonly<{
    memoryClaimId: MemoryClaimId;
    memoryClaimVersionId: MemoryClaimVersionId;
    revision: number;
    createdClaim: boolean;
  }>>;
  executeDormancyPlan(input: {
    userId: UserId;
    claimId: MemoryClaimId;
    currentVersion: MemoryClaimVersionRecord;
    now: Date;
  }): Promise<Readonly<{ memoryClaimVersionId: MemoryClaimVersionId; revision: number }>>;
  executeWholeClaimForgetPlan(input: {
    userId: UserId;
    claimId: MemoryClaimId;
    requestEventRevisionId: string;
    now: Date;
  }): Promise<Readonly<{
    requestId: string;
    claimVersionId: MemoryClaimVersionId;
    excludedEvidenceCount: number;
  }>>;
  executeForgetReversalPlan(input: {
    userId: UserId;
    claimId: MemoryClaimId;
    requestId: string;
    requestEventRevisionId: string;
    reversalEvidenceId: string;
    claimKind: "objective" | "impression";
    retractedVersionId: MemoryClaimVersionId;
    relationshipHints?: RelationshipHintProjectionInputs | null;
    retrievalProjection?: RetrievalProjectionMaterial | null;
    now: Date;
  }): Promise<Readonly<{ claimVersionId: MemoryClaimVersionId }>>;
  /**
   * #115: rebuild the claim's Resolver Hint rows from its CURRENT version
   * inside one transaction (delete + reinsert; ADR-0027 rebuildable
   * projection). No-op for non-relationship claims.
   */
  executeHintRebuildPlan(input: {
    userId: UserId;
    claimId: MemoryClaimId;
    hints: RelationshipHintProjectionInputs;
    now: Date;
  }): Promise<Readonly<{ rebuiltRows: number }>>;
}>;

export type RecordCandidateOutcome =
  | Readonly<{
      outcome: "recorded";
      candidateId: MemoryCandidateId;
      status: "proposed" | "needs_predicate_review";
      reviewDueAt: Date | null;
    }>
  | Readonly<{
      /** ADR-0046 / ADR-0051: identical Evidence + semantic target is fenced forever. */
      outcome: "blocked_terminal";
      reasonCode: string;
    }>;

export type AdmitCandidateOutcome =
  | Readonly<{
      outcome: "promoted";
      claimId: MemoryClaimId;
      claimVersionId: MemoryClaimVersionId;
      revision: number;
      createdClaim: boolean;
      conflictResolution: string;
    }>
  | Readonly<{
      outcome: "contested";
      claimId: MemoryClaimId;
      claimVersionId: MemoryClaimVersionId;
      revision: number;
    }>
  | Readonly<{
      outcome: "reinforced";
      claimId: MemoryClaimId;
      claimVersionId: MemoryClaimVersionId;
    }>
  | Readonly<{ outcome: "needs_entity_resolution"; candidateId: MemoryCandidateId }>
  | Readonly<{
      outcome: "below_impression_floor";
      candidateId: MemoryCandidateId;
      floor: Readonly<{ minEvidenceItems: number; minDailySessions: number }>;
      actual: Readonly<{ evidenceItems: number; dailySessions: number }>;
    }>
  | Readonly<{ outcome: "pending_conflict"; candidateId: MemoryCandidateId }>
  | Readonly<{ outcome: "blocked_forget_fence"; claimId: MemoryClaimId | null }>
  | Readonly<{
      outcome: "rejected";
      candidateId: MemoryCandidateId;
      reasonCode: string;
      terminalContentExpiresAt: Date;
    }>;

export type ApplyDormancyOutcome =
  | Readonly<{
      outcome: "dormant";
      claimId: MemoryClaimId;
      claimVersionId: MemoryClaimVersionId;
      reviewDeadline: Date;
    }>
  | Readonly<{ outcome: "not_due"; reviewDeadline: Date }>
  | Readonly<{ outcome: "not_applicable" }>;

export type ApplyForgetOutcome =
  | Readonly<{
      outcome: "applied";
      requestId: string;
      claimVersionId: MemoryClaimVersionId;
      excludedEvidenceCount: number;
    }>
  | Readonly<{ outcome: "already_fenced" }>;

export type ApplyReversalOutcome =
  | Readonly<{
      outcome: "restored";
      requestId: string;
      claimVersionId: MemoryClaimVersionId;
    }>
  | Readonly<{ outcome: "not_fenced" }>
  | Readonly<{ outcome: "evidence_ineligible" }>;

export type MemoryClaimService = Readonly<{
  recordCandidate(proposal: MemoryCandidateProposal): Promise<RecordCandidateOutcome>;
  admitCandidate(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
  }): Promise<AdmitCandidateOutcome>;
  rejectCandidate(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    reasonCode: AdmissionRejectionCode;
  }): Promise<{ outcome: "rejected"; terminalContentExpiresAt: Date } | { outcome: "already_terminal" }>;
  staleCandidate(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    staleReason: "predicate_review_expired" | "registry_release_expired";
  }): Promise<
    | { outcome: "stale"; terminalContentExpiresAt: Date }
    | { outcome: "already_terminal" | "missing_original_deadline" }
  >;
  applyImpressionDormancy(input: {
    userId: UserId;
    claimId: MemoryClaimId;
  }): Promise<ApplyDormancyOutcome>;
  applyWholeClaimForget(input: {
    userId: UserId;
    claimId: MemoryClaimId;
    requestEventRevisionId: string;
  }): Promise<ApplyForgetOutcome>;
  applyForgetReversal(input: {
    userId: UserId;
    claimId: MemoryClaimId;
    requestEventRevisionId: string;
    reversalEvidenceId: string;
  }): Promise<ApplyReversalOutcome>;
  inspectClaim(input: {
    userId: UserId;
    claimId: MemoryClaimId;
  }): Promise<
    Readonly<{
      claim: MemoryClaimRecord;
      versions: readonly MemoryClaimVersionRecord[];
      qualifiers: readonly ClaimVersionQualifierRecord[];
      resolverHints: readonly RelationshipResolverHintRecord[];
      evidenceItemIds: readonly string[];
      activeForget: Readonly<{ requestId: string }> | null;
    }> | null
  >;
  /**
   * #115: rebuild the Resolver Hint projection of one claim from its CURRENT
   * version (ADR-0027). Returns 0 rows for non-relationship claims.
   */
  rebuildRelationshipResolverHints(input: {
    userId: UserId;
    claimId: MemoryClaimId;
  }): Promise<Readonly<{ rebuiltRows: number }>>;
}>;

export function createMemoryClaimService(dependencies: {
  repository: MemoryClaimRepository;
  registry: RegistryEntryLookup;
  clock: () => Date;
  dedupeFingerprintSecret: string;
}): MemoryClaimService {
  const { repository, registry, clock } = dependencies;
  if (!dependencies.dedupeFingerprintSecret) {
    throw new Error("dedupeFingerprintSecret must be non-empty.");
  }
  const secret = dependencies.dedupeFingerprintSecret;

  async function requireEvidence(
    userId: UserId,
    evidenceItemIds: readonly string[],
  ): Promise<readonly AdmissibleEvidence[]> {
    if (evidenceItemIds.length === 0) {
      throw new CandidateEvidenceMissingError(evidenceItemIds);
    }
    const evidence = await repository.describeEvidence(userId, evidenceItemIds);
    const found = new Set(evidence.map((item) => item.evidenceItemId));
    const missing = evidenceItemIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new CandidateEvidenceMissingError(missing);
    }
    return evidence;
  }

  function semanticTargetFor(candidate: {
    resolutionStatus: MemoryCandidateRecord["resolutionStatus"];
    predicateId: string | null;
    proposedConcept: string | null;
    proposedObjectValue: MemoryCandidateRecord["proposedObjectValue"];
    proposedScopeKey: string;
    subjectEntityId: string | null;
    objectEntityId: string | null;
  }): string {
    return candidateSemanticTarget({
      resolutionStatus: candidate.resolutionStatus,
      predicateId: candidate.predicateId,
      proposedConcept: candidate.proposedConcept,
      proposedObjectValue: candidate.proposedObjectValue,
      proposedScopeKey: candidate.proposedScopeKey,
      subjectEntityId: candidate.subjectEntityId,
      objectEntityId: candidate.objectEntityId,
    });
  }

  function fingerprintFor(
    userId: UserId,
    semanticTarget: string,
    evidence: readonly AdmissibleEvidence[],
  ): string {
    return dedupeFingerprint({
      secret,
      userId,
      semanticTarget,
      evidenceRevisionIds: evidence.map((item) => item.sourceRevisionId),
      policyVersion: MEMORY_ADMISSION_POLICY_VERSION,
    });
  }

  async function disposeCandidateTerminal(
    userId: UserId,
    candidate: MemoryCandidateRecord,
    plan: CandidateDispositionPlan,
    now: Date,
  ): Promise<Date> {
    await repository.recordCandidateDisposition(
      userId,
      candidate.memoryCandidateId,
      plan,
      now,
    );
    return plan.terminalContentExpiresAt;
  }

  async function rejectWithPlan(
    userId: UserId,
    candidate: MemoryCandidateRecord,
    reasonCode: AdmissionRejectionCode,
    now: Date,
  ): Promise<Date> {
    const evidenceItemIds = await repository.listCandidateEvidenceItemIds(
      userId,
      candidate.memoryCandidateId,
    );
    const evidence = await requireEvidence(userId, evidenceItemIds);
    const plan = planRejectionDisposition({
      userId,
      reasonCode,
      now,
      semanticTarget: semanticTargetFor(candidate),
      evidenceRevisionIds: evidence.map((item) => item.sourceRevisionId),
      secret,
    });
    return disposeCandidateTerminal(userId, candidate, plan, now);
  }

  return {
    async recordCandidate(proposal) {
      const now = clock();
      const evidence = await requireEvidence(proposal.userId, proposal.evidenceItemIds);
      const semanticTarget = semanticTargetFor({
        resolutionStatus: proposal.resolution.status,
        predicateId:
          proposal.resolution.status === "mapped" ? proposal.resolution.predicateId : null,
        proposedConcept:
          proposal.resolution.status === "mapped" ? null : proposal.resolution.proposedConcept,
        proposedObjectValue:
          proposal.resolution.status === "mapped" ? proposal.resolution.typedValue : "",
        proposedScopeKey: proposal.scopeKey,
        subjectEntityId: proposal.subjectEntityId,
        objectEntityId: proposal.objectEntityId,
      });
      const fingerprint = fingerprintFor(proposal.userId, semanticTarget, evidence);
      const terminal = await repository.findTerminalCandidateByFingerprint(
        proposal.userId,
        fingerprint,
      );
      if (terminal) {
        return { outcome: "blocked_terminal", reasonCode: terminal.dispositionReasonCode };
      }
      // ADR-0046: ordinary new Evidence cannot override a governance
      // rejection (explicit reconsideration only). Post-sweep, the registry
      // gates remain the deterministic backstop at admission time.
      const governanceBlock = await repository.findTerminalGovernanceBlock(
        proposal.userId,
        {
          predicateId: proposal.resolution.status === "mapped" ? proposal.resolution.predicateId : "",
          proposedConcept: proposal.resolution.status === "mapped" ? "" : proposal.resolution.proposedConcept,
          subjectEntityId: proposal.subjectEntityId,
          objectEntityId: proposal.objectEntityId,
          scopeKey: proposal.scopeKey,
          objectValueJson: JSON.stringify(
            proposal.resolution.status === "mapped" ? proposal.resolution.typedValue : "",
          ),
        },
      );
      if (governanceBlock) {
        return {
          outcome: "blocked_terminal",
          reasonCode: governanceBlock.dispositionReasonCode,
        };
      }
      const isReview = proposal.resolution.status !== "mapped";
      const deadline = isReview ? predicateReviewDeadline(now) : null;
      const candidateId = await repository.insertCandidate({
        proposal,
        status: isReview ? "needs_predicate_review" : "proposed",
        reviewDueAt: deadline,
        now,
      });
      await repository.insertCandidateEvidenceLinks({
        userId: proposal.userId,
        candidateId,
        evidenceItemIds: proposal.evidenceItemIds,
        now,
      });
      return {
        outcome: "recorded",
        candidateId,
        status: isReview ? "needs_predicate_review" : "proposed",
        reviewDueAt: deadline,
      };
    },

    async admitCandidate({ userId, candidateId }) {
      const now = clock();
      const candidate = await repository.findCandidate(userId, candidateId);
      if (!candidate) {
        throw new MemoryCandidateNotFoundError(candidateId);
      }
      if (candidate.status !== "proposed" && candidate.status !== "needs_entity_resolution") {
        throw new CandidateNotAdmissibleError(candidateId, candidate.status);
      }
      if (candidate.resolutionStatus !== "mapped" || !candidate.predicateId) {
        const expiresAt = await rejectWithPlan(userId, candidate, "predicate_unmapped", now);
        return {
          outcome: "rejected",
          candidateId,
          reasonCode: "predicate_unmapped",
          terminalContentExpiresAt: expiresAt,
        };
      }
      const registryEntry = registry.entryFor(candidate.predicateId);
      if (!registryEntry || registryEntry.status !== "active") {
        const expiresAt = await rejectWithPlan(userId, candidate, "predicate_not_active", now);
        return {
          outcome: "rejected",
          candidateId,
          reasonCode: "predicate_not_active",
          terminalContentExpiresAt: expiresAt,
        };
      }
      const selfEntity = await repository.findSelfEntity(userId);
      if (!selfEntity) {
        throw new SelfEntityMissingError(userId);
      }
      const evidenceItemIds = await repository.listCandidateEvidenceItemIds(userId, candidateId);
      const evidence = await requireEvidence(userId, evidenceItemIds);
      // Scope identity is registry-owned, never model-chosen: a scope-none
      // entry's claim identity is predicate + entities + empty scope. A
      // provider-proposed scope (observed: "new_job") would fragment logical
      // claims across re-statements and break canonical-key recall (issue
      // #126 evidence runs).
      const admittedScopeKey =
        registryEntry.scopeSchema.kind === "none"
          ? ""
          : candidate.proposedScopeKey;
      const canonicalKey = claimCanonicalKey({
        predicateId: candidate.predicateId,
        subjectEntityId: candidate.subjectEntityId ?? "",
        objectEntityId: candidate.objectEntityId,
        scopeKey: admittedScopeKey,
        relationshipDirection: registryEntry.relationshipSemantics?.direction ?? null,
      });
      const existingClaim = await repository.findClaimByCanonicalKey(userId, canonicalKey);
      const currentVersion = existingClaim?.currentVersionId
        ? await repository.loadClaimVersion(userId, existingClaim.currentVersionId)
        : null;
      const entityIds = [candidate.subjectEntityId, candidate.objectEntityId].filter(
        (value): value is string => value !== null,
      );
      const entityVersions = await repository.findCurrentEntityVersions(userId, entityIds);
      const excludedEvidenceIds = existingClaim
        ? await repository.listActiveExcludedEvidenceIds(userId, existingClaim.memoryClaimId)
        : [];
      const excludedQualifierKeys = existingClaim
        ? await repository.listActiveExcludedQualifierKeys(
            userId,
            existingClaim.memoryClaimId,
          )
        : [];
      const excludedQualifierEvidence = existingClaim
        ? await repository.listExcludedQualifierEvidence(
            userId,
            existingClaim.memoryClaimId,
          )
        : [];
      const currentVersionQualifiers =
        existingClaim && currentVersion && registryEntry.relationshipSemantics
          ? await repository.listClaimVersionQualifiers(
              userId,
              currentVersion.memoryClaimVersionId,
            )
          : [];
      const relationshipHints = relationshipHintInputsFor(registry, registryEntry);
      const retrievalProjection = retrievalProjectionInputsFor(registry, registryEntry);

      const plan = planClaimAdmission({
        proposal: {
          ...candidateRecordToProposal(candidate, evidenceItemIds),
          scopeKey: admittedScopeKey,
        },
        registryEntry,
        registryVersion: registry.registryVersion(),
        selfEntityId: selfEntity.entityId,
        entityVersions,
        existingClaim: existingClaim
          ? { memoryClaimId: existingClaim.memoryClaimId, canonicalKey }
          : null,
        currentVersion,
        currentVersionQualifiers,
        evidence,
        excludedEvidenceIds,
        excludedQualifierKeys,
        excludedQualifierEvidence,
      });

      if (
        plan.action === "promote" ||
        plan.action === "contested" ||
        plan.action === "reinforce_current"
      ) {
        const executed = await repository.executeClaimAdmissionPlan({
          userId,
          candidateId,
          plan,
          evidenceItemIds,
          lineage: candidateRecordToLineage(candidate),
          relationshipHints,
          retrievalProjection,
          now,
        });
        await repository.transitionCandidate({
          userId,
          candidateId,
          fromStatuses: ["proposed", "needs_entity_resolution"],
          toStatus: "accepted",
        });
        if (plan.action === "promote") {
          return {
            outcome: "promoted",
            claimId: executed.memoryClaimId,
            claimVersionId: executed.memoryClaimVersionId,
            revision: executed.revision,
            createdClaim: executed.createdClaim,
            conflictResolution: plan.conflictResolution,
          };
        }
        if (plan.action === "contested") {
          return {
            outcome: "contested",
            claimId: executed.memoryClaimId,
            claimVersionId: executed.memoryClaimVersionId,
            revision: executed.revision,
          };
        }
        return {
          outcome: "reinforced",
          claimId: executed.memoryClaimId,
          claimVersionId: executed.memoryClaimVersionId,
        };
      }
      if (plan.action === "needs_entity_resolution") {
        await repository.transitionCandidate({
          userId,
          candidateId,
          fromStatuses: ["proposed", "needs_entity_resolution"],
          toStatus: "needs_entity_resolution",
        });
        return { outcome: "needs_entity_resolution", candidateId };
      }
      if (plan.action === "below_impression_floor") {
        return {
          outcome: "below_impression_floor",
          candidateId,
          floor: plan.floor,
          actual: plan.actual,
        };
      }
      if (plan.action === "pending_conflict") {
        return { outcome: "pending_conflict", candidateId };
      }
      if (plan.action === "blocked_forget_fence") {
        return { outcome: "blocked_forget_fence", claimId: existingClaim?.memoryClaimId ?? null };
      }
      const expiresAt = await rejectWithPlan(userId, candidate, plan.reasonCode, now);
      return {
        outcome: "rejected",
        candidateId,
        reasonCode: plan.reasonCode,
        terminalContentExpiresAt: expiresAt,
      };
    },

    async rejectCandidate({ userId, candidateId, reasonCode }) {
      const now = clock();
      const candidate = await repository.findCandidate(userId, candidateId);
      if (!candidate) {
        throw new MemoryCandidateNotFoundError(candidateId);
      }
      if (candidate.status === "rejected" || candidate.status === "stale") {
        return { outcome: "already_terminal" };
      }
      const expiresAt = await rejectWithPlan(userId, candidate, reasonCode, now);
      return { outcome: "rejected", terminalContentExpiresAt: expiresAt };
    },

    async staleCandidate({ userId, candidateId, staleReason }) {
      const now = clock();
      const candidate = await repository.findCandidate(userId, candidateId);
      if (!candidate) {
        throw new MemoryCandidateNotFoundError(candidateId);
      }
      if (candidate.status === "rejected" || candidate.status === "stale") {
        return { outcome: "already_terminal" };
      }
      const originalDeadline =
        staleReason === "predicate_review_expired"
          ? candidate.reviewDueAt
          : candidate.registryReleaseDueAt;
      if (!originalDeadline) {
        return { outcome: "missing_original_deadline" };
      }
      const evidenceItemIds = await repository.listCandidateEvidenceItemIds(userId, candidateId);
      const evidence = await requireEvidence(userId, evidenceItemIds);
      const plan = planStaleDisposition({
        userId,
        staleReason,
        originalDeadline,
        semanticTarget: semanticTargetFor(candidate),
        evidenceRevisionIds: evidence.map((item) => item.sourceRevisionId),
        secret,
      });
      const expiresAt = await disposeCandidateTerminal(userId, candidate, plan, now);
      return { outcome: "stale", terminalContentExpiresAt: expiresAt };
    },

    async applyImpressionDormancy({ userId, claimId }) {
      const now = clock();
      const claim = await repository.loadClaim(userId, claimId);
      if (!claim?.currentVersionId) {
        throw new MemoryClaimNotFoundError(claimId);
      }
      const currentVersion = await repository.loadClaimVersion(userId, claim.currentVersionId);
      if (!currentVersion) {
        throw new MemoryClaimNotFoundError(claimId);
      }
      const latestEvidenceAt = await repository.latestEvidenceAtForVersion(
        userId,
        currentVersion.memoryClaimVersionId,
      );
      const plan = planImpressionDormancy({
        currentVersion,
        latestQualifyingEvidenceAt: latestEvidenceAt,
        now,
      });
      if (plan.outcome === "not_applicable") {
        return { outcome: "not_applicable" };
      }
      if (plan.outcome === "remain_active") {
        return { outcome: "not_due", reviewDeadline: plan.reviewDeadline! };
      }
      const executed = await repository.executeDormancyPlan({
        userId,
        claimId,
        currentVersion,
        now,
      });
      return {
        outcome: "dormant",
        claimId,
        claimVersionId: executed.memoryClaimVersionId,
        reviewDeadline: plan.reviewDeadline!,
      };
    },

    async applyWholeClaimForget({ userId, claimId, requestEventRevisionId }) {
      const now = clock();
      const claim = await repository.loadClaim(userId, claimId);
      if (!claim?.currentVersionId) {
        throw new MemoryClaimNotFoundError(claimId);
      }
      const currentVersion = await repository.loadClaimVersion(userId, claim.currentVersionId);
      if (!currentVersion) {
        throw new MemoryClaimNotFoundError(claimId);
      }
      // The fence is the claim state: a retracted current version means the
      // claim is forgotten; a reversed fence allows a fresh forget request.
      if (currentVersion.status === "retracted") {
        return { outcome: "already_fenced" };
      }
      const executed = await repository.executeWholeClaimForgetPlan({
        userId,
        claimId,
        requestEventRevisionId,
        now,
      });
      return { outcome: "applied", ...executed };
    },

    async applyForgetReversal({ userId, claimId, requestEventRevisionId, reversalEvidenceId }) {
      const now = clock();
      const claim = await repository.loadClaim(userId, claimId);
      if (!claim?.currentVersionId) {
        throw new MemoryClaimNotFoundError(claimId);
      }
      const activeForget = await repository.findAppliedWholeClaimForget(userId, claimId);
      const currentVersion = await repository.loadClaimVersion(userId, claim.currentVersionId);
      if (!activeForget || !currentVersion || currentVersion.status !== "retracted") {
        return { outcome: "not_fenced" };
      }
      const [reversalEvidence] = await repository.describeEvidence(userId, [reversalEvidenceId]);
      if (
        !reversalEvidence ||
        reversalEvidence.sourceActor !== "user" ||
        (reversalEvidence.sourceStatus !== "final" && reversalEvidence.sourceStatus !== "corrected") ||
        reversalEvidence.status !== "active"
      ) {
        return { outcome: "evidence_ineligible" };
      }
      const excluded = await repository.listActiveExcludedEvidenceIds(userId, claimId);
      if (excluded.includes(reversalEvidenceId)) {
        // Old Evidence stays unusable; the reversal event must be new words.
        return { outcome: "evidence_ineligible" };
      }
      const reversalEntry = registry.entryFor(claim.predicateId);
      const executed = await repository.executeForgetReversalPlan({
        userId,
        claimId,
        requestId: activeForget.requestId,
        requestEventRevisionId,
        reversalEvidenceId,
        claimKind: currentVersion.kind,
        retractedVersionId: currentVersion.memoryClaimVersionId,
        relationshipHints: reversalEntry
          ? relationshipHintInputsFor(registry, reversalEntry)
          : null,
        retrievalProjection: reversalEntry
          ? retrievalProjectionInputsFor(registry, reversalEntry)
          : null,
        now,
      });
      return {
        outcome: "restored",
        requestId: activeForget.requestId,
        claimVersionId: executed.claimVersionId,
      };
    },

    async inspectClaim({ userId, claimId }) {
      const claim = await repository.loadClaim(userId, claimId);
      if (!claim) {
        return null;
      }
      const [versions, evidenceItemIds, activeForget, qualifiers, resolverHints] =
        await Promise.all([
          repository.listClaimVersions(userId, claimId),
          repository.listClaimEvidenceItemIds(userId, claimId),
          repository.findAppliedWholeClaimForget(userId, claimId),
          repository.listClaimQualifiers(userId, claimId),
          repository.listRelationshipResolverHints(userId, claimId),
        ]);
      return {
        claim,
        versions,
        qualifiers,
        resolverHints,
        evidenceItemIds,
        activeForget,
      };
    },

    async rebuildRelationshipResolverHints({ userId, claimId }) {
      const claim = await repository.loadClaim(userId, claimId);
      if (!claim) {
        throw new MemoryClaimNotFoundError(claimId);
      }
      const entry = registry.entryFor(claim.predicateId);
      if (!entry || !entry.relationshipSemantics) {
        return { rebuiltRows: 0 };
      }
      const hints = relationshipHintInputsFor(registry, entry);
      if (!hints) {
        return { rebuiltRows: 0 };
      }
      const executed = await repository.executeHintRebuildPlan({
        userId,
        claimId,
        hints,
        now: clock(),
      });
      return { rebuiltRows: executed.rebuiltRows };
    },
  };
}

/**
 * Registry material for retrieval projection planning, or null when the
 * lookup does not expose localizations (narrow test doubles); projection
 * maintenance then stays absent and the query-time fences hold.
 */
export function retrievalProjectionInputsFor(
  registry: RegistryEntryLookup,
  entry: NonNullable<ReturnType<RegistryEntryLookup["entryFor"]>>,
): RetrievalProjectionMaterial | null {
  if (!registry.predicateLocalizationsFor) return null;
  return {
    entry,
    localizations: registry.predicateLocalizationsFor(entry.predicateId),
  };
}

/**
 * Registry material for hint projection, or null when the entry is not a
 * relationship, publishes no hint projections, or the registry lookup does
 * not expose the projection material (narrow test doubles). Shared by the
 * Memory Claim service and the consolidation run commit.
 */
export function relationshipHintInputsFor(
  registry: RegistryEntryLookup,
  entry: NonNullable<ReturnType<RegistryEntryLookup["entryFor"]>>,
): RelationshipHintProjectionInputs | null {
  if (!entry.relationshipSemantics) return null;
  if (!entry.temporalSemantics.resolverHintProjections) return null;
  if (!registry.relationshipProjectionsFor || !registry.predicateLocalizationsFor) {
    return null;
  }
  return {
    entry,
    projections: registry.relationshipProjectionsFor(entry.predicateId),
    localizations: registry.predicateLocalizationsFor(entry.predicateId),
  };
}

function candidateRecordToProposal(
  candidate: MemoryCandidateRecord,
  evidenceItemIds: readonly string[],
): MemoryCandidateProposal {
  return {
    userId: candidate.userId,
    candidateKind: candidate.candidateKind,
    basis: candidate.basis,
    resolution:
      candidate.resolutionStatus === "mapped"
        ? {
            status: "mapped",
            predicateId: candidate.predicateId!,
            registryVersion: candidate.predicateRegistryVersion!,
            typedValue: candidate.proposedObjectValue,
            mappingConfidence: candidate.mappingConfidence,
          }
        : {
            status: candidate.resolutionStatus,
            proposedConcept: candidate.proposedConcept ?? "",
          },
    subjectEntityId: candidate.subjectEntityId,
    subjectEntityMentionId: null,
    objectEntityId: candidate.objectEntityId,
    objectEntityMentionId: null,
    scopeKey: candidate.proposedScopeKey,
    temporal: candidate.temporal,
    qualifiers: candidate.proposedQualifiers,
    evidenceItemIds,
    lineage: candidateRecordToLineage(candidate),
  };
}

function candidateRecordToLineage(
  candidate: MemoryCandidateRecord,
): MemoryCandidateProposal["lineage"] {
  return {
    extractionPolicyVersion: candidate.extractionPolicyVersion,
    generationCommandId: candidate.generationCommandId,
    authoritativeModelAttemptId: candidate.authoritativeModelAttemptId,
    modelVersion: candidate.modelVersion,
    promptVersion: candidate.promptVersion,
    sourceReflectionVersionId: candidate.sourceReflectionVersionId,
  };
}
