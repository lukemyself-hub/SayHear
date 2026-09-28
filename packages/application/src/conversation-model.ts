import type {
  CompiledContextId,
  ConversationEventRevisionId,
  GenerationCommandId,
  ModelRunAttemptId,
  UserId,
} from "@sayhear/domain";

import type { CompiledContextRenderSource } from "./context-compiler";
import type {
  ConversationActionDefinition,
  ConversationActionProposal,
  ConversationFunctionDefinition,
} from "./conversation-action-catalog";
import type { CuriosityStopSignalProposal } from "./curiosity-stop-signal";

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
  functions?: readonly ConversationFunctionDefinition[];
  instructions: string;
  locale: string;
  messages: readonly ConversationTextMessage[];
  model: string;
  /** Provider request parameters frozen by the owning release configuration. */
  parameters?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
  toolsDisabled?: boolean;
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
      /**
       * Present only when the Provider reports a reasoning split, which
       * keeps adapters that have no such concept from fabricating a zero.
       */
      reasoningTokens?: number | null;
      type: "completed";
    }>
  | Readonly<{
      rawArguments: string;
      rawFunctionName: string;
      type: "tool_call";
    }>;

export type ConversationTextModel = Readonly<{
  stream(
    input: ConversationTextModelRequest,
  ): AsyncIterable<ConversationTextModelStreamEvent>;
}>;

export type ProviderEgressStreamEvent =
  | Exclude<ConversationTextModelStreamEvent, { type: "tool_call" }>
  | Readonly<{
      rawArguments: string;
      rawFunctionName: string;
      type: "tool_call";
    }>
  | Readonly<{
      proposal: ConversationActionProposal;
      type: "action_proposal";
    }>
  | Readonly<{
      proposals: readonly CuriosityStopSignalProposal[];
      type: "stop_signal_proposal";
    }>;

export type ProviderEgressPort = Readonly<{
  stream(input: {
    compiledContextId: CompiledContextId;
    /**
     * The complete model-facing Function set this Decision offers, owned by
     * the Harness (Catalog Functions plus the deterministic behavior-proposal
     * channels such as the curiosity stop signal).
     */
    functions?: readonly ConversationFunctionDefinition[];
    /**
     * The Catalog Definitions eligible for this Decision (ADR-0095); the
     * normalization space for any Catalog Action selection. Offered Functions
     * and accepted Definitions derive from the same frozen Decision inputs,
     * but only Definitions gate acceptance.
     */
    definitions?: readonly ConversationActionDefinition[];
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    userId: UserId;
    requestEventRevisionId?: ConversationEventRevisionId;
    signal?: AbortSignal;
    toolsDisabled?: boolean;
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

/**
 * Content-free token accounting for one Provider call. Counts only, never
 * request or response text, so it is safe to keep in release evidence and in
 * logs produced on private data.
 *
 * `reasoningTokens` is `null` when the Provider reported no reasoning split,
 * which is not the same as zero. Issue #252 exists because this number
 * separates a budget spent on reasoning from a budget spent on a truncated
 * answer, and because a successful call's spend is the only evidence that a
 * new budget actually has headroom.
 */
export type ModelRoleCallUsage = Readonly<{
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}>;

/**
 * Content-free reason a Provider response could not be turned into a typed
 * model output (issue #252). `invalid_response` on its own cannot separate an
 * exhausted output budget from an empty final answer, an unparseable body, or
 * a well-formed body that violates the frozen output schema, and each cause
 * needs a different remedy: a larger versioned budget, a shorter prompt, a
 * stricter schema, or a provider fix.
 *
 * Carries the same usage record as a successful call so one artifact shape
 * describes every attempt, whether or not it produced an answer.
 */
export type ProviderResponseFailure = ModelRoleCallUsage &
  Readonly<{
    kind:
      | "output_budget_exhausted"
      | "empty_output"
      | "parse_failed"
      | "schema_mismatch";
    /** Characters of final visible output. A count, never the text itself. */
    outputLength: number;
    /**
     * Set only when the Provider itself reported the truncation, which is what
     * separates a proven budget exhaustion from an inferred one. A literal
     * union, not a free string, so no Provider-supplied text can reach release
     * evidence through this field.
     */
    providerReason: "max_output_tokens" | null;
  }>;

export class ProviderDispatchError extends Error {
  public constructor(
    public readonly category: ProviderDispatchErrorCategory,
    message = "The configured Conversation Text Provider failed.",
    public readonly settlesAttempt = true,
    /** Present only when the failure was proven to a specific response cause. */
    public readonly failure?: ProviderResponseFailure,
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
