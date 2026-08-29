import type {
  EntityIdentityRevalidationCommand,
  EntityIdentityRevalidationOutcome,
  EntityIdentityRevalidationRepository,
  PredicateRegistryEntry,
} from "@sayhear/application";
import {
  asMemoryClaimId,
  asUserId,
} from "@sayhear/domain";
import { claimCanonicalKey } from "@sayhear/application";
import type { Pool, PoolClient } from "pg";

import { insertExecutionReceipt } from "./postgres-conversation-action-repository";
import type { MemoryTrustActionProjectionProvider } from "./postgres-memory-trust-action-repository";
import {
  markClaimRetrievalProjectionsStaleWithin,
  rebuildClaimRetrievalProjectionsWithin,
  rebuildRelationshipResolverHintsWithin,
} from "./postgres-memory-claim-repository";
import { createUuidV7 } from "./uuid-v7";

type RevalidationCommandRow = Readonly<{
  action_execution_id: string;
  expected_data_epoch: string;
  operation: "merge" | "split" | "promote";
  policy_version: string;
  source_entity_id: string;
  source_entity_version_id: string;
  user_id: string;
  workflow_command_id: string;
}>;

type OwnerCommandRow = Readonly<{
  action_execution_id: string;
  command_status: string;
  expected_data_epoch: string;
  operation: "merge" | "split" | "promote";
  source_entity_id: string;
  source_entity_version_id: string;
  user_id: string;
  workflow_command_id: string;
}>;

type IdentityCorrectionRow = Readonly<{
  user_id: string;
  operation: "merge" | "split" | "promote";
  source_entity_id: string;
  source_entity_version_id: string;
  related_entity_id: string | null;
  related_entity_version_id: string | null;
}>;

type CurrentEntityVersionRow = Readonly<{
  entity_id: string;
  entity_version_id: string;
  entity_kind_id: string;
  status: "active" | "merged" | "split" | "unresolved" | "deleted";
}>;

type RevalidationClaimRow = Readonly<{
  claim_id: string;
  current_version_id: string;
  canonical_key: string;
  revision: number;
  scope_key: string;
  kind: "objective" | "impression";
  epistemic_status: "confirmed" | "inferred" | "contested";
  subject_entity_id: string;
  object_entity_id: string | null;
  subject_entity_version_id: string;
  object_entity_version_id: string | null;
  typed_value: unknown;
  confidence: number | string | null;
  temporal_status: "current" | "ended" | "unknown";
  valid_from: Date | null;
  valid_from_precision: string;
  valid_to: Date | null;
  valid_to_precision: string;
  last_observed_at: Date;
  model_version: string | null;
  prompt_version: string | null;
  predicate_registry_version: number;
  predicate_id: string;
}>;

type ClaimQualifierRow = Readonly<{
  axis_id: string;
  role_side: "canonical_subject" | "counterpart";
  typed_value: unknown;
  evidence_item_ids: string[];
}>;

type ValidClaimEvidence = Readonly<{
  claimEvidence: readonly Readonly<{
    evidenceItemId: string;
    linkRole: "support" | "counter" | "subjective_report" | "context";
  }>[];
  qualifiers: readonly ClaimQualifierRow[];
}>;

/**
 * Durable adapter for the #121 reverse-lineage Workflow. It only reads the
 * identity correction's typed rows and its targeted fences; it never scans
 * Journal prose or reuses a stale prior-turn context.
 */
export class PostgresEntityIdentityRevalidationRepository
  implements EntityIdentityRevalidationRepository
{
  public constructor(
    private readonly pool: Pool,
    private readonly projectionProvider?: MemoryTrustActionProjectionProvider,
  ) {}

  public async readRevalidationCommand(input: {
    workflowCommandId: string;
  }): Promise<EntityIdentityRevalidationCommand | null> {
    const result = await this.pool.query<RevalidationCommandRow>(
      `SELECT workflow.workflow_command_id,
              workflow.action_execution_id,
              workflow.expected_data_epoch::text,
              workflow.policy_version,
              correction.operation,
              correction.source_entity_id::text,
              correction.source_entity_version_id::text,
              correction.user_id::text
       FROM workflow_commands workflow
       INNER JOIN entity_identity_corrections correction
         ON correction.action_execution_id = workflow.action_execution_id
        AND correction.user_id = (
          SELECT execution.user_id
          FROM conversation_action_executions execution
          WHERE execution.action_execution_id = workflow.action_execution_id
        )
       WHERE workflow.workflow_command_id = $1
         AND workflow.command_type = 'entity_identity_revalidation'
         AND workflow.subject_type = 'entity'`,
      [input.workflowCommandId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      actionExecutionId: row.action_execution_id,
      expectedDataEpoch: Number(row.expected_data_epoch),
      operation: row.operation,
      policyVersion: row.policy_version,
      sourceEntityId: row.source_entity_id,
      sourceEntityVersionId: row.source_entity_version_id,
      userId: row.user_id,
      workflowCommandId: row.workflow_command_id,
    };
  }

  public async claimRevalidationRun(input: {
    actionExecutionId: string;
    sourceEntityId: string;
    sourceEntityVersionId: string;
    userId: string;
    workflowCommandId: string;
  }): Promise<"execute" | "replayed"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const command = await client.query<OwnerCommandRow>(
        `SELECT workflow.workflow_command_id,
                workflow.action_execution_id,
                workflow.expected_data_epoch::text,
                workflow.status AS command_status,
                correction.operation,
                correction.source_entity_id::text,
                correction.source_entity_version_id::text,
                correction.user_id::text
         FROM workflow_commands workflow
         INNER JOIN entity_identity_corrections correction
           ON correction.action_execution_id = workflow.action_execution_id
          AND correction.user_id = $2
         INNER JOIN app_users owner ON owner.user_id = correction.user_id
         WHERE workflow.workflow_command_id = $1
           AND workflow.command_type = 'entity_identity_revalidation'
           AND workflow.subject_type = 'entity'
           AND owner.status = 'active'
           AND owner.data_epoch = workflow.expected_data_epoch
         FOR UPDATE OF workflow, owner`,
        [input.workflowCommandId, input.userId],
      );
      const commandRow = command.rows[0];
      if (!commandRow) {
        await client.query("COMMIT");
        return "replayed";
      }
      const existing = await client.query<{
        action_execution_id: string;
        source_entity_id: string;
        source_entity_version_id: string;
        status: "running" | "completed";
        user_id: string;
      }>(
        `SELECT status, user_id::text, action_execution_id::text,
                source_entity_id::text, source_entity_version_id::text
         FROM entity_identity_revalidation_runs
         WHERE workflow_command_id = $1
         FOR UPDATE`,
        [input.workflowCommandId],
      );
      const existingRun = existing.rows[0];
      if (existingRun?.status === "completed") {
        await client.query("COMMIT");
        return "replayed";
      }
      // A worker can die after the claim transaction commits but before the
      // workflow records its outcome. Re-entering a running row is safe: the
      // outcome transaction locks the run and is itself idempotent, while the
      // receipt keys prevent duplicate visible receipts.
      if (existingRun) {
        if (
          existingRun.user_id !== input.userId ||
          existingRun.action_execution_id !== input.actionExecutionId ||
          existingRun.source_entity_id !== input.sourceEntityId ||
          existingRun.source_entity_version_id !== input.sourceEntityVersionId
        ) {
          throw new Error("Entity identity revalidation run target drifted.");
        }
        await client.query("COMMIT");
        return "execute";
      }
      if (
        commandRow.action_execution_id !== input.actionExecutionId ||
        commandRow.source_entity_id !== input.sourceEntityId ||
        commandRow.source_entity_version_id !== input.sourceEntityVersionId
      ) {
        throw new Error("Entity identity revalidation command target drifted.");
      }
      await client.query(
        `INSERT INTO entity_identity_revalidation_runs (
           entity_identity_revalidation_run_id, user_id, workflow_command_id,
           action_execution_id, source_entity_id, source_entity_version_id,
           status, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'running', CURRENT_TIMESTAMP)`,
        [
          createUuidV7(new Date()),
          input.userId,
          input.workflowCommandId,
          input.actionExecutionId,
          input.sourceEntityId,
          input.sourceEntityVersionId,
        ],
      );
      await client.query("COMMIT");
      return "execute";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async listAffectedLineage(input: {
    actionExecutionId: string;
    sourceEntityId: string;
    sourceEntityVersionId: string;
    userId: string;
  }): Promise<{
    affectedClaimIds: readonly string[];
    affectedJournalStatementIds: readonly string[];
  }> {
    return this.listAffectedLineageWithin(this.pool, input);
  }

  private async listAffectedLineageWithin(
    client: Pick<Pool, "query">,
    input: {
      actionExecutionId: string;
      sourceEntityId: string;
      sourceEntityVersionId: string;
      userId: string;
    },
  ): Promise<{
    affectedClaimIds: readonly string[];
    affectedJournalStatementIds: readonly string[];
  }> {
    const claims = await client.query<{ memory_claim_id: string }>(
      `SELECT DISTINCT claim.memory_claim_id::text
       FROM memory_claims claim
       INNER JOIN memory_claim_versions version
         ON version.memory_claim_version_id = claim.current_version_id
        AND version.user_id = claim.user_id
       INNER JOIN entity_identity_corrections correction
         ON correction.action_execution_id = $2
        AND correction.user_id = claim.user_id
        AND correction.source_entity_id = $3
        AND correction.source_entity_version_id = $4
       WHERE claim.user_id = $1
         AND claim.deleted_at IS NULL
         AND claim.content_purged_at IS NULL
         AND version.status = 'review_due'
         AND version.created_by = 'entity_identity_correction'
         AND (
           version.subject_entity_version_id IN (
             correction.source_entity_version_id,
             correction.related_entity_version_id
           )
           OR version.object_entity_version_id IN (
             correction.source_entity_version_id,
             correction.related_entity_version_id
           )
         )
       ORDER BY 1`,
      [
        input.userId,
        input.actionExecutionId,
        input.sourceEntityId,
        input.sourceEntityVersionId,
      ],
    );
    const statements = await client.query<{
      journal_statement_id: string;
    }>(
      `SELECT DISTINCT journal_statement_id::text
       FROM journal_identity_review_fences
       WHERE user_id = $1
         AND action_execution_id = $2
         AND status = 'identity_review_pending'
       ORDER BY 1`,
      [input.userId, input.actionExecutionId],
    );
    return {
      affectedClaimIds: claims.rows.map((row) => row.memory_claim_id),
      affectedJournalStatementIds: statements.rows.map(
        (row) => row.journal_statement_id,
      ),
    };
  }

  private async loadCurrentEntityVersions(
    client: Pick<Pool, "query">,
    input: { userId: string; entityIds: readonly string[] },
  ): Promise<ReadonlyMap<string, CurrentEntityVersionRow>> {
    if (input.entityIds.length === 0) return new Map();
    const result = await client.query<CurrentEntityVersionRow>(
      `SELECT entity.entity_id::text,
              version.entity_version_id::text,
              version.entity_kind_id,
              version.status
       FROM entities entity
       INNER JOIN entity_versions version
         ON version.entity_id = entity.entity_id
        AND version.user_id = entity.user_id
        AND version.entity_version_id = entity.current_version_id
       WHERE entity.user_id = $1
         AND entity.entity_id = ANY($2::uuid[])
         AND entity.deleted_at IS NULL`,
      [input.userId, [...new Set(input.entityIds)]],
    );
    return new Map(result.rows.map((row) => [row.entity_id, row]));
  }

  private async restoreClaimIfSafe(
    client: PoolClient,
    input: {
      claimId: string;
      correction: IdentityCorrectionRow;
      currentEntities: ReadonlyMap<string, CurrentEntityVersionRow>;
      now: Date;
      userId: string;
    },
  ): Promise<boolean> {
    if (input.correction.operation === "split") return false;

    const claimResult = await client.query<RevalidationClaimRow>(
      `SELECT claim.memory_claim_id::text AS claim_id,
              claim.current_version_id::text AS current_version_id,
              claim.canonical_key,
              claim.scope_key,
              version.revision, version.kind, version.epistemic_status,
              claim.subject_entity_id::text,
              claim.object_entity_id::text,
              version.subject_entity_version_id::text,
              version.object_entity_version_id::text,
              version.typed_value, version.confidence,
              version.temporal_status, version.valid_from,
              version.valid_from_precision, version.valid_to,
              version.valid_to_precision, version.last_observed_at,
              version.model_version, version.prompt_version,
              version.predicate_registry_version, claim.predicate_id
       FROM memory_claims claim
       INNER JOIN memory_claim_versions version
         ON version.memory_claim_version_id = claim.current_version_id
        AND version.user_id = claim.user_id
       WHERE claim.user_id = $1
         AND claim.memory_claim_id = $2
         AND claim.deleted_at IS NULL
         AND claim.content_purged_at IS NULL
         AND version.status = 'review_due'
         AND version.created_by = 'entity_identity_correction'
       FOR UPDATE OF claim`,
      [input.userId, input.claimId],
    );
    const claim = claimResult.rows[0];
    if (!claim) return false;

    const replacement = replacementEntityVersions(
      claim,
      input.correction,
      input.currentEntities,
    );
    if (!replacement) return false;

    const entityIds = [
      claim.subject_entity_id,
      ...(claim.object_entity_id === null ? [] : [claim.object_entity_id]),
    ];
    const currentEntities = new Map(input.currentEntities);
    for (const row of (
      await this.loadCurrentEntityVersions(client, {
        entityIds,
        userId: input.userId,
      })
    ).values()) {
      currentEntities.set(row.entity_id, row);
    }
    const self = await client.query<{ entity_id: string }>(
      `SELECT entity_id::text FROM user_self_entities WHERE user_id = $1`,
      [input.userId],
    );
    const selfEntityId = self.rows[0]?.entity_id ?? null;
    const validEvidence = await this.loadClaimEvidence(client, {
      claimVersionId: claim.current_version_id,
      userId: input.userId,
    });
    if (
      !validEvidence ||
      !claimCanBeRestored({
        claim,
        currentEntities,
        replacement,
        selfEntityId,
        provider: this.projectionProvider,
        qualifiers: validEvidence.qualifiers,
      })
    ) {
      return false;
    }

    const projection = this.projectionProvider?.retrievalProjectionFor(
      claim.predicate_id,
    );
    if (!projection) return false;
    const reboundCanonicalKey = claimCanonicalKey({
      predicateId: claim.predicate_id,
      subjectEntityId: replacement.subjectEntityId,
      objectEntityId: replacement.objectEntityId,
      scopeKey: claim.scope_key,
      relationshipDirection:
        projection.entry.relationshipSemantics?.direction ?? null,
    });

    if (reboundCanonicalKey !== claim.canonical_key) {
      const existing = await this.findCanonicalClaim(
        client,
        input.userId,
        reboundCanonicalKey,
        claim.claim_id,
      );
      if (existing) {
        // A canonical collision needs value-level reconciliation, not a
        // mechanical evidence union. Leave this Claim fenced until the normal
        // Claim admission/reconciliation path can make that decision.
        return false;
      }
      const reboundClaimId = createUuidV7(input.now);
      await client.query(
        `INSERT INTO memory_claims (
           memory_claim_id, user_id, canonical_key, subject_entity_id,
           object_entity_id, predicate_id, scope_key, current_version_id,
           created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)`,
        [
          reboundClaimId,
          input.userId,
          reboundCanonicalKey,
          replacement.subjectEntityId,
          replacement.objectEntityId,
          claim.predicate_id,
          claim.scope_key,
          input.now,
        ],
      );
      const reboundVersionId = await this.appendClaimVersion(client, {
        claim,
        claimId: reboundClaimId,
        createdBy: "entity_identity_revalidation",
        evidence: validEvidence,
        now: input.now,
        objectEntityVersionId: replacement.objectEntityVersionId,
        revision: 1,
        status: "active",
        subjectEntityVersionId: replacement.subjectEntityVersionId,
        supersedesVersionId: null,
        userId: input.userId,
      });
      const reboundMoved = await client.query(
        `UPDATE memory_claims SET current_version_id = $3
         WHERE user_id = $1 AND memory_claim_id = $2
           AND current_version_id IS NULL`,
        [input.userId, reboundClaimId, reboundVersionId],
      );
      if (reboundMoved.rowCount !== 1) {
        throw new Error(`Claim ${reboundClaimId} revalidation CAS failed.`);
      }
      const supersededVersionId = await this.appendClaimVersion(client, {
        claim,
        claimId: claim.claim_id,
        createdBy: "entity_identity_revalidation",
        evidence: validEvidence,
        now: input.now,
        objectEntityVersionId: claim.object_entity_version_id,
        revision: claim.revision + 1,
        status: "superseded",
        subjectEntityVersionId: claim.subject_entity_version_id,
        supersedesVersionId: claim.current_version_id,
        userId: input.userId,
      });
      const supersededMoved = await client.query(
        `UPDATE memory_claims SET current_version_id = $3
         WHERE user_id = $1 AND memory_claim_id = $2
           AND current_version_id IS NOT DISTINCT FROM $4`,
        [input.userId, claim.claim_id, supersededVersionId, claim.current_version_id],
      );
      if (supersededMoved.rowCount !== 1) {
        throw new Error(`Claim ${claim.claim_id} supersede CAS failed.`);
      }
      await this.refreshClaimProjections(client, {
        claimId: reboundClaimId,
        material: projection,
        now: input.now,
        userId: input.userId,
      });
      await this.fenceClaimProjections(client, input.userId, claim.claim_id);
      return true;
    }

    const versionId = await this.appendClaimVersion(client, {
      claim,
      claimId: claim.claim_id,
      createdBy: "entity_identity_revalidation",
      evidence: validEvidence,
      now: input.now,
      objectEntityVersionId: replacement.objectEntityVersionId,
      revision: claim.revision + 1,
      status: "active",
      subjectEntityVersionId: replacement.subjectEntityVersionId,
      supersedesVersionId: claim.current_version_id,
      userId: input.userId,
    });
    const moved = await client.query(
      `UPDATE memory_claims SET current_version_id = $3
       WHERE user_id = $1 AND memory_claim_id = $2
         AND current_version_id IS NOT DISTINCT FROM $4`,
      [input.userId, claim.claim_id, versionId, claim.current_version_id],
    );
    if (moved.rowCount !== 1) {
      throw new Error(`Claim ${claim.claim_id} revalidation CAS failed.`);
    }
    await this.refreshClaimProjections(client, {
      claimId: claim.claim_id,
      material: projection,
      now: input.now,
      userId: input.userId,
    });
    return true;
  }

  private async findCanonicalClaim(
    client: PoolClient,
    userId: string,
    canonicalKey: string,
    excludedClaimId: string,
  ): Promise<{ memoryClaimId: string } | null> {
    const result = await client.query<{ memory_claim_id: string }>(
      `SELECT memory_claim_id::text
       FROM memory_claims
       WHERE user_id = $1
         AND canonical_key = $2
         AND memory_claim_id <> $3
       FOR UPDATE`,
      [userId, canonicalKey, excludedClaimId],
    );
    return result.rows[0]
      ? { memoryClaimId: result.rows[0].memory_claim_id }
      : null;
  }

  private async appendClaimVersion(
    client: PoolClient,
    input: {
      claim: RevalidationClaimRow;
      claimId: string;
      createdBy: string;
      evidence: ValidClaimEvidence;
      now: Date;
      objectEntityVersionId: string | null;
      revision: number;
      status: "active" | "superseded";
      subjectEntityVersionId: string;
      supersedesVersionId: string | null;
      userId: string;
    },
  ): Promise<string> {
    const versionId = createUuidV7(input.now);
    await client.query(
      `INSERT INTO memory_claim_versions (
         memory_claim_version_id, memory_claim_id, user_id,
         revision, kind, epistemic_status, status, subject_entity_version_id,
         object_entity_version_id, typed_value, confidence, temporal_status,
         valid_from, valid_from_precision, valid_to, valid_to_precision,
         last_observed_at, supersedes_version_id, created_by, model_version,
         prompt_version, predicate_registry_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        versionId,
        input.claimId,
        input.userId,
        input.revision,
        input.claim.kind,
        input.claim.epistemic_status,
        input.status,
        input.subjectEntityVersionId,
        input.objectEntityVersionId,
        JSON.stringify(input.claim.typed_value),
        input.claim.confidence,
        input.claim.temporal_status,
        input.claim.valid_from,
        input.claim.valid_from_precision,
        input.claim.valid_to,
        input.claim.valid_to_precision,
        input.claim.last_observed_at,
        input.supersedesVersionId,
        input.createdBy,
        input.claim.model_version,
        input.claim.prompt_version,
        input.claim.predicate_registry_version,
        input.now,
      ],
    );
    await this.copyClaimAttachments(client, {
      evidence: input.evidence,
      userId: input.userId,
      versionId,
      now: input.now,
    });
    return versionId;
  }

  private async copyClaimAttachments(
    client: PoolClient,
    input: {
      evidence: ValidClaimEvidence;
      userId: string;
      versionId: string;
      now: Date;
    },
  ): Promise<void> {
    for (const evidence of input.evidence.claimEvidence) {
      await client.query(
        `INSERT INTO claim_evidence_links (
           claim_evidence_link_id, memory_claim_version_id, user_id,
           evidence_item_id, link_role, status, created_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
        [
          createUuidV7(input.now),
          input.versionId,
          input.userId,
          evidence.evidenceItemId,
          evidence.linkRole,
          input.now,
        ],
      );
    }
    for (const qualifier of input.evidence.qualifiers) {
      const qualifierId = createUuidV7(input.now);
      await client.query(
        `INSERT INTO memory_claim_version_qualifiers (
           memory_claim_version_qualifier_id, memory_claim_version_id, user_id,
           axis_id, role_side, typed_value, created_by, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'entity_identity_revalidation', $7)`,
        [
          qualifierId,
          input.versionId,
          input.userId,
          qualifier.axis_id,
          qualifier.role_side,
          JSON.stringify(qualifier.typed_value),
          input.now,
        ],
      );
      for (const evidenceItemId of qualifier.evidence_item_ids) {
        await client.query(
          `INSERT INTO memory_claim_version_qualifier_evidence (
             memory_claim_version_qualifier_evidence_id,
             memory_claim_version_qualifier_id, user_id, evidence_item_id,
             created_at
           ) VALUES ($1, $2, $3, $4, $5)`,
          [
            createUuidV7(input.now),
            qualifierId,
            input.userId,
            evidenceItemId,
            input.now,
          ],
        );
      }
    }
  }

  private async fenceClaimProjections(
    client: PoolClient,
    userId: string,
    claimId: string,
  ): Promise<void> {
    await markClaimRetrievalProjectionsStaleWithin(
      client,
      asUserId(userId),
      asMemoryClaimId(claimId),
    );
    await client.query(
      `DELETE FROM relationship_resolver_hints
       WHERE user_id = $1 AND memory_claim_id = $2`,
      [userId, claimId],
    );
  }

  private async refreshClaimProjections(
    client: PoolClient,
    input: {
      claimId: string;
      material: NonNullable<
        ReturnType<NonNullable<MemoryTrustActionProjectionProvider>["retrievalProjectionFor"]>
      >;
      now: Date;
      userId: string;
    },
  ): Promise<void> {
    await this.fenceClaimProjections(client, input.userId, input.claimId);
    await rebuildClaimRetrievalProjectionsWithin(client, {
      userId: asUserId(input.userId),
      claimId: asMemoryClaimId(input.claimId),
      material: input.material,
      now: input.now,
    });
    const hints = this.projectionProvider?.relationshipHintsFor(
      input.material.entry.predicateId,
    );
    if (hints !== null && hints !== undefined) {
      await rebuildRelationshipResolverHintsWithin(client, {
        userId: asUserId(input.userId),
        claimId: asMemoryClaimId(input.claimId),
        hints,
        now: input.now,
      });
    }
  }

  private async loadClaimEvidence(
    client: Pick<Pool, "query">,
    input: { claimVersionId: string; userId: string },
  ): Promise<{
    claimEvidence: readonly Readonly<{
      evidenceItemId: string;
      linkRole: "support" | "counter" | "subjective_report" | "context";
    }>[];
    qualifiers: readonly ClaimQualifierRow[];
  } | null> {
    const claimEvidence = await client.query<{
      evidence_item_id: string;
      link_role: "support" | "counter" | "subjective_report" | "context";
    }>(
      `SELECT evidence_item_id::text, link_role
       FROM claim_evidence_links
       WHERE user_id = $1 AND memory_claim_version_id = $2
       ORDER BY evidence_item_id, link_role`,
      [input.userId, input.claimVersionId],
    );
    if (
      claimEvidence.rows.length === 0 ||
      !claimEvidence.rows.some((row) =>
        row.link_role === "support" || row.link_role === "subjective_report",
      )
    ) {
      return null;
    }
    const qualifiers = await client.query<ClaimQualifierRow>(
      `SELECT qualifier.axis_id, qualifier.role_side, qualifier.typed_value,
              ARRAY(
                SELECT evidence_item_id::text
                FROM memory_claim_version_qualifier_evidence evidence
                WHERE evidence.memory_claim_version_qualifier_id =
                  qualifier.memory_claim_version_qualifier_id
                ORDER BY evidence_item_id
              ) AS evidence_item_ids
       FROM memory_claim_version_qualifiers qualifier
       WHERE qualifier.user_id = $1
         AND qualifier.memory_claim_version_id = $2
         AND qualifier.content_purged_at IS NULL
       ORDER BY qualifier.axis_id, qualifier.role_side`,
      [input.userId, input.claimVersionId],
    );
    const evidenceIds = [
      ...claimEvidence.rows.map((row) => row.evidence_item_id),
      ...qualifiers.rows.flatMap((row) => row.evidence_item_ids),
    ];
    const uniqueEvidenceIds = [...new Set(evidenceIds)];
    if (!await areEvidenceItemsValid(client, input.userId, uniqueEvidenceIds)) {
      return null;
    }
    if (qualifiers.rows.some((row) => row.evidence_item_ids.length === 0)) {
      return null;
    }
    return {
      claimEvidence: claimEvidence.rows.map((row) => ({
        evidenceItemId: row.evidence_item_id,
        linkRole: row.link_role,
      })),
      qualifiers: qualifiers.rows,
    };
  }

  public async recordRevalidationOutcome(input: {
    affectedClaimIds: readonly string[];
    affectedJournalStatementIds: readonly string[];
    outcome: EntityIdentityRevalidationOutcome;
    workflowCommandId: string;
  }): Promise<EntityIdentityRevalidationOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const command = await client.query<{
        user_id: string;
        data_epoch: string;
        expected_data_epoch: string;
        owner_status: string;
        action_execution_id: string;
        operation: "merge" | "split" | "promote";
        source_entity_id: string;
        source_entity_version_id: string;
        related_entity_id: string | null;
        related_entity_version_id: string | null;
      }>(
        `SELECT correction.user_id::text,
                owner.data_epoch::text,
                workflow.expected_data_epoch::text,
                owner.status AS owner_status,
                workflow.action_execution_id::text,
                correction.operation,
                correction.source_entity_id::text,
                correction.source_entity_version_id::text,
                correction.related_entity_id::text,
                correction.related_entity_version_id::text
         FROM workflow_commands workflow
         INNER JOIN entity_identity_corrections correction
           ON correction.action_execution_id = workflow.action_execution_id
          AND correction.user_id = (
            SELECT execution.user_id
            FROM conversation_action_executions execution
            WHERE execution.action_execution_id = workflow.action_execution_id
          )
         INNER JOIN app_users owner ON owner.user_id = correction.user_id
         WHERE workflow.workflow_command_id = $1
           AND workflow.command_type = 'entity_identity_revalidation'
           AND workflow.subject_type = 'entity'
         FOR UPDATE OF workflow, correction, owner`,
        [input.workflowCommandId],
      );
      const commandRow = command.rows[0];
      if (!commandRow) {
        throw new Error(
          "Entity identity revalidation Workflow command does not exist.",
        );
      }
      if (
        commandRow.owner_status !== "active" ||
        Number(commandRow.data_epoch) !==
          Number(commandRow.expected_data_epoch)
      ) {
        throw new Error(
          "Entity identity revalidation was fenced by the owner epoch.",
        );
      }

      const run = await client.query<{
        user_id: string;
        action_execution_id: string;
        source_entity_id: string;
        source_entity_version_id: string;
        status: "running" | "completed";
      }>(
        `SELECT user_id::text, action_execution_id::text,
                source_entity_id::text, source_entity_version_id::text, status
         FROM entity_identity_revalidation_runs
         WHERE workflow_command_id = $1
         FOR UPDATE`,
        [input.workflowCommandId],
      );
      const runRow = run.rows[0];
      if (!runRow) {
        throw new Error("Entity identity revalidation run does not exist.");
      }
      if (runRow.status === "completed") {
        await client.query("COMMIT");
        return input.outcome;
      }
      if (
        runRow.user_id !== commandRow.user_id ||
        runRow.action_execution_id !== commandRow.action_execution_id ||
        runRow.source_entity_id !== commandRow.source_entity_id ||
        runRow.source_entity_version_id !== commandRow.source_entity_version_id
      ) {
        throw new Error("Entity identity revalidation run target drifted.");
      }

      const lineage = await this.listAffectedLineageWithin(client, {
        actionExecutionId: commandRow.action_execution_id,
        sourceEntityId: commandRow.source_entity_id,
        sourceEntityVersionId: commandRow.source_entity_version_id,
        userId: commandRow.user_id,
      });
      assertSameIds(
        input.affectedClaimIds,
        lineage.affectedClaimIds,
        "Claim",
      );
      assertSameIds(
        input.affectedJournalStatementIds,
        lineage.affectedJournalStatementIds,
        "Journal statement",
      );

      const correction: IdentityCorrectionRow = {
        user_id: commandRow.user_id,
        operation: commandRow.operation,
        source_entity_id: commandRow.source_entity_id,
        source_entity_version_id: commandRow.source_entity_version_id,
        related_entity_id: commandRow.related_entity_id,
        related_entity_version_id: commandRow.related_entity_version_id,
      };
      const currentEntities = await this.loadCurrentEntityVersions(client, {
        userId: commandRow.user_id,
        entityIds: [
          commandRow.source_entity_id,
          ...(commandRow.related_entity_id === null
            ? []
            : [commandRow.related_entity_id]),
        ],
      });
      let recordedOutcome = input.outcome;
      if (input.outcome === "no_change") {
        let allClaimsRestored = true;
        for (const claimId of lineage.affectedClaimIds) {
          const restored = await this.restoreClaimIfSafe(client, {
            claimId,
            correction,
            currentEntities,
            now: new Date(),
            userId: commandRow.user_id,
          });
          allClaimsRestored = restored && allClaimsRestored;
        }
        if (!allClaimsRestored) {
          // A collision, invalid original Evidence, or any other failed
          // validator leaves at least one Claim fenced. Do not publish a
          // misleading no_change Journal result; keep the targeted fence until
          // a later evidence-triggered revalidation can decide it.
          recordedOutcome = "still_ambiguous";
        }
      }
      await client.query(
        `UPDATE journal_identity_review_fences
         SET status = $2
         WHERE user_id = $1
           AND action_execution_id = $3
           AND status = 'identity_review_pending'`,
        [commandRow.user_id, recordedOutcome, commandRow.action_execution_id],
      );
      await client.query(
        `UPDATE entity_identity_revalidation_runs
         SET affected_claim_count = $2,
             affected_journal_statement_count = $3,
             status = 'completed',
             completed_at = CURRENT_TIMESTAMP
         WHERE workflow_command_id = $1
           AND status = 'running'`,
        [
          input.workflowCommandId,
          lineage.affectedClaimIds.length,
          lineage.affectedJournalStatementIds.length,
        ],
      );
      await client.query(
        `UPDATE workflow_commands
         SET status = 'completed', dispatched_at = COALESCE(dispatched_at, CURRENT_TIMESTAMP)
         WHERE workflow_command_id = $1
           AND status <> 'dead_lettered'`,
        [input.workflowCommandId],
      );
      await client.query("COMMIT");
      return recordedOutcome;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async appendRevalidationReceipt(input: {
    actionExecutionId: string;
    disposition: string;
    execution: "running" | "succeeded";
    receiptKey: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const correction = await client.query<{
        operation: "merge" | "split" | "promote";
        source_entity_id: string;
        source_entity_version_id: string;
        related_entity_id: string | null;
        related_entity_version_id: string | null;
      }>(
        `SELECT operation, source_entity_id::text, source_entity_version_id::text,
                related_entity_id::text, related_entity_version_id::text
         FROM entity_identity_corrections
         WHERE action_execution_id = $1
         FOR UPDATE`,
        [input.actionExecutionId],
      );
      const row = correction.rows[0];
      if (!row) {
        throw new Error(
          `Entity identity correction for ${input.actionExecutionId} does not exist.`,
        );
      }
      const execution = await client.query(
        `SELECT action_execution_id
         FROM conversation_action_executions
         WHERE action_execution_id = $1
         FOR UPDATE`,
        [input.actionExecutionId],
      );
      if (execution.rowCount !== 1) {
        throw new Error(
          `Action execution ${input.actionExecutionId} does not exist.`,
        );
      }
      await insertExecutionReceipt(client, {
        actionExecutionId: input.actionExecutionId,
        disposition: input.disposition,
        entityIdentityOperation: row.operation,
        execution: input.execution,
        receiptKey: input.receiptKey,
        resolvedEntityId: row.source_entity_id,
        resolvedEntityVersionId: row.source_entity_version_id,
        ...(row.related_entity_id === null
          ? {}
          : { resolvedRelatedEntityId: row.related_entity_id }),
        ...(row.related_entity_version_id === null
          ? {}
          : { resolvedRelatedEntityVersionId: row.related_entity_version_id }),
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

type ReplacementEntityVersions = Readonly<{
  subjectEntityId: string;
  subjectEntityVersionId: string;
  objectEntityId: string | null;
  objectEntityVersionId: string | null;
}>;

function replacementEntityVersions(
  claim: RevalidationClaimRow,
  correction: IdentityCorrectionRow,
  currentEntities: ReadonlyMap<string, CurrentEntityVersionRow>,
): ReplacementEntityVersions | null {
  const source = currentEntities.get(correction.source_entity_id);
  if (!source) return null;
  const related = correction.related_entity_id
    ? currentEntities.get(correction.related_entity_id)
    : null;
  if (correction.operation === "merge") {
    if (
      source.status !== "merged" ||
      !related ||
      related.status !== "active" ||
      correction.related_entity_version_id === null
    ) {
      return null;
    }
  } else if (source.status !== "active") {
    return null;
  }

  const replace = (
    entityId: string,
    entityVersionId: string,
  ): Readonly<{ entityId: string; entityVersionId: string }> | null => {
    if (
      correction.operation === "promote" &&
      entityVersionId === correction.source_entity_version_id
    ) {
      return {
        entityId: source.entity_id,
        entityVersionId: source.entity_version_id,
      };
    }
    if (
      correction.operation === "merge" &&
      entityVersionId === correction.source_entity_version_id
    ) {
      return {
        entityId: related!.entity_id,
        entityVersionId: related!.entity_version_id,
      };
    }
    if (
      correction.operation === "merge" &&
      entityVersionId === correction.related_entity_version_id
    ) {
      return {
        entityId: related!.entity_id,
        entityVersionId: related!.entity_version_id,
      };
    }
    return { entityId, entityVersionId };
  };

  const subject = replace(
    claim.subject_entity_id,
    claim.subject_entity_version_id,
  );
  if (subject === null) return null;
  const object = claim.object_entity_version_id
    ? replace(claim.object_entity_id!, claim.object_entity_version_id)
    : null;
  if (claim.object_entity_version_id !== null && object === null) {
    return null;
  }
  return {
    subjectEntityId: subject.entityId,
    subjectEntityVersionId: subject.entityVersionId,
    objectEntityId: object?.entityId ?? null,
    objectEntityVersionId: object?.entityVersionId ?? null,
  };
}

function claimCanBeRestored(input: {
  claim: RevalidationClaimRow;
  currentEntities: ReadonlyMap<string, CurrentEntityVersionRow>;
  replacement: ReplacementEntityVersions;
  selfEntityId: string | null;
  provider: MemoryTrustActionProjectionProvider | undefined;
  qualifiers: readonly ClaimQualifierRow[];
}): boolean {
  const material = input.provider?.retrievalProjectionFor(input.claim.predicate_id);
  if (!material) return false;
  const entry = material.entry;
  if (
    entry.status !== "active" ||
    entry.registryVersion !== input.claim.predicate_registry_version ||
    !entry.allowedClaimKinds.includes(input.claim.kind) ||
    input.claim.confidence !== null &&
      (!Number.isFinite(Number(input.claim.confidence)) ||
        Number(input.claim.confidence) < 0 ||
        Number(input.claim.confidence) > 1) ||
    (input.claim.kind === "objective" &&
      input.claim.epistemic_status !== "confirmed") ||
    (input.claim.kind === "impression" &&
      input.claim.epistemic_status !== "inferred") ||
    input.claim.temporal_status === "ended" &&
      !entry.temporalSemantics.temporalStatuses.includes("current_ended") ||
    !validScope(entry, input.claim.scope_key) ||
    !validTypedValue(entry, input.claim.typed_value)
  ) {
    return false;
  }

  const subject = input.currentEntities.get(input.replacement.subjectEntityId);
  if (
    !subject ||
    subject.status !== "active" ||
    subject.entity_version_id !== input.replacement.subjectEntityVersionId ||
    !entry.allowedSubjectKindIds.includes(subject.entity_kind_id)
  ) {
    return false;
  }
  if (entry.relationshipSemantics === null) {
    return (
      input.selfEntityId === input.replacement.subjectEntityId &&
      input.claim.object_entity_id === null &&
      input.replacement.objectEntityVersionId === null &&
      input.qualifiers.length === 0
    );
  }

  const object = input.replacement.objectEntityId
    ? input.currentEntities.get(input.replacement.objectEntityId)
    : null;
  if (
    !object ||
    object.status !== "active" ||
    object.entity_version_id !== input.replacement.objectEntityVersionId ||
    !entry.allowedSubjectKindIds.includes(object.entity_kind_id) ||
    input.replacement.objectEntityId === input.replacement.subjectEntityId
  ) {
    return false;
  }
  return validQualifiers(entry, input.qualifiers);
}

function validScope(entry: PredicateRegistryEntry, scopeKey: string): boolean {
  if (entry.scopeSchema.kind === "none") return scopeKey === "";
  if (entry.scopeSchema.kind === "short_text") return scopeKey.trim() !== "";
  return entry.scopeSchema.values.some((value) => value.value === scopeKey);
}

function validTypedValue(entry: PredicateRegistryEntry, raw: unknown): boolean {
  if (entry.relationshipSemantics !== null) {
    return typeof raw === "string" && raw.trim() === "";
  }
  const schema = entry.objectValueSchema;
  const values = Array.isArray(raw) ? raw : [raw];
  if (
    entry.valueCardinality === "multiple" &&
    (!Array.isArray(raw) || values.length === 0)
  ) {
    return false;
  }
  if (entry.valueCardinality === "single" && typeof raw !== "string") {
    return false;
  }
  if (
    values.some(
      (value) => typeof value !== "string" || value.trim().length === 0,
    )
  ) {
    return false;
  }
  if (schema.kind === "text") return true;
  if (schema.kind === "sentiment") {
    return values.every((value) =>
      schema.polarities.includes(value as "positive" | "negative"),
    );
  }
  return values.every((value) =>
    schema.values.some((candidate) => candidate.value === value),
  );
}

function validQualifiers(
  entry: PredicateRegistryEntry,
  qualifiers: readonly ClaimQualifierRow[],
): boolean {
  const semantics = entry.relationshipSemantics;
  if (!semantics) return qualifiers.length === 0;
  return qualifiers.every((qualifier) => {
    const axis = semantics.qualifierAxes.find(
      (candidate) => candidate.axisId === qualifier.axis_id,
    );
    if (!axis || qualifier.evidence_item_ids.length === 0) return false;
    if (
      axis.appliesToRole !== "either" &&
      axis.appliesToRole !== qualifier.role_side
    ) {
      return false;
    }
    return validQualifierValue(
      axis.valueSchema,
      axis.cardinality,
      qualifier.typed_value,
    );
  });
}

function validQualifierValue(
  schema: PredicateRegistryEntry["objectValueSchema"],
  cardinality: "single" | "multiple",
  raw: unknown,
): boolean {
  const values = Array.isArray(raw) ? raw : [raw];
  if (cardinality === "multiple" && (!Array.isArray(raw) || values.length === 0)) {
    return false;
  }
  if (cardinality === "single" && typeof raw !== "string") return false;
  if (
    values.some(
      (value) => typeof value !== "string" || value.trim().length === 0,
    )
  ) {
    return false;
  }
  if (schema.kind === "text") return values.every((value) => value.length <= 2_000);
  if (schema.kind === "sentiment") {
    return values.every((value) =>
      schema.polarities.includes(value as "positive" | "negative"),
    );
  }
  return values.every((value) =>
    schema.values.some((candidate) => candidate.value === value),
  );
}

async function areEvidenceItemsValid(
  client: Pick<Pool, "query">,
  userId: string,
  evidenceItemIds: readonly string[],
): Promise<boolean> {
  if (evidenceItemIds.length === 0) return false;
  const result = await client.query<{
    total: number;
    valid: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE item.status = 'active'
              AND item.source_actor = 'user'
              AND item.source_status IN ('final', 'corrected')
              AND revision.content_purged_at IS NULL
              AND revision.transcript_status IN ('final', 'corrected')
              AND event.actor = 'user'
              AND event.lifecycle_status = 'active'
              AND NOT EXISTS (
                SELECT 1
                FROM memory_forget_evidence_exclusions exclusion
                WHERE exclusion.user_id = item.user_id
                  AND exclusion.evidence_item_id = item.evidence_item_id
                  AND exclusion.status = 'active'
              ))::int AS valid
     FROM evidence_items item
     INNER JOIN conversation_event_revisions revision
       ON revision.conversation_event_revision_id = item.source_revision_id
      AND revision.user_id = item.user_id
     INNER JOIN conversation_events event
       ON event.conversation_event_id = revision.conversation_event_id
      AND event.user_id = revision.user_id
     WHERE item.user_id = $1
       AND item.evidence_item_id = ANY($2::uuid[])`,
    [userId, [...new Set(evidenceItemIds)]],
  );
  const row = result.rows[0];
  return row !== undefined && row.total === row.valid;
}

function assertSameIds(
  supplied: readonly string[],
  actual: readonly string[],
  label: string,
): void {
  const normalize = (ids: readonly string[]) => [...new Set(ids)].sort();
  const suppliedIds = normalize(supplied);
  const actualIds = normalize(actual);
  if (
    suppliedIds.length !== supplied.length ||
    suppliedIds.length !== actualIds.length ||
    suppliedIds.some((id, index) => id !== actualIds[index])
  ) {
    throw new Error(`${label} revalidation lineage drifted before commit.`);
  }
}
