import type {
  ActionFinalizationReceiptSnapshot,
  ConversationActionTransactionExecutor,
  ExplainMemorySourceVerdict,
  MemoryCorrectionFollowupCommand,
  MemoryCorrectionFollowupRepository,
  MemoryCorrectionPlan,
  MemoryTrustActionCommitPort,
  TrustActionClaimSnapshot,
  TrustActionLabelIndexEntry,
  TrustActionResolutionCandidate,
} from "@sayhear/application";
import {
  EXPLAIN_SOURCE_QUOTE_MAX_LENGTH,
  MEMORY_CORRECTION_FOLLOWUP_POLICY_VERSION,
  MEMORY_CORRECTION_POLICY_VERSION,
  normalizeRetrievalTerm,
  TRUST_ACTION_KINDS,
} from "@sayhear/application";
import { asMemoryClaimId, asMemoryClaimVersionId } from "@sayhear/domain";
import type { Pool } from "pg";
import { insertExecutionReceipt } from "./postgres-conversation-action-repository";
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
}>;

export class PostgresMemoryTrustActionCommitPort
  implements MemoryTrustActionCommitPort
{
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
    resolved_claim_id: string | null;
    resolved_claim_version_id: string | null;
  }>(
    `SELECT action_kind,
            resolved_claim_id::text AS resolved_claim_id,
            resolved_claim_version_id::text AS resolved_claim_version_id
     FROM conversation_action_executions
     WHERE action_execution_id = $1`,
    [input.actionExecutionId],
  );
  const row = execution.rows[0];
  const actionKind = row?.action_kind ?? null;
  const claimId = row?.resolved_claim_id ?? null;
  const claimVersionId = row?.resolved_claim_version_id ?? null;
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
    searchSpace: "active_and_corrected" | "active_claims";
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
              AND (
                projection.status = 'active' OR $3::boolean
              )
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
            version.status = 'active'
            OR (
              $3::boolean
              AND version.status = 'superseded'
              AND version.created_by = 'memory_correction'
            )
          )
        ORDER BY claim.memory_claim_id
        LIMIT $2
      `,
      [
        input.userId,
        input.limit,
        input.searchSpace === "active_and_corrected",
      ],
    );
    return result.rows.map((row) => ({
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
    }));
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
