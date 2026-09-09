import { createHash } from "node:crypto";

import type {
  GenerationCommandId,
  ModelRunAttemptId,
  UserId,
  WorkflowCommandId,
} from "@sayhear/domain";

export const ONE_A_3B_MODEL_ROLES = [
  "episode.build",
  "open_loop.extract",
  "reflection.daily",
  "reflection.weekly",
  "bio.write",
  "narrative.validate",
  "proactive.followup",
] as const;

export type OneA3bModelRole = (typeof ONE_A_3B_MODEL_ROLES)[number];
export type ModelRoleFreshnessPolicy = "source_valid:v1" | "exact_head:v1";
export const ONE_A_3B_ROLE_POLICY_VERSION = "1a3b-model-role-policy:v1";
export type ModelRoleAttemptKind =
  | "initial"
  | "technical_retry"
  | "schema_repair";

export type ModelRoleParameterSnapshot = Readonly<Record<string, unknown>>;

type ModelRolePolicy = Readonly<{
  freshnessPolicy: ModelRoleFreshnessPolicy;
  maxTechnicalRetries: 0 | 1;
  maxSemanticRepairs: 0 | 1;
}>;

export const ONE_A_3B_ROLE_POLICIES: Readonly<
  Record<OneA3bModelRole, ModelRolePolicy>
> = {
  "episode.build": {
    freshnessPolicy: "source_valid:v1",
    maxTechnicalRetries: 1,
    maxSemanticRepairs: 0,
  },
  "open_loop.extract": {
    freshnessPolicy: "source_valid:v1",
    maxTechnicalRetries: 1,
    maxSemanticRepairs: 0,
  },
  "reflection.daily": {
    freshnessPolicy: "exact_head:v1",
    maxTechnicalRetries: 1,
    maxSemanticRepairs: 0,
  },
  "reflection.weekly": {
    freshnessPolicy: "exact_head:v1",
    maxTechnicalRetries: 1,
    maxSemanticRepairs: 0,
  },
  "bio.write": {
    freshnessPolicy: "exact_head:v1",
    maxTechnicalRetries: 1,
    maxSemanticRepairs: 1,
  },
  "narrative.validate": {
    freshnessPolicy: "exact_head:v1",
    maxTechnicalRetries: 1,
    maxSemanticRepairs: 0,
  },
  "proactive.followup": {
    freshnessPolicy: "exact_head:v1",
    maxTechnicalRetries: 0,
    maxSemanticRepairs: 0,
  },
};

export type ModelRoleConfigurationSnapshot = Readonly<{
  role: OneA3bModelRole;
  configVersion: string;
  provider: string;
  model: string;
  modelSnapshot: string;
  promptVersion: string;
  schemaVersion: string;
  rolePolicyVersion: string;
  providerPolicyVersion: string;
  rolloutPin: string;
  freshnessPolicy: ModelRoleFreshnessPolicy;
  fallbackMode: "disabled";
  maxTechnicalRetries: 0 | 1;
  maxSemanticRepairs: 0 | 1;
  parameterSnapshot: ModelRoleParameterSnapshot;
}>;

export type ModelRoleRegistry = Readonly<{
  registeredRoles: readonly OneA3bModelRole[];
  enabledRoles: readonly OneA3bModelRole[];
  configuration(role: OneA3bModelRole): ModelRoleConfigurationSnapshot | null;
  requireConfiguration(role: OneA3bModelRole): ModelRoleConfigurationSnapshot;
}>;

export class ModelRoleConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ModelRoleConfigurationError";
  }
}

function isModelRole(value: string): value is OneA3bModelRole {
  return (ONE_A_3B_MODEL_ROLES as readonly string[]).includes(value);
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim() === "") {
    throw new ModelRoleConfigurationError(`${field} must not be empty.`);
  }
}

function requireObject(value: unknown, field: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelRoleConfigurationError(`${field} must be a JSON object.`);
  }
}

export function createModelRoleRegistry(
  configurations: readonly ModelRoleConfigurationSnapshot[],
): ModelRoleRegistry {
  const byRole = new Map<OneA3bModelRole, ModelRoleConfigurationSnapshot>();
  for (const configuration of configurations) {
    if (!isModelRole(configuration.role)) {
      throw new ModelRoleConfigurationError(
        `Unknown 1A.3b model role: ${configuration.role}.`,
      );
    }
    if (byRole.has(configuration.role)) {
      throw new ModelRoleConfigurationError(
        `Model role ${configuration.role} has more than one active configuration.`,
      );
    }
    for (const [field, value] of [
      ["configVersion", configuration.configVersion],
      ["provider", configuration.provider],
      ["model", configuration.model],
      ["modelSnapshot", configuration.modelSnapshot],
      ["promptVersion", configuration.promptVersion],
      ["schemaVersion", configuration.schemaVersion],
      ["rolePolicyVersion", configuration.rolePolicyVersion],
      ["providerPolicyVersion", configuration.providerPolicyVersion],
      ["rolloutPin", configuration.rolloutPin],
    ] as const) {
      requireNonEmpty(value, `${configuration.role}.${field}`);
    }
    requireObject(
      configuration.parameterSnapshot,
      `${configuration.role}.parameterSnapshot`,
    );
    const policy = ONE_A_3B_ROLE_POLICIES[configuration.role];
    if (
      configuration.fallbackMode !== "disabled" ||
      configuration.rolePolicyVersion !== ONE_A_3B_ROLE_POLICY_VERSION ||
      configuration.freshnessPolicy !== policy.freshnessPolicy ||
      configuration.maxTechnicalRetries !== policy.maxTechnicalRetries ||
      configuration.maxSemanticRepairs !== policy.maxSemanticRepairs
    ) {
      throw new ModelRoleConfigurationError(
        `Configuration for ${configuration.role} does not match its frozen role policy.`,
      );
    }
    byRole.set(configuration.role, configuration);
  }

  return {
    registeredRoles: ONE_A_3B_MODEL_ROLES,
    enabledRoles: ONE_A_3B_MODEL_ROLES.filter((role) => byRole.has(role)),
    configuration(role) {
      return byRole.get(role) ?? null;
    },
    requireConfiguration(role) {
      const configuration = byRole.get(role);
      if (!configuration) {
        throw new ModelRoleConfigurationError(
          `Model role ${role} has no evaluated rollout configuration.`,
        );
      }
      return configuration;
    },
  };
}

export type ModelRoleSubjectType =
  | "app_user"
  | "daily_session"
  | "entity"
  | "memory_claim"
  | "conversation_event_revision"
  | "bio"
  | "bio_version"
  | "reflection"
  | "episode"
  | "open_loop";

export type ModelRoleInputManifestEntry = Readonly<{
  key: string;
  revision: number;
  fingerprint: string;
}>;

export type ModelRoleAdmissionInput = Readonly<{
  userId: UserId;
  role: OneA3bModelRole;
  intentKey: string;
  subjectType: ModelRoleSubjectType;
  subjectId: string;
  sourceRevision: number;
  sourceSnapshot: string;
  inputManifest: readonly ModelRoleInputManifestEntry[];
  expectedDataEpoch: number;
  now: Date;
}>;

export type ModelRoleCommandIdentity = Readonly<{
  intentKey: string;
  inputManifest: Readonly<{
    entries: readonly ModelRoleInputManifestEntry[];
    sourceSnapshot: string;
  }>;
}>;

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
}

/**
 * Build the outer idempotency key from the role and frozen input snapshot.
 * The caller's intent label is hashed rather than copied to Workflow payloads,
 * so a domain-specific key cannot smuggle private text into diagnostics.
 */
export function buildModelRoleCommandIdentity(
  input: Pick<
    ModelRoleAdmissionInput,
    "role" | "intentKey" | "sourceSnapshot" | "inputManifest" | "sourceRevision" | "expectedDataEpoch"
  >,
): ModelRoleCommandIdentity {
  requireNonEmpty(input.intentKey, "intentKey");
  requireNonEmpty(input.sourceSnapshot, "sourceSnapshot");
  assertNonNegativeInteger(input.sourceRevision, "sourceRevision");
  if (!Number.isSafeInteger(input.expectedDataEpoch) || input.expectedDataEpoch <= 0) {
    throw new Error("expectedDataEpoch must be a positive safe integer.");
  }
  const entries = [...input.inputManifest]
    .map((entry) => {
      requireNonEmpty(entry.key, "inputManifest.key");
      requireNonEmpty(entry.fingerprint, "inputManifest.fingerprint");
      assertNonNegativeInteger(entry.revision, "inputManifest.revision");
      return { ...entry };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
  const canonical = JSON.stringify({
    dataEpoch: input.expectedDataEpoch,
    entries,
    intentKey: input.intentKey,
    role: input.role,
    sourceRevision: input.sourceRevision,
    sourceSnapshot: input.sourceSnapshot,
  });
  const digest = createHash("sha256").update(canonical).digest("hex");
  return {
    intentKey: `${input.role}:1a3b:${digest}`,
    inputManifest: { entries, sourceSnapshot: input.sourceSnapshot },
  };
}

export type ModelRoleFailureCode =
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "result_unknown"
  | "authentication"
  | "configuration"
  | "schema_incompatible"
  | "provider_egress_blocked"
  | "business_fence"
  | "stale_source"
  | "data_epoch"
  | "semantic_rejection"
  | "semantic_repair_required"
  | "unknown";

const TECHNICAL_RETRY_FAILURES = new Set<ModelRoleFailureCode>([
  "timeout",
  "rate_limited",
  "server_error",
  "result_unknown",
]);

export type ModelRoleRecoveryPlan = Readonly<{
  action: "settled" | "retry" | "terminal";
  commandStatus: "succeeded" | "retry_pending" | "failed";
  nextAttemptKind?: ModelRoleAttemptKind;
  failureCode?: ModelRoleFailureCode;
}>;

export function planModelRoleRecovery(input: Readonly<{
  role: OneA3bModelRole;
  attemptNo: number;
  technicalRetriesUsed: number;
  semanticRepairsUsed: number;
  outcome: "succeeded" | "failed";
  failureCode?: ModelRoleFailureCode;
}>): ModelRoleRecoveryPlan {
  if (!Number.isSafeInteger(input.attemptNo) || input.attemptNo <= 0) {
    throw new Error("attemptNo must be a positive safe integer.");
  }
  assertNonNegativeInteger(input.technicalRetriesUsed, "technicalRetriesUsed");
  assertNonNegativeInteger(input.semanticRepairsUsed, "semanticRepairsUsed");
  if (input.outcome === "succeeded") {
    return { action: "settled", commandStatus: "succeeded" };
  }
  if (!input.failureCode) {
    throw new Error("A failed model role attempt requires a failure code.");
  }
  const policy = ONE_A_3B_ROLE_POLICIES[input.role];
  if (input.failureCode === "semantic_repair_required") {
    if (
      input.role === "bio.write" &&
      input.semanticRepairsUsed < policy.maxSemanticRepairs
    ) {
      return {
        action: "retry",
        commandStatus: "retry_pending",
        failureCode: input.failureCode,
        nextAttemptKind: "schema_repair",
      };
    }
    return {
      action: "terminal",
      commandStatus: "failed",
      failureCode: input.failureCode,
    };
  }
  if (
    input.role !== "proactive.followup" &&
    TECHNICAL_RETRY_FAILURES.has(input.failureCode) &&
    input.technicalRetriesUsed < policy.maxTechnicalRetries
  ) {
    return {
      action: "retry",
      commandStatus: "retry_pending",
      failureCode: input.failureCode,
      nextAttemptKind: "technical_retry",
    };
  }
  return {
    action: "terminal",
    commandStatus: "failed",
    failureCode: input.failureCode,
  };
}

export type AdmittedModelRoleCommand = Readonly<{
  outcome: "created" | "reused";
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  workflowCommandId: WorkflowCommandId | null;
  attemptNo: number;
  intentKey: string;
}>;

export type PersistModelRoleAdmission = Readonly<{
  admission: ModelRoleAdmissionInput;
  identity: ModelRoleCommandIdentity;
  configuration: ModelRoleConfigurationSnapshot;
}>;

export type PersistModelRoleAttemptResult = Readonly<{
  userId: UserId;
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  role: OneA3bModelRole;
  attemptNo: number;
  technicalRetriesUsed: number;
  semanticRepairsUsed: number;
  outcome: "succeeded" | "failed";
  failureCode?: ModelRoleFailureCode;
  currentSourceRevision: number;
  expectedDataEpoch: number;
  now: Date;
  configuration: ModelRoleConfigurationSnapshot;
  recovery: ModelRoleRecoveryPlan;
}>;

export type RecordedModelRoleAttempt = Readonly<{
  outcome: "succeeded" | "retry_scheduled" | "failed" | "discarded";
  reason?: "data_epoch" | "source_changed" | "rollout_pin_changed" | "already_settled";
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  nextModelRunAttemptId?: ModelRunAttemptId;
  nextWorkflowCommandId?: WorkflowCommandId;
}>;

export type ModelRoleCommandRepository = Readonly<{
  admit(input: PersistModelRoleAdmission): Promise<AdmittedModelRoleCommand>;
  recordAttemptResult(
    input: PersistModelRoleAttemptResult,
  ): Promise<RecordedModelRoleAttempt>;
}>;

export type ModelRoleCommandService = Readonly<{
  admit(input: ModelRoleAdmissionInput): Promise<AdmittedModelRoleCommand>;
  recordAttemptResult(
    input: Omit<
      PersistModelRoleAttemptResult,
      "configuration" | "recovery"
    >,
  ): Promise<RecordedModelRoleAttempt>;
}>;

export type ModelRoleAdapterRequest = Readonly<{
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  role: OneA3bModelRole;
  attemptNo: number;
  configuration: ModelRoleConfigurationSnapshot;
  sourceRevision: number;
  sourceSnapshot: string;
  inputManifest: readonly ModelRoleInputManifestEntry[];
}>;

export type ModelRoleAdapterResult =
  | Readonly<{ outcome: "succeeded" }>
  | Readonly<{
      outcome: "failed";
      failureCode: ModelRoleFailureCode;
    }>;

/**
 * Provider-facing seam for future role producers. It receives only the
 * frozen command metadata and returns an allowlisted outcome; domain content
 * is validated and persisted by the role-specific producer in a later lane.
 */
export type ModelRoleAdapter = Readonly<{
  execute(request: ModelRoleAdapterRequest): Promise<ModelRoleAdapterResult>;
}>;

export async function executeModelRoleAttempt(input: Readonly<{
  adapter: ModelRoleAdapter;
  commandService: ModelRoleCommandService;
  userId: UserId;
  request: ModelRoleAdapterRequest;
  technicalRetriesUsed: number;
  semanticRepairsUsed: number;
  currentSourceRevision: number;
  expectedDataEpoch: number;
  now: Date;
}>): Promise<RecordedModelRoleAttempt> {
  let result: ModelRoleAdapterResult;
  try {
    result = await input.adapter.execute(input.request);
  } catch {
    // Do not persist adapter/provider error text. An unknown transport result
    // is the only safe classification when the adapter did not return a
    // typed outcome.
    result = { outcome: "failed", failureCode: "result_unknown" };
  }
  return input.commandService.recordAttemptResult({
    userId: input.userId,
    generationCommandId: input.request.generationCommandId,
    modelRunAttemptId: input.request.modelRunAttemptId,
    role: input.request.role,
    attemptNo: input.request.attemptNo,
    technicalRetriesUsed: input.technicalRetriesUsed,
    semanticRepairsUsed: input.semanticRepairsUsed,
    outcome: result.outcome,
    ...(result.outcome === "failed"
      ? { failureCode: result.failureCode }
      : {}),
    currentSourceRevision: input.currentSourceRevision,
    expectedDataEpoch: input.expectedDataEpoch,
    now: input.now,
  });
}

export function createModelRoleCommandService(dependencies: Readonly<{
  registry: ModelRoleRegistry;
  repository: ModelRoleCommandRepository;
}>): ModelRoleCommandService {
  return {
    async admit(input) {
      const configuration = dependencies.registry.requireConfiguration(input.role);
      const identity = buildModelRoleCommandIdentity(input);
      return dependencies.repository.admit({
        admission: input,
        configuration,
        identity,
      });
    },
    async recordAttemptResult(input) {
      const configuration = dependencies.registry.requireConfiguration(input.role);
      const recovery = planModelRoleRecovery(input);
      return dependencies.repository.recordAttemptResult({
        ...input,
        configuration,
        recovery,
      });
    },
  };
}
