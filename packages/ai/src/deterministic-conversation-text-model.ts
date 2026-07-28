import {
  ProviderDispatchError,
  type ConversationTextModel,
} from "@sayhear/application";

export function createDeterministicConversationTextModel(input: {
  chunks: readonly string[];
  failAfterCompletion?: boolean;
  failAfterChunks?: number;
}): ConversationTextModel {
  return {
    async *stream(request) {
      let emitted = 0;
      for (const chunk of input.chunks) {
        if (request.signal?.aborted) {
          throw new ProviderDispatchError("aborted");
        }
        if (
          input.failAfterChunks !== undefined &&
          emitted >= input.failAfterChunks
        ) {
          throw new ProviderDispatchError("unavailable");
        }
        emitted += 1;
        yield { delta: chunk, type: "delta" };
      }
      if (
        input.failAfterChunks !== undefined &&
        emitted >= input.failAfterChunks
      ) {
        throw new ProviderDispatchError("unavailable");
      }
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
