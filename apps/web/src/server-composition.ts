import {
  createInternalOwnerAccessService,
  createInternalInspectionService,
  createConversationAgentHarness,
  createConversationActionGateway,
  createJournalRegenerationActionHandler,
  createContextCompiler,
  createContinuousExchangeService,
  createConversationResponseService,
  createJournalEligibilityService,
  createDialogueStateService,
  createEvidenceService,
  createJournalService,
  createOwnerFullPurgeService,
  createRecoveryGate,
  createRecoveryReapplyService,
  createRollingSummaryService,
  createOutboxDispatcherService,
  createUserTextConversationService,
  type JournalEligibilityRepository,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
  ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
} from "@sayhear/application";
import {
  createRuntimeProviderEgressPort,
  createRuntimeJournalRoleProviderRegistry,
} from "@sayhear/ai";
import {
  createPostgresPool,
  PostgresContinuousExchangeRepository,
  PostgresConversationResponseRepository,
  PostgresJournalRegenerationActionRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresInternalInspectionRepository,
  PostgresJournalEligibilityRepository,
  PostgresEvidenceRepository,
  PostgresJournalRepository,
  PostgresOutboxDispatcherRepository,
  PostgresOwnerPurgeRepository,
  PostgresPurgeMarkerRepository,
  PostgresUserTextConversationRepository,
  PostgresDialogueStateRepository,
  PostgresRollingSummaryRepository,
} from "@sayhear/data";

import { createAuthOptions } from "./auth";
import { loadRuntimeConfiguration } from "./runtime-config";
import { createWorkflowStarter } from "./workflows/rolling-summary.workflow";

const globalPool = globalThis as typeof globalThis & {
  sayHearPool?: ReturnType<typeof createPostgresPool>;
  sayHearPurgeMarkerPool?: ReturnType<typeof createPostgresPool>;
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

  // The purge marker store is a separate database outside the business backup
  // domain (issue #27, architecture 20.6); validated at startup that it never
  // equals DATABASE_URL.
  const purgeMarkerPool =
    globalPool.sayHearPurgeMarkerPool ??
    createPostgresPool({
      applicationName: "sayhear-purge-marker",
      connectionString: configuration.ownerPurge.markerDatabaseUrl,
    });
  globalPool.sayHearPurgeMarkerPool = purgeMarkerPool;

  const accessRepository = new PostgresInternalOwnerAccessRepository(pool);
  const purgeMarkerRepository = new PostgresPurgeMarkerRepository(purgeMarkerPool);
  const recoveryGate = createRecoveryGate({
    businessStateRepository: accessRepository,
    markerRepository: purgeMarkerRepository,
  });
  const inspectionRepository = new PostgresInternalInspectionRepository(pool);
  const conversationRepository =
    new PostgresUserTextConversationRepository(pool);
  const responseRepository = new PostgresConversationResponseRepository(pool);
  const actionRepository = new PostgresJournalRegenerationActionRepository(
    pool,
    configuration.contextHmacSecret,
  );
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
      { role: "journal.validate", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:journal-validate`, policyVersion: "journal-validator:v3", promptFingerprint: "journal-validate:diagnostic:v3" },
      { role: "dialogue.state", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: "dialogue-state-model:v1", policyVersion: "dialogue-state:v1", promptFingerprint: "dialogue-state-prompt:v1" },
      { role: "summary.compress", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:summary`, policyVersion: "rolling-summary:v1", promptFingerprint: "rolling-summary:neutral-structured:v1" },
    ],
  });
  const evidenceConfiguration = journalRoleRegistry.configuration("evidence.extract");
  const evidenceRepository = new PostgresEvidenceRepository(pool, journalRoleRegistry.evidenceExtractor);
  const evidenceService = createEvidenceService({
    clock: configuration.clock,
    extractionPolicyVersion: evidenceConfiguration.policyVersion,
    champion: {
      configVersion: evidenceConfiguration.configVersion,
      model: evidenceConfiguration.model,
      provider: evidenceConfiguration.provider === "deterministic" ? configuration.provider.champion.provider : evidenceConfiguration.provider,
      providerPolicyVersion: configuration.provider.champion.providerPolicyVersion,
      snapshot: evidenceConfiguration.promptFingerprint,
    },
    repository: evidenceRepository,
    recoveryGate,
    writesEnabled: configuration.writeSwitches.evidenceExtractionEnabled,
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
    recoveryGate,
    repository: journalRepository,
    publishingEnabled: configuration.writeSwitches.journalPublishEnabled,
  });
  const outboxDispatcherRepository =
    new PostgresOutboxDispatcherRepository(pool);
  const dialogueStateConfiguration = journalRoleRegistry.configuration("dialogue.state");
  const dialogueStateService = createDialogueStateService({
    clock: configuration.clock,
    model: journalRoleRegistry.dialogueStateProjector,
    policy: {
      modelConfigVersion: dialogueStateConfiguration.configVersion,
      policyVersion: dialogueStateConfiguration.policyVersion,
      promptVersion: dialogueStateConfiguration.promptFingerprint,
    },
    repository: new PostgresDialogueStateRepository(pool),
    recoveryGate,
  });
  const rollingSummaryService = createRollingSummaryService({
    clock: configuration.clock,
    model: journalRoleRegistry.summaryCompressor,
    modelConfigVersion: journalRoleRegistry.configuration("summary.compress").configVersion,
    policyVersion: journalRoleRegistry.configuration("summary.compress").policyVersion,
    promptVersion: journalRoleRegistry.configuration("summary.compress").promptFingerprint,
    repository: new PostgresRollingSummaryRepository(pool),
    recoveryGate,
  });
  const journalEligibilityService = createJournalEligibilityService({
    clock: configuration.clock,
    minimumSubstantiveExpressionLength:
      configuration.journalEligibilityPolicy.minimumSubstantiveExpressionLength,
    policyVersion: configuration.journalEligibilityPolicy.version,
    repository: journalEligibilityRepository,
    recoveryGate,
  });
  const outboxDispatcherService = createOutboxDispatcherService({
    clock: configuration.clock,
    leaseDurationMs: configuration.outboxDispatcher.leaseDurationMs,
    leaseOwner: configuration.outboxDispatcher.leaseOwner,
    repository: outboxDispatcherRepository,
    startWorkflow: createWorkflowStarter(),
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
      harnessPolicyVersion: ACTION_ENABLED_CONVERSATION_HARNESS_POLICY.version,
      conversationActionCatalogVersion: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
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
    recoveryGate,
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
    recoveryGate,
    repository: responseRepository,
  });
  const actionGateway = createConversationActionGateway({
    handler: createJournalRegenerationActionHandler({
      generationPolicyVersion: draftConfiguration.policyVersion,
    }),
    repository: actionRepository,
  });
  const conversationAgentHarness = createConversationAgentHarness({
    actionGateway,
    clock: configuration.clock,
    egressPort,
    contextCompiler,
    repository: responseRepository,
  });
  return {
    accessService: createInternalOwnerAccessService({
      clock: configuration.clock,
      expectedBackupPolicyVersion: configuration.backupPolicyVersion,
      expectedConfigurationFingerprint:
        configuration.backupConfigurationFingerprint,
      recoveryGate,
      repository: accessRepository,
    }),
    ownerPurgeService: createOwnerFullPurgeService({
      clock: configuration.clock,
      // Best-effort durable-workflow cancellation via the public SDK
      // (`getRun(...).cancel()`); correctness never depends on it — the epoch
      // fences, revoked egress authorization, and cancelled commands own the
      // guarantees (issue #27 settled decisions).
      cancelWorkflows: async (workflowReceiptIds) => {
        try {
          const { getRun } = await import("workflow/api");
          for (const workflowReceiptId of workflowReceiptIds) {
            try {
              await getRun(workflowReceiptId).cancel();
            } catch {
              // Best-effort per run; a receipt without a live run is fine.
            }
          }
        } catch {
          // The SDK being unavailable in this environment is not fatal.
        }
      },
      markerRepository: purgeMarkerRepository,
      providerRetentionDays: configuration.ownerPurge.providerRetentionDays,
      repository: new PostgresOwnerPurgeRepository(pool),
    }),
    authOptions: createAuthOptions({ configuration, pool }),
    clock: configuration.clock,
    journalEligibilityRepository,
    actionRepository,
    actionGateway,
    rollingSummaryService,
    journalEligibilityService,
    dialogueStateService,
    evidenceService,
    journalService,
    journalRepository,
    journalGenerationPolicyVersion: draftConfiguration.policyVersion,
    recoveryGate,
    recoveryReapplyService: createRecoveryReapplyService({
      clock: configuration.clock,
      gate: recoveryGate,
      markerRepository: purgeMarkerRepository,
      repository: new PostgresOwnerPurgeRepository(pool),
    }),
    outboxDispatcherService,
    inspectionService: createInternalInspectionService({
      clock: configuration.clock,
      policyVersion: "sensitive-inspection:v1",
      recoveryGate,
      repository: inspectionRepository,
      stepUpMaxAgeMs: 10 * 60 * 1_000,
    }),
    conversationResponseService: createConversationResponseService({
      catalog: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
      actionGateway,
      clock: configuration.clock,
      contextCompiler,
      conversationService,
      harness: conversationAgentHarness,
      harnessPolicy: ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
      recoveryGate,
    }),
    continuousExchangeService: createContinuousExchangeService({
      clock: configuration.clock,
      repository: continuousExchangeRepository,
    }),
    conversationService,
    recoveryScannerSecret: configuration.recoveryScannerSecret,
  };
}
