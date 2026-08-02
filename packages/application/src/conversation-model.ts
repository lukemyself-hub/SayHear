import type {
  CompiledContextId,
  ConversationEventRevisionId,
  GenerationCommandId,
  ModelRunAttemptId,
} from "@sayhear/domain";

import type { CompiledContextRenderSource } from "./context-compiler";

/**
 * The Provider identity recorded on a Conversation Text Champion and frozen on
 * each GenerationCommand. It is a lineage / audit label (whose account, policy
 * version, and bloodline this generation belongs to), not a transport selector —
 * Providers that share a wire-compatible Responses API are configurations of one
 * protocol client. ADR-0102 widened this from the single 1A.1 Provider ("openai").
 */
export type ConversationTextProvider = "openai" | "deepseek";

export type ConversationTextChampion = Readonly<{
  configVersion: string;
  consentPolicyVersion: string | null;
  contextLimit: number;
  dataRegion: string;
  model: string;
  provider: ConversationTextProvider;
  providerPolicyVersion: string;
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
  locale: string;
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
  | "configuration"
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
      context: CompiledContextRenderSource;
      model: string;
      outcome: "permitted";
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
  }): Promise<boolean>;
  recordProviderCompletion(input: {
    completion: Extract<
      ConversationTextModelStreamEvent,
      { type: "completed" }
    >;
    modelRunAttemptId: ModelRunAttemptId;
    now: Date;
  }): Promise<boolean>;
}>;
