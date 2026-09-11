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
      parameters: {
        input: "must be replaced",
        maxOutputTokens: 900,
        model: "must be replaced",
        store: true,
        temperature: 0.2,
        tools: "must be replaced",
      },
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
      temperature: 0.2,
      max_output_tokens: 900,
    });
    expect(requestBody).not.toHaveProperty("maxOutputTokens");
    expect(requestBody?.input).toEqual([
      { content: "Synthetic input", role: "user" },
    ]);
    expect(requestBody).not.toHaveProperty("tools", "must be replaced");
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

  it("serializes function tools in the flat Responses API shape", async () => {
    // The Responses API carries name/description/parameters directly on the
    // tool object; the nested chat-completions `function` wrapper is rejected
    // with HTTP 400 (observed against DeepSeek during the #79 evidence run,
    // where every decision turn attaches the stop-signal proposal function).
    let requestBody: Record<string, unknown> | undefined;
    const model = createResponsesApiConversationTextModel({
      apiKey: "synthetic-server-key",
      baseUrl: OPENAI_BASE_URL,
      fetchImplementation: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const body = [
          'event: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp_tools","model":"gpt-5.4","usage":{"input_tokens":5,"output_tokens":1}}}\r\n\r\n',
        ].join("");
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        });
      },
    });
    for await (const event of model.stream({
      functions: [
        {
          description: "Propose a curiosity stop signal.",
          name: "propose_curiosity_stop_signal",
          parameters: {
            additionalProperties: false,
            properties: {},
            type: "object",
          },
          strict: true,
        },
      ],
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
      void event;
    }
    expect(requestBody?.tools).toEqual([
      {
        description: "Propose a curiosity stop signal.",
        name: "propose_curiosity_stop_signal",
        parameters: {
          additionalProperties: false,
          properties: {},
          type: "object",
        },
        strict: true,
        type: "function",
      },
    ]);
    expect(
      (requestBody?.tools as readonly Record<string, unknown>[])[0],
    ).not.toHaveProperty("function");
  });

  it("continues once after a call-only response for a visibleReplyRequired function and yields the reply before the call", async () => {
    // DeepSeek's reasoning champion sometimes answers a stop-signal turn with
    // the function call alone (the message stays inside reasoning). The
    // adapter must finish the tool loop with a function_call_output round
    // trip, stream that reply, and only then surface the buffered call, so
    // the decision always carries user-visible text (issue #79 evidence run).
    const requestBodies: Record<string, unknown>[] = [];
    let call = 0;
    const model = createResponsesApiConversationTextModel({
      apiKey: "synthetic-server-key",
      baseUrl: OPENAI_BASE_URL,
      fetchImplementation: async (_url, init) => {
        call += 1;
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const first = call === 1;
        const body = first
          ? [
              'event: response.output_item.added\r\ndata: {"type":"response.output_item.added","item":{"type":"function_call","name":"curiosity_stop_signal","arguments":"","call_id":"call_synthetic_1"}}\r\n\r\n',
              'event: response.function_call_arguments.done\r\ndata: {"type":"response.function_call_arguments.done","arguments":"{\\"proposals\\":[]}"}\r\n\r\n',
              'event: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp_one","model":"deepseek-v4-flash","usage":{"input_tokens":10,"output_tokens":6}}}\r\n\r\n',
            ].join("")
          : [
              'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"好，那就不多问了。"}\r\n\r\n',
              'event: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp_two","model":"deepseek-v4-flash","usage":{"input_tokens":30,"output_tokens":4}}}\r\n\r\n',
            ].join("");
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": first ? "request_one" : "request_two",
          },
          status: 200,
        });
      },
    });

    const events = [];
    for await (const event of model.stream({
      functions: [
        {
          description: "Propose a stop signal.",
          name: "curiosity_stop_signal",
          parameters: { additionalProperties: false, properties: {}, type: "object" },
          strict: true,
          visibleReplyRequired: true,
        },
      ],
      instructions: "Synthetic instructions",
      locale: "zh-CN",
      messages: [
        {
          revisionId: asConversationEventRevisionId(
            "01984477-59a9-7d20-9d97-e588769566a0",
          ),
          role: "user",
          text: "不想聊这个了。",
        },
      ],
      model: "deepseek-v4-flash",
    })) {
      events.push(event);
    }

    // The continuation request carries the call + its output, and no tools.
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).not.toHaveProperty("tools");
    expect(requestBodies[1]?.input).toEqual([
      { content: "不想聊这个了。", role: "user" },
      {
        arguments: '{"proposals":[]}',
        call_id: "call_synthetic_1",
        name: "curiosity_stop_signal",
        type: "function_call",
      },
      { call_id: "call_synthetic_1", output: "recorded", type: "function_call_output" },
    ]);

    // Reply text precedes the buffered call; usage is merged across both
    // round trips into the single completed event of the logical generation.
    expect(events).toEqual([
      { delta: "好，那就不多问了。", type: "delta" },
      {
        rawArguments: '{"proposals":[]}',
        rawFunctionName: "curiosity_stop_signal",
        type: "tool_call",
      },
      {
        costMicros: null,
        finishReason: "completed",
        inputTokens: 40,
        modelSnapshot: "deepseek-v4-flash",
        outputTokens: 10,
        providerRequestId: "request_two",
        type: "completed",
      },
    ]);
  });

  it("yields a call-only response unchanged when the function does not require a visible reply", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    let call = 0;
    const model = createResponsesApiConversationTextModel({
      apiKey: "synthetic-server-key",
      baseUrl: OPENAI_BASE_URL,
      fetchImplementation: async (_url, init) => {
        call += 1;
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const body = [
          'event: response.output_item.done\r\ndata: {"type":"response.output_item.done","item":{"type":"function_call","name":"regenerate_journal","arguments":"{}"}}\r\n\r\n',
          'event: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp_action","model":"gpt-5.4","usage":{"input_tokens":8,"output_tokens":2}}}\r\n\r\n',
        ].join("");
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        });
      },
    });

    const events = [];
    for await (const event of model.stream({
      functions: [
        {
          description: "Regenerate the journal.",
          name: "regenerate_journal",
          parameters: { additionalProperties: false, properties: {}, type: "object" },
          strict: true,
        },
      ],
      instructions: "Synthetic instructions",
      locale: "en-US",
      messages: [
        {
          revisionId: asConversationEventRevisionId(
            "01984477-59a9-7d20-9d97-e588769566a0",
          ),
          role: "user",
          text: "Regenerate it.",
        },
      ],
      model: "gpt-5.4",
    })) {
      events.push(event);
    }

    expect(call).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["tool_call", "completed"]);
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
