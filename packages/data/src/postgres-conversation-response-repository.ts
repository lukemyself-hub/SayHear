import type {
  CompleteResponseMetadata,
  CompiledContextReferencedEvent,
  CompiledContextSection,
  ContextCompilerRepository,
  ContextPolicyVersions,
  ContextSourceSnapshot,
  ConversationResponseRepository,
  ConversationTextChampion,
  ProviderDispatchErrorCategory,
  ProviderEgressClaim,
  ProviderEgressRepository,
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
import { loadDialogueStateForContext } from "./postgres-dialogue-state-repository";

type ContextHeadRow = Readonly<{
  activity_state: "active" | "finalized" | "quiescent";
  closure_policy_version: string;
  continuous_exchange_no: string;
  daily_session_id: string;
  dialogue_revision: string;
  input_revision_id: string;
  locale: string;
  locale_policy_version: string;
  output_format_version: string;
  persona_version: string;
  product_policy_version: string;
  prompt_version: string;
  relationship_policy_version: string;
  safety_policy_version: string;
  source_revision: string;
  expected_data_epoch: string;
}>;

type ContextEventRow = Readonly<{
  actor: "user" | "assistant";
  locale: string;
  revision_id: string;
  sequence_no: string;
  text: string;
}>;

type DispatchRow = Readonly<{
  attempt_status: string;
  consent_active: boolean;
  consent_policy_version: string | null;
  context_compiler_version: string;
  context_content_hmac: string;
  context_dialogue_revision: string;
  context_integrity_algorithm: "hmac-sha256";
  context_integrity_key_version: string;
  context_policy_versions: ContextPolicyVersions;
  context_sections: CompiledContextSection[];
  context_source_revision: string;
  context_total_tokens: string;
  data_epoch: string;
  expected_data_epoch: string;
  freshness_policy: string;
  input_revision_id: string;
  locale: string;
  locale_policy_version: string;
  model: string;
  model_config_version: string;
  model_snapshot: string;
  output_format_version: string;
  persona_version: string;
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
  public constructor(private readonly pool: Pool) {}

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
      if (!row.event_id || !row.revision_id || row.text === null) {
        throw new Error(
          "The succeeded GenerationCommand has no authoritative response.",
        );
      }
      return {
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
            command.persona_version,
            command.product_policy_version,
            command.prompt_version,
            command.relationship_policy_version,
            command.safety_policy_version,
            session.daily_session_id,
            session.activity_state,
            session.closure_policy_version,
            session.current_continuous_exchange_no AS continuous_exchange_no,
            session.dialogue_revision,
            session.source_revision
            , command.expected_data_epoch
          FROM generation_commands command
          INNER JOIN interaction_turns turn
            ON turn.interaction_turn_id = command.interaction_turn_id
            AND turn.user_id = command.user_id
          INNER JOIN daily_sessions session
            ON session.daily_session_id = turn.daily_session_id
            AND session.user_id = turn.user_id
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
            event.sequence_no,
            revision.conversation_event_revision_id AS revision_id,
            revision.locale,
            revision.canonical_text AS text
          FROM generation_commands command
          INNER JOIN interaction_turns turn
            ON turn.interaction_turn_id = command.interaction_turn_id
            AND turn.user_id = command.user_id
          INNER JOIN conversation_events input_event
            ON input_event.conversation_event_id = command.subject_id
            AND input_event.user_id = command.user_id
          INNER JOIN conversation_events event
            ON event.daily_session_id = turn.daily_session_id
            AND event.user_id = turn.user_id
          INNER JOIN conversation_event_revisions revision
            ON revision.conversation_event_revision_id = event.current_revision_id
            AND revision.user_id = event.user_id
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

      await client.query("COMMIT");
      return {
        dailySession: {
          activityState: row.activity_state,
          closurePolicyVersion: row.closure_policy_version,
          continuousExchangeNo: Number(row.continuous_exchange_no),
          id: asDailySessionId(row.daily_session_id),
        },
        dialogueRevision: Number(row.dialogue_revision),
        dialogueState: dialogueState.dialogueState,
        dialogueStateFailure: dialogueState.failure,
        events: events.rows.map((event) => ({
          actor: event.actor,
          locale: event.locale,
          revisionId: asConversationEventRevisionId(event.revision_id),
          sequence: Number(event.sequence_no),
          text: event.text,
        })),
        inputRevisionId: asConversationEventRevisionId(row.input_revision_id),
        locale: row.locale,
        policyVersions: {
          localePolicyVersion: row.locale_policy_version,
          outputFormatVersion: row.output_format_version,
          personaVersion: row.persona_version,
          productPolicyVersion: row.product_policy_version,
          relationshipPolicyVersion: row.relationship_policy_version,
          safetyPolicyVersion: row.safety_policy_version,
          taskInstructionVersion: row.prompt_version,
        },
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
            sections,
            total_tokens,
            degraded_reason,
            content_hmac,
            integrity_algorithm,
            integrity_key_version,
            created_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
            $10::jsonb, $11, $12, $13, $14, $15, $16
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
          JSON.stringify(input.sections),
          input.totalTokens,
          input.degradedReason,
          input.integrity.contentHmac,
          input.integrity.algorithm,
          input.integrity.keyVersion,
          input.now,
        ],
      );
      for (const [ordinal, event] of input.referencedEvents.entries()) {
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
              selection_order
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
      await client.query("COMMIT");
      return {
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
            command.persona_version,
            command.locale,
            command.provider,
            command.model,
            command.model_snapshot,
            command.model_config_version,
            command.provider_policy_version,
            command.consent_policy_version,
            command.freshness_policy,
            context.compiler_version AS context_compiler_version,
            context.dialogue_revision AS context_dialogue_revision,
            context.policy_versions AS context_policy_versions,
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
        row.context_policy_versions.personaVersion ===
          row.persona_version &&
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
      await client.query("COMMIT");
      return {
        context: {
          compilerVersion: row.context_compiler_version,
          integrity: {
            algorithm: row.context_integrity_algorithm,
            contentHmac: row.context_content_hmac,
            keyVersion: row.context_integrity_key_version,
          },
          locale: row.locale,
          policyVersions: row.context_policy_versions,
          referencedEvents,
          sections: row.context_sections,
          totalTokens: Number(row.context_total_tokens),
        },
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
        interaction_turn_id: string;
        locale: string;
        next_event_sequence_no: string;
        provider_policy_status: string;
        source_active: boolean;
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
      await client.query("COMMIT");
      return {
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
      WHERE command.generation_command_id = $2
      GROUP BY command.generation_command_id
    `,
    [compiledContextId, generationCommandId],
  );
  return result.rows[0]?.current === true;
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

async function loadContextReferencedEvents(
  client: PoolClient,
  compiledContextId: CompiledContextId,
): Promise<readonly CompiledContextReferencedEvent[]> {
  const result = await client.query<{
    actor: "user" | "assistant";
    estimated_tokens: string;
    locale: string;
    revision_id: string;
    section: "committed_raw_events" | "current_user_input";
    selection_order: string | null;
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
  }));
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
  return {
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
