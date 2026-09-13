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

describe("runtime safety configuration", () => {
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
    const gitCommit = "a".repeat(40);
    const manifest = buildOneA3bG1ReleaseManifest({
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
        f3ManifestFingerprint: `sha256:${"e".repeat(64)}`,
        totalCases: 18,
        acceptedCases: 17,
        maxRejects: 1,
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

    expect(() =>
      resolveOneA3bG1ReleaseManifest({
        SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(manifest),
        SAYHEAR_DEPLOYED_GIT_COMMIT_SHA: gitCommit,
        SAYHEAR_EPISODE_BUILD_ENABLED: "true",
        SAYHEAR_REFLECTION_ENABLED: "true",
      }),
    ).not.toThrow();
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
    expect(loadRuntimeConfiguration(base).writeSwitches).toEqual({ episodeBuildEnabled: false, evidenceExtractionEnabled: true, fastPathExtractionEnabled: true, journalPublishEnabled: true, memoryConsolidationEnabled: true, memoryRetrievalEnabled: true, reflectionEnabled: false });
    expect(loadRuntimeConfiguration({ ...base, SAYHEAR_EVIDENCE_EXTRACTION_ENABLED: "false" }).writeSwitches)
      .toEqual({ episodeBuildEnabled: false, evidenceExtractionEnabled: false, fastPathExtractionEnabled: true, journalPublishEnabled: true, memoryConsolidationEnabled: true, memoryRetrievalEnabled: true, reflectionEnabled: false });
    expect(loadRuntimeConfiguration({ ...base, SAYHEAR_JOURNAL_PUBLISH_ENABLED: "false" }).writeSwitches)
      .toEqual({ episodeBuildEnabled: false, evidenceExtractionEnabled: true, fastPathExtractionEnabled: true, journalPublishEnabled: false, memoryConsolidationEnabled: true, memoryRetrievalEnabled: true, reflectionEnabled: false });
    expect(loadRuntimeConfiguration({ ...base, SAYHEAR_MEMORY_CONSOLIDATION_ENABLED: "false" }).writeSwitches)
      .toEqual({ episodeBuildEnabled: false, evidenceExtractionEnabled: true, fastPathExtractionEnabled: true, journalPublishEnabled: true, memoryConsolidationEnabled: false, memoryRetrievalEnabled: true, reflectionEnabled: false });
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
