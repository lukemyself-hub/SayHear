/**
 * Run the #63/#77 tiered checks over a captured transcripts file (the #61
 * baseline format: { capturedAt, scenarios: [{ id, languageVariant, turns }] }).
 *
 *   pnpm exec tsx eval/scenario-pack-v2/check-transcripts.ts \
 *     eval/conversation-text-baseline/run/transcripts.json \
 *     eval/scenario-pack-v2/run/baseline-61-findings.json \
 *     [eval/scenario-pack-v2/scenarios.json]
 *
 * The optional third argument joins the pack's #77 fixtures by scenario id:
 * memory fixtures contribute the forbidden-mention tokens, stop-signal
 * fixtures the release turns that close the suppression windows. Transcripts
 * whose id has no pack entry (or no pack given) run with checker-v1 semantics
 * for those parts — the frozen #61 run, for example, predates the fixtures.
 *
 * Output is a TieredReport. Every hard-gate hit and advisory candidate is a
 * candidate finding, not a verdict: confirm against the transcript and record
 * FP/FN in ledger.json (rubric §6).
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  assembleReport,
  type ScenarioPack,
  type ScenarioTurn,
} from "./tiered-checks";

async function main(): Promise<void> {
  const [inputPath, outputPath, packPathArg] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error(
      "usage: tsx eval/scenario-pack-v2/check-transcripts.ts <transcripts.json> <out-findings.json> [scenarios.json]",
    );
    process.exitCode = 1;
    return;
  }

  const transcripts = JSON.parse(await readFile(inputPath, "utf8")) as {
    scenarios: {
      id: string;
      languageVariant: string;
      turns: ScenarioTurn[];
    }[];
  };
  const pack = packPathArg
    ? (JSON.parse(await readFile(packPathArg, "utf8")) as ScenarioPack)
    : null;
  const packById = new Map(
    (pack?.scenarios ?? []).map((entry) => [entry.id, entry]),
  );

  const report = assembleReport({
    source: inputPath,
    scenarios: transcripts.scenarios.map((scenario) => {
      const fixtureEntry = packById.get(scenario.id);
      return {
        id: scenario.id,
        languageVariant: scenario.languageVariant,
        turns: scenario.turns,
        ...(fixtureEntry?.memoryFixture
          ? {
              memoryFixture: {
                forbiddenMentionTokens:
                  fixtureEntry.memoryFixture.forbiddenMentionTokens,
              },
            }
          : {}),
        ...(fixtureEntry?.stopSignalExpectation
          ? {
              stopSignalExpectation: {
                releasedAtTurn:
                  fixtureEntry.stopSignalExpectation.releasedAtTurn,
              },
            }
          : {}),
      };
    }),
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
