import type {
  CompleteResponseMetadata,
  ActionReferenceHandle,
  ActionReferenceTarget,
  ActionFinalizationReceiptSnapshot,
  CompiledContextReferencedEvent,
  CompiledContextSection,
  ContextCompilerRepository,
  ContextPolicyVersions,
  ContextSourceRecentContextPolicy,
  ContextSourceSnapshot,
  CurrentRollingSummary,
  ConversationResponseRepository,
  ConversationTextChampion,
  CuriosityStopSignalProposal,
  ProviderDispatchErrorCategory,
  ProviderEgressClaim,
  ProviderEgressRepository,
} from "@sayhear/application";
import {
  applyCuriosityStopSignalProposals,
  countFollowUpQuestions,
  CURIOSITY_STOP_SIGNAL_POLICY_VERSION,
  EMPTY_CURIOSITY_STOP_SIGNAL_CONTENT,
  minimumHighRiskSafetyPostureDetector,
  SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE,
  SAFETY_POSTURE_POLICY_VERSION,
  applySafetyPostureTurn,
  validateCuriosityStopSignalContent,
  validateSafetyPostureContent,
  type CuriosityStopSignalContent,
  type CurrentCuriosityStopSignal,
  type CurrentSafetyPosture,
  type SafetyPostureContent,
  type SafetyPostureDetector,
} from "@sayhear/application";
import {
  asCompiledContextId,
  asConversationEventId,
  asConversationEventRevisionId,
  asDailySessionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asUserId,
  type CompiledContextId,
  type GenerationCommandId,
  type InteractionTurnId,
  type ModelRunAttemptId,
  type UserId,
} from "@sayhear/domain";
import type { Pool, PoolClient } from "pg";

import { createUuidV7 } from "./uuid-v7";
import { loadHistoryRecallForContext } from "./postgres-history-recall";
import {
  controlExclusionSql,
  generatingUserRevisionIsCurrentSql,
} from "./postgres-source-eligibility";
import { loadActionFinalizationReceiptSnapshot } from "./postgres-memory-trust-action-repository";
import { loadDialogueStateForContext } from "./postgres-dialogue-state-repository";
import { FAST_PATH_PENDING_REVISIONS_SQL } from "./postgres-fast-path-extraction-repository";

type ContextHeadRow = Readonly<{
  action_execution_id: string | null;
  action_execution_status: ActionFinalizationReceiptSnapshot["execution"] | null;
  action_receipt_admission: ActionFinalizationReceiptSnapshot["admission"] | null;
  action_receipt_disposition: string | null;
  action_receipt_sequence: number | null;
  activity_state: "active" | "finalized" | "quiescent";
  canonical_persona_version: string | null;
  closure_policy_version: string;
  continuous_exchange_no: string;
  daily_session_id: string;
  current_journal_id: string | null;
  current_journal_version_id: string | null;
  current_journal_source_revision: string | null;
  current_journal_version_status: "published" | "stale" | "validation_failed" | "needs_review" | null;
  dialogue_revision: string;
  generation_stage: "decision" | "action_finalization" | "history_answer";
  input_revision_id: string;
  locale: string;
  locale_policy_version: string;
  output_format_version: string;
  persona_behavior_anchors_version: string | null;
  persona_contract_invariant_version: string | null;
  product_policy_version: string;
  prompt_version: string;
  relationship_policy_version: string;
  safety_policy_version: string;
  source_revision: string;
  timezone_at_start: string;
  expected_data_epoch: string;
  command_created_at: Date;
  /** Admitted request zone written by #294; NULL for legacy commands. */
  request_timezone: string | null;
  /** `created_at` of the admitted input event behind `command.subject_id`. */
  request_created_at: Date | null;
  rolling_summary_id: string | null;
  rolling_summary_version: string | null;
  rolling_summary_covered_through: string | null;
  rolling_summary_content: CurrentRollingSummary["content"] | null;
  rolling_summary_policy_version: string | null;
  rolling_summary_prompt_version: string | null;
  rolling_summary_model_config_version: string | null;
  rolling_summary_sources: string[] | null;
  rolling_summary_failed: boolean;
}>;

type ContextEventRow = Readonly<{
  actor: "user" | "assistant";
  expressed_at: Date;
  expression_timezone: string | null;
  expression_timezone_source: "request" | "session_start_fallback" | null;
  locale: string;
  revision_id: string;
  sequence_no: string;
  text: string;
}>;

type DispatchRow = Readonly<{
  action_execution_id: string | null;
  action_execution_status: ActionFinalizationReceiptSnapshot["execution"] | null;
  action_receipt_admission: ActionFinalizationReceiptSnapshot["admission"] | null;
  action_receipt_disposition: string | null;
  action_receipt_sequence: number | null;
  attempt_status: string;
  canonical_persona_version: string | null;
  consent_active: boolean;
  consent_policy_version: string | null;
  context_compiler_version: string;
  context_content_hmac: string;
  context_dialogue_revision: string;
  context_integrity_algorithm: "hmac-sha256";
  context_integrity_key_version: string;
  context_policy_versions: ContextPolicyVersions;
  context_rolling_summary: CurrentRollingSummary | null;
  context_sections: CompiledContextSection[];
  context_source_revision: string;
  context_total_tokens: string;
  daily_session_id: string;
  data_epoch: string;
  expected_data_epoch: string;
  freshness_policy: string;
  generation_stage: "decision" | "action_finalization" | "history_answer";
  input_revision_id: string;
  locale: string;
  locale_policy_version: string;
  model: string;
  model_config_version: string;
  model_snapshot: string;
  output_format_version: string;
  persona_behavior_anchors_version: string | null;
  persona_contract_invariant_version: string | null;
  product_policy_version: string;
  prompt_version: string;
  provider: string;
  provider_policy_consent_version: string | null;
  provider_policy_model_config_version: string;
  provider_policy_status: string;
  provider_policy_version: string;
  relationship_policy_version: string;
  safety_policy_version: string;
  session_dialogue_revision: string;
  session_source_revision: string;
  source_active: boolean;
  status: string;
  user_status: string;
}>;

export class PostgresConversationResponseRepository
  implements
    ContextCompilerRepository,
    ConversationResponseRepository,
    ProviderEgressRepository
{
  public constructor(
    private readonly pool: Pool,
    options: Readonly<{ safetyPostureDetector?: SafetyPostureDetector }> = {},
  ) {
    this.safetyPostureDetector =
      options.safetyPostureDetector ?? minimumHighRiskSafetyPostureDetector;
  }

  private readonly safetyPostureDetector: SafetyPostureDetector;

  public async commitActionDecision(input: {
    completedAt: Date;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    userId: UserId;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE generation_commands
         SET status = 'succeeded', settled_at = $3,
             recovery_status = 'not_needed', next_recovery_at = NULL
         WHERE generation_command_id = $1 AND user_id = $2
           AND status IN ('running', 'compiling')
           AND authoritative_result_id IS NULL
           AND generation_stage = 'decision'`,
        // The Decision Command carries no attempt column: only the command,
        // owner, and settle time participate in this transition.
        [input.generationCommandId, input.userId, input.completedAt],
      );
      await client.query(
        `UPDATE model_run_attempts
         SET status = 'succeeded', completed_at = COALESCE(completed_at, $3),
             recovery_status = 'not_needed', recovery_claimed_at = NULL
         WHERE model_run_attempt_id = $1 AND generation_command_id = $2
           AND user_id = $4 AND status = 'running'`,
        [input.modelRunAttemptId, input.generationCommandId, input.completedAt, input.userId],
      );
      await client.query(
        `UPDATE provider_egress_dispositions
         SET status = 'completed', completed_at = COALESCE(completed_at, $3)
         WHERE model_run_attempt_id = $1 AND user_id = $2
           AND status IN ('dispatched', 'completed')`,
        [input.modelRunAttemptId, input.userId, input.completedAt],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimResponseExecution(input: {
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    userId: UserId;
  }): Promise<"owner" | "shared"> {
    const claimed = await this.pool.query(
      `
        UPDATE generation_commands command
        SET status = 'compiling'
        FROM model_run_attempts attempt
        WHERE command.generation_command_id = $1
          AND command.user_id = $2
          AND command.status = 'prepared'
          AND attempt.model_run_attempt_id = $3
          AND attempt.generation_command_id =
            command.generation_command_id
          AND attempt.user_id = command.user_id
          AND attempt.status = 'prepared'
          AND attempt.attempt_no = (
            SELECT MAX(latest.attempt_no)
            FROM model_run_attempts latest
            WHERE latest.generation_command_id =
              command.generation_command_id
              AND latest.user_id = command.user_id
          )
      `,
      [
        input.generationCommandId,
        input.userId,
        input.modelRunAttemptId,
      ],
    );
    if (claimed.rowCount === 1) {
      return "owner";
    }
    const existing = await this.pool.query(
      `
        SELECT 1
        FROM generation_commands
        WHERE generation_command_id = $1
          AND user_id = $2
      `,
      [input.generationCommandId, input.userId],
    );
    if (existing.rowCount !== 1) {
      throw new Error("The GenerationCommand execution was not found.");
    }
    return "shared";
  }

  public async loadResponse(input: {
    generationCommandId: GenerationCommandId;
    userId: UserId;
  }): ReturnType<ConversationResponseRepository["loadResponse"]> {
    const result = await this.pool.query<{
      error_category: string | null;
      event_created_at: Date | null;
      event_id: string | null;
      revision_id: string | null;
      status:
        | "compiling"
        | "failed"
        | "interrupted"
        | "prepared"
        | "retry_pending"
        | "running"
        | "succeeded";
      text: string | null;
    }>(
      `
        SELECT
          command.status,
          attempt.error_category,
          event.conversation_event_id AS event_id,
          event.created_at AS event_created_at,
          revision.conversation_event_revision_id AS revision_id,
          revision.canonical_text AS text
        FROM generation_commands command
        INNER JOIN LATERAL (
          SELECT latest_attempt.*
          FROM model_run_attempts latest_attempt
          WHERE latest_attempt.generation_command_id =
            command.generation_command_id
            AND latest_attempt.user_id = command.user_id
          ORDER BY latest_attempt.attempt_no DESC
          LIMIT 1
        ) attempt ON TRUE
        LEFT JOIN conversation_events event
          ON event.generation_command_id = command.generation_command_id
          AND event.user_id = command.user_id
          AND event.actor = 'assistant'
        LEFT JOIN conversation_event_revisions revision
          ON revision.conversation_event_revision_id =
            command.authoritative_result_id
          AND revision.conversation_event_id = event.conversation_event_id
          AND revision.user_id = event.user_id
        WHERE command.generation_command_id = $1
          AND command.user_id = $2
      `,
      [input.generationCommandId, input.userId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("The GenerationCommand response state was not found.");
    }
    if (row.status === "succeeded") {
      if (
        !row.event_id ||
        !row.revision_id ||
        row.text === null ||
        row.event_created_at === null
      ) {
        throw new Error(
          "The succeeded GenerationCommand has no authoritative response.",
        );
      }
      return {
        createdAt: row.event_created_at.toISOString(),
        eventId: asConversationEventId(row.event_id),
        outcome: "committed",
        revisionId: asConversationEventRevisionId(row.revision_id),
        text: row.text,
      };
    }
    if (row.status === "failed" || row.status === "interrupted") {
      return {
        category: asProviderErrorCategory(row.error_category),
        outcome: row.status,
      };
    }
    return {
      outcome:
        row.status === "compiling" || row.status === "retry_pending"
          ? "running"
          : row.status,
    };
  }

  public async claimStaleResponseExecution(input: {
    expectedModelRunAttemptId: ModelRunAttemptId;
    generationCommandId: GenerationCommandId;
    now: Date;
    userId: UserId;
  }): ReturnType<
    ConversationResponseRepository["claimStaleResponseExecution"]
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await client.query<{
        attempt_no: number;
        attempt_status: string;
        command_status: string;
        first_token_at: Date | null;
        interaction_turn_id: string;
        max_attempts: number;
        model: string;
        model_run_attempt_id: string;
        model_snapshot: string;
        operation_type: "conversation.text";
        prompt_version: string;
        provider: string;
        provider_completed_at: Date | null;
        recovery_claimed_at: Date | null;
        recovery_window_ms: string;
        retry_not_before: Date | null;
        started_at: Date | null;
        turn_status: string;
      }>(
        `
          SELECT
            command.status AS command_status,
            command.interaction_turn_id,
            turn.status AS turn_status,
            attempt.model_run_attempt_id,
            attempt.attempt_no,
            attempt.operation_type,
            attempt.provider,
            attempt.model,
            attempt.model_snapshot,
            attempt.prompt_version,
            attempt.status AS attempt_status,
            attempt.started_at,
            attempt.first_token_at,
            attempt.provider_completed_at,
            attempt.retry_not_before,
            attempt.recovery_claimed_at,
            policy.recovery_window_ms,
            policy.max_attempts
          FROM generation_commands command
          INNER JOIN interaction_turns turn
            ON turn.interaction_turn_id = command.interaction_turn_id
            AND turn.user_id = command.user_id
          INNER JOIN model_run_attempts attempt
            ON attempt.generation_command_id =
              command.generation_command_id
            AND attempt.user_id = command.user_id
          INNER JOIN conversation_response_recovery_policies policy
            ON policy.policy_version = command.recovery_policy_version
          WHERE command.generation_command_id = $1
            AND command.user_id = $2
            AND attempt.model_run_attempt_id = $3
            AND attempt.attempt_no = (
              SELECT MAX(latest.attempt_no)
              FROM model_run_attempts latest
              WHERE latest.generation_command_id =
                command.generation_command_id
                AND latest.user_id = command.user_id
            )
          FOR UPDATE OF command, turn, attempt
        `,
        [
          input.generationCommandId,
          input.userId,
          input.expectedModelRunAttemptId,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return { outcome: "replayed" };
      }
      const recoveryWindowMs = Number(row.recovery_window_ms);
      const recoveryClaimExpired =
        row.recovery_claimed_at === null ||
        row.recovery_claimed_at.getTime() + recoveryWindowMs <=
          input.now.getTime();
      const preparedDue =
        (row.command_status === "prepared" ||
          row.command_status === "compiling") &&
        row.attempt_status === "prepared" &&
        recoveryClaimExpired;
      const runningDue =
        row.command_status === "running" &&
        row.attempt_status === "running" &&
        row.started_at !== null &&
        row.started_at.getTime() + recoveryWindowMs <=
          input.now.getTime();
      const retryDue =
        row.command_status === "retry_pending" &&
        row.retry_not_before !== null &&
        row.retry_not_before <= input.now &&
        recoveryClaimExpired;
      if (!preparedDue && !runningDue && !retryDue) {
        await client.query("COMMIT");
        return { outcome: "not_due" };
      }

      if (row.first_token_at || row.provider_completed_at) {
        await settleRecoveredInterruption(client, {
          attemptStatus: row.provider_completed_at
            ? "result_unknown"
            : "interrupted",
          category: row.provider_completed_at ? "unknown" : "aborted",
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.expectedModelRunAttemptId,
          now: input.now,
          userId: input.userId,
        });
        await client.query("COMMIT");
        return { outcome: "interrupted" };
      }

      if (!preparedDue && row.attempt_no >= row.max_attempts) {
        await settleRecoveredTerminal(client, {
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.expectedModelRunAttemptId,
          now: input.now,
          userId: input.userId,
        });
        await client.query("COMMIT");
        return { outcome: "terminal" };
      }

      let modelRunAttemptId = input.expectedModelRunAttemptId;
      let retried = false;
      if (runningDue || retryDue) {
        modelRunAttemptId = asModelRunAttemptId(createUuidV7(input.now));
        retried = true;
        await client.query(
          `
            UPDATE model_run_attempts
            SET
              status = CASE
                WHEN $4 THEN 'result_unknown'
                ELSE status
              END,
              completed_at = COALESCE(completed_at, $1),
              error_category = COALESCE(error_category, 'timeout'),
              recovery_status = 'retried',
              recovery_claimed_at = NULL
            WHERE model_run_attempt_id = $2
              AND user_id = $3
          `,
          [
            input.now,
            input.expectedModelRunAttemptId,
            input.userId,
            runningDue,
          ],
        );
        await client.query(
          `
            UPDATE provider_egress_dispositions
            SET
              status = CASE
                WHEN status = 'blocked' THEN 'blocked'
                ELSE 'failed'
              END,
              completed_at = COALESCE(completed_at, $1),
              error_category = COALESCE(error_category, 'timeout')
            WHERE model_run_attempt_id = $2
              AND user_id = $3
              AND status IN ('blocked', 'dispatched')
          `,
          [input.now, input.expectedModelRunAttemptId, input.userId],
        );
        await client.query(
          `
            INSERT INTO model_run_attempts (
              model_run_attempt_id,
              user_id,
              generation_command_id,
              attempt_no,
              operation_type,
              provider,
              model,
              model_snapshot,
              prompt_version,
              status,
              retry_of_model_run_attempt_id,
              recovery_status,
              recovery_claimed_at,
              created_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, 'prepared',
              $10, 'recovering', $11, $11
            )
          `,
          [
            modelRunAttemptId,
            input.userId,
            input.generationCommandId,
            row.attempt_no + 1,
            row.operation_type,
            row.provider,
            row.model,
            row.model_snapshot,
            row.prompt_version,
            input.expectedModelRunAttemptId,
            input.now,
          ],
        );
      } else {
        await client.query(
          `
            UPDATE model_run_attempts
            SET
              recovery_status = 'recovering',
              recovery_claimed_at = $1
            WHERE model_run_attempt_id = $2
              AND user_id = $3
          `,
          [input.now, modelRunAttemptId, input.userId],
        );
      }
      await client.query(
        `
          UPDATE generation_commands
          SET
            status = 'prepared',
            recovery_status = 'recovering',
            recovery_checked_at = $1,
            next_recovery_at = NULL,
            settled_at = NULL
          WHERE generation_command_id = $2
            AND user_id = $3
            AND authoritative_result_id IS NULL
        `,
        [input.now, input.generationCommandId, input.userId],
      );
      await client.query("COMMIT");
      return {
        generationCommandId: input.generationCommandId,
        modelRunAttemptId,
        outcome: "execute",
        retried,
        turnId: asInteractionTurnId(row.interaction_turn_id),
        userId: input.userId,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async listStaleResponseExecutions(input: {
    dueAt: Date;
    limit: number;
  }): ReturnType<
    ConversationResponseRepository["listStaleResponseExecutions"]
  > {
    const result = await this.pool.query<{
      generation_command_id: string;
      interaction_turn_id: string;
      model_run_attempt_id: string;
      user_id: string;
    }>(
      `
        SELECT
          command.generation_command_id,
          command.interaction_turn_id,
          attempt.model_run_attempt_id,
          command.user_id
        FROM generation_commands command
        INNER JOIN LATERAL (
          SELECT latest.*
          FROM model_run_attempts latest
          WHERE latest.generation_command_id =
            command.generation_command_id
            AND latest.user_id = command.user_id
          ORDER BY latest.attempt_no DESC
          LIMIT 1
        ) attempt ON TRUE
        INNER JOIN interaction_turns turn
          ON turn.interaction_turn_id = command.interaction_turn_id
          AND turn.user_id = command.user_id
        INNER JOIN conversation_response_recovery_policies policy
          ON policy.policy_version = command.recovery_policy_version
        WHERE command.authoritative_result_id IS NULL
          AND command.generation_stage NOT IN ('action_finalization', 'history_answer')
          AND turn.status IN ('open', 'responding')
          AND (
            (
              command.status IN ('prepared', 'compiling')
              AND attempt.status = 'prepared'
              AND attempt.created_at +
                policy.recovery_window_ms * INTERVAL '1 millisecond' <= $1
            )
            OR (
              command.status = 'running'
              AND attempt.status = 'running'
              AND attempt.started_at IS NOT NULL
              AND attempt.started_at +
                policy.recovery_window_ms * INTERVAL '1 millisecond' <= $1
            )
            OR (
              command.status = 'retry_pending'
              AND attempt.retry_not_before IS NOT NULL
              AND attempt.retry_not_before <= $1
            )
          )
          AND (
            attempt.recovery_claimed_at IS NULL
            OR attempt.recovery_claimed_at +
              policy.recovery_window_ms * INTERVAL '1 millisecond' <= $1
          )
        ORDER BY attempt.created_at, attempt.model_run_attempt_id
        LIMIT $2
      `,
      [input.dueAt, input.limit],
    );
    return result.rows.map((row) => ({
      generationCommandId: asGenerationCommandId(
        row.generation_command_id,
      ),
      modelRunAttemptId: asModelRunAttemptId(row.model_run_attempt_id),
      turnId: asInteractionTurnId(row.interaction_turn_id),
      userId: asUserId(row.user_id),
    }));
  }

  public async loadContextSource(input: {
    generationCommandId: GenerationCommandId;
    interactionTurnId: InteractionTurnId;
    userId: UserId;
  }): Promise<ContextSourceSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const head = await client.query<ContextHeadRow>(
        `
          SELECT
            command.input_revision_id,
            command.locale,
            command.locale_policy_version,
            command.output_format_version,
            command.persona_contract_invariant_version,
            command.canonical_persona_version,
            command.persona_behavior_anchors_version,
            command.generation_stage,
            command.product_policy_version,
            command.prompt_version,
            command.relationship_policy_version,
            command.safety_policy_version,
            session.daily_session_id,
            current_journal.journal_id AS current_journal_id,
            current_journal.current_version_id AS current_journal_version_id,
            current_journal_version.source_revision AS current_journal_source_revision,
            current_journal_version.status AS current_journal_version_status,
            session.activity_state,
            session.closure_policy_version,
            session.current_continuous_exchange_no AS continuous_exchange_no,
            session.dialogue_revision,
            session.source_revision,
            session.timezone_at_start,
            command.expected_data_epoch,
            command.request_timezone,
            command.created_at AS command_created_at,
            (
              SELECT input_event.created_at
              FROM conversation_events input_event
              WHERE input_event.conversation_event_id = command.subject_id
                AND input_event.user_id = command.user_id
            ) AS request_created_at,
            command.action_execution_id::text AS action_execution_id,
            command.action_execution_status,
            command.action_receipt_sequence,
            frozen_receipt.admission_status AS action_receipt_admission,
            frozen_receipt.disposition AS action_receipt_disposition,
            summary.rolling_summary_version_id AS rolling_summary_id,
            summary.version_no AS rolling_summary_version,
            summary.covered_through_sequence_no AS rolling_summary_covered_through,
            summary.content AS rolling_summary_content,
            summary_command.policy_version AS rolling_summary_policy_version,
            summary_command.prompt_version AS rolling_summary_prompt_version,
            summary_command.model_config_version AS rolling_summary_model_config_version,
            ARRAY(SELECT ref.conversation_event_revision_id::text FROM rolling_summary_command_source_refs ref WHERE ref.rolling_summary_command_id = summary_command.rolling_summary_command_id ORDER BY ref.sequence_no) AS rolling_summary_sources,
            EXISTS (SELECT 1 FROM rolling_summary_commands failed WHERE failed.daily_session_id = session.daily_session_id AND failed.status = 'failed' AND NOT EXISTS (SELECT 1 FROM current_rolling_summaries current WHERE current.daily_session_id = session.daily_session_id AND current.covered_through_sequence_no >= failed.covered_through_sequence_no)) AS rolling_summary_failed
          FROM generation_commands command
          INNER JOIN interaction_turns turn
            ON turn.interaction_turn_id = command.interaction_turn_id
            AND turn.user_id = command.user_id
          INNER JOIN daily_sessions session
            ON session.daily_session_id = turn.daily_session_id
            AND session.user_id = turn.user_id
          LEFT JOIN journals current_journal
            ON current_journal.daily_session_id = session.daily_session_id
            AND current_journal.user_id = command.user_id
            AND current_journal.deleted_at IS NULL
          LEFT JOIN journal_versions current_journal_version
            ON current_journal_version.journal_version_id = current_journal.current_version_id
            AND current_journal_version.user_id = command.user_id
          LEFT JOIN conversation_action_receipts frozen_receipt
            ON frozen_receipt.action_execution_id = command.action_execution_id
           AND frozen_receipt.receipt_sequence = command.action_receipt_sequence
           AND command.generation_stage = 'action_finalization'
          LEFT JOIN current_rolling_summaries current_summary
            ON current_summary.daily_session_id = session.daily_session_id
          LEFT JOIN rolling_summary_versions summary
            ON summary.rolling_summary_version_id = current_summary.rolling_summary_version_id
            AND summary.user_id = command.user_id
            AND summary.daily_session_id = session.daily_session_id
            AND summary.covered_through_sequence_no = current_summary.covered_through_sequence_no
          LEFT JOIN rolling_summary_commands summary_command
            ON summary_command.rolling_summary_command_id = summary.rolling_summary_command_id
            AND summary_command.status = 'published'
            AND NOT EXISTS (
              SELECT 1 FROM rolling_summary_command_source_refs ref
              LEFT JOIN conversation_event_revisions summary_revision ON summary_revision.conversation_event_revision_id = ref.conversation_event_revision_id
              LEFT JOIN conversation_events summary_event ON summary_event.conversation_event_id = summary_revision.conversation_event_id
              WHERE ref.rolling_summary_command_id = summary_command.rolling_summary_command_id
                AND (summary_revision.content_purged_at IS NOT NULL OR summary_event.lifecycle_status <> 'active' OR summary_event.current_revision_id <> ref.conversation_event_revision_id OR summary_event.daily_session_id <> session.daily_session_id OR summary_event.user_id <> summary_command.user_id)
            )
          WHERE command.generation_command_id = $1
            AND command.interaction_turn_id = $2
            AND command.user_id = $3
        `,
        [input.generationCommandId, input.interactionTurnId, input.userId],
      );
      const row = head.rows[0];
      if (!row) {
        throw new Error("The GenerationCommand Context source was not found.");
      }

      const events = await client.query<ContextEventRow>(
        `
          SELECT
            event.actor,
            event.created_at AS expressed_at,
            COALESCE(
              generating_command.request_timezone,
              expression_command.request_timezone,
              session.timezone_at_start
            ) AS expression_timezone,
            CASE
              WHEN generating_command.request_timezone IS NOT NULL
                THEN 'request'
              WHEN expression_command.request_timezone IS NOT NULL
                THEN 'request'
              WHEN session.timezone_at_start IS NOT NULL
                THEN 'session_start_fallback'
            END AS expression_timezone_source,
            event.sequence_no,
            revision.conversation_event_revision_id AS revision_id,
            revision.locale,
            revision.canonical_text AS text
          FROM generation_commands command
          INNER JOIN interaction_turns turn
            ON turn.interaction_turn_id = command.interaction_turn_id
            AND turn.user_id = command.user_id
          INNER JOIN daily_sessions session
            ON session.daily_session_id = turn.daily_session_id
            AND session.user_id = turn.user_id
          INNER JOIN conversation_events input_event
            ON input_event.conversation_event_id = command.subject_id
            AND input_event.user_id = command.user_id
          INNER JOIN conversation_events event
            ON event.daily_session_id = turn.daily_session_id
            AND event.user_id = turn.user_id
          INNER JOIN conversation_event_revisions revision
            ON revision.conversation_event_revision_id = event.current_revision_id
            AND revision.user_id = event.user_id
          LEFT JOIN generation_commands generating_command
            ON generating_command.generation_command_id =
              event.generation_command_id
            AND generating_command.user_id = event.user_id
          LEFT JOIN LATERAL (
            SELECT request_command.request_timezone
            FROM generation_commands request_command
            WHERE event.actor = 'user'
              AND request_command.subject_type = 'conversation_event'
              AND request_command.subject_id = event.conversation_event_id
              AND request_command.interaction_turn_id =
                event.interaction_turn_id
              AND request_command.user_id = event.user_id
            ORDER BY request_command.created_at
            LIMIT 1
          ) expression_command ON TRUE
          WHERE command.generation_command_id = $1
            AND command.user_id = $2
            AND event.sequence_no <= input_event.sequence_no
            AND event.actor IN ('user', 'assistant')
            AND event.lifecycle_status = 'active'
            AND revision.content_purged_at IS NULL
            AND revision.transcript_status IN ('final', 'corrected')
            AND (
              event.actor = 'user'
              OR EXISTS (
                SELECT 1
                FROM generation_commands assistant_command
                WHERE assistant_command.generation_command_id =
                    event.generation_command_id
                  AND assistant_command.user_id = event.user_id
                  AND assistant_command.status = 'succeeded'
                  AND assistant_command.authoritative_result_id =
                    revision.conversation_event_revision_id
              )
            )
          ORDER BY event.sequence_no
        `,
        [input.generationCommandId, input.userId],
      );

      const dialogueState = await loadDialogueStateForContext(client, {
        dailySessionId: row.daily_session_id,
        dialogueRevision: Number(row.dialogue_revision),
        expectedDataEpoch: Number(row.expected_data_epoch),
        sourceRevision: Number(row.source_revision),
      });
      const curiosityStopSignal = await loadCuriosityStopSignalForContext(
        client,
        {
          dailySessionId: row.daily_session_id,
          sourceRevision: Number(row.source_revision),
        },
      );
      const safetyPosture = await loadSafetyPostureForContext(client, {
        dailySessionId: row.daily_session_id,
        sourceRevision: Number(row.source_revision),
      });
      // Issue #113: the compile never waits on the fast path; when the session
      // carries committed extraction commands whose runs have not completed,
      // the manifest records `fast_path_pending` and raw Events keep serving.
      const fastPathPending = await client.query<{ pending: boolean }>(
        `SELECT EXISTS (${FAST_PATH_PENDING_REVISIONS_SQL}) AS pending`,
        [row.daily_session_id],
      );
      // #295: the active recent-context governance row is read in the compile
      // snapshot. Absent / revoked means the recent path is disabled for this
      // turn: the compiler emits no recent selection and the original
      // conversation continues. The full identity/budget row is returned so
      // the compiler can refuse a row that names a runtime it does not
      // actually run. The dispatch fence re-checks the frozen version under a
      // shared lock, so a disable after this read still fails the in-flight
      // selection closed.
      const recentPolicy = await client.query<{
        budget_tokens: number;
        compiler_version: string;
        max_candidate_bytes: number;
        max_candidate_rows: number;
        max_single_event_tokens: number;
        policy_version: string;
        read_timeout_ms: number;
        selection_policy_version: string;
        selector_policy_version: string;
      }>(
        `SELECT
           policy_version,
           compiler_version,
           selector_policy_version,
           selection_policy_version,
           budget_tokens,
           max_candidate_rows,
           max_candidate_bytes,
           max_single_event_tokens,
           read_timeout_ms
         FROM recent_context_policies
         WHERE status = 'active'
         LIMIT 1`,
      );
      const memoryActionTargets = await loadMemoryActionReferenceTargets(
        client,
        input.userId,
        Number(row.source_revision),
      );
      const actionReferenceTargets: ActionReferenceTarget[] = [
        ...(row.current_journal_id &&
        row.current_journal_version_id &&
        row.current_journal_source_revision &&
        row.current_journal_version_status === "published"
          ? [
              {
                actionKinds: ["regenerate_journal"],
                targetId: row.current_journal_id,
                targetKind: "journal" as const,
                targetVersionId: row.current_journal_version_id,
                sourceRevision: Number(row.current_journal_source_revision),
              } satisfies ActionReferenceTarget,
            ]
          : []),
        ...memoryActionTargets,
      ];

      const historyRecall =
        row.generation_stage === "history_answer"
          ? await loadHistoryRecallForContext(client, {
              answerCommandId: input.generationCommandId,
              userId: input.userId,
            })
          : null;
      await client.query("COMMIT");
      return {
        ...(historyRecall === null ? {} : { historyRecall }),
        ...(row.action_execution_id !== null &&
        row.action_receipt_sequence !== null &&
        row.action_execution_status !== null &&
        row.action_receipt_admission !== null
          ? {
              actionFinalizationReceipt:
                await loadActionFinalizationReceiptSnapshot(client, {
                  actionExecutionId: row.action_execution_id,
                  admission: row.action_receipt_admission,
                  disposition: row.action_receipt_disposition,
                  execution: row.action_execution_status,
                  receiptSequence: row.action_receipt_sequence,
                }),
            }
          : {}),
        ...(actionReferenceTargets.length === 0
          ? {}
          : { actionReferenceTargets }),
        curiosityStopSignal,
        dailySession: {
          activityState: row.activity_state,
          closurePolicyVersion: row.closure_policy_version,
          continuousExchangeNo: Number(row.continuous_exchange_no),
          id: asDailySessionId(row.daily_session_id),
          timezone: row.timezone_at_start,
        },
        dialogueRevision: Number(row.dialogue_revision),
        dialogueState: dialogueState.dialogueState,
        dialogueStateFailure: dialogueState.failure,
        expectedDataEpoch: Number(row.expected_data_epoch),
        // The frozen recent-source cutoff is the admitted request's input
        // event instant, so an explicit retry reuses the original window
        // instead of moving it to the retry clock (issue #294). Legacy rows
        // without an addressable subject fall back to the command instant.
        commandCreatedAt: row.request_created_at ?? row.command_created_at,
        ...(row.request_timezone === null
          ? {}
          : { requestTimezone: row.request_timezone }),
        events: events.rows.map((event) => ({
          actor: event.actor,
          expressedAt: event.expressed_at.toISOString(),
          expressionTimezone: event.expression_timezone,
          expressionTimezoneSource:
            event.expression_timezone_source ?? "unknown",
          locale: event.locale,
          revisionId: asConversationEventRevisionId(event.revision_id),
          sequence: Number(event.sequence_no),
          text: event.text,
        })),
        fastPathPending: fastPathPending.rows[0]?.pending === true,
        generationStage: row.generation_stage,
        inputRevisionId: asConversationEventRevisionId(row.input_revision_id),
        locale: row.locale,
        // A pre-migration command has no persona block versions; the empty
        // string keeps the field typed while guaranteeing the compiler's
        // fail-closed artifact resolution rejects it.
        policyVersions: {
          canonicalPersonaVersion: row.canonical_persona_version ?? "",
          localePolicyVersion: row.locale_policy_version,
          outputFormatVersion: row.output_format_version,
          personaBehaviorAnchorsVersion:
            row.persona_behavior_anchors_version ?? "",
          personaContractInvariantVersion:
            row.persona_contract_invariant_version ?? "",
          productPolicyVersion: row.product_policy_version,
          relationshipPolicyVersion: row.relationship_policy_version,
          safetyPolicyVersion: row.safety_policy_version,
          taskInstructionVersion: row.prompt_version,
        },
        rollingSummary:
          row.rolling_summary_id === null || row.rolling_summary_version === null ||
          row.rolling_summary_covered_through === null || row.rolling_summary_content === null ||
          row.rolling_summary_policy_version === null || row.rolling_summary_prompt_version === null ||
          row.rolling_summary_model_config_version === null
            ? null
            : {
                id: row.rolling_summary_id,
                version: Number(row.rolling_summary_version),
                coveredThrough: Number(row.rolling_summary_covered_through),
                content: row.rolling_summary_content,
                sourceRevisionIds: (row.rolling_summary_sources ?? []).map(asConversationEventRevisionId),
                policyVersion: row.rolling_summary_policy_version,
                promptVersion: row.rolling_summary_prompt_version,
                modelConfigVersion: row.rolling_summary_model_config_version,
              },
        rollingSummaryFailure: row.rolling_summary_failed,
        recentContextPolicy: mapRecentContextPolicy(recentPolicy.rows[0]),
        safetyPosture,
        sourceRevision: Number(row.source_revision),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async saveCompiledContext(
    input: Parameters<ContextCompilerRepository["saveCompiledContext"]>[0],
  ): ReturnType<ContextCompilerRepository["saveCompiledContext"]> {
    const client = await this.pool.connect();
    const compiledContextId = createUuidV7(input.now);
    try {
      await client.query("BEGIN");
      const command = await client.query<{
        compiled_context_id: string | null;
        status: string;
      }>(
        `
          SELECT compiled_context_id, status
          FROM generation_commands
          WHERE generation_command_id = $1
            AND user_id = $2
          FOR UPDATE
        `,
        [input.generationCommandId, input.userId],
      );
      const commandRow = command.rows[0];
      if (!commandRow) {
        throw new Error("The CompiledContext command was not found.");
      }
      if (commandRow.compiled_context_id) {
        const compiled = await loadCompiledContext(
          client,
          asCompiledContextId(commandRow.compiled_context_id),
        );
        await client.query("COMMIT");
        return compiled;
      }
      if (commandRow.status !== "compiling") {
        throw new Error(
          "Only an owned GenerationCommand can receive CompiledContext.",
        );
      }
      await client.query(
        `
          INSERT INTO compiled_contexts (
            compiled_context_id,
            user_id,
            generation_command_id,
            compiler_version,
            dialogue_revision,
            source_revision,
            locale,
            section_budgets,
            policy_versions,
            rolling_summary,
            sections,
            total_tokens,
            degraded_reason,
            content_hmac,
            integrity_algorithm,
            integrity_key_version,
            retrieval_manifest,
            created_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
            $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17::jsonb, $18
          )
        `,
        [
          compiledContextId,
          input.userId,
          input.generationCommandId,
          input.compilerVersion,
          input.dialogueRevision,
          input.sourceRevision,
          input.locale,
          JSON.stringify(input.sectionBudgets),
          JSON.stringify(input.policyVersions),
          input.rollingSummary === null ? null : JSON.stringify(input.rollingSummary),
          JSON.stringify(input.sections),
          input.totalTokens,
          input.degradedReason,
          input.integrity.contentHmac,
          input.integrity.algorithm,
          input.integrity.keyVersion,
          input.retrievalManifest === undefined || input.retrievalManifest === null
            ? null
            : JSON.stringify(input.retrievalManifest),
          input.now,
        ],
      );
      // #116: the retrieval run row links to the compiled context at commit
      // (retrieval_runs.compiled_context_id is nullable until this point).
      if (input.retrievalRunId) {
        await client.query(
          `UPDATE retrieval_runs SET compiled_context_id = $3
           WHERE user_id = $1 AND retrieval_run_id = $2
             AND compiled_context_id IS NULL`,
          [input.userId, input.retrievalRunId, compiledContextId],
        );
      }
      for (const [ordinal, event] of input.referencedEvents.entries()) {
        // Migration 0068 reserves these columns for the recent-context
        // references. Same-session and current-input expression times are
        // frozen in the HMAC-protected time_context section instead, keeping
        // legacy reference rows and the database section constraint intact.
        const isRecentContextEvent =
          event.section === "recent_conversation_context" ||
          event.section === "history_recall_context";
        await client.query(
          `
            INSERT INTO compiled_context_revision_refs (
              compiled_context_id,
              user_id,
              conversation_event_revision_id,
              ordinal,
              actor,
              estimated_tokens,
              sequence_no,
              section,
              selection_order,
              daily_session_id,
              expressed_at,
              occurred_at,
              selection_reason
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          `,
          [
            compiledContextId,
            input.userId,
            event.revisionId,
            ordinal,
            event.actor,
            event.estimatedTokens,
            event.sequence,
            event.section,
            event.selectionOrder,
            isRecentContextEvent ? event.dailySessionId ?? null : null,
            isRecentContextEvent ? event.expressedAt ?? null : null,
            isRecentContextEvent ? event.occurredAt ?? null : null,
            isRecentContextEvent ? event.selectionReason ?? null : null,
          ],
        );
      }
      const linked = await client.query(
        `
          UPDATE generation_commands
          SET compiled_context_id = $1
          WHERE generation_command_id = $2
            AND user_id = $3
            AND compiled_context_id IS NULL
            AND status = 'compiling'
        `,
        [compiledContextId, input.generationCommandId, input.userId],
      );
      if (linked.rowCount !== 1) {
        throw new Error("The CompiledContext command link was not established.");
      }
      for (const handle of input.actionReferenceHandles ?? []) {
        for (const actionKind of handle.actionKinds) {
          await client.query(
            `
              INSERT INTO conversation_action_handles (
                handle, compiled_context_id, user_id, generation_command_id,
                action_kind, target_kind, target_id, target_version_id,
                target_claim_id, target_claim_version_id, target_qualifier_id,
                source_revision, expected_data_epoch, created_at, expires_at
              )
              VALUES ($1, $2, $3, $4, $5, $6,
                CASE WHEN $6 = 'journal' THEN $7::uuid ELSE NULL::uuid END,
                CASE WHEN $6 = 'journal' THEN $8::uuid ELSE NULL::uuid END,
                CASE WHEN $6 = 'journal' THEN NULL::uuid ELSE $9::uuid END,
                CASE WHEN $6 = 'journal' THEN NULL::uuid ELSE $8::uuid END,
                CASE WHEN $6 = 'relationship_qualifier' THEN $10::uuid ELSE NULL::uuid END,
                $11,
                (SELECT expected_data_epoch FROM generation_commands
                 WHERE generation_command_id = $4 AND user_id = $3), $12, $13)
            `,
            [
              handle.handle,
              compiledContextId,
              input.userId,
              input.generationCommandId,
              actionKind,
              handle.targetKind,
              handle.targetId,
              handle.targetVersionId,
              handle.targetClaimId ?? handle.targetId,
              handle.targetQualifierId ??
                (handle.targetKind === "relationship_qualifier"
                  ? handle.targetId
                  : null),
              handle.sourceRevision,
              input.now,
              new Date(input.now.getTime() + 30 * 60 * 1_000),
            ],
          );
        }
      }
      await client.query("COMMIT");
      return {
        ...(input.actionReferenceHandles === undefined
          ? {}
          : {
              actionReferenceHandles: input.actionReferenceHandles.map(
                ({ actionKinds, handle, targetKind }) => ({
                  actionKinds,
                  handle,
                  targetKind,
                }),
              ),
            }),
        degradedReason: input.degradedReason,
        dialogueRevision: input.dialogueRevision,
        id: asCompiledContextId(compiledContextId),
        locale: input.locale,
        referencedRevisionIds: input.referencedEvents.map(
          (event) => event.revisionId,
        ),
        sourceRevision: input.sourceRevision,
        statistics: {
          rawEventBudgetTokens:
            input.sectionBudgets.committedRawEvents,
          selectedEventCount: input.referencedEvents.length,
          totalTokens: input.totalTokens,
        },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimDispatch(input: {
    champion: ConversationTextChampion;
    compiledContextId: CompiledContextId;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    now: Date;
  }): Promise<ProviderEgressClaim> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await client.query<DispatchRow>(
        `
          SELECT
            owner.status AS user_status,
            owner.data_epoch,
            command.expected_data_epoch,
            command.input_revision_id,
            command.prompt_version,
            command.product_policy_version,
            command.safety_policy_version,
            command.relationship_policy_version,
            command.locale_policy_version,
            command.output_format_version,
            command.persona_contract_invariant_version,
            command.canonical_persona_version,
            command.persona_behavior_anchors_version,
            command.locale,
            command.provider,
            command.model,
            command.model_snapshot,
            command.model_config_version,
            command.provider_policy_version,
            command.consent_policy_version,
            command.freshness_policy,
            command.generation_stage,
            command.action_execution_id::text AS action_execution_id,
            command.action_execution_status,
            command.action_receipt_sequence,
            frozen_receipt.admission_status AS action_receipt_admission,
            frozen_receipt.disposition AS action_receipt_disposition,
            context.compiler_version AS context_compiler_version,
            context.dialogue_revision AS context_dialogue_revision,
            context.policy_versions AS context_policy_versions,
            context.rolling_summary AS context_rolling_summary,
            context.sections AS context_sections,
            context.source_revision AS context_source_revision,
            context.total_tokens AS context_total_tokens,
            context.content_hmac AS context_content_hmac,
            context.integrity_algorithm AS context_integrity_algorithm,
            context.integrity_key_version AS context_integrity_key_version,
            policy.status AS provider_policy_status,
            policy.model_config_version AS provider_policy_model_config_version,
            policy.consent_policy_version AS provider_policy_consent_version,
            (
              policy.consent_policy_version IS NULL
              OR consent.status = 'active'
            ) AS consent_active,
            command.status,
            attempt.status AS attempt_status,
            session.daily_session_id AS daily_session_id,
            session.dialogue_revision AS session_dialogue_revision,
            session.source_revision AS session_source_revision,
            (
              input_event.lifecycle_status = 'active'
              AND input_event.current_revision_id = command.input_revision_id
              AND input_revision.content_purged_at IS NULL
            ) AS source_active
          FROM generation_commands command
          INNER JOIN model_run_attempts attempt
            ON attempt.generation_command_id = command.generation_command_id
            AND attempt.user_id = command.user_id
          INNER JOIN app_users owner
            ON owner.user_id = command.user_id
          INNER JOIN interaction_turns turn
            ON turn.interaction_turn_id = command.interaction_turn_id
            AND turn.user_id = command.user_id
          INNER JOIN daily_sessions session
            ON session.daily_session_id = turn.daily_session_id
            AND session.user_id = turn.user_id
          INNER JOIN compiled_contexts context
            ON context.compiled_context_id = command.compiled_context_id
            AND context.generation_command_id =
              command.generation_command_id
            AND context.user_id = command.user_id
          LEFT JOIN conversation_action_receipts frozen_receipt
            ON frozen_receipt.action_execution_id = command.action_execution_id
           AND frozen_receipt.receipt_sequence = command.action_receipt_sequence
           AND command.generation_stage = 'action_finalization'
          INNER JOIN provider_egress_policy_versions policy
            ON policy.policy_version = command.provider_policy_version
            AND policy.provider = command.provider
            AND policy.role = command.operation_type
          LEFT JOIN LATERAL (
            SELECT provider_consent.status
            FROM provider_egress_consents provider_consent
            WHERE provider_consent.user_id = command.user_id
              AND provider_consent.provider = command.provider
              AND provider_consent.role = command.operation_type
              AND provider_consent.consent_policy_version =
                policy.consent_policy_version
            FOR UPDATE
          ) consent ON TRUE
          INNER JOIN conversation_events input_event
            ON input_event.conversation_event_id = command.subject_id
            AND input_event.user_id = command.user_id
          INNER JOIN conversation_event_revisions input_revision
            ON input_revision.conversation_event_revision_id =
              command.input_revision_id
            AND input_revision.user_id = command.user_id
          WHERE command.generation_command_id = $1
            AND attempt.model_run_attempt_id = $2
            AND command.compiled_context_id = $3
          FOR UPDATE OF
            command, attempt, owner, policy, input_event, input_revision
        `,
        [
          input.generationCommandId,
          input.modelRunAttemptId,
          input.compiledContextId,
        ],
      );
      const row = result.rows[0];
      const referencesAreCurrent = row
        ? await contextReferencesAreCurrent(
            client,
            input.compiledContextId,
            input.generationCommandId,
          )
        : false;
      if (
        row &&
        (row.status !== "compiling" || row.attempt_status !== "prepared")
      ) {
        await client.query("COMMIT");
        return { outcome: "already_claimed" };
      }
      const permitted =
        row?.user_status === "active" &&
        row.data_epoch === row.expected_data_epoch &&
        row.source_active &&
        referencesAreCurrent &&
        row.freshness_policy === "source_valid:v1" &&
        row.provider_policy_status === "active" &&
        row.provider_policy_version ===
          input.champion.providerPolicyVersion &&
        row.provider_policy_model_config_version ===
          input.champion.configVersion &&
        row.provider_policy_consent_version ===
          input.champion.consentPolicyVersion &&
        row.consent_policy_version === input.champion.consentPolicyVersion &&
        row.consent_active &&
        row.provider === input.champion.provider &&
        row.model === input.champion.model &&
        row.model_snapshot === input.champion.snapshot &&
        row.model_config_version === input.champion.configVersion &&
        row.context_policy_versions.localePolicyVersion ===
          row.locale_policy_version &&
        row.context_policy_versions.outputFormatVersion ===
          row.output_format_version &&
        row.context_policy_versions.personaContractInvariantVersion ===
          row.persona_contract_invariant_version &&
        row.context_policy_versions.canonicalPersonaVersion ===
          row.canonical_persona_version &&
        row.context_policy_versions.personaBehaviorAnchorsVersion ===
          row.persona_behavior_anchors_version &&
        row.context_policy_versions.productPolicyVersion ===
          row.product_policy_version &&
        row.context_policy_versions.relationshipPolicyVersion ===
          row.relationship_policy_version &&
        row.context_policy_versions.safetyPolicyVersion ===
          row.safety_policy_version &&
        row.context_policy_versions.taskInstructionVersion ===
          row.prompt_version &&
        row.context_dialogue_revision === row.session_dialogue_revision &&
        row.context_source_revision === row.session_source_revision;

      if (!row || !permitted) {
        if (row) {
          await insertEgressDisposition(client, {
            category: "policy_blocked",
            champion: input.champion,
            expectedDataEpoch: row.expected_data_epoch,
            modelRunAttemptId: input.modelRunAttemptId,
            now: input.now,
            providerPolicyVersion: row.provider_policy_version,
            status: "blocked",
          });
        }
        await client.query("COMMIT");
        return { category: "policy_blocked", outcome: "blocked" };
      }

      await insertEgressDisposition(client, {
        category: null,
        champion: input.champion,
        expectedDataEpoch: row.expected_data_epoch,
        modelRunAttemptId: input.modelRunAttemptId,
        now: input.now,
        providerPolicyVersion: row.provider_policy_version,
        status: "dispatched",
      });
      await client.query(
        `
          UPDATE model_run_attempts
          SET status = 'running', started_at = $1
          WHERE model_run_attempt_id = $2
            AND status = 'prepared'
        `,
        [input.now, input.modelRunAttemptId],
      );
      await client.query(
        `
          UPDATE generation_commands
          SET status = 'running'
          WHERE generation_command_id = $1
            AND status = 'compiling'
        `,
        [input.generationCommandId],
      );
      await client.query(
        `
          UPDATE interaction_turns turn
          SET status = 'responding', updated_at = $1
          FROM generation_commands command
          WHERE command.generation_command_id = $2
            AND turn.interaction_turn_id = command.interaction_turn_id
            AND turn.user_id = command.user_id
            AND turn.status = 'open'
        `,
        [input.now, input.generationCommandId],
      );
      const referencedEvents = await loadContextReferencedEvents(
        client,
        input.compiledContextId,
      );
      const actionHandles = await client.query<{
        action_kind: string;
        handle: string;
        target_kind: "journal" | "memory_claim" | "relationship_qualifier";
      }>(
        `
          SELECT action_kind, handle, target_kind
          FROM conversation_action_handles
          WHERE compiled_context_id = $1
            AND generation_command_id = $2
            AND expires_at > CURRENT_TIMESTAMP
          ORDER BY handle
        `,
        [input.compiledContextId, input.generationCommandId],
      );
      await client.query("COMMIT");
      return {
        context: {
          ...(row.action_execution_id !== null &&
          row.action_receipt_sequence !== null &&
          row.action_execution_status !== null &&
          row.action_receipt_admission !== null
            ? {
                actionFinalizationReceipt:
                  await loadActionFinalizationReceiptSnapshot(client, {
                    actionExecutionId: row.action_execution_id,
                    admission: row.action_receipt_admission,
                    disposition: row.action_receipt_disposition,
                    execution: row.action_execution_status,
                    receiptSequence: row.action_receipt_sequence,
                  }),
              }
            : {}),
          ...(actionHandles.rows.length === 0
            ? {}
            : {
                actionReferenceHandles: actionHandles.rows.map((handle) => ({
                  actionKinds: [handle.action_kind],
                  handle: handle.handle,
                  targetKind: handle.target_kind,
                })),
              }),
          compilerVersion: row.context_compiler_version,
          integrity: {
            algorithm: row.context_integrity_algorithm,
            contentHmac: row.context_content_hmac,
            keyVersion: row.context_integrity_key_version,
          },
          generationStage: row.generation_stage,
          locale: row.locale,
          policyVersions: row.context_policy_versions,
          rollingSummary: row.context_rolling_summary,
          referencedEvents,
          sections: row.context_sections,
          totalTokens: Number(row.context_total_tokens),
        },
        dailySessionId: row.daily_session_id,
        model: row.model,
        outcome: "permitted",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordFirstToken(input: {
    modelRunAttemptId: ModelRunAttemptId;
    now: Date;
  }): Promise<boolean> {
    const recorded = await this.pool.query(
      `
        UPDATE model_run_attempts attempt
        SET first_token_at = COALESCE(first_token_at, $1)
        FROM generation_commands command
        WHERE attempt.model_run_attempt_id = $2
          AND attempt.status = 'running'
          AND command.generation_command_id =
            attempt.generation_command_id
          AND command.user_id = attempt.user_id
          AND command.status = 'running'
          AND command.authoritative_result_id IS NULL
          AND attempt.attempt_no = (
            SELECT MAX(latest.attempt_no)
            FROM model_run_attempts latest
            WHERE latest.generation_command_id =
              command.generation_command_id
              AND latest.user_id = command.user_id
          )
      `,
      [input.now, input.modelRunAttemptId],
    );
    return recorded.rowCount === 1;
  }

  public async recordProviderCompletion(input: {
    completion: {
      costMicros: number | null;
      finishReason: string;
      inputTokens: number | null;
      modelSnapshot: string;
      outputTokens: number | null;
      providerRequestId: string | null;
      type: "completed";
    };
    modelRunAttemptId: ModelRunAttemptId;
    now: Date;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const recorded = await client.query(
        `
          UPDATE model_run_attempts attempt
          SET
            provider_completed_at =
              COALESCE(provider_completed_at, $1),
            provider_request_id =
              COALESCE(provider_request_id, $2),
            model_snapshot = $3,
            input_tokens = $4,
            output_tokens = $5,
            cost_micros = $6,
            finish_reason = $7
          FROM generation_commands command
          WHERE attempt.model_run_attempt_id = $8
            AND attempt.status = 'running'
            AND command.generation_command_id =
              attempt.generation_command_id
            AND command.user_id = attempt.user_id
            AND command.status = 'running'
            AND command.authoritative_result_id IS NULL
            AND attempt.attempt_no = (
              SELECT MAX(latest.attempt_no)
              FROM model_run_attempts latest
              WHERE latest.generation_command_id =
                command.generation_command_id
                AND latest.user_id = command.user_id
            )
        `,
        [
          input.now,
          input.completion.providerRequestId,
          input.completion.modelSnapshot,
          input.completion.inputTokens,
          input.completion.outputTokens,
          input.completion.costMicros,
          input.completion.finishReason,
          input.modelRunAttemptId,
        ],
      );
      if (recorded.rowCount !== 1) {
        await client.query("COMMIT");
        return false;
      }
      // #295: re-check the recent-context governance fence at Provider result
      // time. If the frozen selection was revoked while the Provider was
      // streaming, the result is not accepted; the transaction also holds the
      // governance row lock until commit.
      const command = await client.query<{
        compiled_context_id: string | null;
      }>(
        `
          SELECT command.compiled_context_id
          FROM model_run_attempts attempt
          INNER JOIN generation_commands command
            ON command.generation_command_id = attempt.generation_command_id
           AND command.user_id = attempt.user_id
          WHERE attempt.model_run_attempt_id = $1
        `,
        [input.modelRunAttemptId],
      );
      const compiledContextId = command.rows[0]?.compiled_context_id;
      if (
        compiledContextId !== null &&
        compiledContextId !== undefined &&
        !(await recentContextSelectionAuthorized(
          client,
          asCompiledContextId(compiledContextId),
        ))
      ) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `
          UPDATE provider_egress_dispositions
          SET status = 'completed', completed_at = COALESCE(completed_at, $1)
          WHERE model_run_attempt_id = $2
            AND status = 'dispatched'
        `,
        [input.now, input.modelRunAttemptId],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async commitCompleteResponse(input: {
    completedAt: Date;
    generationCommandId: GenerationCommandId;
    metadata: CompleteResponseMetadata;
    modelRunAttemptId: ModelRunAttemptId;
    stopSignalProposals?: readonly CuriosityStopSignalProposal[];
    text: string;
    userId: UserId;
  }): ReturnType<ConversationResponseRepository["commitCompleteResponse"]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const locked = await client.query<{
        consent_active: boolean;
        daily_session_id: string;
        data_epoch: string;
        expected_data_epoch: string;
        freshness_policy: string;
        input_revision_id: string;
        input_text: string;
        input_sequence_no: string;
        interaction_turn_id: string;
        interaction_turn_exchange_no: string;
        locale: string;
        next_event_sequence_no: string;
        provider_policy_status: string;
        source_active: boolean;
        source_revision: string;
        user_status: string;
      }>(
        `
          SELECT
            owner.status AS user_status,
            owner.data_epoch,
            command.expected_data_epoch,
            command.input_revision_id,
            command.locale,
            command.freshness_policy,
            policy.status AS provider_policy_status,
            (
              policy.consent_policy_version IS NULL
              OR (
                policy.consent_policy_version =
                  command.consent_policy_version
                AND consent.status = 'active'
              )
            ) AS consent_active,
            turn.interaction_turn_id,
            turn.daily_session_id,
            session.next_event_sequence_no,
            session.source_revision,
            turn.continuous_exchange_no AS interaction_turn_exchange_no,
            input_event.sequence_no AS input_sequence_no,
            input_revision.canonical_text AS input_text,
            (
              input_event.lifecycle_status = 'active'
              AND input_event.current_revision_id = command.input_revision_id
              AND input_revision.content_purged_at IS NULL
            ) AS source_active
          FROM generation_commands command
          INNER JOIN model_run_attempts attempt
            ON attempt.generation_command_id = command.generation_command_id
            AND attempt.user_id = command.user_id
          INNER JOIN provider_egress_dispositions egress
            ON egress.model_run_attempt_id = attempt.model_run_attempt_id
            AND egress.user_id = attempt.user_id
            AND egress.provider_policy_version =
              command.provider_policy_version
          INNER JOIN provider_egress_policy_versions policy
            ON policy.policy_version = command.provider_policy_version
            AND policy.provider = command.provider
            AND policy.role = command.operation_type
            AND policy.model_config_version =
              command.model_config_version
          LEFT JOIN LATERAL (
            SELECT provider_consent.status
            FROM provider_egress_consents provider_consent
            WHERE provider_consent.user_id = command.user_id
              AND provider_consent.provider = command.provider
              AND provider_consent.role = command.operation_type
              AND provider_consent.consent_policy_version =
                policy.consent_policy_version
            FOR UPDATE
          ) consent ON TRUE
          INNER JOIN interaction_turns turn
            ON turn.interaction_turn_id = command.interaction_turn_id
            AND turn.user_id = command.user_id
          INNER JOIN daily_sessions session
            ON session.daily_session_id = turn.daily_session_id
            AND session.user_id = turn.user_id
          INNER JOIN app_users owner
            ON owner.user_id = command.user_id
          INNER JOIN conversation_events input_event
            ON input_event.conversation_event_id = command.subject_id
            AND input_event.user_id = command.user_id
          INNER JOIN conversation_event_revisions input_revision
            ON input_revision.conversation_event_revision_id =
              command.input_revision_id
            AND input_revision.user_id = command.user_id
          WHERE command.generation_command_id = $1
            AND command.user_id = $2
            AND command.status = 'running'
            AND command.authoritative_result_id IS NULL
            AND attempt.model_run_attempt_id = $3
            AND attempt.status = 'running'
            AND egress.status IN ('dispatched', 'completed')
            AND turn.status = 'responding'
          FOR UPDATE OF
            command, attempt, egress, policy, turn, session, owner, input_event,
            input_revision
        `,
        [
          input.generationCommandId,
          input.userId,
          input.modelRunAttemptId,
        ],
      );
      const row = locked.rows[0];
      const referencesAreCurrent = row
        ? await contextReferencesAreCurrentForCommand(
            client,
            input.generationCommandId,
          )
        : false;
      if (
        !row ||
        row.user_status !== "active" ||
        row.data_epoch !== row.expected_data_epoch ||
        !row.source_active ||
        !referencesAreCurrent ||
        row.freshness_policy !== "source_valid:v1" ||
        row.provider_policy_status !== "active" ||
        !row.consent_active
      ) {
        await client.query("ROLLBACK");
        return { outcome: "fence_rejected" };
      }

      const eventId = createUuidV7(input.completedAt);
      const revisionId = createUuidV7(input.completedAt);
      await client.query(
        `
          INSERT INTO conversation_events (
            conversation_event_id,
            user_id,
            daily_session_id,
            interaction_turn_id,
            sequence_no,
            client_event_id,
            actor,
            channel,
            event_type,
            lifecycle_status,
            generation_command_id,
            created_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, 'assistant', 'text', 'message',
            'active', $7, $8
          )
        `,
        [
          eventId,
          input.userId,
          row.daily_session_id,
          row.interaction_turn_id,
          Number(row.next_event_sequence_no),
          `assistant/${input.generationCommandId}`,
          input.generationCommandId,
          input.completedAt,
        ],
      );
      await client.query(
        `
          INSERT INTO conversation_event_revisions (
            conversation_event_revision_id,
            user_id,
            conversation_event_id,
            revision,
            locale,
            canonical_text,
            transcript_status,
            created_by,
            created_at
          )
          VALUES ($1, $2, $3, 1, $4, $5, 'final', 'provider', $6)
        `,
        [
          revisionId,
          input.userId,
          eventId,
          row.locale,
          input.text,
          input.completedAt,
        ],
      );
      await client.query(
        `
          UPDATE conversation_events
          SET current_revision_id = $1
          WHERE conversation_event_id = $2
            AND user_id = $3
            AND current_revision_id IS NULL
        `,
        [revisionId, eventId, input.userId],
      );
      await client.query(
        `
          UPDATE generation_commands
          SET
            status = 'succeeded',
            authoritative_result_id = $1,
            recovery_status = CASE
              WHEN recovery_status = 'recovering' THEN 'recovered'
              ELSE 'not_needed'
            END,
            recovery_checked_at = CASE
              WHEN recovery_status = 'recovering' THEN $2
              ELSE recovery_checked_at
            END,
            next_recovery_at = NULL,
            settled_at = $2
          WHERE generation_command_id = $3
        `,
        [revisionId, input.completedAt, input.generationCommandId],
      );
      await client.query(
        `
          UPDATE model_run_attempts
          SET
            status = 'succeeded',
            provider_request_id = $1,
            model_snapshot = $2,
            completed_at = $3,
            input_tokens = $4,
            output_tokens = $5,
            cost_micros = $6,
            finish_reason = $7,
            error_category = NULL,
            recovery_status = CASE
              WHEN retry_of_model_run_attempt_id IS NOT NULL
                OR recovery_status = 'recovering'
              THEN 'recovered'
              ELSE 'not_needed'
            END,
            recovery_claimed_at = NULL
          WHERE model_run_attempt_id = $8
        `,
        [
          input.metadata.providerRequestId,
          input.metadata.modelSnapshot,
          input.completedAt,
          input.metadata.inputTokens,
          input.metadata.outputTokens,
          input.metadata.costMicros,
          input.metadata.finishReason,
          input.modelRunAttemptId,
        ],
      );
      await client.query(
        `
          UPDATE provider_egress_dispositions
          SET status = 'completed', completed_at = $1, error_category = NULL
          WHERE model_run_attempt_id = $2
        `,
        [input.completedAt, input.modelRunAttemptId],
      );
      await client.query(
        `
          UPDATE interaction_turns
          SET status = 'settled', settled_at = $1, updated_at = $1
          WHERE interaction_turn_id = $2
            AND user_id = $3
        `,
        [input.completedAt, row.interaction_turn_id, input.userId],
      );
      await client.query(
        `
          UPDATE daily_sessions
          SET
            next_event_sequence_no = next_event_sequence_no + 1,
            dialogue_revision = dialogue_revision + 1,
            source_revision = source_revision + 1,
            last_activity_at = $1,
            updated_at = $1
          WHERE daily_session_id = $2
            AND user_id = $3
        `,
        [input.completedAt, row.daily_session_id, input.userId],
      );
      const inactivityEvaluationId = createUuidV7(input.completedAt);
      const inactivityScheduled = await client.query(
        `
          INSERT INTO continuous_exchange_inactivity_evaluations (
            inactivity_evaluation_id,
            user_id,
            daily_session_id,
            continuous_exchange_no,
            policy_version,
            expected_dialogue_revision,
            due_at,
            created_at
          )
          SELECT
            $1,
            session.user_id,
            session.daily_session_id,
            session.current_continuous_exchange_no,
            session.closure_policy_version,
            session.dialogue_revision,
            $2::timestamptz + policy.timeout_ms * INTERVAL '1 millisecond',
            $2
          FROM daily_sessions session
          INNER JOIN continuous_exchange_inactivity_policies policy
            ON policy.policy_version = session.closure_policy_version
          WHERE session.daily_session_id = $3
            AND session.user_id = $4
            AND session.activity_state = 'active'
          ON CONFLICT (
            daily_session_id,
            continuous_exchange_no,
            expected_dialogue_revision
          ) DO NOTHING
        `,
        [
          inactivityEvaluationId,
          input.completedAt,
          row.daily_session_id,
          input.userId,
        ],
      );
      if (inactivityScheduled.rowCount !== 1) {
        throw new Error(
          "The inactivity evaluation was not scheduled with the Assistant Event.",
        );
      }
      if (input.stopSignalProposals && input.stopSignalProposals.length > 0) {
        await commitCuriosityStopSignalProposalsInTransaction(client, {
          currentExchangeNo: Number(row.interaction_turn_exchange_no),
          dailySessionId: row.daily_session_id,
          generationCommandId: input.generationCommandId,
          inputSequenceNo: Number(row.input_sequence_no),
          inputUserEventRevisionId: row.input_revision_id,
          currentUserText: row.input_text,
          // The session source_revision bump above already ran in this
          // transaction; the projection version records the post-bump value.
          sourceRevision: Number(row.source_revision) + 1,
          proposals: input.stopSignalProposals,
          userId: input.userId,
          createdAt: input.completedAt,
        });
      }
      // The Safety Posture turn transition (issue #76) runs on every
      // committed response: activation on a detected signal, clean-turn
      // counting, and K-release are all deterministic code inside the same
      // atomic commit. Detector failure never aborts the response — it
      // activates nothing, holds any active posture, and raises an alert.
      await commitSafetyPostureTurnInTransaction(client, {
        createdAt: input.completedAt,
        dailySessionId: row.daily_session_id,
        detector: this.safetyPostureDetector,
        generationCommandId: input.generationCommandId,
        currentUserText: row.input_text,
        inputUserEventRevisionId: row.input_revision_id,
        locale: row.locale,
        sourceRevision: Number(row.source_revision) + 1,
        userId: input.userId,
      });
      await client.query("COMMIT");
      return {
        createdAt: input.completedAt.toISOString(),
        eventId: asConversationEventId(eventId),
        outcome: "committed",
        revisionId: asConversationEventRevisionId(revisionId),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async settleResponseFailure(input: {
    category: ProviderDispatchErrorCategory;
    generationCommandId: GenerationCommandId;
    interrupted: boolean;
    jitter: number;
    modelRunAttemptId: ModelRunAttemptId;
    settledAt: Date;
    userId: UserId;
  }): ReturnType<ConversationResponseRepository["settleResponseFailure"]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const recovery = await client.query<{
        attempt_no: number;
        authoritative_result_id: string | null;
        base_retry_delay_ms: string;
        command_status: string;
        is_latest_attempt: boolean;
        jitter_ratio: number;
        max_attempts: number;
        max_retry_delay_ms: string;
        provider_completed_at: Date | null;
      }>(
        `
          SELECT
            command.status AS command_status,
            command.authoritative_result_id,
            attempt.attempt_no,
            attempt.provider_completed_at,
            attempt.attempt_no = (
              SELECT MAX(latest.attempt_no)
              FROM model_run_attempts latest
              WHERE latest.generation_command_id =
                command.generation_command_id
                AND latest.user_id = command.user_id
            ) AS is_latest_attempt,
            policy.max_attempts,
            policy.base_retry_delay_ms,
            policy.max_retry_delay_ms,
            policy.jitter_ratio
          FROM generation_commands command
          INNER JOIN model_run_attempts attempt
            ON attempt.generation_command_id =
              command.generation_command_id
            AND attempt.user_id = command.user_id
          INNER JOIN conversation_response_recovery_policies policy
            ON policy.policy_version = command.recovery_policy_version
          WHERE command.generation_command_id = $1
            AND command.user_id = $2
            AND attempt.model_run_attempt_id = $3
          FOR UPDATE OF command, attempt
        `,
        [
          input.generationCommandId,
          input.userId,
          input.modelRunAttemptId,
        ],
      );
      const recoveryRow = recovery.rows[0];
      if (
        !recoveryRow ||
        !recoveryRow.is_latest_attempt ||
        recoveryRow.authoritative_result_id ||
        recoveryRow.command_status === "succeeded" ||
        recoveryRow.command_status === "failed" ||
        recoveryRow.command_status === "interrupted"
      ) {
        await client.query("COMMIT");
        return {
          category: input.category,
          outcome: "settled",
          status:
            recoveryRow?.command_status === "interrupted" ||
            input.interrupted
              ? "interrupted"
              : "failed",
        };
      }
      const providerCompleted = recoveryRow.provider_completed_at !== null;
      const interrupted = input.interrupted || providerCompleted;
      const retryable =
        !interrupted &&
        (input.category === "rate_limited" ||
          input.category === "timeout" ||
          input.category === "unavailable") &&
        recoveryRow.attempt_no < recoveryRow.max_attempts;
      if (retryable) {
        const exponentialDelay = Math.min(
          Number(recoveryRow.max_retry_delay_ms),
          Number(recoveryRow.base_retry_delay_ms) *
            2 ** (recoveryRow.attempt_no - 1),
        );
        const jitterMultiplier =
          1 -
          recoveryRow.jitter_ratio +
          2 * recoveryRow.jitter_ratio * input.jitter;
        const retryAt = new Date(
          input.settledAt.getTime() +
            Math.round(exponentialDelay * jitterMultiplier),
        );
        await client.query(
          `
            UPDATE generation_commands
            SET
              status = 'retry_pending',
              recovery_status = 'pending',
              recovery_checked_at = $1,
              next_recovery_at = $2,
              settled_at = NULL
            WHERE generation_command_id = $3
              AND user_id = $4
              AND authoritative_result_id IS NULL
              AND status IN ('prepared', 'compiling', 'running')
          `,
          [
            input.settledAt,
            retryAt,
            input.generationCommandId,
            input.userId,
          ],
        );
        await client.query(
          `
            UPDATE model_run_attempts
            SET
              status = 'failed',
              completed_at = $1,
              error_category = $2,
              recovery_status = 'pending',
              retry_not_before = $3,
              recovery_claimed_at = NULL
            WHERE model_run_attempt_id = $4
              AND user_id = $5
              AND status IN ('prepared', 'running', 'result_unknown')
          `,
          [
            input.settledAt,
            input.category,
            retryAt,
            input.modelRunAttemptId,
            input.userId,
          ],
        );
        await client.query(
          `
            UPDATE provider_egress_dispositions
            SET
              status = CASE
                WHEN status = 'blocked' THEN 'blocked'
                ELSE 'failed'
              END,
              completed_at = $1,
              error_category = $2
            WHERE model_run_attempt_id = $3
              AND user_id = $4
              AND status IN ('blocked', 'dispatched')
          `,
          [
            input.settledAt,
            input.category,
            input.modelRunAttemptId,
            input.userId,
          ],
        );
        await client.query(
          `
            UPDATE interaction_turns turn
            SET updated_at = $1
            FROM generation_commands command
            WHERE command.generation_command_id = $2
              AND command.user_id = $3
              AND turn.interaction_turn_id =
                command.interaction_turn_id
              AND turn.user_id = command.user_id
              AND turn.status IN ('open', 'responding')
          `,
          [input.settledAt, input.generationCommandId, input.userId],
        );
        await client.query("COMMIT");
        return { outcome: "retry_scheduled", retryAt };
      }

      const commandStatus = interrupted ? "interrupted" : "failed";
      const completionResultUnknown =
        providerCompleted &&
        (input.category === "rate_limited" ||
          input.category === "timeout" ||
          input.category === "unavailable" ||
          input.category === "unknown");
      const attemptStatus = completionResultUnknown
        ? "result_unknown"
        : commandStatus;
      const errorCategory = completionResultUnknown
        ? "unknown"
        : input.category;
      await client.query(
        `
          UPDATE generation_commands
          SET
            status = $1,
            settled_at = $2,
            recovery_status = CASE
              WHEN $1 = 'interrupted' THEN 'interrupted'
              ELSE 'terminal'
            END,
            recovery_checked_at = $2,
            next_recovery_at = NULL
          WHERE generation_command_id = $3
            AND user_id = $4
            AND authoritative_result_id IS NULL
            AND status IN ('prepared', 'compiling', 'running')
        `,
        [
          commandStatus,
          input.settledAt,
          input.generationCommandId,
          input.userId,
        ],
      );
      await client.query(
        `
          UPDATE model_run_attempts attempt
          SET
            status = $1,
            completed_at = $2,
            error_category = $3,
            recovery_status = CASE
              WHEN $1 IN ('interrupted', 'result_unknown')
                THEN 'interrupted'
              ELSE 'terminal'
            END,
            recovery_claimed_at = NULL
          FROM generation_commands command
          WHERE attempt.model_run_attempt_id = $4
            AND attempt.user_id = $5
            AND command.generation_command_id =
              attempt.generation_command_id
            AND command.user_id = attempt.user_id
            AND command.authoritative_result_id IS NULL
            AND command.status IN (
              'prepared',
              'compiling',
              'running',
              'retry_pending',
              'failed',
              'interrupted'
            )
            AND attempt.status IN ('prepared', 'running', 'result_unknown')
        `,
        [
          attemptStatus,
          input.settledAt,
          errorCategory,
          input.modelRunAttemptId,
          input.userId,
        ],
      );
      await client.query(
        `
          UPDATE provider_egress_dispositions
          SET
            status = CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'failed' END,
            completed_at = $1,
            error_category = $2
          WHERE model_run_attempt_id = $3
            AND user_id = $4
            AND status IN ('blocked', 'dispatched')
        `,
        [
          input.settledAt,
          errorCategory,
          input.modelRunAttemptId,
          input.userId,
        ],
      );
      await client.query(
        `
          UPDATE interaction_turns turn
          SET status = $1, settled_at = $2, updated_at = $2
          FROM generation_commands command
          WHERE command.generation_command_id = $3
            AND command.user_id = $4
            AND turn.interaction_turn_id = command.interaction_turn_id
            AND turn.user_id = command.user_id
            AND turn.status IN ('open', 'responding')
        `,
        [
          commandStatus,
          input.settledAt,
          input.generationCommandId,
          input.userId,
        ],
      );
      await client.query("COMMIT");
      return {
        category: errorCategory,
        outcome: "settled",
        status: commandStatus,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function settleRecoveredInterruption(
  client: PoolClient,
  input: {
    attemptStatus: "interrupted" | "result_unknown";
    category: ProviderDispatchErrorCategory;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    now: Date;
    userId: UserId;
  },
): Promise<void> {
  await client.query(
    `
      UPDATE generation_commands
      SET
        status = 'interrupted',
        recovery_status = 'interrupted',
        recovery_checked_at = $1,
        next_recovery_at = NULL,
        settled_at = $1
      WHERE generation_command_id = $2
        AND user_id = $3
        AND authoritative_result_id IS NULL
    `,
    [input.now, input.generationCommandId, input.userId],
  );
  await client.query(
    `
      UPDATE model_run_attempts
      SET
        status = $1,
        recovery_status = 'interrupted',
        recovery_claimed_at = NULL,
        completed_at = COALESCE(completed_at, $2),
        error_category = COALESCE(error_category, $3)
      WHERE model_run_attempt_id = $4
        AND user_id = $5
    `,
    [
      input.attemptStatus,
      input.now,
      input.category,
      input.modelRunAttemptId,
      input.userId,
    ],
  );
  await client.query(
    `
      UPDATE provider_egress_dispositions
      SET
        status = CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'failed' END,
        completed_at = COALESCE(completed_at, $1),
        error_category = COALESCE(error_category, $2)
      WHERE model_run_attempt_id = $3
        AND user_id = $4
        AND status IN ('blocked', 'dispatched', 'completed')
    `,
    [input.now, input.category, input.modelRunAttemptId, input.userId],
  );
  await client.query(
    `
      UPDATE interaction_turns turn
      SET status = 'interrupted', settled_at = $1, updated_at = $1
      FROM generation_commands command
      WHERE command.generation_command_id = $2
        AND command.user_id = $3
        AND turn.interaction_turn_id = command.interaction_turn_id
        AND turn.user_id = command.user_id
        AND turn.status IN ('open', 'responding')
    `,
    [input.now, input.generationCommandId, input.userId],
  );
}

async function settleRecoveredTerminal(
  client: PoolClient,
  input: {
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    now: Date;
    userId: UserId;
  },
): Promise<void> {
  await client.query(
    `
      UPDATE generation_commands
      SET
        status = 'failed',
        recovery_status = 'terminal',
        recovery_checked_at = $1,
        next_recovery_at = NULL,
        settled_at = $1
      WHERE generation_command_id = $2
        AND user_id = $3
        AND authoritative_result_id IS NULL
    `,
    [input.now, input.generationCommandId, input.userId],
  );
  await client.query(
    `
      UPDATE model_run_attempts
      SET
        status = 'failed',
        recovery_status = 'terminal',
        recovery_claimed_at = NULL,
        completed_at = COALESCE(completed_at, $1),
        error_category = COALESCE(error_category, 'timeout')
      WHERE model_run_attempt_id = $2
        AND user_id = $3
    `,
    [input.now, input.modelRunAttemptId, input.userId],
  );
  await client.query(
    `
      UPDATE provider_egress_dispositions
      SET
        status = CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'failed' END,
        completed_at = COALESCE(completed_at, $1),
        error_category = COALESCE(error_category, 'timeout')
      WHERE model_run_attempt_id = $2
        AND user_id = $3
        AND status IN ('blocked', 'dispatched')
    `,
    [input.now, input.modelRunAttemptId, input.userId],
  );
  await client.query(
    `
      UPDATE interaction_turns turn
      SET status = 'failed', settled_at = $1, updated_at = $1
      FROM generation_commands command
      WHERE command.generation_command_id = $2
        AND command.user_id = $3
        AND turn.interaction_turn_id = command.interaction_turn_id
        AND turn.user_id = command.user_id
        AND turn.status IN ('open', 'responding')
    `,
    [input.now, input.generationCommandId, input.userId],
  );
}

async function contextReferencesAreCurrent(
  client: PoolClient,
  compiledContextId: CompiledContextId,
  generationCommandId: GenerationCommandId,
): Promise<boolean> {
  const result = await client.query<{ current: boolean }>(
    `
      SELECT COALESCE(
        BOOL_AND(
          event.lifecycle_status = 'active'
          AND event.current_revision_id = ref.conversation_event_revision_id
          AND revision.content_purged_at IS NULL
          AND event.user_id = command.user_id
          -- #294: a recent-source ref is only current while it stays free of
          -- the explicit Correction / Forget associations re-read at dispatch.
          -- A control committed after compile but before egress turns the ref
          -- stale and the command fails closed through the existing
          -- policy_blocked freshness path instead of shipping old background.
          AND NOT (
            ref.section IN ('recent_conversation_context', 'history_recall_context')
            AND (
              ${controlExclusionSql({
                revisionId: "ref.conversation_event_revision_id",
                userId: "ref.user_id",
              })} IS NOT NULL
              OR (
                ref.section = 'history_recall_context'
                AND ref.actor = 'assistant'
                AND (
                  generating_command.input_revision_id IS NULL
                  OR NOT ${generatingUserRevisionIsCurrentSql({
                    generatingRevisionId: "generating_command.input_revision_id",
                    userId: "ref.user_id",
                  })}
                  OR ${controlExclusionSql({
                    revisionId: "generating_command.input_revision_id",
                    userId: "ref.user_id",
                  })} IS NOT NULL
                )
              )
            )
          )
        ),
        FALSE
      ) AS current
      FROM generation_commands command
      INNER JOIN compiled_context_revision_refs ref
        ON ref.compiled_context_id = $1
        AND ref.user_id = command.user_id
      INNER JOIN conversation_event_revisions revision
        ON revision.conversation_event_revision_id =
          ref.conversation_event_revision_id
        AND revision.user_id = ref.user_id
      INNER JOIN conversation_events event
        ON event.conversation_event_id = revision.conversation_event_id
        AND event.user_id = revision.user_id
      LEFT JOIN generation_commands generating_command
        ON generating_command.generation_command_id = event.generation_command_id
        AND generating_command.user_id = event.user_id
      WHERE command.generation_command_id = $2
      GROUP BY command.generation_command_id
    `,
    [compiledContextId, generationCommandId],
  );
  if (result.rows[0]?.current !== true) return false;
  // #295: the revision refs being current is not enough for the recent-source
  // path. When the context carries selected recent content it must also carry
  // a recognized *active* immutable governance identity; the lock is held for
  // the rest of this transaction so a concurrent disable serializes with
  // dispatch / result / commit in either ordering.
  return recentContextSelectionAuthorized(client, compiledContextId);
}

/**
 * #295 independent recent-context governance fence.
 *
 * A compiled context with at least one `recent_conversation_context` ref must
 * carry a non-null frozen governance version that still exists and is active.
 * The row is locked `FOR SHARE`; the operator disable takes the same row
 * `FOR UPDATE`, so the two orderings are serializable. A context with no
 * selected recent ref (legacy, disabled, degraded or zero-selected) passes
 * without any governance row, preserving pre-#294 replay.
 */
async function recentContextSelectionAuthorized(
  client: PoolClient,
  compiledContextId: CompiledContextId,
): Promise<boolean> {
  const frozen = await client.query<{
    has_recent: boolean;
    policy_version: string | null;
  }>(
    `
      SELECT
        EXISTS (
          SELECT 1
          FROM compiled_context_revision_refs ref
          WHERE ref.compiled_context_id = $1
            AND ref.section = 'recent_conversation_context'
        ) AS has_recent,
        (
          SELECT context.policy_versions ->> 'recentContextPolicyVersion'
          FROM compiled_contexts context
          WHERE context.compiled_context_id = $1
        ) AS policy_version
    `,
    [compiledContextId],
  );
  const row = frozen.rows[0];
  if (!row || row.has_recent !== true) return true;
  // Selected recent content without a recognized frozen identity is
  // unauthorized, never grandfathered.
  if (row.policy_version === null || row.policy_version === undefined) {
    return false;
  }
  const active = await client.query(
    `
      SELECT 1
      FROM recent_context_policies
      WHERE policy_version = $1
        AND status = 'active'
      FOR SHARE
    `,
    [row.policy_version],
  );
  return (active.rowCount ?? 0) === 1;
}

function mapRecentContextPolicy(
  row:
    | {
        budget_tokens: number;
        compiler_version: string;
        max_candidate_bytes: number;
        max_candidate_rows: number;
        max_single_event_tokens: number;
        policy_version: string;
        read_timeout_ms: number;
        selection_policy_version: string;
        selector_policy_version: string;
      }
    | undefined,
): ContextSourceRecentContextPolicy | null {
  if (!row) return null;
  return {
    budgetTokens: Number(row.budget_tokens),
    compilerVersion: row.compiler_version,
    maxCandidateBytes: Number(row.max_candidate_bytes),
    maxCandidateRows: Number(row.max_candidate_rows),
    maxSingleEventTokens: Number(row.max_single_event_tokens),
    policyVersion: row.policy_version,
    readTimeoutMs: Number(row.read_timeout_ms),
    selectionPolicyVersion: row.selection_policy_version,
    selectorPolicyVersion: row.selector_policy_version,
  };
}

async function contextReferencesAreCurrentForCommand(
  client: PoolClient,
  generationCommandId: GenerationCommandId,
): Promise<boolean> {
  const result = await client.query<{ compiled_context_id: string | null }>(
    `
      SELECT compiled_context_id
      FROM generation_commands
      WHERE generation_command_id = $1
    `,
    [generationCommandId],
  );
  const contextId = result.rows[0]?.compiled_context_id;
  return contextId
    ? contextReferencesAreCurrent(
        client,
        asCompiledContextId(contextId),
        generationCommandId,
      )
    : false;
}

/**
 * Deterministically commit model stop-signal proposals inside the same
 * serializable transaction as the Complete Assistant Response (issue #74).
 * The evidence envelope is derived from the locked rows here — never from the
 * model — and semantic rejections (no preceding question, duplicates,
 * capacity) leave no row at all.
 */
async function commitCuriosityStopSignalProposalsInTransaction(
  client: PoolClient,
  input: {
    createdAt: Date;
    currentExchangeNo: number;
    dailySessionId: string;
    generationCommandId: GenerationCommandId;
    inputSequenceNo: number;
    inputUserEventRevisionId: string;
    currentUserText: string;
    proposals: readonly CuriosityStopSignalProposal[];
    sourceRevision: number;
    userId: UserId;
  },
): Promise<void> {
  const previous = await client.query<{
    content: CuriosityStopSignalContent | null;
    version_no: string;
  }>(
    `
      SELECT version.content, version.version_no
      FROM current_curiosity_stop_signals current
      INNER JOIN curiosity_stop_signals version
        ON version.curiosity_stop_signal_id = current.curiosity_stop_signal_id
        AND version.user_id = current.user_id
        AND version.daily_session_id = current.daily_session_id
        AND version.source_revision = current.source_revision
        AND version.version_no = current.version_no
      WHERE current.daily_session_id = $1
        AND current.user_id = $2
      FOR UPDATE OF current, version
    `,
    [input.dailySessionId, input.userId],
  );
  const previousRow = previous.rows[0];
  // The projection degrades silently, never aborts the Complete Assistant
  // Response: a corrupt or unreadable prior version resets to empty (no
  // suppression carried), and the conversation continues (SPEC #70 safety /
  // DialogueState degrade discipline). The content was validated at write time
  // and constrained by the DB CHECK, so this is a defensive degrade path.
  let previousContent = EMPTY_CURIOSITY_STOP_SIGNAL_CONTENT;
  if (previousRow?.content !== undefined && previousRow.content !== null) {
    try {
      validateCuriosityStopSignalContent(previousRow.content);
      previousContent = previousRow.content;
    } catch {
      previousContent = EMPTY_CURIOSITY_STOP_SIGNAL_CONTENT;
    }
  }

  const question = await client.query<{
    canonical_text: string;
    revision_id: string;
  }>(
    `
      SELECT
        revision.conversation_event_revision_id AS revision_id,
        revision.canonical_text
      FROM conversation_events event
      INNER JOIN conversation_event_revisions revision
        ON revision.conversation_event_revision_id = event.current_revision_id
        AND revision.user_id = event.user_id
      WHERE event.daily_session_id = $1
        AND event.user_id = $2
        AND event.actor = 'assistant'
        AND event.sequence_no < $3
        AND event.lifecycle_status = 'active'
        AND EXISTS (
          SELECT 1 FROM generation_commands command
          WHERE command.generation_command_id = event.generation_command_id
            AND command.user_id = event.user_id
            AND command.status = 'succeeded'
            AND command.authoritative_result_id = event.current_revision_id
        )
      ORDER BY event.sequence_no DESC
      LIMIT 1
    `,
    [input.dailySessionId, input.userId, input.inputSequenceNo],
  );
  const questionRow = question.rows[0];
  const precedingAssistantQuestion = questionRow
    ? {
        containsQuestion:
          countFollowUpQuestions(questionRow.canonical_text) > 0,
        revisionId: asConversationEventRevisionId(questionRow.revision_id),
      }
    : null;

  const applied = applyCuriosityStopSignalProposals({
    content: previousContent,
    currentExchangeNo: input.currentExchangeNo,
    currentUserEventRevisionId: asConversationEventRevisionId(
      input.inputUserEventRevisionId,
    ),
    currentUserText: input.currentUserText,
    precedingAssistantQuestion,
    proposals: input.proposals,
  });
  if (!applied.committedAny) return;
  validateCuriosityStopSignalContent(applied.content);

  const versionNo = previousRow ? Number(previousRow.version_no) + 1 : 1;
  const projectionId = createUuidV7(input.createdAt);
  await client.query(
    `
      INSERT INTO curiosity_stop_signals (
        curiosity_stop_signal_id,
        user_id,
        daily_session_id,
        version_no,
        source_revision,
        policy_version,
        content,
        committed_generation_command_id,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
    `,
    [
      projectionId,
      input.userId,
      input.dailySessionId,
      versionNo,
      input.sourceRevision,
      CURIOSITY_STOP_SIGNAL_POLICY_VERSION,
      JSON.stringify(applied.content),
      input.generationCommandId,
      input.createdAt,
    ],
  );
  await client.query(
    `
      INSERT INTO current_curiosity_stop_signals (
        daily_session_id,
        curiosity_stop_signal_id,
        user_id,
        source_revision,
        version_no,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (daily_session_id) DO UPDATE SET
        curiosity_stop_signal_id = EXCLUDED.curiosity_stop_signal_id,
        user_id = EXCLUDED.user_id,
        source_revision = EXCLUDED.source_revision,
        version_no = EXCLUDED.version_no,
        updated_at = EXCLUDED.updated_at
    `,
    [
      input.dailySessionId,
      projectionId,
      input.userId,
      input.sourceRevision,
      versionNo,
      input.createdAt,
    ],
  );
}

/**
 * Read the current stop-signal projection for Context compilation. A missing
 * or structurally invalid projection degrades silently to null — the
 * conversation continues; a projection newer than the frozen compile source
 * is never used (same staleness discipline as DialogueState).
 */
async function loadCuriosityStopSignalForContext(
  client: PoolClient,
  input: {
    dailySessionId: string;
    sourceRevision: number;
  },
): Promise<CurrentCuriosityStopSignal | null> {
  const result = await client.query<{
    curiosity_stop_signal_id: string;
    content: CuriosityStopSignalContent;
    policy_version: string;
    source_revision: string;
    version_no: string;
  }>(
    `
      SELECT
        version.curiosity_stop_signal_id,
        version.content,
        version.policy_version,
        version.source_revision,
        version.version_no
      FROM current_curiosity_stop_signals current
      INNER JOIN curiosity_stop_signals version
        ON version.curiosity_stop_signal_id = current.curiosity_stop_signal_id
        AND version.user_id = current.user_id
        AND version.daily_session_id = current.daily_session_id
        AND version.source_revision = current.source_revision
        AND version.version_no = current.version_no
      WHERE current.daily_session_id = $1
    `,
    [input.dailySessionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (Number(row.source_revision) > input.sourceRevision) return null;
  try {
    validateCuriosityStopSignalContent(row.content);
  } catch {
    return null;
  }
  return {
    content: row.content,
    id: row.curiosity_stop_signal_id,
    policyVersion: row.policy_version,
    sourceRevision: Number(row.source_revision),
    versionNo: Number(row.version_no),
  };
}

/**
 * Apply the deterministic Safety Posture turn transition inside the Complete
 * Assistant Response transaction (issue #76, ADR-0112). A SAVEPOINT keeps a
 * posture-step failure from aborting the response itself: a failed detector
 * activates no new posture, any active posture is held untouched, and an
 * alert row is raised. The same holds for an unreadable previous projection.
 */
async function commitSafetyPostureTurnInTransaction(
  client: PoolClient,
  input: {
    createdAt: Date;
    currentUserText: string;
    dailySessionId: string;
    detector: SafetyPostureDetector;
    generationCommandId: GenerationCommandId;
    inputUserEventRevisionId: string;
    locale: string;
    sourceRevision: number;
    userId: UserId;
  },
): Promise<void> {
  await client.query("SAVEPOINT safety_posture_step");
  try {
    const previous = await client.query<{
      content: SafetyPostureContent | null;
      version_no: string;
    }>(
      `
        SELECT version.content, version.version_no
        FROM current_safety_postures current
        INNER JOIN safety_postures version
          ON version.safety_posture_id = current.safety_posture_id
          AND version.user_id = current.user_id
          AND version.daily_session_id = current.daily_session_id
          AND version.source_revision = current.source_revision
          AND version.version_no = current.version_no
        WHERE current.daily_session_id = $1
          AND current.user_id = $2
        FOR UPDATE OF current, version
      `,
      [input.dailySessionId, input.userId],
    );
    const previousRow = previous.rows[0];
    let previousContent: SafetyPostureContent | null = null;
    if (previousRow?.content !== undefined && previousRow.content !== null) {
      try {
        validateSafetyPostureContent(previousRow.content);
        previousContent = previousRow.content;
      } catch {
        // An unreadable prior projection must not reset an active posture:
        // hold the pointer as-is, change nothing, and raise an alert.
        await client.query("ROLLBACK TO SAVEPOINT safety_posture_step");
        await insertSafetyPostureAlert(client, {
          createdAt: input.createdAt,
          dailySessionId: input.dailySessionId,
          generationCommandId: input.generationCommandId,
          reason: "invalid_previous_projection",
          userId: input.userId,
        });
        return;
      }
    }

    let detected: ReturnType<SafetyPostureDetector>;
    try {
      detected = input.detector({
        locale: input.locale,
        text: input.currentUserText,
      });
    } catch {
      // A failed detector activates nothing and holds any active posture;
      // the turn-local prompt-layer Minimum High-Risk Response remains the
      // fallback path (ADR-0112).
      await client.query("ROLLBACK TO SAVEPOINT safety_posture_step");
      await insertSafetyPostureAlert(client, {
        createdAt: input.createdAt,
        dailySessionId: input.dailySessionId,
        generationCommandId: input.generationCommandId,
        reason: "detector_failure",
        userId: input.userId,
      });
      return;
    }

    const applied = applySafetyPostureTurn({
      cleanTurnsToRelease: SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE,
      content: previousContent,
      currentUserEventRevisionId: asConversationEventRevisionId(
        input.inputUserEventRevisionId,
      ),
      detected,
    });
    if (!applied) {
      await client.query("RELEASE SAVEPOINT safety_posture_step");
      return;
    }
    validateSafetyPostureContent(applied);

    const versionNo = previousRow ? Number(previousRow.version_no) + 1 : 1;
    const postureId = createUuidV7(input.createdAt);
    await client.query(
      `
        INSERT INTO safety_postures (
          safety_posture_id,
          user_id,
          daily_session_id,
          version_no,
          source_revision,
          policy_version,
          content,
          committed_generation_command_id,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
      `,
      [
        postureId,
        input.userId,
        input.dailySessionId,
        versionNo,
        input.sourceRevision,
        SAFETY_POSTURE_POLICY_VERSION,
        JSON.stringify(applied),
        input.generationCommandId,
        input.createdAt,
      ],
    );
    await client.query(
      `
        INSERT INTO current_safety_postures (
          daily_session_id,
          safety_posture_id,
          user_id,
          source_revision,
          version_no,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (daily_session_id) DO UPDATE SET
          safety_posture_id = EXCLUDED.safety_posture_id,
          user_id = EXCLUDED.user_id,
          source_revision = EXCLUDED.source_revision,
          version_no = EXCLUDED.version_no,
          updated_at = EXCLUDED.updated_at
      `,
      [
        input.dailySessionId,
        postureId,
        input.userId,
        input.sourceRevision,
        versionNo,
        input.createdAt,
      ],
    );
    await client.query("RELEASE SAVEPOINT safety_posture_step");
  } catch {
    // The transition (or its writes) failed after earlier steps: undo only
    // the posture work, never the Assistant Response commit, and hold
    // whatever posture state the session already had.
    await client.query("ROLLBACK TO SAVEPOINT safety_posture_step");
    await insertSafetyPostureAlert(client, {
      createdAt: input.createdAt,
      dailySessionId: input.dailySessionId,
      generationCommandId: input.generationCommandId,
      reason: "commit_failure",
      userId: input.userId,
    });
  }
}

async function insertSafetyPostureAlert(
  client: PoolClient,
  input: {
    createdAt: Date;
    dailySessionId: string;
    generationCommandId: GenerationCommandId;
    reason: "detector_failure" | "invalid_previous_projection" | "commit_failure";
    userId: UserId;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO safety_posture_alerts (
        safety_posture_alert_id,
        user_id,
        daily_session_id,
        generation_command_id,
        policy_version,
        reason,
        occurred_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      createUuidV7(input.createdAt),
      input.userId,
      input.dailySessionId,
      input.generationCommandId,
      SAFETY_POSTURE_POLICY_VERSION,
      input.reason,
      input.createdAt,
    ],
  );
}

/**
 * Read the current Safety Posture projection for Context compilation. The
 * posture is keyed by Daily Session, so it survives Continuous Exchange
 * boundaries within the day and a next-day session simply has no row. A
 * missing projection degrades silently to null (the prompt-layer Minimum
 * High-Risk Response remains the per-turn fallback), a projection newer than
 * the frozen compile source is never used, and structurally invalid content
 * never reaches compilation.
 */
async function loadSafetyPostureForContext(
  client: PoolClient,
  input: {
    dailySessionId: string;
    sourceRevision: number;
  },
): Promise<CurrentSafetyPosture | null> {
  const result = await client.query<{
    safety_posture_id: string;
    content: SafetyPostureContent;
    policy_version: string;
    source_revision: string;
    version_no: string;
  }>(
    `
      SELECT
        version.safety_posture_id,
        version.content,
        version.policy_version,
        version.source_revision,
        version.version_no
      FROM current_safety_postures current
      INNER JOIN safety_postures version
        ON version.safety_posture_id = current.safety_posture_id
        AND version.user_id = current.user_id
        AND version.daily_session_id = current.daily_session_id
        AND version.source_revision = current.source_revision
        AND version.version_no = current.version_no
      WHERE current.daily_session_id = $1
    `,
    [input.dailySessionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (Number(row.source_revision) > input.sourceRevision) return null;
  try {
    validateSafetyPostureContent(row.content);
  } catch {
    return null;
  }
  return {
    content: row.content,
    id: row.safety_posture_id,
    policyVersion: row.policy_version,
    sourceRevision: Number(row.source_revision),
    versionNo: Number(row.version_no),
  };
}

async function loadContextReferencedEvents(
  client: PoolClient,
  compiledContextId: CompiledContextId,
): Promise<readonly CompiledContextReferencedEvent[]> {
  const result = await client.query<{
    actor: "user" | "assistant";
    daily_session_id: string | null;
    estimated_tokens: string;
    expressed_at: Date | null;
    locale: string;
    occurred_at: Date | null;
    revision_id: string;
    section:
      | "committed_raw_events"
      | "current_user_input"
      | "recent_conversation_context"
      | "history_recall_context";
    selection_order: string | null;
    selection_reason: string | null;
    sequence_no: string;
    text: string;
  }>(
    `
      SELECT
        ref.actor,
        ref.estimated_tokens,
        ref.sequence_no,
        ref.section,
        ref.selection_order,
        ref.daily_session_id,
        ref.expressed_at,
        ref.occurred_at,
        ref.selection_reason,
        revision.conversation_event_revision_id AS revision_id,
        revision.locale,
        revision.canonical_text AS text
      FROM compiled_context_revision_refs ref
      INNER JOIN conversation_event_revisions revision
        ON revision.conversation_event_revision_id =
          ref.conversation_event_revision_id
        AND revision.user_id = ref.user_id
      WHERE ref.compiled_context_id = $1
      ORDER BY ref.ordinal
    `,
    [compiledContextId],
  );
  return result.rows.map((row) => ({
    actor: row.actor,
    estimatedTokens: Number(row.estimated_tokens),
    locale: row.locale,
    revisionId: asConversationEventRevisionId(row.revision_id),
    section: row.section,
    selectionOrder:
      row.selection_order === null ? null : Number(row.selection_order),
    sequence: Number(row.sequence_no),
    text: row.text,
    ...(row.daily_session_id === null
      ? {}
      : { dailySessionId: asDailySessionId(row.daily_session_id) }),
    ...(row.expressed_at === null
      ? {}
      : { expressedAt: row.expressed_at.toISOString() }),
    ...(row.occurred_at === null
      ? {}
      : { occurredAt: row.occurred_at.toISOString() }),
    ...(row.selection_reason === null
      ? {}
      : { selectionReason: row.selection_reason }),
  }));
}

/**
 * Mint typed, command-scoped references for the memory targets that may be
 * acted on from this frozen Context. The IDs stay in the database-backed
 * handle row; the model only receives opaque handle strings. A Qualifier is
 * represented by its own target kind and compiler-minted ID, never by a
 * predicate or free-form selector (ADR-0096 / ADR-0118).
 */
async function loadMemoryActionReferenceTargets(
  client: PoolClient,
  userId: UserId,
  sourceRevision: number,
): Promise<ActionReferenceTarget[]> {
  const activeClaims = await client.query<{
    claim_id: string;
    version_id: string;
  }>(
    `SELECT claim.memory_claim_id::text AS claim_id,
            version.memory_claim_version_id::text AS version_id
     FROM memory_claims claim
     INNER JOIN memory_claim_versions version
       ON version.memory_claim_version_id = claim.current_version_id
      AND version.user_id = claim.user_id
     WHERE claim.user_id = $1
       AND claim.deleted_at IS NULL
       AND claim.content_purged_at IS NULL
       AND version.status = 'active'
       AND version.epistemic_status <> 'contested'
       AND version.content_purged_at IS NULL
     ORDER BY claim.memory_claim_id`,
    [userId],
  );
  const activeQualifiers = await client.query<{
    claim_id: string;
    qualifier_id: string;
    axis_id: string;
    role_side: "canonical_subject" | "counterpart";
    typed_value: unknown;
    version_id: string;
  }>(
    `SELECT claim.memory_claim_id::text AS claim_id,
            qualifier.memory_claim_version_qualifier_id::text AS qualifier_id,
            qualifier.axis_id, qualifier.role_side, qualifier.typed_value,
            version.memory_claim_version_id::text AS version_id
     FROM memory_claims claim
     INNER JOIN memory_claim_versions version
       ON version.memory_claim_version_id = claim.current_version_id
      AND version.user_id = claim.user_id
     INNER JOIN memory_claim_version_qualifiers qualifier
       ON qualifier.memory_claim_version_id = version.memory_claim_version_id
      AND qualifier.user_id = claim.user_id
       AND qualifier.content_purged_at IS NULL
     WHERE claim.user_id = $1
       AND claim.deleted_at IS NULL
       AND claim.content_purged_at IS NULL
       AND version.status = 'active'
       AND version.epistemic_status <> 'contested'
       AND version.content_purged_at IS NULL
     ORDER BY claim.memory_claim_id, qualifier.axis_id, qualifier.role_side`,
    [userId],
  );
  const fencedClaims = await client.query<{
    claim_id: string;
    version_id: string;
  }>(
    `SELECT claim.memory_claim_id::text AS claim_id,
            version.memory_claim_version_id::text AS version_id
     FROM memory_claims claim
     INNER JOIN memory_claim_versions version
       ON version.memory_claim_version_id = claim.current_version_id
      AND version.user_id = claim.user_id
     WHERE claim.user_id = $1
       AND claim.deleted_at IS NULL
       AND claim.content_purged_at IS NULL
       AND version.status = 'retracted'
       AND version.epistemic_status <> 'contested'
       AND EXISTS (
         SELECT 1
         FROM memory_forget_requests fence
         WHERE fence.user_id = claim.user_id
           AND fence.target_claim_id = claim.memory_claim_id
           AND fence.target_scope = 'whole_claim'
           AND fence.status = 'applied'
           AND NOT EXISTS (
             SELECT 1
             FROM memory_forget_reversals reversal
             WHERE reversal.user_id = fence.user_id
               AND reversal.memory_forget_request_id = fence.memory_forget_request_id
               AND reversal.status = 'active'
           )
       )
     ORDER BY claim.memory_claim_id`,
    [userId],
  );
  const fencedQualifiers = await client.query<{
    claim_id: string;
    qualifier_id: string;
    axis_id: string;
    role_side: "canonical_subject" | "counterpart";
    typed_value: unknown;
    version_id: string;
  }>(
    `SELECT request.target_claim_id::text AS claim_id,
            qualifier.memory_claim_version_qualifier_id::text AS qualifier_id,
            qualifier.axis_id, qualifier.role_side, qualifier.typed_value,
            claim.current_version_id::text AS version_id
     FROM memory_forget_requests request
     INNER JOIN memory_claims claim
       ON claim.memory_claim_id = request.target_claim_id
       AND claim.user_id = request.user_id
     INNER JOIN memory_claim_versions current_version
       ON current_version.memory_claim_version_id = claim.current_version_id
      AND current_version.user_id = claim.user_id
     INNER JOIN memory_claim_version_qualifiers qualifier
       ON qualifier.memory_claim_version_qualifier_id = request.target_qualifier_id
      AND qualifier.user_id = request.user_id
     WHERE request.user_id = $1
       AND request.target_scope = 'relationship_qualifier'
       AND request.status = 'applied'
       AND request.target_qualifier_id IS NOT NULL
       AND claim.deleted_at IS NULL
       AND claim.content_purged_at IS NULL
       AND current_version.epistemic_status <> 'contested'
       AND qualifier.content_purged_at IS NULL
       AND NOT EXISTS (
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
       AND NOT EXISTS (
         SELECT 1
         FROM memory_forget_reversals reversal
         WHERE reversal.user_id = request.user_id
           AND reversal.memory_forget_request_id = request.memory_forget_request_id
           AND reversal.status = 'active'
       )
     ORDER BY request.created_at DESC, request.target_claim_id,
              qualifier.axis_id, qualifier.role_side`,
    [userId],
  );

  const targets: ActionReferenceTarget[] = [];
  for (const row of activeClaims.rows) {
    targets.push({
      actionKinds: [
        "memory_correction",
        "explain_memory_source",
        "memory_forget_request",
      ],
      targetId: row.claim_id,
      targetKind: "memory_claim",
      targetVersionId: row.version_id,
      sourceRevision,
    });
  }
  for (const row of activeQualifiers.rows) {
    targets.push({
      actionKinds: ["memory_forget_request"],
      qualifierAxisId: row.axis_id,
      qualifierRoleSide: row.role_side,
      qualifierTypedValue: toActionTypedValue(row.typed_value),
      targetClaimId: row.claim_id,
      targetId: row.qualifier_id,
      targetKind: "relationship_qualifier",
      targetQualifierId: row.qualifier_id,
      targetVersionId: row.version_id,
      sourceRevision,
    });
  }
  for (const row of fencedClaims.rows) {
    targets.push({
      actionKinds: ["memory_forget_reversal"],
      targetId: row.claim_id,
      targetKind: "memory_claim",
      targetVersionId: row.version_id,
      sourceRevision,
    });
  }
  for (const row of fencedQualifiers.rows) {
    targets.push({
      actionKinds: ["memory_forget_reversal"],
      qualifierAxisId: row.axis_id,
      qualifierRoleSide: row.role_side,
      qualifierTypedValue: toActionTypedValue(row.typed_value),
      targetClaimId: row.claim_id,
      targetId: row.qualifier_id,
      targetKind: "relationship_qualifier",
      targetQualifierId: row.qualifier_id,
      targetVersionId: row.version_id,
      sourceRevision,
    });
  }
  return targets;
}

function toActionTypedValue(value: unknown): string | readonly string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : String(value);
}

async function loadCompiledContext(
  client: PoolClient,
  compiledContextId: CompiledContextId,
): ReturnType<ContextCompilerRepository["saveCompiledContext"]> {
  const context = await client.query<{
    degraded_reason: "raw_event_budget_exceeded" | null;
    dialogue_revision: string;
    locale: string;
    raw_event_budget_tokens: string;
    source_revision: string;
    total_tokens: string;
  }>(
    `
      SELECT
        degraded_reason,
        dialogue_revision,
        locale,
        source_revision,
        total_tokens,
        section_budgets ->> 'committedRawEvents' AS
          raw_event_budget_tokens
      FROM compiled_contexts
      WHERE compiled_context_id = $1
    `,
    [compiledContextId],
  );
  const row = context.rows[0];
  if (!row) {
    throw new Error("The persisted CompiledContext was not found.");
  }
  const references = await client.query<{ revision_id: string }>(
    `
      SELECT conversation_event_revision_id AS revision_id
      FROM compiled_context_revision_refs
      WHERE compiled_context_id = $1
      ORDER BY ordinal
    `,
    [compiledContextId],
  );
  const actionHandles = await client.query<{
    action_kind: string;
    handle: string;
    target_kind: "journal" | "memory_claim" | "relationship_qualifier";
  }>(
    `
      SELECT action_kind, handle, target_kind
      FROM conversation_action_handles
      WHERE compiled_context_id = $1
        AND expires_at > CURRENT_TIMESTAMP
      ORDER BY handle
    `,
    [compiledContextId],
  );
  return {
    ...(actionHandles.rows.length === 0
      ? {}
      : {
          actionReferenceHandles: actionHandles.rows.map((handle) => ({
            actionKinds: [handle.action_kind],
            handle: handle.handle,
            targetKind: handle.target_kind,
          })),
        }),
    degradedReason: row.degraded_reason,
    dialogueRevision: Number(row.dialogue_revision),
    id: compiledContextId,
    locale: row.locale,
    referencedRevisionIds: references.rows.map((reference) =>
      asConversationEventRevisionId(reference.revision_id),
    ),
    sourceRevision: Number(row.source_revision),
    statistics: {
      rawEventBudgetTokens: Number(row.raw_event_budget_tokens),
      selectedEventCount: references.rows.length,
      totalTokens: Number(row.total_tokens),
    },
  };
}

async function insertEgressDisposition(
  client: PoolClient,
  input: {
    category: ProviderDispatchErrorCategory | null;
    champion: ConversationTextChampion;
    expectedDataEpoch: string;
    modelRunAttemptId: ModelRunAttemptId;
    now: Date;
    providerPolicyVersion: string;
    status: "blocked" | "dispatched";
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO provider_egress_dispositions (
        provider_egress_disposition_id,
        user_id,
        model_run_attempt_id,
        provider,
        model,
        role,
        provider_policy_version,
        expected_data_epoch,
        status,
        error_category,
        checked_at,
        dispatched_at
      )
      SELECT
        $1,
        attempt.user_id,
        attempt.model_run_attempt_id,
        $2,
        $3,
        'conversation.text',
        $4,
        $5,
        $6::text,
        $7::text,
        $8::timestamptz,
        CASE
          WHEN $6::text = 'dispatched' THEN $8::timestamptz
          ELSE NULL
        END
      FROM model_run_attempts attempt
      WHERE attempt.model_run_attempt_id = $9
    `,
    [
      createUuidV7(input.now),
      input.champion.provider,
      input.champion.model,
      input.providerPolicyVersion,
      input.expectedDataEpoch,
      input.status,
      input.category,
      input.now,
      input.modelRunAttemptId,
    ],
  );
}

function asProviderErrorCategory(
  value: string | null,
): ProviderDispatchErrorCategory {
  switch (value) {
    case "aborted":
    case "authentication":
    case "configuration":
    case "invalid_response":
    case "policy_blocked":
    case "rate_limited":
    case "timeout":
    case "unavailable":
      return value;
    default:
      return "unknown";
  }
}
