import { describe, expect, it } from "vitest";

import {
  assertSystemSuitesExecuted,
  expectedSystemSuiteCount,
  formatSystemSuiteExecution,
  type VitestJsonReport,
} from "../scripts/ci/system-suite-execution.ts";

function fileResult(relativePath: string, testStatuses: string[]): {
  name: string;
  status: string;
  assertionResults: { status: string }[];
} {
  return {
    name: `/repo/${relativePath}`,
    status: testStatuses.includes("failed") ? "failed" : "passed",
    assertionResults: testStatuses.map((status) => ({ status })),
  };
}

function report(testResults: ReturnType<typeof fileResult>[]): VitestJsonReport {
  return { success: true, testResults };
}

function thrownMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the action to throw.");
}

describe("PR system suite execution", () => {
  it("passes when every discovered system suite ran without a skipped test", () => {
    const result = assertSystemSuitesExecuted({
      discoveredSystemSuites: [
        "/repo/tests/system/alpha.system.test.ts",
        "/repo/tests/system/beta.system.test.ts",
      ],
      expectedCount: 2,
      report: report([
        fileResult("tests/recovery-scanner-handler.test.ts", ["passed"]),
        fileResult("tests/system/alpha.system.test.ts", ["passed", "passed"]),
        fileResult("tests/system/beta.system.test.ts", ["passed"]),
      ]),
    });

    expect(result.executedSystemSuites).toBe(2);
    expect(result.skippedSystemTests).toBe(0);
  });

  it("fails when the report is missing a discovered system suite", () => {
    expect(() =>
      assertSystemSuitesExecuted({
        discoveredSystemSuites: [
          "/repo/tests/system/alpha.system.test.ts",
          "/repo/tests/system/beta.system.test.ts",
        ],
        expectedCount: 2,
        report: report([
          fileResult("tests/system/alpha.system.test.ts", ["passed"]),
        ]),
      }),
    ).toThrow(/beta\.system\.test\.ts/);
  });

  it("fails when the environment caused a system suite to skip", () => {
    const message = thrownMessage(() =>
      assertSystemSuitesExecuted({
        discoveredSystemSuites: ["/repo/tests/system/alpha.system.test.ts"],
        expectedCount: 1,
        report: report([
          fileResult("tests/system/alpha.system.test.ts", ["skipped", "skipped"]),
        ]),
      }),
    );
    expect(message).toContain("alpha.system.test.ts");
    expect(message).toContain("reported skipped tests");

    expect(() =>
      assertSystemSuitesExecuted({
        discoveredSystemSuites: ["/repo/tests/system/alpha.system.test.ts"],
        expectedCount: 1,
        report: report([
          fileResult("tests/system/alpha.system.test.ts", ["passed", "pending"]),
        ]),
      }),
    ).toThrow(/alpha\.system\.test\.ts/);
  });

  it("reports failed assertions without misdiagnosing them as skipped tests", () => {
    const message = thrownMessage(() =>
      assertSystemSuitesExecuted({
        discoveredSystemSuites: ["/repo/tests/system/alpha.system.test.ts"],
        expectedCount: 1,
        report: report([
          fileResult("tests/system/alpha.system.test.ts", ["passed", "failed"]),
        ]),
      }),
    );

    expect(message).toContain("alpha.system.test.ts reported failed tests");
    expect(message).not.toContain("reported skipped tests");
    expect(message).not.toContain("database");
  });

  it("reports both skipped and failed assertions when a suite contains both", () => {
    const message = thrownMessage(() =>
      assertSystemSuitesExecuted({
        discoveredSystemSuites: ["/repo/tests/system/alpha.system.test.ts"],
        expectedCount: 1,
        report: report([
          fileResult("tests/system/alpha.system.test.ts", ["skipped", "failed"]),
        ]),
      }),
    );

    expect(message).toContain("reported skipped tests");
    expect(message).toContain("reported failed tests");
  });

  it("fails when a system suite did not pass", () => {
    expect(() =>
      assertSystemSuitesExecuted({
        discoveredSystemSuites: ["/repo/tests/system/alpha.system.test.ts"],
        expectedCount: 1,
        report: report([
          fileResult("tests/system/alpha.system.test.ts", ["passed", "failed"]),
        ]),
      }),
    ).toThrow(/alpha\.system\.test\.ts/);
  });

  it("counts Vitest todo assertions as skipped tests", () => {
    expect(() =>
      assertSystemSuitesExecuted({
        discoveredSystemSuites: ["/repo/tests/system/alpha.system.test.ts"],
        expectedCount: 1,
        report: report([
          fileResult("tests/system/alpha.system.test.ts", ["todo"]),
        ]),
      }),
    ).toThrow(/alpha\.system\.test\.ts reported skipped tests/);
  });

  it("counts disabled assertions as skipped tests", () => {
    expect(() =>
      assertSystemSuitesExecuted({
        discoveredSystemSuites: ["/repo/tests/system/alpha.system.test.ts"],
        expectedCount: 1,
        report: report([
          fileResult("tests/system/alpha.system.test.ts", ["disabled"]),
        ]),
      }),
    ).toThrow(/alpha\.system\.test\.ts reported skipped tests/);
  });

  it("fails closed on an unrecognized suite status without calling it a database skip", () => {
    const result = {
      ...fileResult("tests/system/alpha.system.test.ts", []),
      status: "interrupted",
    };
    const message = thrownMessage(() =>
      assertSystemSuitesExecuted({
        discoveredSystemSuites: ["/repo/tests/system/alpha.system.test.ts"],
        expectedCount: 1,
        report: report([result]),
      }),
    );

    expect(message).toContain("alpha.system.test.ts reported failed tests");
    expect(message).not.toContain("database");
  });

  it("rejects unknown assertion statuses even when the suite reports passed", () => {
    const message = thrownMessage(() =>
      assertSystemSuitesExecuted({
        discoveredSystemSuites: ["/repo/tests/system/alpha.system.test.ts"],
        expectedCount: 1,
        report: report([
          fileResult("tests/system/alpha.system.test.ts", ["passed", "interrupted"]),
        ]),
      }),
    );

    expect(message).toContain("alpha.system.test.ts reported failed tests");
    expect(message).not.toContain("reported skipped tests");
    expect(message).not.toContain("database");
  });

  it("rejects a passing system suite with no assertions", () => {
    expect(() =>
      assertSystemSuitesExecuted({
        discoveredSystemSuites: ["/repo/tests/system/alpha.system.test.ts"],
        expectedCount: 1,
        report: report([fileResult("tests/system/alpha.system.test.ts", [])]),
      }),
    ).toThrow(/alpha\.system\.test\.ts reported no tests/);
  });

  it("fails when the executed system suite count drifts from the expectation", () => {
    expect(() =>
      assertSystemSuitesExecuted({
        discoveredSystemSuites: [
          "/repo/tests/system/alpha.system.test.ts",
          "/repo/tests/system/beta.system.test.ts",
        ],
        expectedCount: expectedSystemSuiteCount,
        report: report([
          fileResult("tests/system/alpha.system.test.ts", ["passed"]),
          fileResult("tests/system/beta.system.test.ts", ["passed"]),
        ]),
      }),
    ).toThrow(new RegExp(`expected ${expectedSystemSuiteCount}`));
  });

  it("names the real tests/system directory rather than a doubled tests/tests/system prefix", () => {
    let message = "";
    try {
      assertSystemSuitesExecuted({
        discoveredSystemSuites: [],
        expectedCount: expectedSystemSuiteCount,
        report: report([]),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(`in tests/system`);
    expect(message).not.toContain("tests/tests/");
  });

  it("matches a suite whose report path is rooted differently from the checkout", () => {
    // A symlinked working directory makes vitest report a resolved prefix while
    // the discovered path keeps the one the process was started in.
    expect(
      assertSystemSuitesExecuted({
        discoveredSystemSuites: [
          "/var/folders/worker/repo/tests/system/alpha.system.test.ts",
        ],
        expectedCount: 1,
        report: report([
          {
            name: "/private/var/folders/worker/repo/tests/system/alpha.system.test.ts",
            status: "passed",
            assertionResults: [{ status: "passed" }],
          },
        ]),
      }).executedSystemSuites,
    ).toBe(1);
  });

  it("summarises the executed suites without listing every assertion", () => {
    const summary = formatSystemSuiteExecution({
      discoveredSystemSuites: [
        "/repo/tests/system/alpha.system.test.ts",
        "/repo/tests/system/beta.system.test.ts",
      ],
      expectedCount: 2,
      report: report([
        fileResult("tests/system/alpha.system.test.ts", ["passed"]),
        fileResult("tests/system/beta.system.test.ts", ["passed", "passed"]),
      ]),
    });

    expect(summary).toMatch(/system suites 2\/2/);
    expect(summary).toMatch(/system tests 3/);
    expect(summary).toMatch(/skipped 0/);
  });
});
