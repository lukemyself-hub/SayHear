import {
  asConversationEventRevisionId,
  PROACTIVE_FOLLOWUP_MODEL_DISPOSITION_SIGNALS,
  ProviderDispatchError,
  type EpisodeProposal,
  type EpisodeBuildModelProvider,
  type ModelRoleConfigurationSnapshot,
  type NarrativeValidatorModelOutput,
  type NarrativeValidationModelProvider,
  type OpenLoopClosureProposal,
  type OpenLoopExtractModelOutput,
  type OpenLoopExtractModelProvider,
  type OpenLoopProposal,
  type ProactiveFollowupDispositionModelOutput,
  type ProactiveFollowupModelProvider,
  type ProactiveFollowupSegmentModelOutput,
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
  /** Test-only transport override; production always uses global fetch. */
  fetchImplementation?: typeof fetch;
}>;

export type OneA3bRuntimeRoleProviders = Readonly<{
  episodeBuildProvider: EpisodeBuildModelProvider;
  reflectionProvider: ReflectionGenerationModelProvider;
  narrativeValidationProvider: NarrativeValidationModelProvider;
  /** Present only when the active regime carries an evaluated bundle config. */
  openLoopExtractProvider?: OpenLoopExtractModelProvider;
  /** Present only when the active regime carries an evaluated bundle config. */
  proactiveFollowupProvider?: ProactiveFollowupModelProvider;
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

const OPEN_LOOP_KINDS = new Set(["upcoming_event", "awaited_outcome"]);
const OPEN_LOOP_TIME_PRECISIONS = new Set([
  "instant",
  "date",
  "range",
  "approximate",
  "unknown",
]);
const OPEN_LOOP_TERMINAL_STATUSES = new Set([
  "occurred",
  "resolved",
  "canceled",
  "expired",
  "retracted",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOpenLoopExpectedWindow(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  return (
    (value.startAt === null || typeof value.startAt === "string") &&
    (value.endAt === null || typeof value.endAt === "string") &&
    typeof value.precision === "string" &&
    OPEN_LOOP_TIME_PRECISIONS.has(value.precision) &&
    (value.timezone === null ||
      value.timezone === undefined ||
      typeof value.timezone === "string")
  );
}

function isOpenLoopProposal(value: unknown): value is OpenLoopProposal {
  if (!isRecord(value)) return false;
  return (
    typeof value.kind === "string" &&
    OPEN_LOOP_KINDS.has(value.kind) &&
    isNonEmptyString(value.evidenceItemId) &&
    isNonEmptyString(value.evidenceRevisionId) &&
    typeof value.hasRealAnchor === "boolean" &&
    typeof value.isTaskLike === "boolean" &&
    isOptionalString(value.userTimeExpression) &&
    (value.expectedWindow === undefined ||
      isOpenLoopExpectedWindow(value.expectedWindow)) &&
    isOptionalString(value.sourceClaimVersionId) &&
    isOptionalString(value.sourceEpisodeVersionId) &&
    isOptionalString(value.explicitLoopBinding) &&
    isOptionalString(value.canonicalClaimKey) &&
    Number.isSafeInteger(value.proposalIndex) &&
    (value.proposalIndex as number) >= 0
  );
}

function isOpenLoopClosure(value: unknown): value is OpenLoopClosureProposal {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.targetOpenLoopId) &&
    typeof value.proposedStatus === "string" &&
    OPEN_LOOP_TERMINAL_STATUSES.has(value.proposedStatus) &&
    isNonEmptyString(value.closureEvidenceRevisionId) &&
    typeof value.closureCommittedAt === "string" &&
    typeof value.entailsTerminal === "boolean" &&
    typeof value.explicitCancel === "boolean" &&
    typeof value.targetKind === "string" &&
    OPEN_LOOP_KINDS.has(value.targetKind)
  );
}

function asOpenLoopExtractOutput(
  value: unknown,
): OpenLoopExtractModelOutput {
  const parsed = asObject(value, "open_loop.extract");
  if (
    !Array.isArray(parsed.proposals) ||
    !parsed.proposals.every(isOpenLoopProposal) ||
    !Array.isArray(parsed.closures) ||
    !parsed.closures.every(isOpenLoopClosure)
  ) {
    throw new ProviderDispatchError(
      "invalid_response",
      "open_loop.extract returned an invalid output schema.",
    );
  }
  const proposals = parsed.proposals as readonly OpenLoopProposal[];
  const indices = proposals.map((proposal) => proposal.proposalIndex);
  if (new Set(indices).size !== indices.length) {
    throw new ProviderDispatchError(
      "invalid_response",
      "open_loop.extract returned duplicate proposal indices.",
    );
  }
  return parsed as OpenLoopExtractModelOutput;
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

const PROACTIVE_EXPRESSION_KINDS = new Set(["question", "acknowledgment"]);
const PROACTIVE_OMIT_REASONS = new Set([
  "no_genuine_opportunity",
  "duplicates_main_response",
  "insufficient_grounding",
  "timing_not_natural",
]);
const PROACTIVE_TARGET_KINDS = new Set(["open_loop", "memory_claim"]);

function isProactiveTargetRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.targetKind === "string" &&
    PROACTIVE_TARGET_KINDS.has(value.targetKind) &&
    isNonEmptyString(value.targetId) &&
    isNonEmptyString(value.targetVersionId)
  );
}

function asProactiveSegmentOutput(
  value: unknown,
): ProactiveFollowupSegmentModelOutput {
  const parsed = asObject(value, "proactive.followup");
  if (
    parsed.decision === "omit" &&
    typeof parsed.reason === "string" &&
    PROACTIVE_OMIT_REASONS.has(parsed.reason) &&
    isProactiveTargetRef(parsed.targetRef)
  ) {
    return parsed as ProactiveFollowupSegmentModelOutput;
  }
  if (
    parsed.decision !== "emit" ||
    !isNonEmptyString(parsed.content) ||
    typeof parsed.expressionKind !== "string" ||
    !PROACTIVE_EXPRESSION_KINDS.has(parsed.expressionKind) ||
    !isProactiveTargetRef(parsed.targetRef)
  ) {
    throw new ProviderDispatchError(
      "invalid_response",
      "proactive.followup returned an invalid output schema.",
    );
  }
  return parsed as ProactiveFollowupSegmentModelOutput;
}

function isProactiveDispositionLocator(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.kind === "assistant_event_revision" &&
    isNonEmptyString(value.assistantEventRevisionId) &&
    value.segment === "proactive_followup" &&
    value.ordinal === 0
  );
}

function asProactiveDispositionOutput(
  value: unknown,
): ProactiveFollowupDispositionModelOutput {
  const parsed = asObject(value, "proactive.followup");
  if (
    typeof parsed.signal !== "string" ||
    !(
      PROACTIVE_FOLLOWUP_MODEL_DISPOSITION_SIGNALS as readonly string[]
    ).includes(parsed.signal) ||
    !isProactiveDispositionLocator(parsed.finalTextLocator)
  ) {
    throw new ProviderDispatchError(
      "invalid_response",
      "proactive.followup returned an invalid output schema.",
    );
  }
  return parsed as ProactiveFollowupDispositionModelOutput;
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
    ...(adapter.fetchImplementation
      ? { fetchImplementation: adapter.fetchImplementation }
      : {}),
  });

  return async function askJson(
    configuration: ModelRoleConfigurationSnapshot,
    payload: unknown,
    instructions: string,
    locale: string,
  ): Promise<unknown> {
    let output = "";
    let modelSnapshot: string | null = null;
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
      if (event.type === "completed") modelSnapshot = event.modelSnapshot;
    }
    if (modelSnapshot !== configuration.modelSnapshot) {
      throw new ProviderDispatchError(
        "invalid_response",
        `${configuration.role} returned model snapshot ${modelSnapshot ?? "<missing>"}, expected ${configuration.modelSnapshot}.`,
      );
    }
    try {
      return JSON.parse(output);
    } catch {
      const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(output);
      if (fenced) {
        try {
          return JSON.parse(fenced[1] ?? "");
        } catch {
          // Fall through to one typed provider failure.
        }
      }
      throw new ProviderDispatchError(
        "invalid_response",
        `${configuration.role} returned non-JSON output.`,
      );
    }
  };
}

/**
 * Construct the real Responses API adapters for the G1 roles plus the G2
 * `open_loop.extract` and `proactive.followup` bundle roles when the active
 * regime carries their evaluated configurations. The manifest supplies every
 * role's frozen model identity; this factory only supplies transport
 * credentials and refuses cross-provider configuration. A G1-only regime
 * leaves both bundle lanes closed (no bundle providers) exactly as before.
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
      const parsed = await askJson(
        episodeConfiguration,
        request,
        "Given the frozen Evidence and active Episode records, return a JSON array of typed proposals. Each proposal must contain proposedKind, label, temporalAnchor, phase, kindFields, citedEvidenceItemIds, realWorldOccurrence, and may contain entityAnchorIds, explicitContinuity, or explicitNewOccurrence. proposedKind must come from the supplied kind catalog. phase must be one of planned, ongoing, completed, unknown. temporalAnchor start/end precision must be one of exact, month, year, approximate, unknown. Cite only supplied Evidence IDs and never invent IDs or facts.",
        request.evidence[0]?.locale ?? "en-US",
      );
      return asEpisodeProposals(parsed);
    },
  };

  const reflectionProvider: ReflectionGenerationModelProvider = {
    role: "reflection.daily",
    async generate(request) {
      const configuration =
        request.role === "reflection.weekly"
          ? weeklyConfiguration
          : dailyConfiguration;
      return asReflectionOutput(
        await askJson(
          configuration,
          request,
          "Return an object with statements and candidateProposals arrays. Each statement must contain statementKey, text, statementKind, and propositions. Each proposition must contain propositionKey, normalizedProposition, propositionKind, epistemicRendering, supportEvidenceItemIds, and baselineClaimIds. statementKind must be one of day_observation, cross_day_theme, change_observation. propositionKind must be one of fact, impression, synthesis. epistemicRendering must be one of confirmed, inferred. Each normalizedProposition must be an exact verbatim quote (a contiguous substring) of the statement text it belongs to; never paraphrase or normalize its wording. Candidate proposals must be propose_new-only and cite supplied Evidence IDs. Candidate candidateKind must be one of objective, impression; basis must be one of directly_stated, inferred; temporalStatus must be one of current, ended, unknown; validFromPrecision and validToPrecision must be one of exact, month, year, approximate, unknown.",
          request.locale || "en-US",
        ),
        request.role,
      );
    },
  };

  const narrativeValidationProvider: NarrativeValidationModelProvider = {
    role: "narrative.validate",
    async validateNarrative(request) {
      return asNarrativeOutput(
        await askJson(
          narrativeConfiguration,
          request,
          "Independently decompose the draft into propositions and report source coverage. Return an object with propositions and coverageKeys arrays. Each proposition must contain propositionKey, text, propositionKind, epistemicRendering, supportKeys, unsupported, contradicted, and ambiguous. propositionKind must be one of fact, impression, synthesis. epistemicRendering must be one of confirmed, inferred. Use only supplied source keys. Each proposition text must be an exact verbatim quote (a contiguous substring) of the draft text; never paraphrase, normalize, reorder, or translate its wording. Flag semantics. Mark unsupported true only when no supplied source states or directly entails the proposition; paraphrase that preserves meaning counts as supported. Mark contradicted true only when a supplied source states the opposite of the proposition; absence of support is unsupported, never contradicted. Mark ambiguous true only when a reference in the proposition cannot be resolved from the draft itself (for example an entity, quantity, or comparison with no identifiable antecedent) so that source linkage is impossible; inelegant wording or anything resolvable from context is not ambiguous. When uncertain about any flag, leave it false.",
          request.draftLocale ?? "en-US",
        ),
      );
    },
  };

  const openLoopConfiguration = input.configurations.find(
    (candidate) => candidate.role === "open_loop.extract",
  );
  if (openLoopConfiguration) {
    if (!isResponsesApiProvider(openLoopConfiguration.provider)) {
      throw new Error(
        "G2 role open_loop.extract has no supported Responses API provider.",
      );
    }
    if (!jsonCallers.has(openLoopConfiguration.provider)) {
      throw new Error(
        "G2 runtime has no credential adapter for the configured open_loop.extract provider.",
      );
    }
  }
  const openLoopExtractProvider: OpenLoopExtractModelProvider | undefined =
    openLoopConfiguration
      ? {
          role: "open_loop.extract",
          async extractProposals(request) {
            return asOpenLoopExtractOutput(
              await askJson(
                openLoopConfiguration,
                request,
                "Given the frozen user utterance, evidence spans, and currently open loops, return an object with proposals and closures arrays. Each proposal must contain kind, evidenceItemId, evidenceRevisionId, hasRealAnchor, isTaskLike, and proposalIndex, and may contain userTimeExpression, expectedWindow, sourceClaimVersionId, sourceEpisodeVersionId, explicitLoopBinding, or canonicalClaimKey. kind must be upcoming_event or awaited_outcome. Emit a proposal whenever the utterance mentions a future scheduled event or an outcome the user is waiting to hear about, even if it seems minor; use an empty proposals array only when the utterance contains no future happening at all. Never propose reminders, goals, tasks, unfinished topics, or emotions; a dated obligation is task-like even with a date. expectedWindow is optional: omit it entirely when the utterance carries no real time anchor, and never invent a window. When present it must be an object with precision, startAt, endAt, and timezone: precision is one of instant, date, range, approximate, unknown; startAt and endAt are ISO-8601 instants or null; timezone is an IANA time zone name or null. Cite only supplied evidence IDs and never invent IDs or facts. proposalIndex must be unique starting at 0. Each closure must contain targetOpenLoopId, proposedStatus, closureEvidenceRevisionId, closureCommittedAt, entailsTerminal, explicitCancel, and targetKind; only assert closures against the supplied open loops when the user evidence necessarily entails the terminal state, and require explicit cancel language for canceled. When uncertain, return empty arrays.",
                request.locale || "en-US",
              ),
            );
          },
        }
      : undefined;

  const proactiveConfiguration = input.configurations.find(
    (candidate) => candidate.role === "proactive.followup",
  );
  if (proactiveConfiguration) {
    if (!isResponsesApiProvider(proactiveConfiguration.provider)) {
      throw new Error(
        "G2 role proactive.followup has no supported Responses API provider.",
      );
    }
    if (!jsonCallers.has(proactiveConfiguration.provider)) {
      throw new Error(
        "G2 runtime has no credential adapter for the configured proactive.followup provider.",
      );
    }
  }
  const proactiveFollowupProvider: ProactiveFollowupModelProvider | undefined =
    proactiveConfiguration
      ? {
          role: "proactive.followup",
          async generateSegment(request) {
            return asProactiveSegmentOutput(
              await askJson(
                proactiveConfiguration,
                request,
                 "Given the current user message, frozen main response, current local time, pinned follow-up target, and opportunity, decide whether one isolated append-only follow-up would add natural and specific continuity. Return either {decision:'emit', content, expressionKind, targetRef} or {decision:'omit', reason, targetRef}. Omit when there is no genuine conversational opportunity, the main response already asks about or semantically covers the target, the transition would be abrupt, grounding or identity is unclear, or the timing is not natural. Omit instead of adding generic care, an 'I'm here' sentence, a dangling this/that reference, repeated reassurance, or a repeated date or event. Omit reasons are no_genuine_opportunity, duplicates_main_response, insufficient_grounding, or timing_not_natural. For emit, expressionKind must be question or acknowledgment: an open loop normally asks one concise question about its unknown event or outcome, while a memory claim defaults to a specific acknowledgment unless its evidence supports a concrete answerable development. A question must contain exactly one question; an acknowledgment must contain none. targetRef must echo the supplied targetRef object exactly in either decision. Treat subjectRole user as the user and never refer to that person as an unrelated third party. Do not infer that an unknown or other subject is the user. Never invent progress, feelings, urgency, or a recent event. Keep emitted content short and natural; for sensitive targets keep it gentle, brief, and answer-optional without ritual disclaimers. Never rewrite the main response.",
                request.locale || "en-US",
              ),
            );
          },
          async classifyDisposition(request) {
            return asProactiveDispositionOutput(
              await askJson(
                proactiveConfiguration,
                request,
                "Given the user's next message and the committed proactive segment, return an object with signal and finalTextLocator. signal must be one of no_stop_signal, short_response, evaded, refused, topic_changed. A brief but complete answer is still short_response. Ignoring the follow-up while continuing elsewhere is topic_changed. A blanket request to stop questions is refused. Otherwise return no_stop_signal. finalTextLocator must echo the supplied finalTextLocator exactly.",
                request.locale || "en-US",
              ),
            );
          },
        }
      : undefined;

  return {
    episodeBuildProvider,
    reflectionProvider,
    narrativeValidationProvider,
    ...(openLoopExtractProvider ? { openLoopExtractProvider } : {}),
    ...(proactiveFollowupProvider ? { proactiveFollowupProvider } : {}),
  };
}
