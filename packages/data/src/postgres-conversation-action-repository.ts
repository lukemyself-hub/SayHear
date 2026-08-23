import type {
  ConversationActionGatewayContext,
  ConversationActionGatewayRepository,
  ConversationActionReceipt,
  PreparedConversationAction,
} from "@sayhear/application";
import { ACTION_FINALIZATION_TASK_INSTRUCTION_VERSION } from "@sayhear/application";
import type { ConversationActionDefinition, ConversationActionProposal } from "@sayhear/application";
import {
  asCompiledContextId,
  asConversationEventRevisionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asUserId,
  type UserId,
} from "@sayhear/domain";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createUuidV7 } from "./uuid-v7";

type ReceiptRow = Readonly<{
  action_execution_id: string;
  action_kind: string;
  admission_status: ConversationActionReceipt["admission"];
  catalog_version: string;
  disposition: string | null;
  execution_status: ConversationActionReceipt["execution"];
  receipt_sequence: number;
  schema_version: string;
  finalization_generation_command_id: string | null;
  finalization_model_run_attempt_id: string | null;
}>;

type HandleRow = Readonly<{
  action_kind: string;
  compiled_context_id: string;
  current_version_id: string | null;
  current_version_status: "published" | "stale" | "validation_failed" | "needs_review" | null;
  daily_session_id: string;
  expected_data_epoch: string;
  generation_command_id: string;
  handle: string;
  owner_id: string;
  owner_status: "active" | "deleting" | "disabled";
  source_revision: string;
  target_id: string;
  target_kind: "journal";
  target_version_id: string;
}>;

/**
 * The typed persistence adapter for the Journal regeneration handler. The
 * Gateway remains action-generic; this adapter owns only the Journal durable
 * command and receipt transaction required by its registered binding.
 */
export class PostgresJournalRegenerationActionRepository
  implements ConversationActionGatewayRepository
{
  private readonly payloadKey: Buffer;

  public constructor(
    private readonly pool: Pool,
    encryptionSecret: string,
  ) {
    if (!encryptionSecret) {
      throw new Error("Conversation Action payload encryption secret is required.");
    }
    this.payloadKey = createHash("sha256")
      .update(`sayhear-action-payload:v1:${encryptionSecret}`)
      .digest();
  }

  public async resolveHandle(input: {
    context: ConversationActionGatewayContext;
    handle: string;
  }): Promise<import("@sayhear/application").ActionReferenceBinding | null> {
    const row = (
      await this.pool.query<HandleRow>(
        `
          SELECT
            handle.action_kind,
            handle.compiled_context_id,
            journal.current_version_id,
            current_version.status AS current_version_status,
            journal.daily_session_id,
            handle.expected_data_epoch,
            handle.generation_command_id,
            handle.handle,
            handle.user_id AS owner_id,
            owner.status AS owner_status,
            handle.source_revision,
            handle.target_id,
            handle.target_kind,
            handle.target_version_id
          FROM conversation_action_handles handle
          INNER JOIN journals journal ON journal.journal_id = handle.target_id
          INNER JOIN app_users owner ON owner.user_id = handle.user_id
          LEFT JOIN journal_versions current_version
            ON current_version.journal_version_id = journal.current_version_id
          WHERE handle.handle = $1
            AND handle.user_id = $2
            AND handle.compiled_context_id = $3
            AND handle.generation_command_id = $4
            AND handle.expires_at > CURRENT_TIMESTAMP
            AND journal.deleted_at IS NULL
        `,
        [
          input.handle,
          input.context.userId,
          input.context.compiledContextId,
          input.context.decisionCommandId,
        ],
      )
    ).rows[0];
    if (!row) return null;
    return {
      actionKinds: [row.action_kind],
      compiledContextId: asCompiledContextId(row.compiled_context_id),
      currentVersionId: row.current_version_id,
      ...(row.current_version_status === null
        ? {}
        : { currentVersionStatus: row.current_version_status }),
      dailySessionId: row.daily_session_id,
      expectedDataEpoch: Number(row.expected_data_epoch),
      generationCommandId: asGenerationCommandId(row.generation_command_id),
      handle: row.handle,
      ownerId: asUserId(row.owner_id),
      ownerStatus: row.owner_status,
      sourceRevision: Number(row.source_revision),
      targetId: row.target_id,
      targetKind: row.target_kind,
      targetVersionId: row.target_version_id,
    };
  }

  public async hasInFlightTarget(input: {
    targetId: string;
    userId: UserId;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `
        SELECT 1
        FROM conversation_action_executions
        WHERE target_id = $1
          AND user_id = $2
          AND execution_status IN ('pending', 'running')
        LIMIT 1
      `,
      [input.targetId, input.userId],
    );
    return result.rowCount === 1;
  }

  public async purgeExpiredGuidance(now = new Date()): Promise<number> {
    const result = await this.pool.query(
      `
        UPDATE journal_generation_commands command
        SET guidance_ciphertext = NULL,
            guidance_content_purged_at = COALESCE(
              guidance_content_purged_at,
              $1
            )
        WHERE command.guidance_ciphertext IS NOT NULL
          AND (
            command.guidance_expires_at <= $1
            OR EXISTS (
              SELECT 1
              FROM conversation_action_executions execution
              WHERE execution.action_execution_id = command.action_execution_id
                AND execution.execution_status IN ('succeeded', 'failed', 'canceled')
            )
          )
      `,
      [now],
    );
    return result.rowCount ?? 0;
  }

  public async findByIdempotencyKey(input: {
    context: ConversationActionGatewayContext;
    idempotencyKey: string;
  }): Promise<ConversationActionReceipt | null> {
    const result = await this.pool.query<ReceiptRow>(
      `
        SELECT
          execution.action_execution_id,
          execution.action_kind,
          receipt.admission_status,
          execution.catalog_version,
          receipt.disposition,
          receipt.execution_status,
          receipt.receipt_sequence,
          execution.schema_version,
          finalization.generation_command_id AS finalization_generation_command_id,
          finalization_attempt.model_run_attempt_id AS finalization_model_run_attempt_id
        FROM conversation_action_executions execution
        INNER JOIN conversation_action_receipts receipt
          ON receipt.action_execution_id = execution.action_execution_id
        LEFT JOIN generation_commands finalization
          ON finalization.action_execution_id = execution.action_execution_id
         AND finalization.generation_stage = 'action_finalization'
        LEFT JOIN model_run_attempts finalization_attempt
          ON finalization_attempt.generation_command_id = finalization.generation_command_id
         AND finalization_attempt.attempt_no = 1
        WHERE execution.user_id = $1
          AND execution.idempotency_key = $2
        ORDER BY receipt.receipt_sequence DESC
        LIMIT 1
      `,
      [input.context.userId, input.idempotencyKey],
    );
    const row = result.rows[0];
    return row ? mapReceipt(row) : null;
  }

  public async commitNonAccepted(input: {
    admission: Exclude<ConversationActionReceipt["admission"], "accepted">;
    catalogVersion: string;
    context: ConversationActionGatewayContext;
    definition: ConversationActionDefinition | null;
    disposition: string | null;
    proposal: ConversationActionProposal | null;
    schemaVersion: string;
  }): Promise<ConversationActionReceipt> {
    const idempotencyKey = createIdempotencyKey(input.context, input.proposal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await findReceipt(client, input.context.userId, idempotencyKey);
      if (existing) {
        await client.query("COMMIT");
        return existing;
      }
      const actionExecutionId = createUuidV7(new Date());
      await client.query(
        `
          INSERT INTO conversation_action_executions (
            action_execution_id, user_id, decision_command_id,
            request_event_revision_id, action_kind, schema_version,
            catalog_version, target_handle, target_kind, target_id,
            target_version_id, daily_session_id, source_revision,
            expected_data_epoch, idempotency_key, admission_status,
            execution_status, disposition, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            $9, $10, 'not_started', $11, CURRENT_TIMESTAMP)
        `,
        [
          actionExecutionId,
          input.context.userId,
          input.context.decisionCommandId,
          input.context.requestEventRevisionId,
          input.definition?.actionKind ?? input.proposal?.actionKind ?? "unknown",
          input.schemaVersion,
          input.catalogVersion,
          idempotencyKey,
          input.admission,
          input.disposition,
        ],
      );
      const receipt = await insertReceipt(client, {
        actionExecutionId,
        actionKind: input.definition?.actionKind ?? input.proposal?.actionKind ?? "unknown",
        admission: input.admission,
        catalogVersion: input.catalogVersion,
        disposition: input.disposition,
        execution: "not_started",
        schemaVersion: input.schemaVersion,
      });
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async commitAccepted(input: {
    catalogVersion: string;
    context: ConversationActionGatewayContext;
    definition: ConversationActionDefinition;
    prepare: () => PreparedConversationAction;
    proposal: ConversationActionProposal;
  }): Promise<ConversationActionReceipt> {
    const idempotencyKey = createIdempotencyKey(input.context, input.proposal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await findReceipt(client, input.context.userId, idempotencyKey);
      if (existing) {
        await client.query("COMMIT");
        return existing;
      }
      const handle = await selectHandle(client, input.context, input.proposal.arguments.journalHandle);
      const existingAfterHandleLock = await findReceipt(
        client,
        input.context.userId,
        idempotencyKey,
      );
      if (existingAfterHandleLock) {
        await client.query("COMMIT");
        return existingAfterHandleLock;
      }
      const validHead = await exactHeadIsValid(
        client,
        handle,
        handle ? Number(handle.expected_data_epoch) : 0,
      );
      if (!handle || !validHead) {
        const receipt = await insertNonAcceptedInTransaction(client, {
          actionExecutionId: createUuidV7(new Date()),
          context: input.context,
          catalogVersion: input.catalogVersion,
          definition: input.definition,
          disposition: "exact_head_advanced",
          idempotencyKey,
          proposal: input.proposal,
          admission: "clarification_required",
        });
        await client.query("COMMIT");
        return receipt;
      }
      const inFlight = await client.query(
        `
          SELECT 1 FROM conversation_action_executions
          WHERE user_id = $1 AND target_id = $2
            AND execution_status IN ('pending', 'running')
          LIMIT 1
        `,
        [input.context.userId, handle.target_id],
      );
      if (inFlight.rowCount === 1) {
        const receipt = await insertNonAcceptedInTransaction(client, {
          actionExecutionId: createUuidV7(new Date()),
          context: input.context,
          catalogVersion: input.catalogVersion,
          definition: input.definition,
          disposition: "rate_limited_in_flight",
          idempotencyKey,
          proposal: input.proposal,
          admission: "rejected",
        });
        await client.query("COMMIT");
        return receipt;
      }

      const prepared = input.prepare();
      if (
        prepared.dailySessionId !== handle.daily_session_id ||
        prepared.sourceRevision !== Number(handle.source_revision) ||
        prepared.expectedDataEpoch !== Number(handle.expected_data_epoch)
      ) {
        throw new Error("Prepared Action target does not match its opaque handle.");
      }
      const now = new Date();
      const actionExecutionId = createUuidV7(now);
      const workflowCommandId = createUuidV7(now);
      const generationCommandId = createUuidV7(now);
      const finalizationCommandId = createUuidV7(now);
      const finalizationAttemptId = createUuidV7(now);
      const guidanceCiphertext = prepared.guidance
        ? encrypt(prepared.guidance, this.payloadKey)
        : null;
      await client.query(
        `
          INSERT INTO conversation_action_executions (
            action_execution_id, user_id, decision_command_id,
            request_event_revision_id, action_kind, schema_version,
            catalog_version, target_handle, target_kind, target_id,
            target_version_id, daily_session_id, source_revision,
            expected_data_epoch, idempotency_key, admission_status,
            execution_status, disposition, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, 'accepted', 'pending', NULL, $16)
        `,
        [
          actionExecutionId,
          input.context.userId,
          input.context.decisionCommandId,
          input.context.requestEventRevisionId,
          input.definition.actionKind,
          input.definition.schemaVersion,
          input.catalogVersion,
          input.proposal.arguments.journalHandle,
          handle.target_kind,
          handle.target_id,
          handle.target_version_id,
          prepared.dailySessionId,
          prepared.sourceRevision,
          prepared.expectedDataEpoch,
          idempotencyKey,
          now,
        ],
      );
      const admissionReceipt = await insertReceipt(client, {
        actionExecutionId,
        actionKind: input.definition.actionKind,
        admission: "accepted",
        catalogVersion: input.catalogVersion,
        disposition: null,
        execution: "pending",
        schemaVersion: input.definition.schemaVersion,
      });
      await client.query(
        `
          INSERT INTO workflow_commands (
            workflow_command_id, command_type, subject_type, subject_id,
            source_revision, policy_version, expected_data_epoch, action_execution_id,
            status, created_at
          )
          VALUES ($1, 'journal_regeneration', 'daily_session', $2, $3, $4, $5, $6, 'created', $7)
        `,
        [
          workflowCommandId,
          prepared.dailySessionId,
          prepared.sourceRevision,
          prepared.generationPolicyVersion,
          prepared.expectedDataEpoch,
          actionExecutionId,
          now,
        ],
      );
      await client.query(
        `
          INSERT INTO journal_generation_commands (
            generation_command_id, user_id, daily_session_id, source_revision,
            generation_policy_version, expected_data_epoch, created_at,
            generation_kind, action_execution_id, guidance_ciphertext,
            guidance_expires_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'regeneration', $8, $9, $10)
        `,
        [
          generationCommandId,
          input.context.userId,
          prepared.dailySessionId,
          prepared.sourceRevision,
          prepared.generationPolicyVersion,
          prepared.expectedDataEpoch,
          now,
          actionExecutionId,
          guidanceCiphertext,
          new Date(now.getTime() + 24 * 60 * 60 * 1_000),
        ],
      );
      await client.query(
        `
          INSERT INTO outbox_events (
            outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
            aggregate_revision, event_type, status, next_attempt_at,
            attempt_count, payload, created_at
          )
          VALUES ($1, $2, 'daily_session', $3, $4,
            'journal_regeneration_requested', 'pending', $5, 0, $6::jsonb, $5)
        `,
        [
          createUuidV7(now),
          workflowCommandId,
          prepared.dailySessionId,
          prepared.sourceRevision,
          now,
          JSON.stringify({
            actionExecutionId,
            eventType: "journal_regeneration_requested",
            expectedDataEpoch: prepared.expectedDataEpoch,
            policyVersion: prepared.generationPolicyVersion,
            sourceRevision: prepared.sourceRevision,
            status: "pending",
            subjectId: prepared.dailySessionId,
            workflowCommandId,
          }),
        ],
      );
      if (guidanceCiphertext) {
        await client.query(
          `
            INSERT INTO conversation_action_payloads (
              action_execution_id, payload_schema_version, ciphertext,
              expires_at
            ) VALUES ($1, $2, $3, $4)
          `,
          [actionExecutionId, input.definition.schemaVersion, guidanceCiphertext, new Date(now.getTime() + 24 * 60 * 60 * 1_000)],
        );
        await client.query(
          "DELETE FROM conversation_action_payloads WHERE action_execution_id = $1",
          [actionExecutionId],
        );
      }
      await createActionFinalizationCommand(client, {
        actionExecutionId,
        decisionCommandId: input.context.decisionCommandId,
        finalizationCommandId,
        finalizationAttemptId,
        now,
        receipt: admissionReceipt,
        userId: input.context.userId,
      });
      const receipt = await findReceipt(client, input.context.userId, idempotencyKey);
      if (!receipt) throw new Error("The accepted Action Receipt was not committed.");
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async readRegenerationWorkflowCommand(input: {
    workflowCommandId: string;
  }): Promise<import("@sayhear/application").JournalRegenerationWorkflowCommand | null> {
    const result = await this.pool.query<{
      action_execution_id: string;
      daily_session_id: string;
      expected_data_epoch: string;
      generation_command_id: string;
      generation_policy_version: string;
      guidance_ciphertext: Buffer | null;
      model_run_attempt_id: string | null;
      source_revision: string;
      target_version_id: string;
      user_id: string;
      workflow_command_id: string;
    }>(
      `SELECT workflow.workflow_command_id, workflow.action_execution_id,
          command.user_id, command.daily_session_id, command.source_revision,
          command.generation_policy_version, command.expected_data_epoch,
          command.generation_command_id, command.guidance_ciphertext,
          execution.target_version_id,
          attempt.model_run_attempt_id
       FROM workflow_commands workflow
       INNER JOIN journal_generation_commands command
         ON command.action_execution_id = workflow.action_execution_id
        AND command.generation_kind = 'regeneration'
       INNER JOIN conversation_action_executions execution
         ON execution.action_execution_id = workflow.action_execution_id
       LEFT JOIN LATERAL (
         SELECT model_run_attempt_id
         FROM journal_model_run_attempts
         WHERE generation_command_id = command.generation_command_id
           AND role = 'journal.draft'
           AND status = 'started'
         ORDER BY created_at DESC, model_run_attempt_id DESC
         LIMIT 1
       ) attempt ON TRUE
       WHERE workflow.workflow_command_id = $1
         AND workflow.command_type = 'journal_regeneration'`,
      [input.workflowCommandId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      actionExecutionId: row.action_execution_id,
      dailySessionId: row.daily_session_id,
      expectedDataEpoch: Number(row.expected_data_epoch),
      generationCommandId: row.generation_command_id,
      generationPolicyVersion: row.generation_policy_version,
      guidance: row.guidance_ciphertext
        ? decrypt(row.guidance_ciphertext, this.payloadKey)
        : null,
      modelRunAttemptId: row.model_run_attempt_id,
      sourceRevision: Number(row.source_revision),
      targetVersionId: row.target_version_id,
      userId: asUserId(row.user_id),
      workflowCommandId: row.workflow_command_id,
    };
  }

  public async claimRegenerationExecution(input: {
    actionExecutionId: string;
  }): Promise<"execute" | "replayed"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const execution = await client.query<{
        execution_status: ConversationActionReceipt["execution"];
      }>(
        `SELECT execution_status
         FROM conversation_action_executions
         WHERE action_execution_id = $1
         FOR UPDATE`,
        [input.actionExecutionId],
      );
      const row = execution.rows[0];
      if (!row || row.execution_status === "succeeded" || row.execution_status === "failed" || row.execution_status === "canceled") {
        await client.query("COMMIT");
        return "replayed";
      }
      const published = await client.query(
        `SELECT 1
         FROM journal_generation_commands command
         INNER JOIN journal_versions version
           ON version.generation_command_id = command.generation_command_id
          AND version.status = 'published'
         WHERE command.action_execution_id = $1
         LIMIT 1`,
        [input.actionExecutionId],
      );
      if (published.rowCount) {
        await client.query(
          `UPDATE conversation_action_executions
           SET execution_status = 'succeeded', disposition = 'published_before_recovery'
           WHERE action_execution_id = $1
             AND execution_status IN ('pending', 'running')`,
          [input.actionExecutionId],
        );
        await insertExecutionReceipt(client, {
          actionExecutionId: input.actionExecutionId,
          receiptKey: "execution:succeeded",
          execution: "succeeded",
          disposition: "published_before_recovery",
        });
        await client.query("COMMIT");
        return "replayed";
      }
      await client.query(
        `UPDATE conversation_action_executions
         SET execution_status = 'running'
         WHERE action_execution_id = $1
           AND execution_status IN ('pending', 'running')`,
        [input.actionExecutionId],
      );
      await insertExecutionReceipt(client, {
        actionExecutionId: input.actionExecutionId,
        receiptKey: "execution:running",
        execution: "running",
        disposition: "workflow_running",
      });
      await client.query("COMMIT");
      return "execute";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordRegenerationExecution(input: {
    actionExecutionId: string;
    disposition: string;
    outcome: import("@sayhear/application").JournalRegenerationExecutionOutcome;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        admission_status: ConversationActionReceipt["admission"];
        execution_status: ConversationActionReceipt["execution"];
      }>(
        `SELECT admission_status, execution_status
         FROM conversation_action_executions
         WHERE action_execution_id = $1
         FOR UPDATE`,
        [input.actionExecutionId],
      );
      const row = current.rows[0];
      if (!row || row.execution_status === "succeeded" || row.execution_status === "failed" || row.execution_status === "canceled") {
        await client.query("COMMIT");
        return;
      }
      await client.query(
        `UPDATE conversation_action_executions
         SET execution_status = $2, disposition = $3
         WHERE action_execution_id = $1
           AND execution_status IN ('pending', 'running')`,
        [input.actionExecutionId, input.outcome, input.disposition],
      );
      await insertExecutionReceipt(client, {
        actionExecutionId: input.actionExecutionId,
        receiptKey: `execution:${input.outcome}`,
        execution: input.outcome,
        disposition: input.disposition,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async listPendingFinalizations(input: {
    limit: number;
  }): Promise<readonly import("@sayhear/application").ConversationActionFinalizationCommand[]> {
    const result = await this.pool.query<{
      action_execution_id: string;
      generation_command_id: string;
      interaction_turn_id: string;
      model_run_attempt_id: string;
      request_event_revision_id: string;
      receipt_admission_status: ConversationActionReceipt["admission"];
      receipt_disposition: string | null;
      receipt_execution_status: ConversationActionReceipt["execution"];
      receipt_sequence: number;
      user_id: string;
    }>(
      `SELECT execution.action_execution_id, command.generation_command_id,
          command.interaction_turn_id, attempt.model_run_attempt_id,
          command.input_revision_id AS request_event_revision_id,
          frozen_receipt.admission_status AS receipt_admission_status,
          frozen_receipt.disposition AS receipt_disposition,
          command.action_execution_status AS receipt_execution_status,
          command.action_receipt_sequence AS receipt_sequence,
          command.user_id
       FROM conversation_action_executions execution
       INNER JOIN generation_commands command
         ON command.action_execution_id = execution.action_execution_id
        AND command.generation_stage = 'action_finalization'
        AND command.status IN ('prepared', 'compiling', 'running', 'retry_pending')
       INNER JOIN conversation_action_receipts frozen_receipt
         ON frozen_receipt.action_execution_id = execution.action_execution_id
        AND frozen_receipt.receipt_sequence = command.action_receipt_sequence
       INNER JOIN model_run_attempts attempt
         ON attempt.generation_command_id = command.generation_command_id
        AND attempt.attempt_no = 1
        AND attempt.status IN ('prepared', 'running')
       WHERE execution.admission_status = 'accepted'
         AND execution.execution_status IN ('pending', 'running')
       ORDER BY command.created_at, command.generation_command_id
       LIMIT $1`,
      [input.limit],
    );
    return result.rows.map((row) => ({
      actionExecutionId: row.action_execution_id,
      generationCommandId: asGenerationCommandId(row.generation_command_id),
      interactionTurnId: asInteractionTurnId(row.interaction_turn_id),
      modelRunAttemptId: row.model_run_attempt_id,
      requestEventRevisionId: asConversationEventRevisionId(row.request_event_revision_id),
      receipt: {
        admission: row.receipt_admission_status,
        disposition: row.receipt_disposition,
        execution: row.receipt_execution_status,
        sequence: row.receipt_sequence,
      },
      userId: asUserId(row.user_id),
    }));
  }
}

/** @deprecated Use the typed Journal regeneration adapter name. */
export const PostgresConversationActionRepository =
  PostgresJournalRegenerationActionRepository;

async function createActionFinalizationCommand(
  client: PoolClient,
  input: {
    actionExecutionId: string;
    decisionCommandId: string;
    finalizationAttemptId: string;
    finalizationCommandId: string;
    now: Date;
    receipt: ConversationActionReceipt;
    userId: UserId;
  },
): Promise<void> {
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
       expected_data_epoch, generation_stage, action_execution_id,
       action_receipt_sequence, action_execution_status, status, created_at
     )
     SELECT $1, command.user_id, command.interaction_turn_id, command.operation_type,
       $2, command.subject_type, command.subject_id, command.input_revision_kind,
       command.input_revision_id, $9, command.output_format_version,
       command.persona_contract_invariant_version, command.canonical_persona_version,
       command.persona_behavior_anchors_version,
       command.product_policy_version, command.safety_policy_version,
       command.relationship_policy_version, command.locale_policy_version, command.locale,
       command.provider, command.model, command.model_snapshot, command.model_config_version,
       command.provider_policy_version, command.consent_policy_version, command.freshness_policy,
       command.harness_policy_version, command.conversation_action_catalog_version,
       command.expected_data_epoch, 'action_finalization', $3, $4, $5, 'prepared', $6
     FROM generation_commands command
     WHERE command.generation_command_id = $7
       AND command.user_id = $8
     ON CONFLICT (action_execution_id) WHERE generation_stage = 'action_finalization' DO NOTHING`,
    [
      input.finalizationCommandId,
      `action-finalization/${input.actionExecutionId}`,
      input.actionExecutionId,
      input.receipt.receiptSequence,
      input.receipt.execution,
      input.now,
      input.decisionCommandId,
      input.userId,
      // Action Finalization is its own GenerationCommand stage and pins its own
      // task instruction version instead of inheriting the Decision stage's
      // (ADR-0094, issue #73).
      ACTION_FINALIZATION_TASK_INSTRUCTION_VERSION,
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
     WHERE command.generation_command_id = $3
       AND command.user_id = $4
     ON CONFLICT (model_run_attempt_id) DO NOTHING`,
    [input.finalizationAttemptId, input.now, input.finalizationCommandId, input.userId],
  );
}

function mapReceipt(row: ReceiptRow): ConversationActionReceipt {
  return {
    actionExecutionId: row.action_execution_id,
    actionKind: row.action_kind,
    admission: row.admission_status,
    catalogVersion: row.catalog_version,
    disposition: row.disposition,
    execution: row.execution_status,
    receiptSequence: row.receipt_sequence,
    schemaVersion: row.schema_version,
    ...(row.finalization_generation_command_id && row.finalization_model_run_attempt_id
      ? {
          finalization: {
            generationCommandId: row.finalization_generation_command_id,
            modelRunAttemptId: row.finalization_model_run_attempt_id,
          },
        }
      : {}),
  };
}

async function findReceipt(
  client: PoolClient,
  userId: UserId,
  idempotencyKey: string,
): Promise<ConversationActionReceipt | null> {
  const result = await client.query<ReceiptRow>(
    `
      SELECT execution.action_execution_id, execution.action_kind,
        receipt.admission_status, execution.catalog_version,
        receipt.disposition, receipt.execution_status,
        receipt.receipt_sequence, execution.schema_version,
        finalization.generation_command_id AS finalization_generation_command_id,
        finalization_attempt.model_run_attempt_id AS finalization_model_run_attempt_id
      FROM conversation_action_executions execution
      INNER JOIN conversation_action_receipts receipt
        ON receipt.action_execution_id = execution.action_execution_id
      LEFT JOIN generation_commands finalization
        ON finalization.action_execution_id = execution.action_execution_id
       AND finalization.generation_stage = 'action_finalization'
      LEFT JOIN model_run_attempts finalization_attempt
        ON finalization_attempt.generation_command_id = finalization.generation_command_id
       AND finalization_attempt.attempt_no = 1
      WHERE execution.user_id = $1 AND execution.idempotency_key = $2
      ORDER BY receipt.receipt_sequence DESC LIMIT 1
    `,
    [userId, idempotencyKey],
  );
  return result.rows[0] ? mapReceipt(result.rows[0]) : null;
}

async function selectHandle(
  client: PoolClient,
  context: ConversationActionGatewayContext,
  handle: string,
): Promise<HandleRow | null> {
  const result = await client.query<HandleRow>(
    `
      SELECT action_kind, compiled_context_id, journal.current_version_id,
        current_version.status AS current_version_status,
        journal.daily_session_id, handle.expected_data_epoch,
        handle.generation_command_id, handle.handle, handle.user_id AS owner_id,
        owner.status AS owner_status,
        handle.source_revision, handle.target_id, handle.target_kind,
        handle.target_version_id
      FROM conversation_action_handles handle
      INNER JOIN journals journal ON journal.journal_id = handle.target_id
      INNER JOIN app_users owner ON owner.user_id = handle.user_id
      LEFT JOIN journal_versions current_version
        ON current_version.journal_version_id = journal.current_version_id
      WHERE handle.handle = $1 AND handle.user_id = $2
        AND handle.compiled_context_id = $3
        AND handle.generation_command_id = $4
        AND handle.expires_at > CURRENT_TIMESTAMP
        AND journal.deleted_at IS NULL
      FOR UPDATE OF handle, journal, owner
    `,
    [handle, context.userId, context.compiledContextId, context.decisionCommandId],
  );
  return result.rows[0] ?? null;
}

async function exactHeadIsValid(
  client: PoolClient,
  handle: HandleRow | null,
  expectedDataEpoch: number,
): Promise<boolean> {
  if (!handle) return false;
  const result = await client.query(
    `
      SELECT 1
      FROM app_users owner
      INNER JOIN journals journal ON journal.user_id = owner.user_id
      INNER JOIN journal_versions version ON version.journal_version_id = journal.current_version_id
      WHERE owner.user_id = $1 AND owner.status = 'active'
        AND owner.data_epoch = $2
        AND journal.journal_id = $3
        AND journal.current_version_id = $4
        AND version.status = 'published'
    `,
    [handle.owner_id, expectedDataEpoch, handle.target_id, handle.target_version_id],
  );
  return result.rowCount === 1;
}

async function insertReceipt(
  client: PoolClient,
  input: Omit<ConversationActionReceipt, "actionExecutionId" | "receiptSequence"> &
    Readonly<{ actionExecutionId: string }>,
): Promise<ConversationActionReceipt> {
  const receiptId = createUuidV7(new Date());
  await client.query(
    `
      INSERT INTO conversation_action_receipts (
        action_receipt_id, action_execution_id, receipt_sequence,
        receipt_key, admission_status, execution_status, disposition, created_at
      ) VALUES ($1, $2, 1, 'admission', $3, $4, $5, CURRENT_TIMESTAMP)
    `,
    [receiptId, input.actionExecutionId, input.admission, input.execution, input.disposition],
  );
  return { ...input, receiptSequence: 1 };
}

async function insertExecutionReceipt(
  client: PoolClient,
  input: {
    actionExecutionId: string;
    receiptKey: string;
    execution: ConversationActionReceipt["execution"];
    disposition: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO conversation_action_receipts (
       action_receipt_id, action_execution_id, receipt_sequence, receipt_key,
       admission_status, execution_status, disposition, created_at
     )
     SELECT $1, execution.action_execution_id,
       COALESCE(MAX(receipt.receipt_sequence), 0) + 1, $2,
       execution.admission_status, $3, $4, CURRENT_TIMESTAMP
     FROM conversation_action_executions execution
     LEFT JOIN conversation_action_receipts receipt
       ON receipt.action_execution_id = execution.action_execution_id
     WHERE execution.action_execution_id = $5
     GROUP BY execution.action_execution_id, execution.admission_status
     ON CONFLICT (action_execution_id, receipt_key) DO NOTHING`,
    [createUuidV7(new Date()), input.receiptKey, input.execution, input.disposition, input.actionExecutionId],
  );
}

async function insertNonAcceptedInTransaction(
  client: PoolClient,
  input: {
    actionExecutionId: string;
    admission: Exclude<ConversationActionReceipt["admission"], "accepted">;
    catalogVersion: string;
    context: ConversationActionGatewayContext;
    definition: ConversationActionDefinition;
    disposition: string;
    idempotencyKey: string;
    proposal: ConversationActionProposal;
  },
): Promise<ConversationActionReceipt> {
  await client.query(
    `
      INSERT INTO conversation_action_executions (
        action_execution_id, user_id, decision_command_id,
        request_event_revision_id, action_kind, schema_version,
        catalog_version, target_handle, target_kind, target_id,
        target_version_id, daily_session_id, source_revision,
        expected_data_epoch, idempotency_key, admission_status,
        execution_status, disposition, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, $8, $9, 'not_started', $10, CURRENT_TIMESTAMP)
    `,
    [
      input.actionExecutionId,
      input.context.userId,
      input.context.decisionCommandId,
      input.context.requestEventRevisionId,
      input.definition.actionKind,
      input.definition.schemaVersion,
      input.catalogVersion,
      input.idempotencyKey,
      input.admission,
      input.disposition,
    ],
  );
  return insertReceipt(client, {
    actionExecutionId: input.actionExecutionId,
    actionKind: input.definition.actionKind,
    admission: input.admission,
    catalogVersion: input.catalogVersion,
    disposition: input.disposition,
    execution: "not_started",
    schemaVersion: input.definition.schemaVersion,
  });
}

function createIdempotencyKey(
  context: ConversationActionGatewayContext,
  proposal: ConversationActionProposal | null,
): string {
  return [
    context.decisionCommandId,
    context.requestEventRevisionId,
    proposal?.actionKind ?? "unsupported",
    proposal?.arguments.journalHandle ?? "none",
  ].join(":");
}

function encrypt(value: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(value: Buffer, key: Buffer): string {
  const iv = value.subarray(0, 12);
  const authTag = value.subarray(12, 28);
  const ciphertext = value.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
