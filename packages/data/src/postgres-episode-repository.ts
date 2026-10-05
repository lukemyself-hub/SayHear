import type {
  DailySessionId,
  EpisodeVersionId,
  GenerationCommandId,
  ModelRunAttemptId,
  UserId,
  WorkflowCommandId,
} from "@sayhear/domain";
import {
  asDailySessionId,
  asEpisodeId,
  asEpisodeVersionId,
  asEvidenceItemId,
  asUserId,
  asWorkflowCommandId,
} from "@sayhear/domain";
import type {
  EpisodeBoundaryPrecision,
  EpisodeBuildRunOutcomeRow,
  EpisodeBuilderRepository,
  EpisodeContent,
  EpisodeEligibilitySnapshot,
  EpisodeFrozenBuildInput,
  EpisodeId,
  EpisodeKind,
  EpisodeMaintenanceSweepResult,
  EpisodeProposal,
  EpisodeTemporalAnchor,
} from "@sayhear/application";
import {
  EPISODE_ADMISSION_POLICY_VERSION,
  EPISODE_DEDUPE_FINGERPRINT_KEY_VERSION,
  EPISODE_KIND_CATALOG_V1,
  TERMINAL_CONTENT_EXPIRY_DAYS,
  EPISODE_UNRESOLVED_CANDIDATE_STALE_DAYS,
} from "@sayhear/application";
import {
  addDays,
  episodeDedupeFingerprint,
  episodeSemanticTarget,
  normalizeEpisodeKind,
  planEpisodeAdmission,
} from "@sayhear/application";
import type { Pool, PoolClient } from "pg";

import { createUuidV7 } from "./uuid-v7";
import { modelRoleAttemptIsRunning } from "./postgres-model-role-attempt-fence";

type EpisodeContentLike = {
  kind: string;
  label: string;
  temporalAnchor: {
    start: { date?: string; precision: string };
    end?: { date?: string; precision: string };
  };
  phase: string;
  kindFields: Record<string, string>;
};

type RawEvidenceRow = {
  evidence_item_id: string;
  locator_type: string;
  locator_key: string;
  source_status: "final" | "corrected";
  revision_id: string;
  canonical_text: string;
  locale: string | null;
};

type RawEpisodeRow = {
  episode_id: string;
  episode_kind_id: string;
  current_version_id: string;
  current_revision: number;
  label: string | null;
  content: EpisodeContentLike | null;
};

type RawEntityLinkRow = {
  episode_version_id: string;
  entity_id: string;
};

type InsertCandidateInput = Readonly<{
  candidateId: string;
  userId: UserId;
  dailySessionId: DailySessionId;
  sourceRevision: number;
  kind: string;
  label: string;
  anchor: EpisodeProposal["temporalAnchor"];
  phase: string;
  continuitySpan: string | null;
  resolutionStatus: "new" | "matched" | "unresolved";
  status: "proposed" | "accepted" | "rejected";
  existingEpisodeId: string | null;
  policyVersion: string;
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  fingerprint: string;
  /**
   * Owner-verified citations to persist on `episode_candidate_evidence_links`.
   * Callers must pre-filter to frozen owner Evidence; unknown / cross-owner
   * IDs are never linked (ADR-0087).
   */
  evidenceItemIds: readonly string[];
  /** Owner-resolvable Entity anchors for `episode_candidate_entity_links`. */
  entityAnchorIds: readonly string[];
  dispositionReasonCode?: string;
  decidedAt?: Date;
  terminalContentExpiresAt?: Date;
}>;

type InsertVersionInput = Readonly<{
  episodeId: string;
  userId: UserId;
  revision: number;
  supersedesVersionId: string | null;
  sourceRevision: number;
  kind: string;
  content: {
    kind: string;
    label: string;
    temporalAnchor: EpisodeProposal["temporalAnchor"];
    phase: string;
    kindFields: Record<string, string>;
  };
  policyVersion: string;
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  /**
   * Owner-verified citations to persist on `episode_evidence_links` for this
   * immutable version. Continuations pass predecessor links merged with the
   * newly admitted refs.
   */
  evidenceItemIds: readonly string[];
  /** Owner-resolvable Entity anchors for `episode_version_entity_links`. */
  entityAnchorIds: readonly string[];
  now: Date;
}>;

function dateOrdinal(date: Date): number {
  return Number(date.toISOString().slice(0, 10).replace(/-/g, ""));
}

function textAtLocator(
  canonicalText: string,
  locatorType: string,
  locatorKey: string,
): string | null {
  if (locatorType === "whole_revision") {
    return canonicalText;
  }
  const match = locatorKey.match(/^(-?\d+):(-?\d+)$/);
  if (!match) {
    return null;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end < start
    || end > canonicalText.length
  ) {
    return null;
  }
  return canonicalText.slice(start, end);
}

function storedAnchor(
  anchor: { start: { date?: string; precision: string }; end?: { date?: string; precision: string } },
): EpisodeTemporalAnchor {
  return {
    start: {
      ...(anchor.start.date !== undefined ? { date: anchor.start.date } : {}),
      precision: anchor.start.precision as EpisodeBoundaryPrecision,
    },
    ...(anchor.end
      ? {
          end: {
            ...(anchor.end.date !== undefined ? { date: anchor.end.date } : {}),
            precision: anchor.end.precision as EpisodeBoundaryPrecision,
          },
        }
      : {}),
  };
}

function anchorJson(anchor: EpisodeProposal["temporalAnchor"]): string {
  return JSON.stringify({
    start: anchor.start,
    ...(anchor.end ? { end: anchor.end } : {}),
  });
}

/**
 * PostgreSQL adapter for the daily Episode Builder (issue #197). Every
 * mutation runs inside one short transaction that locks the owner row and
 * re-verifies the data epoch and the session head, so late results can never
 * publish, and the current pointer never regresses.
 */
export class PostgresEpisodeRepository implements EpisodeBuilderRepository {
  public constructor(private readonly pool: Pool) {}

  public async readPolicyVersion(): Promise<string | null> {
    const result = await this.pool.query<{ policy_version: string }>(
      "SELECT policy_version FROM episode_policies ORDER BY created_at DESC LIMIT 1",
    );
    return result.rows[0]?.policy_version ?? null;
  }

  public async readDayScopeEnrichment(input: {
    userId: UserId;
    logicalDate: string;
    limit: number;
  }): Promise<
    readonly Readonly<{
      episodeId: EpisodeId;
      episodeVersionId: EpisodeVersionId;
      kind: EpisodeKind;
      label: string | null;
      content: EpisodeContent | null;
    }>[]
  > {
    const result = await this.pool.query<{
      episode_id: string;
      episode_version_id: string;
      episode_kind_id: string;
      label: string | null;
      content: EpisodeContentLike | null;
    }>(
      `SELECT e.episode_id, v.episode_version_id, e.episode_kind_id,
              v.label, v.content
       FROM episodes e
       INNER JOIN episode_versions v
         ON v.episode_version_id = e.current_version_id
       INNER JOIN app_users owner ON owner.user_id = e.user_id
       WHERE e.user_id = $1 AND e.status = 'active' AND owner.status = 'active'
         AND v.status = 'current' AND v.content_purged_at IS NULL
         AND v.enrichment_paused_at IS NULL
         AND EXISTS (
           SELECT 1 FROM episode_evidence_links link
           INNER JOIN evidence_items item
             ON item.evidence_item_id = link.evidence_item_id
           INNER JOIN conversation_events ev
             ON ev.conversation_event_id = item.source_event_id
           INNER JOIN daily_sessions s ON s.daily_session_id = ev.daily_session_id
           INNER JOIN conversation_event_revisions rev
             ON rev.conversation_event_revision_id = item.source_revision_id
           WHERE link.episode_version_id = v.episode_version_id
             AND item.status = 'active' AND ev.lifecycle_status = 'active'
             AND ev.current_revision_id = rev.conversation_event_revision_id
             AND rev.transcript_status IN ('final', 'corrected')
             AND rev.content_purged_at IS NULL
             AND s.logical_date = $2
         )
         AND NOT EXISTS (
           SELECT 1 FROM episode_version_entity_links l
           INNER JOIN entities e2
             ON e2.entity_id = l.entity_id AND e2.user_id = v.user_id
           WHERE l.episode_version_id = v.episode_version_id
             AND (e2.deleted_at IS NOT NULL OR e2.current_version_id IS NULL)
         )
       ORDER BY v.episode_version_id
       LIMIT $3`,
      [input.userId, input.logicalDate, input.limit],
    );
    return result.rows.map((row) => ({
      episodeId: asEpisodeId(row.episode_id),
      episodeVersionId: asEpisodeVersionId(row.episode_version_id),
      kind: normalizeEpisodeKind(row.episode_kind_id),
      label: row.label,
      content: row.content
        ? {
            kind: normalizeEpisodeKind(row.content.kind),
            label: row.content.label,
            temporalAnchor: storedAnchor(row.content.temporalAnchor),
            phase: row.content.phase as EpisodeContent["phase"],
            kindFields: row.content.kindFields,
          }
        : null,
    }));
  }

  public async listQuiescentSessionsNeedingBuild(input: {
    now: Date;
    policyVersion: string;
    limit: number;
  }): Promise<
    readonly Readonly<{
      dailySessionId: DailySessionId;
      userId: UserId;
      sourceRevision: number;
    }>[]
  > {
    const result = await this.pool.query<{
      daily_session_id: string;
      user_id: string;
      source_revision: string;
    }>(
      `SELECT s.daily_session_id, s.user_id, s.source_revision::text
       FROM daily_sessions s
       INNER JOIN app_users owner ON owner.user_id = s.user_id
       WHERE s.activity_state = 'quiescent' AND owner.status = 'active'
         AND EXISTS (
           SELECT 1 FROM evidence_source_snapshots snap
           INNER JOIN evidence_items item
             ON item.evidence_source_snapshot_id = snap.evidence_source_snapshot_id
           WHERE snap.daily_session_id = s.daily_session_id
             AND snap.source_revision = s.source_revision
             AND item.status = 'active'
         )
         AND NOT EXISTS (
           SELECT 1 FROM episode_build_runs run
           WHERE run.daily_session_id = s.daily_session_id
             AND run.source_revision = s.source_revision
             AND run.policy_version = $2
             AND run.status = 'built'
         )
       ORDER BY s.daily_session_id
       LIMIT $1`,
      [input.limit, input.policyVersion],
    );
    return result.rows.map((row) => ({
      dailySessionId: asDailySessionId(row.daily_session_id),
      userId: asUserId(row.user_id),
      sourceRevision: Number(row.source_revision),
    }));
  }

  public async queueEpisodeBuild(input: {
    dailySessionId: DailySessionId;
    sourceRevision: number;
    policyVersion: string;
  }): Promise<
    | Readonly<{
        outcome: "queued";
        workflowCommandId: WorkflowCommandId;
        userId: UserId;
        expectedDataEpoch: number;
      }>
    | Readonly<{ outcome: "already_queued" }>
    | Readonly<{ outcome: "not_found" }>
    | Readonly<{ outcome: "not_quiescent" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query<{
        user_id: string;
        source_revision: string;
        activity_state: string;
        data_epoch: string;
      }>(
        `SELECT s.user_id, s.source_revision::text, s.activity_state,
                owner.data_epoch::text
         FROM daily_sessions s
         INNER JOIN app_users owner ON owner.user_id = s.user_id
         WHERE s.daily_session_id = $1
         FOR UPDATE OF s`,
        [input.dailySessionId],
      );
      const row = session.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      if (
        Number(row.source_revision) !== input.sourceRevision
        || row.activity_state !== "quiescent"
      ) {
        await client.query("COMMIT");
        return { outcome: "not_quiescent" };
      }
      const expectedDataEpoch = Number(row.data_epoch);
      const inserted = await client.query<{
        workflow_command_id: string;
        fresh: boolean;
      }>(
        `INSERT INTO workflow_commands (
           workflow_command_id, command_type, subject_type, subject_id,
           source_revision, policy_version, expected_data_epoch,
           coverage_through_sequence_no, intent_key, status, created_at
         )
         VALUES ($1, 'episode_build', 'daily_session', $2, $3, $4, $5, 0, '', 'created', $6)
         ON CONFLICT (
           command_type, subject_type, subject_id, source_revision,
           expected_data_epoch, policy_version, coverage_through_sequence_no,
           intent_key
         ) DO UPDATE SET workflow_command_id = workflow_commands.workflow_command_id
         RETURNING workflow_command_id, (xmax = 0) AS fresh`,
        [
          createUuidV7(new Date()),
          input.dailySessionId,
          input.sourceRevision,
          input.policyVersion,
          expectedDataEpoch,
          new Date(),
        ],
      );
      const commandRow = inserted.rows[0]!;
      if (commandRow.fresh) {
        await client.query(
          `INSERT INTO outbox_events (
             outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
             aggregate_revision, aggregate_data_epoch, aggregate_coverage,
             event_type, intent_key, status, next_attempt_at, attempt_count,
             payload, created_at
           )
           VALUES ($1, $2, 'daily_session', $3, $4, $5, 0,
             'episode_build_requested', '', 'pending', $6, 0, $7::jsonb, $6)
           ON CONFLICT DO NOTHING`,
          [
            createUuidV7(new Date()),
            commandRow.workflow_command_id,
            input.dailySessionId,
            input.sourceRevision,
            expectedDataEpoch,
            new Date(),
            JSON.stringify({
              workflowCommandId: commandRow.workflow_command_id,
              subjectType: "daily_session",
              subjectId: input.dailySessionId,
              sourceRevision: input.sourceRevision,
              policyVersion: input.policyVersion,
              expectedDataEpoch,
              ownerId: row.user_id,
              eventType: "episode_build_requested",
            }),
          ],
        );
      }
      await client.query("COMMIT");
      return {
        outcome: "queued",
        workflowCommandId: asWorkflowCommandId(commandRow.workflow_command_id),
        userId: asUserId(row.user_id),
        expectedDataEpoch,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async queueEpisodeMaintenance(input: {
    userId: UserId;
    policyVersion: string;
  }): Promise<
    | Readonly<{ outcome: "queued"; workflowCommandId: WorkflowCommandId }>
    | Readonly<{ outcome: "already_queued" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ data_epoch: string }>(
        "SELECT data_epoch::text FROM app_users WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow) {
        await client.query("COMMIT");
        return { outcome: "already_queued" };
      }
      const sourceRevision = dateOrdinal(new Date());
      const inserted = await client.query<{
        workflow_command_id: string;
        fresh: boolean;
      }>(
        `INSERT INTO workflow_commands (
           workflow_command_id, command_type, subject_type, subject_id,
           source_revision, policy_version, expected_data_epoch,
           coverage_through_sequence_no, intent_key, status, created_at
         )
         VALUES ($1, 'episode_maintenance', 'app_user', $2, $3, $4, $5, 0, '', 'created', $6)
         ON CONFLICT (
           command_type, subject_type, subject_id, source_revision,
           expected_data_epoch, policy_version, coverage_through_sequence_no,
           intent_key
         ) DO UPDATE SET workflow_command_id = workflow_commands.workflow_command_id
         RETURNING workflow_command_id, (xmax = 0) AS fresh`,
        [
          createUuidV7(new Date()),
          input.userId,
          sourceRevision,
          input.policyVersion,
          Number(ownerRow.data_epoch),
          new Date(),
        ],
      );
      const commandRow = inserted.rows[0]!;
      if (commandRow.fresh) {
        await client.query(
          `INSERT INTO outbox_events (
             outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
             aggregate_revision, aggregate_data_epoch, aggregate_coverage,
             event_type, intent_key, status, next_attempt_at, attempt_count,
             payload, created_at
           )
           VALUES ($1, $2, 'app_user', $3, $4, $5, 0,
             'episode_maintenance_requested', '', 'pending', $6, 0, $7::jsonb, $6)
           ON CONFLICT DO NOTHING`,
          [
            createUuidV7(new Date()),
            commandRow.workflow_command_id,
            input.userId,
            sourceRevision,
            Number(ownerRow.data_epoch),
            new Date(),
            JSON.stringify({
              workflowCommandId: commandRow.workflow_command_id,
              subjectType: "app_user",
              subjectId: input.userId,
              sourceRevision,
              policyVersion: input.policyVersion,
              expectedDataEpoch: Number(ownerRow.data_epoch),
              eventType: "episode_maintenance_requested",
            }),
          ],
        );
      }
      await client.query("COMMIT");
      return {
        outcome: commandRow.fresh ? "queued" : "already_queued",
        workflowCommandId: asWorkflowCommandId(commandRow.workflow_command_id),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async readSessionSnapshot(input: {
    dailySessionId: DailySessionId;
    sourceRevision: number;
    policyVersion: string;
  }): Promise<
    | Readonly<{
        outcome: "evaluated";
        snapshot: EpisodeEligibilitySnapshot;
        frozen: EpisodeFrozenBuildInput;
      }>
    | Readonly<{ outcome: "not_found" }>
    | Readonly<{ outcome: "not_quiescent" }>
    | Readonly<{ outcome: "stale_source" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query<{
        user_id: string;
        source_revision: string;
        activity_state: string;
        logical_date: string;
        data_epoch: string;
      }>(
        `SELECT s.user_id, s.source_revision::text, s.activity_state,
                s.logical_date::text, owner.data_epoch::text
         FROM daily_sessions s
         INNER JOIN app_users owner ON owner.user_id = s.user_id
         WHERE s.daily_session_id = $1
         FOR UPDATE OF s`,
        [input.dailySessionId],
      );
      const row = session.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      if (Number(row.source_revision) !== input.sourceRevision) {
        await client.query("COMMIT");
        return { outcome: "stale_source" };
      }
      if (row.activity_state !== "quiescent") {
        await client.query("COMMIT");
        return { outcome: "not_quiescent" };
      }
      const frozen = await this.loadFrozenBuildInputWithin(client, {
        userId: asUserId(row.user_id),
        dailySessionId: input.dailySessionId,
        sourceRevision: input.sourceRevision,
      });
      if (!frozen) {
        await client.query("COMMIT");
        return { outcome: "stale_source" };
      }
      const snapshot: EpisodeEligibilitySnapshot = {
        userId: asUserId(row.user_id),
        dailySessionId: input.dailySessionId,
        logicalDate: row.logical_date,
        sourceRevision: input.sourceRevision,
        activityState: "quiescent",
        ownerEpoch: Number(row.data_epoch),
      };
      await client.query("COMMIT");
      return { outcome: "evaluated", snapshot, frozen };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async readAttemptContext(input: {
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
  }): Promise<
    | Readonly<{
        outcome: "evaluated";
        userId: UserId;
        dailySessionId: DailySessionId;
        sourceRevision: number;
        policyVersion: string;
        expectedDataEpoch: number;
        attemptNo: number;
        attemptStatus: "prepared";
        frozen: EpisodeFrozenBuildInput;
      }>
    | Readonly<{ outcome: "settled" }>
    | Readonly<{ outcome: "not_found" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const command = await client.query<{
        user_id: string;
        subject_id: string;
        source_revision: string;
        expected_data_epoch: string;
      }>(
        `SELECT gc.user_id, gc.subject_id, gc.source_revision::text,
                gc.expected_data_epoch::text
         FROM generation_commands gc
         INNER JOIN model_run_attempts a
           ON a.generation_command_id = gc.generation_command_id
         WHERE gc.generation_command_id = $1 AND a.model_run_attempt_id = $2`,
        [input.generationCommandId, input.modelRunAttemptId],
      );
      const commandRow = command.rows[0];
      if (!commandRow) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      const attempt = await client.query<{
        status: string;
        attempt_no: number;
      }>(
        `SELECT status, attempt_no FROM model_run_attempts
         WHERE model_run_attempt_id = $1`,
        [input.modelRunAttemptId],
      );
      const attemptRow = attempt.rows[0];
      if (!attemptRow || attemptRow.status !== "prepared") {
        await client.query("COMMIT");
        return { outcome: "settled" };
      }
      const dailySessionId = asDailySessionId(commandRow.subject_id);
      const frozen = await this.loadFrozenBuildInputWithin(client, {
        userId: asUserId(commandRow.user_id),
        dailySessionId,
        sourceRevision: Number(commandRow.source_revision),
      });
      if (!frozen) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      await client.query("COMMIT");
      return {
        outcome: "evaluated",
        userId: asUserId(commandRow.user_id),
        dailySessionId,
        sourceRevision: Number(commandRow.source_revision),
        policyVersion: EPISODE_ADMISSION_POLICY_VERSION,
        expectedDataEpoch: Number(commandRow.expected_data_epoch),
        attemptNo: attemptRow.attempt_no,
        attemptStatus: "prepared" as const,
        frozen,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async commitEpisodeAdmission(input: {
    userId: UserId;
    dailySessionId: DailySessionId;
    sourceRevision: number;
    policyVersion: string;
    expectedDataEpoch: number;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    proposals: readonly EpisodeProposal[];
    dedupeFingerprintSecret: string;
  }): Promise<
    | Readonly<{
        outcome: "committed" | "already_built";
        candidateCount: number;
        acceptedCount: number;
        unresolvedCount: number;
        rejectedCount: number;
      }>
    | Readonly<{ outcome: "fenced"; reason: string }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await modelRoleAttemptIsRunning(client, input))) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "attempt_settled" };
      }
      const owner = await client.query<{ status: string; data_epoch: string }>(
        "SELECT status, data_epoch::text FROM app_users WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow || ownerRow.status !== "active") {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "owner" };
      }
      if (Number(ownerRow.data_epoch) !== input.expectedDataEpoch) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "data_epoch" };
      }
      const session = await client.query<{ source_revision: string }>(
        `SELECT source_revision::text FROM daily_sessions
         WHERE daily_session_id = $1 AND user_id = $2 FOR UPDATE`,
        [input.dailySessionId, input.userId],
      );
      const sessionRow = session.rows[0];
      if (
        !sessionRow
        || Number(sessionRow.source_revision) !== input.sourceRevision
      ) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "source_head" };
      }
      const activePin = await client.query<{ rollout_pin: string }>(
        `SELECT rollout_pin FROM model_role_rollout_pins
         WHERE role = 'episode.build' AND status = 'active'
         ORDER BY activated_at DESC LIMIT 1`,
      );
      if (!activePin.rows[0]) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "rollout_pin" };
      }

      const existingRun = await client.query<{ status: string }>(
        `SELECT status FROM episode_build_runs
         WHERE user_id = $1 AND daily_session_id = $2
           AND source_revision = $3 AND policy_version = $4
         FOR UPDATE`,
        [
          input.userId,
          input.dailySessionId,
          input.sourceRevision,
          input.policyVersion,
        ],
      );
      if (existingRun.rows[0]?.status === "built") {
        await client.query("COMMIT");
        return {
          outcome: "already_built",
          candidateCount: 0,
          acceptedCount: 0,
          unresolvedCount: 0,
          rejectedCount: 0,
        };
      }

      const frozen = await this.loadFrozenBuildInputWithin(client, {
        userId: input.userId,
        dailySessionId: input.dailySessionId,
        sourceRevision: input.sourceRevision,
      });
      if (!frozen) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "source_snapshot_missing" };
      }

      const now = new Date();
      let candidateCount = 0;
      let acceptedCount = 0;
      let unresolvedCount = 0;
      let rejectedCount = 0;

      // Only frozen owner Evidence and owner-resolvable Entities may ever be
      // linked. The plan gate already rejects unknown refs, but rejected and
      // unresolved proposals are persisted too, so the intersection is
      // enforced here for every candidate (ADR-0087).
      const frozenEvidenceIds = new Set<string>(
        frozen.evidence.map((item) => item.evidenceItemId),
      );
      const frozenEntityIds = new Set<string>(frozen.resolvableEntityIds);

      // A single admission batch may contain more than one continuation of the
      // same Episode. Each continuation must chain onto the most recent
      // in-batch successor rather than the frozen snapshot, or two inserts
      // collide on the (episode_id, revision) unique constraint.
      const inBatchEpisodeSuccessors = new Map<
        string,
        Readonly<{ versionId: string; revision: number }>
      >();

      for (const proposal of input.proposals) {
        const plan = planEpisodeAdmission({
          proposal,
          request: {
            userId: input.userId,
            dailySessionId: input.dailySessionId,
            sourceRevision: input.sourceRevision,
            kindCatalog: EPISODE_KIND_CATALOG_V1,
            evidence: frozen.evidence,
            activeEpisodes: frozen.activeEpisodes,
          },
          resolvableEntityIds: frozen.resolvableEntityIds,
        });
        const evidenceRevisionIds = [
          ...new Set(
            frozen.evidence
              .filter((item) =>
                proposal.citedEvidenceItemIds.includes(item.evidenceItemId),
              )
              .map((item) => item.revisionId),
          ),
        ];
        const semanticTarget = episodeSemanticTarget({
          kind: plan.kind,
          proposal,
          entityAnchorIds: proposal.entityAnchorIds ?? [],
          plan,
        });
        const fingerprint = episodeDedupeFingerprint({
          userId: input.userId,
          semanticTarget,
          evidenceRevisionIds,
          policyVersion: input.policyVersion,
          secret: input.dedupeFingerprintSecret,
        });
        const duplicate = await client.query<{ status: string }>(
          `SELECT status FROM episode_candidates
           WHERE user_id = $1 AND dedupe_fingerprint = $2 LIMIT 1`,
          [input.userId, fingerprint],
        );
        if (duplicate.rows.length > 0) {
          continue;
        }

        candidateCount += 1;
        const candidateId = createUuidV7(now);
        const citedEvidenceIds = [
          ...new Set(
            proposal.citedEvidenceItemIds.filter((id) =>
              frozenEvidenceIds.has(id),
            ),
          ),
        ];
        const admittedEntityIds = [
          ...new Set(
            (proposal.entityAnchorIds ?? []).filter((id) =>
              frozenEntityIds.has(id),
            ),
          ),
        ];

        if (plan.action === "reject") {
          await this.insertCandidateWithin(client, {
            candidateId,
            userId: input.userId,
            dailySessionId: input.dailySessionId,
            sourceRevision: input.sourceRevision,
            kind: plan.kind,
            label: proposal.label,
            anchor: proposal.temporalAnchor,
            phase: proposal.phase,
            continuitySpan: null,
            resolutionStatus: "unresolved",
            status: "rejected",
            existingEpisodeId: null,
            policyVersion: input.policyVersion,
            generationCommandId: input.generationCommandId,
            modelRunAttemptId: input.modelRunAttemptId,
            fingerprint,
            evidenceItemIds: citedEvidenceIds,
            entityAnchorIds: admittedEntityIds,
            dispositionReasonCode: plan.rejectionCode,
            decidedAt: now,
            terminalContentExpiresAt: addDays(now, TERMINAL_CONTENT_EXPIRY_DAYS),
          });
          rejectedCount += 1;
          continue;
        }

        if (plan.action === "stay_unresolved") {
          await this.insertCandidateWithin(client, {
            candidateId,
            userId: input.userId,
            dailySessionId: input.dailySessionId,
            sourceRevision: input.sourceRevision,
            kind: plan.kind,
            label: proposal.label,
            anchor: proposal.temporalAnchor,
            phase: proposal.phase,
            continuitySpan: null,
            resolutionStatus: "unresolved",
            status: "proposed",
            existingEpisodeId: null,
            policyVersion: input.policyVersion,
            generationCommandId: input.generationCommandId,
            modelRunAttemptId: input.modelRunAttemptId,
            fingerprint,
            evidenceItemIds: citedEvidenceIds,
            entityAnchorIds: admittedEntityIds,
          });
          unresolvedCount += 1;
          continue;
        }

        if (plan.action === "create_episode") {
          const episodeId = createUuidV7(now);
          await client.query(
            `INSERT INTO episodes (
               episode_id, user_id, episode_kind_id, current_version_id,
               status, created_at
             ) VALUES ($1, $2, $3, NULL, 'active', $4)`,
            [episodeId, input.userId, plan.content.kind, now],
          );
          const firstVersionId = await this.insertVersionWithin(client, {
            episodeId,
            userId: input.userId,
            revision: 1,
            supersedesVersionId: null,
            sourceRevision: input.sourceRevision,
            kind: plan.content.kind,
            content: plan.content,
            policyVersion: input.policyVersion,
            generationCommandId: input.generationCommandId,
            modelRunAttemptId: input.modelRunAttemptId,
            evidenceItemIds: citedEvidenceIds,
            entityAnchorIds: admittedEntityIds,
            now,
          });
          await client.query(
            `UPDATE episodes SET current_version_id = $2
             WHERE episode_id = $1 AND user_id = $3 AND current_version_id IS NULL`,
            [episodeId, firstVersionId, input.userId],
          );
          await this.insertCandidateWithin(client, {
            candidateId,
            userId: input.userId,
            dailySessionId: input.dailySessionId,
            sourceRevision: input.sourceRevision,
            kind: plan.kind,
            label: proposal.label,
            anchor: proposal.temporalAnchor,
            phase: proposal.phase,
            continuitySpan: null,
            resolutionStatus: "new",
            status: "accepted",
            existingEpisodeId: null,
            policyVersion: input.policyVersion,
            generationCommandId: input.generationCommandId,
            modelRunAttemptId: input.modelRunAttemptId,
            fingerprint,
            evidenceItemIds: citedEvidenceIds,
            entityAnchorIds: admittedEntityIds,
          });
          acceptedCount += 1;
          continue;
        }

        // continue_episode: append the immutable successor version and only
        // advance the pointer when it still sits on the superseded version.
        const frozenCurrentVersion = frozen.activeEpisodes.find(
          (episode) => episode.episodeId === plan.episodeId,
        );
        if (!frozenCurrentVersion) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "episode_missing" };
        }
        // Base the successor on the most recent version of this Episode in the
        // current batch, or the frozen current version for the first
        // continuation. Chaining onto the in-batch successor keeps revisions
        // strictly increasing and always supersedes the live predecessor
        // instead of a stale snapshot version.
        const base = inBatchEpisodeSuccessors.get(plan.episodeId) ?? {
          versionId: frozenCurrentVersion.currentVersionId,
          revision: frozenCurrentVersion.currentRevision,
        };
        // A continuation carries forward the predecessor's still-valid links
        // and adds the newly admitted refs, deduped. It never invents links
        // the predecessor did not have, and never copies refs that are no
        // longer valid or owner-scoped (ADR-0037 / ADR-0089).
        const carriedLinks = await this.loadCarryForwardVersionLinksWithin(
          client,
          {
            userId: input.userId,
            episodeVersionId: base.versionId,
          },
        );
        const successorEvidenceIds = [
          ...new Set([...carriedLinks.evidenceItemIds, ...citedEvidenceIds]),
        ];
        const successorEntityIds = [
          ...new Set([...carriedLinks.entityIds, ...admittedEntityIds]),
        ];
        const successorId = await this.insertVersionWithin(client, {
          episodeId: plan.episodeId,
          userId: input.userId,
          revision: base.revision + 1,
          supersedesVersionId: base.versionId,
          sourceRevision: input.sourceRevision,
          kind: plan.content.kind,
          content: plan.content,
          policyVersion: input.policyVersion,
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
          evidenceItemIds: successorEvidenceIds,
          entityAnchorIds: successorEntityIds,
          now,
        });
        await client.query(
          `UPDATE episode_versions SET status = 'superseded'
           WHERE episode_version_id = $1 AND status = 'current'`,
          [base.versionId],
        );
        await client.query(
          `UPDATE episodes SET current_version_id = $3
           WHERE episode_id = $1 AND user_id = $2
             AND current_version_id = $4`,
          [
            plan.episodeId,
            input.userId,
            successorId,
            base.versionId,
          ],
        );
        inBatchEpisodeSuccessors.set(plan.episodeId, {
          versionId: successorId,
          revision: base.revision + 1,
        });
        await this.insertCandidateWithin(client, {
          candidateId,
          userId: input.userId,
          dailySessionId: input.dailySessionId,
          sourceRevision: input.sourceRevision,
          kind: plan.kind,
          label: proposal.label,
          anchor: proposal.temporalAnchor,
          phase: proposal.phase,
          continuitySpan: plan.explicitContinuitySpan,
          resolutionStatus: "matched",
          status: "accepted",
          existingEpisodeId: plan.episodeId,
          policyVersion: input.policyVersion,
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
          fingerprint,
          evidenceItemIds: citedEvidenceIds,
          entityAnchorIds: admittedEntityIds,
        });
        acceptedCount += 1;
      }

      await client.query(
        `INSERT INTO episode_build_runs (
           episode_build_run_id, user_id, daily_session_id, source_revision,
           policy_version, expected_data_epoch, generation_command_id,
           model_run_attempt_id, status, outcome_detail, candidate_count,
           accepted_count, unresolved_count, rejected_count, error_code,
           created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, 'built', NULL, $9, $10, $11, $12,
           NULL, $13, $13
         )
         ON CONFLICT (user_id, daily_session_id, source_revision, policy_version)
         DO UPDATE SET
           status = 'built',
           outcome_detail = NULL,
           candidate_count = EXCLUDED.candidate_count,
           accepted_count = EXCLUDED.accepted_count,
           unresolved_count = EXCLUDED.unresolved_count,
           rejected_count = EXCLUDED.rejected_count,
           error_code = NULL,
           updated_at = EXCLUDED.updated_at
         WHERE episode_build_runs.status <> 'built'`,
        [
          createUuidV7(now),
          input.userId,
          input.dailySessionId,
          input.sourceRevision,
          input.policyVersion,
          input.expectedDataEpoch,
          input.generationCommandId,
          input.modelRunAttemptId,
          candidateCount,
          acceptedCount,
          unresolvedCount,
          rejectedCount,
          now,
        ],
      );
      await client.query("COMMIT");
      return {
        outcome: "committed",
        candidateCount,
        acceptedCount,
        unresolvedCount,
        rejectedCount,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordBuildRunOutcome(
    input: EpisodeBuildRunOutcomeRow,
  ): Promise<{ applied: boolean }> {
    const result = await this.pool.query(
      `INSERT INTO episode_build_runs (
         episode_build_run_id, user_id, daily_session_id, source_revision,
         policy_version, expected_data_epoch, generation_command_id,
         model_run_attempt_id, status, outcome_detail, candidate_count,
         accepted_count, unresolved_count, rejected_count, error_code,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $16)
       ON CONFLICT (user_id, daily_session_id, source_revision, policy_version)
       DO UPDATE SET
         status = EXCLUDED.status,
         outcome_detail = EXCLUDED.outcome_detail,
         error_code = EXCLUDED.error_code,
         generation_command_id = COALESCE(EXCLUDED.generation_command_id, episode_build_runs.generation_command_id),
         model_run_attempt_id = COALESCE(EXCLUDED.model_run_attempt_id, episode_build_runs.model_run_attempt_id),
         updated_at = EXCLUDED.updated_at
       WHERE episode_build_runs.status <> 'built'`,
      [
        createUuidV7(new Date()),
        input.userId,
        input.dailySessionId,
        input.sourceRevision,
        input.policyVersion,
        input.expectedDataEpoch,
        input.generationCommandId,
        input.modelRunAttemptId,
        input.status,
        input.outcomeDetail,
        input.candidateCount,
        input.acceptedCount,
        input.unresolvedCount,
        input.rejectedCount,
        input.errorCode,
        new Date(),
      ],
    );
    return { applied: (result.rowCount ?? 0) > 0 };
  }

  public async staleUnresolvedCandidates(input: {
    userId: UserId;
    now: Date;
    policyVersion: string;
    dedupeFingerprintSecret: string;
    limit: number;
  }): Promise<EpisodeMaintenanceSweepResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ status: string }>(
        "SELECT status FROM app_users WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      if (owner.rows[0]?.status !== "active") {
        await client.query("ROLLBACK");
        return { staledCandidates: 0, alreadyTerminalCandidates: 0 };
      }
      const due = await client.query<{
        episode_candidate_id: string;
        created_at: Date;
        dedupe_fingerprint: string | null;
      }>(
        `SELECT c.episode_candidate_id, c.created_at, c.dedupe_fingerprint
         FROM episode_candidates c
         WHERE c.user_id = $1 AND c.status = 'proposed'
           AND c.content_purged_at IS NULL
           AND c.created_at + make_interval(days => $2) <= $3
         ORDER BY c.created_at, c.episode_candidate_id
         LIMIT $4
         FOR UPDATE`,
        [input.userId, EPISODE_UNRESOLVED_CANDIDATE_STALE_DAYS, input.now, input.limit],
      );
      let staled = 0;
      let alreadyTerminal = 0;
      for (const row of due.rows) {
        const terminalEffectiveAt = new Date(
          row.created_at.getTime()
            + EPISODE_UNRESOLVED_CANDIDATE_STALE_DAYS * 24 * 60 * 60 * 1000,
        );
        const applied = await client.query(
          `UPDATE episode_candidates SET
             status = 'stale',
             disposition_reason_code = 'unresolved_stale_expired',
             disposition_policy_version = $3,
             reproposal_policy = 'material_change_allowed',
             decided_at = $4,
             terminal_effective_at = $5,
             terminal_content_expires_at = $6,
             dedupe_fingerprint = COALESCE(dedupe_fingerprint, $7),
             dedupe_fingerprint_key_version = COALESCE(dedupe_fingerprint_key_version, $8)
           WHERE episode_candidate_id = $1 AND user_id = $2
             AND status = 'proposed'`,
          [
            row.episode_candidate_id,
            input.userId,
            input.policyVersion,
            input.now,
            terminalEffectiveAt,
            addDays(terminalEffectiveAt, TERMINAL_CONTENT_EXPIRY_DAYS),
            row.dedupe_fingerprint ?? "",
            EPISODE_DEDUPE_FINGERPRINT_KEY_VERSION,
          ],
        );
        if ((applied.rowCount ?? 0) > 0) {
          staled += 1;
        } else {
          alreadyTerminal += 1;
        }
      }
      await client.query("COMMIT");
      return {
        staledCandidates: staled,
        alreadyTerminalCandidates: alreadyTerminal,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async purgeExpiredTerminalCandidates(input: {
    userId: UserId;
    now: Date;
    limit: number;
  }): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ status: string }>(
        "SELECT status FROM app_users WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      if (owner.rows[0]?.status !== "active") {
        await client.query("ROLLBACK");
        return 0;
      }
      const purged = await client.query<{ episode_candidate_id: string }>(
        `UPDATE episode_candidates SET
           proposed_label = NULL,
           proposed_temporal_anchor = NULL,
           proposed_phase = NULL,
           explicit_continuity_span = NULL,
           admission_reason_code = NULL,
           proposed_existing_episode_id = NULL,
           content_purged_at = $2
         WHERE episode_candidate_id IN (
           SELECT c.episode_candidate_id
           FROM episode_candidates c
           WHERE c.user_id = $1
             AND c.status IN ('rejected', 'stale')
             AND c.content_purged_at IS NULL
             AND c.terminal_content_expires_at <= $2
           ORDER BY c.created_at, c.episode_candidate_id
           LIMIT $3
           FOR UPDATE
         )
         RETURNING episode_candidate_id`,
        [input.userId, input.now, input.limit],
      );
      await client.query("COMMIT");
      return purged.rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async listUsersNeedingMaintenance(input: {
    now: Date;
    policyVersion: string;
    limit: number;
  }): Promise<readonly UserId[]> {
    const result = await this.pool.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM (
         SELECT c.user_id FROM episode_candidates c
         WHERE c.content_purged_at IS NULL AND (
           (c.status = 'proposed'
             AND c.created_at + make_interval(days => $2) <= $1)
           OR (c.status IN ('rejected', 'stale')
             AND c.terminal_content_expires_at <= $1)
         )
         UNION
         SELECT v.user_id FROM episode_impact_reviews r
         INNER JOIN episode_versions v
           ON v.episode_version_id = r.episode_version_id
         WHERE r.outcome = 'pending' AND v.status = 'current'
           AND v.content_purged_at IS NULL
       ) due
       LIMIT $3`,
      [input.now, EPISODE_UNRESOLVED_CANDIDATE_STALE_DAYS, input.limit],
    );
    return result.rows.map((row) => asUserId(row.user_id));
  }

  public async detectAndPauseInvalidatedVersions(input: {
    userId: UserId;
    now: Date;
    policyVersion: string;
    limit: number;
  }): Promise<readonly EpisodeVersionId[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ status: string }>(
        "SELECT status FROM app_users WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      if (owner.rows[0]?.status !== "active") {
        await client.query("ROLLBACK");
        return [];
      }
      const evidenceTriggered = await client.query<{
        episode_version_id: string;
        evidence_item_id: string;
      }>(
        `SELECT v.episode_version_id, l.evidence_item_id
         FROM episode_versions v
         INNER JOIN episode_evidence_links l
           ON l.episode_version_id = v.episode_version_id
         INNER JOIN evidence_items item
           ON item.evidence_item_id = l.evidence_item_id
         INNER JOIN conversation_events ev
           ON ev.conversation_event_id = item.source_event_id
         INNER JOIN conversation_event_revisions rev
           ON rev.conversation_event_revision_id = item.source_revision_id
         WHERE v.user_id = $1 AND v.status = 'current'
           AND v.enrichment_paused_at IS NULL AND v.content_purged_at IS NULL
           AND (item.status <> 'active'
             OR ev.lifecycle_status <> 'active'
             OR ev.current_revision_id IS DISTINCT FROM rev.conversation_event_revision_id
             OR rev.content_purged_at IS NOT NULL)
         ORDER BY v.episode_version_id, l.evidence_item_id
         LIMIT $2`,
        [input.userId, input.limit],
      );
      const entityTriggered = await client.query<{
        episode_version_id: string;
        entity_id: string;
      }>(
        `SELECT v.episode_version_id, l.entity_id
         FROM episode_versions v
         INNER JOIN episode_version_entity_links l
           ON l.episode_version_id = v.episode_version_id
         INNER JOIN entities e
           ON e.entity_id = l.entity_id AND e.user_id = v.user_id
         WHERE v.user_id = $1 AND v.status = 'current'
           AND v.enrichment_paused_at IS NULL AND v.content_purged_at IS NULL
           AND (e.deleted_at IS NOT NULL OR e.current_version_id IS NULL)
         ORDER BY v.episode_version_id, l.entity_id
         LIMIT $2`,
        [input.userId, input.limit],
      );
      const paused: EpisodeVersionId[] = [];
      const triggers = [
        ...evidenceTriggered.rows.map((row) => ({
          episodeVersionId: row.episode_version_id,
          triggerType: "evidence_correction" as const,
          triggerRef: row.evidence_item_id,
        })),
        ...entityTriggered.rows.map((row) => ({
          episodeVersionId: row.episode_version_id,
          triggerType: "entity_identity_change" as const,
          triggerRef: row.entity_id,
        })),
      ];
      for (const trigger of triggers) {
        const pause = await client.query(
          `UPDATE episode_versions SET
             enrichment_paused_at = $3, enrichment_pause_reason = $4
           WHERE episode_version_id = $1 AND user_id = $2
             AND enrichment_paused_at IS NULL AND content_purged_at IS NULL`,
          [trigger.episodeVersionId, input.userId, input.now, trigger.triggerType],
        );
        if ((pause.rowCount ?? 0) === 0) {
          continue;
        }
        paused.push(asEpisodeVersionId(trigger.episodeVersionId));
        await client.query(
          `INSERT INTO episode_impact_reviews (
             episode_impact_review_id, user_id, episode_version_id,
             trigger_type, trigger_ref_id, outcome, policy_version, created_at
           ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
           ON CONFLICT (episode_version_id, trigger_type, trigger_ref_id, policy_version)
           DO NOTHING`,
          [
            createUuidV7(input.now),
            input.userId,
            trigger.episodeVersionId,
            trigger.triggerType,
            trigger.triggerRef,
            input.policyVersion,
            input.now,
          ],
        );
      }
      await client.query("COMMIT");
      return paused;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async revalidatePausedVersions(input: {
    userId: UserId;
    policyVersion: string;
    limit: number;
  }): Promise<Readonly<{ revalidated: number; superseded: number }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ status: string }>(
        "SELECT status FROM app_users WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      if (owner.rows[0]?.status !== "active") {
        await client.query("ROLLBACK");
        return { revalidated: 0, superseded: 0 };
      }
      const candidates = await client.query<{ episode_version_id: string }>(
        `SELECT v.episode_version_id
         FROM episode_versions v
         WHERE v.user_id = $1 AND v.status = 'current'
           AND v.enrichment_paused_at IS NOT NULL
           AND v.content_purged_at IS NULL
         ORDER BY v.enrichment_paused_at, v.episode_version_id
         LIMIT $2
         FOR UPDATE`,
        [input.userId, input.limit],
      );
      let revalidated = 0;
      let superseded = 0;
      for (const row of candidates.rows) {
        const validity = await client.query<{
          link_count: string;
          valid_count: string;
          entity_total: string;
          entity_valid: string;
        }>(
          `SELECT
             (SELECT COUNT(*) FROM episode_evidence_links l
              WHERE l.episode_version_id = $1) AS link_count,
             (SELECT COUNT(*) FROM episode_evidence_links l
              INNER JOIN evidence_items item
                ON item.evidence_item_id = l.evidence_item_id
              INNER JOIN conversation_events ev
                ON ev.conversation_event_id = item.source_event_id
              INNER JOIN conversation_event_revisions rev
                ON rev.conversation_event_revision_id = item.source_revision_id
              WHERE l.episode_version_id = $1
                AND item.status = 'active'
                AND ev.lifecycle_status = 'active'
                AND ev.current_revision_id = rev.conversation_event_revision_id
                AND rev.transcript_status IN ('final', 'corrected')
                AND rev.content_purged_at IS NULL) AS valid_count,
             (SELECT COUNT(*) FROM episode_version_entity_links l
              WHERE l.episode_version_id = $1) AS entity_total,
             (SELECT COUNT(*) FROM episode_version_entity_links l
              INNER JOIN entities e
                ON e.entity_id = l.entity_id AND e.user_id = $2
              WHERE l.episode_version_id = $1
                AND e.deleted_at IS NULL AND e.current_version_id IS NOT NULL
             ) AS entity_valid`,
          [row.episode_version_id, input.userId],
        );
        const counts = validity.rows[0]!;
        const allEvidenceValid =
          Number(counts.link_count) > 0
          && Number(counts.valid_count) === Number(counts.link_count);
        const allEntitiesValid =
          Number(counts.entity_total) === 0
          || Number(counts.entity_valid) === Number(counts.entity_total);
        if (allEvidenceValid && allEntitiesValid) {
          const restored = await client.query(
            `UPDATE episode_versions SET
               enrichment_paused_at = NULL, enrichment_pause_reason = NULL
             WHERE episode_version_id = $1 AND user_id = $2
               AND status = 'current'`,
            [row.episode_version_id, input.userId],
          );
          if ((restored.rowCount ?? 0) > 0) {
            revalidated += 1;
            await client.query(
              `UPDATE episode_impact_reviews SET
                 outcome = 'revalidated', decided_at = $3
               WHERE episode_version_id = $1 AND user_id = $2
                 AND outcome = 'pending'`,
              [row.episode_version_id, input.userId, new Date()],
            );
            continue;
          }
        }
        const marked = await client.query(
          `UPDATE episode_impact_reviews SET
             outcome = 'superseded', decided_at = $3
           WHERE episode_version_id = $1 AND user_id = $2
             AND outcome = 'pending'`,
          [row.episode_version_id, input.userId, new Date()],
        );
        if ((marked.rowCount ?? 0) > 0) {
          superseded += 1;
        }
      }
      await client.query("COMMIT");
      return { revalidated, superseded };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertCandidateWithin(
    client: PoolClient,
    input: InsertCandidateInput,
  ): Promise<void> {
    const terminal = input.status === "rejected";
    await client.query(
      `INSERT INTO episode_candidates (
         episode_candidate_id, user_id, daily_session_id, source_revision,
         proposed_episode_kind_id, proposed_existing_episode_id,
         proposed_label, proposed_temporal_anchor, proposed_phase,
         explicit_continuity_span, resolution_status, status,
         admission_reason_code, policy_version, generation_command_id,
         model_run_attempt_id, dedupe_fingerprint,
         dedupe_fingerprint_key_version, disposition_reason_code,
         disposition_policy_version, decided_at, terminal_effective_at,
         terminal_content_expires_at, reproposal_policy, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
       )`,
      [
        input.candidateId,
        input.userId,
        input.dailySessionId,
        input.sourceRevision,
        input.kind,
        input.existingEpisodeId,
        input.label,
        anchorJson(input.anchor),
        input.phase,
        input.continuitySpan,
        input.resolutionStatus,
        input.status,
        input.resolutionStatus,
        input.policyVersion,
        input.generationCommandId,
        input.modelRunAttemptId,
        input.fingerprint,
        EPISODE_DEDUPE_FINGERPRINT_KEY_VERSION,
        input.dispositionReasonCode ?? null,
        terminal ? input.policyVersion : null,
        terminal ? (input.decidedAt ?? null) : null,
        terminal ? (input.decidedAt ?? null) : null,
        terminal ? (input.terminalContentExpiresAt ?? null) : null,
        terminal ? "material_change_allowed" : null,
        input.decidedAt ?? new Date(),
      ],
    );
    await this.insertEvidenceLinkRowsWithin(
      client,
      "episode_candidate_evidence_links",
      "episode_candidate_evidence_link_id",
      "episode_candidate_id",
      input.candidateId,
      input.userId,
      input.evidenceItemIds,
      input.decidedAt ?? new Date(),
    );
    await this.insertEntityLinkRowsWithin(
      client,
      "episode_candidate_entity_links",
      "episode_candidate_entity_link_id",
      "episode_candidate_id",
      input.candidateId,
      input.userId,
      input.entityAnchorIds,
      input.decidedAt ?? new Date(),
    );
  }

  private async insertVersionWithin(
    client: PoolClient,
    input: InsertVersionInput,
  ): Promise<string> {
    const inserted = await client.query<{ episode_version_id: string }>(
      `INSERT INTO episode_versions (
         episode_version_id, episode_id, user_id, revision, source_revision,
         episode_kind_id, status, label, content, policy_version,
         generation_command_id, model_run_attempt_id, supersedes_version_id,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'current', $7, $8::jsonb, $9, $10, $11, $12, $13
       )
       RETURNING episode_version_id`,
      [
        createUuidV7(input.now),
        input.episodeId,
        input.userId,
        input.revision,
        input.sourceRevision,
        input.kind,
        input.content.label,
        JSON.stringify({
          kind: input.content.kind,
          label: input.content.label,
          temporalAnchor: input.content.temporalAnchor,
          phase: input.content.phase,
          kindFields: input.content.kindFields,
        }),
        input.policyVersion,
        input.generationCommandId,
        input.modelRunAttemptId,
        input.supersedesVersionId,
        input.now,
      ],
    );
    const episodeVersionId = inserted.rows[0]!.episode_version_id;
    await this.insertEvidenceLinkRowsWithin(
      client,
      "episode_evidence_links",
      "episode_evidence_link_id",
      "episode_version_id",
      episodeVersionId,
      input.userId,
      input.evidenceItemIds,
      input.now,
    );
    await this.insertEntityLinkRowsWithin(
      client,
      "episode_version_entity_links",
      "episode_version_entity_link_id",
      "episode_version_id",
      episodeVersionId,
      input.userId,
      input.entityAnchorIds,
      input.now,
    );
    return episodeVersionId;
  }

  private async insertEvidenceLinkRowsWithin(
    client: PoolClient,
    table:
      | "episode_candidate_evidence_links"
      | "episode_evidence_links",
    idColumn: string,
    foreignKeyColumn: "episode_candidate_id" | "episode_version_id",
    foreignId: string,
    userId: UserId,
    evidenceItemIds: readonly string[],
    now: Date,
  ): Promise<void> {
    for (const evidenceItemId of evidenceItemIds) {
      await client.query(
        `INSERT INTO ${table} (
           ${idColumn}, ${foreignKeyColumn}, user_id, evidence_item_id, created_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (${foreignKeyColumn}, evidence_item_id) DO NOTHING`,
        [createUuidV7(now), foreignId, userId, evidenceItemId, now],
      );
    }
  }

  private async insertEntityLinkRowsWithin(
    client: PoolClient,
    table:
      | "episode_candidate_entity_links"
      | "episode_version_entity_links",
    idColumn: string,
    foreignKeyColumn: "episode_candidate_id" | "episode_version_id",
    foreignId: string,
    userId: UserId,
    entityIds: readonly string[],
    now: Date,
  ): Promise<void> {
    for (const entityId of entityIds) {
      await client.query(
        `INSERT INTO ${table} (
           ${idColumn}, ${foreignKeyColumn}, user_id, entity_id, created_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (${foreignKeyColumn}, entity_id) DO NOTHING`,
        [createUuidV7(now), foreignId, userId, entityId, now],
      );
    }
  }

  /**
   * Predecessor immutable links that remain valid for the owner right now:
   * active owner Evidence on its current final/corrected revision, and
   * non-deleted owner Entities. A continuation carries these forward so the
   * successor's current version stays a real, still-supported basis; invalid
   * or forgotten refs are never copied (ADR-0037 / ADR-0087 / ADR-0089).
   */
  private async loadCarryForwardVersionLinksWithin(
    client: PoolClient,
    input: { userId: UserId; episodeVersionId: string },
  ): Promise<{ evidenceItemIds: readonly string[]; entityIds: readonly string[] }> {
    const evidence = await client.query<{ evidence_item_id: string }>(
      `SELECT l.evidence_item_id
       FROM episode_evidence_links l
       INNER JOIN evidence_items item
         ON item.evidence_item_id = l.evidence_item_id
       INNER JOIN conversation_events ev
         ON ev.conversation_event_id = item.source_event_id
       INNER JOIN conversation_event_revisions rev
         ON rev.conversation_event_revision_id = item.source_revision_id
       WHERE l.episode_version_id = $1 AND l.user_id = $2
         AND item.user_id = $2 AND item.status = 'active'
         AND ev.lifecycle_status = 'active'
         AND ev.current_revision_id = rev.conversation_event_revision_id
         AND rev.transcript_status IN ('final', 'corrected')
         AND rev.content_purged_at IS NULL
       ORDER BY l.evidence_item_id`,
      [input.episodeVersionId, input.userId],
    );
    const entities = await client.query<{ entity_id: string }>(
      `SELECT l.entity_id
       FROM episode_version_entity_links l
       INNER JOIN entities e
         ON e.entity_id = l.entity_id AND e.user_id = $2
       WHERE l.episode_version_id = $1 AND l.user_id = $2
         AND e.deleted_at IS NULL AND e.current_version_id IS NOT NULL
       ORDER BY l.entity_id`,
      [input.episodeVersionId, input.userId],
    );
    return {
      evidenceItemIds: evidence.rows.map((row) => row.evidence_item_id),
      entityIds: entities.rows.map((row) => row.entity_id),
    };
  }

  private async loadFrozenBuildInputWithin(
    client: PoolClient,
    input: {
      userId: UserId;
      dailySessionId: DailySessionId;
      sourceRevision: number;
    },
  ): Promise<EpisodeFrozenBuildInput | null> {
    const snapshot = await client.query<{ evidence_source_snapshot_id: string }>(
      `SELECT snapshot.evidence_source_snapshot_id
       FROM evidence_source_snapshots snapshot
       INNER JOIN app_users owner ON owner.user_id = snapshot.user_id
       WHERE snapshot.daily_session_id = $1 AND snapshot.source_revision = $2
         AND owner.status = 'active'
       ORDER BY snapshot.created_at DESC, snapshot.evidence_source_snapshot_id
       LIMIT 1`,
      [input.dailySessionId, input.sourceRevision],
    );
    const snapshotRow = snapshot.rows[0];
    if (!snapshotRow) {
      return null;
    }
    const evidence = await client.query<RawEvidenceRow>(
      `SELECT item.evidence_item_id, item.locator_type, item.locator_key,
              item.source_status,
              revision.conversation_event_revision_id AS revision_id,
              revision.canonical_text, revision.locale
       FROM evidence_items item
       INNER JOIN conversation_event_revisions revision
         ON revision.conversation_event_revision_id = item.source_revision_id
       INNER JOIN conversation_events ev
         ON ev.conversation_event_id = item.source_event_id
       INNER JOIN app_users owner ON owner.user_id = item.user_id
       WHERE item.evidence_source_snapshot_id = $1
         AND item.status = 'active'
         AND owner.status = 'active'
         AND ev.actor = 'user' AND ev.lifecycle_status = 'active'
         AND revision.transcript_status IN ('final', 'corrected')
         AND revision.content_purged_at IS NULL
         AND revision.conversation_event_revision_id = ev.current_revision_id
       ORDER BY item.evidence_item_id`,
      [snapshotRow.evidence_source_snapshot_id],
    );
    if (evidence.rows.length === 0) {
      return null;
    }
    const evidenceItems: Array<EpisodeFrozenBuildInput["evidence"][number]> = [];
    for (const row of evidence.rows) {
      const sourceText = textAtLocator(
        row.canonical_text,
        row.locator_type,
        row.locator_key,
      );
      if (sourceText === null) {
        return null;
      }
      evidenceItems.push({
        evidenceItemId: asEvidenceItemId(row.evidence_item_id),
        locatorType: row.locator_type,
        locatorKey: row.locator_key,
        sourceText,
        locale: row.locale,
        revisionId: row.revision_id,
      });
    }
    const versions = await client.query<RawEpisodeRow>(
      `SELECT e.episode_id, e.episode_kind_id, e.current_version_id,
              v.revision AS current_revision, v.label, v.content
       FROM episodes e
       INNER JOIN episode_versions v
         ON v.episode_version_id = e.current_version_id
       WHERE e.user_id = $1 AND e.status = 'active'
         AND v.status = 'current' AND v.content_purged_at IS NULL
       ORDER BY e.episode_id`,
      [input.userId],
    );
    const entityLinks = versions.rows.length
      ? await client.query<RawEntityLinkRow>(
          `SELECT l.episode_version_id, l.entity_id
           FROM episode_version_entity_links l
           INNER JOIN episode_versions v
             ON v.episode_version_id = l.episode_version_id
           WHERE v.user_id = $1
           ORDER BY l.episode_version_id, l.entity_id`,
          [input.userId],
        )
      : { rows: [] as RawEntityLinkRow[] };
    const linksByVersion = new Map<string, string[]>();
    for (const link of entityLinks.rows) {
      const list = linksByVersion.get(link.episode_version_id) ?? [];
      list.push(link.entity_id);
      linksByVersion.set(link.episode_version_id, list);
    }
    const entities = await client.query<{ entity_id: string }>(
      `SELECT entity_id FROM entities
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY entity_id`,
      [input.userId],
    );
    return {
      evidence: evidenceItems,
      activeEpisodes: versions.rows.map((row) => ({
        episodeId: asEpisodeId(row.episode_id),
        kind: normalizeEpisodeKind(row.episode_kind_id),
        temporalAnchor: row.content
          ? storedAnchor(row.content.temporalAnchor)
          : null,
        entityAnchorIds: linksByVersion.get(row.current_version_id) ?? [],
        label: row.label,
        currentVersionId: asEpisodeVersionId(row.current_version_id),
        currentRevision: row.current_revision,
      })),
      resolvableEntityIds: entities.rows.map((row) => row.entity_id),
    };
  }
}
