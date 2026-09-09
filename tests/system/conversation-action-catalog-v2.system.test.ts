import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  REGENERATE_JOURNAL_ACTION_DEFINITION,
  actionFunctionsForCatalog,
  createConversationActionGateway,
  createContextCompiler,
  createJournalRegenerationActionHandler,
  createUserTextConversationService,
  validateConversationActionCatalog,
  type ConversationActionCatalog,
  type ConversationActionDefinition,
  type ConversationActionHandler,
} from "@sayhear/application";
import {
  PostgresJournalRegenerationActionRepository,
  PostgresConversationResponseRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const now = new Date();

/**
 * The second Definition used purely as seam plumbing for issue #109: it is a
 * synchronous in-transaction Action over the same Journal target contract and
 * never becomes a product capability. Its authoritative effect is one
 * short-lived action-payload envelope (ADR-0101 surface) carrying a probe
 * marker, which can only exist if the whole admission transaction committed.
 */
const PREFACTOR_PROBE_ACTION_DEFINITION: ConversationActionDefinition =
  Object.freeze({
    actionKind: "prefactor_probe",
    availabilityPolicy: "authenticated_owner",
    consistencyPolicy: "exact_head",
    confirmationPolicy: "none",
    effectClass: "test_only_probe",
    executionMode: "synchronous",
    functionDescription:
      "Probe Function proving a second Definition coexists and offers alongside the Journal regeneration Function.",
    handlerBinding: "test.prefactor-probe.v1",
    idempotencyScope: "decision_command_action_target",
    inputSchema: Object.freeze({
      additionalProperties: false,
      properties: Object.freeze({
        marker: Object.freeze({ maxLength: 64, type: "string" }),
        probeHandle: Object.freeze({ minLength: 1, type: "string" }),
      }),
      required: Object.freeze(["probeHandle"]),
      type: "object",
    }),
    ratePolicy: Object.freeze({ maxInFlightPerTarget: null, name: "none" }),
    schemaVersion: "prefactor-probe:v1",
    targetContract: Object.freeze({
      handleArgument: "probeHandle",
      handleKind: "journal",
      versioned: true,
    }),
    trustClass: "user_private_test_probe",
  });

const TEST_TWO_DEFINITION_CATALOG: ConversationActionCatalog = Object.freeze({
  definitions: Object.freeze([
    REGENERATE_JOURNAL_ACTION_DEFINITION,
    PREFACTOR_PROBE_ACTION_DEFINITION,
  ]),
  version: "conversation-action-catalog:test-two-definitions:v1",
});

function createPrefactorProbeHandler(options: {
  failCommit?: boolean;
}): ConversationActionHandler {
  return {
    actionKind: "prefactor_probe",
    prepare({ proposal, target }) {
      if (!target) {
        throw new Error("The probe handler requires its handle-mode target.");
      }
      const marker =
        typeof proposal.arguments.marker === "string"
          ? proposal.arguments.marker
          : "default";
      return {
        actionKind: "prefactor_probe",
        commit: async ({ actionExecutionId, executor }) => {
          if (options.failCommit) {
            throw new Error("The probe handler was scripted to fail.");
          }
          const inserted = await executor.query(
            `
              INSERT INTO conversation_action_payloads (
                action_execution_id, payload_schema_version, ciphertext,
                expires_at
              ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '24 hours')
            `,
            [
              actionExecutionId,
              PREFACTOR_PROBE_ACTION_DEFINITION.schemaVersion,
              Buffer.from(`probe:${marker}`, "utf8"),
            ],
          );
          if (inserted.rowCount !== 1) {
            throw new Error("The synchronous probe effect was not committed.");
          }
        },
        dailySessionId: target.dailySessionId,
        expectedDataEpoch: target.expectedDataEpoch,
        mode: "in_transaction",
        sourceRevision: target.sourceRevision,
        targetVersionId: target.targetVersionId,
      };
    },
  };
}

describe("Conversation Action Catalog v2 foundation system seam (issue #109)", () => {
  let database: IsolatedPostgresSchema;
  let turnCounter = 0;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(database.pool).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "catalog-v2-test-owner",
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
    await database.pool.query("DELETE FROM backup_policy_versions");
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
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
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  /** Submits one authenticated turn through the real service request path. */
  async function submitAuthenticatedTurn() {
    turnCounter += 1;
    const conversationService = createUserTextConversationService({
      clock: () => now,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: {
        consentPolicyVersion: null,
        freshnessPolicy: "source_valid:v1" as const,
        chineseLocalePackVersion: "locale-pack-zh:v1",
        englishLocalePackVersion: "locale-pack-en:v1",
        harnessPolicyVersion: CATALOG_V2_CONVERSATION_HARNESS_POLICY.version,
        conversationActionCatalogVersion: TEST_TWO_DEFINITION_CATALOG.version,
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
      },
      inactivityPolicy: {
        timeoutMs: 1_800_000,
        version: "continuous-exchange-inactivity:v1",
      },
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const turn = await conversationService.submit(
      fixedInternalOwnerPrincipal.userId,
      {
        clientEventId: `catalog-v2-event-${turnCounter}`,
        clientTurnId: `catalog-v2-turn-${turnCounter}`,
        locale: "en-US",
        text: "Please keep this day available for later review.",
        timezone: "America/Los_Angeles",
      },
    );

    // Seed a published Journal head so Journal-target handles resolve.
    const snapshotId = `01984477-0000-7000-8000-00000000a${String(turnCounter).padStart(3, "0")}`;
    const journalGenerationCommandId = `01984477-0000-7000-8000-00000000b${String(turnCounter).padStart(3, "0")}`;
    const journalAttemptId = `01984477-0000-7000-8000-00000000c${String(turnCounter).padStart(3, "0")}`;
    const journalId = `01984477-0000-7000-8000-00000000d${String(turnCounter).padStart(3, "0")}`;
    const versionId = `01984477-0000-7000-8000-00000000e${String(turnCounter).padStart(3, "0")}`;
    const pool = database.pool;
    await pool.query(
      `INSERT INTO evidence_source_snapshots (
        evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
        extraction_policy_version, command_id, attempt_id, champion_config_version,
        champion_provider, champion_model, champion_snapshot,
        champion_provider_policy_version, created_at
      ) VALUES ($1, $2, $3, 1, 'evidence-extraction:v2', 'seed', 'seed',
        'test', 'openai', 'test', 'test', 'test', $4)`,
      [snapshotId, fixedInternalOwnerPrincipal.userId, turn.dailySession.id, now],
    );
    await pool.query(
      `INSERT INTO journal_generation_commands (
        generation_command_id, user_id, daily_session_id, source_revision,
        generation_policy_version, expected_data_epoch, created_at
      ) VALUES ($1, $2, $3, 1, 'journal-generation:v2', 1, $4)`,
      [journalGenerationCommandId, fixedInternalOwnerPrincipal.userId, turn.dailySession.id, now],
    );
    await pool.query(
      `INSERT INTO evidence_items (
        evidence_item_id, user_id, evidence_source_snapshot_id,
        source_event_id, source_revision_id, source_actor, source_status,
        locator_type, locator_key, extraction_policy_version, evidence_role,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision',
        $6, 'evidence-extraction:v2', 'factual_support', $7)`,
      [
        `01984477-0000-7000-8000-00000000f${String(turnCounter).padStart(3, "0")}`,
        fixedInternalOwnerPrincipal.userId,
        snapshotId,
        turn.message.id,
        turn.message.revisionId,
        `revision:${turn.message.revisionId}`,
        now,
      ],
    );
    await pool.query(
      `INSERT INTO journal_model_run_attempts (
        model_run_attempt_id, generation_command_id, status, created_at
      ) VALUES ($1, $2, 'completed', $3)`,
      [journalAttemptId, journalGenerationCommandId, now],
    );
    await pool.query(
      `INSERT INTO journals (journal_id, user_id, daily_session_id, current_version_id, created_at)
       VALUES ($1, $2, $3, NULL, $4)`,
      [journalId, fixedInternalOwnerPrincipal.userId, turn.dailySession.id, now],
    );
    await pool.query(
      `INSERT INTO journal_versions (
        journal_version_id, journal_id, user_id, daily_session_id, source_revision,
        generation_policy_version, validator_version, locale, evidence_source_snapshot_id,
        status, generation_command_id, model_run_attempt_id, generation_kind, created_at
      ) VALUES ($1, $2, $3, $4, 1, 'journal-generation:v2', 'journal-validator:v1',
        'en-US', $5, 'published', $6, $7, 'automatic', $8)`,
      [
        versionId,
        journalId,
        fixedInternalOwnerPrincipal.userId,
        turn.dailySession.id,
        snapshotId,
        journalGenerationCommandId,
        journalAttemptId,
        now,
      ],
    );
    await pool.query(
      "UPDATE journals SET current_version_id = $1 WHERE journal_id = $2",
      [versionId, journalId],
    );

    // The Decision must be owned before compiling (same dispatch fence as the
    // production response path).
    const responseRepository = new PostgresConversationResponseRepository(pool);
    expect(
      await responseRepository.claimResponseExecution({
        generationCommandId: turn.generation.commandId,
        modelRunAttemptId: turn.generation.attemptId,
        userId: fixedInternalOwnerPrincipal.userId,
      }),
    ).toBe("owner");
    const context = await createContextCompiler({
      clock: () => now,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "catalog-v2-test-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    }).compile({
      generationCommandId: turn.generation.commandId,
      interactionTurnId: turn.turn.id,
      userId: fixedInternalOwnerPrincipal.userId,
    });
    const journalHandle = context.actionReferenceHandles?.[0];
    expect(journalHandle?.handle).toMatch(/^shh-handle-/);

    // The second Definition's handle: minted like the compiler does (same
    // table, same expiry window), demonstrating coexistence of two eligible
    // target handles for one Decision Command.
    const probeHandleValue = `shh-handle-probe-${turnCounter}`;
    await pool.query(
      `INSERT INTO conversation_action_handles (
        handle, compiled_context_id, user_id, generation_command_id,
        action_kind, target_kind, target_id, target_version_id,
        source_revision, expected_data_epoch, created_at, expires_at
      )
      SELECT $1, $2, $3, $4, 'prefactor_probe', 'journal',
        journal.journal_id, journal.current_version_id, 1,
        (SELECT expected_data_epoch FROM generation_commands
         WHERE generation_command_id = $4 AND user_id = $3),
        $5::timestamptz, $5::timestamptz + INTERVAL '30 minutes'
      FROM journals journal
      WHERE journal.journal_id = $6 AND journal.user_id = $3`,
      [
        probeHandleValue,
        String(context.id),
        fixedInternalOwnerPrincipal.userId,
        turn.generation.commandId,
        now,
        journalId,
      ],
    );

    return {
      actionContext: {
        compiledContextId: context.id,
        decisionCommandId: turn.generation.commandId,
        requestEventRevisionId: turn.message.revisionId,
        userId: fixedInternalOwnerPrincipal.userId,
      },
      context,
      journalId,
      journalHandle: journalHandle!,
      probeHandleValue,
      turn,
      versionId,
    };
  }

  it("offers Functions for two coexisting Definitions and commits the synchronous probe inside the admission transaction", async () => {
    const seeded = await submitAuthenticatedTurn();
    const handles = [
      {
        actionKinds: seeded.journalHandle.actionKinds.includes(
          "regenerate_journal",
        )
          ? ["regenerate_journal", "prefactor_probe"]
          : [...seeded.journalHandle.actionKinds],
        handle: seeded.journalHandle.handle,
        targetKind: seeded.journalHandle.targetKind,
      },
      {
        actionKinds: ["prefactor_probe"],
        handle: seeded.probeHandleValue,
        targetKind: "journal" as const,
      },
    ];
    const catalog = TEST_TWO_DEFINITION_CATALOG;

    expect(validateConversationActionCatalog(catalog)).toEqual({ valid: true });
    const functions = actionFunctionsForCatalog(catalog, handles);
    expect(functions.map((fn) => fn.name).sort()).toEqual([
      "prefactor_probe",
      "regenerate_journal",
    ]);

    // The Decision Command pinned the v2-era policy and the two-Definition
    // Catalog through the real submission path.
    const pins = await database.pool.query<{
      conversation_action_catalog_version: string;
      harness_policy_version: string;
    }>(
      `SELECT harness_policy_version, conversation_action_catalog_version
       FROM generation_commands WHERE generation_stage = 'decision'`,
    );
    expect(pins.rows[0]).toEqual({
      conversation_action_catalog_version: catalog.version,
      harness_policy_version: CATALOG_V2_CONVERSATION_HARNESS_POLICY.version,
    });

    const actionRepository = new PostgresJournalRegenerationActionRepository(
      database.pool,
      "catalog-v2-test-secret",
    );
    const gateway = createConversationActionGateway({
      handlers: [
        createJournalRegenerationActionHandler({
          generationPolicyVersion: "journal-generation:v2",
        }),
        createPrefactorProbeHandler({}),
      ],
      repository: actionRepository,
    });

    // Same-turn synchronous commit: admission Receipt, the probe's domain
    // effect, and the terminal Completion Receipt land as ONE transaction.
    const probeReceipt = await gateway.admit({
      catalog,
      context: seeded.actionContext,
      proposal: {
        actionKind: "prefactor_probe",
        arguments: {
          marker: "catalog-v2-foundation",
          probeHandle: seeded.probeHandleValue,
        },
        requestEventRevisionId: seeded.turn.message.revisionId,
        schemaVersion: "prefactor-probe:v1",
      },
    });
    expect(probeReceipt).toMatchObject({
      actionKind: "prefactor_probe",
      admission: "accepted",
      disposition: "committed_in_transaction",
      execution: "succeeded",
      receiptSequence: 2,
      schemaVersion: "prefactor-probe:v1",
    });

    // The async durable-workflow mode stays intact beside it: the Journal
    // regeneration accepts under the same Catalog and creates its workflow.
    const regenerationReceipt = await gateway.admit({
      catalog,
      context: seeded.actionContext,
      proposal: {
        actionKind: "regenerate_journal",
        arguments: {
          guidance: "Sharper emphasis.",
          journalHandle: seeded.journalHandle.handle,
        },
        requestEventRevisionId: seeded.turn.message.revisionId,
        schemaVersion: "regenerate-journal:v1",
      },
    });
    expect(regenerationReceipt).toMatchObject({
      admission: "accepted",
      execution: "pending",
      receiptSequence: 1,
    });

    const state = await database.pool.query<{
      executions_succeeded: string;
      finalizations_frozen_terminal: string;
      payloads: string;
      probe_marker_bytes: Buffer | null;
      receipt_sequences: Record<string, unknown>;
      regeneration_outbox: string;
      regeneration_workflows: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM conversation_action_executions
          WHERE execution_status = 'succeeded') AS executions_succeeded,
        (SELECT COUNT(*) FROM conversation_action_executions
          WHERE execution_status = 'pending') AS executions_pending,
        (SELECT jsonb_object_agg(action_kind, sequences)
          FROM (
            SELECT execution.action_kind,
              ARRAY_AGG(receipt.receipt_sequence ORDER BY receipt.receipt_sequence)
                AS sequences
            FROM conversation_action_executions execution
            INNER JOIN conversation_action_receipts receipt
              ON receipt.action_execution_id = execution.action_execution_id
            GROUP BY execution.action_execution_id, execution.action_kind
          ) grouped) AS receipt_sequences,
        (SELECT COUNT(*) FROM conversation_action_payloads
          WHERE payload_schema_version = 'prefactor-probe:v1') AS payloads,
        (SELECT ciphertext FROM conversation_action_payloads
          WHERE payload_schema_version = 'prefactor-probe:v1') AS probe_marker_bytes,
        (SELECT COUNT(*) FROM workflow_commands
          WHERE command_type = 'journal_regeneration') AS regeneration_workflows,
        (SELECT COUNT(*) FROM outbox_events
          WHERE event_type = 'journal_regeneration_requested') AS regeneration_outbox,
        (SELECT COUNT(*) FROM generation_commands finalization
          INNER JOIN conversation_action_executions execution
            ON execution.action_execution_id = finalization.action_execution_id
          WHERE finalization.generation_stage = 'action_finalization'
            AND finalization.action_receipt_sequence = 2
            AND finalization.action_execution_status = 'succeeded'
            AND execution.disposition = 'committed_in_transaction')
          AS finalizations_frozen_terminal
    `);
    expect(state.rows[0]).toMatchObject({
      executions_succeeded: "1",
      executions_pending: "1",
      finalizations_frozen_terminal: "1",
      payloads: "1",
      probe_marker_bytes: Buffer.from("probe:catalog-v2-foundation", "utf8"),
      regeneration_outbox: "1",
      regeneration_workflows: "1",
    });
    expect(state.rows[0]?.receipt_sequences).toMatchObject({
      regenerate_journal: [1],
      prefactor_probe: [1, 2],
    });

    // Repeating the identical synchronous request converges on the same
    // ActionExecution without re-running the effect.
    const replayed = await gateway.admit({
      catalog,
      context: seeded.actionContext,
      proposal: {
        actionKind: "prefactor_probe",
        arguments: {
          marker: "catalog-v2-foundation",
          probeHandle: seeded.probeHandleValue,
        },
        requestEventRevisionId: seeded.turn.message.revisionId,
        schemaVersion: "prefactor-probe:v1",
      },
    });
    expect(replayed).toEqual(probeReceipt);
    expect(
      await database.pool.query(
        "SELECT COUNT(*) AS n FROM conversation_action_payloads WHERE payload_schema_version = 'prefactor-probe:v1'",
      ),
    ).toMatchObject({ rows: [{ n: "1" }] });

    // Crash-parity: a terminal synchronous commit whose finalization never ran
    // still appears in the pending-finalization recovery scan (ADR-0099).
    const pendingBeforeSettle =
      await actionRepository.listPendingFinalizations!({ limit: 10 });
    expect(
      pendingBeforeSettle.map((command) => command.actionExecutionId),
    ).toContain(probeReceipt.actionExecutionId);
    await database.pool.query(
      `UPDATE generation_commands SET status = 'succeeded'
       WHERE action_execution_id = $1
         AND generation_stage = 'action_finalization'`,
      [probeReceipt.actionExecutionId],
    );
    const pendingAfterSettle =
      await actionRepository.listPendingFinalizations!({ limit: 10 });
    expect(
      pendingAfterSettle.map((command) => command.actionExecutionId),
    ).not.toContain(probeReceipt.actionExecutionId);
  });

  it("rolls back the entire synchronous admission when the in-transaction effect fails", async () => {
    const seeded = await submitAuthenticatedTurn();
    const gateway = createConversationActionGateway({
      handlers: [createPrefactorProbeHandler({ failCommit: true })],
      repository: new PostgresJournalRegenerationActionRepository(
        database.pool,
        "catalog-v2-test-secret",
      ),
    });

    await expect(
      gateway.admit({
        catalog: TEST_TWO_DEFINITION_CATALOG,
        context: seeded.actionContext,
        proposal: {
          actionKind: "prefactor_probe",
          arguments: { probeHandle: seeded.probeHandleValue },
          requestEventRevisionId: seeded.turn.message.revisionId,
          schemaVersion: "prefactor-probe:v1",
        },
      }),
    ).rejects.toThrow("The probe handler was scripted to fail.");

    // No partial admission may survive a failed synchronous effect
    // (ADR-0099): no execution, receipts, finalization command, or payload.
    const counts = await database.pool.query<{
      commands: string;
      executions: string;
      payloads: string;
      receipts: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM conversation_action_executions) AS executions,
        (SELECT COUNT(*) FROM conversation_action_receipts) AS receipts,
        (SELECT COUNT(*) FROM conversation_action_payloads) AS payloads,
        (SELECT COUNT(*) FROM generation_commands
          WHERE generation_stage = 'action_finalization') AS commands
    `);
    expect(counts.rows[0]).toEqual({
      commands: "0",
      executions: "0",
      payloads: "0",
      receipts: "0",
    });
  });
});
