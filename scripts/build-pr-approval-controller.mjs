import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, version as esbuildVersion } from "esbuild";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(repositoryRoot, "artifacts/pr-approval/build");
const controllerPath = resolve(outputDirectory, "controller.mjs");
const nodePath = resolve(outputDirectory, "node");
const launchers = [
  { mode: 1, name: "pr-approval-status" },
  { mode: 2, name: "pr-approval-prepare" },
  { mode: 3, name: "pr-approval-submit" },
  { mode: 4, name: "pr-approval-configure" },
  { mode: 5, name: "pr-approval-scan" },
];

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The protected PR approval runtime build currently requires Apple Silicon macOS.");
}

const pinnedNodeVersion = (await readFile(resolve(repositoryRoot, ".node-version"), "utf8")).trim();
if (process.version !== `v${pinnedNodeVersion}`) {
  throw new Error(`Refusing build: runtime ${process.version} does not match .node-version v${pinnedNodeVersion}.`);
}

// Clean same-commit source only.
async function assertCleanSource() {
  const trackedNames = (await execFileAsync("git", ["diff", "HEAD", "--name-only", "-z"], { cwd: repositoryRoot })).stdout
    .split("\0").filter(Boolean).sort();
  if (trackedNames.length > 0) {
    throw new Error(`Refusing dirty build: tracked source changes present: ${trackedNames.slice(0, 20).join(", ")}${trackedNames.length > 20 ? ` (+${trackedNames.length - 20} more)` : ""}. Rebuild from clean committed source.`);
  }
  const untrackedNames = (await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repositoryRoot })).stdout
    .split("\0").filter(Boolean)
    .filter((path) => !path.startsWith(".audit/") && !path.startsWith("artifacts/") && !path.split("/").includes("node_modules"))
    .sort();
  if (untrackedNames.length > 0) {
    throw new Error(`Refusing dirty build: untracked source files present: ${untrackedNames.slice(0, 20).join(", ")}${untrackedNames.length > 20 ? ` (+${untrackedNames.length - 20} more)` : ""}. Rebuild from clean committed source.`);
  }
}

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const sourceCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })).stdout.trim();
await assertCleanSource();
const sourceDiffSha256 = createHash("sha256").update("").digest("hex");
const expectedPolicyVersion = "sayhear-pr-review-gate:v12";
const expectedReportVersion = "sayhear-pr-review-report:v5";
const expectedCompletionVersion = "sayhear-pr-completion:v1";
const expectedDiffCollectionVersion = "sayhear-pr-diff:v2";
const expectedBaseSyncHandoffVersion = "sayhear-pr-base-sync:v1";
const expectedBrowserApprovalVersion = "sayhear-pr-browser-approval:v1";
const expectedHumanFinalDecisionVersion = "final-decision-v1";
const buildInfo = { sourceCommit, sourceDiffSha256, nodeVersion: process.version, esbuildVersion };
const bundle = await build({
  metafile: true,
  define: { __PR_APPROVAL_BUILD_INFO__: JSON.stringify(buildInfo) },
  entryPoints: [resolve(repositoryRoot, "scripts/pr-approval-controller.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: controllerPath,
  sourcemap: false,
  packages: "bundle",
  legalComments: "none",
});

await copyFile(process.execPath, nodePath);
await chmod(nodePath, 0o755);
const bundledNodeVersion = await execFileAsync(nodePath, ["--version"]);
if (bundledNodeVersion.stdout.trim() !== process.version) {
  throw new Error("The copied Node runtime does not match the build runtime.");
}
for (const launcher of launchers) {
  const launcherPath = resolve(outputDirectory, launcher.name);
  await execFileAsync("/usr/bin/clang", [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-O2",
    `-DPR_APPROVAL_MODE=${launcher.mode}`,
    resolve(repositoryRoot, "scripts/pr-approval-launcher.c"),
    "-o",
    launcherPath,
  ]);
  await chmod(launcherPath, 0o755);
}

const digest = async (path) =>
  createHash("sha256").update(await readFile(path)).digest("hex");
await assertCleanSource();
const manifest = {
  version: 4,
  ...buildInfo,
  policyVersion: expectedPolicyVersion,
  reportVersion: expectedReportVersion,
  completionVersion: expectedCompletionVersion,
  diffCollectionVersion: expectedDiffCollectionVersion,
  baseSyncHandoffVersion: expectedBaseSyncHandoffVersion,
  browserApprovalVersion: expectedBrowserApprovalVersion,
  humanFinalDecisionVersion: expectedHumanFinalDecisionVersion,
  inputs: await Promise.all(Array.from(new Set([
    ...Object.keys(bundle.metafile.inputs).filter((path) => !path.startsWith("<")),
    "scripts/build-pr-approval-controller.mjs",
    "scripts/verify-pr-approval-bundle.mjs",
    "scripts/pr-approval-launcher.c",
    ".node-version",
    "pnpm-lock.yaml",
    "package.json",
    "tsconfig.base.json",
  ])).sort().map(async (path) => {
    if (path.includes("\0") || resolve(repositoryRoot, path) !== `${repositoryRoot}/${path}` || path.startsWith("/") || path.startsWith("..")) {
      throw new Error(`Refusing build: manifest input escapes the repository: ${path}`);
    }
    return { path, sha256: await digest(resolve(repositoryRoot, path)) };
  })),
  clangVersion: (await execFileAsync("/usr/bin/clang", ["--version"])).stdout.split("\n")[0],
  nodeVersion: process.version,
  architecture: process.arch,
  controllerSha256: await digest(controllerPath),
  launchers: await Promise.all(
    launchers.map(async ({ name }) => ({
      name,
      sha256: await digest(resolve(outputDirectory, name)),
    })),
  ),
  nodeSha256: await digest(nodePath),
};
await writeFile(
  resolve(outputDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
