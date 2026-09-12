import type {
  CompiledContextId,
  ConversationEventRevisionId,
  GenerationCommandId,
  InteractionTurnId,
  ModelRunAttemptId,
  UserId,
} from "@sayhear/domain";

import { countFollowUpQuestions } from "../conversation-behavior";
import type { CompleteResponseMetadata } from "../conversation-response";
import type { ProactiveFollowupTargetKind } from "./types";

export type ProactiveFollowupSegmentPlan = Readonly<{
  expectedDataEpoch: number;
  interactionTurnId: InteractionTurnId;
  mainGenerationCommandId: GenerationCommandId;
  promptUserEventRevisionId: ConversationEventRevisionId;
  promptUserEventSequence: number;
  policyBundle: Readonly<Record<string, unknown>>;
  policyBundleVersion: string;
  promptPolicyVersion: string;
  reservationId: string;
  segmentCompiledContextId: CompiledContextId;
  segmentGenerationCommandId: GenerationCommandId;
  segmentModelRunAttemptId: ModelRunAttemptId;
  selectionPolicyVersion: string;
  targetId: string;
  targetKind: ProactiveFollowupTargetKind;
  targetVersionId: string;
  userId: UserId;
}>;

export type ProactiveFollowupSegmentOutput = Readonly<{
  content: string;
  expressionKind: "question" | "acknowledgment";
  targetRef: Readonly<{
    targetId: string;
    targetKind: ProactiveFollowupTargetKind;
    targetVersionId: string;
  }>;
}>;

export type ProactiveFollowupSegmentGeneration = Readonly<{
  metadata: CompleteResponseMetadata;
  output: ProactiveFollowupSegmentOutput;
}>;

export type ProactiveFollowupSegmentCommit = Readonly<{
  generation: ProactiveFollowupSegmentGeneration;
  plan: ProactiveFollowupSegmentPlan;
}>;

export type ProactiveFollowupSegmentPreparationInput = Readonly<{
  interactionTurnId: InteractionTurnId;
  mainGenerationCommandId: GenerationCommandId;
  mainText: string;
  now: Date;
  ordinaryQuestionAlreadyAsked: boolean;
  requestEventRevisionId: ConversationEventRevisionId;
  userId: UserId;
}>;

export type ProactiveFollowupSegmentAbandonReason =
  | "generation_failed"
  | "interrupted"
  | "invalid_output"
  | "pre_display_revalidation_failed";

/**
 * Application-owned C3 seam. Implementations own state/selection reads,
 * Segment Command/context creation, and the independent proactive.followup
 * provider role. The Harness never receives provider messages or raw tool
 * calls through this interface.
 */
export type ProactiveFollowupSegmentStage = Readonly<{
  abandon(
    plan: ProactiveFollowupSegmentPlan,
    reason: ProactiveFollowupSegmentAbandonReason,
  ): Promise<void>;
  generate(
    plan: ProactiveFollowupSegmentPlan,
    signal?: AbortSignal,
  ): Promise<ProactiveFollowupSegmentGeneration>;
  prepare(
    input: ProactiveFollowupSegmentPreparationInput,
  ): Promise<ProactiveFollowupSegmentPlan | null>;
}>;

export type ProactiveFollowupSegmentValidation =
  | Readonly<{ outcome: "valid" }>
  | Readonly<{ outcome: "invalid"; reason: "expression_kind" | "question_budget" | "target_ref" | "empty" }>;

export function validateProactiveFollowupSegmentOutput(input: Readonly<{
  mainText: string;
  output: ProactiveFollowupSegmentOutput;
  plan: ProactiveFollowupSegmentPlan;
}>): ProactiveFollowupSegmentValidation {
  const content = input.output.content.trim();
  if (content.length === 0) return { outcome: "invalid", reason: "empty" };

  const targetMatches =
    input.output.targetRef.targetKind === input.plan.targetKind &&
    input.output.targetRef.targetId === input.plan.targetId &&
    input.output.targetRef.targetVersionId === input.plan.targetVersionId;
  if (!targetMatches) return { outcome: "invalid", reason: "target_ref" };

  const segmentQuestionCount = countFollowUpQuestions(content);
  if (
    (input.output.expressionKind === "question" && segmentQuestionCount !== 1) ||
    (input.output.expressionKind === "acknowledgment" && segmentQuestionCount !== 0)
  ) {
    return { outcome: "invalid", reason: "expression_kind" };
  }

  if (countFollowUpQuestions(`${input.mainText}\n\n${content}`) > 1) {
    return { outcome: "invalid", reason: "question_budget" };
  }
  return { outcome: "valid" };
}

export function composeProactiveFollowupResponse(input: Readonly<{
  mainText: string;
  segmentText: string;
}>): string {
  const mainText = input.mainText.trimEnd();
  const segmentText = input.segmentText.trim();
  if (mainText.length === 0 || segmentText.length === 0) {
    throw new Error("A composed proactive response requires two non-empty parts.");
  }
  return `${mainText}\n\n${segmentText}`;
}
