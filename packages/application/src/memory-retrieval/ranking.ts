import {
  RETRIEVAL_BROAD_TERM_STOP_LIST,
  RETRIEVAL_LANE_PRIORITY,
  type CandidateFenceState,
  type ConstructedRetrievalQuery,
  type LaneCandidateHit,
  type RankedCandidate,
  type RankComponents,
  type RetrievalCandidateClaimState,
  type RetrievalLane,
  type RetrievalTimeWordClass,
  type TrustFenceResult,
} from "./types";

/**
 * Deterministic fences, lane dedupe, ranking, and relevance cutoffs
 * (architecture §10.2 / §10.3). Trust fences run before and across ranking;
 * the three lanes never merge into one cross-lane score; recency only breaks
 * ties. Every decision is recorded as structured reason codes for the
 * retrieval manifest.
 */

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/** Canonical fence evaluation order (single source). */
export const FENCE_ORDER = [
  "current_version",
  "evidence",
  "entity",
  "correction",
  "forget",
  "contested",
  "dormant",
  "deletion",
] as const;

export function evaluateTrustFences(input: {
  claim: RetrievalCandidateClaimState;
  fenceState: CandidateFenceState;
}): readonly TrustFenceResult[] {
  const state = input.fenceState;
  const results: readonly TrustFenceResult[] = [
    { fence: "current_version", passed: state.isCurrentVersion },
    { fence: "evidence", passed: state.validEvidenceCount > 0 },
    {
      fence: "entity",
      passed:
        state.subjectEntityVersionStatus === "active" &&
        state.subjectEntityCurrentVersionStatus === "active" &&
        !state.subjectEntityDeleted &&
        (input.claim.objectEntityId === null ||
          (state.objectEntityVersionStatus === "active" &&
            state.objectEntityCurrentVersionStatus === "active" &&
            !state.objectEntityDeleted)),
    },
    { fence: "correction", passed: state.versionStatus !== "superseded" },
    { fence: "forget", passed: !state.activeWholeClaimForget },
    {
      fence: "contested",
      passed:
        state.epistemicStatus !== "contested" && state.versionStatus !== "review_due",
    },
    {
      fence: "dormant",
      passed: !(state.versionStatus === "dormant"),
    },
    {
      fence: "deletion",
      passed:
        !state.claimDeleted &&
        !state.claimContentPurged &&
        !state.versionContentPurged &&
        !state.projectionContentPurged,
    },
  ];
  const byFence = new Map(results.map((result) => [result.fence, result]));
  return FENCE_ORDER.map((fence) => byFence.get(fence)!);
}

export type DedupedCandidate = LaneCandidateHit &
  Readonly<{ dedupeBeatenLanes: readonly RetrievalLane[] }>;

/**
 * Cross-lane dedupe by `claim_version_id`: the highest-priority lane wins and
 * the demoted lanes are recorded on the surviving hit (architecture §10.2 —
 * no cross-lane score fusion, strict lane priority).
 */
export function dedupeLaneHits(
  hits: readonly LaneCandidateHit[],
): readonly DedupedCandidate[] {
  const byVersion = new Map<string, DedupedCandidate>();
  for (const hit of hits) {
    const existing = byVersion.get(hit.claim.versionId);
    if (!existing) {
      byVersion.set(hit.claim.versionId, { ...hit, dedupeBeatenLanes: [] });
      continue;
    }
    const incomingPriority = RETRIEVAL_LANE_PRIORITY.indexOf(hit.lane);
    const existingPriority = RETRIEVAL_LANE_PRIORITY.indexOf(existing.lane);
    if (incomingPriority < existingPriority) {
      byVersion.set(hit.claim.versionId, {
        ...hit,
        dedupeBeatenLanes: [...existing.dedupeBeatenLanes, existing.lane].sort(
          (a, b) => RETRIEVAL_LANE_PRIORITY.indexOf(a) - RETRIEVAL_LANE_PRIORITY.indexOf(b),
        ),
      });
    } else {
      byVersion.set(hit.claim.versionId, {
        ...existing,
        dedupeBeatenLanes: [...existing.dedupeBeatenLanes, hit.lane].sort(
          (a, b) => RETRIEVAL_LANE_PRIORITY.indexOf(a) - RETRIEVAL_LANE_PRIORITY.indexOf(b),
        ),
      });
    }
  }
  return [...byVersion.values()];
}

export function temporalFitOf(input: {
  claim: RetrievalCandidateClaimState;
  timeWordClasses: readonly RetrievalTimeWordClass[];
  now: Date;
}): number {
  const { claim, timeWordClasses, now } = input;
  if (timeWordClasses.length === 0) return 1;
  let best = 0;
  for (const clazz of timeWordClasses) {
    if (clazz === "past") {
      const ended =
        claim.temporalStatus === "ended" ||
        (claim.validTo !== null && Date.parse(claim.validTo) < now.getTime());
      best = Math.max(best, ended ? 2 : 0);
    } else if (clazz === "recent") {
      const recent =
        now.getTime() - Date.parse(claim.lastObservedAt) <= RECENT_WINDOW_MS;
      best = Math.max(best, recent ? 2 : 0);
    } else {
      // `上次` asks for the most recent occurrence; recency breaks the tie.
      best = Math.max(best, 1);
    }
  }
  return best;
}

function rankComponentsOf(
  hit: LaneCandidateHit,
  query: ConstructedRetrievalQuery,
  now: Date,
): RankComponents {
  const resolvedIds = new Set(
    query.resolvedEntities.map((entity) => entity.entityId),
  );
  const entityMatch =
    (resolvedIds.has(hit.claim.subjectEntityId) ? 1 : 0) +
    (hit.claim.objectEntityId !== null && resolvedIds.has(hit.claim.objectEntityId)
      ? 1
      : 0);
  return {
    entity_match: entityMatch,
    predicate_match: query.predicateCandidates.some(
      (candidate) => candidate.predicateId === hit.claim.predicateId,
    )
      ? 1
      : 0,
    temporal_fit: temporalFitOf({
      claim: hit.claim,
      timeWordClasses: query.timeWordClasses,
      now,
    }),
    lexical_coverage: hit.matchedTerms.length,
    fts_rank: hit.ftsRank,
    trust_kind: hit.claim.kind,
    last_observed_at: hit.claim.lastObservedAt,
    stable_id: hit.claim.versionId,
  };
}

function compareCandidates(
  left: { components: RankComponents; lane: RetrievalLane },
  right: { components: RankComponents; lane: RetrievalLane },
): number {
  const laneDelta =
    RETRIEVAL_LANE_PRIORITY.indexOf(left.lane) -
    RETRIEVAL_LANE_PRIORITY.indexOf(right.lane);
  if (laneDelta !== 0) return laneDelta;
  if (left.components.entity_match !== right.components.entity_match) {
    return right.components.entity_match - left.components.entity_match;
  }
  if (left.components.predicate_match !== right.components.predicate_match) {
    return right.components.predicate_match - left.components.predicate_match;
  }
  if (left.components.temporal_fit !== right.components.temporal_fit) {
    return right.components.temporal_fit - left.components.temporal_fit;
  }
  const coverageDelta = coverageOf(left) - coverageOf(right);
  if (coverageDelta !== 0) return coverageDelta;
  const kindDelta =
    (left.components.trust_kind === "objective" ? 0 : 1) -
    (right.components.trust_kind === "objective" ? 0 : 1);
  if (kindDelta !== 0) return kindDelta;
  const recencyDelta =
    Date.parse(right.components.last_observed_at) -
    Date.parse(left.components.last_observed_at);
  if (recencyDelta !== 0) return recencyDelta;
  return left.components.stable_id.localeCompare(right.components.stable_id, "en");
}

function coverageOf(candidate: { components: RankComponents; lane: RetrievalLane }): number {
  return candidate.lane === "english_fts"
    ? candidate.components.fts_rank ?? 0
    : candidate.components.lexical_coverage;
}

/**
 * Deterministic global ordering: strict lane priority first, then the
 * §10.3 comparator inside each lane. `final_rank` is assigned sequentially
 * over the global order.
 */
export function rankCandidates(input: {
  hits: readonly (LaneCandidateHit &
    Readonly<{ dedupeBeatenLanes?: readonly RetrievalLane[] }>)[];
  query: ConstructedRetrievalQuery;
  now: Date;
}): readonly RankedCandidate[] {
  const withComponents = input.hits.map((hit) => ({
    hit,
    components: rankComponentsOf(hit, input.query, input.now),
  }));
  withComponents.sort((left, right) =>
    compareCandidates(
      { components: left.components, lane: left.hit.lane },
      { components: right.components, lane: right.hit.lane },
    ),
  );
  return withComponents.map(({ hit, components }, index) => ({
    claim: hit.claim,
    lane: hit.lane,
    matchedFields: hit.matchedFields,
    matchedTerms: hit.matchedTerms,
    rankComponents: components,
    finalRank: index + 1,
    cutoffPassed: true,
    selectionReasonCodes:
      (hit.dedupeBeatenLanes ?? []).length > 0
        ? hit.dedupeBeatenLanes!.map((lane) => `lane_dedupe_won_over_${lane}`)
        : [],
    rejectionReasonCodes: [],
  }));
}

const broadTerms = new Set(RETRIEVAL_BROAD_TERM_STOP_LIST);

/**
 * Relevance cutoffs (architecture §10.3): canonical-key exact or
 * Entity+Predicate joint hits pass for Objective Memory; plain lexical
 * matches need ≥2 independent non-broad terms; a unique resolved alias forms
 * a structured anchor (entity signal); an AI Impression needs ≥2 independent
 * signals and at most one Impression qualifies per run.
 */
export function applyRelevanceCutoffs(input: {
  ranked: readonly RankedCandidate[];
  query: ConstructedRetrievalQuery;
}): readonly RankedCandidate[] {
  let impressionQualified = 0;
  return input.ranked.map((candidate) => {
    const components = candidate.rankComponents;
    const effectiveTerms = [
      ...new Set(
        candidate.matchedTerms.filter((term) => !broadTerms.has(term)),
      ),
    ];
    const canonicalKeyExact = input.query.canonicalKeys.includes(
      candidate.claim.canonicalKey,
    );
    const entityPredicateJoint =
      components.entity_match > 0 && components.predicate_match === 1;
    const twoIndependentTerms = effectiveTerms.length >= 2;

    let passed: boolean;
    const selectionReasonCodes = [...candidate.selectionReasonCodes];
    const rejectionReasonCodes: string[] = [];
    if (canonicalKeyExact || entityPredicateJoint || twoIndependentTerms) {
      passed = true;
      if (canonicalKeyExact) {
        selectionReasonCodes.push("relevance_cutoff_canonical_key_exact");
      }
      if (entityPredicateJoint) {
        selectionReasonCodes.push("relevance_cutoff_entity_predicate_joint");
      }
      if (twoIndependentTerms) {
        selectionReasonCodes.push("relevance_cutoff_lexical_two_terms");
      }
    } else {
      passed = false;
      if (effectiveTerms.length === 0 && candidate.matchedTerms.length > 0) {
        rejectionReasonCodes.push("relevance_cutoff_broad_term_only");
      } else if (effectiveTerms.length === 1) {
        rejectionReasonCodes.push("relevance_cutoff_single_term");
      } else {
        rejectionReasonCodes.push("relevance_cutoff_insufficient_signals");
      }
    }

    if (candidate.claim.kind === "impression") {
      const signals = [
        components.entity_match > 0,
        components.predicate_match === 1,
        components.temporal_fit >= 2,
        twoIndependentTerms,
      ].filter(Boolean).length;
      if (signals < 2) {
        // Recorded alongside any objective-floor code: both limits failed.
        passed = false;
        rejectionReasonCodes.push("relevance_cutoff_impression_single_signal");
      } else if (passed) {
        selectionReasonCodes.push("relevance_cutoff_impression_two_signals");
        if (impressionQualified >= 1) {
          passed = false;
          rejectionReasonCodes.push("relevance_cutoff_impression_per_run_limit");
        } else {
          impressionQualified += 1;
        }
      }
    }

    return {
      ...candidate,
      cutoffPassed: passed,
      selectionReasonCodes,
      rejectionReasonCodes,
    };
  });
}

/** Fence failure code recorded on the manifest row. */
export function fenceFailureCodes(
  results: readonly TrustFenceResult[],
): readonly string[] {
  return results
    .filter((result) => !result.passed)
    .map((result) => `trust_fence_failed_${result.fence}`);
}
