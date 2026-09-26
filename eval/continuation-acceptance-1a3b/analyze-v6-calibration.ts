import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { V6CatalogManifest, V6Scene, V6SceneFile, V6TreatmentVerification } from "./protocol-v6";

const POSITIVE_FAMILIES = [
  "positive_open_loop",
  "positive_memory",
  "stateful_suppression",
  "competing_pool",
] as const;
const SAMPLE_MINIMUMS = {
  positive_open_loop: 3,
  positive_memory: 3,
  stateful_suppression: 2,
  competing_pool: 1,
} as const;
const OMISSION_REASONS = [
  "no_genuine_opportunity",
  "duplicates_main_response",
  "insufficient_grounding",
  "timing_not_natural",
] as const;

export type V6CalibrationAnalysis = Readonly<{
  version: "1a3b-g2-calibration-analysis:v6";
  round: 1 | 2;
  passed: boolean;
  pauseReason: string | null;
  families: Readonly<Record<(typeof POSITIVE_FAMILIES)[number], Readonly<{
    opportunities: number;
    committedEmits: number;
    p: number;
    formulaMinimum: number | null;
    plannedCount: number | null;
  }>>>;
  omissionReasons: Readonly<Record<(typeof OMISSION_REASONS)[number], Readonly<{
    declared: number;
    actualTypedOmissions: number;
    stable: boolean;
  }>>>;
  plannedPositiveCounts: Readonly<Record<(typeof POSITIVE_FAMILIES)[number], number>> | null;
  totalFormalPositiveScenes: number | null;
  verificationPassed: boolean;
  verificationFailures: readonly string[];
  semanticQuestionEmitTurnIds: readonly string[];
  semanticGatePassed: boolean;
}>;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : args[index + 1] ?? fallback;
  };
  const catalogPath = arg("--catalog", "eval/continuation-acceptance-1a3b/fixtures-v6-calibration-1.json");
  const verificationPath = arg("--verification", "eval/continuation-acceptance-1a3b/run-v6-calibration-1/verification.json");
  const outputPath = arg("--out", "eval/continuation-acceptance-1a3b/run-v6-calibration-1/calibration-report.json");
  const manifest = JSON.parse(await readFile(resolve(catalogPath), "utf8")) as V6CatalogManifest;
  if (manifest.purpose !== "calibration" || !manifest.calibrationRound) throw new Error("Calibration analysis requires a numbered calibration catalog.");
  const runDirectory = `eval/continuation-acceptance-1a3b/run-v6-calibration-${manifest.calibrationRound}`;
  const mainAuditPath = arg("--main-audit", `${runDirectory}/main-audit.json`);
  const mainRunPath = arg("--main-run", `${runDirectory}/continuation-main.json`);
  const verification = JSON.parse(await readFile(resolve(verificationPath), "utf8")) as V6TreatmentVerification;
  const mainAudit = JSON.parse(await readFile(resolve(mainAuditPath), "utf8")) as {
    reviewedBeforeExpressionCalls: boolean;
    mainRawSha256: string;
    rows: readonly Readonly<{ sceneId: string; sequenceInScenario: number; currentMainHasOrdinaryQuestionSemantic: boolean }>[];
  };
  const mainRawSha256 = createHash("sha256").update(await readFile(resolve(mainRunPath))).digest("hex");
  if (!mainAudit.reviewedBeforeExpressionCalls || mainAudit.mainRawSha256 !== mainRawSha256) {
    throw new Error("Main-response semantic audit does not match the frozen main capture.");
  }
  const sceneFiles = await Promise.all(manifest.sceneFiles.map(async (entry) => JSON.parse(await readFile(resolve(entry.path), "utf8")) as V6SceneFile));
  const scenes = sceneFiles.flatMap((file) => file.scenes);
  const auditedTurnIds = mainAudit.rows.map((row) => `${row.sceneId}:t${row.sequenceInScenario}`);
  const declaredAuditTurnIds = scenes.map((scene) => `${scene.id}:t2`);
  if (auditedTurnIds.length !== declaredAuditTurnIds.length ||
      new Set(auditedTurnIds).size !== auditedTurnIds.length ||
      declaredAuditTurnIds.some((turnId) => !auditedTurnIds.includes(turnId))) {
    throw new Error("Main-response semantic audit does not cover every declared t2 turn exactly once.");
  }
  const semanticQuestionEmitTurnIds = mainAudit.rows
    .filter((row) => row.currentMainHasOrdinaryQuestionSemantic)
    .map((row) => `${row.sceneId}:t${row.sequenceInScenario}`)
    .filter((turnId) => verification.committedOpportunityTurnIds.includes(turnId));
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const opportunityFamily = new Map<string, string>();
  for (const turnId of verification.predeclaredOpportunityTurnIds) {
    const [sceneId] = turnId.split(":t");
    const scene = sceneById.get(sceneId!);
    if (scene) opportunityFamily.set(turnId, scene.family);
  }
  const emittedByFamily = new Map<string, number>();
  for (const turnId of verification.committedOpportunityTurnIds) {
    const family = opportunityFamily.get(turnId);
    if (family) emittedByFamily.set(family, (emittedByFamily.get(family) ?? 0) + 1);
  }
  const actualEmitSceneIds = new Set(verification.actualEmitScenarioIds);
  const familyStats = {} as Record<(typeof POSITIVE_FAMILIES)[number], {
    opportunities: number; committedEmits: number; p: number; formulaMinimum: number | null; plannedCount: number | null;
  }>;
  const familyZero = [] as string[];
  let formulaTotal = 0;
  for (const family of POSITIVE_FAMILIES) {
    const opportunities = [...opportunityFamily].filter(([, sceneFamily]) => sceneFamily === family).length;
    const committedEmits = emittedByFamily.get(family) ?? 0;
    const p = opportunities === 0 ? 0 : committedEmits / opportunities;
    if (committedEmits === 0 || p === 0) familyZero.push(family);
    const rawMinimum = p === 0 ? null : Math.ceil((2 * SAMPLE_MINIMUMS[family]) / p);
    const formulaMinimum = rawMinimum === null ? null : Math.ceil(rawMinimum / 10) * 10;
    familyStats[family] = { opportunities, committedEmits, p, formulaMinimum, plannedCount: formulaMinimum };
    if (formulaMinimum !== null) formulaTotal += formulaMinimum;
  }

  const actualOmissionSceneIds = new Set(verification.actualOmissionAuditScenarioIds);
  const omissionReasons = {} as Record<(typeof OMISSION_REASONS)[number], { declared: number; actualTypedOmissions: number; stable: boolean }>;
  const unstableReasons: string[] = [];
  for (const reason of OMISSION_REASONS) {
    const declaredScenes = scenes.filter((scene) => scene.reviewIntent === "omission_audit" && scene.expectedOmissionReason === reason);
    const actualTypedOmissions = declaredScenes.filter((scene) => actualOmissionSceneIds.has(scene.id)).length;
    const stable = declaredScenes.length === 3 && actualTypedOmissions === 3;
    omissionReasons[reason] = { declared: declaredScenes.length, actualTypedOmissions, stable };
    if (!stable) unstableReasons.push(reason);
  }

  let plannedPositiveCounts: Record<(typeof POSITIVE_FAMILIES)[number], number> | null = null;
  if (familyZero.length === 0 && formulaTotal <= 160) {
    plannedPositiveCounts = Object.fromEntries(POSITIVE_FAMILIES.map((family) => [family, familyStats[family].plannedCount!])) as Record<(typeof POSITIVE_FAMILIES)[number], number>;
    const order = ["positive_memory", "competing_pool", "positive_open_loop", "stateful_suppression"] as const;
    let next = 0;
    while (Object.values(plannedPositiveCounts).reduce((sum, count) => sum + count, 0) < 80) {
      plannedPositiveCounts[order[next % order.length]!] += 10;
      next += 1;
    }
    for (const family of POSITIVE_FAMILIES) familyStats[family].plannedCount = plannedPositiveCounts[family];
  }
  const totalFormalPositiveScenes = plannedPositiveCounts
    ? Object.values(plannedPositiveCounts).reduce((sum, count) => sum + count, 0)
    : null;
  const pauseReason = semanticQuestionEmitTurnIds.length > 0
    ? `semantic main-question gate failed for ${semanticQuestionEmitTurnIds.join(", ")}`
    : !verification.passed
    ? "calibration verification failed; repair only demonstrated defects before an independent round"
    : familyZero.length > 0
      ? `zero complete emits or executable opportunities in: ${familyZero.join(", ")}`
      : unstableReasons.length > 0
        ? `typed omission reason was not stable in all three probes: ${unstableReasons.join(", ")}`
        : formulaTotal > 160
          ? `formula requires ${formulaTotal} positive scenes, exceeding the 160-scene cap`
          : null;
  const report: V6CalibrationAnalysis = {
    version: "1a3b-g2-calibration-analysis:v6",
    round: manifest.calibrationRound,
    passed: pauseReason === null,
    pauseReason,
    families: familyStats,
    omissionReasons,
    plannedPositiveCounts,
    totalFormalPositiveScenes,
    verificationPassed: verification.passed,
    verificationFailures: verification.failures,
    semanticQuestionEmitTurnIds,
    semanticGatePassed: semanticQuestionEmitTurnIds.length === 0,
  };
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("analyze-v6-calibration.ts")) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
