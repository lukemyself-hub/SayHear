import { describe, expect, it } from "vitest";

import { assertSafeRuntimeConfiguration } from "../apps/web/src/runtime-config";

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
});
