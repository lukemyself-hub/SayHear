import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createContextCompiler,
  createConversationAgentHarness,
  createConversationResponseService,
  createUserTextConversationService,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  type ConversationResponseStreamEvent,
  type ConversationTextChampion,
  ProviderDispatchError,
  type ConversationTextModel,
  type ConversationTextModelRequest,
  type ConversationTextModelStreamEvent,
} from "@sayhear/application";
import { createProviderEgressPort } from "@sayhear/ai/testing";
import {
  PostgresConversationResponseRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

import { asGenerationCommandId } from "@sayhear/domain";

import { createConversationResponseHandler } from "../../apps/web/src/conversation-response-handler";

/**
 * Request lifecycle (issue #319, ADR-0151): one absolute 30 second deadline,
 * a newer user message that retires an older answer, and settlement of every
 * attempt. The model is the only substituted part; the BFF handler, Service,
 * Harness, Egress, Context Compiler and PostgreSQL run for real.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required; the system seam never falls back to a mock database.",
  );
}

const T0 = Date.parse("2026-09-12T16:00:00.000Z");

const champion: ConversationTextChampion = Object.freeze({
  configVersion: "conversation-text-champion:v1",
  consentPolicyVersion: null,
  contextLimit: 1_000_000,
  dataRegion: "test",
  model: "gpt-5.4",
  provider: "openai",
  providerPolicyVersion: "openai-conversation-text:v1",
  retentionMode: "store-disabled",
  snapshot: "gpt-5.4",
  streaming: true,
  supportedLocales: Object.freeze(["en", "zh"]),
  trainingPolicy: "test",
});

const generationPolicy = Object.freeze({
  consentPolicyVersion: null,
  freshnessPolicy: "source_valid:v1" as const,
  chineseLocalePackVersion: "locale-pack-zh:v1",
  englishLocalePackVersion: "locale-pack-en:v1",
  harnessPolicyVersion: "conversation-harness:v1",
  conversationActionCatalogVersion: "conversation-action-catalog:empty:v1",
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

const completed = (outputTokens = 3): ConversationTextModelStreamEvent => ({
  costMicros: null,
  finishReason: "completed",
  inputTokens: 5,
  modelSnapshot: "gpt-5.4",
  outputTokens,
  providerRequestId: null,
  type: "completed",
});

type Script = (input: {
  onUsage: ConversationTextModelRequest["onUsage"];
  signal: AbortSignal | undefined;
  text: string;
}) => AsyncIterable<ConversationTextModelStreamEvent>;

function lastUserText(
  messages: readonly Readonly<{ role: string; text: string }>[],
): string {
  return messages.at(-1)?.text ?? "";
}

describe("Conversation request lifecycle — deadline, supersession and settlement (issue #319)", () => {
  let database: IsolatedPostgresSchema;
  let responseRepository: PostgresConversationResponseRepository;
  let now = T0;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "test-owner",
      userId: fixedInternalOwnerPrincipal.userId,
    });
    responseRepository = new PostgresConversationResponseRepository(database.pool);
  }, 20_000);

  beforeEach(async () => {
    now = T0;
    await database.pool.query(`
      TRUNCATE TABLE daily_sessions, interaction_turns, conversation_events,
        conversation_event_revisions, generation_commands, model_run_attempts,
        provider_egress_dispositions, compiled_contexts CASCADE
    `);
    await database.pool.query("DELETE FROM backup_policy_versions");
    await database.pool.query("UPDATE app_users SET status = 'active', data_epoch = 1");
    await database.pool.query("UPDATE provider_egress_policy_versions SET status = 'active'");
    await new PostgresInternalOwnerAccessRepository(database.pool).recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: "sha256:expected",
      databaseRetentionDays: 30,
      evidenceReference: "synthetic backup console evidence",
      policyVersion: "neon-production-v1",
      pitrRetentionDays: 7,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2027-09-12T16:00:00.000Z"),
      verifiedAt: new Date("2026-09-12T15:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  function createApp(
    script: Script,
    options: {
      commitFault?: () => Error | null;
      requestBudgetMs?: number;
    } = {},
  ) {
    const clock = () => new Date(now);
    // Optionally make the acceptance commit fail after the Provider succeeded.
    const harnessRepository = new Proxy(responseRepository, {
      get(target, property, receiver) {
        if (property === "commitCompleteResponse" && options.commitFault) {
          return async (...args: unknown[]) => {
            const fault = options.commitFault?.();
            if (fault) throw fault;
            return (target.commitCompleteResponse as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const contextCompiler = createContextCompiler({
      clock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    const model: ConversationTextModel = {
      stream: (request) =>
        script({
          onUsage: request.onUsage,
          signal: request.signal,
          text: lastUserText(request.messages),
        }),
    };
    const conversationService = createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const service = createConversationResponseService({
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock,
      contextCompiler,
      conversationService,
      harness: createConversationAgentHarness({
        clock,
        delay: async () => undefined,
        onUnexpectedFailure: (failure) => console.log("UNEXPECTED", JSON.stringify(failure)),
        egressPort: createProviderEgressPort({
          champion,
          clock,
          contextCompiler,
          model,
          repository: responseRepository,
        }),
        repository: harnessRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      ...(options.requestBudgetMs === undefined
        ? {}
        : { requestBudgetMs: options.requestBudgetMs }),
      repository: responseRepository,
    });
    return { conversationService, service };
  }

  async function chat(
    service: ReturnType<typeof createApp>["service"],
    key: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<readonly ConversationResponseStreamEvent[]> {
    const events: ConversationResponseStreamEvent[] = [];
    for await (const event of service.respond(
      fixedInternalOwnerPrincipal.userId,
      {
        clientEventId: `${key}-event`,
        clientTurnId: `${key}-turn`,
        locale: "en-US",
        text,
        timezone: "America/Denver",
      },
      signal,
    )) {
      events.push(event);
    }
    return events;
  }

  async function assistantTexts(): Promise<string[]> {
    const rows = await database.pool.query<{ text: string }>(`
      SELECT revision.canonical_text AS text
      FROM conversation_events event
      INNER JOIN conversation_event_revisions revision
        ON revision.conversation_event_id = event.conversation_event_id
      WHERE event.actor = 'assistant'
      ORDER BY event.sequence_no
    `);
    return rows.rows.map((row) => row.text);
  }

  async function commandStates(): Promise<
    Array<{ attempt: string; category: string | null; command: string }>
  > {
    const rows = await database.pool.query<{
      attempt: string;
      category: string | null;
      command: string;
    }>(`
      SELECT command.status AS command, attempt.status AS attempt,
             attempt.error_category AS category
      FROM generation_commands command
      INNER JOIN model_run_attempts attempt
        ON attempt.generation_command_id = command.generation_command_id
      INNER JOIN interaction_turns turn
        ON turn.interaction_turn_id = command.interaction_turn_id
      ORDER BY turn.turn_sequence_no, attempt.attempt_no
    `);
    return rows.rows;
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("ends a stuck request at its deadline with a timeout, never commits the late result and leaves nothing running", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service } = createApp(
      async function* () {
        // Ignores cancellation entirely, like a Provider connection that hangs.
        await gate;
        yield { delta: "a very late answer", type: "delta" };
        yield completed();
      },
      { requestBudgetMs: 400 },
    );
    const started = performance.now();
    const events = await chat(service, "slow", "Tell me about yesterday.");
    const elapsed = performance.now() - started;
    release();
    await wait(300);

    expect(events.map((event) => event.type)).toEqual([
      "user_committed",
      "response_failed",
    ]);
    expect(events.at(-1)).toEqual({ category: "timeout", type: "response_failed" });
    expect(elapsed).toBeLessThan(2_000);
    expect(await assistantTexts()).toEqual([]);
    expect(await commandStates()).toEqual([
      { attempt: "failed", category: "timeout", command: "failed" },
    ]);
  });

  it("refuses at the database to accept an answer whose frozen deadline has passed", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service } = createApp(
      async function* () {
        await gate;
        yield { delta: "answer", type: "delta" };
        yield completed();
      },
      { requestBudgetMs: 30_000 },
    );
    const running = chat(service, "fence", "Question");
    await wait(300);
    const command = await database.pool.query<{
      generation_command_id: string;
      model_run_attempt_id: string;
      request_deadline_at: Date | null;
    }>(`
      SELECT command.generation_command_id, attempt.model_run_attempt_id,
             command.request_deadline_at
      FROM generation_commands command
      INNER JOIN model_run_attempts attempt
        ON attempt.generation_command_id = command.generation_command_id
    `);
    expect(command.rows[0]?.request_deadline_at?.toISOString()).toBe(
      new Date(T0 + 30_000).toISOString(),
    );
    const late = await responseRepository.commitCompleteResponse({
      completedAt: new Date(T0 + 31_000),
      generationCommandId: asGenerationCommandId(command.rows[0]!.generation_command_id),
      metadata: {
        costMicros: null,
        finishReason: "completed",
        inputTokens: 5,
        modelSnapshot: "gpt-5.4",
        outputTokens: 3,
        providerRequestId: null,
      },
      modelRunAttemptId: command.rows[0]!.model_run_attempt_id as never,
      text: "too late",
      userId: fixedInternalOwnerPrincipal.userId,
    });
    expect(late).toEqual({ outcome: "fence_rejected", reason: "deadline_exceeded" });
    release();
    await running;
    expect(await assistantTexts()).not.toContain("too late");
  });

  it("retires an older answer in progress when a newer message is accepted, even on another instance", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = createApp(async function* ({ text }) {
      if (text.includes("kayak")) {
        await gate; // does not honour the abort signal
        yield { delta: "stale kayak answer", type: "delta" };
        yield completed();
        return;
      }
      yield { delta: `fresh answer to: ${text}`, type: "delta" };
      yield completed();
    });
    const other = createApp(async function* ({ text }) {
      yield { delta: `fresh answer to: ${text}`, type: "delta" };
      yield completed();
    });
    const first = chat(slow.service, "one", "Tell me about the kayak trip.");
    await wait(300);
    const second = await chat(other.service, "two", "Never mind, the lease is on my mind.");
    expect(second.at(-1)?.type).toBe("assistant_committed");
    release();
    const firstEvents = await first;

    expect(firstEvents.map((event) => event.type)).not.toContain("assistant_committed");
    // The retired answer never reaches the screen either.
    expect(firstEvents.map((event) => event.type)).not.toContain("assistant_delta");
    expect(firstEvents.at(-1)?.type).toBe("response_failed");
    expect(await assistantTexts()).toEqual([
      "fresh answer to: Never mind, the lease is on my mind.",
    ]);
    expect((await commandStates()).map((state) => state.command)).toEqual([
      "failed",
      "succeeded",
    ]);
  });

  it("cancels the older in-flight call at once when the same instance accepts a newer message", async () => {
    let sawAbort = false;
    const { service } = createApp(async function* ({ signal, text }) {
      if (text.includes("kayak")) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            sawAbort = true;
            resolve();
          });
        });
        return;
      }
      yield { delta: "ok", type: "delta" };
      yield completed();
    });
    const first = chat(service, "one", "Tell me about the kayak trip.");
    await wait(300);
    const second = await chat(service, "two", "Actually, something else.");
    await first;
    expect(JSON.stringify(second.map((event) => [event.type, "category" in event ? event.category : null]))).toContain("assistant_committed");
    expect(sawAbort).toBe(true);
    expect(await assistantTexts()).toEqual(["ok"]);
  });

  it("does not resume a stale command after its deadline when the recovery scan finds it", async () => {
    let calls = 0;
    const { conversationService, service } = createApp(
      async function* () {
        calls += 1;
        yield { delta: "resumed late", type: "delta" };
        yield completed();
      },
      { requestBudgetMs: 30_000 },
    );
    // A request was accepted (its deadline frozen) and the process then died.
    await conversationService.submit(
      fixedInternalOwnerPrincipal.userId,
      {
        clientEventId: "crash-event",
        clientTurnId: "crash-turn",
        locale: "en-US",
        text: "Are you there?",
        timezone: "America/Denver",
      },
      { requestDeadlineAt: new Date(T0 + 30_000) },
    );
    now = T0 + 10 * 60_000;
    await service.scanStaleResponses();
    expect(calls).toBe(0);
    expect(await assistantTexts()).toEqual([]);
    expect((await commandStates())[0]).toMatchObject({ command: "failed", category: "timeout" });
  });

  it("keeps the spend the Provider reported even when the call then fails, and records the reasoning split on success", async () => {
    const failing = createApp(async function* ({ onUsage }) {
      onUsage?.({
        cachedTokens: null,
        inputTokens: 6_430,
        outputTokens: 11_919,
        reasoningTokens: 11_000,
        totalTokens: null,
      });
      yield* [];
      throw new ProviderDispatchError("authentication");
    });
    await chat(failing.service, "fail", "first question");
    const succeeding = createApp(async function* () {
      yield { delta: "fine", type: "delta" };
      yield { ...(completed() as object), reasoningTokens: 7, totalTokens: 15 } as ConversationTextModelStreamEvent;
    });
    await chat(succeeding.service, "ok", "second question");
    const rows = await database.pool.query<{
      input_tokens: string | null;
      output_tokens: string | null;
      reasoning_tokens: string | null;
      status: string;
      total_tokens: string | null;
    }>(`
      SELECT attempt.status, attempt.input_tokens, attempt.output_tokens,
             attempt.reasoning_tokens, attempt.total_tokens
      FROM model_run_attempts attempt
      INNER JOIN generation_commands command
        ON command.generation_command_id = attempt.generation_command_id
      INNER JOIN interaction_turns turn
        ON turn.interaction_turn_id = command.interaction_turn_id
      ORDER BY turn.turn_sequence_no
    `);
    expect(rows.rows).toEqual([
      // Billed but failed: the reported spend survives; the unreported total is unknown, not zero.
      { input_tokens: "6430", output_tokens: "11919", reasoning_tokens: "11000", status: "failed", total_tokens: null },
      { input_tokens: "5", output_tokens: "3", reasoning_tokens: "7", status: "succeeded", total_tokens: "15" },
    ]);
  });

  it("settles the attempt and its spend when the Provider succeeded but the database commit failed, and a resend yields one answer", async () => {
    let failCommit = true;
    const { service } = createApp(
      async function* () {
        yield { delta: "an answer", type: "delta" };
        yield completed(9);
      },
      {
        commitFault: () =>
          failCommit
            ? Object.assign(new Error("connection terminated"), { code: "08006" })
            : null,
      },
    );
    const first = await chat(service, "commit-fault", "hello there");
    expect(first.at(-1)).toEqual({ category: "unknown", type: "response_interrupted" });
    // Nothing is left running; the Provider's spend is on the ledger.
    expect(await commandStates()).toEqual([
      { attempt: "result_unknown", category: "unknown", command: "interrupted" },
    ]);
    const spend = await database.pool.query<{ output_tokens: string | null }>(
      "SELECT output_tokens FROM model_run_attempts",
    );
    expect(spend.rows[0]?.output_tokens).toBe("9");
    expect(await assistantTexts()).toEqual([]);

    // The person (or a reconnecting client) sends the same message again: it
    // resolves to the original turn and still never makes two answers.
    failCommit = false;
    await chat(service, "commit-fault", "hello there");
    await chat(service, "commit-fault", "hello there");
    expect((await assistantTexts()).length).toBeLessThanOrEqual(1);
  });

  it("serves the BFF boundary: the stream closes with a timeout even if the service never ends", async () => {
    const hung = {
      async *respond() {
        await new Promise(() => undefined);
        yield* [] as ConversationResponseStreamEvent[];
      },
      async *retry() {
        yield* [] as ConversationResponseStreamEvent[];
      },
      async scanStaleResponses() {
        return { committed: 0, interrupted: 0, processed: 0, retried: 0, terminal: 0 };
      },
    };
    const handler = createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      requestBudgetMs: 300,
      service: hung,
    });
    const started = performance.now();
    const response = await handler(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify({
          clientEventId: "e",
          clientTurnId: "t",
          locale: "en-US",
          text: "hello",
          timezone: "America/Denver",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const body = await response.text();
    expect(JSON.parse(body.trim())).toEqual({ category: "timeout", type: "response_failed" });
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
