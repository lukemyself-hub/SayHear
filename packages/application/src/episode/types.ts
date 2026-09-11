import type {
  DailySessionId,
  EpisodeCandidateId,
  EpisodeId,
  EpisodeVersionId,
  EvidenceItemId,
  GenerationCommandId,
  ModelRunAttemptId,
  UserId,
  WorkflowCommandId,
} from "@sayhear/domain";

/**
 * 1A.3b A1 (issue #197). Episode identity, resolution and lifecycle follow
 * ADR-0037 / ADR-0120 / ADR-0122 lineage: the model only proposes typed
 * proposals; deterministic code validates the real-world anchor and decides
 * whether a proposal creates a new Episode, conservatively continues the one
 * uniquely-anchored Episode, or stays unresolved. Rejected and stale
 * candidates are terminal and never auto-revive (ADR-0046).
 */
export const EPISODE_ADMISSION_POLICY_VERSION = "episode-admission:v1";

/** Daily builder orchestration policy (Journal-style eligibility). */
export const EPISODE_BUILDER_POLICY_VERSION = "episode-builder:v1";

/** Impact review policy for correction / identity change revalidation. */
export const EPISODE_IMPACT_REVIEW_POLICY_VERSION = "episode-impact-review:v1";

/**
 * Code-versioned closed kind catalog (ADR-0120). The model may only propose a
 * kind from this catalog; an unmapped proposal is deterministically
 * downgraded to `other`, never rejected and never queued for governance.
 * Expanding this catalog requires a code release.
 */
export const EPISODE_KIND_CATALOG_V1 = [
  "sh.episode.trip",
  "sh.episode.relocation",
  "sh.episode.project_phase",
  "sh.episode.occurrence",
  "sh.episode.other",
] as const;

export type EpisodeKind = (typeof EPISODE_KIND_CATALOG_V1)[number];

export function isEpisodeKind(value: string): value is EpisodeKind {
  return (EPISODE_KIND_CATALOG_V1 as readonly string[]).includes(value);
}

/**
 * Time-bound precision is preserved exactly as the Evidence states it
 * (CONTEXT.md "Episode Temporal Anchor"); the system never completes a
 * coarse boundary into an exact date.
 */
export type EpisodeBoundaryPrecision =
  | "exact"
  | "month"
  | "year"
  | "approximate"
  | "unknown";

export type EpisodeBoundary = Readonly<{
  date?: string;
  precision: EpisodeBoundaryPrecision;
}>;

export type EpisodeTemporalAnchor = Readonly<{
  start: EpisodeBoundary;
  end?: EpisodeBoundary;
}>;

export type EpisodePhase = "planned" | "ongoing" | "completed" | "unknown";

/**
 * Optional typed fields allowed per kind (v1). Every kind accepts none; the
 * listed keys are the only permitted extras and `other` accepts none at all,
 * so coverage diversity lives in label / anchors / evidence (ADR-0120).
 */
const EPISODE_KIND_TYPED_FIELD_ALLOWLIST: Readonly<
  Record<EpisodeKind, readonly string[]>
> = {
  "sh.episode.trip": ["destination"],
  "sh.episode.relocation": ["fromPlace", "toPlace"],
  "sh.episode.project_phase": ["project"],
  "sh.episode.occurrence": [],
  "sh.episode.other": [],
};

export function episodeKindTypedFields(kind: EpisodeKind): readonly string[] {
  return EPISODE_KIND_TYPED_FIELD_ALLOWLIST[kind];
}

export type EpisodeContent = Readonly<{
  kind: EpisodeKind;
  label: string;
  temporalAnchor: EpisodeTemporalAnchor;
  phase: EpisodePhase;
  kindFields: Readonly<Record<string, string>>;
}>;

/**
 * One model proposal for one real-world occurrence. Output of the
 * `episode.build` role; always advisory, never authoritative.
 */
export type EpisodeProposal = Readonly<{
  proposedKind: string;
  label: string;
  temporalAnchor: EpisodeTemporalAnchor;
  phase: EpisodePhase;
  kindFields: Readonly<Record<string, string>>;
  citedEvidenceItemIds: readonly EvidenceItemId[];
  entityAnchorIds?: readonly string[];
  /**
   * The proposal must declare that the cited Evidence describes a real-world
   * event or ongoing process (not chat, a topic, an emotion, or a
   * relationship fact). Without it admission rejects (ADR-0037); `other` is
   * subject to the same gate.
   */
  realWorldOccurrence: boolean;
  /**
   * Explicit user continuity expression ("东京第二天…"): cites one evidence
   * item and quotes a span of its underlying revision text.
   */
  explicitContinuity?: Readonly<{
    evidenceItemId: EvidenceItemId;
    span: string;
  }>;
  /**
   * The Evidence explicitly marks a distinct new occurrence (e.g. a later
   * repeat of the same kind of event). Explicitly new occurrences never
   * continue an older Episode (ADR-0037).
   */
  explicitNewOccurrence?: boolean;
}>;

export type EpisodeCandidateResolutionStatus = "new" | "matched" | "unresolved";

export type EpisodeCandidateStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "stale";

export type EpisodeCandidateRecord = Readonly<{
  episodeCandidateId: EpisodeCandidateId;
  userId: UserId;
  dailySessionId: DailySessionId;
  sourceRevision: number;
  proposedKind: EpisodeKind;
  proposedExistingEpisodeId: EpisodeId | null;
  proposedLabel: string | null;
  proposedTemporalAnchor: EpisodeTemporalAnchor | null;
  proposedPhase: EpisodePhase | null;
  explicitContinuitySpan: string | null;
  resolutionStatus: EpisodeCandidateResolutionStatus;
  status: EpisodeCandidateStatus;
  admissionReasonCode: string | null;
  policyVersion: string;
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  predecessorCandidateId: EpisodeCandidateId | null;
  successorTrigger: "materially_new_evidence" | null;
  materialChangeReasonCodes: readonly string[];
  dedupeFingerprint: string | null;
  dedupeFingerprintKeyVersion: string | null;
  reproposalPolicy: "material_change_allowed" | null;
  dispositionReasonCode: string | null;
  dispositionPolicyVersion: string | null;
  decidedAt: Date | null;
  terminalEffectiveAt: Date | null;
  terminalContentExpiresAt: Date | null;
  createdAt: Date;
  contentPurgedAt: Date | null;
}>;

export type EpisodeVersionRecord = Readonly<{
  episodeVersionId: EpisodeVersionId;
  episodeId: EpisodeId;
  userId: UserId;
  revision: number;
  sourceRevision: number;
  kind: EpisodeKind;
  status: "current" | "superseded";
  label: string | null;
  content: EpisodeContent | null;
  policyVersion: string;
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  supersedesVersionId: EpisodeVersionId | null;
  enrichmentPausedAt: Date | null;
  enrichmentPauseReason: string | null;
  createdAt: Date;
  contentPurgedAt: Date | null;
}>;

/** Deterministic rejection codes; all are terminal (no auto-revival). */
export type EpisodeAdmissionRejectionCode =
  | "cited_evidence_missing"
  | "evidence_ineligible"
  | "no_real_world_anchor"
  | "label_invalid"
  | "temporal_anchor_invalid"
  | "typed_field_invalid"
  | "entity_anchor_invalid"
  | "entity_anchor_ambiguous";

export type EpisodeDispositionReasonCode =
  | EpisodeAdmissionRejectionCode
  | "unresolved_stale_expired";

/**
 * Unresolved proposals keep their open state for at most 30 days (the
 * Memory-Candidate review deadline rule, inherited); terminal content is
 * cleared after 7 days and only the contentless envelope remains
 * (ADR-0051 rule, ADR-0130).
 */
export const EPISODE_UNRESOLVED_CANDIDATE_STALE_DAYS = 30;
export const EPISODE_TERMINAL_CONTENT_EXPIRY_DAYS = 7;
/** Bound on proposals a single daily build may persist. */
export const MAX_PROPOSALS_PER_BUILD = 20;
/** Bounded maintenance pass size (mirrors the Memory Candidate sweeper). */
export const MAX_EPISODE_SWEEPER_ROWS_PER_PASS = 500;
export const EPISODE_DEDUPE_FINGERPRINT_KEY_VERSION =
  "episode-dedupe-fingerprint-key:v1";

export type EpisodeCandidateDispositionPlan = Readonly<{
  status: "rejected" | "stale";
  dispositionReasonCode: EpisodeDispositionReasonCode;
  dispositionPolicyVersion: string;
  reproposalPolicy: "material_change_allowed";
  terminalEffectiveAt: Date;
  terminalContentExpiresAt: Date;
  dedupeFingerprint: string;
}>;

export type EpisodeAdmissionPlan =
  | Readonly<{
      action: "create_episode";
      kind: EpisodeKind;
      content: EpisodeContent;
      resolutionStatus: "new";
    }>
  | Readonly<{
      action: "continue_episode";
      kind: EpisodeKind;
      content: EpisodeContent;
      episodeId: EpisodeId;
      resolutionStatus: "matched";
      explicitContinuitySpan: string | null;
    }>
  | Readonly<{
      action: "stay_unresolved";
      kind: EpisodeKind;
      resolutionStatus: "unresolved";
    }>
  | Readonly<{
      action: "reject";
      kind: EpisodeKind;
      rejectionCode: EpisodeAdmissionRejectionCode;
    }>;

/**
 * Frozen model input: only approved IDs and semantic fields, never free
 * conversation text beyond the evidence locator semantics.
 */
export type EpisodeBuildModelRequest = Readonly<{
  userId: UserId;
  dailySessionId: DailySessionId;
  sourceRevision: number;
  kindCatalog: readonly EpisodeKind[];
  evidence: readonly EpisodeBuildEvidenceInput[];
  activeEpisodes: readonly EpisodeBuildEpisodeInput[];
}>;

export type EpisodeBuildEvidenceInput = Readonly<{
  evidenceItemId: EvidenceItemId;
  locatorType: string;
  locatorKey: string;
  sourceText: string;
  locale: string | null;
}>;

export type EpisodeBuildEpisodeInput = Readonly<{
  episodeId: EpisodeId;
  kind: EpisodeKind;
  temporalAnchor: EpisodeTemporalAnchor | null;
  entityAnchorIds: readonly string[];
  label: string | null;
}>;

/**
 * Role-scoped producer seam for `episode.build`: receives the frozen typed
 * input and returns typed proposals; classification and admission stay in
 * deterministic code.
 */
export type EpisodeBuildModelProvider = Readonly<{
  role: "episode.build";
  buildProposals(
    request: EpisodeBuildModelRequest,
  ): Promise<readonly EpisodeProposal[]>;
}>;

// ---- Frozen daily eligibility + build input ---------------------------------

export type EpisodeEligibilitySnapshot = Readonly<{
  userId: UserId;
  dailySessionId: DailySessionId;
  logicalDate: string;
  sourceRevision: number;
  activityState: "active" | "quiescent";
  ownerEpoch: number;
}>;

/**
 * Everything the deterministic admission needs, frozen in one transaction:
 * valid evidence items, the active Episode pool, and resolvable Entity IDs.
 */
export type EpisodeFrozenBuildInput = Readonly<{
  evidence: readonly (EpisodeBuildEvidenceInput & {
    revisionId: string;
  })[];
  activeEpisodes: readonly (EpisodeBuildEpisodeInput & {
    currentVersionId: EpisodeVersionId;
    currentRevision: number;
  })[];
  resolvableEntityIds: readonly string[];
}>;

export type EpisodeBuildRunStatus =
  | "built"
  | "stale_source"
  | "fenced"
  | "retryable_failed"
  | "failed";

export type EpisodeBuildRunOutcomeRow = Readonly<{
  userId: UserId;
  dailySessionId: DailySessionId;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
  generationCommandId: GenerationCommandId | null;
  modelRunAttemptId: ModelRunAttemptId | null;
  status: EpisodeBuildRunStatus;
  outcomeDetail: string | null;
  candidateCount: number;
  acceptedCount: number;
  unresolvedCount: number;
  rejectedCount: number;
  errorCode: string | null;
}>;

export type EpisodeMaintenanceSweepResult = Readonly<{
  staledCandidates: number;
  alreadyTerminalCandidates: number;
}>;

export type EpisodeMaintenanceResult = Readonly<{
  staledCandidates: number;
  alreadyTerminalCandidates: number;
  purgedTerminalCandidates: number;
  pausedVersions: number;
  revalidatedVersions: number;
  supersededVersions: number;
}>;

export type EpisodeBuildEntrypointInput = Readonly<{
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}>;

export type EpisodeBuildAttemptInput = Readonly<{
  workflowCommandId: string;
  generationCommandId: string;
  modelRunAttemptId: string;
  attemptNo: number;
  attemptKind: string;
  rolloutPin: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}>;

export type EpisodeBuildEntrypointResult = Readonly<{
  dailySessionId: string;
  outcome:
    | "built"
    | "stale_superseded"
    | "fenced"
    | "retryable_failed"
    | "failed";
  candidateCount: number;
  acceptedCount: number;
  unresolvedCount: number;
  rejectedCount: number;
  errorCode: string | null;
}>;

export type EpisodeBuilderRepository = Readonly<{
  readPolicyVersion(): Promise<string | null>;
  /** One transaction: locks the owner + session, queues the build command. */
  queueEpisodeBuild(input: {
    dailySessionId: DailySessionId;
    sourceRevision: number;
    policyVersion: string;
  }): Promise<
    | Readonly<{
        outcome: "queued";
        workflowCommandId: WorkflowCommandId;
        userId: UserId;
        expectedDataEpoch: number;
      }>
    | Readonly<{ outcome: "already_queued" }>
    | Readonly<{ outcome: "not_found" }>
    | Readonly<{ outcome: "not_quiescent" }>
  >;
  /** Queues the maintenance command for one owner (idempotent per day). */
  queueEpisodeMaintenance(input: {
    userId: UserId;
    policyVersion: string;
  }): Promise<
    | Readonly<{ outcome: "queued"; workflowCommandId: WorkflowCommandId }>
    | Readonly<{ outcome: "already_queued" }>
  >;
  /**
   * Locks the session owner in one transaction and returns the eligibility
   * snapshot plus the frozen build input, or a stale/quiescent outcome.
   */
  readSessionSnapshot(input: {
    dailySessionId: DailySessionId;
    sourceRevision: number;
    policyVersion: string;
  }): Promise<
    | Readonly<{
        outcome: "evaluated";
        snapshot: EpisodeEligibilitySnapshot;
        frozen: EpisodeFrozenBuildInput;
      }>
    | Readonly<{ outcome: "not_found" }>
    | Readonly<{ outcome: "not_quiescent" }>
    | Readonly<{ outcome: "stale_source" }>
  >;
  /**
   * Reconstructs the frozen context for a retry attempt of an admitted
   * `episode.build` command. `settled` means the attempt already reached a
   * terminal state and the replay must not run the provider again.
   */
  readAttemptContext(input: {
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
  }): Promise<
    | Readonly<{
        outcome: "evaluated";
        userId: UserId;
        dailySessionId: DailySessionId;
        sourceRevision: number;
        policyVersion: string;
        expectedDataEpoch: number;
        attemptNo: number;
        attemptStatus: "prepared";
        frozen: EpisodeFrozenBuildInput;
      }>
    | Readonly<{ outcome: "settled" }>
    | Readonly<{ outcome: "not_found" }>
  >;
  /**
   * The single fenced domain commit for one daily build: verifies the owner
   * epoch, the session head, and the active `episode.build` rollout pin
   * inside one transaction; absorbs replays of an already-built key. The
   * current pointer only advances (never regresses).
   */
  commitEpisodeAdmission(input: {
    userId: UserId;
    dailySessionId: DailySessionId;
    sourceRevision: number;
    policyVersion: string;
    expectedDataEpoch: number;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    proposals: readonly EpisodeProposal[];
    dedupeFingerprintSecret: string;
  }): Promise<
    | Readonly<{
        outcome: "committed";
        candidateCount: number;
        acceptedCount: number;
        unresolvedCount: number;
        rejectedCount: number;
      }>
    | Readonly<{
        outcome: "already_built";
        candidateCount: number;
        acceptedCount: number;
        unresolvedCount: number;
        rejectedCount: number;
      }>
    | Readonly<{ outcome: "fenced"; reason: string }>
  >;
  /** Idempotent run-outcome write (never downgrades a built run). */
  recordBuildRunOutcome(input: EpisodeBuildRunOutcomeRow): Promise<{
    applied: boolean;
  }>;
  /** Stale pass: 30-day unresolved candidates become terminal. */
  staleUnresolvedCandidates(input: {
    userId: UserId;
    now: Date;
    policyVersion: string;
    dedupeFingerprintSecret: string;
    limit: number;
  }): Promise<EpisodeMaintenanceSweepResult>;
  /** Terminal content purge after the 7-day grace. */
  purgeExpiredTerminalCandidates(input: {
    userId: UserId;
    now: Date;
    limit: number;
  }): Promise<number>;
  /**
   * Impact review detection: pause enrichment on current versions whose
   * linked Evidence or Entity anchors lost validity, and record the review.
   */
  detectAndPauseInvalidatedVersions(input: {
    userId: UserId;
    policyVersion: string;
    limit: number;
  }): Promise<readonly EpisodeVersionId[]>;
  /**
   * Revalidates paused versions against the underlying Evidence only:
   * restores eligibility when every anchor is valid again, otherwise marks
   * the review superseded (the next build appends the successor version).
   */
  revalidatePausedVersions(input: {
    userId: UserId;
    policyVersion: string;
    limit: number;
  }): Promise<Readonly<{ revalidated: number; superseded: number }>>;
  /** Owners with any due episode maintenance work. */
  listUsersNeedingMaintenance(input: {
    now: Date;
    policyVersion: string;
    limit: number;
  }): Promise<readonly UserId[]>;
  /**
   * Journal day-scope enrichment read (SPEC 4.3): only current EpisodeVersions
   * whose every evidence link still expands to a valid final/corrected User
   * Event revision inside the day, whose entity anchors still resolve, and
   * whose enrichment is not paused. A missing Episode never blocks Journal.
   */
  readDayScopeEnrichment(input: {
    userId: UserId;
    logicalDate: string;
    limit: number;
  }): Promise<
    readonly Readonly<{
      episodeId: EpisodeId;
      episodeVersionId: EpisodeVersionId;
      kind: EpisodeKind;
      label: string | null;
      content: EpisodeContent | null;
    }>[]
  >;
  /** Sessions with eligible evidence not yet built at the current head. */
  listQuiescentSessionsNeedingBuild(input: {
    now: Date;
    policyVersion: string;
    limit: number;
  }): Promise<
    readonly Readonly<{
      dailySessionId: DailySessionId;
      userId: UserId;
      sourceRevision: number;
    }>[]
  >;
}>;

export type {
  EpisodeCandidateId,
  EpisodeId,
  EpisodeVersionId,
} from "@sayhear/domain";

/**
 * Composition seam for the episode Workflow steps (mirrors the Memory
 * Consolidation entrypoint dependencies).
 */
export type EpisodeBuildEntrypointDependencies = Readonly<{
  clock: () => Date;
  repository: EpisodeBuilderRepository;
  modelRoleCommandService: import("../model-role-runtime").ModelRoleCommandService;
  /** Final recovery/rollout/epoch claim immediately before provider dispatch. */
  providerEgress?: import("../model-role-runtime").ModelRoleProviderEgress;
  episodeBuildProvider: EpisodeBuildModelProvider;
  dedupeFingerprintSecret: string;
  workflowReceiptId: string;
}>;
