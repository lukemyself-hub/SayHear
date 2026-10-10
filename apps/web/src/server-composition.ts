import {
  createMemoryRetrievalService,
  createInternalOwnerAccessService,
  createInternalInspectionService,
  createConversationAgentHarness,
  createConversationActionGateway,
  createEntityIdentityCorrectionActionHandler,
  createExplainMemorySourceActionHandler,
  createJournalRegenerationActionHandler,
  createMemoryCorrectionActionHandler,
  createMemoryForgetRequestActionHandler,
  createMemoryForgetReversalActionHandler,
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
  createModelRoleCommandService,
  createModelRoleRegistry,
  createModelRoleProviderEgress,
  createBioInspectionService,
  createReflectionInspectionService,
  createUserTextConversationService,
  type JournalEligibilityRepository,
  MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  planTrustActionTargetResolution,
  RETRIEVAL_BROAD_TERM_STOP_LIST,
  normalizeRetrievalTerm,
  type TrustActionTargetResolver,
  CANONICAL_PERSONA_VERSION,
  CHINESE_LOCALE_PACK_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  ENGLISH_LOCALE_PACK_VERSION,
  FAST_PATH_EXTRACTION_POLICY_VERSION,
  MEMORY_CONSOLIDATION_POLICY_VERSION,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  loadPredicateRegistrySnapshot,
  PREDICATE_REGISTRY_RUNTIME_VERSION,
  RECENT_CONTEXT_DEFAULT_POLICY,
  TIME_AWARE_CONTEXT_COMPILER_VERSION,
  createMemoryConsolidationScanService,
  createEpisodeBuilderScanService,
  createReflectionSchedulerScanService,
  asMemoryCandidateId,
  createMemoryClaimService,
  createCandidateReviewPortalService,
  createCandidateReviewService,
  createPredicateGovernanceService,
  CANDIDATE_REVIEW_POLICY_VERSION,
  type CandidateReviewWorkflowRepository,
  EPISODE_BUILDER_POLICY_VERSION,
  REFLECTION_READINESS_POLICY_VERSION,
  NARRATIVE_VALIDATION_POLICY_VERSION,
  type EpisodeBuildEntrypointDependencies,
  type EpisodeBuildModelProvider,
  type EpisodeBuilderRepository,
  type ReflectionEntrypointDependencies,
  type ReflectionGenerationModelProvider,
  type ReflectionRepository,
  type FastPathExtractionEntrypointDependencies,
  type MemoryConsolidationEntrypointDependencies,
  type NarrativeValidationEntrypointDependencies,
  type NarrativeValidationModelProvider,
  relationshipHintInputsFor,
  retrievalProjectionInputsFor,
} from "@sayhear/application";
import {
  createRuntimeProviderEgressPort,
  createRuntimeJournalRoleProviderRegistry,
  createRuntimeOneA3bRoleProviders,
  type JournalRoleConfiguration,
} from "@sayhear/ai";
import {
  createPostgresPool,
  PostgresContinuousExchangeRepository,
  PostgresConversationResponseRepository,
  PostgresJournalRegenerationActionRepository,
  PostgresMemoryCorrectionFollowupRepository,
  PostgresMemoryTrustActionCommitPort,
  PostgresMemoryTrustActionTargetSource,
  PostgresEntityIdentityCorrectionCommitPort,
  PostgresEntityIdentityCorrectionTargetSource,
  PostgresEntityIdentityRevalidationRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresInternalInspectionRepository,
  PostgresJournalEligibilityRepository,
  PostgresEvidenceRepository,
  PostgresEntityRepository,
  PostgresFastPathExtractionRepository,
  PostgresMemoryConsolidationRepository,
  PostgresMemoryRetrievalRepository,
  PostgresJournalRepository,
  PostgresOutboxDispatcherRepository,
  PostgresOwnerPurgeRepository,
  PostgresPurgeMarkerRepository,
  PostgresUserTextConversationRepository,
  PostgresDialogueStateRepository,
  PostgresRollingSummaryRepository,
  PostgresModelRoleCommandRepository,
  PostgresEpisodeRepository,
  PostgresBioInspectionRepository,
  PostgresReflectionInspectionRepository,
  PostgresEvidenceStepUpRepository,
  PostgresMemoryClaimRepository,
  PostgresCandidateReviewRepository,
  insertCandidateRemapCommandWithin,
  selectPendingRemapCandidates,
  PostgresNarrativeValidationRepository,
  PostgresReflectionRepository,
  PostgresRecentContextPolicyRepository,
  PostgresRecentContextSource,
} from "@sayhear/data";

import { createAuthOptions } from "./auth";
import { loadRuntimeConfiguration } from "./runtime-config";
import { createWorkflowStarter } from "./workflow-starter";

const globalPool = globalThis as typeof globalThis & {
  sayHearPool?: ReturnType<typeof createPostgresPool>;
  sayHearPurgeMarkerPool?: ReturnType<typeof createPostgresPool>;
};

export function createServerComposition() {
  const configuration = loadRuntimeConfiguration(process.env);
  const g1SwitchesEnabled =
    configuration.writeSwitches.episodeBuildEnabled &&
    configuration.writeSwitches.reflectionEnabled;
  const activeG1ReleaseManifest =
    configuration.oneA3bG1.releaseManifest?.status === "active" &&
    g1SwitchesEnabled
      ? configuration.oneA3bG1.releaseManifest
      : null;
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
  const purgeMarkerRepository = new PostgresPurgeMarkerRepository(
    purgeMarkerPool,
    activeG1ReleaseManifest
      ? {
          purgeMarkerMigrations:
            activeG1ReleaseManifest.schema.purgeMarkerMigrations,
          purgeMarkerFingerprint:
            activeG1ReleaseManifest.schema.purgeMarkerFingerprint,
        }
      : undefined,
  );
  const purgeRepository = new PostgresOwnerPurgeRepository(pool);
  const recoveryGate = createRecoveryGate({
    businessStateRepository: accessRepository,
    markerRepository: purgeMarkerRepository,
    purgeStateRepository: purgeRepository,
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
      { role: "memory.extract", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:memory-extract`, policyVersion: "memory-extraction:v1", promptFingerprint: "memory-extract:propose:v4" },
      { role: "entity.resolve", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:entity-resolve`, policyVersion: "entity-resolve-gate:v1", promptFingerprint: "entity-resolve:gate:v2" },
      // Slow-path role (issue #114): daily / weekly consolidation diffs get
      // their own Champion config under the same ADR-0060 / ADR-0061
      // discipline — no implicit cross-role fallback, failures land loudly.
      { role: "memory.consolidate", provider: configuration.provider.adapter === "deterministic" ? "deterministic" : configuration.provider.champion.provider, model: configuration.provider.champion.model, configVersion: `${configuration.provider.champion.configVersion}:memory-consolidate`, policyVersion: "memory-consolidation:v1", promptFingerprint: "memory-consolidate:diffs:v1" },
  ];
  const journalRoleRegistry = createRuntimeJournalRoleProviderRegistry({
    adapter: configuration.provider.adapter === "deterministic"
      ? { type: "deterministic" }
      : configuration.provider.adapter === "opencode-go"
        ? { apiKey: configuration.provider.apiKey!, timeoutMs: configuration.provider.timeoutMs, type: "opencode-go" }
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
  const predicateRegistrySnapshot = loadPredicateRegistrySnapshot(
    PREDICATE_REGISTRY_RUNTIME_VERSION,
  );
  const predicateRegistryLookup = {
    entryFor(predicateId: string) {
      return (
        predicateRegistrySnapshot.entries.find(
          (entry) => entry.predicateId === predicateId,
        ) ?? null
      );
    },
    registryVersion: () => predicateRegistrySnapshot.registryVersion,
    relationshipProjectionsFor(predicateId: string) {
      return predicateRegistrySnapshot.relationshipProjections.filter(
        (projection) => projection.predicateId === predicateId,
      );
    },
    predicateLocalizationsFor(predicateId: string) {
      return predicateRegistrySnapshot.localizations.filter(
        (localization) => localization.predicateId === predicateId,
      );
    },
  };
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
      registry: predicateRegistryLookup,
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
      recoveryGate,
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
      registry: predicateRegistryLookup,
      policy: { version: MEMORY_CONSOLIDATION_POLICY_VERSION },
      dedupeFingerprintSecret: configuration.contextHmacSecret,
      recoveryGate,
      workflowReceiptId,
    };
  };
  const draftConfiguration = journalRoleRegistry.configuration("journal.draft");
  const validationConfiguration = journalRoleRegistry.configuration("journal.validate");
  const journalService = createJournalService({
    cursorSecret: configuration.contextHmacSecret,
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
  // F2 registers the composition seam. G1 only opens the four role
  // configurations frozen by an active release manifest; later roles remain
  // absent from the registry until their own release stage.
  const activeG1Configurations =
    activeG1ReleaseManifest
      ? activeG1ReleaseManifest.roles.configurations
      : [];
  const g1RuntimeProviders =
    activeG1ReleaseManifest
      ? configuration.provider.adapter === "deterministic"
        ? (() => {
            throw new Error(
              "An active 1A.3b G1 manifest cannot open with the deterministic test adapter.",
            );
          })()
        : createRuntimeOneA3bRoleProviders({
            adapters: [
              ...(configuration.provider.roleAdapters.openai
                ? [configuration.provider.roleAdapters.openai]
                : []),
              ...(configuration.provider.roleAdapters.deepseek
                ? [configuration.provider.roleAdapters.deepseek]
                : []),
              ...(configuration.provider.roleAdapters["opencode-go"]
                ? [configuration.provider.roleAdapters["opencode-go"]]
                : []),
            ],
            configurations:
              activeG1ReleaseManifest.roles.configurations,
          })
      : null;
  const modelRoleCommandService = createModelRoleCommandService({
    registry: createModelRoleRegistry(activeG1Configurations),
    repository: new PostgresModelRoleCommandRepository(
      pool,
      activeG1ReleaseManifest
        ? activeG1ReleaseManifest.schema
        : undefined,
      activeG1ReleaseManifest?.fingerprint,
    ),
  });
  const modelRoleProviderEgress = createModelRoleProviderEgress({
    commandService: modelRoleCommandService,
    recoveryGate,
  });
  const episodeBuildProvider: EpisodeBuildModelProvider =
    g1RuntimeProviders?.episodeBuildProvider ?? {
      role: "episode.build",
      async buildProposals() {
        throw new Error(
          "episode.build has no runtime provider; admission stays closed until a release manifest publishes an evaluated config.",
        );
      },
    };
  const episodeRepository = new PostgresEpisodeRepository(pool);
  const episodeBuilderScanService = createEpisodeBuilderScanService({
    clock: configuration.clock,
    policyVersion: EPISODE_BUILDER_POLICY_VERSION,
    repository: episodeRepository,
    enabled: configuration.writeSwitches.episodeBuildEnabled,
  });
  const episodeEntrypointDependencies = (
    workflowReceiptId: string,
  ): EpisodeBuildEntrypointDependencies => ({
    clock: configuration.clock,
    repository: episodeRepository,
    modelRoleCommandService,
    providerEgress: modelRoleProviderEgress,
    episodeBuildProvider: episodeBuildProvider,
    dedupeFingerprintSecret: configuration.contextHmacSecret,
    workflowReceiptId,
  });
  const bioInspectionService = createBioInspectionService({
    repository: new PostgresBioInspectionRepository(pool),
  });
  const reflectionInspectionService = createReflectionInspectionService({
    clock: configuration.clock,
    recoveryGate,
    repository: new PostgresReflectionInspectionRepository(
      pool,
      configuration.contextHmacSecret,
      configuration.clock,
    ),
  });
  const evidenceStepUpRepository = new PostgresEvidenceStepUpRepository(pool);
  const candidateReviewRepository = new PostgresCandidateReviewRepository(
    pool,
    configuration.contextHmacSecret,
  );
  const candidateReviewMemoryClaimService = createMemoryClaimService({
    repository: new PostgresMemoryClaimRepository(pool),
    registry: predicateRegistryLookup,
    clock: configuration.clock,
    dedupeFingerprintSecret: configuration.contextHmacSecret,
  });
  const candidateReviewService = createCandidateReviewService({
    repository: candidateReviewRepository,
    registry: predicateRegistryLookup,
    memoryClaimService: candidateReviewMemoryClaimService,
    clock: configuration.clock,
    dedupeFingerprintSecret: configuration.contextHmacSecret,
  });
  const predicateGovernanceService = createPredicateGovernanceService({
    repository: candidateReviewRepository,
    clock: configuration.clock,
    registryVersion: () => predicateRegistryLookup.registryVersion(),
  });
  const candidateReviewPortalService = createCandidateReviewPortalService({
    repository: candidateReviewRepository,
    clock: configuration.clock,
  });
  const candidateReviewWorkflowRepository: CandidateReviewWorkflowRepository = {
    readRemapCommand: (input) =>
      candidateReviewRepository.readRemapCommand(input),
    completeRemapCommand: (input) =>
      candidateReviewRepository.completeRemapCommand(input),
    selectPendingRemapCandidates: (input) =>
      selectPendingRemapCandidates(pool, {
        policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
        ...(input.registryVersion === undefined
          ? {}
          : { registryVersion: input.registryVersion }),
      }),
    insertRemapCommand: (input) =>
      candidateReviewRepository.insertRemapCommand({
        userId: input.userId,
        candidateId: asMemoryCandidateId(input.memoryCandidateId),
        registryVersion: input.registryVersion,
        policyVersion: input.policyVersion ?? CANDIDATE_REVIEW_POLICY_VERSION,
        now: configuration.clock(),
      }),
  };
  // A2 registers the shared narrative.validate seam without enabling a
  // runtime provider. An evaluated config and active rollout pin are
  // required before a producer workflow can validate a draft (ADR-0121).
  const narrativeValidationProvider: NarrativeValidationModelProvider =
    g1RuntimeProviders?.narrativeValidationProvider ?? {
      role: "narrative.validate",
      async validateNarrative() {
        throw new Error(
          "narrative.validate has no runtime provider; admission stays closed until a release manifest publishes an evaluated config.",
        );
      },
    };
  const narrativeValidationEntrypointDependencies = (
  ): NarrativeValidationEntrypointDependencies => ({
    clock: configuration.clock,
    repository: new PostgresNarrativeValidationRepository(pool),
    modelRoleCommandService,
    providerEgress: modelRoleProviderEgress,
    narrativeValidationProvider,
  });
  // A3 (issue #199): Reflection roles stay closed until a release manifest
  // publishes an evaluated config (ADR-0136 / ADR-0134). The scheduler only
  // runs behind the explicit write switch.
  const reflectionProvider: ReflectionGenerationModelProvider =
    g1RuntimeProviders?.reflectionProvider ?? {
      role: "reflection.daily",
      async generate() {
        throw new Error(
          "reflection.daily/weekly has no runtime provider; admission stays closed until a release manifest publishes an evaluated config.",
        );
      },
    };
  const reflectionRepository = new PostgresReflectionRepository(pool, {
    entryFor: predicateRegistryLookup.entryFor,
    registryVersion: predicateRegistryLookup.registryVersion,
  });
  const reflectionSchedulerScanService = createReflectionSchedulerScanService({
    clock: configuration.clock,
    policyVersion: REFLECTION_READINESS_POLICY_VERSION,
    repository: reflectionRepository,
    enabled: configuration.writeSwitches.reflectionEnabled,
  });
  const reflectionEntrypointDependencies = (
    workflowReceiptId: string,
  ): ReflectionEntrypointDependencies => ({
    clock: configuration.clock,
    repository: reflectionRepository,
    modelRoleCommandService,
    providerEgress: modelRoleProviderEgress,
    reflectionProvider,
    narrativeValidation: narrativeValidationEntrypointDependencies(),
    dedupeFingerprintSecret: configuration.contextHmacSecret,
    workflowReceiptId,
  });
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
      conversationActionCatalogVersion:
        MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG.version,
      model: configuration.provider.champion.model,
      modelConfigVersion: configuration.provider.champion.configVersion,
      modelSnapshot: configuration.provider.champion.snapshot,
      canonicalPersonaVersion: CANONICAL_PERSONA_VERSION,
      outputFormatVersion: "conversation-output:v2",
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
  // #116: the Structured-Lexical retrieval baseline. The registry material
  // is the same released snapshot the admission path pins; the port is wired
  // into the Context Compiler only when the write switch enables the
  // baseline, so a disabled deployment compiles exactly as before.
  const memoryRetrievalPort = configuration.writeSwitches.memoryRetrievalEnabled
    ? createMemoryRetrievalService({
        repository: new PostgresMemoryRetrievalRepository(pool),
        registry: {
          registryVersion: predicateRegistrySnapshot.registryVersion,
          entryFor: predicateRegistryLookup.entryFor,
          localizations: predicateRegistrySnapshot.localizations,
        },
        clock: configuration.clock,
      })
    : undefined;
  const contextCompiler = createContextCompiler({
    clock: configuration.clock,
    compilerVersion: TIME_AWARE_CONTEXT_COMPILER_VERSION,
    contentHmacSecret: configuration.contextHmacSecret,
    rawEventTokenBudget: 4_000,
    // #294: the seven-local-day bounded recent source. It is wired into the
    // real compile/save/replay/egress path; frozen legacy manifests still
    // replay unchanged and a deployment that does not pass this dependency
    // compiles exactly as the pre-#293 compiler (ADR-0149).
    recentContext: {
      policy: RECENT_CONTEXT_DEFAULT_POLICY,
      source: new PostgresRecentContextSource(pool),
    },
    repository: responseRepository,
    ...(memoryRetrievalPort ? { memoryRetrieval: memoryRetrievalPort } : {}),
  });
  // #295: independent, immutable recent-context governance. The compiler reads
  // the active identity inside the same source snapshot; this repository is
  // also the operator enable/disable surface and the effective-config probe.
  const recentContextGovernanceRepository =
    new PostgresRecentContextPolicyRepository(pool);
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
        : configuration.provider.adapter === "opencode-go"
          ? {
              apiKey: configuration.provider.apiKey!,
              timeoutMs: configuration.provider.timeoutMs,
              type: "opencode-go",
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
  // #119: the trust-action commit port and the admission-time target
  // resolver (ADR-0118). The resolver runs the bounded owner-scoped
  // structured-lexical search over active Claims and classifies with the
  // pure planner; registry lexical surfaces come from the same released
  // snapshot the retrieval baseline pins.
  const memoryTrustActionProjectionProvider = {
    relationshipHintsFor(predicateId: string) {
      const entry = predicateRegistryLookup.entryFor(predicateId);
      return entry
        ? relationshipHintInputsFor(predicateRegistryLookup, entry)
        : null;
    },
    retrievalProjectionFor(predicateId: string) {
      const entry = predicateRegistryLookup.entryFor(predicateId);
      return entry
        ? retrievalProjectionInputsFor(predicateRegistryLookup, entry)
        : null;
    },
  };
  const memoryTrustActionCommitPort = new PostgresMemoryTrustActionCommitPort(
    memoryTrustActionProjectionProvider,
  );
  const memoryCorrectionFollowupRepository =
    new PostgresMemoryCorrectionFollowupRepository(pool);
  const entityIdentityCorrectionCommitPort =
    new PostgresEntityIdentityCorrectionCommitPort();
  const entityIdentityCorrectionTargetSource =
    new PostgresEntityIdentityCorrectionTargetSource(pool);
  const entityIdentityRevalidationRepository =
    new PostgresEntityIdentityRevalidationRepository(
      pool,
      memoryTrustActionProjectionProvider,
    );
  const memoryTrustActionTargetSource = new PostgresMemoryTrustActionTargetSource(
    pool,
  );
  const trustActionPredicateSurfaces = new Map(
    predicateRegistrySnapshot.localizations
      .flatMap((localization) =>
        localization.lexicalSurfaces.map((surface) => ({
          predicateId: localization.predicateId,
          surface: normalizeRetrievalTerm(surface.text),
        })),
      )
      .reduce((byePredicate, entry) => {
        const existing = byePredicate.get(entry.predicateId) ?? [];
        byePredicate.set(entry.predicateId, [...existing, entry.surface]);
        return byePredicate;
      }, new Map<string, readonly string[]>()),
  );
  const trustActionTargetResolver: TrustActionTargetResolver = {
    async resolve({ actionKind, anchor, userId }) {
      if (
        actionKind !== "memory_correction" &&
        actionKind !== "explain_memory_source" &&
        actionKind !== "memory_forget_request" &&
        actionKind !== "memory_forget_reversal"
      ) {
        throw new Error(
          `No trust-action search space is defined for kind "${actionKind}".`,
        );
      }
      // ADR-0118: each action owns an explicit search space. Forget targets
      // include already-fenced items so repeated Forget converges honestly;
      // Reversal sees only the still-fenced set.
      const [candidates, labelIndex] = await Promise.all([
        memoryTrustActionTargetSource.listResolutionCandidates({
          limit: 100,
          searchSpace:
            actionKind === "memory_correction"
              ? "active_and_corrected"
              : actionKind === "explain_memory_source"
                ? "active_claims"
                : actionKind === "memory_forget_reversal"
                  ? "fenced_targets"
                  : "forget_targets",
          userId,
        }),
        memoryTrustActionTargetSource.listLabelIndex({ userId }),
      ]);
      const plan = planTrustActionTargetResolution({
        anchor,
        broadTerms: RETRIEVAL_BROAD_TERM_STOP_LIST,
        candidates: candidates.map((candidate) => ({
          ...candidate,
          predicateSurfaces:
            trustActionPredicateSurfaces.get(candidate.predicateId) ?? [],
        })),
        labelIndex,
      });
      if (plan.outcome === "unique") {
        return { outcome: "unique", target: plan.target };
      }
      if (plan.outcome === "multi_hit") {
        return {
          candidateCount: plan.candidateCount,
          outcome: "multi_hit",
        };
      }
      if (plan.outcome === "scope_ambiguous") {
        return { outcome: "scope_ambiguous" };
      }
      return { outcome: "zero_hit" };
    },
  };
  const actionGateway = createConversationActionGateway({
    handlers: [
      createJournalRegenerationActionHandler({
        generationPolicyVersion: draftConfiguration.policyVersion,
      }),
      createMemoryCorrectionActionHandler({
        commitPort: memoryTrustActionCommitPort,
      }),
      createExplainMemorySourceActionHandler({
        commitPort: memoryTrustActionCommitPort,
      }),
      createMemoryForgetRequestActionHandler({
        commitPort: memoryTrustActionCommitPort,
      }),
      createMemoryForgetReversalActionHandler({
        commitPort: memoryTrustActionCommitPort,
      }),
      createEntityIdentityCorrectionActionHandler({
        commitPort: entityIdentityCorrectionCommitPort,
      }),
    ],
    repository: actionRepository,
    entityIdentityCorrectionTargetResolver:
      entityIdentityCorrectionTargetSource,
    trustActionTargetResolver,
  });
  const conversationAgentHarness = createConversationAgentHarness({
    actionGateway,
    clock: configuration.clock,
    egressPort,
    contextCompiler,
    onUnexpectedFailure: (failure) => {
      console.error("conversation_decision_unexpected_failure", failure);
    },
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
      repository: purgeRepository,
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
      repository: purgeRepository,
    }),
    outboxDispatcherService,
    modelRoleCommandService,
    bioInspectionService,
    reflectionInspectionService,
    evidenceStepUpRepository,
    inspectionService: createInternalInspectionService({
      clock: configuration.clock,
      policyVersion: "sensitive-inspection:v1",
      recoveryGate,
      repository: inspectionRepository,
      stepUpMaxAgeMs: 10 * 60 * 1_000,
    }),
    conversationResponseService: createConversationResponseService({
      catalog: MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
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
    memoryCorrectionFollowupRepository,
    entityIdentityRevalidationRepository,
    fastPathExtractionService,
    fastPathExtractionEntrypointDependencies,
    memoryConsolidationRepository,
    memoryConsolidationService,
    memoryConsolidationEntrypointDependencies,
    candidateReviewRepository,
    candidateReviewService,
    candidateReviewPortalService,
    predicateGovernanceService,
    candidateReviewWorkflowRepository,
    episodeRepository,
    episodeBuilderScanService,
    episodeEntrypointDependencies,
    episodeBuilderPolicyVersion: EPISODE_BUILDER_POLICY_VERSION,
    episodeBuildProvider,
    reflectionRepository,
    reflectionSchedulerScanService,
    reflectionEntrypointDependencies,
    reflectionReadinessPolicyVersion: REFLECTION_READINESS_POLICY_VERSION,
    narrativeValidationEntrypointDependencies,
    oneA3bG1ReleaseManifest: configuration.oneA3bG1.releaseManifest,
    dedupeFingerprintSecret: configuration.contextHmacSecret,
    recentContextGovernanceRepository,
    recoveryScannerSecret: configuration.recoveryScannerSecret,
  };
}
