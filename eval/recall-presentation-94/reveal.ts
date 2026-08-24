/**
 * PROTOTYPE — formal unblind for the issue #94 comparison.
 *
 * Structured 先评后揭: refuses to reveal while ratings.json is incomplete
 * (every scenario needs all four 1–5 dimensions on every arm plus a scenario
 * best). After revealing it prints the letter→arm mapping, per-arm dimension
 * medians (medians only — dimensions are never summed, ADR-0110), the
 * scenario-best tally, and the mechanical candidate-flag summary. Every
 * conclusion quote is reverse-checked against the raw response it is
 * attributed to (the #62 revision-record lesson, mechanized); a mismatch
 * exits non-zero. Writes run/results.json.
 *
 * Run: pnpm exec tsx eval/recall-presentation-94/reveal.ts
 *      [--conclusions run/conclusions.json]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ArmKey, ArmLetter } from "./protocol";

const outDir = path.join(import.meta.dirname, "run");

type ComparisonFile = {
  arms: readonly Readonly<{ key: ArmKey; name: string; oneLiner: string }>[];
  dimensions: readonly Readonly<{ key: string; label: string }>;
  scenarios: readonly Readonly<{
    id: string;
    languageVariant: string;
    letterMap: Record<ArmLetter, ArmKey>;
    day2: {
      turns: readonly Readonly<{
        responses: Readonly<Record<string, Readonly<{ text: string; flags?: Record<string, unknown> }>>>;
      }>;
    };
  }>[];
};

type RatingsFile = {
  scenarios: readonly Readonly<{
    scenarioId: string;
    best?: string;
    scenarioNote?: string;
    arms: readonly Readonly<{
      letter: string;
      dimensions: Readonly<Record<string, number>>;
      note?: string;
    }>[];
    turnNotes?: readonly Readonly<{ turnIndex: number; letter: string; note: string }>[];
  }>[];
};

type ConclusionsFile = readonly Readonly<{
  quote: string;
  scenarioId: string;
  turnIndex: number;
  letter: string;
  claim: string;
}>;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(outDir, file), "utf8")) as T;
}

async function main() {
  const comparison = await readJson<ComparisonFile>("comparison.json");
  const ratings = await readJson<RatingsFile>("ratings.json");
  const conclusionsIndex = process.argv.indexOf("--conclusions");
  const conclusions =
    conclusionsIndex > 0
      ? JSON.parse(await readFile(process.argv[conclusionsIndex + 1]!, "utf8")) as ConclusionsFile
      : null;

  const armName: Record<string, string> = {};
  const armOneLiner: Record<string, string> = {};
  for (const arm of comparison.arms) {
    armName[arm.key] = arm.name;
    armOneLiner[arm.key] = arm.oneLiner;
  }
  const dimensionKeys = comparison.dimensions.map((dimension) => dimension.key);
  const letters = ["W", "X", "Y", "Z"] as const;

  // Completeness gate — 先评后揭.
  const problems: string[] = [];
  for (const scenario of comparison.scenarios) {
    const rated = ratings.scenarios.find((entry) => entry.scenarioId === scenario.id);
    if (!rated) {
      problems.push(`${scenario.id}: 未找到评分记录`);
      continue;
    }
    if (!rated.best || !letters.includes(rated.best as ArmLetter)) {
      problems.push(`${scenario.id}: 缺少场景最佳选择`);
    }
    for (const letter of letters) {
      const arm = rated.arms.find((entry) => entry.letter === letter);
      if (!arm) {
        problems.push(`${scenario.id} ${letter}: 缺少评分`);
        continue;
      }
      for (const key of dimensionKeys) {
        const value = arm.dimensions[key];
        if (typeof value !== "number" || value < 1 || value > 5) {
          problems.push(`${scenario.id} ${letter}: 维度 ${key} 缺分或超界`);
        }
      }
    }
  }
  if (problems.length > 0) {
    process.stderr.write(`评分不完整,拒绝揭示(先评后揭):\n  ${problems.join("\n  ")}\n`);
    process.exit(1);
  }

  // Mapping + per-arm medians + best tally.
  const lines: string[] = [];
  const bestTally: Record<string, number> = {};
  const medians: Record<string, Record<string, number[]>> = {};
  lines.push("=== 揭示:字母 → 变体 ===");
  for (const scenario of comparison.scenarios) {
    const rated = ratings.scenarios.find((entry) => entry.scenarioId === scenario.id)!;
    const mapping = Object.entries(scenario.letterMap)
      .map(([letter, key]) => `${letter}=${key}`)
      .join("  ");
    lines.push(`${scenario.id} (${scenario.languageVariant}): ${mapping} · 最佳=${rated.best}`);
    bestTally[scenario.letterMap[rated.best as ArmLetter]!] =
      (bestTally[scenario.letterMap[rated.best as ArmLetter]!] ?? 0) + 1;
    for (const letter of letters) {
      const key = scenario.letterMap[letter];
      const arm = rated.arms.find((entry) => entry.letter === letter)!;
      medians[key] ??= {};
      for (const dimensionKey of dimensionKeys) {
        (medians[key]![dimensionKey] ??= []).push(arm.dimensions[dimensionKey]!);
      }
    }
  }

  lines.push("");
  lines.push("=== 各变体维度中位数(1–5,不求和)===");
  for (const arm of comparison.arms) {
    const perDimension = dimensionKeys.map(
      (dimensionKey) => `${dimensionKey}=${median(medians[arm.key]![dimensionKey]!)}`,
    );
    lines.push(`${arm.name} [${arm.key}] · 最佳计数 ${bestTally[arm.key] ?? 0} · ${perDimension.join("  ")}`);
  }

  lines.push("");
  lines.push("=== 机械候选标记汇总(报警≠定罪,人工核实)===");
  let flagTotal = 0;
  for (const scenario of comparison.scenarios) {
    for (const [turnIndex, turn] of scenario.day2.turns.entries()) {
      for (const [letter, key] of Object.entries(scenario.letterMap)) {
        const response = turn.responses[key];
        const flags = response?.flags as
          | { forbiddenTokenHits?: string[]; timeGroundingFlags?: string[]; recallPhraseFlags?: string[] }
          | undefined;
        const hits = [
          ...(flags?.forbiddenTokenHits ?? []),
          ...(flags?.timeGroundingFlags ?? []),
        ];
        if (hits.length > 0) {
          flagTotal += 1;
          lines.push(
            `${scenario.id} t${turnIndex + 3} ${letter}(${key}): 硬门禁类候选 ${hits.join(" · ")}`,
          );
        }
      }
    }
  }
  if (flagTotal === 0) lines.push("禁提 token 与时间锚扫描:全部无命中");

  lines.push("");
  lines.push("=== 逐轮批注 ===");
  for (const scenario of comparison.scenarios) {
    const rated = ratings.scenarios.find((entry) => entry.scenarioId === scenario.id)!;
    for (const note of rated.turnNotes ?? []) {
      lines.push(`${scenario.id} t${note.turnIndex} ${note.letter}: ${note.note}`);
    }
    for (const arm of rated.arms) {
      if (arm.note) lines.push(`${scenario.id} ${arm.letter} 整体: ${arm.note}`);
    }
    if (rated.scenarioNote) lines.push(`${scenario.id} 场景: ${rated.scenarioNote}`);
  }

  // Reverse-check conclusions against raw responses.
  let reverseCheckFailures = 0;
  if (conclusions) {
    lines.push("");
    lines.push("=== 引文反查 ===");
    for (const conclusion of conclusions) {
      const scenario = comparison.scenarios.find(
        (entry) => entry.id === conclusion.scenarioId,
      );
      const turn = scenario?.day2.turns[conclusion.turnIndex - 3];
      const key = scenario?.letterMap[conclusion.letter as ArmLetter];
      const raw = key ? turn?.responses[key]?.text : undefined;
      if (typeof raw !== "string" || !raw.includes(conclusion.quote)) {
        reverseCheckFailures += 1;
        lines.push(
          `✗ ${conclusion.scenarioId} t${conclusion.turnIndex} ${conclusion.letter}: 引文不是该变体该轮原文的子串 — "${conclusion.quote.slice(0, 60)}"`,
        );
      } else {
        lines.push(
          `✓ ${conclusion.scenarioId} t${conclusion.turnIndex} ${conclusion.letter}: ${conclusion.claim}`,
        );
      }
    }
  }

  const report = lines.join("\n");
  process.stdout.write(report + "\n");
  await writeFile(
    path.join(outDir, "results.json"),
    JSON.stringify(
      {
        bestTally,
        conclusions: conclusions ?? null,
        generatedAtIso: new Date().toISOString(),
        medians: Object.fromEntries(
          Object.entries(medians).map(([key, perDimension]) => [
            key,
            Object.fromEntries(
              Object.entries(perDimension).map(([dimensionKey, values]) => [
                dimensionKey,
                median(values),
              ]),
            ),
          ]),
        ),
        report,
      },
      null,
      2,
    ),
  );
  if (reverseCheckFailures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
