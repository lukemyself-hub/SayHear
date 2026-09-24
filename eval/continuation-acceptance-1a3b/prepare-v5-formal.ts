import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256 } from "./protocol";
import type { V5CatalogManifest, V5Pins, V5Scene, V5SceneFile } from "./protocol-v5";
import { V5_SAMPLE_SEED } from "./sampling-v5";
import { verifyV5Catalog } from "./verify-fixtures-v5";

const ROOT = "eval/continuation-acceptance-1a3b";
const CALIBRATION_CATALOG = `${ROOT}/fixtures-v5-calibration-1.json`;
const CALIBRATION_REPORT = `${ROOT}/run-v5-calibration-1/calibration-report.json`;
const POSITIVE_COUNTS_PATH = `${ROOT}/formal-positive-counts-v5.json`;
const FORMAL_CATALOG = `${ROOT}/fixtures-v5.json`;
const PINS_PATH = `${ROOT}/pins-v5.json`;
const SAMPLE_SEED_PATH = `${ROOT}/review-seed-v5.json`;
const EXPRESSION_SELECTION_PATH = `${ROOT}/run-v5/operator/expression-selection.json`;
const PREREGISTRATION_PATH = `${ROOT}/preregistration-v5.json`;

function rawSha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function sceneContentFingerprint(scene: V5Scene): string {
  return sha256({
    historicalEvents: scene.historicalEvents.map((entry) => entry.text),
    memory: scene.memory.map((entry) => entry.text),
    portrait: scene.portrait.map((entry) => entry.text),
    turns: scene.turns.map((turn) => turn.userInput.text),
  });
}

async function main(): Promise<void> {
  const calibration = JSON.parse(await readFile(resolve(CALIBRATION_REPORT), "utf8")) as {
    passed: boolean;
    round: number;
    plannedPositiveCounts: Record<string, number> | null;
    families: Readonly<Record<string, { plannedCount: number | null }>>;
  };
  if (!calibration.passed || calibration.round !== 1 || !calibration.plannedPositiveCounts) {
    throw new Error("Formal fixtures require a passing first calibration and its frozen count calculation.");
  }
  const counts = Object.fromEntries(Object.entries(calibration.families).map(([family, item]) => [family, item.plannedCount])) as Record<string, number>;
  if (sha256(counts) !== sha256(calibration.plannedPositiveCounts)) {
    throw new Error("Calibration report count formula and planned positive counts disagree.");
  }
  await writeFile(resolve(POSITIVE_COUNTS_PATH), `${JSON.stringify(counts, null, 2)}\n`, "utf8");
  execFileSync(process.execPath, ["--import", "tsx/esm", resolve(`${ROOT}/author-fixtures-v5.ts`), "formal", resolve(POSITIVE_COUNTS_PATH)], { stdio: "inherit" });

  const manifestRaw = await readFile(resolve(FORMAL_CATALOG), "utf8");
  const catalog = JSON.parse(manifestRaw) as V5CatalogManifest;
  const fixtureVerification = await verifyV5Catalog({ manifest: catalog, root: process.cwd() });
  if (!fixtureVerification.passed) {
    throw new Error(`Formal catalog failed structure and hash validation: ${fixtureVerification.mismatches.join("; ")}`);
  }
  const formalFiles = await Promise.all(catalog.sceneFiles.map(async (entry) => ({
    path: entry.path,
    raw: await readFile(resolve(entry.path), "utf8"),
    file: JSON.parse(await readFile(resolve(entry.path), "utf8")) as V5SceneFile,
  })));
  const formalScenes = formalFiles.flatMap((entry) => entry.file.scenes);
  const calibrationManifestRaw = await readFile(resolve(CALIBRATION_CATALOG), "utf8");
  const calibrationManifest = JSON.parse(calibrationManifestRaw) as V5CatalogManifest;
  const calibrationVerificationRaw = await readFile(resolve(`${ROOT}/run-v5-calibration-1/verification.json`), "utf8");
  const calibrationVerification = JSON.parse(calibrationVerificationRaw) as {
    inputFingerprints: readonly Readonly<{ path: string; rawSha256: string; canonicalJsonSha256: string }>[];
    passed: boolean;
  };
  if (!calibrationVerification.passed) throw new Error("Calibration evidence is not verifier-passing.");
  const calibrationFiles = await Promise.all(calibrationManifest.sceneFiles.map(async (entry) => {
    const raw = await readFile(resolve(entry.path), "utf8");
    const pinned = calibrationVerification.inputFingerprints.find((item) => item.path === entry.path);
    if (!pinned || pinned.rawSha256 !== rawSha256(raw) || pinned.canonicalJsonSha256 !== sha256(JSON.parse(raw) as unknown)) {
      throw new Error(`Calibration input fingerprint is missing or changed: ${entry.path}`);
    }
    return { raw, file: JSON.parse(raw) as V5SceneFile };
  }));
  const calibrationScenes = calibrationFiles.flatMap((entry) => entry.file.scenes);
  const calibrationContent = new Set(calibrationScenes.map(sceneContentFingerprint));
  const overlap = formalScenes.filter((scene) => calibrationContent.has(sceneContentFingerprint(scene)));
  if (overlap.length > 0 || formalScenes.some((scene) => calibrationScenes.some((prior) => prior.id === scene.id))) {
    throw new Error(`Formal pool overlaps calibration content: ${overlap.map((scene) => scene.id).join(", ")}`);
  }
  const calibratedManifestFingerprint = calibrationVerification.inputFingerprints.find((item) => item.path === CALIBRATION_CATALOG);
  if (!calibratedManifestFingerprint || calibratedManifestFingerprint.rawSha256 !== rawSha256(calibrationManifestRaw) ||
      calibratedManifestFingerprint.canonicalJsonSha256 !== sha256(JSON.parse(calibrationManifestRaw) as unknown)) {
    throw new Error("Calibration verifier does not fingerprint the current calibration manifest.");
  }
  if (!catalog.batches || catalog.batches.length < 1 || catalog.batches.length > 3) {
    throw new Error("Formal batch plan must contain one to three batches.");
  }

  const [pinsRaw, seedRaw, selectionRaw, countsRaw, calibrationRaw] = await Promise.all([
    readFile(resolve(PINS_PATH), "utf8"),
    readFile(resolve(SAMPLE_SEED_PATH), "utf8"),
    readFile(resolve(EXPRESSION_SELECTION_PATH), "utf8"),
    readFile(resolve(POSITIVE_COUNTS_PATH), "utf8"),
    readFile(resolve(CALIBRATION_REPORT), "utf8"),
  ]);
  const pins = JSON.parse(pinsRaw) as V5Pins;
  const seed = JSON.parse(seedRaw) as { sampleSeed: number; version: string };
  const selection = JSON.parse(selectionRaw) as { version: string; winnerConfigId: string; winnerRolePinSha256: string };
  const expressionPin = pins.expression.configurations.find((entry) => entry.id === selection.winnerConfigId);
  if (pins.version !== "1a3b-g2-pins:v5" || pins.continuation.arms.on.proactive.promptVersion !== "proactive-followup-prompt:v5" ||
      !expressionPin || selection.version !== "1a3b-g2-expression-decision:v5" || selection.winnerConfigId !== pins.expression.selectedConfigId ||
      selection.winnerRolePinSha256 !== sha256(expressionPin.pin) || seed.version !== "1a3b-g2-review-seed:v5" || seed.sampleSeed !== V5_SAMPLE_SEED) {
    throw new Error("Formal pins, role selection, or sampling seed are not the frozen v5 inputs.");
  }
  const frozenInputs = [
    { path: FORMAL_CATALOG, raw: manifestRaw },
    ...formalFiles.map((entry) => ({ path: entry.path, raw: entry.raw })),
    { path: POSITIVE_COUNTS_PATH, raw: countsRaw },
    { path: PINS_PATH, raw: pinsRaw },
    { path: SAMPLE_SEED_PATH, raw: seedRaw },
    { path: EXPRESSION_SELECTION_PATH, raw: selectionRaw },
  ];
  const batchStats = catalog.batches.map((batch) => {
    const batchScenes = batch.sceneIds.map((id) => formalScenes.find((scene) => scene.id === id)).filter((scene): scene is V5Scene => !!scene);
    return {
      id: batch.id,
      sceneCount: batchScenes.length,
      familyCounts: Object.fromEntries([...new Set(batchScenes.map((scene) => scene.family))].map((family) => [family, batchScenes.filter((scene) => scene.family === family).length])),
      languageCounts: Object.fromEntries(["en", "zh", "code_switch"].map((language) => [language, batchScenes.filter((scene) => scene.languageVariant === language).length])),
      omissionIds: batchScenes.filter((scene) => scene.reviewIntent === "omission_audit").map((scene) => scene.id),
      correctZeroIds: batchScenes.filter((scene) => scene.family === "correct_zero").map((scene) => scene.id),
    };
  });
  const body = {
    version: "1a3b-g2-preregistration:v5",
    frozenAt: "2026-09-23",
    calibrationEvidence: {
      report: { path: CALIBRATION_REPORT, rawSha256: rawSha256(calibrationRaw), canonicalJsonSha256: sha256(JSON.parse(calibrationRaw) as unknown) },
      catalog: { path: CALIBRATION_CATALOG, rawSha256: rawSha256(calibrationManifestRaw), canonicalJsonSha256: sha256(JSON.parse(calibrationManifestRaw) as unknown) },
      sceneFiles: calibrationFiles.map((entry, index) => ({ path: calibrationManifest.sceneFiles[index]!.path, rawSha256: rawSha256(entry.raw), canonicalJsonSha256: sha256(JSON.parse(entry.raw) as unknown) })),
      verification: { path: `${ROOT}/run-v5-calibration-1/verification.json`, rawSha256: rawSha256(calibrationVerificationRaw), canonicalJsonSha256: sha256(JSON.parse(calibrationVerificationRaw) as unknown) },
    },
    formalPurpose: catalog.purpose,
    plannedPositiveCounts: catalog.plannedPositiveCounts,
    sampleSeed: seed.sampleSeed,
    batchPlan: batchStats,
    inputs: frozenInputs.map((entry) => ({ path: entry.path, rawSha256: rawSha256(entry.raw), canonicalJsonSha256: sha256(JSON.parse(entry.raw) as unknown) })),
    fixtureVerification: { passed: fixtureVerification.passed, sceneCount: fixtureVerification.sceneCount, familyCounts: fixtureVerification.familyCounts, languageCounts: fixtureVerification.languageCounts },
  };
  const preregistration = { ...body, preregistrationSha256: sha256(body) };
  await writeFile(resolve(PREREGISTRATION_PATH), `${JSON.stringify(preregistration, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ path: PREREGISTRATION_PATH, preregistrationSha256: preregistration.preregistrationSha256, positiveCounts: catalog.plannedPositiveCounts, batchStats }, null, 2));
}

if (process.argv[1]?.endsWith("prepare-v5-formal.ts")) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
