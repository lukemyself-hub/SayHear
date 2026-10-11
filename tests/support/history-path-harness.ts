import { randomBytes } from "node:crypto";

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
  TIME_AWARE_CONTEXT_COMPILER_VERSION,
  type ConversationResponseStreamEvent,
  type ConversationTextModel,
  type ExperienceSearchSourcePort,
  type HistoryRecallGateway,
  type HistoryRecallPolicy,
  type HistoryRecallSourcePort,
} from "@sayhear/application";
import {
  PostgresContinuousExchangeRepository,
  PostgresConversationResponseRepository,
  PostgresExperienceSearchSource,
  PostgresHistoryRecallPolicyRepository,
  PostgresHistoryRecallRepository,
  PostgresHistoryRecallSource,
  PostgresInternalOwnerAccessRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import { createProviderEgressPort } from "@sayhear/ai/testing";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

/**
 * Shared in-process assembly of the whole history path for the #320 system
 * suites: real conversation service, Harness, Context Compiler, Provider
 * Egress, governance and PostgreSQL. Only the external model is a stand-in; it
 * records every request, so "what left SayHear" is asserted at the Provider
 * boundary. Hooks let a suite land a user control at an exact point of the
 * request (before read, after read, after freeze, after compile, before the
 * first token, between the first token and the commit).
 */

export const OWNER = fixedInternalOwnerPrincipal.userId;
export const ZONE = "Asia/Shanghai";
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

export type CapturedRequest = Readonly<{
  functionNames: readonly string[];
  instructions: string;
  messages: readonly string[];
  toolsDisabled: boolean;
}>;

export type Hooks = {
  /** Runs once, after the source has been read, before the result is frozen. */
  afterRead?: () => Promise<void>;
  /** Runs once, after the result was frozen, before the answer is compiled. */
  afterAdmit?: () => Promise<void>;
  /** Runs once, after the answer was compiled, before it is sent. */
  afterAnswerCompile?: () => Promise<void>;
  /** Runs inside the answer stream, before the first visible token. */
  beforeFirstDelta?: () => Promise<void>;
  /** Runs inside the answer stream, after the first token was yielded. */
  afterFirstDelta?: () => Promise<void>;
};

export type HarnessOptions = {
  /** Wire governance (default true) and seed one active identity. */
  governed?: boolean;
  policy?: HistoryRecallPolicy;
  /** Offer no history gateway at all (the deployment switch is off). */
  noGateway?: boolean;
};

export function uuidV7(at: Date): string {
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

export const terminal = (events: readonly ConversationResponseStreamEvent[]) =>
  events.at(-1)?.type;
export const shownText = (events: readonly ConversationResponseStreamEvent[]) =>
  events.flatMap((event) => (event.type === "assistant_delta" ? [event.delta] : [])).join("");

export function createHistoryPathHarness(testDatabaseUrl: string) {
  let database: IsolatedPostgresSchema;
  let now = iso("2026-09-15T02:10:00.000Z");
  let counter = 0;
  const state = {
    hooks: {} as Hooks,
    replyChunks: ["我看了", "你之前说的。"] as readonly string[],
    requests: [] as CapturedRequest[],
    review: null as Record<string, unknown> | null,
    sourceReads: 0,
  };
  let hookArmed = { afterAnswerCompile: false };
  const clock = () => now;

  const model: ConversationTextModel = {
    async *stream(request) {
      state.requests.push({
        functionNames: (request.functions ?? []).map((definition) => definition.name),
        instructions: request.instructions,
        messages: request.messages.map((message) => `${message.role}:${message.text}`),
        toolsDisabled: request.toolsDisabled === true,
      });
      const offered = (request.functions ?? []).some(
        (definition) => definition.name === HISTORY_REVIEW_FUNCTION_NAME,
      );
      if (offered && state.review) {
        yield {
          rawArguments: JSON.stringify(state.review),
          rawFunctionName: HISTORY_REVIEW_FUNCTION_NAME,
          type: "tool_call" as const,
        };
        yield completion(request.model, 5);
        return;
      }
      const answerStage = request.toolsDisabled === true;
      if (answerStage) await takeHook("beforeFirstDelta");
      let first = true;
      for (const chunk of state.replyChunks) {
        yield { delta: chunk, type: "delta" as const };
        if (first && answerStage) {
          first = false;
          await takeHook("afterFirstDelta");
        }
      }
      yield completion(request.model, 9);
    },
  };

  async function takeHook(name: keyof Hooks): Promise<void> {
    const hook = state.hooks[name];
    if (!hook) return;
    delete state.hooks[name];
    await hook();
  }

  function completion(modelName: string, outputTokens: number) {
    return {
      costMicros: 0,
      finishReason: "completed",
      inputTokens: 10,
      modelSnapshot: modelName,
      outputTokens,
      providerRequestId: "history-path-request",
      type: "completed" as const,
    };
  }

  function build(options: HarnessOptions = {}) {
    const responseRepository = new PostgresConversationResponseRepository(database.pool);
    const baseCompiler = createContextCompiler({
      clock,
      compilerVersion: TIME_AWARE_CONTEXT_COMPILER_VERSION,
      contentHmacSecret: "history-path-system-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    const contextCompiler = {
      ...baseCompiler,
      async compile(input: Parameters<typeof baseCompiler.compile>[0]) {
        const compiled = await baseCompiler.compile(input);
        if (hookArmed.afterAnswerCompile) {
          hookArmed.afterAnswerCompile = false;
          await takeHook("afterAnswerCompile");
        }
        return compiled;
      },
    };
    const innerSource = new PostgresHistoryRecallSource(database.pool);
    const source: HistoryRecallSourcePort = {
      async readHistoryRange(request) {
        state.sourceReads += 1;
        const snapshot = await innerSource.readHistoryRange(request);
        await takeHook("afterRead");
        return snapshot;
      },
    };
    const innerExperience = new PostgresExperienceSearchSource(database.pool);
    const experienceSource: ExperienceSearchSourcePort = {
      lookupVerifiedAliases: (request) => innerExperience.lookupVerifiedAliases(request),
      readContext: (request) => innerExperience.readContext(request),
      async searchHits(request) {
        state.sourceReads += 1;
        const hits = await innerExperience.searchHits(request);
        await takeHook("afterRead");
        return hits;
      },
    } as ExperienceSearchSourcePort;
    const governanceRepository = new PostgresHistoryRecallPolicyRepository(database.pool);
    const gatewayBase = createHistoryRecallGateway({
      clock,
      experienceSource,
      ...(options.governed === false ? {} : { governance: governanceRepository }),
      ...(options.policy ? { policy: options.policy } : {}),
      repository: new PostgresHistoryRecallRepository(database.pool),
      source,
    });
    const historyRecall: HistoryRecallGateway = {
      ...gatewayBase,
      async admit(input) {
        const receipt = await gatewayBase.admit(input);
        hookArmed.afterAnswerCompile = true;
        await takeHook("afterAdmit");
        return receipt;
      },
    };
    const conversationService = createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy,
      inactivityPolicy: { timeoutMs: 1_800_000, version: "continuous-exchange-inactivity:v1" },
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const gateway = options.noGateway ? undefined : historyRecall;
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
      ...(gateway ? { historyRecall: gateway } : {}),
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
      ...(gateway ? { historyRecall: gateway } : {}),
      jitter: () => 0,
      repository: responseRepository,
    });
    const exchange = createContinuousExchangeService({
      clock,
      repository: new PostgresContinuousExchangeRepository(database.pool),
    });
    return {
      conversationService,
      exchange,
      governanceRepository,
      harness,
      historyRecall,
      responseRepository,
      service,
    };
  }

  let built: ReturnType<typeof build>;

  async function rows<T extends Record<string, unknown>>(
    sql: string,
    parameters: unknown[] = [],
  ): Promise<T[]> {
    return (await database.pool.query<T>(sql, parameters)).rows;
  }

  async function say(
    text: string,
    at: string,
    reply?: string,
  ): Promise<ConversationResponseStreamEvent[]> {
    now = iso(at);
    if (reply !== undefined) state.replyChunks = [reply];
    counter += 1;
    const events: ConversationResponseStreamEvent[] = [];
    for await (const event of built.service.respond(OWNER, {
      clientEventId: `p-event-${counter}`,
      clientTurnId: `p-turn-${counter}`,
      locale: "zh-CN",
      text,
      timezone: ZONE,
    })) {
      events.push(event);
    }
    return events;
  }

  async function closeSession(at: string): Promise<void> {
    now = iso(at);
    await built.exchange.scanDueInactivity();
  }

  async function seedForget(revisionText: string): Promise<void> {
    const [revision] = await rows<{
      conversation_event_id: string;
      conversation_event_revision_id: string;
      daily_session_id: string;
      sequence_no: string;
    }>(
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

  /** The person edits a past message: a new current revision supersedes it. */
  async function correctMessage(oldText: string, newText: string): Promise<void> {
    const [event] = await rows<{ conversation_event_id: string }>(
      `SELECT revision.conversation_event_id::text AS conversation_event_id
       FROM conversation_event_revisions revision WHERE revision.canonical_text = $1`,
      [oldText],
    );
    await built.conversationService.correct(OWNER, {
      eventId: event!.conversation_event_id,
      locale: "zh-CN",
      text: newText,
    });
  }

  /** Owner Full Purge's fence: the Data Epoch moves past every frozen command. */
  async function bumpEpoch(): Promise<void> {
    await database.pool.query(
      "UPDATE app_users SET data_epoch = data_epoch + 1 WHERE user_id = $1",
      [OWNER],
    );
  }

  async function enableGovernance(): Promise<string> {
    const policy = await built.governanceRepository.insertActivePolicy({
      changedBy: String(OWNER),
      compilerVersion: TIME_AWARE_CONTEXT_COMPILER_VERSION,
      harnessPolicyVersion: HISTORY_RECALL_CONVERSATION_HARNESS_POLICY.version,
      historyPolicyVersion: HISTORY_RECALL_DEFAULT_POLICY.version,
      now,
    });
    return policy.policyVersion;
  }

  async function disableGovernance(): Promise<void> {
    await built.governanceRepository.revokeActivePolicy({ now, revokedBy: String(OWNER) });
  }

  async function setup(options: HarnessOptions = {}): Promise<void> {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    const access = new PostgresInternalOwnerAccessRepository(database.pool);
    await access.provisionInternalOwner({
      issuer: "https://github.com",
      subject: "history-path-test-owner",
      userId: OWNER,
    });
    await access.recordBackupPolicyEvidence({
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
    now = iso("2026-09-15T02:10:00.000Z");
    state.hooks = {};
    state.requests = [];
    state.review = null;
    state.sourceReads = 0;
    state.replyChunks = ["我看了", "你之前说的。"];
    hookArmed = { afterAnswerCompile: false };
    built = build(options);
    if (options.governed !== false) await enableGovernance();
  }

  async function teardown(): Promise<void> {
    await database?.dispose();
  }

  return {
    get built() {
      return built;
    },
    bumpEpoch,
    clock,
    closeSession,
    correctMessage,
    get database() {
      return database;
    },
    disableGovernance,
    enableGovernance,
    get now() {
      return now;
    },
    rebuild(options: HarnessOptions = {}) {
      built = build(options);
    },
    rows,
    say,
    seedForget,
    setNow(at: string) {
      now = iso(at);
    },
    setup,
    state,
    teardown,
  };
}

/* ------------------------------------------------------------------------- */
/* The shared synthetic life used by the cross-entrance suites.               */
/* ------------------------------------------------------------------------- */

export const ASK_AT = "2026-09-15T02:10:00.000Z";
export const U_RAIN = "奥斯陆的雨下得人心烦。";
export const U_BAG = "路过修鞋摊，师傅教我缝了帆布包。";
export const U_BAG_REPLY = "缝帆布包这件事听起来很有成就感。";
export const U_REPAIR = "回家后决定以后东西坏了先自己补。";
export const U_REPAIR_REPLY = "先自己补的想法挺踏实。";
export const U_JASMINE = "把阳台的茉莉挪到了太阳底下。";

/** One exchange per day, every day in its own Daily Session. */
export async function seedLife(harness: ReturnType<typeof createHistoryPathHarness>): Promise<void> {
  harness.state.review = null;
  await harness.say(U_RAIN, "2026-08-19T12:10:00.000Z", "雨天确实容易闷。");
  await harness.closeSession("2026-08-19T14:00:00.000Z");
  await harness.say(U_BAG, "2026-08-20T10:30:00.000Z", U_BAG_REPLY);
  await harness.say(U_REPAIR, "2026-08-20T11:20:00.000Z", U_REPAIR_REPLY);
  await harness.closeSession("2026-08-20T14:00:00.000Z");
  await harness.say(U_JASMINE, "2026-08-21T12:40:00.000Z", "茉莉会喜欢的。");
  await harness.closeSession("2026-08-21T14:00:00.000Z");
  harness.state.replyChunks = ["我看了", "你之前说的。"];
  harness.state.requests = [];
  harness.state.sourceReads = 0;
}

/** The three history entrances: date review, older-experience search, continuation. */
export const ENTRANCES = {
  continuation: {
    ask: "那个帆布包的线又开了，我得再补一下。",
    review: { continuation_basis: ["current_input"], search_terms: ["帆布包"] },
  },
  date: {
    ask: "八月二十号那天我跟你说了什么？",
    review: { start_date: "2026-08-20" },
  },
  search: {
    ask: "我以前是不是说过缝帆布包的事？",
    review: { search_terms: ["帆布包"] },
  },
} as const;

export type EntranceName = keyof typeof ENTRANCES;

export async function askVia(
  harness: ReturnType<typeof createHistoryPathHarness>,
  entrance: EntranceName,
): Promise<ConversationResponseStreamEvent[]> {
  harness.state.review = ENTRANCES[entrance].review as unknown as Record<string, unknown>;
  return harness.say(ENTRANCES[entrance].ask, ASK_AT);
}
