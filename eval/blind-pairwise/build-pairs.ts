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
 *     --out eval/blind-pairwise/run-next --sample --sample-seed 79
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BLIND_PAIRWISE_PROTOCOL_V1,
  BLIND_PAIRWISE_PROTOCOL_V2,
  identityAssignmentForScenario,
  isRecord,
  PAIRWISE_SAMPLE_PROTECTED_CATEGORIES,
  PAIRWISE_EXCLUDED_CATEGORIES,
  SAMPLE_LANGUAGE_VARIANTS,
  STRATIFIED_SAMPLE_QUOTAS,
  mulberry32,
  type PairScenario,
  type PairTurn,
  type PairsFile,
  type PairwiseSampling,
  type SealedIdentitiesFile,
  type SampleLanguageVariant,
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
  sample: boolean;
  sampleSeed: number;
  scenariosFile: string;
  seed: number;
} {
  const arguments_ = process.argv.slice(2);
  const resolved = {
    baselineFile: "",
    candidateFile: "",
    outDir: "",
    sample: false,
    sampleSeed: 0,
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
    } else if (argument === "--sample") {
      resolved.sample = true;
    } else if (argument === "--sample-seed") {
      resolved.sampleSeed = Number(required(arguments_, ++index, "--sample-seed"));
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
  if (!Number.isInteger(resolved.seed) || !Number.isInteger(resolved.sampleSeed)) {
    throw new Error("--seed and --sample-seed must be integers.");
  }
  if (!resolved.sampleSeed) resolved.sampleSeed = resolved.seed;
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

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  return values
    .map((value, index) => ({ value, index, key: random() }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map(({ value }) => value);
}

function languageCounts(
  scenarios: readonly PairScenario[],
): Record<SampleLanguageVariant, number> {
  const counts = { en: 0, zh: 0, code_switch: 0 };
  for (const scenario of scenarios) {
    if (!SAMPLE_LANGUAGE_VARIANTS.includes(scenario.languageVariant as SampleLanguageVariant)) {
      throw new Error(
        `v2 sampling does not support language variant ${scenario.languageVariant}.`,
      );
    }
    counts[scenario.languageVariant as SampleLanguageVariant] += 1;
  }
  return counts;
}

function selectStratifiedSample(
  scenarios: readonly PairScenario[],
  sampleSeed: number,
): { scenarios: PairScenario[]; sampling: PairwiseSampling; selectedIds: ReadonlySet<string> } {
  const shuffledScenarios = shuffled(scenarios, sampleSeed);
  const selectedIds = new Set<string>();
  const selectedCounts = { en: 0, zh: 0, code_switch: 0 };
  const protectedCoverage: Record<string, string> = {};

  for (const category of PAIRWISE_SAMPLE_PROTECTED_CATEGORIES) {
    const selected = shuffledScenarios.find(
      (scenario) =>
        scenario.category === category &&
        !selectedIds.has(scenario.scenarioId) &&
        selectedCounts[scenario.languageVariant as SampleLanguageVariant] <
          STRATIFIED_SAMPLE_QUOTAS[scenario.languageVariant as SampleLanguageVariant],
    );
    if (!selected) {
      throw new Error(
        `Cannot satisfy protected-category coverage for ${category} within the v2 language quotas.`,
      );
    }
    selectedIds.add(selected.scenarioId);
    selectedCounts[selected.languageVariant as SampleLanguageVariant] += 1;
    protectedCoverage[category] = selected.scenarioId;
  }

  for (const languageVariant of SAMPLE_LANGUAGE_VARIANTS) {
    const remaining = STRATIFIED_SAMPLE_QUOTAS[languageVariant] - selectedCounts[languageVariant];
    if (remaining < 0) {
      throw new Error(`Protected coverage exceeded the ${languageVariant} sample quota.`);
    }
    const candidates = shuffledScenarios.filter(
      (scenario) =>
        scenario.languageVariant === languageVariant &&
        !selectedIds.has(scenario.scenarioId),
    );
    if (candidates.length < remaining) {
      throw new Error(
        `Not enough comparable ${languageVariant} scenarios for the v2 quota: need ${remaining}, found ${candidates.length}.`,
      );
    }
    for (const scenario of candidates.slice(0, remaining)) {
      selectedIds.add(scenario.scenarioId);
      selectedCounts[languageVariant] += 1;
    }
  }

  const selectedScenarios = shuffledScenarios.filter((scenario) =>
    selectedIds.has(scenario.scenarioId),
  );
  const eligibleCounts = languageCounts(scenarios);
  return {
    scenarios: selectedScenarios,
    selectedIds,
    sampling: {
      strategy: "stratified-random-v1",
      sampleSeed,
      quotas: STRATIFIED_SAMPLE_QUOTAS,
      eligibleCounts,
      selectedCounts,
      protectedCoverage,
    },
  };
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
  const {
    baselineFile,
    candidateFile,
    outDir,
    sample,
    sampleSeed,
    scenariosFile,
    seed,
  } = parseArguments();
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

  let sampling: PairwiseSampling | undefined;
  let outputScenarios = pairScenarios;
  if (sample) {
    const selected = selectStratifiedSample(pairScenarios, sampleSeed || seed);
    sampling = selected.sampling;
    outputScenarios = selected.scenarios;
    const selectedIds = selected.selectedIds;
    for (const scenario of pairScenarios) {
      if (!selectedIds.has(scenario.scenarioId)) {
        excludedScenarios.push({
          id: scenario.scenarioId,
          reason: "not selected by the v2 stratified random sample",
        });
      }
    }
  }

  const generatedAt = new Date().toISOString();
  const pairs: PairsFile = {
    protocol: sample ? BLIND_PAIRWISE_PROTOCOL_V2 : BLIND_PAIRWISE_PROTOCOL_V1,
    seed,
    generatedAt,
    baselineSource: path.relative(process.cwd(), baselineFile),
    candidateSource: path.relative(process.cwd(), candidateFile),
    scenarios: outputScenarios,
    ...(sampling ? { sampling } : {}),
    excludedScenarios,
    excludedTurns,
  };
  const sealed: SealedIdentitiesFile = {
    protocol: pairs.protocol,
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
    (total, scenario) =>
      total + (outputScenarios.includes(scenario) ? scenario.turns.length : 0),
    0,
  );
  console.log(
    `[pairwise] ${outputScenarios.length} paired scenarios, ${turnCount} comparable turns; ` +
      `${excludedScenarios.length} scenarios and ${excludedTurns.length} turns excluded`,
  );
  if (sampling) {
    console.log(
      `[pairwise] v2 sample ${JSON.stringify(sampling.selectedCounts)} from ${JSON.stringify(sampling.eligibleCounts)} (seed ${sampling.sampleSeed})`,
    );
  }
  console.log(
    `[pairwise] wrote pairs.json (blinded) and sealed-identities.json to ${path.relative(process.cwd(), outDir)}`,
  );
}

main().catch((error: unknown) => {
  console.error("[pairwise] build failed:", error);
  process.exitCode = 1;
});
