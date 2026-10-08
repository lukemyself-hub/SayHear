import { describe, expect, it } from "vitest";

import { normalizeDatabaseIdentity } from "../apps/web/src/release-identity";
import {
  normalizeTestDatabaseTarget,
  resolveTestDatabaseEnvironment,
} from "../scripts/ci/test-databases.ts";

const businessUrl = "postgresql://ci:synthetic@127.0.0.1:5432/sayhear_test";
const purgeMarkerUrl =
  "postgresql://ci:synthetic@127.0.0.1:5432/sayhear_purge_marker_test";

describe("CI two-database environment", () => {
  it("rejects a missing business test database variable instead of skipping system suites", () => {
    expect(() =>
      resolveTestDatabaseEnvironment({
        TEST_PURGE_MARKER_DATABASE_URL: purgeMarkerUrl,
      }),
    ).toThrow(/TEST_DATABASE_URL/);
  });

  it("rejects a missing purge marker test database variable instead of skipping system suites", () => {
    expect(() =>
      resolveTestDatabaseEnvironment({ TEST_DATABASE_URL: businessUrl }),
    ).toThrow(/TEST_PURGE_MARKER_DATABASE_URL/);
  });

  it("rejects blank test database variables", () => {
    expect(() =>
      resolveTestDatabaseEnvironment({
        TEST_DATABASE_URL: "   ",
        TEST_PURGE_MARKER_DATABASE_URL: purgeMarkerUrl,
      }),
    ).toThrow(/TEST_DATABASE_URL/);
    expect(() =>
      resolveTestDatabaseEnvironment({
        TEST_DATABASE_URL: businessUrl,
        TEST_PURGE_MARKER_DATABASE_URL: "",
      }),
    ).toThrow(/TEST_PURGE_MARKER_DATABASE_URL/);
  });

  it("rejects one test database used for both the business and purge marker stores", () => {
    expect(() =>
      resolveTestDatabaseEnvironment({
        TEST_DATABASE_URL: businessUrl,
        TEST_PURGE_MARKER_DATABASE_URL: businessUrl,
      }),
    ).toThrow(/separate database/);
  });

  it("rejects one test database spelled two ways for both stores", () => {
    expect(() =>
      resolveTestDatabaseEnvironment({
        TEST_DATABASE_URL: "postgresql://ci:synthetic@127.0.0.1:5432/sayhear_test",
        TEST_PURGE_MARKER_DATABASE_URL:
          "postgresql://ci:synthetic@127.0.0.1/sayhear_test",
      }),
    ).toThrow(/separate database/);
  });

  it("rejects a pooled endpoint and its direct twin as the same test database", () => {
    expect(() =>
      resolveTestDatabaseEnvironment({
        TEST_DATABASE_URL:
          "postgresql://ci:synthetic@business-pooler.db.example.com/sayhear_test",
        TEST_PURGE_MARKER_DATABASE_URL:
          "postgresql://ci:synthetic@business.db.example.com/sayhear_test",
      }),
    ).toThrow(/separate database/);
  });

  it("accepts two distinct test databases and reports credential-free targets", () => {
    const resolved = resolveTestDatabaseEnvironment({
      TEST_DATABASE_URL: businessUrl,
      TEST_PURGE_MARKER_DATABASE_URL: purgeMarkerUrl,
    });

    expect(resolved.business).toEqual({
      target: "127.0.0.1:5432/sayhear_test",
      url: businessUrl,
    });
    expect(resolved.purgeMarker).toEqual({
      target: "127.0.0.1:5432/sayhear_purge_marker_test",
      url: purgeMarkerUrl,
    });
  });

  it("normalizes a test database target exactly like the deployed two-database identity", () => {
    const spellings = [
      businessUrl,
      "postgresql://ci:synthetic@127.0.0.1/sayhear_test",
      "postgresql://ci:synthetic@127.0.0.1:5432/sayhear_test/",
      "postgresql://ci:synthetic@business-pooler.db.example.com:5432/sayhear_test",
      "postgresql://ci:synthetic@business.db.example.com/sayhear_test",
    ];

    for (const spelling of spellings) {
      expect(normalizeTestDatabaseTarget(spelling)).toBe(
        normalizeDatabaseIdentity(spelling),
      );
    }
  });
});