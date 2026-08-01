import {
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
  generationPolicy: GenerationPolicy;
  inactivityPolicy: InactivityPolicy;
  locale: string;
  logicalDate: string;
  now: Date;
  text: string;
  timezone: string;
  userId: UserId;
}>;

export type RecordConversationRetryInput = Readonly<{
  expectedBackupPolicyVersion: string;
  expectedConfigurationFingerprint: string;
  generationPolicy: GenerationPolicy;
  inactivityPolicy: InactivityPolicy;
  now: Date;
  originalTurnId: InteractionTurnId;
  retryRequestId: RetryRequestId;
  userId: UserId;
}>;

export type GenerationPolicy = Readonly<{
  consentPolicyVersion: string | null;
  freshnessPolicy: "source_valid:v1";
  chineseLocalePackVersion: string;
  englishLocalePackVersion: string;
  model: string;
  modelConfigVersion: string;
  modelSnapshot: string;
  outputFormatVersion: string;
  personaVersion: string;
  providerPolicyVersion: string;
  productPolicyVersion: string;
  promptVersion: string;
  provider: "openai";
  relationshipPolicyVersion: string;
  safetyPolicyVersion: string;
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
  eventId: ConversationEventId;
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
  listInterruptedResponses(
    userId: UserId,
  ): Promise<readonly InterruptedConversationResponse[]>;
  listUserTextMessages(userId: UserId): Promise<readonly UserTextMessage[]>;
  recordConversationRetry(
    input: RecordConversationRetryInput,
  ): Promise<RecordConversationRetryRepositoryResult>;
  recordUserTextTurn(
    input: RecordUserTextTurnInput,
  ): Promise<RecordUserTextTurnRepositoryResult>;
}>;

export type UserTextConversationService = Readonly<{
  endContinuousExchange(
    userId: UserId,
    input: { dailySessionId: string },
  ): Promise<ExplicitContinuousExchangeEnd>;
  listInterruptedResponses(
    userId: UserId,
  ): Promise<readonly InterruptedConversationResponse[]>;
  listMessages(userId: UserId): Promise<readonly UserTextMessage[]>;
  retry(
    userId: UserId,
    input: {
      originalTurnId: string;
      retryRequestId: string;
    },
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
  generationPolicy: GenerationPolicy;
  inactivityPolicy?: InactivityPolicy;
  repository: UserTextConversationRepository;
}): UserTextConversationService {
  const inactivityPolicy =
    dependencies.inactivityPolicy ??
    Object.freeze({
      timeoutMs: 30 * 60 * 1_000,
      version: "continuous-exchange-inactivity:v1",
    });
  return {
    async endContinuousExchange(userId, rawInput) {
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
      return dependencies.repository.listInterruptedResponses(userId);
    },
    async listMessages(userId) {
      return dependencies.repository.listUserTextMessages(userId);
    },
    async retry(userId, rawInput) {
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
    async submit(userId, rawInput) {
      const input = validateUserTextInput(rawInput);
      const now = dependencies.clock();
      const result = await dependencies.repository.recordUserTextTurn({
        ...input,
        expectedBackupPolicyVersion: dependencies.expectedBackupPolicyVersion,
        expectedConfigurationFingerprint:
          dependencies.expectedConfigurationFingerprint,
        generationPolicy: dependencies.generationPolicy,
        inactivityPolicy,
        logicalDate: localDateAt(now, input.timezone),
        now,
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

function localDateAt(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
