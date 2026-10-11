import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ConversationRetryNotAllowedError,
  createRecoveryGate,
  createUserTextConversationService,
  type GenerationPolicy,
  type UserTextConversationService,
} from "@sayhear/application";
import {
  PostgresInternalOwnerAccessRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

/**
 * SPEC #260 ticket #269 integration acceptance against real PostgreSQL.
 *
 * The only cross-module behaviour that needs database evidence is the
 * interrupted-history retry path. The existing Retry contract
 * (`recordRetryInTransaction`) always inserts the retry InteractionTurn into
 * the ORIGINAL turn's Daily Session and reactivates it when it is quiescent.
 * Read-only history therefore must not call it; these tests pin the exact
 * observable outcome so the portal's navigation-only affordance is justified.
 *
 * The 100-date / 500-message composite read is covered by
 * `portal-conversation-page.system.test.ts`; this file adds the cross-date
 * retry contract behaviour and its fail-closed cases.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const BASE_TIME = new Date("2026-10-06T16:00:00.000Z").getTime();
let clockNowMs = BASE_TIME;
const clock = () => new Date(clockNowMs);

const policy: GenerationPolicy = Object.freeze({
  consentPolicyVersion: null,
  freshnessPolicy: "source_valid:v1",
  chineseLocalePackVersion: "locale-pack-zh:v1",
  englishLocalePackVersion: "locale-pack-en:v1",
  harnessPolicyVersion: "conversation-harness:v1",
  conversationActionCatalogVersion: "conversation-action-catalog:empty:v1",
  model: "gpt-5.4",
  modelConfigVersion: "conversation-text-champion:v1",
  modelSnapshot: "gpt-5.4",
  outputFormatVersion: "conversation-output:v2",
  canonicalPersonaVersion: "canonical-persona:v1",
  personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
  personaContractInvariantVersion: "persona-contract-invariant:v1",
  productPolicyVersion: "product-policy:v1",
  taskInstructionVersion: "task-instruction-decision:v1",
  provider: "openai",
  providerPolicyVersion: "openai-conversation-text:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
});

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

describe("Portal cross-date interrupted retry contract", () => {
  let database: IsolatedPostgresSchema;
  let service: UserTextConversationService;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    const accessRepository = new PostgresInternalOwnerAccessRepository(
      database.pool,
    );
    await accessRepository.provisionInternalOwner({
      issuer: "https://github.com",
      subject: "portal-acceptance-test-owner",
      userId: OWNER,
    });
    const recoveryGate = createRecoveryGate({
      businessStateRepository: accessRepository,
      markerRepository: { findLatestMarker: async () => null },
    });
    service = createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: policy,
      recoveryGate,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
  }, 60_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME;
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
    await database.pool.query("DELETE FROM backup_policy_versions");
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  async function openPrivateWrites(): Promise<void> {
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
  }

  async function submitAndInterrupt(logicalDateIso: string): Promise<{
    dailySessionId: string;
    turnId: string;
  }> {
    const turn = await service.submit(OWNER, {
      clientEventId: createTestUuidV7(clock()),
      clientTurnId: createTestUuidV7(clock()),
      locale: "en-US",
      text: `synthetic message ${logicalDateIso}`,
      timezone: "America/Los_Angeles",
    });
    await database.pool.query(
      `UPDATE interaction_turns SET status = 'interrupted', updated_at = $2
       WHERE interaction_turn_id = $1`,
      [turn.turn.id, clock()],
    );
    await database.pool.query(
      `UPDATE generation_commands
       SET status = 'interrupted', authoritative_result_id = NULL
       WHERE interaction_turn_id = $1`,
      [turn.turn.id],
    );
    return { dailySessionId: turn.dailySession.id, turnId: turn.turn.id };
  }

  it(
    "appends a retry to the original historical session and reactivates it",
    async () => {
      await openPrivateWrites();
      const original = await submitAndInterrupt("2026-10-01T16:00:00.000Z");

      // The exchange has ended and the day is no longer writable.
      await database.pool.query(
        `UPDATE daily_sessions SET activity_state = 'quiescent', updated_at = $2
         WHERE daily_session_id = $1`,
        [original.dailySessionId, clock()],
      );
      expect(await service.readCurrentConversation(OWNER)).toBeNull();

      const retry = await service.retry(OWNER, {
        originalTurnId: original.turnId,
        retryRequestId: "synthetic-cross-date-retry",
      });

      // The retry turn belongs to the original (historical) Daily Session, and
      // that session has been reactivated into the writable slot.
      const state = await database.pool.query<{
        activity_state: string;
        retry_session: string;
      }>(
        `
          SELECT
            session.activity_state,
            retry_turn.daily_session_id::text AS retry_session
          FROM daily_sessions session
          INNER JOIN interaction_turns retry_turn
            ON retry_turn.interaction_turn_id = $2
          WHERE session.daily_session_id = $1
        `,
        [original.dailySessionId, retry.turn.id],
      );
      expect(state.rows[0]).toEqual({
        activity_state: "active",
        retry_session: original.dailySessionId,
      });
      expect((await service.readCurrentConversation(OWNER))?.dailySessionId).toBe(
        original.dailySessionId,
      );
    },
    60_000,
  );

  it("fails a retry against a finalized historical session closed", async () => {
    await openPrivateWrites();
    const original = await submitAndInterrupt("2026-09-20T16:00:00.000Z");
    await database.pool.query(
      `UPDATE daily_sessions SET activity_state = 'finalized', updated_at = $2
       WHERE daily_session_id = $1`,
      [original.dailySessionId, clock()],
    );

    await expect(
      service.retry(OWNER, {
        originalTurnId: original.turnId,
        retryRequestId: "synthetic-finalized-retry",
      }),
    ).rejects.toBeInstanceOf(ConversationRetryNotAllowedError);

    // The failure leaves the historical session untouched.
    const state = await database.pool.query<{ activity_state: string }>(
      `SELECT activity_state FROM daily_sessions WHERE daily_session_id = $1`,
      [original.dailySessionId],
    );
    expect(state.rows[0]?.activity_state).toBe("finalized");
  }, 30_000);

  it("fails a retry for an unknown or foreign original turn closed", async () => {
    await openPrivateWrites();
    const original = await submitAndInterrupt("2026-09-21T16:00:00.000Z");

    await expect(
      service.retry(OWNER, {
        originalTurnId: createTestUuidV7(clock()),
        retryRequestId: "synthetic-unknown-retry",
      }),
    ).rejects.toBeInstanceOf(ConversationRetryNotAllowedError);

    // A turn that exists but is still settled is also not retryable.
    await database.pool.query(
      `UPDATE interaction_turns SET status = 'settled', updated_at = $2
       WHERE interaction_turn_id = $1`,
      [original.turnId, clock()],
    );
    await expect(
      service.retry(OWNER, {
        originalTurnId: original.turnId,
        retryRequestId: "synthetic-settled-retry",
      }),
    ).rejects.toBeInstanceOf(ConversationRetryNotAllowedError);
  }, 30_000);
});
