import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
  createEntityService,
  createMemoryClaimService,
  createOutboxDispatcherService,
  createUserTextConversationService,
  loadPredicateRegistrySnapshot,
  runFastPathExtraction,
  type EntityResolveGateProvider,
  type EntityService,
  type FastPathExtractionEntrypointDependencies,
  type MemoryClaimService,
  type MemoryExtractProvider,
  type MemoryExtractRevisionResult,
} from "@sayhear/application";
import { FAST_PATH_EXTRACTION_POLICY_VERSION } from "@sayhear/application";
import { asMemoryCandidateId, asMemoryClaimId } from "@sayhear/domain";
import {
  PostgresEntityRepository,
  PostgresFastPathExtractionRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresMemoryClaimRepository,
  PostgresOutboxDispatcherRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

/**
 * SPEC #107 "Relationships" (ticket #115, ADR-0027 / 0029 / 0030 / 0031 /
 * 0033 / 0034 / 0036), proven against real PostgreSQL through the fast-path
 * extraction workflow and the deterministic Memory Claim admission: canonical
 * identity (inverse phrasing and mention order create nothing), restarts
 * reusing the logical Claim with new versions, zero relationship-occurrence
 * IDs, evidence-backed Relationship Qualifiers that never touch Claim
 * identity, precision-preserving temporal states, direct third-party
 * relationships with no transitive Self claim, and the rebuildable Resolver
 * Hint projection that reads the current version only.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const BASE_TIME = new Date("2026-08-27T08:00:00.000Z").getTime();

let clockNowMs = BASE_TIME;
const clock = () => new Date(clockNowMs);
const advanceHours = (hours: number) => {
  clockNowMs += hours * 60 * 60 * 1000;
};

const RELATIVE_OF = "sh.relationship.relative_of";
const PARTNER_OF = "sh.relationship.partner_of";
const COLLEAGUE_OF = "sh.relationship.colleague_of";

const registrySnapshot = loadPredicateRegistrySnapshot(1);

/** Registry lookup including the #115 hint-projection accessors. */
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

describe("Relationship Memory Claims system seam (#115)", () => {
  let database: IsolatedPostgresSchema;
  let claimService: MemoryClaimService;
  let entityService: EntityService;
  let conversationService: Awaited<
    ReturnType<typeof createUserTextConversationService>
  >;
  let dispatch: () => Promise<unknown>;
  let submitCount = 0;
  let workflowCounter = 0;

  type ExtractTurn = {
    evidence: { locatorKey: string; role: "factual_support" | "subjective_report" }[];
    mentions: MemoryExtractRevisionResult["mentions"];
    candidates: MemoryExtractRevisionResult["candidates"];
  };

  // Scripted per-turn memory.extract output, keyed by turn order.
  let extractTurns: ExtractTurn[] = [];
  let extractTurnIndex = 0;

  function namedMention(
    text: string,
    surface: string,
    options: { newIntroduction: boolean },
  ): MemoryExtractRevisionResult["mentions"][number] {
    const start = text.indexOf(surface);
    if (start < 0) throw new Error(`surface ${surface} not in text`);
    return {
      surfaceForm: surface,
      startOffset: start,
      endOffset: start + surface.length,
      mentionKind: "named",
      newIntroduction: options.newIntroduction,
      entityKindId: "sh.entity.person",
      evidenceLocatorKey: `0:${text.length}`,
    };
  }

  function firstPersonMention(): MemoryExtractRevisionResult["mentions"][number] {
    return {
      surfaceForm: "我",
      startOffset: null,
      endOffset: null,
      mentionKind: "first_person",
      newIntroduction: false,
      entityKindId: "sh.entity.person",
      evidenceLocatorKey: null,
    };
  }

  /**
   * Submit one turn through the real conversation service, run the real
   * outbox → fast-path extraction workflow with the scripted provider, then
   * run deterministic admission on the produced candidate.
   */
  async function submitExtractAndAdmit(
    text: string,
    plan: Omit<ExtractTurn, "evidence"> & {
      evidence?: ExtractTurn["evidence"];
    },
  ): Promise<{
    admitOutcome: Awaited<ReturnType<MemoryClaimService["admitCandidate"]>>;
    revisionId: string;
  }> {
    submitCount += 1;
    const turn = await conversationService.submit(OWNER, {
      clientEventId: `rel-claim-event-${submitCount}`,
      clientTurnId: `rel-claim-turn-${submitCount}`,
      locale: "zh-CN",
      text,
      timezone: "Asia/Shanghai",
    });
    extractTurns = [
      {
        evidence:
          plan.evidence ?? [
            { locatorKey: `0:${text.length}`, role: "factual_support" },
          ],
        mentions: plan.mentions,
        candidates: plan.candidates,
      },
    ];
    extractTurnIndex = 0;
    await dispatch();
    const candidateRow = await database.pool.query<{
      memory_candidate_id: string;
    }>(
      `SELECT memory_candidate_id FROM memory_candidates
       WHERE user_id = $1 AND status IN ('proposed', 'needs_entity_resolution')
       ORDER BY created_at DESC LIMIT 1`,
      [OWNER],
    );
    expect(candidateRow.rows[0]).toBeTruthy();
    const admitOutcome = await claimService.admitCandidate({
      userId: OWNER,
      candidateId: asMemoryCandidateId(candidateRow.rows[0]!.memory_candidate_id),
    });
    return { admitOutcome, revisionId: turn.message.revisionId };
  }

  /** Fixture binding step: an introduced party's EntityVersion becomes active. */
  async function activateEntityByLabel(label: string): Promise<string> {
    const row = await database.pool.query<{ entity_id: string }>(
      `SELECT e.entity_id FROM entities e
       JOIN entity_labels l ON l.entity_id = e.entity_id AND l.user_id = e.user_id
       JOIN entity_versions v ON v.entity_version_id = e.current_version_id
       WHERE e.user_id = $1 AND l.label = $2 AND l.is_current`,
      [OWNER, label],
    );
    const entityId = row.rows[0]!.entity_id;
    const activeVersionId = createTestUuidV7(clock());
    await database.pool.query(
      `INSERT INTO entity_versions (
         entity_version_id, entity_id, user_id, revision, entity_kind_id,
         status, created_at
       )
       SELECT $3, entity_id, user_id, revision + 1, entity_kind_id, 'active', $4
       FROM entity_versions
       WHERE user_id = $1
         AND entity_version_id = (
           SELECT current_version_id FROM entities
           WHERE entity_id = $2 AND user_id = $1
         )`,
      [OWNER, entityId, activeVersionId, clock()],
    );
    await database.pool.query(
      `UPDATE entities SET current_version_id = $3
       WHERE user_id = $1 AND entity_id = $2`,
      [OWNER, entityId, activeVersionId],
    );
    return entityId;
  }

  async function claimIdByPair(
    entityIdA: string,
    entityIdB: string,
    predicateId: string,
  ): Promise<string> {
    const pair = [entityIdA, entityIdB].sort();
    const row = await database.pool.query<{ memory_claim_id: string }>(
      `SELECT memory_claim_id FROM memory_claims
       WHERE user_id = $1 AND predicate_id = $2
         AND LEAST(subject_entity_id::text, object_entity_id::text) = $3
         AND GREATEST(subject_entity_id::text, object_entity_id::text) = $4`,
      [OWNER, predicateId, pair[0], pair[1]],
    );
    return row.rows[0]!.memory_claim_id;
  }

  async function relationshipClaimCount(): Promise<string> {
    const row = await database.pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM memory_claims WHERE user_id = $1",
      [OWNER],
    );
    return row.rows[0]!.count;
  }

  let selfEntityIdCache: string | null = null;
  async function selfEntityId(): Promise<string> {
    if (selfEntityIdCache) return selfEntityIdCache;
    // The Self Entity provisions lazily in-write; tests that need the id up
    // front converge through the same shared idempotent path.
    const self = await entityService.ensureSelfEntity({ userId: OWNER });
    selfEntityIdCache = self.entityId;
    return selfEntityIdCache;
  }

  /** Fixture: one evidence item citing a real committed revision. */
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
         $4, 'user', 'final', 'whole_revision', '', 'evidence-extraction:v2',
         'factual_support', $5)`,
      [itemId, OWNER, snapshotId, revisionId, clock()],
    );
    return itemId;
  }

  function entrypointDependencies(
    workflowReceiptId: string,
  ): FastPathExtractionEntrypointDependencies {
    const memoryExtract: MemoryExtractProvider = {
      role: "memory.extract",
      async extract(request) {
        const turn = extractTurns[extractTurnIndex];
        extractTurnIndex += 1;
        if (!turn) throw new Error("no scripted extract turn");
        return request.revisions.map((revision) => ({
          revisionId: revision.revisionId,
          evidence: turn.evidence,
          mentions: turn.mentions,
          candidates: turn.candidates,
          clarifications: [],
        }));
      },
    };
    const entityResolve: EntityResolveGateProvider = {
      role: "entity.resolve",
      async resolve() {
        return { verdict: "unclear", entityId: null, confidence: 0 };
      },
    };
    return {
      clock,
      repository: new PostgresFastPathExtractionRepository(database.pool),
      entityService,
      entityRepository: new PostgresEntityRepository(database.pool),
      memoryExtract,
      entityResolve,
      registry: registryLookup,
      policy: {
        version: FAST_PATH_EXTRACTION_POLICY_VERSION,
        visibilityTargetMs: 30_000,
        maxBatchRevisions: 8,
        tAuto: 0.9,
        maxCandidates: 3,
      },
      memoryExtractConfiguration: {
        role: "memory.extract",
        configVersion: "memory-extract-champion:v1",
        modelVersion: "gpt-5.4",
        promptVersion: "memory-extract:propose:v1",
        fallback: { mode: "disabled" },
      },
      entityResolveConfiguration: {
        role: "entity.resolve",
        configVersion: "entity-resolve-champion:v1",
        modelVersion: "gpt-5.4",
        promptVersion: "entity-resolve:gate:v1",
        fallback: { mode: "disabled" },
      },
      evidenceChampion: {
        provider: "openai",
        model: "gpt-5.4",
        configVersion: "memory-extract-champion:v1",
        snapshot: "memory-extract:propose:v1",
        providerPolicyVersion: "openai-conversation-text:v1",
      },
      dedupeFingerprintSecret: "system-test-secret",
      workflowReceiptId,
    };
  }

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    const accessRepository = new PostgresInternalOwnerAccessRepository(
      database.pool,
    );
    await accessRepository.provisionInternalOwner({
      issuer: "https://github.com",
      subject: "relationship-claim-test-owner",
      userId: OWNER,
    });

    entityService = createEntityService({
      repository: new PostgresEntityRepository(database.pool),
      clock,
    });
    claimService = createMemoryClaimService({
      repository: new PostgresMemoryClaimRepository(database.pool),
      registry: registryLookup,
      clock,
      dedupeFingerprintSecret: "system-test-secret",
    });
    const policy = Object.freeze({
      consentPolicyVersion: null,
      freshnessPolicy: "source_valid:v1" as const,
      chineseLocalePackVersion: "locale-pack-zh:v1",
      englishLocalePackVersion: "locale-pack-en:v1",
      harnessPolicyVersion: ACTION_ENABLED_CONVERSATION_HARNESS_POLICY.version,
      conversationActionCatalogVersion:
        JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
      model: "gpt-5.4",
      modelConfigVersion: "conversation-text-champion:v1",
      modelSnapshot: "gpt-5.4",
      outputFormatVersion: "conversation-output:v1",
      canonicalPersonaVersion: "canonical-persona:v1",
      personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
      personaContractInvariantVersion: "persona-contract-invariant:v1",
      productPolicyVersion: "product-policy:v1",
      taskInstructionVersion: "task-instruction-decision:v1",
      provider: "openai" as const,
      providerPolicyVersion: "openai-conversation-text:v1",
      relationshipPolicyVersion: "relationship-boundary:v1",
      safetyPolicyVersion: "minimum-high-risk-response:v1",
    });
    conversationService = createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      fastPathExtractionPolicyVersion: FAST_PATH_EXTRACTION_POLICY_VERSION,
      generationPolicy: policy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    dispatch = async () => {
      const dispatcher = createOutboxDispatcherService({
        clock,
        leaseDurationMs: 60_000,
        leaseOwner: "relationship-claim-system-test",
        repository: new PostgresOutboxDispatcherRepository(database.pool),
        startWorkflow: async (input: {
          workflowCommandId: string;
          policyVersion: string;
        }) => {
          workflowCounter += 1;
          const receipt = `wf-relationship-${workflowCounter}`;
          await runFastPathExtraction({
            dependencies: entrypointDependencies(receipt),
            command: {
              workflowCommandId: input.workflowCommandId,
              policyVersion: input.policyVersion,
            },
          });
          return { workflowReceiptId: receipt };
        },
      });
      return dispatcher.dispatchPending();
    };
  }, 20_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME;
    selfEntityIdCache = null;
    await database.pool.query(`
      TRUNCATE TABLE
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
      CASCADE
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
    await database.pool.end();
  });

  it("canonicalizes inverse phrasing onto one logical Claim with evidence-backed Qualifiers", async () => {
    const selfId = await selfEntityId();

    // Turn 1: direct introduction with a kinship qualifier on 莉莉's side.
    const turn1Text = "莉莉是我姑姑。";
    const turn1 = await submitExtractAndAdmit(turn1Text, {
      mentions: [
        namedMention(turn1Text, "莉莉", { newIntroduction: true }),
        firstPersonMention(),
      ],
      candidates: [
        {
          basis: "directly_stated",
          candidateKind: "objective",
          predicateId: RELATIVE_OF,
          proposedConcept: null,
          typedValue: "",
          scopeKey: "",
          subjectMentionIndex: null,
          objectMentionIndex: 0,
          evidenceLocatorKeys: [`0:${turn1Text.length}`],
          qualifiers: [
            {
              axisId: "kinship_term",
              roleSide: "object",
              typedValue: "姑姑",
              evidenceLocatorKeys: [`0:${turn1Text.length}`],
            },
          ],
          temporal: {
            temporalStatus: "current",
            validFrom: null,
            validFromPrecision: "unknown",
            validTo: null,
            validToPrecision: "unknown",
          },
          itemClass: "person",
          itemSummary: "aunt relationship",
        },
      ],
    });
    expect(turn1.admitOutcome).toMatchObject({
      outcome: "needs_entity_resolution",
    });

    // Introduced parties bind through the entity machinery before admission.
    const lilyId = await activateEntityByLabel("莉莉");
    const promoted = await promoteParkedCandidate();
    expect(promoted).toMatchObject({
      outcome: "promoted",
      createdClaim: true,
      conflictResolution: "initial_admission",
    });
    const claimId = asMemoryClaimId(
      await claimIdByPair(selfId, lilyId, RELATIVE_OF),
    );
    const inspection = await claimService.inspectClaim({
      userId: OWNER,
      claimId,
    });
    expect(inspection?.versions).toHaveLength(1);
    const v1 = inspection?.versions[0]!;
    expect(v1).toMatchObject({
      kind: "objective",
      epistemicStatus: "confirmed",
      temporal: {
        temporalStatus: "current",
        validFrom: null,
        validFromPrecision: "unknown",
      },
    });

    // The qualifier carries its own evidence and lands on the canonical side:
    // the pair is normalized by Entity ID order, mention order never decides.
    expect(inspection?.qualifiers).toHaveLength(1);
    const qualifier = inspection?.qualifiers[0]!;
    expect(qualifier).toMatchObject({ axisId: "kinship_term", typedValue: "姑姑" });
    // 莉莉 was proposed on the candidate's object side; the canonical side
    // follows the sorted Entity-pair order, not mention order.
    expect(qualifier.roleSide).toBe(
      selfId < lilyId ? "counterpart" : "canonical_subject",
    );
    expect(qualifier.evidenceItemIds.length).toBe(1);

    // Resolver Hints: rebuilt from the current version, qualifier term for
    // 莉莉, neutral fallback for the other side, both locales.
    const hints = inspection?.resolverHints ?? [];
    expect(hints).toHaveLength(4);
    expect(
      hints.every(
        (hint) => hint.memoryClaimVersionId === v1.memoryClaimVersionId,
      ),
    ).toBe(true);
    const lilyZh = hints.find(
      (hint) => hint.locale === "zh" && hint.resolvedEntityId === lilyId,
    )!;
    expect(lilyZh).toMatchObject({
      roleTerm: "姑姑",
      roleSource: "qualifier",
      roleAxisId: "kinship_term",
      temporalForm: "current",
      // The pair includes the label-less Self Entity, so no phrase can render.
      phrase: null,
    });
    // The Self side has no Entity label, so the phrase stays null while the
    // structured role term still projects the neutral fallback.
    const selfZh = hints.find(
      (hint) => hint.locale === "zh" && hint.resolvedEntityId === selfId,
    )!;
    expect(selfZh).toMatchObject({
      roleTerm: "亲戚",
      roleSource: "neutral_fallback",
      phrase: null,
    });

    // Turn 2, next day, inverse phrasing: "我是莉莉的侄子" adds the Self-side
    // qualifier — a refinement that advances a version on the SAME claim.
    advanceHours(30);
    const turn2Text = "我是莉莉的侄子。";
    const turn2 = await submitExtractAndAdmit(turn2Text, {
      mentions: [
        namedMention(turn2Text, "莉莉", { newIntroduction: false }),
        firstPersonMention(),
      ],
      candidates: [
        {
          basis: "directly_stated",
          candidateKind: "objective",
          predicateId: RELATIVE_OF,
          proposedConcept: null,
          typedValue: "",
          scopeKey: "",
          subjectMentionIndex: null,
          objectMentionIndex: 0,
          evidenceLocatorKeys: [`0:${turn2Text.length}`],
          qualifiers: [
            {
              axisId: "kinship_term",
              roleSide: "subject",
              typedValue: "侄子",
              evidenceLocatorKeys: [`0:${turn2Text.length}`],
            },
          ],
          temporal: {
            temporalStatus: "current",
            validFrom: null,
            validFromPrecision: "unknown",
            validTo: null,
            validToPrecision: "unknown",
          },
          itemClass: "person",
          itemSummary: "nephew relationship",
        },
      ],
    });
    // The second mention of 莉莉 resolved deterministically, so admission
    // runs on the first attempt.
    expect(turn2.admitOutcome.outcome).toBe("promoted");
    const afterInverse = await claimService.inspectClaim({
      userId: OWNER,
      claimId,
    });
    expect(afterInverse?.versions).toHaveLength(2);
    const v2 = afterInverse?.versions[1]!;
    expect(v2.supersedesVersionId).toBe(v1.memoryClaimVersionId);
    // The merged qualifier set carries 姑姑 with its original evidence.
    expect(afterInverse?.qualifiers.filter((q) => q.memoryClaimVersionId === v2.memoryClaimVersionId)).toHaveLength(2);
    const hintsV2 = afterInverse?.resolverHints ?? [];
    expect(
      hintsV2.every(
        (hint) => hint.memoryClaimVersionId === v2.memoryClaimVersionId,
      ),
    ).toBe(true);
    const selfZhV2 = hintsV2.find(
      (hint) => hint.locale === "zh" && hint.resolvedEntityId === selfId,
    )!;
    expect(selfZhV2.roleTerm).toBe("侄子");

    // Restarted inverse phrasing of the SAME fact creates nothing new: a
    // repeated statement reinforces and the claim count stays at one.
    advanceHours(24);
    const turn3Text = "莉莉是我姑姑。";
    const turn3 = await submitExtractAndAdmit(turn3Text, {
      mentions: [
        namedMention(turn3Text, "莉莉", { newIntroduction: false }),
        firstPersonMention(),
      ],
      candidates: [
        {
          basis: "directly_stated",
          candidateKind: "objective",
          predicateId: RELATIVE_OF,
          proposedConcept: null,
          typedValue: "",
          scopeKey: "",
          subjectMentionIndex: null,
          objectMentionIndex: 0,
          evidenceLocatorKeys: [`0:${turn3Text.length}`],
          qualifiers: [],
          temporal: {
            temporalStatus: "current",
            validFrom: null,
            validFromPrecision: "unknown",
            validTo: null,
            validToPrecision: "unknown",
          },
          itemClass: "person",
          itemSummary: "aunt relationship again",
        },
      ],
    });
    expect(turn3.admitOutcome.outcome).toBe("reinforced");
    const afterRepeat = await claimService.inspectClaim({
      userId: OWNER,
      claimId,
    });
    expect(afterRepeat?.versions).toHaveLength(2);
    expect(await relationshipClaimCount()).toBe("1");

    // The rebuild path reproduces the write-through projection exactly.
    const beforeRebuild = afterRepeat?.resolverHints ?? [];
    const rebuilt = await claimService.rebuildRelationshipResolverHints({
      userId: OWNER,
      claimId,
    });
    expect(rebuilt.rebuiltRows).toBe(beforeRebuild.length);
    const afterRebuild = await claimService.inspectClaim({
      userId: OWNER,
      claimId,
    });
    expect(afterRebuild?.resolverHints).toEqual(
      beforeRebuild.map((hint) => ({
        ...hint,
        relationshipResolverHintId: expect.any(String),
        rebuiltAt: expect.any(Date),
      })),
    );
  });

  it("advances versions for relationship state changes and reuses the Claim on restart", async () => {
    const selfId = await selfEntityId();
    const partnerText1 = "小陈是我的伴侣。";
    await submitExtractAndAdmit(partnerText1, {
      mentions: [
        namedMention(partnerText1, "小陈", { newIntroduction: true }),
        firstPersonMention(),
      ],
      candidates: [
        {
          basis: "directly_stated",
          candidateKind: "objective",
          predicateId: PARTNER_OF,
          proposedConcept: null,
          typedValue: "",
          scopeKey: "",
          subjectMentionIndex: null,
          objectMentionIndex: 0,
          evidenceLocatorKeys: [`0:${partnerText1.length}`],
          qualifiers: [],
          temporal: {
            temporalStatus: "current",
            validFrom: null,
            validFromPrecision: "unknown",
            validTo: null,
            validToPrecision: "unknown",
          },
          itemClass: "person",
          itemSummary: "partner relationship",
        },
      ],
    });
    const partnerId = await activateEntityByLabel("小陈");
    const initial = await promoteParkedCandidate();
    expect(initial).toMatchObject({ outcome: "promoted" });
    const claimId = asMemoryClaimId(
      await claimIdByPair(selfId, partnerId, PARTNER_OF),
    );

    // Ending the relationship is a state change: a new ClaimVersion with
    // temporal_status ended — the Evidence date never becomes a boundary.
    advanceHours(24);
    const breakText = "我和小陈分手了。";
    const ended = await submitExtractAndAdmit(breakText, {
      mentions: [
        namedMention(breakText, "小陈", { newIntroduction: false }),
        firstPersonMention(),
      ],
      candidates: [
        {
          basis: "directly_stated",
          candidateKind: "objective",
          predicateId: PARTNER_OF,
          proposedConcept: null,
          typedValue: "",
          scopeKey: "",
          subjectMentionIndex: null,
          objectMentionIndex: 0,
          evidenceLocatorKeys: [`0:${breakText.length}`],
          qualifiers: [],
          temporal: {
            temporalStatus: "ended",
            validFrom: null,
            validFromPrecision: "unknown",
            validTo: null,
            validToPrecision: "unknown",
          },
          itemClass: "person",
          itemSummary: "partnership ended",
        },
      ],
    });
    expect(ended.admitOutcome).toMatchObject({
      outcome: "promoted",
      conflictResolution: "temporal_or_correction_supersede",
    });
    const endedInspection = await claimService.inspectClaim({
      userId: OWNER,
      claimId,
    });
    expect(endedInspection?.versions).toHaveLength(2);
    const endedVersion = endedInspection?.versions[1]!;
    expect(endedVersion.temporal).toEqual({
      temporalStatus: "ended",
      validFrom: null,
      validFromPrecision: "unknown",
      validTo: null,
      validToPrecision: "unknown",
    });
    // Former projection: ended claims project the registry former templates.
    const endedHints = endedInspection?.resolverHints ?? [];
    expect(endedHints.length).toBeGreaterThan(0);
    for (const hint of endedHints) {
      expect(hint.temporalForm).toBe("former");
      expect(hint.memoryClaimVersionId).toBe(endedVersion.memoryClaimVersionId);
    }

    // Restart: the same pair re-enters the same predicate — the original
    // logical Claim is reused with a new interval version (ADR-0036); no
    // relationship-occurrence identity exists anywhere.
    advanceHours(24);
    const reunionText = "我和小陈复合了。";
    const restarted = await submitExtractAndAdmit(reunionText, {
      mentions: [
        namedMention(reunionText, "小陈", { newIntroduction: false }),
        firstPersonMention(),
      ],
      candidates: [
        {
          basis: "directly_stated",
          candidateKind: "objective",
          predicateId: PARTNER_OF,
          proposedConcept: null,
          typedValue: "",
          scopeKey: "",
          subjectMentionIndex: null,
          objectMentionIndex: 0,
          evidenceLocatorKeys: [`0:${reunionText.length}`],
          qualifiers: [],
          temporal: {
            temporalStatus: "current",
            validFrom: null,
            validFromPrecision: "unknown",
            validTo: null,
            validToPrecision: "unknown",
          },
          itemClass: "person",
          itemSummary: "partnership restarted",
        },
      ],
    });
    expect(restarted.admitOutcome).toMatchObject({
      outcome: "promoted",
      conflictResolution: "claim_reuse_new_interval",
    });
    const finalInspection = await claimService.inspectClaim({
      userId: OWNER,
      claimId,
    });
    expect(finalInspection?.versions).toHaveLength(3);
    const finalVersion = finalInspection?.versions[2]!;
    expect(finalVersion.temporal.temporalStatus).toBe("current");
    // Hints read the CURRENT version only: current form again, derived from
    // the restart version, never from the superseded ended version.
    for (const hint of finalInspection?.resolverHints ?? []) {
      expect(hint.temporalForm).toBe("current");
      expect(hint.memoryClaimVersionId).toBe(finalVersion.memoryClaimVersionId);
    }
    // Symmetric pair normalization: still exactly one logical Claim.
    expect(await relationshipClaimCount()).toBe("1");
  });

  it("preserves boundary precision verbatim and never repurposes Evidence dates", async () => {
    const selfId = await selfEntityId();
    const text = "老周2023年起是我同事。";
    await submitExtractAndAdmit(text, {
      mentions: [
        namedMention(text, "老周", { newIntroduction: true }),
        firstPersonMention(),
      ],
      candidates: [
        {
          basis: "directly_stated",
          candidateKind: "objective",
          predicateId: COLLEAGUE_OF,
          proposedConcept: null,
          typedValue: "",
          scopeKey: "",
          subjectMentionIndex: null,
          objectMentionIndex: 0,
          evidenceLocatorKeys: [`0:${text.length}`],
          qualifiers: [],
          temporal: {
            temporalStatus: "current",
            validFrom: "2023-01-01T00:00:00.000Z",
            validFromPrecision: "year",
            validTo: null,
            validToPrecision: "unknown",
          },
          itemClass: "person",
          itemSummary: "colleague since 2023",
        },
      ],
    });
    const colleagueId = await activateEntityByLabel("老周");
    await promoteParkedCandidate();
    const claimId = asMemoryClaimId(
      await claimIdByPair(selfId, colleagueId, COLLEAGUE_OF),
    );
    const inspection = await claimService.inspectClaim({
      userId: OWNER,
      claimId,
    });
    // The year-precision boundary is preserved verbatim — never upgraded to
    // exact, never overwritten with the Evidence/observation date.
    expect(inspection?.versions[0]!.temporal).toEqual({
      temporalStatus: "current",
      validFrom: new Date("2023-01-01T00:00:00.000Z"),
      validFromPrecision: "year",
      validTo: null,
      validToPrecision: "unknown",
    });
  });

  it("admits a direct third-party relationship and never derives a transitive Self claim", async () => {
    const selfId = await selfEntityId();
    const text = "汤姆是我姐姐莉莉的丈夫。";
    const { admitOutcome } = await submitExtractAndAdmit(text, {
      mentions: [
        namedMention(text, "汤姆", { newIntroduction: true }),
        namedMention(text, "莉莉", { newIntroduction: true }),
        firstPersonMention(),
      ],
      candidates: [
        {
          basis: "directly_stated",
          candidateKind: "objective",
          predicateId: PARTNER_OF,
          proposedConcept: null,
          typedValue: "",
          scopeKey: "",
          subjectMentionIndex: 1,
          objectMentionIndex: 0,
          evidenceLocatorKeys: [`0:${text.length}`],
          qualifiers: [],
          temporal: {
            temporalStatus: "current",
            validFrom: null,
            validFromPrecision: "unknown",
            validTo: null,
            validToPrecision: "unknown",
          },
          itemClass: "person",
          itemSummary: "sister's husband",
        },
      ],
    });
    expect(admitOutcome).toMatchObject({ outcome: "needs_entity_resolution" });
    const lilyId = await activateEntityByLabel("莉莉");
    const tomId = await activateEntityByLabel("汤姆");
    expect(await promoteParkedCandidate()).toMatchObject({
      outcome: "promoted",
    });

    // Exactly one new Claim exists and it connects the two third parties —
    // no closure language produced a Self claim (AC 16, ADR-0031).
    expect(await relationshipClaimCount()).toBe("1");
    const claimId = asMemoryClaimId(
      await claimIdByPair(lilyId, tomId, PARTNER_OF),
    );
    const inspection = await claimService.inspectClaim({
      userId: OWNER,
      claimId,
    });
    expect(inspection?.claim.subjectEntityId).toBe(lilyId);
    expect(inspection?.claim.objectEntityId).toBe(tomId);
    // The third-party hint retains its resolved anchors — both are non-Self.
    for (const hint of inspection?.resolverHints ?? []) {
      expect(hint.resolvedEntityId).not.toBe(selfId);
      expect(hint.contextEntityId).not.toBe(selfId);
    }
  });

  it("drops the projection on whole-Claim Forget and restores it on Reversal", async () => {
    const selfId = await selfEntityId();
    const text = "小林是我的朋友。";
    const { revisionId: introRevision } = await submitExtractAndAdmit(text, {
      mentions: [
        namedMention(text, "小林", { newIntroduction: true }),
        firstPersonMention(),
      ],
      candidates: [
        {
          basis: "directly_stated",
          candidateKind: "objective",
          predicateId: "sh.relationship.friend_of",
          proposedConcept: null,
          typedValue: "",
          scopeKey: "",
          subjectMentionIndex: null,
          objectMentionIndex: 0,
          evidenceLocatorKeys: [`0:${text.length}`],
          qualifiers: [],
          temporal: {
            temporalStatus: "current",
            validFrom: null,
            validFromPrecision: "unknown",
            validTo: null,
            validToPrecision: "unknown",
          },
          itemClass: "person",
          itemSummary: "friend relationship",
        },
      ],
    });
    const xiaolinId = await activateEntityByLabel("小林");
    expect(await promoteParkedCandidate()).toMatchObject({ outcome: "promoted" });
    const claimId = asMemoryClaimId(
      await claimIdByPair(selfId, xiaolinId, "sh.relationship.friend_of"),
    );
    expect(
      (await claimService.inspectClaim({ userId: OWNER, claimId }))?.resolverHints
        .length,
    ).toBeGreaterThan(0);

    // Whole-Claim Forget fences the claim: the projection is deleted in the
    // same transaction — no stale hint survives the fence.
    const forgotten = await claimService.applyWholeClaimForget({
      userId: OWNER,
      claimId,
      requestEventRevisionId: introRevision,
    });
    expect(forgotten).toMatchObject({ outcome: "applied" });
    const afterForget = await claimService.inspectClaim({
      userId: OWNER,
      claimId,
    });
    expect(afterForget?.resolverHints).toEqual([]);
    expect(afterForget?.versions.at(-1)).toMatchObject({ status: "retracted" });

    // Explicit Reversal: the reversal event doubles as new Evidence and the
    // projection rebuilds from the restored current version.
    advanceHours(24);
    submitCount += 1;
    const reversalTurn = await conversationService.submit(OWNER, {
      clientEventId: `rel-claim-event-${submitCount}`,
      clientTurnId: `rel-claim-turn-${submitCount}`,
      locale: "zh-CN",
      text: "我还想继续做小林的朋友。",
      timezone: "Asia/Shanghai",
    });
    const reversalEvidence = await seedEvidence(reversalTurn.message.revisionId);
    const restored = await claimService.applyForgetReversal({
      userId: OWNER,
      claimId,
      requestEventRevisionId: reversalTurn.message.revisionId,
      reversalEvidenceId: reversalEvidence,
    });
    expect(restored).toMatchObject({ outcome: "restored" });
    const afterReversal = await claimService.inspectClaim({
      userId: OWNER,
      claimId,
    });
    const hints = afterReversal?.resolverHints ?? [];
    expect(hints.length).toBeGreaterThan(0);
    const currentVersion = afterReversal?.versions.at(-1)!;
    expect(currentVersion.status).toBe("active");
    for (const hint of hints) {
      expect(hint.memoryClaimVersionId).toBe(currentVersion.memoryClaimVersionId);
    }
  });

  async function promoteParkedCandidate(): Promise<
    Awaited<ReturnType<MemoryClaimService["admitCandidate"]>>
  > {
    const row = await database.pool.query<{ memory_candidate_id: string }>(
      `SELECT memory_candidate_id FROM memory_candidates
       WHERE user_id = $1 AND status = 'needs_entity_resolution'
       ORDER BY created_at DESC LIMIT 1`,
      [OWNER],
    );
    expect(row.rows[0]).toBeTruthy();
    return claimService.admitCandidate({
      userId: OWNER,
      candidateId: row.rows[0]!.memory_candidate_id as never,
    });
  }
});
