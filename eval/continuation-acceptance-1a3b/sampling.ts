import {
  CONTINUATION_FORCED_COVERAGE,
  CONTINUATION_PROTECTED_CATEGORIES,
  CONTINUATION_SAMPLE_QUOTAS,
  LANGUAGE_VARIANTS,
  shuffled,
  type ContinuationCoverageTag,
  type ContinuationProtectedCategory,
  type ContinuationSample,
  type LanguageVariant,
  type SampleCandidate,
} from "./protocol";

function emptyCounts(): Record<LanguageVariant, number> {
  return { code_switch: 0, en: 0, zh: 0 };
}

function quotaTotal(quotas: Readonly<Record<LanguageVariant, number>>): number {
  return LANGUAGE_VARIANTS.reduce((total, variant) => total + quotas[variant], 0);
}

function validateQuotas(
  quotas: Readonly<Record<LanguageVariant, number>>,
  total: number,
): void {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error("Sample total must be a non-negative integer.");
  }
  for (const variant of LANGUAGE_VARIANTS) {
    if (!Number.isInteger(quotas[variant]) || quotas[variant] < 0) {
      throw new Error(`Quota for ${variant} must be a non-negative integer.`);
    }
  }
  if (quotaTotal(quotas) !== total) {
    throw new Error(`Language quotas must sum to ${total}.`);
  }
}

function forcedTags(candidate: SampleCandidate): readonly ContinuationCoverageTag[] {
  return CONTINUATION_FORCED_COVERAGE.filter((tag) =>
    candidate.coverageTags.includes(tag),
  );
}

type ForcedRequirement =
  | { kind: "category"; key: ContinuationProtectedCategory }
  | { kind: "tag"; key: ContinuationCoverageTag };

const forcedRequirements: readonly ForcedRequirement[] = [
  ...CONTINUATION_FORCED_COVERAGE.map((key) => ({ kind: "tag" as const, key })),
  ...CONTINUATION_PROTECTED_CATEGORIES.map((key) => ({
    kind: "category" as const,
    key,
  })),
];

function satisfies(
  candidate: SampleCandidate,
  requirement: ForcedRequirement,
): boolean {
  return requirement.kind === "tag"
    ? candidate.coverageTags.includes(requirement.key)
    : candidate.category === requirement.key;
}

/**
 * Select the F3 Continuation sample without consulting a provider or a
 * production data source. Forced coverage is filled first, then the
 * remaining language quota is filled from the same seeded order.
 */
export function selectContinuationSample(input: {
  candidates: readonly SampleCandidate[];
  quotas?: Readonly<Record<LanguageVariant, number>>;
  sampleSeed: number;
  total?: number;
}): ContinuationSample {
  const quotas = input.quotas ?? CONTINUATION_SAMPLE_QUOTAS;
  const total = input.total ?? quotaTotal(quotas);
  if (!Number.isInteger(input.sampleSeed)) {
    throw new Error("sampleSeed must be an integer.");
  }
  validateQuotas(quotas, total);

  const ids = new Set<string>();
  const eligibleCounts = emptyCounts();
  for (const candidate of input.candidates) {
    if (ids.has(candidate.id)) {
      throw new Error(`Continuation candidate ${candidate.id} is duplicated.`);
    }
    ids.add(candidate.id);
    if (!LANGUAGE_VARIANTS.includes(candidate.languageVariant)) {
      throw new Error(`Unsupported language variant ${candidate.languageVariant}.`);
    }
    eligibleCounts[candidate.languageVariant] += 1;
  }

  const ordered = shuffled(input.candidates, input.sampleSeed);
  const selected: SampleCandidate[] = [];
  const selectedIds = new Set<string>();
  const selectedCounts = emptyCounts();

  const hasRoom = (candidate: SampleCandidate): boolean =>
    selectedCounts[candidate.languageVariant] < quotas[candidate.languageVariant];
  const add = (candidate: SampleCandidate): void => {
    selected.push(candidate);
    selectedIds.add(candidate.id);
    selectedCounts[candidate.languageVariant] += 1;
  };
  const covers = (requirement: ForcedRequirement): boolean =>
    selected.some((candidate) => satisfies(candidate, requirement));
  const uniquelyCovers = (
    candidate: SampleCandidate,
    requirement: ForcedRequirement,
  ): boolean =>
    satisfies(candidate, requirement) &&
    selected.filter((entry) => satisfies(entry, requirement)).length === 1;

  for (const requirement of forcedRequirements) {
    if (covers(requirement)) continue;
    const available = ordered.filter(
      (candidate) =>
        !selectedIds.has(candidate.id) &&
        satisfies(candidate, requirement),
    );
    const direct = available.find(hasRoom);
    if (direct) {
      add(direct);
      continue;
    }

    let swapped = false;
    for (const candidate of available) {
      const victimIndex = selected.findIndex(
        (victim) =>
          victim.languageVariant === candidate.languageVariant &&
          !forcedRequirements.some((coveredRequirement) =>
            uniquelyCovers(victim, coveredRequirement),
          ),
      );
      if (victimIndex < 0) continue;
      const [victim] = selected.splice(victimIndex, 1);
      if (!victim) continue;
      selectedIds.delete(victim.id);
      add(candidate);
      swapped = true;
      break;
    }
    if (!swapped) {
      throw new Error(
        `Cannot satisfy Continuation forced coverage for ${requirement.key}.`,
      );
    }
  }

  for (const candidate of ordered) {
    if (selected.length >= total) break;
    if (!selectedIds.has(candidate.id) && hasRoom(candidate)) add(candidate);
  }
  if (selected.length !== total) {
    throw new Error(
      `Continuation sample selected ${selected.length} of ${total}; the pool is too small for the quotas.`,
    );
  }

  const forcedCoverage = {} as Record<ContinuationCoverageTag, string>;
  for (const tag of CONTINUATION_FORCED_COVERAGE) {
    const bearer = selected.find((candidate) => forcedTags(candidate).includes(tag));
    if (!bearer) {
      throw new Error(`Forced coverage ${tag} was lost during selection.`);
    }
    forcedCoverage[tag] = bearer.id;
  }
  const protectedCoverage = {} as Record<ContinuationProtectedCategory, string>;
  for (const category of CONTINUATION_PROTECTED_CATEGORIES) {
    const bearer = selected.find((candidate) => candidate.category === category);
    if (!bearer) {
      throw new Error(`Protected category ${category} was lost during selection.`);
    }
    protectedCoverage[category] = bearer.id;
  }

  return {
    eligibleCounts,
    forcedCoverage,
    protectedCoverage,
    quotas,
    sampleSeed: input.sampleSeed,
    scenarioIds: ordered
      .filter((candidate) => selectedIds.has(candidate.id))
      .map((candidate) => candidate.id),
    selectedCounts,
    strategy: "stratified-random-v1",
  };
}

export function selectFixedLanguageSample(input: {
  candidates: readonly SampleCandidate[];
  quotas: Readonly<Record<LanguageVariant, number>>;
  sampleSeed: number;
}): {
  eligibleCounts: Readonly<Record<LanguageVariant, number>>;
  quotas: Readonly<Record<LanguageVariant, number>>;
  sampleSeed: number;
  scenarioIds: readonly string[];
  selectedCounts: Readonly<Record<LanguageVariant, number>>;
  strategy: "stratified-random-v1";
} {
  if (!Number.isInteger(input.sampleSeed)) {
    throw new Error("sampleSeed must be an integer.");
  }
  validateQuotas(input.quotas, quotaTotal(input.quotas));
  const ordered = shuffled(input.candidates, input.sampleSeed);
  const eligibleCounts = emptyCounts();
  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (ids.has(candidate.id)) throw new Error(`Sample candidate ${candidate.id} is duplicated.`);
    ids.add(candidate.id);
    if (!LANGUAGE_VARIANTS.includes(candidate.languageVariant)) {
      throw new Error(`Unsupported language variant ${candidate.languageVariant}.`);
    }
    eligibleCounts[candidate.languageVariant] += 1;
  }
  const selectedCounts = emptyCounts();
  const selected: SampleCandidate[] = [];
  for (const candidate of ordered) {
    if (selectedCounts[candidate.languageVariant] >= input.quotas[candidate.languageVariant]) {
      continue;
    }
    selected.push(candidate);
    selectedCounts[candidate.languageVariant] += 1;
  }
  if (
    LANGUAGE_VARIANTS.some(
      (variant) => selectedCounts[variant] !== input.quotas[variant],
    )
  ) {
    throw new Error("The fixed-language sample cannot satisfy its quotas.");
  }
  return {
    eligibleCounts,
    quotas: input.quotas,
    sampleSeed: input.sampleSeed,
    scenarioIds: selected.map((candidate) => candidate.id),
    selectedCounts,
    strategy: "stratified-random-v1",
  };
}
