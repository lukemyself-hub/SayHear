import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  runMemoryCorrectionFollowupWorkflow,
  CompiledContextIntegrityError,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  createConversationActionGateway,
  createContinuousExchangeService,
  createConversationAgentHarness,
  createConversationResponseService,
  createContextCompiler,
  createExplainMemorySourceActionHandler,
  createMemoryClaimService,
  createMemoryCorrectionActionHandler,
  createMemoryRetrievalService,
  createUserTextConversationService,
  loadPredicateRegistrySnapshot,
  MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
  normalizeRetrievalTerm,
  planTrustActionTargetResolution,
  relationshipHintInputsFor,
  retrievalProjectionInputsFor,
  RETRIEVAL_BROAD_TERM_STOP_LIST,
  createMemoryForgetRequestActionHandler,
  createMemoryForgetReversalActionHandler,
  trustActionUnverifiablePhrasing,
  RECENT_CONTEXT_COMPILER_VERSION,
  RECENT_CONTEXT_DEFAULT_POLICY,
  RECENT_CONTEXT_SELECTION_POLICY_VERSION,
  RECENT_CONTEXT_SECTION_KEY,
  RecentContextGovernanceConflictError,
  asGenerationCommandId,
  decodeRecentContextReference,
  resolveRecentContextWindow,
  selectRecentContext,
  type ConversationResponseStreamEvent,
  type MemoryClaimService,
  type RecentContextSelectionPolicy,
  type RecentContextSourceRequest,
  type TrustActionResolutionCandidate,
} from "@sayhear/application";
import {
  loadActionFinalizationReceiptSnapshot,
  PostgresContinuousExchangeRepository,
  PostgresMemoryCorrectionFollowupRepository,
  PostgresConversationResponseRepository,
  PostgresEntityRepository,
  PostgresInternalInspectionRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresJournalRegenerationActionRepository,
  PostgresMemoryClaimRepository,
  PostgresMemoryRetrievalRepository,
  PostgresMemoryTrustActionCommitPort,
  PostgresMemoryTrustActionTargetSource,
  PostgresRecentContextPolicyRepository,
  PostgresRecentContextSource,
  PostgresUserTextConversationRepository,
  RECENT_CONTEXT_CANDIDATE_SQL,
  runMigrations,
} from "@sayhear/data";
import {
  asCompiledContextId,
  asConversationEventRevisionId,
  asDailySessionId,
} from "@sayhear/domain";
import { createProviderEgressPort } from "@sayhear/ai/testing";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";
import type { ConversationTextModel } from "@sayhear/application";

/**
 * SPEC #107 "Trust actions" (ticket #119, ADR-0118 / ADR-0099): the first
 * two Trust-Control Actions end-to-end through the real request path —
 * admission-time deterministic owner-scoped target resolution (unique hit
 * admits, count-only multi-hit clarification, honest zero-hit), synchronous
 * in-transaction correction commits before the reply round's retrieval with
 * fail-closed memory on material ambiguity, impression deactivation with the
 * user veto, transport-retry-safe execution idempotency, and evidence-backed
 * source explanations with the fixed ADR-0008 unverifiable phrasing.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const BASE_TIME = new Date("2026-08-27T08:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1_000;
const INACTIVITY_ADVANCE_MS = 2 * 60 * 60 * 1_000;

let clockNowMs = BASE_TIME;
const clock = () => new Date(clockNowMs);
const advanceMs = (ms: number) => {
  clockNowMs += ms;
};

const registrySnapshot = loadPredicateRegistrySnapshot(1);

const registryLookup = {
  entryFor(predicateId: string) {
    return (
      registrySnapshot.entries.find(
        (entry) => entry.predicateId === predicateId,
      ) ?? null
    );
  },
  registryVersion: () => registrySnapshot.registryVersion,
  relationshipProjectionsFor(predicateId: string) {
    return registrySnapshot.relationshipProjections.filter(
      (projection) => projection.predicateId === predicateId,
    );
  },
  predicateLocalizationsFor(predicateId: string) {
    return registrySnapshot.localizations.filter(
      (localization) => localization.predicateId === predicateId,
    );
  },
};

const generationPolicy = Object.freeze({
  consentPolicyVersion: null,
  freshnessPolicy: "source_valid:v1" as const,
  chineseLocalePackVersion: "locale-pack-zh:v1",
  englishLocalePackVersion: "locale-pack-en:v1",
  harnessPolicyVersion: CATALOG_V2_CONVERSATION_HARNESS_POLICY.version,
  conversationActionCatalogVersion:
    MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG.version,
  model: "gpt-5.4",
  modelConfigVersion: "conversation-text-champion:v1",
  modelSnapshot: "gpt-5.4",
  outputFormatVersion: "conversation-output:v1",
  canonicalPersonaVersion: "canonical-persona:v1",
  personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
  personaContractInvariantVersion: "persona-contract-invariant:v1",
  productPolicyVersion: "product-policy:v1",
  taskInstructionVersion: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
});

const testChampion = Object.freeze({
  configVersion: "conversation-text-champion:v1",
  consentPolicyVersion: null,
  contextLimit: 1_000_000,
  dataRegion: "test",
  model: "gpt-5.4",
  provider: "openai" as const,
  providerPolicyVersion: "openai-conversation-text:v1",
  retentionMode: "store-disabled",
  snapshot: "gpt-5.4",
  streaming: true as const,
  supportedLocales: Object.freeze(["en", "zh"]),
  trainingPolicy: "test",
});

function createTestUuidV7(now: Date): string {
  const bytes = randomBytes(16);
  let timestamp = now.getTime();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
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

let database: IsolatedPostgresSchema;
let claimService: MemoryClaimService;
let conversationService: ReturnType<typeof createUserTextConversationService>;
let responseRepository: PostgresConversationResponseRepository;
let counter = 0;
let quiesceActiveSession: () => Promise<boolean>;

beforeAll(async () => {
  database = await createIsolatedPostgresSchema(testDatabaseUrl);
  await runMigrations(database.pool);
  await new PostgresInternalOwnerAccessRepository(
    database.pool,
  ).provisionInternalOwner({
    issuer: "https://github.com",
    subject: "trust-actions-test-owner",
    userId: fixedInternalOwnerPrincipal.userId,
  });
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

  claimService = createMemoryClaimService({
    repository: new PostgresMemoryClaimRepository(database.pool),
    registry: {
      entryFor(predicateId) {
        return (
          registrySnapshot.entries.find(
            (entry) => entry.predicateId === predicateId,
          ) ?? null
        );
      },
      registryVersion: () => registrySnapshot.registryVersion,
      relationshipProjectionsFor(predicateId) {
        return registrySnapshot.relationshipProjections.filter(
          (projection) => projection.predicateId === predicateId,
        );
      },
      predicateLocalizationsFor(predicateId) {
        return registrySnapshot.localizations.filter(
          (localization) => localization.predicateId === predicateId,
        );
      },
    },
    clock,
    dedupeFingerprintSecret: "system-test-secret",
  });
  conversationService = createUserTextConversationService({
    clock,
    expectedBackupPolicyVersion: "neon-production-v1",
    expectedConfigurationFingerprint: "sha256:expected",
    generationPolicy,
    inactivityPolicy: {
      timeoutMs: 1_800_000,
      version: "continuous-exchange-inactivity:v1",
    },
    repository: new PostgresUserTextConversationRepository(database.pool),
  });
  responseRepository = new PostgresConversationResponseRepository(database.pool);
  const continuousExchangeService = createContinuousExchangeService({
    clock,
    repository: new PostgresContinuousExchangeRepository(database.pool),
  });
  quiesceActiveSession = async () =>
    (await continuousExchangeService.scanDueInactivity()).applied > 0;
}, 20_000);

beforeEach(async () => {
  clockNowMs = BASE_TIME;
  counter = 0;
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
        recent_context_policies,
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
  await database.pool.query(
    "UPDATE app_users SET status = 'active', data_epoch = 1",
  );
  // #295: the #293/#294 suites exercise the *enabled* recent-source path, so
  // each test starts from one active immutable governance row that matches the
  // production wired runtime. The #293 suite overrides it with a row matching
  // its own test policy; tests that need the disabled / revoked / mismatched
  // state revoke or re-seed explicitly.
  await seedRecentContextGovernance(RECENT_CONTEXT_DEFAULT_POLICY);
  await new PostgresEntityRepository(database.pool).ensureSelfEntity({
    userId: OWNER,
    now: clock(),
  });
});

afterAll(async () => {
  await database?.dispose();
}, 10_000);

// ── fixtures ───────────────────────────────────────────────────────────────

function createContextCompilerForTest() {
  return createContextCompiler({
    clock,
    compilerVersion: "context-compiler:v1",
    contentHmacSecret: "test-context-integrity-secret",
    rawEventTokenBudget: 4_000,
    repository: responseRepository,
    memoryRetrieval: createMemoryRetrievalService({
      repository: new PostgresMemoryRetrievalRepository(database.pool),
      registry: {
        registryVersion: registrySnapshot.registryVersion,
        entryFor(predicateId) {
          return (
            registrySnapshot.entries.find(
              (entry) => entry.predicateId === predicateId,
            ) ?? null
          );
        },
        localizations: registrySnapshot.localizations,
      },
      clock,
    }),
  });
}

function createTrustGateway() {
  const actionRepository = new PostgresJournalRegenerationActionRepository(
    database.pool,
    "test-action-payload-secret",
  );
  const commitPort = new PostgresMemoryTrustActionCommitPort({
    relationshipHintsFor(predicateId) {
      const entry = registryLookup.entryFor(predicateId);
      return entry ? relationshipHintInputsFor(registryLookup, entry) : null;
    },
    retrievalProjectionFor(predicateId) {
      const entry = registryLookup.entryFor(predicateId);
      return entry ? retrievalProjectionInputsFor(registryLookup, entry) : null;
    },
  });
  const targetSource = new PostgresMemoryTrustActionTargetSource(database.pool);
  const predicateSurfaces = new Map<string, readonly string[]>();
  for (const localization of registrySnapshot.localizations) {
    const existing = predicateSurfaces.get(localization.predicateId) ?? [];
    predicateSurfaces.set(localization.predicateId, [
      ...existing,
      ...localization.lexicalSurfaces
        .map((surface) => normalizeRetrievalTerm(surface.text))
        .filter((surface) => surface !== ""),
    ]);
  }
  const gateway = createConversationActionGateway({
    handlers: [
      createMemoryCorrectionActionHandler({ commitPort }),
      createExplainMemorySourceActionHandler({ commitPort }),
      createMemoryForgetRequestActionHandler({ commitPort }),
      createMemoryForgetReversalActionHandler({ commitPort }),
    ],
    repository: actionRepository,
    trustActionTargetResolver: {
      async resolve({ actionKind, anchor, userId }) {
        const [candidates, labelIndex] = await Promise.all([
          targetSource.listResolutionCandidates({
            limit: 100,
            searchSpace:
              actionKind === "memory_correction"
                ? "active_and_corrected"
                : actionKind === "explain_memory_source"
                  ? "active_claims"
                  : actionKind === "memory_forget_reversal"
                    ? "fenced_targets"
                    : "forget_targets",
            userId,
          }),
          targetSource.listLabelIndex({ userId }),
        ]);
        const withSurfaces: TrustActionResolutionCandidate[] = candidates.map(
          (candidate) => ({
            ...candidate,
            predicateSurfaces:
              predicateSurfaces.get(candidate.predicateId) ?? [],
          }),
        );
        const plan = planTrustActionTargetResolution({
          anchor,
          broadTerms: RETRIEVAL_BROAD_TERM_STOP_LIST,
          candidates: withSurfaces,
          labelIndex,
        });
        if (plan.outcome === "unique") {
          return { outcome: "unique", target: plan.target };
        }
        if (plan.outcome === "multi_hit") {
          return {
            candidateCount: plan.candidateCount,
            outcome: "multi_hit",
          };
        }
        if (plan.outcome === "scope_ambiguous") {
          return { outcome: "scope_ambiguous" };
        }
        return { outcome: "zero_hit" };
      },
    },
  });
  return { actionRepository, gateway };
}

type ModelScript = Readonly<{
  actionKind?: string;
  arguments?: Record<string, unknown>;
  /** Test hook: observes the provider payload actually rendered for egress. */
  onStream?: (request: {
    messages: readonly { role: string; text: string }[];
  }) => void;
  reply: string;
}>;

/**
 * The deterministic Champion stand-in: the decision stage emits the scripted
 * trust-action proposal (a provider-native tool call the Egress normalizes),
 * the tools-disabled finalization stage streams the scripted reply.
 */
const RECENT_CONTEXT_POLICY: RecentContextSelectionPolicy = Object.freeze({
  budgets: Object.freeze({
    maxCandidateBytes: 5_000_000,
    maxCandidateRows: 500,
    maxContextTokens: 4_000,
    maxSingleEventTokens: 2_000,
    readTimeoutMs: 5_000,
  }),
  version: "recent-context-selection-policy:v1",
  windowDays: 7,
});

/** #295: the active immutable governance identity seeded per test. */
const ACTIVE_RECENT_CONTEXT_POLICY_VERSION =
  "recent-context-governance:system-test-active";

/**
 * #295: seed exactly one active governance row whose identities and budgets
 * match the given wired policy. The compile gate refuses a row that does not
 * name the runtime actually wired, so a test using a non-production policy
 * must seed the matching row.
 */
async function seedRecentContextGovernance(
  policy: RecentContextSelectionPolicy,
): Promise<void> {
  await database.pool.query("DELETE FROM recent_context_policies");
  await database.pool.query(
    `INSERT INTO recent_context_policies (
       policy_version, status, compiler_version, selector_policy_version,
       selection_policy_version, budget_tokens, max_candidate_rows,
       max_candidate_bytes, max_single_event_tokens, read_timeout_ms,
       changed_by, created_at, revoked_at, revoked_by
     ) VALUES (
       $1, 'active', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, NULL
     )`,
    [
      ACTIVE_RECENT_CONTEXT_POLICY_VERSION,
      RECENT_CONTEXT_COMPILER_VERSION,
      RECENT_CONTEXT_SELECTION_POLICY_VERSION,
      policy.version,
      policy.budgets.maxContextTokens,
      policy.budgets.maxCandidateRows,
      policy.budgets.maxCandidateBytes,
      policy.budgets.maxSingleEventTokens,
      policy.budgets.readTimeoutMs,
      String(OWNER),
      clock(),
    ],
  );
}

function createContextCompilerWithRecentSource() {
  return createContextCompiler({
    clock,
    compilerVersion: "context-compiler:v1",
    contentHmacSecret: "test-context-integrity-secret",
    rawEventTokenBudget: 4_000,
    recentContext: {
      policy: RECENT_CONTEXT_POLICY,
      source: new PostgresRecentContextSource(database.pool),
    },
    repository: responseRepository,
  });
}

/**
 * #294 mirrors the production composition: the real bounded Postgres source
 * under the shipped default policy (never the looser #293 test policy).
 */
function createContextCompilerWithProductionRecentSource() {
  return createContextCompiler({
    clock,
    compilerVersion: "context-compiler:v1",
    contentHmacSecret: "test-context-integrity-secret",
    rawEventTokenBudget: 4_000,
    recentContext: {
      policy: RECENT_CONTEXT_DEFAULT_POLICY,
      source: new PostgresRecentContextSource(database.pool),
    },
    repository: responseRepository,
  });
}

async function loadLatestCompiledContextId(): Promise<string> {
  const row = await database.pool.query<{ compiled_context_id: string }>(
    `SELECT compiled_context_id::text AS compiled_context_id
     FROM compiled_contexts
     WHERE user_id = $1
     ORDER BY created_at DESC, compiled_context_id DESC
     LIMIT 1`,
    [OWNER],
  );
  const id = row.rows[0]?.compiled_context_id;
  if (!id) throw new Error("No CompiledContext was persisted.");
  return id;
}

/**
 * Runs an insert expected to violate a database invariant and returns the
 * PostgreSQL SQLSTATE so the test proves which real constraint fired.
 */
async function expectPgRejection(
  sql: string,
  parameters: readonly unknown[],
): Promise<string> {
  try {
    await database.pool.query(sql, parameters as unknown[]);
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
  throw new Error("Expected the insert to be rejected by the schema.");
}

const RECENT_REF_INSERT = `
  INSERT INTO compiled_context_revision_refs (
    compiled_context_id, user_id, conversation_event_revision_id, ordinal,
    actor, estimated_tokens, sequence_no, section, selection_order,
    daily_session_id, expressed_at, occurred_at, selection_reason
  ) VALUES ($1, $2, $3, $4, 'user', 4, 1, 'recent_conversation_context',
    $5, $6, $7, NULL, $8)
`;

function createScriptedModel(script: ModelScript): ConversationTextModel {
  return {
    async *stream(request) {
      script.onStream?.({ messages: request.messages });
      if (request.toolsDisabled !== true && script.actionKind) {
        yield {
          rawArguments: JSON.stringify(script.arguments ?? {}),
          rawFunctionName: script.actionKind,
          type: "tool_call" as const,
        };
        yield {
          costMicros: 0,
          finishReason: "completed",
          inputTokens: 10,
          modelSnapshot: request.model,
          outputTokens: 0,
          providerRequestId: "trust-action-request",
          type: "completed" as const,
        };
        return;
      }
      yield { delta: script.reply, type: "delta" as const };
      yield {
        costMicros: 0,
        finishReason: "completed",
        inputTokens: 10,
        modelSnapshot: request.model,
        outputTokens: Math.ceil(script.reply.length / 4),
        providerRequestId: "trust-action-request",
        type: "completed" as const,
      };
    },
  };
}

type ActionReceipt = Extract<
  ConversationResponseStreamEvent,
  { type: "action_admitted" }
>["receipt"];

async function respond(
  text: string,
  script: ModelScript,
  contextCompiler: ReturnType<typeof createContextCompiler> =
    createContextCompilerForTest(),
): Promise<{ replyText: string; receipt: ActionReceipt | null }> {
  counter += 1;
  const { gateway } = createTrustGateway();
  const harness = createConversationAgentHarness({
    actionGateway: gateway,
    clock,
    contextCompiler,
    egressPort: createProviderEgressPort({
      champion: testChampion,
      clock,
      contextCompiler,
      model: createScriptedModel(script),
      repository: responseRepository,
    }),
    repository: responseRepository,
  });
  const responseService = createConversationResponseService({
    catalog: MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
    actionGateway: gateway,
    clock,
    contextCompiler,
    conversationService,
    harness,
    harnessPolicy: CATALOG_V2_CONVERSATION_HARNESS_POLICY,
    repository: responseRepository,
  });
  let replyText = "";
  let receipt: ActionReceipt | null = null;
  const eventSummaries: string[] = [];
  for await (const event of responseService.respond(OWNER, {
    clientEventId: `trust-event-${counter}`,
    clientTurnId: `trust-turn-${counter}`,
    locale: "zh-CN",
    text,
    timezone: "Asia/Shanghai",
  })) {
    eventSummaries.push(
      event.type === "response_failed" || event.type === "response_interrupted"
        ? `${event.type}:${event.category}`
        : event.type,
    );
    if (event.type === "assistant_delta") {
      replyText += event.delta;
    } else if (event.type === "action_admitted") {
      receipt = event.receipt;
    } else if (event.type === "response_failed") {
      throw new Error(`Response failed: ${event.category}`);
    }
  }
  if (!replyText) {
    throw new Error(
      `The turn produced no visible reply (events=${eventSummaries.join(",")}, receipt=${JSON.stringify(receipt)}).`,
    );
  }
  return { receipt, replyText };
}

async function submitTurn(text: string): Promise<string> {
  counter += 1;
  const turn = await conversationService.submit(OWNER, {
    clientEventId: `trust-seed-event-${counter}`,
    clientTurnId: `trust-seed-turn-${counter}`,
    locale: "zh-CN",
    text,
    timezone: "Asia/Shanghai",
  });
  return turn.message.revisionId;
}

async function seedEvidence(revisionId: string): Promise<string> {
  const snapshotId = createTestUuidV7(clock());
  const itemId = createTestUuidV7(clock());
  await database.pool.query(
    `INSERT INTO evidence_source_snapshots (
       evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
       extraction_policy_version, command_id, attempt_id, champion_config_version,
       champion_provider, champion_model, champion_snapshot,
       champion_provider_policy_version, created_at
     ) VALUES ($1, $2, (SELECT daily_session_id FROM conversation_events
       WHERE conversation_event_id = (SELECT conversation_event_id
         FROM conversation_event_revisions WHERE conversation_event_revision_id = $3)),
       (SELECT sequence_no FROM conversation_events
         WHERE conversation_event_id = (SELECT conversation_event_id
           FROM conversation_event_revisions WHERE conversation_event_revision_id = $3)),
       'evidence-extraction:v2', 'seed', 'seed', 'test', 'openai', 'test', 'test', 'test', $4)`,
    [snapshotId, OWNER, revisionId, clock()],
  );
  await database.pool.query(
    `INSERT INTO evidence_items (
       evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
       source_revision_id, source_actor, source_status, locator_type,
       locator_key, extraction_policy_version, evidence_role, created_at
     ) VALUES ($1, $2, $3,
       (SELECT conversation_event_id FROM conversation_event_revisions
         WHERE conversation_event_revision_id = $4),
       $4, 'user', 'final', 'whole_revision', $5, 'evidence-extraction:v2',
       'factual_support', $6)`,
    [itemId, OWNER, snapshotId, revisionId, `revision:${revisionId}`, clock()],
  );
  return itemId;
}

async function selfEntityId(): Promise<string> {
  const row = await database.pool.query<{ entity_id: string }>(
    `SELECT entity_id::text FROM user_self_entities WHERE user_id = $1`,
    [OWNER],
  );
  const entityId = row.rows[0]?.entity_id;
  if (!entityId) throw new Error("Self Entity missing in test fixture.");
  return entityId;
}

/** Fixture: introduce one named person and promote its EntityVersion. */
async function seedNamedPerson(label: string): Promise<string> {
  const text = `我和${label}是亲戚。`;
  const revisionId = await submitTurn(text);
  const evidenceId = await seedEvidence(revisionId);
  const startOffset = text.indexOf(label);
  const resolutions = await new PostgresEntityRepository(
    database.pool,
  ).resolveMentions({
    userId: OWNER,
    eventRevisionId: revisionId,
    proposals: [
      {
        surfaceForm: label,
        locatorType: "text_span",
        startOffset,
        endOffset: startOffset + label.length,
        mentionKind: "named",
        newIntroduction: true,
        entityKindId: "sh.entity.person",
        evidenceId,
      },
    ],
    resolverPolicyVersion: "entity-resolution:v2",
    now: clock(),
  });
  const entityId = resolutions[0]?.entityId;
  if (!entityId) throw new Error(`Could not create Entity for ${label}.`);
  await database.pool.query(
    `INSERT INTO entity_versions (
       entity_version_id, entity_id, user_id, revision, entity_kind_id,
       status, created_at
     )
     SELECT $3, entity_id, user_id, revision + 1, entity_kind_id, 'active', $4
     FROM entity_versions
     WHERE entity_id = $1 AND user_id = $2
       AND entity_version_id = (
         SELECT current_version_id FROM entities
         WHERE entity_id = $1 AND user_id = $2
       )`,
    [entityId, OWNER, createTestUuidV7(clock()), clock()],
  );
  await database.pool.query(
    `UPDATE entities
     SET current_version_id = (
       SELECT entity_version_id FROM entity_versions
       WHERE entity_id = $1 AND user_id = $2
       ORDER BY revision DESC LIMIT 1
     )
     WHERE entity_id = $1 AND user_id = $2`,
    [entityId, OWNER],
  );
  return entityId;
}

/** Fixture: one relationship Claim with an evidence-backed kinship Qualifier. */
async function seedRelativeClaim(input: {
  label?: string;
  qualifierValue?: string;
  independentBaseEvidence?: boolean;
} = {}): Promise<{
  claimId: string;
  objectEntityId: string;
  evidenceId: string;
  revisionId: string;
}> {
  const label = input.label ?? "小明";
  const qualifierValue = input.qualifierValue ?? "姑姑";
  const objectEntityId = await seedNamedPerson(label);
  const baseRevisionId = await submitTurn(`${label}是我的亲戚。`);
  const baseEvidenceId = await seedEvidence(baseRevisionId);
  const hasIndependentBaseEvidence = input.independentBaseEvidence ?? true;
  const qualifierRevisionId = hasIndependentBaseEvidence
    ? await submitTurn(`${label}是我的${qualifierValue}。`)
    : baseRevisionId;
  const qualifierEvidenceId = hasIndependentBaseEvidence
    ? await seedEvidence(qualifierRevisionId)
    : baseEvidenceId;
  const admitted = await recordAndAdmit({
    basis: "directly_stated",
    evidenceItemIds: [baseEvidenceId, qualifierEvidenceId],
    kind: "objective",
    objectEntityId,
    predicateId: "sh.relationship.relative_of",
    qualifiers: [
      {
        axisId: "kinship_term",
        roleSide: "object",
        typedValue: qualifierValue,
        evidenceItemIds: [qualifierEvidenceId],
      },
    ],
    typedValue: "",
  });
  if (admitted.outcome !== "promoted") {
    throw new Error(`expected promoted relationship claim, got ${admitted.outcomeCode}`);
  }
  return {
    claimId: admitted.claimId,
    objectEntityId,
    evidenceId: qualifierEvidenceId,
    revisionId: qualifierRevisionId,
  };
}

const CLAIM_LINEAGE = {
  extractionPolicyVersion: "memory-extract-test:v1",
  generationCommandId: null,
  authoritativeModelAttemptId: null,
  modelVersion: "test-model",
  promptVersion: "memory-extract-test-prompt:v1",
  sourceReflectionVersionId: null,
} as const;

async function recordAndAdmit(input: {
  predicateId: string;
  kind: "objective" | "impression";
  basis: "directly_stated" | "inferred";
  typedValue: string | readonly string[];
  evidenceItemIds: readonly string[];
  objectEntityId?: string | null;
  qualifiers?: readonly {
    axisId: string;
    roleSide: "subject" | "object";
    typedValue: string | readonly string[];
    evidenceItemIds: readonly string[];
  }[];
}): Promise<
  | { outcome: "promoted"; claimId: string; claimVersionId: string }
  | { outcome: "not_promoted"; outcomeCode: string }
> {
  const recorded = await claimService.recordCandidate({
    userId: OWNER,
    candidateKind: input.kind,
    basis: input.basis,
    resolution: {
      status: "mapped",
      predicateId: input.predicateId,
      registryVersion: 1,
      typedValue: input.typedValue,
      mappingConfidence: 0.95,
    },
    subjectEntityId: await selfEntityId(),
    subjectEntityMentionId: null,
    objectEntityId: input.objectEntityId ?? null,
    objectEntityMentionId: null,
    scopeKey: "",
    temporal: {
      temporalStatus: "current",
      validFrom: null,
      validFromPrecision: "unknown",
      validTo: null,
      validToPrecision: "unknown",
    },
    qualifiers: input.qualifiers ?? [],
    evidenceItemIds: input.evidenceItemIds,
    lineage: CLAIM_LINEAGE,
  });
  if (recorded.outcome !== "recorded") {
    throw new Error(`expected recorded candidate, got ${recorded.outcome}`);
  }
  const admitted = await claimService.admitCandidate({
    userId: OWNER,
    candidateId: recorded.candidateId,
  });
  if (admitted.outcome !== "promoted") {
    return { outcome: "not_promoted", outcomeCode: admitted.outcome };
  }
  return {
    outcome: "promoted",
    claimId: admitted.claimId,
    claimVersionId: admitted.claimVersionId,
  };
}

/** Admits a residence claim through the real path: event → evidence → claim. */
async function seedResidenceClaim(statement: string): Promise<string> {
  const revisionId = await submitTurn(statement);
  const evidenceId = await seedEvidence(revisionId);
  const admitted = await recordAndAdmit({
    basis: "directly_stated",
    evidenceItemIds: [evidenceId],
    kind: "objective",
    predicateId: "sh.place.residence",
    typedValue: "上海",
  });
  if (admitted.outcome !== "promoted") {
    throw new Error(
      `expected promoted residence claim, got ${admitted.outcomeCode}`,
    );
  }
  return admitted.claimId;
}

// ── query helpers ──────────────────────────────────────────────────────────

async function claimState(claimId: string): Promise<{
  currentStatus: string;
  currentVersionId: string;
  createdBy: string;
  revision: number;
  projectionStatuses: string[];
}> {
  const row = await database.pool.query<{
    created_by: string;
    current_status: string;
    current_version_id: string;
    projection_statuses: string[] | null;
    revision: number;
  }>(
    `SELECT v.status AS current_status, v.created_by, v.revision,
            v.memory_claim_version_id::text AS current_version_id,
            (SELECT array_agg(p.status ORDER BY p.claim_retrieval_projection_id)
             FROM claim_retrieval_projections p
             WHERE p.memory_claim_id = claim.memory_claim_id
               AND p.user_id = claim.user_id) AS projection_statuses
     FROM memory_claims claim
     JOIN memory_claim_versions v
       ON v.memory_claim_version_id = claim.current_version_id
     WHERE claim.memory_claim_id = $1 AND claim.user_id = $2`,
    [claimId, OWNER],
  );
  const value = row.rows[0]!;
  return {
    createdBy: value.created_by,
    currentStatus: value.current_status,
    currentVersionId: value.current_version_id,
    projectionStatuses: value.projection_statuses ?? [],
    revision: value.revision,
  };
}

async function currentQualifiers(claimId: string): Promise<
  readonly {
    id: string;
    versionId: string;
    axisId: string;
    roleSide: string;
    typedValue: unknown;
    evidenceItemIds: string[];
  }[]
> {
  const rows = await database.pool.query<{
    id: string;
    version_id: string;
    axis_id: string;
    role_side: string;
    typed_value: unknown;
    evidence_item_ids: string[] | null;
  }>(
    `SELECT qualifier.memory_claim_version_qualifier_id::text AS id,
            qualifier.memory_claim_version_id::text AS version_id,
            qualifier.axis_id, qualifier.role_side, qualifier.typed_value,
            ARRAY(
              SELECT evidence_item_id::text
              FROM memory_claim_version_qualifier_evidence evidence
              WHERE evidence.memory_claim_version_qualifier_id =
                qualifier.memory_claim_version_qualifier_id
              ORDER BY evidence_item_id
            ) AS evidence_item_ids
     FROM memory_claims claim
     INNER JOIN memory_claim_version_qualifiers qualifier
       ON qualifier.memory_claim_version_id = claim.current_version_id
      AND qualifier.user_id = claim.user_id
     WHERE claim.user_id = $1 AND claim.memory_claim_id = $2
     ORDER BY qualifier.axis_id, qualifier.role_side`,
    [OWNER, claimId],
  );
  return rows.rows.map((row) => ({
    axisId: row.axis_id,
    evidenceItemIds: row.evidence_item_ids ?? [],
    id: row.id,
    roleSide: row.role_side,
    typedValue: row.typed_value,
    versionId: row.version_id,
  }));
}

async function currentRelationshipHints(claimId: string): Promise<
  readonly {
    locale: string;
    roleAxisId: string | null;
    roleSource: string;
    roleTerm: string;
    versionId: string;
  }[]
> {
  const rows = await database.pool.query<{
    locale: string;
    role_axis_id: string | null;
    role_source: string;
    role_term: string;
    version_id: string;
  }>(
    `SELECT hint.locale, hint.role_axis_id, hint.role_source,
            hint.role_term, hint.memory_claim_version_id::text AS version_id
     FROM relationship_resolver_hints hint
     WHERE hint.user_id = $1 AND hint.memory_claim_id = $2
     ORDER BY hint.locale, hint.resolved_entity_id`,
    [OWNER, claimId],
  );
  return rows.rows.map((row) => ({
    locale: row.locale,
    roleAxisId: row.role_axis_id,
    roleSource: row.role_source,
    roleTerm: row.role_term,
    versionId: row.version_id,
  }));
}

/** Sections of the newest action-finalization compiled context. */
async function finalizationContextSections(): Promise<{
  degradedReason: string | null;
  sectionKeys: string[];
}> {
  const row = await database.pool.query<{
    degraded_reason: string | null;
    sections: { key: string }[];
  }>(
    `SELECT context.degraded_reason, context.sections
     FROM compiled_contexts context
     INNER JOIN generation_commands command
       ON command.compiled_context_id = context.compiled_context_id
      AND command.user_id = context.user_id
     WHERE command.user_id = $1
       AND command.generation_stage = 'action_finalization'
     ORDER BY context.created_at DESC, context.compiled_context_id DESC
     LIMIT 1`,
    [OWNER],
  );
  const value = row.rows[0];
  if (!value) return { degradedReason: null, sectionKeys: [] };
  return {
    degradedReason: value.degraded_reason,
    sectionKeys: value.sections.map((section) => section.key),
  };
}

async function decisionContextSectionKeys(): Promise<string[]> {
  const row = await database.pool.query<{ sections: { key: string }[] }>(
    `SELECT context.sections
     FROM compiled_contexts context
     INNER JOIN generation_commands command
       ON command.compiled_context_id = context.compiled_context_id
      AND command.user_id = context.user_id
     WHERE command.user_id = $1
       AND command.generation_stage = 'decision'
     ORDER BY context.created_at DESC, context.compiled_context_id DESC
     LIMIT 1`,
    [OWNER],
  );
  return (row.rows[0]?.sections ?? []).map((section) => section.key);
}

async function receiptRows(actionExecutionId: string) {
  const row = await database.pool.query<{
    disposition: string | null;
    execution_status: string;
    receipt_key: string;
    receipt_sequence: number;
  }>(
    `SELECT receipt_key, receipt_sequence, execution_status, disposition
     FROM conversation_action_receipts
     WHERE action_execution_id = $1
     ORDER BY receipt_sequence`,
    [actionExecutionId],
  );
  return row.rows;
}

async function executionRow(actionExecutionId: string) {
  const row = await database.pool.query<{
    disposition: string | null;
    resolved_claim_id: string | null;
    resolved_claim_version_id: string | null;
    resolved_qualifier_id: string | null;
    request_event_revision_id: string;
    target_kind: string | null;
  }>(
    `SELECT disposition, request_event_revision_id::text AS request_event_revision_id,
            resolved_claim_id::text AS resolved_claim_id,
            resolved_claim_version_id::text AS resolved_claim_version_id,
            resolved_qualifier_id::text AS resolved_qualifier_id, target_kind
     FROM conversation_action_executions WHERE action_execution_id = $1`,
    [actionExecutionId],
  );
  return row.rows[0]!;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("Trust actions core (issue #119)", () => {
  it("corrects a unique target synchronously: typed reference, immediate fence, receipts, follow-up command", async () => {
    const claimId = await seedResidenceClaim("我住在上海。");
    advanceMs(60 * 1_000);

    const { receipt, replyText } = await respond(
      "不对，我不是住在上海，我住在杭州。",
      {
        actionKind: "memory_correction",
        arguments: {
          correctedFact: "我住在杭州",
          targetAnchor: "我住在上海",
        },
        reply: "好，已更正，以后按杭州来说。",
      },
    );

    expect(receipt?.admission).toBe("accepted");
    expect(receipt?.execution).toBe("succeeded");
    const receipts = await receiptRows(receipt!.actionExecutionId);
    expect(receipts.map((value) => value.receipt_key)).toEqual([
      "admission",
      "execution:succeeded",
    ]);

    // The typed reference (ADR-0118): the resolved claim on the execution.
    const execution = await executionRow(receipt!.actionExecutionId);
    expect(execution.resolved_claim_id).toBe(claimId);
    expect(execution.target_kind).toBe("memory_claim");
    expect(execution.disposition).toBe("committed_in_transaction");

    // The corrected content stops being recallable in the same turn
    // (SPEC AC 28/29): superseded current version, stale projections.
    const state = await claimState(claimId);
    expect(state.currentStatus).toBe("superseded");
    expect(state.createdBy).toBe("memory_correction");
    expect(state.projectionStatuses.every((status) => status === "stale")).toBe(
      true,
    );

    // The correction command + follow-up command joined the same transaction.
    const corrections = await database.pool.query(
      `SELECT 1 FROM memory_claim_corrections
       WHERE user_id = $1 AND target_claim_id = $2 AND corrected_fact_recorded`,
      [OWNER, claimId],
    );
    expect(corrections.rowCount).toBe(1);
    const followups = await database.pool.query<{ event_type: string }>(
      `SELECT events.event_type
       FROM workflow_commands command
       JOIN outbox_events events
         ON events.workflow_command_id = command.workflow_command_id
       WHERE command.command_type = 'memory_correction_followup'`,
    );
    expect(followups.rows).toHaveLength(1);
    expect(followups.rows[0]!.event_type).toBe(
      "memory_correction_followup_requested",
    );

    // The finalization (reply) context compiled after the commit carries no
    // corrected memory: commit before retrieval is mechanical (SPEC AC 29).
    const sections = await finalizationContextSections();
    expect(sections.sectionKeys).not.toContain("objective_memory");
    expect(sections.sectionKeys).toContain("trust_action_expression");
    expect(sections.sectionKeys).toContain("action_finalization_receipt");
    expect(replyText).toContain("更正");
  });

  it("never recalls the corrected content on later turns", async () => {
    const claimId = await seedResidenceClaim("我住在上海。");
    advanceMs(60 * 1_000);
    await respond("不对，我不是住在上海，我住在杭州。", {
      actionKind: "memory_correction",
      arguments: {
        correctedFact: "我住在杭州",
        targetAnchor: "我住在上海",
      },
      reply: "好，已更正。",
    });
    advanceMs(60 * 1_000);
    await respond("我现在住哪儿来着？", { reply: "你说过你住在杭州。" });
    const keys = await decisionContextSectionKeys();
    expect(keys).not.toContain("objective_memory");
    expect((await claimState(claimId)).currentStatus).toBe("superseded");
  });

  it("clarifies count-only on a materially ambiguous target and fails the round's memory closed", async () => {
    await seedResidenceClaim("我住在上海。");
    const revisionId = await submitTurn("我公司在上海。");
    const evidenceId = await seedEvidence(revisionId);
    const workplace = await recordAndAdmit({
      basis: "directly_stated",
      evidenceItemIds: [evidenceId],
      kind: "objective",
      predicateId: "sh.place.workplace",
      typedValue: ["上海"],
    });
    if (workplace.outcome !== "promoted") throw new Error(workplace.outcome);
    advanceMs(60 * 1_000);

    const { receipt, replyText } = await respond(
      "关于上海的记忆不对，帮我改一下。",
      {
        actionKind: "memory_correction",
        arguments: { targetAnchor: "关于上海的记忆" },
        reply: "有两条和上海有关的记忆，你指的是哪一条？",
      },
    );

    expect(receipt?.admission).toBe("clarification_required");
    expect(receipt?.disposition).toBe("target_ambiguous_multi_hit");
    expect(receipt?.execution).toBe("not_started");

    const execution = await executionRow(receipt!.actionExecutionId);
    expect(execution.resolved_claim_id).toBeNull();
    const detail = await database.pool.query<{
      disposition_detail: { candidateCount?: number } | null;
    }>(
      `SELECT disposition_detail FROM conversation_action_receipts
       WHERE action_execution_id = $1 AND receipt_key = 'admission'`,
      [receipt!.actionExecutionId],
    );
    expect(detail.rows[0]!.disposition_detail).toEqual({ candidateCount: 2 });

    // Zero domain change: both claims stayed active.
    const active = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM memory_claim_versions
       WHERE user_id = $1 AND status = 'active'`,
      [OWNER],
    );
    expect(active.rows[0]!.count).toBe("2");

    // The round's memory fails closed on the reply context (SPEC AC 29).
    const sections = await finalizationContextSections();
    expect(sections.degradedReason).toBe("trust_action_memory_fenced");
    expect(sections.sectionKeys).not.toContain("objective_memory");
    expect(sections.sectionKeys).not.toContain("recall_experience");
    expect(sections.sectionKeys).toContain("trust_action_expression");
    // A clarification reply is still owed and committed.
    expect(replyText).toContain("两条");
  });

  it("honestly reports a zero hit with zero domain change and keeps memory available", async () => {
    await seedResidenceClaim("我住在上海。");
    advanceMs(60 * 1_000);

    const { receipt, replyText } = await respond("上海的事你记错了。", {
      actionKind: "memory_correction",
      arguments: { targetAnchor: "我养了一只企鹅" },
      reply: "我没有找到这条记忆，什么都没有改。",
    });

    expect(receipt?.admission).toBe("clarification_required");
    expect(receipt?.disposition).toBe("target_not_found");
    const superseded = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM memory_claim_versions
       WHERE user_id = $1 AND status = 'superseded'`,
      [OWNER],
    );
    expect(superseded.rows[0]!.count).toBe("0");

    // Zero-hit is honest, not fenced: the reply context keeps its memory.
    const sections = await finalizationContextSections();
    expect(sections.degradedReason).not.toBe("trust_action_memory_fenced");
    expect(replyText.length).toBeGreaterThan(0);
  });

  it("converges a repeated correction on the same logical claim (succeeded_noop)", async () => {
    const claimId = await seedResidenceClaim("我住在上海。");
    advanceMs(60 * 1_000);
    await respond("不对，我不住在上海。", {
      actionKind: "memory_correction",
      arguments: { targetAnchor: "我住在上海" },
      reply: "好，已更正。",
    });
    const firstState = await claimState(claimId);
    advanceMs(60 * 1_000);

    const { receipt } = await respond("再说一遍，上海是错的。", {
      actionKind: "memory_correction",
      arguments: { targetAnchor: "上海" },
      reply: "好，这条我记住了：不再提上海。",
    });

    expect(receipt?.admission).toBe("accepted");
    expect(receipt?.execution).toBe("succeeded");
    expect(receipt?.disposition).toBe("committed_in_transaction");
    // Logical Claim reuse WITH version append as normal history (story 48):
    // the repeat appended a version on the SAME claim — no duplicate claim.
    const secondState = await claimState(claimId);
    expect(secondState.revision).toBe(firstState.revision + 1);
    expect(secondState.currentStatus).toBe("superseded");
    expect(secondState.createdBy).toBe("memory_correction");
    const claimCount = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM memory_claims WHERE user_id = $1`,
      [OWNER],
    );
    expect(claimCount.rows[0]!.count).toBe("1");
  });

  it("deactivates an impression with the user veto; re-accumulation starts from zero", async () => {
    // Cross-session impression (ADR-0039): two independent days.
    const day1 = await submitTurn("我感觉我不太爱说话。");
    const evidence1 = await seedEvidence(day1);
    advanceMs(INACTIVITY_ADVANCE_MS);
    expect(await quiesceActiveSession()).toBe(true);
    advanceMs(1 * DAY_MS);
    const day2 = await submitTurn("对，我确实是那种安静的人。");
    const evidence2 = await seedEvidence(day2);
    const admitted = await recordAndAdmit({
      basis: "inferred",
      evidenceItemIds: [evidence1, evidence2],
      kind: "impression",
      predicateId: "sh.communication.stated_style",
      typedValue: "安静",
    });
    if (admitted.outcome !== "promoted")
      throw new Error(admitted.outcomeCode);
    const claimId = admitted.claimId;
    advanceMs(60 * 1_000);

    const { receipt } = await respond("不对，你别把我当安静的人。", {
      actionKind: "memory_correction",
      arguments: { targetAnchor: "安静的人" },
      reply: "好，我收回这个印象，不会再这么看你。",
    });

    expect(receipt?.admission).toBe("accepted");
    expect(receipt?.disposition).toBe("committed_in_transaction");
    const state = await claimState(claimId);
    expect(state.currentStatus).toBe("superseded");
    expect(state.createdBy).toBe("memory_correction");
    const vetoes = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM memory_impression_vetoes
       WHERE user_id = $1 AND memory_claim_id = $2 AND status = 'active'`,
      [OWNER, claimId],
    );
    expect(vetoes.rows[0]!.count).toBe("1");

    // Fresh-from-zero: a new same-topic impression with only ONE new piece
    // of evidence from one new session stays below the ADR-0039 floor — the
    // deactivated evidence chain does not carry it.
    advanceMs(INACTIVITY_ADVANCE_MS);
    expect(await quiesceActiveSession()).toBe(true);
    advanceMs(1 * DAY_MS);
    const day3 = await submitTurn("其实我最近话挺多的。");
    const evidence3 = await seedEvidence(day3);
    const retry = await recordAndAdmit({
      basis: "inferred",
      evidenceItemIds: [evidence3],
      kind: "impression",
      predicateId: "sh.communication.stated_style",
      typedValue: "外向",
    });
    expect(retry).toEqual({
      outcome: "not_promoted",
      outcomeCode: "below_impression_floor",
    });
  });

  it("explains a verified source with dates and the user's actual words", async () => {
    await seedResidenceClaim("我住在上海。");
    advanceMs(60 * 1_000);

    const { receipt } = await respond("你为什么记得我住在上海？", {
      actionKind: "explain_memory_source",
      arguments: { targetAnchor: "我住在上海" },
      reply: "因为你 2026-08-27 说过「我住在上海。」",
    });

    expect(receipt?.admission).toBe("accepted");
    expect(receipt?.execution).toBe("succeeded");
    expect(receipt?.disposition).toBe("source_evidence_verified");
    const execution = await executionRow(receipt!.actionExecutionId);
    expect(execution.resolved_claim_id).not.toBeNull();

    // The frozen receipt detail derives byte-identically for the compile and
    // the egress replay: dates and the user's actual words (ADR-0008).
    const snapshot = await loadActionFinalizationReceiptSnapshot(
      database.pool,
      {
        actionExecutionId: receipt!.actionExecutionId,
        admission: receipt!.admission,
        disposition: receipt!.disposition,
        execution: receipt!.execution,
        receiptSequence: receipt!.receiptSequence,
      },
    );
    expect(snapshot.trustAction?.evidenceVerdict).toBe("verified");
    expect(snapshot.trustAction?.claimKind).toBe("objective");
    expect(snapshot.trustAction?.evidenceItems).toHaveLength(1);
    expect(snapshot.trustAction?.evidenceItems[0]?.occurredOn).toBe(
      "2026-08-27",
    );
    expect(snapshot.trustAction?.evidenceItems[0]?.quote).toContain(
      "我住在上海",
    );
  });

  it("falls back to the fixed cannot-verify phrasing when evidence is unreadable", async () => {
    const claimId = await seedResidenceClaim("我住在上海。");
    // The evidence source can no longer be expanded to a valid User Event
    // Revision: its conversation Event left the active lifecycle (deletion
    // propagation, ADR-0002) — exactly ADR-0008's unverifiable case.
    await database.pool.query(
      `UPDATE conversation_events event
       SET lifecycle_status = 'deleted'
       WHERE event.conversation_event_id IN (
         SELECT item.source_event_id
         FROM claim_evidence_links link
         JOIN evidence_items item
           ON item.evidence_item_id = link.evidence_item_id
         WHERE link.user_id = $1 AND link.memory_claim_version_id = $2
       )`,
      [
        OWNER,
        (
          await database.pool.query<{ current_version_id: string }>(
            `SELECT current_version_id::text FROM memory_claims
             WHERE memory_claim_id = $1 AND user_id = $2`,
            [claimId, OWNER],
          )
        ).rows[0]!.current_version_id,
      ],
    );
    advanceMs(60 * 1_000);

    const { receipt } = await respond("你为什么记得我住在上海？", {
      actionKind: "explain_memory_source",
      arguments: { targetAnchor: "我住在上海" },
      reply: "我无法核实这条记忆是从哪来的。",
    });

    expect(receipt?.disposition).toBe("source_unverifiable");
    // The unverifiable verdict drives the fixed ADR-0008 phrasing; the
    // derived snapshot carries no fabricated evidence.
    const snapshot = await loadActionFinalizationReceiptSnapshot(
      database.pool,
      {
        actionExecutionId: receipt!.actionExecutionId,
        admission: receipt!.admission,
        disposition: receipt!.disposition,
        execution: receipt!.execution,
        receiptSequence: receipt!.receiptSequence,
      },
    );
    expect(snapshot.trustAction?.evidenceVerdict).toBe("unverifiable");
    expect(snapshot.trustAction?.evidenceItems).toHaveLength(0);
    expect(trustActionUnverifiablePhrasing("zh-CN")).toBe(
      "我无法核实这条记忆是从哪来的。",
    );
  });

  it("runs the async follow-up idempotently under one receipt sequence", async () => {
    const claimId = await seedResidenceClaim("我住在上海。");
    advanceMs(60 * 1_000);
    await respond("不对，我不住在上海。", {
      actionKind: "memory_correction",
      arguments: { targetAnchor: "我住在上海" },
      reply: "好，已更正。",
    });
    const command = await database.pool.query<{
      action_execution_id: string;
      workflow_command_id: string;
    }>(
      `SELECT action_execution_id::text AS action_execution_id,
              workflow_command_id::text AS workflow_command_id
       FROM workflow_commands
       WHERE command_type = 'memory_correction_followup'`,
    );
    expect(command.rows).toHaveLength(1);
    const workflowCommandId = command.rows[0]!.workflow_command_id;

    const followupRepository = new PostgresMemoryCorrectionFollowupRepository(
      database.pool,
    );
    const first = await runMemoryCorrectionFollowupWorkflow({
      repository: followupRepository,
      workflowCommandId,
    });
    expect(first.outcome).toBe("completed");
    // A workflow retry replays: the follow-up row is the idempotency anchor.
    const second = await runMemoryCorrectionFollowupWorkflow({
      repository: followupRepository,
      workflowCommandId,
    });
    expect(second.outcome).toBe("replayed");

    const receipts = await receiptRows(command.rows[0]!.action_execution_id);
    expect(receipts.map((value) => value.receipt_key)).toEqual([
      "admission",
      "execution:succeeded",
      "execution:followup:processing",
      "execution:followup:completed",
    ]);
    expect(
      receipts.every((value) => value.execution_status !== "not_started"),
    ).toBe(true);
    expect((await claimState(claimId)).currentStatus).toBe("superseded");
  });

  it("keeps transport retries safe: the same request event revision returns the same execution", async () => {
    const claimId = await seedResidenceClaim("我住在上海。");
    advanceMs(60 * 1_000);
    const { receipt } = await respond("不对，我不住在上海。", {
      actionKind: "memory_correction",
      arguments: { targetAnchor: "我住在上海" },
      reply: "好，已更正。",
    });
    const identity = await database.pool.query<{
      compiled_context_id: string;
      decision_command_id: string;
      request_event_revision_id: string;
    }>(
      `SELECT decision_command_id::text, request_event_revision_id::text,
              (SELECT compiled_context_id::text FROM generation_commands command
               WHERE command.generation_command_id = execution.decision_command_id
                 AND command.user_id = execution.user_id) AS compiled_context_id
       FROM conversation_action_executions execution
       WHERE action_execution_id = $1`,
      [receipt!.actionExecutionId],
    );
    const decisionCommandId = identity.rows[0]!.decision_command_id;
    const requestEventRevisionId =
      identity.rows[0]!.request_event_revision_id;

    // A transport retry replays the same proposal against the same request
    // event revision (SPEC story 48): same execution, same receipts, no
    // second domain write.
    const { gateway } = createTrustGateway();
    const replayed = await gateway.admit({
      catalog: MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
      context: {
        compiledContextId: identity.rows[0]!.compiled_context_id as never,
        decisionCommandId: decisionCommandId as never,
        requestEventRevisionId: requestEventRevisionId as never,
        userId: OWNER,
      },
      proposal: {
        actionKind: "memory_correction",
        arguments: { targetAnchor: "我住在上海" },
        requestEventRevisionId: requestEventRevisionId as never,
        schemaVersion: "memory-correction:v1",
      },
    });
    expect(replayed.actionExecutionId).toBe(receipt!.actionExecutionId);
    const state = await claimState(claimId);
    expect(state.createdBy).toBe("memory_correction");
    const versions = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM memory_claim_versions
       WHERE memory_claim_id = $1`,
      [claimId],
    );
    // Exactly two versions: the original + the correction (the retry added
    // nothing) — the idempotency key, not dedup machinery, converged it.
    expect(versions.rows[0]!.count).toBe("2");
  });

  it("forgets a whole Claim without deleting its source and converges repeats", async () => {
    const claimId = await seedResidenceClaim("我住在上海。");
    const original = await claimState(claimId);
    advanceMs(60 * 1_000);

    const { receipt } = await respond("请忘掉我住在上海这件事。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "我住在上海" },
      reply: "好，我不会再把这件事作为记忆提起。原对话还在。",
    });

    expect(receipt).toMatchObject({
      admission: "accepted",
      disposition: "committed_in_transaction",
      execution: "succeeded",
    });
    const execution = await executionRow(receipt!.actionExecutionId);
    expect(execution).toMatchObject({
      resolved_claim_id: claimId,
      target_kind: "memory_claim",
      resolved_qualifier_id: null,
    });
    const state = await claimState(claimId);
    expect(state).toMatchObject({
      createdBy: "forget_request",
      currentStatus: "retracted",
    });
    expect(state.currentVersionId).not.toBe(original.currentVersionId);
    expect(state.projectionStatuses.every((status) => status === "deleted")).toBe(
      true,
    );

    const request = await database.pool.query<{
      applied_claim_version_id: string;
      target_scope: string;
    }>(
      `SELECT applied_claim_version_id::text, target_scope
       FROM memory_forget_requests
       WHERE user_id = $1 AND target_claim_id = $2`,
      [OWNER, claimId],
    );
    expect(request.rows).toHaveLength(1);
    expect(request.rows[0]).toMatchObject({
      applied_claim_version_id: state.currentVersionId,
      target_scope: "whole_claim",
    });
    const exclusions = await database.pool.query(
      `SELECT 1 FROM memory_forget_evidence_exclusions
       WHERE user_id = $1 AND memory_forget_request_id = (
         SELECT memory_forget_request_id FROM memory_forget_requests
         WHERE user_id = $1 AND target_claim_id = $2
       ) AND exclusion_scope = 'whole_claim' AND status = 'active'`,
      [OWNER, claimId],
    );
    expect(exclusions.rowCount).toBe(1);

    const source = await database.pool.query<{
      event_lifecycle: string;
      item_status: string;
      purged_at: Date | null;
    }>(
      `SELECT item.status AS item_status,
              revision.content_purged_at AS purged_at,
              event.lifecycle_status AS event_lifecycle
       FROM evidence_items item
       JOIN conversation_event_revisions revision
         ON revision.conversation_event_revision_id = item.source_revision_id
       JOIN conversation_events event
         ON event.conversation_event_id = revision.conversation_event_id
       WHERE item.user_id = $1 AND item.evidence_item_id = $2`,
      [OWNER, (await database.pool.query<{ evidence_item_id: string }>(
        `SELECT evidence_item_id::text FROM claim_evidence_links
         WHERE user_id = $1 AND memory_claim_version_id = $2
         LIMIT 1`,
        [OWNER, original.currentVersionId],
      )).rows[0]!.evidence_item_id],
    );
    expect(source.rows[0]).toMatchObject({
      event_lifecycle: "active",
      item_status: "active",
      purged_at: null,
    });
    const finalization = await finalizationContextSections();
    expect(finalization.degradedReason).toBe("trust_action_memory_fenced");
    expect(finalization.sectionKeys).not.toContain("objective_memory");

    advanceMs(60 * 1_000);
    const repeated = await respond("再忘掉我住在上海这件事。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "我住在上海" },
      reply: "这条记忆已经忘记了。",
    });
    expect(repeated.receipt).toMatchObject({
      admission: "accepted",
      disposition: "succeeded_noop",
      execution: "succeeded",
    });
    expect((await claimState(claimId)).currentVersionId).toBe(
      state.currentVersionId,
    );
    const requestCount = await database.pool.query(
      `SELECT 1 FROM memory_forget_requests
       WHERE user_id = $1 AND target_claim_id = $2`,
      [OWNER, claimId],
    );
    expect(requestCount.rowCount).toBe(1);
  });

  it("uses a fresh Evidence and ClaimVersion for whole-Claim Forget Reversal", async () => {
    const claimId = await seedResidenceClaim("我住在上海。");
    const original = await claimState(claimId);
    const originalEvidence = await database.pool.query<{
      evidence_item_id: string;
    }>(
      `SELECT evidence_item_id::text
       FROM claim_evidence_links
       WHERE user_id = $1 AND memory_claim_version_id = $2
       LIMIT 1`,
      [OWNER, original.currentVersionId],
    );
    advanceMs(60 * 1_000);
    await respond("请忘掉我住在上海。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "我住在上海" },
      reply: "好。",
    });
    const fenced = await claimState(claimId);
    advanceMs(60 * 1_000);

    const { receipt } = await respond("我明确允许你重新记住我住在上海。", {
      actionKind: "memory_forget_reversal",
      arguments: { targetAnchor: "我住在上海" },
      reply: "你已经明确允许我重新记住这件事了。",
    });
    expect(receipt).toMatchObject({
      admission: "accepted",
      disposition: "committed_in_transaction",
      execution: "succeeded",
    });
    const execution = await executionRow(receipt!.actionExecutionId);
    expect(execution).toMatchObject({
      resolved_claim_id: claimId,
      target_kind: "memory_claim",
      resolved_qualifier_id: null,
    });
    const restored = await claimState(claimId);
    expect(restored).toMatchObject({
      createdBy: "forget_reversal",
      currentStatus: "active",
    });
    expect(restored.currentVersionId).not.toBe(fenced.currentVersionId);

    const currentEvidence = await database.pool.query<{
      evidence_item_id: string;
      extraction_policy_version: string;
      source_revision_id: string;
    }>(
      `SELECT link.evidence_item_id::text,
              item.extraction_policy_version,
              item.source_revision_id::text
       FROM claim_evidence_links link
       JOIN evidence_items item
         ON item.evidence_item_id = link.evidence_item_id
        AND item.user_id = link.user_id
       WHERE link.user_id = $1 AND link.memory_claim_version_id = $2
         AND link.status = 'active'`,
      [OWNER, restored.currentVersionId],
    );
    expect(currentEvidence.rows).toHaveLength(1);
    expect(currentEvidence.rows[0]!.extraction_policy_version).toBe(
      "memory-forget-reversal:v1",
    );
    expect(currentEvidence.rows[0]!.evidence_item_id).not.toBe(
      originalEvidence.rows[0]!.evidence_item_id,
    );
    expect(currentEvidence.rows[0]!.source_revision_id).toBe(
      execution.request_event_revision_id,
    );

    const oldExclusion = await database.pool.query(
      `SELECT 1
       FROM memory_forget_evidence_exclusions exclusion
       JOIN memory_forget_requests request
         ON request.memory_forget_request_id = exclusion.memory_forget_request_id
       WHERE request.user_id = $1 AND request.target_claim_id = $2
         AND exclusion.exclusion_scope = 'whole_claim'
         AND exclusion.status = 'active'`,
      [OWNER, claimId],
    );
    expect(oldExclusion.rowCount).toBe(1);
    const versions = await database.pool.query<{
      created_by: string;
      status: string;
    }>(
      `SELECT created_by, status FROM memory_claim_versions
       WHERE user_id = $1 AND memory_claim_id = $2
       ORDER BY revision`,
      [OWNER, claimId],
    );
    expect(versions.rows.map((row) => [row.created_by, row.status])).toEqual([
      ["consolidation", "active"],
      ["forget_request", "retracted"],
      ["forget_reversal", "active"],
    ]);
    const reversal = await database.pool.query(
      `SELECT 1 FROM memory_forget_reversals
       WHERE user_id = $1 AND memory_forget_request_id = (
         SELECT memory_forget_request_id FROM memory_forget_requests
         WHERE user_id = $1 AND target_claim_id = $2
       ) AND status = 'active' AND applied_claim_version_id = $3`,
      [OWNER, claimId, restored.currentVersionId],
    );
    expect(reversal.rowCount).toBe(1);
  });

  it("does not reverse an active target without a Forget fence", async () => {
    const claimId = await seedResidenceClaim("我住在上海。");
    const before = await claimState(claimId);
    advanceMs(60 * 1_000);

    const { receipt, replyText } = await respond(
      "我明确允许你重新记住我住在上海。",
      {
        actionKind: "memory_forget_reversal",
        arguments: { targetAnchor: "我住在上海" },
        reply: "我没有找到一条目前被忘掉的记忆，因此没有恢复任何内容。",
      },
    );

    expect(receipt).toMatchObject({
      admission: "clarification_required",
      disposition: "target_not_fenced",
      execution: "not_started",
    });
    expect(replyText).toContain("没有找到");
    expect(await claimState(claimId)).toMatchObject({
      currentVersionId: before.currentVersionId,
      currentStatus: "active",
    });
    const reversals = await database.pool.query(
      `SELECT 1 FROM memory_forget_reversals
       WHERE user_id = $1 AND status = 'active'`,
      [OWNER],
    );
    expect(reversals.rowCount).toBe(0);
  });

  it("forgets one relationship Qualifier, keeps neutral relationship recall, and fences re-learning", async () => {
    const fixture = await seedRelativeClaim();
    const originalQualifiers = await currentQualifiers(fixture.claimId);
    expect(originalQualifiers).toHaveLength(1);
    const originalQualifier = originalQualifiers[0]!;
    advanceMs(60 * 1_000);

    const { receipt } = await respond("请忘掉小明是我姑姑这个称谓。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "姑姑" },
      reply: "好，我不会再使用这个具体称谓，但会保留中性的关系。",
    });
    expect(receipt).toMatchObject({
      admission: "accepted",
      disposition: "committed_in_transaction",
      execution: "succeeded",
    });
    const execution = await executionRow(receipt!.actionExecutionId);
    expect(execution).toMatchObject({
      resolved_claim_id: fixture.claimId,
      target_kind: "relationship_qualifier",
      resolved_qualifier_id: originalQualifier.id,
    });
    const afterForget = await claimState(fixture.claimId);
    expect(afterForget.currentStatus).toBe("active");
    expect(await currentQualifiers(fixture.claimId)).toHaveLength(0);
    const hints = await currentRelationshipHints(fixture.claimId);
    expect(hints).toHaveLength(4);
    expect(
      hints.every(
        (hint) =>
          hint.roleAxisId === "kinship_term" &&
          hint.roleSource === "neutral_fallback" &&
          hint.roleTerm === (hint.locale === "zh" ? "亲戚" : "relative") &&
          hint.versionId === afterForget.currentVersionId,
      ),
    ).toBe(true);
    const request = await database.pool.query<{
      canonical_side: string;
      qualifier_key: string;
      target_qualifier_id: string;
    }>(
      `SELECT canonical_side, qualifier_key, target_qualifier_id::text
       FROM memory_forget_requests
       WHERE user_id = $1 AND target_claim_id = $2`,
      [OWNER, fixture.claimId],
    );
    expect(request.rows).toEqual([
      expect.objectContaining({
        qualifier_key: "kinship_term",
        target_qualifier_id: originalQualifier.id,
      }),
    ]);

    advanceMs(60 * 1_000);
    const repeated = await respond("再忘掉姑姑这个称谓。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "姑姑" },
      reply: "这个称谓已经不再使用了。",
    });
    expect(repeated.receipt).toMatchObject({
      admission: "accepted",
      disposition: "succeeded_noop",
      execution: "succeeded",
    });
    expect((await claimState(fixture.claimId)).currentVersionId).toBe(
      afterForget.currentVersionId,
    );

    const newRevisionId = await submitTurn("小明仍然是我的亲戚。");
    const newEvidenceId = await seedEvidence(newRevisionId);
    const blocked = await recordAndAdmit({
      basis: "directly_stated",
      evidenceItemIds: [newEvidenceId],
      kind: "objective",
      objectEntityId: fixture.objectEntityId,
      predicateId: "sh.relationship.relative_of",
      qualifiers: [
        {
          axisId: "kinship_term",
          roleSide: "object",
          typedValue: "姑姑",
          evidenceItemIds: [newEvidenceId],
        },
      ],
      typedValue: "",
    });
    expect(blocked).toEqual({
      outcome: "not_promoted",
      outcomeCode: "blocked_forget_fence",
    });

    // Qualifier-scoped Evidence cannot be repurposed as an independent neutral
    // relationship source; only Evidence outside the Forget scope may keep the
    // base relationship alive (ADR-0034).
    const neutralOldEvidenceReuse = await recordAndAdmit({
      basis: "directly_stated",
      evidenceItemIds: [fixture.evidenceId],
      kind: "objective",
      objectEntityId: fixture.objectEntityId,
      predicateId: "sh.relationship.relative_of",
      typedValue: "",
    });
    expect(neutralOldEvidenceReuse).toEqual({
      outcome: "not_promoted",
      outcomeCode: "blocked_forget_fence",
    });
  });

  it("retracts the whole relationship when the forgotten Qualifier was its only Evidence", async () => {
    const fixture = await seedRelativeClaim({ independentBaseEvidence: false });
    advanceMs(60 * 1_000);

    const { receipt } = await respond("请忘掉小明是我姑姑这个称谓。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "姑姑" },
      reply: "好，这条关系没有其他独立依据，我也不会再保留它。",
    });
    expect(receipt).toMatchObject({
      admission: "accepted",
      disposition: "committed_in_transaction",
      execution: "succeeded",
    });
    const state = await claimState(fixture.claimId);
    expect(state.currentStatus).toBe("retracted");
    expect(state.projectionStatuses.every((status) => status === "deleted")).toBe(
      true,
    );
    expect(await currentQualifiers(fixture.claimId)).toHaveLength(0);
    expect(await currentRelationshipHints(fixture.claimId)).toHaveLength(0);

    advanceMs(60 * 1_000);
    const repeated = await respond("再忘掉姑姑这个称谓。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "姑姑" },
      reply: "这个称谓已经不再使用了。",
    });
    expect(repeated.receipt).toMatchObject({
      admission: "accepted",
      disposition: "succeeded_noop",
      execution: "succeeded",
    });
  });

  it("fences Evidence from historical versions of the forgotten Qualifier role", async () => {
    const fixture = await seedRelativeClaim();
    const revisedRevisionId = await submitTurn("小明是我的侄子。");
    const revisedEvidenceId = await seedEvidence(revisedRevisionId);
    const revised = await recordAndAdmit({
      basis: "directly_stated",
      evidenceItemIds: [revisedEvidenceId],
      kind: "objective",
      objectEntityId: fixture.objectEntityId,
      predicateId: "sh.relationship.relative_of",
      qualifiers: [
        {
          axisId: "kinship_term",
          roleSide: "object",
          typedValue: "侄子",
          evidenceItemIds: [revisedEvidenceId],
        },
      ],
      typedValue: "",
    });
    expect(revised.outcome).toBe("promoted");
    expect((await currentQualifiers(fixture.claimId))[0]).toMatchObject({
      typedValue: "侄子",
      evidenceItemIds: [revisedEvidenceId],
    });

    advanceMs(60 * 1_000);
    const { receipt } = await respond("请忘掉侄子这个称谓。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "侄子" },
      reply: "好，我不会再使用这个具体称谓。",
    });
    expect(receipt).toMatchObject({
      admission: "accepted",
      disposition: "committed_in_transaction",
      execution: "succeeded",
    });

    const historicalQualifierReuse = await recordAndAdmit({
      basis: "directly_stated",
      evidenceItemIds: [fixture.evidenceId],
      kind: "objective",
      objectEntityId: fixture.objectEntityId,
      predicateId: "sh.relationship.relative_of",
      qualifiers: [
        {
          axisId: "kinship_term",
          roleSide: "object",
          typedValue: "姑姑",
          evidenceItemIds: [fixture.evidenceId],
        },
      ],
      typedValue: "",
    });
    expect(historicalQualifierReuse).toEqual({
      outcome: "not_promoted",
      outcomeCode: "blocked_forget_fence",
    });
  });

  it("reverses a forgotten Qualifier with new Evidence while retaining the old exclusion", async () => {
    const fixture = await seedRelativeClaim();
    const originalQualifier = (await currentQualifiers(fixture.claimId))[0]!;
    advanceMs(60 * 1_000);
    await respond("请忘掉姑姑这个称谓。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "姑姑" },
      reply: "好。",
    });
    advanceMs(60 * 1_000);

    const { receipt } = await respond("我明确允许你重新使用姑姑这个称谓。", {
      actionKind: "memory_forget_reversal",
      arguments: { targetAnchor: "姑姑" },
      reply: "你已经明确允许我重新使用这个称谓了。",
    });
    expect(receipt).toMatchObject({
      admission: "accepted",
      disposition: "committed_in_transaction",
      execution: "succeeded",
    });
    const execution = await executionRow(receipt!.actionExecutionId);
    expect(execution).toMatchObject({
      target_kind: "relationship_qualifier",
      resolved_qualifier_id: originalQualifier.id,
    });
    const current = await claimState(fixture.claimId);
    expect(current.currentStatus).toBe("active");
    const qualifiers = await currentQualifiers(fixture.claimId);
    expect(qualifiers).toHaveLength(1);
    expect(qualifiers[0]).toMatchObject({
      axisId: "kinship_term",
      typedValue: "姑姑",
    });
    expect(qualifiers[0]!.id).not.toBe(originalQualifier.id);
    expect(qualifiers[0]!.evidenceItemIds).not.toContain(fixture.evidenceId);
    const oldQualifier = await database.pool.query(
      `SELECT 1 FROM memory_claim_version_qualifiers
       WHERE user_id = $1 AND memory_claim_version_qualifier_id = $2`,
      [OWNER, originalQualifier.id],
    );
    expect(oldQualifier.rowCount).toBe(1);
    const exclusion = await database.pool.query(
      `SELECT 1 FROM memory_forget_evidence_exclusions exclusion
       JOIN memory_forget_requests request
         ON request.memory_forget_request_id = exclusion.memory_forget_request_id
       WHERE request.user_id = $1 AND request.target_claim_id = $2
         AND exclusion.exclusion_scope = 'relationship_qualifier'
         AND exclusion.status = 'active'`,
      [OWNER, fixture.claimId],
    );
    expect(exclusion.rowCount).toBe(1);
    const reversal = await database.pool.query(
      `SELECT 1 FROM memory_forget_reversals
       WHERE user_id = $1 AND status = 'active'
         AND applied_claim_version_id = $2`,
      [OWNER, current.currentVersionId],
    );
    expect(reversal.rowCount).toBe(1);

    const oldEvidenceReuse = await recordAndAdmit({
      basis: "directly_stated",
      evidenceItemIds: [fixture.evidenceId],
      kind: "objective",
      objectEntityId: fixture.objectEntityId,
      predicateId: "sh.relationship.relative_of",
      qualifiers: [
        {
          axisId: "kinship_term",
          roleSide: "object",
          typedValue: "姑姑",
          evidenceItemIds: [fixture.evidenceId],
        },
      ],
      typedValue: "",
    });
    expect(oldEvidenceReuse).toEqual({
      outcome: "not_promoted",
      outcomeCode: "blocked_forget_fence",
    });
  });

  it("clarifies whole-vs-Qualifier scope and rejects person-wide Forget honestly", async () => {
    const fixture = await seedRelativeClaim();
    advanceMs(60 * 1_000);
    const ambiguous = await respond("请处理小明的亲戚记忆。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "小明的亲戚" },
      reply: "你是要忘掉整段关系，还是只忘掉具体称谓？",
    });
    expect(ambiguous.receipt).toMatchObject({
      admission: "clarification_required",
      disposition: "scope_ambiguous",
      execution: "not_started",
    });
    expect(await currentQualifiers(fixture.claimId)).toHaveLength(1);
    const requestsBeforeUnsupported = await database.pool.query(
      `SELECT 1 FROM memory_forget_requests
       WHERE user_id = $1 AND target_claim_id = $2`,
      [OWNER, fixture.claimId],
    );
    expect(requestsBeforeUnsupported.rowCount).toBe(0);

    advanceMs(60 * 1_000);
    const unsupported = await respond("请忘掉所有记忆。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "所有记忆" },
      reply: "我现在不支持一次忘掉所有人的全部记忆；你可以告诉我具体是哪一条。",
    });
    expect(unsupported.receipt).toMatchObject({
      admission: "unsupported",
      disposition: "person_wide_unsupported",
      execution: "not_started",
    });
    const requestsAfterUnsupported = await database.pool.query(
      `SELECT 1 FROM memory_forget_requests
       WHERE user_id = $1 AND target_claim_id = $2`,
      [OWNER, fixture.claimId],
    );
    expect(requestsAfterUnsupported.rowCount).toBe(0);
  });
});

/**
 * SPEC #292 / issue #293: the recent-source adapter must associate source
 * revisions with the existing explicit Correction / Forget records, and the
 * real repository must persist, load and replay the frozen recent refs.
 */
describe("Recent context source explicit trust-control mapping (#293)", () => {
  // This suite wires the looser #293 test policy through the compiler, so it
  // needs a governance row that names that policy, not the production default
  // seeded by the outer beforeEach.
  beforeEach(async () => {
    await seedRecentContextGovernance(RECENT_CONTEXT_POLICY);
  });

  async function loadRecentSource(frozenAt: Date = clock()) {
    const window = resolveRecentContextWindow({
      frozenAt,
      timezone: "Asia/Shanghai",
      windowDays: RECENT_CONTEXT_POLICY.windowDays,
    });
    const session = await database.pool.query<{ daily_session_id: string }>(
      `SELECT daily_session_id::text FROM daily_sessions
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [OWNER],
    );
    return new PostgresRecentContextSource(database.pool).loadRecentContextSource({
      budgets: RECENT_CONTEXT_POLICY.budgets,
      cutoff: {
        currentInputRevisionId: null,
        currentInputSequence: null,
        dailySessionId: null,
        expressedAt: frozenAt.toISOString(),
      },
      currentDailySessionId: asDailySessionId(
        session.rows[0]!.daily_session_id,
      ),
      excludeRevisionIds: [],
      expectedDataEpoch: 1,
      frozenAt,
      policyVersion: RECENT_CONTEXT_POLICY.version,
      selectorVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
      timezone: "Asia/Shanghai",
      userId: OWNER,
      windowEndLocalDate: window.windowEndLocalDate,
      windowStartLocalDate: window.windowStartLocalDate,
    });
  }

  it("maps whole-Claim Forget, Correction and Qualifier Forget evidence to explicit controls", async () => {
    // Whole-Claim Forget through the real trust-action path.
    const forgottenClaim = await seedResidenceClaim("我住在上海。");
    const forgottenEvidence = await database.pool.query<{
      source_revision_id: string;
    }>(
      `SELECT item.source_revision_id::text AS source_revision_id
       FROM claim_evidence_links link
       INNER JOIN evidence_items item
         ON item.evidence_item_id = link.evidence_item_id
        AND item.user_id = link.user_id
       WHERE link.user_id = $1
         AND link.memory_claim_version_id = (
           SELECT current_version_id FROM memory_claims
           WHERE user_id = $1 AND memory_claim_id = $2
         )
         AND link.status = 'active'
       LIMIT 1`,
      [OWNER, forgottenClaim],
    );
    const forgottenRevision = forgottenEvidence.rows[0]!.source_revision_id;
    advanceMs(60 * 1_000);
    await respond("请忘掉我住在上海。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "我住在上海" },
      reply: "好，我不会再把这件事作为记忆提起。",
    });
    const forgetRequest = await database.pool.query<{
      memory_forget_request_id: string;
    }>(
      `SELECT memory_forget_request_id::text AS memory_forget_request_id
       FROM memory_forget_requests
       WHERE user_id = $1 AND target_claim_id = $2`,
      [OWNER, forgottenClaim],
    );
    const forgetRequestId =
      forgetRequest.rows[0]!.memory_forget_request_id;
    const afterForget = await loadRecentSource();
    expect(afterForget.failure).toBeNull();
    expect(
      afterForget.items.find(
        (candidate) => String(candidate.revisionId) === forgottenRevision,
      )?.exclusion,
    ).toEqual({ controlId: forgetRequestId, reason: "forget_association" });

    // A real relationship-Qualifier Forget maps its qualifier evidence too.
    const relative = await seedRelativeClaim({ label: "小刚" });
    advanceMs(60 * 1_000);
    await respond("请忘掉小刚是我姑姑这个称谓。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "姑姑" },
      reply: "好，我保留中性的关系。",
    });
    const qualifierForget = await database.pool.query<{
      memory_forget_request_id: string;
    }>(
      `SELECT memory_forget_request_id::text AS memory_forget_request_id
       FROM memory_forget_requests
       WHERE user_id = $1 AND target_claim_id = $2`,
      [OWNER, relative.claimId],
    );
    const afterQualifier = await loadRecentSource();
    expect(
      afterQualifier.items.find(
        (candidate) => String(candidate.revisionId) === relative.revisionId,
      )?.exclusion,
    ).toEqual({
      controlId: qualifierForget.rows[0]!.memory_forget_request_id,
      reason: "forget_association",
    });

    // A real Correction row deactivating a ClaimVersion maps its evidence.
    const corrected = await seedRelativeClaim({ label: "小红" });
    const correctedVersion = await database.pool.query<{
      current_version_id: string;
      source_revision_id: string;
    }>(
      `SELECT claim.current_version_id::text AS current_version_id,
              item.source_revision_id::text AS source_revision_id
       FROM memory_claims claim
       INNER JOIN claim_evidence_links link
         ON link.memory_claim_version_id = claim.current_version_id
        AND link.user_id = claim.user_id
        AND link.status = 'active'
       INNER JOIN evidence_items item
         ON item.evidence_item_id = link.evidence_item_id
        AND item.user_id = link.user_id
       WHERE claim.user_id = $1 AND claim.memory_claim_id = $2
       LIMIT 1`,
      [OWNER, corrected.claimId],
    );
    const correctionId = createTestUuidV7(clock());
    await database.pool.query(
      `INSERT INTO memory_claim_corrections (
         memory_claim_correction_id, user_id, request_event_revision_id,
         target_claim_id, deactivated_claim_version_id, target_scope,
         corrected_fact_recorded, correction_policy_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'whole_claim', FALSE,
         'memory-correction:v1', $6)`,
      [
        correctionId,
        OWNER,
        correctedVersion.rows[0]!.source_revision_id,
        corrected.claimId,
        correctedVersion.rows[0]!.current_version_id,
        clock(),
      ],
    );
    const afterCorrection = await loadRecentSource();
    expect(
      afterCorrection.items.find(
        (candidate) =>
          String(candidate.revisionId) ===
          correctedVersion.rows[0]!.source_revision_id,
      )?.exclusion,
    ).toEqual({
      controlId: correctionId,
      reason: "correction_association",
    });
  });

  it("persists and replays a real frozen recent section without restoring excluded facts", async () => {
    const claimId = await seedResidenceClaim("我住在上海。");
    const evidence = await database.pool.query<{ source_revision_id: string }>(
      `SELECT item.source_revision_id::text AS source_revision_id
       FROM claim_evidence_links link
       INNER JOIN evidence_items item
         ON item.evidence_item_id = link.evidence_item_id
        AND item.user_id = link.user_id
       WHERE link.user_id = $1
         AND link.memory_claim_version_id = (
           SELECT current_version_id FROM memory_claims
           WHERE user_id = $1 AND memory_claim_id = $2
         )
         AND link.status = 'active'
       LIMIT 1`,
      [OWNER, claimId],
    );
    const forbiddenRevision = evidence.rows[0]!.source_revision_id;
    advanceMs(60 * 1_000);
    await respond("请忘掉我住在上海。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "我住在上海" },
      reply: "好，我不会再提起。",
    });
    // Move to a finalized prior Session so the excluded source is cross-day.
    advanceMs(DAY_MS);
    expect(await quiesceActiveSession()).toBe(true);

    const renderedPayloads: { role: string; text: string }[][] = [];
    const { replyText } = await respond(
      "今天我们聊点别的。",
      {
        onStream: (request) => {
          renderedPayloads.push(
            request.messages.map((message) => ({
              role: message.role,
              text: message.text,
            })),
          );
        },
        reply: "好呀，我在听。",
      },
      createContextCompilerWithRecentSource(),
    );
    expect(replyText.length).toBeGreaterThan(0);

    const compiledContextId = await loadLatestCompiledContextId();
    const context = await database.pool.query<{
      sections: readonly { key: string; reference: string }[];
    }>(
      `SELECT sections FROM compiled_contexts
       WHERE user_id = $1 AND compiled_context_id = $2`,
      [OWNER, compiledContextId],
    );
    const recentSection = context.rows[0]!.sections.find(
      (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
    );
    expect(recentSection).toBeDefined();
    const decoded = decodeRecentContextReference(recentSection!.reference);
    expect(
      decoded.selected.map((selected) => selected.revisionId),
    ).not.toContain(forbiddenRevision);
    expect(decoded.omitted).toContainEqual(
      expect.objectContaining({
        reason: "explicit_control",
        revisionId: forbiddenRevision,
      }),
    );

    // The real claimDispatch -> renderPermittedPayload egress path re-read the
    // frozen reference and re-rendered the same selection (HMAC validated).
    const payload = renderedPayloads.find(
      (messages) => messages.at(-1)?.text === "今天我们聊点别的。",
    );
    expect(payload).toBeDefined();
    const selectedTexts = await database.pool.query<{ text: string }>(
      `SELECT canonical_text AS text
       FROM conversation_event_revisions
       WHERE user_id = $1
         AND conversation_event_revision_id = ANY($2::uuid[])`,
      [OWNER, decoded.selected.map((selected) => selected.revisionId)],
    );
    expect(selectedTexts.rows.length).toBe(decoded.selected.length);
    const renderedTexts = payload!.map((message) => message.text);
    for (const selected of selectedTexts.rows) {
      expect(renderedTexts).toContain(selected.text);
    }
    const forbiddenText = await database.pool.query<{ text: string }>(
      `SELECT canonical_text AS text
       FROM conversation_event_revisions
       WHERE user_id = $1 AND conversation_event_revision_id = $2`,
      [OWNER, forbiddenRevision],
    );
    expect(renderedTexts).not.toContain(forbiddenText.rows[0]!.text);
    expect(payload!.at(-1)).toMatchObject({
      role: "user",
      text: "今天我们聊点别的。",
    });

    const refs = await database.pool.query<{
      daily_session_id: string | null;
      expressed_at: Date | null;
      selection_reason: string | null;
      selection_order: number | null;
    }>(
      `SELECT daily_session_id::text, expressed_at, selection_reason,
              selection_order
       FROM compiled_context_revision_refs
       WHERE compiled_context_id = $1
         AND section = 'recent_conversation_context'
       ORDER BY ordinal`,
      [compiledContextId],
    );
    expect(refs.rows).toHaveLength(decoded.selected.length);
    for (const ref of refs.rows) {
      expect(ref.daily_session_id).not.toBeNull();
      expect(ref.expressed_at).not.toBeNull();
      expect(ref.selection_reason).not.toBeNull();
      expect(ref.selection_order).not.toBeNull();
    }

    // The same frozen selection replayed through the selector restores no
    // fact from the excluded user or its adjacent assistant.
    const replayed = selectRecentContext({
      cutoff: {
        currentInputRevisionId:
          decoded.cutoff.currentInputRevisionId === null
            ? null
            : asConversationEventRevisionId(
                decoded.cutoff.currentInputRevisionId,
              ),
        currentInputSequence: decoded.cutoff.currentInputSequence,
        dailySessionId:
          decoded.cutoff.dailySessionId === null
            ? null
            : asDailySessionId(decoded.cutoff.dailySessionId),
        expressedAt: decoded.cutoff.expressedAt,
      },
      excludeRevisionIds: [],
      frozenAt: clock(),
      items: (await loadRecentSource()).items,
      policy: RECENT_CONTEXT_POLICY,
      timezone: "Asia/Shanghai",
      windowEndLocalDate: decoded.windowEndLocalDate,
      windowStartLocalDate: decoded.windowStartLocalDate,
    });
    expect(
      replayed.selected.map((selected) => String(selected.revisionId)),
    ).not.toContain(forbiddenRevision);

    // The migrated schema itself rejects missing / invalid / cross-owner /
    // session-mismatched recent metadata, not only the application layer.
    const forbiddenSession = (
      await database.pool.query<{ daily_session_id: string }>(
        `SELECT event.daily_session_id::text AS daily_session_id
         FROM conversation_event_revisions revision
         INNER JOIN conversation_events event
           ON event.conversation_event_id = revision.conversation_event_id
          AND event.user_id = revision.user_id
         WHERE revision.user_id = $1
           AND revision.conversation_event_revision_id = $2`,
        [OWNER, forbiddenRevision],
      )
    ).rows[0]!.daily_session_id;
    const otherOwnerSession = (
      await database.pool.query<{ daily_session_id: string }>(
        `SELECT daily_session_id::text AS daily_session_id
         FROM daily_sessions
         WHERE user_id = $1 AND daily_session_id <> $2
         ORDER BY started_at
         LIMIT 1`,
        [OWNER, forbiddenSession],
      )
    ).rows[0]!.daily_session_id;

    const attempt = (input: {
      dailySessionId: string;
      ordinal: number;
      selectionReason: string | null;
    }) =>
      expectPgRejection(RECENT_REF_INSERT, [
        compiledContextId,
        OWNER,
        forbiddenRevision,
        input.ordinal,
        0,
        input.dailySessionId,
        clock(),
        input.selectionReason,
      ]);
    expect(
      await attempt({
        dailySessionId: forbiddenSession,
        ordinal: 900,
        selectionReason: null,
      }),
    ).toBe("23514");
    expect(
      await attempt({
        dailySessionId: forbiddenSession,
        ordinal: 901,
        selectionReason: "not_a_reason",
      }),
    ).toBe("23514");

    // A session that belongs to another owner fails the composite owner FK.
    const foreignOwner = createTestUuidV7(clock());
    await database.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [foreignOwner, clock()],
    );
    const foreignSession = createTestUuidV7(clock());
    await database.pool.query(
      `INSERT INTO daily_sessions (
         daily_session_id, user_id, logical_date, timezone_at_start,
         started_at, last_activity_at, created_at, updated_at
       ) VALUES ($1, $2, '2026-08-20', 'Asia/Shanghai', $3, $3, $3, $3)`,
      [foreignSession, foreignOwner, clock()],
    );
    expect(
      await attempt({
        dailySessionId: foreignSession,
        ordinal: 902,
        selectionReason: "today",
      }),
    ).toMatch(/^23/);

    // The same owner's other session is valid lineage but not the revision's
    // session, so the trigger rejects it.
    expect(
      await attempt({
        dailySessionId: otherOwnerSession,
        ordinal: 903,
        selectionReason: "today",
      }),
    ).toBe("23514");
  });

  it("fails closed on tampered recent metadata or HMAC through real persistence", async () => {
    await seedResidenceClaim("我住在上海。");
    advanceMs(DAY_MS);
    expect(await quiesceActiveSession()).toBe(true);

    const compileFreshTurn = async () => {
      counter += 1;
      const turn = await conversationService.submit(OWNER, {
        clientEventId: `trust-tamper-event-${counter}`,
        clientTurnId: `trust-tamper-turn-${counter}`,
        locale: "zh-CN",
        text: "今天我们聊点别的。",
        timezone: "Asia/Shanghai",
      });
      expect(
        await responseRepository.claimResponseExecution({
          generationCommandId: turn.generation.commandId,
          modelRunAttemptId: turn.generation.attemptId,
          userId: OWNER,
        }),
      ).toBe("owner");
      const compiler = createContextCompilerWithRecentSource();
      const compiled = await compiler.compile({
        generationCommandId: turn.generation.commandId,
        interactionTurnId: turn.turn.id,
        userId: OWNER,
      });
      return { compiled, compiler, turn };
    };
    const sectionsOf = async (compiledContextId: string) =>
      (
        await database.pool.query<{
          sections: readonly { key: string; reference: string }[];
        }>(
          `SELECT sections FROM compiled_contexts
           WHERE user_id = $1 AND compiled_context_id = $2`,
          [OWNER, compiledContextId],
        )
      ).rows[0]!.sections;

    // A malformed frozen recent reference fails closed even though the row
    // loaded and the HMAC was untouched.
    const metadataTurn = await compileFreshTurn();
    const metadataSections = await sectionsOf(metadataTurn.compiled.id);
    expect(
      metadataSections.some(
        (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
      ),
    ).toBe(true);
    await database.pool.query(
      `UPDATE compiled_contexts SET sections = $3::jsonb
       WHERE user_id = $1 AND compiled_context_id = $2`,
      [
        OWNER,
        metadataTurn.compiled.id,
        JSON.stringify(
          metadataSections.map((section) =>
            section.key === RECENT_CONTEXT_SECTION_KEY
              ? { ...section, reference: `${section.reference}corrupt` }
              : section,
          ),
        ),
      ],
    );
    const metadataClaim = await responseRepository.claimDispatch({
      champion: testChampion,
      compiledContextId: asCompiledContextId(metadataTurn.compiled.id),
      generationCommandId: metadataTurn.turn.generation.commandId,
      modelRunAttemptId: metadataTurn.turn.generation.attemptId,
      now: clock(),
    });
    expect(metadataClaim.outcome).toBe("permitted");
    if (metadataClaim.outcome !== "permitted") {
      throw new Error("Expected the metadata-tampered claim to be permitted.");
    }
    expect(() =>
      metadataTurn.compiler.renderPermittedPayload(metadataClaim.context),
    ).toThrow(CompiledContextIntegrityError);

    // A tampered manifest HMAC fails closed too.
    const hmacTurn = await compileFreshTurn();
    await database.pool.query(
      `UPDATE compiled_contexts SET content_hmac = 'tampered'
       WHERE user_id = $1 AND compiled_context_id = $2`,
      [OWNER, hmacTurn.compiled.id],
    );
    const hmacClaim = await responseRepository.claimDispatch({
      champion: testChampion,
      compiledContextId: asCompiledContextId(hmacTurn.compiled.id),
      generationCommandId: hmacTurn.turn.generation.commandId,
      modelRunAttemptId: hmacTurn.turn.generation.attemptId,
      now: clock(),
    });
    expect(hmacClaim.outcome).toBe("permitted");
    if (hmacClaim.outcome !== "permitted") {
      throw new Error("Expected the HMAC-tampered claim to be permitted.");
    }
    expect(() =>
      hmacTurn.compiler.renderPermittedPayload(hmacClaim.context),
    ).toThrow(CompiledContextIntegrityError);
  });

  it("keeps a Forgot revision excluded from recent context after a real Reversal", async () => {
    const claimId = await seedResidenceClaim("我住在上海。");
    const evidence = await database.pool.query<{ source_revision_id: string }>(
      `SELECT item.source_revision_id::text AS source_revision_id
       FROM claim_evidence_links link
       INNER JOIN evidence_items item
         ON item.evidence_item_id = link.evidence_item_id
        AND item.user_id = link.user_id
       WHERE link.user_id = $1
         AND link.memory_claim_version_id = (
           SELECT current_version_id FROM memory_claims
           WHERE user_id = $1 AND memory_claim_id = $2
         )
         AND link.status = 'active'
       LIMIT 1`,
      [OWNER, claimId],
    );
    const forgottenRevision = evidence.rows[0]!.source_revision_id;
    advanceMs(60 * 1_000);
    await respond("请忘掉我住在上海。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "我住在上海" },
      reply: "好，我不会再把这件事作为记忆提起。",
    });
    advanceMs(60 * 1_000);
    const { receipt } = await respond("我明确允许你重新记住我住在上海。", {
      actionKind: "memory_forget_reversal",
      arguments: { targetAnchor: "我住在上海" },
      reply: "你已经明确允许我重新记住这件事了。",
    });
    expect(receipt).toMatchObject({
      admission: "accepted",
      disposition: "committed_in_transaction",
      execution: "succeeded",
    });

    const afterReversal = await loadRecentSource();
    expect(afterReversal.failure).toBeNull();
    expect(
      afterReversal.items.find(
        (candidate) => String(candidate.revisionId) === forgottenRevision,
      )?.exclusion,
    ).toMatchObject({ reason: "forget_association" });

    const window = resolveRecentContextWindow({
      frozenAt: clock(),
      timezone: "Asia/Shanghai",
      windowDays: RECENT_CONTEXT_POLICY.windowDays,
    });
    const selected = selectRecentContext({
      cutoff: {
        currentInputRevisionId: null,
        currentInputSequence: null,
        dailySessionId: null,
        expressedAt: clock().toISOString(),
      },
      excludeRevisionIds: [],
      frozenAt: clock(),
      items: afterReversal.items,
      policy: RECENT_CONTEXT_POLICY,
      timezone: "Asia/Shanghai",
      windowEndLocalDate: window.windowEndLocalDate,
      windowStartLocalDate: window.windowStartLocalDate,
    });
    expect(
      selected.selected.map((candidate) => String(candidate.revisionId)),
    ).not.toContain(forgottenRevision);
    expect(selected.omitted).toContainEqual(
      expect.objectContaining({
        reason: "explicit_control",
        revisionId: forgottenRevision,
      }),
    );
  });

  it("keeps the same frozen recent selection when the same command compiles again", async () => {
    await seedResidenceClaim("我住在上海。");
    advanceMs(DAY_MS);
    expect(await quiesceActiveSession()).toBe(true);

    counter += 1;
    const turn = await conversationService.submit(OWNER, {
      clientEventId: `trust-idempotency-event-${counter}`,
      clientTurnId: `trust-idempotency-turn-${counter}`,
      locale: "zh-CN",
      text: "今天我们聊点别的。",
      timezone: "Asia/Shanghai",
    });
    expect(
      await responseRepository.claimResponseExecution({
        generationCommandId: turn.generation.commandId,
        modelRunAttemptId: turn.generation.attemptId,
        userId: OWNER,
      }),
    ).toBe("owner");

    const compiler = createContextCompilerWithRecentSource();
    const compileInput = {
      generationCommandId: turn.generation.commandId,
      interactionTurnId: turn.turn.id,
      userId: OWNER,
    } as const;
    const first = await compiler.compile(compileInput);
    const firstSections = await database.pool.query<{
      sections: readonly { key: string; reference: string }[];
    }>(
      `SELECT sections FROM compiled_contexts
       WHERE user_id = $1 AND compiled_context_id = $2`,
      [OWNER, first.id],
    );

    // A retry clock far ahead of the admitted command must not re-select.
    advanceMs(5 * 60 * 1_000);
    const second = await compiler.compile(compileInput);
    expect(second.id).toBe(first.id);
    expect(second.referencedRevisionIds).toEqual(first.referencedRevisionIds);

    const compiledRows = await database.pool.query(
      `SELECT 1 FROM compiled_contexts
       WHERE user_id = $1 AND generation_command_id = $2`,
      [OWNER, turn.generation.commandId],
    );
    expect(compiledRows.rowCount).toBe(1);
    const secondSections = await database.pool.query<{
      sections: readonly { key: string; reference: string }[];
    }>(
      `SELECT sections FROM compiled_contexts
       WHERE user_id = $1 AND compiled_context_id = $2`,
      [OWNER, second.id],
    );
    expect(secondSections.rows[0]!.sections).toEqual(
      firstSections.rows[0]!.sections,
    );

    const command = await database.pool.query<{ created_at: Date }>(
      `SELECT created_at FROM generation_commands
       WHERE user_id = $1 AND generation_command_id = $2`,
      [OWNER, turn.generation.commandId],
    );
    const recentSection = firstSections.rows[0]!.sections.find(
      (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
    );
    expect(recentSection).toBeDefined();
    expect(
      decodeRecentContextReference(recentSection!.reference).cutoff.expressedAt,
    ).toBe(command.rows[0]!.created_at.toISOString());
  });
});

describe("Bounded recent context production wiring (#294)", () => {
  const productionSource = () => new PostgresRecentContextSource(database.pool);

  async function loadSource(
    overrides: {
      budgets?: RecentContextSourceRequest["budgets"];
      readTimeoutMs?: number;
    } = {},
  ) {
    const timezone = "Asia/Shanghai";
    const window = resolveRecentContextWindow({
      frozenAt: clock(),
      timezone,
      windowDays: RECENT_CONTEXT_DEFAULT_POLICY.windowDays,
    });
    return productionSource().loadRecentContextSource({
      budgets: {
        ...RECENT_CONTEXT_DEFAULT_POLICY.budgets,
        ...(overrides.readTimeoutMs === undefined
          ? {}
          : { readTimeoutMs: overrides.readTimeoutMs }),
        ...overrides.budgets,
      },
      cutoff: {
        currentInputRevisionId: null,
        currentInputSequence: null,
        dailySessionId: null,
        expressedAt: clock().toISOString(),
      },
      currentDailySessionId: asDailySessionId(createTestUuidV7(clock())),
      excludeRevisionIds: [],
      expectedDataEpoch: 1,
      frozenAt: clock(),
      policyVersion: RECENT_CONTEXT_DEFAULT_POLICY.version,
      selectorVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
      timezone,
      userId: OWNER,
      windowEndLocalDate: window.windowEndLocalDate,
      windowStartLocalDate: window.windowStartLocalDate,
    });
  }

  async function sectionsOf(compiledContextId: string) {
    return (
      await database.pool.query<{
        sections: readonly { key: string; reference: string }[];
      }>(
        `SELECT sections FROM compiled_contexts
         WHERE user_id = $1 AND compiled_context_id = $2`,
        [OWNER, compiledContextId],
      )
    ).rows[0]!.sections;
  }

  it("carries yesterday's experience into the next-day new session and the real Provider payload", async () => {
    const yesterdayRevision = await submitTurn("昨天我去公园跑步，心情很好。");
    advanceMs(DAY_MS);
    expect(await quiesceActiveSession()).toBe(true);

    const todayText = "今天想聊聊别的。";
    const rendered: { role: string; text: string }[][] = [];
    await respond(
      todayText,
      {
        onStream: (request) => {
          rendered.push(
            request.messages.map((message) => ({
              role: message.role,
              text: message.text,
            })),
          );
        },
        reply: "好啊，我在听。",
      },
      createContextCompilerWithProductionRecentSource(),
    );

    const compiledId = await loadLatestCompiledContextId();
    const recentSection = (await sectionsOf(compiledId)).find(
      (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
    );
    expect(recentSection).toBeDefined();
    const decoded = decodeRecentContextReference(recentSection!.reference);
    expect(decoded.selected.map((selected) => selected.revisionId)).toContain(
      yesterdayRevision,
    );

    // The egress payload actually rendered yesterday's user text as context,
    // before today's input, with no fabricated answer from yesterday.
    const yesterdayText = (
      await database.pool.query<{ text: string }>(
        `SELECT canonical_text AS text
         FROM conversation_event_revisions
         WHERE user_id = $1 AND conversation_event_revision_id = $2`,
        [OWNER, yesterdayRevision],
      )
    ).rows[0]!.text;
    const payload = rendered.find(
      (messages) => messages.at(-1)?.text === todayText,
    );
    expect(payload).toBeDefined();
    expect(payload!.map((message) => message.text)).toContain(yesterdayText);
    expect(payload!.at(-1)).toMatchObject({ role: "user", text: todayText });

    // The admitted command persists its request timezone.
    const command = await database.pool.query<{ request_timezone: string }>(
      `SELECT command.request_timezone
       FROM generation_commands command
       INNER JOIN compiled_contexts compiled
         ON compiled.generation_command_id = command.generation_command_id
        AND compiled.user_id = command.user_id
       WHERE compiled.user_id = $1 AND compiled.compiled_context_id = $2`,
      [OWNER, compiledId],
    );
    expect(command.rows[0]!.request_timezone).toBe("Asia/Shanghai");
  });

  it("uses the admitted request zone, not the session-start zone, for the window", async () => {
    const first = await conversationService.submit(OWNER, {
      clientEventId: "travel-event-1",
      clientTurnId: "travel-turn-1",
      locale: "zh-CN",
      text: "我在上海出发。",
      timezone: "Asia/Shanghai",
    });
    // 15.5h after 08:00Z is 2026-08-27T23:30Z: Shanghai is already the 28th
    // while Los Angeles is still the 27th.
    advanceMs(15.5 * 60 * 60 * 1_000);
    const second = await conversationService.submit(OWNER, {
      clientEventId: "travel-event-2",
      clientTurnId: "travel-turn-2",
      locale: "zh-CN",
      text: "我到洛杉矶了。",
      timezone: "America/Los_Angeles",
    });
    expect(String(second.dailySession.id)).toBe(String(first.dailySession.id));
    expect(second.dailySession.timezoneAtStart).toBe("Asia/Shanghai");

    const command = await database.pool.query<{ request_timezone: string }>(
      `SELECT request_timezone FROM generation_commands
       WHERE user_id = $1 AND generation_command_id = $2`,
      [OWNER, second.generation.commandId],
    );
    expect(command.rows[0]!.request_timezone).toBe("America/Los_Angeles");

    expect(
      await responseRepository.claimResponseExecution({
        generationCommandId: second.generation.commandId,
        modelRunAttemptId: second.generation.attemptId,
        userId: OWNER,
      }),
    ).toBe("owner");
    await createContextCompilerWithProductionRecentSource().compile({
      generationCommandId: second.generation.commandId,
      interactionTurnId: second.turn.id,
      userId: OWNER,
    });
    const recentSection = (
      await sectionsOf(await loadLatestCompiledContextId())
    ).find((section) => section.key === RECENT_CONTEXT_SECTION_KEY);
    expect(recentSection).toBeDefined();
    const decoded = decodeRecentContextReference(recentSection!.reference);
    expect(decoded.timezone).toBe("America/Los_Angeles");
    const requestZoneWindow = resolveRecentContextWindow({
      frozenAt: new Date(second.message.createdAt),
      timezone: "America/Los_Angeles",
      windowDays: 7,
    });
    const sessionZoneWindow = resolveRecentContextWindow({
      frozenAt: new Date(second.message.createdAt),
      timezone: "Asia/Shanghai",
      windowDays: 7,
    });
    expect(decoded.windowEndLocalDate).toBe(
      requestZoneWindow.windowEndLocalDate,
    );
    expect(sessionZoneWindow.windowEndLocalDate).not.toBe(
      decoded.windowEndLocalDate,
    );
  });

  it("freezes the original input instant and zone across an explicit cross-midnight retry", async () => {
    const timezone = "America/Los_Angeles";
    const original = await conversationService.submit(OWNER, {
      clientEventId: "retry-event-1",
      clientTurnId: "retry-turn-1",
      locale: "zh-CN",
      text: "我在洛杉矶看了日落。",
      timezone,
    });
    await database.pool.query(
      `UPDATE interaction_turns SET status = 'interrupted'
       WHERE user_id = $1 AND interaction_turn_id = $2`,
      [OWNER, original.turn.id],
    );
    await database.pool.query(
      `UPDATE generation_commands SET status = 'interrupted'
       WHERE user_id = $1 AND generation_command_id = $2`,
      [OWNER, original.generation.commandId],
    );
    advanceMs(DAY_MS);
    const retry = await conversationService.retry(OWNER, {
      originalTurnId: original.turn.id,
      retryRequestId: "retry-request-1",
    });

    const retryCommand = await database.pool.query<{
      created_at: Date;
      request_timezone: string;
    }>(
      `SELECT created_at, request_timezone FROM generation_commands
       WHERE user_id = $1 AND generation_command_id = $2`,
      [OWNER, retry.generation.commandId],
    );
    expect(retryCommand.rows[0]!.request_timezone).toBe(timezone);
    expect(retryCommand.rows[0]!.created_at.getTime()).toBeGreaterThan(
      new Date(original.message.createdAt).getTime(),
    );

    expect(
      await responseRepository.claimResponseExecution({
        generationCommandId: retry.generation.commandId,
        modelRunAttemptId: retry.generation.attemptId,
        userId: OWNER,
      }),
    ).toBe("owner");
    await createContextCompilerWithProductionRecentSource().compile({
      generationCommandId: retry.generation.commandId,
      interactionTurnId: retry.turn.id,
      userId: OWNER,
    });
    const recentSection = (
      await sectionsOf(await loadLatestCompiledContextId())
    ).find((section) => section.key === RECENT_CONTEXT_SECTION_KEY);
    expect(recentSection).toBeDefined();
    const decoded = decodeRecentContextReference(recentSection!.reference);
    expect(decoded.cutoff.expressedAt).toBe(original.message.createdAt);
    expect(decoded.timezone).toBe(timezone);
  });

  it("bounds the O(7d) source read by rows and bytes, and fails closed on timeout", async () => {
    for (let index = 0; index < 60; index += 1) {
      await submitTurn(`合成长对话第${index}条 ${"内".repeat(200)}`);
      advanceMs(1_000);
    }

    const unbounded = await loadSource({
      budgets: {
        ...RECENT_CONTEXT_DEFAULT_POLICY.budgets,
        maxCandidateBytes: 10_000_000,
        maxCandidateRows: 100,
      },
    });
    expect(unbounded.failure).toBeNull();
    expect(unbounded.items.length).toBeGreaterThan(1);
    // Newest-first ordering is preserved by the SQL caps.
    expect(unbounded.items[0]!.text).toContain("合成长对话第59条");

    // Date-stratified read: 8 total rows over 7 local dates is one row per
    // date, so a single busy newest day cannot monopolize the row cap.
    const rowCapped = await loadSource({
      budgets: {
        ...RECENT_CONTEXT_DEFAULT_POLICY.budgets,
        maxCandidateRows: 8,
      },
    });
    expect(rowCapped.failure).toBeNull();
    expect(rowCapped.items.length).toBe(Math.max(1, Math.floor(8 / 7)));
    expect(rowCapped.truncated).toBe(true);
    expect(rowCapped.items[0]!.text).toContain("合成长对话第59条");
    expect(rowCapped.perDate?.filter((date) => !date.empty).length).toBe(1);

    const newestBytes = Buffer.byteLength(unbounded.items[0]!.text, "utf8");
    const byteCapped = await loadSource({
      budgets: {
        ...RECENT_CONTEXT_DEFAULT_POLICY.budgets,
        maxCandidateBytes: newestBytes + 1,
        maxCandidateRows: 100,
      },
    });
    expect(byteCapped.failure).toBeNull();
    expect(byteCapped.items.length).toBe(1);
    expect(byteCapped.candidateBytes).toBe(newestBytes);
    expect(byteCapped.truncated).toBe(true);

    // Deterministic timeout: hold an exclusive lock on the read table in a
    // second session so the bounded read must block and the local
    // `statement_timeout` fires rather than hanging the turn.
    const locker = await database.pool.connect();
    await locker.query("BEGIN");
    await locker.query(
      "LOCK TABLE conversation_events IN ACCESS EXCLUSIVE MODE",
    );
    try {
      const timedOut = await loadSource({ readTimeoutMs: 100 });
      expect(timedOut.failure?.code).toBe("source_read_timeout");
      expect(timedOut.failure?.detail).toBeNull();
      expect(timedOut.items).toEqual([]);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });

  it("fails dispatch closed when a Forget control lands after compile but before egress", async () => {
    await seedResidenceClaim("我住在上海。");
    advanceMs(DAY_MS);
    expect(await quiesceActiveSession()).toBe(true);

    counter += 1;
    const turn = await conversationService.submit(OWNER, {
      clientEventId: `trust-late-control-event-${counter}`,
      clientTurnId: `trust-late-control-turn-${counter}`,
      locale: "zh-CN",
      text: "今天我们聊点别的。",
      timezone: "Asia/Shanghai",
    });
    expect(
      await responseRepository.claimResponseExecution({
        generationCommandId: turn.generation.commandId,
        modelRunAttemptId: turn.generation.attemptId,
        userId: OWNER,
      }),
    ).toBe("owner");
    const compiled = await createContextCompilerWithProductionRecentSource().compile(
      {
        generationCommandId: turn.generation.commandId,
        interactionTurnId: turn.turn.id,
        userId: OWNER,
      },
    );
    const recentSection = (await sectionsOf(compiled.id)).find(
      (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
    );
    expect(recentSection).toBeDefined();
    const selectedRevisionId = decodeRecentContextReference(
      recentSection!.reference,
    ).selected.find((selected) => selected.actor === "user")?.revisionId;
    expect(selectedRevisionId).toBeDefined();

    // The control is committed after the compile: only the dispatch-time
    // recheck can catch it.
    const evidenceItemId = (
      await database.pool.query<{ evidence_item_id: string }>(
        `SELECT item.evidence_item_id::text AS evidence_item_id
         FROM evidence_items item
         WHERE item.user_id = $1 AND item.source_revision_id = $2
           AND item.status = 'active'
         LIMIT 1`,
        [OWNER, selectedRevisionId],
      )
    ).rows[0]!.evidence_item_id;
    const forgetRequestId = createTestUuidV7(clock());
    await database.pool.query(
      `INSERT INTO memory_forget_requests (
         memory_forget_request_id, user_id, request_event_revision_id,
         target_claim_id, target_scope, canonical_side, qualifier_key,
         qualifier_typed_value, status, applied_claim_version_id,
         forget_policy_version, created_at
       ) VALUES ($1, $2, $3, NULL, 'whole_claim', NULL, NULL, NULL,
                 'pending_scope', NULL, 'memory-forget:v1', $4)`,
      [forgetRequestId, OWNER, selectedRevisionId, clock()],
    );
    await database.pool.query(
      `INSERT INTO memory_forget_evidence_exclusions (
         memory_forget_evidence_exclusion_id, user_id,
         memory_forget_request_id, evidence_item_id, exclusion_scope,
         canonical_side, qualifier_key, status, created_at
       ) VALUES ($1, $2, $3, $4, 'whole_claim', NULL, NULL, 'active', $5)`,
      [
        createTestUuidV7(clock()),
        OWNER,
        forgetRequestId,
        evidenceItemId,
        clock(),
      ],
    );

    const claim = await responseRepository.claimDispatch({
      champion: testChampion,
      compiledContextId: asCompiledContextId(compiled.id),
      generationCommandId: turn.generation.commandId,
      modelRunAttemptId: turn.generation.attemptId,
      now: clock(),
    });
    expect(claim.outcome).toBe("blocked");
    if (claim.outcome !== "blocked") {
      throw new Error("Expected the stale recent context to block dispatch.");
    }
    expect(claim.category).toBe("policy_blocked");
  });

  it("inherits the admitted request zone into a real Action Finalization command", async () => {
    await seedResidenceClaim("我住在上海。");
    advanceMs(60 * 1_000);
    const { receipt } = await respond("请忘掉我住在上海。", {
      actionKind: "memory_forget_request",
      arguments: { targetAnchor: "我住在上海" },
      reply: "好，我不会再把这件事当作记忆提起。",
    });
    expect(receipt).toMatchObject({ admission: "accepted" });

    const finalizations = await database.pool.query<{
      request_timezone: string | null;
    }>(
      `SELECT request_timezone FROM generation_commands
       WHERE user_id = $1 AND generation_stage = 'action_finalization'`,
      [OWNER],
    );
    expect(finalizations.rows.length).toBeGreaterThan(0);
    for (const row of finalizations.rows) {
      expect(row.request_timezone).toBe("Asia/Shanghai");
    }
  });

  it("resolves a real assistant event to its canonical generating input revision", async () => {
    await submitTurn("我喜欢下雨天。");
    advanceMs(60 * 1_000);
    await respond("今天天气怎么样？", { reply: "我不太清楚呢。" });

    const snapshot = await loadSource();
    expect(snapshot.failure).toBeNull();
    const assistant = snapshot.items.find((item) => item.actor === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.generationCommandId).not.toBeNull();
    expect(assistant!.generatingUserRevisionId).not.toBeNull();

    const generatingInput = await database.pool.query<{
      input_revision_id: string;
    }>(
      `SELECT input_revision_id::text AS input_revision_id
       FROM generation_commands
       WHERE user_id = $1 AND generation_command_id = $2`,
      [OWNER, assistant!.generationCommandId],
    );
    expect(String(assistant!.generatingUserRevisionId)).toBe(
      generatingInput.rows[0]!.input_revision_id,
    );

    const user = snapshot.items.find((item) => item.actor === "user");
    expect(user?.generationCommandId ?? null).toBeNull();
    expect(user?.generatingUserRevisionId ?? null).toBeNull();
  });

  it("omits only an oversized row and keeps the other window events", async () => {
    await submitTurn("短消息一。");
    advanceMs(60 * 1_000);
    await submitTurn("短消息二。");
    advanceMs(60 * 1_000);
    await submitTurn(`大${"段".repeat(2_000)}`);

    const snapshot = await loadSource({
      budgets: {
        ...RECENT_CONTEXT_DEFAULT_POLICY.budgets,
        maxCandidateBytes: 300,
      },
    });
    expect(snapshot.failure).toBeNull();
    // The oversized body is still returned so the selector can omit it with a
    // reason; it must not empty the whole window.
    expect(snapshot.items.some((item) => item.text.startsWith("大"))).toBe(true);
    expect(
      snapshot.items.some(
        (item) => item.text === "短消息一。" || item.text === "短消息二。",
      ),
    ).toBe(true);
    expect(snapshot.items.length).toBe(3);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.perDate?.some((date) => !date.empty)).toBe(true);
  });

  it("reads all seven local dates under the per-date quota", async () => {
    for (let day = 0; day < 7; day += 1) {
      await submitTurn(`第${day}天的消息`);
      if (day < 6) advanceMs(DAY_MS);
    }

    const snapshot = await loadSource({
      budgets: {
        ...RECENT_CONTEXT_DEFAULT_POLICY.budgets,
        maxCandidateRows: 7,
      },
    });
    expect(snapshot.failure).toBeNull();
    const nonEmpty = snapshot.perDate?.filter((date) => !date.empty) ?? [];
    expect(nonEmpty).toHaveLength(7);
    expect(snapshot.items).toHaveLength(7);
    // Exact-cap diagnostic: seven candidates against a cap of seven is not
    // truncation, because the read budget is `>` not `>=`.
    expect(snapshot.truncated).toBe(false);
  });

  it("never returns more bodies than a row cap below the window size", async () => {
    for (let day = 0; day < 7; day += 1) {
      await submitTurn(`第${day}天的消息`);
      if (day < 6) advanceMs(DAY_MS);
    }

    const budgetLimit = 2 * RECENT_CONTEXT_DEFAULT_POLICY.windowDays;
    for (const maxCandidateRows of [1, 2]) {
      const snapshot = await loadSource({
        budgets: {
          ...RECENT_CONTEXT_DEFAULT_POLICY.budgets,
          maxCandidateRows,
        },
      });
      expect(snapshot.failure).toBeNull();
      // Hard contract: never more bodies than the caller declared, even
      // though every one of the seven dates has a candidate.
      expect(snapshot.items.length).toBeLessThanOrEqual(maxCandidateRows);
      expect(snapshot.items).toHaveLength(maxCandidateRows);
      // All seven dates were still read, so uncovered dates are reported
      // honestly rather than hidden by under-fetching.
      expect(
        snapshot.perDate?.filter((date) => !date.empty),
      ).toHaveLength(7);
      // Documented fixed metadata overhead: per_date_limit + 1 rows per date.
      expect(snapshot.candidateRows).toBeLessThanOrEqual(budgetLimit);
      expect(snapshot.truncated).toBe(true);
    }
  });

  it("charges the cumulative byte budget only over rows the caps keep", async () => {
    // Older date: one small fitting representative.
    await submitTurn("a".repeat(5));
    advanceMs(DAY_MS);
    // Newer date: three fitting rows. With per_date_limit = 1 the two newest
    // are fetched; the older of the two is the probe row and must not consume
    // byte budget ahead of the older date's representative.
    await submitTurn("b".repeat(10));
    advanceMs(1_000);
    await submitTurn("b".repeat(10));
    advanceMs(1_000);
    await submitTurn("b".repeat(10));

    const snapshot = await loadSource({
      budgets: {
        ...RECENT_CONTEXT_DEFAULT_POLICY.budgets,
        maxCandidateBytes: 20,
        maxCandidateRows: 2,
      },
    });
    expect(snapshot.failure).toBeNull();
    // Both the newer date's kept row and the older date's representative fit.
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items.map((entry) => entry.text)).toEqual(
      expect.arrayContaining(["a".repeat(5), "b".repeat(10)]),
    );
  });

  it("prefers a fitting row over an oversized newest event for a single slot", async () => {
    await submitTurn("f".repeat(10));
    advanceMs(1_000);
    await submitTurn("o".repeat(50));

    const snapshot = await loadSource({
      budgets: {
        ...RECENT_CONTEXT_DEFAULT_POLICY.budgets,
        maxCandidateBytes: 20,
        maxCandidateRows: 1,
      },
    });
    expect(snapshot.failure).toBeNull();
    expect(snapshot.items).toHaveLength(1);
    // The oversized newest row must not occupy the only day slot; the fitting
    // row still represents the date and the oversized row is omitted later by
    // the selector with `single_event_over_budget`.
    expect(snapshot.items[0]!.text).toBe("f".repeat(10));
  });

  it("still returns the newest oversized row when a date has no fitting candidate", async () => {
    await submitTurn("o".repeat(10));
    advanceMs(1_000);
    await submitTurn("p".repeat(12));

    const snapshot = await loadSource({
      budgets: {
        ...RECENT_CONTEXT_DEFAULT_POLICY.budgets,
        maxCandidateBytes: 5,
        maxCandidateRows: 1,
      },
    });
    expect(snapshot.failure).toBeNull();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]!.text).toBe("p".repeat(12));
  });

  it("orders same-instant events by numeric sequence, not text", async () => {
    for (let index = 0; index < 10; index += 1) {
      await submitTurn(`同刻消息${index}`);
    }

    const snapshot = await loadSource();
    expect(snapshot.failure).toBeNull();
    const ten = snapshot.items.findIndex((entry) => entry.sequence === 10);
    const nine = snapshot.items.findIndex((entry) => entry.sequence === 9);
    expect(ten).toBeGreaterThanOrEqual(0);
    expect(nine).toBeGreaterThanOrEqual(0);
    // `"10" < "9"` in text order, so the buggy text sort would put 9 first.
    expect(ten).toBeLessThan(nine);
  });

  it("survives a source failure through compile, save, replay and the Provider payload", async () => {
    const failingCompiler = createContextCompiler({
      clock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      recentContext: {
        policy: RECENT_CONTEXT_DEFAULT_POLICY,
        source: {
          async loadRecentContextSource(request) {
            return {
              candidateBytes: 0,
              candidateRows: 0,
              failure: { code: "source_read_timeout", detail: null },
              items: [],
              perDate: [],
              policyVersion: request.policyVersion,
              selectorVersion: request.selectorVersion,
              timezone: request.timezone,
              truncated: false,
              windowEndLocalDate: request.windowEndLocalDate,
              windowStartLocalDate: request.windowStartLocalDate,
            };
          },
        },
      },
      repository: responseRepository,
    });
    const todayText = "今天天气不错。";
    const rendered: { role: string; text: string }[] = [];
    const { replyText } = await respond(
      todayText,
      {
        onStream: (request) => {
          for (const message of request.messages) {
            rendered.push({ role: message.role, text: message.text });
          }
        },
        reply: "是呀。",
      },
      failingCompiler,
    );
    expect(replyText.length).toBeGreaterThan(0);

    const compiledId = await loadLatestCompiledContextId();
    const recentSection = (await sectionsOf(compiledId)).find(
      (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
    );
    expect(recentSection).toBeDefined();
    const decoded = decodeRecentContextReference(recentSection!.reference);
    expect(decoded.failure).toEqual({
      code: "source_read_timeout",
      detail: null,
    });
    expect(decoded.selected).toEqual([]);
    // The current input still reaches the Provider; nothing recent is injected.
    expect(rendered.some((message) => message.text === todayText)).toBe(true);
  });

  async function prepareRecentTurn(
    seed: () => Promise<string> = () => seedResidenceClaim("我住在上海。"),
  ) {
    const claimId = await seed();
    advanceMs(DAY_MS);
    expect(await quiesceActiveSession()).toBe(true);
    counter += 1;
    const turn = await conversationService.submit(OWNER, {
      clientEventId: `trust-late-event-${counter}`,
      clientTurnId: `trust-late-turn-${counter}`,
      locale: "zh-CN",
      text: "今天我们聊点别的。",
      timezone: "Asia/Shanghai",
    });
    expect(
      await responseRepository.claimResponseExecution({
        generationCommandId: turn.generation.commandId,
        modelRunAttemptId: turn.generation.attemptId,
        userId: OWNER,
      }),
    ).toBe("owner");
    const compiled = await createContextCompilerWithProductionRecentSource().compile(
      {
        generationCommandId: turn.generation.commandId,
        interactionTurnId: turn.turn.id,
        userId: OWNER,
      },
    );
    const recentSection = (await sectionsOf(compiled.id)).find(
      (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
    );
    expect(recentSection).toBeDefined();
    const decoded = decodeRecentContextReference(recentSection!.reference);
    const userRevision = decoded.selected.find(
      (selected) => selected.actor === "user",
    )?.revisionId;
    expect(userRevision).toBeDefined();
    return { claimId, compiled, turn, userRevision: userRevision! };
  }

  async function prepareSameSessionRawTurn() {
    // Same-session prior turn becomes `committed_raw_events`, not a
    // recent-source ref. The #294 control fence applies only to the new
    // recent_conversation_context source and must leave this path untouched.
    const rawRevisionId = await submitTurn("我住在上海。");
    await seedEvidence(rawRevisionId);
    counter += 1;
    const turn = await conversationService.submit(OWNER, {
      clientEventId: `trust-raw-event-${counter}`,
      clientTurnId: `trust-raw-turn-${counter}`,
      locale: "zh-CN",
      text: "今天我们聊点别的。",
      timezone: "Asia/Shanghai",
    });
    expect(
      await responseRepository.claimResponseExecution({
        generationCommandId: turn.generation.commandId,
        modelRunAttemptId: turn.generation.attemptId,
        userId: OWNER,
      }),
    ).toBe("owner");
    const compiled = await createContextCompilerWithProductionRecentSource().compile(
      {
        generationCommandId: turn.generation.commandId,
        interactionTurnId: turn.turn.id,
        userId: OWNER,
      },
    );
    return { compiled, rawRevisionId, turn };
  }

  async function insertForgetControl(input: {
    revisionId: string;
    scope: "whole_claim" | "relationship_qualifier";
    qualifier?: {
      canonicalSide: "canonical_subject" | "counterpart";
      key: string;
      qualifierId: string;
    };
  }) {
    const evidenceItemId = (
      await database.pool.query<{ evidence_item_id: string }>(
        `SELECT item.evidence_item_id::text AS evidence_item_id
         FROM evidence_items item
         WHERE item.user_id = $1 AND item.source_revision_id = $2
           AND item.status = 'active'
         LIMIT 1`,
        [OWNER, input.revisionId],
      )
    ).rows[0]!.evidence_item_id;
    const qualifier = input.scope === "relationship_qualifier";
    const requestId = createTestUuidV7(clock());
    await database.pool.query(
      `INSERT INTO memory_forget_requests (
         memory_forget_request_id, user_id, request_event_revision_id,
         target_claim_id, target_scope, canonical_side, qualifier_key,
         qualifier_typed_value, target_qualifier_id, status,
         applied_claim_version_id, forget_policy_version, created_at
       ) VALUES ($1, $2, $3, NULL, $4, $5, $6, NULL, $7,
                 'pending_scope', NULL, 'memory-forget:v1', $8)`,
      [
        requestId,
        OWNER,
        input.revisionId,
        input.scope,
        qualifier ? input.qualifier!.canonicalSide : null,
        qualifier ? input.qualifier!.key : null,
        qualifier ? input.qualifier!.qualifierId : null,
        clock(),
      ],
    );
    await database.pool.query(
      `INSERT INTO memory_forget_evidence_exclusions (
         memory_forget_evidence_exclusion_id, user_id,
         memory_forget_request_id, evidence_item_id, exclusion_scope,
         canonical_side, qualifier_key, status, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)`,
      [
        createTestUuidV7(clock()),
        OWNER,
        requestId,
        evidenceItemId,
        input.scope,
        qualifier ? input.qualifier!.canonicalSide : null,
        qualifier ? input.qualifier!.key : null,
        clock(),
      ],
    );
  }

  async function insertCorrectionControl(input: {
    revisionId: string;
  }) {
    const link = (
      await database.pool.query<{
        memory_claim_id: string;
        memory_claim_version_id: string;
      }>(
        `SELECT version.memory_claim_id::text AS memory_claim_id,
                link.memory_claim_version_id::text AS memory_claim_version_id
         FROM claim_evidence_links link
         INNER JOIN evidence_items item
           ON item.evidence_item_id = link.evidence_item_id
          AND item.user_id = link.user_id
         INNER JOIN memory_claim_versions version
           ON version.memory_claim_version_id = link.memory_claim_version_id
          AND version.user_id = link.user_id
         WHERE link.user_id = $1 AND link.status = 'active'
           AND item.source_revision_id = $2
         LIMIT 1`,
        [OWNER, input.revisionId],
      )
    ).rows[0]!;
    await database.pool.query(
      `INSERT INTO memory_claim_corrections (
         memory_claim_correction_id, user_id, request_event_revision_id,
         target_claim_id, deactivated_claim_version_id, target_scope,
         corrected_fact_recorded, correction_policy_version, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'whole_claim', FALSE,
                 'memory-correction:v1', $6)`,
      [
        createTestUuidV7(clock()),
        OWNER,
        input.revisionId,
        link.memory_claim_id,
        link.memory_claim_version_id,
        clock(),
      ],
    );
  }

  async function loadKinshipQualifier(claimId: string) {
    return (
      await database.pool.query<{
        axis_id: string;
        memory_claim_version_qualifier_id: string;
        role_side: "canonical_subject" | "counterpart";
      }>(
        `SELECT q.memory_claim_version_qualifier_id::text
                  AS memory_claim_version_qualifier_id,
                q.role_side, q.axis_id
         FROM memory_claim_versions version
         INNER JOIN memory_claim_version_qualifiers q
           ON q.memory_claim_version_id = version.memory_claim_version_id
          AND q.user_id = version.user_id
         WHERE version.memory_claim_id = $1 AND version.user_id = $2
         LIMIT 1`,
        [claimId, OWNER],
      )
    ).rows[0]!;
  }

  it("blocks dispatch when a Correction lands after compile but before egress", async () => {
    const { compiled, turn, userRevision } = await prepareRecentTurn();
    await insertCorrectionControl({ revisionId: userRevision });

    const claim = await responseRepository.claimDispatch({
      champion: testChampion,
      compiledContextId: asCompiledContextId(compiled.id),
      generationCommandId: turn.generation.commandId,
      modelRunAttemptId: turn.generation.attemptId,
      now: clock(),
    });
    expect(claim.outcome).toBe("blocked");
    if (claim.outcome !== "blocked") {
      throw new Error("Expected the late Correction to block dispatch.");
    }
    expect(claim.category).toBe("policy_blocked");
  });

  it("blocks dispatch when a Qualifier-scope Forget lands after compile", async () => {
    const { claimId, compiled, turn, userRevision } = await prepareRecentTurn(
      async () => (await seedRelativeClaim()).claimId,
    );
    const qualifier = await loadKinshipQualifier(claimId);
    await insertForgetControl({
      revisionId: userRevision,
      scope: "relationship_qualifier",
      qualifier: {
        canonicalSide: qualifier.role_side,
        key: qualifier.axis_id,
        qualifierId: qualifier.memory_claim_version_qualifier_id,
      },
    });

    const claim = await responseRepository.claimDispatch({
      champion: testChampion,
      compiledContextId: asCompiledContextId(compiled.id),
      generationCommandId: turn.generation.commandId,
      modelRunAttemptId: turn.generation.attemptId,
      now: clock(),
    });
    expect(claim.outcome).toBe("blocked");
    if (claim.outcome !== "blocked") {
      throw new Error("Expected the late Qualifier Forget to block dispatch.");
    }
    expect(claim.category).toBe("policy_blocked");
  });

  it("does not extend the recent-source control fence to same-session raw history", async () => {
    const { compiled, rawRevisionId, turn } = await prepareSameSessionRawTurn();
    const recentSection = (await sectionsOf(compiled.id)).find(
      (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
    );
    expect(recentSection).toBeDefined();
    const decoded = decodeRecentContextReference(recentSection!.reference);
    // Scope clarification (authoritative): only the new
    // recent_conversation_context source is control-filtered. A same-session
    // prior turn is frozen as committed_raw_events, never as a recent ref.
    expect(
      decoded.selected.some((selected) => selected.revisionId === rawRevisionId),
    ).toBe(false);

    await insertForgetControl({ revisionId: rawRevisionId, scope: "whole_claim" });
    const claim = await responseRepository.claimDispatch({
      champion: testChampion,
      compiledContextId: asCompiledContextId(compiled.id),
      generationCommandId: turn.generation.commandId,
      modelRunAttemptId: turn.generation.attemptId,
      now: clock(),
    });
    // Existing raw behavior is preserved: a control on a raw ref does not
    // block dispatch and the same-session input still ships.
    expect(claim.outcome).toBe("permitted");
  });

  it("commits the authoritative Assistant when no control lands after dispatch", async () => {
    const prepared = await prepareRecentTurn();
    expect(
      await responseRepository.claimDispatch({
        champion: testChampion,
        compiledContextId: asCompiledContextId(prepared.compiled.id),
        generationCommandId: prepared.turn.generation.commandId,
        modelRunAttemptId: prepared.turn.generation.attemptId,
        now: clock(),
      }),
    ).toMatchObject({ outcome: "permitted" });
    const committed = await responseRepository.commitCompleteResponse({
      completedAt: clock(),
      generationCommandId: prepared.turn.generation.commandId,
      metadata: {
        costMicros: 0,
        finishReason: "completed",
        inputTokens: 4,
        modelSnapshot: "gpt-5.4",
        outputTokens: 3,
        providerRequestId: "late-control-commit",
      },
      modelRunAttemptId: prepared.turn.generation.attemptId,
      text: "好的。",
      userId: OWNER,
    });
    expect(committed.outcome).toBe("committed");
  });

  it("rejects the authoritative Assistant when a control lands after dispatch", async () => {
    const prepared = await prepareRecentTurn();
    const dispatched = await responseRepository.claimDispatch({
      champion: testChampion,
      compiledContextId: asCompiledContextId(prepared.compiled.id),
      generationCommandId: prepared.turn.generation.commandId,
      modelRunAttemptId: prepared.turn.generation.attemptId,
      now: clock(),
    });
    expect(dispatched.outcome).toBe("permitted");
    await insertForgetControl({
      revisionId: prepared.userRevision,
      scope: "whole_claim",
    });
    const rejected = await responseRepository.commitCompleteResponse({
      completedAt: clock(),
      generationCommandId: prepared.turn.generation.commandId,
      metadata: {
        costMicros: 0,
        finishReason: "completed",
        inputTokens: 4,
        modelSnapshot: "gpt-5.4",
        outputTokens: 3,
        providerRequestId: "late-control-fence",
      },
      modelRunAttemptId: prepared.turn.generation.attemptId,
      text: "好的。",
      userId: OWNER,
    });
    expect(rejected).toEqual({ outcome: "fence_rejected" });
  });

  it("rejects the authoritative Assistant when a late Correction lands after dispatch", async () => {
    const prepared = await prepareRecentTurn();
    expect(
      (
        await responseRepository.claimDispatch({
          champion: testChampion,
          compiledContextId: asCompiledContextId(prepared.compiled.id),
          generationCommandId: prepared.turn.generation.commandId,
          modelRunAttemptId: prepared.turn.generation.attemptId,
          now: clock(),
        })
      ).outcome,
    ).toBe("permitted");
    await insertCorrectionControl({ revisionId: prepared.userRevision });
    const rejected = await responseRepository.commitCompleteResponse({
      completedAt: clock(),
      generationCommandId: prepared.turn.generation.commandId,
      metadata: {
        costMicros: 0,
        finishReason: "completed",
        inputTokens: 4,
        modelSnapshot: "gpt-5.4",
        outputTokens: 3,
        providerRequestId: "late-correction-fence",
      },
      modelRunAttemptId: prepared.turn.generation.attemptId,
      text: "好的。",
      userId: OWNER,
    });
    expect(rejected).toEqual({ outcome: "fence_rejected" });
  });

  it("rejects the authoritative Assistant when a late Qualifier Forget lands after dispatch", async () => {
    const { claimId, compiled, turn, userRevision } = await prepareRecentTurn(
      async () => (await seedRelativeClaim()).claimId,
    );
    expect(
      (
        await responseRepository.claimDispatch({
          champion: testChampion,
          compiledContextId: asCompiledContextId(compiled.id),
          generationCommandId: turn.generation.commandId,
          modelRunAttemptId: turn.generation.attemptId,
          now: clock(),
        })
      ).outcome,
    ).toBe("permitted");
    const qualifier = await loadKinshipQualifier(claimId);
    await insertForgetControl({
      revisionId: userRevision,
      scope: "relationship_qualifier",
      qualifier: {
        canonicalSide: qualifier.role_side,
        key: qualifier.axis_id,
        qualifierId: qualifier.memory_claim_version_qualifier_id,
      },
    });
    const rejected = await responseRepository.commitCompleteResponse({
      completedAt: clock(),
      generationCommandId: turn.generation.commandId,
      metadata: {
        costMicros: 0,
        finishReason: "completed",
        inputTokens: 4,
        modelSnapshot: "gpt-5.4",
        outputTokens: 3,
        providerRequestId: "late-qualifier-fence",
      },
      modelRunAttemptId: turn.generation.attemptId,
      text: "好的。",
      userId: OWNER,
    });
    expect(rejected).toEqual({ outcome: "fence_rejected" });
  });

  it("calibrates the shipped default policy against a fixed seven-day fixture (#294)", async () => {
    // Fixed, versioned fixture: 4000 assistant events spread across the seven
    // local dates of the frozen window. Changing this shape invalidates the
    // recorded plan/budget calibration.
    const FIXTURE_ROWS = 4_000;
    const timezone = "Asia/Shanghai";
    const window = resolveRecentContextWindow({
      frozenAt: clock(),
      timezone,
      windowDays: RECENT_CONTEXT_DEFAULT_POLICY.windowDays,
    });
    const windowStart = new Date(
      `${window.windowStartLocalDate}T00:00:00+08:00`,
    );
    const firstMs = windowStart.getTime() + 1_000;
    const lastMs = clock().getTime() - 60_000;
    const stepMs = (lastMs - firstMs) / FIXTURE_ROWS;
    const sessionId = createTestUuidV7(clock());
    const turnId = createTestUuidV7(clock());
    const timestamps: Date[] = [];
    for (let index = 0; index < FIXTURE_ROWS; index += 1) {
      timestamps.push(new Date(firstMs + index * stepMs));
    }
    const eventIds = timestamps.map((instant) => createTestUuidV7(instant));
    const revisionIds = timestamps.map((instant) => createTestUuidV7(instant));
    const sequences = timestamps.map((_, index) => index + 1);
    await database.pool.query(
      `INSERT INTO daily_sessions (
         daily_session_id, user_id, logical_date, timezone_at_start,
         started_at, last_activity_at, created_at, updated_at
       ) VALUES ($1, $2, $3::date, $4, $5, $5, $5, $5)`,
      [sessionId, OWNER, window.windowStartLocalDate, timezone, windowStart],
    );
    await database.pool.query(
      `INSERT INTO interaction_turns (
         interaction_turn_id, user_id, daily_session_id, client_turn_id,
         turn_sequence_no, continuous_exchange_no, status, started_at,
         created_at, updated_at
       ) VALUES ($1, $2, $3, 'cal-turn', 1, 1, 'open', $4, $4, $4)`,
      [turnId, OWNER, sessionId, windowStart],
    );
    await database.pool.query(
      `INSERT INTO conversation_events (
         conversation_event_id, user_id, daily_session_id, interaction_turn_id,
         sequence_no, client_event_id, actor, channel, event_type,
         lifecycle_status, created_at
       )
       SELECT fixture.event_id, $1, $2, $3, fixture.seq,
              'cal-' || fixture.seq, 'assistant', 'text',
              'assistant_message', 'active', fixture.created_at
       FROM unnest(
         $4::uuid[], $5::bigint[], $6::timestamptz[]
       ) AS fixture(event_id, seq, created_at)`,
      [OWNER, sessionId, turnId, eventIds, sequences, timestamps],
    );
    await database.pool.query(
      `INSERT INTO conversation_event_revisions (
         conversation_event_revision_id, user_id, conversation_event_id,
         revision, locale, canonical_text, transcript_status, created_by,
         created_at
       )
       SELECT fixture.revision_id, $1, fixture.event_id, 1, 'zh-CN',
              '校准内容' || fixture.seq, 'final', 'client',
              fixture.created_at
       FROM unnest(
         $2::uuid[], $3::uuid[], $4::bigint[], $5::timestamptz[]
       ) AS fixture(revision_id, event_id, seq, created_at)`,
      [OWNER, revisionIds, eventIds, sequences, timestamps],
    );
    await database.pool.query(
      `UPDATE conversation_events event
       SET current_revision_id = fixture.revision_id
       FROM unnest($1::uuid[], $2::uuid[]) AS fixture(event_id, revision_id)
       WHERE event.conversation_event_id = fixture.event_id`,
      [eventIds, revisionIds],
    );

    const snapshot = await loadSource();
    expect(snapshot.failure).toBeNull();
    expect(snapshot.items.length).toBeGreaterThan(0);
    expect(snapshot.items.length).toBeLessThanOrEqual(
      RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateRows,
    );
    expect(snapshot.perDate?.filter((date) => !date.empty)).toHaveLength(7);

    // Fresh, deterministic statistics for the fixed fixture so the plan
    // assertions do not depend on autovacuum timing from earlier tests.
    await database.pool.query("ANALYZE conversation_events");
    await database.pool.query("ANALYZE conversation_event_revisions");

    // Committed plan evidence: the per-local-date range predicate is served by
    // the dedicated recent-context index.
    const planParameters = [
      OWNER,
      timezone,
      window.windowStartLocalDate,
      window.windowEndLocalDate,
      clock().toISOString(),
      [],
      RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateRows,
      RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateBytes,
    ];
    const planTextOf = (rows: readonly { "QUERY PLAN": unknown }[]) =>
      rows.map((row) => String(row["QUERY PLAN"])).join("\n");
    const client = await database.pool.connect();
    try {
      // Secondary assertion: with seqscan disabled the dedicated index is
      // provably reachable for the shipped predicate, independent of planner
      // statistics.
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const forcedPlan = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN ${RECENT_CONTEXT_CANDIDATE_SQL}`,
        planParameters,
      );
      expect(planTextOf(forcedPlan.rows)).toContain(
        "conversation_events_recent_context_idx",
      );
      await client.query("ROLLBACK");

      // Primary assertion: under default planner settings the shipped query is
      // index-served — it references the dedicated index and never scans
      // `conversation_events` sequentially.
      const defaultPlan = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN ${RECENT_CONTEXT_CANDIDATE_SQL}`,
        planParameters,
      );
      const defaultPlanText = planTextOf(defaultPlan.rows);
      expect(defaultPlanText).toContain(
        "conversation_events_recent_context_idx",
      );
      expect(defaultPlanText).not.toMatch(
        /Seq Scan on conversation_events\b/,
      );
    } finally {
      client.release();
    }
  });
});

/**
 * Issue #295: the recent-source path must be independently disable-able by an
 * operator, without touching G1 role pins, provider egress policy, or any user
 * content. The governance identity is immutable and versioned: disabling
 * revokes, re-enabling inserts a brand-new version, and a revoked version can
 * never be resurrected. The compile freezes the identity only when recent
 * content was actually selected, and the dispatch / Provider-result / commit
 * fences fail closed when it is no longer active.
 */
describe("Recent context independent governance (#295)", () => {
  const governanceRepository = () =>
    new PostgresRecentContextPolicyRepository(database.pool);

  async function sectionsOf(compiledContextId: string) {
    return (
      await database.pool.query<{
        sections: readonly { key: string; reference: string }[];
      }>(
        `SELECT sections FROM compiled_contexts
         WHERE user_id = $1 AND compiled_context_id = $2`,
        [OWNER, compiledContextId],
      )
    ).rows[0]!.sections;
  }

  async function prepareRecentTurn() {
    await seedResidenceClaim("我住在上海。");
    advanceMs(DAY_MS);
    expect(await quiesceActiveSession()).toBe(true);
    counter += 1;
    const turn = await conversationService.submit(OWNER, {
      clientEventId: `trust-governance-event-${counter}`,
      clientTurnId: `trust-governance-turn-${counter}`,
      locale: "zh-CN",
      text: "今天我们聊点别的。",
      timezone: "Asia/Shanghai",
    });
    expect(
      await responseRepository.claimResponseExecution({
        generationCommandId: turn.generation.commandId,
        modelRunAttemptId: turn.generation.attemptId,
        userId: OWNER,
      }),
    ).toBe("owner");
    const compiled =
      await createContextCompilerWithProductionRecentSource().compile({
        generationCommandId: turn.generation.commandId,
        interactionTurnId: turn.turn.id,
        userId: OWNER,
      });
    const recentSection = (await sectionsOf(compiled.id)).find(
      (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
    );
    expect(recentSection).toBeDefined();
    return { compiled, recentSection: recentSection!, turn };
  }

  /**
   * A compiler whose recent source always fails. It still emits the recent
   * section (with a recorded failure and zero selected refs) so the test can
   * prove a degraded recent section never blocks the original response.
   */
  function createCompilerWithFailingRecentSource() {
    return createContextCompiler({
      clock,
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "test-context-integrity-secret",
      rawEventTokenBudget: 4_000,
      recentContext: {
        policy: RECENT_CONTEXT_DEFAULT_POLICY,
        source: {
          async loadRecentContextSource(request) {
            return {
              candidateBytes: 0,
              candidateRows: 0,
              failure: { code: "source_read_failed" as const, detail: null },
              items: [],
              policyVersion: request.policyVersion,
              selectorVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
              timezone: request.timezone,
              truncated: false,
              windowEndLocalDate: request.windowEndLocalDate,
              windowStartLocalDate: request.windowStartLocalDate,
            };
          },
        },
      },
      repository: responseRepository,
    });
  }

  async function prepareTurnWithCompiler(
    compiler: ReturnType<typeof createContextCompiler>,
  ) {
    await seedResidenceClaim("我住在上海。");
    advanceMs(DAY_MS);
    expect(await quiesceActiveSession()).toBe(true);
    counter += 1;
    const turn = await conversationService.submit(OWNER, {
      clientEventId: `trust-governance-turn-${counter}`,
      clientTurnId: `trust-governance-turn-${counter}`,
      locale: "zh-CN",
      text: "今天我们聊点别的。",
      timezone: "Asia/Shanghai",
    });
    expect(
      await responseRepository.claimResponseExecution({
        generationCommandId: turn.generation.commandId,
        modelRunAttemptId: turn.generation.attemptId,
        userId: OWNER,
      }),
    ).toBe("owner");
    const compiled = await compiler.compile({
      generationCommandId: turn.generation.commandId,
      interactionTurnId: turn.turn.id,
      userId: OWNER,
    });
    return { compiled, turn };
  }

  it("revokes and re-enables with a new immutable version, never resurrecting the old one", async () => {
    const repository = governanceRepository();
    const before = await repository.findEffectiveState();
    expect(before.enabled).toBe(true);
    const activeVersion = before.active!.policyVersion;

    const revoked = await repository.revokeActivePolicy({
      now: clock(),
      revokedBy: String(OWNER),
    });
    expect(revoked.outcome).toBe("revoked");
    if (revoked.outcome !== "revoked") {
      throw new Error("Expected the active policy to be revoked.");
    }
    // F2: revocation records its own actor and never overwrites the enable
    // actor.
    expect(revoked.policy.changedBy).toBe(String(OWNER));
    expect(revoked.policy.revokedBy).toBe(String(OWNER));
    expect(revoked.policy.revokedAt).not.toBeNull();
    expect(await repository.findActivePolicy()).toBeNull();
    expect(await repository.findPolicyStatus(activeVersion)).toBe("revoked");

    // A second disable is an idempotent no-op, not an error.
    expect(
      (
        await repository.revokeActivePolicy({
          now: clock(),
          revokedBy: String(OWNER),
        })
      ).outcome,
    ).toBe("already_disabled");

    const reEnabled = await repository.insertActivePolicy({
      budgetTokens: RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxContextTokens,
      changedBy: String(OWNER),
      compilerVersion: RECENT_CONTEXT_COMPILER_VERSION,
      maxCandidateBytes:
        RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateBytes,
      maxCandidateRows: RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateRows,
      maxSingleEventTokens:
        RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxSingleEventTokens,
      now: clock(),
      readTimeoutMs: RECENT_CONTEXT_DEFAULT_POLICY.budgets.readTimeoutMs,
      selectionPolicyVersion: RECENT_CONTEXT_DEFAULT_POLICY.version,
      selectorPolicyVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
    });
    expect(reEnabled.policyVersion).not.toBe(activeVersion);
    expect(reEnabled.changedBy).toBe(String(OWNER));
    expect(reEnabled.revokedBy).toBeNull();
    expect(reEnabled.status).toBe("active");
    // The revoked version stays revoked forever.
    expect(await repository.findPolicyStatus(activeVersion)).toBe("revoked");

    // Enabling while an active version exists fails closed and leaves it
    // unchanged.
    await expect(
      repository.insertActivePolicy({
        budgetTokens: RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxContextTokens,
        changedBy: String(OWNER),
        compilerVersion: RECENT_CONTEXT_COMPILER_VERSION,
        maxCandidateBytes:
          RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateBytes,
        maxCandidateRows:
          RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateRows,
        maxSingleEventTokens:
          RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxSingleEventTokens,
        now: clock(),
        readTimeoutMs: RECENT_CONTEXT_DEFAULT_POLICY.budgets.readTimeoutMs,
        selectionPolicyVersion: RECENT_CONTEXT_DEFAULT_POLICY.version,
        selectorPolicyVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
      }),
    ).rejects.toBeInstanceOf(RecentContextGovernanceConflictError);
    expect((await repository.findActivePolicy())!.policyVersion).toBe(
      reEnabled.policyVersion,
    );
  });

  it("stops selecting recent content when disabled and keeps the original conversation responding", async () => {
    await seedResidenceClaim("我住在上海。");
    advanceMs(DAY_MS);
    expect(await quiesceActiveSession()).toBe(true);
    await governanceRepository().revokeActivePolicy({
      now: clock(),
      revokedBy: String(OWNER),
    });

    const { replyText } = await respond(
      "今天想聊聊别的。",
      { reply: "好啊，我在听。" },
      createContextCompilerWithProductionRecentSource(),
    );
    expect(replyText).toBe("好啊，我在听。");

    const compiledId = await loadLatestCompiledContextId();
    expect(
      (await sectionsOf(compiledId)).some(
        (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
      ),
    ).toBe(false);
  });

  it("freezes the active governance identity only when recent content is selected", async () => {
    const { compiled } = await prepareRecentTurn();
    const row = await database.pool.query<{
      policy_versions: Record<string, unknown>;
    }>(
      `SELECT policy_versions FROM compiled_contexts
       WHERE user_id = $1 AND compiled_context_id = $2`,
      [OWNER, compiled.id],
    );
    expect(row.rows[0]!.policy_versions["recentContextPolicyVersion"]).toBe(
      ACTIVE_RECENT_CONTEXT_POLICY_VERSION,
    );
  });

  it("blocks dispatch when the frozen governance version was revoked first", async () => {
    const { compiled, turn } = await prepareRecentTurn();
    await governanceRepository().revokeActivePolicy({
      now: clock(),
      revokedBy: String(OWNER),
    });
    const claim = await responseRepository.claimDispatch({
      champion: testChampion,
      compiledContextId: asCompiledContextId(compiled.id),
      generationCommandId: turn.generation.commandId,
      modelRunAttemptId: turn.generation.attemptId,
      now: clock(),
    });
    expect(claim).toMatchObject({
      category: "policy_blocked",
      outcome: "blocked",
    });
  });

  it("rejects the Provider result when governance is revoked after dispatch", async () => {
    const { compiled, turn } = await prepareRecentTurn();
    expect(
      (
        await responseRepository.claimDispatch({
          champion: testChampion,
          compiledContextId: asCompiledContextId(compiled.id),
          generationCommandId: turn.generation.commandId,
          modelRunAttemptId: turn.generation.attemptId,
          now: clock(),
        })
      ).outcome,
    ).toBe("permitted");
    await governanceRepository().revokeActivePolicy({
      now: clock(),
      revokedBy: String(OWNER),
    });
    const accepted = await responseRepository.recordProviderCompletion({
      completion: {
        costMicros: 0,
        finishReason: "completed",
        inputTokens: 4,
        modelSnapshot: "gpt-5.4",
        outputTokens: 3,
        providerRequestId: "governance-revoked-result",
        type: "completed",
      },
      modelRunAttemptId: turn.generation.attemptId,
      now: clock(),
    });
    expect(accepted).toBe(false);
  });

  it("rejects the authoritative Assistant when governance is revoked after the result", async () => {
    const { compiled, turn } = await prepareRecentTurn();
    expect(
      (
        await responseRepository.claimDispatch({
          champion: testChampion,
          compiledContextId: asCompiledContextId(compiled.id),
          generationCommandId: turn.generation.commandId,
          modelRunAttemptId: turn.generation.attemptId,
          now: clock(),
        })
      ).outcome,
    ).toBe("permitted");
    expect(
      await responseRepository.recordProviderCompletion({
        completion: {
          costMicros: 0,
          finishReason: "completed",
          inputTokens: 4,
          modelSnapshot: "gpt-5.4",
          outputTokens: 3,
          providerRequestId: "governance-revoked-commit",
          type: "completed",
        },
        modelRunAttemptId: turn.generation.attemptId,
        now: clock(),
      }),
    ).toBe(true);
    await governanceRepository().revokeActivePolicy({
      now: clock(),
      revokedBy: String(OWNER),
    });
    const rejected = await responseRepository.commitCompleteResponse({
      completedAt: clock(),
      generationCommandId: turn.generation.commandId,
      metadata: {
        costMicros: 0,
        finishReason: "completed",
        inputTokens: 4,
        modelSnapshot: "gpt-5.4",
        outputTokens: 3,
        providerRequestId: "governance-revoked-commit",
      },
      modelRunAttemptId: turn.generation.attemptId,
      text: "好的。",
      userId: OWNER,
    });
    expect(rejected).toEqual({ outcome: "fence_rejected" });
  });

  it("serializes a concurrent disable against an in-flight shared governance lock", async () => {
    const repository = governanceRepository();
    const active = await repository.findActivePolicy();
    const holder = await database.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT 1 FROM recent_context_policies
         WHERE policy_version = $1 AND status = 'active'
         FOR SHARE`,
        [active!.policyVersion],
      );
      let settled = false;
      const disable = repository
        .revokeActivePolicy({ now: clock(), revokedBy: String(OWNER) })
        .then((result) => {
          settled = true;
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      // The disable must wait on the shared lock the in-flight selection holds.
      expect(settled).toBe(false);
      await holder.query("COMMIT");
      expect((await disable).outcome).toBe("revoked");
    } finally {
      holder.release();
    }
  });

  it("reports the frozen recent selection content-free through the Inspector read model", async () => {
    const yesterdayRevision = await submitTurn("昨天我去公园跑步，心情很好。");
    advanceMs(DAY_MS);
    expect(await quiesceActiveSession()).toBe(true);
    counter += 1;
    const turn = await conversationService.submit(OWNER, {
      clientEventId: `trust-inspector-event-${counter}`,
      clientTurnId: `trust-inspector-turn-${counter}`,
      locale: "zh-CN",
      text: "今天我们聊点别的。",
      timezone: "Asia/Shanghai",
    });
    await responseRepository.claimResponseExecution({
      generationCommandId: turn.generation.commandId,
      modelRunAttemptId: turn.generation.attemptId,
      userId: OWNER,
    });
    const compiled =
      await createContextCompilerWithProductionRecentSource().compile({
        generationCommandId: turn.generation.commandId,
        interactionTurnId: turn.turn.id,
        userId: OWNER,
      });
    expect(
      (
        await responseRepository.claimDispatch({
          champion: testChampion,
          compiledContextId: asCompiledContextId(compiled.id),
          generationCommandId: turn.generation.commandId,
          modelRunAttemptId: turn.generation.attemptId,
          now: clock(),
        })
      ).outcome,
    ).toBe("permitted");

    const metadata = await new PostgresInternalInspectionRepository(
      database.pool,
    ).findGenerationMetadata({
      generationCommandId: asGenerationCommandId(turn.generation.commandId),
      userId: OWNER,
    });
    const recent = metadata!.compiledContext!.recentContext;
    expect(recent).not.toBeNull();
    expect(recent!.authorizationStatus).toBe("active");
    expect(recent!.authorizationPolicyVersion).toBe(
      ACTIVE_RECENT_CONTEXT_POLICY_VERSION,
    );
    expect(
      recent!.selected.some(
        (selected) => selected.revisionId === yesterdayRevision,
      ),
    ).toBe(true);
    expect(recent!.readLatencyMs).toBeGreaterThanOrEqual(0);
    // Content-free: the Inspector renders the frozen metadata, never a
    // re-read of the previous session's message body.
    expect(JSON.stringify(recent)).not.toContain("昨天我去公园跑步");

    const recentRef = metadata!.compiledContext!.referencedEvents.find(
      (event) =>
        event.section === RECENT_CONTEXT_SECTION_KEY &&
        event.revisionId === yesterdayRevision,
    );
    expect(recentRef).toMatchObject({
      dailySessionId: expect.any(String),
      selectionReason: expect.any(String),
    });
  });

  it("keeps the governance switch independent from G1 policies and content-free", async () => {
    const before = await database.pool.query(
      `SELECT policy_version, status, role, provider
       FROM provider_egress_policy_versions
       ORDER BY policy_version, role, provider`,
    );
    await governanceRepository().revokeActivePolicy({
      now: clock(),
      revokedBy: String(OWNER),
    });
    const after = await database.pool.query(
      `SELECT policy_version, status, role, provider
       FROM provider_egress_policy_versions
       ORDER BY policy_version, role, provider`,
    );
    expect(after.rows).toEqual(before.rows);

    // Content-free global governance: no owner column, no message body column.
    const columns = await database.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'recent_context_policies'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toContain("user_id");
    expect(names).not.toContain("canonical_text");
    expect(names).not.toContain("content");
  });

  it("selects no recent content when the active governance row names a different runtime", async () => {
    await seedResidenceClaim("我住在上海。");
    advanceMs(DAY_MS);
    expect(await quiesceActiveSession()).toBe(true);
    // Active row, but its compiler identity does not match the wired runtime.
    await database.pool.query(
      `UPDATE recent_context_policies
       SET compiler_version = 'context-compiler:v1'
       WHERE status = 'active'`,
    );
    const { replyText } = await respond(
      "今天想聊聊别的。",
      { reply: "好啊，我在听。" },
      createContextCompilerWithProductionRecentSource(),
    );
    expect(replyText).toBe("好啊，我在听。");
    const compiledId = await loadLatestCompiledContextId();
    expect(
      (await sectionsOf(compiledId)).some(
        (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
      ),
    ).toBe(false);
  });

  it("selects no recent content and still responds when governance was never enabled", async () => {
    await seedResidenceClaim("我住在上海。");
    advanceMs(DAY_MS);
    expect(await quiesceActiveSession()).toBe(true);
    await database.pool.query("DELETE FROM recent_context_policies");
    const { replyText } = await respond(
      "今天想聊聊别的。",
      { reply: "好啊，我在听。" },
      createContextCompilerWithProductionRecentSource(),
    );
    expect(replyText).toBe("好啊，我在听。");
    const compiledId = await loadLatestCompiledContextId();
    expect(
      (await sectionsOf(compiledId)).some(
        (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
      ),
    ).toBe(false);
  });

  it("does not block the original response for a zero-selected degraded recent section after revoke", async () => {
    const { compiled, turn } = await prepareTurnWithCompiler(
      createCompilerWithFailingRecentSource(),
    );
    expect(
      (await sectionsOf(compiled.id)).some(
        (section) => section.key === RECENT_CONTEXT_SECTION_KEY,
      ),
    ).toBe(true);
    const refs = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM compiled_context_revision_refs
       WHERE compiled_context_id = $1
         AND section = 'recent_conversation_context'`,
      [compiled.id],
    );
    expect(Number(refs.rows[0]!.count)).toBe(0);
    const versions = await database.pool.query<{
      policy_versions: Record<string, unknown>;
    }>(
      `SELECT policy_versions FROM compiled_contexts
       WHERE user_id = $1 AND compiled_context_id = $2`,
      [OWNER, compiled.id],
    );
    expect(
      versions.rows[0]!.policy_versions["recentContextPolicyVersion"],
    ).toBeUndefined();

    await governanceRepository().revokeActivePolicy({
      now: clock(),
      revokedBy: String(OWNER),
    });
    const claim = await responseRepository.claimDispatch({
      champion: testChampion,
      compiledContextId: asCompiledContextId(compiled.id),
      generationCommandId: turn.generation.commandId,
      modelRunAttemptId: turn.generation.attemptId,
      now: clock(),
    });
    expect(claim.outcome).toBe("permitted");
  });

  it("renders an explicit unreadable state for a malformed frozen recent reference", async () => {
    const { compiled, turn } = await prepareRecentTurn();
    await responseRepository.claimDispatch({
      champion: testChampion,
      compiledContextId: asCompiledContextId(compiled.id),
      generationCommandId: turn.generation.commandId,
      modelRunAttemptId: turn.generation.attemptId,
      now: clock(),
    });
    const tampered = (await sectionsOf(compiled.id)).map((section) =>
      section.key === RECENT_CONTEXT_SECTION_KEY
        ? { ...section, reference: 'recent-context:{"version":99}' }
        : section,
    );
    await database.pool.query(
      `UPDATE compiled_contexts SET sections = $3::jsonb
       WHERE user_id = $1 AND compiled_context_id = $2`,
      [OWNER, compiled.id, JSON.stringify(tampered)],
    );
    const metadata = await new PostgresInternalInspectionRepository(
      database.pool,
    ).findGenerationMetadata({
      generationCommandId: asGenerationCommandId(turn.generation.commandId),
      userId: OWNER,
    });
    const recent = metadata!.compiledContext!.recentContext;
    expect(recent).not.toBeNull();
    expect(recent!.unreadableReason).not.toBeNull();
    expect(recent!.selected).toHaveLength(0);
    expect(JSON.stringify(recent)).not.toContain("我住在上海");
  });

  it("serializes concurrent enable and disable so at most one active version survives", async () => {
    const repository = governanceRepository();
    await database.pool.query("DELETE FROM recent_context_policies");
    await Promise.allSettled([
      repository.insertActivePolicy({
        budgetTokens: RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxContextTokens,
        changedBy: String(OWNER),
        compilerVersion: RECENT_CONTEXT_COMPILER_VERSION,
        maxCandidateBytes:
          RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateBytes,
        maxCandidateRows:
          RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxCandidateRows,
        maxSingleEventTokens:
          RECENT_CONTEXT_DEFAULT_POLICY.budgets.maxSingleEventTokens,
        now: clock(),
        readTimeoutMs: RECENT_CONTEXT_DEFAULT_POLICY.budgets.readTimeoutMs,
        selectionPolicyVersion: RECENT_CONTEXT_DEFAULT_POLICY.version,
        selectorPolicyVersion: RECENT_CONTEXT_SELECTION_POLICY_VERSION,
      }),
      repository.revokeActivePolicy({
        now: clock(),
        revokedBy: String(OWNER),
      }),
    ]);
    const activeCount = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM recent_context_policies
       WHERE status = 'active'`,
    );
    expect(Number(activeCount.rows[0]!.count)).toBeLessThanOrEqual(1);
    const state = await repository.findEffectiveState();
    expect(state.enabled).toBe(state.active !== null);
  });
});
