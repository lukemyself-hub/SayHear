import { describe, expect, it } from "vitest";

import { loadLedger, planRun } from "../eval/continuity-acceptance-301/src/budget";
import {
  calibrationCase,
  calibrationSamples,
} from "../eval/continuity-acceptance-301/src/calibration";
import { evaluateCase, type CaseReport } from "../eval/continuity-acceptance-301/src/evaluate";
import {
  listCaseIds,
  loadCase,
  sha256,
  validateCase,
  validateLanguageCoverage,
  type CaseFixture,
  type CaseOracle,
  type LoadedCase,
} from "../eval/continuity-acceptance-301/src/fixture";
import {
  buildRunReport,
  compareWithKnownRed,
  loadKnownRed,
  renderMarkdown,
} from "../eval/continuity-acceptance-301/src/report";
import { reproducibilityDigest } from "../eval/continuity-acceptance-301/src/runner";

/**
 * T00 #313: the frozen case pack and its expectation ledgers, checked without
 * starting a model, a server or a database.
 */

const cases = listCaseIds().map((id) => loadCase(id));

function withFixture(loaded: LoadedCase, change: (fixture: CaseFixture) => CaseFixture): LoadedCase {
  const fixture = change(loaded.fixture);
  const fixtureText = JSON.stringify(fixture);
  const fixtureSha256 = sha256(fixtureText);
  // Re-bind the oracle so each probe isolates the one defect it introduces.
  return {
    ...loaded,
    fixture,
    fixtureSha256,
    fixtureText,
    oracle: { ...loaded.oracle, fixture: { sha256: fixtureSha256, version: fixture.fixtureVersion } },
  };
}

function withOracle(loaded: LoadedCase, change: (oracle: CaseOracle) => CaseOracle): LoadedCase {
  return { ...loaded, oracle: change(loaded.oracle) };
}

describe("continuity acceptance case pack", () => {
  it("ships the continuity cases (C01-C13, C16, the lifecycle case L01) and the three smoke cases", () => {
    expect(listCaseIds()).toEqual([
      "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C11", "C12", "C13", "C16", "L01",
      "S01", "S02", "S03",
    ]);
  });

  it("covers Chinese, English and code-switched conversation", () => {
    expect(validateLanguageCoverage(cases)).toEqual([]);
    expect(validateLanguageCoverage(cases.filter((loaded) => loaded.fixture.languageVariant !== "code-switch"))).toEqual([
      "suite has no code-switch case",
    ]);
  });

  for (const loaded of cases) {
    it(`${loaded.fixture.id} is valid and carries an independent ledger`, () => {
      expect(validateCase(loaded)).toEqual([]);
      const { oracle } = loaded;
      // Each case states what may and may not be said, how it should behave
      // and how it fails, and can be judged on the deterministic path.
      expect(oracle.facts.allowed.length + oracle.topics.length + oracle.time.length).toBeGreaterThan(0);
      expect(oracle.facts.forbidden.length).toBeGreaterThan(0);
      expect(oracle.expectedBehavior.length).toBeGreaterThan(0);
      expect(oracle.failureSignals.length).toBeGreaterThan(0);
      expect(oracle.sourceEligibility.length).toBeGreaterThan(0);
      expect(
        oracle.criteria.some(
          (criterion) => criterion.kind === "objective" && criterion.modes.includes("deterministic"),
        ),
      ).toBe(true);
      expect(oracle.criteria.some((criterion) => criterion.kind !== "objective")).toBe(true);
    });
  }

  it("refuses a fixture that was edited after its expectations were written", () => {
    const edited = { ...cases[0]!, fixtureSha256: sha256("edited") };
    expect(validateCase(edited).join("\n")).toMatch(/oracle is bound to fixture sha256/);
  });

  it("reports broken instants, timezones, ordering and references", () => {
    const base = loadCase("C04");
    const problems = (loaded: LoadedCase) => validateCase(loaded).join("\n");

    expect(
      problems(withFixture(base, (fixture) => ({ ...fixture, defaults: { ...fixture.defaults, timezone: "Asia/Shangai" } }))),
    ).toMatch(/not a valid IANA timezone/);
    expect(
      problems(
        withFixture(base, (fixture) => ({
          ...fixture,
          history: fixture.history.map((turn, index) => (index === 0 ? { ...turn, at: "2026-06-13 16:40" } : turn)),
        })),
      ),
    ).toMatch(/invalid UTC instant/);
    expect(
      problems(withFixture(base, (fixture) => ({ ...fixture, history: [...fixture.history].reverse() }))),
    ).toMatch(/not strictly later/);
    expect(
      problems(
        withFixture(base, (fixture) => ({
          ...fixture,
          steps: fixture.steps.map((step) => ({ ...step, at: "2026-01-01T00:00:00.000Z" })),
        })),
      ),
    ).toMatch(/happens before the preceding history/);
    expect(
      problems(
        withOracle(base, (oracle) => ({
          ...oracle,
          facts: {
            ...oracle.facts,
            allowed: [{ id: "a-ghost", sources: ["nowhere:user"], statement: "Refers to a message that does not exist." }],
          },
        })),
      ),
    ).toMatch(/unknown source nowhere:user/);
    expect(
      problems(
        withOracle(base, (oracle) => ({
          ...oracle,
          sourceEligibility: oracle.sourceEligibility.map((entry) =>
            entry.source === "piano:user" ? { ...entry, eligibility: "forbidden" as const } : entry,
          ),
        })),
      ),
    ).toMatch(/treats piano:user as allowed but sourceEligibility says forbidden/);
  });

  it("keeps expectations out of the model-visible half", () => {
    const base = loadCase("C04");
    // A scenario name or expectation field riding along in the fixture.
    expect(
      validateCase(withFixture(base, (fixture) => ({ ...fixture, title: "Old piano memory" }) as CaseFixture)).join("\n"),
    ).toMatch(/must not carry expectation field fixture\.title/);
    // An expected answer copied out of, or into, the conversation text.
    const statement = base.oracle.facts.allowed[0]!.statement;
    expect(
      validateCase(
        withFixture(base, (fixture) => ({
          ...fixture,
          steps: fixture.steps.map((step) => (step.type === "say" ? { ...step, text: `${step.text} ${statement}` } : step)),
        })),
      ).join("\n"),
    ).toMatch(/appears verbatim in the fixture/);
  });

  it("refuses a fixture that no longer exerts the pressure its case is about", () => {
    const base = loadCase("C01");
    const shortened = withFixture(base, (fixture) => ({
      ...fixture,
      history: fixture.history.filter((turn) => !turn.key.startsWith("more-")),
    }));
    expect(validateCase(shortened).join("\n")).toMatch(/precondition not met/);
  });
});

describe("continuity acceptance known-red ledger", () => {
  const ledger = loadKnownRed();

  it("only lists real deterministic criteria, each with an owning ticket", () => {
    // Empty once every owner ticket has turned its entry green (T07 closed the last).
    expect(ledger.entries.length).toBeGreaterThanOrEqual(0);
    for (const entry of ledger.entries) {
      const loaded = cases.find((candidate) => candidate.fixture.id === entry.caseId);
      const criterion = loaded?.oracle.criteria.find((candidate) => candidate.id === entry.criterionId);
      expect(criterion, `${entry.caseId} ${entry.criterionId}`).toBeDefined();
      expect(criterion?.kind).toBe("objective");
      expect(entry.owner).toMatch(/^#\d+$/);
      expect(criterion?.owner).toBe(entry.owner);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it("flags an undeclared failure and a declared failure that has turned green", () => {
    const report = (caseId: string, statuses: Record<string, CaseReport["status"]>): CaseReport => ({
      caseId,
      criteria: Object.entries(statuses).map(([id, status]) => ({
        description: id, evidence: [], id, kind: "objective", owner: null, reason: "r", status,
      })),
      mode: "deterministic",
      reviewer: null,
      runId: "r",
      status: "fail",
    });
    const declared = { entries: [{ caseId: "C04", criterionId: "O-old-source", owner: "#316", reason: "x" }], schemaVersion: "continuity-known-red:v1" as const };

    expect(compareWithKnownRed([report("C04", { "O-commit": "pass", "O-old-source": "fail" })], declared)).toEqual({
      unexpectedGreen: [],
      unexpectedRed: [],
    });
    // A regression nobody declared is not absorbed by the ledger.
    expect(
      compareWithKnownRed([report("C04", { "O-commit": "fail", "O-old-source": "fail" })], declared).unexpectedRed,
    ).toEqual([{ caseId: "C04", criterionId: "O-commit", reason: "r" }]);
    // Once fixed, the entry must be removed: a stale ledger fails too.
    expect(
      compareWithKnownRed([report("C04", { "O-commit": "pass", "O-old-source": "pass" })], declared).unexpectedGreen,
    ).toEqual(declared.entries);
    // not-run and environment errors are never counted as the declared red.
    expect(
      compareWithKnownRed([report("C04", { "O-old-source": "not-run" })], declared).unexpectedGreen,
    ).toEqual(declared.entries);
    // A case that was not part of this run says nothing about its entries.
    expect(compareWithKnownRed([report("S01", { "O-commit": "pass" })], declared)).toEqual({
      unexpectedGreen: [],
      unexpectedRed: [],
    });
  });
});

describe("continuity acceptance report", () => {
  const sample = calibrationSamples().find((candidate) => candidate.name === "missing-early-topic")!;
  const plan = planRun({
    environment: {},
    ledger: loadLedger(),
    requestedMode: undefined,
    shape: { generationSteps: 3, scheduledScans: 0, seedTurns: 4 },
  });
  const caseReport = evaluateCase({ loaded: calibrationCase, observation: sample.observation, review: sample.review });
  const report = buildRunReport({
    caseReport,
    loaded: calibrationCase,
    observation: sample.observation,
    plan,
    reproducibilityDigest: reproducibilityDigest(sample.observation, calibrationCase.fixture),
  });
  const markdown = renderMarkdown(report);

  it("carries identity, transcript, evidence, sources, timing, usage and remaining risk", () => {
    expect(report.identity).toMatchObject({
      fixtureSha256: calibrationCase.fixtureSha256,
      gitCommit: expect.any(String),
      oracleSha256: calibrationCase.oracleSha256,
      runId: "calibration-run",
    });
    expect(report.transcript.map((turn) => turn.stepId)).toEqual(["q1", "q2", "q3"]);
    expect(report.sourceManifest[0]?.rows.find((row) => row.source === "k1:user")).toEqual({
      eligibility: "allowed", inInspector: true, inProviderRequest: true, source: "k1:user",
    });
    expect(report.timings[0]).toMatchObject({ cliFirstVisibleTextMs: 900, providerLatencyMs: 850, stepId: "q1" });
    expect(report.usage.inputTokens).toBeNull(); // one step has no usage: unknown stays unknown
    expect(report.remainingRisks.length).toBeGreaterThan(0);
  });

  it("renders a failed run as failed, with the evidence a reader needs to check it", () => {
    expect(markdown.split("\n")[0]).toContain("CAL: FAIL");
    expect(markdown).toContain("is **not** a completed acceptance pass");
    expect(markdown).toContain("`S-topics`");
    expect(markdown).toContain("The fence repair is never mentioned.");
    expect(markdown).toContain("not browser rendering");
  });

  it("gives the same digest for the same behaviour and a different one when behaviour changes", () => {
    const [first, second] = calibrationSamples();
    const digest = (observation: typeof sample.observation) =>
      reproducibilityDigest(observation, calibrationCase.fixture);
    // Generated identifiers and wall-clock timings do not affect the digest.
    const retimed = {
      ...first!.observation,
      identity: { ...first!.observation.identity, runId: "another-run" },
      steps: first!.observation.steps.map((step) =>
        step.chat ? { ...step, chat: { ...step.chat, timing: { ...step.chat.timing, committedMs: 9_999 } } } : step,
      ),
    };
    expect(digest(retimed)).toBe(digest(first!.observation));
    expect(digest(second!.observation)).not.toBe(digest(first!.observation));
  });
});
