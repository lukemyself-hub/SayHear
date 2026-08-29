import type {
  ConversationActionHandler,
  ConversationActionTransactionExecutor,
} from "./conversation-action-gateway";
import type {
  ConversationActionDefinition,
  ConversationActionProposal,
} from "./conversation-action-catalog";

/** The immutable policy identity for the user-correction identity operation. */
export const ENTITY_IDENTITY_CORRECTION_POLICY_VERSION =
  "entity-identity-correction:v1";

export type EntityIdentityCorrectionOperation = "merge" | "split" | "promote";

/**
 * The typed result of admission-time identity lookup. Anchors are deliberately
 * absent: they are user-word clues, not durable selectors. The handler receives
 * only the owner-scoped Entity and EntityVersion identities the resolver found.
 */
export type ResolvedEntityIdentityCorrectionTarget = Readonly<{
  operation: EntityIdentityCorrectionOperation;
  sourceEntityId: string;
  sourceEntityVersionId: string;
  sourceEntityVersionStatus: "active" | "unresolved" | "merged" | "split" | "deleted";
  sourceIsSelf?: boolean;
  targetEntityId: string | null;
  targetEntityVersionId: string | null;
  targetEntityVersionStatus:
    | "active"
    | "unresolved"
    | "merged"
    | "split"
    | "deleted"
    | null;
  targetIsSelf?: boolean;
  newEntityLabel: string | null;
  promotionEvidence: Readonly<{
    explicitStatement: boolean;
    independentRevisionCount: number;
  }> | null;
  expectedDataEpoch: number;
  /** Admission-time guard; false means the current User Event is ordinary text. */
  explicitUserCorrection?: boolean;
}>;

/** Backwards-compatible domain name used by policy and fixture callers. */
export type EntityIdentityCorrectionTarget = ResolvedEntityIdentityCorrectionTarget;

export type EntityIdentityCorrectionPlan =
  | Readonly<{
      action: "merge";
      sourceEntityId: string;
      sourceEntityVersionId: string;
      targetEntityId: string;
      targetEntityVersionId: string;
    }>
  | Readonly<{
      action: "split";
      sourceEntityId: string;
      sourceEntityVersionId: string;
      newEntityLabel: string;
    }>
  | Readonly<{
      action: "promote";
      sourceEntityId: string;
      sourceEntityVersionId: string;
    }>
  | Readonly<{
      action: "noop_already_promoted";
      reasonCode: "source_entity_already_active";
    }>
  | Readonly<{
      action: "rejected";
      reasonCode: string;
    }>;

const CORRECTABLE_ENTITY_STATUSES = new Set(["active", "unresolved"]);

/**
 * Pure identity-surgery policy. SQL re-loads and locks the same state before
 * executing the returned plan; this function owns the product rules and keeps
 * Self protection, operation shape, and promotion evidence testable without a
 * database.
 */
export function planEntityIdentityCorrection(
  input: EntityIdentityCorrectionTarget,
): EntityIdentityCorrectionPlan {
  if (
    input.operation !== "promote" &&
    input.explicitUserCorrection !== true
  ) {
    return { action: "rejected", reasonCode: "identity_correction_not_explicit" };
  }
  if (input.sourceIsSelf || input.targetIsSelf) {
    return { action: "rejected", reasonCode: "self_entity_protected" };
  }
  if (
    input.operation === "promote" &&
    input.sourceEntityVersionStatus === "active"
  ) {
    return {
      action: "noop_already_promoted",
      reasonCode: "source_entity_already_active",
    };
  }
  if (!CORRECTABLE_ENTITY_STATUSES.has(input.sourceEntityVersionStatus)) {
    return {
      action: "rejected",
      reasonCode: "source_entity_not_correctable",
    };
  }

  if (input.operation === "merge") {
    if (!input.targetEntityId || !input.targetEntityVersionId) {
      return { action: "rejected", reasonCode: "merge_target_required" };
    }
    if (input.sourceEntityId === input.targetEntityId) {
      return { action: "rejected", reasonCode: "merge_target_same_entity" };
    }
    if (
      input.targetEntityVersionStatus === null ||
      !CORRECTABLE_ENTITY_STATUSES.has(input.targetEntityVersionStatus)
    ) {
      return { action: "rejected", reasonCode: "merge_target_not_correctable" };
    }
    return {
      action: "merge",
      sourceEntityId: input.sourceEntityId,
      sourceEntityVersionId: input.sourceEntityVersionId,
      targetEntityId: input.targetEntityId,
      targetEntityVersionId: input.targetEntityVersionId,
    };
  }

  if (input.operation === "split") {
    const label = input.newEntityLabel?.trim() ?? "";
    if (label.length === 0) {
      return { action: "rejected", reasonCode: "split_new_label_required" };
    }
    if ([...label].length > 200) {
      return { action: "rejected", reasonCode: "split_new_label_too_long" };
    }
    if (input.targetEntityId !== null || input.targetEntityVersionId !== null) {
      return { action: "rejected", reasonCode: "split_target_not_allowed" };
    }
    return {
      action: "split",
      sourceEntityId: input.sourceEntityId,
      sourceEntityVersionId: input.sourceEntityVersionId,
      newEntityLabel: label,
    };
  }

  if (input.targetEntityId !== null || input.targetEntityVersionId !== null) {
    return { action: "rejected", reasonCode: "promote_target_not_allowed" };
  }
  if (input.sourceEntityVersionStatus !== "unresolved") {
    return { action: "rejected", reasonCode: "promotion_requires_unresolved_entity" };
  }
  const evidence = input.promotionEvidence;
  if (
    !evidence ||
    (!evidence.explicitStatement && evidence.independentRevisionCount < 2)
  ) {
    return {
      action: "rejected",
      reasonCode:
        input.explicitUserCorrection === false
          ? "identity_correction_not_explicit"
          : "promotion_evidence_insufficient",
    };
  }
  return {
    action: "promote",
    sourceEntityId: input.sourceEntityId,
    sourceEntityVersionId: input.sourceEntityVersionId,
  };
}

/**
 * Conservative lexical guard for the user-correction-only action. The model
 * may propose an Action, but ordinary mention text must not be enough to make
 * identity surgery executable. A promotion's explicit identity statement is
 * also an explicit correction signal for this purpose.
 */
export function hasExplicitEntityIdentityCorrection(
  text: string,
  operation?: EntityIdentityCorrectionOperation,
): boolean {
  const normalized = normalizeIdentityText(text);
  if (normalized === "") return false;
  const mergeCue =
    /\b(?:same person|same one|one person|are the same(?: person)?|is the same(?: person)?)\b/.test(
      normalized,
    ) ||
    /\b(?:merge|combine|unify)\s+(?:these\s+)?(?:two\s+)?(?:people|persons|identities|names|profiles)\b/.test(
      normalized,
    ) ||
    /(?:同一个人|同一人|一个人|身份相同|合并(?:身份|人物|名字)|统一(?:身份|人物|名字))/.test(
      normalized,
    );
  const splitCue =
    /\b(?:different people|different person|separate people|separate persons|not the same|not one person|distinct people|distinct persons)\b/.test(
      normalized,
    ) ||
    /\b(?:split|separate)\s+(?:these\s+)?(?:two\s+)?(?:people|persons|identities|names|profiles)\b/.test(
      normalized,
    ) ||
    /(?:不同的人|不是同一个|不是一个人|身份不同|(?:两个人|两个身份).*(?:分开|拆开|拆成)|(?:分开|拆开|拆成).*(?:人|身份))/.test(
      normalized,
    );
  const promoteCue =
    /\b(?:promote(?:d)?|this is me|that is me|that's me|i am|i'm|my name is)\b/.test(
      normalized,
    ) || /(?:这是我|我就是|我叫|身份是我)/.test(normalized);
  if (operation === "merge") return mergeCue;
  if (operation === "split") return splitCue;
  if (operation === "promote") return promoteCue;
  return mergeCue || splitCue || promoteCue;
}

/** Detects a bounded, explicit "this name is me / this is this person" form. */
export function hasExplicitEntityIdentityStatement(
  text: string,
  label: string,
): boolean {
  const normalizedText = normalizeIdentityText(text);
  const normalizedLabel = normalizeIdentityText(label);
  if (normalizedText === "" || normalizedLabel === "") return false;
  const escaped = normalizedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(
      `(?:^|[^a-z0-9])(?:this is|that is|that's|my name is|i am|i'm)\\s+${escaped}(?:$|[^a-z0-9])`,
    ).test(normalizedText) ||
    new RegExp(
      `(?:^|[^a-z0-9])${escaped}\\s+(?:is me|is myself|means me|is the same person)(?:$|[^a-z0-9])`,
    ).test(normalizedText) ||
    normalizedText.includes(`这是${normalizedLabel}`) ||
    normalizedText.includes(`我叫${normalizedLabel}`) ||
    normalizedText.includes(`${normalizedLabel}是我`) ||
    normalizedText.includes(`就是${normalizedLabel}`)
  );
}

function normalizeIdentityText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .trim()
    .replaceAll(/\s+/g, " ");
}

export type EntityIdentityCorrectionCommitPort = Readonly<{
  executeEntityIdentityCorrection(
    executor: ConversationActionTransactionExecutor,
    input: {
      actionExecutionId: string;
      requestEventRevisionId: string;
      target: ResolvedEntityIdentityCorrectionTarget;
      userId: string;
    },
  ): Promise<string>;
}>;

function requiredStringArgument(
  proposal: ConversationActionProposal,
  key: string,
): string {
  const value = proposal.arguments[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Entity identity correction requires ${key}.`);
  }
  return value.trim();
}

/** Typed handler for the one user-correction identity action. */
export function createEntityIdentityCorrectionActionHandler(input: {
  commitPort: EntityIdentityCorrectionCommitPort;
}): ConversationActionHandler {
  return {
    actionKind: "entity_identity_correction",
    prepare({ definition, proposal, resolvedIdentityTarget }) {
      if (!resolvedIdentityTarget) {
        throw new Error(
          "Entity identity correction requires the admission-time resolved target.",
        );
      }
      const operation = requiredStringArgument(proposal, "operation");
      if (operation !== resolvedIdentityTarget.operation) {
        throw new Error(
          "Prepared identity correction operation does not match admission resolution.",
        );
      }
      // The target anchor is intentionally read only to ensure the proposal has
      // the declared bounded input; it never enters the durable action envelope.
      requiredStringArgument(proposal, definition.targetContract.handleArgument);
      return {
        actionKind: "entity_identity_correction",
        mode: "in_transaction_entity_identity",
        operation: resolvedIdentityTarget.operation,
        sourceEntityId: resolvedIdentityTarget.sourceEntityId,
        sourceEntityVersionId: resolvedIdentityTarget.sourceEntityVersionId,
        targetEntityId: resolvedIdentityTarget.targetEntityId,
        targetEntityVersionId: resolvedIdentityTarget.targetEntityVersionId,
        newEntityLabel: resolvedIdentityTarget.newEntityLabel,
        promotionEvidence: resolvedIdentityTarget.promotionEvidence,
        expectedDataEpoch: resolvedIdentityTarget.expectedDataEpoch,
        commit: async ({ actionExecutionId, executor, userId }) =>
          input.commitPort.executeEntityIdentityCorrection(executor, {
            actionExecutionId,
            requestEventRevisionId: proposal.requestEventRevisionId,
            target: resolvedIdentityTarget,
            userId,
          }),
      };
    },
  };
}
