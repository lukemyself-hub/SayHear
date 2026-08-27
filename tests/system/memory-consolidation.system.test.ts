import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  createContinuousExchangeService,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  FAST_PATH_EXTRACTION_POLICY_VERSION,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  MEMORY_CONSOLIDATION_POLICY_VERSION,
  createConversationAgentHarness,
  createContextCompiler,
  createConversationResponseService,
  createEntityService,
  createOutboxDispatcherService,
  createUserTextConversationService,
  loadPredicateRegistrySnapshot,
  runFastPathExtraction,
  runMemoryConsolidation,
  type EntityResolveGateProvider,
  type EntityResolveGateResponse,
  type FastPathExtractionEntrypointDependencies,
  type MemoryConsolidateModelInput,
  type MemoryConsolidateProvider,
  type MemoryConsolidateResult,
  type MemoryExtractProvider,
  type MemoryExtractRevisionResult,
} from "@sayhear/application";
import {
  PostgresContinuousExchangeRepository,
  PostgresEntityRepository,
  PostgresFastPathExtractionRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresMemoryConsolidationRepository,
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
 * SPEC #107 "Two-speed pipeline" slow-path half (ticket #114), proven against
 * real PostgreSQL through the authenticated conversation seam plus the real
 * outbox / workflow machinery — no sleeps. The controllable domain clock
 * drives every day boundary: a day-1 direct statement becomes a Claim only
 * via daily consolidation (never the fast path); an Impression promotes only
 * after evidence from two different Daily Sessions; weekly consolidation
 * advances dormancy at the 30-day review cycle; the sweeper enforces the
 * 30-day predicate-review stale and the 7-day terminal content purge; runs
 * are idempotent under retry; a failed memory.consolidate role fails loudly.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const BASE_TIME = new Date("2026-08-27T08:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1_000;

let database: IsolatedPostgresSchema;

let clockNowMs = BASE_TIME;
const clock = () => new Date(clockNowMs);
const advanceDays = (days: number) => {
  clockNowMs += days * DAY_MS;
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

describe("Slow-path consolidation system seam", () => {
  let conversationService: ReturnType<typeof createUserTextConversationService>;
  let entityRepository: PostgresEntityRepository;
  let fastPathRepository: PostgresFastPathExtractionRepository;
  let consolidationRepository: PostgresMemoryConsolidationRepository;
  let responseRepository: PostgresConversationResponseRepository;
  let dispatch: () => Promise<{ dispatched: number; failed: number }>;
  let quiesceActiveSession: () => Promise<number>;
  let scan: () => Promise<{ daily: number; weekly: number; sweeper: number; reArmed: number }>;
  let memoryExtractCalls: number;
  let consolidateCalls: number;
  let submitCount = 0;

  // Scripted determinism replacements (SPEC Testing Decisions): memory.extract
  // proposes per revision, memory.consolidate proposes diffs per run — both
  // scripted through the seam.
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
  let consolidateScript: (
    input: MemoryConsolidateModelInput,
  ) => MemoryConsolidateResult = () => ({ diffs: [] });

  const memoryExtract: MemoryExtractProvider = {
    role: "memory.extract",
    async extract(request, _invocation) {
      memoryExtractCalls += 1;
      return extractScript(request.revisions);
    },
  };
  const entityResolve: EntityResolveGateProvider = {
    role: "entity.resolve",
    async resolve(_request, _invocation): Promise<EntityResolveGateResponse> {
      return { verdict: "unclear", entityId: null, confidence: 0 };
    },
  };
  const memoryConsolidate: MemoryConsolidateProvider = {
    role: "memory.consolidate",
    async consolidate(request, _invocation) {
      consolidateCalls += 1;
      return consolidateScript(request);
    },
  };

  function fastPathDependencies(
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

  function consolidationDependencies(workflowReceiptId: string) {
    return {
      clock,
      repository: consolidationRepository,
      memoryConsolidate,
      memoryConsolidateConfiguration: {
        role: "memory.consolidate" as const,
        configVersion: "memory-consolidate-champion:v1",
        modelVersion: "gpt-5.4",
        promptVersion: "memory-consolidate:diffs:v1",
        fallback: { mode: "disabled" as const },
      },
      registry: {
        entryFor(predicateId: string) {
          return (
            registrySnapshot.entries.find((entry) => entry.predicateId === predicateId) ??
            null
          );
        },
        registryVersion: () => registrySnapshot.registryVersion,
      },
      policy: { version: MEMORY_CONSOLIDATION_POLICY_VERSION },
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
      clientEventId: `consolidation-event-${submitCount}`,
      clientTurnId: `consolidation-turn-${submitCount}`,
      locale,
      text,
      timezone: "UTC",
    });
    return {
      eventId: turn.message.id,
      revisionId: turn.message.revisionId,
      dailySessionId: turn.dailySession.id,
    };
  }

  /** Fast-path extraction proposal for a direct objective statement. */
  function objectiveExtractScript(predicateId: string, typedValue: string) {
    return (
      revisions: readonly Readonly<{ revisionId: string; text: string }>[],
    ): MemoryExtractRevisionResult[] =>
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
            predicateId,
            proposedConcept: null,
            typedValue,
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
            itemClass: "preference",
            itemSummary: `stated: ${typedValue}`,
          },
        ],
        clarifications: [],
      }));
  }

  /** Fast-path extraction proposal for an inferred impression candidate. */
  function impressionExtractScript(predicateId: string, typedValue: string) {
    return (
      revisions: readonly Readonly<{ revisionId: string; text: string }>[],
    ): MemoryExtractRevisionResult[] =>
      revisions.map((revision) => ({
        revisionId: revision.revisionId,
        evidence: [
          { locatorKey: `0:${revision.text.length}`, role: "subjective_report" as const },
        ],
        mentions: [],
        candidates: [
          {
            basis: "inferred" as const,
            candidateKind: "impression" as const,
            predicateId,
            proposedConcept: null,
            typedValue,
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
            itemClass: "open",
            itemSummary: `inferred: ${typedValue}`,
          },
        ],
        clarifications: [],
      }));
  }

  async function currentClaims() {
    const result = await database.pool.query<{
      memory_claim_id: string;
      kind: string;
      predicate_id: string;
      current_status: string | null;
      epistemic_status: string | null;
      typed_value: unknown;
      revision: number;
    }>(
      `SELECT claim.memory_claim_id, version.kind, claim.predicate_id,
              version.status AS current_status,
              version.epistemic_status, version.typed_value, version.revision
       FROM memory_claims claim
       LEFT JOIN memory_claim_versions version
         ON version.memory_claim_version_id = claim.current_version_id
       ORDER BY claim.memory_claim_id`,
    );
    return result.rows;
  }

  async function pendingCandidateIds() {
    const result = await database.pool.query<{ memory_candidate_id: string }>(
      `SELECT memory_candidate_id FROM memory_candidates
       WHERE status IN ('proposed', 'needs_entity_resolution')
       ORDER BY memory_candidate_id`,
    );
    return result.rows.map((row) => row.memory_candidate_id);
  }

  /** Consolidate script helper: propose_new over every pending candidate. */
  function proposeAllCandidatesScript() {
    return (input: MemoryConsolidateModelInput): MemoryConsolidateResult => ({
      diffs: input.candidates.map((candidate) => ({
        kind: "propose_new" as const,
        candidateId: candidate.candidateId,
        proposal: null,
        evidenceItemIds: candidate.evidence.map((item) => item.evidenceItemId),
      })),
    });
  }

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    const accessRepository = new PostgresInternalOwnerAccessRepository(
      database.pool,
    );
    await accessRepository.provisionInternalOwner({
      issuer: "https://github.com",
      subject: "consolidation-test-owner",
      userId: OWNER,
    });

    entityRepository = new PostgresEntityRepository(database.pool);
    fastPathRepository = new PostgresFastPathExtractionRepository(database.pool);
    consolidationRepository = new PostgresMemoryConsolidationRepository(database.pool);
    responseRepository = new PostgresConversationResponseRepository(database.pool);
    conversationService = createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      fastPathExtractionPolicyVersion: FAST_PATH_EXTRACTION_POLICY_VERSION,
      generationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const continuousExchangeService = createContinuousExchangeService({
      clock,
      repository: new PostgresContinuousExchangeRepository(database.pool),
    });
    // Daily Sessions do not split at midnight (ADR-0012): a new logical-date
    // session opens only after the previous one went quiescent through the
    // real inactivity machinery. Tests drive that with the domain clock.
    quiesceActiveSession = async () => {
      const result = await continuousExchangeService.scanDueInactivity();
      return result.applied;
    };
    let workflowCounter = 0;
    dispatch = async () => {
      const dispatcher = createOutboxDispatcherService({
        clock,
        leaseDurationMs: 60_000,
        leaseOwner: "consolidation-system-test",
        repository: new PostgresOutboxDispatcherRepository(database.pool),
        startWorkflow: async (input) => {
          workflowCounter += 1;
          const receipt = `wf-consolidation-${workflowCounter}`;
          if (input.eventType === "journal_eligibility_requested") {
            // Exchange-end eligibility follow-ups are out of scope here; the
            // memory workflows under test do not depend on them.
            return { workflowReceiptId: receipt };
          }
          if (input.eventType === "fast_path_extraction_requested") {
            await runFastPathExtraction({
              dependencies: fastPathDependencies(receipt),
              command: {
                workflowCommandId: input.workflowCommandId,
                policyVersion: input.policyVersion,
              },
            });
          } else {
            await runMemoryConsolidation({
              dependencies: consolidationDependencies(receipt),
              command: {
                workflowCommandId: input.workflowCommandId,
                policyVersion: input.policyVersion,
              },
            });
          }
          return { workflowReceiptId: receipt };
        },
      });
      return dispatcher.dispatchPending();
    };
    scan = async () =>
      consolidationRepository.queueDueCommands({
        now: clock(),
        policyVersion: MEMORY_CONSOLIDATION_POLICY_VERSION,
      });
  }, 20_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME;
    memoryExtractCalls = 0;
    consolidateCalls = 0;
    extractScript = (revisions) =>
      revisions.map((revision) => ({
        revisionId: revision.revisionId,
        evidence: [
          { locatorKey: `0:${revision.text.length}`, role: "factual_support" as const },
        ],
        mentions: [],
        candidates: [],
        clarifications: [],
      }));
    consolidateScript = () => ({ diffs: [] });
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

  it("promotes a day-1 direct statement into a Claim only via daily consolidation, idempotently", async () => {
    extractScript = objectiveExtractScript("sh.place.residence", "上海");
    await submitTurn("我住在上海。");
    await dispatch();

    // The fast path never Claims (SPEC story 29): only the pending candidate exists.
    expect(await currentClaims()).toHaveLength(0);
    expect(await pendingCandidateIds()).toHaveLength(1);

    // Day boundary: the same local day is not yet due.
    advanceDays(0.5);
    expect((await scan()).daily).toBe(0);

    // Next local day: the day-1 anchor becomes due and dispatches.
    advanceDays(0.5);
    consolidateScript = proposeAllCandidatesScript();
    const queued = await scan();
    expect(queued.daily).toBe(1);
    expect(queued.sweeper).toBe(0);
    await dispatch();

    const claims = await currentClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      kind: "objective",
      predicate_id: "sh.place.residence",
      current_status: "active",
      epistemic_status: "confirmed",
      revision: 1,
    });
    expect(claims[0]!.typed_value).toBe("上海");
    expect(await pendingCandidateIds()).toHaveLength(0);
    const accepted = await database.pool.query(
      `SELECT status FROM memory_candidates WHERE status = 'accepted'`,
    );
    expect(accepted.rows).toHaveLength(1);

    // Idempotent under retry: re-running the same command converges without a
    // second Claim or ClaimVersion.
    const command = await database.pool.query<{ workflow_command_id: string }>(
      `SELECT workflow_command_id FROM workflow_commands
       WHERE command_type = 'daily_consolidation'`,
    );
    expect(command.rows).toHaveLength(1);
    const replay = await runMemoryConsolidation({
      dependencies: consolidationDependencies("wf-replay-1"),
      command: {
        workflowCommandId: command.rows[0]!.workflow_command_id,
        policyVersion: MEMORY_CONSOLIDATION_POLICY_VERSION,
      },
    });
    expect(replay.outcome).toBe("already_consolidated");
    expect((await currentClaims())).toHaveLength(1);
    const versions = await database.pool.query(
      `SELECT COUNT(*)::int AS count FROM memory_claim_versions`,
    );
    expect(versions.rows[0]!.count).toBe(1);

    // A later scan creates no duplicate command for the completed anchor.
    advanceDays(1);
    expect((await scan()).daily).toBe(0);
  });

  it("promotes an impression only after evidence from two different Daily Sessions", async () => {
    // Day 1: two same-topic impression turns in ONE session — repetition
    // inside a single Session can never promote (ADR-0039).
    extractScript = impressionExtractScript("sh.communication.stated_style", "direct");
    await submitTurn("我更喜欢直接一点的沟通方式。");
    await submitTurn("还是直接说比较好，不用绕弯子。");
    await dispatch();
    expect(await pendingCandidateIds()).toHaveLength(2);

    advanceDays(1);
    consolidateScript = (input) => ({
      diffs: [
        {
          kind: "propose_new" as const,
          candidateId: null,
          proposal: {
            basis: "inferred" as const,
            candidateKind: "impression" as const,
            predicateId: "sh.communication.stated_style",
            proposedConcept: null,
            typedValue: "direct",
            scopeKey: "",
            temporal: {
              temporalStatus: "current" as const,
              validFrom: null,
              validFromPrecision: "unknown" as const,
              validTo: null,
              validToPrecision: "unknown" as const,
            },
            evidenceItemIds: input.candidates.flatMap((candidate) =>
              candidate.evidence.map((item) => item.evidenceItemId),
            ),
          },
          evidenceItemIds: [],
        },
      ],
    });
    expect((await scan()).daily).toBe(1);
    await dispatch();

    // Two evidence items, one Daily Session: the deterministic floor holds.
    expect(await currentClaims()).toHaveLength(0);
    const belowFloor = await database.pool.query(
      `SELECT outcome, reason_code FROM memory_consolidation_diffs
       WHERE outcome = 'below_impression_floor'`,
    );
    expect(belowFloor.rows).toHaveLength(1);
    expect(belowFloor.rows[0]!.reason_code).toContain("actual=2e/1s");

    // Day 2: quiesce the day-1 session through the real inactivity
    // machinery, then open a new Daily Session with fresh evidence.
    await quiesceActiveSession();
    await submitTurn("我说了，直接讲就好。");
    await dispatch();
    // Day-1 originals + the below-floor aggregate + the day-2 candidate.
    expect(await pendingCandidateIds()).toHaveLength(4);

    advanceDays(1);
    expect((await scan()).daily).toBe(1);
    await dispatch();

    const claims = await currentClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      kind: "impression",
      predicate_id: "sh.communication.stated_style",
      current_status: "active",
      epistemic_status: "inferred",
    });
    expect(claims[0]!.typed_value).toBe("direct");
    const supportLinks = await database.pool.query(
      `SELECT COUNT(DISTINCT link.evidence_item_id)::int AS items,
              COUNT(DISTINCT snapshot.daily_session_id)::int AS sessions
       FROM claim_evidence_links link
       INNER JOIN evidence_items item
         ON item.evidence_item_id = link.evidence_item_id
       INNER JOIN evidence_source_snapshots snapshot
         ON snapshot.evidence_source_snapshot_id = item.evidence_source_snapshot_id
       WHERE link.memory_claim_version_id = (
         SELECT current_version_id FROM memory_claims
       ) AND link.link_role = 'support'`,
    );
    expect(supportLinks.rows[0]!.items).toBeGreaterThanOrEqual(2);
    expect(supportLinks.rows[0]!.sessions).toBe(2);
  });

  it("advances impression dormancy at the 30-day review cycle through weekly consolidation", async () => {
    // Build an active impression Claim across two sessions (days 1 and 2).
    extractScript = impressionExtractScript("sh.communication.stated_style", "direct");
    await submitTurn("我更喜欢直接一点的沟通方式。");
    await dispatch();
    advanceDays(1);
    await quiesceActiveSession();
    await submitTurn("还是直接说比较好。");
    await dispatch();
    advanceDays(1);
    consolidateScript = (input) => ({
      diffs: [
        {
          kind: "propose_new" as const,
          candidateId: null,
          proposal: {
            basis: "inferred" as const,
            candidateKind: "impression" as const,
            predicateId: "sh.communication.stated_style",
            proposedConcept: null,
            typedValue: "direct",
            scopeKey: "",
            temporal: {
              temporalStatus: "current" as const,
              validFrom: null,
              validFromPrecision: "unknown" as const,
              validTo: null,
              validToPrecision: "unknown" as const,
            },
            evidenceItemIds: input.candidates.flatMap((candidate) =>
              candidate.evidence.map((item) => item.evidenceItemId),
            ),
          },
          evidenceItemIds: [],
        },
      ],
    });
    await scan();
    await dispatch();
    expect(await currentClaims()).toHaveLength(1);
    const claimId = (await currentClaims())[0]!.memory_claim_id;

    // Within the 30-day cycle: weekly runs keep the impression active.
    advanceDays(7);
    await scan();
    await dispatch();
    expect((await currentClaims())[0]!.current_status).toBe("active");

    // Past the review deadline with no fresh Evidence: the weekly pass
    // advances dormancy deterministically (ADR-0041).
    advanceDays(31);
    await scan();
    await dispatch();
    const afterDormancy = (await currentClaims()).filter(
      (claim) => claim.memory_claim_id === claimId,
    );
    expect(afterDormancy[0]!.current_status).toBe("dormant");
    const versions = await database.pool.query<{ status: string; created_by: string }>(
      `SELECT status, created_by FROM memory_claim_versions
       WHERE memory_claim_id = $1 ORDER BY revision`,
      [claimId],
    );
    expect(versions.rows.at(-1)).toMatchObject({
      status: "dormant",
      created_by: "dormancy_review",
    });
    // Objective Memory never decays with silence — nothing else was touched.
    expect(versions.rows).toHaveLength(2);
  });

  it("sweeper: needs_predicate_review stales at 30 days and terminal content purges after 7", async () => {
    // An unmapped concept routes to needs_predicate_review with a 30-day
    // review deadline (fast path).
    extractScript = (
      revisions: readonly Readonly<{ revisionId: string; text: string }>[],
    ): MemoryExtractRevisionResult[] =>
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
            predicateId: null,
            proposedConcept: "concept:干亲关系",
            typedValue: "干亲关系",
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
            itemClass: "open",
            itemSummary: "unmapped concept",
          },
        ],
        clarifications: [],
      }));
    await submitTurn("他是我干儿子。");
    await dispatch();

    const review = await database.pool.query<{
      memory_candidate_id: string;
      status: string;
      review_due_at: Date;
    }>(
      `SELECT memory_candidate_id, status, review_due_at FROM memory_candidates`,
    );
    expect(review.rows).toHaveLength(1);
    expect(review.rows[0]!.status).toBe("needs_predicate_review");
    expect(review.rows[0]!.review_due_at).toBeTruthy();
    const candidateId = review.rows[0]!.memory_candidate_id;
    const originalDeadline = review.rows[0]!.review_due_at as Date;

    // Day 29: nothing is due yet.
    advanceDays(29);
    expect((await scan()).sweeper).toBe(0);

    // Day 30+: the sweeper stales the candidate with the ORIGINAL deadline
    // as terminal_effective_at (ADR-0051: sweeper delay never extends it).
    advanceDays(2);
    expect((await scan()).sweeper).toBe(1);
    await dispatch();
    const staled = await database.pool.query<{
      status: string;
      terminal_effective_at: Date;
      terminal_content_expires_at: Date;
      content_purged_at: Date | null;
      proposed_concept: string | null;
      dedupe_fingerprint: string | null;
    }>(
      `SELECT status, terminal_effective_at, terminal_content_expires_at,
              content_purged_at, proposed_concept, dedupe_fingerprint
       FROM memory_candidates WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    expect(staled.rows[0]!.status).toBe("stale");
    expect(staled.rows[0]!.terminal_effective_at!.getTime()).toBe(
      originalDeadline.getTime(),
    );
    expect(staled.rows[0]!.proposed_concept).toBe("concept:干亲关系");
    expect(staled.rows[0]!.content_purged_at).toBeNull();

    // Within the 7-day grace the audit content is still readable.
    advanceDays(5);
    await scan();
    await dispatch();
    const stillReadable = await database.pool.query(
      `SELECT proposed_concept, content_purged_at FROM memory_candidates
       WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    expect(stillReadable.rows[0]!.proposed_concept).toBe("concept:干亲关系");

    // Past the 7-day window: derived semantics cleared, envelope retained.
    advanceDays(2);
    await scan();
    await dispatch();
    const purged = await database.pool.query(
      `SELECT proposed_concept, proposed_object_value, proposed_scope_key,
              predicate_id, content_purged_at, dedupe_fingerprint,
              dedupe_fingerprint_key_version, disposition_reason_code,
              terminal_effective_at
       FROM memory_candidates WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    const row = purged.rows[0]!;
    expect(row.proposed_concept).toBeNull();
    expect(row.proposed_object_value).toBeNull();
    expect(row.proposed_scope_key).toBeNull();
    expect(row.predicate_id).toBeNull();
    expect(row.content_purged_at).not.toBeNull();
    // The audit envelope survives (ADR-0051 whitelist).
    expect(row.dedupe_fingerprint).toBeTruthy();
    expect(row.dedupe_fingerprint_key_version).toBe("dedupe-fingerprint-key:v1");
    expect(row.disposition_reason_code).toBe("predicate_review_expired");
    expect(row.terminal_effective_at).not.toBeNull();
  });

  it("fails loudly when the memory.consolidate role fails, and re-arms through the scan", async () => {
    extractScript = objectiveExtractScript("sh.place.residence", "上海");
    await submitTurn("我住在上海。");
    await dispatch();
    advanceDays(1);

    consolidateScript = () => {
      throw new Error("provider timeout");
    };
    await scan();
    await dispatch();

    const failed = await database.pool.query<{
      status: string;
      error_code: string;
    }>(
      `SELECT status, error_code FROM memory_consolidation_runs
       WHERE consolidation_kind = 'daily'`,
    );
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0]!.status).toBe("retryable_failed");
    expect(failed.rows[0]!.error_code).toBe("provider_timeout");
    expect(await currentClaims()).toHaveLength(0);

    // Structurally invalid model output fails loudly too.
    const commandRow = await database.pool.query<{ workflow_command_id: string }>(
      `SELECT workflow_command_id FROM workflow_commands
       WHERE command_type = 'daily_consolidation'`,
    );
    consolidateScript = () => ({ diffs: "garbage" } as unknown as ReturnType<
      typeof consolidateScript
    >);
    const invalid = await runMemoryConsolidation({
      dependencies: consolidationDependencies("wf-invalid-1"),
      command: {
        workflowCommandId: commandRow.rows[0]!.workflow_command_id,
        policyVersion: MEMORY_CONSOLIDATION_POLICY_VERSION,
      },
    });
    expect(invalid.outcome).toBe("retryable_failed");
    const invalidRun = await database.pool.query<{ error_code: string }>(
      `SELECT error_code FROM memory_consolidation_runs WHERE status = 'retryable_failed'`,
    );
    expect(invalidRun.rows[0]!.error_code).toBe("memory_consolidate_invalid_proposal");

    // The scan re-arms the failed anchor; a healthy role then completes it.
    consolidateScript = proposeAllCandidatesScript();
    const reArm = await scan();
    expect(reArm.reArmed).toBe(1);
    await dispatch();
    const claims = await currentClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      kind: "objective",
      epistemic_status: "confirmed",
    });
    const completed = await database.pool.query<{ status: string }>(
      `SELECT status FROM memory_consolidation_runs WHERE consolidation_kind = 'daily'`,
    );
    expect(completed.rows[0]!.status).toBe("consolidated");
  });

  it("keeps the model advisory: a diff the planner rejects never becomes state", async () => {
    // An inferred candidate proposed as if it were directly stated: the
    // deterministic planner routes it to below_impression_floor (single
    // session), whatever the diff label claims.
    extractScript = impressionExtractScript("sh.communication.stated_style", "direct");
    await submitTurn("我更喜欢直接一点的沟通方式。");
    await dispatch();
    advanceDays(1);
    consolidateScript = (input) => ({
      diffs: input.candidates.map((candidate) => ({
        kind: "supersede_existing" as const,
        candidateId: candidate.candidateId,
        evidenceItemIds: candidate.evidence.map((item) => item.evidenceItemId),
      })),
    });
    await scan();
    await dispatch();
    expect(await currentClaims()).toHaveLength(0);
    const outcomes = await database.pool.query<{ outcome: string }>(
      `SELECT outcome FROM memory_consolidation_diffs`,
    );
    expect(outcomes.rows).toHaveLength(1);
    expect(outcomes.rows[0]!.outcome).toBe("below_impression_floor");
  });
});
