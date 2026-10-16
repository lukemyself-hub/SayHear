import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDirectory = resolve(root, "artifacts/pr-approval/build");
const manifest = JSON.parse(await readFile(resolve(buildDirectory, "manifest.json"), "utf8"));
if (manifest.version !== 4) throw new Error("The bundle manifest version does not match the clean-source build.");
const bundlePath = resolve(buildDirectory, "controller.mjs");
const digest = createHash("sha256").update(await readFile(bundlePath)).digest("hex");
if (digest !== manifest.controllerSha256) throw new Error("The bundle does not match its manifest.");
const bundle = await import(pathToFileURL(bundlePath).href);
const identity = bundle.controllerBuildIdentity();
const expected = {
  policyVersion: "sayhear-pr-review-gate:v12",
  reportVersion: "sayhear-pr-review-report:v5",
  completionVersion: "sayhear-pr-completion:v1",
  diffCollectionVersion: "sayhear-pr-diff:v2",
  baseSyncHandoffVersion: "sayhear-pr-base-sync:v1",
  browserApprovalVersion: "sayhear-pr-browser-approval:v1",
  humanFinalDecisionVersion: "final-decision-v1",
};
const CLEAN_SOURCE_DIFF_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
if (manifest.policyVersion !== expected.policyVersion || manifest.reportVersion !== expected.reportVersion ||
    manifest.completionVersion !== expected.completionVersion || manifest.diffCollectionVersion !== expected.diffCollectionVersion ||
    manifest.baseSyncHandoffVersion !== expected.baseSyncHandoffVersion || manifest.browserApprovalVersion !== expected.browserApprovalVersion ||
    manifest.humanFinalDecisionVersion !== expected.humanFinalDecisionVersion) {
  throw new Error("The manifest capability identity is not the v12 target.");
}
if (bundle.PR_REVIEW_GATE_POLICY_VERSION !== expected.policyVersion || bundle.PR_REVIEW_REPORT_VERSION !== expected.reportVersion ||
    bundle.BROWSER_APPROVAL_VERSION !== expected.browserApprovalVersion) {
  throw new Error("The bundled controller/gate capability identity is not the v12 target.");
}
if (identity.sourceCommit !== manifest.sourceCommit || identity.policyVersion !== expected.policyVersion ||
    identity.reportVersion !== expected.reportVersion || identity.humanFinalDecisionVersion !== expected.humanFinalDecisionVersion ||
    identity.completionVersion !== expected.completionVersion ||
    identity.diffCollectionVersion !== expected.diffCollectionVersion || identity.baseSyncHandoffVersion !== expected.baseSyncHandoffVersion ||
    identity.browserApprovalVersion !== expected.browserApprovalVersion) {
  throw new Error("The bundle's source or capability identity does not match.");
}
if (typeof manifest.sourceDiffSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sourceDiffSha256) ||
    identity.sourceDiffSha256 !== manifest.sourceDiffSha256) {
  throw new Error("The bundle's source tree fingerprint does not match.");
}
// Clean same-commit source only.
if (manifest.sourceDiffSha256 !== CLEAN_SOURCE_DIFF_SHA256 || identity.sourceDiffSha256 !== CLEAN_SOURCE_DIFF_SHA256) {
  throw new Error("The bundle was not built from clean source.");
}
if (!/^[0-9a-f]{40}$/.test(manifest.sourceCommit) || identity.sourceCommit !== manifest.sourceCommit) {
  throw new Error("The bundle's source commit identity does not match.");
}
const actualHead = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
if (actualHead !== manifest.sourceCommit) {
  throw new Error("The bundle source commit does not match the current commit.");
}
if (!Array.isArray(manifest.inputs) || manifest.inputs.length === 0) {
  throw new Error("The manifest source input list is missing.");
}
for (const requiredInput of ["scripts/pr-approval-controller.ts", "scripts/pr-review-gate.ts", "scripts/daily-release-validation.ts", "scripts/build-pr-approval-controller.mjs", "scripts/verify-pr-approval-bundle.mjs", "scripts/pr-approval-launcher.c", ".node-version", "pnpm-lock.yaml", "package.json", "tsconfig.base.json"]) {
  if (!manifest.inputs.some((entry) => entry?.path === requiredInput && typeof entry?.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256))) {
    throw new Error(`The manifest source input list is incomplete: ${requiredInput}`);
  }
}
if (typeof bundle.controllerBuildIdentity !== "function" || typeof bundle.evaluatePrReviewGate !== "function") {
  throw new Error("The bundled controller/gate exports are missing.");
}
for (const input of manifest.inputs) {
  if (typeof input?.path !== "string" || input.path.includes("\0") || input.path.startsWith("/") || input.path.startsWith("..") || resolve(root, input.path) !== `${root}/${input.path}`) throw new Error(`A manifest input escapes the repository: ${input?.path}`);
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
