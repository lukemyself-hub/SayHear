import { randomBytes } from "node:crypto";

import type { Pool } from "pg";

import {
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
  createContinuousExchangeService,
  createEntityService,
  createMemoryClaimService,
  createMemoryRetrievalService,
  createUserTextConversationService,
  evaluateTrustFences,
  loadPredicateRegistrySnapshot,
  MEMORY_SECTION_KEYS,
  type MemoryRetrievalRunOutcome,
} from "@sayhear/application";
import {
  createUuidV7,
  PostgresContinuousExchangeRepository,
  PostgresEntityRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresMemoryClaimRepository,
  PostgresMemoryRetrievalRepository,
  PostgresUserTextConversationRepository,
} from "@sayhear/data";
import { fixedInternalOwnerPrincipal } from "@sayhear/test-support";
import {
  asDailySessionId,
  asMemoryClaimId,
  type UserId,
} from "@sayhear/domain";

import {
  CORPUS_BASE_TIME_UTC,
  DORMANCY_PROBE_CLAIM_ID,
  POST_DORMANCY_QUERY,
  buildCorpus,
  compileLocaleOf,
  type CorpusTurnSpec,
  type PlantedClaimSpec,
  type PlantedPerson,
  type PrecisionCorpus,
  type QuerySpec,
} from "./corpus";
import {
  evaluateQueryRuns,
  zeroToleranceViolations,
  type CorpusMetrics,
  type QueryLedgerRow,
  type QueryRunRecord,
} from "./metrics";

/**
 * Retrieval-precision corpus runner harness (issue #125, SPEC AC 38).
 *
 * Eval-side only — it follows the pack-runner pattern (build → run → metrics
 * → ledger) and adds no runtime seam. The corpus is planted through the
 * production write paths (conversation submission, claim admission with the
 * published registry, whole-claim forget, impression dormancy) plus
 * fast-path-shaped Evidence rows, and every probe query is executed by the
 * SAME production retrieval service the runtime uses
 * (`createMemoryRetrievalService` over `PostgresMemoryRetrievalRepository`),
 * under the production 200 ms policy — never a parallel implementation.
 *
 * The caller supplies an isolated, migrated schema pool (see run-corpus.ts
 * and the system test). Zero-tolerance outcomes (fence leakage, budget
 * violations, deadline violations, degraded rounds) are returned in the
 * ledger; the accounting baselines carry no thresholds.
 */

const OWNER = fixedInternalOwnerPrincipal.userId;

const registrySnapshot = loadPredicateRegistrySnapshot(1);

const registryEntryFor = (predicateId: string) =>
  registrySnapshot.entries.find((entry) => entry.predicateId === predicateId) ?? null;

const claimRegistry = {
  entryFor: registryEntryFor,
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

const retrievalRegistry = {
  registryVersion: registrySnapshot.registryVersion,
  entryFor: registryEntryFor,
  localizations: registrySnapshot.localizations,
};

const generationPolicy = Object.freeze({
  consentPolicyVersion: null,
  freshnessPolicy: "source_valid:v1" as const,
  chineseLocalePackVersion: "locale-pack-zh:v1",
  englishLocalePackVersion: "locale-pack-en:v1",
  harnessPolicyVersion: INITIAL_CONVERSATION_HARNESS_POLICY.version,
  conversationActionCatalogVersion: EMPTY_CONVERSATION_ACTION_CATALOG.version,
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

const SESSION_OFFSET_MS = [0, 41_400_000] as const; // 09:00 and 20:30 China Standard Time
const TURN_SPACING_MS = 180_000;
const DORMANCY_DAY_OFFSET = 44; // past the 30-day impression review deadline

/** One committed conversation turn, as the retrieval input needs it. */
type SubmittedTurn = Readonly<{
  revisionId: string;
  sequence: number;
  dailySessionId: string;
  exchangeNo: number;
}>;

export type CorpusHarnessResult = Readonly<{
  corpus: PrecisionCorpus;
  ledger: readonly QueryLedgerRow[];
  metrics: CorpusMetrics;
  /** Human-readable zero-tolerance findings; empty when clean. */
  violations: readonly string[];
  planted: readonly Readonly<{
    corpusClaimId: string;
    memoryClaimId: string;
    currentVersionId: string;
  }>[];
}>;

export async function runRetrievalPrecisionCorpus(input: {
  pool: Pool;
  log?: (line: string) => void;
}): Promise<CorpusHarnessResult> {
  const { pool, log = () => {} } = input;
  const corpus = buildCorpus();
  const baseTime = Date.parse(CORPUS_BASE_TIME_UTC);
  let clockNowMs = baseTime;
  const clock = () => new Date(clockNowMs);
  const advanceTo = (day: number, session: 0 | 1, slot: number) => {
    clockNowMs =
      baseTime +
      (day - 1) * 86_400_000 +
      SESSION_OFFSET_MS[session]! +
      slot * TURN_SPACING_MS;
  };

  // ── provisioning (internal owner + backup evidence + Self Entity) ────────
  const ownerAccess = new PostgresInternalOwnerAccessRepository(pool);
  await ownerAccess.provisionInternalOwner({
    issuer: "https://github.com",
    subject: "retrieval-precision-corpus-owner",
    userId: OWNER,
  });
  await ownerAccess.recordBackupPolicyEvidence({
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

  const entityService = createEntityService({
    repository: new PostgresEntityRepository(pool),
    clock,
  });
  const claimService = createMemoryClaimService({
    repository: new PostgresMemoryClaimRepository(pool),
    registry: claimRegistry,
    clock,
    dedupeFingerprintSecret: "retrieval-precision-corpus-secret",
  });
  // The deterministic inactivity driver: production quiesces a Daily Session
  // after the configured idle timeout, which is what turns a day boundary
  // into a new Daily Session (and an idle evening into a new exchange).
  const exchangeService = createContinuousExchangeService({
    clock,
    repository: new PostgresContinuousExchangeRepository(pool),
  });
  const conversationService = createUserTextConversationService({
    clock,
    expectedBackupPolicyVersion: "neon-production-v1",
    expectedConfigurationFingerprint: "sha256:expected",
    generationPolicy,
    repository: new PostgresUserTextConversationRepository(pool),
  });
  const retrievalRepository = new PostgresMemoryRetrievalRepository(pool);
  const retrievalService = createMemoryRetrievalService({
    repository: retrievalRepository,
    registry: retrievalRegistry,
    clock,
  });

  await entityService.ensureSelfEntity({ userId: OWNER });
  const selfEntity = await entityService.findSelfEntity(OWNER);
  if (!selfEntity) throw new Error("Self Entity missing after ensure-self-entity.");
  const selfEntityId = selfEntity.entityId;

  // ── per-corpus state ──────────────────────────────────────────────────────
  let submitCount = 0;
  const personEntityIds = new Map<string, string>();
  const evidenceIdByTurnId = new Map<string, string>();
  const claimIdByVersionId = new Map<string, string>(); // version id → corpus claim id
  const plantedByCorpusClaimId = new Map<string, { memoryClaimId: string; currentVersionId: string }>();
  const runs: QueryRunRecord[] = [];

  async function submitTurn(text: string): Promise<SubmittedTurn> {
    submitCount += 1;
    const turn = await conversationService.submit(OWNER, {
      clientEventId: `corpus-event-${submitCount}`,
      clientTurnId: `corpus-turn-${submitCount}`,
      locale: "zh-CN",
      text,
      timezone: corpus.timezone,
    });
    const exchange = await pool.query<{ current_continuous_exchange_no: string }>(
      `SELECT current_continuous_exchange_no FROM daily_sessions WHERE daily_session_id = $1`,
      [turn.dailySession.id],
    );
    return {
      revisionId: turn.message.revisionId,
      sequence: turn.message.sequence,
      dailySessionId: turn.dailySession.id,
      exchangeNo: Number(exchange.rows[0]!.current_continuous_exchange_no),
    };
  }

  /** Seed one whole-revision User EvidenceItem, the shape the fast path writes. */
  async function seedEvidence(submitted: SubmittedTurn): Promise<string> {
    const now = clock();
    const snapshotId = createUuidV7(now);
    const itemId = createUuidV7(now);
    await pool.query(
      `INSERT INTO evidence_source_snapshots (
         evidence_source_snapshot_id, user_id, daily_session_id, source_revision,
         extraction_policy_version, command_id, attempt_id, champion_config_version,
         champion_provider, champion_model, champion_snapshot,
         champion_provider_policy_version, created_at
       ) VALUES ($1, $2, $3,
         (SELECT sequence_no FROM conversation_events
           WHERE conversation_event_id = (SELECT conversation_event_id
             FROM conversation_event_revisions WHERE conversation_event_revision_id = $4)),
         'evidence-extraction:v2', 'corpus', 'corpus', 'test', 'openai', 'test', 'test', 'test', $5)`,
      [snapshotId, OWNER, submitted.dailySessionId, submitted.revisionId, now],
    );
    await pool.query(
      `INSERT INTO evidence_items (
         evidence_item_id, user_id, evidence_source_snapshot_id, source_event_id,
         source_revision_id, source_actor, source_status, locator_type,
         locator_key, extraction_policy_version, evidence_role, created_at
       ) VALUES ($1, $2, $3,
         (SELECT conversation_event_id FROM conversation_event_revisions
           WHERE conversation_event_revision_id = $4),
         $4, 'user', 'final', 'whole_revision', $5, 'evidence-extraction:v2',
         'factual_support', $6)`,
      [itemId, OWNER, snapshotId, submitted.revisionId, `revision:${submitted.revisionId}`, now],
    );
    return itemId;
  }

  async function ensurePerson(person: PlantedPerson, aliasEvidenceId: string | null): Promise<string> {
    const existing = personEntityIds.get(person.personId);
    if (existing) return existing;
    const now = clock();
    const entityId = createUuidV7(now);
    const versionId = createUuidV7(now);
    await pool.query(
      `INSERT INTO entities (entity_id, user_id, created_at) VALUES ($1, $2, $3)`,
      [entityId, OWNER, now],
    );
    await pool.query(
      `INSERT INTO entity_versions (
         entity_version_id, entity_id, user_id, revision, entity_kind_id, status, created_at
       ) VALUES ($1, $2, $3, 1, 'sh.entity.person', 'active', $4)`,
      [versionId, entityId, OWNER, now],
    );
    await pool.query(
      `UPDATE entities SET current_version_id = $3 WHERE user_id = $1 AND entity_id = $2`,
      [OWNER, entityId, versionId],
    );
    await pool.query(
      `INSERT INTO entity_labels (
         entity_label_id, entity_id, user_id, locale, label, normalized_label,
         label_kind, is_current, created_at
       ) VALUES ($1, $2, $3, $4, $5, $5, 'primary', TRUE, $6)`,
      [createUuidV7(now), entityId, OWNER, person.primaryLocale, person.primaryLabel, now],
    );
    if (person.alias) {
      if (!aliasEvidenceId) {
        throw new Error(`Alias for ${person.personId} needs an evidence id.`);
      }
      await pool.query(
        `INSERT INTO entity_labels (
           entity_label_id, entity_id, user_id, locale, label, normalized_label,
           label_kind, is_current, source_evidence_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $5, 'alias', TRUE, $6, $7)`,
        [
          createUuidV7(now),
          entityId,
          OWNER,
          person.alias.locale,
          person.alias.label,
          aliasEvidenceId,
          now,
        ],
      );
    }
    personEntityIds.set(person.personId, entityId);
    return entityId;
  }

  async function admitClaim(claim: PlantedClaimSpec): Promise<void> {
    const evidenceIds = claim.category === "impression"
      ? (claim.evidenceTurnIds ?? []).map((turnId) => {
          const evidenceId = evidenceIdByTurnId.get(turnId);
          if (!evidenceId) throw new Error(`${claim.claimId}: evidence for ${turnId} missing.`);
          return evidenceId;
        })
      : [(() => {
          const evidenceId = claim.statementTurnId
            ? evidenceIdByTurnId.get(claim.statementTurnId)
            : undefined;
          if (!evidenceId) throw new Error(`${claim.claimId}: statement evidence missing.`);
          return evidenceId;
        })()];

    const objectEntityId = claim.personId
      ? await (async () => {
          const person = corpus.people.find((candidate) => candidate.personId === claim.personId);
          if (!person) throw new Error(`${claim.claimId}: unknown person ${claim.personId}`);
          const statementTurn = claim.category === "impression"
            ? claim.evidenceTurnIds?.[0]
            : claim.statementTurnId;
          const aliasEvidence = statementTurn ? evidenceIdByTurnId.get(statementTurn) ?? null : null;
          return ensurePerson(person, aliasEvidence);
        })()
      : null;

    const recorded = await claimService.recordCandidate({
      userId: OWNER,
      candidateKind: claim.kind,
      basis: claim.kind === "objective" ? "directly_stated" : "inferred",
      resolution: {
        status: "mapped",
        predicateId: claim.predicateId,
        registryVersion: registrySnapshot.registryVersion,
        typedValue: claim.typedValue ?? "",
        mappingConfidence: 0.95,
      },
      subjectEntityId: selfEntityId,
      subjectEntityMentionId: null,
      objectEntityId,
      objectEntityMentionId: null,
      scopeKey: "",
      temporal: {
        temporalStatus: claim.temporalStatus ?? "current",
        validFrom: null,
        validFromPrecision: "unknown",
        validTo: null,
        validToPrecision: "unknown",
      },
      qualifiers: [],
      evidenceItemIds: evidenceIds,
      lineage: {
        extractionPolicyVersion: "memory-extract-corpus:v1",
        generationCommandId: null,
        authoritativeModelAttemptId: null,
        modelVersion: "corpus-model",
        promptVersion: "memory-extract-corpus-prompt:v1",
        sourceReflectionVersionId: null,
      },
    });
    if (recorded.outcome !== "recorded") {
      throw new Error(`${claim.claimId}: candidate not recorded (${recorded.outcome}).`);
    }
    const admitted = await claimService.admitCandidate({
      userId: OWNER,
      candidateId: recorded.candidateId,
    });
    if (admitted.outcome !== "promoted") {
      throw new Error(`${claim.claimId}: admission did not promote (${admitted.outcome}).`);
    }
    const previous = plantedByCorpusClaimId.get(claim.claimId);
    if (previous && previous.memoryClaimId !== admitted.claimId) {
      throw new Error(`${claim.claimId}: admission did not reuse the logical claim.`);
    }
    plantedByCorpusClaimId.set(claim.claimId, {
      memoryClaimId: admitted.claimId,
      currentVersionId: admitted.claimVersionId,
    });
    claimIdByVersionId.set(admitted.claimVersionId, claim.claimId);
  }

  async function forgetClaim(corpusClaimId: string, revisionId: string): Promise<void> {
    const planted = plantedByCorpusClaimId.get(corpusClaimId);
    if (!planted) throw new Error(`${corpusClaimId}: cannot forget before admission.`);
    const outcome = await claimService.applyWholeClaimForget({
      userId: OWNER,
      claimId: asMemoryClaimId(planted.memoryClaimId),
      requestEventRevisionId: revisionId,
    });
    if (outcome.outcome !== "applied") {
      throw new Error(`${corpusClaimId}: whole-claim forget did not apply (${outcome.outcome}).`);
    }
    await refreshCurrentVersion(corpusClaimId);
  }

  /** Forget and dormancy advance the claim's current version — re-sync the probe ground truth. */
  async function refreshCurrentVersion(corpusClaimId: string): Promise<void> {
    const planted = plantedByCorpusClaimId.get(corpusClaimId);
    if (!planted) return;
    const row = await pool.query<{ current_version_id: string }>(
      `SELECT current_version_id::text FROM memory_claims WHERE memory_claim_id = $1`,
      [planted.memoryClaimId],
    );
    const versionId = row.rows[0]?.current_version_id;
    if (!versionId) throw new Error(`${corpusClaimId}: current version missing.`);
    planted.currentVersionId = versionId;
    claimIdByVersionId.set(versionId, corpusClaimId);
  }

  async function runQuery(
    query: QuerySpec,
    turn: CorpusTurnSpec,
    submitted: SubmittedTurn,
  ): Promise<void> {
    const outcome: MemoryRetrievalRunOutcome = await retrievalService.run({
      userId: OWNER,
      dailySession: {
        id: asDailySessionId(submitted.dailySessionId),
        continuousExchangeNo: submitted.exchangeNo,
      },
      sourceEventRevisionId: submitted.revisionId,
      currentInputText: query.text,
      currentTopic: null,
      dialogueRevision: 0,
      currentInputSequence: submitted.sequence,
      locale: compileLocaleOf(query.locale, query.text),
    });

    const qualified = outcome.retrievalRunId
      ? await pool.query<{ memory_claim_version_id: string }>(
          `SELECT memory_claim_version_id FROM retrieval_run_candidates
           WHERE retrieval_run_id = $1 AND final_rank IS NOT NULL`,
          [outcome.retrievalRunId],
        )
      : { rows: [] as { memory_claim_version_id: string }[] };
    const qualifiedVersionIds = qualified.rows.map((row) => row.memory_claim_version_id);

    const injected = MEMORY_SECTION_KEYS.flatMap((section) =>
      outcome.memorySections[section].map((item) => ({
        versionId: item.claimVersionId,
        section,
        selectionSource: item.selectionSource,
        kind: item.kind,
      })),
    );

    // Production fence re-verification of every injected version: a leak is
    // any injected item whose fence state fails any fence right now.
    const injectedFenceFailures: { versionId: string; failedFences: string[] }[] = [];
    if (injected.length > 0) {
      const fenceStates = await retrievalRepository.loadCandidateFenceStates(
        OWNER,
        injected.map((item) => item.versionId),
      );
      const stateByVersion = new Map(fenceStates.map((state) => [state.versionId, state]));
      // evaluateTrustFences reads the claim's object binding from the claim
      // itself (CandidateFenceState carries only the entity statuses).
      const objectRows = await pool.query<{
        memory_claim_version_id: string;
        object_entity_id: string | null;
      }>(
        `SELECT v.memory_claim_version_id::text, claim.object_entity_id::text AS object_entity_id
         FROM memory_claim_versions v
         INNER JOIN memory_claims claim ON claim.memory_claim_id = v.memory_claim_id
         WHERE v.user_id = $1 AND v.memory_claim_version_id = ANY($2)`,
        [OWNER, injected.map((item) => item.versionId)],
      );
      const objectByVersion = new Map(
        objectRows.rows.map((row) => [row.memory_claim_version_id, row.object_entity_id]),
      );
      for (const item of injected) {
        const state = stateByVersion.get(item.versionId);
        const results = state
          ? evaluateTrustFences({
              claim: { objectEntityId: objectByVersion.get(item.versionId) ?? null },
              fenceState: state,
            })
          : [];
        const failedFences = results.filter((result) => !result.passed).map((result) => result.fence);
        if (!state || failedFences.length > 0) {
          injectedFenceFailures.push({
            versionId: item.versionId,
            failedFences: state ? failedFences : ["fence_state_unavailable"],
          });
        }
      }
    }

    const currentVersionByClaim = (claimIds: readonly string[]): string[] =>
      claimIds
        .map((claimId) => plantedByCorpusClaimId.get(claimId)?.currentVersionId)
        .filter((versionId): versionId is string => versionId !== undefined);

    runs.push({
      query,
      compiledLocale: compileLocaleOf(query.locale, query.text),
      expectedVersionIds: currentVersionByClaim(query.expectedClaimIds),
      fencedVersionIds: currentVersionByClaim(query.fencedClaimIds ?? []),
      status: outcome.status,
      degradedReasonCodes: outcome.degradedReasonCodes,
      durationMs: outcome.manifest.duration_ms,
      deadlineMs: outcome.manifest.deadline_ms,
      deadlineExceededStage: outcome.manifest.deadline_exceeded_stage,
      qualifiedVersionIds,
      injected,
      injectedFenceFailures,
      laneHitCounts: { ...outcome.manifest.lane_hit_counts },
    });
  }

  // ── replay the corpus ─────────────────────────────────────────────────────
  for (const turn of corpus.turns) {
    advanceTo(turn.day, turn.session, turn.slot);
    await exchangeService.scanDueInactivity();
    const submitted = await submitTurn(turn.text);

    if (turn.role === "statement") {
      const evidenceId = await seedEvidence(submitted);
      evidenceIdByTurnId.set(turn.turnId, evidenceId);
      for (const claimId of turn.claimIds ?? []) {
        const claim = corpus.claims.find((candidate) => candidate.claimId === claimId);
        if (!claim) throw new Error(`${turn.turnId}: unknown claim ${claimId}`);
        if (claim.category === "impression") {
          // ADR-0039: admission runs on the LAST evidence turn only.
          const lastEvidence = claim.evidenceTurnIds?.[claim.evidenceTurnIds.length - 1];
          if (lastEvidence !== turn.turnId) continue;
        }
        await admitClaim(claim);
      }
    } else if (turn.role === "forget") {
      for (const claimId of turn.forgetClaimIds ?? []) {
        await forgetClaim(claimId, submitted.revisionId);
      }
    }

    if (turn.query) {
      await runQuery(turn.query, turn, submitted);
    }
  }

  // Impression claims whose last evidence turn carried no query still admit.
  for (const claim of corpus.claims) {
    if (claim.category !== "impression") continue;
    if (plantedByCorpusClaimId.has(claim.claimId)) continue;
    const lastTurnId = claim.evidenceTurnIds?.[claim.evidenceTurnIds.length - 1];
    if (!lastTurnId) throw new Error(`${claim.claimId}: no evidence turns.`);
    const turn = corpus.turns.find((candidate) => candidate.turnId === lastTurnId);
    if (!turn) throw new Error(`${claim.claimId}: unknown evidence turn.`);
    advanceTo(turn.day, turn.session, turn.slot);
    await admitClaim(claim);
  }

  // ── dormancy fence probe (ADR-0041): force the review deadline, then probe ─
  const dormancyTurn: CorpusTurnSpec = {
    turnId: "post-dormancy",
    day: DORMANCY_DAY_OFFSET + 1,
    session: 0,
    slot: 0,
    locale: POST_DORMANCY_QUERY.locale,
    text: POST_DORMANCY_QUERY.text,
    role: "query",
    query: POST_DORMANCY_QUERY,
  };
  {
    clockNowMs = baseTime + DORMANCY_DAY_OFFSET * 86_400_000;
    const dormancyClaim = plantedByCorpusClaimId.get(DORMANCY_PROBE_CLAIM_ID);
    if (!dormancyClaim) throw new Error("dormancy probe claim was never planted.");
    const dormancy = await claimService.applyImpressionDormancy({
      userId: OWNER,
      claimId: asMemoryClaimId(dormancyClaim.memoryClaimId),
    });
    if (dormancy.outcome !== "dormant") {
      throw new Error(`dormancy probe did not go dormant (${dormancy.outcome}).`);
    }
    await refreshCurrentVersion(DORMANCY_PROBE_CLAIM_ID);
    const submitted = await submitTurn(POST_DORMANCY_QUERY.text);
    await runQuery(POST_DORMANCY_QUERY, dormancyTurn, submitted);
  }

  // ── accounting ────────────────────────────────────────────────────────────
  const { ledger, metrics } = evaluateQueryRuns({
    corpus: { ...corpus, turns: [...corpus.turns, dormancyTurn] },
    claimIdByVersionId,
    runs,
  });
  const violations = zeroToleranceViolations(ledger);

  log(
    `planted ${plantedByCorpusClaimId.size} claims; ran ${runs.length} probes; ` +
      `hit(retrieved)=${metrics.hitRateRetrieved} hit(injected)=${metrics.hitRateInjected} ` +
      `precision=${metrics.queryRetrievalPrecision}; violations=${violations.length}`,
  );

  return {
    corpus,
    ledger,
    metrics,
    violations,
    planted: [...plantedByCorpusClaimId.entries()].map(([corpusClaimId, planted]) => ({
      corpusClaimId,
      memoryClaimId: planted.memoryClaimId,
      currentVersionId: planted.currentVersionId,
    })),
  };
}
