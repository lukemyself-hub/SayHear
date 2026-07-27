import type {
  ConversationEventId,
  ConversationEventRevisionId,
  DailySessionId,
  InteractionTurnId,
  PrivateWriteGateReason,
  UserId,
} from "@sayhear/domain";

declare const clientEventIdBrand: unique symbol;
declare const clientTurnIdBrand: unique symbol;

export type ClientEventId = string & {
  readonly [clientEventIdBrand]: "ClientEventId";
};
export type ClientTurnId = string & {
  readonly [clientTurnIdBrand]: "ClientTurnId";
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
  locale: string;
  logicalDate: string;
  now: Date;
  text: string;
  timezone: string;
  userId: UserId;
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
  replayed: boolean;
  turn: Readonly<{
    id: InteractionTurnId;
    sequence: number;
    status: InteractionTurnStatus;
  }>;
}>;

export type UserTextMessage = Readonly<{
  eventId: ConversationEventId;
  locale: string;
  revisionId: ConversationEventRevisionId;
  sequence: number;
  text: string;
}>;

export type RecordUserTextTurnRepositoryResult =
  | Readonly<{ outcome: "recorded"; turn: UserTextTurn }>
  | Readonly<{ outcome: "idempotency_conflict" }>
  | Readonly<{ outcome: "owner_denied" }>
  | Readonly<{
      outcome: "write_denied";
      reason: Exclude<PrivateWriteGateReason, "backup_evidence_current">;
    }>;

export type UserTextConversationRepository = Readonly<{
  listUserTextMessages(userId: UserId): Promise<readonly UserTextMessage[]>;
  recordUserTextTurn(
    input: RecordUserTextTurnInput,
  ): Promise<RecordUserTextTurnRepositoryResult>;
}>;

export type UserTextConversationService = Readonly<{
  listMessages(userId: UserId): Promise<readonly UserTextMessage[]>;
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

export function createUserTextConversationService(dependencies: {
  clock: () => Date;
  expectedBackupPolicyVersion: string;
  expectedConfigurationFingerprint: string;
  repository: UserTextConversationRepository;
}): UserTextConversationService {
  return {
    async listMessages(userId) {
      return dependencies.repository.listUserTextMessages(userId);
    },
    async submit(userId, rawInput) {
      const input = validateUserTextInput(rawInput);
      const now = dependencies.clock();
      const result = await dependencies.repository.recordUserTextTurn({
        ...input,
        expectedBackupPolicyVersion: dependencies.expectedBackupPolicyVersion,
        expectedConfigurationFingerprint:
          dependencies.expectedConfigurationFingerprint,
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
