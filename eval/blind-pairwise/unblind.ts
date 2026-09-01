/**
 * Unblind a scored pairwise run and evaluate its merge-gate statistics.
 *
 * v1 is retained for the historical #79 six-dimension result. v2 is the
 * lower-fatigue protocol: one A / tie / B choice per comparable turn and one
 * holistic A / tie / B choice per scenario. Scenario-level choices are the
 * primary evidence unit; turn-level choices make disagreements inspectable.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BLIND_PAIRWISE_PROTOCOL_V1,
  BLIND_PAIRWISE_PROTOCOL_V2,
  DIMENSION_NAMES,
  isRecord,
  median,
  PROTECTED_CATEGORIES,
  TASTE_DIMENSIONS,
  type Conclusion,
  type PairScenario,
  type PairwiseChoice,
  type PairwiseScoresFile,
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

function validatePairs(value: unknown, file: string): PairsFile {
  if (
    !isRecord(value) ||
    (value.protocol !== BLIND_PAIRWISE_PROTOCOL_V1 &&
      value.protocol !== BLIND_PAIRWISE_PROTOCOL_V2) ||
    typeof value.seed !== "number" ||
    !Array.isArray(value.scenarios)
  ) {
    throw new Error(
      `${file} must contain a supported protocol, numeric seed, and scenarios array.`,
    );
  }
  return value as PairsFile;
}

function validateMapping(
  pairs: PairsFile,
  sealed: SealedIdentitiesFile,
): SealedIdentitiesFile["mapping"] {
  if (sealed.protocol !== pairs.protocol || !isRecord(sealed.mapping)) {
    throw new Error("sealed-identities.json does not match pairs.json.");
  }
  for (const scenario of pairs.scenarios) {
    const assignment = sealed.mapping[scenario.scenarioId];
    if (
      !assignment ||
      (assignment.A !== "baseline" && assignment.A !== "candidate") ||
      (assignment.B !== "baseline" && assignment.B !== "candidate") ||
      assignment.A === assignment.B
    ) {
      throw new Error(
        `sealed-identities.json has no valid mapping for ${scenario.scenarioId}.`,
      );
    }
  }
  return sealed.mapping;
}

function isPairwiseChoice(value: unknown): value is PairwiseChoice {
  return value === "A" || value === "tie" || value === "B";
}

function validateV1Scores(scores: unknown, pairs: PairsFile): ScoresFile {
  if (
    !isRecord(scores) ||
    (scores.protocol !== undefined && scores.protocol !== BLIND_PAIRWISE_PROTOCOL_V1) ||
    typeof scores.scorer !== "string" ||
    typeof scores.scoredAt !== "string" ||
    !Array.isArray(scores.scenarios)
  ) {
    throw new Error(
      "v1 scores.json must carry scorer, scoredAt, and a scenarios array.",
    );
  }
  const pairScenariosById = new Map(
    pairs.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );
  const scoredById = new Map<string, ScoredScenario>();
  for (const entry of scores.scenarios as unknown[]) {
    const scored = entry as ScoredScenario;
    if (!isRecord(entry) || typeof scored.scenarioId !== "string") {
      throw new Error("Every v1 scores.json scenario needs a scenarioId.");
    }
    if (scoredById.has(scored.scenarioId)) {
      throw new Error(`v1 scores.json duplicates ${scored.scenarioId}.`);
    }
    const pair = pairScenariosById.get(scored.scenarioId);
    if (!pair) {
      throw new Error(
        `v1 scores.json scores unknown scenario ${scored.scenarioId}.`,
      );
    }
    if (scored.bestOf !== "A" && scored.bestOf !== "B") {
      throw new Error(
        `Scenario ${scored.scenarioId} must pick exactly one best (A or B).`,
      );
    }
    if (!Array.isArray(scored.turns)) {
      throw new Error(`Scenario ${scored.scenarioId} is missing turns.`);
    }
    const scoredTurns = new Set<number>();
    for (const turnEntry of scored.turns) {
      const turn = turnEntry as {
        A: unknown;
        B: unknown;
        sequenceInScenario: number;
      };
      if (
        !isRecord(turnEntry) ||
        typeof turn.sequenceInScenario !== "number" ||
        scoredTurns.has(turn.sequenceInScenario)
      ) {
        throw new Error(
          `Scenario ${scored.scenarioId} has a malformed or duplicate scored turn.`,
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
      if (
        !pair.turns.some(
          (pairTurn) =>
            pairTurn.sequenceInScenario === turn.sequenceInScenario,
        )
      ) {
        throw new Error(
          `Scenario ${scored.scenarioId} turn ${turn.sequenceInScenario} is not a paired turn.`,
        );
      }
      scoredTurns.add(turn.sequenceInScenario);
    }
    for (const pairTurn of pair.turns) {
      if (!scoredTurns.has(pairTurn.sequenceInScenario)) {
        throw new Error(
          `Scenario ${scored.scenarioId} is partially scored; v1 unblinding refuses to continue.`,
        );
      }
    }
    scoredById.set(scored.scenarioId, scored);
  }
  for (const scenario of pairs.scenarios) {
    if (!scoredById.has(scenario.scenarioId)) {
      throw new Error(
        `Scenario ${scenario.scenarioId} is unscored; v1 unblinding refuses to continue.`,
      );
    }
  }
  return scores as ScoresFile;
}

function validateV2Scores(
  scores: unknown,
  pairs: PairsFile,
): PairwiseScoresFile {
  if (
    !isRecord(scores) ||
    scores.protocol !== BLIND_PAIRWISE_PROTOCOL_V2 ||
    typeof scores.scorer !== "string" ||
    typeof scores.scoredAt !== "string" ||
    !Array.isArray(scores.scenarios)
  ) {
    throw new Error(
      "v2 scores.json must carry protocol, scorer, scoredAt, and a scenarios array.",
    );
  }
  const pairScenariosById = new Map(
    pairs.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );
  const scoredById = new Map<string, PairwiseScoresFile["scenarios"][number]>();
  for (const entry of scores.scenarios as unknown[]) {
    if (!isRecord(entry) || typeof entry.scenarioId !== "string") {
      throw new Error("Every v2 scores.json scenario needs a scenarioId.");
    }
    const scored = entry as PairwiseScoresFile["scenarios"][number];
    if (scoredById.has(scored.scenarioId)) {
      throw new Error(`v2 scores.json duplicates ${scored.scenarioId}.`);
    }
    const pair = pairScenariosById.get(scored.scenarioId);
    if (!pair) {
      throw new Error(
        `v2 scores.json scores unknown scenario ${scored.scenarioId}.`,
      );
    }
    if (!isPairwiseChoice(scored.overallChoice)) {
      throw new Error(
        `Scenario ${scored.scenarioId} must choose A, tie, or B overall.`,
      );
    }
    if (!Array.isArray(scored.turns)) {
      throw new Error(`Scenario ${scored.scenarioId} is missing turns.`);
    }
    const scoredTurns = new Set<number>();
    for (const turnEntry of scored.turns) {
      if (
        !isRecord(turnEntry) ||
        typeof turnEntry.sequenceInScenario !== "number" ||
        !isPairwiseChoice(turnEntry.choice) ||
        scoredTurns.has(turnEntry.sequenceInScenario)
      ) {
        throw new Error(
          `Scenario ${scored.scenarioId} has a malformed or duplicate v2 scored turn.`,
        );
      }
      if (
        !pair.turns.some(
          (pairTurn) =>
            pairTurn.sequenceInScenario === turnEntry.sequenceInScenario,
        )
      ) {
        throw new Error(
          `Scenario ${scored.scenarioId} turn ${turnEntry.sequenceInScenario} is not a paired turn.`,
        );
      }
      scoredTurns.add(turnEntry.sequenceInScenario);
    }
    for (const pairTurn of pair.turns) {
      if (!scoredTurns.has(pairTurn.sequenceInScenario)) {
        throw new Error(
          `Scenario ${scored.scenarioId} is partially scored; v2 unblinding refuses to continue.`,
        );
      }
    }
    scoredById.set(scored.scenarioId, scored);
  }
  for (const scenario of pairs.scenarios) {
    if (!scoredById.has(scenario.scenarioId)) {
      throw new Error(
        `Scenario ${scenario.scenarioId} is unscored; v2 unblinding refuses to continue.`,
      );
    }
  }
  return scores as PairwiseScoresFile;
}

type DimensionSummary = Readonly<
  Record<TasteDimension, { baseline: number; candidate: number }>
>;

function emptyDimensionBuckets(): Record<TasteDimension, number[]> {
  const buckets = {} as Record<TasteDimension, number[]>;
  for (const dimension of TASTE_DIMENSIONS) {
    buckets[dimension] = [];
  }
  return buckets;
}

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
  const summary = {} as Record<
    TasteDimension,
    { baseline: number; candidate: number }
  >;
  for (const dimension of TASTE_DIMENSIONS) {
    summary[dimension] = {
      baseline: median(values.baseline[dimension]),
      candidate: median(values.candidate[dimension]),
    };
  }
  return summary;
}

type ChoiceCounts = Readonly<{
  baseline: number;
  tie: number;
  candidate: number;
  comparisons: number;
  candidateNet: number;
}>;

function emptyChoiceCounts(): {
  baseline: number;
  tie: number;
  candidate: number;
} {
  return { baseline: 0, tie: 0, candidate: 0 };
}

function choiceIdentity(
  choice: PairwiseChoice,
  assignment: { A: SystemIdentity; B: SystemIdentity },
): SystemIdentity | "tie" {
  if (choice === "tie") return "tie";
  return assignment[choice];
}

function choiceSummary(
  scenarios: readonly PairScenario[],
  scores: PairwiseScoresFile,
  mapping: SealedIdentitiesFile["mapping"],
  filter: (scenario: PairScenario) => boolean,
  level: "turns" | "scenarios",
): ChoiceCounts {
  const counts = emptyChoiceCounts();
  for (const scenario of scenarios) {
    if (!filter(scenario)) continue;
    const scored = scores.scenarios.find(
      (entry) => entry.scenarioId === scenario.scenarioId,
    );
    if (!scored) continue;
    const choices =
      level === "turns"
        ? scored.turns.map((turn) => turn.choice)
        : [scored.overallChoice];
    for (const choice of choices) {
      const winner = choiceIdentity(choice, mapping[scenario.scenarioId]!);
      if (winner === "baseline") counts.baseline += 1;
      if (winner === "candidate") counts.candidate += 1;
      if (winner === "tie") counts.tie += 1;
    }
  }
  return {
    ...counts,
    comparisons: counts.baseline + counts.tie + counts.candidate,
    candidateNet: counts.candidate - counts.baseline,
  };
}

type ReverseCheck =
  | { conclusionsChecked: number; failures: readonly string[] }
  | { conclusionsChecked: 0; note: "no conclusions file supplied" };

async function reverseCheckConclusions(
  conclusionsFile: string | null,
  pairs: PairsFile,
  mapping: SealedIdentitiesFile["mapping"],
): Promise<ReverseCheck> {
  if (!conclusionsFile) {
    return { conclusionsChecked: 0, note: "no conclusions file supplied" };
  }
  const conclusions = (await readJson(conclusionsFile)) as {
    conclusions: readonly Conclusion[];
  };
  if (!isRecord(conclusions) || !Array.isArray(conclusions.conclusions)) {
    throw new Error("conclusions.json must carry a conclusions array.");
  }
  const failures: string[] = [];
  for (const conclusion of conclusions.conclusions) {
    const scenario = pairs.scenarios.find(
      (entry) => entry.scenarioId === conclusion.scenarioId,
    );
    const turn = scenario?.turns.find(
      (entry) => entry.sequenceInScenario === conclusion.sequenceInScenario,
    );
    if (!scenario || !turn) {
      failures.push(
        `${conclusion.scenarioId} t${conclusion.sequenceInScenario}: no such paired turn`,
      );
      continue;
    }
    const side =
      mapping[conclusion.scenarioId]!.A === conclusion.attributedTo ? "A" : "B";
    const response = side === "A" ? turn.responseA : turn.responseB;
    if (!response.includes(conclusion.quote.trim())) {
      failures.push(
        `${conclusion.scenarioId} t${conclusion.sequenceInScenario} (attributed ${conclusion.attributedTo}): quote not found in that system's response — ${JSON.stringify(conclusion.quote)}`,
      );
    }
  }
  return { conclusionsChecked: conclusions.conclusions.length, failures };
}

function buildV1Results(
  pairs: PairsFile,
  scores: ScoresFile,
  mapping: SealedIdentitiesFile["mapping"],
  reverseCheck: ReverseCheck,
) {
  const overall = mediansBy(pairs.scenarios, scores, mapping, () => true);
  const perLocale = {
    code_switch: mediansBy(
      pairs.scenarios,
      scores,
      mapping,
      (scenario) => scenario.languageVariant === "code_switch",
    ),
    en: mediansBy(
      pairs.scenarios,
      scores,
      mapping,
      (scenario) => scenario.languageVariant === "en",
    ),
    zh: mediansBy(
      pairs.scenarios,
      scores,
      mapping,
      (scenario) => scenario.languageVariant === "zh",
    ),
  };
  const protectedSummaries = Object.fromEntries(
    PROTECTED_CATEGORIES.map((category) => [
      category,
      mediansBy(
        pairs.scenarios,
        scores,
        mapping,
        (scenario) => scenario.category === category,
      ),
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
    bestCounts[winnerIdentity] += 1;
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

  return {
    protocol: BLIND_PAIRWISE_PROTOCOL_V1,
    unblindedAt: new Date().toISOString(),
    seed: pairs.seed,
    scorer: scores.scorer,
    scoredAt: scores.scoredAt,
    mapping,
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
}

function buildV2Results(
  pairs: PairsFile,
  scores: PairwiseScoresFile,
  mapping: SealedIdentitiesFile["mapping"],
  reverseCheck: ReverseCheck,
) {
  const locales = ["en", "zh", "code_switch"] as const;
  const overall = {
    turns: choiceSummary(pairs.scenarios, scores, mapping, () => true, "turns"),
    scenarios: choiceSummary(
      pairs.scenarios,
      scores,
      mapping,
      () => true,
      "scenarios",
    ),
  };
  const perLocale = Object.fromEntries(
    locales.map((locale) => [
      locale,
      {
        turns: choiceSummary(
          pairs.scenarios,
          scores,
          mapping,
          (scenario) => scenario.languageVariant === locale,
          "turns",
        ),
        scenarios: choiceSummary(
          pairs.scenarios,
          scores,
          mapping,
          (scenario) => scenario.languageVariant === locale,
          "scenarios",
        ),
      },
    ]),
  );
  // The protected set is the run's own declared forced coverage when the
  // pairs carry sampling metadata (#79 v2 runs declare the contract §八 five
  // categories; #126 memory runs declare the ADR-0114 memory categories and
  // fence reasons). A run without sampling declares no forced coverage, so
  // only the overall and locale gates apply. A key matches a scenario through
  // its pack category or its coverage tags, so fence-reason keys
  // (post_correction / post_forget) resolve on the scenarios whose fixtures
  // carry them.
  const coverageKeys = pairs.sampling
    ? Object.keys(pairs.sampling.protectedCoverage)
    : [];
  const scenarioCovers = (scenario: PairScenario, key: string): boolean =>
    scenario.category === key ||
    (scenario.coverageTags ?? []).includes(key);
  const protectedCategories = Object.fromEntries(
    coverageKeys.map((category) => [
      category,
      {
        sampledScenarios: pairs.scenarios.filter((scenario) =>
          scenarioCovers(scenario, category),
        ).length,
        turns: choiceSummary(
          pairs.scenarios,
          scores,
          mapping,
          (scenario) => scenarioCovers(scenario, category),
          "turns",
        ),
        scenarios: choiceSummary(
          pairs.scenarios,
          scores,
          mapping,
          (scenario) => scenarioCovers(scenario, category),
          "scenarios",
        ),
      },
    ]),
  );

  const localeRegressions = locales.flatMap((locale) => {
    const summary = perLocale[locale].scenarios;
    return summary.candidateNet < 0
      ? [`${locale}: candidate net ${summary.candidateNet} < 0`]
      : [];
  });
  const protectedRegressions = Object.entries(protectedCategories).flatMap(
    ([category, summary]) => {
      if (summary.sampledScenarios === 0) {
        return [`${category}: no sampled scenario`];
      }
      return summary.scenarios.candidateNet < 0
        ? [`${category}: candidate net ${summary.scenarios.candidateNet} < 0`]
        : [];
    },
  );

  return {
    protocol: BLIND_PAIRWISE_PROTOCOL_V2,
    unblindedAt: new Date().toISOString(),
    seed: pairs.seed,
    sample: pairs.sampling ?? null,
    scorer: scores.scorer,
    scoredAt: scores.scoredAt,
    mapping,
    pairwise: {
      overall,
      perLocale,
      protectedCategories,
    },
    gate: {
      candidateStrictlyPreferredOverall: {
        passed: overall.scenarios.candidateNet > 0,
        unit: "scenario overall choice",
        summary: overall.scenarios,
        rule: "candidate scenario-level wins must exceed baseline wins; ties are neutral",
      },
      localeNoRegression:
        localeRegressions.length === 0
          ? { passed: true, unit: "scenario overall choice" }
          : {
              passed: false,
              unit: "scenario overall choice",
              regressions: localeRegressions,
            },
      protectedCategoryNoRegression:
        protectedRegressions.length === 0
          ? { passed: true, unit: "scenario overall choice" }
          : {
              passed: false,
              unit: "scenario overall choice",
              regressions: protectedRegressions,
            },
    },
    reverseCheck,
  };
}

async function main(): Promise<void> {
  const { conclusionsFile, dir } = parseArguments();
  const pairs = validatePairs(
    await readJson(path.join(dir, "pairs.json")),
    path.join(dir, "pairs.json"),
  );
  const sealed = (await readJson(
    path.join(dir, "sealed-identities.json"),
  )) as SealedIdentitiesFile;
  const mapping = validateMapping(pairs, sealed);
  const scores =
    pairs.protocol === BLIND_PAIRWISE_PROTOCOL_V1
      ? validateV1Scores(await readJson(path.join(dir, "scores.json")), pairs)
      : validateV2Scores(await readJson(path.join(dir, "scores.json")), pairs);
  const reverseCheck = await reverseCheckConclusions(
    conclusionsFile,
    pairs,
    mapping,
  );
  const results =
    pairs.protocol === BLIND_PAIRWISE_PROTOCOL_V1
      ? buildV1Results(pairs, scores as ScoresFile, mapping, reverseCheck)
      : buildV2Results(
          pairs,
          scores as PairwiseScoresFile,
          mapping,
          reverseCheck,
        );

  await writeFile(
    path.join(dir, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
    "utf8",
  );
  console.log(`[pairwise] unblinded ${pairs.scenarios.length} scenarios`);
  if (pairs.protocol === BLIND_PAIRWISE_PROTOCOL_V1) {
    const scenarioBest = (results as ReturnType<typeof buildV1Results>).scenarioBest;
    console.log(
      `[pairwise] scenario best — baseline ${scenarioBest.baseline} / candidate ${scenarioBest.candidate}`,
    );
  } else {
    const scenarioSummary =
      (results as ReturnType<typeof buildV2Results>).pairwise.overall.scenarios;
    console.log(
      `[pairwise] scenario overall — baseline ${scenarioSummary.baseline} / tie ${scenarioSummary.tie} / candidate ${scenarioSummary.candidate}`,
    );
  }
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
