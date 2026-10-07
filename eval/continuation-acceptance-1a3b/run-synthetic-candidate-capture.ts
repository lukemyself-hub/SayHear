/**
 * F3 candidate-arm continuation capture for the 1A.3b G2 gate (issue #207).
 *
 * Mirrors `run-synthetic-capture.ts` (incumbent arm) but runs every
 * `continuation` fixture through the bundle-enabled seam: the REAL
 * `open_loop.extract` runner evolves the open-loop lane from the frozen
 * Events (production formation/closure code, in-memory repositories), and
 * the REAL `ProactiveFollowupSegmentStage` may append an isolated segment
 * behind the same harness that renders the main response. The OFF arm never
 * touches the lanes, so shared inputs stay identical across arms (SPEC #193
 * §14.4); only bundle participation differs.
 *
 * Lane-seeding rules (deterministic projections of frozen input, no
 * fabrication):
 * - Open-loop candidates come only from the production runner over frozen
 *   Events. Memory turns stay segment-free by construction in 2c scope (the
 *   memory candidate pipeline is deferred; the stage hard-disables the
 *   memory lane), which doubles as a regression guard.
 * - Suppression starts empty per fixture (`never_suppressed`, ADR-0044) and
 *   is sticky within the fixture run: the seam records stop signals but
 *   never time-releases them. Cooldown release is production-repository
 *   behavior outside this seam's scope.
 * - Dialogue focus is a fixed category map: `direct_task` and `high_risk`
 *   require focus (no segment: correct-zero and safety deference), every
 *   other category does not. The map is scaffolding, not policy.
 *
 * Usage:
 *   tsx eval/continuation-acceptance-1a3b/run-synthetic-candidate-capture.ts \
 *     [--deterministic] [--only <fixtureId>] [--continue-on-error] \
 *     [--catalog <path>] [--pins <path>] [--out <path>] \
 *     [--hard-gates-out <path>] [--lanes-out <path>]
 *
 * The deterministic double proves the plumbing without network calls: the
 * stub extract provider yields no loops, so no segment is produced and the
 * transcript must equal the incumbent main response turn for turn.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  CANONICAL_PERSONA_VERSION,
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  createConversationAgentHarness,
  createContextCompiler,
  createProactiveFollowupSegmentStage,
  ENGLISH_LOCALE_PACK_VERSION,
  MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
  MEMORY_BUDGETS_POLICY_VERSION,
  MEMORY_RETRIEVAL_POLICY_VERSION,
  MEMORY_SECTION_KEYS,
  minimumHighRiskSafetyPostureDetector,
  applySafetyPostureTurn,
  ONE_A_3B_ROLE_POLICIES,
  ONE_A_3B_ROLE_POLICY_VERSION,
  OPEN_LOOP_EXTRACTION_POLICY_VERSION,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  PORTRAIT_SELECTION_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
  RECALL_FRAMING_POLICY_VERSION,
  RETRIEVAL_LANE_PRIORITY,
  RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
  runOpenLoopExtractAttempt,
  SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE,
  SAFETY_POSTURE_POLICY_VERSION,
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
  type ModelRoleCommandService,
  type ModelRoleConfigurationSnapshot,
  type ModelRoleProviderEgress,
  type OneA3bModelRole,
  type OpenLoopExtractionRepository,
  type OpenLoopExtractModelProvider,
  type ProactiveFollowupDialogueSnapshot,
  type ProactiveFollowupLaneSnapshot,
  type ProactiveFollowupModelProvider,
  type ProactiveFollowupPendingUse,
  type ProactiveFollowupStageReaders,
  type ProactiveFollowupStateSnapshot,
  type ProactiveFollowupReservationStore,
  type ProactiveFollowupTurnContext,
  type ProviderEgressClaim,
  type ProviderEgressPort,
  type ProviderEgressRepository,
  type RetrievalRunManifest,
} from "@sayhear/application";
import {
  createRuntimeProviderEgressPort,
  createRuntimeOneA3bRoleProviders,
  type OneA3bProviderAdapter,
} from "@sayhear/ai";
import {
  asCompiledContextId,
  asConversationEventId,
  asConversationEventRevisionId,
  asDailySessionId,
  asEvidenceItemId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asOpenLoopId,
  asUserId,
} from "@sayhear/domain";

import { buildChampionAssembly, loadDotEnv } from "../memory-pairwise-126/shared";
import type { TwinConversationAdapter } from "../memory-pairwise-126/twin-harness";
import {
  F3_RUN_VERSION,
  configurationFingerprint,
  sha256,
  type ContinuationFixture,
  type FixtureCatalog,
  type F3Pins,
  type FrozenSharedInput,
  type SyntheticRun,
  type SyntheticRunTurn,
  F3_BUNDLE_CANDIDATE_CONFIG_ID,
} from "./protocol";
import { verifySyntheticRunHardGates } from "./review-package";

const DEFAULT_CATALOG = "eval/continuation-acceptance-1a3b/fixtures.json";
const DEFAULT_PINS = "eval/continuation-acceptance-1a3b/pins.json";
const DEFAULT_OUT = "eval/continuation-acceptance-1a3b/run/continuation-candidate.json";
const DEFAULT_HARD_GATES_OUT =
  "eval/continuation-acceptance-1a3b/run/continuation-candidate-hard-gates.json";
const DEFAULT_LANES_OUT =
  "eval/continuation-acceptance-1a3b/run/continuation-candidate-lanes.json";
const CONFIG_ID = F3_BUNDLE_CANDIDATE_CONFIG_ID;
const GROUP = "continuation" as const;
const USER_ID = asUserId(uuidFrom("synthetic-user"));

/**
 * Fixture categories whose current request requires focus, so the bundle
 * must stay out of the turn. `direct_task` exercises the correct-zero
 * contract; `high_risk` exercises safety deference. Every other category
 * leaves the focus gate open and lets selection decide.
 */
const FOCUS_REQUIRED_CATEGORIES = new Set(["direct_task", "high_risk"]);

type ParsedArguments = Readonly<{
  catalog: string;
  continueOnError: boolean;
  deterministic: boolean;
  hardGatesOut: string;
  lanesOut: string;
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
    lanesOut: DEFAULT_LANES_OUT,
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
    else if (argument === "--lanes-out") values.lanesOut = required(arguments_, ++index, argument);
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

/**
 * Expand a pins identity label into a full configuration snapshot. Lifecycle
 * fields come from the frozen role policy, never from the pins: the registry
 * rejects anything else. A pins/policy disagreement fails loudly here
 * instead of silently running an unevaluated configuration.
 */
function snapshotFor(
  role: OneA3bModelRole,
  pins: F3Pins,
): ModelRoleConfigurationSnapshot {
  const pin = pins.roles[role];
  if (!pin) throw new Error(`Pins file has no ${role} role.`);
  if (pin.provider !== "deepseek" && pin.provider !== "opencode-go") {
    throw new Error(`Capture supports the pinned deepseek or opencode-go provider, found ${pin.provider} for ${role}.`);
  }
  if (pin.fallback !== "none") {
    throw new Error(`Capture requires fallback none, found ${pin.fallback} for ${role}.`);
  }
  const temperature = pin.parameters.temperature;
  const maxOutputTokens = pin.parameters.maxOutputTokens;
  if (typeof temperature !== "number" || typeof maxOutputTokens !== "number") {
    throw new Error(`Pins parameters for ${role} must carry numeric temperature and maxOutputTokens.`);
  }
  const policy = ONE_A_3B_ROLE_POLICIES[role];
  if (pin.maxTechnicalRetries !== policy.maxTechnicalRetries) {
    throw new Error(
      `Pins disagree with the frozen role policy for ${role}: pins maxTechnicalRetries ${pin.maxTechnicalRetries}, policy ${policy.maxTechnicalRetries}.`,
    );
  }
  return {
    role,
    configVersion: `${role}:eval-candidate:v1`,
    provider: pin.provider,
    model: pin.model,
    modelSnapshot: pin.snapshot,
    promptVersion: pin.promptVersion,
    schemaVersion: pin.schemaVersion,
    rolePolicyVersion: ONE_A_3B_ROLE_POLICY_VERSION,
    providerPolicyVersion: `${pin.provider}-${role}-egress:candidate:v1`,
    rolloutPin: `${role}-candidate-pin:v1`,
    freshnessPolicy: policy.freshnessPolicy,
    fallbackMode: "disabled",
    maxTechnicalRetries: policy.maxTechnicalRetries,
    maxSemanticRepairs: policy.maxSemanticRepairs,
    parameterSnapshot: {
      budgetPolicyVersion: "eval-candidate-budget:v1",
      providerCallBudget: 4,
      temperature,
      maxOutputTokens,
    },
  };
}

/** In-memory model-role command service: every admission is unique, every attempt stays ready. */
function createCommandService(
  configurations: Readonly<Record<string, ModelRoleConfigurationSnapshot>>,
): ModelRoleCommandService {
  return {
    admit: async (input) => ({
      outcome: "created",
      generationCommandId: asGenerationCommandId(uuidFrom(`admit:${input.intentKey}`)),
      modelRunAttemptId: asModelRunAttemptId(uuidFrom(`attempt:${input.intentKey}`)),
      workflowCommandId: null,
      attemptNo: 1,
      attemptKind: "initial",
      intentKey: input.intentKey,
    }),
    configuration: (role) => configurations[role] ?? null,
    validateAttempt: async () => ({ outcome: "ready" }),
    claimProviderDispatch: async () => ({ outcome: "ready" }),
    discardAttempt: async (input) => ({
      outcome: "discarded" as const,
      generationCommandId: input.generationCommandId,
      modelRunAttemptId: input.modelRunAttemptId,
    }),
    recordAttemptResult: async (input) => ({
      outcome: input.outcome === "succeeded" ? ("succeeded" as const) : ("failed" as const),
      generationCommandId: input.generationCommandId,
      modelRunAttemptId: input.modelRunAttemptId,
    }),
  };
}

type FormedLoop = Readonly<{
  loopId: string;
  kind: "upcoming_event" | "awaited_outcome";
  sourceEventRevisionId: string;
  localizedSummary: string | null;
  expectedStartAt: string | null;
  expiresAt: string;
  closed: boolean;
}>;

/** In-memory open-loop lane: frozen Events in, production runner effects stored. */
function createLaneRepository(): OpenLoopExtractionRepository & {
  registerEvent(event: Readonly<{
    revisionId: string;
    locale: string;
    timeZone: string;
    text: string;
  }>): void;
  loops(): readonly FormedLoop[];
  noteExtractError(revisionId: string): void;
  extractErrored(revisionId: string): boolean;
} {
  const events = new Map<string, { locale: string; timeZone: string; text: string }>();
  const settled = new Set<string>();
  const errored = new Set<string>();
  const loops: FormedLoop[] = [];
  let loopTick = 0;
  return {
    registerEvent: (event) => {
      events.set(event.revisionId, { locale: event.locale, timeZone: event.timeZone, text: event.text });
    },
    loops: () => loops,
    noteExtractError: (revisionId) => {
      errored.add(revisionId);
    },
    extractErrored: (revisionId) => errored.has(revisionId),
    listEventsNeedingExtraction: async () => {
      const pending: { eventRevisionId: string; userId: typeof USER_ID; sourceRevision: number; expectedDataEpoch: number }[] = [];
      for (const [revisionId] of events) {
        if (!settled.has(revisionId) && !errored.has(revisionId)) {
          pending.push({ eventRevisionId: revisionId, userId: USER_ID, sourceRevision: 1, expectedDataEpoch: 1 });
        }
      }
      return pending;
    },
    readExtractionSnapshot: async (readInput) => {
      const event = events.get(readInput.eventRevisionId);
      if (!event || settled.has(readInput.eventRevisionId)) return { outcome: "stale" };
      return {
        outcome: "ready",
        snapshot: {
          userId: USER_ID,
          eventRevisionId: readInput.eventRevisionId,
          sourceRevision: 1,
          expectedDataEpoch: 1,
          locale: event.locale,
          timeZone: event.timeZone,
          userText: event.text,
          evidenceCommittedAt: new Date(BASE_TIME_MS).toISOString(),
          evidence: [
            {
              evidenceItemId: asEvidenceItemId(uuidFrom(`evidence:${readInput.eventRevisionId}`)),
              revisionId: readInput.eventRevisionId,
              locatorType: "conversation_event_revision",
              locatorKey: readInput.eventRevisionId,
              committedAt: new Date(BASE_TIME_MS).toISOString(),
            },
          ],
          identityCandidates: loops
            .filter((loop) => !loop.closed)
            .map((loop) => ({
              openLoopId: asOpenLoopId(loop.loopId),
              kind: loop.kind,
              canonicalClaimKey: null,
              expectedStartAt: loop.expectedStartAt,
              expectedEndAt: null,
            })),
          currentOpenCount: loops.filter((loop) => !loop.closed).length,
        },
      };
    },
    readAttemptEventRevision: async () => ({ outcome: "not_found" }),
    commitEventEffects: async (commitInput) => {
      for (const formation of commitInput.formations) {
        loopTick += 1;
        loops.push({
          loopId: `loop:${commitInput.sourceEventRevisionId}:${loopTick}`,
          kind: formation.kind,
          sourceEventRevisionId: commitInput.sourceEventRevisionId,
          localizedSummary: formation.localizedSummary,
          expectedStartAt: formation.expectedStartAt,
          expiresAt: formation.expiresAt,
          closed: false,
        });
      }
      for (const closure of commitInput.closures) {
        const index = loops.findIndex((loop) => loop.loopId === closure.targetOpenLoopId);
        if (index >= 0) {
          const target = loops[index];
          if (target) loops.splice(index, 1, { ...target, closed: true });
        }
      }
      settled.add(commitInput.sourceEventRevisionId);
      return {
        outcome: "settled",
        formed: commitInput.formations.length,
        closed: commitInput.closures.length,
        suppressed: commitInput.ambiguousSuppressedTargetIds.length,
      };
    },
  };
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
    predicateId: `syn-predicate:${input.claimId}`,
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

type LaneSidecarFixture = {
  fixtureId: string;
  formedLoops: readonly {
    loopId: string;
    kind: string;
    sourceEventRevisionId: string;
    expectedStartAt: string | null;
    expiresAt: string;
  }[];
  extractCalls: number;
  extractErrors: number;
  segmentsCommitted: number;
};

type SeamCursor = {
  fixture: ContinuationFixture;
  sequence: number;
  revisionId: string;
  interactionTurnId: ReturnType<typeof asInteractionTurnId>;
  snapshot: ContextSourceSnapshot | null;
};

function createSeam(input: {
  adapter:
    | Readonly<{
        apiKey: string;
        baseUrl: string;
        timeoutMs: number;
        type: "responses-api";
      }>
    | Readonly<{ apiKey: string; timeoutMs: number; type: "opencode-go" }>
    | Readonly<{ chunks: readonly string[]; type: "deterministic" }>;
  champion: ConversationTextChampion;
  commandService: ModelRoleCommandService;
  openLoopExtractProvider: OpenLoopExtractModelProvider | undefined;
  proactiveFollowupProvider: ProactiveFollowupModelProvider | undefined;
}): {
  clock: () => Date;
  compiler: { compile: (input: {
    generationCommandId: ReturnType<typeof asGenerationCommandId>;
    interactionTurnId: ReturnType<typeof asInteractionTurnId>;
    userId: typeof USER_ID;
  }) => Promise<CompiledContext> };
  harness: ConversationAgentHarness;
  lane: ReturnType<typeof createLaneRepository>;
  cursor: SeamCursor;
  eventTexts: Map<string, string>;
  laneLog: (fixtureId: string) => Omit<LaneSidecarFixture, "fixtureId" | "segmentsCommitted">;
  noteExtractCall: (success: boolean) => void;
  lastEgressError: () => Error | null;
  memoryState: { fixtureId: string; sharedInput: FrozenSharedInput | null };
  registerSnapshot: (generationCommandId: string, snapshot: ContextSourceSnapshot) => void;
} {
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
  const eventTexts = new Map<string, string>();
  const lane = createLaneRepository();
  const cursor: SeamCursor = {
    fixture: undefined as unknown as ContinuationFixture,
    sequence: 0,
    revisionId: "",
    interactionTurnId: asInteractionTurnId(uuidFrom("synthetic-cursor")),
    snapshot: null,
  };
  // Pending proactive uses within the fixture run, plus sticky suppression
  // states (no time-based release inside the seam).
  const pendingUses: (ProactiveFollowupPendingUse & { recorded: boolean })[] = [];
  const states = new Map<string, ProactiveFollowupStateSnapshot>();
  let lastEgressError: Error | null = null;
  let extractCalls = 0;
  let extractErrors = 0;

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
      const eventId = asConversationEventId(uuidFrom(`${commitInput.generationCommandId}:event`));
      const revisionId = asConversationEventRevisionId(
        uuidFrom(`${commitInput.generationCommandId}:revision`),
      );
      const segment = (commitInput as { proactiveSegment?: {
        plan: Pick<ProactiveFollowupPendingUse, "targetKind" | "targetId" | "targetVersionId" | "promptUserEventSequence">;
      } }).proactiveSegment;
      if (segment) {
        pendingUses.push({
          useId: `use:${commitInput.generationCommandId}`,
          assistantEventRevisionId: String(revisionId),
          targetKind: segment.plan.targetKind,
          targetId: segment.plan.targetId,
          targetVersionId: segment.plan.targetVersionId,
          promptUserEventSequence: segment.plan.promptUserEventSequence,
          promptDailySessionId: snapshot ? String(snapshot.dailySession.id) : "",
          recorded: false,
        });
      }
      return {
        createdAt: commitInput.completedAt.toISOString(),
        eventId,
        outcome: "committed",
        revisionId,
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

  const turnContext = (): ProactiveFollowupTurnContext => ({
    dailySessionId: `session:${cursor.fixture.id}`,
    continuousExchangeNo: 1,
    currentUserEventSequence: cursor.sequence,
    currentSourceRevision: 1,
    dialogueRevision: 0,
    expectedDataEpoch: 1,
    timeZone: cursor.fixture.timezone,
    interactionTurnId: cursor.interactionTurnId,
    locale: cursor.fixture.locale,
  });

  const readers: ProactiveFollowupStageReaders = {
    readTurnContext: async () => turnContext(),
    readDialogue: async (): Promise<ProactiveFollowupDialogueSnapshot> => ({
      status: "current",
      coveredThroughSequence: cursor.sequence,
      currentEventSequence: cursor.sequence,
      currentEventRevisionId: cursor.revisionId,
      currentRequestRequiresFocus: {
        value: FOCUS_REQUIRED_CATEGORIES.has(cursor.fixture.category),
        confidence: 1,
        sourceRevisionIds: [cursor.revisionId],
      },
    }),
    readOpenLane: async (): Promise<ProactiveFollowupLaneSnapshot> => {
      if (lane.extractErrored(cursor.revisionId)) {
        return {
          name: "open_loop",
          enabled: true,
          status: "unavailable",
          watermark: null,
          manifestVersion: PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
          integrity: "valid",
          candidates: [],
        };
      }
      return {
        name: "open_loop",
        enabled: true,
        status: "complete",
        watermark: { sourceRevision: 1, coveredThroughSequence: cursor.sequence },
        manifestVersion: PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
        integrity: "valid",
        candidates: lane.loops()
          .filter((loop) => !loop.closed)
          .map((loop) => ({
            targetKind: "open_loop" as const,
            targetId: loop.loopId,
            targetVersionId: `${loop.loopId}:v1`,
            source: "open_loop" as const,
            sourceRank: null,
            evidenceAt: new Date(BASE_TIME_MS).toISOString(),
            expectedStartAt: loop.expectedStartAt,
            expiresAt: loop.expiresAt,
            sensitive: false,
            lastUsedAt: null,
            current: true,
            eligible: true,
            trustFence: "valid" as const,
            mentionedInExchange: false,
            formedInCurrentTurn: loop.sourceEventRevisionId === cursor.revisionId,
          })),
      };
    },
    readTargetSummary: async (summaryInput) => {
      const loop = lane.loops().find((entry) => entry.loopId === summaryInput.targetId);
      return loop ? (loop.localizedSummary ?? null) : null;
    },
    readStates: async (statesInput) => {
      const found: ProactiveFollowupStateSnapshot[] = [];
      for (const candidate of statesInput.candidates) {
        const state = states.get(`${candidate.targetKind}:${candidate.targetId}`);
        if (state) found.push(state);
      }
      return found;
    },
    readEventRevisionText: async (textInput) => {
      const text = eventTexts.get(textInput.revisionId);
      return text === undefined ? null : { text };
    },
    listUsesAwaitingDisposition: async () => {
      const awaiting: ProactiveFollowupPendingUse[] = [];
      for (const use of pendingUses) {
        if (!use.recorded) {
          awaiting.push({
            useId: use.useId,
            assistantEventRevisionId: use.assistantEventRevisionId,
            targetKind: use.targetKind,
            targetId: use.targetId,
            targetVersionId: use.targetVersionId,
            promptUserEventSequence: use.promptUserEventSequence,
            promptDailySessionId: use.promptDailySessionId,
          });
        }
      }
      return awaiting;
    },
  };

  const reservations: ProactiveFollowupReservationStore = {
    reserveSelection: async (reserveInput) => ({
      outcome: "reserved",
      reservationId: `reservation:${reserveInput.mainGenerationCommandId}`,
      targetKind: reserveInput.target.targetKind,
      targetId: reserveInput.target.targetId,
      targetVersionId: reserveInput.target.targetVersionId,
    }),
    bindSegmentCommand: async () => ({ outcome: "bound" }),
    abandonSegment: async () => undefined,
    recordDisposition: async (dispositionInput) => {
      const use = pendingUses.find((entry) => entry.useId === dispositionInput.useId);
      if (use) use.recorded = true;
      const suppressed = dispositionInput.signal !== "no_stop_signal";
      states.set(`${dispositionInput.targetKind}:${dispositionInput.targetId}`, {
        stateId: `state:${dispositionInput.targetKind}:${dispositionInput.targetId}`,
        stateVersionId: `state:${dispositionInput.useId}`,
        targetKind: dispositionInput.targetKind,
        targetId: dispositionInput.targetId,
        targetVersionId: dispositionInput.targetVersionId,
        eligibilityStatus: suppressed ? "suppressed" : "eligible",
        suppressionReason: suppressed ? dispositionInput.signal : null,
        consecutiveSoftStopCount: suppressed ? 1 : 0,
        suppressedUntilAt: null,
        lastPromptEventRevisionId: dispositionInput.triggerUserEventRevisionId,
        lastResponseEventRevisionId: null,
        lastUsedAt: dispositionInput.now.toISOString(),
        releaseReason: null,
      });
      return { outcome: "recorded", stateVersionId: `state:${dispositionInput.useId}` };
    },
  };

  const roleEgress: ModelRoleProviderEgress = {
    dispatch: async (dispatchInput) => dispatchInput.execute(),
  };

  const stage = input.proactiveFollowupProvider
    ? createProactiveFollowupSegmentStage({
        clock,
        modelRoleCommandService: input.commandService,
        providerEgress: roleEgress,
        provider: input.proactiveFollowupProvider,
        readers,
        reservations,
        compiler: {
          compileSegmentContext: async (compileInput) => {
            const current = cursor.snapshot;
            if (!current) {
              throw new Error("Segment context compiled without a current snapshot.");
            }
            snapshots.set(String(compileInput.generationCommandId), current);
            const compiled = await compiler.compile({
              generationCommandId: compileInput.generationCommandId,
              interactionTurnId: asInteractionTurnId(compileInput.interactionTurnId),
              userId: compileInput.userId,
            });
            return compiled.id;
          },
        },
      })
    : undefined;

  const harness = createConversationAgentHarness({
    clock,
    contextCompiler: compiler,
    egressPort,
    repository,
    ...(stage ? { proactiveFollowupStage: stage } : {}),
  });

  return {
    clock,
    compiler: {
      compile: (compileInput) => compiler.compile(compileInput),
    },
    harness,
    lane,
    cursor,
    eventTexts,
    laneLog: () => ({
      formedLoops: lane.loops().map((loop) => ({
        loopId: loop.loopId,
        kind: loop.kind,
        sourceEventRevisionId: loop.sourceEventRevisionId,
        expectedStartAt: loop.expectedStartAt,
        expiresAt: loop.expiresAt,
      })),
      extractCalls,
      extractErrors,
    }),
    noteExtractCall: (success: boolean) => {
      extractCalls += 1;
      if (!success) extractErrors += 1;
    },
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

function deterministicRoleProviders(): {
  extract: OpenLoopExtractModelProvider;
  proactive: ProactiveFollowupModelProvider;
} {
  return {
    extract: {
      role: "open_loop.extract",
      extractProposals: async () => ({ proposals: [], closures: [] }),
    },
    proactive: {
      role: "proactive.followup",
      generateSegment: async (request) => ({
        content: "记着呢。",
        expressionKind: "acknowledgment",
        targetRef: {
          targetId: request.targetId,
          targetKind: request.targetKind,
          targetVersionId: request.targetVersionId,
        },
      }),
      classifyDisposition: async (request) => ({
        signal: "no_stop_signal",
        finalTextLocator: request.finalTextLocator,
      }),
    },
  };
}

/**
 * Map the champion's conversation adapter onto the seam's provider-adapter
 * config. OpenCode Go carries no caller-selectable baseUrl, so it is passed
 * through as its own transport instead of being assumed to be a responses-api
 * adapter.
 */
function seamAdapterFor(
  adapter: TwinConversationAdapter,
): Parameters<typeof createSeam>[0]["adapter"] {
  if (adapter.type === "opencode-go") {
    return {
      apiKey: adapter.apiKey,
      timeoutMs: adapter.timeoutMs,
      type: "opencode-go",
    };
  }
  if (adapter.type === "responses-api") {
    return {
      apiKey: adapter.apiKey,
      baseUrl: adapter.baseUrl,
      timeoutMs: adapter.timeoutMs,
      type: "responses-api",
    };
  }
  return { chunks: adapter.chunks ?? ["好的。"], type: "deterministic" };
}

async function captureFixture(input: {
  champion: ConversationTextChampion;
  continueOnError: boolean;
  deterministic: boolean;
  extractConfiguration: ModelRoleConfigurationSnapshot;
  fixture: ContinuationFixture;
  laneLogs: LaneSidecarFixture[];
  providerErrors: ProviderErrorReport[];
  conversationAdapter: TwinConversationAdapter;
  roleProviders:
    | { extract: OpenLoopExtractModelProvider; proactive: ProactiveFollowupModelProvider }
    | undefined;
  commandService: ModelRoleCommandService;
  roleEgress: ModelRoleProviderEgress;
  sharedInput: FrozenSharedInput;
}): Promise<ScenarioCapture> {
  const seam = createSeam({
    adapter: input.deterministic
      ? { chunks: ["好的。"], type: "deterministic" }
      : seamAdapterFor(input.conversationAdapter),
    champion: input.champion,
    commandService: input.commandService,
    openLoopExtractProvider: input.roleProviders?.extract,
    proactiveFollowupProvider: input.roleProviders?.proactive,
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
  for (const frozen of frozenEvents) {
    seam.eventTexts.set(String(frozen.revisionId), frozen.text);
  }
  const committed: ContextSourceEvent[] = [...frozenEvents];
  let sequence = frozenEvents.length;
  const turns: SyntheticRunTurn[] = [];
  let segmentsCommitted = 0;

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
    seam.eventTexts.set(String(userRevisionId), currentUser.text);
    seam.lane.registerEvent({
      revisionId: String(userRevisionId),
      locale: currentUser.locale,
      timeZone: input.fixture.timezone,
      text: currentUser.text,
    });

    // Evolve the open-loop lane from the frozen Event through the production
    // runner before the turn renders. An extract failure keeps the lane
    // unavailable for this turn (fail-closed); it never fails the fixture.
    const extractProvider = input.roleProviders?.extract;
    if (extractProvider) {
      const intentKey = `open-loop-extract:${input.fixture.id}:${fixtureTurn.sequenceInScenario}`;
      try {
        const admitted = await input.commandService.admit({
          userId: USER_ID,
          role: "open_loop.extract",
          intentKey,
          subjectType: "conversation_event_revision",
          subjectId: String(userRevisionId),
          sourceRevision: 1,
          sourceSnapshot: `open-loop-extract:${userRevisionId}`,
          inputManifest: [
            {
              key: `event:${userRevisionId}`,
              revision: 1,
              fingerprint: `event-revision:${userRevisionId}`,
            },
          ],
          expectedDataEpoch: 1,
          now: seam.clock(),
        });
        await runOpenLoopExtractAttempt({
          clock: seam.clock,
          repository: seam.lane,
          modelRoleCommandService: input.commandService,
          openLoopExtractProvider: extractProvider,
          command: {
            workflowCommandId: uuidFrom(`workflow:${intentKey}`),
            eventRevisionId: String(userRevisionId),
            sourceRevision: 1,
            generationCommandId: String(admitted.generationCommandId),
            modelRunAttemptId: String(admitted.modelRunAttemptId),
            attemptNo: admitted.attemptNo,
            attemptKind: admitted.attemptKind,
            rolloutPin: input.extractConfiguration.rolloutPin,
            policyVersion: OPEN_LOOP_EXTRACTION_POLICY_VERSION,
            expectedDataEpoch: 1,
          },
          providerEgress: input.roleEgress,
        });
        seam.noteExtractCall(true);
      } catch (error) {
        seam.noteExtractCall(false);
        seam.lane.noteExtractError(String(userRevisionId));
        console.log(
          `[f3-candidate-capture] ${input.fixture.id} t${fixtureTurn.sequenceInScenario}: extract failed closed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }

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
    seam.cursor.fixture = input.fixture;
    seam.cursor.sequence = userSequence;
    seam.cursor.revisionId = String(userRevisionId);
    seam.cursor.interactionTurnId = interactionTurnId;
    seam.cursor.snapshot = snapshot;

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
      } else if (event.type === "decision_segment_delta") {
        assistantText += ` ${event.delta}`;
        segmentsCommitted += 1;
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
      `[f3-candidate-capture] ${input.fixture.id} t${fixtureTurn.sequenceInScenario}: ${
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

  input.laneLogs.push({ fixtureId: input.fixture.id, ...seam.laneLog(input.fixture.id), segmentsCommitted });
  return { fixture: input.fixture, turns };
}

function shiftForLocale(locale: string): void {
  // Kept as an explicit seam for future locale-specific normalization.
  void locale;
}

type ProviderErrorReport = {
  category: string;
  fixtureId: string;
  message: string;
  sequenceInScenario: number;
};

type ScenarioCapture = {
  fixture: ContinuationFixture;
  turns: SyntheticRunTurn[];
};

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
  if (conversationAdapter.type === "deterministic") {
    throw new Error("The champion assembly did not return a live provider adapter.");
  }
  if (!arguments_.deterministic && !conversationAdapter.apiKey) {
    throw new Error("A provider API key is required for the real capture.");
  }
  const extractConfiguration = snapshotFor("open_loop.extract", pins);
  const proactiveConfiguration = snapshotFor("proactive.followup", pins);
  const roleProviders = arguments_.deterministic
    ? deterministicRoleProviders()
    : (() => {
        // Provision one adapter per provider the role pins actually select,
        // before any Provider call, so a missing credential fails fast rather
        // than after the champion already spent a turn.
        const roleConfigurations = [extractConfiguration, proactiveConfiguration];
        const providersPresent = new Set(
          roleConfigurations.map((configuration) => configuration.provider),
        );
        const adapters: OneA3bProviderAdapter[] = [];
        for (const provider of providersPresent) {
          if (provider === "deepseek") {
            const apiKey = process.env.DEEPSEEK_API_KEY;
            if (!apiKey) {
              throw new Error("DEEPSEEK_API_KEY is required for the selected deepseek provider.");
            }
            adapters.push({
              provider: "deepseek",
              apiKey,
              baseUrl:
                process.env.SAYHEAR_DEEPSEEK_BASE_URL ??
                process.env.DEEPSEEK_BASE_URL ??
                "https://api.deepseek.com",
              timeoutMs: 120_000,
            });
          } else if (provider === "opencode-go") {
            const apiKey = process.env.OPENCODE_GO_API_KEY;
            if (!apiKey) {
              throw new Error("OPENCODE_GO_API_KEY is required for the selected opencode-go provider.");
            }
            adapters.push({ provider: "opencode-go", apiKey, timeoutMs: 120_000 });
          } else {
            throw new Error(`Capture does not support the pinned provider ${provider}.`);
          }
        }
        if (adapters.length !== providersPresent.size) {
          throw new Error("Capture could not provision every configured provider.");
        }
        const providers = createRuntimeOneA3bRoleProviders({
          adapters,
          configurations: roleConfigurations,
        });
        if (!providers.openLoopExtractProvider || !providers.proactiveFollowupProvider) {
          throw new Error("The bundle provider assembly is missing a bundle role.");
        }
        return {
          extract: providers.openLoopExtractProvider,
          proactive: providers.proactiveFollowupProvider,
        };
      })();
  const commandService = createCommandService({
    "open_loop.extract": extractConfiguration,
    "proactive.followup": proactiveConfiguration,
  });
  const roleEgress: ModelRoleProviderEgress = {
    dispatch: async (dispatchInput) => dispatchInput.execute(),
  };
  const continuations = catalog.scenarios.filter(
    (fixture): fixture is ContinuationFixture => fixture.group === "continuation",
  );
  console.log(
    `[f3-candidate-capture] provider=${arguments_.deterministic ? "deterministic" : champion.provider} model=${champion.model} fixtures=${continuations.length}`,
  );

  const providerErrors: ProviderErrorReport[] = [];
  const laneLogs: LaneSidecarFixture[] = [];
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
        extractConfiguration,
        fixture,
        laneLogs,
        providerErrors,
        conversationAdapter,
        roleProviders,
        commandService,
        roleEgress,
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
      console.error(`[f3-candidate-capture] ${fixture.id} aborted:`, error);
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
  await mkdir(dirname(resolve(arguments_.lanesOut)), { recursive: true });
  await writeFile(
    resolve(arguments_.lanesOut),
    `${JSON.stringify({ arm: CONFIG_ID, fixtures: laneLogs }, null, 2)}\n`,
    "utf8",
  );
  const report = verifySyntheticRunHardGates(catalog, run);
  await mkdir(dirname(resolve(arguments_.hardGatesOut)), { recursive: true });
  await writeFile(
    resolve(arguments_.hardGatesOut),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `[f3-candidate-capture] wrote ${scenarios.length}/${continuations.length} scenarios to ${arguments_.out}`,
  );
  console.log(
    `[f3-candidate-capture] hard gates: checked=${report.checkedFixtureCount} passed=${report.passed} failures=${report.failures.length}`,
  );
  for (const failure of report.failures) {
    console.log(`[f3-candidate-capture]   - ${failure}`);
  }
  if (providerErrors.length > 0) {
    console.log(
      `[f3-candidate-capture] provider errors: ${providerErrors.length}`,
    );
    for (const error of providerErrors) {
      console.log(
        `[f3-candidate-capture]   - ${error.fixtureId} t${error.sequenceInScenario} [${error.category}]: ${error.message}`,
      );
    }
  }
  if (scenarios.length !== continuations.length || providerErrors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("[f3-candidate-capture] failed:", error);
  process.exitCode = 1;
});
