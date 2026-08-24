/**
 * Build the blinded pairwise comparison for one baseline-vs-candidate run
 * (issue #79; behavior contract §三).
 *
 * A pair turn is comparable only when both runs contain the same scenario,
 * the same turn number, and byte-identical user input text: the #61 frozen
 * baseline predates the v2.1 pack, so reworded activation/stop turns and
 * appended clean/reopen turns are excluded from judgment rather than
 * compared against different inputs. memory_continuity scenarios are excluded
 * entirely (recall judgment is deferred to 1A.3a).
 *
 * Writes <out>/pairs.json (blinded — no system identities) and
 * <out>/sealed-identities.json (kept sealed until scoring is complete).
 *
 * Usage:
 *   tsx eval/blind-pairwise/build-pairs.ts \
 *     --baseline eval/conversation-text-baseline/run/transcripts.json \
 *     --candidate eval/incumbent-baseline/run/transcripts.json \
 *     --scenarios eval/scenario-pack-v2/scenarios.json \
 *     --out eval/blind-pairwise/run-79
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BLIND_PAIRWISE_PROTOCOL_VERSION,
  identityAssignmentForScenario,
  isRecord,
  PAIRWISE_EXCLUDED_CATEGORIES,
  type PairScenario,
  type PairTurn,
  type PairsFile,
  type SealedIdentitiesFile,
  type SystemIdentity,
} from "./protocol";

type CapturedTurn = Readonly<{
  assistantText: string;
  input: Readonly<{ locale: string; text: string; timezone: string }>;
  sequenceInScenario: number;
}>;

type CapturedScenario = Readonly<{
  category: string;
  description: string;
  id: string;
  languageVariant: string;
  turns: readonly CapturedTurn[];
}>;

type TranscriptsFile = Readonly<{ scenarios: readonly CapturedScenario[] }>;

type PackScenario = Readonly<{
  category: string;
  description: string;
  id: string;
  languageVariant: string;
}>;

type PackFile = Readonly<{ scenarios: readonly PackScenario[] }>;

function parseArguments(): {
  baselineFile: string;
  candidateFile: string;
  outDir: string;
  scenariosFile: string;
  seed: number;
} {
  const arguments_ = process.argv.slice(2);
  const resolved = {
    baselineFile: "",
    candidateFile: "",
    outDir: "",
    scenariosFile: "",
    seed: 79,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === "--baseline") {
      resolved.baselineFile = required(arguments_, ++index, "--baseline");
    } else if (argument === "--candidate") {
      resolved.candidateFile = required(arguments_, ++index, "--candidate");
    } else if (argument === "--scenarios") {
      resolved.scenariosFile = required(arguments_, ++index, "--scenarios");
    } else if (argument === "--out") {
      resolved.outDir = required(arguments_, ++index, "--out");
    } else if (argument === "--seed") {
      resolved.seed = Number(required(arguments_, ++index, "--seed"));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value === "string" && value.length === 0) {
      throw new Error(`${name} is required.`);
    }
  }
  if (!Number.isInteger(resolved.seed)) {
    throw new Error("--seed must be an integer.");
  }
  return resolved;
}

function required(
  arguments_: readonly string[],
  index: number,
  name: string,
): string {
  const value = arguments_[index];
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

function asTranscripts(value: unknown, label: string): TranscriptsFile {
  if (!isRecord(value) || !Array.isArray(value.scenarios)) {
    throw new Error(`${label} must contain a scenarios array.`);
  }
  return value as TranscriptsFile;
}

async function main(): Promise<void> {
  const { baselineFile, candidateFile, outDir, scenariosFile, seed } =
    parseArguments();
  const baseline = asTranscripts(
    await readJson(baselineFile),
    baselineFile,
  );
  const candidate = asTranscripts(
    await readJson(candidateFile),
    candidateFile,
  );
  const pack = (await readJson(scenariosFile)) as PackFile;
  if (!isRecord(pack) || !Array.isArray(pack.scenarios)) {
    throw new Error("The scenario pack must contain a scenarios array.");
  }

  const baselineById = new Map(baseline.scenarios.map((s) => [s.id, s]));
  const candidateById = new Map(candidate.scenarios.map((s) => [s.id, s]));

  const pairScenarios: PairScenario[] = [];
  const mapping: Record<string, { A: SystemIdentity; B: SystemIdentity }> = {};
  const excludedScenarios: { id: string; reason: string }[] = [];
  const excludedTurns: { id: string; sequenceInScenario: number; reason: string }[] =
    [];

  for (const [ordinal, packScenario] of pack.scenarios.entries()) {
    const assignment = identityAssignmentForScenario(seed, ordinal);
    mapping[packScenario.id] = assignment;
    if (PAIRWISE_EXCLUDED_CATEGORIES.includes(packScenario.category)) {
      excludedScenarios.push({
        id: packScenario.id,
        reason: `category ${packScenario.category} excluded: judgment deferred (issue #79)`,
      });
      continue;
    }
    const baselineScenario = baselineById.get(packScenario.id);
    const candidateScenario = candidateById.get(packScenario.id);
    if (!baselineScenario || !candidateScenario) {
      excludedScenarios.push({
        id: packScenario.id,
        reason: !baselineScenario
          ? "no baseline counterpart (scenario added after the frozen #61 run)"
          : "no candidate run for this scenario",
      });
      continue;
    }
    const turns: PairTurn[] = [];
    const maxTurns = Math.max(
      baselineScenario.turns.length,
      candidateScenario.turns.length,
    );
    for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
      const baselineTurn = baselineScenario.turns[turnIndex];
      const candidateTurn = candidateScenario.turns[turnIndex];
      const sequenceInScenario = turnIndex + 1;
      if (!baselineTurn || !candidateTurn) {
        excludedTurns.push({
          id: packScenario.id,
          reason: !baselineTurn
            ? "appended after the frozen #61 pack (#77 posture/stop-signal fixtures)"
            : "missing in the candidate run",
          sequenceInScenario,
        });
        continue;
      }
      if (baselineTurn.input.text !== candidateTurn.input.text) {
        excludedTurns.push({
          id: packScenario.id,
          reason:
            "user input reworded in scenario-pack v2.1 (#77); inputs must be identical to compare",
          sequenceInScenario,
        });
        continue;
      }
      turns.push({
        sequenceInScenario,
        userInput: baselineTurn.input,
        responseA:
          assignment.A === "baseline"
            ? baselineTurn.assistantText
            : candidateTurn.assistantText,
        responseB:
          assignment.B === "baseline"
            ? baselineTurn.assistantText
            : candidateTurn.assistantText,
      });
    }
    if (turns.length === 0) {
      excludedScenarios.push({
        id: packScenario.id,
        reason: "no comparable turns",
      });
      continue;
    }
    pairScenarios.push({
      category: packScenario.category,
      description: packScenario.description,
      languageVariant: packScenario.languageVariant,
      scenarioId: packScenario.id,
      turns,
    });
  }

  const generatedAt = new Date().toISOString();
  const pairs: PairsFile = {
    protocol: BLIND_PAIRWISE_PROTOCOL_VERSION,
    seed,
    generatedAt,
    baselineSource: path.relative(process.cwd(), baselineFile),
    candidateSource: path.relative(process.cwd(), candidateFile),
    scenarios: pairScenarios,
    excludedScenarios,
    excludedTurns,
  };
  const sealed: SealedIdentitiesFile = {
    protocol: BLIND_PAIRWISE_PROTOCOL_VERSION,
    seed,
    generatedAt,
    mapping,
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "pairs.json"),
    `${JSON.stringify(pairs, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outDir, "sealed-identities.json"),
    `${JSON.stringify(sealed, null, 2)}\n`,
    "utf8",
  );
  const turnCount = pairScenarios.reduce(
    (total, scenario) => total + scenario.turns.length,
    0,
  );
  console.log(
    `[pairwise] ${pairScenarios.length} paired scenarios, ${turnCount} comparable turns; ` +
      `${excludedScenarios.length} scenarios and ${excludedTurns.length} turns excluded`,
  );
  console.log(
    `[pairwise] wrote pairs.json (blinded) and sealed-identities.json to ${path.relative(process.cwd(), outDir)}`,
  );
}

main().catch((error: unknown) => {
  console.error("[pairwise] build failed:", error);
  process.exitCode = 1;
});
