import { retryPostgresTransaction } from "./postgres-transaction-retry";
import {
  asUserId,
  type FastPathBatchRevision,
  type FastPathCommandContext,
  type FastPathExtractionRepository,
  type FastPathItemClass,
  type FastPathRunStatus,
  type FastPathSessionLocalContext,
  type PriorCommittedClarification,
} from "@sayhear/application";
import type { Pool, PoolClient } from "pg";

import { lockActiveOwnerEpoch } from "./postgres-owner-epoch-fence";
import {
  findTerminalCandidateByFingerprintWithin,
  findTerminalGovernanceBlockWithin,
  insertCandidateEvidenceLinksWithin,
  insertMemoryCandidateWithin,
} from "./postgres-memory-claim-repository";
import { createUuidV7 } from "./uuid-v7";

/**
 * Fast-path extraction persistence (issue #113). The per-revision commit is a
 * single transaction behind the epoch / event-currency fences; the run row
 * (UNIQUE per event revision + policy) is the idempotency anchor that absorbs
 * workflow replays and retries (SPEC story 28).
 */

type CommandRow = Readonly<{
  workflow_command_id: string;
  subject_id: string;
  source_revision: string;
  policy_version: string;
  expected_data_epoch: string;
  status: string;
}>;

type RevisionRow = Readonly<{
  conversation_event_revision_id: string;
  conversation_event_id: string;
  user_id: string;
  daily_session_id: string;
  sequence_no: string;
  revision: number;
  locale: string;
  canonical_text: string;
  transcript_status: "final" | "corrected";
  created_by: string;
  created_at: Date;
  current_revision_id: string | null;
  content_purged_at: Date | null;
  lifecycle_status: string | null;
  actor: string | null;
}>;

/**
 * Committed final / corrected User Event revisions of one session ($1) whose
 * fast-path extraction has not completed — the `fast_path_pending` signal
 * (issue #113). Shared by the context compile and the session-local read so
 * the two surfaces can never disagree.
 */
export const FAST_PATH_PENDING_REVISIONS_SQL = `
  SELECT revision.conversation_event_revision_id
  FROM conversation_events event
  INNER JOIN conversation_event_revisions revision
    ON revision.conversation_event_revision_id = event.current_revision_id
  WHERE event.daily_session_id = $1
    AND event.actor = 'user'
    AND event.event_type = 'message'
    AND event.lifecycle_status = 'active'
    AND revision.transcript_status IN ('final', 'corrected')
    AND revision.content_purged_at IS NULL
    AND EXISTS (
      SELECT 1 FROM workflow_commands command
      WHERE command.command_type = 'fast_path_extraction'
        AND command.subject_type = 'conversation_event_revision'
        AND command.subject_id = revision.conversation_event_revision_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM fast_path_extraction_runs run
      WHERE run.event_revision_id = revision.conversation_event_revision_id
        AND run.status = 'extracted'
    )
`;

const REVISION_VALIDITY_JOIN = `
  FROM conversation_event_revisions revision
  INNER JOIN conversation_events event
    ON event.conversation_event_id = revision.conversation_event_id
    AND event.user_id = revision.user_id
  INNER JOIN daily_sessions session
    ON session.daily_session_id = event.daily_session_id
    AND session.user_id = event.user_id
  WHERE revision.user_id = $1
    AND revision.conversation_event_revision_id = $2
    AND event.actor = 'user'
    AND event.event_type = 'message'
    AND event.lifecycle_status = 'active'
    AND revision.transcript_status IN ('final', 'corrected')
    AND revision.content_purged_at IS NULL
`;

export class PostgresFastPathExtractionRepository
  implements FastPathExtractionRepository
{
  public constructor(private readonly pool: Pool) {}

  /** The DB-pinned versioned parameters (immutable policy rows). */
  public async loadPolicy(policyVersion: string): Promise<{
    version: string;
    visibilityTargetMs: number;
    maxBatchRevisions: number;
    tAuto: number;
    maxCandidates: number;
  } | null> {
    const result = await this.pool.query<{
      visibility_target_ms: number;
      max_batch_revisions: number;
      entity_resolve_t_auto: string;
      entity_resolve_max_candidates: number;
    }>(
      `SELECT visibility_target_ms, max_batch_revisions,
              entity_resolve_t_auto::text, entity_resolve_max_candidates
       FROM fast_path_extraction_policies WHERE policy_version = $1`,
      [policyVersion],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      version: policyVersion,
      visibilityTargetMs: Number(row.visibility_target_ms),
      maxBatchRevisions: Number(row.max_batch_revisions),
      tAuto: Number(row.entity_resolve_t_auto),
      maxCandidates: Number(row.entity_resolve_max_candidates),
    };
  }

  public async readCommand(input: {
    workflowCommandId: string;
    policyVersion: string;
    maxBatchRevisions: number;
  }): Promise<
    | Readonly<{ outcome: "not_found" }>
    | Readonly<{ outcome: "stale_source" }>
    | Readonly<{
        outcome: "ready";
        command: FastPathCommandContext;
        existingRunStatus: FastPathRunStatus | null;
      }>
  > {
    const client = await this.pool.connect();
    try {
      return await readCommandWithin(client, input);
    } finally {
      client.release();
    }
  }

  public async ensureRevisionEvidence(input: {
    userId: string;
    dailySessionId: string;
    revision: FastPathBatchRevision;
    evidence: readonly Readonly<{
      locatorKey: string;
      role: "factual_support" | "subjective_report";
    }>[];
    extractionPolicyVersion: string;
    expectedDataEpoch: number;
    lineage: Readonly<{
      commandId: string;
      attemptId: string;
      championConfigVersion: string;
      championProvider: string;
      championModel: string;
      championSnapshot: string;
      championProviderPolicyVersion: string;
    }>;
    now: Date;
  }): Promise<ReadonlyMap<string, string>> {
    return retryPostgresTransaction(() => this.ensureRevisionEvidenceOnce(input));
  }

  private async ensureRevisionEvidenceOnce(input: {
    userId: string;
    dailySessionId: string;
    revision: FastPathBatchRevision;
    evidence: readonly Readonly<{
      locatorKey: string;
      role: "factual_support" | "subjective_report";
    }>[];
    extractionPolicyVersion: string;
    expectedDataEpoch: number;
    lineage: Readonly<{
      commandId: string;
      attemptId: string;
      championConfigVersion: string;
      championProvider: string;
      championModel: string;
      championSnapshot: string;
      championProviderPolicyVersion: string;
    }>;
    now: Date;
  }): Promise<ReadonlyMap<string, string>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const map = await ensureRevisionEvidenceWithin(client, input);
      await client.query("COMMIT");
      return map;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async commitRevisionExtraction(
    input: Parameters<FastPathExtractionRepository["commitRevisionExtraction"]>[0],
  ): Promise<
    | Readonly<{ outcome: "committed"; candidateIds: readonly string[] }>
    | Readonly<{ outcome: "already_extracted" }>
    | Readonly<{ outcome: "stale_source" }>
  > {
    return retryPostgresTransaction(() => this.commitRevisionExtractionOnce(input));
  }

  private async commitRevisionExtractionOnce(
    input: Parameters<FastPathExtractionRepository["commitRevisionExtraction"]>[0],
  ): Promise<
    | Readonly<{ outcome: "committed"; candidateIds: readonly string[] }>
    | Readonly<{ outcome: "already_extracted" }>
    | Readonly<{ outcome: "stale_source" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await commitRevisionExtractionWithin(client, input);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordRunFailure(input: {
    command: Readonly<{
      workflowCommandId: string;
      userId: string;
      dailySessionId: string;
      eventRevisionId: string;
      expectedDataEpoch: number;
      extractionPolicyVersion: string;
      eventCommittedAt: Date;
    }>;
    lineage: Readonly<{
      modelAttemptId: string;
      memoryExtractConfigVersion: string;
      memoryExtractModelVersion: string;
      memoryExtractPromptVersion: string;
      entityResolveConfigVersion: string | null;
      roleFallbackUsed: boolean;
    }>;
    errorCode: string;
    now: Date;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Authoritative-write fence: an epoch that has moved on (purge) means
      // the failure record would reference a data face that no longer
      // exists — skip rather than write through the fence.
      const epoch = await lockActiveOwnerEpoch(client, input.command.userId);
      if (epoch !== null && epoch === input.command.expectedDataEpoch) {
        await client.query(
          `INSERT INTO fast_path_extraction_runs (
             fast_path_run_id, user_id, daily_session_id, event_revision_id,
             event_conversation_event_id, extraction_policy_version,
             workflow_command_id, model_attempt_id, memory_extract_config_version,
             memory_extract_model_version, memory_extract_prompt_version,
             entity_resolve_config_version, role_fallback_used, status,
             event_committed_at, error_code, created_at, updated_at
           ) VALUES ($1, $2, $3, $4,
             (SELECT conversation_event_id FROM conversation_event_revisions
              WHERE conversation_event_revision_id = $4 AND user_id = $2),
             $5, $6, $7, $8, $9, $10, $11, $12,
             'retryable_failed', $13, $14, $15, $15)
           ON CONFLICT (event_revision_id, extraction_policy_version)
           DO UPDATE SET status = 'retryable_failed', error_code = EXCLUDED.error_code,
             updated_at = EXCLUDED.updated_at
           WHERE fast_path_extraction_runs.status = 'retryable_failed'`,
          [
            createUuidV7(input.now),
            input.command.userId,
            input.command.dailySessionId,
            input.command.eventRevisionId,
            input.command.extractionPolicyVersion,
            input.command.workflowCommandId,
            input.lineage.modelAttemptId,
            input.lineage.memoryExtractConfigVersion,
            input.lineage.memoryExtractModelVersion,
            input.lineage.memoryExtractPromptVersion,
            input.lineage.entityResolveConfigVersion,
            input.lineage.roleFallbackUsed,
            input.command.eventCommittedAt,
            input.errorCode,
            input.now,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async readSessionLocalContext(input: {
    dailySessionId: string;
  }): Promise<FastPathSessionLocalContext> {
    const items = await this.pool.query<{
      item_class: FastPathItemClass;
      summary: string;
      evidence_item_id: string | null;
    }>(
      `SELECT item.item_class, item.summary, item.evidence_item_id
       FROM fast_path_session_items item
       INNER JOIN conversation_events event
         ON event.conversation_event_id = (
           SELECT conversation_event_id FROM conversation_event_revisions
           WHERE conversation_event_revision_id = item.event_revision_id
         )
         AND event.user_id = item.user_id
       WHERE item.user_id = (
           SELECT user_id FROM daily_sessions WHERE daily_session_id = $1
         )
         AND item.daily_session_id = $1
         AND item.retired_at IS NULL
         AND event.current_revision_id = item.event_revision_id
         AND event.lifecycle_status = 'active'
       ORDER BY item.created_at, item.fast_path_item_id`,
      [input.dailySessionId],
    );
    const pending = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM (${FAST_PATH_PENDING_REVISIONS_SQL}) pending`,
      [input.dailySessionId],
    );
    const openClarifications = await this.pool.query<{
      question_text: string;
      topic_key: string;
      semantic_impact: "relationship_attribution" | "person_identity";
    }>(
      `SELECT question_text, topic_key, semantic_impact
       FROM entity_clarification_proposals
       WHERE daily_session_id = $1
         AND user_id = (SELECT user_id FROM daily_sessions WHERE daily_session_id = $1)
         AND status = 'committed'
       ORDER BY created_at, entity_clarification_proposal_id`,
      [input.dailySessionId],
    );
    return {
      items: items.rows.map((row) => ({
        itemClass: row.item_class,
        summary: row.summary,
        evidenceItemIds: row.evidence_item_id === null ? [] : [row.evidence_item_id],
      })),
      openClarifications: openClarifications.rows.map((row) => ({
        questionText: row.question_text,
        topicKey: row.topic_key,
        semanticImpact: row.semantic_impact,
      })),
      pendingRevisionCount: Number(pending.rows[0]?.count ?? 0),
    };
  }
}

// ── Within-transaction implementations ──────────────────────────────────────

async function readCommandWithin(
  client: PoolClient,
  input: {
    workflowCommandId: string;
    policyVersion: string;
    maxBatchRevisions: number;
  },
): Promise<
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "stale_source" }>
  | Readonly<{
      outcome: "ready";
      command: FastPathCommandContext;
      existingRunStatus: FastPathRunStatus | null;
    }>
> {
  const command = await client.query<CommandRow>(
    `SELECT workflow_command_id, subject_id, source_revision::text,
            policy_version, expected_data_epoch::text, status
     FROM workflow_commands
     WHERE workflow_command_id = $1
       AND command_type = 'fast_path_extraction'
       AND subject_type = 'conversation_event_revision'`,
    [input.workflowCommandId],
  );
  const commandRow = command.rows[0];
  if (!commandRow) return { outcome: "not_found" };

  const revision = await loadValidRevision(
    client,
    commandRow.subject_id,
  );
  if (!revision) {
    // The revision is superseded, purged, or no longer current: the command
    // deterministically converges without writing anything.
    return { outcome: "stale_source" };
  }
  const run = await client.query<{ status: FastPathRunStatus }>(
    `SELECT status FROM fast_path_extraction_runs
     WHERE event_revision_id = $1 AND extraction_policy_version = $2`,
    [commandRow.subject_id, input.policyVersion],
  );

  // Provider economy: batch this session's still-pending committed revisions
  // (same validity fences), newest-last. Per-revision semantics are preserved
  // by the per-revision commits; a co-extracted revision's own command finds
  // its run already written and converges.
  const batchRows = await client.query<RevisionRow>(
    `SELECT revision.conversation_event_revision_id,
            revision.conversation_event_id, revision.user_id,
            event.daily_session_id, event.sequence_no::text, revision.revision,
            revision.locale, revision.canonical_text,
            revision.transcript_status, revision.created_by, revision.created_at,
            event.current_revision_id, revision.content_purged_at,
            event.lifecycle_status, event.actor
     FROM conversation_event_revisions revision
     INNER JOIN conversation_events event
       ON event.conversation_event_id = revision.conversation_event_id
       AND event.user_id = revision.user_id
     WHERE event.daily_session_id = $1
       AND event.user_id = $2
       AND event.actor = 'user'
       AND event.event_type = 'message'
       AND event.lifecycle_status = 'active'
       AND revision.transcript_status IN ('final', 'corrected')
       AND revision.content_purged_at IS NULL
       AND event.current_revision_id = revision.conversation_event_revision_id
       AND EXISTS (
         SELECT 1 FROM workflow_commands command
         WHERE command.command_type = 'fast_path_extraction'
           AND command.subject_type = 'conversation_event_revision'
           AND command.subject_id = revision.conversation_event_revision_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM fast_path_extraction_runs run
         WHERE run.event_revision_id = revision.conversation_event_revision_id
           AND run.extraction_policy_version = $3
           AND run.status IN ('extracted', 'stale_source', 'retired')
       )
     ORDER BY revision.created_at, revision.conversation_event_revision_id
     LIMIT $4`,
    [
      revision.daily_session_id,
      revision.user_id,
      input.policyVersion,
      input.maxBatchRevisions,
    ],
  );
  const priorClarifications = await client.query<{
    entity_clarification_proposal_id: string;
    topic_key: string;
    status: "committed" | "resolved" | "dropped";
  }>(
    `SELECT entity_clarification_proposal_id, topic_key, status
     FROM entity_clarification_proposals
     WHERE user_id = $1 AND daily_session_id = $2`,
    [revision.user_id, revision.daily_session_id],
  );

  const batch = toBatchRevisions(batchRows.rows);
  const subjectRevision = toBatchRevisions([revision])[0]!;
  if (!batch.some((entry) => entry.revisionId === subjectRevision.revisionId)) {
    // The subject revision always processes; a full batch yields its oldest
    // slot so the versioned batch bound still holds.
    if (batch.length >= input.maxBatchRevisions) {
      batch.shift();
    }
    batch.push(subjectRevision);
  }
  return {
    outcome: "ready",
    command: {
      workflowCommandId: commandRow.workflow_command_id,
      userId: revision.user_id,
      dailySessionId: revision.daily_session_id,
      eventRevisionId: revision.conversation_event_revision_id,
      revisionOrdinal: Number(commandRow.source_revision),
      extractionPolicyVersion: commandRow.policy_version,
      expectedDataEpoch: Number(commandRow.expected_data_epoch),
      revision: subjectRevision,
      batch,
      priorCommittedClarifications: priorClarifications.rows.map(
        (row): PriorCommittedClarification => ({
          proposalId: row.entity_clarification_proposal_id,
          topicKey: row.topic_key,
          status: row.status,
        }),
      ),
    },
    existingRunStatus: run.rows[0]?.status ?? null,
  };
}

async function loadValidRevision(
  client: PoolClient,
  eventRevisionId: string,
): Promise<RevisionRow | null> {
  // The command's subject scopes the lookup; the join enforces the same
  // validity fences the commit re-checks in-transaction.
  const result = await client.query<RevisionRow>(
    `SELECT revision.conversation_event_revision_id,
            revision.conversation_event_id, revision.user_id,
            event.daily_session_id, event.sequence_no::text, revision.revision,
            revision.locale, revision.canonical_text,
            revision.transcript_status, revision.created_by, revision.created_at,
            event.current_revision_id, revision.content_purged_at,
            event.lifecycle_status, event.actor
     FROM conversation_event_revisions revision
     INNER JOIN conversation_events event
       ON event.conversation_event_id = revision.conversation_event_id
       AND event.user_id = revision.user_id
     INNER JOIN daily_sessions session
       ON session.daily_session_id = event.daily_session_id
       AND session.user_id = event.user_id
     WHERE revision.conversation_event_revision_id = $1
       AND event.actor = 'user'
       AND event.event_type = 'message'
       AND event.lifecycle_status = 'active'
       AND revision.transcript_status IN ('final', 'corrected')
       AND revision.content_purged_at IS NULL
       AND event.current_revision_id = revision.conversation_event_revision_id`,
    [eventRevisionId],
  );
  return result.rows[0] ?? null;
}

function toBatchRevisions(rows: readonly RevisionRow[]): FastPathBatchRevision[] {
  return rows.map((row) => ({
    revisionId: row.conversation_event_revision_id,
    conversationEventId: row.conversation_event_id,
    sequenceNo: Number(row.sequence_no),
    locale: row.locale,
    text: row.canonical_text,
    committedAt: row.created_at,
    transcriptStatus: row.transcript_status,
    isCorrection: row.created_by === "user_correction",
    supersedesRevisionId: null,
  }));
}

async function ensureRevisionEvidenceWithin(
  client: PoolClient,
  input: {
    userId: string;
    dailySessionId: string;
    revision: FastPathBatchRevision;
    evidence: readonly Readonly<{
      locatorKey: string;
      role: "factual_support" | "subjective_report";
    }>[];
    extractionPolicyVersion: string;
    expectedDataEpoch: number;
    lineage: Readonly<{
      commandId: string;
      attemptId: string;
      championConfigVersion: string;
      championProvider: string;
      championModel: string;
      championSnapshot: string;
      championProviderPolicyVersion: string;
    }>;
    now: Date;
  },
): Promise<ReadonlyMap<string, string>> {
  const epoch = await lockActiveOwnerEpoch(client, input.userId);
  if (epoch === null || epoch !== input.expectedDataEpoch) {
    throw new Error("Fast path evidence write was fenced by the owner epoch.");
  }
  // One snapshot per (session, event sequence, policy); corrections reuse the
  // row because EvidenceItems themselves key on the source revision. Snapshot
  // and item rows are immutable — conflicts converge by re-selecting.
  const snapshotId = createUuidV7(input.now);
  await client.query(
    `INSERT INTO evidence_source_snapshots (
       evidence_source_snapshot_id, user_id, daily_session_id,
       source_revision, extraction_policy_version, command_id, attempt_id,
       champion_config_version, champion_provider, champion_model,
       champion_snapshot, champion_provider_policy_version, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (daily_session_id, source_revision, extraction_policy_version)
     DO NOTHING`,
    [
      snapshotId,
      input.userId,
      input.dailySessionId,
      input.revision.sequenceNo,
      input.extractionPolicyVersion,
      input.lineage.commandId,
      input.lineage.attemptId,
      input.lineage.championConfigVersion,
      input.lineage.championProvider,
      input.lineage.championModel,
      input.lineage.championSnapshot,
      input.lineage.championProviderPolicyVersion,
      input.now,
    ],
  );
  const resolvedSnapshot = await client.query<{ evidence_source_snapshot_id: string }>(
    `SELECT evidence_source_snapshot_id FROM evidence_source_snapshots
     WHERE daily_session_id = $1 AND source_revision = $2
       AND extraction_policy_version = $3`,
    [
      input.dailySessionId,
      input.revision.sequenceNo,
      input.extractionPolicyVersion,
    ],
  );
  const resolvedSnapshotId =
    resolvedSnapshot.rows[0]!.evidence_source_snapshot_id;
  const byLocator = new Map<string, string>();
  for (const span of input.evidence) {
    const itemId = createUuidV7(input.now);
    await client.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id,
         source_event_id, source_revision_id, source_actor, source_status,
         locator_type, locator_key, extraction_policy_version, evidence_role,
         status, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'user', $6, 'text_span', $7, $8, $9,
         'active', $10)
       ON CONFLICT (user_id, source_revision_id, locator_key, extraction_policy_version)
       DO NOTHING`,
      [
        itemId,
        input.userId,
        resolvedSnapshotId,
        input.revision.conversationEventId,
        input.revision.revisionId,
        input.revision.transcriptStatus,
        span.locatorKey,
        input.extractionPolicyVersion,
        span.role,
        input.now,
      ],
    );
    const item = await client.query<{ evidence_item_id: string }>(
      `SELECT evidence_item_id FROM evidence_items
       WHERE user_id = $1 AND source_revision_id = $2 AND locator_key = $3
         AND extraction_policy_version = $4`,
      [
        input.userId,
        input.revision.revisionId,
        span.locatorKey,
        input.extractionPolicyVersion,
      ],
    );
    await client.query(
      `INSERT INTO evidence_lineage (evidence_item_id, command_id, attempt_id, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (evidence_item_id) DO NOTHING`,
      [
        item.rows[0]!.evidence_item_id,
        input.lineage.commandId,
        input.lineage.attemptId,
        input.now,
      ],
    );
    byLocator.set(span.locatorKey, item.rows[0]!.evidence_item_id);
  }
  return byLocator;
}

async function commitRevisionExtractionWithin(
  client: PoolClient,
  input: Parameters<FastPathExtractionRepository["commitRevisionExtraction"]>[0],
): Promise<
  | Readonly<{ outcome: "committed"; candidateIds: readonly string[] }>
  | Readonly<{ outcome: "already_extracted" }>
  | Readonly<{ outcome: "stale_source" }>
> {
  // Authoritative-write fence: lock the owner, check epoch, then the event
  // currency (architecture 13.4).
  const epoch = await lockActiveOwnerEpoch(client, input.command.userId);
  if (epoch === null || epoch !== input.command.expectedDataEpoch) {
    return { outcome: "stale_source" };
  }
  const revision = await client.query<RevisionRow>(
    `SELECT revision.conversation_event_revision_id,
            revision.conversation_event_id, revision.user_id,
            event.daily_session_id, event.sequence_no::text, revision.revision,
            revision.locale, revision.canonical_text,
            revision.transcript_status, revision.created_by, revision.created_at,
            event.current_revision_id, revision.content_purged_at,
            event.lifecycle_status, event.actor
     ${REVISION_VALIDITY_JOIN}
       AND event.current_revision_id = revision.conversation_event_revision_id`,
    [input.command.userId, input.revision.revisionId],
  );
  const revisionRow = revision.rows[0];
  if (!revisionRow) {
    return { outcome: "stale_source" };
  }

  // The idempotency claim: claim the run row first. An already-extracted
  // revision (or a non-retryable terminal state) converges without writes.
  const claimed = await client.query<{ claimed: boolean }>(
    `INSERT INTO fast_path_extraction_runs AS run (
       fast_path_run_id, user_id, daily_session_id, event_revision_id,
       event_conversation_event_id, extraction_policy_version,
       workflow_command_id, model_attempt_id, memory_extract_config_version,
       memory_extract_model_version, memory_extract_prompt_version,
       entity_resolve_config_version, role_fallback_used, status,
       event_committed_at, extracted_at, visibility_lag_ms,
       visibility_target_met, item_count, mention_count, candidate_count,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       'extracted', $14, $15, $16, $17, $18, $19, $20, $21, $21)
     ON CONFLICT (event_revision_id, extraction_policy_version) DO NOTHING
     RETURNING TRUE AS claimed`,
    [
      createUuidV7(input.now),
      input.command.userId,
      input.command.dailySessionId,
      input.revision.revisionId,
      input.revision.conversationEventId,
      input.command.extractionPolicyVersion,
      input.command.workflowCommandId,
      input.lineage.modelAttemptId,
      input.lineage.memoryExtractConfigVersion,
      input.lineage.memoryExtractModelVersion,
      input.lineage.memoryExtractPromptVersion,
      input.lineage.entityResolveConfigVersion,
      input.lineage.roleFallbackUsed,
      input.revision.committedAt,
      input.now,
      Math.max(
        0,
        input.now.getTime() - input.revision.committedAt.getTime(),
      ),
      input.now.getTime() - input.revision.committedAt.getTime() <=
        input.visibilityTargetMs,
      input.items.length,
      input.mentionIdsByProposalIndex.size,
      input.candidates.length,
      input.now,
    ],
  );
  if (claimed.rows.length === 0) {
    const existing = await client.query<{ status: FastPathRunStatus }>(
      `SELECT status FROM fast_path_extraction_runs
       WHERE event_revision_id = $1 AND extraction_policy_version = $2`,
      [input.revision.revisionId, input.command.extractionPolicyVersion],
    );
    const status = existing.rows[0]?.status ?? "extracted";
    if (status === "retryable_failed") {
      // A retryable failure may be retried by the workflow machinery: take
      // the row forward inside this same transaction.
      await client.query(
        `UPDATE fast_path_extraction_runs
         SET status = 'extracted', extracted_at = $1, updated_at = $1,
             visibility_lag_ms = $2, visibility_target_met = $3,
             item_count = $4, mention_count = $5, candidate_count = $6,
             error_code = NULL
         WHERE event_revision_id = $7 AND extraction_policy_version = $8
           AND status = 'retryable_failed'`,
        [
          input.now,
          Math.max(0, input.now.getTime() - input.revision.committedAt.getTime()),
          input.now.getTime() - input.revision.committedAt.getTime() <=
            input.visibilityTargetMs,
          input.items.length,
          input.mentionIdsByProposalIndex.size,
          input.candidates.length,
          input.revision.revisionId,
          input.command.extractionPolicyVersion,
        ],
      );
    } else {
      return status === "stale_source"
        ? { outcome: "stale_source" }
        : { outcome: "already_extracted" };
    }
  }

  const runId = await client.query<{ fast_path_run_id: string }>(
    `SELECT fast_path_run_id FROM fast_path_extraction_runs
     WHERE event_revision_id = $1 AND extraction_policy_version = $2`,
    [input.revision.revisionId, input.command.extractionPolicyVersion],
  );

  // Memory Candidates through the shared terminal-fenced writer: ADR-0046
  // rejections and governance blocks must fence fast-path proposals exactly
  // like consolidation proposals.
  const userId = asUserId(input.command.userId);
  const candidateIds: string[] = [];
  const candidateIdByIndex = new Map<number, string>();
  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index]!;
    const terminal = await findTerminalCandidateByFingerprintWithin(
      client,
      userId,
      candidate.dedupeFingerprint,
    );
    if (terminal) continue;
    const governance = await findTerminalGovernanceBlockWithin(client, userId, {
      predicateId:
        candidate.proposal.resolution.status === "mapped"
          ? candidate.proposal.resolution.predicateId
          : "",
      proposedConcept:
        candidate.proposal.resolution.status === "mapped"
          ? ""
          : candidate.proposal.resolution.proposedConcept,
      subjectEntityId: candidate.proposal.subjectEntityId,
      objectEntityId: candidate.proposal.objectEntityId,
      scopeKey: candidate.proposal.scopeKey,
      objectValueJson: JSON.stringify(
        candidate.proposal.resolution.status === "mapped"
          ? candidate.proposal.resolution.typedValue
          : "",
      ),
    });
    if (governance) continue;
    const candidateId = await insertMemoryCandidateWithin(client, {
      proposal: candidate.proposal,
      status: candidate.status,
      reviewDueAt: candidate.reviewDueAt,
      now: input.now,
    });
    await insertCandidateEvidenceLinksWithin(client, {
      userId,
      candidateId,
      evidenceItemIds: candidate.proposal.evidenceItemIds,
      now: input.now,
    });
    candidateIds.push(candidateId);
    candidateIdByIndex.set(index, candidateId);
  }

  // Session-local items with light dedupe (UNIQUE per user + session + key).
  for (const item of input.items) {
    await client.query(
      `INSERT INTO fast_path_session_items (
         fast_path_item_id, user_id, daily_session_id, event_revision_id,
         fast_path_run_id, item_class, summary, memory_candidate_id,
         entity_mention_id, evidence_item_id, dedupe_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (user_id, daily_session_id, dedupe_key) DO NOTHING`,
      [
        createUuidV7(input.now),
        input.command.userId,
        input.command.dailySessionId,
        input.revision.revisionId,
        runId.rows[0]!.fast_path_run_id,
        item.itemClass,
        item.summary,
        item.candidateIndex !== null
          ? candidateIdByIndex.get(item.candidateIndex) ?? null
          : null,
        item.mentionProposalIndex !== null
          ? input.mentionIdsByProposalIndex.get(item.mentionProposalIndex) ?? null
          : null,
        item.evidenceLocatorKeys.length > 0
          ? input.evidenceItemIdsByLocatorKey.get(item.evidenceLocatorKeys[0]!) ??
            null
          : null,
        item.dedupeKey,
        input.now,
      ],
    );
  }

  // Entity Clarification commits (model proposed, deterministic code
  // commits, once per session + topic) and prior dispositions (ADR-0024).
  for (const clarification of input.clarifications) {
    await client.query(
      `INSERT INTO entity_clarification_proposals (
         entity_clarification_proposal_id, user_id, daily_session_id,
         event_revision_id, entity_mention_id, topic_key, semantic_impact,
         status, question_text, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'committed', $8, $9)
       ON CONFLICT (user_id, daily_session_id, topic_key) DO NOTHING`,
      [
        createUuidV7(input.now),
        input.command.userId,
        input.command.dailySessionId,
        input.revision.revisionId,
        input.mentionIdsByProposalIndex.get(clarification.mentionProposalIndex) ??
          null,
        clarification.topicKey,
        clarification.semanticImpact,
        clarification.questionText,
        input.now,
      ],
    );
  }
  for (const disposition of input.priorClarificationDispositions) {
    if (disposition.disposition === "keep") continue;
    await client.query(
      `UPDATE entity_clarification_proposals
       SET status = $1, decided_at = $2, decided_by_event_revision_id = $3
       WHERE entity_clarification_proposal_id = $4
         AND user_id = $5 AND status = 'committed'`,
      [
        disposition.disposition === "resolved" ? "resolved" : "dropped",
        input.now,
        input.revision.revisionId,
        disposition.proposalId,
        input.command.userId,
      ],
    );
  }

  return { outcome: "committed", candidateIds };
}
