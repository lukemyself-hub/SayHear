import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createContextCompiler,
  createDialogueStateService,
  createContinuousExchangeService,
  createConversationAgentHarness,
  createConversationResponseService,
  createHistoryRecallGateway,
  type ExperienceSearchSourcePort,
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
  PostgresDialogueStateRepository,
  PostgresExperienceSearchSource,
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
 * Issue #317: the current talk naturally picks up an older matter from the original words,
 * end to end through the real conversation service, Harness, Context
 * Compiler, Provider Egress and PostgreSQL. No Claim, Entity or projection
 * exists for these messages. Only the external model is a stand-in; it records
 * every request so "what actually left SayHear" is asserted at the Provider
 * boundary.
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
  /** Arguments the Decision sends to the review function; null answers ordinarily. */
  review: Record<string, unknown> | null;
  /** Throw this category once on the first stage-two request. */
  failAnswerOnce?: "timeout";
};

let database: IsolatedPostgresSchema;
let now = iso("2026-06-01T10:00:00.000Z");
let counter = 0;
let requests: CapturedRequest[] = [];
let script: Script = { review: null };
let answerFailuresLeft = 0;
let sourceReads = 0;
let replyText = "我看了你之前说的。";

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
    yield { delta: replyText, type: "delta" as const };
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
  experience?: (inner: ExperienceSearchSourcePort) => ExperienceSearchSourcePort;
} = {}) {
  const responseRepository = new PostgresConversationResponseRepository(database.pool);
  const baseCompiler = createContextCompiler({
    clock,
    compilerVersion: TIME_AWARE_CONTEXT_COMPILER_VERSION,
    contentHmacSecret: "history-continuation-system-secret",
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
    experienceSource: overrides.experience
      ? overrides.experience(new PostgresExperienceSearchSource(database.pool))
      : new PostgresExperienceSearchSource(database.pool),
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

async function say(
  text: string,
  at: string,
  reply = "我看了你之前说的。",
): Promise<ConversationResponseStreamEvent[]> {
  now = iso(at);
  replyText = reply;
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

const KILN_A =
  "I finally posted my entry for the Marlowe Open, the juried ceramics show. Three stoneware bowls with the ash glaze I have been fighting with since winter.";
const KILN_B =
  "They say results come by post in the autumn. I have decided not to think about it until then.";
const TRIP =
  "Spent the whole weekend hiking in the Lake District with my brother, and the rain never stopped once.";
const JOB_A =
  "Sent off the application for the archive assistant post at the county records office this morning. Closing date is Friday.";
const JOB_B = "No word yet from the records office. I keep refreshing my email like it will help.";
const STUDIO =
  "Spent the evening at the wheel again. First time I have thrown anything decent since I sent those bowls away.";
const CUED = "And there was an envelope on the mat when I got in. They finally wrote back.";
const BARE = "I finally got a reply!";
const STUDIO_AT = "2026-09-23T19:20:00.000Z";
const CUED_AT = "2026-09-23T19:23:00.000Z";

/** Ordinary life: two pending matters and a trip, all older than seven days. */
async function seedLife(): Promise<void> {
  script = { review: null };
  await say(KILN_A, "2026-06-02T18:30:00.000Z");
  await say(KILN_B, "2026-06-02T18:36:00.000Z");
  await closeSession("2026-06-02T20:00:00.000Z");
  await say(TRIP, "2026-07-10T09:00:00.000Z");
  await closeSession("2026-07-10T11:00:00.000Z");
  await say(JOB_A, "2026-09-01T08:10:00.000Z");
  await closeSession("2026-09-01T10:00:00.000Z");
  await say(JOB_B, "2026-09-03T17:45:00.000Z");
  await closeSession("2026-09-03T19:00:00.000Z");
  requests = [];
  sourceReads = 0;
}

async function continueWith(
  review: Record<string, unknown> | null,
  text: string,
  at: string,
) {
  script = { review };
  return say(text, at);
}


/** Publish a real DialogueState for the active session through the real service. */
async function publishDialogueState(topic: string): Promise<void> {
  const [policy] = await rows<{
    model_config_version: string;
    policy_version: string;
    prompt_version: string;
  }>("SELECT policy_version, prompt_version, model_config_version FROM dialogue_state_policies LIMIT 1");
  const policyInput = {
    modelConfigVersion: policy!.model_config_version,
    policyVersion: policy!.policy_version,
    promptVersion: policy!.prompt_version,
  };
  const repository = new PostgresDialogueStateRepository(database.pool);
  await repository.queueEligible({ now, policy: policyInput });
  const commands = await rows<{ id: string }>(
    "SELECT dialogue_state_command_id::text AS id FROM dialogue_state_commands WHERE status = 'created'",
  );
  const service = createDialogueStateService({
    clock,
    model: {
      async project({ sources }) {
        const ids = sources.map((source) => source.revisionId);
        const nothing = { confidence: 0, sourceRevisionIds: [], value: null };
        return {
          advice_explicitly_requested: nothing,
          close_intent: nothing,
          current_request_requires_focus: nothing,
          current_topic: { confidence: 0.9, sourceRevisionIds: ids.slice(-1), value: topic },
          emotional_intensity: nothing,
          user_willing_to_elaborate: nothing,
        };
      },
    },
    policy: policyInput,
    repository,
  });
  for (const command of commands) {
    expect((await service.run(command.id)).outcome).toBe("published");
  }
}

async function lastDecisionMetadata() {
  const decision = (await rows<{ generation_command_id: string }>(
    "SELECT generation_command_id FROM generation_commands WHERE generation_stage = 'decision' ORDER BY created_at DESC LIMIT 1",
  ))[0]!;
  return new PostgresInternalInspectionRepository(database.pool).findGenerationMetadata({
    generationCommandId: asGenerationCommandId(decision.generation_command_id),
    userId: OWNER,
  });
}

const answerUsers = (answer: CapturedRequest) =>
  answer.messages.filter((message) => message.startsWith("user:"));

const assistantText = (events: readonly ConversationResponseStreamEvent[]) =>
  events.flatMap((event) => (event.type === "assistant_delta" ? [event.delta] : [])).join("");
const terminal = (events: readonly ConversationResponseStreamEvent[]) => events.at(-1)?.type;

async function rows<T extends Record<string, unknown>>(sql: string, parameters: unknown[] = []): Promise<T[]> {
  return (await database.pool.query<T>(sql, parameters)).rows;
}

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

beforeEach(async () => {
  database = await createIsolatedPostgresSchema(testDatabaseUrl);
  await runMigrations(database.pool);
  await new PostgresInternalOwnerAccessRepository(database.pool).provisionInternalOwner({
    issuer: "https://github.com",
    subject: "history-continuation-test-owner",
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
  script = { review: null };
  answerFailuresLeft = 0;
  sourceReads = 0;
  replyText = "我看了你之前说的。";
  built = build();
}, 30_000);

afterEach(async () => {
  await database?.dispose();
}, 15_000);


describe("natural continuation of the current talk through the real conversation path", () => {
  it("connects a cued follow-up to the months-old matter without the user repeating it, and no Memory exists", async () => {
    await seedLife();
    await continueWith(null, STUDIO, STUDIO_AT);
    requests = [];
    const events = await continueWith(
      {
        continuation_basis: ["current_input", "adjacent_user"],
        search_terms: ["bowls", "juried", "entry"],
      },
      CUED,
      CUED_AT,
    );
    expect(terminal(events)).toBe("assistant_committed");
    expect(events.filter((event) => event.type === "assistant_committed")).toHaveLength(1);
    expect(requests).toHaveLength(2);
    const answer = requests[1]!;
    expect(answer.toolsDisabled).toBe(true);
    const users = answerUsers(answer);
    expect(users).toContain(`user:${KILN_A}`);
    expect(users).toContain(`user:${KILN_B}`);
    expect(users.join("\n")).not.toContain("Lake District");
    expect(users.at(-1)).toBe(`user:${CUED}`);
    expect(answer.instructions).toContain("without asking them to tell it again");
    expect(answer.instructions).not.toContain("exactly ONE short");

    // The clues are not facts: nothing about them reaches Memory tables.
    expect(await rows("SELECT 1 FROM memory_claims")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM evidence_items")).toHaveLength(0);
    expect(await rows("SELECT 1 FROM entities")).toHaveLength(0);
    // And no new follow-up work is created: just the two stages of this turn.
    const stages = await rows<{ generation_stage: string }>(
      `SELECT generation_stage FROM generation_commands
       WHERE interaction_turn_id = (SELECT interaction_turn_id FROM generation_commands ORDER BY created_at DESC LIMIT 1)
       ORDER BY generation_stage`,
    );
    expect(stages.map((row) => row.generation_stage)).toEqual(["decision", "history_answer"]);

    const metadata = await lastDecisionMetadata();
    expect(metadata?.historyRecall?.coverage.continuation).toMatchObject({
      anchoredClues: 1,
      basis: ["current_input", "adjacent_user"],
      basisRejected: [],
      dialogueState: "unavailable",
      verdict: "single",
    });
  });

  it("names the matter the current talk points at when two fit, without merging them", async () => {
    await seedLife();
    await continueWith(null, STUDIO, STUDIO_AT);
    requests = [];
    await continueWith(
      {
        continuation_basis: ["current_input", "adjacent_user"],
        search_terms: ["bowls", "application"],
      },
      CUED,
      CUED_AT,
    );
    const answer = requests[1]!;
    const users = answerUsers(answer);
    expect(users).toContain(`user:${KILN_A}`);
    expect(users).toContain(`user:${JOB_A}`);
    expect(answer.instructions).toContain("occasion 1 (around 2026-06-03) shares the most");
    expect(answer.instructions).toContain("must not be merged");
    const metadata = await lastDecisionMetadata();
    expect(metadata?.historyRecall?.coverage.continuation).toMatchObject({
      leadingGroup: 1,
      verdict: "leading",
    });
  });

  it("keeps two fitting matters apart and asks one question when nothing separates them", async () => {
    await seedLife();
    const events = await continueWith(
      { continuation_basis: ["current_input"], search_terms: ["entry", "application"] },
      BARE,
      CUED_AT,
    );
    expect(terminal(events)).toBe("assistant_committed");
    const answer = requests[1]!;
    const users = answerUsers(answer);
    expect(users).toContain(`user:${KILN_A}`);
    expect(users).toContain(`user:${JOB_A}`);
    expect(users.join("\n")).not.toContain("Lake District");
    expect(answer.instructions).toContain("exactly ONE short");
    expect(answer.instructions).toContain("do not pick the most recent");
    expect(answer.instructions).toContain("never merge them");
    const metadata = await lastDecisionMetadata();
    expect(metadata?.historyRecall?.coverage.continuation).toMatchObject({
      anchoredClues: 0,
      leadingGroup: null,
      verdict: "tied",
    });
  });

  it("does not look back for a greeting: the clues are dropped and the reply stays ordinary", async () => {
    await seedLife();
    const events = await continueWith(
      { continuation_basis: ["current_input"], search_terms: ["hello", "你好", "thanks"] },
      "Hello!",
      CUED_AT,
    );
    expect(terminal(events)).toBe("assistant_committed");
    const answer = requests[1]!;
    expect(answerUsers(answer)).toEqual(["user:Hello!"]);
    expect(answer.instructions).toContain("Reply to what they just said as you normally would");
    expect(answer.instructions).not.toContain("could not look it up");
    expect(sourceReads).toBe(0);
    const [result] = await rows<{ failure_code: string }>("SELECT failure_code FROM history_recall_results");
    expect(result!.failure_code).toBe("search_terms_unusable");
  });

  it("leaves a new subject and unrelated chat on the ordinary path: no search, no extra command", async () => {
    await seedLife();
    const events = await continueWith(null, "The train was packed today and I got a seat at last.", CUED_AT);
    expect(terminal(events)).toBe("assistant_committed");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages.join("\n")).not.toContain("juried");
    expect(await rows("SELECT 1 FROM history_recall_results")).toHaveLength(0);
  });

  it("rejects a DialogueState basis when no source-valid state exists, and replies ordinarily", async () => {
    await seedLife();
    await continueWith(
      { continuation_basis: ["dialogue_state"], search_terms: ["bowls", "entry"] },
      CUED,
      CUED_AT,
    );
    const answer = requests[1]!;
    expect(answerUsers(answer)).toEqual([`user:${CUED}`]);
    expect(answer.instructions).toContain("Reply to what they just said as you normally would");
    const [result] = await rows<{ failure_code: string; status: string }>(
      "SELECT failure_code, status FROM history_recall_results",
    );
    expect(result).toMatchObject({ failure_code: "continuation_basis_unavailable", status: "failed" });
    const metadata = await lastDecisionMetadata();
    expect(metadata?.historyRecall?.coverage.continuation).toMatchObject({
      basis: [],
      basisRejected: ["dialogue_state"],
      verdict: "none",
    });
    expect(sourceReads).toBe(0);
  });

  it("does not quote a source with an explicit Forget association, and never reveals that it existed", async () => {
    await seedLife();
    await seedForgetExclusion(KILN_A);
    await continueWith(
      { continuation_basis: ["current_input"], search_terms: ["entry", "application"] },
      BARE,
      CUED_AT,
    );
    const answer = requests[1]!;
    const users = answerUsers(answer);
    expect(users.join("\n")).not.toContain("Marlowe");
    expect(users).toContain(`user:${JOB_A}`);
    expect(answer.instructions).toContain("Earlier occasions found, oldest first: occasion 1 around");
    expect(answer.instructions).not.toMatch(/forget|excluded|exclusion/i);
    const metadata = await lastDecisionMetadata();
    expect(metadata?.historyRecall?.coverage.continuation?.verdict).toBe("single");
  });

  it("exposes only counts and verdicts through the Inspector, never clues or text", async () => {
    await seedLife();
    await continueWith(
      { continuation_basis: ["current_input"], people: ["Priya"], search_terms: ["entry", "application"] },
      BARE,
      CUED_AT,
    );
    const metadata = await lastDecisionMetadata();
    expect(metadata?.historyRecall?.coverage.continuation).toBeDefined();
    const serialized = JSON.stringify(metadata);
    for (const secret of ["Marlowe", "juried", "records office", "Priya", "application", "entry"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("takes the clue from a source-valid DialogueState topic and records which state it used", async () => {
    await seedLife();
    await continueWith(null, STUDIO, STUDIO_AT);
    await publishDialogueState("the stoneware bowls sent to the juried ceramics show");
    requests = [];
    await continueWith(
      { continuation_basis: ["dialogue_state"], search_terms: ["bowls", "entry"] },
      CUED,
      CUED_AT,
    );
    const answer = requests[1]!;
    expect(answerUsers(answer)).toContain(`user:${KILN_A}`);
    const metadata = await lastDecisionMetadata();
    const continuation = metadata?.historyRecall?.coverage.continuation;
    expect(continuation).toMatchObject({ anchoredClues: 1, basis: ["dialogue_state"], basisRejected: [], verdict: "single" });
    expect(["current", "lagging"]).toContain(continuation?.dialogueState);
  });

  it("stops using a DialogueState whose source was withdrawn: the basis is rejected and the reply stays ordinary", async () => {
    await seedLife();
    await continueWith(null, STUDIO, STUDIO_AT);
    await publishDialogueState("the stoneware bowls sent to the juried ceramics show");
    await database.pool.query(
      `UPDATE conversation_events SET lifecycle_status = 'deleted', deleted_at = $1
       WHERE conversation_event_id = (
         SELECT conversation_event_id FROM conversation_event_revisions WHERE canonical_text = $2)`,
      [now, STUDIO],
    );
    await built.exchange.scanDueInactivity();
    requests = [];
    await continueWith(
      { continuation_basis: ["dialogue_state"], search_terms: ["bowls", "entry"] },
      CUED,
      CUED_AT,
    );
    expect(answerUsers(requests[1]!)).not.toContain(`user:${KILN_A}`);
    const metadata = await lastDecisionMetadata();
    expect(metadata?.historyRecall?.coverage.continuation).toMatchObject({
      basis: [],
      basisRejected: ["dialogue_state"],
      verdict: "none",
    });
  });

  it("with a lagging DialogueState still accepts it and reads the raw messages after its coverage", async () => {
    await seedLife();
    await continueWith(null, STUDIO, STUDIO_AT);
    await publishDialogueState("the stoneware bowls sent to the juried ceramics show");
    await continueWith(null, "The kiln is cooling down now, fingers crossed.", "2026-09-23T19:21:30.000Z");
    requests = [];
    await continueWith(
      { continuation_basis: ["dialogue_state", "adjacent_user"], search_terms: ["bowls", "entry"] },
      CUED,
      CUED_AT,
    );
    expect(requests[0]!.messages.join("\n")).toContain("The kiln is cooling down now");
    const metadata = await lastDecisionMetadata();
    expect(metadata?.historyRecall?.coverage.continuation).toMatchObject({
      basisRejected: [],
      dialogueState: "lagging",
      verdict: "single",
    });
  });
});
