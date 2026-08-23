import {
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  asCompiledContextId,
  asConversationEventId,
  asConversationEventRevisionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asUserId,
  createConversationAgentHarness,
  type CompiledContextRenderSource,
  type ConversationAgentHarnessRepository,
  type ConversationHarnessEvent,
  type ConversationTextChampion,
  type ConversationTextModel,
  type ContextCompiler,
  type ProviderEgressRepository,
} from "@sayhear/application";
import { describe, expect, it } from "vitest";

import { createProviderEgressPort } from "./provider-egress";
import { createDeterministicConversationTextModel } from "./deterministic-conversation-text-model";
import { createBehaviorAwareConversationTextModel } from "./behavior-aware-conversation-text-model";

/**
 * Issue #24 AC7: deterministic and runtime Provider adapters pass one Harness
 * Interface conformance suite. Both the deterministic Conversation Text model
 * and the behavior-aware Champion flow through the same real Provider Egress
 * Port and the same Conversation Agent Harness, so the contract — ordinary
 * streaming commit, interrupted exclusion, same-Command retry, and empty-Catalog
 * fail-closed — holds for every adapter.
 */

const userId = asUserId("01984477-1f9a-7d25-9d97-e588769566c0");
const interactionTurnId = asInteractionTurnId(
  "01984477-1f9a-7d25-9d97-e588769566c1",
);
const generationCommandId = asGenerationCommandId(
  "01984477-1f9a-7d25-9d97-e588769566c2",
);
const compiledContextId = asCompiledContextId(
  "01984477-1f9a-7d25-9d97-e588769566c3",
);
const modelRunAttemptId = asModelRunAttemptId(
  "01984477-1f9a-7d25-9d97-e588769566c4",
);
const assistantEventId = asConversationEventId(
  "01984477-1f9a-7d25-9d97-e588769566c5",
);
const assistantRevisionId = asConversationEventRevisionId(
  "01984477-1f9a-7d25-9d97-e588769566c6",
);

const fixedClock = () => new Date("2026-08-11T12:00:00.000Z");

const champion: ConversationTextChampion = Object.freeze({
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
});

const permittedRenderSource: CompiledContextRenderSource = Object.freeze({
  compilerVersion: "context-compiler:v1",
  integrity: {
    algorithm: "hmac-sha256",
    contentHmac: "0".repeat(64),
    keyVersion: "context-integrity:v1",
  } as const,
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
});

const contextCompiler = {
  async compile() {
    throw new Error("Compilation runs in the Service, not the Harness.");
  },
  renderPermittedPayload() {
    return {
      instructions: "Companion instructions rendered by Context Compiler.",
      locale: "en-US",
      messages: [
        {
          revisionId: assistantRevisionId,
          role: "user" as const,
          text: "Private synthetic conformance input.",
        },
      ],
    };
  },
} satisfies ContextCompiler;

function createEgressPort(model: ConversationTextModel) {
  const egressRepository = {
    async claimDispatch() {
      return {
        context: permittedRenderSource,
        model: champion.model,
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
  return createProviderEgressPort({
    champion,
    clock: fixedClock,
    contextCompiler,
    model,
    repository: egressRepository,
  });
}

function createHarnessRepository(options: {
  commitOutcome: "committed" | "fence_rejected";
  settleOutcome:
    | { kind: "settled"; status: "failed" | "interrupted" }
    | { kind: "retry_scheduled"; retryAt: Date };
  onSettle?: (interrupted: boolean) => void;
}): ConversationAgentHarnessRepository {
  return {
    async claimResponseExecution() {
      return "owner";
    },
    async loadResponse() {
      throw new Error("unexpected loadResponse in conformance harness");
    },
    async commitCompleteResponse() {
      if (options.commitOutcome === "fence_rejected") {
        return { outcome: "fence_rejected" };
      }
      return {
        eventId: assistantEventId,
        outcome: "committed",
        revisionId: assistantRevisionId,
      };
    },
    async settleResponseFailure(input) {
      options.onSettle?.(input.interrupted);
      if (options.settleOutcome.kind === "settled") {
        return {
          category: input.category,
          outcome: "settled",
          status: options.settleOutcome.status,
        };
      }
      return {
        outcome: "retry_scheduled",
        retryAt: options.settleOutcome.retryAt,
      };
    },
    async claimStaleResponseExecution() {
      throw new Error("unexpected claimStaleResponseExecution");
    },
  };
}

function baseCommand() {
  return {
    catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
    catalogVersion: EMPTY_CONVERSATION_ACTION_CATALOG.version,
    compiledContextId,
    generationCommandId,
    harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
    interactionTurnId,
    modelRunAttemptId,
    userId,
  };
}

async function runHarness(model: ConversationTextModel, repository: ConversationAgentHarnessRepository) {
  const harness = createConversationAgentHarness({
    clock: fixedClock,
    delay: async () => undefined,
    egressPort: createEgressPort(model),
    jitter: () => 0.5,
    repository,
  });
  const events: ConversationHarnessEvent[] = [];
  for await (const event of harness.runDecision(baseCommand())) {
    events.push(event);
  }
  return events;
}

type AdapterFactory = (input: {
  deltas: readonly string[];
  emitToolCall?: Readonly<{ rawArguments: string; rawFunctionName: string }>;
}) => ConversationTextModel;

// Each adapter under test: the deterministic Conversation Text model and the
// behavior-aware Champion. Both must satisfy the same Harness contract.
const adapters: Readonly<{ name: string; create: AdapterFactory }>[] = [
  {
    name: "deterministic",
    create: ({ deltas, emitToolCall }) =>
      createDeterministicConversationTextModel({
        chunks: deltas,
        ...(emitToolCall ? { emitToolCall } : {}),
      }),
  },
  {
    name: "behavior-aware",
    create: ({ deltas, emitToolCall }) =>
      createBehaviorAwareConversationTextModel({
        responder: () => deltas,
        ...(emitToolCall ? { emitToolCall } : {}),
      }),
  },
];

for (const adapter of adapters) {
  describe(`Conversation Agent Harness conformance — ${adapter.name} adapter`, () => {
    it("streams the ordinary Final Response and commits one Assistant Event", async () => {
      let commitCalls = 0;
      const repository = {
        ...createHarnessRepository({ commitOutcome: "committed", settleOutcome: { kind: "settled", status: "failed" } }),
        async commitCompleteResponse() {
          commitCalls += 1;
          return {
            eventId: assistantEventId,
            outcome: "committed" as const,
            revisionId: assistantRevisionId,
          };
        },
      };
      const model = adapter.create({ deltas: ["I hear you."] });
      const events = await runHarness(model, repository);

      expect(events).toEqual([
        { delta: "I hear you.", type: "decision_delta" },
        {
          assistantEventId,
          assistantEventRevisionId: assistantRevisionId,
          type: "decision_committed",
        },
      ]);
      expect(commitCalls).toBe(1);
    });

    it("fails closed without an Assistant Event when the model selects a tool against the empty Catalog", async () => {
      let commitCalls = 0;
      let settledCategory: string | null = null;
      const base = createHarnessRepository({
        commitOutcome: "fence_rejected",
        settleOutcome: { kind: "settled", status: "failed" },
        onSettle: (interrupted) => {
          expect(interrupted).toBe(false);
        },
      });
      const repository: ConversationAgentHarnessRepository = {
        ...base,
        async commitCompleteResponse() {
          commitCalls += 1;
          return { outcome: "fence_rejected" as const };
        },
        async settleResponseFailure(input) {
          settledCategory = input.category;
          return { category: input.category, outcome: "settled" as const, status: "failed" as const };
        },
      };
      const model = adapter.create({
        deltas: ["Done."],
        emitToolCall: {
          rawArguments: '{"journal_id":"sh.journal.private"}',
          rawFunctionName: "regenerate_journal",
        },
      });
      const events = await runHarness(model, repository);

      expect(commitCalls).toBe(0);
      expect(events).toEqual([
        {
          category: "invalid_response",
          interrupted: false,
          type: "decision_failed",
        },
      ]);
      expect(settledCategory).toBe("invalid_response");
      expect(JSON.stringify(events).includes("regenerate_journal")).toBe(false);
    });
  });
}
