import {
  ProviderDispatchError,
  type ConversationTextModelRequest,
  type ConversationTextModelStreamEvent,
} from "@sayhear/application";

/**
 * The shared delta-emission scaffold for every deterministic Conversation Text
 * model. It yields one `delta` event per chunk with the same `aborted` and
 * `failAfterChunks` fault injection, then throws once the configured chunk
 * ceiling is reached. The `completed` event is emitted by the caller so each
 * model keeps its own token accounting.
 */
export async function* streamDeterministicDeltas(
  request: ConversationTextModelRequest,
  chunks: readonly string[],
  failAfterChunks?: number,
): AsyncGenerator<Extract<ConversationTextModelStreamEvent, { type: "delta" }>> {
  let emitted = 0;
  for (const chunk of chunks) {
    if (request.signal?.aborted) {
      throw new ProviderDispatchError("aborted");
    }
    if (failAfterChunks !== undefined && emitted >= failAfterChunks) {
      throw new ProviderDispatchError("unavailable");
    }
    emitted += 1;
    yield { delta: chunk, type: "delta" };
  }
  if (failAfterChunks !== undefined && emitted >= failAfterChunks) {
    throw new ProviderDispatchError("unavailable");
  }
}
