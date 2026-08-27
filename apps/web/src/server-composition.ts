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
  createEntityService,
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
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  CANONICAL_PERSONA_VERSION,
  CHINESE_LOCALE_PACK_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  ENGLISH_LOCALE_PACK_VERSION,
  FAST_PATH_EXTRACTION_POLICY_VERSION,
  MEMORY_CONSOLIDATION_POLICY_VERSION,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  loadPredicateRegistrySnapshot,
  createMemoryConsolidationScanService,
  type FastPathExtractionEntrypointDependencies,
  type MemoryConsolidationEntrypointDependencies,
} from "@sayhear/application";
import {
  createRuntimeProviderEgressPort,
  createRuntimeJournalRoleProviderRegistry,
  type JournalRoleConfiguration,
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
  PostgresEntityRepository,
  PostgresFastPathExtractionRepository,
  PostgresMemoryConsolidationRepository,
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
  const roles: readonly JournalRoleConfiguration[] = [
      { role: "evidence.extract", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:evidence`, policyVersion: "evidence-extraction:v2", promptFingerprint: "evidence-extract:spans:v2" },
      { role: "journal.draft", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:journal-draft`, policyVersion: "journal-generation:v2", promptFingerprint: "journal-draft:evidence-only:v2" },
      { role: "journal.validate", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:journal-validate`, policyVersion: "journal-validator:v3", promptFingerprint: "journal-validate:diagnostic:v3" },
      { role: "dialogue.state", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: "dialogue-state-model:v1", policyVersion: "dialogue-state:v2", promptFingerprint: "dialogue-state-prompt:v2" },
      { role: "summary.compress", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:summary`, policyVersion: "rolling-summary:v1", promptFingerprint: "rolling-summary:neutral-structured:v1" },
      // Memory roles (issue #113): their own Champion configs, independently
      // versioned, fallback disabled until a fallback Champion is explicitly
      // published per ADR-0060 / ADR-0061.
      { role: "memory.extract", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:memory-extract`, policyVersion: "memory-extraction:v1", promptFingerprint: "memory-extract:propose:v1" },
      { role: "entity.resolve", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:entity-resolve`, policyVersion: "entity-resolve-gate:v1", promptFingerprint: "entity-resolve:gate:v1" },
      // Slow-path role (issue #114): daily / weekly consolidation diffs get
      // their own Champion config under the same ADR-0060 / ADR-0061
      // discipline — no implicit cross-role fallback, failures land loudly.
      { role: "memory.consolidate", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:memory-consolidate`, policyVersion: "memory-consolidation:v1", promptFingerprint: "memory-consolidate:diffs:v1" },
  ];
  const journalRoleRegistry = createRuntimeJournalRoleProviderRegistry({
    adapter: configuration.provider.adapter === "deterministic"
      ? { type: "deterministic" }
      : { type: "responses-api", apiKey: configuration.provider.apiKey!, baseUrl: configuration.provider.baseUrl!, timeoutMs: configuration.provider.timeoutMs },
    roles,
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
  const entityRepository = new PostgresEntityRepository(pool);
  const entityService = createEntityService({
    repository: entityRepository,
    clock: configuration.clock,
  });
  const fastPathExtractionRepository =
    new PostgresFastPathExtractionRepository(pool);
  const predicateRegistrySnapshot = loadPredicateRegistrySnapshot(1);
  const memoryExtractConfiguration =
    journalRoleRegistry.configuration("memory.extract");
  const entityResolveConfiguration =
    journalRoleRegistry.configuration("entity.resolve");
  const fastPathPolicyPromise = fastPathExtractionRepository.loadPolicy(
    FAST_PATH_EXTRACTION_POLICY_VERSION,
  );
  const fastPathExtractionService = {
    async resolvePolicyForStep() {
      const policy = await fastPathPolicyPromise;
      if (!policy) {
        throw new Error("Fast path extraction policy is unavailable or has drifted.");
      }
      return {
        policyVersion: policy.version,
        visibilityTargetMs: policy.visibilityTargetMs,
        maxBatchRevisions: policy.maxBatchRevisions,
        tAuto: policy.tAuto,
        maxCandidates: policy.maxCandidates,
      };
    },
  };
  const fastPathExtractionEntrypointDependencies = async (
    workflowReceiptId: string,
  ): Promise<FastPathExtractionEntrypointDependencies> => {
    const policy = await fastPathExtractionService.resolvePolicyForStep();
    return {
      clock: configuration.clock,
      repository: fastPathExtractionRepository,
      entityService,
      entityRepository,
      memoryExtract: journalRoleRegistry.memoryExtractor,
      entityResolve: journalRoleRegistry.entityResolver,
      registry: {
        entryFor(predicateId) {
          return (
            predicateRegistrySnapshot.entries.find(
              (entry) => entry.predicateId === predicateId,
            ) ?? null
          );
        },
        registryVersion: () => predicateRegistrySnapshot.registryVersion,
      },
      policy: {
        version: policy.policyVersion,
        visibilityTargetMs: policy.visibilityTargetMs,
        maxBatchRevisions: policy.maxBatchRevisions,
        tAuto: policy.tAuto,
        maxCandidates: policy.maxCandidates,
      },
      memoryExtractConfiguration: {
        role: "memory.extract",
        configVersion: memoryExtractConfiguration.configVersion,
        modelVersion: memoryExtractConfiguration.model,
        promptVersion: memoryExtractConfiguration.promptFingerprint,
        // ADR-0060: explicit per-role fallback only; disabled until a fallback
        // Champion is published. A failed role fails loudly.
        fallback: { mode: "disabled" },
      },
      entityResolveConfiguration: {
        role: "entity.resolve",
        configVersion: entityResolveConfiguration.configVersion,
        modelVersion: entityResolveConfiguration.model,
        promptVersion: entityResolveConfiguration.promptFingerprint,
        fallback: { mode: "disabled" },
      },
      evidenceChampion: {
        provider:
          memoryExtractConfiguration.provider === "deterministic"
            ? configuration.provider.champion.provider
            : memoryExtractConfiguration.provider,
        model: memoryExtractConfiguration.model,
        configVersion: memoryExtractConfiguration.configVersion,
        snapshot: memoryExtractConfiguration.promptFingerprint,
        providerPolicyVersion:
          configuration.provider.champion.providerPolicyVersion,
      },
      dedupeFingerprintSecret: configuration.contextHmacSecret,
      workflowReceiptId,
    };
  };
  const memoryConsolidationRepository =
    new PostgresMemoryConsolidationRepository(pool);
  const memoryConsolidateConfiguration =
    journalRoleRegistry.configuration("memory.consolidate");
  const memoryConsolidationService = createMemoryConsolidationScanService({
    clock: configuration.clock,
    policyVersion: MEMORY_CONSOLIDATION_POLICY_VERSION,
    repository: memoryConsolidationRepository,
    enabled: configuration.writeSwitches.memoryConsolidationEnabled,
  });
  const memoryConsolidationEntrypointDependencies = async (
    workflowReceiptId: string,
  ): Promise<MemoryConsolidationEntrypointDependencies> => {
    return {
      clock: configuration.clock,
      repository: memoryConsolidationRepository,
      memoryConsolidate: journalRoleRegistry.memoryConsolidator,
      memoryConsolidateConfiguration: {
        role: "memory.consolidate",
        configVersion: memoryConsolidateConfiguration.configVersion,
        modelVersion: memoryConsolidateConfiguration.model,
        promptVersion: memoryConsolidateConfiguration.promptFingerprint,
        // ADR-0060: explicit per-role fallback only; disabled until a fallback
        // Champion is published. A failed role fails loudly.
        fallback: { mode: "disabled" },
      },
      registry: {
        entryFor(predicateId) {
          return (
            predicateRegistrySnapshot.entries.find(
              (entry) => entry.predicateId === predicateId,
            ) ?? null
          );
        },
        registryVersion: () => predicateRegistrySnapshot.registryVersion,
      },
      policy: { version: MEMORY_CONSOLIDATION_POLICY_VERSION },
      dedupeFingerprintSecret: configuration.contextHmacSecret,
      workflowReceiptId,
    };
  };
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
    fastPathExtractionPolicyVersion:
      configuration.writeSwitches.fastPathExtractionEnabled
        ? FAST_PATH_EXTRACTION_POLICY_VERSION
        : null,
    generationPolicy: {
      consentPolicyVersion:
        configuration.provider.champion.consentPolicyVersion,
      freshnessPolicy: "source_valid:v1",
      chineseLocalePackVersion: CHINESE_LOCALE_PACK_VERSION,
      englishLocalePackVersion: ENGLISH_LOCALE_PACK_VERSION,
      harnessPolicyVersion: CATALOG_V2_CONVERSATION_HARNESS_POLICY.version,
      conversationActionCatalogVersion: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
      model: configuration.provider.champion.model,
      modelConfigVersion: configuration.provider.champion.configVersion,
      modelSnapshot: configuration.provider.champion.snapshot,
      canonicalPersonaVersion: CANONICAL_PERSONA_VERSION,
      outputFormatVersion: "conversation-output:v1",
      personaBehaviorAnchorsVersion: PERSONA_BEHAVIOR_ANCHORS_VERSION,
      personaContractInvariantVersion: PERSONA_CONTRACT_INVARIANT_VERSION,
      productPolicyVersion: "product-policy:v1",
      taskInstructionVersion: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
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
    handlers: [
      createJournalRegenerationActionHandler({
        generationPolicyVersion: draftConfiguration.policyVersion,
      }),
    ],
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
      harnessPolicy: CATALOG_V2_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
      recoveryGate,
    }),
    continuousExchangeService: createContinuousExchangeService({
      clock: configuration.clock,
      repository: continuousExchangeRepository,
    }),
    conversationService,
    entityService,
    fastPathExtractionRepository,
    fastPathExtractionService,
    fastPathExtractionEntrypointDependencies,
    memoryConsolidationRepository,
    memoryConsolidationService,
    memoryConsolidationEntrypointDependencies,
    recoveryScannerSecret: configuration.recoveryScannerSecret,
  };
}
