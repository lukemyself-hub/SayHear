import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  BioCoverageUnitId,
  BioId,
  BioVersionId,
  EvidenceItemId,
  MemoryCandidateId,
  MemoryClaimId,
  MemoryClaimVersionId,
  ReflectionAtomicPropositionId,
  ReflectionId,
  ReflectionStatementId,
  ReflectionVersionId,
  UserId,
} from "@sayhear/domain";

import type { RecoveryGate } from "./recovery-gate";
import type {
  ReflectionScopeType,
  ReflectionStatementKind,
  ReflectionVersionStatus,
} from "./reflection/types";

export const REFLECTION_INSPECTION_CAPABILITY =
  "reflection_inspection:read" as const;
export const REFLECTION_INSPECTION_POLICY_VERSION =
  "reflection-inspection:v1" as const;
export const REFLECTION_EVIDENCE_CAPABILITY =
  "conversation_content:read" as const;
export const REFLECTION_INSPECTION_DEFAULT_LIMIT = 25;
export const REFLECTION_INSPECTION_MAX_LIMIT = 100;
export const REFLECTION_INSPECTION_STEP_UP_MAX_AGE_MS = 10 * 60 * 1_000;

export type ReflectionInspectionLayer =
  | "reflections"
  | "versions"
  | "statements"
  | "propositions"
  | "evidence"
  | "candidates"
  | "candidate_predecessors"
  | "candidate_successors"
  | "claims"
  | "bio_impact";

export type ReflectionInspectionCursorLayer =
  | ReflectionInspectionLayer
  | "evidence_content";

export type ReflectionInspectionFilters = Readonly<{
  candidateId?: MemoryCandidateId;
  fromDate?: string;
  reflectionVersionId?: ReflectionVersionId;
  scopeType?: ReflectionScopeType;
  status?: readonly ReflectionVersionStatus[];
  toDate?: string;
}>;

export type ReflectionInspectionContentState =
  | "available"
  | "content_expired"
  | "content_purged"
  | "source_invalidated";

export type ReflectionInspectionUnavailableOutcome =
  | "content_expired"
  | "content_purged"
  | "no_current_version"
  | "source_invalidated"
  | "target_missing";

export type ReflectionInspectionPage<T> = Readonly<{
  outcome: "ok";
  items: readonly T[];
  nextCursor: string | null;
  snapshot: string;
}>;

export type ReflectionInspectionLayerResult<T> =
  | ReflectionInspectionPage<T>
  | Readonly<{ outcome: "no_record" }>
  | Readonly<{
      outcome: Exclude<ReflectionInspectionUnavailableOutcome, "no_current_version">;
      reflectionId: ReflectionId | null;
      reflectionVersionId: ReflectionVersionId | null;
    }>
  | Readonly<{
      outcome: "state_changed";
      reflectionId: ReflectionId;
      expectedVersionId: ReflectionVersionId | null;
      currentVersionId: ReflectionVersionId | null;
    }>;

export type ReflectionInspectionVersionMetadata = Readonly<{
  authoritativeModelAttemptId: string | null;
  attemptKind: string | null;
  attemptStatus: string | null;
  generationCommandId: string | null;
  model: string | null;
  modelConfigVersion: string | null;
  modelSnapshot: string | null;
  modelRole: string | null;
  policyVersion: string | null;
  provider: string | null;
  providerPolicyVersion: string | null;
  rolloutPin: string | null;
  schedulePolicyVersion: string | null;
  validationPolicyVersion: string | null;
  validationPromptVersion: string | null;
  validationSchemaVersion: string | null;
  validationBlockingFindingCodes: readonly string[];
  validationAdvisoryFindingCodes: readonly string[];
  validationCoveredKeys: readonly string[];
  validationUncoveredPlannedKeys: readonly string[];
  validationVerdict: "accepted" | "blocked" | null;
  validatorRequestId: string | null;
  validatorResultId: string | null;
}>;

export type ReflectionInspectionVersionSummary = Readonly<{
  contentState: ReflectionInspectionContentState;
  current: boolean;
  degradedEpisodeReason: string | null;
  locale: string;
  metadata: ReflectionInspectionVersionMetadata;
  promptVersion: string;
  revision: number;
  schemaVersion: string;
  sourceDigest: string | null;
  sourceRevision: number;
  status: ReflectionVersionStatus;
  versionId: ReflectionVersionId;
}>;

export type ReflectionInspectionReflection = Readonly<{
  createdAt: string;
  current: ReflectionInspectionVersionSummary | null;
  currentOutcome: ReflectionInspectionUnavailableOutcome | null;
  currentVersionId: ReflectionVersionId | null;
  dailySessionId: string | null;
  logicalDate: string | null;
  reflectionId: ReflectionId;
  scopeType: ReflectionScopeType;
  weekIdentifier: string | null;
  windowEndDate: string | null;
  windowStartDate: string | null;
}>;

export type ReflectionInspectionStatement = Readonly<{
  contentState: ReflectionInspectionContentState;
  statementId: ReflectionStatementId;
  statementIndex: number;
  statementKind: ReflectionStatementKind;
  statementText: string | null;
}>;

export type ReflectionInspectionProposition = Readonly<{
  baselineClaimIds: readonly string[];
  contentState: ReflectionInspectionContentState;
  epistemicRendering: "confirmed" | "inferred";
  propositionId: ReflectionAtomicPropositionId;
  propositionIndex: number;
  propositionKind: "fact" | "impression" | "synthesis";
  propositionText: string | null;
}>;

export type ReflectionInspectionEvidenceLink = Readonly<{
  evidenceItemId: EvidenceItemId;
  evidenceLinkId: string;
  locatorKey: string;
  locatorType: "whole_revision" | "segment" | "text_span" | "time_range";
  locale: string | null;
  logicalDate: string | null;
  sourceEventId: string;
  sourceRevision: number;
  sourceRevisionId: string;
  sourceStatus: "final" | "corrected" | null;
  sourceOutcome: "available" | "content_purged" | "source_invalidated" | "target_missing";
}>;

export type ReflectionInspectionCandidate = Readonly<{
  candidateId: MemoryCandidateId | null;
  candidateEvidenceItemIds: readonly EvidenceItemId[];
  candidateStatus:
    | "proposed"
    | "needs_entity_resolution"
    | "needs_predicate_review"
    | "awaiting_registry_release"
    | "accepted"
    | "rejected"
    | "stale"
    | "deleted"
    | null;
  contentState: ReflectionInspectionContentState;
  createdAt: string;
  decidedAt: string | null;
  dispositionPolicyVersion: string | null;
  dispositionReasonCode: string | null;
  materialChangeReasonCodes: readonly string[];
  outcome: "created" | "blocked_terminal" | "skipped";
  predecessorCandidateId: MemoryCandidateId | null;
  proposalId: string;
  registryReleaseDueAt: string | null;
  reviewDueAt: string | null;
  successorTrigger: "materially_new_evidence" | "explicit_reconsideration" | null;
  terminalContentExpiresAt: string | null;
  terminalEffectiveAt: string | null;
}>;

export type ReflectionInspectionCandidateSuccessor = Readonly<{
  candidateId: MemoryCandidateId;
  contentPurged: boolean;
  createdAt: string;
  decidedAt: string | null;
  dispositionPolicyVersion: string | null;
  dispositionReasonCode: string | null;
  materialChangeReasonCodes: readonly string[];
  predecessorCandidateId: MemoryCandidateId | null;
  registryReleaseDueAt: string | null;
  reviewDueAt: string | null;
  status: ReflectionInspectionCandidate["candidateStatus"];
  successorTrigger: ReflectionInspectionCandidate["successorTrigger"];
  terminalContentExpiresAt: string | null;
  terminalEffectiveAt: string | null;
}>;

export type ReflectionInspectionClaimImpact = Readonly<{
  claimId: MemoryClaimId | null;
  claimVersionId: MemoryClaimVersionId | null;
  diffId: string;
  diffKind: string;
  eligibility:
    | "eligible"
    | "superseded"
    | "forgotten"
    | "contested"
    | "dormant"
    | "entity_invalid"
    | "not_eligible"
    | "no_record"
    | "content_purged";
  isCurrentVersion: boolean;
  outcome: string;
  revision: number | null;
  status: string | null;
}>;

export type ReflectionInspectionBioImpact = Readonly<{
  bioCoverageUnitId: BioCoverageUnitId | null;
  bioId: BioId;
  bioVersionId: BioVersionId;
  coverageDisposition:
    | "covered"
    | "deferred_by_budget"
    | "background_absent"
    | "excluded_by_policy"
    | "stale"
    | null;
  coveragePolicyVersion: string | null;
  current: boolean;
  expectedDataEpoch: number;
  linkRole: "input" | "support";
  revision: number;
  sourceRevision: number;
  status: string;
  supportStatus:
    | "eligible"
    | "deferred_by_budget"
    | "invalidated"
    | "missing";
  unitKey: string | null;
}>;

export type ReflectionInspectionEvidenceExpansion =
  | Readonly<{
      outcome: "allowed";
      evidenceItemId: EvidenceItemId;
      locale: string | null;
      logicalDate: string | null;
      locatorKey: string;
      locatorType: ReflectionInspectionEvidenceLink["locatorType"];
      sourceEventId: string;
      sourceRevisionId: string;
      sourceStatus: "final" | "corrected";
      text: string;
    }>
  | Readonly<{
      outcome:
        | "content_purged"
        | "source_invalidated"
        | "target_missing";
      evidenceItemId: EvidenceItemId;
    }>
  | Readonly<{
      outcome: "denied";
      evidenceItemId: EvidenceItemId;
      reason: "elevated_capability_required" | "recent_step_up_required";
    }>;

export type ReflectionInspectionCursorPayload = Readonly<{
  after: readonly string[];
  filter: string;
  layer: ReflectionInspectionCursorLayer;
  limit: number;
  owner: UserId;
  snapshot: string;
  sort: string;
  version: 1;
}>;

export type ReflectionInspectionRepository = Readonly<{
  authorizeReflectionInspection(input: Readonly<{
    authSessionId: string;
    userId: UserId;
  }>): Promise<Readonly<{ outcome: "allowed" }> | Readonly<{
    outcome: "denied";
    reason: "reflection_capability_required";
  }>>;
  expandEvidence(input: Readonly<{
    authSessionId: string;
    evidenceItemId: EvidenceItemId;
    now: Date;
    policyVersion: string;
    stepUpMaxAgeMs: number;
    userId: UserId;
  }>): Promise<ReflectionInspectionEvidenceExpansion>;
  listBioImpacts(input: Readonly<{
    cursor: string | null;
    limit: number;
    memoryClaimVersionId: MemoryClaimVersionId;
    userId: UserId;
  }>): Promise<ReflectionInspectionLayerResult<ReflectionInspectionBioImpact>>;
  listCandidateSuccessors(input: Readonly<{
    candidateId: MemoryCandidateId;
    cursor: string | null;
    limit: number;
    userId: UserId;
  }>): Promise<ReflectionInspectionLayerResult<ReflectionInspectionCandidateSuccessor>>;
  listCandidatePredecessors(input: Readonly<{
    candidateId: MemoryCandidateId;
    cursor: string | null;
    limit: number;
    userId: UserId;
  }>): Promise<ReflectionInspectionLayerResult<ReflectionInspectionCandidateSuccessor>>;
  listCandidates(input: Readonly<{
    cursor: string | null;
    expectedCurrentVersionId: ReflectionVersionId | null;
    limit: number;
    reflectionVersionId: ReflectionVersionId;
    userId: UserId;
  }>): Promise<ReflectionInspectionLayerResult<ReflectionInspectionCandidate>>;
  listClaimImpacts(input: Readonly<{
    candidateId: MemoryCandidateId;
    cursor: string | null;
    limit: number;
    userId: UserId;
  }>): Promise<ReflectionInspectionLayerResult<ReflectionInspectionClaimImpact>>;
  listEvidenceLinks(input: Readonly<{
    cursor: string | null;
    expectedCurrentVersionId: ReflectionVersionId | null;
    limit: number;
    propositionId: ReflectionAtomicPropositionId;
    userId: UserId;
  }>): Promise<ReflectionInspectionLayerResult<ReflectionInspectionEvidenceLink>>;
  listPropositions(input: Readonly<{
    cursor: string | null;
    expectedCurrentVersionId: ReflectionVersionId | null;
    limit: number;
    statementId: ReflectionStatementId;
    userId: UserId;
  }>): Promise<ReflectionInspectionLayerResult<ReflectionInspectionProposition>>;
  listReflections(input: Readonly<{
    cursor: string | null;
    filters: ReflectionInspectionFilters;
    limit: number;
    userId: UserId;
  }>): Promise<ReflectionInspectionPage<ReflectionInspectionReflection>>;
  listStatements(input: Readonly<{
    cursor: string | null;
    expectedCurrentVersionId: ReflectionVersionId | null;
    limit: number;
    reflectionVersionId: ReflectionVersionId;
    userId: UserId;
  }>): Promise<ReflectionInspectionLayerResult<ReflectionInspectionStatement>>;
  listVersions(input: Readonly<{
    cursor: string | null;
    expectedCurrentVersionId: ReflectionVersionId | null;
    limit: number;
    reflectionId: ReflectionId;
    userId: UserId;
  }>): Promise<ReflectionInspectionLayerResult<ReflectionInspectionVersionSummary>>;
  readReflection(input: Readonly<{
    expectedCurrentVersionId: ReflectionVersionId | null;
    reflectionId: ReflectionId;
    userId: UserId;
  }>): Promise<
    | ReflectionInspectionReflection
    | Readonly<{ outcome: "no_record" }>
    | Readonly<{
        outcome: "state_changed";
        reflectionId: ReflectionId;
        expectedVersionId: ReflectionVersionId | null;
        currentVersionId: ReflectionVersionId | null;
      }>
    | Readonly<{
        outcome: "no_current_version" | "content_expired" | "content_purged" | "source_invalidated" | "target_missing";
        reflectionId: ReflectionId;
        reflectionVersionId: ReflectionVersionId | null;
      }>
  >;
}>;

export class ReflectionInspectionDeniedError extends Error {
  public constructor() {
    super("Reflection inspection capability is not authorized.");
    this.name = "ReflectionInspectionDeniedError";
  }
}

export class ReflectionInspectionCursorError extends Error {
  public constructor() {
    super("The Reflection Inspector cursor is invalid or no longer matches the query.");
    this.name = "ReflectionInspectionCursorError";
  }
}

export class ReflectionInspectionLimitError extends Error {
  public constructor() {
    super("Reflection Inspector limit must be a positive integer.");
    this.name = "ReflectionInspectionLimitError";
  }
}

export class ReflectionInspectionAuditError extends Error {
  public constructor() {
    super("Reflection Evidence access audit failed closed.");
    this.name = "ReflectionInspectionAuditError";
  }
}

export function normalizeReflectionInspectionLimit(value: number | undefined): number {
  if (value === undefined) return REFLECTION_INSPECTION_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value <= 0) {
    throw new ReflectionInspectionLimitError();
  }
  return Math.min(value, REFLECTION_INSPECTION_MAX_LIMIT);
}

export function reflectionInspectionFilterFingerprint(
  filters: ReflectionInspectionFilters,
): string {
  return JSON.stringify({
    candidateId: filters.candidateId ?? null,
    fromDate: filters.fromDate ?? null,
    reflectionVersionId: filters.reflectionVersionId ?? null,
    scopeType: filters.scopeType ?? null,
    status: [...(filters.status ?? [])].sort(),
    toDate: filters.toDate ?? null,
  });
}

function cursorMac(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function encodeReflectionInspectionCursor(
  payload: ReflectionInspectionCursorPayload,
  secret: string,
): string {
  if (!secret) throw new Error("Reflection inspection cursor secret is required.");
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encodedPayload}.${cursorMac(encodedPayload, secret)}`;
}

export function decodeReflectionInspectionCursor(
  token: string,
  secret: string,
): ReflectionInspectionCursorPayload | null {
  if (!token || !secret) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const encodedPayload = token.slice(0, separator);
  const suppliedMac = token.slice(separator + 1);
  const expectedMac = cursorMac(encodedPayload, secret);
  const supplied = Buffer.from(suppliedMac, "base64url");
  const expected = Buffer.from(expectedMac, "base64url");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<ReflectionInspectionCursorPayload>;
    const parsedLimit = parsed.limit;
    if (
      parsed.version !== 1 ||
      typeof parsed.owner !== "string" ||
      typeof parsed.layer !== "string" ||
      typeof parsed.filter !== "string" ||
      typeof parsed.sort !== "string" ||
      typeof parsedLimit !== "number" ||
      !Number.isInteger(parsedLimit) ||
      parsedLimit <= 0 ||
      typeof parsed.snapshot !== "string" ||
      !Array.isArray(parsed.after) ||
      !parsed.after.every((value) => typeof value === "string")
    ) {
      return null;
    }
    return { ...parsed, limit: parsedLimit } as ReflectionInspectionCursorPayload;
  } catch {
    return null;
  }
}

export type ReflectionInspectionService = Readonly<{
  authorize(userId: UserId, authSessionId: string): Promise<void>;
  expandEvidence(
    userId: UserId,
    authSessionId: string,
    evidenceItemId: EvidenceItemId,
  ): Promise<ReflectionInspectionEvidenceExpansion>;
  listBioImpacts(
    userId: UserId,
    memoryClaimVersionId: MemoryClaimVersionId,
    limit?: number,
    cursor?: string | null,
  ): Promise<ReflectionInspectionLayerResult<ReflectionInspectionBioImpact>>;
  listCandidateSuccessors(
    userId: UserId,
    candidateId: MemoryCandidateId,
    limit?: number,
    cursor?: string | null,
  ): Promise<ReflectionInspectionLayerResult<ReflectionInspectionCandidateSuccessor>>;
  listCandidatePredecessors(
    userId: UserId,
    candidateId: MemoryCandidateId,
    limit?: number,
    cursor?: string | null,
  ): Promise<ReflectionInspectionLayerResult<ReflectionInspectionCandidateSuccessor>>;
  listCandidates(
    userId: UserId,
    reflectionVersionId: ReflectionVersionId,
    expectedCurrentVersionId?: ReflectionVersionId | null,
    limit?: number,
    cursor?: string | null,
  ): Promise<ReflectionInspectionLayerResult<ReflectionInspectionCandidate>>;
  listClaimImpacts(
    userId: UserId,
    candidateId: MemoryCandidateId,
    limit?: number,
    cursor?: string | null,
  ): Promise<ReflectionInspectionLayerResult<ReflectionInspectionClaimImpact>>;
  listEvidenceLinks(
    userId: UserId,
    propositionId: ReflectionAtomicPropositionId,
    expectedCurrentVersionId?: ReflectionVersionId | null,
    limit?: number,
    cursor?: string | null,
  ): Promise<ReflectionInspectionLayerResult<ReflectionInspectionEvidenceLink>>;
  listPropositions(
    userId: UserId,
    statementId: ReflectionStatementId,
    expectedCurrentVersionId?: ReflectionVersionId | null,
    limit?: number,
    cursor?: string | null,
  ): Promise<ReflectionInspectionLayerResult<ReflectionInspectionProposition>>;
  listReflections(
    userId: UserId,
    filters: ReflectionInspectionFilters,
    limit?: number,
    cursor?: string | null,
  ): Promise<ReflectionInspectionPage<ReflectionInspectionReflection>>;
  listStatements(
    userId: UserId,
    reflectionVersionId: ReflectionVersionId,
    expectedCurrentVersionId?: ReflectionVersionId | null,
    limit?: number,
    cursor?: string | null,
  ): Promise<ReflectionInspectionLayerResult<ReflectionInspectionStatement>>;
  listVersions(
    userId: UserId,
    reflectionId: ReflectionId,
    expectedCurrentVersionId?: ReflectionVersionId | null,
    limit?: number,
    cursor?: string | null,
  ): Promise<ReflectionInspectionLayerResult<ReflectionInspectionVersionSummary>>;
  readReflection(
    userId: UserId,
    reflectionId: ReflectionId,
    expectedCurrentVersionId?: ReflectionVersionId | null,
  ): Promise<
    | ReflectionInspectionReflection
    | Readonly<{ outcome: "no_record" }>
    | Readonly<{
        outcome: "state_changed";
        reflectionId: ReflectionId;
        expectedVersionId: ReflectionVersionId | null;
        currentVersionId: ReflectionVersionId | null;
      }>
    | Readonly<{
        outcome: "no_current_version" | "content_expired" | "content_purged" | "source_invalidated" | "target_missing";
        reflectionId: ReflectionId;
        reflectionVersionId: ReflectionVersionId | null;
      }>
  >;
}>;

export function createReflectionInspectionService(dependencies: Readonly<{
  clock: () => Date;
  policyVersion?: string;
  recoveryGate?: RecoveryGate;
  repository: ReflectionInspectionRepository;
  stepUpMaxAgeMs?: number;
}>): ReflectionInspectionService {
  const policyVersion =
    dependencies.policyVersion ?? REFLECTION_INSPECTION_POLICY_VERSION;
  const stepUpMaxAgeMs =
    dependencies.stepUpMaxAgeMs ?? REFLECTION_INSPECTION_STEP_UP_MAX_AGE_MS;

  async function requireOpen(userId: UserId): Promise<void> {
    await dependencies.recoveryGate?.requireOpen(userId);
  }

  return {
    async authorize(userId, authSessionId) {
      await requireOpen(userId);
      const result = await dependencies.repository.authorizeReflectionInspection({
        authSessionId,
        userId,
      });
      if (result.outcome === "denied") {
        throw new ReflectionInspectionDeniedError();
      }
    },
    async expandEvidence(userId, authSessionId, evidenceItemId) {
      await requireOpen(userId);
      return dependencies.repository.expandEvidence({
        authSessionId,
        evidenceItemId,
        now: dependencies.clock(),
        policyVersion,
        stepUpMaxAgeMs,
        userId,
      });
    },
    async listBioImpacts(userId, memoryClaimVersionId, limit, cursor) {
      await requireOpen(userId);
      return dependencies.repository.listBioImpacts({
        cursor: cursor ?? null,
        limit: normalizeReflectionInspectionLimit(limit),
        memoryClaimVersionId,
        userId,
      });
    },
    async listCandidateSuccessors(userId, candidateId, limit, cursor) {
      await requireOpen(userId);
      return dependencies.repository.listCandidateSuccessors({
        candidateId,
        cursor: cursor ?? null,
        limit: normalizeReflectionInspectionLimit(limit),
        userId,
      });
    },
    async listCandidatePredecessors(userId, candidateId, limit, cursor) {
      await requireOpen(userId);
      return dependencies.repository.listCandidatePredecessors({
        candidateId,
        cursor: cursor ?? null,
        limit: normalizeReflectionInspectionLimit(limit),
        userId,
      });
    },
    async listCandidates(
      userId,
      reflectionVersionId,
      expectedCurrentVersionId,
      limit,
      cursor,
    ) {
      await requireOpen(userId);
      return dependencies.repository.listCandidates({
        cursor: cursor ?? null,
        expectedCurrentVersionId: expectedCurrentVersionId ?? null,
        limit: normalizeReflectionInspectionLimit(limit),
        reflectionVersionId,
        userId,
      });
    },
    async listClaimImpacts(userId, candidateId, limit, cursor) {
      await requireOpen(userId);
      return dependencies.repository.listClaimImpacts({
        candidateId,
        cursor: cursor ?? null,
        limit: normalizeReflectionInspectionLimit(limit),
        userId,
      });
    },
    async listEvidenceLinks(
      userId,
      propositionId,
      expectedCurrentVersionId,
      limit,
      cursor,
    ) {
      await requireOpen(userId);
      return dependencies.repository.listEvidenceLinks({
        cursor: cursor ?? null,
        expectedCurrentVersionId: expectedCurrentVersionId ?? null,
        limit: normalizeReflectionInspectionLimit(limit),
        propositionId,
        userId,
      });
    },
    async listPropositions(
      userId,
      statementId,
      expectedCurrentVersionId,
      limit,
      cursor,
    ) {
      await requireOpen(userId);
      return dependencies.repository.listPropositions({
        cursor: cursor ?? null,
        expectedCurrentVersionId: expectedCurrentVersionId ?? null,
        limit: normalizeReflectionInspectionLimit(limit),
        statementId,
        userId,
      });
    },
    async listReflections(userId, filters, limit, cursor) {
      await requireOpen(userId);
      return dependencies.repository.listReflections({
        cursor: cursor ?? null,
        filters,
        limit: normalizeReflectionInspectionLimit(limit),
        userId,
      });
    },
    async listStatements(
      userId,
      reflectionVersionId,
      expectedCurrentVersionId,
      limit,
      cursor,
    ) {
      await requireOpen(userId);
      return dependencies.repository.listStatements({
        cursor: cursor ?? null,
        expectedCurrentVersionId: expectedCurrentVersionId ?? null,
        limit: normalizeReflectionInspectionLimit(limit),
        reflectionVersionId,
        userId,
      });
    },
    async listVersions(
      userId,
      reflectionId,
      expectedCurrentVersionId,
      limit,
      cursor,
    ) {
      await requireOpen(userId);
      return dependencies.repository.listVersions({
        cursor: cursor ?? null,
        expectedCurrentVersionId: expectedCurrentVersionId ?? null,
        limit: normalizeReflectionInspectionLimit(limit),
        reflectionId,
        userId,
      });
    },
    async readReflection(userId, reflectionId, expectedCurrentVersionId) {
      await requireOpen(userId);
      return dependencies.repository.readReflection({
        expectedCurrentVersionId: expectedCurrentVersionId ?? null,
        reflectionId,
        userId,
      });
    },
  };
}
