import {
  createInternalOwnerAccessService,
  createInternalInspectionService,
  createConversationAgentHarness,
  createContextCompiler,
  createContinuousExchangeService,
  createConversationResponseService,
  createUserTextConversationService,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
} from "@sayhear/application";
import {
  createRuntimeProviderEgressPort,
} from "@sayhear/ai";
import {
  createPostgresPool,
  PostgresContinuousExchangeRepository,
  PostgresConversationResponseRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresInternalInspectionRepository,
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
  const inspectionRepository = new PostgresInternalInspectionRepository(pool);
  const conversationRepository =
    new PostgresUserTextConversationRepository(pool);
  const responseRepository = new PostgresConversationResponseRepository(pool);
  const continuousExchangeRepository =
    new PostgresContinuousExchangeRepository(pool);
  const conversationService = createUserTextConversationService({
    clock: configuration.clock,
    expectedBackupPolicyVersion: configuration.backupPolicyVersion,
    expectedConfigurationFingerprint:
      configuration.backupConfigurationFingerprint,
    generationPolicy: {
      consentPolicyVersion:
        configuration.provider.champion.consentPolicyVersion,
      freshnessPolicy: "source_valid:v1",
      chineseLocalePackVersion: "locale-pack-zh:v1",
      englishLocalePackVersion: "locale-pack-en:v1",
      harnessPolicyVersion: "conversation-harness:v1",
      conversationActionCatalogVersion: "conversation-action-catalog:empty:v1",
      model: configuration.provider.champion.model,
      modelConfigVersion: configuration.provider.champion.configVersion,
      modelSnapshot: configuration.provider.champion.snapshot,
      outputFormatVersion: "conversation-output:v1",
      personaVersion: "sayhear-persona:v1",
      productPolicyVersion: "product-policy:v1",
      promptVersion: "conversation-text:v1",
      provider: configuration.provider.champion.provider,
      providerPolicyVersion:
        configuration.provider.champion.providerPolicyVersion,
      relationshipPolicyVersion: "relationship-boundary:v1",
      safetyPolicyVersion: "minimum-high-risk-response:v1",
    },
    inactivityPolicy: configuration.inactivityPolicy,
    repository: conversationRepository,
  });
  const contextCompiler = createContextCompiler({
    clock: configuration.clock,
    compilerVersion: "context-compiler:v1",
    contentHmacSecret: configuration.contextHmacSecret,
    rawEventTokenBudget: 4_000,
    repository: responseRepository,
  });
  const egressPort = createRuntimeProviderEgressPort({
    adapter:
      configuration.provider.adapter === "deterministic"
        ? {
            chunks: configuration.provider.deterministicChunks,
            type: "deterministic",
            ...(configuration.provider.failAfterCompletion
              ? { failAfterCompletion: true }
              : {}),
            ...(configuration.provider.failAfterChunks === undefined
              ? {}
              : {
                  failAfterChunks:
                    configuration.provider.failAfterChunks,
                }),
          }
        : {
            apiKey: configuration.provider.apiKey!,
            baseUrl: configuration.provider.baseUrl!,
            timeoutMs: configuration.provider.timeoutMs,
            type: "responses-api",
          },
    champion: configuration.provider.champion,
    clock: configuration.clock,
    contextCompiler,
    repository: responseRepository,
  });
  const conversationAgentHarness = createConversationAgentHarness({
    clock: configuration.clock,
    egressPort,
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
    inspectionService: createInternalInspectionService({
      clock: configuration.clock,
      policyVersion: "sensitive-inspection:v1",
      repository: inspectionRepository,
      stepUpMaxAgeMs: 10 * 60 * 1_000,
    }),
    conversationResponseService: createConversationResponseService({
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: configuration.clock,
      contextCompiler,
      conversationService,
      harness: conversationAgentHarness,
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    }),
    continuousExchangeService: createContinuousExchangeService({
      clock: configuration.clock,
      repository: continuousExchangeRepository,
    }),
    conversationService,
    recoveryScannerSecret: configuration.recoveryScannerSecret,
  };
}
