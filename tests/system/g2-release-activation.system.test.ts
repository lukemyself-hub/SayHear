import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_G2_BUNDLE_ROLES,
  ONE_A_3B_ROLE_POLICIES,
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
const g1ManifestFingerprint = `sha256:${"b".repeat(64)}`;
const g2ManifestFingerprint = `sha256:${"a".repeat(64)}`;
const activatedAt = new Date("2026-09-14T10:00:00.000Z");

const g1Configurations: readonly ModelRoleConfigurationSnapshot[] =
  ONE_A_3B_G1_ENABLED_ROLES.map((role) => {
    const policy = ONE_A_3B_ROLE_POLICIES[role];
    return {
      role,
      configVersion: `${role}:g1-release:v1`,
      provider: "deepseek",
      model: "deepseek-chat",
      modelSnapshot: "deepseek-chat@2026-09-12",
      promptVersion: `${role}-prompt:v1`,
      schemaVersion: `${role}-schema:v1`,
      rolePolicyVersion: "1a3b-model-role-policy:v1",
      providerPolicyVersion: `deepseek-${role}-egress:g1-release:v1`,
      rolloutPin: `${role}-g1-release-pin:v1`,
      freshnessPolicy: policy.freshnessPolicy,
      fallbackMode: "disabled",
      maxTechnicalRetries: policy.maxTechnicalRetries,
      maxSemanticRepairs: policy.maxSemanticRepairs,
      parameterSnapshot: { temperature: 0 },
    };
  });

const bundleConfigurations: readonly ModelRoleConfigurationSnapshot[] =
  ONE_A_3B_G2_BUNDLE_ROLES.map((role) => {
    const policy = ONE_A_3B_ROLE_POLICIES[role];
    return {
      role,
      configVersion: `${role}:g2-release:v1`,
      provider: "deepseek",
      model: "deepseek-chat",
      modelSnapshot: "deepseek-chat@2026-09-14",
      promptVersion: `${role}-prompt:v1`,
      schemaVersion: `${role}-schema:v1`,
      rolePolicyVersion: "1a3b-model-role-policy:v1",
      providerPolicyVersion: `deepseek-${role}-egress:g2-release:v1`,
      rolloutPin: `${role}-g2-release-pin:v1`,
      freshnessPolicy: policy.freshnessPolicy,
      fallbackMode: "disabled",
      maxTechnicalRetries: policy.maxTechnicalRetries,
      maxSemanticRepairs: policy.maxSemanticRepairs,
      parameterSnapshot: { temperature: 0 },
    };
  });

async function seedBundleEgressPolicies(
  database: IsolatedPostgresSchema,
): Promise<void> {
  for (const configuration of bundleConfigurations) {
    await database.pool.query(
      `INSERT INTO provider_egress_policy_versions (
         policy_version, provider, role, model_config_version, status
       ) VALUES ($1, 'deepseek', $2, $3, 'active')`,
      [
        configuration.providerPolicyVersion,
        configuration.role,
        configuration.configVersion,
      ],
    );
  }
}

async function switchG1Base(database: IsolatedPostgresSchema): Promise<void> {
  await new PostgresModelRoleCommandRepository(database.pool).bindActiveG1Release({
    configurations: g1Configurations,
    manifestFingerprint: g1ManifestFingerprint,
    now: activatedAt,
  });
}

systemDescribe("G2 bundle release activation persistence", () => {
  let database: IsolatedPostgresSchema | undefined;

  beforeEach(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl!);
    await runMigrations(database.pool);
    await seedBundleEgressPolicies(database);
  });

  afterEach(async () => {
    await database?.dispose();
    database = undefined;
  });

  it("provisions the bundle on the switched G1 base, revokes only the bundle, and reactivates it", async () => {
    await switchG1Base(database!);
    const repository = new PostgresModelRoleCommandRepository(database!.pool);

    await expect(
      repository.bindActiveG2Release({
        configurations: bundleConfigurations,
        manifestFingerprint: g2ManifestFingerprint,
        baseG1ReleaseFingerprint: g1ManifestFingerprint,
        now: activatedAt,
      }),
    ).resolves.toBe(2);

    const fresh = await database!.pool.query<{
      configurations: number;
      enabled_definitions: number;
      active_pins: number;
      g1_active_pins: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_configurations
          WHERE role = ANY($1::text[])) AS configurations,
         (SELECT count(*)::int FROM model_role_definitions
          WHERE role = ANY($1::text[]) AND enabled) AS enabled_definitions,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[]) AND status = 'active'
            AND release_fingerprint = $2) AS active_pins,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($3::text[]) AND status = 'active'
            AND release_fingerprint = $4) AS g1_active_pins`,
      [
        [...ONE_A_3B_G2_BUNDLE_ROLES],
        g2ManifestFingerprint,
        [...ONE_A_3B_G1_ENABLED_ROLES],
        g1ManifestFingerprint,
      ],
    );
    expect(fresh.rows[0]).toEqual({
      configurations: 2,
      enabled_definitions: 2,
      active_pins: 2,
      g1_active_pins: 4,
    });

    const rollbackRepository = new PostgresModelRoleCommandRepository(
      database!.pool,
      undefined,
      g2ManifestFingerprint,
    );
    await expect(
      rollbackRepository.revokeActiveRolloutPins({
        now: new Date("2026-09-14T10:05:00.000Z"),
        roles: ONE_A_3B_G2_BUNDLE_ROLES,
        configurations: bundleConfigurations,
        manifestFingerprint: g2ManifestFingerprint,
      }),
    ).resolves.toBe(2);

    const rolledBack = await database!.pool.query<{
      configurations: number;
      revoked_pins: number;
      g1_active_pins: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_configurations
          WHERE role = ANY($1::text[])) AS configurations,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[]) AND status = 'revoked'
            AND release_fingerprint = $2) AS revoked_pins,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($3::text[]) AND status = 'active'
            AND release_fingerprint = $4) AS g1_active_pins`,
      [
        [...ONE_A_3B_G2_BUNDLE_ROLES],
        g2ManifestFingerprint,
        [...ONE_A_3B_G1_ENABLED_ROLES],
        g1ManifestFingerprint,
      ],
    );
    expect(rolledBack.rows[0]).toEqual({
      configurations: 2,
      revoked_pins: 2,
      g1_active_pins: 4,
    });

    await expect(
      repository.bindActiveG2Release({
        configurations: bundleConfigurations,
        manifestFingerprint: g2ManifestFingerprint,
        baseG1ReleaseFingerprint: g1ManifestFingerprint,
        now: new Date("2026-09-14T10:10:00.000Z"),
      }),
    ).resolves.toBe(2);

    const reactivated = await database!.pool.query<{
      pins: number;
      active_pins: number;
      g1_active_pins: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[])) AS pins,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[]) AND status = 'active'
            AND release_fingerprint = $2) AS active_pins,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($3::text[]) AND status = 'active'
            AND release_fingerprint = $4) AS g1_active_pins`,
      [
        [...ONE_A_3B_G2_BUNDLE_ROLES],
        g2ManifestFingerprint,
        [...ONE_A_3B_G1_ENABLED_ROLES],
        g1ManifestFingerprint,
      ],
    );
    expect(reactivated.rows[0]).toEqual({
      pins: 2,
      active_pins: 2,
      g1_active_pins: 4,
    });
  });

  it("refuses to cut over while the G1 base is not switched", async () => {
    await expect(
      new PostgresModelRoleCommandRepository(database!.pool).bindActiveG2Release({
        configurations: bundleConfigurations,
        manifestFingerprint: g2ManifestFingerprint,
        baseG1ReleaseFingerprint: g1ManifestFingerprint,
        now: activatedAt,
      }),
    ).rejects.toThrow("switched G1");

    const counts = await database!.pool.query<{
      configurations: number;
      pins: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_configurations
          WHERE role = ANY($1::text[])) AS configurations,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[])) AS pins`,
      [[...ONE_A_3B_G2_BUNDLE_ROLES]],
    );
    expect(counts.rows[0]).toEqual({ configurations: 0, pins: 0 });
  });

  it("refuses a base fingerprint that does not match the switched G1 pins", async () => {
    await switchG1Base(database!);

    await expect(
      new PostgresModelRoleCommandRepository(database!.pool).bindActiveG2Release({
        configurations: bundleConfigurations,
        manifestFingerprint: g2ManifestFingerprint,
        baseG1ReleaseFingerprint: `sha256:${"0".repeat(64)}`,
        now: activatedAt,
      }),
    ).rejects.toThrow("switched G1");

    const counts = await database!.pool.query<{
      configurations: number;
      pins: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_configurations
          WHERE role = ANY($1::text[])) AS configurations,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[])) AS pins`,
      [[...ONE_A_3B_G2_BUNDLE_ROLES]],
    );
    expect(counts.rows[0]).toEqual({ configurations: 0, pins: 0 });
  });

  it("requires exactly the two bundle roles before starting the transaction", async () => {
    await switchG1Base(database!);

    await expect(
      new PostgresModelRoleCommandRepository(database!.pool).bindActiveG2Release({
        configurations: bundleConfigurations.slice(0, 1),
        manifestFingerprint: g2ManifestFingerprint,
        baseG1ReleaseFingerprint: g1ManifestFingerprint,
        now: activatedAt,
      }),
    ).rejects.toThrow("complete Open Loop / Proactive bundle");

    const counts = await database!.pool.query<{
      configurations: number;
      pins: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_configurations
          WHERE role = ANY($1::text[])) AS configurations,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[])) AS pins`,
      [[...ONE_A_3B_G2_BUNDLE_ROLES]],
    );
    expect(counts.rows[0]).toEqual({ configurations: 0, pins: 0 });
  });

  it("rejects a conflicting immutable bundle configuration without partially activating", async () => {
    await switchG1Base(database!);
    const conflict = bundleConfigurations[0]!;
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
      new PostgresModelRoleCommandRepository(database!.pool).bindActiveG2Release({
        configurations: bundleConfigurations,
        manifestFingerprint: g2ManifestFingerprint,
        baseG1ReleaseFingerprint: g1ManifestFingerprint,
        now: activatedAt,
      }),
    ).rejects.toThrow("Immutable G2 configuration");

    const counts = await database!.pool.query<{
      pins: number;
      enabled_definitions: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[])) AS pins,
         (SELECT count(*)::int FROM model_role_definitions
          WHERE role = ANY($1::text[]) AND enabled) AS enabled_definitions`,
      [[...ONE_A_3B_G2_BUNDLE_ROLES]],
    );
    expect(counts.rows[0]).toEqual({ pins: 0, enabled_definitions: 0 });
  });

  it("rejects bundle rollback with a foreign fingerprint", async () => {
    await switchG1Base(database!);
    await new PostgresModelRoleCommandRepository(database!.pool).bindActiveG2Release({
      configurations: bundleConfigurations,
      manifestFingerprint: g2ManifestFingerprint,
      baseG1ReleaseFingerprint: g1ManifestFingerprint,
      now: activatedAt,
    });

    await expect(
      new PostgresModelRoleCommandRepository(
        database!.pool,
        undefined,
        `sha256:${"0".repeat(64)}`,
      ).revokeActiveRolloutPins({
        now: new Date("2026-09-14T10:05:00.000Z"),
        roles: ONE_A_3B_G2_BUNDLE_ROLES,
        configurations: bundleConfigurations,
        manifestFingerprint: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toThrow("does not match the release manifest");

    const state = await database!.pool.query<{
      active_pins: number;
      g1_active_pins: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($1::text[]) AND status = 'active') AS active_pins,
         (SELECT count(*)::int FROM model_role_rollout_pins
          WHERE role = ANY($2::text[]) AND status = 'active') AS g1_active_pins`,
      [[...ONE_A_3B_G2_BUNDLE_ROLES], [...ONE_A_3B_G1_ENABLED_ROLES]],
    );
    expect(state.rows[0]).toEqual({ active_pins: 2, g1_active_pins: 4 });
  });

  it("rejects rollback of a partial bundle", async () => {
    await expect(
      new PostgresModelRoleCommandRepository(database!.pool).revokeActiveRolloutPins({
        now: activatedAt,
        roles: ONE_A_3B_G2_BUNDLE_ROLES.slice(0, 1),
        configurations: bundleConfigurations.slice(0, 1),
        manifestFingerprint: g2ManifestFingerprint,
      }),
    ).rejects.toThrow("complete active role set");
  });
});
