import {
  asCompiledContextId,
  asConversationEventRevisionId,
  asGenerationCommandId,
  asModelRunAttemptId,
  asUserId,
  ProviderDispatchError,
  type ContextCompiler,
  type ConversationTextChampion,
  type ConversationTextModel,
  type ModelRoleCallUsage,
  type ProviderEgressRepository,
} from "@sayhear/application";
import { describe, expect, it } from "vitest";

import { createProviderEgressPort } from "./provider-egress";

const userId = asUserId("01984477-59a9-7d20-9d97-e588769566c0");
const attemptId = asModelRunAttemptId("01984477-59a9-7d20-9d97-e588769566c9");

const champion: ConversationTextChampion = {
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
};

const contextCompiler = {
  async compile() {
    throw new Error("not used");
  },
  renderPermittedPayload() {
    return {
      instructions: "x",
      locale: "en-US",
      messages: [
        {
          revisionId: asConversationEventRevisionId("01984477-59a9-7d20-9d97-e588769566c0"),
          role: "user" as const,
          text: "hi",
        },
      ],
    };
  },
} satisfies ContextCompiler;

function setup(model: ConversationTextModel) {
  const recorded: ModelRoleCallUsage[] = [];
  const repository: ProviderEgressRepository = {
    async claimDispatch() {
      return {
        context: {
          compilerVersion: "context-compiler:v1",
          integrity: {
            algorithm: "hmac-sha256" as const,
            contentHmac: "0".repeat(64),
            keyVersion: "context-integrity:v1",
          },
          generationStage: "decision",
          locale: "en-US",
          policyVersions: {
            canonicalPersonaVersion: "canonical-persona:v1",
            localePolicyVersion: "locale-pack-en:v1",
            outputFormatVersion: "conversation-output:v1",
            personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
            personaContractInvariantVersion: "persona-contract-invariant:v1",
            productPolicyVersion: "product-policy:v1",
            relationshipPolicyVersion: "relationship-boundary:v1",
            safetyPolicyVersion: "minimum-high-risk-response:v1",
            taskInstructionVersion: "task-instruction-decision:v1",
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
    async recordProviderUsage(input) {
      recorded.push(input.usage);
    },
  };
  const port = createProviderEgressPort({
    champion,
    clock: () => new Date("2026-09-12T16:00:00.000Z"),
    contextCompiler,
    model,
    repository,
  });
  return { port, recorded };
}

async function drain(port: ReturnType<typeof setup>["port"]): Promise<unknown> {
  try {
    for await (const event of port.stream({
      compiledContextId: asCompiledContextId("01984477-59a9-7d20-9d97-e588769566c3"),
      generationCommandId: asGenerationCommandId("01984477-59a9-7d20-9d97-e588769566c2"),
      modelRunAttemptId: attemptId,
      userId,
    })) {
      void event;
    }
    return null;
  } catch (error) {
    return error;
  }
}

describe("Provider Egress usage settlement (issue #319)", () => {
  it("keeps the spend the Provider reported when the call then fails before completing", async () => {
    // A tool-only Decision that burned its budget thinking and was then cut off:
    // the Provider already billed it, so the ledger must show it.
    const { port, recorded } = setup({
      async *stream(input) {
        input.onUsage?.({
          cachedTokens: null,
          inputTokens: 6_430,
          outputTokens: 11_919,
          reasoningTokens: 11_000,
          totalTokens: 18_349,
        });
        yield* [];
        throw new ProviderDispatchError("unavailable");
      },
    });
    const error = await drain(port);
    expect(error).toBeInstanceOf(ProviderDispatchError);
    expect(recorded).toEqual([
      {
        cachedTokens: null,
        inputTokens: 6_430,
        outputTokens: 11_919,
        reasoningTokens: 11_000,
        totalTokens: 18_349,
      },
    ]);
  });

  it("records nothing when the Provider reported no usage, never a fabricated zero", async () => {
    const { port, recorded } = setup({
      async *stream() {
        yield* [];
        throw new ProviderDispatchError("timeout");
      },
    });
    await drain(port);
    expect(recorded).toEqual([]);
  });
});
