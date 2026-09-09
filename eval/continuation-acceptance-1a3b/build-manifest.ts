import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  F3_CATALOG_VERSION,
  type BaselineReference,
  type FixtureCatalog,
  type F3Pins,
} from "./protocol";
import { buildManifest } from "./manifest";

const root = path.resolve(import.meta.dirname, "../..");
const defaultCatalogPath = path.join(
  root,
  "eval/continuation-acceptance-1a3b/fixtures.json",
);
const defaultPinsPath = path.join(
  root,
  "eval/continuation-acceptance-1a3b/pins.json",
);
const defaultBaselinePath = path.join(
  root,
  "eval/continuation-acceptance-1a3b/baseline-reference.json",
);

type Arguments = Readonly<{
  baselinePath: string;
  catalogPath: string;
  commands: readonly string[];
  fixtureSeed: number;
  gitCommit: string | null;
  outPath: string;
  pinsPath: string;
  sampleSeed: number;
}>;

function required(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

function parseArguments(): Arguments {
  const arguments_ = process.argv.slice(2);
  const values = {
    baselinePath: defaultBaselinePath,
    catalogPath: defaultCatalogPath,
    commands: [] as string[],
    fixtureSeed: 196,
    gitCommit: null as string | null,
    outPath: path.join(
      root,
      "eval/continuation-acceptance-1a3b/run/manifest.json",
    ),
    pinsPath: defaultPinsPath,
    sampleSeed: 1960,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--catalog") values.catalogPath = required(arguments_, ++index, argument);
    else if (argument === "--pins") values.pinsPath = required(arguments_, ++index, argument);
    else if (argument === "--baseline") values.baselinePath = required(arguments_, ++index, argument);
    else if (argument === "--out") values.outPath = required(arguments_, ++index, argument);
    else if (argument === "--seed") values.fixtureSeed = Number(required(arguments_, ++index, argument));
    else if (argument === "--sample-seed") values.sampleSeed = Number(required(arguments_, ++index, argument));
    else if (argument === "--git-commit") values.gitCommit = required(arguments_, ++index, argument);
    else if (argument === "--command") values.commands.push(required(arguments_, ++index, argument));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return values;
}

function currentCommit(): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function workingTreeIsDirty(): boolean {
  return execFileSync("git", ["-C", root, "status", "--porcelain"], {
    encoding: "utf8",
  }).trim().length > 0;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function main(): Promise<void> {
  const arguments_ = parseArguments();
  const catalog = await readJson<FixtureCatalog>(arguments_.catalogPath);
  const pins = await readJson<F3Pins>(arguments_.pinsPath);
  const baseline = await readJson<BaselineReference>(arguments_.baselinePath);
  const gitCommit = arguments_.gitCommit ?? currentCommit();
  if (!arguments_.gitCommit && workingTreeIsDirty()) {
    throw new Error("The working tree is dirty; pass --git-commit for an explicitly reviewed frozen commit.");
  }
  const commands =
    arguments_.commands.length > 0
      ? arguments_.commands
      : [
          "pnpm exec tsx eval/continuation-acceptance-1a3b/verify-fixtures.ts",
          `pnpm exec tsx eval/continuation-acceptance-1a3b/build-manifest.ts --seed ${arguments_.fixtureSeed} --sample-seed ${arguments_.sampleSeed} --git-commit ${gitCommit}`,
        ];
  const manifest = buildManifest({
    baseline,
    catalog,
    catalogPath: path.relative(root, arguments_.catalogPath),
    commands,
    fixtureSeed: arguments_.fixtureSeed,
    gitCommit,
    pins,
    pinsPath: path.relative(root, arguments_.pinsPath),
    sampleSeed: arguments_.sampleSeed,
  });
  await mkdir(path.dirname(arguments_.outPath), { recursive: true });
  await writeFile(arguments_.outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `[f3-manifest] ${manifest.status}; catalog ${manifest.catalog.sha256}; ` +
      `continuation sample ${manifest.continuation.sample.scenarioIds.length}; ` +
      `fingerprint ${manifest.fingerprint}`,
  );
  console.log(`[f3-manifest] wrote ${path.relative(root, arguments_.outPath)}`);
  if (catalog.version !== F3_CATALOG_VERSION) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("[f3-manifest] build failed:", error);
  process.exitCode = 1;
});
