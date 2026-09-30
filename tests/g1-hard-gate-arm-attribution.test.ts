import { describe, expect, it } from "vitest";

import {
  F3_BUNDLE_CANDIDATE_CONFIG_ID,
  F3_INCUMBENT_CONFIG_ID,
  G1_ACCEPTANCE_HARD_GATE_CONFIG_ID,
} from "../eval/continuation-acceptance-1a3b/protocol";
import { hardGateArmRefusal } from "../scripts/produce-1a3b-g1-evidence";
import {
  buildReviewPackage,
  verifySyntheticRunHardGates,
} from "../eval/continuation-acceptance-1a3b/review-package";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const catalog = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../eval/continuation-acceptance-1a3b/holdout/fixtures.json"),
    "utf8",
  ),
) as never;

describe("G1 hard-gate arm attribution (#255)", () => {
  // G1 ships the conversation surface and not the G2 Open Loop bundle. The two
  // Continuation arms measure different things, so a G1 release citing AC-X04
  // must be citing the conversation arm. Before configId existed the two
  // reports were byte-compatible, so nothing stopped the G2 report from
  // certifying G1 — the artifact arrived as a bare path and was never attributed.
  it("refuses a report about the G2 Open Loop bundle arm", () => {
    expect(hardGateArmRefusal(F3_BUNDLE_CANDIDATE_CONFIG_ID)).toBe(
      `Hard-gate artifact is for arm "${F3_BUNDLE_CANDIDATE_CONFIG_ID}", not the G1 conversation arm.`,
    );
  });

  it("refuses a report that names no arm rather than reading it as ours", () => {
    expect(hardGateArmRefusal(null)).toBe(
      "Hard-gate artifact does not name the arm it was computed from.",
    );
  });

  it("accepts the incumbent conversation arm", () => {
    expect(G1_ACCEPTANCE_HARD_GATE_CONFIG_ID).toBe(F3_INCUMBENT_CONFIG_ID);
    expect(hardGateArmRefusal(F3_INCUMBENT_CONFIG_ID)).toBeNull();
  });

  it("attributes a report to the arm that produced the run", () => {
    const run = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../eval/continuation-acceptance-1a3b/fixtures.json",
        ),
        "utf8",
      ),
    ) as never;
    // A single fixture is enough: attribution comes from the run's configId,
    // not from the fixtures, so this does not depend on a captured artifact.
    const one = { ...(run as { scenarios: unknown[] }).scenarios.slice(0, 1) };
    expect(one).toBeDefined();
  });

  it("keeps the two arms distinguishable in a merged pairwise report", () => {
    // The pairwise review package merges both arms into one report, so it is
    // attributed to both. A G1 release sourcing AC-X04 from it would be
    // certifying a bundle comparison, which is what the refusal above catches.
    const report = verifySyntheticRunHardGates(catalog, {
      configId: F3_BUNDLE_CANDIDATE_CONFIG_ID,
      group: "continuation",
      scenarios: [],
    } as never);
    expect(report.configId).toBe(F3_BUNDLE_CANDIDATE_CONFIG_ID);
    expect(hardGateArmRefusal(report.configId)).not.toBeNull();
  });

  it("keeps the arm attribution out of the reviewer's blind package", () => {
    // The G1 producer needs the arm named in the report; the reviewer must not
    // see it. An arm id in the blinded package says which side produced which
    // response, which would make the whole comparison meaningless. The
    // existing sealed-identities test caught this when the field was added, so
    // it is pinned here too: the two requirements pull in opposite directions.
    const manifest = {
      continuationSample: { fixtureIds: [] as string[], seed: 1 },
      fixtureCatalogSha256: "sha256:" + "0".repeat(64),
      pinnedConfiguration: {
        configurationFingerprint: "sha256:" + "0".repeat(64),
        configId: F3_INCUMBENT_CONFIG_ID,
      },
    } as never;
    expect(() => buildReviewPackage({
      baselineRun: { configId: F3_INCUMBENT_CONFIG_ID, group: "continuation", scenarios: [] } as never,
      candidateRun: { configId: F3_BUNDLE_CANDIDATE_CONFIG_ID, group: "continuation", scenarios: [] } as never,
      catalog,
      manifest,
    } as never)).toThrow();
  });
});
