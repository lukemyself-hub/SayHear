import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  F3_V6_CATALOG_VERSION,
  F3_V6_SCENES_VERSION,
  V6_DISPOSITION_SIGNALS,
  V6_FAMILIES,
  V6_PROTECTED_CATEGORIES,
  V6_ZERO_REASONS,
  matchesV6TargetRef,
  type V6CatalogManifest,
  type V6Family,
  type V6Scene,
  type V6SceneFile,
  type V6TargetRef,
} from "./protocol-v6";

const POSITIVE_FAMILIES = [
  "positive_open_loop",
  "positive_memory",
  "stateful_suppression",
  "competing_pool",
] as const;
const OMISSION_REASONS = [
  "no_genuine_opportunity",
  "duplicates_main_response",
  "insufficient_grounding",
  "timing_not_natural",
] as const;

export type V6FixtureVerification = Readonly<{
  passed: boolean;
  mismatches: readonly string[];
  sceneCount: number;
  familyCounts: Readonly<Record<V6Family, number>>;
  languageCounts: Readonly<Record<"en" | "zh" | "code_switch", number>>;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveTarget(
  scene: V6Scene,
  target: V6TargetRef,
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
  scene: V6Scene,
  fileFamily: V6Family,
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
    } else if (!(V6_ZERO_REASONS as readonly string[]).includes(expectation.zeroReason)) {
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
        !(V6_DISPOSITION_SIGNALS as readonly string[]).includes(
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
  for (const category of scene.protectedCategories) {
    const sequence = scene.protectedTurnSequences?.[category];
    const evidenceTurn = scene.turns.find((turn) => turn.sequenceInScenario === sequence);
    if (!evidenceTurn) {
      mismatches.push(`${scene.id}: protected category ${category} has no turn-level evidence`);
      continue;
    }
    const supported = category === "direct_task"
      ? evidenceTurn.opportunity === "direct_task"
      : category === "high_risk"
        ? evidenceTurn.opportunity === "urgent_or_high_risk"
        : category === "refusal"
          ? evidenceTurn.expect.disposition?.signal === "refused"
          : category === "short_answer"
            ? evidenceTurn.expect.disposition?.signal === "short_response"
            : evidenceTurn.expect.disposition?.signal === "topic_changed";
    if (!supported) mismatches.push(`${scene.id} t${sequence}: turn does not support protected category ${category}`);
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
      if (winner && matchesV6TargetRef(competitor, winner)) {
        mismatches.push(`${scene.id}: selected target is duplicated as a competitor`);
      }
    }
  }
}

/**
 * Fail-closed fixture verification. Any mismatch blocks capture/package work.
 */
export async function verifyV6Catalog(input: Readonly<{
  manifest: V6CatalogManifest;
  root: string;
}>): Promise<V6FixtureVerification> {
  const mismatches: string[] = [];
  const manifest = input.manifest;
  if (manifest.version !== F3_V6_CATALOG_VERSION) {
    mismatches.push(`catalog version ${manifest.version} is not ${F3_V6_CATALOG_VERSION}`);
  }
  if (manifest.synthetic !== true || !manifest.syntheticNotice.toLowerCase().includes("synthetic")) {
    mismatches.push("catalog must be synthetic and carry a synthetic notice");
  }
  const scenes: V6Scene[] = [];
  const seenIds = new Set<string>();
  const parsedFamilies = new Set<V6Family>();
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
    let file: V6SceneFile;
    try {
      file = JSON.parse(raw) as V6SceneFile;
    } catch {
      mismatches.push(`scene file is not valid JSON: ${entry.path}`);
      continue;
    }
    if (file.version !== F3_V6_SCENES_VERSION || file.synthetic !== true) {
      mismatches.push(`scene file version/boundary mismatch: ${entry.path}`);
      continue;
    }
    if (!(V6_FAMILIES as readonly string[]).includes(file.family)) {
      mismatches.push(`scene file family unknown: ${entry.path}`);
      continue;
    }
    parsedFamilies.add(file.family);
    for (const scene of file.scenes) {
      verifyScene(scene, file.family, seenIds, mismatches);
      scenes.push(scene);
    }
  }
  for (const family of V6_FAMILIES) {
    if (!parsedFamilies.has(family)) {
      mismatches.push(`scene file family ${family} is missing from the manifest`);
    }
  }
  const familyCounts = Object.fromEntries(
    V6_FAMILIES.map((family) => [
      family,
      scenes.filter((scene) => scene.family === family).length,
    ]),
  ) as Record<V6Family, number>;
  if (manifest.purpose === "calibration") {
    if (manifest.calibrationRound !== 1 && manifest.calibrationRound !== 2) {
      mismatches.push("calibration catalog must declare round 1 or 2");
    }
    for (const family of POSITIVE_FAMILIES) {
      if (familyCounts[family] !== 8) {
        mismatches.push(`calibration family ${family} has ${familyCounts[family]} scenes; needs exactly 8`);
      }
    }
    if (familyCounts.omission_contract !== 12 || familyCounts.correct_zero !== 0) {
      mismatches.push("calibration requires 12 omission probes and no correct-zero controls");
    }
  } else if (manifest.purpose === "formal") {
    if (manifest.calibrationRound !== undefined) mismatches.push("formal catalog cannot declare a calibration round");
    if (!manifest.plannedPositiveCounts) mismatches.push("formal catalog must freeze plannedPositiveCounts");
    let positiveTotal = 0;
    for (const family of POSITIVE_FAMILIES) {
      const planned = manifest.plannedPositiveCounts?.[family];
      if (!Number.isInteger(planned) || planned === undefined || planned < 1) {
        mismatches.push(`formal catalog has no positive planned count for ${family}`);
        continue;
      }
      positiveTotal += planned;
      if (familyCounts[family] !== planned) {
        mismatches.push(`formal family ${family} has ${familyCounts[family]} scenes; preregistered ${planned}`);
      }
    }
    if (positiveTotal < 80 || positiveTotal > 160) {
      mismatches.push(`formal positive pool has ${positiveTotal} scenes; allowed range is 80..160`);
    }
    if (familyCounts.omission_contract !== 8 || familyCounts.correct_zero < 1) {
      mismatches.push("formal pool requires eight omissions and at least one correct-zero control");
    }
    if (!manifest.batches || manifest.batches.length < 1 || manifest.batches.length > 3) {
      mismatches.push("formal catalog must preregister one to three batches");
    } else {
      const batchIds = new Set<string>();
      const batchSceneIds = new Set<string>();
      for (const batch of manifest.batches) {
        if (!batch.id || batchIds.has(batch.id)) mismatches.push("formal batch IDs must be nonempty and unique");
        batchIds.add(batch.id);
        for (const id of batch.sceneIds) {
          if (batchSceneIds.has(id)) mismatches.push(`formal scene ${id} occurs in multiple batches`);
          batchSceneIds.add(id);
        }
        const batchScenes = batch.sceneIds.map((id) => scenes.find((scene) => scene.id === id)).filter((scene): scene is V6Scene => !!scene);
        const positiveBatchScenes = batchScenes.filter((scene) => scene.reviewIntent === "pairwise_candidate");
        for (const family of POSITIVE_FAMILIES) {
          if (!positiveBatchScenes.some((scene) => scene.family === family)) {
            mismatches.push(`formal batch ${batch.id} lacks ${family} balance`);
          }
        }
        for (const language of ["en", "zh", "code_switch"] as const) {
          if (!positiveBatchScenes.some((scene) => scene.languageVariant === language)) {
            mismatches.push(`formal batch ${batch.id} lacks ${language} balance`);
          }
        }
      }
      if (batchSceneIds.size !== scenes.length || scenes.some((scene) => !batchSceneIds.has(scene.id))) {
        mismatches.push("formal batches must cover every preregistered scene exactly once");
      }
      const firstBatch = new Set(manifest.batches[0]?.sceneIds ?? []);
      if (scenes.filter((scene) => scene.reviewIntent === "omission_audit").some((scene) => !firstBatch.has(scene.id)) ||
          scenes.filter((scene) => scene.family === "correct_zero").some((scene) => !firstBatch.has(scene.id))) {
        mismatches.push("all formal omission and correct-zero controls must be in the first batch");
      }
    }
  } else {
    mismatches.push("catalog purpose must be calibration or formal");
  }
  const languageCounts = {
    en: scenes.filter((scene) => scene.languageVariant === "en").length,
    zh: scenes.filter((scene) => scene.languageVariant === "zh").length,
    code_switch: scenes.filter((scene) => scene.languageVariant === "code_switch").length,
  };
  if (manifest.purpose === "formal") {
    for (const [language, minimum] of Object.entries({ en: 5, zh: 3, code_switch: 2 })) {
      if (scenes.filter((scene) => scene.reviewIntent === "pairwise_candidate" && scene.languageVariant === language).length < minimum) {
        mismatches.push(`formal positive pool has too few ${language} candidates for the review quota`);
      }
    }
  }
  const protectedPresent = new Set(
    scenes.flatMap((scene) => scene.protectedCategories),
  );
  if (manifest.purpose === "formal") for (const category of V6_PROTECTED_CATEGORIES) {
    if (!protectedPresent.has(category)) mismatches.push(`protected category ${category} is missing from the pool`);
  }
  const tags = new Set(scenes.flatMap((scene) => scene.coverageTags));
  if (manifest.purpose === "formal") for (const tag of [
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
  const expectedOmissionCount = manifest.purpose === "calibration" ? 12 : 8;
  if (omissionAudits.length !== expectedOmissionCount) mismatches.push(`${manifest.purpose} omission audit declares ${omissionAudits.length} cases; needs exactly ${expectedOmissionCount}`);
  for (const reason of OMISSION_REASONS) {
    const expected = manifest.purpose === "calibration" ? 3 : 2;
    const count = omissionAudits.filter((scene) => scene.expectedOmissionReason === reason).length;
    if (count !== expected) mismatches.push(`${manifest.purpose} omission audit has ${count} ${reason} cases; needs exactly ${expected}`);
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
    if (manifest.purpose === "formal" && count > 3) {
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
    process.argv[2] ?? "eval/continuation-acceptance-1a3b/fixtures-v6.json",
  );
  const manifest = JSON.parse(
    await readFile(catalogPath, "utf8"),
  ) as V6CatalogManifest;
  const verification = await verifyV6Catalog({
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

if (process.argv[1]?.endsWith("verify-fixtures-v6.ts")) {
  main().catch((error: unknown) => {
    console.error("[g2-v6-fixtures] failed:", error);
    process.exitCode = 1;
  });
}
