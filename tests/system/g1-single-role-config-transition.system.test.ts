import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createModelRoleCommandService,
  createModelRoleRegistry,
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_G1_ROLE_CONFIG_VERSIONS,
  ONE_A_3B_G1_ROLLOUT_PIN_VERSION,
  ONE_A_3B_ROLE_POLICIES,
  ONE_A_3B_ROLE_POLICY_VERSION,
  type ModelRoleConfigurationSnapshot,
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

const manifestFingerprint = `sha256:${"a".repeat(64)}`;
const laterManifestFingerprint = `sha256:${"e".repeat(64)}`;
const activatedAt = new Date("2026-09-12T10:00:00.000Z");
const upgradedAt = new Date("2026-09-13T10:00:00.000Z");
const rolledBackAt = new Date("2026-09-14T10:00:00.000Z");
const ownerId = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");

const UPGRADED_ROLE = "episode.build" as const;
const UPGRADED_CONFIG_VERSION = `${UPGRADED_ROLE}:g1-release:v8`;
const UPGRADED_PROVIDER_POLICY_VERSION = `opencode-go-${UPGRADED_ROLE}-egress:g1-release:v8`;
const UPGRADED_ROLLOUT_PIN = `${UPGRADED_ROLE}-g1-release-pin:v18`;

function buildBaseConfigurations(): readonly ModelRoleConfigurationSnapshot[] {
  return ONE_A_3B_G1_ENABLED_ROLES.map((role) => {
    const policy = ONE_A_3B_ROLE_POLICIES[role];
    const configIteration = ONE_A_3B_G1_ROLE_CONFIG_VERSIONS[role];
    return {
      role,
      configVersion: `${role}:g1-release:${configIteration}`,
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      modelSnapshot: "deepseek-v4.1-flash",
      promptVersion: `${role}-prompt:v1`,
      schemaVersion: `${role}-schema:v1`,
      rolePolicyVersion: ONE_A_3B_ROLE_POLICY_VERSION,
      providerPolicyVersion: `opencode-go-${role}-egress:g1-release:${configIteration}`,
      rolloutPin: `${role}-g1-release-pin:${ONE_A_3B_G1_ROLLOUT_PIN_VERSION}`,
      freshnessPolicy: policy.freshnessPolicy,
      fallbackMode: "disabled",
      maxTechnicalRetries: policy.maxTechnicalRetries,
      maxSemanticRepairs: policy.maxSemanticRepairs,
      parameterSnapshot: { temperature: 0 },
    };
  });
}

function upgradeEpisodeBuild(
  configurations: readonly ModelRoleConfigurationSnapshot[],
): readonly ModelRoleConfigurationSnapshot[] {
  return configurations.map((configuration) =>
    configuration.role === UPGRADED_ROLE
      ? {
          ...configuration,
          configVersion: UPGRADED_CONFIG_VERSION,
          providerPolicyVersion: UPGRADED_PROVIDER_POLICY_VERSION,
          rolloutPin: UPGRADED_ROLLOUT_PIN,
          promptVersion: `${UPGRADED_ROLE}-prompt:v2`,
          parameterSnapshot: { temperature: 0, maxOutputTokens: 32000 },
        }
      : configuration,
  );
}

const untouchedRoles = ONE_A_3B_G1_ENABLED_ROLES.filter(
  (role) => role !== UPGRADED_ROLE,
);

async function selectPins(
  database: IsolatedPostgresSchema,
  roles: readonly string[],
) {
  return (
    await database.pool.query(
      `SELECT role, rollout_pin, config_version, provider_policy_version,
              status, activated_at, revoked_at, release_fingerprint
       FROM model_role_rollout_pins
       WHERE role = ANY($1::text[])
       ORDER BY role, rollout_pin`,
      [roles],
    )
  ).rows;
}

async function selectConfigurations(
  database: IsolatedPostgresSchema,
  roles: readonly string[],
) {
  return (
    await database.pool.query(
      `SELECT role, config_version, provider, model, model_snapshot,
              prompt_version, schema_version, role_policy_version,
              provider_policy_version, freshness_policy, fallback_mode,
              max_technical_retries, max_semantic_repairs, parameter_snapshot
       FROM model_role_configurations
       WHERE role = ANY($1::text[])
       ORDER BY role, config_version`,
      [roles],
    )
  ).rows;
}

systemDescribe("G1 single-role configuration transition", () => {
  let database: IsolatedPostgresSchema | undefined;

  beforeEach(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl!);
    await runMigrations(database.pool);
    await database.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [ownerId, activatedAt],
    );
    const repository = new PostgresModelRoleCommandRepository(database.pool);
    await repository.bindActiveG1Release({
      configurations: buildBaseConfigurations(),
      manifestFingerprint,
      now: activatedAt,
    });
  });

  afterEach(async () => {
    await database?.dispose();
    database = undefined;
  });

  async function seedUpgradedProviderPolicy(): Promise<void> {
    await database!.pool.query(
      `INSERT INTO provider_egress_policy_versions (
         policy_version, provider, role, model_config_version,
         consent_policy_version, status
       ) VALUES ($1, 'opencode-go', $2, $3, NULL, 'active')`,
      [UPGRADED_PROVIDER_POLICY_VERSION, UPGRADED_ROLE, UPGRADED_CONFIG_VERSION],
    );
  }

  it("upgrades exactly one role to a new immutable configuration and leaves the other three pins byte-for-byte", async () => {
    await seedUpgradedProviderPolicy();
    const beforePins = await selectPins(database!, untouchedRoles);
    const beforeConfigurations = await selectConfigurations(
      database!,
      untouchedRoles,
    );

    const repository = new PostgresModelRoleCommandRepository(database!.pool);
    const result = await repository.transitionActiveG1Configurations({
      configurations: upgradeEpisodeBuild(buildBaseConfigurations()),
      manifestFingerprint: laterManifestFingerprint,
      now: upgradedAt,
    });

    expect([...result.reauthorized].sort()).toEqual([UPGRADED_ROLE]);
    expect([...result.reused].sort()).toEqual(
      [...untouchedRoles].sort(),
    );

    // ADR-0148: a real configuration change is versioned honestly for the
    // affected role only. The other three roles keep their pins, activation
    // timestamps, historical acceptance fingerprint, and immutable
    // configuration rows without a re-capture or re-bind.
    expect(await selectPins(database!, untouchedRoles)).toEqual(beforePins);
    expect(await selectConfigurations(database!, untouchedRoles)).toEqual(
      beforeConfigurations,
    );

    const episodePins = await selectPins(database!, [UPGRADED_ROLE]);
    expect(episodePins).toHaveLength(2);
    const active = episodePins.find((pin) => pin.status === "active");
    const revoked = episodePins.find((pin) => pin.status === "revoked");
    expect(active).toMatchObject({
      rollout_pin: UPGRADED_ROLLOUT_PIN,
      config_version: UPGRADED_CONFIG_VERSION,
      provider_policy_version: UPGRADED_PROVIDER_POLICY_VERSION,
      release_fingerprint: laterManifestFingerprint,
    });
    // The superseded pin is history, not deleted or rewritten.
    expect(revoked).toMatchObject({
      rollout_pin: `${UPGRADED_ROLE}-g1-release-pin:${ONE_A_3B_G1_ROLLOUT_PIN_VERSION}`,
      config_version: `${UPGRADED_ROLE}:g1-release:${ONE_A_3B_G1_ROLE_CONFIG_VERSIONS[UPGRADED_ROLE]}`,
      release_fingerprint: manifestFingerprint,
    });

    const episodeConfigurations = (
      await database!.pool.query<{ config_version: string }>(
        `SELECT config_version FROM model_role_configurations
         WHERE role = $1 ORDER BY config_version`,
        [UPGRADED_ROLE],
      )
    ).rows.map((row) => row.config_version);
    expect(episodeConfigurations).toEqual([
      `${UPGRADED_ROLE}:g1-release:${ONE_A_3B_G1_ROLE_CONFIG_VERSIONS[UPGRADED_ROLE]}`,
      UPGRADED_CONFIG_VERSION,
    ]);
  });

  it("does not churn the role set when only the accepted deployment fingerprint changes", async () => {
    const beforePins = await selectPins(database!, ONE_A_3B_G1_ENABLED_ROLES);
    const beforeConfigurations = await selectConfigurations(
      database!,
      ONE_A_3B_G1_ENABLED_ROLES,
    );

    const repository = new PostgresModelRoleCommandRepository(database!.pool);
    const result = await repository.transitionActiveG1Configurations({
      configurations: buildBaseConfigurations(),
      manifestFingerprint: laterManifestFingerprint,
      now: upgradedAt,
    });

    expect([...result.reused].sort()).toEqual(
      [...ONE_A_3B_G1_ENABLED_ROLES].sort(),
    );
    expect(result.reauthorized).toEqual([]);
    expect(await selectPins(database!, ONE_A_3B_G1_ENABLED_ROLES)).toEqual(
      beforePins,
    );
    expect(
      await selectConfigurations(database!, ONE_A_3B_G1_ENABLED_ROLES),
    ).toEqual(beforeConfigurations);
  });

  it("fences a late old-config result after the upgrade and records new lineage for fresh commands", async () => {
    const baseConfigurations = buildBaseConfigurations();
    const baseService = createModelRoleCommandService({
      registry: createModelRoleRegistry(baseConfigurations),
      repository: new PostgresModelRoleCommandRepository(database!.pool),
    });
    const inFlight = await baseService.admit({
      userId: ownerId,
      role: UPGRADED_ROLE,
      intentKey: "episode:synthetic:upgrade",
      subjectType: "app_user",
      subjectId: ownerId,
      sourceRevision: 7,
      sourceSnapshot: "snapshot:7",
      inputManifest: [],
      expectedDataEpoch: 1,
      now: activatedAt,
    });
    await baseService.claimProviderDispatch({
      userId: ownerId,
      generationCommandId: inFlight.generationCommandId,
      modelRunAttemptId: inFlight.modelRunAttemptId,
      role: UPGRADED_ROLE,
      attemptNo: 1,
      attemptKind: "initial",
      rolloutPin: baseConfigurations.find(
        (configuration) => configuration.role === UPGRADED_ROLE,
      )!.rolloutPin,
      currentSourceRevision: 7,
      expectedDataEpoch: 1,
      now: activatedAt,
    });

    await seedUpgradedProviderPolicy();
    const upgradedConfigurations = upgradeEpisodeBuild(baseConfigurations);
    await new PostgresModelRoleCommandRepository(
      database!.pool,
    ).transitionActiveG1Configurations({
      configurations: upgradedConfigurations,
      manifestFingerprint: laterManifestFingerprint,
      now: upgradedAt,
    });

    // The in-flight attempt froze under the old pin. Even asked to settle as
    // the new configuration, it cannot acquire the new authorization.
    const upgradedService = createModelRoleCommandService({
      registry: createModelRoleRegistry(upgradedConfigurations),
      repository: new PostgresModelRoleCommandRepository(database!.pool),
    });
    await expect(
      upgradedService.recordAttemptResult({
        userId: ownerId,
        generationCommandId: inFlight.generationCommandId,
        modelRunAttemptId: inFlight.modelRunAttemptId,
        role: UPGRADED_ROLE,
        attemptNo: 1,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "succeeded",
        currentSourceRevision: 7,
        expectedDataEpoch: 1,
        now: upgradedAt,
      }),
    ).resolves.toMatchObject({
      outcome: "discarded",
      reason: "rollout_pin_changed",
    });
    await expect(
      database!.pool.query(
        `SELECT status FROM model_run_attempts WHERE model_run_attempt_id = $1`,
        [inFlight.modelRunAttemptId],
      ),
    ).resolves.toMatchObject({ rows: [{ status: "discarded" }] });

    // A fresh command admitted after the upgrade records the new lineage.
    const fresh = await upgradedService.admit({
      userId: ownerId,
      role: UPGRADED_ROLE,
      intentKey: "episode:synthetic:upgraded",
      subjectType: "app_user",
      subjectId: ownerId,
      sourceRevision: 8,
      sourceSnapshot: "snapshot:8",
      inputManifest: [],
      expectedDataEpoch: 1,
      now: upgradedAt,
    });
    const lineage = await database!.pool.query<{
      model_config_version: string;
      provider_policy_version: string;
      rollout_pin: string;
      prompt_version: string;
      parameter_snapshot: Record<string, unknown>;
    }>(
      `SELECT model_config_version, provider_policy_version, rollout_pin,
              prompt_version, parameter_snapshot
       FROM generation_commands WHERE generation_command_id = $1`,
      [fresh.generationCommandId],
    );
    expect(lineage.rows[0]).toMatchObject({
      model_config_version: UPGRADED_CONFIG_VERSION,
      provider_policy_version: UPGRADED_PROVIDER_POLICY_VERSION,
      rollout_pin: UPGRADED_ROLLOUT_PIN,
      prompt_version: `${UPGRADED_ROLE}-prompt:v2`,
    });
    expect(lineage.rows[0]!.parameter_snapshot).toMatchObject({
      maxOutputTokens: 32000,
    });
  });

  it("rolls back to the usable old configuration, preserves history, and fences late new-config results", async () => {
    const baseConfigurations = buildBaseConfigurations();
    await seedUpgradedProviderPolicy();
    const upgradedConfigurations = upgradeEpisodeBuild(baseConfigurations);
    const repository = new PostgresModelRoleCommandRepository(database!.pool);
    await repository.transitionActiveG1Configurations({
      configurations: upgradedConfigurations,
      manifestFingerprint: laterManifestFingerprint,
      now: upgradedAt,
    });

    const upgradedService = createModelRoleCommandService({
      registry: createModelRoleRegistry(upgradedConfigurations),
      repository: new PostgresModelRoleCommandRepository(database!.pool),
    });
    const inFlight = await upgradedService.admit({
      userId: ownerId,
      role: UPGRADED_ROLE,
      intentKey: "episode:synthetic:rollback",
      subjectType: "app_user",
      subjectId: ownerId,
      sourceRevision: 9,
      sourceSnapshot: "snapshot:9",
      inputManifest: [],
      expectedDataEpoch: 1,
      now: upgradedAt,
    });

    // Rollback re-applies the prior immutable configuration + pin. The
    // upgrade rows stay as history.
    const rollback = await repository.transitionActiveG1Configurations({
      configurations: baseConfigurations,
      manifestFingerprint: laterManifestFingerprint,
      now: rolledBackAt,
    });
    expect([...rollback.reauthorized].sort()).toEqual([UPGRADED_ROLE]);
    expect([...rollback.reused].sort()).toEqual([...untouchedRoles].sort());

    const pins = await selectPins(database!, [UPGRADED_ROLE]);
    expect(pins.filter((pin) => pin.status === "active")).toHaveLength(1);
    expect(pins.find((pin) => pin.status === "active")).toMatchObject({
      rollout_pin: `${UPGRADED_ROLE}-g1-release-pin:${ONE_A_3B_G1_ROLLOUT_PIN_VERSION}`,
      config_version: `${UPGRADED_ROLE}:g1-release:${ONE_A_3B_G1_ROLE_CONFIG_VERSIONS[UPGRADED_ROLE]}`,
    });
    // Both versions of the immutable configuration remain.
    const configurationCount = await database!.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM model_role_configurations
       WHERE role = $1`,
      [UPGRADED_ROLE],
    );
    expect(configurationCount.rows[0]!.count).toBe(2);

    // The command admitted under the upgraded pin cannot settle after rollback.
    const rolledBackService = createModelRoleCommandService({
      registry: createModelRoleRegistry(baseConfigurations),
      repository: new PostgresModelRoleCommandRepository(database!.pool),
    });
    await expect(
      rolledBackService.recordAttemptResult({
        userId: ownerId,
        generationCommandId: inFlight.generationCommandId,
        modelRunAttemptId: inFlight.modelRunAttemptId,
        role: UPGRADED_ROLE,
        attemptNo: 1,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "succeeded",
        currentSourceRevision: 9,
        expectedDataEpoch: 1,
        now: rolledBackAt,
      }),
    ).resolves.toMatchObject({
      outcome: "discarded",
      reason: "rollout_pin_changed",
    });

    // The old authorization is usable again and records old lineage.
    const fresh = await rolledBackService.admit({
      userId: ownerId,
      role: UPGRADED_ROLE,
      intentKey: "episode:synthetic:rolled-back",
      subjectType: "app_user",
      subjectId: ownerId,
      sourceRevision: 10,
      sourceSnapshot: "snapshot:10",
      inputManifest: [],
      expectedDataEpoch: 1,
      now: rolledBackAt,
    });
    const lineage = await database!.pool.query<{
      model_config_version: string;
      rollout_pin: string;
      prompt_version: string;
    }>(
      `SELECT model_config_version, rollout_pin, prompt_version
       FROM generation_commands WHERE generation_command_id = $1`,
      [fresh.generationCommandId],
    );
    expect(lineage.rows[0]).toMatchObject({
      model_config_version: `${UPGRADED_ROLE}:g1-release:${ONE_A_3B_G1_ROLE_CONFIG_VERSIONS[UPGRADED_ROLE]}`,
      rollout_pin: `${UPGRADED_ROLE}-g1-release-pin:${ONE_A_3B_G1_ROLLOUT_PIN_VERSION}`,
      prompt_version: `${UPGRADED_ROLE}-prompt:v1`,
    });
  });

  it("is idempotent: re-applying an unchanged target reuses every pin without new rows", async () => {
    await seedUpgradedProviderPolicy();
    const upgradedConfigurations = upgradeEpisodeBuild(buildBaseConfigurations());
    const repository = new PostgresModelRoleCommandRepository(database!.pool);
    await repository.transitionActiveG1Configurations({
      configurations: upgradedConfigurations,
      manifestFingerprint: laterManifestFingerprint,
      now: upgradedAt,
    });
    const afterFirst = await selectPins(database!, ONE_A_3B_G1_ENABLED_ROLES);
    const configurationCount = await database!.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM model_role_configurations`,
    );

    const repeated = await repository.transitionActiveG1Configurations({
      configurations: upgradedConfigurations,
      manifestFingerprint: laterManifestFingerprint,
      now: new Date(upgradedAt.getTime() + 60_000),
    });

    expect(repeated.reauthorized).toEqual([]);
    expect([...repeated.reused].sort()).toEqual(
      [...ONE_A_3B_G1_ENABLED_ROLES].sort(),
    );
    expect(await selectPins(database!, ONE_A_3B_G1_ENABLED_ROLES)).toEqual(
      afterFirst,
    );
    expect(
      (
        await database!.pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM model_role_configurations`,
        )
      ).rows[0]!.count,
    ).toBe(configurationCount.rows[0]!.count);
  });

  it("preserves the source and data-epoch fences across a scoped role upgrade", async () => {
    const baseConfigurations = buildBaseConfigurations();
    const baseService = createModelRoleCommandService({
      registry: createModelRoleRegistry(baseConfigurations),
      repository: new PostgresModelRoleCommandRepository(database!.pool),
    });
    const makeCommand = (intentKey: string) =>
      baseService.admit({
        userId: ownerId,
        role: UPGRADED_ROLE,
        intentKey,
        subjectType: "app_user",
        subjectId: ownerId,
        sourceRevision: 7,
        sourceSnapshot: "snapshot:7",
        inputManifest: [],
        expectedDataEpoch: 1,
        now: activatedAt,
      });
    const staleSource = await makeCommand("episode:synthetic:stale-source");
    const staleEpoch = await makeCommand("episode:synthetic:stale-epoch");

    await seedUpgradedProviderPolicy();
    const upgradedConfigurations = upgradeEpisodeBuild(baseConfigurations);
    await new PostgresModelRoleCommandRepository(
      database!.pool,
    ).transitionActiveG1Configurations({
      configurations: upgradedConfigurations,
      manifestFingerprint: laterManifestFingerprint,
      now: upgradedAt,
    });
    const upgradedService = createModelRoleCommandService({
      registry: createModelRoleRegistry(upgradedConfigurations),
      repository: new PostgresModelRoleCommandRepository(database!.pool),
    });

    await expect(
      upgradedService.recordAttemptResult({
        userId: ownerId,
        generationCommandId: staleSource.generationCommandId,
        modelRunAttemptId: staleSource.modelRunAttemptId,
        role: UPGRADED_ROLE,
        attemptNo: 1,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "succeeded",
        currentSourceRevision: 8,
        expectedDataEpoch: 1,
        now: upgradedAt,
      }),
    ).resolves.toMatchObject({ outcome: "discarded", reason: "source_changed" });

    await database!.pool.query(
      "UPDATE app_users SET data_epoch = 2, updated_at = $2 WHERE user_id = $1",
      [ownerId, upgradedAt],
    );
    await expect(
      upgradedService.recordAttemptResult({
        userId: ownerId,
        generationCommandId: staleEpoch.generationCommandId,
        modelRunAttemptId: staleEpoch.modelRunAttemptId,
        role: UPGRADED_ROLE,
        attemptNo: 1,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "succeeded",
        currentSourceRevision: 7,
        expectedDataEpoch: 1,
        now: upgradedAt,
      }),
    ).resolves.toMatchObject({ outcome: "discarded", reason: "data_epoch" });
  });

  it("serializes an in-flight old-config settlement against a concurrent authorization revoke", async () => {
    const baseConfigurations = buildBaseConfigurations();
    const baseService = createModelRoleCommandService({
      registry: createModelRoleRegistry(baseConfigurations),
      repository: new PostgresModelRoleCommandRepository(database!.pool),
    });
    const inFlight = await baseService.admit({
      userId: ownerId,
      role: UPGRADED_ROLE,
      intentKey: "episode:synthetic:concurrent",
      subjectType: "app_user",
      subjectId: ownerId,
      sourceRevision: 7,
      sourceSnapshot: "snapshot:7",
      inputManifest: [],
      expectedDataEpoch: 1,
      now: activatedAt,
    });
    const oldConfiguration = baseConfigurations.find(
      (configuration) => configuration.role === UPGRADED_ROLE,
    )!;

    await seedUpgradedProviderPolicy();
    const upgradedConfigurations = upgradeEpisodeBuild(baseConfigurations);
    // Hold the authorization change open on a second connection, exactly as
    // the transition does while it revokes the old pin and inserts the new
    // one. The late settlement must block on the same row lock and then fail
    // the CAS rather than becoming current under the superseded authorization.
    const concurrent = await database!.pool.connect();
    try {
      await concurrent.query("BEGIN");
      await concurrent.query(
        `UPDATE model_role_rollout_pins
         SET status = 'revoked', revoked_at = $1
         WHERE role = $2 AND status = 'active'`,
        [upgradedAt, UPGRADED_ROLE],
      );
      const settlement = baseService.recordAttemptResult({
        userId: ownerId,
        generationCommandId: inFlight.generationCommandId,
        modelRunAttemptId: inFlight.modelRunAttemptId,
        role: UPGRADED_ROLE,
        attemptNo: 1,
        technicalRetriesUsed: 0,
        semanticRepairsUsed: 0,
        outcome: "succeeded",
        currentSourceRevision: 7,
        expectedDataEpoch: 1,
        now: upgradedAt,
      });
      // Give the blocked settlement a chance to reach the row lock, then
      // complete the transition.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await concurrent.query(
        `INSERT INTO model_role_configurations (
           role, config_version, provider, model, model_snapshot,
           prompt_version, schema_version, role_policy_version,
           provider_policy_version, freshness_policy, fallback_mode,
           max_technical_retries, max_semantic_repairs, parameter_snapshot,
           created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
        [
          UPGRADED_ROLE,
          UPGRADED_CONFIG_VERSION,
          oldConfiguration.provider,
          oldConfiguration.model,
          oldConfiguration.modelSnapshot,
          `${UPGRADED_ROLE}-prompt:v2`,
          oldConfiguration.schemaVersion,
          oldConfiguration.rolePolicyVersion,
          UPGRADED_PROVIDER_POLICY_VERSION,
          oldConfiguration.freshnessPolicy,
          oldConfiguration.fallbackMode,
          oldConfiguration.maxTechnicalRetries,
          oldConfiguration.maxSemanticRepairs,
          JSON.stringify({ temperature: 0, maxOutputTokens: 32000 }),
          upgradedAt,
        ],
      );
      await concurrent.query(
        `INSERT INTO model_role_rollout_pins (
           role, rollout_pin, config_version, provider_policy_version,
           status, activated_at, release_fingerprint
         ) VALUES ($1,$2,$3,$4,'active',$5,$6)`,
        [
          UPGRADED_ROLE,
          UPGRADED_ROLLOUT_PIN,
          UPGRADED_CONFIG_VERSION,
          UPGRADED_PROVIDER_POLICY_VERSION,
          upgradedAt,
          laterManifestFingerprint,
        ],
      );
      await concurrent.query("COMMIT");
      await expect(settlement).resolves.toMatchObject({
        outcome: "discarded",
        reason: "rollout_pin_changed",
      });
    } finally {
      concurrent.release();
    }
    const active = await database!.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM model_role_rollout_pins
       WHERE status = 'active'`,
    );
    expect(active.rows[0]!.count).toBe(ONE_A_3B_G1_ENABLED_ROLES.length);
    // The transition is still usable after the race and lands on the target.
    const result = await new PostgresModelRoleCommandRepository(
      database!.pool,
    ).transitionActiveG1Configurations({
      configurations: upgradedConfigurations,
      manifestFingerprint: laterManifestFingerprint,
      now: upgradedAt,
    });
    expect([...result.reused].sort()).toEqual(
      [...ONE_A_3B_G1_ENABLED_ROLES].sort(),
    );
  });

  it("rejects reusing an immutable configuration version with changed content", async () => {
    const baseConfigurations = buildBaseConfigurations();
    const baseEpisode = baseConfigurations.find(
      (configuration) => configuration.role === UPGRADED_ROLE,
    )!;
    const silentlyChangedSchema = baseConfigurations.map((configuration) =>
      configuration.role === UPGRADED_ROLE
        ? {
            ...configuration,
            schemaVersion: `${UPGRADED_ROLE}-schema:v2`,
            rolloutPin: UPGRADED_ROLLOUT_PIN,
          }
        : configuration,
    );
    await seedUpgradedProviderPolicy();
    const repository = new PostgresModelRoleCommandRepository(database!.pool);
    await expect(
      repository.transitionActiveG1Configurations({
        configurations: silentlyChangedSchema,
        manifestFingerprint: laterManifestFingerprint,
        now: upgradedAt,
      }),
    ).rejects.toThrow("Immutable G1 configuration");
    const activeCount = await database!.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM model_role_rollout_pins
       WHERE status = 'active'`,
    );
    expect(activeCount.rows[0]!.count).toBe(ONE_A_3B_G1_ENABLED_ROLES.length);
    // The untouched base pin is still active with its original schema.
    const stored = await database!.pool.query<{ schema_version: string }>(
      `SELECT schema_version FROM model_role_configurations
       WHERE role = $1 AND config_version = $2`,
      [UPGRADED_ROLE, baseEpisode.configVersion],
    );
    expect(stored.rows).toEqual([{ schema_version: baseEpisode.schemaVersion }]);
  });

  it("rejects an illegal fallback switch and a Provider that disagrees with its egress policy", async () => {
    const repository = new PostgresModelRoleCommandRepository(database!.pool);

    // A new immutable configuration that silently requests fallback is
    // rejected by the frozen fallback contract, with no partial activation.
    const fallback = upgradeEpisodeBuild(buildBaseConfigurations()).map(
      (configuration) =>
        configuration.role === UPGRADED_ROLE
          ? { ...configuration, fallbackMode: "enabled" as never }
          : configuration,
    );
    await seedUpgradedProviderPolicy();
    await expect(
      repository.transitionActiveG1Configurations({
        configurations: fallback,
        manifestFingerprint: laterManifestFingerprint,
        now: upgradedAt,
      }),
    ).rejects.toThrow();

    // A Provider that does not agree with the active egress policy for that
    // configuration is not an authorization and is rejected.
    const mismatchedProvider = upgradeEpisodeBuild(
      buildBaseConfigurations(),
    ).map((configuration) =>
      configuration.role === UPGRADED_ROLE
        ? { ...configuration, provider: "deepseek" }
        : configuration,
    );
    await expect(
      repository.transitionActiveG1Configurations({
        configurations: mismatchedProvider,
        manifestFingerprint: laterManifestFingerprint,
        now: upgradedAt,
      }),
    ).rejects.toThrow("does not match the release manifest");

    const activeCount = await database!.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM model_role_rollout_pins
       WHERE status = 'active'`,
    );
    expect(activeCount.rows[0]!.count).toBe(ONE_A_3B_G1_ENABLED_ROLES.length);
  });

  it("rejects a missing role, a retired role, and an unauthorized provider policy", async () => {
    const repository = new PostgresModelRoleCommandRepository(database!.pool);

    await expect(
      repository.transitionActiveG1Configurations({
        configurations: buildBaseConfigurations().slice(0, 3),
        manifestFingerprint: laterManifestFingerprint,
        now: upgradedAt,
      }),
    ).rejects.toThrow("complete role set");

    const retired = buildBaseConfigurations().map((configuration) =>
      configuration.role === UPGRADED_ROLE
        ? { ...configuration, role: "open_loop.extract" as never }
        : configuration,
    );
    await expect(
      repository.transitionActiveG1Configurations({
        configurations: retired,
        manifestFingerprint: laterManifestFingerprint,
        now: upgradedAt,
      }),
    ).rejects.toThrow();

    // A changed provider policy with no active egress policy row is not an
    // authorization and must not be silently provisioned.
    const unknownPolicy = upgradeEpisodeBuild(buildBaseConfigurations());
    await expect(
      repository.transitionActiveG1Configurations({
        configurations: unknownPolicy,
        manifestFingerprint: laterManifestFingerprint,
        now: upgradedAt,
      }),
    ).rejects.toThrow();
    const activePins = await database!.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM model_role_rollout_pins
       WHERE status = 'active'`,
    );
    expect(activePins.rows[0]!.count).toBe(ONE_A_3B_G1_ENABLED_ROLES.length);
  });
});
