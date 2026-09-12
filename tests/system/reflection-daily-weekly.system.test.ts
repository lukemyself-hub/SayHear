import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  NARRATIVE_FINDINGS_SCHEMA_VERSION,
  NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION,
  createModelRoleCommandService,
  createModelRoleRegistry,
  runReflectionDailyBuild,
  type ModelRoleCommandService,
  type ModelRoleConfigurationSnapshot,
  type NarrativeValidationEntrypointDependencies,
  type ReflectionEntrypointDependencies,
  type ReflectionGenerationModelOutput,
} from "@sayhear/application";
import {
  asDailySessionId,
  asEvidenceItemId,
  asGenerationCommandId,
  asMemoryClaimId,
  asMemoryClaimVersionId,
  asModelRunAttemptId,
} from "@sayhear/domain";
import {
  PostgresModelRoleCommandRepository,
  PostgresNarrativeValidationRepository,
  PostgresReflectionRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const systemDescribe = testDatabaseUrl ? describe : describe.skip;

const OWNER = fixedInternalOwnerPrincipal.userId;
const SELF_ENTITY_ID = "f0000000-0000-7000-8000-000000000001";
const SELF_ENTITY_VERSION_ID = "f0000000-0000-7000-8000-000000000002";
const BASE_TIME = Date.parse("2026-09-09T08:00:00.000Z");
const INTERVAL_MS = 30 * 60 * 1000;
const READINESS_POLICY = "reflection-readiness:v1";

const dailyRoleConfiguration: ModelRoleConfigurationSnapshot = {
  role: "reflection.daily",
  configVersion: "system-reflection-daily:v1",
  provider: "system-test",
  model: "synthetic-model",
  modelSnapshot: "synthetic-model@fixture",
  promptVersion: "reflection-daily:system-test:v1",
  schemaVersion: "reflection-output-schema:v1",
  rolePolicyVersion: "1a3b-model-role-policy:v1",
  providerPolicyVersion: "system-reflection-egress:v1",
  rolloutPin: "system-reflection-daily-pin:v1",
  freshnessPolicy: "exact_head:v1",
  fallbackMode: "disabled",
  maxTechnicalRetries: 1,
  maxSemanticRepairs: 0,
  parameterSnapshot: { maxStatements: 12 },
};

const weeklyRoleConfiguration: ModelRoleConfigurationSnapshot = {
  ...dailyRoleConfiguration,
  role: "reflection.weekly",
  configVersion: "system-reflection-weekly:v1",
  promptVersion: "reflection-weekly:system-test:v1",
  providerPolicyVersion: "system-reflection-weekly-egress:v1",
  rolloutPin: "system-reflection-weekly-pin:v1",
};

const validatorRoleConfiguration: ModelRoleConfigurationSnapshot = {
  role: "narrative.validate",
  configVersion: "system-narrative-validate:v1",
  provider: "system-test",
  model: "synthetic-model",
  modelSnapshot: "synthetic-model@fixture",
  promptVersion: NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION,
  schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
  rolePolicyVersion: "1a3b-model-role-policy:v1",
  providerPolicyVersion: "system-narrative-validate-egress:v1",
  rolloutPin: "system-narrative-validate-pin:v1",
  freshnessPolicy: "exact_head:v1",
  fallbackMode: "disabled",
  maxTechnicalRetries: 1,
  maxSemanticRepairs: 0,
  parameterSnapshot: {
    budgetPolicyVersion: "system-test-budget:v1",
    providerCallBudget: 2,
  },
};

async function seedRoleConfiguration(
  pool: IsolatedPostgresSchema["pool"],
  configuration: ModelRoleConfigurationSnapshot,
): Promise<void> {
  await pool.query(
    `INSERT INTO provider_egress_policy_versions (
       policy_version, provider, role, model_config_version, status, created_at
     ) VALUES ($1, $2, $3, $4, 'active', $5)`,
    [
      configuration.providerPolicyVersion,
      configuration.provider,
      configuration.role,
      configuration.configVersion,
      new Date(BASE_TIME),
    ],
  );
  await pool.query(
    `INSERT INTO model_role_configurations (
       role, config_version, provider, model, model_snapshot, prompt_version,
       schema_version, role_policy_version, provider_policy_version,
       freshness_policy, fallback_mode, max_technical_retries,
       max_semantic_repairs, parameter_snapshot, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
    [
      configuration.role,
      configuration.configVersion,
      configuration.provider,
      configuration.model,
      configuration.modelSnapshot,
      configuration.promptVersion,
      configuration.schemaVersion,
      configuration.rolePolicyVersion,
      configuration.providerPolicyVersion,
      configuration.freshnessPolicy,
      configuration.fallbackMode,
      configuration.maxTechnicalRetries,
      configuration.maxSemanticRepairs,
      JSON.stringify(configuration.parameterSnapshot),
      new Date(BASE_TIME),
    ],
  );
  await pool.query(
    "UPDATE model_role_definitions SET enabled = TRUE WHERE role = $1",
    [configuration.role],
  );
  await pool.query(
    `INSERT INTO model_role_rollout_pins (
       role, rollout_pin, config_version, provider_policy_version,
       status, activated_at
     ) VALUES ($1, $2, $3, $4, 'active', $5)`,
    [
      configuration.role,
      configuration.rolloutPin,
      configuration.configVersion,
      configuration.providerPolicyVersion,
      new Date(BASE_TIME),
    ],
  );
}

/** Deterministic UUIDv7 generator for test rows. */
let sequence = 0;
function testUuid(now: number): string {
  sequence += 1;
  const hex = (sequence % 0x10000).toString(16).padStart(4, "0");
  const timeHex = now.toString(16).padStart(12, "0");
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${timeHex.slice(13, 15)}-a${hex.slice(1)}-000000000000`;
}

systemDescribe("Daily / Weekly Reflection — 1A.3b A3 (issue #199)", () => {
  let database: IsolatedPostgresSchema | undefined;
  let commandService: ModelRoleCommandService | undefined;
  let reflectionRepository: PostgresReflectionRepository | undefined;
  let clockNowMs = BASE_TIME;
  let narrativeScript: (() => {
    propositions: readonly unknown[];
    coverageKeys: readonly string[];
  } | null) | undefined;

  function clock(): Date {
    return new Date(clockNowMs);
  }

  function reflectionDependencies(
    generate: (
      request: Parameters<ReflectionEntrypointDependencies["reflectionProvider"]["generate"]>[0],
    ) => Promise<ReflectionGenerationModelOutput>,
  ): ReflectionEntrypointDependencies {
    return {
      clock,
      repository: reflectionRepository!,
      modelRoleCommandService: commandService!,
      reflectionProvider: {
        role: "reflection.daily",
        generate,
      },
      narrativeValidation: narrativeValidationDependencies(),
      dedupeFingerprintSecret: "system-test-dedupe-secret",
      workflowReceiptId: "wf-reflection-system-test",
    };
  }

  function narrativeValidationDependencies(): NarrativeValidationEntrypointDependencies {
    return {
      clock,
      repository: new PostgresNarrativeValidationRepository(database!.pool),
      modelRoleCommandService: commandService!,
      narrativeValidationProvider: {
        role: "narrative.validate",
        async validateNarrative(request: unknown) {
          void request;
          if (!narrativeScript) {
            const error = new Error("validator transport failure");
            (error as { category?: string }).category = "timeout";
            throw error;
          }
          return narrativeScript();
        },
      } as never,
    };
  }

  beforeAll(async () => {
    const seeded = await createIsolatedPostgresSchema(testDatabaseUrl!);
    database = seeded;
    await runMigrations(seeded.pool);
    await seeded.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [OWNER, new Date(BASE_TIME)],
    );
    await seedRoleConfiguration(seeded.pool, dailyRoleConfiguration);
    await seedRoleConfiguration(seeded.pool, weeklyRoleConfiguration);
    await seedRoleConfiguration(seeded.pool, validatorRoleConfiguration);
    commandService = createModelRoleCommandService({
      registry: createModelRoleRegistry([
        dailyRoleConfiguration,
        weeklyRoleConfiguration,
        validatorRoleConfiguration,
      ]),
      repository: new PostgresModelRoleCommandRepository(seeded.pool),
    });
    reflectionRepository = new PostgresReflectionRepository(seeded.pool, {
      entryFor: (predicateId) =>
        predicateId === "sh.memory.hobby" ? { predicateId } : null,
      registryVersion: () => 1,
    });
  }, 30_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME;
    narrativeScript = undefined;
    await database!.pool.query(`
      TRUNCATE TABLE
        proactive_followup_dispositions,
        proactive_followup_uses,
        proactive_followup_reservations,
        proactive_followup_state_versions,
        proactive_followup_states,
        reflection_runs,
        reflection_candidate_proposals,
        reflection_statement_evidence_links,
        reflection_atomic_propositions,
        reflection_statements,
        reflection_versions,
        reflections,
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
        memory_candidate_evidence_links,
        memory_candidates,
        claim_evidence_links,
        memory_claim_versions,
        memory_claims,
        user_self_entities,
        entity_versions,
        entities,
        evidence_lineage,
        evidence_model_run_attempts,
        evidence_items,
        evidence_source_snapshots,
        conversation_event_revisions,
        conversation_events,
        interaction_turns,
        daily_session_date_outcomes,
        journal_workflow_outcomes,
        daily_sessions
      CASCADE
    `);
    await database!.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
    // One Self Entity per owner so Candidate admission can bind the subject.
    await database!.pool.query(
      `INSERT INTO entities (entity_id, user_id, created_at) VALUES ($1, $2, $3)`,
      [SELF_ENTITY_ID, OWNER, new Date(BASE_TIME)],
    );
    await database!.pool.query(
      `INSERT INTO entity_versions (
         entity_version_id, entity_id, user_id, revision, entity_kind_id,
         status, created_at
       ) VALUES ($1, $2, $3, 1, 'person', 'active', $4)`,
      [SELF_ENTITY_VERSION_ID, SELF_ENTITY_ID, OWNER, new Date(BASE_TIME)],
    );
    await database!.pool.query(
      "UPDATE entities SET current_version_id = $2 WHERE entity_id = $1 AND user_id = $3",
      [SELF_ENTITY_ID, SELF_ENTITY_VERSION_ID, OWNER],
    );
    await database!.pool.query(
      "INSERT INTO user_self_entities (user_id, entity_id, created_at) VALUES ($1, $2, $3)",
      [OWNER, SELF_ENTITY_ID, new Date(BASE_TIME)],
    );
  });

  let nextId = 0;
  function seedId(): string {
    nextId += 1;
    const timeHex = BASE_TIME.toString(16).padStart(12, "0");
    const counter = nextId.toString(16).padStart(12, "0");
    return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${counter.slice(0, 3)}-a${counter.slice(3, 6)}-${counter.slice(6, 12).padStart(12, "0")}`;
  }

  /** Seeds one quiescent session with one whole-revision Evidence item. */
  async function seedSession(input: { logicalDate: string }): Promise<{
    dailySessionId: ReturnType<typeof asDailySessionId>;
    evidenceItemId: ReturnType<typeof asEvidenceItemId>;
    revisionId: string;
  }> {
    const dailySessionId = seedId();
    const interactionTurnId = seedId();
    const conversationEventId = seedId();
    const revisionId = seedId();
    const snapshotId = seedId();
    const evidenceItemId = seedId();
    const now = new Date(BASE_TIME);
    await database!.pool.query(
      `INSERT INTO daily_sessions (
         daily_session_id, user_id, logical_date, timezone_at_start, started_at,
         last_activity_at, activity_state, current_continuous_exchange_no,
         dialogue_revision, source_revision, next_turn_sequence_no,
         next_event_sequence_no, quiescent_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'UTC', $4, $4, 'quiescent', 1, 0, 1, 1, 1, $4, $4, $4)`,
      [dailySessionId, OWNER, input.logicalDate, now],
    );
    await database!.pool.query(
      `INSERT INTO interaction_turns (
         interaction_turn_id, user_id, daily_session_id, client_turn_id,
         turn_sequence_no, continuous_exchange_no, status, started_at,
         settled_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'turn:' || $5, 1, 1, 'settled', $4, $4, $4, $4)`,
      [interactionTurnId, OWNER, dailySessionId, now, interactionTurnId],
    );
    await database!.pool.query(
      `INSERT INTO conversation_events (
         conversation_event_id, user_id, daily_session_id, interaction_turn_id,
         sequence_no, client_event_id, actor, channel, event_type,
         lifecycle_status, created_at
       ) VALUES ($1, $2, $3, $4, 1, 'event:' || $5, 'user', 'text', 'message',
         'active', $6)`,
      [conversationEventId, OWNER, dailySessionId, interactionTurnId, conversationEventId, now],
    );
    await database!.pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, canonical_text, locale, transcript_status, created_by, created_at
       ) VALUES ($1, $2, $3, 1, 'I started fixing radios this week.', 'en-US',
         'final', 'client', $4)`,
      [revisionId, OWNER, conversationEventId, now],
    );
    await database!.pool.query(
      "UPDATE conversation_events SET current_revision_id = $2 WHERE conversation_event_id = $1",
      [conversationEventId, revisionId],
    );
    await database!.pool.query(
      `INSERT INTO evidence_source_snapshots (
         evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
         extraction_policy_version, command_id, attempt_id,
         champion_config_version, champion_provider, champion_model,
         champion_snapshot, champion_provider_policy_version, created_at
       ) VALUES ($1, $2, $3, 1, 'evidence-extraction:v2', 'seed', 'seed', 'test', 'openai', 'test', 'test', 'test', $4)`,
      [snapshotId, OWNER, dailySessionId, now],
    );
    await database!.pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
         source_revision_id, source_actor, source_status, locator_type,
         locator_key, extraction_policy_version, evidence_role, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'user', 'final', 'whole_revision', '1:0',
         'evidence-extraction:v2', 'factual_support', $6)`,
      [evidenceItemId, OWNER, snapshotId, conversationEventId, revisionId, now],
    );
    return {
      dailySessionId: asDailySessionId(dailySessionId),
      evidenceItemId: asEvidenceItemId(evidenceItemId),
      revisionId,
    };
  }

  async function seedDateOutcome(input: {
    dailySessionId: string;
    outcome: "no_activity" | "insufficient_expression" | "eligible_queued" | "journal_available";
  }): Promise<void> {
    await database!.pool.query(
      `INSERT INTO daily_session_date_outcomes (
         daily_session_id, user_id, logical_date, outcome,
         eligibility_policy_version, source_revision, workflow_receipt_id,
         computed_at
       ) VALUES (
         $1, $2,
         (SELECT logical_date FROM daily_sessions WHERE daily_session_id = $1),
         $3, 'journal-eligibility:v1', 1, 'seed', $4)`,
      [input.dailySessionId, OWNER, input.outcome, new Date(BASE_TIME)],
    );
  }

  let journalOutcomeTick = 0;
  async function seedJournalOutcome(input: {
    dailySessionId: string;
    outcome: "published" | "needs_review" | "retryable_failed";
  }): Promise<void> {
    journalOutcomeTick += 1;
    await database!.pool.query(
      `INSERT INTO journal_workflow_outcomes (
         workflow_command_id, user_id, daily_session_id, source_revision,
         expected_data_epoch, outcome, reason, created_at
       ) VALUES ($1, $2, $3, 1, 1, $4, NULL, $5)`,
      [
        `${input.outcome}-${seedId()}`,
        OWNER,
        input.dailySessionId,
        input.outcome,
        new Date(BASE_TIME + journalOutcomeTick),
      ],
    );
  }

  it("Q2: a journal-published day becomes due only after the Episode interval", async () => {
    const session = await seedSession({ logicalDate: "2026-09-09" });
    await seedDateOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "journal_available",
    });
    await seedJournalOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "published",
    });
    const beforeInterval = await reflectionRepository!.listDueDailySessions({
      now: new Date(BASE_TIME),
      policyVersion: READINESS_POLICY,
      limit: 10,
    });
    expect(beforeInterval).toHaveLength(0);
    const due = await reflectionRepository!.listDueDailySessions({
      now: new Date(BASE_TIME + INTERVAL_MS + 1),
      policyVersion: READINESS_POLICY,
      limit: 10,
    });
    expect(due).toHaveLength(1);
    expect(due[0]!.dailySessionId).toBe(session.dailySessionId);
    expect(due[0]!.degradedEpisodeReason).toBe("episode_build_pending");
  });

  it("Q2: a retryable Journal keeps waiting; a terminal needs_review does not", async () => {
    const session = await seedSession({ logicalDate: "2026-09-09" });
    await seedDateOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "journal_available",
    });
    await seedJournalOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "retryable_failed",
    });
    const waiting = await reflectionRepository!.listDueDailySessions({
      now: new Date(BASE_TIME + INTERVAL_MS + 1),
      policyVersion: READINESS_POLICY,
      limit: 10,
    });
    expect(waiting).toHaveLength(0);
    await seedJournalOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "needs_review",
    });
    const settled = await reflectionRepository!.listDueDailySessions({
      now: new Date(BASE_TIME + INTERVAL_MS + 1),
      policyVersion: READINESS_POLICY,
      limit: 10,
    });
    expect(settled).toHaveLength(1);
  });

  it("Q2: blank days (no_activity) never get a Reflection", async () => {
    const session = await seedSession({ logicalDate: "2026-09-09" });
    await seedDateOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "no_activity",
    });
    const due = await reflectionRepository!.listDueDailySessions({
      now: new Date(BASE_TIME + INTERVAL_MS + 1),
      policyVersion: READINESS_POLICY,
      limit: 10,
    });
    expect(due).toHaveLength(0);
  });

  it("Q3: identical snapshots dedupe; a baseline-only change queues a new command", async () => {
    const session = await seedSession({ logicalDate: "2026-09-09" });
    await seedDateOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "journal_available",
    });
    await seedJournalOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "published",
    });
    const digest = await reflectionRepository!.readDailyBaselineDigest({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });
    expect(digest).not.toBeNull();
    const queued = await reflectionRepository!.queueDailyReflection({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
      claimBaselineDigest: digest!,
      policyVersion: READINESS_POLICY,
    });
    expect(queued.outcome).toBe("queued");
    const duplicate = await reflectionRepository!.queueDailyReflection({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
      claimBaselineDigest: digest!,
      policyVersion: READINESS_POLICY,
    });
    expect(duplicate.outcome).toBe("already_queued");
    // A moved source head is a NEW snapshot: a new command identity (Q3).
    await database!.pool.query(
      "UPDATE daily_sessions SET source_revision = 2 WHERE daily_session_id = $1",
      [session.dailySessionId],
    );
    const nextHead = await reflectionRepository!.queueDailyReflection({
      dailySessionId: session.dailySessionId,
      sourceRevision: 2,
      claimBaselineDigest: digest!,
      policyVersion: READINESS_POLICY,
    });
    expect(nextHead.outcome).toBe("queued");
  });

  it("publishes a validated Reflection current and hands off a propose_new Candidate", async () => {
    const session = await seedSession({ logicalDate: "2026-09-09" });
    await seedDateOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "journal_available",
    });
    await seedJournalOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "published",
    });
    const digest = await reflectionRepository!.readDailyBaselineDigest({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });
    const queued = await reflectionRepository!.queueDailyReflection({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
      claimBaselineDigest: digest!,
      policyVersion: READINESS_POLICY,
    });
    expect(queued.outcome).toBe("queued");
    if (queued.outcome !== "queued") {
      throw new Error("unreachable");
    }
    const queuedCommand = queued;
    narrativeScript = () => ({
      propositions: [
        {
          propositionKey: "independent:1",
          text: "You have been fixing radios this week.",
          propositionKind: "fact",
          epistemicRendering: "confirmed",
          supportKeys: [],
          unsupported: false,
          contradicted: false,
          ambiguous: false,
        },
      ],
      coverageKeys: [],
    });
    const result = await runReflectionDailyBuild({
      dependencies: reflectionDependencies(async () => ({
        statements: [
          {
            statementKey: "statement:1",
            text: "You have been fixing radios this week.",
            statementKind: "day_observation",
            propositions: [
              {
                propositionKey: "proposition:1",
                normalizedProposition: "user fixes radios",
                propositionKind: "fact",
                epistemicRendering: "confirmed",
                supportEvidenceItemIds: [session.evidenceItemId],
                baselineClaimIds: [],
              },
            ],
          },
        ],
        candidateProposals: [
          {
            candidateKind: "objective",
            basis: "directly_stated",
            predicateId: "sh.memory.hobby",
            proposedConcept: null,
            typedValue: "radio repair",
            scopeKey: "",
            temporal: {
              temporalStatus: "current",
              validFrom: null,
              validFromPrecision: "unknown",
              validTo: null,
              validToPrecision: "unknown",
            },
            evidenceItemIds: [session.evidenceItemId],
          },
        ],
      })),
      command: {
        workflowCommandId: queuedCommand.workflowCommandId,
        subjectId: session.dailySessionId,
        sourceRevision: 1,
        claimBaselineDigest: digest!,
        policyVersion: READINESS_POLICY,
        expectedDataEpoch: queuedCommand.expectedDataEpoch,
        scope: "daily",
        weekIdentifier: null,
        windowStartDate: null,
        windowEndDate: null,
        sourceDigest: null,
      },
    });
    expect(result.outcome).toBe("built");
    expect(result.statementCount).toBe(1);
    expect(result.candidateCount).toBe(1);

    const candidate = await database!.pool.query<{
      memory_candidate_id: string;
      source_reflection_version_id: string | null;
      predicate_id: string | null;
    }>(
      "SELECT memory_candidate_id, source_reflection_version_id, predicate_id FROM memory_candidates WHERE user_id = $1",
      [OWNER],
    );
    expect(candidate.rows).toHaveLength(1);
    expect(candidate.rows[0]!.predicate_id).toBe("sh.memory.hobby");
    const current = await database!.pool.query<{ reflection_version_id: string }>(
      `SELECT v.reflection_version_id FROM reflections r
       INNER JOIN reflection_versions v
         ON v.reflection_version_id = r.current_version_id
       WHERE r.user_id = $1 AND r.daily_session_id = $2`,
      [OWNER, session.dailySessionId],
    );
    expect(current.rows).toHaveLength(1);
    expect(candidate.rows[0]!.source_reflection_version_id).toBe(
      current.rows[0]!.reflection_version_id,
    );
    const lineage = await database!.pool.query<{ outcome: string }>(
      "SELECT outcome FROM reflection_candidate_proposals WHERE user_id = $1",
      [OWNER],
    );
    expect(lineage.rows[0]!.outcome).toBe("created");
  });

  it("fails closed when the owner epoch advanced before the commit", async () => {
    const session = await seedSession({ logicalDate: "2026-09-09" });
    await seedDateOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "journal_available",
    });
    await seedJournalOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "published",
    });
    const digest = await reflectionRepository!.readDailyBaselineDigest({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });
    const queued = await reflectionRepository!.queueDailyReflection({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
      claimBaselineDigest: digest!,
      policyVersion: READINESS_POLICY,
    });
    if (queued.outcome !== "queued") {
      throw new Error("unreachable");
    }
    const queuedCommand = queued;
    await database!.pool.query(
      "UPDATE app_users SET data_epoch = data_epoch + 1 WHERE user_id = $1",
      [OWNER],
    );
    narrativeScript = () => ({
      propositions: [],
      coverageKeys: [],
    });
    const result = await runReflectionDailyBuild({
      dependencies: reflectionDependencies(async () => ({
        statements: [],
        candidateProposals: [],
      })),
      command: {
        workflowCommandId: queuedCommand.workflowCommandId,
        subjectId: session.dailySessionId,
        sourceRevision: 1,
        claimBaselineDigest: digest!,
        policyVersion: READINESS_POLICY,
        expectedDataEpoch: queuedCommand.expectedDataEpoch,
        scope: "daily",
        weekIdentifier: null,
        windowStartDate: null,
        windowEndDate: null,
        sourceDigest: null,
      },
    });
    expect(result.outcome).toBe("fenced");
    expect(result.errorCode).toBe("data_epoch");
  });

  it("leaves no current and no Candidate when the validator never completes", async () => {
    const session = await seedSession({ logicalDate: "2026-09-09" });
    await seedDateOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "journal_available",
    });
    await seedJournalOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "published",
    });
    const digest = await reflectionRepository!.readDailyBaselineDigest({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });
    const queued = await reflectionRepository!.queueDailyReflection({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
      claimBaselineDigest: digest!,
      policyVersion: READINESS_POLICY,
    });
    if (queued.outcome !== "queued") {
      throw new Error("expected queued");
    }
    // The validator command cannot complete (transport failure after its own
    // retry budget): no current pointer, no Candidate (ADR-0132).
    narrativeScript = undefined;
    const result = await runReflectionDailyBuild({
      dependencies: reflectionDependencies(async () => ({
        statements: [
          {
            statementKey: "statement:1",
            text: "You have been fixing radios this week.",
            statementKind: "day_observation",
            propositions: [
              {
                propositionKey: "proposition:1",
                normalizedProposition: "user fixes radios",
                propositionKind: "fact",
                epistemicRendering: "confirmed",
                supportEvidenceItemIds: [session.evidenceItemId],
                baselineClaimIds: [],
              },
            ],
          },
        ],
        candidateProposals: [],
      })),
      command: {
        workflowCommandId: queued.workflowCommandId,
        subjectId: session.dailySessionId,
        sourceRevision: 1,
        claimBaselineDigest: digest!,
        policyVersion: READINESS_POLICY,
        expectedDataEpoch: queued.expectedDataEpoch,
        scope: "daily",
        weekIdentifier: null,
        windowStartDate: null,
        windowEndDate: null,
        sourceDigest: null,
      },
    });
    // The validator transport failure rides the shared validator command's
    // own one-retry budget (ADR-0132) before the typed final failure.
    expect(result.outcome).toBe("retryable_failed");
    const current = await database!.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reflections r
       INNER JOIN reflection_versions v
         ON v.reflection_version_id = r.current_version_id
       WHERE r.user_id = $1 AND r.daily_session_id = $2`,
      [OWNER, session.dailySessionId],
    );
    expect(Number(current.rows[0]!.count)).toBe(0);
    const candidates = await database!.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM memory_candidates WHERE user_id = $1",
      [OWNER],
    );
    expect(Number(candidates.rows[0]!.count)).toBe(0);
  });

  it("marks committed versions stale by reverse Evidence lineage and stops the current read", async () => {
    const session = await seedSession({ logicalDate: "2026-09-09" });
    await seedDateOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "journal_available",
    });
    await seedJournalOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "published",
    });
    const digest = await reflectionRepository!.readDailyBaselineDigest({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });
    const queued = await reflectionRepository!.queueDailyReflection({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
      claimBaselineDigest: digest!,
      policyVersion: READINESS_POLICY,
    });
    if (queued.outcome !== "queued") {
      throw new Error("expected queued");
    }
    narrativeScript = () => ({ propositions: [], coverageKeys: [] });
    const published = await runReflectionDailyBuild({
      dependencies: reflectionDependencies(async () => ({
        statements: [
          {
            statementKey: "statement:1",
            text: "You have been fixing radios this week.",
            statementKind: "day_observation",
            propositions: [
              {
                propositionKey: "proposition:1",
                normalizedProposition: "user fixes radios",
                propositionKind: "fact",
                epistemicRendering: "confirmed",
                supportEvidenceItemIds: [session.evidenceItemId],
                baselineClaimIds: [],
              },
            ],
          },
        ],
        candidateProposals: [],
      })),
      command: {
        workflowCommandId: queued.workflowCommandId,
        subjectId: session.dailySessionId,
        sourceRevision: 1,
        claimBaselineDigest: digest!,
        policyVersion: READINESS_POLICY,
        expectedDataEpoch: queued.expectedDataEpoch,
        scope: "daily",
        weekIdentifier: null,
        windowStartDate: null,
        windowEndDate: null,
        sourceDigest: null,
      },
    });
    expect(published.outcome).toBe("built");
    // Evidence invalidation: the reverse-lineage pass stales the version and
    // the read path stops treating it as current (SPEC 5.3).
    await database!.pool.query(
      "UPDATE conversation_events SET lifecycle_status = 'deleted' WHERE conversation_event_id = (SELECT source_event_id FROM evidence_items WHERE evidence_item_id = $1)",
      [session.evidenceItemId],
    );
    const staled = await reflectionRepository!.markStaleByInvalidatedEvidence({
      userId: OWNER as never,
      policyVersion: READINESS_POLICY,
      limit: 100,
    });
    expect(staled).toBe(1);
    const read = await reflectionRepository!.readCurrentVersion({
      userId: OWNER as never,
      dailySessionId: session.dailySessionId,
      weekIdentifier: null,
      now: new Date(BASE_TIME + 1000),
    });
    expect(read.outcome).toBe("stale");
  });

  it("expires uncommitted content at the 7-day read-time deadline (ADR-0130)", async () => {
    const session = await seedSession({ logicalDate: "2026-09-09" });
    await seedDateOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "journal_available",
    });
    await seedJournalOutcome({
      dailySessionId: session.dailySessionId,
      outcome: "published",
    });
    const digest = await reflectionRepository!.readDailyBaselineDigest({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });
    const queued = await reflectionRepository!.queueDailyReflection({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
      claimBaselineDigest: digest!,
      policyVersion: READINESS_POLICY,
    });
    if (queued.outcome !== "queued") {
      throw new Error("expected queued");
    }
    const queuedCommand = queued;
    narrativeScript = () => ({ propositions: [], coverageKeys: [] });
    const published = await runReflectionDailyBuild({
      dependencies: reflectionDependencies(async () => ({
        statements: [
          {
            statementKey: "statement:1",
            text: "You have been fixing radios this week.",
            statementKind: "day_observation",
            propositions: [
              {
                propositionKey: "proposition:1",
                normalizedProposition: "user fixes radios",
                propositionKind: "fact",
                epistemicRendering: "confirmed",
                supportEvidenceItemIds: [session.evidenceItemId],
                baselineClaimIds: [],
              },
            ],
          },
        ],
        candidateProposals: [],
      })),
      command: {
        workflowCommandId: queuedCommand.workflowCommandId,
        subjectId: session.dailySessionId,
        sourceRevision: 1,
        claimBaselineDigest: digest!,
        policyVersion: READINESS_POLICY,
        expectedDataEpoch: queuedCommand.expectedDataEpoch,
        scope: "daily",
        weekIdentifier: null,
        windowStartDate: null,
        windowEndDate: null,
        sourceDigest: null,
      },
    });
    expect(published.outcome).toBe("built");
    // A real baseline change (a new admitted Claim rotates the comparison
    // baseline) freezes a second DRAFT at the same head; its content expires
    // at the 7-day read-time deadline while the current committed version
    // keeps its typed content (ADR-0130, Q3).
    const claimId = asMemoryClaimId(seedId());
    const claimVersionId = asMemoryClaimVersionId(seedId());
    await database!.pool.query(
      `INSERT INTO memory_claims (
         memory_claim_id, user_id, canonical_key, subject_entity_id,
         predicate_id, scope_key, created_at
       ) VALUES ($1, $2, 'v1|sh.memory.hobby|self||radio', $3,
         'sh.memory.hobby', '', $4)`,
      [claimId, OWNER, SELF_ENTITY_ID, new Date(BASE_TIME)],
    );
    await database!.pool.query(
      `INSERT INTO memory_claim_versions (
         memory_claim_version_id, memory_claim_id, user_id, revision, kind,
         epistemic_status, status, subject_entity_version_id, typed_value,
         temporal_status, valid_from_precision, valid_to_precision,
         last_observed_at, created_by, predicate_registry_version, created_at
       ) VALUES ($1, $2, $3, 1, 'objective', 'confirmed', 'active',
         $4, '"radio repair"', 'current', 'unknown', 'unknown', $5,
         'admission', 1, $6)`,
      [claimVersionId, claimId, OWNER, SELF_ENTITY_VERSION_ID, new Date(BASE_TIME), new Date(BASE_TIME)],
    );
    await database!.pool.query(
      "UPDATE memory_claims SET current_version_id = $2 WHERE memory_claim_id = $1",
      [claimId, claimVersionId],
    );
    const rotatedDigest = await reflectionRepository!.readDailyBaselineDigest({
      dailySessionId: session.dailySessionId,
      sourceRevision: 1,
    });
    expect(rotatedDigest).not.toBe(digest);
    const rotatedCommandId = asGenerationCommandId(seedId());
    const rotatedAttemptId = asModelRunAttemptId(seedId());
    await database!.pool.query(
      `INSERT INTO generation_commands (
         generation_command_id, user_id, operation_type, intent_key,
         subject_type, subject_id, model_role, schema_version, prompt_version,
         product_policy_version, safety_policy_version,
         relationship_policy_version, locale_policy_version, locale, provider,
         model, model_snapshot, model_config_version, freshness_policy,
         output_format_version, harness_policy_version,
         conversation_action_catalog_version, role_policy_version, rollout_pin,
         provider_policy_version, source_revision, parameter_snapshot,
         fallback_mode, expected_data_epoch, status, created_at
       ) VALUES ($1, $2, 'reflection.daily', 'rotated-draft', 'daily_session',
         $3, 'reflection.daily', 'reflection-output-schema:v1',
         'reflection-daily:system-test:v1', 'product-policy:v1',
         'minimum-high-risk-response:v1', 'relationship-boundary:v1',
         'locale-policy:v1', 'en', 'system-test', 'synthetic-model',
         'synthetic-model@fixture', 'system-reflection-daily:v1',
         'exact_head:v1', 'reflection-output:v1',
         'conversation-harness:v1', 'memory-trust-actions-catalog:v1',
         '1a3b-model-role-policy:v1', 'system-reflection-daily-pin:v1',
         'system-reflection-egress:v1', 1, '{}'::jsonb, 'disabled', 1,
         'succeeded', $4)`,
      [rotatedCommandId, OWNER, session.dailySessionId, new Date(BASE_TIME)],
    );
    await database!.pool.query(
      `INSERT INTO model_run_attempts (
         model_run_attempt_id, user_id, generation_command_id, attempt_no,
         operation_type, provider, model, model_snapshot, prompt_version,
         attempt_kind, status, created_at
       ) VALUES ($1, $2, $3, 1, 'reflection.daily', 'system-test',
         'synthetic-model', 'synthetic-model@fixture',
         'reflection-daily:system-test:v1', 'initial', 'succeeded', $4)`,
      [rotatedAttemptId, OWNER, rotatedCommandId, new Date(BASE_TIME)],
    );
    const rotated = await reflectionRepository!.persistDraftVersion({
      userId: OWNER as never,
      scopeType: "daily_session",
      dailySessionId: session.dailySessionId,
      weekIdentifier: null,
      windowStartDate: null,
      windowEndDate: null,
      sourceRevision: 1,
      sourceDigest: null,
      claimBaselineDigest: rotatedDigest!,
      policyVersion: "reflection-admission:v1",
      schedulePolicyVersion: READINESS_POLICY,
      promptVersion: "reflection-daily:system-test:v1",
      schemaVersion: "reflection-output-schema:v1",
      locale: "en",
      expectedDataEpoch: 1,
      generationCommandId: rotatedCommandId,
      modelRunAttemptId: rotatedAttemptId,
      now: new Date(BASE_TIME),
      degradedEpisodeReason: null,
      statements: [
        {
          statementKey: "statement:1",
          text: "You have been fixing radios this week.",
          statementKind: "day_observation",
          propositions: [
            {
              propositionKey: "proposition:1",
              normalizedProposition: "user fixes radios",
              propositionKind: "fact",
              epistemicRendering: "confirmed",
              supportEvidenceItemIds: [session.evidenceItemId],
              baselineClaimIds: [],
            },
          ],
        },
      ],
    });
    expect(rotated.outcome).toBe("persisted");
    const beforeDeadline = await reflectionRepository!.purgeExpiredContent({
      now: new Date(BASE_TIME + 6 * 24 * 60 * 60 * 1000),
      limit: 100,
    });
    expect(beforeDeadline).toBe(0);
    const afterDeadline = await reflectionRepository!.purgeExpiredContent({
      now: new Date(BASE_TIME + 8 * 24 * 60 * 60 * 1000),
      limit: 100,
    });
    expect(afterDeadline).toBe(1);
    // The expired draft's typed content is gone; the committed version keeps
    // its typed content (ADR-0130).
    const draftStatements = await database!.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reflection_statements
       WHERE reflection_version_id = (SELECT reflection_version_id
         FROM reflection_versions
         WHERE user_id = $1 AND status = 'draft')`,
      [OWNER],
    );
    expect(Number(draftStatements.rows[0]!.count)).toBe(0);
    const committedStatements = await database!.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM reflection_statements",
    );
    expect(Number(committedStatements.rows[0]!.count)).toBe(1);
    const committedEnvelope = await database!.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reflection_versions
       WHERE user_id = $1 AND status = 'committed' AND content_purged_at IS NULL`,
      [OWNER],
    );
    expect(Number(committedEnvelope.rows[0]!.count)).toBe(1);
  });

  it("weekly scope queues and builds on the composite source identity", async () => {
    // Two activity days in one ISO week; the earliest run time is the local
    // Monday 00:00 after the window (SPEC 5.1).
    const monday = await seedSession({ logicalDate: "2026-09-07" });
    const tuesday = await seedSession({ logicalDate: "2026-09-08" });
    for (const session of [monday, tuesday]) {
      await seedDateOutcome({
        dailySessionId: session.dailySessionId,
        outcome: "journal_available",
      });
      await seedJournalOutcome({
        dailySessionId: session.dailySessionId,
        outcome: "published",
      });
    }
    // The weekly scheduler picks the week up only after the window closes.
    const beforeWindow = await reflectionRepository!.listDueWeekWindows({
      now: new Date(BASE_TIME),
      policyVersion: READINESS_POLICY,
      limit: 10,
    });
    expect(beforeWindow).toHaveLength(0);
    const afterWindow = await reflectionRepository!.listDueWeekWindows({
      now: new Date(Date.parse("2026-09-14T06:00:00.000Z")),
      policyVersion: READINESS_POLICY,
      limit: 10,
    });
    expect(afterWindow).toHaveLength(1);
    const week = afterWindow[0]!;
    expect(week.weekIdentifier).toBe("2026-W37");
    const queued = await reflectionRepository!.queueWeeklyReflection({
      userId: OWNER as never,
      weekIdentifier: week.weekIdentifier,
      windowStartDate: week.windowStartDate,
      windowEndDate: week.windowEndDate,
      sourceDigest: week.sourceDigest,
      policyVersion: READINESS_POLICY,
    });
    expect(queued.outcome).toBe("queued");
    const duplicate = await reflectionRepository!.queueWeeklyReflection({
      userId: OWNER as never,
      weekIdentifier: week.weekIdentifier,
      windowStartDate: week.windowStartDate,
      windowEndDate: week.windowEndDate,
      sourceDigest: week.sourceDigest,
      policyVersion: READINESS_POLICY,
    });
    expect(duplicate.outcome).toBe("already_queued");
  });
});
