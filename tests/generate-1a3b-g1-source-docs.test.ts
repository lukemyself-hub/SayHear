import { describe, expect, it } from "vitest";

import {
  buildAcL02DrillResult,
  ids,
  parseSourceOptions,
  validatedAcM01Result,
} from "../scripts/generate-1a3b-g1-source-docs";
import { parseOptions } from "../scripts/produce-1a3b-g1-evidence";
import { ONE_A_3B_G1_ROLE_CONFIG_VERSIONS, ONE_A_3B_G1_ROLLOUT_PIN_VERSION, ONE_A_3B_ROLE_POLICY_VERSION } from "@sayhear/application";

const report = {
  assertionIds: ["suite relevant assertion", "suite unrelated assertion"],
  passedTestSuites: 1,
  passedTests: 2,
  runId: "report:123",
  totalTestSuites: 1,
  totalTests: 2,
};

describe("G1 source document evidence validation", () => {
  it("protects the historical producer run root and requires an explicit catalog", () => {
    expect(() => parseOptions([])).toThrow("required");
    expect(() => parseOptions(["--run-root", "eval/continuation-acceptance-1a3b/run", "--catalog", "fixtures.json"])).toThrow("protected");
    const options = parseOptions(["--run-root", "eval/continuation-acceptance-1a3b/run/new-run", "--catalog", "eval/continuation-acceptance-1a3b/holdout/fixtures.json"]);
    expect(options.ledgerPath).toContain("new-run/validator-ledger.json");
    expect(options.catalogPath).toContain("holdout/fixtures.json");
  });
  it("requires explicit release paths and deployment and rejects escapes or duplicate options", () => {
    const args = ["--run-root", "eval/continuation-acceptance-1a3b/run/new-run", "--catalog", "eval/continuation-acceptance-1a3b/holdout/fixtures.json", "--pins", "eval/continuation-acceptance-1a3b/pins.json", "--deployment-id", "dpl-test"];
    expect(parseSourceOptions(args).deploymentId).toBe("dpl-test");
    expect(() => parseSourceOptions(args.slice(0, -2))).toThrow("--deployment-id is required");
    expect(() => parseSourceOptions([...args, "--pins", "other"])).toThrow("unique");
    expect(() => parseSourceOptions(["--run-root", "../escape", ...args.slice(2)])).toThrow("inside the repository");
  });

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
      generationCommandId: "command-1",
      model: "model-1",
      modelRunAttemptId: "attempt-1",
      modelSnapshot: "snapshot-1",
      outcome: "completed",
      parameters,
      provider: "provider-1",
      role: "episode.build",
      configVersion: `episode.build:g1-release:${ONE_A_3B_G1_ROLE_CONFIG_VERSIONS["episode.build"]}`,
      providerPolicyVersion: `provider-1-episode.build-egress:g1-release:${ONE_A_3B_G1_ROLE_CONFIG_VERSIONS["episode.build"]}`,
      rolloutPin: `episode.build-g1-release-pin:${ONE_A_3B_G1_ROLLOUT_PIN_VERSION}`,
      rolePolicyVersion: ONE_A_3B_ROLE_POLICY_VERSION,
      usage: { inputTokens: 100, outputTokens: 200, reasoningTokens: null },
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
    expect(() => validatedAcM01Result({ providerCalls: [{ ...call, usage: undefined }] }, pins, ["episode.build"])).toThrow("usage");
    expect(() => validatedAcM01Result({ providerCalls: [{ ...call, generationCommandId: undefined }] }, pins, ["episode.build"])).toThrow("identity");
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
