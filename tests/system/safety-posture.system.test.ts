import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  asGenerationCommandId,
  createContextCompiler,
  createConversationAgentHarness,
  createConversationResponseService,
  createUserTextConversationService,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  renderMinimumHighRiskResponse,
  SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE,
  SAFETY_POSTURE_POLICY_VERSION,
  type ConversationTextChampion,
  type ConversationTurnSignal,
  type SafetyPostureDetector,
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

describe("Authenticated Internal Text Conversation System Seam — Safety Posture lifecycle", () => {
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
        safety_posture_alerts,
        current_safety_postures,
        safety_postures,
        conversation_action_payloads,
        conversation_action_receipts,
        conversation_action_executions,
        conversation_action_handles,
        current_curiosity_stop_signals,
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
    /** Scriptable detector seam for detector-failure scenarios. */
    safetyPostureDetector?: SafetyPostureDetector;
  }) {
    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
      input.safetyPostureDetector
        ? { safetyPostureDetector: input.safetyPostureDetector }
        : {},
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
    input: { text: string; turnId: string; locale?: string },
  ) {
    const response = await createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    })(
      new Request("http://localhost/api/internal/conversation/responses", {
        body: JSON.stringify({
          clientEventId: `${input.turnId}-event`,
          clientTurnId: input.turnId,
          locale: input.locale ?? "en-US",
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

  async function currentPosture() {
    const result = await database.pool.query<{
      content: Record<string, unknown>;
      version_no: string;
      committed_generation_command_id: string;
      source_revision: string;
      policy_version: string;
    }>(`
      SELECT version.content, version.version_no,
        version.committed_generation_command_id, version.source_revision,
        version.policy_version
      FROM current_safety_postures current
      INNER JOIN safety_postures version
        ON version.safety_posture_id = current.safety_posture_id
    `);
    return result.rows[0] ?? null;
  }

  async function postureVersionCount() {
    const result = await database.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM safety_postures`,
    );
    return Number(result.rows[0]!.count);
  }

  async function safetyPostureAlerts() {
    const result = await database.pool.query<{
      reason: string;
      generation_command_id: string;
    }>(
      `SELECT reason, generation_command_id::text FROM safety_posture_alerts ORDER BY occurred_at`,
    );
    return result.rows;
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

  it("activates the posture deterministically on an explicit high-risk disclosure and anchors the response", async () => {
    const { service } = createService({
      responder: () => ["must not produce ordinary listening under high risk"],
    });

    const turn = await submit(service, {
      text: "I want to kill myself tonight.",
      turnId: "activate-turn-1",
    });
    expect(turn.deltas).toBe(
      renderMinimumHighRiskResponse({ kind: "self_harm", locale: "en-US" }),
    );
    expect(turn.deltas).toContain("988");

    const posture = await currentPosture();
    expect(posture).not.toBeNull();
    expect(Number(posture!.version_no)).toBe(1);
    expect(posture!.policy_version).toBe("safety-posture:v2");
    expect(posture!.content).toMatchObject({
      cleanTurnCount: 0,
      kind: "self_harm",
      releasedBy: null,
      state: "active",
    });
    expect(
      asGenerationCommandId(posture!.committed_generation_command_id),
    ).toBeTruthy();
    // Minimal envelope (ADR-0101): revision references and enums only.
    const envelope = JSON.stringify(posture!.content);
    expect(envelope).not.toContain("kill myself");
    expect(envelope).not.toContain("tonight");

    // The immutable policy row records the same K the runtime consumes; the
    // two are pinned equal so they can never drift apart silently.
    const policy = await database.pool.query<{
      policy_version: string;
      clean_turns_to_release: number;
    }>(
      `SELECT policy_version, clean_turns_to_release FROM safety_posture_policies WHERE policy_version = $1`,
      [SAFETY_POSTURE_POLICY_VERSION],
    );
    expect(policy.rows[0]).toEqual({
      clean_turns_to_release: SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE,
      policy_version: SAFETY_POSTURE_POLICY_VERSION,
    });
  });

  it("keeps the anchor and reduced persona on every posture-active turn, across a topic change and a Continuous Exchange boundary", async () => {
    const { conversationService, service } = createService({
      responder: () => ["I am staying with you."],
    });

    await submit(service, {
      text: "我不想活了，真的很累。",
      turnId: "zh-activate-turn-1",
      locale: "zh-Hans-CN",
    });
    expect(await currentPosture()).not.toBeNull();

    // A clean turn that changes the topic still compiles the reduced variant
    // and the anchor section, and the response keeps a whitelisted number.
    const afterTopicChange = await submit(service, {
      text: "对了，我昨晚看了一部电影。",
      turnId: "zh-clean-turn-2",
      locale: "zh-Hans-CN",
    });
    expect(afterTopicChange.deltas).toContain("I am staying with you.");
    expect(afterTopicChange.deltas).toContain("12356");
    let sections = await compiledSections(afterTopicChange.generationCommandId);
    expect(
      sections.find((section) => section.key === "safety_posture")
        ?.content_reference,
    ).toContain("safety-posture:active");
    expect(
      sections.find((section) => section.key === "persona_behavior_anchors")
        ?.content_reference,
    ).toBe("safety-posture-reduced-persona:v1");
    const activeMetadata = await new PostgresInternalInspectionRepository(
      database.pool,
    ).findGenerationMetadata({
      generationCommandId: asGenerationCommandId(
        afterTopicChange.generationCommandId,
      ),
      userId: fixedInternalOwnerPrincipal.userId,
    });
    expect(activeMetadata?.compiledContext.safetyPosture).toMatchObject({
      posture: {
        content: {
          cleanTurnCount: 0,
          state: "active",
        },
        policyVersion: SAFETY_POSTURE_POLICY_VERSION,
      },
      state: "active",
    });

    // The posture survives the Continuous Exchange boundary within the day.
    await endCurrentExchange(conversationService);
    const nextExchange = await submit(service, {
      text: "新的一天开始了，我想说说话。",
      turnId: "zh-exchange-2-turn-1",
      locale: "zh-Hans-CN",
    });
    expect(nextExchange.deltas).toContain("12356");
    sections = await compiledSections(nextExchange.generationCommandId);
    expect(
      sections.find((section) => section.key === "safety_posture"),
    ).toBeTruthy();
  });

  it("releases after exactly two consecutive clean turns and restores the ordinary persona", async () => {
    const { service } = createService({
      responder: () => ["I hear you."],
    });

    await submit(service, {
      text: "I want to kill myself tonight.",
      turnId: "release-turn-1",
    });
    const firstClean = await submit(service, {
      text: "I slept a little better today.",
      turnId: "release-turn-2",
    });
    // Clean turn one: still active, anchor present, count at one.
    expect(firstClean.deltas).toContain("988");
    expect((await currentPosture())!.content).toMatchObject({
      cleanTurnCount: 1,
      state: "active",
    });

    const secondClean = await submit(service, {
      text: "I went for a walk this afternoon.",
      turnId: "release-turn-3",
    });
    // Clean turn two is itself posture-active at compile time, then releases.
    expect(secondClean.deltas).toContain("988");
    expect((await currentPosture())!.content).toMatchObject({
      cleanTurnCount: 2,
      state: "released",
    });

    // The next response: no anchor, ordinary persona restored.
    const afterRelease = await submit(service, {
      text: "The walk helped more than I expected.",
      turnId: "release-turn-4",
    });
    expect(afterRelease.deltas).toBe("I hear you.");
    const sections = await compiledSections(afterRelease.generationCommandId);
    expect(
      sections.find((section) => section.key === "safety_posture"),
    ).toBeUndefined();
    expect(
      sections.find((section) => section.key === "persona_behavior_anchors")
        ?.content_reference,
    ).toBe("persona-behavior-anchors:v1");

    const metadata = await new PostgresInternalInspectionRepository(
      database.pool,
    ).findGenerationMetadata({
      generationCommandId: asGenerationCommandId(
        afterRelease.generationCommandId,
      ),
      userId: fixedInternalOwnerPrincipal.userId,
    });
    expect(metadata?.compiledContext.safetyPosture).toMatchObject({
      posture: {
        content: {
          cleanTurnCount: 2,
          releasedBy: {
            userEventRevisionId: expect.any(String),
          },
          state: "released",
        },
        policyVersion: SAFETY_POSTURE_POLICY_VERSION,
        versionNo: 3,
      },
      state: "released",
    });
  });

  it("counts an explicit statement of safety as exactly one clean turn without short-circuiting", async () => {
    const { service } = createService({
      responder: () => ["I hear you."],
    });

    await submit(service, {
      text: "I want to kill myself tonight.",
      turnId: "statement-turn-1",
    });
    const statement = await submit(service, {
      text: "I am safe now, I really am.",
      turnId: "statement-turn-2",
    });
    expect(statement.deltas).toContain("988");
    expect((await currentPosture())!.content).toMatchObject({
      cleanTurnCount: 1,
      state: "active",
    });

    await submit(service, {
      text: "Thanks for staying with me today.",
      turnId: "statement-turn-3",
    });
    expect((await currentPosture())!.content).toMatchObject({
      cleanTurnCount: 2,
      state: "released",
    });
  });

  it("resets the count and re-activates when a renewed signal arrives mid-posture", async () => {
    const { service } = createService({
      responder: () => ["I hear you."],
    });

    await submit(service, {
      text: "I want to kill myself tonight.",
      turnId: "renewal-turn-1",
    });
    await submit(service, {
      text: "I slept a little better today.",
      turnId: "renewal-turn-2",
    });
    expect((await currentPosture())!.content).toMatchObject({
      cleanTurnCount: 1,
      state: "active",
    });

    const renewed = await submit(service, {
      text: "I still want to die sometimes.",
      turnId: "renewal-turn-3",
    });
    expect(renewed.deltas).toBe(
      renderMinimumHighRiskResponse({ kind: "self_harm", locale: "en-US" }),
    );
    expect((await currentPosture())!.content).toMatchObject({
      cleanTurnCount: 0,
      kind: "self_harm",
      state: "active",
    });
    expect(await postureVersionCount()).toBe(3);

    // Two clean turns release the renewed posture.
    await submit(service, {
      text: "My partner stayed home with me.",
      turnId: "renewal-turn-4",
    });
    await submit(service, {
      text: "We cooked dinner together.",
      turnId: "renewal-turn-5",
    });
    expect((await currentPosture())!.content).toMatchObject({
      state: "released",
    });
  });

  it("does not carry the posture into the next day's session", async () => {
    const { conversationService, service } = createService({
      responder: () => ["I hear you."],
    });

    await submit(service, {
      text: "I want to kill myself tonight.",
      turnId: "day-1-turn-1",
    });
    expect(await currentPosture()).not.toBeNull();
    await endCurrentExchange(conversationService);

    // A Daily Session does not split at midnight (ADR-0012): the day ends via
    // the deterministic Continuous Exchange end, and the next day's exchange
    // starts a fresh session with no posture carried over.
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
      sections.find((section) => section.key === "safety_posture"),
    ).toBeUndefined();
    expect(nextDay.deltas).toBe("I hear you.");
  });

  it("holds everything when the detector fails: no activation, active postures held, alert raised, fallback intact", async () => {
    let detectorFails = false;
    const scriptedDetector: SafetyPostureDetector = (input) => {
      if (detectorFails) {
        throw new Error("scripted detector outage");
      }
      return input.text.includes("kill myself") ? "self_harm" : null;
    };

    // With the detector down, an explicit disclosure still gets the
    // prompt-layer Minimum High-Risk Response, but no posture activates.
    const failing = createService({
      responder: () => ["must not be used"],
      safetyPostureDetector: scriptedDetector,
    });
    detectorFails = true;
    const failedActivation = await submit(failing.service, {
      text: "I want to kill myself tonight.",
      turnId: "failure-turn-1",
    });
    expect(failedActivation.deltas).toBe(
      renderMinimumHighRiskResponse({ kind: "self_harm", locale: "en-US" }),
    );
    expect(await currentPosture()).toBeNull();
    expect(await safetyPostureAlerts()).toEqual([
      expect.objectContaining({ reason: "detector_failure" }),
    ]);

    // With the detector restored, the posture activates; a later outage on a
    // would-be clean turn holds the active posture untouched (count stays 0)
    // and raises another alert, while the compile still enforces the anchor.
    const working = createService({
      responder: () => ["I am staying with you."],
      safetyPostureDetector: scriptedDetector,
    });
    detectorFails = false;
    await submit(working.service, {
      text: "I want to kill myself tonight.",
      turnId: "failure-turn-2",
    });
    expect((await currentPosture())!.content).toMatchObject({
      cleanTurnCount: 0,
      state: "active",
    });

    detectorFails = true;
    const heldTurn = await submit(working.service, {
      text: "I slept a little better today.",
      turnId: "failure-turn-3",
    });
    expect(heldTurn.deltas).toContain("988");
    expect((await currentPosture())!.content).toMatchObject({
      cleanTurnCount: 0,
      state: "active",
    });
    const alerts = await safetyPostureAlerts();
    expect(alerts).toHaveLength(2);
    expect(alerts.every((alert) => alert.reason === "detector_failure")).toBe(
      true,
    );
    // The alert rows keep a minimal envelope — no user content.
    const alertEnvelope = JSON.stringify(alerts);
    expect(alertEnvelope).not.toContain("kill myself");
    expect(alertEnvelope).not.toContain("slept a little");
  });
});
