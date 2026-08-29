import type {
  CompiledContextId,
  GenerationCommandId,
  UserId,
} from "@sayhear/domain";

import type {
  ConversationActionKind,
  ConversationActionTargetKind,
} from "./conversation-action-catalog";

export type ActionReferenceBinding = Readonly<{
  actionKinds: readonly ConversationActionKind[];
  compiledContextId: CompiledContextId;
  currentVersionId: string | null;
  currentVersionStatus?:
    | "published"
    | "stale"
    | "validation_failed"
    | "needs_review"
    | "active"
    | "review_due"
    | "dormant"
    | "superseded"
    | "retracted"
    | null;
  dailySessionId: string;
  expectedDataEpoch: number;
  generationCommandId: GenerationCommandId;
  handle: string;
  ownerId: UserId;
  ownerStatus?: "active" | "deleting" | "disabled";
  sourceRevision: number;
  targetId: string;
  targetKind: ConversationActionTargetKind;
  /** Set for a relationship_qualifier target; never assembled by the model. */
  targetClaimId?: string;
  targetQualifierId?: string;
  targetVersionId: string;
}>;
