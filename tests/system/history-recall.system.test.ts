import { randomBytes } from "node:crypto";

import type { Pool } from "pg";
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

/**
 * Issue #314: the controlled read-only history review, end to end through the
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
      messages: request.messages.map((message) => `${message.role}:${message.text}`),
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
  /** The pool the history repository commits through (fault injection). */
  historyRepositoryPool?: Pool;
  /** End-to-end request budget (ADR-0151); unset keeps the request unbounded. */
  requestBudgetMs?: number;
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
    repository: new PostgresHistoryRecallRepository(
      overrides.historyRepositoryPool ?? database.pool,
    ),
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
    ...(overrides.requestBudgetMs ? { requestBudgetMs: overrides.requestBudgetMs } : {}),
    repository: responseRepository,
  });
  const exchange = createContinuousExchangeService({
    clock,
    repository: new PostgresContinuousExchangeRepository(database.pool),
  });
  return { exchange, harness, historyRecall, responseRepository, service };
}

async function say(text: string, at: string): Promise<ConversationResponseStreamEvent[]> {
  now = iso(at);
  counter += 1;
  const events: ConversationResponseStreamEvent[] = [];
  for await (const event of built.service.respond(OWNER, {
    clientEventId: `h-event-${counter}`,
    clientTurnId: `h-turn-${counter}`,
    locale: "zh-CN",
    text,
    timezone: ZONE,
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

/** Seed one exchange per day, each in its own Daily Session. */
async function seedHistory(): Promise<void> {
  script = { review: null };
  await say("奥斯陆的雨下得人心烦。", "2026-08-19T12:10:00.000Z"); // 08-19 20:10 +08
  await closeSession("2026-08-19T14:00:00.000Z");
  await say("路过修鞋摊，师傅教我缝了帆布包。", "2026-08-20T10:30:00.000Z"); // 18:30
  await say("回家后决定以后东西坏了先自己补。", "2026-08-20T11:20:00.000Z"); // 19:20
  await closeSession("2026-08-20T14:00:00.000Z");
  await say("把阳台的茉莉挪到了太阳底下。", "2026-08-21T12:40:00.000Z"); // 08-21 20:40
  await closeSession("2026-08-21T14:00:00.000Z");
  requests = [];
  sourceReads = 0;
}

const ASK_AT = "2026-09-15T02:10:00.000Z";

async function ask(text = "八月二十号那天我跟你说了什么？") {
  script = { review: { start_date: "2026-08-20" } };
  return say(text, ASK_AT);
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

describe("controlled history review through the real conversation path", () => {
  it("answers an explicit older date from its original messages as one reply and settles both commands", async () => {
    await seedHistory();
    const events = await ask();

    expect(terminal(events)).toBe("assistant_committed");
    expect(events.filter((event) => event.type === "assistant_committed")).toHaveLength(1);
    expect(assistantText(events)).toBe("我看了那天你说的。");

    // Stage one: the Decision was offered the review function and chose it.
    expect(requests).toHaveLength(2);
    expect(requests[0]!.functionNames).toContain(HISTORY_REVIEW_FUNCTION_NAME);
    expect(requests[0]!.toolsDisabled).toBe(false);
    // Stage two: tools off, the original messages of that date and only that
    // date, with roles and the expression times in the signed time context.
    const answer = requests[1]!;
    expect(answer.toolsDisabled).toBe(true);
    expect(answer.functionNames).toEqual([]);
    expect(answer.messages.slice(0, 4)).toEqual([
      "user:路过修鞋摊，师傅教我缝了帆布包。",
      "assistant:我看了那天你说的。",
      "user:回家后决定以后东西坏了先自己补。",
      "assistant:我看了那天你说的。",
    ]);
    const outbound = answer.messages.join("\n") + answer.instructions;
    expect(outbound).not.toContain("奥斯陆的雨");
    expect(outbound).not.toContain("茉莉");
    expect(answer.instructions).toContain("1=2026-08-20 18:30:00 GMT+8");
    expect(answer.instructions).toContain("3=2026-08-20 19:20:00 GMT+8");
    expect(answer.instructions).toContain("History review result");

    // Exactly two commands for the turn; neither is left running.
    const commands = await rows<{ generation_stage: string; status: string; settled_at: Date | null; authoritative_result_id: string | null }>(
      `SELECT command.generation_stage, command.status, command.settled_at, command.authoritative_result_id
       FROM generation_commands command
       INNER JOIN interaction_turns turn ON turn.interaction_turn_id = command.interaction_turn_id
       WHERE command.created_at >= $1 AND command.user_id = $2
       ORDER BY command.created_at, command.generation_stage`,
      [iso(ASK_AT), OWNER],
    );
    expect(commands.map((row) => [row.generation_stage, row.status])).toEqual([
      ["decision", "succeeded"],
      ["history_answer", "succeeded"],
    ]);
    const attempts = await rows<{ status: string }>(
      `SELECT attempt.status FROM model_run_attempts attempt
       INNER JOIN generation_commands command ON command.generation_command_id = attempt.generation_command_id
       WHERE command.generation_stage IN ('decision', 'history_answer')
         AND command.created_at >= $1`,
      [iso(ASK_AT)],
    );
    expect(attempts.map((row) => row.status)).toEqual(["succeeded", "succeeded"]);

    // One Assistant Event for the turn, produced by the History Answer command.
    const assistantEvents = await rows<{ generation_stage: string }>(
      `SELECT command.generation_stage
       FROM conversation_events event
       INNER JOIN generation_commands command ON command.generation_command_id = event.generation_command_id
       WHERE event.actor = 'assistant' AND event.created_at >= $1`,
      [iso(ASK_AT)],
    );
    expect(assistantEvents).toEqual([{ generation_stage: "history_answer" }]);

    // The frozen result is content free: references, coverage and plan only.
    const [result] = await rows<{ status: string; coverage: { selectedRows: number; perDate: unknown[] }; item_refs: unknown[] }>(
      "SELECT status, coverage, item_refs FROM history_recall_results",
    );
    expect(result).toMatchObject({ status: "completed", coverage: { selectedRows: 4 } });
    expect(JSON.stringify(result)).not.toContain("修鞋");
  });

  it("keeps an ordinary reply a single command with no history query", async () => {
    await seedHistory();
    script = { review: null };
    const events = await say("今天地铁有点挤。", ASK_AT);
    expect(terminal(events)).toBe("assistant_committed");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.toolsDisabled).toBe(false);
    expect(await rows("SELECT 1 FROM history_recall_results")).toHaveLength(0);
    const stages = await rows<{ generation_stage: string }>(
      "SELECT generation_stage FROM generation_commands WHERE created_at >= $1",
      [iso(ASK_AT)],
    );
    expect(stages).toEqual([{ generation_stage: "decision" }]);
  });

  it("retries the answer stage technically without re-reading history or committing twice", async () => {
    await seedHistory();
    answerFailuresLeft = 1;
    const events = await ask();
    expect(terminal(events)).toBe("assistant_committed");
    expect(sourceReads).toBe(1);
    const attempts = await rows<{ attempt_no: number; status: string }>(
      `SELECT attempt.attempt_no, attempt.status FROM model_run_attempts attempt
       INNER JOIN generation_commands command ON command.generation_command_id = attempt.generation_command_id
       WHERE command.generation_stage = 'history_answer' ORDER BY attempt.attempt_no`,
    );
    expect(attempts.map((row) => row.status)).toEqual(["failed", "succeeded"]);
    expect(
      await rows("SELECT 1 FROM conversation_events WHERE actor = 'assistant' AND created_at >= $1", [iso(ASK_AT)]),
    ).toHaveLength(1);
  });

  it("does not duplicate the Assistant Event when the same stage is dispatched again", async () => {
    await seedHistory();
    await ask();
    expect(await built.service.scanPendingHistoryAnswers?.()).toBe(0);
    const [answer] = await rows<{ generation_command_id: string; interaction_turn_id: string; user_id: string; input_revision_id: string }>(
      "SELECT generation_command_id, interaction_turn_id, user_id, input_revision_id FROM generation_commands WHERE generation_stage = 'history_answer'",
    );
    const [attempt] = await rows<{ model_run_attempt_id: string }>(
      "SELECT model_run_attempt_id FROM model_run_attempts WHERE generation_command_id = $1",
      [answer!.generation_command_id],
    );
    const before = requests.length;
    const replay: string[] = [];
    for await (const event of built.harness.runHistoryAnswerCommand!(
      {
        generationCommandId: asGenerationCommandId(answer!.generation_command_id),
        interactionTurnId: answer!.interaction_turn_id as never,
        modelRunAttemptId: attempt!.model_run_attempt_id as never,
        requestEventRevisionId: answer!.input_revision_id as never,
        userId: OWNER,
      },
      { catalog: EMPTY_CONVERSATION_ACTION_CATALOG, harnessPolicy: { ...HISTORY_RECALL_CONVERSATION_HARNESS_POLICY, toolsDisabled: true } },
    )) {
      replay.push(event.type);
    }
    expect(replay).toContain("decision_committed");
    expect(requests.length).toBe(before);
    expect(
      await rows("SELECT 1 FROM conversation_events WHERE actor = 'assistant' AND created_at >= $1", [iso(ASK_AT)]),
    ).toHaveLength(1);
  });

  it("reports an empty date range as empty, sends no old text, and still answers", async () => {
    await seedHistory();
    script = { review: { start_date: "2026-08-25" } };
    const events = await say("八月二十五号我说了什么？", ASK_AT);
    expect(terminal(events)).toBe("assistant_committed");
    const answer = requests[1]!;
    expect(answer.messages).toEqual(["user:八月二十五号我说了什么？"]);
    expect(answer.instructions).toContain("2026-08-25: empty; 0 message(s) found");
    const [result] = await rows<{ status: string }>("SELECT status FROM history_recall_results");
    expect(result!.status).toBe("completed");
  });

  it("marks a read that cannot be exhausted as partial and says so", async () => {
    await seedHistory();
    built = build({ policy: { ...HISTORY_RECALL_DEFAULT_POLICY, maxPages: 1, pageSize: 1 } });
    const events = await ask();
    expect(terminal(events)).toBe("assistant_committed");
    const answer = requests[1]!;
    expect(answer.messages[0]).toBe("user:路过修鞋摊，师傅教我缝了帆布包。");
    expect(answer.instructions).toContain("Read status: partial");
    const [result] = await rows<{ status: string; coverage: { enumerationComplete: boolean } }>("SELECT status, coverage FROM history_recall_results");
    expect(result).toMatchObject({ status: "partial", coverage: { enumerationComplete: false } });
  });

  it("answers honestly and sends no history when the source read fails", async () => {
    await seedHistory();
    built = build({
      source: () => ({
        async readHistoryRange() {
          return {
            currentConversationRows: 0,
            enumerationComplete: false,
            failure: { code: "source_read_timeout" as const },
            items: [],
            pages: 0,
            readLatencyMs: 2_000,
          };
        },
      }),
    });
    const events = await ask();
    expect(terminal(events)).toBe("assistant_committed");
    const answer = requests[1]!;
    expect(answer.messages).toEqual(["user:八月二十号那天我跟你说了什么？"]);
    expect(answer.instructions).toContain("Read status: failed (source_read_timeout)");
    const [result] = await rows<{ status: string; failure_code: string }>("SELECT status, failure_code FROM history_recall_results");
    expect(result).toEqual({ failure_code: "source_read_timeout", status: "failed" });
  });

  it("fails closed for a Decision that is not this owner's and creates nothing", async () => {
    await seedHistory();
    await ask();
    const [decision] = await rows<{ generation_command_id: string }>(
      "SELECT generation_command_id FROM generation_commands WHERE generation_stage = 'decision' ORDER BY created_at DESC LIMIT 1",
    );
    const before = await rows<{ count: string }>("SELECT COUNT(*)::text AS count FROM generation_commands");
    const receipt = await built.historyRecall.admit({
      context: {
        decisionCommandId: asGenerationCommandId(decision!.generation_command_id),
        modelRunAttemptId: "01984477-31e1-7595-92c6-06889cb0fde0" as never,
        requestEventRevisionId: "01984477-31e1-7595-92c6-06889cb0fde1" as never,
        userId: asUserId(uuidV7(now)),
      },
      proposal: { endDate: "2026-08-20", kind: "review_dates", sourceScope: "conversation_text", startDate: "2026-08-20", timeBasis: "expressed_date" },
    });
    expect(receipt).toEqual({ outcome: "fence_rejected" });
    expect(await rows<{ count: string }>("SELECT COUNT(*)::text AS count FROM generation_commands")).toEqual(before);
  });

  async function seedForgetExclusion(revisionText: string): Promise<void> {
    const [revision] = await rows<{ conversation_event_revision_id: string; conversation_event_id: string; daily_session_id: string; sequence_no: string }>(
      `SELECT revision.conversation_event_revision_id::text, revision.conversation_event_id::text,
              event.daily_session_id::text, event.sequence_no::text
       FROM conversation_event_revisions revision
       INNER JOIN conversation_events event ON event.conversation_event_id = revision.conversation_event_id
       WHERE revision.canonical_text = $1`,
      [revisionText],
    );
    const snapshotId = uuidV7(now);
    const itemId = uuidV7(now);
    await database.pool.query(
      `INSERT INTO evidence_source_snapshots (
         evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
         extraction_policy_version, command_id, attempt_id, champion_config_version,
         champion_provider, champion_model, champion_snapshot,
         champion_provider_policy_version, created_at
       ) VALUES ($1, $2, $3, $4, 'evidence-extraction:v2', 'seed', 'seed', 'test', 'openai', 'test', 'test', 'test', $5)`,
      [snapshotId, OWNER, revision!.daily_session_id, revision!.sequence_no, now],
    );
    await database.pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
         source_revision_id, source_actor, source_status, locator_type,
         locator_key, extraction_policy_version, evidence_role, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision', $6, 'evidence-extraction:v2', 'factual_support', $7)`,
      [itemId, OWNER, snapshotId, revision!.conversation_event_id, revision!.conversation_event_revision_id, `revision:${revision!.conversation_event_revision_id}`, now],
    );
    const forgetRequestId = uuidV7(now);
    await database.pool.query(
      `INSERT INTO memory_forget_requests (
         memory_forget_request_id, user_id, request_event_revision_id,
         target_claim_id, target_scope, canonical_side, qualifier_key,
         qualifier_typed_value, status, applied_claim_version_id,
         forget_policy_version, created_at
       ) VALUES ($1, $2, $3, NULL, 'whole_claim', NULL, NULL, NULL, 'pending_scope', NULL, 'memory-forget:v1', $4)`,
      [forgetRequestId, OWNER, revision!.conversation_event_revision_id, now],
    );
    await database.pool.query(
      `INSERT INTO memory_forget_evidence_exclusions (
         memory_forget_evidence_exclusion_id, user_id, memory_forget_request_id,
         evidence_item_id, exclusion_scope, canonical_side, qualifier_key, status, created_at
       ) VALUES ($1, $2, $3, $4, 'whole_claim', NULL, NULL, 'active', $5)`,
      [uuidV7(now), OWNER, forgetRequestId, itemId, now],
    );
  }

  it("never sends a source with an explicit Forget association, nor the reply generated for it", async () => {
    await seedHistory();
    await seedForgetExclusion("路过修鞋摊，师傅教我缝了帆布包。");
    const events = await ask();
    expect(terminal(events)).toBe("assistant_committed");
    const answer = requests[1]!;
    expect(answer.messages).toEqual([
      "user:回家后决定以后东西坏了先自己补。",
      "assistant:我看了那天你说的。",
      "user:八月二十号那天我跟你说了什么？",
    ]);
    expect(answer.messages.join("")).not.toContain("修鞋摊");
    const [result] = await rows<{ coverage: { omitted: Record<string, number> } }>("SELECT coverage FROM history_recall_results");
    expect(result!.coverage.omitted).toEqual({ forget_association: 2 });
  });

  it("tells the reply a day with only forgotten messages has nothing to quote, without exposing the Forget", async () => {
    await seedHistory();
    await seedForgetExclusion("路过修鞋摊，师傅教我缝了帆布包。");
    await seedForgetExclusion("回家后决定以后东西坏了先自己补。");
    const events = await ask();
    expect(terminal(events)).toBe("assistant_committed");
    const answer = requests[1]!;
    expect(answer.messages).toEqual(["user:八月二十号那天我跟你说了什么？"]);
    expect(answer.instructions).toContain("2026-08-20: empty; 0 message(s) found, 0 quoted.");
    expect(answer.instructions).toContain("did not find saved messages from that date");
    expect(answer.instructions).not.toMatch(/forget|_association|Not quoted|every saved message/i);
    // The operator still sees why: the reason lives only in the frozen result.
    const [result] = await rows<{ coverage: { omitted: Record<string, number> }; status: string }>("SELECT coverage, status FROM history_recall_results");
    expect(result!.status).toBe("completed");
    expect(result!.coverage.omitted).toEqual({ forget_association: 4 });
  });

  it("retries the freeze transaction when PostgreSQL aborts it for a serialization conflict", async () => {
    await seedHistory();
    // A concurrent writer wins once: the first attempt to freeze the result
    // is aborted with SQLSTATE 40001 after it began.
    let conflicts = 1;
    const flaky = new Proxy(database.pool, {
      get(target, property) {
        if (property !== "connect") {
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(inner, key) {
              if (key !== "query") {
                const value = Reflect.get(inner, key) as unknown;
                return typeof value === "function" ? value.bind(inner) : value;
              }
              return (sql: unknown, ...rest: unknown[]) => {
                if (conflicts > 0 && typeof sql === "string" && sql.includes("INSERT INTO history_recall_results")) {
                  conflicts -= 1;
                  return Promise.reject(Object.assign(new Error("could not serialize access"), { code: "40001" }));
                }
                return (inner.query as (...args: unknown[]) => unknown)(sql, ...rest);
              };
            },
          });
        };
      },
    }) as Pool;
    built = build({ historyRepositoryPool: flaky });
    const events = await ask();
    expect(terminal(events)).toBe("assistant_committed");
    expect(conflicts).toBe(0);
    // Frozen exactly once, with exactly one answer command.
    expect(await rows("SELECT 1 FROM history_recall_results")).toHaveLength(1);
    expect(await rows("SELECT 1 FROM generation_commands WHERE generation_stage = 'history_answer'")).toHaveLength(1);
  });

  it("stops waiting for a stalled lookup when the request deadline arrives, and a late finish cannot commit", async () => {
    await seedHistory();
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    built = build({
      requestBudgetMs: 300,
      source: (inner) => ({
        async readHistoryRange(request) {
          await stalled;
          return inner.readHistoryRange(request);
        },
      }),
    });
    const events = await ask();
    // The Decision's own model call had finished, so the settlement is an
    // interruption, never a reply.
    expect(["response_failed", "response_interrupted"]).toContain(terminal(events));
    expect(assistantText(events)).toBe("");
    expect(requests.filter((request) => request.toolsDisabled)).toHaveLength(0);

    // The stalled read finally returns: the Decision was already settled, so
    // the fence refuses to freeze a result or start an answer.
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await rows("SELECT 1 FROM history_recall_results")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM generation_commands WHERE generation_stage = 'history_answer'")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM conversation_events WHERE actor = 'assistant' AND created_at >= $1", [iso(ASK_AT)])).toHaveLength(0);
  });

  it("drops a source that stopped qualifying between the query and the compile", async () => {
    await seedHistory();
    built = build({
      afterAdmit: async () => {
        await database.pool.query(
          `UPDATE conversation_event_revisions SET content_purged_at = $1, canonical_text = ''
           WHERE canonical_text = '回家后决定以后东西坏了先自己补。'`,
          [now],
        );
      },
    });
    const events = await ask();
    expect(terminal(events)).toBe("assistant_committed");
    const outbound = requests[1]!.messages.join("\n");
    expect(outbound).toContain("修鞋摊");
    expect(outbound).not.toContain("先自己补");
    expect(requests[1]!.instructions).toContain("no_longer_eligible x2");
  });

  it("blocks dispatch with zero outbound and zero acceptance when a source is invalidated after compile", async () => {
    await seedHistory();
    let armed = false;
    built = build({
      // Arm only after the Decision query, so the next compile is the answer.
      afterAdmit: async () => {
        armed = true;
      },
      afterCompile: async () => {
        if (!armed) return;
        armed = false;
        await database.pool.query(
          `UPDATE conversation_event_revisions SET content_purged_at = $1, canonical_text = ''
           WHERE canonical_text = '路过修鞋摊，师傅教我缝了帆布包。'`,
          [now],
        );
      },
    });
    const events = await ask();
    expect(["response_failed", "response_interrupted"]).toContain(terminal(events));
    // The Decision request left; the answer request never did.
    expect(requests).toHaveLength(1);
    expect(
      await rows("SELECT 1 FROM conversation_events WHERE actor = 'assistant' AND created_at >= $1", [iso(ASK_AT)]),
    ).toHaveLength(0);
  });

  it("exposes the branch, coverage and sources through the controlled Inspector without any text", async () => {
    await seedHistory();
    const events = await ask();
    expect(terminal(events)).toBe("assistant_committed");
    const decision = (await rows<{ generation_command_id: string }>(
      "SELECT generation_command_id FROM generation_commands WHERE generation_stage = 'decision' ORDER BY created_at DESC LIMIT 1",
    ))[0]!;
    const inspection = new PostgresInternalInspectionRepository(database.pool);
    const metadata = await inspection.findGenerationMetadata({
      generationCommandId: asGenerationCommandId(decision.generation_command_id),
      userId: OWNER,
    });
    expect(metadata?.generationStage).toBe("decision");
    expect(metadata?.historyRecall).toMatchObject({
      role: "decision",
      status: "completed",
      plan: { startDate: "2026-08-20", timezone: ZONE },
      coverage: { selectedRows: 4, enumerationComplete: true },
    });
    expect(metadata?.historyRecall?.sources).toHaveLength(4);
    const answerMetadata = await inspection.findGenerationMetadata({
      generationCommandId: asGenerationCommandId(metadata!.historyRecall!.answerCommandId),
      userId: OWNER,
    });
    expect(answerMetadata?.generationStage).toBe("history_answer");
    expect(answerMetadata?.compiledContext.referencedEvents.filter((event) => event.section === "history_recall_context")).toHaveLength(4);
    expect(JSON.stringify(metadata)).not.toContain("修鞋");
  });
});
