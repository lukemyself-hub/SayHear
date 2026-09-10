import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  runMemoryCorrectionFollowupWorkflow,
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
  type ConversationResponseStreamEvent,
  type MemoryClaimService,
  type TrustActionResolutionCandidate,
} from "@sayhear/application";
import {
  loadActionFinalizationReceiptSnapshot,
  PostgresContinuousExchangeRepository,
  PostgresMemoryCorrectionFollowupRepository,
  PostgresConversationResponseRepository,
  PostgresEntityRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresJournalRegenerationActionRepository,
  PostgresMemoryClaimRepository,
  PostgresMemoryRetrievalRepository,
  PostgresMemoryTrustActionCommitPort,
  PostgresMemoryTrustActionTargetSource,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
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
  await database.pool.query(
    "UPDATE app_users SET status = 'active', data_epoch = 1",
  );
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
  reply: string;
}>;

/**
 * The deterministic Champion stand-in: the decision stage emits the scripted
 * trust-action proposal (a provider-native tool call the Egress normalizes),
 * the tools-disabled finalization stage streams the scripted reply.
 */
function createScriptedModel(script: ModelScript): ConversationTextModel {
  return {
    async *stream(request) {
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
): Promise<{ replyText: string; receipt: ActionReceipt | null }> {
  counter += 1;
  const contextCompiler = createContextCompilerForTest();
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
