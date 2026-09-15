import { describe, expect, it } from "vitest";

import {
  buildOneA3bG1ReleaseManifest,
  buildOneA3bG2ReleaseManifest,
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_G1_REQUIRED_ACCEPTANCE_CRITERIA,
  ONE_A_3B_G2_ENABLED_ROLES,
  ONE_A_3B_G2_REQUIRED_ACCEPTANCE_CRITERIA,
  ONE_A_3B_ROLE_POLICIES,
} from "@sayhear/application";

import {
  assertSafeRuntimeConfiguration,
  loadRuntimeConfiguration,
  resolveOneA3bG1ReleaseManifest,
  resolveOneA3bG2ReleaseManifest,
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
        precisionReportPath:
          "release-evidence/not-deployed/validator-precision-report.json",
        precisionReportSha256: "1".repeat(64),
        precisionReportVersion: "1a3b-f3-validator-precision-report:v1",
        precisionTotalCases: 6,
        precisionFalseBlockingCases: 0,
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

  it("resolves a linked G2 bundle manifest without requiring release evidence in the deployed checkout", () => {
    const gitCommit = "a".repeat(40);
    const g1 = buildActiveG1ForG2(gitCommit);
    const g2 = buildLinkedG2ForG2(gitCommit, g1.fingerprint, {});
    const resolved = resolveOneA3bG2ReleaseManifest({
      SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(g1),
      SAYHEAR_1A_3B_G2_RELEASE_MANIFEST: JSON.stringify(g2),
      SAYHEAR_DEPLOYED_GIT_COMMIT_SHA: gitCommit,
      SAYHEAR_EPISODE_BUILD_ENABLED: "true",
      SAYHEAR_REFLECTION_ENABLED: "true",
    });
    expect(resolved?.fingerprint).toBe(g2.fingerprint);
    expect(resolved?.baseG1ReleaseFingerprint).toBe(g1.fingerprint);
  });

  it("keeps the G2 stage closed when no G2 manifest is configured", () => {
    expect(resolveOneA3bG2ReleaseManifest({})).toBeNull();
    expect(
      resolveOneA3bG2ReleaseManifest({
        SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(
          buildActiveG1ForG2("a".repeat(40)),
        ),
      }),
    ).toBeNull();
    expect(
      loadRuntimeConfiguration({
        CRON_SECRET: "cron", DATABASE_URL: "postgres://test", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret",
        NEXTAUTH_SECRET: "auth", PURGE_MARKER_DATABASE_URL: "postgres://test-marker", SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "fingerprint", SAYHEAR_BACKUP_POLICY_VERSION: "backup:v1",
        SAYHEAR_CONTEXT_HMAC_SECRET: "context", SAYHEAR_DEPLOYMENT: "test", SAYHEAR_PROVIDER_ADAPTER: "deterministic",
        SAYHEAR_TEST_PROVIDER_CHUNKS: '["ok"]',
      }).oneA3bG2.releaseManifest,
    ).toBeNull();
  });

  it("requires both G2 write switches together before resolving a G2 manifest", () => {
    const gitCommit = "a".repeat(40);
    const g1 = buildActiveG1ForG2(gitCommit);
    const g2 = buildLinkedG2ForG2(gitCommit, g1.fingerprint, {
      cutoverState: "active",
    });
    const base = {
      SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(g1),
      SAYHEAR_1A_3B_G2_RELEASE_MANIFEST: JSON.stringify(g2),
      SAYHEAR_DEPLOYED_GIT_COMMIT_SHA: gitCommit,
      SAYHEAR_EPISODE_BUILD_ENABLED: "true",
      SAYHEAR_REFLECTION_ENABLED: "true",
    };
    expect(() =>
      resolveOneA3bG2ReleaseManifest({
        ...base,
        SAYHEAR_OPEN_LOOP_EXTRACTION_ENABLED: "true",
      }),
    ).toThrow("must be enabled together");
    expect(() =>
      resolveOneA3bG2ReleaseManifest({
        ...base,
        SAYHEAR_PROACTIVE_FOLLOWUP_ENABLED: "true",
      }),
    ).toThrow("must be enabled together");
    expect(
      resolveOneA3bG2ReleaseManifest({
        ...base,
        SAYHEAR_OPEN_LOOP_EXTRACTION_ENABLED: "true",
        SAYHEAR_PROACTIVE_FOLLOWUP_ENABLED: "true",
      })?.fingerprint,
    ).toBe(g2.fingerprint);
  });

  it("requires the G2 artifact when a G2 write switch opens", () => {
    expect(() =>
      resolveOneA3bG2ReleaseManifest({
        SAYHEAR_OPEN_LOOP_EXTRACTION_ENABLED: "true",
        SAYHEAR_PROACTIVE_FOLLOWUP_ENABLED: "true",
      }),
    ).toThrow("SAYHEAR_1A_3B_G2_RELEASE_MANIFEST is required");
  });

  it("defaults the G2 write switches to closed and parses each through the bundle gate", () => {
    const base = {
      CRON_SECRET: "cron", DATABASE_URL: "postgres://test", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret",
      NEXTAUTH_SECRET: "auth", PURGE_MARKER_DATABASE_URL: "postgres://test-marker", SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "fingerprint", SAYHEAR_BACKUP_POLICY_VERSION: "backup:v1",
      SAYHEAR_CONTEXT_HMAC_SECRET: "context", SAYHEAR_DEPLOYMENT: "test", SAYHEAR_PROVIDER_ADAPTER: "deterministic",
      SAYHEAR_TEST_PROVIDER_CHUNKS: '["ok"]',
    };
    expect(loadRuntimeConfiguration(base).writeSwitches).toEqual({
      episodeBuildEnabled: false,
      evidenceExtractionEnabled: true,
      fastPathExtractionEnabled: true,
      journalPublishEnabled: true,
      memoryConsolidationEnabled: true,
      memoryRetrievalEnabled: true,
      openLoopExtractionEnabled: false,
      proactiveFollowupEnabled: false,
      reflectionEnabled: false,
    });
    expect(() =>
      loadRuntimeConfiguration({
        ...base,
        SAYHEAR_OPEN_LOOP_EXTRACTION_ENABLED: "true",
        SAYHEAR_PROACTIVE_FOLLOWUP_ENABLED: "true",
        SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(
          buildActiveG1ForG2("a".repeat(40)),
        ),
      }),
    ).toThrow("SAYHEAR_1A_3B_G2_RELEASE_MANIFEST is required");
  });

  it("rejects a malformed or structurally invalid G2 manifest", () => {
    expect(() =>
      resolveOneA3bG2ReleaseManifest({
        SAYHEAR_1A_3B_G2_RELEASE_MANIFEST: "not-json",
      }),
    ).toThrow("valid JSON");
    expect(() =>
      resolveOneA3bG2ReleaseManifest({
        SAYHEAR_1A_3B_G2_RELEASE_MANIFEST: "{}",
      }),
    ).toThrow("is invalid");
  });

  it("requires the switched G1 release before resolving a G2 manifest", () => {
    const gitCommit = "a".repeat(40);
    const orphan = buildLinkedG2ForG2(gitCommit, `sha256:${"f".repeat(64)}`, {});
    expect(() =>
      resolveOneA3bG2ReleaseManifest({
        SAYHEAR_1A_3B_G2_RELEASE_MANIFEST: JSON.stringify(orphan),
        SAYHEAR_DEPLOYED_GIT_COMMIT_SHA: gitCommit,
      }),
    ).toThrow("G1");
    expect(() =>
      assertSafeRuntimeConfiguration({
        SAYHEAR_DEPLOYMENT: "test",
        SAYHEAR_1A_3B_G2_RELEASE_MANIFEST: JSON.stringify(orphan),
        SAYHEAR_DEPLOYED_GIT_COMMIT_SHA: gitCommit,
      }),
    ).toThrow("G1");
  });

  it("refuses a G2 manifest linked to another G1 release", () => {
    const gitCommit = "a".repeat(40);
    const g1 = buildActiveG1ForG2(gitCommit);
    const g2 = buildLinkedG2ForG2(gitCommit, `sha256:${"0".repeat(64)}`, {});
    expect(() =>
      resolveOneA3bG2ReleaseManifest({
        SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(g1),
        SAYHEAR_1A_3B_G2_RELEASE_MANIFEST: JSON.stringify(g2),
        SAYHEAR_DEPLOYED_GIT_COMMIT_SHA: gitCommit,
        SAYHEAR_EPISODE_BUILD_ENABLED: "true",
        SAYHEAR_REFLECTION_ENABLED: "true",
      }),
    ).toThrow("link");
  });

  it("refuses a G2 manifest while its G1 base is not active", () => {
    const gitCommit = "a".repeat(40);
    const g1 = buildActiveG1ForG2(gitCommit, { cutoverState: "disabled" });
    expect(g1.status).not.toBe("active");
    const g2 = buildLinkedG2ForG2(gitCommit, g1.fingerprint, {});
    expect(() =>
      resolveOneA3bG2ReleaseManifest({
        SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(g1),
        SAYHEAR_1A_3B_G2_RELEASE_MANIFEST: JSON.stringify(g2),
        SAYHEAR_DEPLOYED_GIT_COMMIT_SHA: gitCommit,
      }),
    ).toThrow("active");
  });

  it("rejects a G2 manifest built for another commit", () => {
    const gitCommit = "a".repeat(40);
    const g1 = buildActiveG1ForG2(gitCommit);
    const g2 = buildLinkedG2ForG2(gitCommit, g1.fingerprint, {});
    expect(() =>
      resolveOneA3bG2ReleaseManifest({
        SAYHEAR_1A_3B_G1_RELEASE_MANIFEST: JSON.stringify(g1),
        SAYHEAR_1A_3B_G2_RELEASE_MANIFEST: JSON.stringify(g2),
        SAYHEAR_DEPLOYED_GIT_COMMIT_SHA: "b".repeat(40),
        SAYHEAR_EPISODE_BUILD_ENABLED: "true",
        SAYHEAR_REFLECTION_ENABLED: "true",
      }),
    ).toThrow("deployed commit");
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
    expect(loadRuntimeConfiguration(base).writeSwitches).toEqual({ episodeBuildEnabled: false, evidenceExtractionEnabled: true, fastPathExtractionEnabled: true, journalPublishEnabled: true, memoryConsolidationEnabled: true, memoryRetrievalEnabled: true, openLoopExtractionEnabled: false, proactiveFollowupEnabled: false, reflectionEnabled: false });
    expect(loadRuntimeConfiguration({ ...base, SAYHEAR_EVIDENCE_EXTRACTION_ENABLED: "false" }).writeSwitches)
      .toEqual({ episodeBuildEnabled: false, evidenceExtractionEnabled: false, fastPathExtractionEnabled: true, journalPublishEnabled: true, memoryConsolidationEnabled: true, memoryRetrievalEnabled: true, openLoopExtractionEnabled: false, proactiveFollowupEnabled: false, reflectionEnabled: false });
    expect(loadRuntimeConfiguration({ ...base, SAYHEAR_JOURNAL_PUBLISH_ENABLED: "false" }).writeSwitches)
      .toEqual({ episodeBuildEnabled: false, evidenceExtractionEnabled: true, fastPathExtractionEnabled: true, journalPublishEnabled: false, memoryConsolidationEnabled: true, memoryRetrievalEnabled: true, openLoopExtractionEnabled: false, proactiveFollowupEnabled: false, reflectionEnabled: false });
    expect(loadRuntimeConfiguration({ ...base, SAYHEAR_MEMORY_CONSOLIDATION_ENABLED: "false" }).writeSwitches)
      .toEqual({ episodeBuildEnabled: false, evidenceExtractionEnabled: true, fastPathExtractionEnabled: true, journalPublishEnabled: true, memoryConsolidationEnabled: false, memoryRetrievalEnabled: true, openLoopExtractionEnabled: false, proactiveFollowupEnabled: false, reflectionEnabled: false });
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

function buildActiveG1ForG2(
  gitCommit: string,
  overrides: { cutoverState?: "disabled" | "active" } = {},
) {
  return buildOneA3bG1ReleaseManifest({
    gitCommit,
    migrations: [{ name: "0052_release.sql", sha256: "b".repeat(64) }],
    purgeMarkerMigrations: [
      { name: "0002_marker.sql", sha256: "c".repeat(64) },
    ],
    roleConfigurations: ONE_A_3B_G1_ENABLED_ROLES.map((role) => {
      const policy = ONE_A_3B_ROLE_POLICIES[role];
      return {
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
        freshnessPolicy: policy.freshnessPolicy,
        fallbackMode: "disabled" as const,
        maxTechnicalRetries: policy.maxTechnicalRetries,
        maxSemanticRepairs: policy.maxSemanticRepairs,
        parameterSnapshot: { temperature: 0 },
      };
    }),
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
    cutoverState: overrides.cutoverState ?? "active",
    createdAt: "2026-09-12T00:00:00.000Z",
  });
}

function buildLinkedG2ForG2(
  gitCommit: string,
  baseG1ReleaseFingerprint: string,
  overrides: {
    continuationStatus?: "verified" | "pending";
    cutoverState?: "disabled" | "active";
  },
) {
  const continuationStatus = overrides.continuationStatus ?? "verified";
  return buildOneA3bG2ReleaseManifest({
    gitCommit,
    baseG1ReleaseFingerprint,
    migrations: [{ name: "0052_release.sql", sha256: "b".repeat(64) }],
    purgeMarkerMigrations: [
      { name: "0002_marker.sql", sha256: "c".repeat(64) },
    ],
    roleConfigurations: ONE_A_3B_G2_ENABLED_ROLES.map((role) => {
      const policy = ONE_A_3B_ROLE_POLICIES[role];
      return {
        role,
        configVersion: `${role}:v1`,
        provider: "synthetic-provider",
        model: "synthetic-model",
        modelSnapshot: "synthetic-model@2026-09-14",
        promptVersion: `${role}-prompt:v1`,
        schemaVersion: `${role}-schema:v1`,
        rolePolicyVersion: "1a3b-model-role-policy:v1",
        providerPolicyVersion: `${role}-egress:v1`,
        rolloutPin: `${role}-rollout:v1`,
        freshnessPolicy: policy.freshnessPolicy,
        fallbackMode: "disabled" as const,
        maxTechnicalRetries: policy.maxTechnicalRetries,
        maxSemanticRepairs: policy.maxSemanticRepairs,
        parameterSnapshot: { temperature: 0 },
      };
    }),
    fixture: {
      f3ManifestPath: "release-evidence/not-deployed/manifest.json",
      f3ManifestSha256: "d".repeat(64),
      f3ManifestFingerprint: `sha256:${"e".repeat(64)}`,
      fixtureSeed: 207,
      sampleSeed: 2070,
    },
    continuationCalibration: {
      ledgerPath: "release-evidence/not-deployed/continuation-ledger.json",
      ledgerSha256: "f".repeat(64),
      ledgerVersion: "1a3b-g2-continuation-ledger:v1",
      f3ManifestFingerprint: `sha256:${"e".repeat(64)}`,
      totalCases: 15,
      englishCases: 8,
      chineseCases: 5,
      codeSwitchCases: 2,
      netPreference: 3,
      localeRegressions: 0,
      protectedCategoryRegressions: 0,
      humanOwner: "Luke",
      status: continuationStatus,
      ...(continuationStatus === "verified"
        ? {}
        : { note: "Continuation blind review has not run." }),
    },
    commands: ["CI=true pnpm validate"],
    evidence: ONE_A_3B_G2_REQUIRED_ACCEPTANCE_CRITERIA.map(
      (criterion, index) => ({
        criterion,
        fixtureIds: ["synthetic-fixture"],
        command: `verify ${criterion}`,
        ...(continuationStatus === "verified" || criterion !== "AC-X01"
          ? {
              artifactSha256: (index + 1).toString(16).repeat(64),
              artifactPath: `release-evidence/not-deployed/${criterion.toLowerCase()}.json`,
              status: "verified" as const,
            }
          : {
              artifactSha256: null,
              artifactPath: null,
              status: "pending" as const,
              note: "Continuation blind review has not run.",
            }),
        owner: "Luke",
        source:
          criterion === "AC-X01"
            ? "human"
            : criterion === "AC-M01"
              ? "provider"
              : criterion === "AC-W01"
                ? "hosted"
                : criterion === "AC-X04"
                  ? "local"
                  : "ci",
      }),
    ),
    cutoverState: overrides.cutoverState ?? "disabled",
    createdAt: "2026-09-14T00:00:00.000Z",
  });
}
