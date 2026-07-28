import { describe, expect, it } from "vitest";

import {
  ProviderDispatchError,
  type ConversationTextModelRequest,
} from "@sayhear/application";

import { createDeterministicConversationTextModel } from "./deterministic-conversation-text-model";

const request = Object.freeze({
  instructions: "Synthetic system-seam instructions.",
  messages: Object.freeze([]),
  model: "deterministic-test-model",
}) satisfies ConversationTextModelRequest;

describe("deterministic Conversation Text model", () => {
  it("injects failures before output, after a visible prefix, and after completion", async () => {
    await expect(
      collect(
        createDeterministicConversationTextModel({
          chunks: ["first", "second"],
          failAfterChunks: 0,
        }),
      ),
    ).rejects.toMatchObject({
      category: "unavailable",
    } satisfies Partial<ProviderDispatchError>);

    const afterPrefix = createDeterministicConversationTextModel({
      chunks: ["first", "second"],
      failAfterChunks: 1,
    }).stream(request)[Symbol.asyncIterator]();
    await expect(afterPrefix.next()).resolves.toEqual({
      done: false,
      value: { delta: "first", type: "delta" },
    });
    await expect(afterPrefix.next()).rejects.toMatchObject({
      category: "unavailable",
    } satisfies Partial<ProviderDispatchError>);

    const afterCompletion = createDeterministicConversationTextModel({
      chunks: ["complete"],
      failAfterCompletion: true,
    }).stream(request)[Symbol.asyncIterator]();
    await expect(afterCompletion.next()).resolves.toEqual({
      done: false,
      value: { delta: "complete", type: "delta" },
    });
    await expect(afterCompletion.next()).resolves.toMatchObject({
      done: false,
      value: { finishReason: "completed", type: "completed" },
    });
    await expect(afterCompletion.next()).rejects.toMatchObject({
      category: "unavailable",
    } satisfies Partial<ProviderDispatchError>);
  });
});

async function collect(
  model: ReturnType<typeof createDeterministicConversationTextModel>,
) {
  const events = [];
  for await (const event of model.stream(request)) {
    events.push(event);
  }
  return events;
}
