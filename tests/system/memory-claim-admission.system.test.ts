import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
  createEntityService,
  createMemoryClaimService,
  createUserTextConversationService,
  CandidateNotAdmissibleError,
  loadPredicateRegistrySnapshot,
  type AdmitCandidateOutcome,
  type EntityService,
  type MemoryCandidateId,
  type MemoryClaimId,
  type MemoryClaimService,
  type RecordCandidateOutcome,
} from "@sayhear/application";
import {
  createContinuousExchangeService,
  type ContinuousExchangeRepository,
} from "@sayhear/application";
import {
  PostgresContinuousExchangeRepository,
  PostgresEntityRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresMemoryClaimRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

/**
 * SPEC #107 "Claims and admission" (ticket #112), proven against real
 * PostgreSQL: the epistemic combination constraints, ClaimVersion
 * immutability, the candidate terminal fence, the cross-session impression
 * floor, deterministic conflict routing, impression dormancy, and the
 * whole-Claim Forget fence with explicit Reversal. Turns are submitted
 * through the production user-text conversation service; every assertion
 * reads authoritative state back from the database. Day boundaries for the
 * cross-Session floor and the dormancy review are driven by the controllable
 * domain clock.
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

const RESIDENCE = "sh.place.residence";
const PARTNER_OF = "sh.relationship.partner_of";
const STATED_STYLE = "sh.communication.stated_style";

const registrySnapshot = loadPredicateRegistrySnapshot(1);

/** Opaque UUIDv7 generator for fixture rows (domain ID guards reject v4 UUIDs). */
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

describe("Memory Claim admission system seam", () => {
  let database: IsolatedPostgresSchema;
  let claimService: MemoryClaimService;
  let entityService: EntityService;
  let submitTurn: (text: string, locale: "zh-CN" | "en-US") => Promise<string>;
  let startNewDay: () => Promise<void>;
  let eventCounter = 0;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(database.pool).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "memory-claim-test-owner",
      userId: OWNER,
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
    const entityRepository = new PostgresEntityRepository(database.pool);
    entityService = createEntityService({ repository: entityRepository, clock });
    const exchangeService = createContinuousExchangeService({
      clock,
      repository: new PostgresContinuousExchangeRepository(database.pool),
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
      },
      clock,
      dedupeFingerprintSecret: "system-test-secret",
    });
    const conversationService = createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: "neon-production-v1",
      expectedConfigurationFingerprint: "sha256:expected",
      generationPolicy: policy,
      inactivityPolicy: {
        timeoutMs: 1_800_000,
        version: "continuous-exchange-inactivity:v1",
      },
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    submitTurn = async (text, locale) => {
      eventCounter += 1;
      const turn = await conversationService.submit(OWNER, {
        clientEventId: `memory-claim-event-${eventCounter}`,
        clientTurnId: `memory-claim-turn-${eventCounter}`,
        locale,
        text,
        timezone: locale === "zh-CN" ? "Asia/Shanghai" : "America/Los_Angeles",
      });
      return turn.message.revisionId;
    };
    startNewDay = async () => {
      advanceHours(24);
      await exchangeService.scanDueInactivity();
    };
  }, 20_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME;
    await database.pool.query(`
      TRUNCATE TABLE
        relationship_resolver_hints,
        memory_claim_version_qualifier_evidence,
        memory_claim_version_qualifiers,
        memory_consolidation_diffs,
        memory_consolidation_runs,
        memory_forget_reversals,
        memory_forget_evidence_exclusions,
        memory_forget_requests,
        memory_candidate_evidence_links,
        memory_candidates,
        claim_evidence_links,
        memory_claim_versions,
        memory_claims,
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
        evidence_lineage,
        evidence_model_run_attempts,
        evidence_items,
        evidence_source_snapshots,
        conversation_event_revisions,
        conversation_events,
        interaction_turns,
        daily_sessions
      CASCADE
    `);
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
    await entityService.ensureSelfEntity({ userId: OWNER });
  });

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  /** Seed one whole-revision User EvidenceItem the way the fast path would. */
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
    const self = await entityService.findSelfEntity(OWNER);
    if (!self) throw new Error("Self Entity missing in test fixture.");
    return self.entityId;
  }

  async function mappedProposal(input: {
    predicateId: string;
    typedValue: string | readonly string[];
    candidateKind?: "objective" | "impression";
    basis?: "directly_stated" | "inferred";
    objectEntityId?: string | null;
    evidenceItemIds: readonly string[];
  }) {
    return {
      userId: OWNER,
      candidateKind: input.candidateKind ?? ("objective" as const),
      basis: input.basis ?? ("directly_stated" as const),
      resolution: {
        status: "mapped" as const,
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
        temporalStatus: "current" as const,
        validFrom: null,
        validFromPrecision: "unknown" as const,
        validTo: null,
        validToPrecision: "unknown" as const,
      },
      qualifiers: [],
      evidenceItemIds: input.evidenceItemIds,
      lineage: {
        extractionPolicyVersion: "memory-extract-test:v1",
        generationCommandId: null,
        authoritativeModelAttemptId: null,
        modelVersion: "test-model",
        promptVersion: "memory-extract-test-prompt:v1",
        sourceReflectionVersionId: null,
      },
    };
  }

  function candidateIdOf(recorded: RecordCandidateOutcome): MemoryCandidateId {
    if (recorded.outcome !== "recorded") {
      throw new Error(`expected recorded candidate, got ${recorded.outcome}`);
    }
    return recorded.candidateId;
  }

  function claimIdOf(admission: AdmitCandidateOutcome): MemoryClaimId {
    if (
      admission.outcome !== "promoted" &&
      admission.outcome !== "contested" &&
      admission.outcome !== "reinforced"
    ) {
      throw new Error(`expected a claim-bearing outcome, got ${admission.outcome}`);
    }
    return admission.claimId;
  }

  async function recordAndAdmit(
    proposal: Awaited<ReturnType<typeof mappedProposal>>,
  ): Promise<AdmitCandidateOutcome> {
    const recorded = await claimService.recordCandidate(proposal);
    if (recorded.outcome !== "recorded") {
      throw new Error(`expected recorded candidate, got ${recorded.outcome}`);
    }
    return claimService.admitCandidate({
      userId: OWNER,
      candidateId: recorded.candidateId,
    });
  }

  it("admits one direct explicit statement as objective + confirmed with zero repetition (AC 6)", async () => {
    const revision = await submitTurn("我最近搬到上海了。", "zh-CN");
    const evidenceId = await seedEvidence(revision);

    const admission = await recordAndAdmit(
      await mappedProposal({
        predicateId: RESIDENCE,
        typedValue: "上海",
        evidenceItemIds: [evidenceId],
      }),
    );

    expect(admission).toMatchObject({
      outcome: "promoted",
      createdClaim: true,
      conflictResolution: "initial_admission",
      revision: 1,
    });
    const inspection = await claimService.inspectClaim({
      userId: OWNER,
      claimId: claimIdOf(admission),
    });
    expect(inspection?.versions).toHaveLength(1);
    expect(inspection?.versions[0]).toMatchObject({
      kind: "objective",
      epistemicStatus: "confirmed",
      status: "active",
      typedValue: "上海",
    });
    expect(inspection?.claim.currentVersionId).toEqual(
      inspection?.versions[0]?.memoryClaimVersionId,
    );
  });

  it("enforces the two recallable epistemic combinations at the database level (AC 6)", async () => {
    const claimId = createTestUuidV7(clock());
    const versionId = createTestUuidV7(clock());
    const selfVersion = await database.pool.query<{ entity_version_id: string }>(
      `SELECT current_version_id AS entity_version_id FROM entities
       WHERE entity_id = $1`,
      [await selfEntityId()],
    );
    await database.pool.query(
      `INSERT INTO memory_claims (
         memory_claim_id, user_id, canonical_key, subject_entity_id,
         predicate_id, created_at
       ) VALUES ($1, $2, 'k-impression-confirmed', $3, $4, $5)`,
      [claimId, OWNER, await selfEntityId(), RESIDENCE, clock()],
    );

    // kind=impression + epistemic_status=confirmed is not a legal combination;
    // the schema offers no `observed` escape hatch at all.
    await expect(
      database.pool.query(
        `INSERT INTO memory_claim_versions (
           memory_claim_version_id, memory_claim_id, user_id, revision, kind,
           epistemic_status, status, subject_entity_version_id, typed_value,
           temporal_status, valid_from_precision, valid_to_precision,
           last_observed_at, created_by, predicate_registry_version, created_at
         ) VALUES ($1, $2, $3, 1, 'impression', 'confirmed', 'active', $4,
             '"北京"'::jsonb, 'current', 'unknown', 'unknown', $5, 'consolidation', 1, $5)`,
        [versionId, claimId, OWNER, selfVersion.rows[0]!.entity_version_id, clock()],
      ),
    ).rejects.toThrow(/memory_claim_versions_epistemic_combination_check/);
  });

  it("keeps single-Session impressions below the floor and promotes only cross-Session evidence (AC 7)", async () => {
    const revision1 = await submitTurn("我感觉我最近更喜欢直接的表达。", "zh-CN");
    const evidence1 = await seedEvidence(revision1);
    await startNewDay();
    const revision2 = await submitTurn("说实话我这人一直都吃软不吃硬。", "zh-CN");
    const evidence2 = await seedEvidence(revision2);

    const singleSession = await recordAndAdmit(
      await mappedProposal({
        predicateId: STATED_STYLE,
        typedValue: "positive",
        candidateKind: "impression",
        basis: "inferred",
        evidenceItemIds: [evidence1],
      }),
    );
    expect(singleSession).toMatchObject({
      outcome: "below_impression_floor",
      actual: { evidenceItems: 1, dailySessions: 1 },
    });

    // Repeating inside one Session never satisfies the gate (ADR-0039):
    // both items here come from the same Daily Session AND the same revision.
    const sameSessionRepeat = await recordAndAdmit(
      await mappedProposal({
        predicateId: STATED_STYLE,
        typedValue: "positive",
        candidateKind: "impression",
        basis: "inferred",
        evidenceItemIds: [evidence1, evidence1],
      }),
    );
    expect(sameSessionRepeat.outcome).toBe("below_impression_floor");

    const crossSession = await recordAndAdmit(
      await mappedProposal({
        predicateId: STATED_STYLE,
        typedValue: "positive",
        candidateKind: "impression",
        basis: "inferred",
        evidenceItemIds: [evidence1, evidence2],
      }),
    );
    expect(crossSession).toMatchObject({
      outcome: "promoted",
      conflictResolution: "initial_admission",
    });
    const inspection = await claimService.inspectClaim({
      userId: OWNER,
      claimId: claimIdOf(crossSession),
    });
    expect(inspection?.versions[0]).toMatchObject({
      kind: "impression",
      epistemicStatus: "inferred",
      status: "active",
    });

    // The floor was met exactly once: no second claim for the same semantics.
    const claimCount = await database.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM memory_claims WHERE user_id = $1`,
      [OWNER],
    );
    expect(claimCount.rows[0]?.count).toBe("1");
  });

  it("supersedes on a new direct statement, preserves immutable history, and blocks row rewrites (AC 10)", async () => {
    const revision1 = await submitTurn("我住在北京。", "zh-CN");
    const evidence1 = await seedEvidence(revision1);
    const first = await recordAndAdmit(
      await mappedProposal({
        predicateId: RESIDENCE,
        typedValue: "北京",
        evidenceItemIds: [evidence1],
      }),
    );
    expect(first.outcome).toBe("promoted");

    await startNewDay();
    const revision2 = await submitTurn("我搬去上海了。", "zh-CN");
    const evidence2 = await seedEvidence(revision2);
    const second = await recordAndAdmit(
      await mappedProposal({
        predicateId: RESIDENCE,
        typedValue: "上海",
        evidenceItemIds: [evidence2],
      }),
    );
    expect(second).toMatchObject({
      outcome: "promoted",
      createdClaim: false,
      conflictResolution: "temporal_or_correction_supersede",
      revision: 2,
    });

    const claimId = claimIdOf(second);
    const inspection = await claimService.inspectClaim({ userId: OWNER, claimId });
    expect(inspection?.versions).toHaveLength(2);
    expect(inspection?.versions[0]).toMatchObject({ typedValue: "北京" });
    expect(inspection?.versions[1]).toMatchObject({
      typedValue: "上海",
      supersedesVersionId: inspection?.versions[0]?.memoryClaimVersionId,
    });
    expect(inspection?.claim.currentVersionId).toEqual(
      inspection?.versions[1]?.memoryClaimVersionId,
    );

    await expect(
      database.pool.query(
        `UPDATE memory_claim_versions SET typed_value = '"天津"'::jsonb
         WHERE user_id = $1 AND memory_claim_version_id = $2`,
        [OWNER, inspection?.versions[0]?.memoryClaimVersionId],
      ),
    ).rejects.toThrow(/MemoryClaimVersion is immutable/);

    const claimCount = await database.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM memory_claims WHERE user_id = $1`,
      [OWNER],
    );
    expect(claimCount.rows[0]?.count).toBe("1");
  });

  it("routes unresolved inferred mutual exclusion to contested + review_due and never lets inference contest a confirmed statement (AC 10)", async () => {
    const revision1 = await submitTurn("我感觉我说话一向直来直往。", "zh-CN");
    const evidence1 = await seedEvidence(revision1);
    await startNewDay();
    const revision2 = await submitTurn("同事也说我沟通风格很直接。", "zh-CN");
    const evidence2 = await seedEvidence(revision2);

    const first = await recordAndAdmit(
      await mappedProposal({
        predicateId: STATED_STYLE,
        typedValue: "positive",
        candidateKind: "impression",
        basis: "inferred",
        evidenceItemIds: [evidence1, evidence2],
      }),
    );
    expect(first.outcome).toBe("promoted");

    await startNewDay();
    const revision3 = await submitTurn("但家里人常说我其实是拐弯抹角的人。", "zh-CN");
    const evidence3 = await seedEvidence(revision3);
    await startNewDay();
    const revision4 = await submitTurn("想想也确实，我对陌生人才委婉。", "zh-CN");
    const evidence4 = await seedEvidence(revision4);
    const conflict = await recordAndAdmit(
      await mappedProposal({
        predicateId: STATED_STYLE,
        typedValue: "negative",
        candidateKind: "impression",
        basis: "inferred",
        evidenceItemIds: [evidence3, evidence4],
      }),
    );
    expect(conflict).toMatchObject({ outcome: "contested" });

    const inspection = await claimService.inspectClaim({
      userId: OWNER,
      claimId: claimIdOf(conflict),
    });
    expect(inspection?.versions).toHaveLength(2);
    expect(inspection?.versions[1]).toMatchObject({
      epistemicStatus: "contested",
      status: "review_due",
    });
    expect(inspection?.claim.currentVersionId).toEqual(
      inspection?.versions[1]?.memoryClaimVersionId,
    );

    // The user's direct statement resolves the live contest with a new
    // active version (ADR-0040: resolution creates another ClaimVersion).
    await startNewDay();
    const revision5 = await submitTurn("其实我就是喜欢直来直去的沟通。", "zh-CN");
    const evidence5 = await seedEvidence(revision5);
    const resolved = await recordAndAdmit(
      await mappedProposal({
        predicateId: STATED_STYLE,
        typedValue: "positive",
        candidateKind: "objective",
        basis: "directly_stated",
        evidenceItemIds: [evidence5],
      }),
    );
    expect(resolved).toMatchObject({
      outcome: "promoted",
      conflictResolution: "contested_resolved",
    });

    // Inference never auto-contests (or overrides) a confirmed statement.
    // The conflicting impression first meets the cross-Session floor, then
    // routes to pending — not to contested (ADR-0040).
    const revision6 = await submitTurn("有时候又感觉我其实挺委婉的。", "zh-CN");
    const evidence6 = await seedEvidence(revision6);
    await startNewDay();
    const revision7 = await submitTurn("想想上次跟领导汇报，我确实绕了很大一圈。", "zh-CN");
    const evidence7 = await seedEvidence(revision7);
    const pending = await recordAndAdmit(
      await mappedProposal({
        predicateId: STATED_STYLE,
        typedValue: "negative",
        candidateKind: "impression",
        basis: "inferred",
        evidenceItemIds: [evidence6, evidence7],
      }),
    );
    expect(pending.outcome).toBe("pending_conflict");
  });

  it("sends unmapped concepts to needs_predicate_review with the 30-day deadline (AC 9)", async () => {
    const revision = await submitTurn("我每个周末都去观鸟。", "zh-CN");
    const evidenceId = await seedEvidence(revision);
    const recorded = await claimService.recordCandidate({
      userId: OWNER,
      candidateKind: "objective",
      basis: "directly_stated",
      resolution: { status: "unmapped", proposedConcept: "sh.hobby.birdwatching" },
      subjectEntityId: await selfEntityId(),
      subjectEntityMentionId: null,
      objectEntityId: null,
      objectEntityMentionId: null,
      scopeKey: "",
      qualifiers: [],
      temporal: {
        temporalStatus: "current",
        validFrom: null,
        validFromPrecision: "unknown",
        validTo: null,
        validToPrecision: "unknown",
      },
      evidenceItemIds: [evidenceId],
      lineage: {
        extractionPolicyVersion: "memory-extract-test:v1",
        generationCommandId: null,
        authoritativeModelAttemptId: null,
        modelVersion: null,
        promptVersion: null,
        sourceReflectionVersionId: null,
      },
    });
    expect(recorded).toMatchObject({
      outcome: "recorded",
      status: "needs_predicate_review",
    });
    if (recorded.outcome !== "recorded") throw new Error("unreachable");
    const expected = new Date(clock().getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(recorded.reviewDueAt?.toISOString()).toBe(expected.toISOString());
  });

  it("makes rejected candidates terminal: no revival, no identical re-proposal, 7-day expiry from disposition (AC 9)", async () => {
    const revision = await submitTurn("我住在杭州。", "zh-CN");
    const evidenceId = await seedEvidence(revision);
    const proposal = await mappedProposal({
      predicateId: RESIDENCE,
      typedValue: "杭州",
      evidenceItemIds: [evidenceId],
    });
    const recorded = await claimService.recordCandidate(proposal);
    const candidateId = candidateIdOf(recorded);

    const rejected = await claimService.rejectCandidate({
      userId: OWNER,
      candidateId,
      reasonCode: "typed_value_invalid",
    });
    expect(rejected.outcome).toBe("rejected");
    if (rejected.outcome !== "rejected") throw new Error("unreachable");
    const expected = new Date(clock().getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(rejected.terminalContentExpiresAt.toISOString()).toBe(expected.toISOString());

    // Terminal is terminal: the fence trigger blocks any status change.
    await expect(
      database.pool.query(
        `UPDATE memory_candidates SET status = 'accepted'
         WHERE user_id = $1 AND memory_candidate_id = $2`,
        [OWNER, candidateId],
      ),
    ).rejects.toThrow(/Terminal MemoryCandidate disposition cannot change/);

    // The identical Evidence + semantic target can never re-enter (ADR-0046).
    const reproposed = await claimService.recordCandidate(proposal);
    expect(reproposed).toMatchObject({ outcome: "blocked_terminal" });

    // Admission on a terminal candidate fails loudly.
    await expect(
      claimService.admitCandidate({ userId: OWNER, candidateId }),
    ).rejects.toBeInstanceOf(CandidateNotAdmissibleError);
  });

  it("runs the stale content window from the original deadline, not sweeper time (AC 9 / ADR-0051)", async () => {
    const revision = await submitTurn("我周末去观鸟。", "zh-CN");
    const evidenceId = await seedEvidence(revision);
    const recorded = await claimService.recordCandidate({
      userId: OWNER,
      candidateKind: "objective",
      basis: "directly_stated",
      resolution: { status: "unmapped", proposedConcept: "sh.hobby.birdwatching" },
      subjectEntityId: await selfEntityId(),
      subjectEntityMentionId: null,
      objectEntityId: null,
      objectEntityMentionId: null,
      scopeKey: "",
      qualifiers: [],
      temporal: {
        temporalStatus: "current",
        validFrom: null,
        validFromPrecision: "unknown",
        validTo: null,
        validToPrecision: "unknown",
      },
      evidenceItemIds: [evidenceId],
      lineage: {
        extractionPolicyVersion: "memory-extract-test:v1",
        generationCommandId: null,
        authoritativeModelAttemptId: null,
        modelVersion: null,
        promptVersion: null,
        sourceReflectionVersionId: null,
      },
    });
    const candidateId = candidateIdOf(recorded);
    if (recorded.outcome !== "recorded") throw new Error("unreachable");
    const reviewDueAt = recorded.reviewDueAt!;

    advanceHours(24 * 40); // the sweeper runs long after the deadline passed
    const staled = await claimService.staleCandidate({
      userId: OWNER,
      candidateId,
      staleReason: "predicate_review_expired",
    });
    expect(staled.outcome).toBe("stale");
    if (staled.outcome !== "stale") throw new Error("unreachable");
    const expected = new Date(reviewDueAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(staled.terminalContentExpiresAt.toISOString()).toBe(expected.toISOString());
  });

  it("advances impressions to dormant at the 30-day review and re-qualifies only via fresh cross-Session evidence (AC 11)", async () => {
    const revision1 = await submitTurn("我喜欢把话说清楚。", "zh-CN");
    const evidence1 = await seedEvidence(revision1);
    await startNewDay();
    const revision2 = await submitTurn("我一直偏好直接的沟通方式。", "zh-CN");
    const evidence2 = await seedEvidence(revision2);
    const promoted = await recordAndAdmit(
      await mappedProposal({
        predicateId: STATED_STYLE,
        typedValue: "positive",
        candidateKind: "impression",
        basis: "inferred",
        evidenceItemIds: [evidence1, evidence2],
      }),
    );
    expect(promoted.outcome).toBe("promoted");
    const claimId = claimIdOf(promoted);

    // Objective memory never decays: dormancy does not apply (ADR-0041).
    const revision3 = await submitTurn("我住在深圳。", "zh-CN");
    const evidence3 = await seedEvidence(revision3);
    const objective = await recordAndAdmit(
      await mappedProposal({
        predicateId: RESIDENCE,
        typedValue: "深圳",
        evidenceItemIds: [evidence3],
      }),
    );
    expect(
      await claimService.applyImpressionDormancy({
        userId: OWNER,
        claimId: claimIdOf(objective),
      }),
    ).toMatchObject({ outcome: "not_applicable" });

    // Inside the 30-day review cycle: not due.
    advanceHours(24 * 29);
    expect(
      await claimService.applyImpressionDormancy({ userId: OWNER, claimId }),
    ).toMatchObject({ outcome: "not_due" });

    advanceHours(24 * 2); // past the review deadline
    const dormancy = await claimService.applyImpressionDormancy({ userId: OWNER, claimId });
    expect(dormancy).toMatchObject({ outcome: "dormant" });
    const dormantInspection = await claimService.inspectClaim({ userId: OWNER, claimId });
    expect(dormantInspection?.versions).toHaveLength(2);
    expect(dormantInspection?.versions[1]).toMatchObject({
      status: "dormant",
      epistemicStatus: "inferred",
    });

    // One fresh item alone cannot reactivate the dormant impression.
    await startNewDay();
    const revision4 = await submitTurn("聊天的时候我还是更喜欢把话说明白。", "zh-CN");
    const evidence4 = await seedEvidence(revision4);
    const singleFresh = await recordAndAdmit(
      await mappedProposal({
        predicateId: STATED_STYLE,
        typedValue: "positive",
        candidateKind: "impression",
        basis: "inferred",
        evidenceItemIds: [evidence4],
      }),
    );
    expect(singleFresh.outcome).toBe("below_impression_floor");

    await startNewDay();
    const revision5 = await submitTurn("朋友也说我一向直来直往。", "zh-CN");
    const evidence5 = await seedEvidence(revision5);
    const requalified = await recordAndAdmit(
      await mappedProposal({
        predicateId: STATED_STYLE,
        typedValue: "positive",
        candidateKind: "impression",
        basis: "inferred",
        evidenceItemIds: [evidence4, evidence5],
      }),
    );
    expect(requalified).toMatchObject({
      outcome: "promoted",
      conflictResolution: "dormancy_requalified",
    });
  });

  it("fences forgotten claims against promotion and restores them only by explicit Reversal (trust-fence state)", async () => {
    const revision1 = await submitTurn("我住在成都。", "zh-CN");
    const evidence1 = await seedEvidence(revision1);
    const promoted = await recordAndAdmit(
      await mappedProposal({
        predicateId: RESIDENCE,
        typedValue: "成都",
        evidenceItemIds: [evidence1],
      }),
    );
    const claimId = claimIdOf(promoted);

    // Reversal before any forget: honest precondition failure, no admission.
    const revision2 = await submitTurn("你可以记住这个。", "zh-CN");
    expect(
      await claimService.applyForgetReversal({
        userId: OWNER,
        claimId,
        requestEventRevisionId: revision2,
        reversalEvidenceId: await seedEvidence(revision2),
      }),
    ).toMatchObject({ outcome: "not_fenced" });

    const forgotten = await claimService.applyWholeClaimForget({
      userId: OWNER,
      claimId,
      requestEventRevisionId: revision2,
    });
    expect(forgotten).toMatchObject({ outcome: "applied", excludedEvidenceCount: 1 });

    const fenceInspection = await claimService.inspectClaim({ userId: OWNER, claimId });
    expect(fenceInspection?.versions).toHaveLength(2);
    expect(fenceInspection?.versions[1]).toMatchObject({ status: "retracted" });
    expect(fenceInspection?.claim.currentVersionId).toEqual(
      fenceInspection?.versions[1]?.memoryClaimVersionId,
    );

    // Idempotent forget: the fence already holds.
    expect(
      await claimService.applyWholeClaimForget({
        userId: OWNER,
        claimId,
        requestEventRevisionId: revision2,
      }),
    ).toMatchObject({ outcome: "already_fenced" });

    // Re-mention cannot promote through the fence.
    const revision3 = await submitTurn("对了我住在成都。", "zh-CN");
    const evidence3 = await seedEvidence(revision3);
    expect(
      await recordAndAdmit(
        await mappedProposal({
          predicateId: RESIDENCE,
          typedValue: "成都",
          evidenceItemIds: [evidence3],
        }),
      ),
    ).toMatchObject({ outcome: "blocked_forget_fence" });

    // Old Evidence is inside the exclusion set and cannot become reversal evidence.
    expect(
      await claimService.applyForgetReversal({
        userId: OWNER,
        claimId,
        requestEventRevisionId: revision3,
        reversalEvidenceId: evidence1,
      }),
    ).toMatchObject({ outcome: "evidence_ineligible" });

    // The explicit reversal event doubles as new Evidence and releases the
    // fence with a new active ClaimVersion — no permission-only state.
    await startNewDay();
    const revision4 = await submitTurn("你可以重新记住我住成都这件事。", "zh-CN");
    const reversalEvidence = await seedEvidence(revision4);
    const restored = await claimService.applyForgetReversal({
      userId: OWNER,
      claimId,
      requestEventRevisionId: revision4,
      reversalEvidenceId: reversalEvidence,
    });
    expect(restored).toMatchObject({ outcome: "restored" });
    const restoredInspection = await claimService.inspectClaim({ userId: OWNER, claimId });
    expect(restoredInspection?.versions).toHaveLength(3);
    expect(restoredInspection?.versions[2]).toMatchObject({
      status: "active",
      epistemicStatus: "confirmed",
    });
    expect(restoredInspection?.claim.currentVersionId).toEqual(
      restoredInspection?.versions[2]?.memoryClaimVersionId,
    );

    // Old exclusions stay active even after reversal (ADR-0035).
    const excludedRows = await database.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM memory_forget_evidence_exclusions
       WHERE user_id = $1 AND status = 'active'`,
      [OWNER],
    );
    expect(excludedRows.rows[0]?.count).toBe("1");

    // A fresh forget after reversal is a NEW fence, not a noop shadowed by
    // the reversed request.
    const reforgotten = await claimService.applyWholeClaimForget({
      userId: OWNER,
      claimId,
      requestEventRevisionId: revision4,
    });
    expect(reforgotten).toMatchObject({ outcome: "applied" });
  });

  it("parks relationship candidates on unbound parties and admits once both Entities bind", async () => {
    const introText = "介绍一下，这是我伴侣小陈。";
    const introRevision = await submitTurn(introText, "zh-CN");
    const introEvidence = await seedEvidence(introRevision);
    const resolutions = await entityService.resolveMentions({
      userId: OWNER,
      eventRevisionId: introRevision,
      proposals: [
        {
          surfaceForm: "我",
          locatorType: "whole_revision",
          startOffset: null,
          endOffset: null,
          mentionKind: "first_person",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceId: null,
        },
        {
          surfaceForm: "小陈",
          locatorType: "text_span",
          startOffset: introText.indexOf("小陈"),
          endOffset: introText.indexOf("小陈") + 2,
          mentionKind: "named",
          newIntroduction: true,
          entityKindId: "sh.entity.person",
          evidenceId: introEvidence,
        },
      ],
    });
    const partnerResolution = resolutions[1];
    const partnerEntityId =
      partnerResolution?.entityId != null ? partnerResolution.entityId : null;
    expect(partnerResolution?.outcome).toBe("created_unresolved");
    expect(partnerEntityId).toBeTruthy();

    const proposal = await mappedProposal({
      predicateId: PARTNER_OF,
      typedValue: "",
      objectEntityId: partnerEntityId,
      evidenceItemIds: [introEvidence],
    });
    const recorded = await claimService.recordCandidate(proposal);
    expect(recorded.outcome).toBe("recorded");
    const parked = await claimService.admitCandidate({
      userId: OWNER,
      candidateId: candidateIdOf(recorded),
    });
    expect(parked).toMatchObject({ outcome: "needs_entity_resolution" });

    // The entity.resolve gate (#113) commits the binding as a new active
    // EntityVersion (state changes append versions; rows are immutable); the
    // parked candidate admits only once both parties hold active versions.
    const boundVersionId = createTestUuidV7(clock());
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
      [OWNER, partnerEntityId, boundVersionId, clock()],
    );
    await database.pool.query(
      `UPDATE entities SET current_version_id = $3
       WHERE user_id = $1 AND entity_id = $2`,
      [OWNER, partnerEntityId, boundVersionId],
    );

    const admitted = await claimService.admitCandidate({
      userId: OWNER,
      candidateId: candidateIdOf(recorded),
    });
    expect(admitted).toMatchObject({ outcome: "promoted", createdClaim: true });
    const inspection = await claimService.inspectClaim({
      userId: OWNER,
      claimId: claimIdOf(admitted),
    });
    expect(inspection?.claim.objectEntityId).toBe(partnerEntityId);
    expect(inspection?.versions[0]).toMatchObject({
      kind: "objective",
      epistemicStatus: "confirmed",
    });
  });
});
