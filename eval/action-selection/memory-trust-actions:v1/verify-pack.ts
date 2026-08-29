/**
 * Verify the synthetic trust-action selection pack and, when supplied, a
 * normalized selection result file. This command never calls a model, the
 * Action Gateway, or a database.
 *
 *   pnpm exec tsx eval/action-selection/memory-trust-actions:v1/verify-pack.ts
 *   pnpm exec tsx eval/action-selection/memory-trust-actions:v1/verify-pack.ts \
 *     --results /path/to/action-selection-results.json
 */
import { readFile } from "node:fs/promises";

import {
  verifySelectionDataset,
  verifySelectionResults,
} from "./selection-checks";

const DEFAULT_PACK_PATH =
  "eval/action-selection/memory-trust-actions:v1/scenarios.json";

type CliArgs = Readonly<{
  packPath: string;
  resultsPath?: string;
}>;

function parseArgs(args: readonly string[]): CliArgs {
  let packPath: string | undefined;
  let resultsPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--results") {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--results requires a JSON file path");
      }
      resultsPath = next;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option: ${argument}`);
    } else if (packPath === undefined) {
      packPath = argument;
    } else {
      throw new Error(`only one pack path is supported; got ${argument}`);
    }
  }

  return { packPath: packPath ?? DEFAULT_PACK_PATH, resultsPath };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function main(): Promise<void> {
  const { packPath, resultsPath } = parseArgs(process.argv.slice(2));
  const dataset = await readJson(packPath);
  const datasetVerification = verifySelectionDataset(dataset);

  console.log(
    `dataset=${packPath} fixtures=${datasetVerification.fixtureCount} headroom=${datasetVerification.headroom}`,
  );
  for (const [category, counts] of Object.entries(datasetVerification.counts)) {
    console.log(
      `quota ${category}: total=${counts.total} en=${counts.languages.en} zh=${counts.languages.zh} code_switch=${counts.languages.code_switch}`,
    );
  }
  if (datasetVerification.mismatches.length === 0) {
    console.log("dataset verification: OK");
  } else {
    for (const mismatch of datasetVerification.mismatches) {
      console.error(
        `MISMATCH ${mismatch.fixtureId ?? "<dataset>"} ${mismatch.code}: ${mismatch.detail}`,
      );
    }
  }

  if (resultsPath !== undefined) {
    const resultFile = await readJson(resultsPath);
    const resultVerification = verifySelectionResults({ dataset, resultFile });
    console.log(
      `results=${resultsPath} fixtures=${resultVerification.fixtureCount} results=${resultVerification.resultCount} conformance=${resultVerification.conformance} wrongTarget=${resultVerification.wrongTarget} falseSuccess=${resultVerification.falseSuccess}`,
    );
    if (resultVerification.mismatches.length === 0) {
      console.log("result verification: OK");
    } else {
      for (const mismatch of resultVerification.mismatches) {
        console.error(
          `MISMATCH ${mismatch.fixtureId ?? "<results>"} ${mismatch.code}: ${mismatch.detail}`,
        );
      }
    }
    if (!resultVerification.passed) process.exitCode = 1;
  }

  if (!datasetVerification.passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
