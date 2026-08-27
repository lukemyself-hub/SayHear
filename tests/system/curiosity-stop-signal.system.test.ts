import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  asGenerationCommandId,
  countFollowUpQuestions,
  createContextCompiler,
  createConversationAgentHarness,
  createConversationResponseService,
  createUserTextConversationService,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  validateUnderstandingResponse,
  type ConversationTextChampion,
  type ConversationTurnSignal,
  type CuriosityStopSignalProposal,
} from "@sayhear/application";
import { createBehaviorAwareConversationTextModel, createProviderEgressPort } from "@sayhear/ai/testing";
import {
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

import { createConversationResponseHandler } from "../../apps/web/src/conversation-response-handler";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required; the system seam never falls back to a mock database.",
  );
}

const BASE_TIME_MS = Date.parse("2026-07-27T16:00:00.000Z");

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
  supportedLocales: Object.freeze(["en", "zh"]),
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
  personaVersion: "sayhear-persona:v1",
  productPolicyVersion: "product-policy:v1",
  promptVersion: "conversation-text:v1",
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
  taskInstructionVersion: "task-instruction-decision:v1",
});

describe("Authenticated Internal Text Conversation System Seam — Curiosity Stop Signal projection", () => {
  let database: IsolatedPostgresSchema;
  let clockNowMs = BASE_TIME_MS;
  const clock = () => new Date(clockNowMs);

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
    clockNowMs = BASE_TIME_MS;
    await database.pool.query(`
      TRUNCATE TABLE
        entity_mention_candidates,
        entity_mentions,
        entity_labels,
        user_self_entities,
        entity_versions,
        entities,
        conversation_action_payloads,
        conversation_action_receipts,
        conversation_action_executions,
        conversation_action_handles,
        current_curiosity_stop_signals,
        safety_posture_alerts,
        current_safety_postures,
        safety_postures,
        curiosity_stop_signals,
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

  function createService(input: {
    responder: (turn: {
      history: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
      locale: string;
      signal: ConversationTurnSignal;
      text: string;
    }) => readonly string[];
    stopSignalProposals?: (turn: {
      locale: string;
      signal: ConversationTurnSignal;
      text: string;
    }) => readonly CuriosityStopSignalProposal[] | null;
  }) {
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const contextCompiler = createContextCompiler({
      clock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      repository: responseRepository,
    });
    const conversationService = createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: testGenerationPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const service = createConversationResponseService({
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
          model: createBehaviorAwareConversationTextModel({
            responder: input.responder,
            ...(input.stopSignalProposals
              ? { stopSignalProposals: input.stopSignalProposals }
              : {}),
          }),
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });
    return { conversationService, service };
  }

  async function submit(
    service: ReturnType<typeof createService>["service"],
    input: { text: string; turnId: string },
  ) {
    const response = await createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    })(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify({
          clientEventId: `${input.turnId}-event`,
          clientTurnId: input.turnId,
          locale: "en-US",
          text: input.text,
          timezone: "America/Los_Angeles",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)?.type).toBe("assistant_committed");
    return {
      deltas: events
        .filter((event) => event.type === "assistant_delta")
        .map((event) => String(event.delta ?? ""))
        .join(""),
      generationCommandId: String(events[0]?.generationCommandId),
    };
  }

  async function compiledSections(generationCommandId: string) {
    const result = await database.pool.query<{
      key: string;
      content_reference: string;
    }>(`
      SELECT section->>'key' AS key, section->>'reference' AS content_reference
      FROM compiled_contexts context
      INNER JOIN generation_commands command
        ON command.compiled_context_id = context.compiled_context_id
      CROSS JOIN LATERAL jsonb_array_elements(context.sections) AS section
      WHERE command.generation_command_id = $1
    `, [generationCommandId]);
    return result.rows;
  }

  async function projectionVersion() {
    const result = await database.pool.query<{
      content: Record<string, unknown>;
      version_no: string;
      committed_generation_command_id: string;
      source_revision: string;
    }>(`
      SELECT version.content, version.version_no,
        version.committed_generation_command_id, version.source_revision
      FROM current_curiosity_stop_signals current
      INNER JOIN curiosity_stop_signals version
        ON version.curiosity_stop_signal_id = current.curiosity_stop_signal_id
    `);
    return result.rows[0] ?? null;
  }

  async function endCurrentExchange(
    conversationService: ReturnType<typeof createService>["conversationService"],
  ) {
    const session = await database.pool.query<{ daily_session_id: string }>(
      `SELECT daily_session_id FROM daily_sessions ORDER BY created_at DESC LIMIT 1`,
    );
    await conversationService.endContinuousExchange(
      fixedInternalOwnerPrincipal.userId,
      { dailySessionId: session.rows[0]!.daily_session_id },
    );
  }

  it("commits a model-proposed direction suppression deterministically and keeps a minimal evidence envelope", async () => {
    const { service } = createService({
      responder: (turn) => [
        turn.text === "Work has been crushing me this month."
          ? "That sounds heavy. What does the pressure feel like day to day?"
          : "Understood — I will not push on that.",
      ],
      stopSignalProposals: (turn) =>
        turn.text === "I don't want to talk about the work pressure."
          ? [
              {
                direction: "work pressure",
                kind: "suppress_direction" as const,
                signalKind: "refused" as const,
              },
            ]
          : null,
    });

    await submit(service, {
      text: "Work has been crushing me this month.",
      turnId: "suppress-turn-1",
    });
    await submit(service, {
      text: "I don't want to talk about the work pressure.",
      turnId: "suppress-turn-2",
    });

    const version = await projectionVersion();
    expect(version).not.toBeNull();
    expect(Number(version!.version_no)).toBe(1);
    expect(
      asGenerationCommandId(version!.committed_generation_command_id),
    ).toBeTruthy();
    const directions = version!.content
      .suppressedDirections as unknown as Record<string, unknown>[];
    expect(directions).toHaveLength(1);
    expect(directions[0]).toMatchObject({
      committedInExchangeNo: 1,
      direction: "work pressure",
      releasedBy: null,
      signalKind: "refused",
    });
    // Minimal envelope: revision references and enums only — the projection
    // record never duplicates user or assistant content.
    const envelope = JSON.stringify(version!.content);
    expect(envelope).not.toContain("crushing");
    expect(envelope).not.toContain("What does the pressure feel like");
    expect(envelope).not.toContain("don't want to talk");
  });

  it("keeps the direction suppressed across Continuous Exchanges within the session until the user re-opens it", async () => {
    const { conversationService, service } = createService({
      responder: (turn) => [
        turn.text === "Work has been crushing me this month."
          ? "That sounds heavy. What does the pressure feel like day to day?"
          : "I hear you.",
      ],
      stopSignalProposals: (turn) => {
        if (turn.text === "I don't want to talk about the work pressure.") {
          return [
            {
              direction: "work pressure",
              kind: "suppress_direction" as const,
              signalKind: "refused" as const,
            },
          ];
        }
        if (
          turn.text ===
          "Actually, about the work pressure — I think it is my manager."
        ) {
          return [
            {
              direction: "work pressure",
              kind: "release_direction" as const,
              releaseReason: "user_reopened" as const,
            },
          ];
        }
        if (turn.text === "The weather has been strange.") {
          return [
            {
              direction: "work pressure",
              kind: "release_direction" as const,
              releaseReason: "user_reopened" as const,
            },
          ];
        }
        return null;
      },
    });

    await submit(service, {
      text: "Work has been crushing me this month.",
      turnId: "exchange-1-turn-1",
    });
    await submit(service, {
      text: "I don't want to talk about the work pressure.",
      turnId: "exchange-1-turn-2",
    });
    await endCurrentExchange(conversationService);

    // A later Continuous Exchange within the same day's session: the compile
    // carries the suppression as a deterministic input section.
    const afterExchange = await submit(service, {
      text: "I had a nice weekend otherwise.",
      turnId: "exchange-2-turn-1",
    });
    const sections = await compiledSections(afterExchange.generationCommandId);
    const stopSignal = sections.find(
      (section) => section.key === "curiosity_stop_signal",
    );
    expect(stopSignal?.content_reference).toContain("work pressure (refused)");
    expect(stopSignal?.content_reference).toContain(
      "zero questions is always valid",
    );

    // An unrelated turn does not release the direction.
    const unrelatedTurn = await submit(service, {
      text: "The weather has been strange.",
      turnId: "exchange-2-turn-2",
    });
    const unrelatedSections = await compiledSections(
      unrelatedTurn.generationCommandId,
    );
    expect(
      unrelatedSections.find(
        (section) => section.key === "curiosity_stop_signal",
      )?.content_reference,
    ).toContain("work pressure (refused)");

    // The user re-opens the topic: the model proposes, deterministic code
    // releases, and the next compile no longer carries the section.
    await submit(service, {
      text: "Actually, about the work pressure — I think it is my manager.",
      turnId: "exchange-2-turn-3",
    });
    const released = await projectionVersion();
    const releasedDirections = released!.content
      .suppressedDirections as unknown as Record<string, unknown>[];
    expect(releasedDirections[0]!.releasedBy).toMatchObject({
      reason: "user_reopened",
    });

    const afterRelease = await submit(service, {
      text: "It builds up every standup.",
      turnId: "exchange-2-turn-4",
    });
    const sectionsAfterRelease = await compiledSections(
      afterRelease.generationCommandId,
    );
    expect(
      sectionsAfterRelease.find(
        (section) => section.key === "curiosity_stop_signal",
      ),
    ).toBeUndefined();
  });

  it("releases a suppressed direction on new substantive content without a topic re-open", async () => {
    const { service } = createService({
      responder: (turn) => [
        turn.text === "We keep arguing about the family plans for the holidays."
          ? "That sounds tense. What would feel right to you?"
          : "I hear you.",
      ],
      stopSignalProposals: (turn) =>
        turn.text === "Please, not the family plans question."
          ? [
              {
                direction: "family plans",
                kind: "suppress_direction" as const,
                signalKind: "avoided" as const,
              },
            ]
          : turn.text ===
              "I accepted the offer abroad — that settles what happens with the family plans."
            ? [
                {
                  direction: "family plans",
                  kind: "release_direction" as const,
                  releaseReason: "new_substantive_content" as const,
                },
              ]
            : null,
    });

    await submit(service, {
      text: "We keep arguing about the family plans for the holidays.",
      turnId: "substantive-turn-1",
    });
    await submit(service, {
      text: "Please, not the family plans question.",
      turnId: "substantive-turn-2",
    });
    await submit(service, {
      text: "I accepted the offer abroad — that settles what happens with the family plans.",
      turnId: "substantive-turn-3",
    });

    const version = await projectionVersion();
    const directions = version!.content
      .suppressedDirections as unknown as Record<string, unknown>[];
    expect(directions[0]!.releasedBy).toMatchObject({
      reason: "new_substantive_content",
    });
  });

  it("scopes the blanket stop-asking form to the current Continuous Exchange", async () => {
    const { conversationService, service } = createService({
      responder: (turn) => [
        turn.text === "Honestly, stop asking questions for now."
          ? "Of course — no questions from me for now."
          : "What mattered most about it?",
      ],
      stopSignalProposals: (turn) =>
        turn.text === "Honestly, stop asking questions for now."
          ? [{ kind: "suppress_all_questions" as const }]
          : null,
    });

    await submit(service, {
      text: "Something happened at the office today.",
      turnId: "blanket-turn-1",
    });
    const blanketTurn = await submit(service, {
      text: "Honestly, stop asking questions for now.",
      turnId: "blanket-turn-2",
    });
    expect(countFollowUpQuestions(blanketTurn.deltas)).toBe(0);
    expect(validateUnderstandingResponse(blanketTurn.deltas).violations).toEqual(
      [],
    );
    const version = await projectionVersion();
    expect(version!.content.blanketStop).toMatchObject({
      exchangeNo: 1,
      releasedBy: null,
    });

    await endCurrentExchange(conversationService);
    const nextExchange = await submit(service, {
      text: "Anyway, I watched a good film last night.",
      turnId: "blanket-turn-3",
    });
    // The next Continuous Exchange never inherits the blanket form: the
    // section is absent without any write, and ordinary questioning may
    // resume.
    const sections = await compiledSections(nextExchange.generationCommandId);
    expect(
      sections.find((section) => section.key === "curiosity_stop_signal"),
    ).toBeUndefined();
    expect(countFollowUpQuestions(nextExchange.deltas)).toBe(1);
  });

  it("does not carry suppression into the next day's session", async () => {
    const { conversationService, service } = createService({
      responder: (turn) => [
        turn.text === "Work has been crushing me this month."
          ? "That sounds heavy. What does the pressure feel like day to day?"
          : "I hear you.",
      ],
      stopSignalProposals: (turn) =>
        turn.text === "I don't want to talk about the work pressure."
          ? [
              {
                direction: "work pressure",
                kind: "suppress_direction" as const,
                signalKind: "refused" as const,
              },
            ]
          : null,
    });

    await submit(service, {
      text: "Work has been crushing me this month.",
      turnId: "day-1-turn-1",
    });
    await submit(service, {
      text: "I don't want to talk about the work pressure.",
      turnId: "day-1-turn-2",
    });
    expect(await projectionVersion()).not.toBeNull();

    // A Daily Session does not split at midnight (ADR-0012): the day ends via
    // the deterministic Continuous Exchange end, and the next day's exchange
    // starts a fresh session with no suppression carried over.
    await endCurrentExchange(conversationService);
    clockNowMs += 24 * 60 * 60 * 1_000;
    const nextDay = await submit(service, {
      text: "A fresh morning.",
      turnId: "day-2-turn-1",
    });
    const sessions = await database.pool.query(
      `SELECT COUNT(*)::int AS count FROM daily_sessions`,
    );
    expect(sessions.rows[0]!.count).toBe(2);
    const sections = await compiledSections(nextDay.generationCommandId);
    expect(
      sections.find((section) => section.key === "curiosity_stop_signal"),
    ).toBeUndefined();
  });

  it("commits nothing when the model proposes a suppression without a preceding assistant question", async () => {
    const { service } = createService({
      responder: () => ["I hear you."],
      stopSignalProposals: () => [
        {
          direction: "work pressure",
          kind: "suppress_direction" as const,
          signalKind: "refused" as const,
        },
      ],
    });

    const first = await submit(service, {
      text: "A brand new conversation.",
      turnId: "no-question-turn-1",
    });
    expect(first.deltas).toBe("I hear you.");
    const versions = await database.pool.query(
      `SELECT COUNT(*)::int AS count FROM curiosity_stop_signals`,
    );
    expect(versions.rows[0]!.count).toBe(0);
    const sections = await compiledSections(first.generationCommandId);
    expect(
      sections.find((section) => section.key === "curiosity_stop_signal"),
    ).toBeUndefined();
  });
});
