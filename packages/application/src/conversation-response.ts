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
import type { ConversationAgentHarness } from "./conversation-agent-harness";
import { type ProviderDispatchErrorCategory } from "./conversation-model";
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
  commitCompleteResponse(input: {
    completedAt: Date;
    generationCommandId: GenerationCommandId;
    metadata: CompleteResponseMetadata;
    modelRunAttemptId: ModelRunAttemptId;
    text: string;
    userId: UserId;
  }): Promise<
    | Readonly<{
        eventId: ConversationEventId;
        outcome: "committed";
        revisionId: ConversationEventRevisionId;
      }>
    | Readonly<{ outcome: "fence_rejected" }>
  >;
  settleResponseFailure(input: {
    category: ProviderDispatchErrorCategory;
    generationCommandId: GenerationCommandId;
    interrupted: boolean;
    jitter: number;
    modelRunAttemptId: ModelRunAttemptId;
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
}>;

export function createConversationResponseService(dependencies: {
  catalog: ConversationActionCatalog;
  actionGateway?: ConversationActionGateway;
  clock: () => Date;
  contextCompiler: ContextCompiler;
  conversationService: UserTextConversationService;
  harness: ConversationAgentHarness;
  harnessPolicy: ConversationHarnessPolicy;
  jitter?: () => number;
  recoveryScanLimit?: number;
  recoveryGate?: RecoveryGate;
  repository: ConversationResponseRepository;
}): ConversationResponseService {
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
      const context = await dependencies.contextCompiler.compile({
        generationCommandId: turn.generation.commandId,
        interactionTurnId: turn.turn.id,
        userId,
      });
      for await (const event of dependencies.harness.runDecision(
        {
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
            eventId: event.assistantEventId,
            revisionId: event.assistantEventRevisionId,
            type: "assistant_committed",
          };
        } else if (event.type === "action_admitted") {
          yield event;
          const finalization = event.receipt.finalization;
          if (
            event.receipt.admission === "accepted" &&
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
            for await (const finalizationEvent of dependencies.harness.runFinalizationCommand(
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
                harnessPolicy: {
                  ...dependencies.harnessPolicy,
                  maxStateChangingActions: 0,
                  toolsDisabled: true,
                },
              },
              signal,
            )) {
              if (finalizationEvent.type === "decision_delta") {
                possiblyVisible = true;
                yield {
                  delta: finalizationEvent.delta,
                  type: "assistant_delta",
                };
              } else if (finalizationEvent.type === "decision_committed") {
                settled = true;
                yield {
                  eventId: finalizationEvent.assistantEventId,
                  revisionId: finalizationEvent.assistantEventRevisionId,
                  type: "assistant_committed",
                };
              } else if (finalizationEvent.type === "decision_failed") {
                settled = true;
                yield {
                  category: finalizationEvent.category,
                  type: finalizationEvent.interrupted
                    ? "response_interrupted"
                    : "response_failed",
                };
              } else {
                settled = true;
                yield {
                  category: "invalid_response",
                  type: "response_failed",
                };
              }
            }
          } else {
            settled = true;
          }
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
      await dependencies.recoveryGate?.requireOpen(userId);
      const turn = await dependencies.conversationService.submit(userId, input);
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
        signal,
      );
    },
    async *retry(userId, input, signal) {
      await dependencies.recoveryGate?.requireOpen(userId);
      const retry: ConversationRetryTurn =
        await dependencies.conversationService.retry(userId, input);
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
        signal,
      );
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
