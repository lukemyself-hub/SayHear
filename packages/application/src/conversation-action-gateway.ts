import type {
  ConversationActionCatalog,
  ConversationActionDefinition,
  ConversationActionGatewayContext,
  ConversationActionProposal,
} from "./conversation-action-catalog";
import { validateConversationActionCatalog } from "./conversation-action-catalog";
import type { ActionReferenceBinding } from "./conversation-action-handles";
import {
  isPersonWideMemoryForgetAnchor,
  MEMORY_FORGET_UNSUPPORTED_SCOPE_REASON,
} from "./memory-trust-actions";
import type {
  ConversationEventRevisionId,
  InteractionTurnId,
} from "@sayhear/domain";

export type ConversationActionAdmission =
  | "accepted"
  | "clarification_required"
  | "rejected"
  | "unsupported";

export type ConversationActionExecution =
  | "not_started"
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type ConversationActionReceipt = Readonly<{
  actionExecutionId: string;
  actionKind: string;
  admission: ConversationActionAdmission;
  catalogVersion: string;
  disposition: string | null;
  execution: ConversationActionExecution;
  receiptSequence: number;
  schemaVersion: string;
  finalization?: Readonly<{
    generationCommandId: string;
    modelRunAttemptId: string;
  }>;
}>;

/**
 * The prepared action a Handler derives from the verified context and typed
 * input (ADR-0098). The `mode` discriminant mirrors the Definition's
 * executionMode and target contract:
 *
 * - `durable_workflow` — the repository creates an idempotent workflow command
 *   / outbox entry inside the admission transaction (regenerate_journal).
 * - `in_transaction` — `commit` performs this Action's authoritative domain
 *   writes during that same admission transaction through the transaction-
 *   scoped executor; any throw rolls the whole admission back, so no partial
 *   effect can survive while a reply claims success (ADR-0099). Handle-mode
 *   target fields must match the locked handle.
 * - `in_transaction_anchor` — the same synchronous in-transaction commit for
 *   an admission-time-anchor Definition (ADR-0118): the target is the claim
 *   the Gateway resolved from the owner-scoped structured-lexical anchor, and
 *   the repository re-verifies it under lock inside the transaction.
 *
 * `commit` returns the terminal Completion Receipt disposition (or void for
 * the plain `committed_in_transaction` outcome).
 */
export type PreparedConversationAction =
  | Readonly<{
      actionKind: "regenerate_journal";
      dailySessionId: string;
      expectedDataEpoch: number;
      guidance: string | null;
      generationPolicyVersion: string;
      mode: "durable_workflow";
      sourceRevision: number;
      targetVersionId: string;
    }>
  | Readonly<{
      actionKind: string;
      commit(input: {
        actionExecutionId: string;
        executor: ConversationActionTransactionExecutor;
        userId: string;
      }): Promise<string | void>;
      dailySessionId: string;
      expectedDataEpoch: number;
      mode: "in_transaction";
      sourceRevision: number;
      targetVersionId: string;
    }>
  | Readonly<{
      actionKind: string;
      commit(input: {
        actionExecutionId: string;
        executor: ConversationActionTransactionExecutor;
        userId: string;
      }): Promise<string | void>;
      mode: "in_transaction_anchor";
      resolvedClaimId: string;
      resolvedClaimVersionId: string;
      resolvedQualifierId?: string;
      resolvedTargetKind: "memory_claim" | "relationship_qualifier";
    }>;

/**
 * Transaction-scoped read/write surface handed to a synchronous in-transaction
 * handler's `commit` and the trust-action commit port. Statements issued here
 * join the single admission transaction (ADR-0099).
 */
export interface ConversationActionTransactionExecutor {
  query<T = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount: number | null; rows: T[] }>;
}

export type JournalRegenerationWorkflowCommand = Readonly<{
  actionExecutionId: string;
  dailySessionId: string;
  expectedDataEpoch: number;
  generationCommandId: string;
  generationPolicyVersion: string;
  guidance: string | null;
  modelRunAttemptId: string | null;
  sourceRevision: number;
  targetVersionId: string;
  userId: ConversationActionGatewayContext["userId"];
  workflowCommandId: string;
}>;

export type JournalRegenerationExecutionOutcome =
  | "canceled"
  | "failed"
  | "succeeded";

export type ConversationActionFinalizationCommand = Readonly<{
  actionExecutionId: string;
  generationCommandId: string;
  interactionTurnId: InteractionTurnId;
  modelRunAttemptId: string;
  requestEventRevisionId: ConversationEventRevisionId;
  receipt: Readonly<{
    admission: ConversationActionAdmission;
    disposition: string | null;
    execution: ConversationActionExecution;
    sequence: number;
  }>;
  userId: ConversationActionGatewayContext["userId"];
}>;

/**
 * The typed reference to the real Claim an admission-time anchor resolved to
 * (ADR-0118). It enters Receipts / Execution records for auditability.
 */
export type ResolvedTrustActionTarget = Readonly<{
  claimId: string;
  claimKind: "objective" | "impression";
  claimVersionId: string;
  predicateId: string;
  targetKind: "memory_claim" | "relationship_qualifier";
  qualifierId?: string;
  qualifierAxisId?: string;
  qualifierRoleSide?: "canonical_subject" | "counterpart";
  qualifierTypedValue?: string | readonly string[];
}>;

/**
 * The deterministic admission-time resolution outcome (ADR-0118): only a
 * unique high-confidence hit admits; a multi-hit clarifies with a count and
 * never lists or preselects; a zero-hit honestly reports nothing found.
 */
export type TrustActionTargetResolution =
  | Readonly<{ outcome: "unique"; target: ResolvedTrustActionTarget }>
  | Readonly<{ outcome: "scope_ambiguous" }>
  | Readonly<{ candidateCount: number; outcome: "multi_hit" }>
  | Readonly<{ outcome: "unsupported_scope"; reasonCode: string }>
  | Readonly<{ outcome: "zero_hit" }>;

/**
 * Owner-scoped bounded structured-lexical target resolution over the
 * Action's search space (Correction / Source Explanation search active
 * Claims; Reversal will search only the fenced set when it publishes).
 */
export type TrustActionTargetResolver = Readonly<{
  resolve(input: {
    actionKind: string;
    userId: string;
    anchor: string;
  }): Promise<TrustActionTargetResolution>;
}>;

export type ConversationActionHandler = Readonly<{
  actionKind: string;
  prepare(input: {
    definition: ConversationActionDefinition;
    proposal: ConversationActionProposal;
    /** Handle-mode target (ADR-0096); present only when a locked handle backs the proposal. */
    target?: ActionReferenceBinding;
    /** Anchor-mode target (ADR-0118); present only when admission-time resolution admitted. */
    resolvedTarget?: ResolvedTrustActionTarget;
  }): PreparedConversationAction;
}>;

export type ConversationActionGatewayRepository = Readonly<{
  commitAccepted(input: {
    catalogVersion: string;
    context: ConversationActionGatewayContext;
    definition: ConversationActionDefinition;
    /** Anchor-mode resolved target; absent for handle-mode admissions. */
    resolvedClaim?: Readonly<{ claimId: string; claimVersionId: string }>;
    /** Full typed target for Trust-Control Actions, including Qualifiers. */
    resolvedTarget?: ResolvedTrustActionTarget;
    prepare: () => PreparedConversationAction;
    proposal: ConversationActionProposal;
  }): Promise<ConversationActionReceipt>;
  commitNonAccepted(input: {
    admission: Exclude<ConversationActionAdmission, "accepted">;
    catalogVersion: string;
    context: ConversationActionGatewayContext;
    definition: ConversationActionDefinition | null;
    disposition: string | null;
    /** Structured no-prose detail (IDs / counts / codes only, ADR-0101). */
    dispositionDetail?: Readonly<Record<string, unknown>>;
    proposal: ConversationActionProposal | null;
    schemaVersion: string;
  }): Promise<ConversationActionReceipt>;
  findByIdempotencyKey(input: {
    context: ConversationActionGatewayContext;
    idempotencyKey: string;
  }): Promise<ConversationActionReceipt | null>;
  hasInFlightTarget(input: {
    targetId: string;
    userId: ConversationActionGatewayContext["userId"];
  }): Promise<boolean>;
  purgeExpiredGuidance?(now: Date): Promise<number>;
  resolveHandle(input: {
    context: ConversationActionGatewayContext;
    handle: string;
  }): Promise<ActionReferenceBinding | null>;
  readRegenerationWorkflowCommand?(input: {
    workflowCommandId: string;
  }): Promise<JournalRegenerationWorkflowCommand | null>;
  claimRegenerationExecution?(input: {
    actionExecutionId: string;
  }): Promise<"execute" | "replayed">;
  recordRegenerationExecution?(input: {
    actionExecutionId: string;
    disposition: string;
    outcome: JournalRegenerationExecutionOutcome;
  }): Promise<void>;
  listPendingFinalizations?(input: {
    limit: number;
  }): Promise<readonly ConversationActionFinalizationCommand[]>;
}>;

export type ConversationActionGateway = Readonly<{
  admit(input: {
    catalog: ConversationActionCatalog;
    context: ConversationActionGatewayContext;
    proposal: ConversationActionProposal | null;
  }): Promise<ConversationActionReceipt>;
  listPendingFinalizations?(input: {
    limit: number;
  }): Promise<readonly ConversationActionFinalizationCommand[]>;
}>;

export function createConversationActionGateway(input: {
  /**
   * One typed handler per enabled action kind (ADR-0098). A proposal whose
   * Definition has no bound handler fails closed.
   */
  handlers: readonly ConversationActionHandler[];
  repository: ConversationActionGatewayRepository;
  /**
   * Required to admit an admission-time-anchor Definition (ADR-0118): the
   * deterministic owner-scoped structured-lexical target resolution. A trust
   * proposal arriving without a configured resolver fails closed.
   */
  trustActionTargetResolver?: TrustActionTargetResolver;
}): ConversationActionGateway {
  const handlersByKind = new Map(
    input.handlers.map((handler) => [handler.actionKind, handler]),
  );
  return {
    async admit(request) {
      await input.repository.purgeExpiredGuidance?.(new Date());
      const proposal = request.proposal;
      const catalogValidation = validateConversationActionCatalog(request.catalog);
      if (!catalogValidation.valid) {
        return input.repository.commitNonAccepted({
          admission: "unsupported",
          catalogVersion: request.catalog.version,
          context: request.context,
          definition: null,
          disposition: catalogValidation.reason,
          proposal,
          schemaVersion: proposal?.schemaVersion ?? "unknown",
        });
      }
      const definition = proposal
        ? request.catalog.definitions.find(
            (candidate) => candidate.actionKind === proposal.actionKind,
          ) ?? null
        : null;
      const schemaVersion = proposal?.schemaVersion ?? "unknown";
      const idempotencyKey = proposal
        ? createIdempotencyKey(request.context, proposal, definition)
        : null;

      if (idempotencyKey) {
        const existing = await input.repository.findByIdempotencyKey({
          context: request.context,
          idempotencyKey,
        });
        if (existing) return existing;
      }

      if (!proposal || !definition || definition.schemaVersion !== schemaVersion) {
        return input.repository.commitNonAccepted({
          admission: "unsupported",
          catalogVersion: request.catalog.version,
          context: request.context,
          definition,
          disposition: "catalog_or_schema",
          proposal,
          schemaVersion,
        });
      }

      const validation = validateProposal(
        proposal,
        definition,
        request.context.requestEventRevisionId,
      );
      if (!validation.valid) {
        return input.repository.commitNonAccepted({
          admission: "unsupported",
          catalogVersion: request.catalog.version,
          context: request.context,
          definition,
          disposition: validation.reason,
          proposal,
          schemaVersion,
        });
      }

      // ADR-0118: admission-time deterministic owner-scoped structured-lexical
      // target resolution for Trust-Control Actions. The model-side contract
      // is unchanged (ADR-0096) — the anchor span is a resolution clue, never
      // a free-text selector. Unique high-confidence hit admits; multi-hit
      // returns a count-only clarification without listing or preselecting;
      // zero hit honestly reports nothing found with zero domain change.
      if (definition.targetContract.resolution === "admission_time_anchor") {
        if (!input.trustActionTargetResolver) {
          throw new Error(
            `No Trust Action target resolver is configured for kind "${definition.actionKind}".`,
          );
        }
        const targetAnchor = String(
          proposal.arguments[definition.targetContract.handleArgument],
        );
        if (
          (definition.actionKind === "memory_forget_request" ||
            definition.actionKind === "memory_forget_reversal") &&
          isPersonWideMemoryForgetAnchor(targetAnchor)
        ) {
          return input.repository.commitNonAccepted({
            admission: "unsupported",
            catalogVersion: request.catalog.version,
            context: request.context,
            definition,
            disposition: MEMORY_FORGET_UNSUPPORTED_SCOPE_REASON,
            proposal,
            schemaVersion,
          });
        }
        const resolution = await input.trustActionTargetResolver.resolve({
          actionKind: definition.actionKind,
          anchor: targetAnchor,
          userId: request.context.userId,
        });
        if (resolution.outcome === "multi_hit") {
          return input.repository.commitNonAccepted({
            admission: "clarification_required",
            catalogVersion: request.catalog.version,
            context: request.context,
            definition,
            disposition: "target_ambiguous_multi_hit",
            dispositionDetail: { candidateCount: resolution.candidateCount },
            proposal,
            schemaVersion,
          });
        }
        if (resolution.outcome === "scope_ambiguous") {
          return input.repository.commitNonAccepted({
            admission: "clarification_required",
            catalogVersion: request.catalog.version,
            context: request.context,
            definition,
            disposition: "scope_ambiguous",
            proposal,
            schemaVersion,
          });
        }
        if (resolution.outcome === "unsupported_scope") {
          return input.repository.commitNonAccepted({
            admission: "unsupported",
            catalogVersion: request.catalog.version,
            context: request.context,
            definition,
            disposition: resolution.reasonCode,
            proposal,
            schemaVersion,
          });
        }
        if (resolution.outcome === "zero_hit") {
          return input.repository.commitNonAccepted({
            admission: "clarification_required",
            catalogVersion: request.catalog.version,
            context: request.context,
            definition,
            disposition:
              definition.actionKind === "memory_forget_reversal"
                ? "target_not_fenced"
                : "target_not_found",
            proposal,
            schemaVersion,
          });
        }
        return input.repository.commitAccepted({
          catalogVersion: request.catalog.version,
          context: request.context,
          definition,
          resolvedTarget: resolution.target,
          resolvedClaim: {
            claimId: resolution.target.claimId,
            claimVersionId: resolution.target.claimVersionId,
          },
          prepare: () => {
            const handler = handlersByKind.get(definition.actionKind);
            if (!handler) {
              throw new Error(
                `No Conversation Action Handler is bound for kind "${definition.actionKind}".`,
              );
            }
            return handler.prepare({
              definition,
              proposal,
              resolvedTarget: resolution.target,
            });
          },
          proposal,
        });
      }

      const target = await input.repository.resolveHandle({
        context: request.context,
        handle: readTargetHandleArgument(proposal, definition)!,
      });
      if (!target || !target.actionKinds.includes(proposal.actionKind)) {
        return input.repository.commitNonAccepted({
          admission: "rejected",
          catalogVersion: request.catalog.version,
          context: request.context,
          definition,
          disposition: "handle_invalid_or_not_owned",
          proposal,
          schemaVersion,
        });
      }
      if (
        target.ownerStatus !== undefined &&
        target.ownerStatus !== "active"
      ) {
        return input.repository.commitNonAccepted({
          admission: "rejected",
          catalogVersion: request.catalog.version,
          context: request.context,
          definition,
          disposition: "owner_or_deletion_fence",
          proposal,
          schemaVersion,
        });
      }
      if (
        target.currentVersionStatus !== undefined &&
        target.targetKind === "journal" &&
        target.currentVersionStatus !== "published"
      ) {
        return input.repository.commitNonAccepted({
          admission: "rejected",
          catalogVersion: request.catalog.version,
          context: request.context,
          definition,
          disposition: "source_invalid",
          proposal,
          schemaVersion,
        });
      }
      if (target.currentVersionId !== target.targetVersionId) {
        return input.repository.commitNonAccepted({
          admission: "clarification_required",
          catalogVersion: request.catalog.version,
          context: request.context,
          definition,
          disposition: "exact_head_advanced",
          proposal,
          schemaVersion,
        });
      }
      if (
        definition.ratePolicy.maxInFlightPerTarget !== null &&
        (await input.repository.hasInFlightTarget({
          targetId: target.targetId,
          userId: request.context.userId,
        }))
      ) {
        return input.repository.commitNonAccepted({
          admission: "rejected",
          catalogVersion: request.catalog.version,
          context: request.context,
          definition,
          disposition: "rate_limited_in_flight",
          proposal,
          schemaVersion,
        });
      }

      return input.repository.commitAccepted({
        catalogVersion: request.catalog.version,
        context: request.context,
        definition,
        prepare: () => {
          const handler = handlersByKind.get(definition.actionKind);
          if (!handler) {
            throw new Error(
              `No Conversation Action Handler is bound for kind "${definition.actionKind}".`,
            );
          }
          return handler.prepare({
            definition,
            proposal,
            // The anchor branch returned above; a handle-mode admission
            // here always carries the resolved, locked handle.
            target: target!,
          });
        },
        proposal,
      });
    },
    ...(input.repository.listPendingFinalizations
      ? {
          listPendingFinalizations(inputRequest: { limit: number }) {
            return input.repository.listPendingFinalizations!(inputRequest);
          },
        }
      : {}),
  };
}

export function createJournalRegenerationActionHandler(input: {
  generationPolicyVersion: string;
  maxGuidanceLength?: number;
}): ConversationActionHandler {
  const maxGuidanceLength = input.maxGuidanceLength ?? 1_000;
  if (!Number.isSafeInteger(maxGuidanceLength) || maxGuidanceLength <= 0) {
    throw new Error("maxGuidanceLength must be a positive safe integer.");
  }
  return {
    actionKind: "regenerate_journal",
    prepare({ proposal, target }) {
      if (!target) {
        throw new Error(
          "Journal regeneration requires its command-scoped handle target.",
        );
      }
      const rawGuidance = proposal.arguments.guidance;
      const guidance =
        typeof rawGuidance === "string" ? rawGuidance.trim() : "";
      if (guidance.length > maxGuidanceLength) {
        throw new Error("Regeneration Guidance exceeds its bounded length.");
      }
      return {
        actionKind: "regenerate_journal",
        dailySessionId: target.dailySessionId,
        expectedDataEpoch: target.expectedDataEpoch,
        guidance: guidance || null,
        generationPolicyVersion: input.generationPolicyVersion,
        mode: "durable_workflow",
        sourceRevision: target.sourceRevision,
        targetVersionId: target.targetVersionId,
      };
    },
  };
}

function createIdempotencyKey(
  context: ConversationActionGatewayContext,
  proposal: ConversationActionProposal,
  definition: ConversationActionDefinition | null,
): string {
  return createConversationActionIdempotencyKey(context, proposal, definition);
}

/**
 * The single source of the Action execution idempotency key (SPEC story 48).
 * Trust-Control Actions (`idempotencyScope: "request_event_revision"`) key on
 * the request event revision, so transport retries of the same request event
 * resolve to the same ActionExecution and its existing Receipts. Every other
 * scope keys on the decision command + target handle. The user scoping lives
 * in the repository's UNIQUE (user_id, idempotency_key). The data-layer
 * repository imports this function — the two sides can never drift.
 */
export function createConversationActionIdempotencyKey(
  context: ConversationActionGatewayContext,
  proposal: ConversationActionProposal | null,
  definition: ConversationActionDefinition | null,
): string {
  if (definition?.idempotencyScope === "request_event_revision") {
    return [
      context.requestEventRevisionId,
      proposal?.actionKind ?? "unsupported",
    ].join(":");
  }
  return [
    context.decisionCommandId,
    context.requestEventRevisionId,
    proposal?.actionKind ?? "unsupported",
    proposal && definition
      ? readTargetHandleArgument(proposal, definition) ?? "none"
      : "none",
  ].join(":");
}

/**
 * Reads the target reference handle under the Definition's declared
 * `targetContract.handleArgument` property (ADR-0096). Returns null when the
 * proposal carries anything other than a non-empty string there.
 */
function readTargetHandleArgument(
  proposal: ConversationActionProposal,
  definition: ConversationActionDefinition | null,
): string | null {
  if (!definition) return null;
  const value = proposal.arguments[definition.targetContract.handleArgument];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validateProposal(
  proposal: ConversationActionProposal,
  definition: ConversationActionDefinition,
  requestEventRevisionId: ConversationActionGatewayContext["requestEventRevisionId"],
): { valid: true } | { valid: false; reason: string } {
  if (proposal.requestEventRevisionId !== requestEventRevisionId) {
    return { valid: false, reason: "request_revision_mismatch" };
  }
  if (
    !proposal.arguments ||
    Object.keys(proposal.arguments).some((key) => !(key in definition.inputSchema.properties))
  ) {
    return { valid: false, reason: "malformed_arguments" };
  }
  for (const [key, schema] of Object.entries(definition.inputSchema.properties)) {
    const value = proposal.arguments[key];
    if (value === undefined) continue;
    if (schema.type === "string") {
      if (typeof value !== "string") {
        return { valid: false, reason: "malformed_arguments" };
      }
      const minLength = schema.minLength;
      if (typeof minLength === "number" && value.length < minLength) {
        return { valid: false, reason: "malformed_arguments" };
      }
      const maxLength = schema.maxLength;
      if (typeof maxLength === "number" && value.length > maxLength) {
        return { valid: false, reason: "malformed_arguments" };
      }
    }
  }
  for (const requiredKey of definition.inputSchema.required) {
    const schema = definition.inputSchema.properties[requiredKey];
    const value = proposal.arguments[requiredKey];
    if (schema?.type === "string") {
      if (
        typeof value !== "string" ||
        value.length < ((schema.minLength as number | undefined) ?? 0) ||
        (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      ) {
        return { valid: false, reason: "malformed_arguments" };
      }
    } else if (value === undefined) {
      return { valid: false, reason: "malformed_arguments" };
    }
  }
  return { valid: true };
}
