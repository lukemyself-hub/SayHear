import { afterEach, describe, expect, it, vi } from "vitest";

import {
  asConversationEventRevisionId,
} from "@sayhear/application";

import { createOpenAIConversationTextModel } from "./openai-conversation-text-model";

describe("OpenAI Conversation Text adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("classifies Provider authentication and configuration failures as terminal", async () => {
    for (const [status, category] of [
      [401, "authentication"],
      [400, "configuration"],
    ] as const) {
      const model = createOpenAIConversationTextModel({
        apiKey: "synthetic-server-key",
        fetchImplementation: async () => new Response(null, { status }),
      });

      await expect(async () => {
        for await (const _event of model.stream({
          instructions: "Synthetic instructions",
          messages: [],
          model: "gpt-5.4",
        })) {
          // Terminal Provider failures must not yield.
        }
      }).rejects.toMatchObject({ category });
    }
  });

  it("does not expose Provider credentials or raw error bodies", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = createOpenAIConversationTextModel({
      apiKey: "PROVIDER_CREDENTIAL_CANARY",
      fetchImplementation: async () =>
        new Response("RAW_PROVIDER_ERROR_PRIVATE_CANARY", { status: 500 }),
    });

    let caught: unknown;
    try {
      for await (const _event of model.stream({
        instructions: "Synthetic instructions",
        messages: [
          {
            revisionId: asConversationEventRevisionId(
              "01984477-59a9-7d20-9d97-e588769566a0",
            ),
            role: "user",
            text: "PRIVATE_REQUEST_CANARY",
          },
        ],
        model: "gpt-5.4",
      })) {
        // A failed Provider response must not yield.
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ category: "unavailable" });
    expect(String(caught)).not.toMatch(
      /PROVIDER_CREDENTIAL_CANARY|RAW_PROVIDER_ERROR_PRIVATE_CANARY|PRIVATE_REQUEST_CANARY/,
    );
    expect(JSON.stringify([errorLog.mock.calls, warnLog.mock.calls])).not.toMatch(
      /PROVIDER_CREDENTIAL_CANARY|RAW_PROVIDER_ERROR_PRIVATE_CANARY|PRIVATE_REQUEST_CANARY/,
    );
  });
});
