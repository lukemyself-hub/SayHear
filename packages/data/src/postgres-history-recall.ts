import type { Pool, PoolClient } from "pg";

import {
  HISTORY_ANSWER_TASK_INSTRUCTION_VERSION,
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
} from "@sayhear/application";
import {
  asConversationEventRevisionId,
  asDailySessionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asUserId,
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
 * One keyset page of retained original messages whose expression instant falls
 * inside the plan local-date range (half-open UTC bounds computed in SQL from
 * the IANA zone, so DST days are 23/25 hours long and correct), up to the
 * frozen cutoff, excluding the current Daily Session. Rows with an explicit
 * control association come back with their text blanked: the text never
 * crosses the port. The Assistant is bound to the user revision that
 * generated it; a superseded or controlled request makes the reply ineligible.
 *
 * Parameters: $1 user, $2 timezone, $3 start local date, $4 end local date,
 * $5 cutoff, $6 current session, $7 page size + 1, $8 cursor instant (text or
 * NULL), $9 cursor session, $10 cursor sequence.
 */
export const HISTORY_RECALL_PAGE_SQL = `
  WITH bounds AS (
    SELECT ($3::date)::timestamp AT TIME ZONE $2 AS start_utc,
           (($4::date) + 1)::timestamp AT TIME ZONE $2 AS end_utc
  )
  SELECT
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
    control.exclusion AS exclusion
  FROM bounds, conversation_events event
  INNER JOIN conversation_event_revisions revision
    ON revision.conversation_event_revision_id = event.current_revision_id
   AND revision.user_id = event.user_id
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
  ) control ON TRUE
  WHERE event.user_id = $1
    AND event.actor IN ('user', 'assistant')
    AND event.lifecycle_status = 'active'
    AND revision.content_purged_at IS NULL
    AND revision.transcript_status IN ${ELIGIBLE_TRANSCRIPT_STATUSES_SQL}
    AND event.created_at >= bounds.start_utc
    AND event.created_at < bounds.end_utc
    AND event.created_at <= $5::timestamptz
    AND event.daily_session_id <> $6::uuid
    AND (
      $8::timestamptz IS NULL
      OR (event.created_at, event.daily_session_id::text, event.sequence_no) >
         ($8::timestamptz, $9::text, $10::bigint)
    )
  ORDER BY event.created_at, event.daily_session_id::text, event.sequence_no
  LIMIT $7
`;

const CURRENT_CONVERSATION_COUNT_SQL = `
  WITH bounds AS (
    SELECT ($3::date)::timestamp AT TIME ZONE $2 AS start_utc,
           (($4::date) + 1)::timestamp AT TIME ZONE $2 AS end_utc
  )
  SELECT COUNT(*)::text AS rows
  FROM bounds, conversation_events event
  WHERE event.user_id = $1
    AND event.daily_session_id = $5::uuid
    AND event.actor IN ('user', 'assistant')
    AND event.lifecycle_status = 'active'
    AND event.created_at >= bounds.start_utc
    AND event.created_at < bounds.end_utc
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
            plan.startDate,
            plan.endDate,
            plan.cutoff,
            request.currentDailySessionId,
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
      const current = await client.query<{ rows: string }>(
        CURRENT_CONVERSATION_COUNT_SQL,
        [request.userId, plan.timezone, plan.startDate, plan.endDate, request.currentDailySessionId],
      );
      return {
        currentConversationRows: Number(current.rows[0]?.rows ?? 0),
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
    };
  }

  public async commitHistoryRecall(input: {
    decisionAttemptId: ModelRunAttemptId;
    decisionCommandId: GenerationCommandId;
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
          HISTORY_ANSWER_TASK_INSTRUCTION_VERSION,
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
           failure_code, plan, coverage, item_refs, expected_data_epoch, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13)`,
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
    revision_id: string;
    sequence_no: string;
    text: string;
  }>(
    `SELECT ref.value ->> 'revisionId' AS revision_id,
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
  return {
    droppedAtCompile: Math.max(0, result.item_refs.length - rows.rows.length),
    events: rows.rows.map((row) => ({
      actor: row.actor,
      dailySessionId: asDailySessionId(row.daily_session_id),
      expressedAt: row.expressed_at.toISOString(),
      expressionTimezone: row.expression_timezone,
      expressionTimezoneSource: row.expression_timezone_source ?? "unknown",
      locale: row.locale,
      revisionId: asConversationEventRevisionId(row.revision_id),
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
