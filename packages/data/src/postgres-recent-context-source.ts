import type { Pool, PoolClient } from "pg";

import type {
  RecentContextControlReason,
  RecentContextPerDateCoverage,
  RecentContextSourceItem,
  RecentContextSourcePort,
  RecentContextSourceRequest,
  RecentContextSourceSnapshot,
} from "@sayhear/application";
import {
  asConversationEventRevisionId,
  asDailySessionId,
  asInteractionTurnId,
} from "@sayhear/domain";

type RawCoverage = Readonly<{
  localDate: string;
  candidateRows: number;
  bounded: boolean;
  empty: boolean;
}>;

type CandidateRow = Readonly<{
  actor: "user" | "assistant" | null;
  cap_bounded: boolean;
  candidate_count: string;
  daily_session_id: string | null;
  exclusion: { controlId: string; reason: string } | null;
  expressed_at: Date | null;
  fitting_cap_hit: boolean;
  generation_command_id: string | null;
  generating_user_revision_id: string | null;
  interaction_turn_id: string | null;
  oversized_seen: boolean;
  per_date: readonly RawCoverage[] | null;
  revision_id: string | null;
  row_bounded: boolean;
  sequence_no: string | null;
  text: string | null;
  text_bytes: string | null;
}>;

const SUPPORTED_CONTROL_REASONS: readonly RecentContextControlReason[] = [
  "correction_association",
  "forget_association",
];

/**
 * The single bounded, date-stratified candidate query (see
 * {@link PostgresRecentContextSource}).
 *
 * Each of the seven local dates is read through its own index-ordered
 * `LIMIT (per_date_limit + 1)` (one extra row detects whether the date was
 * bounded), so database work is bounded — not by a WindowAgg over every
 * in-window event. The returned body set is independently capped at exactly
 * $7 rows by the round-robin `overall_rank <= $7` filter, so a
 * `maxCandidateRows` smaller than the window can never return more bodies
 * than declared; uncovered dates stay explicitly reported rather than
 * over-fetched. The fixed metadata overhead is bounded and documented:
 * `per_date_limit = GREATEST(1, FLOOR($7 / window_days))`, so at most
 * `window_days * (per_date_limit + 1)` candidate rows are read, i.e.
 * `<= $7 + 2 * window_days` in the worst case. Only then are the per-row byte
 * guard and the cumulative fitting-byte budget applied. A single oversized
 * row is returned (the selector omits it with `single_event_over_budget`) but
 * contributes nothing to the cumulative sum, so it can never empty the whole
 * window. Fitting rows rank ahead of oversized rows within a date, so an
 * oversized newest event cannot occupy the only day slot; a date whose only
 * candidates are oversized still returns its newest oversized row. The
 * cumulative budget is charged over the row/day-capped set only, so discarded
 * probe / over-cap rows never evict an older date's fitting representative.
 * Every ranking/order clause uses the numeric sequence, never its text form.
 *
 * Parameters: $1 user, $2 timezone, $3 window start local date,
 * $4 window end local date, $5 cutoff instant, $6 excluded revisions,
 * $7 total row cap, $8 candidate byte cap.
 */
export const RECENT_CONTEXT_CANDIDATE_SQL = `
  WITH window_dates AS (
    SELECT generate_series($3::date, $4::date, interval '1 day')::date
      AS local_date
  ),
  params AS (
    SELECT GREATEST(
      1,
      FLOOR($7::numeric / (SELECT COUNT(*) FROM window_dates))::int
    ) AS per_date_limit
  ),
  fetched AS (
    SELECT window_dates.local_date, candidate.*
    FROM window_dates
    CROSS JOIN params p
    LEFT JOIN LATERAL (
      SELECT
        event.daily_session_id::text AS daily_session_id,
        event.interaction_turn_id::text AS interaction_turn_id,
        event.sequence_no::text AS sequence_no,
        event.sequence_no AS sequence_ord,
        event.actor,
        event.generation_command_id::text AS generation_command_id,
        CASE
          WHEN event.actor = 'assistant'
            AND generating_command.subject_type = 'conversation_event'
            AND generating_command.input_revision_kind =
              'conversation_event_revision'
          THEN generating_command.input_revision_id::text
        END AS generating_user_revision_id,
        revision.conversation_event_revision_id::text AS revision_id,
        revision.canonical_text AS text,
        pg_catalog.octet_length(revision.canonical_text) AS text_bytes,
        event.created_at AS expressed_at,
        COALESCE(
          (
            SELECT jsonb_build_object(
              'controlId', exclusion.memory_forget_request_id::text,
              'reason', 'forget_association'
            )
            FROM evidence_items item
            INNER JOIN memory_forget_evidence_exclusions exclusion
              ON exclusion.evidence_item_id = item.evidence_item_id
             AND exclusion.user_id = item.user_id
            WHERE item.user_id = event.user_id
              AND item.source_revision_id =
                revision.conversation_event_revision_id
              AND item.status = 'active'
              AND exclusion.status = 'active'
            ORDER BY exclusion.created_at
            LIMIT 1
          ),
          (
            SELECT jsonb_build_object(
              'controlId', correction.memory_claim_correction_id::text,
              'reason', 'correction_association'
            )
            FROM claim_evidence_links link
            INNER JOIN evidence_items item
              ON item.evidence_item_id = link.evidence_item_id
             AND item.user_id = link.user_id
            INNER JOIN memory_claim_corrections correction
              ON correction.deactivated_claim_version_id =
                link.memory_claim_version_id
             AND correction.user_id = link.user_id
            WHERE link.user_id = event.user_id
              AND link.status = 'active'
              AND item.source_revision_id =
                revision.conversation_event_revision_id
            ORDER BY correction.created_at
            LIMIT 1
          )
        ) AS exclusion
      FROM conversation_events event
      INNER JOIN conversation_event_revisions revision
        ON revision.conversation_event_revision_id =
          event.current_revision_id
       AND revision.user_id = event.user_id
      LEFT JOIN generation_commands generating_command
        ON generating_command.generation_command_id =
          event.generation_command_id
       AND generating_command.user_id = event.user_id
      WHERE event.user_id = $1
        AND event.actor IN ('user', 'assistant')
        AND event.lifecycle_status = 'active'
        AND revision.content_purged_at IS NULL
        AND revision.transcript_status IN ('final', 'corrected')
        AND event.created_at >=
          (window_dates.local_date::timestamp AT TIME ZONE $2)
        AND event.created_at <
          ((window_dates.local_date + 1)::timestamp AT TIME ZONE $2)
        AND event.created_at <= $5::timestamptz
        AND NOT (
          revision.conversation_event_revision_id = ANY($6::uuid[])
        )
      ORDER BY event.created_at DESC,
        event.daily_session_id DESC,
        event.sequence_no DESC
      LIMIT p.per_date_limit + 1
    ) candidate ON TRUE
  ),
  candidates AS (
    SELECT
      fetched.*,
      ROW_NUMBER() OVER (
        PARTITION BY fetched.local_date
        ORDER BY (fetched.text_bytes > $8) ASC,
          fetched.expressed_at DESC,
          fetched.daily_session_id DESC,
          fetched.sequence_ord DESC
      ) AS day_rank,
      COUNT(*) OVER (PARTITION BY fetched.local_date) AS day_fetched
    FROM fetched
    WHERE fetched.revision_id IS NOT NULL
  ),
  ranked AS (
    SELECT
      candidates.*,
      ROW_NUMBER() OVER (
        ORDER BY candidates.day_rank ASC,
          (candidates.text_bytes > $8) ASC,
          candidates.expressed_at DESC,
          candidates.daily_session_id DESC,
          candidates.sequence_ord DESC
      ) AS overall_rank
    FROM candidates
  ),
  -- The cumulative fitting-byte budget is charged only over rows that survive
  -- the row/day caps, so a discarded probe row or over-cap row never evicts an
  -- older date's fitting representative. Order matches the final output order.
  bounded AS (
    SELECT
      ranked.*,
      SUM(ranked.text_bytes) FILTER (WHERE ranked.text_bytes <= $8) OVER (
        ORDER BY ranked.expressed_at DESC,
          ranked.daily_session_id DESC,
          ranked.sequence_ord DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS fitting_running_bytes
    FROM ranked
    WHERE ranked.day_rank <= (SELECT per_date_limit FROM params)
      AND ranked.overall_rank <= $7
  ),
  stats AS (
    SELECT
      (SELECT COUNT(*) FROM ranked) AS candidate_count,
      COALESCE(
        (
          SELECT BOOL_OR(day_fetched > (SELECT per_date_limit FROM params))
          FROM ranked
        ),
        FALSE
      ) AS row_bounded,
      COALESCE((SELECT BOOL_OR(text_bytes > $8) FROM ranked), FALSE)
        AS oversized_seen,
      COALESCE(
        (
          SELECT BOOL_OR(text_bytes <= $8 AND fitting_running_bytes > $8)
          FROM bounded
        ),
        FALSE
      ) AS fitting_cap_hit,
      COALESCE((SELECT BOOL_OR(overall_rank > $7) FROM ranked), FALSE)
        AS cap_bounded
  ),
  coverage AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'localDate', window_dates.local_date::text,
        'candidateRows', COALESCE(day.day_fetched, 0),
        'bounded',
          COALESCE(day.day_fetched, 0) >
            (SELECT per_date_limit FROM params),
        'empty', COALESCE(day.day_fetched, 0) = 0
      )
      ORDER BY window_dates.local_date
    ) AS per_date
    FROM window_dates
    LEFT JOIN (
      SELECT local_date, MAX(day_fetched) AS day_fetched
      FROM ranked
      GROUP BY local_date
    ) day ON day.local_date = window_dates.local_date
  )
  SELECT
    bounded.local_date,
    bounded.daily_session_id,
    bounded.interaction_turn_id,
    bounded.sequence_no,
    bounded.actor,
    bounded.generation_command_id,
    bounded.generating_user_revision_id,
    bounded.revision_id,
    bounded.text,
    bounded.text_bytes,
    bounded.expressed_at,
    bounded.exclusion,
    stats.candidate_count,
    stats.row_bounded,
    stats.oversized_seen,
    stats.fitting_cap_hit,
    stats.cap_bounded,
    coverage.per_date
  FROM stats
  CROSS JOIN coverage
  LEFT JOIN bounded
    ON (
      bounded.fitting_running_bytes <= $8 OR bounded.text_bytes > $8
    )
  ORDER BY bounded.expressed_at DESC,
    bounded.daily_session_id DESC,
    bounded.sequence_ord DESC
`;

function toControlReason(value: string): RecentContextControlReason | null {
  return SUPPORTED_CONTROL_REASONS.includes(value as RecentContextControlReason)
    ? (value as RecentContextControlReason)
    : null;
}

/**
 * Real PostgreSQL recent-source adapter (issues #293, #294).
 *
 * It reads only final / corrected, non-purged Conversation Event Revisions in
 * the frozen seven-local-day window up to the admitted-command cutoff, and
 * associates each row with the existing explicit Correction / Forget records
 * through `claim_evidence_links` / `evidence_items` (whole-Claim and
 * relationship-Qualifier scope). It performs no semantic matching and never
 * copies message bodies into any frozen manifest.
 *
 * The read is bounded in SQL before any body crosses the port: a sargable
 * per-local-date range with an inner row cap, a per-row byte guard and a
 * cumulative fitting-byte budget all run in one read-only transaction with a
 * local `statement_timeout`. Diagnostics (`candidate_count`, `row_bounded`,
 * `oversized_seen`, `fitting_cap_hit`, per-date coverage) stay independent of
 * the returned row set, so an empty or byte-starved result is still explained.
 */
export class PostgresRecentContextSource implements RecentContextSourcePort {
  public constructor(private readonly pool: Pool) {}

  public async loadRecentContextSource(
    request: RecentContextSourceRequest,
  ): Promise<RecentContextSourceSnapshot> {
    const base = {
      candidateBytes: 0,
      candidateRows: 0,
      failure: null,
      items: [] as readonly RecentContextSourceItem[],
      perDate: [] as readonly RecentContextPerDateCoverage[],
      policyVersion: request.policyVersion,
      selectorVersion: request.selectorVersion,
      timezone: request.timezone,
      truncated: false,
      windowEndLocalDate: request.windowEndLocalDate,
      windowStartLocalDate: request.windowStartLocalDate,
    };
    let client;
    // #295: measure the bounded read at the adapter boundary so the Inspector
    // can show the actual read duration the frozen selection was produced
    // under. Content-free; measured even when the read fails or times out.
    const startedAt = performance.now();
    const readLatencyMs = (): number =>
      Math.max(0, Math.round(performance.now() - startedAt));
    try {
      client = await this.pool.connect();
      const snapshot = await this.load(client, request, base);
      return { ...snapshot, readLatencyMs: readLatencyMs() };
    } catch (error) {
      return {
        ...base,
        // Content-free reason only: the SQL text and any parameter values never
        // reach the failure metadata or the user-visible path.
        failure: {
          code: isStatementTimeout(error)
            ? "source_read_timeout"
            : "source_read_failed",
          detail: null,
        },
        readLatencyMs: readLatencyMs(),
      };
    } finally {
      client?.release();
    }
  }

  private async load(
    client: PoolClient,
    request: RecentContextSourceRequest,
    base: Omit<RecentContextSourceSnapshot, "failure"> & {
      failure: RecentContextSourceSnapshot["failure"];
    },
  ): Promise<RecentContextSourceSnapshot> {
    let inTransaction = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      inTransaction = true;
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(request.budgets.readTimeoutMs),
      ]);
      const owner = await client.query<{
        data_epoch: string;
        status: string;
      }>(
        `SELECT data_epoch, status FROM app_users WHERE user_id = $1`,
        [request.userId],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow || ownerRow.status !== "active") {
        return { ...base, failure: { code: "owner_inactive", detail: null } };
      }
      if (Number(ownerRow.data_epoch) !== request.expectedDataEpoch) {
        return {
          ...base,
          failure: { code: "expected_data_epoch_mismatch", detail: null },
        };
      }

      const result = await client.query<CandidateRow>(
        RECENT_CONTEXT_CANDIDATE_SQL,
        [
          request.userId,
          request.timezone,
          request.windowStartLocalDate,
          request.windowEndLocalDate,
          request.cutoff.expressedAt,
          request.excludeRevisionIds,
          request.budgets.maxCandidateRows,
          request.budgets.maxCandidateBytes,
        ],
      );

      const diagnostics = result.rows[0];
      let candidateBytes = 0;
      const items: RecentContextSourceItem[] = [];
      for (const row of result.rows) {
        if (row.revision_id === null) continue;
        const text = row.text ?? "";
        candidateBytes += Number(row.text_bytes ?? 0);
        const controlReason =
          row.exclusion === null
            ? null
            : toControlReason(row.exclusion.reason);
        items.push({
          actor: row.actor === "assistant" ? "assistant" : "user",
          dailySessionId: asDailySessionId(row.daily_session_id!),
          exclusion:
            row.exclusion === null || controlReason === null
              ? null
              : { controlId: row.exclusion.controlId, reason: controlReason },
          expressedAt: row.expressed_at!.toISOString(),
          generationCommandId: row.generation_command_id,
          generatingUserRevisionId:
            row.generating_user_revision_id === null
              ? null
              : asConversationEventRevisionId(
                  row.generating_user_revision_id,
                ),
          interactionTurnId: asInteractionTurnId(row.interaction_turn_id!),
          occurredAt: null,
          revisionId: asConversationEventRevisionId(row.revision_id),
          sequence: Number(row.sequence_no),
          text,
        });
      }
      const perDate: RecentContextPerDateCoverage[] = (
        diagnostics?.per_date ?? []
      ).map((entry) => ({
        candidateRows: Number(entry.candidateRows),
        empty: entry.empty,
        localDate: entry.localDate,
        readBounded: entry.bounded,
      }));
      return {
        ...base,
        candidateBytes,
        // Independent of the returned body set: a byte- or row-starved read
        // still reports how many candidates were seen and whether bounds bit.
        candidateRows: Number(diagnostics?.candidate_count ?? items.length),
        items,
        perDate,
        truncated:
          Boolean(diagnostics?.row_bounded) ||
          Boolean(diagnostics?.oversized_seen) ||
          Boolean(diagnostics?.fitting_cap_hit) ||
          Boolean(diagnostics?.cap_bounded),
      };
    } finally {
      if (inTransaction) {
        await client.query("ROLLBACK").catch(() => undefined);
      }
    }
  }
}

function isStatementTimeout(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "57014";
}
