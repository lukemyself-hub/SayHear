import {
  ProviderDispatchError,
  type ConversationTextModel,
} from "@sayhear/application";

import { streamDeterministicDeltas } from "./deterministic-stream";

export function createDeterministicConversationTextModel(input: {
  chunks: readonly string[];
  failAfterCompletion?: boolean;
  failAfterChunks?: number;
}): ConversationTextModel {
  return {
    async *stream(request) {
      yield* streamDeterministicDeltas(
        request,
        input.chunks,
        input.failAfterChunks,
      );
      yield {
        costMicros: 0,
        finishReason: "completed",
        inputTokens: request.messages.reduce(
          (total, message) => total + Math.ceil(message.text.length / 4),
          0,
        ),
        modelSnapshot: request.model,
        outputTokens: Math.ceil(input.chunks.join("").length / 4),
        providerRequestId: "deterministic-request",
        type: "completed",
      };
      if (input.failAfterCompletion) {
        throw new ProviderDispatchError("unavailable");
      }
    },
  };
}
