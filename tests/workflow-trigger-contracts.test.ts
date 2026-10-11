import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const workflowDirectory = `${repositoryRoot}.github/workflows`;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
});

async function runTriggerChecker(directory: string): Promise<{
  exitCode: number;
  output: string;
}> {
  return execFileAsync(
    process.execPath,
    ["scripts/ci/check-workflow-triggers.mjs"],
    {
      cwd: repositoryRoot,
      env: { ...process.env, SAYHEAR_WORKFLOW_DIR: directory },
    },
  ).then(
    ({ stdout, stderr }) => ({ exitCode: 0, output: `${stdout}${stderr}` }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      exitCode: error.code ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    }),
  );
}

type WorkflowFixture = { recovery: string; backup: string };

async function runFixture(
  mutate: (workflows: WorkflowFixture) => Partial<WorkflowFixture>,
): Promise<{ exitCode: number; output: string }> {
  const root = await mkdtemp(join(tmpdir(), "sayhear-workflow-fixture-"));
  temporaryRoots.push(root);
  const workflows: WorkflowFixture = {
    recovery: await readFile(
      join(workflowDirectory, "internal-recovery-scan.yml"),
      "utf8",
    ),
    backup: await readFile(
      join(workflowDirectory, "backup-evidence-renewal.yml"),
      "utf8",
    ),
  };
  const mutated = mutate(workflows);
  await writeFile(
    join(root, "internal-recovery-scan.yml"),
    mutated.recovery ?? workflows.recovery,
    "utf8",
  );
  await writeFile(
    join(root, "backup-evidence-renewal.yml"),
    mutated.backup ?? workflows.backup,
    "utf8",
  );
  return runTriggerChecker(root);
}

describe("Scheduled workflow trigger contracts", () => {
  it("accepts the deployed recovery-scan and backup-renewal workflows", async () => {
    const result = await runTriggerChecker(workflowDirectory);

    expect(result.exitCode, result.output).toBe(0);
  });

  it("rejects a deleted hourly recovery schedule", async () => {
    const result = await runFixture(({ recovery }) => ({
      recovery: recovery.replace(
        '\n  schedule:\n    - cron: "13 * * * *"',
        "",
      ),
    }));

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      'hourly schedule cron "13 * * * *"',
    );
  });

  it("rejects a wrong recovery cron", async () => {
    const result = await runFixture(({ recovery }) => ({
      recovery: recovery.replace('"13 * * * *"', '"0 * * * *"'),
    }));

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('hourly schedule cron "13 * * * *"');
  });

  it("requires the two-hour derived-latency gate in the original scan step", async () => {
    const result = await runFixture(({ recovery }) => ({
      recovery: recovery.replace("if (latency > 7200)", "if (latency > 9000)"),
    }));

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("derived-latency gate must fail above 7200 seconds");
  });

  it("rejects an identity-only trigger that drops the original scan step", async () => {
    const result = await runFixture(({ recovery }) => {
      const start = recovery.indexOf(
        "      - name: Call recovery scan endpoint",
      );
      const end = recovery.indexOf(
        "      - name: Verify scoped production endpoint",
      );
      return { recovery: `${recovery.slice(0, start)}${recovery.slice(end)}` };
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "must keep the original recovery scan dispatch step",
    );
  });

  it("rejects a scoped recovery route that does not target the recovery scan", async () => {
    const result = await runFixture(({ recovery }) => ({
      recovery: recovery.replace(
        "/api/internal/recovery/scan",
        "/api/internal/inspection/release-identity",
      ),
    }));

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "recovery mode must select the original recovery scan route",
    );
  });

  it("rejects a deleted backup-renewal schedule", async () => {
    const result = await runFixture(({ backup }) => ({
      backup: backup.replace('\n  schedule:\n    - cron: "13 4 1 * *"', ""),
    }));

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('monthly schedule cron "13 4 1 * *"');
  });

  it("rejects a renewal that bypasses a failed window verification", async () => {
    const result = await runFixture(({ backup }) => ({
      backup: backup.replace(
        "      - name: Record renewed backup evidence (+30 days)\n",
        "      - name: Record renewed backup evidence (+30 days)\n        if: always()\n",
      ),
    }));

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "must not bypass a failed window verification",
    );
  });
});
