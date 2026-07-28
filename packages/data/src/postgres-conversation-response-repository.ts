import type {
  CompleteResponseMetadata,
  ContextCompilerRepository,
  ContextSourceSnapshot,
  ConversationResponseRepository,
  ConversationTextChampion,
  ConversationTextMessage,
  ProviderDispatchErrorCategory,
  ProviderEgressClaim,
  ProviderEgressRepository,
} from "@sayhear/application";
import {
  asCompiledContextId,
  asConversationEventId,
  asConversationEventRevisionId,
  type CompiledContextId,
  type GenerationCommandId,
  type InteractionTurnId,
  type ModelRunAttemptId,
  type UserId,
} from "@sayhear/domain";
import type { Pool, PoolClient } from "pg";

import { createUuidV7 } from "./uuid-v7";

type ContextHeadRow = Readonly<{
  dialogue_revision: string;
  input_revision_id: string;
  locale: string;
  source_revision: string;
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
  data_epoch: string;
  expected_data_epoch: string;
  freshness_policy: string;
  input_revision_id: string;
  locale: string;
  locale_policy_version: string;
  model: string;
  model_config_version: string;
  model_snapshot: string;
  product_policy_version: string;
  prompt_version: string;
  provider: string;
  provider_policy_consent_version: string | null;
  provider_policy_model_config_version: string;
  provider_policy_status: string;
  provider_policy_version: string;
  relationship_policy_version: string;
  safety_policy_version: string;
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
    userId: UserId;
  }): Promise<"owner" | "shared"> {
    const claimed = await this.pool.query(
      `
        UPDATE generation_commands
        SET status = 'compiling'
        WHERE generation_command_id = $1
          AND user_id = $2
          AND status = 'prepared'
      `,
      [input.generationCommandId, input.userId],
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
        INNER JOIN model_run_attempts attempt
          ON attempt.generation_command_id = command.generation_command_id
          AND attempt.user_id = command.user_id
          AND attempt.attempt_no = 1
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
    return { outcome: row.status === "compiling" ? "running" : row.status };
  }

  public async loadContextSource(input: {
    generationCommandId: GenerationCommandId;
    interactionTurnId: InteractionTurnId;
    userId: UserId;
  }): Promise<ContextSourceSnapshot> {
    const head = await this.pool.query<ContextHeadRow>(
      `
        SELECT
          command.input_revision_id,
          command.locale,
          session.dialogue_revision,
          session.source_revision
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

    const events = await this.pool.query<ContextEventRow>(
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
        ORDER BY event.sequence_no
      `,
      [input.generationCommandId, input.userId],
    );

    return {
      dialogueRevision: Number(row.dialogue_revision),
      events: events.rows.map((event) => ({
        actor: event.actor,
        locale: event.locale,
        revisionId: asConversationEventRevisionId(event.revision_id),
        sequence: Number(event.sequence_no),
        text: event.text,
      })),
      inputRevisionId: asConversationEventRevisionId(row.input_revision_id),
      locale: row.locale,
      sourceRevision: Number(row.source_revision),
    };
  }

  public async saveCompiledContext(
    input: Parameters<ContextCompilerRepository["saveCompiledContext"]>[0],
  ) {
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
        const references = await client.query<{ revision_id: string }>(
          `
            SELECT
              conversation_event_revision_id AS revision_id
            FROM compiled_context_revision_refs
            WHERE compiled_context_id = $1
            ORDER BY ordinal
          `,
          [commandRow.compiled_context_id],
        );
        await client.query("COMMIT");
        return {
          id: asCompiledContextId(commandRow.compiled_context_id),
          referencedRevisionIds: references.rows.map((row) =>
            asConversationEventRevisionId(row.revision_id),
          ),
        };
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
            total_tokens,
            degraded_reason,
            content_hmac,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
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
          input.totalTokens,
          input.degradedReason,
          input.contentHmac,
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
              estimated_tokens
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            compiledContextId,
            input.userId,
            event.revisionId,
            ordinal,
            event.actor,
            event.estimatedTokens,
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
        id: asCompiledContextId(compiledContextId),
        referencedRevisionIds: input.referencedEvents.map(
          (event) => event.revisionId,
        ),
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
            command.locale,
            command.provider,
            command.model,
            command.model_snapshot,
            command.model_config_version,
            command.provider_policy_version,
            command.consent_policy_version,
            command.freshness_policy,
            policy.status AS provider_policy_status,
            policy.model_config_version AS provider_policy_model_config_version,
            policy.consent_policy_version AS provider_policy_consent_version,
            (
              policy.consent_policy_version IS NULL
              OR consent.status = 'active'
            ) AS consent_active,
            command.status,
            attempt.status AS attempt_status,
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
        row.model_config_version === input.champion.configVersion;

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
      const messages = await loadContextMessages(
        client,
        input.compiledContextId,
      );
      await client.query("COMMIT");
      return {
        locale: row.locale,
        localePolicyVersion: row.locale_policy_version,
        messages,
        model: row.model,
        outcome: "permitted",
        productPolicyVersion: row.product_policy_version,
        promptVersion: row.prompt_version,
        relationshipPolicyVersion: row.relationship_policy_version,
        safetyPolicyVersion: row.safety_policy_version,
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
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE model_run_attempts
        SET first_token_at = COALESCE(first_token_at, $1)
        WHERE model_run_attempt_id = $2
          AND status = 'running'
      `,
      [input.now, input.modelRunAttemptId],
    );
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
            AND egress.status = 'dispatched'
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
            error_category = NULL
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
    modelRunAttemptId: ModelRunAttemptId;
    settledAt: Date;
    userId: UserId;
  }): Promise<void> {
    const status = input.interrupted ? "interrupted" : "failed";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          UPDATE generation_commands
          SET status = $1, settled_at = $2
          WHERE generation_command_id = $3
            AND user_id = $4
            AND authoritative_result_id IS NULL
            AND status IN ('prepared', 'compiling', 'running')
        `,
        [status, input.settledAt, input.generationCommandId, input.userId],
      );
      await client.query(
        `
          UPDATE model_run_attempts
          SET
            status = $1,
            completed_at = $2,
            error_category = $3
          WHERE model_run_attempt_id = $4
            AND user_id = $5
            AND status IN ('prepared', 'running', 'result_unknown')
        `,
        [
          status,
          input.settledAt,
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
          SET status = $1, settled_at = $2, updated_at = $2
          FROM generation_commands command
          WHERE command.generation_command_id = $3
            AND command.user_id = $4
            AND turn.interaction_turn_id = command.interaction_turn_id
            AND turn.user_id = command.user_id
            AND turn.status IN ('open', 'responding')
        `,
        [status, input.settledAt, input.generationCommandId, input.userId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
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

async function loadContextMessages(
  client: PoolClient,
  compiledContextId: CompiledContextId,
): Promise<readonly ConversationTextMessage[]> {
  const result = await client.query<{
    actor: "user" | "assistant";
    revision_id: string;
    text: string;
  }>(
    `
      SELECT
        ref.actor,
        revision.conversation_event_revision_id AS revision_id,
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
    revisionId: asConversationEventRevisionId(row.revision_id),
    role: row.actor,
    text: row.text,
  }));
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
