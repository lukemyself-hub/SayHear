/**
 * Operator assembler for the recovered AC-W01 hosted evidence.
 *
 * The hosted exporter passed, and the producer artifact `evidence/ac-w01.json`
 * is a validated pass, but the producer dropped two fields the final verifier
 * needs: `result.expectedRunIds` and `result.canaryValuesArtifact`. Its source
 * document `evidence-sources/ac-w01.json` still carries both. This helper
 * copies exactly those two fields into an in-memory clone of the producer
 * artifact, re-runs the frozen `verifyHostedCanaryArtifact` (which re-reads and
 * re-scans the raw export/values references), and writes:
 *   - evidence/ac-w01-final.json               (exclusive create, new sha256)
 *   - g1-release-manifest-final-input.json     (exclusive create, only AC-W01
 *                                               artifactPath/artifactSha256 changed)
 * Originals `evidence/ac-w01.json` and `g1-release-manifest-input.json` are
 * never written. No passed=true is hand-written: the pass state is inherited
 * from the already-validated producer artifact.
 *
 * Usage:
 *   <node24> --import tsx /Users/lukemyself/.local/share/opencode/tool-output/g1-recovery-hosted-fields.mts \
 *     --root <frozen-root> --run-root <run-dir>
 *   ... add --verify-only to re-check the final files and re-run the verifier.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SELF = "/Users/lukemyself/.local/share/opencode/tool-output/g1-recovery-hosted-fields.mts";
const USAGE = `node --import tsx ${SELF} --root <frozen-root> --run-root <run-dir> [--verify-only]`;

function fail(message: string): never {
  throw new Error(`${message}\n${USAGE}`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
    if (name !== "--root" && name !== "--run-root") fail(`unknown argument ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    values.set(name, value);
    index += 1;
  }
  for (const name of ["--root", "--run-root"]) if (!values.has(name)) fail(`${name} is required`);
  return { root: resolve(values.get("--root")!), runRoot: resolve(values.get("--run-root")!), verifyOnly };
}

function inside(root: string, path: string, label: string): string {
  const rel = relative(root, path).split("\\").join("/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) fail(`${label} must stay inside ${root}`);
  return rel;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  inside(args.root, args.runRoot, "--run-root");
  const verifier = await import(pathToFileURL(join(args.root, "scripts/verify-1a3b-g1-evidence.ts")).href);
  const protocol = await import(pathToFileURL(join(args.root, "eval/continuation-acceptance-1a3b/protocol.ts")).href);
  const sameJson = (left: unknown, right: unknown): boolean => protocol.canonicalJson(left) === protocol.canonicalJson(right);

  const sourcePath = join(args.runRoot, "evidence-sources", "ac-w01.json");
  const destPath = join(args.runRoot, "evidence", "ac-w01.json");
  const inputPath = join(args.runRoot, "g1-release-manifest-input.json");
  const finalArtifactPath = join(args.runRoot, "evidence", "ac-w01-final.json");
  const finalInputPath = join(args.runRoot, "g1-release-manifest-final-input.json");
  const source = readJson(sourcePath);
  const dest = readJson(destPath);
  const input = readJson(inputPath);

  // Inherit the already-validated pass; never invent a green result.
  if (source.criterion !== "AC-W01" || dest.criterion !== "AC-W01") fail("source and destination must both be AC-W01");
  if (source.passed !== true || source.result?.passed !== true) fail("source AC-W01 document is not a validated pass");
  if (dest.status !== "passed" || dest.result?.passed !== true) fail("destination AC-W01 artifact is not a validated pass");
  if (!Array.isArray(source.result.expectedRunIds) || source.result.expectedRunIds.length === 0) fail("source AC-W01 has no expectedRunIds");
  if (typeof source.result.canaryValuesArtifact !== "object" || source.result.canaryValuesArtifact === null) fail("source AC-W01 has no canaryValuesArtifact");

  // Every shared reference must already agree before anything is copied.
  for (const key of Object.keys(source.result)) {
    if (key in dest.result && !sameJson(source.result[key], dest.result[key])) {
      fail(`source and destination disagree on result.${key}`);
    }
  }
  if (dest.result.sourceArtifactPath !== source.artifactPath || dest.result.sourceArtifactSha256 !== source.artifactSha256) {
    fail("destination source-artifact reference does not match the source document");
  }
  if (dest.result.verificationCommand !== source.verification?.command || dest.command !== source.command) {
    fail("destination command lineage does not match the source document");
  }

  // The only mutation: the two fields the producer dropped.
  const updated = clone(dest);
  updated.result.expectedRunIds = clone(source.result.expectedRunIds);
  updated.result.canaryValuesArtifact = clone(source.result.canaryValuesArtifact);
  verifier.verifyHostedCanaryArtifact(updated, args.root);

  const finalBytes = Buffer.from(`${JSON.stringify(updated, null, 2)}\n`, "utf8");
  const finalHash = sha256Hex(finalBytes);
  const finalRel = inside(args.root, finalArtifactPath, "final artifact");

  const finalInput = clone(input);
  if (!Array.isArray(finalInput.evidence)) fail("manifest input evidence must be an array");
  const entries = finalInput.evidence.filter((entry: any) => entry?.criterion === "AC-W01");
  if (entries.length !== 1) fail(`manifest input must carry exactly one AC-W01 entry (found ${entries.length})`);
  const originalEntry = clone(entries[0]);
  entries[0].artifactPath = finalRel;
  entries[0].artifactSha256 = finalHash;
  // Prove nothing else in the manifest input moved.
  const reverted = clone(finalInput);
  const revertedEntry = reverted.evidence.find((entry: any) => entry?.criterion === "AC-W01");
  revertedEntry.artifactPath = originalEntry.artifactPath;
  revertedEntry.artifactSha256 = originalEntry.artifactSha256;
  if (!sameJson(reverted, input)) fail("final manifest input changes more than the AC-W01 artifact path/hash");

  if (args.verifyOnly) {
    if (!existsSync(finalArtifactPath) || !existsSync(finalInputPath)) fail("final AC-W01 files do not exist; run the writer first");
    const writtenArtifactBytes = readFileSync(finalArtifactPath);
    const writtenInput = readJson(finalInputPath);
    if (sha256Hex(writtenArtifactBytes) !== finalHash) fail("ac-w01-final.json hash does not match the expected extended artifact");
    if (!sameJson(JSON.parse(writtenArtifactBytes.toString("utf8")), updated)) fail("ac-w01-final.json content does not match the expected extended artifact");
    if (!sameJson(writtenInput, finalInput)) fail("g1-release-manifest-final-input.json does not match the expected updated input");
    const writtenEntry = writtenInput.evidence.find((entry: any) => entry?.criterion === "AC-W01");
    if (writtenEntry.artifactPath !== finalRel || writtenEntry.artifactSha256 !== finalHash) fail("final input does not bind the final AC-W01 artifact");
    verifier.verifyHostedCanaryArtifact(updated, args.root);
    console.log(`verify-only ok: AC-W01 extended; ${finalRel} sha256=${finalHash}`);
    return;
  }

  writeFileSync(finalArtifactPath, finalBytes, { flag: "wx" });
  writeFileSync(finalInputPath, `${JSON.stringify(finalInput, null, 2)}\n`, { flag: "wx" });
  console.log(`wrote ${finalArtifactPath} (sha256=${finalHash}) and ${finalInputPath}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
