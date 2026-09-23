import type {
  ConversationEventRevisionId,
  DailySessionId,
  UserId,
} from "@sayhear/domain";

import {
  PROACTIVE_FOLLOWUP_OPPORTUNITY_KINDS,
  type ProactiveFollowupOpportunityKind,
} from "./proactive-followup/types";
import type { RecoveryGate } from "./recovery-gate";

export type DialogueStateField<T> = Readonly<{
  confidence: number;
  sourceRevisionIds: readonly ConversationEventRevisionId[];
  value: T;
}>;

export type DialogueStateContent = Readonly<{
  current_topic: DialogueStateField<string | null>;
  emotional_intensity: DialogueStateField<
    "low" | "moderate" | "high" | null
  >;
  advice_explicitly_requested: DialogueStateField<boolean | null>;
  current_request_requires_focus: DialogueStateField<boolean | null>;
  proactive_followup_opportunity: DialogueStateField<
    ProactiveFollowupOpportunityKind | null
  >;
  close_intent: DialogueStateField<boolean | null>;
  user_willing_to_elaborate: DialogueStateField<boolean | null>;
}>;

export type DialogueStateSource = Readonly<{
  actor: "user" | "assistant";
  revisionId: ConversationEventRevisionId;
  sequence: number;
  text: string;
}>;

export type DialogueStatePolicy = Readonly<{
  modelConfigVersion: string;
  policyVersion: string;
  promptVersion: string;
}>;

export type DialogueStateCommand = DialogueStatePolicy & Readonly<{
  coverageThroughSequence: number;
  dailySessionId: DailySessionId;
  dialogueRevision: number;
  expectedDataEpoch: number;
  id: string;
  claimId: string;
  sourceRevision: number;
  userId: UserId;
}>;

export type CurrentDialogueState = Readonly<{
  content: DialogueStateContent;
  coveredThroughSequence: number;
  dialogueRevision: number;
  id: string;
  modelConfigVersion: string;
  policyVersion: string;
  promptVersion: string;
  sourceRevision: number;
  sourceRevisionIds: readonly ConversationEventRevisionId[];
  status: "current" | "lagging";
  updatedAt: Date;
  version: number;
}>;

export type DialogueStateModel = Readonly<{
  project(input: {
    policy: DialogueStatePolicy;
    sources: readonly DialogueStateSource[];
  }): Promise<DialogueStateContent>;
}>;

export type DialogueStateRepository = Readonly<{
  fail(input: { claimId: string; commandId: string; errorCode: string }): Promise<void>;
  loadCommand(input: {
    commandId: string;
    now: Date;
  }): Promise<
    | Readonly<{
        command: DialogueStateCommand;
        sources: readonly DialogueStateSource[];
      }>
    | null
  >;
  publish(input: {
    command: DialogueStateCommand;
    content: DialogueStateContent;
    now: Date;
  }): Promise<"published" | "stale">;
  queueEligible(input: {
    now: Date;
    policy: DialogueStatePolicy;
  }): Promise<number>;
  reconcile(input: { maximumClaimAgeMs: number; now: Date }): Promise<void>;
  stale(input: { claimId: string; commandId: string }): Promise<void>;
}>;

export type DialogueStateService = Readonly<{
  run(commandId: string): Promise<{
    outcome: "failed" | "published" | "stale";
  }>;
  scanPending(): Promise<{ queued: number }>;
}>;

const fieldDefinitions = [
  "current_topic",
  "emotional_intensity",
  "advice_explicitly_requested",
  "current_request_requires_focus",
  "proactive_followup_opportunity",
  "close_intent",
  "user_willing_to_elaborate",
] as const;

const booleanFieldNames = [
  "advice_explicitly_requested",
  "current_request_requires_focus",
  "close_intent",
  "user_willing_to_elaborate",
] as const;

const boundaryViolationPattern =
  /(?:safety\s+(?:verdict|decision)|安全(?:判定|决定|结论)|(?:authorize|approve)\s+(?:an?\s+)?action|(?:safe\s+to\s+proceed)|(?:send|execute|delete|publish)\s+(?:the\s+|an?\s+)?(?:email|message|action|data|record|request)|(?:message|email|request).{0,20}(?:should|must|needs to|can be).{0,10}(?:sent|send|executed|approved|authorized)|(?:授权|批准|执行|删除|发布|发送).{0,8}(?:邮件|消息|操作|数据|记录|请求)|(?:邮件|消息|请求).{0,12}(?:应该|必须|可以).{0,8}(?:发送|执行|批准|授权)|(?:close|end|terminate)\s+(?:the\s+)?(?:continuous\s+)?exchange|(?:recommend|suggest|should|must|need to|needs to).{0,20}(?:end|close|terminate).{0,20}(?:exchange|conversation|dialogue)|(?:exchange|conversation|dialogue).{0,20}(?:should|must|needs to|ought to).{0,10}(?:end|close|terminate)|(?:关闭|结束|终止).{0,8}(?:连续)?(?:交流|对话)|(?:交流|对话).{0,12}(?:应该|必须|需要).{0,8}(?:结束|关闭|终止))/i;

export function validateDialogueStateContent(
  content: DialogueStateContent,
  sourceRevisionIds: readonly ConversationEventRevisionId[],
): void {
  const allowedSourceIds = new Set(sourceRevisionIds);
  for (const fieldName of fieldDefinitions) {
    const field = content[fieldName];
    if (!field || typeof field !== "object") {
      throw new Error(`DialogueState ${fieldName} is missing.`);
    }
    if (!Number.isFinite(field.confidence) || field.confidence < 0 || field.confidence > 1) {
      throw new Error(`DialogueState ${fieldName} confidence must be between 0 and 1.`);
    }
    if (
      field.sourceRevisionIds.some((sourceRevisionId) => !allowedSourceIds.has(sourceRevisionId))
    ) {
      throw new Error(`DialogueState ${fieldName} references an unknown source revision.`);
    }
    if (field.value === null) {
      if (field.confidence !== 0 || field.sourceRevisionIds.length !== 0) {
        throw new Error(`DialogueState ${fieldName} null values cannot carry confidence or sources.`);
      }
      continue;
    }
    if (fieldName === "current_topic") {
      if (typeof field.value !== "string") {
        throw new Error(`DialogueState ${fieldName} value must be a string or null.`);
      }
      if (!field.value.trim() || field.value.length > 240) {
        throw new Error(`DialogueState ${fieldName} value is outside the bounded policy.`);
      }
      if (boundaryViolationPattern.test(field.value)) {
        throw new Error(`DialogueState ${fieldName} contains a forbidden boundary decision.`);
      }
    }
    if (
      fieldName === "emotional_intensity" &&
      field.value !== "low" &&
      field.value !== "moderate" &&
      field.value !== "high"
    ) {
      throw new Error("DialogueState emotional_intensity is outside the bounded policy.");
    }
    if (
      fieldName === "proactive_followup_opportunity" &&
      !PROACTIVE_FOLLOWUP_OPPORTUNITY_KINDS.includes(
        field.value as ProactiveFollowupOpportunityKind,
      )
    ) {
      throw new Error(
        "DialogueState proactive_followup_opportunity is outside the bounded policy.",
      );
    }
    if (
      booleanFieldNames.includes(
        fieldName as (typeof booleanFieldNames)[number],
      ) &&
      typeof field.value !== "boolean"
    ) {
      throw new Error(`DialogueState ${fieldName} value must be a boolean or null.`);
    }
    if (field.sourceRevisionIds.length === 0) {
      throw new Error(`DialogueState ${fieldName} non-null values require source revisions.`);
    }
  }
}

export function hasCompleteDialogueStateCoverage(
  command: DialogueStateCommand,
  sources: readonly DialogueStateSource[],
): boolean {
  return (
    sources.length > 0 &&
    sources.every((source, index) => source.sequence === index + 1) &&
    sources.at(-1)?.sequence === command.coverageThroughSequence
  );
}

export function createDialogueStateService(dependencies: {
  clock: () => Date;
  maximumClaimAgeMs?: number;
  model: DialogueStateModel;
  policy: DialogueStatePolicy;
  repository: DialogueStateRepository;
  recoveryGate?: RecoveryGate;
}): DialogueStateService {
  const maximumClaimAgeMs = dependencies.maximumClaimAgeMs ?? 5 * 60 * 1_000;

  return {
    async run(commandId) {
      const frozen = await dependencies.repository.loadCommand({
        commandId,
        now: dependencies.clock(),
      });
      if (!frozen) return { outcome: "stale" };
      await dependencies.recoveryGate?.requireOpen(frozen.command.userId);
      if (
        frozen.command.policyVersion !== dependencies.policy.policyVersion ||
        frozen.command.promptVersion !== dependencies.policy.promptVersion ||
        frozen.command.modelConfigVersion !== dependencies.policy.modelConfigVersion ||
        !hasCompleteDialogueStateCoverage(frozen.command, frozen.sources)
      ) {
        await dependencies.repository.stale({
          claimId: frozen.command.claimId,
          commandId,
        });
        return { outcome: "stale" };
      }

      try {
        const content = await dependencies.model.project({
          policy: {
            modelConfigVersion: frozen.command.modelConfigVersion,
            policyVersion: frozen.command.policyVersion,
            promptVersion: frozen.command.promptVersion,
          },
          sources: frozen.sources,
        });
        validateDialogueStateContent(
          content,
          frozen.sources.map((source) => source.revisionId),
        );
        return {
          outcome: await dependencies.repository.publish({
            command: frozen.command,
            content,
            now: dependencies.clock(),
          }),
        };
      } catch {
        await dependencies.repository.fail({
          claimId: frozen.command.claimId,
          commandId,
          errorCode: "dialogue_state_generation_failed",
        });
        return { outcome: "failed" };
      }
    },
    async scanPending() {
      const now = dependencies.clock();
      await dependencies.repository.reconcile({
        maximumClaimAgeMs,
        now,
      });
      return {
        queued: await dependencies.repository.queueEligible({
          now,
          policy: dependencies.policy,
        }),
      };
    },
  };
}
