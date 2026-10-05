import { afterEach, describe, expect, it, vi } from "vitest";

import {
  asConversationEventRevisionId,
  type ConversationTextModel,
  type ConversationTextModelRequest,
  type ConversationTextModelStreamEvent,
  type ModelRoleCallUsage,
} from "@sayhear/application";

import { createOpenCodeGoConversationTextModel } from "./opencode-go-conversation-text-model";

const ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";
const MODEL = "deepseek-v4.1-flash";
const REVISION = asConversationEventRevisionId(
  "01984477-59a9-7d20-9d97-e588769566a0",
);

const VISIBLE_FUNCTION = {
  description: "Propose a stop signal.",
  name: "curiosity_stop_signal",
  parameters: { additionalProperties: false, properties: {}, type: "object" },
  strict: true as const,
  visibleReplyRequired: true as const,
};

const DONE = Symbol("sse-done");

/** Frame a sequence of Chat Completions SSE events with CRLF terminators. */
function sse(...events: (unknown | typeof DONE)[]): string {
  return events
    .map((event) =>
      event === DONE
        ? "data: [DONE]\r\n\r\n"
        : `data: ${JSON.stringify(event)}\r\n\r\n`,
    )
    .join("");
}

function chunk(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}

function okResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: { "content-type": "text/event-stream", ...headers },
    status: 200,
  });
}

function baseRequest(
  overrides: Partial<ConversationTextModelRequest> = {},
): ConversationTextModelRequest {
  return {
    instructions: "Synthetic instructions",
    locale: "en-US",
    messages: [
      { revisionId: REVISION, role: "user", text: "Synthetic input" },
    ],
    model: MODEL,
    providerSessionId: "session-opaque-1",
    ...overrides,
  };
}

function requestWithoutSession(): ConversationTextModelRequest {
  const { providerSessionId: _providerSessionId, ...rest } = baseRequest();
  void _providerSessionId;
  return rest;
}

async function collect(
  model: ConversationTextModel,
  request: ConversationTextModelRequest,
): Promise<ConversationTextModelStreamEvent[]> {
  const events: ConversationTextModelStreamEvent[] = [];
  for await (const event of model.stream(request)) {
    events.push(event);
  }
  return events;
}

async function catchError(
  run: () => Promise<unknown>,
): Promise<Record<string, unknown>> {
  try {
    await run();
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error("expected the model stream to fail");
}

async function collectUntilFailure(
  model: ConversationTextModel,
  request: ConversationTextModelRequest,
): Promise<{
  error: Record<string, unknown>;
  events: ConversationTextModelStreamEvent[];
}> {
  const events: ConversationTextModelStreamEvent[] = [];
  try {
    for await (const event of model.stream(request)) {
      events.push(event);
    }
  } catch (error) {
    return { error: error as Record<string, unknown>, events };
  }
  throw new Error("expected the model stream to fail");
}

function capturedBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("OpenCode Go Chat Completions Conversation Text adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("translates the frozen request to the exact Chat Completions wire shape", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async (url, init) => {
        capturedUrl = String(url);
        capturedInit = init;
        return okResponse(
          sse(
            {
              choices: [
                { delta: { content: "Hi", role: "assistant" }, finish_reason: null, index: 0 },
              ],
              id: "chatcmpl-1",
              model: MODEL,
              object: "chat.completion.chunk",
            },
            {
              choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
              id: "chatcmpl-1",
              model: MODEL,
            },
            {
              choices: [],
              id: "chatcmpl-1",
              model: MODEL,
              usage: {
                completion_tokens: 17,
                completion_tokens_details: { reasoning_tokens: 11 },
                prompt_tokens: 56,
                prompt_tokens_details: { cached_tokens: 0 },
                total_tokens: 73,
              },
            },
            DONE,
          ),
          { "x-request-id": "request-1" },
        );
      },
    });

    const events = await collect(
      model,
      baseRequest({
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
        instructions: "System text",
        messages: [
          { revisionId: REVISION, role: "user", text: "u1" },
          { revisionId: REVISION, role: "assistant", text: "a1" },
          { revisionId: REVISION, role: "user", text: "u2" },
        ],
        parameters: {
          maxOutputTokens: 4000,
          reasoning: { effort: "low" },
          temperature: 0.2,
        },
      }),
    );

    expect(capturedUrl).toBe(ENDPOINT);
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.redirect).toBe("error");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer synthetic-server-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("user-agent")).toBe("SayHear/1.0");
    expect(headers.get("x-opencode-session")).toBe("session-opaque-1");

    expect(capturedBody(capturedInit)).toEqual({
      max_tokens: 4000,
      messages: [
        { content: "System text", role: "system" },
        { content: "u1", role: "user" },
        { content: "a1", reasoning_content: "", role: "assistant" },
        { content: "u2", role: "user" },
      ],
      model: MODEL,
      reasoning_effort: "low",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      thinking: { type: "enabled" },
      tool_choice: "auto",
      tools: [
        {
          function: {
            description: "Propose a curiosity stop signal.",
            name: "propose_curiosity_stop_signal",
            parameters: {
              additionalProperties: false,
              properties: {},
              type: "object",
            },
            strict: true,
          },
          type: "function",
        },
      ],
    });

    expect(events).toEqual([
      { delta: "Hi", type: "delta" },
      {
        cachedTokens: 0,
        costMicros: null,
        finishReason: "completed",
        inputTokens: 56,
        modelSnapshot: MODEL,
        outputTokens: 17,
        providerRequestId: "request-1",
        reasoningTokens: 11,
        totalTokens: 73,
        type: "completed",
      },
    ]);
  });

  it("translates each documented reasoning effort without changing it", async () => {
    for (const effort of ["low", "high", "max"] as const) {
      let body: Record<string, unknown> | undefined;
      const model = createOpenCodeGoConversationTextModel({
        apiKey: "synthetic-server-key",
        fetchImplementation: async (_url, init) => {
          body = capturedBody(init);
          return okResponse(
            sse(
              {
                choices: [{ delta: { content: "ok" }, finish_reason: null, index: 0 }],
                model: MODEL,
              },
              { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: MODEL },
              DONE,
            ),
          );
        },
      });
      await collect(
        model,
        baseRequest({ parameters: { reasoning: { effort } } }),
      );
      expect(body).toMatchObject({
        reasoning_effort: effort,
        thinking: { type: "enabled" },
      });
    }
  });

  it("omits tools and tool_choice when tools are disabled or none are offered", async () => {
    const bodies: Record<string, unknown>[] = [];
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async (_url, init) => {
        bodies.push(capturedBody(init));
        return okResponse(
          sse(
            {
              choices: [{ delta: { content: "ok" }, finish_reason: null, index: 0 }],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: MODEL },
            DONE,
          ),
        );
      },
    });

    const functions = [
      {
        description: "A function.",
        name: "some_function",
        parameters: { additionalProperties: false, properties: {}, type: "object" },
        strict: true as const,
      },
    ];
    await collect(model, baseRequest({ functions }));
    await collect(model, baseRequest({ functions, toolsDisabled: true }));
    await collect(model, baseRequest({ toolsDisabled: false }));

    expect(bodies[0]).toHaveProperty("tools");
    expect(bodies[1]).not.toHaveProperty("tools");
    expect(bodies[1]).not.toHaveProperty("tool_choice");
    expect(bodies[2]).not.toHaveProperty("tools");
    expect(bodies[2]).not.toHaveProperty("tool_choice");
  });

  it("fails a tool call that arrives when no tools were offered", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: { arguments: "{}", name: "unoffered" },
                        id: "call_1",
                        index: 0,
                        type: "function",
                      },
                    ],
                  },
                  finish_reason: null,
                  index: 0,
                },
              ],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }], model: MODEL },
            DONE,
          ),
        ),
    });

    const error = await catchError(() =>
      collect(model, baseRequest({ toolsDisabled: true })),
    );
    expect(error).toMatchObject({ category: "invalid_response" });
  });

  it("assembles streamed tool-call fragments by index and never emits partial calls", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: {
                          arguments: '{"pro',
                          name: "propose_curiosity_stop_signal",
                        },
                        id: "call_1",
                        index: 0,
                        type: "function",
                      },
                    ],
                  },
                  finish_reason: null,
                  index: 0,
                },
              ],
              model: MODEL,
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { function: { arguments: 'posals":[]}' }, index: 0 },
                    ],
                  },
                  finish_reason: null,
                  index: 0,
                },
              ],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }], model: MODEL },
            {
              choices: [],
              model: MODEL,
              usage: { completion_tokens: 3, prompt_tokens: 4, total_tokens: 7 },
            },
            DONE,
          ),
        ),
    });

    const events = await collect(
      model,
      baseRequest({
        functions: [
          {
            description: "Propose a stop signal.",
            name: "propose_curiosity_stop_signal",
            parameters: { additionalProperties: false, properties: {}, type: "object" },
            strict: true,
          },
        ],
      }),
    );

    expect(events).toEqual([
      {
        rawArguments: '{"proposals":[]}',
        rawFunctionName: "propose_curiosity_stop_signal",
        type: "tool_call",
      },
      {
        costMicros: null,
        finishReason: "completed",
        inputTokens: 4,
        modelSnapshot: MODEL,
        outputTokens: 3,
        providerRequestId: null,
        reasoningTokens: null,
        totalTokens: 7,
        type: "completed",
      },
    ]);
  });

  it("rejects a fragment that reassigns a tool call identity", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: { arguments: "", name: "a" },
                        id: "call_1",
                        index: 0,
                      },
                    ],
                  },
                  index: 0,
                },
              ],
              model: MODEL,
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ id: "call_2", index: 0 }],
                  },
                  index: 0,
                },
              ],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }], model: MODEL },
            DONE,
          ),
        ),
    });

    const error = await catchError(() =>
      collect(
        model,
        baseRequest({
          functions: [
            {
              description: "A function.",
              name: "a",
              parameters: { additionalProperties: false, properties: {}, type: "object" },
              strict: true,
            },
          ],
        }),
      ),
    );
    expect(error).toMatchObject({ category: "invalid_response" });
  });

  it("keeps unknown or invalid usage as null and never invents a zero or total", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [{ delta: { content: "ok" }, finish_reason: null, index: 0 }],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: MODEL },
            {
              choices: [],
              model: MODEL,
              usage: {
                completion_tokens: 1.5,
                completion_tokens_details: { reasoning_tokens: -5 },
                prompt_tokens: -1,
                prompt_tokens_details: { cached_tokens: null },
                total_tokens: "not-a-number",
              },
            },
            DONE,
          ),
        ),
    });

    const events = await collect(model, baseRequest());
    expect(events).toEqual([
      { delta: "ok", type: "delta" },
      {
        costMicros: null,
        finishReason: "completed",
        inputTokens: null,
        modelSnapshot: MODEL,
        outputTokens: null,
        providerRequestId: null,
        reasoningTokens: null,
        type: "completed",
      },
    ]);
  });

  it("reports a length-truncated response as a content-free output-budget failure", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [
                { delta: { content: '{"propositions":' }, finish_reason: null, index: 0 },
              ],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "length", index: 0 }], model: MODEL },
            {
              choices: [],
              model: MODEL,
              usage: {
                completion_tokens: 4000,
                completion_tokens_details: { reasoning_tokens: 3600 },
                prompt_tokens: 940,
                total_tokens: 4940,
              },
            },
            DONE,
          ),
        ),
    });

    const error = await catchError(() =>
      collect(
        model,
        baseRequest({
          messages: [
            { revisionId: REVISION, role: "user", text: "PRIVATE_DRAFT_CANARY" },
          ],
        }),
      ),
    );
    expect(error).toMatchObject({
      category: "invalid_response",
      failure: {
        inputTokens: 940,
        kind: "output_budget_exhausted",
        outputLength: 16,
        outputTokens: 4000,
        providerReason: "length",
        reasoningTokens: 3600,
        totalTokens: 4940,
      },
    });
    expect(String(error)).not.toMatch(/PRIVATE_DRAFT_CANARY/);
  });

  it("fails EOF without the [DONE] sentinel", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [{ delta: { content: "ok" }, finish_reason: null, index: 0 }],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: MODEL },
          ),
        ),
    });

    const error = await catchError(() => collect(model, baseRequest()));
    expect(error).toMatchObject({ category: "invalid_response" });
  });

  it("fails malformed JSON in the stream", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse("data: {not json}\r\n\r\n" + "data: [DONE]\r\n\r\n"),
    });

    const error = await catchError(() => collect(model, baseRequest()));
    expect(error).toMatchObject({ category: "invalid_response" });
  });

  it("rejects a reasoning-only response that produced no visible text", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [
                {
                  delta: { reasoning_content: "internal thinking" },
                  finish_reason: null,
                  index: 0,
                },
              ],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: MODEL },
            DONE,
          ),
        ),
    });

    const error = await catchError(() => collect(model, baseRequest()));
    expect(error).toMatchObject({ category: "invalid_response" });
  });

  it("discards reasoning_content and emits only visible content", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [
                {
                  delta: { reasoning_content: "hidden" },
                  finish_reason: null,
                  index: 0,
                },
              ],
              model: MODEL,
            },
            {
              choices: [{ delta: { content: "visible" }, finish_reason: null, index: 0 }],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: MODEL },
            DONE,
          ),
        ),
    });

    const events = await collect(model, baseRequest());
    expect(events[0]).toEqual({ delta: "visible", type: "delta" });
    expect(JSON.stringify(events)).not.toMatch(/hidden/);
  });

  it("rejects a first response whose returned model is not the pinned model", async () => {
    for (const returnedModel of [
      "deepseek-v4-flash",
      "gpt-5.4",
      "deepseek-v4.1-flash@2026-09-12",
    ]) {
      const model = createOpenCodeGoConversationTextModel({
        apiKey: "synthetic-server-key",
        fetchImplementation: async () =>
          okResponse(
            sse(
              {
                choices: [
                  { delta: { content: "ok" }, finish_reason: null, index: 0 },
                ],
                model: returnedModel,
              },
              {
                choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
                model: returnedModel,
              },
              DONE,
            ),
          ),
      });

      const { error } = await collectUntilFailure(model, baseRequest());
      expect(error, returnedModel).toMatchObject({
        category: "invalid_response",
      });
    }
  });

  it("reports usage once when a wrong model shares the chunk with valid usage", async () => {
    const usage = {
      completion_tokens: 5,
      completion_tokens_details: { reasoning_tokens: 3 },
      prompt_tokens: 11,
      prompt_tokens_details: { cached_tokens: 2 },
      total_tokens: 16,
    };
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [
                { delta: { content: "provisional" }, finish_reason: null, index: 0 },
              ],
              model: "gpt-5.4",
              usage,
            },
            DONE,
          ),
        ),
    });
    const seen: unknown[] = [];
    const { error, events } = await collectUntilFailure(
      model,
      baseRequest({ onUsage: (reported) => seen.push(reported) }),
    );
    expect(error).toMatchObject({ category: "invalid_response" });
    expect(events).toEqual([]);
    expect(seen).toEqual([
      {
        cachedTokens: 2,
        inputTokens: 11,
        outputTokens: 5,
        reasoningTokens: 3,
        totalTokens: 16,
      },
    ]);
  });

  it("reports usage once when a streamed error shares the chunk with valid usage", async () => {
    const usage = { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 };
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(sse({ error: { message: "boom" }, usage }, DONE)),
    });
    const seen: unknown[] = [];
    const { error, events } = await collectUntilFailure(
      model,
      baseRequest({ onUsage: (reported) => seen.push(reported) }),
    );
    expect(error).toMatchObject({ category: "invalid_response" });
    expect(events).toEqual([]);
    expect(seen).toEqual([
      {
        cachedTokens: null,
        inputTokens: 7,
        outputTokens: 2,
        reasoningTokens: null,
        totalTokens: 9,
      },
    ]);
  });

  it("reports usage once when invalid choices share the chunk with valid usage", async () => {
    const usage = { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 };
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [
                { delta: { content: "a" }, finish_reason: null, index: 0 },
                { delta: { content: "b" }, finish_reason: null, index: 1 },
              ],
              model: MODEL,
              usage,
            },
            DONE,
          ),
        ),
    });
    const seen: unknown[] = [];
    const { error, events } = await collectUntilFailure(
      model,
      baseRequest({ onUsage: (reported) => seen.push(reported) }),
    );
    expect(error).toMatchObject({ category: "invalid_response" });
    expect(events).toEqual([]);
    expect(seen).toEqual([
      {
        cachedTokens: null,
        inputTokens: 4,
        outputTokens: 1,
        reasoningTokens: null,
        totalTokens: 5,
      },
    ]);
  });

  it("rejects a wrong returned model on the continuation call", async () => {
    let call = 0;
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () => {
        call += 1;
        if (call === 1) {
          return okResponse(
            sse(
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          function: { arguments: "{}", name: "curiosity_stop_signal" },
                          id: "call_1",
                          index: 0,
                        },
                      ],
                    },
                    finish_reason: null,
                    index: 0,
                  },
                ],
                model: MODEL,
              },
              {
                choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
                model: MODEL,
              },
              DONE,
            ),
          );
        }
        return okResponse(
          sse(
            {
              choices: [
                { delta: { content: "reply" }, finish_reason: null, index: 0 },
              ],
              model: "deepseek-v4-flash",
            },
            {
              choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
              model: "deepseek-v4-flash",
            },
            DONE,
          ),
        );
      },
    });

    const { error } = await collectUntilFailure(
      model,
      baseRequest({ functions: [VISIBLE_FUNCTION] }),
    );
    expect(call).toBe(2);
    expect(error).toMatchObject({ category: "invalid_response" });
  });

  it("rejects conflicting model identities inside one stream", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [{ delta: { content: "a" }, finish_reason: null, index: 0 }],
              model: "deepseek-v4.1-flash",
            },
            {
              choices: [{ delta: { content: "b" }, finish_reason: null, index: 0 }],
              model: "deepseek-v4-flash",
            },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: "deepseek-v4.1-flash" },
            DONE,
          ),
        ),
    });

    const error = await catchError(() => collect(model, baseRequest()));
    expect(error).toMatchObject({ category: "invalid_response" });
  });

  it("rejects multiple choices or a non-zero choice index", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [
                { delta: { content: "a" }, finish_reason: null, index: 0 },
                { delta: { content: "b" }, finish_reason: null, index: 1 },
              ],
              model: MODEL,
            },
            DONE,
          ),
        ),
    });

    const error = await catchError(() => collect(model, baseRequest()));
    expect(error).toMatchObject({ category: "invalid_response" });
  });

  it("rejects a safety finish reason instead of reporting success", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [{ delta: { content: "partial" }, finish_reason: null, index: 0 }],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "content_filter", index: 0 }], model: MODEL },
            DONE,
          ),
        ),
    });

    const error = await catchError(() => collect(model, baseRequest()));
    expect(error).toMatchObject({ category: "invalid_response" });
  });

  it("rejects an attempt to override a protected or Responses-only parameter", async () => {
    for (const parameters of [
      { model: "other" },
      { stream: false },
      { stream_options: { include_usage: false } },
      { tools: [] },
      { tool_choice: "none" },
      { messages: [] },
      { instructions: "override" },
      { store: true },
      { input: "override" },
      { max_output_tokens: 10 },
      { maxOutputTokens: 10, max_tokens: 20 },
      { reasoning: { effort: "low" }, reasoning_effort: "high" },
      { reasoning: { effort: "medium" } },
    ] as const) {
      const model = createOpenCodeGoConversationTextModel({
        apiKey: "synthetic-server-key",
        fetchImplementation: async () => {
          throw new Error("fetch must not be called");
        },
      });
      const error = await catchError(() =>
        collect(model, baseRequest({ parameters })),
      );
      expect(error).toMatchObject({ category: "configuration" });
    }
  });

  it("rejects a request for any model but the pinned Go model", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () => {
        throw new Error("fetch must not be called");
      },
    });

    const error = await catchError(() =>
      collect(model, baseRequest({ model: "deepseek-v4-flash" })),
    );
    expect(error).toMatchObject({ category: "configuration" });
  });

  it("requires an explicit bounded header-safe providerSessionId", async () => {
    for (const providerSessionId of [
      undefined,
      "",
      "with\r\nnewline",
      "with space",
      "é",
      "x".repeat(201),
    ]) {
      const model = createOpenCodeGoConversationTextModel({
        apiKey: "synthetic-server-key",
        fetchImplementation: async () => {
          throw new Error("fetch must not be called");
        },
      });
      const request =
        providerSessionId === undefined
          ? requestWithoutSession()
          : baseRequest({ providerSessionId });
      const error = await catchError(() => collect(model, request));
      expect(error).toMatchObject({ category: "configuration" });
    }
  });

  it("classifies HTTP authentication, configuration, rate-limit, and gateway failures", async () => {
    for (const [status, category] of [
      [401, "authentication"],
      [403, "authentication"],
      [400, "configuration"],
      [429, "rate_limited"],
      [500, "unavailable"],
      [504, "timeout"],
    ] as const) {
      const model = createOpenCodeGoConversationTextModel({
        apiKey: "synthetic-server-key",
        fetchImplementation: async () => new Response(null, { status }),
      });
      const error = await catchError(() => collect(model, baseRequest()));
      expect(error).toMatchObject({ category });
      expect(String(error)).toContain(`HTTP ${status}`);
    }
  });

  it("sanitizes a streamed error payload without echoing it", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "PROVIDER_CREDENTIAL_CANARY",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              error: {
                message: "RAW_PROVIDER_ERROR_PRIVATE_CANARY",
                type: "invalid_request_error",
              },
            },
            DONE,
          ),
        ),
    });

    const error = await catchError(() =>
      collect(
        model,
        baseRequest({
          messages: [
            { revisionId: REVISION, role: "user", text: "PRIVATE_REQUEST_CANARY" },
          ],
        }),
      ),
    );
    expect(error).toMatchObject({ category: "invalid_response" });
    expect(String(error)).not.toMatch(
      /PROVIDER_CREDENTIAL_CANARY|RAW_PROVIDER_ERROR_PRIVATE_CANARY|PRIVATE_REQUEST_CANARY/,
    );
    expect(JSON.stringify([errorLog.mock.calls, warnLog.mock.calls])).not.toMatch(
      /PROVIDER_CREDENTIAL_CANARY|RAW_PROVIDER_ERROR_PRIVATE_CANARY|PRIVATE_REQUEST_CANARY/,
    );
  });

  it("does not echo an HTTP error body", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "PROVIDER_CREDENTIAL_CANARY",
      fetchImplementation: async () =>
        new Response("RAW_PROVIDER_ERROR_PRIVATE_CANARY", { status: 500 }),
    });

    const error = await catchError(() => collect(model, baseRequest()));
    expect(error).toMatchObject({ category: "unavailable" });
    expect(String(error)).not.toMatch(
      /PROVIDER_CREDENTIAL_CANARY|RAW_PROVIDER_ERROR_PRIVATE_CANARY/,
    );
  });

  it("frames split UTF-8, arbitrary chunks, multiline data, and a final event without a blank line", async () => {
    const encoder = new TextEncoder();
    const body = [
      chunk({
        choices: [{ delta: { content: "我听到你了。" }, finish_reason: null, index: 0 }],
        model: MODEL,
      }),
      // Multiline data field split across two `data:` lines.
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],\r\n',
      `data: "model":"${MODEL}"}\r\n\r\n`,
      // Final framing: [DONE] with no trailing blank line.
      "data: [DONE]",
    ].join("");
    const bytes = encoder.encode(body);
    // Split at boundaries that cut a multi-byte CJK sequence and the CRLF pair.
    const pieces: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += 7) {
      pieces.push(bytes.slice(offset, offset + 7));
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      },
    });

    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        }),
    });

    const events = await collect(model, baseRequest());
    expect(events[0]).toEqual({ delta: "我听到你了。", type: "delta" });
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });

  it("cancels and releases the reader when the consumer returns early", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            chunk({
              choices: [{ delta: { content: "first" }, finish_reason: null, index: 0 }],
              model: MODEL,
            }),
          ),
        );
        // The stream never closes; the consumer leaves after the first delta.
      },
      cancel() {
        cancelled = true;
      },
    });

    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        }),
    });

    for await (const event of model.stream(baseRequest())) {
      expect(event).toEqual({ delta: "first", type: "delta" });
      break;
    }
    expect(cancelled).toBe(true);
  });

  it("stops at a framed [DONE] without waiting for socket EOF and cancels the body", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = sse(
      {
        choices: [{ delta: { content: "hi" }, finish_reason: null, index: 0 }],
        model: MODEL,
      },
      { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: MODEL },
      {
        choices: [],
        model: MODEL,
        usage: { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 },
      },
      DONE,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        // The body never closes: the framed [DONE] must end the stream.
      },
      cancel() {
        cancelled = true;
      },
    });
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        }),
    });

    type RaceResult =
      | { events: ConversationTextModelStreamEvent[]; ok: true }
      | { ok: false };
    const result = await new Promise<RaceResult>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false }), 2000);
      collect(model, baseRequest()).then(
        (events) => {
          clearTimeout(timer);
          resolve({ events, ok: true });
        },
        () => {
          clearTimeout(timer);
          resolve({ ok: false });
        },
      );
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toEqual([
      { delta: "hi", type: "delta" },
      {
        costMicros: null,
        finishReason: "completed",
        inputTokens: 3,
        modelSnapshot: MODEL,
        outputTokens: 2,
        providerRequestId: null,
        reasoningTokens: null,
        totalTokens: 5,
        type: "completed",
      },
    ]);
    expect(cancelled).toBe(true);
  });

  it("reports observed usage exactly once when a reasoning-only terminal fails locally", async () => {
    const seen: ModelRoleCallUsage[] = [];
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [
                { delta: { reasoning_content: "hidden" }, finish_reason: null, index: 0 },
              ],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: MODEL },
            {
              choices: [],
              model: MODEL,
              usage: {
                completion_tokens: 9,
                completion_tokens_details: { reasoning_tokens: 4 },
                prompt_tokens: 7,
                total_tokens: 16,
              },
            },
            DONE,
          ),
        ),
    });

    const error = await catchError(() =>
      collect(model, baseRequest({ onUsage: (usage) => seen.push(usage) })),
    );
    expect(error).toMatchObject({ category: "invalid_response" });
    expect(seen).toEqual([
      {
        cachedTokens: null,
        inputTokens: 7,
        outputTokens: 9,
        reasoningTokens: 4,
        totalTokens: 16,
      },
    ]);
  });

  it("reports observed usage once when the stream ends without [DONE]", async () => {
    const seen: ModelRoleCallUsage[] = [];
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [{ delta: { content: "partial" }, finish_reason: null, index: 0 }],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: MODEL },
            {
              choices: [],
              model: MODEL,
              usage: { completion_tokens: 6, prompt_tokens: 4, total_tokens: 10 },
            },
          ),
        ),
    });

    const error = await catchError(() =>
      collect(model, baseRequest({ onUsage: (usage) => seen.push(usage) })),
    );
    expect(error).toMatchObject({ category: "invalid_response" });
    expect(seen).toEqual([
      {
        cachedTokens: null,
        inputTokens: 4,
        outputTokens: 6,
        reasoningTokens: null,
        totalTokens: 10,
      },
    ]);
  });

  it("reports observed usage once when a parser error follows it", async () => {
    const seen: ModelRoleCallUsage[] = [];
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          chunk({
            choices: [],
            model: MODEL,
            usage: { completion_tokens: 2, prompt_tokens: 8, total_tokens: 10 },
          }) + "data: {not json}\r\n\r\n",
        ),
    });

    const error = await catchError(() =>
      collect(model, baseRequest({ onUsage: (usage) => seen.push(usage) })),
    );
    expect(error).toMatchObject({ category: "invalid_response" });
    expect(seen).toEqual([
      {
        cachedTokens: null,
        inputTokens: 8,
        outputTokens: 2,
        reasoningTokens: null,
        totalTokens: 10,
      },
    ]);
  });

  it("reports normalized usage once on a normal completion, keeping unknown counts null", async () => {
    const seen: ModelRoleCallUsage[] = [];
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () =>
        okResponse(
          sse(
            {
              choices: [{ delta: { content: "ok" }, finish_reason: null, index: 0 }],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: MODEL },
            {
              choices: [],
              model: MODEL,
              usage: { prompt_tokens: 12, total_tokens: "not-a-number" },
            },
            DONE,
          ),
        ),
    });

    const events = await collect(
      model,
      baseRequest({ onUsage: (usage) => seen.push(usage) }),
    );
    expect(seen).toEqual([
      {
        cachedTokens: null,
        inputTokens: 12,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
      },
    ]);
    expect(events.at(-1)).toMatchObject({ inputTokens: 12, type: "completed" });
  });

  it("keeps concurrent per-call usage reports distinct", async () => {
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async (_url, init) => {
        const session = new Headers(init?.headers).get("x-opencode-session");
        const factor = session === "session-a" ? 1 : 2;
        return okResponse(
          sse(
            {
              choices: [
                { delta: { content: `c${factor}` }, finish_reason: null, index: 0 },
              ],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: MODEL },
            {
              choices: [],
              model: MODEL,
              usage: {
                completion_tokens: factor,
                prompt_tokens: factor * 10,
                total_tokens: factor * 11,
              },
            },
            DONE,
          ),
        );
      },
    });
    const first: ModelRoleCallUsage[] = [];
    const second: ModelRoleCallUsage[] = [];
    await Promise.all([
      collect(
        model,
        baseRequest({
          onUsage: (usage) => first.push(usage),
          providerSessionId: "session-a",
        }),
      ),
      collect(
        model,
        baseRequest({
          onUsage: (usage) => second.push(usage),
          providerSessionId: "session-b",
        }),
      ),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toMatchObject({ inputTokens: 10, outputTokens: 1, totalTokens: 11 });
    expect(second[0]).toMatchObject({ inputTokens: 20, outputTokens: 2, totalTokens: 22 });
  });

  it("makes one bounded continuation for a call-only visibleReplyRequired selection", async () => {
    const bodies: Record<string, unknown>[] = [];
    const sessions: (string | null)[] = [];
    const seen: ModelRoleCallUsage[] = [];
    let call = 0;
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async (_url, init) => {
        bodies.push(capturedBody(init));
        sessions.push(new Headers(init?.headers).get("x-opencode-session"));
        call += 1;
        if (call === 1) {
          return okResponse(
            sse(
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          function: {
                            arguments: '{"proposals":[]}',
                            name: "curiosity_stop_signal",
                          },
                          id: "call_1",
                          index: 0,
                          type: "function",
                        },
                      ],
                    },
                    finish_reason: null,
                    index: 0,
                  },
                ],
                model: MODEL,
              },
              {
                choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
                model: MODEL,
              },
              {
                choices: [],
                model: MODEL,
                usage: {
                  completion_tokens: 6,
                  prompt_tokens: 10,
                  total_tokens: 16,
                },
              },
              DONE,
            ),
          );
        }
        return okResponse(
          sse(
            {
              choices: [
                { delta: { content: "好，那就不多问了。" }, finish_reason: null, index: 0 },
              ],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: MODEL },
            {
              choices: [],
              model: MODEL,
              usage: {
                completion_tokens: 4,
                prompt_tokens: 30,
                total_tokens: 34,
              },
            },
            DONE,
          ),
        );
      },
    });

    const events = await collect(
      model,
      baseRequest({
        functions: [VISIBLE_FUNCTION],
        onUsage: (usage) => seen.push(usage),
        parameters: { maxOutputTokens: 4000 },
      }),
    );

    expect(bodies).toHaveLength(2);
    expect(sessions).toEqual(["session-opaque-1", "session-opaque-1"]);
    expect(bodies[0]).toHaveProperty("tools");
    expect(bodies[1]).not.toHaveProperty("tools");
    expect(bodies[1]).not.toHaveProperty("tool_choice");
    expect(bodies[1]).toMatchObject({ max_tokens: 4000 });
    expect(bodies[1]?.messages).toEqual([
      { content: "Synthetic instructions", role: "system" },
      { content: "Synthetic input", role: "user" },
      {
        content: null,
        reasoning_content: "",
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments: '{"proposals":[]}',
              name: "curiosity_stop_signal",
            },
            id: "call_1",
            type: "function",
          },
        ],
      },
      { content: "recorded", role: "tool", tool_call_id: "call_1" },
    ]);
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
        modelSnapshot: MODEL,
        outputTokens: 10,
        providerRequestId: null,
        reasoningTokens: null,
        totalTokens: 50,
        type: "completed",
      },
    ]);
    expect(seen).toEqual([
      {
        cachedTokens: null,
        inputTokens: 40,
        outputTokens: 10,
        reasoningTokens: null,
        totalTokens: 50,
      },
    ]);
  });

  it("fails closed and reports accounting when the continuation is truncated", async () => {
    const seen: ModelRoleCallUsage[] = [];
    let call = 0;
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () => {
        call += 1;
        if (call === 1) {
          return okResponse(
            sse(
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          function: { arguments: "{}", name: "curiosity_stop_signal" },
                          id: "call_1",
                          index: 0,
                        },
                      ],
                    },
                    finish_reason: null,
                    index: 0,
                  },
                ],
                model: MODEL,
              },
              {
                choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
                model: MODEL,
              },
              {
                choices: [],
                model: MODEL,
                usage: { completion_tokens: 6, prompt_tokens: 10, total_tokens: 16 },
              },
              DONE,
            ),
          );
        }
        return okResponse(
          sse(
            {
              choices: [{ delta: { content: "partial" }, finish_reason: null, index: 0 }],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "length", index: 0 }], model: MODEL },
            {
              choices: [],
              model: MODEL,
              usage: { completion_tokens: 4, prompt_tokens: 30, total_tokens: 34 },
            },
            DONE,
          ),
        );
      },
    });

    const { error, events } = await collectUntilFailure(
      model,
      baseRequest({
        functions: [VISIBLE_FUNCTION],
        onUsage: (usage) => seen.push(usage),
      }),
    );
    expect(events).toEqual([]);
    expect(error).toMatchObject({
      category: "invalid_response",
      failure: { kind: "output_budget_exhausted", providerReason: "length" },
    });
    expect(call).toBe(2);
    expect(seen).toEqual([
      {
        cachedTokens: null,
        inputTokens: 40,
        outputTokens: 10,
        reasoningTokens: null,
        totalTokens: 50,
      },
    ]);
  });

  it("skips the continuation when the first response already carried visible text", async () => {
    let call = 0;
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () => {
        call += 1;
        return okResponse(
          sse(
            {
              choices: [{ delta: { content: "visible first" }, finish_reason: null, index: 0 }],
              model: MODEL,
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: { arguments: "{}", name: "curiosity_stop_signal" },
                        id: "call_1",
                        index: 0,
                      },
                    ],
                  },
                  finish_reason: null,
                  index: 0,
                },
              ],
              model: MODEL,
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }], model: MODEL },
            DONE,
          ),
        );
      },
    });

    const events = await collect(
      model,
      baseRequest({ functions: [VISIBLE_FUNCTION] }),
    );
    expect(call).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "delta",
      "tool_call",
      "completed",
    ]);
  });

  it("rejects a continuation whose model identity differs from the first response", async () => {
    let call = 0;
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async () => {
        call += 1;
        if (call === 1) {
          return okResponse(
            sse(
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          function: { arguments: "{}", name: "curiosity_stop_signal" },
                          id: "call_1",
                          index: 0,
                        },
                      ],
                    },
                    finish_reason: null,
                    index: 0,
                  },
                ],
                model: MODEL,
              },
              { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }], model: MODEL },
              DONE,
            ),
          );
        }
        return okResponse(
          sse(
            {
              choices: [{ delta: { content: "reply" }, finish_reason: null, index: 0 }],
              model: "deepseek-v4-flash",
            },
            { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model: "deepseek-v4-flash" },
            DONE,
          ),
        );
      },
    });

    const { error, events } = await collectUntilFailure(
      model,
      baseRequest({ functions: [VISIBLE_FUNCTION] }),
    );
    expect(events).toEqual([]);
    expect(error).toMatchObject({ category: "invalid_response" });
  });

  it("ends a stalled provider request at the server-owned deadline", async () => {
    const model = createOpenCodeGoConversationTextModel({
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

    const error = await catchError(() => collect(model, baseRequest()));
    expect(error).toMatchObject({ category: "timeout" });
  });

  it("classifies a caller cancellation as aborted rather than a timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-server-key",
      fetchImplementation: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => reject(new DOMException("cancelled", "AbortError"));
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
        }),
      timeoutMs: 60_000,
    });

    const error = await catchError(() =>
      collect(model, baseRequest({ signal: controller.signal })),
    );
    expect(error).toMatchObject({ category: "aborted" });
  });
});
