import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The fault matrix handed to T08 (#321) names, for every fault, the test file
 * and test titles that prove it. This keeps the matrix honest: a renamed or
 * deleted proof makes the matrix fail here instead of silently going stale.
 */

const root = path.resolve(import.meta.dirname, "..");
const matrix = readFileSync(
  path.join(root, "eval/continuity-acceptance-301/fault-matrix.md"),
  "utf8",
);

type Row = Readonly<{ file: string; fragments: readonly string[]; id: number }>;

function rows(): Row[] {
  let lastFile = "";
  const found: Row[] = [];
  for (const line of matrix.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 7 || !/^\d+$/.test(cells[1]!)) continue;
    const proof = cells[5]!;
    const written = /`((?:tests\/)?[^`]*\.test\.ts)`/.exec(proof)?.[1];
    // A bare file name means tests/system, where the suites live.
    const file = written === undefined ? undefined : written.includes("/") ? written : `tests/system/${written}`;
    if (file) lastFile = file;
    // Fragments are the backticked phrases after the file name.
    const afterFile = written ? proof.slice(proof.indexOf(written) + written.length + 1) : proof;
    const fragments = [...afterFile.matchAll(/`([^`<>]+)`/g)].map((match) => match[1]!);
    found.push({ file: file ?? lastFile, fragments, id: Number(cells[1]) });
  }
  return found;
}

describe("continuity fault matrix", () => {
  const table = rows();

  it("lists every fault with a proof", () => {
    expect(table.length).toBeGreaterThanOrEqual(18);
    for (const row of table) expect(row.file, `row ${row.id} names no test file`).not.toBe("");
  });

  it("points only at test files and test titles that exist", () => {
    for (const row of table) {
      const absolute = path.join(root, row.file);
      expect(existsSync(absolute), `row ${row.id}: ${row.file} is missing`).toBe(true);
      const source = readFileSync(absolute, "utf8");
      for (const fragment of row.fragments) {
        expect(source, `row ${row.id}: "${fragment}" is not in ${row.file}`).toContain(fragment);
      }
    }
  });

  it("names the combined-version command and the independent switch", () => {
    expect(matrix).toContain("pnpm acceptance:continuity versions");
    expect(matrix).toContain("SAYHEAR_HISTORY_RECALL_ENABLED");
    expect(matrix).toContain("/api/internal/operator/history-recall");
  });
});
