import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  FAST_PATH_EXTRACTION_POLICY_VERSION,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  createConversationAgentHarness,
  createContextCompiler,
  createConversationResponseService,
  createEntityService,
  createOutboxDispatcherService,
  createUserTextConversationService,
  loadPredicateRegistrySnapshot,
  runFastPathExtraction,
  type EntityResolveGateProvider,
  type EntityResolveGateResponse,
  type FastPathExtractionEntrypointDependencies,
  type MemoryExtractProvider,
  type MemoryExtractRevisionResult,
} from "@sayhear/application";
import {
  PostgresEntityRepository,
  PostgresFastPathExtractionRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresOutboxDispatcherRepository,
  PostgresUserTextConversationRepository,
  PostgresConversationResponseRepository,
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
 * SPEC #107 "Two-speed pipeline" (ticket #113), proven against real
 * PostgreSQL through the authenticated conversation seam: every committed
 * final / corrected User Event carries exactly one idempotent extraction
 * command created in the submit transaction (the reply never waits); the
 * outbox dispatcher + workflow entrypoint run one batched `memory.extract`
 * call with deterministic resolution first and the single `entity.resolve`
 * gate on bounded ambiguity; corrections produce new commands and retire the
 * old revision's derivatives; output stays same-day session-local; lag is
 * recorded as `fast_path_pending`; a failed role fails loudly. Async work is
 * observed through the outbox / workflow machinery — no sleeps.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const BASE_TIME = new Date("2026-08-27T08:00:00.000Z").getTime();

let database: IsolatedPostgresSchema;

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


async function countRows(table: string, where = ""): Promise<number> {
  const result = await database.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} ${where}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe("Fast-path extraction workflow system seam", () => {
  let conversationService: ReturnType<typeof createUserTextConversationService>;
  let entityRepository: PostgresEntityRepository;
  let fastPathRepository: PostgresFastPathExtractionRepository;
  let responseRepository: PostgresConversationResponseRepository;
  let dispatch: () => Promise<{ dispatched: number; failed: number }>;
  let memoryExtractCalls: number;
  let entityResolveCalls: number;
  let submitCount = 0;

  // Scripted determinism replacements (SPEC Testing Decisions): the memory
  // roles are scripted per Event revision through the seam.
  let extractScript: (
    revisions: readonly Readonly<{ revisionId: string; text: string; locale: string }>[],
  ) => readonly MemoryExtractRevisionResult[] = (revisions) =>
    revisions.map((revision) => ({
      revisionId: revision.revisionId,
      evidence: [
        { locatorKey: `0:${revision.text.length}`, role: "factual_support" as const },
      ],
      mentions: [],
      candidates: [],
      clarifications: [],
    }));
  let resolveScript: (
    input: Parameters<EntityResolveGateProvider["resolve"]>[0],
  ) => EntityResolveGateResponse = () => ({ verdict: "unclear", entityId: null, confidence: 0 });

  const defaultExtractScript: (
    revisions: readonly Readonly<{ revisionId: string; text: string }>[],
  ) => readonly MemoryExtractRevisionResult[] = (revisions) =>
    revisions.map((revision) => ({
      revisionId: revision.revisionId,
      evidence: [
        { locatorKey: `0:${revision.text.length}`, role: "factual_support" as const },
      ],
      mentions: [],
      candidates: [
        {
          basis: "directly_stated" as const,
          candidateKind: "objective" as const,
          predicateId: "sh.place.residence",
          proposedConcept: null,
          typedValue: revision.text,
          scopeKey: "",
          subjectMentionIndex: null,
          objectMentionIndex: null,
          evidenceLocatorKeys: [`0:${revision.text.length}`],
          qualifiers: [],
          temporal: {
            temporalStatus: "current" as const,
            validFrom: null,
            validFromPrecision: "unknown" as const,
            validTo: null,
            validToPrecision: "unknown" as const,
          },
          itemClass: "person",
          itemSummary: `stated: ${revision.text.slice(0, 40)}`,
        },
      ],
      clarifications: [],
    }));

  const memoryExtract: MemoryExtractProvider = {
    role: "memory.extract",
    async extract(request, _invocation) {
      memoryExtractCalls += 1;
      return extractScript(request.revisions);
    },
  };
  const entityResolve: EntityResolveGateProvider = {
    role: "entity.resolve",
    async resolve(request, _invocation) {
      entityResolveCalls += 1;
      return resolveScript(request);
    },
  };

  function entrypointDependencies(
    workflowReceiptId: string,
  ): FastPathExtractionEntrypointDependencies {
    return {
      clock,
      repository: fastPathRepository,
      entityService: createEntityService({ repository: entityRepository, clock }),
      entityRepository,
      memoryExtract,
      entityResolve,
      registry: {
        entryFor(predicateId) {
          return (
            registrySnapshot.entries.find((entry) => entry.predicateId === predicateId) ??
            null
          );
        },
        registryVersion: () => registrySnapshot.registryVersion,
      },
      policy: {
        version: FAST_PATH_EXTRACTION_POLICY_VERSION,
        visibilityTargetMs: 30_000,
        maxBatchRevisions: 8,
        tAuto: 0.9,
        maxCandidates: 3,
      },
      memoryExtractConfiguration: {
        role: "memory.extract",
        configVersion: "memory-extract-champion:v1",
        modelVersion: "gpt-5.4",
        promptVersion: "memory-extract:propose:v1",
        fallback: { mode: "disabled" },
      },
      entityResolveConfiguration: {
        role: "entity.resolve",
        configVersion: "entity-resolve-champion:v1",
        modelVersion: "gpt-5.4",
        promptVersion: "entity-resolve:gate:v1",
        fallback: { mode: "disabled" },
      },
      evidenceChampion: {
        provider: "openai",
        model: "gpt-5.4",
        configVersion: "memory-extract-champion:v1",
        snapshot: "memory-extract:propose:v1",
        providerPolicyVersion: "openai-conversation-text:v1",
      },
      dedupeFingerprintSecret: "system-test-secret",
      workflowReceiptId,
    };
  }

  async function submitTurn(
    text: string,
    locale: "zh-CN" | "en-US" = "zh-CN",
  ): Promise<{ eventId: string; revisionId: string; dailySessionId: string }> {
    submitCount += 1;
    const turn = await conversationService.submit(OWNER, {
      clientEventId: `fast-path-event-${submitCount}`,
      clientTurnId: `fast-path-turn-${submitCount}`,
      locale,
      text,
      timezone: locale === "zh-CN" ? "Asia/Shanghai" : "America/Los_Angeles",
    });
    return {
      eventId: turn.message.id,
      revisionId: turn.message.revisionId,
      dailySessionId: turn.dailySession.id,
    };
  }

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    const accessRepository = new PostgresInternalOwnerAccessRepository(
      database.pool,
    );
    await accessRepository.provisionInternalOwner({
      issuer: "https://github.com",
      subject: "fast-path-test-owner",
      userId: OWNER,
    });

    entityRepository = new PostgresEntityRepository(database.pool);
    fastPathRepository = new PostgresFastPathExtractionRepository(database.pool);
    responseRepository = new PostgresConversationResponseRepository(database.pool);
    conversationService = createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      fastPathExtractionPolicyVersion: FAST_PATH_EXTRACTION_POLICY_VERSION,
      generationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    let workflowCounter = 0;
    dispatch = async () => {
      const dispatcher = createOutboxDispatcherService({
        clock,
        leaseDurationMs: 60_000,
        leaseOwner: "fast-path-system-test",
        repository: new PostgresOutboxDispatcherRepository(database.pool),
        startWorkflow: async (input) => {
          workflowCounter += 1;
          const receipt = `wf-fast-path-${workflowCounter}`;
          await runFastPathExtraction({
            dependencies: entrypointDependencies(receipt),
            command: {
              workflowCommandId: input.workflowCommandId,
              policyVersion: input.policyVersion,
            },
          });
          return { workflowReceiptId: receipt };
        },
      });
      return dispatcher.dispatchPending();
    };
  }, 20_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME;
    memoryExtractCalls = 0;
    entityResolveCalls = 0;
    extractScript = defaultExtractScript;
    resolveScript = () => ({ verdict: "unclear", entityId: null, confidence: 0 });
    await database.pool.query(`
      TRUNCATE TABLE
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
      CASCADE
    `);
    await database.pool.query("DELETE FROM backup_policy_versions");
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
    await database.pool.query(
      "UPDATE provider_egress_policy_versions SET status = 'active'",
    );
    await new PostgresInternalOwnerAccessRepository(database.pool).recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: "sha256:expected",
      databaseRetentionDays: 30,
      evidenceReference: "synthetic backup console evidence",
      policyVersion: "neon-production-v1",
      pitrRetentionDays: 7,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2027-08-27T16:00:00.000Z"),
      verifiedAt: new Date("2026-07-27T15:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  it("creates exactly one idempotent command per committed final event without waiting on extraction", async () => {
    const turn = await submitTurn("我妈妈住在上海。");
    expect(turn.revisionId).toBeTruthy();

    const commands = await database.pool.query(
      `SELECT command_type, subject_type, subject_id, source_revision, policy_version
       FROM workflow_commands WHERE command_type = 'fast_path_extraction'`,
    );
    expect(commands.rows).toHaveLength(1);
    expect(commands.rows[0]).toMatchObject({
      command_type: "fast_path_extraction",
      subject_type: "conversation_event_revision",
      subject_id: turn.revisionId,
      source_revision: "1",
      policy_version: FAST_PATH_EXTRACTION_POLICY_VERSION,
    });
    const outbox = await database.pool.query(
      `SELECT event_type, status FROM outbox_events
       WHERE event_type = 'fast_path_extraction_requested'`,
    );
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0]).toMatchObject({ status: "pending" });

    // The current reply never waits: no provider call, no extraction state.
    expect(memoryExtractCalls).toBe(0);
    expect(await countRows("fast_path_extraction_runs")).toBe(0);

    // A replayed submit (same idempotency keys) creates no second command.
    submitCount -= 1;
    await submitTurn("我妈妈住在上海。");
    expect(
      await countRows("workflow_commands", "WHERE command_type = 'fast_path_extraction'"),
    ).toBe(1);
    expect(await countRows("outbox_events", "WHERE event_type = 'fast_path_extraction_requested'")).toBe(1);
  });

  it("dispatches through the real outbox machinery, batches pending revisions into one provider call, and records visibility", async () => {
    extractScript = (revisions) =>
      revisions.map((revision) => ({
        revisionId: revision.revisionId,
        evidence: [
          { locatorKey: `0:${revision.text.length}`, role: "factual_support" as const },
        ],
        mentions: [],
        candidates: [
          {
            basis: "directly_stated" as const,
            candidateKind: "objective" as const,
            predicateId: "sh.place.residence",
            proposedConcept: null,
            typedValue: revision.text,
            scopeKey: "",
            subjectMentionIndex: null,
            objectMentionIndex: null,
            evidenceLocatorKeys: [`0:${revision.text.length}`],
          qualifiers: [],
            temporal: {
              temporalStatus: "current" as const,
              validFrom: null,
              validFromPrecision: "unknown" as const,
              validTo: null,
              validToPrecision: "unknown" as const,
            },
            itemClass: "person",
            itemSummary: `stated: ${revision.text.slice(0, 40)}`,
          },
        ],
        clarifications: [],
      }));
    const first = await submitTurn("我妈妈住在上海。");
    const second = await submitTurn("我最近在准备换工作。");
    advanceMs(10_000);

    const outcome = await dispatch();
    expect(outcome.dispatched).toBe(2);
    expect(memoryExtractCalls).toBe(1);

    const runs = await database.pool.query<{
      event_revision_id: string;
      status: string;
      visibility_lag_ms: string;
      visibility_target_met: boolean;
      error_code: string | null;
    }>(
      `SELECT event_revision_id, status, visibility_lag_ms::text, visibility_target_met, error_code
       FROM fast_path_extraction_runs ORDER BY created_at`,
    );
    expect(runs.rows).toHaveLength(2);
    expect(new Set(runs.rows.map((row) => row.event_revision_id))).toEqual(
      new Set([first.revisionId, second.revisionId]),
    );
    for (const run of runs.rows) {
      expect(run.status).toBe("extracted");
      expect(run.error_code).toBeNull();
      expect(run.visibility_target_met).toBe(true);
      expect(Number(run.visibility_lag_ms)).toBeGreaterThanOrEqual(10_000);
    }

    // Evidence, candidates, and session items landed per revision.
    expect(await countRows("evidence_items")).toBe(2);
    expect(await countRows("memory_candidates", "WHERE status = 'proposed'")).toBe(2);
    expect(await countRows("fast_path_session_items")).toBe(2);
    const itemClasses = await database.pool.query<{ item_class: string }>(
      "SELECT DISTINCT item_class FROM fast_path_session_items",
    );
    expect(itemClasses.rows.map((row) => row.item_class)).toEqual(["person"]);

    // Fast-path output never admits Claims (SPEC story 29): structurally no
    // Claim exists from the fast path.
    expect(await countRows("memory_claims")).toBe(0);

    // Replay of the workflow entrypoint converges without double writes.
    const command = await database.pool.query<{ workflow_command_id: string }>(
      `SELECT workflow_command_id FROM workflow_commands
       WHERE command_type = 'fast_path_extraction' AND subject_id = $1`,
      [first.revisionId],
    );
    const replay = await runFastPathExtraction({
      dependencies: entrypointDependencies("wf-replay"),
      command: {
        workflowCommandId: command.rows[0]!.workflow_command_id,
        policyVersion: FAST_PATH_EXTRACTION_POLICY_VERSION,
      },
    });
    expect(replay.outcome).toBe("already_extracted");
    expect(await countRows("evidence_items")).toBe(2);
    expect(await countRows("fast_path_session_items")).toBe(2);
    expect(await countRows("memory_candidates")).toBe(2);
  });

  it("resolves deterministically first and commits the entity.resolve gate only on match ∧ confidence ≥ t_auto", async () => {
    // 上海 turn introduces 妈妈 as a named new person → unresolved Entity with
    // label 妈妈. 身体 turn mentions 媽媽 twice (traditional form) — homophone
    // near-forms become candidates only. 回家 turn's mention binds through the
    // scripted gate.
    extractScript = (revisions) => {
      const results: MemoryExtractRevisionResult[] = [];
      for (const revision of revisions) {
        const text = revision.text;
        const span = `0:${text.length}`;
        if (text.includes("上海")) {
          results.push({
            revisionId: revision.revisionId,
            evidence: [{ locatorKey: span, role: "factual_support" }],
            mentions: [
              {
                surfaceForm: "妈妈",
                startOffset: text.indexOf("妈妈"),
                endOffset: text.indexOf("妈妈") + 2,
                mentionKind: "named",
                newIntroduction: true,
                entityKindId: "sh.entity.person",
                evidenceLocatorKey: span,
              },
            ],
            candidates: [],
            clarifications: [],
          });
        } else if (text.includes("身体")) {
          const firstAt = text.indexOf("媽媽");
          const secondAt = text.indexOf("媽媽", firstAt + 2);
          results.push({
            revisionId: revision.revisionId,
            evidence: [{ locatorKey: span, role: "factual_support" }],
            mentions: [
              {
                surfaceForm: "媽媽",
                startOffset: firstAt,
                endOffset: firstAt + 2,
                mentionKind: "named",
                newIntroduction: false,
                entityKindId: "sh.entity.person",
                evidenceLocatorKey: span,
              },
              {
                surfaceForm: "媽媽",
                startOffset: secondAt,
                endOffset: secondAt + 2,
                mentionKind: "named",
                newIntroduction: false,
                entityKindId: "sh.entity.person",
                evidenceLocatorKey: span,
              },
            ],
            candidates: [],
            clarifications: [],
          });
        } else if (text.includes("回家")) {
          results.push({
            revisionId: revision.revisionId,
            evidence: [{ locatorKey: span, role: "factual_support" }],
            mentions: [
              {
                surfaceForm: "媽媽",
                startOffset: text.indexOf("媽媽"),
                endOffset: text.indexOf("媽媽") + 2,
                mentionKind: "named",
                newIntroduction: false,
                entityKindId: "sh.entity.person",
                evidenceLocatorKey: span,
              },
            ],
            candidates: [],
            clarifications: [],
          });
        } else {
          results.push({
            revisionId: revision.revisionId,
            evidence: [{ locatorKey: span, role: "factual_support" }],
            mentions: [],
            candidates: [],
            clarifications: [],
          });
        }
      }
      return results;
    };
    await submitTurn("我妈妈住在上海。");
    await dispatch();

    const entities = await database.pool.query<{ entity_id: string }>(
      `SELECT e.entity_id FROM entities e
       JOIN entity_labels l ON l.entity_id = e.entity_id AND l.label_kind = 'primary'
       WHERE e.user_id = $1 AND l.label = '妈妈'`,
      [OWNER],
    );
    expect(entities.rows).toHaveLength(1);
    const motherEntityId = entities.rows[0]!.entity_id;

    // The pipeline itself drove the gate on both bounded-ambiguous mentions
    // with the scripted responses (call order follows mention order):
    // call 1 — match but confidence below t_auto; call 2 — match but a
    // selection outside the candidate list. Both fail closed and stay
    // unbound; every outcome is audited.
    resolveScript = (() => {
      let gateCall = 0;
      return () => {
        gateCall += 1;
        if (gateCall === 1) {
          return { verdict: "match" as const, entityId: motherEntityId, confidence: 0.85 };
        }
        return {
          verdict: "match" as const,
          entityId: "00000000-0000-7000-8000-000000000099",
          confidence: 0.99,
        };
      };
    })();
    await submitTurn("媽媽最近身体不太好，媽媽很辛苦。");
    advanceMs(5_000);
    await dispatch();

    const outcomes = await database.pool.query(
      "SELECT committed, not_committed_reason FROM entity_resolve_gate_outcomes ORDER BY confidence",
    );
    expect(outcomes.rows).toHaveLength(2);
    expect(outcomes.rows[0]).toMatchObject({
      committed: false,
      not_committed_reason: "confidence_below_t_auto",
    });
    expect(outcomes.rows[1]).toMatchObject({
      committed: false,
      not_committed_reason: "selection_not_a_candidate",
    });
    const stillUnbound = await database.pool.query(
      "SELECT COUNT(*)::text AS count FROM entity_mentions WHERE user_id = $1 AND resolution_status = 'unresolved'",
      [OWNER],
    );
    expect(Number(stillUnbound.rows[0]!.count)).toBe(2);
    expect(entityResolveCalls).toBe(2);

    // Deterministic lanes held: the introduction created exactly one
    // unresolved Entity labeled 妈妈, and the traditional-form mentions were
    // homophone near-form CANDIDATES only — recorded for the gate, never a
    // bind (ADR-0088).
    const candidates = await database.pool.query<{ candidate_entity_id: string }>(
      `SELECT c.candidate_entity_id FROM entity_mention_candidates c
       JOIN entity_mentions m ON m.entity_mention_id = c.entity_mention_id
       WHERE m.user_id = $1 AND m.resolution_status = 'unresolved'`,
      [OWNER],
    );
    expect(candidates.rows).toHaveLength(2);
    for (const row of candidates.rows) {
      expect(row.candidate_entity_id).toBe(motherEntityId);
    }

    // Gate commit through the pipeline: the 回家 mention binds when the
    // scripted gate returns match with a candidate id at ≥ t_auto.
    resolveScript = (input) => ({
      verdict: "match",
      entityId: input.candidates[0]!.entityId,
      confidence: 0.95,
    });
    await submitTurn("媽媽讓我早點回家。");
    advanceMs(2_000);
    await dispatch();
    const bound = await database.pool.query<{ resolved_entity_id: string }>(
      `SELECT resolved_entity_id FROM entity_mentions
       WHERE user_id = $1 AND resolved_entity_id IS NOT NULL AND mention_kind = 'named'`,
      [OWNER],
    );
    expect(bound.rows.map((row) => row.resolved_entity_id)).toContain(
      motherEntityId,
    );
    expect(entityResolveCalls).toBe(3);
  });

  it("records fast_path_pending in the compiled context while lagging and clears it once extraction lands", async () => {
    const contextCompiler = createContextCompiler({
      clock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
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
            chunks: ["I hear you."],
          }),
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });

    for await (const _event of responseService.respond(OWNER, {
      clientEventId: "fast-path-response-event-1",
      clientTurnId: "fast-path-response-turn-1",
      locale: "zh-CN",
      text: "我今天有点累。",
      timezone: "Asia/Shanghai",
    })) {
      void _event;
    }

    const pendingManifest = await database.pool.query<{ degraded_reason: string }>(
      `SELECT degraded_reason FROM compiled_contexts
       WHERE degraded_reason = 'fast_path_pending'`,
    );
    expect(pendingManifest.rows.length).toBeGreaterThan(0);

    advanceMs(4_000);
    await dispatch();
    const sessionLocal = await fastPathRepository.readSessionLocalContext({
      dailySessionId: (
        await database.pool.query<{ daily_session_id: string }>(
          "SELECT daily_session_id FROM daily_sessions LIMIT 1",
        )
      ).rows[0]!.daily_session_id,
    });
    expect(sessionLocal.pendingRevisionCount).toBe(0);

    for await (const _event of responseService.respond(OWNER, {
      clientEventId: "fast-path-response-event-2",
      clientTurnId: "fast-path-response-turn-2",
      locale: "zh-CN",
      text: "明天想聊聊工作的事。",
      timezone: "Asia/Shanghai",
    })) {
      void _event;
    }
    // The newest turn is pending again (extraction async), but the previous
    // turn's compile after extraction is proven by the pending count of 1
    // (not 2): the first turn is no longer lagging.
    const pending = await database.pool.query<{ pending: string }>(
      `SELECT COUNT(*)::text AS pending
       FROM conversation_events event
       JOIN conversation_event_revisions revision
         ON revision.conversation_event_revision_id = event.current_revision_id
       WHERE event.actor = 'user' AND event.event_type = 'message'
         AND NOT EXISTS (
           SELECT 1 FROM fast_path_extraction_runs run
           WHERE run.event_revision_id = revision.conversation_event_revision_id
             AND run.status = 'extracted'
         )`,
    );
    expect(Number(pending.rows[0]!.pending)).toBe(1);
  });

  it("serves same-day session-local context only, scoped to the session", async () => {
    const first = await submitTurn("我妈妈住在上海。");
    await dispatch();
    let context = await fastPathRepository.readSessionLocalContext({
      dailySessionId: first.dailySessionId,
    });
    expect(context.items).toHaveLength(1);
    expect(context.pendingRevisionCount).toBe(0);

    // A different day / session sees nothing (same-day session-local only).
    // ADR-0012: an active session is not split at midnight, so the exchange
    // ends explicitly before the next day's submit opens a new session.
    await conversationService.endContinuousExchange(OWNER, {
      dailySessionId: first.dailySessionId,
    });
    advanceMs(24 * 60 * 60 * 1_000);
    const otherDay = await submitTurn("新的一天。");
    expect(otherDay.dailySessionId).not.toBe(first.dailySessionId);
    context = await fastPathRepository.readSessionLocalContext({
      dailySessionId: otherDay.dailySessionId,
    });
    expect(context.items).toHaveLength(0);
    expect(context.pendingRevisionCount).toBe(1);
  });

  it("produces new commands on correction and retires the old revision's derivatives", async () => {
    const first = await submitTurn("我妈妈住在上海。");
    advanceMs(1_000);
    await dispatch();
    expect(await countRows("fast_path_extraction_runs", "WHERE status = 'extracted'")).toBe(1);
    expect(await countRows("fast_path_session_items")).toBe(1);

    const corrected = await conversationService.correct(OWNER, {
      eventId: first.eventId,
      locale: "zh-CN",
      text: "我妈妈住在杭州。",
    });

    const commands = await database.pool.query<{ subject_id: string; source_revision: string }>(
      `SELECT subject_id, source_revision::text FROM workflow_commands
       WHERE command_type = 'fast_path_extraction'
       ORDER BY source_revision`,
    );
    expect(commands.rows).toHaveLength(2);
    expect(commands.rows[1]).toMatchObject({
      subject_id: expect.any(String),
      source_revision: "2",
    });
    expect(commands.rows[1]!.subject_id).not.toBe(first.revisionId);

    // The old revision's derivatives retired in the correction transaction.
    expect(await countRows("fast_path_extraction_runs", "WHERE status = 'retired'")).toBe(1);
    expect(await countRows("fast_path_session_items", "WHERE retired_at IS NOT NULL")).toBe(1);

    advanceMs(2_000);
    await dispatch();
    const newRun = await database.pool.query<{ status: string }>(
      "SELECT status FROM fast_path_extraction_runs WHERE event_revision_id = $1",
      [commands.rows[1]!.subject_id],
    );
    expect(newRun.rows[0]).toMatchObject({ status: "extracted" });
    expect(corrected.dailySessionId).toBe(first.dailySessionId);
  });

  it("fails loudly on a failed role without writing and converges on retry", async () => {
    const turn = await submitTurn("今天聊了很多。");
    extractScript = () => {
      throw new Error("memory.extract dispatch failed with 529");
    };
    const failed = await dispatch();
    expect(failed.dispatched).toBe(1);

    const run = await database.pool.query<{
      status: string;
      error_code: string;
    }>(
      "SELECT status, error_code FROM fast_path_extraction_runs WHERE event_revision_id = $1",
      [turn.revisionId],
    );
    expect(run.rows[0]).toMatchObject({
      status: "retryable_failed",
      error_code: "provider_server_error",
    });
    expect(await countRows("evidence_items")).toBe(0);
    expect(await countRows("memory_candidates")).toBe(0);

    // Retry with a healthy script converges (fallback disabled: exactly one
    // provider attempt per dispatch). The outbox already recorded the
    // receipt; retry is the Workflow machinery calling the entrypoint again.
    extractScript = defaultExtractScript;
    const retried = await runFastPathExtraction({
      dependencies: entrypointDependencies("wf-retry"),
      command: {
        workflowCommandId: (
          await database.pool.query<{ workflow_command_id: string }>(
            "SELECT workflow_command_id FROM workflow_commands WHERE command_type = 'fast_path_extraction' AND subject_id = $1",
            [turn.revisionId],
          )
        ).rows[0]!.workflow_command_id,
        policyVersion: FAST_PATH_EXTRACTION_POLICY_VERSION,
      },
    });
    expect(retried.outcome).toBe("extracted");
    const recovered = await database.pool.query<{ status: string }>(
      "SELECT status FROM fast_path_extraction_runs WHERE event_revision_id = $1",
      [turn.revisionId],
    );
    expect(recovered.rows[0]).toMatchObject({ status: "extracted" });
  });

  it("commits Entity Clarification once per topic and drops it on disengagement", async () => {
    // Two same-label person introductions make later same-form mentions
    // multi-exact ambiguous; the model may propose one clarification.
    extractScript = (revisions) => {
      const results: MemoryExtractRevisionResult[] = [];
      for (const revision of revisions) {
        const text = revision.text;
        const span = `0:${text.length}`;
        if (text.includes("同事") || text.includes("邻居")) {
          results.push({
            revisionId: revision.revisionId,
            evidence: [{ locatorKey: span, role: "factual_support" }],
            mentions: [
              {
                surfaceForm: "小王",
                startOffset: text.indexOf("小王"),
                endOffset: text.indexOf("小王") + 2,
                mentionKind: "named",
                newIntroduction: true,
                entityKindId: "sh.entity.person",
                evidenceLocatorKey: span,
              },
            ],
            candidates: [],
            clarifications: [],
          });
        } else if (text.includes("小王")) {
          const at = text.indexOf("小王");
          results.push({
            revisionId: revision.revisionId,
            evidence: [{ locatorKey: span, role: "factual_support" }],
            mentions: [
              {
                surfaceForm: "小王",
                startOffset: at,
                endOffset: at + 2,
                mentionKind: "named",
                newIntroduction: false,
                entityKindId: "sh.entity.person",
                evidenceLocatorKey: span,
              },
            ],
            candidates: [],
            clarifications: [
              {
                mentionIndex: 0,
                semanticImpact: "person_identity",
                questionText: "你说的小王是哪一位小王？",
              },
            ],
          });
        } else {
          results.push({
            revisionId: revision.revisionId,
            evidence: [{ locatorKey: span, role: "factual_support" }],
            mentions: [],
            candidates: [],
            clarifications: [],
          });
        }
      }
      return results;
    };
    await submitTurn("小王是我的同事。");
    await dispatch();
    await submitTurn("小王今天帮了我大忙。");
    await dispatch();

    let proposals = await database.pool.query<{
      topic_key: string;
      status: string;
    }>(
      "SELECT topic_key, status FROM entity_clarification_proposals",
    );
    // One named introduction created one Entity; the second same-form mention
    // exact-binds to it (deterministic lane), so no ambiguity arises and no
    // clarification commits — deterministic code decides, not the model.
    expect(proposals.rows).toHaveLength(0);

    // Now make the mention genuinely ambiguous: two introductions, then a
    // bare re-mention with a model-proposed clarification.
    await submitTurn("我认识了另一个小王，他是我的邻居。");
    await dispatch();
    await submitTurn("小王约我周末吃饭。");
    await dispatch();
    proposals = await database.pool.query<{
      topic_key: string;
      status: string;
      question_text: string;
    }>("SELECT topic_key, status, question_text FROM entity_clarification_proposals");
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0]).toMatchObject({
      topic_key: "小王",
      status: "committed",
      question_text: "你说的小王是哪一位小王？",
    });

    // The topic-scoped stop: a later revision that moves on drops it for the
    // rest of the topic, and it never escalates to the question-stop state.
    await submitTurn("算了，说点别的，我最近在学吉他。");
    await dispatch();
    const droppedProposals = await database.pool.query<{ status: string }>(
      "SELECT status FROM entity_clarification_proposals",
    );
    expect(droppedProposals.rows[0]).toMatchObject({ status: "dropped" });
    expect(await countRows("curiosity_stop_signals")).toBe(0);
  });
});
