/**
 * Recent-conversation-context source contract (SPEC #292, issue #293,
 * ADR-0149).
 *
 * This module owns the application-layer DTO, the versioned selection policy
 * and the deterministic selector for the bounded cross-day source history.
 * It deliberately exposes no SQL or framework types: the PostgreSQL adapter
 * implements {@link RecentContextSourcePort} in the data package and the
 * Context Compiler consumes the selected, freeze-ready projection.
 *
 * The selector is a pure function. It never compares local `sequence`
 * numbers across Daily Sessions: ordering uses the message expression
 * instant plus the opaque revision identity, while `sequence` only breaks
 * ties inside one session whose expression instants collide.
 */

import type {
  ConversationEventRevisionId,
  DailySessionId,
  InteractionTurnId,
  UserId,
} from "@sayhear/domain";

/** Section key for the independently frozen recent-source projection. */
export const RECENT_CONTEXT_SECTION_KEY = "recent_conversation_context" as const;

/**
 * Version of the deterministic selection algorithm below. v2 adds the
 * cheapest-complete-expression per-date floor and newest-first remainder fill
 * (issue #294); v1 references are rejected rather than reinterpreted.
 */
export const RECENT_CONTEXT_SELECTION_POLICY_VERSION =
  "recent-context-selection:v2" as const;

/**
 * Version of the frozen reference wire format written by {@link encode}.
 *
 * v4 adds the content-free `readLatencyMs` measurement to the frozen
 * recent-source diagnostics (issue #295); v3 stays decodable so a Context
 * compiled by #294 still replays and still renders in the Inspector. An
 * unknown future version fails closed instead of being reinterpreted.
 */
export const RECENT_CONTEXT_REFERENCE_VERSION = 4 as const;

/** Prior decodable reference version written before #295. */
export const RECENT_CONTEXT_PREVIOUS_REFERENCE_VERSION = 3 as const;

/** Window is today plus the previous six local days; empty days are not padded. */
export const RECENT_CONTEXT_WINDOW_DAYS = 7 as const;

/**
 * Versioned initial production budgets for the recent-source path (issue
 * #294). These are additive to the existing raw-event budget and were
 * calibrated against the fixed synthetic long conversation and the
 * `EXPLAIN (ANALYZE, BUFFERS)` plan recorded in the #294 validation; they are
 * not derived from the retired research 1500 / 4000 token figures.
 */
export const RECENT_CONTEXT_DEFAULT_POLICY: RecentContextSelectionPolicy =
  Object.freeze({
    budgets: Object.freeze({
      // Read caps (SQL-level, before any body crosses the port).
      maxCandidateBytes: 262_144,
      maxCandidateRows: 400,
      // Shared selection budget for user expressions + adjacent assistants.
      maxContextTokens: 2_000,
      maxSingleEventTokens: 600,
      readTimeoutMs: 2_000,
    }),
    version: "recent-context-selection-policy:v1",
    windowDays: RECENT_CONTEXT_WINDOW_DAYS,
  });

export type RecentContextControlReason =
  | "correction_association"
  | "forget_association";

export type RecentContextOmissionReason =
  | "duplicate_revision"
  | "after_cutoff"
  | "outside_window"
  | "explicit_control"
  | "assistant_of_excluded_user"
  | "assistant_of_omitted_user"
  | "unreferenced_assistant"
  | "single_event_over_budget"
  | "context_budget_exceeded"
  | "source_read_failed"
  /** A prior local date had candidates but none fit the selection budget. */
  | "date_budget_excluded"
  /** A prior local date had more candidates than the bounded read returned. */
  | "date_read_bounded";

export type RecentContextSelectionReason =
  | "today"
  | "day_representation"
  | "budget_fill";

export type RecentContextSelectionBudgets = Readonly<{
  /** Hard upper bound on candidate rows the adapter may return. */
  maxCandidateRows: number;
  /** Hard upper bound on candidate body bytes the adapter may read. */
  maxCandidateBytes: number;
  /** Shared token budget for selected recent user + adjacent assistant text. */
  maxContextTokens: number;
  /** A single message larger than this is omitted with a recorded reason. */
  maxSingleEventTokens: number;
  /** Versioned read deadline; a timeout degrades the whole recent section. */
  readTimeoutMs: number;
}>;

export type RecentContextSelectionPolicy = Readonly<{
  version: string;
  windowDays: number;
  budgets: RecentContextSelectionBudgets;
}>;

/**
 * The frozen admitted-command cutoff. Later events (including a retried
 * compile's later committed input) must never enter the recent projection.
 * `dailySessionId` + `currentInputSequence` break same-instant ties inside the
 * admitted session; across sessions only the instant and revision identity
 * order the cut.
 */
export type RecentContextCutoff = Readonly<{
  currentInputRevisionId: ConversationEventRevisionId | null;
  currentInputSequence: number | null;
  dailySessionId: DailySessionId | null;
  expressedAt: string;
}>;

export type RecentContextSourceRequest = Readonly<{
  budgets: RecentContextSelectionBudgets;
  cutoff: RecentContextCutoff;
  currentDailySessionId: DailySessionId;
  /** Revision refs already frozen into this compile; never re-read as recent. */
  excludeRevisionIds: readonly ConversationEventRevisionId[];
  expectedDataEpoch: number;
  frozenAt: Date;
  policyVersion: string;
  selectorVersion: string;
  timezone: string;
  userId: UserId;
  windowEndLocalDate: string;
  windowStartLocalDate: string;
}>;

/**
 * One candidate row returned by the source port. `exclusion` is the explicit,
 * existing Correction / Forget association when the row must not be injected;
 * there is no semantic matching and no new Trust Action.
 */
export type RecentContextSourceItem = Readonly<{
  actor: "user" | "assistant";
  dailySessionId: DailySessionId;
  exclusion: Readonly<{
    controlId: string;
    reason: RecentContextControlReason;
  }> | null;
  /** Message expression instant (ISO-8601); never the Daily Session date. */
  expressedAt: string;
  /** IANA zone used to interpret the expression instant, when known. */
  expressionTimezone?: string | null;
  expressionTimezoneSource?: "request" | "session_start_fallback" | "unknown";
  /**
   * The Assistant event's own `generation_command_id`, when the row is an
   * Assistant. `null` is the pre-0003 legacy shape; `undefined` is used only by
   * synthetic callers that have no command identity to offer (treated as
   * legacy for the same-turn fallback). A non-null value is authoritative:
   * {@link generatingUserRevisionId} must resolve or the Assistant is omitted.
   */
  generationCommandId?: string | null;
  /**
   * The canonical generating input revision for an Assistant, resolved at the
   * source from `generation_commands.input_revision_id` (issue #294). This is
   * the only association the selector trusts for a modern Assistant: neither
   * turn adjacency nor the nearest preceding user can recover a retried,
   * delayed, concurrent or action-finalized Assistant.
   */
  generatingUserRevisionId?: ConversationEventRevisionId | null;
  /**
   * InteractionTurn the revision belongs to. Used ONLY as the legacy
   * (`generation_command_id IS NULL`) same-turn fallback; never as the modern
   * association mechanism.
   */
  interactionTurnId?: InteractionTurnId | null;
  /** Real-world event time when known; never fabricated from expression time. */
  occurredAt: string | null;
  revisionId: ConversationEventRevisionId;
  /** Session-local order only; never compared across sessions. */
  sequence: number;
  text: string;
}>;

/**
 * Closed set of content-free source failure codes (issue #294). The adapter
 * never returns SQL text, parameter values or message bodies; #295's Inspector
 * distinguishes timeout / owner / epoch / failure from this typed value.
 */
export type RecentContextSourceFailureCode =
  | "source_read_failed"
  | "source_read_timeout"
  | "source_read_threw"
  | "owner_inactive"
  | "expected_data_epoch_mismatch"
  | "source_metadata_mismatch"
  | "cutoff_unavailable";

export type RecentContextSourceFailure = Readonly<{
  code: RecentContextSourceFailureCode;
  detail: string | null;
}>;

/**
 * Per-local-date bounded-read diagnosis (issue #294). `empty` distinguishes a
 * genuinely empty date from one whose rows were dropped by the read caps
 * (`readBounded`); unpadded dates stay explicitly empty rather than fabricated.
 */
export type RecentContextPerDateCoverage = Readonly<{
  localDate: string;
  candidateRows: number;
  readBounded: boolean;
  empty: boolean;
}>;

export type RecentContextSourceSnapshot = Readonly<{
  candidateBytes: number;
  candidateRows: number;
  failure: RecentContextSourceFailure | null;
  items: readonly RecentContextSourceItem[];
  /** Optional so pre-#294 fakes stay valid; real adapters always set it. */
  perDate?: readonly RecentContextPerDateCoverage[];
  policyVersion: string;
  /**
   * Wall-clock duration of the bounded source read, measured at the adapter
   * boundary (issue #295). Content-free; `null` when a caller could not measure
   * it. Optional so pre-#295 fakes stay valid.
   */
  readLatencyMs?: number | null;
  selectorVersion: string;
  timezone: string;
  truncated: boolean;
  windowEndLocalDate: string;
  windowStartLocalDate: string;
}>;

export type RecentContextSourcePort = Readonly<{
  loadRecentContextSource(
    request: RecentContextSourceRequest,
  ): Promise<RecentContextSourceSnapshot>;
}>;

/**
 * Independent, versioned operator governance for the recent-context path
 * (issue #295). A row is content-free; it records the compiler / selector /
 * budget identities the path was enabled under. Disabling revokes the single
 * active row; re-enabling inserts a brand-new immutable version, so a revoked
 * identity can never be resurrected.
 */
export const RECENT_CONTEXT_GOVERNANCE_PREFIX =
  "recent-context-governance:" as const;

export type RecentContextGovernanceStatus =
  | "active"
  | "revoked"
  | "absent";

export type RecentContextGovernancePolicy = Readonly<{
  budgetTokens: number;
  /** The actor who enabled this version; write-once, never overwritten. */
  changedBy: string;
  compilerVersion: string;
  createdAt: string;
  maxCandidateBytes: number;
  maxCandidateRows: number;
  maxSingleEventTokens: number;
  policyVersion: string;
  readTimeoutMs: number;
  /** `null` while active; set once revoked. */
  revokedAt: string | null;
  /** The actor who revoked this version; `null` while active, write-once. */
  revokedBy: string | null;
  selectionPolicyVersion: string;
  selectorPolicyVersion: string;
  status: "active" | "revoked";
}>;

export type RecentContextGovernanceEffectiveState = Readonly<{
  active: RecentContextGovernancePolicy | null;
  enabled: boolean;
  latest: RecentContextGovernancePolicy | null;
  policyCount: number;
}>;

export type RecentContextGovernanceInput = Readonly<{
  budgetTokens: number;
  changedBy: string;
  compilerVersion: string;
  maxCandidateBytes: number;
  maxCandidateRows: number;
  maxSingleEventTokens: number;
  now: Date;
  /** Optional caller-supplied immutable version; generated when absent. */
  policyVersion?: string;
  readTimeoutMs: number;
  selectionPolicyVersion: string;
  selectorPolicyVersion: string;
}>;

export class RecentContextGovernanceConflictError extends Error {
  public constructor(
    message = "A recent-context governance policy is already active, or the requested version already exists.",
  ) {
    super(message);
    this.name = "RecentContextGovernanceConflictError";
  }
}

export type RecentContextGovernanceRepository = Readonly<{
  findActivePolicy(): Promise<RecentContextGovernancePolicy | null>;
  findEffectiveState(): Promise<RecentContextGovernanceEffectiveState>;
  findPolicyStatus(
    policyVersion: string,
  ): Promise<RecentContextGovernanceStatus>;
  insertActivePolicy(
    input: RecentContextGovernanceInput,
  ): Promise<RecentContextGovernancePolicy>;
  revokeActivePolicy(input: {
    now: Date;
    revokedBy: string;
  }): Promise<
    | Readonly<{
        outcome: "revoked";
        policy: RecentContextGovernancePolicy;
      }>
    | Readonly<{ outcome: "already_disabled" }>
  >;
}>;

export type RecentContextOmission = Readonly<{
  controlId: string | null;
  reason: RecentContextOmissionReason;
  revisionId: ConversationEventRevisionId | null;
}>;

export type RecentContextSelectedEvent = Readonly<{
  actor: "user" | "assistant";
  dailySessionId: DailySessionId;
  estimatedTokens: number;
  expressedAt: string;
  expressionTimezone?: string | null;
  expressionTimezoneSource?: "request" | "session_start_fallback" | "unknown";
  /** InteractionTurn of the source revision; see {@link RecentContextSourceItem}. */
  interactionTurnId?: InteractionTurnId | null;
  occurredAt: string | null;
  revisionId: ConversationEventRevisionId;
  selectionOrder: number;
  selectionReason: RecentContextSelectionReason;
  sequence: number;
  text: string;
}>;

export type RecentContextSelectionCounts = Readonly<{
  candidateBytes: number;
  candidateRows: number;
  selectedCount: number;
  truncated: boolean;
}>;

export type RecentContextSelection = Readonly<{
  budgetTokens: number;
  budgets: RecentContextSelectionBudgets;
  counts: RecentContextSelectionCounts;
  cutoff: RecentContextCutoff;
  excludedRevisionIds: readonly ConversationEventRevisionId[];
  failure: RecentContextSourceFailure | null;
  omitted: readonly RecentContextOmission[];
  perDate: readonly RecentContextPerDateCoverage[];
  policyVersion: string;
  /** Content-free bounded-read duration measured at the source boundary. */
  readLatencyMs: number | null;
  selected: readonly RecentContextSelectedEvent[];
  selectedTokens: number;
  selectorVersion: string;
  timezone: string;
  windowDays: number;
  windowEndLocalDate: string;
  windowStartLocalDate: string;
}>;

export type RecentContextFrozenSelectedRef = Readonly<{
  actor: "user" | "assistant";
  dailySessionId: string;
  expressedAt: string;
  occurredAt: string | null;
  revisionId: string;
  selectionOrder: number;
  selectionReason: RecentContextSelectionReason;
}>;

export type RecentContextFrozenReference = Readonly<{
  budgetTokens: number;
  budgets: RecentContextSelectionBudgets;
  counts: RecentContextSelectionCounts;
  cutoff: Readonly<{
    currentInputRevisionId: string | null;
    currentInputSequence: number | null;
    dailySessionId: string | null;
    expressedAt: string;
  }>;
  excludedRevisionIds: readonly string[];
  failure: RecentContextSourceFailure | null;
  omitted: readonly RecentContextOmission[];
  perDate: readonly RecentContextPerDateCoverage[];
  policyVersion: string;
  readLatencyMs: number | null;
  selected: readonly RecentContextFrozenSelectedRef[];
  selectedTokens: number;
  selectorVersion: string;
  timezone: string;
  version: typeof RECENT_CONTEXT_REFERENCE_VERSION;
  windowDays: number;
  windowEndLocalDate: string;
  windowStartLocalDate: string;
}>;

/**
 * #295: the decoded reference keeps `version` normalized to the current wire
 * format for existing consumers, and additionally records the actual encoded
 * `wireVersion` so the Inspector can be honest about a v3 reference rendered by
 * a v4 reader.
 */
export type RecentContextDecodedReference = RecentContextFrozenReference &
  Readonly<{ wireVersion: number }>;

export class RecentContextReferenceError extends Error {
  public constructor(detail: string) {
    super(`Recent-context frozen reference is invalid: ${detail}`);
    this.name = "RecentContextReferenceError";
  }
}

const OMISSION_REASONS: readonly RecentContextOmissionReason[] = [
  "duplicate_revision",
  "after_cutoff",
  "outside_window",
  "explicit_control",
  "assistant_of_excluded_user",
  "assistant_of_omitted_user",
  "unreferenced_assistant",
  "single_event_over_budget",
  "context_budget_exceeded",
  "source_read_failed",
  "date_budget_excluded",
  "date_read_bounded",
];

const SOURCE_FAILURE_CODES: readonly RecentContextSourceFailureCode[] = [
  "source_read_failed",
  "source_read_timeout",
  "source_read_threw",
  "owner_inactive",
  "expected_data_epoch_mismatch",
  "source_metadata_mismatch",
  "cutoff_unavailable",
];

const SELECTION_REASONS: readonly RecentContextSelectionReason[] = [
  "today",
  "day_representation",
  "budget_fill",
];

export function estimateRecentContextTokens(text: string): number {
  return Math.max(1, Math.ceil([...text].length / 4));
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Local calendar date (YYYY-MM-DD) for an instant in an IANA timezone. */
export function localDateOf(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(instant);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) {
    throw new RecentContextReferenceError("unreadable_local_date");
  }
  return `${year}-${month}-${day}`;
}

/** Shift a YYYY-MM-DD local calendar date by whole days (DST-safe). */
export function shiftLocalDate(localDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) {
    throw new RecentContextReferenceError(`invalid_local_date:${localDate}`);
  }
  const base = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  const shifted = new Date(base + days * 24 * 60 * 60 * 1_000);
  return shifted.toISOString().slice(0, 10);
}

export function resolveRecentContextWindow(input: {
  frozenAt: Date;
  timezone: string;
  windowDays: number;
}): Readonly<{ windowEndLocalDate: string; windowStartLocalDate: string }> {
  if (!Number.isInteger(input.windowDays) || input.windowDays < 1) {
    throw new RecentContextReferenceError("invalid_window_days");
  }
  const windowEndLocalDate = localDateOf(input.frozenAt, input.timezone);
  return {
    windowEndLocalDate,
    windowStartLocalDate: shiftLocalDate(
      windowEndLocalDate,
      -(input.windowDays - 1),
    ),
  };
}

type Disposition =
  | Readonly<{
      associationUserRevisionId: string | null;
      kind: "candidate";
      localDate: string;
    }>
  | Readonly<{
      controlId: string | null;
      kind: "omitted";
      reason: RecentContextOmissionReason;
    }>;

type Candidate = Readonly<{
  associationUserRevisionId: string | null;
  disposition: Extract<Disposition, { kind: "candidate" }>;
  item: RecentContextSourceItem;
}>;

function classify(input: {
  cutoff: RecentContextCutoff;
  excludeRevisionIds: ReadonlySet<string>;
  items: readonly RecentContextSourceItem[];
  seen: Set<string>;
  timezone: string;
  /** Legacy same-turn user per InteractionTurn, for rows with no command id. */
  userByTurnId: ReadonlyMap<string, string>;
  windowEndLocalDate: string;
  windowStartLocalDate: string;
}): readonly Disposition[] {
  const cutoffTime = Date.parse(input.cutoff.expressedAt);
  return input.items.map((item) => {
    if (
      input.excludeRevisionIds.has(item.revisionId) ||
      input.seen.has(item.revisionId)
    ) {
      input.seen.add(item.revisionId);
      return { controlId: null, kind: "omitted", reason: "duplicate_revision" };
    }
    input.seen.add(item.revisionId);
    const itemTime = Date.parse(item.expressedAt);
    if (Number.isNaN(itemTime)) {
      return {
        controlId: null,
        kind: "omitted",
        reason: "duplicate_revision",
      };
    }
    if (itemTime > cutoffTime) {
      return { controlId: null, kind: "omitted", reason: "after_cutoff" };
    }
    if (
      itemTime === cutoffTime &&
      input.cutoff.dailySessionId !== null &&
      input.cutoff.currentInputSequence !== null &&
      item.dailySessionId === input.cutoff.dailySessionId &&
      item.sequence > input.cutoff.currentInputSequence
    ) {
      return { controlId: null, kind: "omitted", reason: "after_cutoff" };
    }
    const localDate = localDateOf(new Date(itemTime), input.timezone);
    if (
      localDate < input.windowStartLocalDate ||
      localDate > input.windowEndLocalDate
    ) {
      return { controlId: null, kind: "omitted", reason: "outside_window" };
    }
    if (item.exclusion !== null) {
      return {
        controlId: item.exclusion.controlId,
        kind: "omitted",
        reason: "explicit_control",
      };
    }
    return {
      associationUserRevisionId:
        item.actor === "assistant"
          ? associatedUserRevisionId(input, item)
          : null,
      kind: "candidate",
      localDate,
    };
  });
}

/**
 * Associate an Assistant row with the User expression that actually generated
 * it (issue #294). For a modern Assistant the event's
 * `generation_command_id` is authoritative: the canonical
 * `generation_commands.input_revision_id` must resolve to a fetched revision or
 * the Assistant is omitted fail-closed. That binding survives retries (the new
 * turn has no user revision), delayed/concurrent commits and action
 * finalization (the generated input is reused, not re-derived from adjacency),
 * and an excluded or omitted generating user can never be swapped for a
 * different eligible neighbor. Only a legacy row with
 * `generation_command_id IS NULL` may fall back to the same InteractionTurn's
 * user revision; with no such identity it is omitted.
 */
function associatedUserRevisionId(
  input: Readonly<{ userByTurnId: ReadonlyMap<string, string> }>,
  assistant: RecentContextSourceItem,
): string | null {
  if (
    assistant.generationCommandId !== undefined &&
    assistant.generationCommandId !== null
  ) {
    const generatingRevisionId = assistant.generatingUserRevisionId;
    return generatingRevisionId === undefined || generatingRevisionId === null
      ? null
      : String(generatingRevisionId);
  }
  const turnId = assistant.interactionTurnId;
  if (turnId === undefined || turnId === null) return null;
  return input.userByTurnId.get(String(turnId)) ?? null;
}

export function selectRecentContext(input: {
  candidateBytes?: number;
  candidateRows?: number;
  cutoff?: RecentContextCutoff;
  excludeRevisionIds?: readonly ConversationEventRevisionId[];
  failure?: RecentContextSourceFailure | null;
  frozenAt: Date;
  items: readonly RecentContextSourceItem[];
  perDate?: readonly RecentContextPerDateCoverage[];
  policy: RecentContextSelectionPolicy;
  /** Content-free read duration from the source snapshot (issue #295). */
  readLatencyMs?: number | null;
  timezone: string;
  truncated?: boolean;
  windowEndLocalDate: string;
  windowStartLocalDate: string;
}): RecentContextSelection {
  const budgets = input.policy.budgets;
  const cutoff: RecentContextCutoff = input.cutoff ?? {
    currentInputRevisionId: null,
    currentInputSequence: null,
    dailySessionId: null,
    expressedAt: input.frozenAt.toISOString(),
  };
  const excludeRevisionIds = new Set<string>(
    (input.excludeRevisionIds ?? []).map((revisionId) => String(revisionId)),
  );

  // Legacy-only view: the same-turn user revision per InteractionTurn. Modern
  // Assistants ignore this and use their canonical generating command input.
  const userByTurnId = new Map<string, string>();
  for (const item of input.items) {
    if (item.actor !== "user") continue;
    const turnId = item.interactionTurnId;
    if (turnId !== undefined && turnId !== null) {
      const key = String(turnId);
      if (!userByTurnId.has(key)) {
        userByTurnId.set(key, item.revisionId);
      }
    }
  }
  const excludedUserRevisionIds = new Set<string>();
  for (const item of input.items) {
    if (item.actor === "user" && item.exclusion !== null) {
      excludedUserRevisionIds.add(item.revisionId);
    }
  }

  const dispositions = classify({
    cutoff,
    excludeRevisionIds,
    items: input.items,
    seen: new Set<string>(),
    timezone: input.timezone,
    userByTurnId,
    windowEndLocalDate: input.windowEndLocalDate,
    windowStartLocalDate: input.windowStartLocalDate,
  });

  const candidates: Candidate[] = [];
  for (const [index, disposition] of dispositions.entries()) {
    if (disposition.kind === "candidate") {
      candidates.push({
        associationUserRevisionId: disposition.associationUserRevisionId,
        disposition,
        item: input.items[index]!,
      });
    }
  }

  const newestFirst = [...candidates].toSorted((left, right) =>
    compareByTimeThenSessionOrder(left.item, right.item, "descending"),
  );
  const chronological = [...candidates].toSorted((left, right) =>
    compareByTimeThenSessionOrder(left.item, right.item, "ascending"),
  );

  const selected: RecentContextSelectedEvent[] = [];
  const selectedIds = new Set<string>();
  const selectedReason = new Map<string, RecentContextSelectionReason>();
  let remaining = budgets.maxContextTokens;

  const assistantAllowed = (item: RecentContextSourceItem): boolean => {
    if (item.actor !== "assistant") return true;
    const association =
      candidates.find((candidate) => candidate.item === item)
        ?.associationUserRevisionId ?? null;
    return association !== null && selectedIds.has(association);
  };

  const tryAdd = (
    candidate: Candidate,
    selectionReason: RecentContextSelectionReason,
  ): boolean => {
    const { item } = candidate;
    if (selectedIds.has(item.revisionId)) return true;
    if (!assistantAllowed(item)) return false;
    const estimatedTokens = estimateRecentContextTokens(item.text);
    if (estimatedTokens > budgets.maxSingleEventTokens) return false;
    if (estimatedTokens > remaining) return false;
    selectedIds.add(item.revisionId);
    selectedReason.set(item.revisionId, selectionReason);
    remaining -= estimatedTokens;
    selected.push({
      actor: item.actor,
      dailySessionId: item.dailySessionId,
      estimatedTokens,
      expressedAt: item.expressedAt,
      ...(item.expressionTimezone === undefined
        ? {}
        : { expressionTimezone: item.expressionTimezone }),
      ...(item.expressionTimezoneSource === undefined
        ? {}
        : { expressionTimezoneSource: item.expressionTimezoneSource }),
      ...(item.interactionTurnId === undefined ||
      item.interactionTurnId === null
        ? {}
        : { interactionTurnId: item.interactionTurnId }),
      occurredAt: item.occurredAt,
      revisionId: item.revisionId,
      selectionOrder: 0,
      selectionReason,
      sequence: item.sequence,
      text: item.text,
    });
    return true;
  };

  const tokensOf = (candidate: Candidate): number =>
    estimateRecentContextTokens(candidate.item.text);
  const isPriorDate = (candidate: Candidate): boolean =>
    candidate.disposition.localDate < input.windowEndLocalDate;

  // Priority 1: today's conversation, oldest first so a user is always
  // considered before its adjacent assistant.
  for (const candidate of chronological) {
    if (candidate.disposition.localDate === input.windowEndLocalDate) {
      tryAdd(candidate, "today");
    }
  }

  // Priority 2 (floor): reserve the *cheapest* complete user expression per
  // eligible earlier local date, globally cheapest first, so a tight budget
  // covers as many distinct dates as mathematically possible instead of
  // letting the nearest date starve the rest. No summary/model/semantic
  // matching: only the deterministic token estimate and recency order.
  // Impossible cases are left honest rather than fabricated: a date whose
  // every expression exceeds `maxSingleEventTokens`, or a remaining budget
  // smaller than the cheapest expression, is recorded as an omission
  // (`single_event_over_budget` / `date_budget_excluded`) with no summary row.
  const cheapestByDate = new Map<string, Candidate>();
  for (const candidate of chronological) {
    if (candidate.item.actor !== "user" || !isPriorDate(candidate)) continue;
    if (selectedIds.has(candidate.item.revisionId)) continue;
    if (tokensOf(candidate) > budgets.maxSingleEventTokens) continue;
    const localDate = candidate.disposition.localDate;
    const existing = cheapestByDate.get(localDate);
    if (existing === undefined) {
      cheapestByDate.set(localDate, candidate);
      continue;
    }
    const delta = tokensOf(candidate) - tokensOf(existing);
    if (
      delta < 0 ||
      (delta === 0 &&
        compareByTimeThenSessionOrder(
          candidate.item,
          existing.item,
          "descending",
        ) < 0)
    ) {
      cheapestByDate.set(localDate, candidate);
    }
  }
  const floor = [...cheapestByDate.values()].toSorted(
    (left, right) =>
      tokensOf(left) - tokensOf(right) ||
      compareByTimeThenSessionOrder(left.item, right.item, "descending"),
  );
  for (const candidate of floor) {
    tryAdd(candidate, "day_representation");
  }
  // Adjacent assistants of whatever floor representative was actually added.
  for (const candidate of chronological) {
    if (
      candidate.item.actor === "assistant" &&
      isPriorDate(candidate) &&
      candidate.associationUserRevisionId !== null &&
      selectedIds.has(candidate.associationUserRevisionId)
    ) {
      tryAdd(candidate, "day_representation");
    }
  }

  // Priority 3: remaining budget goes to the nearest/newest remaining
  // content, newest first.
  for (const candidate of newestFirst) {
    tryAdd(candidate, "budget_fill");
  }

  // Final omission decisions based on what was actually selected, so a
  // failed probe attempt never leaves a stale reason in the frozen manifest.
  const omitted: RecentContextOmission[] = [];
  const omittedKeys = new Set<string>();
  // Local dates with at least one candidate genuinely dropped by the selection
  // budget. A date-level `date_budget_excluded` is only honest when backed by a
  // concrete item-level `context_budget_excluded` / `single_event_over_budget`.
  const budgetStarvedDates = new Set<string>();
  const record = (omission: RecentContextOmission): void => {
    const key = `${omission.reason}:${omission.revisionId ?? ""}:${omission.controlId ?? ""}`;
    if (omittedKeys.has(key)) return;
    omittedKeys.add(key);
    omitted.push(omission);
  };
  for (const [index, item] of input.items.entries()) {
    if (selectedIds.has(item.revisionId)) continue;
    const disposition = dispositions[index]!;
    if (disposition.kind === "omitted") {
      record({
        controlId: disposition.controlId,
        reason: disposition.reason,
        revisionId: item.revisionId,
      });
      continue;
    }
    if (item.actor === "assistant") {
      const association = disposition.associationUserRevisionId;
      if (association === null) {
        record({
          controlId: null,
          reason: "unreferenced_assistant",
          revisionId: item.revisionId,
        });
        continue;
      }
      if (excludedUserRevisionIds.has(association)) {
        record({
          controlId: null,
          reason: "assistant_of_excluded_user",
          revisionId: item.revisionId,
        });
        continue;
      }
      if (!selectedIds.has(association)) {
        record({
          controlId: null,
          reason: "assistant_of_omitted_user",
          revisionId: item.revisionId,
        });
        continue;
      }
    }
    const budgetReason =
      estimateRecentContextTokens(item.text) > budgets.maxSingleEventTokens
        ? "single_event_over_budget"
        : "context_budget_exceeded";
    budgetStarvedDates.add(disposition.localDate);
    record({
      controlId: null,
      reason: budgetReason,
      revisionId: item.revisionId,
    });
  }

  // Honest per-date coverage for the frozen diagnostics: distinguish a truly
  // empty date (no candidate existed) from one whose rows were dropped by the
  // bounded read (`date_read_bounded`) or by the selection budget
  // (`date_budget_excluded`). Dates are never padded.
  const selectedDates = new Set(
    selected.map((event) =>
      localDateOf(new Date(event.expressedAt), input.timezone),
    ),
  );
  const perDate = input.perDate ?? [];
  for (const coverage of perDate) {
    if (coverage.localDate >= input.windowEndLocalDate) continue;
    const covered = selectedDates.has(coverage.localDate);
    // A bounded read already explains the gap; do not double-report it as a
    // budget exclusion.
    if (coverage.readBounded) {
      record({
        controlId: null,
        reason: "date_read_bounded",
        revisionId: null,
      });
    }
    // Only report a date-level budget exclusion when a candidate on that date
    // was actually dropped for `context_budget_excluded` /
    // `single_event_over_budget`. A date whose candidates were all dropped for
    // control, duplicate or assistant-association reasons already has an
    // item-level reason and must not be misattributed to the budget.
    if (
      !covered &&
      coverage.readBounded === false &&
      budgetStarvedDates.has(coverage.localDate)
    ) {
      record({
        controlId: null,
        reason: "date_budget_excluded",
        revisionId: null,
      });
    }
  }

  const orderedSelected = [...selected]
    .toSorted((left, right) =>
      compareSelectedChronologically(left, right),
    )
    .map((event, index) => ({ ...event, selectionOrder: index }));
  const selectedTokens = orderedSelected.reduce(
    (total, event) => total + event.estimatedTokens,
    0,
  );
  const candidateRows = input.candidateRows ?? input.items.length;
  const candidateBytes =
    input.candidateBytes ??
    input.items.reduce((total, item) => total + utf8ByteLength(item.text), 0);
  return {
    budgetTokens: budgets.maxContextTokens,
    budgets,
    counts: {
      candidateBytes,
      candidateRows,
      selectedCount: orderedSelected.length,
      // Exact-cap is not truncation: only strictly exceeding a cap drops rows.
      truncated:
        input.truncated ??
        (candidateRows > budgets.maxCandidateRows ||
          candidateBytes > budgets.maxCandidateBytes),
    },
    cutoff,
    excludedRevisionIds: input.excludeRevisionIds ?? [],
    failure: input.failure ?? null,
    omitted,
    perDate,
    policyVersion: input.policy.version,
    readLatencyMs: normalizeReadLatencyMs(input.readLatencyMs),
    selected: orderedSelected,
    selectedTokens,
    selectorVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
    timezone: input.timezone,
    windowDays: input.policy.windowDays,
    windowEndLocalDate: input.windowEndLocalDate,
    windowStartLocalDate: input.windowStartLocalDate,
  };
}

/**
 * Within one session, identical expression instants fall back to session-local
 * sequence. Across sessions, identical instants fall back to the stable
 * opaque revision identity only.
 */
function compareByTimeThenSessionOrder(
  left: RecentContextSourceItem,
  right: RecentContextSourceItem,
  direction: "ascending" | "descending",
): number {
  const factor = direction === "ascending" ? 1 : -1;
  const leftTime = Date.parse(left.expressedAt);
  const rightTime = Date.parse(right.expressedAt);
  if (leftTime !== rightTime) return (leftTime - rightTime) * factor;
  if (left.dailySessionId === right.dailySessionId) {
    return (left.sequence - right.sequence) * factor;
  }
  return left.revisionId.localeCompare(right.revisionId) * factor;
}

function compareSelectedChronologically(
  left: RecentContextSelectedEvent,
  right: RecentContextSelectedEvent,
): number {
  const leftTime = Date.parse(left.expressedAt);
  const rightTime = Date.parse(right.expressedAt);
  if (leftTime !== rightTime) return leftTime - rightTime;
  if (left.dailySessionId === right.dailySessionId) {
    return left.sequence - right.sequence;
  }
  return left.revisionId.localeCompare(right.revisionId);
}

export function encodeRecentContextReference(
  selection: RecentContextSelection,
): string {
  const reference: RecentContextFrozenReference = {
    budgetTokens: selection.budgetTokens,
    budgets: selection.budgets,
    counts: selection.counts,
    cutoff: {
      currentInputRevisionId:
        selection.cutoff.currentInputRevisionId === null
          ? null
          : String(selection.cutoff.currentInputRevisionId),
      currentInputSequence: selection.cutoff.currentInputSequence,
      dailySessionId:
        selection.cutoff.dailySessionId === null
          ? null
          : String(selection.cutoff.dailySessionId),
      expressedAt: selection.cutoff.expressedAt,
    },
    excludedRevisionIds: selection.excludedRevisionIds.map((revisionId) =>
      String(revisionId),
    ),
    failure: selection.failure,
    omitted: selection.omitted,
    perDate: selection.perDate,
    policyVersion: selection.policyVersion,
    readLatencyMs: selection.readLatencyMs,
    selected: selection.selected.map((event) => ({
      actor: event.actor,
      dailySessionId: event.dailySessionId,
      expressedAt: event.expressedAt,
      occurredAt: event.occurredAt,
      revisionId: event.revisionId,
      selectionOrder: event.selectionOrder,
      selectionReason: event.selectionReason,
    })),
    selectedTokens: selection.selectedTokens,
    selectorVersion: selection.selectorVersion,
    timezone: selection.timezone,
    version: RECENT_CONTEXT_REFERENCE_VERSION,
    windowDays: selection.windowDays,
    windowEndLocalDate: selection.windowEndLocalDate,
    windowStartLocalDate: selection.windowStartLocalDate,
  };
  return `recent-context:${JSON.stringify(reference)}`;
}

export function decodeRecentContextReference(
  reference: string,
): RecentContextDecodedReference {
  const prefix = "recent-context:";
  if (!reference.startsWith(prefix)) {
    throw new RecentContextReferenceError("unknown_reference_prefix");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(reference.slice(prefix.length));
  } catch {
    throw new RecentContextReferenceError("unparseable_reference");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RecentContextReferenceError("reference_not_an_object");
  }
  const record = parsed as Record<string, unknown>;
  const version = record["version"];
  if (
    version !== RECENT_CONTEXT_REFERENCE_VERSION &&
    version !== RECENT_CONTEXT_PREVIOUS_REFERENCE_VERSION
  ) {
    throw new RecentContextReferenceError("unknown_reference_version");
  }
  // v3 predates the read-latency measurement: it decodes as `null` rather than
  // being reinterpreted or invented.
  const readLatencyMs =
    version === RECENT_CONTEXT_PREVIOUS_REFERENCE_VERSION
      ? null
      : normalizeReadLatencyMs(record["readLatencyMs"]);
  if (record["selectorVersion"] !== RECENT_CONTEXT_SELECTION_POLICY_VERSION) {
    throw new RecentContextReferenceError("unknown_selector_version");
  }
  const policyVersion = requireNonEmptyString(
    record["policyVersion"],
    "policyVersion",
  );
  const budgets = decodeBudgets(record["budgets"]);
  const windowDays = requirePositiveInteger(record["windowDays"], "windowDays");
  const windowStartLocalDate = requireLocalDate(
    record["windowStartLocalDate"],
    "windowStartLocalDate",
  );
  const windowEndLocalDate = requireLocalDate(
    record["windowEndLocalDate"],
    "windowEndLocalDate",
  );
  if (
    shiftLocalDate(windowStartLocalDate, windowDays - 1) !== windowEndLocalDate
  ) {
    throw new RecentContextReferenceError("window_span_mismatch");
  }
  const timezone = requireNonEmptyString(record["timezone"], "timezone");
  const budgetTokens = requireNonNegativeInteger(
    record["budgetTokens"],
    "budgetTokens",
  );
  if (budgetTokens !== budgets.maxContextTokens) {
    throw new RecentContextReferenceError("budget_tokens_mismatch");
  }
  const selectedTokens = requireNonNegativeInteger(
    record["selectedTokens"],
    "selectedTokens",
  );
  if (selectedTokens > budgetTokens) {
    throw new RecentContextReferenceError("selected_tokens_over_budget");
  }
  const cutoff = decodeCutoff(record["cutoff"]);
  const counts = decodeCounts(record["counts"]);
  const failure = decodeSourceFailure(record["failure"]);
  const perDate = decodePerDate(
    record["perDate"],
    windowStartLocalDate,
    windowEndLocalDate,
  );
  const selectedRaw = record["selected"];
  if (!Array.isArray(selectedRaw)) {
    throw new RecentContextReferenceError("selected_not_an_array");
  }
  const selected = selectedRaw.map((entry, index) =>
    decodeSelectedRef(entry, index),
  );
  const selectedIds = new Set<string>();
  for (const [index, entry] of selected.entries()) {
    if (entry.selectionOrder !== index) {
      throw new RecentContextReferenceError("selection_order_not_contiguous");
    }
    if (selectedIds.has(entry.revisionId)) {
      throw new RecentContextReferenceError("duplicate_selected_revision");
    }
    selectedIds.add(entry.revisionId);
    const localDate = localDateOf(new Date(entry.expressedAt), timezone);
    if (
      localDate < windowStartLocalDate ||
      localDate > windowEndLocalDate
    ) {
      throw new RecentContextReferenceError("selected_outside_window");
    }
    if (Date.parse(entry.expressedAt) > Date.parse(cutoff.expressedAt)) {
      throw new RecentContextReferenceError("selected_after_cutoff");
    }
  }
  if (counts.selectedCount !== selected.length) {
    throw new RecentContextReferenceError("selected_count_mismatch");
  }
  if (failure !== null && selected.length > 0) {
    throw new RecentContextReferenceError("failure_with_selected");
  }
  const excludedRevisionIds = record["excludedRevisionIds"];
  if (!Array.isArray(excludedRevisionIds)) {
    throw new RecentContextReferenceError("excluded_revision_ids_not_an_array");
  }
  const parsedExcludedIds = excludedRevisionIds.map((entry, index) =>
    requireNonEmptyString(entry, `excludedRevisionIds[${index}]`),
  );
  if (parsedExcludedIds.some((revisionId) => selectedIds.has(revisionId))) {
    throw new RecentContextReferenceError("excluded_also_selected");
  }
  const omittedRaw = record["omitted"];
  if (!Array.isArray(omittedRaw)) {
    throw new RecentContextReferenceError("omitted_not_an_array");
  }
  const omitted = omittedRaw.map((entry, index) =>
    decodeOmission(entry, index),
  );
  for (const omission of omitted) {
    if (omission.revisionId !== null && selectedIds.has(omission.revisionId)) {
      throw new RecentContextReferenceError("omitted_also_selected");
    }
  }
  return {
    budgetTokens,
    budgets,
    counts,
    cutoff,
    excludedRevisionIds: parsedExcludedIds,
    failure,
    omitted,
    perDate,
    policyVersion,
    readLatencyMs,
    selected,
    selectedTokens,
    selectorVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
    timezone,
    version: RECENT_CONTEXT_REFERENCE_VERSION,
    windowDays,
    windowEndLocalDate,
    windowStartLocalDate,
    wireVersion: version,
  };
}

function decodeBudgets(value: unknown): RecentContextSelectionBudgets {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecentContextReferenceError("budgets_not_an_object");
  }
  const record = value as Record<string, unknown>;
  const budgets: RecentContextSelectionBudgets = {
    maxCandidateBytes: requirePositiveInteger(
      record["maxCandidateBytes"],
      "maxCandidateBytes",
    ),
    maxCandidateRows: requirePositiveInteger(
      record["maxCandidateRows"],
      "maxCandidateRows",
    ),
    maxContextTokens: requirePositiveInteger(
      record["maxContextTokens"],
      "maxContextTokens",
    ),
    maxSingleEventTokens: requirePositiveInteger(
      record["maxSingleEventTokens"],
      "maxSingleEventTokens",
    ),
    readTimeoutMs: requirePositiveInteger(
      record["readTimeoutMs"],
      "readTimeoutMs",
    ),
  };
  if (budgets.maxSingleEventTokens > budgets.maxContextTokens) {
    throw new RecentContextReferenceError("single_event_budget_over_context");
  }
  return budgets;
}

function decodeCounts(value: unknown): RecentContextSelectionCounts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecentContextReferenceError("counts_not_an_object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["truncated"] !== "boolean") {
    throw new RecentContextReferenceError("counts_bad_truncated");
  }
  return {
    candidateBytes: requireNonNegativeInteger(
      record["candidateBytes"],
      "candidateBytes",
    ),
    candidateRows: requireNonNegativeInteger(
      record["candidateRows"],
      "candidateRows",
    ),
    selectedCount: requireNonNegativeInteger(
      record["selectedCount"],
      "selectedCount",
    ),
    truncated: record["truncated"],
  };
}

function decodeCutoff(value: unknown): RecentContextFrozenReference["cutoff"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecentContextReferenceError("cutoff_not_an_object");
  }
  const record = value as Record<string, unknown>;
  const currentInputRevisionId = record["currentInputRevisionId"];
  const currentInputSequence = record["currentInputSequence"];
  const dailySessionId = record["dailySessionId"];
  if (
    currentInputRevisionId !== null &&
    typeof currentInputRevisionId !== "string"
  ) {
    throw new RecentContextReferenceError("cutoff_bad_revision_id");
  }
  if (dailySessionId !== null && typeof dailySessionId !== "string") {
    throw new RecentContextReferenceError("cutoff_bad_session_id");
  }
  if (
    currentInputSequence !== null &&
    (typeof currentInputSequence !== "number" ||
      !Number.isInteger(currentInputSequence) ||
      currentInputSequence < 0)
  ) {
    throw new RecentContextReferenceError("cutoff_bad_sequence");
  }
  return {
    currentInputRevisionId,
    currentInputSequence,
    dailySessionId,
    expressedAt: requireInstant(record["expressedAt"], "cutoff.expressedAt"),
  };
}

type DecodedSelectedRef = RecentContextFrozenSelectedRef;

function decodeSelectedRef(value: unknown, index: number): DecodedSelectedRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecentContextReferenceError(`selected[${index}]_not_an_object`);
  }
  const record = value as Record<string, unknown>;
  const actor = record["actor"];
  if (actor !== "user" && actor !== "assistant") {
    throw new RecentContextReferenceError(`selected[${index}]_bad_actor`);
  }
  const selectionReason = record["selectionReason"];
  if (
    typeof selectionReason !== "string" ||
    !SELECTION_REASONS.includes(selectionReason as RecentContextSelectionReason)
  ) {
    throw new RecentContextReferenceError(`selected[${index}]_bad_selection_reason`);
  }
  const occurredAt = record["occurredAt"];
  if (occurredAt !== null && typeof occurredAt !== "string") {
    throw new RecentContextReferenceError(`selected[${index}]_bad_occurred_at`);
  }
  return {
    actor,
    dailySessionId: requireNonEmptyString(
      record["dailySessionId"],
      `selected[${index}].dailySessionId`,
    ),
    expressedAt: requireInstant(
      record["expressedAt"],
      `selected[${index}].expressedAt`,
    ),
    occurredAt:
      occurredAt === null
        ? null
        : requireInstant(occurredAt, `selected[${index}].occurredAt`),
    revisionId: requireNonEmptyString(
      record["revisionId"],
      `selected[${index}].revisionId`,
    ),
    selectionOrder: requireNonNegativeInteger(
      record["selectionOrder"],
      `selected[${index}].selectionOrder`,
    ),
    selectionReason: selectionReason as RecentContextSelectionReason,
  };
}

function decodeSourceFailure(
  value: unknown,
): RecentContextSourceFailure | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RecentContextReferenceError("failure_not_an_object");
  }
  const record = value as Record<string, unknown>;
  const code = record["code"];
  if (
    typeof code !== "string" ||
    !SOURCE_FAILURE_CODES.includes(code as RecentContextSourceFailureCode)
  ) {
    throw new RecentContextReferenceError("failure_bad_code");
  }
  const detail = record["detail"];
  if (detail !== null && typeof detail !== "string") {
    throw new RecentContextReferenceError("failure_bad_detail");
  }
  return { code: code as RecentContextSourceFailureCode, detail };
}

function decodePerDate(
  value: unknown,
  windowStartLocalDate: string,
  windowEndLocalDate: string,
): readonly RecentContextPerDateCoverage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new RecentContextReferenceError("per_date_not_an_array");
  }
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new RecentContextReferenceError(`per_date[${index}]_not_an_object`);
    }
    const record = entry as Record<string, unknown>;
    const localDate = requireLocalDate(
      record["localDate"],
      `per_date[${index}].localDate`,
    );
    if (localDate < windowStartLocalDate || localDate > windowEndLocalDate) {
      throw new RecentContextReferenceError(`per_date[${index}]_outside_window`);
    }
    const readBounded = record["readBounded"];
    const empty = record["empty"];
    if (typeof readBounded !== "boolean" || typeof empty !== "boolean") {
      throw new RecentContextReferenceError(`per_date[${index}]_bad_flags`);
    }
    return {
      candidateRows: requireNonNegativeInteger(
        record["candidateRows"],
        `per_date[${index}].candidateRows`,
      ),
      empty,
      localDate,
      readBounded,
    };
  });
}

function decodeOmission(value: unknown, index: number): RecentContextOmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecentContextReferenceError(`omitted[${index}]_not_an_object`);
  }
  const record = value as Record<string, unknown>;
  const reason = record["reason"];
  if (
    typeof reason !== "string" ||
    !OMISSION_REASONS.includes(reason as RecentContextOmissionReason)
  ) {
    throw new RecentContextReferenceError(`omitted[${index}]_bad_reason`);
  }
  const revisionId = record["revisionId"];
  const controlId = record["controlId"];
  if (revisionId !== null && typeof revisionId !== "string") {
    throw new RecentContextReferenceError(`omitted[${index}]_bad_revision_id`);
  }
  if (controlId !== null && typeof controlId !== "string") {
    throw new RecentContextReferenceError(`omitted[${index}]_bad_control_id`);
  }
  if (
    reason === "explicit_control" &&
    (typeof controlId !== "string" || controlId.length === 0)
  ) {
    throw new RecentContextReferenceError(
      `omitted[${index}]_explicit_control_without_control_id`,
    );
  }
  return {
    controlId: controlId as string | null,
    reason: reason as RecentContextOmissionReason,
    revisionId: revisionId as ConversationEventRevisionId | null,
  };
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RecentContextReferenceError(`bad_${field}`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RecentContextReferenceError(`bad_${field}`);
  }
  return value;
}

function normalizeReadLatencyMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RecentContextReferenceError("bad_read_latency_ms");
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new RecentContextReferenceError(`bad_${field}`);
  }
  return value;
}

function requireLocalDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RecentContextReferenceError(`bad_${field}`);
  }
  return value;
}

function requireInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new RecentContextReferenceError(`bad_${field}`);
  }
  return value;
}
