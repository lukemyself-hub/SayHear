/**
 * Issue #207 G2 v2 blind review package builder.
 *
 * Turns the captured ON/OFF arm runs plus the treatment ledger into the files
 * the human blind-pairwise page consumes. The builder is fail-closed: it does
 * not write any output unless the v2 treatment verifier and the pool-coverage
 * checks both report zero failures.
 *
 * Usage:
 *   pnpm exec tsx eval/continuation-acceptance-1a3b/build-review-package-v2.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { BLIND_PAIRWISE_PROTOCOL_V2 } from "../blind-pairwise/protocol";
import {
  LANGUAGE_VARIANTS,
  armAssignment,
  sha256,
  shuffled,
  type LanguageVariant,
} from "./protocol";
import {
  F3_V2_PACKAGE_VERSION,
  v2ConfigurationFingerprint,
  type V2ArmRun,
  type V2CatalogManifest,
  type V2Family,
  type V2MainRun,
  type V2Pins,
  type V2Scene,
  type V2SceneFile,
  type V2TreatmentLedger,
} from "./protocol-v2";
import { verifyV2Catalog } from "./verify-fixtures-v2";
import { verifyG2PoolCoverage, verifyG2Treatment } from "./verify-g2-treatment";

export const V2_REVIEW_SAMPLE_SIZE = 15;

export const V2_REVIEW_LANGUAGE_QUOTAS: Readonly<Record<LanguageVariant, number>> =
  Object.freeze({ code_switch: 2, en: 8, zh: 5 });

export const V2_REVIEW_FAMILY_MINIMUMS = Object.freeze({
  competing_pool: 2,
  positive_memory: 4,
  positive_open_loop: 4,
  stateful_suppression: 3,
} as const);

/**
 * Protected categories that must be visible in the sample. `short_answers`
 * is the blind-pairwise name; the v2 fixture category is `short_answer`, so
 * the matcher normalizes the plural alias.
 */
export const V2_REVIEW_PROTECTED_REQUIREMENTS = Object.freeze([
  "refusal",
  "short_answers",
  "topic_change",
  "direct_task",
] as const);

export const V2_REVIEW_TOPIC_CAP = 3;

const PROTECTED_CATEGORY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  short_answers: "short_answer",
});

type ContextPanelItem = Readonly<{
  kind: "memory_claim" | "portrait" | "open_loop";
  label: string;
  text: string;
}>;

type ContextPanel = Readonly<{ items: readonly ContextPanelItem[] }>;

type ReviewTurn = Readonly<{
  sequenceInScenario: number;
  userInput: Readonly<{ locale: string; text: string; timezone: string }>;
  responseA: string;
  responseB: string;
  timeContext: Readonly<{ currentDate: string; elapsedDays: number }>;
}>;

type ReviewScenario = Readonly<{
  scenarioId: string;
  languageVariant: LanguageVariant;
  contextPanel: ContextPanel;
  turns: readonly ReviewTurn[];
}>;

type ReviewPairScenario = Readonly<{
  /** Neutral, arm-blind context that existed before the case started. */
  contextPanel: ContextPanel;
  offIsA: boolean;
  /** 0-based position among the selected scenes, kept for provenance. */
  selectedIndex: number;
  /** 0-based position in the seeded candidate order; the arm draw ordinal. */
  poolOrdinal: number;
  scene: V2Scene;
}>;

type Arguments = Readonly<{
  catalogPath: string;
  fixtureSeed: number;
  ledgerPath: string;
  mainRunPath: string;
  offRunPath: string;
  onRunPath: string;
  outDir: string;
  pinsPath: string;
  sampleSeed: number;
}>;

function required(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function parseSeed(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer.`);
  return parsed;
}

function parseArguments(arguments_: readonly string[]): Arguments {
  const values = {
    catalogPath: "eval/continuation-acceptance-1a3b/fixtures-v2.json",
    fixtureSeed: 207,
    ledgerPath: "eval/continuation-acceptance-1a3b/run-v2/treatment-ledger.json",
    mainRunPath: "eval/continuation-acceptance-1a3b/run-v2/continuation-main.json",
    offRunPath: "eval/continuation-acceptance-1a3b/run-v2/continuation-off.json",
    onRunPath: "eval/continuation-acceptance-1a3b/run-v2/continuation-on.json",
    outDir: "eval/continuation-acceptance-1a3b/run-v2/review",
    pinsPath: "eval/continuation-acceptance-1a3b/pins-v2.json",
    sampleSeed: 207,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--on-run") values.onRunPath = required(arguments_, ++index, argument);
    else if (argument === "--off-run") values.offRunPath = required(arguments_, ++index, argument);
    else if (argument === "--main-run") values.mainRunPath = required(arguments_, ++index, argument);
    else if (argument === "--ledger") values.ledgerPath = required(arguments_, ++index, argument);
    else if (argument === "--catalog") values.catalogPath = required(arguments_, ++index, argument);
    else if (argument === "--pins") values.pinsPath = required(arguments_, ++index, argument);
    else if (argument === "--out") values.outDir = required(arguments_, ++index, argument);
    else if (argument === "--sample-seed") {
      values.sampleSeed = parseSeed(required(arguments_, ++index, argument), argument);
    } else if (argument === "--fixture-seed") {
      values.fixtureSeed = parseSeed(required(arguments_, ++index, argument), argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return values;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function matchesProtected(scene: V2Scene, requirement: string): boolean {
  const categories = scene.protectedCategories as readonly string[];
  const alias = PROTECTED_CATEGORY_ALIASES[requirement] ?? requirement;
  return categories.includes(requirement) || categories.includes(alias);
}

function countValues<T extends string>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function countsRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function satisfiesSelection(selection: readonly V2Scene[]): boolean {
  if (selection.length !== V2_REVIEW_SAMPLE_SIZE) return false;
  for (const variant of LANGUAGE_VARIANTS) {
    const count = selection.filter((scene) => scene.languageVariant === variant).length;
    if (count !== V2_REVIEW_LANGUAGE_QUOTAS[variant]) return false;
  }
  for (const family of Object.keys(V2_REVIEW_FAMILY_MINIMUMS) as (keyof typeof V2_REVIEW_FAMILY_MINIMUMS)[]) {
    const count = selection.filter((scene) => scene.family === family).length;
    if (count < V2_REVIEW_FAMILY_MINIMUMS[family]) return false;
  }
  for (const requirement of V2_REVIEW_PROTECTED_REQUIREMENTS) {
    if (!selection.some((scene) => matchesProtected(scene, requirement))) return false;
  }
  const topics = countValues(selection.map((scene) => scene.topic));
  for (const count of topics.values()) {
    if (count > V2_REVIEW_TOPIC_CAP) return false;
  }
  return true;
}

function selectionFailureReasons(candidates: readonly V2Scene[]): readonly string[] {
  const reasons: string[] = [];
  if (candidates.length < V2_REVIEW_SAMPLE_SIZE) {
    reasons.push(`candidate pool has ${candidates.length} scenes; need ${V2_REVIEW_SAMPLE_SIZE}`);
  }
  for (const variant of LANGUAGE_VARIANTS) {
    const available = candidates.filter((scene) => scene.languageVariant === variant).length;
    const quota = V2_REVIEW_LANGUAGE_QUOTAS[variant];
    if (available < quota) {
      reasons.push(`language ${variant}: ${available} candidates available, quota ${quota}`);
    }
  }
  for (const family of Object.keys(V2_REVIEW_FAMILY_MINIMUMS) as (keyof typeof V2_REVIEW_FAMILY_MINIMUMS)[]) {
    const available = candidates.filter((scene) => scene.family === family).length;
    const minimum = V2_REVIEW_FAMILY_MINIMUMS[family];
    if (available < minimum) {
      reasons.push(`family ${family}: ${available} candidates available, minimum ${minimum}`);
    }
  }
  for (const requirement of V2_REVIEW_PROTECTED_REQUIREMENTS) {
    const available = candidates.filter((scene) => matchesProtected(scene, requirement)).length;
    if (available === 0) {
      reasons.push(`protected category ${requirement}: no candidate covers it`);
    }
  }
  const topics = countValues(candidates.map((scene) => scene.topic));
  const cappedTotal = [...topics.values()].reduce(
    (total, count) => total + Math.min(count, V2_REVIEW_TOPIC_CAP),
    0,
  );
  if (cappedTotal < V2_REVIEW_SAMPLE_SIZE) {
    reasons.push(
      `topic cap ${V2_REVIEW_TOPIC_CAP} allows at most ${cappedTotal} scenes; need ${V2_REVIEW_SAMPLE_SIZE}`,
    );
  }
  if (reasons.length === 0) {
    reasons.push(
      "no combination satisfies the quotas, family minimums, protected coverage and topic cap simultaneously",
    );
  }
  return reasons;
}

export type G2ReviewSelection = Readonly<{
  /** The seeded candidate order the selection walks; ordinals come from here. */
  ordered: readonly V2Scene[];
  selected: readonly V2Scene[];
}>;

/**
 * Deterministic quota/family/protected/topic selection. The first solution
 * found in the seeded shuffle order wins; the seed is never changed on
 * failure. The selected scenes keep their positions in `ordered` as their
 * stable arm-draw ordinals.
 */
export function selectG2ReviewScenes(input: Readonly<{
  candidates: readonly V2Scene[];
  requiredScenarioIds?: ReadonlySet<string>;
  sampleSeed: number;
}>): G2ReviewSelection {
  const ordered = shuffled(input.candidates, input.sampleSeed);
  const chosen = new Array<boolean>(ordered.length).fill(false);
  const languageSelected = new Map<LanguageVariant, number>();
  const topicSelected = new Map<string, number>();
  let solution: readonly V2Scene[] | null = null;

  const adjust = (scene: V2Scene, delta: number): void => {
    languageSelected.set(
      scene.languageVariant,
      (languageSelected.get(scene.languageVariant) ?? 0) + delta,
    );
    topicSelected.set(scene.topic, (topicSelected.get(scene.topic) ?? 0) + delta);
  };

  const search = (index: number, count: number): boolean => {
    if (solution !== null) return true;
    if (count === V2_REVIEW_SAMPLE_SIZE) {
      const selection = ordered.filter((_, candidateIndex) => chosen[candidateIndex]);
      if (
        satisfiesSelection(selection) &&
        [...(input.requiredScenarioIds ?? [])].every((id) =>
          selection.some((scene) => scene.id === id),
        )
      ) {
        solution = selection;
        return true;
      }
      return false;
    }
    if (index >= ordered.length) return false;
    if (count + (ordered.length - index) < V2_REVIEW_SAMPLE_SIZE) return false;
    const scene = ordered[index]!;
    const withinLanguageQuota =
      (languageSelected.get(scene.languageVariant) ?? 0) <
      V2_REVIEW_LANGUAGE_QUOTAS[scene.languageVariant];
    const withinTopicCap =
      (topicSelected.get(scene.topic) ?? 0) < V2_REVIEW_TOPIC_CAP;
    if (withinLanguageQuota && withinTopicCap) {
      chosen[index] = true;
      adjust(scene, 1);
      if (search(index + 1, count + 1)) return true;
      adjust(scene, -1);
      chosen[index] = false;
    }
    return input.requiredScenarioIds?.has(scene.id)
      ? false
      : search(index + 1, count);
  };

  if (!search(0, 0) || solution === null) {
    const reasons = selectionFailureReasons(ordered)
      .map((reason) => `  - ${reason}`)
      .join("\n");
    throw new Error(
      `sampling seed ${input.sampleSeed} cannot fill the ${V2_REVIEW_SAMPLE_SIZE}-scene review sample; ` +
        `the seed was not changed.\n${reasons}`,
    );
  }
  return { ordered, selected: solution };
}

function contextPanelOf(scene: V2Scene): ContextPanel {
  const items: ContextPanelItem[] = [];
  for (const memory of scene.memory) {
    items.push({ kind: "memory_claim", label: "记忆", text: memory.text });
  }
  for (const portrait of scene.portrait) {
    items.push({ kind: "portrait", label: "画像", text: portrait.text });
  }
  for (const event of scene.historicalEvents) {
    items.push({ kind: "open_loop", label: "悬念", text: event.text });
  }
  return { items };
}

function indexBySequence(
  scenario: V2ArmRun["scenarios"][number],
): Map<number, V2ArmRun["scenarios"][number]["turns"][number]> {
  return new Map(scenario.turns.map((turn) => [turn.sequenceInScenario, turn]));
}

function pairScenario(input: {
  scene: V2Scene;
  offScenario: V2ArmRun["scenarios"][number];
  onScenario: V2ArmRun["scenarios"][number];
  offIsA: boolean;
}): ReviewScenario {
  const offTurns = indexBySequence(input.offScenario);
  const onTurns = indexBySequence(input.onScenario);
  let elapsedDays = 0;
  return {
    contextPanel: contextPanelOf(input.scene),
    languageVariant: input.scene.languageVariant,
    scenarioId: input.scene.id,
    turns: input.scene.turns.map((turn) => {
      elapsedDays += turn.clockAdvanceDays ?? 0;
      const offTurn = offTurns.get(turn.sequenceInScenario);
      const onTurn = onTurns.get(turn.sequenceInScenario);
      if (!offTurn || !onTurn) {
        throw new Error(
          `${input.scene.id} t${turn.sequenceInScenario}: arm run is missing this turn.`,
        );
      }
      return {
        responseA: input.offIsA ? offTurn.assistantText : onTurn.assistantText,
        responseB: input.offIsA ? onTurn.assistantText : offTurn.assistantText,
        sequenceInScenario: turn.sequenceInScenario,
        timeContext: {
          currentDate: new Intl.DateTimeFormat("en-CA", {
            timeZone: turn.userInput.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(
            new Date(
              Date.parse("2026-09-12T00:00:00.000Z") +
                elapsedDays * 86_400_000,
            ),
          ),
          elapsedDays: turn.clockAdvanceDays ?? 0,
        },
        userInput: {
          locale: turn.userInput.locale,
          text: turn.userInput.text,
          timezone: turn.userInput.timezone,
        },
      };
    }),
  };
}

function scoreTemplate(
  selected: readonly V2Scene[],
  reviewPackageFingerprint: string,
): Record<string, unknown> {
  return {
    protocol: BLIND_PAIRWISE_PROTOCOL_V2,
    reviewPackageFingerprint,
    reviewPackageVersion: F3_V2_PACKAGE_VERSION,
    scenarios: selected.map((scene) => ({
      overallChoice: "tie",
      scenarioId: scene.id,
      turns: scene.turns.map((turn) => ({
        choice: "tie",
        sequenceInScenario: turn.sequenceInScenario,
      })),
    })),
    scoredAt: "",
    scorer: "",
  };
}

async function renderPage(
  outDir: string,
  pairs: unknown,
): Promise<string> {
  const templatePath = path.join(
    import.meta.dirname,
    "..",
    "blind-pairwise",
    "review-page.v2.template.html",
  );
  const template = await readFile(templatePath, "utf8");
  const marker = "const PAIRS = /*__PAIRS__*/;";
  if (!template.includes(marker)) throw new Error("Page template marker is missing.");
  const payload = JSON.stringify(pairs).replaceAll("<", "\\u003c");
  const page = template.replace(marker, `const PAIRS = ${payload};`);
  const file = path.join(outDir, "index.html");
  await writeFile(file, page, "utf8");
  return file;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const root = process.cwd();

  const catalog = await readJson<V2CatalogManifest>(arguments_.catalogPath);
  const catalogVerification = await verifyV2Catalog({ manifest: catalog, root });
  if (!catalogVerification.passed) {
    throw new Error(
      `fixture catalog failed:\n${catalogVerification.mismatches.map((line) => `  - ${line}`).join("\n")}`,
    );
  }
  const sceneFiles = await Promise.all(
    catalog.sceneFiles.map((entry) => readJson<V2SceneFile>(entry.path)),
  );
  const scenes = sceneFiles.flatMap((file) => file.scenes);
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));

  const [mainRun, offRun, onRun, ledger, pins] = await Promise.all([
    readJson<V2MainRun>(arguments_.mainRunPath),
    readJson<V2ArmRun>(arguments_.offRunPath),
    readJson<V2ArmRun>(arguments_.onRunPath),
    readJson<V2TreatmentLedger>(arguments_.ledgerPath),
    readJson<V2Pins>(arguments_.pinsPath),
  ]);

  const report = verifyG2Treatment({
    catalog,
    catalogSha256: sha256(catalog),
    ledger,
    ledgerSha256: sha256(ledger),
    main: mainRun,
    off: offRun,
    on: onRun,
    scenes,
  });
  const poolFailures = verifyG2PoolCoverage({
    catalogVerified: catalogVerification.passed,
    eligibleScenarioIds: report.eligibleScenarioIds,
    scenes,
  });
  const failures = [...report.verification.failures, ...poolFailures];
  if (failures.length > 0 || report.verification.failureCount !== 0) {
    throw new Error(
      `G2 treatment verification did not pass (failureCount ${failures.length}); ` +
        `refusing to build the review package.\n${failures.map((line) => `  - ${line}`).join("\n")}`,
    );
  }

  for (const arm of [offRun, onRun]) {
    if (v2ConfigurationFingerprint(pins, arm.configId) !== arm.configurationFingerprint) {
      throw new Error(
        `${arm.arm} arm configuration ${arm.configId} does not match the pinned configuration.`,
      );
    }
  }
  if (pins.continuation.arms.off.id !== offRun.configId || pins.continuation.arms.on.id !== onRun.configId) {
    throw new Error("pins-v2.json does not pin the captured OFF/ON configurations.");
  }

  const eligibleIds = new Set(report.eligibleScenarioIds);
  const ledgerByScene = new Map(
    ledger.scenarios.map((scenario) => [scenario.fixtureId, scenario]),
  );
  const candidates = scenes.filter((scene) => {
    if (scene.family === "correct_zero") return false;
    if (!eligibleIds.has(scene.id)) return false;
    const ledgerScenario = ledgerByScene.get(scene.id);
    return (
      ledgerScenario !== undefined &&
      ledgerScenario.turns.some(
        (turn) =>
          turn.on.selectionOutcome === "selected" &&
          (turn.on.segmentOutcome === "committed" ||
            turn.on.segmentOutcome === "omitted"),
      )
    );
  });
  if (candidates.length === 0) {
    throw new Error("no eligible review candidate reached an ON expression decision.");
  }

  const requiredScenarioIds = new Set(
    candidates
      .filter((scene) =>
        ledgerByScene
          .get(scene.id)
          ?.turns.some((turn) => turn.on.segmentOutcome === "committed"),
      )
      .map((scene) => scene.id),
  );
  const { ordered: candidateOrder, selected } = selectG2ReviewScenes({
    candidates,
    requiredScenarioIds,
    sampleSeed: arguments_.sampleSeed,
  });
  if (selected.length !== V2_REVIEW_SAMPLE_SIZE) {
    throw new Error(
      `selection returned ${selected.length} scenes; expected ${V2_REVIEW_SAMPLE_SIZE}.`,
    );
  }
  const poolOrdinal = new Map(
    candidateOrder.map((scene, index) => [scene.id, index]),
  );

  const assignments: ReviewPairScenario[] = selected.map((scene, selectedIndex) => {
    const ordinal = poolOrdinal.get(scene.id);
    if (ordinal === undefined) {
      throw new Error(`${scene.id}: selected scene is missing from the candidate order.`);
    }
    // Blind-pairwise convention (see eval/blind-pairwise/build-pairs.ts): the
    // per-scenario draw uses the stable ordinal in the seeded candidate
    // order; skipped scenes do not renumber the survivors.
    const assignment = armAssignment(arguments_.fixtureSeed, ordinal);
    return {
      contextPanel: contextPanelOf(scene),
      offIsA: assignment === "A",
      poolOrdinal: ordinal,
      scene,
      selectedIndex,
    };
  });
  const aSideCount = assignments.filter((entry) => entry.offIsA).length;
  if (aSideCount !== 7 && aSideCount !== 8) {
    throw new Error(
      `A/B assignment split ${aSideCount}/${V2_REVIEW_SAMPLE_SIZE - aSideCount} is not 7/8 or 8/7.`,
    );
  }

  const mapping: Record<string, { A: string; B: string }> = {};
  const pairScenarios: ReviewScenario[] = [];
  for (const entry of assignments) {
    const offScenario = offRun.scenarios.find((scenario) => scenario.fixtureId === entry.scene.id);
    const onScenario = onRun.scenarios.find((scenario) => scenario.fixtureId === entry.scene.id);
    if (!offScenario || !onScenario) {
      throw new Error(`${entry.scene.id}: captured arm run is missing this scene.`);
    }
    mapping[entry.scene.id] = {
      A: entry.offIsA ? offRun.configId : onRun.configId,
      B: entry.offIsA ? onRun.configId : offRun.configId,
    };
    pairScenarios.push(
      pairScenario({ offIsA: entry.offIsA, offScenario, onScenario, scene: entry.scene }),
    );
  }

  const selectedIds = selected.map((scene) => scene.id);
  const selectedFamilyCounts = countsRecord(
    countValues(selected.map((scene) => scene.family)),
  );
  const selectedLanguageCounts = countsRecord(
    countValues(selected.map((scene) => scene.languageVariant)),
  );
  const candidateFamilyCounts = countsRecord(
    countValues(candidates.map((scene) => scene.family)),
  );
  const candidateLanguageCounts = countsRecord(
    countValues(candidates.map((scene) => scene.languageVariant)),
  );
  const topicCounts = countsRecord(countValues(selected.map((scene) => scene.topic)));
  const protectedCoverage: Record<string, string> = {};
  for (const requirement of V2_REVIEW_PROTECTED_REQUIREMENTS) {
    const bearer = selected.find((scene) => matchesProtected(scene, requirement));
    if (!bearer) {
      throw new Error(`protected category ${requirement} was lost during selection.`);
    }
    protectedCoverage[requirement] = bearer.id;
  }
  for (const scene of selected) {
    if (sceneById.get(scene.id) === undefined) {
      throw new Error(`${scene.id}: selected scene is not in the verified catalog.`);
    }
  }

  const generatedAt = new Date().toISOString();
  const pairsBase = {
    baselineSource: "synthetic blinded arm A",
    candidateSource: "synthetic blinded arm B",
    excludedScenarios: [],
    excludedTurns: [],
    generatedAt,
    protocol: BLIND_PAIRWISE_PROTOCOL_V2,
    sampling: {
      eligibleCounts: candidateLanguageCounts,
      familyMinimums: V2_REVIEW_FAMILY_MINIMUMS,
      fixtureSeed: arguments_.fixtureSeed,
      protectedCoverage,
      quotas: V2_REVIEW_LANGUAGE_QUOTAS,
      sampleSeed: arguments_.sampleSeed,
      selectedCounts: selectedLanguageCounts,
      strategy: "stratified-random-v1",
      topicCap: V2_REVIEW_TOPIC_CAP,
    },
    scenarios: pairScenarios,
    seed: arguments_.fixtureSeed,
  };

  const sealedIdentities = {
    armOrder: [offRun.configId, onRun.configId],
    arms: { off: offRun.configId, on: onRun.configId },
    fixtureSeed: arguments_.fixtureSeed,
    generatedAt,
    mapping,
    ordinals: Object.fromEntries(
      assignments.map((entry) => [entry.scene.id, entry.poolOrdinal]),
    ),
    protocol: BLIND_PAIRWISE_PROTOCOL_V2,
    sampleSeed: arguments_.sampleSeed,
    seed: arguments_.fixtureSeed,
  };

  const verificationSummary = {
    candidatePoolCount: candidates.length,
    catalogVerified: catalogVerification.passed,
    checkedScenarioCount: report.verification.checkedScenarioCount,
    failureCount: 0,
    failures: [],
    poolCoverageFailures: [],
    treatment: report.verification,
  };

  const reviewPackageBase = {
    abBalance: {
      aSideCount,
      assignmentRule:
        "armAssignment(fixtureSeed, poolOrdinal) with the 0-based position in the seeded candidate order",
      bSideCount: V2_REVIEW_SAMPLE_SIZE - aSideCount,
      offInA: aSideCount,
      onInA: V2_REVIEW_SAMPLE_SIZE - aSideCount,
    },
    artifacts: {
      catalogPath: arguments_.catalogPath,
      catalogSha256: sha256(catalog),
      ledgerPath: arguments_.ledgerPath,
      ledgerSha256: sha256(ledger),
      mainRunPath: arguments_.mainRunPath,
      mainRunSha256: sha256(mainRun),
      offRunPath: arguments_.offRunPath,
      offRunSha256: sha256(offRun),
      onRunPath: arguments_.onRunPath,
      onRunSha256: sha256(onRun),
      pinsPath: arguments_.pinsPath,
      pinsSha256: sha256(pins),
    },
    candidateFamilyCounts,
    candidateLanguageCounts,
    candidatePoolIds: candidates.map((scene) => scene.id),
    eligibleScenarioIds: report.eligibleScenarioIds,
    fixtureSeed: arguments_.fixtureSeed,
    generatedAt,
    languageCounts: selectedLanguageCounts,
    languageQuotas: V2_REVIEW_LANGUAGE_QUOTAS,
    protectedCategoryAliases: PROTECTED_CATEGORY_ALIASES,
    protectedCoverage,
    protocol: BLIND_PAIRWISE_PROTOCOL_V2,
    sampleSeed: arguments_.sampleSeed,
    selectedFamilyCounts,
    selectedScenarioIds: selectedIds,
    synthetic: true,
    topicCounts,
    topicCap: V2_REVIEW_TOPIC_CAP,
    verification: verificationSummary,
    version: F3_V2_PACKAGE_VERSION,
  };
  const reviewPackageFingerprint = sha256({
    pairs: pairsBase,
    reviewPackage: reviewPackageBase,
    sealedIdentities,
    template: await readFile(
      path.resolve(root, "eval/blind-pairwise/review-page.v2.template.html"),
      "utf8",
    ),
  });
  const pairsFile = {
    ...pairsBase,
    reviewPackageFingerprint,
    reviewPackageVersion: F3_V2_PACKAGE_VERSION,
  };
  const reviewPackage = {
    ...reviewPackageBase,
    reviewPackageFingerprint,
  };

  await mkdir(arguments_.outDir, { recursive: true });
  await writeJson(path.join(arguments_.outDir, "pairs.json"), pairsFile);
  await writeJson(path.join(arguments_.outDir, "sealed-identities.json"), sealedIdentities);
  await writeJson(
    path.join(arguments_.outDir, "scores.json"),
    scoreTemplate(selected, reviewPackageFingerprint),
  );
  await writeJson(path.join(arguments_.outDir, "review-package.json"), reviewPackage);
  const pageFile = await renderPage(arguments_.outDir, pairsFile);

  console.log(
    `[g2-review-package] selected ${selected.length} scenes with sample seed ${arguments_.sampleSeed}; ` +
      `verification failureCount 0 (${report.verification.checkedScenarioCount} scenes checked)`,
  );
  console.log("id\tfamily\tlanguage\ttopic\tfirst-protected\tordinal\tA/B");
  for (const entry of assignments) {
    const firstProtected = entry.scene.protectedCategories[0] ?? "-";
    const assignment = entry.offIsA ? "off=A,on=B" : "off=B,on=A";
    console.log(
      `${entry.scene.id}\t${entry.scene.family}\t${entry.scene.languageVariant}\t${entry.scene.topic}\t${firstProtected}\t${entry.poolOrdinal}\t${assignment}`,
    );
  }
  console.log(`family counts: ${JSON.stringify(selectedFamilyCounts)}`);
  console.log(`language counts: ${JSON.stringify(selectedLanguageCounts)}`);
  console.log(`protected coverage: ${JSON.stringify(protectedCoverage)}`);
  console.log(`topic counts: ${JSON.stringify(topicCounts)}`);
  console.log(
    `A/B balance: A=${aSideCount} B=${V2_REVIEW_SAMPLE_SIZE - aSideCount} (off=A ${aSideCount}, on=A ${V2_REVIEW_SAMPLE_SIZE - aSideCount})`,
  );
  console.log(`wrote ${arguments_.outDir}/pairs.json, sealed-identities.json, scores.json, review-package.json`);
  console.log(`wrote ${path.relative(root, pageFile)}`);
}

if (process.argv[1]?.endsWith("build-review-package-v2.ts")) {
  main().catch((error: unknown) => {
    console.error("[g2-review-package] build failed:", error);
    process.exitCode = 1;
  });
}
