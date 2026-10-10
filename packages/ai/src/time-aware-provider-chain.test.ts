import {
  asCompiledContextId,
  asConversationEventRevisionId,
  asDailySessionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asUserId,
  createContextCompiler,
  TIME_AWARE_CONTEXT_COMPILER_VERSION,
  type ContextCompilerRepository,
  type ContextPolicyVersions,
  type ConversationTextChampion,
  type ProviderEgressRepository,
} from "@sayhear/application";
import { describe, expect, it } from "vitest";

import { createOpenCodeGoConversationTextModel } from "./opencode-go-conversation-text-model";
import { createProviderEgressPort } from "./provider-egress";

const userId = asUserId("01984477-59a9-7d20-9d97-e588769566c0");
const dailySessionId = asDailySessionId(
  "01984477-59a9-7d20-9d97-e588769566c1",
);
const inputRevisionId = asConversationEventRevisionId(
  "01984477-59a9-7d20-9d97-e588769566c2",
);
const earlierUserRevisionId = asConversationEventRevisionId(
  "01984477-59a9-7d20-9d97-e588769566c3",
);
const earlierAssistantRevisionId = asConversationEventRevisionId(
  "01984477-59a9-7d20-9d97-e588769566c4",
);
const generationCommandId = asGenerationCommandId(
  "01984477-59a9-7d20-9d97-e588769566c5",
);
const interactionTurnId = asInteractionTurnId(
  "01984477-59a9-7d20-9d97-e588769566c6",
);
const modelRunAttemptId = asModelRunAttemptId(
  "01984477-59a9-7d20-9d97-e588769566c7",
);

const policyVersions: ContextPolicyVersions = {
  canonicalPersonaVersion: "canonical-persona:v1",
  localePolicyVersion: "locale-pack-en:v1",
  outputFormatVersion: "conversation-output:v1",
  personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
  personaContractInvariantVersion: "persona-contract-invariant:v1",
  productPolicyVersion: "product-policy:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
  taskInstructionVersion: "task-instruction-decision:v1",
};

const champion: ConversationTextChampion = {
  configVersion: "conversation-text-champion:test:v1",
  consentPolicyVersion: null,
  contextLimit: 100_000,
  dataRegion: "test",
  model: "deepseek-v4.1-flash",
  provider: "opencode-go",
  providerPolicyVersion: "opencode-go-conversation-text:test:v1",
  retentionMode: "store-disabled",
  snapshot: "deepseek-v4.1-flash",
  streaming: true,
  supportedLocales: ["en"],
  trainingPolicy: "test",
};

describe("time-aware Context to OpenCode Go provider chain", () => {
  it("sends frozen current and per-message times in the actual provider request", async () => {
    let compiled: Parameters<
      ContextCompilerRepository["saveCompiledContext"]
    >[0] | undefined;
    const contextCompiler = createContextCompiler({
      clock: () => new Date("2026-11-01T09:30:00.000Z"),
      compilerVersion: TIME_AWARE_CONTEXT_COMPILER_VERSION,
      contentHmacSecret: "time-aware-provider-chain-test-secret",
      rawEventTokenBudget: 4_000,
      repository: {
        async loadContextSource() {
          return {
            commandCreatedAt: new Date("2026-11-01T09:30:00.000Z"),
            dailySession: {
              activityState: "active" as const,
              closurePolicyVersion: "daily-session-inactivity:v1",
              continuousExchangeNo: 3,
              id: dailySessionId,
              timezone: "America/Los_Angeles",
            },
            dialogueRevision: 1,
            events: [
              {
                actor: "user" as const,
                expressedAt: "2026-11-01T06:55:00.000Z",
                expressionTimezone: "America/Los_Angeles",
                expressionTimezoneSource: "request" as const,
                locale: "en-US",
                revisionId: earlierUserRevisionId,
                sequence: 7,
                text: "I went to bed late.",
              },
              {
                actor: "assistant" as const,
                expressedAt: "2026-11-01T08:30:00.000Z",
                expressionTimezone: "America/Los_Angeles",
                expressionTimezoneSource: "request" as const,
                locale: "en-US",
                revisionId: earlierAssistantRevisionId,
                sequence: 8,
                text: "You said it was 1:30.",
              },
              {
                actor: "user" as const,
                expressedAt: "2026-11-01T09:30:00.000Z",
                expressionTimezone: "America/Los_Angeles",
                expressionTimezoneSource: "request" as const,
                locale: "en-US",
                revisionId: inputRevisionId,
                sequence: 9,
                text: "What did I say yesterday?",
              },
            ],
            generationStage: "decision" as const,
            inputRevisionId,
            locale: "en-US",
            policyVersions,
            requestTimezone: "America/Los_Angeles",
            sourceRevision: 3,
          };
        },
        async saveCompiledContext(input) {
          compiled = input;
          return {
            degradedReason: input.degradedReason,
            dialogueRevision: input.dialogueRevision,
            id: asCompiledContextId(
              "01984477-59a9-7d20-9d97-e588769566c8",
            ),
            locale: input.locale,
            referencedRevisionIds: input.referencedEvents.map(
              (event) => event.revisionId,
            ),
            sourceRevision: input.sourceRevision,
            statistics: {
              rawEventBudgetTokens: input.sectionBudgets.committedRawEvents,
              selectedEventCount: input.referencedEvents.length,
              totalTokens: input.totalTokens,
            },
          };
        },
      } satisfies ContextCompilerRepository,
    });
    await contextCompiler.compile({
      generationCommandId,
      interactionTurnId,
      userId,
    });
    if (!compiled) throw new Error("The Context manifest was not captured.");

    let providerBody: Record<string, unknown> | undefined;
    const model = createOpenCodeGoConversationTextModel({
      apiKey: "synthetic-provider-key",
      fetchImplementation: async (_url, init) => {
        providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const events = [
          {
            choices: [
              {
                delta: { content: "I hear you.", role: "assistant" },
                finish_reason: null,
                index: 0,
              },
            ],
            id: "chatcmpl-time-context-test",
            model: "deepseek-v4.1-flash",
          },
          {
            choices: [
              { delta: {}, finish_reason: "stop", index: 0 },
            ],
            id: "chatcmpl-time-context-test",
            model: "deepseek-v4.1-flash",
          },
          {
            choices: [],
            id: "chatcmpl-time-context-test",
            model: "deepseek-v4.1-flash",
            usage: {
              completion_tokens: 4,
              prompt_tokens: 100,
              total_tokens: 104,
            },
          },
          "[DONE]",
        ];
        const body = events
          .map((event) =>
            event === "[DONE]"
              ? "data: [DONE]\n\n"
              : `data: ${JSON.stringify(event)}\n\n`,
          )
          .join("");
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "synthetic-time-context-request",
          },
          status: 200,
        });
      },
    });
    const repository: ProviderEgressRepository = {
      async claimDispatch() {
        return {
          context: {
            ...compiled!,
            generationStage: "decision",
          },
          dailySessionId,
          model: "deepseek-v4.1-flash",
          outcome: "permitted",
        };
      },
      async recordFirstToken() {
        return true;
      },
      async recordProviderCompletion() {
        return true;
      },
    };
    const port = createProviderEgressPort({
      champion,
      clock: () => new Date("2026-11-01T09:30:00.000Z"),
      contextCompiler,
      model,
      repository,
    });

    for await (const _event of port.stream({
      compiledContextId: asCompiledContextId(
        "01984477-59a9-7d20-9d97-e588769566c8",
      ),
      generationCommandId,
      modelRunAttemptId,
      userId,
    })) {
      // Consume the complete synthetic Provider response.
    }

    const messages = providerBody?.["messages"] as
      | readonly Readonly<Record<string, unknown>>[]
      | undefined;
    expect(messages?.map((message) => message["role"])).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(messages?.[0]?.["content"]).toContain(
      "current request anchor instant=2026-11-01T09:30:00.000Z",
    );
    expect(messages?.[0]?.["content"]).toContain(
      "local date=2026-11-01; local time=01:30:00 GMT-8",
    );
    expect(messages?.[0]?.["content"]).toContain(
      "local date=2026-10-31; local time=23:55:00 GMT-7",
    );
    expect(messages?.[0]?.["content"]).toContain(
      "local time=01:30:00 GMT-7",
    );
    expect(messages?.[0]?.["content"]).toContain(
      `provider_message=1; revision=${earlierUserRevisionId}; role=user`,
    );
    expect(messages?.[0]?.["content"]).toContain(
      `provider_message=2; revision=${earlierAssistantRevisionId}; role=assistant`,
    );
    expect(messages?.[0]?.["content"]).toContain(
      `provider_message=3; revision=${inputRevisionId}; role=user`,
    );
    expect(messages?.slice(1).map((message) => message["content"])).toEqual([
      "I went to bed late.",
      "You said it was 1:30.",
      "What did I say yesterday?",
    ]);
  });
});
