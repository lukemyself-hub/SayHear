import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildOneA3bG1ReleaseManifest,
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA,
} from "@sayhear/application";

import {
  assertSafeRuntimeConfiguration,
  loadRuntimeConfiguration,
  resolveOneA3bG1ReleaseManifest,
} from "../apps/web/src/runtime-config";

function buildActiveG1Manifest(gitCommit: string) {
  return buildOneA3bG1ReleaseManifest({
    gitCommit,
    migrations: [{ name: "0052_release.sql", sha256: "b".repeat(64) }],
    purgeMarkerMigrations: [
      { name: "0002_marker.sql", sha256: "c".repeat(64) },
    ],
    roleConfigurations: ONE_A_3B_G1_ENABLED_ROLES.map((role) => ({
      role,
      configVersion: `${role}:v1`,
      provider: "synthetic-provider",
      model: "synthetic-model",
      modelSnapshot: "synthetic-model@2026-09-12",
      promptVersion: `${role}-prompt:v1`,
      schemaVersion: `${role}-schema:v1`,
      rolePolicyVersion: "1a3b-model-role-policy:v1",
      providerPolicyVersion: `${role}-egress:v1`,
      rolloutPin: `${role}-rollout:v1`,
      freshnessPolicy:
        role === "episode.build" ? "source_valid:v1" : "exact_head:v1",
      fallbackMode: "disabled",
      maxTechnicalRetries: 1,
      maxSemanticRepairs: 0,
      parameterSnapshot: { temperature: 0 },
    })),
    fixture: {
      f3ManifestPath: "release-evidence/not-deployed/manifest.json",
      f3ManifestSha256: "d".repeat(64),
      f3ManifestFingerprint: `sha256:${"e".repeat(64)}`,
      fixtureSeed: 196,
      sampleSeed: 1960,
    },
    validatorCalibration: {
      ledgerPath: "release-evidence/not-deployed/validator-ledger.json",
      ledgerSha256: "f".repeat(64),
      ledgerVersion: "1a3b-f3-adjudication:v1",
      precisionReportPath:
        "release-evidence/not-deployed/validator-precision-report.json",
      precisionReportSha256: "1".repeat(64),
      precisionReportVersion: "1a3b-f3-validator-precision-report:v1",
      precisionTotalCases: 6,
      precisionFalseBlockingCases: 0,
      f3ManifestFingerprint: `sha256:${"e".repeat(64)}`,
      totalCases: 6,
      acceptedCases: 6,
      maxRejects: 0,
      humanOwner: "Luke",
      status: "verified",
    },
    commands: ["CI=true pnpm validate"],
    evidence: ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA.map(
      (criterion, index) => ({
        criterion,
        fixtureIds: ["synthetic-fixture"],
        command: `verify ${criterion}`,
        artifactSha256: (index + 1).toString(16).repeat(64),
        artifactPath: `release-evidence/not-deployed/${criterion.toLowerCase()}.json`,
        owner: "Luke",
        source:
          criterion === "AC-M01"
            ? "provider"
            : criterion === "AC-W01" || criterion === "AC-D01"
              ? "hosted"
              : "ci",
        status: "verified",
      }),
    ),
    cutoverState: "active",
    createdAt: "2026-09-12T00:00:00.000Z",
  });
}

describe("runtime safety configuration", () => {
  it("rejects leftover G2 switches and release pins at startup", () => {
    for (const name of [
      "SAYHEAR_OPEN_LOOP_EXTRACTION_ENABLED",
      "SAYHEAR_PROACTIVE_FOLLOWUP_ENABLED",
      "SAYHEAR_1A_3B_G2_RELEASE_MANIFEST",
    ]) {
      expect(() => assertSafeRuntimeConfiguration({ [name]: "false" })).toThrow(name);
    }
  });

  it("allows a fixed principal only in the test environment", () => {
    expect(() =>
      assertSafeRuntimeConfiguration({
        NODE_ENV: "production",
        SAYHEAR_TEST_PRINCIPAL_SUBJECT: "test-owner",
      }),
    ).toThrow("test principal");

    expect(() =>
      assertSafeRuntimeConfiguration({
        NODE_ENV: "test",
        SAYHEAR_TEST_PRINCIPAL_SUBJECT: "test-owner",
      }),
    ).not.toThrow();
  });

  it("rejects development signing material in preview and production", () => {
    for (const deployment of ["preview", "production"]) {
      expect(() =>
        assertSafeRuntimeConfiguration({
          SAYHEAR_AUTH_SECRET_SOURCE: "development",
          SAYHEAR_DEPLOYMENT: deployment,
        }),
      ).toThrow("development signing material");
    }
  });

  it("does not let an explicit setting downgrade an authoritative deployment", () => {
    expect(() =>
      assertSafeRuntimeConfiguration({
        SAYHEAR_DEPLOYMENT: "test",
        SAYHEAR_TEST_PRINCIPAL_SUBJECT: "test-owner",
        VERCEL_ENV: "production",
      }),
    ).toThrow();

    expect(() =>
      assertSafeRuntimeConfiguration({
        NODE_ENV: "production",
        SAYHEAR_AUTH_SECRET_SOURCE: "development",
        SAYHEAR_DEPLOYMENT: "development",
      }),
    ).toThrow();
  });

  it("allows controlled time only in the test deployment", () => {
    expect(() =>
      assertSafeRuntimeConfiguration({
        SAYHEAR_DEPLOYMENT: "production",
        SAYHEAR_TEST_NOW: "2026-07-27T16:00:00.000Z",
      }),
    ).toThrow("only in the test environment");

    expect(
      assertSafeRuntimeConfiguration({
        SAYHEAR_DEPLOYMENT: "test",
        SAYHEAR_TEST_NOW: "2026-07-27T16:00:00.000Z",
      }),
    ).toBe("test");
  });

  it("allows a file-driven controlled clock only in the test deployment", () => {
    expect(() =>
      assertSafeRuntimeConfiguration({
        SAYHEAR_DEPLOYMENT: "production",
        SAYHEAR_TEST_NOW_FILE: "/tmp/acceptance-clock",
      }),
    ).toThrow("only in the test environment");
  });

  it("re-reads the controlled instant from the clock file on every call", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sayhear-clock-"));
    const clockFile = path.join(directory, "now");
    const base = {
      CRON_SECRET: "cron",
      DATABASE_URL: "postgres://test",
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      NEXTAUTH_SECRET: "auth",
      PURGE_MARKER_DATABASE_URL: "postgres://test-marker",
      SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "fingerprint",
      SAYHEAR_BACKUP_POLICY_VERSION: "backup:v1",
      SAYHEAR_CONTEXT_HMAC_SECRET: "context",
      SAYHEAR_DEPLOYMENT: "test",
      SAYHEAR_PROVIDER_ADAPTER: "deterministic",
      SAYHEAR_TEST_NOW_FILE: clockFile,
      SAYHEAR_TEST_PROVIDER_CHUNKS: '["ok"]',
    };
    try {
      writeFileSync(clockFile, "2026-07-27T16:00:00.000Z\n");
      const configuration = loadRuntimeConfiguration(base);
      expect(configuration.clock().toISOString()).toBe("2026-07-27T16:00:00.000Z");
      writeFileSync(clockFile, "2026-07-28T07:30:00.000Z");
      expect(configuration.clock().toISOString()).toBe("2026-07-28T07:30:00.000Z");

      // An unreadable instant never silently falls back to the wall clock.
      writeFileSync(clockFile, "not-a-date");
      expect(() => configuration.clock()).toThrow("SAYHEAR_TEST_NOW_FILE");
      expect(() =>
        loadRuntimeConfiguration({
          ...base,
          SAYHEAR_TEST_NOW: "2026-07-27T16:00:00.000Z",
        }),
      ).toThrow("SAYHEAR_TEST_NOW_FILE");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps deterministic completion faults test-only", () => {
    expect(() =>
      assertSafeRuntimeConfiguration({
        SAYHEAR_DEPLOYMENT: "production",
        SAYHEAR_TEST_PROVIDER_FAIL_AFTER_COMPLETION: "true",
      }),
    ).toThrow("only in the test environment");

    expect(
      assertSafeRuntimeConfiguration({
        SAYHEAR_DEPLOYMENT: "test",
        SAYHEAR_TEST_PROVIDER_FAIL_AFTER_COMPLETION: "true",
      }),
    ).toBe("test");
  });

  it("requires an exact G1 release artifact before opening a G1 write switch", () => {
    expect(() =>
      assertSafeRuntimeConfiguration({
        SAYHEAR_DEPLOYMENT: "test",
        SAYHEAR_EPISODE_BUILD_ENABLED: "true",
        SAYHEAR_REFLECTION_ENABLED: "true",
      }),
    ).toThrow("SAYHEAR_1A_3B_G1_RELEASE_MANIFEST is required");

    expect(() =>
      resolveOneA3bG1ReleaseManifest({
        SAYHEAR_DEPLOYMENT: "test",
        SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: "not-json",
      }),
    ).toThrow("valid JSON");
  });

  it("verifies an active G1 manifest without requiring release evidence in the deployed checkout", () => {
    const manifest = buildActiveG1Manifest("a".repeat(40));

    expect(() =>
      resolveOneA3bG1ReleaseManifest({
        SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(manifest),
        SAYHEAR_DEPLOYED_GIT_COMMIT_SHA: manifest.gitCommit,
        SAYHEAR_EPISODE_BUILD_ENABLED: "true",
        SAYHEAR_REFLECTION_ENABLED: "true",
      }),
    ).not.toThrow();
  });

  it("accepts a same-configuration UI commit whose deployment SHA differs from the acceptance commit", () => {
    const manifest = buildActiveG1Manifest("a".repeat(40));
    const resolved = resolveOneA3bG1ReleaseManifest({
      SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(manifest),
      VERCEL_GIT_COMMIT_SHA: "b".repeat(40),
      SAYHEAR_EPISODE_BUILD_ENABLED: "true",
      SAYHEAR_REFLECTION_ENABLED: "true",
    });
    // The acceptance commit is preserved; the deployment identity is separate.
    expect(resolved?.gitCommit).toBe("a".repeat(40));
  });

  it("accepts a same-configuration server commit recorded through the explicit deployment SHA", () => {
    const manifest = buildActiveG1Manifest("a".repeat(40));
    const resolved = resolveOneA3bG1ReleaseManifest({
      SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(manifest),
      SAYHEAR_DEPLOYED_GIT_COMMIT_SHA: "c".repeat(40),
      SAYHEAR_DEPLOYMENT: "production",
      SAYHEAR_EPISODE_BUILD_ENABLED: "true",
      SAYHEAR_REFLECTION_ENABLED: "true",
    });
    expect(resolved?.gitCommit).toBe("a".repeat(40));
  });

  it.each(["", "  "])(
    "uses the explicit deployment SHA when Vercel supplies a blank Git SHA (%j)",
    (vercelSha) => {
      const manifest = buildActiveG1Manifest("a".repeat(40));
      expect(
        resolveOneA3bG1ReleaseManifest({
          SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(manifest),
          VERCEL_GIT_COMMIT_SHA: vercelSha,
          SAYHEAR_DEPLOYED_GIT_COMMIT_SHA: "c".repeat(40),
          SAYHEAR_EPISODE_BUILD_ENABLED: "true",
          SAYHEAR_REFLECTION_ENABLED: "true",
        })?.gitCommit,
      ).toBe(manifest.gitCommit);
    },
  );

  it("still requires a deployment identity before a G1 write switch can open", () => {
    const manifest = buildActiveG1Manifest("a".repeat(40));
    expect(() =>
      resolveOneA3bG1ReleaseManifest({
        SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(manifest),
        SAYHEAR_EPISODE_BUILD_ENABLED: "true",
        SAYHEAR_REFLECTION_ENABLED: "true",
      }),
    ).toThrow("SAYHEAR_DEPLOYED_GIT_COMMIT_SHA or VERCEL_GIT_COMMIT_SHA");
  });

  it("requires the Episode and Reflection G1 switches to cut over atomically", () => {
    expect(() =>
      resolveOneA3bG1ReleaseManifest({
        SAYHEAR_EPISODE_BUILD_ENABLED: "true",
        SAYHEAR_REFLECTION_ENABLED: "false",
      }),
    ).toThrow("must be enabled together");
    expect(() =>
      resolveOneA3bG1ReleaseManifest({
        SAYHEAR_EPISODE_BUILD_ENABLED: "false",
        SAYHEAR_REFLECTION_ENABLED: "true",
      }),
    ).toThrow("must be enabled together");
  });

  it("defaults Journal and Evidence write switches to enabled and parses each independently", () => {
    const base = {
      CRON_SECRET: "cron", DATABASE_URL: "postgres://test", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret",
      NEXTAUTH_SECRET: "auth", PURGE_MARKER_DATABASE_URL: "postgres://test-marker", SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "fingerprint", SAYHEAR_BACKUP_POLICY_VERSION: "backup:v1",
      SAYHEAR_CONTEXT_HMAC_SECRET: "context", SAYHEAR_DEPLOYMENT: "test", SAYHEAR_PROVIDER_ADAPTER: "deterministic",
      SAYHEAR_TEST_PROVIDER_CHUNKS: '["ok"]',
    };
    expect(loadRuntimeConfiguration(base).writeSwitches).toEqual({ episodeBuildEnabled: false, historyRecallEnabled: false, evidenceExtractionEnabled: true, fastPathExtractionEnabled: true, journalPublishEnabled: true, memoryConsolidationEnabled: true, memoryRetrievalEnabled: true, reflectionEnabled: false });
    expect(loadRuntimeConfiguration({ ...base, SAYHEAR_EVIDENCE_EXTRACTION_ENABLED: "false" }).writeSwitches)
      .toEqual({ episodeBuildEnabled: false, historyRecallEnabled: false, evidenceExtractionEnabled: false, fastPathExtractionEnabled: true, journalPublishEnabled: true, memoryConsolidationEnabled: true, memoryRetrievalEnabled: true, reflectionEnabled: false });
    expect(loadRuntimeConfiguration({ ...base, SAYHEAR_JOURNAL_PUBLISH_ENABLED: "false" }).writeSwitches)
      .toEqual({ episodeBuildEnabled: false, historyRecallEnabled: false, evidenceExtractionEnabled: true, fastPathExtractionEnabled: true, journalPublishEnabled: false, memoryConsolidationEnabled: true, memoryRetrievalEnabled: true, reflectionEnabled: false });
    expect(loadRuntimeConfiguration({ ...base, SAYHEAR_MEMORY_CONSOLIDATION_ENABLED: "false" }).writeSwitches)
      .toEqual({ episodeBuildEnabled: false, historyRecallEnabled: false, evidenceExtractionEnabled: true, fastPathExtractionEnabled: true, journalPublishEnabled: true, memoryConsolidationEnabled: false, memoryRetrievalEnabled: true, reflectionEnabled: false });
  });

  it("configures OpenCode Go as an exact honest identity with no baseUrl and no silent rename", () => {
    const goBase = {
      CRON_SECRET: "cron",
      DATABASE_URL: "postgres://test",
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      NEXTAUTH_SECRET: "auth",
      OPENCODE_GO_API_KEY: "go-key",
      PURGE_MARKER_DATABASE_URL: "postgres://test-marker",
      SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "fingerprint",
      SAYHEAR_BACKUP_POLICY_VERSION: "backup:v1",
      SAYHEAR_CONTEXT_HMAC_SECRET: "context",
      SAYHEAR_DEPLOYMENT: "test",
      SAYHEAR_PROVIDER_ADAPTER: "opencode-go",
    };
    const configuration = loadRuntimeConfiguration(goBase);
    expect(configuration.provider.adapter).toBe("opencode-go");
    expect(configuration.provider.champion.provider).toBe("opencode-go");
    expect(configuration.provider.champion.model).toBe("deepseek-v4.1-flash");
    expect(configuration.provider.champion.snapshot).toBe("deepseek-v4.1-flash");
    expect(configuration.provider.champion.providerPolicyVersion).toBe(
      "opencode-go-conversation-text:v1",
    );
    expect(configuration.provider.champion.dataRegion).toBe("provider-managed");
    // The fixed Go endpoint has no caller-selectable baseUrl.
    expect(configuration.provider).not.toHaveProperty("baseUrl");
    expect(configuration.provider.roleAdapters["opencode-go"]).toEqual({
      apiKey: "go-key",
      provider: "opencode-go",
      timeoutMs: 60000,
    });

    // The credential is required for the selected Go adapter.
    const { OPENCODE_GO_API_KEY: _omitted, ...withoutKey } = goBase;
    void _omitted;
    expect(() => loadRuntimeConfiguration(withoutKey)).toThrow(
      "OPENCODE_GO_API_KEY",
    );

    // An explicit legacy model override is passed through, never silently
    // renamed to the Go model; the transport refuses the wrong model at
    // dispatch instead of substituting.
    const explicit = loadRuntimeConfiguration({
      ...goBase,
      SAYHEAR_CONVERSATION_TEXT_MODEL: "deepseek-v4-flash",
    });
    expect(explicit.provider.champion.model).toBe("deepseek-v4-flash");
    expect(explicit.provider.champion.provider).toBe("opencode-go");
  });

  it("bounds a chat request at 30 seconds independently of the background-role Provider timeout (issue #319)", () => {
    const base = {
      CRON_SECRET: "cron",
      DATABASE_URL: "postgres://test",
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      NEXTAUTH_SECRET: "auth",
      OPENCODE_GO_API_KEY: "go-key",
      PURGE_MARKER_DATABASE_URL: "postgres://test-marker",
      SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "fingerprint",
      SAYHEAR_BACKUP_POLICY_VERSION: "backup:v1",
      SAYHEAR_CONTEXT_HMAC_SECRET: "context",
      SAYHEAR_DEPLOYMENT: "test",
      SAYHEAR_PROVIDER_ADAPTER: "opencode-go",
    };
    const defaults = loadRuntimeConfiguration(base);
    expect(defaults.conversationRequest).toEqual({
      budgetMs: 60_000,
      providerTimeoutMs: 60_000,
    });
    // The shared role timeout is untouched by the conversation path.
    expect(defaults.provider.timeoutMs).toBe(60_000);

    // A slow background role (memory extraction needs minutes) must never
    // loosen the chat stop condition, and the reverse holds too.
    const longRoles = loadRuntimeConfiguration({
      ...base,
      SAYHEAR_PROVIDER_TIMEOUT_MS: "180000",
    });
    expect(longRoles.provider.timeoutMs).toBe(180_000);
    expect(longRoles.provider.roleAdapters["opencode-go"]?.timeoutMs).toBe(180_000);
    expect(longRoles.conversationRequest.providerTimeoutMs).toBe(60_000);

    const tighter = loadRuntimeConfiguration({
      ...base,
      SAYHEAR_CONVERSATION_PROVIDER_TIMEOUT_MS: "20000",
      SAYHEAR_CONVERSATION_REQUEST_BUDGET_MS: "25000",
    });
    expect(tighter.conversationRequest).toEqual({
      budgetMs: 25_000,
      providerTimeoutMs: 20_000,
    });
    expect(tighter.provider.timeoutMs).toBe(60_000);

    // The product stop condition can be tightened, never loosened.
    for (const value of ["60001", "0", "-5", "1.5", "abc"]) {
      expect(() =>
        loadRuntimeConfiguration({
          ...base,
          SAYHEAR_CONVERSATION_REQUEST_BUDGET_MS: value,
        }),
      ).toThrow("SAYHEAR_CONVERSATION_REQUEST_BUDGET_MS");
    }
    expect(() =>
      loadRuntimeConfiguration({
        ...base,
        SAYHEAR_CONVERSATION_PROVIDER_TIMEOUT_MS: "60001",
      }),
    ).toThrow("SAYHEAR_CONVERSATION_PROVIDER_TIMEOUT_MS");
  });

  it("accepts only the four known Provider adapters and keeps the unset openai default", () => {
    const base: Record<string, string> = {
      CRON_SECRET: "cron",
      DATABASE_URL: "postgres://test",
      DEEPSEEK_API_KEY: "deepseek-key",
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
      NEXTAUTH_SECRET: "auth",
      OPENAI_API_KEY: "openai-key",
      OPENCODE_GO_API_KEY: "go-key",
      PURGE_MARKER_DATABASE_URL: "postgres://test-marker",
      SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "fingerprint",
      SAYHEAR_BACKUP_POLICY_VERSION: "backup:v1",
      SAYHEAR_CONTEXT_HMAC_SECRET: "context",
      SAYHEAR_DEPLOYMENT: "test",
      SAYHEAR_TEST_PROVIDER_CHUNKS: '["ok"]',
    };
    // Unset keeps the historical openai default.
    expect(loadRuntimeConfiguration(base).provider.adapter).toBe("openai");
    for (const adapter of [
      "openai",
      "deepseek",
      "deterministic",
      "opencode-go",
    ]) {
      expect(
        loadRuntimeConfiguration({
          ...base,
          SAYHEAR_PROVIDER_ADAPTER: adapter,
        }).provider.adapter,
      ).toBe(adapter);
    }
    // Any explicit unknown, typo, or empty value fails at load with a fixed
    // message that names the choices and never echoes the invalid value.
    for (const invalid of ["opengpt", "", " openai", "OPENAI", "gpt-5"]) {
      expect(() =>
        loadRuntimeConfiguration({
          ...base,
          SAYHEAR_PROVIDER_ADAPTER: invalid,
        }),
      ).toThrow(
        "SAYHEAR_PROVIDER_ADAPTER must be one of openai, deepseek, deterministic, opencode-go.",
      );
    }
  });

  it("requires the purge marker store to be a separate database from the business database", () => {
    const base = {
      CRON_SECRET: "cron", DATABASE_URL: "postgres://test", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret",
      NEXTAUTH_SECRET: "auth", PURGE_MARKER_DATABASE_URL: "postgres://test-marker", SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "fingerprint", SAYHEAR_BACKUP_POLICY_VERSION: "backup:v1",
      SAYHEAR_CONTEXT_HMAC_SECRET: "context", SAYHEAR_DEPLOYMENT: "test", SAYHEAR_PROVIDER_ADAPTER: "deterministic",
      SAYHEAR_TEST_PROVIDER_CHUNKS: '["ok"]',
    };
    expect(() =>
      loadRuntimeConfiguration({
        ...base,
        PURGE_MARKER_DATABASE_URL: base.DATABASE_URL,
      }),
    ).toThrow("separate database");
    // The startup assertion (validate-startup.ts) fails closed on the same
    // invariant even before a composition is built.
    expect(() =>
      assertSafeRuntimeConfiguration({
        DATABASE_URL: "postgres://test",
        PURGE_MARKER_DATABASE_URL: "postgres://test",
      }),
    ).toThrow("separate database");
    expect(
      assertSafeRuntimeConfiguration({
        DATABASE_URL: "postgres://test",
        PURGE_MARKER_DATABASE_URL: "postgres://test-marker",
      }),
    ).toBe("development");
    expect(
      loadRuntimeConfiguration(base).ownerPurge.providerRetentionDays,
    ).toBe(30);
    expect(() =>
      loadRuntimeConfiguration({
        ...base,
        SAYHEAR_PROVIDER_RETENTION_DAYS: "0",
      }),
    ).toThrow("SAYHEAR_PROVIDER_RETENTION_DAYS");
  });
});
