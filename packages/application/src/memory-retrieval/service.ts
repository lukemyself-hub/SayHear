import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import type { UserId } from "@sayhear/domain";

import { buildRetrievalQuery } from "./query-construction";
import {
  applyRelevanceCutoffs,
  dedupeLaneHits,
  evaluateTrustFences,
  fenceFailureCodes,
  FENCE_ORDER,
  rankCandidates,
  temporalFitOf,
} from "./ranking";
import {
  EMPTY_MEMORY_SECTIONS,
  MEMORY_BUDGETS_POLICY_VERSION,
  PORTRAIT_ELIGIBLE_PREDICATE_IDS,
  PORTRAIT_SELECTION_POLICY_VERSION,
  RECALL_FRAMING_POLICY_VERSION,
  buildMemoryContextItems,
  emptyBudgetVsActual,
  selectMemoryForInjection,
  type MemoryContextItem,
  type MemorySectionKey,
  type MemoryVersionDetail,
  type MemoryVersionEvidence,
  type PortraitPoolCandidate,
} from "./memory-compilation";
import {
  MEMORY_RETRIEVAL_POLICY_VERSION,
  RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
  CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
  type ConstructedRetrievalQuery,
  type LaneCandidateHit,
  type MemoryRetrievalInput,
  type MemoryRetrievalPort,
  type MemoryRetrievalRepository,
  type MemoryRetrievalRunOutcome,
  type MemoryRetrievalPolicy,
  type PortraitDegradedReasonCode,
  type RetrievalTestSupport,
  type RetrievalDeadlineStage,
  type RetrievalDegradedReasonCode,
  type RetrievalLane,
  type RetrievalLaneRow,
  type RetrievalRegistryMaterial,
  type RetrievalRunManifest,
  type RetrievalTestSupportConfiguration,
  type TrustFenceResult,
} from "./types";

/**
 * Memory retrieval orchestrator (issue #116, ADR-0115, architecture §10):
 * query construction, all enabled lanes, dedupe, ranking, and fences share
 * ONE versioned wall-clock deadline with no per-lane re-timing and no
 * in-request retry. The run never throws for operational failures — it
 * returns a degraded outcome, the round's memory fails closed, and the
 * conversation continues without memory (ADR-0111 degradation).
 */

class RetrievalDeadlineError extends Error {
  public constructor(public readonly stage: RetrievalDeadlineStage) {
    super(`The shared retrieval deadline expired during ${stage}.`);
    this.name = "RetrievalDeadlineError";
  }
}

class RetrievalLaneFailureError extends Error {
  public constructor(public readonly lane: RetrievalLane, cause: unknown) {
    super(`Retrieval lane ${lane} failed: ${String(cause)}`);
    this.name = "RetrievalLaneFailureError";
  }
}

class RetrievalQueryConstructionError extends Error {
  public constructor(cause: unknown) {
    super(`Retrieval query construction failed: ${String(cause)}`);
    this.name = "RetrievalQueryConstructionError";
  }
}

class RetrievalHydrationError extends Error {
  public constructor(cause: unknown) {
    super(`Retrieval candidate hydration failed: ${String(cause)}`);
    this.name = "RetrievalHydrationError";
  }
}

class RetrievalRecordingError extends Error {
  public constructor(cause: unknown) {
    super(`Retrieval run recording failed: ${String(cause)}`);
    this.name = "RetrievalRecordingError";
  }
}

const LANE_FAULT_KEYS = {
  structured_exact: "structuredExact",
  lexical_term_overlap: "lexicalTermOverlap",
  english_fts: "englishFts",
} as const;

export function createMemoryRetrievalService(dependencies: {
  repository: MemoryRetrievalRepository;
  registry: RetrievalRegistryMaterial;
  clock: () => Date;
  /** Wall-clock monotonic milliseconds; overridable in tests. */
  monotonicNow?: () => number;
  /** Versioned policy row to pin; tests may seed a different version. */
  policyVersion?: string;
  testSupport?: RetrievalTestSupport;
}): MemoryRetrievalPort {
  const {
    repository,
    registry,
    clock,
    monotonicNow = () => performance.now(),
    policyVersion = MEMORY_RETRIEVAL_POLICY_VERSION,
    testSupport,
  } = dependencies;

  let policyPromise: Promise<MemoryRetrievalPolicy | null> | null = null;
  function loadPolicy(): Promise<MemoryRetrievalPolicy | null> {
    // Only successful loads are memoized: a transient failure or a missing
    // policy row retries on the next run instead of degrading forever.
    if (policyPromise === null) {
      const pending = repository.loadPolicy(policyVersion).catch(
        () => null,
      );
      policyPromise = pending.then((policy) => {
        if (policy === null && policyPromise === pending) policyPromise = null;
        return policy;
      });
      return policyPromise;
    }
    return policyPromise;
  }

  async function applyFault(
    fault: { failWith?: Error; delayMs?: number } | undefined,
  ): Promise<void> {
    if (!fault) return;
    if (fault.delayMs !== undefined && fault.delayMs > 0) {
      await sleep(fault.delayMs);
    }
    if (fault.failWith) {
      throw fault.failWith;
    }
  }

  function testConfiguration(): RetrievalTestSupportConfiguration | null {
    return testSupport?.configuration() ?? null;
  }

  return {
    async run(input) {
      const wallStartedAt = clock();
      const startedAt = monotonicNow();
      const timings: Record<string, number> = {};
      let durationMs = 0;
      let stage: RetrievalDeadlineStage = "query_construction";
      let query: ConstructedRetrievalQuery | null = null;
      let candidateRows: RetrievalLaneRow[] = [];
      const laneHitCounts: Record<RetrievalLane, number> = {
        structured_exact: 0,
        lexical_term_overlap: 0,
        english_fts: 0,
      };
      const elapsed = () => {
        durationMs = Math.max(0, Math.round(monotonicNow() - startedAt));
        return durationMs;
      };

      const policy = await loadPolicy();
      if (!policy) {
        return degradedOutcomeWithoutRun({
          code: "retrieval_policy_unavailable",
          durationMs: elapsed(),
        });
      }
      const checkDeadline = (currentStage: RetrievalDeadlineStage) => {
        stage = currentStage;
        if (elapsed() > policy.deadlineMs) {
          throw new RetrievalDeadlineError(currentStage);
        }
      };

      let retrievalRunId: string | null = null;
      const degradedCodes: RetrievalDegradedReasonCode[] = [];
      try {
        // --- query construction -------------------------------------------
        const constructionStart = monotonicNow();
        try {
          await applyFault(testConfiguration()?.queryConstruction);
          const substrate = await repository.loadQueryConstructionSources({
            userId: input.userId,
            dailySessionId: input.dailySession.id,
            exchangeNo: input.dailySession.continuousExchangeNo,
            beforeSequence: input.currentInputSequence,
          });
          query = buildRetrievalQuery({
            sources: {
              currentInput: {
                revisionId: input.sourceEventRevisionId,
                text: input.currentInputText,
              },
              priorUserEvents: substrate.priorUserEvents,
              currentTopic: input.currentTopic,
              dialogueRevision: input.dialogueRevision,
              selfEntityId: substrate.selfEntityId,
              labelIndex: substrate.labelIndex,
              resolverHints: substrate.resolverHints,
            },
            registry,
          });
        } catch (error) {
          if (error instanceof RetrievalDeadlineError) throw error;
          throw new RetrievalQueryConstructionError(error);
        } finally {
          timings.query_construction_ms = Math.round(
            monotonicNow() - constructionStart,
          );
        }
        checkDeadline("query_construction");

        // The run row lands with the constructed refs while still `running`;
        // failure paths below insert with empty refs instead.
        retrievalRunId = randomUUID();
        const constructed = query!;
        await repository.insertRetrievalRun({
          retrievalRunId,
          userId: input.userId,
          dailySessionId: input.dailySession.id,
          sourceEventRevisionId: input.sourceEventRevisionId,
          retrievalPolicyVersion: policy.version,
          queryConstructionPolicyVersion: RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
          projectionPolicyVersion: CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
          deadlineMs: policy.deadlineMs,
          querySourceRefs: constructed.sourceRefs,
          normalizedQueryTerms: normalizedTermsOf(constructed),
          lanePlan: constructed.lanePlan,
          startedAt: wallStartedAt,
        });

        // --- lane execution (one shared budget, no per-lane re-timing) ----
        candidateRows = [];
        const laneStart = monotonicNow();
        for (const lane of constructed.lanePlan) {
          if (!lane.enabled) continue;
          const laneTimer = monotonicNow();
          try {
            await applyFault(
              testConfiguration()?.[LANE_FAULT_KEYS[lane.lane]],
            );
            const rows = await runLane(repository, input.userId, lane.lane, {
              query: constructed,
              policy,
              now: clock(),
            });
            laneHitCounts[lane.lane] = rows.length;
            candidateRows.push(...rows);
          } catch (error) {
            if (error instanceof RetrievalDeadlineError) throw error;
            throw new RetrievalLaneFailureError(lane.lane, error);
          } finally {
            timings[`lane_${lane.lane}_ms`] = Math.round(
              monotonicNow() - laneTimer,
            );
          }
          checkDeadline("lane_execution");
        }
        timings.lane_execution_ms = Math.round(monotonicNow() - laneStart);

        // --- dedupe --------------------------------------------------------
        const dedupeStart = monotonicNow();
        const hits = candidateRows.map((row) => toCandidateHit(row, constructed, clock()));
        const deduped = dedupeLaneHits(hits);
        timings.dedupe_ms = Math.round(monotonicNow() - dedupeStart);
        checkDeadline("dedupe");

        // --- fences (before and across ranking) ---------------------------
        const fencesStart = monotonicNow();
        const fenceStates = await repository.loadCandidateFenceStates(
          input.userId,
          deduped.map((candidate) => candidate.claim.versionId),
        );
        const fenceStateByVersion = new Map(
          fenceStates.map((state) => [state.versionId, state]),
        );
        const fenceEvaluated = deduped.map((candidate) => {
          const fenceState =
            fenceStateByVersion.get(candidate.claim.versionId) ?? null;
          const results: readonly TrustFenceResult[] = fenceState
            ? evaluateTrustFences({
                claim: candidate.claim,
                fenceState,
              })
            : missingFenceResults();
          return {
            candidate,
            fenceResults: results,
            passed: results.every((result) => result.passed),
          };
        });
        timings.fences_ms = Math.round(monotonicNow() - fencesStart);
        checkDeadline("fences");

        // --- ranking + relevance cutoffs ------------------------------------
        const rankingStart = monotonicNow();
        const survivors = fenceEvaluated.filter((entry) => entry.passed);
        const fencedOut = fenceEvaluated.filter((entry) => !entry.passed);
        const ranked = rankCandidates({
          hits: survivors.map((entry) => entry.candidate),
          query: constructed,
          now: clock(),
        });
        const withCutoffs = applyRelevanceCutoffs({ ranked, query: constructed });
        timings.ranking_ms = Math.round(monotonicNow() - rankingStart);
        checkDeadline("ranking");

        // --- memory compilation (issue #117) -------------------------------
        // Selection completes inside the run because candidate rows are
        // immutable after insert — `selected_section` and the budget reason
        // codes must be known here. The Portrait arm degrades alone: a load
        // failure omits the Portrait section (never fabricated) while the
        // retrieval round itself continues. The versioned 200 ms deadline
        // keeps covering its five stages; compilation is timed separately.
        const compilationStart = monotonicNow();
        const portraitDegradedCodes: PortraitDegradedReasonCode[] = [];
        let portraitPool: PortraitPoolCandidate[] = [];
        const evidenceByVersion = new Map<string, MemoryVersionEvidence>();
        try {
          const poolDetails = await repository.loadPortraitCandidateVersions({
            userId: input.userId,
            predicateIds: PORTRAIT_ELIGIBLE_PREDICATE_IDS,
            locale: input.locale,
          });
          const poolVersionIds = poolDetails.map((detail) => detail.versionId);
          const poolFenceStates = poolVersionIds.length > 0
            ? await repository.loadCandidateFenceStates(
                input.userId,
                poolVersionIds,
              )
            : [];
          const poolFenceByVersion = new Map(
            poolFenceStates.map((state) => [state.versionId, state]),
          );
          for (const row of await repository.loadMemoryVersionEvidence(
            input.userId,
            poolVersionIds,
          )) {
            evidenceByVersion.set(row.versionId, row);
          }
          portraitPool = poolDetails
            .filter((detail) => {
              const state = poolFenceByVersion.get(detail.versionId) ?? null;
              const results = state
                ? evaluateTrustFences({
                    claim: { objectEntityId: detail.objectEntityId },
                    fenceState: state,
                  })
                : missingFenceResults();
              return results.every((result) => result.passed);
            })
            .map((detail) => ({
              detail,
              validEvidenceCount:
                poolFenceByVersion.get(detail.versionId)?.validEvidenceCount ?? 0,
              latestEvidenceAt:
                evidenceByVersion.get(detail.versionId)?.latestEvidenceAt ?? null,
            }));
        } catch {
          portraitDegradedCodes.push("portrait_load_failed");
          portraitPool = [];
        }

        const plan = selectMemoryForInjection({
          query: constructed,
          registry,
          portraitPool,
          retrievalQualified: withCutoffs
            .filter((candidate) => candidate.cutoffPassed)
            .map((candidate) => ({
              claim: candidate.claim,
              finalRank: candidate.finalRank,
              selectionReasonCodes: candidate.selectionReasonCodes,
            })),
        });

        // Hydrate the retrieval-selected versions (rendered text, entity
        // version ids); portrait-selected details are already loaded. A
        // hydration failure fails the round's memory closed — items cannot
        // render without their details.
        const detailByVersion = new Map<string, MemoryVersionDetail>(
          plan.portraitSelected.map((candidate) => [
            candidate.detail.versionId,
            candidate.detail,
          ]),
        );
        const retrievalVersionIds = plan.retrievalSelected.map(
          (entry) => entry.candidate.claim.versionId,
        );
        try {
          const retrievalDetails = await repository.loadMemoryVersionDetails({
            userId: input.userId,
            versionIds: retrievalVersionIds,
            locale: input.locale,
          });
          for (const detail of retrievalDetails) {
            detailByVersion.set(detail.versionId, detail);
          }
          for (const row of await repository.loadMemoryVersionEvidence(
            input.userId,
            retrievalVersionIds,
          )) {
            evidenceByVersion.set(row.versionId, row);
          }
        } catch (error) {
          throw new RetrievalHydrationError(error);
        }
        const memorySections = buildMemoryContextItems({
          plan,
          detailByVersion,
          evidenceByVersion,
        });
        timings.memory_compilation_ms = Math.round(
          monotonicNow() - compilationStart,
        );

        const decisionByVersion = new Map(
          plan.decisions.map((decision) => [decision.claimVersionId, decision]),
        );
        const candidateRecords = [
          ...fencedOut.map((entry) => ({
            claimVersionId: entry.candidate.claim.versionId,
            retrievalProjectionId: entry.candidate.claim.projectionId,
            lane: entry.candidate.lane,
            matchedFields: entry.candidate.matchedFields,
            matchedTerms: entry.candidate.matchedTerms,
            trustFenceResults: entry.fenceResults,
            rankComponents: stubRankComponents(entry.candidate),
            finalRank: null,
            selectedSection: null,
            selectionReasonCodes: [],
            rejectionReasonCodes: fenceFailureCodes(entry.fenceResults),
          })),
          ...withCutoffs.map((candidate) => {
            const fenceEntry = fenceEvaluated.find(
              (entry) => entry.candidate.claim.versionId === candidate.claim.versionId,
            )!;
            const decision =
              decisionByVersion.get(candidate.claim.versionId) ?? null;
            return {
              claimVersionId: candidate.claim.versionId,
              retrievalProjectionId: candidate.claim.projectionId,
              lane: candidate.lane,
              matchedFields: candidate.matchedFields,
              matchedTerms: candidate.matchedTerms,
              trustFenceResults: fenceEntry.fenceResults,
              rankComponents: candidate.rankComponents,
              finalRank: candidate.finalRank,
              selectedSection: decision?.selectedSection ?? null,
              selectionReasonCodes: decision
                ? [
                    ...candidate.selectionReasonCodes,
                    ...decision.selectionReasonCodes,
                  ]
                : candidate.selectionReasonCodes,
              rejectionReasonCodes: decision
                ? [
                    ...candidate.rejectionReasonCodes,
                    ...decision.rejectionReasonCodes,
                  ]
                : candidate.rejectionReasonCodes,
            };
          }),
        ];
        await repository.insertRetrievalCandidates({
          retrievalRunId: retrievalRunId!,
          userId: input.userId,
          candidates: candidateRecords,
          now: clock(),
        });

        const manifest: RetrievalRunManifest = {
          retrieval_run_id: retrievalRunId!,
          retrieval_policy_version: policy.version,
          query_construction_policy_version: RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
          projection_policy_version: CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
          deadline_ms: policy.deadlineMs,
          query_source_refs: constructed.sourceRefs,
          normalized_query_terms: normalizedTermsOf(constructed),
          lane_plan: constructed.lanePlan,
          lane_hit_counts: laneHitCounts,
          zero_signal: constructed.zeroSignal,
          candidate_count: deduped.length,
          qualified_count: withCutoffs.filter((candidate) => candidate.cutoffPassed)
            .length,
          fenced_out_count: fencedOut.length,
          selection_policy_versions: {
            portrait_selection: PORTRAIT_SELECTION_POLICY_VERSION,
            memory_budgets: MEMORY_BUDGETS_POLICY_VERSION,
            recall_framing: RECALL_FRAMING_POLICY_VERSION,
          },
          section_budget_vs_actual: plan.budgetVsActual,
          portrait_selection: {
            pool_count: plan.portraitPoolCount,
            selected_claim_version_ids: plan.portraitSelected.map(
              (candidate) => candidate.detail.versionId,
            ),
          },
          portrait_degraded_reason_codes: portraitDegradedCodes,
          timings,
          duration_ms: elapsed(),
          deadline_exceeded_stage: null,
          degraded_reason_codes: [],
        };
        await repository.completeRetrievalRun({
          retrievalRunId: retrievalRunId!,
          userId: input.userId,
          status: "completed",
          degradedReasonCodes: [],
          durationMs: manifest.duration_ms,
          deadlineExceededStage: null,
          timings,
          completedAt: clock(),
        });
        return {
          retrievalRunId,
          status: "completed",
          degradedReasonCodes: [],
          manifest,
          memorySections,
        };
      } catch (error) {
        const finalDuration = elapsed();
        if (error instanceof RetrievalDeadlineError) {
          degradedCodes.push("retrieval_deadline_exceeded");
        } else if (error instanceof RetrievalLaneFailureError) {
          degradedCodes.push("retrieval_lane_failed");
        } else if (error instanceof RetrievalQueryConstructionError) {
          degradedCodes.push("retrieval_query_construction_failed");
        } else if (error instanceof RetrievalHydrationError) {
          degradedCodes.push("retrieval_candidate_hydration_failed");
        } else {
          degradedCodes.push("retrieval_run_recording_failed");
        }
        const manifest: RetrievalRunManifest = {
          retrieval_run_id: retrievalRunId ?? "unrecorded",
          retrieval_policy_version: policy.version,
          query_construction_policy_version: RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
          projection_policy_version: CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
          deadline_ms: policy.deadlineMs,
          query_source_refs: query?.sourceRefs ?? [],
          normalized_query_terms: normalizedTermsOf(query),
          lane_plan: query?.lanePlan ?? [],
          lane_hit_counts: laneHitCounts,
          zero_signal: query?.zeroSignal ?? false,
          candidate_count: 0,
          qualified_count: 0,
          fenced_out_count: 0,
          selection_policy_versions: {
            portrait_selection: PORTRAIT_SELECTION_POLICY_VERSION,
            memory_budgets: MEMORY_BUDGETS_POLICY_VERSION,
            recall_framing: RECALL_FRAMING_POLICY_VERSION,
          },
          section_budget_vs_actual: emptyBudgetVsActual(),
          portrait_selection: { pool_count: 0, selected_claim_version_ids: [] },
          portrait_degraded_reason_codes: [],
          timings,
          duration_ms: finalDuration,
          deadline_exceeded_stage:
            error instanceof RetrievalDeadlineError ? error.stage : null,
          degraded_reason_codes: degradedCodes,
        };
        if (retrievalRunId !== null) {
          await repository
            .completeRetrievalRun({
              retrievalRunId,
              userId: input.userId,
              status: "degraded",
              degradedReasonCodes: degradedCodes,
              durationMs: finalDuration,
              deadlineExceededStage:
                error instanceof RetrievalDeadlineError ? error.stage : null,
              timings,
              completedAt: clock(),
            })
            .catch(() => {
              // The run row is already `running`; a failed outcome update
              // cannot be repaired in-request (no retry) — the code set is
              // already reflected on the returned manifest.
            });
        }
        return {
          retrievalRunId,
          status: "degraded",
          degradedReasonCodes: degradedCodes,
          manifest,
          memorySections: EMPTY_MEMORY_SECTIONS,
        };
      }
    },
  };
}

async function runLane(
  repository: MemoryRetrievalRepository,
  userId: UserId,
  lane: RetrievalLane,
  input: {
    query: ConstructedRetrievalQuery;
    policy: MemoryRetrievalPolicy;
    now: Date;
  },
): Promise<readonly RetrievalLaneRow[]> {
  const { query, policy, now } = input;
  if (lane === "structured_exact") {
    void now;
    return repository.runStructuredLane({
      userId,
      entityIds: query.resolvedEntities.map((entity) => entity.entityId),
      predicateIds: query.predicateCandidates.map(
        (candidate) => candidate.predicateId,
      ),
      canonicalKeys: query.canonicalKeys,
      dateTokens: query.dateTokens,
      limit: policy.candidateLimitPerLane,
    });
  }
  if (lane === "lexical_term_overlap") {
    return repository.runLexicalLane({
      userId,
      terms: query.lexicalTerms,
      limit: policy.candidateLimitPerLane,
    });
  }
  return repository.runEnglishLane({
    userId,
    queryText: query.englishQueryText,
    limit: policy.candidateLimitPerLane,
  });
}

function toCandidateHit(
  row: RetrievalLaneRow,
  query: ConstructedRetrievalQuery,
  now: Date,
): LaneCandidateHit {
  const claim = {
    claimId: row.memory_claim_id,
    versionId: row.memory_claim_version_id,
    projectionId: row.claim_retrieval_projection_id,
    canonicalKey: row.canonical_key,
    subjectEntityId: row.subject_entity_id,
    objectEntityId: row.object_entity_id,
    predicateId: row.predicate_id,
    kind: row.kind,
    temporalStatus: row.temporal_status,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    lastObservedAt: row.last_observed_at,
  };
  if (row.lane === "structured_exact") {
    const resolvedIds = new Set(
      query.resolvedEntities.map((entity) => entity.entityId),
    );
    const matchedFields: string[] = [];
    if (
      resolvedIds.has(row.subject_entity_id) ||
      (row.object_entity_id !== null && resolvedIds.has(row.object_entity_id))
    ) {
      matchedFields.push("entity_id");
    }
    if (
      query.predicateCandidates.some(
        (candidate) => candidate.predicateId === row.predicate_id,
      )
    ) {
      matchedFields.push("predicate_id");
    }
    if (query.canonicalKeys.includes(row.canonical_key)) {
      matchedFields.push("canonical_key");
    }
    if (
      temporalFitOf({ claim, timeWordClasses: query.timeWordClasses, now }) >= 2
    ) {
      matchedFields.push("time_range");
    }
    if (
      row.typed_value_text !== null &&
      query.dateTokens.some((token) => row.typed_value_text!.includes(token))
    ) {
      matchedFields.push("typed_value");
    }
    return {
      lane: row.lane,
      claim,
      matchedFields,
      matchedTerms: [],
      ftsRank: null,
    };
  }
  if (row.lane === "lexical_term_overlap") {
    return {
      lane: row.lane,
      claim,
      matchedFields: ["lexical_terms"],
      matchedTerms: row.matched_terms ?? [],
      ftsRank: null,
    };
  }
  return {
    lane: row.lane,
    claim,
    matchedFields: ["english_fts"],
    matchedTerms: [],
    ftsRank: row.fts_rank,
  };
}

function stubRankComponents(
  hit: LaneCandidateHit,
): import("./types").RankComponents {
  return {
    entity_match: 0,
    predicate_match: 0,
    temporal_fit: 0,
    lexical_coverage: hit.matchedTerms.length,
    fts_rank: hit.ftsRank,
    trust_kind: hit.claim.kind,
    last_observed_at: hit.claim.lastObservedAt,
    stable_id: hit.claim.versionId,
  };
}

function missingFenceResults(): readonly TrustFenceResult[] {
  // A candidate whose fence state cannot be loaded fails every fence
  // fail-closed rather than being silently dropped.
  return FENCE_ORDER.map((fence) => ({ fence, passed: false }));
}

function normalizedTermsOf(
  query: ConstructedRetrievalQuery | null,
): RetrievalRunManifest["normalized_query_terms"] {
  return {
    lexical_terms: query?.lexicalTerms ?? [],
    resolved_entities: (query?.resolvedEntities ?? []).map(
      (entity) => entity.entityId,
    ),
    predicate_candidates: (query?.predicateCandidates ?? []).map(
      (candidate) => candidate.predicateId,
    ),
    canonical_keys: query?.canonicalKeys ?? [],
    time_word_classes: query?.timeWordClasses ?? [],
    date_tokens: query?.dateTokens ?? [],
  };
}

function degradedOutcomeWithoutRun(input: {
  code: RetrievalDegradedReasonCode;
  durationMs: number;
}): MemoryRetrievalRunOutcome {
  return {
    retrievalRunId: null,
    status: "degraded",
    degradedReasonCodes: [input.code],
    manifest: {
      retrieval_run_id: "unrecorded",
      retrieval_policy_version: MEMORY_RETRIEVAL_POLICY_VERSION,
      query_construction_policy_version: RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
      projection_policy_version: CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
      deadline_ms: 0,
      query_source_refs: [],
      normalized_query_terms: {
        lexical_terms: [],
        resolved_entities: [],
        predicate_candidates: [],
        canonical_keys: [],
        time_word_classes: [],
        date_tokens: [],
      },
      lane_plan: [],
      lane_hit_counts: {
        structured_exact: 0,
        lexical_term_overlap: 0,
        english_fts: 0,
      },
      zero_signal: false,
      candidate_count: 0,
      qualified_count: 0,
      fenced_out_count: 0,
      selection_policy_versions: {
        portrait_selection: PORTRAIT_SELECTION_POLICY_VERSION,
        memory_budgets: MEMORY_BUDGETS_POLICY_VERSION,
        recall_framing: RECALL_FRAMING_POLICY_VERSION,
      },
      section_budget_vs_actual: emptyBudgetVsActual(),
      portrait_selection: { pool_count: 0, selected_claim_version_ids: [] },
      portrait_degraded_reason_codes: [],
      timings: {},
      duration_ms: input.durationMs,
      deadline_exceeded_stage: null,
      degraded_reason_codes: [input.code],
    },
    memorySections: EMPTY_MEMORY_SECTIONS,
  };
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
