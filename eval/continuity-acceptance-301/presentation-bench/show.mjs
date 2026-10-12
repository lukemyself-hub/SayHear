#!/usr/bin/env node
/**
 * Prints the replies (and, with --reasoning, where the reasoning hesitated) of
 * the calls matching a filter, for reading by a person.
 *
 *   node show.mjs --round r1 --fixture H12-work [--layout V2] [--failed] [--cannot-see] [--reasoning N]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

import { CANNOT_SEE, CANNOT_SEE_SOURCE, MARK_LEAK } from "./patterns.mjs";

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
  options: {
    "cannot-see": { type: "boolean", default: false },
    failed: { type: "boolean", default: false },
    fixture: { type: "string" },
    layout: { type: "string" },
    reasoning: { type: "string" },
    round: { type: "string" },
  },
});

/** Recorded calls of a round; committed rounds are stored gzipped. */
function readCalls(round) {
  const plain = path.join(here, "results", round, "calls.jsonl");
  return existsSync(plain) ? readFileSync(plain, "utf8") : gunzipSync(readFileSync(`${plain}.gz`)).toString("utf8");
}

const calls = readCalls(values.round)
  .split("\n")
  .filter(Boolean)
  .map((line) => rescore(JSON.parse(line)))
  .filter((call) => !values.fixture || values.fixture.split(",").includes(call.fixture))
  .filter((call) => !values.layout || values.layout.split(",").includes(call.layout))
  .filter((call) => !values.failed || !call.checks.pass)
  .filter((call) => !values["cannot-see"] || call.flags.cannotSeeQuoted)
  .sort((left, right) => `${left.fixture}${left.layout}${left.correction}${left.repeat}`.localeCompare(`${right.fixture}${right.layout}${right.correction}${right.repeat}`));
for (const call of calls) {
  const failedChecks = [
    ...Object.entries(call.checks.must).filter(([, ok]) => !ok).map(([id]) => `missing:${id}`),
    ...Object.entries(call.checks.mustNot).filter(([, hit]) => hit).map(([id]) => `hit:${id}`),
  ];
  console.log(
    `\n## ${call.fixture} ${call.layout}/${call.correction}/${call.rules} #${call.repeat} reasoning=${call.usage?.reasoningTokens} done=${call.timings.endedMs}ms ${failedChecks.join(" ")}`,
  );
  console.log(call.text.replace(/\n+/g, " ⏎ "));
  if (values["cannot-see"]) {
    const match = new RegExp(`.{0,260}(?:${CANNOT_SEE_SOURCE}).{0,260}`, "is").exec(call.reasoning);
    console.log(`   REASONING AROUND THE MATCH: ${(match?.[0] ?? "").replace(/\n+/g, " ")}`);
  }
  if (values.reasoning) console.log(`   REASONING (first ${values.reasoning}): ${call.reasoning.slice(0, Number(values.reasoning)).replace(/\n+/g, " ")}`);
}
console.log(`\n${calls.length} call(s).`);
