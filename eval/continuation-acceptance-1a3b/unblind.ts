import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  F3_LEDGER_VERSION,
  isRecord,
  type BioInspectionLedger,
  type PairwiseScores,
  type ReviewPackage,
  type SealedIdentities,
} from "./protocol";
import { unblindReviewPackage } from "./review-package";

function required(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

function parseDir(): string {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 2 || arguments_[0] !== "--dir") {
    throw new Error("Usage: unblind.ts --dir <review-package-directory>");
  }
  return required(arguments_, 1, "--dir");
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function readOptionalJson<T>(file: string): Promise<T | undefined> {
  try {
    return await readJson<T>(file);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const dir = parseDir();
  const publicPackage = await readJson<Omit<ReviewPackage, "sealed">>(
    path.join(dir, "review-package.json"),
  );
  const sealed = await readJson<SealedIdentities>(
    path.join(dir, "sealed-identities.json"),
  );
  const package_: ReviewPackage = { ...publicPackage, sealed };
  const scores = await readJson<PairwiseScores>(path.join(dir, "scores.json"));
  const bioInspection =
    package_.inputSummary.group === "bio_naturalness"
      ? await readOptionalJson<BioInspectionLedger>(
          path.join(dir, "bio-inspection.json"),
        )
      : undefined;
  const result = unblindReviewPackage({
    ...(bioInspection ? { bioInspection } : {}),
    package: package_,
    scores,
  });
  await writeFile(path.join(dir, "results.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(dir, "adjudication-ledger.json"),
    `${JSON.stringify(
      {
        version: F3_LEDGER_VERSION,
        kind: "pairwise",
        group: result.group,
        manifestFingerprint: result.manifestFingerprint,
        reviewPackageFingerprint: result.reviewPackageFingerprint,
        scorer: scores.scorer,
        scoredAt: scores.scoredAt,
        entries: scores.scenarios,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`[f3-review] revealed ${result.pairwise.overall.scenarios.comparisons} scenario/turn choices`);
  console.log(`[f3-review] result written to ${path.join(dir, "results.json")}`);
  if (result.group === "continuation") {
    const requiredGates = [
      "candidateStrictlyPreferredOverall",
      "localeNoRegression",
      "protectedCategoryNoRegression",
    ];
    const failedGates = requiredGates.filter((name) => {
      const gate = result.gate[name];
      return !isRecord(gate) || gate.passed !== true;
    });
    if (failedGates.length > 0) {
      console.error(`[f3-review] failed continuation gates: ${failedGates.join(", ")}`);
      process.exitCode = 1;
    }
  } else {
    const inspection = result.gate.humanFixedSampleInspection;
    if (!isRecord(inspection) || inspection.completed !== true || inspection.passed !== true) {
      console.error("[f3-review] Bio fixed-sample Luke inspection is incomplete or failed");
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  console.error("[f3-review] unblind failed:", error);
  process.exitCode = 1;
});
