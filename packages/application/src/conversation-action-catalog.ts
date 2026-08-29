import type {
  CompiledContextId,
  ConversationEventRevisionId,
  GenerationCommandId,
  UserId,
} from "@sayhear/domain";

/**
 * The immutable Conversation Action Catalog (ADR-0093, ADR-0094, architecture
 * 08-10 §8.4).
 *
 * The Catalog is the finite, versioned set of ConversationActionDefinitions the
 * Conversation Agent Harness exposes to the model for a Decision Command. The
 * initial Catalog for issue #24 contains **zero** enabled Definitions: this
 * ticket prefactors the Text response path behind the Harness and does not yet
 * admit any Conversation Action. #25 publishes the first Definition
 * (`regenerate_journal`).
 *
 * The Catalog is an application-owned, content-addressed constant. Its version
 * is frozen on each Decision Command (`conversation_action_catalog_version`),
 * but it is never a database lookup table, CRUD surface, or long-lived product
 * object — it must not expose Journal, Workflow, Claim, Profile, deletion, or
 * internal CRUD operations (issue #24 AC5).
 *
 * `ConversationActionProposal` is the provider-independent typed union the
 * Provider Adapter normalizes a selected Conversation Function into before the
 * application seam. With no enabled Definition it is uninhabited
 * (`actionKind: never`): a model attempting an Action while the Catalog is empty
 * cannot name a valid kind, so the Harness fails closed.
 */

/**
 * The discriminator of a Conversation Action capability. A concrete kind (for
 * example `regenerate_journal`) is published only when its Definition validates.
 * Until then the only valid Catalog has no kind to select.
 */
export type ConversationActionKind =
  | "regenerate_journal"
  | (string & {});

export type ConversationActionTargetKind = "journal";

export type ActionReferenceHandle = Readonly<{
  actionKinds: readonly ConversationActionKind[];
  handle: string;
  targetKind: ConversationActionTargetKind;
}>;

export type ActionReferenceTarget = Readonly<{
  actionKinds: readonly ConversationActionKind[];
  targetId: string;
  targetKind: ConversationActionTargetKind;
  targetVersionId: string;
  sourceRevision: number;
}>;

export type ConversationFunctionDefinition = Readonly<{
  description: string;
  name: string;
  parameters: Readonly<Record<string, unknown>>;
  strict: true;
  /**
   * Marks a proposal channel whose user-facing reply must arrive in the same
   * logical generation. When a Provider answers with only a call to a
   * function carrying this flag and no output text, the adapter continues
   * the tool loop once (a function_call_output round trip) to obtain the
   * visible reply, instead of surfacing a text-less decision. Conversation
   * Action functions leave it unset: their finalization stage already owns
   * the visible reply.
   */
  visibleReplyRequired?: true;
}>;

export type ConversationActionSchema = Readonly<{
  additionalProperties: false;
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  required: readonly string[];
  type: "object";
}>;

/**
 * A single capability descriptor in the Catalog (ADR-0098). The descriptor
 * carries only the cross-cutting contracts the Gateway, Harness, permission
 * checks, observability, and Receipt need; domain state machines stay in typed
 * handlers.
 *
 * Since issue #109 a Catalog may carry multiple coexisting Definitions, and an
 * execution mode of `"synchronous"` commits its effect inside the admission
 * transaction instead of creating a durable workflow command. Open string
 * unions for capability identities keep new Definitions publishable without
 * editing this module; publication checks still fail closed below.
 */
export type ConversationActionDefinition = Readonly<{
  actionKind: ConversationActionKind;
  availabilityPolicy: "authenticated_owner";
  consistencyPolicy: string;
  confirmationPolicy: "none";
  effectClass: string;
  /**
   * `"async"` creates an idempotent durable workflow command / outbox entry in
   * the admission transaction; `"synchronous"` commits the handler's domain
   * effect inside that same transaction and finishes with a terminal
   * Completion Receipt (ADR-0099).
   */
  executionMode: "async" | "synchronous";
  /** Model-facing Function description; generation is Definition-driven. */
  functionDescription: string;
  handlerBinding: string;
  idempotencyScope: string;
  inputSchema: ConversationActionSchema;
  ratePolicy: Readonly<{
    /** Positive integer cap on in-flight executions, or null for uncapped. */
    maxInFlightPerTarget: number | null;
    name: string;
  }>;
  schemaVersion: string;
  targetContract: Readonly<{
    /**
     * The required inputSchema property carrying the target reference — the
     * opaque ADR-0096 handle for `frozen_context_handle` resolution, the
     * user-words anchor span for `admission_time_anchor` resolution
     * (ADR-0118).
     */
    handleArgument: string;
    handleKind: string;
    /**
     * How the Gateway resolves the reference. Absent means the default
     * `frozen_context_handle` (ADR-0096): the reference must resolve to a
     * minted, command-scoped handle of this Decision's CompiledContext.
     * `admission_time_anchor` (ADR-0118, Trust-Control Actions): the Gateway
     * deterministically resolves the owner-scoped structured-lexical anchor
     * against the Action's search space at admission time — unique
     * high-confidence hit admits, multi-hit clarifies count-only, zero hit
     * honestly reports with zero domain change.
     */
    resolution?: "frozen_context_handle" | "admission_time_anchor";
    versioned: true;
  }>;
  trustClass: string;
}>;

/**
 * The immutable, versioned Catalog the Harness freezes for a Decision Command.
 * `version` is content-addressed: a different set of Definitions is a different
 * version identity, never an in-place mutation.
 */
export type ConversationActionCatalog = Readonly<{
  definitions: readonly ConversationActionDefinition[];
  version: string;
}>;

/**
 * The provider-independent normalized Action selection (ADR-0095). The Provider
 * Adapter must produce this from a native function / strict-structured-output
 * selection before the application seam. Arguments are validated against the
 * selected Definition's inputSchema; the target reference handle arrives under
 * the Definition's `targetContract.handleArgument` property.
 */
export type ConversationActionProposal = Readonly<{
  actionKind: ConversationActionKind;
  arguments: Readonly<Record<string, unknown>>;
  requestEventRevisionId: ConversationEventRevisionId;
  schemaVersion: string;
}>;

export type ConversationActionGatewayContext = Readonly<{
  compiledContextId: CompiledContextId;
  decisionCommandId: GenerationCommandId;
  requestEventRevisionId: ConversationEventRevisionId;
  userId: UserId;
}>;

/**
 * The version identity of the Harness execution policy frozen on each Decision
 * Command. It bounds the Decision / Finalization model stages, the number of
 * state-changing Actions, tool round-trips, time and token budget, and when user
 * visible output is permitted (CONTEXT.md "Conversation Harness Policy"). The
 * Framework or Provider cannot widen these limits.
 *
 * The initial policy permits exactly one logical model stage for an ordinary
 * response and zero state-changing Actions, matching the existing single-decision
 * streaming and recovery semantics that #24 must preserve.
 */
export type ConversationHarnessPolicy = Readonly<{
  version: string;
  maxDecisionStages: 1;
  maxStateChangingActions: 0 | 1;
  toolsDisabled?: boolean;
}>;

/**
 * The immutable empty Catalog published by #24. It carries no enabled
 * Definition, so the model has no Conversation Function to select and any Action
 * attempt fails closed. It never exposes internal Journal, Workflow, Claim,
 * Profile, deletion, or CRUD operations.
 */
export const EMPTY_CONVERSATION_ACTION_CATALOG: ConversationActionCatalog =
  Object.freeze({
    definitions: Object.freeze([] as readonly ConversationActionDefinition[]),
    version: "conversation-action-catalog:empty:v1",
  });

/**
 * The Conversation Harness Policy frozen on every Decision Command while the
 * Catalog is empty. An ordinary Turn uses one logical model stage and admits no
 * state-changing Action; technical retries only add ModelRunAttempts under the
 * same Decision Command (ADR-0094).
 */
export const INITIAL_CONVERSATION_HARNESS_POLICY: ConversationHarnessPolicy =
  Object.freeze({
    version: "conversation-harness:v1",
    maxDecisionStages: 1,
    maxStateChangingActions: 0,
  });

export const ACTION_ENABLED_CONVERSATION_HARNESS_POLICY: ConversationHarnessPolicy =
  Object.freeze({
    version: "conversation-harness:v2",
    maxDecisionStages: 1,
    maxStateChangingActions: 1,
  });

/**
 * The policy for Catalog v2 execution (issue #109): multiple coexisting
 * Definitions and the synchronous in-transaction mode are eligible, while the
 * bounded one-state-changing-Action-per-Decision limit is unchanged (ADR-0093).
 * Rollback re-pins conversation-harness:v2.
 */
export const CATALOG_V2_CONVERSATION_HARNESS_POLICY: ConversationHarnessPolicy =
  Object.freeze({
    version: "conversation-harness:v3",
    maxDecisionStages: 1,
    maxStateChangingActions: 1,
  });

export const REGENERATE_JOURNAL_ACTION_DEFINITION: ConversationActionDefinition =
  Object.freeze({
    actionKind: "regenerate_journal",
    availabilityPolicy: "authenticated_owner",
    consistencyPolicy: "exact_head",
    confirmationPolicy: "none",
    effectClass: "derived_artifact_regeneration",
    executionMode: "async",
    functionDescription:
      "Regenerate the current Journal using the same evidence. Optional guidance may improve emphasis, clarity, or organization but cannot change facts.",
    handlerBinding: "journal.regeneration.v1",
    idempotencyScope: "decision_command_action_target",
    inputSchema: Object.freeze({
      additionalProperties: false,
      properties: Object.freeze({
        guidance: Object.freeze({
          maxLength: 1_000,
          type: "string",
        }),
        journalHandle: Object.freeze({
          minLength: 1,
          type: "string",
        }),
      }),
      required: Object.freeze(["journalHandle"]),
      type: "object",
    }),
    ratePolicy: Object.freeze({
      maxInFlightPerTarget: 1 as const,
      name: "journal_regeneration:v1",
    }),
    schemaVersion: "regenerate-journal:v1",
    targetContract: Object.freeze({
      handleArgument: "journalHandle",
      handleKind: "journal",
      versioned: true as const,
    }),
    trustClass: "user_private_derived_artifact",
  });

export const JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG: ConversationActionCatalog =
  Object.freeze({
    definitions: Object.freeze([REGENERATE_JOURNAL_ACTION_DEFINITION]),
    version: "conversation-action-catalog:journal-regeneration:v1",
  });

const MEMORY_TRUST_TARGET_CONTRACT = Object.freeze({
  handleArgument: "targetAnchor",
  handleKind: "memory_claim",
  resolution: "admission_time_anchor" as const,
  versioned: true as const,
});

/**
 * `memory_correction` (issue #119, ADR-0001 / ADR-0118): invalidate a wrong
 * understanding synchronously in the admission transaction — the corrected
 * content stops being recallable the same turn — and optionally record an
 * establishment clause whose structured fact forms forward through ordinary
 * extraction and admission. Impression corrections additionally record the
 * user veto so same-topic impressions re-accumulate fresh cross-Session
 * Evidence from zero (ADR-0039). Correction is a right: no rate limit, no
 * confirmation.
 */
export const MEMORY_CORRECTION_ACTION_DEFINITION: ConversationActionDefinition =
  Object.freeze({
    actionKind: "memory_correction",
    availabilityPolicy: "authenticated_owner",
    consistencyPolicy: "admission_time_target",
    confirmationPolicy: "none",
    effectClass: "memory_trust_control",
    executionMode: "synchronous",
    functionDescription:
      "Record the user's explicit correction of something SayHear remembers. targetAnchor must quote the user's own words that identify the remembered item; optionally include correctedFact quoting what the user now states instead. Only call this when the user is clearly correcting or revoking a remembered understanding — never for ordinary new information.",
    handlerBinding: "memory.correction.v1",
    idempotencyScope: "request_event_revision",
    inputSchema: Object.freeze({
      additionalProperties: false,
      properties: Object.freeze({
        correctedFact: Object.freeze({
          maxLength: 300,
          type: "string",
        }),
        targetAnchor: Object.freeze({
          maxLength: 300,
          minLength: 1,
          type: "string",
        }),
      }),
      required: Object.freeze(["targetAnchor"]),
      type: "object",
    }),
    ratePolicy: Object.freeze({
      maxInFlightPerTarget: null,
      name: "memory_correction:v1",
    }),
    schemaVersion: "memory-correction:v1",
    targetContract: MEMORY_TRUST_TARGET_CONTRACT,
    trustClass: "memory_trust_control",
  });

/**
 * `explain_memory_source` (issue #119, ADR-0008): read-only source
 * explanation. The admission transaction verifies the resolved Claim's
 * Evidence down to valid User Event Revisions and freezes the verdict in the
 * Receipt — dates and the user's actual words, or the `unverifiable` marker
 * that drives the fixed ADR-0008 honesty phrasing. Never fabricates
 * provenance.
 */
export const EXPLAIN_MEMORY_SOURCE_ACTION_DEFINITION: ConversationActionDefinition =
  Object.freeze({
    actionKind: "explain_memory_source",
    availabilityPolicy: "authenticated_owner",
    consistencyPolicy: "admission_time_target",
    confirmationPolicy: "none",
    effectClass: "memory_source_explanation",
    executionMode: "synchronous",
    functionDescription:
      "Explain where a remembered understanding came from, when the user asks why SayHear remembers or believes something. targetAnchor must quote the user's own words that identify the remembered item. Read-only: it never changes what SayHear remembers.",
    handlerBinding: "memory.source-explanation.v1",
    idempotencyScope: "request_event_revision",
    inputSchema: Object.freeze({
      additionalProperties: false,
      properties: Object.freeze({
        targetAnchor: Object.freeze({
          maxLength: 300,
          minLength: 1,
          type: "string",
        }),
      }),
      required: Object.freeze(["targetAnchor"]),
      type: "object",
    }),
    ratePolicy: Object.freeze({
      maxInFlightPerTarget: null,
      name: "memory_explain_source:v1",
    }),
    schemaVersion: "memory-explain-source:v1",
    targetContract: MEMORY_TRUST_TARGET_CONTRACT,
    trustClass: "memory_trust_control",
  });

/**
 * The Catalog v2 go-live set (issue #119): the Journal regeneration
 * Definition plus the first two Trust-Control Definitions end-to-end. The
 * remaining three trust Definitions (`memory_forget_request`,
 * `memory_forget_reversal`, `entity_identity_correction`) join in their own
 * tickets; the five-Definition catalog pin completes at the 1A.3a cutover.
 */
export const MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG: ConversationActionCatalog =
  Object.freeze({
    definitions: Object.freeze([
      REGENERATE_JOURNAL_ACTION_DEFINITION,
      MEMORY_CORRECTION_ACTION_DEFINITION,
      EXPLAIN_MEMORY_SOURCE_ACTION_DEFINITION,
    ]),
    version: "conversation-action-catalog:memory-trust-actions:v1",
  });

/**
 * The Definitions eligible for this Decision: each handle-mode Definition
 * carries at least one ActionReferenceHandle for its kind in the frozen
 * CompiledContext — a Definition without a minted handle exposes no Function
 * this turn. Admission-time-anchor Definitions (ADR-0118 Trust-Control
 * Actions) resolve their targets outside the frozen context, so they are
 * always eligible for the authenticated owner: correcting un-injected memory
 * requires no magic recall.
 */
export function actionDefinitionsForCatalog(
  catalog: ConversationActionCatalog,
  handles: readonly ActionReferenceHandle[] = [],
): readonly ConversationActionDefinition[] {
  if (!validateConversationActionCatalog(catalog).valid) return [];
  return catalog.definitions.filter(
    (definition) =>
      definition.targetContract.resolution === "admission_time_anchor" ||
      handles.some((handle) =>
        handle.actionKinds.includes(definition.actionKind),
      ),
  );
}

/**
 * Definition-driven model-facing Function generation (ADR-0095): one Function
 * per eligible Definition, named by its action kind and described by its own
 * `functionDescription`.
 */
export function conversationFunctionsForActionDefinitions(
  definitions: readonly ConversationActionDefinition[],
): readonly ConversationFunctionDefinition[] {
  return definitions.map((definition) => ({
    description: definition.functionDescription,
    name: definition.actionKind,
    parameters: definition.inputSchema,
    strict: true,
  }));
}

export function actionFunctionsForCatalog(
  catalog: ConversationActionCatalog,
  handles: readonly ActionReferenceHandle[] = [],
): readonly ConversationFunctionDefinition[] {
  return conversationFunctionsForActionDefinitions(
    actionDefinitionsForCatalog(catalog, handles),
  );
}

function stringArgumentMatchesSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
): boolean {
  if (typeof value !== "string") return false;
  const minLength = schema.minLength;
  if (typeof minLength === "number" && value.length < minLength) return false;
  const maxLength = schema.maxLength;
  if (typeof maxLength === "number" && value.length > maxLength) return false;
  return true;
}

/**
 * Normalizes a provider Function selection into the provider-independent
 * `ConversationActionProposal` union against the frozen Definition set the
 * Decision Command offered (ADR-0095). Unknown names and Schema-violating
 * arguments fail closed as `{ type: "invalid" }`.
 */
export function normalizeProviderActionProposal(input: {
  rawArguments: string;
  rawFunctionName: string;
  requestEventRevisionId: ConversationEventRevisionId;
  definitions: readonly ConversationActionDefinition[];
}):
  | Readonly<{
      proposal: ConversationActionProposal;
      type: "normalized";
    }>
  | Readonly<{ type: "invalid" }> {
  const definition = input.definitions.find(
    (candidate) => candidate.actionKind === input.rawFunctionName,
  );
  if (!definition) return { type: "invalid" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawArguments);
  } catch {
    return { type: "invalid" };
  }
  if (!isRecord(parsed)) return { type: "invalid" };
  const schemaProperties = definition.inputSchema.properties;
  for (const key of Object.keys(parsed)) {
    if (!(key in schemaProperties)) return { type: "invalid" };
    if (
      schemaProperties[key]?.type === "string" &&
      !stringArgumentMatchesSchema(parsed[key], schemaProperties[key]!)
    ) {
      return { type: "invalid" };
    }
  }
  for (const requiredKey of definition.inputSchema.required) {
    const requiredSchema = schemaProperties[requiredKey];
    if (
      !(requiredKey in parsed) ||
      (requiredSchema?.type === "string" &&
        !stringArgumentMatchesSchema(parsed[requiredKey], requiredSchema!))
    ) {
      return { type: "invalid" };
    }
  }
  return {
    proposal: {
      actionKind: definition.actionKind,
      arguments: { ...parsed },
      requestEventRevisionId: input.requestEventRevisionId,
      schemaVersion: definition.schemaVersion,
    },
    type: "normalized",
  };
}

/**
 * Catalog publication check (ADR-0091 / ADR-0098 / ADR-0100). Any number of
 * coexisting Definitions validates when every one satisfies the cross-cutting
 * contract: owner-only availability, no secondary confirmation, a bounded
 * execution mode, a safe closed object schema whose required target-handle
 * property is declared by `targetContract.handleArgument`, and non-empty
 * capability identities. Anything else fails closed.
 */
export function validateConversationActionCatalog(
  catalog: ConversationActionCatalog,
): { valid: true } | { valid: false; reason: string } {
  if (!catalog.version || !Array.isArray(catalog.definitions)) {
    return { valid: false, reason: "invalid_catalog" };
  }
  const seen = new Set<string>();
  for (const definition of catalog.definitions) {
    if (typeof definition?.actionKind !== "string" || definition.actionKind.length === 0) {
      return { valid: false, reason: "invalid_definition_contract" };
    }
    if (seen.has(definition.actionKind)) {
      return { valid: false, reason: "duplicate_action_kind" };
    }
    seen.add(definition.actionKind);
    const schema = definition.inputSchema;
    const propertyNames: readonly string[] = Object.keys(
      schema?.properties ?? {},
    );
    const requiredKeys: readonly string[] = schema?.required ?? [];
    const handleArgument =
      typeof definition.targetContract?.handleArgument === "string"
        ? definition.targetContract.handleArgument
        : null;
    const handleSchema = handleArgument ? schema.properties[handleArgument] : undefined;
    const minHandleLength = handleSchema?.minLength;
    if (
      definition.availabilityPolicy !== "authenticated_owner" ||
      definition.confirmationPolicy !== "none" ||
      (definition.executionMode !== "async" &&
        definition.executionMode !== "synchronous") ||
      typeof definition.consistencyPolicy !== "string" ||
      definition.consistencyPolicy.length === 0 ||
      typeof definition.effectClass !== "string" ||
      definition.effectClass.length === 0 ||
      typeof definition.trustClass !== "string" ||
      definition.trustClass.length === 0 ||
      typeof definition.handlerBinding !== "string" ||
      definition.handlerBinding.length === 0 ||
      typeof definition.idempotencyScope !== "string" ||
      definition.idempotencyScope.length === 0 ||
      typeof definition.functionDescription !== "string" ||
      definition.functionDescription.length === 0 ||
      typeof definition.schemaVersion !== "string" ||
      definition.schemaVersion.length === 0 ||
      typeof definition.ratePolicy?.name !== "string" ||
      definition.ratePolicy.name.length === 0 ||
      !(
        definition.ratePolicy.maxInFlightPerTarget === null ||
        (Number.isSafeInteger(definition.ratePolicy.maxInFlightPerTarget) &&
          definition.ratePolicy.maxInFlightPerTarget > 0)
      ) ||
      definition.targetContract?.versioned !== true ||
      typeof definition.targetContract.handleKind !== "string" ||
      definition.targetContract.handleKind.length === 0 ||
      handleArgument === null ||
      handleSchema === undefined ||
      handleSchema.type !== "string" ||
      typeof minHandleLength !== "number" ||
      minHandleLength < 1 ||
      !requiredKeys.includes(handleArgument) ||
      schema.type !== "object" ||
      schema.additionalProperties !== false ||
      propertyNames.length === 0 ||
      new Set(requiredKeys).size !== requiredKeys.length ||
      requiredKeys.some((key) => !propertyNames.includes(key))
    ) {
      return { valid: false, reason: "invalid_definition_contract" };
    }
  }
  return { valid: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
