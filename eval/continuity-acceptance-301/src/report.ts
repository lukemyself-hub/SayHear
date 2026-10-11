import { readFileSync } from "node:fs";
import path from "node:path";

import type { RunPlan } from "./budget";
import {
  exitCodeForStatus,
  aggregateStatus,
  type CaseReport,
  type CriterionStatus,
} from "./evaluate";
import { packRoot, sourceKeys, sourceText, type LoadedCase } from "./fixture";
import {
  diagnoseStep,
  type DiagnosticEvidence,
  type StepDiagnosis,
} from "./diagnose";
import type { CaseObservation, ObservedStep } from "./observation";

/**
 * Machine-readable run report plus a short Markdown rendering (T00 #313).
 * Every conclusion carries pointers into the transcript and the oracle, so a
 * reader can check a verdict without re-running anything.
 */

export const REPORT_SCHEMA_VERSION = "continuity-acceptance-report:v1";
export const KNOWN_RED_SCHEMA_VERSION = "continuity-known-red:v1";

export type KnownRedEntry = Readonly<{
  caseId: string;
  criterionId: string;
  /** Ticket expected to turn it green. */
  owner: string;
  reason: string;
}>;

export type KnownRedLedger = Readonly<{
  entries: readonly KnownRedEntry[];
  schemaVersion: typeof KNOWN_RED_SCHEMA_VERSION;
}>;

export const knownRedPath = path.join(packRoot, "known-red.json");

export function loadKnownRed(file: string = knownRedPath): KnownRedLedger {
  return JSON.parse(readFileSync(file, "utf8")) as KnownRedLedger;
}

export type SourceManifestRow = Readonly<{
  eligibility: "allowed" | "forbidden" | "unspecified";
  inInspector: boolean;
  inProviderRequest: boolean;
  source: string;
}>;

export type StepTiming = Readonly<{
  /** `cold` right after an app (re)start; `warm` otherwise. */
  appState: "cold" | "warm";
  cliAcceptedMs: number | null;
  cliCommittedMs: number | null;
  cliFirstVisibleTextMs: number | null;
  cliStreamClosedMs: number | null;
  providerLatencyMs: number | null;
  stepId: string;
}>;

export type RunReport = Readonly<{
  budget: RunPlan;
  case: CaseReport;
  /**
   * Where a required source was lost, per step (T07 #320): decided from the
   * authoritative history, the Inspector and the Provider request that left,
   * and only a semantic verdict can yield a generation error.
   */
  diagnosis: readonly Readonly<{ diagnosis: StepDiagnosis; stepId: string }>[];
  identity: CaseObservation["identity"] &
    Readonly<{ oracleSha256: string; title: string }>;
  remainingRisks: readonly string[];
  reproducibilityDigest: string;
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  sourceManifest: readonly Readonly<{ rows: readonly SourceManifestRow[]; stepId: string }>[];
  timings: readonly StepTiming[];
  transcript: readonly Readonly<{
    at: string;
    assistant: string | null;
    stepId: string;
    terminalEvent: string | null;
    type: string;
    user: string | null;
  }>[];
  usage: Readonly<{
    inputTokens: number | null;
    outputTokens: number | null;
    paidCostUsdMicros: number | null;
    providerRequests: number;
  }>;
}>;

function manifestFor(
  loaded: LoadedCase,
  observation: CaseObservation,
  step: ObservedStep,
): SourceManifestRow[] {
  const strings = step.providerRequests.flatMap((request) => request.strings);
  const references = new Set(
    (step.inspection?.referencedEvents ?? []).map((event) => event.revisionId),
  );
  return sourceKeys(loaded.fixture).map((source) => {
    const [key, actor] = source.split(":");
    const turn = observation.seed.turns.find((candidate) => candidate.key === key);
    const revisionId = actor === "user" ? turn?.userRevisionId : turn?.assistantRevisionId;
    const text = sourceText(loaded.fixture, source) ?? "";
    return {
      eligibility:
        loaded.oracle.sourceEligibility.find((entry) => entry.source === source)
          ?.eligibility ?? "unspecified",
      inInspector: revisionId ? references.has(revisionId) : false,
      inProviderRequest: strings.some((value) => value.includes(text)),
      source,
    };
  });
}

function localDateIn(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** One diagnosis per step whose criteria require seeded sources to arrive. */
function diagnoseSteps(
  loaded: LoadedCase,
  observation: CaseObservation,
  caseReport: CaseReport,
): RunReport["diagnosis"] {
  const result: Array<{ diagnosis: StepDiagnosis; stepId: string }> = [];
  const authoritativeTexts = observation.finalHistory.flatMap((session) =>
    session.messages.map((message) => message.text),
  );
  for (const step of observation.steps) {
    if (step.chat === null) continue;
    const required = loaded.oracle.criteria.flatMap((criterion) => {
      const check = (criterion as { check?: { sources?: readonly string[]; step?: string; type?: string } }).check;
      return check?.type === "outbound_includes" && check.step === step.id ? (check.sources ?? []) : [];
    });
    if (required.length === 0) continue;
    const verdicts = loaded.oracle.criteria
      .filter((criterion) => criterion.kind === "semantic" && (criterion as { step?: string }).step === step.id)
      .map((criterion) => caseReport.criteria.find((entry) => entry.id === criterion.id)?.status);
    const semanticVerdict: DiagnosticEvidence["semanticVerdict"] = verdicts.includes("fail")
      ? "fail"
      : verdicts.length > 0 && verdicts.every((status) => status === "pass")
        ? "pass"
        : null;
    const recall = step.inspection?.historyRecall ?? null;
    const evidence: DiagnosticEvidence = {
      authoritativeTexts,
      recall: recall
        ? {
            answerCommandId: recall.answerCommandId,
            enumerationComplete: recall.enumerationComplete,
            failureCode: recall.failureCode,
            omitted: recall.omitted,
            role: recall.role,
            searchOutcome: recall.searchOutcome,
            sourceRevisionIds: recall.sourceRevisionIds,
            status: recall.status,
          }
        : null,
      requests: step.providerRequests
        .filter((request) => request.conversationTurn && request.messages !== undefined)
        .map((request) => ({
          instructions: request.instructions ?? "",
          messages: request.messages ?? [],
          providerResponseId: request.providerResponseId ?? "",
          sequence: request.sequence,
          toolsOffered: request.toolsOffered ?? [],
        })),
      semanticVerdict,
      sources: required.map((source) => {
        const [key, actor] = source.split(":");
        const seeded = observation.seed.turns.find((candidate) => candidate.key === key);
        const turn = loaded.fixture.history.find((candidate) => candidate.key === key);
        return {
          expectedLocalDate: turn
            ? localDateIn(turn.at, turn.timezone ?? loaded.fixture.defaults.timezone)
            : null,
          revisionId: (actor === "user" ? seeded?.userRevisionId : seeded?.assistantRevisionId) ?? null,
          source,
          text: sourceText(loaded.fixture, source) ?? "",
        };
      }),
      turn: step.inspection?.turn ?? null,
    };
    result.push({ diagnosis: diagnoseStep(evidence), stepId: step.id });
  }
  return result;
}

export function buildRunReport(input: {
  caseReport: CaseReport;
  loaded: LoadedCase;
  observation: CaseObservation;
  plan: RunPlan;
  reproducibilityDigest: string;
}): RunReport {
  const { caseReport, loaded, observation, plan } = input;
  const chatSteps = observation.steps.filter((step) => step.chat !== null);
  const sum = (pick: (step: ObservedStep) => number | null) => {
    const values = chatSteps.map(pick);
    return values.some((value) => value === null)
      ? null
      : values.reduce<number>((total, value) => total + (value ?? 0), 0);
  };
  const remainingRisks: string[] = [];
  if (observation.mode === "deterministic") {
    remainingRisks.push(
      "Deterministic mode: replies are a fixed stub sentence. Nothing here is evidence about what a real model would say.",
      "Deterministic mode: the Decision itself (whether to look history up, the search clues, the people and the continuation basis) comes from the fixture script, not from a model. A passing objective criterion proves the pipeline and source control for that Decision; it does not prove that a model would choose it.",
    );
    if (caseReport.pipelineOnly.length > 0) {
      remainingRisks.push(
        `Pipeline-only: ${caseReport.pipelineOnly.map((id) => `\`${id}\``).join(", ")} were judged on a step whose scripted Decision used hindsight clues (not literally in the current message or the person's previous seven days of messages). Their verdicts are not evidence of selection quality, and the case is not shown as a complete pass.`,
      );
    }
  }
  if (loaded.fixture.stage !== "final") {
    remainingRisks.push(
      "This is a development fixture. Final validation needs separately authored fixtures frozen before tuning.",
    );
  }
  if (observation.identity.gitDirty) {
    remainingRisks.push("The working tree had uncommitted changes; the commit alone does not identify the code that ran.");
  }
  remainingRisks.push(
    "Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).",
  );

  let previousWasRestart = observation.seed.turns.length === 0;
  const timings: StepTiming[] = [];
  for (const step of observation.steps) {
    if (step.type === "restart") {
      previousWasRestart = true;
      continue;
    }
    timings.push({
      appState: previousWasRestart ? "cold" : "warm",
      cliAcceptedMs: step.chat?.timing.acceptedMs ?? null,
      cliCommittedMs: step.chat?.timing.committedMs ?? null,
      cliFirstVisibleTextMs: step.chat?.timing.firstVisibleTextMs ?? null,
      cliStreamClosedMs: step.chat?.timing.streamClosedMs ?? null,
      providerLatencyMs: step.inspection?.providerLatencyMs ?? null,
      stepId: step.id,
    });
    previousWasRestart = false;
  }

  return {
    budget: plan,
    case: caseReport,
    diagnosis: diagnoseSteps(loaded, observation, caseReport),
    identity: {
      ...observation.identity,
      oracleSha256: loaded.oracleSha256,
      title: loaded.oracle.title,
    },
    remainingRisks,
    reproducibilityDigest: input.reproducibilityDigest,
    schemaVersion: REPORT_SCHEMA_VERSION,
    sourceManifest: observation.steps
      .filter((step) => step.type === "say")
      .map((step) => ({ rows: manifestFor(loaded, observation, step), stepId: step.id })),
    timings,
    transcript: observation.steps.map((step) => ({
      assistant: step.chat?.streamedText ?? null,
      at: step.at,
      stepId: step.id,
      terminalEvent: step.chat?.terminalEvent ?? null,
      type: step.type,
      user: step.input?.text ?? null,
    })),
    usage: {
      inputTokens: sum((step) => step.inspection?.inputTokens ?? null),
      outputTokens: sum((step) => step.inspection?.outputTokens ?? null),
      paidCostUsdMicros: observation.mode === "deterministic" ? 0 : null,
      providerRequests: observation.steps.reduce(
        (total, step) => total + step.providerRequests.length,
        0,
      ),
    },
  };
}

const STATUS_LABEL: Record<CriterionStatus, string> = {
  "environment-error": "ENVIRONMENT-ERROR",
  fail: "FAIL",
  "needs-review": "NEEDS-REVIEW",
  "not-run": "NOT-RUN",
  pass: "PASS",
};

function ms(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

export function renderMarkdown(report: RunReport): string {
  const lines: string[] = [];
  const { case: result, identity } = report;
  lines.push(`# ${identity.title} — ${result.caseId}: ${STATUS_LABEL[result.status]}`);
  lines.push("");
  if (result.status !== "pass") {
    lines.push(
      "> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.",
    );
    lines.push("");
  }
  lines.push("## Identity");
  lines.push("");
  lines.push(`- Run: \`${identity.runId}\` · mode \`${result.mode}\` · model \`${identity.model}\``);
  lines.push(`- Commit: \`${identity.gitCommit}\`${identity.gitDirty ? " (working tree dirty)" : ""}`);
  lines.push(`- Fixture: version \`${identity.fixtureVersion}\`, sha256 \`${identity.fixtureSha256}\``);
  lines.push(`- Oracle: sha256 \`${identity.oracleSha256}\``);
  lines.push(`- Recent-context governance: \`${identity.recentContextGovernance}\``);
  lines.push(`- Reproducibility digest: \`${report.reproducibilityDigest}\``);
  lines.push(`- Reviewer: ${result.reviewer ? `\`${result.reviewer}\`` : "none"}`);
  lines.push("");
  lines.push("## Criteria");
  lines.push("");
  lines.push("| Criterion | Kind | Status | Owner | Reason |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const criterion of result.criteria) {
    lines.push(
      `| \`${criterion.id}\` ${criterion.description} | ${criterion.kind} | **${STATUS_LABEL[criterion.status]}${criterion.scope === "pipeline-only" ? " (pipeline-only)" : ""}** | ${criterion.owner ?? "—"} | ${criterion.reason} |`,
    );
  }
  lines.push("");
  const pipelineOnly = result.criteria.filter((criterion) => criterion.scope === "pipeline-only");
  if (pipelineOnly.length > 0) {
    lines.push("## Pipeline-only criteria (scripted Decision used hindsight clues)");
    lines.push("");
    lines.push(
      "These verdicts hold for the pipeline and source control given the scripted Decision. They are not evidence that a model would have chosen those clues.",
    );
    lines.push("");
    for (const criterion of pipelineOnly) {
      for (const item of criterion.evidence.filter((entry) => entry.startsWith("pipeline-only:"))) {
        lines.push(`- \`${criterion.id}\` — ${item}`);
      }
    }
    lines.push("");
  }
  const explained = result.criteria.filter(
    (criterion) => criterion.status !== "pass" && criterion.evidence.length > 0,
  );
  if (explained.length > 0) {
    lines.push("## Evidence for every non-passing criterion");
    lines.push("");
    for (const criterion of explained) {
      lines.push(`### \`${criterion.id}\` — ${STATUS_LABEL[criterion.status]}`);
      lines.push("");
      for (const item of criterion.evidence) lines.push(`- ${item}`);
      lines.push("");
    }
  }
  if (report.diagnosis.length > 0) {
    lines.push("## Diagnosis (where a required source was lost)");
    lines.push("");
    for (const { diagnosis, stepId } of report.diagnosis) {
      lines.push(
        `- \`${stepId}\`: read state \`${diagnosis.readState}\`, payload told the model \`${diagnosis.payloadReadStatus ?? "nothing"}\``,
      );
      for (const item of diagnosis.disagreements) lines.push(`  - DISAGREEMENT: ${item}`);
      for (const source of diagnosis.sources) {
        lines.push(
          `  - \`${source.source}\` → **${source.fault}**` +
            (source.trace
              ? ` (Provider call \`${source.trace.providerResponseId}\`, request #${source.trace.requestSequence}, ${source.trace.commandStage ?? "unknown stage"})`
              : ""),
        );
        for (const note of source.evidence) lines.push(`    - ${note}`);
      }
    }
    lines.push("");
  }
  lines.push("## Transcript");
  lines.push("");
  for (const turn of report.transcript) {
    if (turn.type === "restart") {
      lines.push(`- \`${turn.stepId}\` @ ${turn.at} — app restarted`);
      continue;
    }
    lines.push(`- \`${turn.stepId}\` (${turn.type}) @ ${turn.at} — ended \`${turn.terminalEvent ?? "no terminal event"}\``);
    lines.push(`  - user: ${JSON.stringify(turn.user)}`);
    lines.push(`  - assistant: ${JSON.stringify(turn.assistant)}`);
  }
  lines.push("");
  lines.push("## Source manifest (what reached the Provider)");
  lines.push("");
  for (const step of report.sourceManifest) {
    const reached = step.rows.filter((row) => row.inProviderRequest || row.inInspector);
    lines.push(
      `- \`${step.stepId}\`: ${reached.length} of ${step.rows.length} seeded sources reached the request` +
        (reached.length > 0 ? ` — ${reached.map((row) => `\`${row.source}\``).join(", ")}` : ""),
    );
    const blocked = step.rows.filter(
      (row) => row.eligibility === "allowed" && !(row.inProviderRequest && row.inInspector),
    );
    if (blocked.length > 0) {
      lines.push(`  - allowed but absent: ${blocked.map((row) => `\`${row.source}\``).join(", ")}`);
    }
    const leaked = step.rows.filter(
      (row) => row.eligibility === "forbidden" && (row.inProviderRequest || row.inInspector),
    );
    if (leaked.length > 0) {
      lines.push(`  - forbidden but present: ${leaked.map((row) => `\`${row.source}\``).join(", ")}`);
    }
  }
  lines.push("");
  lines.push("## Timing (CLI network; not browser rendering)");
  lines.push("");
  lines.push("| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const timing of report.timings) {
    lines.push(
      `| \`${timing.stepId}\` | ${timing.appState} | ${ms(timing.cliAcceptedMs)} | ${ms(timing.cliFirstVisibleTextMs)} | ${ms(timing.cliCommittedMs)} | ${ms(timing.cliStreamClosedMs)} | ${ms(timing.providerLatencyMs)} |`,
    );
  }
  lines.push("");
  lines.push(
    "First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.",
  );
  lines.push("");
  lines.push("## Usage and budget");
  lines.push("");
  lines.push(`- Provider requests in follow-up steps: ${report.usage.providerRequests}`);
  lines.push(`- Tokens recorded: input ${report.usage.inputTokens ?? "unknown"}, output ${report.usage.outputTokens ?? "unknown"}`);
  lines.push(`- Paid cost this run: ${report.usage.paidCostUsdMicros === null ? "unknown" : `${report.usage.paidCostUsdMicros} USD micros`}`);
  lines.push(`- Budget: cap ${report.budget.capUsdMicros} USD micros, remaining ${report.budget.remainingUsdMicros}, ledger entries of unknown cost ${report.budget.unknownCostEntries}`);
  lines.push("");
  lines.push("## Remaining risks");
  lines.push("");
  for (const risk of report.remainingRisks) lines.push(`- ${risk}`);
  lines.push("");
  return lines.join("\n");
}

export type KnownRedComparison = Readonly<{
  /** Listed as known red, but it did not fail: the ledger is stale. */
  unexpectedGreen: readonly KnownRedEntry[];
  /** Failed, but nobody declared it: a regression or an undeclared gap. */
  unexpectedRed: readonly Readonly<{ caseId: string; criterionId: string; reason: string }>[];
}>;

/**
 * Staged development keeps CI green without hiding red: the suite passes this
 * comparison only when the failing criteria are exactly the declared ones.
 * A fix that turns a declared red green also fails it, until the entry is
 * removed in the same change.
 */
export function compareWithKnownRed(
  reports: readonly CaseReport[],
  ledger: KnownRedLedger,
): KnownRedComparison {
  const ran = new Set(reports.map((report) => report.caseId));
  const failed = reports.flatMap((report) =>
    report.criteria
      .filter((criterion) => criterion.status === "fail")
      .map((criterion) => ({ caseId: report.caseId, criterionId: criterion.id, reason: criterion.reason })),
  );
  const declared = (caseId: string, criterionId: string) =>
    ledger.entries.some((entry) => entry.caseId === caseId && entry.criterionId === criterionId);
  return {
    unexpectedGreen: ledger.entries.filter(
      (entry) =>
        ran.has(entry.caseId) &&
        !failed.some((failure) => failure.caseId === entry.caseId && failure.criterionId === entry.criterionId),
    ),
    unexpectedRed: failed.filter((failure) => !declared(failure.caseId, failure.criterionId)),
  };
}

/**
 * What `suite --expect-known-red` exits with (review fix T). The comparison
 * says only that the failures are the declared ones; with semantic criteria
 * not run it says nothing about acceptance. Exit 0 for an incomplete or red
 * suite therefore has to be asked for by name (`--regression-only`); without
 * it the exit code is the suite's own status.
 */
export function knownRedOutcome(input: {
  comparison: KnownRedComparison;
  regressionOnly: boolean;
  status: CriterionStatus;
}): Readonly<{ code: number; message: string }> {
  if (input.status === "environment-error") {
    return { code: 3, message: "The run hit a harness or environment error; the ledger was not compared." };
  }
  const holds =
    input.comparison.unexpectedRed.length === 0 &&
    input.comparison.unexpectedGreen.length === 0;
  if (!holds) return { code: 1, message: "Known-red ledger does not match this run." };
  if (input.status === "pass") {
    return { code: 0, message: "Known-red ledger holds and every criterion passed." };
  }
  if (input.regressionOnly) {
    return {
      code: 0,
      message:
        "Known-red ledger holds: failures are exactly the declared ones (regression check only). This is NOT an acceptance pass: criteria that were not run or await review are not covered.",
    };
  }
  return {
    code: exitCodeForStatus(input.status),
    message: `Known-red ledger holds, but the suite is ${input.status}: this is not an acceptance pass. Pass --regression-only to use the ledger comparison alone as the exit status.`,
  };
}

export function suiteStatus(reports: readonly CaseReport[]): CriterionStatus {
  return aggregateStatus(reports.map((report) => report.status));
}
