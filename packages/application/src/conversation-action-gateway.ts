import type {
  ConversationActionCatalog,
  ConversationActionDefinition,
  ConversationActionGatewayContext,
  ConversationActionProposal,
} from "./conversation-action-catalog";
import { validateConversationActionCatalog } from "./conversation-action-catalog";
import type { ActionReferenceBinding } from "./conversation-action-handles";
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
 * executionMode:
 *
 * - `durable_workflow` — the repository creates an idempotent workflow command
 *   / outbox entry inside the admission transaction (regenerate_journal).
 * - `in_transaction` — `commit` performs this Action's authoritative domain
 *   writes during that same admission transaction through the transaction-
 *   scoped executor; any throw rolls the whole admission back, so no partial
 *   effect can survive while a reply claims success (ADR-0099).
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
      }): Promise<void>;
      dailySessionId: string;
      expectedDataEpoch: number;
      mode: "in_transaction";
      sourceRevision: number;
      targetVersionId: string;
    }>;

/**
 * Transaction-scoped write surface handed to a synchronous in-transaction
 * handler's `commit`. Statements issued here join the single admission
 * transaction (ADR-0099).
 */
export interface ConversationActionTransactionExecutor {
  query(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ rowCount: number | null }>;
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

export type ConversationActionHandler = Readonly<{
  actionKind: string;
  prepare(input: {
    definition: ConversationActionDefinition;
    proposal: ConversationActionProposal;
    target: ActionReferenceBinding;
  }): PreparedConversationAction;
}>;

export type ConversationActionGatewayRepository = Readonly<{
  commitAccepted(input: {
    catalogVersion: string;
    context: ConversationActionGatewayContext;
    definition: ConversationActionDefinition;
    prepare: () => PreparedConversationAction;
    proposal: ConversationActionProposal;
  }): Promise<ConversationActionReceipt>;
  commitNonAccepted(input: {
    admission: Exclude<ConversationActionAdmission, "accepted">;
    catalogVersion: string;
    context: ConversationActionGatewayContext;
    definition: ConversationActionDefinition | null;
    disposition: string | null;
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
            target,
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
  return [
    context.decisionCommandId,
    context.requestEventRevisionId,
    proposal.actionKind,
    readTargetHandleArgument(proposal, definition) ?? "none",
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
