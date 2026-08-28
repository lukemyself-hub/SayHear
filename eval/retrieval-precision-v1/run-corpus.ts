import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runMigrations } from "@sayhear/data";
import { createIsolatedPostgresSchema } from "@sayhear/test-support";
import { Pool } from "pg";

import { runRetrievalPrecisionCorpus } from "./harness";

/**
 * Retrieval-precision accounting run CLI (issue #125, SPEC #107 AC 38).
 *
 * Creates a throwaway isolated schema (never touches real data), migrates,
 * plants the fixed-seed synthetic corpus through production write paths, runs
 * every probe query through the production retrieval functions, and writes
 * the accounting baseline (metrics.json) plus the per-query ledger
 * (ledger.json) under run/<stamp>/.
 *
 * Usage:
 *   pnpm tsx eval/retrieval-precision-v1/run-corpus.ts [--out DIR]
 * Env:
 *   TEST_DATABASE_URL (falls back to DATABASE_URL)
 *
 * Exit code: 0 when the absolute zeros hold (fence leakage, budget
 * violations, deadline violations), 1 otherwise. Hit rate and precision are
 * accounting baselines — they never gate.
 */

async function main() {
  const connectionString =
    process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null;
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL (or DATABASE_URL) is required.");
  }
  const outArg = process.argv.indexOf("--out");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = outArg >= 0
    ? process.argv[outArg + 1]!
    : path.join(import.meta.dirname, "run", stamp);
  await mkdir(outDir, { recursive: true });

  const database = await createIsolatedPostgresSchema(connectionString);
  try {
    await runMigrations(database.pool);
    const startedAt = Date.now();
    const result = await runRetrievalPrecisionCorpus({
      pool: database.pool,
      log: (line) => console.log(`[corpus] ${line}`),
    });
    const elapsedMs = Date.now() - startedAt;

    await writeFile(
      path.join(outDir, "metrics.json"),
      `${JSON.stringify({ ...result.metrics, wallClockMs: elapsedMs }, null, 2)}\n`,
    );
    await writeFile(
      path.join(outDir, "ledger.json"),
      `${JSON.stringify(result.ledger, null, 2)}\n`,
    );
    await writeFile(
      path.join(outDir, "planted.json"),
      `${JSON.stringify(result.planted, null, 2)}\n`,
    );

    console.log("retrieval-precision accounting baseline (no thresholds):");
    console.log(`  queries                 : ${result.metrics.queriesTotal}`);
    console.log(`  hit rate (retrieved)    : ${result.metrics.hitRateRetrieved}`);
    console.log(`  hit rate (injected)     : ${result.metrics.hitRateInjected}`);
    console.log(
      `  query-retrieval precision: ${result.metrics.queryRetrievalPrecision}` +
        ` (${result.metrics.truePositiveTotal} TP / ${result.metrics.queryRetrievedInjectionTotal} injected)`,
    );
    console.log(`  portrait injections     : ${result.metrics.portraitInjectionTotal}`);
    console.log(`  duration p50 / p95 (ms) : ${result.metrics.durationP50Ms} / ${result.metrics.durationP95Ms} (deadline ${result.metrics.deadlineMs}ms)`);
    console.log("absolute zeros (must hold):");
    console.log(`  fence leakage           : ${result.metrics.fenceLeakCount}`);
    console.log(`  budget violations       : ${result.metrics.budgetViolationCount}`);
    console.log(`  deadline violations     : ${result.metrics.deadlineViolationCount}`);
    console.log(`  degraded rounds         : ${result.metrics.runsDegraded}`);
    console.log(`artifacts written to ${outDir}`);

    if (result.violations.length > 0) {
      console.error("zero-tolerance violations:");
      for (const violation of result.violations) console.error(`  - ${violation}`);
      process.exitCode = 1;
    }
  } finally {
    await database.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
