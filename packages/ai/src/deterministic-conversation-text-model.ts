import {
  ProviderDispatchError,
  type ConversationTextModel,
} from "@sayhear/application";

import { streamDeterministicDeltas } from "./deterministic-stream";

export function createDeterministicConversationTextModel(input: {
  chunks: readonly string[];
  failAfterCompletion?: boolean;
  failAfterChunks?: number;
  /**
   * When set, the model emits one provider-native `tool_call` event before any
   * delta. It is a fault-injection seam for the Harness fail-closed contract
   * (issue #24 AC8): a tool_call against an empty Conversation Action Catalog
   * must fail closed and never produce a fabricated success response.
   */
  emitToolCall?: Readonly<{ rawArguments: string; rawFunctionName: string }>;
}): ConversationTextModel {
  return {
    async *stream(request) {
      if (input.emitToolCall) {
        yield {
          rawArguments: input.emitToolCall.rawArguments,
          rawFunctionName: input.emitToolCall.rawFunctionName,
          type: "tool_call",
        };
      }
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
