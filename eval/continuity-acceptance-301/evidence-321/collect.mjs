// Collects stored real-model runs into this directory as committed evidence
// (T08 #321): applies the agent reviews, re-scores each run with the CLI,
// copies the readable files, compresses the sealed observation, and refuses
// to finish if a Provider credential appears anywhere in what it wrote.
//
//   node collect.mjs <artifacts root> [credential profile file]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const here = import.meta.dirname;
const repositoryRoot = path.resolve(here, "../../..");
const source = path.resolve(process.argv[2]);
const reviews = JSON.parse(fs.readFileSync(path.join(here, "reviews.json"), "utf8"));
const groups = ["formal", "supplementary"];

function caseDirectories(root) {
  const found = [];
  const visit = (directory) => {
    if (fs.existsSync(path.join(directory, "observation.json"))) return found.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  if (fs.existsSync(root)) visit(root);
  return found.sort();
}

const written = [];
for (const group of groups) {
  for (const directory of caseDirectories(path.join(source, group))) {
    const relative = path.relative(path.join(source, group), directory);
    const observation = JSON.parse(fs.readFileSync(path.join(directory, "observation.json"), "utf8"));
    const findings = group === "formal" ? reviews.runs[relative] : undefined;
    const args = ["acceptance:continuity", "report", "--run", directory];
    if (findings) {
      const review = {
        caseId: observation.caseId,
        findings: findings.map(([criterionId, itemId, verdict, quote, reason]) => ({
          criterionId,
          itemId,
          ...(quote ? { quote } : {}),
          reason,
          verdict,
        })),
        reviewer: reviews.reviewer,
        rubricVersion: "continuity-rubric:v1",
        runId: observation.identity.runId,
        schemaVersion: "continuity-acceptance-review:v1",
      };
      fs.writeFileSync(path.join(directory, "review.json"), `${JSON.stringify(review, null, 2)}\n`);
      args.push("--review", path.join(directory, "review.json"));
    }
    try {
      execFileSync("pnpm", ["-s", ...args], { cwd: repositoryRoot, stdio: "ignore" });
    } catch {
      // A non-zero exit is the run's own status (fail / needs-review), not an error.
    }
    const target = path.join(here, group, relative);
    fs.mkdirSync(target, { recursive: true });
    for (const name of ["report.md", "report.json", "timings.json", "transcript.md", "versions.json", "review.json", "observation.sha256"]) {
      if (fs.existsSync(path.join(directory, name))) {
        fs.copyFileSync(path.join(directory, name), path.join(target, name));
        written.push(path.join(target, name));
      }
    }
    fs.writeFileSync(
      path.join(target, "observation.json.gz"),
      zlib.gzipSync(fs.readFileSync(path.join(directory, "observation.json")), { level: 9 }),
    );
    written.push(path.join(target, "observation.json"));
    console.log(`${group}/${relative}: ${findings ? "reviewed" : "no review"}`);
  }
  if (fs.existsSync(path.join(source, group))) {
    const summary = execFileSync(
      "pnpm",
      ["-s", "acceptance:continuity", "summary", "--run", path.join(source, group)],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    fs.writeFileSync(path.join(here, group, "summary.md"), summary);
  }
}

// The credential must not be in anything that is about to be committed. The
// uncompressed observations are checked at their source.
if (process.argv[3]) {
  const line = fs
    .readFileSync(process.argv[3], "utf8")
    .split("\n")
    .find((candidate) => candidate.startsWith("OPENCODE_GO_API_KEY="));
  const credential = line?.slice("OPENCODE_GO_API_KEY=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!credential) throw new Error("No credential found to check against.");
  let leaks = 0;
  for (const file of written) {
    const actual = file.endsWith("observation.json")
      ? path.join(source, path.relative(here, file))
      : file;
    if (fs.readFileSync(actual, "utf8").includes(credential)) leaks += 1;
  }
  for (const file of ["../cost-ledger.json", "reviews.json"]) {
    if (fs.readFileSync(path.join(here, file), "utf8").includes(credential)) leaks += 1;
  }
  if (leaks > 0) throw new Error(`The Provider credential appears in ${leaks} evidence file(s).`);
  console.log(`credential check: ${written.length + 2} files, none contains the Provider credential`);
}
