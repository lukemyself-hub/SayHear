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
}>;

export type ConversationActionSchema = Readonly<{
  additionalProperties: false;
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  required: readonly string[];
  type: "object";
}>;

/**
 * A single capability descriptor in the Catalog. The full capability metadata
 * (input schema, target/effect/trust class, confirmation, execution mode,
 * idempotency, consistency, rate, receipt, availability, handler binding) is
 * populated when #25 publishes the first Definition. Issue #24 only freezes the
 * Catalog seam and the empty initial instance, so this type carries the kind and
 * schema version identity a Decision Command must record.
 */
export type ConversationActionDefinition = Readonly<{
  actionKind: ConversationActionKind;
  availabilityPolicy: "authenticated_owner";
  consistencyPolicy: "exact_head";
  confirmationPolicy: "none";
  effectClass: "derived_artifact_regeneration";
  executionMode: "async";
  handlerBinding: "journal.regeneration.v1";
  idempotencyScope: "decision_command_action_target";
  inputSchema: ConversationActionSchema;
  ratePolicy: Readonly<{
    maxInFlightPerTarget: 1;
    name: "journal_regeneration:v1";
  }>;
  schemaVersion: string;
  targetContract: Readonly<{
    handleKind: "journal";
    versioned: true;
  }>;
  trustClass: "user_private_derived_artifact";
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
 * The provider-independent normalized Action selection. The Provider Adapter
 * must produce this from a native function / strict-structured-output selection
 * before the application seam (issue #24 AC6). With an empty Catalog no valid
 * `actionKind` exists, so the type is uninhabited and the Harness must fail
 * closed rather than accept or invent an Action (AC8).
 */
export type ConversationActionProposal = Readonly<{
  actionKind: "regenerate_journal";
  arguments: Readonly<{
    guidance?: string;
    journalHandle: string;
  }>;
  requestEventRevisionId: ConversationEventRevisionId;
  schemaVersion: "regenerate-journal:v1";
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

export const REGENERATE_JOURNAL_ACTION_DEFINITION: ConversationActionDefinition =
  Object.freeze({
    actionKind: "regenerate_journal",
    availabilityPolicy: "authenticated_owner",
    consistencyPolicy: "exact_head",
    confirmationPolicy: "none",
    effectClass: "derived_artifact_regeneration",
    executionMode: "async",
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
      maxInFlightPerTarget: 1,
      name: "journal_regeneration:v1",
    }),
    schemaVersion: "regenerate-journal:v1",
    targetContract: Object.freeze({
      handleKind: "journal",
      versioned: true,
    }),
    trustClass: "user_private_derived_artifact",
  });

export const JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG: ConversationActionCatalog =
  Object.freeze({
    definitions: Object.freeze([REGENERATE_JOURNAL_ACTION_DEFINITION]),
    version: "conversation-action-catalog:journal-regeneration:v1",
  });

export function actionFunctionsForCatalog(
  catalog: ConversationActionCatalog,
  handles: readonly ActionReferenceHandle[] = [],
): readonly ConversationFunctionDefinition[] {
  if (!validateConversationActionCatalog(catalog).valid) return [];
  return catalog.definitions.flatMap((definition) => {
    if (definition.actionKind !== "regenerate_journal") return [];
    const handlesForAction = handles.filter((handle) =>
      handle.actionKinds.includes(definition.actionKind),
    );
    if (handlesForAction.length === 0) return [];
    return [
      {
        description:
          "Regenerate the current Journal using the same evidence. Optional guidance may improve emphasis, clarity, or organization but cannot change facts.",
        name: definition.actionKind,
        parameters: definition.inputSchema,
        strict: true,
      },
    ];
  });
}

export function normalizeProviderActionProposal(input: {
  rawArguments: string;
  rawFunctionName: string;
  requestEventRevisionId: ConversationEventRevisionId;
  functions: readonly ConversationFunctionDefinition[];
}):
  | Readonly<{
      proposal: ConversationActionProposal;
      type: "normalized";
    }>
  | Readonly<{ type: "invalid" }> {
  const definition = input.functions.find(
    (candidate) => candidate.name === input.rawFunctionName,
  );
  if (!definition || definition.strict !== true) return { type: "invalid" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawArguments);
  } catch {
    return { type: "invalid" };
  }
  if (!isRecord(parsed) || typeof parsed.journalHandle !== "string") {
    return { type: "invalid" };
  }
  if (
    Object.keys(parsed).some(
      (key) => key !== "journalHandle" && key !== "guidance",
    ) ||
    parsed.journalHandle.length === 0
  ) {
    return { type: "invalid" };
  }
  if (
    parsed.guidance !== undefined &&
    (typeof parsed.guidance !== "string" ||
      parsed.guidance.length >
        Number(
          REGENERATE_JOURNAL_ACTION_DEFINITION.inputSchema.properties.guidance
            ?.maxLength ?? 1_000,
        ))
  ) {
    return { type: "invalid" };
  }
  return {
    proposal: {
      actionKind: "regenerate_journal",
      arguments: {
        journalHandle: parsed.journalHandle,
        ...(parsed.guidance === undefined ? {} : { guidance: parsed.guidance }),
      },
      requestEventRevisionId: input.requestEventRevisionId,
      schemaVersion: "regenerate-journal:v1",
    },
    type: "normalized",
  };
}

export function validateConversationActionCatalog(
  catalog: ConversationActionCatalog,
): { valid: true } | { valid: false; reason: string } {
  if (!catalog.version || !Array.isArray(catalog.definitions)) {
    return { valid: false, reason: "invalid_catalog" };
  }
  if (catalog.definitions.length > 1) {
    return { valid: false, reason: "multiple_action_definitions" };
  }
  const seen = new Set<string>();
  for (const definition of catalog.definitions) {
    if (seen.has(definition.actionKind)) {
      return { valid: false, reason: "duplicate_action_kind" };
    }
    seen.add(definition.actionKind);
    const propertyNames = Object.keys(definition.inputSchema.properties).sort();
    if (
      definition.actionKind !== "regenerate_journal" ||
      definition.availabilityPolicy !== "authenticated_owner" ||
      definition.consistencyPolicy !== "exact_head" ||
      definition.effectClass !== "derived_artifact_regeneration" ||
      definition.trustClass !== "user_private_derived_artifact" ||
      definition.confirmationPolicy !== "none" ||
      definition.executionMode !== "async" ||
      definition.handlerBinding !== "journal.regeneration.v1" ||
      definition.idempotencyScope !== "decision_command_action_target" ||
      definition.targetContract.versioned !== true ||
      definition.targetContract.handleKind !== "journal" ||
      definition.ratePolicy.maxInFlightPerTarget !== 1 ||
      definition.ratePolicy.name !== "journal_regeneration:v1" ||
      definition.inputSchema.type !== "object" ||
      definition.inputSchema.additionalProperties !== false ||
      definition.inputSchema.required.length !== 1 ||
      definition.inputSchema.required[0] !== "journalHandle" ||
      propertyNames.length !== 2 ||
      propertyNames[0] !== "guidance" ||
      propertyNames[1] !== "journalHandle" ||
      definition.inputSchema.properties.journalHandle?.type !== "string" ||
      definition.inputSchema.properties.journalHandle?.minLength !== 1 ||
      definition.inputSchema.properties.guidance?.type !== "string" ||
      definition.inputSchema.properties.guidance?.maxLength !== 1_000
    ) {
      return { valid: false, reason: "invalid_definition_contract" };
    }
  }
  return { valid: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
