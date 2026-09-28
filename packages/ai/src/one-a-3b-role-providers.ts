import {
  asConversationEventRevisionId,
  ProviderDispatchError,
  type EpisodeProposal,
  type EpisodeBuildModelProvider,
  type ModelRoleConfigurationSnapshot,
  type NarrativeValidatorModelOutput,
  type NarrativeValidationModelProvider,
  type ProviderResponseFailure,
  type ReflectionGenerationModelOutput,
  type ReflectionGenerationModelProvider,
} from "@sayhear/application";

import { createResponsesApiConversationTextModel } from "./responses-api-conversation-text-model";
import { assertRuntimeProviderEgressIntegration } from "./runtime-provider-egress";

export type ResponsesApiAdapter = Readonly<{
  apiKey: string;
  baseUrl: string;
  provider: "openai" | "deepseek";
  timeoutMs: number;
}>;

export type OneA3bRuntimeRoleProviders = Readonly<{
  episodeBuildProvider: EpisodeBuildModelProvider;
  reflectionProvider: ReflectionGenerationModelProvider;
  narrativeValidationProvider: NarrativeValidationModelProvider;
}>;

const SYNTHETIC_REQUEST_REVISION_ID = asConversationEventRevisionId(
  "00000000-0000-7000-8000-000000000001",
);

const EPISODE_PHASES = new Set([
  "planned",
  "ongoing",
  "completed",
  "unknown",
]);
const EPISODE_BOUNDARY_PRECISIONS = new Set([
  "exact",
  "month",
  "year",
  "approximate",
  "unknown",
]);
const REFLECTION_STATEMENT_KINDS = new Set([
  "day_observation",
  "cross_day_theme",
  "change_observation",
]);
const REFLECTION_PROPOSITION_KINDS = new Set([
  "fact",
  "impression",
  "synthesis",
]);
const REFLECTION_EPISTEMIC_RENDERINGS = new Set(["confirmed", "inferred"]);
const REFLECTION_CANDIDATE_KINDS = new Set(["objective", "impression"]);
const REFLECTION_CANDIDATE_BASES = new Set(["directly_stated", "inferred"]);
const REFLECTION_TEMPORAL_STATUSES = new Set(["current", "ended", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isEpisodeBoundary(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.date === undefined || typeof value.date === "string") &&
    typeof value.precision === "string" &&
    EPISODE_BOUNDARY_PRECISIONS.has(value.precision)
  );
}

function isEpisodeProposal(value: unknown): value is EpisodeProposal {
  if (!isRecord(value)) return false;
  const temporalAnchor = value.temporalAnchor;
  const explicitContinuity = value.explicitContinuity;
  return (
    typeof value.proposedKind === "string" &&
    typeof value.label === "string" &&
    isRecord(temporalAnchor) &&
    isEpisodeBoundary(temporalAnchor.start) &&
    (temporalAnchor.end === undefined || isEpisodeBoundary(temporalAnchor.end)) &&
    typeof value.phase === "string" &&
    EPISODE_PHASES.has(value.phase) &&
    isStringRecord(value.kindFields) &&
    isStringArray(value.citedEvidenceItemIds) &&
    typeof value.realWorldOccurrence === "boolean" &&
    (value.entityAnchorIds === undefined || isStringArray(value.entityAnchorIds)) &&
    (explicitContinuity === undefined ||
      (isRecord(explicitContinuity) &&
        typeof explicitContinuity.evidenceItemId === "string" &&
        typeof explicitContinuity.span === "string")) &&
    (value.explicitNewOccurrence === undefined ||
      typeof value.explicitNewOccurrence === "boolean")
  );
}

function requiredConfiguration(
  configurations: readonly ModelRoleConfigurationSnapshot[],
  role: ModelRoleConfigurationSnapshot["role"],
): ModelRoleConfigurationSnapshot {
  const configuration = configurations.find((candidate) => candidate.role === role);
  if (!configuration) {
    throw new Error(`G1 runtime provider is missing configuration for ${role}.`);
  }
  return configuration;
}

function isResponsesApiProvider(
  value: string,
): value is ResponsesApiAdapter["provider"] {
  return value === "openai" || value === "deepseek";
}

function asObject(value: unknown, role: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProviderDispatchError(
      "invalid_response",
      `${role} returned an invalid JSON object.`,
    );
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, role: string): readonly unknown[] {
  if (!Array.isArray(value) || value.some((entry) => entry === null || typeof entry !== "object")) {
    throw new ProviderDispatchError(
      "invalid_response",
      `${role} returned an invalid JSON array.`,
    );
  }
  return value;
}

function asEpisodeProposals(value: unknown): readonly EpisodeProposal[] {
  const proposals = asArray(value, "episode.build");
  if (!proposals.every(isEpisodeProposal)) {
    throw new ProviderDispatchError(
      "invalid_response",
      "episode.build returned a proposal with an invalid schema.",
    );
  }
  return proposals as readonly EpisodeProposal[];
}

function isReflectionStatement(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.statementKey === "string" &&
    typeof value.text === "string" &&
    typeof value.statementKind === "string" &&
    REFLECTION_STATEMENT_KINDS.has(value.statementKind) &&
    Array.isArray(value.propositions) &&
    value.propositions.every(isReflectionProposition)
  );
}

function isReflectionProposition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.propositionKey === "string" &&
    typeof value.normalizedProposition === "string" &&
    typeof value.propositionKind === "string" &&
    REFLECTION_PROPOSITION_KINDS.has(value.propositionKind) &&
    typeof value.epistemicRendering === "string" &&
    REFLECTION_EPISTEMIC_RENDERINGS.has(value.epistemicRendering) &&
    isStringArray(value.supportEvidenceItemIds) &&
    isStringArray(value.baselineClaimIds)
  );
}

function isReflectionTemporal(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.temporalStatus === "string" &&
    REFLECTION_TEMPORAL_STATUSES.has(value.temporalStatus) &&
    (value.validFrom === null || typeof value.validFrom === "string") &&
    typeof value.validFromPrecision === "string" &&
    EPISODE_BOUNDARY_PRECISIONS.has(value.validFromPrecision) &&
    (value.validTo === null || typeof value.validTo === "string") &&
    typeof value.validToPrecision === "string" &&
    EPISODE_BOUNDARY_PRECISIONS.has(value.validToPrecision)
  );
}

function isReflectionCandidate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.candidateKind === "string" &&
    REFLECTION_CANDIDATE_KINDS.has(value.candidateKind) &&
    typeof value.basis === "string" &&
    REFLECTION_CANDIDATE_BASES.has(value.basis) &&
    (value.predicateId === null || typeof value.predicateId === "string") &&
    (value.proposedConcept === null || typeof value.proposedConcept === "string") &&
    (typeof value.typedValue === "string" || isStringArray(value.typedValue)) &&
    typeof value.scopeKey === "string" &&
    isReflectionTemporal(value.temporal) &&
    isStringArray(value.evidenceItemIds)
  );
}

function asReflectionOutput(
  value: unknown,
  role: string,
): ReflectionGenerationModelOutput {
  const parsed = asObject(value, role);
  if (
    !Array.isArray(parsed.statements) ||
    !parsed.statements.every(isReflectionStatement) ||
    !Array.isArray(parsed.candidateProposals) ||
    !parsed.candidateProposals.every(isReflectionCandidate)
  ) {
    throw new ProviderDispatchError(
      "invalid_response",
      `${role} returned an invalid output schema.`,
    );
  }
  return parsed as ReflectionGenerationModelOutput;
}

function isNarrativeProposition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.propositionKey === "string" &&
    typeof value.text === "string" &&
    typeof value.propositionKind === "string" &&
    REFLECTION_PROPOSITION_KINDS.has(value.propositionKind) &&
    typeof value.epistemicRendering === "string" &&
    REFLECTION_EPISTEMIC_RENDERINGS.has(value.epistemicRendering) &&
    isStringArray(value.supportKeys) &&
    typeof value.unsupported === "boolean" &&
    typeof value.contradicted === "boolean" &&
    typeof value.ambiguous === "boolean"
  );
}

function asNarrativeOutput(value: unknown): NarrativeValidatorModelOutput {
  const parsed = asObject(value, "narrative.validate");
  if (
    !Array.isArray(parsed.propositions) ||
    !parsed.propositions.every(isNarrativeProposition) ||
    !isStringArray(parsed.coverageKeys)
  ) {
    throw new ProviderDispatchError(
      "invalid_response",
      "narrative.validate returned an invalid output schema.",
    );
  }
  return parsed as NarrativeValidatorModelOutput;
}

function jsonInstructions(
  configuration: ModelRoleConfigurationSnapshot,
  instructions: string,
): string {
  return [
    `You are the SayHear ${configuration.role} role.`,
    `The pinned configuration version is ${configuration.configVersion}.`,
    `The pinned provider policy version is ${configuration.providerPolicyVersion}.`,
    `The pinned model snapshot is ${configuration.modelSnapshot}.`,
    `The pinned prompt version is ${configuration.promptVersion}.`,
    `The pinned output schema version is ${configuration.schemaVersion}.`,
    instructions,
    "Return JSON only. Do not include markdown, private diagnostics, tool calls, or commentary.",
  ].join(" ");
}

function createJsonCaller(adapter: ResponsesApiAdapter) {
  const model = createResponsesApiConversationTextModel({
    apiKey: adapter.apiKey,
    baseUrl: adapter.baseUrl,
    timeoutMs: adapter.timeoutMs,
  });

  return async function askJson(
    configuration: ModelRoleConfigurationSnapshot,
    payload: unknown,
    instructions: string,
    locale: string,
  ): Promise<{ parsed: unknown; usage: JsonCallUsage }> {
    let output = "";
    let modelSnapshot: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    for await (const event of model.stream({
      instructions: jsonInstructions(configuration, instructions),
      locale,
      messages: [
        {
          revisionId: SYNTHETIC_REQUEST_REVISION_ID,
          role: "user",
          text: JSON.stringify(payload),
        },
      ],
      model: configuration.model,
      parameters: configuration.parameterSnapshot,
      toolsDisabled: true,
    })) {
      if (event.type === "delta") output += event.delta;
      if (event.type === "completed") {
        modelSnapshot = event.modelSnapshot;
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
      }
    }
    if (modelSnapshot !== configuration.modelSnapshot) {
      throw new ProviderDispatchError(
        "invalid_response",
        `${configuration.role} returned model snapshot ${modelSnapshot ?? "<missing>"}, expected ${configuration.modelSnapshot}.`,
      );
    }
    const usage: JsonCallUsage = {
      inputTokens,
      outputLength: output.length,
      outputTokens,
    };
    if (output.length === 0) {
      throw untypedOutputError(configuration, usage);
    }
    try {
      return { parsed: JSON.parse(output), usage };
    } catch {
      const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(output);
      if (fenced) {
        try {
          return { parsed: JSON.parse(fenced[1] ?? ""), usage };
        } catch {
          // Fall through to one typed provider failure.
        }
      }
      throw untypedOutputError(configuration, usage);
    }
  };
}

/** Counts and lengths only; never the response text. */
type JsonCallUsage = Readonly<{
  inputTokens: number | null;
  outputLength: number;
  outputTokens: number | null;
}>;

/**
 * Issue #252: some Providers truncate at the frozen `max_output_tokens` cap
 * without reporting `max_output_tokens` in `incomplete_details`, so a parse
 * failure alone cannot name the budget as the cause. The #252 capture shows
 * `narrative.validate` routinely spending 92–98% of its cap on successful
 * calls, so a response that failed to produce typed output after spending
 * this much of the cap is in the truncation regime, not the malformed-output
 * regime — a threshold of exactly 1.0 would report those as `parse_failed`
 * and point the next versioned configuration at the wrong remedy.
 *
 * This is an inference, never a proof: only the Provider-reported reason
 * proves exhaustion, and the two stay distinguishable through
 * `providerReason`. The floor is a named constant so changing it is a
 * reviewable code decision, not a silent drift in a frozen artifact.
 */
const BUDGET_UTILIZATION_INFERENCE_FLOOR = 0.9;

function outputFailureKind(
  configuration: ModelRoleConfigurationSnapshot,
  usage: JsonCallUsage,
): ProviderResponseFailure["kind"] {
  const cap = configuration.parameterSnapshot.maxOutputTokens;
  if (
    typeof cap === "number" &&
    usage.outputTokens !== null &&
    usage.outputTokens >= Math.floor(cap * BUDGET_UTILIZATION_INFERENCE_FLOOR)
  ) {
    return "output_budget_exhausted";
  }
  return usage.outputLength === 0 ? "empty_output" : "parse_failed";
}

function untypedOutputError(
  configuration: ModelRoleConfigurationSnapshot,
  usage: JsonCallUsage,
): ProviderDispatchError {
  return new ProviderDispatchError(
    "invalid_response",
    `${configuration.role} returned output that is not a typed JSON object.`,
    true,
    { ...usage, kind: outputFailureKind(configuration, usage), providerReason: null },
  );
}

/**
 * Construct the real Responses API adapters for the four G1 roles. The
 * manifest supplies every role's frozen model identity; this factory only
 * supplies transport credentials and refuses cross-provider configuration.
 */
export function createRuntimeOneA3bRoleProviders(input: {
  adapter?: ResponsesApiAdapter;
  adapters?: readonly ResponsesApiAdapter[];
  configurations: readonly ModelRoleConfigurationSnapshot[];
}): OneA3bRuntimeRoleProviders {
  assertRuntimeProviderEgressIntegration("provider-egress.responses-api");
  const adapters = input.adapters ?? (input.adapter ? [input.adapter] : []);
  if (adapters.length === 0) {
    throw new Error("G1 runtime providers require at least one provider adapter.");
  }
  const jsonCallers = new Map<
    ResponsesApiAdapter["provider"],
    ReturnType<typeof createJsonCaller>
  >();
  for (const adapter of adapters) {
    if (jsonCallers.has(adapter.provider)) {
      throw new Error(`G1 runtime received duplicate ${adapter.provider} adapters.`);
    }
    jsonCallers.set(adapter.provider, createJsonCaller(adapter));
  }
  const askJson = (
    configuration: ModelRoleConfigurationSnapshot,
    payload: unknown,
    instructions: string,
    locale: string,
  ) => {
    if (!isResponsesApiProvider(configuration.provider)) {
      throw new Error(
        `G1 runtime cannot dispatch unsupported provider ${configuration.provider} for ${configuration.role}.`,
      );
    }
    const caller = jsonCallers.get(configuration.provider);
    if (!caller) {
      throw new Error(
        `G1 runtime has no credentials for the configured ${configuration.provider} provider of ${configuration.role}.`,
      );
    }
    return caller(configuration, payload, instructions, locale);
  };
  /**
   * Issue #252: a parseable body that fails the frozen output schema is a
   * fourth, distinct remedy (tighten or correct the schema) and can only be
   * proven at the typed read, so the classification is attached here. A
   * failure that already carries a cause keeps it.
   */
  const askTypedJson = async <Output>(
    configuration: ModelRoleConfigurationSnapshot,
    payload: unknown,
    instructions: string,
    locale: string,
    read: (parsed: unknown, role: string) => Output,
  ): Promise<Output> => {
    const { parsed, usage } = await askJson(
      configuration,
      payload,
      instructions,
      locale,
    );
    try {
      return read(parsed, configuration.role);
    } catch (error) {
      if (error instanceof ProviderDispatchError && error.failure === undefined) {
        throw new ProviderDispatchError(
          error.category,
          error.message,
          error.settlesAttempt,
          { ...usage, kind: "schema_mismatch", providerReason: null },
        );
      }
      throw error;
    }
  };
  const episodeConfiguration = requiredConfiguration(
    input.configurations,
    "episode.build",
  );
  const dailyConfiguration = requiredConfiguration(
    input.configurations,
    "reflection.daily",
  );
  const weeklyConfiguration = requiredConfiguration(
    input.configurations,
    "reflection.weekly",
  );
  const narrativeConfiguration = requiredConfiguration(
    input.configurations,
    "narrative.validate",
  );
  for (const configuration of [
    episodeConfiguration,
    dailyConfiguration,
    weeklyConfiguration,
    narrativeConfiguration,
  ]) {
    if (!isResponsesApiProvider(configuration.provider)) {
      throw new Error(
        `G1 role ${configuration.role} has no supported Responses API provider.`,
      );
    }
    if (!jsonCallers.has(configuration.provider)) {
      throw new Error(
        `G1 runtime has no credential adapter for the configured ${configuration.provider} provider of ${configuration.role}.`,
      );
    }
  }

  const episodeBuildProvider: EpisodeBuildModelProvider = {
    role: "episode.build",
    async buildProposals(request) {
      return askTypedJson(
        episodeConfiguration,
        request,
        "Given the frozen Evidence and active Episode records, return a JSON array of typed proposals. Each proposal must contain proposedKind, label, temporalAnchor, phase, kindFields, citedEvidenceItemIds, realWorldOccurrence, and may contain entityAnchorIds, explicitContinuity, or explicitNewOccurrence. proposedKind must come from the supplied kind catalog. phase must be one of planned, ongoing, completed, unknown. temporalAnchor start/end precision must be one of exact, month, year, approximate, unknown. Cite only supplied Evidence IDs and never invent IDs or facts.",
        request.evidence[0]?.locale ?? "en-US",
        asEpisodeProposals,
      );
    },
  };

  const reflectionProvider: ReflectionGenerationModelProvider = {
    role: "reflection.daily",
    async generate(request) {
      const configuration =
        request.role === "reflection.weekly"
          ? weeklyConfiguration
          : dailyConfiguration;
      return askTypedJson(
        configuration,
        request,
        "Return an object with statements and candidateProposals arrays. Each statement must contain statementKey, text, statementKind, and propositions. Each proposition must contain propositionKey, normalizedProposition, propositionKind, epistemicRendering, supportEvidenceItemIds, and baselineClaimIds. statementKind must be one of day_observation, cross_day_theme, change_observation. propositionKind must be one of fact, impression, synthesis. epistemicRendering must be one of confirmed, inferred. Each normalizedProposition must be an exact verbatim quote (a contiguous substring) of the statement text it belongs to; never paraphrase or normalize its wording. Candidate proposals must be propose_new-only and cite supplied Evidence IDs. Candidate candidateKind must be one of objective, impression; basis must be one of directly_stated, inferred; temporalStatus must be one of current, ended, unknown; validFromPrecision and validToPrecision must be one of exact, month, year, approximate, unknown.",
        request.locale || "en-US",
        asReflectionOutput,
      );
    },
  };

  const narrativeValidationProvider: NarrativeValidationModelProvider = {
    role: "narrative.validate",
    async validateNarrative(request) {
      return askTypedJson(
        narrativeConfiguration,
        request,
        "Independently decompose the draft into propositions and report source coverage. Return an object with propositions and coverageKeys arrays. Each proposition must contain propositionKey, text, propositionKind, epistemicRendering, supportKeys, unsupported, contradicted, and ambiguous. propositionKind must be one of fact, impression, synthesis. epistemicRendering must be one of confirmed, inferred. Use only supplied source keys. Each proposition text must be an exact verbatim quote (a contiguous substring) of the draft text; never paraphrase, normalize, reorder, or translate its wording. Flag semantics. Mark unsupported true only when no supplied source states or directly entails the proposition; paraphrase that preserves meaning counts as supported. Mark contradicted true only when a supplied source states the opposite of the proposition; absence of support is unsupported, never contradicted. Mark ambiguous true only when a reference in the proposition cannot be resolved from the draft itself (for example an entity, quantity, or comparison with no identifiable antecedent) so that source linkage is impossible; inelegant wording or anything resolvable from context is not ambiguous. When uncertain about any flag, leave it false.",
        request.draftLocale ?? "en-US",
        asNarrativeOutput,
      );
    },
  };

  return {
    episodeBuildProvider,
    reflectionProvider,
    narrativeValidationProvider,
  };
}
