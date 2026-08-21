import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  asGenerationCommandId,
  classifyConversationTurnSignal,
  countFollowUpQuestions,
  createContextCompiler,
  createConversationAgentHarness,
  createConversationResponseService,
  createUserTextConversationService,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  renderMinimumHighRiskResponse,
  validateMinimumHighRiskResponse,
  validateUnderstandingResponse,
  type ConversationTextChampion,
  type ConversationTurnSignal,
} from "@sayhear/application";
import { createBehaviorAwareConversationTextModel, createProviderEgressPort } from "@sayhear/ai/testing";
import {
  PostgresConversationResponseRepository,
  PostgresInternalInspectionRepository,
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

const fixedResponseClock = () => new Date("2026-07-27T16:00:00.000Z");

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
  personaVersion: "sayhear-persona:v1",
  productPolicyVersion: "product-policy:v1",
  promptVersion: "conversation-text:v1",
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
});

describe("Authenticated Internal Text Conversation System Seam — bilingual behavior", () => {
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
      validUntil: new Date("2026-08-27T16:00:00.000Z"),
      verifiedAt: new Date("2026-07-27T15:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  function createService(responder: (turn: {
    history: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
    locale: string;
    signal: ConversationTurnSignal;
    text: string;
  }) => readonly string[]) {
    const responseRepository = new PostgresConversationResponseRepository(
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
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const service = createConversationResponseService({
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
          model: createBehaviorAwareConversationTextModel({ responder }),
          repository: responseRepository,
        }),
        repository: responseRepository,
      }),
      harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });
    return { conversationService, contextCompiler, service };
  }

  async function submit(
    service: ReturnType<typeof createService>["service"],
    input: {
      clientEventId: string;
      clientTurnId: string;
      locale: string;
      text: string;
      timezone?: string;
    },
  ) {
    const response = await createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    })(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify({
          clientEventId: input.clientEventId,
          clientTurnId: input.clientTurnId,
          locale: input.locale,
          text: input.text,
          timezone: input.timezone ?? "America/Los_Angeles",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    return readNdjson(response);
  }

  it("completes a bilingual multi-turn conversation through the same Web/BFF path", async () => {
    const responses = new Map<string, string>([
      [
        "I felt invisible in that meeting today.",
        "That sounds painful. What did you most wish had been seen?",
      ],
      [
        "I just wanted someone, anyone, to notice I was there.",
        "Wanting to be noticed like that makes sense. What would being seen have looked like for you?",
      ],
      ["Never mind, it doesn't matter.", "Okay — no pressure to sort it out now."],
    ]);
    const { service } = createService((turn) => [responses.get(turn.text) ?? "I hear you."]);

    const first = await submit(service, {
      clientEventId: "en-event-1",
      clientTurnId: "en-turn-1",
      locale: "en-US",
      text: "I felt invisible in that meeting today.",
    });
    expect(first.at(-1)?.type).toBe("assistant_committed");
    const firstResponse = joinDeltas(first);
    expect(firstResponse).toBe(
      "That sounds painful. What did you most wish had been seen?",
    );
    expect(validateUnderstandingResponse(firstResponse).violations).toEqual([]);

    const second = await submit(service, {
      clientEventId: "en-event-2",
      clientTurnId: "en-turn-2",
      locale: "en-US",
      text: "I just wanted someone, anyone, to notice I was there.",
    });
    expect(second.at(-1)?.type).toBe("assistant_committed");
    expect(validateUnderstandingResponse(joinDeltas(second)).violations).toEqual(
      [],
    );

    const priorContext = await database.pool.query<{
      actor: string;
      ordinal: number;
      text: string;
    }>(`
      SELECT ref.actor, ref.ordinal, revision.canonical_text AS text
      FROM generation_commands command
      INNER JOIN interaction_turns turn
        ON turn.interaction_turn_id = command.interaction_turn_id
      INNER JOIN compiled_context_revision_refs ref
        ON ref.compiled_context_id = command.compiled_context_id
      INNER JOIN conversation_event_revisions revision
        ON revision.conversation_event_revision_id = ref.conversation_event_revision_id
      WHERE turn.turn_sequence_no = 2
      ORDER BY ref.ordinal
    `);
    expect(priorContext.rows.map((row) => row.text)).toEqual([
      "I felt invisible in that meeting today.",
      "That sounds painful. What did you most wish had been seen?",
      "I just wanted someone, anyone, to notice I was there.",
    ]);
  });

  it("asks at most one current-expression-anchored question and stops after a stop signal", async () => {
    const responses = new Map<string, string>([
      [
        "今天的会议我一句话都没插上。",
        "听起来你很希望被听见。那一刻你最想表达的是什么？",
      ],
      [
        "对，我就是希望有人能注意到我。",
        "希望被注意到是很自然的。如果当时被看见了，你希望发生什么？",
      ],
      ["算了，没什么。", "没关系，你现在不用想清楚。"],
    ]);
    const seenSignals: ConversationTurnSignal[] = [];
    const { service } = createService((turn) => {
      seenSignals.push(turn.signal);
      return [responses.get(turn.text) ?? "听到了。"];
    });

    const engaged = await submit(service, {
      clientEventId: "zh-event-1",
      clientTurnId: "zh-turn-1",
      locale: "zh-CN",
      text: "今天的会议我一句话都没插上。",
    });
    const engagedResponse = joinDeltas(engaged);
    expect(validateUnderstandingResponse(engagedResponse).violations).toEqual([]);
    expect(countFollowUpQuestions(engagedResponse)).toBe(1);

    const followUp = await submit(service, {
      clientEventId: "zh-event-2",
      clientTurnId: "zh-turn-2",
      locale: "zh-CN",
      text: "对，我就是希望有人能注意到我。",
    });
    expect(countFollowUpQuestions(joinDeltas(followUp))).toBe(1);

    expect(
      classifyConversationTurnSignal({ locale: "zh-CN", text: "算了，没什么。" }),
    ).not.toBe("engaged");
    const stopped = await submit(service, {
      clientEventId: "zh-event-3",
      clientTurnId: "zh-turn-3",
      locale: "zh-CN",
      text: "算了，没什么。",
    });
    const stoppedResponse = joinDeltas(stopped);
    expect(seenSignals.at(-1)).not.toBe("engaged");
    expect(countFollowUpQuestions(stoppedResponse)).toBe(0);
    expect(stoppedResponse).not.toContain("被注意到");
    expect(validateUnderstandingResponse(stoppedResponse).violations).toEqual([]);
  });

  it("preserves natural code-switching and the original BCP-47 locale independently from the IANA timezone", async () => {
    const { service } = createService(() => [
      "那种没被认可的感觉一定很难受。你最希望他们看到你的哪一部分？",
    ]);
    const codeSwitched = "今天的 review 让我觉得很 unappreciated。";
    const events = await submit(service, {
      clientEventId: "code-switch-event",
      clientTurnId: "code-switch-turn",
      locale: "zh-Hans-CN",
      text: codeSwitched,
      timezone: "America/Los_Angeles",
    });
    expect(events.at(-1)?.type).toBe("assistant_committed");

    const stored = await database.pool.query<{
      locale: string;
      text: string;
      timezone: string;
    }>(`
      SELECT command.locale, revision.canonical_text AS text, session.timezone_at_start AS timezone
      FROM generation_commands command
      INNER JOIN interaction_turns turn
        ON turn.interaction_turn_id = command.interaction_turn_id
      INNER JOIN daily_sessions session
        ON session.daily_session_id = turn.daily_session_id
      INNER JOIN conversation_events event
        ON event.interaction_turn_id = turn.interaction_turn_id
          AND event.actor = 'user'
      INNER JOIN conversation_event_revisions revision
        ON revision.conversation_event_revision_id = event.current_revision_id
    `);
    expect(stored.rows[0]).toEqual({
      locale: "zh-Hans-CN",
      text: codeSwitched,
      timezone: "America/Los_Angeles",
    });
    expect(stored.rows[0]?.text).toContain("review");
    expect(stored.rows[0]?.text).toContain("unappreciated");
  });

  it.each([
    {
      label: "English self-harm",
      kind: "self_harm" as const,
      locale: "en-US",
      text: "I want to kill myself tonight.",
    },
    {
      label: "Chinese imminent danger",
      kind: "imminent_danger" as const,
      locale: "zh-CN",
      text: "我已经站在窗边了，我真的控制不住了。",
    },
    {
      label: "English harm-to-others",
      kind: "harm_to_others" as const,
      locale: "en-US",
      text: "I am going to hurt someone close to me.",
    },
  ])(
    "activates the versioned Minimum High-Risk Response for $label through the full commit path",
    async ({ kind, locale, text }) => {
      let responderCalls = 0;
      const { service } = createService(() => {
        responderCalls += 1;
        return ["must not produce ordinary listening under high risk"];
      });

      const events = await submit(service, {
        clientEventId: `high-risk-${kind}-event`,
        clientTurnId: `high-risk-${kind}-turn`,
        locale,
        text,
      });
      expect(events.map((event) => event.type)).toEqual([
        "user_committed",
        "assistant_delta",
        "assistant_committed",
      ]);
      expect(responderCalls).toBe(0);
      const response = joinDeltas(events);
      expect(response).toBe(renderMinimumHighRiskResponse({ kind, locale }));
      expect(validateMinimumHighRiskResponse(response).violations).toEqual([]);

      const committed = await database.pool.query<{
        assistant_events: string;
        attempt_status: string;
        command_status: string;
        safety_policy_version: string;
        turn_status: string;
      }>(`
        SELECT
          command.status AS command_status,
          command.safety_policy_version,
          attempt.status AS attempt_status,
          turn.status AS turn_status,
          (
            SELECT COUNT(*)::text
            FROM conversation_events
            WHERE actor = 'assistant'
          ) AS assistant_events
        FROM generation_commands command
        INNER JOIN model_run_attempts attempt
          ON attempt.generation_command_id = command.generation_command_id
        INNER JOIN interaction_turns turn
          ON turn.interaction_turn_id = command.interaction_turn_id
      `);
      expect(committed.rows[0]).toEqual({
        assistant_events: "1",
        attempt_status: "succeeded",
        command_status: "succeeded",
        safety_policy_version: "minimum-high-risk-response:v1",
        turn_status: "settled",
      });
    },
  );

  it("records the versioned policy identities on the generation metadata of a bilingual turn", async () => {
    const { service } = createService(() => [
      "听到了，这件事对你很重要。",
    ]);
    const events = await submit(service, {
      clientEventId: "policy-event",
      clientTurnId: "policy-turn",
      locale: "zh-CN",
      text: "今天的 review 让我有点失落。",
    });
    const generationCommandId = asGenerationCommandId(
      String(events[0]?.generationCommandId),
    );
    const metadata = await new PostgresInternalInspectionRepository(
      database.pool,
    ).findGenerationMetadata({
      generationCommandId,
      userId: fixedInternalOwnerPrincipal.userId,
    });
    expect(metadata?.compiledContext.policyVersions).toMatchObject({
      localePolicyVersion: "locale-pack-zh:v1",
      outputFormatVersion: "conversation-output:v1",
      personaVersion: "sayhear-persona:v1",
      productPolicyVersion: "product-policy:v1",
      relationshipPolicyVersion: "relationship-boundary:v1",
      safetyPolicyVersion: "minimum-high-risk-response:v1",
      taskInstructionVersion: "conversation-text:v1",
    });
    expect(metadata?.compiledContext.locale).toBe("zh-CN");
  });

  it("creates no Journal product state and leaves the 1A.2 durability foundation empty while a conversation is active", async () => {
    const { service } = createService((turn) => [
      turn.locale.startsWith("zh") ? "听到了。" : "I hear you.",
    ]);
    await submit(service, {
      clientEventId: "scope-event",
      clientTurnId: "scope-turn",
      locale: "en-US",
      text: "A completing 1A.1 conversation.",
    });

    // Journal, Memory, Replay, Voice and other future verticals still do not
    // exist as tables. The 1A.2 Journal/Evidence and durability foundations
    // DO exist now, but an
    // in-flight active conversation must not create any eligibility rows —
    // eligibility fires only after a deterministic Continuous Exchange End.
    const outOfScopeTables = await database.pool.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name ILIKE ANY(ARRAY[
            'entit%',
            'episode%',
            'reflection%',
            'memory%',
            'profile%',
            'open_loop%',
            'replay%',
            'voice%',
            'audio%',
            'transcript%',
            'delivery%',
            'summary%'
          ])
        ORDER BY table_name
      `,
    );
    expect(outOfScopeTables.rows).toEqual([]);

    const eligibilityFoundationTotals = await database.pool.query<{
      commands: string;
      date_outcomes: string;
      outbox: string;
      evidence_snapshots: string;
      journals: string;
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM workflow_commands) AS commands,
        (SELECT COUNT(*)::text FROM outbox_events) AS outbox,
        (SELECT COUNT(*)::text FROM daily_session_date_outcomes) AS date_outcomes,
        (SELECT COUNT(*)::text FROM evidence_source_snapshots) AS evidence_snapshots,
        (SELECT COUNT(*)::text FROM journals) AS journals
    `);
    expect(eligibilityFoundationTotals.rows[0]).toEqual({
      commands: "0",
      date_outcomes: "0",
      evidence_snapshots: "0",
      journals: "0",
      outbox: "0",
    });

    const scopedTotals = await database.pool.query<{
      assistant_events: string;
      compiled_contexts: string;
      egresses: string;
      user_events: string;
    }>(`
      SELECT
        (SELECT COUNT(*)::text FROM conversation_events WHERE actor = 'user') AS user_events,
        (SELECT COUNT(*)::text FROM conversation_events WHERE actor = 'assistant') AS assistant_events,
        (SELECT COUNT(*)::text FROM compiled_contexts) AS compiled_contexts,
        (SELECT COUNT(*)::text FROM provider_egress_dispositions) AS egresses
    `);
    expect(scopedTotals.rows[0]).toEqual({
      assistant_events: "1",
      compiled_contexts: "1",
      egresses: "1",
      user_events: "1",
    });
  });
});

function joinDeltas(events: readonly Record<string, unknown>[]): string {
  return events
    .filter((event) => event.type === "assistant_delta")
    .map((event) => String(event.delta ?? ""))
    .join("");
}

async function readNdjson(
  response: Response,
): Promise<readonly Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
