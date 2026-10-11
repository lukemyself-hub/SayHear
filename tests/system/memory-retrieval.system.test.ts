import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  MEMORY_RETRIEVAL_POLICY_VERSION,
  createConversationAgentHarness,
  createContextCompiler,
  createConversationResponseService,
  createEntityService,
  createMemoryClaimService,
  createMemoryRetrievalService,
  createUserTextConversationService,
  loadPredicateRegistrySnapshot,
  asMemoryCandidateId,
  type EntityService,
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
 * SPEC #107 "Retrieval — Structured-Lexical Baseline" (ticket #116), proven
 * against real PostgreSQL through the authenticated internal text
 * conversation seam: three deterministic lanes with strict priority and
 * fences before ranking (AC 17), the versioned 200 ms shared deadline with
 * boundary-success and timeout-fail-closed (AC 18), the lane health matrix
 * (AC 19, story 39), the manifest distinguishing zero signal / empty /
 * fenced-out with per-candidate reasons (story 40), deterministic committed
 * query sources with Assistant Events excluded (story 44), all through the
 * real request path (story 52). Lane failure / timeout injection is
 * test-support configuration of the retrieval lanes, not a new seam.
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
const COLLEAGUE_OF = "sh.relationship.colleague_of";

/** Opaque UUIDv7 generator for fixture rows (domain ID guards reject v4 UUIDs). */
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

describe("Structured-Lexical retrieval baseline system seam", () => {
  let database: IsolatedPostgresSchema;
  let claimService: MemoryClaimService;
  let entityService: EntityService;
  let conversationService: ReturnType<typeof createUserTextConversationService>;
  let responseRepository: PostgresConversationResponseRepository;
  let submitCount = 0;

  /** Mutable lane fault configuration read per run (test-support only). */
  let retrievalFaults: RetrievalTestSupportConfiguration | null;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(database.pool).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "memory-retrieval-test-owner",
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

    entityService = createEntityService({
      repository: new PostgresEntityRepository(database.pool),
      clock,
    });
    // The production-shaped registry lookup exposes localizations, so claim
    // admission maintains the retrieval projection write-through.
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
  }, 20_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME;
    retrievalFaults = null;
    await database.pool.query(`
      TRUNCATE TABLE
        conversation_event_generation_command_links,
        proactive_followup_dispositions,
        proactive_followup_uses,
        proactive_followup_reservations,
        proactive_followup_state_versions,
        proactive_followup_states,
        narrative_validator_results,
        narrative_validator_requests,
        episode_impact_reviews,
        episode_build_runs,
        episode_version_entity_links,
        episode_evidence_links,
        episode_candidate_entity_links,
        episode_candidate_evidence_links,
        episode_candidates,
        episode_versions,
        episodes,
        open_loop_closure_audits,
        open_loop_expiry_runs,
        open_loop_run_outcomes,
        open_loop_versions,
        open_loops,
        entity_identity_revalidation_runs,
        journal_identity_review_fences,
        journal_statement_entity_links,
        entity_identity_corrections,
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
        candidate_review_audits,
        predicate_change_proposal_candidate_links,
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
        history_recall_results,
        compiled_context_revision_refs,
        compiled_contexts,
        model_run_attempts,
        generation_commands,
        continuous_exchange_inactivity_evaluations,
        reflection_runs,
        reflection_candidate_proposals,
        reflection_statement_evidence_links,
        reflection_atomic_propositions,
        reflection_statements,
        reflection_versions,
        reflections,
        conversation_event_revisions,
        conversation_events,
        interaction_turns,
        daily_sessions
    `);
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
    // Policy rows are immutable (trigger): test deadline variants are seeded
    // idempotently and never deleted. Fault-injection tests pin the wide
    // policy so the injected lane fault — not wall-clock contention from the
    // parallel suite — is the determining variable.
    await database.pool.query(
      `INSERT INTO retrieval_policies (policy_version, deadline_ms, candidate_limit_per_lane, created_at)
       VALUES ('memory-retrieval:v1-wide', 10000, 25, CURRENT_TIMESTAMP)
       ON CONFLICT DO NOTHING`,
    );
    await entityService.ensureSelfEntity({ userId: OWNER });
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  // ── fixtures ──────────────────────────────────────────────────────────────

  /** One active person entity with a current primary zh label. */
  async function seedPersonEntity(labelZh: string): Promise<string> {
    const entityId = createTestUuidV7(clock());
    const versionId = createTestUuidV7(clock());
    await database.pool.query(
      `INSERT INTO entities (entity_id, user_id, created_at)
       VALUES ($1, $2, $3)`,
      [entityId, OWNER, clock()],
    );
    await database.pool.query(
      `INSERT INTO entity_versions (
         entity_version_id, entity_id, user_id, revision, entity_kind_id, status, created_at
       ) VALUES ($1, $2, $3, 1, 'sh.entity.person', 'active', $4)`,
      [versionId, entityId, OWNER, clock()],
    );
    await database.pool.query(
      `UPDATE entities SET current_version_id = $3
       WHERE user_id = $1 AND entity_id = $2`,
      [OWNER, entityId, versionId],
    );
    await database.pool.query(
      `INSERT INTO entity_labels (
         entity_label_id, entity_id, user_id, locale, label, normalized_label,
         label_kind, is_current, created_at
       ) VALUES ($1, $2, $3, 'zh', $4, $4, 'primary', TRUE, $5)`,
      [createTestUuidV7(clock()), entityId, OWNER, labelZh, clock()],
    );
    return entityId;
  }

  async function selfEntityId(): Promise<string> {
    const self = await entityService.findSelfEntity(OWNER);
    if (!self) throw new Error("Self Entity missing in test fixture.");
    return self.entityId;
  }

  /** Submit a user turn through the conversation service (committed input). */
  async function submitTurn(text: string): Promise<string> {
    submitCount += 1;
    const turn = await conversationService.submit(OWNER, {
      clientEventId: `retrieval-event-${submitCount}`,
      clientTurnId: `retrieval-turn-${submitCount}`,
      locale: "zh-CN",
      text,
      timezone: "Asia/Shanghai",
    });
    return turn.message.revisionId;
  }

  /** Seed one whole-revision User EvidenceItem the way the fast path would. */
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

  /** Admit a colleague_of claim between Self and a seeded person entity. */
  async function seedColleagueClaim(wangEntityId: string) {
    const revisionId = await submitTurn("我和小王是同事，都在产品部。");
    const evidenceId = await seedEvidence(revisionId);
    const recorded = await claimService.recordCandidate({
      userId: OWNER,
      candidateKind: "objective",
      basis: "directly_stated",
      resolution: {
        status: "mapped",
        predicateId: COLLEAGUE_OF,
        registryVersion: 1,
        typedValue: "",
        mappingConfidence: 0.95,
      },
      subjectEntityId: await selfEntityId(),
      subjectEntityMentionId: null,
      objectEntityId: wangEntityId,
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
      evidenceItemIds: [evidenceId],
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
    return admitted.claimId;
  }

  /**
   * The real request path with the retrieval baseline wired into the Context
   * Compiler: the deterministic conversation model streams one reply, the
   * lane fault configuration is read per run.
   */
  async function respond(
    text: string,
    options: { policyVersion?: string } = {},
  ): Promise<void> {
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
        ...(options.policyVersion
          ? { policyVersion: options.policyVersion }
          : {}),
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
    submitCount += 1;
    for await (const _event of responseService.respond(OWNER, {
      clientEventId: `retrieval-response-event-${submitCount}`,
      clientTurnId: `retrieval-response-turn-${submitCount}`,
      locale: "zh-CN",
      text,
      timezone: "Asia/Shanghai",
    })) {
      void _event;
    }
  }

  async function latestRun(): Promise<{
    retrieval_run_id: string;
    status: string;
    degraded_reason_codes: string[];
    deadline_ms: number;
    duration_ms: number;
    deadline_exceeded_stage: string | null;
    compiled_context_id: string | null;
    lane_plan: { lane: string; enabled: boolean; notEnabledReason: string | null }[];
    query_source_refs: { kind: string; revisionId?: string }[];
    normalized_query_terms: { resolved_entities: string[]; lexical_terms: string[] };
  }> {
    const row = await database.pool.query(
      `SELECT * FROM retrieval_runs ORDER BY started_at DESC, retrieval_run_id DESC LIMIT 1`,
    );
    const run = row.rows[0];
    if (!run) throw new Error("No retrieval run recorded.");
    return run as never;
  }

  async function candidatesOf(runId: string) {
    const rows = await database.pool.query(
      `SELECT * FROM retrieval_run_candidates
       WHERE retrieval_run_id = $1 ORDER BY final_rank NULLS LAST`,
      [runId],
    );
    return rows.rows as unknown as readonly {
      retrieval_lane: string;
      matched_fields: string[];
      matched_terms: string[];
      trust_fence_results: { fence: string; passed: boolean }[];
      final_rank: number | null;
      selection_reason_codes: string[];
      rejection_reason_codes: string[];
    }[];
  }

  // ── AC 17 + stories 40 / 44 / 52 ──────────────────────────────────────────

  it("runs the lanes deterministically through the real request path and records the manifest (AC 17, story 40)", async () => {
    const wang = await seedPersonEntity("小王");
    await seedColleagueClaim(wang);
    // Admission maintains the projection write-through: one row per locale.
    const projections = await database.pool.query(
      `SELECT locale, status FROM claim_retrieval_projections ORDER BY locale`,
    );
    expect(projections.rows).toEqual([
      { locale: "en", status: "active" },
      { locale: "zh", status: "active" },
    ]);

    await respond("我同事小王还好吗");

    const run = await latestRun();
    expect(run.status).toBe("completed");
    expect(run.degraded_reason_codes).toEqual([]);
    expect(run.deadline_ms).toBe(200);
    expect(run.compiled_context_id).not.toBeNull();
    // Strict lane plan: structured + lexical enabled, english not (zh-only).
    expect(run.lane_plan).toEqual([
      { lane: "structured_exact", enabled: true, notEnabledReason: null },
      { lane: "lexical_term_overlap", enabled: true, notEnabledReason: null },
      { lane: "english_fts", enabled: false, notEnabledReason: "no_english_word_content" },
    ]);
    expect(run.normalized_query_terms.resolved_entities).toEqual([wang]);
    expect(run.normalized_query_terms.lexical_terms).toEqual(
      expect.arrayContaining(["同事", "小王"]),
    );

    const candidates = await candidatesOf(run.retrieval_run_id);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.retrieval_lane).toBe("structured_exact");
    expect(candidate.matched_fields).toEqual(
      expect.arrayContaining(["entity_id", "predicate_id", "canonical_key"]),
    );
    expect(candidate.final_rank).toBe(1);
    expect(candidate.selection_reason_codes).toContain(
      "relevance_cutoff_canonical_key_exact",
    );
    expect(candidate.rejection_reason_codes).toEqual([]);
    expect(
      candidate.trust_fence_results.every((fence) => fence.passed),
    ).toBe(true);

    const compiled = await database.pool.query<{
      degraded_reason: string | null;
      retrieval_manifest: { qualified_count: number } | null;
    }>(
      `SELECT degraded_reason, retrieval_manifest FROM compiled_contexts
       WHERE compiled_context_id = $1`,
      [run.compiled_context_id],
    );
    expect(compiled.rows[0]!.degraded_reason).toBeNull();
    expect(compiled.rows[0]!.retrieval_manifest?.qualified_count).toBe(1);
  });

  it("builds queries only from committed user-side sources (story 44)", async () => {
    const wang = await seedPersonEntity("小王");
    await seedColleagueClaim(wang);
    await respond("我同事小王还好吗");
    const run = await latestRun();
    const revisionIds = run.query_source_refs
      .filter((ref) => ref.revisionId !== undefined)
      .map((ref) => ref.revisionId);
    expect(revisionIds.length).toBeGreaterThan(0);
    const userRevisions = await database.pool.query(
      `SELECT revision.conversation_event_revision_id::text AS id
       FROM conversation_event_revisions revision
       JOIN conversation_events event
         ON event.current_revision_id = revision.conversation_event_revision_id
       WHERE event.user_id = $1 AND event.actor = 'user'`,
      [OWNER],
    );
    const userIds = new Set(userRevisions.rows.map((row) => row.id));
    for (const revisionId of revisionIds) {
      expect(userIds.has(revisionId)).toBe(true);
    }
    // A prior exchange user event joins the query sources on the next turn.
    await respond("他还好吗");
    const second = await latestRun();
    expect(
      second.query_source_refs.some((ref) => ref.kind === "exchange_user_event"),
    ).toBe(true);
  });

  it("records query-construction zero signal as a completed empty run (story 40)", async () => {
    await respond("。。。");
    const run = await latestRun();
    expect(run.status).toBe("completed");
    expect(run.degraded_reason_codes).toEqual([]);
    expect(run.lane_plan.every((lane) => !lane.enabled)).toBe(true);
    const candidates = await candidatesOf(run.retrieval_run_id);
    expect(candidates).toHaveLength(0);
    const manifest = await database.pool.query<{ retrieval_manifest: unknown }>(
      `SELECT retrieval_manifest FROM compiled_contexts
       WHERE compiled_context_id = $1`,
      [run.compiled_context_id],
    );
    expect(manifest.rows[0]!.retrieval_manifest).toMatchObject({
      zero_signal: true,
    });
  });

  it("treats an enabled lane with zero candidates as a valid empty (AC 19)", async () => {
    // No claims seeded: the lexical lane is enabled (matched terms) but the
    // projection store holds nothing for this user.
    await respond("我同事小王还好吗");
    const run = await latestRun();
    expect(run.status).toBe("completed");
    const candidates = await candidatesOf(run.retrieval_run_id);
    expect(candidates).toHaveLength(0);
    const manifest = await database.pool.query<{ retrieval_manifest: unknown }>(
      `SELECT retrieval_manifest FROM compiled_contexts
       WHERE compiled_context_id = $1`,
      [run.compiled_context_id],
    );
    expect(manifest.rows[0]!.retrieval_manifest).toMatchObject({
      zero_signal: false,
      candidate_count: 0,
      lane_hit_counts: {
        structured_exact: 0,
        lexical_term_overlap: 0,
        english_fts: 0,
      },
    });
  });

  // ── AC 19 / story 39: lane health matrix ──────────────────────────────────

  it("fails the whole round's memory closed when an enabled lane errors, and the conversation continues", async () => {
    const wang = await seedPersonEntity("小王");
    await seedColleagueClaim(wang);
    retrievalFaults = {
      structuredExact: { failWith: new Error("structured lane exploded") },
    };
    await respond("我同事小王还好吗", { policyVersion: "memory-retrieval:v1-wide" });

    const run = await latestRun();
    expect(run.status).toBe("degraded");
    expect(run.degraded_reason_codes).toContain("retrieval_lane_failed");
    const candidates = await candidatesOf(run.retrieval_run_id);
    expect(candidates).toHaveLength(0);

    const compiled = await database.pool.query<{ degraded_reason: string | null }>(
      `SELECT degraded_reason FROM compiled_contexts
       WHERE compiled_context_id = $1`,
      [run.compiled_context_id],
    );
    expect(compiled.rows[0]!.degraded_reason).toBe("memory_retrieval_failed");

    // Degraded memory never blocks the reply: the Assistant Event committed.
    const assistant = await database.pool.query(
      `SELECT COUNT(*)::int AS count FROM conversation_events
       WHERE user_id = $1 AND actor = 'assistant' AND lifecycle_status = 'active'`,
      [OWNER],
    );
    expect(assistant.rows[0]!.count).toBeGreaterThan(0);
  });

  it("ignores a failure injected into a lane the query plan did not enable (AC 19)", async () => {
    retrievalFaults = {
      englishFts: { failWith: new Error("english lane exploded") },
    };
    await respond("我同事小王还好吗", { policyVersion: "memory-retrieval:v1-wide" });
    const run = await latestRun();
    expect(run.status).toBe("completed");
    expect(run.degraded_reason_codes).toEqual([]);
  });

  it("does not reuse the previous turn's memory after a mid-exchange lane failure", async () => {
    const wang = await seedPersonEntity("小王");
    await seedColleagueClaim(wang);
    await respond("我同事小王还好吗");
    const healthy = await latestRun();
    const [qualified] = await candidatesOf(healthy.retrieval_run_id);
    expect(qualified?.selection_reason_codes.length).toBeGreaterThan(0);

    retrievalFaults = {
      structuredExact: { failWith: new Error("structured lane exploded") },
    };
    advanceMs(1_000);
    await respond("小王呢", { policyVersion: "memory-retrieval:v1-wide" });
    const failed = await latestRun();
    expect(failed.retrieval_run_id).not.toBe(healthy.retrieval_run_id);
    expect(failed.status).toBe("degraded");
    const candidates = await candidatesOf(failed.retrieval_run_id);
    expect(candidates).toHaveLength(0);
    const compiled = await database.pool.query<{ degraded_reason: string | null }>(
      `SELECT degraded_reason FROM compiled_contexts
       WHERE compiled_context_id = $1`,
      [failed.compiled_context_id],
    );
    expect(compiled.rows[0]!.degraded_reason).toBe("memory_retrieval_failed");
  });

  // ── AC 18: the versioned 200 ms shared deadline ───────────────────────────

  it("records the deadline with actual duration and phase when exceeded (AC 18)", async () => {
    await database.pool.query(
      `INSERT INTO retrieval_policies (policy_version, deadline_ms, candidate_limit_per_lane, created_at)
       VALUES ('memory-retrieval:v1-tight', 60, 25, CURRENT_TIMESTAMP)
       ON CONFLICT DO NOTHING`,
    );
    const wang = await seedPersonEntity("小王");
    await seedColleagueClaim(wang);
    retrievalFaults = { structuredExact: { delayMs: 120 } };
    await respond("我同事小王还好吗", { policyVersion: "memory-retrieval:v1-tight" });

    const run = await latestRun();
    expect(run.status).toBe("degraded");
    expect(run.degraded_reason_codes).toContain("retrieval_deadline_exceeded");
    expect(run.deadline_exceeded_stage).toBe("lane_execution");
    expect(run.duration_ms).toBeGreaterThanOrEqual(60);
    const compiled = await database.pool.query<{ degraded_reason: string | null }>(
      `SELECT degraded_reason FROM compiled_contexts
       WHERE compiled_context_id = $1`,
      [run.compiled_context_id],
    );
    expect(compiled.rows[0]!.degraded_reason).toBe("memory_retrieval_failed");
  });

  it("demonstrates boundary success inside the deadline with recorded duration (AC 18)", async () => {
    const wang = await seedPersonEntity("小王");
    await seedColleagueClaim(wang);
    retrievalFaults = { structuredExact: { delayMs: 80 } };
    await respond("我同事小王还好吗", { policyVersion: "memory-retrieval:v1-wide" });

    const run = await latestRun();
    expect(run.status).toBe("completed");
    expect(run.duration_ms).toBeGreaterThanOrEqual(80);
    expect(run.duration_ms).toBeLessThanOrEqual(10_000);
    const candidates = await candidatesOf(run.retrieval_run_id);
    expect(candidates[0]!.final_rank).toBe(1);
  });

  it("ships the production policy pinned at 200 ms", async () => {
    const policy = await database.pool.query(
      `SELECT deadline_ms, candidate_limit_per_lane FROM retrieval_policies
       WHERE policy_version = $1`,
      [MEMORY_RETRIEVAL_POLICY_VERSION],
    );
    expect(policy.rows[0]).toEqual({ deadline_ms: 200, candidate_limit_per_lane: 25 });
  });

  // ── fences before ranking, across all lanes (AC 17 / story 52) ────────────

  it("fails a claim closed when its referenced EntityVersion merged, with recorded fence results", async () => {
    const wang = await seedPersonEntity("小王");
    const claimId = await seedColleagueClaim(wang);

    // Entity merge propagation is asynchronous: the merged EntityVersion
    // must stop Recall immediately, without waiting for consolidation
    // (knowledge model §7.11 retrieval fence rule).
    const referenced = await database.pool.query<{ version_id: string }>(
      `SELECT v.object_entity_version_id::text AS version_id
       FROM memory_claims claim
       JOIN memory_claim_versions v
         ON v.memory_claim_version_id = claim.current_version_id
       WHERE claim.memory_claim_id = $1`,
      [claimId],
    );
    const mergedVersionId = createTestUuidV7(clock());
    const survivor = await seedPersonEntity("小汪");
    await database.pool.query(
      `INSERT INTO entity_versions (
         entity_version_id, entity_id, user_id, revision, entity_kind_id,
         status, merged_into_entity_id, created_at
       ) SELECT $2, entity_id, user_id, revision + 1, entity_kind_id,
                'merged', $3, $4
       FROM entity_versions WHERE entity_version_id = $1`,
      [referenced.rows[0]!.version_id, mergedVersionId, survivor, clock()],
    );
    await database.pool.query(
      `UPDATE entities SET current_version_id = $2
       WHERE user_id = $1 AND current_version_id = $3
         AND entity_id = (SELECT entity_id FROM entity_versions WHERE entity_version_id = $3)`,
      [OWNER, mergedVersionId, referenced.rows[0]!.version_id],
    );

    await respond("我同事小王还好吗");
    const run = await latestRun();
    expect(run.status).toBe("completed");
    const candidates = await candidatesOf(run.retrieval_run_id);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.rejection_reason_codes).toContain(
      "trust_fence_failed_entity",
    );
    expect(
      candidate.trust_fence_results.find((fence) => fence.fence === "entity")
        ?.passed,
    ).toBe(false);
    expect(candidate.final_rank).toBeNull();
    const manifest = await database.pool.query<{ retrieval_manifest: unknown }>(
      `SELECT retrieval_manifest FROM compiled_contexts
       WHERE compiled_context_id = $1`,
      [run.compiled_context_id],
    );
    expect(manifest.rows[0]!.retrieval_manifest).toMatchObject({
      fenced_out_count: 1,
      qualified_count: 0,
    });
  });

  it("stops recall structurally after whole-claim Forget: no projection, no candidate", async () => {
    const wang = await seedPersonEntity("小王");
    const claimId = await seedColleagueClaim(wang);
    const forget = await claimService.applyWholeClaimForget({
      userId: OWNER,
      claimId,
      requestEventRevisionId: await submitTurn("忘掉小王的事。"),
    });
    expect(forget.outcome).toBe("applied");
    // Fence teardown is the active -> deleted lifecycle: no projection
    // participates in recall any more (the row itself stays for the immutable
    // retrieval observation ledger; physical deletion is the purge face).
    const projections = await database.pool.query(
      `SELECT COUNT(*)::int AS count FROM claim_retrieval_projections
       WHERE memory_claim_id = $1 AND status = 'active'`,
      [claimId],
    );
    expect(projections.rows[0]!.count).toBe(0);

    await respond("我同事小王还好吗");
    const run = await latestRun();
    expect(run.status).toBe("completed");
    const candidates = await candidatesOf(run.retrieval_run_id);
    expect(candidates).toHaveLength(0);
  });
});
