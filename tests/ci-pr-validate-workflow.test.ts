import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { expectedSystemSuiteCount } from "../scripts/ci/system-suite-execution.ts";

const repositoryRoot = new URL("../", import.meta.url);

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, repositoryRoot), "utf8");
}

type RootPackageJson = {
  scripts?: Record<string, string>;
};

/** The workflow's `services:` block, one string per service, indentation intact. */
function serviceBlocks(workflow: string): string[] {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === "services:");
  const serviceKey = /^ {6}[a-z][\w-]*:$/;
  const jobKey = /^ {4}\S/;
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of lines.slice(start + 1)) {
    if (jobKey.test(line)) break;
    if (serviceKey.test(line)) {
      if (current) blocks.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join("\n"));
  return blocks;
}

function namedStepBlock(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start < 0) throw new Error(`Missing workflow step: ${name}`);

  const nextStep = lines.findIndex(
    (line, index) => index > start && /^ {6}- (?:name|uses):/.test(line),
  );
  return lines.slice(start, nextStep < 0 ? undefined : nextStep).join("\n");
}

describe("PR validate workflow", () => {
  it("runs every step of the validate composition, so CI cannot silently drift", async () => {
    const rootPackage = JSON.parse(
      await readRepositoryFile("package.json"),
    ) as RootPackageJson;
    const validateSteps = (rootPackage.scripts?.validate ?? "").split("&&").map(
      (step) => step.trim().replace(/^pnpm /, ""),
    );
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );

    expect(validateSteps.length).toBeGreaterThan(1);
    for (const script of validateSteps) {
      expect(
        workflow.includes(`run: pnpm ${script}\n`),
        `the PR workflow does not run \`pnpm ${script}\` from the validate composition`,
      ).toBe(true);
    }
  });

  it("is triggered for every pull request with no path filter", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("types: [opened, synchronize, reopened, ready_for_review, labeled]");
    expect(workflow).not.toContain("paths:");
    expect(workflow).not.toContain("paths-ignore:");
    expect(workflow).not.toContain("pull_request_target");
  });

  it("reads no repository secret and runs untrusted code unprivileged", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );

    // The merge queue only reports its required checks on the merge-group ref.
    // Without this trigger `validate` never runs there, and an entry waits forever.
    expect(workflow).toContain("merge_group:");
    expect(workflow).toContain(
      "github.event.pull_request.number || github.event.merge_group.head_sha",
    );

    expect(workflow).not.toContain("secrets.");
    expect(workflow).toContain("contents: read");
  });

  it("records the exact checkout SHA alongside the test report", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );
    const identityStep = namedStepBlock(
      workflow,
      "Record validated checkout identity",
    );
    const uploadStep = namedStepBlock(workflow, "Upload the vitest report");

    expect(identityStep).toContain('["rev-parse", "HEAD"]');
    expect(identityStep).toContain("PR_VALIDATE_HEAD_SHA");
    expect(identityStep).toContain("PR_VALIDATE_BASE_SHA");
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(identityStep).toContain('["show", "-s", "--format=%P", "HEAD"]');
    expect(identityStep).toContain("runId: Number(process.env.GITHUB_RUN_ID)");
    expect(identityStep).toContain("runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT)");
    expect(uploadStep).toContain("artifacts/vitest-report.json");
    expect(uploadStep).toContain("artifacts/pr-validate-source.json");
  });

  it("provisions two distinct temporary PostgreSQL services and exports both variables", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );
    const serviceBlocksInWorkflow = serviceBlocks(workflow);

    expect(serviceBlocksInWorkflow).toHaveLength(2);
    expect(new Set(serviceBlocksInWorkflow).size).toBe(2);
    expect(serviceBlocksInWorkflow.join("")).toContain(
      "POSTGRES_DB: sayhear_test",
    );
    expect(serviceBlocksInWorkflow.join("")).toContain(
      "POSTGRES_DB: sayhear_purge_marker_test",
    );
    expect(workflow).toContain(
      "TEST_DATABASE_URL: postgresql://sayhear:sayhear@127.0.0.1:5432/sayhear_test",
    );
    expect(workflow).toContain(
      "TEST_PURGE_MARKER_DATABASE_URL: postgresql://sayhear:sayhear@127.0.0.1:5433/sayhear_purge_marker_test",
    );
    expect(workflow).toContain("pg_isready");
  });

  it("installs the declared toolchain from a frozen lockfile", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );

    expect(workflow).toContain("pnpm/action-setup@v4");
    expect(workflow).toContain("node-version-file: .node-version");
    expect(workflow).toContain("pnpm install --frozen-lockfile");
  });

  it("builds with a legal synthetic configuration and no open G1 write switch", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );

    expect(workflow).toContain("SAYHEAR_DEPLOYMENT: test");
    expect(workflow).not.toMatch(/SAYHEAR_EPISODE_BUILD_ENABLED:\s*true/);
    expect(workflow).not.toMatch(/SAYHEAR_REFLECTION_ENABLED:\s*true/);
    // Startup validation still runs through `pnpm build`; nothing skips it.
    expect(workflow).toContain("run: pnpm build\n");
    expect(workflow).not.toContain("validate-startup --skip");
  });

  it("fails the run when the databases or the expected system suites are wrong", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );

    expect(workflow).toContain("run: pnpm ci:verify-test-databases\n");
    expect(workflow).toContain(
      "run: pnpm ci:assert-system-suites artifacts/vitest-report.json\n",
    );
  });

  it("runs independent checks after a failure without continuing cancelled runs", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );
    const installCondition =
      "if: ${{ !cancelled() && steps.install_dependencies.outcome == 'success' }}";
    const databaseCondition =
      "if: ${{ !cancelled() && steps.install_dependencies.outcome == 'success' && steps.verify_test_databases.outcome == 'success' }}";

    expect(namedStepBlock(workflow, "Install dependencies")).toContain(
      "id: install_dependencies",
    );
    expect(
      namedStepBlock(workflow, "Verify the two test databases"),
    ).toContain(installCondition);
    expect(namedStepBlock(workflow, "Unit and system tests")).toContain(
      databaseCondition,
    );
    expect(
      namedStepBlock(workflow, "Assert the expected system suites ran"),
    ).toContain(databaseCondition);

    for (const name of [
      "Typecheck",
      "Purge surface inventory",
      "Schema extensions",
      "Module boundaries",
      "Runtime version",
      "Build",
    ]) {
      expect(namedStepBlock(workflow, name)).toContain(installCondition);
      expect(namedStepBlock(workflow, name)).not.toContain(
        "steps.unit_tests.outcome",
      );
    }

    expect(namedStepBlock(workflow, "Upload the vitest report")).toContain(
      "if: ${{ !cancelled() }}",
    );
    expect(workflow).not.toContain("if: always()");
    expect(workflow).not.toContain("continue-on-error: true");
    expect(workflow).toContain("cancel-in-progress: true");
  });

  it("cites the pinned system suite count so the workflow comment cannot go stale", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );

    // The workflow comment must repeat the exact count pinned by
    // `expectedSystemSuiteCount`; this guard fails the moment the two drift.
    expect(workflow).toContain(`${expectedSystemSuiteCount} system suites`);
  });

  it("does not make the merge gate depend on lint or a local hook", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );

    expect(workflow).not.toContain("pnpm lint");
    expect(workflow).not.toContain("lint-staged");
    expect(workflow).not.toContain("pre-commit");
  });
});
