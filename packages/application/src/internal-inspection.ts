import type {
  ConversationEventRevisionId,
  GenerationCommandId,
  ModelRunAttemptId,
  UserId,
} from "@sayhear/domain";

export type GenerationInspectionMetadata = Readonly<{
  attemptStatus: string;
  checkedAt: Date;
  commandStatus: string;
  completedAt: Date | null;
  consentPolicyVersion: string | null;
  costMicros: number | null;
  dispatchLatencyMs: number;
  dispatchedAt: Date | null;
  disposition: string;
  freshnessPolicy: string;
  generationCommandId: GenerationCommandId;
  inputTokens: number | null;
  model: string;
  modelRunAttemptId: ModelRunAttemptId;
  outputTokens: number | null;
  provider: string;
  providerLatencyMs: number | null;
  providerPolicyVersion: string;
  providerRequestId: string | null;
  role: string;
  sourceRevisionId: ConversationEventRevisionId;
}>;

export type SensitiveInspectionDenialReason =
  | "elevated_capability_required"
  | "recent_step_up_required";

export type ConversationContentInspection = Readonly<{
  events: readonly Readonly<{
    actor: "assistant" | "system" | "user";
    revisionId: ConversationEventRevisionId;
    text: string;
  }>[];
  generationCommandId: GenerationCommandId;
}>;

export type InternalInspectionRepository = Readonly<{
  findGenerationMetadata(input: {
    generationCommandId: GenerationCommandId;
    userId: UserId;
  }): Promise<GenerationInspectionMetadata | null>;
  inspectConversationContent(input: {
    authSessionId: string;
    capability: "conversation_content:read";
    generationCommandId: GenerationCommandId;
    now: Date;
    policyVersion: string;
    stepUpMaxAgeMs: number;
    userId: UserId;
  }): Promise<
    | Readonly<{
        content: ConversationContentInspection;
        outcome: "allowed";
      }>
    | Readonly<{
        outcome: "denied";
        reason: SensitiveInspectionDenialReason;
      }>
    | Readonly<{ outcome: "not_found" }>
  >;
}>;

export type InternalInspectionService = Readonly<{
  getGenerationMetadata(
    userId: UserId,
    generationCommandId: GenerationCommandId,
  ): Promise<GenerationInspectionMetadata>;
  inspectConversationContent(
    userId: UserId,
    authSessionId: string,
    generationCommandId: GenerationCommandId,
  ): Promise<ConversationContentInspection>;
}>;

export class InternalInspectionNotFoundError extends Error {
  public constructor() {
    super("The requested GenerationCommand inspection was not found.");
    this.name = "InternalInspectionNotFoundError";
  }
}

export class SensitiveInspectionDeniedError extends Error {
  public constructor(
    public readonly reason: SensitiveInspectionDenialReason,
  ) {
    super("Sensitive conversation inspection is not authorized.");
    this.name = "SensitiveInspectionDeniedError";
  }
}

export function createInternalInspectionService(dependencies: {
  clock: () => Date;
  policyVersion: string;
  repository: InternalInspectionRepository;
  stepUpMaxAgeMs: number;
}): InternalInspectionService {
  return {
    async getGenerationMetadata(userId, generationCommandId) {
      const metadata = await dependencies.repository.findGenerationMetadata({
        generationCommandId,
        userId,
      });
      if (metadata === null) {
        throw new InternalInspectionNotFoundError();
      }
      return metadata;
    },
    async inspectConversationContent(
      userId,
      authSessionId,
      generationCommandId,
    ) {
      const result = await dependencies.repository.inspectConversationContent({
        authSessionId,
        capability: "conversation_content:read",
        generationCommandId,
        now: dependencies.clock(),
        policyVersion: dependencies.policyVersion,
        stepUpMaxAgeMs: dependencies.stepUpMaxAgeMs,
        userId,
      });
      if (result.outcome === "not_found") {
        throw new InternalInspectionNotFoundError();
      }
      if (result.outcome === "denied") {
        throw new SensitiveInspectionDeniedError(result.reason);
      }
      return result.content;
    },
  };
}
