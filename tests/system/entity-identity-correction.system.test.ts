import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  ENTITY_IDENTITY_CORRECTION_ACTION_DEFINITION,
  createConversationActionGateway,
  createContinuousExchangeService,
  createEntityIdentityCorrectionActionHandler,
  createEntityService,
  createMemoryClaimService,
  MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
  loadPredicateRegistrySnapshot,
  relationshipHintInputsFor,
  retrievalProjectionInputsFor,
  runEntityIdentityRevalidationWorkflow,
  createUserTextConversationService,
  type MemoryClaimService,
} from "@sayhear/application";
import {
  createUuidV7,
  PostgresEntityIdentityCorrectionCommitPort,
  PostgresEntityIdentityCorrectionTargetSource,
  PostgresEntityIdentityRevalidationRepository,
  PostgresContinuousExchangeRepository,
  PostgresEntityRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresJournalRegenerationActionRepository,
  PostgresMemoryClaimRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import { asCompiledContextId } from "@sayhear/domain";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const BASE_TIME = new Date("2026-08-28T08:00:00.000Z");
let database: IsolatedPostgresSchema;
let clockNow = BASE_TIME.getTime();
let clientSequence = 0;
let claimService: MemoryClaimService;

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

const identityProjectionProvider = {
  relationshipHintsFor(predicateId: string) {
    const entry = registryLookup.entryFor(predicateId);
    return entry ? relationshipHintInputsFor(registryLookup, entry) : null;
  },
  retrievalProjectionFor(predicateId: string) {
    const entry = registryLookup.entryFor(predicateId);
    return entry ? retrievalProjectionInputsFor(registryLookup, entry) : null;
  },
};

const clock = () => new Date(clockNow);

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

function span(text: string, surface: string, fromIndex = 0) {
  const startOffset = text.indexOf(surface, fromIndex);
  if (startOffset < 0) {
    throw new Error(`Fixture surface ${surface} is not present in ${text}.`);
  }
  return {
    locatorType: "text_span" as const,
    startOffset,
    endOffset: startOffset + surface.length,
  };
}

async function submit(text: string) {
  const service = createUserTextConversationService({
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
  const sequence = ++clientSequence;
  return service.submit(OWNER, {
    clientEventId: `identity-correction-event-${sequence}`,
    clientTurnId: `identity-correction-turn-${sequence}`,
    locale: "en-US",
    text,
    timezone: "America/Los_Angeles",
  });
}

async function introduceEntities(text: string, labels: readonly string[]) {
  const turn = await submit(text);
  const entityService = createEntityService({
    clock,
    repository: new PostgresEntityRepository(database.pool),
  });
  const resolutions = await entityService.resolveMentions({
    eventRevisionId: turn.message.revisionId,
    proposals: labels.map((label, index) => ({
      surfaceForm: label,
      ...span(text, label, index === 0 ? 0 : text.indexOf(label)),
      mentionKind: "named" as const,
      newIntroduction: true,
      entityKindId: "sh.entity.person" as const,
      evidenceId: null,
    })),
    userId: OWNER,
  });
  return resolutions.map((resolution) => ({
    entityId: resolution.entityId!,
  }));
}

async function seedEntityLookupWindow(targetLabel: string): Promise<{
  entityId: string;
}> {
  const orderedUuid = (prefix: string, suffix: number) =>
    `${prefix}-0000-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
  const noise = Array.from({ length: 1_001 }, (_, index) => ({
    entityId: orderedUuid("00000000", index + 1),
    entityVersionId: orderedUuid("10000000", index + 1),
    labelId: orderedUuid("20000000", index + 1),
    label: `noise-${index + 1}`,
  }));
  const target = {
    entityId: "ffffffff-ffff-7fff-bfff-ffffffffffff",
    entityVersionId: "efffffff-ffff-7fff-bfff-ffffffffffff",
    labelId: "dfffffff-ffff-7fff-bfff-ffffffffffff",
    label: targetLabel,
  };
  const rows = [...noise, target];
  const entityValues = rows.map((_, index) =>
    `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`,
  );
  await database.pool.query(
    `INSERT INTO entities (entity_id, user_id, created_at)
     VALUES ${entityValues.join(", ")}`,
    rows.flatMap((row) => [row.entityId, OWNER, clock()]),
  );
  const versionValues = rows.map((_, index) => {
    const offset = index * 4;
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, 1,
      'sh.entity.person', 'unresolved', $${offset + 4})`;
  });
  await database.pool.query(
    `INSERT INTO entity_versions (
       entity_version_id, entity_id, user_id, revision, entity_kind_id,
       status, created_at
     ) VALUES ${versionValues.join(", ")}`,
    rows.flatMap((row) => [
      row.entityVersionId,
      row.entityId,
      OWNER,
      clock(),
    ]),
  );
  await database.pool.query(
    `UPDATE entities entity
     SET current_version_id = version.entity_version_id
     FROM entity_versions version
     WHERE entity.user_id = $1
       AND version.user_id = entity.user_id
       AND version.entity_id = entity.entity_id`,
    [OWNER],
  );
  const labelValues = rows.map((_, index) => {
    const offset = index * 6;
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, 'en-US',
      $${offset + 4}, $${offset + 5}, 'primary', TRUE, NULL, $${offset + 6})`;
  });
  await database.pool.query(
    `INSERT INTO entity_labels (
       entity_label_id, entity_id, user_id, locale, label,
       normalized_label, label_kind, is_current, source_evidence_id,
       created_at
     ) VALUES ${labelValues.join(", ")}`,
    rows.flatMap((row) => [
      row.labelId,
      row.entityId,
      OWNER,
      row.label,
      row.label.normalize("NFKC").trim().toLocaleLowerCase("en-US"),
      clock(),
    ]),
  );
  return { entityId: target.entityId };
}

async function seedEvidence(revisionId: string): Promise<{
  evidenceItemId: string;
  evidenceSourceSnapshotId: string;
  dailySessionId: string;
  sourceRevision: number;
}> {
  const snapshotId = createUuidV7(clock());
  const itemId = createUuidV7(clock());
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
  const metadata = await database.pool.query<{
    daily_session_id: string;
    source_revision: number;
  }>(
    `SELECT daily_session_id::text, source_revision::int
     FROM evidence_source_snapshots
     WHERE evidence_source_snapshot_id = $1 AND user_id = $2`,
    [snapshotId, OWNER],
  );
  const row = metadata.rows[0];
  if (!row) throw new Error("Seeded evidence metadata is missing.");
  return {
    dailySessionId: row.daily_session_id,
    evidenceItemId: itemId,
    evidenceSourceSnapshotId: snapshotId,
    sourceRevision: row.source_revision,
  };
}

async function selfEntityId(): Promise<string> {
  const result = await database.pool.query<{ entity_id: string }>(
    `SELECT entity_id::text FROM user_self_entities WHERE user_id = $1`,
    [OWNER],
  );
  const entityId = result.rows[0]?.entity_id;
  if (!entityId) throw new Error("Self Entity missing in test fixture.");
  return entityId;
}

async function admitColleagueClaim(input: {
  objectEntityId: string;
  evidenceItemId: string;
}): Promise<string> {
  const proposal = {
    userId: OWNER,
    candidateKind: "objective" as const,
    basis: "directly_stated" as const,
    resolution: {
      status: "mapped" as const,
      predicateId: "sh.relationship.colleague_of",
      registryVersion: 1,
      typedValue: "",
      mappingConfidence: 0.95,
    },
    subjectEntityId: await selfEntityId(),
    subjectEntityMentionId: null,
    objectEntityId: input.objectEntityId,
    objectEntityMentionId: null,
    scopeKey: "",
    temporal: {
      temporalStatus: "current" as const,
      validFrom: null,
      validFromPrecision: "unknown" as const,
      validTo: null,
      validToPrecision: "unknown" as const,
    },
    qualifiers: [],
    evidenceItemIds: [input.evidenceItemId],
    lineage: {
      extractionPolicyVersion: "identity-correction-test:v1",
      generationCommandId: null,
      authoritativeModelAttemptId: null,
      modelVersion: "test-model",
      promptVersion: "identity-correction-test-prompt:v1",
      sourceReflectionVersionId: null,
    },
  };
  const recorded = await claimService.recordCandidate(proposal);
  if (recorded.outcome !== "recorded") {
    throw new Error(`Expected a recorded claim candidate, got ${recorded.outcome}.`);
  }
  const admitted = await claimService.admitCandidate({
    userId: OWNER,
    candidateId: recorded.candidateId,
  });
  if (
    admitted.outcome !== "promoted" &&
    admitted.outcome !== "contested" &&
    admitted.outcome !== "reinforced"
  ) {
    throw new Error(`Expected an admitted claim, got ${admitted.outcome}.`);
  }
  return admitted.claimId;
}

async function seedJournalStatement(input: {
  evidence: Awaited<ReturnType<typeof seedEvidence>>;
  statementText: string;
}): Promise<string> {
  const journalGenerationCommandId = createUuidV7(clock());
  const journalAttemptId = createUuidV7(clock());
  const journalId = createUuidV7(clock());
  const journalVersionId = createUuidV7(clock());
  const journalStatementId = createUuidV7(clock());
  await database.pool.query(
    `INSERT INTO journal_generation_commands (
       generation_command_id, user_id, daily_session_id, source_revision,
       generation_policy_version, expected_data_epoch, created_at
     ) VALUES ($1, $2, $3, $4, 'journal-generation:v2', 1, $5)`,
    [
      journalGenerationCommandId,
      OWNER,
      input.evidence.dailySessionId,
      input.evidence.sourceRevision,
      clock(),
    ],
  );
  await database.pool.query(
    `INSERT INTO journal_model_run_attempts (
       model_run_attempt_id, generation_command_id, status, created_at
     ) VALUES ($1, $2, 'completed', $3)`,
    [journalAttemptId, journalGenerationCommandId, clock()],
  );
  await database.pool.query(
    `INSERT INTO journals (
       journal_id, user_id, daily_session_id, current_version_id, created_at
     ) VALUES ($1, $2, $3, NULL, $4)`,
    [journalId, OWNER, input.evidence.dailySessionId, clock()],
  );
  await database.pool.query(
    `INSERT INTO journal_versions (
       journal_version_id, journal_id, user_id, daily_session_id,
       source_revision, generation_policy_version, validator_version, locale,
       evidence_source_snapshot_id, status, generation_command_id,
       model_run_attempt_id, generation_kind, created_at
     ) VALUES ($1, $2, $3, $4, $5, 'journal-generation:v2',
       'journal-validator:v1', 'en-US', $6, 'published', $7, $8, 'automatic', $9)`,
    [
      journalVersionId,
      journalId,
      OWNER,
      input.evidence.dailySessionId,
      input.evidence.sourceRevision,
      input.evidence.evidenceSourceSnapshotId,
      journalGenerationCommandId,
      journalAttemptId,
      clock(),
    ],
  );
  await database.pool.query(
    `UPDATE journals SET current_version_id = $1 WHERE journal_id = $2`,
    [journalVersionId, journalId],
  );
  await database.pool.query(
    `INSERT INTO journal_statements (
       journal_statement_id, journal_version_id, statement_index,
       statement_key, statement_text, user_id, source_revision,
       evidence_source_snapshot_id
     ) VALUES ($1, $2, 0, 'identity-correction-test', $3, $4, $5, $6)`,
    [
      journalStatementId,
      journalVersionId,
      input.statementText,
      OWNER,
      input.evidence.sourceRevision,
      input.evidence.evidenceSourceSnapshotId,
    ],
  );
  await database.pool.query(
    `INSERT INTO journal_statement_evidence_links (
       journal_statement_id, evidence_item_id, user_id, source_revision,
       evidence_source_snapshot_id, evidence_role
     ) VALUES ($1, $2, $3, $4, $5, 'factual_support')`,
    [
      journalStatementId,
      input.evidence.evidenceItemId,
      OWNER,
      input.evidence.sourceRevision,
      input.evidence.evidenceSourceSnapshotId,
    ],
  );
  return journalStatementId;
}

function createIdentityGateway() {
  const actionRepository = new PostgresJournalRegenerationActionRepository(
    database.pool,
    "identity-correction-action-secret",
  );
  const commitPort = new PostgresEntityIdentityCorrectionCommitPort();
  const targetSource = new PostgresEntityIdentityCorrectionTargetSource(
    database.pool,
  );
  return createConversationActionGateway({
    entityIdentityCorrectionTargetResolver: targetSource,
    handlers: [
      createEntityIdentityCorrectionActionHandler({ commitPort }),
    ],
    repository: actionRepository,
  });
}

async function admitIdentityCorrection(input: {
  operation: "merge" | "split" | "promote";
  targetAnchor: string;
  relatedTargetAnchor?: string;
  newEntityLabel?: string;
  text: string;
}) {
  const turn = await submit(input.text);
  const gateway = createIdentityGateway();
  const action = await gateway.admit({
    catalog: MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
    context: {
      compiledContextId: asCompiledContextId(createUuidV7(clock())),
      decisionCommandId: turn.generation.commandId,
      requestEventRevisionId: turn.message.revisionId,
      userId: OWNER,
    },
    proposal: {
      actionKind: ENTITY_IDENTITY_CORRECTION_ACTION_DEFINITION.actionKind,
      arguments: {
        operation: input.operation,
        targetAnchor: input.targetAnchor,
        ...(input.relatedTargetAnchor === undefined
          ? {}
          : { relatedTargetAnchor: input.relatedTargetAnchor }),
        ...(input.newEntityLabel === undefined
          ? {}
          : { newEntityLabel: input.newEntityLabel }),
      },
      requestEventRevisionId: turn.message.revisionId,
      schemaVersion: ENTITY_IDENTITY_CORRECTION_ACTION_DEFINITION.schemaVersion,
    },
  });
  return action;
}

async function truncateBusinessSchema() {
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
      current_safety_postures,
      safety_posture_alerts,
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
  await database.pool.query(
    "UPDATE app_users SET status = 'active', data_epoch = 1",
  );
  await database.pool.query("DELETE FROM backup_policy_versions");
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
}

describe("Entity identity correction PostgreSQL seam (issue #121)", () => {
  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "identity-correction-test-owner",
      userId: OWNER,
    });
    claimService = createMemoryClaimService({
      repository: new PostgresMemoryClaimRepository(database.pool),
      registry: registryLookup,
      clock,
      dedupeFingerprintSecret: "identity-correction-test-secret",
    });
  }, 20_000);

  beforeEach(async () => {
    clockNow = BASE_TIME.getTime();
    clientSequence = 0;
    await truncateBusinessSchema();
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  it("merges two user-introduced Entities atomically and revalidates lineage idempotently", async () => {
    const introduced = await introduceEntities(
      "I know Alex and Alexis from work.",
      ["Alex", "Alexis"],
    );
    const action = await admitIdentityCorrection({
      operation: "merge",
      targetAnchor: "Alex",
      relatedTargetAnchor: "Alexis",
      text: "Actually, Alex and Alexis are the same person.",
    });

    expect(action).toMatchObject({
      actionKind: "entity_identity_correction",
      admission: "accepted",
      disposition: "committed_in_transaction",
      execution: "succeeded",
    });

    const versions = await database.pool.query<{
      entity_id: string;
      revision: number;
      status: string;
    }>(
      `SELECT entity_id::text, revision, status
       FROM entity_versions
       WHERE user_id = $1 AND entity_id = ANY($2::uuid[])
       ORDER BY entity_id, revision`,
      [OWNER, introduced.map((entry) => entry.entityId)],
    );
    expect(versions.rows).toHaveLength(4);
    expect(versions.rows.filter((row) => row.status === "merged")).toHaveLength(1);
    expect(versions.rows.filter((row) => row.status === "active")).toHaveLength(1);

    const correction = await database.pool.query<{
      operation: string;
      source_entity_id: string;
      related_entity_id: string;
    }>(
      `SELECT operation, source_entity_id::text, related_entity_id::text
       FROM entity_identity_corrections
       WHERE action_execution_id = $1`,
      [action.actionExecutionId],
    );
    expect(correction.rows[0]).toMatchObject({
      operation: "merge",
      source_entity_id: introduced[0]!.entityId,
      related_entity_id: introduced[1]!.entityId,
    });

    const workflow = await database.pool.query<{ workflow_command_id: string }>(
      `SELECT workflow_command_id::text
       FROM workflow_commands
       WHERE action_execution_id = $1`,
      [action.actionExecutionId],
    );
    expect(workflow.rows).toHaveLength(1);

    const revalidation = new PostgresEntityIdentityRevalidationRepository(
      database.pool,
    );
    const correctionTarget = await database.pool.query<{
      source_entity_id: string;
      source_entity_version_id: string;
    }>(
      `SELECT source_entity_id::text, source_entity_version_id::text
       FROM entity_identity_corrections
       WHERE action_execution_id = $1`,
      [action.actionExecutionId],
    );
    const commandRow = workflow.rows[0]!;
    await database.pool.query(
      `INSERT INTO entity_identity_revalidation_runs (
         entity_identity_revalidation_run_id, user_id, workflow_command_id,
         action_execution_id, source_entity_id, source_entity_version_id,
         status, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7)`,
      [
        createUuidV7(clock()),
        OWNER,
        commandRow.workflow_command_id,
        action.actionExecutionId,
        correctionTarget.rows[0]!.source_entity_id,
        correctionTarget.rows[0]!.source_entity_version_id,
        clock(),
      ],
    );
    const first = await runEntityIdentityRevalidationWorkflow({
      repository: revalidation,
      workflowCommandId: commandRow.workflow_command_id,
    });
    const replay = await runEntityIdentityRevalidationWorkflow({
      repository: revalidation,
      workflowCommandId: commandRow.workflow_command_id,
    });
    expect(first).toMatchObject({
      affectedClaimCount: 0,
      affectedJournalStatementCount: 0,
      outcome: "completed",
      revalidationOutcome: "no_change",
    });
    expect(replay.outcome).toBe("replayed");

    const runCount = await database.pool.query(
      `SELECT count(*) AS count
       FROM entity_identity_revalidation_runs
       WHERE action_execution_id = $1`,
      [action.actionExecutionId],
    );
    expect(Number(runCount.rows[0]!.count)).toBe(1);
  });

  it("finds an exact target beyond the bounded entity lookup window", async () => {
    const turn = await submit("This is Needle.");
    const target = await seedEntityLookupWindow("Needle");
    const resolution = await new PostgresEntityIdentityCorrectionTargetSource(
      database.pool,
    ).resolve({
      operation: "promote",
      requestEventRevisionId: turn.message.revisionId,
      targetAnchor: "Needle",
      userId: OWNER,
    });

    expect(resolution).toMatchObject({
      outcome: "unique",
      target: {
        sourceEntityId: target.entityId,
        sourceEntityVersionStatus: "unresolved",
      },
    });
  });

  it("fences Claim and Journal lineage before restoring only a valid merged target", async () => {
    const [source, related] = await introduceEntities(
      "I know Alex and Alexis from work.",
      ["Alex", "Alexis"],
    );
    await admitIdentityCorrection({
      operation: "promote",
      targetAnchor: "Alexis",
      text: "Alexis is me.",
    });

    const evidenceRevision = await submit("Alexis and I work together.");
    const evidence = await seedEvidence(evidenceRevision.message.revisionId);
    const claimId = await admitColleagueClaim({
      objectEntityId: related!.entityId,
      evidenceItemId: evidence.evidenceItemId,
    });
    const journalStatementId = await seedJournalStatement({
      evidence,
      statementText: "The owner works with Alexis.",
    });

    const action = await admitIdentityCorrection({
      operation: "merge",
      targetAnchor: "Alex",
      relatedTargetAnchor: "Alexis",
      text: "Actually, Alex and Alexis are the same person.",
    });
    const suspended = await database.pool.query<{
      status: string;
      object_entity_version_id: string;
    }>(
      `SELECT version.status, version.object_entity_version_id::text
       FROM memory_claims claim
       INNER JOIN memory_claim_versions version
         ON version.memory_claim_version_id = claim.current_version_id
       WHERE claim.memory_claim_id = $1`,
      [claimId],
    );
    expect(suspended.rows[0]).toMatchObject({
      status: "review_due",
      object_entity_version_id: expect.any(String),
    });
    const pendingFence = await database.pool.query<{
      status: string;
      journal_statement_id: string;
    }>(
      `SELECT status, journal_statement_id::text
       FROM journal_identity_review_fences
       WHERE action_execution_id = $1`,
      [action.actionExecutionId],
    );
    expect(pendingFence.rows).toEqual([
      { status: "identity_review_pending", journal_statement_id: journalStatementId },
    ]);

    const workflow = await database.pool.query<{ workflow_command_id: string }>(
      `SELECT workflow_command_id::text
       FROM workflow_commands
       WHERE action_execution_id = $1`,
      [action.actionExecutionId],
    );
    const revalidation = new PostgresEntityIdentityRevalidationRepository(
      database.pool,
      identityProjectionProvider,
    );
    const result = await runEntityIdentityRevalidationWorkflow({
      repository: revalidation,
      workflowCommandId: workflow.rows[0]!.workflow_command_id,
    });
    expect(result).toMatchObject({
      affectedClaimCount: 1,
      affectedJournalStatementCount: 1,
      outcome: "completed",
      revalidationOutcome: "no_change",
    });

    const current = await database.pool.query<{
      status: string;
      revision: number;
      object_entity_version_id: string;
      current_entity_version_id: string;
    }>(
      `SELECT version.status, version.revision,
              version.object_entity_version_id::text,
              entity.current_version_id::text AS current_entity_version_id
       FROM memory_claims claim
       INNER JOIN memory_claim_versions version
         ON version.memory_claim_version_id = claim.current_version_id
       INNER JOIN entities entity
         ON entity.entity_id = claim.object_entity_id
        AND entity.user_id = claim.user_id
       WHERE claim.memory_claim_id = $1`,
      [claimId],
    );
    expect(current.rows[0]).toMatchObject({
      status: "active",
      revision: 3,
      object_entity_version_id: current.rows[0]?.current_entity_version_id,
    });
    const fence = await database.pool.query<{ status: string }>(
      `SELECT status
       FROM journal_identity_review_fences
       WHERE action_execution_id = $1 AND journal_statement_id = $2`,
      [action.actionExecutionId, journalStatementId],
    );
    expect(fence.rows[0]?.status).toBe("no_change");
    const projection = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM claim_retrieval_projections
       WHERE user_id = $1 AND memory_claim_id = $2 AND status = 'active'`,
      [OWNER, claimId],
    );
    expect(Number(projection.rows[0]!.count)).toBeGreaterThan(0);

    const afterMerge = await submit("Alex called me today.");
    const resolutions = await createEntityService({
      clock,
      repository: new PostgresEntityRepository(database.pool),
    }).resolveMentions({
      eventRevisionId: afterMerge.message.revisionId,
      proposals: [
        {
          surfaceForm: "Alex",
          ...span("Alex called me today.", "Alex"),
          mentionKind: "named",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
      userId: OWNER,
    });
    expect(resolutions[0]?.entityId).toBe(related!.entityId);
    expect(source!.entityId).not.toBe(related!.entityId);
  });

  it("creates a new logical Claim when merge changes a source-side identity", async () => {
    const [source, related] = await introduceEntities(
      "I know Alex and Alexis from work.",
      ["Alex", "Alexis"],
    );
    await admitIdentityCorrection({
      operation: "promote",
      targetAnchor: "Alex",
      text: "Alex is me.",
    });
    const evidenceRevision = await submit("Alex is my colleague.");
    const evidence = await seedEvidence(evidenceRevision.message.revisionId);
    const oldClaimId = await admitColleagueClaim({
      objectEntityId: source!.entityId,
      evidenceItemId: evidence.evidenceItemId,
    });

    const action = await admitIdentityCorrection({
      operation: "merge",
      targetAnchor: "Alex",
      relatedTargetAnchor: "Alexis",
      text: "Actually, Alex and Alexis are the same person.",
    });
    const workflow = await database.pool.query<{ workflow_command_id: string }>(
      `SELECT workflow_command_id::text
       FROM workflow_commands
       WHERE action_execution_id = $1`,
      [action.actionExecutionId],
    );
    const result = await runEntityIdentityRevalidationWorkflow({
      repository: new PostgresEntityIdentityRevalidationRepository(
        database.pool,
        identityProjectionProvider,
      ),
      workflowCommandId: workflow.rows[0]!.workflow_command_id,
    });
    expect(result).toMatchObject({
      affectedClaimCount: 1,
      revalidationOutcome: "no_change",
    });

    const currentTarget = await database.pool.query<{
      entity_version_id: string;
    }>(
      `SELECT current_version_id::text AS entity_version_id
       FROM entities
       WHERE user_id = $1 AND entity_id = $2`,
      [OWNER, related!.entityId],
    );
    const claims = await database.pool.query<{
      memory_claim_id: string;
      canonical_key: string;
      object_entity_id: string;
      status: string;
      object_entity_version_id: string;
    }>(
      `SELECT claim.memory_claim_id::text, claim.canonical_key,
              claim.object_entity_id::text, version.status,
              version.object_entity_version_id::text
       FROM memory_claims claim
       INNER JOIN memory_claim_versions version
         ON version.memory_claim_version_id = claim.current_version_id
       WHERE claim.user_id = $1
         AND claim.predicate_id = 'sh.relationship.colleague_of'
       ORDER BY claim.memory_claim_id`,
      [OWNER],
    );
    expect(claims.rows).toHaveLength(2);
    expect(claims.rows.find((row) => row.memory_claim_id === oldClaimId)).toMatchObject({
      status: "superseded",
    });
    const replacement = claims.rows.find(
      (row) => row.memory_claim_id !== oldClaimId,
    );
    expect(replacement).toMatchObject({
      object_entity_id: related!.entityId,
      object_entity_version_id: currentTarget.rows[0]!.entity_version_id,
      status: "active",
    });
    expect(replacement?.canonical_key).not.toBe(
      claims.rows.find((row) => row.memory_claim_id === oldClaimId)?.canonical_key,
    );
  });

  it("keeps reverse-lineage review fenced when a merge hits a canonical collision", async () => {
    const [source, related] = await introduceEntities(
      "I know Alex and Alexis from work.",
      ["Alex", "Alexis"],
    );
    await admitIdentityCorrection({
      operation: "promote",
      targetAnchor: "Alex",
      text: "Alex is me.",
    });
    await admitIdentityCorrection({
      operation: "promote",
      targetAnchor: "Alexis",
      text: "Alexis is me.",
    });
    const sourceEvidenceRevision = await submit("Alex is my colleague.");
    const sourceEvidence = await seedEvidence(sourceEvidenceRevision.message.revisionId);
    const relatedEvidenceRevision = await submit("Alexis is my colleague.");
    const relatedEvidence = await seedEvidence(relatedEvidenceRevision.message.revisionId);
    const sourceClaimId = await admitColleagueClaim({
      objectEntityId: source!.entityId,
      evidenceItemId: sourceEvidence.evidenceItemId,
    });
    const relatedClaimId = await admitColleagueClaim({
      objectEntityId: related!.entityId,
      evidenceItemId: relatedEvidence.evidenceItemId,
    });
    const journalStatementId = await seedJournalStatement({
      evidence: sourceEvidence,
      statementText: "The owner works with Alex.",
    });

    const action = await admitIdentityCorrection({
      operation: "merge",
      targetAnchor: "Alex",
      relatedTargetAnchor: "Alexis",
      text: "Actually, Alex and Alexis are the same person.",
    });
    const workflow = await database.pool.query<{ workflow_command_id: string }>(
      `SELECT workflow_command_id::text
       FROM workflow_commands
       WHERE action_execution_id = $1`,
      [action.actionExecutionId],
    );
    const result = await runEntityIdentityRevalidationWorkflow({
      repository: new PostgresEntityIdentityRevalidationRepository(
        database.pool,
        identityProjectionProvider,
      ),
      workflowCommandId: workflow.rows[0]!.workflow_command_id,
    });

    expect(result).toMatchObject({
      affectedClaimCount: 2,
      affectedJournalStatementCount: 1,
      outcome: "completed",
      revalidationOutcome: "still_ambiguous",
    });
    const claims = await database.pool.query<{
      memory_claim_id: string;
      status: string;
    }>(
      `SELECT claim.memory_claim_id::text, version.status
       FROM memory_claims claim
       INNER JOIN memory_claim_versions version
         ON version.memory_claim_version_id = claim.current_version_id
       WHERE claim.memory_claim_id = ANY($1::uuid[])
       ORDER BY claim.memory_claim_id`,
      [[sourceClaimId, relatedClaimId]],
    );
    expect(claims.rows).toHaveLength(2);
    expect(claims.rows.find((row) => row.memory_claim_id === sourceClaimId)).toMatchObject({
      status: "review_due",
    });
    expect(claims.rows.find((row) => row.memory_claim_id === relatedClaimId)).toMatchObject({
      status: "active",
    });
    const fence = await database.pool.query<{ status: string }>(
      `SELECT status
       FROM journal_identity_review_fences
       WHERE action_execution_id = $1 AND journal_statement_id = $2`,
      [action.actionExecutionId, journalStatementId],
    );
    expect(fence.rows[0]?.status).toBe("still_ambiguous");
  });

  it("promotes an unresolved Entity after two independent cross-day revisions", async () => {
    const [source] = await introduceEntities("I know Alex.", ["Alex"]);
    const secondTurn = await submit("Alex joined the meeting again today.");
    const secondResolution = await createEntityService({
      clock,
      repository: new PostgresEntityRepository(database.pool),
    }).resolveMentions({
      eventRevisionId: secondTurn.message.revisionId,
      proposals: [
        {
          surfaceForm: "Alex",
          ...span("Alex joined the meeting again today.", "Alex"),
          mentionKind: "named",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
      userId: OWNER,
    });
    expect(secondResolution[0]?.entityId).toBe(source!.entityId);

    clockNow += 24 * 60 * 60 * 1_000;
    await createContinuousExchangeService({
      clock,
      repository: new PostgresContinuousExchangeRepository(database.pool),
    }).scanDueInactivity();
    const thirdTurn = await submit("Alex joined the meeting on another day.");
    const thirdResolution = await createEntityService({
      clock,
      repository: new PostgresEntityRepository(database.pool),
    }).resolveMentions({
      eventRevisionId: thirdTurn.message.revisionId,
      proposals: [
        {
          surfaceForm: "Alex",
          ...span("Alex joined the meeting on another day.", "Alex"),
          mentionKind: "named",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
      ],
      userId: OWNER,
    });
    expect(thirdResolution[0]?.entityId).toBe(source!.entityId);

    const action = await admitIdentityCorrection({
      operation: "promote",
      targetAnchor: "Alex",
      text: "Alex joined the meeting on another day.",
    });
    expect(action).toMatchObject({
      admission: "accepted",
      execution: "succeeded",
    });
    const audit = await database.pool.query<{
      promotion_independent_revision_count: number;
      promotion_explicit_statement: boolean;
    }>(
      `SELECT promotion_independent_revision_count,
              promotion_explicit_statement
       FROM entity_identity_corrections
       WHERE action_execution_id = $1`,
      [action.actionExecutionId],
    );
    expect(audit.rows[0]).toEqual({
      promotion_explicit_statement: false,
      promotion_independent_revision_count: 2,
    });
  });

  it("splits an Entity only when the new identity is explicitly stated", async () => {
    const [source] = await introduceEntities("I know Alex.", ["Alex"]);
    const action = await admitIdentityCorrection({
      operation: "split",
      targetAnchor: "Alex",
      newEntityLabel: "Jamie",
      text: "Actually, Alex and Jamie are different people; Jamie is the other person.",
    });
    expect(action).toMatchObject({
      admission: "accepted",
      execution: "succeeded",
    });
    const entities = await database.pool.query<{
      entity_id: string;
      status: string;
      label: string | null;
    }>(
      `SELECT entity.entity_id::text, version.status, label.label
       FROM entities entity
       INNER JOIN entity_versions version
         ON version.entity_version_id = entity.current_version_id
       LEFT JOIN entity_labels label
         ON label.entity_id = entity.entity_id
        AND label.user_id = entity.user_id
        AND label.label_kind = 'primary'
        AND label.is_current
       WHERE entity.user_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM user_self_entities self
           WHERE self.user_id = entity.user_id
             AND self.entity_id = entity.entity_id
         )
       ORDER BY entity.created_at, entity.entity_id`,
      [OWNER],
    );
    expect(entities.rows).toHaveLength(2);
    expect(entities.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_id: source!.entityId, status: "split" }),
        expect.objectContaining({ label: "Jamie", status: "active" }),
      ]),
    );
  });

  it("promotes an unresolved Entity from an explicit identity statement", async () => {
    const [source] = await introduceEntities("I know Alex.", ["Alex"]);
    const action = await admitIdentityCorrection({
      operation: "promote",
      targetAnchor: "Alex",
      text: "This is Alex, and Alex is me.",
    });

    expect(action).toMatchObject({
      admission: "accepted",
      execution: "succeeded",
    });
    const current = await database.pool.query<{ status: string; revision: number }>(
      `SELECT version.status, version.revision
       FROM entities entity
       INNER JOIN entity_versions version
         ON version.entity_version_id = entity.current_version_id
       WHERE entity.user_id = $1 AND entity.entity_id = $2`,
      [OWNER, source!.entityId],
    );
    expect(current.rows[0]).toEqual({ status: "active", revision: 2 });
  });

  it("does not admit an ordinary mention as identity surgery", async () => {
    await introduceEntities("I know Alex.", ["Alex"]);
    const action = await admitIdentityCorrection({
      operation: "promote",
      targetAnchor: "Alex",
      text: "Alex joined the meeting today.",
    });
    expect(action).toMatchObject({
      admission: "clarification_required",
      disposition: "identity_correction_not_explicit",
      execution: "not_started",
    });
    const correctionCount = await database.pool.query(
      "SELECT count(*) AS count FROM entity_identity_corrections",
    );
    expect(Number(correctionCount.rows[0]!.count)).toBe(0);
  });

  it("does not resolve an identity anchor that the user did not state", async () => {
    await introduceEntities(
      "I know Alex and Alexis from work.",
      ["Alex", "Alexis"],
    );
    const action = await admitIdentityCorrection({
      operation: "merge",
      targetAnchor: "Alex",
      relatedTargetAnchor: "Alexis",
      text: "Actually, Jordan and Taylor are the same person.",
    });

    expect(action).toMatchObject({
      admission: "clarification_required",
      disposition: "identity_target_not_stated",
      execution: "not_started",
    });
    const correctionCount = await database.pool.query(
      "SELECT count(*) AS count FROM entity_identity_corrections",
    );
    expect(Number(correctionCount.rows[0]!.count)).toBe(0);
  });

  it("converges concurrent transport retries on one identity execution", async () => {
    const [source] = await introduceEntities("I know Alex.", ["Alex"]);
    const turn = await submit("Alex is me.");
    const gateway = createIdentityGateway();
    const request = {
      catalog: MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
      context: {
        compiledContextId: asCompiledContextId(createUuidV7(clock())),
        decisionCommandId: turn.generation.commandId,
        requestEventRevisionId: turn.message.revisionId,
        userId: OWNER,
      },
      proposal: {
        actionKind: ENTITY_IDENTITY_CORRECTION_ACTION_DEFINITION.actionKind,
        arguments: { operation: "promote", targetAnchor: "Alex" },
        requestEventRevisionId: turn.message.revisionId,
        schemaVersion: ENTITY_IDENTITY_CORRECTION_ACTION_DEFINITION.schemaVersion,
      },
    };

    const actions = await Promise.all([
      gateway.admit(request),
      gateway.admit(request),
    ]);

    expect(actions[0]?.actionExecutionId).toBe(actions[1]?.actionExecutionId);
    const executions = await database.pool.query(
      `SELECT count(*) AS count
       FROM conversation_action_executions
       WHERE user_id = $1 AND request_event_revision_id = $2`,
      [OWNER, turn.message.revisionId],
    );
    expect(Number(executions.rows[0]!.count)).toBe(1);
    expect(source?.entityId).toBeTruthy();
  });
});
