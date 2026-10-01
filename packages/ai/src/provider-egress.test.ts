import {
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  createConversationAgentHarness,
  asInteractionTurnId,
  asConversationEventId,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
  asCompiledContextId,
  asConversationEventRevisionId,
  asGenerationCommandId,
  asModelRunAttemptId,
  asUserId,
  type ContextCompiler,
  type ConversationTextChampion,
  type ProviderEgressClaim,
  type ProviderEgressStreamEvent,
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

  it.each(["conversation-output:v1", "conversation-output:v2"])("completes a missing real-world support anchor on a posture-active turn (%s)", async (outputFormatVersion) => {
    // The real champion occasionally drops the anchor on a posture-active
    // turn even with the compiled posture section present (observed on the
    // #79 evidence run). Egress makes the anchor deterministic: when the
    // compiled instructions carry the active-posture marker and the streamed
    // response contains no whitelisted number, one versioned anchor delta is
    // emitted before the completion — the same semantics the behavior-aware
    // Champion already freezes in the system tests.
    const contextCompiler = {
      async compile() {
        throw new Error("Compilation does not run inside Egress.");
      },
      renderPermittedPayload() {
        return {
          instructions:
            "Instructions with an active posture safety-posture:active section.",
          locale: "en-US",
          messages: [],
        };
      },
    } satisfies ContextCompiler;
    const model = {
      async *stream() {
        yield { delta: "Glad you slept a little,", type: "delta" as const };
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
    const repository = baseRepository(outputFormatVersion);
    const port = createProviderEgressPort({
      champion: testChampion(),
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

    const deltas = events.filter((event) => event.type === "delta");
    expect(deltas).toHaveLength(outputFormatVersion === "conversation-output:v1" ? 2 : 3);
    expect(deltas.at(-1)?.delta).toContain("988");
    expect(deltas.slice(0, -1).map((event) => event.delta).join("")).toBe("Glad you slept a little,");
    const completedIndex = events.findIndex((event) => event.type === "completed");
    expect(completedIndex).toBe(events.length - 1);
  });

  it.each(["conversation-output:v1", "conversation-output:v2"])("does not append the anchor when the response already carries a whitelisted number (%s)", async (outputFormatVersion) => {
    const contextCompiler = {
      async compile() {
        throw new Error("Compilation does not run inside Egress.");
      },
      renderPermittedPayload() {
        return {
          instructions:
            "Instructions with an active posture safety-posture:active section.",
          locale: "zh-CN",
          messages: [],
        };
      },
    } satisfies ContextCompiler;
    const model = {
      async *stream() {
        yield { delta: "如果撑不住就打 12356。", type: "delta" as const };
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
    const port = createProviderEgressPort({
      champion: testChampion(),
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
      contextCompiler,
      model,
      repository: baseRepository(outputFormatVersion),
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

    const deltas = events.filter((event) => event.type === "delta");
    expect(deltas).toHaveLength(1);
  });

  it.each(["conversation-output:v1", "conversation-output:v2"])("never appends an anchor when no posture is active (%s)", async (outputFormatVersion) => {
    const contextCompiler = {
      async compile() {
        throw new Error("Compilation does not run inside Egress.");
      },
      renderPermittedPayload() {
        return { instructions: "Ordinary instructions.", locale: "en-US", messages: [] };
      },
    } satisfies ContextCompiler;
    const model = {
      async *stream() {
        yield { delta: "Plain ordinary reply.", type: "delta" as const };
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
    const port = createProviderEgressPort({
      champion: testChampion(),
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
      contextCompiler,
      model,
      repository: baseRepository(outputFormatVersion),
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

    expect(events.filter((event) => event.type === "delta")).toHaveLength(1);
  });

  it("allows stop-signal proposals between text deltas and commits the same formatted text", async () => {
    const { events, joined } = await streamPunctuationFixture("conversation-output:v2", false, true);
    expect(joined).toBe("我是 AI，不是人。这个我接不住，也不能");
    expect(events.some((event) => event.type === "stop_signal_proposal")).toBe(true);
    let committedText = "";
    let committedProposals: unknown;
    const harness = createConversationAgentHarness({
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
      egressPort: { async *stream() { yield* events; } },
      repository: {
        async claimResponseExecution() { return "owner"; },
        async claimStaleResponseExecution() { throw new Error("Unexpected retry"); },
        async loadResponse() { throw new Error("Unexpected replay"); },
        async settleResponseFailure() { throw new Error("Unexpected failure"); },
        async commitCompleteResponse(input) {
          committedText = input.text;
          committedProposals = input.stopSignalProposals;
          return {
            outcome: "committed",
            eventId: asConversationEventId("01984477-59a9-7d20-9d97-e588769566c5"),
            revisionId: asConversationEventRevisionId("01984477-59a9-7d20-9d97-e588769566c6"),
          };
        },
      },
    });
    const output = [];
    for await (const event of harness.runDecision({
      userId,
      compiledContextId: asCompiledContextId("01984477-59a9-7d20-9d97-e588769566c1"),
      generationCommandId: asGenerationCommandId("01984477-59a9-7d20-9d97-e588769566c2"),
      modelRunAttemptId: asModelRunAttemptId("01984477-59a9-7d20-9d97-e588769566c3"),
      requestEventRevisionId: asConversationEventRevisionId("01984477-59a9-7d20-9d97-e588769566c4"),
      interactionTurnId: asInteractionTurnId("01984477-59a9-7d20-9d97-e588769566c7"),
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      catalogVersion: EMPTY_CONVERSATION_ACTION_CATALOG.version,
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
    })) output.push(event);
    expect(output.at(-1)?.type).toBe("decision_committed");
    expect(committedText).toBe(joined);
    expect(output.filter((event) => event.type === "decision_delta").map((event) => event.delta).join("")).toBe(joined);
    expect(committedProposals).toEqual([{ kind: "suppress_all_questions" }]);
  });

  it("flushes held response text before an Action selection", async () => {
    const { events, joined } = await streamPunctuationFixture("conversation-output:v2", true);
    expect(events.map((event) => event.type)).toEqual(["delta", "delta", "action_proposal", "completed"]);
    expect(joined).toBe("我是 AI,");
    expect(events.find((event) => event.type === "action_proposal")).toMatchObject({
      proposal: { arguments: { journalHandle: "shh-handle-test" } },
    });
  });

  it("keeps conversation-output:v1 delta stream byte-identical", async () => {
    const { joined, events } = await streamPunctuationFixture(
      "conversation-output:v1",
    );
    expect(joined).toBe("我是 AI,不是人。这个我接不住,也不能");
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
  });

  it("normalizes CJK-adjacent commas for conversation-output:v2 and preserves completion", async () => {
    const { joined, events } = await streamPunctuationFixture(
      "conversation-output:v2",
    );
    expect(joined).toBe("我是 AI，不是人。这个我接不住，也不能");
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(events.at(-1)).toEqual(PUNCTUATION_COMPLETION);
  });
});

const PUNCTUATION_COMPLETION = {
  costMicros: 0,
  finishReason: "completed",
  inputTokens: 8,
  modelSnapshot: "gpt-5.4",
  outputTokens: 4,
  providerRequestId: "synthetic-provider-request",
  type: "completed" as const,
};

async function streamPunctuationFixture(
  outputFormatVersion: string,
  action = false,
  stopSignal = false,
): Promise<{ events: ProviderEgressStreamEvent[]; joined: string }> {
  const contextCompiler = {
    async compile() {
      throw new Error("Compilation does not run inside Egress.");
    },
    renderPermittedPayload() {
      return { instructions: "Ordinary instructions.", locale: "zh-CN", messages: [] };
    },
  } satisfies ContextCompiler;
  const model = {
    async *stream() {
      yield { delta: "我是 AI,", type: "delta" as const };
      if (stopSignal) {
        yield { type: "tool_call" as const, rawFunctionName: "curiosity_stop_signal", rawArguments: '{"proposals":[{"kind":"suppress_all_questions"}]}' };
      }
      if (action) {
        yield { type: "tool_call" as const, rawFunctionName: "regenerate_journal", rawArguments: '{"journalHandle":"shh-handle-test"}' };
      } else {
        yield { delta: "不是人。这个我接不住,", type: "delta" as const };
        yield { delta: "也不能", type: "delta" as const };
      }
      yield PUNCTUATION_COMPLETION;
    },
  } satisfies ConversationTextModel;
  const port = createProviderEgressPort({
    champion: testChampion(),
    clock: () => new Date("2026-07-29T12:00:00.000Z"),
    contextCompiler,
    model,
    repository: baseRepository(outputFormatVersion),
  });
  const events: ProviderEgressStreamEvent[] = [];
  let joined = "";
  for await (const event of port.stream({
    ...((action || stopSignal) ? {
      definitions: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.definitions,
      requestEventRevisionId: asConversationEventRevisionId("01984477-59a9-7d20-9d97-e588769566c4"),
    } : {}),
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
    if (event.type === "delta") joined += event.delta;
    events.push(event);
  }
  return { events, joined };
}

function testChampion(): ConversationTextChampion {
  return {
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
    supportedLocales: Object.freeze(["en", "zh"]),
    trainingPolicy: "test",
  };
}

function baseRepository(
  outputFormatVersion = "conversation-output:v1",
): ProviderEgressRepository {
  return {
    async claimDispatch() {
      return {
        context: {
          compilerVersion: "context-compiler:v1",
          integrity: {
            algorithm: "hmac-sha256" as const,
            contentHmac: "0".repeat(64),
            keyVersion: "context-integrity:v1",
          },
          generationStage: "decision" as const,
          locale: "en-US",
          policyVersions: {
            canonicalPersonaVersion: "canonical-persona:v1",
            localePolicyVersion: "locale-pack-en:v1",
            outputFormatVersion,
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
  };
}

