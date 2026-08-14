import type {
  CompiledContextId,
  GenerationCommandId,
  UserId,
} from "@sayhear/domain";

import type { ConversationActionKind } from "./conversation-action-catalog";

export type ActionReferenceBinding = Readonly<{
  actionKinds: readonly ConversationActionKind[];
  compiledContextId: CompiledContextId;
  currentVersionId: string | null;
  currentVersionStatus?: "published" | "stale" | "validation_failed" | "needs_review" | null;
  dailySessionId: string;
  expectedDataEpoch: number;
  generationCommandId: GenerationCommandId;
  handle: string;
  ownerId: UserId;
  ownerStatus?: "active" | "deleting" | "disabled";
  sourceRevision: number;
  targetId: string;
  targetKind: "journal";
  targetVersionId: string;
}>;
