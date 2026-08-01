import { describe, expect, it } from "vitest";

import {
  asConversationEventRevisionId,
  ProviderDispatchError,
  renderMinimumHighRiskResponse,
  type ConversationTextMessage,
} from "@sayhear/application";

import {
  createBehaviorAwareConversationTextModel,
  type ConversationUnderstandingTurn,
} from "./behavior-aware-conversation-text-model";

const revisionId = asConversationEventRevisionId(
  "01984477-59a9-7d20-9d97-e588769566a0",
);

function request(messages: readonly ConversationTextMessage[], locale = "en-US") {
  return Object.freeze({
    instructions: "Instructions rendered by Context Compiler.",
    locale,
    messages: Object.freeze(messages),
    model: "behavior-aware-test-model",
  });
}

async function collect(
  model: ReturnType<typeof createBehaviorAwareConversationTextModel>,
  messages: readonly ConversationTextMessage[],
  locale?: string,
) {
  const events = [];
  for await (const event of model.stream(request(messages, locale))) {
    events.push(event);
  }
  return events;
}

describe("behavior-aware Conversation Text model", () => {
  it("returns the responder understanding chunks for an ordinary expression", async () => {
    const seen: ConversationUnderstandingTurn[] = [];
    const model = createBehaviorAwareConversationTextModel({
      responder: (turn) => {
        seen.push(turn);
        return ["I hear that this mattered to you."];
      },
    });
    const events = await collect(model, [
      { revisionId, role: "user", text: "Nobody backed me up in the meeting." },
    ]);

    expect(events.map((event) => event.type)).toEqual(["delta", "completed"]);
    expect(events[0]).toMatchObject({
      delta: "I hear that this mattered to you.",
      type: "delta",
    });
    expect(seen).toEqual([
      {
        history: [],
        locale: "en-US",
        text: "Nobody backed me up in the meeting.",
      },
    ]);
  });

  it("passes prior committed turns as history and preserves the current locale", async () => {
    const seen: ConversationUnderstandingTurn[] = [];
    const model = createBehaviorAwareConversationTextModel({
      responder: (turn) => {
        seen.push(turn);
        return ["听到了。"];
      },
    });
    await collect(
      model,
      [
        { revisionId, role: "user", text: "今天开会有点委屈。" },
        {
          revisionId: asConversationEventRevisionId(
            "01984477-59a9-7d20-9d97-e588769566a1",
          ),
          role: "assistant",
          text: "听起来这次会议对你很重要。",
        },
        {
          revisionId: asConversationEventRevisionId(
            "01984477-59a9-7d20-9d97-e588769566a2",
          ),
          role: "user",
          text: "对，他们没有一个人支持我。",
        },
      ],
      "zh-CN",
    );

    expect(seen[0]).toMatchObject({
      locale: "zh-CN",
      text: "对，他们没有一个人支持我。",
    });
    expect(seen[0]?.history).toEqual([
      { role: "user", text: "今天开会有点委屈。" },
      { role: "assistant", text: "听起来这次会议对你很重要。" },
    ]);
  });

  it.each([
    ["self-harm", "en-US", "I want to kill myself tonight."],
    ["harm-to-others", "en-US", "I am going to hurt someone close to me."],
    ["imminent danger", "en-US", "I cannot keep myself safe right now."],
    ["self-harm", "zh-CN", "我不想活了。"],
  ])(
    "emits the versioned Minimum High-Risk Response for %s without calling the responder",
    async (_label, locale, text) => {
      let responderCalls = 0;
      const model = createBehaviorAwareConversationTextModel({
        responder: () => {
          responderCalls += 1;
          return ["must not be used for a high-risk turn"];
        },
      });
      const events = await collect(model, [{ revisionId, role: "user", text }], locale);

      expect(events.map((event) => event.type)).toEqual(["delta", "completed"]);
      expect(events[0]).toMatchObject({
        delta: renderMinimumHighRiskResponse({ kind: "self_harm", locale }),
        type: "delta",
      });
      expect(responderCalls).toBe(0);
    },
  );

  it("classifies deterministic faults before visibility and after completion", async () => {
    await expect(
      collect(
        createBehaviorAwareConversationTextModel({
          responder: () => ["complete"],
          failAfterChunks: 0,
        }),
        [{ revisionId, role: "user", text: "An ordinary turn." }],
      ),
    ).rejects.toMatchObject({
      category: "unavailable",
    } satisfies Partial<ProviderDispatchError>);

    const afterCompletion = createBehaviorAwareConversationTextModel({
      responder: () => ["complete"],
      failAfterCompletion: true,
    }).stream(request([{ revisionId, role: "user", text: "An ordinary turn." }]))[
      Symbol.asyncIterator
    ]();
    await expect(afterCompletion.next()).resolves.toMatchObject({
      value: { delta: "complete", type: "delta" },
    });
    await expect(afterCompletion.next()).resolves.toMatchObject({
      value: { type: "completed" },
    });
    await expect(afterCompletion.next()).rejects.toMatchObject({
      category: "unavailable",
    } satisfies Partial<ProviderDispatchError>);
  });
});
