import { describe, expect, it } from "vitest";

import {
  buildRetrievalQuery,
  loadPredicateRegistrySnapshot,
  type RetrievalQuerySubstrate,
  type RetrievalRegistryMaterial,
} from "@sayhear/application";

import {
  buildCorpus,
  compileLocaleOf,
  POST_DORMANCY_QUERY,
  validateCorpus,
  type CorpusTurnSpec,
  type PrecisionCorpus,
} from "../eval/retrieval-precision-v1/corpus";
import {
  evaluateQueryRuns,
  zeroToleranceViolations,
  type InjectedItem,
  type QueryRunRecord,
} from "../eval/retrieval-precision-v1/metrics";

/**
 * Issue #125 — pure-side proofs for the retrieval-precision corpus runner:
 * corpus determinism and ground-truth integrity (AC 38 counts, fences,
 * language allocation), pre-validation of every probe query against the REAL
 * production query construction, and the accounting math with its absolute
 * zeros (fence leakage, budget violations, deadline violations).
 */

const registrySnapshot = loadPredicateRegistrySnapshot(1);

const registryMaterial: RetrievalRegistryMaterial = {
  registryVersion: registrySnapshot.registryVersion,
  entryFor(predicateId) {
    return (
      registrySnapshot.entries.find((entry) => entry.predicateId === predicateId) ?? null
    );
  },
  localizations: registrySnapshot.localizations,
};

const corpus: PrecisionCorpus = buildCorpus();

describe("retrieval-precision corpus definition (#125, AC 38)", () => {
  it("is deterministic under the fixed seed — two builds are byte-identical", () => {
    const again = buildCorpus();
    expect(JSON.stringify(again)).toBe(JSON.stringify(corpus));
    expect(corpus.seed).toBe(20260828);
    expect(corpus.version).toBe("retrieval-precision-corpus:v1");
  });

  it("carries the synthetic notice and the ~10 days × 2 sessions × ~12 turns shape", () => {
    expect(corpus.syntheticNotice).toMatch(/synthetic/i);
    expect(corpus.days).toBe(10);
    expect(corpus.sessionsPerDay).toBe(2);
    expect(corpus.turnsPerSession).toBe(12);
    expect(corpus.turns).toHaveLength(10 * 2 * 12);
    expect(corpus.timezone).toBe("Asia/Shanghai");
  });

  it("passes its own integrity validation", () => {
    expect(validateCorpus(corpus)).toEqual([]);
  });

  it("plants ≥30 claims across all required categories plus at least as many distractors", () => {
    const planted = corpus.claims.filter((claim) => claim.category !== "distractor");
    const distractors = corpus.claims.filter((claim) => claim.category === "distractor");
    expect(planted.length).toBeGreaterThanOrEqual(30);
    expect(distractors.length).toBeGreaterThanOrEqual(planted.length);

    const categories = new Set(planted.map((claim) => claim.category));
    expect(categories.has("objective_fact")).toBe(true);
    expect(categories.has("relationship")).toBe(true);
    expect(categories.has("impression")).toBe(true);
    expect(planted.filter((claim) => claim.supersedesClaimId !== undefined).length).toBeGreaterThanOrEqual(3);
    // People: bilingual probe persons exist (en-primary and zh-primary with aliases).
    expect(corpus.people.filter((p) => p.role === "probe" && p.primaryLocale === "en").length).toBeGreaterThanOrEqual(3);
    expect(corpus.people.filter((p) => p.role === "probe" && p.alias).length).toBeGreaterThanOrEqual(3);
  });

  it("allocates queries across zh / en / mix and plants cross-day probes", () => {
    const queryTurns = corpus.turns.filter((turn) => turn.query);
    for (const locale of ["zh", "en", "mix"] as const) {
      expect(queryTurns.some((turn) => turn.locale === locale)).toBe(true);
    }
    // Every probe is cross-day: the expected claims were planted on an earlier day.
    const statementDayByClaim = new Map<string, number>();
    for (const claim of corpus.claims) {
      const turnId = claim.category === "impression"
        ? claim.evidenceTurnIds?.[0]
        : claim.statementTurnId;
      const turn = corpus.turns.find((candidate) => candidate.turnId === turnId);
      if (turn) statementDayByClaim.set(claim.claimId, turn.day);
    }
    let crossDayQueries = 0;
    for (const turn of queryTurns) {
      const claims = turn.query!.expectedClaimIds;
      if (claims.length === 0) continue;
      expect(claims.every((claimId) => (statementDayByClaim.get(claimId) ?? 0) < turn.day)).toBe(true);
      crossDayQueries += 1;
    }
    expect(crossDayQueries).toBeGreaterThanOrEqual(20);
    // Fence probes exist for the forgotten claims and for post-dormancy.
    expect(queryTurns.filter((turn) => turn.query!.phase === "post_forget")).toHaveLength(2);
    expect(POST_DORMANCY_QUERY.phase).toBe("post_dormancy");
  });

  it("keeps filler turns free of query signals (no resolved entity, no registry alias)", () => {
    const labelIndex = corpus.people.map((person) => ({
      entityId: `entity-${person.personId}`,
      label: person.primaryLabel,
      labelKind: "primary" as const,
      locale: person.primaryLocale,
    }));
    for (const turn of corpus.turns.filter((candidate) => candidate.role === "filler")) {
      const query = buildRetrievalQuery({
        sources: {
          currentInput: { revisionId: "rev", text: turn.text },
          priorUserEvents: [],
          currentTopic: null,
          dialogueRevision: 0,
          selfEntityId: "entity-self",
          labelIndex,
          resolverHints: [],
        },
        registry: registryMaterial,
      });
      expect(query.resolvedEntities).toEqual([]);
      expect(query.predicateCandidates).toEqual([]);
    }
  });

  it("every probe query produces structured signal that can reach its expected claims", () => {
    const entityIdOf = new Map(corpus.people.map((person) => [person.personId, `entity-${person.personId}`]));
    const claimById = new Map(corpus.claims.map((claim) => [claim.claimId, claim]));
    const labelIndex = corpus.people.flatMap((person) => [
      {
        entityId: entityIdOf.get(person.personId)!,
        label: person.primaryLabel,
        labelKind: "primary" as const,
        locale: person.primaryLocale,
      },
      ...(person.alias
        ? [{
            entityId: entityIdOf.get(person.personId)!,
            label: person.alias.label,
            labelKind: "alias" as const,
            locale: person.alias.locale,
          }]
        : []),
    ]);
    const substrate: RetrievalQuerySubstrate = {
      priorUserEvents: [],
      selfEntityId: "entity-self",
      labelIndex,
      resolverHints: [],
    };

    const queryTurns = corpus.turns.filter((turn): turn is CorpusTurnSpec & { query: NonNullable<CorpusTurnSpec["query"]> } => turn.query !== undefined);
    expect(queryTurns.length).toBeGreaterThanOrEqual(30);
    for (const turn of queryTurns) {
      const query = turn.query!;
      const built = buildRetrievalQuery({
        sources: {
          currentInput: { revisionId: `rev-${query.queryId}`, text: query.text },
          priorUserEvents: [],
          currentTopic: null,
          dialogueRevision: 0,
          selfEntityId: "entity-self",
          labelIndex,
          resolverHints: [],
        },
        registry: registryMaterial,
      });
      expect(built.zeroSignal, `${query.queryId} must enable at least one lane`).toBe(false);
      const resolvedIds = new Set(built.resolvedEntities.map((entity) => entity.entityId));
      const candidatePredicates = new Set(built.predicateCandidates.map((candidate) => candidate.predicateId));
      for (const claimId of query.expectedClaimIds) {
        const claim = claimById.get(claimId)!;
        if (claim.personId !== undefined) {
          expect(
            resolvedIds.has(entityIdOf.get(claim.personId)!),
            `${query.queryId} must resolve the person ${claim.personId}`,
          ).toBe(true);
        } else {
          expect(
            candidatePredicates.has(claim.predicateId),
            `${query.queryId} must surface predicate ${claim.predicateId}`,
          ).toBe(true);
        }
      }
      // Fence probes still produce signal lanes (they exercise the fences, not silence).
      if (query.phase !== "main") {
        expect(
          built.lanePlan.some((lane) => lane.enabled),
          `${query.queryId} fence probe must still enable lanes`,
        ).toBe(true);
      }
    }

    // The post-dormancy probe (not part of the turn grid) passes the same bar.
    const dormancyBuilt = buildRetrievalQuery({
      sources: {
        currentInput: { revisionId: "rev-dormant", text: POST_DORMANCY_QUERY.text },
        priorUserEvents: [],
        currentTopic: null,
        dialogueRevision: 0,
        selfEntityId: "entity-self",
        labelIndex,
        resolverHints: [],
      },
      registry: registryMaterial,
    });
    expect(dormancyBuilt.zeroSignal).toBe(false);
    expect(dormancyBuilt.predicateCandidates.map((candidate) => candidate.predicateId)).toContain(
      claimById.get(POST_DORMANCY_QUERY.fencedClaimIds![0]!)!.predicateId,
    );
  });

  it("resolves mix queries to zh when the text contains CJK", () => {
    expect(compileLocaleOf("mix", "同事小王还好吗")).toBe("zh");
    expect(compileLocaleOf("mix", "How is my colleague David?")).toBe("en");
    expect(compileLocaleOf("zh", "你好")).toBe("zh");
  });
});

// ---------------------------------------------------------------------------
// Accounting metrics + absolute zeros (pure).
// ---------------------------------------------------------------------------

function runRecord(overrides: Partial<QueryRunRecord> & { queryId: string }): QueryRunRecord {
  return {
    query: {
      queryId: overrides.queryId,
      text: "probe",
      locale: "zh",
      phase: "main",
      expectedClaimIds: [],
    },
    compiledLocale: "zh",
    expectedVersionIds: [],
    fencedVersionIds: [],
    status: "completed",
    degradedReasonCodes: [],
    durationMs: 20,
    deadlineMs: 200,
    deadlineExceededStage: null,
    qualifiedVersionIds: [],
    injected: [],
    injectedFenceFailures: [],
    laneHitCounts: { structured_exact: 0, lexical_term_overlap: 0, english_fts: 0 },
    ...overrides,
  };
}

function injectedItem(versionId: string, overrides: Partial<InjectedItem> = {}): InjectedItem {
  return {
    versionId,
    section: "objective_memory",
    selectionSource: "query_retrieval",
    kind: "objective",
    ...overrides,
  };
}

const VERSION_BY_CLAIM = new Map<string, string>([
  ["claim-a", "version-a"],
  ["claim-b", "version-b"],
  ["claim-distractor", "version-distractor"],
]);
const CLAIM_BY_VERSION = new Map<string, string>([
  ["version-a", "claim-a"],
  ["version-b", "claim-b"],
  ["version-distractor", "claim-distractor"],
]);

function tinyCorpus(): PrecisionCorpus {
  return {
    ...corpus,
    claims: [
      { claimId: "claim-a", category: "objective_fact", kind: "objective", predicateId: "p.a" },
      { claimId: "claim-b", category: "relationship", kind: "objective", predicateId: "p.b", personId: "wang" },
      { claimId: "claim-distractor", category: "distractor", kind: "objective", predicateId: "p.c", personId: "wang2" },
    ],
    turns: corpus.turns.map((turn, index) => {
      if (index === 0) {
        return {
          ...turn,
          role: "query" as const,
          query: {
            queryId: "q-1", text: "probe", locale: "zh" as const, phase: "main" as const,
            expectedClaimIds: ["claim-a"],
          },
        };
      }
      if (index === 1) {
        return {
          ...turn,
          role: "query" as const,
          query: {
            queryId: "q-fence", text: "probe", locale: "zh" as const, phase: "post_forget" as const,
            expectedClaimIds: [], fencedClaimIds: ["claim-b"],
          },
        };
      }
      return turn;
    }),
  };
}

describe("retrieval-precision accounting metrics (#125)", () => {
  const smallCorpus = tinyCorpus();

  it("computes hit rates and query-retrieval precision from per-query runs", () => {
    const runs: QueryRunRecord[] = [
      runRecord({
        queryId: "q-1",
        query: { queryId: "q-1", text: "probe", locale: "zh", phase: "main", expectedClaimIds: ["claim-a"] },
        expectedVersionIds: ["version-a"],
        qualifiedVersionIds: ["version-a", "version-distractor"],
        injected: [
          injectedItem("version-a"),
          injectedItem("version-distractor"),
          injectedItem("version-b", { section: "person_portrait", selectionSource: "person_portrait" }),
        ],
      }),
    ];
    const { ledger, metrics } = evaluateQueryRuns({
      corpus: smallCorpus,
      claimIdByVersionId: CLAIM_BY_VERSION,
      runs,
    });
    expect(ledger).toHaveLength(1);
    const row = ledger[0]!;
    expect(row.expectedVersionIds).toEqual(["version-a"]);
    expect(row.hitRetrieved).toBe(true);
    expect(row.hitInjected).toBe(true);
    expect(row.truePositives).toEqual(["version-a"]);
    expect(row.falsePositives).toEqual([
      { versionId: "version-distractor", classification: "distractor" },
    ]);
    // Portrait injections stay out of the precision accounting (recorded separately).
    expect(metrics.hitRateRetrieved).toBe(1);
    expect(metrics.hitRateInjected).toBe(1);
    expect(metrics.queryRetrievalPrecision).toBe(0.5);
    expect(metrics.portraitInjectionTotal).toBe(1);
    expect(zeroToleranceViolations(ledger)).toEqual([]);
  });

  it("flags fence leakage when a fenced probe's claim injects or a fence re-check fails", () => {
    const fencedQuery = {
      queryId: "q-fence", text: "probe", locale: "zh" as const, phase: "post_forget" as const,
      expectedClaimIds: [], fencedClaimIds: ["claim-b"],
    };
    const runs: QueryRunRecord[] = [
      runRecord({
        queryId: "q-fence",
        query: fencedQuery,
        expectedVersionIds: [],
        fencedVersionIds: ["version-b"],
        injected: [injectedItem("version-b")],
      }),
    ];
    const { ledger } = evaluateQueryRuns({
      corpus: smallCorpus,
      claimIdByVersionId: CLAIM_BY_VERSION,
      runs,
    });
    expect(ledger[0]!.fenceLeak).toBe(true);
    expect(zeroToleranceViolations(ledger)).toHaveLength(1);

    const fenceFailureRuns: QueryRunRecord[] = [
      runRecord({
        queryId: "q-fence",
        query: fencedQuery,
        expectedVersionIds: [],
        fencedVersionIds: ["version-b"],
        injected: [injectedItem("version-a")],
        injectedFenceFailures: [{ versionId: "version-a", failedFences: ["forget"] }],
      }),
    ];
    const failed = evaluateQueryRuns({
      corpus: smallCorpus,
      claimIdByVersionId: CLAIM_BY_VERSION,
      runs: fenceFailureRuns,
    });
    expect(failed.ledger[0]!.fenceLeak).toBe(true);
  });

  it("flags budget violations against ceilings v1 and deadline violations", () => {
    const overbudget: QueryRunRecord[] = [
      runRecord({
        queryId: "q-1",
        query: { queryId: "q-1", text: "probe", locale: "zh", phase: "main", expectedClaimIds: ["claim-a"] },
        injected: [
          injectedItem("v1", { section: "person_portrait", selectionSource: "person_portrait" }),
          injectedItem("v2", { section: "person_portrait", selectionSource: "person_portrait" }),
          injectedItem("v3", { section: "person_portrait", selectionSource: "person_portrait" }),
          injectedItem("v4", { section: "person_portrait", selectionSource: "person_portrait" }),
        ],
      }),
    ];
    const { ledger } = evaluateQueryRuns({
      corpus: smallCorpus,
      claimIdByVersionId: CLAIM_BY_VERSION,
      runs: overbudget,
    });
    expect(ledger[0]!.budgetViolation).toBe(true);

    const late: QueryRunRecord[] = [
      runRecord({ queryId: "q-1", durationMs: 240 }),
    ];
    const lateResult = evaluateQueryRuns({
      corpus: smallCorpus,
      claimIdByVersionId: CLAIM_BY_VERSION,
      runs: late,
    });
    expect(lateResult.ledger[0]!.deadlineViolation).toBe(true);
    expect(lateResult.metrics.deadlineViolationCount).toBe(1);

    const stage: QueryRunRecord[] = [
      runRecord({ queryId: "q-1", deadlineExceededStage: "lane_execution", status: "degraded", degradedReasonCodes: ["retrieval_deadline_exceeded"] }),
    ];
    const stageResult = evaluateQueryRuns({
      corpus: smallCorpus,
      claimIdByVersionId: CLAIM_BY_VERSION,
      runs: stage,
    });
    expect(stageResult.ledger[0]!.deadlineViolation).toBe(true);
    expect(stageResult.ledger[0]!.degraded).toBe(true);
  });

  it("records zero hit rates without inventing precision when nothing qualifies", () => {
    const { ledger, metrics } = evaluateQueryRuns({
      corpus: smallCorpus,
      claimIdByVersionId: CLAIM_BY_VERSION,
      runs: [runRecord({ queryId: "q-1" })],
    });
    expect(ledger[0]!.hitRetrieved).toBe(false);
    expect(ledger[0]!.hitInjected).toBe(false);
    expect(metrics.hitRateRetrieved).toBe(0);
    expect(metrics.queryRetrievalPrecision).toBe(0);
    expect(metrics.runsCompleted).toBe(1);
    expect(zeroToleranceViolations(ledger)).toEqual([]);
  });
});
