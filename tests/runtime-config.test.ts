import { describe, expect, it } from "vitest";

import { assertSafeRuntimeConfiguration, loadRuntimeConfiguration } from "../apps/web/src/runtime-config";

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

  it("defaults Journal and Evidence write switches to enabled and parses each independently", () => {
    const base = {
      CRON_SECRET: "cron", DATABASE_URL: "postgres://test", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret",
      NEXTAUTH_SECRET: "auth", PURGE_MARKER_DATABASE_URL: "postgres://test-marker", SAYHEAR_BACKUP_CONFIGURATION_FINGERPRINT: "fingerprint", SAYHEAR_BACKUP_POLICY_VERSION: "backup:v1",
      SAYHEAR_CONTEXT_HMAC_SECRET: "context", SAYHEAR_DEPLOYMENT: "test", SAYHEAR_PROVIDER_ADAPTER: "deterministic",
      SAYHEAR_TEST_PROVIDER_CHUNKS: '["ok"]',
    };
    expect(loadRuntimeConfiguration(base).writeSwitches).toEqual({ evidenceExtractionEnabled: true, journalPublishEnabled: true });
    expect(loadRuntimeConfiguration({ ...base, SAYHEAR_EVIDENCE_EXTRACTION_ENABLED: "false" }).writeSwitches)
      .toEqual({ evidenceExtractionEnabled: false, journalPublishEnabled: true });
    expect(loadRuntimeConfiguration({ ...base, SAYHEAR_JOURNAL_PUBLISH_ENABLED: "false" }).writeSwitches)
      .toEqual({ evidenceExtractionEnabled: true, journalPublishEnabled: false });
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
