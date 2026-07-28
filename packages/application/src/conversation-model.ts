import type {
  CompiledContextId,
  ConversationEventRevisionId,
  GenerationCommandId,
  ModelRunAttemptId,
} from "@sayhear/domain";

export type ConversationTextChampion = Readonly<{
  configVersion: string;
  contextLimit: number;
  dataRegion: string;
  model: string;
  provider: "openai";
  retentionMode: string;
  snapshot: string;
  streaming: true;
  supportedLocales: readonly string[];
  trainingPolicy: string;
}>;

export type ConversationTextMessage = Readonly<{
  revisionId: ConversationEventRevisionId;
  role: "user" | "assistant";
  text: string;
}>;

export type ConversationTextModelRequest = Readonly<{
  instructions: string;
  messages: readonly ConversationTextMessage[];
  model: string;
  signal?: AbortSignal;
}>;

export type ConversationTextModelStreamEvent =
  | Readonly<{ delta: string; type: "delta" }>
  | Readonly<{
      costMicros: number | null;
      finishReason: string;
      inputTokens: number | null;
      modelSnapshot: string;
      outputTokens: number | null;
      providerRequestId: string | null;
      type: "completed";
    }>;

export type ConversationTextModel = Readonly<{
  stream(
    input: ConversationTextModelRequest,
  ): AsyncIterable<ConversationTextModelStreamEvent>;
}>;

export type ProviderEgressStreamEvent = ConversationTextModelStreamEvent;

export type ProviderEgressPort = Readonly<{
  stream(input: {
    compiledContextId: CompiledContextId;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    signal?: AbortSignal;
  }): AsyncIterable<ProviderEgressStreamEvent>;
}>;

export type ProviderDispatchErrorCategory =
  | "aborted"
  | "authentication"
  | "invalid_response"
  | "policy_blocked"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "unknown";

export class ProviderDispatchError extends Error {
  public constructor(
    public readonly category: ProviderDispatchErrorCategory,
    message = "The configured Conversation Text Provider failed.",
    public readonly settlesAttempt = true,
  ) {
    super(message);
    this.name = "ProviderDispatchError";
  }
}

export type ProviderEgressClaim =
  | Readonly<{
      locale: string;
      localePolicyVersion: string;
      messages: readonly ConversationTextMessage[];
      model: string;
      outcome: "permitted";
      productPolicyVersion: string;
      promptVersion: string;
      relationshipPolicyVersion: string;
      safetyPolicyVersion: string;
    }>
  | Readonly<{
      category: ProviderDispatchErrorCategory;
      outcome: "blocked";
    }>
  | Readonly<{
      outcome: "already_claimed";
    }>;

export type ProviderEgressRepository = Readonly<{
  claimDispatch(input: {
    champion: ConversationTextChampion;
    compiledContextId: CompiledContextId;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    now: Date;
  }): Promise<ProviderEgressClaim>;
  recordFirstToken(input: {
    modelRunAttemptId: ModelRunAttemptId;
    now: Date;
  }): Promise<void>;
}>;
