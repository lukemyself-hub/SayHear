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
import type { CurrentDialogueState } from "./dialogue-state";
import type { MemorySectionKey } from "./memory-retrieval/memory-compilation";
import type {
  RankComponents,
  RetrievalFenceCode,
  RetrievalLane,
  RetrievalRunManifest,
  TrustFenceResult,
} from "./memory-retrieval/types";
import type { RecoveryGate } from "./recovery-gate";
import type { CurrentSafetyPosture } from "./safety-posture";

export type CompiledContextSafetyPostureInspection = Readonly<{
  posture: CurrentSafetyPosture | null;
  state: "active" | "default" | "released";
}>;

/**
 * #122: one retrieval-funnel row from the run ledger — lane, hit and ranking
 * fields, trust-fence results, and the selection / rejection reasons recorded
 * at run time. The Inspector renders these rows next to the CompiledContext
 * memory sections; it never recomputes a selection (ADR-0115: no second
 * "selected but not injected" state).
 */
export type RetrievalCandidateInspection = Readonly<{
  claimVersionId: string;
  finalRank: number | null;
  lane: RetrievalLane;
  matchedFields: readonly string[];
  matchedTerms: readonly string[];
  rankComponents: RankComponents;
  rejectionReasonCodes: readonly string[];
  retrievalProjectionId: string;
  selectedSection: MemorySectionKey | null;
  selectionReasonCodes: readonly string[];
  trustFenceResults: readonly TrustFenceResult[];
}>;

export type CompiledContextInspection = Readonly<{
  compilerVersion: string;
  degradedReason: CompiledContextDegradedReason;
  dialogueState: CurrentDialogueState | null;
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
  /**
   * #122: the compact retrieval manifest pinned on the CompiledContext at
   * compile commit — the run outcome, lane plan, and counters the panel
   * displays. Null for Contexts compiled before the retrieval baseline or
   * with the memory switch off.
   */
  retrievalManifest: RetrievalRunManifest | null;
  safetyPosture: CompiledContextSafetyPostureInspection;
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
  /**
   * #122: the full candidate funnel of the context's retrieval run — the
   * run-ledger rows joined by the manifest's pinned retrieval_run_id, ordered
   * by final rank with unranked (fenced-out) rows last. Empty when no run is
   * linked to the context.
   */
  retrievalCandidates: readonly RetrievalCandidateInspection[];
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
  recoveryGate?: RecoveryGate;
  repository: InternalInspectionRepository;
  stepUpMaxAgeMs: number;
}): InternalInspectionService {
  return {
    async authorizeSensitiveInspection(userId, authSessionId) {
      await dependencies.recoveryGate?.requireOpen(userId);
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
      await dependencies.recoveryGate?.requireOpen(userId);
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
      await dependencies.recoveryGate?.requireOpen(userId);
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
