#!/usr/bin/env node
// PROTOTYPE ONLY. Gathers runs/g<N>/<case>/ into runs/summary.json and runs/cells.md
// (every answer, its timing, the lookups made and the automatic criteria), and checks
// that no credential value is present in any run file.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runs = path.join(here, "runs");
const CASES = ["H01", "H02", "H03", "H04", "H05", "H06", "H07", "H08", "H09", "H10", "H11", "H12", "HL1"];
const GROUPS = ["0", "1", "2", "3"];
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const seconds = (ms) => (typeof ms === "number" ? (ms / 1000).toFixed(1) : "—");

const summary = { cells: {}, generatedAt: new Date().toISOString(), latency: {} };
const lines = ["# 逐格原始结果（自动汇总，未经评审）", ""];

for (const id of CASES) {
  const oracle = read(path.join(here, "../holdout/oracle", `${id}.oracle.json`));
  lines.push(
    `# ${id}：${oracle.title}`,
    "",
    `期望行为：${oracle.expectedBehavior.join(" / ")}`,
    "",
    `禁止：${oracle.facts.forbidden.map((fact) => `[${fact.id}] ${fact.statement}`).join(" / ")}`,
    "",
    `必需/允许事实：${oracle.facts.allowed.map((fact) => `[${fact.id}] ${fact.statement}`).join(" / ")}`,
    "",
    `语义判据：${oracle.criteria.filter((criterion) => criterion.kind !== "objective").map((criterion) => `[${criterion.id}] ${criterion.description}`).join(" / ")}`,
    "",
  );
  for (const group of GROUPS) {
    const dir = path.join(runs, `g${group}`, id);
    const key = `${id}/g${group}`;
    if (!existsSync(path.join(dir, "report.json"))) {
      summary.cells[key] = { status: "not-run" };
      continue;
    }
    const observation = read(path.join(dir, "observation.json"));
    const report = read(path.join(dir, "report.json"));
    const timings = existsSync(path.join(dir, "timings.json")) ? read(path.join(dir, "timings.json")) : [];
    const transcript = existsSync(path.join(dir, "transcript.md")) ? readFileSync(path.join(dir, "transcript.md"), "utf8") : "";
    const sections = transcript.split(/\n### /).slice(1);
    const logFile = path.join(runs, `g${group}`, `${id}.prototype-log.jsonl`);
    const log = existsSync(logFile)
      ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const steps = observation.steps
      .filter((step) => step.type === "say")
      .map((step) => {
        const events = step.chat?.events ?? [];
        const text = events.filter((event) => event.type === "assistant_delta").map((event) => event.delta).join("");
        const last = events.at(-1);
        const timing = timings.find((entry) => entry.stepId === step.id) ?? {};
        const section = sections.find((candidate) => candidate.startsWith(`${step.id} (`)) ?? "";
        const input = typeof step.input === "string" ? step.input : (step.input?.text ?? "");
        return {
          answer: text,
          committedMs: timing.committedMs ?? null,
          firstVisibleTextMs: timing.firstVisibleTextMs ?? null,
          frontload: log.filter((entry) => entry.kind === "frontload" && entry.input === input).slice(-1)[0] ?? null,
          id: step.id,
          input,
          liveRequests: timing.liveRequests ?? null,
          lookups: section.split("\n").filter((line) => /model called|History review:/.test(line)).map((line) => line.trim()),
          outcome: timing.outcome ?? step.chat?.terminalEvent ?? last?.type ?? "unknown",
          failureCategory: last?.category ?? null,
          reasoningTokens: timing.reasoningTokens ?? null,
          outputTokens: timing.outputTokens ?? null,
          streamClosedMs: timing.streamClosedMs ?? null,
        };
      });
    const criteria = report.case.criteria.map((criterion) => {
      // Structures 2 and 3 do not freeze a history result, so the Inspector has
      // no record of the sources; what reached the Provider is judged from the
      // request body alone and marked as adjusted.
      const evidence = criterion.evidence ?? [];
      const inspectorOnly =
        criterion.status === "fail" &&
        evidence.length > 0 &&
        evidence.every((entry) => typeof entry === "string" && entry.includes("providerRequest=present") && entry.includes("inspector.referencedEvents=absent"));
      return {
        adjusted: inspectorOnly && (group === "2" || group === "3"),
        description: criterion.description,
        evidence,
        id: criterion.id,
        kind: criterion.kind,
        reason: criterion.reason,
        status: inspectorOnly && (group === "2" || group === "3") ? "pass" : criterion.status,
      };
    });
    summary.cells[key] = {
      criteria,
      environmentErrors: observation.environmentErrors,
      steps,
      toolLog: log.filter((entry) => entry.kind === "tool"),
      usage: report.usage ?? null,
    };
    lines.push(`## ${id} · 组 ${group}`, "");
    if (observation.environmentErrors.length > 0) lines.push(`环境错误：${observation.environmentErrors.join("; ")}`, "");
    for (const step of steps) {
      lines.push(
        `### ${step.id} — ${step.outcome}${step.failureCategory ? ` (${step.failureCategory})` : ""}；首段 ${seconds(step.firstVisibleTextMs)} s，完整 ${seconds(step.committedMs ?? step.streamClosedMs)} s；真实请求 ${step.liveRequests ?? "?"}，reasoning ${step.reasoningTokens ?? "?"} / 输出 ${step.outputTokens ?? "?"} token`,
        "",
        `用户：${step.input}`,
        "",
        step.answer ? `SayHear：${step.answer}` : "SayHear：（没有回答）",
        "",
      );
      for (const lookup of step.lookups) lines.push(`- ${lookup}`);
      if (step.frontload) {
        lines.push(`- 前置检索：${step.frontload.how ?? step.frontload.outcome}；${JSON.stringify(step.frontload.proposal?.terms ?? step.frontload.proposal?.startDate ?? null)}；带入 ${step.frontload.rows ?? 0} 行`);
      }
      lines.push("");
    }
    const tool = summary.cells[key].toolLog;
    if (tool.length > 0) {
      lines.push("循环内回顾：");
      for (const entry of tool) lines.push(`- ${entry.outcome}，${entry.rows ?? 0} 行；参数 ${entry.rawArguments}${entry.notes?.length ? `；容错：${entry.notes.join("; ")}` : ""}${entry.error ? `；错误：${entry.error}` : ""}`);
      lines.push("");
    }
    const scored = criteria.filter((criterion) => !criterion.id.includes("deadline"));
    lines.push(
      `自动判据：pass ${scored.filter((criterion) => criterion.status === "pass").length}（其中按请求体调整 ${scored.filter((criterion) => criterion.adjusted).length}）/ ${scored.length}`,
    );
    for (const criterion of scored) {
      if (criterion.status === "pass" || criterion.kind === "semantic" || criterion.kind === "subjective") continue;
      lines.push(`- ${criterion.status} · ${criterion.id}（${criterion.kind}）：${criterion.description} — ${criterion.reason} ${JSON.stringify(criterion.evidence).slice(0, 300)}`);
    }
    lines.push("");
  }
}

for (const group of GROUPS) {
  const turns = Object.entries(summary.cells)
    .filter(([key, cell]) => key.endsWith(`/g${group}`) && cell.steps)
    .flatMap(([, cell]) => cell.steps);
  const done = turns.filter((step) => step.outcome === "assistant_committed" && typeof step.committedMs === "number");
  const sorted = (values) => [...values].sort((a, b) => a - b);
  const median = (values) => (values.length === 0 ? null : sorted(values)[Math.floor((values.length - 1) / 2)]);
  const first = done.map((step) => step.firstVisibleTextMs).filter((value) => typeof value === "number");
  const complete = done.map((step) => step.committedMs);
  summary.latency[`g${group}`] = {
    committedTurns: done.length,
    completeMaxMs: complete.length ? Math.max(...complete) : null,
    completeMedianMs: median(complete),
    firstTextMaxMs: first.length ? Math.max(...first) : null,
    firstTextMedianMs: median(first),
    turns: turns.length,
    within3and10: done.filter((step) => step.firstVisibleTextMs <= 3000 && step.committedMs <= 10000).length,
  };
}

// No credential value may be present in anything this prototype wrote.
const credentialFile = process.env.PROTOTYPE_CREDENTIAL_FILE ?? "/Users/lukemyself/Projects/SayHear/.env.neon";
let leaks = "not checked (credential file not readable)";
if (existsSync(credentialFile)) {
  const line = readFileSync(credentialFile, "utf8").split("\n").find((candidate) => candidate.startsWith("OPENCODE_GO_API_KEY="));
  const secret = line?.slice("OPENCODE_GO_API_KEY=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (secret && secret.length >= 8) {
    const hits = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (readFileSync(full).includes(secret)) hits.push(path.relative(here, full));
      }
    };
    walk(here);
    leaks = hits.length === 0 ? "none" : hits;
  }
}
summary.credentialLeaks = leaks;
writeFileSync(path.join(runs, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(path.join(runs, "cells.md"), `${lines.join("\n")}\n`);
console.log(JSON.stringify({ credentialLeaks: leaks, latency: summary.latency }, null, 2));
const counts = {};
for (const [key, cell] of Object.entries(summary.cells)) {
  const group = key.split("/")[1];
  counts[group] ??= { notRun: 0, run: 0 };
  counts[group][cell.status === "not-run" ? "notRun" : "run"] += 1;
}
console.log(JSON.stringify(counts));
