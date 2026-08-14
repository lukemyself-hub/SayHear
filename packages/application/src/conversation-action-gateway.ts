import type {
  ConversationActionCatalog,
  ConversationActionDefinition,
  ConversationActionGatewayContext,
  ConversationActionProposal,
} from "./conversation-action-catalog";
import { validateConversationActionCatalog } from "./conversation-action-catalog";
import type { ActionReferenceBinding } from "./conversation-action-handles";

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
}>;

export type PreparedConversationAction = Readonly<{
  actionKind: "regenerate_journal";
  dailySessionId: string;
  expectedDataEpoch: number;
  guidance: string | null;
  generationPolicyVersion: string;
  sourceRevision: number;
}>;

export type ConversationActionHandler = Readonly<{
  actionKind: "regenerate_journal";
  prepare(input: {
    definition: ConversationActionDefinition;
    proposal: ConversationActionProposal;
    target: ActionReferenceBinding;
  }): PreparedConversationAction;
}>;

export type ConversationActionGatewayRepository = Readonly<{
  commitAccepted(input: {
    context: ConversationActionGatewayContext;
    definition: ConversationActionDefinition;
    prepare: () => PreparedConversationAction;
    proposal: ConversationActionProposal;
  }): Promise<ConversationActionReceipt>;
  commitNonAccepted(input: {
    admission: Exclude<ConversationActionAdmission, "accepted">;
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
}>;

export type ConversationActionGateway = Readonly<{
  admit(input: {
    catalog: ConversationActionCatalog;
    context: ConversationActionGatewayContext;
    proposal: ConversationActionProposal | null;
  }): Promise<ConversationActionReceipt>;
}>;

export function createConversationActionGateway(input: {
  handler: ConversationActionHandler;
  repository: ConversationActionGatewayRepository;
}): ConversationActionGateway {
  return {
    async admit(request) {
      await input.repository.purgeExpiredGuidance?.(new Date());
      const proposal = request.proposal;
      const catalogValidation = validateConversationActionCatalog(request.catalog);
      if (!catalogValidation.valid) {
        return input.repository.commitNonAccepted({
          admission: "unsupported",
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
        ? createIdempotencyKey(request.context, proposal)
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
          context: request.context,
          definition,
          disposition: validation.reason,
          proposal,
          schemaVersion,
        });
      }

      const target = await input.repository.resolveHandle({
        context: request.context,
        handle: proposal.arguments.journalHandle,
      });
      if (!target || !target.actionKinds.includes(proposal.actionKind)) {
        return input.repository.commitNonAccepted({
          admission: "rejected",
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
          context: request.context,
          definition,
          disposition: "exact_head_advanced",
          proposal,
          schemaVersion,
        });
      }
      if (await input.repository.hasInFlightTarget({
        targetId: target.targetId,
        userId: request.context.userId,
      })) {
        return input.repository.commitNonAccepted({
          admission: "rejected",
          context: request.context,
          definition,
          disposition: "rate_limited_in_flight",
          proposal,
          schemaVersion,
        });
      }

      return input.repository.commitAccepted({
        context: request.context,
        definition,
        prepare: () =>
          input.handler.prepare({
            definition,
            proposal,
            target,
          }),
        proposal,
      });
    },
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
      const guidance = proposal.arguments.guidance?.trim() ?? "";
      if (guidance.length > maxGuidanceLength) {
        throw new Error("Regeneration Guidance exceeds its bounded length.");
      }
      return {
        actionKind: "regenerate_journal",
        dailySessionId: target.dailySessionId,
        expectedDataEpoch: target.expectedDataEpoch,
        guidance: guidance || null,
        generationPolicyVersion: input.generationPolicyVersion,
        sourceRevision: target.sourceRevision,
      };
    },
  };
}

function createIdempotencyKey(
  context: ConversationActionGatewayContext,
  proposal: ConversationActionProposal,
): string {
  return [
    context.decisionCommandId,
    context.requestEventRevisionId,
    proposal.actionKind,
    proposal.arguments.journalHandle,
  ].join(":");
}

function validateProposal(
  proposal: ConversationActionProposal,
  definition: ConversationActionDefinition,
  requestEventRevisionId: ConversationActionGatewayContext["requestEventRevisionId"],
): { valid: true } | { valid: false; reason: string } {
  if (proposal.actionKind !== "regenerate_journal") {
    return { valid: false, reason: "unsupported_action" };
  }
  if (proposal.requestEventRevisionId !== requestEventRevisionId) {
    return { valid: false, reason: "request_revision_mismatch" };
  }
  if (
    !proposal.arguments ||
    Object.keys(proposal.arguments).some(
      (key) => key !== "journalHandle" && key !== "guidance",
    ) ||
    typeof proposal.arguments.journalHandle !== "string" ||
    proposal.arguments.journalHandle.length === 0 ||
    (proposal.arguments.guidance !== undefined &&
      (typeof proposal.arguments.guidance !== "string" ||
        proposal.arguments.guidance.length >
          Number(definition.inputSchema.properties.guidance?.maxLength ?? 1_000)))
  ) {
    return { valid: false, reason: "malformed_arguments" };
  }
  return { valid: true };
}
