#!/usr/bin/env node
/**
 * Builds the layout-independent benchmark fixtures from the History Answer
 * calls recorded by the response-structure prototype (group 0, the product's
 * own structure at f179b3d).
 *
 *   node extract-fixtures.mjs --runs <.../prototype-response-structure/runs/g0>
 *
 * Everything in a fixture is synthetic holdout data that already left for the
 * Provider in that run. Nothing is read from a database.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { runs: { type: "string" } } });
if (!values.runs) throw new Error("--runs <g0 directory> is required");

/**
 * Rough, machine-checkable points per fixture, written from the holdout
 * oracle's allowed / forbidden facts. They are a coarse screen only: a pass
 * is not a semantic pass, and a miss needs a human look.
 */
const CASES = [
  {
    caseId: "H12",
    stepId: "work",
    checks: {
      must: [
        { id: "corrected-figure", pattern: "1\\.5" },
        { id: "merge", pattern: "platform" },
      ],
      mustNot: [
        {
          id: "old-figure-as-current",
          pattern:
            "(更正|改口|改成|改为|纠正|订正|修正|后来(又)?(说|讲|确认)|其实是|应该是|实际是)[^。；\\n]{0,30}2\\.5|2\\.5[^。；\\n]{0,14}(才对|为准|是对的|才是)",
        },
      ],
    },
  },
  {
    caseId: "H07",
    stepId: "september",
    checks: {
      must: [
        { id: "old-home", pattern: "槐荫里|合租" },
        { id: "shared-bathroom-or-noise", pattern: "卫生间|打游戏|游戏" },
      ],
      mustNot: [{ id: "says-cannot-tell", pattern: "没法(给你)?还原|看不到|没(有)?找到|没有记录|答不上" }],
    },
  },
  {
    caseId: "H07",
    stepId: "party",
    // The lookup in this run did not return the cancellation message, so the
    // fixture cannot require it. It is kept for the reasoning load it caused.
    checks: {
      must: [],
      mustNot: [{ id: "party-described-as-held", pattern: "吃得(很|挺)?(好|开心|热闹)|办得(很|挺)?" }],
    },
  },
  {
    caseId: "H11",
    stepId: "older",
    checks: {
      must: [
        { id: "adoption", pattern: "橘猫|救助站" },
        { id: "hiding", pattern: "沙发" },
      ],
      mustNot: [{ id: "false-empty", pattern: "没(有)?(聊|说|提)过什么|没有记录|没(有)?找到" }],
    },
  },
  {
    caseId: "H04",
    stepId: "ask",
    checks: {
      must: [
        { id: "cousin", pattern: "表弟" },
        { id: "life-ring", pattern: "救生圈" },
      ],
      mustNot: [
        { id: "no-record", pattern: "没(有)?(讲|说|提)过|找不到|没(有)?找到" },
        { id: "lesson-mixed-in", pattern: "憋气|浅水区" },
      ],
    },
  },
  {
    caseId: "H06",
    stepId: "role",
    checks: {
      must: [
        { id: "designer", pattern: "designer|设计" },
        { id: "role-left-open", pattern: "没(有)?(确认|回答|回|答|说|讲|提|告诉|接)|不确定|不知道|没法确定|说不准|说不上|没下文" },
      ],
      mustNot: [{ id: "lead-as-fact", pattern: "他(就)?是(?!不是)(你们)?[^，。？不]{0,10}design lead[。，]" }],
    },
  },
  {
    caseId: "H01",
    stepId: "recap",
    checks: {
      must: [
        { id: "car", pattern: "电瓶|打不着火|搭电" },
        { id: "timetable", pattern: "课表|调课|冲突" },
        { id: "hearing-aid", pattern: "助听器" },
        { id: "piano-exam", pattern: "钢琴|考级" },
        { id: "masters", pattern: "研究生|读研|在职" },
      ],
      mustNot: [{ id: "todays-lab", pattern: "实验室" }],
    },
  },
  {
    caseId: "H02",
    stepId: "said",
    checks: {
      must: [
        { id: "market", pattern: "花市" },
        { id: "tyre", pattern: "后胎|补胎|图钉|车胎" },
        { id: "mentor-meal", pattern: "老秦|师傅" },
      ],
      mustNot: [{ id: "market-placed-yesterday", pattern: "昨天(陪|去|和|跟)[^。]{0,14}花市" }],
    },
  },
];

function parseTimeRow(raw) {
  // "2026-11-11 20:00:00 GMT+8" or "GMT+5:30" or "GMT-7"
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(raw);
  if (!match) throw new Error(`Unrecognised time row: ${raw}`);
  const [, date, time, sign, hours, minutes] = match;
  const offset = `${sign}${hours.padStart(2, "0")}:${minutes ?? "00"}`;
  return new Date(`${date}T${time}${offset}`).toISOString();
}

for (const spec of CASES) {
  const file = path.join(values.runs, spec.caseId, "observation.json");
  const bytes = readFileSync(file);
  const observation = JSON.parse(bytes);
  const step = observation.steps.find((candidate) => candidate.id === spec.stepId);
  const decision = step.providerRequests[0];
  const answer = step.providerRequests.at(-1);
  if (step.providerRequests.length < 2 || answer.toolsOffered.length !== 0) {
    throw new Error(`${spec.caseId} ${spec.stepId}: no History Answer call`);
  }
  const lines = answer.instructions.split("\n");
  const sessionIndex = lines.findIndex((line) => line.startsWith("daily_session="));
  const receiptIndex = lines.findIndex((line) => line.startsWith("History review result"));
  const rulesIndex = lines.findIndex((line) => line.startsWith("Rules for the reply:"));
  const readingIndex = lines.findIndex((line) => line.startsWith("History reading rules"));
  const timeLines = lines.slice(sessionIndex + 1, receiptIndex);
  const anchorLine = timeLines.find((line) => line.startsWith("current request anchor"));
  const anchor = /instant=([^;]+); timezone=([^;]+);/.exec(anchorLine);
  const rows = timeLines
    .map((line) => /^(\d+)=([^;]+);/.exec(line))
    .filter(Boolean)
    .map((match) => match[2]);
  if (rows.length !== answer.messages.length) {
    throw new Error(`${spec.caseId} ${spec.stepId}: ${rows.length} time rows for ${answer.messages.length} messages`);
  }
  const facts = lines.slice(receiptIndex + 1, rulesIndex);
  const afterRules = lines.slice(rulesIndex + 1, readingIndex === -1 ? undefined : readingIndex);
  const corrections = new Map();
  const guidance = [];
  for (const line of afterRules) {
    const mark = /^Message (\d+) is the person's own correction .* at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) /.exec(line);
    if (mark) corrections.set(Number(mark[1]), { date: mark[2], time: mark[3] });
    else guidance.push(line);
  }
  let quotedCount = 0;
  const occasions = [];
  for (const line of facts) {
    const perDate = /^- \d{4}-\d{2}-\d{2}: .*?(\d+) quoted\.$/.exec(line);
    const occasion = /^- (Occasion \d+): around (\d{4}-\d{2}-\d{2}); (\d+) message\(s\) quoted\.$/.exec(line);
    if (perDate) quotedCount += Number(perDate[1]);
    if (occasion) {
      quotedCount += Number(occasion[3]);
      occasions.push({ count: Number(occasion[3]), label: occasion[1] });
    }
  }
  const messages = answer.messages.map((message, index) => {
    const timeRaw = rows[index];
    const correction = corrections.get(index + 1);
    const offset = /GMT.*$/.exec(timeRaw)[0];
    return {
      role: message.role,
      text: message.text,
      saidAt: parseTimeRow(timeRaw),
      timeRaw,
      ...(correction
        ? {
            correctedAt: parseTimeRow(`${correction.date} ${correction.time}:00 ${offset}`),
            correctedRaw: `${correction.date} ${correction.time}:00 ${offset}`,
          }
        : {}),
    };
  });
  let occasionCursor = 0;
  const quoted = messages.slice(0, quotedCount).map((message, index) => {
    if (occasions.length === 0) return message;
    let seen = 0;
    for (const occasion of occasions) {
      seen += occasion.count;
      if (index < seen) return { ...message, occasion: occasion.label };
    }
    occasionCursor += 1;
    return message;
  });
  void occasionCursor;
  const fixture = {
    id: `${spec.caseId}-${spec.stepId}`,
    caseId: spec.caseId,
    stepId: spec.stepId,
    source: {
      observationSha256: createHash("sha256").update(bytes).digest("hex"),
      run: "prototype-response-structure/runs/g0",
      productCommit: observation.identity.gitCommit,
    },
    timezone: anchor[2],
    now: anchor[1],
    // V0: exactly what the product sent for the History Answer call.
    answer: { instructions: answer.instructions, messages: answer.messages },
    // The Decision call of the same turn (the prefix a tool-result layout shares).
    decision: {
      instructions: decision.instructions,
      messages: decision.messages,
      toolCall: decision.response.toolCalls[0],
    },
    head: lines.slice(0, sessionIndex).join("\n"),
    dailySessionLine: lines[sessionIndex],
    timeLines,
    quoted,
    conversation: messages.slice(quotedCount, -1),
    question: messages.at(-1),
    receipt: {
      header: lines[receiptIndex],
      facts,
      rulesForReply: lines[rulesIndex],
      guidance,
      occasions,
    },
    observed: {
      reasoningTokens: answer.response.usage.reasoningTokens,
      endedMs: Math.round(answer.response.endedMs),
      text: answer.response.text,
    },
    checks: spec.checks,
  };
  writeFileSync(path.join(here, "fixtures", `${fixture.id}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(
    `${fixture.id}: quoted=${quoted.length} conversation=${fixture.conversation.length} corrections=${corrections.size} occasions=${occasions.length} observedReasoning=${fixture.observed.reasoningTokens}`,
  );
}
