import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createConversationAgentHarness,
  createEvidenceService,
  createJournalService,
  createJournalEligibilityService,
  createOutboxDispatcherService,
  createConversationResponseService,
  createContextCompiler,
  createUserTextConversationService,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  runJournalEligibility,
  runAutomaticJournal,
  type ConversationTextChampion,
} from "@sayhear/application";
import {
  createBehaviorAwareConversationTextModel,
  createProviderEgressPort,
} from "@sayhear/ai/testing";
import { createRuntimeJournalRoleProviderRegistry } from "@sayhear/ai";
import {
  PostgresConversationResponseRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresJournalEligibilityRepository,
  PostgresJournalRepository,
  PostgresEvidenceRepository,
  PostgresOutboxDispatcherRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

import { createConversationResponseHandler } from "../../apps/web/src/conversation-response-handler";
import { createContinuousExchangeEndHandler } from "../../apps/web/src/continuous-exchange-end-handler";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required; the system seam never falls back to a mock database.",
  );
}

const fixedResponseClock = () => new Date("2026-08-12T16:00:00.000Z");

const testChampion: ConversationTextChampion = Object.freeze({
  configVersion: "conversation-text-champion:v1",
  consentPolicyVersion: null,
  contextLimit: 1_000_000,
  dataRegion: "test",
  model: "gpt-5.4",
  provider: "openai",
  providerPolicyVersion: "openai-conversation-text:v1",
  retentionMode: "store-disabled",
  snapshot: "gpt-5.4",
  streaming: true,
  supportedLocales: ["en", "zh"],
  trainingPolicy: "test",
});

const testGenerationPolicy = Object.freeze({
  consentPolicyVersion: null,
  freshnessPolicy: "source_valid:v1" as const,
  chineseLocalePackVersion: "locale-pack-zh:v1",
  englishLocalePackVersion: "locale-pack-en:v1",
  harnessPolicyVersion: "conversation-harness:v1",
  conversationActionCatalogVersion: "conversation-action-catalog:empty:v1",
  model: "gpt-5.4",
  modelConfigVersion: "conversation-text-champion:v1",
  modelSnapshot: "gpt-5.4",
  outputFormatVersion: "conversation-output:v1",
  canonicalPersonaVersion: "canonical-persona:v1",
  personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
  personaContractInvariantVersion: "persona-contract-invariant:v1",
  productPolicyVersion: "product-policy:v1",
  taskInstructionVersion: "task-instruction-decision:v1",
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
});

const JOURNAL_ELIGIBILITY_POLICY_VERSION = "journal-eligibility:v1";
const MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH = 20;

// Production incident 2026-08-17: the Recovery Scan quiesced the session,
// admitted the journal_eligibility command at source head N, and a writer
// (recovered assistant response commit) advanced the head to N+1 before the
// durable step ran. runJournalEligibility threw "stale at the current source
// head", the workflow SDK burned all retries on the deterministic mismatch,
// and the Journal stayed unpublished until a later scan re-admitted.
describe("Journal eligibility stale-command recovery system seam", () => {
  let database: IsolatedPostgresSchema;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "test-owner",
      userId: fixedInternalOwnerPrincipal.userId,
    });
  }, 20_000);

  beforeEach(async () => {
    await database.pool.query(`
      TRUNCATE TABLE
        episode_impact_reviews,
        episode_build_runs,
        episode_version_entity_links,
        episode_evidence_links,
        episode_candidate_entity_links,
        episode_candidate_evidence_links,
        episode_candidates,
        episode_versions,
        episodes,
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
        owner_purge_operational_metadata,
        owner_purge_receipts,
        owner_purge_orders,
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
    await database.pool.query("DELETE FROM backup_policy_versions");
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
    await database.pool.query(
      "UPDATE provider_egress_policy_versions SET status = 'active'",
    );
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).recordBackupPolicyEvidence({
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

  function buildComposition() {
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const conversationRepository = new PostgresUserTextConversationRepository(
      database.pool,
    );
    const journalEligibilityRepository = new PostgresJournalEligibilityRepository(
      database.pool,
    );
    const evidenceRepository = new PostgresEvidenceRepository(database.pool, {
      role: "evidence.extract",
      extract: async ({ sourceText }) => [{
        locatorKey: `0:${sourceText.length}`,
        locatorType: "text_span",
        role: "factual_support",
      }],
    });
    const journalRoleRegistry = createRuntimeJournalRoleProviderRegistry({
      adapter: { type: "deterministic" },
      roles: [
        { role: "evidence.extract", provider: "deterministic", model: "test", configVersion: "test:evidence", policyVersion: "evidence-extraction:v1", promptFingerprint: "test:evidence" },
        { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:draft", policyVersion: "journal-generation:v2", promptFingerprint: "test:draft" },
        { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:validate", policyVersion: "journal-validator:v2", promptFingerprint: "test:validate" },
        { role: "dialogue.state", provider: "deterministic", model: "test", configVersion: "dialogue-state-model:v1", policyVersion: "dialogue-state:v2", promptFingerprint: "dialogue-state-prompt:v2" },
        { role: "summary.compress", provider: "deterministic", model: "test", configVersion: "test:summary", policyVersion: "rolling-summary:v1", promptFingerprint: "test:summary" },
        { role: "memory.extract", provider: "deterministic", model: "test", configVersion: "test:memory-extract", policyVersion: "memory-extraction:v1", promptFingerprint: "test:memory-extract" },
        { role: "entity.resolve", provider: "deterministic", model: "test", configVersion: "test:entity-resolve", policyVersion: "entity-resolve-gate:v1", promptFingerprint: "test:entity-resolve" },
{ role: "memory.consolidate", provider: "openai", model: "test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
      ],
    });
    const journalRepository = new PostgresJournalRepository(database.pool);
    const draftConfiguration = journalRoleRegistry.configuration("journal.draft");
    const validationConfiguration = journalRoleRegistry.configuration("journal.validate");
    const journalService = createJournalService({
      evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: {
        ...draftConfiguration,
        role: "journal.draft",
        rolePolicyVersion: draftConfiguration.policyVersion,
      },
      journalPolicyVersion: "journal-generation:v2",
      model: journalRoleRegistry.draft,
      repository: journalRepository,
      validationMetadata: {
        ...validationConfiguration,
        role: "journal.validate",
        rolePolicyVersion: validationConfiguration.policyVersion,
      },
      validationProvider: journalRoleRegistry.validator,
      validatorVersion: "journal-validator:v2",
    });
    const evidenceService = createEvidenceService({
      clock: fixedResponseClock,
      extractionPolicyVersion: "evidence-extraction:v1",
      champion: {
        configVersion: "evidence-champion:v1",
        model: testChampion.model,
        provider: testChampion.provider,
        providerPolicyVersion: "evidence-provider-egress:v1",
        snapshot: testChampion.snapshot,
      },
      repository: evidenceRepository,
    });
    const outboxRepository = new PostgresOutboxDispatcherRepository(
      database.pool,
    );
    const contextCompiler = createContextCompiler({
      clock: fixedResponseClock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    const conversationService = createUserTextConversationService({
      clock: fixedResponseClock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: conversationRepository,
    });
    const conversationResponseService = createConversationResponseService({
      catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
      clock: fixedResponseClock,
      contextCompiler,
      conversationService,
      harness: createConversationAgentHarness({
        clock: fixedResponseClock,
        egressPort: createProviderEgressPort({
          champion: testChampion,
          clock: fixedResponseClock,
          contextCompiler,
          model: createBehaviorAwareConversationTextModel({
            responder: () => ["I hear you, that matters."],
          }),
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });
    const journalEligibilityService = createJournalEligibilityService({
      clock: fixedResponseClock,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      repository: journalEligibilityRepository,
    });
    return {
      conversationResponseService,
      conversationService,
      journalEligibilityRepository,
      journalEligibilityService,
      journalService,
      evidenceService,
      outboxRepository,
    };
  }

  async function submitConversation(input: {
    clientEventId: string;
    clientTurnId: string;
    text: string;
  }): Promise<string> {
    const composition = buildComposition();
    const handler = createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service: composition.conversationResponseService,
    });
    const response = await handler(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify({
          clientEventId: input.clientEventId,
          clientTurnId: input.clientTurnId,
          locale: "en-US",
          text: input.text,
          timezone: "America/Los_Angeles",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    await response.text();
    const session = await database.pool.query<{ daily_session_id: string }>(
      `SELECT daily_session_id FROM daily_sessions WHERE user_id = $1`,
      [fixedInternalOwnerPrincipal.userId],
    );
    return session.rows[0]!.daily_session_id;
  }

  async function endExchange(dailySessionId: string): Promise<void> {
    const composition = buildComposition();
    const handler = createContinuousExchangeEndHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      journalEligibilityService: composition.journalEligibilityService,
      outboxDispatcherService: createOutboxDispatcherService({
        clock: fixedResponseClock,
        leaseDurationMs: 60_000,
        leaseOwner: "test-dispatcher",
        repository: composition.outboxRepository,
        startWorkflow: async () => ({
          workflowReceiptId: "test-receipt",
        }),
      }),
      service: composition.conversationService,
    });
    const response = await handler(
      new Request("http://localhost/api/internal/conversation/exchanges/end", {
        body: JSON.stringify({ dailySessionId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
  }

  async function readJournal() {
    const composition = buildComposition();
    return await composition.journalService.readLatest({
      userId: fixedInternalOwnerPrincipal.userId,
    });
  }

  it("treats a superseded command as benign and converges on the next scan (production incident 2026-08-17)", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "stale-recovery-event",
      clientTurnId: "stale-recovery-turn",
      text: "I felt invisible in that meeting today and it really hurt.",
    });
    await endExchange(dailySessionId);

    const admitted = await database.pool.query<{
      workflow_command_id: string;
      source_revision: string;
    }>(
      `SELECT workflow_command_id, source_revision FROM workflow_commands
       WHERE command_type = 'journal_eligibility'`,
    );
    expect(admitted.rows).toHaveLength(1);
    const frozenCommand = {
      workflowCommandId: admitted.rows[0]!.workflow_command_id,
      policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      sourceRevision: Number(admitted.rows[0]!.source_revision),
      subjectId: dailySessionId,
      expectedDataEpoch: 1,
    };

    // Reproduce the production race: a writer (recovered assistant response
    // commit) advances the source head AFTER admission, BEFORE the step runs.
    await database.pool.query(
      `UPDATE daily_sessions
         SET source_revision = source_revision + 1, dialogue_revision = dialogue_revision + 1
       WHERE daily_session_id = $1`,
      [dailySessionId],
    );

    const composition = buildComposition();

    // FIXED behavior: the superseded command resolves benignly instead of
    // throwing a FatalError that burns every durable retry. Before the fix
    // this threw "Journal eligibility command is stale at the current source
    // head." and the workflow died.
    const superseded = await runJournalEligibility({
      clock: fixedResponseClock,
      command: frozenCommand,
      eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      repository: composition.journalEligibilityRepository,
      workflowReceiptId: "stale-receipt-1",
    });
    expect(superseded.outcome).toBe("stale_superseded");

    // No date outcome was recorded for the superseded command, so the next
    // scan re-lists the session and admits a fresh command at the new head.
    const scan = await composition.journalEligibilityService.scanPendingEligibility();
    expect(scan.commandsCreated).toBe(1);
    const readmitted = await database.pool.query<{
      workflow_command_id: string;
      source_revision: string;
    }>(
      `SELECT workflow_command_id, source_revision FROM workflow_commands
       WHERE command_type = 'journal_eligibility'
       ORDER BY source_revision DESC`,
    );
    expect(Number(readmitted.rows[0]!.source_revision)).toBe(
      frozenCommand.sourceRevision + 1,
    );

    // The fresh command runs to an eligible date outcome and the Journal the
    // user was promised by Automatic Journal Delivery actually publishes.
    const eligible = await runJournalEligibility({
      clock: fixedResponseClock,
      command: {
        workflowCommandId: readmitted.rows[0]!.workflow_command_id,
        policyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
        sourceRevision: Number(readmitted.rows[0]!.source_revision),
        subjectId: dailySessionId,
        expectedDataEpoch: 1,
      },
      eligibilityPolicyVersion: JOURNAL_ELIGIBILITY_POLICY_VERSION,
      minimumSubstantiveExpressionLength: MINIMUM_SUBSTANTIVE_EXPRESSION_LENGTH,
      repository: composition.journalEligibilityRepository,
      workflowReceiptId: "stale-receipt-2",
      evidenceService: composition.evidenceService,
    });
    expect(eligible.outcome).toBe("eligible_queued");

    const journal = await runAutomaticJournal({
      service: composition.journalService,
      command: {
        workflowCommandId: readmitted.rows[0]!.workflow_command_id,
        policyVersion: "journal-generation:v2",
        sourceRevision: Number(readmitted.rows[0]!.source_revision),
        subjectId: dailySessionId,
        expectedDataEpoch: 1,
      },
      generationCommandId: "stale-recovery-journal",
      modelRunAttemptId: "stale-recovery-attempt",
    });
    expect(journal.outcome).toBe("published");

    const visible = await readJournal();
    expect(visible).not.toBeNull();
  });

  it("dispatches a numeric sourceRevision to the Workflow starter (production incident 2026-08-17 root cause)", async () => {
    const dailySessionId = await submitConversation({
      clientEventId: "numeric-revision-event",
      clientTurnId: "numeric-revision-turn",
      text: "The Workflow starter must receive the source revision as a number.",
    });
    const composition = buildComposition();
    // End without the best-effort dispatch stub so the outbox row stays pending
    // and can be leased through the real dispatcher repository below.
    await composition.conversationService.endContinuousExchange(
      fixedInternalOwnerPrincipal.userId,
      { dailySessionId },
    );
    await composition.journalEligibilityService.evaluate(dailySessionId);

    const command = await database.pool.query<{ source_revision: string }>(
      `SELECT source_revision FROM workflow_commands WHERE command_type = 'journal_eligibility'`,
    );
    expect(command.rows).toHaveLength(1);
    const admittedRevision = Number(command.rows[0]!.source_revision);

    // Drive the REAL Postgres dispatcher repository so the BIGINT round-trip is
    // exercised. Before the fix, node-postgres returned aggregate_revision as
    // the string "2", mapLeased leaked it through as-is, and the Workflow
    // starter received sourceRevision="2" — where 2 !== "2" tripped the stale
    // fence deterministically and burned every durable retry.
    const captured: Array<unknown> = [];
    const dispatcher = createOutboxDispatcherService({
      clock: fixedResponseClock,
      leaseDurationMs: 60_000,
      leaseOwner: "numeric-revision-dispatcher",
      repository: composition.outboxRepository,
      startWorkflow: async (input) => {
        captured.push(input.sourceRevision);
        return { workflowReceiptId: "numeric-revision-receipt" };
      },
    });
    const dispatch = await dispatcher.dispatchPending();
    expect(dispatch.dispatched).toBe(1);
    expect(captured).toEqual([admittedRevision]);
  });
});
