import {
  createInternalOwnerAccessService,
  createInternalInspectionService,
  createConversationAgentHarness,
  createContextCompiler,
  createContinuousExchangeService,
  createConversationResponseService,
  createJournalEligibilityService,
  createEvidenceService,
  createJournalService,
  createOutboxDispatcherService,
  createUserTextConversationService,
  type JournalEligibilityRepository,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
} from "@sayhear/application";
import {
  createRuntimeProviderEgressPort,
  createRuntimeJournalRoleProviderRegistry,
} from "@sayhear/ai";
import {
  createPostgresPool,
  PostgresContinuousExchangeRepository,
  PostgresConversationResponseRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresInternalInspectionRepository,
  PostgresJournalEligibilityRepository,
  PostgresEvidenceRepository,
  PostgresJournalRepository,
  PostgresOutboxDispatcherRepository,
  PostgresUserTextConversationRepository,
} from "@sayhear/data";

import { createAuthOptions } from "./auth";
import { loadRuntimeConfiguration } from "./runtime-config";
import { createJournalEligibilityWorkflowStarter } from "./workflows/journal-eligibility.workflow";

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
  const journalEligibilityRepository =
    new PostgresJournalEligibilityRepository(pool);
  const journalRoleRegistry = createRuntimeJournalRoleProviderRegistry({
    adapter: configuration.provider.adapter === "deterministic"
      ? { type: "deterministic" }
      : { type: "responses-api", apiKey: configuration.provider.apiKey!, baseUrl: configuration.provider.baseUrl!, timeoutMs: configuration.provider.timeoutMs },
    roles: [
      { role: "evidence.extract", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:evidence`, policyVersion: "evidence-extraction:v2", promptFingerprint: "evidence-extract:spans:v2" },
      { role: "journal.draft", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:journal-draft`, policyVersion: "journal-generation:v2", promptFingerprint: "journal-draft:evidence-only:v2" },
      { role: "journal.validate", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:journal-validate`, policyVersion: "journal-validator:v2", promptFingerprint: "journal-validate:semantic:v2" },
    ],
  });
  const evidenceConfiguration = journalRoleRegistry.configuration("evidence.extract");
  const evidenceRepository = new PostgresEvidenceRepository(pool, journalRoleRegistry.evidenceExtractor);
  const evidenceService = createEvidenceService({
    clock: configuration.clock,
    expectedDataEpoch: configuration.outboxDispatcher.expectedDataEpoch,
    extractionPolicyVersion: evidenceConfiguration.policyVersion,
    champion: {
      configVersion: evidenceConfiguration.configVersion,
      model: evidenceConfiguration.model,
      provider: evidenceConfiguration.provider === "deterministic" ? configuration.provider.champion.provider : evidenceConfiguration.provider,
      providerPolicyVersion: configuration.provider.champion.providerPolicyVersion,
      snapshot: evidenceConfiguration.promptFingerprint,
    },
    repository: evidenceRepository,
  });
  const journalRepository = new PostgresJournalRepository(pool);
  const draftConfiguration = journalRoleRegistry.configuration("journal.draft");
  const validationConfiguration = journalRoleRegistry.configuration("journal.validate");
  const journalService = createJournalService({
    journalPolicyVersion: draftConfiguration.policyVersion,
    validatorVersion: validationConfiguration.policyVersion,
    evidenceExtractionPolicyVersion: evidenceConfiguration.policyVersion,
    generationMetadata: {
      role: "journal.draft",
      provider: draftConfiguration.provider,
      model: draftConfiguration.model,
      configVersion: draftConfiguration.configVersion,
      rolePolicyVersion: draftConfiguration.policyVersion,
      promptFingerprint: draftConfiguration.promptFingerprint,
    },
    validationMetadata: {
      role: "journal.validate",
      provider: validationConfiguration.provider,
      model: validationConfiguration.model,
      configVersion: validationConfiguration.configVersion,
      rolePolicyVersion: validationConfiguration.policyVersion,
      promptFingerprint: validationConfiguration.promptFingerprint,
    },
    validationProvider: journalRoleRegistry.validator,
    model: journalRoleRegistry.draft,
    repository: journalRepository,
  });
  const outboxDispatcherRepository =
    new PostgresOutboxDispatcherRepository(pool);
  const journalEligibilityService = createJournalEligibilityService({
    clock: configuration.clock,
    expectedDataEpoch: configuration.outboxDispatcher.expectedDataEpoch,
    minimumSubstantiveExpressionLength:
      configuration.journalEligibilityPolicy.minimumSubstantiveExpressionLength,
    policyVersion: configuration.journalEligibilityPolicy.version,
    repository: journalEligibilityRepository,
  });
  const outboxDispatcherService = createOutboxDispatcherService({
    clock: configuration.clock,
    leaseDurationMs: configuration.outboxDispatcher.leaseDurationMs,
    leaseOwner: configuration.outboxDispatcher.leaseOwner,
    repository: outboxDispatcherRepository,
    startWorkflow: createJournalEligibilityWorkflowStarter(),
  });
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
      harnessPolicyVersion: INITIAL_CONVERSATION_HARNESS_POLICY.version,
      conversationActionCatalogVersion: EMPTY_CONVERSATION_ACTION_CATALOG.version,
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
    clock: configuration.clock,
    journalEligibilityRepository,
    journalEligibilityService,
    evidenceService,
    journalService,
    journalRepository,
    journalGenerationPolicyVersion: draftConfiguration.policyVersion,
    configurationExpectedDataEpoch: configuration.outboxDispatcher.expectedDataEpoch,
    outboxDispatcherService,
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
