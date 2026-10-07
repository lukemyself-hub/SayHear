import type {
  AdmittedModelRoleCommand,
  ModelRoleCommandRepository,
  ModelRoleConfigurationSnapshot,
  ModelRoleCallUsage,
  ModelRoleAttemptReadiness,
  ModelRoleAttemptRecovery,
  PersistModelRoleAdmission,
  PersistModelRoleAttemptDiscard,
  PersistModelRoleAttemptValidation,
  PersistModelRoleAttemptResult,
  RecordedModelRoleAttempt,
} from "@sayhear/application";
import type {
  ModelRoleAttemptKind,
  OneA3bModelRole,
  OneA3bG1ReleaseManifest,
} from "@sayhear/application";
import {
  isModelRoleAttemptKind,
  normalizeModelRoleCallUsage,
  ONE_A_3B_G1_ENABLED_ROLES,
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
  public constructor(public readonly reason: "owner" | "epoch" | "rollout" | "retired_role") {
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
  attempt_kind: ModelRoleAttemptKind | null;
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
  policy_model_config_version: string;
  policy_status: string;
  policy_consent_policy_version: string | null;
  release_fingerprint: string | null;
}>;

const MODEL_ROLE_RECOVERY_WINDOW_MS = 300_000;

type RecoveryAttemptRow = Readonly<{
  model_run_attempt_id: string;
  attempt_no: number | string;
  attempt_kind: string;
  operation_type: string;
  provider: string;
  model: string;
  model_snapshot: string;
  prompt_version: string;
  status: string;
  started_at: Date | null;
}>;

function asNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function hasExactG1RoleSet(roles: readonly OneA3bModelRole[]): boolean {
  return (
    roles.length === ONE_A_3B_G1_ENABLED_ROLES.length &&
    ONE_A_3B_G1_ENABLED_ROLES.every((role) => roles.includes(role))
  );
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
            policy.model_config_version AS policy_model_config_version,
            policy.status AS policy_status,
            policy.consent_policy_version AS policy_consent_policy_version,
            pin.release_fingerprint
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

async function providerConsentIsActive(
  client: PoolClient,
  input: Readonly<{
    userId: UserId;
    role: string;
    provider: string;
    consentPolicyVersion: string | null;
  }>,
): Promise<boolean> {
  if (input.consentPolicyVersion === null) return true;
  const consent = await client.query<{ status: string }>(
    `SELECT status
     FROM provider_egress_consents
     WHERE user_id = $1
       AND provider = $2
       AND role = $3
       AND consent_policy_version = $4
     FOR UPDATE`,
    [
      input.userId,
      input.provider,
      input.role,
      input.consentPolicyVersion,
    ],
  );
  return consent.rows[0]?.status === "active";
}

function rolloutMatchesConfiguration(
  row: ActiveRolloutRow,
  role: string,
  configuration: ModelRoleConfigurationSnapshot,
  releaseFingerprint?: string,
): boolean {
  return (
    row.role === role &&
    row.enabled &&
    row.policy_status === "active" &&
    row.policy_role === role &&
    (releaseFingerprint === undefined ||
      row.release_fingerprint === releaseFingerprint) &&
    row.policy_provider === configuration.provider &&
    row.policy_model_config_version === configuration.configVersion &&
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

type ConfigurationRow = Readonly<{
  role: string;
  config_version: string;
  provider: string;
  model: string;
  model_snapshot: string;
  prompt_version: string;
  schema_version: string;
  role_policy_version: string;
  provider_policy_version: string;
  freshness_policy: string;
  fallback_mode: string;
  max_technical_retries: string | number;
  max_semantic_repairs: string | number;
  parameter_snapshot: unknown;
}>;

function storedConfigurationMatches(
  row: ConfigurationRow,
  configuration: ModelRoleConfigurationSnapshot,
): boolean {
  return (
    row.role === configuration.role &&
    row.config_version === configuration.configVersion &&
    row.provider === configuration.provider &&
    row.model === configuration.model &&
    row.model_snapshot === configuration.modelSnapshot &&
    row.prompt_version === configuration.promptVersion &&
    row.schema_version === configuration.schemaVersion &&
    row.role_policy_version === configuration.rolePolicyVersion &&
    row.provider_policy_version === configuration.providerPolicyVersion &&
    row.freshness_policy === configuration.freshnessPolicy &&
    row.fallback_mode === configuration.fallbackMode &&
    asNumber(row.max_technical_retries) === configuration.maxTechnicalRetries &&
    asNumber(row.max_semantic_repairs) === configuration.maxSemanticRepairs &&
    canonicalJson(row.parameter_snapshot) ===
      canonicalJson(configuration.parameterSnapshot)
  );
}

function commandMatchesConfiguration(
  row: CommandRow,
  configuration: ModelRoleConfigurationSnapshot,
): boolean {
  return (
    row.provider === configuration.provider &&
    row.model === configuration.model &&
    row.model_snapshot === configuration.modelSnapshot &&
    row.prompt_version === configuration.promptVersion &&
    row.schema_version === configuration.schemaVersion &&
    row.role_policy_version === configuration.rolePolicyVersion &&
    row.freshness_policy === configuration.freshnessPolicy &&
    canonicalJson(row.parameter_snapshot) ===
      canonicalJson(configuration.parameterSnapshot) &&
    row.fallback_mode === configuration.fallbackMode &&
    row.model_config_version === configuration.configVersion &&
    row.provider_policy_version === configuration.providerPolicyVersion &&
    row.rollout_pin === configuration.rolloutPin
  );
}

type G1SchemaContract = Pick<OneA3bG1ReleaseManifest["schema"], "migrations" | "fingerprint">;

async function assertG1SchemaContract(
  client: PoolClient,
  schemaContract: G1SchemaContract | undefined,
): Promise<void> {
  if (!schemaContract) return;
  const applied = await client.query<{
    migration_name: string;
    migration_sha256: string;
  }>(
    `SELECT migration_name, migration_sha256
     FROM schema_migrations
     ORDER BY migration_name`,
  );
  const expected = schemaContract.migrations;
  const matches =
    applied.rows.length === expected.length &&
    applied.rows.every(
      (row, index) =>
        row.migration_name === expected[index]?.name &&
        row.migration_sha256 === expected[index]?.sha256,
    );
  if (!matches) {
    throw new Error(
      `Database schema does not match the frozen G1 migration contract ${schemaContract.fingerprint}.`,
    );
  }
}

function mapAdmissionResult(
  row: Readonly<{
    generation_command_id: string;
    model_run_attempt_id: string;
    attempt_no: number;
    attempt_kind: ModelRoleAttemptKind;
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
    attemptKind: row.attempt_kind,
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

async function discardAttemptRows(
  client: PoolClient,
  input: Readonly<{
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    userId: UserId;
    reason: PersistModelRoleAttemptDiscard["reason"];
    now: Date;
    /**
     * Content-free usage already proven for this same attempt (the Provider
     * completed before a fence discarded the result). COALESCE keeps a
     * no-usage discard from erasing anything recorded earlier.
     */
    usage?: ModelRoleCallUsage | null;
  }>,
): Promise<void> {
  const usage = normalizeModelRoleCallUsage(input.usage);
  await client.query(
    `UPDATE model_run_attempts
     SET status = 'discarded', error_code = $1,
         completed_at = $2, provider_completed_at = $2,
         recovery_status = 'terminal',
         input_tokens = COALESCE($6, input_tokens),
         output_tokens = COALESCE($7, output_tokens),
         reasoning_tokens = COALESCE($8, reasoning_tokens),
         cached_tokens = COALESCE($9, cached_tokens),
         total_tokens = COALESCE($10, total_tokens)
     WHERE model_run_attempt_id = $3
       AND generation_command_id = $4
       AND user_id = $5
       AND status NOT IN ('succeeded', 'failed', 'discarded', 'result_unknown')`,
    [
      input.reason,
      input.now,
      input.modelRunAttemptId,
      input.generationCommandId,
      input.userId,
      usage?.inputTokens ?? null,
      usage?.outputTokens ?? null,
      usage?.reasoningTokens ?? null,
      usage?.cachedTokens ?? null,
      usage?.totalTokens ?? null,
    ],
  );
  await client.query(
    `UPDATE generation_commands
     SET status = 'failed', recovery_status = 'terminal',
         recovery_checked_at = $1, settled_at = $1
     WHERE generation_command_id = $2
       AND user_id = $3
       AND status NOT IN ('succeeded', 'failed')`,
    [input.now, input.generationCommandId, input.userId],
  );
  await client.query(
    `UPDATE provider_egress_dispositions
     SET status = 'failed', error_category = 'policy_blocked', completed_at = $1
     WHERE model_run_attempt_id = $2
       AND user_id = $3
       AND status = 'dispatched'`,
    [input.now, input.modelRunAttemptId, input.userId],
  );
}

export class PostgresModelRoleCommandRepository
  implements ModelRoleCommandRepository
{
  public constructor(
    private readonly pool: Pool,
    private readonly schemaContract?: G1SchemaContract,
    private readonly releaseFingerprint?: string,
  ) {}

  private async assertActiveG1Release(
    client: PoolClient,
    configurations: readonly ModelRoleConfigurationSnapshot[],
  ): Promise<void> {
    if (!hasExactG1RoleSet(configurations.map((configuration) => configuration.role))) {
      throw new Error(
        `G1 release must contain the complete active role set: ${ONE_A_3B_G1_ENABLED_ROLES.join(", ")}.`,
      );
    }
    if (!this.releaseFingerprint || !/^sha256:[a-f0-9]{64}$/.test(this.releaseFingerprint)) {
      throw new Error("G1 active rollout pins are missing their release fingerprint binding.");
    }
    await assertG1SchemaContract(client, this.schemaContract);
    const active = await client.query<{ role: string; rollout_pin: string }>(
      `SELECT role, rollout_pin
       FROM model_role_rollout_pins
       WHERE status = 'active'
       FOR UPDATE`,
      [],
    );
    if (
      active.rows.length !== ONE_A_3B_G1_ENABLED_ROLES.length ||
      new Set(active.rows.map((row) => row.role)).size !==
        ONE_A_3B_G1_ENABLED_ROLES.length ||
      active.rows.some(
        (row) =>
          !(ONE_A_3B_G1_ENABLED_ROLES as readonly string[]).includes(row.role),
      )
    ) {
      throw new Error("G1 active rollout pins are not the complete four-role set.");
    }
    for (const configuration of configurations) {
      const rollout = await lockActiveRollout(
        client,
        configuration.role,
        configuration.rolloutPin,
      );
      if (
        !rollout ||
        !rolloutMatchesConfiguration(
          rollout,
          configuration.role,
          configuration,
          this.releaseFingerprint,
        )
      ) {
        throw new Error(
          `Active G1 rollout pin for ${configuration.role} does not match the release manifest.`,
        );
      }
    }
  }

  public async verifyActiveG1Release(input: Readonly<{
    configurations: readonly ModelRoleConfigurationSnapshot[];
  }>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertActiveG1Release(client, input.configurations);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reconcile a replayed model-role event before it can reach a Provider.
   * A stale running attempt is made result-unknown and gets one new,
   * content-free technical retry in the same transaction. A late callback for
   * the old attempt therefore finds a terminal row and cannot settle it again.
   */
  public async recoverAttempt(input: Readonly<{
    userId: UserId;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    now: Date;
  }>): Promise<ModelRoleAttemptRecovery> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertG1SchemaContract(client, this.schemaContract);
      const command = await client.query<{
        status: string;
        model_role: string;
        max_technical_retries: string | number;
      }>(
        `SELECT gc.status, gc.model_role,
                definition.max_technical_retries
         FROM generation_commands gc
         INNER JOIN model_role_definitions definition
           ON definition.role = gc.model_role
         WHERE gc.generation_command_id = $1 AND gc.user_id = $2
         FOR UPDATE`,
        [input.generationCommandId, input.userId],
      );
      if (!command.rows[0]) {
        await client.query("COMMIT");
        return { outcome: "settled", terminalOutcome: "discarded" };
      }
      const latest = await client.query<RecoveryAttemptRow>(
        `SELECT model_run_attempt_id, attempt_no, attempt_kind,
                operation_type, provider, model, model_snapshot,
                prompt_version, status, started_at
         FROM model_run_attempts
         WHERE generation_command_id = $1 AND user_id = $2
         ORDER BY attempt_no DESC
         LIMIT 1
         FOR UPDATE`,
        [input.generationCommandId, input.userId],
      );
      const attempt = latest.rows[0];
      if (!attempt) {
        await client.query("COMMIT");
        return { outcome: "settled", terminalOutcome: "discarded" };
      }
      const attemptId = asModelRunAttemptId(attempt.model_run_attempt_id);
      const attemptNo = asNumber(attempt.attempt_no);
      const attemptKind = isModelRoleAttemptKind(attempt.attempt_kind)
        ? attempt.attempt_kind
        : null;
      if (!attemptKind) {
        throw new Error("Model role recovery found an invalid attempt kind.");
      }
      if (command.rows[0].status === "succeeded") {
        await client.query("COMMIT");
        return { outcome: "settled", terminalOutcome: "succeeded" };
      }
      if (
        command.rows[0].status === "failed" ||
        command.rows[0].status === "interrupted" ||
        attempt.status === "failed" ||
        attempt.status === "discarded" ||
        attempt.status === "result_unknown"
      ) {
        await client.query("COMMIT");
        return { outcome: "settled", terminalOutcome: "failed" };
      }
      if (attempt.status === "succeeded") {
        await client.query("COMMIT");
        return { outcome: "settled", terminalOutcome: "succeeded" };
      }
      if (attempt.status === "prepared") {
        await client.query("COMMIT");
        return {
          outcome: "ready",
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: attemptId,
          attemptNo,
          attemptKind,
        };
      }
      const interrupted = attempt.status === "interrupted";
      if (attempt.status !== "running" && !interrupted) {
        await client.query("COMMIT");
        return { outcome: "not_due" };
      }
      if (
        !interrupted &&
        (!attempt.started_at ||
        attempt.started_at.getTime() + MODEL_ROLE_RECOVERY_WINDOW_MS >
          input.now.getTime())
      ) {
        await client.query("COMMIT");
        return { outcome: "not_due" };
      }

      await client.query(
        `UPDATE model_run_attempts
         SET status = 'result_unknown', error_category = 'unavailable',
             error_code = 'recovery_timeout', completed_at = $1,
             provider_completed_at = $1, recovery_status = 'retried'
         WHERE model_run_attempt_id = $2 AND user_id = $3
           AND status IN ('running', 'interrupted')`,
        [input.now, attemptId, input.userId],
      );
      await client.query(
        `UPDATE provider_egress_dispositions
         SET status = 'failed', error_category = 'unavailable', completed_at = $1
         WHERE model_run_attempt_id = $2 AND user_id = $3
           AND status = 'dispatched'`,
        [input.now, attemptId, input.userId],
      );
      if (attemptNo >= 1 + asNumber(command.rows[0].max_technical_retries)) {
        await client.query(
          `UPDATE generation_commands
           SET status = 'failed', recovery_status = 'terminal',
               recovery_checked_at = $1, settled_at = $1
           WHERE generation_command_id = $2 AND user_id = $3
             AND status NOT IN ('succeeded', 'failed')`,
          [input.now, input.generationCommandId, input.userId],
        );
        await client.query("COMMIT");
        return { outcome: "settled", terminalOutcome: "failed" };
      }

      const nextAttemptId = asModelRunAttemptId(createUuidV7(input.now));
      await client.query(
        `INSERT INTO model_run_attempts (
           model_run_attempt_id, user_id, generation_command_id, attempt_no,
           operation_type, provider, model, model_snapshot, prompt_version,
           status, retry_of_model_run_attempt_id, recovery_status,
           attempt_kind, source_attempt_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'prepared',
                   $10, 'pending', 'technical_retry', $10, $11)`,
        [
          nextAttemptId,
          input.userId,
          input.generationCommandId,
          attemptNo + 1,
          attempt.operation_type,
          attempt.provider,
          attempt.model,
          attempt.model_snapshot,
          attempt.prompt_version,
          attemptId,
          input.now,
        ],
      );
      await client.query(
        `UPDATE generation_commands
         SET status = 'retry_pending', recovery_status = 'recovering',
             recovery_checked_at = $1, next_recovery_at = NULL,
             settled_at = NULL
         WHERE generation_command_id = $2 AND user_id = $3
           AND status NOT IN ('succeeded', 'failed')`,
        [input.now, input.generationCommandId, input.userId],
      );
      await client.query("COMMIT");
      return {
        outcome: "ready",
        generationCommandId: input.generationCommandId,
        modelRunAttemptId: nextAttemptId,
        attemptNo: attemptNo + 1,
        attemptKind: "technical_retry",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Provision and activate the exact manifest role set before cutover. */
  public async bindActiveG1Release(input: Readonly<{
    configurations: readonly ModelRoleConfigurationSnapshot[];
    manifestFingerprint: string;
    now: Date;
  }>): Promise<number> {
    if (
      !hasExactG1RoleSet(
        input.configurations.map((configuration) => configuration.role),
      ) ||
      !/^sha256:[a-f0-9]{64}$/.test(input.manifestFingerprint)
    ) {
      throw new Error(
        "G1 activation requires the complete role set and a valid manifest fingerprint.",
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertG1SchemaContract(client, this.schemaContract);
      const active = await client.query<{ role: string; rollout_pin: string }>(
        `SELECT role, rollout_pin
         FROM model_role_rollout_pins
         WHERE status = 'active'
         FOR UPDATE`,
        [],
      );
      if (active.rows.length > 0) {
        const requestedPins = new Map(
          input.configurations.map((configuration) => [
            configuration.role,
            configuration.rolloutPin,
          ]),
        );
        if (
          active.rows.length !== ONE_A_3B_G1_ENABLED_ROLES.length ||
          active.rows.some(
            (row) => requestedPins.get(row.role as OneA3bModelRole) !== row.rollout_pin,
          )
        ) {
          throw new Error(
            "G1 activation refuses a partial or conflicting active rollout pin set.",
          );
        }
      }

      for (const configuration of input.configurations) {
        await client.query(
          `INSERT INTO model_role_configurations (
             role, config_version, provider, model, model_snapshot,
             prompt_version, schema_version, role_policy_version,
             provider_policy_version, freshness_policy, fallback_mode,
             max_technical_retries, max_semantic_repairs,
             parameter_snapshot, created_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14::jsonb, $15
           )
           ON CONFLICT (role, config_version) DO NOTHING`,
          [
            configuration.role,
            configuration.configVersion,
            configuration.provider,
            configuration.model,
            configuration.modelSnapshot,
            configuration.promptVersion,
            configuration.schemaVersion,
            configuration.rolePolicyVersion,
            configuration.providerPolicyVersion,
            configuration.freshnessPolicy,
            configuration.fallbackMode,
            configuration.maxTechnicalRetries,
            configuration.maxSemanticRepairs,
            JSON.stringify(configuration.parameterSnapshot),
            input.now,
          ],
        );
        const stored = await client.query<ConfigurationRow>(
          `SELECT role, config_version, provider, model, model_snapshot,
                  prompt_version, schema_version, role_policy_version,
                  provider_policy_version, freshness_policy, fallback_mode,
                  max_technical_retries, max_semantic_repairs,
                  parameter_snapshot
           FROM model_role_configurations
           WHERE role = $1 AND config_version = $2
           FOR UPDATE`,
          [configuration.role, configuration.configVersion],
        );
        if (
          !stored.rows[0] ||
          !storedConfigurationMatches(stored.rows[0], configuration)
        ) {
          throw new Error(
            `Immutable G1 configuration for ${configuration.role} conflicts with the release manifest.`,
          );
        }

        const pin = await client.query<{
          config_version: string;
          provider_policy_version: string;
          release_fingerprint: string | null;
        }>(
          `SELECT config_version, provider_policy_version, release_fingerprint
           FROM model_role_rollout_pins
           WHERE role = $1 AND rollout_pin = $2
           FOR UPDATE`,
          [configuration.role, configuration.rolloutPin],
        );
        if (
          pin.rows[0] &&
          (pin.rows[0].config_version !== configuration.configVersion ||
            pin.rows[0].provider_policy_version !==
              configuration.providerPolicyVersion ||
            (pin.rows[0].release_fingerprint !== null &&
              pin.rows[0].release_fingerprint !== input.manifestFingerprint))
        ) {
          throw new Error(
            `Immutable G1 rollout pin for ${configuration.role} conflicts with the release manifest.`,
          );
        }
        if (pin.rows[0]) {
          await client.query(
            `UPDATE model_role_rollout_pins
             SET status = 'active', activated_at = $1, revoked_at = NULL,
                 release_fingerprint = $2
             WHERE role = $3 AND rollout_pin = $4`,
            [
              input.now,
              input.manifestFingerprint,
              configuration.role,
              configuration.rolloutPin,
            ],
          );
        } else {
          await client.query(
            `INSERT INTO model_role_rollout_pins (
               role, rollout_pin, config_version, provider_policy_version,
               status, activated_at, release_fingerprint
             ) VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
            [
              configuration.role,
              configuration.rolloutPin,
              configuration.configVersion,
              configuration.providerPolicyVersion,
              input.now,
              input.manifestFingerprint,
            ],
          );
        }
      }
      const definitions = await client.query(
        `UPDATE model_role_definitions
         SET enabled = TRUE
         WHERE role = ANY($1::text[])`,
        [input.configurations.map((configuration) => configuration.role)],
      );
      if (definitions.rowCount !== ONE_A_3B_G1_ENABLED_ROLES.length) {
        throw new Error("G1 activation did not enable every manifest role.");
      }
      for (const configuration of input.configurations) {
        const rollout = await lockActiveRollout(
          client,
          configuration.role,
          configuration.rolloutPin,
        );
        if (
          !rollout ||
          !rolloutMatchesConfiguration(
            rollout,
            configuration.role,
            configuration,
            input.manifestFingerprint,
          )
        ) {
          throw new Error(
            `Active G1 rollout pin for ${configuration.role} does not match the release manifest.`,
          );
        }
      }
      await client.query("COMMIT");
      return ONE_A_3B_G1_ENABLED_ROLES.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Revoke the active pins before or during a G1 rollback. Admission and late
   * result recording lock the same rows, so a result that arrives after this
   * transaction commits is discarded by lockActiveRollout rather than becoming
   * current under an old release.
   */
  public async revokeActiveRolloutPins(input: Readonly<{
    now: Date;
    roles: readonly OneA3bModelRole[];
    configurations: readonly ModelRoleConfigurationSnapshot[];
    manifestFingerprint: string;
  }>): Promise<number> {
    if (!hasExactG1RoleSet(input.roles)) {
      throw new Error(
        `G1 rollback must revoke the complete active role set atomically: ${ONE_A_3B_G1_ENABLED_ROLES.join(", ")}.`,
      );
    }
    if (input.configurations.length !== input.roles.length ||
        new Set(input.configurations.map((configuration) => configuration.role)).size !== input.roles.length ||
        input.configurations.some((configuration) => !input.roles.includes(configuration.role)) ||
        !/^sha256:[a-f0-9]{64}$/.test(input.manifestFingerprint)) {
      throw new Error("G1 rollback requires the exact active role configurations and manifest fingerprint.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertActiveG1Release(client, input.configurations);
      const result = await client.query<{ role: string }>(
        `UPDATE model_role_rollout_pins
         SET status = 'revoked', revoked_at = $1
         WHERE status = 'active'
           AND role = ANY($2::text[])
           AND release_fingerprint = $3
         RETURNING role`,
        [input.now, [...input.roles], input.manifestFingerprint],
      );
      if (result.rows.length !== input.roles.length) {
        throw new Error(
          `G1 rollback expected ${input.roles.length} active rollout pins but found ${result.rows.length}; no pins were revoked.`,
        );
      }
      await client.query("COMMIT");
      return result.rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async admit(
    input: PersistModelRoleAdmission,
  ): Promise<AdmittedModelRoleCommand> {
    const { admission, configuration, identity } = input;
    if (!(ONE_A_3B_G1_ENABLED_ROLES as readonly string[]).includes(admission.role)) {
      throw new ModelRoleAdmissionRejectedError("retired_role");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertG1SchemaContract(client, this.schemaContract);
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
      const consentActive = rollout
        ? await providerConsentIsActive(client, {
            userId: admission.userId,
            role: admission.role,
            provider: configuration.provider,
            consentPolicyVersion: rollout.policy_consent_policy_version,
          })
        : false;
      if (
        !rollout ||
        !consentActive ||
        !rolloutMatchesConfiguration(
          rollout,
          admission.role,
          configuration,
          this.releaseFingerprint,
        )
      ) {
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
           fallback_mode, generation_stage,
           created_at
         )
         VALUES (
           $1, $2, NULL, $3, $4, $5, $6, 'model_role_input', NULL, $7,
           $8, 'model-role:none:v1', $9, $9, $9, $9, 'und', $10, $11, $12,
           $13, $14, NULL, $15, 'model-role-harness:none:v1',
           'model-role-actions:none:v1', $16, 'prepared', $3, $17, $18,
           $19, $20, $21, $22::jsonb, $23::jsonb, 'disabled',
           'decision',
           $24
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
          attempt_kind: string;
        }>(
          `SELECT model_run_attempt_id, attempt_no, attempt_kind
           FROM model_run_attempts
           WHERE generation_command_id = $1
           ORDER BY attempt_no DESC
           LIMIT 1`,
          [commandId],
        );
        if (!existing.rows[0]) {
          throw new Error("Existing model role command has no attempt ledger row.");
        }
        if (!isModelRoleAttemptKind(existing.rows[0].attempt_kind)) {
          throw new Error("Existing model role command has an invalid attempt kind.");
        }
        await client.query("COMMIT");
        return mapAdmissionResult({
          generation_command_id: commandRow.generation_command_id,
          model_run_attempt_id: existing.rows[0].model_run_attempt_id,
          attempt_no: existing.rows[0].attempt_no,
          attempt_kind: existing.rows[0].attempt_kind,
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
        attempt_kind: "initial",
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

  private async validateAttemptInTransaction(
    client: PoolClient,
    input: PersistModelRoleAttemptValidation,
  ): Promise<ModelRoleAttemptReadiness> {
    await assertG1SchemaContract(client, this.schemaContract);
    const command = await client.query<CommandRow>(
      `SELECT command.generation_command_id, command.user_id,
              command.model_role, command.model_config_version,
              command.provider_policy_version, command.rollout_pin,
              command.intent_key, command.source_revision,
              command.expected_data_epoch, command.status,
              attempt.model_run_attempt_id AS attempt_id,
              attempt.attempt_no, attempt.attempt_kind, attempt.status AS attempt_status,
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
       FOR UPDATE OF command, attempt`,
      [input.generationCommandId, input.userId, input.modelRunAttemptId],
    );
    const row = command.rows[0];
    if (!row) return { outcome: "discarded", reason: "already_settled" };
    if (
      row.attempt_status === "succeeded" ||
      row.attempt_status === "failed" ||
      row.attempt_status === "discarded" ||
      row.attempt_status === "result_unknown" ||
      row.attempt_status !== "prepared" ||
      !["prepared", "retry_pending"].includes(row.status)
    ) {
      return { outcome: "discarded", reason: "already_settled" };
    }
    if (
      row.attempt_no !== input.attemptNo ||
      row.attempt_kind !== input.attemptKind
    ) {
      await discardAttemptRows(client, {
        generationCommandId: input.generationCommandId,
        modelRunAttemptId: input.modelRunAttemptId,
        userId: input.userId,
        reason: "attempt_metadata_mismatch",
        now: input.now,
      });
      return { outcome: "discarded", reason: "attempt_metadata_mismatch" };
    }
    if (
      row.model_role !== input.role ||
      asNumber(row.source_revision) !== input.currentSourceRevision
    ) {
      await discardAttemptRows(client, {
        generationCommandId: input.generationCommandId,
        modelRunAttemptId: input.modelRunAttemptId,
        userId: input.userId,
        reason: "source_changed",
        now: input.now,
      });
      return { outcome: "discarded", reason: "source_changed" };
    }
    const owner = await lockOwner(client, input.userId);
    if (
      !owner ||
      owner.status !== "active" ||
      owner.dataEpoch !== input.expectedDataEpoch ||
      owner.dataEpoch !== asNumber(row.expected_data_epoch)
    ) {
      await discardAttemptRows(client, {
        generationCommandId: input.generationCommandId,
        modelRunAttemptId: input.modelRunAttemptId,
        userId: input.userId,
        reason: "data_epoch",
        now: input.now,
      });
      return { outcome: "discarded", reason: "data_epoch" };
    }
    if (row.rollout_pin !== input.rolloutPin) {
      await discardAttemptRows(client, {
        generationCommandId: input.generationCommandId,
        modelRunAttemptId: input.modelRunAttemptId,
        userId: input.userId,
        reason: "rollout_pin_changed",
        now: input.now,
      });
      return { outcome: "discarded", reason: "rollout_pin_changed" };
    }
    const rollout = await lockActiveRollout(
      client,
      input.role,
      input.rolloutPin,
    );
    const consentActive = rollout
      ? await providerConsentIsActive(client, {
          userId: input.userId,
          role: input.role,
          provider: input.configuration.provider,
          consentPolicyVersion: rollout.policy_consent_policy_version,
        })
      : false;
    if (
      !rollout ||
      !consentActive ||
      !rolloutMatchesConfiguration(
        rollout,
        input.role,
        input.configuration,
        this.releaseFingerprint,
      ) ||
      !commandMatchesConfiguration(row, input.configuration)
    ) {
      await discardAttemptRows(client, {
        generationCommandId: input.generationCommandId,
        modelRunAttemptId: input.modelRunAttemptId,
        userId: input.userId,
        reason: "rollout_pin_changed",
        now: input.now,
      });
      return { outcome: "discarded", reason: "rollout_pin_changed" };
    }
    return { outcome: "ready" };
  }

  public async validateAttempt(
    input: PersistModelRoleAttemptValidation,
  ): Promise<ModelRoleAttemptReadiness> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const readiness = await this.validateAttemptInTransaction(client, input);
      await client.query("COMMIT");
      return readiness;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async claimProviderDispatch(
    input: PersistModelRoleAttemptValidation,
  ): Promise<ModelRoleAttemptReadiness> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const readiness = await this.validateAttemptInTransaction(client, input);
      if (readiness.outcome !== "ready") {
        await client.query("COMMIT");
        return readiness;
      }
      const claimed = await client.query(
        `UPDATE model_run_attempts
         SET status = 'running', started_at = $1
         WHERE model_run_attempt_id = $2
           AND user_id = $3
           AND status = 'prepared'`,
        [input.now, input.modelRunAttemptId, input.userId],
      );
      if (claimed.rowCount !== 1) {
        await client.query("COMMIT");
        return { outcome: "discarded", reason: "already_settled" };
      }
      await client.query(
        `UPDATE generation_commands
         SET status = 'running'
         WHERE generation_command_id = $1
           AND user_id = $2
           AND status IN ('prepared', 'retry_pending')`,
        [input.generationCommandId, input.userId],
      );
      await client.query(
        `INSERT INTO provider_egress_dispositions (
           provider_egress_disposition_id, user_id, model_run_attempt_id,
           provider, model, role, provider_policy_version,
           expected_data_epoch, status, checked_at, dispatched_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'dispatched', $9, $9)
         ON CONFLICT (model_run_attempt_id) DO NOTHING`,
        [
          createUuidV7(input.now),
          input.userId,
          input.modelRunAttemptId,
          input.configuration.provider,
          input.configuration.model,
          input.role,
          input.configuration.providerPolicyVersion,
          input.expectedDataEpoch,
          input.now,
        ],
      );
      await client.query("COMMIT");
      return { outcome: "ready" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async discardAttempt(
    input: PersistModelRoleAttemptDiscard,
  ): Promise<RecordedModelRoleAttempt> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const attempt = await client.query<{
        status: string;
        generation_command_id: string;
      }>(
        `SELECT status, generation_command_id
         FROM model_run_attempts
         WHERE model_run_attempt_id = $1
           AND generation_command_id = $2
           AND user_id = $3
         FOR UPDATE`,
        [input.modelRunAttemptId, input.generationCommandId, input.userId],
      );
      const row = attempt.rows[0];
      if (
        !row ||
        row.status === "succeeded" ||
        row.status === "failed" ||
        row.status === "discarded" ||
        row.status === "result_unknown"
      ) {
        await client.query("COMMIT");
        return {
          outcome: "discarded",
          reason: "already_settled",
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
        };
      }
      await discardAttemptRows(client, input);
      await client.query("COMMIT");
      return {
        outcome: "discarded",
        reason: input.reason,
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

  public async recordAttemptResult(
    input: PersistModelRoleAttemptResult,
  ): Promise<RecordedModelRoleAttempt> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertG1SchemaContract(client, this.schemaContract);
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
        await this.discardAttemptForResult(client, input, "source_changed");
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
        await this.discardAttemptForResult(client, input, "data_epoch");
        await client.query("COMMIT");
        return {
          outcome: "discarded",
          reason: "data_epoch",
          generationCommandId: input.generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
        };
      }
      const rollout = await lockActiveRollout(client, input.role, row.rollout_pin);
      const consentActive = rollout
        ? await providerConsentIsActive(client, {
            userId: input.userId,
            role: input.role,
            provider: input.configuration.provider,
            consentPolicyVersion: rollout.policy_consent_policy_version,
          })
        : false;
      if (
        !rollout ||
        !consentActive ||
        !rolloutMatchesConfiguration(
          rollout,
          input.role,
          input.configuration,
          this.releaseFingerprint,
        ) ||
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
        await this.discardAttemptForResult(client, input, "rollout_pin_changed");
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
      // COALESCE so a settlement without a usage record (deduplicated replay,
      // conversation/Journal paths) never overwrites a count already recorded
      // on this same attempt.
      const callUsage = normalizeModelRoleCallUsage(input.usage);
      await client.query(
        `UPDATE model_run_attempts
         SET status = $1,
             error_code = $2,
             error_category = $3,
             completed_at = $4,
             provider_completed_at = $4,
             recovery_status = $5,
             input_tokens = COALESCE($8, input_tokens),
             output_tokens = COALESCE($9, output_tokens),
             reasoning_tokens = COALESCE($10, reasoning_tokens),
             cached_tokens = COALESCE($11, cached_tokens),
             total_tokens = COALESCE($12, total_tokens)
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
          callUsage?.inputTokens ?? null,
          callUsage?.outputTokens ?? null,
          callUsage?.reasoningTokens ?? null,
          callUsage?.cachedTokens ?? null,
          callUsage?.totalTokens ?? null,
        ],
      );
      await client.query(
        `UPDATE provider_egress_dispositions
         SET status = $1, error_category = $2, completed_at = $3
         WHERE model_run_attempt_id = $4
           AND user_id = $5
           AND status = 'dispatched'`,
        [
          input.outcome === "succeeded" ? "completed" : "failed",
          input.outcome === "succeeded"
            ? null
            : input.failureCode
              ? errorCategory(input.failureCode)
              : "unknown",
          input.now,
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

  private async discardAttemptForResult(
    client: PoolClient,
    input: PersistModelRoleAttemptResult,
    reason: "data_epoch" | "source_changed" | "rollout_pin_changed",
  ): Promise<void> {
    await discardAttemptRows(client, {
      generationCommandId: input.generationCommandId,
      modelRunAttemptId: input.modelRunAttemptId,
      userId: input.userId,
      reason,
      now: input.now,
      usage: input.usage ?? null,
    });
  }
}
