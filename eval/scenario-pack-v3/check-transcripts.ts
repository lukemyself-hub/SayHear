/**
 * Run the tiered-checks:v3 semantics over a captured transcripts file (the
 * #61 baseline format: { capturedAt, scenarios: [{ id, languageVariant,
 * turns }] }).
 *
 *   pnpm exec tsx eval/scenario-pack-v3/check-transcripts.ts \
 *     <transcripts.json> <out-findings.json> [eval/scenario-pack-v3/scenarios.json]
 *
 * The optional third argument joins the pack's fixtures by scenario id:
 * memory fixtures contribute the scoped forbidden-mention tokens, the
 * advisory expectedRecall tokens (documented only; no longer gated since #228),
 * the fenced-mention tokens, and
 * the stop-signal release turns that close the suppression windows.
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
      "usage: tsx eval/scenario-pack-v3/check-transcripts.ts <transcripts.json> <out-findings.json> [scenarios.json]",
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
                ...(fixtureEntry.memoryFixture.forbiddenMentionFromTurn !==
                undefined
                  ? {
                      forbiddenMentionFromTurn:
                        fixtureEntry.memoryFixture.forbiddenMentionFromTurn,
                    }
                  : {}),
                expectedRecalls: fixtureEntry.memoryFixture.expectedRecalls,
                ...(fixtureEntry.memoryFixture.fencedMentions !== undefined
                  ? { fencedMentions: fixtureEntry.memoryFixture.fencedMentions }
                  : {}),
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
