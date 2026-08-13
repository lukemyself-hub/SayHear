import type {
  CompiledContextId,
  ConversationEventRevisionId,
  GenerationCommandId,
  ModelRunAttemptId,
  UserId,
} from "@sayhear/domain";

import type {
  CompiledContextDegradedReason,
  CompiledContextSectionKey,
  ContextPolicyVersions,
} from "./context-compiler";

export type CompiledContextInspection = Readonly<{
  compilerVersion: string;
  degradedReason: CompiledContextDegradedReason;
  dialogueRevision: number;
  id: CompiledContextId;
  integrity: Readonly<{
    algorithm: "hmac-sha256";
    keyVersion: string;
  }>;
  locale: string;
  policyVersions: ContextPolicyVersions;
  referencedEvents: readonly Readonly<{
    actor: "user" | "assistant";
    estimatedTokens: number;
    revisionId: ConversationEventRevisionId;
    section: "committed_raw_events" | "current_user_input";
    selectionOrder: number | null;
    sequence: number;
  }>[];
  sectionBudgets: Readonly<{ committedRawEvents: number }>;
  sections: readonly Readonly<{
    budgetTokens: number | null;
    key: CompiledContextSectionKey;
    ordinal: number;
    reference: string;
    selectedTokens: number;
    truncatable: boolean;
  }>[];
  sourceRevision: number;
  totalTokens: number;
}>;

export type GenerationInspectionMetadata = Readonly<{
  attemptStatus: string;
  checkedAt: Date;
  commandStatus: string;
  compiledContext: CompiledContextInspection;
  completedAt: Date | null;
  consentPolicyVersion: string | null;
  conversationActionCatalogVersion: string;
  costMicros: number | null;
  dispatchLatencyMs: number;
  dispatchedAt: Date | null;
  disposition: string;
  freshnessPolicy: string;
  generationCommandId: GenerationCommandId;
  harnessPolicyVersion: string;
  inputTokens: number | null;
  model: string;
  modelRunAttemptId: ModelRunAttemptId;
  outputTokens: number | null;
  provider: string;
  providerLatencyMs: number | null;
  providerPolicyVersion: string;
  providerRequestId: string | null;
  recovery: Readonly<{
    attempts: readonly Readonly<{
      attemptNo: number;
      completedAt: Date | null;
      createdAt: Date;
      errorCategory: string | null;
      firstTokenAt: Date | null;
      id: ModelRunAttemptId;
      providerCompletedAt: Date | null;
      recoveryClaimedAt: Date | null;
      recoveryStatus: string;
      retryNotBefore: Date | null;
      retryOfModelRunAttemptId: ModelRunAttemptId | null;
      startedAt: Date | null;
      status: string;
    }>[];
    checkedAt: Date | null;
    nextRecoveryAt: Date | null;
    policyVersion: string;
    status: string;
  }>;
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
  authorizeSensitiveInspection(input: {
    authSessionId: string;
    capability: "conversation_content:read";
    now: Date;
    policyVersion: string;
    stepUpMaxAgeMs: number;
    userId: UserId;
  }): Promise<Readonly<{ outcome: "allowed" }> | Readonly<{ outcome: "denied"; reason: SensitiveInspectionDenialReason }>>;
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
  authorizeSensitiveInspection(userId: UserId, authSessionId: string): Promise<void>;
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
    async authorizeSensitiveInspection(userId, authSessionId) {
      const result = await dependencies.repository.authorizeSensitiveInspection({
        authSessionId,
        capability: "conversation_content:read",
        now: dependencies.clock(),
        policyVersion: dependencies.policyVersion,
        stepUpMaxAgeMs: dependencies.stepUpMaxAgeMs,
        userId,
      });
      if (result.outcome === "denied") throw new SensitiveInspectionDeniedError(result.reason);
    },
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
