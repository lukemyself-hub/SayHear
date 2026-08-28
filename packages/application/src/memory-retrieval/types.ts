import type {
  DailySessionId,
  UserId,
} from "@sayhear/domain";

import type {
  ClaimKind,
  PredicateLocalization,
  PredicateRegistryEntry,
} from "../predicate-registry/types";
import type {
  MemoryContextItem,
  MemorySectionBudgetActual,
  MemorySectionKey,
  MemoryVersionDetail,
  MemoryVersionEvidence,
} from "./memory-compilation";

/**
 * Structured-Lexical Retrieval Baseline types (issue #116, ADR-0115, SPEC
 * #107 "Retrieval", architecture §10). Three deterministic lanes — no
 * pre-retrieval LLM, no cross-encoder, no RRF, no pgvector / embedding /
 * pg_trgm — under one versioned shared deadline, fail-closed per the lane
 * health matrix. The manifest distinguishes query-construction zero signal,
 * empty candidates, and candidates eliminated by fences (story 40).
 */

/** Versioned deadline + lane cap policy (retrieval_policies row). */
export const MEMORY_RETRIEVAL_POLICY_VERSION = "memory-retrieval:v1";

/** Versioned query-construction rules (sources, term policy, stop list). */
export const RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION =
  "memory-retrieval-query:v1";

/** Versioned claim-retrieval projection rules (text + lexical term policy). */
export const CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION =
  "claim-retrieval-projection:v1";

export const RETRIEVAL_LANE_PRIORITY = [
  "structured_exact",
  "lexical_term_overlap",
  "english_fts",
] as const;

export type RetrievalLane = (typeof RETRIEVAL_LANE_PRIORITY)[number];

export type RetrievalDeadlineStage =
  | "query_construction"
  | "lane_execution"
  | "dedupe"
  | "ranking"
  | "fences";

export type RetrievalDegradedReasonCode =
  | "retrieval_deadline_exceeded"
  | "retrieval_lane_failed"
  | "retrieval_query_construction_failed"
  | "retrieval_policy_unavailable"
  | "retrieval_run_recording_failed"
  /** #117: hydrating selected retrieval candidates failed — the round's memory fails closed. */
  | "retrieval_candidate_hydration_failed";

/** #117: portrait-side failures degrade only the Portrait section (omitted), never the retrieval round. */
export type PortraitDegradedReasonCode = "portrait_load_failed";

export type RetrievalFenceCode =
  | "current_version"
  | "evidence"
  | "entity"
  | "correction"
  | "forget"
  | "contested"
  | "dormant"
  | "deletion";

export type TrustFenceResult = Readonly<{
  fence: RetrievalFenceCode;
  passed: boolean;
}>;

/**
 * Broad-topic / emotion / common-word surfaces (versioned with the query
 * policy). A lexical match that only hits these never passes the relevance
 * cutoff alone — precision first (architecture §10.3).
 */
export const RETRIEVAL_BROAD_TERM_STOP_LIST: readonly string[] = [
  // zh broad topics / emotion / common words
  "事情",
  "东西",
  "生活",
  "工作",
  "开心",
  "高兴",
  "快乐",
  "难过",
  "伤心",
  "烦",
  "累",
  "感觉",
  "觉得",
  "喜欢",
  "讨厌",
  "时候",
  "时间",
  "最近",
  "以前",
  "现在",
  "今天",
  "明天",
  "昨天",
  // en broad topics / emotion / common words
  "life",
  "work",
  "happy",
  "sad",
  "tired",
  "feel",
  "feeling",
  "think",
  "like",
  "time",
  "thing",
  "things",
  "today",
  "yesterday",
  "tomorrow",
  "recently",
];

/** Time-word vocabulary (versioned with the query policy). */
export const RETRIEVAL_TIME_WORDS: Readonly<
  Record<"past" | "recent" | "last_time", readonly string[]>
> = Object.freeze({
  past: ["以前", "之前", "早先", "before", "previously", "in the past"],
  recent: ["最近", "最近几天", "这两天", "lately", "recently", "these days"],
  last_time: ["上次", "上回", "last time"],
});

export type RetrievalTimeWordClass = keyof typeof RETRIEVAL_TIME_WORDS;

/** Deterministic normalization shared by query terms and projection terms. */
export function normalizeRetrievalTerm(term: string): string {
  return term
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Query construction (story 44: deterministic committed sources only;
// Assistant Events are never query sources).
// ---------------------------------------------------------------------------

export type RetrievalQuerySourceRef =
  | Readonly<{ kind: "current_user_event"; revisionId: string }>
  | Readonly<{ kind: "exchange_user_event"; revisionId: string; ordinal: number }>
  | Readonly<{
      kind: "current_topic";
      dialogueRevision: number;
    }>
  | Readonly<{ kind: "registry_lexical_alias"; registryVersion: number }>;

export type ResolvedQueryEntity = Readonly<{
  entityId: string;
  basis: "label" | "verified_alias" | "resolver_hint";
  surface: string;
}>;

export type QueryPredicateCandidate = Readonly<{
  predicateId: string;
  surface: string;
}>;

export type RetrievalQueryConstructionSources = Readonly<{
  currentInput: Readonly<{ revisionId: string; text: string }>;
  /** Newest first, at most two, current Continuous Exchange only. */
  priorUserEvents: readonly Readonly<{ revisionId: string; text: string }>[];
  /** Latest source-valid DialogueState topic, or null when stale / failed. */
  currentTopic: string | null;
  dialogueRevision: number;
  selfEntityId: string | null;
  /** Current entity label index (primary + verified aliases). */
  labelIndex: readonly Readonly<{
    entityId: string;
    label: string;
    labelKind: "primary" | "alias";
    locale: string;
  }>[];
  /** Resolver hints already re-validated against their claim's current version. */
  resolverHints: readonly Readonly<{
    entityId: string;
    phrase: string;
    locale: string;
  }>[];
}>;

/** Repository-loaded substrate of the query sources (no compiler inputs). */
export type RetrievalQuerySubstrate = Pick<
  RetrievalQueryConstructionSources,
  "priorUserEvents" | "selfEntityId" | "labelIndex" | "resolverHints"
>;

export type RetrievalRegistryMaterial = Readonly<{
  registryVersion: number;
  entryFor(predicateId: string): PredicateRegistryEntry | null;
  localizations: readonly PredicateLocalization[];
}>;

/**
 * Registry material threaded into claim-write executors so retrieval
 * projections rebuild in the same transaction as the version advance
 * (mirrors RelationshipHintProjectionInputs).
 */
export type RetrievalProjectionMaterial = Readonly<{
  entry: PredicateRegistryEntry;
  localizations: readonly PredicateLocalization[];
}>;

export type RetrievalLanePlanEntry = Readonly<{
  lane: RetrievalLane;
  enabled: boolean;
  notEnabledReason: string | null;
}>;

export type ConstructedRetrievalQuery = Readonly<{
  policyVersion: string;
  sourceRefs: readonly RetrievalQuerySourceRef[];
  /** User Event texts feeding lanes (current first, then prior, oldest last). */
  userTexts: readonly string[];
  englishQueryText: string;
  lexicalTerms: readonly string[];
  resolvedEntities: readonly ResolvedQueryEntity[];
  predicateCandidates: readonly QueryPredicateCandidate[];
  canonicalKeys: readonly string[];
  timeWordClasses: readonly RetrievalTimeWordClass[];
  dateTokens: readonly string[];
  lanePlan: readonly RetrievalLanePlanEntry[];
  zeroSignal: boolean;
}>;

// ---------------------------------------------------------------------------
// Lanes: candidate hits (Claim / projection references only).
// ---------------------------------------------------------------------------

export type RetrievalCandidateClaimState = Readonly<{
  claimId: string;
  versionId: string;
  projectionId: string;
  canonicalKey: string;
  subjectEntityId: string;
  objectEntityId: string | null;
  predicateId: string;
  kind: ClaimKind;
  temporalStatus: "current" | "ended" | "unknown";
  validFrom: string | null;
  validTo: string | null;
  lastObservedAt: string;
}>;

export type LaneCandidateHit = Readonly<{
  lane: RetrievalLane;
  claim: RetrievalCandidateClaimState;
  matchedFields: readonly string[];
  matchedTerms: readonly string[];
  /** English FTS only: ts_rank_cd within-lane ordering signal. */
  ftsRank: number | null;
}>;

// ---------------------------------------------------------------------------
// Fences (evaluated before ranking, across all lanes).
// ---------------------------------------------------------------------------

export type CandidateFenceState = Readonly<{
  versionId: string;
  isCurrentVersion: boolean;
  claimDeleted: boolean;
  claimContentPurged: boolean;
  versionContentPurged: boolean;
  projectionContentPurged: boolean;
  versionStatus: "active" | "review_due" | "dormant" | "superseded" | "retracted";
  epistemicStatus: "confirmed" | "inferred" | "contested";
  activeWholeClaimForget: boolean;
  validEvidenceCount: number;
  subjectEntityVersionStatus: string | null;
  objectEntityVersionStatus: string | null;
  /** Status of each party's CURRENT entity version — a merged / split /
   * deleted / unresolved current version stops Recall even when the
   * ClaimVersion still references an older active EntityVersion (§7.11). */
  subjectEntityCurrentVersionStatus: string | null;
  objectEntityCurrentVersionStatus: string | null;
  subjectEntityDeleted: boolean;
  objectEntityDeleted: boolean;
}>;

// ---------------------------------------------------------------------------
// Ranking + relevance cutoffs (SPEC §10.3).
// ---------------------------------------------------------------------------

export type RankComponents = Readonly<{
  entity_match: number;
  predicate_match: 0 | 1;
  temporal_fit: number;
  lexical_coverage: number;
  fts_rank: number | null;
  trust_kind: "objective" | "impression";
  last_observed_at: string;
  stable_id: string;
}>;

export type RankedCandidate = Readonly<{
  claim: RetrievalCandidateClaimState;
  lane: RetrievalLane;
  matchedFields: readonly string[];
  matchedTerms: readonly string[];
  rankComponents: RankComponents;
  finalRank: number;
  cutoffPassed: boolean;
  selectionReasonCodes: readonly string[];
  rejectionReasonCodes: readonly string[];
}>;

// ---------------------------------------------------------------------------
// Run outcome + manifest (compact, no prose; per-candidate rows persist
// separately in retrieval_run_candidates).
// ---------------------------------------------------------------------------

export type RetrievalRunManifest = Readonly<{
  retrieval_run_id: string;
  retrieval_policy_version: string;
  query_construction_policy_version: string;
  projection_policy_version: string;
  deadline_ms: number;
  query_source_refs: readonly RetrievalQuerySourceRef[];
  normalized_query_terms: Readonly<{
    lexical_terms: readonly string[];
    resolved_entities: readonly string[];
    predicate_candidates: readonly string[];
    canonical_keys: readonly string[];
    time_word_classes: readonly string[];
    date_tokens: readonly string[];
  }>;
  lane_plan: readonly RetrievalLanePlanEntry[];
  lane_hit_counts: Readonly<Record<RetrievalLane, number>>;
  zero_signal: boolean;
  candidate_count: number;
  qualified_count: number;
  fenced_out_count: number;
  /** #117: pinned selection strategy versions (cutover pin-list discipline). */
  selection_policy_versions: Readonly<{
    portrait_selection: string;
    memory_budgets: string;
    recall_framing: string;
  }>;
  /** #117: versioned ceilings versus injected actuals per memory section. */
  section_budget_vs_actual: MemorySectionBudgetActual;
  /** #117: per-turn Portrait reselection visibility (pool size + selections). */
  portrait_selection: Readonly<{
    pool_count: number;
    selected_claim_version_ids: readonly string[];
  }>;
  /** #117: Portrait-only failures; the retrieval round itself stays completed. */
  portrait_degraded_reason_codes: readonly PortraitDegradedReasonCode[];
  timings: Readonly<Record<string, number>>;
  duration_ms: number;
  deadline_exceeded_stage: string | null;
  degraded_reason_codes: readonly RetrievalDegradedReasonCode[];
}>;

export type MemoryRetrievalRunOutcome = Readonly<{
  retrievalRunId: string | null;
  status: "completed" | "degraded";
  degradedReasonCodes: readonly RetrievalDegradedReasonCode[];
  manifest: RetrievalRunManifest;
  /**
   * #117: the compiled memory items per section. Empty arrays when the run
   * degraded (the round's memory fails closed) or nothing qualified.
   */
  memorySections: Readonly<Record<MemorySectionKey, readonly MemoryContextItem[]>>;
}>;

export type MemoryRetrievalInput = Readonly<{
  userId: UserId;
  dailySession: Readonly<{
    id: DailySessionId;
    continuousExchangeNo: number;
  }>;
  sourceEventRevisionId: string;
  currentInputText: string;
  /** Source-valid current topic or null (stale / failed / invalidated). */
  currentTopic: string | null;
  dialogueRevision: number;
  /** Sequence of the current input event; prior exchange events load before it. */
  currentInputSequence: number;
  /** Compile locale resolved to a projection locale (zh / en, issue #117). */
  locale: "zh" | "en";
}>;

export type MemoryRetrievalPort = Readonly<{
  run(input: MemoryRetrievalInput): Promise<MemoryRetrievalRunOutcome>;
}>;

// ---------------------------------------------------------------------------
// Test-support fault injection (SPEC: lane failure / timeout injection is
// test-support configuration of the retrieval lanes, not a seam).
// ---------------------------------------------------------------------------

export type RetrievalFault = Readonly<{
  failWith?: Error;
  delayMs?: number;
}>;

export type RetrievalTestSupportConfiguration = Readonly<{
  queryConstruction?: RetrievalFault;
  structuredExact?: RetrievalFault;
  lexicalTermOverlap?: RetrievalFault;
  englishFts?: RetrievalFault;
}>;

export type RetrievalTestSupport = Readonly<{
  /** Read per run; tests mutate the backing object between turns. */
  configuration(): RetrievalTestSupportConfiguration | null;
}>;


// ---------------------------------------------------------------------------
// Repository port (Postgres implementation in @sayhear/data).
// ---------------------------------------------------------------------------

export type MemoryRetrievalPolicy = Readonly<{
  version: string;
  deadlineMs: number;
  candidateLimitPerLane: number;
}>;

export type RetrievalLaneRow = Readonly<{
  lane: RetrievalLane;
  memory_claim_id: string;
  memory_claim_version_id: string;
  claim_retrieval_projection_id: string;
  canonical_key: string;
  subject_entity_id: string;
  object_entity_id: string | null;
  predicate_id: string;
  kind: ClaimKind;
  temporal_status: "current" | "ended" | "unknown";
  valid_from: string | null;
  valid_to: string | null;
  last_observed_at: string;
  /** JSON text of the version's typed value (structured matched-field check). */
  typed_value_text: string | null;
  matched_terms: readonly string[] | null;
  fts_rank: number | null;
}>;

export type MemoryRetrievalRepository = Readonly<{
  loadPolicy(version: string): Promise<MemoryRetrievalPolicy | null>;
  loadQueryConstructionSources(input: {
    userId: UserId;
    dailySessionId: DailySessionId;
    exchangeNo: number;
    beforeSequence: number;
  }): Promise<RetrievalQuerySubstrate>;
  runStructuredLane(input: {
    userId: UserId;
    entityIds: readonly string[];
    predicateIds: readonly string[];
    canonicalKeys: readonly string[];
    dateTokens: readonly string[];
    limit: number;
  }): Promise<readonly RetrievalLaneRow[]>;
  runLexicalLane(input: {
    userId: UserId;
    terms: readonly string[];
    limit: number;
  }): Promise<readonly RetrievalLaneRow[]>;
  runEnglishLane(input: {
    userId: UserId;
    queryText: string;
    limit: number;
  }): Promise<readonly RetrievalLaneRow[]>;
  loadCandidateFenceStates(
    userId: UserId,
    versionIds: readonly string[],
  ): Promise<readonly CandidateFenceState[]>;
  /**
   * #117: current ClaimVersions of the portrait-eligible predicates with the
   * locale-resolved projection material (rendered text + lexical terms).
   * Structural prefiltering only — trust fences re-check per candidate.
   */
  loadPortraitCandidateVersions(input: {
    userId: UserId;
    predicateIds: readonly string[];
    locale: "zh" | "en";
  }): Promise<readonly MemoryVersionDetail[]>;
  /**
   * #117: hydration for retrieval-selected versions (rendered text, entity
   * version ids, epistemic / temporal state of the current version).
   */
  loadMemoryVersionDetails(input: {
    userId: UserId;
    versionIds: readonly string[];
    locale: "zh" | "en";
  }): Promise<readonly MemoryVersionDetail[]>;
  /**
   * #117: valid Evidence ids (ordered) plus latest valid Evidence timestamp
   * per version — the item's evidence trace and the portrait tie-break input.
   */
  loadMemoryVersionEvidence(
    userId: UserId,
    versionIds: readonly string[],
  ): Promise<readonly MemoryVersionEvidence[]>;
  insertRetrievalRun(input: {
    retrievalRunId: string;
    userId: UserId;
    dailySessionId: DailySessionId;
    sourceEventRevisionId: string;
    retrievalPolicyVersion: string;
    queryConstructionPolicyVersion: string;
    projectionPolicyVersion: string;
    deadlineMs: number;
    querySourceRefs: readonly RetrievalQuerySourceRef[];
    normalizedQueryTerms: RetrievalRunManifest["normalized_query_terms"];
    lanePlan: readonly RetrievalLanePlanEntry[];
    startedAt: Date;
  }): Promise<void>;
  completeRetrievalRun(input: {
    retrievalRunId: string;
    userId: UserId;
    status: "completed" | "degraded" | "failed";
    degradedReasonCodes: readonly string[];
    durationMs: number;
    deadlineExceededStage: string | null;
    timings: Readonly<Record<string, number>>;
    completedAt: Date;
  }): Promise<void>;
  insertRetrievalCandidates(input: {
    retrievalRunId: string;
    userId: UserId;
    candidates: readonly Readonly<{
      claimVersionId: string;
      retrievalProjectionId: string;
      lane: RetrievalLane;
      matchedFields: readonly string[];
      matchedTerms: readonly string[];
      trustFenceResults: readonly TrustFenceResult[];
      rankComponents: RankComponents;
      finalRank: number | null;
      selectedSection: MemorySectionKey | null;
      selectionReasonCodes: readonly string[];
      rejectionReasonCodes: readonly string[];
    }>[];
    now: Date;
  }): Promise<void>;
}>;
