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
import type { HistoryQueryPlan, HistoryRecallCoverage } from "./history-recall";
import type { MemorySectionKey } from "./memory-retrieval/memory-compilation";
import type {
  RankComponents,
  RetrievalFenceCode,
  RetrievalLane,
  RetrievalRunManifest,
  TrustFenceResult,
} from "./memory-retrieval/types";
import type { RecoveryGate } from "./recovery-gate";
import type {
  RecentContextFrozenReference,
  RecentContextOmission,
  RecentContextPerDateCoverage,
  RecentContextSelectionBudgets,
  RecentContextSelectionCounts,
  RecentContextSourceFailure,
} from "./recent-context";
import type { CurrentSafetyPosture } from "./safety-posture";

/**
 * #295: content-free presentation of the frozen recent-source selection plus
 * the per-ref provenance columns stored on `compiled_context_revision_refs`.
 * It never carries message bodies and is only built from the recorded
 * CompiledContext, so it cannot fabricate a selection the model did not see.
 */
export type RecentContextInspectionSelectedRef = Readonly<{
  actor: "user" | "assistant";
  dailySessionId: string;
  estimatedTokens: number | null;
  expressedAt: string;
  occurredAt: string | null;
  revisionId: string;
  selectionOrder: number;
  selectionReason: string;
  sequence: number | null;
}>;

export type RecentContextInspection = Readonly<{
  authorizationPolicyVersion: string | null;
  authorizationStatus: "active" | "revoked" | "absent" | "unrecognized";
  budgetTokens: number;
  budgets: RecentContextSelectionBudgets;
  counts: RecentContextSelectionCounts;
  cutoff: RecentContextFrozenReference["cutoff"];
  excludedRevisionIds: readonly string[];
  failure: RecentContextSourceFailure | null;
  omitted: readonly RecentContextOmission[];
  perDate: readonly RecentContextPerDateCoverage[];
  policyVersion: string;
  readLatencyMs: number | null;
  /** The actual encoded wire version (v3 stays v3 under a v4 reader). */
  referenceVersion: number;
  selected: readonly RecentContextInspectionSelectedRef[];
  selectorVersion: string;
  timezone: string;
  /** Non-null when the frozen reference could not be decoded at all. */
  unreadableReason: string | null;
  windowDays: number;
  windowEndLocalDate: string;
  windowStartLocalDate: string;
}>;

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

/**
 * Issue #314: the minimal, content-free account of a controlled history
 * review, readable from either the Decision command (which branch it took) or
 * the History Answer command (what it was compiled from). No message text.
 */
export type HistorySearchPlanInspection = Readonly<{
  endDate: string | null;
  kind: "search_experience";
  personGroups: number;
  searchPolicyVersion: string;
  startDate: string | null;
  termGroups: number;
  timezone: string;
  variants: number;
}>;

export type HistoryRecallInspection = Readonly<{
  answerCommandId: string;
  coverage: HistoryRecallCoverage;
  decisionCommandId: string;
  failureCode: string | null;
  plan: HistoryQueryPlan | HistorySearchPlanInspection | null;
  policyVersion: string;
  /** Which end of the review this inspected command is. */
  role: "answer" | "decision";
  sources: readonly Readonly<{
    actor: "user" | "assistant";
    expressedAt: string;
    group?: number;
    revisionId: string;
    role?: "match" | "context";
  }>[];
  status: "completed" | "failed" | "partial";
}>;

/**
 * Issue #320: one Turn seen as a whole, content-free. It joins every command of
 * the Turn (Decision, History Answer, Finalization) with its attempt, Provider
 * Egress disposition and the Provider's own request id, and states how the
 * Turn finally ended. The request id is the join key to what was actually
 * sent: it names the Provider call whose payload this Context produced.
 */
export type TurnInspectionCommand = Readonly<{
  attemptStatus: string | null;
  commandStatus: string;
  completedAt: string | null;
  egressDisposition: string | null;
  errorCategory: string | null;
  firstTokenAt: string | null;
  generationCommandId: string;
  providerRequestId: string | null;
  stage: string;
}>;

export type TurnFinalDisposition =
  | "committed"
  | "failed"
  | "in_progress"
  | "interrupted"
  | "settled_without_reply";

export type TurnInspection = Readonly<{
  assistantEventCommitted: boolean;
  commands: readonly TurnInspectionCommand[];
  finalDisposition: TurnFinalDisposition;
  interactionTurnId: string;
  turnStatus: string;
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
  /**
   * #295: decoded content-free recent-source diagnostics for this Context.
   * `null` when the Context never carried a recent section.
   */
  recentContext: RecentContextInspection | null;
  referencedEvents: readonly Readonly<{
    actor: "user" | "assistant";
    dailySessionId: string | null;
    estimatedTokens: number;
    expressedAt: string | null;
    occurredAt: string | null;
    revisionId: ConversationEventRevisionId;
    section:
      | "committed_raw_events"
      | "current_user_input"
      | "recent_conversation_context"
      | "history_recall_context";
    selectionOrder: number | null;
    selectionReason: string | null;
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
  /** The GenerationCommand stage this command executed (issue #314). */
  generationStage: string;
  harnessPolicyVersion: string;
  /** Set when this command is either end of a controlled history review. */
  historyRecall: HistoryRecallInspection | null;
  /** The whole Turn this command belongs to (issue #320). */
  turn: TurnInspection | null;
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
