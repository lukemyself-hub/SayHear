/**
 * Mechanically verify the scenario-pack:v3 expectation fixtures against the
 * deterministic production policies (issue #118): posture K-turn
 * expectations, stop-signal session-persistent expectations with release, and
 * the v3 memory-fixture tiering — forbidden-mention with the
 * day-boundary scope, advisory expectedRecall tokens (satisfiability-checked
 * for the judge pre-screen; never gated since #228), semantic expectations =
 * advisory judge pre-screen, and
 * the post-Correction / post-Forget fenced-mention gates. Exits non-zero on
 * any mismatch, so evidence runs (#126) can gate on it before generating
 * transcripts.
 *
 *   pnpm exec tsx eval/scenario-pack-v3/verify-pack.ts \
 *     [eval/scenario-pack-v3/scenarios.json]
 */
import { readFile } from "node:fs/promises";

import {
  verifyScenarioPackExpectations,
  type ScenarioPack,
} from "./tiered-checks";

async function main(): Promise<void> {
  const [packPathArg] = process.argv.slice(2);
  const packPath = packPathArg ?? "eval/scenario-pack-v3/scenarios.json";

  const pack = JSON.parse(await readFile(packPath, "utf8")) as ScenarioPack;
  const verification = verifyScenarioPackExpectations(pack);

  console.log(
    `pack=${packPath} version=${verification.packVersion} scenarios=${verification.scenarioCount}`,
  );
  console.log(
    `fixtures: posture=${verification.fixtureCounts.posture} stopSignal=${verification.fixtureCounts.stopSignal} memory=${verification.fixtureCounts.memory}`,
  );

  if (verification.mismatches.length === 0) {
    console.log("fixture verification: OK — every expectation reproduces");
    return;
  }
  for (const mismatch of verification.mismatches) {
    console.error(
      `MISMATCH ${mismatch.scenarioId} ${mismatch.kind}: ${mismatch.detail}`,
    );
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
