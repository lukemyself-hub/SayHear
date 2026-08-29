/**
 * Build the 1A.3a memory blind-pairwise sample (issue #126; ADR-0114
 * memory-specific extension; SPEC #107 AC 36).
 *
 * The comparison arms are the Memory-on and Memory-off Replay twins of the
 * SAME frozen input (issue #126 capture-twins), so net preference is
 * attributable to memory itself, not persona drift. Identities are blinded by
 * the #62 seeded per-scenario shuffle; the Memory-off twin is the "baseline"
 * arm and the Memory-on twin the "candidate" arm, so the shared unblind tool's
 * "candidate net preference" reads directly as "Memory-on net preference".
 *
 * Sampling follows ADR-0114: 15 scenarios, 8 en / 5 zh / 2 code-switch quotas,
 * and forced coverage of Objective Memory, Person Portrait / AI Impression,
 * cross-day continuity, relationships and temporal change, post-Correction
 * AND post-Forget non-reuse, plus all three language forms. The memory sample
 * does not rely on the general behavior sample happening to include memory
 * turns: memory-bearing scenarios fill first (subject to the language quotas)
 * and the remainder is drawn from the general pool with a reproducible seed.
 *
 * Usage:
 *   pnpm exec tsx eval/memory-pairwise-126/build-memory-pairs.ts \
 *     --memory-on  eval/memory-pairwise-126/run-twins-on/transcripts.json \
 *     --memory-off eval/memory-pairwise-126/run-twins-off/transcripts.json \
 *     --scenarios  eval/scenario-pack-v3/scenarios.json \
 *     --out eval/memory-pairwise-126/pairs-run \
 *     --seed 126 --sample-seed 1260 [--full]
 *
 * Then reuse the shared blind-pairwise tooling on the output directory:
 *   build-review-page.ts --dir <out>   (human review; Luke scores scores.json)
 *   unblind.ts --dir <out>             (gates: net>0, no locale net-negative,
 *                                       no covered category net-regressed)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  SAMPLE_LANGUAGE_VARIANTS,
  STRATIFIED_SAMPLE_QUOTAS,
  identityAssignmentForScenario,
  mulberry32,
  type PairScenario,
  type PairTurn,
  type PairsFile,
  type PairwiseSampling,
  type SampleLanguageVariant,
  type SealedIdentitiesFile,
  type SystemIdentity,
} from "../blind-pairwise/protocol";

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
  id: string;
  languageVariant: string;
  memoryFixture?: Readonly<{
    fencedMentions?: readonly Readonly<{
      fromTurn: number;
      reason: string;
      tokens: readonly string[];
    }>[];
  }>;
}>;

type PackFile = Readonly<{ scenarios: readonly PackScenario[] }>;

/** ADR-0114 memory extension: the categories the sample must not miss. */
export const MEMORY_SAMPLE_FORCED_COVERAGE = Object.freeze([
  "memory_objective",
  "memory_impression",
  "memory_continuity",
  "post_correction",
  "post_forget",
] as const);

export type MemorySampleForcedCoverage =
  (typeof MEMORY_SAMPLE_FORCED_COVERAGE)[number];

export type MemorySampleCandidate = Readonly<{
  categories: readonly string[];
  id: string;
  languageVariant: SampleLanguageVariant;
}>;

export type MemorySampleSelection = Readonly<{
  eligibleCounts: Readonly<Record<SampleLanguageVariant, number>>;
  forcedCoverage: Readonly<Record<string, string>>;
  quotas: Readonly<Record<SampleLanguageVariant, number>>;
  scenarioIds: readonly string[];
  selectedCounts: Readonly<Record<SampleLanguageVariant, number>>;
  strategy: "memory-stratified-v1";
}>;

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = result[i]!;
    const b = result[j]!;
    result[i] = b;
    result[j] = a;
  }
  return result;
}

/**
 * The pure, reproducible memory-sample selection (ADR-0114). Deterministic
 * for a fixed seed; throws when the constraints cannot be satisfied by the
 * pool instead of silently dropping coverage.
 */
export function selectMemorySample(input: {
  candidates: readonly MemorySampleCandidate[];
  quotas?: Readonly<Record<SampleLanguageVariant, number>>;
  sampleSeed: number;
  total?: number;
}): MemorySampleSelection {
  const quotas = input.quotas ?? STRATIFIED_SAMPLE_QUOTAS;
  const total = input.total ?? 15;
  const quotaTotal = SAMPLE_LANGUAGE_VARIANTS.reduce(
    (sum, variant) => sum + quotas[variant],
    0,
  );
  if (quotaTotal !== total) {
    throw new Error(
      `Language quotas sum to ${quotaTotal}, expected the sample size ${total}.`,
    );
  }
  const eligibleCounts = { ...STRATIFIED_SAMPLE_QUOTAS };
  for (const variant of SAMPLE_LANGUAGE_VARIANTS) eligibleCounts[variant] = 0;
  for (const candidate of input.candidates) {
    eligibleCounts[candidate.languageVariant] += 1;
  }
  const random = mulberry32(input.sampleSeed);
  const memoryPool = shuffle(
    input.candidates.filter((candidate) =>
      candidate.categories.some((category) => category.startsWith("memory_")),
    ),
    random,
  );
  const generalPool = shuffle(
    input.candidates.filter(
      (candidate) =>
        !candidate.categories.some((category) =>
          category.startsWith("memory_"),
        ),
    ),
    random,
  );

  const forcedOf = (candidate: MemorySampleCandidate): readonly string[] =>
    MEMORY_SAMPLE_FORCED_COVERAGE.filter((forced) =>
      candidate.categories.includes(forced),
    );

  const selected: MemorySampleCandidate[] = [];
  const counts = { ...STRATIFIED_SAMPLE_QUOTAS };
  for (const variant of SAMPLE_LANGUAGE_VARIANTS) counts[variant] = 0;
  const hasRoom = (candidate: MemorySampleCandidate): boolean =>
    counts[candidate.languageVariant] < quotas[candidate.languageVariant];
  const push = (candidate: MemorySampleCandidate): void => {
    selected.push(candidate);
    counts[candidate.languageVariant] += 1;
  };

  // 1. Memory-bearing scenarios fill first, in seeded shuffle order, subject
  //    to the language quotas (code-switch caps at 2 by ADR-0114).
  for (const candidate of memoryPool) {
    if (hasRoom(candidate)) push(candidate);
  }

  // 2. Guarantee every forced category. A category missed only because its
  //    sole bearer lost its language slot to a non-forced selection swaps the
  //    bearer in for a same-language selection that covers nothing forced.
  for (const forced of MEMORY_SAMPLE_FORCED_COVERAGE) {
    if (selected.some((candidate) => forcedOf(candidate).includes(forced))) {
      continue;
    }
    const bearer = memoryPool.find((candidate) =>
      forcedOf(candidate).includes(forced),
    );
    if (!bearer) {
      throw new Error(
        `The pool contains no scenario covering "${forced}"; the ADR-0114 forced coverage is unsatisfiable.`,
      );
    }
    const victimIndex = selected.findIndex(
      (candidate) =>
        candidate.languageVariant === bearer.languageVariant &&
        forcedOf(candidate).length === 0,
    );
    if (victimIndex < 0) {
      throw new Error(
        `Cannot fit the "${forced}" bearer without breaking quotas or dropping other forced coverage.`,
      );
    }
    selected.splice(victimIndex, 1);
    push(bearer);
  }

  // 3. Fill the remaining quota slots from the general pool.
  for (const candidate of generalPool) {
    if (selected.length >= total) break;
    if (hasRoom(candidate)) push(candidate);
  }
  if (selected.length !== total) {
    throw new Error(
      `Sample selected ${selected.length} of ${total}; the pool is too small for the quotas.`,
    );
  }

  const forcedCoverage: Record<string, string> = {};
  for (const forced of MEMORY_SAMPLE_FORCED_COVERAGE) {
    const bearer = selected.find((candidate) =>
      forcedOf(candidate).includes(forced),
    );
    if (!bearer) {
      throw new Error(`Forced coverage "${forced}" was lost during selection.`);
    }
    forcedCoverage[forced] = bearer.id;
  }
  return {
    eligibleCounts,
    forcedCoverage,
    quotas,
    scenarioIds: selected.map((candidate) => candidate.id),
    selectedCounts: counts,
    strategy: "memory-stratified-v1",
  };
}

function categoriesOf(
  scenario: CapturedScenario,
  packScenario: PackScenario | undefined,
): readonly string[] {
  const categories = [scenario.category];
  for (const fence of packScenario?.memoryFixture?.fencedMentions ?? []) {
    categories.push(fence.reason);
  }
  return categories;
}

function parseArguments(): {
  full: boolean;
  memoryOnFile: string;
  memoryOffFile: string;
  outDir: string;
  sampleSeed: number;
  scenariosFile: string;
  seed: number;
} {
  const arguments_ = process.argv.slice(2);
  const resolved = {
    full: false,
    memoryOnFile: "",
    memoryOffFile: "",
    outDir: "",
    sampleSeed: 0,
    scenariosFile: "",
    seed: 126,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === "--full") {
      resolved.full = true;
    } else if (argument === "--memory-on") {
      resolved.memoryOnFile = required(arguments_, ++index, "--memory-on");
    } else if (argument === "--memory-off") {
      resolved.memoryOffFile = required(arguments_, ++index, "--memory-off");
    } else if (argument === "--scenarios") {
      resolved.scenariosFile = required(arguments_, ++index, "--scenarios");
    } else if (argument === "--out") {
      resolved.outDir = required(arguments_, ++index, "--out");
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

export type MemoryPairBuildInput = Readonly<{
  full: boolean;
  memoryOff: TranscriptsFile;
  memoryOn: TranscriptsFile;
  pack: PackFile;
  sampleSeed: number;
  seed: number;
  sources?: Readonly<{ baselineSource: string; candidateSource: string }>;
}>;

export type MemoryPairBuildResult = Readonly<{
  excludedTurns: readonly Readonly<{
    id: string;
    reason: string;
    sequenceInScenario: number;
  }>[];
  pairs: PairsFile;
  sealed: SealedIdentitiesFile;
}>;

export function buildMemoryPairs(
  input: MemoryPairBuildInput,
): MemoryPairBuildResult {
  const packById = new Map(
    input.pack.scenarios.map((entry) => [entry.id, entry]),
  );
  const offById = new Map(
    input.memoryOff.scenarios.map((scenario) => [scenario.id, scenario]),
  );

  // A pair turn is comparable only when both twin arms contain the same
  // scenario, the same turn number, and byte-identical user input — by twin
  // construction every turn qualifies, but the check keeps the protocol
  // honest if arms ever drift.
  const excludedTurns: {
    id: string;
    reason: string;
    sequenceInScenario: number;
  }[] = [];
  const comparable = (scenario: CapturedScenario): PairScenario => {
    const counterpart = offById.get(scenario.id);
    if (!counterpart) {
      throw new Error(`Scenario ${scenario.id} is missing from the off arm.`);
    }
    const turns: PairTurn[] = [];
    for (const turn of scenario.turns) {
      const counterpartTurn = counterpart.turns.find(
        (candidate) =>
          candidate.sequenceInScenario === turn.sequenceInScenario,
      );
      if (!counterpartTurn || counterpartTurn.input.text !== turn.input.text) {
        excludedTurns.push({
          id: scenario.id,
          reason: "user input differs between the twin arms",
          sequenceInScenario: turn.sequenceInScenario,
        });
        continue;
      }
      turns.push({
        responseA: counterpartTurn.assistantText,
        responseB: turn.assistantText,
        sequenceInScenario: turn.sequenceInScenario,
        userInput: turn.input,
      });
    }
    return {
      category: scenario.category,
      description: scenario.description,
      languageVariant: scenario.languageVariant,
      scenarioId: scenario.id,
      turns,
    };
  };

  const candidates: MemorySampleCandidate[] = input.memoryOn.scenarios.map(
    (scenario) => ({
      categories: categoriesOf(scenario, packById.get(scenario.id)),
      id: scenario.id,
      languageVariant: scenario.languageVariant as SampleLanguageVariant,
    }),
  );
  const pairScenarios = input.memoryOn.scenarios.map(comparable);
  const pairById = new Map(
    pairScenarios.map((pair) => [pair.scenarioId, pair]),
  );

  let selection: MemorySampleSelection | null = null;
  const selectedPairs = input.full
    ? pairScenarios
    : (() => {
        selection = selectMemorySample({
          candidates,
          sampleSeed: input.sampleSeed,
        });
        return selection.scenarioIds.flatMap((id) => {
          const pair = pairById.get(id);
          if (!pair) {
            throw new Error(`Sampled scenario ${id} has no comparable pair.`);
          }
          return [pair];
        });
      })();

  const mapping: Record<string, { A: SystemIdentity; B: SystemIdentity }> = {};
  const blinded: PairScenario[] = selectedPairs.map((pair, ordinal) => {
    const assignment = identityAssignmentForScenario(input.seed, ordinal);
    mapping[pair.scenarioId] = assignment;
    if (assignment.A === "baseline") {
      // A shows the Memory-off twin, B the Memory-on twin.
      return pair;
    }
    return {
      ...pair,
      turns: pair.turns.map((turn) => ({
        ...turn,
        responseA: turn.responseB,
        responseB: turn.responseA,
      })),
    };
  });

  const sampling: PairwiseSampling | undefined = selection
    ? {
        eligibleCounts: selection.eligibleCounts,
        protectedCoverage: { ...selection.forcedCoverage },
        quotas: selection.quotas,
        sampleSeed: input.sampleSeed,
        selectedCounts: selection.selectedCounts,
        strategy: "stratified-random-v1",
      }
    : undefined;

  return {
    excludedTurns,
    pairs: {
      baselineSource: input.sources?.baselineSource ?? "memory-off twin transcripts",
      candidateSource: input.sources?.candidateSource ?? "memory-on twin transcripts",
      excludedScenarios: [],
      excludedTurns,
      generatedAt: new Date().toISOString(),
      protocol: "blind-pairwise:v2",
      scenarios: blinded,
      ...(sampling ? { sampling } : {}),
      seed: input.seed,
    },
    sealed: {
      generatedAt: new Date().toISOString(),
      mapping,
      protocol: "blind-pairwise:v2",
      seed: input.seed,
    },
  };
}

async function main(): Promise<void> {
  const {
    full,
    memoryOnFile,
    memoryOffFile,
    outDir,
    sampleSeed,
    scenariosFile,
    seed,
  } = parseArguments();
  const memoryOn = JSON.parse(
    await readFile(memoryOnFile, "utf8"),
  ) as TranscriptsFile;
  const memoryOff = JSON.parse(
    await readFile(memoryOffFile, "utf8"),
  ) as TranscriptsFile;
  const pack = JSON.parse(await readFile(scenariosFile, "utf8")) as PackFile;
  const { excludedTurns, pairs, sealed } = buildMemoryPairs({
    full,
    memoryOff,
    memoryOn,
    pack,
    sampleSeed,
    seed,
    sources: { baselineSource: memoryOffFile, candidateSource: memoryOnFile },
  });

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
  console.log(
    `[memory-pairs] wrote ${pairs.scenarios.length} scenario pair(s) to ${outDir}` +
      (pairs.sampling
        ? ` (sample seed ${sampleSeed}; forced coverage ${Object.keys(pairs.sampling.protectedCoverage).join(", ")})`
        : " (--full: no sampling)"),
  );
  console.log(
    `[memory-pairs] excluded turns: ${excludedTurns.length}` +
      (excludedTurns.length === 0 ? "" : ` (${excludedTurns.map((turn) => `${turn.id}#${turn.sequenceInScenario}`).join(", ")})`),
  );
  console.log(
    "[memory-pairs] next: pnpm exec tsx eval/blind-pairwise/build-review-page.ts --dir "
      + outDir,
  );
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error("[memory-pairs] build failed:", error);
    process.exitCode = 1;
  });
}
