import { afterEach, describe, expect, it, vi } from "vitest";

import {
  asConversationEventRevisionId,
} from "@sayhear/application";

import { createResponsesApiConversationTextModel } from "./responses-api-conversation-text-model";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

describe("Responses API Conversation Text adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams typed Responses events without storing Provider conversation state", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const model = createResponsesApiConversationTextModel({
      apiKey: "synthetic-server-key",
      baseUrl: OPENAI_BASE_URL,
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
      locale: "en-US",
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

  it("routes a DeepSeek configuration to the DeepSeek Responses API endpoint", async () => {
    let requestUrl: string | undefined;
    const model = createResponsesApiConversationTextModel({
      apiKey: "synthetic-deepseek-key",
      baseUrl: DEEPSEEK_BASE_URL,
      fetchImplementation: async (url) => {
        requestUrl = String(url);
        const body = [
          'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"我听到你了。"}\r\n\r\n',
          'event: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp_deepseek","model":"deepseek-v4-flash","usage":{"input_tokens":9,"output_tokens":5}}}\r\n\r\n',
        ].join("");
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "request_deepseek",
          },
          status: 200,
        });
      },
    });

    const events = [];
    for await (const event of model.stream({
      instructions: "Synthetic instructions",
      locale: "zh-CN",
      messages: [
        {
          revisionId: asConversationEventRevisionId(
            "01984477-59a9-7d20-9d97-e588769566a0",
          ),
          role: "user",
          text: "今天好累",
        },
      ],
      model: "deepseek-v4-flash",
    })) {
      events.push(event);
    }

    expect(requestUrl).toBe(`${DEEPSEEK_BASE_URL}/responses`);
    expect(events).toEqual([
      { delta: "我听到你了。", type: "delta" },
      {
        costMicros: null,
        finishReason: "completed",
        inputTokens: 9,
        modelSnapshot: "deepseek-v4-flash",
        outputTokens: 5,
        providerRequestId: "request_deepseek",
        type: "completed",
      },
    ]);
  });

  it("ends a stalled provider request at the server-owned deadline", async () => {
    const model = createResponsesApiConversationTextModel({
      apiKey: "synthetic-server-key",
      baseUrl: OPENAI_BASE_URL,
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
        locale: "en-US",
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

  it("classifies Provider authentication, configuration, and gateway failures as terminal and carries the HTTP status", async () => {
    for (const [status, category] of [
      [401, "authentication"],
      [400, "configuration"],
      [504, "timeout"],
      [500, "unavailable"],
    ] as const) {
      const model = createResponsesApiConversationTextModel({
        apiKey: "synthetic-server-key",
        baseUrl: OPENAI_BASE_URL,
        fetchImplementation: async () => new Response(null, { status }),
      });

      let caught: unknown;
      try {
        for await (const _event of model.stream({
          instructions: "Synthetic instructions",
          locale: "en-US",
          messages: [],
          model: "gpt-5.4",
        })) {
          // Terminal Provider failures must not yield.
        }
      } catch (error) {
        caught = error;
      }

      // The concrete status must survive into the message so an incident log
      // can tell a gateway 504 from a rate-limit 429 (incident 2026-08-18).
      expect(caught).toMatchObject({ category });
      expect(String(caught)).toContain(`HTTP ${status}`);
    }
  });

  it("does not expose Provider credentials or raw error bodies", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = createResponsesApiConversationTextModel({
      apiKey: "PROVIDER_CREDENTIAL_CANARY",
      baseUrl: OPENAI_BASE_URL,
      fetchImplementation: async () =>
        new Response("RAW_PROVIDER_ERROR_PRIVATE_CANARY", { status: 500 }),
    });

    let caught: unknown;
    try {
      for await (const _event of model.stream({
        instructions: "Synthetic instructions",
        locale: "en-US",
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
