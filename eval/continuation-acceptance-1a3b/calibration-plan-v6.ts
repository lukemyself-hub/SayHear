import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256 } from "./protocol";
import type { V6CatalogManifest, V6Pins, V6Scene, V6SceneFile } from "./protocol-v6";
import { verifyV6Catalog } from "./verify-fixtures-v6";

const ROOT = "eval/continuation-acceptance-1a3b";
const CONFIGS = [
  { id: "prompt-v5", path: `${ROOT}/pins-v6-prompt-v5.json` },
  { id: "prompt-v6", path: `${ROOT}/pins-v6.json` },
  { id: "effort-low", path: `${ROOT}/pins-v6-effort-low.json` },
] as const;
const HISTORICAL = [
  `${ROOT}/fixtures-v4.json`,
  `${ROOT}/fixtures-v5-calibration-1.json`,
  `${ROOT}/fixtures-v5-calibration-2.json`,
] as const;

function calibrationCatalog(round: 1 | 2): string {
  return round === 1
    ? `${ROOT}/fixtures-v6-calibration-1.json`
    : `${ROOT}/fixtures-v6-calibration-2-revised.json`;
}

type FrozenFile = Readonly<{ path: string; rawSha256: string }>;
type Pool = Readonly<{
  scenes: readonly V6Scene[];
  events: ReadonlySet<string>;
  targets: ReadonlySet<string>;
  ids: ReadonlySet<string>;
  files: readonly FrozenFile[];
}>;

export type V6CalibrationPlan = Readonly<{
  version: "g2-v6-calibration-plan:v1";
  round: 1 | 2;
  syntheticOnly: true;
  comparisonOrder: readonly ["prompt-v5", "prompt-v6", "effort-low"];
  mainResponseStrategy: string;
  acceptanceRule: string;
  omissionReasonOrder: readonly string[];
  poolSeparation: string;
  configurations: readonly Readonly<{ id: string; path: string; rolePinSha256: string }>[];
  inputs: readonly FrozenFile[];
  planSha256: string;
}>;

function rawSha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function frozen(path: string): Promise<FrozenFile> {
  return { path, rawSha256: rawSha256(await readFile(resolve(path), "utf8")) };
}

async function readPool(path: string, validateV6: boolean): Promise<Pool> {
  const raw = await readFile(resolve(path), "utf8");
  const catalog = JSON.parse(raw) as V6CatalogManifest;
  if (validateV6) {
    const verification = await verifyV6Catalog({ manifest: catalog, root: process.cwd() });
    if (!verification.passed) throw new Error(`${path}: ${verification.mismatches.join("; ")}`);
    if (catalog.purpose !== "calibration" || verification.sceneCount !== 44 ||
        ["positive_open_loop", "positive_memory", "stateful_suppression", "competing_pool"].some(
          (family) => verification.familyCounts[family as keyof typeof verification.familyCounts] !== 8,
        ) || verification.familyCounts.omission_contract !== 12 ||
        Object.values(verification.languageCounts).some((count) => count === 0)) {
      throw new Error(`${path}: v6 calibration counts or language coverage are incomplete`);
    }
  }
  const files: FrozenFile[] = [{ path, rawSha256: rawSha256(raw) }];
  const scenes: V6Scene[] = [];
  for (const entry of catalog.sceneFiles) {
    const sceneRaw = await readFile(resolve(entry.path), "utf8");
    files.push({ path: entry.path, rawSha256: rawSha256(sceneRaw) });
    scenes.push(...(JSON.parse(sceneRaw) as V6SceneFile).scenes);
  }
  const events = new Set<string>();
  const targets = new Set<string>();
  const ids = new Set<string>();
  for (const scene of scenes) {
    ids.add(scene.id);
    for (const event of scene.historicalEvents) {
      events.add(event.text);
      targets.add(event.text);
      if (validateV6 && !/^(I |我|李|王|张)/u.test(event.text)) {
        throw new Error(`${scene.id}: historical source is not a direct first-person or named-third-party User Event`);
      }
    }
    for (const turn of scene.turns) events.add(turn.userInput.text);
    for (const memory of scene.memory) targets.add(memory.text);
  }
  return { scenes, events, targets, ids, files };
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): string | null {
  for (const value of left) if (right.has(value)) return value;
  return null;
}

function assertDisjoint(left: Pool, right: Pool, labels: readonly [string, string]): void {
  for (const [kind, a, b] of [
    ["Event text", left.events, right.events],
    ["target text", left.targets, right.targets],
    ["scene ID", left.ids, right.ids],
  ] as const) {
    const duplicate = overlap(a, b);
    if (duplicate !== null) throw new Error(`${labels[0]} and ${labels[1]} reuse ${kind}: ${duplicate}`);
  }
}

async function buildPlan(round: 1 | 2): Promise<V6CalibrationPlan> {
  const current = await readPool(calibrationCatalog(round), true);
  const heldout = await readPool(round === 1
    ? `${ROOT}/fixtures-v6-calibration-2.json`
    : calibrationCatalog(1), true);
  assertDisjoint(current, heldout, [`v6 calibration ${round}`, `v6 calibration ${round === 1 ? 2 : 1}`]);
  for (const path of round === 2 ? [...HISTORICAL, `${ROOT}/fixtures-v6-calibration-2.json`] : HISTORICAL) {
    assertDisjoint(current, await readPool(path, false), [`v6 calibration ${round}`, path]);
  }
  const handoffPath = `${ROOT}/issue-241-v6-window-evidence-handoff.json`;
  const handoff = JSON.parse(await readFile(resolve(handoffPath), "utf8")) as {
    scenarios: readonly Readonly<{ id: string; sourceEvent: Readonly<{ text: string }>; subject: string }>[];
  };
  for (const scene of handoff.scenarios) {
    if (current.events.has(scene.sourceEvent.text) || current.targets.has(scene.subject) || current.ids.has(scene.id)) {
      throw new Error(`v6 calibration ${round} overlaps #241 handoff ${scene.id}`);
    }
  }
  const configurations: Array<{ id: string; path: string; rolePinSha256: string }> = [];
  for (const config of CONFIGS) {
    const pins = JSON.parse(await readFile(resolve(config.path), "utf8")) as V6Pins;
    const selected = pins.expression.configurations.find((item) => item.id === pins.expression.selectedConfigId);
    if (pins.version !== "1a3b-g2-pins:v6" || !pins.syntheticOnly || !selected ||
        sha256(selected.pin) !== sha256(pins.roles["proactive.followup"]) ||
        pins.roles["proactive.followup"].provider !== "deepseek" ||
        pins.roles["proactive.followup"].fallback !== "none") {
      throw new Error(`${config.path}: incomplete expression pin or unsupported adapter`);
    }
    configurations.push({ id: config.id, path: config.path, rolePinSha256: sha256(selected.pin) });
  }
  const inputs = [
    ...current.files,
    ...heldout.files,
    ...(await Promise.all([...HISTORICAL, ...(round === 2 ? [`${ROOT}/fixtures-v6-calibration-2.json`] : []), handoffPath, ...CONFIGS.map((config) => config.path),
      `${ROOT}/review-seed-v6.json`].map(frozen))),
  ];
  const body = {
    version: "g2-v6-calibration-plan:v1" as const,
    round,
    syntheticOnly: true as const,
    comparisonOrder: ["prompt-v5", "prompt-v6", "effort-low"] as const,
    mainResponseStrategy: "One real independent Conversation Decision response per predeclared turn. Freeze its raw output, then replay byte-identical main text through OFF and each ON configuration. A main question remains a zero and never triggers a replacement draw.",
    acceptanceRule: "Keep all 32 predeclared positive turns and 12 single-reason probes. One semantic result per configuration and turn; technical failures are separate. A family with zero complete emits, an unstable reason, any negative emit, or any deterministic hard-gate failure fails the set. Review typed reasons for semantic correctness against frozen main text, not string equality alone.",
    omissionReasonOrder: ["insufficient_grounding", "duplicates_main_response", "timing_not_natural", "no_genuine_opportunity"],
    poolSeparation: "Exact scene IDs, full Event text, and full target source text are disjoint from v4/v5, #241 handoff, and the other v6 calibration set. The formal set must use the reserved Valecrest/谷岭 target pool and be verified before capture.",
    configurations,
    inputs,
  };
  return { ...body, planSha256: sha256(body) };
}

export async function verifyV6CalibrationPlan(round: 1 | 2, pinsPath: string, catalogPath: string): Promise<void> {
  const path = `${ROOT}/calibration-plan-v6-round-${round}.json`;
  const saved = JSON.parse(await readFile(resolve(path), "utf8")) as V6CalibrationPlan;
  const { planSha256, ...body } = saved;
  if (planSha256 !== sha256(body)) throw new Error(`${path}: plan hash changed`);
  if (catalogPath !== calibrationCatalog(round) ||
      !saved.configurations.some((config) => config.path === pinsPath)) {
    throw new Error("calibration catalog or complete configuration is outside the frozen plan");
  }
  for (const entry of saved.inputs) {
    const actual = await frozen(entry.path);
    if (actual.rawSha256 !== entry.rawSha256) throw new Error(`${entry.path}: raw bytes changed after calibration freeze`);
  }
  const rebuilt = await buildPlan(round);
  if (sha256(rebuilt) !== sha256(saved)) throw new Error(`${path}: calibration plan no longer matches current inputs`);
}

async function main(): Promise<void> {
  const [mode, roundText] = process.argv.slice(2);
  const round = Number(roundText);
  if ((mode !== "freeze" && mode !== "verify") || (round !== 1 && round !== 2)) {
    throw new Error("usage: calibration-plan-v6.ts freeze|verify 1|2");
  }
  const path = `${ROOT}/calibration-plan-v6-round-${round}.json`;
  if (mode === "freeze") {
    try {
      await readFile(resolve(path), "utf8");
      throw new Error(`${path} already exists; a frozen plan cannot be replaced`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const plan = await buildPlan(round);
    await writeFile(resolve(path), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ plan: path, planSha256: plan.planSha256, scenes: 44, configurations: plan.configurations.map((config) => config.id) }));
  } else {
    for (const config of CONFIGS) {
      await verifyV6CalibrationPlan(round as 1 | 2, config.path, calibrationCatalog(round as 1 | 2));
    }
    console.log(JSON.stringify({ passed: true, plan: path }));
  }
}

if (process.argv[1]?.endsWith("calibration-plan-v6.ts")) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
