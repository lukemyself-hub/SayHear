import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  asGenerationCommandId,
  createConversationAgentHarness,
  createContextCompiler,
  createConversationResponseService,
  createContinuousExchangeService,
  createInternalInspectionService,
  createMemoryRetrievalService,
  createEntityService,
  createMemoryClaimService,
  createUserTextConversationService,
  loadPredicateRegistrySnapshot,
  type GenerationInspectionMetadata,
  type RetrievalTestSupportConfiguration,
} from "@sayhear/application";
import {
  PostgresContinuousExchangeRepository,
  PostgresConversationResponseRepository,
  PostgresEntityRepository,
  PostgresInternalInspectionRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresMemoryClaimRepository,
  PostgresMemoryRetrievalRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createDeterministicConversationTextModel,
  createProviderEgressPort,
} from "@sayhear/ai/testing";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

import { parseMemorySectionItems } from "../../apps/web/app/internal/context-inspector-data";

/**
 * Context Inspector retrieval panel (issue #122, SPEC #107 "Context Inspector
 * extension", ADR-0115), proven through the authenticated internal text
 * conversation seam and the real read-only inspection path. The panel reads
 * the same truth the model received: the injected items come from the
 * CompiledContext memory sections themselves, the candidate funnel and
 * timings from the retrieval run ledger, and no "selected but not injected"
 * state exists — every selected candidate is backed by an injected item, and
 * every injected item is backed by a recorded selection (AC 33, story 51).
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const BASE_TIME = new Date("2026-08-27T08:00:00.000Z").getTime();

let clockNowMs = BASE_TIME;
const clock = () => new Date(clockNowMs);
const advanceMs = (ms: number) => {
  clockNowMs += ms;
};

const generationPolicy = Object.freeze({
  consentPolicyVersion: null,
  freshnessPolicy: "source_valid:v1" as const,
  chineseLocalePackVersion: "locale-pack-zh:v1",
  englishLocalePackVersion: "locale-pack-en:v1",
  harnessPolicyVersion: INITIAL_CONVERSATION_HARNESS_POLICY.version,
  conversationActionCatalogVersion: EMPTY_CONVERSATION_ACTION_CATALOG.version,
  model: "gpt-5.4",
  modelConfigVersion: "conversation-text-champion:v1",
  modelSnapshot: "gpt-5.4",
  outputFormatVersion: "conversation-output:v1",
  canonicalPersonaVersion: "canonical-persona:v1",
  personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
  personaContractInvariantVersion: "persona-contract-invariant:v1",
  productPolicyVersion: "product-policy:v1",
  taskInstructionVersion: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
});

const testChampion = Object.freeze({
  configVersion: "conversation-text-champion:v1",
  consentPolicyVersion: null,
  contextLimit: 1_000_000,
  dataRegion: "test",
  model: "gpt-5.4",
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  retentionMode: "store-disabled",
  snapshot: "gpt-5.4",
  streaming: true as const,
  supportedLocales: Object.freeze(["en", "zh"]),
  trainingPolicy: "test",
});

const registrySnapshot = loadPredicateRegistrySnapshot(1);

function createTestUuidV7(now: Date): string {
  const bytes = randomBytes(16);
  let timestamp = now.getTime();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xff);
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

describe("Context Inspector retrieval panel system seam (#122)", () => {
  let database: IsolatedPostgresSchema;
  let claimService: ReturnType<typeof createMemoryClaimService>;
  let conversationService: ReturnType<typeof createUserTextConversationService>;
  let responseRepository: PostgresConversationResponseRepository;
  let quiesceActiveSession: () => Promise<number>;
  let submitCount = 0;
  let respondCount = 0;
  let retrievalFaults: RetrievalTestSupportConfiguration | null = null;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(database.pool).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "inspector-retrieval-test-owner",
      userId: OWNER,
    });
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: "sha256:expected",
      databaseRetentionDays: 30,
      evidenceReference: "synthetic backup evidence",
      policyVersion: "neon-production-v1",
      pitrRetentionDays: 7,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2027-08-27T00:00:00.000Z"),
      verifiedAt: new Date("2026-08-13T00:00:00.000Z"),
    });

    claimService = createMemoryClaimService({
      repository: new PostgresMemoryClaimRepository(database.pool),
      registry: {
        entryFor(predicateId) {
          return (
            registrySnapshot.entries.find(
              (entry) => entry.predicateId === predicateId,
            ) ?? null
          );
        },
        registryVersion: () => registrySnapshot.registryVersion,
        relationshipProjectionsFor(predicateId) {
          return registrySnapshot.relationshipProjections.filter(
            (projection) => projection.predicateId === predicateId,
          );
        },
        predicateLocalizationsFor(predicateId) {
          return registrySnapshot.localizations.filter(
            (localization) => localization.predicateId === predicateId,
          );
        },
      },
      clock,
      dedupeFingerprintSecret: "system-test-secret",
    });
    conversationService = createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy,
      inactivityPolicy: {
        timeoutMs: 1_800_000,
        version: "continuous-exchange-inactivity:v1",
      },
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    responseRepository = new PostgresConversationResponseRepository(database.pool);
    const continuousExchangeService = createContinuousExchangeService({
      clock,
      repository: new PostgresContinuousExchangeRepository(database.pool),
    });
    quiesceActiveSession = async () =>
      (await continuousExchangeService.scanDueInactivity()).applied;
  }, 20_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME;
    retrievalFaults = null;
    // Migrations from concurrently developed branches may add tables that
    // reference the truncated set (e.g. the #119 trust-action face); include
    // them only when they exist so the reset works before and after they land.
    const optionalReferencingTables = await database.pool.query<{
      name: string;
    }>(`
      SELECT name
      FROM (
        VALUES ('memory_claim_corrections'), ('memory_impression_vetoes')
      ) AS candidate(name)
      WHERE to_regclass(format('%I', name)) IS NOT NULL
    `);
    const optionalNames = optionalReferencingTables.rows
      .map((row) => row.name)
      .join(", ");
    await database.pool.query(`
      TRUNCATE TABLE
        ${optionalNames ? `${optionalNames},` : ""}
        retrieval_run_candidates,
        retrieval_runs,
        claim_retrieval_projections,
        relationship_resolver_hints,
        memory_claim_version_qualifier_evidence,
        memory_claim_version_qualifiers,
        memory_impression_vetoes,
        memory_correction_followups,
        memory_claim_corrections,
        memory_consolidation_diffs,
        memory_consolidation_runs,
        fast_path_session_items,
        entity_resolve_gate_outcomes,
        entity_clarification_proposals,
        fast_path_extraction_runs,
        entity_mention_candidates,
        memory_forget_reversals,
        memory_forget_evidence_exclusions,
        memory_forget_requests,
        memory_candidate_evidence_links,
        memory_candidates,
        claim_evidence_links,
        memory_claim_versions,
        memory_claims,
        entity_mentions,
        entity_labels,
        user_self_entities,
        entity_versions,
        entities,
        conversation_action_payloads,
        conversation_action_receipts,
        conversation_action_executions,
        conversation_action_handles,
        current_rolling_summaries,
        rolling_summary_versions,
        rolling_summary_command_source_refs,
        rolling_summary_commands,
        journal_statement_evidence_links,
        journal_diagnostic_findings,
        journal_statements,
        journal_validation_results,
        journal_versions,
        journals,
        journal_model_run_attempts,
        journal_generation_commands,
        journal_workflow_outcomes,
        dialogue_state_command_source_refs,
        dialogue_state_versions,
        current_curiosity_stop_signals,
        safety_posture_alerts,
        current_safety_postures,
        safety_postures,
        curiosity_stop_signals,
        current_dialogue_states,
        dialogue_state_commands,
        evidence_lineage,
        evidence_model_run_attempts,
        evidence_items,
        evidence_source_snapshots,
        daily_session_date_outcomes,
        outbox_events,
        workflow_commands,
        sensitive_access_audits,
        internal_diagnostic_access_grants,
        provider_egress_consents,
        provider_egress_dispositions,
        compiled_context_revision_refs,
        compiled_contexts,
        model_run_attempts,
        generation_commands,
        continuous_exchange_inactivity_evaluations,
        conversation_event_revisions,
        conversation_events,
        interaction_turns,
        daily_sessions
    `);
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
    await new PostgresEntityRepository(database.pool).ensureSelfEntity({
      userId: OWNER,
      now: clock(),
    });
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  // ── fixtures ──────────────────────────────────────────────────────────────

  async function submitTurn(text: string): Promise<string> {
    submitCount += 1;
    const turn = await conversationService.submit(OWNER, {
      clientEventId: `inspector-event-${submitCount}`,
      clientTurnId: `inspector-turn-${submitCount}`,
      locale: "zh-CN",
      text,
      timezone: "Asia/Shanghai",
    });
    return turn.message.revisionId;
  }

  async function seedEvidence(revisionId: string): Promise<string> {
    const snapshotId = createTestUuidV7(clock());
    const itemId = createTestUuidV7(clock());
    await database.pool.query(
      `INSERT INTO evidence_source_snapshots (
         evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
         extraction_policy_version, command_id, attempt_id, champion_config_version,
         champion_provider, champion_model, champion_snapshot,
         champion_provider_policy_version, created_at
       ) VALUES ($1, $2, (SELECT daily_session_id FROM conversation_events
         WHERE conversation_event_id = (SELECT conversation_event_id
           FROM conversation_event_revisions WHERE conversation_event_revision_id = $3)),
         (SELECT sequence_no FROM conversation_events
           WHERE conversation_event_id = (SELECT conversation_event_id
             FROM conversation_event_revisions WHERE conversation_event_revision_id = $3)),
         'evidence-extraction:v2', 'seed', 'seed', 'test', 'openai', 'test', 'test', 'test', $4)`,
      [snapshotId, OWNER, revisionId, clock()],
    );
    await database.pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
         source_revision_id, source_actor, source_status, locator_type,
         locator_key, extraction_policy_version, evidence_role, created_at
       ) VALUES ($1, $2, $3,
         (SELECT conversation_event_id FROM conversation_event_revisions
           WHERE conversation_event_revision_id = $4),
         $4, 'user', 'final', 'whole_revision', $5, 'evidence-extraction:v2',
         'factual_support', $6)`,
      [itemId, OWNER, snapshotId, revisionId, `revision:${revisionId}`, clock()],
    );
    return itemId;
  }

  async function selfEntityId(): Promise<string> {
    const row = await database.pool.query<{ entity_id: string }>(
      `SELECT entity_id::text FROM user_self_entities WHERE user_id = $1`,
      [OWNER],
    );
    const entityId = row.rows[0]?.entity_id;
    if (!entityId) throw new Error("Self Entity missing in test fixture.");
    return entityId;
  }

  async function admitClaim(input: {
    predicateId: string;
    kind: "objective" | "impression";
    basis: "directly_stated" | "inferred";
    typedValue: string | readonly string[];
    evidenceItemIds: readonly string[];
  }): Promise<{ claimId: string; claimVersionId: string }> {
    const recorded = await claimService.recordCandidate({
      userId: OWNER,
      candidateKind: input.kind,
      basis: input.basis,
      resolution: {
        status: "mapped",
        predicateId: input.predicateId,
        registryVersion: 1,
        typedValue: input.typedValue,
        mappingConfidence: 0.95,
      },
      subjectEntityId: await selfEntityId(),
      subjectEntityMentionId: null,
      objectEntityId: null,
      objectEntityMentionId: null,
      scopeKey: "",
      temporal: {
        temporalStatus: "current",
        validFrom: null,
        validFromPrecision: "unknown",
        validTo: null,
        validToPrecision: "unknown",
      },
      qualifiers: [],
      evidenceItemIds: input.evidenceItemIds,
      lineage: {
        extractionPolicyVersion: "memory-extract-test:v1",
        generationCommandId: null,
        authoritativeModelAttemptId: null,
        modelVersion: "test-model",
        promptVersion: "memory-extract-test-prompt:v1",
        sourceReflectionVersionId: null,
      },
    });
    if (recorded.outcome !== "recorded") {
      throw new Error(`expected recorded candidate, got ${recorded.outcome}`);
    }
    const admitted = await claimService.admitCandidate({
      userId: OWNER,
      candidateId: recorded.candidateId,
    });
    if (admitted.outcome !== "promoted") {
      throw new Error(`expected promoted claim, got ${admitted.outcome}`);
    }
    return {
      claimId: admitted.claimId,
      claimVersionId: admitted.claimVersionId,
    };
  }

  /** The real request path; resolves the turn's GenerationCommand id. */
  async function respond(
    text: string,
    options: { withMemoryRetrieval?: boolean } = {},
  ): Promise<string> {
    const contextCompiler = createContextCompiler({
      clock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
      ...(options.withMemoryRetrieval === false
        ? {}
        : {
            memoryRetrieval: createMemoryRetrievalService({
              repository: new PostgresMemoryRetrievalRepository(database.pool),
              registry: {
                registryVersion: registrySnapshot.registryVersion,
                entryFor(predicateId) {
                  return (
                    registrySnapshot.entries.find(
                      (entry) => entry.predicateId === predicateId,
                    ) ?? null
                  );
                },
                localizations: registrySnapshot.localizations,
              },
              clock,
              testSupport: {
                configuration: () => retrievalFaults,
              },
            }),
          }),
    });
    const responseService = createConversationResponseService({
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock,
      contextCompiler,
      conversationService,
      harness: createConversationAgentHarness({
        clock,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock,
          contextCompiler,
          model: createDeterministicConversationTextModel({
            chunks: ["我在听。"],
          }),
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });
    respondCount += 1;
    let generationCommandId = "";
    for await (const event of responseService.respond(OWNER, {
      clientEventId: `inspector-response-event-${respondCount}`,
      clientTurnId: `inspector-response-turn-${respondCount}`,
      locale: "zh-CN",
      text,
      timezone: "Asia/Shanghai",
    })) {
      if (event.type === "user_committed") {
        generationCommandId = event.generationCommandId;
      }
    }
    if (!generationCommandId) {
      throw new Error("The response produced no GenerationCommand id.");
    }
    return generationCommandId;
  }

  function inspect(generationCommandId: string) {
    return createInternalInspectionService({
      clock,
      policyVersion: "sensitive-inspection:v1",
      repository: new PostgresInternalInspectionRepository(database.pool),
      stepUpMaxAgeMs: 10 * 60 * 1_000,
    }).getGenerationMetadata(
      OWNER,
      asGenerationCommandId(generationCommandId),
    );
  }

  async function seedStandingMemory(): Promise<void> {
    const impressionDay1 = await seedEvidence(
      await submitTurn("对我来说家人永远排第一位。"),
    );
    await admitClaim({
      predicateId: "sh.place.hometown",
      kind: "objective",
      basis: "directly_stated",
      typedValue: "西安",
      evidenceItemIds: [await seedEvidence(await submitTurn("我老家在西安。"))],
    });
    advanceMs(26 * 60 * 60 * 1_000);
    await quiesceActiveSession();
    const impressionDay2 = await seedEvidence(
      await submitTurn("还是那句话，家里人对我是最重要的。"),
    );
    await admitClaim({
      predicateId: "sh.value.core_priorities",
      kind: "impression",
      basis: "inferred",
      typedValue: ["家庭"],
      evidenceItemIds: [impressionDay1, impressionDay2],
    });
    await admitClaim({
      predicateId: "sh.life.career_stage",
      kind: "objective",
      basis: "directly_stated",
      typedValue: "employed",
      evidenceItemIds: [await seedEvidence(await submitTurn("我目前在上班。"))],
    });
    await admitClaim({
      predicateId: "sh.work.employer",
      kind: "objective",
      basis: "directly_stated",
      typedValue: "Acme",
      evidenceItemIds: [await seedEvidence(await submitTurn("我入职了 Acme。"))],
    });
  }

  function injectedItemsByVersion(
    inspection: GenerationInspectionMetadata,
  ): Map<string, string> {
    const byVersion = new Map<string, string>();
    for (const entry of memoryInjectedBySection(inspection)) {
      for (const item of entry.items) {
        byVersion.set(item.claimVersionId, entry.sectionKey);
      }
    }
    return byVersion;
  }

  function memoryInjectedBySection(
    inspection: GenerationInspectionMetadata,
  ): readonly {
    sectionKey: string;
    items: ReturnType<typeof parseMemorySectionItems>;
  }[] {
    return inspection.compiledContext.sections
      .filter((section) =>
        ["person_portrait", "objective_memory", "ai_impression"].includes(
          section.key,
        ),
      )
      .map((section) => ({
        items: parseMemorySectionItems(section.reference),
        sectionKey: section.key,
      }));
  }

  // ── AC 33 / story 51: same truth, full funnel ─────────────────────────────

  it("serves the retrieval panel from the same truth the model received (AC 33)", async () => {
    await seedStandingMemory();
    const generationCommandId = await respond("我在现在的公司过得还不错。");

    const inspection = await inspect(generationCommandId);

    // The panel manifest is exactly the persisted CompiledContext manifest.
    const persisted = await database.pool.query(
      `SELECT retrieval_manifest FROM compiled_contexts
       WHERE generation_command_id = $1`,
      [generationCommandId],
    );
    expect(inspection.compiledContext.retrievalManifest).toEqual(
      persisted.rows[0]?.retrieval_manifest,
    );
    const manifest = inspection.compiledContext.retrievalManifest!;
    expect(manifest.deadline_ms).toBe(200);
    expect(manifest.lane_plan.map((lane) => lane.lane)).toEqual([
      "structured_exact",
      "lexical_term_overlap",
      "english_fts",
    ]);
    expect(Object.keys(manifest.timings).length).toBeGreaterThan(0);
    expect(manifest.selection_policy_versions).toEqual({
      portrait_selection: "portrait-selection:v1",
      memory_budgets: "memory-budgets:v1",
      recall_framing: "recall-framing:v1",
    });

    // The employer Claim dual-selects: Portrait wins, so objective_memory is
    // omitted — and the panel's injected items come from the CompiledContext
    // sections themselves, never a recomputed selection.
    const injected = injectedItemsByVersion(inspection);
    expect(injected.size).toBe(3);
    expect([...injected.values()].filter((key) => key === "person_portrait"))
      .toHaveLength(3);

    // Full candidate funnel with per-candidate reasons.
    const funnel = inspection.retrievalCandidates;
    expect(funnel.length).toBeGreaterThan(0);
    const employerRow = funnel.find((candidate) =>
      candidate.selectionReasonCodes.includes("selected_person_portrait"),
    );
    expect(employerRow).toBeDefined();
    expect(employerRow!.selectedSection).toBe("person_portrait");
    expect(employerRow!.lane).toBe("structured_exact");
    expect(employerRow!.finalRank).not.toBeNull();
    expect(employerRow!.trustFenceResults.every((fence) => fence.passed)).toBe(
      true,
    );

    // No "selected but not injected": every selected candidate version is an
    // injected item in exactly that section.
    for (const candidate of funnel) {
      if (candidate.selectedSection === null) {
        expect(candidate.rejectionReasonCodes.length).toBeGreaterThan(0);
        expect(injected.has(candidate.claimVersionId)).toBe(false);
        continue;
      }
      expect(injected.get(candidate.claimVersionId)).toBe(
        candidate.selectedSection,
      );
    }
    // And no injection without a recorded selection reason.
    const portraitSelectedVersions = new Set(
      manifest.portrait_selection.selected_claim_version_ids,
    );
    for (const [versionId] of injected) {
      const backed =
        portraitSelectedVersions.has(versionId) ||
        funnel.some(
          (candidate) =>
            candidate.claimVersionId === versionId &&
            candidate.selectedSection !== null,
        );
      expect(backed).toBe(true);
    }
  });

  it("records the degraded round and injects nothing when a lane fails", async () => {
    await seedStandingMemory();
    retrievalFaults = {
      structuredExact: { failWith: new Error("lane down") },
    };
    const generationCommandId = await respond("我在现在的公司过得还不错。");

    const inspection = await inspect(generationCommandId);

    expect(inspection.compiledContext.degradedReason).toBe(
      "memory_retrieval_failed",
    );
    const manifest = inspection.compiledContext.retrievalManifest!;
    expect(manifest.degraded_reason_codes).toContain("retrieval_lane_failed");
    // The panel shows zero injected memory for the failed round.
    expect(memoryInjectedBySection(inspection)).toEqual([]);
    expect(inspection.retrievalCandidates).toEqual([]);
  });

  it("shows a turn with zero retrieved injection while the Portrait still compiles", async () => {
    await seedStandingMemory();
    const generationCommandId = await respond("你好呀。");

    const inspection = await inspect(generationCommandId);

    // The exchange window carries the seeding turns' signals, so the query is
    // not zero-signal — but the greeting matches no Claim closely enough, so
    // zero retrieved items inject. The funnel shows what the lanes saw and
    // why nothing qualified: a valid empty, not a failure.
    // The exchange window carries the seeding turns' signals: the employer
    // Claim canonical-key hit qualifies but dual-selects into the Portrait
    // (portrait wins dedupe), so zero query-retrieved items inject while the
    // funnel records exactly why — a valid empty for objective_memory.
    const manifest = inspection.compiledContext.retrievalManifest!;
    expect(manifest.zero_signal).toBe(false);
    expect(manifest.qualified_count).toBe(1);
    expect(manifest.section_budget_vs_actual.query_retrieved.actual_items).toBe(
      0,
    );
    expect(inspection.retrievalCandidates).toHaveLength(1);
    expect(inspection.retrievalCandidates[0]?.selectedSection).toBe(
      "person_portrait",
    );
    expect(
      inspection.retrievalCandidates[0]?.selectionReasonCodes,
    ).toContain("section_dedupe_portrait_priority");
    const injected = injectedItemsByVersion(inspection);
    expect(injected.size).toBe(3);
    // The dedupe-selected candidate is injected — through the Portrait.
    expect(
      injected.get(inspection.retrievalCandidates[0]!.claimVersionId),
    ).toBe("person_portrait");
  });

  it("reports no retrieval panel for a Context compiled without the retrieval port", async () => {
    await seedStandingMemory();
    const generationCommandId = await respond("我在现在的公司过得还不错。", {
      withMemoryRetrieval: false,
    });

    const inspection = await inspect(generationCommandId);

    expect(inspection.compiledContext.retrievalManifest).toBeNull();
    expect(inspection.retrievalCandidates).toEqual([]);
  });

  it("performs only reads — repeated inspection returns the identical payload", async () => {
    await seedStandingMemory();
    const generationCommandId = await respond("我在现在的公司过得还不错。");

    const first = await inspect(generationCommandId);
    const runsAfterFirst = await database.pool.query(
      "SELECT count(*)::int AS count FROM retrieval_runs",
    );
    const second = await inspect(generationCommandId);

    expect(second).toEqual(first);
    const runsAfterSecond = await database.pool.query(
      "SELECT count(*)::int AS count FROM retrieval_runs",
    );
    expect(runsAfterSecond.rows[0]?.count).toBe(runsAfterFirst.rows[0]?.count);
  });
});
