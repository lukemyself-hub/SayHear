#!/usr/bin/env node
// PROTOTYPE ONLY. Runs the given cases (default: all 13) for groups 0..3, one after another.
//   node eval/continuity-acceptance-301/prototype-response-structure/run-all.mjs [--cases H05,H06,H01] [--groups 0,1,2,3]
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const value = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};
const groups = (value("groups") ?? "0,1,2,3").split(",");
const cases = value("cases");
// Case by case across the groups, so a spend stop leaves complete rows.
const ALL = ["H01", "H02", "H03", "H04", "H05", "H06", "H07", "H08", "H09", "H10", "H11", "H12", "HL1"];
for (const id of cases ? cases.split(",") : ALL) {
  for (const group of groups) {
    const result = spawnSync("node", [path.join(here, "run.mjs"), "--group", group, "--cases", id], {
      encoding: "utf8",
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.log(`run.mjs exited ${result.status}; stopping.`);
      process.exit(result.status ?? 1);
    }
  }
}
