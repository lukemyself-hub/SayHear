import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  RECENT_CONVERSATION_MESSAGE_LIMIT,
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
import { asUserId } from "@sayhear/domain";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

/**
 * SPEC #260 ticket #264 against real PostgreSQL: the persisted server commit
 * time (`conversation_events.created_at`) is exposed on every portal message
 * read — the current/live recent batch and the paginated history — for both the
 * user and the assistant. The value is byte-identical across refreshes, honors
 * the existing owner / active-revision / purge filters, and never changes the
 * Daily Session `logical_date` across midnight. Missing time is never
 * fabricated (the read model requires the column).
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

type SeedMessage = Readonly<{
  actor: "user" | "assistant";
  createdAt: Date;
  text: string;
}>;

type SeedEvent = Readonly<{
  eventId: string;
  revisionId: string;
  sequence: number;
}>;

describe("Portal persisted message time system seam", () => {
  let database: IsolatedPostgresSchema;
  let service: UserTextConversationService;
  let turnCounter = 0;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    const accessRepository = new PostgresInternalOwnerAccessRepository(
      database.pool,
    );
    await accessRepository.provisionInternalOwner({
      issuer: "https://github.com",
      subject: "portal-message-time-test-owner",
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
      recoveryGate,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
  }, 60_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME;
    turnCounter = 0;
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

  async function seedSession(input: {
    activityState?: "active" | "finalized";
    logicalDate: string;
    messages: readonly SeedMessage[];
    userId?: string;
  }): Promise<{
    dailySessionId: string;
    events: readonly SeedEvent[];
    userId: string;
  }> {
    const userId = input.userId ?? OWNER;
    const now = clock();
    const dailySessionId = createTestUuidV7(now);
    const events: SeedEvent[] = [];
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO daily_sessions (
           daily_session_id, user_id, logical_date, timezone_at_start,
           started_at, last_activity_at, activity_state, created_at, updated_at
         ) VALUES ($1, $2, $3::date, 'America/Los_Angeles', $4, $4, $5, $4, $4)`,
        [
          dailySessionId,
          userId,
          input.logicalDate,
          now,
          input.activityState ?? "active",
        ],
      );
      let eventSequence = 1;
      let turnSequence = 1;
      let currentTurnId: string | null = null;
      for (const message of input.messages) {
        if (message.actor === "user" || currentTurnId === null) {
          currentTurnId = createTestUuidV7(now);
          await client.query(
            `INSERT INTO interaction_turns (
               interaction_turn_id, user_id, daily_session_id, client_turn_id,
               turn_sequence_no, continuous_exchange_no, status, started_at,
               created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, 1, 'settled', $6, $6, $6)`,
            [
              currentTurnId,
              userId,
              dailySessionId,
              `${dailySessionId}-turn-${turnSequence}`,
              turnSequence,
              message.createdAt,
            ],
          );
          turnSequence += 1;
        }
        const eventId = createTestUuidV7(now);
        const revisionId = createTestUuidV7(now);
        await client.query(
          `INSERT INTO conversation_events (
             conversation_event_id, user_id, daily_session_id, interaction_turn_id,
             sequence_no, client_event_id, actor, channel, event_type,
             current_revision_id, lifecycle_status, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'text', $8, NULL, 'active', $9)`,
          [
            eventId,
            userId,
            dailySessionId,
            currentTurnId,
            eventSequence,
            `${dailySessionId}-event-${eventSequence}`,
            message.actor,
            message.actor === "user" ? "user_message" : "assistant_message",
            message.createdAt,
          ],
        );
        await client.query(
          `INSERT INTO conversation_event_revisions (
             conversation_event_revision_id, user_id, conversation_event_id,
             revision, locale, canonical_text, transcript_status, created_by,
             created_at
           ) VALUES ($1, $2, $3, 1, 'en-US', $4, 'final', $5, $6)`,
          [
            revisionId,
            userId,
            eventId,
            message.text,
            message.actor === "user" ? "client" : "provider",
            message.createdAt,
          ],
        );
        await client.query(
          `UPDATE conversation_events SET current_revision_id = $1
           WHERE conversation_event_id = $2`,
          [revisionId, eventId],
        );
        events.push({ eventId, revisionId, sequence: eventSequence });
        eventSequence += 1;
      }
      await client.query(
        `UPDATE daily_sessions
         SET next_event_sequence_no = $2, next_turn_sequence_no = $3
         WHERE daily_session_id = $1`,
        [dailySessionId, eventSequence, turnSequence],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { dailySessionId, events, userId };
  }

  it("exposes the persisted user and assistant commit instants on the live recent read", async () => {
    await openPrivateWrites();
    const userAt = new Date("2026-10-06T16:00:01.000Z");
    const assistantAt = new Date("2026-10-06T16:00:09.000Z");
    const session = await seedSession({
      logicalDate: "2026-10-06",
      messages: [
        { actor: "user", createdAt: userAt, text: "First." },
        { actor: "assistant", createdAt: assistantAt, text: "First reply." },
      ],
    });

    const messages = await service.listRecentMessages(OWNER, {
      dailySessionId: session.dailySessionId,
    });
    expect(messages).toEqual([
      expect.objectContaining({
        actor: "user",
        createdAt: userAt.toISOString(),
        text: "First.",
      }),
      expect.objectContaining({
        actor: "assistant",
        createdAt: assistantAt.toISOString(),
        text: "First reply.",
      }),
    ]);
  });

  it("exposes the same instants on the paginated history read", async () => {
    await openPrivateWrites();
    const messages = Array.from(
      { length: RECENT_CONVERSATION_MESSAGE_LIMIT + 3 },
      (_, index) => ({
        actor: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        createdAt: new Date(BASE_TIME + index * 1_000),
        text: `message ${index}`,
      }),
    );
    const session = await seedSession({
      activityState: "finalized",
      logicalDate: "2026-10-05",
      messages,
    });

    const recent = await service.listRecentMessages(OWNER, {
      dailySessionId: session.dailySessionId,
    });
    expect(recent).toHaveLength(RECENT_CONVERSATION_MESSAGE_LIMIT);

    const older = await service.listOlderMessages(OWNER, {
      beforeSequence: recent[0]!.sequence,
      cursor: null,
      dailySessionId: session.dailySessionId,
    });
    expect(older.messages).toHaveLength(3);
    expect(older.messages[0]!.createdAt).toBe(
      new Date(BASE_TIME).toISOString(),
    );
    expect(older.messages.at(-1)!.createdAt).toBe(
      new Date(BASE_TIME + 2_000).toISOString(),
    );
  });

  it("is byte-identical across repeated reads (refresh stability)", async () => {
    await openPrivateWrites();
    const session = await seedSession({
      logicalDate: "2026-10-06",
      messages: [
        {
          actor: "user",
          createdAt: new Date("2026-10-06T16:00:03.000Z"),
          text: "Stable.",
        },
        {
          actor: "assistant",
          createdAt: new Date("2026-10-06T16:00:04.000Z"),
          text: "Stable reply.",
        },
      ],
    });

    const first = await service.listRecentMessages(OWNER, {
      dailySessionId: session.dailySessionId,
    });
    const second = await service.listRecentMessages(OWNER, {
      dailySessionId: session.dailySessionId,
    });
    expect(second.map((message) => message.createdAt)).toEqual(
      first.map((message) => message.createdAt),
    );
  });

  it("keeps the persisted instant and the ownership date across midnight", async () => {
    await openPrivateWrites();
    // 2026-10-07T08:00Z is 01:00 on 10-07 in Los Angeles, but the session still
    // owns 10-06: the message instant is the real one, logical_date is not
    // rewritten.
    const instant = new Date("2026-10-07T08:00:00.000Z");
    const session = await seedSession({
      logicalDate: "2026-10-06",
      messages: [{ actor: "assistant", createdAt: instant, text: "Late." }],
    });

    const messages = await service.listRecentMessages(OWNER, {
      dailySessionId: session.dailySessionId,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      createdAt: instant.toISOString(),
      logicalDate: "2026-10-06",
    });
  });

  it("records the submit-time instant for a newly committed user message", async () => {
    await openPrivateWrites();
    const submittedAt = new Date("2026-10-06T16:00:07.000Z");
    clockNowMs = submittedAt.getTime();

    const turn = await service.submit(OWNER, {
      clientEventId: "portal-message-time-event-1",
      clientTurnId: "portal-message-time-turn-1",
      locale: "en-US",
      text: "Just recorded.",
      timezone: "America/Los_Angeles",
    });
    const messages = await service.listRecentMessages(OWNER, {
      dailySessionId: turn.dailySession.id,
    });
    expect(messages).toEqual([
      expect.objectContaining({
        createdAt: submittedAt.toISOString(),
        text: "Just recorded.",
      }),
    ]);
  });

  it("does not expose times for deleted, superseded or purged messages", async () => {
    await openPrivateWrites();
    const deletedAt = new Date("2026-10-06T16:00:01.000Z");
    const correctedAt = new Date("2026-10-06T16:00:02.000Z");
    const purgedAt = new Date("2026-10-06T16:00:03.000Z");
    const session = await seedSession({
      logicalDate: "2026-10-06",
      messages: [
        { actor: "user", createdAt: deletedAt, text: "Deleted." },
        { actor: "user", createdAt: correctedAt, text: "Superseded." },
        { actor: "user", createdAt: purgedAt, text: "Purged." },
      ],
    });

    await database.pool.query(
      `UPDATE conversation_events
       SET lifecycle_status = 'deleted', deleted_at = $2
       WHERE conversation_event_id = $1`,
      [session.events[0]!.eventId, clock()],
    );
    await database.pool.query(
      `UPDATE conversation_events
       SET lifecycle_status = 'superseded'
       WHERE conversation_event_id = $1`,
      [session.events[1]!.eventId],
    );
    await database.pool.query(
      `UPDATE conversation_event_revisions
       SET canonical_text = '', content_purged_at = $2
       WHERE conversation_event_revision_id = $1`,
      [session.events[2]!.revisionId, clock()],
    );

    const messages = await service.listRecentMessages(OWNER, {
      dailySessionId: session.dailySessionId,
    });
    expect(messages).toEqual([]);
  });

  it("does not return another owner's message times", async () => {
    await openPrivateWrites();
    const foreignUserId = createTestUuidV7(clock());
    await database.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [foreignUserId, clock()],
    );
    const foreign = await seedSession({
      logicalDate: "2026-10-04",
      messages: [
        {
          actor: "user",
          createdAt: new Date("2026-10-04T16:00:00.000Z"),
          text: "foreign",
        },
      ],
      userId: foreignUserId,
    });

    expect(
      await service.listRecentMessages(OWNER, {
        dailySessionId: foreign.dailySessionId,
      }),
    ).toEqual([]);
    expect(await service.readCurrentConversation(asUserId(foreignUserId))).toBeNull();
  });
});
