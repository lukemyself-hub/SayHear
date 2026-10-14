#!/usr/bin/env node
/**
 * Presentation benchmark runner. Calls the Provider DIRECTLY with the request a
 * layout builds from a fixture; it does not go through SayHear's conversation
 * path. See README.md: results choose a presentation, they are not acceptance
 * evidence.
 *
 *   node run.mjs --layout V2 --fixture H12-work --repeat 3 --round r1 \
 *        --provider-credential-file /path/to/env-file
 *   node run.mjs --matrix --round r1 --provider-credential-file FILE
 *   node run.mjs --layout V2 --fixture H12-work --dry-run     # print the request, call nothing
 *
 * Options
 *   --layout L[,L]        V0..V4 (default with --matrix: all)
 *   --fixture F[,F]       fixture ids (default with --matrix: all)
 *   --correction a|b|a,b  correction presentation (b only runs on fixtures that have a correction)
 *   --rules full|lean     reading-rule set
 *   --repeat N            calls per cell (default 3)
 *   --concurrency N       parallel calls (default 4). Wall-clock times are only comparable
 *                         within one concurrency setting; reasoning tokens are the main measure.
 *   --round NAME          results go to results/NAME/
 *   --cap-usd X           stop launching calls once this benchmark's recorded spend reaches X (default 1.5)
 *   --no-ledger           do not append to ../cost-ledger.json (dry tests only)
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { LAYOUTS, buildRequest } from "./layouts.mjs";
import { CANNOT_SEE, MARK_LEAK } from "./patterns.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";
const CREDENTIAL = "OPENCODE_GO_API_KEY";
// The ledger's conservative rate: peak list price, every input token uncached.
const INPUT_USD_MICROS_PER_TOKEN = 0.3;
const OUTPUT_USD_MICROS_PER_TOKEN = 1.2;
const CALL_TIMEOUT_MS = 240_000;

const { values } = parseArgs({
  options: {
    "cap-usd": { type: "string", default: "1.5" },
    concurrency: { type: "string", default: "4" },
    correction: { type: "string", default: "a" },
    "dry-run": { type: "boolean", default: false },
    fixture: { type: "string" },
    layout: { type: "string" },
    matrix: { type: "boolean", default: false },
    "no-ledger": { type: "boolean", default: false },
    "provider-credential-file": { type: "string" },
    repeat: { type: "string", default: "3" },
    round: { type: "string", default: "adhoc" },
    rules: { type: "string", default: "full" },
  },
});

const fixtureDir = path.join(here, "fixtures");
const allFixtures = readdirSync(fixtureDir)
  .filter((name) => name.endsWith(".json") && name !== "decision-tools.json")
  .map((name) => name.replace(/\.json$/, ""));
const tools = JSON.parse(readFileSync(path.join(fixtureDir, "decision-tools.json"), "utf8"));
const layouts = values.layout ? values.layout.split(",") : values.matrix ? LAYOUTS : null;
const fixtures = values.fixture ? values.fixture.split(",") : values.matrix ? allFixtures : null;
if (!layouts || !fixtures) throw new Error("Give --layout and --fixture, or --matrix.");
const corrections = values.correction.split(",");
const repeat = Number(values.repeat);
const roundDir = path.join(here, "results", values.round);
const spendFile = path.join(here, "results", "spend.json");

function loadFixture(id) {
  return JSON.parse(readFileSync(path.join(fixtureDir, `${id}.json`), "utf8"));
}

const jobs = [];
for (const fixtureId of fixtures) {
  const fx = loadFixture(fixtureId);
  const hasCorrection = fx.quoted.some((message) => message.correctedAt);
  for (const layout of layouts) {
    for (const correction of corrections) {
      if (correction !== "a" && (!hasCorrection || layout === "V0")) continue;
      for (let index = 1; index <= repeat; index += 1) {
        jobs.push({ correction, fixtureId, fx, layout, repeat: index, rules: layout === "V0" ? "product" : values.rules });
      }
    }
  }
}

const approxTokens = (body) => Math.round(JSON.stringify(body).length * 0.55);

if (values["dry-run"]) {
  for (const job of jobs.filter((candidate) => candidate.repeat === 1)) {
    const request = buildRequest(job.layout, job.fx, { correction: job.correction, rules: job.rules, sessionId: randomUUID(), tools });
    console.log(`\n######## ${job.layout} ${job.fixtureId} correction=${job.correction} rules=${job.rules} (~${approxTokens(request.body)} input tokens)`);
    for (const message of request.body.messages) {
      console.log(`\n--- ${message.role}${message.tool_calls ? ` tool_calls=${JSON.stringify(message.tool_calls)}` : ""}`);
      console.log(message.content);
    }
  }
  const estimate = jobs.reduce((sum, job) => {
    const request = buildRequest(job.layout, job.fx, { correction: job.correction, rules: job.rules, sessionId: randomUUID(), tools });
    return sum + approxTokens(request.body) * (request.warmup ? 2 : 1) * INPUT_USD_MICROS_PER_TOKEN + 5000 * OUTPUT_USD_MICROS_PER_TOKEN;
  }, 0);
  console.log(`\n${jobs.length} call(s); rough estimate ${(estimate / 1e6).toFixed(3)} USD at 5,000 output tokens per call.`);
  process.exit(0);
}

function readCredential() {
  const file = values["provider-credential-file"];
  if (!file) throw new Error("--provider-credential-file is required for a live run.");
  const line = readFileSync(path.resolve(file), "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith(`${CREDENTIAL}=`));
  if (!line) throw new Error(`${CREDENTIAL} is not in the credential file.`);
  return line.slice(CREDENTIAL.length + 1).trim().replace(/^["']|["']$/g, "");
}
const apiKey = readCredential();

const spend = existsSync(spendFile) ? JSON.parse(readFileSync(spendFile, "utf8")) : { costUsdMicros: 0, requests: 0 };
const capUsdMicros = Number(values["cap-usd"]) * 1e6;
mkdirSync(path.join(roundDir, "requests"), { recursive: true });

async function callProvider(body, sessionId) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  const out = { firstByteMs: null, firstContentMs: null, firstReasoningMs: null, reasoning: "", text: "", usage: null };
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
    out.status = response.status;
    if (!response.ok || !response.body) {
      out.error = `http_${response.status}`;
      out.errorBody = (await response.text().catch(() => "")).slice(0, 300);
      return out;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      if (out.firstByteMs === null) out.firstByteMs = performance.now() - started;
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.usage) out.usage = event.usage;
        const choice = event.choices?.[0];
        const delta = choice?.delta ?? {};
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
          if (out.firstReasoningMs === null) out.firstReasoningMs = performance.now() - started;
          out.reasoning += delta.reasoning_content;
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
          if (out.firstContentMs === null) out.firstContentMs = performance.now() - started;
          out.text += delta.content;
        }
        if (delta.tool_calls) out.toolCalled = true;
        if (choice?.finish_reason) out.finishReason = choice.finish_reason;
      }
    }
  } catch (error) {
    out.error = error?.name === "AbortError" ? "timeout" : `transport_${error?.name ?? "error"}`;
  } finally {
    clearTimeout(timer);
    out.endedMs = performance.now() - started;
  }
  return out;
}

function normalizedUsage(usage) {
  if (!usage) return null;
  return {
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? null,
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
  };
}

function costOf(usage, body) {
  // Unknown usage is charged at a planning bound so nothing goes unbilled.
  const input = usage?.inputTokens ?? approxTokens(body) * 2;
  const output = usage?.outputTokens ?? 16_000;
  return Math.ceil(input * INPUT_USD_MICROS_PER_TOKEN + output * OUTPUT_USD_MICROS_PER_TOKEN);
}

const totals = { costUsdMicros: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
function bill(usage, body) {
  const cost = costOf(usage, body);
  totals.costUsdMicros += cost;
  totals.requests += 1;
  totals.inputTokens += usage?.inputTokens ?? approxTokens(body) * 2;
  totals.outputTokens += usage?.outputTokens ?? 16_000;
  spend.costUsdMicros += cost;
  spend.requests += 1;
  writeFileSync(spendFile, `${JSON.stringify(spend, null, 2)}\n`);
  return cost;
}

async function runJob(job) {
  const sessionId = randomUUID();
  const request = buildRequest(job.layout, job.fx, { correction: job.correction, rules: job.rules, sessionId, tools });
  const key = `${job.layout}-${job.fixtureId}-${job.correction}-${job.rules}`;
  const sample = path.join(roundDir, "requests", `${key}.json`);
  if (job.repeat === 1) writeFileSync(sample, `${JSON.stringify(request.body, null, 2)}\n`);
  let warmupCost = 0;
  if (request.warmup) {
    const warm = await callProvider(request.warmup, sessionId);
    warmupCost = bill(normalizedUsage(warm.usage), request.warmup);
  }
  const result = await callProvider(request.body, sessionId);
  const usage = normalizedUsage(result.usage);
  const cost = bill(usage, request.body);
  const check = (list) => Object.fromEntries(list.map((item) => [item.id, new RegExp(item.pattern, "i").test(result.text)]));
  const must = check(job.fx.checks.must);
  const mustNot = check(job.fx.checks.mustNot);
  const record = {
    at: new Date().toISOString(),
    round: values.round,
    layout: job.layout,
    fixture: job.fixtureId,
    correction: job.correction,
    rules: job.rules,
    repeat: job.repeat,
    concurrency: Number(values.concurrency),
    status: result.status ?? null,
    error: result.error ?? null,
    finishReason: result.finishReason ?? null,
    usage,
    timings: {
      endedMs: Math.round(result.endedMs),
      firstByteMs: result.firstByteMs === null ? null : Math.round(result.firstByteMs),
      firstContentMs: result.firstContentMs === null ? null : Math.round(result.firstContentMs),
      firstReasoningMs: result.firstReasoningMs === null ? null : Math.round(result.firstReasoningMs),
    },
    flags: {
      cannotSeeQuoted: CANNOT_SEE.test(result.reasoning),
      markLeak: MARK_LEAK.test(result.text),
      toolCalled: result.toolCalled === true,
    },
    checks: {
      must,
      mustNot,
      pass: Object.values(must).every(Boolean) && !Object.values(mustNot).some(Boolean),
    },
    costUsdMicros: cost + warmupCost,
    text: result.text,
    reasoning: result.reasoning,
    ...(result.errorBody ? { errorBody: result.errorBody } : {}),
  };
  appendFileSync(path.join(roundDir, "calls.jsonl"), `${JSON.stringify(record)}\n`);
  console.log(
    `${key} #${job.repeat}: ${record.error ?? "ok"} reasoning=${usage?.reasoningTokens ?? "?"} in=${usage?.inputTokens ?? "?"} cached=${usage?.cachedTokens ?? "?"} done=${record.timings.endedMs}ms cannotSee=${record.flags.cannotSeeQuoted} leak=${record.flags.markLeak} checks=${record.checks.pass} cost=$${(record.costUsdMicros / 1e6).toFixed(4)}`,
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
console.log(`${jobs.length} call(s), concurrency ${values.concurrency}; benchmark spend so far $${(spend.costUsdMicros / 1e6).toFixed(4)} of $${values["cap-usd"]}.`);
await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
if (stopped) console.log(`STOPPED: benchmark spend reached the cap; ${queue.length} call(s) not made.`);

if (!values["no-ledger"] && totals.requests > 0) {
  const ledgerFile = path.join(here, "..", "cost-ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
  ledger.entries.push({
    costUsdMicros: totals.costUsdMicros,
    date: new Date().toISOString().slice(0, 10),
    inputTokens: totals.inputTokens,
    note: `presentation-bench round ${values.round}: layouts ${layouts.join(",")} x fixtures ${fixtures.join(",")} (correction ${values.correction}, rules ${values.rules}, repeat ${repeat}); direct Provider calls, design benchmark, not acceptance; conservative peak, uncached list price; per-call detail in presentation-bench/results/${values.round}/calls.jsonl`,
    outputTokens: totals.outputTokens,
    requests: totals.requests,
    runId: `presentation-bench-${values.round}-${randomUUID().slice(0, 8)}`,
    ticket: "#301-presentation",
  });
  writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
}
console.log(
  `This invocation: ${totals.requests} request(s), $${(totals.costUsdMicros / 1e6).toFixed(4)}. Benchmark total: $${(spend.costUsdMicros / 1e6).toFixed(4)}.`,
);
