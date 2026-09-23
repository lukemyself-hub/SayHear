import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  F3_V4_CATALOG_VERSION,
  F3_V4_SCENES_VERSION,
  V4_DISPOSITION_SIGNALS,
  V4_FAMILIES,
  V4_PROTECTED_CATEGORIES,
  V4_ZERO_REASONS,
  matchesV4TargetRef,
  type V4CatalogManifest,
  type V4Family,
  type V4Scene,
  type V4SceneFile,
  type V4TargetRef,
} from "./protocol-v4";

export const V4_MINIMUM_SCENES = 45;

export const V4_FAMILY_MINIMUMS: Readonly<Record<V4Family, number>> = {
  positive_open_loop: 8,
  positive_memory: 8,
  stateful_suppression: 8,
  omission_contract: 8,
  correct_zero: 7,
  competing_pool: 6,
};

export const V4_LANGUAGE_MINIMUMS = Object.freeze({
  en: 8,
  zh: 5,
  code_switch: 2,
});

export type V4FixtureVerification = Readonly<{
  passed: boolean;
  mismatches: readonly string[];
  sceneCount: number;
  familyCounts: Readonly<Record<V4Family, number>>;
  languageCounts: Readonly<Record<"en" | "zh" | "code_switch", number>>;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveTarget(
  scene: V4Scene,
  target: V4TargetRef,
  mismatches: string[],
  label: string,
): void {
  if (target.kind === "memory_claim") {
    const known =
      scene.memory.some((memory) => memory.id === target.memoryId) ||
      scene.portrait.some((portrait) => portrait.id === target.memoryId);
    if (!known) {
      mismatches.push(`${scene.id}: ${label} references unknown memory ${target.memoryId}`);
    }
    return;
  }
  if (
    !Number.isInteger(target.sourceTurn) ||
    target.sourceTurn < 0 ||
    target.sourceTurn > scene.turns.length
  ) {
    mismatches.push(
      `${scene.id}: ${label} references invalid sourceTurn ${target.sourceTurn}`,
    );
  }
  if (!Number.isInteger(target.ordinal) || target.ordinal < 0) {
    mismatches.push(`${scene.id}: ${label} has invalid ordinal ${target.ordinal}`);
  }
}

function verifyScene(
  scene: V4Scene,
  fileFamily: V4Family,
  seenIds: Set<string>,
  mismatches: string[],
): void {
  if (scene.family !== fileFamily) {
    mismatches.push(`${scene.id}: family ${scene.family} is in ${fileFamily} file`);
  }
  if (seenIds.has(scene.id)) {
    mismatches.push(`${scene.id}: duplicate scene id`);
  }
  seenIds.add(scene.id);
  if (!["en", "zh", "code_switch"].includes(scene.languageVariant)) {
    mismatches.push(`${scene.id}: unknown language variant ${scene.languageVariant}`);
  }
  if (scene.locale === "" || scene.timezone === "") {
    mismatches.push(`${scene.id}: locale and timezone are required`);
  }
  if (scene.topic === "") {
    mismatches.push(`${scene.id}: topic is required`);
  }
  if (scene.turns.length < 2 || scene.turns.length > 4) {
    mismatches.push(`${scene.id}: scene must carry two to four turns`);
  }
  const sequences = scene.turns.map((turn) => turn.sequenceInScenario);
  sequences.forEach((sequence, index) => {
    if (sequence !== index + 1) {
      mismatches.push(`${scene.id}: turns must be contiguous from 1`);
    }
  });
  for (const turn of scene.turns) {
    const expectation = turn.expect;
    for (const target of turn.mentionedTargets ?? []) {
      resolveTarget(
        scene,
        target,
        mismatches,
        `t${turn.sequenceInScenario} mentioned target`,
      );
    }
    if (
      expectation.selection === "segment" &&
      !["greeting", "open_start", "natural_gap"].includes(turn.opportunity ?? "")
    ) {
      mismatches.push(
        `${scene.id} t${turn.sequenceInScenario}: selected turn needs a current positive opportunity`,
      );
    }
    if (
      expectation.selection === "none" &&
      ["greeting", "open_start", "natural_gap"].includes(turn.opportunity ?? "") &&
      !turn.focusRequired &&
      expectation.zeroReason === "focus_required_by_opportunity"
    ) {
      mismatches.push(
        `${scene.id} t${turn.sequenceInScenario}: focus zero conflicts with positive opportunity`,
      );
    }
    if (expectation.selection === "segment") {
      if (!expectation.target) {
        mismatches.push(`${scene.id} t${turn.sequenceInScenario}: segment without target`);
      } else {
        resolveTarget(scene, expectation.target, mismatches, `t${turn.sequenceInScenario} target`);
      }
    } else if (!expectation.zeroReason) {
      mismatches.push(`${scene.id} t${turn.sequenceInScenario}: zero without zoneReason`);
    } else if (!(V4_ZERO_REASONS as readonly string[]).includes(expectation.zeroReason)) {
      mismatches.push(
        `${scene.id} t${turn.sequenceInScenario}: unknown zero reason ${expectation.zeroReason}`,
      );
    }
    if (expectation.zeroReason === "focus_required_by_opportunity") {
      const opportunity = turn.opportunity;
      if (
        opportunity === null ||
        !["current_topic", "direct_task", "urgent_or_high_risk"].includes(opportunity)
      ) {
        mismatches.push(
          `${scene.id} t${turn.sequenceInScenario}: focus_required_by_opportunity needs a focus opportunity`,
        );
      }
    }
    if (expectation.zeroReason === "dialogue_state_not_ready" && !turn.focusRequired) {
      mismatches.push(
        `${scene.id} t${turn.sequenceInScenario}: dialogue zero needs focusRequired`,
      );
    }
    if (expectation.disposition) {
      if (
        !(V4_DISPOSITION_SIGNALS as readonly string[]).includes(
          expectation.disposition.signal,
        )
      ) {
        mismatches.push(
          `${scene.id} t${turn.sequenceInScenario}: unknown disposition signal`,
        );
      }
      resolveTarget(
        scene,
        expectation.disposition.target,
        mismatches,
        `t${turn.sequenceInScenario} disposition target`,
      );
    }
    if (expectation.release?.reason !== undefined && expectation.release.reason !== "cooldown_elapsed") {
      mismatches.push(`${scene.id} t${turn.sequenceInScenario}: unknown release reason`);
    }
    if (expectation.release) {
      resolveTarget(
        scene,
        expectation.release.target,
        mismatches,
        `t${turn.sequenceInScenario} release target`,
      );
    }
    if (expectation.suppressedAfter) {
      resolveTarget(
        scene,
        expectation.suppressedAfter,
        mismatches,
        `t${turn.sequenceInScenario} suppressedAfter`,
      );
    }
    if (expectation.excludedTarget) {
      resolveTarget(
        scene,
        expectation.excludedTarget,
        mismatches,
        `t${turn.sequenceInScenario} excludedTarget`,
      );
      if (!expectation.excludedReason) {
        mismatches.push(
          `${scene.id} t${turn.sequenceInScenario}: excludedTarget without excludedReason`,
        );
      }
    }
    if (turn.mentionedTargets?.length) {
      if (
        expectation.selection !== "none" ||
        expectation.excludedReason !== "mentioned_in_exchange" ||
        !expectation.excludedTarget ||
        !turn.mentionedTargets.some((target) =>
          JSON.stringify(target) === JSON.stringify(expectation.excludedTarget),
        )
      ) {
        mismatches.push(
          `${scene.id} t${turn.sequenceInScenario}: a mentioned target must be explicitly excluded`,
        );
      }
    }
  }
  const segments = scene.turns.filter(
    (turn) => turn.expect.selection === "segment",
  ).length;
  if (
    scene.family === "positive_open_loop" ||
    scene.family === "positive_memory" ||
    scene.family === "omission_contract"
  ) {
    if (segments !== 1) {
      mismatches.push(`${scene.id}: positive scene must commit exactly one segment`);
    }
  }
  if (scene.family === "correct_zero" && segments !== 0) {
    mismatches.push(`${scene.id}: correct_zero scene must not commit a segment`);
  }
  if (scene.family === "stateful_suppression") {
    if (segments === 0) {
      mismatches.push(`${scene.id}: stateful scene must commit at least one segment`);
    }
    const dispositions = scene.turns.filter((turn) => turn.expect.disposition);
    const checkpoints = scene.turns.filter(
      (turn) =>
        turn.expect.selection === "none" &&
        turn.expect.excludedReason === "suppressed",
    );
    if (dispositions.length === 0) {
      mismatches.push(`${scene.id}: stateful scene must declare a disposition`);
    }
    const lastDispositionTurn = Math.max(
      ...dispositions.map((turn) => turn.sequenceInScenario),
      0,
    );
    const laterCheckpoint = checkpoints.some(
      (turn) => turn.sequenceInScenario > lastDispositionTurn,
    );
    const releaseAfterDisposition = scene.turns.some(
      (turn) =>
        turn.sequenceInScenario > lastDispositionTurn && turn.expect.release,
    );
    if (!laterCheckpoint && !releaseAfterDisposition) {
      mismatches.push(
        `${scene.id}: stateful scene needs a later suppression checkpoint or release`,
      );
    }
  }
  if (scene.family === "competing_pool") {
    const seeded = scene.memory.length + scene.portrait.length;
    const competitors = scene.competitors ?? [];
    const winner = scene.turns.find(
      (turn) => turn.expect.selection === "segment",
    )?.expect.target;
    if (seeded < 1 || competitors.length < 1) {
      mismatches.push(
        `${scene.id}: competing scene needs a seeded target and a declared competitor`,
      );
    }
    if (!winner) {
      mismatches.push(`${scene.id}: competing scene must declare its selected target`);
    }
    for (const competitor of competitors) {
      resolveTarget(scene, competitor, mismatches, "competitor");
      if (winner && matchesV4TargetRef(competitor, winner)) {
        mismatches.push(`${scene.id}: selected target is duplicated as a competitor`);
      }
    }
  }
}

/**
 * Fail-closed fixture verification. Any mismatch blocks capture/package work.
 */
export async function verifyV4Catalog(input: Readonly<{
  manifest: V4CatalogManifest;
  root: string;
}>): Promise<V4FixtureVerification> {
  const mismatches: string[] = [];
  const manifest = input.manifest;
  if (manifest.version !== F3_V4_CATALOG_VERSION) {
    mismatches.push(`catalog version ${manifest.version} is not ${F3_V4_CATALOG_VERSION}`);
  }
  if (manifest.synthetic !== true || !manifest.syntheticNotice.toLowerCase().includes("synthetic")) {
    mismatches.push("catalog must be synthetic and carry a synthetic notice");
  }
  const scenes: V4Scene[] = [];
  const seenIds = new Set<string>();
  const parsedFamilies = new Set<V4Family>();
  for (const entry of manifest.sceneFiles) {
    const path = resolve(input.root, entry.path);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      mismatches.push(`scene file missing: ${entry.path}`);
      continue;
    }
    if (sha256(raw) !== entry.sha256) {
      mismatches.push(`scene file hash drift: ${entry.path}`);
      continue;
    }
    let file: V4SceneFile;
    try {
      file = JSON.parse(raw) as V4SceneFile;
    } catch {
      mismatches.push(`scene file is not valid JSON: ${entry.path}`);
      continue;
    }
    if (file.version !== F3_V4_SCENES_VERSION || file.synthetic !== true) {
      mismatches.push(`scene file version/boundary mismatch: ${entry.path}`);
      continue;
    }
    if (!(V4_FAMILIES as readonly string[]).includes(file.family)) {
      mismatches.push(`scene file family unknown: ${entry.path}`);
      continue;
    }
    parsedFamilies.add(file.family);
    for (const scene of file.scenes) {
      verifyScene(scene, file.family, seenIds, mismatches);
      scenes.push(scene);
    }
  }
  for (const family of V4_FAMILIES) {
    if (!parsedFamilies.has(family)) {
      mismatches.push(`scene file family ${family} is missing from the manifest`);
    }
  }
  const familyCounts = Object.fromEntries(
    V4_FAMILIES.map((family) => [
      family,
      scenes.filter((scene) => scene.family === family).length,
    ]),
  ) as Record<V4Family, number>;
  for (const family of V4_FAMILIES) {
    if (familyCounts[family] < V4_FAMILY_MINIMUMS[family]) {
      mismatches.push(
        `family ${family} has ${familyCounts[family]} scenes, needs ${V4_FAMILY_MINIMUMS[family]}`,
      );
    }
  }
  if (scenes.length < V4_MINIMUM_SCENES) {
    mismatches.push(`pool has ${scenes.length} scenes, needs ${V4_MINIMUM_SCENES}`);
  }
  const languageCounts = {
    en: scenes.filter((scene) => scene.languageVariant === "en").length,
    zh: scenes.filter((scene) => scene.languageVariant === "zh").length,
    code_switch: scenes.filter((scene) => scene.languageVariant === "code_switch").length,
  };
  for (const [language, minimum] of Object.entries(V4_LANGUAGE_MINIMUMS)) {
    if (languageCounts[language as keyof typeof languageCounts] < minimum) {
      mismatches.push(`language ${language} has too few scenes`);
    }
  }
  const protectedPresent = new Set(
    scenes.flatMap((scene) => scene.protectedCategories),
  );
  for (const category of V4_PROTECTED_CATEGORIES) {
    if (!protectedPresent.has(category)) {
      mismatches.push(`protected category ${category} is missing from the pool`);
    }
  }
  const tags = new Set(scenes.flatMap((scene) => scene.coverageTags));
  for (const tag of [
    "open_loop_question",
    "memory_acknowledgment",
    "greeting_or_pause",
    "direct_task",
    "high_risk",
    "stop_signal",
    "incomplete_lane",
  ]) {
    if (!tags.has(tag)) mismatches.push(`coverage tag ${tag} is missing from the pool`);
  }
  const topics = new Map<string, number>();
  const omissionAudits = scenes.filter(
    (scene) => scene.reviewIntent === "omission_audit",
  );
  if (omissionAudits.length !== 8) {
    mismatches.push(`omission audit declares ${omissionAudits.length} cases; needs exactly 8`);
  }
  const omissionReasons = new Set(
    omissionAudits.map((scene) => scene.expectedOmissionReason).filter(Boolean),
  );
  for (const reason of [
    "no_genuine_opportunity",
    "duplicates_main_response",
    "insufficient_grounding",
    "timing_not_natural",
  ] as const) {
    if (!omissionReasons.has(reason)) {
      mismatches.push(`omission audit lacks expected reason ${reason}`);
    }
  }
  for (const language of ["en", "zh", "code_switch"] as const) {
    if (!omissionAudits.some((scene) => scene.languageVariant === language)) {
      mismatches.push(`omission audit lacks ${language} coverage`);
    }
  }
  for (const targetKind of ["open_loop", "memory_claim"] as const) {
    if (
      !omissionAudits.some((scene) =>
        scene.turns.some(
          (turn) =>
            turn.expect.selection === "segment" &&
            turn.expect.target?.kind === targetKind,
        ),
      )
    ) {
      mismatches.push(`omission audit lacks ${targetKind} target coverage`);
    }
  }
  for (const scene of scenes) {
    if (!scene.rationale.trim()) mismatches.push(`${scene.id}: rationale is required`);
    if (
      scene.reviewIntent === "omission_audit" &&
      (!scene.expectedOmissionReason ||
        !scene.turns.some((turn) => turn.expect.selection === "segment"))
    ) {
      mismatches.push(`${scene.id}: omission audit needs a typed-omit target and private reason expectation`);
    }
    if (
      scene.reviewIntent === "pairwise_candidate" &&
      !scene.turns.some((turn) => turn.expect.selection === "segment")
    ) {
      mismatches.push(`${scene.id}: pairwise candidate needs a declared selected opportunity`);
    }
  }
  for (const scene of scenes) {
    topics.set(scene.topic, (topics.get(scene.topic) ?? 0) + 1);
  }
  for (const [topic, count] of topics) {
    if (count > 3) {
      mismatches.push(`topic ${topic} appears ${count} times; keep it at most three`);
    }
  }
  return {
    passed: mismatches.length === 0,
    mismatches,
    sceneCount: scenes.length,
    familyCounts,
    languageCounts,
  };
}

async function main(): Promise<void> {
  const catalogPath = resolve(
    process.argv[2] ?? "eval/continuation-acceptance-1a3b/fixtures-v4.json",
  );
  const manifest = JSON.parse(
    await readFile(catalogPath, "utf8"),
  ) as V4CatalogManifest;
  const verification = await verifyV4Catalog({
    manifest,
    root: process.cwd(),
  });
  const report = {
    ...verification,
    catalog: catalogPath,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!verification.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("verify-fixtures-v4.ts")) {
  main().catch((error: unknown) => {
    console.error("[g2-v4-fixtures] failed:", error);
    process.exitCode = 1;
  });
}
