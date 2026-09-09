import type {
  AdmittedModelRoleCommand,
  ModelRoleCommandRepository,
  ModelRoleConfigurationSnapshot,
  PersistModelRoleAdmission,
  PersistModelRoleAttemptResult,
  RecordedModelRoleAttempt,
} from "@sayhear/application";
import {
  asGenerationCommandId,
  asModelRunAttemptId,
  asUserId,
  asWorkflowCommandId,
  type GenerationCommandId,
  type ModelRunAttemptId,
  type UserId,
} from "@sayhear/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { createUuidV7 } from "./uuid-v7";

export class ModelRoleAdmissionRejectedError extends Error {
  public constructor(public readonly reason: "owner" | "epoch" | "rollout") {
    super(`1A.3b model role admission rejected: ${reason}.`);
    this.name = "ModelRoleAdmissionRejectedError";
  }
}

type CommandRow = Readonly<{
  generation_command_id: string;
  user_id: string;
  model_role: string;
  model_config_version: string;
  provider_policy_version: string;
  rollout_pin: string;
  intent_key: string;
  source_revision: string | number;
  expected_data_epoch: string | number;
  status: string;
  attempt_id: string | null;
  attempt_no: number | null;
  attempt_status: string | null;
  provider: string;
  model: string;
  model_snapshot: string;
  prompt_version: string;
  schema_version: string;
  role_policy_version: string;
  freshness_policy: string;
  parameter_snapshot: unknown;
  fallback_mode: string;
}>;

type ActiveRolloutRow = Readonly<{
  role: string;
  config_version: string;
  provider_policy_version: string;
  enabled: boolean;
  definition_role_policy_version: string;
  definition_freshness_policy: string;
  definition_tools_mode: string;
  definition_max_technical_retries: string | number;
  definition_max_semantic_repairs: string | number;
  config_provider: string;
  config_model: string;
  config_model_snapshot: string;
  config_prompt_version: string;
  config_schema_version: string;
  config_role_policy_version: string;
  config_freshness_policy: string;
  config_fallback_mode: string;
  config_parameter_snapshot: unknown;
  config_max_technical_retries: string | number;
  config_max_semantic_repairs: string | number;
  policy_role: string;
  policy_provider: string;
  policy_status: string;
}>;

function asNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "undefined") {
    throw new Error("Model role parameter snapshot must be JSON serializable.");
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Model role parameter snapshot must be JSON serializable.");
  }
  return serialized;
}

async function lockActiveRollout(
  client: PoolClient,
  role: string,
  rolloutPin: string,
): Promise<ActiveRolloutRow | null> {
  const result = await client.query<ActiveRolloutRow>(
    `SELECT pin.role,
            pin.config_version,
            pin.provider_policy_version,
            definition.enabled,
            definition.role_policy_version AS definition_role_policy_version,
            definition.freshness_policy AS definition_freshness_policy,
            definition.tools_mode AS definition_tools_mode,
            definition.max_technical_retries AS definition_max_technical_retries,
            definition.max_semantic_repairs AS definition_max_semantic_repairs,
            config.provider AS config_provider,
            config.model AS config_model,
            config.model_snapshot AS config_model_snapshot,
            config.prompt_version AS config_prompt_version,
            config.schema_version AS config_schema_version,
            config.role_policy_version AS config_role_policy_version,
            config.freshness_policy AS config_freshness_policy,
            config.fallback_mode AS config_fallback_mode,
            config.parameter_snapshot AS config_parameter_snapshot,
            config.max_technical_retries AS config_max_technical_retries,
            config.max_semantic_repairs AS config_max_semantic_repairs,
            policy.role AS policy_role,
            policy.provider AS policy_provider,
            policy.status AS policy_status
     FROM model_role_rollout_pins pin
     INNER JOIN model_role_definitions definition
       ON definition.role = pin.role
     INNER JOIN model_role_configurations config
       ON config.role = pin.role
      AND config.config_version = pin.config_version
      AND config.provider_policy_version = pin.provider_policy_version
     INNER JOIN provider_egress_policy_versions policy
       ON policy.policy_version = pin.provider_policy_version
     WHERE pin.role = $1
       AND pin.rollout_pin = $2
       AND pin.status = 'active'
       AND definition.enabled = TRUE
       AND policy.status = 'active'
     FOR UPDATE`,
    [role, rolloutPin],
  );
  return result.rows[0] ?? null;
}

function rolloutMatchesConfiguration(
  row: ActiveRolloutRow,
  role: string,
  configuration: ModelRoleConfigurationSnapshot,
): boolean {
  return (
    row.role === role &&
    row.enabled &&
    row.policy_status === "active" &&
    row.policy_role === role &&
    row.policy_provider === configuration.provider &&
    row.config_version === configuration.configVersion &&
    row.provider_policy_version === configuration.providerPolicyVersion &&
    row.config_provider === configuration.provider &&
    row.config_model === configuration.model &&
    row.config_model_snapshot === configuration.modelSnapshot &&
    row.config_prompt_version === configuration.promptVersion &&
    row.config_schema_version === configuration.schemaVersion &&
    row.config_role_policy_version === configuration.rolePolicyVersion &&
    row.config_freshness_policy === configuration.freshnessPolicy &&
    row.config_fallback_mode === configuration.fallbackMode &&
    canonicalJson(row.config_parameter_snapshot) ===
      canonicalJson(configuration.parameterSnapshot) &&
    asNumber(row.config_max_technical_retries) ===
      configuration.maxTechnicalRetries &&
    asNumber(row.config_max_semantic_repairs) ===
      configuration.maxSemanticRepairs &&
    row.definition_role_policy_version === configuration.rolePolicyVersion &&
    row.definition_freshness_policy === configuration.freshnessPolicy &&
    row.definition_tools_mode === "disabled" &&
    asNumber(row.definition_max_technical_retries) ===
      configuration.maxTechnicalRetries &&
    asNumber(row.definition_max_semantic_repairs) ===
      configuration.maxSemanticRepairs
  );
}

function mapAdmissionResult(
  row: Readonly<{
    generation_command_id: string;
    model_run_attempt_id: string;
    attempt_no: number;
    workflow_command_id: string | null;
    inserted: boolean;
    intent_key: string;
  }>,
): AdmittedModelRoleCommand {
  return {
    outcome: row.inserted ? "created" : "reused",
    generationCommandId: asGenerationCommandId(row.generation_command_id),
    modelRunAttemptId: asModelRunAttemptId(row.model_run_attempt_id),
    workflowCommandId: row.workflow_command_id
      ? asWorkflowCommandId(row.workflow_command_id)
      : null,
    attemptNo: row.attempt_no,
    intentKey: row.intent_key,
  };
}

function errorCategory(
  failureCode: PersistModelRoleAttemptResult["failureCode"],
): string {
  switch (failureCode) {
    case "authentication":
      return "authentication";
    case "configuration":
    case "schema_incompatible":
    case "provider_egress_blocked":
      return "configuration";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "server_error":
    case "result_unknown":
      return "unavailable";
    default:
      return "unknown";
  }
}

async function lockOwner(
  client: PoolClient,
  userId: UserId,
): Promise<Readonly<{ status: string; dataEpoch: number }> | null> {
  const result = await client.query<{ status: string; data_epoch: string }>(
    `SELECT status, data_epoch::text AS data_epoch
     FROM app_users
     WHERE user_id = $1
     FOR UPDATE`,
    [userId],
  );
  const row = result.rows[0];
  return row
    ? { status: row.status, dataEpoch: Number(row.data_epoch) }
    : null;
}

async function insertWorkflowAndOutbox(
  client: PoolClient,
  input: Readonly<{
    userId: UserId;
    sourceRevision: number;
    expectedDataEpoch: number;
    policyVersion: string;
    intentKey: string;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    role: string;
    rolloutPin: string;
    attemptNo: number;
    attemptKind: string;
    now: Date;
  }>,
): Promise<string> {
  const workflowCommandId = createUuidV7(input.now);
  const workflow = await client.query<{ workflow_command_id: string }>(
    `INSERT INTO workflow_commands (
       workflow_command_id, command_type, subject_type, subject_id,
       source_revision, policy_version, expected_data_epoch,
       coverage_through_sequence_no, intent_key, status, created_at
     )
     VALUES ($1, 'model_role', 'app_user', $2, $3, $4, $5, 0, $6, 'created', $7)
     ON CONFLICT (
       command_type, subject_type, subject_id, source_revision,
       expected_data_epoch, policy_version, coverage_through_sequence_no,
       intent_key
     ) DO UPDATE SET workflow_command_id = workflow_commands.workflow_command_id
     RETURNING workflow_command_id`,
    [
      workflowCommandId,
      input.userId,
      input.sourceRevision,
      input.policyVersion,
      input.expectedDataEpoch,
      input.intentKey,
      input.now,
    ],
  );
  const resolvedWorkflowCommandId = workflow.rows[0]!.workflow_command_id;
  const payload = {
    workflowCommandId: resolvedWorkflowCommandId,
    subjectType: "app_user",
    subjectId: input.userId,
    sourceRevision: input.sourceRevision,
    policyVersion: input.policyVersion,
    expectedDataEpoch: input.expectedDataEpoch,
    eventType: "model_role_requested",
    modelRole: input.role,
    generationCommandId: input.generationCommandId,
    modelRunAttemptId: input.modelRunAttemptId,
    attemptNo: input.attemptNo,
    attemptKind: input.attemptKind,
    rolloutPin: input.rolloutPin,
  };
  await client.query<QueryResultRow>(
    `INSERT INTO outbox_events (
       outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
       aggregate_revision, aggregate_data_epoch, aggregate_coverage,
       event_type, intent_key, status, next_attempt_at, attempt_count,
       payload, created_at
     )
     VALUES ($1, $2, 'app_user', $3, $4, $5, 0, 'model_role_requested',
       $6, 'pending', $7, 0, $8::jsonb, $7)
     ON CONFLICT DO NOTHING`,
    [
      createUuidV7(input.now),
      resolvedWorkflowCommandId,
      input.userId,
      input.sourceRevision,
      input.expectedDataEpoch,
      input.intentKey,
      input.now,
      JSON.stringify(payload),
    ],
  );
  return resolvedWorkflowCommandId;
}

export class PostgresModelRoleCommandRepository
  implements ModelRoleCommandRepository
{
  public constructor(private readonly pool: Pool) {}

  public async admit(
    input: PersistModelRoleAdmission,
  ): Promise<AdmittedModelRoleCommand> {
    const { admission, configuration, identity } = input;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await lockOwner(client, admission.userId);
      if (!owner || owner.status !== "active") {
        throw new ModelRoleAdmissionRejectedError("owner");
      }
      if (owner.dataEpoch !== admission.expectedDataEpoch) {
        throw new ModelRoleAdmissionRejectedError("epoch");
      }
      const rollout = await lockActiveRollout(
        client,
        admission.role,
        configuration.rolloutPin,
      );
      if (!rollout || !rolloutMatchesConfiguration(rollout, admission.role, configuration)) {
        throw new ModelRoleAdmissionRejectedError("rollout");
      }

      const generationCommandId = createUuidV7(admission.now);
      const inserted = await client.query<{
        generation_command_id: string;
        inserted: boolean;
        intent_key: string;
      }>(
        `INSERT INTO generation_commands (
           generation_command_id, user_id, interaction_turn_id,
           operation_type, intent_key, subject_type, subject_id,
           input_revision_kind, input_revision_id, prompt_version,
           output_format_version, persona_version, product_policy_version,
           safety_policy_version, relationship_policy_version,
           locale_policy_version, locale, provider, model, model_snapshot,
           model_config_version, provider_policy_version,
           consent_policy_version, freshness_policy, harness_policy_version,
           conversation_action_catalog_version, expected_data_epoch, status,
           model_role, schema_version, role_policy_version, rollout_pin,
           source_revision, source_snapshot, input_manifest, parameter_snapshot,
           fallback_mode,
           created_at
         )
         VALUES (
           $1, $2, NULL, $3, $4, $5, $6, 'model_role_input', NULL, $7,
           $8, 'model-role:none:v1', $9, $9, $9, $9, 'und', $10, $11, $12,
           $13, $14, NULL, $15, 'model-role-harness:none:v1',
           'model-role-actions:none:v1', $16, 'prepared', $3, $17, $18,
           $19, $20, $21, $22::jsonb, $23::jsonb, 'disabled', $24
         )
         ON CONFLICT (user_id, intent_key) DO UPDATE
           SET generation_command_id = generation_commands.generation_command_id
         RETURNING generation_command_id, (xmax = 0) AS inserted, intent_key`,
        [
          generationCommandId,
          admission.userId,
          admission.role,
          identity.intentKey,
          admission.subjectType,
          admission.subjectId,
          configuration.promptVersion,
          configuration.schemaVersion,
          configuration.rolePolicyVersion,
          configuration.provider,
          configuration.model,
          configuration.modelSnapshot,
          configuration.configVersion,
          configuration.providerPolicyVersion,
          configuration.freshnessPolicy,
          admission.expectedDataEpoch,
          configuration.schemaVersion,
          configuration.rolePolicyVersion,
          configuration.rolloutPin,
          admission.sourceRevision,
          admission.sourceSnapshot,
          JSON.stringify(identity.inputManifest),
          JSON.stringify(configuration.parameterSnapshot),
          admission.now,
        ],
      );
      const commandRow = inserted.rows[0]!;
      const commandId = asGenerationCommandId(commandRow.generation_command_id);
      if (!commandRow.inserted) {
        const existing = await client.query<{
          model_run_attempt_id: string;
          attempt_no: number;
        }>(
          `SELECT model_run_attempt_id, attempt_no
           FROM model_run_attempts
           WHERE generation_command_id = $1
           ORDER BY attempt_no DESC
           LIMIT 1`,
          [commandId],
        );
        if (!existing.rows[0]) {
          throw new Error("Existing model role command has no attempt ledger row.");
        }
        await client.query("COMMIT");
        return mapAdmissionResult({
          generation_command_id: commandRow.generation_command_id,
          model_run_attempt_id: existing.rows[0].model_run_attempt_id,
          attempt_no: existing.rows[0].attempt_no,
          workflow_command_id: null,
          inserted: false,
          intent_key: commandRow.intent_key,
        });
      }

      const modelRunAttemptId = createUuidV7(admission.now);
      await client.query(
        `INSERT INTO model_run_attempts (
           model_run_attempt_id, user_id, generation_command_id, attempt_no,
           operation_type, provider, model, model_snapshot, prompt_version,
           attempt_kind, status, created_at
         )
         VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, 'initial', 'prepared', $9)`,
        [
          modelRunAttemptId,
          admission.userId,
          commandId,
          admission.role,
          configuration.provider,
          configuration.model,
          configuration.modelSnapshot,
          configuration.promptVersion,
          admission.now,
        ],
      );
      const workflowCommandId = await insertWorkflowAndOutbox(client, {
        userId: admission.userId,
        sourceRevision: admission.sourceRevision,
        expectedDataEpoch: admission.expectedDataEpoch,
        policyVersion: configuration.rolePolicyVersion,
        intentKey: identity.intentKey,
        generationCommandId: commandId,
        modelRunAttemptId: asModelRunAttemptId(modelRunAttemptId),
        role: admission.role,
        rolloutPin: configuration.rolloutPin,
        attemptNo: 1,
        attemptKind: "initial",
        now: admission.now,
      });
      await client.query("COMMIT");
      return mapAdmissionResult({
        generation_command_id: commandRow.generation_command_id,
        model_run_attempt_id: modelRunAttemptId,
        attempt_no: 1,
        workflow_command_id: workflowCommandId,
        inserted: true,
        intent_key: commandRow.intent_key,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordAttemptResult(
    input: PersistModelRoleAttemptResult,
  ): Promise<RecordedModelRoleAttempt> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const command = await client.query<CommandRow>(
        `SELECT command.generation_command_id, command.user_id,
                command.model_role, command.model_config_version,
                command.provider_policy_version, command.rollout_pin,
                command.intent_key, command.source_revision,
                command.expected_data_epoch, command.status,
                attempt.model_run_attempt_id AS attempt_id,
                attempt.attempt_no, attempt.status AS attempt_status,
                command.provider, command.model, command.model_snapshot,
                command.prompt_version, command.schema_version,
                command.role_policy_version, command.freshness_policy,
                command.parameter_snapshot,
                command.fallback_mode
         FROM generation_commands command
         INNER JOIN model_run_attempts attempt
           ON attempt.generation_command_id = command.generation_command_id
          AND attempt.user_id = command.user_id
         WHERE command.generation_command_id = $1
           AND command.user_id = $2
           AND attempt.model_run_attempt_id = $3
         FOR UPDATE`,
        [input.generationCommandId, input.userId, input.modelRunAttemptId],
      );
      const row = command.rows[0];
      if (!row) {
        throw new Error("Model role command or attempt was not found.");
      }
      if (row.attempt_no !== input.attemptNo) {
        throw new Error("Model role attempt number does not match the ledger.");
      }
      if (
        row.attempt_status === "succeeded" ||
        row.attempt_status === "failed" ||
        row.attempt_status === "discarded" ||
        row.attempt_status === "result_unknown"
      ) {
        await client.query("ROLLBACK");
        return {
          outcome: "discarded",
          reason: "already_settled",
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
        };
      }
      if (
        row.model_role !== input.role ||
        asNumber(row.source_revision) !== input.currentSourceRevision
      ) {
        await this.discardAttempt(client, input, "source_changed");
        await client.query("COMMIT");
        return {
          outcome: "discarded",
          reason: "source_changed",
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
        };
      }
      const owner = await lockOwner(client, asUserId(row.user_id));
      if (
        !owner ||
        owner.status !== "active" ||
        owner.dataEpoch !== input.expectedDataEpoch ||
        owner.dataEpoch !== asNumber(row.expected_data_epoch)
      ) {
        await this.discardAttempt(client, input, "data_epoch");
        await client.query("COMMIT");
        return {
          outcome: "discarded",
          reason: "data_epoch",
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
        };
      }
      const rollout = await lockActiveRollout(client, input.role, row.rollout_pin);
      if (
        !rollout ||
        !rolloutMatchesConfiguration(rollout, input.role, input.configuration) ||
        row.provider !== input.configuration.provider ||
        row.model !== input.configuration.model ||
        row.model_snapshot !== input.configuration.modelSnapshot ||
        row.prompt_version !== input.configuration.promptVersion ||
        row.schema_version !== input.configuration.schemaVersion ||
        row.role_policy_version !== input.configuration.rolePolicyVersion ||
        row.freshness_policy !== input.configuration.freshnessPolicy ||
        canonicalJson(row.parameter_snapshot) !==
          canonicalJson(input.configuration.parameterSnapshot) ||
        row.fallback_mode !== input.configuration.fallbackMode ||
        row.model_config_version !== input.configuration.configVersion ||
        row.provider_policy_version !== input.configuration.providerPolicyVersion ||
        row.rollout_pin !== input.configuration.rolloutPin
      ) {
        await this.discardAttempt(client, input, "rollout_pin_changed");
        await client.query("COMMIT");
        return {
          outcome: "discarded",
          reason: "rollout_pin_changed",
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
        };
      }
      if (["succeeded", "failed"].includes(row.status)) {
        await client.query("ROLLBACK");
        return {
          outcome: "discarded",
          reason: "already_settled",
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
        };
      }

      const usage = await client.query<{
        technical_retries_used: string | number;
        semantic_repairs_used: string | number;
      }>(
        `SELECT
           count(*) FILTER (WHERE attempt_kind = 'technical_retry')::int
             AS technical_retries_used,
           count(*) FILTER (WHERE attempt_kind = 'schema_repair')::int
             AS semantic_repairs_used
         FROM model_run_attempts
         WHERE generation_command_id = $1 AND user_id = $2`,
        [input.generationCommandId, input.userId],
      );
      const usageRow = usage.rows[0]!;
      if (
        asNumber(usageRow.technical_retries_used) !== input.technicalRetriesUsed ||
        asNumber(usageRow.semantic_repairs_used) !== input.semanticRepairsUsed
      ) {
        throw new Error("Model role retry counters do not match the ledger.");
      }

      const attemptStatus =
        input.outcome === "succeeded"
          ? "succeeded"
          : input.failureCode === "result_unknown"
            ? "result_unknown"
            : "failed";
      await client.query(
        `UPDATE model_run_attempts
         SET status = $1,
             error_code = $2,
             error_category = $3,
             completed_at = $4,
             provider_completed_at = $4,
             recovery_status = $5
         WHERE model_run_attempt_id = $6
           AND user_id = $7`,
        [
          attemptStatus,
          input.failureCode ?? null,
          input.failureCode ? errorCategory(input.failureCode) : null,
          input.now,
          input.recovery.action === "retry"
            ? "retried"
            : input.outcome === "succeeded"
              ? "not_needed"
              : "terminal",
          input.modelRunAttemptId,
          input.userId,
        ],
      );

      if (input.recovery.action === "retry") {
        const nextAttemptId = createUuidV7(input.now);
        const nextAttemptNo = input.attemptNo + 1;
        await client.query(
          `INSERT INTO model_run_attempts (
             model_run_attempt_id, user_id, generation_command_id, attempt_no,
             operation_type, provider, model, model_snapshot, prompt_version,
             attempt_kind, source_attempt_id, status, retry_not_before,
             created_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             'prepared', $12, $12)`,
          [
            nextAttemptId,
            input.userId,
            input.generationCommandId,
            nextAttemptNo,
            input.role,
            input.configuration.provider,
            input.configuration.model,
            input.configuration.modelSnapshot,
            input.configuration.promptVersion,
            input.recovery.nextAttemptKind,
            input.modelRunAttemptId,
            input.now,
          ],
        );
        await client.query(
          `UPDATE generation_commands
           SET status = 'retry_pending',
               recovery_status = 'pending',
               recovery_checked_at = $1,
               next_recovery_at = $1,
               settled_at = NULL
           WHERE generation_command_id = $2
             AND user_id = $3`,
          [input.now, input.generationCommandId, input.userId],
        );
        const nextWorkflowId = await insertWorkflowAndOutbox(client, {
          userId: input.userId,
          sourceRevision: input.currentSourceRevision,
          expectedDataEpoch: input.expectedDataEpoch,
          policyVersion: input.configuration.rolePolicyVersion,
          intentKey: `${row.intent_key}:attempt:${nextAttemptNo}`,
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: asModelRunAttemptId(nextAttemptId),
          role: input.role,
          rolloutPin: input.configuration.rolloutPin,
          attemptNo: nextAttemptNo,
          attemptKind: input.recovery.nextAttemptKind!,
          now: input.now,
        });
        await client.query("COMMIT");
        return {
          outcome: "retry_scheduled",
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
          nextModelRunAttemptId: asModelRunAttemptId(nextAttemptId),
          nextWorkflowCommandId: asWorkflowCommandId(nextWorkflowId),
        };
      }

      await client.query(
        `UPDATE generation_commands
         SET status = $1,
             recovery_status = $2,
             recovery_checked_at = $3,
             settled_at = $3
         WHERE generation_command_id = $4
           AND user_id = $5`,
        [
          input.recovery.commandStatus,
          input.outcome === "succeeded" ? "not_needed" : "terminal",
          input.now,
          input.generationCommandId,
          input.userId,
        ],
      );
      await client.query("COMMIT");
      return {
        outcome: input.outcome === "succeeded" ? "succeeded" : "failed",
        generationCommandId: input.generationCommandId,
        modelRunAttemptId: input.modelRunAttemptId,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async discardAttempt(
    client: PoolClient,
    input: PersistModelRoleAttemptResult,
    reason: "data_epoch" | "source_changed" | "rollout_pin_changed",
  ): Promise<void> {
    await client.query(
      `UPDATE model_run_attempts
       SET status = 'discarded', error_code = $1,
           completed_at = $2, provider_completed_at = $2,
           recovery_status = 'terminal'
       WHERE model_run_attempt_id = $3 AND user_id = $4`,
      [reason, input.now, input.modelRunAttemptId, input.userId],
    );
    await client.query(
      `UPDATE generation_commands
       SET status = 'failed', recovery_status = 'terminal',
           recovery_checked_at = $1, settled_at = $1
       WHERE generation_command_id = $2 AND user_id = $3`,
      [input.now, input.generationCommandId, input.userId],
    );
  }
}
