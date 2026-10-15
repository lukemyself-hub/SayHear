import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
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

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const sourceCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })).stdout.trim();
// sourceCommit alone cannot prove this delivery: the v5 source is uncommitted
// work on top of that commit, so the identity also fingerprints the tree.
const sourceDiff = (await execFileAsync("git", ["diff", "HEAD", "--binary"], { cwd: repositoryRoot, maxBuffer: 64_000_000 })).stdout;
const untrackedCandidates = (await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repositoryRoot })).stdout
  .split("\n").filter(Boolean)
  .filter((path) => !path.startsWith(".audit/") && !path.startsWith("artifacts/") && !path.split("/").includes("node_modules"))
  .sort();
const sourceHasher = createHash("sha256").update(sourceDiff);
for (const path of untrackedCandidates) {
  // Only regular files enter the fingerprint. Symlinks and directories cannot
  // be read and are not source inputs.
  const info = await lstat(resolve(repositoryRoot, path)).catch(() => null);
  if (!info?.isFile()) continue;
  sourceHasher.update(path).update("\0").update(await readFile(resolve(repositoryRoot, path)));
}
const sourceDiffSha256 = sourceHasher.digest("hex");
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
const manifest = {
  version: 3,
  ...buildInfo,
  inputs: await Promise.all(Object.keys(bundle.metafile.inputs).filter((path) => !path.startsWith("<")).sort().map(async (path) => ({ path, sha256: await digest(resolve(repositoryRoot, path)) }))),
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
