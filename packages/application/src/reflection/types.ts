import type {
  DailySessionId,
  EvidenceItemId,
  GenerationCommandId,
  ModelRunAttemptId,
  NarrativeValidatorRequestId,
  ReflectionId,
  ReflectionStatementId,
  ReflectionVersionId,
  UserId,
  WorkflowCommandId,
} from "@sayhear/domain";
import type { MemoryCandidateProposal } from "../memory-claim/types";

/**
 * 1A.3b A3 (issue #199, SPEC 5). Daily / Weekly Reflection is a non-authoritative,
 * internally inspectable observation built only from a frozen window input:
 * valid User Evidence, touched accepted EpisodeVersions as organizing material,
 * required compressed Session Summaries, and the structured Claim comparison
 * baseline. Reflection never reads Journal / Reflection / Bio / Open Loop /
 * Candidate text, and every new understanding enters Memory only through the
 * existing Candidate admission pipeline with `propose_new`.
 */

export const REFLECTION_ADMISSION_POLICY_VERSION = "reflection-admission:v1";

/** Day / week readiness + input freezing orchestration policy (Q2). */
export const REFLECTION_READINESS_POLICY_VERSION = "reflection-readiness:v1";

/** Output policy: statement kinds, budgets and the proposal envelope. */
export const REFLECTION_OUTPUT_POLICY_VERSION = "reflection-output:v1";

/** Frozen output schema shared by both Reflection roles. */
export const REFLECTION_OUTPUT_SCHEMA_VERSION = "reflection-output-schema:v1";

/** One frozen Prompt per artifact kind (ADR-0121 discipline for producers). */
export const REFLECTION_DAILY_PROMPT_VERSION = "reflection-daily:v1";
export const REFLECTION_WEEKLY_PROMPT_VERSION = "reflection-weekly:v1";

/**
 * Q2 (Luke, accepted): the Episode Builder runs first and Reflection waits a
 * versioned default of 30 minutes after the Episode enrichment target time.
 * A missing or failed Episode enrichment never blocks Reflection; the reason
 * is recorded on the version.
 */
export const REFLECTION_EPISODE_INTERVAL_MINUTES = 30;

/** Versioned mechanical budgets frozen in this implementation ticket. */
export const MAX_STATEMENTS_PER_VERSION = 12;
export const MAX_PROPOSITIONS_PER_STATEMENT = 6;
export const MAX_CANDIDATE_PROPOSALS_PER_VERSION = 10;
/**
 * Days whose Evidence exceeds this raw-event count must be represented by
 * their compressed Session Summary in the frozen input (token-budget policy,
 * `reflection-output:v1`); the Evidence itself stays the only support.
 */
export const MAX_RAW_EVENTS_PER_DAY = 40;
/** Largest single-day Evidence manifest a version may cite support from. */
export const MAX_EVIDENCE_INPUT_ITEMS = 200;

/** Read-time retention (ADR-0130 / SPEC 5.3). */
export const REFLECTION_COMMITTED_SUPERSEDED_RETENTION_DAYS = 30;
export const REFLECTION_UNCOMMITTED_RETENTION_DAYS = 7;

export type ReflectionScopeType = "daily_session" | "date_range";

export type ReflectionStatementKind =
  | "day_observation"
  | "cross_day_theme"
  | "change_observation";

export type ReflectionPropositionKind = "fact" | "impression" | "synthesis";

export type ReflectionEpistemicRendering = "confirmed" | "inferred";

export type ReflectionVersionStatus =
  | "draft"
  | "failed"
  | "committed"
  | "superseded"
  | "stale";

/**
 * Structured Claim comparison baseline entry (SPEC 5.1): the same eligibility
 * fence as the Bio eligible Claim set, minus every narrative projection body.
 * The baseline only tells the generator what to compare against; it is never
 * Evidence and never support.
 */
export type ReflectionBaselineEntry = Readonly<{
  claimId: string;
  claimVersionId: string;
  kind: "objective" | "impression";
  predicateId: string;
  scopeKey: string;
  typedValue: string | readonly string[];
  temporalStatus: "current" | "ended" | "unknown";
  validFrom: string | null;
  validFromPrecision: "exact" | "month" | "year" | "approximate" | "unknown";
  validTo: string | null;
  validToPrecision: "exact" | "month" | "year" | "approximate" | "unknown";
  epistemicStatus: "confirmed" | "inferred";
  lastObservedAt: string;
}>;

/** One frozen Evidence input item (the only epistemic support). */
export type ReflectionEvidenceInput = Readonly<{
  evidenceItemId: EvidenceItemId;
  dailySessionId: DailySessionId;
  logicalDate: string;
  locatorType: string;
  locatorKey: string;
  sourceText: string;
  locale: string | null;
  revisionId: string;
}>;

/** Touched accepted EpisodeVersion, organizing material only. */
export type ReflectionEpisodeInput = Readonly<{
  episodeId: string;
  episodeVersionId: string;
  kind: string;
  label: string | null;
}>;

/** Required compressed Session Summary for over-budget days. */
export type ReflectionSummaryInput = Readonly<{
  dailySessionId: DailySessionId;
  rollingSummaryVersionId: string;
  content: string;
}>;

export type ReflectionFrozenInput = Readonly<{
  scopeType: ReflectionScopeType;
  dailySessionId: DailySessionId | null;
  weekIdentifier: string | null;
  windowStartDate: string | null;
  windowEndDate: string | null;
  /** Distinct activity days with their Daily Session source heads. */
  days: readonly Readonly<{
    dailySessionId: DailySessionId;
    logicalDate: string;
    sourceRevision: number;
    summarized: boolean;
  }>[];
  evidence: readonly ReflectionEvidenceInput[];
  episodes: readonly ReflectionEpisodeInput[];
  summaries: readonly ReflectionSummaryInput[];
  baseline: readonly ReflectionBaselineEntry[];
  claimBaselineDigest: string;
  /** Weekly composite source digest; null for Daily scope. */
  sourceDigest: string | null;
  dominantLocale: string | null;
}>;

export type ReflectionEligibilitySnapshot = Readonly<{
  userId: UserId;
  scopeType: ReflectionScopeType;
  dailySessionId: DailySessionId | null;
  weekIdentifier: string | null;
  sourceRevision: number;
  sourceDigest: string | null;
  ownerEpoch: number;
}>;

// ---- Model provider seam -----------------------------------------------------

export type ReflectionGenerationModelRequest = Readonly<{
  userId: UserId;
  role: "reflection.daily" | "reflection.weekly";
  scopeType: ReflectionScopeType;
  weekIdentifier: string | null;
  locale: string;
  evidence: readonly ReflectionEvidenceInput[];
  episodes: readonly ReflectionEpisodeInput[];
  summaries: readonly ReflectionSummaryInput[];
  baseline: readonly ReflectionBaselineEntry[];
  sessionCount: number;
  maxStatements: number;
  maxPropositionsPerStatement: number;
  maxCandidateProposals: number;
}>;

export type ReflectionModelProposition = Readonly<{
  propositionKey: string;
  normalizedProposition: string;
  propositionKind: ReflectionPropositionKind;
  epistemicRendering: ReflectionEpistemicRendering;
  /** Only frozen EvidenceItem IDs; Claims never support. */
  supportEvidenceItemIds: readonly string[];
  /** change_observation only: frozen baseline claim IDs. */
  baselineClaimIds: readonly string[];
}>;

export type ReflectionModelStatement = Readonly<{
  statementKey: string;
  text: string;
  statementKind: ReflectionStatementKind;
  propositions: readonly ReflectionModelProposition[];
}>;

/**
 * `propose_new`-only Memory Candidate proposal (SPEC 5.2): the original
 * MemoryCandidate proposal envelope; reinforcement / contest / supersede stay
 * owned by `memory.consolidate`.
 */
export type ReflectionModelCandidateProposal = Readonly<{
  candidateKind: "objective" | "impression";
  basis: "directly_stated" | "inferred";
  predicateId: string | null;
  proposedConcept: string | null;
  typedValue: string | readonly string[];
  scopeKey: string;
  temporal: Readonly<{
    temporalStatus: "current" | "ended" | "unknown";
    validFrom: string | null;
    validFromPrecision: "exact" | "month" | "year" | "approximate" | "unknown";
    validTo: string | null;
    validToPrecision: "exact" | "month" | "year" | "approximate" | "unknown";
  }>;
  evidenceItemIds: readonly string[];
}>;

export type ReflectionGenerationModelOutput = Readonly<{
  statements: readonly ReflectionModelStatement[];
  candidateProposals: readonly ReflectionModelCandidateProposal[];
}>;

export type ReflectionGenerationModelProvider = Readonly<{
  role: "reflection.daily" | "reflection.weekly";
  generate(
    request: ReflectionGenerationModelRequest,
  ): Promise<ReflectionGenerationModelOutput>;
}>;

// ---- Deterministic gate ------------------------------------------------------

/** Tier-1 deterministic rejection codes; all are all-or-nothing (SPEC 5.2). */
export type ReflectionTier1RejectionCode =
  | "schema_invalid"
  | "locale_invalid"
  | "statement_kind_invalid"
  | "statement_limit_exceeded"
  | "proposition_limit_exceeded"
  | "statement_text_invalid"
  | "proposition_text_invalid"
  | "support_evidence_invalid"
  | "claim_based_support"
  | "baseline_claim_out_of_bounds"
  | "cross_day_session_count"
  | "daily_scope_kind_invalid"
  | "candidate_limit_exceeded"
  | "candidate_support_evidence_invalid";

export type ReflectionVersionPlan =
  | Readonly<{
      action: "persist_draft";
      statements: readonly ReflectionModelStatement[];
    }>
  | Readonly<{
      action: "fail_version";
      rejectionCode: ReflectionTier1RejectionCode;
      detail: string;
    }>;

// ---- Candidate handoff -------------------------------------------------------

export type ReflectionCandidateOutcomeCode =
  | "created"
  | "created_needs_predicate_review"
  | "blocked_terminal"
  | "skipped";

export type ReflectionCandidateOutcome = Readonly<{
  proposalIndex: number;
  outcome: ReflectionCandidateOutcomeCode;
  reasonCode: string | null;
  memoryCandidateId: string | null;
}>;

// ---- Run ledger --------------------------------------------------------------

export type ReflectionRunStatus =
  | "ready"
  | "built"
  | "stale_source"
  | "fenced"
  | "retryable_failed"
  | "failed";

export type ReflectionRunOutcomeRow = Readonly<{
  userId: UserId;
  scopeType: ReflectionScopeType;
  dailySessionId: DailySessionId | null;
  weekIdentifier: string | null;
  windowStartDate: string | null;
  windowEndDate: string | null;
  sourceRevision: number;
  sourceDigest: string | null;
  claimBaselineDigest: string;
  policyVersion: string;
  expectedDataEpoch: number;
  generationCommandId: GenerationCommandId | null;
  modelRunAttemptId: ModelRunAttemptId | null;
  status: ReflectionRunStatus;
  outcomeDetail: string | null;
  statementCount: number | null;
  candidateCount: number | null;
  degradedEpisodeReason: string | null;
  errorCode: string | null;
}>;

export type ReflectionCommitInput = Readonly<{
  userId: UserId;
  reflectionVersionId: ReflectionVersionId;
  frozen: ReflectionFrozenInput;
  sourceRevision: number;
  sourceDigest: string | null;
  claimBaselineDigest: string;
  policyVersion: string;
  expectedDataEpoch: number;
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  validatorRequestId: NarrativeValidatorRequestId;
  validatorResultId: string;
  promptVersion: string;
  locale: string;
  statements: readonly ReflectionModelStatement[];
  candidateProposals: readonly ReflectionModelCandidateProposal[];
  dedupeFingerprintSecret: string;
}>;

export type ReflectionDraftInput = Readonly<{
  userId: UserId;
  scopeType: ReflectionScopeType;
  dailySessionId: DailySessionId | null;
  weekIdentifier: string | null;
  windowStartDate: string | null;
  windowEndDate: string | null;
  sourceRevision: number;
  sourceDigest: string | null;
  claimBaselineDigest: string;
  policyVersion: string;
  schedulePolicyVersion: string;
  promptVersion: string;
  schemaVersion: string;
  locale: string;
  expectedDataEpoch: number;
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  degradedEpisodeReason: string | null;
  statements: readonly ReflectionModelStatement[];
  now: Date;
}>;

export type ReflectionDraftResult =
  | Readonly<{
      outcome: "persisted";
      reflectionVersionId: ReflectionVersionId;
    }>
  | Readonly<{ outcome: "already_persisted"; reflectionVersionId: ReflectionVersionId }>
  | Readonly<{ outcome: "fenced"; reason: string }>;

export type ReflectionCommitResult =
  | Readonly<{
      outcome: "committed";
      reflectionVersionId: ReflectionVersionId;
      statementCount: number;
      candidateCount: number;
      candidateOutcomes: readonly ReflectionCandidateOutcome[];
    }>
  | Readonly<{ outcome: "already_committed" }>
  | Readonly<{ outcome: "fenced"; reason: string }>;

// ---- Repository --------------------------------------------------------------

export type QueuedReflection = Readonly<{
  outcome: "queued";
  workflowCommandId: WorkflowCommandId;
  userId: UserId;
  expectedDataEpoch: number;
}>;

export type ReflectionAttemptContext =
  | Readonly<{
      outcome: "evaluated";
      userId: UserId;
      scopeType: ReflectionScopeType;
      dailySessionId: DailySessionId | null;
      sourceRevision: number;
      sourceDigest: string | null;
      claimBaselineDigest: string;
      policyVersion: string;
      promptVersion: string;
      schemaVersion: string;
      expectedDataEpoch: number;
      attemptNo: number;
      attemptStatus: "prepared";
      frozen: ReflectionFrozenInput;
    }>
  | Readonly<{ outcome: "settled" }>
  | Readonly<{ outcome: "not_found" }>;

export type ReflectionAttemptPreparation = Readonly<{
  userId: UserId;
  scopeType: ReflectionScopeType;
  dailySessionId: DailySessionId | null;
  weekIdentifier: string | null;
  windowStartDate: string | null;
  windowEndDate: string | null;
  sourceRevision: number;
  sourceDigest: string | null;
  claimBaselineDigest: string;
  policyVersion: string;
  expectedDataEpoch: number;
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  now: Date;
}>;

export type ReflectionDailySnapshotOutcome =
  | Readonly<{
      outcome: "evaluated";
      snapshot: ReflectionEligibilitySnapshot;
      frozen: ReflectionFrozenInput;
      degradedEpisodeReason: string | null;
    }>
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "not_ready" }>
  | Readonly<{ outcome: "stale_source" }>
  | Readonly<{ outcome: "baseline_changed" }>;

export type ReflectionMaintenanceResult = Readonly<{
  expiredContent: number;
  staledVersions: number;
}>;

/**
 * PostgreSQL-facing port for the Reflection scheduler and generator
 * (issue #199). Mirrors the Episode builder port: every mutation runs in one
 * short transaction that locks the owner, re-verifies the data epoch, the
 * exact source head and the claim-baseline digest, and never regresses the
 * current pointer.
 */
export type ReflectionRepository = Readonly<{
  readPolicyVersion(): Promise<string | null>;
  /**
   * One transaction: locks the owner + session, re-verifies day readiness and
   * the frozen head, and queues the Daily Reflection command with the
   * claim-baseline digest in the intent key (Q3 identity).
   */
  queueDailyReflection(input: {
    dailySessionId: DailySessionId;
    sourceRevision: number;
    claimBaselineDigest: string;
    policyVersion: string;
  }): Promise<
    | QueuedReflection
    | Readonly<{ outcome: "already_queued" }>
    | Readonly<{ outcome: "not_found" }>
    | Readonly<{ outcome: "not_ready" }>
  >;
  /**
   * Queues the Weekly Reflection command for one owner and week window
   * (composite source identity; idempotent per week + digest).
   */
  queueWeeklyReflection(input: {
    userId: UserId;
    weekIdentifier: string;
    windowStartDate: string;
    windowEndDate: string;
    sourceDigest: string;
    policyVersion: string;
  }): Promise<
    | QueuedReflection
    | Readonly<{ outcome: "already_queued" }>
    | Readonly<{ outcome: "not_ready" }>
  >;
  /** Queues the maintenance command (retention + reverse lineage). */
  queueReflectionMaintenance(input: {
    userId: UserId;
    policyVersion: string;
  }): Promise<
    | Readonly<{ outcome: "queued"; workflowCommandId: WorkflowCommandId }>
    | Readonly<{ outcome: "already_queued" }>
  >;
  /**
   * Locks the owner + session and returns the readiness snapshot plus the
   * frozen generation input, or the typed stale / not-ready / baseline
   * outcome.
   */
  readDailySnapshot(input: {
    dailySessionId: DailySessionId;
    sourceRevision: number;
    claimBaselineDigest: string;
    policyVersion: string;
  }): Promise<ReflectionDailySnapshotOutcome>;
  /**
   * Locks the owner and returns the frozen Weekly input for the composite
   * digest, or the typed stale / not-ready outcome.
   */
  readWeeklySnapshot(input: {
    userId: UserId;
    weekIdentifier: string;
    windowStartDate: string;
    windowEndDate: string;
    sourceDigest: string;
    policyVersion: string;
  }): Promise<
    | Readonly<{
        outcome: "evaluated";
        snapshot: ReflectionEligibilitySnapshot;
        frozen: ReflectionFrozenInput;
      }>
    | Readonly<{ outcome: "not_ready" }>
    | Readonly<{ outcome: "stale_source" }>
    | Readonly<{ outcome: "digest_changed" }>
  >;
  /** Retry re-entry context from the shared command ledger. */
  readAttemptContext(input: {
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
  }): Promise<ReflectionAttemptContext>;
  /** Create the content-free run ledger before a Provider call. */
  prepareAttempt?(input: ReflectionAttemptPreparation): Promise<
    | Readonly<{ outcome: "prepared" | "already_prepared" | "already_built" }>
    | Readonly<{ outcome: "fenced"; reason: string }>
  >;
  /**
   * Persists the draft ReflectionVersion (status draft) and the ready run row
   * in one transaction, re-verifying epoch + exact head + baseline digest.
   * Called before narrative validation so the validator draft locator exists.
   */
  persistDraftVersion(input: ReflectionDraftInput): Promise<ReflectionDraftResult>;
  /**
   * The single fenced domain commit: recomputes data_epoch + exact head +
   * claim-baseline digest and the active rollout pin inside one transaction,
   * CAS-transitions the draft to committed and updates the current pointer,
   * then hands `propose_new` candidates to the admission pipeline.
   */
  commitReflection(input: ReflectionCommitInput): Promise<ReflectionCommitResult>;
  /** Idempotent run-outcome write (never downgrades a built run). */
  recordRunOutcome(input: ReflectionRunOutcomeRow): Promise<{ applied: boolean }>;
  /**
   * Reverse lineage invalidation (SPEC 5.3): Evidence correction / deletion /
   * invalidation marks every affected non-superseded ReflectionVersion stale
   * and stops it being read as current.
   */
  markStaleByInvalidatedEvidence(input: {
    userId: UserId;
    policyVersion: string;
    limit: number;
  }): Promise<number>;
  /** Read-time retention maintenance: expire content to a tombstone. */
  purgeExpiredContent(input: { now: Date; limit: number }): Promise<number>;
  /** Owners with any due Reflection maintenance work. */
  listUsersNeedingMaintenance(input: {
    now: Date;
    policyVersion: string;
    limit: number;
  }): Promise<readonly UserId[]>;
  /**
   * Daily Sessions whose readiness (Q2) is satisfied and that have no ready
   * or built run at the current head. The claim-baseline digest is computed
   * separately per session via `readDailyBaselineDigest`.
   */
  listDueDailySessions(input: {
    now: Date;
    policyVersion: string;
    limit: number;
  }): Promise<
    readonly Readonly<{
      dailySessionId: DailySessionId;
      userId: UserId;
      sourceRevision: number;
      degradedEpisodeReason: string | null;
    }>[]
  >;
  /**
   * Frozen claim-baseline digest for one Daily Session head at read time;
   * null when the session has no eligible Evidence window anymore.
   */
  readDailyBaselineDigest(input: {
    dailySessionId: DailySessionId;
    sourceRevision: number;
  }): Promise<string | null>;
  /**
   * Week windows whose activity days are all settled (Q2) and that have no
   * ready or built run at the current composite digest.
   */
  listDueWeekWindows(input: {
    now: Date;
    policyVersion: string;
    limit: number;
  }): Promise<
    readonly Readonly<{
      userId: UserId;
      weekIdentifier: string;
      windowStartDate: string;
      windowEndDate: string;
      sourceDigest: string;
    }>[]
  >;
  /** Producer read contract with read-time retention enforcement. */
  readCurrentVersion(input: {
    userId: UserId;
    dailySessionId: DailySessionId | null;
    weekIdentifier: string | null;
    now: Date;
  }): Promise<
    | Readonly<{
        outcome: "ok";
        reflectionVersionId: ReflectionVersionId;
        status: ReflectionVersionStatus;
        statements: readonly ReflectionModelStatement[];
      }>
    | Readonly<{ outcome: "no_current_version" }>
    | Readonly<{ outcome: "content_expired" }>
    | Readonly<{ outcome: "content_purged" }>
    | Readonly<{ outcome: "stale" }>
    | Readonly<{ outcome: "not_found" }>
  >;
}>;

export type { ReflectionId, ReflectionVersionId, ReflectionStatementId };

/**
 * Composition seam for the Reflection Workflow steps (mirrors the Episode
 * entrypoint dependencies). The narrative validator dependencies come from
 * the shared A2 seam.
 */
export type ReflectionEntrypointDependencies = Readonly<{
  clock: () => Date;
  repository: ReflectionRepository;
  modelRoleCommandService: import("../model-role-runtime").ModelRoleCommandService;
  /** Final recovery/rollout/epoch claim immediately before provider dispatch. */
  providerEgress?: import("../model-role-runtime").ModelRoleProviderEgress;
  reflectionProvider: ReflectionGenerationModelProvider;
  narrativeValidation: import("../narrative-validation/types").NarrativeValidationEntrypointDependencies;
  dedupeFingerprintSecret: string;
  workflowReceiptId: string;
}>;

export type ReflectionBuildEntrypointInput = Readonly<{
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  claimBaselineDigest: string;
  policyVersion: string;
  expectedDataEpoch: number;
  scope: "daily" | "weekly";
  /** Weekly scope only. */
  weekIdentifier: string | null;
  /** Weekly window dates. */
  windowStartDate: string | null;
  windowEndDate: string | null;
  /** Weekly composite source digest; null for Daily scope. */
  sourceDigest: string | null;
}>;

export type ReflectionAttemptEntrypointInput = Readonly<{
  generationCommandId: string;
  modelRunAttemptId: string;
  attemptNo: number;
  attemptKind: string;
  rolloutPin: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
  scope: "daily" | "weekly";
}>;

export type ReflectionBuildEntrypointResult = Readonly<{
  subjectId: string;
  scope: "daily" | "weekly";
  outcome:
    | "built"
    | "stale_superseded"
    | "fenced"
    | "retryable_failed"
    | "failed"
    | "rejected";
  rejectionCode: string | null;
  statementCount: number;
  candidateCount: number;
  degradedEpisodeReason: string | null;
  errorCode: string | null;
}>;
