import { describe, expect, it } from "vitest";

import { loadPredicateRegistrySnapshot } from "../predicate-registry/index";
import { createMemoryRetrievalService } from "./service";
import {
  MEMORY_RETRIEVAL_POLICY_VERSION,
  type CandidateFenceState,
  type MemoryRetrievalPolicy,
  type MemoryRetrievalInput,
  type MemoryRetrievalRepository,
  type RetrievalTestSupportConfiguration,
  type RetrievalLaneRow,
  type RetrievalQuerySubstrate,
  type RetrievalRegistryMaterial,
} from "./types";

const registrySnapshot = loadPredicateRegistrySnapshot(1);
const registryMaterial: RetrievalRegistryMaterial = {
  registryVersion: registrySnapshot.registryVersion,
  entryFor(predicateId) {
    return (
      registrySnapshot.entries.find(
        (entry) => entry.predicateId === predicateId,
      ) ?? null
    );
  },
  localizations: registrySnapshot.localizations,
};

const BASE_TIME = Date.parse("2026-08-27T10:00:00.000Z");
const COLLEAGUE_KEY = "v1|sh.relationship.colleague_of|entity-self+entity-wang|";

function laneRow(overrides: Partial<RetrievalLaneRow> = {}): RetrievalLaneRow {
  return {
    lane: "structured_exact",
    memory_claim_id: "claim-1",
    memory_claim_version_id: "version-1",
    claim_retrieval_projection_id: "projection-1",
    canonical_key: COLLEAGUE_KEY,
    subject_entity_id: "entity-self",
    object_entity_id: "entity-wang",
    predicate_id: "sh.relationship.colleague_of",
    kind: "objective",
    temporal_status: "current",
    valid_from: null,
    valid_to: null,
    last_observed_at: "2026-08-20T00:00:00.000Z",
    typed_value_text: null,
    matched_terms: null,
    fts_rank: null,
    ...overrides,
  };
}

function fenceState(overrides: Partial<CandidateFenceState> = {}): CandidateFenceState {
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

function substrate(overrides: Partial<RetrievalQuerySubstrate> = {}): RetrievalQuerySubstrate {
  return {
    priorUserEvents: [],
    selfEntityId: "entity-self",
    labelIndex: [
      { entityId: "entity-wang", label: "小王", labelKind: "primary", locale: "zh" },
    ],
    resolverHints: [],
    ...overrides,
  };
}

function createHarness(options: {
  policy?: MemoryRetrievalPolicy | null;
  structuredRows?: readonly RetrievalLaneRow[];
  lexicalRows?: readonly RetrievalLaneRow[];
  englishRows?: readonly RetrievalLaneRow[];
  fenceLoader?: (
    versionIds: readonly string[],
  ) => Promise<readonly CandidateFenceState[]>;
  substrateOverrides?: Partial<RetrievalQuerySubstrate>;
  testConfiguration?: RetrievalTestSupportConfiguration | null;
  monotonicNow?: () => number;
  repositoryFaults?: {
    loadSources?: Error;
    loadFenceStates?: Error;
    insertCandidates?: Error;
    completeRun?: Error;
  };
} = {}) {
  const calls = {
    structuredLanes: 0,
    lexicalLanes: 0,
    englishLanes: 0,
    completedRuns: [] as string[],
    insertedCandidates: [] as unknown[],
  };
  const repository: MemoryRetrievalRepository = {
    async loadPolicy() {
      if (options.policy === null) return null;
      if (options.policy) return options.policy;
      return {
        version: MEMORY_RETRIEVAL_POLICY_VERSION,
        deadlineMs: 200,
        candidateLimitPerLane: 25,
      };
    },
    async loadQueryConstructionSources() {
      if (options.repositoryFaults?.loadSources) throw options.repositoryFaults.loadSources;
      return substrate(options.substrateOverrides);
    },
    async runStructuredLane() {
      calls.structuredLanes += 1;
      return options.structuredRows ?? [];
    },
    async runLexicalLane() {
      calls.lexicalLanes += 1;
      return options.lexicalRows ?? [];
    },
    async runEnglishLane() {
      calls.englishLanes += 1;
      return options.englishRows ?? [];
    },
    async loadCandidateFenceStates(_userId, versionIds) {
      if (options.repositoryFaults?.loadFenceStates) {
        throw options.repositoryFaults.loadFenceStates;
      }
      if (options.fenceLoader) return options.fenceLoader(versionIds);
      return versionIds.map((versionId) => fenceState({ versionId }));
    },
    async insertRetrievalRun() {},
    async completeRetrievalRun(input) {
      if (options.repositoryFaults?.completeRun) throw options.repositoryFaults.completeRun;
      calls.completedRuns.push(`${input.retrievalRunId}:${input.status}`);
    },
    async insertRetrievalCandidates(input) {
      if (options.repositoryFaults?.insertCandidates) {
        throw options.repositoryFaults.insertCandidates;
      }
      calls.insertedCandidates.push(input.candidates);
    },
  };
  let monotonicBase = 0;
  const service = createMemoryRetrievalService({
    repository,
    registry: registryMaterial,
    clock: () => new Date(BASE_TIME),
    monotonicNow:
      options.monotonicNow ??
      (() => {
        monotonicBase += 1;
        return monotonicBase;
      }),
    testSupport: {
      configuration: () => options.testConfiguration ?? null,
    },
  });
  return { service, calls };
}

function retrievalInput(overrides: Partial<MemoryRetrievalInput> = {}): MemoryRetrievalInput {
  return {
    userId: "user-1" as never,
    dailySession: { id: "session-1" as never, continuousExchangeNo: 1 },
    sourceEventRevisionId: "rev-1",
    currentInputText: "我同事小王还好吗",
    currentTopic: null,
    dialogueRevision: 3,
    currentInputSequence: 5,
    ...overrides,
  };
}

describe("createMemoryRetrievalService", () => {
  it("runs the enabled lanes, records the manifest, and returns the qualified candidate", async () => {
    const { service, calls } = createHarness({
      structuredRows: [laneRow()],
    });
    const outcome = await service.run(retrievalInput());
    expect(outcome.status).toBe("completed");
    expect(outcome.degradedReasonCodes).toEqual([]);
    expect(outcome.manifest.deadline_ms).toBe(200);
    expect(outcome.manifest.retrieval_policy_version).toBe(MEMORY_RETRIEVAL_POLICY_VERSION);
    expect(outcome.manifest.query_source_refs).toContainEqual({
      kind: "current_user_event",
      revisionId: "rev-1",
    });
    expect(outcome.manifest.normalized_query_terms.resolved_entities).toEqual([
      "entity-wang",
    ]);
    expect(outcome.manifest.qualified_count).toBe(1);
    expect(calls.completedRuns).toEqual([`${outcome.retrievalRunId}:completed`]);
    const candidates = calls.insertedCandidates[0] as readonly {
      selectionReasonCodes: readonly string[];
    }[];
    expect(candidates[0]!.selectionReasonCodes).toContain(
      "relevance_cutoff_canonical_key_exact",
    );
  });

  it("records query-construction zero signal as a completed empty run, not a failure", async () => {
    const { service } = createHarness({
      substrateOverrides: substrate({ labelIndex: [], selfEntityId: null }),
    });
    const outcome = await service.run(
      retrievalInput({ currentInputText: "。。。" }),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.manifest.zero_signal).toBe(true);
    expect(outcome.manifest.candidate_count).toBe(0);
    expect(outcome.manifest.lane_plan.every((lane) => !lane.enabled)).toBe(true);
  });

  it("treats an enabled lane returning zero candidates as a valid empty", async () => {
    const { service } = createHarness();
    const outcome = await service.run(retrievalInput());
    expect(outcome.status).toBe("completed");
    expect(outcome.manifest.candidate_count).toBe(0);
    expect(outcome.manifest.lane_hit_counts).toEqual({
      structured_exact: 0,
      lexical_term_overlap: 0,
      english_fts: 0,
    });
  });

  it("fails the whole run closed when an enabled lane errors", async () => {
    const { service } = createHarness({
      testConfiguration: {
        structuredExact: { failWith: new Error("lane exploded") },
      },
    });
    const outcome = await service.run(retrievalInput());
    expect(outcome.status).toBe("degraded");
    expect(outcome.degradedReasonCodes).toContain("retrieval_lane_failed");
    expect(outcome.manifest.qualified_count).toBe(0);
    expect(outcome.manifest.degraded_reason_codes).toContain("retrieval_lane_failed");
  });

  it("ignores a failure injected into a lane the query plan did not enable", async () => {
    const { service } = createHarness({
      // English lane is not enabled for a Chinese-only query without ascii
      // words; a fault targeting it must not count toward lane health.
      testConfiguration: {
        englishFts: { failWith: new Error("lane exploded") },
      },
    });
    const outcome = await service.run(retrievalInput());
    expect(outcome.status).toBe("completed");
    expect(
      outcome.manifest.lane_plan.find((lane) => lane.lane === "english_fts")!
        .enabled,
    ).toBe(false);
  });

  it("records the deadline with actual duration and phase when exceeded", async () => {
    let elapsed = 0;
    const { service } = createHarness({
      policy: {
        version: MEMORY_RETRIEVAL_POLICY_VERSION,
        deadlineMs: 30,
        candidateLimitPerLane: 25,
      },
      // monotonicNow advances 10ms per call, so the 30ms shared budget trips
      // during lane execution without relying on real sleeps.
      monotonicNow: () => {
        elapsed += 10;
        return elapsed;
      },
    });
    const outcome = await service.run(retrievalInput());
    expect(outcome.status).toBe("degraded");
    expect(outcome.degradedReasonCodes).toContain("retrieval_deadline_exceeded");
    expect(outcome.manifest.deadline_exceeded_stage).toBe("lane_execution");
    expect(outcome.manifest.duration_ms).toBeGreaterThanOrEqual(30);
  });

  it("treats elapsed == deadline as boundary success (expiry is strictly greater)", async () => {
    // Every stage check reads exactly the deadline: 200 > 200 is false, so
    // the run completes — the documented boundary semantics of AC 18.
    const { service } = createHarness({
      policy: {
        version: MEMORY_RETRIEVAL_POLICY_VERSION,
        deadlineMs: 200,
        candidateLimitPerLane: 25,
      },
      monotonicNow: (() => {
        let base = 0;
        return () => {
          if (base === 0) {
            base = 1;
            return 0;
          }
          return 200;
        };
      })(),
      structuredRows: [laneRow()],
    });
    const outcome = await service.run(retrievalInput());
    expect(outcome.status).toBe("completed");
    expect(outcome.manifest.duration_ms).toBe(200);
    expect(outcome.manifest.qualified_count).toBe(1);
  });

  it("demonstrates boundary success inside the deadline", async () => {
    const { service } = createHarness({
      policy: {
        version: MEMORY_RETRIEVAL_POLICY_VERSION,
        deadlineMs: 5_000,
        candidateLimitPerLane: 25,
      },
      monotonicNow: () => 3,
      structuredRows: [laneRow()],
    });
    const outcome = await service.run(retrievalInput());
    expect(outcome.status).toBe("completed");
    expect(outcome.manifest.duration_ms).toBeLessThanOrEqual(5_000);
    expect(outcome.manifest.qualified_count).toBe(1);
  });

  it("fails closed on query construction errors", async () => {
    const { service } = createHarness({
      repositoryFaults: { loadSources: new Error("db down") },
    });
    const outcome = await service.run(retrievalInput());
    expect(outcome.status).toBe("degraded");
    expect(outcome.degradedReasonCodes).toContain(
      "retrieval_query_construction_failed",
    );
  });

  it("eliminates fenced-out candidates and distinguishes them from empty", async () => {
    const { service, calls } = createHarness({
      structuredRows: [laneRow({ memory_claim_version_id: "version-fenced" })],
      fenceLoader: (versionIds) =>
        Promise.resolve(
          versionIds.map((versionId) =>
            fenceState({ versionId, versionStatus: "dormant" }),
          ),
        ),
    });
    const outcome = await service.run(retrievalInput());
    expect(outcome.status).toBe("completed");
    expect(outcome.manifest.candidate_count).toBe(1);
    expect(outcome.manifest.fenced_out_count).toBe(1);
    expect(outcome.manifest.qualified_count).toBe(0);
    const candidates = calls.insertedCandidates[0] as readonly {
      rejectionReasonCodes: readonly string[];
      finalRank: number | null;
    }[];
    expect(candidates[0]!.rejectionReasonCodes).toContain("trust_fence_failed_dormant");
    expect(candidates[0]!.finalRank).toBeNull();
  });

  it("degrades when recording the run itself fails", async () => {
    const { service } = createHarness({
      repositoryFaults: { completeRun: new Error("ledger unavailable") },
    });
    const outcome = await service.run(retrievalInput());
    expect(outcome.status).toBe("degraded");
    expect(outcome.degradedReasonCodes).toContain("retrieval_run_recording_failed");
  });

  it("returns a degraded outcome when the policy version is unavailable", async () => {
    const { service } = createHarness({ policy: null });
    const outcome = await service.run(retrievalInput());
    expect(outcome.status).toBe("degraded");
    expect(outcome.degradedReasonCodes).toContain("retrieval_policy_unavailable");
    expect(outcome.retrievalRunId).toBeNull();
  });
});
