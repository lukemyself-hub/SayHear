/**
 * Run the #63 tiered checks over a captured transcripts file (the #61
 * baseline format: { capturedAt, scenarios: [{ id, languageVariant, turns }] }).
 *
 *   pnpm exec tsx eval/scenario-pack-v2/check-transcripts.ts \
 *     eval/conversation-text-baseline/run/transcripts.json \
 *     eval/scenario-pack-v2/run/baseline-61-findings.json
 *
 * Output is a TieredReport. Every hard-gate hit and advisory candidate is a
 * candidate finding, not a verdict: confirm against the transcript and record
 * FP/FN in ledger.json (rubric §6).
 */
import { readFile, writeFile } from "node:fs/promises";
import { assembleReport } from "./tiered-checks";

async function main(): Promise<void> {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error(
      "usage: tsx eval/scenario-pack-v2/check-transcripts.ts <transcripts.json> <out-findings.json>",
    );
    process.exitCode = 1;
    return;
  }

  const transcripts = JSON.parse(await readFile(inputPath, "utf8")) as {
    scenarios: {
      id: string;
      languageVariant: string;
      turns: {
        input: { locale: string; text: string };
        assistantText: string;
      }[];
    }[];
  };

  const report = assembleReport({
    source: inputPath,
    scenarios: transcripts.scenarios,
  });

  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`wrote ${outputPath}`);
  console.log(
    `turns=${report.summary.turnsChecked} hardGateViolations=${report.summary.hardGateViolations} advisoryCandidates=${report.summary.advisoryCandidates}`,
  );
  console.log("hardGatesByKind:", report.summary.hardGatesByKind);
  console.log("advisoriesByKind:", report.summary.advisoriesByKind);
  for (const locale of report.trajectory.perLocale) {
    console.log(
      `locale=${locale.languageVariant} questionRate=${locale.questionRate.toFixed(2)} medianChars=${locale.medianAssistantChars}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
