import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  RELEASE_CLOSURE_REPORT_VERSION,
  assertReleaseClosureContentFree,
  buildReleaseClosureReport,
  collectReleaseClosureInput,
  formatReleaseClosureReport,
  main as runReleaseClosureReport,
  parseGhRuns,
  parseWorkflowCron,
  rehearsePromotionRollback,
  renderReleaseClosureSummary,
  syntheticClosureFixture,
  type CommandResult,
  type CommandRunner,
  type ReleaseClosureInput,
} from "../scripts/release-closure-report.ts";

const CANDIDATE_SHA = "c".repeat(40);

function fixtureInput(
  overrides: Partial<ReleaseClosureInput> = {},
): ReleaseClosureInput {
  return { ...syntheticClosureFixture(), ...overrides };
}

function fixtureIntegrationCommit(): string {
  return syntheticClosureFixture().repository.integrationCommit;
}

function fixtureBaseCommit(): string {
  return syntheticClosureFixture().repository.baseCommit;
}

function fixtureTicketCommit(id: string): string {
  const entry = syntheticClosureFixture().acceptance.find(
    (evidence) => evidence.id === id,
  );
  if (!entry || entry.commits.length === 0) {
    throw new Error(`missing fixture evidence for ${id}`);
  }
  return entry.commits[0] as string;
}

function successRun(id: number): ReleaseClosureInput["ciRuns"][number] {
  return {
    id,
    workflow: "PR Validate",
    event: "pull_request",
    branch: "integration/spec-275",
    commit: fixtureIntegrationCommit(),
    status: "completed",
    conclusion: "success",
    createdAt: "2026-10-08T07:00:00Z",
    url: `https://github.com/lukemyself-hub/SayHear/actions/runs/${id}`,
  };
}

describe("release closure aggregation", () => {
  it("maps all fourteen parent-SPEC acceptance criteria exactly once", () => {
    const fixture = syntheticClosureFixture();
    const ids = fixture.acceptance.map((entry) => entry.id);

    expect(ids).toEqual(
      Array.from({ length: 14 }, (_, index) =>
        `AC-${String(index + 1).padStart(2, "0")}`,
      ),
    );
    for (const entry of fixture.acceptance) {
      expect(entry.status === "blocked" ? entry.blocker : entry.files.length > 0).toBeTruthy();
    }
  });

  it("binds real SHAs, run ids and evidence pointers without inventing values", () => {
    const report = buildReleaseClosureReport(fixtureInput());

    expect(report.version).toBe(RELEASE_CLOSURE_REPORT_VERSION);
    expect(report.repository.integrationCommit).toBe(fixtureIntegrationCommit());
    expect(report.repository.baseCommit).toBe(fixtureBaseCommit());
    expect(report.pullRequest.number).toBe(285);
    expect(report.ciRuns[0]?.id).toBe(37741892121);
    expect(report.acceptance.find((entry) => entry.id === "AC-01")?.runIds).toContain(
      37741892121,
    );
  });

  it("records scheduler workflow ids, state, schedule and last-run conclusions", () => {
    const report = buildReleaseClosureReport(fixtureInput());

    expect(report.schedulers.map((entry) => entry.workflowId)).toEqual([
      336293901, 349048917,
    ]);
    const recovery = report.schedulers.find(
      (entry) => entry.workflowId === 336293901,
    );
    expect(recovery?.state).toBe("active");
    expect(recovery?.schedule).toContain("13 * * * *");
    expect(recovery?.lastScheduledConclusion).toBe("success");
    const backup = report.schedulers.find((entry) => entry.workflowId === 349048917);
    expect(backup?.schedule).toContain("13 4 1 * *");
    expect(backup?.lastScheduledConclusion).toBe("success");
  });

  it("stays blocked while production identity, required checks and promotion are unproven", () => {
    const report = buildReleaseClosureReport(fixtureInput());
    const blockerIds = report.blockers.map((entry) => entry.id);

    expect(report.closureStatus).toBe("blocked");
    expect(blockerIds).toContain("required-status-checks-plan-blocked");
    expect(blockerIds).toContain("production-deployment-identity");
    expect(blockerIds).toContain("promotion-config-comparison");
    expect(blockerIds).toContain("ci-latest-run-not-success");
  });

  it("does not mark a locally-proven AC verified while no production deployment exists", () => {
    const byId = new Map(
      syntheticClosureFixture().acceptance.map((entry) => [entry.id, entry]),
    );

    for (const id of ["AC-09", "AC-10", "AC-11"]) {
      const entry = byId.get(id);
      expect(entry?.status, `${id} must not be verified without a real run`).not.toBe(
        "verified",
      );
      expect(entry?.blocker, `${id} must carry its concrete blocker`).toBeTruthy();
    }
  });

  it("reports closed only when every blocker is resolved and every AC is verified", () => {
    const base = syntheticClosureFixture();
    const closed = buildReleaseClosureReport({
      ...base,
      ciRuns: [successRun(99)],
      requiredChecks: { status: "enabled", detail: "required status check enabled" },
      deploymentIdentity: {
        production: {
          status: "verified",
          commit: fixtureBaseCommit(),
          deploymentId: "dpl_production",
          reason: "read from the authenticated release-identity endpoint",
        },
        candidate: {
          status: "verified",
          commit: CANDIDATE_SHA,
          deploymentId: "dpl_candidate",
          reason: "read from the authenticated release-identity endpoint",
        },
      },
      promotion: {
        status: "collected",
        command: "pnpm release:promotion:report",
        configDigest: "d".repeat(64),
        promotionAllowed: true,
        blockerKeys: [],
        note: "candidate matches current production",
      },
      acceptance: base.acceptance.map((entry) => ({
        ...entry,
        status: "verified" as const,
        blocker: null,
      })),
    });

    expect(closed.closureStatus).toBe("closed");
    expect(closed.blockers).toEqual([]);
  });

  it("never records a secret, connection string or private body", () => {
    const report = buildReleaseClosureReport(fixtureInput());
    expect(() => assertReleaseClosureContentFree(report)).not.toThrow();

    expect(() =>
      buildReleaseClosureReport(
        fixtureInput({
          limitations: ["leaked postgresql://owner:password@db.example/prod"],
        }),
      ),
    ).toThrow(/content-free|secret|connection/i);
  });

  it("prints one compact summary and a paste-ready Markdown section", () => {
    const report = buildReleaseClosureReport(fixtureInput());
    const text = formatReleaseClosureReport(report);
    expect(text).toContain("closure_status=blocked");
    expect(text).toContain("blocker required-status-checks-plan-blocked");

    const markdown = renderReleaseClosureSummary(report);
    for (const marker of [
      "CI",
      "差异报告",
      "部署身份",
      "视觉",
      "Scheduler",
      "回滚",
      "阻塞",
    ]) {
      expect(markdown).toContain(marker);
    }
  });
});

describe("release closure CLI", () => {
  it("writes the fixture report and exits non-zero while closure is blocked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sayhear-284-closure-"));
    const reportPath = join(directory, "report.json");
    const lines: string[] = [];
    try {
      const code = await runReleaseClosureReport(
        ["--fixture", "--summary", "--report", reportPath],
        { stdout: (line) => lines.push(line) },
      );
      const written = JSON.parse(await readFile(reportPath, "utf8")) as {
        version?: string;
        closureStatus?: string;
      };
      expect(code).toBe(1);
      expect(written.version).toBe(RELEASE_CLOSURE_REPORT_VERSION);
      expect(written.closureStatus).toBe("blocked");
      expect(lines.join("\n")).toContain("closure_status=blocked");
      expect(lines.join("\n")).toContain("## 发布闭合摘要");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to guess an identity when --pr/--branch/--base are missing", async () => {
    await expect(
      runReleaseClosureReport([], { stdout: () => {} }),
    ).rejects.toThrow(/--pr|--branch|--base/);
  });
});

describe("non-production promotion rehearsal", () => {
  const fixturePath = (name: string): string =>
    fileURLToPath(
      new URL(`./fixtures/g1-promotion-config-report/${name}`, import.meta.url),
    );

  it("demonstrates candidate change -> blocking -> variable/deployment recovery -> verification", () => {
    const rehearsal = rehearsePromotionRollback({
      isolatedPath: fixturePath("isolated.json"),
      productionPath: fixturePath("production.json"),
      candidateChangePath: fixturePath("candidate-change.json"),
      candidateRecoveredPath: fixturePath("candidate-recovered.json"),
    });

    expect(rehearsal.productionUntouched).toBe(true);
    expect(rehearsal.steps.map((step) => step.stage)).toEqual([
      "candidate-change",
      "variable-recovery",
      "verification",
    ]);
    expect(rehearsal.steps[0]?.outcome).toMatch(/blocked/);
    expect(rehearsal.steps[0]?.outcome).toContain("deadline.provider_ms");
    expect(rehearsal.steps[1]?.outcome).toMatch(/restored|redeploy/i);
    expect(rehearsal.steps[2]?.outcome).toMatch(/allowed/);
  });
});

describe("gh reader", () => {
  it("parses the gh run list JSON shape", () => {
    const runs = parseGhRuns(
      JSON.stringify([
        {
          databaseId: 37741892121,
          workflowName: "PR Validate",
          event: "pull_request",
          headBranch: "integration/spec-275",
          headSha: fixtureIntegrationCommit(),
          status: "in_progress",
          conclusion: "",
          createdAt: "2026-10-08T07:11:09Z",
          url: "https://github.com/lukemyself-hub/SayHear/actions/runs/37741892121",
        },
      ]),
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 37741892121,
      workflow: "PR Validate",
      conclusion: null,
      status: "in_progress",
    });
  });

  it("reads cron schedules from the committed workflow files", () => {
    expect(parseWorkflowCron('on:\n  schedule:\n    - cron: "13 * * * *"\n')).toEqual([
      "13 * * * *",
    ]);
  });

  it("collects the live-shaped inputs through an injected runner and records the plan-blocked check", async () => {
    const ghJson = (payload: unknown): CommandResult => ({
      stdout: JSON.stringify(payload),
      stderr: "",
      exitCode: 0,
    });
    const runs = [
      {
        databaseId: 37741892121,
        workflowName: "PR Validate",
        event: "pull_request",
        headBranch: "integration/spec-275",
        headSha: fixtureIntegrationCommit(),
        status: "completed",
        conclusion: "success",
        createdAt: "2026-10-08T07:11:09Z",
        url: "https://github.com/lukemyself-hub/SayHear/actions/runs/37741892121",
      },
    ];
    const schedulerRuns = [
      {
        databaseId: 37715214472,
        workflowName: "Internal Recovery Scan",
        event: "schedule",
        headBranch: "main",
        headSha: fixtureBaseCommit(),
        status: "completed",
        conclusion: "success",
        createdAt: "2026-10-08T01:54:13Z",
        url: "https://github.com/lukemyself-hub/SayHear/actions/runs/37715214472",
      },
    ];
    const runner: CommandRunner = async (command, args) => {
      const joined = [command, ...args].join(" ");
      if (joined.startsWith("gh pr view")) {
        return ghJson({
          number: 285,
          url: "https://github.com/lukemyself-hub/SayHear/pull/285",
          baseRefName: "main",
          headRefName: "integration/spec-275",
          isDraft: true,
          headRefOid: fixtureIntegrationCommit(),
          baseRefOid: fixtureBaseCommit(),
        });
      }
      if (joined.includes("/branches/main/protection")) {
        return {
          stdout: "",
          stderr:
            "Upgrade to GitHub Pro or make this repository public to enable this feature.",
          exitCode: 1,
        };
      }
      if (joined.includes("/actions/workflows")) {
        return ghJson({
          workflows: [
            {
              id: 349048917,
              name: "Backup Evidence Renewal",
              path: ".github/workflows/backup-evidence-renewal.yml",
              state: "active",
            },
            {
              id: 336293901,
              name: "Internal Recovery Scan",
              path: ".github/workflows/internal-recovery-scan.yml",
              state: "active",
            },
            {
              id: 378113294,
              name: "PR Validate",
              path: ".github/workflows/pr-validate.yml",
              state: "active",
            },
          ],
        });
      }
      if (joined.includes("--workflow internal-recovery-scan.yml")) {
        return ghJson(schedulerRuns);
      }
      if (joined.includes("--workflow backup-evidence-renewal.yml")) {
        return ghJson(schedulerRuns);
      }
      if (joined.includes("--branch integration/spec-275")) {
        return ghJson(runs);
      }
      if (joined.startsWith("git rev-parse HEAD")) {
        return { stdout: `${fixtureIntegrationCommit()}\n`, stderr: "", exitCode: 0 };
      }
      if (joined.startsWith("git rev-parse main")) {
        return { stdout: `${fixtureBaseCommit()}\n`, stderr: "", exitCode: 0 };
      }
      if (joined.startsWith("git cat-file")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${joined}`);
    };

    const input = await collectReleaseClosureInput({
      runner,
      repository: "lukemyself-hub/SayHear",
      pullRequestNumber: 285,
      integrationBranch: "integration/spec-275",
      baseBranch: "main",
      collectedAt: "2026-10-08T07:30:00Z",
      promotionReportPath: null,
      visualResult: "not run in this process",
    });

    expect(input.repository.integrationCommit).toBe(fixtureIntegrationCommit());
    expect(input.repository.baseCommit).toBe(fixtureBaseCommit());
    expect(input.requiredChecks.status).toBe("plan-blocked");
    expect(input.ciRuns).toHaveLength(1);
    expect(input.schedulers.map((entry) => entry.workflowId)).toEqual([
      336293901, 349048917,
    ]);
    expect(input.deploymentIdentity.production.status).toBe("unverified");
    expect(input.acceptance).toHaveLength(14);
  });

  it("fails rather than falling back to a SPEC-specific identity when the head cannot be established", async () => {
    const runner: CommandRunner = async (command, args) => {
      const joined = [command, ...args].join(" ");
      if (joined.startsWith("gh pr view")) {
        return { stdout: "", stderr: "no pull request", exitCode: 1 };
      }
      if (joined.startsWith("git rev-parse HEAD")) {
        return { stdout: "\n", stderr: "", exitCode: 0 };
      }
      if (joined.startsWith("git rev-parse main")) {
        return { stdout: "\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${joined}`);
    };

    await expect(
      collectReleaseClosureInput({
        runner,
        repository: "lukemyself-hub/SayHear",
        pullRequestNumber: 285,
        integrationBranch: "integration/spec-275",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/identity|integration commit|base commit/i);
  });

  it("requires an explicit pull request and branches instead of SPEC defaults", async () => {
    const runner: CommandRunner = async () => {
      throw new Error("the runner must not be called without an explicit identity");
    };

    await expect(
      collectReleaseClosureInput({
        runner,
        repository: "lukemyself-hub/SayHear",
        integrationBranch: "integration/spec-275",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/pullRequestNumber|pull request/i);

    await expect(
      collectReleaseClosureInput({
        runner,
        repository: "lukemyself-hub/SayHear",
        pullRequestNumber: 285,
        baseBranch: "main",
      }),
    ).rejects.toThrow(/integrationBranch|integration branch/i);
  });
});

describe("acceptance evidence map", () => {
  it("references real merged commits and files from tickets #276-#283", () => {
    const byId = new Map(
      syntheticClosureFixture().acceptance.map((entry) => [entry.id, entry]),
    );

    expect(byId.get("AC-01")?.commits).toContain(fixtureTicketCommit("AC-01"));
    expect(byId.get("AC-01")?.files).toContain(
      ".github/workflows/pr-validate.yml",
    );
    expect(byId.get("AC-08")?.files).toContain(
      "scripts/g1-promotion-config-report.ts",
    );
    expect(byId.get("AC-14")?.files).toContain(
      "scripts/portal-visual-acceptance.mjs",
    );
  });
});
