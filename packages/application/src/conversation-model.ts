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
import type { HistoryQueryProposal } from "./history-recall";

/**
 * The Provider identity recorded on a Conversation Text Champion and frozen on
 * each GenerationCommand. It is a lineage / audit label (whose account, policy
 * version, and bloodline this generation belongs to), not a transport selector —
 * Providers that share a wire-compatible Responses API are configurations of one
 * protocol client. ADR-0102 widened this from the single 1A.1 Provider ("openai").
 * ADR-0147 adds `opencode-go`, which is an honest Provider identity of its own:
 * it is reached through the OpenCode Go Chat Completions transport, not the
 * Responses API, so a Champion cannot silently relabel a Go lineage as DeepSeek.
 */
export type ConversationTextProvider = "openai" | "deepseek" | "opencode-go";

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
  /**
   * Optional per-call content-free accounting. An adapter invokes it at most
   * once with the normalized Provider usage when the Provider reported any, on
   * a normal terminal or on a terminal failure (including a late protocol,
   * EOF, or abort failure after usage was seen). It never carries request or
   * response text, and a call with no observed usage does not invoke it — an
   * absent invocation is never a fabricated zero.
   */
  onUsage?: (usage: ModelRoleCallUsage) => void;
  /** Provider request parameters frozen by the owning release configuration. */
  parameters?: Readonly<Record<string, unknown>>;
  /**
   * Opaque, caller-owned session identity for Providers that require a stable
   * session header. Callers pass a hashed logical conversation / task identity,
   * never raw user data. Adapters that have no such concept ignore it.
   */
  providerSessionId?: string;
  signal?: AbortSignal;
  toolsDisabled?: boolean;
}>;

export type ConversationTextModelStreamEvent =
  | Readonly<{ delta: string; type: "delta" }>
  | Readonly<{
      costMicros: number | null;
      finishReason: string;
      /**
       * Present only when the Provider reports cached input tokens, so an
       * adapter without the concept never fabricates a zero.
       */
      cachedTokens?: number | null;
      inputTokens: number | null;
      modelSnapshot: string;
      outputTokens: number | null;
      providerRequestId: string | null;
      /**
       * Present only when the Provider reports a reasoning split, which
       * keeps adapters that have no such concept from fabricating a zero.
       */
      reasoningTokens?: number | null;
      /**
       * Present only when the Provider reports a total that includes the
       * reasoning spend; absent stays unknown rather than being summed.
       */
      totalTokens?: number | null;
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
    }>
  | Readonly<{
      proposal: HistoryQueryProposal;
      type: "history_query_proposal";
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
  /**
   * Provider-reported cached input tokens (`input_tokens_details.cached_tokens`).
   * Absent/unknown is `null`, never an invented zero or a derived sum.
   */
  cachedTokens: number | null;
  /**
   * Provider-reported `total_tokens`, which already includes reasoning. It is
   * reported as-is and never recomputed from the other counters.
   */
  totalTokens: number | null;
}>;

/**
 * Normalize a Provider usage record to content-free safe integers. Every
 * counter is finite, non-negative, and a safe integer or it becomes `null`
 * (unknown). This is the single place a token count can enter the durable
 * ledger, so no NaN/Infinity/fractional/negative value can be stored as a
 * `0` or a fabricated total.
 */
export function normalizeModelRoleCallUsage(
  usage: ModelRoleCallUsage | null | undefined,
): ModelRoleCallUsage | null {
  if (!usage) return null;
  return {
    cachedTokens: normalizeTokenCount(usage.cachedTokens),
    inputTokens: normalizeTokenCount(usage.inputTokens),
    outputTokens: normalizeTokenCount(usage.outputTokens),
    reasoningTokens: normalizeTokenCount(usage.reasoningTokens),
    totalTokens: normalizeTokenCount(usage.totalTokens),
  };
}

function normalizeTokenCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

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
     * evidence through this field. Responses APIs report `max_output_tokens`;
     * Chat Completions reports the equivalent `length` finish reason.
     */
    providerReason: "max_output_tokens" | "length" | null;
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
      /**
       * The Daily Session this conversation command belongs to, read from the
       * existing `interaction_turns.daily_session_id` join. It is the trusted
       * logical scope for an opaque transport session identity (ADR-0147) and
       * is never persisted as a new column or sent to the Provider as payload.
       */
      dailySessionId?: string;
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
  /**
   * Records the spend a Provider reported for a call that did NOT complete
   * normally (cut off, timed out, aborted, fenced). The Provider billed it
   * either way, so the ledger keeps it (issue #319). Unknown counters stay
   * unknown; nothing here ever writes a zero the Provider did not report.
   */
  recordProviderUsage?(input: {
    modelRunAttemptId: ModelRunAttemptId;
    now: Date;
    usage: ModelRoleCallUsage;
  }): Promise<void>;
}>;
