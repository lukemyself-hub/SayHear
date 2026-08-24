/**
 * Shared protocol types and helpers for the blind-pairwise channel
 * (issue #79; docs/evaluation/01-behavior-contract-and-rubric.md §三).
 *
 * The protocol: the same scenarios run through both systems, identities are
 * blinded by a seeded per-scenario shuffle, and the rater compares each
 * common turn with one of A / tie / B before any unblinding. The v1 six-
 * dimension score format remains readable for the historical #79 run; v2 is
 * the lower-fatigue format for subsequent evaluations. Post-reveal
 * conclusions are reverse-checked against raw responses before they may be
 * cited (the #62 revision-record lesson).
 */

export const BLIND_PAIRWISE_PROTOCOL_V1 = "blind-pairwise:v1" as const;
export const BLIND_PAIRWISE_PROTOCOL_V2 = "blind-pairwise:v2" as const;
export const BLIND_PAIRWISE_PROTOCOL_VERSION = BLIND_PAIRWISE_PROTOCOL_V2;

export type BlindPairwiseProtocol =
  | typeof BLIND_PAIRWISE_PROTOCOL_V1
  | typeof BLIND_PAIRWISE_PROTOCOL_V2;

export const SAMPLE_LANGUAGE_VARIANTS = ["en", "zh", "code_switch"] as const;
export type SampleLanguageVariant = (typeof SAMPLE_LANGUAGE_VARIANTS)[number];

export const STRATIFIED_SAMPLE_QUOTAS: Readonly<
  Record<SampleLanguageVariant, number>
> = Object.freeze({
  en: 8,
  zh: 5,
  code_switch: 2,
});

export const PAIRWISE_SAMPLE_PROTECTED_CATEGORIES = Object.freeze([
  "high_risk",
  "refusal",
  "short_answers",
  "topic_change",
  "direct_task",
] as const);

export type PairwiseChoice = "A" | "tie" | "B";

/** The six taste dimensions of the behavior contract §二, English keys over the CONTEXT.md names. */
export const TASTE_DIMENSIONS = [
  "vitality",
  "warmth",
  "sincerity",
  "proportion",
  "naturalness",
  "colloquial",
] as const;

export type TasteDimension = (typeof TASTE_DIMENSIONS)[number];

/** 生命力 vitality · 温暖关心 warmth · 真诚 sincerity · 分寸 proportion · 自然 naturalness · 口语度 colloquial */
export const DIMENSION_NAMES: Readonly<Record<TasteDimension, string>> = {
  colloquial: "口语度",
  naturalness: "自然",
  proportion: "分寸",
  sincerity: "真诚",
  vitality: "生命力",
  warmth: "温暖关心",
};

export type TasteScores = Readonly<Record<TasteDimension, number>>;

/**
 * Categories whose contract criteria and taste medians may not regress
 * against the incumbent baseline (contract §八 evidence item 2): safety,
 * stop-signal behavior, and capability honesty.
 */
export const PROTECTED_CATEGORIES: readonly string[] = Object.freeze([
  "high_risk",
  "refusal",
  "short_answers",
  "topic_change",
  "direct_task",
]);

/** Categories excluded from pairwise judgment in this slice: recall judgment is deferred to 1A.3a (#79). */
export const PAIRWISE_EXCLUDED_CATEGORIES: readonly string[] = Object.freeze([
  "memory_continuity",
]);

export type SystemIdentity = "baseline" | "candidate";

export type PairTurn = Readonly<{
  sequenceInScenario: number;
  userInput: Readonly<{ locale: string; text: string; timezone: string }>;
  responseA: string;
  responseB: string;
}>;

export type PairScenario = Readonly<{
  scenarioId: string;
  category: string;
  languageVariant: string;
  description: string;
  turns: readonly PairTurn[];
}>;

export type PairwiseSampling = Readonly<{
  strategy: "stratified-random-v1";
  sampleSeed: number;
  quotas: Readonly<Record<SampleLanguageVariant, number>>;
  eligibleCounts: Readonly<Record<SampleLanguageVariant, number>>;
  selectedCounts: Readonly<Record<SampleLanguageVariant, number>>;
  protectedCoverage: Readonly<Record<string, string>>;
}>;

export type PairsFile = Readonly<{
  protocol: BlindPairwiseProtocol;
  seed: number;
  generatedAt: string;
  baselineSource: string;
  candidateSource: string;
  scenarios: readonly PairScenario[];
  sampling?: PairwiseSampling;
  excludedScenarios: readonly Readonly<{ id: string; reason: string }>[];
  excludedTurns: readonly Readonly<{
    id: string;
    sequenceInScenario: number;
    reason: string;
  }>[];
}>;

export type SealedIdentitiesFile = Readonly<{
  protocol: BlindPairwiseProtocol;
  seed: number;
  generatedAt: string;
  mapping: Readonly<
    Record<string, Readonly<{ A: SystemIdentity; B: SystemIdentity }>>
  >;
}>;

export type ScoredTurn = Readonly<{
  sequenceInScenario: number;
  A: TasteScores;
  B: TasteScores;
  note?: string;
}>;

export type ScoredScenario = Readonly<{
  scenarioId: string;
  bestOf: "A" | "B";
  scenarioNote?: string;
  turns: readonly ScoredTurn[];
}>;

export type ScoresFile = Readonly<{
  scorer: string;
  scoredAt: string;
  scenarios: readonly ScoredScenario[];
}>;

export type PairwiseScoredTurn = Readonly<{
  sequenceInScenario: number;
  choice: PairwiseChoice;
  note?: string;
}>;

export type PairwiseScoredScenario = Readonly<{
  scenarioId: string;
  overallChoice: PairwiseChoice;
  scenarioNote?: string;
  turns: readonly PairwiseScoredTurn[];
}>;

export type PairwiseScoresFile = Readonly<{
  protocol: typeof BLIND_PAIRWISE_PROTOCOL_V2;
  scorer: string;
  scoredAt: string;
  scenarios: readonly PairwiseScoredScenario[];
}>;

export type Conclusion = Readonly<{
  quote: string;
  scenarioId: string;
  sequenceInScenario: number;
  attributedTo: SystemIdentity;
  claim: string;
}>;

/**
 * Deterministic PRNG (mulberry32) with the #62 seed derivation: the shuffle
 * for scenario ordinal i uses seed + i * 7, so the blinding is reproducible
 * from the recorded seed alone.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function identityAssignmentForScenario(
  seed: number,
  scenarioOrdinal: number,
): { A: SystemIdentity; B: SystemIdentity } {
  const draw = mulberry32(seed + scenarioOrdinal * 7)();
  return draw < 0.5
    ? { A: "baseline", B: "candidate" }
    : { A: "candidate", B: "baseline" };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("median of an empty sample is undefined.");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
