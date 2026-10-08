import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

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
      const ciVariant = script === "test" ? "test:ci" : script;
      expect(
        workflow.includes(`run: pnpm ${ciVariant}\n`),
        `the PR workflow does not run \`pnpm ${ciVariant}\` from the validate composition`,
      ).toBe(true);
    }
  });

  it("is triggered for every pull request with no path filter", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );

    expect(workflow).toContain("pull_request:");
    expect(workflow).not.toContain("paths:");
    expect(workflow).not.toContain("paths-ignore:");
    expect(workflow).not.toContain("pull_request_target");
  });

  it("reads no repository secret and runs untrusted code unprivileged", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );

    expect(workflow).not.toContain("secrets.");
    expect(workflow).toContain("contents: read");
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

  it("does not make the merge gate depend on lint or a local hook", async () => {
    const workflow = await readRepositoryFile(
      ".github/workflows/pr-validate.yml",
    );

    expect(workflow).not.toContain("pnpm lint");
    expect(workflow).not.toContain("lint-staged");
    expect(workflow).not.toContain("pre-commit");
  });
});