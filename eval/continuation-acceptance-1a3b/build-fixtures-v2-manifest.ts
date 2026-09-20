/**
 * Build the v2 fixture catalog manifest: hashes every scene file so the
 * capture and verifier fail closed on any drift.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  F3_V2_CATALOG_VERSION,
  type V2CatalogManifest,
} from "./protocol-v2";

const SCENES_DIR = "eval/continuation-acceptance-1a3b/fixtures-v2";
const OUTPUT = "eval/continuation-acceptance-1a3b/fixtures-v2.json";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main(): Promise<void> {
  const directory = resolve(process.cwd(), SCENES_DIR);
  const entries = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const sceneFiles = [];
  for (const name of entries) {
    const path = `${SCENES_DIR}/${name}`;
    const raw = await readFile(resolve(process.cwd(), path), "utf8");
    JSON.parse(raw);
    sceneFiles.push({ path, sha256: sha256(raw) });
  }
  const manifest: V2CatalogManifest = {
    version: F3_V2_CATALOG_VERSION,
    synthetic: true,
    syntheticNotice:
      "Synthetic evaluation fixtures only. No real user data or production content.",
    sceneFiles,
  };
  await writeFile(
    resolve(process.cwd(), OUTPUT),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `[g2-v2-fixtures] wrote ${sceneFiles.length} scene hashes to ${OUTPUT}`,
  );
}

main().catch((error: unknown) => {
  console.error("[g2-v2-fixtures] failed:", error);
  process.exitCode = 1;
});
