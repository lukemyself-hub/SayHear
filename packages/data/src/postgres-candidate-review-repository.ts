import type { Pool, PoolClient } from "pg";

import {
  asCandidateReviewAuditId,
  asMemoryCandidateId,
  asUserId,
  asPredicateChangeProposalCandidateLinkId,
  asPredicateChangeProposalId,
  asPredicateChangeProposalVersionId,
  type MemoryCandidateId,
  type PredicateChangeProposalId,
  type PredicateChangeProposalVersionId,
  type UserId,
} from "@sayhear/domain";

import {
  addDays,
  candidateSemanticTarget,
  dedupeFingerprint,
  DEDUPE_FINGERPRINT_KEY_VERSION,
  MEMORY_ADMISSION_POLICY_VERSION,
  REGISTRY_RELEASE_WAIT_DAYS,
  TERMINAL_CONTENT_EXPIRY_DAYS,
  type CandidateDispositionPlan,
  type CandidateReviewQueueEntry,
  type ClaimTypedValue,
  type MemoryCandidateRecord,
} from "@sayhear/application";

import {
  CANDIDATE_COLUMNS,
  rowToCandidate,
  type CandidateRow,
} from "./postgres-memory-claim-repository";
import { createUuidV7 } from "./uuid-v7";
import type {
  CandidateReviewAuthDenialReason,
  CandidateReviewRepository,
  PredicateChangeProposalCandidateLinkRecord,
  PredicateChangeProposalRecord,
  PredicateChangeProposalVersionRecord,
  ProposalEntryDraft,
  ReviewStage,
} from "@sayhear/application";

/**
 * PostgreSQL executor for the Candidate Review and Predicate Registry
 * governance modules (SPEC #193 §8, ADR-0046–0053, ADR-0122). Every command
 * is a synchronous conditional database update in one short transaction —
 * no durable workflow is created for a human disposition — and appends a
 * content-free audit row in the SAME transaction as the state change.
 *
 * All deadline semantics live inside the WHERE clauses: a disposition is
 * valid only when `decided_at <= review_due_at`, the exact symmetry of
 * ADR-0050's `published_at <= registry_release_due_at` rule, so no outcome
 * depends on which asynchronous task ran first.
 */

const REGISTRY_RELEASE_COMMAND_TYPE = "predicate_registry_release";
const CANDIDATE_REMAP_COMMAND_TYPE = "candidate_remap";
const REGISTRY_RELEASE_EVENT_TYPE = "predicate_registry_released";
const CANDIDATE_REMAP_EVENT_TYPE = "candidate_remap_requested";

type ProposalVersionRow = {
  predicate_change_proposal_version_id: string;
  predicate_change_proposal_id: string;
  revision: number;
  base_registry_version: number;
  proposed_predicate_identity: string;
  entry_label: string;
  entry_definition: string;
  entry_value_schema: unknown;
  entry_synthetic_examples: unknown;
  governance_rationale: string;
  reviewer_principal_id: string;
  reason_code: string | null;
  status: PredicateChangeProposalVersionRecord["status"];
  decision_scope: PredicateChangeProposalVersionRecord["decisionScope"];
  supersedes_version_id: string | null;
  created_at: Date;
  published_registry_version: number | null;
  published_at: Date | null;
};

function rowToProposalVersion(
  row: ProposalVersionRow,
): PredicateChangeProposalVersionRecord {
  return {
    predicateChangeProposalVersionId: asPredicateChangeProposalVersionId(
      row.predicate_change_proposal_version_id,
    ),
    predicateChangeProposalId: asPredicateChangeProposalId(
      row.predicate_change_proposal_id,
    ),
    revision: row.revision,
    baseRegistryVersion: row.base_registry_version,
    proposedPredicateIdentity: row.proposed_predicate_identity,
    label: row.entry_label,
    definition: row.entry_definition,
    valueSchemaDraft: row.entry_value_schema,
    syntheticExamples: toSyntheticExamples(row.entry_synthetic_examples),
    governanceRationale: row.governance_rationale,
    reviewerPrincipalId: row.reviewer_principal_id,
    reasonCode: row.reason_code,
    status: row.status,
    decisionScope: row.decision_scope,
    supersedesVersionId: row.supersedes_version_id
      ? asPredicateChangeProposalVersionId(row.supersedes_version_id)
      : null,
    createdAt: row.created_at,
    publishedRegistryVersion: row.published_registry_version,
    publishedAt: row.published_at,
  };
}

function toSyntheticExamples(
  raw: unknown,
): PredicateChangeProposalVersionRecord["syntheticExamples"] {
  const record = (raw ?? {}) as { positive?: unknown; negative?: unknown };
  const strings = (value: unknown): readonly string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    positive: strings(record.positive),
    negative: strings(record.negative),
  };
}

const VERSION_COLUMNS = `predicate_change_proposal_version_id, predicate_change_proposal_id,
  revision, base_registry_version, proposed_predicate_identity, entry_label,
  entry_definition, entry_value_schema, entry_synthetic_examples,
  governance_rationale, reviewer_principal_id, reason_code, status,
  decision_scope, supersedes_version_id, created_at,
  published_registry_version, published_at`;

type ReviewRejectionDiagnosis =
  | { outcome: "not_eligible" }
  | { outcome: "review_deadline_passed" };

export class PostgresCandidateReviewRepository
  implements CandidateReviewRepository
{
  public constructor(
    private readonly pool: Pool,
    private readonly dedupeFingerprintSecret: string,
  ) {
    if (!dedupeFingerprintSecret) {
      throw new Error("dedupeFingerprintSecret must be non-empty.");
    }
  }

  public async authorizeCandidateReview(input: {
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
  > {
    const result = await this.pool.query<{
      capability_status: string;
      step_up_authenticated_at: Date | null;
    }>(
      `SELECT diagnostic_grant.status AS capability_status,
              diagnostic_grant.step_up_authenticated_at
       FROM auth_sessions session
       INNER JOIN internal_diagnostic_access_grants diagnostic_grant
         ON diagnostic_grant.session_token_hash = session.session_token_hash
        AND diagnostic_grant.capability = $3
       WHERE session.user_id = $1
         AND session.session_token_hash = decode($2, 'hex')
         AND session.expires_at > $4`,
      [input.userId, input.authSessionId, input.capability, input.now],
    );
    const grant = result.rows[0];
    if (!grant || grant.capability_status !== "active") {
      return { outcome: "denied", reason: "elevated_capability_required" };
    }
    if (input.requireStepUp) {
      const stepUpAt = grant.step_up_authenticated_at?.getTime();
      const now = input.now.getTime();
      if (
        stepUpAt === undefined ||
        stepUpAt > now ||
        stepUpAt < now - input.stepUpMaxAgeMs
      ) {
        return { outcome: "denied", reason: "recent_step_up_required" };
      }
    }
    return { outcome: "allowed" };
  }

  public async recordCandidateReviewAudit(input: {
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
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO candidate_review_audits (
         candidate_review_audit_id, user_id, command, target_type, target_id,
         disposition, reason, operator_principal_id, policy_version, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        asCandidateReviewAuditId(createUuidV7(input.now)),
        input.userId,
        input.command,
        input.targetType,
        input.targetId,
        input.disposition,
        input.reason,
        input.operatorPrincipalId,
        input.policyVersion,
        input.now,
      ],
    );
  }

  // ── Candidate review reads ──────────────────────────────────────────────

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

  public async listCandidateEvidenceRevisionIds(
    userId: UserId,
    candidateId: MemoryCandidateId,
  ): Promise<readonly string[]> {
    const client = await this.pool.connect();
    try {
      return await listCandidateEvidenceRevisionIdsWithin(client, {
        userId,
        candidateId,
      });
    } finally {
      client.release();
    }
  }

  public async findCurrentEntityLabels(
    userId: UserId,
    entityIds: readonly string[],
  ): Promise<Readonly<Record<string, string>>> {
    if (entityIds.length === 0) return {};
    const result = await this.pool.query<{ entity_id: string; label: string }>(
      `SELECT DISTINCT ON (entity_id) entity_id, label
       FROM entity_labels
       WHERE user_id = $1 AND entity_id = ANY($2::uuid[])
         AND label_kind = 'primary' AND is_current
         AND content_purged_at IS NULL
       ORDER BY entity_id, created_at DESC`,
      [userId, [...entityIds]],
    );
    const labels: Record<string, string> = {};
    for (const row of result.rows) {
      labels[row.entity_id] = row.label;
    }
    return labels;
  }

  public async listReviewQueue(
    userId: UserId,
    now: Date,
  ): Promise<readonly CandidateReviewQueueEntry[]> {
    const result = await this.pool.query<
      CandidateRow & {
        linked_proposal_id: string | null;
        linked_proposal_status: PredicateChangeProposalVersionRecord["status"] | null;
      }
    >(
      `SELECT candidate.*, link.predicate_change_proposal_id AS linked_proposal_id,
              current_version.status AS linked_proposal_status
       FROM memory_candidates candidate
       LEFT JOIN predicate_change_proposal_candidate_links link
         ON link.user_id = candidate.user_id
        AND link.memory_candidate_id = candidate.memory_candidate_id
       LEFT JOIN predicate_change_proposals proposal
         ON proposal.predicate_change_proposal_id = link.predicate_change_proposal_id
       LEFT JOIN predicate_change_proposal_versions current_version
         ON current_version.predicate_change_proposal_version_id =
              proposal.current_version_id
       WHERE candidate.user_id = $1 AND candidate.content_purged_at IS NULL
         AND (
           candidate.status IN ('needs_predicate_review', 'awaiting_registry_release')
           OR (candidate.status IN ('rejected', 'stale')
               AND candidate.terminal_content_expires_at > $2)
         )
       ORDER BY
         CASE candidate.status
           WHEN 'needs_predicate_review' THEN 0
           WHEN 'awaiting_registry_release' THEN 1
           ELSE 2
         END,
         COALESCE(candidate.review_due_at, candidate.registry_release_due_at,
                  candidate.terminal_content_expires_at) ASC`,
      [userId, now],
    );
    return result.rows.map((row) => {
      const candidate = rowToCandidate(row);
      return {
        candidate,
        stage: reviewStageFor(candidate, now),
        linkedProposalId: row.linked_proposal_id
          ? asPredicateChangeProposalId(row.linked_proposal_id)
          : null,
        linkedProposalStatus: row.linked_proposal_status ?? null,
        governanceBlocked:
          row.linked_proposal_status === "rejected" &&
          candidate.status === "awaiting_registry_release",
      } satisfies CandidateReviewQueueEntry;
    });
  }

  // ── Candidate review CAS writes ─────────────────────────────────────────

  public async casMapExisting(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    predicateId: string;
    registryVersion: number;
    typedValue: ClaimTypedValue | null;
    decidedAt: Date;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const valueJson =
        input.typedValue === null ? null : JSON.stringify(input.typedValue);
      const result = await client.query<{ memory_candidate_id: string }>(
        `UPDATE memory_candidates
         SET status = 'proposed',
             predicate_id = $3,
             predicate_registry_version = $4,
             predicate_resolution_status = 'mapped',
             proposed_concept = NULL,
             mapping_confidence = NULL,
             proposed_object_value = COALESCE($6::jsonb, proposed_object_value),
             decided_at = $5
         WHERE user_id = $1 AND memory_candidate_id = $2
           AND status = 'needs_predicate_review'
           AND review_due_at IS NOT NULL
           AND review_due_at >= $5
         RETURNING memory_candidate_id`,
        [
          input.userId,
          input.candidateId,
          input.predicateId,
          input.registryVersion,
          input.decidedAt,
          valueJson,
        ],
      );
      await client.query("COMMIT");
      return result.rows.length > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async casRemapCandidate(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    predicateId: string;
    registryVersion: number;
    typedValue: ClaimTypedValue;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ memory_candidate_id: string }>(
        `UPDATE memory_candidates
         SET status = 'proposed',
             predicate_id = $3,
             predicate_registry_version = $4,
             predicate_resolution_status = 'mapped',
             proposed_concept = NULL,
             mapping_confidence = NULL,
             proposed_object_value = $5::jsonb
         WHERE user_id = $1 AND memory_candidate_id = $2
           AND status = 'awaiting_registry_release'
           AND content_purged_at IS NULL
         RETURNING memory_candidate_id`,
        [
          input.userId,
          input.candidateId,
          input.predicateId,
          input.registryVersion,
          JSON.stringify(input.typedValue),
        ],
      );
      await client.query("COMMIT");
      return result.rows.length > 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async casRejectCandidate(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    plan: CandidateDispositionPlan;
    reviewerPrincipalId: string;
    governance:
      | Readonly<{ action: "none" }>
      | Readonly<{ action: "create"; draft: ProposalEntryDraft }>
      | Readonly<{ action: "associate"; proposalId: PredicateChangeProposalId }>;
    decidedAt: Date;
  }): Promise<
    | { outcome: "rejected" }
    | ReviewRejectionDiagnosis
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const disposed = await client.query<{ memory_candidate_id: string }>(
        `UPDATE memory_candidates
         SET status = $3,
             disposition_reason_code = $4,
             disposition_policy_version = $5,
             decided_at = $6,
             terminal_effective_at = $7,
             terminal_content_expires_at = $8,
             reproposal_policy = $9,
             dedupe_fingerprint = $10,
             dedupe_fingerprint_key_version = $11
         WHERE user_id = $1 AND memory_candidate_id = $2
           AND status = 'needs_predicate_review'
           AND review_due_at IS NOT NULL
           AND review_due_at >= $6
         RETURNING memory_candidate_id`,
        [
          input.userId,
          input.candidateId,
          input.plan.status,
          input.plan.dispositionReasonCode,
          input.plan.dispositionPolicyVersion,
          input.decidedAt,
          input.plan.terminalEffectiveAt,
          input.plan.terminalContentExpiresAt,
          input.plan.reproposalPolicy,
          input.plan.dedupeFingerprint,
          DEDUPE_FINGERPRINT_KEY_VERSION,
        ],
      );
      if (disposed.rows.length === 0) {
        await client.query("ROLLBACK");
        return await this.diagnoseLateDisposition(input);
      }
      if (input.governance.action === "create") {
        await insertProposalVersionForCandidateWithin(client, {
          userId: input.userId,
          candidateId: input.candidateId,
          draft: input.governance.draft,
          reviewerPrincipalId: input.reviewerPrincipalId,
          decisionScope: "product_value_rejection",
          reasonCode: input.plan.dispositionReasonCode,
          status: "rejected",
          decidedAt: input.decidedAt,
        });
      } else if (input.governance.action === "associate") {
        const linked = await linkCandidateToProposalWithin(client, {
          userId: input.userId,
          candidateId: input.candidateId,
          proposalId: input.governance.proposalId,
          requiredStatus: "rejected",
          requiredScope: "product_value_rejection",
          decidedAt: input.decidedAt,
        });
        if (!linked.ok) {
          await client.query("ROLLBACK");
          return await this.diagnoseLateDisposition(input);
        }
      }
      await client.query("COMMIT");
      return { outcome: "rejected" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Diagnose a lost conditional update: distinguishes a late command
   * (`review_deadline_passed`, fail closed even when the sweeper has not run
   * yet) from an already-disposed Candidate.
   */
  private async diagnoseLateDisposition(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    decidedAt: Date;
  }): Promise<ReviewRejectionDiagnosis> {
    const row = await this.pool.query<{
      status: MemoryCandidateRecord["status"];
      review_due_at: Date | null;
    }>(
      `SELECT status, review_due_at FROM memory_candidates
       WHERE user_id = $1 AND memory_candidate_id = $2`,
      [input.userId, input.candidateId],
    );
    const candidate = row.rows[0];
    if (
      candidate &&
      candidate.status === "needs_predicate_review" &&
      candidate.review_due_at !== null &&
      candidate.review_due_at.getTime() < input.decidedAt.getTime()
    ) {
      return { outcome: "review_deadline_passed" };
    }
    return { outcome: "not_eligible" };
  }

  public async casApproveForRegistryChange(input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    reviewerPrincipalId: string;
    mode:
      | Readonly<{ action: "create"; draft: ProposalEntryDraft }>
      | Readonly<{ action: "associate"; proposalId: PredicateChangeProposalId }>;
    decidedAt: Date;
  }): Promise<
    | { outcome: "approved"; proposalVersionId: PredicateChangeProposalVersionId }
    | ReviewRejectionDiagnosis
    | { outcome: "proposal_not_found" }
    | { outcome: "proposal_not_awaiting_release" }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const releaseDueAt = addDays(
        input.decidedAt,
        REGISTRY_RELEASE_WAIT_DAYS,
      );
      const advanced = await client.query<{ memory_candidate_id: string }>(
        `UPDATE memory_candidates
         SET status = 'awaiting_registry_release',
             registry_release_wait_started_at = $3,
             registry_release_due_at = $4,
             decided_at = $3
         WHERE user_id = $1 AND memory_candidate_id = $2
           AND status = 'needs_predicate_review'
           AND review_due_at IS NOT NULL
           AND review_due_at >= $3
         RETURNING memory_candidate_id`,
        [input.userId, input.candidateId, input.decidedAt, releaseDueAt],
      );
      if (advanced.rows.length === 0) {
        await client.query("ROLLBACK");
        return await this.diagnoseLateDisposition(input);
      }
      let versionId: PredicateChangeProposalVersionId;
      if (input.mode.action === "create") {
        versionId = await insertProposalVersionForCandidateWithin(client, {
          userId: input.userId,
          candidateId: input.candidateId,
          draft: input.mode.draft,
          reviewerPrincipalId: input.reviewerPrincipalId,
          decisionScope: "registry_change",
          reasonCode: null,
          status: "awaiting_release",
          decidedAt: input.decidedAt,
        });
      } else {
        const linked = await linkCandidateToProposalWithin(client, {
          userId: input.userId,
          candidateId: input.candidateId,
          proposalId: input.mode.proposalId,
          requiredStatus: "awaiting_release",
          requiredScope: "registry_change",
          decidedAt: input.decidedAt,
        });
        if (!linked.ok) {
          await client.query("ROLLBACK");
          return {
            outcome:
              linked.reason === "proposal_not_rejected"
                ? "proposal_not_awaiting_release"
                : linked.reason,
          };
        }
        versionId = linked.versionId;
      }
      await client.query("COMMIT");
      return { outcome: "approved", proposalVersionId: versionId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // ── Governance reads ────────────────────────────────────────────────────

  public async findProposal(
    proposalId: PredicateChangeProposalId,
  ): Promise<PredicateChangeProposalRecord | null> {
    const result = await this.pool.query<{
      predicate_change_proposal_id: string;
      current_version_id: string | null;
      created_at: Date;
    }>(
      `SELECT predicate_change_proposal_id, current_version_id, created_at
       FROM predicate_change_proposals
       WHERE predicate_change_proposal_id = $1`,
      [proposalId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      predicateChangeProposalId: asPredicateChangeProposalId(
        row.predicate_change_proposal_id,
      ),
      currentVersionId: row.current_version_id
        ? asPredicateChangeProposalVersionId(row.current_version_id)
        : null,
      createdAt: row.created_at,
    };
  }

  public async findCurrentProposalVersion(
    proposalId: PredicateChangeProposalId,
  ): Promise<PredicateChangeProposalVersionRecord | null> {
    const result = await this.pool.query<ProposalVersionRow>(
      `SELECT ${VERSION_COLUMNS.split(", ")
        .map((column) => `version.${column}`)
        .join(", ")}
       FROM predicate_change_proposal_versions version
       JOIN predicate_change_proposals proposal
         ON proposal.current_version_id =
              version.predicate_change_proposal_version_id
       WHERE proposal.predicate_change_proposal_id = $1`,
      [proposalId],
    );
    return result.rows[0] ? rowToProposalVersion(result.rows[0]) : null;
  }

  public async listProposalVersions(
    proposalId: PredicateChangeProposalId,
  ): Promise<readonly PredicateChangeProposalVersionRecord[]> {
    const result = await this.pool.query<ProposalVersionRow>(
      `SELECT ${VERSION_COLUMNS}
       FROM predicate_change_proposal_versions
       WHERE predicate_change_proposal_id = $1
       ORDER BY revision ASC`,
      [proposalId],
    );
    return result.rows.map(rowToProposalVersion);
  }

  public async findCandidateLink(
    userId: UserId,
    candidateId: MemoryCandidateId,
  ): Promise<PredicateChangeProposalCandidateLinkRecord | null> {
    const result = await this.pool.query<{
      predicate_change_proposal_candidate_link_id: string;
      predicate_change_proposal_id: string;
      created_at: Date;
    }>(
      `SELECT predicate_change_proposal_candidate_link_id,
              predicate_change_proposal_id, created_at
       FROM predicate_change_proposal_candidate_links
       WHERE user_id = $1 AND memory_candidate_id = $2`,
      [userId, candidateId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      predicateChangeProposalCandidateLinkId:
        asPredicateChangeProposalCandidateLinkId(
          row.predicate_change_proposal_candidate_link_id,
        ),
      userId,
      memoryCandidateId: candidateId,
      predicateChangeProposalId: asPredicateChangeProposalId(
        row.predicate_change_proposal_id,
      ),
      createdAt: row.created_at,
    };
  }

  // ── Governance commands ─────────────────────────────────────────────────

  public async casCancelProposal(input: {
    proposalId: PredicateChangeProposalId;
    now: Date;
  }): Promise<
    | { outcome: "canceled"; staledCandidateCount: number }
    | { outcome: "already_canceled" }
    | { outcome: "not_awaiting_release" }
    | { outcome: "not_found" }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const proposal = await client.query<{
        current_version_id: string | null;
      }>(
        `SELECT current_version_id FROM predicate_change_proposals
         WHERE predicate_change_proposal_id = $1
         FOR UPDATE`,
        [input.proposalId],
      );
      const row = proposal.rows[0];
      if (!row || !row.current_version_id) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      const canceled = await client.query<{ status: string }>(
        `UPDATE predicate_change_proposal_versions
         SET status = 'canceled'
         WHERE predicate_change_proposal_version_id = $1
           AND status = 'awaiting_release'
         RETURNING status`,
        [row.current_version_id],
      );
      if (canceled.rows.length === 0) {
        const current = await client.query<{ status: string }>(
          `SELECT status FROM predicate_change_proposal_versions
           WHERE predicate_change_proposal_version_id = $1`,
          [row.current_version_id],
        );
        await client.query("ROLLBACK");
        return current.rows[0]?.status === "canceled"
          ? { outcome: "already_canceled" }
          : { outcome: "not_awaiting_release" };
      }
      const staled = await this.staleLinkedCandidatesWithin(client, {
        proposalId: input.proposalId,
        now: input.now,
      });
      await client.query("COMMIT");
      return { outcome: "canceled", staledCandidateCount: staled };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async appendReconsideredProposalVersion(input: {
    proposalId: PredicateChangeProposalId;
    draft: ProposalEntryDraft;
    reviewerPrincipalId: string;
    baseRegistryVersion: number;
    decidedAt: Date;
  }): Promise<
    | { outcome: "applied"; version: PredicateChangeProposalVersionRecord }
    | { outcome: "not_rejected" }
    | { outcome: "not_found" }
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const proposal = await client.query<{
        current_version_id: string | null;
      }>(
        `SELECT current_version_id FROM predicate_change_proposals
         WHERE predicate_change_proposal_id = $1
         FOR UPDATE`,
        [input.proposalId],
      );
      const row = proposal.rows[0];
      if (!row || !row.current_version_id) {
        await client.query("ROLLBACK");
        return { outcome: "not_found" };
      }
      const current = await client.query<ProposalVersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM predicate_change_proposal_versions
         WHERE predicate_change_proposal_version_id = $1`,
        [row.current_version_id],
      );
      const currentVersion = current.rows[0];
      if (
        !currentVersion ||
        currentVersion.status !== "rejected" ||
        currentVersion.decision_scope !== "product_value_rejection"
      ) {
        await client.query("ROLLBACK");
        return { outcome: "not_rejected" };
      }
      const versionId = createUuidV7(input.decidedAt);
      const inserted = await client.query<ProposalVersionRow>(
        `INSERT INTO predicate_change_proposal_versions (
           predicate_change_proposal_version_id, predicate_change_proposal_id,
           revision, base_registry_version, proposed_predicate_identity,
           entry_label, entry_definition, entry_value_schema,
           entry_synthetic_examples, governance_rationale,
           reviewer_principal_id, reason_code, status, decision_scope,
           supersedes_version_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11,
           NULL, 'awaiting_release', 'registry_change', $12, $13)
         RETURNING ${VERSION_COLUMNS}`,
        [
          versionId,
          input.proposalId,
          currentVersion.revision + 1,
          input.baseRegistryVersion,
          input.draft.proposedPredicateIdentity,
          input.draft.label,
          input.draft.definition,
          JSON.stringify(input.draft.valueSchemaDraft),
          JSON.stringify(input.draft.syntheticExamples),
          input.draft.rationale,
          input.reviewerPrincipalId,
          currentVersion.predicate_change_proposal_version_id,
          input.decidedAt,
        ],
      );
      await client.query(
        `UPDATE predicate_change_proposals
         SET current_version_id = $2
         WHERE predicate_change_proposal_id = $1`,
        [input.proposalId, versionId],
      );
      await client.query("COMMIT");
      return {
        outcome: "applied",
        version: rowToProposalVersion(inserted.rows[0]!),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // ── Release/remap workflow reads and writes (ADR-0122) ───────────────────

  public async readRemapCommand(input: {
    workflowCommandId: string;
  }): Promise<
    | Readonly<{
        userId: UserId;
        candidateId: MemoryCandidateId;
        registryVersion: number;
        policyVersion: string;
      }>
    | null
  > {
    const result = await this.pool.query<{
      user_id: string;
      memory_candidate_id: string;
      source_revision: string;
      policy_version: string;
    }>(
      `SELECT candidate.user_id, command.subject_id AS memory_candidate_id,
              command.source_revision::text AS source_revision,
              command.policy_version
       FROM workflow_commands command
       JOIN memory_candidates candidate
         ON candidate.memory_candidate_id = command.subject_id
       WHERE command.workflow_command_id = $1
         AND command.command_type = $2
         AND command.subject_type = 'memory_candidate'`,
      [input.workflowCommandId, CANDIDATE_REMAP_COMMAND_TYPE],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      userId: asUserId(row.user_id),
      candidateId: asMemoryCandidateId(row.memory_candidate_id),
      registryVersion: Number(row.source_revision),
      policyVersion: row.policy_version,
    };
  }

  public async completeRemapCommand(input: {
    workflowCommandId: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_commands
       SET status = 'completed',
           dispatched_at = COALESCE(dispatched_at, CURRENT_TIMESTAMP)
       WHERE workflow_command_id = $1
         AND command_type = $2
         AND status <> 'dead_lettered'`,
      [input.workflowCommandId, CANDIDATE_REMAP_COMMAND_TYPE],
    );
  }

  /**
   * Idempotent per-candidate remap command + outbox event in one
   * transaction (ADR-0122 key:
   * `candidate-remap/<candidate-id>/<registry-version>/<policy-version>`).
   */
  public async insertRemapCommand(input: {
    userId: string;
    candidateId: MemoryCandidateId;
    registryVersion: number;
    policyVersion: string;
    now: Date;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await insertCandidateRemapCommandWithin(client, {
        userId: input.userId,
        candidateId: input.candidateId,
        registryVersion: input.registryVersion,
        policyVersion: input.policyVersion,
        now: input.now ?? new Date(),
      });
      await client.query("COMMIT");
      return inserted;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // ── shared helpers ──────────────────────────────────────────────────────

  /**
   * Cancel stalings (ADR-0122): every still-`awaiting_registry_release`
   * linked Candidate becomes stale with reason `registry_release_canceled`
   * and terminal_effective_at = cancel commit time; already-terminal
   * Candidates stay unchanged.
   */
  private async staleLinkedCandidatesWithin(
    client: PoolClient,
    input: { proposalId: PredicateChangeProposalId; now: Date },
  ): Promise<number> {
    const links = await client.query<{
      memory_candidate_id: string;
      user_id: string;
    }>(
      `SELECT candidate.memory_candidate_id, candidate.user_id
       FROM predicate_change_proposal_candidate_links link
       JOIN memory_candidates candidate
         ON candidate.user_id = link.user_id
        AND candidate.memory_candidate_id = link.memory_candidate_id
       WHERE link.predicate_change_proposal_id = $1
         AND candidate.status = 'awaiting_registry_release'
         AND candidate.content_purged_at IS NULL
       FOR UPDATE OF candidate`,
      [input.proposalId],
    );
    let staled = 0;
    for (const link of links.rows) {
      const candidateId = asMemoryCandidateId(link.memory_candidate_id);
      const revisions = await listCandidateEvidenceRevisionIdsWithin(client, {
        userId: link.user_id,
        candidateId,
      });
      const candidate = await client.query<CandidateRow>(
        `SELECT ${CANDIDATE_COLUMNS} FROM memory_candidates
         WHERE user_id = $1 AND memory_candidate_id = $2`,
        [link.user_id, candidateId],
      );
      const record = candidate.rows[0];
      if (!record) continue;
      const plan = planCancelStaleDisposition({
        userId: link.user_id,
        semanticTarget: candidateSemanticTarget(rowToCandidate(record)),
        evidenceRevisionIds: revisions,
        secret: this.dedupeFingerprintSecret,
        now: input.now,
      });
      const stale = await client.query(
        `UPDATE memory_candidates
         SET status = 'stale',
             disposition_reason_code = $3,
             disposition_policy_version = $4,
             decided_at = $5,
             terminal_effective_at = $6,
             terminal_content_expires_at = $7,
             reproposal_policy = $8,
             dedupe_fingerprint = $9,
             dedupe_fingerprint_key_version = $10
         WHERE user_id = $1 AND memory_candidate_id = $2
           AND status = 'awaiting_registry_release'`,
        [
          link.user_id,
          candidateId,
          plan.dispositionReasonCode,
          plan.dispositionPolicyVersion,
          input.now,
          plan.terminalEffectiveAt,
          plan.terminalContentExpiresAt,
          plan.reproposalPolicy,
          plan.dedupeFingerprint,
          DEDUPE_FINGERPRINT_KEY_VERSION,
        ],
      );
      staled += stale.rowCount ?? 0;
    }
    return staled;
  }
}

/**
 * Cancel-stale disposition (ADR-0122): terminal_effective_at is the CANCEL
 * COMMIT TIME — not the original policy deadline, and never a sweeper time.
 */
export function planCancelStaleDisposition(input: {
  userId: string;
  semanticTarget: string;
  evidenceRevisionIds: readonly string[];
  secret: string;
  now: Date;
}): CandidateDispositionPlan {
  return {
    status: "stale",
    dispositionReasonCode: "registry_release_canceled",
    dispositionPolicyVersion: MEMORY_ADMISSION_POLICY_VERSION,
    reproposalPolicy: "material_change_allowed",
    terminalEffectiveAt: input.now,
    terminalContentExpiresAt: addDays(input.now, TERMINAL_CONTENT_EXPIRY_DAYS),
    dedupeFingerprint: dedupeFingerprint({
      secret: input.secret,
      userId: input.userId,
      semanticTarget: input.semanticTarget,
      evidenceRevisionIds: input.evidenceRevisionIds,
      policyVersion: MEMORY_ADMISSION_POLICY_VERSION,
    }),
  };
}

async function listCandidateEvidenceRevisionIdsWithin(
  client: PoolClient,
  input: { userId: string; candidateId: MemoryCandidateId },
): Promise<readonly string[]> {
  const result = await client.query<{ source_revision_id: string }>(
    `SELECT item.source_revision_id
     FROM memory_candidate_evidence_links link
     JOIN evidence_items item
       ON item.evidence_item_id = link.evidence_item_id
      AND item.user_id = link.user_id
     WHERE link.user_id = $1 AND link.memory_candidate_id = $2`,
    [input.userId, input.candidateId],
  );
  return result.rows.map((row) => row.source_revision_id);
}

/** Create the Proposal + first immutable version + the owner-scoped link. */
async function insertProposalVersionForCandidateWithin(
  client: PoolClient,
  input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    draft: ProposalEntryDraft;
    reviewerPrincipalId: string;
    decisionScope: PredicateChangeProposalVersionRecord["decisionScope"];
    reasonCode: string | null;
    status: PredicateChangeProposalVersionRecord["status"];
    decidedAt: Date;
  },
): Promise<PredicateChangeProposalVersionId> {
  const proposalId = createUuidV7(input.decidedAt);
  const versionId = createUuidV7(input.decidedAt);
  // The pointer is set after the immutable version row exists (FK order).
  await client.query(
    `INSERT INTO predicate_change_proposals (
       predicate_change_proposal_id, current_version_id, created_at
     ) VALUES ($1, NULL, $2)`,
    [proposalId, input.decidedAt],
  );
  const inserted = await client.query<ProposalVersionRow>(
    `INSERT INTO predicate_change_proposal_versions (
       predicate_change_proposal_version_id, predicate_change_proposal_id,
       revision, base_registry_version, proposed_predicate_identity,
       entry_label, entry_definition, entry_value_schema,
       entry_synthetic_examples, governance_rationale, reviewer_principal_id,
       reason_code, status, decision_scope, supersedes_version_id, created_at
     ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11,
       $12, $13, NULL, $14)
     RETURNING ${VERSION_COLUMNS}`,
    [
      versionId,
      proposalId,
      input.draft.baseRegistryVersion,
      input.draft.proposedPredicateIdentity,
      input.draft.label,
      input.draft.definition,
      JSON.stringify(input.draft.valueSchemaDraft),
      JSON.stringify(input.draft.syntheticExamples),
      input.draft.rationale,
      input.reviewerPrincipalId,
      input.reasonCode,
      input.status,
      input.decisionScope,
      input.decidedAt,
    ],
  );
  await client.query(
    `UPDATE predicate_change_proposals
     SET current_version_id = $2
     WHERE predicate_change_proposal_id = $1`,
    [proposalId, versionId],
  );
  await client.query(
    `INSERT INTO predicate_change_proposal_candidate_links (
       predicate_change_proposal_candidate_link_id, user_id,
       memory_candidate_id, predicate_change_proposal_id, created_at
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [
      asPredicateChangeProposalCandidateLinkId(createUuidV7(input.decidedAt)),
      input.userId,
      input.candidateId,
      proposalId,
      input.decidedAt,
    ],
  );
  return asPredicateChangeProposalVersionId(
    inserted.rows[0]!.predicate_change_proposal_version_id,
  );
}

type ProposalLinkRequirement = {
  requiredStatus: "awaiting_release" | "rejected";
  requiredScope: "registry_change" | "product_value_rejection";
};

/** Reviewer-selected association; validates the required Proposal state. */
async function linkCandidateToProposalWithin(
  client: PoolClient,
  input: {
    userId: UserId;
    candidateId: MemoryCandidateId;
    proposalId: PredicateChangeProposalId;
    requiredStatus: "awaiting_release" | "rejected";
    requiredScope: "registry_change" | "product_value_rejection";
    decidedAt: Date;
  },
): Promise<
  | {
      ok: true;
      versionId: PredicateChangeProposalVersionId;
    }
  | {
      ok: false;
      reason: "proposal_not_found" | "proposal_not_awaiting_release" | "proposal_not_rejected";
    }
> {
  const proposal = await client.query<{ current_version_id: string | null }>(
    `SELECT current_version_id FROM predicate_change_proposals
     WHERE predicate_change_proposal_id = $1
     FOR UPDATE`,
    [input.proposalId],
  );
  const row = proposal.rows[0];
  if (!row || !row.current_version_id) {
    return { ok: false, reason: "proposal_not_found" };
  }
  const version = await client.query<
    Pick<ProposalVersionRow, "status" | "decision_scope">
  >(
    `SELECT status, decision_scope FROM predicate_change_proposal_versions
     WHERE predicate_change_proposal_version_id = $1`,
    [row.current_version_id],
  );
  const current = version.rows[0];
  if (
    !current ||
    current.status !== input.requiredStatus ||
    current.decision_scope !== input.requiredScope
  ) {
    return {
      ok: false,
      reason:
        input.requiredStatus === "awaiting_release"
          ? "proposal_not_awaiting_release"
          : "proposal_not_rejected",
    };
  }
  await client.query(
    `INSERT INTO predicate_change_proposal_candidate_links (
       predicate_change_proposal_candidate_link_id, user_id,
       memory_candidate_id, predicate_change_proposal_id, created_at
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [
      asPredicateChangeProposalCandidateLinkId(createUuidV7(input.decidedAt)),
      input.userId,
      input.candidateId,
      input.proposalId,
      input.decidedAt,
    ],
  );
  return {
    ok: true,
    versionId: asPredicateChangeProposalVersionId(row.current_version_id),
  };
}

function reviewStageFor(
  candidate: MemoryCandidateRecord,
  now: Date,
): ReviewStage {
  if (
    (candidate.status === "rejected" || candidate.status === "stale") &&
    candidate.terminalContentExpiresAt !== null &&
    candidate.terminalContentExpiresAt.getTime() > now.getTime()
  ) {
    return "terminal_grace";
  }
  if (candidate.status === "awaiting_registry_release") {
    return "awaiting_release";
  }
  if (candidate.predecessorCandidateId !== null) {
    return "successor";
  }
  return "needs_review";
}

/** Release-side remap scan row (ADR-0122). */
export type PendingRemapRow = Readonly<{
  userId: string;
  memoryCandidateId: MemoryCandidateId;
  registryVersion: number;
}>;

/**
 * Published-but-unremapped awaiting Candidates (ADR-0122): the remap scan
 * derives directly from published ProposalVersions, so a missed release
 * outbox event converges the same way as an unfinished remap. A Candidate
 * whose remap command exists with a dead-lettered or missing outbox event is
 * also re-armed here; only a completed command or a live pending event holds
 * the slot.
 */
export async function selectPendingRemapCandidates(
  pool: Pool,
  input: { policyVersion: string },
): Promise<readonly PendingRemapRow[]> {
  const result = await pool.query<{
    user_id: string;
    memory_candidate_id: string;
    published_registry_version: number;
  }>(
    `SELECT candidate.user_id, candidate.memory_candidate_id,
            version.published_registry_version
     FROM memory_candidates candidate
     JOIN predicate_change_proposal_candidate_links link
       ON link.user_id = candidate.user_id
      AND link.memory_candidate_id = candidate.memory_candidate_id
     JOIN predicate_change_proposals proposal
       ON proposal.predicate_change_proposal_id = link.predicate_change_proposal_id
     JOIN predicate_change_proposal_versions version
       ON version.predicate_change_proposal_version_id =
            proposal.current_version_id
     WHERE candidate.status = 'awaiting_registry_release'
       AND candidate.content_purged_at IS NULL
       AND version.status = 'published'
       AND version.published_registry_version IS NOT NULL
       AND version.published_at <= candidate.registry_release_due_at
       AND NOT EXISTS (
         SELECT 1
         FROM workflow_commands command
         LEFT JOIN outbox_events event
           ON event.workflow_command_id = command.workflow_command_id
          AND event.event_type = 'candidate_remap_requested'
         WHERE command.command_type = $2
           AND command.subject_type = 'memory_candidate'
           AND command.subject_id = candidate.memory_candidate_id
           AND command.source_revision = version.published_registry_version
           AND command.policy_version = $1
           AND (
             command.status = 'completed'
             OR event.status IN ('pending', 'leased', 'dispatched')
           )
       )
     LIMIT 500`,
    [input.policyVersion, CANDIDATE_REMAP_COMMAND_TYPE],
  );
  return result.rows.map((row) => ({
    userId: row.user_id,
    memoryCandidateId: asMemoryCandidateId(row.memory_candidate_id),
    registryVersion: row.published_registry_version,
  }));
}

/**
 * Idempotent per-candidate remap command + outbox event (ADR-0122 key:
 * `candidate-remap/<candidate-id>/<registry-version>/<policy-version>`).
 * Must be called INSIDE the caller's transaction. Replays converge on the
 * command identity; a dead-lettered or missing event for an existing command
 * is re-armed in place (one row per aggregate-event unique index). Returns
 * true when this call inserted the command or re-armed its delivery.
 */
export async function insertCandidateRemapCommandWithin(
  client: PoolClient,
  input: {
    userId: string;
    candidateId: MemoryCandidateId;
    registryVersion: number;
    policyVersion: string;
    now: Date;
  },
): Promise<boolean> {
  const owner = await client.query<{ data_epoch: string }>(
    `SELECT data_epoch::text FROM app_users
     WHERE user_id = $1 AND status = 'active'`,
    [input.userId],
  );
  const epoch = owner.rows[0];
  if (!epoch) {
    throw new Error("Candidate remap command owner is missing or inactive.");
  }
  const existing = await client.query<{
    workflow_command_id: string;
    command_status: string;
    event_status: string | null;
  }>(
    `SELECT command.workflow_command_id, command.status AS command_status,
            event.status AS event_status
     FROM workflow_commands command
     LEFT JOIN outbox_events event
       ON event.workflow_command_id = command.workflow_command_id
      AND event.event_type = $5
     WHERE command.command_type = $1
       AND command.subject_type = 'memory_candidate'
       AND command.subject_id = $2
       AND command.source_revision = $3
       AND command.policy_version = $4
     ORDER BY event.outbox_event_id NULLS LAST
     LIMIT 1`,
    [
      CANDIDATE_REMAP_COMMAND_TYPE,
      input.candidateId,
      input.registryVersion,
      input.policyVersion,
      CANDIDATE_REMAP_EVENT_TYPE,
    ],
  );
  const command = existing.rows[0];
  if (command) {
    if (command.command_status === "completed") {
      return false;
    }
    if (command.event_status === null) {
      await insertCandidateRemapEvent(client, {
        workflowCommandId: command.workflow_command_id,
        candidateId: input.candidateId,
        registryVersion: input.registryVersion,
        dataEpoch: Number(epoch.data_epoch),
        now: input.now,
      });
      return true;
    }
    if (command.event_status === "dead_lettered") {
      await client.query(
        `UPDATE outbox_events
         SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
             next_attempt_at = $2, attempt_count = 0, last_error_code = NULL
         WHERE workflow_command_id = $1
           AND event_type = $3
           AND status = 'dead_lettered'`,
        [command.workflow_command_id, input.now, CANDIDATE_REMAP_EVENT_TYPE],
      );
      return true;
    }
    return false;
  }
  const commandId = createUuidV7(input.now);
  const inserted = await client.query(
    `INSERT INTO workflow_commands (
       workflow_command_id, command_type, subject_type, subject_id,
       source_revision, policy_version, expected_data_epoch, status, created_at
     ) VALUES ($1, $2, 'memory_candidate', $3, $4, $5, $6, 'created', $7)
     ON CONFLICT DO NOTHING`,
    [
      commandId,
      CANDIDATE_REMAP_COMMAND_TYPE,
      input.candidateId,
      input.registryVersion,
      input.policyVersion,
      Number(epoch.data_epoch),
      input.now,
    ],
  );
  if ((inserted.rowCount ?? 0) === 0) {
    // A concurrent creator won the command insert; leave the delivery to it.
    return false;
  }
  await insertCandidateRemapEvent(client, {
    workflowCommandId: commandId,
    candidateId: input.candidateId,
    registryVersion: input.registryVersion,
    dataEpoch: Number(epoch.data_epoch),
    now: input.now,
  });
  return true;
}

async function insertCandidateRemapEvent(
  client: PoolClient,
  input: {
    workflowCommandId: string;
    candidateId: MemoryCandidateId;
    registryVersion: number;
    dataEpoch: number;
    now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (
       outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
       aggregate_revision, aggregate_data_epoch, aggregate_coverage,
       event_type, status, next_attempt_at, attempt_count, payload, created_at
     ) VALUES ($1, $2, 'memory_candidate', $3, $4, $5, 0, $6, 'pending', $7,
       0, $8::jsonb, $7)
     ON CONFLICT DO NOTHING`,
    [
      createUuidV7(input.now),
      input.workflowCommandId,
      input.candidateId,
      input.registryVersion,
      input.dataEpoch,
      CANDIDATE_REMAP_EVENT_TYPE,
      input.now,
      JSON.stringify({
        registryVersion: input.registryVersion,
      }),
    ],
  );
}

/**
 * Release publication event (ADR-0122): one command + one outbox event per
 * published Registry version, written by the release handler after the
 * release migration transaction. The per-candidate remap commands are
 * created by the idempotent scan in follow-up workflow steps.
 */
export async function insertRegistryReleaseEventWithin(
  client: PoolClient,
  input: { registryVersion: number; now: Date },
): Promise<void> {
  const commandId = createUuidV7(input.now);
  await client.query(
    `INSERT INTO workflow_commands (
       workflow_command_id, command_type, subject_type, subject_id,
       source_revision, policy_version, expected_data_epoch, status, created_at
     ) VALUES ($1, $2, 'predicate_registry', $1, $3, $4, 1, 'created', $5)
     ON CONFLICT DO NOTHING`,
    [
      commandId,
      REGISTRY_RELEASE_COMMAND_TYPE,
      input.registryVersion,
      "predicate-registry-release:v1",
      input.now,
    ],
  );
  await client.query(
    `INSERT INTO outbox_events (
       outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
       aggregate_revision, aggregate_data_epoch, aggregate_coverage,
       event_type, status, next_attempt_at, attempt_count, payload, created_at
     ) VALUES ($1, $2, 'predicate_registry', $3, $4, 1, 0, $5, 'pending', $6,
       0, $7::jsonb, $6)
     ON CONFLICT DO NOTHING`,
    [
      createUuidV7(input.now),
      commandId,
      commandId,
      input.registryVersion,
      REGISTRY_RELEASE_EVENT_TYPE,
      input.now,
      JSON.stringify({ registryVersion: input.registryVersion }),
    ],
  );
}
