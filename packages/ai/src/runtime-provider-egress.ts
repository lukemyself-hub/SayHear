import { PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION } from "@sayhear/application";
import type {
  ContextCompiler,
  ConversationTextChampion,
  ProviderEgressPort,
  ProviderEgressRepository,
  RecoveryGate,
} from "@sayhear/application";

import { createBehaviorAwareConversationTextModel } from "./behavior-aware-conversation-text-model";
import { createOpenCodeGoConversationTextModel } from "./opencode-go-conversation-text-model";
import { createResponsesApiConversationTextModel } from "./responses-api-conversation-text-model";
import { createProviderEgressPort } from "./provider-egress";

/**
 * Executable provider-egress coverage manifest. The release inventory imports
 * this value from the module that constructs the provider adapter, so adding a
 * new egress path cannot be represented only by a detached registry string.
 *
 * ADR-0147: the same in-process Provider Egress Port capability now fronts both
 * stateless Responses API traffic (openai/deepseek) and OpenCode Go Chat
 * Completions traffic. It stays one logical capability — `provider:<role>` with
 * its dynamic expected-provider-role set — because the durable integration,
 * receipts, and purge contract are identical; only the wire protocol differs.
 */
export const RUNTIME_PROVIDER_EGRESS_PURGE_INTEGRATION_MANIFEST = {
  integrationIds: ["provider-egress.responses-api"],
  version: PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
} as const;

export const RUNTIME_PROVIDER_EGRESS_INTEGRATION_ID =
  "provider-egress.responses-api" as const;

export function assertRuntimeProviderEgressIntegration(
  integrationId: string,
): void {
  if (
    !RUNTIME_PROVIDER_EGRESS_PURGE_INTEGRATION_MANIFEST.integrationIds.includes(
      integrationId as (typeof RUNTIME_PROVIDER_EGRESS_PURGE_INTEGRATION_MANIFEST.integrationIds)[number],
    )
  ) {
    throw new Error(`Unknown runtime provider-egress integration: ${integrationId}`);
  }
}

type ProviderAdapterConfiguration =
  | Readonly<{
      apiKey: string;
      baseUrl: string;
      timeoutMs: number;
      type: "responses-api";
    }>
  | Readonly<{
      apiKey: string;
      timeoutMs: number;
      type: "opencode-go";
    }>
  | Readonly<{
      chunks: readonly string[];
      emitToolCall?: Readonly<{ rawArguments: string; rawFunctionName: string }>;
      failAfterCompletion?: boolean;
      failAfterChunks?: number;
      type: "deterministic";
    }>;

export function createRuntimeProviderEgressPort(input: {
  adapter: ProviderAdapterConfiguration;
  champion: ConversationTextChampion;
  clock: () => Date;
  contextCompiler: Pick<ContextCompiler, "renderPermittedPayload">;
  recoveryGate?: RecoveryGate;
  repository: ProviderEgressRepository;
}): ProviderEgressPort {
  const model =
    input.adapter.type === "deterministic"
      ? createDeterministicBehaviorModel(input.adapter)
      : input.adapter.type === "opencode-go"
        ? (() => {
            assertRuntimeProviderEgressIntegration(
              RUNTIME_PROVIDER_EGRESS_INTEGRATION_ID,
            );
            return createOpenCodeGoConversationTextModel({
              apiKey: input.adapter.apiKey,
              timeoutMs: input.adapter.timeoutMs,
            });
          })()
        : (() => {
            assertRuntimeProviderEgressIntegration(
              RUNTIME_PROVIDER_EGRESS_INTEGRATION_ID,
            );
            return createResponsesApiConversationTextModel({
              apiKey: input.adapter.apiKey,
              baseUrl: input.adapter.baseUrl,
              timeoutMs: input.adapter.timeoutMs,
            });
          })();

  return createProviderEgressPort({
    champion: input.champion,
    clock: input.clock,
    contextCompiler: input.contextCompiler,
    model,
    ...(input.recoveryGate ? { recoveryGate: input.recoveryGate } : {}),
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
  emitToolCall?: Readonly<{ rawArguments: string; rawFunctionName: string }>;
  failAfterCompletion?: boolean;
  failAfterChunks?: number;
}) {
  const { chunks, emitToolCall, failAfterCompletion, failAfterChunks } = adapter;
  return createBehaviorAwareConversationTextModel({
    responder: () => chunks,
    ...(emitToolCall ? { emitToolCall } : {}),
    ...(failAfterCompletion ? { failAfterCompletion: true } : {}),
    ...(failAfterChunks === undefined ? {} : { failAfterChunks }),
  });
}
