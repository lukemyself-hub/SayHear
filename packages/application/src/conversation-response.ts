import type {
  ConversationEventId,
  ConversationEventRevisionId,
  GenerationCommandId,
  InteractionTurnId,
  ModelRunAttemptId,
  UserId,
} from "@sayhear/domain";

import type { ContextCompiler } from "./context-compiler";
import {
  ProviderDispatchError,
  type ProviderDispatchErrorCategory,
  type ProviderEgressPort,
} from "./conversation-model";
import type {
  ConversationRetryTurn,
  UserTextConversationService,
  UserTextTurn,
} from "./user-text-conversation";

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
}>;

export function createConversationResponseService(dependencies: {
  clock: () => Date;
  contextCompiler: ContextCompiler;
  conversationService: UserTextConversationService;
  delay?: (delayMs: number) => Promise<void>;
  egressPort: ProviderEgressPort;
  jitter?: () => number;
  recoveryScanLimit?: number;
  repository: ConversationResponseRepository;
}): ConversationResponseService {
  const delay =
    dependencies.delay ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const jitter = dependencies.jitter ?? Math.random;
  const recoveryScanLimit = dependencies.recoveryScanLimit ?? 100;
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
    initialEvent:
      | Extract<
          ConversationResponseStreamEvent,
          { type: "retry_committed" | "user_committed" }
        >
      | null,
    signal?: AbortSignal,
  ): AsyncIterable<ConversationResponseStreamEvent> {
    const ownership = await dependencies.repository.claimResponseExecution({
      generationCommandId: turn.generation.commandId,
      modelRunAttemptId: turn.generation.attemptId,
      userId,
    });
    let possiblyVisible = false;
    let completeText = "";
    let completion: CompleteResponseMetadata | null = null;
    let settled = ownership === "shared";

    try {
      if (initialEvent) {
        yield initialEvent;
      }

      if (ownership === "shared") {
        const response = await dependencies.repository.loadResponse({
          generationCommandId: turn.generation.commandId,
          userId,
        });
        yield* streamExistingResponse(response);
        return;
      }

      const context = await dependencies.contextCompiler.compile({
        generationCommandId: turn.generation.commandId,
        interactionTurnId: turn.turn.id,
        userId,
      });
      for await (const event of dependencies.egressPort.stream({
        compiledContextId: context.id,
        generationCommandId: turn.generation.commandId,
        modelRunAttemptId: turn.generation.attemptId,
        ...(signal ? { signal } : {}),
      })) {
        if (event.type === "delta") {
          possiblyVisible = true;
          completeText += event.delta;
          yield { delta: event.delta, type: "assistant_delta" };
        } else {
          completion = event;
        }
      }
      if (completion === null || completeText.length === 0) {
        throw new ProviderDispatchError("invalid_response");
      }

      const committed = await dependencies.repository.commitCompleteResponse({
        completedAt: dependencies.clock(),
        generationCommandId: turn.generation.commandId,
        metadata: completion,
        modelRunAttemptId: turn.generation.attemptId,
        text: completeText,
        userId,
      });
      if (committed.outcome === "fence_rejected") {
        throw new ProviderDispatchError("policy_blocked");
      }
      settled = true;
      yield {
        eventId: committed.eventId,
        revisionId: committed.revisionId,
        type: "assistant_committed",
      };
    } catch (error) {
      if (
        error instanceof ProviderDispatchError &&
        !error.settlesAttempt
      ) {
        settled = true;
        const response = await dependencies.repository.loadResponse({
          generationCommandId: turn.generation.commandId,
          userId,
        });
        yield* streamExistingResponse(response);
        return;
      }
      const category =
        error instanceof ProviderDispatchError ? error.category : "unknown";
      const interrupted = possiblyVisible || category === "unknown";
      const failure = await dependencies.repository.settleResponseFailure({
        category,
        generationCommandId: turn.generation.commandId,
        interrupted,
        jitter: normalizedJitter(jitter()),
        modelRunAttemptId: turn.generation.attemptId,
        settledAt: dependencies.clock(),
        userId,
      });
      settled = true;
      if (failure.outcome === "retry_scheduled") {
        await delay(
          Math.max(0, failure.retryAt.getTime() - dependencies.clock().getTime()),
        );
        const recovery =
          await dependencies.repository.claimStaleResponseExecution({
            expectedModelRunAttemptId: turn.generation.attemptId,
            generationCommandId: turn.generation.commandId,
            now: failure.retryAt,
            userId,
          });
        if (recovery.outcome === "execute") {
          yield* streamResponse(
            userId,
            {
              generation: {
                attemptId: recovery.modelRunAttemptId,
                commandId: recovery.generationCommandId,
              },
              turn: {
                id: recovery.turnId,
                sequence: 0,
                status: "responding",
              },
            },
            null,
            signal,
          );
          return;
        }
      }
      const failureCategory =
        failure.outcome === "settled" ? failure.category : category;
      const failureInterrupted =
        failure.outcome === "settled"
          ? failure.status === "interrupted"
          : interrupted;
      yield {
        category: failureCategory,
        type: failureInterrupted
          ? "response_interrupted"
          : "response_failed",
      };
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
      const turn = await dependencies.conversationService.submit(userId, input);
      yield* streamResponse(
        userId,
        turn,
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
      const retry: ConversationRetryTurn =
        await dependencies.conversationService.retry(userId, input);
      yield* streamResponse(
        userId,
        retry,
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
