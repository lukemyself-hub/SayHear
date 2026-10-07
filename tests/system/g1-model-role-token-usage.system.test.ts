import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ONE_A_3B_ROLE_POLICIES,
  createModelRoleCommandService,
  createModelRoleRegistry,
  type ModelRoleCallUsage,
  type ModelRoleCommandService,
  type ModelRoleConfigurationSnapshot,
  type OneA3bModelRole,
} from "@sayhear/application";
import {
  PostgresModelRoleCommandRepository,
  runMigrations,
} from "@sayhear/data";
import { asUserId } from "@sayhear/domain";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const systemDescribe = testDatabaseUrl ? describe : describe.skip;

const G1_ROLES: readonly OneA3bModelRole[] = [
  "episode.build",
  "reflection.daily",
  "reflection.weekly",
  "narrative.validate",
];

const owner = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");
const fencedOwner = asUserId("01984477-2f9a-7b25-a5cc-83c3b21fbc68");
const now = new Date("2026-10-04T12:00:00.000Z");

function configurationFor(role: OneA3bModelRole): ModelRoleConfigurationSnapshot {
  const policy = ONE_A_3B_ROLE_POLICIES[role];
  return {
    role,
    configVersion: `token-usage-${role}:v1`,
    provider: "system-test",
    model: "synthetic-model",
    modelSnapshot: "synthetic-model@fixture",
    promptVersion: `token-usage-${role}:v1`,
    schemaVersion: "token-usage-schema:v1",
    rolePolicyVersion: "1a3b-model-role-policy:v1",
    providerPolicyVersion: `system-${role}-egress:v1`,
    rolloutPin: `system-${role}-pin:v1`,
    freshnessPolicy: policy.freshnessPolicy,
    fallbackMode: "disabled",
    maxTechnicalRetries: policy.maxTechnicalRetries,
    maxSemanticRepairs: policy.maxSemanticRepairs,
    parameterSnapshot: { maxOutputTokens: 4000, temperature: 0 },
  };
}

const configurations = G1_ROLES.map(configurationFor);

type UsageColumns = Readonly<{
  status: string;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  reasoning_tokens: string | number | null;
  cached_tokens: string | number | null;
  total_tokens: string | number | null;
}>;

function numberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

systemDescribe("G1 model role token usage persistence", () => {
  let database: IsolatedPostgresSchema | undefined;
  let service: ModelRoleCommandService;

  async function seedOwner(userId: string): Promise<void> {
    await database!.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [userId, now],
    );
  }

  beforeAll(async () => {
    const seeded = await createIsolatedPostgresSchema(testDatabaseUrl!);
    database = seeded;
    await runMigrations(seeded.pool);
    await seedOwner(owner);
    await seedOwner(fencedOwner);
    for (const configuration of configurations) {
      await seeded.pool.query(
        `INSERT INTO provider_egress_policy_versions (
           policy_version, provider, role, model_config_version, status, created_at
         ) VALUES ($1, $2, $3, $4, 'active', $5)`,
        [
          configuration.providerPolicyVersion,
          configuration.provider,
          configuration.role,
          configuration.configVersion,
          now,
        ],
      );
      await seeded.pool.query(
        `INSERT INTO model_role_configurations (
           role, config_version, provider, model, model_snapshot, prompt_version,
           schema_version, role_policy_version, provider_policy_version,
           freshness_policy, fallback_mode, max_technical_retries,
           max_semantic_repairs, parameter_snapshot, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
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
          now,
        ],
      );
      await seeded.pool.query(
        "UPDATE model_role_definitions SET enabled = TRUE WHERE role = $1",
        [configuration.role],
      );
      await seeded.pool.query(
        `INSERT INTO model_role_rollout_pins (
           role, rollout_pin, config_version, provider_policy_version,
           status, activated_at
         ) VALUES ($1, $2, $3, $4, 'active', $5)`,
        [
          configuration.role,
          configuration.rolloutPin,
          configuration.configVersion,
          configuration.providerPolicyVersion,
          now,
        ],
      );
    }
    service = createModelRoleCommandService({
      registry: createModelRoleRegistry(configurations),
      repository: new PostgresModelRoleCommandRepository(seeded.pool),
    });
  }, 60_000);

  afterAll(async () => {
    await database?.dispose();
  });

  async function readAttempt(attemptId: string): Promise<UsageColumns> {
    const result = await database!.pool.query<UsageColumns>(
      `SELECT status, input_tokens, output_tokens, reasoning_tokens,
              cached_tokens, total_tokens
       FROM model_run_attempts
       WHERE model_run_attempt_id = $1`,
      [attemptId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Attempt row was not found.");
    return row;
  }

  it("persists the reported usage for each of the four G1 roles", async () => {
    const expected = new Map<OneA3bModelRole, ModelRoleCallUsage>([
      [
        "episode.build",
        { cachedTokens: 11, inputTokens: 100, outputTokens: 40, reasoningTokens: 7, totalTokens: 147 },
      ],
      [
        "reflection.daily",
        { cachedTokens: 12, inputTokens: 200, outputTokens: 80, reasoningTokens: 15, totalTokens: 295 },
      ],
      [
        "reflection.weekly",
        { cachedTokens: 13, inputTokens: 300, outputTokens: 120, reasoningTokens: 21, totalTokens: 441 },
      ],
      [
        "narrative.validate",
        { cachedTokens: 2304, inputTokens: 900, outputTokens: 3931, reasoningTokens: 3600, totalTokens: 146917 },
      ],
    ]);
    for (const role of G1_ROLES) {
      const admitted = await service.admit({
        userId: owner,
        role,
        intentKey: `token-usage-four-role:${role}`,
        subjectType: "app_user",
        subjectId: owner,
        sourceRevision: 1,
        sourceSnapshot: `token-usage:${role}`,
        inputManifest: [],
        expectedDataEpoch: 1,
        now,
      });
      const usage = expected.get(role)!;
      await expect(
        service.recordAttemptResult({
          userId: owner,
          generationCommandId: admitted.generationCommandId,
          modelRunAttemptId: admitted.modelRunAttemptId,
          role,
          attemptNo: admitted.attemptNo,
          technicalRetriesUsed: 0,
          semanticRepairsUsed: 0,
          outcome: "succeeded",
          currentSourceRevision: 1,
          expectedDataEpoch: 1,
          now,
          usage,
        }),
      ).resolves.toMatchObject({ outcome: "succeeded" });
      const row = await readAttempt(admitted.modelRunAttemptId);
      expect(row.status).toBe("succeeded");
      expect({
        cachedTokens: numberOrNull(row.cached_tokens),
        inputTokens: numberOrNull(row.input_tokens),
        outputTokens: numberOrNull(row.output_tokens),
        reasoningTokens: numberOrNull(row.reasoning_tokens),
        totalTokens: numberOrNull(row.total_tokens),
      }).toEqual(usage);
    }
  }, 60_000);

  it("keeps unknown as null, records failure spend, and retries with an independent attempt", async () => {
    const admitted = await service.admit({
      userId: owner,
      role: "episode.build",
      intentKey: "token-usage-failure-retry",
      subjectType: "app_user",
      subjectId: owner,
      sourceRevision: 2,
      sourceSnapshot: "token-usage:failure",
      inputManifest: [],
      expectedDataEpoch: 1,
      now,
    });
    // A failed attempt that never reported usage: every counter stays null,
    // never zero.
    const failed = await service.recordAttemptResult({
      userId: owner,
      generationCommandId: admitted.generationCommandId,
      modelRunAttemptId: admitted.modelRunAttemptId,
      role: "episode.build",
      attemptNo: admitted.attemptNo,
      technicalRetriesUsed: 0,
      semanticRepairsUsed: 0,
      outcome: "failed",
      failureCode: "timeout",
      currentSourceRevision: 2,
      expectedDataEpoch: 1,
      now,
      usage: null,
    });
    expect(failed.outcome).toBe("retry_scheduled");
    const firstRow = await readAttempt(admitted.modelRunAttemptId);
    expect(firstRow.status).toBe("failed");
    expect(firstRow.input_tokens).toBeNull();
    expect(firstRow.output_tokens).toBeNull();
    expect(firstRow.reasoning_tokens).toBeNull();
    expect(firstRow.cached_tokens).toBeNull();
    expect(firstRow.total_tokens).toBeNull();

    // The retry is a fresh attempt row; its usage must not leak into attempt 1.
    const retry = await service.recordAttemptResult({
      userId: owner,
      generationCommandId: admitted.generationCommandId,
      modelRunAttemptId: failed.nextModelRunAttemptId!,
      role: "episode.build",
      attemptNo: 2,
      technicalRetriesUsed: 1,
      semanticRepairsUsed: 0,
      outcome: "succeeded",
      currentSourceRevision: 2,
      expectedDataEpoch: 1,
      now,
      usage: {
        cachedTokens: 5,
        inputTokens: 50,
        outputTokens: 20,
        reasoningTokens: 3,
        totalTokens: 73,
      },
    });
    expect(retry.outcome).toBe("succeeded");
    const retryRow = await readAttempt(failed.nextModelRunAttemptId!);
    expect(numberOrNull(retryRow.output_tokens)).toBe(20);
    const firstRowAfter = await readAttempt(admitted.modelRunAttemptId);
    expect(firstRowAfter.output_tokens).toBeNull();
  }, 60_000);

  it("does not overwrite usage when a duplicate settlement is discarded", async () => {
    const admitted = await service.admit({
      userId: owner,
      role: "reflection.daily",
      intentKey: "token-usage-duplicate",
      subjectType: "app_user",
      subjectId: owner,
      sourceRevision: 3,
      sourceSnapshot: "token-usage:duplicate",
      inputManifest: [],
      expectedDataEpoch: 1,
      now,
    });
    await service.recordAttemptResult({
      userId: owner,
      generationCommandId: admitted.generationCommandId,
      modelRunAttemptId: admitted.modelRunAttemptId,
      role: "reflection.daily",
      attemptNo: admitted.attemptNo,
      technicalRetriesUsed: 0,
      semanticRepairsUsed: 0,
      outcome: "succeeded",
      currentSourceRevision: 3,
      expectedDataEpoch: 1,
      now,
      usage: {
        cachedTokens: 1,
        inputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 1,
        totalTokens: 15,
      },
    });
    await expect(
      service.recordAttemptResult({
        userId: owner,
        generationCommandId: admitted.generationCommandId,
        modelRunAttemptId: admitted.modelRunAttemptId,
        role: "reflection.daily",
        attemptNo: admitted.attemptNo,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "succeeded",
        currentSourceRevision: 3,
        expectedDataEpoch: 1,
        now,
        usage: {
          cachedTokens: 999,
          inputTokens: 999,
          outputTokens: 999,
          reasoningTokens: 999,
          totalTokens: 999,
        },
      }),
    ).resolves.toMatchObject({ outcome: "discarded", reason: "already_settled" });
    const row = await readAttempt(admitted.modelRunAttemptId);
    expect(numberOrNull(row.output_tokens)).toBe(4);
    expect(numberOrNull(row.total_tokens)).toBe(15);
  }, 60_000);

  it("retains proven usage when a fenced result discards the attempt", async () => {
    const admitted = await service.admit({
      userId: fencedOwner,
      role: "narrative.validate",
      intentKey: "token-usage-fenced",
      subjectType: "app_user",
      subjectId: fencedOwner,
      sourceRevision: 1,
      sourceSnapshot: "token-usage:fenced",
      inputManifest: [],
      expectedDataEpoch: 1,
      now,
    });
    await database!.pool.query(
      "UPDATE app_users SET data_epoch = 2, updated_at = $2 WHERE user_id = $1",
      [fencedOwner, now],
    );
    await expect(
      service.recordAttemptResult({
        userId: fencedOwner,
        generationCommandId: admitted.generationCommandId,
        modelRunAttemptId: admitted.modelRunAttemptId,
        role: "narrative.validate",
        attemptNo: admitted.attemptNo,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "succeeded",
        currentSourceRevision: 1,
        expectedDataEpoch: 1,
        now,
        usage: {
          cachedTokens: 2,
          inputTokens: 20,
          outputTokens: 8,
          reasoningTokens: 2,
          totalTokens: 30,
        },
      }),
    ).resolves.toMatchObject({ outcome: "discarded", reason: "data_epoch" });
    const row = await readAttempt(admitted.modelRunAttemptId);
    expect(row.status).toBe("discarded");
    expect(numberOrNull(row.output_tokens)).toBe(8);
    expect(numberOrNull(row.reasoning_tokens)).toBe(2);
    expect(numberOrNull(row.total_tokens)).toBe(30);
  }, 60_000);
});
