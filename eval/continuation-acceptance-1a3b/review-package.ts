import {
  F3_BIO_INSPECTION_VERSION,
  F3_CATALOG_VERSION,
  F3_LEDGER_VERSION,
  F3_PAIRWISE_PROTOCOL,
  F3_REVIEW_PACKAGE_VERSION,
  armAssignment,
  canonicalJson,
  countQuestions,
  configurationFingerprint,
  sha256,
  type BioInspectionLedger,
  type BioNaturalnessFixture,
  type ContinuationFixture,
  type Fixture,
  type FixtureCatalog,
  type InputSummary,
  type InputSummaryEntry,
  type LanguageVariant,
  type PairScenario,
  type PairwiseChoice,
  type PairwiseScores,
  type PairsFile,
  type ReviewPackage,
  type SealedIdentities,
  type SyntheticRun,
  type ValidatorAdjudicationLedger,
} from "./protocol";
import {
  verifyFixtureCatalog,
  verifyManifest,
  verifyPins,
  verifySyntheticSourceBoundary,
  type AcceptanceManifest,
} from "./manifest";
import {
  checkTurn as checkScenarioTurn,
  replayPostureActiveTurns,
} from "../scenario-pack-v3/tiered-checks";
import {
  selectContinuationSample,
  selectFixedLanguageSample,
} from "./sampling";

export type { SyntheticRun } from "./protocol";
export type PublicReviewPackage = Omit<ReviewPackage, "sealed">;

type ResponseFixture = ContinuationFixture | BioNaturalnessFixture;

function responseFixtures(
  catalog: FixtureCatalog,
  group: "continuation" | "bio_naturalness",
): readonly ResponseFixture[] {
  return catalog.scenarios.filter(
    (fixture): fixture is ResponseFixture => fixture.group === group,
  );
}

function fixtureById(
  fixtures: readonly Fixture[],
): Map<string, Fixture> {
  return new Map(fixtures.map((fixture) => [fixture.id, fixture]));
}

function expectedConfigIds(
  manifest: AcceptanceManifest,
  group: "continuation" | "bio_naturalness",
): readonly [string, string] {
  return group === "continuation"
    ? [
        manifest.pinnedConfiguration.continuation.arms.incumbent.id,
        manifest.pinnedConfiguration.continuation.arms.candidate.id,
      ]
    : [
        manifest.pinnedConfiguration.bio.configurations[0]!.id,
        manifest.pinnedConfiguration.bio.configurations[1]!.id,
      ];
}

function runScenariosById(run: SyntheticRun): Map<string, SyntheticRun["scenarios"][number]> {
  const scenarios = new Map<string, SyntheticRun["scenarios"][number]>();
  for (const scenario of run.scenarios) {
    if (scenarios.has(scenario.fixtureId)) {
      throw new Error(`${run.arm} run duplicates fixture ${scenario.fixtureId}.`);
    }
    scenarios.set(scenario.fixtureId, scenario);
  }
  return scenarios;
}

function sameInput(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export type HardGateReport = Readonly<{
  advisories: readonly string[];
  checkedFixtureCount: number;
  failures: readonly string[];
  passed: boolean;
}>;

/**
 * Run the F3 deterministic response checks over the complete candidate pool.
 *
 * #228: per-turn question counts and required-recall tokens are advisory
 * expectations for both arms. Deterministic safety/resource/punctuation
 * checks and references to never-injected memory remain hard gates.
 */
export function verifySyntheticRunHardGates(
  catalog: FixtureCatalog,
  run: SyntheticRun,
): HardGateReport {
  if (run.group !== "continuation") {
    return { advisories: [], checkedFixtureCount: 0, failures: [], passed: true };
  }
  const fixtures = catalog.scenarios.filter(
    (fixture): fixture is ContinuationFixture => fixture.group === "continuation",
  );
  const scenarios = runScenariosById(run);
  const failures: string[] = [];
  const advisories: string[] = [];
  for (const fixture of fixtures) {
    const scenario = scenarios.get(fixture.id);
    if (!scenario) {
      failures.push(`${run.arm}/${fixture.id}: missing from complete hard-gate run`);
      continue;
    }
    const postureActiveTurns = replayPostureActiveTurns(
      fixture.turns.map((fixtureTurn) => ({
        input: {
          locale: fixtureTurn.userInput.locale,
          text: fixtureTurn.userInput.text,
        },
      })),
    );
    for (const turn of scenario.turns) {
      const prefix = `${run.arm}/${fixture.id} t${turn.sequenceInScenario}`;
      if (countQuestions(turn.assistantText) > fixture.hardGate.maxQuestions) {
        advisories.push(
          `${prefix}: question_count_exceeded — response has ${countQuestions(turn.assistantText)} question(s), expected at most ${fixture.hardGate.maxQuestions}`,
        );
      }
      const fixtureTurnIndex = fixture.turns.findIndex(
        (fixtureTurn) =>
          fixtureTurn.sequenceInScenario === turn.sequenceInScenario,
      );
      const postureActive =
        fixture.category === "high_risk" ||
        postureActiveTurns[fixtureTurnIndex] === true;
      const findings = checkScenarioTurn({
        assistantText: turn.assistantText,
        forbiddenMentionTokens: fixture.hardGate.forbiddenTokens,
        languageVariant: fixture.languageVariant,
        locale: fixture.locale,
        postureActive,
        requiredRecallTokens: fixture.hardGate.requiredTokens,
        scenarioId: fixture.id,
        sequenceInScenario: turn.sequenceInScenario,
        userText: turn.userInput.text,
      }).hardGates;
      for (const finding of findings) {
        const message = `${prefix}: ${finding.gate} — ${finding.detail}`;
        failures.push(message);
      }
      for (const token of fixture.hardGate.requiredTokens) {
        if (turn.assistantText.toLowerCase().includes(token.toLowerCase())) continue;
        const message = `${prefix}: required_recall_missing — required-recall token "${token}" absent from the response`;
        advisories.push(message);
      }
    }
  }
  return {
    advisories,
    checkedFixtureCount: fixtures.length,
    failures,
    passed: failures.length === 0,
  };
}

function validateRun(
  run: SyntheticRun,
  catalog: FixtureCatalog,
  group: "continuation" | "bio_naturalness",
  pins: AcceptanceManifest["pinnedConfiguration"],
  expectedConfigIds_: readonly [string, string],
): Map<string, SyntheticRun["scenarios"][number]> {
  const sourceViolations = verifySyntheticSourceBoundary(run, `${run.arm} run`);
  if (sourceViolations.length > 0) {
    throw new Error(`Synthetic run contains a production source:
${sourceViolations.join("\n")}`);
  }
  if (run.version !== "1a3b-f3-synthetic-run:v1" || run.format !== run.version) {
    throw new Error(`${run.arm} run has an unsupported synthetic-run format.`);
  }
  if (!run.synthetic || run.sourceKind !== "synthetic-eval") {
    throw new Error(`${run.arm} run must be explicitly synthetic-eval input.`);
  }
  if (run.catalogVersion !== F3_CATALOG_VERSION || run.group !== group) {
    throw new Error(`${run.arm} run does not match the requested catalog/group.`);
  }
  if (!expectedConfigIds_.includes(run.configId)) {
    throw new Error(`${run.arm} run config ${run.configId} is not pinned for ${group}.`);
  }
  if (
    run.configurationFingerprint !==
    configurationFingerprint(pins, group, run.configId)
  ) {
    throw new Error(`${run.arm} run configuration fingerprint differs from the pinned configuration.`);
  }
  const fixtures = responseFixtures(catalog, group);
  const expected = fixtureById(fixtures);
  const scenarios = runScenariosById(run);
  if (scenarios.size !== fixtures.length) {
    throw new Error(`${run.arm} run must contain the complete ${group} fixture pool.`);
  }
  for (const fixture of fixtures) {
    const scenario = scenarios.get(fixture.id);
    if (!scenario) throw new Error(`${run.arm} run is missing ${fixture.id}.`);
    const expectedFixture = expected.get(fixture.id)! as ResponseFixture;
    if (scenario.turns.length !== expectedFixture.turns.length) {
      throw new Error(`${run.arm}/${fixture.id} has a different turn count.`);
    }
    const sharedInput = catalog.sharedInputs[expectedFixture.inputRef];
    if (!sharedInput) {
      throw new Error(`${fixture.id} references a missing shared input.`);
    }
    if (scenario.sharedInputFingerprint !== sha256(sharedInput)) {
      throw new Error(`${run.arm}/${fixture.id} shared input fingerprint differs from the frozen fixture.`);
    }
    const expectedPromptFingerprint =
      group === "bio_naturalness" && expectedFixture.group === "bio_naturalness"
        ? sha256(expectedFixture.prompt)
        : null;
    if (scenario.promptFingerprint !== expectedPromptFingerprint) {
      throw new Error(`${run.arm}/${fixture.id} prompt fingerprint differs from the frozen fixture.`);
    }
    const expectedTurns = new Map(
      expectedFixture.turns.map((turn) => [turn.sequenceInScenario, turn]),
    );
    const seenTurns = new Set<number>();
    for (const turn of scenario.turns) {
      if (seenTurns.has(turn.sequenceInScenario)) {
        throw new Error(`${run.arm}/${fixture.id} duplicates turn ${turn.sequenceInScenario}.`);
      }
      seenTurns.add(turn.sequenceInScenario);
      const expectedTurn = expectedTurns.get(turn.sequenceInScenario);
      if (!expectedTurn) throw new Error(`${run.arm}/${fixture.id} has an unknown turn.`);
      if (!sameInput(turn.userInput, expectedTurn.userInput)) {
        throw new Error(`${run.arm}/${fixture.id} user input differs from the frozen fixture.`);
      }
      if (turn.assistantText.trim().length === 0) {
        throw new Error(`${run.arm}/${fixture.id} has an empty response.`);
      }
    }
  }
  return scenarios;
}

export function validateContinuationSyntheticRun(input: Readonly<{
  catalog: FixtureCatalog;
  pins: AcceptanceManifest["pinnedConfiguration"];
  run: SyntheticRun;
}>): void {
  validateRun(input.run, input.catalog, "continuation", input.pins, [
    input.pins.continuation.arms.incumbent.id,
    input.pins.continuation.arms.candidate.id,
  ]);
}

function inputSummaryEntry(
  fixture: ResponseFixture,
  sharedInput: FixtureCatalog["sharedInputs"][string],
  group: "continuation" | "bio_naturalness",
): InputSummaryEntry {
  const components = {
    conversation: sha256(sharedInput.config.conversation),
    events: sha256(sharedInput.events),
    locale: sha256(sharedInput.config.locale),
    memory: sha256(sharedInput.memory),
    persona: sha256(sharedInput.config.persona),
    portrait: sha256(sharedInput.portrait),
    retrieval: sha256(sharedInput.retrieval),
    safety: sha256(sharedInput.config.safety),
  };
  return {
    fixtureId: fixture.id,
    intentionalDifference:
      group === "continuation"
        ? {
            keys: ["open_loop_bundle", "proactive_bundle"],
            statement:
              "Both arms use this exact frozen input; only the Open Loop / Proactive bundle may differ.",
          }
        : {
            keys: ["bio_writer_configuration", "validator_configuration"],
            statement:
              "Both arms use this exact frozen input; only the complete Bio writer/validator configuration may differ.",
          },
    sharedInput: {
      components,
      fingerprint: sha256(sharedInput),
    },
  };
}

function expectedSampleIds(
  catalog: FixtureCatalog,
  manifest: AcceptanceManifest,
  group: "continuation" | "bio_naturalness",
): readonly string[] {
  if (group === "continuation") {
    return selectContinuationSample({
      candidates: catalog.scenarios
        .filter((fixture): fixture is ContinuationFixture => fixture.group === "continuation")
        .map((fixture) => ({
          category: fixture.category,
          coverageTags: fixture.coverageTags,
          id: fixture.id,
          languageVariant: fixture.languageVariant,
        })),
      sampleSeed: manifest.sampleSeed,
    }).scenarioIds;
  }
  return selectFixedLanguageSample({
    candidates: catalog.scenarios
      .filter((fixture): fixture is BioNaturalnessFixture => fixture.group === "bio_naturalness")
      .map((fixture) => ({
        category: fixture.category,
        coverageTags: [],
        id: fixture.id,
        languageVariant: fixture.languageVariant,
      })),
    quotas: manifest.bio.sampleQuotas,
    sampleSeed: manifest.sampleSeed,
  }).scenarioIds;
}

function pairScenario(
  fixture: ResponseFixture,
  firstRunScenario: SyntheticRun["scenarios"][number],
  secondRunScenario: SyntheticRun["scenarios"][number],
  firstIsA: boolean,
): PairScenario {
  const firstByTurn = new Map(
    firstRunScenario.turns.map((turn) => [turn.sequenceInScenario, turn]),
  );
  const secondByTurn = new Map(
    secondRunScenario.turns.map((turn) => [turn.sequenceInScenario, turn]),
  );
  return {
    category: fixture.category,
    coverageTags: fixture.group === "continuation" ? fixture.coverageTags : [],
    description: fixture.description,
    languageVariant: fixture.languageVariant,
    scenarioId: fixture.id,
    turns: fixture.turns.map((fixtureTurn) => {
      const first = firstByTurn.get(fixtureTurn.sequenceInScenario)!;
      const second = secondByTurn.get(fixtureTurn.sequenceInScenario)!;
      return {
        responseA: firstIsA ? first.assistantText : second.assistantText,
        responseB: firstIsA ? second.assistantText : first.assistantText,
        sequenceInScenario: fixtureTurn.sequenceInScenario,
        userInput: fixtureTurn.userInput,
      };
    }),
  };
}

function deterministicPackagePayload(
  package_: Omit<ReviewPackage, "packageFingerprint">,
): unknown {
  return {
    ...package_,
    pairs: { ...package_.pairs, generatedAt: "volatile" },
    sealed: { ...package_.sealed, generatedAt: "volatile" },
  };
}

export type BuildReviewPackageInput = Readonly<{
  baselineRun: SyntheticRun;
  candidateRun: SyntheticRun;
  catalog: FixtureCatalog;
  createdAt?: string;
  group: "continuation" | "bio_naturalness";
  manifest: AcceptanceManifest;
}>;

/**
 * Build a blinded F3 package from two synthetic runs. The complete pool is
 * checked first; only the declared human-review sample is then paired.
 */
export function buildReviewPackage(input: BuildReviewPackageInput): ReviewPackage {
  const catalogVerification = verifyFixtureCatalog(input.catalog);
  if (!catalogVerification.passed) {
    throw new Error(`Cannot build review package:\n${catalogVerification.mismatches.join("\n")}`);
  }
  const manifestVerification = verifyManifest(input.manifest);
  if (!manifestVerification.passed) {
    throw new Error(`Manifest verification failed: ${manifestVerification.mismatches.join("; ")}`);
  }
  if (!input.manifest.comparisonAllowed) {
    throw new Error("A clean incumbent rebaseline is required before pairing.");
  }
  if (sha256(input.catalog) !== input.manifest.catalog.sha256) {
    throw new Error("The catalog hash does not match the manifest.");
  }
  if (sha256(input.manifest.pinnedConfiguration) !== input.manifest.pins.sha256) {
    throw new Error("The pin hash does not match the manifest.");
  }
  const pinsVerification = verifyPins(input.manifest.pinnedConfiguration);
  if (!pinsVerification.passed) {
    throw new Error(`Pin verification failed: ${pinsVerification.mismatches.join("; ")}`);
  }
  const expectedConfigIds_ = expectedConfigIds(input.manifest, input.group);
  if (
    input.baselineRun.configId !== expectedConfigIds_[0] ||
    input.candidateRun.configId !== expectedConfigIds_[1]
  ) {
    throw new Error(
      `Review runs must be ordered as baseline ${expectedConfigIds_[0]} then candidate ${expectedConfigIds_[1]}.`,
    );
  }
  const first = validateRun(
    input.baselineRun,
    input.catalog,
    input.group,
    input.manifest.pinnedConfiguration,
    expectedConfigIds_,
  );
  const second = validateRun(
    input.candidateRun,
    input.catalog,
    input.group,
    input.manifest.pinnedConfiguration,
    expectedConfigIds_,
  );
  if (input.baselineRun.configId === input.candidateRun.configId) {
    throw new Error("The two review arms must use different complete configurations.");
  }

  const firstHardGates = verifySyntheticRunHardGates(input.catalog, input.baselineRun);
  const secondHardGates = verifySyntheticRunHardGates(input.catalog, input.candidateRun);
  const hardGateReport: HardGateReport = {
    advisories: [
      ...firstHardGates.advisories,
      ...secondHardGates.advisories,
    ],
    checkedFixtureCount: firstHardGates.checkedFixtureCount,
    failures: [...firstHardGates.failures, ...secondHardGates.failures],
    passed: firstHardGates.passed && secondHardGates.passed,
  };
  if (!hardGateReport.passed) {
    throw new Error(`Synthetic hard gates failed:\n${hardGateReport.failures.join("\n")}`);
  }

  const fixtures = responseFixtures(input.catalog, input.group);
  const selectedIds =
    input.group === "continuation"
      ? input.manifest.continuation.sample.scenarioIds
      : input.manifest.bio.sampleIds;
  if (canonicalJson(selectedIds) !== canonicalJson(expectedSampleIds(input.catalog, input.manifest, input.group))) {
    throw new Error("Review sample does not match the manifest's deterministic selection.");
  }
  const selectedSet = new Set(selectedIds);
  if (selectedSet.size !== selectedIds.length) throw new Error("Review sample contains duplicate fixture IDs.");
  const selectedFixtures = selectedIds.map((id) => {
    const fixture = fixtures.find((entry) => entry.id === id);
    if (!fixture) throw new Error(`Review sample references unknown fixture ${id}.`);
    return fixture;
  });
  const generatedAt = input.createdAt ?? new Date().toISOString();
  const mapping: Record<string, { A: string; B: string }> = {};
  const pairs: PairScenario[] = [];
  const inputEntries: InputSummaryEntry[] = [];
  for (const [ordinal, fixture] of selectedFixtures.entries()) {
    const firstIsA = armAssignment(input.manifest.fixtureSeed, ordinal) === "A";
    mapping[fixture.id] = firstIsA
      ? { A: input.baselineRun.configId, B: input.candidateRun.configId }
      : { A: input.candidateRun.configId, B: input.baselineRun.configId };
    pairs.push(
      pairScenario(
        fixture,
        first.get(fixture.id)!,
        second.get(fixture.id)!,
        firstIsA,
      ),
    );
    const sharedInput = input.catalog.sharedInputs[fixture.inputRef];
    if (!sharedInput) throw new Error(`Missing shared input ${fixture.inputRef}.`);
    inputEntries.push(inputSummaryEntry(fixture, sharedInput, input.group));
  }

  const excludedScenarios = fixtures
    .filter((fixture) => !selectedSet.has(fixture.id))
    .map((fixture) => ({
      id: fixture.id,
      reason: "not selected for the declared human-review sample; full pool was hard-gate checked",
    }));
  const eligibleCounts =
    input.group === "continuation"
      ? input.manifest.continuation.sample.eligibleCounts
      : { code_switch: 5, en: 5, zh: 5 };
  const quotas =
    input.group === "continuation"
      ? input.manifest.continuation.sample.quotas
      : input.manifest.bio.sampleQuotas;
  const selectedCounts =
    input.group === "continuation"
      ? input.manifest.continuation.sample.selectedCounts
      : quotas;
  const protectedCoverage =
    input.group === "continuation"
      ? input.manifest.continuation.sample.protectedCoverage
      : {};
  const pairsFile: PairsFile = {
    baselineSource: "synthetic blinded arm A",
    candidateSource: "synthetic blinded arm B",
    excludedScenarios,
    excludedTurns: [],
    generatedAt,
    protocol: F3_PAIRWISE_PROTOCOL,
    sampling: {
      eligibleCounts,
      protectedCoverage,
      quotas,
      sampleSeed: input.manifest.sampleSeed,
      selectedCounts,
      strategy: "stratified-random-v1",
    },
    scenarios: pairs,
    seed: input.manifest.fixtureSeed,
  };
  const sealed: SealedIdentities = {
    armOrder: [input.baselineRun.configId, input.candidateRun.configId],
    generatedAt,
    mapping,
    protocol: F3_PAIRWISE_PROTOCOL,
    seed: input.manifest.fixtureSeed,
  };
  const inputSummary: InputSummary = {
    catalogVersion: input.catalog.version,
    entries: inputEntries,
    group: input.group,
    version: "1a3b-f3-input-summary:v1",
  };
  const withoutFingerprint: Omit<ReviewPackage, "packageFingerprint"> = {
    hardGateReport,
    inputSummary,
    manifestFingerprint: input.manifest.fingerprint,
    pairs: pairsFile,
    sealed,
    version: F3_REVIEW_PACKAGE_VERSION,
  };
  return {
    ...withoutFingerprint,
    packageFingerprint: sha256(deterministicPackagePayload(withoutFingerprint)),
  };
}

function validateScores(
  scores: PairwiseScores,
  pairs: PairsFile,
): Map<string, PairwiseScores["scenarios"][number]> {
  if (
    scores.protocol !== F3_PAIRWISE_PROTOCOL ||
    scores.scorer.trim() !== "Luke" ||
    scores.scoredAt.trim().length === 0
  ) {
    throw new Error("Pairwise scores must be a dated Luke adjudication using the frozen protocol.");
  }
  const pairsById = new Map(pairs.scenarios.map((scenario) => [scenario.scenarioId, scenario]));
  const scored = new Map<string, PairwiseScores["scenarios"][number]>();
  for (const entry of scores.scenarios) {
    if (scored.has(entry.scenarioId)) throw new Error(`Scores duplicate ${entry.scenarioId}.`);
    const pair = pairsById.get(entry.scenarioId);
    if (!pair) throw new Error(`Scores reference unknown ${entry.scenarioId}.`);
    if (!["A", "tie", "B"].includes(entry.overallChoice)) {
      throw new Error(`Scores have an invalid overall choice for ${entry.scenarioId}.`);
    }
    const turns = new Map<number, PairwiseChoice>();
    for (const turn of entry.turns) {
      if (turns.has(turn.sequenceInScenario)) throw new Error(`Scores duplicate ${entry.scenarioId} turn.`);
      if (!pair.turns.some((candidate) => candidate.sequenceInScenario === turn.sequenceInScenario)) {
        throw new Error(`Scores reference an unknown turn in ${entry.scenarioId}.`);
      }
      if (!["A", "tie", "B"].includes(turn.choice)) throw new Error("Scores have an invalid turn choice.");
      turns.set(turn.sequenceInScenario, turn.choice);
    }
    for (const turn of pair.turns) {
      if (!turns.has(turn.sequenceInScenario)) {
        throw new Error(`Review package is only partially scored: ${entry.scenarioId}.`);
      }
    }
    scored.set(entry.scenarioId, entry);
  }
  for (const pair of pairs.scenarios) {
    if (!scored.has(pair.scenarioId)) {
      throw new Error(`Review package has an unscored fixture: ${pair.scenarioId}.`);
    }
  }
  return scored;
}

export type BioInspectionReport = Readonly<{
  completed: boolean;
  configurationId: string | null;
  inspectedFixtureCount: number;
  passed: boolean;
  unacceptableFixtureIds: readonly string[];
}>;

/** Validate Luke's fixed-sample Bio inspection after pairwise identities are revealed. */
export function validateBioInspection(input: {
  package: ReviewPackage;
  ledger?: BioInspectionLedger;
}): BioInspectionReport {
  const expectedFixtureIds = input.package.pairs.scenarios.map(
    (scenario) => scenario.scenarioId,
  );
  if (!input.ledger) {
    return {
      completed: false,
      configurationId: null,
      inspectedFixtureCount: 0,
      passed: false,
      unacceptableFixtureIds: [],
    };
  }
  const sourceViolations = verifySyntheticSourceBoundary(
    input.ledger,
    "Bio inspection ledger",
  );
  if (sourceViolations.length > 0) {
    throw new Error(`Bio inspection ledger contains a production source:\n${sourceViolations.join("\n")}`);
  }
  if (
    input.ledger.version !== F3_BIO_INSPECTION_VERSION ||
    input.ledger.group !== "bio_naturalness" ||
    input.ledger.manifestFingerprint !== input.package.manifestFingerprint ||
    input.ledger.reviewPackageFingerprint !== input.package.packageFingerprint
  ) {
    throw new Error("Bio inspection ledger does not belong to this review package.");
  }
  if (
    input.ledger.adjudicator !== "Luke" ||
    input.ledger.decidedAt.trim().length === 0 ||
    !input.package.sealed.armOrder.includes(input.ledger.configurationId)
  ) {
    throw new Error("Bio inspection ledger must be a dated Luke ruling for one revealed arm.");
  }
  const expected = new Set(expectedFixtureIds);
  const seen = new Set<string>();
  const unacceptableFixtureIds: string[] = [];
  for (const entry of input.ledger.entries) {
    if (!expected.has(entry.fixtureId)) {
      throw new Error(`Bio inspection ledger references unknown fixture ${entry.fixtureId}.`);
    }
    if (seen.has(entry.fixtureId)) {
      throw new Error(`Bio inspection ledger duplicates ${entry.fixtureId}.`);
    }
    if (entry.verdict !== "acceptable" && entry.verdict !== "unacceptable") {
      throw new Error(`Bio inspection ledger has an invalid verdict for ${entry.fixtureId}.`);
    }
    seen.add(entry.fixtureId);
    if (entry.verdict === "unacceptable") unacceptableFixtureIds.push(entry.fixtureId);
  }
  if (seen.size !== expected.size) {
    const missing = expectedFixtureIds.filter((fixtureId) => !seen.has(fixtureId));
    throw new Error(`Bio inspection ledger is missing ${missing.join(", ")}.`);
  }
  return {
    completed: true,
    configurationId: input.ledger.configurationId,
    inspectedFixtureCount: seen.size,
    passed: unacceptableFixtureIds.length === 0,
    unacceptableFixtureIds,
  };
}

type ChoiceSummary = Readonly<{
  byArm: Readonly<Record<string, number>>;
  comparisons: number;
  tie: number;
}>;

function emptyChoiceSummary(arms: readonly string[]): { byArm: Record<string, number>; tie: number; comparisons: number } {
  return {
    byArm: Object.fromEntries(arms.map((arm) => [arm, 0])),
    comparisons: 0,
    tie: 0,
  };
}

function summarizeChoices(
  pairs: readonly PairScenario[],
  scores: Map<string, PairwiseScores["scenarios"][number]>,
  sealed: SealedIdentities,
  arms: readonly string[],
  filter: (pair: PairScenario) => boolean,
  level: "scenarios" | "turns",
): ChoiceSummary {
  const summary = emptyChoiceSummary(arms);
  for (const pair of pairs) {
    if (!filter(pair)) continue;
    const scored = scores.get(pair.scenarioId)!;
    const choices = level === "scenarios"
      ? [scored.overallChoice]
      : scored.turns.map((turn) => turn.choice);
    for (const choice of choices) {
      summary.comparisons += 1;
      if (choice === "tie") {
        summary.tie += 1;
      } else {
        const assignment = sealed.mapping[pair.scenarioId];
        if (!assignment) throw new Error(`Missing sealed identity for ${pair.scenarioId}.`);
        const arm = assignment[choice];
        if (!arm) throw new Error(`Missing sealed arm for ${pair.scenarioId}.`);
        summary.byArm[arm] = (summary.byArm[arm] ?? 0) + 1;
      }
    }
  }
  return summary;
}

export type UnblindedReviewResult = Readonly<{
  gate: Readonly<Record<string, unknown>>;
  group: "continuation" | "bio_naturalness";
  manifestFingerprint: string;
  pairwise: Readonly<{
    overall: Readonly<{ scenarios: ChoiceSummary; turns: ChoiceSummary }>;
    perLanguage: Readonly<Record<LanguageVariant, Readonly<{ scenarios: ChoiceSummary; turns: ChoiceSummary }>>>;
  }>;
  revealed: true;
  revealedAt: string;
  reviewPackageFingerprint: string;
  identities: SealedIdentities["mapping"];
}>;

/** Return the portion safe to hand to the blinded reviewer. */
export function toPublicReviewPackage(
  package_: ReviewPackage,
): PublicReviewPackage {
  const { sealed: _sealed, ...publicPackage } = package_;
  return publicPackage;
}

/** Reveal a completed human score file and only then calculate arm-level results. */
export function unblindReviewPackage(input: {
  bioInspection?: BioInspectionLedger;
  package: ReviewPackage;
  scores: PairwiseScores;
}): UnblindedReviewResult {
  const expectedFingerprint = sha256(deterministicPackagePayload({
    hardGateReport: input.package.hardGateReport,
    inputSummary: input.package.inputSummary,
    manifestFingerprint: input.package.manifestFingerprint,
    pairs: input.package.pairs,
    sealed: input.package.sealed,
    version: input.package.version,
  }));
  if (input.package.packageFingerprint !== expectedFingerprint) {
    throw new Error("Review package fingerprint does not match its contents.");
  }
  if (!input.package.hardGateReport.passed) {
    throw new Error("Cannot reveal a package with failed deterministic hard gates.");
  }
  const scored = validateScores(input.scores, input.package.pairs);
  if (
    input.package.sealed.armOrder.length !== 2 ||
    new Set(input.package.sealed.armOrder).size !== 2
  ) {
    throw new Error("Review package must seal exactly two distinct arm identities.");
  }
  const arms = Object.values(input.package.sealed.mapping).flatMap((mapping) => [mapping.A, mapping.B]);
  const uniqueArms = [...new Set(arms)];
  if (
    uniqueArms.length !== 2 ||
    uniqueArms.some((arm) => !input.package.sealed.armOrder.includes(arm))
  ) {
    throw new Error("Sealed mappings do not match the two review arms.");
  }
  for (const pair of input.package.pairs.scenarios) {
    const mapping = input.package.sealed.mapping[pair.scenarioId];
    if (!mapping || mapping.A === mapping.B) {
      throw new Error(`Sealed mapping is incomplete for ${pair.scenarioId}.`);
    }
    if (
      new Set([mapping.A, mapping.B]).size !== 2 ||
      !input.package.sealed.armOrder.includes(mapping.A) ||
      !input.package.sealed.armOrder.includes(mapping.B)
    ) {
      throw new Error(`Sealed mapping has an unknown arm for ${pair.scenarioId}.`);
    }
  }
  const perLanguage = Object.fromEntries(
    (["en", "zh", "code_switch"] as const).map((language) => [
      language,
      {
        scenarios: summarizeChoices(
          input.package.pairs.scenarios,
          scored,
          input.package.sealed,
          uniqueArms,
          (pair) => pair.languageVariant === language,
          "scenarios",
        ),
        turns: summarizeChoices(
          input.package.pairs.scenarios,
          scored,
          input.package.sealed,
          uniqueArms,
          (pair) => pair.languageVariant === language,
          "turns",
        ),
      },
    ]),
  ) as Record<LanguageVariant, { scenarios: ChoiceSummary; turns: ChoiceSummary }>;
  const overall = {
    scenarios: summarizeChoices(
      input.package.pairs.scenarios,
      scored,
      input.package.sealed,
      uniqueArms,
      () => true,
      "scenarios",
    ),
    turns: summarizeChoices(
      input.package.pairs.scenarios,
      scored,
      input.package.sealed,
      uniqueArms,
      () => true,
      "turns",
    ),
  };
  const [baselineArm, candidateArm] = input.package.sealed.armOrder;
  const bioInspection =
    input.package.inputSummary.group === "bio_naturalness"
      ? validateBioInspection({
          ...(input.bioInspection ? { ledger: input.bioInspection } : {}),
          package: input.package,
        })
      : null;
  const localeRegressions = (["en", "zh", "code_switch"] as const).flatMap(
    (language) => {
      const summary = perLanguage[language].scenarios;
      return (summary.byArm[candidateArm!] ?? 0) - (summary.byArm[baselineArm!] ?? 0) < 0
        ? [`${language}: candidate arm net preference is negative`]
        : [];
    },
  );
  const result: UnblindedReviewResult = {
    gate:
      input.package.inputSummary.group === "continuation"
        ? {
            candidateStrictlyPreferredOverall: {
              passed:
                (overall.scenarios.byArm[candidateArm!] ?? 0) -
                  (overall.scenarios.byArm[baselineArm!] ?? 0) >
                0,
              rule: "candidate scenario-level net preference must be strictly positive; inspect by revealed candidate arm",
            },
            localeNoRegression: {
              passed: localeRegressions.length === 0,
              regressions: localeRegressions,
            },
            protectedCategoryNoRegression: (() => {
              const regressions = Object.entries(
                input.package.pairs.sampling.protectedCoverage,
              ).flatMap(([category, fixtureId]) => {
                const categoryPairs = input.package.pairs.scenarios.filter(
                  (pair) =>
                    pair.category === category ||
                    pair.coverageTags.includes(category),
                );
                if (
                  categoryPairs.length === 0 ||
                  fixtureId.length === 0 ||
                  !categoryPairs.some((pair) => pair.scenarioId === fixtureId)
                ) {
                  return [`${category}: protected fixture is absent from the review sample`];
                }
                const summary = summarizeChoices(
                  categoryPairs,
                  scored,
                  input.package.sealed,
                  uniqueArms,
                  () => true,
                  "scenarios",
                );
                return (summary.byArm[candidateArm!] ?? 0) -
                  (summary.byArm[baselineArm!] ?? 0) <
                  0
                  ? [`${category}: candidate arm net preference is negative`]
                  : [];
              });
              return { passed: regressions.length === 0, regressions };
            })(),
            humanTasteIsAuthoritative: true,
          }
        : {
            automaticWinner: null,
            humanFixedSampleInspection: bioInspection,
            humanFixedSampleInspectionRequired: true,
          },
    group: input.package.inputSummary.group,
    identities: input.package.sealed.mapping,
    manifestFingerprint: input.package.manifestFingerprint,
    pairwise: { overall, perLanguage },
    revealed: true,
    revealedAt: new Date().toISOString(),
    reviewPackageFingerprint: input.package.packageFingerprint,
  };
  return result;
}

/** Validate the separate 18-case validator ledger; this never auto-accepts a case. */
export function validateValidatorLedger(input: {
  catalog: FixtureCatalog;
  ledger: ValidatorAdjudicationLedger;
}): Readonly<{ accepted: number; maxRejects: number; rejected: number; total: number }> {
  const sourceViolations = verifySyntheticSourceBoundary(input.ledger, "validator ledger");
  if (sourceViolations.length > 0) {
    throw new Error(`Validator ledger contains a production source:\n${sourceViolations.join("\n")}`);
  }
  const catalogVerification = verifyFixtureCatalog(input.catalog);
  if (!catalogVerification.passed) throw new Error("The fixture catalog is invalid.");
  if (input.ledger.version !== F3_LEDGER_VERSION || input.ledger.group !== "validator") {
    throw new Error("Validator ledger has an unsupported version or group.");
  }
  if (input.ledger.adjudicator !== "Luke" || input.ledger.decidedAt.trim().length === 0) {
    throw new Error("Validator ledger must record Luke's dated adjudication.");
  }
  const fixtures = input.catalog.scenarios.filter((fixture) => fixture.group === "validator");
  const expected = new Set(fixtures.map((fixture) => fixture.id));
  const seen = new Set<string>();
  let accepted = 0;
  let rejected = 0;
  for (const entry of input.ledger.entries) {
    if (!expected.has(entry.fixtureId)) throw new Error(`Ledger references unknown fixture ${entry.fixtureId}.`);
    if (seen.has(entry.fixtureId)) throw new Error(`Ledger duplicates ${entry.fixtureId}.`);
    if (entry.verdict !== "accepted" && entry.verdict !== "rejected") throw new Error("Ledger has an invalid verdict.");
    if ("machineVerdict" in entry) throw new Error("Machine verdicts cannot replace Luke's adjudication.");
    seen.add(entry.fixtureId);
    if (entry.verdict === "accepted") accepted += 1;
    else rejected += 1;
  }
  if (seen.size !== expected.size) {
    const missing = fixtures.filter((fixture) => !seen.has(fixture.id)).map((fixture) => fixture.id);
    throw new Error(`Validator ledger is missing ${missing.join(", ")}.`);
  }
  const maxRejects = input.ledger.maxRejects ?? 0;
  if (!Number.isInteger(maxRejects) || maxRejects < 0) {
    throw new Error("Validator ledger maxRejects must be a non-negative integer.");
  }
  if (maxRejects > Math.floor(seen.size * 0.1)) {
    throw new Error(`Validator ledger maxRejects ${maxRejects} exceeds the 10% error budget.`);
  }
  return { accepted, maxRejects, rejected, total: seen.size };
}
