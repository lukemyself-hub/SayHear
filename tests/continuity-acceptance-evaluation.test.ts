import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  calibrationCase,
  calibrationSamples,
} from "../eval/continuity-acceptance-301/src/calibration";
import {
  aggregateStatus,
  applyOwnerRulings,
  evaluateCase,
  exitCodeForStatus,
  loadOwnerRulings,
} from "../eval/continuity-acceptance-301/src/evaluate";
import {
  loadCase,
  packRoot,
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

  // --- #319: request lifecycle checks --------------------------------------
  const withoutAssistantReplies = (observation: CaseObservation): CaseObservation => ({
    ...observation,
    finalHistory: observation.finalHistory.map((session) => ({
      ...session,
      messages: session.messages.filter((message) => message.actor !== "assistant"),
    })),
  });
  const withChat =
    (change: (chat: NonNullable<CaseObservation["steps"][number]["chat"]>) => unknown) =>
    (observation: CaseObservation): CaseObservation => ({
      ...observation,
      steps: observation.steps.map((step) =>
        step.id === "q1" && step.chat ? ({ ...step, chat: change(step.chat) } as never) : step,
      ),
    });
  const stoppedStream = (closedMs: number, category: string | null = "timeout") =>
    withChat((chat) => ({
      ...chat,
      events: [
        { category: null, delta: null, elapsedMs: 5, type: "user_committed" },
        { category, delta: null, elapsedMs: closedMs, type: "response_failed" },
      ],
      streamedText: "",
      terminalEvent: "response_failed",
      timing: { ...chat.timing, committedMs: null, streamClosedMs: closedMs },
    }));
  const withInspection =
    (commandStatus: string, attemptStatus: string) =>
    (observation: CaseObservation): CaseObservation => ({
      ...observation,
      steps: observation.steps.map((step) =>
        step.id === "q1" && step.inspection
          ? ({ ...step, inspection: { ...step.inspection, attemptStatus, commandStatus } } as never)
          : step,
      ),
    });
  const compose =
    (...changes: Array<(observation: CaseObservation) => CaseObservation>) =>
    (observation: CaseObservation) =>
      changes.reduce((current, change) => change(current), observation);

  it("fails a reply that a newer message had retired when it was shown or stored, and passes when it was neither", () => {
    const check = { step: "q1", type: "replaced_reply_never_shown" } as const;
    // The calibration transcript's q1 streams and stores a reply.
    expect(scoreWith(check).status).toBe("fail");
    const retired = compose(
      stoppedStream(900, "aborted"),
      withoutAssistantReplies,
    );
    expect(scoreWith(check, retired).status).toBe("pass");
    // Hidden from the stream but still stored: still a failure.
    expect(scoreWith(check, stoppedStream(900, "aborted")).status).toBe("fail");
  });

  it("passes a stalled request only when it ended with a timeout inside the limit, committed nothing and left nothing running", () => {
    const check = { maxMs: 9_000, step: "q1", type: "stopped_at_deadline" } as const;
    const stopped = compose(
      stoppedStream(6_020),
      withoutAssistantReplies,
      withInspection("failed", "failed"),
    );
    expect(scoreWith(check, stopped).status).toBe("pass");
    // Waited past the limit.
    expect(
      scoreWith(check, compose(stoppedStream(31_000), withoutAssistantReplies, withInspection("failed", "failed"))).status,
    ).toBe("fail");
    // Ended, but not as a timeout.
    expect(
      scoreWith(check, compose(stoppedStream(6_000, "unknown"), withoutAssistantReplies, withInspection("failed", "failed"))).status,
    ).toBe("fail");
    // Ended on time but the command was left running.
    expect(
      scoreWith(check, compose(stoppedStream(6_000), withoutAssistantReplies, withInspection("running", "running"))).status,
    ).toBe("fail");
    // A late answer was committed anyway.
    expect(
      scoreWith(check, compose(stoppedStream(6_000), withInspection("failed", "failed"))).status,
    ).toBe("fail");
  });

  /**
   * Review fix S: an excluded source that reaches the Provider cut short,
   * re-punctuated or embedded in other text is still a leak. The exact-text
   * match alone would miss it.
   */
  describe("an excluded source is recognised by its distinctive fragments", () => {
    const FORBIDDEN = "The basement flooded this morning and I spent hours bailing it out.";
    const excludes: ObjectiveCheck = { sources: ["k0:user"], step: "q1", type: "outbound_excludes" };
    const sending = (extra: string) => (observation: CaseObservation) => ({
      ...observation,
      steps: observation.steps.map((step) =>
        step.id === "q1"
          ? {
              ...step,
              providerRequests: step.providerRequests.map((request) => ({
                ...request,
                strings: [...request.strings, extra],
              })),
            }
          : step,
      ),
    });

    it("still passes when nothing of the source was sent", () => {
      expect(scoreWith(excludes).status).toBe("pass");
      expect(scoreWith(excludes, sending("An unrelated line about the weather and a long walk by the river.")).status).toBe("pass");
    });

    it("fails on the whole message, as before", () => {
      expect(scoreWith(excludes, sending(FORBIDDEN)).status).toBe("fail");
    });

    it("fails on a truncated, re-punctuated or embedded part of the message", () => {
      for (const leaked of [
        "The basement flooded this morning and I spent hours",
        "earlier they said: the basement flooded, this morning — and I spent hours bailing it out",
        "summary=THE BASEMENT FLOODED THIS MORNING; next=...",
      ]) {
        const result = scoreWith(excludes, sending(leaked));
        expect(result.status, leaked).toBe("fail");
        expect(result.evidence.join(" ")).toMatch(/fragment/);
      }
    });

    it("does not mistake words the source shares with a permitted message for a leak", () => {
      // The person corrected the message: almost every word is shared, and the
      // corrected wording is allowed to be sent.
      const corrected = "The basement flooded this morning and I spent minutes mopping it up.";
      const good = calibrationSamples()[0]!;
      const loaded = {
        ...calibrationCase,
        fixture: {
          ...calibrationCase.fixture,
          steps: [
            ...calibrationCase.fixture.steps,
            { at: "2026-03-25T15:07:00.000Z", id: "fix", target: "k0", text: corrected, type: "correct" as const },
          ],
        },
        oracle: {
          ...calibrationCase.oracle,
          criteria: [
            { check: excludes, description: "probe", id: "PROBE", kind: "objective" as const, modes: ["real-model" as const] },
          ],
        },
      };
      const probe = (extra: string) =>
        evaluateCase({ loaded, observation: sending(extra)(good.observation), review: null }).criteria.find(
          (criterion) => criterion.id === "PROBE",
        )!;
      expect(probe(corrected).status).toBe("pass");
      // The part only the superseded wording has is still caught.
      expect(probe("and I spent hours bailing it out").status).toBe("fail");
    });

    it("recognises a fragment of a Chinese message without spaces or punctuation", () => {
      const zh = "我朋友阿梅私下告诉我她被裁员了，补偿都还没谈拢，她让我千万别往外说。";
      const good = calibrationSamples()[0]!;
      const loaded = {
        ...calibrationCase,
        fixture: {
          ...calibrationCase.fixture,
          history: calibrationCase.fixture.history.map((turn) =>
            turn.key === "k0" ? { ...turn, user: zh } : turn,
          ),
        },
        oracle: {
          ...calibrationCase.oracle,
          criteria: [
            { check: excludes, description: "probe", id: "PROBE", kind: "objective" as const, modes: ["real-model" as const] },
          ],
        },
      };
      const probe = (extra: string) =>
        evaluateCase({ loaded, observation: sending(extra)(good.observation), review: null }).criteria.find(
          (criterion) => criterion.id === "PROBE",
        )!;
      expect(probe("背景：阿梅 私下 告诉我 她被裁员了").status).toBe("fail");
      expect(probe("今天天气不错，我们去河边散步了很久。").status).toBe("pass");
    });
  });

  it("never reports a run as complete unless every required criterion passed", () => {
    expect(aggregateStatus(["pass", "pass"])).toBe("pass");
    expect(aggregateStatus(["pass", "not-run"])).toBe("not-run");
    expect(aggregateStatus(["pass", "needs-review", "not-run"])).toBe("needs-review");
    expect(aggregateStatus(["needs-review", "fail", "not-run"])).toBe("fail");
    expect(aggregateStatus(["fail", "environment-error"])).toBe("environment-error");
    expect(aggregateStatus([])).toBe("not-run");
  });

  it("leaves a criterion an owner ruling took out of acceptance out of the verdict, without deleting it", () => {
    // Not counted is neither a pass nor a gap: the rest decides.
    expect(aggregateStatus(["pass", "not-counted"])).toBe("pass");
    expect(aggregateStatus(["fail", "not-counted"])).toBe("fail");
    expect(aggregateStatus(["not-counted"])).toBe("not-run");

    // Luke 2026-10-12: a natural continuation with no clue at all is not an acceptance requirement.
    for (const [caseId, criterionId] of [
      ["H05", "S-bare"],
      ["H05", "O-bare-older"],
      ["C05", "S-bare"],
      ["C05", "O-bare-older"],
    ] as const) {
      const ruled = applyOwnerRulings(caseId, {
        description: "d",
        evidence: ["e"],
        id: criterionId,
        kind: criterionId.startsWith("S-") ? "semantic" : "objective",
        owner: null,
        reason: "The model named neither matter.",
        status: "fail",
      });
      expect(ruled.status).toBe("not-counted");
      expect(ruled.reason).toMatch(/Luke 2026-10-12/);
      // What was observed stays on the record.
      expect(ruled.evidence.join("\n")).toContain("observed: fail");
      expect(ruled.evidence.join("\n")).toContain("The model named neither matter.");
    }
    // The cued continuation is still required.
    const cued = applyOwnerRulings("H05", {
      description: "d", evidence: [], id: "S-cued", kind: "semantic", owner: null, reason: "r", status: "needs-review",
    });
    expect(cued.status).toBe("needs-review");
    // A ruling on how to read a criterion travels with it for whoever reviews the answer.
    expect(cued.evidence.join("\n")).toMatch(/owner ruling .*Luke 2026-10-12.*did not ask what the letter says/i);
    const controls = applyOwnerRulings("H12", {
      description: "d", evidence: [], id: "S-controls", kind: "semantic", owner: null, reason: "r", status: "needs-review",
    });
    expect(controls.evidence.join("\n")).toMatch(/earlier wording.*passes/i);
  });

  it("names only criteria that still exist in the oracles, and leaves the frozen holdout files untouched", () => {
    const rulings = loadOwnerRulings();
    expect(rulings.rulings.every((ruling) => ruling.by === "Luke" && ruling.date === "2026-10-12")).toBe(true);
    for (const entry of [...rulings.notCounted, ...rulings.interpretations]) {
      const loaded = entry.caseId.startsWith("H")
        ? loadCase(entry.caseId, {
            cases: path.join(packRoot, "holdout", "cases"),
            oracle: path.join(packRoot, "holdout", "oracle"),
          })
        : loadCase(entry.caseId);
      expect(loaded.oracle.criteria.map((criterion) => criterion.id)).toContain(entry.criterionId);
      expect(rulings.rulings.map((ruling) => ruling.id)).toContain(entry.ruling);
    }
    const freeze = JSON.parse(
      readFileSync(new URL("../eval/continuity-acceptance-301/holdout/FREEZE.json", import.meta.url), "utf8"),
    ) as { cases: Record<string, { oracleSha256: string }> };
    for (const caseId of ["H05", "H06", "H07", "H10", "H12"]) {
      const bytes = readFileSync(
        new URL(`../eval/continuity-acceptance-301/holdout/oracle/${caseId}.oracle.json`, import.meta.url),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(freeze.cases[caseId]!.oracleSha256);
    }
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
