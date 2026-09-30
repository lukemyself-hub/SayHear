/**
 * F3 "clean incumbent" continuation capture for the 1A.3b G1 gate.
 *
 * Runs every `continuation` fixture through the REAL production conversation
 * seam — Context Compiler + Conversation Agent Harness + Runtime Provider
 * Egress — against an in-memory frozen-input layer (no Postgres), using the
 * pinned incumbent arm `continuation-incumbent-1a3a`. The Provider adapter is
 * either the pinned DeepSeek champion (`buildChampionAssembly`) or a
 * deterministic double used to prove the plumbing without network calls.
 *
 * Usage:
 *   tsx eval/continuation-acceptance-1a3b/run-synthetic-capture.ts \
 *     [--deterministic] [--only <fixtureId>] [--continue-on-error] \
 *     [--catalog <path>] [--pins <path>] [--out <path>] [--hard-gates-out <path>]
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  CANONICAL_PERSONA_VERSION,
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  CHINESE_LOCALE_PACK_VERSION,
  CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  ENGLISH_LOCALE_PACK_VERSION,
  MEMORY_BUDGETS_POLICY_VERSION,
  MEMORY_RETRIEVAL_POLICY_VERSION,
  MEMORY_SECTION_KEYS,
  MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  PORTRAIT_SELECTION_POLICY_VERSION,
  RECALL_FRAMING_POLICY_VERSION,
  RETRIEVAL_LANE_PRIORITY,
  RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
  SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE,
  SAFETY_POSTURE_POLICY_VERSION,
  applySafetyPostureTurn,
  createContextCompiler,
  createConversationAgentHarness,
  minimumHighRiskSafetyPostureDetector,
  validateSafetyPostureContent,
  type ClaimKind,
  type CompiledContext,
  type CompiledContextRenderSource,
  type ContextCompilerRepository,
  type ContextPolicyVersions,
  type ContextSourceEvent,
  type ContextSourceSnapshot,
  type ConversationAgentHarness,
  type ConversationAgentHarnessRepository,
  type ConversationHarnessPolicy,
  type ConversationTextChampion,
  type CurrentSafetyPosture,
  type MemoryContextItem,
  type MemoryRetrievalPort,
  type MemoryRetrievalRunOutcome,
  type MemorySectionKey,
  type ProviderEgressClaim,
  type ProviderEgressPort,
  type ProviderEgressRepository,
  type RetrievalRunManifest,
} from "@sayhear/application";
import { createRuntimeProviderEgressPort } from "@sayhear/ai";
import {
  asCompiledContextId,
  asConversationEventId,
  asConversationEventRevisionId,
  asDailySessionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asUserId,
} from "@sayhear/domain";

import { buildChampionAssembly, loadDotEnv } from "../memory-pairwise-126/shared";
import {
  F3_RUN_VERSION,
  configurationFingerprint,
  sha256,
  type ContinuationFixture,
  type FixtureCatalog,
  type F3Pins,
  type FrozenSharedInput,
  type SyntheticRun,
  type SyntheticRunTurn,, F3_INCUMBENT_CONFIG_ID 
} from "./protocol";
import { verifySyntheticRunHardGates } from "./review-package";

const DEFAULT_CATALOG = "eval/continuation-acceptance-1a3b/fixtures.json";
const DEFAULT_PINS = "eval/continuation-acceptance-1a3b/pins.json";
const DEFAULT_OUT = "eval/continuation-acceptance-1a3b/run/continuation-incumbent.json";
const DEFAULT_HARD_GATES_OUT =
  "eval/continuation-acceptance-1a3b/run/continuation-incumbent-hard-gates.json";
const CONFIG_ID = F3_INCUMBENT_CONFIG_ID;
const GROUP = "continuation" as const;
const USER_ID = asUserId(uuidFrom("synthetic-user"));

type ParsedArguments = Readonly<{
  catalog: string;
  continueOnError: boolean;
  deterministic: boolean;
  hardGatesOut: string;
  only: string | null;
  out: string;
  pins: string;
}>;

function parseArguments(): ParsedArguments {
  const arguments_ = process.argv.slice(2);
  const values = {
    catalog: DEFAULT_CATALOG,
    continueOnError: false,
    deterministic: false,
    hardGatesOut: DEFAULT_HARD_GATES_OUT,
    only: null as string | null,
    out: DEFAULT_OUT,
    pins: DEFAULT_PINS,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--catalog") values.catalog = required(arguments_, ++index, argument);
    else if (argument === "--continue-on-error") values.continueOnError = true;
    else if (argument === "--deterministic") values.deterministic = true;
    else if (argument === "--hard-gates-out") values.hardGatesOut = required(arguments_, ++index, argument);
    else if (argument === "--only") values.only = required(arguments_, ++index, argument);
    else if (argument === "--out") values.out = required(arguments_, ++index, argument);
    else if (argument === "--pins") values.pins = required(arguments_, ++index, argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return values;
}

function required(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

/** Deterministic RFC 9562 UUIDv7-shaped id derived from a seed string. */
function uuidFrom(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  const characters = hash.split("");
  characters[12] = "7";
  characters[16] = "8";
  return [
    characters.slice(0, 8).join(""),
    characters.slice(8, 12).join(""),
    characters.slice(12, 16).join(""),
    characters.slice(16, 20).join(""),
    characters.slice(20, 32).join(""),
  ].join("-");
}

const BASE_TIME_MS = Date.UTC(2026, 8, 12, 0, 0, 0);

function createClock(): () => Date {
  let tick = 0;
  return () => new Date(BASE_TIME_MS + tick++ * 1_000);
}

function claimKindOf(kind: "objective_memory" | "ai_impression" | "person_portrait"): ClaimKind {
  return kind === "ai_impression" ? "impression" : "objective";
}

function toMemoryItem(input: {
  claimId: string;
  evidenceIds: readonly string[];
  kind: ClaimKind;
  memoryRef: string;
  predicateId: string;
  renderedText: string;
  selectionSource: MemoryContextItem["selectionSource"];
}): MemoryContextItem {
  return {
    claimId: input.claimId,
    claimVersionId: uuidFrom(`version:${input.claimId}`),
    contextMemoryRef: input.memoryRef,
    entityVersionIds: [],
    epistemicStatus: input.kind === "impression" ? "inferred" : "confirmed",
    evidenceIds: [...input.evidenceIds],
    kind: input.kind,
    predicateId: input.predicateId,
    recallFramingPolicyVersion: RECALL_FRAMING_POLICY_VERSION,
    renderedText: input.renderedText,
    selectionSource: input.selectionSource,
    temporalStatus: "current",
    validFrom: null,
    validTo: null,
  };
}

function buildMemorySections(
  sharedInput: FrozenSharedInput,
): Readonly<Record<MemorySectionKey, readonly MemoryContextItem[]>> {
  const sections: Record<MemorySectionKey, MemoryContextItem[]> = {
    ai_impression: [],
    objective_memory: [],
    person_portrait: [],
  };
  for (const memory of sharedInput.memory) {
    const section: MemorySectionKey =
      memory.kind === "ai_impression" ? "ai_impression" : "objective_memory";
    sections[section].push(
      toMemoryItem({
        claimId: memory.id,
        evidenceIds: memory.evidenceIds,
        kind: claimKindOf(memory.kind),
        memoryRef: `shh-memory-${memory.id}`,
        predicateId: `syn-predicate:${memory.id}`,
        renderedText: memory.text,
        selectionSource: "query_retrieval",
      }),
    );
  }
  for (const portrait of sharedInput.portrait) {
    sections.person_portrait.push(
      toMemoryItem({
        claimId: portrait.claimId,
        evidenceIds: [],
        kind: claimKindOf(portrait.kind),
        memoryRef: `shh-memory-${portrait.id}`,
        predicateId: `syn-predicate:${portrait.id}`,
        renderedText: portrait.text,
        selectionSource: "person_portrait",
      }),
    );
  }
  return sections;
}

function buildRetrievalManifest(
  sharedInput: FrozenSharedInput,
  retrievalRunId: string,
  memorySections: Readonly<Record<MemorySectionKey, readonly MemoryContextItem[]>>,
): RetrievalRunManifest {
  const selected = sharedInput.retrieval.filter((entry) => entry.selected);
  const actualItems = MEMORY_SECTION_KEYS.reduce(
    (total, key) => total + memorySections[key].length,
    0,
  );
  const portraitCount = memorySections.person_portrait.length;
  const actualImpressions = MEMORY_SECTION_KEYS.reduce(
    (total, key) =>
      total + memorySections[key].filter((item) => item.kind === "impression").length,
    0,
  );
  return {
    candidate_count: sharedInput.retrieval.length,
    deadline_exceeded_stage: null,
    deadline_ms: 1_000,
    degraded_reason_codes: [],
    duration_ms: 1,
    fenced_out_count: 0,
    lane_hit_counts: {
      english_fts: 0,
      lexical_term_overlap: 0,
      structured_exact: 0,
    },
    lane_plan: RETRIEVAL_LANE_PRIORITY.map((lane) => ({
      enabled: true,
      lane,
      notEnabledReason: null,
    })),
    normalized_query_terms: {
      canonical_keys: [],
      date_tokens: [],
      lexical_terms: [],
      predicate_candidates: sharedInput.memory.map((entry) => entry.id),
      resolved_entities: [],
      time_word_classes: [],
    },
    portrait_degraded_reason_codes: [],
    portrait_selection: {
      pool_count: sharedInput.portrait.length,
      selected_claim_version_ids: memorySections.person_portrait.map(
        (item) => item.claimVersionId,
      ),
    },
    projection_policy_version: CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
    qualified_count: selected.length,
    query_construction_policy_version:
      RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
    query_source_refs: [],
    retrieval_policy_version: MEMORY_RETRIEVAL_POLICY_VERSION,
    retrieval_run_id: retrievalRunId,
    section_budget_vs_actual: {
      memory_class_total: { actual_items: actualItems, ceiling_items: 5 },
      person_portrait: {
        actual_impressions: memorySections.person_portrait.filter(
          (item) => item.kind === "impression",
        ).length,
        actual_items: portraitCount,
        ceiling_impressions: 2,
        ceiling_items: 3,
      },
      query_retrieved: {
        actual_impressions: actualImpressions,
        actual_items: actualItems - portraitCount,
        ceiling_impressions: 1,
        ceiling_items: 2,
      },
    },
    selection_policy_versions: {
      memory_budgets: MEMORY_BUDGETS_POLICY_VERSION,
      portrait_selection: PORTRAIT_SELECTION_POLICY_VERSION,
      recall_framing: RECALL_FRAMING_POLICY_VERSION,
    },
    timings: {},
    zero_signal: false,
  };
}

type ScenarioCapture = Readonly<{
  fixture: ContinuationFixture;
  turns: readonly SyntheticRunTurn[];
}>;

type ProviderErrorReport = Readonly<{
  category: string | null;
  fixtureId: string;
  message: string;
  sequenceInScenario: number;
}>;

type Seam = Readonly<{
  clock: () => Date;
  compiler: ReturnType<typeof createContextCompiler>;
  harness: ConversationAgentHarness;
  lastEgressError: () => Error | null;
  memoryState: { fixtureId: string; sharedInput: FrozenSharedInput | null };
  registerSnapshot: (
    generationCommandId: string,
    snapshot: ContextSourceSnapshot,
  ) => void;
}>;

function createSeam(input: {
  adapter:
    | Readonly<{
        apiKey: string;
        baseUrl: string;
        timeoutMs: number;
        type: "responses-api";
      }>
    | Readonly<{ chunks: readonly string[]; type: "deterministic" }>;
  champion: ConversationTextChampion;
}): Seam {
  const clock = createClock();
  const renderSources = new Map<string, CompiledContextRenderSource>();
  const snapshots = new Map<string, ContextSourceSnapshot>();
  // The Daily-Session-scoped Safety Posture projection, mirroring
  // `current_safety_postures`: at most one current version per session, read by
  // loadContextSource and advanced by the deterministic turn transition at the
  // response-commit boundary.
  const safetyPostures = new Map<string, CurrentSafetyPosture>();
  const memoryState: { fixtureId: string; sharedInput: FrozenSharedInput | null } = {
    fixtureId: "",
    sharedInput: null,
  };
  let lastEgressError: Error | null = null;

  const repository: ContextCompilerRepository &
    ProviderEgressRepository &
    ConversationAgentHarnessRepository = {
    claimDispatch: async (claimInput): Promise<ProviderEgressClaim> => {
      const context = renderSources.get(String(claimInput.compiledContextId));
      if (!context) {
        return { category: "configuration", outcome: "blocked" };
      }
      return { context, model: input.champion.model, outcome: "permitted" };
    },
    claimResponseExecution: async () => "owner",
    claimStaleResponseExecution: async () => ({ outcome: "terminal" }),
    commitActionDecision: async () => undefined,
    commitCompleteResponse: async (commitInput) => {
      const snapshot = snapshots.get(String(commitInput.generationCommandId));
      if (snapshot) {
        const sessionId = String(snapshot.dailySession.id);
        const previous = safetyPostures.get(sessionId) ?? null;
        const currentUser = snapshot.events.find(
          (event) => event.revisionId === snapshot.inputRevisionId,
        );
        const detected = minimumHighRiskSafetyPostureDetector({
          locale: snapshot.locale,
          text: currentUser?.text ?? "",
        });
        const applied = applySafetyPostureTurn({
          cleanTurnsToRelease: SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE,
          content: previous?.content ?? null,
          currentUserEventRevisionId: snapshot.inputRevisionId,
          detected,
        });
        if (applied !== null) {
          validateSafetyPostureContent(applied);
          const versionNo = (previous?.versionNo ?? 0) + 1;
          safetyPostures.set(sessionId, {
            content: applied,
            id: uuidFrom(`${sessionId}:safety-posture:${versionNo}`),
            policyVersion: SAFETY_POSTURE_POLICY_VERSION,
            sourceRevision: snapshot.sourceRevision,
            versionNo,
          });
        }
      }
      return {
        eventId: asConversationEventId(uuidFrom(`${commitInput.generationCommandId}:event`)),
        outcome: "committed",
        revisionId: asConversationEventRevisionId(
          uuidFrom(`${commitInput.generationCommandId}:revision`),
        ),
      };
    },
    loadContextSource: async (loadInput) => {
      const snapshot = snapshots.get(String(loadInput.generationCommandId));
      if (!snapshot) {
        throw new Error(
          `No frozen Context source registered for ${loadInput.generationCommandId}.`,
        );
      }
      const safetyPosture =
        safetyPostures.get(String(snapshot.dailySession.id)) ?? null;
      return { ...snapshot, safetyPosture };
    },
    loadResponse: async () => ({ outcome: "prepared" }),
    recordFirstToken: async () => true,
    recordProviderCompletion: async () => true,
    saveCompiledContext: async (saveInput) => {
      const compiledContextId = uuidFrom(
        `${saveInput.generationCommandId}:compiled-context`,
      );
      const stage =
        snapshots.get(String(saveInput.generationCommandId))?.generationStage ??
        "decision";
      const renderSource: CompiledContextRenderSource = {
        compilerVersion: saveInput.compilerVersion,
        generationStage: stage,
        integrity: saveInput.integrity,
        locale: saveInput.locale,
        policyVersions: saveInput.policyVersions,
        referencedEvents: saveInput.referencedEvents,
        rollingSummary: saveInput.rollingSummary,
        sections: saveInput.sections,
        totalTokens: saveInput.totalTokens,
        ...(saveInput.actionReferenceHandles === undefined
          ? {}
          : { actionReferenceHandles: saveInput.actionReferenceHandles }),
      };
      renderSources.set(compiledContextId, renderSource);
      const compiled: CompiledContext = {
        degradedReason: saveInput.degradedReason,
        dialogueRevision: saveInput.dialogueRevision,
        id: asCompiledContextId(compiledContextId),
        locale: saveInput.locale,
        referencedRevisionIds: saveInput.referencedEvents.map(
          (event) => event.revisionId,
        ),
        sourceRevision: saveInput.sourceRevision,
        statistics: {
          rawEventBudgetTokens: saveInput.sectionBudgets.committedRawEvents,
          selectedEventCount: saveInput.referencedEvents.length,
          totalTokens: saveInput.totalTokens,
        },
      };
      return compiled;
    },
    settleResponseFailure: async (failureInput) => ({
      category: failureInput.category,
      outcome: "settled",
      status: failureInput.interrupted ? "interrupted" : "failed",
    }),
  };

  const memoryRetrieval: MemoryRetrievalPort = {
    async run(): Promise<MemoryRetrievalRunOutcome> {
      const sharedInput = memoryState.sharedInput;
      if (!sharedInput) {
        throw new Error("Memory retrieval ran without a frozen shared input.");
      }
      const memorySections = buildMemorySections(sharedInput);
      const retrievalRunId = uuidFrom(
        `${memoryState.fixtureId}:retrieval:${retrievalRunIdTick++}`,
      );
      return {
        degradedReasonCodes: [],
        manifest: buildRetrievalManifest(sharedInput, retrievalRunId, memorySections),
        memorySections,
        retrievalRunId,
        status: "completed",
      };
    },
  };

  const compiler = createContextCompiler({
    clock,
    compilerVersion: "context-compiler:v1",
    contentHmacSecret: "synthetic-context-integrity-secret",
    memoryRetrieval,
    rawEventTokenBudget: 4_000,
    repository,
  });
  const baseEgress = createRuntimeProviderEgressPort({
    adapter: input.adapter,
    champion: input.champion,
    clock,
    contextCompiler: compiler,
    repository,
  });
  const egressPort: ProviderEgressPort = {
    async *stream(streamInput) {
      try {
        yield* baseEgress.stream(streamInput);
      } catch (error) {
        lastEgressError =
          error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    },
  };
  const harness = createConversationAgentHarness({
    clock,
    contextCompiler: compiler,
    egressPort,
    repository,
  });

  return {
    clock,
    compiler,
    harness,
    lastEgressError: () => lastEgressError,
    memoryState,
    registerSnapshot: (generationCommandId, snapshot) => {
      snapshots.set(generationCommandId, snapshot);
    },
  };
}

let retrievalRunIdTick = 0;

function policyVersionsFor(sharedInput: FrozenSharedInput): ContextPolicyVersions {
  const locale = sharedInput.config.locale;
  const localePolicyVersion =
    locale.toLowerCase().includes("zh") || locale.toLowerCase().includes("en")
      ? locale
      : ENGLISH_LOCALE_PACK_VERSION;
  return {
    canonicalPersonaVersion: sharedInput.config.persona || CANONICAL_PERSONA_VERSION,
    localePolicyVersion,
    outputFormatVersion: "conversation-output:v1",
    personaBehaviorAnchorsVersion: PERSONA_BEHAVIOR_ANCHORS_VERSION,
    personaContractInvariantVersion: PERSONA_CONTRACT_INVARIANT_VERSION,
    productPolicyVersion: "product-policy:v1",
    relationshipPolicyVersion: "relationship-boundary:v1",
    safetyPolicyVersion: "minimum-high-risk-response:v1",
    taskInstructionVersion: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  };
}

function createHarnessPolicy(): ConversationHarnessPolicy {
  return {
    ...CATALOG_V2_CONVERSATION_HARNESS_POLICY,
    toolsDisabled: true,
  };
}

async function captureFixture(input: {
  champion: ConversationTextChampion;
  continueOnError: boolean;
  deterministic: boolean;
  fixture: ContinuationFixture;
  providerErrors: ProviderErrorReport[];
  responsesApiAdapter: Readonly<{
    apiKey: string;
    baseUrl: string;
    timeoutMs: number;
  }>;
  sharedInput: FrozenSharedInput;
}): Promise<ScenarioCapture> {
  const seam = createSeam({
    adapter: input.deterministic
      ? { chunks: ["好的。"], type: "deterministic" }
      : {
          apiKey: input.responsesApiAdapter.apiKey,
          baseUrl: input.responsesApiAdapter.baseUrl,
          timeoutMs: input.responsesApiAdapter.timeoutMs,
          type: "responses-api",
        },
    champion: input.champion,
  });
  const harnessPolicy = createHarnessPolicy();

  const frozenEvents: ContextSourceEvent[] = input.sharedInput.events.map(
    (event, index) => ({
      actor: "user",
      locale: event.locale,
      revisionId: asConversationEventRevisionId(
        uuidFrom(`${input.fixture.id}:frozen:${index}`),
      ),
      sequence: index + 1,
      text: event.text,
    }),
  );
  const committed: ContextSourceEvent[] = [...frozenEvents];
  let sequence = frozenEvents.length;
  const turns: SyntheticRunTurn[] = [];

  for (const fixtureTurn of input.fixture.turns) {
    seam.memoryState.fixtureId = input.fixture.id;
    seam.memoryState.sharedInput = input.sharedInput;

    sequence += 1;
    const userSequence = sequence;
    const userRevisionId = asConversationEventRevisionId(
      uuidFrom(`${input.fixture.id}:t${fixtureTurn.sequenceInScenario}:user`),
    );
    const currentUser: ContextSourceEvent = {
      actor: "user",
      locale: fixtureTurn.userInput.locale,
      revisionId: userRevisionId,
      sequence: userSequence,
      text: fixtureTurn.userInput.text,
    };
    const generationCommandId = String(
      asGenerationCommandId(
        uuidFrom(`${input.fixture.id}:t${fixtureTurn.sequenceInScenario}:command`),
      ),
    );
    const interactionTurnId = asInteractionTurnId(
      uuidFrom(`${input.fixture.id}:t${fixtureTurn.sequenceInScenario}:turn`),
    );
    const modelRunAttemptId = asModelRunAttemptId(
      uuidFrom(`${input.fixture.id}:t${fixtureTurn.sequenceInScenario}:attempt`),
    );

    const snapshot: ContextSourceSnapshot = {
      dailySession: {
        activityState: "active",
        closurePolicyVersion: "continuous-exchange-inactivity:v1",
        continuousExchangeNo: 1,
        id: asDailySessionId(uuidFrom(`${input.fixture.id}:daily-session`)),
      },
      dialogueRevision: 0,
      events: [...committed, currentUser],
      generationStage: "decision",
      inputRevisionId: userRevisionId,
      locale: input.fixture.locale,
      policyVersions: policyVersionsFor(input.sharedInput),
      rollingSummary: null,
      sourceRevision: 1,
    };
    seam.registerSnapshot(generationCommandId, snapshot);

    const compiled = await seam.compiler.compile({
      generationCommandId: asGenerationCommandId(generationCommandId),
      interactionTurnId,
      userId: USER_ID,
    });

    let assistantText = "";
    let failedCategory: string | null = null;
    for await (const event of seam.harness.runDecision({
      catalog: MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
      catalogVersion: MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG.version,
      compiledContextId: compiled.id,
      generationCommandId: asGenerationCommandId(generationCommandId),
      harnessPolicy,
      interactionTurnId,
      modelRunAttemptId,
      requestEventRevisionId: userRevisionId,
      userId: USER_ID,
    })) {
      if (event.type === "decision_delta") {
        assistantText += event.delta;
      } else if (event.type === "decision_failed") {
        failedCategory = event.category;
      }
    }

    if (failedCategory !== null) {
      input.providerErrors.push({
        category: failedCategory,
        fixtureId: input.fixture.id,
        message: seam.lastEgressError()?.message ?? "no provider error message",
        sequenceInScenario: fixtureTurn.sequenceInScenario,
      });
    }

    turns.push({
      assistantText,
      sequenceInScenario: fixtureTurn.sequenceInScenario,
      userInput: fixtureTurn.userInput,
    });
    console.log(
      `[f3-synthetic-capture] ${input.fixture.id} t${fixtureTurn.sequenceInScenario}: ${
        failedCategory === null ? `${assistantText.length} chars` : `FAILED ${failedCategory}`
      }`,
    );

    committed.push(currentUser);
    sequence += 1;
    committed.push({
      actor: "assistant",
      locale: input.fixture.locale,
      revisionId: asConversationEventRevisionId(
        uuidFrom(`${input.fixture.id}:t${fixtureTurn.sequenceInScenario}:assistant`),
      ),
      sequence,
      text: assistantText,
    });

    if (failedCategory !== null && !input.continueOnError) break;
  }

  return { fixture: input.fixture, turns };
}

function shiftForLocale(locale: string): void {
  // Kept as an explicit seam for future locale-specific normalization.
  void locale;
}

async function main(): Promise<void> {
  const environment = (() => {
    loadDotEnv();
    return process.env;
  })();
  const arguments_ = parseArguments();
  const catalog = JSON.parse(
    await readFile(resolve(arguments_.catalog), "utf8"),
  ) as unknown as FixtureCatalog;
  const pins = JSON.parse(
    await readFile(resolve(arguments_.pins), "utf8"),
  ) as unknown as F3Pins;
  const { champion, conversationAdapter } = buildChampionAssembly(environment);
  if (conversationAdapter.type !== "responses-api") {
    throw new Error("The champion assembly did not return a responses-api adapter.");
  }
  if (!arguments_.deterministic && !conversationAdapter.apiKey) {
    throw new Error("A provider API key is required for the real capture.");
  }
  const continuations = catalog.scenarios.filter(
    (fixture): fixture is ContinuationFixture => fixture.group === "continuation",
  );
  console.log(
    `[f3-synthetic-capture] provider=${arguments_.deterministic ? "deterministic" : champion.provider} model=${champion.model} fixtures=${continuations.length}`,
  );

  const providerErrors: ProviderErrorReport[] = [];
  const scenarios: SyntheticRun["scenarios"][number][] = [];
  for (const fixture of continuations) {
    if (arguments_.only && fixture.id !== arguments_.only) continue;
    const sharedInput = catalog.sharedInputs[fixture.inputRef];
    if (!sharedInput) {
      providerErrors.push({
        category: "configuration",
        fixtureId: fixture.id,
        message: `Missing frozen shared input ${fixture.inputRef}.`,
        sequenceInScenario: 0,
      });
      continue;
    }
    shiftForLocale(fixture.locale);
    try {
      const captured = await captureFixture({
        champion,
        continueOnError: arguments_.continueOnError,
        deterministic: arguments_.deterministic,
        fixture,
        providerErrors,
        responsesApiAdapter: {
          apiKey: conversationAdapter.apiKey,
          baseUrl: conversationAdapter.baseUrl,
          timeoutMs: conversationAdapter.timeoutMs,
        },
        sharedInput,
      });
      scenarios.push({
        fixtureId: captured.fixture.id,
        promptFingerprint: null,
        sharedInputFingerprint: sha256(sharedInput),
        turns: captured.turns,
      });
    } catch (error) {
      providerErrors.push({
        category: "harness",
        fixtureId: fixture.id,
        message: error instanceof Error ? error.message : String(error),
        sequenceInScenario: 0,
      });
      console.error(`[f3-synthetic-capture] ${fixture.id} aborted:`, error);
      if (!arguments_.continueOnError) break;
    }
  }

  const run: SyntheticRun = {
    arm: CONFIG_ID,
    catalogVersion: catalog.version,
    configurationFingerprint: configurationFingerprint(pins, GROUP, CONFIG_ID),
    configId: CONFIG_ID,
    format: F3_RUN_VERSION,
    group: GROUP,
    scenarios,
    sourceKind: "synthetic-eval",
    synthetic: true,
    version: F3_RUN_VERSION,
  };

  await mkdir(dirname(resolve(arguments_.out)), { recursive: true });
  await writeFile(resolve(arguments_.out), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  const report = verifySyntheticRunHardGates(catalog, run);
  await mkdir(dirname(resolve(arguments_.hardGatesOut)), { recursive: true });
  await writeFile(
    resolve(arguments_.hardGatesOut),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `[f3-synthetic-capture] wrote ${scenarios.length}/${continuations.length} scenarios to ${arguments_.out}`,
  );
  console.log(
    `[f3-synthetic-capture] hard gates: checked=${report.checkedFixtureCount} passed=${report.passed} failures=${report.failures.length}`,
  );
  for (const failure of report.failures) {
    console.log(`[f3-synthetic-capture]   - ${failure}`);
  }
  if (providerErrors.length > 0) {
    console.log(
      `[f3-synthetic-capture] provider errors: ${providerErrors.length}`,
    );
    for (const error of providerErrors) {
      console.log(
        `[f3-synthetic-capture]   - ${error.fixtureId} t${error.sequenceInScenario} [${error.category}]: ${error.message}`,
      );
    }
  }
  if (scenarios.length !== continuations.length || providerErrors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("[f3-synthetic-capture] failed:", error);
  process.exitCode = 1;
});
