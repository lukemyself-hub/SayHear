import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPostgresPool } from "@sayhear/data";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createAcceptanceEnvironment,
  type AcceptanceEnvironment,
} from "../../eval/continuity-acceptance-301/src/environment";
import { evaluateCase } from "../../eval/continuity-acceptance-301/src/evaluate";
import { loadCase, oracleStrings } from "../../eval/continuity-acceptance-301/src/fixture";
import {
  IsolationError,
  resolveIsolationTarget,
} from "../../eval/continuity-acceptance-301/src/isolation";
import type { CaseObservation } from "../../eval/continuity-acceptance-301/src/observation";
import {
  buildRunReport,
  compareWithKnownRed,
  loadKnownRed,
} from "../../eval/continuity-acceptance-301/src/report";
import {
  reproducibilityDigest,
  runCase,
} from "../../eval/continuity-acceptance-301/src/runner";

/**
 * T00 #313 against the real system: synthetic history is loaded through the
 * real chat route into an isolated PostgreSQL schema, a real `next dev` app
 * answers over HTTP, the authoritative history and the controlled Inspector are
 * read back, and the only substituted part is the external Provider.
 *
 * This suite is what keeps ordinary CI green without hiding red: it asserts
 * that today's known gaps fail for the declared reason on the real path. When
 * a later ticket closes a gap, its entry leaves `known-red.json` and the
 * matching assertion here flips from `fail` to `pass` in the same change.
 */

if (!process.env.TEST_DATABASE_URL || !process.env.TEST_PURGE_MARKER_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL and TEST_PURGE_MARKER_DATABASE_URL are required.");
}

vi.setConfig({ hookTimeout: 180_000, testTimeout: 180_000 });

const target = resolveIsolationTarget({
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
  TEST_PURGE_MARKER_DATABASE_URL: process.env.TEST_PURGE_MARKER_DATABASE_URL,
});

function statuses(observation: CaseObservation, caseId: string) {
  const report = evaluateCase({ loaded: loadCase(caseId), observation, review: null });
  return {
    byId: Object.fromEntries(report.criteria.map((criterion) => [criterion.id, criterion])),
    report,
  };
}

describe("Continuity acceptance over the real chat path", () => {
  const smoke = loadCase("S01");
  const older = loadCase("C04");
  const controls = loadCase("C12");
  let environment: AcceptanceEnvironment;
  let first: CaseObservation;

  beforeAll(async () => {
    environment = await createAcceptanceEnvironment({
      initialNow: new Date(smoke.fixture.history[0]!.at),
      target,
    });
    first = await runCase({
      environment,
      fixture: smoke.fixture,
      fixtureSha256: smoke.fixtureSha256,
      mode: "deterministic",
    });
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  it("runs an ordinary conversation from seed to real HTTP chat to authoritative history", () => {
    expect(first.environmentErrors).toEqual([]);

    // Seeded history went through the real write path and is read back
    // verbatim through the normal history API.
    expect(first.seed.turns.map((turn) => turn.terminalEvent)).toEqual([
      "assistant_committed",
      "assistant_committed",
    ]);
    expect(first.seed.readback.flatMap((session) => session.messages.map((message) => message.text))).toEqual(
      smoke.fixture.history.flatMap((turn) => [turn.user, turn.assistant]),
    );

    // The follow-up turn streamed over HTTP and committed; controlled time,
    // not the wall clock, stamped it.
    const step = first.steps[0]!;
    expect(step.chat).toMatchObject({ httpStatus: 200, terminalEvent: "assistant_committed" });
    const today = first.finalHistory.find((session) => session.logicalDate === "2026-09-15");
    expect(today?.messages.map((message) => [message.actor, message.text, message.createdAt])).toEqual([
      ["user", smoke.fixture.steps[0]!.type === "say" ? smoke.fixture.steps[0]!.text : "", "2026-09-15T01:30:00.000Z"],
      ["assistant", step.chat?.streamedText, "2026-09-15T01:30:00.000Z"],
    ]);

    // Idle time passed the way it does in production: the scheduled scan
    // ended the quiet exchanges, so yesterday and today are separate sessions.
    expect(first.scheduledScans.length).toBeGreaterThan(0);
    expect(first.finalHistory.map((session) => session.logicalDate)).toEqual(["2026-09-14", "2026-09-15"]);

    const { byId, report } = statuses(first, "S01");
    for (const id of ["INV-seed-readback", "INV-oracle-not-in-outbound", "INV-no-duplicate-messages", "O-commit", "O-history", "O-background", "O-usage"]) {
      expect(byId[id]?.status, id).toBe("pass");
    }
    // A stub reply is never scored for meaning, and a run with unscored
    // criteria is incomplete rather than passed.
    expect(byId["S-reply"]?.status).toBe("not-run");
    expect(byId["O-deadline"]?.status).toBe("not-run");
    expect(report.status).toBe("not-run");
  });

  it("stubs only the external Provider, and never shows it the oracle", () => {
    const step = first.steps[0]!;
    // The Provider received a real Responses API request built by SayHear:
    // persona instructions plus the person's own words.
    const turn = step.providerRequests.find((request) => request.conversationTurn);
    expect(turn).toBeDefined();
    expect(turn?.strings.some((value) => value.includes("SayHear"))).toBe(true);
    expect(turn?.strings).toContain(smoke.fixture.history[0]!.user);

    // Nothing the scorer knows reached the model: not the title, the
    // capability, an expected fact or a failure signal.
    const outbound = [
      ...first.seed.providerStrings,
      ...first.backgroundProviderStrings,
      ...first.steps.flatMap((observed) => observed.providerRequests.flatMap((request) => request.strings)),
    ];
    expect(outbound.length).toBeGreaterThan(0);
    for (const expectation of oracleStrings(smoke.oracle)) {
      if (expectation.length < 8) continue;
      expect(outbound.some((value) => value.includes(expectation)), expectation).toBe(false);
    }
    // The seed prepared inputs only: no selection or answer was pre-written.
    // What reached the Provider is whatever the product itself selected.
    expect(step.inspection?.referencedEvents.length).toBeGreaterThan(0);
    expect(step.inspection?.compilerVersion).toMatch(/^context-compiler:/);
  });

  it("reproduces the same observable result after a reset", async () => {
    const before = reproducibilityDigest(first, smoke.fixture);
    await environment.reset();
    const again = await runCase({
      environment,
      fixture: smoke.fixture,
      fixtureSha256: smoke.fixtureSha256,
      mode: "deterministic",
    });
    expect(again.environmentErrors).toEqual([]);
    expect(again.identity.runId).toBe(first.identity.runId);
    expect(reproducibilityDigest(again, smoke.fixture)).toBe(before);
  });

  it("finds an unclaimed experience older than seven days from its original words (T03 #316)", async () => {
    await environment.reset();
    const observation = await runCase({
      environment,
      fixture: older.fixture,
      fixtureSha256: older.fixtureSha256,
      mode: "deterministic",
    });
    const { byId, report } = statuses(observation, "C04");

    expect(observation.environmentErrors).toEqual([]);
    expect(byId["INV-seed-readback"]?.status).toBe("pass");
    expect(byId["O-commit"]?.status).toBe("pass");
    expect(byId["O-history"]?.status).toBe("pass");
    // The three-month-old words and their adjacent message reached the
    // Provider and are recorded by the controlled Inspector.
    const found = byId["O-old-source"]!;
    expect(found.status).toBe("pass");
    expect(found.owner).toBe("#316");
    // Nothing semantic is scored from the fixed stub reply.
    expect(byId["S-detail"]?.status).toBe("not-run");
    expect(byId["S-no-invention"]?.status).toBe("not-run");
    expect(report.status).toBe("not-run");

    // The entry left the ledger in the same change: no unexpected red, and no
    // stale entry for these criteria.
    const comparison = compareWithKnownRed([report], loadKnownRed());
    expect(comparison.unexpectedRed).toEqual([]);
    expect(comparison.unexpectedGreen).toEqual([]);
  });

  it("keeps corrected and forgotten sources out of the history path, on the real path, and explains where each source went", async () => {
    await environment.reset();
    const observation = await runCase({
      environment,
      fixture: controls.fixture,
      fixtureSha256: controls.fixtureSha256,
      mode: "deterministic",
    });
    const { byId, report } = statuses(observation, "C12");

    expect(observation.environmentErrors).toEqual([]);
    expect(byId["INV-seed-readback"]?.status).toBe("pass");
    expect(byId["O-superseded-out"]?.status).toBe("pass");
    expect(byId["O-corrected-in"]?.status).toBe("pass");
    expect(byId["O-independent-in"]?.status).toBe("pass");
    // The Forget request seeded as fixture state is honoured with its replies.
    expect(byId["O-forget-out"]?.status).toBe("pass");
    // A Purge racing a turn cannot be run over HTTP (it revokes the sessions
    // the run reads back with); it is proven in-process, and stays not-run here.
    expect(byId["O-purge-race"]?.status).toBe("not-run");
    expect(report.status).toBe("not-run");

    // The turn really took the controlled history branch, not just the background.
    const work = observation.steps.find((step) => step.id === "work")!;
    expect(work.inspection?.historyRecall?.status).toBe("completed");
    expect(work.inspection?.turn?.finalDisposition).toBe("committed");
    expect(work.providerRequests.some((request) => request.conversationTurn)).toBe(true);

    // The person's own later restatement has no explicit association: it is
    // an ordinary dated message that may be quoted (ADR-0149). Neither its
    // presence nor its absence is asserted here; what matters is that the
    // answer gives the corrected figure as the present state, which only the
    // semantic criterion S-controls can judge (real model, T08).
    expect(byId["S-controls"]?.status).toBe("not-run");

    // The diagnosis names the very Provider call whose payload it inspected: the
    // id the Inspector recorded for the History Answer attempt.
    const diagnosed = buildRunReport({
      caseReport: report,
      loaded: controls,
      observation,
      plan: {} as never,
      reproducibilityDigest: "test",
    }).diagnosis.find((entry) => entry.stepId === "work")!;
    const answerCommand = work.inspection!.turn!.commands.find((command) => command.stage === "history_answer")!;
    expect(diagnosed.diagnosis.sources[0]!.trace!.providerResponseId).toBe(answerCommand.providerRequestId);
    expect(diagnosed.diagnosis.readState).toBe("complete");
    expect(diagnosed.diagnosis.disagreements).toEqual([]);

    const comparison = compareWithKnownRed([report], loadKnownRed());
    expect(comparison.unexpectedRed).toEqual([]);
    expect(comparison.unexpectedGreen).toEqual([]);

    // The app's own output for the whole history turn holds no message text,
    // clue or person: logs stay content-free (#320).
    const logFile = path.join(os.tmpdir(), `sayhear-history-app-log-${process.pid}-${Date.now()}.txt`);
    process.env["SAYHEAR_ACCEPTANCE_APP_LOG"] = logFile;
    try {
      await environment.restartApp();
      const log = readFileSync(logFile, "utf8");
      expect(log.length).toBeGreaterThan(0);
      const everything = [
        ...controls.fixture.history.flatMap((turn) => [turn.user, turn.assistant]),
        ...controls.fixture.steps.flatMap((step) => ("text" in step ? [step.text] : [])),
      ];
      for (const text of everything) {
        expect(log, `app output must not contain: ${text.slice(0, 12)}`).not.toContain(text);
        // Not even a recognisable fragment of a message.
        expect(log).not.toContain(text.slice(0, 12));
      }
    } finally {
      delete process.env["SAYHEAR_ACCEPTANCE_APP_LOG"];
      rmSync(logFile, { force: true });
    }
  });

  it("refuses to seed or reset a schema it cannot prove it owns", async () => {
    await expect(environment.assertOwned()).resolves.toBeUndefined();

    const pool = createPostgresPool({
      applicationName: "continuity-acceptance-self-test",
      connectionString: environment.schemaConnectionString(),
    });
    try {
      // Another run's stamp: the schema is no longer provably this run's.
      await pool.query("UPDATE acceptance_run_identity SET run_id = 'run-someone-else'");
      await expect(environment.assertOwned()).rejects.toBeInstanceOf(IsolationError);
      await expect(environment.reset()).rejects.toThrow(/different acceptance run/);
      await expect(
        runCase({ environment, fixture: smoke.fixture, fixtureSha256: smoke.fixtureSha256, mode: "deterministic" }),
      ).rejects.toBeInstanceOf(IsolationError);

      // The right stamp but a real-looking owner identity is refused as well.
      await pool.query("UPDATE acceptance_run_identity SET run_id = $1", [environment.runId]);
      await pool.query("UPDATE internal_owner_identities SET issuer = 'https://github.com', subject = '4242'");
      await expect(environment.reset()).rejects.toThrow(/real owner/);

      // Restored, the environment is usable and disposable again.
      await pool.query(
        "UPDATE internal_owner_identities SET issuer = 'https://acceptance.sayhear.invalid', subject = $1",
        [`continuity-acceptance:${environment.runId}`],
      );
      await expect(environment.assertOwned()).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
