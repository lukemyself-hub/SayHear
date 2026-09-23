import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { sha256 } from "./protocol";
import type { V4ExpressionSelectionManifest, V4Pins } from "./protocol-v4";

const pinsPath = "eval/continuation-acceptance-1a3b/pins-v4.json";
const outputPath =
  "eval/continuation-acceptance-1a3b/run-v4/operator/expression-selection.json";

async function main(): Promise<void> {
  const pins = JSON.parse(await readFile(pinsPath, "utf8")) as V4Pins;
  const winnerConfigId = pins.expression.selectedConfigId;
  const winner = pins.expression.configurations.find(
    (entry) => entry.id === winnerConfigId,
  );
  if (!winner || winnerConfigId === null || pins.expression.configurations.length !== 1) {
    throw new Error("v4 waiver requires exactly one pinned expression configuration.");
  }
  const decision = {
    kind: "single_candidate_iteration",
    decidedAt: "2026-09-23",
    reason:
      "The G2 v4 candidate is evaluated against OFF under the approved dual-track protocol; expression-style comparison remains deferred under ADR-0136's bounded exception.",
  };
  const waiver = {
    approvedBy: "luke",
    approvedAt: "2026-09-23",
    reason: "Luke-approved v4 acceptance iteration recorded in ADR-0136.",
    adrAmendment: "0136:2026-09-23",
  };
  const selection: V4ExpressionSelectionManifest = {
    version: "1a3b-g2-expression-decision:v4",
    expressionRunSha256: null,
    winnerConfigId,
    winnerRolePinSha256: sha256(winner.pin),
    decisionSha256: sha256(decision),
    authorizationSha256: sha256({ decision, waiver }),
    decision,
    waiver,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(selection, null, 2)}\n`, "utf8");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
