declare const userIdBrand: unique symbol;
declare const dailySessionIdBrand: unique symbol;
declare const interactionTurnIdBrand: unique symbol;
declare const conversationEventIdBrand: unique symbol;
declare const conversationEventRevisionIdBrand: unique symbol;
declare const generationCommandIdBrand: unique symbol;
declare const modelRunAttemptIdBrand: unique symbol;
declare const compiledContextIdBrand: unique symbol;
declare const inactivityEvaluationIdBrand: unique symbol;

export type UserId = string & { readonly [userIdBrand]: "UserId" };
export type DailySessionId = string & {
  readonly [dailySessionIdBrand]: "DailySessionId";
};
export type InteractionTurnId = string & {
  readonly [interactionTurnIdBrand]: "InteractionTurnId";
};
export type ConversationEventId = string & {
  readonly [conversationEventIdBrand]: "ConversationEventId";
};
export type ConversationEventRevisionId = string & {
  readonly [conversationEventRevisionIdBrand]: "ConversationEventRevisionId";
};
export type GenerationCommandId = string & {
  readonly [generationCommandIdBrand]: "GenerationCommandId";
};
export type ModelRunAttemptId = string & {
  readonly [modelRunAttemptIdBrand]: "ModelRunAttemptId";
};
export type CompiledContextId = string & {
  readonly [compiledContextIdBrand]: "CompiledContextId";
};
export type InactivityEvaluationId = string & {
  readonly [inactivityEvaluationIdBrand]: "InactivityEvaluationId";
};

const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function asUserId(value: string): UserId {
  return asOpaqueUuidV7(value, "UserId") as UserId;
}

export function asDailySessionId(value: string): DailySessionId {
  return asOpaqueUuidV7(value, "DailySessionId") as DailySessionId;
}

export function asInteractionTurnId(value: string): InteractionTurnId {
  return asOpaqueUuidV7(value, "InteractionTurnId") as InteractionTurnId;
}

export function asConversationEventId(value: string): ConversationEventId {
  return asOpaqueUuidV7(value, "ConversationEventId") as ConversationEventId;
}

export function asConversationEventRevisionId(
  value: string,
): ConversationEventRevisionId {
  return asOpaqueUuidV7(
    value,
    "ConversationEventRevisionId",
  ) as ConversationEventRevisionId;
}

export function asGenerationCommandId(value: string): GenerationCommandId {
  return asOpaqueUuidV7(value, "GenerationCommandId") as GenerationCommandId;
}

export function asModelRunAttemptId(value: string): ModelRunAttemptId {
  return asOpaqueUuidV7(value, "ModelRunAttemptId") as ModelRunAttemptId;
}

export function asCompiledContextId(value: string): CompiledContextId {
  return asOpaqueUuidV7(value, "CompiledContextId") as CompiledContextId;
}

export function asInactivityEvaluationId(
  value: string,
): InactivityEvaluationId {
  return asOpaqueUuidV7(
    value,
    "InactivityEvaluationId",
  ) as InactivityEvaluationId;
}

function asOpaqueUuidV7(value: string, typeName: string): string {
  if (!uuidV7Pattern.test(value)) {
    throw new Error(`${typeName} must be an opaque UUIDv7.`);
  }
  return value;
}
