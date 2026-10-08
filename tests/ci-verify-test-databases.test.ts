import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  assertTestDatabasesAreReady,
  formatTestDatabaseReadiness,
  type TestDatabaseProbe,
} from "../scripts/ci/test-databases.ts";

const repositoryRoot = new URL("../", import.meta.url);

function runVerifyTestDatabases(
  environment: Record<string, string>,
): { status: number | null; stderr: string; stdout: string } {
  const inherited = { ...process.env };
  for (const variable of [
    "TEST_DATABASE_URL",
    "TEST_PURGE_MARKER_DATABASE_URL",
  ]) {
    delete inherited[variable];
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/ci/verify-test-databases.ts"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...inherited, ...environment },
    },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

const businessProbe: TestDatabaseProbe = {
  database: "sayhear_test",
  leftoverTestSchemas: 0,
};

const purgeMarkerProbe: TestDatabaseProbe = {
  database: "sayhear_purge_marker_test",
  leftoverTestSchemas: 0,
};

describe("CI test database readiness", () => {
  it("accepts two reachable databases that the server reports as different", () => {
    expect(
      assertTestDatabasesAreReady({
        business: businessProbe,
        purgeMarker: purgeMarkerProbe,
      }),
    ).toBeUndefined();
  });

  it("rejects two URLs that reach the same database on the server", () => {
    expect(() =>
      assertTestDatabasesAreReady({
        business: businessProbe,
        purgeMarker: { database: "sayhear_test", leftoverTestSchemas: 0 },
      }),
    ).toThrow(/same database sayhear_test/);
  });

  it("rejects a test database still holding schemas from an aborted run", () => {
    expect(() =>
      assertTestDatabasesAreReady({
        business: { database: "sayhear_test", leftoverTestSchemas: 7 },
        purgeMarker: purgeMarkerProbe,
      }),
    ).toThrow(/7 leftover/);
    expect(() =>
      assertTestDatabasesAreReady({
        business: businessProbe,
        purgeMarker: { database: "sayhear_purge_marker_test", leftoverTestSchemas: 1 },
      }),
    ).toThrow(/1 leftover/);
  });

  it("summarises both databases without echoing credentials", () => {
    const summary = formatTestDatabaseReadiness({
      business: { target: "127.0.0.1:5432/sayhear_test", ...businessProbe },
      purgeMarker: {
        target: "127.0.0.1:5432/sayhear_purge_marker_test",
        ...purgeMarkerProbe,
      },
    });

    expect(summary).toContain("127.0.0.1:5432/sayhear_test");
    expect(summary).toContain("127.0.0.1:5432/sayhear_purge_marker_test");
    expect(summary).not.toContain("synthetic");
    expect(summary).not.toContain("@");
  });

  it("fails the check when a test database variable is missing", () => {
    const missingBusiness = runVerifyTestDatabases({});
    expect(missingBusiness.status).not.toBe(0);
    expect(missingBusiness.stderr).toMatch(/TEST_DATABASE_URL/);

    const missingPurgeMarker = runVerifyTestDatabases({
      TEST_DATABASE_URL: "postgresql://ci:synthetic@127.0.0.1:5432/sayhear_test",
    });
    expect(missingPurgeMarker.status).not.toBe(0);
    expect(missingPurgeMarker.stderr).toMatch(/TEST_PURGE_MARKER_DATABASE_URL/);
  });

  it("fails the check when both variables name one database", () => {
    const result = runVerifyTestDatabases({
      TEST_DATABASE_URL: "postgresql://ci:synthetic@127.0.0.1:5432/sayhear_test",
      TEST_PURGE_MARKER_DATABASE_URL:
        "postgresql://ci:synthetic@127.0.0.1/sayhear_test",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/separate database/);
  });

  it("fails the check when a test database cannot be reached", () => {
    const result = runVerifyTestDatabases({
      TEST_DATABASE_URL: "postgresql://ci:synthetic@127.0.0.1:1/sayhear_test",
      TEST_PURGE_MARKER_DATABASE_URL:
        "postgresql://ci:synthetic@127.0.0.1:1/sayhear_purge_marker_test",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/127\.0\.0\.1:1\/sayhear_test/);
    expect(result.stderr).toMatch(/unreachable|ECONNREFUSED|refused/i);
  });
});