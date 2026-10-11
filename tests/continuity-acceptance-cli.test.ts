import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * T00 #313: the CLI's own contract — exit codes and refusals — exercised as a
 * real process. None of these cases reaches a database, a server or a model.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repositoryRoot, "eval/continuity-acceptance-301/cli.ts");
const tsx = path.join(repositoryRoot, "node_modules/.bin/tsx");

function run(args: readonly string[], environment: Record<string, string> = {}) {
  const result = spawnSync(tsx, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      ...environment,
    } as unknown as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
  return { code: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe("continuity acceptance CLI", { timeout: 120_000 }, () => {
  it("validates the whole pack without any database or model configured", () => {
    const result = run(["validate"]);
    expect(result.output).toContain("18 case(s) valid.");
    expect(result.code).toBe(0);
  });

  it("plans a deterministic run as free and ready by default", () => {
    const result = run(["plan"]);
    expect(result.output).toMatch(/mode:\s+deterministic/);
    expect(result.output).toMatch(/paid requests, at most:\s+0 /);
    expect(result.output).toMatch(/status:\s+READY/);
    expect(result.code).toBe(0);
  });

  it("blocks real-model mode with its own exit code instead of falling back to the stub", () => {
    const requested = run(["plan", "--mode", "real-model"]);
    expect(requested.code).toBe(4);
    expect(requested.output).toMatch(/status:\s+BLOCKED/);
    expect(requested.output).toContain("SAYHEAR_ACCEPTANCE_REAL_MODEL");
    expect(requested.output).toContain("issue-307-online-acceptance");

    // Even with the switch set, an unverified precondition and an unresolved
    // ledger entry keep it blocked, and a run refuses before touching anything.
    const enabled = run(["run-case", "S01", "--mode", "real-model"], {
      SAYHEAR_ACCEPTANCE_REAL_MODEL: "enabled",
    });
    expect(enabled.code).toBe(4);
    expect(enabled.output).toContain("BLOCKED: real-model mode cannot start.");
    expect(enabled.output).not.toMatch(/S01: (PASS|NOT-RUN|FAIL)/);
  });

  it("refuses to run against a database it cannot prove is synthetic", () => {
    const missing = run(["run-case", "S01"]);
    expect(missing.code).toBe(3);
    expect(missing.output).toContain("REFUSED");
    expect(missing.output).toContain("never falls back to DATABASE_URL");

    const real = run(["run-case", "S01"], {
      SAYHEAR_ACCEPTANCE_ISOLATED: "true",
      TEST_DATABASE_URL: "postgresql://owner:top-secret@db.example.com/sayhear",
      TEST_PURGE_MARKER_DATABASE_URL: "postgresql://localhost:5432/sayhear_marker_t00",
    });
    expect(real.code).toBe(3);
    expect(real.output).toContain("REFUSED");
    expect(real.output).not.toContain("top-secret");
  });

  it("separates a usage mistake from every run outcome", () => {
    expect(run(["run-case", "C99"]).code).toBe(64);
    expect(run(["plan", "--mode", "fast"]).code).not.toBe(0);
  });

  it("refuses to re-score a stored run whose observation was edited or never sealed", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "sayhear-acceptance-report-"));
    try {
      const runDirectory = path.join(directory, "S01");
      mkdirSync(runDirectory);
      // A hand-assembled observation claiming a real-model run.
      writeFileSync(
        path.join(runDirectory, "observation.json"),
        JSON.stringify({ caseId: "S01", mode: "real-model", steps: [] }),
      );
      const unsealed = run(["report", "--run", runDirectory]);
      expect(unsealed.code).toBe(3);
      expect(unsealed.output).toContain("REFUSED: the stored run cannot be re-scored");
      expect(unsealed.output).not.toMatch(/S01: (PASS|NOT-RUN|FAIL|NEEDS-REVIEW)/);

      writeFileSync(path.join(runDirectory, "observation.sha256"), "0".repeat(64));
      const edited = run(["report", "--run", runDirectory]);
      expect(edited.code).toBe(3);
      expect(edited.output).toContain("changed after the run");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("proves its checker against the prefabricated good and bad transcripts", () => {
    const result = run(["calibrate"]);
    expect(result.output).toContain("Checker calibration holds.");
    expect(result.output).toContain("ok   late-reply-after-cancel");
    expect(result.output).not.toContain("MISS");
    expect(result.code).toBe(0);
  });
});
