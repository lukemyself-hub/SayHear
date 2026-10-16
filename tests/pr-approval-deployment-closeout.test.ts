import { describe, expect, it } from "vitest";

import {
  collectDeploymentCloseout,
  decideDeploymentCloseout,
  DEPLOYMENT_CLOSEOUT_VERSION,
  deploymentRequired,
  main,
  type CommandRunner,
  type DeploymentInput,
  type DeploymentStatusInput,
} from "../scripts/pr-approval/deployment-closeout.ts";

const MERGE_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function status(
  state: string,
  createdAt: string,
  environmentUrl: string | null = null,
): DeploymentStatusInput {
  return { state, created_at: createdAt, environment_url: environmentUrl };
}

function deployment(
  id: number,
  sha: string,
  environment: string,
  statuses: readonly DeploymentStatusInput[],
): DeploymentInput {
  return { id, sha, environment, statuses };
}

function successDeployment(id = 7): DeploymentInput {
  return deployment(id, MERGE_SHA, "production", [
    status("success", "2026-10-16T00:00:01Z", "https://say-hear-web.vercel.app"),
  ]);
}

type Route = { code: number; stdout: string; stderr: string };

function fakeRunner(
  handler: (endpoint: string) => Route,
  seen: string[],
): CommandRunner {
  return async (command, args) => {
    seen.push(`${command} ${args.join(" ")}`);
    const endpoint = args.find((part) => part.startsWith("repos/")) ?? "";
    return handler(endpoint);
  };
}

function endToEndRunner(
  seen: string[],
  options: {
    files?: unknown;
    filesCode?: number;
    deployments?: unknown;
    deploymentsCode?: number;
    statuses?: unknown;
    statusesCode?: number;
    merged?: boolean;
  } = {},
): CommandRunner {
  return fakeRunner((endpoint) => {
    if (endpoint === "repos/lukemyself-hub/SayHear/pulls/42/files") {
      if ((options.filesCode ?? 0) !== 0) {
        return { code: 1, stdout: "", stderr: "files unreadable" };
      }
      return {
        code: 0,
        stdout: JSON.stringify(
          options.files ?? [{ filename: "apps/web/app/page.tsx" }],
        ),
        stderr: "",
      };
    }
    if (endpoint === "repos/lukemyself-hub/SayHear/pulls/42") {
      return {
        code: 0,
        stdout: JSON.stringify({
          merged: options.merged ?? true,
          merge_commit_sha: MERGE_SHA,
        }),
        stderr: "",
      };
    }
    if (
      endpoint ===
      `repos/lukemyself-hub/SayHear/deployments?sha=${MERGE_SHA}&per_page=100`
    ) {
      if ((options.deploymentsCode ?? 0) !== 0) {
        return { code: 1, stdout: "", stderr: "deployments unreadable" };
      }
      return {
        code: 0,
        stdout: JSON.stringify(
          options.deployments ?? [
            { id: 7, sha: MERGE_SHA, environment: "production" },
          ],
        ),
        stderr: "",
      };
    }
    if (
      endpoint ===
      "repos/lukemyself-hub/SayHear/deployments/7/statuses?per_page=100"
    ) {
      if ((options.statusesCode ?? 0) !== 0) {
        return { code: 1, stdout: "", stderr: "statuses unreadable" };
      }
      return {
        code: 0,
        stdout: JSON.stringify(
          options.statuses ?? [
            {
              state: "success",
              created_at: "2026-10-16T00:00:01Z",
              environment_url: "https://say-hear-web.vercel.app",
            },
          ],
        ),
        stderr: "",
      };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  }, seen);
}

function mainRunner(
  statuses: unknown,
  files: unknown = [{ filename: "apps/web/app/page.tsx" }],
): CommandRunner {
  const seen: string[] = [];
  return fakeRunner((endpoint) => {
    if (endpoint === "repos/lukemyself-hub/SayHear/pulls/9/files") {
      return { code: 0, stdout: JSON.stringify(files), stderr: "" };
    }
    if (endpoint === "repos/lukemyself-hub/SayHear/pulls/9") {
      return {
        code: 0,
        stdout: JSON.stringify({
          merged: true,
          merge_commit_sha: MERGE_SHA,
        }),
        stderr: "",
      };
    }
    if (endpoint.includes("/deployments?sha=")) {
      return {
        code: 0,
        stdout: JSON.stringify([
          { id: 3, sha: MERGE_SHA, environment: "production" },
        ]),
        stderr: "",
      };
    }
    if (endpoint.includes("/deployments/3/statuses")) {
      return { code: 0, stdout: JSON.stringify(statuses), stderr: "" };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  }, seen);
}

describe("deploymentRequired", () => {
  it("is not required for docs and tooling only", () => {
    expect(
      deploymentRequired([
        "docs/guide.md",
        "tests/pr-approval-diff.test.ts",
        "eval/continuity-acceptance-301/cli.ts",
        "scripts/check-boundaries.mjs",
        ".agents/notes.md",
        ".github/workflows/pr-validate.yml",
        ".codex/config.md",
        "README.md",
        "GLOSSARY.md",
      ]),
    ).toBe(false);
  });

  it("is required when any runtime path changed", () => {
    expect(
      deploymentRequired(["docs/guide.md", "apps/web/app/page.tsx"]),
    ).toBe(true);
  });

  it("is required for an empty path list", () => {
    expect(deploymentRequired([])).toBe(true);
  });

  it("is required for unknown and root config paths", () => {
    for (const path of [
      "mystery/file.xyz",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.json",
      "vercel.json",
      "packages/domain/src/x.ts",
    ]) {
      expect(deploymentRequired([path])).toBe(true);
    }
  });

  it("treats only top-level markdown as non-runtime", () => {
    expect(deploymentRequired(["README.md", "CHANGELOG.md"])).toBe(false);
    expect(deploymentRequired(["apps/web/README.md"])).toBe(false);
    expect(deploymentRequired(["packages/domain/README.md"])).toBe(false);
  });

  it("still requires deployment for other nested markdown and configs", () => {
    expect(deploymentRequired(["apps/web/CHANGELOG.md"])).toBe(true);
    expect(deploymentRequired(["apps/web/notes.md"])).toBe(true);
    expect(deploymentRequired(["package.json"])).toBe(true);
  });

  it("considers both sides of a rename when checking docs-only", () => {
    expect(
      deploymentRequired(["docs/old.md", "apps/web/README.md"]),
    ).toBe(false);
    expect(
      deploymentRequired(["docs/old.md", "apps/web/app/page.tsx"]),
    ).toBe(true);
  });
});

describe("decideDeploymentCloseout", () => {
  it("reports not_required regardless of deployments", () => {
    for (const deployments of [null, [successDeployment()]] as const) {
      const closeout = decideDeploymentCloseout({
        pullRequestNumber: 1,
        mergeSha: MERGE_SHA,
        changedPaths: ["docs/guide.md"],
        deployments,
      });
      expect(closeout.status).toBe("not_required");
      expect(closeout.deploymentRequired).toBe(false);
      expect(closeout.deploymentId).toBeNull();
      expect(closeout.environmentUrl).toBeNull();
    }
  });

  it("reports unverified when deployments could not be read", () => {
    const closeout = decideDeploymentCloseout({
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      changedPaths: ["apps/web/app/page.tsx"],
      deployments: null,
    });
    expect(closeout).toEqual({
      version: DEPLOYMENT_CLOSEOUT_VERSION,
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      deploymentRequired: true,
      status: "unverified",
      deploymentId: null,
      environmentUrl: null,
      reason: `Deployments for merge ${MERGE_SHA} could not be read, so deployment status is unverified.`,
    });
  });

  it("stays pending when only another SHA has a ready deployment", () => {
    const closeout = decideDeploymentCloseout({
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      changedPaths: ["apps/web/app/page.tsx"],
      deployments: [
        deployment(6, OTHER_SHA, "production", [
          status("success", "2026-10-16T00:00:01Z"),
        ]),
        deployment(9, MERGE_SHA, "preview", [
          status("success", "2026-10-16T00:00:02Z"),
        ]),
      ],
    });
    expect(closeout.status).toBe("pending");
    expect(closeout.deploymentId).toBeNull();
    expect(closeout.reason).toBe(
      `No production deployment exists for merge ${MERGE_SHA} yet.`,
    );
  });

  it("matches SHA and production case-insensitively", () => {
    const closeout = decideDeploymentCloseout({
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      changedPaths: ["apps/web/app/page.tsx"],
      deployments: [
        deployment(7, MERGE_SHA.toUpperCase(), "Production", [
          status("success", "2026-10-16T00:00:01Z"),
        ]),
      ],
    });
    expect(closeout.status).toBe("succeeded");
    expect(closeout.deploymentId).toBe(7);
  });

  it("reports success with the deployment id and environment url", () => {
    const closeout = decideDeploymentCloseout({
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      changedPaths: ["apps/web/app/page.tsx"],
      deployments: [successDeployment(7)],
    });
    expect(closeout).toEqual({
      version: DEPLOYMENT_CLOSEOUT_VERSION,
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      deploymentRequired: true,
      status: "succeeded",
      deploymentId: 7,
      environmentUrl: "https://say-hear-web.vercel.app",
      reason: `Production deployment 7 for merge ${MERGE_SHA} succeeded.`,
    });
  });

  it("treats success followed by inactive as succeeded", () => {
    const closeout = decideDeploymentCloseout({
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      changedPaths: ["apps/web/app/page.tsx"],
      deployments: [
        deployment(7, MERGE_SHA, "production", [
          status("inactive", "2026-10-16T00:00:02Z"),
          status("success", "2026-10-16T00:00:01Z"),
        ]),
      ],
    });
    expect(closeout.status).toBe("succeeded");
    expect(closeout.deploymentId).toBe(7);
  });

  it("reports failure when a newer failure is later marked inactive", () => {
    for (const failed of ["failure", "error"]) {
      const closeout = decideDeploymentCloseout({
        pullRequestNumber: 1,
        mergeSha: MERGE_SHA,
        changedPaths: ["apps/web/app/page.tsx"],
        deployments: [
          deployment(7, MERGE_SHA, "production", [
            status("inactive", "2026-10-16T00:00:03Z"),
            status(failed, "2026-10-16T00:00:02Z"),
            status("success", "2026-10-16T00:00:01Z"),
          ]),
        ],
      });
      expect(closeout.status).toBe("failed");
      expect(closeout.deploymentId).toBe(7);
      expect(closeout.reason).toBe(
        `Production deployment 7 for merge ${MERGE_SHA} reported ${failed}.`,
      );
    }
  });

  it("stays pending when a newer active attempt follows an older success", () => {
    for (const active of ["queued", "in_progress", "pending"]) {
      const closeout = decideDeploymentCloseout({
        pullRequestNumber: 1,
        mergeSha: MERGE_SHA,
        changedPaths: ["apps/web/app/page.tsx"],
        deployments: [
          deployment(7, MERGE_SHA, "production", [
            status("inactive", "2026-10-16T00:00:03Z"),
            status(active, "2026-10-16T00:00:02Z"),
            status("success", "2026-10-16T00:00:01Z"),
          ]),
        ],
      });
      expect(closeout.status).toBe("pending");
      expect(closeout.deploymentId).toBe(7);
    }
  });

  it("reports failure as fact without retrying", () => {
    const closeout = decideDeploymentCloseout({
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      changedPaths: ["apps/web/app/page.tsx"],
      deployments: [
        deployment(7, MERGE_SHA, "production", [
          status("failure", "2026-10-16T00:00:01Z"),
        ]),
      ],
    });
    expect(closeout.status).toBe("failed");
    expect(closeout.deploymentId).toBe(7);
    expect(closeout.reason).toBe(
      `Production deployment 7 for merge ${MERGE_SHA} reported failure.`,
    );
  });

  it("reports failed when a newer failure follows an older success", () => {
    const closeout = decideDeploymentCloseout({
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      changedPaths: ["apps/web/app/page.tsx"],
      deployments: [
        deployment(7, MERGE_SHA, "production", [
          status("error", "2026-10-16T00:00:02Z"),
          status("success", "2026-10-16T00:00:01Z"),
        ]),
      ],
    });
    expect(closeout.status).toBe("failed");
    expect(closeout.reason).toBe(
      `Production deployment 7 for merge ${MERGE_SHA} reported error.`,
    );
  });

  it("prefers the newer success across candidates", () => {
    const closeout = decideDeploymentCloseout({
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      changedPaths: ["apps/web/app/page.tsx"],
      deployments: [
        deployment(5, MERGE_SHA, "production", [
          status("failure", "2026-10-16T00:00:01Z"),
        ]),
        successDeployment(9),
      ],
    });
    expect(closeout.status).toBe("succeeded");
    expect(closeout.deploymentId).toBe(9);
  });

  it("reports failure when a newer deployment failed after an older success", () => {
    const closeout = decideDeploymentCloseout({
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      changedPaths: ["apps/web/app/page.tsx"],
      deployments: [
        deployment(7, MERGE_SHA, "production", [
          status("success", "2026-10-16T00:00:01Z"),
        ]),
        deployment(8, MERGE_SHA, "production", [
          status("failure", "2026-10-16T00:00:02Z"),
        ]),
      ],
    });
    expect(closeout.status).toBe("failed");
    expect(closeout.deploymentId).toBe(8);
  });

  it("stays pending when a newer deployment is queued after an older success", () => {
    const closeout = decideDeploymentCloseout({
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      changedPaths: ["apps/web/app/page.tsx"],
      deployments: [
        deployment(7, MERGE_SHA, "production", [
          status("success", "2026-10-16T00:00:01Z"),
        ]),
        deployment(8, MERGE_SHA, "production", [
          status("queued", "2026-10-16T00:00:02Z"),
        ]),
      ],
    });
    expect(closeout.status).toBe("pending");
    expect(closeout.deploymentId).toBe(8);
  });

  it("allows a later success after an older failure", () => {
    const closeout = decideDeploymentCloseout({
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      changedPaths: ["apps/web/app/page.tsx"],
      deployments: [
        deployment(7, MERGE_SHA, "production", [
          status("failure", "2026-10-16T00:00:01Z"),
        ]),
        deployment(8, MERGE_SHA, "production", [
          status("success", "2026-10-16T00:00:02Z"),
        ]),
      ],
    });
    expect(closeout.status).toBe("succeeded");
    expect(closeout.deploymentId).toBe(8);
  });

  it("stays pending for queued and in_progress statuses", () => {
    for (const state of ["queued", "in_progress"]) {
      const closeout = decideDeploymentCloseout({
        pullRequestNumber: 1,
        mergeSha: MERGE_SHA,
        changedPaths: ["apps/web/app/page.tsx"],
        deployments: [
          deployment(7, MERGE_SHA, "production", [
            status(state, "2026-10-16T00:00:01Z"),
          ]),
        ],
      });
      expect(closeout.status).toBe("pending");
      expect(closeout.deploymentId).toBe(7);
      expect(closeout.reason).toBe(
        `Production deployment 7 for merge ${MERGE_SHA} is still ${state}.`,
      );
    }
  });

  it("stays pending when no status was reported yet", () => {
    const closeout = decideDeploymentCloseout({
      pullRequestNumber: 1,
      mergeSha: MERGE_SHA,
      changedPaths: ["apps/web/app/page.tsx"],
      deployments: [deployment(7, MERGE_SHA, "production", [])],
    });
    expect(closeout.status).toBe("pending");
    expect(closeout.deploymentId).toBe(7);
    expect(closeout.environmentUrl).toBeNull();
  });
});

describe("collectDeploymentCloseout", () => {
  it("collects the closeout end to end through gh api only", async () => {
    const seen: string[] = [];
    const closeout = await collectDeploymentCloseout(
      42,
      endToEndRunner(seen),
    );
    expect(closeout).toEqual({
      version: DEPLOYMENT_CLOSEOUT_VERSION,
      pullRequestNumber: 42,
      mergeSha: MERGE_SHA,
      deploymentRequired: true,
      status: "succeeded",
      deploymentId: 7,
      environmentUrl: "https://say-hear-web.vercel.app",
      reason: `Production deployment 7 for merge ${MERGE_SHA} succeeded.`,
    });
    expect(seen).toHaveLength(4);
    expect(seen.every((line) => line.startsWith("gh api"))).toBe(true);
    expect(
      seen.some((line) => line.includes("--paginate") && line.includes("/pulls/42/files")),
    ).toBe(true);
    expect(
      seen.some((line) =>
        line.includes(`/deployments?sha=${MERGE_SHA}&per_page=100`),
      ),
    ).toBe(true);
  });

  it("throws for an unmerged pull request", async () => {
    const seen: string[] = [];
    await expect(
      collectDeploymentCloseout(42, endToEndRunner(seen, { merged: false })),
    ).rejects.toThrow("pull_request_not_merged");
  });

  it("reports unverified when deployments cannot be read", async () => {
    const seen: string[] = [];
    const closeout = await collectDeploymentCloseout(
      42,
      endToEndRunner(seen, { deploymentsCode: 1 }),
    );
    expect(closeout.status).toBe("unverified");
    expect(closeout.deploymentRequired).toBe(true);
  });

  it("reports unverified when statuses cannot be read", async () => {
    const seen: string[] = [];
    const closeout = await collectDeploymentCloseout(
      42,
      endToEndRunner(seen, { statusesCode: 1 }),
    );
    expect(closeout.status).toBe("unverified");
  });

  it("treats unreadable files as deployment required", async () => {
    const seen: string[] = [];
    const closeout = await collectDeploymentCloseout(
      42,
      endToEndRunner(seen, { filesCode: 1 }),
    );
    expect(closeout.deploymentRequired).toBe(true);
    expect(closeout.status).toBe("succeeded");
  });

  it("ends docs-only merges without requiring a deployment", async () => {
    const seen: string[] = [];
    const closeout = await collectDeploymentCloseout(
      42,
      endToEndRunner(seen, {
        files: [{ filename: "docs/guide.md", previous_filename: null }],
        deploymentsCode: 1,
      }),
    );
    expect(closeout.status).toBe("not_required");
    expect(closeout.deploymentRequired).toBe(false);
  });

  it("reads the merge SHA from the merged timeline event when it is valid", async () => {
    const timelineSha = "c".repeat(40);
    const seen: string[] = [];
    const runner = fakeRunner((endpoint) => {
      if (endpoint === "repos/lukemyself-hub/SayHear/pulls/42/files") {
        return {
          code: 0,
          stdout: JSON.stringify([{ filename: "docs/guide.md" }]),
          stderr: "",
        };
      }
      if (endpoint === "repos/lukemyself-hub/SayHear/pulls/42") {
        return {
          code: 0,
          stdout: JSON.stringify({ merged: true, merge_commit_sha: null }),
          stderr: "",
        };
      }
      if (
        endpoint === "repos/lukemyself-hub/SayHear/issues/42/timeline"
      ) {
        return {
          code: 0,
          stdout: JSON.stringify([
            [{ event: "merged", commit_id: "not-a-sha" }],
            [{ event: "merged", commit_id: timelineSha }],
          ]),
          stderr: "",
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    }, seen);
    const closeout = await collectDeploymentCloseout(42, runner);
    expect(closeout.mergeSha).toBe(timelineSha);
    expect(closeout.status).toBe("not_required");
    expect(
      seen.some(
        (line) =>
          line.includes("--paginate") &&
          line.includes("--slurp") &&
          line.includes("/issues/42/timeline"),
      ),
    ).toBe(true);
  });

  it("throws when neither merge_commit_sha nor timeline provides a valid SHA", async () => {
    for (const timeline of [
      [{ event: "merged", commit_id: "not-a-sha" }],
      [{ event: "commented", commit_id: "c".repeat(40) }],
      [],
    ]) {
      const seen: string[] = [];
      const runner = fakeRunner((endpoint) => {
        if (endpoint === "repos/lukemyself-hub/SayHear/pulls/42") {
          return {
            code: 0,
            stdout: JSON.stringify({ merged: true, merge_commit_sha: null }),
            stderr: "",
          };
        }
        if (endpoint === "repos/lukemyself-hub/SayHear/issues/42/timeline") {
          return { code: 0, stdout: JSON.stringify([timeline]), stderr: "" };
        }
        if (endpoint === "repos/lukemyself-hub/SayHear/pulls/42/files") {
          return {
            code: 0,
            stdout: JSON.stringify([{ filename: "docs/guide.md" }]),
            stderr: "",
          };
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      }, seen);
      await expect(collectDeploymentCloseout(42, runner)).rejects.toThrow(
        "merge_commit_sha_unavailable",
      );
    }
  });

  it("never falls back to the pull request head SHA", async () => {
    const seen: string[] = [];
    const runner = fakeRunner((endpoint) => {
      if (endpoint === "repos/lukemyself-hub/SayHear/pulls/42") {
        return {
          code: 0,
          stdout: JSON.stringify({
            merged: true,
            merge_commit_sha: null,
            head: { sha: "d".repeat(40) },
          }),
          stderr: "",
        };
      }
      if (endpoint === "repos/lukemyself-hub/SayHear/issues/42/timeline") {
        return { code: 0, stdout: JSON.stringify([[]]), stderr: "" };
      }
      if (endpoint === "repos/lukemyself-hub/SayHear/pulls/42/files") {
        return {
          code: 0,
          stdout: JSON.stringify([{ filename: "docs/guide.md" }]),
          stderr: "",
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    }, seen);
    await expect(collectDeploymentCloseout(42, runner)).rejects.toThrow(
      "merge_commit_sha_unavailable",
    );
  });

  it("flattens slurped files pages instead of parsing them as one list", async () => {
    const seen: string[] = [];
    const closeout = await collectDeploymentCloseout(
      42,
      endToEndRunner(seen, {
        files: [
          [{ filename: "docs/guide.md" }],
          [{ filename: "apps/web/app/page.tsx" }],
        ],
      }),
    );
    expect(closeout.deploymentRequired).toBe(true);
    expect(
      seen.some(
        (line) =>
          line.includes("--paginate") &&
          line.includes("--slurp") &&
          line.includes("/pulls/42/files"),
      ),
    ).toBe(true);
  });

  it("stays unverified when slurped files pages are malformed", async () => {
    const seen: string[] = [];
    const closeout = await collectDeploymentCloseout(
      42,
      endToEndRunner(seen, { files: [[{ filename: 7 }]] }),
    );
    expect(closeout.deploymentRequired).toBe(true);
  });

  it("cannot claim not_required when changed_files exceeds the file list", async () => {
    const seen: string[] = [];
    const runner = fakeRunner((endpoint) => {
      if (endpoint === "repos/lukemyself-hub/SayHear/pulls/42/files") {
        return {
          code: 0,
          stdout: JSON.stringify([[{ filename: "docs/guide.md" }]]),
          stderr: "",
        };
      }
      if (endpoint === "repos/lukemyself-hub/SayHear/pulls/42") {
        return {
          code: 0,
          stdout: JSON.stringify({
            merged: true,
            merge_commit_sha: MERGE_SHA,
            changed_files: 2,
          }),
          stderr: "",
        };
      }
      if (
        endpoint ===
        `repos/lukemyself-hub/SayHear/deployments?sha=${MERGE_SHA}&per_page=100`
      ) {
        return {
          code: 0,
          stdout: JSON.stringify([[]]),
          stderr: "",
        };
      }
      if (
        endpoint ===
        "repos/lukemyself-hub/SayHear/deployments/7/statuses?per_page=100"
      ) {
        return {
          code: 0,
          stdout: JSON.stringify([[]]),
          stderr: "",
        };
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    }, seen);
    const closeout = await collectDeploymentCloseout(42, runner);
    expect(closeout.deploymentRequired).toBe(true);
    expect(closeout.status).toBe("unverified");
  });
});

describe("main", () => {
  async function runMain(
    argv: string[],
    runner: CommandRunner,
  ): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    const code = await main(
      argv,
      {
        stdout: (line) => {
          lines.push(line);
        },
      },
      runner,
    );
    return { code, lines };
  }

  it("exits 0 for succeeded", async () => {
    const { code, lines } = await runMain(
      ["--pr", "9"],
      mainRunner([
        {
          state: "success",
          created_at: "2026-10-16T00:00:01Z",
          environment_url: null,
        },
      ]),
    );
    expect(code).toBe(0);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      version: DEPLOYMENT_CLOSEOUT_VERSION,
      status: "succeeded",
    });
  });

  it("exits 0 for not_required", async () => {
    const { code, lines } = await runMain(
      ["--pr", "9"],
      mainRunner(
        [{ state: "success", created_at: "2026-10-16T00:00:01Z" }],
        [{ filename: "docs/guide.md" }],
      ),
    );
    expect(code).toBe(0);
    expect(JSON.parse(lines[0] ?? "").status).toBe("not_required");
  });

  it("exits 1 for failed", async () => {
    const { code } = await runMain(
      ["--pr", "9"],
      mainRunner([{ state: "failure", created_at: "2026-10-16T00:00:01Z" }]),
    );
    expect(code).toBe(1);
  });

  it("exits 2 for pending", async () => {
    const { code, lines } = await runMain(
      ["--pr", "9"],
      mainRunner([{ state: "queued", created_at: "2026-10-16T00:00:01Z" }]),
    );
    expect(code).toBe(2);
    expect(JSON.parse(lines[0] ?? "").status).toBe("pending");
  });

  it("exits 2 for unverified", async () => {
    const seen: string[] = [];
    const runner = fakeRunner((endpoint) => {
      if (endpoint === "repos/lukemyself-hub/SayHear/pulls/9") {
        return {
          code: 0,
          stdout: JSON.stringify({
            merged: true,
            merge_commit_sha: MERGE_SHA,
          }),
          stderr: "",
        };
      }
      if (endpoint === "repos/lukemyself-hub/SayHear/pulls/9/files") {
        return {
          code: 0,
          stdout: JSON.stringify([{ filename: "apps/web/app/page.tsx" }]),
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "deployments unreadable" };
    }, seen);
    const { code, lines } = await runMain(["--pr", "9"], runner);
    expect(code).toBe(2);
    expect(JSON.parse(lines[0] ?? "").status).toBe("unverified");
  });

  it("rejects anything but --pr N", async () => {
    const runner = mainRunner([]);
    for (const argv of [
      [],
      ["--pr"],
      ["--pr", "abc"],
      ["--pr", "0"],
      ["--pr", "9", "extra"],
      ["--fixture"],
    ]) {
      await expect(runMain(argv, runner)).rejects.toThrow();
    }
  });
});
