import { describe, expect, it } from "vitest";

import {
  applyRelevanceCutoffs,
  dedupeLaneHits,
  evaluateTrustFences,
  rankCandidates,
  temporalFitOf,
} from "./ranking";
import type {
  CandidateFenceState,
  ConstructedRetrievalQuery,
  LaneCandidateHit,
  RetrievalCandidateClaimState,
} from "./types";

function claimState(
  overrides: Partial<RetrievalCandidateClaimState> = {},
): RetrievalCandidateClaimState {
  return {
    claimId: "claim-1",
    versionId: "version-1",
    projectionId: "projection-1",
    canonicalKey: "v1|sh.relationship.colleague_of|a+b|",
    subjectEntityId: "entity-self",
    objectEntityId: "entity-wang",
    predicateId: "sh.relationship.colleague_of",
    kind: "objective",
    temporalStatus: "current",
    validFrom: null,
    validTo: null,
    lastObservedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function fenceState(
  overrides: Partial<CandidateFenceState> = {},
): CandidateFenceState {
  return {
    versionId: "version-1",
    isCurrentVersion: true,
    claimDeleted: false,
    claimContentPurged: false,
    versionContentPurged: false,
    projectionContentPurged: false,
    versionStatus: "active",
    epistemicStatus: "confirmed",
    activeWholeClaimForget: false,
    validEvidenceCount: 2,
    subjectEntityVersionStatus: "active",
    objectEntityVersionStatus: "active",
    subjectEntityCurrentVersionStatus: "active",
    objectEntityCurrentVersionStatus: "active",
    subjectEntityDeleted: false,
    objectEntityDeleted: false,
    ...overrides,
  };
}

function hit(
  claim: RetrievalCandidateClaimState,
  lane: LaneCandidateHit["lane"],
  extra: Partial<LaneCandidateHit> = {},
): LaneCandidateHit {
  return {
    lane,
    claim,
    matchedFields: ["entity_id"],
    matchedTerms: [],
    ftsRank: null,
    ...extra,
  };
}

function query(overrides: Partial<ConstructedRetrievalQuery> = {}) {
  return {
    policyVersion: "memory-retrieval-query:v1",
    sourceRefs: [],
    userTexts: ["我同事小王怎么样"],
    englishQueryText: "",
    lexicalTerms: ["同事", "小王"],
    resolvedEntities: [
      { entityId: "entity-wang", basis: "label", surface: "小王" },
    ],
    predicateCandidates: [
      { predicateId: "sh.relationship.colleague_of", surface: "同事" },
    ],
    canonicalKeys: ["v1|sh.relationship.colleague_of|a+b|"],
    timeWordClasses: [],
    dateTokens: [],
    lanePlan: [],
    zeroSignal: false,
    ...overrides,
  } as ConstructedRetrievalQuery;
}

describe("evaluateTrustFences", () => {
  it("passes a fully eligible candidate", () => {
    const result = evaluateTrustFences({
      claim: claimState(),
      fenceState: fenceState(),
    });
    expect(result.every((fence) => fence.passed)).toBe(true);
    expect(result.map((fence) => fence.fence)).toEqual([
      "current_version",
      "evidence",
      "entity",
      "correction",
      "forget",
      "contested",
      "dormant",
      "deletion",
    ]);
  });

  it("fails a superseded (corrected-away) version on current_version and correction", () => {
    const result = evaluateTrustFences({
      claim: claimState(),
      fenceState: fenceState({
        isCurrentVersion: false,
        versionStatus: "superseded",
      }),
    });
    expect(result.find((f) => f.fence === "current_version")?.passed).toBe(false);
    expect(result.find((f) => f.fence === "correction")?.passed).toBe(false);
  });

  it("fails forget, contested, dormant, deletion, evidence, and entity fences", () => {
    expect(
      evaluateTrustFences({
        claim: claimState(),
        fenceState: fenceState({ activeWholeClaimForget: true }),
      }).find((f) => f.fence === "forget")?.passed,
    ).toBe(false);
    expect(
      evaluateTrustFences({
        claim: claimState(),
        fenceState: fenceState({
          epistemicStatus: "contested",
          versionStatus: "review_due",
        }),
      }).find((f) => f.fence === "contested")?.passed,
    ).toBe(false);
    expect(
      evaluateTrustFences({
        claim: claimState(),
        fenceState: fenceState({ versionStatus: "dormant" }),
      }).find((f) => f.fence === "dormant")?.passed,
    ).toBe(false);
    expect(
      evaluateTrustFences({
        claim: claimState(),
        fenceState: fenceState({ claimDeleted: true }),
      }).find((f) => f.fence === "deletion")?.passed,
    ).toBe(false);
    expect(
      evaluateTrustFences({
        claim: claimState(),
        fenceState: fenceState({ validEvidenceCount: 0 }),
      }).find((f) => f.fence === "evidence")?.passed,
    ).toBe(false);
    expect(
      evaluateTrustFences({
        claim: claimState(),
        fenceState: fenceState({ subjectEntityVersionStatus: "merged" }),
      }).find((f) => f.fence === "entity")?.passed,
    ).toBe(false);
  });

  it("keeps claims on a newly introduced (unresolved) object Entity recallable", () => {
    // Architecture §7.7-12: `unresolved` is the normal state of a newly
    // introduced Entity; its user-stated objective facts stay recallable
    // (SPEC #107 AC 5). The fence targets merged / split / deleted Entities.
    expect(
      evaluateTrustFences({
        claim: claimState(),
        fenceState: fenceState({
          objectEntityVersionStatus: "unresolved",
          objectEntityCurrentVersionStatus: "unresolved",
        }),
      }).find((f) => f.fence === "entity")?.passed,
    ).toBe(true);
    expect(
      evaluateTrustFences({
        claim: claimState(),
        fenceState: fenceState({
          objectEntityVersionStatus: "deleted",
          objectEntityDeleted: true,
        }),
      }).find((f) => f.fence === "entity")?.passed,
    ).toBe(false);
  });
});

describe("dedupeLaneHits", () => {
  it("keeps the highest-priority lane per claim version and records the demotion", () => {
    const claim = claimState();
    const deduped = dedupeLaneHits([
      hit(claim, "english_fts", { matchedTerms: ["wang"] }),
      hit(claim, "lexical_term_overlap", { matchedTerms: ["小王"] }),
      hit(claim, "structured_exact", { matchedTerms: [] }),
      hit(
        claimState({ versionId: "version-2", projectionId: "projection-2" }),
        "lexical_term_overlap",
      ),
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0]!.lane).toBe("structured_exact");
    expect(deduped[0]!.dedupeBeatenLanes).toEqual([
      "lexical_term_overlap",
      "english_fts",
    ]);
  });
});

describe("temporalFitOf", () => {
  const now = new Date("2026-08-27T00:00:00.000Z");
  it("is neutral without time words", () => {
    expect(
      temporalFitOf({ claim: claimState(), timeWordClasses: [], now }),
    ).toBe(1);
  });
  it("prefers ended claims for past words", () => {
    expect(
      temporalFitOf({
        claim: claimState({ temporalStatus: "ended" }),
        timeWordClasses: ["past"],
        now,
      }),
    ).toBeGreaterThan(
      temporalFitOf({
        claim: claimState({ temporalStatus: "current" }),
        timeWordClasses: ["past"],
        now,
      }),
    );
  });
  it("prefers recent observations for recent words", () => {
    expect(
      temporalFitOf({
        claim: claimState({ lastObservedAt: "2026-08-26T00:00:00.000Z" }),
        timeWordClasses: ["recent"],
        now,
      }),
    ).toBeGreaterThan(
      temporalFitOf({
        claim: claimState({ lastObservedAt: "2026-01-01T00:00:00.000Z" }),
        timeWordClasses: ["recent"],
        now,
      }),
    );
  });
});

describe("rankCandidates", () => {
  it("orders by entity match before predicate, kind, and recency; lane order is strict", () => {
    // Entity hit: object entity resolves through the query, predicate is NOT
    // a query candidate — pure entity signal.
    const entityHit = claimState({
      versionId: "v-entity",
      predicateId: "sh.relationship.friend_of",
      canonicalKey: "v1|sh.relationship.friend_of|a+b|",
      lastObservedAt: "2026-01-01T00:00:00.000Z",
    });
    // Predicate hit: predicate IS the query candidate, but neither claim
    // party resolves through the query — pure predicate signal.
    const predicateOnly = claimState({
      versionId: "v-predicate",
      subjectEntityId: "entity-other",
      objectEntityId: "entity-other-2",
      canonicalKey: "v1|sh.relationship.colleague_of|c+d|",
      lastObservedAt: "2026-08-01T00:00:00.000Z",
    });
    const ranked = rankCandidates({
      hits: [
        hit(predicateOnly, "lexical_term_overlap", { matchedFields: ["predicate_id"] }),
        hit(entityHit, "lexical_term_overlap", { matchedFields: ["entity_id"] }),
        hit(
          claimState({ versionId: "v-struct", projectionId: "p-3" }),
          "structured_exact",
          { matchedFields: ["canonical_key"] },
        ),
      ],
      query: query(),
      now: new Date("2026-08-27T00:00:00.000Z"),
    });
    // structured_exact lane strictly outranks the lexical lane.
    expect(ranked[0]!.claim.versionId).toBe("v-struct");
    // entity match beats predicate match within the lexical lane.
    expect(ranked[1]!.claim.versionId).toBe("v-entity");
    expect(ranked[2]!.claim.versionId).toBe("v-predicate");
    expect(ranked.map((candidate) => candidate.finalRank)).toEqual([1, 2, 3]);
  });

  it("breaks ties by recency then stable id", () => {
    const older = claimState({ versionId: "v-a", lastObservedAt: "2026-01-01T00:00:00.000Z" });
    const newer = claimState({ versionId: "v-z", lastObservedAt: "2026-06-01T00:00:00.000Z" });
    const ranked = rankCandidates({
      hits: [hit(older, "lexical_term_overlap"), hit(newer, "lexical_term_overlap")],
      query: query(),
      now: new Date("2026-08-27T00:00:00.000Z"),
    });
    expect(ranked[0]!.claim.versionId).toBe("v-z");
  });
});

describe("applyRelevanceCutoffs", () => {
  it("passes canonical-key exact and entity+predicate joint hits", () => {
    const canonical = claimState({ versionId: "v-canonical" });
    const joint = claimState({
      versionId: "v-joint",
      canonicalKey: "v1|other|a+b|",
    });
    const result = applyRelevanceCutoffs({
      ranked: [
        {
          claim: canonical,
          lane: "structured_exact",
          matchedFields: ["canonical_key"],
          matchedTerms: [],
          rankComponents: {
            entity_match: 1,
            predicate_match: 1,
            temporal_fit: 1,
            lexical_coverage: 0,
            fts_rank: null,
            trust_kind: "objective",
            last_observed_at: canonical.lastObservedAt,
            stable_id: canonical.versionId,
          },
          finalRank: 1,
          cutoffPassed: true,
          selectionReasonCodes: [],
          rejectionReasonCodes: [],
        },
        {
          claim: joint,
          lane: "structured_exact",
          matchedFields: ["entity_id", "predicate_id"],
          matchedTerms: [],
          rankComponents: {
            entity_match: 1,
            predicate_match: 1,
            temporal_fit: 1,
            lexical_coverage: 0,
            fts_rank: null,
            trust_kind: "objective",
            last_observed_at: joint.lastObservedAt,
            stable_id: joint.versionId,
          },
          finalRank: 2,
          cutoffPassed: true,
          selectionReasonCodes: [],
          rejectionReasonCodes: [],
        },
      ],
      query: query(),
    });
    expect(result[0]!.selectionReasonCodes).toContain(
      "relevance_cutoff_canonical_key_exact",
    );
    expect(result[1]!.selectionReasonCodes).toContain(
      "relevance_cutoff_entity_predicate_joint",
    );
  });

  it("rejects a single plain lexical term", () => {
    const claim = claimState({
      canonicalKey: "v1|sh.relationship.colleague_of|x+y|",
      subjectEntityId: "entity-other",
      objectEntityId: "entity-other-2",
    });
    const result = applyRelevanceCutoffs({
      ranked: [
        {
          claim,
          lane: "lexical_term_overlap",
          matchedFields: ["lexical_terms"],
          matchedTerms: ["小王"],
          rankComponents: {
            entity_match: 0,
            predicate_match: 0,
            temporal_fit: 1,
            lexical_coverage: 1,
            fts_rank: null,
            trust_kind: "objective",
            last_observed_at: claim.lastObservedAt,
            stable_id: claim.versionId,
          },
          finalRank: 1,
          cutoffPassed: true,
          selectionReasonCodes: [],
          rejectionReasonCodes: [],
        },
      ],
      query: query(),
    });
    expect(result[0]!.cutoffPassed).toBe(false);
    expect(result[0]!.rejectionReasonCodes).toContain(
      "relevance_cutoff_single_term",
    );
  });

  it("passes two independent non-broad lexical terms and rejects broad-only matches", () => {
    const claim = claimState({
      canonicalKey: "v1|sh.relationship.colleague_of|x+y|",
      subjectEntityId: "entity-other",
      objectEntityId: "entity-other-2",
    });
    const twoTerms = { ...claim, versionId: "v-two" };
    const broadOnly = { ...claim, versionId: "v-broad" };
    const result = applyRelevanceCutoffs({
      ranked: [
        {
          claim: twoTerms,
          lane: "lexical_term_overlap",
          matchedFields: ["lexical_terms"],
          matchedTerms: ["小王", "青禾计划"],
          rankComponents: {
            entity_match: 0,
            predicate_match: 0,
            temporal_fit: 1,
            lexical_coverage: 2,
            fts_rank: null,
            trust_kind: "objective",
            last_observed_at: twoTerms.lastObservedAt,
            stable_id: twoTerms.versionId,
          },
          finalRank: 1,
          cutoffPassed: true,
          selectionReasonCodes: [],
          rejectionReasonCodes: [],
        },
        {
          claim: broadOnly,
          lane: "lexical_term_overlap",
          matchedFields: ["lexical_terms"],
          matchedTerms: ["工作", "开心"],
          rankComponents: {
            entity_match: 0,
            predicate_match: 0,
            temporal_fit: 1,
            lexical_coverage: 2,
            fts_rank: null,
            trust_kind: "objective",
            last_observed_at: broadOnly.lastObservedAt,
            stable_id: broadOnly.versionId,
          },
          finalRank: 2,
          cutoffPassed: true,
          selectionReasonCodes: [],
          rejectionReasonCodes: [],
        },
      ],
      query: query(),
    });
    expect(result[0]!.cutoffPassed).toBe(true);
    expect(result[0]!.selectionReasonCodes).toContain(
      "relevance_cutoff_lexical_two_terms",
    );
    expect(result[1]!.cutoffPassed).toBe(false);
    expect(result[1]!.rejectionReasonCodes).toContain(
      "relevance_cutoff_broad_term_only",
    );
  });

  it("requires two independent signals for an AI Impression and keeps at most one per run", () => {
    const impression = (versionId: string): RetrievalCandidateClaimState => ({
      ...claimState({
        versionId,
        kind: "impression",
        canonicalKey: "v1|sh.person.style|x|",
        predicateId: "sh.person.stated_style",
        objectEntityId: null,
      }),
    });
    const withSignals = impression("v-imp-1");
    const singleSignal = impression("v-imp-2");
    const extraQualified = impression("v-imp-3");
    const rank = (
      claim: RetrievalCandidateClaimState,
      entityMatch: number,
      terms: string[],
    ): import("./types").RankedCandidate => ({
      claim,
      lane: "lexical_term_overlap" as const,
      matchedFields: ["lexical_terms"],
      matchedTerms: terms,
      rankComponents: {
        entity_match: entityMatch,
        predicate_match: 0,
        temporal_fit: 1,
        lexical_coverage: terms.length,
        fts_rank: null,
        trust_kind: "impression" as const,
        last_observed_at: claim.lastObservedAt,
        stable_id: claim.versionId,
      },
      finalRank: 1,
      cutoffPassed: true,
      selectionReasonCodes: [],
      rejectionReasonCodes: [],
    });
    const result = applyRelevanceCutoffs({
      ranked: [
        rank(withSignals, 1, ["小王", "青禾计划"]),
        rank(singleSignal, 0, ["青禾计划"]),
        rank(extraQualified, 1, ["小王", "别的计划"]),
      ],
      query: query(),
    });
    expect(result[0]!.cutoffPassed).toBe(true);
    expect(result[0]!.selectionReasonCodes).toContain(
      "relevance_cutoff_impression_two_signals",
    );
    expect(result[1]!.cutoffPassed).toBe(false);
    expect(result[1]!.rejectionReasonCodes).toContain(
      "relevance_cutoff_impression_single_signal",
    );
    // Per-run Impression cap (architecture §10.3): only the best-ranked one stays.
    expect(result[2]!.cutoffPassed).toBe(false);
    expect(result[2]!.rejectionReasonCodes).toContain(
      "relevance_cutoff_impression_per_run_limit",
    );
  });

  it("rejects entity-only structured hits with insufficient signals", () => {
    const claim = claimState({
      versionId: "v-entity-only",
      canonicalKey: "v1|sh.relationship.colleague_of|x+y|",
      predicateId: "sh.relationship.friend_of",
    });
    const result = applyRelevanceCutoffs({
      ranked: [
        {
          claim,
          lane: "structured_exact",
          matchedFields: ["entity_id"],
          matchedTerms: [],
          rankComponents: {
            entity_match: 1,
            predicate_match: 0,
            temporal_fit: 1,
            lexical_coverage: 0,
            fts_rank: null,
            trust_kind: "objective",
            last_observed_at: claim.lastObservedAt,
            stable_id: claim.versionId,
          },
          finalRank: 1,
          cutoffPassed: true,
          selectionReasonCodes: [],
          rejectionReasonCodes: [],
        },
      ],
      query: query(),
    });
    expect(result[0]!.cutoffPassed).toBe(false);
    expect(result[0]!.rejectionReasonCodes).toContain(
      "relevance_cutoff_insufficient_signals",
    );
  });

  describe("object-elided canonical-key match (#152)", () => {
    const rankByCanonicalKey = (
      claim: RetrievalCandidateClaimState,
    ): import("./types").RankedCandidate => ({
      claim,
      lane: "structured_exact" as const,
      matchedFields: ["canonical_key"],
      matchedTerms: [],
      rankComponents: {
        entity_match: 0,
        predicate_match: 0,
        temporal_fit: 1,
        lexical_coverage: 0,
        fts_rank: null,
        trust_kind: "objective" as const,
        last_observed_at: claim.lastObservedAt,
        stable_id: claim.versionId,
      },
      finalRank: 1,
      cutoffPassed: true,
      selectionReasonCodes: [],
      rejectionReasonCodes: [],
    });

    it("matches a v1 scope-none claim whose bound object is elided from the query key", () => {
      const claim = claimState({
        versionId: "v-elided",
        canonicalKey: "v1|sh.work.employer|entity-self>entity-company|",
        subjectEntityId: "entity-self",
        objectEntityId: "entity-company",
        predicateId: "sh.work.employer",
      });
      const result = applyRelevanceCutoffs({
        ranked: [rankByCanonicalKey(claim)],
        query: query({
          canonicalKeys: ["v1|sh.work.employer|entity-self>|"],
        }),
      });
      expect(result[0]!.cutoffPassed).toBe(true);
      expect(result[0]!.selectionReasonCodes).toContain(
        "relevance_cutoff_canonical_key_object_elided",
      );
    });

    it("does not trigger object-elided matching for a non-v1 key version", () => {
      const claim = claimState({
        versionId: "v-future",
        canonicalKey: "v2|sh.work.employer|entity-self>entity-company|",
        subjectEntityId: "entity-self",
        objectEntityId: "entity-company",
        predicateId: "sh.work.employer",
      });
      const result = applyRelevanceCutoffs({
        ranked: [rankByCanonicalKey(claim)],
        query: query({
          canonicalKeys: ["v2|sh.work.employer|entity-self>|"],
        }),
      });
      expect(result[0]!.cutoffPassed).toBe(false);
      expect(result[0]!.selectionReasonCodes).not.toContain(
        "relevance_cutoff_canonical_key_object_elided",
      );
      expect(result[0]!.rejectionReasonCodes).toContain(
        "relevance_cutoff_insufficient_signals",
      );
    });
  });
});
