import type { Pool, PoolClient } from "pg";

import {
  HISTORY_ANSWER_TASK_INSTRUCTION_VERSION,
  HISTORY_CONTINUATION_ANSWER_TASK_INSTRUCTION_VERSION,
  type HistoryAnswerCommandRef,
  type HistoryRecallDecisionFacts,
  type HistoryRecallFailureCode,
  type HistoryRecallItemRef,
  type HistoryRecallRepository,
  type HistoryRecallResult,
  type HistoryRecallSourceItem,
  type HistoryRecallSourcePort,
  type HistoryRecallSourceRequest,
  type HistoryRecallSourceSnapshot,
  type ContextSourceHistoryRecall,
  type ExperienceContextWindow,
  type ExperienceHit,
  type ExperienceHitsSnapshot,
  type ExperienceSearchSourcePort,
  type HistoryExperienceSearchPlan,
  type HistoryContinuationSignals,
  type VerifiedLabel,
  searchPatternsOf,
} from "@sayhear/application";
import {
  asConversationEventRevisionId,
  asDailySessionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asUserId,
  type ConversationEventRevisionId,
  type GenerationCommandId,
  type ModelRunAttemptId,
  type UserId,
} from "@sayhear/domain";

import {
  controlExclusionSql,
  ELIGIBLE_TRANSCRIPT_STATUSES_SQL,
  generatingUserRevisionIsCurrentSql,
} from "./postgres-source-eligibility";
import { createUuidV7 } from "./uuid-v7";

type SourceRow = Readonly<{
  actor: "user" | "assistant";
  cursor_at: string;
  daily_session_id: string;
  exclusion: { controlId: string; reason: string } | null;
  expressed_at: Date;
  expression_timezone: string | null;
  expression_timezone_source: "request" | "session_start_fallback" | null;
  generating_user_revision_id: string | null;
  local_date: string;
  revision_id: string;
  sequence_no: string;
  text: string;
}>;

/**
 * Columns and joins shared by every read that may hand retained original text
 * to a model (date review pages, experience search hits and context). They
 * expect `event` and `revision` aliases, the owner as $1 and the plan timezone
 * as $2, and blank the text of any row with an explicit Correction / Forget
 * association so that text never crosses the port.
 */
const EVENT_ROW_COLUMNS_SQL = `
    event.daily_session_id::text AS daily_session_id,
    event.sequence_no::text AS sequence_no,
    event.actor,
    event.created_at AS expressed_at,
    to_char(event.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
    (event.created_at AT TIME ZONE $2)::date::text AS local_date,
    revision.conversation_event_revision_id::text AS revision_id,
    CASE WHEN control.exclusion IS NULL THEN revision.canonical_text ELSE '' END AS text,
    CASE
      WHEN event.actor = 'assistant'
        AND generating_command.subject_type = 'conversation_event'
        AND generating_command.input_revision_kind = 'conversation_event_revision'
      THEN generating_command.input_revision_id::text
    END AS generating_user_revision_id,
    COALESCE(
      generating_command.request_timezone,
      expression_command.request_timezone,
      session.timezone_at_start
    ) AS expression_timezone,
    CASE
      WHEN generating_command.request_timezone IS NOT NULL THEN 'request'
      WHEN expression_command.request_timezone IS NOT NULL THEN 'request'
      WHEN session.timezone_at_start IS NOT NULL THEN 'session_start_fallback'
    END AS expression_timezone_source,
    control.exclusion AS exclusion`;

const EVENT_ROW_JOINS_SQL = `
  LEFT JOIN generation_commands generating_command
    ON generating_command.generation_command_id = event.generation_command_id
   AND generating_command.user_id = event.user_id
  LEFT JOIN LATERAL (
    SELECT request_command.request_timezone
    FROM generation_commands request_command
    WHERE event.actor = 'user'
      AND request_command.subject_type = 'conversation_event'
      AND request_command.subject_id = event.conversation_event_id
      AND request_command.interaction_turn_id = event.interaction_turn_id
      AND request_command.user_id = event.user_id
    ORDER BY request_command.created_at
    LIMIT 1
  ) expression_command ON TRUE
  LEFT JOIN daily_sessions session
    ON session.daily_session_id = event.daily_session_id
   AND session.user_id = event.user_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      ${controlExclusionSql({
        revisionId: "revision.conversation_event_revision_id",
        userId: "event.user_id",
      })},
      CASE
        WHEN event.actor = 'assistant'
          AND generating_command.input_revision_id IS NOT NULL
        THEN COALESCE(
          ${controlExclusionSql({
            revisionId: "generating_command.input_revision_id",
            userId: "event.user_id",
          })},
          CASE
            WHEN NOT ${generatingUserRevisionIsCurrentSql({
              generatingRevisionId: "generating_command.input_revision_id",
              userId: "event.user_id",
            })}
            THEN jsonb_build_object(
              'controlId', generating_command.input_revision_id::text,
              'reason', 'correction_association'
            )
          END
        )
      END
    ) AS exclusion
  ) control ON TRUE`;

/**
 * One keyset page of retained original messages whose expression instant falls
 * inside the plan local-date range (half-open UTC bounds computed in SQL from
 * the IANA zone, so DST days are 23/25 hours long and correct), up to the
 * frozen cutoff, including the current Daily Session (a conversation that
 * crosses midnight still holds yesterday's messages) but never the request
 * itself. Rows with an explicit
 * control association come back with their text blanked: the text never
 * crosses the port. The Assistant is bound to the user revision that
 * generated it; a superseded or controlled request makes the reply ineligible.
 *
 * Parameters: $1 user, $2 timezone, $3 start local date, $4 end local date,
 * $5 cutoff, $6 request revision, $7 page size + 1, $8 cursor instant (text or
 * NULL), $9 cursor session, $10 cursor sequence.
 */
export const HISTORY_RECALL_PAGE_SQL = `
  WITH bounds AS (
    SELECT ($3::date)::timestamp AT TIME ZONE $2 AS start_utc,
           (($4::date) + 1)::timestamp AT TIME ZONE $2 AS end_utc
  )
  SELECT ${EVENT_ROW_COLUMNS_SQL}
  FROM bounds, conversation_events event
  INNER JOIN conversation_event_revisions revision
    ON revision.conversation_event_revision_id = event.current_revision_id
   AND revision.user_id = event.user_id
  ${EVENT_ROW_JOINS_SQL}
  WHERE event.user_id = $1
    AND event.actor IN ('user', 'assistant')
    AND event.lifecycle_status = 'active'
    AND revision.content_purged_at IS NULL
    AND revision.transcript_status IN ${ELIGIBLE_TRANSCRIPT_STATUSES_SQL}
    AND event.created_at >= bounds.start_utc
    AND event.created_at < bounds.end_utc
    AND event.created_at <= $5::timestamptz
    AND revision.conversation_event_revision_id <> $6::uuid
    AND (
      $8::timestamptz IS NULL
      OR (event.created_at, event.daily_session_id::text, event.sequence_no) >
         ($8::timestamptz, $9::text, $10::bigint)
    )
  ORDER BY event.created_at, event.daily_session_id::text, event.sequence_no
  LIMIT $7
`;

/**
 * Experience search, step one: scan the owner's newest retained User messages
 * (bounded by the policy scan limit, optionally by a local-date range and the
 * frozen cutoff, never the request itself) and return the ones that
 * match any clue pattern, with the number of rows really scanned. Matching is
 * on NFKC-folded, lower-cased, whitespace-collapsed text: CJK clues by
 * substring, ASCII clues on word boundaries. Only User text is searched.
 *
 * Parameters: $1 user, $2 timezone, $3 start date|NULL, $4 end date|NULL,
 * $5 cutoff, $6 request revision, $7 scan limit + 1, $8 scan limit,
 * $9 pattern groups, $10 pattern kinds, $11 pattern values, $12 hit rows.
 */
export const EXPERIENCE_SEARCH_HITS_SQL = `
  WITH bounds AS (
    SELECT CASE WHEN $3::text IS NULL THEN NULL
                ELSE (($3::text)::date)::timestamp AT TIME ZONE $2 END AS start_utc,
           CASE WHEN $4::text IS NULL THEN NULL
                ELSE ((($4::text)::date) + 1)::timestamp AT TIME ZONE $2 END AS end_utc
  ),
  scan AS (
    SELECT event.conversation_event_id, event.created_at, event.sequence_no,
           regexp_replace(
             lower(normalize(revision.canonical_text, NFKC)),
             '[[:space:]\u3000]+', ' ', 'g'
           ) AS norm
    FROM bounds, conversation_events event
    INNER JOIN conversation_event_revisions revision
      ON revision.conversation_event_revision_id = event.current_revision_id
     AND revision.user_id = event.user_id
    WHERE event.user_id = $1
      AND event.actor = 'user'
      AND event.lifecycle_status = 'active'
      AND revision.content_purged_at IS NULL
      AND revision.transcript_status IN ${ELIGIBLE_TRANSCRIPT_STATUSES_SQL}
      AND event.created_at <= $5::timestamptz
      AND revision.conversation_event_revision_id <> $6::uuid
      AND (bounds.start_utc IS NULL OR event.created_at >= bounds.start_utc)
      AND (bounds.end_utc IS NULL OR event.created_at < bounds.end_utc)
    ORDER BY event.created_at DESC, event.sequence_no DESC
    LIMIT $7
  ),
  numbered AS (
    SELECT scan.*, row_number() OVER (
      ORDER BY created_at DESC, sequence_no DESC
    ) AS rn
    FROM scan
  ),
  meta AS (
    SELECT COUNT(*) FILTER (WHERE rn <= $8)::int AS scanned,
           (COUNT(*) > $8) AS truncated,
           to_char(MIN(created_at) FILTER (WHERE rn <= $8) AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS oldest
    FROM numbered
  ),
  hits AS (
    SELECT numbered.conversation_event_id,
           ARRAY(
             SELECT DISTINCT pattern.grp
             FROM unnest($9::int[], $10::text[], $11::text[])
               AS pattern(grp, kind, val)
             WHERE (pattern.kind = 'substring' AND strpos(numbered.norm, pattern.val) > 0)
                OR (pattern.kind = 'word' AND numbered.norm ~ pattern.val)
             ORDER BY pattern.grp
           ) AS groups,
           numbered.created_at
    FROM numbered
    WHERE numbered.rn <= $8
  ),
  best AS (
    SELECT * FROM hits
    WHERE cardinality(groups) > 0
    ORDER BY cardinality(groups) DESC, created_at DESC
    LIMIT $12
  )
  SELECT meta.scanned, meta.truncated, meta.oldest,
         best.groups AS matched_groups,
         ${EVENT_ROW_COLUMNS_SQL}
  FROM meta
  LEFT JOIN best ON TRUE
  LEFT JOIN conversation_events event
    ON event.conversation_event_id = best.conversation_event_id
   AND event.user_id = $1
  LEFT JOIN conversation_event_revisions revision
    ON revision.conversation_event_revision_id = event.current_revision_id
   AND revision.user_id = event.user_id
  ${EVENT_ROW_JOINS_SQL}
  ORDER BY best.created_at DESC NULLS LAST
`;

/**
 * Experience search, step two: the eligible messages of the chosen occasions,
 * limited to the occasion's session and time window. $3 sessions, $4 window
 * starts, $5 window ends, $6 cutoff, $7 row limit, $8 request revision (the
 * request itself is never context).
 */
export const EXPERIENCE_SEARCH_CONTEXT_SQL = `
  SELECT ${EVENT_ROW_COLUMNS_SQL}
  FROM conversation_events event
  INNER JOIN conversation_event_revisions revision
    ON revision.conversation_event_revision_id = event.current_revision_id
   AND revision.user_id = event.user_id
  ${EVENT_ROW_JOINS_SQL}
  WHERE event.user_id = $1
    AND event.actor IN ('user', 'assistant')
    AND event.lifecycle_status = 'active'
    AND revision.content_purged_at IS NULL
    AND revision.transcript_status IN ${ELIGIBLE_TRANSCRIPT_STATUSES_SQL}
    AND event.created_at <= $6::timestamptz
    AND revision.conversation_event_revision_id <> $8::uuid
    AND EXISTS (
      SELECT 1
      FROM unnest($3::uuid[], $4::timestamptz[], $5::timestamptz[])
        AS occasion(session_id, from_at, to_at)
      WHERE occasion.session_id = event.daily_session_id
        AND event.created_at BETWEEN occasion.from_at AND occasion.to_at
    )
  ORDER BY event.created_at, event.daily_session_id::text, event.sequence_no
  LIMIT $7
`;

const REASONS = ["correction_association", "forget_association"] as const;

function isStatementTimeout(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "57014";
}

/**
 * Real PostgreSQL source of the controlled history review (issue #314). It
 * reads inside one read-only REPEATABLE READ transaction with a local
 * statement timeout, checks the owner and the frozen data epoch first, pages
 * with a stable keyset cursor under a deterministic row/page budget and reports
 * whether enumeration finished.
 */
export class PostgresHistoryRecallSource implements HistoryRecallSourcePort {
  public constructor(private readonly pool: Pool) {}

  public async readHistoryRange(
    request: HistoryRecallSourceRequest,
  ): Promise<HistoryRecallSourceSnapshot> {
    const startedAt = performance.now();
    const latency = () => Math.max(0, Math.round(performance.now() - startedAt));
    const fail = (
      code: HistoryRecallFailureCode,
    ): HistoryRecallSourceSnapshot => ({
      currentConversationRows: 0,
      enumerationComplete: false,
      failure: { code },
      items: [],
      pages: 0,
      readLatencyMs: latency(),
    });
    let client: PoolClient | undefined;
    let inTransaction = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      inTransaction = true;
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(request.budgets.readTimeoutMs),
      ]);
      const owner = await client.query<{ data_epoch: string; status: string }>(
        "SELECT data_epoch, status FROM app_users WHERE user_id = $1",
        [request.userId],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow || ownerRow.status !== "active") return fail("owner_inactive");
      if (Number(ownerRow.data_epoch) !== request.expectedDataEpoch) {
        return fail("expected_data_epoch_mismatch");
      }
      const { plan } = request;
      const items: HistoryRecallSourceItem[] = [];
      let cursor: { at: string; session: string; sequence: string } | null = null;
      let pages = 0;
      let more = false;
      while (pages < request.budgets.maxPages) {
        const remaining = request.budgets.maxSourceRows - items.length;
        if (remaining <= 0) {
          more = true;
          break;
        }
        const limit = Math.min(request.budgets.pageSize, remaining);
        const page: { rows: SourceRow[] } = await client.query<SourceRow>(
          HISTORY_RECALL_PAGE_SQL,
          [
            request.userId,
            plan.timezone,
            plan.readStartDate,
            plan.readEndDate,
            plan.cutoff,
            request.requestRevisionId,
            limit + 1,
            cursor?.at ?? null,
            cursor?.session ?? "",
            cursor?.sequence ?? "0",
          ],
        );
        pages += 1;
        const rows = page.rows.slice(0, limit);
        for (const row of rows) {
          const reason = REASONS.find((value) => value === row.exclusion?.reason);
          items.push({
            actor: row.actor,
            dailySessionId: asDailySessionId(row.daily_session_id),
            exclusion:
              row.exclusion === null || reason === undefined
                ? null
                : { controlId: row.exclusion.controlId, reason },
            expressedAt: row.expressed_at.toISOString(),
            expressionTimezone: row.expression_timezone,
            expressionTimezoneSource: row.expression_timezone_source ?? "unknown",
            generatingUserRevisionId:
              row.generating_user_revision_id === null
                ? null
                : asConversationEventRevisionId(row.generating_user_revision_id),
            localDate: row.local_date,
            revisionId: asConversationEventRevisionId(row.revision_id),
            sequence: Number(row.sequence_no),
            text: row.text,
          });
        }
        more = page.rows.length > limit;
        if (!more) break;
        const last = rows.at(-1)!;
        cursor = { at: last.cursor_at, sequence: last.sequence_no, session: last.daily_session_id };
      }
      return {
        currentConversationRows: 0,
        enumerationComplete: !more,
        failure: null,
        items,
        pages,
        readLatencyMs: latency(),
      };
    } catch (error) {
      return fail(isStatementTimeout(error) ? "source_read_timeout" : "source_read_failed");
    } finally {
      if (client) {
        if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }
  }
}

type EventRow = Readonly<{
  actor: "user" | "assistant";
  daily_session_id: string;
  exclusion: { controlId: string; reason: string } | null;
  expressed_at: Date;
  expression_timezone: string | null;
  expression_timezone_source: "request" | "session_start_fallback" | null;
  generating_user_revision_id: string | null;
  local_date: string;
  revision_id: string;
  sequence_no: string;
  text: string;
}>;

function mapEventRow(row: EventRow): HistoryRecallSourceItem {
  const reason = REASONS.find((value) => value === row.exclusion?.reason);
  return {
    actor: row.actor,
    dailySessionId: asDailySessionId(row.daily_session_id),
    exclusion:
      row.exclusion === null || reason === undefined
        ? null
        : { controlId: row.exclusion.controlId, reason },
    expressedAt: row.expressed_at.toISOString(),
    expressionTimezone: row.expression_timezone,
    expressionTimezoneSource: row.expression_timezone_source ?? "unknown",
    generatingUserRevisionId:
      row.generating_user_revision_id === null
        ? null
        : asConversationEventRevisionId(row.generating_user_revision_id),
    localDate: row.local_date,
    revisionId: asConversationEventRevisionId(row.revision_id),
    sequence: Number(row.sequence_no),
    text: row.text,
  };
}

/**
 * Real PostgreSQL source of the original-text experience search (issue #316).
 * No projection, index or copy of private text is kept: every call reads the
 * owner's retained conversation text in place, inside a read-only REPEATABLE
 * READ transaction with a local statement timeout equal to what remains of the
 * shared deadline, after checking the owner and the frozen data epoch.
 */
export class PostgresExperienceSearchSource implements ExperienceSearchSourcePort {
  public constructor(private readonly pool: Pool) {}

  private async inSnapshot<T>(
    input: { deadlineMs: number; expectedDataEpoch: number | null; userId: UserId },
    work: (client: PoolClient) => Promise<T>,
  ): Promise<
    | { failure: HistoryRecallFailureCode; ok: false }
    | { ok: true; value: T }
  > {
    let client: PoolClient | undefined;
    let inTransaction = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      inTransaction = true;
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(Math.max(1, Math.trunc(input.deadlineMs))),
      ]);
      if (input.expectedDataEpoch !== null) {
        const owner = await client.query<{ data_epoch: string; status: string }>(
          "SELECT data_epoch, status FROM app_users WHERE user_id = $1",
          [input.userId],
        );
        const ownerRow = owner.rows[0];
        if (!ownerRow || ownerRow.status !== "active") {
          return { failure: "owner_inactive", ok: false };
        }
        if (Number(ownerRow.data_epoch) !== input.expectedDataEpoch) {
          return { failure: "expected_data_epoch_mismatch", ok: false };
        }
      }
      return { ok: true, value: await work(client) };
    } catch (error) {
      return {
        failure: isStatementTimeout(error) ? "source_read_timeout" : "source_read_failed",
        ok: false,
      };
    } finally {
      if (client) {
        if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }
  }

  public async lookupVerifiedAliases(input: {
    deadlineMs: number;
    userId: UserId;
  }): Promise<readonly VerifiedLabel[]> {
    const read = await this.inSnapshot(
      { ...input, expectedDataEpoch: null },
      (client) =>
        client.query<{
          entity_id: string;
          label: string;
          label_kind: "primary" | "alias";
        }>(
          `SELECT label.entity_id::text, label.label, label.label_kind
           FROM entity_labels label
           INNER JOIN entities entity
             ON entity.entity_id = label.entity_id AND entity.user_id = label.user_id
           INNER JOIN entity_versions version
             ON version.entity_version_id = entity.current_version_id
            AND version.entity_id = entity.entity_id
            AND version.user_id = entity.user_id
           WHERE label.user_id = $1
             AND label.is_current
             AND label.content_purged_at IS NULL
             AND entity.deleted_at IS NULL
             AND version.status IN ('active', 'unresolved')
             AND (label.label_kind = 'primary' OR label.source_evidence_id IS NOT NULL)`,
          [input.userId],
        ),
    );
    if (!read.ok) throw new Error(read.failure);
    return read.value.rows.map((row) => ({
      entityId: row.entity_id,
      label: row.label,
      labelKind: row.label_kind,
    }));
  }

  public async searchHits(input: {
    deadlineMs: number;
    expectedDataEpoch: number;
    maxHitRows: number;
    requestRevisionId: ConversationEventRevisionId;
    plan: HistoryExperienceSearchPlan;
    scanLimit: number;
    userId: UserId;
  }): Promise<ExperienceHitsSnapshot> {
    const startedAt = performance.now();
    const latency = () => Math.max(0, Math.round(performance.now() - startedAt));
    const patterns = searchPatternsOf(input.plan);
    const read = await this.inSnapshot(input, (client) =>
      client.query<
        EventRow & {
          matched_groups: number[] | null;
          oldest: string | null;
          scanned: number;
          truncated: boolean;
        }
      >(EXPERIENCE_SEARCH_HITS_SQL, [
        input.userId,
        input.plan.timezone,
        input.plan.startDate,
        input.plan.endDate,
        input.plan.cutoff,
        input.requestRevisionId,
        input.scanLimit + 1,
        input.scanLimit,
        patterns.map((pattern) => pattern.group),
        patterns.map((pattern) => pattern.kind),
        patterns.map((pattern) => pattern.value),
        input.maxHitRows,
      ]),
    );
    if (!read.ok) {
      return {
        failure: { code: read.failure },
        hits: [],
        oldestScannedAt: null,
        readLatencyMs: latency(),
        scanComplete: false,
        scannedRows: 0,
      };
    }
    const first = read.value.rows[0];
    const hits: ExperienceHit[] = read.value.rows.flatMap((row) =>
      row.revision_id === null || row.matched_groups === null
        ? []
        : [{ ...mapEventRow(row), matchedGroups: row.matched_groups }],
    );
    return {
      failure: null,
      hits,
      oldestScannedAt: first?.oldest ?? null,
      readLatencyMs: latency(),
      scanComplete: first ? !first.truncated : true,
      scannedRows: Number(first?.scanned ?? 0),
    };
  }

  public async readContext(input: {
    cutoff: string;
    deadlineMs: number;
    expectedDataEpoch: number;
    maxRowsPerWindow: number;
    requestRevisionId: ConversationEventRevisionId;
    timezone: string;
    userId: UserId;
    windows: readonly ExperienceContextWindow[];
  }): Promise<{
    failure: { code: HistoryRecallFailureCode } | null;
    items: readonly HistoryRecallSourceItem[];
  }> {
    const read = await this.inSnapshot(input, (client) =>
      client.query<EventRow>(EXPERIENCE_SEARCH_CONTEXT_SQL, [
        input.userId,
        input.timezone,
        input.windows.map((window) => window.dailySessionId),
        input.windows.map((window) => window.fromAt),
        input.windows.map((window) => window.toAt),
        input.cutoff,
        input.maxRowsPerWindow * Math.max(1, input.windows.length),
        input.requestRevisionId,
      ]),
    );
    if (!read.ok) return { failure: { code: read.failure }, items: [] };
    return { failure: null, items: read.value.rows.map(mapEventRow) };
  }
}

const SETTLE_TERMINAL_STATUSES = ["prepared", "compiling", "running", "retry_pending"];

export class PostgresHistoryRecallRepository implements HistoryRecallRepository {
  public constructor(private readonly pool: Pool) {}

  public async loadDecisionFacts(input: {
    decisionCommandId: GenerationCommandId;
    userId: UserId;
  }): Promise<HistoryRecallDecisionFacts | null> {
    const result = await this.pool.query<{
      cutoff: Date;
      daily_session_id: string;
      expected_data_epoch: string;
      input_revision_id: string;
      interaction_turn_id: string;
      request_timezone: string | null;
      timezone_at_start: string | null;
    }>(
      `SELECT COALESCE(input_event.created_at, command.created_at) AS cutoff,
              session.daily_session_id::text AS daily_session_id,
              command.expected_data_epoch::text AS expected_data_epoch,
              command.input_revision_id::text AS input_revision_id,
              command.interaction_turn_id::text AS interaction_turn_id,
              command.request_timezone,
              session.timezone_at_start
       FROM generation_commands command
       INNER JOIN interaction_turns turn
         ON turn.interaction_turn_id = command.interaction_turn_id
        AND turn.user_id = command.user_id
       INNER JOIN daily_sessions session
         ON session.daily_session_id = turn.daily_session_id
        AND session.user_id = turn.user_id
       LEFT JOIN conversation_events input_event
         ON input_event.conversation_event_id = command.subject_id
        AND input_event.user_id = command.user_id
       WHERE command.generation_command_id = $1
         AND command.user_id = $2
         AND command.generation_stage = 'decision'
         AND command.status = 'running'`,
      [input.decisionCommandId, input.userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      cutoff: row.cutoff,
      dailySessionId: asDailySessionId(row.daily_session_id),
      expectedDataEpoch: Number(row.expected_data_epoch),
      inputRevisionId: asConversationEventRevisionId(row.input_revision_id),
      interactionTurnId: asInteractionTurnId(row.interaction_turn_id),
      requestTimezone: row.request_timezone,
      sessionTimezone: row.timezone_at_start,
      signals: await this.loadContinuationSignals({
        decisionCommandId: input.decisionCommandId,
        inputRevisionId: row.input_revision_id,
        userId: input.userId,
      }),
    };
  }

  /**
   * What the Decision itself was shown (issue #317): the current input, the
   * user's other messages in its frozen context that are still the current,
   * un-purged revision of an active event, and a DialogueState section only
   * if the compiler judged it source-valid. Text stays in memory.
   */
  private async loadContinuationSignals(input: {
    decisionCommandId: GenerationCommandId;
    inputRevisionId: string;
    userId: UserId;
  }): Promise<HistoryContinuationSignals> {
    const current = await this.pool.query<{ canonical_text: string }>(
      `SELECT canonical_text
       FROM conversation_event_revisions
       WHERE conversation_event_revision_id = $1
         AND user_id = $2
         AND content_purged_at IS NULL`,
      [input.inputRevisionId, input.userId],
    );
    const adjacent = await this.pool.query<{ canonical_text: string }>(
      `SELECT revision.canonical_text
       FROM compiled_contexts context
       INNER JOIN compiled_context_revision_refs ref
         ON ref.compiled_context_id = context.compiled_context_id
        AND ref.user_id = context.user_id
       INNER JOIN conversation_events event
         ON event.current_revision_id = ref.conversation_event_revision_id
        AND event.user_id = ref.user_id
       INNER JOIN conversation_event_revisions revision
         ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
        AND revision.user_id = ref.user_id
       WHERE context.generation_command_id = $1
         AND context.user_id = $2
         AND ref.actor = 'user'
         AND event.actor = 'user'
         AND event.lifecycle_status = 'active'
         AND revision.content_purged_at IS NULL
         AND ref.conversation_event_revision_id <> $3
       ORDER BY event.created_at DESC, event.sequence_no DESC
       LIMIT 5`,
      [input.decisionCommandId, input.userId, input.inputRevisionId],
    );
    const sections = await this.pool.query<{ reference: string | null }>(
      `SELECT section.value ->> 'reference' AS reference
       FROM compiled_contexts context
       CROSS JOIN LATERAL jsonb_array_elements(context.sections) AS section(value)
       WHERE context.generation_command_id = $1
         AND context.user_id = $2
         AND section.value ->> 'key' = 'dialogue_state'`,
      [input.decisionCommandId, input.userId],
    );
    const reference = sections.rows[0]?.reference ?? null;
    let dialogueState: HistoryContinuationSignals["dialogueState"] = null;
    if (reference !== null) {
      const status = /status=(current|lagging)/.exec(reference)?.[1];
      const topic = /^Current topic: (.*) \(confidence=/m.exec(reference)?.[1];
      if (status === "current" || status === "lagging") {
        dialogueState = {
          status,
          topic: topic === undefined || topic === "none" ? null : topic,
        };
      }
    }
    return {
      adjacentUserTexts: adjacent.rows.map((row) => row.canonical_text),
      currentInputText: current.rows[0]?.canonical_text ?? "",
      dialogueState,
    };
  }

  public async commitHistoryRecall(input: {
    decisionAttemptId: ModelRunAttemptId;
    decisionCommandId: GenerationCommandId;
    governancePolicyVersion?: string | null;
    now: Date;
    policyVersion: string;
    result: HistoryRecallResult;
    userId: UserId;
  }): ReturnType<HistoryRecallRepository["commitHistoryRecall"]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const command = await client.query<{
        expected_data_epoch: string;
        interaction_turn_id: string;
        status: string;
      }>(
        `SELECT status, expected_data_epoch::text, interaction_turn_id::text
         FROM generation_commands
         WHERE generation_command_id = $1 AND user_id = $2
           AND generation_stage = 'decision'
         FOR UPDATE`,
        [input.decisionCommandId, input.userId],
      );
      const commandRow = command.rows[0];
      if (!commandRow) {
        await client.query("ROLLBACK");
        return { outcome: "fence_rejected" };
      }
      const existing = await client.query<{
        answer_command_id: string;
        answer_attempt_id: string;
      }>(
        `SELECT result.answer_command_id::text AS answer_command_id,
                attempt.model_run_attempt_id::text AS answer_attempt_id
         FROM history_recall_results result
         INNER JOIN model_run_attempts attempt
           ON attempt.generation_command_id = result.answer_command_id
          AND attempt.attempt_no = 1
         WHERE result.decision_command_id = $1 AND result.user_id = $2`,
        [input.decisionCommandId, input.userId],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return {
          answer: {
            generationCommandId: asGenerationCommandId(existing.rows[0].answer_command_id),
            modelRunAttemptId: asModelRunAttemptId(existing.rows[0].answer_attempt_id),
          },
          outcome: "committed",
        };
      }
      const fence = await client.query<{ ok: boolean }>(
        `SELECT (
           owner.status = 'active'
           AND owner.data_epoch = command.expected_data_epoch
           AND command.status = 'running'
           AND command.authoritative_result_id IS NULL
           AND input_event.lifecycle_status = 'active'
           AND input_event.current_revision_id = command.input_revision_id
           AND input_revision.content_purged_at IS NULL
         ) AS ok
         FROM generation_commands command
         INNER JOIN app_users owner ON owner.user_id = command.user_id
         INNER JOIN conversation_events input_event
           ON input_event.conversation_event_id = command.subject_id
          AND input_event.user_id = command.user_id
         INNER JOIN conversation_event_revisions input_revision
           ON input_revision.conversation_event_revision_id =
             input_event.current_revision_id
         WHERE command.generation_command_id = $1 AND command.user_id = $2`,
        [input.decisionCommandId, input.userId],
      );
      if (fence.rows[0]?.ok !== true) {
        await client.query("ROLLBACK");
        return { outcome: "fence_rejected" };
      }
      // #320: the governance identity must still be active at the moment the
      // result is frozen (shared lock; the operator revocation takes the same
      // row FOR UPDATE, so the two orderings serialize).
      if (
        input.governancePolicyVersion !== undefined &&
        input.governancePolicyVersion !== null
      ) {
        const active = await client.query(
          `SELECT 1 FROM history_recall_policies
           WHERE policy_version = $1 AND status = 'active'
           FOR SHARE`,
          [input.governancePolicyVersion],
        );
        if ((active.rowCount ?? 0) !== 1) {
          await client.query("ROLLBACK");
          return { outcome: "fence_rejected" };
        }
      }
      // Settle the Decision: a history query is a legitimate terminal outcome of
      // the Decision stage, so neither the command nor its attempt may stay
      // running (the non-accepted Action leak is not repeated here).
      await client.query(
        `UPDATE generation_commands
         SET status = 'succeeded', settled_at = $3,
             recovery_status = 'not_needed', next_recovery_at = NULL
         WHERE generation_command_id = $1 AND user_id = $2
           AND status = 'running' AND authoritative_result_id IS NULL
           AND generation_stage = 'decision'`,
        [input.decisionCommandId, input.userId, input.now],
      );
      await client.query(
        `UPDATE model_run_attempts
         SET status = 'succeeded', completed_at = COALESCE(completed_at, $3),
             recovery_status = 'not_needed', recovery_claimed_at = NULL
         WHERE model_run_attempt_id = $1 AND generation_command_id = $2
           AND user_id = $4 AND status = 'running'`,
        [input.decisionAttemptId, input.decisionCommandId, input.now, input.userId],
      );
      await client.query(
        `UPDATE provider_egress_dispositions
         SET status = 'completed', completed_at = COALESCE(completed_at, $3)
         WHERE model_run_attempt_id = $1 AND user_id = $2
           AND status IN ('dispatched', 'completed')`,
        [input.decisionAttemptId, input.userId, input.now],
      );
      const answerCommandId = createUuidV7(input.now);
      const answerAttemptId = createUuidV7(input.now);
      await client.query(
        `INSERT INTO generation_commands (
           generation_command_id, user_id, interaction_turn_id, operation_type,
           intent_key, subject_type, subject_id, input_revision_kind,
           input_revision_id, prompt_version, output_format_version,
           persona_contract_invariant_version, canonical_persona_version,
           persona_behavior_anchors_version,
           product_policy_version, safety_policy_version, relationship_policy_version,
           locale_policy_version, locale, provider, model, model_snapshot,
           model_config_version, provider_policy_version, consent_policy_version,
           freshness_policy, harness_policy_version, conversation_action_catalog_version,
           expected_data_epoch, generation_stage, status, created_at,
           request_timezone, request_deadline_at, latest_input_fence_version
         )
         SELECT $1, command.user_id, command.interaction_turn_id, command.operation_type,
           $2, command.subject_type, command.subject_id, command.input_revision_kind,
           command.input_revision_id, $4, command.output_format_version,
           command.persona_contract_invariant_version, command.canonical_persona_version,
           command.persona_behavior_anchors_version,
           command.product_policy_version, command.safety_policy_version,
           command.relationship_policy_version, command.locale_policy_version, command.locale,
           command.provider, command.model, command.model_snapshot, command.model_config_version,
           command.provider_policy_version, command.consent_policy_version, command.freshness_policy,
           command.harness_policy_version, command.conversation_action_catalog_version,
           command.expected_data_epoch, 'history_answer', 'prepared', $5,
           command.request_timezone, command.request_deadline_at,
           command.latest_input_fence_version
         FROM generation_commands command
         WHERE command.generation_command_id = $3 AND command.user_id = $6`,
        [
          answerCommandId,
          `history-answer/${input.decisionCommandId}`,
          input.decisionCommandId,
          input.result.proposal.kind === "search_experience" &&
            input.result.proposal.continuation
            ? HISTORY_CONTINUATION_ANSWER_TASK_INSTRUCTION_VERSION
            : HISTORY_ANSWER_TASK_INSTRUCTION_VERSION,
          input.now,
          input.userId,
        ],
      );
      await client.query(
        `INSERT INTO model_run_attempts (
           model_run_attempt_id, user_id, generation_command_id, attempt_no,
           operation_type, provider, model, model_snapshot, prompt_version,
           status, created_at
         )
         SELECT $1, command.user_id, command.generation_command_id, 1,
           command.operation_type, command.provider, command.model,
           command.model_snapshot, command.prompt_version, 'prepared', $2
         FROM generation_commands command
         WHERE command.generation_command_id = $3 AND command.user_id = $4`,
        [answerAttemptId, input.now, answerCommandId, input.userId],
      );
      await client.query(
        `INSERT INTO history_recall_results (
           history_recall_result_id, user_id, interaction_turn_id,
           decision_command_id, answer_command_id, policy_version, status,
           failure_code, plan, coverage, item_refs, expected_data_epoch, created_at,
           governance_policy_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14)`,
        [
          createUuidV7(input.now),
          input.userId,
          commandRow.interaction_turn_id,
          input.decisionCommandId,
          answerCommandId,
          input.policyVersion,
          input.result.status,
          input.result.failureCode,
          JSON.stringify({ plan: input.result.plan, proposal: input.result.proposal }),
          JSON.stringify(input.result.coverage),
          JSON.stringify(input.result.itemRefs),
          commandRow.expected_data_epoch,
          input.now,
          input.governancePolicyVersion ?? null,
        ],
      );
      await client.query("COMMIT");
      return {
        answer: {
          generationCommandId: asGenerationCommandId(answerCommandId),
          modelRunAttemptId: asModelRunAttemptId(answerAttemptId),
        },
        outcome: "committed",
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async listPendingHistoryAnswers(input: {
    limit: number;
  }): Promise<readonly HistoryAnswerCommandRef[]> {
    const result = await this.pool.query<{
      generation_command_id: string;
      interaction_turn_id: string;
      model_run_attempt_id: string;
      request_event_revision_id: string;
      user_id: string;
    }>(
      `SELECT command.generation_command_id, command.interaction_turn_id,
              attempt.model_run_attempt_id,
              command.input_revision_id AS request_event_revision_id,
              command.user_id
       FROM generation_commands command
       INNER JOIN history_recall_results result
         ON result.answer_command_id = command.generation_command_id
        AND result.user_id = command.user_id
       INNER JOIN interaction_turns turn
         ON turn.interaction_turn_id = command.interaction_turn_id
        AND turn.user_id = command.user_id
       INNER JOIN model_run_attempts attempt
         ON attempt.generation_command_id = command.generation_command_id
        AND attempt.attempt_no = 1
        AND attempt.status IN ('prepared', 'running')
       WHERE command.generation_stage = 'history_answer'
         AND command.authoritative_result_id IS NULL
         AND command.status = ANY($2::text[])
         AND turn.status IN ('open', 'responding')
       ORDER BY command.created_at, command.generation_command_id
       LIMIT $1`,
      [input.limit, SETTLE_TERMINAL_STATUSES],
    );
    return result.rows.map((row) => ({
      generationCommandId: asGenerationCommandId(row.generation_command_id),
      interactionTurnId: asInteractionTurnId(row.interaction_turn_id),
      modelRunAttemptId: asModelRunAttemptId(row.model_run_attempt_id),
      requestEventRevisionId: asConversationEventRevisionId(row.request_event_revision_id),
      userId: asUserId(row.user_id),
    }));
  }
}

/**
 * Re-read and re-qualify the frozen item references for the compile of a
 * History Answer command. A reference that no longer qualifies (the Event or
 * revision changed, was purged, or gained an explicit Correction / Forget
 * association) is dropped and counted; its text is never selected.
 */
export async function loadHistoryRecallForContext(
  client: PoolClient,
  input: { answerCommandId: string; userId: string },
): Promise<ContextSourceHistoryRecall | null> {
  const head = await client.query<{
    coverage: unknown;
    failure_code: string | null;
    history_recall_result_id: string;
    item_refs: readonly HistoryRecallItemRef[];
    plan: { plan: HistoryRecallResult["plan"]; proposal: HistoryRecallResult["proposal"] };
    policy_version: string;
    status: HistoryRecallResult["status"];
  }>(
    `SELECT history_recall_result_id::text, policy_version, status, failure_code,
            plan, coverage, item_refs
     FROM history_recall_results
     WHERE answer_command_id = $1 AND user_id = $2`,
    [input.answerCommandId, input.userId],
  );
  const result = head.rows[0];
  if (!result) return null;
  const rows = await client.query<{
    actor: "user" | "assistant";
    daily_session_id: string;
    expressed_at: Date;
    expression_timezone: string | null;
    expression_timezone_source: "request" | "session_start_fallback" | null;
    locale: string;
    ref_group: string | null;
    ref_role: string | null;
    revision_id: string;
    sequence_no: string;
    text: string;
  }>(
    `SELECT ref.value ->> 'revisionId' AS revision_id,
            ref.value ->> 'role' AS ref_role,
            ref.value ->> 'group' AS ref_group,
            event.actor, event.daily_session_id::text AS daily_session_id,
            event.created_at AS expressed_at, event.sequence_no::text AS sequence_no,
            revision.locale, revision.canonical_text AS text,
            COALESCE(generating_command.request_timezone, expression_command.request_timezone, session.timezone_at_start) AS expression_timezone,
            CASE
              WHEN generating_command.request_timezone IS NOT NULL THEN 'request'
              WHEN expression_command.request_timezone IS NOT NULL THEN 'request'
              WHEN session.timezone_at_start IS NOT NULL THEN 'session_start_fallback'
            END AS expression_timezone_source
     FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS ref(value, ord)
     INNER JOIN conversation_event_revisions revision
       ON revision.conversation_event_revision_id = (ref.value ->> 'revisionId')::uuid
      AND revision.user_id = $1
     INNER JOIN conversation_events event
       ON event.conversation_event_id = revision.conversation_event_id
      AND event.user_id = revision.user_id
     LEFT JOIN generation_commands generating_command
       ON generating_command.generation_command_id = event.generation_command_id
      AND generating_command.user_id = event.user_id
     LEFT JOIN LATERAL (
       SELECT request_command.request_timezone
       FROM generation_commands request_command
       WHERE event.actor = 'user'
         AND request_command.subject_type = 'conversation_event'
         AND request_command.subject_id = event.conversation_event_id
         AND request_command.interaction_turn_id = event.interaction_turn_id
         AND request_command.user_id = event.user_id
       ORDER BY request_command.created_at
       LIMIT 1
     ) expression_command ON TRUE
     LEFT JOIN daily_sessions session
       ON session.daily_session_id = event.daily_session_id
      AND session.user_id = event.user_id
     WHERE event.lifecycle_status = 'active'
       AND event.current_revision_id = revision.conversation_event_revision_id
       AND revision.content_purged_at IS NULL
       AND revision.transcript_status IN ${ELIGIBLE_TRANSCRIPT_STATUSES_SQL}
       AND ${controlExclusionSql({
         revisionId: "revision.conversation_event_revision_id",
         userId: "event.user_id",
       })} IS NULL
       AND (
         event.actor = 'user'
         OR (
           generating_command.input_revision_id IS NOT NULL
           AND ${generatingUserRevisionIsCurrentSql({
             generatingRevisionId: "generating_command.input_revision_id",
             userId: "event.user_id",
           })}
           AND ${controlExclusionSql({
             revisionId: "generating_command.input_revision_id",
             userId: "event.user_id",
           })} IS NULL
         )
       )
     ORDER BY ref.ord`,
    [input.userId, JSON.stringify(result.item_refs)],
  );
  const frozen = result.plan;
  // An experience search quotes adjacent context only for an occasion whose
  // matching message still qualifies: without its evidence the neighbours are
  // not injected on their own.
  const liveMatchGroups = new Set(
    rows.rows
      .filter((row) => row.ref_role === "match")
      .map((row) => row.ref_group),
  );
  const qualified = rows.rows.filter(
    (row) => row.ref_role !== "context" || liveMatchGroups.has(row.ref_group),
  );
  return {
    droppedAtCompile: Math.max(0, result.item_refs.length - qualified.length),
    events: qualified.map((row) => ({
      actor: row.actor,
      dailySessionId: asDailySessionId(row.daily_session_id),
      expressedAt: row.expressed_at.toISOString(),
      expressionTimezone: row.expression_timezone,
      expressionTimezoneSource: row.expression_timezone_source ?? "unknown",
      locale: row.locale,
      revisionId: asConversationEventRevisionId(row.revision_id),
      selectionReason:
        row.ref_role === "match"
          ? "history_lexical_match"
          : row.ref_role === "context"
            ? "history_lexical_context"
            : "history_date_range",
      sequence: Number(row.sequence_no),
      text: row.text,
    })),
    policyVersion: result.policy_version,
    result: {
      coverage: result.coverage as HistoryRecallResult["coverage"],
      failureCode: result.failure_code as HistoryRecallResult["failureCode"],
      plan: frozen.plan,
      proposal: frozen.proposal,
      status: result.status,
    },
    resultId: result.history_recall_result_id,
  };
}
