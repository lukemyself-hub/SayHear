import {
  asCompiledContextId,
  asConversationEventRevisionId,
  asGenerationCommandId,
  asModelRunAttemptId,
  asUserId,
  type ContextCompiler,
  type ConversationTextModel,
  type ProviderEgressRepository,
} from "@sayhear/application";
import { describe, expect, it } from "vitest";

import { createProviderEgressPort } from "./provider-egress";

const userId = asUserId("01984477-59a9-7d20-9d97-e588769566c0");

describe("Provider Egress", () => {
  it("uses the Context Compiler rendered payload after the dispatch fence", async () => {
    const inputRevisionId = asConversationEventRevisionId(
      "01984477-59a9-7d20-9d97-e588769566c0",
    );
    const contextCompiler = {
      async compile() {
        throw new Error("Compilation does not run inside Egress.");
      },
      renderPermittedPayload() {
        return {
          instructions: "Instructions rendered by Context Compiler.",
          locale: "en-US",
          messages: [
            {
              revisionId: inputRevisionId,
              role: "user" as const,
              text: "Private synthetic input.",
            },
          ],
        };
      },
    } satisfies ContextCompiler;
    let modelRequest: Parameters<ConversationTextModel["stream"]>[0] | undefined;
    const model = {
      async *stream(input) {
        modelRequest = input;
        yield { delta: "I hear you.", type: "delta" as const };
        yield {
          costMicros: 0,
          finishReason: "completed",
          inputTokens: 8,
          modelSnapshot: "gpt-5.4",
          outputTokens: 4,
          providerRequestId: "synthetic-provider-request",
          type: "completed" as const,
        };
      },
    } satisfies ConversationTextModel;
    const repository = {
      async claimDispatch() {
        return {
          context: {
            compilerVersion: "context-compiler:v1",
            integrity: {
              algorithm: "hmac-sha256" as const,
              contentHmac: "0".repeat(64),
              keyVersion: "context-integrity:v1",
            },
            locale: "en-US",
            policyVersions: {
              localePolicyVersion: "locale-pack-en:v1",
              outputFormatVersion: "conversation-output:v1",
              personaVersion: "sayhear-persona:v1",
              productPolicyVersion: "product-policy:v1",
              relationshipPolicyVersion: "relationship-boundary:v1",
              safetyPolicyVersion: "minimum-high-risk-response:v1",
              taskInstructionVersion: "conversation-text:v1",
            },
            referencedEvents: [],
            sections: [],
            totalTokens: 0,
          },
          model: "gpt-5.4",
          outcome: "permitted" as const,
        };
      },
      async recordFirstToken() {
        return true;
      },
      async recordProviderCompletion() {
        return true;
      },
    } satisfies ProviderEgressRepository;
    const port = createProviderEgressPort({
      champion: {
        configVersion: "conversation-text-champion:v1",
        consentPolicyVersion: null,
        contextLimit: 100_000,
        dataRegion: "test",
        model: "gpt-5.4",
        provider: "openai",
        providerPolicyVersion: "openai-conversation-text:v1",
        retentionMode: "store-disabled",
        snapshot: "gpt-5.4",
        streaming: true,
        supportedLocales: ["en", "zh"],
        trainingPolicy: "test",
      },
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
      contextCompiler,
      model,
      repository,
    });

    for await (const _event of port.stream({
      userId,
      compiledContextId: asCompiledContextId(
        "01984477-59a9-7d20-9d97-e588769566c1",
      ),
      generationCommandId: asGenerationCommandId(
        "01984477-59a9-7d20-9d97-e588769566c2",
      ),
      modelRunAttemptId: asModelRunAttemptId(
        "01984477-59a9-7d20-9d97-e588769566c3",
      ),
    })) {
      // Drain the stream so the model request is observed.
    }

    expect(modelRequest).toEqual({
      instructions: "Instructions rendered by Context Compiler.",
      locale: "en-US",
      messages: [
        {
          revisionId: inputRevisionId,
          role: "user",
          text: "Private synthetic input.",
        },
      ],
      model: "gpt-5.4",
    });
  });

  it("forwards a provider-native tool_call without recording a completion", async () => {
    const contextCompiler = {
      async compile() {
        throw new Error("Compilation does not run inside Egress.");
      },
      renderPermittedPayload() {
        return {
          instructions: "Instructions rendered by Context Compiler.",
          locale: "en-US",
          messages: [],
        };
      },
    } satisfies ContextCompiler;
    let recordedCompletions = 0;
    const model = {
      async *stream() {
        // A provider-native function call is not a Final Response. The Egress
        // Port forwards it untouched and never records a completion; the
        // Conversation Action Catalog decision is the Harness's responsibility.
        yield {
          rawArguments: '{"journal_id":"sh.journal.private"}',
          rawFunctionName: "regenerate_journal",
          type: "tool_call" as const,
        };
      },
    } satisfies ConversationTextModel;
    const repository = {
      async claimDispatch() {
        return {
          context: {
            compilerVersion: "context-compiler:v1",
            integrity: {
              algorithm: "hmac-sha256" as const,
              contentHmac: "0".repeat(64),
              keyVersion: "context-integrity:v1",
            },
            locale: "en-US",
            policyVersions: {
              localePolicyVersion: "locale-pack-en:v1",
              outputFormatVersion: "conversation-output:v1",
              personaVersion: "sayhear-persona:v1",
              productPolicyVersion: "product-policy:v1",
              relationshipPolicyVersion: "relationship-boundary:v1",
              safetyPolicyVersion: "minimum-high-risk-response:v1",
              taskInstructionVersion: "conversation-text:v1",
            },
            referencedEvents: [],
            sections: [],
            totalTokens: 0,
          },
          model: "gpt-5.4",
          outcome: "permitted" as const,
        };
      },
      async recordFirstToken() {
        return true;
      },
      async recordProviderCompletion() {
        recordedCompletions += 1;
        return true;
      },
    } satisfies ProviderEgressRepository;
    const port = createProviderEgressPort({
      champion: {
        configVersion: "conversation-text-champion:v1",
        consentPolicyVersion: null,
        contextLimit: 100_000,
        dataRegion: "test",
        model: "gpt-5.4",
        provider: "openai",
        providerPolicyVersion: "openai-conversation-text:v1",
        retentionMode: "store-disabled",
        snapshot: "gpt-5.4",
        streaming: true,
        supportedLocales: ["en", "zh"],
        trainingPolicy: "test",
      },
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
      contextCompiler,
      model,
      repository,
    });

    const events = [];
    for await (const event of port.stream({
      userId,
      compiledContextId: asCompiledContextId(
        "01984477-59a9-7d20-9d97-e588769566c1",
      ),
      generationCommandId: asGenerationCommandId(
        "01984477-59a9-7d20-9d97-e588769566c2",
      ),
      modelRunAttemptId: asModelRunAttemptId(
        "01984477-59a9-7d20-9d97-e588769566c3",
      ),
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        rawArguments: '{"journal_id":"sh.journal.private"}',
        rawFunctionName: "regenerate_journal",
        type: "tool_call",
      },
    ]);
    expect(recordedCompletions).toBe(0);
  });
});
