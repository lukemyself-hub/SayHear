import type {
  ActionFinalizationReceiptSnapshot,
  ConversationActionTransactionExecutor,
  ExplainMemorySourceVerdict,
  MemoryCorrectionFollowupCommand,
  MemoryCorrectionFollowupRepository,
  MemoryForgetRequestPlan,
  MemoryForgetReversalPlan,
  MemoryCorrectionPlan,
  MemoryTrustActionCommitPort,
  ResolvedTrustActionTarget,
  RelationshipHintProjectionInputs,
  RetrievalProjectionMaterial,
  TrustActionClaimSnapshot,
  TrustActionLabelIndexEntry,
  TrustActionResolutionCandidate,
} from "@sayhear/application";
import {
  EXPLAIN_SOURCE_QUOTE_MAX_LENGTH,
  MEMORY_CORRECTION_FOLLOWUP_POLICY_VERSION,
  MEMORY_CORRECTION_POLICY_VERSION,
  planMemoryForgetRequest,
  planMemoryForgetReversal,
  normalizeRetrievalTerm,
  TRUST_ACTION_KINDS,
} from "@sayhear/application";
import {
  asClaimEvidenceLinkId,
  asMemoryClaimId,
  asMemoryClaimVersionId,
  asMemoryClaimVersionQualifierId,
  asMemoryForgetEvidenceExclusionId,
  asMemoryForgetRequestId,
  asMemoryForgetReversalId,
  asUserId,
} from "@sayhear/domain";
import type { Pool, PoolClient } from "pg";
import { insertExecutionReceipt } from "./postgres-conversation-action-repository";
import {
  listClaimVersionQualifiersWithin,
  markClaimRetrievalProjectionsStaleWithin,
  rebuildClaimRetrievalProjectionsWithin,
  rebuildRelationshipResolverHintsWithin,
} from "./postgres-memory-claim-repository";
import { createUuidV7 } from "./uuid-v7";

/**
 * The Postgres implementation of the trust-action transaction commit port
 * (issue #119, ADR-0099 / ADR-0118). Every statement runs through the
 * Gateway's admission-transaction executor, so the domain effect, the
 * Receipts, and the Finalization command commit or roll back as one atomic
 * unit. Decisions live in the application-layer planners; this adapter owns
 * only the SQL.
 */

type TrustClaimRow = Readonly<{
  claim_id: string;
  created_by: string | null;
  kind: "objective" | "impression" | null;
  revision: number | null;
  status:
    | "active"
    | "review_due"
    | "dormant"
    | "superseded"
    | "retracted"
    | null;
  version_id: string | null;
}>;

type CurrentVersionRow = Readonly<{
  epistemic_status: string;
  kind: string;
  object_entity_version_id: string | null;
  predicate_registry_version: number;
  subject_entity_version_id: string;
  temporal_status: string;
  typed_value: unknown;
  valid_from: Date | null;
  valid_from_precision: string;
  valid_to: Date | null;
  valid_to_precision: string;
  supersedes_version_id: string | null;
  last_observed_at: Date;
  created_at: Date;
}>;

export type MemoryTrustActionProjectionProvider = Readonly<{
  relationshipHintsFor(predicateId: string): RelationshipHintProjectionInputs | null;
  retrievalProjectionFor(predicateId: string): RetrievalProjectionMaterial | null;
}>;

export class PostgresMemoryTrustActionCommitPort
  implements MemoryTrustActionCommitPort
{
  public constructor(
    private readonly projectionProvider?: MemoryTrustActionProjectionProvider,
  ) {}

  public async loadTrustActionClaim(
    executor: ConversationActionTransactionExecutor,
    input: { claimId: string; userId: string },
  ): Promise<TrustActionClaimSnapshot | null> {
    const result = await executor.query<TrustClaimRow>(
      `
        SELECT
          claim.memory_claim_id::text AS claim_id,
          version.created_by,
          version.kind,
          version.revision,
          version.status,
          version.memory_claim_version_id::text AS version_id
        FROM memory_claims claim
        LEFT JOIN memory_claim_versions version
          ON version.memory_claim_version_id = claim.current_version_id
        WHERE claim.user_id = $1
          AND claim.memory_claim_id = $2
          AND claim.deleted_at IS NULL
          AND claim.content_purged_at IS NULL
        FOR UPDATE OF claim
      `,
      [input.userId, input.claimId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      claimId: asMemoryClaimId(row.claim_id),
      currentVersion:
        row.version_id !== null && row.kind !== null && row.status !== null
          ? {
              createdBy: row.created_by ?? "",
              kind: row.kind,
              revision: row.revision ?? 0,
              status: row.status,
              versionId: asMemoryClaimVersionId(row.version_id),
            }
          : null,
    };
  }

  public async executeMemoryCorrectionPlan(
    executor: ConversationActionTransactionExecutor,
    input: {
      actionExecutionId: string;
      plan: MemoryCorrectionPlan;
      requestEventRevisionId: string;
      snapshot: TrustActionClaimSnapshot;
      userId: string;
    },
  ): Promise<void> {
    if (input.plan.action !== "supersede") return;
    const { snapshot, plan } = input;
    const claimId = snapshot.claimId;
    const currentVersionId = snapshot.currentVersion?.versionId;
    if (!currentVersionId) {
      throw new Error(`Claim ${claimId} has no current version to correct.`);
    }
    const now = new Date();

    // The claim row is already locked by loadTrustActionClaim. The full
    // version field set copies forward onto the superseding version — the
    // append-only discipline: history is never rewritten (ADR-0089), the
    // correction fence is the new current version's `superseded` status.
    const current = await executor.query<CurrentVersionRow>(
      `SELECT epistemic_status, kind, object_entity_version_id::text
         AS object_entity_version_id, predicate_registry_version,
         subject_entity_version_id::text AS subject_entity_version_id,
         temporal_status, typed_value, valid_from, valid_from_precision,
         valid_to, valid_to_precision
       FROM memory_claim_versions
       WHERE user_id = $1 AND memory_claim_version_id = $2`,
      [input.userId, currentVersionId],
    );
    const version = current.rows[0];
    if (!version) {
      throw new Error(
        `Claim version ${currentVersionId} does not exist for this owner.`,
      );
    }

    const revisionRow = await executor.query<{ next_revision: number }>(
      `SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
       FROM memory_claim_versions WHERE memory_claim_id = $1`,
      [claimId],
    );
    const revision = revisionRow.rows[0]!.next_revision;
    const supersededVersionId = asMemoryClaimVersionId(createUuidV7(now));
    await executor.query(
      `INSERT INTO memory_claim_versions (
         memory_claim_version_id, memory_claim_id, user_id,
         revision, kind, epistemic_status, status, subject_entity_version_id,
         object_entity_version_id, typed_value, confidence, temporal_status,
         valid_from, valid_from_precision, valid_to, valid_to_precision,
         last_observed_at, supersedes_version_id, created_by, model_version,
         prompt_version, predicate_registry_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'superseded', $7, $8, $9::jsonb,
         NULL, $10, $11, $12, $13, $14, $15, $16, 'memory_correction',
         NULL, NULL, $17, $18)`,
      [
        supersededVersionId,
        claimId,
        input.userId,
        revision,
        version.kind,
        version.epistemic_status,
        version.subject_entity_version_id,
        version.object_entity_version_id,
        JSON.stringify(toTypedValue(version.typed_value)),
        version.temporal_status,
        version.valid_from,
        version.valid_from_precision,
        version.valid_to,
        version.valid_to_precision,
        now,
        currentVersionId,
        version.predicate_registry_version,
        now,
      ],
    );

    // User control command (ADR-0035 pattern): the correction record, never
    // counter-Evidence. References only — the user's words stay in the
    // conversation Events (ADR-0101).
    await executor.query(
      `INSERT INTO memory_claim_corrections (
         memory_claim_correction_id, user_id, request_event_revision_id,
         target_claim_id, deactivated_claim_version_id, target_scope,
         corrected_fact_recorded, correction_policy_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'whole_claim', $6, $7, $8)`,
      [
        createUuidV7(now),
        input.userId,
        input.requestEventRevisionId,
        claimId,
        currentVersionId,
        plan.correctedFactRecorded,
        MEMORY_CORRECTION_POLICY_VERSION,
        now,
      ],
    );

    if (plan.recordVeto) {
      // Impression correction: the user veto. Same-topic impressions
      // re-accumulate fresh cross-Session Evidence from zero (ADR-0039);
      // the old evidence chain is not reactivated.
      await executor.query(
        `INSERT INTO memory_impression_vetoes (
           memory_impression_veto_id, user_id, memory_claim_id,
           vetoed_claim_version_id, request_event_revision_id, status,
           impression_correction_policy_version, created_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)`,
        [
          createUuidV7(now),
          input.userId,
          claimId,
          currentVersionId,
          input.requestEventRevisionId,
          "impression-correction:v1",
          now,
        ],
      );
    }

    await executor.query(
      `UPDATE memory_claims SET current_version_id = $3
       WHERE user_id = $1 AND memory_claim_id = $2
         AND current_version_id IS NOT DISTINCT FROM $4`,
      [input.userId, claimId, supersededVersionId, currentVersionId],
    );

    // #115: a corrected claim stops projecting Resolver Hints entirely —
    // its current version is no longer an active relationship state.
    await executor.query(
      `DELETE FROM relationship_resolver_hints
       WHERE user_id = $1 AND memory_claim_id = $2`,
      [input.userId, claimId],
    );
    // #116: the retrieval projection goes stale with the same fence — the
    // corrected content never reappears through retrieval (SPEC AC 29).
    await executor.query(
      `UPDATE claim_retrieval_projections SET status = 'stale'
       WHERE user_id = $1 AND memory_claim_id = $2 AND status = 'active'`,
      [input.userId, claimId],
    );

    // The async follow-up joins the same admission transaction as an
    // idempotent workflow command + outbox event (ADR-0066 / ADR-0099): the
    // visible reply claims only the synchronous part (SPEC story 45). The
    // command identity anchors on the deactivated version's revision, so a
    // repeated correction of a NEWER version is a new command while replays
    // of this one converge.
    const dataEpoch = await executor.query<{ data_epoch: string }>(
      `SELECT data_epoch::text AS data_epoch FROM app_users WHERE user_id = $1`,
      [input.userId],
    );
    const workflowCommandId = createUuidV7(now);
    await executor.query(
      `INSERT INTO workflow_commands (
         workflow_command_id, command_type, subject_type, subject_id,
         source_revision, policy_version, expected_data_epoch,
         action_execution_id, status, created_at
       ) VALUES ($1, 'memory_correction_followup', 'memory_claim', $2,
         $3, $4, $5, $6, 'created', $7)`,
      [
        workflowCommandId,
        claimId,
        snapshot.currentVersion?.revision ?? 0,
        MEMORY_CORRECTION_FOLLOWUP_POLICY_VERSION,
        Number(dataEpoch.rows[0]!.data_epoch),
        input.actionExecutionId,
        now,
      ],
    );
    await executor.query(
      `INSERT INTO outbox_events (
         outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
         aggregate_revision, event_type, status, next_attempt_at,
         attempt_count, payload, created_at
       ) VALUES ($1, $2, 'memory_claim', $3, $4,
         'memory_correction_followup_requested', 'pending', $5, 0, $6::jsonb,
         $5)`,
      [
        createUuidV7(now),
        workflowCommandId,
        claimId,
        snapshot.currentVersion?.revision ?? 0,
        now,
        JSON.stringify({
          actionExecutionId: input.actionExecutionId,
          eventType: "memory_correction_followup_requested",
          policyVersion: MEMORY_CORRECTION_FOLLOWUP_POLICY_VERSION,
          status: "pending",
          subjectId: claimId,
          workflowCommandId,
        }),
      ],
    );
  }

  public async executeMemoryForgetRequestPlan(
    executor: ConversationActionTransactionExecutor,
    input: {
      actionExecutionId: string;
      requestEventRevisionId: string;
      target: ResolvedTrustActionTarget;
      userId: string;
    },
  ): Promise<string> {
    const claim = await executor.query<{
      current_version_id: string | null;
      predicate_id: string;
    }>(
      `SELECT current_version_id, predicate_id
       FROM memory_claims
       WHERE user_id = $1 AND memory_claim_id = $2
         AND deleted_at IS NULL AND content_purged_at IS NULL
       FOR UPDATE`,
      [input.userId, input.target.claimId],
    );
    const currentVersionId = claim.rows[0]?.current_version_id;
    if (!currentVersionId) {
      throw new Error(`Claim ${input.target.claimId} has no current version.`);
    }
    if (currentVersionId !== input.target.claimVersionId) {
      throw new Error(
        `Resolved target ${input.target.claimId} advanced before Forget admission.`,
      );
    }
    const current = await loadActionVersion(executor, input.userId, currentVersionId);
    if (!current) {
      throw new Error(`Claim version ${currentVersionId} does not exist.`);
    }
    const now = new Date();

    if (input.target.targetKind === "memory_claim") {
      const plan = planMemoryForgetRequest({
        targetKind: "memory_claim",
        currentVersionStatus: current.status,
      });
      if (plan.action === "noop_already_fenced") return "succeeded_noop";
      await applyWholeForgetWithin(executor, {
        actionExecutionId: input.actionExecutionId,
        claimId: input.target.claimId,
        current,
        requestEventRevisionId: input.requestEventRevisionId,
        userId: input.userId,
        now,
      });
      return "committed_in_transaction";
    }

    const qualifierId = input.target.qualifierId;
    if (!qualifierId) {
      throw new Error("A relationship qualifier target requires its qualifier id.");
    }
    const qualifier = await loadQualifier(
      executor,
      input.userId,
      qualifierId,
      currentVersionId,
      input.target.claimId,
    );
    const plan = planMemoryForgetRequest({
      targetKind: "relationship_qualifier",
      currentVersionStatus: current.status,
      targetQualifierPresent: qualifier !== null,
    });
    if (plan.action === "noop_already_fenced") return "succeeded_noop";
    if (!qualifier) {
      throw new Error(`Qualifier ${qualifierId} is not on the resolved current version.`);
    }
    await applyQualifierForgetWithin(executor, {
      actionExecutionId: input.actionExecutionId,
      claimId: input.target.claimId,
      current,
      currentQualifier: qualifier,
      predicateId: claim.rows[0]!.predicate_id,
      requestEventRevisionId: input.requestEventRevisionId,
      userId: input.userId,
      now,
      ...(this.projectionProvider === undefined
        ? {}
        : { provider: this.projectionProvider }),
    });
    return "committed_in_transaction";
  }

  public async executeMemoryForgetReversalPlan(
    executor: ConversationActionTransactionExecutor,
    input: {
      actionExecutionId: string;
      requestEventRevisionId: string;
      target: ResolvedTrustActionTarget;
      userId: string;
    },
  ): Promise<string> {
    const claim = await executor.query<{
      current_version_id: string | null;
      predicate_id: string;
    }>(
      `SELECT current_version_id, predicate_id
       FROM memory_claims
       WHERE user_id = $1 AND memory_claim_id = $2
         AND deleted_at IS NULL AND content_purged_at IS NULL
       FOR UPDATE`,
      [input.userId, input.target.claimId],
    );
    const currentVersionId = claim.rows[0]?.current_version_id;
    if (!currentVersionId) return "reversal_precondition_failed";
    if (currentVersionId !== input.target.claimVersionId) {
      return "reversal_precondition_failed";
    }
    const current = await loadActionVersion(executor, input.userId, currentVersionId);
    if (!current) return "reversal_precondition_failed";
    const targetQualifier = input.target.qualifierId
      ? await loadQualifier(
          executor,
          input.userId,
          input.target.qualifierId,
          null,
          input.target.claimId,
        )
      : null;
    if (
      input.target.targetKind === "relationship_qualifier" &&
      targetQualifier === null
    ) {
      return "reversal_precondition_failed";
    }
    const fence = await findActiveForgetFence(executor, {
      claimId: input.target.claimId,
      qualifierId: input.target.qualifierId ?? null,
      targetKind: input.target.targetKind,
      userId: input.userId,
    });
    const plan = planMemoryForgetReversal({ fencePresent: fence !== null });
    if (plan.action === "precondition_failed" || !fence) {
      return "reversal_precondition_failed";
    }

    const now = new Date();
    const reversalEvidenceId = await insertReversalEvidenceWithin(executor, {
      actionExecutionId: input.actionExecutionId,
      requestEventRevisionId: input.requestEventRevisionId,
      userId: input.userId,
      now,
    });
    const predecessor =
      current.supersedes_version_id === null
        ? null
        : await loadActionVersion(
            executor,
            input.userId,
            current.supersedes_version_id,
          );
    const sourceVersion =
      input.target.targetKind === "memory_claim" && predecessor
        ? predecessor
        : current;
    const sourceVersionId = sourceVersion.version_id;
    const sourceQualifiers = await listActionQualifiers(
      executor,
      input.userId,
      sourceVersionId,
    );
    const revision = await nextActionClaimRevision(
      executor,
      input.target.claimId,
    );
    const versionId = asMemoryClaimVersionId(createUuidV7(now));
    await insertActionClaimVersion(executor, {
      claimId: input.target.claimId,
      current,
      createdBy: "forget_reversal",
      kind: sourceVersion.kind,
      revision,
      status: "active",
      supersedesVersionId: current.version_id,
      userId: input.userId,
      versionId,
      now,
    });

    if (input.target.targetKind === "relationship_qualifier") {
      const baseLinks = await listBaseEvidenceLinks(
        executor,
        input.userId,
        sourceVersionId,
      );
      await insertActionEvidenceLinks(executor, {
        links: [...baseLinks, { evidence_item_id: reversalEvidenceId, link_role: "support" }],
        userId: input.userId,
        versionId,
        now,
      });
    } else {
      await insertActionEvidenceLinks(executor, {
        links: [{ evidence_item_id: reversalEvidenceId, link_role: "support" }],
        userId: input.userId,
        versionId,
        now,
      });
    }

    const copiedQualifierKeys = new Set<string>();
    for (const qualifier of sourceQualifiers) {
      const key = `${qualifier.axis_id}:${qualifier.role_side}`;
      const isTarget =
        input.target.targetKind === "relationship_qualifier" &&
        (qualifier.memory_claim_version_qualifier_id === input.target.qualifierId ||
          (targetQualifier !== null &&
            qualifier.axis_id === targetQualifier.axis_id &&
            qualifier.role_side === targetQualifier.role_side));
      if (isTarget) continue;
      copiedQualifierKeys.add(key);
      await insertActionQualifier(executor, {
        qualifier,
        evidenceItemIds:
          input.target.targetKind === "memory_claim"
            ? [reversalEvidenceId]
            : qualifier.evidence_item_ids,
        userId: input.userId,
        versionId,
        now,
      });
    }
    if (input.target.targetKind === "relationship_qualifier") {
      const qualifier = targetQualifier;
      if (!qualifier) {
        return "reversal_precondition_failed";
      }
      const key = `${qualifier.axis_id}:${qualifier.role_side}`;
      if (!copiedQualifierKeys.has(key)) {
        await insertActionQualifier(executor, {
          qualifier,
          evidenceItemIds: [reversalEvidenceId],
          userId: input.userId,
          versionId,
          now,
        });
      }
    }

    await executor.query(
      `INSERT INTO memory_forget_reversals (
         memory_forget_reversal_id, user_id, memory_forget_request_id,
         request_event_revision_id, reversal_evidence_id, status,
         applied_claim_version_id, forget_policy_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)`,
      [
        asMemoryForgetReversalId(createUuidV7(now)),
        input.userId,
        fence.request_id,
        input.requestEventRevisionId,
        reversalEvidenceId,
        versionId,
        "memory-forget-reversal:v1",
        now,
      ],
    );
    const moved = await executor.query(
      `UPDATE memory_claims SET current_version_id = $3
       WHERE user_id = $1 AND memory_claim_id = $2
         AND current_version_id IS NOT DISTINCT FROM $4`,
      [input.userId, input.target.claimId, versionId, current.version_id],
    );
    if (moved.rowCount !== 1) {
      throw new Error(`Forget Reversal CAS failed for claim ${input.target.claimId}.`);
    }
    await refreshActionProjections(executor, {
      claimId: input.target.claimId,
      predicateId: claim.rows[0]!.predicate_id,
      userId: input.userId,
      now,
      fence: false,
      ...(this.projectionProvider === undefined
        ? {}
        : { provider: this.projectionProvider }),
    });
    return "committed_in_transaction";
  }

  public async loadExplainEvidenceVerdict(
    executor: ConversationActionTransactionExecutor,
    input: { claimId: string; userId: string },
  ): Promise<ExplainMemorySourceVerdict> {
    const version = await executor.query<{ kind: string }>(
      `SELECT v.kind
       FROM memory_claims c
       JOIN memory_claim_versions v
         ON v.memory_claim_version_id = c.current_version_id
       WHERE c.user_id = $1 AND c.memory_claim_id = $2`,
      [input.userId, input.claimId],
    );
    const claimKind = version.rows[0]?.kind;
    if (claimKind !== "objective" && claimKind !== "impression") {
      return { verdict: "unverifiable" };
    }
    const items = await loadVerifiedExplainEvidenceItems(
      executor,
      input.userId,
      input.claimId,
    );
    if (items.length === 0) {
      return { verdict: "unverifiable" };
    }
    return { claimKind, items, verdict: "verified" };
  }
}

type ActionVersionRow = Readonly<{
  version_id: string;
  claim_id: string;
  revision: number;
  kind: "objective" | "impression";
  epistemic_status: "confirmed" | "inferred" | "contested";
  status:
    | "active"
    | "review_due"
    | "dormant"
    | "superseded"
    | "retracted";
  subject_entity_version_id: string;
  object_entity_version_id: string | null;
  typed_value: unknown;
  temporal_status: string;
  valid_from: Date | null;
  valid_from_precision: string;
  valid_to: Date | null;
  valid_to_precision: string;
  last_observed_at: Date;
  supersedes_version_id: string | null;
  predicate_registry_version: number;
}>;

type ActionQualifierRow = Readonly<{
  memory_claim_version_qualifier_id: string;
  memory_claim_version_id: string;
  axis_id: string;
  role_side: "canonical_subject" | "counterpart";
  typed_value: unknown;
  evidence_item_ids: string[];
}>;

async function loadActionVersion(
  executor: ConversationActionTransactionExecutor,
  userId: string,
  versionId: string,
): Promise<ActionVersionRow | null> {
  const result = await executor.query<ActionVersionRow>(
    `SELECT memory_claim_version_id::text AS version_id,
            memory_claim_id::text AS claim_id, revision, kind,
            epistemic_status, status, subject_entity_version_id::text,
            object_entity_version_id::text, typed_value, temporal_status,
            valid_from, valid_from_precision, valid_to, valid_to_precision,
            last_observed_at, supersedes_version_id::text,
            predicate_registry_version
     FROM memory_claim_versions
     WHERE user_id = $1 AND memory_claim_version_id = $2`,
    [userId, versionId],
  );
  return result.rows[0] ?? null;
}

async function nextActionClaimRevision(
  executor: ConversationActionTransactionExecutor,
  claimId: string,
): Promise<number> {
  const result = await executor.query<{ next_revision: number }>(
    `SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision
     FROM memory_claim_versions WHERE memory_claim_id = $1`,
    [claimId],
  );
  return result.rows[0]!.next_revision;
}

async function insertActionClaimVersion(
  executor: ConversationActionTransactionExecutor,
  input: {
    claimId: string;
    current: ActionVersionRow;
    createdBy: string;
    kind: "objective" | "impression";
    revision: number;
    status: ActionVersionRow["status"];
    supersedesVersionId: string;
    userId: string;
    versionId: string;
    now: Date;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO memory_claim_versions (
       memory_claim_version_id, memory_claim_id, user_id,
       revision, kind, epistemic_status, status, subject_entity_version_id,
       object_entity_version_id, typed_value, confidence, temporal_status,
       valid_from, valid_from_precision, valid_to, valid_to_precision,
       last_observed_at, supersedes_version_id, created_by, model_version,
       prompt_version, predicate_registry_version, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NULL,
       $11, $12, $13, $14, $15, $16, $17, $18, NULL, NULL, $19, $20)`,
    [
      input.versionId,
      input.claimId,
      input.userId,
      input.revision,
      input.kind,
      input.current.epistemic_status,
      input.status,
      input.current.subject_entity_version_id,
      input.current.object_entity_version_id,
      JSON.stringify(toTypedValue(input.current.typed_value)),
      input.current.temporal_status,
      input.current.valid_from,
      input.current.valid_from_precision,
      input.current.valid_to,
      input.current.valid_to_precision,
      input.now,
      input.supersedesVersionId,
      input.createdBy,
      input.current.predicate_registry_version,
      input.now,
    ],
  );
}

async function loadQualifier(
  executor: ConversationActionTransactionExecutor,
  userId: string,
  qualifierId: string,
  versionId: string | null,
  claimId: string,
): Promise<ActionQualifierRow | null> {
  const result = await executor.query<ActionQualifierRow>(
    `SELECT q.memory_claim_version_qualifier_id::text,
            q.memory_claim_version_id::text, q.axis_id, q.role_side,
            q.typed_value,
            ARRAY(
              SELECT evidence_item_id::text
              FROM memory_claim_version_qualifier_evidence evidence
              WHERE evidence.memory_claim_version_qualifier_id =
                q.memory_claim_version_qualifier_id
              ORDER BY evidence_item_id
            ) AS evidence_item_ids
     FROM memory_claim_version_qualifiers q
     INNER JOIN memory_claim_versions version
       ON version.memory_claim_version_id = q.memory_claim_version_id
      AND version.user_id = q.user_id
      WHERE q.user_id = $1
       AND q.memory_claim_version_qualifier_id = $2
       AND ($3::uuid IS NULL OR q.memory_claim_version_id = $3)
       AND version.memory_claim_id = $4
       AND q.content_purged_at IS NULL`,
    [userId, qualifierId, versionId, claimId],
  );
  return result.rows[0] ?? null;
}

async function listActionQualifiers(
  executor: ConversationActionTransactionExecutor,
  userId: string,
  versionId: string,
): Promise<readonly ActionQualifierRow[]> {
  const result = await executor.query<ActionQualifierRow>(
    `SELECT q.memory_claim_version_qualifier_id::text,
            q.memory_claim_version_id::text, q.axis_id, q.role_side,
            q.typed_value,
            ARRAY(
              SELECT evidence_item_id::text
              FROM memory_claim_version_qualifier_evidence evidence
              WHERE evidence.memory_claim_version_qualifier_id =
                q.memory_claim_version_qualifier_id
              ORDER BY evidence_item_id
            ) AS evidence_item_ids
     FROM memory_claim_version_qualifiers q
     WHERE q.user_id = $1 AND q.memory_claim_version_id = $2
       AND q.content_purged_at IS NULL
     ORDER BY q.axis_id, q.role_side`,
    [userId, versionId],
  );
  return result.rows;
}

async function insertActionQualifier(
  executor: ConversationActionTransactionExecutor,
  input: {
    qualifier: ActionQualifierRow;
    evidenceItemIds: readonly string[];
    userId: string;
    versionId: string;
    now: Date;
  },
): Promise<void> {
  const qualifierId = asMemoryClaimVersionQualifierId(createUuidV7(input.now));
  await executor.query(
    `INSERT INTO memory_claim_version_qualifiers (
       memory_claim_version_qualifier_id, memory_claim_version_id, user_id,
       axis_id, role_side, typed_value, created_by, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      qualifierId,
      input.versionId,
      input.userId,
      input.qualifier.axis_id,
      input.qualifier.role_side,
      JSON.stringify(input.qualifier.typed_value),
      "forget_action",
      input.now,
    ],
  );
  for (const evidenceItemId of input.evidenceItemIds) {
    await executor.query(
      `INSERT INTO memory_claim_version_qualifier_evidence (
         memory_claim_version_qualifier_evidence_id,
         memory_claim_version_qualifier_id, user_id, evidence_item_id, created_at
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [createUuidV7(input.now), qualifierId, input.userId, evidenceItemId, input.now],
    );
  }
}

async function listBaseEvidenceLinks(
  executor: ConversationActionTransactionExecutor,
  userId: string,
  versionId: string,
  excludedEvidenceItemIds: readonly string[] = [],
): Promise<readonly { evidence_item_id: string; link_role: "support" | "counter" | "subjective_report" | "context" }[]> {
  const result = await executor.query<{
    evidence_item_id: string;
    link_role: "support" | "counter" | "subjective_report" | "context";
  }>(
    `SELECT link.evidence_item_id::text, link.link_role
     FROM claim_evidence_links link
     WHERE link.user_id = $1 AND link.memory_claim_version_id = $2
       AND link.status = 'active'
       AND NOT EXISTS (
         SELECT 1
         FROM memory_forget_evidence_exclusions exclusion
         WHERE exclusion.user_id = link.user_id
           AND exclusion.evidence_item_id = link.evidence_item_id
           AND exclusion.status = 'active'
           AND exclusion.exclusion_scope = 'whole_claim'
       )
     ORDER BY link.evidence_item_id, link.link_role`,
    [userId, versionId],
  );
  const excluded = new Set(excludedEvidenceItemIds);
  return result.rows.filter((row) => !excluded.has(row.evidence_item_id));
}

async function insertActionEvidenceLinks(
  executor: ConversationActionTransactionExecutor,
  input: {
    links: readonly { evidence_item_id: string; link_role: string }[];
    userId: string;
    versionId: string;
    now: Date;
  },
): Promise<void> {
  for (const link of input.links) {
    await executor.query(
      `INSERT INTO claim_evidence_links (
         claim_evidence_link_id, memory_claim_version_id, user_id,
         evidence_item_id, link_role, status, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6)
       ON CONFLICT DO NOTHING`,
      [
        asClaimEvidenceLinkId(createUuidV7(input.now)),
        input.versionId,
        input.userId,
        link.evidence_item_id,
        link.link_role,
        input.now,
      ],
    );
  }
}

async function applyWholeForgetWithin(
  executor: ConversationActionTransactionExecutor,
  input: {
    actionExecutionId: string;
    claimId: string;
    current: ActionVersionRow;
    requestEventRevisionId: string;
    userId: string;
    now: Date;
  },
): Promise<void> {
  const versionId = asMemoryClaimVersionId(createUuidV7(input.now));
  const revision = await nextActionClaimRevision(executor, input.claimId);
  await insertActionClaimVersion(executor, {
    claimId: input.claimId,
    current: input.current,
    createdBy: "forget_request",
    kind: input.current.kind,
    revision,
    status: "retracted",
    supersedesVersionId: input.current.version_id,
    userId: input.userId,
    versionId,
    now: input.now,
  });
  const evidence = await executor.query<{ evidence_item_id: string }>(
    `SELECT DISTINCT link.evidence_item_id::text
     FROM claim_evidence_links link
     INNER JOIN memory_claim_versions version
       ON version.memory_claim_version_id = link.memory_claim_version_id
      AND version.user_id = link.user_id
     WHERE link.user_id = $1 AND version.memory_claim_id = $2`,
    [input.userId, input.claimId],
  );
  const requestId = asMemoryForgetRequestId(createUuidV7(input.now));
  await executor.query(
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
      versionId,
      "memory-forget:v1",
      input.now,
    ],
  );
  for (const row of evidence.rows) {
    await executor.query(
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
  const moved = await executor.query(
    `UPDATE memory_claims SET current_version_id = $3
     WHERE user_id = $1 AND memory_claim_id = $2
       AND current_version_id IS NOT DISTINCT FROM $4`,
    [input.userId, input.claimId, versionId, input.current.version_id],
  );
  if (moved.rowCount !== 1) {
    throw new Error(`Forget CAS failed for claim ${input.claimId}.`);
  }
  await executor.query(
    `DELETE FROM relationship_resolver_hints
     WHERE user_id = $1 AND memory_claim_id = $2`,
    [input.userId, input.claimId],
  );
  await executor.query(
    `UPDATE claim_retrieval_projections SET status = 'deleted'
     WHERE user_id = $1 AND memory_claim_id = $2 AND status <> 'deleted'`,
    [input.userId, input.claimId],
  );
}

async function applyQualifierForgetWithin(
  executor: ConversationActionTransactionExecutor,
  input: {
    actionExecutionId: string;
    claimId: string;
    current: ActionVersionRow;
    currentQualifier: ActionQualifierRow;
    predicateId: string;
    requestEventRevisionId: string;
    userId: string;
    now: Date;
    provider?: MemoryTrustActionProjectionProvider;
  },
): Promise<void> {
  const historicalQualifierEvidence = await executor.query<{
    evidence_item_id: string;
  }>(
    `SELECT DISTINCT evidence.evidence_item_id::text AS evidence_item_id
       FROM memory_claim_version_qualifier_evidence evidence
       INNER JOIN memory_claim_version_qualifiers qualifier
         ON qualifier.memory_claim_version_qualifier_id =
              evidence.memory_claim_version_qualifier_id
        AND qualifier.user_id = evidence.user_id
       INNER JOIN memory_claim_versions version
         ON version.memory_claim_version_id = qualifier.memory_claim_version_id
        AND version.user_id = qualifier.user_id
      WHERE evidence.user_id = $1
        AND version.memory_claim_id = $2
        AND qualifier.content_purged_at IS NULL
        AND qualifier.axis_id = $3
        AND qualifier.role_side = $4
      ORDER BY 1`,
    [
      input.userId,
      input.claimId,
      input.currentQualifier.axis_id,
      input.currentQualifier.role_side,
    ],
  );
  const excludedQualifierEvidenceItemIds = historicalQualifierEvidence.rows.map(
    (row) => row.evidence_item_id,
  );
  const baseLinks = await listBaseEvidenceLinks(
    executor,
    input.userId,
    input.current.version_id,
    excludedQualifierEvidenceItemIds,
  );
  const versionId = asMemoryClaimVersionId(createUuidV7(input.now));
  const revision = await nextActionClaimRevision(executor, input.claimId);
  const nextStatus: ActionVersionRow["status"] =
    baseLinks.length === 0 ? "retracted" : input.current.status;
  await insertActionClaimVersion(executor, {
    claimId: input.claimId,
    current: input.current,
    createdBy: "forget_request",
    kind: input.current.kind,
    revision,
    status: nextStatus,
    supersedesVersionId: input.current.version_id,
    userId: input.userId,
    versionId,
    now: input.now,
  });
  await insertActionEvidenceLinks(executor, {
    links: baseLinks,
    userId: input.userId,
    versionId,
    now: input.now,
  });
  for (const qualifier of await listActionQualifiers(
    executor,
    input.userId,
    input.current.version_id,
  )) {
    if (
      qualifier.memory_claim_version_qualifier_id ===
      input.currentQualifier.memory_claim_version_qualifier_id
    ) {
      continue;
    }
    await insertActionQualifier(executor, {
      qualifier,
      evidenceItemIds: qualifier.evidence_item_ids,
      userId: input.userId,
      versionId,
      now: input.now,
    });
  }
  const requestId = asMemoryForgetRequestId(createUuidV7(input.now));
  await executor.query(
    `INSERT INTO memory_forget_requests (
       memory_forget_request_id, user_id, request_event_revision_id,
       target_claim_id, target_scope, canonical_side, qualifier_key,
       qualifier_typed_value, status, applied_claim_version_id,
       forget_policy_version, target_qualifier_id, created_at
     ) VALUES ($1, $2, $3, $4, 'relationship_qualifier', $5, $6, $7::jsonb,
       'applied', $8, $9, $10, $11)`,
    [
      requestId,
      input.userId,
      input.requestEventRevisionId,
      input.claimId,
      input.currentQualifier.role_side,
      input.currentQualifier.axis_id,
      JSON.stringify(toTypedValue(input.currentQualifier.typed_value)),
      versionId,
      "memory-forget:v1",
      input.currentQualifier.memory_claim_version_qualifier_id,
      input.now,
    ],
  );
  for (const evidenceItemId of excludedQualifierEvidenceItemIds) {
    await executor.query(
      `INSERT INTO memory_forget_evidence_exclusions (
         memory_forget_evidence_exclusion_id, user_id,
         memory_forget_request_id, evidence_item_id, exclusion_scope,
         canonical_side, qualifier_key, status, created_at
       ) VALUES ($1, $2, $3, $4, 'relationship_qualifier', $5, $6,
         'active', $7)
       ON CONFLICT DO NOTHING`,
      [
        asMemoryForgetEvidenceExclusionId(createUuidV7(input.now)),
        input.userId,
        requestId,
        evidenceItemId,
        input.currentQualifier.role_side,
        input.currentQualifier.axis_id,
        input.now,
      ],
    );
  }
  const moved = await executor.query(
    `UPDATE memory_claims SET current_version_id = $3
     WHERE user_id = $1 AND memory_claim_id = $2
       AND current_version_id IS NOT DISTINCT FROM $4`,
    [input.userId, input.claimId, versionId, input.current.version_id],
  );
  if (moved.rowCount !== 1) {
    throw new Error(`Qualifier Forget CAS failed for claim ${input.claimId}.`);
  }
  await refreshActionProjections(executor, {
    claimId: input.claimId,
    predicateId: input.predicateId,
    userId: input.userId,
    now: input.now,
    fence: nextStatus === "retracted",
    ...(input.provider === undefined ? {} : { provider: input.provider }),
  });
}

async function findActiveForgetFence(
  executor: ConversationActionTransactionExecutor,
  input: {
    claimId: string;
    qualifierId: string | null;
    targetKind: "memory_claim" | "relationship_qualifier";
    userId: string;
  },
): Promise<{ request_id: string; applied_version_id: string } | null> {
  const result = await executor.query<{
    request_id: string;
    applied_version_id: string;
  }>(
    `SELECT request.memory_forget_request_id::text AS request_id,
            request.applied_claim_version_id::text AS applied_version_id
     FROM memory_forget_requests request
     WHERE request.user_id = $1
       AND request.target_claim_id = $2
       AND request.target_scope = $3
       AND request.status = 'applied'
       AND ($4::uuid IS NULL OR request.target_qualifier_id = $4)
       AND (
         request.target_scope = 'whole_claim'
         OR NOT EXISTS (
           SELECT 1
           FROM memory_forget_requests whole_fence
           WHERE whole_fence.user_id = request.user_id
             AND whole_fence.target_claim_id = request.target_claim_id
             AND whole_fence.target_scope = 'whole_claim'
             AND whole_fence.status = 'applied'
             AND NOT EXISTS (
               SELECT 1
               FROM memory_forget_reversals whole_reversal
               WHERE whole_reversal.user_id = whole_fence.user_id
                 AND whole_reversal.memory_forget_request_id =
                       whole_fence.memory_forget_request_id
                 AND whole_reversal.status = 'active'
             )
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM memory_forget_reversals reversal
         WHERE reversal.user_id = request.user_id
           AND reversal.memory_forget_request_id = request.memory_forget_request_id
           AND reversal.status = 'active'
       )
     ORDER BY request.created_at DESC
     LIMIT 1`,
    [
      input.userId,
      input.claimId,
      input.targetKind === "memory_claim"
        ? "whole_claim"
        : "relationship_qualifier",
      input.qualifierId,
    ],
  );
  return result.rows[0] ?? null;
}

async function insertReversalEvidenceWithin(
  executor: ConversationActionTransactionExecutor,
  input: {
    actionExecutionId: string;
    requestEventRevisionId: string;
    userId: string;
    now: Date;
  },
): Promise<string> {
  const source = await executor.query<{
    conversation_event_id: string;
    daily_session_id: string;
    sequence_no: string;
    transcript_status: "final" | "corrected";
  }>(
    `SELECT event.conversation_event_id::text,
            event.daily_session_id::text, event.sequence_no::text,
            revision.transcript_status
     FROM conversation_event_revisions revision
     INNER JOIN conversation_events event
       ON event.conversation_event_id = revision.conversation_event_id
      AND event.user_id = revision.user_id
     WHERE revision.user_id = $1
       AND revision.conversation_event_revision_id = $2
       AND revision.content_purged_at IS NULL
       AND event.current_revision_id = revision.conversation_event_revision_id
       AND event.actor = 'user'
       AND event.lifecycle_status = 'active'`,
    [input.userId, input.requestEventRevisionId],
  );
  const sourceRow = source.rows[0];
  if (!sourceRow || !["final", "corrected"].includes(sourceRow.transcript_status)) {
    throw new Error("Forget Reversal requires a final user Event Revision.");
  }
  const extractionPolicyVersion = "memory-forget-reversal:v1";
  const snapshotId = createUuidV7(input.now);
  await executor.query(
    `INSERT INTO evidence_source_snapshots (
       evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
       extraction_policy_version, command_id, attempt_id,
       champion_config_version, champion_provider, champion_model,
       champion_snapshot, champion_provider_policy_version, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'openai', 'memory-control',
       'memory-control', 'memory-control:v1', $8)
     ON CONFLICT (daily_session_id, source_revision, extraction_policy_version)
     DO NOTHING`,
    [
      snapshotId,
      input.userId,
      sourceRow.daily_session_id,
      Number(sourceRow.sequence_no),
      extractionPolicyVersion,
      input.actionExecutionId,
      input.actionExecutionId,
      input.now,
    ],
  );
  const snapshot = await executor.query<{ evidence_source_snapshot_id: string }>(
    `SELECT evidence_source_snapshot_id::text
     FROM evidence_source_snapshots
     WHERE user_id = $1 AND daily_session_id = $2
       AND source_revision = $3 AND extraction_policy_version = $4`,
    [
      input.userId,
      sourceRow.daily_session_id,
      Number(sourceRow.sequence_no),
      extractionPolicyVersion,
    ],
  );
  const resolvedSnapshotId = snapshot.rows[0]?.evidence_source_snapshot_id;
  if (!resolvedSnapshotId) throw new Error("Reversal Evidence snapshot was not created.");
  const locatorKey = `memory-forget-reversal:${input.actionExecutionId}`;
  const evidenceId = createUuidV7(input.now);
  await executor.query(
    `INSERT INTO evidence_items (
       evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
       source_revision_id, source_actor, source_status, locator_type, locator_key,
       extraction_policy_version, evidence_role, created_at
     ) VALUES ($1, $2, $3, $4, $5, 'user', $6, 'whole_revision', $7, $8,
       'factual_support', $9)
     ON CONFLICT (user_id, source_revision_id, locator_key,
                  extraction_policy_version) DO NOTHING`,
    [
      evidenceId,
      input.userId,
      resolvedSnapshotId,
      sourceRow.conversation_event_id,
      input.requestEventRevisionId,
      sourceRow.transcript_status,
      locatorKey,
      extractionPolicyVersion,
      input.now,
    ],
  );
  const resolvedEvidence = await executor.query<{ evidence_item_id: string }>(
    `SELECT evidence_item_id::text FROM evidence_items
     WHERE user_id = $1 AND source_revision_id = $2 AND locator_key = $3
       AND extraction_policy_version = $4`,
    [input.userId, input.requestEventRevisionId, locatorKey, extractionPolicyVersion],
  );
  const resolvedEvidenceId = resolvedEvidence.rows[0]?.evidence_item_id;
  if (!resolvedEvidenceId) throw new Error("Reversal Evidence item was not created.");
  await executor.query(
    `INSERT INTO evidence_lineage (evidence_item_id, command_id, attempt_id, created_at)
     VALUES ($1, $2, $2, $3)
     ON CONFLICT (evidence_item_id) DO NOTHING`,
    [resolvedEvidenceId, input.actionExecutionId, input.now],
  );
  return resolvedEvidenceId;
}

async function refreshActionProjections(
  executor: ConversationActionTransactionExecutor,
  input: {
    claimId: string;
    predicateId: string;
    userId: string;
    now: Date;
    fence: boolean;
    provider?: MemoryTrustActionProjectionProvider;
  },
): Promise<void> {
  await executor.query(
    `DELETE FROM relationship_resolver_hints
     WHERE user_id = $1 AND memory_claim_id = $2`,
    [input.userId, input.claimId],
  );
  await markClaimRetrievalProjectionsStaleWithin(
    executor as unknown as PoolClient,
    asUserId(input.userId),
    asMemoryClaimId(input.claimId),
  );
  if (input.fence) {
    await executor.query(
      `UPDATE claim_retrieval_projections SET status = 'deleted'
       WHERE user_id = $1 AND memory_claim_id = $2 AND status <> 'deleted'`,
      [input.userId, input.claimId],
    );
    return;
  }
  const hints = input.provider?.relationshipHintsFor(input.predicateId);
  if (hints) {
    await rebuildRelationshipResolverHintsWithin(
      executor as unknown as PoolClient,
      {
        userId: asUserId(input.userId),
        claimId: asMemoryClaimId(input.claimId),
        hints,
        now: input.now,
      },
    );
  }
  const retrieval = input.provider?.retrievalProjectionFor(input.predicateId);
  if (retrieval) {
    await rebuildClaimRetrievalProjectionsWithin(
      executor as unknown as PoolClient,
      {
        userId: asUserId(input.userId),
        claimId: asMemoryClaimId(input.claimId),
        material: retrieval,
        now: input.now,
      },
    );
  }
}

/**
 * The verified evidence snapshot for one claim's CURRENT version (ADR-0008):
 * the same validity rules the fence loader applies — active support /
 * subjective-report links onto active Evidence whose source expands to a
 * live final / corrected User Event Revision, minus Forget exclusions.
 * Shared by the commit port and the finalization receipt snapshot loaders.
 */
export async function loadVerifiedExplainEvidenceItems(
  client: { query: ConversationActionTransactionExecutor["query"] },
  userId: string,
  claimId: string,
): Promise<
  readonly Readonly<{ occurredOn: string; quote: string }>[]
> {
  const evidence = await client.query<{
    canonical_text: string;
    logical_date: string;
  }>(
    `SELECT revision.canonical_text,
            session.logical_date::text AS logical_date
     FROM claim_evidence_links link
     INNER JOIN evidence_items item
       ON item.evidence_item_id = link.evidence_item_id
      AND item.user_id = link.user_id
     INNER JOIN conversation_event_revisions revision
       ON revision.conversation_event_revision_id = item.source_revision_id
      AND revision.user_id = item.user_id
     INNER JOIN conversation_events event
       ON event.conversation_event_id = revision.conversation_event_id
      AND event.user_id = revision.user_id
     INNER JOIN daily_sessions session
       ON session.daily_session_id = event.daily_session_id
      AND session.user_id = event.user_id
     WHERE link.user_id = $1
       AND link.memory_claim_version_id = (
         SELECT c.current_version_id FROM memory_claims c
         WHERE c.user_id = $1 AND c.memory_claim_id = $2
       )
       AND link.status = 'active'
       AND link.link_role IN ('support', 'subjective_report')
       AND item.status = 'active'
       AND item.source_actor = 'user'
       AND item.source_status IN ('final', 'corrected')
       AND revision.content_purged_at IS NULL
       AND revision.transcript_status IN ('final', 'corrected')
       AND event.lifecycle_status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM memory_forget_evidence_exclusions exclusion
        WHERE exclusion.user_id = link.user_id
          AND exclusion.evidence_item_id = link.evidence_item_id
          AND exclusion.status = 'active'
          AND exclusion.exclusion_scope = 'whole_claim'
       )
     ORDER BY revision.created_at, revision.conversation_event_revision_id`,
    [userId, claimId],
  );
  return evidence.rows.map((row) => ({
    occurredOn: row.logical_date,
    quote: excerptUserWords(row.canonical_text),
  }));
}

/** Bounded user-words excerpt for the source explanation (ADR-0101 discipline). */
function excerptUserWords(canonicalText: string): string {
  const normalized = canonicalText.trim();
  if (normalized.length <= EXPLAIN_SOURCE_QUOTE_MAX_LENGTH) {
    return normalized;
  }
  return `${[...normalized]
    .slice(0, EXPLAIN_SOURCE_QUOTE_MAX_LENGTH)
    .join("")}…`;
}

function toTypedValue(value: unknown): string | readonly string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return String(value);
}

/**
 * Derive the frozen finalization receipt snapshot for one action execution
 * (issue #119). Both finalization-context loaders use this so the compile
 * and the Provider Egress replay derive byte-identical section content. The
 * trust detail carries the typed claim reference, the multi-hit candidate
 * count, and — for a verified source explanation — the bounded evidence
 * snapshot; a verified receipt whose evidence can no longer be derived falls
 * back to the unverifiable verdict (fail-closed to honesty, never to
 * fabrication).
 */
export async function loadActionFinalizationReceiptSnapshot(
  client: { query: ConversationActionTransactionExecutor["query"] },
  input: {
    actionExecutionId: string;
    admission: "accepted" | "clarification_required" | "rejected" | "unsupported";
    disposition: string | null;
    execution: "not_started" | "pending" | "running" | "succeeded" | "failed" | "canceled";
    receiptSequence: number;
  },
): Promise<ActionFinalizationReceiptSnapshot> {
  const execution = await client.query<{
    action_kind: string;
    target_kind: "journal" | "memory_claim" | "relationship_qualifier" | null;
    resolved_claim_id: string | null;
    resolved_claim_version_id: string | null;
    resolved_qualifier_id: string | null;
  }>(
    `SELECT action_kind, target_kind,
            resolved_claim_id::text AS resolved_claim_id,
            resolved_claim_version_id::text AS resolved_claim_version_id,
            resolved_qualifier_id::text AS resolved_qualifier_id
     FROM conversation_action_executions
     WHERE action_execution_id = $1`,
    [input.actionExecutionId],
  );
  const row = execution.rows[0];
  const actionKind = row?.action_kind ?? null;
  const claimId = row?.resolved_claim_id ?? null;
  const claimVersionId = row?.resolved_claim_version_id ?? null;
  const targetKind =
    row?.target_kind === "memory_claim" ||
    row?.target_kind === "relationship_qualifier"
      ? row.target_kind
      : null;
  const qualifierId = row?.resolved_qualifier_id ?? null;
  if (!actionKind || !TRUST_ACTION_KINDS.includes(actionKind)) {
    return {
      actionKind,
      admission: input.admission,
      disposition: input.disposition,
      execution: input.execution,
      sequence: input.receiptSequence,
      trustAction: null,
    };
  }
  let candidateCount: number | null = null;
  if (input.disposition === "target_ambiguous_multi_hit") {
    const detail = await client.query<{ disposition_detail: { candidateCount?: number } | null }>(
      `SELECT disposition_detail
       FROM conversation_action_receipts
       WHERE action_execution_id = $1 AND receipt_sequence = $2`,
      [input.actionExecutionId, input.receiptSequence],
    );
    candidateCount = detail.rows[0]?.disposition_detail?.candidateCount ?? null;
  }
  let claimKind: "objective" | "impression" | null = null;
  if (claimId !== null) {
    const kind = await client.query<{ kind: string }>(
      `SELECT v.kind
       FROM memory_claims c
       JOIN memory_claim_versions v
         ON v.memory_claim_version_id = c.current_version_id
       WHERE c.user_id = (SELECT user_id FROM conversation_action_executions
                          WHERE action_execution_id = $1)
         AND c.memory_claim_id = $2`,
      [input.actionExecutionId, claimId],
    );
    const kindRow = kind.rows[0]?.kind;
    claimKind =
      kindRow === "impression" || kindRow === "objective" ? kindRow : null;
  }
  let evidenceVerdict: "verified" | "unverifiable" | null = null;
  let evidenceItems: readonly Readonly<{ occurredOn: string; quote: string }>[] = [];
  if (
    actionKind === "explain_memory_source" &&
    claimId !== null &&
    input.execution === "succeeded"
  ) {
    if (input.disposition === "source_evidence_verified") {
      const userId = await client.query<{ user_id: string }>(
        `SELECT user_id::text AS user_id FROM conversation_action_executions
         WHERE action_execution_id = $1`,
        [input.actionExecutionId],
      );
      evidenceItems = await loadVerifiedExplainEvidenceItems(
        client,
        userId.rows[0]!.user_id,
        claimId,
      );
      evidenceVerdict = evidenceItems.length > 0 ? "verified" : "unverifiable";
    } else {
      evidenceVerdict = "unverifiable";
    }
  }
  return {
    actionKind,
    admission: input.admission,
    disposition: input.disposition,
    execution: input.execution,
    sequence: input.receiptSequence,
    trustAction: {
      candidateCount,
      claimId,
      claimKind,
      claimVersionId,
      qualifierId,
      targetKind,
      evidenceItems,
      evidenceVerdict,
    },
  };
}

/**
 * The bounded structured-lexical candidate source for admission-time target
 * resolution (ADR-0118). One owner-scoped query returns the owner's active
 * Claims with their merged projection surfaces, typed values, and entity
 * label surfaces; classification stays in the application-layer planner.
 * The Internal Owner stage holds one account, so the bounded result window
 * (LIMIT) is the scale guard; the GIN-indexed projection tables do the
 * heavy lifting at query time.
 */
export class PostgresMemoryTrustActionTargetSource {
  public constructor(private readonly pool: Pool) {}

  /**
   * The bounded search space for one trust-action kind (ADR-0118):
   * `active_claims` (Source Explanation) vs `active_and_corrected`
   * (Correction — a repeated correction must converge on the claim its
   * predecessor already corrected, SPEC story 48). Correction-superseded
   * claims enter only through versions this action created.
   */
  public async listResolutionCandidates(input: {
    limit: number;
    searchSpace:
      | "active_and_corrected"
      | "active_claims"
      | "forget_targets"
      | "fenced_targets";
    userId: string;
  }): Promise<readonly TrustActionResolutionCandidate[]> {
    const result = await this.pool.query<{
      claim_id: string;
      claim_kind: string;
      entity_surface_bindings: { e: string; s: string }[] | null;
      lexical_terms: string[] | null;
      object_entity_id: string | null;
      predicate_id: string;
      subject_entity_id: string;
      typed_value: unknown;
      version_id: string;
    }>(
      `
        SELECT
          claim.memory_claim_id::text AS claim_id,
          version.kind AS claim_kind,
          (
            SELECT COALESCE(
              jsonb_agg(DISTINCT jsonb_build_object(
                's', label.normalized_label, 'e', label.entity_id::text
              )),
              '[]'::jsonb
            )
            FROM entity_labels label
            WHERE label.entity_id IN (
              claim.subject_entity_id, claim.object_entity_id
            )
            AND label.user_id = claim.user_id
            AND label.is_current
            AND label.content_purged_at IS NULL
          ) AS entity_surface_bindings,
          (
            SELECT array_agg(DISTINCT term)
            FROM claim_retrieval_projections projection,
                 unnest(projection.lexical_terms) term
            WHERE projection.user_id = claim.user_id
              AND projection.memory_claim_id = claim.memory_claim_id
              AND projection.content_purged_at IS NULL
              AND (projection.status = 'active' OR $5::boolean)
          ) AS lexical_terms,
          claim.object_entity_id::text AS object_entity_id,
          claim.predicate_id,
          claim.subject_entity_id::text AS subject_entity_id,
          version.typed_value,
          version.memory_claim_version_id::text AS version_id
        FROM memory_claims claim
        INNER JOIN memory_claim_versions version
          ON version.memory_claim_version_id = claim.current_version_id
        WHERE claim.user_id = $1
          AND claim.deleted_at IS NULL
          AND claim.content_purged_at IS NULL
          AND version.epistemic_status <> 'contested'
          AND (
            ($6::boolean AND version.status = 'active')
            OR (
              $3::boolean
              AND version.status = 'superseded'
              AND version.created_by = 'memory_correction'
            )
            OR (
              $4::boolean
              AND version.status = 'retracted'
              AND EXISTS (
                SELECT 1 FROM memory_forget_requests fence
                WHERE fence.user_id = claim.user_id
                  AND fence.target_claim_id = claim.memory_claim_id
                  AND fence.target_scope = 'whole_claim'
                  AND fence.status = 'applied'
                  AND NOT EXISTS (
                    SELECT 1 FROM memory_forget_reversals reversal
                    WHERE reversal.user_id = fence.user_id
                      AND reversal.memory_forget_request_id = fence.memory_forget_request_id
                      AND reversal.status = 'active'
                  )
              )
            )
          )
        ORDER BY claim.memory_claim_id
        LIMIT $2
      `,
      [
        input.userId,
        input.limit,
        input.searchSpace === "active_and_corrected",
        input.searchSpace === "forget_targets" || input.searchSpace === "fenced_targets",
        input.searchSpace !== "active_claims",
        input.searchSpace !== "fenced_targets",
      ],
    );
    const claimCandidates = result.rows.map((row) => ({
      claimId: row.claim_id,
      claimKind:
        row.claim_kind === "impression"
          ? ("impression" as const)
          : ("objective" as const),
      claimVersionId: row.version_id,
      entitySurfaceBindings: (row.entity_surface_bindings ?? []).map(
        (binding) => ({
          entityId: binding.e,
          surface: normalizeRetrievalTerm(binding.s),
        }),
      ),
      lexicalTerms: (row.lexical_terms ?? [])
        .map((term) => normalizeRetrievalTerm(term))
        .filter((term) => term !== ""),
      objectEntityId: row.object_entity_id,
      predicateId: row.predicate_id,
      subjectEntityId: row.subject_entity_id,
      typedValues: toTypedValues(row.typed_value),
      targetKind: "memory_claim" as const,
    }));
    if (
      input.searchSpace !== "forget_targets" &&
      input.searchSpace !== "fenced_targets"
    ) {
      return claimCandidates;
    }

    const qualifiers = await this.pool.query<{
      claim_id: string;
      claim_kind: string;
      entity_surface_bindings: { e: string; s: string }[] | null;
      lexical_terms: string[] | null;
      object_entity_id: string | null;
      predicate_id: string;
      subject_entity_id: string;
      typed_value: unknown;
      qualifier_id: string;
      qualifier_axis_id: string;
      qualifier_role_side: "canonical_subject" | "counterpart";
      version_id: string;
    }>(
      `
        SELECT claim.memory_claim_id::text AS claim_id,
               version.kind AS claim_kind,
               (
                 SELECT COALESCE(
                   jsonb_agg(DISTINCT jsonb_build_object(
                     's', label.normalized_label, 'e', label.entity_id::text
                   )), '[]'::jsonb
                 )
                 FROM entity_labels label
                 WHERE label.entity_id IN (
                   claim.subject_entity_id, claim.object_entity_id
                 )
                   AND label.user_id = claim.user_id
                   AND label.is_current
                   AND label.content_purged_at IS NULL
               ) AS entity_surface_bindings,
               ARRAY(
                 SELECT DISTINCT term
                 FROM (
                   SELECT jsonb_array_elements_text(
                     CASE jsonb_typeof(qualifier.typed_value)
                       WHEN 'array' THEN qualifier.typed_value
                       ELSE jsonb_build_array(qualifier.typed_value)
                     END
                   ) AS term
                   UNION ALL
                   SELECT hint.role_term
                   FROM relationship_resolver_hints hint
                   WHERE hint.user_id = claim.user_id
                     AND hint.memory_claim_id = claim.memory_claim_id
                     AND hint.role_axis_id = qualifier.axis_id
                     AND hint.role_side = qualifier.role_side
                 ) terms
               ) AS lexical_terms,
               claim.object_entity_id::text AS object_entity_id,
               claim.predicate_id,
               claim.subject_entity_id::text AS subject_entity_id,
               qualifier.typed_value,
               qualifier.memory_claim_version_qualifier_id::text AS qualifier_id,
               qualifier.axis_id AS qualifier_axis_id,
               qualifier.role_side AS qualifier_role_side,
               claim.current_version_id::text AS version_id
        FROM memory_claims claim
        INNER JOIN memory_claim_versions version
          ON version.memory_claim_version_id = claim.current_version_id
         AND version.user_id = claim.user_id
        INNER JOIN memory_claim_version_qualifiers qualifier
          ON qualifier.user_id = claim.user_id
         AND (
           qualifier.memory_claim_version_id = claim.current_version_id
           OR EXISTS (
             SELECT 1
             FROM memory_forget_requests fence
             WHERE fence.user_id = claim.user_id
               AND fence.target_scope = 'relationship_qualifier'
               AND fence.target_qualifier_id = qualifier.memory_claim_version_qualifier_id
               AND fence.target_claim_id = claim.memory_claim_id
               AND fence.status = 'applied'
               AND NOT EXISTS (
                 SELECT 1 FROM memory_forget_reversals reversal
                 WHERE reversal.user_id = fence.user_id
                   AND reversal.memory_forget_request_id = fence.memory_forget_request_id
                   AND reversal.status = 'active'
               )
           )
         )
        WHERE claim.user_id = $1
          AND claim.deleted_at IS NULL
          AND claim.content_purged_at IS NULL
          AND version.epistemic_status <> 'contested'
          AND NOT EXISTS (
            SELECT 1
            FROM memory_forget_requests whole_fence
            WHERE whole_fence.user_id = claim.user_id
              AND whole_fence.target_claim_id = claim.memory_claim_id
              AND whole_fence.target_scope = 'whole_claim'
              AND whole_fence.status = 'applied'
              AND NOT EXISTS (
                SELECT 1
                FROM memory_forget_reversals whole_reversal
                WHERE whole_reversal.user_id = whole_fence.user_id
                  AND whole_reversal.memory_forget_request_id =
                        whole_fence.memory_forget_request_id
                  AND whole_reversal.status = 'active'
              )
          )
          AND (
            (
              $2::boolean
              AND qualifier.memory_claim_version_id = claim.current_version_id
              AND version.status = 'active'
            )
            OR EXISTS (
              SELECT 1
              FROM memory_forget_requests fence
              WHERE fence.user_id = claim.user_id
                AND fence.target_scope = 'relationship_qualifier'
                AND fence.target_qualifier_id = qualifier.memory_claim_version_qualifier_id
                AND fence.target_claim_id = claim.memory_claim_id
                AND fence.status = 'applied'
                AND NOT EXISTS (
                  SELECT 1 FROM memory_forget_reversals reversal
                  WHERE reversal.user_id = fence.user_id
                    AND reversal.memory_forget_request_id = fence.memory_forget_request_id
                    AND reversal.status = 'active'
                )
            )
          )
        ORDER BY claim.memory_claim_id, qualifier.axis_id, qualifier.role_side
        LIMIT $3
      `,
      [input.userId, input.searchSpace === "forget_targets", input.limit],
    );
    const qualifierCandidates = qualifiers.rows.map((row) => ({
      claimId: row.claim_id,
      claimKind:
        row.claim_kind === "impression"
          ? ("impression" as const)
          : ("objective" as const),
      claimVersionId: row.version_id,
      entitySurfaceBindings: (row.entity_surface_bindings ?? []).map(
        (binding) => ({
          entityId: binding.e,
          surface: normalizeRetrievalTerm(binding.s),
        }),
      ),
      lexicalTerms: (row.lexical_terms ?? [])
        .map((term) => normalizeRetrievalTerm(term))
        .filter((term) => term !== ""),
      objectEntityId: row.object_entity_id,
      predicateId: row.predicate_id,
      subjectEntityId: row.subject_entity_id,
      targetKind: "relationship_qualifier" as const,
      qualifierId: row.qualifier_id,
      qualifierAxisId: row.qualifier_axis_id,
      qualifierRoleSide: row.qualifier_role_side,
      qualifierTypedValue: toTypedValue(row.typed_value),
      typedValues: toTypedValues(row.typed_value),
    }));
    return [...claimCandidates, ...qualifierCandidates];
  }

  /** The owner's full current entity label index (normalized surfaces). */
  public async listLabelIndex(input: {
    userId: string;
  }): Promise<readonly TrustActionLabelIndexEntry[]> {
    const result = await this.pool.query<{
      entity_id: string;
      normalized_label: string;
    }>(
      `SELECT DISTINCT entity_id::text, normalized_label
       FROM entity_labels
       WHERE user_id = $1 AND is_current AND content_purged_at IS NULL`,
      [input.userId],
    );
    return result.rows.map((row) => ({
      entityId: row.entity_id,
      surface: normalizeRetrievalTerm(row.normalized_label),
    }));
  }
}

function toTypedValues(value: unknown): readonly string[] {
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item) => normalizeRetrievalTerm(String(item)))
    .filter((item) => item !== "");
}

/**
 * The Postgres implementation of the correction follow-up workflow port
 * (issue #119): reads the command enqueued inside the admission transaction,
 * claims the idempotent run, records the targeted JournalStatement
 * revalidation result, and appends follow-up Receipts to the same immutable
 * sequence the synchronous correction produced.
 */
export class PostgresMemoryCorrectionFollowupRepository
  implements MemoryCorrectionFollowupRepository
{
  public constructor(private readonly pool: Pool) {}

  public async readFollowupCommand(input: {
    workflowCommandId: string;
  }): Promise<MemoryCorrectionFollowupCommand | null> {
    const result = await this.pool.query<{
      action_execution_id: string;
      policy_version: string;
      subject_id: string;
      user_id: string;
    }>(
      `SELECT command.workflow_command_id::text AS workflow_command_id,
              command.subject_id::text AS subject_id,
              execution.user_id::text AS user_id,
              command.policy_version,
              execution.action_execution_id::text AS action_execution_id
       FROM workflow_commands command
       INNER JOIN conversation_action_executions execution
         ON execution.action_execution_id = command.action_execution_id
       WHERE command.workflow_command_id = $1
         AND command.command_type = 'memory_correction_followup'`,
      [input.workflowCommandId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      actionExecutionId: row.action_execution_id,
      policyVersion: row.policy_version,
      targetClaimId: row.subject_id,
      userId: row.user_id,
      workflowCommandId: input.workflowCommandId,
    };
  }

  public async claimFollowupRun(input: {
    actionExecutionId: string;
    targetClaimId: string;
    userId: string;
    workflowCommandId: string;
  }): Promise<"execute" | "replayed"> {
    const result = await this.pool.query(
      `INSERT INTO memory_correction_followups (
         memory_correction_followup_id, user_id, workflow_command_id,
         action_execution_id, target_claim_id,
         affected_journal_statement_count, followup_policy_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, 0, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (workflow_command_id) DO NOTHING`,
      [
        createUuidV7(new Date()),
        input.userId,
        input.workflowCommandId,
        input.actionExecutionId,
        input.targetClaimId,
        MEMORY_CORRECTION_FOLLOWUP_POLICY_VERSION,
      ],
    );
    return (result.rowCount ?? 0) === 1 ? "execute" : "replayed";
  }

  public async listAffectedJournalStatementIds(input: {
    claimId: string;
    userId: string;
  }): Promise<readonly string[]> {
    // Journal statements whose evidence links intersect the corrected
    // claim's evidence: the targeted revalidation scope (SPEC trust
    // actions). Read-only here; the journal layer owns any re-check.
    const result = await this.pool.query<{ journal_statement_id: string }>(
      `SELECT DISTINCT link.journal_statement_id::text AS journal_statement_id
       FROM journal_statement_evidence_links link
       WHERE link.user_id = $1
         AND link.evidence_item_id IN (
           SELECT DISTINCT claim_link.evidence_item_id
           FROM claim_evidence_links claim_link
           INNER JOIN memory_claim_versions version
             ON version.memory_claim_version_id =
               claim_link.memory_claim_version_id
           WHERE claim_link.user_id = $1
             AND version.memory_claim_id = $2
         )
       ORDER BY 1`,
      [input.userId, input.claimId],
    );
    return result.rows.map((row) => row.journal_statement_id);
  }

  public async recordFollowupOutcome(input: {
    affectedJournalStatementIds: readonly string[];
    workflowCommandId: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE memory_correction_followups
       SET affected_journal_statement_count = $2
       WHERE workflow_command_id = $1`,
      [input.workflowCommandId, input.affectedJournalStatementIds.length],
    );
  }

  public async appendFollowupReceipt(input: {
    actionExecutionId: string;
    disposition: string;
    execution: "running" | "succeeded";
    receiptKey: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const execution = await client.query(
        `SELECT action_execution_id FROM conversation_action_executions
         WHERE action_execution_id = $1 FOR UPDATE`,
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
        execution: input.execution,
        receiptKey: input.receiptKey,
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
