import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  F3_BIO_INSPECTION_VERSION,
  F3_REVIEW_PACKAGE_VERSION,
  type FixtureCatalog,
  type PairwiseScores,
  type SyntheticRun,
} from "./protocol";
import { buildReviewPackage, toPublicReviewPackage } from "./review-package";
import { type AcceptanceManifest } from "./manifest";

type Group = "continuation" | "bio_naturalness";

function required(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

function parseArguments(): {
  baselineRunPath: string;
  candidateRunPath: string;
  catalogPath: string;
  group: Group;
  manifestPath: string;
  outDir: string;
} {
  const arguments_ = process.argv.slice(2);
  const values = {
    baselineRunPath: "",
    candidateRunPath: "",
    catalogPath: "eval/continuation-acceptance-1a3b/fixtures.json",
    group: "continuation" as Group,
    manifestPath: "",
    outDir: "",
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--baseline-run") values.baselineRunPath = required(arguments_, ++index, argument);
    else if (argument === "--candidate-run") values.candidateRunPath = required(arguments_, ++index, argument);
    else if (argument === "--catalog") values.catalogPath = required(arguments_, ++index, argument);
    else if (argument === "--manifest") values.manifestPath = required(arguments_, ++index, argument);
    else if (argument === "--group") {
      const value = required(arguments_, ++index, argument);
      if (value !== "continuation" && value !== "bio_naturalness") throw new Error("--group must be continuation or bio_naturalness.");
      values.group = value;
    } else if (argument === "--out") values.outDir = required(arguments_, ++index, argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "string" && value.length === 0) throw new Error(`${name} is required.`);
  }
  return values;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function scoreTemplate(package_: ReturnType<typeof buildReviewPackage>): PairwiseScores {
  return {
    protocol: "blind-pairwise:v2",
    scorer: "",
    scoredAt: "",
    scenarios: package_.pairs.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      overallChoice: "tie",
      turns: scenario.turns.map((turn) => ({
        sequenceInScenario: turn.sequenceInScenario,
        choice: "tie",
      })),
    })),
  };
}

function bioInspectionTemplate(
  package_: ReturnType<typeof buildReviewPackage>,
): unknown {
  return {
    adjudicator: "Luke",
    configurationId: "",
    decidedAt: "",
    entries: package_.pairs.scenarios.map((scenario) => ({
      fixtureId: scenario.scenarioId,
      note: "Replace with Luke's fixed-sample ruling.",
      verdict: "unacceptable",
    })),
    group: "bio_naturalness",
    manifestFingerprint: package_.manifestFingerprint,
    reviewPackageFingerprint: package_.packageFingerprint,
    version: F3_BIO_INSPECTION_VERSION,
  };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments();
  const catalog = await readJson<FixtureCatalog>(arguments_.catalogPath);
  const manifest = await readJson<AcceptanceManifest>(arguments_.manifestPath);
  const baselineRun = await readJson<SyntheticRun>(arguments_.baselineRunPath);
  const candidateRun = await readJson<SyntheticRun>(arguments_.candidateRunPath);
  const package_ = buildReviewPackage({
    baselineRun,
    candidateRun,
    catalog,
    group: arguments_.group,
    manifest,
  });
  await mkdir(arguments_.outDir, { recursive: true });
  await writeJson(
    path.join(arguments_.outDir, "review-package.json"),
    toPublicReviewPackage(package_),
  );
  await writeJson(path.join(arguments_.outDir, "pairs.json"), package_.pairs);
  await writeJson(path.join(arguments_.outDir, "sealed-identities.json"), package_.sealed);
  await writeJson(path.join(arguments_.outDir, "input-summary.json"), package_.inputSummary);
  await writeJson(path.join(arguments_.outDir, "hard-gates.json"), package_.hardGateReport);
  await writeJson(path.join(arguments_.outDir, "scores.json"), scoreTemplate(package_));
  if (arguments_.group === "bio_naturalness") {
    await writeJson(
      path.join(arguments_.outDir, "bio-inspection-template.json"),
      bioInspectionTemplate(package_),
    );
  }
  console.log(
    `[f3-review] ${F3_REVIEW_PACKAGE_VERSION} ${arguments_.group}: ` +
      `${package_.pairs.scenarios.length} blinded scenarios, ` +
      `${package_.hardGateReport.checkedFixtureCount} full-pool fixtures checked`,
  );
  console.log(
    `[f3-review] next: pnpm exec tsx eval/blind-pairwise/build-review-page.ts --dir ${arguments_.outDir}`,
  );
}

main().catch((error: unknown) => {
  console.error("[f3-review] build failed:", error);
  process.exitCode = 1;
});
