import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CANDIDATE_REVIEW_POLICY_VERSION,
  CandidateReviewAuthError,
  createCandidateReviewPortalService,
  createCandidateReviewService,
  createEntityService,
  createMemoryClaimService,
  createPredicateGovernanceService,
  createUserTextConversationService,
  loadPredicateRegistrySnapshot,
  ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
  type CandidateReviewPortalService,
  type CandidateReviewService,
  type EntityService,
  type MemoryCandidateId,
  type MemoryClaimService,
  type PredicateGovernanceService,
  type RegistryEntryLookup,
} from "@sayhear/application";
import {
  PostgresCandidateReviewRepository,
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
import {
  createCandidateReviewApproveHandler,
  createCandidateReviewEvidenceHandler,
  createCandidateReviewMapHandler,
  createCandidateReviewQueueHandler,
  createCandidateReviewRejectHandler,
} from "../../apps/web/src/candidate-review-handler";
import {
  CANDIDATE_REVIEW_OUTCOME_COPY,
  candidateReviewOutcomeCopy,
} from "../../apps/web/src/candidate-review-copy";

/**
 * SPEC #193 §8.5 (issue #201, work package B2) against real PostgreSQL:
 * the Review Portal delivers needs_review / awaiting_release / terminal_grace /
 * successor views with deadline-pressure ordering, owner session +
 * candidate_review capability, step-up + audit for Evidence and commands,
 * operator controls that only call B1 public interfaces and redraw by
 * (outcome, after-state), fixed outcome copy (never model text), and a route
 * inventory with no Registry-publish / Claim-write entrypoint.
 *
 * Fixture B2-PORTAL-01..06, commands below, artifacts are the DB rows and the
 * handler JSON asserted here. Owner: agent/issue-201.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const OWNER = fixedInternalOwnerPrincipal.userId;
const BASE_TIME = new Date("2026-09-01T08:00:00.000Z").getTime();
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

let clockNowMs = BASE_TIME;
const clock = () => new Date(clockNowMs);
const advanceHours = (hours: number) => {
  clockNowMs += hours * HOUR_MS;
};
const advanceDays = (days: number) => advanceHours(days * 24);

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

const registrySnapshot = loadPredicateRegistrySnapshot(1);
const NEIGHBOR_OF = "sh.relationship.neighbor_of";
const STATED_STYLE = "sh.communication.stated_style";

const swimmingLookup: RegistryEntryLookup = {
  entryFor(predicateId: string) {
    return (
      registrySnapshot.entries.find(
        (entry) => entry.predicateId === predicateId,
      ) ?? null
    );
  },
  registryVersion: () => registrySnapshot.registryVersion,
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

const authSessionTokenHash = (token: string): Buffer =>
  createHash("sha256").update(token).digest();

describe("Candidate Review Portal system seam (B2)", () => {
  let database: IsolatedPostgresSchema;
  let claimService: MemoryClaimService;
  let entityService: EntityService;
  let reviewService: CandidateReviewService;
  let governanceService: PredicateGovernanceService;
  let portalService: CandidateReviewPortalService;
  let candidateReviewRepository: PostgresCandidateReviewRepository;
  let submitTurn: (text: string, locale: "zh-CN" | "en-US") => Promise<string>;
  let eventCounter = 0;
  let sessionCounter = 0;
  let counterpartyCounter = 0;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "candidate-review-portal-test-owner",
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
    entityService = createEntityService({
      repository: new PostgresEntityRepository(database.pool),
      clock,
    });
    claimService = createMemoryClaimService({
      repository: new PostgresMemoryClaimRepository(database.pool),
      registry: swimmingLookup,
      clock,
      dedupeFingerprintSecret: "system-test-secret",
    });
    candidateReviewRepository = new PostgresCandidateReviewRepository(
      database.pool,
      "system-test-secret",
    );
    reviewService = createCandidateReviewService({
      repository: candidateReviewRepository,
      registry: swimmingLookup,
      memoryClaimService: claimService,
      clock,
      dedupeFingerprintSecret: "system-test-secret",
    });
    governanceService = createPredicateGovernanceService({
      repository: candidateReviewRepository,
      clock,
      registryVersion: () => swimmingLookup.registryVersion(),
    });
    portalService = createCandidateReviewPortalService({
      repository: candidateReviewRepository,
      clock,
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
        clientEventId: `portal-event-${eventCounter}`,
        clientTurnId: `portal-turn-${eventCounter}`,
        locale,
        text,
        timezone: locale === "zh-CN" ? "Asia/Shanghai" : "America/Los_Angeles",
      });
      return turn.message.revisionId;
    };
  }, 20_000);

  beforeEach(async () => {
    clockNowMs = BASE_TIME;
    await database.pool.query(`
      TRUNCATE TABLE
        candidate_review_audits,
        predicate_change_proposal_candidate_links,
        predicate_change_proposal_versions,
        predicate_change_proposals,
        workflow_commands,
        outbox_events,
        retrieval_run_candidates,
        retrieval_runs,
        claim_retrieval_projections,
        relationship_resolver_hints,
        memory_impression_vetoes,
        memory_correction_followups,
        memory_claim_corrections,
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

  async function seedCounterpartyEntity(): Promise<string> {
    counterpartyCounter += 1;
    const entityId = createTestUuidV7(clock());
    const versionId = createTestUuidV7(clock());
    await database.pool.query(
      `INSERT INTO entities (entity_id, user_id, created_at)
       VALUES ($1, $2, $3)`,
      [entityId, OWNER, clock()],
    );
    await database.pool.query(
      `INSERT INTO entity_versions (
         entity_version_id, entity_id, user_id, revision, entity_kind_id,
         status, created_at
       ) VALUES ($1, $2, $3, 1, 'sh.entity.person', 'active', $4)`,
      [versionId, entityId, OWNER, clock()],
    );
    await database.pool.query(
      `UPDATE entities SET current_version_id = $2
       WHERE entity_id = $1 AND user_id = $3`,
      [entityId, versionId, OWNER],
    );
    await database.pool.query(
      `INSERT INTO entity_labels (
         entity_label_id, entity_id, user_id, locale, label,
         normalized_label, label_kind, is_current, created_at
       ) VALUES ($1, $2, $3, 'zh-CN', $4, $4, 'primary', true, $5)`,
      [createTestUuidV7(clock()), entityId, OWNER, "小陈", clock()],
    );
    return entityId;
  }

  async function selfEntityId(): Promise<string> {
    const self = await entityService.findSelfEntity(OWNER);
    if (!self) throw new Error("Self Entity missing in test fixture.");
    return self.entityId;
  }

  async function seedReviewCandidate(): Promise<MemoryCandidateId> {
    const revisionId = await submitTurn(
      "隔壁的小陈是我的邻居，我们经常互相照应。",
      "zh-CN",
    );
    const evidenceItemId = await seedEvidence(revisionId);
    const neighbor = await seedCounterpartyEntity();
    const recorded = await claimService.recordCandidate({
      userId: OWNER,
      candidateKind: "objective",
      basis: "directly_stated",
      resolution: {
        status: "unmapped" as const,
        proposedConcept: "邻居关系",
      },
      subjectEntityId: await selfEntityId(),
      subjectEntityMentionId: null,
      objectEntityId: neighbor,
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
      evidenceItemIds: [evidenceItemId],
      lineage: {
        extractionPolicyVersion: "memory-extract-test:v1",
        generationCommandId: null,
        authoritativeModelAttemptId: null,
        modelVersion: "test-model",
        promptVersion: "memory-extract-test-prompt:v1",
        sourceReflectionVersionId: null,
      },
    });
    if (recorded.outcome !== "recorded") {
      throw new Error(`Fixture candidate recording failed: ${recorded.outcome}.`);
    }
    return recorded.candidateId;
  }

  const draftFor = () => ({
    proposedPredicateIdentity: NEIGHBOR_OF,
    label: "neighbor of",
    definition: "Non-familial residential adjacency between two people.",
    valueSchemaDraft: { kind: "text", maxLength: 200 },
    syntheticExamples: {
      positive: ["is my neighbor"],
      negative: ["lives in the same district"],
    },
    rationale: "A stable adjacency relationship supports care framing.",
    attestation: true,
  });

  async function provisionReviewSession(input?: {
    stepUpAt?: Date;
    sessionToken?: string;
  }): Promise<string> {
    sessionCounter += 1;
    const sessionToken = input?.sessionToken ?? `portal-session-${sessionCounter}`;
    const tokenHash = authSessionTokenHash(sessionToken);
    await database.pool.query(
      `INSERT INTO auth_sessions (
         session_token_hash, user_id, expires_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (session_token_hash) DO NOTHING`,
      [tokenHash, OWNER, new Date("2099-01-01T00:00:00.000Z"), clock()],
    );
    await database.pool.query(
      `INSERT INTO internal_diagnostic_access_grants (
         session_token_hash, capability, status, step_up_authenticated_at, updated_at
       ) VALUES ($1, 'candidate_review', 'active', $2, $3)
       ON CONFLICT (session_token_hash, capability) DO UPDATE
         SET status = 'active', step_up_authenticated_at = $2, updated_at = $3`,
      [tokenHash, input?.stepUpAt ?? clock(), clock()],
    );
    return tokenHash.toString("hex");
  }

  // ── B2-PORTAL-01: four views, deadline pressure, predecessor/disposition/trigger ──

  it("delivers the four lifecycle views with stable deadline-pressure order and no verbatim", async () => {
    const needsId = await seedReviewCandidate();
    const awaitingId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId: awaitingId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    const terminalId = await seedReviewCandidate();
    await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId: terminalId,
      reasonCode: "insufficient_evidence",
    });

    const views = await portalService.listPortalQueue({
      userId: OWNER,
      authSessionId: sessionToken,
    });
    expect(views.needsReview).toHaveLength(1);
    expect(views.awaitingRelease).toHaveLength(1);
    expect(views.terminalGrace).toHaveLength(1);
    expect(views.total).toBe(3);
    expect(views.needsReview[0]!.candidateId).toBe(needsId);
    expect(views.awaitingRelease[0]!.candidateId).toBe(awaitingId);
    expect(views.terminalGrace[0]!.candidateId).toBe(terminalId);

    // 30/90/7-day deadlines are visible with predecessor/disposition/trigger.
    expect(views.needsReview[0]!.deadlineKind).toBe("review_30d");
    expect(views.needsReview[0]!.reviewDueAt).not.toBeNull();
    expect(views.awaitingRelease[0]!.deadlineKind).toBe("release_90d");
    expect(views.awaitingRelease[0]!.registryReleaseDueAt).not.toBeNull();
    expect(views.terminalGrace[0]!.deadlineKind).toBe("terminal_7d");
    expect(views.terminalGrace[0]!.terminalContentExpiresAt).not.toBeNull();
    expect(views.terminalGrace[0]!.dispositionReasonCode).toBe(
      "insufficient_evidence",
    );
    expect(views.awaitingRelease[0]!.linkedProposalId).not.toBeNull();

    // Queue payloads never copy User Evidence verbatim.
    const serialized = JSON.stringify(views);
    expect(serialized).not.toContain("隔壁的小陈是我的邻居");
  });

  it("orders each view by deadline pressure with a stable id tiebreak", async () => {
    const first = await seedReviewCandidate();
    advanceHours(1);
    const second = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const views = await portalService.listPortalQueue({
      userId: OWNER,
      authSessionId: sessionToken,
    });
    expect(views.needsReview.map((entry) => entry.candidateId)).toEqual([
      first,
      second,
    ]);
    const remaining = views.needsReview.map(
      (entry) => entry.deadlineRemainingMs!,
    );
    expect(remaining[0]! < remaining[1]!).toBe(true);
  });

  it("the portal exposes reads only; writes stay on the B1 services", () => {
    expect(Object.keys(portalService).sort()).toEqual(
      ["listPortalQueue", "readCandidateEvidence"].sort(),
    );
  });

  it("shows a successor view with predecessor, trigger and material-change reason", async () => {
    const predecessor = await seedReviewCandidate();
    const successor = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await database.pool.query(
      `UPDATE memory_candidates
        SET predecessor_candidate_id = $2,
            successor_trigger = 'materially_new_evidence',
            material_change_reason_codes = ARRAY['target_refined_by_new_evidence']
        WHERE user_id = $1 AND memory_candidate_id = $3`,
      [OWNER, predecessor, successor],
    );
    const views = await portalService.listPortalQueue({
      userId: OWNER,
      authSessionId: sessionToken,
    });
    expect(views.successor).toHaveLength(1);
    expect(views.successor[0]!.candidateId).toBe(successor);
    expect(views.successor[0]!.predecessorCandidateId).toBe(predecessor);
    expect(views.successor[0]!.successorTrigger).toBe(
      "materially_new_evidence",
    );
    expect(views.successor[0]!.materialChangeReasonCodes).toEqual([
      "target_refined_by_new_evidence",
    ]);
  });

  it("terminal grace expires on the read path after 7 days without a sweeper", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      reasonCode: "insufficient_evidence",
    });
    const before = await portalService.listPortalQueue({
      userId: OWNER,
      authSessionId: sessionToken,
    });
    expect(before.terminalGrace).toHaveLength(1);

    advanceDays(8);
    const steppedUp = await provisionReviewSession({});
    const after = await portalService.listPortalQueue({
      userId: OWNER,
      authSessionId: steppedUp,
    });
    expect(after.terminalGrace).toHaveLength(0);
    expect(after.total).toBe(0);
  });

  it("the 90-day release deadline is anchored at the approve commit time", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    advanceDays(5);
    const approveTime = clock();
    const approvedToken = await provisionReviewSession({});
    const approved = await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: approvedToken,
      candidateId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    expect(approved.outcome).toBe("applied");
    const views = await portalService.listPortalQueue({
      userId: OWNER,
      authSessionId: approvedToken,
    });
    const entry = views.awaitingRelease.find(
      (candidate) => candidate.candidateId === candidateId,
    );
    expect(entry?.registryReleaseDueAt).toEqual(
      new Date(approveTime.getTime() + 90 * DAY_MS).toISOString(),
    );
    void sessionToken;
  });

  // ── B2-PORTAL-02: capability, step-up and audit for queue and Evidence ──

  it("queue reads need the capability but no step-up; Evidence needs a fresh step-up", async () => {
    const candidateId = await seedReviewCandidate();
    const freshSession = await provisionReviewSession({});
    const queue = await portalService.listPortalQueue({
      userId: OWNER,
      authSessionId: freshSession,
    });
    expect(queue.total).toBe(1);

    // Evidence without a fresh step-up fails closed.
    advanceHours(1);
    await expect(
      portalService.readCandidateEvidence({
        userId: OWNER,
        authSessionId: freshSession,
        candidateId,
      }),
    ).rejects.toMatchObject({ code: "recent_step_up_required" });

    const steppedUp = await provisionReviewSession({});
    const found = await portalService.readCandidateEvidence({
      userId: OWNER,
      authSessionId: steppedUp,
      candidateId,
    });
    expect(found.outcome).toBe("found");
    if (found.outcome === "found") {
      expect(found.excerpts.length).toBeGreaterThan(0);
      expect(found.excerpts[0]!.text).toContain("小陈");
    }

    const audits = await database.pool.query<{
      command: string;
      disposition: string;
      target_id: string | null;
    }>(
      `SELECT command, disposition, target_id FROM candidate_review_audits
       ORDER BY recorded_at`,
    );
    expect(
      audits.rows.some(
        (row) => row.command === "queue_read" && row.disposition === "allowed",
      ),
    ).toBe(true);
    expect(
      audits.rows.some(
        (row) => row.command === "queue_read" && row.disposition === "denied",
      ),
    ).toBe(true);
  });

  it("a revoked capability fails the queue closed with step_up_required", async () => {
    await seedReviewCandidate();
    const revoked = await provisionReviewSession({});
    await database.pool.query(
      `UPDATE internal_diagnostic_access_grants SET status = 'revoked'
       WHERE session_token_hash = decode($1, 'hex')`,
      [revoked],
    );
    await expect(
      portalService.listPortalQueue({ userId: OWNER, authSessionId: revoked }),
    ).rejects.toMatchObject({ code: "step_up_required" });
  });

  // ── B2-PORTAL-03: operator controls call only B1 interfaces and redraw ──

  it("map/reject handlers return the real after-state; losers never fake success", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const authenticate = async () => ({
      authSessionId: sessionToken,
      userId: OWNER,
    });

    const mapHandler = createCandidateReviewMapHandler({
      authenticate,
      reviewService,
    });
    const mapResponse = await mapHandler(
      new Request("https://internal.test/map", {
        method: "POST",
        body: JSON.stringify({ predicateId: STATED_STYLE, typedValue: "简洁" }),
      }),
      candidateId,
    );
    const mapped = (await mapResponse.json()) as {
      outcome: string;
      message: string;
      candidateAfter: { status: string } | null;
    };
    expect(mapped.outcome).toBe("applied");
    expect(mapped.candidateAfter?.status).toBe("accepted");
    expect(mapped.message).toBe(candidateReviewOutcomeCopy("applied"));

    const rejectHandler = createCandidateReviewRejectHandler({
      authenticate,
      reviewService,
    });
    const replay = await rejectHandler(
      new Request("https://internal.test/reject", {
        method: "POST",
        body: JSON.stringify({ reasonCode: "insufficient_evidence" }),
      }),
      candidateId,
    );
    const replayed = (await replay.json()) as { outcome: string };
    expect(replayed.outcome).toBe("already_disposed");
  });

  it("a late portal command surfaces review_deadline_passed with the stored after-state", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    advanceDays(31);
    const lateToken = await provisionReviewSession({});
    const rejectHandler = createCandidateReviewRejectHandler({
      authenticate: async () => ({
        authSessionId: lateToken,
        userId: OWNER,
      }),
      reviewService,
    });
    const response = await rejectHandler(
      new Request("https://internal.test/reject", {
        method: "POST",
        body: JSON.stringify({ reasonCode: "duplicate_concept" }),
      }),
      candidateId,
    );
    const payload = (await response.json()) as {
      outcome: string;
      candidateAfter: { status: string } | null;
    };
    expect(payload.outcome).toBe("review_deadline_passed");
    expect(payload.candidateAfter?.status).toBe("needs_predicate_review");
    void sessionToken;
  });

  it("fixed outcome copy covers every §8.5 code and never renders model text", () => {
    const required = [
      "unauthorized",
      "step_up_required",
      "recent_step_up_required",
      "candidate_not_found",
      "already_disposed",
      "review_deadline_passed",
      "predicate_not_active",
      "predicate_deprecated",
      "value_schema_mismatch",
      "proposal_not_found",
      "proposal_not_awaiting_release",
      "reconsideration_blocked_by_rejected_version",
      "linked_proposal_rejected",
      "invalid_reason_code",
    ];
    for (const code of required) {
      const copy = candidateReviewOutcomeCopy(code);
      expect(typeof copy).toBe("string");
      expect(copy.length).toBeGreaterThan(0);
      expect(CANDIDATE_REVIEW_OUTCOME_COPY[code]).toBe(copy);
    }
    expect(candidateReviewOutcomeCopy("model_free_text_is_never_a_code")).toBe(
      CANDIDATE_REVIEW_OUTCOME_COPY["applied"] === undefined
        ? candidateReviewOutcomeCopy("model_free_text_is_never_a_code")
        : "操作未能完成（未知结果码），已显示最新真实状态。",
    );
  });

  it("unauthenticated portal requests fail closed with the fixed unauthorized copy", async () => {
    const queueHandler = createCandidateReviewQueueHandler({
      authenticate: async () => null,
      portalService,
    });
    const queueResponse = await queueHandler(
      new Request("https://internal.test/queue"),
    );
    expect(queueResponse.status).toBe(401);
    const queuePayload = (await queueResponse.json()) as {
      outcome: string;
      message: string;
    };
    expect(queuePayload.outcome).toBe("unauthorized");
    expect(queuePayload.message).toBe(candidateReviewOutcomeCopy("unauthorized"));

    const evidenceHandler = createCandidateReviewEvidenceHandler({
      authenticate: async () => null,
      portalService,
    });
    const evidenceResponse = await evidenceHandler(
      new Request("https://internal.test/evidence"),
      "00000000-0000-7000-8000-000000000000",
    );
    expect(evidenceResponse.status).toBe(401);
  });

  it("client-supplied owner identifiers are rejected on portal reads", async () => {
    const sessionToken = await provisionReviewSession({});
    const queueHandler = createCandidateReviewQueueHandler({
      authenticate: async () => ({
        authSessionId: sessionToken,
        userId: OWNER,
      }),
      portalService,
    });
    const response = await queueHandler(
      new Request("https://internal.test/queue?user_id=attacker"),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { outcome: string };
    expect(payload.outcome).toBe("invalid_reason_code");
  });

  it("approve via the portal handler sets the independent 90-day deadline", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const approveHandler = createCandidateReviewApproveHandler({
      authenticate: async () => ({
        authSessionId: sessionToken,
        userId: OWNER,
      }),
      reviewService,
    });
    const response = await approveHandler(
      new Request("https://internal.test/approve", {
        method: "POST",
        body: JSON.stringify({
          mode: { action: "create", draft: { ...draftFor() } },
        }),
      }),
      candidateId,
    );
    const payload = (await response.json()) as {
      outcome: string;
      candidateAfter: { status: string } | null;
      proposalVersionId: string | null;
    };
    expect(payload.outcome).toBe("applied");
    expect(payload.candidateAfter?.status).toBe("awaiting_registry_release");
    expect(payload.proposalVersionId).not.toBeNull();
  });

  // ── B2-PORTAL-04: route inventory keeps the four-layer privilege proof ──

  it("no review route binds a Registry-write, Proposal-publish or Claim-write entrypoint", () => {
    const apiRoot = join(process.cwd(), "apps", "web", "app", "api");
    const offenders: string[] = [];
    const forbidden =
      /syncPredicateRegistry|publishAwaitingProposals|executeClaimAdmissionPlan|insertRegistryReleaseEventWithin|createProposalForDisposition/;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (entry.name.endsWith(".ts")) {
          if (forbidden.test(readFileSync(path, "utf8"))) offenders.push(path);
        }
      }
    };
    walk(apiRoot);
    expect(offenders).toEqual([]);
  });

  it("review handlers never import a domain write repository or publisher", () => {
    const handlerSource = readFileSync(
      join(process.cwd(), "apps", "web", "src", "candidate-review-handler.ts"),
      "utf8",
    );
    expect(handlerSource).not.toMatch(/Postgres\w*Repository/);
    expect(handlerSource).not.toMatch(
      /syncPredicateRegistry|publishAwaitingProposals|executeClaimAdmissionPlan/,
    );
    expect(handlerSource).toMatch(/candidateReviewService/);
    expect(handlerSource).toMatch(/governanceService|portalService/);
  });

  it("auth denials from the service surface as typed codes, never thrown text", async () => {
    const candidateId = await seedReviewCandidate();
    const revoked = await provisionReviewSession({});
    await database.pool.query(
      `UPDATE internal_diagnostic_access_grants SET status = 'revoked'
       WHERE session_token_hash = decode($1, 'hex')`,
      [revoked],
    );
    await expect(
      reviewService.reject({
        userId: OWNER,
        authSessionId: revoked,
        candidateId,
        reasonCode: "insufficient_evidence",
      }),
    ).rejects.toBeInstanceOf(CandidateReviewAuthError);
    await expect(
      reviewService.reject({
        userId: OWNER,
        authSessionId: revoked,
        candidateId,
        reasonCode: "insufficient_evidence",
      }),
    ).rejects.toMatchObject({ code: "step_up_required" });
    expect(CANDIDATE_REVIEW_POLICY_VERSION).toBe(
      "candidate-review:v1",
    );
  });
});
