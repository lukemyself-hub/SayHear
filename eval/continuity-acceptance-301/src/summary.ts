import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { CaseObservation } from "./observation";
import { COMMIT_LIMIT_MS, LATENCY_PASS_SHARE, type StepTiming } from "./transcript";

/**
 * One table over a set of stored real-model runs (T08 #321): every turn the
 * real Provider answered, with its own first-text and commit times, and every
 * criterion that did not pass. No averages: each sample stands on its own.
 */

type StoredReport = Readonly<{
  case: Readonly<{
    criteria: readonly Readonly<{ id: string; kind: string; reason: string; status: string }>[];
    status: string;
  }>;
}>;

export type RunSummary = Readonly<{
  cases: readonly Readonly<{
    caseId: string;
    notPassing: readonly Readonly<{ id: string; kind: string; status: string }>[];
    run: string;
    status: string;
    turnsNeverAnswered: readonly string[];
  }>[];
  timings: readonly (StepTiming & { run: string })[];
}>;

function caseDirectories(root: string): { directory: string; run: string }[] {
  const found: { directory: string; run: string }[] = [];
  const visit = (directory: string) => {
    if (existsSync(path.join(directory, "observation.json"))) {
      found.push({ directory, run: path.relative(root, path.dirname(directory)) || "." });
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(root);
  return found.sort((left, right) => left.directory.localeCompare(right.directory));
}

export function summarizeRuns(root: string): RunSummary {
  const cases: RunSummary["cases"][number][] = [];
  const timings: (StepTiming & { run: string })[] = [];
  for (const { directory, run } of caseDirectories(root)) {
    const observation = JSON.parse(
      readFileSync(path.join(directory, "observation.json"), "utf8"),
    ) as CaseObservation;
    const report = JSON.parse(readFileSync(path.join(directory, "report.json"), "utf8")) as StoredReport;
    const rows = JSON.parse(readFileSync(path.join(directory, "timings.json"), "utf8")) as StepTiming[];
    timings.push(...rows.map((row) => ({ ...row, run })));
    cases.push({
      caseId: observation.caseId,
      notPassing: report.case.criteria
        .filter((criterion) => criterion.status !== "pass")
        .map((criterion) => ({ id: criterion.id, kind: criterion.kind, status: criterion.status })),
      run,
      status: report.case.status,
      turnsNeverAnswered: observation.steps
        .filter(
          (step) =>
            step.type === "say" &&
            step.chat !== null &&
            !step.chat.clientAborted &&
            step.chat.terminalEvent !== "assistant_committed",
        )
        .map((step) => step.id),
    });
  }
  return { cases, timings };
}

function seconds(value: number | null): string {
  return value === null ? "—" : (value / 1000).toFixed(1);
}

export function renderSummaryMarkdown(summary: RunSummary): string {
  const lines = [
    "| run | case | turn | kind | app | outcome | first text s | committed s | committed ≤ 15 s | live requests | output tokens (reasoning) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of summary.timings) {
    lines.push(
      `| ${row.run} | ${row.caseId} | ${row.stepId} | ${row.kind} | ${row.appState} | ${row.outcome} | ${seconds(row.firstVisibleTextMs)} | ${seconds(row.committedMs)} | ${row.outcome === "client-aborted" ? "n/a" : row.withinContract ? "yes" : "NO"} | ${row.liveRequests} | ${row.outputTokens} (${row.reasoningTokens}) |`,
    );
  }
  const answered = summary.timings.filter((row) => row.outcome !== "client-aborted");
  const within = answered.filter((row) => row.withinContract).length;
  lines.push(
    "",
    `Turns sent to the real Provider (cancelled ones excluded): ${answered.length}. Committed within ${COMMIT_LIMIT_MS / 1000} s: ${within}${answered.length === 0 ? "" : ` (${((within / answered.length) * 100).toFixed(0)}%)`}. Outside or never committed: ${answered.length - within}. Latency gate (at least ${LATENCY_PASS_SHARE * 100}% within): ${answered.length === 0 ? "no samples" : within / answered.length >= LATENCY_PASS_SHARE ? "met" : "NOT met"}.`,
    "",
    "| run | case | status | turns with no committed reply | criteria not passing |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const entry of summary.cases) {
    lines.push(
      `| ${entry.run} | ${entry.caseId} | ${entry.status} | ${entry.turnsNeverAnswered.join(", ") || "—"} | ${entry.notPassing.map((criterion) => `${criterion.id} (${criterion.status})`).join(", ") || "—"} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
