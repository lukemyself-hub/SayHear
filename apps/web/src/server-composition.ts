import {
  createInternalOwnerAccessService,
  createContextCompiler,
  createConversationResponseService,
  createUserTextConversationService,
} from "@sayhear/application";
import {
  createDeterministicConversationTextModel,
  createOpenAIConversationTextModel,
  createProviderEgressPort,
} from "@sayhear/ai";
import {
  createPostgresPool,
  PostgresConversationResponseRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresUserTextConversationRepository,
} from "@sayhear/data";

import { createAuthOptions } from "./auth";
import { loadRuntimeConfiguration } from "./runtime-config";

const globalPool = globalThis as typeof globalThis & {
  sayHearPool?: ReturnType<typeof createPostgresPool>;
};

export function createServerComposition() {
  const configuration = loadRuntimeConfiguration(process.env);
  const pool =
    globalPool.sayHearPool ??
    createPostgresPool({
      applicationName: "sayhear-web",
      connectionString: configuration.databaseUrl,
    });

  globalPool.sayHearPool = pool;

  const accessRepository = new PostgresInternalOwnerAccessRepository(pool);
  const conversationRepository =
    new PostgresUserTextConversationRepository(pool);
  const responseRepository = new PostgresConversationResponseRepository(pool);
  const conversationService = createUserTextConversationService({
    clock: configuration.clock,
    expectedBackupPolicyVersion: configuration.backupPolicyVersion,
    expectedConfigurationFingerprint:
      configuration.backupConfigurationFingerprint,
    generationPolicy: {
      freshnessPolicy: "source_valid:v1",
      localePolicyVersion: "locale-pack:v1",
      model: configuration.provider.champion.model,
      modelConfigVersion: configuration.provider.champion.configVersion,
      modelSnapshot: configuration.provider.champion.snapshot,
      productPolicyVersion: "product-policy:v1",
      promptVersion: "conversation-text:v1",
      provider: configuration.provider.champion.provider,
      relationshipPolicyVersion: "relationship-boundary:v1",
      safetyPolicyVersion: "minimum-high-risk-response:v1",
    },
    repository: conversationRepository,
  });
  const conversationTextModel =
    configuration.provider.adapter === "deterministic"
      ? createDeterministicConversationTextModel({
          chunks: configuration.provider.deterministicChunks,
          ...(configuration.provider.failAfterChunks === undefined
            ? {}
            : {
                failAfterChunks: configuration.provider.failAfterChunks,
              }),
        })
      : createOpenAIConversationTextModel({
          apiKey: configuration.provider.apiKey!,
          timeoutMs: configuration.provider.timeoutMs,
        });
  const contextCompiler = createContextCompiler({
    clock: configuration.clock,
    compilerVersion: "context-compiler:v1",
    contentHmacSecret: configuration.contextHmacSecret,
    rawEventTokenBudget: 4_000,
    repository: responseRepository,
  });
  const egressPort = createProviderEgressPort({
    champion: configuration.provider.champion,
    clock: configuration.clock,
    model: conversationTextModel,
    repository: responseRepository,
  });
  return {
    accessService: createInternalOwnerAccessService({
      clock: configuration.clock,
      expectedBackupPolicyVersion: configuration.backupPolicyVersion,
      expectedConfigurationFingerprint:
        configuration.backupConfigurationFingerprint,
      repository: accessRepository,
    }),
    authOptions: createAuthOptions({ configuration, pool }),
    conversationResponseService: createConversationResponseService({
      clock: configuration.clock,
      contextCompiler,
      conversationService,
      egressPort,
      repository: responseRepository,
    }),
    conversationService,
  };
}
