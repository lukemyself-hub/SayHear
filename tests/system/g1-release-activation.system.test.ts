import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
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
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const systemDescribe = testDatabaseUrl ? describe : describe.skip;
const manifestFingerprint = `sha256:${"a".repeat(64)}`;
const activatedAt = new Date("2026-09-12T10:00:00.000Z");

const configurations: readonly ModelRoleConfigurationSnapshot[] =
  ONE_A_3B_G1_ENABLED_ROLES.map((role) => {
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

systemDescribe("G1 release activation persistence", () => {
  let database: IsolatedPostgresSchema | undefined;

  beforeEach(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl!);
    await runMigrations(database.pool);
  });

  afterEach(async () => {
    await database?.dispose();
    database = undefined;
  });

  it("accepts the same immutable configuration under a later accepted manifest without rebinding pins", async () => {
    const repository = new PostgresModelRoleCommandRepository(
      database!.pool,
      undefined,
      manifestFingerprint,
    );
    await expect(
      repository.bindActiveG1Release({
        configurations,
        manifestFingerprint,
        now: activatedAt,
      }),
    ).resolves.toBe(4);

    const selectPins = `
      SELECT role, rollout_pin, config_version, provider_policy_version,
             status, release_fingerprint
      FROM model_role_rollout_pins
      ORDER BY role`;
    const before = await database!.pool.query(selectPins);

    // ADR-0148: a new UI or server commit with unchanged configuration reuses
    // the accepted pins. The deployment/report fingerprint is separate from the
    // per-role configuration authorization.
    const laterManifestFingerprint = `sha256:${"e".repeat(64)}`;
    const laterRepository = new PostgresModelRoleCommandRepository(
      database!.pool,
      undefined,
      laterManifestFingerprint,
    );
    await expect(
      laterRepository.verifyActiveG1Release({ configurations }),
    ).resolves.toBeUndefined();

    const after = await database!.pool.query(selectPins);
    expect(after.rows).toEqual(before.rows);
  });

  it("re-running activation with a later accepted manifest keeps the original pin identity", async () => {
    const repository = new PostgresModelRoleCommandRepository(database!.pool);
    await expect(
      repository.bindActiveG1Release({
        configurations,
        manifestFingerprint,
        now: activatedAt,
      }),
    ).resolves.toBe(4);

    const laterManifestFingerprint = `sha256:${"e".repeat(64)}`;
    await expect(
      repository.bindActiveG1Release({
        configurations,
        manifestFingerprint: laterManifestFingerprint,
        now: new Date("2026-09-13T10:00:00.000Z"),
      }),
    ).resolves.toBe(4);

    const pins = await database!.pool.query<{
      role: string;
      release_fingerprint: string | null;
    }>(
      `SELECT role, release_fingerprint
       FROM model_role_rollout_pins
       WHERE status = 'active'
       ORDER BY role`,
    );
    expect(pins.rows).toEqual(
      [...ONE_A_3B_G1_ENABLED_ROLES]
        .sort((left, right) => left.localeCompare(right))
        .map((role) => ({ role, release_fingerprint: manifestFingerprint })),
    );
  });

  it("rejects a changed role configuration even under a valid accepted manifest", async () => {
    const repository = new PostgresModelRoleCommandRepository(
      database!.pool,
      undefined,
      manifestFingerprint,
    );
    await expect(
      repository.bindActiveG1Release({
        configurations,
        manifestFingerprint,
        now: activatedAt,
      }),
    ).resolves.toBe(4);

    const changed = configurations.map((configuration) =>
      configuration.role === "episode.build"
        ? { ...configuration, promptVersion: `${configuration.role}-prompt:v2` }
        : configuration,
    );
    await expect(
      repository.verifyActiveG1Release({ configurations: changed }),
    ).rejects.toThrow("does not match the release manifest");
  });

  it("rejects an active pin that carries no acceptance binding", async () => {
    await expect(
      new PostgresModelRoleCommandRepository(database!.pool).bindActiveG1Release({
        configurations,
        manifestFingerprint,
        now: activatedAt,
      }),
    ).resolves.toBe(4);
    // A production repository is constructed with the accepted release
    // identity; an active pin without any acceptance binding is not authorized.
    await database!.pool.query(
      `UPDATE model_role_rollout_pins SET release_fingerprint = NULL
       WHERE status = 'active'`,
    );
    await expect(
      new PostgresModelRoleCommandRepository(
        database!.pool,
        undefined,
        manifestFingerprint,
      ).verifyActiveG1Release({ configurations }),
    ).rejects.toThrow("does not match the release manifest");
  });

  it("rejects an expired (revoked) authorization before any G1 commit", async () => {
    const repository = new PostgresModelRoleCommandRepository(
      database!.pool,
      undefined,
      manifestFingerprint,
    );
    await expect(
      repository.bindActiveG1Release({
        configurations,
        manifestFingerprint,
        now: activatedAt,
      }),
    ).resolves.toBe(4);

    await expect(
      new PostgresModelRoleCommandRepository(
        database!.pool,
        undefined,
        manifestFingerprint,
      ).revokeActiveRolloutPins({
        now: new Date("2026-09-12T10:05:00.000Z"),
        roles: ONE_A_3B_G1_ENABLED_ROLES,
        configurations,
        manifestFingerprint,
      }),
    ).resolves.toBe(4);

    // Revocation removes the active pins; the same complete configuration can
    // no longer admit or commit a G1 result until it is authorized again.
    await expect(
      repository.verifyActiveG1Release({ configurations }),
    ).rejects.toThrow("not the complete four-role set");
  });

  it("preserves old v2 rows while activating versioned new configurations and pins", async () => {
    const repository = new PostgresModelRoleCommandRepository(database!.pool);

    // Old production configurations are immutable rollback history.
    for (const role of ONE_A_3B_G1_ENABLED_ROLES) {
      const iteration = "v2";
      const livePolicy = ONE_A_3B_ROLE_POLICIES[role];
      await database!.pool.query(
        `INSERT INTO model_role_configurations (
           role, config_version, provider, model, model_snapshot, prompt_version,
           schema_version, role_policy_version, provider_policy_version,
           freshness_policy, fallback_mode, max_technical_retries,
           max_semantic_repairs, parameter_snapshot, created_at
         ) VALUES ($1,$2,'deepseek','deepseek-chat','deepseek-chat@2026-09-12',
                   $3,$4,$5,$6,$7,'disabled',$8,$9,$10,$11)`,
        [
          role,
          `${role}:g1-release:${iteration}`,
          `${role}-prompt:v1`,
          `${role}-schema:v1`,
          ONE_A_3B_ROLE_POLICY_VERSION,
          `deepseek-${role}-egress:g1-release:${iteration}`,
          livePolicy.freshnessPolicy,
          livePolicy.maxTechnicalRetries,
          livePolicy.maxSemanticRepairs,
          JSON.stringify({ temperature: 0 }),
          activatedAt,
        ],
      );
      await database!.pool.query(
        `INSERT INTO model_role_rollout_pins (
           role, rollout_pin, config_version, provider_policy_version,
           status, activated_at, release_fingerprint
         ) VALUES ($1,$2,$3,$4,'active',$5,$6)`,
        [
          role,
          `${role}-g1-release-pin:v1`,
          `${role}:g1-release:${iteration}`,
          `deepseek-${role}-egress:g1-release:${iteration}`,
          activatedAt,
          `sha256:${"b".repeat(64)}`,
        ],
      );
    }

    // Revoke superseded pins before activating the new immutable versions.
    await database!.pool.query(
      `UPDATE model_role_rollout_pins
       SET status = 'revoked', revoked_at = $1`,
      [activatedAt],
    );

    await expect(
      repository.bindActiveG1Release({
        configurations,
        manifestFingerprint,
        now: activatedAt,
      }),
    ).resolves.toBe(4);

    const active = await database!.pool.query<{
      config_version: string;
      role: string;
      rollout_pin: string;
    }>(
      `SELECT role, rollout_pin, config_version
       FROM model_role_rollout_pins
       WHERE status = 'active'
       ORDER BY role`,
    );

    expect(active.rows).toEqual(
      ONE_A_3B_G1_ENABLED_ROLES.map((role) => ({
        role,
        rollout_pin: `${role}-g1-release-pin:${ONE_A_3B_G1_ROLLOUT_PIN_VERSION}`,
        config_version: `${role}:g1-release:${ONE_A_3B_G1_ROLE_CONFIG_VERSIONS[role]}`,
      })).sort((left, right) => left.role.localeCompare(right.role)),
    );
    // All four prior configurations remain, alongside the four new versions.
    // Literal anchors so an accidental re-bump of the shared constants cannot
    // stay self-consistent: the rollout pin and all four config versions are
    // pinned here, not only derived from the same constants used to build the
    // expectations above.
    expect(ONE_A_3B_G1_ROLLOUT_PIN_VERSION).toBe("v17");
    expect(ONE_A_3B_G1_ROLE_CONFIG_VERSIONS).toEqual({
      "episode.build": "v7",
      "reflection.daily": "v9",
      "reflection.weekly": "v8",
      "narrative.validate": "v7",
    });
    const counts = await database!.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM model_role_configurations
       WHERE role = ANY($1::text[])`,
      [[...ONE_A_3B_G1_ENABLED_ROLES]],
    );
    expect(counts.rows[0]!.count).toBe(8);
  });

  it("provisions all four roles, revokes them, and reactivates the same immutable rows", async () => {
    const repository = new PostgresModelRoleCommandRepository(database!.pool);

    await expect(
      repository.bindActiveG1Release({
        configurations,
        manifestFingerprint,
        now: activatedAt,
      }),
    ).resolves.toBe(4);

    const fresh = await database!.pool.query<{
      configurations: number;
      enabled_definitions: number;
      active_pins: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_configurations
          WHERE role = ANY($1::text[])) AS configurations,
         (SELECT count(*)::int FROM model_role_definitions
          WHERE role = ANY($1::text[]) AND enabled) AS enabled_definitions,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[]) AND status = 'active'
            AND release_fingerprint = $2) AS active_pins`,
      [[...ONE_A_3B_G1_ENABLED_ROLES], manifestFingerprint],
    );
    expect(fresh.rows[0]).toEqual({
      configurations: 4,
      enabled_definitions: 4,
      active_pins: 4,
    });

    const rollbackRepository = new PostgresModelRoleCommandRepository(
      database!.pool,
      undefined,
      manifestFingerprint,
    );
    await expect(
      rollbackRepository.revokeActiveRolloutPins({
        now: new Date("2026-09-12T10:05:00.000Z"),
        roles: ONE_A_3B_G1_ENABLED_ROLES,
        configurations,
        manifestFingerprint,
      }),
    ).resolves.toBe(4);

    const rolledBack = await database!.pool.query<{
      configurations: number;
      revoked_pins: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_configurations
          WHERE role = ANY($1::text[])) AS configurations,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[]) AND status = 'revoked'
            AND release_fingerprint = $2) AS revoked_pins`,
      [[...ONE_A_3B_G1_ENABLED_ROLES], manifestFingerprint],
    );
    expect(rolledBack.rows[0]).toEqual({ configurations: 4, revoked_pins: 4 });

    await expect(
      repository.bindActiveG1Release({
        configurations,
        manifestFingerprint,
        now: new Date("2026-09-12T10:10:00.000Z"),
      }),
    ).resolves.toBe(4);

    const reactivated = await database!.pool.query<{
      configurations: number;
      pins: number;
      active_pins: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_configurations
          WHERE role = ANY($1::text[])) AS configurations,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[])) AS pins,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[]) AND status = 'active'
            AND release_fingerprint = $2) AS active_pins`,
      [[...ONE_A_3B_G1_ENABLED_ROLES], manifestFingerprint],
    );
    expect(reactivated.rows[0]).toEqual({
      configurations: 4,
      pins: 4,
      active_pins: 4,
    });
  });

  it("rejects a conflicting immutable configuration without partially activating", async () => {
    const conflict = configurations[0]!;
    await database!.pool.query(
      `INSERT INTO model_role_configurations (
         role, config_version, provider, model, model_snapshot, prompt_version,
         schema_version, role_policy_version, provider_policy_version,
         freshness_policy, fallback_mode, max_technical_retries,
         max_semantic_repairs, parameter_snapshot, created_at
       ) VALUES ($1, $2, $3, 'conflicting-model', $4, $5, $6, $7, $8, $9,
                 $10, $11, $12, $13::jsonb, $14)`,
      [
        conflict.role,
        conflict.configVersion,
        conflict.provider,
        conflict.modelSnapshot,
        conflict.promptVersion,
        conflict.schemaVersion,
        conflict.rolePolicyVersion,
        conflict.providerPolicyVersion,
        conflict.freshnessPolicy,
        conflict.fallbackMode,
        conflict.maxTechnicalRetries,
        conflict.maxSemanticRepairs,
        JSON.stringify(conflict.parameterSnapshot),
        activatedAt,
      ],
    );

    await expect(
      new PostgresModelRoleCommandRepository(database!.pool).bindActiveG1Release({
        configurations,
        manifestFingerprint,
        now: activatedAt,
      }),
    ).rejects.toThrow("Immutable G1 configuration");

    const counts = await database!.pool.query<{
      configurations: number;
      pins: number;
      enabled_definitions: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_configurations) AS configurations,
         (SELECT count(*)::int FROM model_role_rollout_pins) AS pins,
         (SELECT count(*)::int FROM model_role_definitions WHERE enabled)
           AS enabled_definitions`,
    );
    expect(counts.rows[0]).toEqual({
      configurations: 1,
      pins: 0,
      enabled_definitions: 0,
    });
  });

  it("requires exactly four manifest roles before starting the transaction", async () => {
    await expect(
      new PostgresModelRoleCommandRepository(database!.pool).bindActiveG1Release({
        configurations: configurations.slice(0, 3),
        manifestFingerprint,
        now: activatedAt,
      }),
    ).rejects.toThrow("complete role set");

    const counts = await database!.pool.query<{
      configurations: number;
      pins: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_configurations) AS configurations,
         (SELECT count(*)::int FROM model_role_rollout_pins) AS pins`,
    );
    expect(counts.rows[0]).toEqual({ configurations: 0, pins: 0 });
  });

  it("rejects a conflicting immutable pin without replacing it or provisioning other roles", async () => {
    const conflict = configurations[0]!;
    const conflictingConfigVersion = `${conflict.role}:conflict:v1`;
    const conflictingPolicyVersion = `deepseek-${conflict.role}-egress:conflict:v1`;
    await database!.pool.query(
      `INSERT INTO provider_egress_policy_versions (
         policy_version, provider, role, model_config_version, status
       ) VALUES ($1, 'deepseek', $2, $3, 'active')`,
      [conflictingPolicyVersion, conflict.role, conflictingConfigVersion],
    );
    await database!.pool.query(
      `INSERT INTO model_role_configurations (
         role, config_version, provider, model, model_snapshot, prompt_version,
         schema_version, role_policy_version, provider_policy_version,
         freshness_policy, fallback_mode, max_technical_retries,
         max_semantic_repairs, parameter_snapshot, created_at
       ) VALUES ($1, $2, 'deepseek', 'conflict', 'conflict@v1', 'conflict:v1',
                 'conflict:v1', $3, $4, $5, 'disabled', $6, $7, '{}'::jsonb, $8)`,
      [
        conflict.role,
        conflictingConfigVersion,
        conflict.rolePolicyVersion,
        conflictingPolicyVersion,
        conflict.freshnessPolicy,
        conflict.maxTechnicalRetries,
        conflict.maxSemanticRepairs,
        activatedAt,
      ],
    );
    await database!.pool.query(
      `INSERT INTO model_role_rollout_pins (
         role, rollout_pin, config_version, provider_policy_version,
         status, activated_at, revoked_at
       ) VALUES ($1, $2, $3, $4, 'revoked', $5, $5)`,
      [
        conflict.role,
        conflict.rolloutPin,
        conflictingConfigVersion,
        conflictingPolicyVersion,
        activatedAt,
      ],
    );

    await expect(
      new PostgresModelRoleCommandRepository(database!.pool).bindActiveG1Release({
        configurations,
        manifestFingerprint,
        now: activatedAt,
      }),
    ).rejects.toThrow("Immutable G1 rollout pin");

    const pins = await database!.pool.query<{
      config_version: string;
      status: string;
      release_fingerprint: string | null;
    }>(
      `SELECT config_version, status, release_fingerprint
       FROM model_role_rollout_pins`,
    );
    expect(pins.rows).toEqual([
      {
        config_version: conflictingConfigVersion,
        status: "revoked",
        release_fingerprint: null,
      },
    ]);
    await expect(
      database!.pool.query(
        `SELECT count(*)::int AS count FROM model_role_configurations
         WHERE config_version LIKE '%:g1-release:v1'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("rejects any pre-existing partial or foreign active pin set", async () => {
    await database!.pool.query(
      `INSERT INTO provider_egress_policy_versions (
         policy_version, provider, role, model_config_version, status
       ) VALUES ('deepseek-open-loop-egress:foreign:v1', 'deepseek',
                 'open_loop.extract', 'open-loop:foreign:v1', 'active')`,
    );
    await database!.pool.query(
      `INSERT INTO model_role_configurations (
         role, config_version, provider, model, model_snapshot, prompt_version,
         schema_version, role_policy_version, provider_policy_version,
         freshness_policy, fallback_mode, max_technical_retries,
         max_semantic_repairs, parameter_snapshot, created_at
       ) VALUES ('open_loop.extract', 'open-loop:foreign:v1', 'deepseek',
                 'foreign', 'foreign@v1', 'foreign:v1', 'foreign:v1',
                 $1, 'deepseek-open-loop-egress:foreign:v1',
                 'source_valid:v1', 'disabled', 1, 0, '{}'::jsonb, $2)`,
      [ONE_A_3B_ROLE_POLICY_VERSION, activatedAt],
    );
    await database!.pool.query(
      `INSERT INTO model_role_rollout_pins (
         role, rollout_pin, config_version, provider_policy_version,
         status, activated_at
       ) VALUES ('open_loop.extract', 'foreign-pin:v1',
                 'open-loop:foreign:v1',
                 'deepseek-open-loop-egress:foreign:v1', 'active', $1)`,
      [activatedAt],
    );

    await expect(
      new PostgresModelRoleCommandRepository(database!.pool).bindActiveG1Release({
        configurations,
        manifestFingerprint,
        now: activatedAt,
      }),
    ).rejects.toThrow("partial or conflicting active rollout pin set");

    await expect(
      new PostgresModelRoleCommandRepository(
        database!.pool,
        undefined,
        manifestFingerprint,
      ).verifyActiveG1Release({ configurations }),
    ).rejects.toThrow("G1 active rollout pins are not the complete four-role set");

    const state = await database!.pool.query<{
      active_pins: number;
      g1_configurations: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE status = 'active') AS active_pins,
         (SELECT count(*)::int FROM model_role_configurations
          WHERE role = ANY($1::text[])) AS g1_configurations`,
      [[...ONE_A_3B_G1_ENABLED_ROLES]],
    );
    expect(state.rows[0]).toEqual({ active_pins: 1, g1_configurations: 0 });
  });
});
