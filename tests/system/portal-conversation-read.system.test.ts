import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createRecoveryGate,
  createUserTextConversationService,
  RecoveryGateClosedError,
  type GenerationPolicy,
  type UserTextConversationService,
} from "@sayhear/application";
import {
  PostgresInternalOwnerAccessRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  asDailySessionId,
  asUserId,
} from "@sayhear/domain";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

/**
 * SPEC #260 ticket #261 against real PostgreSQL: the portal's server-side
 * "current conversation" read resolves the authoritative active Daily Session,
 * returns only a capped, ascending recent batch, never creates a session, is
 * owner-scoped, and fails closed through the recovery gate. Superseded,
 * deleted and purged content never leaves the database.
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

describe("Portal current conversation read system seam", () => {
  let database: IsolatedPostgresSchema;
  let service: UserTextConversationService;
  let eventCounter = 0;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    const accessRepository = new PostgresInternalOwnerAccessRepository(
      database.pool,
    );
    await accessRepository.provisionInternalOwner({
      issuer: "https://github.com",
      subject: "portal-conversation-read-test-owner",
      userId: OWNER,
    });
    const recoveryGate = createRecoveryGate({
      businessStateRepository: accessRepository,
      // A clean first-generation database has no purge marker; keeping the
      // marker store local lets this test require only TEST_DATABASE_URL.
      markerRepository: { findLatestMarker: async () => null },
    });
    service = createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: policy,
      inactivityPolicy: {
        timeoutMs: 1_800_000,
        version: "continuous-exchange-inactivity:v1",
      },
      recoveryGate,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
  }, 60_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME;
    eventCounter = 0;
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
      validUntil: new Date("2027-10-06T00:00:00.000Z"),
      verifiedAt: new Date("2026-10-06T00:00:00.000Z"),
    });
  }

  async function seedTurn(
    text: string,
    timezone = "America/Los_Angeles",
  ) {
    eventCounter += 1;
    return service.submit(OWNER, {
      clientEventId: `portal-read-event-${eventCounter}`,
      clientTurnId: `portal-read-turn-${eventCounter}`,
      locale: "en-US",
      text,
      timezone,
    });
  }

  async function countSessions(): Promise<number> {
    const result = await database.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM daily_sessions",
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async function seedForeignOwner(): Promise<{
    dailySessionId: string;
    userId: string;
  }> {
    const now = clock();
    const userId = createTestUuidV7(now);
    const dailySessionId = createTestUuidV7(now);
    const turnId = createTestUuidV7(now);
    const eventId = createTestUuidV7(now);
    const revisionId = createTestUuidV7(now);
    await database.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [userId, now],
    );
    await database.pool.query(
      `INSERT INTO daily_sessions (
         daily_session_id, user_id, logical_date, timezone_at_start,
         started_at, last_activity_at, created_at, updated_at
       ) VALUES ($1, $2, '2026-10-04', 'Asia/Shanghai', $3, $3, $3, $3)`,
      [dailySessionId, userId, now],
    );
    await database.pool.query(
      `INSERT INTO interaction_turns (
         interaction_turn_id, user_id, daily_session_id, client_turn_id,
         turn_sequence_no, continuous_exchange_no, status, started_at,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'foreign-turn', 1, 1, 'settled', $4, $4, $4)`,
      [turnId, userId, dailySessionId, now],
    );
    await database.pool.query(
      `INSERT INTO conversation_events (
         conversation_event_id, user_id, daily_session_id, interaction_turn_id,
         sequence_no, client_event_id, actor, channel, event_type,
         current_revision_id, lifecycle_status, created_at
       ) VALUES ($1, $2, $3, $4, 1, 'foreign-event', 'user', 'text',
         'user_message', NULL, 'active', $5)`,
      [eventId, userId, dailySessionId, turnId, now],
    );
    await database.pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, locale, canonical_text, transcript_status, created_by,
         created_at
       ) VALUES ($1, $2, $3, 1, 'en-US', 'foreign text', 'final', 'client', $4)`,
      [revisionId, userId, eventId, now],
    );
    await database.pool.query(
      `UPDATE conversation_events SET current_revision_id = $1
       WHERE conversation_event_id = $2`,
      [revisionId, eventId],
    );
    return { dailySessionId, userId };
  }

  it("resolves the authoritative active session and returns null when none exists", async () => {
    await openPrivateWrites();
    expect(await service.readCurrentConversation(OWNER)).toBeNull();

    const turn = await seedTurn("A first expression.");
    const identity = await service.readCurrentConversation(OWNER);

    expect(identity).toMatchObject({
      activityState: "active",
      logicalDate: "2026-10-06",
      timezoneAtStart: "America/Los_Angeles",
    });
    expect(identity?.dailySessionId).toBe(turn.dailySession.id);
    expect(identity?.startedAt).toBeInstanceOf(Date);
  });

  it("returns only the capped recent batch with ascending sequence", async () => {
    await openPrivateWrites();
    for (let index = 0; index < 55; index += 1) {
      await seedTurn(`message number ${index}`);
    }
    const identity = await service.readCurrentConversation(OWNER);
    const messages = await service.listRecentMessages(OWNER, {
      dailySessionId: identity!.dailySessionId,
    });

    expect(messages).toHaveLength(50);
    expect(messages.map((message) => message.sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 6),
    );
    expect(messages[0]?.text).toBe("message number 5");
    expect(messages.at(-1)?.text).toBe("message number 54");
    expect(messages.every((message) => message.actor === "user")).toBe(true);
  });

  it("never creates a Daily Session while reading", async () => {
    await openPrivateWrites();
    const unusedSessionId = createTestUuidV7(clock());

    expect(await service.readCurrentConversation(OWNER)).toBeNull();
    expect(
      await service.listRecentMessages(OWNER, {
        dailySessionId: unusedSessionId,
      }),
    ).toEqual([]);
    expect(await countSessions()).toBe(0);

    await seedTurn("The only persisted expression.");
    const identity = await service.readCurrentConversation(OWNER);
    await service.listRecentMessages(OWNER, {
      dailySessionId: identity!.dailySessionId,
    });
    expect(await countSessions()).toBe(1);
  });

  it("does not return another owner's session or messages", async () => {
    await openPrivateWrites();
    await seedTurn("The owner's own expression.");
    const identity = await service.readCurrentConversation(OWNER);
    const foreign = await seedForeignOwner();

    expect(
      await service.readCurrentConversation(asUserId(foreign.userId)),
    ).toBeNull();
    expect(
      await service.listRecentMessages(OWNER, {
        dailySessionId: asDailySessionId(foreign.dailySessionId) as string,
      }),
    ).toEqual([]);
    expect(
      await service.listRecentMessages(OWNER, {
        dailySessionId: identity!.dailySessionId,
      }),
    ).toMatchObject([{ text: "The owner's own expression." }]);
  });

  it("keeps the actual ownership date across midnight", async () => {
    await openPrivateWrites();
    const turn = await seedTurn("Started before midnight.", "America/Los_Angeles");
    expect(turn.dailySession.logicalDate).toBe("2026-10-06");

    // 2026-10-07T08:00Z is 01:00 in Los Angeles: the open exchange still owns
    // the previous local date until it ends.
    clockNowMs = new Date("2026-10-07T08:00:00.000Z").getTime();
    const identity = await service.readCurrentConversation(OWNER);
    expect(identity?.logicalDate).toBe("2026-10-06");
    expect(identity?.dailySessionId).toBe(turn.dailySession.id);
  });

  it("fails reads closed when the recovery gate is closed", async () => {
    await openPrivateWrites();
    await seedTurn("Fenced content.");
    const identity = await service.readCurrentConversation(OWNER);

    await database.pool.query(
      "UPDATE app_users SET status = 'deleting', updated_at = $2 WHERE user_id = $1",
      [OWNER, clock()],
    );

    await expect(service.readCurrentConversation(OWNER)).rejects.toBeInstanceOf(
      RecoveryGateClosedError,
    );
    await expect(
      service.listRecentMessages(OWNER, {
        dailySessionId: identity!.dailySessionId,
      }),
    ).rejects.toBeInstanceOf(RecoveryGateClosedError);

    // A restored database whose data epoch advanced without its external
    // marker is an inconsistent fence and must stay closed.
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 2, updated_at = $2 WHERE user_id = $1",
      [OWNER, clock()],
    );
    await expect(service.readCurrentConversation(OWNER)).rejects.toBeInstanceOf(
      RecoveryGateClosedError,
    );
  });

  it("does not expose deleted, superseded, or purged content", async () => {
    await openPrivateWrites();
    const deleted = await seedTurn("This was deleted.");
    const corrected = await seedTurn("This was superseded.");
    const purged = await seedTurn("This was purged.");

    await database.pool.query(
      `UPDATE conversation_events
       SET lifecycle_status = 'deleted', deleted_at = $2
       WHERE conversation_event_id = $1`,
      [deleted.message.id, clock()],
    );
    await service.correct(OWNER, {
      eventId: corrected.message.id,
      locale: "en-US",
      text: "This is the current revision.",
    });
    const purgedRevision = await database.pool.query<{ revision_id: string }>(
      "SELECT current_revision_id AS revision_id FROM conversation_events WHERE conversation_event_id = $1",
      [purged.message.id],
    );
    await database.pool.query(
      `UPDATE conversation_event_revisions
       SET canonical_text = '', content_purged_at = $2
       WHERE conversation_event_revision_id = $1`,
      [purgedRevision.rows[0]!.revision_id, clock()],
    );

    const identity = await service.readCurrentConversation(OWNER);
    const messages = await service.listRecentMessages(OWNER, {
      dailySessionId: identity!.dailySessionId,
    });
    expect(messages.map((message) => message.text)).toEqual([
      "This is the current revision.",
    ]);
  });
});
