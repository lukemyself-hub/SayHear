import type {
  ConversationTextChampion,
  ProviderEgressPort,
  ProviderEgressRepository,
} from "@sayhear/application";

import { createDeterministicConversationTextModel } from "./deterministic-conversation-text-model";
import { createOpenAIConversationTextModel } from "./openai-conversation-text-model";
import { createProviderEgressPort } from "./provider-egress";

type ProviderAdapterConfiguration =
  | Readonly<{
      apiKey: string;
      timeoutMs: number;
      type: "openai";
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
  repository: ProviderEgressRepository;
}): ProviderEgressPort {
  const model =
    input.adapter.type === "deterministic"
      ? createDeterministicConversationTextModel({
          chunks: input.adapter.chunks,
          ...(input.adapter.failAfterCompletion
            ? { failAfterCompletion: true }
            : {}),
          ...(input.adapter.failAfterChunks === undefined
            ? {}
            : { failAfterChunks: input.adapter.failAfterChunks }),
        })
      : createOpenAIConversationTextModel({
          apiKey: input.adapter.apiKey,
          timeoutMs: input.adapter.timeoutMs,
        });

  return createProviderEgressPort({
    champion: input.champion,
    clock: input.clock,
    model,
    repository: input.repository,
  });
}
