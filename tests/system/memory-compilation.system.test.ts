import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  createContinuousExchangeService,
  createConversationAgentHarness,
  createContextCompiler,
  createConversationResponseService,
  createEntityService,
  createMemoryClaimService,
  createMemoryRetrievalService,
  createUserTextConversationService,
  loadPredicateRegistrySnapshot,
  type MemoryClaimService,
  type RetrievalTestSupportConfiguration,
} from "@sayhear/application";
import {
  PostgresContinuousExchangeRepository,
  PostgresConversationResponseRepository,
  PostgresEntityRepository,
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

/**
 * SPEC #107 "Context compilation" (ticket #117), proven through the
 * authenticated internal text conversation seam: the three atomic memory
 * sections with global claim-version dedupe — Portrait wins dual selection
 * (AC 21) — budgets v1 as ceilings with zero-qualified zero-injection
 * (AC 20), the four-factor lexicographic Portrait selection with per-turn
 * reselection visible in manifests (AC 22), the prompt reading rendered
 * text + reference + kind-specific framing (never Evidence originals), and
 * the pinned strategy versions on the CompiledContext manifest
 * (cutover pin-list discipline, stories 41–43).
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const BASE_TIME = new Date("2026-08-27T08:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1_000;

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

describe("Memory context compilation system seam (#117)", () => {
  let database: IsolatedPostgresSchema;
  let claimService: MemoryClaimService;
  let conversationService: ReturnType<typeof createUserTextConversationService>;
  let responseRepository: PostgresConversationResponseRepository;
  let quiesceActiveSession: () => Promise<number>;
  let submitCount = 0;
  let respondCount = 0;

  let retrievalFaults: RetrievalTestSupportConfiguration | null;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(database.pool).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "memory-compilation-test-owner",
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
    // Daily Sessions do not split at midnight (ADR-0012): a new logical-date
    // session opens only after the previous one went quiescent.
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
    await database.pool.query(`
      TRUNCATE TABLE
        retrieval_run_candidates,
        retrieval_runs,
        claim_retrieval_projections,
        relationship_resolver_hints,
        memory_claim_version_qualifier_evidence,
        memory_claim_version_qualifiers,
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
      clientEventId: `compilation-event-${submitCount}`,
      clientTurnId: `compilation-turn-${submitCount}`,
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

  /** Admit one claim through the real claim service; returns the version id. */
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

  /**
   * The real request path with the retrieval baseline + memory compilation
   * wired into the Context Compiler.
   */
  async function respond(text: string): Promise<void> {
    const contextCompiler = createContextCompiler({
      clock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
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
    for await (const _event of responseService.respond(OWNER, {
      clientEventId: `compilation-response-event-${respondCount}`,
      clientTurnId: `compilation-response-turn-${respondCount}`,
      locale: "zh-CN",
      text,
      timezone: "Asia/Shanghai",
    })) {
      void _event;
    }
  }

  async function latestCompiled(): Promise<{
    degraded_reason: string | null;
    sections: readonly { key: string; reference: string }[];
    retrieval_manifest: {
      selection_policy_versions: Record<string, string>;
      section_budget_vs_actual: {
        person_portrait: {
          ceiling_items: number;
          ceiling_impressions: number;
          actual_items: number;
          actual_impressions: number;
        };
        query_retrieved: {
          ceiling_items: number;
          actual_items: number;
          actual_impressions: number;
        };
        memory_class_total: { ceiling_items: number; actual_items: number };
      };
      portrait_selection: {
        pool_count: number;
        selected_claim_version_ids: string[];
      };
      portrait_degraded_reason_codes: string[];
      zero_signal: boolean;
    } | null;
  }> {
    const row = await database.pool.query(
      `SELECT degraded_reason, sections, retrieval_manifest
       FROM compiled_contexts ORDER BY created_at DESC LIMIT 1`,
    );
    const compiled = row.rows[0];
    if (!compiled) throw new Error("No CompiledContext recorded.");
    return compiled;
  }

  async function candidatesOf(runId: string) {
    const rows = await database.pool.query(
      `SELECT selected_section, selection_reason_codes, rejection_reason_codes
       FROM retrieval_run_candidates WHERE retrieval_run_id = $1`,
      [runId],
    );
    return rows.rows as unknown as readonly {
      selected_section: string | null;
      selection_reason_codes: string[];
      rejection_reason_codes: string[];
    }[];
  }

  /**
   * Seeds the standing memory fixture across two Daily Sessions: one
   * cross-session AI Impression (understanding tier 3), hometown (tier 1,
   * stable semantics, admitted on day 1 so it stays out of the day-2
   * exchange query window), career stage (tier 2), and employer (tier 1)
   * — four portrait-eligible Claims with the employer's canonical key
   * reachable from a "公司" query.
   */
  async function seedStandingMemory(): Promise<{
    employer: { claimId: string; claimVersionId: string };
    hometown: { claimId: string; claimVersionId: string };
    career: { claimId: string; claimVersionId: string };
  }> {
    // Day 1: impression evidence + the hometown Claim (a prior-session
    // surface can never leak into the day-2 exchange query window).
    const impressionDay1 = await seedEvidence(
      await submitTurn("对我来说家人永远排第一位。"),
    );
    const hometown = await admitClaim({
      predicateId: "sh.place.hometown",
      kind: "objective",
      basis: "directly_stated",
      typedValue: "西安",
      evidenceItemIds: [await seedEvidence(await submitTurn("我老家在西安。"))],
    });
    // Cross the day boundary through the real inactivity machinery.
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
    const career = await admitClaim({
      predicateId: "sh.life.career_stage",
      kind: "objective",
      basis: "directly_stated",
      typedValue: "employed",
      evidenceItemIds: [await seedEvidence(await submitTurn("我目前在上班。"))],
    });
    const employer = await admitClaim({
      predicateId: "sh.work.employer",
      kind: "objective",
      basis: "directly_stated",
      typedValue: "Acme",
      evidenceItemIds: [await seedEvidence(await submitTurn("我入职了 Acme。"))],
    });
    return { employer, hometown, career };
  }

  // ── AC 21 + stories 41–43 ────────────────────────────────────────────────

  it("compiles the atomic sections with global dedupe, kind separation, and pinned versions (AC 21)", async () => {
    const { employer, career } = await seedStandingMemory();
    await respond("我在现在的公司过得还不错。");

    const compiled = await latestCompiled();
    expect(compiled.degraded_reason).toBeNull();
    const keys = compiled.sections.map((section) => section.key);
    // The employer Claim is both the top Portrait pick (current-topic tier)
    // and a canonical-key retrieval hit: it stays only in person_portrait,
    // so objective_memory is omitted entirely (portrait wins dual selection).
    expect(keys).toContain("person_portrait");
    expect(keys).not.toContain("objective_memory");
    expect(keys).not.toContain("ai_impression");

    const portrait = compiled.sections.find(
      (section) => section.key === "person_portrait",
    )!;
    // The prompt reads rendered text + opaque reference + kind framing, with
    // stable claim / version / evidence ids — never Evidence originals.
    expect(portrait.reference).toContain("[shh-memory-1]");
    expect(portrait.reference).toContain("portrait-selection:v1");
    expect(portrait.reference).toContain("memory-budgets:v1");
    expect(portrait.reference).toContain("recall-framing:v1");
    expect(portrait.reference).toContain(`version=${employer.claimVersionId}`);
    expect(portrait.reference).toContain("kind=impression");
    expect(portrait.reference).toContain("措辞（objective）");
    expect(portrait.reference).toContain("措辞（impression）");
    // The raw User Event prose never rides the memory sections.
    expect(portrait.reference).not.toContain("我目前在上班");
    expect(portrait.reference).not.toContain("还是那句话");

    const run = await database.pool.query<{ retrieval_run_id: string }>(
      `SELECT retrieval_run_id FROM retrieval_runs ORDER BY started_at DESC LIMIT 1`,
    );
    const candidates = await candidatesOf(run.rows[0]!.retrieval_run_id);
    const employerRow = candidates.find(
      (candidate) =>
        candidate.selection_reason_codes.includes("selected_person_portrait"),
    );
    expect(employerRow).toBeDefined();
    expect(employerRow!.selected_section).toBe("person_portrait");
    expect(employerRow!.selection_reason_codes).toContain(
      "section_dedupe_portrait_priority",
    );

    const manifest = compiled.retrieval_manifest!;
    expect(manifest.selection_policy_versions).toEqual({
      portrait_selection: "portrait-selection:v1",
      memory_budgets: "memory-budgets:v1",
      recall_framing: "recall-framing:v1",
    });
    expect(manifest.portrait_selection.pool_count).toBe(4);
    // Current-topic tier first: the 上班 / 公司 surfaces put career stage
    // (understanding tier 2) ahead of the employer Claim inside the topic
    // tier; the employer still makes the Portrait and dual-selects.
    expect(manifest.portrait_selection.selected_claim_version_ids).toEqual(
      expect.arrayContaining([career.claimVersionId, employer.claimVersionId]),
    );
    // Budgets v1 as ceilings: 3 items with ≤2 impressions; the dual-selected
    // Claim counts once against the memory-class total.
    expect(manifest.section_budget_vs_actual.person_portrait).toEqual({
      ceiling_items: 3,
      ceiling_impressions: 2,
      actual_items: 3,
      actual_impressions: 1,
    });
    expect(manifest.section_budget_vs_actual.memory_class_total).toEqual({
      ceiling_items: 5,
      actual_items: 3,
    });
  });

  // ── AC 22 ────────────────────────────────────────────────────────────────

  it("re-selects the Portrait per turn around the current topic, visible in manifests (AC 22)", async () => {
    const { hometown, employer } = await seedStandingMemory();
    // Turn 1: the exchange query window carries 上班 (career stage), so the
    // career Claim wins the topic tier and takes the top slot.
    await respond("我在现在的公司过得还不错。");
    const first = await latestCompiled();
    advanceMs(5 * 60 * 1_000);
    expect(
      first.retrieval_manifest!.portrait_selection.selected_claim_version_ids[0],
    ).toBe(employer.claimVersionId);
    // Turn 2: the topic moves to 老家 — the hometown Claim (stable
    // semantics) now wins the topic tier; per-turn reselection is recorded.
    await respond("最近总想起老家的事。");
    const second = await latestCompiled();
    expect(
      second.retrieval_manifest!.portrait_selection.selected_claim_version_ids[0],
    ).toBe(hometown.claimVersionId);
    expect(
      second.retrieval_manifest!.section_budget_vs_actual.person_portrait
        .actual_items,
    ).toBeLessThanOrEqual(3);
  });

  // ── AC 20 ────────────────────────────────────────────────────────────────

  it("injects zero retrieved memory on a zero-signal turn while the standing Portrait compiles (AC 20)", async () => {
    await seedStandingMemory();
    await respond("你好呀。");

    const compiled = await latestCompiled();
    const keys = compiled.sections.map((section) => section.key);
    const manifest = compiled.retrieval_manifest!;
    expect(keys).toContain("person_portrait");
    expect(keys).not.toContain("objective_memory");
    expect(keys).not.toContain("ai_impression");
    expect(manifest.section_budget_vs_actual.query_retrieved.actual_items).toBe(
      0,
    );
    expect(
      manifest.section_budget_vs_actual.person_portrait.actual_items,
    ).toBe(3);
    expect(
      manifest.section_budget_vs_actual.memory_class_total.actual_items,
    ).toBe(3);
  });

  it("fails the whole round's memory closed on a lane failure — no memory sections, conversation continues", async () => {
    await seedStandingMemory();
    retrievalFaults = {
      structuredExact: { failWith: new Error("lane down") },
    };
    await respond("我在现在的公司过得还不错。");

    const compiled = await latestCompiled();
    expect(compiled.degraded_reason).toBe("memory_retrieval_failed");
    const keys = compiled.sections.map((section) => section.key);
    expect(keys).not.toContain("person_portrait");
    expect(keys).not.toContain("objective_memory");
    expect(keys).not.toContain("ai_impression");
  });
});
