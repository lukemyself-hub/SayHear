import { describe, expect, it } from "vitest";

import {
  asConversationEventRevisionId,
} from "@sayhear/application";

import { createOpenAIConversationTextModel } from "./openai-conversation-text-model";

describe("OpenAI Conversation Text adapter", () => {
  it("streams typed Responses events without storing Provider conversation state", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const model = createOpenAIConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const body = [
          'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"I hear you."}\r\n\r\n',
          'event: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp_synthetic","model":"gpt-5.4-2026-07-01","usage":{"input_tokens":12,"output_tokens":4}}}\r\n\r\n',
        ].join("");
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "request_synthetic",
          },
          status: 200,
        });
      },
    });

    const events = [];
    for await (const event of model.stream({
      instructions: "Synthetic instructions",
      messages: [
        {
          revisionId: asConversationEventRevisionId(
            "01984477-59a9-7d20-9d97-e588769566a0",
          ),
          role: "user",
          text: "Synthetic input",
        },
      ],
      model: "gpt-5.4",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { delta: "I hear you.", type: "delta" },
      {
        costMicros: null,
        finishReason: "completed",
        inputTokens: 12,
        modelSnapshot: "gpt-5.4-2026-07-01",
        outputTokens: 4,
        providerRequestId: "request_synthetic",
        type: "completed",
      },
    ]);
    expect(requestBody).toMatchObject({
      model: "gpt-5.4",
      store: false,
      stream: true,
    });
    expect(requestBody).not.toHaveProperty("previous_response_id");
  });

  it("ends a stalled provider request at the server-owned deadline", async () => {
    const model = createOpenAIConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("deadline", "AbortError")),
            { once: true },
          );
        }),
      timeoutMs: 5,
    });

    await expect(async () => {
      for await (const _event of model.stream({
        instructions: "Synthetic instructions",
        messages: [
          {
            revisionId: asConversationEventRevisionId(
              "01984477-59a9-7d20-9d97-e588769566a0",
            ),
            role: "user",
            text: "Synthetic input",
          },
        ],
        model: "gpt-5.4",
      })) {
        // A stalled request must not yield.
      }
    }).rejects.toMatchObject({
      category: "timeout",
    });
  });
});
