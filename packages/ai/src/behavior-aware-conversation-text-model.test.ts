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

function request(
  messages: readonly ConversationTextMessage[],
  locale = "en-US",
  withRegenerationFunction = false,
) {
  return Object.freeze({
    instructions: withRegenerationFunction
      ? "Instructions rendered by Context Compiler.\nAvailable Action Reference Handles (opaque and command-scoped):\n- regenerate_journal: shh-handle-current"
      : "Instructions rendered by Context Compiler.",
    locale,
    messages: Object.freeze(messages),
    model: "behavior-aware-test-model",
    ...(withRegenerationFunction
      ? {
          functions: [{
            description: "Regenerate the current Journal.",
            name: "regenerate_journal",
            parameters: { type: "object" },
            strict: true as const,
          }],
        }
      : {}),
  });
}

async function collect(
  model: ReturnType<typeof createBehaviorAwareConversationTextModel>,
  messages: readonly ConversationTextMessage[],
  locale?: string,
  withRegenerationFunction = false,
) {
  const events = [];
  for await (const event of model.stream(request(messages, locale, withRegenerationFunction))) {
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
        signal: "engaged",
        text: "Nobody backed me up in the meeting.",
      },
    ]);
  });

  it("propagates the classified turn signal so the responder can stop pressing", async () => {
    const seen: ConversationUnderstandingTurn[] = [];
    const model = createBehaviorAwareConversationTextModel({
      responder: (turn) => {
        seen.push(turn);
        return ["听到了，现在不着急。"];
      },
    });
    await collect(model, [
      { revisionId, role: "user", text: "I'd rather not get into it." },
    ]);

    expect(seen[0]?.signal).toBe("avoidance");
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

  it.each([
    ["English", "I don't like how this Journal is written; make the wording clearer.", "en-US"],
    ["Chinese", "我不喜欢这篇 Journal 的表达，请把重点写得更清楚。", "zh-CN"],
    ["code-switch", "这个 Journal 的 expression 不够清楚，please regenerate it.", "zh-CN"],
  ])("selects only bounded expression regeneration for %s", async (_label, text, locale) => {
    const events = await collect(
      createBehaviorAwareConversationTextModel({ responder: () => ["not used"] }),
      [{ revisionId, role: "user", text }],
      locale,
      true,
    );
    expect(events[0]).toMatchObject({
      rawFunctionName: "regenerate_journal",
      type: "tool_call",
    });
  });

  it.each([
    "I don't like this.",
    "Rewrite the Journal in first person and delete the old version.",
    "这件事写错了，请纠正事实。",
    "Give me three candidate versions in a poetic style.",
  ])("does not select regeneration for unsupported or ambiguous request: %s", async (text) => {
    const events = await collect(
      createBehaviorAwareConversationTextModel({ responder: () => ["clarify"] }),
      [{ revisionId, role: "user", text }],
      "en-US",
      true,
    );
    expect(events.map((event) => event.type)).toEqual(["delta", "completed"]);
  });
});
