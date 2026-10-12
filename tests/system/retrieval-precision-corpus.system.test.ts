import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "@sayhear/data";
import { createIsolatedPostgresSchema, type IsolatedPostgresSchema } from "@sayhear/test-support";

import { buildCorpus } from "../../eval/retrieval-precision-v1/corpus";
import { runRetrievalPrecisionCorpus } from "../../eval/retrieval-precision-v1/harness";

/**
 * Issue #125 — SPEC #107 AC 38: the retrieval-precision run over the
 * synthetic multi-day corpus records hit rate and injection precision as
 * accounting baselines with per-query ledger output, through the production
 * retrieval functions. Fence leakage, budget violations, and deadline
 * violations are absolutely zero. The system test drives a stepwise monotonic
 * clock for deterministic accounting rather than real latency evidence; the
 * standalone accounting CLI retains the real clock. Hit rate / precision
 * levels carry no thresholds here (budgets v2 from production manifests is a
 * later slice).
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

describe("retrieval-precision corpus runner (AC 38)", () => {
  let database: IsolatedPostgresSchema;

  beforeAll(async () => {
    database = await createIsolatedPostgresSchema(testDatabaseUrl);
    await runMigrations(database.pool);
  }, 30_000);

  afterAll(async () => {
    await database?.dispose();
  }, 10_000);

  it("runs the fixed-seed corpus through the production retrieval functions with the absolute zeros intact", async () => {
    let retrievalNowMs = 0;
    const result = await runRetrievalPrecisionCorpus({
      pool: database.pool,
      log: (line) => console.log(`[corpus] ${line}`),
      retrievalMonotonicNow: () => retrievalNowMs++,
    });

    const expectedQueries =
      buildCorpus().turns.filter((turn) => turn.query).length + 1; // + post-dormancy probe
    expect(result.metrics.queriesTotal).toBe(expectedQueries);
    expect(result.ledger).toHaveLength(expectedQueries);
    for (const row of result.ledger) {
      expect(row.queryId).toBeTruthy();
      expect(row.deadlineMs).toBe(200);
    }

    // AC 38: the accounting baselines exist and are meaningful (not gates).
    expect(result.metrics.hitRateRetrieved).toBeGreaterThan(0);
    expect(result.metrics.hitRateInjected).toBeGreaterThan(0);
    expect(result.metrics.queryRetrievedInjectionTotal).toBeGreaterThan(0);
    expect(result.metrics.portraitInjectionTotal).toBeGreaterThan(0);

    // The absolute zeros.
    expect(result.violations).toEqual([]);
    expect(result.metrics.fenceLeakCount).toBe(0);
    expect(result.metrics.budgetViolationCount).toBe(0);
    expect(result.metrics.deadlineViolationCount).toBe(0);
    expect(result.metrics.runsDegraded).toBe(0);
    expect(result.metrics.durationP95Ms).toBeGreaterThan(0);
    expect(result.metrics.durationP95Ms).toBeLessThanOrEqual(200);

    // The corpus was planted through production admission, and every probe
    // ran through the production retrieval seam under the pinned policy.
    expect(result.planted.length).toBeGreaterThanOrEqual(30);

    // Ledger spot check: a cross-day relationship probe injects its expected
    // planted claim (either as query retrieval or portrait selection).
    const ledgerById = new Map(result.ledger.map((row) => [row.queryId, row]));
    const wang = ledgerById.get("q-wang-zh")!;
    expect(wang).toBeDefined();
    const wangPlanted = result.planted.find(
      (claim) => claim.corpusClaimId === "rel-colleague-wang",
    );
    expect(wangPlanted).toBeDefined();
    const injectedVersions = new Set([
      ...wang.injectedBySection.objective_memory,
      ...wang.injectedBySection.ai_impression,
      ...wang.injectedBySection.person_portrait,
    ]);
    expect(wang.hitInjected).toBe(true);
    expect(injectedVersions.has(wangPlanted!.currentVersionId)).toBe(true);

    // A forgotten claim never injects on its post-forget probe.
    const postForget = ledgerById.get("q-proj-postforget")!;
    expect(postForget.fenceLeak).toBe(false);
    const projInjected = [
      ...postForget.injectedBySection.objective_memory,
      ...postForget.injectedBySection.ai_impression,
      ...postForget.injectedBySection.person_portrait,
    ];
    expect(projInjected).not.toContain(
      result.planted.find((claim) => claim.corpusClaimId === "proj-nebula")!.currentVersionId,
    );
  }, 600_000);
});
