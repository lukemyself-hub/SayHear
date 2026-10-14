import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createContextCompiler,
  createContinuousExchangeService,
  createConversationAgentHarness,
  createConversationResponseService,
  createHistoryRecallGateway,
  createUserTextConversationService,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  HISTORY_RECALL_CONVERSATION_HARNESS_POLICY,
  HISTORY_RECALL_DEFAULT_POLICY,
  HISTORY_REVIEW_FUNCTION_NAME,
  ProviderDispatchError,
  TIME_AWARE_CONTEXT_COMPILER_VERSION,
  type ConversationResponseStreamEvent,
  type ConversationTextModel,
  type HistoryRecallPolicy,
  type HistoryRecallSourcePort,
} from "@sayhear/application";
import {
  PostgresContinuousExchangeRepository,
  PostgresConversationResponseRepository,
  PostgresHistoryRecallRepository,
  PostgresHistoryRecallSource,
  PostgresInternalInspectionRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  asGenerationCommandId,
  asUserId,
} from "@sayhear/domain";
import { createProviderEgressPort } from "@sayhear/ai/testing";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";
import { sentMessages } from "../support/earlier-messages-block";

/**
 * Issue #315: date-based history review (time blocks, experienced dates, honest coverage) on top of the #314 controlled review, end to end through the
 * real conversation service, Harness, Context Compiler, Provider Egress and
 * PostgreSQL. Only the external model is a stand-in; it records every request
 * so "what actually left SayHear" is asserted at the Provider boundary.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const ZONE = "Asia/Shanghai";
const iso = (value: string) => new Date(value);

const testChampion = Object.freeze({
  configVersion: "conversation-text-champion:v1",
  consentPolicyVersion: null,
  contextLimit: 1_000_000,
  dataRegion: "test",
  model: "gpt-5.4",
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  retentionMode: "store-disabled",
  snapshot: "gpt-5.4",
  streaming: true as const,
  supportedLocales: Object.freeze(["en", "zh"]),
  trainingPolicy: "test",
});

const generationPolicy = Object.freeze({
  consentPolicyVersion: null,
  freshnessPolicy: "source_valid:v1" as const,
  chineseLocalePackVersion: "locale-pack-zh:v1",
  englishLocalePackVersion: "locale-pack-en:v1",
  harnessPolicyVersion: HISTORY_RECALL_CONVERSATION_HARNESS_POLICY.version,
  conversationActionCatalogVersion: EMPTY_CONVERSATION_ACTION_CATALOG.version,
  model: "gpt-5.4",
  modelConfigVersion: "conversation-text-champion:v1",
  modelSnapshot: "gpt-5.4",
  outputFormatVersion: "conversation-output:v1",
  canonicalPersonaVersion: "canonical-persona:v1",
  personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
  personaContractInvariantVersion: "persona-contract-invariant:v1",
  productPolicyVersion: "product-policy:v1",
  taskInstructionVersion: "task-instruction-decision:v1",
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
});

type CapturedRequest = Readonly<{
  functionNames: readonly string[];
  instructions: string;
  messages: readonly string[];
  toolsDisabled: boolean;
}>;

type Script = {
  /** Local dates the Decision selects; null answers ordinarily. */
  review: { end_date?: string; start_date: string } | null;
  /** Throw this category once on the first stage-two request. */
  failAnswerOnce?: "timeout";
};

let database: IsolatedPostgresSchema;
let now = iso("2026-08-20T10:00:00.000Z");
let counter = 0;
let requests: CapturedRequest[] = [];
let script: Script = { review: null };
let answerFailuresLeft = 0;
let sourceReads = 0;

function uuidV7(at: Date): string {
  const bytes = randomBytes(16);
  let timestamp = at.getTime();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const clock = () => now;

const model: ConversationTextModel = {
  async *stream(request) {
    requests.push({
      functionNames: (request.functions ?? []).map((definition) => definition.name),
      instructions: request.instructions,
      // Quoted earlier messages (the block in the instructions), then the turns sent.
      messages: sentMessages(request),
      toolsDisabled: request.toolsDisabled === true,
    });
    const offered = (request.functions ?? []).some(
      (definition) => definition.name === HISTORY_REVIEW_FUNCTION_NAME,
    );
    if (offered && script.review) {
      yield {
        rawArguments: JSON.stringify(script.review),
        rawFunctionName: HISTORY_REVIEW_FUNCTION_NAME,
        type: "tool_call" as const,
      };
      yield completion(request.model, 5);
      return;
    }
    if (request.toolsDisabled === true && answerFailuresLeft > 0) {
      answerFailuresLeft -= 1;
      throw new ProviderDispatchError("timeout");
    }
    yield { delta: "我看了那天你说的。", type: "delta" as const };
    yield completion(request.model, 9);
  },
};

function completion(modelName: string, outputTokens: number) {
  return {
    costMicros: 0,
    finishReason: "completed",
    inputTokens: 10,
    modelSnapshot: modelName,
    outputTokens,
    providerRequestId: "history-recall-request",
    type: "completed" as const,
  };
}

type Built = ReturnType<typeof build>;
let built: Built;

function build(overrides: {
  policy?: HistoryRecallPolicy;
  afterAdmit?: () => Promise<void>;
  afterCompile?: () => Promise<void>;
  source?: (inner: HistoryRecallSourcePort) => HistoryRecallSourcePort;
} = {}) {
  const responseRepository = new PostgresConversationResponseRepository(database.pool);
  const baseCompiler = createContextCompiler({
    clock,
    compilerVersion: TIME_AWARE_CONTEXT_COMPILER_VERSION,
    contentHmacSecret: "history-recall-system-secret",
    rawEventTokenBudget: 4_000,
    repository: responseRepository,
  });
  const contextCompiler = overrides.afterCompile
    ? {
        ...baseCompiler,
        async compile(input: Parameters<typeof baseCompiler.compile>[0]) {
          const compiled = await baseCompiler.compile(input);
          await overrides.afterCompile!();
          return compiled;
        },
      }
    : baseCompiler;
  const innerSource = new PostgresHistoryRecallSource(database.pool);
  const countingSource: HistoryRecallSourcePort = {
    async readHistoryRange(request) {
      sourceReads += 1;
      return innerSource.readHistoryRange(request);
    },
  };
  const gatewayBase = createHistoryRecallGateway({
    clock,
    ...(overrides.policy ? { policy: overrides.policy } : {}),
    repository: new PostgresHistoryRecallRepository(database.pool),
    source: overrides.source ? overrides.source(countingSource) : countingSource,
  });
  const historyRecall = overrides.afterAdmit
    ? {
        ...gatewayBase,
        async admit(input: Parameters<typeof gatewayBase.admit>[0]) {
          const receipt = await gatewayBase.admit(input);
          await overrides.afterAdmit!();
          return receipt;
        },
      }
    : gatewayBase;
  const conversationService = createUserTextConversationService({
    clock,
    expectedBackupPolicyVersion: "neon-production-v1",
    expectedConfigurationFingerprint: "sha256:expected",
    generationPolicy,
    inactivityPolicy: { timeoutMs: 1_800_000, version: "continuous-exchange-inactivity:v1" },
    repository: new PostgresUserTextConversationRepository(database.pool),
  });
  const harness = createConversationAgentHarness({
    clock,
    contextCompiler,
    delay: async () => undefined,
    egressPort: createProviderEgressPort({
      champion: testChampion,
      clock,
      contextCompiler,
      model,
      repository: responseRepository,
    }),
    historyRecall,
    jitter: () => 0,
    repository: responseRepository,
  });
  const service = createConversationResponseService({
    catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
    clock,
    contextCompiler,
    conversationService,
    harness,
    harnessPolicy: HISTORY_RECALL_CONVERSATION_HARNESS_POLICY,
    historyRecall,
    jitter: () => 0,
    repository: responseRepository,
  });
  const exchange = createContinuousExchangeService({
    clock,
    repository: new PostgresContinuousExchangeRepository(database.pool),
  });
  return { exchange, harness, historyRecall, responseRepository, service };
}

async function say(text: string, at: string, timezone: string = ZONE): Promise<ConversationResponseStreamEvent[]> {
  now = iso(at);
  counter += 1;
  const events: ConversationResponseStreamEvent[] = [];
  for await (const event of built.service.respond(OWNER, {
    clientEventId: `h-event-${counter}`,
    clientTurnId: `h-turn-${counter}`,
    locale: "zh-CN",
    text,
    timezone,
  })) {
    events.push(event);
  }
  return events;
}

/** End the active Daily Session the way the production scan would. */
async function closeSession(at: string): Promise<void> {
  now = iso(at);
  await built.exchange.scanDueInactivity();
}

const assistantText = (events: readonly ConversationResponseStreamEvent[]) =>
  events.flatMap((event) => (event.type === "assistant_delta" ? [event.delta] : [])).join("");

const terminal = (events: readonly ConversationResponseStreamEvent[]) => events.at(-1)?.type;

async function rows<T extends Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
  return (await database.pool.query<T>(sql, parameters)).rows;
}

beforeEach(async () => {
  database = await createIsolatedPostgresSchema(testDatabaseUrl);
  await runMigrations(database.pool);
  await new PostgresInternalOwnerAccessRepository(database.pool).provisionInternalOwner({
    issuer: "https://github.com",
    subject: "history-recall-test-owner",
    userId: OWNER,
  });
  await new PostgresInternalOwnerAccessRepository(database.pool).recordBackupPolicyEvidence({
    backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
    configurationFingerprint: "sha256:expected",
    databaseRetentionDays: 30,
    evidenceReference: "synthetic backup evidence",
    policyVersion: "neon-production-v1",
    pitrRetentionDays: 7,
    snapshotRetentionDays: 30,
    status: "verified",
    validUntil: new Date("2027-08-27T00:00:00.000Z"),
    verifiedAt: new Date("2026-08-13T00:00:00.000Z"),
  });
  await database.pool.query("UPDATE provider_egress_policy_versions SET status = 'active'");
  counter = 0;
  requests = [];
  script = { review: null };
  answerFailuresLeft = 0;
  sourceReads = 0;
  built = build();
}, 30_000);

afterEach(async () => {
  await database?.dispose();
}, 15_000);

// ---------------------------------------------------------------------------
// Helpers specific to the date review (issue #315).
// ---------------------------------------------------------------------------

/** The review function call of the next Decision. */
function review(
  startDate: string,
  over: { end_date?: string; time_basis?: "expressed_date" | "experienced_date" } = {},
): void {
  script = { review: { start_date: startDate, ...over } };
}

async function ask(text: string, at: string, timezone: string = ZONE) {
  const events = await say(text, at, timezone);
  expect(terminal(events)).toBe("assistant_committed");
  return events;
}

/** The History Answer request: the last request that left SayHear. */
const answerRequest = () => requests.at(-1)!;

const frozenResults = () =>
  rows<{
    coverage: {
      blocks: number;
      blocksCovered: number;
      enumeratedRows: number;
      enumerationComplete: boolean;
      limits: string[];
      omitted: Record<string, number>;
      pages: number;
      perDate: Array<{ localDate: string; state: string }>;
      readThrough: string | null;
      selectedRows: number;
      timeBasis: string;
    };
    item_refs: Array<{ expressedAt: string }>;
    plan: { plan: { readEndDate: string; readStartDate: string; timeBasis: string } };
    status: string;
  }>("SELECT status, coverage, item_refs, plan FROM history_recall_results ORDER BY created_at");

const guidanceOf = (instructions: string) =>
  instructions
    .split("\n")
    .filter((line) => line.startsWith("Answer guidance"))
    .join("\n");

/** Ownership of every stored message: event -> Daily Session. */
const ownership = () =>
  rows<{ conversation_event_id: string; daily_session_id: string }>(
    "SELECT conversation_event_id::text, daily_session_id::text FROM conversation_events ORDER BY conversation_event_id",
  );

const LONG_DAY = "2026-09-14";
const LATE_TOPIC = Array.from(
  { length: 8 },
  (_, index) =>
    `深夜里我还在想转岗的事，第${index + 1}层：${"想到要搬家就头大，".repeat(8)}编号${index + 1}。`,
);

/** Five subjects across one Shanghai day; the last one is long. */
async function seedLongDay(): Promise<void> {
  script = { review: null };
  await say("牙医那边补的料又掉了。", "2026-09-14T00:10:00.000Z");
  await closeSession("2026-09-14T01:00:00.000Z");
  await say("到公司就对账，差了三千二。", "2026-09-14T02:30:00.000Z");
  await say("后来发现一张发票录了两次。", "2026-09-14T02:39:00.000Z");
  await closeSession("2026-09-14T03:30:00.000Z");
  await say("我妈说老家屋顶又漏了。", "2026-09-14T04:40:00.000Z");
  await closeSession("2026-09-14T05:30:00.000Z");
  await say("下午去看女儿游泳测试。", "2026-09-14T08:20:00.000Z");
  await closeSession("2026-09-14T09:10:00.000Z");
  for (const [index, text] of LATE_TOPIC.entries()) {
    await say(text, `2026-09-14T14:${String(10 + index * 3).padStart(2, "0")}:00.000Z`);
  }
  await closeSession("2026-09-14T15:40:00.000Z");
  await say("今天一来又是对账，运费多了八百。", "2026-09-15T01:40:00.000Z");
  requests = [];
  sourceReads = 0;
}

const SMALL_BUDGET_POLICY: HistoryRecallPolicy = {
  ...HISTORY_RECALL_DEFAULT_POLICY,
  maxContextTokens: 120,
  maxPages: 12,
  maxSourceRows: 100,
  pageSize: 5,
};

describe("date review through the real conversation path", () => {
  it("covers every part of a long day across pages without letting the last long subject crowd out the early ones", async () => {
    await seedLongDay();
    built = build({ policy: SMALL_BUDGET_POLICY });
    review(LONG_DAY);
    await ask("昨天一整天我都跟你聊了些什么？", "2026-09-15T01:55:00.000Z");

    const messages = answerRequest().messages.join("\n");
    for (const early of [
      "牙医那边补的料又掉了。",
      "到公司就对账，差了三千二。",
      "我妈说老家屋顶又漏了。",
      "下午去看女儿游泳测试。",
      LATE_TOPIC[0]!,
    ]) {
      expect(messages).toContain(early);
    }
    // The late topic does not fit: it is cut, not the early subjects.
    expect(messages).not.toContain(LATE_TOPIC[7]!);

    const [result] = await frozenResults();
    expect(result!.status).toBe("partial");
    expect(result!.coverage).toMatchObject({ blocks: 5, blocksCovered: 5, enumerationComplete: true });
    expect(result!.coverage.pages).toBeGreaterThan(1);
    expect(result!.coverage.omitted.budget_exhausted).toBeGreaterThan(0);
    // Nothing from today is presented as part of yesterday.
    expect(result!.item_refs.every((ref) => ref.expressedAt < "2026-09-14T16:00:00.000Z")).toBe(true);
    expect(answerRequest().instructions).toContain("Answer guidance (only part quoted)");
  });

  it("answers a follow-up detail again from the original words and leaves Session ownership alone", async () => {
    await seedLongDay();
    built = build({ policy: SMALL_BUDGET_POLICY });
    review(LONG_DAY);
    await ask("昨天一整天我都跟你聊了些什么？", "2026-09-15T01:55:00.000Z");
    const before = await ownership();

    requests = [];
    review(LONG_DAY);
    await ask("对账那件事，我最后是怎么找到问题的？", "2026-09-15T02:00:00.000Z");
    expect(requests).toHaveLength(2);
    const detail = answerRequest().messages.join("\n");
    expect(detail).toContain("后来发现一张发票录了两次。");
    expect(detail).toContain("user:到公司就对账，差了三千二。");

    const after = await ownership();
    for (const row of before) {
      expect(after).toContainEqual(row);
    }
    // The earlier recap reply is only context: no stored claim or summary.
    expect(await rows("SELECT 1 FROM memory_claims")).toHaveLength(0);
    expect(answerRequest().instructions).toContain("never evidence of what the person said");
  });

  it("keeps what was said and what happened apart, and leaves an unknown experience date unknown", async () => {
    script = { review: null };
    await say("上周日带我爸去了趟滨江公园。", "2026-09-16T12:05:00.000Z");
    await say("对了，最近还见了一回大学同屋阿澈。", "2026-09-16T12:12:00.000Z");
    await closeSession("2026-09-16T13:30:00.000Z");
    requests = [];

    // Asked about the Sunday itself as an experience: the retelling is a lead,
    // never proof, and the review says it cannot be complete.
    review("2026-09-13", { time_basis: "experienced_date" });
    await ask("上周日我自己实际做了什么事？", "2026-09-17T11:30:00.000Z");
    const experienced = answerRequest();
    expect(experienced.messages.join("\n")).toContain("上周日带我爸去了趟滨江公园。");
    expect(experienced.messages.join("\n")).toContain("大学同屋阿澈");
    expect(experienced.instructions).toContain("when something happened is not recorded");
    expect(guidanceOf(experienced.instructions)).toContain("keep it undated");
    const [first] = await frozenResults();
    expect(first).toMatchObject({
      coverage: { limits: ["experience_time_not_recorded"], timeBasis: "experienced_date" },
      plan: { plan: { readEndDate: "2026-09-17", readStartDate: "2026-09-13", timeBasis: "experienced_date" } },
      status: "partial",
    });

    // The same date asked as "what was said" is a different, verifiable question.
    requests = [];
    review("2026-09-13");
    await ask("上周日那天我跟你说了什么？", "2026-09-17T11:40:00.000Z");
    expect(answerRequest().messages.join("\n")).not.toContain("滨江公园");
    expect(answerRequest().instructions).toContain("2026-09-13: empty");
    expect(guidanceOf(answerRequest().instructions)).toContain("did not find saved messages");
  });

  it("finds yesterday's messages of a conversation that crossed midnight, once", async () => {
    script = { review: null };
    await say("睡前再说一件事，今天的会开得很累。", "2026-09-14T15:50:00.000Z"); // 23:50 on the 14th
    await say("过了零点了，还是睡不着。", "2026-09-14T16:10:00.000Z"); // 00:10 on the 15th, same Session
    requests = [];
    review("2026-09-14");
    await ask("昨天晚上我都说了什么？", "2026-09-14T16:20:00.000Z");
    const outbound = answerRequest().messages;
    expect(outbound.filter((line) => line === "user:睡前再说一件事，今天的会开得很累。")).toHaveLength(1);
    const [result] = await frozenResults();
    // Only the message expressed on the 14th belongs to the asked date.
    expect(result!.coverage.selectedRows).toBe(2);
    expect(answerRequest().instructions).toContain("2026-09-14: complete; 2 message(s) found");
    const sessions = await rows<{ count: string }>("SELECT COUNT(DISTINCT daily_session_id)::text AS count FROM conversation_events");
    expect(sessions[0]!.count).toBe("1");
  });

  it("orders a repeated daylight-saving hour by real instants and bounds a 25-hour day by the zone", async () => {
    const LA = "America/Los_Angeles";
    script = { review: null };
    await say("十月最后一天夜里，还在写东西。", "2026-10-31T23:00:00.000Z", LA);
    await closeSession("2026-11-01T00:30:00.000Z");
    await say("刚过零点，南瓜灯还亮着。", "2026-11-01T07:59:00.000Z", LA); // 00:59 PDT
    await say("现在是第一次的一点一刻。", "2026-11-01T08:15:00.000Z", LA); // 01:15 PDT
    await closeSession("2026-11-01T08:50:00.000Z");
    await say("钟拨回去了，又是一点十分。", "2026-11-01T09:10:00.000Z", LA); // 01:10 PST
    await closeSession("2026-11-01T10:00:00.000Z");
    await say("这一天快结束了，二十三点五十九。", "2026-11-02T07:59:00.000Z", LA); // 23:59 PST on the 1st
    await say("新的一天零点整。", "2026-11-02T08:00:00.000Z", LA); // 00:00 PST on the 2nd
    await closeSession("2026-11-02T09:00:00.000Z");
    requests = [];
    review("2026-11-01");
    await ask("十一月一号那天我都说了什么？", "2026-11-02T18:00:00.000Z", LA);
    const outbound = answerRequest().messages.filter((line) => line.startsWith("user:"));
    expect(outbound.slice(0, 4)).toEqual([
      "user:刚过零点，南瓜灯还亮着。",
      "user:现在是第一次的一点一刻。",
      "user:钟拨回去了，又是一点十分。",
      "user:这一天快结束了，二十三点五十九。",
    ]);
    const joined = answerRequest().messages.join("\n");
    expect(joined).not.toContain("十月最后一天夜里");
    expect(joined).not.toContain("新的一天零点整");
    // The repeated hour is told apart by its GMT offset on the quoted entries.
    expect(answerRequest().instructions).toMatch(/\[\d+\] 01:15 GMT-7, they said:\n> 现在是第一次的一点一刻。/);
    expect(answerRequest().instructions).toMatch(/\[\d+\] 01:10 GMT-8, they said:\n> 钟拨回去了，又是一点十分。/);
  });

  it("includes a message whose request timezone was never kept and marks its time as a fallback", async () => {
    script = { review: null };
    await say("这条是很早以前存下来的，没有时区。", "2026-09-10T12:00:00.000Z");
    await closeSession("2026-09-10T13:00:00.000Z");
    await database.pool.query("UPDATE generation_commands SET request_timezone = NULL");
    requests = [];
    review("2026-09-10");
    await ask("九月十号我说了什么？", "2026-09-15T02:10:00.000Z");
    expect(answerRequest().messages.join("\n")).toContain("这条是很早以前存下来的，没有时区。");
    // No request timezone was kept: the time is marked as the Session-start fallback.
    expect(answerRequest().instructions).toContain(
      "Thursday 10 September 2026 (5 days ago)\n[1] 20:00 (time zone assumed), they said:\n> 这条是很早以前存下来的，没有时区。",
    );
    const [result] = await frozenResults();
    expect(result!.status).toBe("completed");
  });

  it("reproduces the four outcomes with different guidance for the reply", async () => {
    script = { review: null };
    await say("八月二十号路过修鞋摊。", "2026-08-20T10:30:00.000Z");
    await say("回家后决定以后东西坏了先自己补。", "2026-08-20T11:20:00.000Z");
    await closeSession("2026-08-20T14:00:00.000Z");
    const guidance: Record<string, string> = {};

    review("2026-08-20");
    await ask("八月二十号我说了什么？", "2026-09-15T02:00:00.000Z");
    guidance["complete"] = guidanceOf(answerRequest().instructions);

    review("2026-08-25");
    await ask("八月二十五号我说了什么？", "2026-09-15T02:40:00.000Z");
    guidance["empty"] = guidanceOf(answerRequest().instructions);

    built = build({ policy: { ...HISTORY_RECALL_DEFAULT_POLICY, maxPages: 1, pageSize: 1 } });
    review("2026-08-20");
    await ask("八月二十号我说了什么？再看一次", "2026-09-15T03:20:00.000Z");
    guidance["partial"] = guidanceOf(answerRequest().instructions);

    built = build({
      source: () => ({
        async readHistoryRange() {
          return {
            currentConversationRows: 0,
            enumerationComplete: false,
            failure: { code: "source_read_failed" as const },
            items: [],
            pages: 0,
            readLatencyMs: 5,
          };
        },
      }),
    });
    review("2026-08-20");
    await ask("八月二十号我说了什么？最后一次", "2026-09-15T04:00:00.000Z");
    guidance["failed"] = guidanceOf(answerRequest().instructions);

    expect(guidance["complete"]).toContain("(complete)");
    expect(guidance["empty"]).toContain("(nothing found)");
    expect(guidance["partial"]).toContain("(read stopped early)");
    expect(guidance["failed"]).toContain("(lookup failed)");
    expect(new Set(Object.values(guidance)).size).toBe(4);
    for (const text of Object.values(guidance)) {
      expect(text).not.toMatch(/policy|receipt|section|token|coverage|status|database|window/i);
    }
    expect((await frozenResults()).map((row) => row.status)).toEqual([
      "completed",
      "completed",
      "partial",
      "failed",
    ]);
  });

  it("never reads a message that arrived after the request's frozen cutoff", async () => {
    script = { review: null };
    await say("早上先聊了一件事。", "2026-09-14T01:00:00.000Z");
    await closeSession("2026-09-14T02:00:00.000Z");
    await say("下午又聊了一件事。", "2026-09-14T07:00:00.000Z");
    await closeSession("2026-09-14T08:00:00.000Z");
    requests = [];
    built = build({
      source: (inner) => ({
        async readHistoryRange(request) {
          // A message of the asked day lands after the request was accepted.
          await database.pool.query(
            `UPDATE conversation_events SET created_at = $1
             WHERE created_at >= '2026-09-14T06:00:00Z' AND created_at <= '2026-09-14T08:30:00Z'`,
            [new Date(Date.parse(request.plan.cutoff) + 60_000)],
          );
          return inner.readHistoryRange(request);
        },
      }),
    });
    review("2026-09-14");
    // 2026-09-15 02:00Z is already past the day; the late arrival keeps its
    // original session but its instant is after the cutoff, so it is out.
    await ask("昨天都聊了什么？", "2026-09-14T15:00:00.000Z");
    // The frozen result holds the morning pair only; the late arrival is out.
    const [result] = await frozenResults();
    expect(result!.coverage.enumeratedRows).toBe(2);
    expect(result!.item_refs).toHaveLength(2);
    expect(result!.item_refs.every((ref) => ref.expressedAt < "2026-09-14T02:00:00.000Z")).toBe(true);
  });

  it("does not use sources that stopped qualifying on a later page, and blocks after an epoch change", async () => {
    script = { review: null };
    for (const [index, text] of ["第一条，页一。", "第二条，页一。", "第三条，页二。", "第四条，页二。", "第五条，页三。"].entries()) {
      await say(text, `2026-09-14T0${index + 1}:00:00.000Z`);
      await closeSession(`2026-09-14T0${index + 1}:40:00.000Z`);
    }
    requests = [];
    // Correction-like change of a page-one and a page-two row after the read.
    built = build({
      afterAdmit: async () => {
        await database.pool.query(
          `UPDATE conversation_event_revisions SET content_purged_at = $1, canonical_text = ''
           WHERE canonical_text IN ('第一条，页一。', '第四条，页二。')`,
          [now],
        );
      },
      policy: { ...HISTORY_RECALL_DEFAULT_POLICY, maxPages: 6, pageSize: 2 },
    });
    review("2026-09-14");
    await ask("昨天都聊了什么？", "2026-09-14T15:00:00.000Z");
    const messages = answerRequest().messages.join("\n");
    expect(messages).not.toContain("第一条，页一。");
    expect(messages).not.toContain("第四条，页二。");
    for (const kept of ["第二条，页一。", "第三条，页二。", "第五条，页三。"]) {
      expect(messages).toContain(kept);
    }
    expect(answerRequest().instructions).toContain("no_longer_eligible");

    // A data epoch change between the read and the answer stops the answer.
    requests = [];
    built = build({
      afterAdmit: async () => {
        await database.pool.query("UPDATE app_users SET data_epoch = data_epoch + 1");
      },
    });
    review("2026-09-14");
    const events = await say("再看一次昨天。", "2026-09-14T15:30:00.000Z");
    expect(["response_failed", "response_interrupted"]).toContain(terminal(events));
    expect(requests).toHaveLength(1);
  });

  it("reports the read window, page count and omissions through the Inspector without any text", async () => {
    await seedLongDay();
    built = build({ policy: SMALL_BUDGET_POLICY });
    review(LONG_DAY);
    await ask("昨天一整天我都跟你聊了些什么？", "2026-09-15T01:55:00.000Z");
    const decision = (await rows<{ generation_command_id: string }>(
      "SELECT generation_command_id FROM generation_commands WHERE generation_stage = 'decision' ORDER BY created_at DESC LIMIT 1",
    ))[0]!;
    const metadata = await new PostgresInternalInspectionRepository(database.pool).findGenerationMetadata({
      generationCommandId: asGenerationCommandId(decision.generation_command_id),
      userId: OWNER,
    });
    expect(metadata?.historyRecall).toMatchObject({
      coverage: { blocks: 5, blocksCovered: 5, enumerationComplete: true, timeBasis: "expressed_date" },
      plan: { cutoff: "2026-09-15T01:55:00.000Z", readEndDate: LONG_DAY, readStartDate: LONG_DAY },
      policyVersion: HISTORY_RECALL_DEFAULT_POLICY.version,
      status: "partial",
    });
    expect(metadata!.historyRecall!.coverage.pages).toBeGreaterThan(1);
    expect(JSON.stringify(metadata)).not.toContain("牙医");
  });
});
