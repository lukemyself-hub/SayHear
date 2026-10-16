import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat, lstat } from "node:fs/promises";
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
// Pinned artifact runtime proof: the exact copied node and launcher bytes.
const EXPECTED_NODE_VERSION = "v24.18.0";
const EXPECTED_LAUNCHERS = ["pr-approval-status", "pr-approval-prepare", "pr-approval-submit", "pr-approval-configure", "pr-approval-scan"];
const pinnedNodeVersion = (await readFile(resolve(root, ".node-version"), "utf8")).trim();
if (pinnedNodeVersion !== EXPECTED_NODE_VERSION.slice(1)) throw new Error("The runtime pin does not match the expected Node version.");
if (manifest.nodeVersion !== EXPECTED_NODE_VERSION || identity.nodeVersion !== EXPECTED_NODE_VERSION) {
  throw new Error("The bundle runtime version does not match the expected Node version.");
}
if (typeof manifest.nodeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.nodeSha256)) {
  throw new Error("The manifest Node digest is missing.");
}
if (!Array.isArray(manifest.launchers) || manifest.launchers.length !== EXPECTED_LAUNCHERS.length) {
  throw new Error("The manifest launcher set is incomplete.");
}
const seenLaunchers = new Set();
for (const entry of manifest.launchers) {
  if (typeof entry?.name !== "string" || !EXPECTED_LAUNCHERS.includes(entry.name) || seenLaunchers.has(entry.name) ||
      typeof entry?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error("The manifest launcher set is invalid.");
  }
  seenLaunchers.add(entry.name);
}
for (const expectedLauncher of EXPECTED_LAUNCHERS) {
  if (!seenLaunchers.has(expectedLauncher)) throw new Error(`The manifest launcher set is incomplete: ${expectedLauncher}`);
}
const digestBuildArtifact = async (name) => {
  const artifactPath = resolve(buildDirectory, name);
  if (artifactPath !== `${buildDirectory}/${name}`) throw new Error(`A bundled artifact escapes the build directory: ${name}`);
  const artifactInfo = await lstat(artifactPath).catch(() => null);
  if (!artifactInfo || artifactInfo.isSymbolicLink() || !artifactInfo.isFile()) {
    throw new Error(`A bundled artifact is not a regular file: ${name}`);
  }
  return { artifactPath, sha256: createHash("sha256").update(await readFile(artifactPath)).digest("hex") };
};
const copiedNode = await digestBuildArtifact("node");
if (copiedNode.sha256 !== manifest.nodeSha256) throw new Error("The copied Node runtime does not match its manifest.");
const copiedNodeVersion = (await promisify(execFile)(copiedNode.artifactPath, ["--version"])).stdout.trim();
if (copiedNodeVersion !== EXPECTED_NODE_VERSION) throw new Error("The copied Node runtime version does not match.");
for (const entry of manifest.launchers) {
  const launcher = await digestBuildArtifact(entry.name);
  if (launcher.sha256 !== entry.sha256) throw new Error(`A bundled launcher does not match its manifest: ${entry.name}`);
}
const CLEAN_TREE_UNTRACKED_EXCLUSIONS = [".audit/", "artifacts/", "node_modules"];
async function assertCleanTree() {
  const tracked = (await promisify(execFile)("git", ["diff", "HEAD", "--name-only", "-z"], { cwd: root })).stdout
    .split("\0").filter(Boolean).sort();
  if (tracked.length > 0) {
    throw new Error(`Refusing to verify a bundle against dirty source: tracked changes present: ${tracked.slice(0, 20).join(", ")}${tracked.length > 20 ? ` (+${tracked.length - 20} more)` : ""}. Verify from clean committed source.`);
  }
  const untracked = (await promisify(execFile)("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root })).stdout
    .split("\0").filter(Boolean)
    .filter((path) => !CLEAN_TREE_UNTRACKED_EXCLUSIONS.some((exclusion) => exclusion.endsWith("/") ? path.startsWith(exclusion) : path.split("/").includes(exclusion)))
    .sort();
  if (untracked.length > 0) {
    throw new Error(`Refusing to verify a bundle against dirty source: untracked source files present: ${untracked.slice(0, 20).join(", ")}${untracked.length > 20 ? ` (+${untracked.length - 20} more)` : ""}. Verify from clean committed source.`);
  }
}
// Same clean-tree refusal as the build: the bundle tests must run against the
// same committed source the manifest input digests were taken from.
await assertCleanTree();
const configPath = resolve(buildDirectory, "bundle-vitest.config.mjs");
// integration-refresh / merge-ref-rebuild are bundled into controller.mjs via
// the controller imports; they have no bundle re-export, so their suites run
// against source here (the controller suite still proves them inside the bundle).
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
  test: { include: ["tests/pr-approval-controller.test.ts", "tests/pr-approval-completion.test.ts", "tests/pr-approval-diff.test.ts", "tests/pr-approval-browser-approval.test.ts", "tests/pr-approval-integration-refresh.test.ts", "tests/pr-approval-merge-ref-rebuild.test.ts", "tests/pr-review-gate.test.ts"] },
})};\n`);
const run = await promisify(execFile)(copiedNode.artifactPath, [resolve(root, "node_modules/vitest/vitest.mjs"), "run", "--config", configPath], { cwd: root, maxBuffer: 4_000_000, env: { ...process.env, SAYHEAR_COMPLETION_BUNDLE_TEST: "1" } });
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
await mkdir(resolve(root, ".audit/pr-approval-v5-tests"), { recursive: true });
await writeFile(resolve(root, ".audit/pr-approval-v5-tests/bundle-proof.json"), JSON.stringify({ identity, digest, manifest }, null, 2));
