import { createHash } from "node:crypto";

import type {
  DailySessionId,
  GenerationCommandId,
  ModelRunAttemptId,
  ReflectionVersionId,
  UserId,
  WorkflowCommandId,
} from "@sayhear/domain";
import {
  asDailySessionId,
  asEvidenceItemId,
  asReflectionVersionId,
  asUserId,
  asWorkflowCommandId,
} from "@sayhear/domain";
import type {
  ReflectionBaselineEntry,
  ReflectionCommitInput,
  ReflectionCommitResult,
  ReflectionDailySnapshotOutcome,
  ReflectionDraftInput,
  ReflectionDraftResult,
  ReflectionEligibilitySnapshot,
  ReflectionEpisodeInput,
  ReflectionEvidenceInput,
  ReflectionFrozenInput,
  ReflectionAttemptPreparation,
  ReflectionModelStatement,
  ReflectionRepository,
  ReflectionRunOutcomeRow,
  ReflectionSummaryInput,
} from "@sayhear/application";
import {
  claimBaselineDigest as computeClaimBaselineDigest,
  classifyDailyJournalReadiness,
  classifyEpisodeGate,
  planReflectionCandidate,
  weekWindowId as computeWeekWindowId,
  dateOrdinal,
  DEDUPE_FINGERPRINT_KEY_VERSION,
  MAX_RAW_EVENTS_PER_DAY,
  REFLECTION_OUTPUT_SCHEMA_VERSION,
} from "@sayhear/application";
import type { Pool, PoolClient } from "pg";

import type { RecoveryDerivedLatency } from "./postgres-continuous-exchange-repository";
export type { RecoveryDerivedLatency } from "./postgres-continuous-exchange-repository";

import { createUuidV7 } from "./uuid-v7";
import {
  findTerminalCandidateByFingerprintWithin,
  insertCandidateEvidenceLinksWithin,
  insertMemoryCandidateWithin,
} from "./postgres-memory-claim-repository";
import { modelRoleAttemptIsRunning } from "./postgres-model-role-attempt-fence";

/**
 * PostgreSQL adapter for Daily / Weekly Reflection (issue #199). Every
 * mutation runs inside one short transaction that locks the owner row and
 * re-verifies the data epoch, the exact source head, and the claim-baseline
 * digest, so late results can never publish and the current pointer never
 * regresses (SPEC 5.3).
 */

type ReflectionRegistryLookup = {
  entryFor(predicateId: string): { predicateId: string } | null;
  registryVersion(): number;
};

type RawBaselineRow = {
  memory_claim_id: string;
  memory_claim_version_id: string;
  kind: string;
  predicate_id: string;
  scope_key: string;
  typed_value: unknown;
  temporal_status: string;
  valid_from: Date | null;
  valid_from_precision: string;
  valid_to: Date | null;
  valid_to_precision: string;
  epistemic_status: string;
  last_observed_at: Date;
};

type RawEvidenceRow = {
  evidence_item_id: string;
  daily_session_id: string;
  logical_date: string;
  locator_type: string;
  locator_key: string;
  canonical_text: string;
  locale: string | null;
  revision_id: string;
};

type RawDayRow = {
  daily_session_id: string;
  logical_date: string;
  source_revision: string;
  evidence_count: number;
  summarized: boolean;
};

function addDaysToDateString(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`invalid local date: ${date}`);
  }
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function textAtLocator(
  canonicalText: string,
  locatorType: string,
  locatorKey: string,
): string {
  if (locatorType === "whole_revision") {
    return canonicalText;
  }
  const match = locatorKey.match(/^(-?\d+):(-?\d+)$/);
  if (!match) {
    return canonicalText;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > canonicalText.length
  ) {
    return canonicalText;
  }
  return canonicalText.slice(start, end);
}

function typedValueFromJson(value: unknown): string | readonly string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  const text = String(value ?? "");
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item));
      }
    } catch {
      // fall through to the raw string
    }
  }
  return text;
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function isoWeekIdentifierOf(monday: string): string {
  const date = new Date(`${monday}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== monday ||
    date.getUTCDay() !== 1
  ) {
    return "";
  }
  // ISO week-numbering year: the week's Thursday anchors the ISO year.
  const thursday = addDaysToDateString(monday, 3);
  const thursdayDate = new Date(`${thursday}T00:00:00.000Z`);
  const yearStart = new Date(Date.UTC(thursdayDate.getUTCFullYear(), 0, 1));
  const weekNumber =
    Math.round(
      (thursdayDate.getTime() - yearStart.getTime()) / (7 * 24 * 60 * 60 * 1000),
    ) + 1;
  return `${thursdayDate.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

/**
 * The UTC instant of local midnight for a local date under an IANA timezone,
 * by binary search over the local-date boundary (no fixed 24h offset, so DST
 * transitions stay correct).
 */
function localMidnightInstant(
  localDate: string,
  timezone: string,
): Date | null {
  const probe = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  let low = new Date(`${localDate}T00:00:00.000Z`).getTime() - 26 * 60 * 60 * 1000;
  let high = new Date(`${localDate}T00:00:00.000Z`).getTime() + 26 * 60 * 60 * 1000;
  const localDateOf = (time: number): string => {
    const parts = probe.formatToParts(new Date(time));
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    return `${values.year}-${values.month}-${values.day}`;
  };
  // Find the first instant whose local date is `localDate`.
  for (let index = 0; index < 24; index += 1) {
    const mid = Math.floor((low + high) / 2);
    if (localDateOf(mid) < localDate) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const candidate = new Date(high);
  return Number.isNaN(candidate.getTime())
    ? null
    : candidate;
}


type WorkflowCommandInput = Readonly<{
  commandType: string;
  subjectType: "daily_session" | "app_user";
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
  intentKey: string;
  eventType: string;
  aggregateType: string;
  payload: Readonly<Record<string, unknown>>;
}>;

async function insertWorkflowCommand(
  client: PoolClient,
  input: WorkflowCommandInput,
): Promise<Readonly<{ workflow_command_id: string; fresh: boolean }>> {
  const inserted = await client.query<{
    workflow_command_id: string;
    fresh: boolean;
  }>(
    `INSERT INTO workflow_commands (
       workflow_command_id, command_type, subject_type, subject_id,
       source_revision, policy_version, expected_data_epoch,
       coverage_through_sequence_no, intent_key, status, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 'created', $9)
     ON CONFLICT (
       command_type, subject_type, subject_id, source_revision,
       expected_data_epoch, policy_version, coverage_through_sequence_no,
       intent_key
     ) DO UPDATE SET workflow_command_id = workflow_commands.workflow_command_id
     RETURNING workflow_command_id, (xmax = 0) AS fresh`,
    [
      createUuidV7(new Date()),
      input.commandType,
      input.subjectType,
      input.subjectId,
      input.sourceRevision,
      input.policyVersion,
      input.expectedDataEpoch,
      input.intentKey,
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
       VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, 'pending', $9, 0, $10::jsonb, $9)
       ON CONFLICT DO NOTHING`,
      [
        createUuidV7(new Date()),
        commandRow.workflow_command_id,
        input.aggregateType,
        input.subjectId,
        input.sourceRevision,
        input.expectedDataEpoch,
        input.eventType,
        input.intentKey,
        new Date(),
        JSON.stringify({
          workflowCommandId: commandRow.workflow_command_id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          sourceRevision: input.sourceRevision,
          policyVersion: input.policyVersion,
          expectedDataEpoch: input.expectedDataEpoch,
          eventType: input.eventType,
          ...input.payload,
        }),
      ],
    );
  }
  return commandRow;
}

type CandidateProposalLedgerOutcome =
  | "created"
  | "blocked_terminal"
  | "skipped";

type CandidateProposalLedgerInput = Readonly<{
  reflectionVersionId: string;
  userId: string;
  outcome: CandidateProposalLedgerOutcome;
  reasonCode: string | null;
  memoryCandidateId: string | null;
  fingerprint: string | null;
  now: Date;
}>;

/** Persists the Candidate-handoff lineage row for one proposal. */
async function recordCandidateProposal(
  client: PoolClient,
  input: CandidateProposalLedgerInput,
): Promise<void> {
  await client.query(
    `INSERT INTO reflection_candidate_proposals (
       reflection_candidate_proposal_id, reflection_version_id, user_id,
       memory_candidate_id, dedupe_fingerprint,
       dedupe_fingerprint_key_version, outcome, reason_code, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      createUuidV7(input.now),
      input.reflectionVersionId,
      input.userId,
      input.memoryCandidateId,
      input.fingerprint,
      input.fingerprint ? DEDUPE_FINGERPRINT_KEY_VERSION : null,
      input.outcome,
      input.reasonCode,
      input.now,
    ],
  );
}

export class PostgresReflectionRepository implements ReflectionRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly registry: ReflectionRegistryLookup,
  ) {}

  public async readDerivedLatency(
    now: Date,
    policyVersion: string,
  ): Promise<RecoveryDerivedLatency> {
    const result = await this.pool.query<{
      oldest_pending_seconds: number | null;
      pending_sessions: number;
    }>(
      `WITH pending_sessions AS (
         SELECT s.daily_session_id,
                GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - s.quiescent_at))))::int AS pending_seconds
         FROM daily_sessions s
         INNER JOIN app_users owner ON owner.user_id = s.user_id
         LEFT JOIN daily_session_date_outcomes outcome
           ON outcome.daily_session_id = s.daily_session_id
           AND outcome.source_revision = s.source_revision
         LEFT JOIN LATERAL (
           SELECT status FROM reflection_runs run
           WHERE run.daily_session_id = s.daily_session_id
             AND run.source_revision = s.source_revision
             AND run.policy_version = $2
             AND run.scope_type = 'daily_session'
             AND run.status = 'built'
           ORDER BY run.updated_at DESC LIMIT 1
         ) reflection ON true
         WHERE s.activity_state = 'quiescent'
           AND s.quiescent_at IS NOT NULL
           AND owner.status = 'active'
           AND outcome.outcome IS DISTINCT FROM 'no_activity'
           AND EXISTS (
             SELECT 1 FROM evidence_source_snapshots snap
             INNER JOIN evidence_items item
               ON item.evidence_source_snapshot_id = snap.evidence_source_snapshot_id
             WHERE snap.daily_session_id = s.daily_session_id
               AND snap.source_revision = s.source_revision
               AND item.status = 'active'
           )
           AND reflection.status IS DISTINCT FROM 'built'
       )
       SELECT MAX(pending_seconds)::int AS oldest_pending_seconds,
              COUNT(*)::int AS pending_sessions
       FROM pending_sessions`,
      [now, policyVersion],
    );
    return {
      oldestPendingSeconds: result.rows[0]?.oldest_pending_seconds ?? 0,
      pendingSessions: result.rows[0]?.pending_sessions ?? 0,
    };
  }

  public async readPolicyVersion(): Promise<string | null> {
    const result = await this.pool.query<{ policy_version: string }>(
      "SELECT policy_version FROM reflection_policies ORDER BY created_at DESC LIMIT 1",
    );
    return result.rows[0]?.policy_version ?? null;
  }

  // ---- Claim comparison baseline (read) --------------------------------------

  private async readBaselineWithin(
    client: PoolClient,
    userId: string,
  ): Promise<ReflectionBaselineEntry[]> {
    const result = await client.query<RawBaselineRow>(
      `SELECT c.memory_claim_id, v.memory_claim_version_id, v.kind,
              c.predicate_id, c.scope_key, v.typed_value, v.temporal_status,
              v.valid_from, v.valid_from_precision::text,
              v.valid_to, v.valid_to_precision::text,
              v.epistemic_status, v.last_observed_at
       FROM memory_claims c
       INNER JOIN memory_claim_versions v
         ON v.memory_claim_version_id = c.current_version_id
       INNER JOIN app_users owner ON owner.user_id = c.user_id
       WHERE c.user_id = $1 AND owner.status = 'active'
         AND c.deleted_at IS NULL AND c.content_purged_at IS NULL
         AND v.status = 'active' AND v.epistemic_status <> 'contested'
         AND v.content_purged_at IS NULL
         AND EXISTS (
           SELECT 1 FROM entities se
           WHERE se.entity_id = c.subject_entity_id
             AND se.user_id = c.user_id
             AND se.deleted_at IS NULL AND se.current_version_id IS NOT NULL
         )
         AND (c.object_entity_id IS NULL OR EXISTS (
           SELECT 1 FROM entities oe
           WHERE oe.entity_id = c.object_entity_id
             AND oe.user_id = c.user_id
             AND oe.deleted_at IS NULL AND oe.current_version_id IS NOT NULL
         ))
       ORDER BY v.memory_claim_version_id`,
      [userId],
    );
    return result.rows.map((row) => ({
      claimId: row.memory_claim_id,
      claimVersionId: row.memory_claim_version_id,
      kind: row.kind === "impression" ? "impression" : "objective",
      predicateId: row.predicate_id,
      scopeKey: row.scope_key,
      typedValue: typedValueFromJson(row.typed_value),
      temporalStatus: row.temporal_status as ReflectionBaselineEntry["temporalStatus"],
      validFrom: isoOrNull(row.valid_from),
      validFromPrecision: row.valid_from_precision as ReflectionBaselineEntry["validFromPrecision"],
      validTo: isoOrNull(row.valid_to),
      validToPrecision: row.valid_to_precision as ReflectionBaselineEntry["validToPrecision"],
      epistemicStatus:
        row.epistemic_status === "inferred"
          ? ("inferred" as const)
          : ("confirmed" as const),
      lastObservedAt: row.last_observed_at.toISOString(),
    }));
  }

  private async digestBaselineWithin(
    client: PoolClient,
    userId: string,
  ): Promise<string> {
    const entries = await this.readBaselineWithin(client, userId);
    return computeClaimBaselineDigest(entries);
  }

  // ---- Frozen window reads ------------------------------------------------------

  private async readWindowDaysWithin(
    client: PoolClient,
    userId: string,
    window: { startDate: string; endDate: string; dailySessionId: string | null },
  ): Promise<RawDayRow[]> {
    const result = await client.query<{
      daily_session_id: string;
      logical_date: string;
      source_revision: string;
      evidence_count: number;
      summarized: boolean;
    }>(
      `SELECT s.daily_session_id::text, s.logical_date::text,
              s.source_revision::text,
              (SELECT count(*)::int FROM evidence_source_snapshots snap
               INNER JOIN evidence_items item
                 ON item.evidence_source_snapshot_id = snap.evidence_source_snapshot_id
               WHERE snap.daily_session_id = s.daily_session_id
                 AND snap.source_revision = s.source_revision
                 AND item.status = 'active') AS evidence_count,
              EXISTS (
                SELECT 1 FROM current_rolling_summaries crs
                WHERE crs.daily_session_id = s.daily_session_id
              ) AS summarized
       FROM daily_sessions s
       WHERE s.user_id = $1 AND s.activity_state = 'quiescent'
         AND s.logical_date >= $2::date AND s.logical_date <= $3::date
         AND ($4::uuid IS NULL OR s.daily_session_id = $4::uuid)
         AND EXISTS (
           SELECT 1 FROM evidence_source_snapshots snap
           INNER JOIN evidence_items item
             ON item.evidence_source_snapshot_id = snap.evidence_source_snapshot_id
           WHERE snap.daily_session_id = s.daily_session_id
             AND snap.source_revision = s.source_revision
             AND item.status = 'active'
         )
       ORDER BY s.logical_date, s.daily_session_id`,
      [userId, window.startDate, window.endDate, window.dailySessionId],
    );
    return result.rows;
  }

  private async readWindowEvidenceWithin(
    client: PoolClient,
    userId: string,
    window: { startDate: string; endDate: string; dailySessionId: string | null },
  ): Promise<RawEvidenceRow[]> {
    const result = await client.query<RawEvidenceRow>(
      `SELECT item.evidence_item_id,
              s.daily_session_id::text, s.logical_date::text,
              item.locator_type, item.locator_key,
              rev.canonical_text, rev.locale,
              rev.conversation_event_revision_id AS revision_id
       FROM daily_sessions s
       INNER JOIN evidence_source_snapshots snap
         ON snap.daily_session_id = s.daily_session_id
         AND snap.source_revision = s.source_revision
       INNER JOIN evidence_items item
         ON item.evidence_source_snapshot_id = snap.evidence_source_snapshot_id
       INNER JOIN conversation_events ev
         ON ev.conversation_event_id = item.source_event_id
       INNER JOIN conversation_event_revisions rev
         ON rev.conversation_event_revision_id = item.source_revision_id
       WHERE s.user_id = $1 AND item.status = 'active'
         AND ev.lifecycle_status = 'active'
         AND ev.current_revision_id = rev.conversation_event_revision_id
         AND rev.transcript_status IN ('final', 'corrected')
         AND rev.content_purged_at IS NULL
         AND s.logical_date >= $2::date AND s.logical_date <= $3::date
         AND ($4::uuid IS NULL OR s.daily_session_id = $4::uuid)
       ORDER BY s.logical_date, item.evidence_item_id`,
      [userId, window.startDate, window.endDate, window.dailySessionId],
    );
    return result.rows;
  }

  private async readWindowEpisodesWithin(
    client: PoolClient,
    userId: string,
    window: { startDate: string; endDate: string; dailySessionId: string | null },
  ): Promise<ReflectionEpisodeInput[]> {
    const result = await client.query<{
      episode_id: string;
      episode_version_id: string;
      episode_kind_id: string;
      label: string | null;
    }>(
      `SELECT DISTINCT ON (e.episode_id)
              e.episode_id, v.episode_version_id, e.episode_kind_id, v.label
       FROM episodes e
       INNER JOIN episode_versions v
         ON v.episode_version_id = e.current_version_id
       INNER JOIN episode_evidence_links link
         ON link.episode_version_id = v.episode_version_id
       INNER JOIN evidence_items item
         ON item.evidence_item_id = link.evidence_item_id
       INNER JOIN evidence_source_snapshots snap
         ON snap.evidence_source_snapshot_id = item.evidence_source_snapshot_id
       INNER JOIN daily_sessions s
         ON s.daily_session_id = snap.daily_session_id
       WHERE e.user_id = $1 AND e.status = 'active'
         AND v.status = 'current' AND v.content_purged_at IS NULL
         AND v.enrichment_paused_at IS NULL AND item.status = 'active'
         AND s.logical_date >= $2::date AND s.logical_date <= $3::date
         AND ($4::uuid IS NULL OR s.daily_session_id = $4::uuid)
       ORDER BY e.episode_id, v.revision DESC`,
      [userId, window.startDate, window.endDate, window.dailySessionId],
    );
    return result.rows.map((row) => ({
      episodeId: row.episode_id,
      episodeVersionId: row.episode_version_id,
      kind: row.episode_kind_id,
      label: row.label,
    }));
  }

  private async readWindowSummariesWithin(
    client: PoolClient,
    userId: string,
    overBudgetSessionIds: readonly string[],
  ): Promise<ReflectionSummaryInput[]> {
    if (overBudgetSessionIds.length === 0) {
      return [];
    }
    const result = await client.query<{
      daily_session_id: string;
      rolling_summary_version_id: string;
      content: string | null;
    }>(
      `SELECT DISTINCT ON (sc.daily_session_id::text)
              sc.daily_session_id::text, v.rolling_summary_version_id, v.content
       FROM rolling_summary_commands sc
       INNER JOIN current_rolling_summaries crs
         ON crs.daily_session_id = sc.daily_session_id
       INNER JOIN rolling_summary_versions v
         ON v.rolling_summary_version_id = crs.rolling_summary_version_id
       WHERE sc.user_id = $1 AND sc.daily_session_id = ANY($2::uuid[])
       ORDER BY sc.daily_session_id::text, v.version_no DESC`,
      [userId, overBudgetSessionIds],
    );
    return result.rows
      .filter((row) => row.content !== null)
      .map((row) => ({
        dailySessionId: asDailySessionId(row.daily_session_id),
        rollingSummaryVersionId: row.rolling_summary_version_id,
        content: row.content!,
      }));
  }

  private async freezeWindowInputWithin(
    client: PoolClient,
    input: Readonly<{
      userId: string;
      scopeType: "daily_session" | "date_range";
      window: { startDate: string; endDate: string; dailySessionId: string | null };
      dayRows: readonly RawDayRow[];
      sourceDigest: string | null;
      weekIdentifier: string | null;
      windowStartDate: string;
      windowEndDate: string;
      setDayHead: boolean;
    }>,
  ): Promise<ReflectionFrozenInput> {
    const evidenceRows = await this.readWindowEvidenceWithin(
      client,
      input.userId,
      input.window,
    );
    const evidence: ReflectionEvidenceInput[] = evidenceRows.map((row) => ({
      evidenceItemId: asEvidenceItemId(row.evidence_item_id),
      dailySessionId: asDailySessionId(row.daily_session_id),
      logicalDate: row.logical_date,
      locatorType: row.locator_type,
      locatorKey: row.locator_key,
      sourceText: textAtLocator(
        row.canonical_text,
        row.locator_type,
        row.locator_key,
      ),
      locale: row.locale,
      revisionId: row.revision_id,
    }));
    const episodes = await this.readWindowEpisodesWithin(
      client,
      input.userId,
      input.window,
    );
    const perDayCounts = new Map<string, number>();
    for (const row of evidenceRows) {
      perDayCounts.set(
        row.daily_session_id,
        (perDayCounts.get(row.daily_session_id) ?? 0) + 1,
      );
    }
    const overBudgetSessionIds = [...perDayCounts.entries()]
      .filter(([_id, count]) => count > MAX_RAW_EVENTS_PER_DAY)
      .map(([id]) => id);
    const summaries = await this.readWindowSummariesWithin(
      client,
      input.userId,
      overBudgetSessionIds,
    );
    const baseline = await this.readBaselineWithin(client, input.userId);
    const summarizedDayIds = new Set(
      summaries.map((item) => String(item.dailySessionId)),
    );
    const localeCounts = new Map<string, number>();
    for (const item of evidence) {
      const key = item.locale ?? "en";
      localeCounts.set(key, (localeCounts.get(key) ?? 0) + 1);
    }
    let dominantLocale: string | null = null;
    let bestCount = -1;
    for (const [locale, count] of localeCounts) {
      if (count > bestCount) {
        bestCount = count;
        dominantLocale = locale;
      }
    }
    return {
      scopeType: input.scopeType,
      dailySessionId: input.window.dailySessionId
        ? asDailySessionId(input.window.dailySessionId)
        : null,
      weekIdentifier: input.weekIdentifier,
      windowStartDate: input.windowStartDate,
      windowEndDate: input.windowEndDate,
      days: input.dayRows.map((day) => ({
        dailySessionId: asDailySessionId(day.daily_session_id),
        logicalDate: day.logical_date,
        sourceRevision: input.setDayHead ? Number(day.source_revision) : 0,
        summarized: summarizedDayIds.has(day.daily_session_id),
      })),
      evidence,
      episodes,
      summaries,
      baseline,
      claimBaselineDigest: await this.digestBaselineWithin(client, input.userId),
      sourceDigest: input.sourceDigest,
      dominantLocale,
    };
  }

  // ---- Scheduler scans ------------------------------------------------------------

  public async listDueDailySessions(input: {
    now: Date;
    policyVersion: string;
    limit: number;
  }): Promise<
    readonly Readonly<{
      dailySessionId: DailySessionId;
      userId: UserId;
      sourceRevision: number;
      degradedEpisodeReason: string | null;
    }>[]
  > {
    // Q2 readiness in SQL: a quiescent day with active Evidence at head, a
    // settled Journal (published / final failure / explicit skip), the
    // Episode gate resolved (built, or defaulted after the interval), and no
    // ready or built run at this head + policy yet.
    const result = await this.pool.query<{
      daily_session_id: string;
      user_id: string;
      source_revision: string;
      degraded_episode_reason: string | null;
    }>(
      `WITH candidates AS (
         SELECT s.daily_session_id, s.user_id, s.source_revision,
                s.quiescent_at,
                (SELECT o.outcome FROM daily_session_date_outcomes o
                   WHERE o.daily_session_id = s.daily_session_id) AS date_outcome,
                (SELECT w.outcome FROM journal_workflow_outcomes w
                   WHERE w.daily_session_id = s.daily_session_id
                   ORDER BY w.created_at DESC LIMIT 1) AS journal_outcome,
                er.status AS episode_status,
                er.updated_at AS episode_updated_at
         FROM daily_sessions s
         INNER JOIN app_users owner ON owner.user_id = s.user_id
         LEFT JOIN LATERAL (
           SELECT status, updated_at FROM episode_build_runs r
           WHERE r.daily_session_id = s.daily_session_id
             AND r.source_revision = s.source_revision
           ORDER BY r.created_at DESC LIMIT 1
         ) er ON true
         WHERE s.activity_state = 'quiescent' AND owner.status = 'active'
           AND EXISTS (
             SELECT 1 FROM evidence_source_snapshots snap
             INNER JOIN evidence_items item
               ON item.evidence_source_snapshot_id = snap.evidence_source_snapshot_id
             WHERE snap.daily_session_id = s.daily_session_id
               AND snap.source_revision = s.source_revision
               AND item.status = 'active'
           )
           AND EXISTS (
             SELECT 1 FROM daily_session_date_outcomes o
             WHERE o.daily_session_id = s.daily_session_id
               AND o.outcome <> 'no_activity'
           )
           AND (
             (SELECT o.outcome FROM daily_session_date_outcomes o
                WHERE o.daily_session_id = s.daily_session_id)
               = 'insufficient_expression'
             OR (SELECT w.outcome FROM journal_workflow_outcomes w
                   WHERE w.daily_session_id = s.daily_session_id
                   ORDER BY w.created_at DESC LIMIT 1)
                   IN ('published', 'needs_review')
           )
       )
       SELECT c.daily_session_id, c.user_id, c.source_revision::text,
              CASE
                WHEN c.episode_status = 'built' THEN NULL
                WHEN c.episode_status IN ('failed', 'stale_source', 'fenced')
                  THEN 'episode_' || c.episode_status
                ELSE 'episode_build_pending'
              END AS degraded_episode_reason
       FROM candidates c
       WHERE (
         (c.episode_status = 'built'
           AND c.episode_updated_at + make_interval(mins => $1) <= $2)
         OR (c.episode_status IN ('failed', 'stale_source', 'fenced')
           AND c.episode_updated_at + make_interval(mins => $1) <= $2)
         OR (c.episode_status IS NULL
           AND c.quiescent_at + make_interval(mins => $1) <= $2)
       )
       AND NOT EXISTS (
         SELECT 1 FROM reflection_runs run
         WHERE run.daily_session_id = c.daily_session_id
           AND run.source_revision = c.source_revision
           AND run.policy_version = $3
           AND run.scope_type = 'daily_session'
           AND run.status IN ('ready', 'built')
       )
       ORDER BY c.daily_session_id
       LIMIT $4`,
      [30, input.now, input.policyVersion, input.limit],
    );
    return result.rows.map((row) => ({
      dailySessionId: asDailySessionId(row.daily_session_id),
      userId: asUserId(row.user_id),
      sourceRevision: Number(row.source_revision),
      degradedEpisodeReason: row.degraded_episode_reason,
    }));
  }

  public async readDailyBaselineDigest(input: {
    dailySessionId: DailySessionId;
    sourceRevision: number;
  }): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query<{
        user_id: string;
        source_revision: string;
      }>(
        "SELECT user_id, source_revision::text FROM daily_sessions WHERE daily_session_id = $1",
        [input.dailySessionId],
      );
      const row = session.rows[0];
      if (!row || Number(row.source_revision) !== input.sourceRevision) {
        await client.query("COMMIT");
        return null;
      }
      const digest = await this.digestBaselineWithin(client, row.user_id);
      await client.query("COMMIT");
      return digest;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async listCandidateWeeks(input: {
    limit: number;
  }): Promise<
    readonly Readonly<{
      userId: string;
      weekMonday: string;
      timezone: string;
    }>[]
  > {
    const result = await this.pool.query<{
      user_id: string;
      week_monday: string;
      timezone: string | null;
    }>(
      `SELECT s.user_id,
              (min(s.logical_date - ((extract(dow from s.logical_date)::int + 6) % 7)))::text AS week_monday,
              min(s.timezone_at_start) AS timezone
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
         AND EXISTS (
           SELECT 1 FROM daily_session_date_outcomes o
           WHERE o.daily_session_id = s.daily_session_id
             AND o.outcome <> 'no_activity'
         )
       GROUP BY s.user_id,
                (s.logical_date - ((extract(dow from s.logical_date)::int + 6) % 7))
       ORDER BY week_monday, s.user_id
       LIMIT $1`,
      [input.limit],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      weekMonday: row.week_monday,
      timezone: row.timezone ?? "UTC",
    }));
  }

  public async listDueWeekWindows(input: {
    now: Date;
    policyVersion: string;
    limit: number;
  }): Promise<
    readonly Readonly<{
      userId: UserId;
      weekIdentifier: string;
      windowStartDate: string;
      windowEndDate: string;
      sourceDigest: string;
    }>[]
  > {
    const candidates = await this.listCandidateWeeks({ limit: input.limit });
    const due: {
      userId: UserId;
      weekIdentifier: string;
      windowStartDate: string;
      windowEndDate: string;
      sourceDigest: string;
    }[] = [];
    for (const candidate of candidates) {
      const windowEndDate = addDaysToDateString(candidate.weekMonday, 6);
      // Weekly earliest at local Monday 00:00 after the window (SPEC 5.1).
      const earliest = localMidnightInstant(
        addDaysToDateString(windowEndDate, 1),
        candidate.timezone,
      );
      if (earliest === null || input.now.getTime() < earliest.getTime()) {
        continue;
      }
      const weekIdentifier = isoWeekIdentifierOf(candidate.weekMonday);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const existingRuns = await client.query<{
          status: string;
          source_digest: string | null;
          command_status: string | null;
        }>(
          `SELECT run.status, run.source_digest,
                  command.status AS command_status
           FROM reflection_runs run
           LEFT JOIN generation_commands command
             ON command.generation_command_id = run.generation_command_id
           WHERE run.user_id = $1
             AND run.week_window_id = $2
             AND run.scope_type = 'date_range'
             AND run.status IN ('ready', 'built')`,
          [candidate.userId, computeWeekWindowId(candidate.userId, weekIdentifier)],
        );
        // A `built` run or a `ready` run whose generation command has not
        // terminally failed still owns the window: it is either the current
        // history or a live/recoverable attempt, and re-admission would
        // duplicate it. A `ready` run whose command is terminally `failed`
        // (the Oct 4 W38 incident: `reflection_runs.status = ready` beside a
        // failed `generation_command`) is a frozen historical attempt. Its
        // bytes stay untouched, but it must not suppress a genuinely new,
        // still-current source digest forever.
        const liveRun = existingRuns.rows.some(
          (row) =>
            row.status === "built" ||
            (row.status === "ready" && row.command_status !== "failed"),
        );
        // Same-source dedup: only a digest that differs from an existing
        // terminally failed attempt is a new source. A matching failed digest
        // stays a non-retry, exactly like a normal completed window.
        const failedDigests = new Set(
          existingRuns.rows
            .filter(
              (row) => row.status === "ready" && row.command_status === "failed",
            )
            .map((row) => row.source_digest)
            .filter((digest): digest is string => digest !== null),
        );
        const dayRows = await this.readWindowDaysWithin(client, candidate.userId, {
          startDate: candidate.weekMonday,
          endDate: windowEndDate,
          dailySessionId: null,
        });
        const settled = await this.assertDaysSettledWithin(client, dayRows);
        const digest =
          !liveRun && settled
            ? await this.weeklyWindowDigestWithin(client, candidate.userId, {
                weekIdentifier,
                windowStartDate: candidate.weekMonday,
                windowEndDate,
              })
            : null;
        await client.query("COMMIT");
        if (digest && !failedDigests.has(digest)) {
          due.push({
            userId: asUserId(candidate.userId),
            weekIdentifier,
            windowStartDate: candidate.weekMonday,
            windowEndDate,
            sourceDigest: digest,
          });
        }
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    return due;
  }

  /** Every activity day: journal settled (Q2) and the Episode gate resolved. */
  private async assertDaysSettledWithin(
    client: PoolClient,
    dayRows: readonly RawDayRow[],
  ): Promise<boolean> {
    if (dayRows.length === 0) {
      return false;
    }
    for (const day of dayRows) {
      const journal = await client.query<{
        date_outcome: string | null;
        journal_outcome: string | null;
        activity_state: string;
        quiescent_at: Date | null;
        episode_status: string | null;
        episode_updated_at: Date | null;
      }>(
        `SELECT
           (SELECT o.outcome FROM daily_session_date_outcomes o
              WHERE o.daily_session_id = $1) AS date_outcome,
           (SELECT w.outcome FROM journal_workflow_outcomes w
              WHERE w.daily_session_id = $1
              ORDER BY w.created_at DESC LIMIT 1) AS journal_outcome,
           s.activity_state, s.quiescent_at,
           (SELECT r.status FROM episode_build_runs r
              WHERE r.daily_session_id = $1
                AND r.source_revision = s.source_revision
              ORDER BY r.created_at DESC LIMIT 1) AS episode_status,
           (SELECT r.updated_at FROM episode_build_runs r
              WHERE r.daily_session_id = $1
                AND r.source_revision = s.source_revision
              ORDER BY r.created_at DESC LIMIT 1) AS episode_updated_at
         FROM daily_sessions s
         WHERE s.daily_session_id = $1`,
        [day.daily_session_id],
      );
      const item = journal.rows[0];
      if (!item || item.activity_state !== "quiescent") {
        return false;
      }
      const readiness = classifyDailyJournalReadiness({
        dateOutcome: item.date_outcome as
          | "no_activity"
          | "insufficient_expression"
          | "eligible_queued"
          | "journal_available"
          | null,
        journalOutcome: item.journal_outcome as
          | "published"
          | "needs_review"
          | "retryable_failed"
          | null,
        journalCommandSettled: item.journal_outcome !== "retryable_failed",
        activityState: "quiescent",
        hasActiveEvidence: true,
      });
      if (readiness === "no_activity" || readiness === "waiting") {
        return false;
      }
      const gate = classifyEpisodeGate({
        episodeRunUpdatedAt: item.episode_updated_at,
        episodeRunStatus:
          (item.episode_status as
            | "built"
            | "stale_source"
            | "fenced"
            | "retryable_failed"
            | "failed") ?? null,
        sessionQuiescentAt: item.quiescent_at,
        now: new Date(),
        intervalMinutes: 30,
      });
      if (!gate.ready) {
        return false;
      }
    }
    return true;
  }

  // ---- Queueing ----------------------------------------------------------------------

  public async queueDailyReflection(input: {
    dailySessionId: DailySessionId;
    sourceRevision: number;
    claimBaselineDigest: string;
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
    | Readonly<{ outcome: "not_ready" }>
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
        Number(row.source_revision) !== input.sourceRevision ||
        row.activity_state !== "quiescent"
      ) {
        await client.query("COMMIT");
        return { outcome: "not_ready" };
      }
      const expectedDataEpoch = Number(row.data_epoch);
      const digest = await this.digestBaselineWithin(client, row.user_id);
      if (digest !== input.claimBaselineDigest) {
        // The baseline moved between scan time and queue time (Q3): the next
        // scan freezes a fresh command at the new identity.
        await client.query("COMMIT");
        return { outcome: "not_ready" };
      }
      const commandRow = await insertWorkflowCommand(client, {
        commandType: "reflection_daily",
        subjectType: "daily_session",
        subjectId: input.dailySessionId,
        sourceRevision: input.sourceRevision,
        policyVersion: input.policyVersion,
        expectedDataEpoch,
        intentKey: `baseline:${input.claimBaselineDigest}`,
        eventType: "reflection_daily_requested",
        aggregateType: "daily_session",
        payload: {
          scope: "daily",
          claimBaselineDigest: input.claimBaselineDigest,
          ownerId: row.user_id,
        },
      });
      await client.query("COMMIT");
      if (!commandRow.fresh) {
        return { outcome: "already_queued" };
      }
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

  public async queueWeeklyReflection(input: {
    userId: UserId;
    weekIdentifier: string;
    windowStartDate: string;
    windowEndDate: string;
    sourceDigest: string;
    policyVersion: string;
  }): Promise<
    | Readonly<{
        outcome: "queued";
        workflowCommandId: WorkflowCommandId;
        userId: UserId;
        expectedDataEpoch: number;
      }>
    | Readonly<{ outcome: "already_queued" }>
    | Readonly<{ outcome: "not_ready" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ status: string; data_epoch: string }>(
        "SELECT status, data_epoch::text FROM app_users WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow || ownerRow.status !== "active") {
        await client.query("COMMIT");
        return { outcome: "not_ready" };
      }
      const expectedDataEpoch = Number(ownerRow.data_epoch);
      // Re-verify the frozen weekly identity inside the queue transaction.
      const dayRows = await this.readWindowDaysWithin(client, input.userId, {
        startDate: input.windowStartDate,
        endDate: input.windowEndDate,
        dailySessionId: null,
      });
      const settled = await this.assertDaysSettledWithin(client, dayRows);
      if (!settled || dayRows.length === 0) {
        await client.query("COMMIT");
        return { outcome: "not_ready" };
      }
      const digest = await this.weeklyWindowDigestWithin(client, input.userId, {
        weekIdentifier: input.weekIdentifier,
        windowStartDate: input.windowStartDate,
        windowEndDate: input.windowEndDate,
      });
      if (digest !== input.sourceDigest) {
        await client.query("COMMIT");
        return { outcome: "not_ready" };
      }
      const commandRow = await insertWorkflowCommand(client, {
        commandType: "reflection_weekly",
        subjectType: "app_user",
        subjectId: input.userId,
        sourceRevision: dateOrdinal(input.windowStartDate),
        policyVersion: input.policyVersion,
        expectedDataEpoch,
        intentKey: `weekly:${input.weekIdentifier}:${input.sourceDigest}`,
        eventType: "reflection_weekly_requested",
        aggregateType: "app_user",
        payload: {
          scope: "weekly",
          weekIdentifier: input.weekIdentifier,
          sourceDigest: input.sourceDigest,
          windowStartDate: input.windowStartDate,
          windowEndDate: input.windowEndDate,
          ownerId: input.userId,
        },
      });
      await client.query("COMMIT");
      if (!commandRow.fresh) {
        return { outcome: "already_queued" };
      }
      return {
        outcome: "queued",
        workflowCommandId: asWorkflowCommandId(commandRow.workflow_command_id),
        userId: input.userId,
        expectedDataEpoch,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async queueReflectionMaintenance(input: {
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
      const sourceRevision = dateOrdinal(new Date().toISOString().slice(0, 10));
      const commandRow = await insertWorkflowCommand(client, {
        commandType: "reflection_maintenance",
        subjectType: "app_user",
        subjectId: input.userId,
        sourceRevision,
        policyVersion: input.policyVersion,
        expectedDataEpoch: Number(ownerRow.data_epoch),
        intentKey: "",
        eventType: "reflection_maintenance_requested",
        aggregateType: "app_user",
        payload: {},
      });
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

  // ---- Snapshot freezing -----------------------------------------------------------

  public async readDailySnapshot(input: {
    dailySessionId: DailySessionId;
    sourceRevision: number;
    claimBaselineDigest: string;
    policyVersion: string;
  }): Promise<ReflectionDailySnapshotOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const session = await client.query<{
        user_id: string;
        source_revision: string;
        activity_state: string;
        owner_status: string;
        data_epoch: string;
        logical_date: string;
        quiescent_at: Date | null;
      }>(
        `SELECT s.user_id, s.source_revision::text, s.activity_state,
                owner.status AS owner_status, owner.data_epoch::text,
                s.logical_date::text, s.quiescent_at
         FROM daily_sessions s
         INNER JOIN app_users owner ON owner.user_id = s.user_id
         WHERE s.daily_session_id = $1
         FOR UPDATE OF s`,
        [input.dailySessionId],
      );
      const row = session.rows[0];
      if (!row || row.owner_status !== "active") {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      if (Number(row.source_revision) !== input.sourceRevision) {
        await client.query("COMMIT");
        return { outcome: "stale_source" };
      }
      if (row.activity_state !== "quiescent") {
        await client.query("COMMIT");
        return { outcome: "not_ready" };
      }
      const dayRows = await this.readWindowDaysWithin(client, row.user_id, {
        startDate: row.logical_date,
        endDate: row.logical_date,
        dailySessionId: input.dailySessionId,
      });
      if (dayRows.length === 0) {
        await client.query("COMMIT");
        return { outcome: "not_ready" };
      }
      const readiness = await this.assertDailyReadinessWithin(client, {
        dailySessionId: input.dailySessionId,
        quiescentAt: row.quiescent_at,
      });
      if (!readiness.ready) {
        await client.query("COMMIT");
        return { outcome: "not_ready" };
      }
      const digest = await this.digestBaselineWithin(client, row.user_id);
      if (digest !== input.claimBaselineDigest) {
        await client.query("COMMIT");
        return { outcome: "baseline_changed" };
      }
      const frozen = await this.freezeWindowInputWithin(client, {
        userId: row.user_id,
        scopeType: "daily_session",
        window: {
          startDate: row.logical_date,
          endDate: row.logical_date,
          dailySessionId: input.dailySessionId,
        },
        dayRows,
        sourceDigest: null,
        weekIdentifier: null,
        windowStartDate: row.logical_date,
        windowEndDate: row.logical_date,
        setDayHead: true,
      });
      const snapshot: ReflectionEligibilitySnapshot = {
        userId: asUserId(row.user_id),
        scopeType: "daily_session",
        dailySessionId: input.dailySessionId,
        weekIdentifier: null,
        sourceRevision: input.sourceRevision,
        sourceDigest: null,
        ownerEpoch: Number(row.data_epoch),
      };
      await client.query("COMMIT");
      return {
        outcome: "evaluated",
        snapshot,
        frozen,
        degradedEpisodeReason: readiness.degradedEpisodeReason,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertDailyReadinessWithin(
    client: PoolClient,
    input: { dailySessionId: DailySessionId; quiescentAt: Date | null },
  ): Promise<Readonly<{ ready: boolean; degradedEpisodeReason: string | null }>> {
    const journal = await client.query<{
      date_outcome: string | null;
      journal_outcome: string | null;
    }>(
      `SELECT
         (SELECT o.outcome FROM daily_session_date_outcomes o
            WHERE o.daily_session_id = $1) AS date_outcome,
         (SELECT w.outcome FROM journal_workflow_outcomes w
            WHERE w.daily_session_id = $1
            ORDER BY w.created_at DESC LIMIT 1) AS journal_outcome`,
      [input.dailySessionId],
    );
    const item = journal.rows[0];
    const readiness = classifyDailyJournalReadiness({
      dateOutcome: item?.date_outcome as
        | "no_activity"
        | "insufficient_expression"
        | "eligible_queued"
        | "journal_available"
        | null,
      journalOutcome: item?.journal_outcome as
        | "published"
        | "needs_review"
        | "retryable_failed"
        | null,
      journalCommandSettled: item?.journal_outcome !== "retryable_failed",
      activityState: "quiescent",
      hasActiveEvidence: true,
    });
    if (readiness === "no_activity" || readiness === "waiting") {
      return { ready: false, degradedEpisodeReason: null };
    }
    const episode = await client.query<{
      status: string | null;
      updated_at: Date | null;
    }>(
      `SELECT status, updated_at FROM episode_build_runs
       WHERE daily_session_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [input.dailySessionId],
    );
    const episodeRow = episode.rows[0];
    const gate = classifyEpisodeGate({
      episodeRunUpdatedAt: episodeRow?.updated_at ?? null,
      episodeRunStatus:
        (episodeRow?.status as
          | "built"
          | "stale_source"
          | "fenced"
          | "retryable_failed"
          | "failed") ?? null,
      sessionQuiescentAt: input.quiescentAt,
      now: new Date(),
      intervalMinutes: 30,
    });
    return {
      ready: gate.ready,
      degradedEpisodeReason: gate.degradedReason,
    };
  }

  // ---- Weekly snapshot ----------------------------------------------------------------

  private async weeklyWindowDigestWithin(
    client: PoolClient,
    userId: string,
    input: { weekIdentifier: string; windowStartDate: string; windowEndDate: string },
  ): Promise<string | null> {
    const dayRows = await this.readWindowDaysWithin(client, userId, {
      startDate: input.windowStartDate,
      endDate: input.windowEndDate,
      dailySessionId: null,
    });
    if (dayRows.length === 0) {
      return null;
    }
    const evidenceRows = await this.readWindowEvidenceWithin(client, userId, {
      startDate: input.windowStartDate,
      endDate: input.windowEndDate,
      dailySessionId: null,
    });
    const episodes = await this.readWindowEpisodesWithin(client, userId, {
      startDate: input.windowStartDate,
      endDate: input.windowEndDate,
      dailySessionId: null,
    });
    const baselineDigest = await this.digestBaselineWithin(client, userId);
    const perDayCounts = new Map<string, number>();
    for (const row of evidenceRows) {
      perDayCounts.set(row.daily_session_id, (perDayCounts.get(row.daily_session_id) ?? 0) + 1);
    }
    const overBudget = [...perDayCounts.entries()]
      .filter(([_id, count]) => count > MAX_RAW_EVENTS_PER_DAY)
      .map(([id]) => id);
    const summaries = await this.readWindowSummariesWithin(client, userId, overBudget);
    const payload = {
      version: "reflection-week-window:v2",
      weekIdentifier: input.weekIdentifier,
      windowStartDate: input.windowStartDate,
      windowEndDate: input.windowEndDate,
      days: dayRows.map((day) => ({
        dailySessionId: day.daily_session_id,
        logicalDate: day.logical_date,
        sourceRevision: day.source_revision,
        summarized: day.summarized,
      })),
      evidence: evidenceRows.map((row) => ({
        evidenceItemId: row.evidence_item_id,
        revisionId: row.revision_id,
      })),
      episodes: episodes.map((episode) => episode.episodeVersionId),
      summaries: summaries.map((summary) => summary.rollingSummaryVersionId),
      claimBaselineDigest: baselineDigest,
    };
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  public async readWeeklySnapshot(input: {
    userId: UserId;
    weekIdentifier: string;
    windowStartDate: string;
    windowEndDate: string;
    sourceDigest: string;
    policyVersion: string;
  }): Promise<
    | Readonly<{
        outcome: "evaluated";
        snapshot: ReflectionEligibilitySnapshot;
        frozen: ReflectionFrozenInput;
      }>
    | Readonly<{ outcome: "not_ready" }>
    | Readonly<{ outcome: "stale_source" }>
    | Readonly<{ outcome: "digest_changed" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ status: string; data_epoch: string }>(
        "SELECT status, data_epoch::text FROM app_users WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow || ownerRow.status !== "active") {
        await client.query("COMMIT");
        return { outcome: "not_ready" };
      }
      const windowStartDate = input.windowStartDate;
      const windowEndDate = input.windowEndDate;
      const dayRows = await this.readWindowDaysWithin(client, input.userId, {
        startDate: windowStartDate,
        endDate: windowEndDate,
        dailySessionId: null,
      });
      if (dayRows.length === 0) {
        await client.query("COMMIT");
        return { outcome: "stale_source" };
      }
      const digest = await this.weeklyWindowDigestWithin(
        client,
        input.userId,
        {
          weekIdentifier: input.weekIdentifier,
          windowStartDate,
          windowEndDate,
        },
      );
      if (digest !== input.sourceDigest) {
        await client.query("COMMIT");
        return { outcome: "digest_changed" };
      }
      const frozen = await this.freezeWindowInputWithin(client, {
        userId: input.userId,
        scopeType: "date_range",
        window: {
          startDate: windowStartDate,
          endDate: windowEndDate,
          dailySessionId: null,
        },
        dayRows,
        sourceDigest: digest,
        weekIdentifier: input.weekIdentifier,
        windowStartDate,
        windowEndDate,
        setDayHead: false,
      });
      const snapshot: ReflectionEligibilitySnapshot = {
        userId: asUserId(input.userId),
        scopeType: "date_range",
        dailySessionId: null,
        weekIdentifier: input.weekIdentifier,
        sourceRevision: 0,
        sourceDigest: digest,
        ownerEpoch: Number(ownerRow.data_epoch),
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
        scopeType: "daily_session" | "date_range";
        dailySessionId: DailySessionId | null;
        sourceRevision: number;
        sourceDigest: string | null;
        claimBaselineDigest: string;
        policyVersion: string;
        promptVersion: string;
        schemaVersion: string;
        expectedDataEpoch: number;
        attemptNo: number;
        attemptStatus: "prepared";
        frozen: ReflectionFrozenInput;
      }>
    | Readonly<{ outcome: "settled" }>
    | Readonly<{ outcome: "not_found" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const command = await client.query<{
        user_id: string;
        expected_data_epoch: string;
      }>(
        `SELECT gc.user_id, gc.expected_data_epoch::text
         FROM generation_commands gc
         INNER JOIN model_run_attempts a
           ON a.generation_command_id = gc.generation_command_id
         WHERE gc.generation_command_id = $1
           AND a.model_run_attempt_id = $2`,
        [input.generationCommandId, input.modelRunAttemptId],
      );
      const commandRow = command.rows[0];
      if (!commandRow) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      const attempt = await client.query<{ status: string; attempt_no: number }>(
        "SELECT status, attempt_no FROM model_run_attempts WHERE model_run_attempt_id = $1",
        [input.modelRunAttemptId],
      );
      const attemptRow = attempt.rows[0];
      if (!attemptRow || attemptRow.status !== "prepared") {
        await client.query("COMMIT");
        return { outcome: "settled" };
      }
      const runRow = await client.query<{
        source_revision: string;
        source_digest: string | null;
        claim_baseline_digest: string;
        daily_session_id: string | null;
      }>(
        `SELECT r.source_revision::text, r.source_digest,
                r.claim_baseline_digest, r.daily_session_id::text
         FROM reflection_runs r
         WHERE r.generation_command_id = $1
         ORDER BY r.created_at DESC LIMIT 1`,
        [input.generationCommandId],
      );
      const run = runRow.rows[0];
      if (!run) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      const dailySessionId = run.daily_session_id
        ? asDailySessionId(run.daily_session_id)
        : null;
      let windowStartDate: string | null = null;
      let windowEndDate: string | null = null;
      if (dailySessionId) {
        const dayRow = await client.query<{ logical_date: string }>(
          "SELECT logical_date::text FROM daily_sessions WHERE daily_session_id = $1",
          [dailySessionId],
        );
        windowStartDate = dayRow.rows[0]?.logical_date ?? null;
        windowEndDate = windowStartDate;
        if (!windowStartDate) {
          await client.query("COMMIT");
          return { outcome: "not_found" };
        }
      } else {
        // The Weekly retry replays the frozen window recorded on the run row
        // — never a fabricated min-Monday over all the owner's sessions.
        const windowRow = await client.query<{
          window_start_date: string | null;
          window_end_date: string | null;
        }>(
          `SELECT r.window_start_date::text, r.window_end_date::text
           FROM reflection_runs r
           WHERE r.generation_command_id = $1
           ORDER BY r.created_at DESC LIMIT 1`,
          [input.generationCommandId],
        );
        const window = windowRow.rows[0];
        if (!window || !window.window_start_date || !window.window_end_date) {
          await client.query("COMMIT");
          return { outcome: "not_found" };
        }
        windowStartDate = window.window_start_date;
        windowEndDate = window.window_end_date;
        if (!isoWeekIdentifierOf(windowStartDate)) {
          await client.query("COMMIT");
          return { outcome: "not_found" };
        }
      }
      if (!windowStartDate || !windowEndDate) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      const dayRows = await this.readWindowDaysWithin(client, commandRow.user_id, {
        startDate: windowStartDate,
        endDate: windowEndDate,
        dailySessionId,
      });
      // The Weekly retry must reconstruct the exact week identity the first
      // attempt froze. `reflection_runs` has no week_identifier column, but the
      // stored window start is always the week Monday the identifier was
      // derived from, so recompute it here. An empty string would change the
      // `reflection-week-window:v2` digest and the retry would be discarded as
      // `source_changed` forever (issue #274).
      const weekIdentifier = dailySessionId
        ? null
        : windowStartDate
          ? isoWeekIdentifierOf(windowStartDate) || null
          : null;
      if (!dailySessionId && !weekIdentifier) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      const frozen = await this.freezeWindowInputWithin(client, {
        userId: commandRow.user_id,
        scopeType: dailySessionId ? "daily_session" : "date_range",
        window: {
          startDate: windowStartDate,
          endDate: windowEndDate,
          dailySessionId,
        },
        dayRows,
        sourceDigest: dailySessionId ? null : run.source_digest,
        weekIdentifier,
        windowStartDate,
        windowEndDate,
        setDayHead: Boolean(dailySessionId),
      });
      if (!frozen) {
        await client.query("COMMIT");
        return { outcome: "not_found" };
      }
      await client.query("COMMIT");
      return {
        outcome: "evaluated",
        userId: asUserId(commandRow.user_id),
        scopeType: dailySessionId ? "daily_session" : "date_range",
        dailySessionId,
        sourceRevision: Number(run.source_revision),
        sourceDigest: run.source_digest,
        claimBaselineDigest: run.claim_baseline_digest,
        policyVersion: "reflection-admission:v1",
        promptVersion: "",
        schemaVersion: REFLECTION_OUTPUT_SCHEMA_VERSION,
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

  // ---- Draft persist ------------------------------------------------------------------

  /** Create the content-free run ledger before the first Provider dispatch. */
  public async prepareAttempt(
    input: ReflectionAttemptPreparation,
  ): Promise<
    | Readonly<{ outcome: "prepared" | "already_prepared" | "already_built" }>
    | Readonly<{ outcome: "fenced"; reason: string }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (
        input.scopeType === "date_range" &&
        (!input.weekIdentifier ||
          !input.windowStartDate ||
          !input.windowEndDate)
      ) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "missing_week_window" };
      }
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
      if (input.scopeType === "daily_session") {
        const session = await client.query<{
          user_id: string;
          source_revision: string;
          activity_state: string;
        }>(
          `SELECT user_id, source_revision::text, activity_state
           FROM daily_sessions
           WHERE daily_session_id = $1 AND user_id = $2
           FOR UPDATE`,
          [input.dailySessionId, input.userId],
        );
        const sessionRow = session.rows[0];
        if (!sessionRow || Number(sessionRow.source_revision) !== input.sourceRevision) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "stale_source" };
        }
        if (sessionRow.activity_state !== "quiescent") {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "not_quiescent" };
        }
        if (await this.digestBaselineWithin(client, input.userId) !== input.claimBaselineDigest) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "baseline_changed" };
        }
      } else {
        if (
          !input.weekIdentifier ||
          !input.windowStartDate ||
          !input.windowEndDate
        ) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "missing_week_window" };
        }
        const digest = await this.weeklyWindowDigestWithin(client, input.userId, {
          weekIdentifier: input.weekIdentifier,
          windowStartDate: input.windowStartDate,
          windowEndDate: input.windowEndDate,
        });
        if (!digest || digest !== input.sourceDigest) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "digest_changed" };
        }
      }

      const runId = createUuidV7(input.now);
      const inserted = await client.query<{ status: string }>(
        `INSERT INTO reflection_runs (
           reflection_run_id, user_id, scope_type, daily_session_id,
           week_window_id, window_start_date, window_end_date,
           source_revision, source_digest, claim_baseline_digest,
           policy_version, expected_data_epoch, generation_command_id,
           model_run_attempt_id, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   $11, $12, $13, $14, 'ready', $15, $15)
         ON CONFLICT DO NOTHING
         RETURNING reflection_run_id, status`,
        [
          runId,
          input.userId,
          input.scopeType,
          input.dailySessionId,
          input.scopeType === "date_range"
            ? computeWeekWindowId(input.userId, input.weekIdentifier!)
            : null,
          input.windowStartDate,
          input.windowEndDate,
          input.sourceRevision,
          input.sourceDigest,
          input.claimBaselineDigest,
          input.policyVersion,
          input.expectedDataEpoch,
          input.generationCommandId,
          input.modelRunAttemptId,
          input.now,
        ],
      );
      if (inserted.rows[0]) {
        await client.query("COMMIT");
        return {
          outcome: inserted.rows[0].status === "built" ? "already_built" : "prepared",
        };
      }

      const existing = await client.query<{ status: string }>(
        input.scopeType === "daily_session"
          ? `SELECT status FROM reflection_runs
             WHERE user_id = $1 AND daily_session_id = $2
               AND source_revision = $3 AND claim_baseline_digest = $4
               AND policy_version = $5 AND scope_type = 'daily_session'
             FOR UPDATE`
          : `SELECT status FROM reflection_runs
             WHERE user_id = $1 AND week_window_id = $2
               AND source_digest = $3 AND policy_version = $4
               AND scope_type = 'date_range'
             FOR UPDATE`,
        input.scopeType === "daily_session"
          ? [
              input.userId,
              input.dailySessionId,
              input.sourceRevision,
              input.claimBaselineDigest,
              input.policyVersion,
            ]
          : [
              input.userId,
              computeWeekWindowId(input.userId, input.weekIdentifier!),
              input.sourceDigest,
              input.policyVersion,
            ],
      );
      if (existing.rows[0] && existing.rows[0].status !== "built") {
        await client.query(
          input.scopeType === "daily_session"
            ? `UPDATE reflection_runs
               SET generation_command_id = $6, model_run_attempt_id = $7,
                   expected_data_epoch = $8, updated_at = $9
               WHERE user_id = $1 AND daily_session_id = $2
                 AND source_revision = $3 AND claim_baseline_digest = $4
                 AND policy_version = $5 AND scope_type = 'daily_session'
                 AND status <> 'built'`
            : `UPDATE reflection_runs
               SET generation_command_id = $5, model_run_attempt_id = $6,
                   expected_data_epoch = $7, updated_at = $8
               WHERE user_id = $1 AND week_window_id = $2
                 AND source_digest = $3 AND policy_version = $4
                 AND scope_type = 'date_range' AND status <> 'built'`,
          input.scopeType === "daily_session"
            ? [
                input.userId,
                input.dailySessionId,
                input.sourceRevision,
                input.claimBaselineDigest,
                input.policyVersion,
                input.generationCommandId,
                input.modelRunAttemptId,
                input.expectedDataEpoch,
                input.now,
              ]
            : [
                input.userId,
                computeWeekWindowId(input.userId, input.weekIdentifier!),
                input.sourceDigest,
                input.policyVersion,
                input.generationCommandId,
                input.modelRunAttemptId,
                input.expectedDataEpoch,
                input.now,
              ],
        );
      }
      await client.query("COMMIT");
      return {
        outcome: existing.rows[0]?.status === "built" ? "already_built" : "already_prepared",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async persistDraftVersion(
    input: ReflectionDraftInput,
  ): Promise<ReflectionDraftResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (
        input.scopeType === "date_range" &&
        (!input.weekIdentifier ||
          !input.windowStartDate ||
          !input.windowEndDate)
      ) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "missing_week_window" };
      }
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
      if (input.scopeType === "daily_session") {
        const session = await client.query<{ source_revision: string }>(
          "SELECT source_revision::text FROM daily_sessions WHERE daily_session_id = $1",
          [input.dailySessionId],
        );
        const sessionRow = session.rows[0];
        if (!sessionRow) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "session_missing" };
        }
        if (Number(sessionRow.source_revision) !== input.sourceRevision) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "stale_source" };
        }
        const digest = await this.digestBaselineWithin(client, input.userId);
        if (digest !== input.claimBaselineDigest) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "baseline_changed" };
        }
      } else {
        if (
          !input.weekIdentifier ||
          !input.windowStartDate ||
          !input.windowEndDate
        ) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "missing_week_window" };
        }
        const weekMonday = input.windowStartDate;
        const dayRows = await this.readWindowDaysWithin(client, input.userId, {
          startDate: weekMonday,
          endDate: addDaysToDateString(weekMonday, 6),
          dailySessionId: null,
        });
        const digest = dayRows.length
          ? await this.weeklyWindowDigestWithin(client, input.userId, {
              weekIdentifier: input.weekIdentifier,
              windowStartDate: weekMonday,
              windowEndDate: input.windowEndDate,
            })
          : null;
        if (!digest || digest !== input.sourceDigest) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "digest_changed" };
        }
      }

      const now = input.now;
      // Logical Reflection identity: one per Daily Session / week window.
      const reflectionRow = await client.query<{
        reflection_id: string;
        current_version_id: string | null;
      }>(
        `INSERT INTO reflections (
           reflection_id, user_id, scope_type, daily_session_id,
           week_window_id, week_identifier, window_start_date, window_end_date,
           created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, daily_session_id)
           WHERE scope_type = 'daily_session' AND deleted_at IS NULL
         DO UPDATE SET reflection_id = reflections.reflection_id
         RETURNING reflection_id, current_version_id`,
        [
          createUuidV7(now),
          input.userId,
          input.scopeType,
          input.dailySessionId,
          input.scopeType === "date_range"
            ? computeWeekWindowId(input.userId, input.weekIdentifier!)
            : null,
          input.weekIdentifier,
          input.windowStartDate,
          input.windowEndDate,
          now,
        ],
      );
      const reflection = reflectionRow.rows[0]!;
      const revisionRow = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS next
         FROM reflection_versions WHERE reflection_id = $1`,
        [reflection.reflection_id],
      );
      const nextRevision = revisionRow.rows[0]!.next;
      const versionInsertSql = `
          INSERT INTO reflection_versions (
            reflection_version_id, reflection_id, user_id, revision, scope_type,
            source_revision, source_digest, claim_baseline_digest,
            schedule_policy_version, policy_version, prompt_version,
            schema_version, locale, status, degraded_episode_reason,
            statements, candidate_proposals, generation_command_id,
            authoritative_model_attempt_id, supersedes_version_id,
            status_effective_at, content_expires_at, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            'draft', $14, $15::jsonb, $16::jsonb, $17, $18, $19, $20, $21, $20)
          ${
            input.scopeType === "daily_session"
              ? "ON CONFLICT (reflection_id, source_revision, claim_baseline_digest, policy_version) WHERE scope_type = 'daily_session' DO NOTHING"
              : "ON CONFLICT (reflection_id, source_digest, policy_version) WHERE scope_type = 'date_range' DO NOTHING"
          }
          RETURNING reflection_version_id`;
      const inserted = await client.query<{ reflection_version_id: string }>(
        versionInsertSql,
        [
          createUuidV7(now),
          reflection.reflection_id,
          input.userId,
          nextRevision,
          input.scopeType,
          input.sourceRevision,
          input.sourceDigest,
          input.claimBaselineDigest,
          input.schedulePolicyVersion,
          input.policyVersion,
          input.promptVersion,
          input.schemaVersion,
          input.locale,
          input.degradedEpisodeReason,
          JSON.stringify({ statements: input.statements }),
          JSON.stringify({ proposals: [] }),
          input.generationCommandId,
          input.modelRunAttemptId,
          reflection.current_version_id,
          now,
          new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        ],
      );
      let reflectionVersionId: string;
      let alreadyPersisted = false;
      if (inserted.rows[0]) {
        reflectionVersionId = inserted.rows[0].reflection_version_id;
      } else {
        const existing = await client.query<{ reflection_version_id: string }>(
          input.scopeType === "daily_session"
            ? `SELECT reflection_version_id FROM reflection_versions
               WHERE reflection_id = $1 AND source_revision = $2
                 AND claim_baseline_digest = $3 AND policy_version = $4
                 AND scope_type = 'daily_session'`
            : `SELECT reflection_version_id FROM reflection_versions
               WHERE reflection_id = $1 AND source_digest = $5
                 AND policy_version = $4
                 AND scope_type = 'date_range'`,
          [
            reflection.reflection_id,
            input.sourceRevision,
            input.claimBaselineDigest,
            input.policyVersion,
            input.sourceDigest,
          ],
        );
        const existingRow = existing.rows[0];
        if (!existingRow) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "identity_conflict" };
        }
        reflectionVersionId = existingRow.reflection_version_id;
        alreadyPersisted = true;
      }
      await client.query(
        `INSERT INTO reflection_runs (
           reflection_run_id, user_id, scope_type, daily_session_id,
           week_window_id, window_start_date, window_end_date,
           source_revision, source_digest,
           claim_baseline_digest, policy_version, expected_data_epoch,
           generation_command_id, model_run_attempt_id, status,
           statement_count, candidate_count, degraded_episode_reason,
           created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, 'ready', $15, 0, $16, $17, $17)
         ${
           input.scopeType === "daily_session"
             ? "ON CONFLICT (user_id, daily_session_id, source_revision, claim_baseline_digest, policy_version) WHERE scope_type = 'daily_session' DO UPDATE SET updated_at = EXCLUDED.updated_at"
             : "ON CONFLICT (user_id, week_window_id, source_digest, policy_version) WHERE scope_type = 'date_range' DO UPDATE SET updated_at = EXCLUDED.updated_at"
         }`,
        [
          createUuidV7(now),
          input.userId,
          input.scopeType,
          input.dailySessionId,
          input.scopeType === "date_range"
            ? computeWeekWindowId(input.userId, input.weekIdentifier!)
            : null,
          input.windowStartDate,
          input.windowEndDate,
          input.sourceRevision,
          input.sourceDigest,
          input.claimBaselineDigest,
          input.policyVersion,
          input.expectedDataEpoch,
          input.generationCommandId,
          input.modelRunAttemptId,
          input.statements.length,
          input.degradedEpisodeReason,
          now,
        ],
      );
      await client.query("COMMIT");
      return {
        outcome: alreadyPersisted ? "already_persisted" : "persisted",
        reflectionVersionId: asReflectionVersionId(reflectionVersionId),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // ---- Fenced commit + Candidate handoff ----------------------------------------------

  public async commitReflection(
    input: ReflectionCommitInput,
  ): Promise<ReflectionCommitResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (
        input.frozen.scopeType === "date_range" &&
        (!input.frozen.weekIdentifier ||
          !input.frozen.windowStartDate ||
          !input.frozen.windowEndDate)
      ) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "missing_week_window" };
      }
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
      // Exact head + baseline recheck (SPEC 5.3, CAS).
      if (input.frozen.scopeType === "daily_session") {
        const session = await client.query<{ source_revision: string }>(
          "SELECT source_revision::text FROM daily_sessions WHERE daily_session_id = $1",
          [input.frozen.dailySessionId],
        );
        const sessionRow = session.rows[0];
        if (!sessionRow) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "session_missing" };
        }
        if (Number(sessionRow.source_revision) !== input.sourceRevision) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "stale_source" };
        }
        const digest = await this.digestBaselineWithin(client, input.userId);
        if (digest !== input.claimBaselineDigest) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "baseline_changed" };
        }
      } else {
        if (
          !input.frozen.weekIdentifier ||
          !input.frozen.windowStartDate ||
          !input.frozen.windowEndDate
        ) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "missing_week_window" };
        }
        const weekMonday = input.frozen.windowStartDate;
        const dayRows = await this.readWindowDaysWithin(client, input.userId, {
          startDate: weekMonday,
          endDate: addDaysToDateString(weekMonday, 6),
          dailySessionId: null,
        });
        if (dayRows.length === 0) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "digest_changed" };
        }
        const digest = await this.weeklyWindowDigestWithin(
          client,
          input.userId,
          {
            weekIdentifier: input.frozen.weekIdentifier,
            windowStartDate: weekMonday,
            windowEndDate: input.frozen.windowEndDate,
          },
        );
        if (digest !== input.sourceDigest) {
          await client.query("ROLLBACK");
          return { outcome: "fenced", reason: "digest_changed" };
        }
      }

      // Active rollout pin fence: the pinned config on the generator command
      // must still be the role's active pin.
      const role =
        input.frozen.scopeType === "daily_session"
          ? "reflection.daily"
          : "reflection.weekly";
      const pinRow = await client.query<{
        rollout_pin: string | null;
        active_pin: string | null;
      }>(
        `SELECT gc.rollout_pin, p.rollout_pin AS active_pin
         FROM generation_commands gc
         LEFT JOIN model_role_rollout_pins p
           ON p.role = gc.model_role AND p.status = 'active'
         WHERE gc.generation_command_id = $1`,
        [input.generationCommandId],
      );
      const pin = pinRow.rows[0];
      if (!pin || pin.active_pin === null || pin.active_pin !== pin.rollout_pin) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "rollout_pin" };
      }

      const versionRow = await client.query<{
        reflection_version_id: string;
        reflection_id: string;
        current_version_id: string | null;
        locale: string;
        status: string;
      }>(
        `SELECT v.reflection_version_id, v.reflection_id, r.current_version_id,
                v.locale, v.status
         FROM reflection_versions v
         INNER JOIN reflections r ON r.reflection_id = v.reflection_id
         WHERE v.reflection_version_id = $1 AND v.user_id = $2
         FOR UPDATE OF v`,
        [input.reflectionVersionId, input.userId],
      );
      const version = versionRow.rows[0];
      if (!version) {
        await client.query("ROLLBACK");
        return { outcome: "fenced", reason: "draft_missing" };
      }
      const now = new Date();
      // CAS transition: draft → committed, then the current pointer follows.
      const transition = await client.query(
        `UPDATE reflection_versions
         SET status = 'committed', committed_at = $3,
             status_effective_at = $3, content_expires_at = NULL,
             validator_request_id = $4, validator_result_id = $5
         WHERE reflection_version_id = $1 AND user_id = $2
           AND status = 'draft' AND content_purged_at IS NULL`,
        [
          input.reflectionVersionId,
          input.userId,
          now,
          input.validatorRequestId,
          input.validatorResultId,
        ],
      );
      if ((transition.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { outcome: "already_committed" };
      }
      const previousCurrent = version.current_version_id;
      if (previousCurrent && previousCurrent !== input.reflectionVersionId) {
        await client.query(
          `UPDATE reflection_versions
           SET status = 'superseded', status_effective_at = $3::timestamptz,
               content_expires_at = $3::timestamptz + make_interval(days => $4)
           WHERE reflection_version_id = $1 AND user_id = $2
             AND status = 'committed'`,
          [previousCurrent, input.userId, now, 30],
        );
        await client.query(
          `UPDATE reflection_versions
           SET supersedes_version_id = $3
           WHERE reflection_version_id = $1 AND user_id = $2`,
          [input.reflectionVersionId, input.userId, previousCurrent],
        );
      }
      await client.query(
        `UPDATE reflections SET current_version_id = $3
         WHERE reflection_id = $1 AND user_id = $2`,
        [version.reflection_id, input.userId, input.reflectionVersionId],
      );

      // Typed statement / proposition / Evidence-only support rows.
      const statementCount = input.statements.length;
      for (const [statementIndex, statement] of input.statements.entries()) {
        const statementId = createUuidV7(now);
        await client.query(
          `INSERT INTO reflection_statements (
             reflection_statement_id, reflection_version_id, user_id,
             statement_index, statement_kind, statement_text
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            statementId,
            input.reflectionVersionId,
            input.userId,
            statementIndex,
            statement.statementKind,
            statement.text,
          ],
        );
        for (const [propositionIndex, proposition] of statement.propositions.entries()) {
          const propositionId = createUuidV7(now);
          await client.query(
            `INSERT INTO reflection_atomic_propositions (
               reflection_atomic_proposition_id, reflection_statement_id,
               user_id, proposition_index, normalized_proposition,
               proposition_kind, epistemic_rendering, baseline_claim_ids
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
            [
              propositionId,
              statementId,
              input.userId,
              propositionIndex,
              proposition.normalizedProposition,
              proposition.propositionKind,
              proposition.epistemicRendering,
              JSON.stringify([...proposition.baselineClaimIds]),
            ],
          );
          for (const evidenceItemId of proposition.supportEvidenceItemIds) {
            await client.query(
              `INSERT INTO reflection_statement_evidence_links (
                 reflection_statement_evidence_link_id,
                 reflection_atomic_proposition_id, user_id, evidence_item_id,
                 created_at
               ) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (reflection_atomic_proposition_id, evidence_item_id)
               DO NOTHING`,
              [
                createUuidV7(now),
                propositionId,
                input.userId,
                evidenceItemId,
                now,
              ],
            );
          }
        }
      }

      // Candidate handoff: propose_new only, through the Memory admission
      // pipeline pieces (fingerprint + terminal fence).
      let candidateCount = 0;
      const selfEntity = await client.query<{ entity_id: string }>(
        `SELECT e.entity_id
         FROM user_self_entities use
         INNER JOIN entities e
           ON e.entity_id = use.entity_id AND e.user_id = use.user_id
         WHERE use.user_id = $1 AND e.deleted_at IS NULL
         LIMIT 1`,
        [input.userId],
      );
      const selfEntityId = selfEntity.rows[0]?.entity_id ?? null;
      const candidateOutcomes: import("@sayhear/application").ReflectionCandidateOutcome[] = [];
      for (const [proposalIndex, proposalFromModel] of input.candidateProposals.entries()) {
        if (!selfEntityId) {
          candidateOutcomes.push({
            proposalIndex,
            outcome: "skipped",
            reasonCode: "self_entity_missing",
            memoryCandidateId: null,
          });
          continue;
        }
        const planned = planReflectionCandidate({
          frozen: input.frozen,
          reflectionVersionId: input.reflectionVersionId,
          proposalFromModel,
          registry: this.registry,
          selfEntityId,
          userId: input.userId,
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
          modelVersion: null,
          promptVersion: input.promptVersion,
          dedupeFingerprintSecret: input.dedupeFingerprintSecret,
          now,
        });
        if (planned.outcome === "skipped") {
          await recordCandidateProposal(client, {
            reflectionVersionId: input.reflectionVersionId,
            userId: input.userId,
            outcome: "skipped",
            reasonCode: planned.reasonCode,
            memoryCandidateId: null,
            fingerprint: null,
            now,
          });
          candidateOutcomes.push({
            proposalIndex,
            outcome: "skipped",
            reasonCode: planned.reasonCode,
            memoryCandidateId: null,
          });
          continue;
        }
        const terminal = await findTerminalCandidateByFingerprintWithin(
          client,
          input.userId,
          planned.candidate.dedupeFingerprint,
        );
        if (terminal) {
          await recordCandidateProposal(client, {
            reflectionVersionId: input.reflectionVersionId,
            userId: input.userId,
            outcome: "blocked_terminal",
            reasonCode: terminal.dispositionReasonCode,
            memoryCandidateId: null,
            fingerprint: planned.candidate.dedupeFingerprint,
            now,
          });
          candidateOutcomes.push({
            proposalIndex,
            outcome: "blocked_terminal",
            reasonCode: terminal.dispositionReasonCode,
            memoryCandidateId: null,
          });
          continue;
        }
        const openFingerprint = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM memory_candidates
           WHERE user_id = $1 AND dedupe_fingerprint = $2
             AND status IN ('proposed', 'needs_predicate_review')`,
          [input.userId, planned.candidate.dedupeFingerprint],
        );
        if (Number(openFingerprint.rows[0]?.count ?? 0) > 0) {
          await recordCandidateProposal(client, {
            reflectionVersionId: input.reflectionVersionId,
            userId: input.userId,
            outcome: "skipped",
            reasonCode: "candidate_open_duplicate",
            memoryCandidateId: null,
            fingerprint: planned.candidate.dedupeFingerprint,
            now,
          });
          candidateOutcomes.push({
            proposalIndex,
            outcome: "skipped",
            reasonCode: "candidate_open_duplicate",
            memoryCandidateId: null,
          });
          continue;
        }
        const proposal = planned.candidate.proposal;
        const insertedCandidateId = await insertMemoryCandidateWithin(client, {
          proposal:
            proposal.resolution.status === "mapped"
              ? {
                  ...proposal,
                  resolution: {
                    ...proposal.resolution,
                    registryVersion: this.registry.registryVersion(),
                  },
                }
              : proposal,
          status: proposal.resolution.status === "mapped" ? "proposed" : "needs_predicate_review",
          reviewDueAt:
            proposal.resolution.status === "mapped"
              ? null
              : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
          now,
        });
        await insertCandidateEvidenceLinksWithin(client, {
          userId: input.userId,
          candidateId: insertedCandidateId,
          evidenceItemIds: [...proposal.evidenceItemIds],
          now,
        });
        // The lineage ledger stores the coarse outcome union allowed by schema
        // 0047. The needs_predicate_review distinction is carried by the
        // Candidate's actual status and the rich returned outcome below, so
        // every successful creation persists `created` here.
        const richOutcome =
          proposal.resolution.status === "mapped"
            ? "created"
            : "created_needs_predicate_review";
        await recordCandidateProposal(client, {
          reflectionVersionId: input.reflectionVersionId,
          userId: input.userId,
          outcome: "created",
          reasonCode: null,
          memoryCandidateId: insertedCandidateId,
          fingerprint: planned.candidate.dedupeFingerprint,
          now,
        });
        candidateOutcomes.push({
          proposalIndex,
          outcome: richOutcome,
          reasonCode: null,
          memoryCandidateId: insertedCandidateId,
        });
        candidateCount += 1;
      }

      // Run ledger: built. Both scopes converge on their own identity key.
      if (input.frozen.scopeType === "daily_session") {
        await client.query(
          `UPDATE reflection_runs
           SET status = 'built', statement_count = $2, candidate_count = $3,
               updated_at = $4
           WHERE user_id = $1 AND source_revision = $5
             AND claim_baseline_digest = $6 AND scope_type = 'daily_session'`,
          [input.userId, statementCount, candidateCount, now, input.sourceRevision, input.claimBaselineDigest],
        );
      } else {
        await client.query(
          `UPDATE reflection_runs
           SET status = 'built', statement_count = $2, candidate_count = $3,
               updated_at = $4
           WHERE user_id = $1 AND source_digest = $5
             AND scope_type = 'date_range'`,
          [input.userId, statementCount, candidateCount, now, input.sourceDigest],
        );
      }
      await client.query("COMMIT");
      return {
        outcome: "committed",
        reflectionVersionId: asReflectionVersionId(input.reflectionVersionId),
        statementCount,
        candidateCount,
        candidateOutcomes,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordRunOutcome(
    input: ReflectionRunOutcomeRow,
  ): Promise<{ applied: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (
        input.scopeType === "date_range" &&
        (!input.weekIdentifier ||
          !input.windowStartDate ||
          !input.windowEndDate)
      ) {
        await client.query("ROLLBACK");
        return { applied: false };
      }
      if (
        input.generationCommandId &&
        input.modelRunAttemptId &&
        !(await modelRoleAttemptIsRunning(client, {
          userId: input.userId,
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
        }))
      ) {
        await client.query("ROLLBACK");
        return { applied: false };
      }
      const insert = await client.query(
        `INSERT INTO reflection_runs (
           reflection_run_id, user_id, scope_type, daily_session_id,
           week_window_id, window_start_date, window_end_date,
           source_revision, source_digest,
           claim_baseline_digest, policy_version, expected_data_epoch,
           generation_command_id, model_run_attempt_id, status,
           outcome_detail, statement_count, candidate_count,
           degraded_episode_reason, error_code, created_at, updated_at
         )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20, $21, $21)
         ${
           input.scopeType === "daily_session"
             ? "ON CONFLICT (user_id, daily_session_id, source_revision, claim_baseline_digest, policy_version) WHERE scope_type = 'daily_session' DO UPDATE SET"
             : "ON CONFLICT (user_id, week_window_id, source_digest, policy_version) WHERE scope_type = 'date_range' DO UPDATE SET"
         }
           status = CASE
             WHEN reflection_runs.status = 'built' THEN 'built'
             ELSE EXCLUDED.status
           END,
           outcome_detail = CASE WHEN reflection_runs.status = 'built'
              THEN reflection_runs.outcome_detail
              ELSE COALESCE(EXCLUDED.outcome_detail, reflection_runs.outcome_detail) END,
           error_code = CASE WHEN reflection_runs.status = 'built'
              THEN reflection_runs.error_code
              ELSE COALESCE(EXCLUDED.error_code, reflection_runs.error_code) END,
           updated_at = EXCLUDED.updated_at`,
        [
          createUuidV7(new Date()),
          input.userId,
          input.scopeType,
          input.dailySessionId,
          input.scopeType === "date_range"
            ? computeWeekWindowId(input.userId, input.weekIdentifier!)
            : null,
          input.windowStartDate,
          input.windowEndDate,
          input.sourceRevision,
          input.sourceDigest,
          input.claimBaselineDigest,
          input.policyVersion,
          input.expectedDataEpoch,
          input.generationCommandId,
          input.modelRunAttemptId,
          input.status,
          input.outcomeDetail,
          input.statementCount,
          input.candidateCount,
          input.degradedEpisodeReason,
          input.errorCode,
          new Date(),
        ],
      );
      await client.query("COMMIT");
      return { applied: (insert.rowCount ?? 0) > 0 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async markStaleByInvalidatedEvidence(input: {
    userId: UserId;
    policyVersion: string;
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
      // Reverse lineage (SPEC 5.3): Evidence correction / deletion /
      // invalidation marks affected versions stale immediately; regeneration
      // happens on the next cadence.
      const affected = await client.query<{ reflection_version_id: string }>(
        `SELECT DISTINCT v.reflection_version_id
         FROM reflection_versions v
         INNER JOIN reflection_statements st
           ON st.reflection_version_id = v.reflection_version_id
         INNER JOIN reflection_atomic_propositions p
           ON p.reflection_statement_id = st.reflection_statement_id
         INNER JOIN reflection_statement_evidence_links l
           ON l.reflection_atomic_proposition_id = p.reflection_atomic_proposition_id
         INNER JOIN evidence_items item
           ON item.evidence_item_id = l.evidence_item_id
         INNER JOIN conversation_events ev
           ON ev.conversation_event_id = item.source_event_id
         INNER JOIN conversation_event_revisions rev
           ON rev.conversation_event_revision_id = item.source_revision_id
         WHERE v.user_id = $1 AND v.status IN ('committed', 'draft')
           AND v.content_purged_at IS NULL
           AND (item.status <> 'active'
             OR ev.lifecycle_status <> 'active'
             OR ev.current_revision_id IS DISTINCT FROM rev.conversation_event_revision_id
             OR rev.content_purged_at IS NOT NULL)
         ORDER BY v.reflection_version_id
         LIMIT $2`,
        [input.userId, input.limit],
      );
      let staled = 0;
      for (const version of affected.rows) {
        const now = new Date();
        const updated = await client.query(
          `UPDATE reflection_versions
           SET status = 'stale', status_effective_at = $3::timestamptz,
               content_expires_at = $3::timestamptz + make_interval(days => $4)
           WHERE reflection_version_id = $1 AND user_id = $2
             AND status IN ('committed', 'draft')
             AND content_purged_at IS NULL`,
          [version.reflection_version_id, input.userId, now, 7],
        );
        if ((updated.rowCount ?? 0) > 0) {
          staled += 1;
        }
      }
      await client.query("COMMIT");
      return staled;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async purgeExpiredContent(input: {
    now: Date;
    limit: number;
  }): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<{ reflection_version_id: string }>(
        `SELECT reflection_version_id FROM reflection_versions
         WHERE content_purged_at IS NULL AND status <> 'committed'
           AND content_expires_at IS NOT NULL AND content_expires_at <= $1
         ORDER BY content_expires_at
         LIMIT $2`,
        [input.now, input.limit],
      );
      let purged = 0;
      for (const version of expired.rows) {
        // Expired content leaves only a content-free lineage envelope: the
        // typed content rows are deleted and the frozen statement/proposal
        // JSON transitions to NULL with content_purged_at (ADR-0130).
        await client.query(
          `DELETE FROM reflection_statement_evidence_links l
           USING reflection_atomic_propositions p
           WHERE l.reflection_atomic_proposition_id = p.reflection_atomic_proposition_id
             AND p.reflection_statement_id IN (
               SELECT reflection_statement_id FROM reflection_statements
               WHERE reflection_version_id = $1
             )`,
          [version.reflection_version_id],
        );
        await client.query(
          `DELETE FROM reflection_atomic_propositions p
           USING reflection_statements st
           WHERE p.reflection_statement_id = st.reflection_statement_id
             AND st.reflection_version_id = $1`,
          [version.reflection_version_id],
        );
        await client.query(
          "DELETE FROM reflection_statements WHERE reflection_version_id = $1",
          [version.reflection_version_id],
        );
        await client.query(
          "DELETE FROM reflection_candidate_proposals WHERE reflection_version_id = $1",
          [version.reflection_version_id],
        );
        await client.query(
          `UPDATE reflection_versions
           SET statements = NULL, candidate_proposals = NULL,
               content_purged_at = $2
           WHERE reflection_version_id = $1 AND content_purged_at IS NULL`,
          [version.reflection_version_id, input.now],
        );
        purged += 1;
      }
      await client.query("COMMIT");
      return purged;
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
      `SELECT DISTINCT u.user_id FROM app_users u
       WHERE u.status = 'active'
         AND (
           EXISTS (
             SELECT 1 FROM reflection_versions v
             WHERE v.user_id = u.user_id AND v.content_purged_at IS NULL
               AND v.status <> 'committed'
               AND v.content_expires_at IS NOT NULL
               AND v.content_expires_at <= $1
           )
           OR EXISTS (
             SELECT 1
             FROM reflection_versions sv
             INNER JOIN reflection_statements st
               ON st.reflection_version_id = sv.reflection_version_id
             INNER JOIN reflection_atomic_propositions p
               ON p.reflection_statement_id = st.reflection_statement_id
             INNER JOIN reflection_statement_evidence_links l
               ON l.reflection_atomic_proposition_id = p.reflection_atomic_proposition_id
             INNER JOIN evidence_items item
               ON item.evidence_item_id = l.evidence_item_id
             INNER JOIN conversation_events ev
               ON ev.conversation_event_id = item.source_event_id
             INNER JOIN conversation_event_revisions rev
               ON rev.conversation_event_revision_id = item.source_revision_id
             WHERE sv.user_id = u.user_id AND sv.status = 'committed'
               AND sv.content_purged_at IS NULL
               AND (item.status <> 'active'
                 OR ev.lifecycle_status <> 'active'
                 OR ev.current_revision_id IS DISTINCT FROM rev.conversation_event_revision_id
                 OR rev.content_purged_at IS NOT NULL)
           )
         )
       ORDER BY u.user_id
       LIMIT $2`,
      [input.now, input.limit],
    );
    return result.rows.map((row) => asUserId(row.user_id));
  }

  public async readCurrentVersion(input: {
    userId: UserId;
    dailySessionId: DailySessionId | null;
    weekIdentifier: string | null;
    now: Date;
  }): Promise<
    | Readonly<{
        outcome: "ok";
        reflectionVersionId: ReflectionVersionId;
        status: "committed";
        statements: readonly ReflectionModelStatement[];
      }>
    | Readonly<{ outcome: "no_current_version" }>
    | Readonly<{ outcome: "content_expired" }>
    | Readonly<{ outcome: "content_purged" }>
    | Readonly<{ outcome: "stale" }>
    | Readonly<{ outcome: "not_found" }>
  > {
    const result = await this.pool.query<{
      reflection_version_id: string;
      status: string;
      content_expires_at: Date | null;
      statements: unknown;
      content_purged_at: Date | null;
    }>(
      `SELECT v.reflection_version_id, v.status, v.content_expires_at,
              v.statements, v.content_purged_at
       FROM reflections r
       INNER JOIN reflection_versions v
         ON v.reflection_version_id = r.current_version_id
       WHERE r.user_id = $1
         AND (($2::uuid IS NOT NULL AND r.daily_session_id = $2::uuid)
           OR ($3::text IS NOT NULL AND r.week_identifier = $3::text))
       LIMIT 1`,
      [input.userId, input.dailySessionId, input.weekIdentifier],
    );
    const row = result.rows[0];
    if (!row) {
      return { outcome: "no_current_version" };
    }
    if (row.status === "stale") {
      return { outcome: "stale" };
    }
    if (row.content_purged_at) {
      return { outcome: "content_purged" };
    }
    if (
      row.content_expires_at &&
      row.content_expires_at.getTime() <= input.now.getTime()
    ) {
      // Read-time retention (ADR-0130): the deadline is effective immediately.
      return { outcome: "content_expired" };
    }
    const envelope = row.statements as { statements?: unknown } | null;
    const statements = Array.isArray(envelope?.statements)
      ? (envelope.statements as ReflectionModelStatement[])
      : [];
    return {
      outcome: "ok",
      reflectionVersionId: asReflectionVersionId(row.reflection_version_id),
      status: "committed",
      statements,
    };
  }
}
