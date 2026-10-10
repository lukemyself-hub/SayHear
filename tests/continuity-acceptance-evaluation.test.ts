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
import {
  validateCase,
  type ObjectiveCheck,
} from "../eval/continuity-acceptance-301/src/fixture";
import type { CaseObservation } from "../eval/continuity-acceptance-301/src/observation";

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

  function scoreWith(
    check: ObjectiveCheck,
    change: (observation: CaseObservation) => CaseObservation = (observation) => observation,
  ) {
    const good = calibrationSamples()[0]!;
    const report = evaluateCase({
      loaded: {
        ...calibrationCase,
        oracle: {
          ...calibrationCase.oracle,
          criteria: [
            { check, description: "probe", id: "PROBE", kind: "objective", modes: ["real-model"], owner: "#999" },
          ],
        },
      },
      observation: change(good.observation),
      review: null,
    });
    return report.criteria.find((criterion) => criterion.id === "PROBE")!;
  }

  it("reports a criterion the runner cannot exercise yet as not-run, never as red or green", () => {
    const result = scoreWith({ capability: "seed a Forget request", type: "unsupported" });
    expect(result.status).toBe("not-run");
    expect(result.reason).toContain("seed a Forget request");
    expect(result.owner).toBe("#999");
  });

  it("judges Trust Actions from the admitted Action on the stream, not from the wording", () => {
    const withAction = (kinds: string[]) => (observation: CaseObservation) => ({
      ...observation,
      steps: observation.steps.map((step) =>
        step.id === "q1" && step.chat ? { ...step, chat: { ...step.chat, actions: kinds } } : step,
      ),
    });
    expect(scoreWith({ actionKind: "memory_forget", step: "q1", type: "action_admitted" }).status).toBe("fail");
    expect(
      scoreWith({ actionKind: "memory_forget", step: "q1", type: "action_admitted" }, withAction(["memory_forget"])).status,
    ).toBe("pass");
    // The #312 clue: a plain recap must not trigger a correction Action.
    expect(scoreWith({ step: "q1", type: "no_action" }).status).toBe("pass");
    const wrong = scoreWith({ step: "q1", type: "no_action" }, withAction(["memory_correction"]));
    expect(wrong.status).toBe("fail");
    expect(wrong.evidence.join(" ")).toContain("memory_correction");
  });

  it("treats a step that never ran as a harness error, unless a person chose not to play it", () => {
    const withoutFirstStep = (interactive: boolean) => (observation: CaseObservation) => ({
      ...observation,
      ...(interactive ? { interactive: true } : {}),
      steps: observation.steps.filter((step) => step.id !== "q1"),
    });
    const scripted = scoreWith({ step: "q1", type: "turn_committed" }, withoutFirstStep(false));
    expect(scripted.status).toBe("environment-error");
    const interactive = scoreWith({ step: "q1", type: "turn_committed" }, withoutFirstStep(true));
    expect(interactive.status).toBe("not-run");
    expect(interactive.reason).toContain("not played in this interactive session");
  });

  it("checks that words said during the run reach the Provider for a later turn", () => {
    expect(scoreWith({ inputs: ["q1"], step: "q1", type: "outbound_includes_input" }).status).toBe("pass");
    expect(scoreWith({ inputs: ["q2"], step: "q1", type: "outbound_includes_input" }).status).toBe("fail");
  });

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
