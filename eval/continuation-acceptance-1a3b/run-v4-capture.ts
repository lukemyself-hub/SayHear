/**
 * Issue #207 G2 v4 causal continuation capture.
 *
 * Modes:
 * - `main`: generate each controlled main response once with the clean
 *   incumbent conversation configuration (no extraction, no proactive stage).
 * - `off`: replay the frozen main responses through the OFF arm (no extraction,
 *   no proactive stage) and write the OFF run.
 * - `on`: replay the same frozen main responses through the ON arm (real
 *   extraction plus the real proactive stage) and write the ON run plus the
 *   per-turn treatment ledger.
 *
 * Lane behavior mirrors production: the REAL `open_loop.extract` runner
 * evolves the open-loop lane from the frozen Events (in-memory repositories),
 * the REAL `ProactiveFollowupSegmentStage` may append an isolated segment
 * behind the same harness that renders the main response, and suppression
 * records real cooldown/release transitions. Dialogue focus, already-mentioned
 * targets, and the Memory lane are fixture controls and remain operator-only.
 *
 * Usage:
 *   tsx eval/continuation-acceptance-1a3b/run-v4-capture.ts --mode main|off|on \
 *     [--only <sceneId>] [--continue-on-error] [--env-file <path>] \
 *     [--catalog <path>] [--pins <path>] [--main-in/--main-out <path>] \
 *     [--off-out <path>] [--on-out <path>] [--ledger-out <path>] \
 *     [--expression-selection <path>]
 *
 * Nothing here reuses v1 scores, identities, or the v1 review package.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  CANONICAL_PERSONA_VERSION,
  CHINESE_LOCALE_PACK_VERSION,
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  countFollowUpQuestions,
  createConversationAgentHarness,
  createContextCompiler,
  createModelRoleProviderEgress,
  createProactiveFollowupSegmentStage,
  composeProactiveFollowupResponse,
  ENGLISH_LOCALE_PACK_VERSION,
  MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
  MEMORY_BUDGETS_POLICY_VERSION,
  MEMORY_RETRIEVAL_POLICY_VERSION,
  MEMORY_SECTION_KEYS,
  minimumHighRiskSafetyPostureDetector,
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_G2_ENABLED_ROLES,
  applySafetyPostureTurn,
  ONE_A_3B_ROLE_POLICIES,
  ONE_A_3B_ROLE_POLICY_VERSION,
  OPEN_LOOP_EXTRACTION_POLICY_VERSION,
  planProactiveFollowupCooldownRelease,
  planProactiveFollowupDisposition,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  PORTRAIT_SELECTION_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_EXPRESSION_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_EXPRESSION_PROMPT_VERSION,
  PROACTIVE_FOLLOWUP_MANIFEST_VERSION,
  PROACTIVE_FOLLOWUP_MEMORY_LANE_MANIFEST_VERSIONS,
  PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
  PROACTIVE_FOLLOWUP_OPPORTUNITY_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION,
  PROACTIVE_FOLLOWUP_REASON_CODE_SCHEMA_VERSION,
  PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_SUPPRESSION_POLICY_VERSION,
  PROACTIVE_FOLLOWUP_TASK_INSTRUCTION_VERSION,
  PROACTIVE_FOLLOWUP_USE_SCHEMA_VERSION,
  RECALL_FRAMING_POLICY_VERSION,
  RETRIEVAL_LANE_PRIORITY,
  RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
  runOpenLoopExtractAttempt,
  SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE,
  SAFETY_POSTURE_POLICY_VERSION,
  SAFETY_RESOURCE_WHITELIST_VERSION,
  selectProactiveFollowupTarget,
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
  type ConversationTextModel,
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
  type ProactiveFollowupSelectionManifest,
  type ProactiveFollowupStageReaders,
  type ProactiveFollowupStateSnapshot,
  type ProactiveFollowupReservationStore,
  type ProactiveFollowupTurnContext,
  type ProviderEgressClaim,
  type ProviderEgressPort,
  type ProviderEgressRepository,
  type RecoveryGate,
  type RetrievalRunManifest,
  ProviderDispatchError,
} from "@sayhear/application";

import {
  createRuntimeProviderEgressPort,
  createRuntimeOneA3bRoleProviders,
} from "@sayhear/ai";
import { createProviderEgressPort } from "@sayhear/ai/testing";
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

import {
  buildChampionAssembly,
  gitCommit,
  loadDotEnv,
  trackedWorkingTreeIsDirty,
} from "../memory-pairwise-126/shared";
import { sha256, type FrozenSharedInput } from "./protocol";
import {
  F3_V4_ARM_RUN_VERSION,
  F3_V4_LEDGER_VERSION,
  F3_V4_MAIN_RUN_VERSION,
  v4ConfigurationFingerprint,
  type V4ArmRun,
  type V4CatalogManifest,
  type V4ExpressionSelectionManifest,
  type V4Family,
  type V4LedgerCandidate,
  type V4LedgerLane,
  type V4LedgerScenario,
  type V4LedgerState,
  type V4LedgerTurn,
  type V4MainResponse,
  type V4MainRun,
  type V4MemorySeed,
  type V4Pins,
  type V4PortraitSeed,
  type V4Scene,
  type V4SceneFile,
  type V4TargetRef,
  type V4Turn,
  type V4TreatmentLedger,
  v4TargetWasMentioned,
} from "./protocol-v4";
import { verifyV4Catalog } from "./verify-fixtures-v4";

const DEFAULT_CATALOG = "eval/continuation-acceptance-1a3b/fixtures-v4.json";
const DEFAULT_PINS = "eval/continuation-acceptance-1a3b/pins-v4.json";
const DEFAULT_MAIN_OUT =
  "eval/continuation-acceptance-1a3b/run-v4/continuation-main.json";
const DEFAULT_OFF_OUT =
  "eval/continuation-acceptance-1a3b/run-v4/continuation-off.json";
const DEFAULT_ON_OUT =
  "eval/continuation-acceptance-1a3b/run-v4/continuation-on.json";
const DEFAULT_LEDGER_OUT =
  "eval/continuation-acceptance-1a3b/run-v4/treatment-ledger.json";
const OFF_CONFIG_ID = "continuation-incumbent-1a3a";
const GROUP = "continuation" as const;
const USER_ID = asUserId(uuidFrom("synthetic-user"));

type CaptureMode = "main" | "off" | "on";

type ParsedArguments = Readonly<{
  catalog: string;
  concurrency: number;
  continueOnError: boolean;
  envFile: string | null;
  expressionSelection: string | null;
  ledgerOut: string;
  mainIn: string;
  mainOut: string;
  mode: CaptureMode;
  offOut: string;
  onOut: string;
  only: string | null;
  pins: string;
}>;

function parseArguments(): ParsedArguments {
  const arguments_ = process.argv.slice(2);
  const values = {
    catalog: DEFAULT_CATALOG,
    concurrency: 1,
    continueOnError: false,
    envFile: null as string | null,
    expressionSelection: null as string | null,
    ledgerOut: DEFAULT_LEDGER_OUT,
    mainIn: DEFAULT_MAIN_OUT,
    mainOut: DEFAULT_MAIN_OUT,
    mode: "main" as CaptureMode,
    offOut: DEFAULT_OFF_OUT,
    onOut: DEFAULT_ON_OUT,
    only: null as string | null,
    pins: DEFAULT_PINS,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--catalog") values.catalog = required(arguments_, ++index, argument);
    else if (argument === "--concurrency") {
      const parsed = Number.parseInt(required(arguments_, ++index, argument), 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--concurrency must be a positive integer");
      }
      values.concurrency = parsed;
    }
    else if (argument === "--continue-on-error") values.continueOnError = true;
    else if (argument === "--env-file") values.envFile = required(arguments_, ++index, argument);
    else if (argument === "--expression-selection")
      values.expressionSelection = required(arguments_, ++index, argument);
    else if (argument === "--ledger-out") values.ledgerOut = required(arguments_, ++index, argument);
    else if (argument === "--main-in") values.mainIn = required(arguments_, ++index, argument);
    else if (argument === "--main-out") values.mainOut = required(arguments_, ++index, argument);
    else if (argument === "--mode") {
      const mode = required(arguments_, ++index, argument);
      if (mode !== "main" && mode !== "off" && mode !== "on") {
        throw new Error(`Unknown capture mode: ${mode}`);
      }
      values.mode = mode;
    }
    else if (argument === "--off-out") values.offOut = required(arguments_, ++index, argument);
    else if (argument === "--on-out") values.onOut = required(arguments_, ++index, argument);
    else if (argument === "--only") values.only = required(arguments_, ++index, argument);
    else if (argument === "--pins") values.pins = required(arguments_, ++index, argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return values;
}

function required(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index];
  if (value === undefined) throw new Error(`${name} requires a value.`);
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

const BASE_TIME_MS = Date.UTC(2026, 8, 23, 0, 0, 0);
const DOMAIN_TIME = "2026-09-23T00:00:00.000Z";

function createClock(): {
  advanceDays: (days: number) => void;
  now: () => Date;
} {
  let tick = 0;
  let offsetMs = 0;
  return {
    advanceDays: (days) => {
      offsetMs += days * 24 * 60 * 60 * 1_000;
    },
    now: () => new Date(BASE_TIME_MS + tick++ * 1_000 + offsetMs),
  };
}

function createSyntheticRecoveryGate(): RecoveryGate {
  const result = {
    status: "open" as const,
    markerDataEpoch: null,
    markerPurgedAt: null,
    markerWrittenAt: null,
    receiptDestinations: [],
  };
  return {
    evaluate: async () => result,
    requireOpen: async () => result,
  };
}

/**
 * Expand a pins identity label into a full configuration snapshot. Lifecycle
 * fields come from the frozen role policy, never from the pins: the registry
 * rejects anything else. A pins/policy disagreement fails loudly here
 * instead of silently running an unevaluated configuration.
 */
function snapshotFor(
  role: OneA3bModelRole,
  pins: V4Pins,
): ModelRoleConfigurationSnapshot {
  const pin = pins.roles[role];
  if (!pin) throw new Error(`Pins file has no ${role} role.`);
  if (pin.provider !== "deepseek") {
    throw new Error(`Capture supports the pinned deepseek provider, found ${pin.provider} for ${role}.`);
  }
  if (pin.fallback !== "none") {
    throw new Error(`Capture requires fallback none, found ${pin.fallback} for ${role}.`);
  }
  const temperature = pin.parameters.temperature;
  const maxOutputTokens = pin.parameters.maxOutputTokens;
  const reasoningEffort = pin.parameters.reasoningEffort;
  const responseFormat = pin.parameters.responseFormat;
  if (
    typeof temperature !== "number" ||
    typeof maxOutputTokens !== "number" ||
    reasoningEffort !== "none" ||
    responseFormat !== "json_object"
  ) {
    throw new Error(
      `Pins parameters for ${role} must carry temperature, maxOutputTokens, reasoningEffort=none, and responseFormat=json_object.`,
    );
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
    providerPolicyVersion: `deepseek-${role}-egress:candidate:v1`,
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
      reasoningEffort,
      responseFormat,
    },
  };
}

/** In-memory model-role command service: every admission is unique, every attempt stays ready. */
function createCommandService(
  configurations: Readonly<Record<string, ModelRoleConfigurationSnapshot>>,
): ModelRoleCommandService {
  const requireRoles = (roles: readonly OneA3bModelRole[], regime: string): void => {
    const missing = roles.filter((role) => configurations[role] === undefined);
    if (missing.length > 0) {
      throw new Error(`${regime} synthetic release is missing ${missing.join(", ")}.`);
    }
  };
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
    verifyActiveG1Release: async () => {
      requireRoles(ONE_A_3B_G1_ENABLED_ROLES, "G1");
    },
    verifyActiveG2Release: async () => {
      requireRoles(ONE_A_3B_G2_ENABLED_ROLES, "G2");
    },
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
  expectedEndAt: string | null;
  timePrecision: string;
  timezone: string | null;
  followupEligibleFromAt: string;
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
  settleEmpty(revisionId: string): void;
  noteExtractError(revisionId: string): void;
  extractErrored(revisionId: string): boolean;
  extractPending(revisionId: string): boolean;
  hasPendingExtraction(): boolean;
  hasExtractErrors(): boolean;
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
    settleEmpty: (revisionId) => {
      settled.add(revisionId);
    },
    noteExtractError: (revisionId) => {
      errored.add(revisionId);
    },
    extractErrored: (revisionId) => errored.has(revisionId),
    extractPending: (revisionId) =>
      events.has(revisionId) && !settled.has(revisionId) && !errored.has(revisionId),
    hasPendingExtraction: () =>
      [...events.keys()].some(
        (revisionId) => !settled.has(revisionId) && !errored.has(revisionId),
      ),
    hasExtractErrors: () => errored.size > 0,
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
          loopId: uuidFrom(
            `loop:${commitInput.sourceEventRevisionId}:${loopTick}`,
          ),
          kind: formation.kind,
          sourceEventRevisionId: commitInput.sourceEventRevisionId,
          localizedSummary: formation.localizedSummary,
          expectedStartAt: formation.expectedStartAt,
          expectedEndAt: formation.expectedEndAt,
          timePrecision: formation.timePrecision,
          timezone: formation.timezone,
          followupEligibleFromAt: formation.followupEligibleFromAt,
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

type SeamScene = V4Scene;

type SeamCursor = {
  scene: SeamScene;
  sequence: number;
  revisionId: string;
  interactionTurnId: ReturnType<typeof asInteractionTurnId>;
  snapshot: ContextSourceSnapshot | null;
};

/**
 * Everything the stage read during one turn. Whole-selection failures return
 * an empty candidate list, so `endTurn` replays the pure selection function
 * over these exact inputs to capture the none-case manifest.
 */
type SelectionTrace = {
  turn: ProactiveFollowupTurnContext;
  dialogue: ProactiveFollowupDialogueSnapshot;
  openLane: ProactiveFollowupLaneSnapshot;
  memoryLane: ProactiveFollowupLaneSnapshot;
  states: readonly ProactiveFollowupStateSnapshot[];
  now: Date;
};

type TurnEvidence = {
  sequence: number;
  readerCalled: boolean;
  capturedManifest: ProactiveFollowupSelectionManifest | null;
  capturedSelected: Readonly<{
    targetId: string;
    targetKind: string;
    targetVersionId: string;
  }> | null;
  replayedSelection: ReturnType<typeof selectProactiveFollowupTarget> | null;
  reservationOutcome: string | null;
  segmentCommandId: string | null;
  generateCalls: number;
  dispositionCalls: number;
  dispositionSignal: string | null;
  segmentOutcome: "committed" | "omitted" | "failed" | "not_reached";
  segmentOmitReason: V4LedgerTurn["on"]["segmentOmitReason"];
  segmentText: string | null;
  segmentFingerprint: string | null;
  typedUseOutcome: string | null;
  dispositionOutcome: string | null;
  releaseOutcome: string | null;
  preCompositionMainText: string | null;
  preDisplayOutcome: string | null;
  openLane: V4LedgerLane;
  memoryLane: V4LedgerLane;
  statesAfterTurn: readonly V4LedgerState[];
};

function notReadLane(): V4LedgerLane {
  return {
    integrity: "not_read",
    manifestVersion: "not_read",
    status: "not_read",
    watermark: null,
  };
}

function emptyEvidence(sequence: number): TurnEvidence {
  return {
    sequence,
    readerCalled: false,
    capturedManifest: null,
    capturedSelected: null,
    replayedSelection: null,
    reservationOutcome: null,
    segmentCommandId: null,
    generateCalls: 0,
    dispositionCalls: 0,
    dispositionSignal: null,
    segmentOutcome: "not_reached",
    segmentOmitReason: null,
    segmentText: null,
    segmentFingerprint: null,
    typedUseOutcome: null,
    dispositionOutcome: null,
    releaseOutcome: null,
    preCompositionMainText: null,
    preDisplayOutcome: null,
    openLane: notReadLane(),
    memoryLane: notReadLane(),
    statesAfterTurn: [],
  };
}

function createSeam(input: {
  adapter:
    | Readonly<{
        apiKey: string;
        baseUrl: string;
        timeoutMs: number;
        type: "responses-api";
      }>
    | Readonly<{ chunks: readonly string[]; type: "deterministic" }>
    | Readonly<{ type: "replay" }>;
  champion: ConversationTextChampion;
  commandService: ModelRoleCommandService;
  openLoopExtractProvider: OpenLoopExtractModelProvider | undefined;
  proactiveFollowupProvider: ProactiveFollowupModelProvider | undefined;
}): {
  clock: () => Date;
  advanceClockDays: (days: number) => void;
  promptFingerprint: (generationCommandId: string) => string;
  compiler: { compile: (input: {
    generationCommandId: ReturnType<typeof asGenerationCommandId>;
    interactionTurnId: ReturnType<typeof asInteractionTurnId>;
    userId: typeof USER_ID;
  }) => Promise<CompiledContext> };
  harness: ConversationAgentHarness;
  lane: ReturnType<typeof createLaneRepository>;
  cursor: SeamCursor;
  turnSourceSequence: Map<string, number>;
  eventTexts: Map<string, string>;
  beginTurn: (turn: V4Turn, sequence: number) => void;
  endTurn: () => void;
  turnEvidence: (sequence: number) => TurnEvidence;
  extractAccounting: () => Readonly<{
    attempts: number;
    accepted: number;
    proposals: number;
    skipped: readonly string[];
  }>;
  stateSnapshots: () => readonly V4LedgerState[];
  frozenTextUnused: () => readonly string[];
  noteExtractCall: (input: Readonly<{
    success: boolean;
    proposalCount: number;
    formedCount: number;
    skipLabels: readonly string[];
  }>) => void;
  lastEgressError: () => Error | null;
  roleEgress: ModelRoleProviderEgress;
  memoryState: { sceneId: string; sharedInput: FrozenSharedInput | null };
  registerFrozenResponse: (generationCommandId: string, text: string) => void;
  registerSnapshot: (generationCommandId: string, snapshot: ContextSourceSnapshot) => void;
} {
  const clockState = createClock();
  const clock = clockState.now;
  const renderSources = new Map<string, CompiledContextRenderSource>();
  const snapshots = new Map<string, ContextSourceSnapshot>();
  // The Daily-Session-scoped Safety Posture projection, mirroring
  // `current_safety_postures`: at most one current version per session, read by
  // loadContextSource and advanced by the deterministic turn transition at the
  // response-commit boundary.
  const safetyPostures = new Map<string, CurrentSafetyPosture>();
  const memoryState: { sceneId: string; sharedInput: FrozenSharedInput | null } = {
    sceneId: "",
    sharedInput: null,
  };
  const eventTexts = new Map<string, string>();
  const frozenResponses = new Map<string, string>();
  const usedFrozenResponses = new Set<string>();
  const lane = createLaneRepository();
  const cursor: SeamCursor = {
    scene: undefined as unknown as SeamScene,
    sequence: 0,
    revisionId: "",
    interactionTurnId: asInteractionTurnId(uuidFrom("synthetic-cursor")),
    snapshot: null,
  };
  const turnSourceSequence = new Map<string, number>();
  let currentTurn: V4Turn | null = null;
  let currentTrace: SelectionTrace | null = null;
  const evidenceBySequence = new Map<number, TurnEvidence>();
  let evidence: TurnEvidence = emptyEvidence(0);
  // Pending proactive uses within the scene run; suppression states evolve
  // through the production disposition and cooldown-release plans.
  const pendingUses: (ProactiveFollowupPendingUse & {
    exchangeNo: number;
    promptUserEventRevisionId: string;
    recorded: boolean;
  })[] = [];
  const states = new Map<string, ProactiveFollowupStateSnapshot>();
  let lastEgressError: Error | null = null;
  let extractAttempts = 0;
  let extractAccepted = 0;
  let extractProposals = 0;
  const extractSkipped: string[] = [];

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
      const segment = commitInput.proactiveSegment;
      evidence.preCompositionMainText = commitInput.text;
      const responseText = segment
        ? composeProactiveFollowupResponse({
            mainText: commitInput.text,
            segmentText: segment.generation.output.content,
          })
        : commitInput.text;
      eventTexts.set(String(revisionId), responseText);
      if (segment) {
        evidence.segmentOutcome = "committed";
        evidence.segmentText = segment.generation.output.content;
        evidence.segmentFingerprint = sha256(segment.generation.output.content);
        evidence.typedUseOutcome = "committed";
        evidence.preDisplayOutcome = "permitted";
        pendingUses.push({
          useId: `use:${commitInput.generationCommandId}`,
          assistantEventRevisionId: String(revisionId),
          exchangeNo: snapshot?.dailySession.continuousExchangeNo ?? 1,
          promptUserEventRevisionId: String(segment.plan.promptUserEventRevisionId),
          targetKind: segment.plan.targetKind,
          targetId: segment.plan.targetId,
          targetVersionId: segment.plan.targetVersionId,
          promptUserEventSequence: segment.plan.promptUserEventSequence,
          promptDailySessionId: snapshot ? String(snapshot.dailySession.id) : "",
          recorded: false,
        });
      }
      if (!segment && evidence.segmentOutcome === "not_reached") {
        evidence.segmentOutcome = "omitted";
      }
      return {
        eventId,
        outcome: "committed",
        revisionId,
        segment: segment ? "committed" : "omitted",
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
        `${memoryState.sceneId}:retrieval:${retrievalRunIdTick++}`,
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
  const egressPort: ProviderEgressPort = {
    async *stream(streamInput) {
      try {
        if (input.adapter.type === "replay") {
          const frozen = frozenResponses.get(
            String(streamInput.generationCommandId),
          );
          if (frozen === undefined) {
            throw new Error(
              `No frozen main response registered for ${String(streamInput.generationCommandId)}.`,
            );
          }
          usedFrozenResponses.add(String(streamInput.generationCommandId));
          // The replay model streams the controlled main response verbatim.
          // It deliberately bypasses the behavior-aware deterministic wrapper:
          // the controlled response is already the frozen product of the real
          // safety behavior, and re-applying detection would replace it.
          const replayModel: ConversationTextModel = {
            async *stream(request) {
              yield { delta: frozen, type: "delta" };
              yield {
                costMicros: 0,
                finishReason: "completed",
                inputTokens: request.messages.reduce(
                  (total, message) => total + Math.ceil([...message.text].length / 4),
                  0,
                ),
                modelSnapshot: request.model,
                outputTokens: Math.ceil([...frozen].length / 4),
                providerRequestId: "eval-replay-request",
                type: "completed",
              };
            },
          };
          const port = createProviderEgressPort({
            champion: input.champion,
            clock,
            contextCompiler: compiler,
            model: replayModel,
            repository,
          });
          yield* port.stream(streamInput);
        } else {
          const port = createRuntimeProviderEgressPort({
            adapter: input.adapter,
            champion: input.champion,
            clock,
            contextCompiler: compiler,
            repository,
          });
          yield* port.stream(streamInput);
        }
      } catch (error) {
        lastEgressError =
          error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    },
  };

  const turnContext = (): ProactiveFollowupTurnContext => ({
    dailySessionId: cursor.snapshot
      ? String(cursor.snapshot.dailySession.id)
      : `session:${cursor.scene.id}`,
    continuousExchangeNo: 1,
    currentUserEventSequence: cursor.sequence,
    currentSourceRevision: 1,
    dialogueRevision: 0,
    expectedDataEpoch: 1,
    timeZone: cursor.scene.timezone,
    interactionTurnId: cursor.interactionTurnId,
    locale: cursor.scene.locale,
  });

  const mentionedInCurrentExchange = (target: V4TargetRef): boolean =>
    v4TargetWasMentioned(cursor.scene.turns, cursor.sequence, target);

  const openLoopTargetRef = (loop: ReturnType<typeof lane.loops>[number]): V4TargetRef => {
    const sourceTurn = turnSourceSequence.get(loop.sourceEventRevisionId);
    if (sourceTurn === undefined) {
      throw new Error(`Open Loop ${loop.loopId} has no source turn in scene ${cursor.scene.id}.`);
    }
    return {
      kind: "open_loop",
      ordinal: lane
        .loops()
        .filter((entry) => entry.sourceEventRevisionId === loop.sourceEventRevisionId)
        .findIndex((entry) => entry.loopId === loop.loopId),
      sourceTurn,
    };
  };

  const memoryLaneSnapshot = (
    readInput: Readonly<{ now: Date }>,
  ): ProactiveFollowupLaneSnapshot => {
    if (cursor.scene.memoryLaneUnavailable) {
      return {
        name: "memory",
        enabled: true,
        status: "unavailable",
        watermark: null,
        manifestVersion: PROACTIVE_FOLLOWUP_MEMORY_LANE_MANIFEST_VERSIONS[0],
        integrity: "valid",
        candidates: [],
      };
    }
    const subjectRole = (text: string): "user" | "other" | "unknown" => {
      if (text.startsWith("Your friend ") || text.startsWith("你的朋友")) {
        return "other";
      }
      if (text.startsWith("You ") || text.startsWith("你")) return "user";
      return "unknown";
    };
    const portraits = cursor.scene.portrait.map((portrait, index) => ({
      targetKind: "memory_claim" as const,
      targetId: portrait.id,
      targetVersionId: `${portrait.id}:v1`,
      source: "person_portrait" as const,
      sourceRank: index + 1,
      evidenceAt: new Date(BASE_TIME_MS).toISOString(),
      subjectRole: subjectRole(portrait.text),
      sensitive: portrait.sensitive,
      lastUsedAt: null,
      current: true,
      eligible: true,
      trustFence: "valid" as const,
      mentionedInExchange: mentionedInCurrentExchange({
        kind: "memory_claim",
        memoryId: portrait.id,
      }),
      formedInCurrentTurn: false,
    }));
    const queries = cursor.scene.memory.map((memory, index) => ({
      targetKind: "memory_claim" as const,
      targetId: memory.id,
      targetVersionId: `${memory.id}:v1`,
      source: "query_retrieval" as const,
      sourceRank: portraits.length + index + 1,
      evidenceAt: new Date(BASE_TIME_MS).toISOString(),
      subjectRole: subjectRole(memory.text),
      sensitive: memory.sensitive,
      lastUsedAt: null,
      current: true,
      eligible: true,
      trustFence: "valid" as const,
      mentionedInExchange: mentionedInCurrentExchange({
        kind: "memory_claim",
        memoryId: memory.id,
      }),
      formedInCurrentTurn: false,
    }));
    void readInput;
    return {
      name: "memory",
      enabled: true,
      status: "complete",
      watermark: { sourceRevision: 1, coveredThroughSequence: cursor.sequence },
      manifestVersion: PROACTIVE_FOLLOWUP_MEMORY_LANE_MANIFEST_VERSIONS[0],
      integrity: "valid",
      candidates: [...portraits, ...queries],
    };
  };

  const memorySeedText = (targetId: string): string | null => {
    const memory = cursor.scene.memory.find((entry) => entry.id === targetId);
    if (memory) return memory.text;
    const portrait = cursor.scene.portrait.find((entry) => entry.id === targetId);
    return portrait ? portrait.text : null;
  };

  const readers: ProactiveFollowupStageReaders = {
    readTurnContext: async () => {
      evidence.readerCalled = true;
      const turn = turnContext();
      currentTrace = {
        turn,
        dialogue: undefined as unknown as ProactiveFollowupDialogueSnapshot,
        openLane: undefined as unknown as ProactiveFollowupLaneSnapshot,
        memoryLane: undefined as unknown as ProactiveFollowupLaneSnapshot,
        states: [],
        now: undefined as unknown as Date,
      };
      return turn;
    },
    readDialogue: async (): Promise<ProactiveFollowupDialogueSnapshot> => {
      const dialogue: ProactiveFollowupDialogueSnapshot = {
        status: "current",
        coveredThroughSequence: cursor.sequence,
        currentEventSequence: cursor.sequence,
        currentEventRevisionId: cursor.revisionId,
        currentRequestRequiresFocus: {
          value: currentTurn?.focusRequired ?? true,
          confidence: 1,
          sourceRevisionIds: [cursor.revisionId],
        },
        proactiveFollowupOpportunity: {
          value: currentTurn?.opportunity ?? null,
          confidence: currentTurn?.opportunity === null ? 0 : 1,
          sourceRevisionIds:
            currentTurn?.opportunity === null ? [] : [cursor.revisionId],
        },
      };
      if (currentTrace) currentTrace.dialogue = dialogue;
      return dialogue;
    },
    readOpenLane: async (readInput): Promise<ProactiveFollowupLaneSnapshot> => {
      const snapshot = (() => {
        if (lane.hasExtractErrors() || lane.extractErrored(cursor.revisionId)) {
          return {
            name: "open_loop" as const,
            enabled: true,
            status: "unavailable" as const,
            watermark: null,
            manifestVersion: PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
            integrity: "valid" as const,
            candidates: [],
          };
        }
        if (
          currentTurn?.incompleteLane ||
          lane.hasPendingExtraction()
        ) {
          return {
            name: "open_loop" as const,
            enabled: true,
            status: "incomplete" as const,
            watermark: {
              sourceRevision: readInput.turn.currentSourceRevision,
              coveredThroughSequence: readInput.turn.currentUserEventSequence,
            },
            manifestVersion: PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
            integrity: "valid" as const,
            candidates: [],
          };
        }
        const nowMs = readInput.now.getTime();
        return {
          name: "open_loop" as const,
          enabled: true,
          status: "complete" as const,
          watermark: {
            sourceRevision: 1,
            coveredThroughSequence: cursor.sequence,
          },
          manifestVersion: PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
          integrity: "valid" as const,
          candidates: lane
            .loops()
            .filter((loop) => !loop.closed && Date.parse(loop.expiresAt) > nowMs)
            .map((loop) => ({
              targetKind: "open_loop" as const,
              targetId: loop.loopId,
              targetVersionId: `${loop.loopId}:v1`,
              source: "open_loop" as const,
              sourceRank: null,
              sourceEventRevisionId: loop.sourceEventRevisionId,
              evidenceAt: new Date(BASE_TIME_MS).toISOString(),
              expectedStartAt: loop.expectedStartAt,
              expectedEndAt: loop.expectedEndAt,
              expectedTimePrecision: loop.timePrecision,
              expectedTimeZone: loop.timezone,
              openLoopKind: loop.kind,
              expiresAt: loop.expiresAt,
              sensitive: true,
              lastUsedAt: null,
              current: true,
              eligible: Date.parse(loop.followupEligibleFromAt) <= nowMs,
              trustFence: "valid" as const,
              mentionedInExchange: mentionedInCurrentExchange(
                openLoopTargetRef(loop),
              ),
              formedInCurrentTurn:
                loop.sourceEventRevisionId === cursor.revisionId,
            })),
        };
      })();
      if (currentTrace) {
        currentTrace.openLane = snapshot;
        currentTrace.now = readInput.now;
      }
      return snapshot;
    },
    readMemoryLane: async (readInput): Promise<ProactiveFollowupLaneSnapshot> => {
      const snapshot = memoryLaneSnapshot(readInput);
      if (currentTrace) currentTrace.memoryLane = snapshot;
      return snapshot;
    },
    readTargetSummary: async (summaryInput) => {
      if (summaryInput.targetKind === "open_loop") {
        const loop = lane
          .loops()
          .find((entry) => entry.loopId === summaryInput.targetId);
        return loop ? (loop.localizedSummary ?? null) : null;
      }
      return memorySeedText(summaryInput.targetId);
    },
    readOpenLoopSourceEvidence: async (sourceInput) => {
      const loop = lane
        .loops()
        .find(
          (entry) =>
            entry.loopId === sourceInput.targetId &&
            `${entry.loopId}:v1` === sourceInput.targetVersionId &&
            entry.sourceEventRevisionId ===
              sourceInput.expectedSourceEventRevisionId &&
            !entry.closed,
        );
      if (!loop) return null;
      const sameBinding = lane
        .loops()
        .filter(
          (entry) =>
            !entry.closed &&
            entry.sourceEventRevisionId === loop.sourceEventRevisionId &&
            entry.kind === loop.kind &&
            entry.expectedStartAt === loop.expectedStartAt &&
            entry.expectedEndAt === loop.expectedEndAt &&
            entry.timePrecision === loop.timePrecision &&
            entry.timezone === loop.timezone,
        );
      if (sameBinding.length !== 1) return null;
      const text = eventTexts.get(loop.sourceEventRevisionId);
      return text?.trim()
        ? {
            eventRevisionId: loop.sourceEventRevisionId,
            revision: 1,
            text,
          }
        : null;
    },
    readStates: async (statesInput) => {
      const found: ProactiveFollowupStateSnapshot[] = [];
      for (const candidate of statesInput.candidates) {
        const key = `${candidate.targetKind}:${candidate.targetId}`;
        let state = states.get(key) ?? null;
        if (state && state.eligibilityStatus === "suppressed") {
          const release = planProactiveFollowupCooldownRelease({
            now: statesInput.now,
            state,
          });
          if (release.outcome === "released") {
            const releasedState = {
              ...release.state,
              releaseReason: "cooldown_elapsed" as const,
            };
            states.set(key, releasedState);
            state = releasedState;
            evidence.releaseOutcome = "released:cooldown_elapsed";
          }
        }
        void candidate;
        if (state) found.push(state);
      }
      if (currentTrace) currentTrace.states = found;
      return found;
    },
    readEventRevisionText: async (textInput) => {
      const text = eventTexts.get(textInput.revisionId);
      if (process.env.G2_V4_DEBUG === "1") {
        console.log(
          `[debug-seam] readEventRevisionText ${textInput.revisionId} -> ${text === undefined ? "missing" : `${text.length} chars`}`,
        );
      }
      return text === undefined ? null : { text };
    },
    listUsesAwaitingDisposition: async () => {
      if (process.env.G2_V4_DEBUG === "1") {
        console.log(
          `[debug-seam] listUsesAwaitingDisposition pending=${pendingUses.filter((use) => !use.recorded).length}`,
        );
      }
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
    reserveSelection: async (reserveInput) => {
      evidence.capturedManifest = reserveInput.manifest;
      evidence.capturedSelected = {
        targetKind: reserveInput.target.targetKind,
        targetId: reserveInput.target.targetId,
        targetVersionId: reserveInput.target.targetVersionId,
      };
      evidence.reservationOutcome = "reserved";
      return {
        outcome: "reserved",
        reservationId: `reservation:${reserveInput.mainGenerationCommandId}`,
        targetKind: reserveInput.target.targetKind,
        targetId: reserveInput.target.targetId,
        targetVersionId: reserveInput.target.targetVersionId,
      };
    },
    bindSegmentCommand: async (bindInput) => {
      evidence.segmentCommandId = String(bindInput.segmentGenerationCommandId);
      return { outcome: "bound" };
    },
    abandonSegment: async () => {
      evidence.reservationOutcome = "abandoned";
      evidence.segmentOutcome = "omitted";
    },
    releaseOmittedSegment: async () => {
      evidence.reservationOutcome = "released";
      evidence.segmentOutcome = "omitted";
      return { outcome: "released" };
    },
    recordDisposition: async (dispositionInput) => {
      const use = pendingUses.find((entry) => entry.useId === dispositionInput.useId);
      if (!use) return { outcome: "fenced", reason: "use_missing" };
      try {
        const transition = planProactiveFollowupDisposition({
          userId: String(USER_ID),
          now: dispositionInput.now,
          timeZone: dispositionInput.timeZone,
          signal: dispositionInput.signal,
          targetKind: dispositionInput.targetKind,
          targetId: dispositionInput.targetId,
          targetVersionId: dispositionInput.targetVersionId,
          currentUserEventRevisionId: dispositionInput.triggerUserEventRevisionId,
          currentUserEventSequence: dispositionInput.triggerUserEventSequence,
          currentUserEventExchangeNo: use.exchangeNo,
          use: {
            useId: use.useId,
            userId: String(USER_ID),
            targetKind: use.targetKind,
            targetId: use.targetId,
            targetVersionId: use.targetVersionId,
            promptUserEventRevisionId: use.promptUserEventRevisionId,
            promptUserEventSequence: use.promptUserEventSequence,
            exchangeNo: use.exchangeNo,
            finalTextLocator: dispositionInput.finalTextLocator,
          },
          state: states.get(`${use.targetKind}:${use.targetId}`) ?? null,
        });
        const stateKey = `${use.targetKind}:${use.targetId}`;
        if (transition.outcome === "suppressed") {
          const state = transition.state ?? {
            stateId: `state:${use.targetKind}:${use.targetId}`,
            stateVersionId: `state:${use.useId}`,
            targetKind: use.targetKind,
            targetId: use.targetId,
            targetVersionId: use.targetVersionId,
            eligibilityStatus: "suppressed" as const,
            suppressionReason: transition.suppressionReason,
            consecutiveSoftStopCount: 1,
            suppressedUntilAt: transition.suppressionUntilAt,
            lastPromptEventRevisionId: use.promptUserEventRevisionId,
            lastResponseEventRevisionId: dispositionInput.triggerUserEventRevisionId,
            lastUsedAt: dispositionInput.now.toISOString(),
            releaseReason: null,
          };
          states.set(stateKey, state);
        } else {
          // A recorded use with no stop signal still advances lastUsedAt so
          // "never used first" stays meaningful across the scene.
          const previous = states.get(stateKey) ?? null;
          states.set(stateKey, {
            stateId: previous?.stateId ?? `state:${use.targetKind}:${use.targetId}`,
            stateVersionId: `state:${use.useId}`,
            targetKind: use.targetKind,
            targetId: use.targetId,
            targetVersionId: use.targetVersionId,
            eligibilityStatus: "eligible",
            suppressionReason: previous?.suppressionReason ?? null,
            consecutiveSoftStopCount: previous?.consecutiveSoftStopCount ?? 0,
            suppressedUntilAt: previous?.suppressedUntilAt ?? null,
            lastPromptEventRevisionId: use.promptUserEventRevisionId,
            lastResponseEventRevisionId: dispositionInput.triggerUserEventRevisionId,
            lastUsedAt: dispositionInput.now.toISOString(),
            releaseReason: previous?.releaseReason ?? null,
          });
        }
        use.recorded = true;
        evidence.dispositionOutcome = `recorded:${dispositionInput.signal}`;
        return {
          outcome: "recorded",
          stateVersionId: transition.state?.stateVersionId ?? null,
        };
      } catch {
        evidence.dispositionOutcome = "fenced:disposition_policy";
        return { outcome: "fenced", reason: "disposition_policy" };
      }
    },
  };

  const stateSnapshots = (): readonly V4LedgerState[] =>
    [...states.entries()].map(([, state]) => ({
      targetKind: state.targetKind,
      targetId: state.targetId,
      targetVersionId: state.targetVersionId,
      eligibilityStatus: state.eligibilityStatus,
      suppressionReason: state.suppressionReason,
      consecutiveSoftStopCount: state.consecutiveSoftStopCount,
      suppressedUntilAt: state.suppressedUntilAt,
      lastUsedAt: state.lastUsedAt ?? "",
      releaseReason: state.releaseReason,
    }));

  const baseRoleEgress = createModelRoleProviderEgress({
    commandService: input.commandService,
    recoveryGate: createSyntheticRecoveryGate(),
  });
  const roleEgress: ModelRoleProviderEgress = {
    async dispatch(dispatchInput) {
      try {
        return await baseRoleEgress.dispatch(dispatchInput);
      } catch (error) {
        lastEgressError = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    },
  };

  const stage = input.proactiveFollowupProvider
    ? createProactiveFollowupSegmentStage({
        clock,
        modelRoleCommandService: input.commandService,
        providerEgress: roleEgress,
        provider: {
          role: "proactive.followup",
          async generateSegment(request) {
            evidence.generateCalls += 1;
            try {
              const output = await input.proactiveFollowupProvider!.generateSegment(
                request,
              );
              if (output.decision === "omit") {
                evidence.segmentOmitReason = output.reason;
              }
              return output;
            } catch (error) {
              evidence.segmentOutcome = "failed";
              throw error;
            }
          },
          async classifyDisposition(request) {
            evidence.dispositionCalls += 1;
            const decision =
              await input.proactiveFollowupProvider!.classifyDisposition(
                request,
              );
            evidence.dispositionSignal = decision.signal;
            return decision;
          },
        },
        readers,
        reservations,
        compiler: {
          compileSegmentContext: async (compileInput) => {
            const current = cursor.snapshot;
            if (!current) {
              throw new Error("Segment context compiled without a current snapshot.");
            }
            snapshots.set(String(compileInput.generationCommandId), {
              ...current,
              generationStage: "proactive_followup",
              policyVersions: {
                ...current.policyVersions,
                taskInstructionVersion:
                  PROACTIVE_FOLLOWUP_TASK_INSTRUCTION_VERSION,
              },
            });
            try {
              const compiled = await compiler.compile({
                generationCommandId: compileInput.generationCommandId,
                interactionTurnId: asInteractionTurnId(compileInput.interactionTurnId),
                userId: compileInput.userId,
              });
              return compiled.id;
            } catch (error) {
              console.log(
                `[g2-v4-capture] segment context compile failed: ${error instanceof Error ? error.message : String(error)}`,
              );
              throw error;
            }
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
    advanceClockDays: clockState.advanceDays,
    promptFingerprint: (generationCommandId) =>
      sha256(renderSources.get(generationCommandId) ?? null),
    compiler: {
      compile: (compileInput) => compiler.compile(compileInput),
    },
    harness,
    lane,
    cursor,
    turnSourceSequence,
    eventTexts,
    roleEgress,
    beginTurn: (turn, sequence) => {
      currentTurn = turn;
      currentTrace = null;
      evidence = emptyEvidence(sequence);
    },
    endTurn: () => {
      const laneView = (
        lane: ProactiveFollowupLaneSnapshot | undefined,
      ): V4LedgerLane =>
        lane
          ? {
              integrity: lane.integrity,
              manifestVersion: lane.manifestVersion,
              status: lane.status,
              watermark: lane.watermark
                ? {
                    coveredThroughSequence: lane.watermark.coveredThroughSequence,
                    sourceRevision: lane.watermark.sourceRevision,
                  }
                : null,
            }
          : notReadLane();
      if (currentTrace) {
        evidence.openLane = laneView(currentTrace.openLane);
        evidence.memoryLane = laneView(currentTrace.memoryLane);
      }
      evidence.statesAfterTurn = stateSnapshots();
      evidence.replayedSelection =
        currentTrace && evidence.capturedManifest === null
          ? selectProactiveFollowupTarget({
              userId: String(USER_ID),
              dailySessionId: currentTrace.turn.dailySessionId,
              continuousExchangeNo: currentTrace.turn.continuousExchangeNo,
              currentUserEventRevisionId: cursor.revisionId,
              currentUserEventSequence:
                currentTrace.turn.currentUserEventSequence,
              currentSourceRevision: currentTrace.turn.currentSourceRevision,
              opportunity:
                currentTrace.dialogue.proactiveFollowupOpportunity?.value ?? null,
              ordinaryQuestionAlreadyAsked: false,
              dialogue: currentTrace.dialogue,
              lanes: [currentTrace.openLane, currentTrace.memoryLane],
              states: currentTrace.states,
              now: currentTrace.now,
            })
          : null;
      evidenceBySequence.set(evidence.sequence, evidence);
    },
    turnEvidence: (sequence) =>
      evidenceBySequence.get(sequence) ?? emptyEvidence(sequence),
    extractAccounting: () => ({
      attempts: extractAttempts,
      accepted: extractAccepted,
      proposals: extractProposals,
      skipped: extractSkipped,
    }),
    stateSnapshots,
    frozenTextUnused: () => [...frozenResponses.keys()].filter((key) => !usedFrozenResponses.has(key)),
    noteExtractCall: (call) => {
      extractAttempts += 1;
      if (call.success) extractAccepted += 1;
      extractProposals += call.proposalCount;
      for (const label of call.skipLabels) {
        if (!extractSkipped.includes(label)) extractSkipped.push(label);
      }
    },
    lastEgressError: () => lastEgressError,
    memoryState,
    registerFrozenResponse: (generationCommandId, text) => {
      frozenResponses.set(generationCommandId, text);
    },
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
        decision: "emit",
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

type ProviderErrorReport = {
  category: string;
  message: string;
  sceneId: string;
  sequenceInScenario: number;
};

type SceneRunTurn = Readonly<{
  sequenceInScenario: number;
  userInput: Readonly<{ locale: string; text: string; timezone: string }>;
  assistantText: string;
  preCompositionMainText: string;
}>;

type SceneCapture = {
  scene: V4Scene;
  turns: SceneRunTurn[];
  mainResponses: V4MainResponse[];
  ledger: V4LedgerScenario;
};

/**
 * Deterministic shared input for one scene: historical Events, seeded Memory
 * Claims, and portrait projections. It feeds the ordinary conversation
 * compiler only; the reviewed Memory lane reads the same seeds directly.
 */
function sharedInputForScene(scene: V4Scene): FrozenSharedInput {
  return {
    config: {
      conversation: "conversation-harness:v3",
      locale:
        scene.languageVariant === "en"
          ? ENGLISH_LOCALE_PACK_VERSION
          : CHINESE_LOCALE_PACK_VERSION,
      persona: CANONICAL_PERSONA_VERSION,
      safety: SAFETY_RESOURCE_WHITELIST_VERSION,
    },
    events: scene.historicalEvents.map((event, index) => ({
      id: `${scene.id}:historical:${index}`,
      locale: event.locale,
      sourceRevision: "1",
      text: event.text,
    })),
    memory: scene.memory.map((memory) => ({
      evidenceIds: [...memory.evidenceIds],
      id: memory.id,
      kind: memory.kind,
      text: memory.text,
    })),
    portrait: scene.portrait.map((portrait) => ({
      claimId: portrait.claimId,
      id: portrait.id,
      kind: portrait.kind,
      text: portrait.text,
    })),
    retrieval: scene.memory.map((memory, index) => ({
      id: `${scene.id}:retrieval:${index}`,
      memoryId: memory.id,
      rank: index + 1,
      reason: "query_retrieval",
      selected: true,
    })),
  };
}

const CASE_KIND_BY_FAMILY: Readonly<Record<V4Family, V4LedgerScenario["caseKind"]>> = {
  competing_pool: "positive",
  correct_zero: "correct_zero",
  omission_contract: "omission_audit",
  positive_memory: "positive",
  positive_open_loop: "positive",
  stateful_suppression: "stateful",
};

function expectedTreatmentFor(family: V4Family): string {
  switch (family) {
    case "positive_open_loop":
      return "on:segment:open_loop";
    case "positive_memory":
      return "on:segment:memory_claim";
    case "stateful_suppression":
      return "on:segment:then:suppressed";
    case "competing_pool":
      return "on:segment:declared_target";
    case "omission_contract":
      return "on:typed_omit:declared_reason";
    case "correct_zero":
      return "off:identical";
  }
}

function componentVersions(): Readonly<Record<string, string>> {
  return {
    expressionPolicy: PROACTIVE_FOLLOWUP_EXPRESSION_POLICY_VERSION,
    expressionPrompt: PROACTIVE_FOLLOWUP_EXPRESSION_PROMPT_VERSION,
    memoryLaneManifest: PROACTIVE_FOLLOWUP_MEMORY_LANE_MANIFEST_VERSIONS[0],
    openLoopExtraction: OPEN_LOOP_EXTRACTION_POLICY_VERSION,
    opportunity: PROACTIVE_FOLLOWUP_OPPORTUNITY_POLICY_VERSION,
    policyBundle: PROACTIVE_FOLLOWUP_POLICY_BUNDLE_VERSION,
    proactiveManifest: PROACTIVE_FOLLOWUP_MANIFEST_VERSION,
    reasonCodes: PROACTIVE_FOLLOWUP_REASON_CODE_SCHEMA_VERSION,
    selection: PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
    suppression: PROACTIVE_FOLLOWUP_SUPPRESSION_POLICY_VERSION,
    useSchema: PROACTIVE_FOLLOWUP_USE_SCHEMA_VERSION,
  };
}

async function runScene(input: {
  adapter:
    | Readonly<{ chunks: readonly string[]; type: "deterministic" }>
    | Readonly<{ apiKey: string; baseUrl: string; timeoutMs: number; type: "responses-api" }>
    | Readonly<{ type: "replay" }>;
  champion: ConversationTextChampion;
  commandService: ModelRoleCommandService;
  continueOnError: boolean;
  extractConfiguration: ModelRoleConfigurationSnapshot;
  frozenMain: ReadonlyMap<number, string> | null;
  mode: CaptureMode;
  providerErrors: ProviderErrorReport[];
  roleProviders:
    | { extract: OpenLoopExtractModelProvider; proactive: ProactiveFollowupModelProvider }
    | undefined;
  scene: V4Scene;
}): Promise<SceneCapture> {
  const scene = input.scene;
  const sharedInput = sharedInputForScene(scene);
  const seam = createSeam({
    adapter: input.adapter,
    champion: input.champion,
    commandService: input.commandService,
    openLoopExtractProvider: input.roleProviders?.extract,
    proactiveFollowupProvider: input.roleProviders?.proactive,
  });
  const harnessPolicy = createHarnessPolicy();

  const frozenEvents: ContextSourceEvent[] = sharedInput.events.map(
    (event, index) => ({
      actor: "user",
      locale: event.locale,
      revisionId: asConversationEventRevisionId(
        uuidFrom(`${scene.id}:frozen:${index}`),
      ),
      sequence: index + 1,
      text: event.text,
    }),
  );
  for (const frozen of frozenEvents) {
    seam.eventTexts.set(String(frozen.revisionId), frozen.text);
    seam.lane.registerEvent({
      revisionId: String(frozen.revisionId),
      locale: frozen.locale,
      timeZone: scene.timezone,
      text: frozen.text,
    });
  }
  const committed: ContextSourceEvent[] = [...frozenEvents];
  let sequence = frozenEvents.length;
  const turns: SceneRunTurn[] = [];
  const mainResponses: V4MainResponse[] = [];
  for (const [index, frozen] of frozenEvents.entries()) {
    seam.turnSourceSequence.set(String(frozen.revisionId), index === 0 ? 0 : -1);
  }

  const proposalLabels = (
    request: Readonly<{ evidence: readonly { evidenceItemId: string }[] }>,
    proposals: readonly Readonly<{
      evidenceItemId: string;
      hasRealAnchor: boolean;
      isTaskLike: boolean;
    }>[],
  ): readonly string[] => {
    const evidenceIds = new Set(
      request.evidence.map((entry) => String(entry.evidenceItemId)),
    );
    if (proposals.length === 0) return ["extract_skipped_empty"];
    const formable = proposals.filter(
      (proposal) =>
        evidenceIds.has(String(proposal.evidenceItemId)) &&
        proposal.hasRealAnchor &&
        !proposal.isTaskLike,
    );
    const labels: string[] = [];
    if (formable.length === 0 && proposals.length > 0) {
      const rejected = proposals.map((proposal) => {
        if (!evidenceIds.has(String(proposal.evidenceItemId))) {
          return "extract_skipped_evidence_mismatch";
        }
        if (!proposal.hasRealAnchor) return "extract_skipped_no_real_anchor";
        if (proposal.isTaskLike) return "extract_skipped_task_like";
        return "extract_skipped_unknown";
      });
      labels.push(...rejected);
    }
    return labels;
  };

  const makeExtractProvider = (
    sourceLabel: string,
    onLabels: (labels: readonly string[]) => void,
  ): OpenLoopExtractModelProvider => ({
    role: "open_loop.extract",
    async extractProposals(request) {
      const output = await input.roleProviders!.extract.extractProposals(
        request,
      );
      if (process.env.G2_V4_DEBUG === "1") {
        console.log(
          `[debug-extract] ${scene.id} ${sourceLabel} request=${JSON.stringify(request).slice(0, 1400)}`,
        );
        console.log(
          `[debug-extract] ${scene.id} ${sourceLabel} -> ${JSON.stringify(output).slice(0, 1200)}`,
        );
      }
      const labels = proposalLabels(request, output.proposals);
      onLabels(labels);
      return output;
    },
  });

  const extractEvent = async (
    event: ContextSourceEvent,
    sourceLabel: string,
  ): Promise<void> => {
    if (!input.roleProviders) return;
    const intentKey = `open-loop-extract:${scene.id}:${sourceLabel}`;
    // Every event gets one semantic extraction result. A missing or rejected
    // target is an honest fixture failure; do not retry until the declared
    // target happens to form.
    let settled = false;
    let lastOutcome: string = "not_attempted";
    let lastErrorCode: string | null = null;
    const skipLabels: string[] = [];
    try {
      const provider = makeExtractProvider(
        sourceLabel,
        (labels) => {
          for (const label of labels) {
            if (!skipLabels.includes(label)) skipLabels.push(label);
          }
        },
      );
      const admitted = await input.commandService.admit({
        userId: USER_ID,
        role: "open_loop.extract",
        intentKey,
        subjectType: "conversation_event_revision",
        subjectId: String(event.revisionId),
        sourceRevision: 1,
        sourceSnapshot: `open-loop-extract:${event.revisionId}`,
        inputManifest: [
          {
            key: `event:${event.revisionId}`,
            revision: 1,
            fingerprint: `event-revision:${event.revisionId}`,
          },
        ],
        expectedDataEpoch: 1,
        now: seam.clock(),
      });
      const result = await runOpenLoopExtractAttempt({
        clock: seam.clock,
        repository: seam.lane,
        modelRoleCommandService: input.commandService,
        openLoopExtractProvider: provider,
        command: {
          workflowCommandId: uuidFrom(`workflow:${intentKey}`),
          eventRevisionId: String(event.revisionId),
          sourceRevision: 1,
          generationCommandId: String(admitted.generationCommandId),
          modelRunAttemptId: String(admitted.modelRunAttemptId),
          attemptNo: admitted.attemptNo,
          attemptKind: admitted.attemptKind,
          rolloutPin: input.extractConfiguration.rolloutPin,
          policyVersion: OPEN_LOOP_EXTRACTION_POLICY_VERSION,
          expectedDataEpoch: 1,
        },
        providerEgress: seam.roleEgress,
      });
      const succeeded =
        result.outcome === "extracted" || result.outcome === "duplicate";
      seam.noteExtractCall({
        success: succeeded,
        proposalCount: result.formedCount,
        formedCount: result.formedCount,
        skipLabels: [
          ...skipLabels,
          ...(result.skippedCount > 0
            ? ["extract_skipped_admission_rule"]
            : []),
        ],
      });
      lastOutcome = result.outcome;
      lastErrorCode = result.errorCode;
      if (succeeded) {
        // A committed extraction outcome, including zero formation, is
        // final for this fixture Event.
        settled = true;
      }
      console.log(
        `[g2-v4-capture] ${scene.id} ${sourceLabel}: extract ${result.outcome} (${result.errorCode ?? "no error code"})`,
      );
      if (!settled) {
        // A terminal extraction failure leaves no accepted target for this
        // event. Settle it as an empty extraction so an unrelated event cannot
        // poison the lane for a reviewed turn; the miss stays classified in
        // openLoopSkipped and the fixture checks fail the case if the event was
        // the one that had to form the declared target.
        seam.lane.settleEmpty(String(event.revisionId));
        seam.noteExtractCall({
          success: false,
          proposalCount: 0,
          formedCount: 0,
          skipLabels: [
            ...skipLabels,
            `extract_failed:${sourceLabel}`,
          ],
        });
        console.log(
          `[g2-v4-capture] ${scene.id} ${sourceLabel}: extract ${lastOutcome} (${lastErrorCode ?? "no error code"}; ${seam.lastEgressError()?.message ?? "no detail"})`,
        );
      }
    } catch (error) {
      seam.noteExtractCall({
        success: false,
        proposalCount: 0,
        formedCount: 0,
        skipLabels: [...skipLabels, `extract_failed:${sourceLabel}`],
      });
      seam.lane.settleEmpty(String(event.revisionId));
      console.log(
        `[g2-v4-capture] ${scene.id} ${sourceLabel}: extract failed closed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  };

  for (const [index, frozen] of frozenEvents.entries()) {
    seam.turnSourceSequence.set(String(frozen.revisionId), index === 0 ? 0 : -1);
  }

  for (const [index, frozen] of frozenEvents.entries()) {
    if (input.mode === "on") {
      await extractEvent(frozen, `frozen:${index}`);
    }
  }

  for (const sceneTurn of scene.turns) {
    seam.memoryState.sceneId = scene.id;
    seam.memoryState.sharedInput = sharedInput;
    if (sceneTurn.clockAdvanceDays !== undefined) {
      seam.advanceClockDays(sceneTurn.clockAdvanceDays);
    }

    sequence += 1;
    const userSequence = sequence;
    const userRevisionId = asConversationEventRevisionId(
      uuidFrom(`${scene.id}:t${sceneTurn.sequenceInScenario}:user`),
    );
    const currentUser: ContextSourceEvent = {
      actor: "user",
      locale: sceneTurn.userInput.locale,
      revisionId: userRevisionId,
      sequence: userSequence,
      text: sceneTurn.userInput.text,
    };
    seam.eventTexts.set(String(userRevisionId), currentUser.text);
    seam.lane.registerEvent({
      revisionId: String(userRevisionId),
      locale: currentUser.locale,
      timeZone: scene.timezone,
      text: currentUser.text,
    });
    seam.turnSourceSequence.set(String(userRevisionId), sceneTurn.sequenceInScenario);

    if (input.mode === "on" && sceneTurn.incompleteLane !== true) {
      await extractEvent(
        currentUser,
        `turn:${sceneTurn.sequenceInScenario}`,
      );
    }

    const generationCommandId = String(
      asGenerationCommandId(
        uuidFrom(`${scene.id}:t${sceneTurn.sequenceInScenario}:command`),
      ),
    );
    const interactionTurnId = asInteractionTurnId(
      uuidFrom(`${scene.id}:t${sceneTurn.sequenceInScenario}:turn`),
    );
    const modelRunAttemptId = asModelRunAttemptId(
      uuidFrom(`${scene.id}:t${sceneTurn.sequenceInScenario}:attempt`),
    );

    const snapshot: ContextSourceSnapshot = {
      dailySession: {
        activityState: "active",
        closurePolicyVersion: "continuous-exchange-inactivity:v1",
        continuousExchangeNo: 1,
        id: asDailySessionId(uuidFrom(`${scene.id}:daily-session`)),
      },
      dialogueRevision: 0,
      events: [...committed, currentUser],
      generationStage: "decision",
      inputRevisionId: userRevisionId,
      locale: scene.locale,
      policyVersions: policyVersionsFor(sharedInput),
      rollingSummary: null,
      sourceRevision: 1,
    };
    seam.registerSnapshot(generationCommandId, snapshot);
    seam.cursor.scene = scene;
    seam.cursor.sequence = userSequence;
    seam.cursor.revisionId = String(userRevisionId);
    seam.cursor.interactionTurnId = interactionTurnId;
    seam.cursor.snapshot = snapshot;
    seam.beginTurn(sceneTurn, sceneTurn.sequenceInScenario);

    const frozenText = input.frozenMain?.get(sceneTurn.sequenceInScenario);
    if (input.mode !== "main") {
      if (frozenText === undefined) {
        input.providerErrors.push({
          category: "configuration",
          message: `Missing frozen main response for scene ${scene.id} turn ${sceneTurn.sequenceInScenario}.`,
          sceneId: scene.id,
          sequenceInScenario: sceneTurn.sequenceInScenario,
        });
        if (!input.continueOnError) break;
        continue;
      }
      seam.registerFrozenResponse(generationCommandId, frozenText);
    }

    const compiled = await seam.compiler.compile({
      generationCommandId: asGenerationCommandId(generationCommandId),
      interactionTurnId,
      userId: USER_ID,
    });

    let assistantText = "";
    let failedCategory: string | null = null;
    let committedAssistantRevisionId: string | null = null;
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
      } else if (event.type === "decision_committed") {
        committedAssistantRevisionId = String(event.assistantEventRevisionId);
      } else if (event.type === "decision_failed") {
        failedCategory = event.category;
      }
    }
    seam.endTurn();
    const evidence = seam.turnEvidence(sceneTurn.sequenceInScenario);

    if (committedAssistantRevisionId !== null) {
      assistantText =
        seam.eventTexts.get(committedAssistantRevisionId) ?? assistantText;
    }
    const preCompositionMainText =
      evidence.preCompositionMainText ?? assistantText;

    if (failedCategory !== null) {
      input.providerErrors.push({
        category: failedCategory,
        message: seam.lastEgressError()?.message ?? "no provider error",
        sceneId: scene.id,
        sequenceInScenario: sceneTurn.sequenceInScenario,
      });
    }

    turns.push({
      assistantText,
      preCompositionMainText,
      sequenceInScenario: sceneTurn.sequenceInScenario,
      userInput: sceneTurn.userInput,
    });
    if (input.mode === "main") {
      mainResponses.push({
        fixtureId: scene.id,
        model: input.champion.model,
        modelSnapshot: input.champion.snapshot,
        promptFingerprint: seam.promptFingerprint(generationCommandId),
        provider: input.champion.provider,
        sequenceInScenario: sceneTurn.sequenceInScenario,
        text: assistantText,
        userInputFingerprint: sha256({
          fixtureId: scene.id,
          locale: sceneTurn.userInput.locale,
          sequenceInScenario: sceneTurn.sequenceInScenario,
          text: sceneTurn.userInput.text,
        }),
      });
    }
    console.log(
      `[g2-v4-capture] ${scene.id} t${sceneTurn.sequenceInScenario} ${input.mode}: ${
        failedCategory === null ? `${assistantText.length} chars` : `FAILED ${failedCategory}`
      }`,
    );

    committed.push(currentUser);
    sequence += 1;
    committed.push({
      actor: "assistant",
      locale: scene.locale,
      revisionId: asConversationEventRevisionId(
        committedAssistantRevisionId ??
          uuidFrom(`${scene.id}:t${sceneTurn.sequenceInScenario}:assistant`),
      ),
      sequence,
      text: assistantText,
    });

    if (failedCategory !== null && !input.continueOnError) break;
  }

  const extractAccounting = seam.extractAccounting();
  const loopRef = (loopId: string): V4TargetRef => {
    const loop = seam.lane.loops().find((entry) => entry.loopId === loopId);
    if (!loop) throw new Error(`Unknown loop ${loopId} in scene ${scene.id}.`);
    const sourceTurn = seam.turnSourceSequence.get(loop.sourceEventRevisionId);
    if (sourceTurn === undefined) {
      throw new Error(
        `Loop ${loopId} in scene ${scene.id} has no registered source turn.`,
      );
    }
    const ordinal = seam
      .lane.loops()
      .filter((entry) => entry.sourceEventRevisionId === loop.sourceEventRevisionId)
      .findIndex((entry) => entry.loopId === loopId);
    return { kind: "open_loop", ordinal, sourceTurn };
  };
  const memoryRef = (targetId: string): V4TargetRef => ({
    kind: "memory_claim",
    memoryId: targetId,
  });
  const toRef = (targetKind: string, targetId: string): V4TargetRef =>
    targetKind === "open_loop" ? loopRef(targetId) : memoryRef(targetId);

  const ledgerTurns: V4LedgerTurn[] = [];
  if (input.mode === "on") {
    for (const turn of turns) {
      const evidence = seam.turnEvidence(turn.sequenceInScenario);
      const manifest =
        evidence.capturedManifest ?? evidence.replayedSelection?.manifest ?? null;
      const decision = manifest?.decision ?? null;
      const ordinaryQuestionCount = countFollowUpQuestions(
        turn.preCompositionMainText,
      );
      const selectionOutcome: V4LedgerTurn["on"]["selectionOutcome"] =
        decision === "selected"
          ? "selected"
          : decision === "none"
            ? "none"
            : "not_reached";
      const candidates: V4LedgerCandidate[] = (manifest?.candidates ?? []).map(
        (candidate) => ({
          current: true,
          eligible: candidate.eligible,
          exclusionReason: candidate.exclusionReason,
          formedInCurrentTurn: candidate.formedFromCurrentEvent,
          lane: candidate.sourceLane,
          lastUsedAt: candidate.lastUseAt,
          mentionedInExchange: candidate.mentionedInExchange,
          rankTuple: candidate.rankTuple
            ? [...candidate.rankTuple]
            : null,
          sensitive: candidate.sensitivity === 1,
          stateVersion: candidate.stateVersionId,
          suppressionReason: candidate.suppressionReason,
          suppressedUntilAt: candidate.suppressedUntilAt,
          targetRef: `${candidate.targetKind}:${candidate.targetId}`,
          trustFence: candidate.trustFenceResults.join(","),
        }),
      );
      ledgerTurns.push({
        controlledMainResponseFingerprint: sha256(turn.preCompositionMainText),
        off: {
          finalResponseFingerprint: sha256(turn.assistantText),
          g2CodePathEntered: false,
        },
        on: {
          candidates,
          componentVersions: componentVersions(),
          dispositionOutcome: evidence.dispositionOutcome,
          dispositionProviderCallCount: evidence.dispositionCalls,
          finalResponseFingerprint: sha256(turn.assistantText),
          memoryLane: evidence.memoryLane,
          openLoopLane: evidence.openLane,
          ordinaryQuestionCount,
          preDisplayOutcome: evidence.preDisplayOutcome,
          releaseOutcome: evidence.releaseOutcome,
          reservationOutcome: evidence.reservationOutcome,
          segmentCommandId: evidence.segmentCommandId,
          segmentFingerprint: evidence.segmentFingerprint,
          segmentText: evidence.segmentText,
          segmentOmitReason: evidence.segmentOmitReason,
          segmentOutcome: evidence.segmentOutcome,
          segmentProviderCallCount: evidence.generateCalls,
          selectedTargetRef:
            evidence.capturedSelected === null
              ? null
              : `${evidence.capturedSelected.targetKind}:${evidence.capturedSelected.targetId}`,
          selectionManifestVersion: manifest?.manifestVersion ?? null,
          selectionOutcome,
          selectionReason: manifest?.reason ?? null,
          suppressionStateAfterTurn: evidence.statesAfterTurn,
          typedUseOutcome: evidence.typedUseOutcome,
        },
        sequenceInScenario: turn.sequenceInScenario,
        userInputFingerprint: sha256({
          fixtureId: scene.id,
          locale: turn.userInput.locale,
          sequenceInScenario: turn.sequenceInScenario,
          text: turn.userInput.text,
        }),
      });
    }
  }

  return {
    ledger: {
      caseKind: CASE_KIND_BY_FAMILY[scene.family],
      cleanIncumbentCommit: "assigned_by_writer",
      cleanIncumbentManifestFingerprint: "assigned_by_writer",
      expectedTreatment: expectedTreatmentFor(scene.family),
      family: scene.family,
      fixtureId: scene.id,
      formedTargetRefs: seam.lane.loops().map((loop) => ({
        ref: loopRef(loop.loopId),
        targetId: loop.loopId,
      })),
      formedLoopSchedules: seam.lane.loops().map((loop) => ({
        targetId: loop.loopId,
        kind: loop.kind,
        expectedStartAt: loop.expectedStartAt,
        followupEligibleFromAt: loop.followupEligibleFromAt,
        expiresAt: loop.expiresAt,
        closed: loop.closed,
        sourceEventRevisionId: loop.sourceEventRevisionId,
      })),
      openLoopAcceptedCount: extractAccounting.accepted,
      openLoopExtractAttempts: extractAccounting.attempts,
      openLoopProposalCount: extractAccounting.proposals,
      openLoopSkipped:
        extractAccounting.skipped.length > 0
          ? [...extractAccounting.skipped]
          : [],
      turns: ledgerTurns,
    },
    mainResponses,
    scene,
    turns,
  };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments();
  if (arguments_.only !== null) {
    const defaultOutputs: readonly (readonly [string, string])[] =
      arguments_.mode === "main"
        ? [[arguments_.mainOut, DEFAULT_MAIN_OUT]]
        : arguments_.mode === "off"
          ? [[arguments_.offOut, DEFAULT_OFF_OUT]]
          : [
              [arguments_.onOut, DEFAULT_ON_OUT],
              [arguments_.ledgerOut, DEFAULT_LEDGER_OUT],
            ];
    if (
      defaultOutputs.some(
        ([actual, standard]) => resolve(actual) === resolve(standard),
      )
    ) {
      throw new Error(
        "A partial --only capture requires explicit nondefault output paths.",
      );
    }
  }
  if (trackedWorkingTreeIsDirty()) {
    throw new Error(
      "Capture requires a clean tracked working tree so evaluatorCommit is reproducible.",
    );
  }
  const evaluatorRoot = "eval/continuation-acceptance-1a3b/";
  const untrackedEvaluatorFiles = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", evaluatorRoot],
    { encoding: "utf8" },
  )
    .split(/\r?\n/)
    .filter((path) => path.length > 0 && !path.startsWith(`${evaluatorRoot}run-v4/`));
  if (untrackedEvaluatorFiles.length > 0) {
    throw new Error(
      `Capture requires committed evaluator sources; untracked files: ${untrackedEvaluatorFiles.join(", ")}`,
    );
  }
  const evaluatorCommit = gitCommit();
  const environment = (() => {
    loadDotEnv(
      arguments_.envFile ? { override: true, path: arguments_.envFile } : undefined,
    );
    return process.env;
  })();
  const manifest = JSON.parse(
    await readFile(resolve(arguments_.catalog), "utf8"),
  ) as unknown as V4CatalogManifest;
  const verification = await verifyV4Catalog({
    manifest,
    root: process.cwd(),
  });
  if (!verification.passed) {
    throw new Error(
      `v4 fixture verification failed: ${verification.mismatches.join("; ")}`,
    );
  }
  const sceneFiles = await Promise.all(
    manifest.sceneFiles.map(async (entry) =>
      JSON.parse(
        await readFile(resolve(entry.path), "utf8"),
      ) as unknown as V4SceneFile,
    ),
  );
  const scenes = sceneFiles.flatMap((file) => file.scenes);
  const pins = JSON.parse(
    await readFile(resolve(arguments_.pins), "utf8"),
  ) as unknown as V4Pins;

  if (arguments_.mode === "on") {
    if (arguments_.expressionSelection === null) {
      throw new Error(
        "ON capture requires --expression-selection bound to the reviewed expression winner (ADR-0136).",
      );
    }
    const selection = JSON.parse(
      await readFile(resolve(arguments_.expressionSelection), "utf8"),
    ) as unknown as V4ExpressionSelectionManifest;
    const winner = pins.expression.configurations.find(
      (configuration) => configuration.id === selection.winnerConfigId,
    );
    if (!winner || pins.expression.selectedConfigId !== selection.winnerConfigId) {
      throw new Error(
        "Expression selection does not match the pinned ON configuration.",
      );
    }
    if (
      selection.waiver === undefined &&
      typeof selection.expressionRunSha256 !== "string"
    ) {
      throw new Error(
        "Expression decision has neither a comparison run hash nor a recorded waiver.",
      );
    }
    if (selection.waiver !== undefined) {
      if (
        selection.waiver.approvedBy !== "luke" ||
        selection.waiver.approvedAt !== "2026-09-23" ||
        selection.decision === undefined ||
        selection.authorizationSha256 !==
          sha256({ decision: selection.decision, waiver: selection.waiver })
      ) {
        throw new Error("Expression waiver authorization is invalid or has drifted.");
      }
    }
    if (sha256(winner.pin) !== selection.winnerRolePinSha256) {
      throw new Error("Expression winner role pin hash drift.");
    }
  } else if (pins.expression.selectedConfigId !== null && arguments_.mode === "off") {
    // The OFF arm stays on the incumbent; the expression pin does not bind it.
  }

  const { champion, conversationAdapter } = buildChampionAssembly(environment);
  if (arguments_.mode === "main") {
    if (conversationAdapter.type !== "responses-api") {
      throw new Error("The champion assembly did not return a responses-api adapter.");
    }
    if (conversationAdapter.apiKey === "") {
      throw new Error("A provider API key is required for the main capture.");
    }
  }

  const g1Configurations = [
    snapshotFor("episode.build", pins),
    snapshotFor("reflection.daily", pins),
    snapshotFor("reflection.weekly", pins),
    snapshotFor("narrative.validate", pins),
  ];
  const extractConfiguration = snapshotFor("open_loop.extract", pins);
  const proactiveConfiguration = snapshotFor("proactive.followup", pins);
  const roleConfigurations = Object.fromEntries(
    [...g1Configurations, extractConfiguration, proactiveConfiguration].map(
      (configuration) => [configuration.role, configuration],
    ),
  );
  const commandService = createCommandService(roleConfigurations);

  const roleProviders = (() => {
    if (arguments_.mode !== "on") return undefined;
    if (conversationAdapter.type !== "responses-api") {
      throw new Error("The champion assembly did not return a responses-api adapter.");
    }
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [
        {
          provider: "deepseek",
          baseUrl: conversationAdapter.baseUrl,
          apiKey: conversationAdapter.apiKey,
          timeoutMs: conversationAdapter.timeoutMs,
          ...(process.env.G2_V4_DEBUG === "1"
            ? {
                fetchImplementation: async (
                  url: unknown,
                  init?: { body?: unknown },
                ) => {
                  const body = String(init?.body);
                  const response = await fetch(url as string, init as RequestInit);
                  if (body.includes("open_loop.extract")) {
                    const text = await response.clone().text();
                    const deltas = [
                      ...text.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g),
                    ]
                      .map((match) => JSON.parse(`"${match[1]}"`) as string)
                      .join("");
                    console.log(
                      `[debug-http-response] ${deltas.slice(0, 1500)}`,
                    );
                  }
                  return response;
                },
              }
            : {}),
        },
      ],
      configurations: [
        ...g1Configurations,
        extractConfiguration,
        proactiveConfiguration,
      ],
    });
    if (!providers.openLoopExtractProvider || !providers.proactiveFollowupProvider) {
      throw new Error("The bundle provider assembly is missing a bundle role.");
    }
    return {
      extract: providers.openLoopExtractProvider,
      proactive: providers.proactiveFollowupProvider,
    };
  })();

  const adapterForMode = (): Parameters<typeof runScene>[0]["adapter"] => {
    if (arguments_.mode === "main") {
      if (conversationAdapter.type !== "responses-api") {
        throw new Error("Main capture requires a responses-api adapter.");
      }
      return {
        apiKey: conversationAdapter.apiKey,
        baseUrl: conversationAdapter.baseUrl,
        timeoutMs: conversationAdapter.timeoutMs,
        type: "responses-api",
      };
    }
    return { type: "replay" };
  };

  const mainRun =
    arguments_.mode === "main"
      ? null
      : (JSON.parse(
          await readFile(resolve(arguments_.mainIn), "utf8"),
        ) as unknown as V4MainRun);
  if (
    mainRun &&
    (mainRun.version !== F3_V4_MAIN_RUN_VERSION ||
      mainRun.format !== F3_V4_MAIN_RUN_VERSION ||
      mainRun.synthetic !== true)
  ) {
    throw new Error("The frozen main capture is not a v4 synthetic main run.");
  }
  const mainByScene = new Map<string, Map<number, string>>();
  for (const response of mainRun?.responses ?? []) {
    const turns = mainByScene.get(response.fixtureId) ?? new Map<number, string>();
    turns.set(response.sequenceInScenario, response.text);
    mainByScene.set(response.fixtureId, turns);
  }

  const providerErrors: ProviderErrorReport[] = [];
  const sceneCaptures: SceneCapture[] = [];
  const selectedScenes = scenes.filter(
    (scene) => !arguments_.only || scene.id === arguments_.only,
  );
  const captureScene = async (scene: V4Scene): Promise<SceneCapture | null> => {
    if (mainRun && !mainByScene.has(scene.id)) {
      providerErrors.push({
        category: "configuration",
        message: `Main capture has no responses for scene ${scene.id}.`,
        sceneId: scene.id,
        sequenceInScenario: 0,
      });
      return null;
    }
    try {
      const captured = await runScene({
        adapter: adapterForMode(),
        champion,
        commandService,
        continueOnError: arguments_.continueOnError,
        extractConfiguration,
        frozenMain: mainByScene.get(scene.id) ?? null,
        mode: arguments_.mode,
        providerErrors,
        roleProviders,
        scene,
      });
      if (captured && arguments_.mode === "main") {
        const questioned = captured.turns.filter(
          (turn) => countFollowUpQuestions(turn.preCompositionMainText) > 0,
        );
        if (questioned.length > 0) {
          console.log(
            `[g2-v4-capture] ${scene.id}: preserved one main result with a question at ${questioned
              .map((turn) => `t${turn.sequenceInScenario}`)
              .join(", ")}; the production gate will decide whether G2 runs`,
          );
        }
      }
      return captured;
    } catch (error) {
      providerErrors.push({
        category: "harness",
        message: error instanceof Error ? error.message : String(error),
        sceneId: scene.id,
        sequenceInScenario: 0,
      });
      console.error(`[g2-v4-capture] ${scene.id} aborted:`, error);
      return null;
    }
  };

  const concurrency = Math.max(1, arguments_.concurrency);
  const results = new Array<SceneCapture | null>(selectedScenes.length).fill(null);
  let nextIndex = 0;
  let fatal = false;
  const worker = async (): Promise<void> => {
    while (!fatal) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= selectedScenes.length) return;
      const captured = await captureScene(selectedScenes[index]!);
      results[index] = captured;
      if (captured === null && !arguments_.continueOnError) {
        fatal = true;
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, selectedScenes.length) }, () => worker()),
  );
  for (const captured of results) {
    if (captured !== null) sceneCaptures.push(captured);
  }

  const cleanIncumbentRaw = await readFile(
    resolve("eval/continuation-acceptance-1a3b/run/clean-incumbent.json"),
    "utf8",
  );
  const cleanIncumbentManifestFingerprint = sha256(JSON.parse(cleanIncumbentRaw));
  const cleanIncumbent = JSON.parse(cleanIncumbentRaw) as unknown as Readonly<{
    configurationFingerprint: string;
    configId: string;
    gitCommit: string;
  }>;

  if (arguments_.mode === "main") {
    const run: V4MainRun = {
      catalogVersion: manifest.version,
      domainTime: DOMAIN_TIME,
      cleanIncumbentCommit: cleanIncumbent.gitCommit,
      cleanIncumbentManifestFingerprint,
      conversationConfigId: cleanIncumbent.configId,
      conversationConfigurationFingerprint: cleanIncumbent.configurationFingerprint,
      evaluatorCommit,
      format: F3_V4_MAIN_RUN_VERSION,
      group: GROUP,
      responses: sceneCaptures.flatMap((capture) => capture.mainResponses),
      sourceKind: "synthetic-eval",
      synthetic: true,
      version: F3_V4_MAIN_RUN_VERSION,
    };
    await writeJson(arguments_.mainOut, run);
    console.log(
      `[g2-v4-capture] wrote ${run.responses.length} main responses to ${arguments_.mainOut}`,
    );
  } else {
    const configId =
      arguments_.mode === "off"
        ? OFF_CONFIG_ID
        : pins.continuation.arms.on.id;
    const run: V4ArmRun = {
      arm: arguments_.mode,
      catalogVersion: manifest.version,
      domainTime: DOMAIN_TIME,
      configId,
      configurationFingerprint: v4ConfigurationFingerprint(pins, configId),
      evaluatorCommit,
      format: F3_V4_ARM_RUN_VERSION,
      group: GROUP,
      scenarios: sceneCaptures.map((capture) => ({
        fixtureId: capture.scene.id,
        turns: capture.turns,
      })),
      sourceKind: "synthetic-eval",
      synthetic: true,
      version: F3_V4_ARM_RUN_VERSION,
    };
    const out =
      arguments_.mode === "off" ? arguments_.offOut : arguments_.onOut;
    await writeJson(out, run);
    console.log(
      `[g2-v4-capture] wrote ${run.scenarios.length} scenarios to ${out}`,
    );
    if (arguments_.mode === "on") {
      const ledger: V4TreatmentLedger = {
        catalogVersion: manifest.version,
        domainTime: DOMAIN_TIME,
        configId,
        configurationFingerprint: run.configurationFingerprint,
        evaluatorCommit,
        format: F3_V4_LEDGER_VERSION,
        scenarios: sceneCaptures.map((capture) => ({
          ...capture.ledger,
          cleanIncumbentCommit: cleanIncumbent.gitCommit,
          cleanIncumbentManifestFingerprint,
        })),
        synthetic: true,
        version: F3_V4_LEDGER_VERSION,
      };
      await writeJson(arguments_.ledgerOut, ledger);
      console.log(
        `[g2-v4-capture] wrote treatment ledger to ${arguments_.ledgerOut}`,
      );
    }
  }

  if (providerErrors.length > 0) {
    console.log(`[g2-v4-capture] provider errors: ${providerErrors.length}`);
    for (const error of providerErrors) {
      console.log(
        `[g2-v4-capture]   - ${error.sceneId} t${error.sequenceInScenario} [${error.category}]: ${error.message}`,
      );
    }
  }
  if (providerErrors.length > 0) process.exitCode = 1;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main().catch((error: unknown) => {
  console.error("[g2-v4-capture] failed:", error);
  process.exitCode = 1;
});
