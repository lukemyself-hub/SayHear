#!/usr/bin/env node
/**
 * Summarises one or more benchmark rounds as Markdown.
 *
 *   node summarize.mjs --round r1 [--round r2] [--write]
 *
 * Per layout x fixture (x correction x rules): calls, reasoning tokens and
 * completion time as median [min-max], cached input tokens, how many calls
 * reasoned about not finding the quoted messages, how many read a mark out,
 * and how many passed the coarse point checks. `--write` also saves
 * results/<round>/summary.md for a single round.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

import { CANNOT_SEE, MARK_LEAK } from "./patterns.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Checks and flags are recomputed from the current fixtures and patterns, so a
 * corrected regular expression applies to calls already recorded.
 */
const fixtureChecks = new Map();
function rescore(call) {
  if (!fixtureChecks.has(call.fixture)) {
    fixtureChecks.set(
      call.fixture,
      JSON.parse(readFileSync(path.join(here, "fixtures", `${call.fixture}.json`), "utf8")).checks,
    );
  }
  const checks = fixtureChecks.get(call.fixture);
  const run = (list) => Object.fromEntries(list.map((item) => [item.id, new RegExp(item.pattern, "i").test(call.text)]));
  const must = run(checks.must);
  const mustNot = run(checks.mustNot);
  return {
    ...call,
    checks: { must, mustNot, pass: Object.values(must).every(Boolean) && !Object.values(mustNot).some(Boolean) },
    flags: { ...call.flags, cannotSeeQuoted: CANNOT_SEE.test(call.reasoning), markLeak: MARK_LEAK.test(call.text) },
  };
}
const { values } = parseArgs({
  options: { round: { type: "string", multiple: true }, write: { type: "boolean", default: false } },
});
const rounds = values.round ?? [];
if (rounds.length === 0) throw new Error("--round NAME is required");


/** Recorded calls of a round; committed rounds are stored gzipped. */
function readCalls(round) {
  const plain = path.join(here, "results", round, "calls.jsonl");
  return existsSync(plain) ? readFileSync(plain, "utf8") : gunzipSync(readFileSync(`${plain}.gz`)).toString("utf8");
}

const calls = rounds.flatMap((round) =>
  readCalls(round)
    .split("\n")
    .filter(Boolean)
    .map((line) => rescore(JSON.parse(line))),
);

const median = (numbers) => {
  const sorted = numbers.filter((value) => value !== null && value !== undefined).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};
const range = (numbers, scale = 1, digits = 0) => {
  const known = numbers.filter((value) => value !== null && value !== undefined);
  if (known.length === 0) return "n/a";
  const show = (value) => (value / scale).toFixed(digits);
  return `${show(median(known))} [${show(Math.min(...known))}–${show(Math.max(...known))}]`;
};

function table(groupKeys, title) {
  const groups = new Map();
  for (const call of calls) {
    const key = groupKeys.map((name) => call[name]).join(" | ");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(call);
  }
  const lines = [
    `### ${title}`,
    "",
    `| ${groupKeys.join(" | ")} | calls | errors | reasoning tokens | done (s) | first text (s) | input | cached | "cannot find quoted" | mark read out | points pass |`,
    `| ${groupKeys.map(() => "---").join(" | ")} | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const [key, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const ok = group.filter((call) => call.error === null);
    lines.push(
      `| ${key} | ${group.length} | ${group.length - ok.length} | ${range(ok.map((call) => call.usage?.reasoningTokens))} | ${range(ok.map((call) => call.timings.endedMs), 1000, 1)} | ${range(ok.map((call) => call.timings.firstContentMs), 1000, 1)} | ${median(ok.map((call) => call.usage?.inputTokens)) ?? "n/a"} | ${median(ok.map((call) => call.usage?.cachedTokens)) ?? "n/a"} | ${ok.filter((call) => call.flags.cannotSeeQuoted).length} | ${ok.filter((call) => call.flags.markLeak).length} | ${ok.filter((call) => call.checks.pass).length}/${ok.length} |`,
    );
  }
  return lines.join("\n");
}

const cost = calls.reduce((sum, call) => sum + call.costUsdMicros, 0);
const output = [
  `## Presentation benchmark: ${rounds.join(", ")}`,
  "",
  `${calls.length} measured call(s); recorded cost $${(cost / 1e6).toFixed(4)} (conservative list price, warm-up calls included).`,
  "Reasoning tokens are the main measure. Wall-clock times were taken under the concurrency recorded with each call and are comparable only within one setting.",
  "",
  table(["layout", "correction", "rules"], "By layout (all fixtures)"),
  "",
  table(["fixture", "layout", "correction", "rules"], "By fixture and layout"),
  "",
].join("\n");
console.log(output);
if (values.write && rounds.length === 1) {
  writeFileSync(path.join(here, "results", rounds[0], "summary.md"), output);
}
