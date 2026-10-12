#!/usr/bin/env node
/**
 * Per-turn table over stored real-model runs, for the presentation re-verification.
 *
 *   node collect.mjs <runs dir> [<runs dir> ...]
 *
 * For every follow-up turn: outcome, live requests, reasoning tokens of the
 * call that wrote the answer after a history review (when there was one),
 * reasoning tokens of the whole turn, first visible text and commit times,
 * whether it committed inside the 30 second budget, whether it met 3 s / 10 s
 * (recorded only), how many earlier messages the answer call quoted, whether
 * its reasoning said the quoted messages could not be found, and whether the
 * reply read a note, heading or number of the earlier-messages block out.
 * Reads `observation.json` or `observation.json.gz`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const CANNOT_SEE =
  /(not (actually )?(shown|visible|included|provided|present)|can(no|'|’)t see|cannot see|don'?t see|do not see|no quoted|aren'?t (shown|visible|in the)|not in the conversation|where are the|which (ones|messages) are (the )?quoted|don't have the (content|text)|看不到|没有显示|没看到)/i;
const MARK_LEAK =
  /\[Note\.|EARLIER MESSAGES|END OF EARLIER|they said \[|you replied:|\[\d+\] \d\d:\d\d|written before their correction|time zone assumed|材料块|方括号/i;

function observations(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) observations(full, out);
    else if (name === "observation.json" || name === "observation.json.gz") out.push(full);
  }
  return out;
}

for (const root of process.argv.slice(2)) {
  if (!existsSync(root)) throw new Error(`No such directory: ${root}`);
  console.log(`\n### ${root}\n`);
  console.log(
    "| case | turn | outcome | requests | answer-call reasoning | turn reasoning | first text s | committed s | ≤30 s | 3 s / 10 s | quoted | \"cannot find quoted\" | note read out |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const file of observations(root).sort()) {
    const bytes = readFileSync(file);
    const observation = JSON.parse(file.endsWith(".gz") ? gunzipSync(bytes) : bytes);
    for (const step of observation.steps) {
      if (!step.chat) continue;
      const requests = step.providerRequests ?? [];
      const answer = requests.length > 1 && requests.at(-1).toolsOffered.length === 0 ? requests.at(-1) : null;
      const usage = (request) => request?.response?.usage ?? {};
      const timing = step.chat.timing ?? {};
      const committed = step.chat.terminalEvent === "assistant_committed";
      const seconds = (ms) => (ms === null || ms === undefined ? "—" : (ms / 1000).toFixed(1));
      const quoted = answer
        ? Number(/END OF EARLIER MESSAGES \((\d+) in total\)/.exec(answer.instructions ?? "")?.[1] ?? 0)
        : "—";
      console.log(
        `| ${observation.caseId} | ${step.id} | ${step.chat.clientAborted ? "client-aborted" : step.chat.terminalEvent ?? "none"} | ${requests.length} | ${answer ? usage(answer).reasoningTokens ?? "unknown" : "—"} | ${requests.reduce((sum, request) => sum + (usage(request).reasoningTokens ?? 0), 0)} | ${seconds(timing.firstVisibleTextMs)} | ${seconds(committed ? timing.committedMs : null)} | ${committed && timing.committedMs <= 30_000 ? "yes" : "NO"} | ${committed && timing.firstVisibleTextMs <= 3000 && timing.committedMs <= 10_000 ? "yes" : "no"} | ${quoted} | ${answer ? (CANNOT_SEE.test(answer.response?.reasoning ?? "") ? "match" : "no") : "—"} | ${MARK_LEAK.test(step.chat.streamedText ?? "") ? "YES" : "no"} |`,
      );
    }
  }
}
