import { describe, expect, it } from "vitest";

import {
  calibrationCase,
  calibrationSamples,
} from "../eval/continuity-acceptance-301/src/calibration";
import {
  aggregateStatus,
  evaluateCase,
  exitCodeForStatus,
} from "../eval/continuity-acceptance-301/src/evaluate";
import { validateCase } from "../eval/continuity-acceptance-301/src/fixture";

/**
 * T00 #313 checker calibration: each prefabricated transcript carries the
 * verdict the acceptance contract demands. A correct recap must pass in two
 * different wordings; each deliberately wrong one must be caught at the
 * specific criterion that names its defect.
 */
describe("continuity acceptance evaluation", () => {
  it("keeps the calibration case itself structurally valid", () => {
    expect(validateCase(calibrationCase)).toEqual([]);
  });

  for (const sample of calibrationSamples()) {
    it(`scores "${sample.name}" (${sample.defect})`, () => {
      const report = evaluateCase({
        loaded: calibrationCase,
        observation: sample.observation,
        review: sample.review,
      });
      const statuses = Object.fromEntries(
        report.criteria.map((criterion) => [criterion.id, criterion.status]),
      );
      expect(statuses).toMatchObject(sample.expect.criteria);
      expect(report.status).toBe(sample.expect.aggregate);
      // Every verdict must explain itself and point at what was observed.
      for (const criterion of report.criteria) {
        expect(criterion.reason.length).toBeGreaterThan(0);
        if (criterion.status === "fail") {
          expect(criterion.evidence.length).toBeGreaterThan(0);
        }
      }
    });
  }

  it("never reports a run as complete unless every required criterion passed", () => {
    expect(aggregateStatus(["pass", "pass"])).toBe("pass");
    expect(aggregateStatus(["pass", "not-run"])).toBe("not-run");
    expect(aggregateStatus(["pass", "needs-review", "not-run"])).toBe("needs-review");
    expect(aggregateStatus(["needs-review", "fail", "not-run"])).toBe("fail");
    expect(aggregateStatus(["fail", "environment-error"])).toBe("environment-error");
    expect(aggregateStatus([])).toBe("not-run");
  });

  it("gives failed, incomplete and broken runs different exit codes", () => {
    const codes = (
      ["pass", "fail", "needs-review", "not-run", "environment-error"] as const
    ).map(exitCodeForStatus);
    expect(codes[0]).toBe(0);
    expect(new Set(codes).size).toBe(4);
    expect(exitCodeForStatus("needs-review")).toBe(exitCodeForStatus("not-run"));
    expect(codes.slice(1).every((code) => code !== 0)).toBe(true);
  });
});
