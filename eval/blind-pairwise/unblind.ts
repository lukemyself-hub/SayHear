/**
 * Unblind a scored pairwise run and evaluate the merge-gate statistics
 * (issue #79; behavior contract §三/§八).
 *
 * Enforces score-before-unblind structurally: the run directory must already
 * contain a complete scores.json — every paired turn scored on all six taste
 * dimensions (integers 1–5) and every scenario carrying exactly one best
 * pick — or the unblinding refuses to run. If a conclusions file is supplied,
 * every quoted fragment is reverse-checked against the raw response of the
 * system the conclusion attributes it to, and any mismatch fails the run
 * (the #62 revision-record lesson, mechanized).
 *
 * Usage:
 *   tsx eval/blind-pairwise/unblind.ts --dir eval/blind-pairwise/run-79 \
 *     [--conclusions eval/blind-pairwise/run-79/conclusions.json]
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DIMENSION_NAMES,
  isRecord,
  median,
  PROTECTED_CATEGORIES,
  TASTE_DIMENSIONS,
  type Conclusion,
  type PairScenario,
  type PairsFile,
  type ScoredScenario,
  type ScoresFile,
  type SealedIdentitiesFile,
  type SystemIdentity,
  type TasteDimension,
} from "./protocol";

function parseArguments(): { conclusionsFile: string | null; dir: string } {
  const arguments_ = process.argv.slice(2);
  let dir = "";
  let conclusionsFile: string | null = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === "--dir") {
      dir = required(arguments_, ++index, "--dir");
    } else if (argument === "--conclusions") {
      conclusionsFile = required(arguments_, ++index, "--conclusions");
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (dir.length === 0) {
    throw new Error("--dir is required.");
  }
  return { conclusionsFile, dir };
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

function validateScores(
  scores: unknown,
  pairs: PairsFile,
): ScoresFile {
  if (
    !isRecord(scores) ||
    typeof scores.scorer !== "string" ||
    typeof scores.scoredAt !== "string" ||
    !Array.isArray(scores.scenarios)
  ) {
    throw new Error(
      "scores.json must carry scorer, scoredAt, and a scenarios array.",
    );
  }
  const pairScenariosById = new Map(
    pairs.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );
  const scoredById = new Map<string, ScoredScenario>();
  for (const entry of scores.scenarios as unknown[]) {
    const scored = entry as ScoredScenario;
    if (!isRecord(entry) || typeof scored.scenarioId !== "string") {
      throw new Error("Every scores.json scenario needs a scenarioId.");
    }
    const pair = pairScenariosById.get(scored.scenarioId);
    if (!pair) {
      throw new Error(
        `scores.json scores unknown scenario ${scored.scenarioId}.`,
      );
    }
    if (scored.bestOf !== "A" && scored.bestOf !== "B") {
      throw new Error(
        `Scenario ${scored.scenarioId} must pick exactly one best (A or B).`,
      );
    }
    const scoredTurns = new Set<number>();
    for (const turnEntry of scored.turns ?? []) {
      const turn = turnEntry as { A: unknown; B: unknown; sequenceInScenario: number };
      if (
        !isRecord(turnEntry) ||
        typeof turn.sequenceInScenario !== "number"
      ) {
        throw new Error(
          `Scenario ${scored.scenarioId} has a malformed scored turn.`,
        );
      }
      for (const side of ["A", "B"] as const) {
        const sideScores = turn[side] as Record<string, unknown>;
        if (!isRecord(sideScores)) {
          throw new Error(
            `Scenario ${scored.scenarioId} turn ${turn.sequenceInScenario} is missing ${side} scores.`,
          );
        }
        for (const dimension of TASTE_DIMENSIONS) {
          const value = sideScores[dimension];
          if (
            typeof value !== "number" ||
            !Number.isInteger(value) ||
            value < 1 ||
            value > 5
          ) {
            throw new Error(
              `Scenario ${scored.scenarioId} turn ${turn.sequenceInScenario} ${side} ${DIMENSION_NAMES[dimension]} must be an integer 1–5.`,
            );
          }
        }
      }
      if (!pair.turns.some((t) => t.sequenceInScenario === turn.sequenceInScenario)) {
        throw new Error(
          `Scenario ${scored.scenarioId} turn ${turn.sequenceInScenario} is not a paired turn.`,
        );
      }
      scoredTurns.add(turn.sequenceInScenario);
    }
    for (const pairTurn of pair.turns) {
      if (!scoredTurns.has(pairTurn.sequenceInScenario)) {
        throw new Error(
          `Scenario ${scored.scenarioId} turn ${pairTurn.sequenceInScenario} is unscored; unblinding refuses to run on a partial scoring (score before unblinding).`,
        );
      }
    }
    scoredById.set(scored.scenarioId, scored);
  }
  for (const scenario of pairs.scenarios) {
    if (!scoredById.has(scenario.scenarioId)) {
      throw new Error(
        `Scenario ${scenario.scenarioId} is unscored; unblinding refuses to run on a partial scoring (score before unblinding).`,
      );
    }
  }
  return scores as ScoresFile;
}

type DimensionSummary = Readonly<
  Record<TasteDimension, { baseline: number; candidate: number }>
>;

function mediansBy(
  scenarios: readonly PairScenario[],
  scores: ScoresFile,
  mapping: SealedIdentitiesFile["mapping"],
  filter: (scenario: PairScenario) => boolean,
): DimensionSummary {
  const values: Record<SystemIdentity, Record<TasteDimension, number[]>> = {
    baseline: emptyDimensionBuckets(),
    candidate: emptyDimensionBuckets(),
  };
  for (const scenario of scenarios) {
    if (!filter(scenario)) continue;
    const scored = scores.scenarios.find(
      (entry) => entry.scenarioId === scenario.scenarioId,
    );
    if (!scored) continue;
    // Side attribution flows through the sealed mapping at aggregation time
    // only; the medians below stay per-identity from here on.
    const baselineSide =
      mapping[scenario.scenarioId]!.A === "baseline" ? "A" : "B";
    for (const turn of scored.turns) {
      for (const dimension of TASTE_DIMENSIONS) {
        values.baseline[dimension].push(
          baselineSide === "A" ? turn.A[dimension] : turn.B[dimension],
        );
        values.candidate[dimension].push(
          baselineSide === "A" ? turn.B[dimension] : turn.A[dimension],
        );
      }
    }
  }
  const summary = {} as Record<TasteDimension, { baseline: number; candidate: number }>;
  for (const dimension of TASTE_DIMENSIONS) {
    summary[dimension] = {
      baseline: median(values.baseline[dimension]),
      candidate: median(values.candidate[dimension]),
    };
  }
  return summary;
}

function emptyDimensionBuckets(): Record<TasteDimension, number[]> {
  const buckets = {} as Record<TasteDimension, number[]>;
  for (const dimension of TASTE_DIMENSIONS) {
    buckets[dimension] = [];
  }
  return buckets;
}

async function main(): Promise<void> {
  const { conclusionsFile, dir } = parseArguments();
  const pairs = (await readJson(path.join(dir, "pairs.json"))) as PairsFile;
  const sealed = (await readJson(
    path.join(dir, "sealed-identities.json"),
  )) as SealedIdentitiesFile;
  const scores = validateScores(
    await readJson(path.join(dir, "scores.json")),
    pairs,
  );
  if (pairs.protocol !== "blind-pairwise:v1") {
    throw new Error("Unexpected pairs.json protocol version.");
  }
  const mapping = sealed.mapping;

  const overall = mediansBy(pairs.scenarios, scores, mapping, () => true);
  const perLocale = {
    code_switch: mediansBy(pairs.scenarios, scores, mapping, (s) => s.languageVariant === "code_switch"),
    en: mediansBy(pairs.scenarios, scores, mapping, (s) => s.languageVariant === "en"),
    zh: mediansBy(pairs.scenarios, scores, mapping, (s) => s.languageVariant === "zh"),
  };
  const protectedSummaries = Object.fromEntries(
    PROTECTED_CATEGORIES.map((category) => [
      category,
      mediansBy(pairs.scenarios, scores, mapping, (s) => s.category === category),
    ]),
  );

  const bestCounts = { baseline: 0, candidate: 0 };
  for (const scenario of pairs.scenarios) {
    const scored = scores.scenarios.find(
      (entry) => entry.scenarioId === scenario.scenarioId,
    );
    if (!scored) continue;
    const winnerIdentity =
      scored.bestOf === "A"
        ? mapping[scenario.scenarioId]!.A
        : mapping[scenario.scenarioId]!.B;
    if (winnerIdentity === "baseline") bestCounts.baseline += 1;
    if (winnerIdentity === "candidate") bestCounts.candidate += 1;
  }

  const strictBetter = TASTE_DIMENSIONS.filter(
    (dimension) =>
      (dimension === "vitality" || dimension === "warmth") &&
      overall[dimension].candidate > overall[dimension].baseline,
  );
  const protectedRegressions: string[] = [];
  for (const [category, summary] of Object.entries(protectedSummaries)) {
    for (const dimension of TASTE_DIMENSIONS) {
      if (summary[dimension].candidate < summary[dimension].baseline) {
        protectedRegressions.push(
          `${category}/${DIMENSION_NAMES[dimension]}: candidate median ${summary[dimension].candidate} < baseline ${summary[dimension].baseline}`,
        );
      }
    }
  }

  let reverseCheck:
    | { conclusionsChecked: number; failures: readonly string[] }
    | { conclusionsChecked: 0; note: "no conclusions file supplied" } = {
    conclusionsChecked: 0,
    note: "no conclusions file supplied",
  };
  if (conclusionsFile) {
    const conclusions = (await readJson(conclusionsFile)) as {
      conclusions: readonly Conclusion[];
    };
    if (!isRecord(conclusions) || !Array.isArray(conclusions.conclusions)) {
      throw new Error("conclusions.json must carry a conclusions array.");
    }
    const failures: string[] = [];
    for (const conclusion of conclusions.conclusions) {
      const scenario = pairs.scenarios.find(
        (s) => s.scenarioId === conclusion.scenarioId,
      );
      const turn = scenario?.turns.find(
        (t) => t.sequenceInScenario === conclusion.sequenceInScenario,
      );
      if (!scenario || !turn) {
        failures.push(
          `${conclusion.scenarioId} t${conclusion.sequenceInScenario}: no such paired turn`,
        );
        continue;
      }
      const side =
        mapping[conclusion.scenarioId]!.A === conclusion.attributedTo
          ? "A"
          : "B";
      const response = side === "A" ? turn.responseA : turn.responseB;
      if (!response.includes(conclusion.quote.trim())) {
        failures.push(
          `${conclusion.scenarioId} t${conclusion.sequenceInScenario} (attributed ${conclusion.attributedTo}): quote not found in that system's response — ${JSON.stringify(conclusion.quote)}`,
        );
      }
    }
    reverseCheck = { conclusionsChecked: conclusions.conclusions.length, failures };
  }

  const results = {
    protocol: "blind-pairwise:v1",
    unblindedAt: new Date().toISOString(),
    seed: pairs.seed,
    scorer: scores.scorer,
    scoredAt: scores.scoredAt,
    mapping: sealed.mapping,
    medians: {
      overall,
      perLocale,
      protectedCategories: protectedSummaries,
    },
    scenarioBest: bestCounts,
    gate: {
      vitalityOrWarmthStrictlyBetter:
        strictBetter.length > 0
          ? { passed: true, dimensions: strictBetter }
          : {
              passed: false,
              dimensions: [],
              rule: "at least one of 生命力(vitality)/温暖关心(warmth) overall medians must be strictly better than the baseline, or the change iterates (issue #79)",
            },
      protectedCategoryNoRegression:
        protectedRegressions.length === 0
          ? { passed: true }
          : { passed: false, regressions: protectedRegressions },
    },
    reverseCheck,
  };

  await writeFile(
    path.join(dir, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
    "utf8",
  );
  console.log(`[pairwise] unblinded ${pairs.scenarios.length} scenarios`);
  console.log(
    `[pairwise] scenario best — baseline ${bestCounts.baseline} / candidate ${bestCounts.candidate}`,
  );
  console.log(`[pairwise] gate: ${JSON.stringify(results.gate)}`);
  if ("failures" in reverseCheck && reverseCheck.failures.length > 0) {
    console.error("[pairwise] reverse-check failures:");
    for (const failure of reverseCheck.failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("[pairwise] unblind failed:", error);
  process.exitCode = 1;
});
