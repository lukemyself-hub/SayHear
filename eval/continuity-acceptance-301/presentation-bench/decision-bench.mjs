#!/usr/bin/env node
/**
 * Decision-call benchmark: what a wording of the history-review function
 * description costs. Like the rest of this directory it calls the Provider
 * DIRECTLY and bypasses SayHear's conversation path: design evidence only,
 * never acceptance evidence.
 *
 * The fixtures are Decision requests the product really sent (taken from the
 * real-path observations under ../evidence-321-presentation/runs). Only the
 * description of `review_conversation_history` changes between variants;
 * instructions, messages, the other functions and the model are identical.
 *
 *   node decision-bench.mjs extract                       # rebuild decision-fixtures/ from the observations
 *   node decision-bench.mjs run --variant v4,v5 --repeat 6 --round d1 --provider-credential-file FILE
 *   node decision-bench.mjs run --variant v5 --fixture H05-cued --dry-run
 *   node decision-bench.mjs summarize --round d1 [--round d2] [--write]
 *
 * Measures per variant x fixture: whether a history review was started (against
 * what the turn calls for), reasoning tokens, and how many calls took longer
 * than 30 seconds (the product's whole request budget).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";
const CREDENTIAL = "OPENCODE_GO_API_KEY";
const INPUT_USD_MICROS_PER_TOKEN = 0.3;
const OUTPUT_USD_MICROS_PER_TOKEN = 1.2;
const CALL_TIMEOUT_MS = 120_000;
const REVIEW = "review_conversation_history";
const fixtureDir = path.join(here, "decision-fixtures");
const spendFile = path.join(here, "results", "decision-spend.json");

/**
 * Which Decision requests to use and what each turn calls for.
 * `recall`: the turn can only be answered from older messages. `no-recall`: an
 * ordinary turn the visible conversation answers. `either`: reasonable both ways.
 */
const SOURCES = [
  { run: "full1/H05", step: "cued", expect: "recall", why: "a cued continuation of a months-old matter" },
  { run: "full1/H04", step: "ask", expect: "recall", why: "asks about an experience from three months back" },
  { run: "full1/H12", step: "work", expect: "recall", why: "asks what was said last week" },
  { run: "full1/H08", step: "praise", expect: "recall", why: "a feeling that touches something said weeks earlier" },
  { run: "full1/H10", step: "supplement", expect: "no-recall", why: "narrows a question about today's talk; timed out on the real path" },
  { run: "full1/H02", step: "market-when", expect: "no-recall", why: "the answer is in the visible conversation; timed out on the real path" },
  { run: "full1/H09", step: "light", expect: "no-recall", why: "shares a lucky day; timed out on the real path" },
  { run: "full1/H09", step: "turn", expect: "no-recall", why: "bad news told now" },
  { run: "full1/H03", step: "order", expect: "no-recall", why: "asks about the order of two things from this sitting" },
  { run: "full1/H05", step: "garden", expect: "no-recall", why: "an ordinary share about the afternoon" },
  { run: "full1/H10", step: "after", expect: "no-recall", why: "an ordinary follow-up" },
  { run: "full1/H01", step: "detail", expect: "either", why: "a detail of yesterday; timed out on the real path" },
];

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    "cap-usd": { type: "string", default: "0.8" },
    concurrency: { type: "string", default: "4" },
    "dry-run": { type: "boolean", default: false },
    fixture: { type: "string" },
    "provider-credential-file": { type: "string" },
    repeat: { type: "string", default: "6" },
    round: { type: "string", multiple: true },
    variant: { type: "string", default: "v4,v5" },
    write: { type: "boolean", default: false },
  },
});

if (command === "extract") {
  mkdirSync(fixtureDir, { recursive: true });
  const runs = path.join(here, "..", "evidence-321-presentation", "runs");
  for (const source of SOURCES) {
    const observation = JSON.parse(gunzipSync(readFileSync(path.join(runs, source.run, "observation.json.gz"))));
    const step = observation.steps.find((candidate) => candidate.id === source.step);
    const decision = step.providerRequests[0];
    if (!decision.toolsOffered.includes(REVIEW)) throw new Error(`${source.run} ${source.step}: not a Decision request`);
    const fixture = {
      id: `${observation.caseId}-${source.step}`,
      caseId: observation.caseId,
      stepId: source.step,
      expect: source.expect,
      why: source.why,
      source: `evidence-321-presentation/runs/${source.run}`,
      observed: {
        endedMs: Math.round(decision.response.endedMs),
        reasoningTokens: decision.response.usage?.reasoningTokens ?? null,
        startedReview: (decision.response.toolCalls ?? []).some((call) => call.name === REVIEW),
      },
      instructions: decision.instructions,
      messages: decision.messages,
    };
    writeFileSync(path.join(fixtureDir, `${fixture.id}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`${fixture.id}: expect=${fixture.expect} messages=${fixture.messages.length} observed review=${fixture.observed.startedReview} reasoning=${fixture.observed.reasoningTokens}`);
  }
  process.exit(0);
}

const variants = JSON.parse(readFileSync(path.join(here, "decision-variants.json"), "utf8"));
const baseTools = JSON.parse(readFileSync(path.join(here, "fixtures", "decision-tools.json"), "utf8"));
const fixtures = () =>
  readdirSync(fixtureDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")))
    .filter((fixture) => !values.fixture || values.fixture.split(",").includes(fixture.id));

/**
 * Time layouts (`variant@layout`, default the product's table):
 *   T1  the numbered Times table is removed; every message starts with the raw local time it was written
 *   T2  as T1, in words with the weekday and how many days ago
 *   T3  as T2, on the user's messages only
 *   T5  as T3, keeping the GMT offset when the messages do not all share one; says your replies were written right after
 *   T4  as T2, keeping the GMT offset when the messages do not all share one, and saying when the earliest shown message was written
 */
const TIME_ROW = /^(\d+)=(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):\d{2} (GMT[+-][\d:]+);z=\d+;s=\w$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function withTimeLayout(fixture, layout) {
  if (!layout) return { instructions: fixture.instructions, messages: fixture.messages };
  const lines = fixture.instructions.split("\n");
  const rows = lines.map((line) => TIME_ROW.exec(line)).filter(Boolean);
  if (rows.length !== fixture.messages.length) throw new Error(`${fixture.id}: ${rows.length} time rows for ${fixture.messages.length} messages`);
  const anchor = /local=(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(fixture.instructions);
  const day = (year, month, date) => Date.UTC(Number(year), Number(month) - 1, Number(date));
  const today = day(anchor[1], anchor[2], anchor[3]);
  const words = (year, month, date) => {
    const at = day(year, month, date);
    const ago = Math.round((today - at) / 86_400_000);
    const relative = ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`;
    return `${WEEKDAYS[new Date(at).getUTCDay()]} ${Number(date)} ${MONTHS[Number(month) - 1]} ${year}, ${relative}`;
  };
  const userOnly = layout === "T3" || layout === "T5";
  const mixedOffsets = (layout === "T4" || layout === "T5") && new Set(rows.map((row) => row[7])).size > 1;
  const clock = (row) => `${row[5]}:${row[6]}${mixedOffsets ? ` ${row[7]}` : ""}`;
  const stamp = (row) =>
    layout === "T1"
      ? `[written ${row[2]}-${row[3]}-${row[4]} ${row[5]}:${row[6]} ${row[7]}]`
      : `[written ${words(row[2], row[3], row[4])}, ${clock(row)}]`;
  const earliest =
    layout === "T4"
      ? ` The earliest message below was written ${words(rows[0][2], rows[0][3], rows[0][4])}, ${clock(rows[0])}; nothing they wrote before that is shown here.`
      : "";
  const kept = lines.filter((line) => !TIME_ROW.test(line) && !/^(Zones: |Times:$)/.test(line));
  const instructions = kept
    .join("\n")
    .replace(
      /Expression times are when messages were written, in provider message order[^\n]*/,
      `${userOnly ? "Each of the user's messages" : "Each message"} below begins with a bracketed line saying when it was written, in the user's local time. That line is added by the system: it is not part of what was said, and you never write one yourself.${layout === "T5" ? " Each of your replies was written right after the message it answers." : ""}${layout === "T1" ? "" : ` Now is ${words(anchor[1], anchor[2], anchor[3]).replace(", today", "")}, ${anchor[4]}:${anchor[5]}.`}${earliest}`,
    );
  if (instructions === kept.join("\n")) throw new Error(`${fixture.id}: time preamble not found`);
  return {
    instructions,
    messages: fixture.messages.map((message, index) =>
      userOnly && message.role === "assistant" ? message : { ...message, text: `${stamp(rows[index])}\n${message.text}` },
    ),
  };
}

function requestBody(fixtureAsRecorded, variantAndLayout, sessionId) {
  const [variant, layout] = variantAndLayout.split("@");
  const description = variants[variant]?.description;
  if (typeof description !== "string") throw new Error(`Unknown variant ${variant}`);
  const fixture = withTimeLayout(fixtureAsRecorded, layout);
  return {
    messages: [
      {
        content: fixture.instructions.replace(/daily_session=[0-9a-f-]{36}/, `daily_session=${sessionId}`),
        role: "system",
      },
      ...fixture.messages.map((message) =>
        message.role === "assistant"
          ? { content: message.text, reasoning_content: "", role: "assistant" }
          : { content: message.text, role: "user" },
      ),
    ],
    model: "deepseek-v4.1-flash",
    stream: true,
    stream_options: { include_usage: true },
    tool_choice: "auto",
    tools: baseTools.map((tool) =>
      tool.function.name === REVIEW ? { ...tool, function: { ...tool.function, description } } : tool,
    ),
  };
}

function readCalls(round) {
  const plain = path.join(here, "results", round, "decision-calls.jsonl");
  return (existsSync(plain) ? readFileSync(plain, "utf8") : gunzipSync(readFileSync(`${plain}.gz`)).toString("utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

if (command === "summarize") {
  const rounds = values.round ?? [];
  const calls = rounds.flatMap(readCalls);
  const median = (numbers) => {
    const sorted = numbers.filter((value) => value !== null && value !== undefined).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  };
  const cell = (group) => {
    const ok = group.filter((call) => call.error === null);
    const reasoning = ok.map((call) => call.usage?.reasoningTokens).filter((value) => value !== null && value !== undefined);
    return `${group.length} | ${group.length - ok.length} | ${ok.filter((call) => call.startedReview).length}/${ok.length} | ${median(reasoning) ?? "n/a"} [${reasoning.length ? `${Math.min(...reasoning)}–${Math.max(...reasoning)}` : "n/a"}] | ${reasoning.reduce((sum, value) => sum + value, 0)} | ${(median(ok.map((call) => call.endedMs)) / 1000).toFixed(1)} | ${group.filter((call) => call.endedMs > 30_000 || call.error === "timeout").length}`;
  };
  const header = "calls | errors | started a review | reasoning tokens median [range] | reasoning total | done s (median) | over 30 s";
  const lines = [
    `## Decision benchmark: ${rounds.join(", ")}`,
    "",
    `${calls.length} call(s); recorded cost $${(calls.reduce((sum, call) => sum + call.costUsdMicros, 0) / 1e6).toFixed(4)} (conservative list price).`,
    "Only the description of the history-review function differs between variants. Wall-clock times were taken under the recorded concurrency.",
    "",
    "### By variant and what the turn calls for",
    "",
    `| variant | turn calls for | ${header} | correct |`,
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const keyed = (keys) => {
    const groups = new Map();
    for (const call of calls) {
      const key = keys.map((name) => call[name]).join(" | ");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(call);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  };
  for (const [key, group] of keyed(["variant", "expect"])) {
    const ok = group.filter((call) => call.error === null);
    const correct =
      group[0].expect === "either"
        ? "n/a"
        : `${ok.filter((call) => call.startedReview === (call.expect === "recall")).length}/${ok.length}`;
    lines.push(`| ${key} | ${cell(group)} | ${correct} |`);
  }
  lines.push("", "### By fixture", "", `| fixture | turn calls for | variant | ${header} |`, "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [key, group] of keyed(["fixture", "expect", "variant"])) lines.push(`| ${key} | ${cell(group)} |`);
  const output = `${lines.join("\n")}\n`;
  console.log(output);
  if (values.write) writeFileSync(path.join(here, "results", rounds[0], "decision-summary.md"), output);
  process.exit(0);
}

if (command !== "run") throw new Error("Use: extract | run | summarize");

const round = values.round?.[0] ?? "adhoc";
const jobs = [];
for (const fixture of fixtures()) {
  for (const variant of values.variant.split(",")) {
    for (let index = 1; index <= Number(values.repeat); index += 1) jobs.push({ fixture, repeat: index, variant });
  }
}
const approxTokens = (body) => Math.round(JSON.stringify(body).length * 0.3);

if (values["dry-run"]) {
  for (const job of jobs.filter((candidate) => candidate.repeat === 1)) {
    const body = requestBody(job.fixture, job.variant, randomUUID());
    console.log(`\n######## ${job.variant} ${job.fixture.id} (${job.fixture.expect}; ~${approxTokens(body)} input tokens)`);
    console.log(body.tools.find((tool) => tool.function.name === REVIEW).function.description);
    if (job.variant.includes("@")) console.log(body.messages[0].content.slice(body.messages[0].content.indexOf("current request anchor")));
    for (const message of body.messages.slice(1)) console.log(`--- ${message.role}: ${message.content.slice(0, 160)}`);
  }
  const estimate = jobs.reduce((sum, job) => sum + approxTokens(requestBody(job.fixture, job.variant, "x")) * INPUT_USD_MICROS_PER_TOKEN + 1500 * OUTPUT_USD_MICROS_PER_TOKEN, 0);
  console.log(`\n${jobs.length} call(s); rough estimate ${(estimate / 1e6).toFixed(3)} USD at 1,500 output tokens per call.`);
  process.exit(0);
}

const credentialFile = values["provider-credential-file"];
if (!credentialFile) throw new Error("--provider-credential-file is required for a live run.");
const credentialLine = readFileSync(path.resolve(credentialFile), "utf8")
  .split("\n")
  .find((candidate) => candidate.startsWith(`${CREDENTIAL}=`));
if (!credentialLine) throw new Error(`${CREDENTIAL} is not in the credential file.`);
const apiKey = credentialLine.slice(CREDENTIAL.length + 1).trim().replace(/^["']|["']$/g, "");

const spend = existsSync(spendFile) ? JSON.parse(readFileSync(spendFile, "utf8")) : { costUsdMicros: 0, requests: 0 };
const capUsdMicros = Number(values["cap-usd"]) * 1e6;
const roundDir = path.join(here, "results", round);
mkdirSync(roundDir, { recursive: true });
const totals = { costUsdMicros: 0, inputTokens: 0, outputTokens: 0, requests: 0 };

async function call(body, sessionId) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  const out = { error: null, reasoning: "", text: "", toolCalls: new Map(), usage: null };
  try {
    const response = await fetch(ENDPOINT, {
      body: JSON.stringify(body),
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "user-agent": "SayHear/1.0",
        "x-opencode-session": sessionId,
      },
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      out.error = `http_${response.status}`;
      return out;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (event.usage) out.usage = event.usage;
        const delta = event.choices?.[0]?.delta ?? {};
        if (typeof delta.reasoning_content === "string") out.reasoning += delta.reasoning_content;
        if (typeof delta.content === "string") out.text += delta.content;
        for (const fragment of delta.tool_calls ?? []) {
          const current = out.toolCalls.get(fragment.index) ?? { arguments: "", name: "" };
          if (fragment.function?.name) current.name = fragment.function.name;
          if (fragment.function?.arguments) current.arguments += fragment.function.arguments;
          out.toolCalls.set(fragment.index, current);
        }
      }
    }
  } catch (error) {
    out.error = error?.name === "AbortError" ? "timeout" : `transport_${error?.name ?? "error"}`;
  } finally {
    clearTimeout(timer);
    out.endedMs = Math.round(performance.now() - started);
  }
  return out;
}

async function runJob(job) {
  const sessionId = randomUUID();
  const body = requestBody(job.fixture, job.variant, sessionId);
  const result = await call(body, sessionId);
  const usage = result.usage
    ? {
        cachedTokens: result.usage.prompt_tokens_details?.cached_tokens ?? result.usage.prompt_cache_hit_tokens ?? null,
        inputTokens: result.usage.prompt_tokens ?? null,
        outputTokens: result.usage.completion_tokens ?? null,
        reasoningTokens: result.usage.completion_tokens_details?.reasoning_tokens ?? null,
      }
    : null;
  // Unknown usage is charged at a planning bound so nothing goes unbilled.
  const input = usage?.inputTokens ?? approxTokens(body) * 2;
  const output = usage?.outputTokens ?? 16_000;
  const cost = Math.ceil(input * INPUT_USD_MICROS_PER_TOKEN + output * OUTPUT_USD_MICROS_PER_TOKEN);
  totals.costUsdMicros += cost;
  totals.inputTokens += input;
  totals.outputTokens += output;
  totals.requests += 1;
  spend.costUsdMicros += cost;
  spend.requests += 1;
  writeFileSync(spendFile, `${JSON.stringify(spend, null, 2)}\n`);
  const toolCalls = [...result.toolCalls.values()];
  const record = {
    at: new Date().toISOString(),
    round,
    variant: job.variant,
    fixture: job.fixture.id,
    expect: job.fixture.expect,
    repeat: job.repeat,
    concurrency: Number(values.concurrency),
    error: result.error,
    startedReview: toolCalls.some((toolCall) => toolCall.name === REVIEW),
    toolCalls,
    usage,
    endedMs: result.endedMs,
    costUsdMicros: cost,
    text: result.text,
    reasoning: result.reasoning,
  };
  appendFileSync(path.join(roundDir, "decision-calls.jsonl"), `${JSON.stringify(record)}\n`);
  console.log(
    `${job.variant} ${job.fixture.id} #${job.repeat}: ${record.error ?? "ok"} review=${record.startedReview} (${job.fixture.expect}) reasoning=${usage?.reasoningTokens ?? "?"} done=${record.endedMs}ms cost=$${(cost / 1e6).toFixed(4)}`,
  );
}

const queue = [...jobs];
let stopped = false;
async function worker() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    if (spend.costUsdMicros >= capUsdMicros) {
      stopped = true;
      return;
    }
    await runJob(job);
  }
}
console.log(`${jobs.length} call(s), concurrency ${values.concurrency}; Decision benchmark spend so far $${(spend.costUsdMicros / 1e6).toFixed(4)} of $${values["cap-usd"]}.`);
await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
if (stopped) console.log(`STOPPED: spend reached the cap; ${queue.length} call(s) not made.`);
if (totals.requests > 0) {
  const ledgerFile = path.join(here, "..", "cost-ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
  ledger.entries.push({
    costUsdMicros: totals.costUsdMicros,
    date: new Date().toISOString().slice(0, 10),
    inputTokens: totals.inputTokens,
    note: `presentation-bench Decision benchmark round ${round}: variants ${values.variant} x ${fixtures().length} fixture(s), repeat ${values.repeat}; direct Provider calls, design benchmark, not acceptance; conservative peak, uncached list price; per-call detail in presentation-bench/results/${round}/decision-calls.jsonl`,
    outputTokens: totals.outputTokens,
    requests: totals.requests,
    runId: `decision-bench-${round}-${randomUUID().slice(0, 8)}`,
    ticket: "#301-presentation",
  });
  writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
}
console.log(`This invocation: ${totals.requests} request(s), $${(totals.costUsdMicros / 1e6).toFixed(4)}. Decision benchmark total: $${(spend.costUsdMicros / 1e6).toFixed(4)}.`);
