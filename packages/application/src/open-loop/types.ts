import type {
  EvidenceItemId,
  GenerationCommandId,
  ModelRunAttemptId,
  OpenLoopId,
  OpenLoopVersionId,
  UserId,
} from "@sayhear/domain";

/**
 * 1A.3b C1 (issue #204). Open Loop identity, time, lifecycle follow SPEC ch.6,
 * ADR-0042 / ADR-0132 lineage: the `open_loop.extract` role only emits a
 * transient `OpenLoopProposal`; deterministic code owns eligibility, kind and
 * non-task validation, time normalization, finite expiry, source binding,
 * identity and dedupe. Direct User Evidence is the factual root; Claim and
 * Episode references are optional enrichment, and `localized_summary` is
 * rebuildable rendering. Ambiguous or invalid proposals fail closed without a
 * persistent candidate or review queue.
 */
export const OPEN_LOOP_EXTRACTION_POLICY_VERSION =
  "open-loop-extraction:v1";
export const OPEN_LOOP_FORMATION_POLICY_VERSION = "open-loop-formation:v2";
export const OPEN_LOOP_CLOSURE_POLICY_VERSION = "open-loop-closure:v1";
export const OPEN_LOOP_EXPIRY_POLICY_VERSION = "open-loop-expiry:v1";
/** Versioned near-term lexical allowlist; the model cannot invent near-term. */
export const OPEN_LOOP_NEAR_TERM_LEXICAL_POLICY_VERSION =
  "open-loop-near-term-lexical:v1";
export const OPEN_LOOP_DEDUPE_FINGERPRINT_KEY_VERSION =
  "open-loop-dedupe-fingerprint-key:v1";

/** Closed v1 kind catalog: upcoming_event | awaited_outcome. */
export const OPEN_LOOP_KINDS = ["upcoming_event", "awaited_outcome"] as const;
export type OpenLoopKind = (typeof OPEN_LOOP_KINDS)[number];

export function isOpenLoopKind(value: string): value is OpenLoopKind {
  return (OPEN_LOOP_KINDS as readonly string[]).includes(value);
}

export type OpenLoopStatus =
  | "open"
  | "occurred"
  | "resolved"
  | "canceled"
  | "expired"
  | "retracted";

export type OpenLoopTerminalStatus =
  | "occurred"
  | "resolved"
  | "canceled"
  | "expired"
  | "retracted";

export function isTerminalStatus(status: OpenLoopStatus): boolean {
  return status !== "open";
}

/**
 * Kind/status pairing: upcoming_event closes only as occurred; awaited_outcome
 * only as resolved; both share canceled/expired/retracted. Terminal states
 * never encode success/failure/satisfaction.
 */
const OPEN_LOOP_TERMINAL_BY_KIND: Readonly<
  Record<OpenLoopKind, readonly OpenLoopTerminalStatus[]>
> = {
  upcoming_event: ["occurred", "canceled", "expired", "retracted"],
  awaited_outcome: ["resolved", "canceled", "expired", "retracted"],
};

export function terminalStatusForKind(
  kind: OpenLoopKind,
): readonly OpenLoopTerminalStatus[] {
  return OPEN_LOOP_TERMINAL_BY_KIND[kind];
}

export function isKindStatusPairValid(
  kind: OpenLoopKind,
  status: OpenLoopTerminalStatus,
): boolean {
  return (
    OPEN_LOOP_TERMINAL_BY_KIND[kind] as readonly OpenLoopTerminalStatus[]
  ).includes(status);
}

export type OpenLoopTimePrecision =
  | "instant"
  | "date"
  | "range"
  | "approximate"
  | "unknown";

/**
 * Frozen expected window. Exact datetimes store an instant with null end;
 * date-only / bounded local ranges store an inclusive start and exclusive end
 * resolved in the Evidence Daily Session IANA timezone. Approximate/unknown
 * never fabricates a boundary. Later timezone changes never reinterpret a
 * frozen window; user correction creates a new Version from new Evidence.
 */
export type OpenLoopExpectedWindow = Readonly<{
  startAt: string | null;
  endAt: string | null;
  precision: OpenLoopTimePrecision;
  timezone: string | null;
}>;

export type OpenLoopExpirySource =
  | "anchored_upcoming_plus_7d"
  | "anchored_awaited_plus_14d"
  | "unanchored_plus_14d";

/**
 * Transient model output. Never persisted; single invalid proposals record a
 * content-free skip reason without saving proposal semantics.
 */
export type OpenLoopProposal = Readonly<{
  kind: string;
  /** Direct User Evidence locator backing this pending state. */
  evidenceItemId: EvidenceItemId;
  evidenceRevisionId: string;
  /** Atomically closable real pending state with a reality anchor. */
  hasRealAnchor: boolean;
  /** Task/reminder/goal/unfinished-topic/emotion markers; any true rejects. */
  isTaskLike: boolean;
  /** User time expression as stated (may be absent/fuzzy). */
  userTimeExpression?: string | null;
  /** Frozen expected window as proposed (null = no anchor claimed). */
  expectedWindow?: OpenLoopExpectedWindow | null;
  /** Optional enrichment: exact-same-fact active Objective ClaimVersion. */
  sourceClaimVersionId?: string | null;
  /** Optional enrichment: reliably-attributed EpisodeVersion. */
  sourceEpisodeVersionId?: string | null;
  /** Unique explicit binding to an existing logical Loop, if asserted. */
  explicitLoopBinding?: OpenLoopId | null;
  /** Canonical Objective Claim identity, when the proposal cites one. */
  canonicalClaimKey?: string | null;
  proposalIndex: number;
}>;

export type OpenLoopVersionRecord = Readonly<{
  openLoopVersionId: OpenLoopVersionId;
  openLoopId: OpenLoopId;
  userId: UserId;
  revision: number;
  kind: OpenLoopKind;
  sourceEvidenceItemId: EvidenceItemId;
  sourceEvidenceRevisionId: string;
  sourceClaimVersionId: string | null;
  sourceEpisodeVersionId: string | null;
  localizedSummary: string | null;
  expectedStartAt: string | null;
  expectedEndAt: string | null;
  precision: OpenLoopTimePrecision;
  timezone: string | null;
  followupEligibleFromAt: string;
  expiresAt: string;
  expirySource: OpenLoopExpirySource;
  status: OpenLoopStatus;
  closureEventRevisionId: string | null;
  policyVersion: string;
  generationCommandId: GenerationCommandId;
  modelRunAttemptId: ModelRunAttemptId;
  supersedesVersionId: OpenLoopVersionId | null;
  terminalEffectiveAt: string | null;
  terminalProcessedAt: string | null;
  contentExpiresAt: string | null;
  contentPurgedAt: string | null;
  createdAt: string;
}>;

export type OpenLoopRecord = Readonly<{
  openLoopId: OpenLoopId;
  userId: UserId;
  kind: OpenLoopKind;
  currentVersionId: OpenLoopVersionId;
  createdAt: string;
  deletedAt: string | null;
}>;

/** Content-free closure proposal against one pre-transaction snapshot. */
export type OpenLoopClosureProposal = Readonly<{
  targetOpenLoopId: OpenLoopId;
  proposedStatus: OpenLoopTerminalStatus;
  /** Locator of the final/corrected User Evidence asserting the terminal. */
  closureEvidenceRevisionId: string;
  closureCommittedAt: string;
  /**
   * The Evidence necessarily entails the terminal state: either an explicit
   * terminal statement or first-hand content only knowable if the terminal
   * holds. Assumptions, possibilities, futures, conditionals, silence,
   * time-arrival and Assistant/System content never entail.
   */
  entailsTerminal: boolean;
  /** Cancel additionally requires explicit cancel/withdraw/abandon language. */
  explicitCancel: boolean;
  /** Kind of the target at proposal time (pairing is rechecked in code). */
  targetKind: OpenLoopKind;
}>;

export type OpenLoopFormationRejectionCode =
  | "kind_invalid"
  | "task_like_rejected"
  | "evidence_missing"
  | "no_real_anchor"
  | "time_window_too_wide"
  | "horizon_exceeded"
  | "ambiguous_loop_identity"
  | "capacity_exceeded"
  | "stale_source"
  | "fenced";

export type OpenLoopFormationPlan =
  | Readonly<{
      action: "create_loop";
      kind: OpenLoopKind;
      expectedStartAt: string | null;
      expectedEndAt: string | null;
      precision: OpenLoopTimePrecision;
      timezone: string | null;
      followupEligibleFromAt: string;
      expiresAt: string;
      expirySource: OpenLoopExpirySource;
    }>
  | Readonly<{
      action: "reuse_loop";
      kind: OpenLoopKind;
      openLoopId: OpenLoopId;
      expectedStartAt: string | null;
      expectedEndAt: string | null;
      precision: OpenLoopTimePrecision;
      timezone: string | null;
      followupEligibleFromAt: string;
      expiresAt: string;
      expirySource: OpenLoopExpirySource;
    }>
  | Readonly<{
      action: "skip";
      kind: OpenLoopKind | null;
      reasonCode: OpenLoopFormationRejectionCode;
    }>;

export type OpenLoopClosurePlan =
  | Readonly<{
      action: "close";
      targetOpenLoopId: OpenLoopId;
      terminalStatus: OpenLoopTerminalStatus;
    }>
  | Readonly<{
      action: "ambiguous_suppress";
      targetOpenLoopIds: readonly OpenLoopId[];
      disposition: "ambiguous_closure";
    }>
  | Readonly<{
      action: "no_close";
      reasonCode:
        | "no_entailment"
        | "kind_status_mismatch"
        | "cancel_not_explicit"
        | "no_reasonable_target";
    }>;

/**
 * Role-scoped producer seam for `open_loop.extract` (issue #207 layer 2b):
 * receives the frozen typed per-Event input and returns transient proposals
 * plus closure assertions; eligibility, identity, capacity, and admission
 * stay in deterministic code. The model never persists state and never
 * closes a Loop by itself.
 */
export type OpenLoopExtractModelProvider = Readonly<{
  role: "open_loop.extract";
  extractProposals(
    request: OpenLoopExtractModelRequest,
  ): Promise<OpenLoopExtractModelOutput>;
}>;

export type OpenLoopExtractModelRequest = Readonly<{
  userId: UserId;
  eventRevisionId: string;
  locale: string;
  timeZone: string;
  /** Full user utterance; evidence spans below are the citable locators. */
  userText: string;
  evidenceCommittedAt: string;
  evidence: readonly OpenLoopExtractEvidenceInput[];
  openLoops: readonly OpenLoopExtractLoopInput[];
}>;

export type OpenLoopExtractEvidenceInput = Readonly<{
  evidenceItemId: EvidenceItemId;
  revisionId: string;
  locatorType: string;
  locatorKey: string;
  committedAt: string;
}>;

export type OpenLoopExtractLoopInput = Readonly<{
  openLoopId: OpenLoopId;
  kind: OpenLoopKind;
  localizedSummary: string | null;
  expectedStartAt: string | null;
}>;

export type OpenLoopExtractModelOutput = Readonly<{
  proposals: readonly OpenLoopProposal[];
  closures: readonly OpenLoopClosureProposal[];
}>;

/** Deterministic per-Event capacity bounds (v1). */
export const MAX_NEW_LOOPS_PER_EVENT = 4;
export const MAX_CURRENT_OPEN_LOOPS_PER_OWNER = 128;
/** Anchored expected windows wider than 31 local calendar days are rejected. */
export const MAX_ANCHORED_WINDOW_DAYS = 31;
/** No expiry may exceed 360 local calendar days from Evidence time. */
export const MAX_OPEN_HORIZON_DAYS = 360;
/** Non-current summaries keep a 30-day content grace from leaving open. */
export const OPEN_LOOP_CONTENT_GRACE_DAYS = 30;

export type OpenLoopCapacityCandidate = Readonly<{
  proposalIndex: number;
  followupEligibleFromAt: string;
  expiresAt: string;
  evidenceLocator: string;
}>;

export type { OpenLoopId, OpenLoopVersionId } from "@sayhear/domain";
