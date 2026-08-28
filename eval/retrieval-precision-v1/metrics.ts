import type {
  MemorySectionKey,
} from "@sayhear/application";
import { MEMORY_BUDGETS_V1 } from "@sayhear/application";

import {
  RETRIEVAL_PRECISION_CORPUS_VERSION,
  type PrecisionCorpus,
  type QuerySpec,
} from "./corpus";

/**
 * Accounting metrics + per-query ledger for the retrieval-precision corpus
 * runner (issue #125, SPEC #107 AC 38). Pure functions: no database, no
 * clock. Hit rate and injection precision are recorded as accounting
 * baselines with NO thresholds (budgets v2 from production manifests is a
 * later, separate decision) — the only hard checks are the SPEC's absolute
 * zeros: fence leakage, budget violations, and deadline violations.
 */

export type InjectedItem = Readonly<{
  versionId: string;
  section: MemorySectionKey;
  selectionSource: "person_portrait" | "query_retrieval";
  kind: "objective" | "impression";
}>;

export type QueryRunRecord = Readonly<{
  query: QuerySpec;
  compiledLocale: "zh" | "en";
  /**
   * Ground-truth version ids captured AT QUERY TIME by the harness (a
   * superseding statement later in the corpus changes the claim's current
   * version, so a post-hoc recomputation would mis-score earlier probes).
   */
  expectedVersionIds: readonly string[];
  /** Version ids of the fenced claims at query time (fence probes). */
  fencedVersionIds: readonly string[];
  status: "completed" | "degraded";
  degradedReasonCodes: readonly string[];
  durationMs: number;
  deadlineMs: number;
  deadlineExceededStage: string | null;
  /** Cutoff-passed candidate versions (final_rank not null) for this run. */
  qualifiedVersionIds: readonly string[];
  /** Compiled memory items per section, exactly as the model would receive. */
  injected: readonly InjectedItem[];
  /**
   * Production fence re-verification of every injected version (harness runs
   * the repository fence loader + trust-fence evaluator after the run):
   * empty when every injected item passes all fences.
   */
  injectedFenceFailures: readonly Readonly<{
    versionId: string;
    failedFences: readonly string[];
  }>[];
  laneHitCounts: Readonly<Record<string, number>>;
}>;

export type FalsePositiveClassification = "planted_other" | "distractor" | "unplanted";

export type QueryLedgerRow = Readonly<{
  queryId: string;
  day: number;
  session: number;
  locale: string;
  phase: QuerySpec["phase"];
  text: string;
  expectedClaimIds: readonly string[];
  expectedVersionIds: readonly string[];
  qualifiedVersionIds: readonly string[];
  injectedBySection: Readonly<Record<MemorySectionKey, readonly string[]>>;
  hitRetrieved: boolean;
  hitInjected: boolean;
  /** Query-retrieved injections that are expected (precision numerator part). */
  truePositives: readonly string[];
  /** Query-retrieved injections that are not expected, classified. */
  falsePositives: readonly Readonly<{
    versionId: string;
    classification: FalsePositiveClassification;
  }>[];
  fenceLeak: boolean;
  budgetViolation: boolean;
  deadlineViolation: boolean;
  degraded: boolean;
  durationMs: number;
  deadlineMs: number;
  laneHitCounts: Readonly<Record<string, number>>;
}>;

export type CorpusMetrics = Readonly<{
  runnerVersion: string;
  corpusVersion: string;
  seed: number;
  queriesTotal: number;
  runsCompleted: number;
  runsDegraded: number;
  /** Share of queries whose expected claim reached the qualified set. */
  hitRateRetrieved: number;
  /** Share of queries whose expected claim was actually injected. */
  hitRateInjected: number;
  /** |injected ∩ expected| / |injected| over query-retrieved injections. */
  queryRetrievalPrecision: number;
  queryRetrievedInjectionTotal: number;
  truePositiveTotal: number;
  falsePositiveTotal: number;
  portraitInjectionTotal: number;
  fenceLeakCount: number;
  budgetViolationCount: number;
  deadlineViolationCount: number;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  deadlineMs: number;
}>;

const MEMORY_CLASS_TOTAL_CEILING = MEMORY_BUDGETS_V1.memoryClassTotalMaxItems;

function budgetViolationsOf(
  injectedBySection: Readonly<Record<MemorySectionKey, readonly string[]>>,
  impressionsBySection: Readonly<Record<MemorySectionKey, number>>,
): boolean {
  if (injectedBySection.person_portrait.length > MEMORY_BUDGETS_V1.personPortraitMaxItems) return true;
  if (impressionsBySection.person_portrait > MEMORY_BUDGETS_V1.personPortraitMaxImpressions) return true;
  const queryRetrieved =
    injectedBySection.objective_memory.length + injectedBySection.ai_impression.length;
  if (queryRetrieved > MEMORY_BUDGETS_V1.queryRetrievedMaxItems) return true;
  if (
    impressionsBySection.objective_memory + impressionsBySection.ai_impression >
    MEMORY_BUDGETS_V1.queryRetrievedMaxImpressions
  ) {
    return true;
  }
  const total = Object.values(injectedBySection).reduce((sum, ids) => sum + ids.length, 0);
  return total > MEMORY_CLASS_TOTAL_CEILING;
}

export function evaluateQueryRuns(input: {
  corpus: PrecisionCorpus;
  /** Every planted claim version id → its corpus claim id. */
  claimIdByVersionId: ReadonlyMap<string, string>;
  runs: readonly QueryRunRecord[];
}): { ledger: readonly QueryLedgerRow[]; metrics: CorpusMetrics } {
  const { corpus, claimIdByVersionId } = input;
  const claimById = new Map(corpus.claims.map((claim) => [claim.claimId, claim]));
  const turnByQueryId = new Map(
    corpus.turns.filter((turn) => turn.query).map((turn) => [turn.query!.queryId, turn]),
  );

  const ledger: QueryLedgerRow[] = input.runs.map((run) => {
    const turn = turnByQueryId.get(run.query.queryId);
    if (!turn) throw new Error(`run for unknown query ${run.query.queryId}`);
    const expectedVersionIds = run.expectedVersionIds;
    const fencedVersionIds = run.fencedVersionIds;

    const injectedBySection: Record<MemorySectionKey, string[]> = {
      person_portrait: [],
      objective_memory: [],
      ai_impression: [],
    };
    for (const item of run.injected) {
      injectedBySection[item.section] = [...injectedBySection[item.section], item.versionId];
    }
    const queryRetrieved = run.injected.filter(
      (item) => item.selectionSource === "query_retrieval",
    );
    const queryRetrievedVersionIds = new Set(queryRetrieved.map((item) => item.versionId));
    const allInjectedVersionIds = new Set(run.injected.map((item) => item.versionId));

    const truePositives = queryRetrieved
      .map((item) => item.versionId)
      .filter((versionId) => expectedVersionIds.includes(versionId));
    const falsePositives = queryRetrieved
      .map((item) => item.versionId)
      .filter((versionId) => !expectedVersionIds.includes(versionId))
      .map((versionId) => {
        const claimId = claimIdByVersionId.get(versionId);
        if (claimId === undefined) {
          return { versionId, classification: "unplanted" as const };
        }
        const claim = claimById.get(claimId);
        return {
          versionId,
          classification: claim?.category === "distractor"
            ? ("distractor" as const)
            : ("planted_other" as const),
        };
      });

    const expectedSet = new Set(expectedVersionIds);
    const hitRetrieved = run.qualifiedVersionIds.some((versionId) => expectedSet.has(versionId));
    const hitInjected = expectedVersionIds.some((versionId) => allInjectedVersionIds.has(versionId));

    const fenceLeak =
      run.injectedFenceFailures.length > 0 ||
      // A fenced probe's claim versions must never inject anywhere.
      fencedVersionIds.some((versionId) => allInjectedVersionIds.has(versionId));
    const impressionsBySection: Record<MemorySectionKey, number> = {
      person_portrait: countImpressions(run, "person_portrait"),
      objective_memory: countImpressions(run, "objective_memory"),
      ai_impression: countImpressions(run, "ai_impression"),
    };
    const budgetViolation = budgetViolationsOf(injectedBySection, impressionsBySection);
    const deadlineViolation =
      run.deadlineExceededStage !== null ||
      run.durationMs > run.deadlineMs ||
      run.degradedReasonCodes.includes("retrieval_deadline_exceeded");

    return {
      queryId: run.query.queryId,
      day: turn.day,
      session: turn.session,
      locale: turn.locale,
      phase: run.query.phase,
      text: turn.text,
      expectedClaimIds: [...run.query.expectedClaimIds],
      expectedVersionIds,
      qualifiedVersionIds: [...run.qualifiedVersionIds],
      injectedBySection,
      hitRetrieved,
      hitInjected,
      truePositives,
      falsePositives,
      fenceLeak,
      budgetViolation,
      deadlineViolation,
      degraded: run.status === "degraded",
      durationMs: run.durationMs,
      deadlineMs: run.deadlineMs,
      laneHitCounts: { ...run.laneHitCounts },
    };
  });

  const totalQueryRetrieved = ledger.reduce(
    (sum, row) =>
      sum + row.injectedBySection.objective_memory.length + row.injectedBySection.ai_impression.length,
    0,
  );
  const truePositiveTotal = ledger.reduce((sum, row) => sum + row.truePositives.length, 0);
  const durations = ledger.map((row) => row.durationMs).sort((a, b) => a - b);
  const percentile = (share: number): number | null => {
    if (durations.length === 0) return null;
    const index = Math.min(durations.length - 1, Math.ceil(share * durations.length) - 1);
    return durations[Math.max(0, index)]!;
  };
  const deadlineMs = ledger[0]?.deadlineMs ?? 0;

  const metrics: CorpusMetrics = {
    runnerVersion: RETRIEVAL_PRECISION_CORPUS_VERSION,
    corpusVersion: corpus.version,
    seed: corpus.seed,
    queriesTotal: ledger.length,
    runsCompleted: ledger.filter((row) => !row.degraded).length,
    runsDegraded: ledger.filter((row) => row.degraded).length,
    hitRateRetrieved: share(ledger, (row) => row.hitRetrieved),
    hitRateInjected: share(ledger, (row) => row.hitInjected),
    queryRetrievalPrecision:
      totalQueryRetrieved === 0 ? 0 : round4(truePositiveTotal / totalQueryRetrieved),
    queryRetrievedInjectionTotal: totalQueryRetrieved,
    truePositiveTotal,
    falsePositiveTotal: ledger.reduce((sum, row) => sum + row.falsePositives.length, 0),
    portraitInjectionTotal: ledger.reduce(
      (sum, row) => sum + row.injectedBySection.person_portrait.length,
      0,
    ),
    fenceLeakCount: ledger.filter((row) => row.fenceLeak).length,
    budgetViolationCount: ledger.filter((row) => row.budgetViolation).length,
    deadlineViolationCount: ledger.filter((row) => row.deadlineViolation).length,
    durationP50Ms: percentile(0.5),
    durationP95Ms: percentile(0.95),
    deadlineMs,
  };

  return { ledger, metrics };
}

/** The SPEC's absolute zeros, as human-readable strings (empty = clean). */
export function zeroToleranceViolations(ledger: readonly QueryLedgerRow[]): readonly string[] {
  const problems: string[] = [];
  for (const row of ledger) {
    if (row.fenceLeak) {
      problems.push(`${row.queryId}: fence leakage — injected ${JSON.stringify(row.injectedBySection)}`);
    }
    if (row.budgetViolation) {
      problems.push(`${row.queryId}: budgets v1 violated — ${JSON.stringify(row.injectedBySection)}`);
    }
    if (row.deadlineViolation) {
      problems.push(`${row.queryId}: deadline violated — ${row.durationMs}ms > ${row.deadlineMs}ms`);
    }
  }
  return problems;
}

function countImpressions(run: QueryRunRecord, section: MemorySectionKey): number {
  return run.injected.filter((item) => item.section === section && item.kind === "impression")
    .length;
}

function share(rows: readonly QueryLedgerRow[], predicate: (row: QueryLedgerRow) => boolean): number {
  if (rows.length === 0) return 0;
  return round4(rows.filter(predicate).length / rows.length);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
