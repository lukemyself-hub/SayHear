import {
  asClaimEvidenceLinkId,
  asMemoryCandidateEvidenceLinkId,
  asMemoryCandidateId,
  asMemoryClaimId,
  asMemoryClaimVersionId,
  asMemoryClaimVersionQualifierId,
  asMemoryForgetEvidenceExclusionId,
  asMemoryForgetRequestId,
  asMemoryForgetReversalId,
  asRelationshipResolverHintId,
  asDailySessionId,
  planRelationshipResolverHints,
  type MemoryCandidateId,
  type MemoryClaimId,
  type MemoryClaimVersionId,
  type ProposedQualifier,
  type RelationshipResolverHintPlanRow,
  type RelationshipResolverHintRecord,
  type ResolverHintLocale,
  type UserId,
} from "@sayhear/application";
import type { Pool, PoolClient } from "pg";

import {
  DEDUPE_FINGERPRINT_KEY_VERSION,
} from "@sayhear/application";

import { createUuidV7 } from "./uuid-v7";
import type {
  AdmissibleEvidence,
  AdmittedQualifier,
  CandidateDispositionPlan,
  ClaimAdmissionPlan,
  ClaimTypedValue,
  ClaimVersionQualifierRecord,
  MemoryCandidateProposal,
  MemoryCandidateRecord,
  MemoryClaimRecord,
  MemoryClaimVersionRecord,
  MemoryClaimRepository,
  RelationshipHintProjectionInputs,
  TemporalBounds,
} from "@sayhear/application";

/**
 * PostgreSQL executor for the Memory Claim domain (SPEC #107, architecture
 * §7.10). Every write method runs inside one transaction and executes a plan
 * produced by the pure admission validators; the database triggers added in
 * migration 0033 back the fences (ClaimVersion immutability, candidate
 * terminal disposition, epistemic combinations).
 */

export type CandidateRow = {
  memory_candidate_id: string;
  user_id: string;
  candidate_kind: "objective" | "impression";
  basis: "directly_stated" | "inferred";
  subject_entity_id: string | null;
  object_entity_id: string | null;
  predicate_id: string | null;
  predicate_registry_version: number | null;
  predicate_resolution_status: "mapped" | "ambiguous" | "unmapped";
  proposed_concept: string | null;
  mapping_confidence: string | null;
  proposed_object_value: unknown;
  proposed_scope_key: string;
  proposed_temporal_status: TemporalBounds["temporalStatus"];
  proposed_valid_from: Date | null;
  proposed_valid_from_precision: TemporalBounds["validFromPrecision"];
  proposed_valid_to: Date | null;
  proposed_valid_to_precision: TemporalBounds["validToPrecision"];
  extraction_policy_version: string;
  generation_command_id: string | null;
  authoritative_model_attempt_id: string | null;
  model_version: string | null;
  prompt_version: string | null;
  source_reflection_version_id: string | null;
  status: MemoryCandidateRecord["status"];
  review_due_at: Date | null;
  registry_release_due_at: Date | null;
  disposition_reason_code: string | null;
  disposition_policy_version: string | null;
  decided_at: Date | null;
  terminal_effective_at: Date | null;
  terminal_content_expires_at: Date | null;
  reproposal_policy: MemoryCandidateRecord["reproposalPolicy"];
  predecessor_candidate_id: string | null;
  successor_trigger: MemoryCandidateRecord["successorTrigger"];
  material_change_reason_codes: string[] | null;
  proposed_qualifiers: unknown;
  created_at: Date;
};

type ClaimRow = {
  memory_claim_id: string;
  user_id: string;
  canonical_key: string;
  subject_entity_id: string;
  object_entity_id: string | null;
  predicate_id: string;
  scope_key: string;
  current_version_id: string | null;
  created_at: Date;
  deleted_at: Date | null;
};

export type ClaimVersionRow = {
  memory_claim_version_id: string;
  memory_claim_id: string;
  revision: number;
  kind: "objective" | "impression";
  epistemic_status: "confirmed" | "inferred" | "contested";
  status: MemoryClaimVersionRecord["status"];
  subject_entity_version_id: string;
  object_entity_version_id: string | null;
  typed_value: unknown;
  confidence: string | null;
  temporal_status: TemporalBounds["temporalStatus"];
  valid_from: Date | null;
  valid_from_precision: TemporalBounds["validFromPrecision"];
  valid_to: Date | null;
  valid_to_precision: TemporalBounds["validToPrecision"];
  last_observed_at: Date;
  supersedes_version_id: string | null;
  created_by: string;
  model_version: string | null;
  prompt_version: string | null;
  predicate_registry_version: number;
  created_at: Date;
};

function toTypedValue(raw: unknown): ClaimTypedValue {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item));
  }
  return String(raw ?? "");
}

function toProposedQualifiers(raw: unknown): ProposedQualifier[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const record = item as {
      axisId?: unknown;
      roleSide?: unknown;
      typedValue?: unknown;
      evidenceItemIds?: unknown;
    };
    return {
      axisId: String(record.axisId ?? ""),
      roleSide: record.roleSide === "object" ? ("object" as const) : ("subject" as const),
      typedValue: toTypedValue(record.typedValue),
      evidenceItemIds: Array.isArray(record.evidenceItemIds)
        ? record.evidenceItemIds.map((id) => String(id))
        : [],
    };
  });
}

function toQualifierRecords(
  rows: {
    memory_claim_version_qualifier_id: string;
    memory_claim_version_id: string;
    axis_id: string;
    role_side: "canonical_subject" | "counterpart";
    typed_value: unknown;
    evidence_item_ids: string[] | null;
    created_at: Date;
  }[],
): ClaimVersionQualifierRecord[] {
  return rows.map((row) => ({
    memoryClaimVersionQualifierId: asMemoryClaimVersionQualifierId(
      row.memory_claim_version_qualifier_id,
    ),
    memoryClaimVersionId: asMemoryClaimVersionId(row.memory_claim_version_id),
    axisId: row.axis_id,
    roleSide: row.role_side,
    typedValue: toTypedValue(row.typed_value),
    evidenceItemIds: (row.evidence_item_ids ?? []).map((id) => String(id)),
    createdAt: row.created_at,
  }));
}

const QUALIFIER_COLUMNS = `memory_claim_version_qualifier_id, memory_claim_version_id,
  axis_id, role_side, typed_value,
  ARRAY(
    SELECT evidence_item_id FROM memory_claim_version_qualifier_evidence
    WHERE memory_claim_version_qualifier_evidence.memory_claim_version_qualifier_id
      = memory_claim_version_qualifiers.memory_claim_version_qualifier_id
    ORDER BY evidence_item_id
  ) AS evidence_item_ids,
  created_at`;

export function rowToCandidate(row: CandidateRow): MemoryCandidateRecord {
  return {
    memoryCandidateId: asMemoryCandidateId(row.memory_candidate_id),
    userId: row.user_id as UserId,
    candidateKind: row.candidate_kind,
    basis: row.basis,
    subjectEntityId: row.subject_entity_id,
    objectEntityId: row.object_entity_id,
    resolutionStatus: row.predicate_resolution_status,
    predicateId: row.predicate_id,
    predicateRegistryVersion: row.predicate_registry_version,
    proposedConcept: row.proposed_concept,
    mappingConfidence:
      row.mapping_confidence === null ? null : Number(row.mapping_confidence),
    proposedObjectValue: toTypedValue(row.proposed_object_value),
    proposedScopeKey: row.proposed_scope_key,
    temporal: {
      temporalStatus: row.proposed_temporal_status,
      validFrom: row.proposed_valid_from,
      validFromPrecision: row.proposed_valid_from_precision,
      validTo: row.proposed_valid_to,
      validToPrecision: row.proposed_valid_to_precision,
    },
    extractionPolicyVersion: row.extraction_policy_version,
    generationCommandId: row.generation_command_id,
    authoritativeModelAttemptId: row.authoritative_model_attempt_id,
    modelVersion: row.model_version,
    promptVersion: row.prompt_version,
    sourceReflectionVersionId: row.source_reflection_version_id,
    status: row.status,
    reviewDueAt: row.review_due_at,
    registryReleaseDueAt: row.registry_release_due_at,
    dispositionReasonCode: row.disposition_reason_code,
    dispositionPolicyVersion: row.disposition_policy_version,
    decidedAt: row.decided_at,
    terminalEffectiveAt: row.terminal_effective_at,
    terminalContentExpiresAt: row.terminal_content_expires_at,
    reproposalPolicy: row.reproposal_policy,
    predecessorCandidateId: row.predecessor_candidate_id
      ? asMemoryCandidateId(row.predecessor_candidate_id)
      : null,
    successorTrigger: row.successor_trigger,
    materialChangeReasonCodes: row.material_change_reason_codes,
    proposedQualifiers: toProposedQualifiers(row.proposed_qualifiers),
    createdAt: row.created_at,
  };
}

function rowToClaim(row: ClaimRow): MemoryClaimRecord {
  return {
    memoryClaimId: asMemoryClaimId(row.memory_claim_id),
    userId: row.user_id as UserId,
    canonicalKey: row.canonical_key,
    subjectEntityId: row.subject_entity_id,
    objectEntityId: row.object_entity_id,
    predicateId: row.predicate_id,
    scopeKey: row.scope_key,
    currentVersionId: row.current_version_id
      ? asMemoryClaimVersionId(row.current_version_id)
      : null,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

export function rowToVersion(row: ClaimVersionRow): MemoryClaimVersionRecord {
  return {
    memoryClaimVersionId: asMemoryClaimVersionId(row.memory_claim_version_id),
    memoryClaimId: asMemoryClaimId(row.memory_claim_id),
    revision: row.revision,
    kind: row.kind,
    epistemicStatus: row.epistemic_status,
    status: row.status,
    subjectEntityVersionId: row.subject_entity_version_id,
    objectEntityVersionId: row.object_entity_version_id,
    typedValue: toTypedValue(row.typed_value),
    confidence: row.confidence === null ? null : Number(row.confidence),
    temporal: {
      temporalStatus: row.temporal_status,
      validFrom: row.valid_from,
      validFromPrecision: row.valid_from_precision,
      validTo: row.valid_to,
      validToPrecision: row.valid_to_precision,
    },
    lastObservedAt: row.last_observed_at,
    supersedesVersionId: row.supersedes_version_id
      ? asMemoryClaimVersionId(row.supersedes_version_id)
      : null,
    createdBy: row.created_by,
    modelVersion: row.model_version,
    promptVersion: row.prompt_version,
    predicateRegistryVersion: row.predicate_registry_version,
    createdAt: row.created_at,
  };
}

export const CANDIDATE_COLUMNS = `memory_candidate_id, user_id, candidate_kind, basis,
  subject_entity_id, object_entity_id, predicate_id, predicate_registry_version,
  predicate_resolution_status, proposed_concept, mapping_confidence,
  proposed_object_value, proposed_scope_key, proposed_temporal_status,
  proposed_valid_from, proposed_valid_from_precision, proposed_valid_to,
  proposed_valid_to_precision, extraction_policy_version,
  generation_command_id, authoritative_model_attempt_id, model_version,
  prompt_version, source_reflection_version_id, status, review_due_at,
  registry_release_due_at, disposition_reason_code, disposition_policy_version,
  decided_at, terminal_effective_at, terminal_content_expires_at,
  reproposal_policy, predecessor_candidate_id, successor_trigger,
  material_change_reason_codes, proposed_qualifiers, created_at`;

const VERSION_INSERT_COLUMNS = `memory_claim_version_id, memory_claim_id, user_id,
  revision, kind, epistemic_status, status, subject_entity_version_id,
  object_entity_version_id, typed_value, confidence, temporal_status,
  valid_from, valid_from_precision, valid_to, valid_to_precision,
  last_observed_at, supersedes_version_id, created_by, model_version,
  prompt_version, predicate_registry_version, created_at`;

export const VERSION_COLUMNS = `memory_claim_version_id, memory_claim_id, revision, kind,
  epistemic_status, status, subject_entity_version_id, object_entity_version_id,
  typed_value, confidence, temporal_status, valid_from, valid_from_precision,
  valid_to, valid_to_precision, last_observed_at, supersedes_version_id,
  created_by, model_version, prompt_version, predicate_registry_version, created_at`;

export class PostgresMemoryClaimRepository implements MemoryClaimRepository {
  public constructor(private readonly pool: Pool) {}

  private async withTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // ── candidates: reads ────────────────────────────────────────────────────

  public async findCandidate(
    userId: UserId,
    candidateId: MemoryCandidateId,
  ): Promise<MemoryCandidateRecord | null> {
    const result = await this.pool.query<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM memory_candidates
       WHERE user_id = $1 AND memory_candidate_id = $2`,
      [userId, candidateId],
    );
    return result.rows[0] ? rowToCandidate(result.rows[0]) : null;
  }

  public async findTerminalCandidateByFingerprint(
    userId: UserId,
    fingerprint: string,
  ): Promise<{ memoryCandidateId: MemoryCandidateId; dispositionReasonCode: string } | null> {
    const result = await this.pool.query<{
      memory_candidate_id: string;
      disposition_reason_code: string;
    }>(
      `SELECT memory_candidate_id, disposition_reason_code FROM memory_candidates
       WHERE user_id = $1 AND dedupe_fingerprint = $2
         AND status IN ('rejected', 'stale')`,
      [userId, fingerprint],
    );
    const row = result.rows[0];
    return row
      ? {
          memoryCandidateId: asMemoryCandidateId(row.memory_candidate_id),
          dispositionReasonCode: row.disposition_reason_code,
        }
      : null;
  }

  public async listCandidateEvidenceItemIds(
    userId: UserId,
    candidateId: MemoryCandidateId,
  ): Promise<readonly string[]> {
    const result = await this.pool.query<{ evidence_item_id: string }>(
      `SELECT evidence_item_id FROM memory_candidate_evidence_links
       WHERE user_id = $1 AND memory_candidate_id = $2
       ORDER BY evidence_item_id`,
      [userId, candidateId],
    );
    return result.rows.map((row) => row.evidence_item_id);
  }

  // ── candidates: writes ───────────────────────────────────────────────────

  public async insertCandidate(input: {
    proposal: MemoryCandidateProposal;
    status: "proposed" | "needs_predicate_review";
    reviewDueAt: Date | null;
    now: Date;
  }): Promise<MemoryCandidateId> {
    return this.withTransaction((client) =>
      insertMemoryCandidateWithin(client, input),
    );
  }

  public async insertCandidateEvidenceLinks(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    evidenceItemIds: readonly string[];
    now: Date;
  }): Promise<void> {
    if (input.evidenceItemIds.length === 0) return;
    await this.withTransaction((client) =>
      insertCandidateEvidenceLinksWithin(client, input),
    );
  }

  public async recordCandidateDisposition(
    userId: UserId,
    candidateId: MemoryCandidateId,
    plan: CandidateDispositionPlan,
    decidedAt: Date,
  ): Promise<boolean> {
    return this.withTransaction((client) =>
      recordCandidateDispositionWithin(client, userId, candidateId, plan, decidedAt),
    );
  }

  public async transitionCandidate(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    fromStatuses: readonly ("proposed" | "needs_entity_resolution")[];
    toStatus: "proposed" | "needs_entity_resolution" | "accepted";
  }): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const result = await client.query<{ memory_candidate_id: string }>(
        `UPDATE memory_candidates SET status = $3
         WHERE user_id = $1 AND memory_candidate_id = $2 AND status = ANY($4::text[])
         RETURNING memory_candidate_id`,
        [input.userId, input.candidateId, input.toStatus, [...input.fromStatuses]],
      );
      return result.rows.length > 0;
    });
  }

  // ── evidence ─────────────────────────────────────────────────────────────

  public async describeEvidence(
    userId: UserId,
    evidenceItemIds: readonly string[],
  ): Promise<readonly AdmissibleEvidence[]> {
    if (evidenceItemIds.length === 0) return [];
    const result = await this.pool.query<{
      evidence_item_id: string;
      daily_session_id: string;
      source_revision_id: string;
      source_actor: string;
      source_status: string;
      status: string;
    }>(
      `SELECT i.evidence_item_id, s.daily_session_id, i.source_revision_id,
              i.source_actor, i.source_status, i.status
       FROM evidence_items i
       JOIN evidence_source_snapshots s
         ON s.evidence_source_snapshot_id = i.evidence_source_snapshot_id
       WHERE i.user_id = $1 AND i.evidence_item_id = ANY($2)`,
      [userId, [...evidenceItemIds]],
    );
    return result.rows.map((row) => ({
      evidenceItemId: row.evidence_item_id,
      dailySessionId: asDailySessionId(row.daily_session_id),
      sourceRevisionId: row.source_revision_id,
      sourceActor: row.source_actor as "user",
      sourceStatus: row.source_status as "final" | "corrected",
      status: row.status as "active",
    }));
  }

  // ── entity substrate ─────────────────────────────────────────────────────

  public async findSelfEntity(
    userId: UserId,
  ): Promise<{ entityId: string } | null> {
    const result = await this.pool.query<{ entity_id: string }>(
      `SELECT entity_id FROM user_self_entities WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0] ? { entityId: result.rows[0].entity_id } : null;
  }

  public async findCurrentEntityVersions(
    userId: UserId,
    entityIds: readonly string[],
  ): Promise<
    Record<string, { entityVersionId: string; status: string; entityKindId: string } | null>
  > {
    if (entityIds.length === 0) return {};
    const result = await this.pool.query<{
      entity_id: string;
      entity_version_id: string;
      status: string;
      entity_kind_id: string;
    }>(
      `SELECT e.entity_id, ev.entity_version_id, ev.status, ev.entity_kind_id
       FROM entities e
       JOIN entity_versions ev ON ev.entity_version_id = e.current_version_id
       WHERE e.user_id = $1 AND e.entity_id = ANY($2) AND e.deleted_at IS NULL`,
      [userId, [...entityIds]],
    );
    const map: Record<
      string,
      { entityVersionId: string; status: string; entityKindId: string } | null
    > = {};
    for (const entityId of entityIds) {
      map[entityId] = null;
    }
    for (const row of result.rows) {
      map[row.entity_id] = {
        entityVersionId: row.entity_version_id,
        status: row.status,
        entityKindId: row.entity_kind_id,
      };
    }
    return map;
  }

  // ── claims: reads ────────────────────────────────────────────────────────

  public async findClaimByCanonicalKey(
    userId: UserId,
    canonicalKey: string,
  ): Promise<{ memoryClaimId: MemoryClaimId; currentVersionId: MemoryClaimVersionId | null } | null> {
    const result = await this.pool.query<{
      memory_claim_id: string;
      current_version_id: string | null;
    }>(
      `SELECT memory_claim_id, current_version_id FROM memory_claims
       WHERE user_id = $1 AND canonical_key = $2`,
      [userId, canonicalKey],
    );
    const row = result.rows[0];
    return row
      ? {
          memoryClaimId: asMemoryClaimId(row.memory_claim_id),
          currentVersionId: row.current_version_id
            ? asMemoryClaimVersionId(row.current_version_id)
            : null,
        }
      : null;
  }

  public async loadClaim(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<MemoryClaimRecord | null> {
    const result = await this.pool.query<ClaimRow>(
      `SELECT memory_claim_id, user_id, canonical_key, subject_entity_id,
              object_entity_id, predicate_id, scope_key, current_version_id,
              created_at, deleted_at
       FROM memory_claims WHERE user_id = $1 AND memory_claim_id = $2`,
      [userId, claimId],
    );
    return result.rows[0] ? rowToClaim(result.rows[0]) : null;
  }

  public async loadClaimVersion(
    userId: UserId,
    versionId: MemoryClaimVersionId,
  ): Promise<MemoryClaimVersionRecord | null> {
    const result = await this.pool.query<ClaimVersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM memory_claim_versions
       WHERE user_id = $1 AND memory_claim_version_id = $2`,
      [userId, versionId],
    );
    return result.rows[0] ? rowToVersion(result.rows[0]) : null;
  }

  public async listClaimVersions(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<readonly MemoryClaimVersionRecord[]> {
    const result = await this.pool.query<ClaimVersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM memory_claim_versions
       WHERE user_id = $1 AND memory_claim_id = $2 ORDER BY revision`,
      [userId, claimId],
    );
    return result.rows.map(rowToVersion);
  }

  public async listClaimEvidenceItemIds(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<readonly string[]> {
    const result = await this.pool.query<{ evidence_item_id: string }>(
      `SELECT DISTINCT l.evidence_item_id
       FROM claim_evidence_links l
       JOIN memory_claim_versions v
         ON v.memory_claim_version_id = l.memory_claim_version_id
       WHERE l.user_id = $1 AND v.memory_claim_id = $2
       ORDER BY evidence_item_id`,
      [userId, claimId],
    );
    return result.rows.map((row) => row.evidence_item_id);
  }

  public async listActiveExcludedEvidenceIds(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<readonly string[]> {
    const result = await this.pool.query<{ evidence_item_id: string }>(
      `SELECT DISTINCT x.evidence_item_id
       FROM memory_forget_evidence_exclusions x
       JOIN claim_evidence_links l ON l.evidence_item_id = x.evidence_item_id
       JOIN memory_claim_versions v
         ON v.memory_claim_version_id = l.memory_claim_version_id
       WHERE x.user_id = $1 AND v.memory_claim_id = $2 AND x.status = 'active'
       ORDER BY evidence_item_id`,
      [userId, claimId],
    );
    return result.rows.map((row) => row.evidence_item_id);
  }

  public async findAppliedWholeClaimForget(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<{ requestId: string } | null> {
    // Latest applied request: whether the fence is currently active is decided
    // by the claim state (current version retracted), not by request existence.
    const result = await this.pool.query<{ memory_forget_request_id: string }>(
      `SELECT memory_forget_request_id FROM memory_forget_requests
       WHERE user_id = $1 AND target_claim_id = $2
         AND target_scope = 'whole_claim' AND status = 'applied'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, claimId],
    );
    return result.rows[0]
      ? { requestId: result.rows[0].memory_forget_request_id }
      : null;
  }

  public async findTerminalGovernanceBlock(
    userId: UserId,
    semanticTarget: {
      predicateId: string;
      proposedConcept: string;
      subjectEntityId: string | null;
      objectEntityId: string | null;
      scopeKey: string;
      objectValueJson: string;
    },
  ): Promise<{ dispositionReasonCode: string } | null> {
    const result = await this.pool.query<{ disposition_reason_code: string }>(
      `SELECT disposition_reason_code FROM memory_candidates
       WHERE user_id = $1
         AND status IN ('rejected', 'stale')
         AND reproposal_policy IN ('explicit_reconsideration_only', 'blocked_while_policy_active')
         AND COALESCE(predicate_id, '') = $2
         AND COALESCE(proposed_concept, '') = $3
         AND COALESCE(subject_entity_id::text, '') = $4
         AND COALESCE(object_entity_id::text, '') = $5
         AND proposed_scope_key = $6
         AND proposed_object_value::text = $7::text
       ORDER BY decided_at DESC
       LIMIT 1`,
      [
        userId,
        semanticTarget.predicateId,
        semanticTarget.proposedConcept,
        semanticTarget.subjectEntityId,
        semanticTarget.objectEntityId,
        semanticTarget.scopeKey,
        semanticTarget.objectValueJson,
      ],
    );
    const row = result.rows[0];
    return row ? { dispositionReasonCode: row.disposition_reason_code } : null;
  }

  public async latestEvidenceAtForVersion(
    userId: UserId,
    versionId: MemoryClaimVersionId,
  ): Promise<Date | null> {
    const result = await this.pool.query<{ latest: Date | null }>(
      `SELECT MAX(i.created_at) AS latest
       FROM claim_evidence_links l
       JOIN evidence_items i ON i.evidence_item_id = l.evidence_item_id
       WHERE l.user_id = $1 AND l.memory_claim_version_id = $2
         AND l.status = 'active' AND l.link_role = 'support'`,
      [userId, versionId],
    );
    return result.rows[0]?.latest ?? null;
  }

  // ── claims: transactional plan executors ─────────────────────────────────

  public async executeClaimAdmissionPlan(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    plan: ClaimAdmissionPlan;
    evidenceItemIds: readonly string[];
    lineage: MemoryCandidateProposal["lineage"];
    relationshipHints: RelationshipHintProjectionInputs | null;
    now: Date;
  }): Promise<{
    memoryClaimId: MemoryClaimId;
    memoryClaimVersionId: MemoryClaimVersionId;
    revision: number;
    createdClaim: boolean;
  }> {
    return this.withTransaction((client) =>
      executeClaimAdmissionPlanWithin(client, input),
    );
  }

  // ── #115: qualifiers + resolver hints ─────────────────────────────────────

  public async findCurrentPrimaryLabels(
    userId: UserId,
    entityIds: readonly string[],
  ): Promise<Record<string, { zh: string | null; en: string | null }>> {
    return findCurrentPrimaryLabelsWithin(this.pool, userId, entityIds);
  }

  public listClaimVersionQualifiers(
    userId: UserId,
    versionId: MemoryClaimVersionId,
  ): Promise<ClaimVersionQualifierRecord[]> {
    return listClaimVersionQualifiersWithin(this.pool, userId, versionId);
  }

  public listClaimQualifiers(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<ClaimVersionQualifierRecord[]> {
    return listClaimQualifiersWithin(this.pool, userId, claimId);
  }

  private static readonly HINT_COLUMNS = `relationship_resolver_hint_id,
    memory_claim_id, memory_claim_version_id, resolved_entity_id,
    context_entity_id, view_direction, locale, temporal_form, role_side,
    role_axis_id, role_term, role_source, phrase, rebuilt_at`;

  private static rowToHint(
    row: {
      relationship_resolver_hint_id: string;
      memory_claim_id: string;
      memory_claim_version_id: string;
      resolved_entity_id: string;
      context_entity_id: string;
      view_direction: "forward" | "inverse" | "symmetric";
      locale: string;
      temporal_form: "current" | "former";
      role_side: "canonical_subject" | "counterpart";
      role_axis_id: string | null;
      role_term: string;
      role_source: "qualifier" | "neutral_fallback" | "predicate_label";
      phrase: string | null;
      rebuilt_at: Date;
    },
  ): RelationshipResolverHintRecord {
    return {
      relationshipResolverHintId: asRelationshipResolverHintId(
        row.relationship_resolver_hint_id,
      ),
      memoryClaimId: asMemoryClaimId(row.memory_claim_id),
      memoryClaimVersionId: asMemoryClaimVersionId(row.memory_claim_version_id),
      resolvedEntityId: row.resolved_entity_id,
      contextEntityId: row.context_entity_id,
      viewDirection: row.view_direction,
      locale: row.locale as ResolverHintLocale,
      temporalForm: row.temporal_form,
      roleSide: row.role_side,
      roleAxisId: row.role_axis_id,
      roleTerm: row.role_term,
      roleSource: row.role_source,
      phrase: row.phrase,
      rebuiltAt: row.rebuilt_at,
    };
  }

  public async listRelationshipResolverHints(
    userId: UserId,
    claimId: MemoryClaimId,
  ): Promise<RelationshipResolverHintRecord[]> {
    const result = await this.pool.query(
      `SELECT ${PostgresMemoryClaimRepository.HINT_COLUMNS}
       FROM relationship_resolver_hints
       WHERE user_id = $1 AND memory_claim_id = $2
       ORDER BY locale, resolved_entity_id, role_axis_id NULLS LAST`,
      [userId, claimId],
    );
    return result.rows.map((row) => PostgresMemoryClaimRepository.rowToHint(row));
  }

  public async listResolverHintsForEntity(
    userId: UserId,
    entityId: string,
    locale: ResolverHintLocale,
  ): Promise<RelationshipResolverHintRecord[]> {
    const result = await this.pool.query(
      `SELECT ${PostgresMemoryClaimRepository.HINT_COLUMNS}
       FROM relationship_resolver_hints
       WHERE user_id = $1 AND resolved_entity_id = $2 AND locale = $3
       ORDER BY role_axis_id NULLS LAST`,
      [userId, entityId, locale],
    );
    return result.rows.map((row) => PostgresMemoryClaimRepository.rowToHint(row));
  }

  /** #115: active relationship claims, for the full hint rebuild CLI. */
  public async listRelationshipClaims(): Promise<
    { memoryClaimId: MemoryClaimId; predicateId: string }[]
  > {
    const result = await this.pool.query<{
      memory_claim_id: string;
      predicate_id: string;
    }>(
      `SELECT memory_claim_id, predicate_id FROM memory_claims
       WHERE deleted_at IS NULL AND content_purged_at IS NULL
         AND predicate_id LIKE 'sh.relationship.%'
       ORDER BY memory_claim_id`,
    );
    return result.rows.map((row) => ({
      memoryClaimId: asMemoryClaimId(row.memory_claim_id),
      predicateId: row.predicate_id,
    }));
  }

  public async executeHintRebuildPlan(input: {
    userId: UserId;
    claimId: MemoryClaimId;
    hints: RelationshipHintProjectionInputs;
    now: Date;
  }): Promise<{ rebuiltRows: number }> {
    return this.withTransaction(async (client) => {
      const rebuilt = await rebuildRelationshipResolverHintsWithin(client, input);
      return { rebuiltRows: rebuilt.length };
    });
  }

  public async executeDormancyPlan(input: {
    userId: UserId;
    claimId: MemoryClaimId;
    currentVersion: MemoryClaimVersionRecord;
    now: Date;
  }): Promise<{ memoryClaimVersionId: MemoryClaimVersionId; revision: number }> {
    return this.withTransaction((client) =>
      executeDormancyPlanWithin(client, input),
    );
  }

  public async executeWholeClaimForgetPlan(input: {
    userId: UserId;
    claimId: MemoryClaimId;
    requestEventRevisionId: string;
    now: Date;
  }): Promise<{
    requestId: string;
    claimVersionId: MemoryClaimVersionId;
    excludedEvidenceCount: number;
  }> {
    return this.withTransaction(async (client) => {
      const claimRow = await client.query<{ current_version_id: string }>(
        `SELECT current_version_id FROM memory_claims
         WHERE user_id = $1 AND memory_claim_id = $2 FOR UPDATE`,
        [input.userId, input.claimId],
      );
      const currentVersionId = claimRow.rows[0]?.current_version_id;
      if (!currentVersionId) {
        throw new Error(`Claim ${input.claimId} has no current version to forget.`);
      }
      const current = await client.query<ClaimVersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM memory_claim_versions
         WHERE user_id = $1 AND memory_claim_version_id = $2`,
        [input.userId, currentVersionId],
      );
      const currentVersion = current.rows[0];
      if (!currentVersion) {
        throw new Error(`Claim version ${currentVersionId} does not exist.`);
      }

      const revisionRow = await client.query<{ next_revision: number }>(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
         FROM memory_claim_versions WHERE memory_claim_id = $1`,
        [input.claimId],
      );
      const revision = revisionRow.rows[0]!.next_revision;
      const retractedVersionId = asMemoryClaimVersionId(createUuidV7(input.now));
      await client.query(
        `INSERT INTO memory_claim_versions (
           memory_claim_version_id, memory_claim_id, user_id,
           revision, kind, epistemic_status, status, subject_entity_version_id,
           object_entity_version_id, typed_value, confidence, temporal_status,
           valid_from, valid_from_precision, valid_to, valid_to_precision,
           last_observed_at, supersedes_version_id, created_by, model_version,
           prompt_version, predicate_registry_version, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'retracted', $7, $8, $9::jsonb, NULL,
           $10, $11, $12, $13, $14, $15, $16, 'forget_request', NULL, NULL,
           $17, $18)`,
        [
          retractedVersionId,
          input.claimId,
          input.userId,
          revision,
          currentVersion.kind,
          currentVersion.epistemic_status,
          currentVersion.subject_entity_version_id,
          currentVersion.object_entity_version_id,
          JSON.stringify(toTypedValue(currentVersion.typed_value)),
          currentVersion.temporal_status,
          currentVersion.valid_from,
          currentVersion.valid_from_precision,
          currentVersion.valid_to,
          currentVersion.valid_to_precision,
          input.now,
          currentVersionId,
          currentVersion.predicate_registry_version,
          input.now,
        ],
      );

      const evidenceRows = await client.query<{ evidence_item_id: string }>(
        `SELECT DISTINCT l.evidence_item_id
         FROM claim_evidence_links l
         JOIN memory_claim_versions v
           ON v.memory_claim_version_id = l.memory_claim_version_id
         WHERE l.user_id = $1 AND v.memory_claim_id = $2`,
        [input.userId, input.claimId],
      );

      const requestId = asMemoryForgetRequestId(createUuidV7(input.now));
      await client.query(
        `INSERT INTO memory_forget_requests (
           memory_forget_request_id, user_id, request_event_revision_id,
           target_claim_id, target_scope, status, applied_claim_version_id,
           forget_policy_version, created_at
         ) VALUES ($1, $2, $3, $4, 'whole_claim', 'applied', $5, $6, $7)`,
        [
          requestId,
          input.userId,
          input.requestEventRevisionId,
          input.claimId,
          retractedVersionId,
          "memory-forget:v1",
          input.now,
        ],
      );
      for (const row of evidenceRows.rows) {
        await client.query(
          `INSERT INTO memory_forget_evidence_exclusions (
             memory_forget_evidence_exclusion_id, user_id,
             memory_forget_request_id, evidence_item_id, exclusion_scope,
             status, created_at
           ) VALUES ($1, $2, $3, $4, 'whole_claim', 'active', $5)
           ON CONFLICT DO NOTHING`,
          [
            asMemoryForgetEvidenceExclusionId(createUuidV7(input.now)),
            input.userId,
            requestId,
            row.evidence_item_id,
            input.now,
          ],
        );
      }

      await client.query(
        `UPDATE memory_claims SET current_version_id = $3
         WHERE user_id = $1 AND memory_claim_id = $2
           AND current_version_id IS NOT DISTINCT FROM $4`,
        [input.userId, input.claimId, retractedVersionId, currentVersionId],
      );

      // #115: a fenced claim stops projecting entirely — the Resolver Hint
      // rows go with the fence (fail closed; non-relationship claims hold no
      // rows, so the delete is unconditional).
      await client.query(
        `DELETE FROM relationship_resolver_hints
         WHERE user_id = $1 AND memory_claim_id = $2`,
        [input.userId, input.claimId],
      );

      return {
        requestId,
        claimVersionId: retractedVersionId,
        excludedEvidenceCount: evidenceRows.rows.length,
      };
    });
  }

  public async executeForgetReversalPlan(input: {
    userId: UserId;
    claimId: MemoryClaimId;
    requestId: string;
    requestEventRevisionId: string;
    reversalEvidenceId: string;
    claimKind: "objective" | "impression";
    retractedVersionId: MemoryClaimVersionId;
    relationshipHints?: RelationshipHintProjectionInputs | null;
    now: Date;
  }): Promise<{ claimVersionId: MemoryClaimVersionId }> {
    return this.withTransaction(async (client) => {
      const retracted = await client.query<ClaimVersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM memory_claim_versions
         WHERE user_id = $1 AND memory_claim_version_id = $2`,
        [input.userId, input.retractedVersionId],
      );
      const retractedVersion = retracted.rows[0];
      if (!retractedVersion) {
        throw new Error(`Retracted version ${input.retractedVersionId} does not exist.`);
      }

      const revisionRow = await client.query<{ next_revision: number }>(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
         FROM memory_claim_versions WHERE memory_claim_id = $1`,
        [input.claimId],
      );
      const revision = revisionRow.rows[0]!.next_revision;
      const versionId = asMemoryClaimVersionId(createUuidV7(input.now));
      await client.query(
        `INSERT INTO memory_claim_versions (
           memory_claim_version_id, memory_claim_id, user_id,
           revision, kind, epistemic_status, status, subject_entity_version_id,
           object_entity_version_id, typed_value, confidence, temporal_status,
           valid_from, valid_from_precision, valid_to, valid_to_precision,
           last_observed_at, supersedes_version_id, created_by, model_version,
           prompt_version, predicate_registry_version, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9::jsonb, NULL,
           $10, $11, $12, $13, $14, $15, $16, 'forget_reversal', NULL, NULL,
           $17, $18)`,
        [
          versionId,
          input.claimId,
          input.userId,
          revision,
          input.claimKind,
          input.claimKind === "objective" ? "confirmed" : "inferred",
          retractedVersion.subject_entity_version_id,
          retractedVersion.object_entity_version_id,
          JSON.stringify(toTypedValue(retractedVersion.typed_value)),
          retractedVersion.temporal_status,
          retractedVersion.valid_from,
          retractedVersion.valid_from_precision,
          retractedVersion.valid_to,
          retractedVersion.valid_to_precision,
          input.now,
          input.retractedVersionId,
          retractedVersion.predicate_registry_version,
          input.now,
        ],
      );

      const reversalId = asMemoryForgetReversalId(createUuidV7(input.now));
      await client.query(
        `INSERT INTO memory_forget_reversals (
           memory_forget_reversal_id, user_id, memory_forget_request_id,
           request_event_revision_id, reversal_evidence_id, status,
           applied_claim_version_id, forget_policy_version, created_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)`,
        [
          reversalId,
          input.userId,
          input.requestId,
          input.requestEventRevisionId,
          input.reversalEvidenceId,
          versionId,
          "memory-forget:v1",
          input.now,
        ],
      );

      await insertClaimEvidenceLinks(
        client,
        input.userId,
        versionId,
        [input.reversalEvidenceId],
        "support",
        input.now,
      );

      await client.query(
        `UPDATE memory_claims SET current_version_id = $3
         WHERE user_id = $1 AND memory_claim_id = $2
           AND current_version_id IS NOT DISTINCT FROM $4`,
        [input.userId, input.claimId, versionId, input.retractedVersionId],
      );

      // #115: the reversal event doubles as new Evidence, so the restored
      // current version projects again; with narrow registry material the
      // projection simply stays absent (fail closed) until the next advance.
      if (input.relationshipHints) {
        await rebuildRelationshipResolverHintsWithin(client, {
          userId: input.userId,
          claimId: input.claimId,
          hints: input.relationshipHints,
          now: input.now,
        });
      }

      return { claimVersionId: versionId };
    });
  }
}


/**
 * In-transaction executor for a promote / contested / reinforce admission
 * plan (shared by the Memory Claim service and the consolidation run commit).
 */
export async function executeClaimAdmissionPlanWithin(
  client: PoolClient,
  input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    plan: ClaimAdmissionPlan;
    evidenceItemIds: readonly string[];
    lineage: MemoryCandidateProposal["lineage"];
    relationshipHints?: RelationshipHintProjectionInputs | null;
    now: Date;
  },
): Promise<{
  memoryClaimId: MemoryClaimId;
  memoryClaimVersionId: MemoryClaimVersionId;
  revision: number;
  createdClaim: boolean;
}> {
  const { plan } = input;


      if (plan.action === "reinforce_current") {
        const target = await client.query<ClaimVersionRow>(
          `SELECT ${VERSION_COLUMNS} FROM memory_claim_versions
           WHERE user_id = $1 AND memory_claim_version_id = $2`,
          [input.userId, plan.attachToVersionId],
        );
        const version = target.rows[0];
        if (!version) {
          throw new Error(
            `Reinforce target version ${plan.attachToVersionId} does not exist.`,
          );
        }
        await insertClaimEvidenceLinks(
          client,
          input.userId,
          plan.attachToVersionId,
          input.evidenceItemIds,
          plan.linkRole,
          input.now,
        );
        return {
          memoryClaimId: asMemoryClaimId(version.memory_claim_id),
          memoryClaimVersionId: asMemoryClaimVersionId(version.memory_claim_version_id),
          revision: version.revision,
          createdClaim: false,
        };
      }

      // promote / contested: insert (or reuse) the logical Claim, append the
      // new immutable version, then CAS-move the current-version pointer.
      if (plan.action !== "promote" && plan.action !== "contested") {
        throw new Error(
          `executeClaimAdmissionPlan only executes promote / contested / reinforce plans, got ${plan.action}.`,
        );
      }
      let claimId: MemoryClaimId;
      let createdClaim = false;
      const candidate = await client.query<{ predicate_registry_version: number | null }>(
        `SELECT predicate_registry_version FROM memory_candidates
         WHERE user_id = $1 AND memory_candidate_id = $2`,
        [input.userId, input.candidateId],
      );
      const registryVersion =
        candidate.rows[0]?.predicate_registry_version ?? 1;

      if (plan.claimAction === "create_claim") {
        if (plan.action !== "promote") {
          throw new Error("A contested version cannot create a new logical Claim.");
        }
        claimId = asMemoryClaimId(createUuidV7(input.now));
        await client.query(
          `INSERT INTO memory_claims (
             memory_claim_id, user_id, canonical_key, subject_entity_id,
             object_entity_id, predicate_id, scope_key, current_version_id, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)`,
          [
            claimId,
            input.userId,
            plan.canonicalKey,
            plan.subjectEntityId,
            plan.objectEntityId,
            plan.predicateId,
            plan.scopeKey,
            input.now,
          ],
        );
        createdClaim = true;
      } else {
        const existing = await client.query<{ memory_claim_id: string }>(
          `SELECT memory_claim_id FROM memory_claims
           WHERE user_id = $1 AND canonical_key = $2`,
          [input.userId, plan.canonicalKey],
        );
        const row = existing.rows[0];
        if (!row) {
          throw new Error(
            `Claim reuse failed: no logical Claim for canonical key ${plan.canonicalKey}.`,
          );
        }
        claimId = asMemoryClaimId(row.memory_claim_id);
      }

      const revisionRow = await client.query<{ next_revision: number }>(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
         FROM memory_claim_versions WHERE memory_claim_id = $1`,
        [claimId],
      );
      const revision = revisionRow.rows[0]!.next_revision;
      const versionId = asMemoryClaimVersionId(createUuidV7(input.now));

      await client.query(
        `INSERT INTO memory_claim_versions (
           memory_claim_version_id, memory_claim_id, user_id,
           revision, kind, epistemic_status, status, subject_entity_version_id,
           object_entity_version_id, typed_value, confidence, temporal_status,
           valid_from, valid_from_precision, valid_to, valid_to_precision,
           last_observed_at, supersedes_version_id, created_by, model_version,
           prompt_version, predicate_registry_version, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NULL, $11,
           $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
        [
          versionId,
          claimId,
          input.userId,
          revision,
          plan.kind,
          plan.epistemicStatus,
          plan.versionStatus,
          plan.subjectEntityVersionId,
          plan.objectEntityVersionId,
          JSON.stringify(plan.typedValue),
          plan.temporal.temporalStatus,
          plan.temporal.validFrom,
          plan.temporal.validFromPrecision,
          plan.temporal.validTo,
          plan.temporal.validToPrecision,
          input.now,
          plan.supersedesVersionId,
          "consolidation",
          input.lineage.modelVersion,
          input.lineage.promptVersion,
          registryVersion,
          input.now,
        ],
      );

      const moved = await client.query<{ memory_claim_id: string }>(
        `UPDATE memory_claims SET current_version_id = $3
         WHERE user_id = $1 AND memory_claim_id = $2
           AND current_version_id IS NOT DISTINCT FROM $4
         RETURNING memory_claim_id`,
        [input.userId, claimId, versionId, plan.supersedesVersionId],
      );
      if (moved.rows.length === 0) {
        throw new Error(
          `Admission CAS failed: claim ${claimId} pointer moved concurrently.`,
        );
      }

      await insertClaimEvidenceLinks(
        client,
        input.userId,
        versionId,
        input.evidenceItemIds,
        "support",
        input.now,
      );

      // #115: relationship qualifiers ride the new version; the Resolver Hint
      // projection is rebuilt in the same transaction so it always derives
      // from exactly one version — the new current one (ADR-0027 / ADR-0031).
      if (plan.qualifiers.length > 0) {
        await insertClaimVersionQualifiersWithin(client, {
          userId: input.userId,
          versionId,
          qualifiers: plan.qualifiers,
          createdBy: "admission",
          now: input.now,
        });
      }
      if (input.relationshipHints && plan.action === "promote") {
        await rebuildRelationshipResolverHintsWithin(client, {
          userId: input.userId,
          claimId,
          hints: input.relationshipHints,
          now: input.now,
        });
      }

      return { memoryClaimId: claimId, memoryClaimVersionId: versionId, revision, createdClaim };
}


/** In-transaction executor for the deterministic dormancy plan (ADR-0041). */
export async function executeDormancyPlanWithin(
  client: PoolClient,
  input: {
    userId: UserId;
    claimId: MemoryClaimId;
    currentVersion: MemoryClaimVersionRecord;
    now: Date;
  },
): Promise<{ memoryClaimVersionId: MemoryClaimVersionId; revision: number }> {
      const revisionRow = await client.query<{ next_revision: number }>(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
         FROM memory_claim_versions WHERE memory_claim_id = $1`,
        [input.claimId],
      );
      const revision = revisionRow.rows[0]!.next_revision;
      const versionId = asMemoryClaimVersionId(createUuidV7(input.now));
      await client.query(
        `INSERT INTO memory_claim_versions (
           memory_claim_version_id, memory_claim_id, user_id,
           revision, kind, epistemic_status, status, subject_entity_version_id,
           object_entity_version_id, typed_value, confidence, temporal_status,
           valid_from, valid_from_precision, valid_to, valid_to_precision,
           last_observed_at, supersedes_version_id, created_by, model_version,
           prompt_version, predicate_registry_version, created_at
         ) VALUES ($1, $2, $3, $4, $5, 'inferred', 'dormant', $6, $7,
           $8::jsonb, NULL, $9, $10, $11, $12, $13, $14, $15, 'dormancy_review',
           NULL, NULL, $16, $17)`,
        [
          versionId,
          input.claimId,
          input.userId,
          revision,
          input.currentVersion.kind,
          input.currentVersion.subjectEntityVersionId,
          input.currentVersion.objectEntityVersionId,
          JSON.stringify(input.currentVersion.typedValue),
          input.currentVersion.temporal.temporalStatus,
          input.currentVersion.temporal.validFrom,
          input.currentVersion.temporal.validFromPrecision,
          input.currentVersion.temporal.validTo,
          input.currentVersion.temporal.validToPrecision,
          input.now,
          input.currentVersion.memoryClaimVersionId,
          input.currentVersion.predicateRegistryVersion,
          input.now,
        ],
      );
      const moved = await client.query<{ memory_claim_id: string }>(
        `UPDATE memory_claims SET current_version_id = $3
         WHERE user_id = $1 AND memory_claim_id = $2
           AND current_version_id IS NOT DISTINCT FROM $4
         RETURNING memory_claim_id`,
        [
          input.userId,
          input.claimId,
          versionId,
          input.currentVersion.memoryClaimVersionId,
        ],
      );
      if (moved.rows.length === 0) {
        throw new Error(
          `Dormancy CAS failed: claim ${input.claimId} pointer moved concurrently.`,
        );
      }
      return { memoryClaimVersionId: versionId, revision };
}

async function insertClaimEvidenceLinks(
  client: PoolClient,
  userId: UserId,
  versionId: MemoryClaimVersionId,
  evidenceItemIds: readonly string[],
  linkRole: "support" | "counter" | "subjective_report" | "context",
  now: Date,
): Promise<void> {
  for (const evidenceItemId of evidenceItemIds) {
    await client.query(
      `INSERT INTO claim_evidence_links (
         claim_evidence_link_id, memory_claim_version_id, user_id,
         evidence_item_id, link_role, status, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6)
       ON CONFLICT DO NOTHING`,
      [
        asClaimEvidenceLinkId(createUuidV7(now)),
        versionId,
        userId,
        evidenceItemId,
        linkRole,
        now,
      ],
    );
  }
}

// ── Shared within-transaction writers (issue #113 fast path) ───────────────
// The fast-path extraction commit must write Memory Candidates inside the
// same authoritative transaction as its run row (AC #1: retries never
// double-write memory). These exports carry the exact insert / fence
// semantics the MemoryClaimService path uses; behavior must not drift.


/** Guarded terminal disposition write, in-transaction (ADR-0046 / ADR-0051). */
export async function recordCandidateDispositionWithin(
  client: PoolClient,
  userId: UserId,
  candidateId: MemoryCandidateId,
  plan: CandidateDispositionPlan,
  decidedAt: Date,
): Promise<boolean> {
  const result = await client.query<{ memory_candidate_id: string }>(
    `UPDATE memory_candidates SET
       status = $3,
       disposition_reason_code = $4,
       disposition_policy_version = $5,
       reproposal_policy = $6,
       decided_at = $7,
       terminal_effective_at = $8,
       terminal_content_expires_at = $9,
       dedupe_fingerprint = $10,
       dedupe_fingerprint_key_version = $11
     WHERE user_id = $1 AND memory_candidate_id = $2
       AND status NOT IN ('rejected', 'stale', 'deleted')
     RETURNING memory_candidate_id`,
    [
      userId,
      candidateId,
      plan.status,
      plan.dispositionReasonCode,
      plan.dispositionPolicyVersion,
      plan.reproposalPolicy,
      decidedAt,
      plan.terminalEffectiveAt,
      plan.terminalContentExpiresAt,
      plan.dedupeFingerprint,
      DEDUPE_FINGERPRINT_KEY_VERSION,
    ],
  );
  return result.rows.length > 0;
}

export async function insertMemoryCandidateWithin(
  client: PoolClient,
  input: {
    proposal: MemoryCandidateProposal;
    status: "proposed" | "needs_predicate_review";
    reviewDueAt: Date | null;
    now: Date;
  },
): Promise<MemoryCandidateId> {
  const { proposal, now } = input;
  const mapped = proposal.resolution.status === "mapped";
  const inserted = await client.query<{ memory_candidate_id: string }>(
    `INSERT INTO memory_candidates (
       memory_candidate_id, user_id, candidate_kind, basis,
       subject_entity_id, subject_entity_mention_id, object_entity_id,
       object_entity_mention_id, predicate_id, predicate_registry_version,
       predicate_resolution_status, proposed_concept, mapping_confidence,
       proposed_object_value, proposed_scope_key, proposed_temporal_status,
       proposed_valid_from, proposed_valid_from_precision, proposed_valid_to,
       proposed_valid_to_precision, proposed_qualifiers,
       source_reflection_version_id,
       generation_command_id, authoritative_model_attempt_id, model_version,
       prompt_version, extraction_policy_version, status, review_eligible_at,
       review_due_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14::jsonb, $15, $16, $17, $18, $19, $20, $21::jsonb, $22, $23, $24,
       $25, $26, $27, $28, $29, $30, $31)
     RETURNING memory_candidate_id`,
    [
      createUuidV7(now),
      proposal.userId,
      proposal.candidateKind,
      proposal.basis,
      proposal.subjectEntityId,
      proposal.subjectEntityMentionId,
      proposal.objectEntityId,
      proposal.objectEntityMentionId,
      mapped ? proposal.resolution.predicateId : null,
      mapped ? proposal.resolution.registryVersion : null,
      proposal.resolution.status,
      mapped ? null : proposal.resolution.proposedConcept,
      mapped ? proposal.resolution.mappingConfidence : null,
      JSON.stringify(mapped ? proposal.resolution.typedValue : ""),
      proposal.scopeKey,
      proposal.temporal.temporalStatus,
      proposal.temporal.validFrom,
      proposal.temporal.validFromPrecision,
      proposal.temporal.validTo,
      proposal.temporal.validToPrecision,
      JSON.stringify(proposal.qualifiers),
      proposal.lineage.sourceReflectionVersionId,
      proposal.lineage.generationCommandId,
      proposal.lineage.authoritativeModelAttemptId,
      proposal.lineage.modelVersion,
      proposal.lineage.promptVersion,
      proposal.lineage.extractionPolicyVersion,
      input.status,
      input.status === "needs_predicate_review" ? now : null,
      input.reviewDueAt,
      now,
    ],
  );
  return asMemoryCandidateId(inserted.rows[0]!.memory_candidate_id);
}

export async function insertCandidateEvidenceLinksWithin(
  client: PoolClient,
  input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    evidenceItemIds: readonly string[];
    now: Date;
  },
): Promise<void> {
  for (const evidenceItemId of input.evidenceItemIds) {
    await client.query(
      `INSERT INTO memory_candidate_evidence_links (
         memory_candidate_evidence_link_id, memory_candidate_id, user_id,
         evidence_item_id, created_at
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        asMemoryCandidateEvidenceLinkId(createUuidV7(input.now)),
        input.candidateId,
        input.userId,
        evidenceItemId,
        input.now,
      ],
    );
  }
}

export async function findTerminalCandidateByFingerprintWithin(
  client: PoolClient,
  userId: UserId,
  fingerprint: string,
): Promise<{ memoryCandidateId: MemoryCandidateId; dispositionReasonCode: string } | null> {
  const result = await client.query<{
    memory_candidate_id: string;
    disposition_reason_code: string;
  }>(
    `SELECT memory_candidate_id, disposition_reason_code FROM memory_candidates
     WHERE user_id = $1 AND dedupe_fingerprint = $2
       AND status IN ('rejected', 'stale')`,
    [userId, fingerprint],
  );
  const row = result.rows[0];
  return row
    ? {
        memoryCandidateId: asMemoryCandidateId(row.memory_candidate_id),
        dispositionReasonCode: row.disposition_reason_code,
      }
    : null;
}

export async function findTerminalGovernanceBlockWithin(
  client: PoolClient,
  userId: UserId,
  semanticTarget: {
    predicateId: string;
    proposedConcept: string;
    subjectEntityId: string | null;
    objectEntityId: string | null;
    scopeKey: string;
    objectValueJson: string;
  },
): Promise<{ dispositionReasonCode: string } | null> {
  const result = await client.query<{ disposition_reason_code: string }>(
    `SELECT disposition_reason_code FROM memory_candidates
     WHERE user_id = $1
       AND status IN ('rejected', 'stale')
       AND reproposal_policy IN ('explicit_reconsideration_only', 'blocked_while_policy_active')
       AND COALESCE(predicate_id, '') = $2
       AND COALESCE(proposed_concept, '') = $3
       AND COALESCE(subject_entity_id::text, '') = $4
       AND COALESCE(object_entity_id::text, '') = $5
       AND proposed_scope_key = $6
       AND proposed_object_value::text = $7::text
     ORDER BY decided_at DESC
     LIMIT 1`,
    [
      userId,
      semanticTarget.predicateId,
      semanticTarget.proposedConcept,
      semanticTarget.subjectEntityId,
      semanticTarget.objectEntityId,
      semanticTarget.scopeKey,
      semanticTarget.objectValueJson,
    ],
  );
  const row = result.rows[0];
  return row ? { dispositionReasonCode: row.disposition_reason_code } : null;
}

// ── #115: Relationship Qualifiers + Resolver Hint projection helpers ────────

/** Write one version's admitted qualifiers and their evidence links. */
export async function insertClaimVersionQualifiersWithin(
  client: PoolClient,
  input: {
    userId: UserId;
    versionId: MemoryClaimVersionId;
    qualifiers: readonly AdmittedQualifier[];
    createdBy: string;
    now: Date;
  },
): Promise<void> {
  for (const qualifier of input.qualifiers) {
    const qualifierId = asMemoryClaimVersionQualifierId(
      createUuidV7(input.now),
    );
    await client.query(
      `INSERT INTO memory_claim_version_qualifiers (
         memory_claim_version_qualifier_id, memory_claim_version_id, user_id,
         axis_id, role_side, typed_value, created_by, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        qualifierId,
        input.versionId,
        input.userId,
        qualifier.axisId,
        qualifier.roleSide,
        JSON.stringify(qualifier.typedValue),
        input.createdBy,
        input.now,
      ],
    );
    for (const evidenceItemId of qualifier.evidenceItemIds) {
      await client.query(
        `INSERT INTO memory_claim_version_qualifier_evidence (
           memory_claim_version_qualifier_evidence_id,
           memory_claim_version_qualifier_id, user_id, evidence_item_id, created_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [
          asClaimEvidenceLinkId(createUuidV7(input.now)),
          qualifierId,
          input.userId,
          evidenceItemId,
          input.now,
        ],
      );
    }
  }
}

export async function listClaimVersionQualifiersWithin(
  client: Pool | PoolClient,
  userId: UserId,
  versionId: MemoryClaimVersionId,
): Promise<ClaimVersionQualifierRecord[]> {
  const result = await client.query(
    `SELECT ${QUALIFIER_COLUMNS}
     FROM memory_claim_version_qualifiers
     WHERE user_id = $1 AND memory_claim_version_id = $2
     ORDER BY axis_id, role_side`,
    [userId, versionId],
  );
  return toQualifierRecords(result.rows);
}

export async function listClaimQualifiersWithin(
  client: Pool | PoolClient,
  userId: UserId,
  claimId: MemoryClaimId,
): Promise<ClaimVersionQualifierRecord[]> {
  const result = await client.query(
    `SELECT q.memory_claim_version_qualifier_id, q.memory_claim_version_id,
            q.axis_id, q.role_side, q.typed_value,
            ARRAY(
              SELECT evidence_item_id FROM memory_claim_version_qualifier_evidence
              WHERE memory_claim_version_qualifier_evidence.memory_claim_version_qualifier_id
                = q.memory_claim_version_qualifier_id
              ORDER BY evidence_item_id
            ) AS evidence_item_ids,
            q.created_at
     FROM memory_claim_version_qualifiers q
     JOIN memory_claim_versions v
       ON v.memory_claim_version_id = q.memory_claim_version_id
     WHERE q.user_id = $1 AND v.memory_claim_id = $2
     ORDER BY v.revision, q.axis_id, q.role_side`,
    [userId, claimId],
  );
  return toQualifierRecords(result.rows);
}

/** Current primary Entity labels per locale for hint phrase rendering. */
export async function findCurrentPrimaryLabelsWithin(
  client: Pool | PoolClient,
  userId: UserId,
  entityIds: readonly string[],
): Promise<Record<string, { zh: string | null; en: string | null }>> {
  const labels: Record<string, { zh: string | null; en: string | null }> = {};
  for (const entityId of entityIds) {
    labels[entityId] = { zh: null, en: null };
  }
  if (entityIds.length === 0) return labels;
  const result = await client.query<{
    entity_id: string;
    locale: string;
    label: string;
  }>(
    `SELECT entity_id, locale, label FROM entity_labels
     WHERE user_id = $1
       AND entity_id = ANY($2::uuid[])
       AND label_kind = 'primary' AND is_current AND content_purged_at IS NULL
       AND (locale ILIKE 'zh%' OR locale ILIKE 'en%')`,
    [userId, [...entityIds]],
  );
  for (const row of result.rows) {
    const entry = labels[row.entity_id] ?? { zh: null, en: null };
    // Conversation locale tags (zh-CN / en-US) fold onto the registry's two
    // hint locales by prefix.
    if (row.locale.toLowerCase().startsWith("zh")) entry.zh = row.label;
    if (row.locale.toLowerCase().startsWith("en")) entry.en = row.label;
    labels[row.entity_id] = entry;
  }
  return labels;
}

async function insertResolverHintRowsWithin(
  client: PoolClient,
  input: {
    userId: UserId;
    rows: readonly RelationshipResolverHintPlanRow[];
    now: Date;
  },
): Promise<number> {
  for (const row of input.rows) {
    await client.query(
      `INSERT INTO relationship_resolver_hints (
         relationship_resolver_hint_id, user_id, memory_claim_id,
         memory_claim_version_id, resolved_entity_id, context_entity_id,
         view_direction, locale, temporal_form, role_side, role_axis_id,
         role_term, role_source, phrase, rebuilt_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        asRelationshipResolverHintId(createUuidV7(input.now)),
        input.userId,
        row.memoryClaimId,
        row.memoryClaimVersionId,
        row.resolvedEntityId,
        row.contextEntityId,
        row.viewDirection,
        row.locale,
        row.temporalForm,
        row.roleSide,
        row.roleAxisId,
        row.roleTerm,
        row.roleSource,
        row.phrase,
        input.now,
      ],
    );
  }
  return input.rows.length;
}

/**
 * Rebuild one claim's Resolver Hint projection from its CURRENT version
 * (delete + reinsert, ADR-0027). No-op when the claim has no current version.
 */
export async function rebuildRelationshipResolverHintsWithin(
  client: PoolClient,
  input: {
    userId: UserId;
    claimId: MemoryClaimId;
    hints: RelationshipHintProjectionInputs;
    now: Date;
  },
): Promise<readonly RelationshipResolverHintPlanRow[]> {
  const claimRow = await client.query<{
    subject_entity_id: string;
    object_entity_id: string | null;
    predicate_id: string;
    current_version_id: string | null;
  }>(
    `SELECT subject_entity_id, object_entity_id, predicate_id, current_version_id
     FROM memory_claims WHERE user_id = $1 AND memory_claim_id = $2`,
    [input.userId, input.claimId],
  );
  const claim = claimRow.rows[0];
  if (!claim?.current_version_id || !claim.object_entity_id) {
    await client.query(
      `DELETE FROM relationship_resolver_hints
       WHERE user_id = $1 AND memory_claim_id = $2`,
      [input.userId, input.claimId],
    );
    return [];
  }
  const versionRow = await client.query<{
    memory_claim_version_id: string;
    status: MemoryClaimVersionRecord["status"];
    temporal_status: TemporalBounds["temporalStatus"];
    valid_from: Date | null;
    valid_from_precision: TemporalBounds["validFromPrecision"];
    valid_to: Date | null;
    valid_to_precision: TemporalBounds["validToPrecision"];
  }>(
    `SELECT memory_claim_version_id, status, temporal_status, valid_from,
            valid_from_precision, valid_to, valid_to_precision
     FROM memory_claim_versions
     WHERE user_id = $1 AND memory_claim_version_id = $2`,
    [input.userId, claim.current_version_id],
  );
  const version = versionRow.rows[0];
  if (!version) {
    throw new Error(
      `Claim ${input.claimId} points at missing version ${claim.current_version_id}.`,
    );
  }
  if (version.status === "retracted") {
    // The Forget fence is claim state: a fenced claim projects nothing.
    await client.query(
      `DELETE FROM relationship_resolver_hints
       WHERE user_id = $1 AND memory_claim_id = $2`,
      [input.userId, input.claimId],
    );
    return [];
  }
  const labels = await findCurrentPrimaryLabelsWithin(client, input.userId, [
    claim.subject_entity_id,
    claim.object_entity_id,
  ]);
  const qualifiers = await listClaimVersionQualifiersWithin(
    client,
    input.userId,
    asMemoryClaimVersionId(claim.current_version_id),
  );
  const rows = planRelationshipResolverHints({
    entry: input.hints.entry,
    projections: input.hints.projections,
    localizations: input.hints.localizations,
    claim: {
      memoryClaimId: input.claimId,
      predicateId: claim.predicate_id,
      subjectEntityId: claim.subject_entity_id,
      objectEntityId: claim.object_entity_id,
    },
    currentVersion: {
      memoryClaimVersionId: asMemoryClaimVersionId(claim.current_version_id),
      temporal: {
        temporalStatus: version.temporal_status,
        validFrom: version.valid_from,
        validFromPrecision: version.valid_from_precision,
        validTo: version.valid_to,
        validToPrecision: version.valid_to_precision,
      },
    },
    qualifiers,
    labels,
  });
  await client.query(
    `DELETE FROM relationship_resolver_hints
     WHERE user_id = $1 AND memory_claim_id = $2`,
    [input.userId, input.claimId],
  );
  await insertResolverHintRowsWithin(client, {
    userId: input.userId,
    rows,
    now: input.now,
  });
  return rows;
}
