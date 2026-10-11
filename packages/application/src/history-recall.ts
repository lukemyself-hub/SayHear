/**
 * Controlled read-only history review (issue #314, ADR-0093/0094 amendment,
 * ADR-0151).
 *
 * The Decision stage may PROPOSE one read-only history query. The proposal
 * only describes intent: a range of local calendar dates, the time basis
 * (when the person wrote the messages) and the source scope (conversation
 * text). Everything that matters for safety is deterministic code in this
 * module and its ports: date and timezone resolution, the bounded read,
 * owner / epoch / revision / Correction / Forget qualification, budgets,
 * coverage accounting and the frozen result that the History Answer
 * GenerationCommand is compiled from. The model never supplies SQL, an owner,
 * an object permission, a cursor or a second query.
 */

import type {
  ConversationEventRevisionId,
  DailySessionId,
  GenerationCommandId,
  InteractionTurnId,
  ModelRunAttemptId,
  UserId,
} from "@sayhear/domain";

import type { ConversationFunctionDefinition } from "./conversation-action-catalog";
import {
  estimateRecentContextTokens,
  localDateOf,
  shiftLocalDate,
} from "./recent-context";

export const HISTORY_RECALL_POLICY_VERSION = "history-recall:v2";
export const HISTORY_REVIEW_FUNCTION_NAME = "review_conversation_history";
export const HISTORY_RECALL_RESULT_VERSION = 1;

/** Versioned, deterministic budgets of one history review. */
export type HistoryRecallPolicy = Readonly<{
  /** Maximum inclusive number of local dates one review may span. */
  maxDateSpanDays: number;
  /** A gap longer than this between two messages starts a new time block. */
  blockGapMinutes: number;
  /** Days after an experienced date in which it may still have been retold. */
  experiencedLookaheadDays: number;
  /** A range up to this many dates is itemized date by date. */
  itemizedDateLimit: number;
  /** Maximum tokens of original text injected into the answer stage. */
  maxContextTokens: number;
  /** Rows the bounded source read may enumerate across all pages. */
  maxSourceRows: number;
  maxPages: number;
  pageSize: number;
  maxSingleEventTokens: number;
  readTimeoutMs: number;
  version: string;
}>;

export const HISTORY_RECALL_DEFAULT_POLICY: HistoryRecallPolicy = Object.freeze({
  blockGapMinutes: 30,
  experiencedLookaheadDays: 14,
  itemizedDateLimit: 14,
  maxContextTokens: 3_000,
  maxDateSpanDays: 92,
  maxPages: 8,
  maxSingleEventTokens: 600,
  maxSourceRows: 400,
  pageSize: 50,
  readTimeoutMs: 2_000,
  version: HISTORY_RECALL_POLICY_VERSION,
});

/**
 * `expressed_date`: when the person said it. `experienced_date`: when the thing
 * they describe happened. Only the first is recorded as a fact.
 */
export type HistoryTimeBasis = "expressed_date" | "experienced_date";

/** The model's proposal: intent, time basis and source scope only. */
export type HistoryQueryProposal = Readonly<{
  endDate: string;
  kind: "review_dates";
  sourceScope: "conversation_text";
  startDate: string;
  timeBasis: HistoryTimeBasis;
}>;

export const HISTORY_REVIEW_FUNCTION: ConversationFunctionDefinition =
  Object.freeze({
    description:
      "Look back at the original messages the user wrote on a past calendar date or run of dates (up to about three months) when they name or point to that period and ask what they said or talked about, for example 'what did I tell you on August 20', 'what did we talk about yesterday', 'go over last week', or 'when did I first mention painting' (use a wide range from the far past). Also use it, with time_basis experienced_date, when they ask what HAPPENED or what they DID on a past day ('what did I do yesterday'). Resolve dates yourself from the time context into YYYY-MM-DD in the user's timezone; yesterday and earlier days count, today's ongoing conversation does not need it. A follow-up asking for a detail of a period you already recapped should call it again for that period so the answer comes from the original words, not from your earlier summary. This is a read-only lookup: it changes nothing and is NOT for correcting, forgetting or changing remembered information (those are separate actions), and it is not needed for today's conversation or for questions that do not name a date. When you call it, call it alone, without any reply text; the answer is written after the lookup finishes.",
    name: HISTORY_REVIEW_FUNCTION_NAME,
    parameters: Object.freeze({
      additionalProperties: false,
      properties: Object.freeze({
        end_date: Object.freeze({
          description:
            "Last local date to review, YYYY-MM-DD. Omit for a single date.",
          type: "string",
        }),
        source_scope: Object.freeze({
          description: "Only conversation text can be reviewed.",
          enum: Object.freeze(["conversation_text"]),
          type: "string",
        }),
        start_date: Object.freeze({
          description: "First local date to review, YYYY-MM-DD.",
          type: "string",
        }),
        time_basis: Object.freeze({
          description:
            "expressed_date (default): the dates are when the user wrote or said things, for 'what did we talk about yesterday'. experienced_date: the dates are when the described events happened, for 'what happened yesterday' or 'what did I do last Sunday'; the event date is not recorded, so this only returns the messages from around then and later that may mention it.",
          enum: Object.freeze(["expressed_date", "experienced_date"]),
          type: "string",
        }),
      }),
      required: Object.freeze(["start_date"]),
      type: "object",
    }),
    strict: true,
  });

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isRealLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return date.toISOString().slice(0, 10) === value;
}

/**
 * Normalize the provider-native call into a proposal. Any unknown key (an
 * owner, an SQL fragment, a cursor, ...) or malformed value is an invalid
 * response, never a best-effort read.
 */
export function normalizeHistoryReviewCall(input: {
  rawArguments: string;
}): { proposal: HistoryQueryProposal } | { invalid: true } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawArguments);
  } catch {
    return { invalid: true };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { invalid: true };
  }
  const record = parsed as Record<string, unknown>;
  const allowed = new Set([
    "end_date",
    "source_scope",
    "start_date",
    "time_basis",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return { invalid: true };
  }
  const startDate = record["start_date"];
  const endDate = record["end_date"] ?? startDate;
  if (!isRealLocalDate(startDate) || !isRealLocalDate(endDate)) {
    return { invalid: true };
  }
  if (
    (record["time_basis"] !== undefined &&
      record["time_basis"] !== "expressed_date" &&
      record["time_basis"] !== "experienced_date") ||
    (record["source_scope"] !== undefined &&
      record["source_scope"] !== "conversation_text")
  ) {
    return { invalid: true };
  }
  return {
    proposal: {
      endDate,
      kind: "review_dates",
      sourceScope: "conversation_text",
      startDate,
      timeBasis:
        record["time_basis"] === "experienced_date"
          ? "experienced_date"
          : "expressed_date",
    },
  };
}

export type HistoryRecallFailureCode =
  | "timezone_unavailable"
  | "date_range_reversed"
  | "date_range_too_wide"
  | "date_in_future"
  | "source_read_failed"
  | "source_read_timeout"
  | "source_read_threw"
  | "owner_inactive"
  | "expected_data_epoch_mismatch";

/** The deterministic plan resolved from the proposal and frozen facts. */
export type HistoryQueryPlan = Readonly<{
  /** The admitted request's input-event instant: nothing later is read. */
  cutoff: string;
  /** Number of local dates the person asked about (inclusive). */
  dateCount: number;
  endDate: string;
  /** The asked dates, itemized only for a short range (else empty). */
  localDates: readonly string[];
  /** The dates actually read; wider than asked for an experienced date. */
  readEndDate: string;
  readStartDate: string;
  startDate: string;
  timeBasis: HistoryTimeBasis;
  timezone: string;
}>;

export function resolveHistoryQueryPlan(input: {
  cutoff: Date;
  policy: HistoryRecallPolicy;
  proposal: HistoryQueryProposal;
  timezone: string | null;
}):
  | { ok: true; plan: HistoryQueryPlan }
  | { code: HistoryRecallFailureCode; ok: false } {
  if (input.timezone === null) {
    return { code: "timezone_unavailable", ok: false };
  }
  const { startDate, endDate } = input.proposal;
  if (endDate < startDate) return { code: "date_range_reversed", ok: false };
  const localDates: string[] = [];
  for (
    let day = startDate;
    day <= endDate && localDates.length <= input.policy.maxDateSpanDays;
    day = shiftLocalDate(day, 1)
  ) {
    localDates.push(day);
  }
  if (localDates.length > input.policy.maxDateSpanDays) {
    return { code: "date_range_too_wide", ok: false };
  }
  const today = localDateOf(input.cutoff, input.timezone);
  if (endDate > today) {
    return { code: "date_in_future", ok: false };
  }
  const experienced = input.proposal.timeBasis === "experienced_date";
  const lookaheadEnd = shiftLocalDate(endDate, input.policy.experiencedLookaheadDays);
  return {
    ok: true,
    plan: {
      cutoff: input.cutoff.toISOString(),
      dateCount: localDates.length,
      endDate,
      localDates:
        localDates.length <= input.policy.itemizedDateLimit ? localDates : [],
      readEndDate: experienced ? (lookaheadEnd < today ? lookaheadEnd : today) : endDate,
      readStartDate: startDate,
      startDate,
      timeBasis: input.proposal.timeBasis,
      timezone: input.timezone,
    },
  };
}

/** One row from the bounded source read. Control-excluded rows carry no text. */
export type HistoryRecallSourceItem = Readonly<{
  actor: "user" | "assistant";
  dailySessionId: DailySessionId;
  exclusion: Readonly<{
    controlId: string;
    reason: "correction_association" | "forget_association";
  }> | null;
  expressedAt: string;
  expressionTimezone: string | null;
  expressionTimezoneSource: "request" | "session_start_fallback" | "unknown";
  /** For an Assistant: the user revision whose request produced it. */
  generatingUserRevisionId: ConversationEventRevisionId | null;
  localDate: string;
  revisionId: ConversationEventRevisionId;
  sequence: number;
  text: string;
}>;

export type HistoryRecallSourceRequest = Readonly<{
  budgets: Readonly<{
    maxPages: number;
    maxSourceRows: number;
    pageSize: number;
    readTimeoutMs: number;
  }>;
  /** The request itself is never part of the range it asks about. */
  requestRevisionId: ConversationEventRevisionId;
  expectedDataEpoch: number;
  plan: HistoryQueryPlan;
  userId: UserId;
}>;

export type HistoryRecallSourceSnapshot = Readonly<{
  failure: Readonly<{ code: HistoryRecallFailureCode }> | null;
  /** True when every row in the plan's range was enumerated. */
  enumerationComplete: boolean;
  /** Rows of the current Daily Session that were left out on purpose. */
  currentConversationRows: number;
  items: readonly HistoryRecallSourceItem[];
  pages: number;
  readLatencyMs: number;
}>;

export type HistoryRecallSourcePort = Readonly<{
  readHistoryRange(
    request: HistoryRecallSourceRequest,
  ): Promise<HistoryRecallSourceSnapshot>;
}>;

export type HistoryRecallOmissionReason =
  | "correction_association"
  | "forget_association"
  | "single_event_over_budget"
  | "budget_exhausted"
  /** Assistant lines are context only: giving them up loses no source. */
  | "assistant_context_trimmed"
  | "duplicate_text";

/** Omissions that leave part of the person's own words unseen. */
const MISSED_SOURCE_REASONS: ReadonlySet<HistoryRecallOmissionReason> = new Set([
  "budget_exhausted",
  "single_event_over_budget",
]);

/** Why a review can never be called complete however much was read. */
export type HistoryRecallLimit = "experience_time_not_recorded";

export type HistoryRecallDateState = "empty" | "complete" | "partial" | "unread";

export type HistoryRecallDateCoverage = Readonly<{
  enumeratedRows: number;
  localDate: string;
  selectedRows: number;
  state: HistoryRecallDateState;
}>;

/** Content-free accounting of one review. Enumerated and injected differ. */
export type HistoryRecallCoverage = Readonly<{
  /** Time blocks (runs of messages without a long pause) among eligible rows. */
  blocks: number;
  /** Blocks that still have at least one quoted message. */
  blocksCovered: number;
  currentConversationRows: number;
  enumeratedRows: number;
  enumerationComplete: boolean;
  limits: readonly HistoryRecallLimit[];
  omitted: Readonly<Partial<Record<HistoryRecallOmissionReason, number>>>;
  pages: number;
  perDate: readonly HistoryRecallDateCoverage[];
  /** Instant of the last enumerated message when the read did not finish. */
  readThrough: string | null;
  readLatencyMs: number;
  selectedRows: number;
  selectedTokens: number;
  timeBasis: HistoryTimeBasis;
}>;

export type HistoryRecallItemRef = Readonly<{
  actor: "user" | "assistant";
  dailySessionId: DailySessionId;
  estimatedTokens: number;
  expressedAt: string;
  revisionId: ConversationEventRevisionId;
  sequence: number;
}>;

export type HistoryRecallResult = Readonly<{
  coverage: HistoryRecallCoverage;
  failureCode: HistoryRecallFailureCode | null;
  itemRefs: readonly HistoryRecallItemRef[];
  plan: HistoryQueryPlan | null;
  /** The proposal as the model asked, kept so a failed plan stays explainable. */
  proposal: HistoryQueryProposal;
  status: "completed" | "failed" | "partial";
}>;

export const EMPTY_HISTORY_RECALL_COVERAGE: HistoryRecallCoverage =
  Object.freeze({
    blocks: 0,
    blocksCovered: 0,
    currentConversationRows: 0,
    enumeratedRows: 0,
    enumerationComplete: false,
    limits: Object.freeze([]),
    omitted: Object.freeze({}),
    pages: 0,
    perDate: Object.freeze([]),
    readLatencyMs: 0,
    readThrough: null,
    selectedRows: 0,
    selectedTokens: 0,
    timeBasis: "expressed_date" as const,
  });

export function failedHistoryRecallResult(
  proposal: HistoryQueryProposal,
  plan: HistoryQueryPlan | null,
  code: HistoryRecallFailureCode,
  coverage: HistoryRecallCoverage = EMPTY_HISTORY_RECALL_COVERAGE,
): HistoryRecallResult {
  return {
    coverage: { ...coverage, selectedRows: 0, selectedTokens: 0 },
    failureCode: code,
    itemRefs: [],
    plan,
    proposal,
    status: "failed",
  };
}

type Candidate = Readonly<{ item: HistoryRecallSourceItem; tokens: number }>;

/**
 * Split chronologically ordered candidates into time blocks: a pause longer
 * than the policy gap starts a new block. Blocks are the unit that keeps an
 * early short subject from being crowded out by a late long one.
 */
function toTimeBlocks(
  candidates: readonly Candidate[],
  gapMinutes: number,
): Candidate[][] {
  const gapMs = gapMinutes * 60_000;
  const blocks: Candidate[][] = [];
  let previous: number | null = null;
  for (const candidate of candidates) {
    const instant = Date.parse(candidate.item.expressedAt);
    if (previous === null || instant - previous > gapMs) blocks.push([]);
    blocks.at(-1)!.push(candidate);
    previous = instant;
  }
  return blocks;
}

/** Split `budget` over blocks: small blocks keep all they need, big ones share the rest. */
function allotBlockBudgets(
  demands: readonly number[],
  budget: number,
): number[] {
  const allotments = demands.map(() => 0);
  let remaining = budget;
  let left = demands.length;
  const ascending = demands
    .map((demand, index) => ({ demand, index }))
    .toSorted((a, b) => a.demand - b.demand || a.index - b.index);
  for (const { demand, index } of ascending) {
    const allot = Math.min(demand, Math.floor(remaining / left));
    allotments[index] = allot;
    remaining -= allot;
    left -= 1;
  }
  return allotments;
}

/**
 * Deterministically select what the answer stage may quote and account for
 * everything that was not. Control-excluded rows, and the Assistant replies
 * generated for them, never become references. When the eligible text exceeds
 * the budget, every time block of the range keeps a share: the Assistant's
 * lines go first, then the longest of the person's lines, and the opening line
 * of a block is the last to go. What is not quoted is reported, never
 * silently skipped.
 */
export function selectHistoryRecall(input: {
  plan: HistoryQueryPlan;
  policy: HistoryRecallPolicy;
  proposal: HistoryQueryProposal;
  snapshot: HistoryRecallSourceSnapshot;
}): HistoryRecallResult {
  const { snapshot, policy, plan } = input;
  if (snapshot.failure !== null) {
    return failedHistoryRecallResult(
      input.proposal,
      plan,
      snapshot.failure.code,
      {
        ...EMPTY_HISTORY_RECALL_COVERAGE,
        pages: snapshot.pages,
        readLatencyMs: snapshot.readLatencyMs,
        timeBasis: input.proposal.timeBasis,
      },
    );
  }
  const ordered = snapshot.items.toSorted(
    (left, right) =>
      left.expressedAt.localeCompare(right.expressedAt) ||
      left.dailySessionId.localeCompare(right.dailySessionId) ||
      left.sequence - right.sequence,
  );
  const omitted: Partial<Record<HistoryRecallOmissionReason, number>> = {};
  const missedRows = new Set<HistoryRecallSourceItem>();
  const omit = (
    reason: HistoryRecallOmissionReason,
    item: HistoryRecallSourceItem,
  ) => {
    omitted[reason] = (omitted[reason] ?? 0) + 1;
    if (MISSED_SOURCE_REASONS.has(reason)) missedRows.add(item);
  };
  const droppedUserRevisions = new Set<string>();
  const seenUserText = new Set<string>();
  const candidates: Candidate[] = [];
  for (const item of ordered) {
    if (item.exclusion !== null) {
      omit(item.exclusion.reason, item);
      droppedUserRevisions.add(item.revisionId);
      continue;
    }
    if (
      item.actor === "assistant" &&
      item.generatingUserRevisionId !== null &&
      droppedUserRevisions.has(item.generatingUserRevisionId)
    ) {
      // A companion of a dropped user message: not a budget miss, not counted.
      droppedUserRevisions.add(item.revisionId);
      continue;
    }
    const itemTokens = estimateRecentContextTokens(item.text);
    if (itemTokens > policy.maxSingleEventTokens) {
      omit(
        item.actor === "user"
          ? "single_event_over_budget"
          : "assistant_context_trimmed",
        item,
      );
      droppedUserRevisions.add(item.revisionId);
      continue;
    }
    if (item.actor === "user") {
      const normalized = item.text.trim();
      if (seenUserText.has(normalized)) {
        omit("duplicate_text", item);
        continue;
      }
      seenUserText.add(normalized);
    }
    candidates.push({ item, tokens: itemTokens });
  }

  const blocks = toTimeBlocks(candidates, policy.blockGapMinutes);
  const demands = blocks.map((block) =>
    block.reduce((total, candidate) => total + candidate.tokens, 0),
  );
  const total = demands.reduce((sum, demand) => sum + demand, 0);
  const allotments =
    total <= policy.maxContextTokens
      ? demands
      : allotBlockBudgets(demands, policy.maxContextTokens);
  const selected: Candidate[] = [];
  for (const [index, block] of blocks.entries()) {
    const allot = allotments[index]!;
    let used = demands[index]!;
    const dropped = new Set<Candidate>();
    if (used > allot) {
      const firstUser = block.find((candidate) => candidate.item.actor === "user");
      const rank = (candidate: Candidate) =>
        candidate.item.actor === "assistant" ? 0 : candidate === firstUser ? 2 : 1;
      const dropOrder = block
        .map((candidate, position) => ({ candidate, position }))
        .toSorted(
          (a, b) =>
            rank(a.candidate) - rank(b.candidate) ||
            b.candidate.tokens - a.candidate.tokens ||
            b.position - a.position,
        );
      for (const { candidate } of dropOrder) {
        if (used <= allot) break;
        dropped.add(candidate);
        used -= candidate.tokens;
      }
    }
    for (const candidate of block) {
      if (dropped.has(candidate)) {
        omit(
          candidate.item.actor === "assistant"
            ? "assistant_context_trimmed"
            : "budget_exhausted",
          candidate.item,
        );
      } else {
        selected.push(candidate);
      }
    }
  }
  const selectedItems = new Set(selected.map((candidate) => candidate.item));
  const reportedDates =
    plan.localDates.length > 0
      ? plan.localDates
      : [...new Set(ordered.map((entry) => entry.localDate))].toSorted();
  const perDate = reportedDates.map((localDate): HistoryRecallDateCoverage => {
    const rows = ordered.filter((entry) => entry.localDate === localDate);
    const selectedRows = rows.filter((entry) => selectedItems.has(entry)).length;
    const missed = rows.some((entry) => missedRows.has(entry));
    const state: HistoryRecallDateState =
      rows.length === 0
        ? snapshot.enumerationComplete
          ? "empty"
          : "unread"
        : missed || !snapshot.enumerationComplete
          ? "partial"
          : "complete";
    return { enumeratedRows: rows.length, localDate, selectedRows, state };
  });
  const limits: HistoryRecallLimit[] =
    input.proposal.timeBasis === "experienced_date"
      ? ["experience_time_not_recorded"]
      : [];
  const unreadOrBounded =
    !snapshot.enumerationComplete || missedRows.size > 0 || limits.length > 0;
  const chronological = selected.toSorted(
    (a, b) =>
      a.item.expressedAt.localeCompare(b.item.expressedAt) ||
      a.item.dailySessionId.localeCompare(b.item.dailySessionId) ||
      a.item.sequence - b.item.sequence,
  );
  return {
    coverage: {
      blocks: blocks.length,
      blocksCovered: blocks.filter((block) =>
        block.some((candidate) => selectedItems.has(candidate.item)),
      ).length,
      currentConversationRows: snapshot.currentConversationRows,
      enumeratedRows: ordered.length,
      enumerationComplete: snapshot.enumerationComplete,
      limits,
      omitted,
      pages: snapshot.pages,
      perDate,
      readLatencyMs: snapshot.readLatencyMs,
      readThrough:
        snapshot.enumerationComplete || ordered.length === 0
          ? null
          : ordered.at(-1)!.expressedAt,
      selectedRows: chronological.length,
      selectedTokens: chronological.reduce((sum, c) => sum + c.tokens, 0),
      timeBasis: input.proposal.timeBasis,
    },
    failureCode: null,
    itemRefs: chronological.map((candidate) => ({
      actor: candidate.item.actor,
      dailySessionId: candidate.item.dailySessionId,
      estimatedTokens: candidate.tokens,
      expressedAt: candidate.item.expressedAt,
      revisionId: candidate.item.revisionId,
      sequence: candidate.item.sequence,
    })),
    plan,
    proposal: input.proposal,
    status: unreadOrBounded ? "partial" : "completed",
  };
}

/** What the Harness gets back once the answer stage exists. */
export type HistoryRecallReceipt = Readonly<{
  answer: Readonly<{
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
  }>;
  coverage: HistoryRecallCoverage;
  failureCode: HistoryRecallFailureCode | null;
  status: HistoryRecallResult["status"];
}>;

export type HistoryRecallDecisionFacts = Readonly<{
  cutoff: Date;
  dailySessionId: DailySessionId;
  expectedDataEpoch: number;
  inputRevisionId: ConversationEventRevisionId;
  interactionTurnId: InteractionTurnId;
  requestTimezone: string | null;
  sessionTimezone: string | null;
}>;

export type HistoryRecallRepository = Readonly<{
  /** Frozen facts of a running Decision Command; null for any other owner. */
  loadDecisionFacts(input: {
    decisionCommandId: GenerationCommandId;
    userId: UserId;
  }): Promise<HistoryRecallDecisionFacts | null>;
  /**
   * Atomically settle the Decision, freeze the result and create the History
   * Answer command with its first attempt. Replays return the same ids.
   * `fence_rejected` when the owner, epoch, request revision or Decision
   * state no longer permit the review.
   */
  commitHistoryRecall(input: {
    decisionAttemptId: ModelRunAttemptId;
    decisionCommandId: GenerationCommandId;
    now: Date;
    policyVersion: string;
    result: HistoryRecallResult;
    userId: UserId;
  }): Promise<
    | Readonly<{
        answer: HistoryRecallReceipt["answer"];
        outcome: "committed";
      }>
    | Readonly<{ outcome: "fence_rejected" }>
  >;
  /** History Answer commands that were created but not yet answered. */
  listPendingHistoryAnswers(input: { limit: number }): Promise<
    readonly HistoryAnswerCommandRef[]
  >;
}>;

export type HistoryAnswerCommandRef = Readonly<{
  generationCommandId: GenerationCommandId;
  interactionTurnId: InteractionTurnId;
  modelRunAttemptId: ModelRunAttemptId;
  requestEventRevisionId: ConversationEventRevisionId;
  userId: UserId;
}>;

export type HistoryRecallGateway = Readonly<{
  admit(input: {
    context: Readonly<{
      decisionCommandId: GenerationCommandId;
      modelRunAttemptId: ModelRunAttemptId;
      requestEventRevisionId: ConversationEventRevisionId;
      userId: UserId;
    }>;
    proposal: HistoryQueryProposal;
  }): Promise<HistoryRecallReceipt | { outcome: "fence_rejected" }>;
  listPendingAnswers(input: {
    limit: number;
  }): Promise<readonly HistoryAnswerCommandRef[]>;
}>;

export function createHistoryRecallGateway(dependencies: {
  clock: () => Date;
  policy?: HistoryRecallPolicy;
  repository: HistoryRecallRepository;
  source: HistoryRecallSourcePort;
}): HistoryRecallGateway {
  const policy = dependencies.policy ?? HISTORY_RECALL_DEFAULT_POLICY;
  return {
    listPendingAnswers: (input) =>
      dependencies.repository.listPendingHistoryAnswers(input),
    async admit({ context, proposal }) {
      // The owner comes from the frozen Decision Command, never from the
      // proposal. Another owner's command resolves to nothing and fails closed.
      const facts = await dependencies.repository.loadDecisionFacts({
        decisionCommandId: context.decisionCommandId,
        userId: context.userId,
      });
      if (facts === null || facts.inputRevisionId !== context.requestEventRevisionId) {
        return { outcome: "fence_rejected" };
      }
      const resolved = resolveHistoryQueryPlan({
        cutoff: facts.cutoff,
        policy,
        proposal,
        timezone: facts.requestTimezone ?? facts.sessionTimezone,
      });
      let result: HistoryRecallResult;
      if (!resolved.ok) {
        result = failedHistoryRecallResult(proposal, null, resolved.code);
      } else {
        let snapshot: HistoryRecallSourceSnapshot;
        try {
          snapshot = await dependencies.source.readHistoryRange({
            budgets: {
              maxPages: policy.maxPages,
              maxSourceRows: policy.maxSourceRows,
              pageSize: policy.pageSize,
              readTimeoutMs: policy.readTimeoutMs,
            },
            requestRevisionId: context.requestEventRevisionId,
            expectedDataEpoch: facts.expectedDataEpoch,
            plan: resolved.plan,
            userId: context.userId,
          });
        } catch {
          snapshot = {
            currentConversationRows: 0,
            enumerationComplete: false,
            failure: { code: "source_read_threw" },
            items: [],
            pages: 0,
            readLatencyMs: 0,
          };
        }
        result = selectHistoryRecall({
          plan: resolved.plan,
          policy,
          proposal,
          snapshot,
        });
      }
      const committed = await dependencies.repository.commitHistoryRecall({
        decisionAttemptId: context.modelRunAttemptId,
        decisionCommandId: context.decisionCommandId,
        now: dependencies.clock(),
        policyVersion: policy.version,
        result,
        userId: context.userId,
      });
      if (committed.outcome !== "committed") return { outcome: "fence_rejected" };
      return {
        answer: committed.answer,
        coverage: result.coverage,
        failureCode: result.failureCode,
        status: result.status,
      };
    },
  };
}

/** The content-free manifest that rides in the receipt section reference. */
export type HistoryRecallReceiptSnapshot = Readonly<{
  /** Rows that qualified at query time but no longer did when compiled. */
  droppedAtCompile: number;
  injectedRows: number;
  policyVersion: string;
  result: Pick<
    HistoryRecallResult,
    "coverage" | "failureCode" | "plan" | "proposal" | "status"
  >;
  version: typeof HISTORY_RECALL_RESULT_VERSION;
}>;

export function encodeHistoryRecallReceipt(
  snapshot: HistoryRecallReceiptSnapshot,
): string {
  return JSON.stringify(snapshot);
}

export function decodeHistoryRecallReceipt(
  reference: string,
): HistoryRecallReceiptSnapshot {
  const parsed: unknown = JSON.parse(reference);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== HISTORY_RECALL_RESULT_VERSION
  ) {
    throw new Error("Unsupported frozen history recall receipt.");
  }
  return parsed as HistoryRecallReceiptSnapshot;
}

/** "2026-09-14 18:30" in the given IANA zone. */
function formatLocalMinute(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/**
 * What the reply should say for this outcome. Wording here is for the model;
 * it must never teach the model to talk about how the lookup works.
 */
function historyAnswerGuidance(
  snapshot: HistoryRecallReceiptSnapshot,
): readonly string[] {
  const { result } = snapshot;
  const coverage = result.coverage;
  if (result.status === "failed") {
    return [
      "Answer guidance (lookup failed): say plainly that you could not look it up right now and offer to try again in a moment; do not guess what was said and do not say that nothing was said.",
    ];
  }
  const lines: string[] = [];
  const experienced = result.proposal.timeBasis === "experienced_date";
  const noMessages =
    coverage.selectedRows === 0 &&
    coverage.enumerationComplete &&
    coverage.enumeratedRows === 0;
  if (experienced) {
    lines.push(
      "Answer guidance (event date): the saved messages show when things were said, and when something happened is not recorded. Place an event on a day only when the person's own words give it, relative to when they said it (for example 'last Sunday'); otherwise say its date was not given and keep it undated. Say this is what they told you and do not claim it is everything that happened that day.",
    );
  }
  if (!coverage.enumerationComplete) {
    lines.push(
      "Answer guidance (read stopped early): say plainly that you only saw part of that period and name where it stops; tell what you did see and that anything after that point is not covered; do not claim there is nothing more.",
    );
  } else if (result.status === "partial" && (coverage.omitted.budget_exhausted ?? 0) + (coverage.omitted.single_event_over_budget ?? 0) > 0) {
    lines.push(
      "Answer guidance (only part quoted): cover every part of the day or period you were given, briefly, and say plainly that you have only part of what was said; offer to go into any one thing in detail from the person's own words; do not pretend it is complete.",
    );
  }
  if (noMessages) {
    lines.push(
      experienced
        ? "Answer guidance (nothing found): say you did not find anything they said about that among what you can look at; that does not prove it did not happen."
        : "Answer guidance (nothing found): say you did not find saved messages from that date among what you can look at; that does not prove nothing was said or happened. Do not make up content for it.",
    );
  } else if (lines.length === 0) {
    lines.push(
      "Answer guidance (complete): you were given every saved message from that period, so cover all the distinct subjects in the order they came up, each with when it was said; do not leave a subject out because another was longer.",
    );
  }
  return lines;
}

/** The answer stage's model-facing rendering of the frozen result. */
export function renderHistoryRecallReceipt(
  snapshot: HistoryRecallReceiptSnapshot,
): string {
  const { result } = snapshot;
  const plan = result.plan;
  const coverage = result.coverage;
  const lines = [
    `History review result (read-only lookup of the user's own saved messages; policy ${snapshot.policyVersion}):`,
  ];
  if (plan === null) {
    lines.push(
      `The lookup could not be planned (${result.failureCode ?? "unknown"}). No messages were read.`,
    );
  } else {
    const span = `${plan.startDate}${plan.endDate === plan.startDate ? "" : ` to ${plan.endDate}`}`;
    if (plan.timeBasis === "experienced_date") {
      lines.push(
        `Requested: what happened on local date(s) ${span} (timezone ${plan.timezone}). When something happened is not recorded; the dates below are when the person said things.`,
        `Read: messages the person said from ${plan.readStartDate} to ${plan.readEndDate}, looking for mentions of that time.`,
      );
    } else {
      lines.push(
        `Requested: messages the user wrote on local date(s) ${span} (timezone ${plan.timezone}). The dates are when the person said things, not when the things happened.`,
      );
    }
  }
  lines.push(
    `Read status: ${result.status}${result.failureCode ? ` (${result.failureCode})` : ""}.`,
  );
  for (const date of coverage.perDate) {
    lines.push(
      `- ${date.localDate}: ${date.state}; ${date.enumeratedRows} message(s) found, ${date.selectedRows} quoted.`,
    );
  }
  if (plan !== null && coverage.readThrough !== null) {
    lines.push(
      `Read through ${formatLocalMinute(coverage.readThrough, plan.timezone)} (${plan.timezone}); later messages in the range were not read.`,
    );
  }
  const omitted = Object.entries(coverage.omitted);
  if (omitted.length > 0 || snapshot.droppedAtCompile > 0) {
    lines.push(
      `Not quoted: ${[
        ...omitted.map(([reason, count]) => `${reason} x${count}`),
        ...(snapshot.droppedAtCompile > 0
          ? [`no_longer_eligible x${snapshot.droppedAtCompile}`]
          : []),
      ].join(", ")}.`,
    );
  }
  lines.push(
    "Rules for the reply: quote and describe only the messages that appear in the conversation before the user's current message (each has its own time in the Times list); do not invent anything else. Mention when each thing was said using those times. Assistant lines there are only your earlier replies for understanding and are never evidence of what the person said. Reply as one complete natural paragraph. Never mention internal terms such as policy, receipt, section, token, coverage, status or limits.",
    ...historyAnswerGuidance(snapshot),
  );
  return lines.join("\n");
}
