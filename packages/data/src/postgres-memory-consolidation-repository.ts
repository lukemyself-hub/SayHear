import {
  type AdmissionRejectionCode,
  admittedClaimIdentityFor,
  MEMORY_ADMISSION_POLICY_VERSION,
  addDaysToDateString,
  asUserId,
  type AdmissibleEvidence,
  type ClaimAdmissionPlan,
  type ConsolidationCandidateEvidenceView,
  type ConsolidationCandidateView,
  type ConsolidationClaimView,
  type ConsolidationDiffOutcomeRecord,
  type ConsolidationRunCounters,
  type MemoryCandidateProposal,
  type MemoryCandidateRecord,
  type MemoryClaimVersionRecord,
  type MemoryConsolidateDiff,
  type MemoryConsolidationCommandContext,
  type MemoryConsolidationKind,
  type MemoryConsolidationRepository,
  type MemoryConsolidationRunStatus,
  type RegistryEntryLookup,
  dedupeFingerprint,
  relationshipHintInputsFor,
  retrievalProjectionInputsFor,
  dateOrdinal,
  evidenceCutoff,
  type CommitConsolidationRunResult,
  localDateAt,
  type QueueDueConsolidationResult,
  type MemoryConsolidateDiffProposal,
  planAggregateProposal,
  planClaimAdmission,
  planImpressionDormancy,
  planRejectionDisposition,
  planStaleDisposition,
  PREDICATE_REGISTRY_RUNTIME_VERSION,
  weekStartDate,
  candidateSemanticTarget,
  asMemoryCandidateId,
  asDailySessionId,
} from "@sayhear/application";
import type { Pool, PoolClient } from "pg";

import { lockActiveOwnerEpoch } from "./postgres-owner-epoch-fence";
import {
  CANDIDATE_COLUMNS,
  rowToCandidate,
  type ClaimVersionRow,
  VERSION_COLUMNS,
  executeClaimAdmissionPlanWithin,
  executeDormancyPlanWithin,
  findTerminalCandidateByFingerprintWithin,
  findTerminalGovernanceBlockWithin,
  insertCandidateEvidenceLinksWithin,
  insertMemoryCandidateWithin,
  listClaimVersionQualifiersWithin,
  recordCandidateDispositionWithin,
  rowToVersion,
} from "./postgres-memory-claim-repository";
import { createUuidV7 } from "./uuid-v7";

/**
 * Slow-path consolidation persistence (issue #114). The per-run commit is a
 * single transaction behind the owner epoch fence: every model diff reference
 * is re-validated, the deterministic admission planners decide each outcome,
 * the weekly dormancy pass and the sweeper deadlines run deterministically,
 * and the run row (UNIQUE per user + kind + anchor + policy) is written in
 * the same transaction so workflow retries can never double-execute a
 * completed run (SPEC story 30, AC 9).
 */

type CommandRow = Readonly<{
  workflow_command_id: string;
  command_type: string;
  subject_id: string;
  source_revision: string;
  policy_version: string;
  expected_data_epoch: string;
  status: string;
}>;

const KIND_BY_COMMAND_TYPE: Readonly<Record<string, MemoryConsolidationKind>> = {
  daily_consolidation: "daily",
  weekly_consolidation: "weekly",
  memory_sweeper: "sweeper",
};

const COMMAND_TYPE_BY_KIND: Readonly<Record<MemoryConsolidationKind, string>> = {
  daily: "daily_consolidation",
  weekly: "weekly_consolidation",
  sweeper: "memory_sweeper",
};

const EVENT_TYPE_BY_KIND: Readonly<Record<MemoryConsolidationKind, string>> = {
  daily: "daily_consolidation_requested",
  weekly: "weekly_consolidation_requested",
  sweeper: "memory_sweeper_requested",
};

// Versioned scan / execution bounds. Internal-Core scale keeps these far
// above any real volume; they exist so one runaway scan cannot hold a
// transaction open indefinitely.
const MAX_DAILY_DATES_PER_SCAN = 400;
const MAX_WEEKS_PER_SCAN = 520;
const MAX_MODEL_INPUT_CANDIDATES = 500;
const MAX_MODEL_INPUT_CLAIMS = 500;
const MAX_DIFFS_PER_RUN = 500;
const MAX_SWEEPER_ROWS_PER_PASS = 500;
const WEEKLY_DIFF_INDEX_BASE = 10_000;

function ordinalToAnchorDate(sourceRevision: string): string {
  const digits = sourceRevision.padStart(8, "0");
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export class PostgresMemoryConsolidationRepository
  implements MemoryConsolidationRepository
{
  public constructor(private readonly pool: Pool) {}

  public async loadPolicy(
    policyVersion: string,
  ): Promise<{ version: string } | null> {
    const result = await this.pool.query(
      `SELECT policy_version FROM memory_consolidation_policies
       WHERE policy_version = $1`,
      [policyVersion],
    );
    return result.rows[0]
      ? { version: policyVersion }
      : null;
  }

  // ── Cron scan surface ─────────────────────────────────────────────────────

  public async queueDueCommands(input: {
    now: Date;
    policyVersion: string;
  }): Promise<QueueDueConsolidationResult> {
    const client = await this.pool.connect();
    const counters = { daily: 0, weekly: 0, sweeper: 0, reArmed: 0 };
    try {
      await client.query("BEGIN");
      const policy = await client.query(
        `SELECT 1 FROM memory_consolidation_policies WHERE policy_version = $1`,
        [input.policyVersion],
      );
      if (policy.rowCount !== 1) {
        throw new Error(
          "Memory consolidation policy is unavailable or has drifted.",
        );
      }
      const users = await client.query<{
        user_id: string;
        timezone: string;
        first_date: string;
      }>(
        `SELECT session.user_id,
                (array_agg(session.timezone_at_start
                  ORDER BY session.started_at DESC, session.daily_session_id))[1] AS timezone,
                MIN(session.logical_date)::text AS first_date
         FROM daily_sessions session
         INNER JOIN app_users owner
           ON owner.user_id = session.user_id AND owner.status = 'active'
         GROUP BY session.user_id`,
      );
      for (const user of users.rows) {
        const today = localDateAt(input.now, user.timezone);
        // Daily: every session date that has fully elapsed locally (a later
        // logical date can never join it) without a completed run.
        const dueDaily = await client.query<{ logical_date: string }>(
          `SELECT DISTINCT logical_date::text FROM daily_sessions
           WHERE user_id = $1 AND logical_date < $2::date
             AND NOT EXISTS (
               SELECT 1 FROM memory_consolidation_runs run
               WHERE run.user_id = $1
                 AND run.consolidation_kind = 'daily'
                 AND run.anchor_date = daily_sessions.logical_date
                 AND run.policy_version = $3
                 AND run.status IN ('consolidated', 'stale_source')
             )
           ORDER BY logical_date
           LIMIT ${MAX_DAILY_DATES_PER_SCAN}`,
          [user.user_id, today, input.policyVersion],
        );
        for (const row of dueDaily.rows) {
          const inserted = await insertConsolidationCommand(client, {
            userId: user.user_id,
            kind: "daily",
            anchorDate: row.logical_date,
            policyVersion: input.policyVersion,
            now: input.now,
          });
          if (inserted.eventInserted) {
            counters.daily += 1;
            if (inserted.commandExisted) counters.reArmed += 1;
          }
        }

        // Weekly: every fully elapsed ISO week from the first session week
        // that had activity or memory state, without a completed run. The
        // user's timezone keeps the boundary in the domain layer.
        let week = weekStartDate(user.first_date);
        let scannedWeeks = 0;
        while (
          addDaysToDateString(week, 7) <= today &&
          scannedWeeks < MAX_WEEKS_PER_SCAN
        ) {
          const weekEnd = addDaysToDateString(week, 6);
          const due = await client.query<{ due: boolean }>(
            `SELECT (
               EXISTS (
                 SELECT 1 FROM daily_sessions
                 WHERE user_id = $1 AND logical_date BETWEEN $2::date AND $3::date
               )
               OR EXISTS (
                 SELECT 1 FROM memory_claims
                 WHERE user_id = $1 AND deleted_at IS NULL AND created_at < $4::timestamptz
               )
             ) AND NOT EXISTS (
               SELECT 1 FROM memory_consolidation_runs run
               WHERE run.user_id = $1
                 AND run.consolidation_kind = 'weekly'
                 AND run.anchor_date = $2::date
                 AND run.policy_version = $5
                 AND run.status IN ('consolidated', 'stale_source')
             ) AS due`,
            [
              user.user_id,
              week,
              weekEnd,
              `${addDaysToDateString(weekEnd, 1)}T00:00:00.000Z`,
              input.policyVersion,
            ],
          );
          if (due.rows[0]?.due) {
            const inserted = await insertConsolidationCommand(client, {
              userId: user.user_id,
              kind: "weekly",
              anchorDate: week,
              policyVersion: input.policyVersion,
              now: input.now,
            });
            if (inserted.eventInserted) {
              counters.weekly += 1;
              if (inserted.commandExisted) counters.reArmed += 1;
            }
          }
          week = addDaysToDateString(week, 7);
          scannedWeeks += 1;
        }

        // Sweeper: one command per local day whenever a deadline-bound row
        // exists. The passes themselves are idempotent, so scan cadence only
        // bounds detection latency, never correctness (ADR-0048 / ADR-0051).
        const sweeperDue = await client.query<{ due: boolean }>(
          `SELECT (
             EXISTS (
               SELECT 1 FROM memory_candidates
               WHERE user_id = $1 AND content_purged_at IS NULL AND (
                 (status = 'needs_predicate_review' AND review_due_at <= $2)
                 OR (status = 'awaiting_registry_release'
                     AND registry_release_due_at <= $2)
                 OR (status IN ('rejected', 'stale')
                     AND terminal_content_expires_at <= $2)
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM memory_consolidation_runs run
               WHERE run.user_id = $1
                 AND run.consolidation_kind = 'sweeper'
                 AND run.anchor_date = $3::date
                 AND run.policy_version = $4
                 AND run.status IN ('swept', 'stale_source')
             )
           ) AS due`,
          [user.user_id, input.now, today, input.policyVersion],
        );
        if (sweeperDue.rows[0]?.due) {
          const inserted = await insertConsolidationCommand(client, {
            userId: user.user_id,
            kind: "sweeper",
            anchorDate: today,
            policyVersion: input.policyVersion,
            now: input.now,
          });
          if (inserted.eventInserted) {
            counters.sweeper += 1;
            if (inserted.commandExisted) counters.reArmed += 1;
          }
        }
      }
      await client.query("COMMIT");
      return counters;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // ── Command read (frozen model input) ─────────────────────────────────────

  public async readCommand(input: {
    workflowCommandId: string;
    policyVersion: string;
  }): Promise<
    | Readonly<{ outcome: "not_found" }>
    | Readonly<{ outcome: "stale_source" }>
    | Readonly<{
        outcome: "ready";
        command: MemoryConsolidationCommandContext;
        existingRunStatus: MemoryConsolidationRunStatus | null;
      }>
  > {
    const client = await this.pool.connect();
    try {
      return await readCommandWithin(client, input);
    } finally {
      client.release();
    }
  }

  // ── The authoritative run commit ──────────────────────────────────────────

  public async commitConsolidationRun(input: {
    command: Readonly<{
      workflowCommandId: string;
      userId: string;
      kind: MemoryConsolidationKind;
      anchorDate: string;
      policyVersion: string;
      expectedDataEpoch: number;
    }>;
    diffs: readonly MemoryConsolidateDiff[];
    registry: RegistryEntryLookup;
    dedupeFingerprintSecret: string;
    lineage: Readonly<{
      modelAttemptId: string | null;
      consolidateConfigVersion: string | null;
      consolidateModelVersion: string | null;
      consolidatePromptVersion: string | null;
      roleFallbackUsed: boolean;
    }>;
    now: Date;
  }): Promise<CommitConsolidationRunResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await commitConsolidationRunWithin(client, input);
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
      kind: MemoryConsolidationKind;
      anchorDate: string;
      policyVersion: string;
      expectedDataEpoch: number;
    }>;
    lineage: Readonly<{
      modelAttemptId: string;
      consolidateConfigVersion: string;
      consolidateModelVersion: string;
      consolidatePromptVersion: string;
      roleFallbackUsed: boolean;
    }>;
    errorCode: string;
    now: Date;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const epoch = await lockActiveOwnerEpoch(client, input.command.userId);
      if (epoch !== null && epoch === input.command.expectedDataEpoch) {
        await client.query(
          `INSERT INTO memory_consolidation_runs (
             memory_consolidation_run_id, user_id, consolidation_kind,
             anchor_date, policy_version, workflow_command_id,
             expected_data_epoch, model_attempt_id, consolidate_config_version,
             consolidate_model_version, consolidate_prompt_version,
             role_fallback_used, status, error_code, created_at, updated_at
           ) VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12,
             'retryable_failed', $13, $14, $14)
           ON CONFLICT (user_id, consolidation_kind, anchor_date, policy_version)
           DO UPDATE SET status = 'retryable_failed',
             error_code = EXCLUDED.error_code,
             model_attempt_id = EXCLUDED.model_attempt_id,
             consolidate_config_version = EXCLUDED.consolidate_config_version,
             consolidate_model_version = EXCLUDED.consolidate_model_version,
             consolidate_prompt_version = EXCLUDED.consolidate_prompt_version,
             role_fallback_used = EXCLUDED.role_fallback_used,
             updated_at = EXCLUDED.updated_at
           WHERE memory_consolidation_runs.status = 'retryable_failed'`,
          [
            createUuidV7(input.now),
            input.command.userId,
            input.command.kind,
            input.command.anchorDate,
            input.command.policyVersion,
            input.command.workflowCommandId,
            input.command.expectedDataEpoch,
            input.lineage.modelAttemptId,
            input.lineage.consolidateConfigVersion,
            input.lineage.consolidateModelVersion,
            input.lineage.consolidatePromptVersion,
            input.lineage.roleFallbackUsed,
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
}

// ── Within-transaction implementations ──────────────────────────────────────

async function insertConsolidationCommand(
  client: PoolClient,
  input: {
    userId: string;
    kind: MemoryConsolidationKind;
    anchorDate: string;
    policyVersion: string;
    now: Date;
  },
): Promise<Readonly<{ eventInserted: boolean; commandExisted: boolean }>> {
  const owner = await client.query<{ data_epoch: string }>(
    `SELECT data_epoch::text FROM app_users
     WHERE user_id = $1 AND status = 'active'`,
    [input.userId],
  );
  const epoch = owner.rows[0];
  if (!epoch) {
    throw new Error("Consolidation command owner is missing or inactive.");
  }
  const commandId = createUuidV7(input.now);
  const inserted = await client.query(
    `INSERT INTO workflow_commands (
       workflow_command_id, command_type, subject_type, subject_id,
       source_revision, policy_version, expected_data_epoch, status, created_at
     ) VALUES ($1, $2, 'app_user', $3, $4, $5, $6, 'created', $7)
     ON CONFLICT DO NOTHING`,
    [
      commandId,
      COMMAND_TYPE_BY_KIND[input.kind],
      input.userId,
      dateOrdinal(input.anchorDate),
      input.policyVersion,
      Number(epoch.data_epoch),
      input.now,
    ],
  );
  const command = await client.query<{ workflow_command_id: string }>(
    `SELECT workflow_command_id FROM workflow_commands
     WHERE command_type = $1 AND subject_type = 'app_user'
       AND subject_id = $2 AND source_revision = $3 AND policy_version = $4`,
    [
      COMMAND_TYPE_BY_KIND[input.kind],
      input.userId,
      dateOrdinal(input.anchorDate),
      input.policyVersion,
    ],
  );
  const existingCommandId = command.rows[0]!.workflow_command_id;
  const existingEvent = await client.query<{
    outbox_event_id: string;
    status: string;
  }>(
    `SELECT outbox_event_id, status FROM outbox_events
     WHERE workflow_command_id = $1 AND event_type = $2`,
    [existingCommandId, EVENT_TYPE_BY_KIND[input.kind]],
  );
  if (existingEvent.rows[0]) {
    const event = existingEvent.rows[0];
    if (event.status === "pending" || event.status === "leased") {
      return { eventInserted: false, commandExisted: true };
    }
    // The due queries guarantee this anchor is not completed, so a dispatched
    // or dead-lettered event means a value-failure or crash: resurrect the
    // SAME event row for redelivery (the one-per-aggregate-event unique
    // index forbids a second row; re-arming in place preserves it).
    await client.query(
      `UPDATE outbox_events
       SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
           next_attempt_at = $2, attempt_count = 0, last_error_code = NULL
       WHERE outbox_event_id = $1`,
      [event.outbox_event_id, input.now],
    );
    return { eventInserted: true, commandExisted: true };
  }
  const event = await client.query(
    `INSERT INTO outbox_events (
       outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
       aggregate_revision, aggregate_data_epoch, aggregate_coverage,
       event_type, status, next_attempt_at, attempt_count, payload, created_at
     ) VALUES ($1, $2, 'app_user', $3, $4, $5, 0, $6, 'pending', $7, 0, $8::jsonb, $7)
     ON CONFLICT DO NOTHING`,
    [
      createUuidV7(input.now),
      existingCommandId,
      input.userId,
      dateOrdinal(input.anchorDate),
      Number(epoch.data_epoch),
      EVENT_TYPE_BY_KIND[input.kind],
      input.now,
      JSON.stringify({
        policyVersion: input.policyVersion,
        expectedDataEpoch: Number(epoch.data_epoch),
      }),
    ],
  );
  return {
    eventInserted: (event.rowCount ?? 0) > 0,
    commandExisted: (inserted.rowCount ?? 0) === 0,
  };
}

async function readCommandWithin(
  client: PoolClient,
  input: { workflowCommandId: string; policyVersion: string },
): Promise<
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "stale_source" }>
  | Readonly<{
      outcome: "ready";
      command: MemoryConsolidationCommandContext;
      existingRunStatus: MemoryConsolidationRunStatus | null;
    }>
> {
  const command = await client.query<CommandRow>(
    `SELECT workflow_command_id, command_type, subject_id,
            source_revision::text, policy_version, expected_data_epoch::text,
            status
     FROM workflow_commands
     WHERE workflow_command_id = $1
       AND command_type IN ('daily_consolidation', 'weekly_consolidation', 'memory_sweeper')
       AND subject_type = 'app_user'`,
    [input.workflowCommandId],
  );
  const commandRow = command.rows[0];
  if (!commandRow) return { outcome: "not_found" };
  const kind = KIND_BY_COMMAND_TYPE[commandRow.command_type]!;
  const anchorDate = ordinalToAnchorDate(commandRow.source_revision);
  if (commandRow.policy_version !== input.policyVersion) {
    // Commands from another policy version converge without executing; their
    // run rows are keyed under their own version and never double-run.
    return { outcome: "stale_source" };
  }

  const owner = await client.query<{ status: string; data_epoch: string }>(
    `SELECT status, data_epoch::text FROM app_users WHERE user_id = $1`,
    [commandRow.subject_id],
  );
  const ownerRow = owner.rows[0];
  if (!ownerRow || ownerRow.status !== "active") {
    return { outcome: "stale_source" };
  }

  const run = await client.query<{ status: MemoryConsolidationRunStatus }>(
    `SELECT status FROM memory_consolidation_runs
     WHERE user_id = $1 AND consolidation_kind = $2
       AND anchor_date = $3::date AND policy_version = $4`,
    [commandRow.subject_id, kind, anchorDate, input.policyVersion],
  );

  const modelInput = await loadModelInputWithin(client, {
    userId: commandRow.subject_id,
    kind,
    anchorDate,
    registryVersion: PREDICATE_REGISTRY_RUNTIME_VERSION,
  });

  return {
    outcome: "ready",
    command: {
      workflowCommandId: commandRow.workflow_command_id,
      userId: commandRow.subject_id,
      kind,
      anchorDate,
      policyVersion: commandRow.policy_version,
      expectedDataEpoch: Number(commandRow.expected_data_epoch),
      modelInput,
    },
    existingRunStatus: run.rows[0]?.status ?? null,
  };
}

async function loadModelInputWithin(
  client: PoolClient,
  input: {
    userId: string;
    kind: MemoryConsolidationKind;
    anchorDate: string;
    registryVersion: number;
  },
): Promise<MemoryConsolidationCommandContext["modelInput"]> {
  if (input.kind === "sweeper") {
    return null;
  }
  const cutoff = evidenceCutoff(input.kind, input.anchorDate);
  const candidates = await client.query<{
    memory_candidate_id: string;
    candidate_kind: "objective" | "impression";
    basis: "directly_stated" | "inferred";
    predicate_id: string | null;
    proposed_concept: string | null;
    proposed_object_value: unknown;
    proposed_scope_key: string | null;
    proposed_temporal_status: "current" | "ended" | "unknown";
    status: string;
  }>(
    `SELECT candidate.memory_candidate_id, candidate.candidate_kind,
            candidate.basis, candidate.predicate_id,
            candidate.proposed_concept, candidate.proposed_object_value,
            candidate.proposed_scope_key, candidate.proposed_temporal_status,
            candidate.status
     FROM memory_candidates candidate
     WHERE candidate.user_id = $1
       AND candidate.status IN ('proposed', 'needs_entity_resolution')
       AND candidate.content_purged_at IS NULL
       AND EXISTS (
         SELECT 1 FROM memory_candidate_evidence_links link
         INNER JOIN evidence_items item
           ON item.evidence_item_id = link.evidence_item_id
           AND item.user_id = link.user_id
         INNER JOIN evidence_source_snapshots snapshot
           ON snapshot.evidence_source_snapshot_id = item.evidence_source_snapshot_id
         INNER JOIN daily_sessions session
           ON session.daily_session_id = snapshot.daily_session_id
           AND session.user_id = link.user_id
         WHERE link.memory_candidate_id = candidate.memory_candidate_id
           AND link.user_id = $1
           AND session.logical_date <= $2::date
           AND item.status = 'active'
           AND item.source_actor = 'user'
           AND item.source_status IN ('final', 'corrected')
       )
     ORDER BY candidate.created_at, candidate.memory_candidate_id
     LIMIT ${MAX_MODEL_INPUT_CANDIDATES}`,
    [input.userId, cutoff],
  );
  const candidateIds = candidates.rows.map((row) => row.memory_candidate_id);
  const evidenceByCandidate = new Map<
    string,
    ConsolidationCandidateEvidenceView[]
  >();
  if (candidateIds.length > 0) {
    const evidence = await client.query<{
      memory_candidate_id: string;
      evidence_item_id: string;
      daily_session_id: string;
      logical_date: string;
    }>(
      `SELECT link.memory_candidate_id, item.evidence_item_id,
              snapshot.daily_session_id, session.logical_date::text
       FROM memory_candidate_evidence_links link
       INNER JOIN evidence_items item
         ON item.evidence_item_id = link.evidence_item_id
         AND item.user_id = link.user_id
       INNER JOIN evidence_source_snapshots snapshot
         ON snapshot.evidence_source_snapshot_id = item.evidence_source_snapshot_id
       INNER JOIN daily_sessions session
         ON session.daily_session_id = snapshot.daily_session_id
         AND session.user_id = link.user_id
       WHERE link.user_id = $1
         AND link.memory_candidate_id = ANY($2)
         AND session.logical_date <= $3::date
         AND item.status = 'active'
         AND item.source_actor = 'user'
         AND item.source_status IN ('final', 'corrected')
       ORDER BY link.memory_candidate_id, item.evidence_item_id`,
      [input.userId, candidateIds, cutoff],
    );
    for (const row of evidence.rows) {
      const list = evidenceByCandidate.get(row.memory_candidate_id) ?? [];
      list.push({
        evidenceItemId: row.evidence_item_id,
        dailySessionId: row.daily_session_id,
        logicalDate: row.logical_date,
      });
      evidenceByCandidate.set(row.memory_candidate_id, list);
    }
  }
  const claims = await client.query<{
    memory_claim_id: string;
    predicate_id: string;
    kind: "objective" | "impression";
    status: string;
    typed_value: unknown;
    scope_key: string;
  }>(
    `SELECT claim.memory_claim_id, claim.predicate_id, version.kind,
            version.status, version.typed_value, claim.scope_key
     FROM memory_claims claim
     INNER JOIN memory_claim_versions version
       ON version.memory_claim_version_id = claim.current_version_id
       AND version.user_id = claim.user_id
     WHERE claim.user_id = $1 AND claim.deleted_at IS NULL
     ORDER BY claim.created_at, claim.memory_claim_id
     LIMIT ${MAX_MODEL_INPUT_CLAIMS}`,
    [input.userId],
  );
  const candidateViews: ConsolidationCandidateView[] = candidates.rows.map(
    (row) => ({
      candidateId: row.memory_candidate_id,
      candidateKind: row.candidate_kind,
      basis: row.basis,
      predicateId: row.predicate_id,
      proposedConcept: row.proposed_concept,
      typedValue: stringifyTypedValue(row.proposed_object_value),
      scopeKey: row.proposed_scope_key ?? "",
      temporalStatus: row.proposed_temporal_status,
      status: row.status,
      evidence: evidenceByCandidate.get(row.memory_candidate_id) ?? [],
    }),
  );
  const claimViews: ConsolidationClaimView[] = claims.rows.map((row) => ({
    claimId: row.memory_claim_id,
    predicateId: row.predicate_id,
    kind: row.kind,
    status: row.status,
    typedValue: stringifyTypedValue(row.typed_value),
    scopeKey: row.scope_key,
  }));
  return {
    mode: input.kind,
    anchorDate: input.anchorDate,
    registryVersion: input.registryVersion,
    candidates: candidateViews,
    claims: claimViews,
  };
}

function stringifyTypedValue(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (Array.isArray(raw)) return JSON.stringify(raw);
  return typeof raw === "string" ? raw : String(raw);
}

type DiffExecutionContext = Readonly<{
  userId: string;
  kind: MemoryConsolidationKind;
  anchorDate: string;
  registry: RegistryEntryLookup;
  dedupeFingerprintSecret: string;
  lineage: Readonly<{
    modelAttemptId: string | null;
    consolidateModelVersion: string | null;
    consolidatePromptVersion: string | null;
  }>;
  now: Date;
}>;

async function commitConsolidationRunWithin(
  client: PoolClient,
  input: Parameters<MemoryConsolidationRepository["commitConsolidationRun"]>[0],
): Promise<CommitConsolidationRunResult> {
  const { command } = input;
  const epoch = await lockActiveOwnerEpoch(client, command.userId);
  if (epoch === null || epoch !== command.expectedDataEpoch) {
    return { outcome: "stale_source" };
  }
  const existing = await client.query<{
    memory_consolidation_run_id: string;
    status: MemoryConsolidationRunStatus;
  }>(
    `SELECT memory_consolidation_run_id, status
     FROM memory_consolidation_runs
     WHERE user_id = $1 AND consolidation_kind = $2
       AND anchor_date = $3::date AND policy_version = $4
     FOR UPDATE`,
    [command.userId, command.kind, command.anchorDate, command.policyVersion],
  );
  if (
    existing.rows[0] &&
    existing.rows[0].status !== "retryable_failed"
  ) {
    return { outcome: "already_consolidated" };
  }

  const runId = existing.rows[0]?.memory_consolidation_run_id ?? createUuidV7(input.now);
  const finalStatus = command.kind === "sweeper" ? "swept" : "consolidated";
  await client.query(
    `INSERT INTO memory_consolidation_runs (
       memory_consolidation_run_id, user_id, consolidation_kind, anchor_date,
       policy_version, workflow_command_id, expected_data_epoch,
       model_attempt_id, consolidate_config_version,
       consolidate_model_version, consolidate_prompt_version,
       role_fallback_used, status, error_code, created_at, updated_at
     ) VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, $14, $14)
     ON CONFLICT (user_id, consolidation_kind, anchor_date, policy_version)
     DO UPDATE SET
       workflow_command_id = EXCLUDED.workflow_command_id,
       model_attempt_id = EXCLUDED.model_attempt_id,
       consolidate_config_version = EXCLUDED.consolidate_config_version,
       consolidate_model_version = EXCLUDED.consolidate_model_version,
       consolidate_prompt_version = EXCLUDED.consolidate_prompt_version,
       role_fallback_used = EXCLUDED.role_fallback_used,
       status = EXCLUDED.status,
       error_code = NULL,
       updated_at = EXCLUDED.updated_at
     WHERE memory_consolidation_runs.status = 'retryable_failed'`,
    [
      runId,
      command.userId,
      command.kind,
      command.anchorDate,
      command.policyVersion,
      command.workflowCommandId,
      command.expectedDataEpoch,
      input.lineage.modelAttemptId,
      input.lineage.consolidateConfigVersion,
      input.lineage.consolidateModelVersion,
      input.lineage.consolidatePromptVersion,
      input.lineage.roleFallbackUsed,
      finalStatus,
      input.now,
    ],
  );

  const outcomes: ConsolidationDiffOutcomeRecord[] = [];
  const context: DiffExecutionContext = {
    userId: command.userId,
    kind: command.kind,
    anchorDate: command.anchorDate,
    registry: input.registry,
    dedupeFingerprintSecret: input.dedupeFingerprintSecret,
    lineage: {
      modelAttemptId: input.lineage.modelAttemptId,
      consolidateModelVersion: input.lineage.consolidateModelVersion,
      consolidatePromptVersion: input.lineage.consolidatePromptVersion,
    },
    now: input.now,
  };

  if (command.kind === "daily" || command.kind === "weekly") {
    let index = 0;
    for (const diff of input.diffs) {
      outcomes.push(await executeDiffWithin(client, context, diff, index));
      index += 1;
    }
  }
  if (command.kind === "weekly") {
    outcomes.push(...(await runWeeklyDormancyPassWithin(client, context)));
  }
  if (command.kind === "sweeper") {
    outcomes.push(...(await runSweeperWithin(client, context)));
  }

  for (const outcome of outcomes) {
    await client.query(
      `INSERT INTO memory_consolidation_diffs (
         memory_consolidation_diff_id, memory_consolidation_run_id, user_id,
         diff_index, diff_kind, memory_candidate_id, memory_claim_id,
         outcome, reason_code, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        createUuidV7(input.now),
        runId,
        command.userId,
        outcome.diffIndex,
        outcome.diffKind,
        outcome.memoryCandidateId,
        outcome.memoryClaimId,
        outcome.outcome,
        outcome.reasonCode,
        input.now,
      ],
    );
  }

  const counters = tallyCounters(outcomes);
  await client.query(
    `UPDATE memory_consolidation_runs
     SET diff_count = $2, promoted_count = $3, reinforced_count = $4,
         contested_count = $5, rejected_count = $6, skipped_count = $7,
         dormant_count = $8, staled_count = $9, purged_count = $10,
         updated_at = $11
     WHERE memory_consolidation_run_id = $1`,
    [
      runId,
      counters.diffCount,
      counters.promotedCount,
      counters.reinforcedCount,
      counters.contestedCount,
      counters.rejectedCount,
      counters.skippedCount,
      counters.dormantCount,
      counters.staledCount,
      counters.purgedCount,
      input.now,
    ],
  );
  return { outcome: finalStatus, counters, diffOutcomes: outcomes };
}

function tallyCounters(
  outcomes: readonly ConsolidationDiffOutcomeRecord[],
): ConsolidationRunCounters {
  const count = (value: string) =>
    outcomes.filter((outcome) => outcome.outcome === value).length;
  return {
    diffCount: outcomes.length,
    promotedCount: count("promoted"),
    reinforcedCount: count("reinforced"),
    contestedCount: count("contested"),
    rejectedCount: count("rejected"),
    skippedCount: count("skipped"),
    dormantCount: count("dormant"),
    staledCount: count("staled"),
    purgedCount: count("purged"),
  };
}

// ── Per-diff deterministic execution ────────────────────────────────────────

async function executeDiffWithin(
  client: PoolClient,
  context: DiffExecutionContext,
  diff: MemoryConsolidateDiff,
  index: number,
): Promise<ConsolidationDiffOutcomeRecord> {
  const record = (
    outcome: string,
    reasonCode: string,
    candidateId: string | null = null,
    claimId: string | null = null,
  ): ConsolidationDiffOutcomeRecord => ({
    diffIndex: index,
    diffKind: diff.kind,
    outcome,
    reasonCode,
    memoryCandidateId: candidateId,
    memoryClaimId: claimId,
  });

  if (diff.kind === "no_change") {
    return record("no_change", "model_no_change", diff.candidateId);
  }
  if (diff.kind === "mark_review_due" && diff.candidateId === null) {
    return record("skipped", "mark_review_due_requires_candidate");
  }

  const cutoff = evidenceCutoff(context.kind, context.anchorDate);
  let candidateId = "candidateId" in diff ? diff.candidateId : null;
  let proposalFromModel: MemoryConsolidateDiffProposal | null = null;

  if (diff.kind === "propose_new" && diff.candidateId === null) {
    proposalFromModel = diff.proposal;
  }

  // Aggregate proposals: the pure application planner owns the subject
  // binding, registry gate, and unmapped routing; this executor only
  // persists what it planned behind the terminal fences.
  if (proposalFromModel !== null) {
    const selfEntity = await findSelfEntityWithin(client, context.userId);
    if (!selfEntity) {
      return record("skipped", "self_entity_missing");
    }
    const eligibleEvidence = await describeEligibleEvidenceWithin(
      client,
      context.userId,
      proposalFromModel.evidenceItemIds,
      cutoff,
    );
    const planned = planAggregateProposal({
      proposalFromModel,
      registry: context.registry,
      selfEntityId: selfEntity.entityId,
      eligibleEvidence: eligibleEvidence.map(toAdmissibleEvidence),
      lineage: {
        modelAttemptId: context.lineage.modelAttemptId,
        modelVersion: context.lineage.consolidateModelVersion,
        promptVersion: context.lineage.consolidatePromptVersion,
      },
      userId: asUserId(context.userId),
      now: context.now,
    });
    if (planned.outcome === "skip") {
      return record("skipped", planned.reasonCode);
    }
    const fingerprint = dedupeFingerprint({
      secret: context.dedupeFingerprintSecret,
      userId: asUserId(context.userId),
      semanticTarget: semanticTargetOfProposal(planned.proposal),
      evidenceRevisionIds: eligibleEvidence.map((item) => item.sourceRevisionId),
      policyVersion: MEMORY_ADMISSION_POLICY_VERSION,
    });
    const terminal = await findTerminalCandidateByFingerprintWithin(
      client,
      asUserId(context.userId),
      fingerprint,
    );
    if (terminal) {
      return record("blocked_terminal", terminal.dispositionReasonCode);
    }
    const insertedId = await insertMemoryCandidateWithin(client, {
      proposal: planned.proposal,
      status: planned.status,
      reviewDueAt: planned.reviewDueAt,
      now: context.now,
    });
    await insertCandidateEvidenceLinksWithin(client, {
      userId: asUserId(context.userId),
      candidateId: asMemoryCandidateId(insertedId),
      evidenceItemIds: planned.proposal.evidenceItemIds,
      now: context.now,
    });
    candidateId = insertedId;
    if (planned.status === "needs_predicate_review") {
      return record(
        "recorded",
        "unmapped_concept_needs_predicate_review",
        insertedId,
      );
    }
  }

  // Candidate-bound diffs: deterministic re-validation, evidence attachment,
  // then the admission planner decides.
  const targetId = candidateId;
  if (targetId === null) {
    return record("skipped", "diff_requires_candidate");
  }
  if (diff.kind === "mark_review_due") {
    const claim = await client.query<{ memory_claim_id: string }>(
      `SELECT memory_claim_id FROM memory_claims
       WHERE user_id = $1 AND memory_claim_id = $2 AND deleted_at IS NULL`,
      [context.userId, diff.claimId],
    );
    if (!claim.rows[0]) {
      return record("skipped", "unknown_claim", targetId, diff.claimId);
    }
  }
  return admitCandidateWithin(client, context, targetId, record, diff);
}

type DiffRecordFn = (
  outcome: string,
  reasonCode: string,
  candidateId?: string | null,
  claimId?: string | null,
) => ConsolidationDiffOutcomeRecord;

/**
 * The single status gate over a locked candidate row: terminal candidates
 * never re-enter admission, accepted ones converge idempotently, and
 * governance-held ones wait for their human path.
 */
function candidateGateOutcome(
  candidate: MemoryCandidateRecord,
  record: DiffRecordFn,
  claimIdOfDiff: string | null,
): ConsolidationDiffOutcomeRecord | null {
  if (
    candidate.status === "rejected" ||
    candidate.status === "stale" ||
    candidate.status === "deleted"
  ) {
    return record("skipped", "candidate_terminal", candidate.memoryCandidateId, claimIdOfDiff);
  }
  if (candidate.status === "accepted") {
    return record("already_admitted", "converged_retry", candidate.memoryCandidateId, claimIdOfDiff);
  }
  if (
    candidate.status === "needs_predicate_review" ||
    candidate.status === "awaiting_registry_release"
  ) {
    return record("skipped", "candidate_awaiting_governance", candidate.memoryCandidateId, claimIdOfDiff);
  }
  return null;
}

/**
 * The deterministic admission executor — the exact MemoryClaimService
 * semantics re-run in-transaction over locked rows. The model's diff label is
 * advisory: the planner alone decides promote / reinforce / contest / fence /
 * reject (SPEC story 30).
 */
async function admitCandidateWithin(
  client: PoolClient,
  context: DiffExecutionContext,
  candidateId: string,
  record: DiffRecordFn,
  diff?: MemoryConsolidateDiff,
): Promise<ConsolidationDiffOutcomeRecord> {
  const claimIdOfDiff =
    diff && diff.kind === "mark_review_due" ? diff.claimId : null;
  const candidate = await loadCandidateForUpdateWithin(
    client,
    context.userId,
    candidateId,
  );
  if (!candidate) {
    return record("skipped", "unknown_candidate", candidateId, claimIdOfDiff);
  }
  const gated = candidateGateOutcome(candidate, record, claimIdOfDiff);
  if (gated) {
    return gated;
  }
  // Attach the diff-cited eligible evidence after the gate so terminal or
  // governance-held candidates never accumulate proposal links.
  if (diff && "evidenceItemIds" in diff && diff.evidenceItemIds.length > 0) {
    const cutoff = evidenceCutoff(context.kind, context.anchorDate);
    const eligible = await describeEligibleEvidenceWithin(
      client,
      context.userId,
      diff.evidenceItemIds,
      cutoff,
    );
    if (eligible.length > 0) {
      await insertCandidateEvidenceLinksWithin(client, {
        userId: asUserId(context.userId),
        candidateId: asMemoryCandidateId(candidateId),
        evidenceItemIds: eligible.map((item) => item.evidenceItemId),
        now: context.now,
      });
    }
  }
  if (candidate.resolutionStatus !== "mapped" || !candidate.predicateId) {
    const rejected = await rejectCandidateWithin(
      client,
      context,
      candidate,
      "predicate_unmapped",
    );
    return record(
      rejected ? "rejected" : "skipped",
      "predicate_unmapped",
      candidateId,
      claimIdOfDiff,
    );
  }
  const registryEntry = context.registry.entryFor(candidate.predicateId);
  if (!registryEntry || registryEntry.status !== "active") {
    const rejected = await rejectCandidateWithin(
      client,
      context,
      candidate,
      "predicate_not_active",
    );
    return record(
      rejected ? "rejected" : "skipped",
      "predicate_not_active",
      candidateId,
      claimIdOfDiff,
    );
  }
  const selfEntity = await findSelfEntityWithin(client, context.userId);
  if (!selfEntity) {
    return record("skipped", "self_entity_missing", candidateId, claimIdOfDiff);
  }
  const evidenceItemIds = await listCandidateEvidenceItemIdsWithin(
    client,
    context.userId,
    candidateId,
  );
  const cutoff = evidenceCutoff(context.kind, context.anchorDate);
  const eligibleRows = await describeEligibleEvidenceWithin(
    client,
    context.userId,
    evidenceItemIds,
    cutoff,
  );
  const evidence = eligibleRows.map(toAdmissibleEvidence);
  if (evidence.length === 0) {
    return record(
      "skipped",
      "evidence_outside_anchor_or_ineligible",
      candidateId,
      claimIdOfDiff,
    );
  }
  // Registry-owned scope identity; see admittedClaimIdentityFor (#151).
  const admitted = admittedClaimIdentityFor(candidate, registryEntry, evidenceItemIds);
  const existingClaim = await findClaimByCanonicalKeyWithin(
    client,
    context.userId,
    admitted.canonicalKey,
  );
  const currentVersion = existingClaim?.currentVersionId
    ? await loadClaimVersionWithin(
        client,
        context.userId,
        existingClaim.currentVersionId,
      )
    : null;
  const entityIds = [candidate.subjectEntityId, candidate.objectEntityId].filter(
    (value): value is string => value !== null,
  );
  const entityVersions = await findCurrentEntityVersionsWithin(
    client,
    context.userId,
    entityIds,
  );
  const excludedEvidenceIds = existingClaim
    ? await listActiveExcludedEvidenceIdsWithin(
        client,
        context.userId,
        existingClaim.memoryClaimId,
      )
    : [];
  const excludedQualifierKeys = existingClaim
    ? await listActiveExcludedQualifierKeysWithin(
        client,
        context.userId,
        existingClaim.memoryClaimId,
      )
    : [];
  const excludedQualifierEvidence = existingClaim
    ? await listExcludedQualifierEvidenceWithin(
        client,
        context.userId,
        existingClaim.memoryClaimId,
      )
    : [];
  const currentVersionQualifiers =
    existingClaim && currentVersion && registryEntry.relationshipSemantics
      ? await listClaimVersionQualifiersWithin(
          client,
          asUserId(context.userId),
          currentVersion.memoryClaimVersionId,
        )
      : [];
  const relationshipHints = relationshipHintInputsFor(
    context.registry,
    registryEntry,
  );

  const plan = planClaimAdmission({
    proposal: admitted.proposal,
    registryEntry,
    registryVersion: context.registry.registryVersion(),
    selfEntityId: selfEntity.entityId,
    entityVersions,
    existingClaim: existingClaim
      ? { memoryClaimId: existingClaim.memoryClaimId, canonicalKey: admitted.canonicalKey }
      : null,
    currentVersion,
    currentVersionQualifiers,
    evidence,
    excludedEvidenceIds,
    excludedQualifierKeys,
    excludedQualifierEvidence,
  });

  // ADR-0041: a dormant Impression requalifies only through FRESH Evidence
  // (created after the dormancy commit). A consolidation aggregate citing
  // only pre-dormancy Evidence must not reactivate the Claim, whatever the
  // diff label proposes.
  if (
    plan.action === "promote" &&
    plan.conflictResolution === "dormancy_requalified" &&
    currentVersion !== null &&
    !eligibleRows.some(
      (row) => row.createdAt.getTime() > currentVersion.lastObservedAt.getTime(),
    )
  ) {
    return record(
      "below_impression_floor",
      "requalification_requires_fresh_evidence",
      candidateId,
      claimIdOfDiff,
    );
  }
  if (
    plan.action === "promote" ||
    plan.action === "contested" ||
    plan.action === "reinforce_current"
  ) {
    const executed = await executeClaimAdmissionPlanWithin(client, {
      userId: asUserId(context.userId),
      candidateId: asMemoryCandidateId(candidate.memoryCandidateId),
      plan,
      evidenceItemIds: evidence.map((item) => item.evidenceItemId),
      lineage: {
        extractionPolicyVersion: candidate.extractionPolicyVersion,
        generationCommandId: candidate.generationCommandId,
        authoritativeModelAttemptId: candidate.authoritativeModelAttemptId,
        modelVersion: candidate.modelVersion,
        promptVersion: candidate.promptVersion,
        sourceReflectionVersionId: candidate.sourceReflectionVersionId,
      },
      relationshipHints,
      retrievalProjection: retrievalProjectionInputsFor(
        context.registry,
        registryEntry,
      ),
      now: context.now,
    });
    await transitionCandidateWithin(client, context.userId, candidateId, [
      "proposed",
      "needs_entity_resolution",
    ], "accepted");
    if (plan.action === "promote") {
      return record(
        "promoted",
        plan.conflictResolution,
        candidateId,
        executed.memoryClaimId,
      );
    }
    if (plan.action === "contested") {
      return record(
        "contested",
        plan.conflictResolution,
        candidateId,
        executed.memoryClaimId,
      );
    }
    return record(
      "reinforced",
      plan.reasonCodes.join(",") || "reinforced_current",
      candidateId,
      executed.memoryClaimId,
    );
  }
  if (plan.action === "needs_entity_resolution") {
    await transitionCandidateWithin(client, context.userId, candidateId, [
      "proposed",
      "needs_entity_resolution",
    ], "needs_entity_resolution");
    return record(
      "needs_entity_resolution",
      plan.reasonCodes.join(","),
      candidateId,
      claimIdOfDiff,
    );
  }
  if (plan.action === "below_impression_floor") {
    return record(
      "below_impression_floor",
      `floor=${plan.floor.minEvidenceItems}e/${plan.floor.minDailySessions}s;actual=${plan.actual.evidenceItems}e/${plan.actual.dailySessions}s`,
      candidateId,
      claimIdOfDiff,
    );
  }
  if (plan.action === "pending_conflict") {
    return record(
      "pending_conflict",
      plan.reasonCodes.join(","),
      candidateId,
      claimIdOfDiff,
    );
  }
  if (plan.action === "blocked_forget_fence") {
    return record(
      "blocked_forget_fence",
      plan.reasonCodes.join(","),
      candidateId,
      existingClaim?.memoryClaimId ?? null,
    );
  }
  const rejected = await rejectCandidateWithin(
    client,
    context,
    candidate,
    plan.reasonCode,
  );
  return record(
    rejected ? "rejected" : "skipped",
    plan.reasonCode,
    candidateId,
    claimIdOfDiff,
  );
}

async function rejectCandidateWithin(
  client: PoolClient,
  context: DiffExecutionContext,
  candidate: MemoryCandidateRecord,
  reasonCode: AdmissionRejectionCode,
): Promise<boolean> {
  const evidence = (
    await describeEligibleEvidenceWithin(
      client,
      context.userId,
      await listCandidateEvidenceItemIdsWithin(
        client,
        context.userId,
        candidate.memoryCandidateId,
      ),
      null,
    )
  ).map(toAdmissibleEvidence);
  if (evidence.length === 0) return false;
  const plan = planRejectionDisposition({
    userId: context.userId,
    reasonCode,
    now: context.now,
    semanticTarget: candidateSemanticTarget({
      resolutionStatus: candidate.resolutionStatus,
      predicateId: candidate.predicateId,
      proposedConcept: candidate.proposedConcept,
      proposedObjectValue: candidate.proposedObjectValue,
      proposedScopeKey: candidate.proposedScopeKey ?? "",
      subjectEntityId: candidate.subjectEntityId,
      objectEntityId: candidate.objectEntityId,
    }),
    evidenceRevisionIds: evidence.map((item) => item.sourceRevisionId),
    secret: context.dedupeFingerprintSecret,
  });
  return recordCandidateDispositionWithin(
    client,
    asUserId(context.userId),
    asMemoryCandidateId(candidate.memoryCandidateId),
    plan,
    context.now,
  );
}

function semanticTargetOfProposal(proposal: MemoryCandidateProposal): string {
  return candidateSemanticTarget({
    resolutionStatus: proposal.resolution.status,
    predicateId:
      proposal.resolution.status === "mapped"
        ? proposal.resolution.predicateId
        : null,
    proposedConcept:
      proposal.resolution.status === "mapped"
        ? null
        : proposal.resolution.proposedConcept,
    proposedObjectValue:
      proposal.resolution.status === "mapped"
        ? proposal.resolution.typedValue
        : "",
    proposedScopeKey: proposal.scopeKey,
    subjectEntityId: proposal.subjectEntityId,
    objectEntityId: proposal.objectEntityId,
  });
}


// ── Weekly deterministic passes ─────────────────────────────────────────────

/**
 * The weekly review policy (ADR-0041): every active AI Impression gets its
 * 30-day dormancy check against its latest still-valid qualifying Evidence,
 * plus the evidence re-validation counts in the reason code. Dormancy itself
 * is deterministic — no model proposal participates.
 */
async function runWeeklyDormancyPassWithin(
  client: PoolClient,
  context: DiffExecutionContext,
): Promise<ConsolidationDiffOutcomeRecord[]> {
  const actives = await client.query<ClaimVersionRow>(
    `SELECT ${VERSION_COLUMNS.split(",")
         .map((column) => `version.${column.trim()}`)
         .join(", ")} FROM memory_claims claim
     INNER JOIN memory_claim_versions version
       ON version.memory_claim_version_id = claim.current_version_id
       AND version.user_id = claim.user_id
     WHERE claim.user_id = $1 AND claim.deleted_at IS NULL
       AND version.kind = 'impression' AND version.status = 'active'
     ORDER BY claim.memory_claim_id
     LIMIT ${MAX_MODEL_INPUT_CLAIMS}
     FOR UPDATE OF claim`,
    [context.userId],
  );
  const outcomes: ConsolidationDiffOutcomeRecord[] = [];
  let index = WEEKLY_DIFF_INDEX_BASE;
  for (const row of actives.rows) {
    const version = rowToVersion(row);
    const latestValidEvidenceAt = await latestValidEvidenceAtForVersionWithin(
      client,
      context.userId,
      version.memoryClaimVersionId,
    );
    const plan = planImpressionDormancy({
      currentVersion: version,
      latestQualifyingEvidenceAt: latestValidEvidenceAt,
      now: context.now,
    });
    if (plan.outcome === "go_dormant") {
      await executeDormancyPlanWithin(client, {
        userId: asUserId(context.userId),
        claimId: version.memoryClaimId,
        currentVersion: version,
        now: context.now,
      });
      outcomes.push({
        diffIndex: index,
        diffKind: "dormancy_check",
        outcome: "dormant",
        reasonCode: `review_deadline=${plan.reviewDeadline?.toISOString() ?? ""}`,
        memoryCandidateId: null,
        memoryClaimId: row.memory_claim_id,
      });
    } else {
      outcomes.push({
        diffIndex: index,
        diffKind: "dormancy_check",
        outcome: plan.outcome === "remain_active" ? "not_due" : "not_applicable",
        reasonCode: `review_deadline=${plan.reviewDeadline?.toISOString() ?? "none"}`,
        memoryCandidateId: null,
        memoryClaimId: row.memory_claim_id,
      });
    }
    index += 1;
  }
  return outcomes;
}

async function latestValidEvidenceAtForVersionWithin(
  client: PoolClient,
  userId: string,
  versionId: string,
): Promise<Date | null> {
  const result = await client.query<{ latest: Date | null }>(
    `SELECT MAX(item.created_at) AS latest
     FROM claim_evidence_links link
     INNER JOIN evidence_items item
       ON item.evidence_item_id = link.evidence_item_id
       AND item.user_id = link.user_id
     INNER JOIN evidence_source_snapshots snapshot
       ON snapshot.evidence_source_snapshot_id = item.evidence_source_snapshot_id
     WHERE link.user_id = $1
       AND link.memory_claim_version_id = $2
       AND link.status = 'active'
       AND link.link_role = 'support'
       AND item.status = 'active'
       AND item.source_actor = 'user'
       AND item.source_status IN ('final', 'corrected')`,
    [userId, versionId],
  );
  return result.rows[0]?.latest ?? null;
}

// ── Sweeper passes ──────────────────────────────────────────────────────────

async function runSweeperWithin(
  client: PoolClient,
  context: DiffExecutionContext,
): Promise<ConsolidationDiffOutcomeRecord[]> {
  const outcomes: ConsolidationDiffOutcomeRecord[] = [];
  const due = await client.query(
    `SELECT memory_candidate_id, status, review_due_at, registry_release_due_at
     FROM memory_candidates
     WHERE user_id = $1 AND content_purged_at IS NULL
       AND (
         (status = 'needs_predicate_review' AND review_due_at <= $2)
         OR (status = 'awaiting_registry_release'
             AND registry_release_due_at <= $2)
       )
     ORDER BY memory_candidate_id
     LIMIT ${MAX_SWEEPER_ROWS_PER_PASS}
     FOR UPDATE`,
    [context.userId, context.now],
  );
  let index = 0;
  for (const row of due.rows as readonly {
    memory_candidate_id: string;
    status: string;
    review_due_at: Date | null;
    registry_release_due_at: Date | null;
  }[]) {
    const staleReason =
      row.status === "needs_predicate_review"
        ? ("predicate_review_expired" as const)
        : ("registry_release_expired" as const);
    const originalDeadline =
      staleReason === "predicate_review_expired"
        ? row.review_due_at
        : row.registry_release_due_at;
    if (!originalDeadline) {
      outcomes.push({
        diffIndex: index,
        diffKind: "stale_candidate",
        outcome: "missing_original_deadline",
        reasonCode: "no_original_deadline",
        memoryCandidateId: row.memory_candidate_id,
        memoryClaimId: null,
      });
      index += 1;
      continue;
    }
    const evidence = (
      await describeEligibleEvidenceWithin(
        client,
        context.userId,
        await listCandidateEvidenceItemIdsWithin(
          client,
          context.userId,
          row.memory_candidate_id,
        ),
        null,
      )
    ).map(toAdmissibleEvidence);
    const candidate = await loadCandidateNoLockWithin(
      client,
      context.userId,
      row.memory_candidate_id,
    );
    if (!candidate) continue;
    const plan = planStaleDisposition({
      userId: context.userId,
      staleReason,
      originalDeadline,
      semanticTarget: candidateSemanticTarget({
        resolutionStatus: candidate.resolutionStatus,
        predicateId: candidate.predicateId,
        proposedConcept: candidate.proposedConcept,
        proposedObjectValue: candidate.proposedObjectValue,
        proposedScopeKey: candidate.proposedScopeKey ?? "",
        subjectEntityId: candidate.subjectEntityId,
        objectEntityId: candidate.objectEntityId,
      }),
      evidenceRevisionIds: evidence.map((item) => item.sourceRevisionId),
      secret: context.dedupeFingerprintSecret,
    });
    const applied = await recordCandidateDispositionWithin(
      client,
      asUserId(context.userId),
      asMemoryCandidateId(row.memory_candidate_id),
      plan,
      context.now,
    );
    outcomes.push({
      diffIndex: index,
      diffKind: "stale_candidate",
      outcome: applied ? "staled" : "already_terminal",
      reasonCode: staleReason,
      memoryCandidateId: row.memory_candidate_id,
      memoryClaimId: null,
    });
    index += 1;
  }

  // ADR-0051 sweep: clear the terminal candidates' derived semantics, keep
  // the contentless audit envelope (fingerprint, disposition, versions, dates).
  const purged = await client.query<{ memory_candidate_id: string }>(
    `UPDATE memory_candidates SET
       subject_entity_id = NULL,
       subject_entity_mention_id = NULL,
       object_entity_id = NULL,
       object_entity_mention_id = NULL,
       predicate_id = NULL,
       proposed_concept = NULL,
       mapping_confidence = NULL,
       proposed_object_value = NULL,
       proposed_scope_key = NULL,
       proposed_valid_from = NULL,
       proposed_valid_to = NULL,
       proposed_qualifiers = NULL,
       content_purged_at = $3
     WHERE user_id = $1
       AND status IN ('rejected', 'stale')
       AND terminal_content_expires_at <= $2
       AND content_purged_at IS NULL
     RETURNING memory_candidate_id`,
    [context.userId, context.now, context.now],
  );
  for (const row of purged.rows) {
    outcomes.push({
      diffIndex: index,
      diffKind: "purge_terminal_content",
      outcome: "purged",
      reasonCode: "terminal_content_expired",
      memoryCandidateId: row.memory_candidate_id,
      memoryClaimId: null,
    });
    index += 1;
  }
  return outcomes;
}

// ── Shared row helpers ──────────────────────────────────────────────────────

async function loadCandidateForUpdateWithin(
  client: PoolClient,
  userId: string,
  candidateId: string,
): Promise<MemoryCandidateRecord | null> {
  const result = await client.query(
    `SELECT ${CANDIDATE_COLUMNS} FROM memory_candidates
     WHERE user_id = $1 AND memory_candidate_id = $2
     FOR UPDATE`,
    [userId, candidateId],
  );
  return result.rows[0] ? rowToCandidate(result.rows[0]) : null;
}

async function loadCandidateNoLockWithin(
  client: PoolClient,
  userId: string,
  candidateId: string,
): Promise<MemoryCandidateRecord | null> {
  const result = await client.query(
    `SELECT ${CANDIDATE_COLUMNS} FROM memory_candidates
     WHERE user_id = $1 AND memory_candidate_id = $2`,
    [userId, candidateId],
  );
  return result.rows[0] ? rowToCandidate(result.rows[0]) : null;
}

async function findSelfEntityWithin(
  client: PoolClient,
  userId: string,
): Promise<{ entityId: string } | null> {
  const result = await client.query<{ entity_id: string }>(
    `SELECT entity_id FROM user_self_entities WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] ? { entityId: result.rows[0].entity_id } : null;
}

async function listCandidateEvidenceItemIdsWithin(
  client: PoolClient,
  userId: string,
  candidateId: string,
): Promise<readonly string[]> {
  const result = await client.query<{ evidence_item_id: string }>(
    `SELECT evidence_item_id FROM memory_candidate_evidence_links
     WHERE user_id = $1 AND memory_candidate_id = $2
     ORDER BY evidence_item_id`,
    [userId, candidateId],
  );
  return result.rows.map((row) => row.evidence_item_id);
}

type EligibleEvidenceRow = Readonly<{
  evidenceItemId: string;
  dailySessionId: string;
  sourceRevisionId: string;
  sourceActor: "user";
  sourceStatus: "final" | "corrected";
  status: "active";
  logicalDate: string;
  createdAt: Date;
}>;

/**
 * Evidence eligibility inside the run transaction: user-actor, final /
 * corrected, active — and (when `cutoff` is set) the source session's logical
 * date must fall inside the run's anchor window, so a diff can never smuggle
 * future evidence into an earlier consolidation.
 */
async function describeEligibleEvidenceWithin(
  client: PoolClient,
  userId: string,
  evidenceItemIds: readonly string[],
  cutoff: string | null,
): Promise<readonly EligibleEvidenceRow[]> {
  if (evidenceItemIds.length === 0) return [];
  const result = await client.query<{
    evidence_item_id: string;
    daily_session_id: string;
    source_revision_id: string;
    source_actor: string;
    source_status: string;
    status: string;
    logical_date: string;
    created_at: Date;
  }>(
    `SELECT item.evidence_item_id, snapshot.daily_session_id,
            item.source_revision_id, item.source_actor, item.source_status,
            item.status, session.logical_date::text, item.created_at
     FROM evidence_items item
     INNER JOIN evidence_source_snapshots snapshot
       ON snapshot.evidence_source_snapshot_id = item.evidence_source_snapshot_id
     INNER JOIN daily_sessions session
       ON session.daily_session_id = snapshot.daily_session_id
       AND session.user_id = item.user_id
     WHERE item.user_id = $1
       AND item.evidence_item_id = ANY($2)
       AND item.status = 'active'
       AND item.source_actor = 'user'
       AND item.source_status IN ('final', 'corrected')
       AND ($3::date IS NULL OR session.logical_date <= $3::date)`,
    [userId, [...evidenceItemIds], cutoff],
  );
  return result.rows.map((row) => ({
    evidenceItemId: row.evidence_item_id,
    dailySessionId: row.daily_session_id,
    sourceRevisionId: row.source_revision_id,
    sourceActor: row.source_actor as "user",
    sourceStatus: row.source_status as "final" | "corrected",
    status: row.status as "active",
    logicalDate: row.logical_date,
    createdAt: row.created_at,
  }));
}

function toAdmissibleEvidence(row: EligibleEvidenceRow): AdmissibleEvidence {
  return {
    evidenceItemId: row.evidenceItemId,
    dailySessionId: asDailySessionId(row.dailySessionId),
    sourceRevisionId: row.sourceRevisionId,
    sourceActor: row.sourceActor,
    sourceStatus: row.sourceStatus,
    status: row.status,
  };
}

async function findClaimByCanonicalKeyWithin(
  client: PoolClient,
  userId: string,
  canonicalKey: string,
): Promise<{ memoryClaimId: string; currentVersionId: string | null } | null> {
  const result = await client.query<{
    memory_claim_id: string;
    current_version_id: string | null;
  }>(
    `SELECT memory_claim_id, current_version_id FROM memory_claims
     WHERE user_id = $1 AND canonical_key = $2 AND deleted_at IS NULL`,
    [userId, canonicalKey],
  );
  const row = result.rows[0];
  return row
    ? {
        memoryClaimId: row.memory_claim_id,
        currentVersionId: row.current_version_id,
      }
    : null;
}

async function loadClaimVersionWithin(
  client: PoolClient,
  userId: string,
  versionId: string,
): Promise<MemoryClaimVersionRecord | null> {
  const result = await client.query<ClaimVersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM memory_claim_versions
     WHERE user_id = $1 AND memory_claim_version_id = $2`,
    [userId, versionId],
  );
  return result.rows[0] ? rowToVersion(result.rows[0]) : null;
}

async function findCurrentEntityVersionsWithin(
  client: PoolClient,
  userId: string,
  entityIds: readonly string[],
): Promise<
  Readonly<
    Record<
      string,
      Readonly<{ entityVersionId: string; status: string; entityKindId: string }> | null
    >
  >
> {
  const result: Record<
    string,
    { entityVersionId: string; status: string; entityKindId: string } | null
  > = {};
  for (const entityId of entityIds) {
    result[entityId] = null;
  }
  if (entityIds.length === 0) return result;
  const rows = await client.query<{
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
  for (const row of rows.rows) {
    result[row.entity_id] = {
      entityVersionId: row.entity_version_id,
      status: row.status,
      entityKindId: row.entity_kind_id,
    };
  }
  return result;
}

async function listActiveExcludedEvidenceIdsWithin(
  client: PoolClient,
  userId: string,
  claimId: string,
): Promise<readonly string[]> {
  const result = await client.query<{ evidence_item_id: string }>(
    `SELECT DISTINCT exclusion.evidence_item_id
     FROM memory_forget_evidence_exclusions exclusion
     JOIN claim_evidence_links link
       ON link.evidence_item_id = exclusion.evidence_item_id
     JOIN memory_claim_versions version
       ON version.memory_claim_version_id = link.memory_claim_version_id
     WHERE exclusion.user_id = $1
       AND version.memory_claim_id = $2
       AND exclusion.status = 'active'
       AND exclusion.exclusion_scope = 'whole_claim'
     ORDER BY evidence_item_id`,
    [userId, claimId],
  );
  return result.rows.map((row) => row.evidence_item_id);
}

async function listActiveExcludedQualifierKeysWithin(
  client: PoolClient,
  userId: string,
  claimId: string,
): Promise<readonly Readonly<{
  axisId: string;
  roleSide: "canonical_subject" | "counterpart";
}>[]> {
  const result = await client.query<{
    qualifier_key: string;
    canonical_side: "canonical_subject" | "counterpart";
  }>(
    `SELECT DISTINCT exclusion.qualifier_key,
            exclusion.canonical_side
     FROM memory_forget_evidence_exclusions exclusion
     INNER JOIN memory_forget_requests request
       ON request.memory_forget_request_id = exclusion.memory_forget_request_id
      AND request.user_id = exclusion.user_id
     WHERE exclusion.user_id = $1
       AND request.target_claim_id = $2
       AND exclusion.exclusion_scope = 'relationship_qualifier'
       AND exclusion.status = 'active'
       AND exclusion.qualifier_key IS NOT NULL
       AND exclusion.canonical_side IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM memory_forget_reversals reversal
         WHERE reversal.user_id = request.user_id
           AND reversal.memory_forget_request_id = request.memory_forget_request_id
           AND reversal.status = 'active'
       )
     ORDER BY exclusion.qualifier_key, exclusion.canonical_side`,
    [userId, claimId],
  );
  return result.rows.map((row) => ({
    axisId: row.qualifier_key,
    roleSide: row.canonical_side,
  }));
}

async function listExcludedQualifierEvidenceWithin(
  client: PoolClient,
  userId: string,
  claimId: string,
): Promise<readonly Readonly<{
  axisId: string;
  roleSide: "canonical_subject" | "counterpart";
  evidenceItemIds: readonly string[];
}>[]> {
  const result = await client.query<{
    evidence_item_id: string;
    qualifier_key: string;
    canonical_side: "canonical_subject" | "counterpart";
  }>(
    `SELECT exclusion.evidence_item_id::text,
            exclusion.qualifier_key,
            exclusion.canonical_side
     FROM memory_forget_evidence_exclusions exclusion
     INNER JOIN memory_forget_requests request
       ON request.memory_forget_request_id = exclusion.memory_forget_request_id
      AND request.user_id = exclusion.user_id
     WHERE exclusion.user_id = $1
       AND request.target_claim_id = $2
       AND exclusion.exclusion_scope = 'relationship_qualifier'
       AND exclusion.status = 'active'
       AND exclusion.qualifier_key IS NOT NULL
       AND exclusion.canonical_side IS NOT NULL
     ORDER BY exclusion.qualifier_key, exclusion.canonical_side,
              exclusion.evidence_item_id`,
    [userId, claimId],
  );
  const grouped = new Map<
    string,
    { axisId: string; roleSide: "canonical_subject" | "counterpart"; evidenceItemIds: string[] }
  >();
  for (const row of result.rows) {
    const key = `${row.qualifier_key}\u0000${row.canonical_side}`;
    const existing = grouped.get(key) ?? {
      axisId: row.qualifier_key,
      roleSide: row.canonical_side,
      evidenceItemIds: [],
    };
    existing.evidenceItemIds.push(row.evidence_item_id);
    grouped.set(key, existing);
  }
  return [...grouped.values()];
}

async function transitionCandidateWithin(
  client: PoolClient,
  userId: string,
  candidateId: string,
  fromStatuses: readonly ("proposed" | "needs_entity_resolution")[],
  toStatus: "proposed" | "needs_entity_resolution" | "accepted",
): Promise<boolean> {
  const result = await client.query<{ memory_candidate_id: string }>(
    `UPDATE memory_candidates SET status = $3
     WHERE user_id = $1 AND memory_candidate_id = $2 AND status = ANY($4::text[])
     RETURNING memory_candidate_id`,
    [userId, candidateId, toStatus, [...fromStatuses]],
  );
  return result.rows.length > 0;
}
