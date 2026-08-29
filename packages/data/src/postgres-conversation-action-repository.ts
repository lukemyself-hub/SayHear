import type {
  ConversationActionGatewayContext,
  ConversationActionGatewayRepository,
  ConversationActionReceipt,
  PreparedConversationAction,
  ResolvedEntityIdentityCorrectionTarget,
  ResolvedTrustActionTarget,
} from "@sayhear/application";
import {
  ACTION_FINALIZATION_TASK_INSTRUCTION_VERSION,
  createConversationActionIdempotencyKey,
} from "@sayhear/application";
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
  current_version_status:
    | "published"
    | "stale"
    | "validation_failed"
    | "needs_review"
    | "active"
    | "review_due"
    | "dormant"
    | "superseded"
    | "retracted"
    | null;
  daily_session_id: string;
  expected_data_epoch: string;
  generation_command_id: string;
  handle: string;
  owner_id: string;
  owner_status: "active" | "deleting" | "disabled";
  source_revision: string;
  target_id: string | null;
  target_kind: "journal" | "memory_claim" | "relationship_qualifier";
  target_version_id: string | null;
  target_claim_id: string | null;
  target_claim_version_id: string | null;
  target_qualifier_id: string | null;
}>;

/**
 * The typed persistence adapter for Conversation Action admissions (ADR-0098).
 * Named for the first Definition it carried; it now owns the durable command
 * and receipt transactions for every registered binding — Journal
 * regeneration plus the synchronous Trust-Control Actions (#119). The Gateway
 * remains action-generic.
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
            COALESCE(journal.current_version_id, claim.current_version_id)::text
              AS current_version_id,
            COALESCE(current_version.status, memory_current_version.status)
              AS current_version_status,
            turn.daily_session_id::text AS daily_session_id,
            handle.expected_data_epoch,
            handle.generation_command_id,
            handle.handle,
            handle.user_id AS owner_id,
            owner.status AS owner_status,
            handle.source_revision,
            handle.target_id,
            handle.target_kind,
            handle.target_version_id,
            handle.target_claim_id,
            handle.target_claim_version_id,
            handle.target_qualifier_id
          FROM conversation_action_handles handle
          INNER JOIN generation_commands generation
            ON generation.generation_command_id = handle.generation_command_id
           AND generation.user_id = handle.user_id
          INNER JOIN interaction_turns turn
            ON turn.interaction_turn_id = generation.interaction_turn_id
           AND turn.user_id = generation.user_id
          LEFT JOIN journals journal
            ON handle.target_kind = 'journal'
           AND journal.journal_id = handle.target_id
           AND journal.user_id = handle.user_id
          LEFT JOIN memory_claims claim
            ON handle.target_kind IN ('memory_claim', 'relationship_qualifier')
           AND claim.memory_claim_id = handle.target_claim_id
           AND claim.user_id = handle.user_id
          INNER JOIN app_users owner ON owner.user_id = handle.user_id
          LEFT JOIN journal_versions current_version
            ON current_version.journal_version_id = journal.current_version_id
           AND current_version.user_id = handle.user_id
          LEFT JOIN memory_claim_versions memory_current_version
            ON memory_current_version.memory_claim_version_id = claim.current_version_id
           AND memory_current_version.user_id = claim.user_id
          LEFT JOIN memory_claim_version_qualifiers qualifier
            ON qualifier.memory_claim_version_qualifier_id = handle.target_qualifier_id
           AND qualifier.user_id = handle.user_id
           AND qualifier.content_purged_at IS NULL
          WHERE handle.handle = $1
            AND handle.user_id = $2
            AND handle.compiled_context_id = $3
            AND handle.generation_command_id = $4
            AND handle.expires_at > CURRENT_TIMESTAMP
            AND (
              (handle.target_kind = 'journal' AND journal.deleted_at IS NULL)
              OR (
                handle.target_kind IN ('memory_claim', 'relationship_qualifier')
                AND claim.deleted_at IS NULL
                AND claim.content_purged_at IS NULL
                AND (
                  handle.target_kind = 'memory_claim'
                  OR (
                    qualifier.memory_claim_version_qualifier_id IS NOT NULL
                    AND (
                      qualifier.memory_claim_version_id = claim.current_version_id
                      OR EXISTS (
                        SELECT 1
                        FROM memory_forget_requests fence
                        WHERE fence.user_id = handle.user_id
                          AND fence.target_claim_id = claim.memory_claim_id
                          AND fence.target_scope = 'relationship_qualifier'
                          AND fence.target_qualifier_id = qualifier.memory_claim_version_qualifier_id
                          AND fence.status = 'applied'
                          AND NOT EXISTS (
                            SELECT 1
                            FROM memory_forget_reversals reversal
                            WHERE reversal.user_id = fence.user_id
                              AND reversal.memory_forget_request_id = fence.memory_forget_request_id
                              AND reversal.status = 'active'
                          )
                      )
                    )
                  )
                )
              )
            )
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
      targetId: row.target_id ?? row.target_qualifier_id ?? row.target_claim_id ?? "",
      ...(row.target_claim_id === null
        ? {}
        : { targetClaimId: row.target_claim_id }),
      ...(row.target_qualifier_id === null
        ? {}
        : { targetQualifierId: row.target_qualifier_id }),
      targetKind: row.target_kind,
      targetVersionId: row.target_claim_version_id ?? row.target_version_id ?? "",
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
    dispositionDetail?: Readonly<Record<string, unknown>>;
    proposal: ConversationActionProposal | null;
    schemaVersion: string;
  }): Promise<ConversationActionReceipt> {
    const idempotencyKey = createIdempotencyKey(
      input.context,
      input.proposal,
      input.definition,
    );
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
            $8, $9, 'not_started', $10, CURRENT_TIMESTAMP)
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
        ...(input.dispositionDetail
          ? { dispositionDetail: input.dispositionDetail }
          : {}),
        execution: "not_started",
        schemaVersion: input.schemaVersion,
      });
      // #119: a Trust-Control Action clarification is a real reply — the
      // count-only multi-hit clarification and the honest zero-hit report
      // finalize from the frozen receipt like an accepted action does. The
      // execution stays `not_started` (ADR-0099); the frozen Admission
      // Receipt is what the reply may claim.
      if (input.definition?.targetContract.resolution === "admission_time_anchor") {
        const now = new Date();
        await createActionFinalizationCommand(client, {
          actionExecutionId,
          decisionCommandId: input.context.decisionCommandId,
          finalizationCommandId: createUuidV7(now),
          finalizationAttemptId: createUuidV7(now),
          now,
          receipt: {
            admission: input.admission,
            execution: receipt.execution,
            receiptSequence: receipt.receiptSequence,
          },
          userId: input.context.userId,
        });
        // Re-read so the receipt carries the frozen finalization reference
        // the response service runs the clarification reply from.
        const withFinalization = await findReceipt(
          client,
          input.context.userId,
          idempotencyKey,
        );
        if (withFinalization) {
          await client.query("COMMIT");
          return withFinalization;
        }
      }
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
    /** Anchor-mode resolved target (ADR-0118); absent for handle-mode. */
    resolvedClaim?: Readonly<{ claimId: string; claimVersionId: string }>;
    resolvedTarget?: import("@sayhear/application").ResolvedTrustActionTarget;
    /** Admission-time resolved Entity / EntityVersion target (#121). */
    resolvedIdentityTarget?: ResolvedEntityIdentityCorrectionTarget;
    prepare: () => PreparedConversationAction;
    proposal: ConversationActionProposal;
  }): Promise<ConversationActionReceipt> {
    const idempotencyKey = createIdempotencyKey(
      input.context,
      input.proposal,
      input.definition,
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await findReceipt(client, input.context.userId, idempotencyKey);
      if (existing) {
        await client.query("COMMIT");
        return existing;
      }
      if (input.resolvedIdentityTarget) {
        return await this.commitAcceptedEntityIdentityMode(client, {
          catalogVersion: input.catalogVersion,
          context: input.context,
          definition: input.definition,
          idempotencyKey,
          prepare: input.prepare,
          resolvedIdentityTarget: input.resolvedIdentityTarget,
        });
      }
      // ADR-0118 anchor mode: no handle exists to lock; the resolved claim is
      // re-verified by the handler's commit port under the claim row lock
      // inside this transaction. The typed reference enters the Execution and
      // every Receipt.
      if (input.resolvedTarget || input.resolvedClaim) {
        return await this.commitAcceptedAnchorMode(client, {
          catalogVersion: input.catalogVersion,
          context: input.context,
          definition: input.definition,
          idempotencyKey,
          prepare: input.prepare,
          resolvedTarget:
            input.resolvedTarget ?? {
              ...input.resolvedClaim!,
              claimKind: "objective",
              predicateId: "",
              targetKind: "memory_claim",
            },
        });
      }
      const handle = await selectHandle(
        client,
        input.context,
        // The Gateway has already validated the required handle argument;
        // an empty fallback simply selects nothing and fails closed below.
        readTargetHandle(input.proposal, input.definition) ?? "",
      );
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
      if (input.definition.ratePolicy.maxInFlightPerTarget !== null) {
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
      }

      const prepared = input.prepare();
      // A Handler bound to one executionMode must never produce the other's
      // prepared shape; the Catalog publication check and this runtime guard
      // together fail closed on binding drift (ADR-0098). Anchor-mode
      // proposals never reach this branch (they return above).
      if (prepared.mode === "in_transaction_anchor") {
        throw new Error(
          "Prepared Action execution mode does not match its Definition.",
        );
      }
      if (prepared.mode === "in_transaction_entity_identity") {
        throw new Error(
          "Prepared Action execution mode does not match its Definition.",
        );
      }
      if (
        (input.definition.executionMode === "synchronous") !==
        (prepared.mode === "in_transaction")
      ) {
        throw new Error(
          "Prepared Action execution mode does not match its Definition.",
        );
      }
      if (
        prepared.dailySessionId !== handle.daily_session_id ||
        prepared.sourceRevision !== Number(handle.source_revision) ||
        prepared.expectedDataEpoch !== Number(handle.expected_data_epoch)
      ) {
        throw new Error("Prepared Action target does not match its opaque handle.");
      }
      const now = new Date();
      const actionExecutionId = createUuidV7(now);
      const finalizationCommandId = createUuidV7(now);
      const finalizationAttemptId = createUuidV7(now);
      if (prepared.mode === "durable_workflow") {
        const workflowCommandId = createUuidV7(now);
        const generationCommandId = createUuidV7(now);
        const guidanceCiphertext = prepared.guidance
          ? encrypt(prepared.guidance, this.payloadKey)
          : null;
        await this.insertExecutionRow(client, {
          actionExecutionId,
          catalogVersion: input.catalogVersion,
          context: input.context,
          disposition: null,
          definition: input.definition,
          expectedDataEpoch: prepared.expectedDataEpoch,
          idempotencyKey,
          now,
          sourceRevision: prepared.sourceRevision,
          dailySessionId: prepared.dailySessionId,
          target: handle,
          executionStatus: "pending",
        });
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
      }

      // Synchronous in-transaction mode (issue #109): the domain effect, the
      // Admission Receipt, and the terminal Completion Receipt commit as one
      // atomic unit; a handler failure rolls everything back so no partial
      // effect can survive while a reply claims success (ADR-0099). The
      // execution row is written already terminal, matching the receipt
      // sequence that exists by the end of this transaction.
      await this.insertExecutionRow(client, {
        actionExecutionId,
        catalogVersion: input.catalogVersion,
        context: input.context,
        disposition: "committed_in_transaction",
        definition: input.definition,
        expectedDataEpoch: prepared.expectedDataEpoch,
        idempotencyKey,
        now,
        sourceRevision: prepared.sourceRevision,
        dailySessionId: prepared.dailySessionId,
        target: handle,
        executionStatus: "succeeded",
      });
      await insertReceipt(client, {
        actionExecutionId,
        actionKind: input.definition.actionKind,
        admission: "accepted",
        catalogVersion: input.catalogVersion,
        disposition: null,
        execution: "running",
        schemaVersion: input.definition.schemaVersion,
      });
      const committedDisposition =
        (await prepared.commit({
          actionExecutionId,
          executor: client,
          userId: input.context.userId,
        })) ?? "committed_in_transaction";
      const terminalExecution: ConversationActionReceipt["execution"] =
        committedDisposition === "reversal_precondition_failed"
          ? "failed"
          : "succeeded";
      // The handler's terminal disposition (committed / noop convergence /
      // unverifiable verdict) rides both the execution row and the terminal
      // Completion Receipt — the frozen truth the reply may claim.
      await client.query(
        `UPDATE conversation_action_executions
         SET disposition = $2, execution_status = $3
         WHERE action_execution_id = $1`,
        [actionExecutionId, committedDisposition, terminalExecution],
      );
      const terminalSequence = await insertExecutionReceipt(client, {
        actionExecutionId,
        receiptKey:
          terminalExecution === "succeeded"
            ? "execution:succeeded"
            : "execution:failed",
        execution: terminalExecution,
        disposition: committedDisposition,
      });
      await createActionFinalizationCommand(client, {
        actionExecutionId,
        decisionCommandId: input.context.decisionCommandId,
        finalizationCommandId,
        finalizationAttemptId,
        now,
        receipt: {
          admission: "accepted",
          receiptSequence: terminalSequence,
          execution: terminalExecution,
        },
        userId: input.context.userId,
      });
      const committedReceipt = await findReceipt(
        client,
        input.context.userId,
        idempotencyKey,
      );
      if (!committedReceipt) {
        throw new Error("The accepted Action Receipt was not committed.");
      }
      await client.query("COMMIT");
      return committedReceipt;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * #121 identity-correction admission: the typed Entity / EntityVersion
   * target is persisted directly on the Execution and Receipts. The handler's
   * commit port performs the EntityVersion, Claim, Journal-fence, and outbox
   * writes before this transaction is committed.
   */
  private async commitAcceptedEntityIdentityMode(
    client: PoolClient,
    input: {
      catalogVersion: string;
      context: ConversationActionGatewayContext;
      definition: ConversationActionDefinition;
      idempotencyKey: string;
      prepare: () => PreparedConversationAction;
      resolvedIdentityTarget: ResolvedEntityIdentityCorrectionTarget;
    },
  ): Promise<ConversationActionReceipt> {
    const prepared = input.prepare();
    if (prepared.mode !== "in_transaction_entity_identity") {
      throw new Error(
        "Prepared Action execution mode does not match its Definition.",
      );
    }
    const target = input.resolvedIdentityTarget;
    if (
      prepared.actionKind !== input.definition.actionKind ||
      prepared.operation !== target.operation ||
      prepared.sourceEntityId !== target.sourceEntityId ||
      prepared.sourceEntityVersionId !== target.sourceEntityVersionId ||
      prepared.targetEntityId !== target.targetEntityId ||
      prepared.targetEntityVersionId !== target.targetEntityVersionId ||
      prepared.newEntityLabel !== target.newEntityLabel ||
      (prepared.promotionEvidence?.explicitStatement ?? null) !==
        (target.promotionEvidence?.explicitStatement ?? null) ||
      (prepared.promotionEvidence?.independentRevisionCount ?? null) !==
        (target.promotionEvidence?.independentRevisionCount ?? null) ||
      prepared.expectedDataEpoch !== target.expectedDataEpoch
    ) {
      throw new Error(
        "Prepared Action target does not match the admission-time identity resolution.",
      );
    }
    const now = new Date();
    const actionExecutionId = createUuidV7(now);
    const finalizationCommandId = createUuidV7(now);
    const finalizationAttemptId = createUuidV7(now);
    const insertedExecution = await client.query<{ action_execution_id: string }>(
      `
        INSERT INTO conversation_action_executions (
          action_execution_id, user_id, decision_command_id,
          request_event_revision_id, action_kind, schema_version,
          catalog_version, target_handle, target_kind, target_id,
          target_version_id, daily_session_id, source_revision,
          expected_data_epoch, resolved_claim_id, resolved_claim_version_id,
          resolved_qualifier_id, resolved_entity_id, resolved_entity_version_id,
          resolved_related_entity_id, resolved_related_entity_version_id,
          entity_identity_operation, idempotency_key, admission_status,
          execution_status, disposition, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NULL,
          'entity_identity_correction', NULL, NULL, NULL, NULL, $8,
          NULL, NULL, NULL, $9, $10, $11, $12, $13, $14, 'accepted',
          'succeeded', 'committed_in_transaction', $15)
        ON CONFLICT (user_id, idempotency_key) DO NOTHING
        RETURNING action_execution_id
      `,
      [
        actionExecutionId,
        input.context.userId,
        input.context.decisionCommandId,
        input.context.requestEventRevisionId,
        input.definition.actionKind,
        input.definition.schemaVersion,
        input.catalogVersion,
        prepared.expectedDataEpoch,
        target.sourceEntityId,
        target.sourceEntityVersionId,
        target.targetEntityId,
        target.targetEntityVersionId,
        target.operation,
        input.idempotencyKey,
        now,
      ],
    );
    if (insertedExecution.rowCount !== 1) {
      const existing = await findReceipt(
        client,
        input.context.userId,
        input.idempotencyKey,
      );
      if (!existing) {
        throw new Error(
          "The concurrent identity Action execution did not expose a Receipt.",
        );
      }
      await client.query("COMMIT");
      return existing;
    }
    await insertReceipt(client, {
      actionExecutionId,
      actionKind: input.definition.actionKind,
      admission: "accepted",
      catalogVersion: input.catalogVersion,
      disposition: null,
      entityIdentityOperation: target.operation,
      execution: "running",
      resolvedEntityId: target.sourceEntityId,
      resolvedEntityVersionId: target.sourceEntityVersionId,
      ...(target.targetEntityId === null
        ? {}
        : { resolvedRelatedEntityId: target.targetEntityId }),
      ...(target.targetEntityVersionId === null
        ? {}
        : { resolvedRelatedEntityVersionId: target.targetEntityVersionId }),
      schemaVersion: input.definition.schemaVersion,
    });
    const committedDisposition =
      (await prepared.commit({
        actionExecutionId,
        executor: client,
        userId: input.context.userId,
      })) ?? "committed_in_transaction";
    const terminalExecution: ConversationActionReceipt["execution"] =
      committedDisposition === "reversal_precondition_failed"
        ? "failed"
        : "succeeded";
    await client.query(
      `UPDATE conversation_action_executions
       SET disposition = $2, execution_status = $3
       WHERE action_execution_id = $1`,
      [actionExecutionId, committedDisposition, terminalExecution],
    );
    const terminalSequence = await insertExecutionReceipt(client, {
      actionExecutionId,
      disposition: committedDisposition,
      entityIdentityOperation: target.operation,
      execution: terminalExecution,
      receiptKey:
        terminalExecution === "succeeded"
          ? "execution:succeeded"
          : "execution:failed",
      resolvedEntityId: target.sourceEntityId,
      resolvedEntityVersionId: target.sourceEntityVersionId,
      ...(target.targetEntityId === null
        ? {}
        : { resolvedRelatedEntityId: target.targetEntityId }),
      ...(target.targetEntityVersionId === null
        ? {}
        : { resolvedRelatedEntityVersionId: target.targetEntityVersionId }),
    });
    await createActionFinalizationCommand(client, {
      actionExecutionId,
      decisionCommandId: input.context.decisionCommandId,
      finalizationCommandId,
      finalizationAttemptId,
      now,
      receipt: {
        admission: "accepted",
        receiptSequence: terminalSequence,
        execution: terminalExecution,
      },
      userId: input.context.userId,
    });
    const committedReceipt = await findReceipt(
      client,
      input.context.userId,
      input.idempotencyKey,
    );
    if (!committedReceipt) {
      throw new Error("The accepted identity Action Receipt was not committed.");
    }
    await client.query("COMMIT");
    return committedReceipt;
  }

  /**
   * ADR-0118 anchor-mode synchronous admission: the Execution row carries the
   * resolved claim as its typed target reference (no handle exists), the
   * handler's domain writes join this transaction through the commit port,
   * and the terminal Completion Receipt freezes the handler's disposition.
   */
  private async commitAcceptedAnchorMode(
    client: PoolClient,
    input: {
      catalogVersion: string;
      context: ConversationActionGatewayContext;
      definition: ConversationActionDefinition;
      idempotencyKey: string;
      prepare: () => PreparedConversationAction;
      resolvedTarget: ResolvedTrustActionTarget;
    },
  ): Promise<ConversationActionReceipt> {
    const prepared = input.prepare();
    if (prepared.mode !== "in_transaction_anchor") {
      throw new Error(
        "Prepared Action execution mode does not match its Definition.",
      );
    }
    if (
      prepared.actionKind !== input.definition.actionKind ||
      prepared.resolvedClaimId !== input.resolvedTarget.claimId ||
      prepared.resolvedClaimVersionId !== input.resolvedTarget.claimVersionId ||
      prepared.resolvedTargetKind !== input.resolvedTarget.targetKind ||
      (prepared.resolvedQualifierId ?? null) !==
        (input.resolvedTarget.qualifierId ?? null)
    ) {
      throw new Error(
        "Prepared Action target does not match the admission-time resolution.",
      );
    }
    const now = new Date();
    const actionExecutionId = createUuidV7(now);
    const finalizationCommandId = createUuidV7(now);
    const finalizationAttemptId = createUuidV7(now);
    await client.query(
      `
        INSERT INTO conversation_action_executions (
          action_execution_id, user_id, decision_command_id,
          request_event_revision_id, action_kind, schema_version,
          catalog_version, target_handle, target_kind, target_id,
          target_version_id, daily_session_id, source_revision,
          expected_data_epoch, resolved_claim_id, resolved_claim_version_id,
          resolved_qualifier_id,
          idempotency_key, admission_status, execution_status, disposition,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, NULL,
          NULL, NULL, NULL, NULL, $9, $10, $11, $12, 'accepted', 'succeeded',
          'committed_in_transaction', $13)
      `,
      [
        actionExecutionId,
        input.context.userId,
        input.context.decisionCommandId,
        input.context.requestEventRevisionId,
        input.definition.actionKind,
        input.definition.schemaVersion,
        input.catalogVersion,
        input.resolvedTarget.targetKind,
        input.resolvedTarget.claimId,
        input.resolvedTarget.claimVersionId,
        input.resolvedTarget.qualifierId ?? null,
        input.idempotencyKey,
        now,
      ],
    );
    await insertReceipt(client, {
      actionExecutionId,
      actionKind: input.definition.actionKind,
      admission: "accepted",
      catalogVersion: input.catalogVersion,
      disposition: null,
      ...(input.resolvedTarget
        ? {
            resolvedClaimId: input.resolvedTarget.claimId,
            resolvedClaimVersionId: input.resolvedTarget.claimVersionId,
            resolvedQualifierId: input.resolvedTarget.qualifierId,
          }
        : {}),
      execution: "running",
      schemaVersion: input.definition.schemaVersion,
    });
    const committedDisposition =
      (await prepared.commit({
        actionExecutionId,
        executor: client,
        userId: input.context.userId,
      })) ?? "committed_in_transaction";
    const terminalExecution: ConversationActionReceipt["execution"] =
      committedDisposition === "reversal_precondition_failed"
        ? "failed"
        : "succeeded";
    await client.query(
      `UPDATE conversation_action_executions
       SET disposition = $2, execution_status = $3
       WHERE action_execution_id = $1`,
      [actionExecutionId, committedDisposition, terminalExecution],
    );
    const terminalSequence = await insertExecutionReceipt(client, {
      actionExecutionId,
      receiptKey:
        terminalExecution === "succeeded"
          ? "execution:succeeded"
          : "execution:failed",
      execution: terminalExecution,
      disposition: committedDisposition,
      resolvedClaimId: input.resolvedTarget.claimId,
      resolvedClaimVersionId: input.resolvedTarget.claimVersionId,
      ...(input.resolvedTarget.qualifierId === undefined
        ? {}
        : { resolvedQualifierId: input.resolvedTarget.qualifierId }),
    });
    await createActionFinalizationCommand(client, {
      actionExecutionId,
      decisionCommandId: input.context.decisionCommandId,
      finalizationCommandId,
      finalizationAttemptId,
      now,
      receipt: {
        admission: "accepted",
        receiptSequence: terminalSequence,
        execution: terminalExecution,
      },
      userId: input.context.userId,
    });
    const committedReceipt = await findReceipt(
      client,
      input.context.userId,
      input.idempotencyKey,
    );
    if (!committedReceipt) {
      throw new Error("The accepted Action Receipt was not committed.");
    }
    // The caller opened the admission transaction before dispatching here.
    // Anchor-mode admissions return through this helper, so they must close
    // that transaction explicitly before the pooled client is released.
    await client.query("COMMIT");
    return committedReceipt;
  }

  private async insertExecutionRow(
    client: PoolClient,
    input: {
      actionExecutionId: string;
      catalogVersion: string;
      context: ConversationActionGatewayContext;
      dailySessionId: string;
      definition: ConversationActionDefinition;
      disposition: string | null;
      expectedDataEpoch: number;
      executionStatus: ConversationActionReceipt["execution"];
      idempotencyKey: string;
      now: Date;
      sourceRevision: number;
      target: HandleRow;
    },
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO conversation_action_executions (
          action_execution_id, user_id, decision_command_id,
          request_event_revision_id, action_kind, schema_version,
          catalog_version, target_handle, target_kind, target_id,
          target_version_id, daily_session_id, source_revision,
          expected_data_epoch, resolved_claim_id, resolved_claim_version_id,
          resolved_qualifier_id, idempotency_key, admission_status,
          execution_status, disposition, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7,
          CASE WHEN $9 = 'journal' THEN $8 ELSE NULL END,
          $9,
          CASE WHEN $9 = 'journal' THEN $10::uuid ELSE NULL::uuid END,
          CASE WHEN $9 = 'journal' THEN $11::uuid ELSE NULL::uuid END,
          $12, $13, $14,
          CASE WHEN $9 = 'journal' THEN NULL::uuid ELSE $15::uuid END,
          CASE WHEN $9 = 'journal' THEN NULL::uuid ELSE $16::uuid END,
          CASE WHEN $9 = 'journal' THEN NULL::uuid ELSE $17::uuid END,
          $18, 'accepted', $19, $20, $21)
      `,
      [
        input.actionExecutionId,
        input.context.userId,
        input.context.decisionCommandId,
        input.context.requestEventRevisionId,
        input.definition.actionKind,
        input.definition.schemaVersion,
        input.catalogVersion,
        input.target.handle,
        input.target.target_kind,
        input.target.target_id,
        input.target.target_version_id,
        input.dailySessionId,
        input.sourceRevision,
        input.expectedDataEpoch,
        input.target.target_claim_id,
        input.target.target_claim_version_id,
        input.target.target_qualifier_id,
        input.idempotencyKey,
        input.executionStatus,
        input.disposition,
        input.now,
      ],
    );
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
       WHERE execution.admission_status IN (
               'accepted', 'clarification_required', 'unsupported'
             )
         AND (
           execution.execution_status IN ('pending', 'running')
           OR (
             -- Synchronous in-transaction outcomes are terminal at admission
             -- time; their pending finalization must still be recovered when a
             -- crash lands between the atomic commit and the visible reply.
             execution.execution_status IN ('succeeded', 'failed', 'canceled')
           )
           OR (
             -- Trust-action non-acceptances (ADR-0118) finalize their honest
             -- boundary reply from the frozen Admission Receipt while the
             -- execution stays not_started (issue #119 / #120).
             execution.admission_status IN ('clarification_required', 'unsupported')
             AND execution.execution_status = 'not_started'
           )
         )
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
    receipt: Readonly<{
      admission: ConversationActionReceipt["admission"];
      execution: ConversationActionReceipt["execution"];
      receiptSequence: number;
    }>;
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
      SELECT handle.action_kind, handle.compiled_context_id,
        COALESCE(journal.current_version_id, claim.current_version_id)::text
          AS current_version_id,
        COALESCE(current_version.status, claim_version.status)
          AS current_version_status,
        turn.daily_session_id::text AS daily_session_id,
        handle.expected_data_epoch,
        handle.generation_command_id, handle.handle,
        handle.user_id AS owner_id, owner.status AS owner_status,
        handle.source_revision, handle.target_id, handle.target_kind,
        handle.target_version_id, handle.target_claim_id,
        handle.target_claim_version_id, handle.target_qualifier_id
      FROM conversation_action_handles handle
      INNER JOIN generation_commands generation
        ON generation.generation_command_id = handle.generation_command_id
       AND generation.user_id = handle.user_id
      INNER JOIN interaction_turns turn
        ON turn.interaction_turn_id = generation.interaction_turn_id
       AND turn.user_id = generation.user_id
      LEFT JOIN journals journal
        ON handle.target_kind = 'journal'
       AND journal.journal_id = handle.target_id
       AND journal.user_id = handle.user_id
      LEFT JOIN memory_claims claim
        ON handle.target_kind IN ('memory_claim', 'relationship_qualifier')
       AND claim.memory_claim_id = handle.target_claim_id
       AND claim.user_id = handle.user_id
      INNER JOIN app_users owner ON owner.user_id = handle.user_id
      LEFT JOIN journal_versions current_version
        ON current_version.journal_version_id = journal.current_version_id
      LEFT JOIN memory_claim_versions claim_version
        ON claim_version.memory_claim_version_id = claim.current_version_id
       AND claim_version.user_id = claim.user_id
      LEFT JOIN memory_claim_version_qualifiers qualifier
        ON qualifier.memory_claim_version_qualifier_id = handle.target_qualifier_id
       AND qualifier.user_id = handle.user_id
       AND qualifier.content_purged_at IS NULL
      WHERE handle.handle = $1 AND handle.user_id = $2
        AND handle.compiled_context_id = $3
        AND handle.generation_command_id = $4
        AND handle.expires_at > CURRENT_TIMESTAMP
        AND (
          (handle.target_kind = 'journal' AND journal.deleted_at IS NULL)
          OR (
            handle.target_kind IN ('memory_claim', 'relationship_qualifier')
            AND claim.deleted_at IS NULL
            AND claim.content_purged_at IS NULL
            AND (
              handle.target_kind = 'memory_claim'
              OR (
                NOT EXISTS (
                  SELECT 1
                  FROM memory_forget_requests whole_fence
                  WHERE whole_fence.user_id = handle.user_id
                    AND whole_fence.target_claim_id = claim.memory_claim_id
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
                AND qualifier.memory_claim_version_qualifier_id IS NOT NULL
                AND (
                  qualifier.memory_claim_version_id = claim.current_version_id
                  OR (
                    handle.action_kind = 'memory_forget_reversal'
                    AND EXISTS (
                      SELECT 1
                      FROM memory_forget_requests fence
                      WHERE fence.user_id = handle.user_id
                        AND fence.target_claim_id = claim.memory_claim_id
                        AND fence.target_scope = 'relationship_qualifier'
                        AND fence.target_qualifier_id = qualifier.memory_claim_version_qualifier_id
                        AND fence.status = 'applied'
                        AND NOT EXISTS (
                          SELECT 1
                          FROM memory_forget_reversals reversal
                          WHERE reversal.user_id = fence.user_id
                            AND reversal.memory_forget_request_id = fence.memory_forget_request_id
                            AND reversal.status = 'active'
                        )
                    )
                  )
                )
              )
            )
          )
        )
      FOR UPDATE OF handle, owner
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
  if (handle.target_kind !== "journal") {
    const result = await client.query(
      `
        SELECT 1
        FROM app_users owner
        INNER JOIN memory_claims claim
          ON claim.user_id = owner.user_id
         AND claim.memory_claim_id = $3
        INNER JOIN memory_claim_versions version
          ON version.user_id = claim.user_id
         AND version.memory_claim_version_id = claim.current_version_id
        WHERE owner.user_id = $1
          AND owner.status = 'active'
          AND owner.data_epoch = $2
          AND claim.deleted_at IS NULL
            AND claim.content_purged_at IS NULL
            AND claim.current_version_id = $4
            AND (
              $5 = 'memory_claim'
              OR (
                NOT EXISTS (
                  SELECT 1
                  FROM memory_forget_requests whole_fence
                  WHERE whole_fence.user_id = claim.user_id
                    AND whole_fence.target_claim_id = claim.memory_claim_id
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
                AND EXISTS (
                  SELECT 1
                  FROM memory_claim_version_qualifiers qualifier
                  WHERE qualifier.user_id = claim.user_id
                    AND qualifier.memory_claim_version_qualifier_id = $6
                    AND qualifier.content_purged_at IS NULL
                    AND (
                      qualifier.memory_claim_version_id = claim.current_version_id
                      OR (
                        $7 = 'memory_forget_reversal'
                        AND EXISTS (
                          SELECT 1
                          FROM memory_forget_requests fence
                          WHERE fence.user_id = claim.user_id
                            AND fence.target_claim_id = claim.memory_claim_id
                            AND fence.target_scope = 'relationship_qualifier'
                            AND fence.target_qualifier_id = qualifier.memory_claim_version_qualifier_id
                            AND fence.status = 'applied'
                            AND NOT EXISTS (
                              SELECT 1
                              FROM memory_forget_reversals reversal
                              WHERE reversal.user_id = fence.user_id
                                AND reversal.memory_forget_request_id = fence.memory_forget_request_id
                                AND reversal.status = 'active'
                            )
                        )
                      )
                    )
                  )
                )
              )
        FOR UPDATE OF claim
      `,
      [
        handle.owner_id,
        expectedDataEpoch,
        handle.target_claim_id,
        handle.target_claim_version_id,
        handle.target_kind,
        handle.target_qualifier_id,
        handle.action_kind,
      ],
    );
    return result.rowCount === 1;
  }
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
      FOR UPDATE OF journal
    `,
    [handle.owner_id, expectedDataEpoch, handle.target_id, handle.target_version_id],
  );
  return result.rowCount === 1;
}

async function insertReceipt(
  client: PoolClient,
  input: Omit<ConversationActionReceipt, "actionExecutionId" | "receiptSequence"> &
    Readonly<{
      actionExecutionId: string;
      dispositionDetail?: Readonly<Record<string, unknown>>;
      resolvedClaimId?: string;
      resolvedClaimVersionId?: string;
      resolvedQualifierId?: string;
      resolvedEntityId?: string;
      resolvedEntityVersionId?: string;
      resolvedRelatedEntityId?: string;
      resolvedRelatedEntityVersionId?: string;
      entityIdentityOperation?: string;
    }>,
): Promise<ConversationActionReceipt> {
  const receiptId = createUuidV7(new Date());
  await client.query(
    `
      INSERT INTO conversation_action_receipts (
        action_receipt_id, action_execution_id, receipt_sequence,
        receipt_key, admission_status, execution_status, disposition,
        disposition_detail, resolved_claim_id, resolved_claim_version_id,
        resolved_qualifier_id, resolved_entity_id, resolved_entity_version_id,
        resolved_related_entity_id, resolved_related_entity_version_id,
        entity_identity_operation, created_at
      ) VALUES ($1, $2, 1, 'admission', $3, $4, $5, $6::jsonb, $7, $8, $9,
        $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
    `,
    [
      receiptId,
      input.actionExecutionId,
      input.admission,
      input.execution,
      input.disposition,
      input.dispositionDetail ? JSON.stringify(input.dispositionDetail) : null,
      input.resolvedClaimId ?? null,
      input.resolvedClaimVersionId ?? null,
      input.resolvedQualifierId ?? null,
      input.resolvedEntityId ?? null,
      input.resolvedEntityVersionId ?? null,
      input.resolvedRelatedEntityId ?? null,
      input.resolvedRelatedEntityVersionId ?? null,
      input.entityIdentityOperation ?? null,
    ],
  );
  return { ...input, receiptSequence: 1 };
}

/**
 * Appends an execution-sourced Receipt with the next sequence for the
 * (locked) ActionExecution and returns the sequence it committed, so callers
 * freezing later state never guess it.
 */
export async function insertExecutionReceipt(
  client: PoolClient,
  input: {
    actionExecutionId: string;
    receiptKey: string;
    execution: ConversationActionReceipt["execution"];
    disposition: string;
    resolvedClaimId?: string;
    resolvedClaimVersionId?: string;
    resolvedQualifierId?: string;
    resolvedEntityId?: string;
    resolvedEntityVersionId?: string;
    resolvedRelatedEntityId?: string;
    resolvedRelatedEntityVersionId?: string;
    entityIdentityOperation?: string;
  },
): Promise<number> {
  // The caller holds the ActionExecution lock (its own admission transaction,
  // claimRegenerationExecution, or recordRegenerationExecution), so the
  // max-sequence read and the insert cannot interleave with another allocator.
  const next = await client.query<{ next_sequence: number }>(
    `SELECT COALESCE(MAX(receipt.receipt_sequence), 0) + 1 AS next_sequence
     FROM conversation_action_receipts receipt
     WHERE receipt.action_execution_id = $1`,
    [input.actionExecutionId],
  );
  const receiptSequence = next.rows[0]!.next_sequence;
  await client.query(
    `INSERT INTO conversation_action_receipts (
       action_receipt_id, action_execution_id, receipt_sequence, receipt_key,
       admission_status, execution_status, disposition,
       resolved_claim_id, resolved_claim_version_id, resolved_qualifier_id,
       resolved_entity_id, resolved_entity_version_id,
       resolved_related_entity_id, resolved_related_entity_version_id,
       entity_identity_operation,
       created_at
     )
     SELECT $1, execution.action_execution_id,
       $6, $2,
       execution.admission_status, $3, $4, $7, $8, $9, $10, $11, $12, $13,
       $14, CURRENT_TIMESTAMP
     FROM conversation_action_executions execution
     WHERE execution.action_execution_id = $5
     ON CONFLICT (action_execution_id, receipt_key) DO NOTHING`,
    [
      createUuidV7(new Date()),
      input.receiptKey,
      input.execution,
      input.disposition,
      input.actionExecutionId,
      receiptSequence,
      input.resolvedClaimId ?? null,
      input.resolvedClaimVersionId ?? null,
      input.resolvedQualifierId ?? null,
      input.resolvedEntityId ?? null,
      input.resolvedEntityVersionId ?? null,
      input.resolvedRelatedEntityId ?? null,
      input.resolvedRelatedEntityVersionId ?? null,
      input.entityIdentityOperation ?? null,
    ],
  );
  return receiptSequence;
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
  definition?: ConversationActionDefinition | null,
): string {
  return createConversationActionIdempotencyKey(context, proposal, definition ?? null);
}

/**
 * Reads the target reference handle from the argument the Definition declares
 * as its `targetContract.handleArgument` (ADR-0096).
 */
function readTargetHandle(
  proposal: ConversationActionProposal,
  definition: ConversationActionDefinition,
): string | null {
  const value = proposal.arguments[definition.targetContract.handleArgument];
  return typeof value === "string" && value.length > 0 ? value : null;
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
