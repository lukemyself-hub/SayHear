import type {
  ConversationActionTransactionExecutor,
  EntityIdentityCorrectionCommitPort,
  EntityIdentityCorrectionOperation,
  EntityIdentityCorrectionTargetResolver,
  EntityIdentityCorrectionTargetResolution,
  ResolvedEntityIdentityCorrectionTarget,
} from "@sayhear/application";
import {
  ENTITY_IDENTITY_CORRECTION_POLICY_VERSION,
  ENTITY_IDENTITY_REVALIDATION_POLICY_VERSION,
  hasExplicitEntityIdentityCorrection,
  hasExplicitEntityIdentityStatement,
  normalizeEntityLabel,
  planEntityIdentityCorrection,
} from "@sayhear/application";
import type { Pool } from "pg";

import { insertExecutionReceipt } from "./postgres-conversation-action-repository";
import { createUuidV7 } from "./uuid-v7";

type EntityCandidateRow = Readonly<{
  entity_id: string;
  entity_version_id: string;
  entity_version_status:
    | "active"
    | "merged"
    | "split"
    | "unresolved"
    | "deleted";
  is_self: boolean;
  labels: string[];
}>;

type EntityStateRow = Readonly<{
  entity_id: string;
  entity_version_id: string | null;
  entity_version_revision: number | null;
  entity_version_status:
    | "active"
    | "merged"
    | "split"
    | "unresolved"
    | "deleted"
    | null;
  entity_kind_id: string | null;
  deleted_at: Date | null;
  is_self: boolean;
}>;

type AffectedClaimRow = Readonly<{
  claim_id: string;
  current_version_id: string;
  revision: number;
  kind: "objective" | "impression";
  epistemic_status: "confirmed" | "inferred" | "contested";
  subject_entity_version_id: string;
  object_entity_version_id: string | null;
  typed_value: unknown;
  confidence: number | string | null;
  temporal_status: string;
  valid_from: Date | null;
  valid_from_precision: string;
  valid_to: Date | null;
  valid_to_precision: string;
  last_observed_at: Date;
  model_version: string | null;
  prompt_version: string | null;
  predicate_registry_version: number;
}>;

type ClaimEvidenceRow = Readonly<{
  evidence_item_id: string;
  link_role: "support" | "counter" | "subjective_report" | "context";
}>;

type ClaimQualifierRow = Readonly<{
  axis_id: string;
  role_side: "canonical_subject" | "counterpart";
  typed_value: unknown;
  evidence_item_ids: string[];
}>;

type JournalLineageRow = Readonly<{
  journal_statement_id: string;
  entity_version_id: string;
  evidence_item_id: string;
  link_role: "subject" | "object" | "mention";
  source_revision: number;
}>;

type OwnerStateRow = Readonly<{
  status: "active" | "deleting" | "disabled";
  data_epoch: string;
}>;

/**
 * Admission-time exact Entity lookup for `entity_identity_correction`.
 * Anchors are only compared with current primary labels / verified aliases;
 * fuzzy matching and model guesses never enter this search space.
 */
export class PostgresEntityIdentityCorrectionTargetSource
  implements EntityIdentityCorrectionTargetResolver
{
  public constructor(private readonly pool: Pool) {}

  public async resolve(input: {
    operation: EntityIdentityCorrectionOperation;
    relatedTargetAnchor?: string;
    newEntityLabel?: string;
    requestEventRevisionId: string;
    targetAnchor: string;
    userId: string;
  }): Promise<EntityIdentityCorrectionTargetResolution> {
    const [owner, requestText, sourceCandidates] = await Promise.all([
      this.pool.query<OwnerStateRow>(
        `SELECT status, data_epoch::text AS data_epoch
         FROM app_users WHERE user_id = $1`,
        [input.userId],
      ),
      this.loadRequestText(input.userId, input.requestEventRevisionId),
      this.listEntityCandidates(input.userId, input.targetAnchor),
    ]);
    const ownerRow = owner.rows[0];
    if (!ownerRow || ownerRow.status !== "active") {
      return {
        outcome: "unsupported_scope",
        reasonCode: "owner_not_active",
      };
    }
    if (requestText === null) {
      return {
        outcome: "unsupported_scope",
        reasonCode: "request_revision_not_found",
      };
    }
    const normalizedRequestText = normalizeEntityLabel(requestText);
    if (!surfaceOccursIn(input.targetAnchor, normalizedRequestText)) {
      return {
        outcome: "precondition_failed",
        reasonCode: "identity_target_not_stated",
      };
    }

    const source = uniqueCandidate(sourceCandidates);
    if (sourceCandidates.length > 1) {
      return {
        candidateCount: sourceCandidates.length,
        outcome: "multi_hit",
      };
    }
    if (!source) return { outcome: "zero_hit" };
    if (source.is_self) {
      return {
        outcome: "precondition_failed",
        reasonCode: "self_entity_protected",
      };
    }

    if (
      input.operation !== "merge" &&
      input.operation !== "split" &&
      input.operation !== "promote"
    ) {
      return {
        outcome: "unsupported_scope",
        reasonCode: "identity_operation_not_supported",
      };
    }

    let related: EntityCandidateRow | null = null;
    if (input.operation === "merge") {
      const anchor = input.relatedTargetAnchor?.trim() ?? "";
      if (anchor === "") {
        return {
          outcome: "unsupported_scope",
          reasonCode: "merge_related_target_required",
        };
      }
      if (!surfaceOccursIn(anchor, normalizedRequestText)) {
        return {
          outcome: "precondition_failed",
          reasonCode: "identity_related_target_not_stated",
        };
      }
      const relatedCandidates = await this.listEntityCandidates(
        input.userId,
        anchor,
      );
      if (relatedCandidates.length > 1) {
        return {
          candidateCount: relatedCandidates.length,
          outcome: "multi_hit",
        };
      }
      related = uniqueCandidate(relatedCandidates);
      if (!related) return { outcome: "zero_hit" };
      if (related.is_self) {
        return {
          outcome: "precondition_failed",
          reasonCode: "self_entity_protected",
        };
      }
      if (source.entity_id === related.entity_id) {
        return {
          outcome: "precondition_failed",
          reasonCode: "merge_target_same_entity",
        };
      }
      if (input.newEntityLabel !== undefined) {
        return {
          outcome: "unsupported_scope",
          reasonCode: "merge_new_label_not_allowed",
        };
      }
    }

    const newEntityLabel = input.newEntityLabel?.trim() ?? null;
    if (input.operation === "split") {
      if (input.relatedTargetAnchor !== undefined) {
        return {
          outcome: "unsupported_scope",
          reasonCode: "split_related_target_not_allowed",
        };
      }
      if (!newEntityLabel) {
        return {
          outcome: "precondition_failed",
          reasonCode: "split_new_label_required",
        };
      }
      if (!surfaceOccursIn(newEntityLabel, normalizedRequestText)) {
        return {
          outcome: "precondition_failed",
          reasonCode: "split_new_label_not_stated",
        };
      }
      if (
        await this.currentLabelExists(input.userId, newEntityLabel)
      ) {
        return {
          outcome: "precondition_failed",
          reasonCode: "split_new_label_conflicts",
        };
      }
    }

    if (
      input.operation === "promote" &&
      (input.relatedTargetAnchor !== undefined ||
        input.newEntityLabel !== undefined)
    ) {
      return {
        outcome: "unsupported_scope",
        reasonCode: "promote_extra_target_not_allowed",
      };
    }

    const explicitStatement = source.labels.some((label) =>
      hasExplicitEntityIdentityStatement(requestText, label),
    );
    const independentRevisionCount =
      input.operation === "promote"
        ? await this.countIndependentRevisions(input.userId, source.entity_id)
        : 0;
    const explicitUserCorrection =
      explicitStatement ||
      hasExplicitEntityIdentityCorrection(requestText, input.operation);
    const target: ResolvedEntityIdentityCorrectionTarget = {
      operation: input.operation,
      sourceEntityId: source.entity_id,
      sourceEntityVersionId: source.entity_version_id,
      sourceEntityVersionStatus: source.entity_version_status,
      sourceIsSelf: source.is_self,
      targetEntityId: related?.entity_id ?? null,
      targetEntityVersionId: related?.entity_version_id ?? null,
      targetEntityVersionStatus: related?.entity_version_status ?? null,
      ...(related?.is_self ? { targetIsSelf: true } : {}),
      newEntityLabel,
      promotionEvidence:
        input.operation === "promote"
          ? {
              explicitStatement,
              independentRevisionCount,
            }
          : null,
      expectedDataEpoch: Number(ownerRow.data_epoch),
      explicitUserCorrection,
    };
    const plan = planEntityIdentityCorrection(target);
    if (plan.action === "rejected") {
      return {
        outcome: "precondition_failed",
        reasonCode: plan.reasonCode,
      };
    }
    return { outcome: "unique", target };
  }

  private async loadRequestText(
    userId: string,
    requestEventRevisionId: string,
  ): Promise<string | null> {
    const result = await this.pool.query<{ canonical_text: string }>(
      `SELECT revision.canonical_text
       FROM conversation_event_revisions revision
       INNER JOIN conversation_events event
         ON event.conversation_event_id = revision.conversation_event_id
        AND event.user_id = revision.user_id
       WHERE revision.user_id = $1
         AND revision.conversation_event_revision_id = $2
         AND revision.content_purged_at IS NULL
         AND event.actor = 'user'
         AND event.lifecycle_status = 'active'`,
      [userId, requestEventRevisionId],
    );
    return result.rows[0]?.canonical_text ?? null;
  }

  private async listEntityCandidates(
    userId: string,
    anchor: string,
  ): Promise<readonly EntityCandidateRow[]> {
    const normalizedAnchor = normalizeEntityLabel(anchor);
    const result = await this.pool.query<EntityCandidateRow>(
      `WITH RECURSIVE current_entities AS (
         SELECT entity.entity_id,
                entity.current_version_id AS entity_version_id,
                version.status,
                version.merged_into_entity_id
         FROM entities entity
         INNER JOIN entity_versions version
           ON version.entity_id = entity.entity_id
          AND version.user_id = entity.user_id
          AND version.entity_version_id = entity.current_version_id
         WHERE entity.user_id = $1
           AND entity.deleted_at IS NULL
           AND version.status IN ('active', 'unresolved', 'merged')
       ),
       entity_resolution(labeled_entity_id, resolved_entity_id) AS (
         SELECT entity_id, entity_id FROM current_entities
         UNION ALL
         SELECT resolution.labeled_entity_id, next_entity.merged_into_entity_id
         FROM entity_resolution resolution
         INNER JOIN current_entities next_entity
           ON next_entity.entity_id = resolution.resolved_entity_id
         WHERE next_entity.status = 'merged'
           AND next_entity.merged_into_entity_id IS NOT NULL
       )
       SELECT resolved.entity_id::text,
              resolved.entity_version_id::text,
              resolved.status AS entity_version_status,
              EXISTS (
                SELECT 1 FROM user_self_entities self_binding
                WHERE self_binding.user_id = $1
                  AND self_binding.entity_id = resolved.entity_id
              ) AS is_self,
              array_agg(DISTINCT label.label ORDER BY label.label) AS labels
       FROM entity_resolution resolution
       INNER JOIN current_entities resolved
         ON resolved.entity_id = resolution.resolved_entity_id
       INNER JOIN entity_labels label
         ON label.entity_id = resolution.labeled_entity_id
        AND label.user_id = $1
        AND label.is_current
        AND label.content_purged_at IS NULL
        AND (
          label.label_kind = 'primary' OR label.source_evidence_id IS NOT NULL
        )
       WHERE resolved.status IN ('active', 'unresolved')
         AND EXISTS (
           SELECT 1
           FROM entity_labels matched_label
           WHERE matched_label.entity_id = resolution.labeled_entity_id
             AND matched_label.user_id = $1
             AND matched_label.is_current
             AND matched_label.content_purged_at IS NULL
             AND (
               matched_label.label_kind = 'primary'
               OR matched_label.source_evidence_id IS NOT NULL
             )
             AND matched_label.normalized_label = $2
         )
       GROUP BY resolved.entity_id, resolved.entity_version_id,
                resolved.status
       ORDER BY resolved.entity_id
       LIMIT 1001`,
      [userId, normalizedAnchor],
    );
    return result.rows.filter((row) =>
      row.labels.some((label) => normalizeEntityLabel(label) === normalizedAnchor),
    );
  }

  private async currentLabelExists(
    userId: string,
    label: string,
  ): Promise<boolean> {
    return (await this.listEntityCandidates(userId, label)).length > 0;
  }

  private async countIndependentRevisions(
    userId: string,
    entityId: string,
  ): Promise<number> {
    const result = await this.pool.query<{ independent_revision_count: number }>(
      `SELECT count(DISTINCT session.logical_date)::int
         AS independent_revision_count
       FROM entity_mentions mention
       INNER JOIN conversation_events event
         ON event.conversation_event_id = mention.conversation_event_id
        AND event.user_id = mention.user_id
       INNER JOIN daily_sessions session
         ON session.daily_session_id = event.daily_session_id
        AND session.user_id = mention.user_id
       INNER JOIN conversation_event_revisions revision
         ON revision.conversation_event_revision_id = mention.event_revision_id
        AND revision.user_id = mention.user_id
       WHERE mention.user_id = $1
         AND mention.resolved_entity_id = $2
         AND mention.resolution_status = 'resolved'
         AND mention.mention_kind = 'named'
         AND mention.content_purged_at IS NULL
         AND event.actor = 'user'
         AND event.lifecycle_status = 'active'
         AND revision.transcript_status IN ('final', 'corrected')
         AND revision.content_purged_at IS NULL`,
      [userId, entityId],
    );
    return Number(result.rows[0]?.independent_revision_count ?? 0);
  }
}

/**
 * Authoritative synchronous identity surgery. The Gateway supplies a
 * transaction-scoped executor; every EntityVersion, Claim suspension, Journal
 * fence, Receipt-linked audit row, and outbox command therefore commits or
 * rolls back together.
 */
export class PostgresEntityIdentityCorrectionCommitPort
  implements EntityIdentityCorrectionCommitPort
{
  public async executeEntityIdentityCorrection(
    executor: ConversationActionTransactionExecutor,
    input: {
      actionExecutionId: string;
      requestEventRevisionId: string;
      target: ResolvedEntityIdentityCorrectionTarget;
      userId: string;
    },
  ): Promise<string> {
    const owner = await executor.query<OwnerStateRow>(
      `SELECT status, data_epoch::text AS data_epoch
       FROM app_users WHERE user_id = $1 FOR UPDATE`,
      [input.userId],
    );
    const ownerRow = owner.rows[0];
    if (
      !ownerRow ||
      ownerRow.status !== "active" ||
      Number(ownerRow.data_epoch) !== input.target.expectedDataEpoch
    ) {
      throw new Error("Entity identity correction was fenced by the owner epoch.");
    }

    const entityIds = [
      input.target.sourceEntityId,
      ...(input.target.targetEntityId === null
        ? []
        : [input.target.targetEntityId]),
    ];
    const states = await executor.query<EntityStateRow>(
      `SELECT entity.entity_id::text,
              entity.current_version_id::text AS entity_version_id,
              version.revision AS entity_version_revision,
              version.status AS entity_version_status,
              version.entity_kind_id,
              entity.deleted_at,
              EXISTS (
                SELECT 1 FROM user_self_entities binding
                WHERE binding.user_id = entity.user_id
                  AND binding.entity_id = entity.entity_id
              ) AS is_self
       FROM entities entity
       LEFT JOIN entity_versions version
         ON version.entity_id = entity.entity_id
        AND version.user_id = entity.user_id
        AND version.entity_version_id = entity.current_version_id
       WHERE entity.user_id = $1
         AND entity.entity_id = ANY($2::uuid[])
       ORDER BY entity.entity_id
       FOR UPDATE OF entity`,
      [input.userId, entityIds],
    );
    const source = states.rows.find(
      (row) => row.entity_id === input.target.sourceEntityId,
    );
    const related = input.target.targetEntityId
      ? states.rows.find(
          (row) => row.entity_id === input.target.targetEntityId,
        )
      : null;
    if (
      !source ||
      source.deleted_at !== null ||
      source.entity_version_id !== input.target.sourceEntityVersionId ||
      source.entity_version_status === null ||
      !source.entity_version_revision ||
      (input.target.targetEntityId !== null &&
        (!related ||
          related.deleted_at !== null ||
          related.entity_version_id !== input.target.targetEntityVersionId ||
          related.entity_version_status === null ||
          !related.entity_version_revision))
    ) {
      throw new Error("Entity identity correction target advanced before commit.");
    }

    const actualTarget: ResolvedEntityIdentityCorrectionTarget = {
      ...input.target,
      sourceEntityVersionStatus: source.entity_version_status,
      sourceIsSelf: source.is_self,
      targetEntityVersionStatus: related?.entity_version_status ?? null,
      ...(related?.is_self ? { targetIsSelf: true } : {}),
    };
    const plan = planEntityIdentityCorrection(actualTarget);
    if (plan.action === "rejected") {
      throw new Error(`Entity identity correction rejected: ${plan.reasonCode}.`);
    }
    if (plan.action === "noop_already_promoted") return "succeeded_noop";

    const now = new Date();
    const oldEntityVersionIds = [input.target.sourceEntityVersionId];
    if (input.target.targetEntityVersionId !== null) {
      oldEntityVersionIds.push(input.target.targetEntityVersionId);
    }
    let createdEntityId: string | null = null;
    let createdEntityVersionId: string | null = null;
    if (plan.action === "merge") {
      await this.appendEntityVersion(executor, {
        entityId: source.entity_id,
        entityKindId: source.entity_kind_id!,
        mergedIntoEntityId: related!.entity_id,
        revision: source.entity_version_revision! + 1,
        status: "merged",
        supersedesVersionId: source.entity_version_id!,
        userId: input.userId,
        now,
      });
      await this.appendEntityVersion(executor, {
        entityId: related!.entity_id,
        entityKindId: related!.entity_kind_id!,
        mergedIntoEntityId: null,
        revision: related!.entity_version_revision! + 1,
        status: "active",
        supersedesVersionId: related!.entity_version_id!,
        userId: input.userId,
        now,
      });
      await this.moveCurrentVersion(
        executor,
        input.userId,
        source.entity_id,
        source.entity_version_id!,
        source.entity_version_revision! + 1,
      );
      await this.moveCurrentVersion(
        executor,
        input.userId,
        related!.entity_id,
        related!.entity_version_id!,
        related!.entity_version_revision! + 1,
      );
    } else if (plan.action === "split") {
      const sourceVersionId = await this.appendEntityVersion(executor, {
        entityId: source.entity_id,
        entityKindId: source.entity_kind_id!,
        mergedIntoEntityId: null,
        revision: source.entity_version_revision! + 1,
        status: "split",
        supersedesVersionId: source.entity_version_id!,
        userId: input.userId,
        now,
      });
      await this.moveCurrentVersion(
        executor,
        input.userId,
        source.entity_id,
        source.entity_version_id!,
        sourceVersionId,
      );
      createdEntityId = createUuidV7(now);
      createdEntityVersionId = createUuidV7(now);
      await executor.query(
        `INSERT INTO entities (entity_id, user_id, created_at)
         VALUES ($1, $2, $3)`,
        [createdEntityId, input.userId, now],
      );
      await executor.query(
        `INSERT INTO entity_versions (
           entity_version_id, entity_id, user_id, revision, entity_kind_id,
           status, created_at
         ) VALUES ($1, $2, $3, 1, $4, 'active', $5)`,
        [
          createdEntityVersionId,
          createdEntityId,
          input.userId,
          source.entity_kind_id!,
          now,
        ],
      );
      await executor.query(
        `UPDATE entities SET current_version_id = $1
         WHERE entity_id = $2 AND user_id = $3`,
        [createdEntityVersionId, createdEntityId, input.userId],
      );
      await executor.query(
        `INSERT INTO entity_labels (
           entity_label_id, entity_id, user_id, locale, label,
           normalized_label, label_kind, is_current, source_evidence_id,
           created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'primary', TRUE, NULL, $7)`,
        [
          createUuidV7(now),
          createdEntityId,
          input.userId,
          inferLocale(plan.newEntityLabel),
          plan.newEntityLabel,
          normalizeEntityLabel(plan.newEntityLabel),
          now,
        ],
      );
    } else if (plan.action === "promote") {
      const promotedVersionId = await this.appendEntityVersion(executor, {
        entityId: source.entity_id,
        entityKindId: source.entity_kind_id!,
        mergedIntoEntityId: null,
        revision: source.entity_version_revision! + 1,
        status: "active",
        supersedesVersionId: source.entity_version_id!,
        userId: input.userId,
        now,
      });
      await this.moveCurrentVersion(
        executor,
        input.userId,
        source.entity_id,
        source.entity_version_id!,
        promotedVersionId,
      );
    }

    const affectedClaims = await this.listAffectedClaims(
      executor,
      input.userId,
      oldEntityVersionIds,
    );
    for (const claim of affectedClaims) {
      await this.suspendClaim(executor, {
        claim,
        now,
        userId: input.userId,
      });
    }

    const lineage = await this.listJournalLineage(
      executor,
      input.userId,
      oldEntityVersionIds,
      affectedClaims.map((claim) => claim.current_version_id),
    );
    for (const row of lineage) {
      await executor.query(
        `INSERT INTO journal_statement_entity_links (
           journal_statement_entity_link_id, journal_statement_id,
           entity_version_id, evidence_item_id, user_id, link_role, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [
          createUuidV7(now),
          row.journal_statement_id,
          row.entity_version_id,
          row.evidence_item_id,
          input.userId,
          row.link_role,
          now,
        ],
      );
    }

    const correctionId = createUuidV7(now);
    await executor.query(
      `INSERT INTO entity_identity_corrections (
         entity_identity_correction_id, user_id, action_execution_id,
         request_event_revision_id, operation, source_entity_id,
         source_entity_version_id, related_entity_id, related_entity_version_id,
         created_entity_id, created_entity_version_id,
         promotion_explicit_statement, promotion_independent_revision_count,
         correction_policy_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15)`,
      [
        correctionId,
        input.userId,
        input.actionExecutionId,
        input.requestEventRevisionId,
        plan.action,
        source.entity_id,
        source.entity_version_id,
        related?.entity_id ?? null,
        related?.entity_version_id ?? null,
        createdEntityId,
        createdEntityVersionId,
        input.target.promotionEvidence?.explicitStatement ?? false,
        input.target.promotionEvidence?.independentRevisionCount ?? 0,
        ENTITY_IDENTITY_CORRECTION_POLICY_VERSION,
        now,
      ],
    );

    const fenceRows = uniqueJournalFences(lineage);
    for (const row of fenceRows) {
      await executor.query(
        `INSERT INTO journal_identity_review_fences (
           journal_identity_review_fence_id, user_id, action_execution_id,
           journal_statement_id, entity_version_id, source_revision, status,
           created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'identity_review_pending', $7)
         ON CONFLICT DO NOTHING`,
        [
          createUuidV7(now),
          input.userId,
          input.actionExecutionId,
          row.journal_statement_id,
          row.entity_version_id,
          row.source_revision,
          now,
        ],
      );
    }

    const dataEpoch = Number(ownerRow.data_epoch);
    const workflowCommandId = createUuidV7(now);
    const sourceRevision = source.entity_version_revision!;
    await executor.query(
      `INSERT INTO workflow_commands (
         workflow_command_id, command_type, subject_type, subject_id,
         source_revision, policy_version, expected_data_epoch,
         action_execution_id, status, created_at
       ) VALUES ($1, 'entity_identity_revalidation', 'entity', $2,
         $3, $4, $5, $6, 'created', $7)`,
      [
        workflowCommandId,
        source.entity_id,
        sourceRevision,
        ENTITY_IDENTITY_REVALIDATION_POLICY_VERSION,
        dataEpoch,
        input.actionExecutionId,
        now,
      ],
    );
    await executor.query(
      `INSERT INTO outbox_events (
         outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
         aggregate_revision, event_type, status, next_attempt_at,
         attempt_count, payload, created_at
       ) VALUES ($1, $2, 'entity', $3, $4,
         'entity_identity_revalidation_requested', 'pending', $5, 0, $6::jsonb,
         $5)`,
      [
        createUuidV7(now),
        workflowCommandId,
        source.entity_id,
        sourceRevision,
        now,
        JSON.stringify({
          actionExecutionId: input.actionExecutionId,
          eventType: "entity_identity_revalidation_requested",
          expectedDataEpoch: dataEpoch,
          policyVersion: ENTITY_IDENTITY_REVALIDATION_POLICY_VERSION,
          sourceRevision,
          status: "pending",
          subjectId: source.entity_id,
          workflowCommandId,
        }),
      ],
    );
    return "committed_in_transaction";
  }

  private async appendEntityVersion(
    executor: ConversationActionTransactionExecutor,
    input: {
      entityId: string;
      entityKindId: string;
      mergedIntoEntityId: string | null;
      revision: number;
      status: "active" | "merged" | "split" | "unresolved" | "deleted";
      supersedesVersionId: string;
      userId: string;
      now: Date;
    },
  ): Promise<string> {
    const versionId = createUuidV7(input.now);
    await executor.query(
      `INSERT INTO entity_versions (
         entity_version_id, entity_id, user_id, revision, entity_kind_id,
         status, merged_into_entity_id, supersedes_version_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        versionId,
        input.entityId,
        input.userId,
        input.revision,
        input.entityKindId,
        input.status,
        input.mergedIntoEntityId,
        input.supersedesVersionId,
        input.now,
      ],
    );
    return versionId;
  }

  private async moveCurrentVersion(
    executor: ConversationActionTransactionExecutor,
    userId: string,
    entityId: string,
    oldVersionId: string,
    revisionOrVersionId: number | string,
  ): Promise<void> {
    const versionId =
      typeof revisionOrVersionId === "string"
        ? revisionOrVersionId
        : (
            await executor.query<{ entity_version_id: string }>(
              `SELECT entity_version_id::text
               FROM entity_versions
               WHERE user_id = $1 AND entity_id = $2 AND revision = $3`,
              [userId, entityId, revisionOrVersionId],
            )
          ).rows[0]?.entity_version_id;
    if (!versionId) throw new Error(`Entity ${entityId} version append was not found.`);
    const moved = await executor.query(
      `UPDATE entities SET current_version_id = $3
       WHERE user_id = $1 AND entity_id = $2
         AND current_version_id IS NOT DISTINCT FROM $4`,
      [userId, entityId, versionId, oldVersionId],
    );
    if (moved.rowCount !== 1) {
      throw new Error(`Entity ${entityId} current-version CAS failed.`);
    }
  }

  private async listAffectedClaims(
    executor: ConversationActionTransactionExecutor,
    userId: string,
    entityVersionIds: readonly string[],
  ): Promise<readonly AffectedClaimRow[]> {
    const result = await executor.query<AffectedClaimRow>(
      `SELECT claim.memory_claim_id::text AS claim_id,
              version.memory_claim_version_id::text AS current_version_id,
              version.revision, version.kind, version.epistemic_status,
              version.subject_entity_version_id::text,
              version.object_entity_version_id::text,
              version.typed_value, version.confidence, version.temporal_status,
              version.valid_from, version.valid_from_precision,
              version.valid_to, version.valid_to_precision,
              version.last_observed_at, version.model_version,
              version.prompt_version, version.predicate_registry_version
       FROM memory_claims claim
       INNER JOIN memory_claim_versions version
         ON version.memory_claim_version_id = claim.current_version_id
        AND version.user_id = claim.user_id
       WHERE claim.user_id = $1
         AND claim.deleted_at IS NULL
         AND claim.content_purged_at IS NULL
         AND version.content_purged_at IS NULL
         AND version.status IN ('active', 'review_due', 'dormant')
         AND (
           version.subject_entity_version_id = ANY($2::uuid[])
           OR version.object_entity_version_id = ANY($2::uuid[])
         )
       ORDER BY claim.memory_claim_id
       FOR UPDATE OF claim`,
      [userId, entityVersionIds],
    );
    return result.rows;
  }

  private async suspendClaim(
    executor: ConversationActionTransactionExecutor,
    input: {
      claim: AffectedClaimRow;
      now: Date;
      userId: string;
    },
  ): Promise<void> {
    const versionId = createUuidV7(input.now);
    await executor.query(
      `INSERT INTO memory_claim_versions (
         memory_claim_version_id, memory_claim_id, user_id,
         revision, kind, epistemic_status, status, subject_entity_version_id,
         object_entity_version_id, typed_value, confidence, temporal_status,
         valid_from, valid_from_precision, valid_to, valid_to_precision,
         last_observed_at, supersedes_version_id, created_by, model_version,
         prompt_version, predicate_registry_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'review_due', $7, $8, $9::jsonb,
         $10, $11, $12, $13, $14, $15, $16, $17, 'entity_identity_correction',
         $18, $19, $20, $21)`,
      [
        versionId,
        input.claim.claim_id,
        input.userId,
        input.claim.revision + 1,
        input.claim.kind,
        input.claim.epistemic_status,
        input.claim.subject_entity_version_id,
        input.claim.object_entity_version_id,
        JSON.stringify(input.claim.typed_value),
        input.claim.confidence,
        input.claim.temporal_status,
        input.claim.valid_from,
        input.claim.valid_from_precision,
        input.claim.valid_to,
        input.claim.valid_to_precision,
        input.claim.last_observed_at,
        input.claim.current_version_id,
        input.claim.model_version,
        input.claim.prompt_version,
        input.claim.predicate_registry_version,
        input.now,
      ],
    );
    const evidence = await executor.query<ClaimEvidenceRow>(
      `SELECT evidence_item_id::text, link_role
       FROM claim_evidence_links
       WHERE user_id = $1 AND memory_claim_version_id = $2
       ORDER BY evidence_item_id, link_role`,
      [input.userId, input.claim.current_version_id],
    );
    for (const link of evidence.rows) {
      await executor.query(
        `INSERT INTO claim_evidence_links (
           claim_evidence_link_id, memory_claim_version_id, user_id,
           evidence_item_id, link_role, status, created_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', $6)
         ON CONFLICT DO NOTHING`,
        [
          createUuidV7(input.now),
          versionId,
          input.userId,
          link.evidence_item_id,
          link.link_role,
          input.now,
        ],
      );
    }
    const qualifiers = await executor.query<ClaimQualifierRow>(
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
      [input.userId, input.claim.current_version_id],
    );
    for (const qualifier of qualifiers.rows) {
      const qualifierId = createUuidV7(input.now);
      await executor.query(
        `INSERT INTO memory_claim_version_qualifiers (
           memory_claim_version_qualifier_id, memory_claim_version_id, user_id,
           axis_id, role_side, typed_value, created_by, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb,
           'entity_identity_correction', $7)`,
        [
          qualifierId,
          versionId,
          input.userId,
          qualifier.axis_id,
          qualifier.role_side,
          JSON.stringify(qualifier.typed_value),
          input.now,
        ],
      );
      for (const evidenceItemId of qualifier.evidence_item_ids) {
        await executor.query(
          `INSERT INTO memory_claim_version_qualifier_evidence (
             memory_claim_version_qualifier_evidence_id,
             memory_claim_version_qualifier_id, user_id, evidence_item_id,
             created_at
           ) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [createUuidV7(input.now), qualifierId, input.userId, evidenceItemId, input.now],
        );
      }
    }
    const moved = await executor.query(
      `UPDATE memory_claims SET current_version_id = $3
       WHERE user_id = $1 AND memory_claim_id = $2
         AND current_version_id IS NOT DISTINCT FROM $4`,
      [input.userId, input.claim.claim_id, versionId, input.claim.current_version_id],
    );
    if (moved.rowCount !== 1) {
      throw new Error(`Claim ${input.claim.claim_id} suspension CAS failed.`);
    }
    await executor.query(
      `UPDATE claim_retrieval_projections
       SET status = 'stale'
       WHERE user_id = $1 AND memory_claim_id = $2 AND status = 'active'`,
      [input.userId, input.claim.claim_id],
    );
    await executor.query(
      `DELETE FROM relationship_resolver_hints
       WHERE user_id = $1 AND memory_claim_id = $2`,
      [input.userId, input.claim.claim_id],
    );
  }

  private async listJournalLineage(
    executor: ConversationActionTransactionExecutor,
    userId: string,
    entityVersionIds: readonly string[],
    claimVersionIds: readonly string[],
  ): Promise<readonly JournalLineageRow[]> {
    const result = await executor.query<JournalLineageRow>(
      `
        SELECT DISTINCT statement_link.journal_statement_id::text
          AS journal_statement_id,
          claim_version.subject_entity_version_id::text AS entity_version_id,
          statement_link.evidence_item_id::text AS evidence_item_id,
          'subject' AS link_role,
          statement.source_revision
        FROM journal_statement_evidence_links statement_link
        INNER JOIN journal_statements statement
          ON statement.journal_statement_id = statement_link.journal_statement_id
         AND statement.user_id = statement_link.user_id
        INNER JOIN claim_evidence_links claim_link
          ON claim_link.evidence_item_id = statement_link.evidence_item_id
         AND claim_link.user_id = statement_link.user_id
        INNER JOIN memory_claim_versions claim_version
          ON claim_version.memory_claim_version_id = claim_link.memory_claim_version_id
         AND claim_version.user_id = claim_link.user_id
        WHERE statement_link.user_id = $1
          AND claim_version.memory_claim_version_id = ANY($2::uuid[])
          AND claim_version.subject_entity_version_id = ANY($3::uuid[])
        UNION
        SELECT DISTINCT statement_link.journal_statement_id::text,
          claim_version.object_entity_version_id::text,
          statement_link.evidence_item_id::text,
          'object' AS link_role,
          statement.source_revision
        FROM journal_statement_evidence_links statement_link
        INNER JOIN journal_statements statement
          ON statement.journal_statement_id = statement_link.journal_statement_id
         AND statement.user_id = statement_link.user_id
        INNER JOIN claim_evidence_links claim_link
          ON claim_link.evidence_item_id = statement_link.evidence_item_id
         AND claim_link.user_id = statement_link.user_id
        INNER JOIN memory_claim_versions claim_version
          ON claim_version.memory_claim_version_id = claim_link.memory_claim_version_id
         AND claim_version.user_id = claim_link.user_id
        WHERE statement_link.user_id = $1
          AND claim_version.memory_claim_version_id = ANY($2::uuid[])
          AND claim_version.object_entity_version_id = ANY($3::uuid[])
        UNION
        SELECT DISTINCT statement_link.journal_statement_id::text,
          entity_version.entity_version_id::text,
          statement_link.evidence_item_id::text,
          'mention' AS link_role,
          statement.source_revision
        FROM journal_statement_evidence_links statement_link
        INNER JOIN journal_statements statement
          ON statement.journal_statement_id = statement_link.journal_statement_id
         AND statement.user_id = statement_link.user_id
        INNER JOIN entity_mentions mention
          ON mention.evidence_id = statement_link.evidence_item_id
         AND mention.user_id = statement_link.user_id
        INNER JOIN entity_versions entity_version
          ON entity_version.entity_id = mention.resolved_entity_id
         AND entity_version.user_id = mention.user_id
         AND entity_version.entity_version_id = ANY($3::uuid[])
        WHERE statement_link.user_id = $1
          AND mention.resolution_status = 'resolved'
        UNION
        SELECT DISTINCT direct_link.journal_statement_id::text,
          direct_link.entity_version_id::text,
          direct_link.evidence_item_id::text,
          direct_link.link_role,
          statement.source_revision
        FROM journal_statement_entity_links direct_link
        INNER JOIN journal_statements statement
          ON statement.journal_statement_id = direct_link.journal_statement_id
         AND statement.user_id = direct_link.user_id
        WHERE direct_link.user_id = $1
          AND direct_link.entity_version_id = ANY($3::uuid[])
        ORDER BY journal_statement_id, entity_version_id, evidence_item_id, link_role
      `,
      [userId, claimVersionIds, entityVersionIds],
    );
    return result.rows;
  }
}

function uniqueCandidate(
  candidates: readonly EntityCandidateRow[],
): EntityCandidateRow | null {
  return candidates.length === 1 ? candidates[0]! : null;
}

function surfaceOccursIn(surface: string, normalizedText: string): boolean {
  const normalizedSurface = normalizeEntityLabel(surface);
  if (normalizedSurface === "") return false;
  if (/[a-z0-9]/.test(normalizedSurface)) {
    return new RegExp(
      `(?:^|[^a-z0-9])${normalizedSurface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`,
    ).test(normalizedText);
  }
  return normalizedText.includes(normalizedSurface);
}

function inferLocale(label: string): "en" | "zh" {
  return /[\u3400-\u9fff]/.test(label) ? "zh" : "en";
}

function uniqueJournalFences(
  rows: readonly JournalLineageRow[],
): readonly Pick<JournalLineageRow, "journal_statement_id" | "entity_version_id" | "source_revision">[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.journal_statement_id}:${row.entity_version_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
