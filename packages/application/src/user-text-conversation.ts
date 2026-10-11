import {
  asConversationEventId,
  asDailySessionId,
  asInteractionTurnId,
  type ConversationEventId,
  type ConversationEventRevisionId,
  type DailySessionId,
  type GenerationCommandId,
  type InteractionTurnId,
  type ModelRunAttemptId,
  type PrivateWriteGateReason,
  type UserId,
} from "@sayhear/domain";

import type { ConversationTextProvider } from "./conversation-model";
import type { RecoveryGate } from "./recovery-gate";

declare const clientEventIdBrand: unique symbol;
declare const clientTurnIdBrand: unique symbol;
declare const retryRequestIdBrand: unique symbol;

export type ClientEventId = string & {
  readonly [clientEventIdBrand]: "ClientEventId";
};
export type ClientTurnId = string & {
  readonly [clientTurnIdBrand]: "ClientTurnId";
};
export type RetryRequestId = string & {
  readonly [retryRequestIdBrand]: "RetryRequestId";
};

export type InteractionTurnStatus =
  | "open"
  | "responding"
  | "settled"
  | "interrupted"
  | "failed";

export type RecordUserTextTurnInput = Readonly<{
  clientEventId: ClientEventId;
  clientTurnId: ClientTurnId;
  expectedBackupPolicyVersion: string;
  expectedConfigurationFingerprint: string;
  /** Fast-path extraction switch + versioned policy (issue #113); null = off. */
  fastPathExtractionPolicyVersion: string | null;
  generationPolicy: GenerationPolicy;
  inactivityPolicy: InactivityPolicy;
  locale: string;
  logicalDate: string;
  now: Date;
  /** The end-to-end deadline frozen onto the command (issue #319). */
  requestDeadlineAt?: Date;
  text: string;
  timezone: string;
  userId: UserId;
}>;

/**
 * The freshness rule frozen onto every new conversation command (issue #319):
 * an answer may be kept only while its input is the newest user message of its
 * Daily Session. Named, so the rule is versioned rather than implied.
 */
export const LATEST_USER_INPUT_FENCE_VERSION = "latest_user_input:v1";

export type RecordConversationRetryInput = Readonly<{
  expectedBackupPolicyVersion: string;
  expectedConfigurationFingerprint: string;
  generationPolicy: GenerationPolicy;
  inactivityPolicy: InactivityPolicy;
  now: Date;
  originalTurnId: InteractionTurnId;
  requestDeadlineAt?: Date;
  retryRequestId: RetryRequestId;
  userId: UserId;
}>;

export type GenerationPolicy = Readonly<{
  consentPolicyVersion: string | null;
  freshnessPolicy: "source_valid:v1";
  chineseLocalePackVersion: string;
  englishLocalePackVersion: string;
  harnessPolicyVersion: string;
  conversationActionCatalogVersion: string;
  model: string;
  modelConfigVersion: string;
  modelSnapshot: string;
  canonicalPersonaVersion: string;
  outputFormatVersion: string;
  personaBehaviorAnchorsVersion: string;
  personaContractInvariantVersion: string;
  providerPolicyVersion: string;
  productPolicyVersion: string;
  provider: ConversationTextProvider;
  relationshipPolicyVersion: string;
  safetyPolicyVersion: string;
  taskInstructionVersion: string;
}>;

export type InactivityPolicy = Readonly<{
  timeoutMs: number;
  version: string;
}>;

type ValidatedUserTextInput = Readonly<{
  clientEventId: ClientEventId;
  clientTurnId: ClientTurnId;
  locale: string;
  text: string;
  timezone: string;
}>;

export type UserTextTurn = Readonly<{
  dailySession: Readonly<{
    id: DailySessionId;
    logicalDate: string;
    timezoneAtStart: string;
  }>;
  message: Readonly<{
    /**
     * The authoritative server commit instant of the User Event
     * (`conversation_events.created_at`, ISO 8601 UTC). It is the same value the
     * portal read contract returns for that message, never a receive/render
     * time.
     */
    createdAt: string;
    id: ConversationEventId;
    locale: string;
    revisionId: ConversationEventRevisionId;
    sequence: number;
    text: string;
  }>;
  generation: Readonly<{
    attemptId: ModelRunAttemptId;
    commandId: GenerationCommandId;
  }>;
  replayed: boolean;
  turn: Readonly<{
    id: InteractionTurnId;
    sequence: number;
    status: InteractionTurnStatus;
  }>;
}>;

export type ConversationRetryTurn = Readonly<{
  generation: Readonly<{
    attemptId: ModelRunAttemptId;
    commandId: GenerationCommandId;
  }>;
  originalTurnId: InteractionTurnId;
  replayed: boolean;
  retryActionEventId: ConversationEventId;
  retryRequestId: RetryRequestId;
  turn: Readonly<{
    id: InteractionTurnId;
    sequence: number;
    status: InteractionTurnStatus;
  }>;
}>;

export type ExplicitContinuousExchangeEnd = Readonly<{
  dailySessionId: DailySessionId;
  endedBy: "explicit_user_end";
  replayed: boolean;
  state: "quiescent";
}>;

export type UserTextMessage = Readonly<{
  actor: "user" | "assistant";
  /**
   * The server-persisted commit instant of the message
   * (`conversation_events.created_at`, ISO 8601 UTC). For a user event this is
   * the moment the User Turn was recorded; for an assistant event it is the
   * formal commit `completedAt`. It is never a delta-receive, render or refresh
   * time.
   */
  createdAt: string;
  eventId: ConversationEventId;
  generationCommandId: GenerationCommandId | null;
  locale: string;
  logicalDate: string;
  revisionId: ConversationEventRevisionId;
  sequence: number;
  text: string;
}>;

export type InterruptedConversationResponse = Readonly<{
  logicalDate: string;
  retryStatus: "available" | "retried" | "retrying";
  sequence: number;
  turnId: InteractionTurnId;
}>;

/**
 * A Daily Session resolved by an owner-scoped date read. It never exposes any
 * other owner's session and never creates one.
 */
export type ConversationSessionRef = Readonly<{
  dailySessionId: DailySessionId;
  logicalDate: string;
}>;

export type ConversationDateEntry = Readonly<{
  dailySessionId: DailySessionId;
  logicalDate: string;
}>;

/**
 * One page of Daily Session dates, newest first. `nextCursor` is an opaque
 * server token bound to this query; `null` means there is no earlier page.
 */
export type ConversationDatePage = Readonly<{
  entries: readonly ConversationDateEntry[];
  nextCursor: string | null;
}>;

/**
 * One page of messages within a single Daily Session, ascending by the
 * persisted `sequence_no`. `nextCursor` continues towards older messages.
 */
export type ConversationMessagePage = Readonly<{
  messages: readonly UserTextMessage[];
  nextCursor: string | null;
}>;

/**
 * The owner's single currently writable Daily Session, read directly from the
 * authoritative `activity_state`. A read never creates a session.
 */
export type CurrentConversationIdentity = Readonly<{
  activityState: "active";
  dailySessionId: DailySessionId;
  logicalDate: string;
  startedAt: Date;
  timezoneAtStart: string;
}>;

/**
 * Server-side fixed cap for the portal's first recent-message read. The client
 * cannot raise it; pagination beyond this batch belongs to a later ticket.
 */
export const RECENT_CONVERSATION_MESSAGE_LIMIT = 50;

/**
 * Server-side fixed caps for the portal's history reads. The client cannot
 * raise them, and the cursor carries no limit the caller can influence.
 */
export const CONVERSATION_DATE_PAGE_LIMIT = 30;
export const OLDER_CONVERSATION_MESSAGE_LIMIT = 50;

export class ConversationSessionNotFoundError extends Error {
  public constructor() {
    super("The Daily Session was not found for this owner.");
    this.name = "ConversationSessionNotFoundError";
  }
}

export class InvalidConversationCursorError extends Error {
  public constructor() {
    super("The conversation cursor is invalid for this query.");
    this.name = "InvalidConversationCursorError";
  }
}

export type RecordUserTextTurnRepositoryResult =
  | Readonly<{ outcome: "recorded"; turn: UserTextTurn }>
  | Readonly<{ outcome: "idempotency_conflict" }>
  | Readonly<{ outcome: "owner_denied" }>
  | Readonly<{
      outcome: "write_denied";
      reason: Exclude<PrivateWriteGateReason, "backup_evidence_current">;
    }>;

export type RecordConversationRetryRepositoryResult =
  | Readonly<{ outcome: "recorded"; retry: ConversationRetryTurn }>
  | Readonly<{ outcome: "idempotency_conflict" }>
  | Readonly<{ outcome: "owner_denied" }>
  | Readonly<{ outcome: "retry_not_allowed" }>
  | Readonly<{
      outcome: "write_denied";
      reason: Exclude<PrivateWriteGateReason, "backup_evidence_current">;
    }>;

export type UserTextConversationRepository = Readonly<{
  correctUserEvent?(input: { eventId: ConversationEventId; locale: string; now: Date; text: string; userId: UserId; fastPathExtractionPolicyVersion: string | null }): Promise<{ dailySessionId: DailySessionId } | null>;
  endContinuousExchangeExplicitly(input: {
    dailySessionId: DailySessionId;
    endedAt: Date;
    userId: UserId;
  }): Promise<
    | Readonly<{
        end: ExplicitContinuousExchangeEnd;
        outcome: "ended";
      }>
    | Readonly<{ outcome: "not_found" }>
  >;
  findCurrentWritableConversation(
    userId: UserId,
  ): Promise<CurrentConversationIdentity | null>;
  findConversationSessionByDate(input: {
    logicalDate: string;
    userId: UserId;
  }): Promise<ConversationSessionRef | null>;
  findConversationSessionById(input: {
    dailySessionId: DailySessionId;
    userId: UserId;
  }): Promise<ConversationSessionRef | null>;
  listConversationDates(input: {
    beforeDailySessionId: DailySessionId | null;
    beforeLogicalDate: string | null;
    limit: number;
    userId: UserId;
  }): Promise<
    Readonly<{
      entries: readonly ConversationDateEntry[];
      hasMore: boolean;
    }>
  >;
  listInterruptedResponses(
    userId: UserId,
  ): Promise<readonly InterruptedConversationResponse[]>;
  listInterruptedResponsesForSession(input: {
    dailySessionId: DailySessionId;
    userId: UserId;
  }): Promise<readonly InterruptedConversationResponse[]>;
  listOlderUserTextMessages(input: {
    beforeSequence: number;
    dailySessionId: DailySessionId;
    limit: number;
    userId: UserId;
  }): Promise<
    Readonly<{
      hasMore: boolean;
      messages: readonly UserTextMessage[];
    }>
  >;
  listRecentUserTextMessages(input: {
    dailySessionId: DailySessionId;
    limit: number;
    userId: UserId;
  }): Promise<readonly UserTextMessage[]>;
  listUserTextMessages(userId: UserId): Promise<readonly UserTextMessage[]>;
  recordConversationRetry(
    input: RecordConversationRetryInput,
  ): Promise<RecordConversationRetryRepositoryResult>;
  recordUserTextTurn(
    input: RecordUserTextTurnInput,
  ): Promise<RecordUserTextTurnRepositoryResult>;
}>;

export type UserTextConversationService = Readonly<{
  correct(userId: UserId, input: { eventId: string; locale: string; text: string }): Promise<{ dailySessionId: DailySessionId }>;
  endContinuousExchange(
    userId: UserId,
    input: { dailySessionId: string },
  ): Promise<ExplicitContinuousExchangeEnd>;
  listInterruptedResponses(
    userId: UserId,
  ): Promise<readonly InterruptedConversationResponse[]>;
  listInterruptedResponsesForSession(
    userId: UserId,
    dailySessionId: string,
  ): Promise<readonly InterruptedConversationResponse[]>;
  listMessages(userId: UserId): Promise<readonly UserTextMessage[]>;
  listConversationDates(
    userId: UserId,
    input: { cursor: string | null },
  ): Promise<ConversationDatePage>;
  listOlderMessages(
    userId: UserId,
    input: {
      beforeSequence?: number | null;
      cursor?: string | null;
      dailySessionId: string;
    },
  ): Promise<ConversationMessagePage>;
  listRecentMessages(
    userId: UserId,
    input: { dailySessionId: string },
  ): Promise<readonly UserTextMessage[]>;
  readConversationByDate(
    userId: UserId,
    logicalDate: string,
  ): Promise<ConversationSessionRef | null>;
  readCurrentConversation(
    userId: UserId,
  ): Promise<CurrentConversationIdentity | null>;
  retry(
    userId: UserId,
    input: {
      originalTurnId: string;
      retryRequestId: string;
    },
    options?: Readonly<{ requestDeadlineAt?: Date }>,
  ): Promise<ConversationRetryTurn>;
  submit(
    userId: UserId,
    input: {
      clientEventId: string;
      clientTurnId: string;
      locale: string;
      text: string;
      timezone: string;
    },
    options?: Readonly<{ requestDeadlineAt?: Date }>,
  ): Promise<UserTextTurn>;
}>;

export class InvalidUserTextTurnError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidUserTextTurnError";
  }
}

export class UserTextPrivateWriteDeniedError extends Error {
  public constructor(
    public readonly reason: Exclude<
      PrivateWriteGateReason,
      "backup_evidence_current"
    >,
  ) {
    super(`Private User Text writes are blocked: ${reason}.`);
    this.name = "UserTextPrivateWriteDeniedError";
  }
}

export class UserTextOwnerDeniedError extends Error {
  public constructor() {
    super("The authenticated principal is not the active Internal Owner.");
    this.name = "UserTextOwnerDeniedError";
  }
}

export class UserTextIdempotencyConflictError extends Error {
  public constructor() {
    super("The client Turn and Event idempotency keys identify different Turns.");
    this.name = "UserTextIdempotencyConflictError";
  }
}

export class ConversationRetryNotAllowedError extends Error {
  public constructor() {
    super("Only an interrupted InteractionTurn can be retried.");
    this.name = "ConversationRetryNotAllowedError";
  }
}

export class ContinuousExchangeNotFoundError extends Error {
  public constructor() {
    super("The active Continuous Exchange was not found.");
    this.name = "ContinuousExchangeNotFoundError";
  }
}

export function createUserTextConversationService(dependencies: {
  clock: () => Date;
  expectedBackupPolicyVersion: string;
  expectedConfigurationFingerprint: string;
  /** Fast-path extraction policy version; omitted / null keeps the switch off. */
  fastPathExtractionPolicyVersion?: string | null;
  generationPolicy: GenerationPolicy;
  inactivityPolicy?: InactivityPolicy;
  recoveryGate?: RecoveryGate;
  repository: UserTextConversationRepository;
}): UserTextConversationService {
  const inactivityPolicy =
    dependencies.inactivityPolicy ??
    Object.freeze({
      timeoutMs: 30 * 60 * 1_000,
      version: "continuous-exchange-inactivity:v1",
    });
  const fastPathExtractionPolicyVersion =
    dependencies.fastPathExtractionPolicyVersion ?? null;
  return {
    async correct(userId, rawInput) {
      await dependencies.recoveryGate?.requireOpen(userId);
      let eventId: ConversationEventId;
      try { eventId = asConversationEventId(rawInput.eventId); } catch { throw new InvalidUserTextTurnError("eventId must be an opaque Conversation Event UUIDv7."); }
      const text = rawInput.text?.trim();
      if (!text) throw new InvalidUserTextTurnError("text must contain a corrected User expression.");
      let locale: string;
      try { locale = new Intl.Locale(rawInput.locale).toString(); } catch { throw new InvalidUserTextTurnError("locale must be a valid BCP-47 tag."); }
      if (!dependencies.repository.correctUserEvent) throw new InvalidUserTextTurnError("User Evidence correction is unavailable.");
      const corrected = await dependencies.repository.correctUserEvent({ eventId, locale, now: dependencies.clock(), text, userId, fastPathExtractionPolicyVersion });
      if (!corrected) throw new InvalidUserTextTurnError("The User Event cannot be corrected.");
      return corrected;
    },
    async endContinuousExchange(userId, rawInput) {
      await dependencies.recoveryGate?.requireOpen(userId);
      let dailySessionId: DailySessionId;
      try {
        dailySessionId = asDailySessionId(rawInput.dailySessionId);
      } catch {
        throw new InvalidUserTextTurnError(
          "dailySessionId must be an opaque Daily Session UUIDv7.",
        );
      }
      const result =
        await dependencies.repository.endContinuousExchangeExplicitly({
          dailySessionId,
          endedAt: dependencies.clock(),
          userId,
        });
      if (result.outcome === "not_found") {
        throw new ContinuousExchangeNotFoundError();
      }
      return result.end;
    },
    async listInterruptedResponses(userId) {
      await dependencies.recoveryGate?.requireOpen(userId);
      return dependencies.repository.listInterruptedResponses(userId);
    },
    async listInterruptedResponsesForSession(userId, rawDailySessionId) {
      await dependencies.recoveryGate?.requireOpen(userId);
      const dailySessionId = validateDailySessionId(rawDailySessionId);
      return dependencies.repository.listInterruptedResponsesForSession({
        dailySessionId,
        userId,
      });
    },
    async listMessages(userId) {
      await dependencies.recoveryGate?.requireOpen(userId);
      return dependencies.repository.listUserTextMessages(userId);
    },
    async listConversationDates(userId, input) {
      await dependencies.recoveryGate?.requireOpen(userId);
      const cursor = decodeConversationCursor(input.cursor);
      if (input.cursor !== null && cursor === null) {
        throw new InvalidConversationCursorError();
      }
      if (cursor !== null) {
        if (cursor.kind !== "conversation-dates" || cursor.owner !== userId) {
          throw new InvalidConversationCursorError();
        }
      }
      const result = await dependencies.repository.listConversationDates({
        beforeDailySessionId:
          cursor !== null && cursor.kind === "conversation-dates"
            ? cursor.beforeDailySessionId
            : null,
        beforeLogicalDate:
          cursor !== null && cursor.kind === "conversation-dates"
            ? cursor.beforeLogicalDate
            : null,
        limit: CONVERSATION_DATE_PAGE_LIMIT,
        userId,
      });
      const last = result.entries.at(-1);
      return {
        entries: result.entries,
        nextCursor:
          result.hasMore && last !== undefined
            ? encodeConversationCursor({
                beforeDailySessionId: last.dailySessionId,
                beforeLogicalDate: last.logicalDate,
                kind: "conversation-dates",
                owner: userId,
                version: 1,
              })
            : null,
      };
    },
    async listOlderMessages(userId, input) {
      await dependencies.recoveryGate?.requireOpen(userId);
      const dailySessionId = validateDailySessionId(input.dailySessionId);
      const cursor = decodeConversationCursor(input.cursor ?? null);
      if ((input.cursor ?? null) !== null && cursor === null) {
        throw new InvalidConversationCursorError();
      }
      let beforeSequence: number;
      if (cursor !== null) {
        if (
          cursor.kind !== "conversation-messages" ||
          cursor.owner !== userId ||
          cursor.dailySessionId !== dailySessionId
        ) {
          throw new InvalidConversationCursorError();
        }
        beforeSequence = cursor.beforeSequence;
      } else if (
        typeof input.beforeSequence === "number" &&
        Number.isInteger(input.beforeSequence) &&
        input.beforeSequence > 0
      ) {
        beforeSequence = input.beforeSequence;
      } else {
        throw new InvalidConversationCursorError();
      }
      const session = await dependencies.repository.findConversationSessionById({
        dailySessionId,
        userId,
      });
      if (session === null) {
        throw new ConversationSessionNotFoundError();
      }
      const result = await dependencies.repository.listOlderUserTextMessages({
        beforeSequence,
        dailySessionId,
        limit: OLDER_CONVERSATION_MESSAGE_LIMIT,
        userId,
      });
      const oldest = result.messages[0];
      return {
        messages: result.messages,
        nextCursor:
          result.hasMore && oldest !== undefined
            ? encodeConversationCursor({
                beforeSequence: oldest.sequence,
                dailySessionId,
                kind: "conversation-messages",
                owner: userId,
                version: 1,
              })
            : null,
      };
    },
    async listRecentMessages(userId, rawInput) {
      await dependencies.recoveryGate?.requireOpen(userId);
      const dailySessionId = validateDailySessionId(rawInput.dailySessionId);
      return dependencies.repository.listRecentUserTextMessages({
        dailySessionId,
        limit: RECENT_CONVERSATION_MESSAGE_LIMIT,
        userId,
      });
    },
    async readConversationByDate(userId, logicalDate) {
      await dependencies.recoveryGate?.requireOpen(userId);
      if (!isLogicalDate(logicalDate)) {
        return null;
      }
      return dependencies.repository.findConversationSessionByDate({
        logicalDate,
        userId,
      });
    },
    async readCurrentConversation(userId) {
      await dependencies.recoveryGate?.requireOpen(userId);
      return dependencies.repository.findCurrentWritableConversation(userId);
    },
    async retry(userId, rawInput, options) {
      await dependencies.recoveryGate?.requireOpen(userId);
      let originalTurnId: InteractionTurnId;
      try {
        originalTurnId = asInteractionTurnId(rawInput.originalTurnId);
      } catch {
        throw new InvalidUserTextTurnError(
          "originalTurnId must be an opaque InteractionTurn UUIDv7.",
        );
      }
      const retryRequestId = validateKey<RetryRequestId>(
        rawInput.retryRequestId,
        "retryRequestId",
      );
      const result = await dependencies.repository.recordConversationRetry({
        expectedBackupPolicyVersion: dependencies.expectedBackupPolicyVersion,
        expectedConfigurationFingerprint:
          dependencies.expectedConfigurationFingerprint,
        generationPolicy: dependencies.generationPolicy,
        inactivityPolicy,
        now: dependencies.clock(),
        originalTurnId,
        ...(options?.requestDeadlineAt
          ? { requestDeadlineAt: options.requestDeadlineAt }
          : {}),
        retryRequestId,
        userId,
      });
      if (result.outcome === "owner_denied") {
        throw new UserTextOwnerDeniedError();
      }
      if (result.outcome === "idempotency_conflict") {
        throw new UserTextIdempotencyConflictError();
      }
      if (result.outcome === "retry_not_allowed") {
        throw new ConversationRetryNotAllowedError();
      }
      if (result.outcome === "write_denied") {
        throw new UserTextPrivateWriteDeniedError(result.reason);
      }
      return result.retry;
    },
    async submit(userId, rawInput, options) {
      await dependencies.recoveryGate?.requireOpen(userId);
      const input = validateUserTextInput(rawInput);
      const now = dependencies.clock();
      const result = await dependencies.repository.recordUserTextTurn({
        ...input,
        expectedBackupPolicyVersion: dependencies.expectedBackupPolicyVersion,
        expectedConfigurationFingerprint:
          dependencies.expectedConfigurationFingerprint,
        fastPathExtractionPolicyVersion,
        generationPolicy: dependencies.generationPolicy,
        inactivityPolicy,
        logicalDate: localDateAt(now, input.timezone),
        now,
        ...(options?.requestDeadlineAt
          ? { requestDeadlineAt: options.requestDeadlineAt }
          : {}),
        userId,
      });

      if (result.outcome === "owner_denied") {
        throw new UserTextOwnerDeniedError();
      }
      if (result.outcome === "idempotency_conflict") {
        throw new UserTextIdempotencyConflictError();
      }
      if (result.outcome === "write_denied") {
        throw new UserTextPrivateWriteDeniedError(result.reason);
      }
      return result.turn;
    },
  };
}

function validateUserTextInput(input: {
  clientEventId: string;
  clientTurnId: string;
  locale: string;
  text: string;
  timezone: string;
}): ValidatedUserTextInput {
  const clientEventId = validateKey<ClientEventId>(
    input.clientEventId,
    "clientEventId",
  );
  const clientTurnId = validateKey<ClientTurnId>(
    input.clientTurnId,
    "clientTurnId",
  );
  if (typeof input.text !== "string" || input.text.trim().length === 0) {
    throw new InvalidUserTextTurnError("text must contain a User expression.");
  }
  if (input.text.length > 100_000) {
    throw new InvalidUserTextTurnError("text exceeds the supported length.");
  }

  let locale: string;
  try {
    locale = new Intl.Locale(input.locale).toString();
  } catch {
    throw new InvalidUserTextTurnError("locale must be a valid BCP-47 tag.");
  }
  if (
    typeof input.timezone !== "string" ||
    input.timezone.length === 0 ||
    input.timezone.length > 100
  ) {
    throw new InvalidUserTextTurnError(
      "timezone must be a valid IANA timezone.",
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format(
      new Date(0),
    );
  } catch {
    throw new InvalidUserTextTurnError(
      "timezone must be a valid IANA timezone.",
    );
  }

  return {
    clientEventId,
    clientTurnId,
    locale,
    text: input.text,
    timezone: input.timezone,
  };
}

function validateDailySessionId(value: string): DailySessionId {
  try {
    return asDailySessionId(value);
  } catch {
    throw new InvalidUserTextTurnError(
      "dailySessionId must be an opaque Daily Session UUIDv7.",
    );
  }
}

function validateKey<Key extends string>(value: string, name: string): Key {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 200
  ) {
    throw new InvalidUserTextTurnError(
      `${name} must be a non-empty stable key of at most 200 characters.`,
    );
  }
  return value as Key;
}

/** The owner's local logical date (YYYY-MM-DD) at `now` under `timezone`. */
export function localDateAt(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isLogicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

type ConversationDateCursor = Readonly<{
  beforeDailySessionId: DailySessionId;
  beforeLogicalDate: string;
  kind: "conversation-dates";
  owner: UserId;
  version: 1;
}>;

type ConversationMessageCursor = Readonly<{
  beforeSequence: number;
  dailySessionId: DailySessionId;
  kind: "conversation-messages";
  owner: UserId;
  version: 1;
}>;

type ConversationCursor = ConversationDateCursor | ConversationMessageCursor;

/**
 * Cursors are opaque to the client. They are bound to the authenticated owner
 * and to the exact query (date list vs. one Daily Session's messages), so a
 * forged or cross-query token fails validation instead of silently paginating.
 */
function encodeConversationCursor(cursor: ConversationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeConversationCursor(token: string | null): ConversationCursor | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || typeof record.owner !== "string") {
    return null;
  }
  if (record.kind === "conversation-dates") {
    if (
      typeof record.beforeLogicalDate !== "string" ||
      !isLogicalDate(record.beforeLogicalDate) ||
      typeof record.beforeDailySessionId !== "string"
    ) {
      return null;
    }
    try {
      return {
        beforeDailySessionId: asDailySessionId(record.beforeDailySessionId),
        beforeLogicalDate: record.beforeLogicalDate,
        kind: "conversation-dates",
        owner: record.owner as UserId,
        version: 1,
      };
    } catch {
      return null;
    }
  }
  if (record.kind === "conversation-messages") {
    if (
      typeof record.beforeSequence !== "number" ||
      !Number.isInteger(record.beforeSequence) ||
      record.beforeSequence <= 0 ||
      typeof record.dailySessionId !== "string"
    ) {
      return null;
    }
    try {
      return {
        beforeSequence: record.beforeSequence,
        dailySessionId: asDailySessionId(record.dailySessionId),
        kind: "conversation-messages",
        owner: record.owner as UserId,
        version: 1,
      };
    } catch {
      return null;
    }
  }
  return null;
}
