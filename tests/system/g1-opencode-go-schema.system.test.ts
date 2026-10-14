import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  asGenerationCommandId,
  asModelRunAttemptId,
  asUserId,
} from "@sayhear/domain";
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
const REGISTERED_EXTENSION_NAMES = [
  "0068_recent_conversation_context_refs.sql",
  "0069_recent_context_request_timezone.sql",
  "0070_recent_context_governance.sql",
  "0071_history_answer_generation_stage.sql",
  "0072_history_recall_results.sql",
  "0075_history_experience_search_refs.sql",
  "0080_conversation_request_lifecycle.sql",
  "0081_history_recall_governance.sql",
  "0082_journal_workflow_recovery.sql",
] as const;
const schemaFingerprint = `sha256:${"a".repeat(64)}`;

type AppliedMigration = Readonly<{ name: string; sha256: string }>;

async function appliedMigrations(
  database: IsolatedPostgresSchema,
): Promise<readonly AppliedMigration[]> {
  const result = await database.pool.query<{
    migration_name: string;
    migration_sha256: string;
  }>(
    `SELECT migration_name, migration_sha256
     FROM schema_migrations
     ORDER BY migration_name`,
  );
  return result.rows.map((row) => ({
    name: row.migration_name,
    sha256: row.migration_sha256,
  }));
}

systemDescribe("OpenCode Go G1 schema contract", () => {
  let database: IsolatedPostgresSchema | undefined;

  beforeEach(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl!);
    await runMigrations(database.pool);
  });

  afterEach(async () => {
    await database?.dispose();
    database = undefined;
  });

  it("keeps the legacy Evidence providers and admits opencode-go", async () => {
    const result = await database!.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       WHERE c.conrelid = 'evidence_source_snapshots'::regclass
         AND c.contype = 'c'
         AND pg_get_constraintdef(c.oid) LIKE '%champion_provider%'`,
    );
    expect(result.rows).toHaveLength(1);
    const def = result.rows[0]!.def;
    expect(def).toContain("'openai'");
    expect(def).toContain("'deepseek'");
    expect(def).toContain("'opencode-go'");
  });

  it("registers the opencode-go conversation and both G1 egress policies per role", async () => {
    const result = await database!.pool.query<{
      consent_policy_version: string | null;
      model_config_version: string;
      policy_version: string;
      provider: string;
      role: string;
      status: string;
    }>(
      `SELECT provider, role, policy_version, model_config_version, status,
              consent_policy_version
       FROM provider_egress_policy_versions
       WHERE provider = 'opencode-go'
       ORDER BY role, policy_version`,
    );
    // A non-NULL consent policy would make claimDispatch and the commit path
    // look up provider_egress_consents and fail closed as policy_blocked.
    expect(result.rows.every((row) => row.consent_policy_version === null)).toBe(true);
    expect(result.rows.map((row) => row.role)).toEqual([
      "conversation.text",
      "episode.build",
      "episode.build",
      "narrative.validate",
      "narrative.validate",
      "reflection.daily",
      "reflection.daily",
      "reflection.weekly",
      "reflection.weekly",
    ]);
    expect(result.rows).toEqual([
      expect.objectContaining({
        model_config_version: "conversation-text-champion:v1",
        policy_version: "opencode-go-conversation-text:v1",
        provider: "opencode-go",
        role: "conversation.text",
        status: "active",
      }),
      expect.objectContaining({
        model_config_version: "episode.build:g1-release:v6",
        policy_version: "opencode-go-episode.build-egress:g1-release:v6",
        provider: "opencode-go",
        role: "episode.build",
        status: "active",
      }),
      expect.objectContaining({
        model_config_version: "episode.build:g1-release:v7",
        policy_version: "opencode-go-episode.build-egress:g1-release:v7",
        provider: "opencode-go",
        role: "episode.build",
        status: "active",
      }),
      expect.objectContaining({
        model_config_version: "narrative.validate:g1-release:v6",
        policy_version: "opencode-go-narrative.validate-egress:g1-release:v6",
        provider: "opencode-go",
        role: "narrative.validate",
        status: "active",
      }),
      expect.objectContaining({
        model_config_version: "narrative.validate:g1-release:v7",
        policy_version: "opencode-go-narrative.validate-egress:g1-release:v7",
        provider: "opencode-go",
        role: "narrative.validate",
        status: "active",
      }),
      expect.objectContaining({
        model_config_version: "reflection.daily:g1-release:v8",
        policy_version: "opencode-go-reflection.daily-egress:g1-release:v8",
        provider: "opencode-go",
        role: "reflection.daily",
        status: "active",
      }),
      expect.objectContaining({
        model_config_version: "reflection.daily:g1-release:v9",
        policy_version: "opencode-go-reflection.daily-egress:g1-release:v9",
        provider: "opencode-go",
        role: "reflection.daily",
        status: "active",
      }),
      expect.objectContaining({
        model_config_version: "reflection.weekly:g1-release:v7",
        policy_version: "opencode-go-reflection.weekly-egress:g1-release:v7",
        provider: "opencode-go",
        role: "reflection.weekly",
        status: "active",
      }),
      expect.objectContaining({
        model_config_version: "reflection.weekly:g1-release:v8",
        policy_version: "opencode-go-reflection.weekly-egress:g1-release:v8",
        provider: "opencode-go",
        role: "reflection.weekly",
        status: "active",
      }),
    ]);
  });

  it("keeps every earlier openai/deepseek egress policy row", async () => {
    const result = await database!.pool.query<{ provider: string }>(
      `SELECT DISTINCT provider FROM provider_egress_policy_versions
       WHERE provider IN ('openai', 'deepseek')`,
    );
    expect(new Set(result.rows.map((row) => row.provider))).toEqual(
      new Set(["openai", "deepseek"]),
    );
  });
});

systemDescribe("G1 frozen-prefix schema-extension admission", () => {
  let database: IsolatedPostgresSchema | undefined;

  beforeEach(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl!);
    await runMigrations(database.pool);
  });

  afterEach(async () => {
    await database?.dispose();
    database = undefined;
  });

  function repositoryFor(
    prefix: readonly AppliedMigration[],
  ): PostgresModelRoleCommandRepository {
    return new PostgresModelRoleCommandRepository(
      database!.pool,
      { migrations: prefix, fingerprint: schemaFingerprint },
      schemaFingerprint,
    );
  }

  function recover(repository: PostgresModelRoleCommandRepository) {
    return repository.recoverAttempt({
      userId: asUserId("11111111-1111-7111-8111-111111111111"),
      generationCommandId: asGenerationCommandId(
        "22222222-2222-7222-8222-222222222222",
      ),
      modelRunAttemptId: asModelRunAttemptId(
        "33333333-3333-7333-8333-333333333333",
      ),
      now: new Date("2026-10-08T10:00:00.000Z"),
    });
  }

  it("admits the registered additive extensions after the exact frozen prefix", async () => {
    const applied = await appliedMigrations(database!);
    const frozenPrefix = applied.filter(
      (migration) =>
        !(REGISTERED_EXTENSION_NAMES as readonly string[]).includes(
          migration.name,
        ),
    );
    await expect(recover(repositoryFor(frozenPrefix))).resolves.toEqual({
      outcome: "settled",
      terminalOutcome: "discarded",
    });
  }, 60_000);

  it("reproduces the exact-equality contract when nothing follows the prefix", async () => {
    const applied = await appliedMigrations(database!);
    await expect(recover(repositoryFor(applied))).resolves.toEqual({
      outcome: "settled",
      terminalOutcome: "discarded",
    });
  }, 60_000);

  it("fails closed on an applied migration that is not registered", async () => {
    const applied = await appliedMigrations(database!);
    await database!.pool.query(
      `INSERT INTO schema_migrations (migration_name, migration_sha256)
       VALUES ('9999_unregistered.sql', $1)`,
      ["a".repeat(64)],
    );
    await expect(recover(repositoryFor(applied))).rejects.toThrow(
      /does not match the frozen G1 migration contract/,
    );
  }, 60_000);

  it("fails closed when a frozen prefix row hash drifts", async () => {
    const applied = await appliedMigrations(database!);
    const [first, ...rest] = applied;
    const drifted = [
      { name: first!.name, sha256: "e".repeat(64) },
      ...rest,
    ];
    await expect(recover(repositoryFor(drifted))).rejects.toThrow(
      /does not match the frozen G1 migration contract/,
    );
  }, 60_000);
});
