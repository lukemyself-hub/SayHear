import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const systemDescribe = testDatabaseUrl ? describe : describe.skip;

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
