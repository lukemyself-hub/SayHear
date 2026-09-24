import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  verifyIssue240Diagnosis,
  verifyIssue240Evidence,
} from "../eval/continuation-acceptance-1a3b/verify-issue-240-diagnosis";

const root = resolve(process.cwd());
const diagnosis = JSON.parse(
  readFileSync(
    resolve(root, "eval/continuation-acceptance-1a3b/issue-240-g2-v5-diagnosis.json"),
    "utf8",
  ),
) as Parameters<typeof verifyIssue240Diagnosis>[0];
const contract = JSON.parse(
  readFileSync(
    resolve(root, "eval/continuation-acceptance-1a3b/issue-240-g2-v6-opportunity-contract.json"),
    "utf8",
  ),
) as Parameters<typeof verifyIssue240Diagnosis>[1];
const evidenceAvailable = [
  "eval/continuation-acceptance-1a3b/run-v4/verification.json",
  "eval/continuation-acceptance-1a3b/run-v5-calibration-1/verification.json",
  "eval/continuation-acceptance-1a3b/run-v5-calibration-2/verification.json",
  "eval/continuation-acceptance-1a3b/issue-240-blind-review.json",
].every((path) => existsSync(resolve(root, path)));

describe("Issue #240 G2 v5 diagnosis", () => {
  it("preserves the frozen denominator and separates trajectory outcomes", () => {
    const result = verifyIssue240Diagnosis(diagnosis, contract);

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.counts).toEqual({
      rows: 43,
      mechanicalOpportunities: 31,
      omissionProbes: 12,
      statefulAnchors: 8,
      statefulCommittedAnchors: 0,
    });
  });

  it("fails closed when the mechanical denominator is reduced", () => {
    const changed = structuredClone(diagnosis);
    changed.scope.mechanicalOpportunityDenominator = 30;

    const result = verifyIssue240Diagnosis(changed, contract);

    expect(result.passed).toBe(false);
    expect(result.errors).toContain("mechanical denominator must remain 31");
  });

  const evidenceTest = evidenceAvailable ? it : it.skip;
  evidenceTest("checks the current evidence bytes and blind ordering artifact", async () => {
    const result = await verifyIssue240Evidence(root, diagnosis);

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.counts).toEqual({
      rows: 43,
      mechanicalOpportunities: 31,
      omissionProbes: 12,
      statefulAnchors: 8,
      statefulCommittedAnchors: 0,
    });
  });

  it("reports missing evidence without throwing", async () => {
    const result = await verifyIssue240Evidence(resolve(root, "missing-evidence-root"), diagnosis);

    expect(result.passed).toBe(false);
    expect(result.errors[0]).toMatch(/^evidence_missing:/);
  });
});
