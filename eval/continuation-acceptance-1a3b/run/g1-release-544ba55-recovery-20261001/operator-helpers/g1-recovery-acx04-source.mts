/**
 * Local operator helper: assemble the AC-X04 source document from a genuine
 * completed Continuation capture. It replays the frozen review package's
 * `verifySyntheticRunHardGates` against the actual capture and derives every
 * status field from that replay — nothing is hand-written green.
 *
 * It writes only `<run-root>/evidence-sources/ac-x04.json` with exclusive
 * creation, and never touches the capture or the raw hard-gate report bytes.
 *
 * Usage:
 *   node --import tsx /private/tmp/g1-recovery-acx04-source.mts \
 *     --root <frozen-root> --run-root <run-dir> --catalog <catalog.json>
 *   ... add --verify-only to re-check inputs and the written source without writing.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EVAL = "eval/continuation-acceptance-1a3b";
const HELPER = "/private/tmp/g1-recovery-acx04-source.mts";
const USAGE =
  `node --import tsx ${HELPER} --root <frozen-root> --run-root <run-dir> --catalog <catalog.json> [--verify-only]`;

function fail(message: string): never {
  throw new Error(`${message}\n${USAGE}`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseArgs(argv: readonly string[]) {
  const values = new Map<string, string>();
  let verifyOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if (name === "--verify-only") {
      verifyOnly = true;
      continue;
    }
    if (!["--root", "--run-root", "--catalog"].includes(name)) fail(`unknown argument ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    values.set(name, value);
    index += 1;
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (!value) fail(`${name} is required`);
    return resolve(value);
  };
  return {
    root: required("--root"),
    runRoot: required("--run-root"),
    catalogPath: required("--catalog"),
    verifyOnly,
  };
}

function inside(root: string, path: string, label: string): string {
  const rel = relative(root, path).split("\\").join("/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail(`${label} must stay inside ${root}`);
  return rel;
}

const args = parseArgs(process.argv.slice(2));
inside(args.root, args.runRoot, "--run-root");
inside(args.root, args.catalogPath, "--catalog");

const reviewPackage = await import(pathToFileURL(join(args.root, EVAL, "review-package.ts")).href);
const protocol = await import(pathToFileURL(join(args.root, EVAL, "protocol.ts")).href);

const rawPath = join(args.runRoot, "continuation-hard-gates.json");
const rawBytes = readFileSync(rawPath);
const rawReport = JSON.parse(rawBytes.toString("utf8"));
const capture = readJson(join(args.runRoot, "continuation-capture.json"));
const catalog = readJson(args.catalogPath);
const manifest = readJson(join(args.runRoot, "manifest.json"));
const rawRelPath = inside(args.root, rawPath, "raw hard-gate report");
const rawHash = sha256Hex(rawBytes);

// The AC-X04 report must be the G1 conversation arm over the full 18-fixture pool.
const continuationFixtures = catalog.scenarios.filter((s: any) => s.group === "continuation");
if (continuationFixtures.length !== 18) fail(`catalog has ${continuationFixtures.length} continuation fixtures, expected 18`);
if (capture.group !== "continuation") fail("capture is not a continuation run");
if (capture.configId !== protocol.G1_ACCEPTANCE_HARD_GATE_CONFIG_ID) fail(`capture config ${capture.configId} is not the G1 conversation arm`);
if (capture.arm !== capture.configId) fail(`capture arm ${capture.arm} does not match config ${capture.configId}`);
if (capture.configurationFingerprint !== protocol.configurationFingerprint(manifest.pinnedConfiguration, "continuation", capture.configId)) fail("capture configuration fingerprint does not match the frozen G1 arm pins");
const fixtureIds = continuationFixtures.map((s: any) => s.id);
const captured = new Set(capture.scenarios.map((s: any) => s.fixtureId));
if (capture.scenarios.length !== 18 || captured.size !== 18) fail("capture does not cover exactly 18 distinct fixtures");
if (fixtureIds.some((id: string) => !captured.has(id))) fail("capture is missing a catalog continuation fixture");

// The evidence is only trustworthy if it sits on the frozen commit, catalog, and pins.
const head = execFileSync("git", ["-C", args.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (manifest.gitCommit !== head) fail(`manifest commit ${manifest.gitCommit} does not match frozen HEAD ${head}`);
const dirty = execFileSync("git", ["-C", args.root, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
if (dirty.trim() !== "") fail("frozen tracked source is not clean");
if (manifest.catalog?.version !== catalog.version) fail("manifest catalog version does not match the frozen catalog");
if (manifest.catalog?.sha256 !== protocol.sha256(catalog)) fail("manifest catalog hash does not match the frozen catalog");
if (manifest.pins?.sha256 !== protocol.sha256(manifest.pinnedConfiguration)) fail("manifest pins hash does not match pinnedConfiguration");

const recomputed = reviewPackage.verifySyntheticRunHardGates(catalog, capture);
if (protocol.canonicalJson(recomputed) !== protocol.canonicalJson(rawReport)) fail("recomputed hard-gate report differs from the preserved continuation-hard-gates.json");
const confirmedHardFailures = recomputed.failures.length;
const passed =
  recomputed.passed === true &&
  recomputed.applicable === true &&
  recomputed.checkedFixtureCount === 18 &&
  recomputed.configId === protocol.G1_ACCEPTANCE_HARD_GATE_CONFIG_ID &&
  confirmedHardFailures === 0;
if (!passed) fail(`recomputed G1 continuation report is not a full-pool pass: ${JSON.stringify(recomputed)}`);

const flags = `--root ${args.root} --run-root ${args.runRoot} --catalog ${args.catalogPath}`;
const sourcePath = join(args.runRoot, "evidence-sources", "ac-x04.json");
const source = {
  artifactPath: rawRelPath,
  artifactSha256: rawHash,
  command: `node --import tsx ${HELPER} ${flags}`,
  criterion: "AC-X04",
  fixtureIds,
  owner: "SayHear CI",
  passed,
  result: {
    confirmedHardFailures,
    rawArtifactHash: rawHash,
    automatedAlertCheck: { source: "raw-artifact", confirmedHardFailures },
    passed,
  },
  runId: `continuation-hard-gates:${rawHash}`,
  source: "local",
  verification: { command: `node --import tsx ${HELPER} ${flags} --verify-only`, passed },
};

if (args.verifyOnly) {
  if (!existsSync(sourcePath)) fail(`${sourcePath} does not exist; run without --verify-only first`);
  const existing = readJson(sourcePath);
  if (protocol.canonicalJson(existing) !== protocol.canonicalJson(source)) {
    fail("--verify-only failed: written ac-x04.json does not match the replayed source document");
  }
  console.log(`verify-only ok: ${rawRelPath} sha256=${rawHash} confirmedHardFailures=${confirmedHardFailures}`);
} else {
  mkdirSync(join(args.runRoot, "evidence-sources"), { recursive: true });
  writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`, { flag: "wx" });
  console.log(`wrote ${sourcePath} (artifact ${rawRelPath} sha256=${rawHash}, confirmedHardFailures=${confirmedHardFailures})`);
}
