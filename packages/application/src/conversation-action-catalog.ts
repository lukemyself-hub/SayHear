import type { ConversationEventRevisionId } from "@sayhear/domain";

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
export type ConversationActionKind = string;

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
  schemaVersion: string;
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
  actionKind: never;
  requestEventRevisionId: ConversationEventRevisionId;
  schemaVersion: string;
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
  maxStateChangingActions: 0;
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
