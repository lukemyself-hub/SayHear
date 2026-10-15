import type {
  ConversationEventId,
  ConversationEventRevisionId,
  GenerationCommandId,
  InteractionTurnId,
  ModelRunAttemptId,
  UserId,
} from "@sayhear/domain";
import {
  asGenerationCommandId,
  asModelRunAttemptId,
} from "@sayhear/domain";

import type { ContextCompiler } from "./context-compiler";
import type {
  ConversationActionCatalog,
  ActionReferenceHandle,
  ConversationHarnessPolicy,
} from "./conversation-action-catalog";
import type { ConversationActionReceipt } from "./conversation-action-gateway";
import type { ConversationActionGateway } from "./conversation-action-gateway";
import type {
  ConversationAgentHarness,
  ConversationHarnessEvent,
} from "./conversation-agent-harness";
import type { HistoryRecallGateway } from "./history-recall";
import type { CuriosityStopSignalProposal } from "./curiosity-stop-signal";
import {
  ProviderDispatchError,
  type ProviderDispatchErrorCategory,
} from "./conversation-model";
import {
  createRequestDeadline,
  createRequestInterrupt,
  type RequestDeadline,
} from "./request-deadline";
import type {
  ConversationRetryTurn,
  UserTextConversationService,
  UserTextTurn,
} from "./user-text-conversation";
import type { RecoveryGate } from "./recovery-gate";

export type ConversationResponseStreamEvent =
  | Readonly<{
      generationCommandId: GenerationCommandId;
      message: UserTextTurn["message"];
      modelRunAttemptId: ModelRunAttemptId;
      turnId: InteractionTurnId;
      type: "user_committed";
      userEventRevisionId: ConversationEventRevisionId;
    }>
  | Readonly<{
      generationCommandId: GenerationCommandId;
      modelRunAttemptId: ModelRunAttemptId;
      originalTurnId: InteractionTurnId;
      retryActionEventId: ConversationEventId;
      retryRequestId: string;
      turnId: InteractionTurnId;
      type: "retry_committed";
    }>
  | Readonly<{ delta: string; type: "assistant_delta" }>
  | Readonly<{
      /**
       * The authoritative server commit instant of the Assistant Event
       * (`conversation_events.created_at`, ISO 8601 UTC); the same value the
       * portal read contract returns.
       */
      createdAt: string;
      eventId: ConversationEventId;
      revisionId: ConversationEventRevisionId;
      type: "assistant_committed";
    }>
  | Readonly<{
      category: ProviderDispatchErrorCategory;
      type: "response_failed" | "response_interrupted";
    }>
  | Readonly<{
      receipt: ConversationActionReceipt;
      type: "action_admitted";
    }>;

export type CompleteResponseMetadata = Readonly<{
  costMicros: number | null;
  finishReason: string;
  inputTokens: number | null;
  modelSnapshot: string;
  outputTokens: number | null;
  providerRequestId: string | null;
}>;

type ExistingConversationResponse =
  | Readonly<{
      createdAt: string;
      eventId: ConversationEventId;
      outcome: "committed";
      revisionId: ConversationEventRevisionId;
      text: string;
    }>
  | Readonly<{ outcome: "prepared" | "running" }>
  | Readonly<{
      category: ProviderDispatchErrorCategory;
      outcome: "failed" | "interrupted";
    }>;

export type ConversationResponseRepository = Readonly<{
  commitActionDecision?(input: {
    completedAt: Date;
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    userId: UserId;
  }): Promise<void>;
  claimStaleResponseExecution(input: {
    expectedModelRunAttemptId: ModelRunAttemptId;
    generationCommandId: GenerationCommandId;
    now: Date;
    userId: UserId;
  }): Promise<
    | Readonly<{
        generationCommandId: GenerationCommandId;
        modelRunAttemptId: ModelRunAttemptId;
        outcome: "execute";
        retried: boolean;
        turnId: InteractionTurnId;
        userId: UserId;
      }>
    | Readonly<{ outcome: "interrupted" }>
    | Readonly<{ outcome: "terminal" }>
    | Readonly<{ outcome: "not_due" }>
    | Readonly<{ outcome: "replayed" }>
  >;
  claimResponseExecution(input: {
    generationCommandId: GenerationCommandId;
    modelRunAttemptId: ModelRunAttemptId;
    userId: UserId;
  }): Promise<"owner" | "shared">;
  loadResponse(input: {
    generationCommandId: GenerationCommandId;
    userId: UserId;
  }): Promise<ExistingConversationResponse>;
  listStaleResponseExecutions(input: {
    dueAt: Date;
    limit: number;
  }): Promise<
    readonly Readonly<{
      generationCommandId: GenerationCommandId;
      modelRunAttemptId: ModelRunAttemptId;
      turnId: InteractionTurnId;
      userId: UserId;
    }>[]
  >;
  /**
   * Settle History Answer commands that are due for recovery in a runtime that
   * has no history branch (the deployment switch is off): they can never be
   * run, so they end fail closed (nothing shown, nothing committed, the Turn
   * reaches a final state and the person can Retry). Returns how many ended.
   */
  settleStaleHistoryAnswers?(input: {
    dueAt: Date;
    limit: number;
  }): Promise<number>;
  commitCompleteResponse(input: {
    completedAt: Date;
    generationCommandId: GenerationCommandId;
    metadata: CompleteResponseMetadata;
    modelRunAttemptId: ModelRunAttemptId;
    /**
     * Curiosity Stop Signal proposals (issue #74) collected during this
     * Decision. They are model proposals only — the repository commits them
     * through deterministic code inside the same atomic response commit.
     */
    stopSignalProposals?: readonly CuriosityStopSignalProposal[];
    text: string;
    userId: UserId;
  }): Promise<
    | Readonly<{
        createdAt: string;
        eventId: ConversationEventId;
        outcome: "committed";
        revisionId: ConversationEventRevisionId;
      }>
    | Readonly<{
        outcome: "fence_rejected";
        /**
         * Why the answer lost its eligibility, when the reason is one of the
         * request-lifecycle fences (issue #319): a newer user message exists, or
         * the request's frozen deadline has passed.
         */
        reason?: "deadline_exceeded" | "superseded";
      }>
  >;
  /**
   * Cheap, read-only probe used before the first token becomes visible: is
   * this command's answer still allowed to be shown? A newer user message
   * retires it; so does its deadline (issue #319). The commit fence stays the
   * correctness boundary; this only keeps a retired answer off the screen.
   */
  checkResponseFreshness?(input: {
    generationCommandId: GenerationCommandId;
    now: Date;
    userId: UserId;
  }): Promise<"current" | "deadline_exceeded" | "superseded">;
  settleResponseFailure(input: {
    category: ProviderDispatchErrorCategory;
    generationCommandId: GenerationCommandId;
    interrupted: boolean;
    jitter: number;
    modelRunAttemptId: ModelRunAttemptId;
    /**
     * The reply call completed without any visible text (a proven
     * `empty_output`, never a malformed stream). The first attempt of a
     * Command gets one technical retry for it, inside the request deadline and
     * under the same rules as any other technical retry (ADR-0083).
     */
    emptyReply?: boolean;
    /** The request ended (deadline or cancel): never schedule a retry (#319). */
    noRetry?: boolean;
    settledAt: Date;
    userId: UserId;
  }): Promise<
    | Readonly<{
        category: ProviderDispatchErrorCategory;
        outcome: "settled";
        status: "failed" | "interrupted";
      }>
    | Readonly<{ outcome: "retry_scheduled"; retryAt: Date }>
  >;
}>;

export type ConversationResponseService = Readonly<{
  respond(
    userId: UserId,
    input: {
      clientEventId: string;
      clientTurnId: string;
      locale: string;
      text: string;
      timezone: string;
    },
    signal?: AbortSignal,
  ): AsyncIterable<ConversationResponseStreamEvent>;
  retry(
    userId: UserId,
    input: {
      originalTurnId: string;
      retryRequestId: string;
    },
    signal?: AbortSignal,
  ): AsyncIterable<ConversationResponseStreamEvent>;
  scanStaleResponses(): Promise<
    Readonly<{
      committed: number;
      interrupted: number;
      processed: number;
      retried: number;
      terminal: number;
    }>
  >;
  scanPendingActionFinalizations?(): Promise<number>;
  /** Answer History Answer commands whose request never finished (#314). */
  scanPendingHistoryAnswers?(): Promise<number>;
}>;

export function createConversationResponseService(dependencies: {
  catalog: ConversationActionCatalog;
  actionGateway?: ConversationActionGateway;
  clock: () => Date;
  contextCompiler: ContextCompiler;
  conversationService: UserTextConversationService;
  harness: ConversationAgentHarness;
  harnessPolicy: ConversationHarnessPolicy;
  /** Lists History Answer commands that still need to be answered (#314). */
  historyRecall?: HistoryRecallGateway;
  jitter?: () => number;
  recoveryScanLimit?: number;
  recoveryGate?: RecoveryGate;
  /**
   * End-to-end budget of one chat request in milliseconds (ADR-0152: 60000).
   * It is frozen as an absolute deadline when the request is accepted and
   * shared by every step; unset keeps the legacy unbounded behavior (issue
   * #319). It is separate from the Provider transport timeout.
   */
  requestBudgetMs?: number;
  repository: ConversationResponseRepository;
}): ConversationResponseService {
  const requestBudgetMs = dependencies.requestBudgetMs;
  if (
    requestBudgetMs !== undefined &&
    (!Number.isInteger(requestBudgetMs) || requestBudgetMs <= 0)
  ) {
    throw new Error("requestBudgetMs must be a positive integer.");
  }
  // The newest accepted request per owner in this process. A newer user message
  // retires the older in-flight request at once; across processes the database
  // commit fence does the same (issue #319).
  const inFlightByUser = new Map<string, AbortController>();
  function beginRequest(): RequestDeadline | undefined {
    if (requestBudgetMs === undefined) return undefined;
    return createRequestDeadline({
      clock: dependencies.clock,
      deadlineAt: new Date(dependencies.clock().getTime() + requestBudgetMs),
    });
  }
  const recoveryScanLimit = dependencies.recoveryScanLimit ?? 100;
  const jitter = dependencies.jitter ?? Math.random;
  if (
    !Number.isInteger(recoveryScanLimit) ||
    recoveryScanLimit <= 0 ||
    recoveryScanLimit > 1_000
  ) {
    throw new Error(
      "recoveryScanLimit must be an integer from 1 through 1000.",
    );
  }
  function historyAnswerInput(deadline?: RequestDeadline) {
    return {
      catalog: dependencies.catalog,
      ...(deadline ? { deadline } : {}),
      harnessPolicy: {
        ...dependencies.harnessPolicy,
        maxHistoryQueries: 0 as const,
        maxStateChangingActions: 0 as const,
        toolsDisabled: true,
      },
    };
  }
  async function* streamResponse(
    userId: UserId,
    turn: Pick<UserTextTurn, "generation" | "turn">,
    requestEventRevisionId: ConversationEventRevisionId | null,
    initialEvent:
      | Extract<
          ConversationResponseStreamEvent,
          { type: "retry_committed" | "user_committed" }
        >
      | null,
    signal?: AbortSignal,
    deadline?: RequestDeadline,
  ): AsyncIterable<ConversationResponseStreamEvent> {
    // Claim request-lifecycle ownership of the Decision Command before emitting
    // any stream event, so a consumer that cancels immediately after the
    // user_committed/retry_committed event still triggers the abort-settle
    // below (the 'prepared' -> 'compiling' transition has already run).
    const ownership = await dependencies.repository.claimResponseExecution({
      generationCommandId: turn.generation.commandId,
      modelRunAttemptId: turn.generation.attemptId,
      userId,
    });

    // The aborted-settle defense belongs to the request lifecycle. If the
    // consumer cancels the stream at any point the Harness did not already
    // finalize (commit, fail, or shared replay), the owned attempt is settled
    // as aborted. `possiblyVisible` mirrors whether any decision delta reached
    // the user, so an abort after a partial stream is recorded as interrupted.
    // The Harness owns only the bounded single-Command Decision execution
    // (egress streaming, atomic commit, same-Command technical retry, empty
    // Catalog fail-closed); Provider messages, raw tool-call objects, and
    // Framework sessions never cross back through this seam (issue #24 AC6).
    let possiblyVisible = false;
    let settled = ownership === "shared";
    // Forward a later stage (Action Finalization or History Answer) onto the
    // public stream. The wire contract is unchanged: more deltas, then one
    // committed or failed event.
    async function* forwardStage(
      stageEvents: AsyncIterable<
        ConversationHarnessEvent
      >,
    ): AsyncIterable<ConversationResponseStreamEvent> {
      for await (const stageEvent of stageEvents) {
        if (stageEvent.type === "decision_delta") {
          possiblyVisible = true;
          yield { delta: stageEvent.delta, type: "assistant_delta" };
        } else if (stageEvent.type === "decision_committed") {
          settled = true;
          yield {
            createdAt: stageEvent.assistantCreatedAt,
            eventId: stageEvent.assistantEventId,
            revisionId: stageEvent.assistantEventRevisionId,
            type: "assistant_committed",
          };
        } else if (stageEvent.type === "decision_failed") {
          settled = true;
          yield {
            category: stageEvent.category,
            type: stageEvent.interrupted
              ? "response_interrupted"
              : "response_failed",
          };
        } else {
          settled = true;
          yield { category: "invalid_response", type: "response_failed" };
        }
      }
    }
    try {
      if (initialEvent) {
        yield initialEvent;
      }

      // Shared ownership: another concurrent request already finalized this
      // GenerationCommand. Replay whatever it committed without re-executing the
      // Decision. This arbitration belongs to the request lifecycle, not to the
      // single-Command Harness execution.
      if (ownership === "shared") {
        const response = await dependencies.repository.loadResponse({
          generationCommandId: turn.generation.commandId,
          userId,
        });
        yield* streamExistingResponse(response);
        return;
      }

      // The Service compiles request-lifecycle Context and hands the
      // already-compiled CompiledContext reference to the Harness (ADR-0093,
      // architecture 08-10 §8.1).
      let context: Awaited<ReturnType<ContextCompiler["compile"]>>;
      try {
        context = await interruptible(
          dependencies.contextCompiler.compile({
            generationCommandId: turn.generation.commandId,
            interactionTurnId: turn.turn.id,
            userId,
          }),
          signal,
          deadline,
        );
      } catch (error) {
        if (!(error instanceof ProviderDispatchError)) throw error;
        // The request ended (deadline or cancel) while the Context was being
        // read: settle honestly and say so, without starting anything new.
        await dependencies.repository.settleResponseFailure({
          category: error.category,
          generationCommandId: turn.generation.commandId,
          interrupted: false,
          jitter: normalizedJitter(jitter()),
          modelRunAttemptId: turn.generation.attemptId,
          settledAt: dependencies.clock(),
          userId,
        });
        settled = true;
        yield { category: error.category, type: "response_failed" };
        return;
      }
      for await (const event of dependencies.harness.runDecision(
        {
          ...(deadline ? { deadline } : {}),
          ...(context.actionReferenceHandles === undefined
            ? {}
            : { actionReferenceHandles: context.actionReferenceHandles }),
          catalog: dependencies.catalog,
          catalogVersion: dependencies.catalog.version,
          compiledContextId: context.id,
          generationCommandId: turn.generation.commandId,
          harnessPolicy: dependencies.harnessPolicy,
          interactionTurnId: turn.turn.id,
          modelRunAttemptId: turn.generation.attemptId,
          ...(requestEventRevisionId ? { requestEventRevisionId } : {}),
          userId,
        },
        signal,
      )) {
        if (event.type === "decision_delta") {
          possiblyVisible = true;
          yield { delta: event.delta, type: "assistant_delta" };
        } else if (event.type === "decision_committed") {
          settled = true;
          yield {
            createdAt: event.assistantCreatedAt,
            eventId: event.assistantEventId,
            revisionId: event.assistantEventRevisionId,
            type: "assistant_committed",
          };
        } else if (event.type === "action_admitted") {
          yield event;
          const finalization = event.receipt.finalization;
          // #119: Trust-Control Actions also finalize their non-accepted
          // admissions — the count-only multi-hit clarification and the
          // honest zero-hit report are real replies, shaped by the frozen
          // receipt (the finalization command exists exactly when a reply is
          // owed). Accepted actions keep the existing flow.
          if (
            finalization &&
            dependencies.harness.runFinalizationCommand
          ) {
            const finalizationCommandId = asGenerationCommandId(
              finalization.generationCommandId,
            );
            const finalizationAttemptId = asModelRunAttemptId(
              finalization.modelRunAttemptId,
            );
            if (!dependencies.harness.runFinalizationCommand) {
              throw new Error("Action Finalization orchestration is unavailable.");
            }
            yield* forwardStage(
              dependencies.harness.runFinalizationCommand(
                {
                  actionExecutionId: event.receipt.actionExecutionId,
                  generationCommandId: finalizationCommandId,
                  interactionTurnId: turn.turn.id,
                  modelRunAttemptId: finalizationAttemptId,
                  requestEventRevisionId: requestEventRevisionId!,
                  receipt: {
                    admission: event.receipt.admission,
                    disposition: event.receipt.disposition,
                    execution: event.receipt.execution,
                    sequence: event.receipt.receiptSequence,
                  },
                  userId,
                },
                {
                  catalog: dependencies.catalog,
                  ...(deadline ? { deadline } : {}),
                  harnessPolicy: {
                    ...dependencies.harnessPolicy,
                    maxStateChangingActions: 0,
                    toolsDisabled: true,
                  },
                },
                signal,
              ),
            );
          } else {
            settled = true;
          }
        } else if (event.type === "history_recall_admitted") {
          // Issue #314: the Decision ended in a controlled read-only history
          // query that is already executed and frozen. The independent History
          // Answer command now produces the one complete response.
          if (!dependencies.harness.runHistoryAnswerCommand) {
            throw new Error("History Answer orchestration is unavailable.");
          }
          yield* forwardStage(
            dependencies.harness.runHistoryAnswerCommand(
              {
                generationCommandId: event.receipt.answer.generationCommandId,
                interactionTurnId: turn.turn.id,
                modelRunAttemptId: event.receipt.answer.modelRunAttemptId,
                requestEventRevisionId: requestEventRevisionId!,
                userId,
              },
              historyAnswerInput(deadline),
              signal,
            ),
          );
        } else {
          settled = true;
          yield {
            category: event.category,
            type: event.interrupted ? "response_interrupted" : "response_failed",
          };
        }
      }
    } finally {
      if (!settled) {
        await dependencies.repository.settleResponseFailure({
          category: "aborted",
          generationCommandId: turn.generation.commandId,
          interrupted: possiblyVisible,
          jitter: normalizedJitter(jitter()),
          modelRunAttemptId: turn.generation.attemptId,
          settledAt: dependencies.clock(),
          userId,
        });
      }
    }
  }

  return {
    async *respond(userId, input, signal) {
      const deadline = beginRequest();
      const mine = new AbortController();
      try {
        await dependencies.recoveryGate?.requireOpen(userId);
        const turn = await dependencies.conversationService.submit(
          userId,
          input,
          deadline ? { requestDeadlineAt: deadline.deadlineAt } : undefined,
        );
        if (!turn.replayed) {
          // Accepting a newer message retires the older in-flight answer: its
          // Provider call is cancelled, and the database fence rejects it even
          // if the cancel never lands.
          inFlightByUser.get(userId)?.abort();
          inFlightByUser.set(userId, mine);
        }
        yield* streamResponse(
          userId,
          turn,
          turn.message.revisionId,
          {
            generationCommandId: turn.generation.commandId,
            message: turn.message,
            modelRunAttemptId: turn.generation.attemptId,
            turnId: turn.turn.id,
            type: "user_committed",
            userEventRevisionId: turn.message.revisionId,
          },
          signal ? AbortSignal.any([signal, mine.signal]) : mine.signal,
          deadline,
        );
      } finally {
        deadline?.release();
        if (inFlightByUser.get(userId) === mine) inFlightByUser.delete(userId);
      }
    },
    async *retry(userId, input, signal) {
      const deadline = beginRequest();
      const mine = new AbortController();
      try {
        await dependencies.recoveryGate?.requireOpen(userId);
        const retry: ConversationRetryTurn =
          await dependencies.conversationService.retry(
            userId,
            input,
            deadline ? { requestDeadlineAt: deadline.deadlineAt } : undefined,
          );
        inFlightByUser.get(userId)?.abort();
        inFlightByUser.set(userId, mine);
        yield* streamResponse(
          userId,
          retry,
          null,
          {
            generationCommandId: retry.generation.commandId,
            modelRunAttemptId: retry.generation.attemptId,
            originalTurnId: retry.originalTurnId,
            retryActionEventId: retry.retryActionEventId,
            retryRequestId: retry.retryRequestId,
            turnId: retry.turn.id,
            type: "retry_committed",
          },
          signal ? AbortSignal.any([signal, mine.signal]) : mine.signal,
          deadline,
        );
      } finally {
        deadline?.release();
        if (inFlightByUser.get(userId) === mine) inFlightByUser.delete(userId);
      }
    },
    async scanStaleResponses() {
      const now = dependencies.clock();
      const executions =
        await dependencies.repository.listStaleResponseExecutions({
          dueAt: now,
          limit: recoveryScanLimit,
        });
      let committed = 0;
      let interrupted = 0;
      let processed = 0;
      let retried = 0;
      let terminal = 0;
      for (const candidate of executions) {
        const claim =
          await dependencies.repository.claimStaleResponseExecution({
            expectedModelRunAttemptId: candidate.modelRunAttemptId,
            generationCommandId: candidate.generationCommandId,
            now,
            userId: candidate.userId,
          });
        if (claim.outcome === "not_due" || claim.outcome === "replayed") {
          continue;
        }
        if (claim.outcome === "interrupted") {
          processed += 1;
          interrupted += 1;
          continue;
        }
        if (claim.outcome === "terminal") {
          processed += 1;
          terminal += 1;
          continue;
        }
        let owned = false;
        let outcome: "committed" | "interrupted" | "terminal" | null = null;
        for await (const event of streamResponse(
          claim.userId,
          {
            generation: {
              attemptId: claim.modelRunAttemptId,
              commandId: claim.generationCommandId,
            },
            turn: {
              id: claim.turnId,
              sequence: 0,
              status: "open",
            },
          },
          null,
          null,
        )) {
          owned = true;
          if (event.type === "assistant_committed") {
            outcome = "committed";
          } else if (event.type === "response_interrupted") {
            outcome = "interrupted";
          } else if (event.type === "response_failed") {
            outcome = "terminal";
          }
        }
        if (!owned || outcome === null) {
          continue;
        }
        processed += 1;
        if (claim.retried) {
          retried += 1;
        }
        if (outcome === "committed") {
          committed += 1;
        } else if (outcome === "interrupted") {
          interrupted += 1;
        } else {
          terminal += 1;
        }
      }
      return {
        committed,
        interrupted,
        processed,
        retried,
        terminal,
      };
    },
    async scanPendingActionFinalizations() {
      const pending = await dependencies.actionGateway?.listPendingFinalizations?.({
        limit: recoveryScanLimit,
      });
      if (!pending || !dependencies.harness.runFinalizationCommand) return 0;
      let processed = 0;
      for (const command of pending) {
        if (!dependencies.harness.runFinalizationCommand) continue;
        for await (const event of dependencies.harness.runFinalizationCommand(
          command,
          {
            catalog: dependencies.catalog,
            harnessPolicy: {
              ...dependencies.harnessPolicy,
              maxStateChangingActions: 0,
              toolsDisabled: true,
            },
          },
        )) {
          if (
            event.type === "decision_committed" ||
            event.type === "decision_failed"
          ) {
            processed += 1;
            break;
          }
        }
      }
      return processed;
    },
    async scanPendingHistoryAnswers() {
      if (!dependencies.historyRecall) {
        // The history branch is not part of this runtime (switch off): a
        // command a crashed process left behind can never be answered, so it
        // is closed instead of leaving its Turn responding forever.
        return (
          (await dependencies.repository.settleStaleHistoryAnswers?.({
            dueAt: dependencies.clock(),
            limit: recoveryScanLimit,
          })) ?? 0
        );
      }
      const pending = await dependencies.historyRecall.listPendingAnswers({
        limit: recoveryScanLimit,
      });
      if (!dependencies.harness.runHistoryAnswerCommand) return 0;
      let processed = 0;
      for (const command of pending) {
        for await (const event of dependencies.harness.runHistoryAnswerCommand(
          command,
          historyAnswerInput(),
        )) {
          if (
            event.type === "decision_committed" ||
            event.type === "decision_failed"
          ) {
            processed += 1;
            break;
          }
        }
      }
      return processed;
    },
  };
}

function normalizedJitter(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

async function* streamExistingResponse(
  response: ExistingConversationResponse,
): AsyncIterable<ConversationResponseStreamEvent> {
  if (response.outcome === "committed") {
    yield { delta: response.text, type: "assistant_delta" };
    yield {
      createdAt: response.createdAt,
      eventId: response.eventId,
      revisionId: response.revisionId,
      type: "assistant_committed",
    };
    return;
  }
  if (response.outcome === "failed" || response.outcome === "interrupted") {
    yield {
      category: response.category,
      type:
        response.outcome === "interrupted"
          ? "response_interrupted"
          : "response_failed",
    };
    return;
  }
  yield { category: "unavailable", type: "response_failed" };
}

/**
 * Waits for `work` but gives up as soon as the request is cancelled or its
 * deadline passes, so a database read that cannot be cancelled still cannot
 * hold the request past its budget (issue #319).
 */
async function interruptible<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  deadline: RequestDeadline | undefined,
): Promise<T> {
  const interrupt = createRequestInterrupt(signal, deadline);
  work.catch(() => undefined);
  // A request that already ended never gets the result, even a ready one.
  interrupt.throwIfInterrupted();
  return interrupt.guard(work);
}
