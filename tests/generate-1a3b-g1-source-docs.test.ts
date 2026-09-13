import { describe, expect, it } from "vitest";

import {
  buildAcL02DrillResult,
  ids,
  validatedAcM01Result,
} from "../scripts/generate-1a3b-g1-source-docs";

const report = {
  assertionIds: ["suite relevant assertion", "suite unrelated assertion"],
  passedTestSuites: 1,
  passedTests: 2,
  runId: "report:123",
  totalTestSuites: 1,
  totalTests: 2,
};

describe("G1 source document evidence validation", () => {
  it("fails when a criterion-specific assertion predicate matches nothing", () => {
    expect(() => ids(report, (id) => id.includes("missing"))).toThrow(
      "No passing assertion in report:123 matched",
    );
    expect(ids({ ...report, assertionIds: [] })).toEqual(["report:123"]);
  });

  it("accepts only successful, identified provider calls matching every enabled role pin", () => {
    const parameters = { maxOutputTokens: 4000, temperature: 0.2 };
    const pins = {
      roles: {
        "episode.build": {
          model: "model-1",
          parameters,
          provider: "provider-1",
          snapshot: "snapshot-1",
        },
      },
    };
    const call = {
      model: "model-1",
      modelRunAttemptId: "attempt-1",
      modelSnapshot: "snapshot-1",
      outcome: "completed",
      parameters,
      provider: "provider-1",
      role: "episode.build",
    };

    expect(
      validatedAcM01Result({ providerCalls: [call] }, pins, ["episode.build"])
        .providerCalls,
    ).toEqual([call]);
    expect(() =>
      validatedAcM01Result(
        { providerCalls: [{ ...call, modelSnapshot: "other" }] },
        pins,
        ["episode.build"],
      ),
    ).toThrow("does not match its evaluated pin");
    expect(() =>
      validatedAcM01Result(
        { providerCalls: [{ ...call, outcome: "failed" }] },
        pins,
        ["episode.build"],
      ),
    ).toThrow("no successful provider call");
  });

  it("builds AC-L02 drill results only when every drill phase passed", () => {
    const drill = {
      assertionIds: [
        "G1 AC-L02 drill seeded canary capture: pre-purge backup snapshot predates the purge",
        "G1 AC-L02 drill purge-first inflight order: stale epoch writes are fenced",
        "G1 AC-L02 drill write-first inflight order: pre-purge canaries are cleared",
        "G1 AC-L02 drill restore and marker reapply: backup restore cannot resurrect",
      ],
      passedTestSuites: 1,
      passedTests: 4,
      runId: "drill:123",
      totalTestSuites: 1,
      totalTests: 4,
    };
    const purge = {
      ...report,
      assertionIds: ["recovery scan converges after a crash"],
    };

    const result = buildAcL02DrillResult({ drill, purge });
    expect(result.purgeSurfaceRegistryVersion).toBe("purge-surface-registry:v1");
    expect(result.snapshotPredatesPurge).toBe(true);
    expect(result.inflightOrders).toHaveLength(2);
    expect(result.restoreDrill).toMatchObject({});

    expect(() =>
      buildAcL02DrillResult({
        drill: { ...drill, assertionIds: drill.assertionIds.slice(0, 3) },
        purge,
      }),
    ).toThrow("No passing assertion in drill:123 matched");
    expect(() =>
      buildAcL02DrillResult({
        drill,
        purge: { ...purge, assertionIds: ["unrelated purge assertion"] },
      }),
    ).toThrow("No passing assertion in report:123 matched");
  });

  it("fails when any enabled role lacks underlying provider-call evidence", () => {
    expect(() =>
      validatedAcM01Result(
        { providerCalls: [] },
        {
          roles: {
            "episode.build": {
              model: "model-1",
              parameters: {},
              provider: "provider-1",
              snapshot: "snapshot-1",
            },
          },
        },
        ["episode.build"],
      ),
    ).toThrow("no successful provider call for episode.build");
  });
});
