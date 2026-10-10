import { readFileSync } from "node:fs";
import path from "node:path";

import type { RunPlan } from "./budget";
import {
  aggregateStatus,
  type CaseReport,
  type CriterionStatus,
} from "./evaluate";
import { packRoot, sourceKeys, sourceText, type LoadedCase } from "./fixture";
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
    );
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
      `| \`${criterion.id}\` ${criterion.description} | ${criterion.kind} | **${STATUS_LABEL[criterion.status]}** | ${criterion.owner ?? "—"} | ${criterion.reason} |`,
    );
  }
  lines.push("");
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

export function suiteStatus(reports: readonly CaseReport[]): CriterionStatus {
  return aggregateStatus(reports.map((report) => report.status));
}
