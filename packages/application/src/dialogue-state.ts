import type {
  ConversationEventRevisionId,
  DailySessionId,
  UserId,
} from "@sayhear/domain";

export type DialogueStateField<T> = Readonly<{
  confidence: number;
  sourceRevisionIds: readonly ConversationEventRevisionId[];
  value: T;
}>;

export type DialogueStateContent = Readonly<{
  currentTopic: DialogueStateField<string | null>;
  emotionalTone: DialogueStateField<
    "calm" | "positive" | "negative" | "mixed" | "uncertain" | null
  >;
  pendingQuestion: DialogueStateField<string | null>;
  userIntent: DialogueStateField<
    "sharing" | "asking" | "correcting" | "seeking_understanding" | "unknown"
  >;
}>;

export type DialogueStateSource = Readonly<{
  actor: "user" | "assistant";
  revisionId: ConversationEventRevisionId;
  sequence: number;
  text: string;
}>;

export type DialogueStateCommand = Readonly<{
  coverageThroughSequence: number;
  dailySessionId: DailySessionId;
  dialogueRevision: number;
  expectedDataEpoch: number;
  id: string;
  modelConfigVersion: string;
  policyVersion: string;
  promptVersion: string;
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
    policyVersion: string;
    promptVersion: string;
    modelConfigVersion: string;
    sources: readonly DialogueStateSource[];
  }): Promise<DialogueStateContent>;
}>;

export type DialogueStateRepository = Readonly<{
  fail(input: { commandId: string; errorCode: string }): Promise<void>;
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
    expectedDataEpoch: number;
    modelConfigVersion: string;
    now: Date;
    policyVersion: string;
    promptVersion: string;
  }): Promise<number>;
  reconcile(input: { maximumClaimAgeMs: number; now: Date }): Promise<void>;
  stale(input: { commandId: string }): Promise<void>;
}>;

export type DialogueStateService = Readonly<{
  run(commandId: string): Promise<{
    outcome: "failed" | "published" | "stale";
  }>;
  scanPending(): Promise<{ queued: number }>;
}>;

const fieldDefinitions = [
  "currentTopic",
  "emotionalTone",
  "pendingQuestion",
  "userIntent",
] as const;

export function validateDialogueStateContent(
  content: DialogueStateContent,
  sourceRevisionIds: readonly ConversationEventRevisionId[],
): void {
  const allowedSourceIds = new Set(sourceRevisionIds);
  for (const fieldName of fieldDefinitions) {
    const field = content[fieldName];
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
    if (typeof field.value === "string" && (!field.value.trim() || field.value.length > 240)) {
      throw new Error(`DialogueState ${fieldName} value is outside the bounded policy.`);
    }
    if (fieldName === "emotionalTone" && !["calm", "positive", "negative", "mixed", "uncertain"].includes(field.value)) {
      throw new Error("DialogueState emotionalTone is outside the bounded policy.");
    }
    if (
      fieldName === "userIntent" &&
      !["sharing", "asking", "correcting", "seeking_understanding", "unknown"].includes(field.value)
    ) {
      throw new Error("DialogueState userIntent is outside the bounded policy.");
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
  expectedDataEpoch: number;
  maximumClaimAgeMs?: number;
  model: DialogueStateModel;
  modelConfigVersion: string;
  policyVersion: string;
  promptVersion: string;
  repository: DialogueStateRepository;
}): DialogueStateService {
  if (!Number.isInteger(dependencies.expectedDataEpoch) || dependencies.expectedDataEpoch <= 0) {
    throw new Error("expectedDataEpoch must be a positive integer.");
  }
  const maximumClaimAgeMs = dependencies.maximumClaimAgeMs ?? 5 * 60 * 1_000;

  return {
    async run(commandId) {
      const frozen = await dependencies.repository.loadCommand({
        commandId,
        now: dependencies.clock(),
      });
      if (!frozen) return { outcome: "stale" };
      if (
        frozen.command.expectedDataEpoch !== dependencies.expectedDataEpoch ||
        frozen.command.policyVersion !== dependencies.policyVersion ||
        frozen.command.promptVersion !== dependencies.promptVersion ||
        frozen.command.modelConfigVersion !== dependencies.modelConfigVersion ||
        !hasCompleteDialogueStateCoverage(frozen.command, frozen.sources)
      ) {
        await dependencies.repository.stale({ commandId });
        return { outcome: "stale" };
      }

      try {
        const content = await dependencies.model.project({
          modelConfigVersion: frozen.command.modelConfigVersion,
          policyVersion: frozen.command.policyVersion,
          promptVersion: frozen.command.promptVersion,
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
          expectedDataEpoch: dependencies.expectedDataEpoch,
          modelConfigVersion: dependencies.modelConfigVersion,
          now,
          policyVersion: dependencies.policyVersion,
          promptVersion: dependencies.promptVersion,
        }),
      };
    },
  };
}
