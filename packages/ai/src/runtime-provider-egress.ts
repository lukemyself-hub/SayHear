import type {
  ContextCompiler,
  ConversationTextChampion,
  ProviderEgressPort,
  ProviderEgressRepository,
} from "@sayhear/application";

import { createBehaviorAwareConversationTextModel } from "./behavior-aware-conversation-text-model";
import { createResponsesApiConversationTextModel } from "./responses-api-conversation-text-model";
import { createProviderEgressPort } from "./provider-egress";

type ProviderAdapterConfiguration =
  | Readonly<{
      apiKey: string;
      baseUrl: string;
      timeoutMs: number;
      type: "responses-api";
    }>
  | Readonly<{
      chunks: readonly string[];
      failAfterCompletion?: boolean;
      failAfterChunks?: number;
      type: "deterministic";
    }>;

export function createRuntimeProviderEgressPort(input: {
  adapter: ProviderAdapterConfiguration;
  champion: ConversationTextChampion;
  clock: () => Date;
  contextCompiler: Pick<ContextCompiler, "renderPermittedPayload">;
  repository: ProviderEgressRepository;
}): ProviderEgressPort {
  const model =
    input.adapter.type === "deterministic"
      ? createDeterministicBehaviorModel(input.adapter)
      : createResponsesApiConversationTextModel({
          apiKey: input.adapter.apiKey,
          baseUrl: input.adapter.baseUrl,
          timeoutMs: input.adapter.timeoutMs,
        });

  return createProviderEgressPort({
    champion: input.champion,
    clock: input.clock,
    contextCompiler: input.contextCompiler,
    model,
    repository: input.repository,
  });
}

/**
 * The configured deterministic Conversation Text Champion applies the versioned
 * 1A.1 behavior policy: an explicit high-risk signal activates the Minimum
 * High-Risk Response, and every ordinary Understanding Response echoes the
 * configured deterministic chunks.
 */
function createDeterministicBehaviorModel(adapter: {
  chunks: readonly string[];
  failAfterCompletion?: boolean;
  failAfterChunks?: number;
}) {
  const { chunks, failAfterCompletion, failAfterChunks } = adapter;
  return createBehaviorAwareConversationTextModel({
    responder: () => chunks,
    ...(failAfterCompletion ? { failAfterCompletion: true } : {}),
    ...(failAfterChunks === undefined ? {} : { failAfterChunks }),
  });
}
