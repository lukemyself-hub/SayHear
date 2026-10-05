import {
  asConversationEventRevisionId,
  episodeKindTypedFields,
  ProviderDispatchError,
  type EpisodeBuildModelProvider,
  type EpisodeBuildModelRequest,
  type EpisodeProposal,
  type ModelRoleCallUsage,
  type ModelRoleConfigurationSnapshot,
  type NarrativeValidatorModelOutput,
  type NarrativeValidationModelProvider,
  type ProviderResponseFailure,
  type ReflectionBaselineEntry,
  type ReflectionGenerationModelOutput,
  type ReflectionGenerationModelProvider,
  type ReflectionGenerationModelRequest,
} from "@sayhear/application";

import { createOpenCodeGoConversationTextModel } from "./opencode-go-conversation-text-model";
import { providerSessionIdFor } from "./provider-session-identity";
import { createResponsesApiConversationTextModel } from "./responses-api-conversation-text-model";
import { assertRuntimeProviderEgressIntegration } from "./runtime-provider-egress";

export type ResponsesApiAdapter = Readonly<{
  apiKey: string;
  baseUrl: string;
  provider: "openai" | "deepseek";
  timeoutMs: number;
}>;

/**
 * The OpenCode Go Chat Completions adapter carries no baseUrl: the Go endpoint
 * is fixed inside the transport so no caller can retarget it at another host.
 */
export type OpenCodeGoAdapter = Readonly<{
  apiKey: string;
  provider: "opencode-go";
  timeoutMs: number;
}>;

export type OneA3bProviderAdapter = ResponsesApiAdapter | OpenCodeGoAdapter;

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

function isSupportedProvider(
  value: string,
): value is OneA3bProviderAdapter["provider"] {
  return value === "openai" || value === "deepseek" || value === "opencode-go";
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

function createJsonCaller(adapter: OneA3bProviderAdapter) {
  const model =
    adapter.provider === "opencode-go"
      ? createOpenCodeGoConversationTextModel({
          apiKey: adapter.apiKey,
          timeoutMs: adapter.timeoutMs,
        })
      : createResponsesApiConversationTextModel({
          apiKey: adapter.apiKey,
          baseUrl: adapter.baseUrl,
          timeoutMs: adapter.timeoutMs,
        });

  return async function askJson(
    configuration: ModelRoleConfigurationSnapshot,
    payload: unknown,
    instructions: string,
    locale: string,
    /** Opaque, owner-and-task-scoped transport identity for the Go adapter. */
    providerSessionId: string,
    /** Content-free accounting, reported before any throw so a terminal
     * usage-bearing failure is never lost to a snapshot mismatch. */
    reportUsage?: (usage: ModelRoleCallUsage) => void,
  ): Promise<{ parsed: unknown; usage: JsonCallUsage }> {
    let output = "";
    let modelSnapshot: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let reasoningTokens: number | null = null;
    let cachedTokens: number | null = null;
    let totalTokens: number | null = null;
    // The adapter reports normalized usage once per logical call through this
    // callback — including on a terminal failure after the Provider already
    // spent the tokens. The completed event is used only as a fallback for
    // adapters that do not invoke the callback (the legacy Responses path), so
    // a callback-bearing call is never reported twice.
    let usageReportedByAdapter = false;
    const reportUsageOnce = (usage: ModelRoleCallUsage): void => {
      if (usageReportedByAdapter) return;
      usageReportedByAdapter = true;
      reportUsage?.(usage);
    };
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
      onUsage: reportUsageOnce,
      parameters: configuration.parameterSnapshot,
      providerSessionId,
      toolsDisabled: true,
    })) {
      if (event.type === "delta") output += event.delta;
      if (event.type === "completed") {
        modelSnapshot = event.modelSnapshot;
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
        reasoningTokens = event.reasoningTokens ?? null;
        cachedTokens = event.cachedTokens ?? null;
        totalTokens = event.totalTokens ?? null;
      }
    }
    const usage: JsonCallUsage = {
      cachedTokens,
      inputTokens,
      outputLength: output.length,
      outputTokens,
      reasoningTokens,
      totalTokens,
    };
    // Report before the snapshot check and before any typed read so a terminal
    // call that carries usage still leaves its spend on record even when the
    // business error is a snapshot mismatch. This changes no classification.
    // Guarded so an adapter callback that already reported the same logical
    // call does not double-count it.
    reportUsageOnce({
      cachedTokens: usage.cachedTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
    });
    if (modelSnapshot !== configuration.modelSnapshot) {
      throw new ProviderDispatchError(
        "invalid_response",
        `${configuration.role} returned model snapshot ${modelSnapshot ?? "<missing>"}, expected ${configuration.modelSnapshot}.`,
      );
    }
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
  cachedTokens: number | null;
  inputTokens: number | null;
  outputLength: number;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
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

/**
 * Whether the call spent enough of the frozen cap to be in the truncation
 * regime. Shared by the parse path and the typed-read path so a body that
 * fails either one is judged the same way — otherwise a truncation that still
 * happened to parse would be blamed on the output schema.
 */
function budgetUtilized(
  configuration: ModelRoleConfigurationSnapshot,
  usage: JsonCallUsage,
): boolean {
  const cap = configuration.parameterSnapshot.maxOutputTokens;
  return (
    typeof cap === "number" &&
    usage.outputTokens !== null &&
    usage.outputTokens >= Math.floor(cap * BUDGET_UTILIZATION_INFERENCE_FLOOR)
  );
}

function outputFailureKind(
  configuration: ModelRoleConfigurationSnapshot,
  usage: JsonCallUsage,
): ProviderResponseFailure["kind"] {
  if (budgetUtilized(configuration, usage)) return "output_budget_exhausted";
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
 * The Episode kindFields allowlist is code-owned (`episodeKindTypedFields`)
 * and is the exact set admission accepts. The instruction must describe the
 * catalog the request actually carries, from that single authority, so the
 * model is never told a key is legal that admission terminally rejects with
 * `typed_field_invalid` — or left uninformed about a key it does accept.
 */
function episodeKindFieldContract(
  catalog: EpisodeBuildModelRequest["kindCatalog"],
): string {
  return catalog
    .map((kind) => {
      const fields = episodeKindTypedFields(kind);
      return fields.length === 0
        ? `${kind} kindFields must be an empty object {}`
        : `${kind} kindFields may contain only ${fields.join(", ")}`;
    })
    .join("; ");
}

/**
 * The frozen `episode.build` instruction. It repeats every hard contract
 * admission already enforces (kindFields allowlist, boundary date format per
 * precision, non-empty cited Evidence, and entity-anchor resolvability); it
 * never relaxes or adds a gate. `realWorldOccurrence` is left as the existing
 * boolean requirement because the no_real_world_anchor gate is intended.
 */
function episodeBuildInstructions(
  request: EpisodeBuildModelRequest,
): string {
  return [
    "Given the frozen Evidence and active Episode records, return a JSON array of typed proposals.",
    "Each proposal must contain proposedKind, label, temporalAnchor, phase, kindFields, citedEvidenceItemIds, realWorldOccurrence, and may contain entityAnchorIds, explicitContinuity, or explicitNewOccurrence.",
    "proposedKind must come from the supplied kind catalog. proposedKind and label must be strings.",
    `kindFields allowlist by kind: ${episodeKindFieldContract(request.kindCatalog)}. kindFields is required for every proposal, never omitted: return an empty object {} when the kind allows none, otherwise return only the allowed keys with string values.`,
    "citedEvidenceItemIds must contain at least one supplied Evidence ID and only supplied Evidence IDs.",
    "entityAnchorIds may contain only IDs that already appear in the supplied activeEpisodes entityAnchorIds; omit entityAnchorIds when no supplied ID applies, and never invent an ID.",
    "realWorldOccurrence and optional explicitNewOccurrence must be booleans.",
    "Omit unknown optional fields rather than returning null.",
    "temporalAnchor must contain a start object and may contain an end object.",
    "Boundary date format must match precision exactly: exact requires YYYY-MM-DD, month requires YYYY-MM, year requires YYYY, approximate may use YYYY or YYYY-MM or YYYY-MM-DD or omit the date field, and unknown must omit the date field.",
    "Boundary precision must be one of exact, month, year, approximate, unknown.",
    "phase must be one of planned, ongoing, completed, unknown.",
    "Optional explicitContinuity must contain evidenceItemId and span strings.",
    "Cite only supplied Evidence IDs and never invent IDs or facts.",
  ].join(" ");
}

/**
 * The frozen Reflection output instruction, shared byte-for-byte by both
 * scopes. It states the deterministic reference protocol the Tier-1 gate
 * enforces: Evidence-only support, `baseline[].claimId`-only baseline
 * citations, a baseline subset for `change_observation`, and two distinct
 * Daily Sessions for `cross_day_theme` / `change_observation`. Daily appends
 * its single-scope statement-kind clause below.
 */
const REFLECTION_OUTPUT_INSTRUCTIONS =
  "Return an object with statements and candidateProposals arrays. Each statement must contain statementKey, text, statementKind, and propositions. Each proposition must contain propositionKey, normalizedProposition, propositionKind, epistemicRendering, supportEvidenceItemIds, and baselineClaimIds. statementKind must be one of day_observation, cross_day_theme, change_observation. Every proposition must cite at least one supplied Evidence ID in supportEvidenceItemIds and only supplied Evidence IDs. baselineClaimIds must copy verbatim only supplied baseline claimId values; never cite a claimVersionId, an Evidence, Episode, Session, or Summary ID, and never invent an ID. A change_observation proposition must list at least one supplied baseline claimId. cross_day_theme and change_observation statements must draw support from at least two distinct supplied Daily Session IDs. propositionKind must be one of fact, impression, synthesis. epistemicRendering must be one of confirmed, inferred. Each normalizedProposition must be an exact verbatim quote (a contiguous substring) of the statement text it belongs to; never paraphrase or normalize its wording. Candidate proposals must be propose_new-only and cite supplied Evidence IDs. Each candidate must contain candidateKind, basis, predicateId, proposedConcept, typedValue, scopeKey, temporal, and evidenceItemIds. predicateId and proposedConcept must each be a string or null; typedValue must be a string or an array of strings; scopeKey must be a string; evidenceItemIds must be an array of supplied Evidence IDs. temporal must be an object containing temporalStatus, validFrom, validFromPrecision, validTo, and validToPrecision. validFrom and validTo must each be a date string or null. Candidate candidateKind must be one of objective, impression; basis must be one of directly_stated, inferred; temporalStatus must be one of current, ended, unknown; validFromPrecision and validToPrecision must be one of exact, month, year, approximate, unknown.";

/**
 * The Provider-facing Reflection payload. `claimVersionId` is internal Claim
 * version lineage used only to freeze the comparison digest; the
 * deterministic Tier-1 gate accepts only `baseline[].claimId` values, so
 * sending the version ID invites the model to cite the wrong ID namespace.
 * Only that one unused model-output field is dropped: the frozen request
 * object, its Evidence, Episode, Summary, baseline claim IDs and
 * claim-baseline digest are all preserved, and Episode / narrative.validate
 * payloads are never projected.
 */
type ReflectionBaselineModelEntry = Omit<ReflectionBaselineEntry, "claimVersionId">;
type ReflectionModelPayload = Omit<ReflectionGenerationModelRequest, "baseline"> &
  Readonly<{ baseline: readonly ReflectionBaselineModelEntry[] }>;

function reflectionModelPayload(
  request: ReflectionGenerationModelRequest,
): ReflectionModelPayload {
  return {
    ...request,
    baseline: request.baseline.map((entry) => {
      const { claimVersionId: _claimVersionId, ...modelEntry } = entry;
      void _claimVersionId;
      return modelEntry;
    }),
  };
}

/**
 * Reflection's Tier-1 gate fails the whole version with
 * `daily_scope_kind_invalid` when a Daily statement is not `day_observation`.
 * The shared instruction lists all three statement kinds, so Daily must state
 * its narrower contract explicitly (ADR-0121 keeps one frozen prompt per
 * artifact kind).
 */
function reflectionInstructions(
  request: ReflectionGenerationModelRequest,
): string {
  if (request.role !== "reflection.daily") {
    return REFLECTION_OUTPUT_INSTRUCTIONS;
  }
  return `${REFLECTION_OUTPUT_INSTRUCTIONS} This is a Daily Reflection over one Daily Session: every statement must use statementKind day_observation; cross_day_theme and change_observation are not allowed in Daily scope.`;
}

/**
 * Construct the real Responses API adapters for the four G1 roles. The
 * manifest supplies every role's frozen model identity; this factory only
 * supplies transport credentials and refuses cross-provider configuration.
 */
export function createRuntimeOneA3bRoleProviders(input: {
  adapter?: OneA3bProviderAdapter;
  adapters?: readonly OneA3bProviderAdapter[];
  configurations: readonly ModelRoleConfigurationSnapshot[];
  /** Content-free accounting for synthetic acceptance capture. */
  onUsage?: (role: ModelRoleConfigurationSnapshot["role"], usage: ModelRoleCallUsage) => void;
}): OneA3bRuntimeRoleProviders {
  assertRuntimeProviderEgressIntegration("provider-egress.responses-api");
  const adapters = input.adapters ?? (input.adapter ? [input.adapter] : []);
  if (adapters.length === 0) {
    throw new Error("G1 runtime providers require at least one provider adapter.");
  }
  const jsonCallers = new Map<
    OneA3bProviderAdapter["provider"],
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
    providerSessionId: string,
    reportUsage?: (usage: ModelRoleCallUsage) => void,
  ) => {
    if (!isSupportedProvider(configuration.provider)) {
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
    return caller(
      configuration,
      payload,
      instructions,
      locale,
      providerSessionId,
      reportUsage,
    );
  };
  /**
   * Issue #252: a parseable body that fails the frozen output schema is a
   * fourth, distinct remedy (tighten or correct the schema) and can only be
   * proven at the typed read, so the classification is attached here. It
   * carries the same budget inference as the parse path — a near-exhausted
   * call that happened to parse is still far more likely truncated than
   * schema-violating — and a failure that already carries a cause keeps it.
   */
  const askTypedJson = async <Output>(
    configuration: ModelRoleConfigurationSnapshot,
    payload: unknown,
    instructions: string,
    locale: string,
    providerSessionId: string,
    read: (parsed: unknown, role: string) => Output,
    onUsage?: (usage: ModelRoleCallUsage) => void,
  ): Promise<Output> => {
    // Reported by askJson before any throw so a call that fails the schema,
    // the snapshot check, or the parse still leaves its spend on record; the
    // failure itself carries the same counts. Narrowed explicitly so the
    // callback receives exactly its declared type rather than the wider
    // internal record.
    const reportUsage = (usage: ModelRoleCallUsage) => {
      onUsage?.(usage);
      input.onUsage?.(configuration.role, usage);
    };
    const { parsed, usage } = await askJson(
      configuration,
      payload,
      instructions,
      locale,
      providerSessionId,
      reportUsage,
    );
    try {
      return read(parsed, configuration.role);
    } catch (error) {
      if (error instanceof ProviderDispatchError && error.failure === undefined) {
        throw new ProviderDispatchError(
          error.category,
          error.message,
          error.settlesAttempt,
          {
            ...usage,
            kind: budgetUtilized(configuration, usage)
              ? "output_budget_exhausted"
              : "schema_mismatch",
            providerReason: null,
          },
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
    if (!isSupportedProvider(configuration.provider)) {
      throw new Error(
        `G1 role ${configuration.role} has no supported Provider.`,
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
    async buildProposals(request, onUsage) {
      return askTypedJson(
        episodeConfiguration,
        request,
        episodeBuildInstructions(request),
        request.evidence[0]?.locale ?? "en-US",
        providerSessionIdFor({ ownerId: request.userId, scopeId: `episode.build:${request.dailySessionId}` }),
        asEpisodeProposals,
        onUsage,
      );
    },
  };

  const reflectionProvider: ReflectionGenerationModelProvider = {
    role: "reflection.daily",
    async generate(request, onUsage) {
      const configuration =
        request.role === "reflection.weekly"
          ? weeklyConfiguration
          : dailyConfiguration;
      // Weekly is scoped by its week identifier; Daily by its single session.
      // Evidence is required by the frozen contract, so a scope exists. The Go
      // adapter is stricter: each role must carry its own non-blank trusted
      // scope and is never allowed to borrow the other role's field, so a
      // missing weekly/day identity fails closed before any dispatch instead
      // of silently opening a session under the wrong scope. Legacy
      // Responses/deterministic behavior (including the cross-field fallback)
      // is unchanged.
      let scope: string | undefined;
      if (configuration.provider === "opencode-go") {
        if (request.role === "reflection.weekly") {
          const weekIdentifier = request.weekIdentifier;
          if (
            typeof weekIdentifier !== "string" ||
            weekIdentifier.trim() === ""
          ) {
            throw new ProviderDispatchError(
              "configuration",
              "reflection.weekly requires a non-empty week identifier for a Provider session identity.",
            );
          }
          scope = weekIdentifier;
        } else {
          const dailySessionId = request.evidence[0]?.dailySessionId;
          if (
            typeof dailySessionId !== "string" ||
            dailySessionId.trim() === ""
          ) {
            throw new ProviderDispatchError(
              "configuration",
              `${request.role} requires a non-empty evidence Daily Session for a Provider session identity.`,
            );
          }
          scope = dailySessionId;
        }
      } else {
        scope =
          request.role === "reflection.weekly"
            ? (request.weekIdentifier ??
              request.evidence[0]?.dailySessionId ??
              undefined)
            : (request.evidence[0]?.dailySessionId ??
              request.weekIdentifier ??
              undefined);
      }
      if (!scope) {
        throw new ProviderDispatchError(
          "configuration",
          `${request.role} has no logical scope to derive a Provider session identity.`,
        );
      }
      return askTypedJson(
        configuration,
        reflectionModelPayload(request),
        reflectionInstructions(request),
        request.locale || "en-US",
        providerSessionIdFor({ ownerId: request.userId, scopeId: `${request.role}:${scope}` }),
        asReflectionOutput,
        onUsage,
      );
    },
  };

  const narrativeValidationProvider: NarrativeValidationModelProvider = {
    role: "narrative.validate",
    async validateNarrative(request, onUsage) {
      // The Go adapter derives its session identity from the draft reference.
      // A blank reference would make the scope prefix "narrative.validate:"
      // mask a missing identity, so it is rejected before any dispatch. The
      // outer production caller already validates the draft; legacy
      // Responses/deterministic callers keep their existing contract.
      if (
        narrativeConfiguration.provider === "opencode-go" &&
        (typeof request.draftRef !== "string" ||
          request.draftRef.trim() === "")
      ) {
        throw new ProviderDispatchError(
          "configuration",
          "narrative.validate requires a non-empty draft reference for a Provider session identity.",
        );
      }
      return askTypedJson(
        narrativeConfiguration,
        request,
        "Independently decompose the draft into propositions and report source coverage. Return an object with propositions and coverageKeys arrays. Each proposition must contain propositionKey, text, propositionKind, epistemicRendering, supportKeys, unsupported, contradicted, and ambiguous. propositionKind must be one of fact, impression, synthesis. epistemicRendering must be one of confirmed, inferred. Use only supplied source keys. Each proposition text must be an exact verbatim quote (a contiguous substring) of the draft text; never paraphrase, normalize, reorder, or translate its wording. Flag semantics. Mark unsupported true only when no supplied source states or directly entails the proposition; paraphrase that preserves meaning counts as supported. Mark contradicted true only when a supplied source states the opposite of the proposition; absence of support is unsupported, never contradicted. Mark ambiguous true only when a reference in the proposition cannot be resolved from the draft itself (for example an entity, quantity, or comparison with no identifiable antecedent) so that source linkage is impossible; inelegant wording or anything resolvable from context is not ambiguous. When uncertain about any flag, leave it false.",
        request.draftLocale ?? "en-US",
        providerSessionIdFor({ ownerId: request.userId, scopeId: `narrative.validate:${request.draftRef}` }),
        asNarrativeOutput,
        onUsage,
      );
    },
  };

  return {
    episodeBuildProvider,
    reflectionProvider,
    narrativeValidationProvider,
  };
}
