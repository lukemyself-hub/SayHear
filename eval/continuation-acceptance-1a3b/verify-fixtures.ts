import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  F3_CATALOG_VERSION,
  type FixtureCatalog,
} from "./protocol";
import { verifyFixtureCatalog } from "./manifest";

const defaultCatalogPath = path.resolve(
  import.meta.dirname,
  "fixtures.json",
);

function catalogPathFromArgs(): string {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 0) return defaultCatalogPath;
  if (arguments_.length === 2 && arguments_[0] === "--catalog") {
    return arguments_[1]!;
  }
  throw new Error("Usage: verify-fixtures.ts [--catalog <fixtures.json>]");
}

async function main(): Promise<void> {
  const catalogPath = catalogPathFromArgs();
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as FixtureCatalog;
  const verification = verifyFixtureCatalog(catalog);
  console.log(
    `catalog=${catalogPath} version=${catalog.version ?? F3_CATALOG_VERSION} ` +
      `continuation=${verification.counts.continuation} ` +
      `bio=${verification.counts.bio_naturalness} ` +
      `validator=${verification.counts.validator}`,
  );
  if (!verification.passed) {
    for (const mismatch of verification.mismatches) console.error(`MISMATCH ${mismatch}`);
    process.exitCode = 1;
    return;
  }
  console.log("fixture verification: OK — complete synthetic pool and quotas are valid");
}

main().catch((error: unknown) => {
  console.error("[f3-fixtures] verification failed:", error);
  process.exitCode = 1;
});
