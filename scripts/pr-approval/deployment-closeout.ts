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
  const basename = path.slice(path.lastIndexOf("/") + 1);
  if (basename === "README.md") return true;
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

function isPendingState(state: string): boolean {
  return state === "queued" || state === "in_progress" || state === "pending";
}

function newestUnblockedSuccess(
  candidates: readonly DeploymentInput[],
): { id: number; url: string | null; at: number } | null {
  let newest: DeploymentInput | undefined = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (newest === undefined || candidate.id > newest.id) {
      newest = candidate;
    }
  }
  if (newest === undefined) return null;
  const ordered = newestFirst(newest.statuses);
  for (let index = 0; index < ordered.length; index += 1) {
    const status = ordered[index];
    if (status === undefined || status.state.toLowerCase() !== "success") {
      continue;
    }
    // Any newer failure/error keeps reporting failure, and any newer
    // queued/in_progress/pending means the latest attempt is still active, so
    // neither may be masked by this older success. Plain inactive is the
    // historical deactivation marker and does not block success.
    const blocked = ordered
      .slice(0, index)
      .some((entry) => {
        const newer = entry.state.toLowerCase();
        return (
          isFailureState(newer) || isPendingState(newer)
        );
      });
    if (blocked) break;
    return {
      id: newest.id,
      url: status.environment_url ?? null,
      at: statusTime(status.created_at),
    };
  }
  return null;
}

function newestCandidate(
  candidates: readonly DeploymentInput[],
): DeploymentInput {
  let best = candidates[0];
  if (best === undefined) throw new Error("No deployment candidate.");
  for (const candidate of candidates.slice(1)) {
    if (candidate.id > best.id) {
      best = candidate;
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
  // Inactive is only a historical deactivation marker: the fallback must read
  // the newest substantive status so a trailing inactive cannot hide a known
  // failure. Pending stays pending, failure/error stays failed, and plain
  // success -> inactive still succeeds through the helper above.
  const latest = newestFirst(newest.statuses).find(
    (entry) => entry.state.toLowerCase() !== "inactive",
  );
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

function toMergeSha(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function flattenSlurpedPages(stdout: string): unknown[] {
  const value: unknown = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value)) {
    throw new Error("Response is not slurped pages.");
  }
  if (value.every((page): page is unknown[] => Array.isArray(page))) {
    return (value as unknown[][]).flat();
  }
  return value;
}

function parseTimelinePages(stdout: string): Record<string, unknown>[] {
  const value: unknown = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value)) {
    throw new Error("Timeline response is not an array.");
  }
  const pages: unknown[] = value.every(
    (page): page is unknown[] => Array.isArray(page),
  )
    ? (value as unknown[][]).flat()
    : value;
  const events: Record<string, unknown>[] = [];
  for (const entry of pages) {
    if (!isRecord(entry)) throw new Error("Timeline event is invalid.");
    events.push(entry);
  }
  return events;
}

async function readMergedEventCommitSha(
  runner: CommandRunner,
  pullRequestNumber: number,
): Promise<string | null> {
  const timeline = await runner("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${REPOSITORY}/issues/${pullRequestNumber}/timeline`,
  ]);
  if (timeline.code !== 0) return null;
  let events: Record<string, unknown>[];
  try {
    events = parseTimelinePages(timeline.stdout);
  } catch {
    return null;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.event !== "merged") continue;
    const mergeSha = toMergeSha(event.commit_id);
    if (mergeSha !== null) return mergeSha;
  }
  return null;
}

function parseChangedPaths(value: unknown): {
  paths: string[];
  entryCount: number;
} {
  if (!Array.isArray(value)) throw new Error("Files response is not an array.");
  const pages: unknown[] = value.every(
    (page): page is unknown[] => Array.isArray(page),
  )
    ? (value as unknown[][]).flat()
    : value;
  const paths: string[] = [];
  for (const entry of pages) {
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
  return { paths, entryCount: pages.length };
}

function parseStatuses(stdout: string): DeploymentStatusInput[] {
  let value: unknown;
  try {
    value = flattenSlurpedPages(stdout);
  } catch {
    throw new Error("Statuses response is not an array.");
  }
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
      "--paginate",
      "--slurp",
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
  let mergeSha = toMergeSha(pull.merge_commit_sha);
  if (mergeSha === null) {
    mergeSha = await readMergedEventCommitSha(runner, pullRequestNumber);
  }
  if (mergeSha === null) throw new Error("merge_commit_sha_unavailable");
  const changedFiles =
    typeof pull.changed_files === "number" ? pull.changed_files : null;

  let changedPaths: string[] = [];
  let filesComplete = false;
  let filesRead = false;
  let filesApiOk = false;
  const files = await runner("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${REPOSITORY}/pulls/${pullRequestNumber}/files`,
  ]);
  if (files.code === 0) {
    filesApiOk = true;
    try {
      const parsed = parseChangedPaths(JSON.parse(files.stdout) as unknown);
      changedPaths = parsed.paths;
      filesRead = true;
      filesComplete =
        changedFiles === null || parsed.entryCount >= changedFiles;
    } catch {
      changedPaths = [];
      filesRead = false;
      filesComplete = false;
    }
  }

  // A complete docs-only file list ends the task before any deployment read.
  if (
    filesRead &&
    filesComplete &&
    !deploymentRequired(changedPaths)
  ) {
    return decideDeploymentCloseout({
      pullRequestNumber,
      mergeSha,
      changedPaths,
      deployments: [],
    });
  }

  // An empty, malformed, or partial file list that was actually read stays
  // conservative: treat it as deployment required with unverified
  // deployments, never not_required. An unreadable files endpoint (non-zero
  // exit) preserves the legacy behavior of continuing to the deployment read
  // with an empty path list.
  if (filesApiOk && (!filesRead || !filesComplete)) {
    return decideDeploymentCloseout({
      pullRequestNumber,
      mergeSha,
      changedPaths: [],
      deployments: null,
    });
  }

  let deployments: DeploymentInput[] | null = null;
  const listed = await runner("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${REPOSITORY}/deployments?sha=${mergeSha}&per_page=100`,
  ]);
  if (listed.code === 0) {
    try {
      const pages: unknown = JSON.parse(listed.stdout) as unknown;
      if (!Array.isArray(pages)) throw new Error("Deployments unreadable.");
      const flattened: unknown[] = pages.every(
        (page): page is unknown[] => Array.isArray(page),
      )
        ? (pages as unknown[][]).flat()
        : pages;
      if (flattened.length === 0) {
        const single: unknown = JSON.parse(listed.stdout) as unknown;
        if (Array.isArray(single) && !Array.isArray(single[0])) {
          deployments = await readDeployments(runner, single);
        } else {
          deployments = [];
        }
      } else {
        deployments = await readDeployments(runner, flattened);
      }
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
