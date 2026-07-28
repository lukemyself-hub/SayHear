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
  claimResponseExecution(input: {
    generationCommandId: GenerationCommandId;
    userId: UserId;
  }): Promise<"owner" | "shared">;
  loadResponse(input: {
    generationCommandId: GenerationCommandId;
    userId: UserId;
  }): Promise<ExistingConversationResponse>;
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
    modelRunAttemptId: ModelRunAttemptId;
    settledAt: Date;
    userId: UserId;
  }): Promise<void>;
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
}>;

export function createConversationResponseService(dependencies: {
  clock: () => Date;
  contextCompiler: ContextCompiler;
  conversationService: UserTextConversationService;
  egressPort: ProviderEgressPort;
  repository: ConversationResponseRepository;
}): ConversationResponseService {
  return {
    async *respond(userId, input, signal) {
      const turn = await dependencies.conversationService.submit(userId, input);
      const ownership = await dependencies.repository.claimResponseExecution({
        generationCommandId: turn.generation.commandId,
        userId,
      });
      let possiblyVisible = false;
      let completeText = "";
      let completion: CompleteResponseMetadata | null = null;
      let settled = ownership === "shared";

      try {
        yield {
          generationCommandId: turn.generation.commandId,
          message: turn.message,
          modelRunAttemptId: turn.generation.attemptId,
          turnId: turn.turn.id,
          type: "user_committed",
          userEventRevisionId: turn.message.revisionId,
        };

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
        await dependencies.repository.settleResponseFailure({
          category,
          generationCommandId: turn.generation.commandId,
          interrupted: possiblyVisible,
          modelRunAttemptId: turn.generation.attemptId,
          settledAt: dependencies.clock(),
          userId,
        });
        settled = true;
        yield {
          category,
          type: possiblyVisible ? "response_interrupted" : "response_failed",
        };
      } finally {
        if (!settled) {
          await dependencies.repository.settleResponseFailure({
            category: "aborted",
            generationCommandId: turn.generation.commandId,
            interrupted: possiblyVisible,
            modelRunAttemptId: turn.generation.attemptId,
            settledAt: dependencies.clock(),
            userId,
          });
        }
      }
    },
  };
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
