import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = resolve(root, "artifacts/pr-approval/build");
const manifest = JSON.parse(await readFile(resolve(buildDirectory, "manifest.json"), "utf8"));
const bundlePath = resolve(buildDirectory, "controller.mjs");
const digest = createHash("sha256").update(await readFile(bundlePath)).digest("hex");
if (digest !== manifest.controllerSha256) throw new Error("The bundle does not match its manifest.");
const bundle = await import(pathToFileURL(bundlePath).href);
const identity = bundle.controllerBuildIdentity();
if (identity.sourceCommit !== manifest.sourceCommit || identity.completionVersion !== "sayhear-pr-completion:v1" ||
    identity.diffCollectionVersion !== "sayhear-pr-diff:v2" || identity.baseSyncHandoffVersion !== "sayhear-pr-base-sync:v1" ||
    identity.browserApprovalVersion !== "sayhear-pr-browser-approval:v1" || manifest.browserApprovalVersion !== undefined) {
  throw new Error("The bundle's source or capability identity does not match.");
}
if (typeof manifest.sourceDiffSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sourceDiffSha256) ||
    identity.sourceDiffSha256 !== manifest.sourceDiffSha256) {
  throw new Error("The bundle's source tree fingerprint does not match.");
}
for (const input of manifest.inputs) {
  const info = await stat(resolve(root, input.path)).catch(() => null);
  if (!info?.isFile()) throw new Error(`A manifest input is missing: ${input.path}`);
  const inputDigest = createHash("sha256").update(await readFile(resolve(root, input.path))).digest("hex");
  if (inputDigest !== input.sha256) throw new Error(`A manifest input changed after the build: ${input.path}`);
}
const configPath = resolve(buildDirectory, "bundle-vitest.config.mjs");
await writeFile(configPath, `export default ${JSON.stringify({
  root,
  resolve: { alias: {
    "../scripts/pr-approval-controller.ts": bundlePath,
    "../scripts/pr-approval/completion.ts": bundlePath,
    "../scripts/pr-approval/browser-approval.ts": bundlePath,
    "../scripts/pr-approval/signed-store.ts": bundlePath,
    "../scripts/pr-approval/diff.ts": bundlePath,
    "../scripts/pr-review-gate.ts": bundlePath,
    "../scripts/daily-release-validation.ts": bundlePath,
  } },
  test: { include: ["tests/pr-approval-controller.test.ts", "tests/pr-approval-completion.test.ts", "tests/pr-approval-diff.test.ts", "tests/pr-approval-browser-approval.test.ts", "tests/pr-review-gate.test.ts"] },
})};\n`);
const run = await promisify(execFile)(process.execPath, [resolve(root, "node_modules/vitest/vitest.mjs"), "run", "--config", configPath], { cwd: root, maxBuffer: 4_000_000, env: { ...process.env, SAYHEAR_COMPLETION_BUNDLE_TEST: "1" } });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
await mkdir(resolve(root, ".audit/pr-approval-v5-tests"), { recursive: true });
await writeFile(resolve(root, ".audit/pr-approval-v5-tests/bundle-proof.json"), JSON.stringify({ identity, digest, manifest }, null, 2));
