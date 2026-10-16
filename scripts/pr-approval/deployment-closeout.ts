import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const DEPLOYMENT_CLOSEOUT_VERSION = "sayhear-deployment-closeout:v1";

const REPOSITORY = "lukemyself-hub/SayHear";

export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type DeploymentStatusInput = Readonly<{
  state: string;
  created_at: string;
  environment_url?: string | null;
}>;

export type DeploymentInput = Readonly<{
  id: number;
  sha: string;
  environment: string;
  statuses: readonly DeploymentStatusInput[];
}>;

export type DeploymentCloseout = Readonly<{
  version: string;
  pullRequestNumber: number;
  mergeSha: string;
  deploymentRequired: boolean;
  status: "not_required" | "succeeded" | "pending" | "failed" | "unverified";
  deploymentId: number | null;
  environmentUrl: string | null;
  reason: string;
}>;

export type DecideDeploymentCloseoutInput = Readonly<{
  pullRequestNumber: number;
  mergeSha: string;
  changedPaths: readonly string[];
  deployments: readonly DeploymentInput[] | null;
}>;

const NON_RUNTIME_PREFIXES = [
  "docs/",
  "tests/",
  "eval/",
  "scripts/",
  ".agents/",
  ".github/",
  ".codex/",
] as const;

function isNonRuntimePath(path: string): boolean {
  if (path === "GLOSSARY.md") return true;
  if (!path.includes("/") && path.endsWith(".md")) return true;
  return NON_RUNTIME_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function deploymentRequired(changedPaths: readonly string[]): boolean {
  if (changedPaths.length === 0) return true;
  return changedPaths.some((path) => !isNonRuntimePath(path));
}

function statusTime(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function newestFirst(
  statuses: readonly DeploymentStatusInput[],
): DeploymentStatusInput[] {
  return [...statuses].sort(
    (left, right) => statusTime(right.created_at) - statusTime(left.created_at),
  );
}

function isFailureState(state: string): boolean {
  return state === "failure" || state === "error";
}

function newestStatusTime(deployment: DeploymentInput): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const status of deployment.statuses) {
    const time = statusTime(status.created_at);
    if (time > best) best = time;
  }
  return best;
}

function newestUnblockedSuccess(
  candidates: readonly DeploymentInput[],
): { id: number; url: string | null; at: number } | null {
  let best: { id: number; url: string | null; at: number } | null = null;
  for (const candidate of candidates) {
    const ordered = newestFirst(candidate.statuses);
    for (let index = 0; index < ordered.length; index += 1) {
      const status = ordered[index];
      if (status === undefined || status.state.toLowerCase() !== "success") {
        continue;
      }
      const blocked = ordered
        .slice(0, index)
        .some((entry) => isFailureState(entry.state.toLowerCase()));
      if (blocked) break;
      const at = statusTime(status.created_at);
      if (best === null || at > best.at) {
        best = { id: candidate.id, url: status.environment_url ?? null, at };
      }
      break;
    }
  }
  return best;
}

function newestCandidate(
  candidates: readonly DeploymentInput[],
): DeploymentInput {
  let best = candidates[0];
  if (best === undefined) throw new Error("No deployment candidate.");
  let bestTime = newestStatusTime(best);
  for (const candidate of candidates.slice(1)) {
    const time = newestStatusTime(candidate);
    if (time > bestTime || (time === bestTime && candidate.id > best.id)) {
      best = candidate;
      bestTime = time;
    }
  }
  return best;
}

export function decideDeploymentCloseout(
  input: DecideDeploymentCloseoutInput,
): DeploymentCloseout {
  const required = deploymentRequired(input.changedPaths);
  const identity = {
    version: DEPLOYMENT_CLOSEOUT_VERSION,
    pullRequestNumber: input.pullRequestNumber,
    mergeSha: input.mergeSha,
    deploymentRequired: required,
  };
  if (!required) {
    return {
      ...identity,
      status: "not_required",
      deploymentId: null,
      environmentUrl: null,
      reason: `PR #${input.pullRequestNumber} changed only documentation or tooling, so the merge alone ends the task.`,
    };
  }
  if (input.deployments === null) {
    return {
      ...identity,
      status: "unverified",
      deploymentId: null,
      environmentUrl: null,
      reason: `Deployments for merge ${input.mergeSha} could not be read, so deployment status is unverified.`,
    };
  }
  const mergeSha = input.mergeSha.toLowerCase();
  const candidates = input.deployments.filter(
    (deployment) =>
      deployment.sha.toLowerCase() === mergeSha &&
      /^production\b/i.test(deployment.environment),
  );
  if (candidates.length === 0) {
    return {
      ...identity,
      status: "pending",
      deploymentId: null,
      environmentUrl: null,
      reason: `No production deployment exists for merge ${input.mergeSha} yet.`,
    };
  }
  const success = newestUnblockedSuccess(candidates);
  if (success !== null) {
    return {
      ...identity,
      status: "succeeded",
      deploymentId: success.id,
      environmentUrl: success.url,
      reason: `Production deployment ${success.id} for merge ${input.mergeSha} succeeded.`,
    };
  }
  const newest = newestCandidate(candidates);
  const latest = newestFirst(newest.statuses)[0];
  const state = latest?.state.toLowerCase() ?? "";
  if (state === "failure" || state === "error") {
    return {
      ...identity,
      status: "failed",
      deploymentId: newest.id,
      environmentUrl: latest?.environment_url ?? null,
      reason: `Production deployment ${newest.id} for merge ${input.mergeSha} reported ${state}.`,
    };
  }
  if (latest === undefined) {
    return {
      ...identity,
      status: "pending",
      deploymentId: newest.id,
      environmentUrl: null,
      reason: `Production deployment ${newest.id} for merge ${input.mergeSha} has reported no status yet.`,
    };
  }
  return {
    ...identity,
    status: "pending",
    deploymentId: newest.id,
    environmentUrl: latest.environment_url ?? null,
    reason: `Production deployment ${newest.id} for merge ${input.mergeSha} is still ${state}.`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChangedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Files response is not an array.");
  const paths: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.filename !== "string") {
      throw new Error("File entry is invalid.");
    }
    paths.push(entry.filename);
    if (
      typeof entry.previous_filename === "string" &&
      entry.previous_filename.length > 0
    ) {
      paths.push(entry.previous_filename);
    }
  }
  return paths;
}

function parseStatuses(stdout: string): DeploymentStatusInput[] {
  const value: unknown = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value)) {
    throw new Error("Statuses response is not an array.");
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.state !== "string" ||
      typeof entry.created_at !== "string"
    ) {
      throw new Error("Deployment status entry is invalid.");
    }
    const url = entry.environment_url;
    if (url !== undefined && url !== null && typeof url !== "string") {
      throw new Error("Deployment status entry is invalid.");
    }
    return {
      state: entry.state,
      created_at: entry.created_at,
      environment_url: typeof url === "string" ? url : null,
    };
  });
}

async function readDeployments(
  runner: CommandRunner,
  value: unknown,
): Promise<DeploymentInput[]> {
  if (!Array.isArray(value)) {
    throw new Error("Deployments response is not an array.");
  }
  const deployments: DeploymentInput[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "number" ||
      !Number.isSafeInteger(entry.id) ||
      typeof entry.sha !== "string" ||
      typeof entry.environment !== "string"
    ) {
      throw new Error("Deployment entry is invalid.");
    }
    const statuses = await runner("gh", [
      "api",
      `repos/${REPOSITORY}/deployments/${entry.id}/statuses?per_page=100`,
    ]);
    if (statuses.code !== 0) {
      throw new Error(`Deployment ${entry.id} statuses could not be read.`);
    }
    deployments.push({
      id: entry.id,
      sha: entry.sha,
      environment: entry.environment,
      statuses: parseStatuses(statuses.stdout),
    });
  }
  return deployments;
}

export async function collectDeploymentCloseout(
  pullRequestNumber: number,
  runner: CommandRunner,
): Promise<DeploymentCloseout> {
  const pr = await runner("gh", [
    "api",
    `repos/${REPOSITORY}/pulls/${pullRequestNumber}`,
  ]);
  if (pr.code !== 0) {
    throw new Error(
      pr.stderr.trim() ||
        `gh api repos/${REPOSITORY}/pulls/${pullRequestNumber} failed.`,
    );
  }
  let pull: unknown;
  try {
    pull = JSON.parse(pr.stdout) as unknown;
  } catch {
    throw new Error(`Pull request ${pullRequestNumber} could not be read.`);
  }
  if (!isRecord(pull) || pull.merged !== true) {
    throw new Error("pull_request_not_merged");
  }
  const mergeSha =
    typeof pull.merge_commit_sha === "string" &&
    pull.merge_commit_sha.length > 0
      ? pull.merge_commit_sha
      : null;
  if (mergeSha === null) throw new Error("merge_commit_sha_unavailable");

  let changedPaths: string[] = [];
  const files = await runner("gh", [
    "api",
    "--paginate",
    `repos/${REPOSITORY}/pulls/${pullRequestNumber}/files`,
  ]);
  if (files.code === 0) {
    try {
      changedPaths = parseChangedPaths(JSON.parse(files.stdout) as unknown);
    } catch {
      changedPaths = [];
    }
  }

  let deployments: DeploymentInput[] | null = null;
  const listed = await runner("gh", [
    "api",
    `repos/${REPOSITORY}/deployments?sha=${mergeSha}&per_page=100`,
  ]);
  if (listed.code === 0) {
    try {
      deployments = await readDeployments(
        runner,
        JSON.parse(listed.stdout) as unknown,
      );
    } catch {
      deployments = null;
    }
  }

  return decideDeploymentCloseout({
    pullRequestNumber,
    mergeSha,
    changedPaths,
    deployments,
  });
}

function parsePullRequestNumber(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

const execFileAsync = promisify(execFile);

const realRunner: CommandRunner = async (command, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: typeof failure.code === "number" ? failure.code : 1,
    };
  }
};

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: { stdout: (line: string) => void } = {
    stdout: (line) => process.stdout.write(`${line}\n`),
  },
  runner: CommandRunner = realRunner,
): Promise<number> {
  const flag = argv[0];
  const value = argv[1];
  const pullRequestNumber =
    argv.length === 2 && flag === "--pr" ? parsePullRequestNumber(value) : null;
  if (pullRequestNumber === null) {
    throw new Error("Usage: deployment-closeout.ts --pr <pull-request-number>");
  }
  const closeout = await collectDeploymentCloseout(pullRequestNumber, runner);
  io.stdout(JSON.stringify(closeout, null, 2));
  if (closeout.status === "failed") return 1;
  if (closeout.status === "pending" || closeout.status === "unverified") {
    return 2;
  }
  return 0;
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
