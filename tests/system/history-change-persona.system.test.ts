import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CANONICAL_PERSONA_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  createContextCompiler,
  createContinuousExchangeService,
  createConversationAgentHarness,
  createConversationResponseService,
  createHistoryRecallGateway,
  createUserTextConversationService,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  HISTORY_READING_RULES_VERSION,
  HISTORY_RECALL_CONVERSATION_HARNESS_POLICY,
  HISTORY_REVIEW_FUNCTION_NAME,
  resolvePromptArtifacts,
  TIME_AWARE_CONTEXT_COMPILER_VERSION,
  type ConversationResponseStreamEvent,
  type ConversationTextModel,
} from "@sayhear/application";
import {
  PostgresContinuousExchangeRepository,
  PostgresConversationResponseRepository,
  PostgresExperienceSearchSource,
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
 * Issue #318: older messages are read as past and present, corrections and
 * plans keep their meaning, assistant guesses and one-off feelings stay what
 * they are, and every reply path (ordinary, date review, older search,
 * natural continuation) carries the same persona, safety and relationship
 * contract. Real conversation service, Harness, Context Compiler, Provider
 * Egress and PostgreSQL; only the external model is a stand-in that records
 * every request. No test here judges wording quality: voice and empathy are
 * adjudicated by a human (ADR-0110).
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const ZONE = "Asia/Shanghai";
const iso = (value: string) => new Date(value);

/** The model configurations the product registers egress policy for. */
const MODEL_PROFILES = Object.freeze([
  { model: "gpt-5.4", provider: "openai", providerPolicyVersion: "openai-conversation-text:v1" },
  { model: "deepseek-v4-flash", provider: "deepseek", providerPolicyVersion: "deepseek-conversation-text:v1" },
  { model: "deepseek-v4.1-flash", provider: "opencode-go", providerPolicyVersion: "opencode-go-conversation-text:v1" },
] as const);
type ModelProfile = (typeof MODEL_PROFILES)[number];
let profile: ModelProfile = MODEL_PROFILES[0];

function championOf(selected: ModelProfile) {
  return Object.freeze({
    configVersion: "conversation-text-champion:v1",
    consentPolicyVersion: null,
    contextLimit: 1_000_000,
    dataRegion: "test",
    model: selected.model,
    provider: selected.provider,
    providerPolicyVersion: selected.providerPolicyVersion,
    retentionMode: "store-disabled",
    snapshot: selected.model,
    streaming: true as const,
    supportedLocales: Object.freeze(["en", "zh"]),
    trainingPolicy: "test",
  });
}

const policyVersions = Object.freeze({
  canonicalPersonaVersion: CANONICAL_PERSONA_VERSION,
  localePolicyVersion: "locale-pack-zh:v1",
  outputFormatVersion: "conversation-output:v1",
  personaBehaviorAnchorsVersion: PERSONA_BEHAVIOR_ANCHORS_VERSION,
  personaContractInvariantVersion: "persona-contract-invariant:v1",
  productPolicyVersion: "product-policy:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
  taskInstructionVersion: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
});

const generationPolicyOf = (selected: ModelProfile) => Object.freeze({
  consentPolicyVersion: null,
  freshnessPolicy: "source_valid:v1" as const,
  chineseLocalePackVersion: "locale-pack-zh:v1",
  englishLocalePackVersion: "locale-pack-en:v1",
  harnessPolicyVersion: HISTORY_RECALL_CONVERSATION_HARNESS_POLICY.version,
  conversationActionCatalogVersion: EMPTY_CONVERSATION_ACTION_CATALOG.version,
  model: selected.model,
  modelConfigVersion: "conversation-text-champion:v1",
  modelSnapshot: selected.model,
  outputFormatVersion: policyVersions.outputFormatVersion,
  canonicalPersonaVersion: policyVersions.canonicalPersonaVersion,
  personaBehaviorAnchorsVersion: policyVersions.personaBehaviorAnchorsVersion,
  personaContractInvariantVersion: policyVersions.personaContractInvariantVersion,
  productPolicyVersion: policyVersions.productPolicyVersion,
  taskInstructionVersion: policyVersions.taskInstructionVersion,
  provider: selected.provider,
  providerPolicyVersion: selected.providerPolicyVersion,
  relationshipPolicyVersion: policyVersions.relationshipPolicyVersion,
  safetyPolicyVersion: policyVersions.safetyPolicyVersion,
});

type CapturedRequest = Readonly<{
  instructions: string;
  messages: readonly string[];
  toolsDisabled: boolean;
}>;

let database: IsolatedPostgresSchema;
let now = iso("2026-06-01T10:00:00.000Z");
let counter = 0;
let requests: CapturedRequest[] = [];
let review: Record<string, unknown> | null = null;

const clock = () => now;

const model: ConversationTextModel = {
  async *stream(request) {
    requests.push({
      instructions: request.instructions,
      messages: request.messages.map((message) => `${message.role}:${message.text}`),
      toolsDisabled: request.toolsDisabled === true,
    });
    const offered = (request.functions ?? []).some(
      (definition) => definition.name === HISTORY_REVIEW_FUNCTION_NAME,
    );
    if (offered && review) {
      yield {
        rawArguments: JSON.stringify(review),
        rawFunctionName: HISTORY_REVIEW_FUNCTION_NAME,
        type: "tool_call" as const,
      };
      yield completion(request.model, 5);
      return;
    }
    yield { delta: "我看了你之前说的。", type: "delta" as const };
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
    providerRequestId: "history-change-request",
    type: "completed" as const,
  };
}

let service: ReturnType<typeof createConversationResponseService>;
let exchange: ReturnType<typeof createContinuousExchangeService>;

function build() {
  const responseRepository = new PostgresConversationResponseRepository(database.pool);
  const contextCompiler = createContextCompiler({
    clock,
    compilerVersion: TIME_AWARE_CONTEXT_COMPILER_VERSION,
    contentHmacSecret: "history-change-system-secret",
    rawEventTokenBudget: 4_000,
    repository: responseRepository,
  });
  const historyRecall = createHistoryRecallGateway({
    clock,
    experienceSource: new PostgresExperienceSearchSource(database.pool),
    repository: new PostgresHistoryRecallRepository(database.pool),
    source: new PostgresHistoryRecallSource(database.pool),
  });
  const conversationService = createUserTextConversationService({
    clock,
    expectedBackupPolicyVersion: "neon-production-v1",
    expectedConfigurationFingerprint: "sha256:expected",
    generationPolicy: generationPolicyOf(profile),
    inactivityPolicy: { timeoutMs: 1_800_000, version: "continuous-exchange-inactivity:v1" },
    repository: new PostgresUserTextConversationRepository(database.pool),
  });
  const harness = createConversationAgentHarness({
    clock,
    contextCompiler,
    delay: async () => undefined,
    egressPort: createProviderEgressPort({
      champion: championOf(profile),
      clock,
      contextCompiler,
      model,
      repository: responseRepository,
    }),
    historyRecall,
    jitter: () => 0,
    repository: responseRepository,
  });
  service = createConversationResponseService({
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
  exchange = createContinuousExchangeService({
    clock,
    repository: new PostgresContinuousExchangeRepository(database.pool),
  });
}

async function say(
  text: string,
  at: string,
  reviewCall: Record<string, unknown> | null = null,
): Promise<ConversationResponseStreamEvent[]> {
  now = iso(at);
  review = reviewCall;
  counter += 1;
  const events: ConversationResponseStreamEvent[] = [];
  for await (const event of service.respond(OWNER, {
    clientEventId: `c-event-${counter}`,
    clientTurnId: `c-turn-${counter}`,
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
  await exchange.scanDueInactivity();
}

async function rows<T extends Record<string, unknown>>(
  sql: string,
  parameters: unknown[] = [],
): Promise<T[]> {
  return (await database.pool.query<T>(sql, parameters)).rows;
}

const OLD_JOB = "我在明川物流做调度做了四年，每天就是盯着车队的排班表，最近越来越觉得没意思。";
const OFFER = "拿到栖云科技的 offer 了，做运营分析，十月八号入职，明川那边我周一就去提离职。";
const DATE_FIX = "跟你更正一下，入职日期改了，不是十月八号，HR 说工位没弄好，推到十月十五号。";
const HIKING = "周末一个人在大理徒步了两天，山上一直在下雨，反而挺清静的。";
const ASK = "我有点恍惚，我现在是在哪儿上班、哪天入职的来着？";

/** An old job, an offer, an explicit correction of its date, and an unrelated trip. */
async function seedLife(): Promise<void> {
  await say(OLD_JOB, "2026-08-03T12:00:00.000Z");
  await closeSession("2026-08-03T14:00:00.000Z");
  await say(HIKING, "2026-09-12T09:00:00.000Z");
  await closeSession("2026-09-12T11:00:00.000Z");
  await say(OFFER, "2026-09-20T11:30:00.000Z");
  await closeSession("2026-09-20T13:00:00.000Z");
  await say(DATE_FIX, "2026-09-27T13:10:00.000Z");
  await closeSession("2026-09-27T15:00:00.000Z");
  requests = [];
}

const users = (request: CapturedRequest) =>
  request.messages.filter((message) => message.startsWith("user:"));
const assistants = (request: CapturedRequest) =>
  request.messages.filter((message) => message.startsWith("assistant:"));

beforeEach(async () => {
  database = await createIsolatedPostgresSchema(testDatabaseUrl);
  await runMigrations(database.pool);
  await new PostgresInternalOwnerAccessRepository(database.pool).provisionInternalOwner({
    issuer: "https://github.com",
    subject: "history-change-test-owner",
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
    verifiedAt: new Date("2026-03-13T00:00:00.000Z"),
  });
  await database.pool.query("UPDATE provider_egress_policy_versions SET status = 'active'");
  counter = 0;
  requests = [];
  review = null;
  profile = MODEL_PROFILES[0];
  build();
}, 30_000);

afterEach(async () => {
  await database?.dispose();
}, 15_000);

describe("state change and explicit correction through the real conversation path", () => {
  it("gives the model the old state, the offer and the person's own correction in time order, with the reading rules, and creates no control", async () => {
    await seedLife();
    const events = await say(ASK, "2026-10-28T12:00:00.000Z", {
      search_terms: ["入职", "offer", "上班"],
    });
    expect(events.at(-1)?.type).toBe("assistant_committed");
    expect(requests).toHaveLength(2);
    const answer = requests[1]!;
    expect(answer.toolsDisabled).toBe(true);

    const quoted = users(answer);
    const offerAt = quoted.indexOf(`user:${OFFER}`);
    const fixAt = quoted.indexOf(`user:${DATE_FIX}`);
    expect(offerAt).toBeGreaterThanOrEqual(0);
    expect(fixAt).toBeGreaterThan(offerAt);
    expect(quoted.at(-1)).toBe(`user:${ASK}`);

    expect(answer.instructions).toContain(`History reading rules (${HISTORY_READING_RULES_VERSION})`);
    expect(answer.instructions).toMatch(/latest statement is how it is now/);

    // A conversational correction is not a control: nothing was excluded,
    // forgotten or corrected on its account, and it created no memory.
    expect(await rows("SELECT 1 FROM memory_claim_corrections")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM memory_forget_evidence_exclusions")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM memory_claims")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM evidence_items")).toHaveLength(0);
    // The earlier message is still in the saved history, unchanged.
    expect(
      await rows(
        "SELECT 1 FROM conversation_event_revisions WHERE canonical_text = $1",
        [OFFER],
      ),
    ).toHaveLength(1);
  });

  it("keeps the older state as the past: the old job and the newest statement arrive together for an August question", async () => {
    await seedLife();
    await say("新公司第一周过完了，天天在补他们那套数据口径的文档，脑子是满的。", "2026-10-19T12:40:00.000Z");
    await closeSession("2026-10-19T14:00:00.000Z");
    requests = [];
    await say("八月的时候我是在哪儿做什么的来着？跟现在比呢？", "2026-10-28T12:06:00.000Z", {
      search_terms: ["调度", "明川", "新公司"],
    });
    const answer = requests[1]!;
    const quoted = users(answer).join("\n");
    expect(quoted).toContain("明川物流做调度");
    expect(quoted).toContain("新公司第一周");
    expect(quoted.indexOf("明川物流做调度")).toBeLessThan(quoted.indexOf("新公司第一周"));
    expect(answer.instructions).toMatch(/Speak of the earlier one in the past tense/);
  });

  it("does not pull in an unrelated trip just because it is stored and retrievable", async () => {
    await seedLife();
    await say(ASK, "2026-10-28T12:00:00.000Z", { search_terms: ["入职", "offer"] });
    const answer = requests[1]!;
    expect(users(answer).join("\n")).not.toContain("徒步");
    expect(answer.instructions).toMatch(/unrelated earlier thing just because it was found/);
  });

  it("shows assistant lines only in the assistant role, never as something the person said", async () => {
    await seedLife();
    await say(ASK, "2026-10-28T12:00:00.000Z", { search_terms: ["入职", "offer"] });
    const answer = requests[1]!;
    expect(assistants(answer).length).toBeGreaterThan(0);
    for (const line of assistants(answer)) {
      expect(users(answer)).not.toContain(`user:${line.slice("assistant:".length)}`);
    }
    expect(answer.instructions).toMatch(/assistant lines are your own earlier replies/i);
  });
});

describe("one persona and one safety posture across every reply path", () => {
  const artifacts = resolvePromptArtifacts({
    generationStage: "decision",
    locale: "zh-CN",
    policyVersions,
  });
  const sharedBlocks = [
    artifacts.personaContractInvariant,
    artifacts.canonicalPersona,
    artifacts.personaBehaviorAnchors,
    "Distinguish user facts and judgments from your own inference. Do not encourage dependence or exclusivity.",
    "For explicit self-harm, harm-to-others, or imminent danger, pause ordinary listening",
  ];

  it("keeps identical persona, relationship and safety content and versions on ordinary, date, older and continuation replies", async () => {
    await seedLife();
    await say("今天天气挺好的。", "2026-10-28T09:00:00.000Z");
    const ordinary = requests[0]!;
    requests = [];

    await say("九月二十七号我们聊了什么？", "2026-10-28T09:10:00.000Z", {
      start_date: "2026-09-27",
    });
    const dated = requests[1]!;
    requests = [];

    await say(ASK, "2026-10-28T09:20:00.000Z", { search_terms: ["入职", "offer"] });
    const older = requests[1]!;
    requests = [];

    await say("栖云那边今天把入职清单发给我了。", "2026-10-28T09:30:00.000Z", {
      continuation_basis: ["current_input"],
      search_terms: ["栖云", "入职"],
    });
    const continuation = requests[1]!;

    for (const request of [ordinary, dated, older, continuation]) {
      for (const block of sharedBlocks) {
        expect(request.instructions).toContain(block);
      }
      expect(request.instructions).not.toContain("reduced variant while the Safety Posture is active");
    }
    // The reading contract belongs to the paths that quote older messages.
    expect(ordinary.instructions).not.toContain("History reading rules");
    for (const request of [dated, older, continuation]) {
      expect(request.instructions).toContain(`History reading rules (${HISTORY_READING_RULES_VERSION})`);
    }

    const versions = await rows<{ count: string }>(
      `SELECT count(*)::text AS count FROM (
         SELECT DISTINCT persona_contract_invariant_version, canonical_persona_version,
                persona_behavior_anchors_version, safety_policy_version,
                relationship_policy_version, product_policy_version, locale_policy_version
         FROM generation_commands
         WHERE created_at >= '2026-10-28T00:00:00Z'
       ) shared`,
    );
    expect(versions[0]!.count).toBe("1");
    const stages = await rows<{ generation_stage: string }>(
      `SELECT DISTINCT generation_stage FROM generation_commands
       WHERE created_at >= '2026-10-28T00:00:00Z' ORDER BY 1`,
    );
    expect(stages.map((row) => row.generation_stage)).toEqual(["decision", "history_answer"]);
  });

  it("carries an active Safety Posture into the history answer, and a new day starts clean", async () => {
    await seedLife();
    await say("我不想活了，真的很累。", "2026-10-28T09:00:00.000Z");
    requests = [];

    await say(ASK, "2026-10-28T09:05:00.000Z", { search_terms: ["入职", "offer"] });
    const answer = requests[1]!;
    expect(answer.instructions).toContain("reduced variant while the Safety Posture is active");
    expect(answer.instructions).toContain(`History reading rules (${HISTORY_READING_RULES_VERSION})`);
    for (const block of sharedBlocks.slice(0, 2)) {
      expect(answer.instructions).toContain(block);
    }
    expect(answer.instructions).not.toContain(artifacts.personaBehaviorAnchors);

    await closeSession("2026-10-28T11:00:00.000Z");
    requests = [];
    await say(ASK, "2026-10-29T09:00:00.000Z", { search_terms: ["入职", "offer"] });
    const nextDay = requests[1]!;
    expect(nextDay.instructions).not.toContain("reduced variant while the Safety Posture is active");
    expect(nextDay.instructions).toContain(artifacts.personaBehaviorAnchors);
  });

  it("changes nothing about the persona when the person's tone changes between days", async () => {
    await seedLife();
    await say("唉，今天特别丧，什么都不想做。", "2026-10-28T09:00:00.000Z");
    const heavy = requests[0]!;
    await closeSession("2026-10-28T11:00:00.000Z");
    requests = [];
    await say("哈哈今天心情超好！对了我入职那天是哪天来着？", "2026-10-29T09:00:00.000Z", {
      search_terms: ["入职", "offer"],
    });
    const light = requests[1]!;
    for (const block of sharedBlocks) {
      expect(heavy.instructions).toContain(block);
      expect(light.instructions).toContain(block);
    }
    // No mood or trait is carried as a stored description of the person.
    expect(await rows("SELECT 1 FROM memory_claims")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM evidence_items")).toHaveLength(0);
  });
});

describe("each registered model configuration compiles the same contract", () => {
  it("sends the same persona, safety and reading contract whichever approved model answers, changing only the model identity", async () => {
    await seedLife();
    const readingBlocks: string[] = [];
    const personaBlocks: string[] = [];
    for (const [index, selected] of MODEL_PROFILES.entries()) {
      profile = selected;
      build();
      requests = [];
      const events = await say(ASK, `2026-10-28T1${index}:00:00.000Z`, {
        search_terms: ["offer", "入职日期"],
      });
      expect(events.at(-1)?.type).toBe("assistant_committed");
      const answer = requests[1]!;
      readingBlocks.push(
        answer.instructions.slice(answer.instructions.indexOf("History reading rules")),
      );
      personaBlocks.push(
        answer.instructions.slice(
          answer.instructions.indexOf("Persona Contract Invariant"),
          answer.instructions.indexOf("Persona behavior anchors") + 400,
        ),
      );
      expect(users(answer)).toContain(`user:${DATE_FIX}`);
    }
    expect(new Set(readingBlocks).size).toBe(1);
    expect(new Set(personaBlocks).size).toBe(1);
    const stored = await rows<{ models: string; personas: string }>(
      `SELECT count(DISTINCT model)::text AS models,
              count(DISTINCT (canonical_persona_version, persona_behavior_anchors_version,
                              persona_contract_invariant_version, safety_policy_version,
                              relationship_policy_version))::text AS personas
       FROM generation_commands WHERE created_at >= '2026-10-28T00:00:00Z'`,
    );
    expect(stored[0]).toEqual({ models: "3", personas: "1" });
  });
});
