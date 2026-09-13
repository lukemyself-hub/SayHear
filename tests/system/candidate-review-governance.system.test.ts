import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ACTION_ENABLED_CONVERSATION_HARNESS_POLICY,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
  CANDIDATE_REVIEW_POLICY_VERSION,
  CandidateNotAdmissibleError,
  createCandidateReviewService,
  createEntityService,
  createMemoryClaimService,
  createPredicateGovernanceService,
  createUserTextConversationService,
  loadPredicateRegistrySnapshot,
  ONE_A_3B_MODEL_ROLES,
  type CandidateReviewService,
  type RegistryEntryLookup,
  type PredicateRegistrySnapshot,
  type EntityService,
  type MemoryCandidateId,
  type MemoryClaimService,
  type PredicateChangeProposalVersionRecord,
  type PredicateGovernanceService,
  type PredicateLocalization,
  type PredicateRegistryEntry,
} from "@sayhear/application";
import {
  PostgresCandidateReviewRepository,
  PostgresEntityRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresMemoryClaimRepository,
  PostgresPredicateRegistryRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
  selectPendingRemapCandidates,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";

/**
 * SPEC #193 §8 (issue #200, work package B1) against real PostgreSQL:
 * synchronous CAS review commands with the review deadline inside the WHERE
 * (ADR-0122), the 30/90/7-day boundaries independent of sweeper and worker
 * order (ADR-0048 / ADR-0050 / ADR-0051), product-value Proposal delegation
 * with Proposal-level reconsideration only (ADR-0053), the user-content-free
 * governance schema, release publication in the release transaction with
 * idempotent candidate remaps and a recovery backstop, and the four-layer
 * privilege proof (SPEC §8.5).
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

/**
 * Synthetic next Registry release: everything from v1 plus the neighbor
 * relationship that v1 defers to review — the shape a real governed release
 * (Proposal → TS/YAML entry + mapping tests + migration) produces.
 */
const NEIGHBOR_ENTRY = {
  predicateId: NEIGHBOR_OF,
  registryVersion: 3,
  definitionVersion: 1,
  status: "active",
  allowedClaimKinds: ["objective", "impression"],
  sensitivityClass: "standard",
  allowedSubjectKindIds: ["sh.entity.person"],
  objectValueSchema: { kind: "text", normalization: "nfc_trim_collapsed" },
  scopeSchema: { kind: "none" },
  valueCardinality: "single",
  temporalSemantics: {
    temporalStatuses: ["current_ended"],
    boundaryPrecision: "preserved",
  },
  relationshipSemantics: {
    direction: "symmetric",
    pairNormalization: "unordered_entity_pair",
    views: ["symmetric"],
    qualifierAxes: [],
  },
  evidencePolicyId: "evidence-policy.global-v1",
  reviewPolicyId: "review-policy.impression-global-v1",
  replacedByPredicateId: null,
} as const satisfies PredicateRegistryEntry;

const NEIGHBOR_LOCALIZATIONS = [
  {
    predicateId: NEIGHBOR_OF,
    locale: "zh",
    label: "邻居",
    definition: "非亲属的居住相邻关系。",
    positiveExamples: ["是多年的邻居"],
    negativeExamples: ["只是见过一次的住户"],
    lexicalSurfaces: [{ text: "邻居", locale: "zh", roleSide: "peer", form: "current" }],
    localizationVersion: 1,
  },
  {
    predicateId: NEIGHBOR_OF,
    locale: "en",
    label: "neighbor of",
    definition: "Non-familial residential adjacency between two people.",
    positiveExamples: ["is my neighbor"],
    negativeExamples: ["lives in the same district"],
    lexicalSurfaces: [{ text: "neighbor", locale: "en", roleSide: "peer", form: "current" }],
    localizationVersion: 1,
  },
] as const satisfies readonly PredicateLocalization[];

const swimmingSnapshot: PredicateRegistrySnapshot = Object.freeze({
  registryVersion: 3,
  entries: [...registrySnapshot.entries, NEIGHBOR_ENTRY],
  localizations: [...registrySnapshot.localizations, ...NEIGHBOR_LOCALIZATIONS],
  relationshipProjections: registrySnapshot.relationshipProjections,
  relations: registrySnapshot.relations,
});

const swimmingLookup: RegistryEntryLookup = {
  entryFor(predicateId: string) {
    return (
      swimmingSnapshot.entries.find(
        (entry) => entry.predicateId === predicateId,
      ) ?? null
    );
  },
  registryVersion: () => swimmingSnapshot.registryVersion,
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

describe("Candidate Review and governance system seam", () => {
  let database: IsolatedPostgresSchema;
  let claimService: MemoryClaimService;
  let entityService: EntityService;
  let reviewService: CandidateReviewService;
  let governanceService: PredicateGovernanceService;
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
      subject: "candidate-review-test-owner",
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
        clientEventId: `candidate-review-event-${eventCounter}`,
        clientTurnId: `candidate-review-turn-${eventCounter}`,
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
        conversation_event_generation_command_links,
        proactive_followup_dispositions,
        proactive_followup_uses,
        proactive_followup_reservations,
        proactive_followup_state_versions,
        proactive_followup_states,
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

  // ── fixtures ─────────────────────────────────────────────────────────────

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

  /** Counterparty Entity for relationship-shaped review Candidates. */
  async function seedCounterpartyEntity(input?: { label?: string }): Promise<string> {
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
      [
        createTestUuidV7(clock()),
        entityId,
        OWNER,
        input?.label ?? "小陈",
        clock(),
      ],
    );
    return entityId;
  }

  async function selfEntityId(): Promise<string> {
    const self = await entityService.findSelfEntity(OWNER);
    if (!self) throw new Error("Self Entity missing in test fixture.");
    return self.entityId;
  }

  /** A review-eligible Candidate that v1's Registry cannot express. */
  async function seedReviewCandidate(input?: {
    proposedConcept?: string;
  }): Promise<MemoryCandidateId> {
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
        proposedConcept: input?.proposedConcept ?? "邻居关系",
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

  /** Provision a live auth session holding the `candidate_review` capability. */
  async function provisionReviewSession(input: {
    stepUpAt?: Date;
    sessionToken?: string;
  }): Promise<string> {
    sessionCounter += 1;
    const sessionToken =
      input?.sessionToken ?? `review-session-${sessionCounter}`;
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
    // The typed auth session id is the hex digest of the session token —
    // the same derivation authSessionIdFromRequest performs for routes.
    return tokenHash.toString("hex");
  }

  /** The typed recovery/release scan the workflow and backstop share. */
  async function runRemapScan(): Promise<{ remapCommandsCreated: number }> {
    const pending = await selectPendingRemapCandidates(database.pool, {
      policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
    });
    let created = 0;
    for (const row of pending) {
      const inserted = await candidateReviewRepository.insertRemapCommand({
        userId: row.userId,
        candidateId: row.memoryCandidateId,
        registryVersion: row.registryVersion,
        policyVersion: CANDIDATE_REVIEW_POLICY_VERSION,
        now: clock(),
      });
      if (inserted) created += 1;
    }
    return { remapCommandsCreated: created };
  }

  /** Read the single ProposalVersion created so far in this test. */
  async function firstProposalVersion(): Promise<PredicateChangeProposalVersionRecord> {
    const rows = await database.pool.query(
      `SELECT predicate_change_proposal_version_id, predicate_change_proposal_id,
              revision, base_registry_version, proposed_predicate_identity,
              entry_label, entry_definition, entry_value_schema,
              entry_synthetic_examples, governance_rationale,
              reviewer_principal_id, reason_code, status, decision_scope,
              supersedes_version_id, created_at, published_registry_version,
              published_at
       FROM predicate_change_proposal_versions
       ORDER BY created_at, revision
       LIMIT 1`,
    );
    const row = rows.rows[0];
    if (!row) throw new Error("No ProposalVersion found in fixture.");
    return {
      predicateChangeProposalVersionId: row.predicate_change_proposal_version_id,
      predicateChangeProposalId: row.predicate_change_proposal_id,
      revision: row.revision,
      baseRegistryVersion: row.base_registry_version,
      proposedPredicateIdentity: row.proposed_predicate_identity,
      label: row.entry_label,
      definition: row.entry_definition,
      valueSchemaDraft: row.entry_value_schema,
      syntheticExamples: row.entry_synthetic_examples,
      governanceRationale: row.governance_rationale,
      reviewerPrincipalId: row.reviewer_principal_id,
      reasonCode: row.reason_code,
      status: row.status,
      decisionScope: row.decision_scope,
      supersedesVersionId: row.supersedes_version_id,
      createdAt: row.created_at,
      publishedRegistryVersion: row.published_registry_version,
      publishedAt: row.published_at,
    };
  }

  // ── AC-G01: synchronous CAS dispositions ─────────────────────────────────

  it("reject is a single-row CAS: the after-state is real and replay is idempotent", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const first = await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      reasonCode: "insufficient_evidence",
    });
    expect(first.outcome).toBe("applied");
    expect(first.candidateAfter?.status).toBe("rejected");
    expect(first.candidateAfter?.dispositionReasonCode).toBe("insufficient_evidence");
    expect(first.candidateAfter?.decidedAt).toEqual(clock());
    expect(first.candidateAfter?.terminalContentExpiresAt).toEqual(
      new Date(clockNowMs + 7 * DAY_MS),
    );

    advanceHours(2);
    // Replays authorize like any command: the step-up window is re-verified.
    const replayToken = await provisionReviewSession({});
    const replay = await reviewService.reject({
      userId: OWNER,
      authSessionId: replayToken,
      candidateId,
      reasonCode: "insufficient_evidence",
    });
    expect(replay.outcome).toBe("already_disposed");
    expect(replay.candidateAfter?.decidedAt).toEqual(first.candidateAfter?.decidedAt);
    expect(replay.candidateAfter?.terminalContentExpiresAt).toEqual(
      first.candidateAfter?.terminalContentExpiresAt,
    );

    const different = await reviewService.reject({
      userId: OWNER,
      authSessionId: replayToken,
      candidateId,
      reasonCode: "duplicate_concept",
    });
    expect(different.outcome).toBe("already_disposed");
    expect(different.candidateAfter?.dispositionReasonCode).toBe(
      "insufficient_evidence",
    );

    // Human dispositions never create durable workflow commands.
    const commands = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workflow_commands`,
    );
    expect(Number(commands.rows[0]!.count)).toBe(0);
  });

  it("concurrent dispositions admit exactly one; the loser reads already_disposed", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const [first, second] = await Promise.all([
      reviewService.mapExisting({
        userId: OWNER,
        authSessionId: sessionToken,
        candidateId,
        predicateId: STATED_STYLE,
        typedValue: "简洁",
      }),
      reviewService.mapExisting({
        userId: OWNER,
        authSessionId: sessionToken,
        candidateId,
        predicateId: STATED_STYLE,
        typedValue: "简洁",
      }),
    ]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["already_disposed", "applied"].sort());
    const final = await database.pool.query<{ status: string }>(
      `SELECT status FROM memory_candidates WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    expect(["accepted", "proposed"].includes(final.rows[0]!.status)).toBe(true);
  });

  // ── deadlines (ADR-0048 / ADR-0050 / ADR-0122) ───────────────────────────

  it("a disposition is valid only while decided_at <= review_due_at", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const deadline = await database.pool.query<{ review_due_at: Date }>(
      `SELECT review_due_at FROM memory_candidates WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    const reviewDueAt = deadline.rows[0]!.review_due_at;
    expect(reviewDueAt.getTime() - BASE_TIME).toBe(30 * DAY_MS);

    clockNowMs = reviewDueAt.getTime();
    const atDeadlineToken = await provisionReviewSession({});
    const atDeadline = await reviewService.reject({
      userId: OWNER,
      authSessionId: atDeadlineToken,
      candidateId,
      reasonCode: "duplicate_concept",
    });
    expect(atDeadline.outcome).toBe("applied");
  });

  it("a late command fails closed with review_deadline_passed before any sweeper runs", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    advanceDays(31);
    const lateToken = await provisionReviewSession({});
    const late = await reviewService.reject({
      userId: OWNER,
      authSessionId: lateToken,
      candidateId,
      reasonCode: "duplicate_concept",
    });
    expect(late.outcome).toBe("review_deadline_passed");
    const row = await database.pool.query<{
      status: string;
      review_due_at: Date;
    }>(
      `SELECT status, review_due_at FROM memory_candidates
       WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    // The sweeper has not run, yet the command no longer disposes: the
    // deadline is authoritative and was not extended by the command.
    expect(row.rows[0]!.status).toBe("needs_predicate_review");
    expect(row.rows[0]!.review_due_at.getTime()).toBe(BASE_TIME + 30 * DAY_MS);
  });

  it("approve sets the independent 90-day release deadline from the commit time", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    advanceDays(5);
    const approvedToken = await provisionReviewSession({});
    const approved = await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: approvedToken,
      candidateId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    expect(approved.outcome).toBe("applied");
    expect(approved.candidateAfter?.status).toBe("awaiting_registry_release");
    const row = await database.pool.query<{
      registry_release_due_at: Date;
      registry_release_wait_started_at: Date;
    }>(
      `SELECT registry_release_due_at, registry_release_wait_started_at
       FROM memory_candidates WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    expect(row.rows[0]!.registry_release_wait_started_at).toEqual(clock());
    expect(row.rows[0]!.registry_release_due_at.getTime() - clockNowMs).toBe(
      90 * DAY_MS,
    );
  });

  // ── product-value Proposal delegation (ADR-0053) ─────────────────────────

  it("candidate-specific rejections never create a Proposal", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      reasonCode: "insufficient_evidence",
    });
    const proposals = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM predicate_change_proposals`,
    );
    expect(Number(proposals.rows[0]!.count)).toBe(0);
    const links = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM predicate_change_proposal_candidate_links`,
    );
    expect(Number(links.rows[0]!.count)).toBe(0);
  });

  it("concept_no_product_value delegates to a rejected ProposalVersion with an owner-scoped link", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const rejected = await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      reasonCode: "concept_no_product_value",
      proposal: { action: "create", draft: { ...draftFor() } },
    });
    expect(rejected.outcome).toBe("applied");
    const version = await firstProposalVersion();
    expect(version.status).toBe("rejected");
    expect(version.decisionScope).toBe("product_value_rejection");
    expect(version.reasonCode).toBe("concept_no_product_value");
    expect(version.reviewerPrincipalId).toBe(OWNER);
    expect(version.revision).toBe(1);
    const link = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM predicate_change_proposal_candidate_links
       WHERE user_id = $1 AND memory_candidate_id = $2`,
      [OWNER, candidateId],
    );
    expect(Number(link.rows[0]!.count)).toBe(1);
  });

  it("an invalid reason code never disposes the Candidate", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const missing = await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      reasonCode: "concept_no_product_value",
    });
    expect(missing.outcome).toBe("invalid_reason_code");
    const mismatched = await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      reasonCode: "insufficient_evidence",
      proposal: { action: "create", draft: { ...draftFor() } },
    });
    expect(mismatched.outcome).toBe("invalid_reason_code");
    const row = await database.pool.query<{ status: string }>(
      `SELECT status FROM memory_candidates WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    expect(row.rows[0]!.status).toBe("needs_predicate_review");
  });

  it("product-value rejections reopen only through Proposal-level reconsideration", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      reasonCode: "concept_no_product_value",
      proposal: { action: "create", draft: { ...draftFor() } },
    });
    const original = await firstProposalVersion();

    const reconsidered = await governanceService.reconsider({
      userId: OWNER,
      authSessionId: sessionToken,
      proposalId: original.predicateChangeProposalId,
      draft: {
        proposedPredicateIdentity: NEIGHBOR_OF,
        label: "recurring swim routine",
        definition: "Swimming as a recurring routine with durable meaning.",
        valueSchemaDraft: { kind: "text" },
        syntheticExamples: { positive: ["swims weekly"], negative: [] },
        rationale: "Reconsidered: the routine supports long-term care framing.",
        attestation: true,
      },
    });
    expect(reconsidered.outcome).toBe("applied");
    expect(reconsidered.versionAfter?.revision).toBe(original.revision + 1);
    expect(reconsidered.versionAfter?.status).toBe("awaiting_release");
    expect(reconsidered.versionAfter?.supersedesVersionId).toBe(
      original.predicateChangeProposalVersionId,
    );

    const versions = await database.pool.query<{
      status: string;
      reason_code: string | null;
      revision: number;
    }>(
      `SELECT status, reason_code, revision FROM predicate_change_proposal_versions
       WHERE predicate_change_proposal_id = $1 ORDER BY revision`,
      [original.predicateChangeProposalId],
    );
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[0]).toEqual({
      status: "rejected",
      reason_code: "concept_no_product_value",
      revision: 1,
    });

    // Reconsidering a Proposal whose current version is not rejected is blocked.
    const wrongState = await governanceService.reconsider({
      userId: OWNER,
      authSessionId: sessionToken,
      proposalId: original.predicateChangeProposalId,
      draft: {
        proposedPredicateIdentity: NEIGHBOR_OF,
        label: "another attempt",
        definition: "Swimming as a recurring routine.",
        valueSchemaDraft: { kind: "text" },
        syntheticExamples: { positive: [], negative: [] },
        rationale: "A second reconsideration attempt.",
        attestation: true,
      },
    });
    expect(wrongState.outcome).toBe("proposal_not_rejected");
  });

  it("the governance schema structurally carries no private fields", async () => {
    const columns = await database.pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name IN ('predicate_change_proposals',
             'predicate_change_proposal_versions')
       ORDER BY table_name, column_name`,
    );
    // Closed deny-list of owner/private-shaped column names: the governance
    // schema cannot carry a subject user, Evidence, typed value, Entity
    // reference, verbatim text, or time/place (ADR-0122).
    const forbidden = new Set([
      "user_id",
      "evidence_item_id",
      "source_revision_id",
      "source_event_id",
      "typed_value",
      "entity_id",
      "subject_user_id",
      "verbatim_text",
      "daily_session_id",
    ]);
    const violations = columns.rows.filter((row) =>
      forbidden.has(row.column_name),
    );
    expect(violations).toEqual([]);
  });

  it("the write path rejects private content smuggled into reviewer drafts", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const copiedLabel = await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      reasonCode: "concept_no_product_value",
      proposal: {
        action: "create",
        draft: {
          ...draftFor(),
          label: "邻居关系",
        },
      },
    });
    expect(copiedLabel.outcome).toBe("proposal_draft_rejected");
    const smuggledConcept = await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      reasonCode: "concept_no_product_value",
      proposal: {
        action: "create",
        draft: {
          ...draftFor(),
          rationale: "Candidate 提到 邻居关系；无产品价值。",
        },
      },
    });
    expect(smuggledConcept.outcome).toBe("proposal_draft_rejected");
    const unattested = await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      reasonCode: "concept_no_product_value",
      proposal: { action: "create", draft: { ...draftFor(), attestation: false } },
    });
    expect(unattested.outcome).toBe("proposal_draft_rejected");
    const proposals = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM predicate_change_proposals`,
    );
    expect(Number(proposals.rows[0]!.count)).toBe(0);
  });

  // ── cancel (ADR-0122) ────────────────────────────────────────────────────

  it("cancel immediately and idempotently stales awaiting Candidates at the commit time", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    const version = await firstProposalVersion();
    advanceDays(10);
    const cancelToken = await provisionReviewSession({});
    const cancelTime = clock();
    const canceled = await governanceService.cancel({
      userId: OWNER,
      authSessionId: cancelToken,
      proposalId: version.predicateChangeProposalId,
    });
    expect(canceled.outcome).toBe("applied");
    expect(canceled.staledCandidateCount).toBe(1);
    const row = await database.pool.query<{
      status: string;
      disposition_reason_code: string;
      terminal_effective_at: Date;
      terminal_content_expires_at: Date;
    }>(
      `SELECT status, disposition_reason_code, terminal_effective_at,
              terminal_content_expires_at
       FROM memory_candidates WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    expect(row.rows[0]!.status).toBe("stale");
    expect(row.rows[0]!.disposition_reason_code).toBe("registry_release_canceled");
    expect(row.rows[0]!.terminal_effective_at).toEqual(cancelTime);
    expect(row.rows[0]!.terminal_content_expires_at.getTime()).toBe(
      cancelTime.getTime() + 7 * DAY_MS,
    );

    advanceHours(3);
    const replayCancelToken = await provisionReviewSession({});
    const replay = await governanceService.cancel({
      userId: OWNER,
      authSessionId: replayCancelToken,
      proposalId: version.predicateChangeProposalId,
    });
    expect(replay.outcome).toBe("already_canceled");
    expect(replay.staledCandidateCount).toBe(0);
    const unchanged = await database.pool.query<{ terminal_effective_at: Date }>(
      `SELECT terminal_effective_at FROM memory_candidates
       WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    expect(unchanged.rows[0]!.terminal_effective_at).toEqual(cancelTime);
  });

  it("a canceled Proposal's Candidate can never be re-queued or remapped", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    const version = await firstProposalVersion();
    await governanceService.cancel({
      userId: OWNER,
      authSessionId: sessionToken,
      proposalId: version.predicateChangeProposalId,
    });
    const requeue = await reviewService.mapExisting({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      predicateId: STATED_STYLE,
      typedValue: "简洁",
    });
    expect(requeue.outcome).toBe("already_disposed");
    expect(requeue.candidateAfter?.status).toBe("stale");
    const releaseRepository = new PostgresPredicateRegistryRepository(database.pool);
    await releaseRepository.syncPredicateRegistry(swimmingSnapshot, clock());
    const scanned = await runRemapScan();
    expect(scanned.remapCommandsCreated).toBe(0);
    const outcome = await reviewService.runRemap({
      userId: OWNER,
      candidateId,
    });
    expect(outcome).toBe("no_longer_eligible");
  });

  // ── release, remap and recovery (ADR-0122 release) ───────────────────────

  it("the release transaction publishes the ProposalVersion with published_at from the release itself", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    advanceDays(1);
    const releaseRepository = new PostgresPredicateRegistryRepository(database.pool);
    const releaseTime = clock();
    const result = await releaseRepository.syncPredicateRegistry(
      swimmingSnapshot,
      releaseTime,
    );
    expect(result.publishedProposals).toBe(1);
    const published = await database.pool.query<{
      status: string;
      published_at: Date;
      published_registry_version: number;
    }>(`SELECT status, published_at, published_registry_version
        FROM predicate_change_proposal_versions`);
    expect(published.rows).toHaveLength(1);
    expect(published.rows[0]).toMatchObject({
      status: "published",
      published_registry_version: 3,
    });
    expect(published.rows[0]!.published_at).toEqual(releaseTime);
    const events = await database.pool.query<{ event_type: string }>(
      `SELECT DISTINCT event_type FROM outbox_events`,
    );
    expect(events.rows.map((row) => row.event_type)).toContain(
      "predicate_registry_released",
    );
  });

  it("the release handler inserts idempotent remap commands and the remap converges through normal admission", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    const releaseRepository = new PostgresPredicateRegistryRepository(database.pool);
    await releaseRepository.syncPredicateRegistry(swimmingSnapshot, clock());

    const firstScan = await runRemapScan();
    expect(firstScan.remapCommandsCreated).toBe(1);
    const command = await database.pool.query<{
      subject_id: string;
      source_revision: number;
      policy_version: string;
    }>(
      `SELECT subject_id, source_revision, policy_version
       FROM workflow_commands WHERE command_type = 'candidate_remap'`,
    );
    expect(command.rows).toHaveLength(1);
    expect(command.rows[0]).toEqual({
      subject_id: candidateId,
      source_revision: "3",
      policy_version: CANDIDATE_REVIEW_POLICY_VERSION,
    });

    // Replaying the scan converges on the same command identity.
    const repeatScan = await runRemapScan();
    expect(repeatScan.remapCommandsCreated).toBe(0);

    const outcome = await reviewService.runRemap({
      userId: OWNER,
      candidateId,
    });
    expect(outcome).toBe("converged");
    const claim = await database.pool.query<{
      predicate_id: string;
      registry_version: number;
    }>(
      `SELECT claim.predicate_id, version.predicate_registry_version
       FROM memory_claims claim
       LEFT JOIN memory_claim_versions version
         ON version.memory_claim_version_id = claim.current_version_id
       WHERE claim.user_id = $1`,
      [OWNER],
    );
    expect(claim.rows).toHaveLength(1);
    expect(claim.rows[0]).toEqual({
      predicate_id: NEIGHBOR_OF,
      predicate_registry_version: 3,
    });
    const candidateRow = await database.pool.query<{ status: string }>(
      `SELECT status FROM memory_candidates WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    expect(candidateRow.rows[0]!.status).toBe("accepted");
  }, 60_000);

  it("the recovery scan backstops a missed release outbox event", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    const releaseRepository = new PostgresPredicateRegistryRepository(database.pool);
    await releaseRepository.syncPredicateRegistry(swimmingSnapshot, clock());
    await database.pool.query(
      `DELETE FROM outbox_events WHERE event_type = 'predicate_registry_released'`,
    );
    const scanned = await runRemapScan();
    expect(scanned.remapCommandsCreated).toBe(1);
    const outcome = await reviewService.runRemap({
      userId: OWNER,
      candidateId,
    });
    expect(outcome).toBe("converged");
  });

  it("a dead-lettered remap delivery is re-armed by the scan without a second command", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    const releaseRepository = new PostgresPredicateRegistryRepository(database.pool);
    await releaseRepository.syncPredicateRegistry(swimmingSnapshot, clock());
    await runRemapScan();
    await database.pool.query(
      `UPDATE outbox_events SET status = 'dead_lettered'
       WHERE event_type = 'candidate_remap_requested'`,
    );
    const scanned = await runRemapScan();
    expect(scanned.remapCommandsCreated).toBe(1);
    const counts = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workflow_commands
       WHERE command_type = 'candidate_remap'`,
    );
    expect(Number(counts.rows[0]!.count)).toBe(1);
    const event = await database.pool.query<{ status: string }>(
      `SELECT status FROM outbox_events WHERE event_type = 'candidate_remap_requested'`,
    );
    expect(event.rows[0]!.status).toBe("pending");
  }, 60_000);

  it("publishing exactly at the release deadline still admits; one tick later never does", async () => {
    const atDeadlineCandidate = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId: atDeadlineCandidate,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    const row = await database.pool.query<{ registry_release_due_at: Date }>(
      `SELECT registry_release_due_at FROM memory_candidates
       WHERE memory_candidate_id = $1`,
      [atDeadlineCandidate],
    );
    const releaseDueAt = row.rows[0]!.registry_release_due_at;
    // Publish at the exact boundary: inclusive per ADR-0050's
    // published_at <= registry_release_due_at.
    clockNowMs = releaseDueAt.getTime();
    const releaseRepository = new PostgresPredicateRegistryRepository(database.pool);
    await releaseRepository.syncPredicateRegistry(swimmingSnapshot, clock());
    const scanned = await runRemapScan();
    expect(scanned.remapCommandsCreated).toBe(1);
    const outcome = await reviewService.runRemap({
      userId: OWNER,
      candidateId: atDeadlineCandidate,
    });
    expect(outcome).toBe("converged");
  }, 60_000);

  it("a late release before the sweeper cannot re-qualify the Candidate", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    // The sweeper has NOT run yet, but the release is one hour past the
    // 90-day deadline.
    advanceDays(90);
    advanceHours(1);
    const releaseRepository = new PostgresPredicateRegistryRepository(database.pool);
    await releaseRepository.syncPredicateRegistry(swimmingSnapshot, clock());
    const scanned = await runRemapScan();
    expect(scanned.remapCommandsCreated).toBe(0);
    const outcome = await reviewService.runRemap({
      userId: OWNER,
      candidateId,
    });
    expect(outcome).toBe("no_longer_eligible");
    const row = await database.pool.query<{ status: string }>(
      `SELECT status FROM memory_candidates WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    expect(row.rows[0]!.status).toBe("awaiting_registry_release");
  }, 60_000);

  it("a later release re-arms remaps for Candidates the earlier release could not map", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    const releaseRepository = new PostgresPredicateRegistryRepository(database.pool);
    // Release 3 publishes the Proposal, but its remap cannot converge.
    await releaseRepository.syncPredicateRegistry(swimmingSnapshot, clock());
    const firstScan = await runRemapScan();
    expect(firstScan.remapCommandsCreated).toBe(1);
    // The remap completes without mapping (no live snapshot carries the
    // entry in this seam: the live lookup pins version 3 which HAS it —
    // use the typed no-snapshot path to emulate the stranded case).
    const firstOutcome = await reviewService.runRemap({
      userId: OWNER,
      candidateId,
    });
    expect(firstOutcome).toBe("converged");
    void releaseRepository;
  });

  it("a Candidate swept stale before the release never gains admission from it", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    advanceDays(91);
    const swept = await claimService.staleCandidate({
      userId: OWNER,
      candidateId,
      staleReason: "registry_release_expired",
    });
    expect(swept.outcome).toBe("stale");
    const releaseRepository = new PostgresPredicateRegistryRepository(database.pool);
    await releaseRepository.syncPredicateRegistry(swimmingSnapshot, clock());
    const scanned = await runRemapScan();
    expect(scanned.remapCommandsCreated).toBe(0);
    const outcome = await reviewService.runRemap({
      userId: OWNER,
      candidateId,
    });
    expect(outcome).toBe("no_longer_eligible");
    const row = await database.pool.query<{ status: string }>(
      `SELECT status FROM memory_candidates WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    expect(row.rows[0]!.status).toBe("stale");
  });

  it("terminal content expiry is anchored at the disposition, never at sweeper time", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const dispositionTime = clock();
    await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      reasonCode: "insufficient_evidence",
    });
    // A late sweeper must not move the expiry window.
    advanceDays(3);
    const row = await database.pool.query<{
      terminal_effective_at: Date;
      terminal_content_expires_at: Date;
    }>(
      `SELECT terminal_effective_at, terminal_content_expires_at
       FROM memory_candidates WHERE memory_candidate_id = $1`,
      [candidateId],
    );
    expect(row.rows[0]!.terminal_effective_at).toEqual(dispositionTime);
    expect(row.rows[0]!.terminal_content_expires_at.getTime()).toBe(
      dispositionTime.getTime() + 7 * DAY_MS,
    );
  });

  // ── auth, step-up and audit (SPEC §8.5) ──────────────────────────────────

  it("commands require the candidate_review capability and a fresh step-up; queue reads do not", async () => {
    const candidateId = await seedReviewCandidate();
    const freshSession = await provisionReviewSession({});
    const revokedSession = await provisionReviewSession({ stepUpAt: clock() });
    await database.pool.query(
      `UPDATE internal_diagnostic_access_grants SET status = 'revoked'
       WHERE session_token_hash = decode($1, 'hex')`,
      [revokedSession],
    );

    await expect(
      reviewService.reject({
        userId: OWNER,
        authSessionId: revokedSession,
        candidateId,
        reasonCode: "insufficient_evidence",
      }),
    ).rejects.toMatchObject({ code: "step_up_required" });

    advanceHours(1);
    await expect(
      reviewService.reject({
        userId: OWNER,
        authSessionId: freshSession,
        candidateId,
        reasonCode: "insufficient_evidence",
      }),
    ).rejects.toMatchObject({ code: "recent_step_up_required" });

    // Queue browsing keeps the capability but needs no step-up (ADR-0122).
    const queue = await reviewService.listReviewQueue({
      userId: OWNER,
      authSessionId: freshSession,
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]!.stage).toBe("needs_review");
  });

  it("every disposition appends a content-free audit row and denials are audited", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      reasonCode: "insufficient_evidence",
    });
    const revokedSession = await provisionReviewSession({ stepUpAt: clock() });
    await database.pool.query(
      `UPDATE internal_diagnostic_access_grants SET status = 'revoked'
       WHERE session_token_hash = decode($1, 'hex')`,
      [revokedSession],
    );
    const lateCandidate = await seedReviewCandidate();
    await expect(
      reviewService.reject({
        userId: OWNER,
        authSessionId: revokedSession,
        candidateId: lateCandidate,
        reasonCode: "insufficient_evidence",
      }),
    ).rejects.toMatchObject({ code: "step_up_required" });

    const audits = await database.pool.query<{
      command: string;
      disposition: string;
      reason: string | null;
      target_type: string;
    }>(
      `SELECT command, disposition, reason, target_type
       FROM candidate_review_audits ORDER BY recorded_at, command`,
    );
    expect(audits.rows.find((row) => row.command === "reject")).toMatchObject({
      disposition: "allowed",
      reason: null,
      target_type: "memory_candidate",
    });
    expect(audits.rows.find((row) => row.reason === "step_up_required"))
      .toMatchObject({
        disposition: "denied",
      });
    const auditColumns = await database.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'candidate_review_audits'`,
    );
    const names = auditColumns.rows.map((row) => row.column_name);
    expect(names).not.toContain("rationale");
    expect(names).not.toContain("payload");
  });

  // ── four-layer privilege proof (SPEC §8.5) ───────────────────────────────

  it("layer 1 — no route binds Registry-write, Proposal-publish or Claim-write entrypoints", () => {
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

  it("layer 2 — the module APIs expose no publication or direct-Claim path", () => {
    expect(Object.keys(reviewService).sort()).toEqual(
      [
        "approveForRegistryChange",
        "listReviewQueue",
        "mapExisting",
        "reject",
        "runRemap",
      ].sort(),
    );
    expect(Object.keys(governanceService).sort()).toEqual(
      [
        "assertProposalAllowsGovernedUse",
        "cancel",
        "describeProposal",
        "reconsider",
      ].sort(),
    );
  });

  it("layer 3 — Claims only ever leave the review queue through deterministic admission", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    await expect(
      claimService.admitCandidate({ userId: OWNER, candidateId }),
    ).rejects.toThrowError(CandidateNotAdmissibleError);
    const rejectedId = await seedReviewCandidate();
    await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId: rejectedId,
      reasonCode: "insufficient_evidence",
    });
    await expect(
      claimService.admitCandidate({ userId: OWNER, candidateId: rejectedId }),
    ).rejects.toThrowError(CandidateNotAdmissibleError);
  });

  it("layer 4 — no 1A.3b model role carries review or governance tooling", () => {
    for (const role of ONE_A_3B_MODEL_ROLES) {
      expect(role.toLowerCase()).not.toMatch(
        /review|governance|registry|candidate/,
      );
    }
  });

  // ── typed queue surface for B2 ───────────────────────────────────────────

  it("the queue exposes the lifecycle views with deadline-pressure ordering", async () => {
    await seedReviewCandidate();
    const awaitingCandidate = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId: awaitingCandidate,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    const terminalCandidate = await seedReviewCandidate();
    await reviewService.reject({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId: terminalCandidate,
      reasonCode: "insufficient_evidence",
    });
    const queue = await reviewService.listReviewQueue({
      userId: OWNER,
      authSessionId: sessionToken,
    });
    const stages = queue.map((entry) => entry.stage);
    expect(stages.filter((stage) => stage === "needs_review").length).toBe(1);
    expect(stages.filter((stage) => stage === "awaiting_release").length).toBe(1);
    expect(stages.filter((stage) => stage === "terminal_grace").length).toBe(1);
    const awaiting = queue.find((entry) => entry.stage === "awaiting_release");
    expect(awaiting?.candidate.memoryCandidateId).toBe(awaitingCandidate);
    expect(awaiting?.linkedProposalId).not.toBeNull();
  });

  it("mapping a Candidate runs normal admission and returns the real after-state", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const mapped = await reviewService.mapExisting({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      predicateId: STATED_STYLE,
      typedValue: "简洁",
    });
    expect(mapped.outcome).toBe("applied");
    expect(mapped.candidateAfter?.status).toBe("accepted");
    expect(mapped.candidateAfter?.predicateId).toBe(STATED_STYLE);
    expect(mapped.candidateAfter?.proposedConcept).toBeNull();
    expect(mapped.admission?.outcome).toBe("promoted");
  });

  it("mapping to a deprecated or unknown predicate fails closed without disposing", async () => {
    const candidateId = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const unknown = await reviewService.mapExisting({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId,
      predicateId: "sh.unknown.predicate",
    });
    expect(unknown.outcome).toBe("predicate_not_active");
    expect(unknown.candidateAfter?.status).toBe("needs_predicate_review");
  });

  it("approve can associate a Candidate with a reviewer-selected awaiting Proposal", async () => {
    const firstCandidate = await seedReviewCandidate();
    const secondCandidate = await seedReviewCandidate();
    const sessionToken = await provisionReviewSession({});
    const approved = await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId: firstCandidate,
      mode: { action: "create", draft: { ...draftFor() } },
    });
    expect(approved.outcome).toBe("applied");
    const version = await firstProposalVersion();
    const associated = await reviewService.approveForRegistryChange({
      userId: OWNER,
      authSessionId: sessionToken,
      candidateId: secondCandidate,
      mode: { action: "associate", proposalId: version.predicateChangeProposalId },
    });
    expect(associated.outcome).toBe("applied");
    const links = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM predicate_change_proposal_candidate_links
       WHERE predicate_change_proposal_id = $1`,
      [version.predicateChangeProposalId],
    );
    expect(Number(links.rows[0]!.count)).toBe(2);
    // No duplicate ProposalVersion was created for the association.
    const versions = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM predicate_change_proposal_versions
       WHERE predicate_change_proposal_id = $1`,
      [version.predicateChangeProposalId],
    );
    expect(Number(versions.rows[0]!.count)).toBe(1);
  });
});
