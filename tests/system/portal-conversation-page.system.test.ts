import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CONVERSATION_DATE_PAGE_LIMIT,
  ConversationSessionNotFoundError,
  createRecoveryGate,
  createUserTextConversationService,
  InvalidConversationCursorError,
  OLDER_CONVERSATION_MESSAGE_LIMIT,
  RECENT_CONVERSATION_MESSAGE_LIMIT,
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
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

/**
 * SPEC #260 ticket #262 against real PostgreSQL: the portal's chat date list
 * and per-session message history paginate with fixed server-side caps and
 * stable, query-bound cursors. Reads are owner-scoped, never create a Daily
 * Session, and the recovery gate and purge/epoch fences stay closed.
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

function logicalDateForDay(offset: number): string {
  const date = new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000);
  return date.toISOString().slice(0, 10);
}

type SeedMessage = Readonly<{ actor: "user" | "assistant"; text: string }>;
type SeedEvent = Readonly<{
  eventId: string;
  revisionId: string;
  sequence: number;
  text: string;
}>;

describe("Portal chat history pagination system seam", () => {
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
      subject: "portal-conversation-page-test-owner",
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

  async function seedSession(input: {
    activityState?: "active" | "finalized" | "quiescent";
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
          input.activityState ?? "finalized",
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
              now,
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
            now,
          ],
        );
        await client.query(
          `INSERT INTO conversation_event_revisions (
             conversation_event_revision_id, user_id, conversation_event_id,
             revision, locale, canonical_text, transcript_status, created_by,
             created_at
           ) VALUES ($1, $2, $3, 1, 'en-US', $4, 'final', 'client', $5)`,
          [revisionId, userId, eventId, message.text, now],
        );
        await client.query(
          `UPDATE conversation_events SET current_revision_id = $1
           WHERE conversation_event_id = $2`,
          [revisionId, eventId],
        );
        events.push({
          eventId,
          revisionId,
          sequence: eventSequence,
          text: message.text,
        });
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

  async function countSessions(): Promise<number> {
    const result = await database.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM daily_sessions",
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async function seedForeignOwner(): Promise<{
    dailySessionId: string;
    logicalDate: string;
    userId: string;
  }> {
    const userId = createTestUuidV7(clock());
    await database.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [userId, clock()],
    );
    const session = await seedSession({
      logicalDate: "2026-02-02",
      messages: [{ actor: "user", text: "foreign owner message" }],
      userId,
    });
    return {
      dailySessionId: session.dailySessionId,
      logicalDate: "2026-02-02",
      userId,
    };
  }

  it(
    "paginates the date list newest-first with a stable cursor and no duplicates",
    async () => {
      for (let offset = 0; offset < 100; offset += 1) {
        await seedSession({
          logicalDate: logicalDateForDay(offset),
          messages: [{ actor: "user", text: `day ${offset}` }],
        });
      }
      await seedSession({
        activityState: "active",
        logicalDate: "2026-10-06",
        messages: [{ actor: "user", text: "current" }],
      });

      const first = await service.listConversationDates(OWNER, {
        cursor: null,
      });
      expect(first.entries).toHaveLength(CONVERSATION_DATE_PAGE_LIMIT);
      expect(first.entries[0]?.logicalDate).toBe("2026-04-10");
      expect(first.nextCursor).not.toBeNull();

      const collected = [...first.entries];
      let cursor = first.nextCursor;
      let pages = 1;
      while (cursor !== null) {
        pages += 1;
        expect(pages).toBeLessThan(20);
        const page = await service.listConversationDates(OWNER, { cursor });
        expect(page.entries.length).toBeGreaterThan(0);
        expect(page.entries.length).toBeLessThanOrEqual(
          CONVERSATION_DATE_PAGE_LIMIT,
        );
        collected.push(...page.entries);
        cursor = page.nextCursor;
      }

      const dates = collected.map((entry) => entry.logicalDate);
      expect(dates).toHaveLength(100);
      expect(new Set(dates).size).toBe(100);
      expect(dates).toEqual([...dates].sort().reverse());
      // The active session is the "current" entry, not a history date.
      expect(dates).not.toContain("2026-10-06");
    },
    60_000,
  );

  it(
    "paginates one session's 500 mixed messages ascending without duplicates or gaps",
    async () => {
      const messages = Array.from({ length: 500 }, (_, index): SeedMessage => ({
        actor: index % 2 === 0 ? "user" : "assistant",
        text: `message ${index + 1}`,
      }));
      const session = await seedSession({
        logicalDate: "2026-05-01",
        messages,
      });

      const initial = await service.listRecentMessages(OWNER, {
        dailySessionId: session.dailySessionId,
      });
      expect(initial).toHaveLength(RECENT_CONVERSATION_MESSAGE_LIMIT);
      expect(initial[0]?.sequence).toBe(451);
      expect(initial.at(-1)?.sequence).toBe(500);

      const collected = [...initial];
      let cursor: string | null = null;
      let beforeSequence: number | null = initial[0]!.sequence;
      let pages = 0;
      while (true) {
        pages += 1;
        expect(pages).toBeLessThan(20);
        const page = await service.listOlderMessages(OWNER, {
          beforeSequence: cursor === null ? beforeSequence : null,
          cursor,
          dailySessionId: session.dailySessionId,
        });
        expect(page.messages.length).toBeLessThanOrEqual(
          OLDER_CONVERSATION_MESSAGE_LIMIT,
        );
        collected.unshift(...page.messages);
        if (page.nextCursor === null) {
          break;
        }
        cursor = page.nextCursor;
        beforeSequence = null;
      }

      expect(collected).toHaveLength(500);
      expect(collected.map((message) => message.sequence)).toEqual(
        Array.from({ length: 500 }, (_, index) => index + 1),
      );
      expect(new Set(collected.map((message) => message.eventId)).size).toBe(
        500,
      );
      expect(collected.every((message) => message.text.length > 0)).toBe(true);
    },
    60_000,
  );

  it("treats a Daily Session date and the list selection as independent of the writable identity", async () => {
    const active = await seedSession({
      activityState: "active",
      logicalDate: "2026-10-06",
      messages: [{ actor: "user", text: "active exchange" }],
    });
    await seedSession({
      logicalDate: "2026-10-05",
      messages: [{ actor: "user", text: "earlier day" }],
    });

    const identity = await service.readCurrentConversation(OWNER);
    expect(identity?.dailySessionId).toBe(active.dailySessionId);

    const dates = await service.listConversationDates(OWNER, { cursor: null });
    expect(dates.entries.map((entry) => entry.logicalDate)).toEqual([
      "2026-10-05",
    ]);

    const selected = await service.readConversationByDate(OWNER, "2026-10-05");
    expect(selected?.dailySessionId).not.toBe(identity?.dailySessionId);
    expect((await service.readCurrentConversation(OWNER))?.dailySessionId).toBe(
      active.dailySessionId,
    );
  }, 30_000);

  it("fails a malformed, missing, or foreign date and session explicitly", async () => {
    await seedSession({
      logicalDate: "2026-03-03",
      messages: [{ actor: "user", text: "owned" }],
    });
    const foreign = await seedForeignOwner();

    expect(await service.readConversationByDate(OWNER, "2026-1-1")).toBeNull();
    expect(await service.readConversationByDate(OWNER, "1999-12-31")).toBeNull();
    expect(
      await service.readConversationByDate(OWNER, foreign.logicalDate),
    ).toBeNull();

    const dates = await service.listConversationDates(OWNER, { cursor: null });
    expect(dates.entries.map((entry) => entry.logicalDate)).toEqual([
      "2026-03-03",
    ]);

    await expect(
      service.listOlderMessages(OWNER, {
        beforeSequence: 1,
        dailySessionId: foreign.dailySessionId,
      }),
    ).rejects.toBeInstanceOf(ConversationSessionNotFoundError);
    await expect(
      service.listOlderMessages(OWNER, {
        beforeSequence: 1,
        dailySessionId: createTestUuidV7(clock()),
      }),
    ).rejects.toBeInstanceOf(ConversationSessionNotFoundError);
  }, 30_000);

  it(
    "rejects invalid, tampered, and cross-query cursors",
    async () => {
      for (let offset = 0; offset < 40; offset += 1) {
        await seedSession({
          logicalDate: logicalDateForDay(offset),
          messages: [{ actor: "user", text: `day ${offset}` }],
        });
      }
      const bigSession = await seedSession({
        logicalDate: "2026-06-01",
        messages: Array.from(
          { length: OLDER_CONVERSATION_MESSAGE_LIMIT + 5 },
          (_, index): SeedMessage => ({
            actor: index % 2 === 0 ? "user" : "assistant",
            text: `big ${index + 1}`,
          }),
        ),
      });

      const datePage = await service.listConversationDates(OWNER, {
        cursor: null,
      });
      const datesCursor = datePage.nextCursor;
      expect(datesCursor).not.toBeNull();

      const messagePage = await service.listOlderMessages(OWNER, {
        beforeSequence: 56,
        dailySessionId: bigSession.dailySessionId,
      });
      const messagesCursor = messagePage.nextCursor;
      expect(messagesCursor).not.toBeNull();

      // Cross-query: a dates cursor is not a messages cursor and vice versa.
      await expect(
        service.listConversationDates(OWNER, { cursor: messagesCursor }),
      ).rejects.toBeInstanceOf(InvalidConversationCursorError);
      await expect(
        service.listOlderMessages(OWNER, {
          cursor: datesCursor,
          dailySessionId: bigSession.dailySessionId,
        }),
      ).rejects.toBeInstanceOf(InvalidConversationCursorError);

      // Cross-session: a cursor bound to one session cannot page another.
      const other = await seedSession({
        logicalDate: "2026-06-02",
        messages: Array.from(
          { length: OLDER_CONVERSATION_MESSAGE_LIMIT + 5 },
          (_, index): SeedMessage => ({
            actor: index % 2 === 0 ? "user" : "assistant",
            text: `other ${index + 1}`,
          }),
        ),
      });
      await expect(
        service.listOlderMessages(OWNER, {
          cursor: messagesCursor,
          dailySessionId: other.dailySessionId,
        }),
      ).rejects.toBeInstanceOf(InvalidConversationCursorError);

      // Tampered / malformed tokens fail closed.
      const tampered = `${messagesCursor!}x`;
      await expect(
        service.listOlderMessages(OWNER, {
          cursor: tampered,
          dailySessionId: bigSession.dailySessionId,
        }),
      ).rejects.toBeInstanceOf(InvalidConversationCursorError);
      await expect(
        service.listConversationDates(OWNER, { cursor: "not-a-cursor" }),
      ).rejects.toBeInstanceOf(InvalidConversationCursorError);
      await expect(
        service.listOlderMessages(OWNER, {
          dailySessionId: bigSession.dailySessionId,
        }),
      ).rejects.toBeInstanceOf(InvalidConversationCursorError);
    },
    60_000,
  );

  it("fails all history reads closed when the recovery gate is closed", async () => {
    const session = await seedSession({
      logicalDate: "2026-08-08",
      messages: [{ actor: "user", text: "fenced" }],
    });
    await database.pool.query(
      "UPDATE app_users SET status = 'deleting', updated_at = $2 WHERE user_id = $1",
      [OWNER, clock()],
    );

    await expect(
      service.listConversationDates(OWNER, { cursor: null }),
    ).rejects.toBeInstanceOf(RecoveryGateClosedError);
    await expect(
      service.readConversationByDate(OWNER, "2026-08-08"),
    ).rejects.toBeInstanceOf(RecoveryGateClosedError);
    await expect(
      service.listOlderMessages(OWNER, {
        beforeSequence: 1,
        dailySessionId: session.dailySessionId,
      }),
    ).rejects.toBeInstanceOf(RecoveryGateClosedError);
    await expect(service.readCurrentConversation(OWNER)).rejects.toBeInstanceOf(
      RecoveryGateClosedError,
    );

    // An advanced data epoch without its external marker stays closed too.
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 2, updated_at = $2 WHERE user_id = $1",
      [OWNER, clock()],
    );
    await expect(
      service.listConversationDates(OWNER, { cursor: null }),
    ).rejects.toBeInstanceOf(RecoveryGateClosedError);
  }, 30_000);

  it("never returns deleted, superseded, or purged history content", async () => {
    const session = await seedSession({
      logicalDate: "2026-07-01",
      messages: [
        { actor: "user", text: "deleted expression" },
        { actor: "assistant", text: "purged reply" },
        { actor: "user", text: "superseded expression" },
        { actor: "assistant", text: "kept reply" },
      ],
    });
    const [deletedEvent, purgedEvent, supersededEvent] = session.events;

    await database.pool.query(
      `UPDATE conversation_events
       SET lifecycle_status = 'deleted', deleted_at = $2
       WHERE conversation_event_id = $1`,
      [deletedEvent!.eventId, clock()],
    );
    await database.pool.query(
      `UPDATE conversation_event_revisions
       SET canonical_text = '', content_purged_at = $2
       WHERE conversation_event_revision_id = $1`,
      [purgedEvent!.revisionId, clock()],
    );
    const correctedRevisionId = createTestUuidV7(clock());
    await database.pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, locale, canonical_text, transcript_status, created_by,
         created_at
       ) VALUES ($1, $2, $3, 2, 'en-US', 'corrected expression', 'corrected',
         'user_correction', $4)`,
      [correctedRevisionId, OWNER, supersededEvent!.eventId, clock()],
    );
    await database.pool.query(
      `UPDATE conversation_events SET current_revision_id = $1
       WHERE conversation_event_id = $2`,
      [correctedRevisionId, supersededEvent!.eventId],
    );

    const messages = await service.listRecentMessages(OWNER, {
      dailySessionId: session.dailySessionId,
    });
    expect(messages.map((message) => message.text)).toEqual([
      "corrected expression",
      "kept reply",
    ]);

    const older = await service.listOlderMessages(OWNER, {
      beforeSequence: 100,
      dailySessionId: session.dailySessionId,
    });
    expect(
      older.messages.map((message) => message.text),
    ).toEqual(["corrected expression", "kept reply"]);
    expect(JSON.stringify(messages)).not.toContain("deleted expression");
    expect(JSON.stringify(messages)).not.toContain("purged reply");
    expect(JSON.stringify(messages)).not.toContain("superseded expression");
  }, 30_000);

  it("never creates a Daily Session while reading history", async () => {
    expect(await countSessions()).toBe(0);

    expect(await service.listConversationDates(OWNER, { cursor: null })).toMatchObject({
      entries: [],
      nextCursor: null,
    });
    expect(await service.readConversationByDate(OWNER, "2026-01-01")).toBeNull();
    await expect(
      service.listOlderMessages(OWNER, {
        beforeSequence: 1,
        dailySessionId: createTestUuidV7(clock()),
      }),
    ).rejects.toBeInstanceOf(ConversationSessionNotFoundError);
    expect(await countSessions()).toBe(0);

    await seedSession({
      logicalDate: "2026-09-09",
      messages: [{ actor: "user", text: "only session" }],
    });
    await service.listConversationDates(OWNER, { cursor: null });
    expect(await countSessions()).toBe(1);
  }, 30_000);
});
