#!/usr/bin/env node
// PROTOTYPE ONLY (SPEC #301 response-structure comparison). One command per group:
//   node eval/continuity-acceptance-301/prototype-response-structure/run.mjs --group 2 --cases H05,H06,H01
// Runs each holdout case once against the real model, into runs/g<group>/<case>/.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const argv = process.argv.slice(2);
const args = {};
for (let index = 0; index < argv.length; index += 1) {
  if (!argv[index].startsWith("--")) continue;
  const next = argv[index + 1];
  args[argv[index].slice(2)] = next === undefined || next.startsWith("--") ? "true" : next;
}
const ALL = ["H01", "H02", "H03", "H04", "H05", "H06", "H07", "H08", "H09", "H10", "H11", "H12", "HL1"];
const group = args.group;
if (!["0", "1", "2", "3"].includes(group)) throw new Error("--group must be 0, 1, 2 or 3");
const cases = args.cases ? args.cases.split(",") : ALL;
const deterministic = args.deterministic === "true";
const outRoot = path.resolve(here, args.out ?? "runs", `g${group}`);
mkdirSync(outRoot, { recursive: true });
const indexFile = path.join(outRoot, "index.json");
const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : {};
/** The one request budget all four groups share (product default is 30000). */
const REQUEST_BUDGET_MS = "120000";

for (const id of cases) {
  if (existsSync(path.join(outRoot, id, "report.json")) && args.force !== "true") {
    console.log(`g${group} ${id}: already run, skipping (use --force to rerun)`);
    continue;
  }
  const started = Date.now();
  const result = spawnSync(
    "pnpm",
    [
      "acceptance:continuity",
      "run-case",
      id,
      "--pack",
      "holdout",
      "--out",
      outRoot,
      ...(deterministic
        ? []
        : [
            "--mode",
            "real-model",
            "--provider-credential-file",
            process.env.PROTOTYPE_CREDENTIAL_FILE ?? "/Users/lukemyself/Projects/SayHear/.env.neon",
          ]),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SAYHEAR_ACCEPTANCE_REAL_MODEL: deterministic ? "" : "enabled",
        SAYHEAR_PROTOTYPE_LOG: path.join(outRoot, `${id}.prototype-log.jsonl`),
        SAYHEAR_PROTOTYPE_REQUEST_BUDGET_MS: REQUEST_BUDGET_MS,
        SAYHEAR_PROTOTYPE_STRUCTURE: group,
        TEST_DATABASE_URL: "postgresql://localhost:5432/sayhear_test_proto",
        TEST_PURGE_MARKER_DATABASE_URL: "postgresql://localhost:5432/sayhear_marker_proto",
      },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  index[id] = { exitCode: result.status, finishedAt: new Date().toISOString(), seconds };
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(
    path.join(outRoot, `${id}.cli.log`),
    `${result.stdout ?? ""}\n--- stderr ---\n${(result.stderr ?? "").slice(-20000)}`,
  );
  console.log(`g${group} ${id}: exit ${result.status} in ${seconds}s`);
  if (result.status === 4) {
    console.log("BLOCKED by the budget or mode gate; stopping.");
    break;
  }
}
