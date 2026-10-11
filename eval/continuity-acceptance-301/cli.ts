import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { ACCEPTANCE_INACTIVITY_TIMEOUT_MS, repositoryRoot } from "./src/app-server";
import { loadLedger, planRun, type RunPlan } from "./src/budget";
import { calibrationCase, calibrationSamples } from "./src/calibration";
import { createAcceptanceEnvironment, type AcceptanceEnvironment } from "./src/environment";
import {
  evaluateCase,
  exitCodeForStatus,
  REVIEW_SCHEMA_VERSION,
  RUBRIC_VERSION,
  type CaseReport,
  type ReviewFile,
} from "./src/evaluate";
import {
  listCaseIds,
  loadCase,
  validateCase,
  validateLanguageCoverage,
  type LoadedCase,
} from "./src/fixture";
import { IsolationError, resolveIsolationTarget } from "./src/isolation";
import { renderLatencyMarkdown, runLatencyProfiles } from "./src/latency";
import {
  OBSERVATION_SEAL_FILE,
  observationIntegrityProblems,
  sealObservation,
  type CaseObservation,
} from "./src/observation";
import {
  buildRunReport,
  compareWithKnownRed,
  knownRedOutcome,
  loadKnownRed,
  renderMarkdown,
  suiteStatus,
} from "./src/report";
import { combinedVersion } from "./src/versions";
import { openCaseSession, playStep, reproducibilityDigest, runCase } from "./src/runner";

/**
 * Continuity acceptance CLI (T00 #313). See README.md in this directory.
 *
 * Exit codes: 0 pass · 1 product failure · 2 incomplete (not run / awaiting
 * review) · 3 harness or environment error · 4 blocked by the model-mode or
 * budget gate · 64 usage error.
 */

const EXIT_BLOCKED = 4;
const EXIT_USAGE = 64;

const HELP = `Continuity acceptance CLI (T00 #313)

  validate  [--case ID ...]                    check fixtures, oracles, source refs, timezones
  plan      [--case ID ...] [--mode MODE]      dry run: model mode, request/token/cost bounds, budget left
  run-case  ID [--mode MODE] [--out DIR] [--review FILE] [--verify-reset]
  suite     [--case ID ...] [--mode MODE] [--out DIR] [--expect-known-red [--regression-only]]
  chat      ID [--mode MODE]                   seed the case, then talk to it interactively
  report    --run DIR [--review FILE]          re-score a stored, sealed run (for example with a review)
  rebind    [--case ID ...]                  re-point oracles at deliberately changed development fixtures
  calibrate                                    prove the checker catches prefabricated bad transcripts
  versions                                     the combined version of the continuity stack, with a fingerprint (#320)
  latency   [--repeats N] [--provider-delay-ms N] [--stall-ms N] [--budget-ms N] [--out DIR]
                                               same-method chat latency profiles against the stand-in Provider (#319)

MODE is deterministic (default) or real-model. Any command accepts --dry-run
to stop after planning. Database: SAYHEAR_ACCEPTANCE_DATABASE_URL and
SAYHEAR_ACCEPTANCE_MARKER_DATABASE_URL, else TEST_DATABASE_URL and
TEST_PURGE_MARKER_DATABASE_URL. DATABASE_URL is never used.
`;

class UsageError extends Error {}

function selectCases(ids: readonly string[] | undefined): LoadedCase[] {
  const all = listCaseIds();
  const chosen = ids && ids.length > 0 ? [...ids] : all;
  for (const id of chosen) {
    if (!all.includes(id)) throw new UsageError(`Unknown case ${id}. Known: ${all.join(", ")}`);
  }
  return chosen.map((id) => loadCase(id));
}

function requireValid(cases: readonly LoadedCase[]): void {
  const problems = cases.flatMap((loaded) =>
    validateCase(loaded).map((problem) => `${loaded.fixture.id}: ${problem}`),
  );
  if (problems.length > 0) {
    throw new UsageError(`Refusing to run invalid cases:\n- ${problems.join("\n- ")}`);
  }
}

function plan(cases: readonly LoadedCase[], mode: string | undefined): RunPlan {
  return planRun({
    environment: process.env,
    ledger: loadLedger(),
    requestedMode: mode,
    shape: {
      generationSteps: cases.reduce(
        (total, loaded) =>
          total + loaded.fixture.steps.filter((step) => step.type === "say").length,
        0,
      ),
      scheduledScans: cases.reduce((total, loaded) => {
        const instants = [...loaded.fixture.history, ...loaded.fixture.steps].map((entry) =>
          Date.parse(entry.at),
        );
        return (
          total +
          instants.filter(
            (instant, index) =>
              index > 0 && instant - instants[index - 1]! > ACCEPTANCE_INACTIVITY_TIMEOUT_MS,
          ).length
        );
      }, 0),
      seedTurns: cases.reduce((total, loaded) => total + loaded.fixture.history.length, 0),
    },
  });
}

function printPlan(runPlan: RunPlan): void {
  const cost =
    runPlan.estimatedCostUsdMicros === null
      ? "unknown (no price recorded)"
      : `${runPlan.estimatedCostUsdMicros} USD micros`;
  console.log(`mode:                    ${runPlan.mode}`);
  console.log(`model:                   ${runPlan.model}`);
  console.log(`history turns (stubbed): ${runPlan.shape.seedTurns}`);
  console.log(`follow-up turns:         ${runPlan.shape.generationSteps}`);
  console.log(`scheduled scans:         ${runPlan.shape.scheduledScans} (each may start background model roles)`);
  console.log(`paid requests, at most:  ${runPlan.paidRequestUpperBound} (${runPlan.requestsPerStepUpperBound} per turn incl. retry and continuation)`);
  console.log(`tokens, at most:         input ${runPlan.inputTokenUpperBound}, output ${runPlan.outputTokenUpperBound}`);
  console.log(`cost, at most:           ${cost}`);
  console.log(`budget:                  cap ${runPlan.capUsdMicros} USD micros, remaining ${runPlan.remainingUsdMicros}, entries of unknown cost ${runPlan.unknownCostEntries}`);
  console.log(`status:                  ${runPlan.status.toUpperCase()}`);
  for (const blocker of runPlan.blockers) console.log(`  blocked: ${blocker}`);
}

/**
 * Real-model mode shares every gate with deterministic mode and is refused
 * here rather than silently served by the stub. T00 delivers the gate and the
 * budget check; the live transport is wired when a paid run is authorised.
 */
function requireRunnable(runPlan: RunPlan): void {
  if (runPlan.status === "blocked") {
    printPlan(runPlan);
    console.error("BLOCKED: real-model mode cannot start. Nothing was sent and nothing was scored.");
    process.exit(EXIT_BLOCKED);
  }
  if (runPlan.mode === "real-model") {
    printPlan(runPlan);
    console.error(
      "BLOCKED: the gate passed, but the live Provider transport for real-model runs is not wired in T00 (#313). It lands with the first authorised paid run (T08 #321). Nothing was sent; the stub was not substituted.",
    );
    process.exit(EXIT_BLOCKED);
  }
}

function defaultOutDirectory(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(repositoryRoot, "artifacts/continuity-acceptance", stamp);
}

function reviewTemplate(loaded: LoadedCase, observation: CaseObservation): ReviewFile {
  return {
    caseId: observation.caseId,
    findings: loaded.oracle.criteria.flatMap((criterion) =>
      criterion.kind === "objective"
        ? []
        : [...criterion.required, ...criterion.forbidden].map((itemId) => ({
            criterionId: criterion.id,
            itemId,
            quote: "",
            reason: "",
            verdict: "needs-review" as const,
          })),
    ),
    reviewer: "agent:<name> | human:<name>",
    rubricVersion: RUBRIC_VERSION,
    runId: observation.identity.runId,
    schemaVersion: REVIEW_SCHEMA_VERSION,
  };
}

function writeRun(input: {
  digest: string;
  loaded: LoadedCase;
  observation: CaseObservation;
  outDirectory: string;
  review: ReviewFile | null;
  runPlan: RunPlan;
}): CaseReport {
  const caseReport = evaluateCase({
    loaded: input.loaded,
    observation: input.observation,
    review: input.review,
  });
  const report = buildRunReport({
    caseReport,
    loaded: input.loaded,
    observation: input.observation,
    plan: input.runPlan,
    reproducibilityDigest: input.digest,
  });
  const directory = path.join(input.outDirectory, input.loaded.fixture.id);
  mkdirSync(directory, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFileSync(
      path.join(directory, name),
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  // The stored observation is sealed so `report` can tell the bytes this run
  // wrote from a file that was edited or assembled afterwards.
  const observationText = `${JSON.stringify(input.observation, null, 2)}\n`;
  write("observation.json", observationText);
  write(OBSERVATION_SEAL_FILE, `${sealObservation(observationText)}\n`);
  write("report.json", report);
  write("report.md", renderMarkdown(report));
  write("review-template.json", reviewTemplate(input.loaded, input.observation));
  return caseReport;
}

function readReview(file: string | undefined): ReviewFile | null {
  return file ? (JSON.parse(readFileSync(path.resolve(file), "utf8")) as ReviewFile) : null;
}

function initialNow(loaded: LoadedCase): Date {
  return new Date(loaded.fixture.history[0]?.at ?? loaded.fixture.steps[0]!.at);
}

function environmentFailure(loaded: LoadedCase, error: unknown): CaseObservation {
  return {
    backgroundProviderStrings: [],
    caseId: loaded.fixture.id,
    environmentErrors: [error instanceof Error ? error.message.split("\n")[0]! : String(error)],
    finalHistory: [],
    identity: {
      fixtureSha256: loaded.fixtureSha256,
      fixtureVersion: loaded.fixture.fixtureVersion,
      gitCommit: "unknown",
      gitDirty: true,
      model: "unknown",
      recentContextGovernance: "unknown",
      runId: "not-started",
    },
    mode: "deterministic",
    scheduledScans: [],
    schemaVersion: "continuity-acceptance-observation:v1",
    seed: { providerStrings: [], readback: [], turns: [] },
    steps: [],
  };
}

async function runOne(
  loaded: LoadedCase,
  runPlan: RunPlan,
  options: { outDirectory: string; review: ReviewFile | null; verifyReset: boolean },
): Promise<CaseReport> {
  let environment: AcceptanceEnvironment | null = null;
  let observation: CaseObservation;
  let digest = "";
  try {
    // Isolation is decided before anything is created or dropped.
    const target = resolveIsolationTarget(process.env);
    environment = await createAcceptanceEnvironment({ initialNow: initialNow(loaded), target });
    const run = () =>
      runCase({
        environment: environment!,
        fixture: loaded.fixture,
        fixtureSha256: loaded.fixtureSha256,
        mode: runPlan.mode,
      });
    observation = await run();
    digest = reproducibilityDigest(observation, loaded.fixture);
    if (options.verifyReset) {
      await environment.reset();
      const again = reproducibilityDigest(await run(), loaded.fixture);
      if (again !== digest) {
        observation = {
          ...observation,
          environmentErrors: [
            `Reset is not reproducible: digest ${digest} before reset, ${again} after.`,
          ],
        };
      } else {
        console.log(`${loaded.fixture.id}: reset reproduced digest ${digest}`);
      }
    }
  } catch (error) {
    if (error instanceof IsolationError) throw error;
    observation = environmentFailure(loaded, error);
  } finally {
    await environment?.dispose().catch(() => {});
  }
  return writeRun({
    digest,
    loaded,
    observation,
    outDirectory: options.outDirectory,
    review: options.review,
    runPlan,
  });
}

function printCase(report: CaseReport): void {
  console.log(`${report.caseId}: ${report.status.toUpperCase()}`);
  for (const criterion of report.criteria) {
    if (criterion.status === "pass") continue;
    console.log(`  ${criterion.status.toUpperCase().padEnd(17)} ${criterion.id} — ${criterion.reason}`);
  }
}

async function commandChat(loaded: LoadedCase, runPlan: RunPlan, outDirectory: string): Promise<number> {
  const target = resolveIsolationTarget(process.env);
  const environment = await createAcceptanceEnvironment({ initialNow: initialNow(loaded), target });
  const open = () =>
    openCaseSession({
      environment,
      fixture: loaded.fixture,
      fixtureSha256: loaded.fixtureSha256,
      interactive: true,
      mode: runPlan.mode,
      onStep(step) {
        if (step.type === "restart") return;
        console.log(
          `[${step.id}] ${step.chat?.terminalEvent ?? (step.chat?.clientAborted ? "client aborted" : "no terminal event")} · first text ${step.chat?.timing.firstVisibleTextMs?.toFixed(0) ?? "—"} ms · committed ${step.chat?.timing.committedMs?.toFixed(0) ?? "—"} ms`,
        );
        console.log(`assistant> ${step.chat?.streamedText ?? ""}`);
      },
    });
  let session = await open();
  let now = new Date(loaded.fixture.steps[0]!.at);
  let abortNext: number | undefined;
  let counter = 0;
  let lastSaid: string | null = null;
  let played = 0;
  console.log(
    `Seeded ${session.seed.turns.length} history turns for ${loaded.fixture.id}. Controlled time is ${now.toISOString()}.`,
  );
  console.log("Type a message, or: /next (play the next scripted step) · /at ISO · /advance 2h30m|1d · /abort N · /resend · /restart · /history · /inspect · /reset · /report · /quit");
  const lines = createInterface({ input: process.stdin, terminal: false });
  let lastObservation: CaseObservation | null = null;
  try {
    for await (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line === "/quit") break;
      if (line.startsWith("/at ")) {
        const next = new Date(line.slice(4).trim());
        if (Number.isNaN(next.getTime())) console.log("Not a valid ISO instant.");
        else now = next;
        console.log(`time> ${now.toISOString()}`);
      } else if (line.startsWith("/advance ")) {
        const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/.exec(line.slice(9).trim());
        if (!match || !match[0]) console.log("Use for example /advance 1d, /advance 2h30m.");
        else {
          now = new Date(
            now.getTime() +
              (Number(match[1] ?? 0) * 24 * 60 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 60_000,
          );
        }
        console.log(`time> ${now.toISOString()}`);
      } else if (line.startsWith("/abort ")) {
        abortNext = Number(line.slice(7));
        console.log(`The next message will be cancelled after ${abortNext} delta(s).`);
      } else if (line === "/next") {
        const scripted = loaded.fixture.steps[played];
        if (!scripted) console.log("The fixture has no further scripted step.");
        else {
          played += 1;
          now = new Date(scripted.at);
          await playStep(session, scripted);
          if (scripted.type === "say") lastSaid = scripted.id;
          console.log(`played scripted step ${scripted.id} at ${now.toISOString()}`);
        }
      } else if (line === "/resend") {
        if (!lastSaid) console.log("Nothing to resend yet.");
        else await session.resend(`chat-${(counter += 1)}`, lastSaid, now);
      } else if (line === "/restart") {
        await session.restart(`chat-${(counter += 1)}`, now);
        console.log("app restarted");
      } else if (line === "/history" || line === "/inspect" || line === "/report") {
        lastObservation = await session.finish();
        if (line === "/history") {
          for (const day of lastObservation.finalHistory) {
            console.log(`--- ${day.logicalDate} (${day.messages.length} messages)`);
            for (const message of day.messages) {
              console.log(`${message.createdAt} ${message.actor}: ${message.text}`);
            }
          }
        } else if (line === "/inspect") {
          console.log(JSON.stringify(lastObservation.steps.at(-1)?.inspection ?? null, null, 2));
        } else {
          const report = writeRun({
            digest: reproducibilityDigest(lastObservation, loaded.fixture),
            loaded,
            observation: lastObservation,
            outDirectory,
            review: null,
            runPlan,
          });
          printCase(report);
          console.log(`Wrote ${path.join(outDirectory, loaded.fixture.id)}`);
        }
      } else if (line === "/reset") {
        await environment.reset();
        session = await open();
        now = new Date(loaded.fixture.steps[0]!.at);
        lastSaid = null;
        played = 0;
        console.log(`Reset to the seeded baseline. Controlled time is ${now.toISOString()}.`);
      } else if (line.startsWith("/")) {
        console.log("Unknown command.");
      } else {
        const id = `chat-${(counter += 1)}`;
        await session.say({
          at: now,
          id,
          text: line,
          ...(abortNext === undefined ? {} : { abortAfterDeltas: abortNext }),
        });
        abortNext = undefined;
        lastSaid = id;
      }
    }
  } finally {
    await environment.dispose().catch(() => {});
  }
  return 0;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      case: { multiple: true, type: "string" },
      "dry-run": { type: "boolean" },
      "expect-known-red": { type: "boolean" },
      "regression-only": { type: "boolean" },
      "budget-ms": { type: "string" },
      help: { type: "boolean" },
      "provider-delay-ms": { type: "string" },
      repeats: { type: "string" },
      "stall-ms": { type: "string" },
      mode: { type: "string" },
      out: { type: "string" },
      review: { type: "string" },
      run: { type: "string" },
      "verify-reset": { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(HELP);
    return command ? 0 : EXIT_USAGE;
  }

  if (command === "versions") {
    console.log(JSON.stringify(combinedVersion(), null, 2));
    return 0;
  }

  if (command === "calibrate") {
    let wrong = 0;
    for (const sample of calibrationSamples()) {
      const report = evaluateCase({ loaded: calibrationCase, observation: sample.observation, review: sample.review });
      const statuses = Object.fromEntries(report.criteria.map((criterion) => [criterion.id, criterion.status]));
      const misses = Object.entries(sample.expect.criteria).filter(([id, status]) => statuses[id] !== status);
      const ok = misses.length === 0 && report.status === sample.expect.aggregate;
      if (!ok) wrong += 1;
      console.log(`${ok ? "ok  " : "MISS"} ${sample.name} — ${sample.defect} → ${report.status}`);
      for (const [id, status] of misses) console.log(`       ${id}: expected ${status}, got ${statuses[id]}`);
    }
    console.log(wrong === 0 ? "Checker calibration holds." : `${wrong} calibration sample(s) scored wrongly.`);
    return wrong === 0 ? 0 : 1;
  }

  if (command === "validate") {
    const cases = selectCases(values.case);
    const problems = cases.flatMap((loaded) =>
      validateCase(loaded).map((problem) => `${loaded.fixture.id}: ${problem}`),
    );
    if (!values.case) problems.push(...validateLanguageCoverage(cases));
    for (const loaded of cases) {
      console.log(
        `${loaded.fixture.id}  ${loaded.fixture.languageVariant.padEnd(11)} ${loaded.fixture.stage.padEnd(11)} history ${String(loaded.fixture.history.length).padStart(3)}  steps ${loaded.fixture.steps.length}  criteria ${loaded.oracle.criteria.length}  ${loaded.oracle.title}`,
      );
    }
    for (const problem of problems) console.error(`INVALID ${problem}`);
    console.log(problems.length === 0 ? `${cases.length} case(s) valid.` : `${problems.length} problem(s).`);
    return problems.length === 0 ? 0 : 1;
  }

  if (command === "rebind") {
    // An explicit, reviewable act: re-point an oracle at the fixture bytes on
    // disk after the fixture was deliberately changed.
    for (const loaded of selectCases(values.case)) {
      if (loaded.fixture.stage === "final") {
        throw new UsageError(`${loaded.fixture.id} is a frozen final fixture; it cannot be re-bound.`);
      }
      const oracle = {
        ...loaded.oracle,
        fixture: { sha256: loaded.fixtureSha256, version: loaded.fixture.fixtureVersion },
      };
      if (JSON.stringify(oracle.fixture) === JSON.stringify(loaded.oracle.fixture)) continue;
      writeFileSync(
        loaded.oraclePath,
        loaded.oracleText.replace(
          /"fixture":\s*\{[^}]*\}/,
          `"fixture": { "version": ${JSON.stringify(oracle.fixture.version)}, "sha256": ${JSON.stringify(oracle.fixture.sha256)} }`,
        ),
      );
      console.log(`${loaded.fixture.id}: oracle bound to fixture ${loaded.fixtureSha256}`);
    }
    return 0;
  }

  if (command === "report") {
    if (!values.run) throw new UsageError("report needs --run DIR (a case directory holding observation.json).");
    const directory = path.resolve(values.run);
    const observationText = readFileSync(path.join(directory, "observation.json"), "utf8");
    // The mode recorded in the file decides which criteria may be scored, so
    // the file is not believed on its own word.
    const problems = observationIntegrityProblems({
      seal: existsSync(path.join(directory, OBSERVATION_SEAL_FILE))
        ? readFileSync(path.join(directory, OBSERVATION_SEAL_FILE), "utf8")
        : null,
      text: observationText,
    });
    if (problems.length > 0) {
      console.error(`REFUSED: the stored run cannot be re-scored:\n- ${problems.join("\n- ")}`);
      return 3;
    }
    const observation = JSON.parse(observationText) as CaseObservation;
    const loaded = loadCase(observation.caseId);
    if (loaded.fixtureSha256 !== observation.identity.fixtureSha256) {
      throw new UsageError("The stored run used a different fixture than the one on disk; it cannot be re-scored against this oracle.");
    }
    const report = writeRun({
      digest: reproducibilityDigest(observation, loaded.fixture),
      loaded,
      observation,
      outDirectory: path.dirname(directory),
      review: readReview(values.review),
      runPlan: plan([loaded], observation.mode),
    });
    printCase(report);
    return exitCodeForStatus(report.status);
  }

  if (command === "latency") {
    const integer = (value: string | undefined, fallback: number, name: string): number => {
      if (value === undefined) return fallback;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new UsageError(`--${name} must be a non-negative integer.`);
      }
      return parsed;
    };
    const report = await runLatencyProfiles({
      providerDelayMs: integer(values["provider-delay-ms"], 0, "provider-delay-ms"),
      repeats: integer(values.repeats, 2, "repeats"),
      stallMs: integer(values["stall-ms"], 0, "stall-ms"),
      target: resolveIsolationTarget(process.env),
      ...(values["budget-ms"] === undefined
        ? {}
        : { requestBudgetMs: integer(values["budget-ms"], 0, "budget-ms") }),
    });
    const directory = values.out ? path.resolve(values.out) : defaultOutDirectory();
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "latency.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(path.join(directory, "latency.md"), renderLatencyMarkdown(report));
    console.log(renderLatencyMarkdown(report));
    console.log(`Wrote ${directory}`);
    return 0;
  }

  const ids =
    command === "run-case" || command === "chat"
      ? positionals[1]
        ? [positionals[1]]
        : (() => {
            throw new UsageError(`${command} needs a case id.`);
          })()
      : values.case;
  if (!["plan", "run-case", "suite", "chat"].includes(command)) {
    throw new UsageError(`Unknown command ${command}.\n\n${HELP}`);
  }
  const cases = selectCases(ids);
  requireValid(cases);
  const runPlan = plan(cases, values.mode);

  if (command === "plan" || values["dry-run"]) {
    printPlan(runPlan);
    return runPlan.status === "blocked" ? EXIT_BLOCKED : 0;
  }
  requireRunnable(runPlan);
  const outDirectory = values.out ? path.resolve(values.out) : defaultOutDirectory();

  if (command === "chat") return commandChat(cases[0]!, runPlan, outDirectory);

  if (command === "run-case") {
    const report = await runOne(cases[0]!, runPlan, {
      outDirectory,
      review: readReview(values.review),
      verifyReset: values["verify-reset"] === true,
    });
    printCase(report);
    console.log(`Wrote ${path.join(outDirectory, report.caseId)}`);
    return exitCodeForStatus(report.status);
  }

  const reports: CaseReport[] = [];
  for (const loaded of cases) {
    const report = await runOne(loaded, runPlan, { outDirectory, review: null, verifyReset: false });
    printCase(report);
    reports.push(report);
  }
  const status = suiteStatus(reports);
  const comparison = compareWithKnownRed(reports, loadKnownRed());
  mkdirSync(outDirectory, { recursive: true });
  writeFileSync(
    path.join(outDirectory, "suite.json"),
    `${JSON.stringify({ cases: reports.map((report) => ({ caseId: report.caseId, status: report.status })), knownRed: comparison, status }, null, 2)}\n`,
  );
  console.log(`\nSuite: ${status.toUpperCase()} — ${reports.filter((report) => report.status === "pass").length}/${reports.length} cases pass. Wrote ${outDirectory}`);
  for (const entry of comparison.unexpectedRed) {
    console.log(`UNEXPECTED RED   ${entry.caseId} ${entry.criterionId} — ${entry.reason}`);
  }
  for (const entry of comparison.unexpectedGreen) {
    console.log(`UNEXPECTED GREEN ${entry.caseId} ${entry.criterionId} — remove it from known-red.json (owner ${entry.owner})`);
  }
  if (values["expect-known-red"]) {
    // Staged development: red must be exactly the declared red. This is a
    // statement about the ledger, never an acceptance pass; exit 0 for a
    // suite that is not a complete pass needs --regression-only.
    const outcome = knownRedOutcome({
      comparison,
      regressionOnly: values["regression-only"] === true,
      status,
    });
    console.log(outcome.message);
    return outcome.code;
  }
  return exitCodeForStatus(status);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = EXIT_USAGE;
    } else if (error instanceof IsolationError) {
      console.error(`REFUSED: ${error.message}`);
      process.exitCode = 3;
    } else {
      console.error(error);
      process.exitCode = 3;
    }
  });
