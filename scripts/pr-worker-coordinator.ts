/**
 * Thin executable glue for #366/#368. Codex stays the orchestrator and only
 * delegate-opencode caller. This helper binds reserve/attach/status/accept/
 * release/stop/finding to the SAME ownership record, bracketed by the real
 * service adapter. It never approves, merges, pushes, or launches a model.
 * Local execution output is NOT a GitHub approval or authorization.
 * Pending controller packet bridge: coordinator maps that packet onto
 * CoordinatorRequest instead of adding new state machinery here.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  PrWorkCoordinationStore,
  acceptResult,
  attachSession,
  readWork,
  recordFinding,
  releaseWork,
  reserveWork,
  type WorkRole,
} from "./pr-work-coordination.ts";
import {
  PR_WORKER_SERVICE_DEFAULT_TIMEOUT_MS,
  capturePrWorkerServiceIdentity,
  probePrWorkerSession,
  requestPrWorkerSessionStop,
  type PrWorkerServiceConfig,
  type PrWorkerServiceIdentity,
} from "./pr-worker-service.ts";

export interface CoordinatorRequest {
  repositoryId: number;
  pullRequestNumber: number;
  head: string;
  changeDigest: string;
  ledger: { roundsConsumed: number; paused: boolean; historyConsistent: boolean; latestReviewedHead: string | null };
  role: WorkRole;
  worktree: string;
  allowedPaths: string[];
  taskFile: string;
  taskSha256: string;
  workerStateDir: string;
  expectedAttempt: number;
  expectedService: PrWorkerServiceIdentity;
  resumeSessionId?: string;
  startingWorktreeDigest?: string;
  /**
   * Explicit re-review: bypasses only the `already_reviewed` refusal for a
   * code-review reserve. Defaults to false; never part of the scope digest.
   */
  reReview?: boolean;
  finding?: { key: string; status: "confirmed" | "refuted" | "disputed"; evidence: string; repairDirective?: string | null };
}
export type ServiceOverrides = Pick<PrWorkerServiceConfig, "baseUrl" | "credentialFile" | "timeoutMs" | "fetch">;
export interface RunOptions { stateDir: string; ownerToken?: string; serviceConfig?: ServiceOverrides }
export interface CliOutcome { exitCode: number; output: Record<string, unknown> }
const runExec = promisify(execFile);
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
function fail(message: string): never { throw new Error(message); }
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("request must be a JSON object.");
  return value as Record<string, unknown>;
}
function posInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`${name} must be a positive safe integer.`);
  return value as number;
}
/** Validate the immutable coordinator request. Reads no App keys. */
export function parseCoordinatorRequest(raw: unknown): CoordinatorRequest {
  const v = asRecord(raw);
  const repositoryId = posInt(v.repositoryId, "repositoryId");
  const pullRequestNumber = posInt(v.pullRequestNumber, "pullRequestNumber");
  if (typeof v.head !== "string" || !HEX40.test(v.head.toLowerCase())) fail("head must be 40-char hex.");
  if (typeof v.changeDigest !== "string" || !HEX64.test(v.changeDigest.toLowerCase())) fail("changeDigest must be 64-char hex.");
  const ledger = asRecord(v.ledger);
  if (typeof ledger.roundsConsumed !== "number" || !Number.isSafeInteger(ledger.roundsConsumed) || (ledger.roundsConsumed as number) < 0) fail("ledger.roundsConsumed must be a non-negative integer.");
  if (typeof ledger.paused !== "boolean" || typeof ledger.historyConsistent !== "boolean") fail("ledger must carry paused/historyConsistent.");
  if (!("latestReviewedHead" in ledger)) fail("ledger.latestReviewedHead is required.");
  const latestReviewedHead = ledger.latestReviewedHead as unknown;
  if (latestReviewedHead !== null && (typeof latestReviewedHead !== "string" || !HEX40.test(latestReviewedHead.toLowerCase()) || latestReviewedHead.toLowerCase() !== latestReviewedHead)) {
    fail("ledger.latestReviewedHead must be null or a 40-char lowercase hex head.");
  }
  if (v.role !== "implementation" && v.role !== "code-review") fail('role must be "implementation" or "code-review".');
  for (const field of ["worktree", "taskFile", "workerStateDir"] as const) {
    if (typeof v[field] !== "string" || !isAbsolute(v[field] as string)) fail(`${field} must be an absolute path.`);
  }
  if (!Array.isArray(v.allowedPaths)) fail("allowedPaths must be an array.");
  const allowedPaths = (v.allowedPaths as unknown[]).map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 256) fail("allowedPaths entries must be 1-256 chars.");
    if (entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes("..")) fail("allowedPaths must be repo-relative without escapes.");
    return entry;
  });
  if (v.role === "implementation" && allowedPaths.length === 0) fail("allowedPaths must be nonempty for implementation.");
  if (typeof v.taskSha256 !== "string" || !HEX64.test((v.taskSha256 as string).toLowerCase())) fail("taskSha256 must be 64-char hex.");
  const expectedAttempt = posInt(v.expectedAttempt, "expectedAttempt");
  if (v.reReview !== undefined && typeof v.reReview !== "boolean") fail("reReview must be a boolean.");
  const reReview = (v.reReview as boolean | undefined) ?? false;
  const service = asRecord(v.expectedService);
  if (typeof service.pid !== "number" || !Number.isInteger(service.pid) || (service.pid as number) <= 0) fail("expectedService.pid must be a positive integer.");
  if (typeof service.version !== "string" || service.version.length === 0 || service.version.length > 128) fail("expectedService.version must be 1-128 chars.");
  const hasResumeSession = v.resumeSessionId !== undefined;
  const hasBaseline = v.startingWorktreeDigest !== undefined;
  if (hasResumeSession !== hasBaseline) fail("resumeSessionId and startingWorktreeDigest must be paired.");
  let resumeSessionId: string | undefined;
  let startingWorktreeDigest: string | undefined;
  if (hasResumeSession && hasBaseline) {
    if (v.role !== "implementation") fail("resume fields require implementation role.");
    if (expectedAttempt < 2) fail("resume fields require expectedAttempt >= 2.");
    if (typeof v.resumeSessionId !== "string" || v.resumeSessionId.length === 0 || v.resumeSessionId.length > 256) fail("resumeSessionId must be 1-256 chars.");
    if (typeof v.startingWorktreeDigest !== "string" || !HEX64.test((v.startingWorktreeDigest as string).toLowerCase())) fail("startingWorktreeDigest must be 64-char hex.");
    resumeSessionId = v.resumeSessionId as string;
    startingWorktreeDigest = (v.startingWorktreeDigest as string).toLowerCase();
  }
  let finding: CoordinatorRequest["finding"];
  if (v.finding !== undefined) {
    const f = asRecord(v.finding);
    if (typeof f.key !== "string" || f.key.length === 0) fail("finding.key is required.");
    if (f.status !== "confirmed" && f.status !== "refuted" && f.status !== "disputed") fail("finding.status must be confirmed/refuted/disputed.");
    if (typeof f.evidence !== "string" || f.evidence.length === 0) fail("finding.evidence is required.");
    const repair = f.repairDirective ?? null;
    if (repair !== null && (typeof repair !== "string" || repair.length === 0)) fail("finding repairDirective must be a string or absent.");
    finding = { key: f.key as string, status: f.status as NonNullable<CoordinatorRequest["finding"]>["status"], evidence: f.evidence as string, repairDirective: repair as string | null };
  }
  return {
    repositoryId, pullRequestNumber, head: (v.head as string).toLowerCase(), changeDigest: (v.changeDigest as string).toLowerCase(),
    ledger: { roundsConsumed: ledger.roundsConsumed as number, paused: ledger.paused as boolean, historyConsistent: ledger.historyConsistent as boolean, latestReviewedHead: latestReviewedHead as string | null },
    role: v.role as WorkRole, worktree: v.worktree as string, allowedPaths, taskFile: v.taskFile as string,
    taskSha256: (v.taskSha256 as string).toLowerCase(),
    workerStateDir: v.workerStateDir as string, expectedAttempt,
    expectedService: { pid: service.pid as number, version: service.version as string },
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    ...(startingWorktreeDigest === undefined ? {} : { startingWorktreeDigest }),
    ...(v.reReview === undefined ? {} : { reReview }),
    ...(finding === undefined ? {} : { finding }),
  };
}
/** Scope binding: any post-reserve request edit changes this digest. */
export function computeScopeDigest(request: CoordinatorRequest): string {
  return createHash("sha256").update(JSON.stringify({
    allowedPaths: [...request.allowedPaths].sort(), changeDigest: request.changeDigest,
    expectedAttempt: request.expectedAttempt, expectedService: request.expectedService,
    head: request.head, ledger: request.ledger, pullRequestNumber: request.pullRequestNumber,
    repositoryId: request.repositoryId, resumeSessionId: request.resumeSessionId ?? null,
    role: request.role, startingWorktreeDigest: request.startingWorktreeDigest ?? null,
    taskFile: resolve(request.taskFile),
    taskSha256: request.taskSha256.toLowerCase(), workerStateDir: resolve(request.workerStateDir),
    worktree: resolve(request.worktree),
  })).digest("hex");
}
async function canonicalExisting(path: string, what: string): Promise<string> {
  const canon = await realpath(path).catch(() => fail(`${what} is not accessible.`));
  if (resolve(path) !== canon) fail(`${what} must be canonical.`);
  return canon;
}
async function canonicalWorkerDir(path: string): Promise<string> {
  try {
    const canon = await realpath(path);
    if (resolve(path) !== canon) fail("workerStateDir must be canonical.");
    return canon;
  } catch (error) {
    // Only a missing directory falls back to parent validation. Any other
    // failure (including the canonicality refusal above for a pre-existing
    // symlink) is rethrown so an alias can never stand in for the bound dir.
    if ((error as { code?: unknown } | null)?.code !== "ENOENT") throw error;
    const parentCanon = await realpath(dirname(path)).catch(() => fail("workerStateDir parent is not accessible."));
    const base = basename(resolve(path));
    if (!base || base === "." || base === ".." || base.includes("\0")) fail("workerStateDir must be canonical.");
    const canon = join(parentCanon, base);
    if (resolve(path) !== canon) fail("workerStateDir must be canonical.");
    return canon;
  }
}
async function requireTaskMatch(canonicalTaskFile: string, expected: string): Promise<void> {
  const bytes = await readFile(canonicalTaskFile).catch(() => fail("taskFile is not accessible."));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected.toLowerCase()) fail("stale_task_marker");
}
function staleTask(): CliOutcome { return { exitCode: 1, output: { ok: false, reason: "stale_task" } }; }
async function requireTaskBytes(taskFile: string, expected: string): Promise<CliOutcome | null> {
  try {
    await requireTaskMatch(taskFile, expected);
    return null;
  } catch (error) {
    if ((error as Error).message === "stale_task_marker") return staleTask();
    throw error;
  }
}
function serviceConfig(overrides?: ServiceOverrides): PrWorkerServiceConfig {
  return { timeoutMs: PR_WORKER_SERVICE_DEFAULT_TIMEOUT_MS, ...(overrides ?? {}) };
}
function storeFor(stateDir: string): PrWorkCoordinationStore {
  if (!isAbsolute(stateDir)) fail("stateDir must be an absolute path.");
  return new PrWorkCoordinationStore({ stateDir: resolve(stateDir) });
}
function ownerTokenOf(options: RunOptions): string {
  const token = (options.ownerToken ?? "").toLowerCase();
  if (!HEX32.test(token)) fail("ownerToken must be the 32-char reservation token.");
  return token;
}
function heldExit(reason: string): number {
  return ["occupied", "already_reviewed", "dispatched_unattached", "worker_running", "worker_unknown", "session_unknown", "paused", "rounds_exhausted", "history_inconsistent", "review_not_recorded", "repeated_finding", "model_changed", "not_completed", "still_running", "awaiting_release"].includes(reason) ? 2 : 1;
}
async function git(worktree: string, argv: string[]): Promise<string> {
  const { stdout } = await runExec("git", argv, { cwd: worktree, timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}
async function gitBytes(worktree: string, argv: string[]): Promise<Buffer> {
  const { stdout } = await runExec("git", argv, {
    cwd: worktree, timeout: 10_000, maxBuffer: 10 * 1024 * 1024, encoding: "buffer",
  }) as unknown as { stdout: Buffer };
  return Buffer.from(stdout as unknown as Uint8Array);
}
async function headOf(worktree: string): Promise<string> {
  const head = (await git(worktree, ["rev-parse", "HEAD"])).trim().toLowerCase();
  if (!HEX40.test(head)) fail("worktree HEAD is not 40-char hex.");
  return head;
}
interface StatusEntry { path: string; untracked: boolean }
/** Exact NUL parse of `git status --porcelain=v1 -z`. Never trims/unquotes filenames. */
async function collectStatusEntries(worktree: string): Promise<StatusEntry[]> {
  const buf = await gitBytes(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"]);
  const chunks: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) {
      chunks.push(buf.subarray(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  if (start < buf.length) chunks.push(buf.subarray(start).toString("utf8"));
  if (start === buf.length && buf.length > 0 && buf[buf.length - 1] !== 0) {
    chunks.push(buf.subarray(start).toString("utf8"));
  }
  const entries: StatusEntry[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i] as string;
    if (chunk.length === 0) continue;
    if (chunk.length < 4 || chunk[2] !== " ") fail("worktree status is invalid.");
    const xy = chunk.slice(0, 2);
    const first = chunk.slice(3);
    if (first.length === 0) fail("worktree status is invalid.");
    const renamed = xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C";
    if (renamed) {
      const second = chunks[(i += 1)] as string | undefined;
      if (second === undefined || second.length === 0) fail("worktree status is invalid.");
      entries.push({ path: first, untracked: false });
      entries.push({ path: second, untracked: false });
    } else {
      entries.push({ path: first, untracked: xy === "??" });
    }
  }
  return entries;
}
/** Changed repo-relative paths including untracked entries and both rename sides. */
export async function collectChangedPaths(worktree: string): Promise<string[]> {
  const paths = new Set<string>();
  for (const entry of await collectStatusEntries(worktree)) {
    paths.add(entry.path);
  }
  return [...paths].sort();
}
/**
 * Deterministic actual-change digest: tracked `git diff HEAD` bytes plus every
 * untracked path/kind/content. JSON tuple binding avoids concat ambiguity.
 * Untracked symlinks record the link target text via lstat+readlink and never
 * read the target. Missing/moving entries fail closed. Small helper for accept
 * and the upcoming resume baseline; not a store.
 */
export async function collectChangeDigest(worktree: string): Promise<string> {
  const tracked = await gitBytes(worktree, ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv", "--"]);
  const untrackedPaths = (await collectStatusEntries(worktree))
    .filter((entry) => entry.untracked)
    .map((entry) => entry.path)
    .sort();
  const root = resolve(worktree);
  const untracked: Array<{ path: string; kind: string; bytes?: string; target?: string }> = [];
  for (const rel of untrackedPaths) {
    if (rel.length === 0 || rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..")) {
      fail("worktree entry is invalid.");
    }
    const abs = resolve(join(root, rel));
    if (abs !== join(root, rel) || (!abs.startsWith(`${root}/`) && abs !== root)) fail("worktree entry is invalid.");
    const st = await lstat(abs).catch(() => fail("worktree entry is invalid."));
    if (st.isSymbolicLink()) {
      const target = await readlink(abs).catch(() => fail("worktree entry is invalid."));
      untracked.push({ path: rel, kind: "symlink", target });
    } else if (st.isFile()) {
      const bytes = await readFile(abs).catch(() => fail("worktree entry is invalid."));
      untracked.push({ path: rel, kind: "file", bytes: bytes.toString("base64") });
    } else {
      fail("worktree entry is invalid.");
    }
  }
  return createHash("sha256")
    .update(JSON.stringify({ tracked: tracked.toString("base64"), untracked }))
    .digest("hex");
}
function inScope(changed: string, allowed: string[]): boolean {
  return allowed.some((scope) => changed === scope || changed.startsWith(`${scope}/`));
}
async function readJson(path: string, what: string): Promise<Record<string, unknown>> {
  const raw = await readFile(path, "utf8").catch(() => fail(`${what} is missing.`));
  return asRecord(JSON.parse(raw as string) as unknown);
}
interface WrapperReceipt {
  sessionId: string;
  role: string;
  worktree: string;
  attempt: number;
  taskSha256: string;
  model: string | null;
  status: string;
  cliExitCode: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: number | null;
}
/** Strict parse of the real wrapper receipt shape (session.json and per-attempt share it). */
function parseWrapperReceipt(v: Record<string, unknown>, what: string): WrapperReceipt {
  if (typeof v.session_id !== "string" || v.session_id.length === 0 || v.session_id.length > 256) fail(`${what} is malformed.`);
  if (typeof v.agent !== "string" || v.agent.length === 0 || v.agent.length > 64) fail(`${what} is malformed.`);
  if (typeof v.directory !== "string" || !isAbsolute(v.directory)) fail(`${what} is malformed.`);
  if (typeof v.attempt !== "number" || !Number.isSafeInteger(v.attempt) || v.attempt < 1) fail(`${what} is malformed.`);
  if (typeof v.status !== "string" || (v.status !== "running" && v.status !== "completed" && v.status !== "blocked" && v.status !== "timed_out" && v.status !== "interrupted")) fail(`${what} is malformed.`);
  if (v.model !== undefined && (typeof v.model !== "string" || v.model.length === 0 || v.model.length > 256)) fail(`${what} is malformed.`);
  const model = typeof v.model === "string" ? v.model : null;
  if (v.service_version !== undefined && (typeof v.service_version !== "string" || v.service_version.length === 0 || v.service_version.length > 64)) fail(`${what} is malformed.`);
  if (typeof v.task_sha256 !== "string" || !HEX64.test((v.task_sha256 as string).toLowerCase())) fail(`${what} is malformed.`);
  let cliExitCode: number | null = null;
  if (v.cli_exit_code !== undefined && v.cli_exit_code !== null) {
    if (typeof v.cli_exit_code !== "number" || !Number.isSafeInteger(v.cli_exit_code)) fail(`${what} is malformed.`);
    cliExitCode = v.cli_exit_code as number;
  }
  let finishedAt: number | null = null;
  if (v.finished_at !== undefined && v.finished_at !== null) {
    if (typeof v.finished_at !== "number" || !Number.isFinite(v.finished_at)) fail(`${what} is malformed.`);
    finishedAt = v.finished_at as number;
  }
  let errorCode: string | null = null;
  if (v.error_code !== undefined && v.error_code !== null && v.error_code !== "") {
    if (typeof v.error_code !== "string" || (v.error_code as string).length === 0) fail(`${what} is malformed.`);
    errorCode = v.error_code as string;
  }
  let errorMessage: string | null = null;
  if (v.error !== undefined && v.error !== null && v.error !== "") {
    if (typeof v.error !== "string" || (v.error as string).length === 0) fail(`${what} is malformed.`);
    errorMessage = v.error as string;
  }
  return {
    sessionId: v.session_id as string, role: v.agent as string, worktree: v.directory as string,
    attempt: v.attempt as number, taskSha256: (v.task_sha256 as string).toLowerCase(), model,
    status: v.status as string, cliExitCode, errorCode, errorMessage, finishedAt,
  };
}
async function wrapperSession(stateDir: string): Promise<WrapperReceipt> {
  const v = await readJson(join(stateDir, "session.json"), "wrapper session.json");
  return parseWrapperReceipt(v, "wrapper session.json");
}
async function attemptStatus(stateDir: string, attempt: number): Promise<WrapperReceipt> {
  const name = `attempt-${String(attempt).padStart(3, "0")}-status.json`;
  const v = await readJson(join(stateDir, name), "wrapper per-attempt status");
  return parseWrapperReceipt(v, "wrapper per-attempt status");
}
export async function runCapture(overrides?: ServiceOverrides): Promise<CliOutcome> {
  const captured = await capturePrWorkerServiceIdentity(serviceConfig(overrides));
  if (!captured.ok) return { exitCode: 2, output: { ok: false, reason: captured.reason, detail: captured.detail } };
  return { exitCode: 0, output: { ok: true, service: captured.service } };
}
export async function runReserve(request: CoordinatorRequest, options: RunOptions): Promise<CliOutcome> {
  const scopeDigest = computeScopeDigest(request);
  const worktree = await canonicalExisting(request.worktree, "worktree");
  const taskFile = await canonicalExisting(request.taskFile, "taskFile");
  const workerStateDir = await canonicalWorkerDir(request.workerStateDir);
  const stale = await requireTaskBytes(taskFile, request.taskSha256);
  if (stale !== null) return stale;
  if ((await headOf(worktree)) !== request.head) return { exitCode: 1, output: { ok: false, reason: "stale_head" } };
  const store = storeFor(options.stateDir);
  const existing = await readWork(store, { repositoryId: request.repositoryId, pullRequestNumber: request.pullRequestNumber });
  if (existing?.owner !== null && existing?.owner !== undefined) {
    return { exitCode: 2, output: { ok: false, reason: "occupied" } };
  }
  const hasResume = request.resumeSessionId !== undefined || request.startingWorktreeDigest !== undefined;
  if (hasResume) {
    if (request.resumeSessionId === undefined || request.startingWorktreeDigest === undefined) {
      return { exitCode: 1, output: { ok: false, reason: "resume_requires_paired_fields" } };
    }
    if (request.role !== "implementation") {
      return { exitCode: 1, output: { ok: false, reason: "resume_requires_implementation" } };
    }
    if (request.expectedAttempt < 2) {
      return { exitCode: 1, output: { ok: false, reason: "resume_requires_attempt" } };
    }
    if (!HEX64.test(request.startingWorktreeDigest.toLowerCase())) {
      return { exitCode: 1, output: { ok: false, reason: "invalid", detail: "startingWorktreeDigest must be 64-char hex." } };
    }
    if (request.resumeSessionId.length === 0 || request.resumeSessionId.length > 256) {
      return { exitCode: 1, output: { ok: false, reason: "invalid", detail: "resumeSessionId must be 1-256 chars." } };
    }
    const seen = existing?.seenSessions.find((entry) => entry.id === request.resumeSessionId && entry.role === "implementation");
    if (seen === undefined) {
      return { exitCode: 1, output: { ok: false, reason: "resume_unknown_session" } };
    }
    let receipt: WrapperReceipt;
    try {
      receipt = await wrapperSession(workerStateDir);
    } catch {
      return { exitCode: 1, output: { ok: false, reason: "resume_receipt_mismatch" } };
    }
    if (
      receipt.sessionId !== request.resumeSessionId ||
      receipt.role !== "implementation" ||
      receipt.role !== request.role ||
      resolve(receipt.worktree) !== worktree
    ) {
      return { exitCode: 1, output: { ok: false, reason: "resume_receipt_mismatch" } };
    }
    if (receipt.taskSha256 !== request.taskSha256.toLowerCase()) return staleTask();
    if (receipt.attempt !== request.expectedAttempt - 1) {
      return { exitCode: 1, output: { ok: false, reason: "resume_attempt_mismatch" } };
    }
    if (receipt.status === "running" || (receipt.status !== "completed" && receipt.status !== "blocked" && receipt.status !== "timed_out" && receipt.status !== "interrupted")) {
      return { exitCode: 1, output: { ok: false, reason: "resume_not_terminal", status: receipt.status } };
    }
    const probe = await probePrWorkerSession(serviceConfig(options.serviceConfig), { expectedService: request.expectedService, sessionId: request.resumeSessionId });
    if (probe.state !== "stopped") {
      if (probe.state === "running") return { exitCode: 2, output: { ok: false, reason: "worker_running", probe: "running" } };
      return { exitCode: 2, output: { ok: false, reason: probe.reason ?? "worker_unknown", probe: "unknown" } };
    }
    const actualDigest = await collectChangeDigest(worktree);
    if (actualDigest !== request.startingWorktreeDigest.toLowerCase()) {
      return { exitCode: 1, output: { ok: false, reason: "resume_baseline_mismatch" } };
    }
    const changed = await collectChangedPaths(worktree);
    const outside = changed.filter((path) => !inScope(path, request.allowedPaths));
    if (outside.length > 0) {
      return { exitCode: 1, output: { ok: false, reason: "outside_scope", changed, outside } };
    }
  } else {
    if ((await collectChangedPaths(resolve(request.worktree))).length !== 0) {
      return { exitCode: 1, output: { ok: false, reason: "worktree_not_clean" } };
    }
  }
  const reserved = await reserveWork(store, {
    repositoryId: request.repositoryId, pullRequestNumber: request.pullRequestNumber, role: request.role,
    startHead: request.head, scopeDigest, changeDigest: request.changeDigest, worktree,
    taskFile, workerStateDir, ledger: request.ledger,
    ...(request.reReview === undefined ? {} : { reReview: request.reReview }),
  });
  if (!reserved.ok) return { exitCode: heldExit(reserved.reason), output: { ok: false, reason: reserved.reason } };
  return { exitCode: 0, output: { ok: true, ownerToken: reserved.record.owner?.token ?? "", scopeDigest, head: request.head } };
}
export async function runAttach(request: CoordinatorRequest, options: RunOptions): Promise<CliOutcome> {
  const token = ownerTokenOf(options);
  const scopeDigest = computeScopeDigest(request);
  const worktree = await canonicalExisting(request.worktree, "worktree");
  const taskFile = await canonicalExisting(request.taskFile, "taskFile");
  const workerStateDir = await canonicalWorkerDir(request.workerStateDir);
  const stale = await requireTaskBytes(taskFile, request.taskSha256);
  if (stale !== null) return stale;
  const session = await wrapperSession(workerStateDir);
  if (session.role !== request.role || resolve(session.worktree) !== worktree) {
    return { exitCode: 1, output: { ok: false, reason: "session_binding_mismatch" } };
  }
  if (session.attempt !== request.expectedAttempt) return { exitCode: 1, output: { ok: false, reason: "attempt_mismatch" } };
  if (session.taskSha256 !== request.taskSha256.toLowerCase()) return staleTask();
  if (request.resumeSessionId !== undefined || request.startingWorktreeDigest !== undefined) {
    if (request.resumeSessionId === undefined || request.startingWorktreeDigest === undefined) {
      return { exitCode: 1, output: { ok: false, reason: "resume_requires_paired_fields" } };
    }
    if (request.role !== "implementation") {
      return { exitCode: 1, output: { ok: false, reason: "resume_requires_implementation" } };
    }
    if (request.expectedAttempt < 2) {
      return { exitCode: 1, output: { ok: false, reason: "resume_requires_attempt" } };
    }
    if (session.sessionId !== request.resumeSessionId) {
      return { exitCode: 1, output: { ok: false, reason: "resume_session_mismatch" } };
    }
  }
  const probe = await probePrWorkerSession(serviceConfig(options.serviceConfig), { expectedService: request.expectedService, sessionId: session.sessionId });
  if (probe.state === "unknown") {
    return { exitCode: 2, output: { ok: false, reason: probe.reason ?? "worker_unknown", probe: "unknown" } };
  }
  const attached = await attachSession(storeFor(options.stateDir), {
    repositoryId: request.repositoryId, pullRequestNumber: request.pullRequestNumber, ownerToken: token,
    startHead: request.head, scopeDigest, role: request.role, sessionId: session.sessionId, workerStateDir,
    model: session.model,
  });
  if (!attached.ok) return { exitCode: heldExit(attached.reason), output: { ok: false, reason: attached.reason } };
  return { exitCode: 0, output: { ok: true, sessionId: session.sessionId, resumed: attached.resumed, probe: probe.state } };
}
export async function runStatus(request: CoordinatorRequest, options: RunOptions): Promise<CliOutcome> {
  const record = await readWork(storeFor(options.stateDir), { repositoryId: request.repositoryId, pullRequestNumber: request.pullRequestNumber });
  // Findings ride along so a restarted coordinator sees the repeat latch
  // without another command.
  const findings = (record?.findings ?? []).map((finding) => ({
    key: finding.key, status: finding.status, repeatedAfterFix: finding.repeatedAfterFix,
  }));
  if (record?.owner === null || record?.owner === undefined) return { exitCode: 2, output: { ok: false, reason: "no_owner", probe: "unknown", findings } };
  if (record.owner.scopeDigest !== computeScopeDigest(request)) return { exitCode: 1, output: { ok: false, reason: "scope_mismatch" } };
  if (record.owner.sessionId === null) return { exitCode: 2, output: { ok: false, reason: "session_unknown", probe: "unknown", findings } };
  const probe = await probePrWorkerSession(serviceConfig(options.serviceConfig), { expectedService: request.expectedService, sessionId: record.owner.sessionId });
  if (probe.state === "unknown") return { exitCode: 2, output: { ok: true, probe: "unknown", reason: probe.reason, findings } };
  return { exitCode: 0, output: { ok: true, probe: probe.state, sessionId: record.owner.sessionId, findings } };
}
export async function runAccept(request: CoordinatorRequest, options: RunOptions): Promise<CliOutcome> {
  const token = ownerTokenOf(options);
  const scopeDigest = computeScopeDigest(request);
  const worktree = await canonicalExisting(request.worktree, "worktree");
  const taskFile = await canonicalExisting(request.taskFile, "taskFile");
  const workerStateDir = await canonicalWorkerDir(request.workerStateDir);
  const stale = await requireTaskBytes(taskFile, request.taskSha256);
  if (stale !== null) return stale;
  if ((await headOf(worktree)) !== request.head) return { exitCode: 1, output: { ok: false, reason: "stale_head" } };
  const session = await wrapperSession(workerStateDir);
  if (session.role !== request.role || resolve(session.worktree) !== worktree || session.attempt !== request.expectedAttempt) {
    return { exitCode: 1, output: { ok: false, reason: "session_binding_mismatch" } };
  }
  const attempt = await attemptStatus(workerStateDir, request.expectedAttempt);
  if (session.taskSha256 !== request.taskSha256.toLowerCase() || attempt.taskSha256 !== request.taskSha256.toLowerCase()) return staleTask();
  if (attempt.attempt !== request.expectedAttempt || attempt.attempt !== session.attempt) {
    return { exitCode: 1, output: { ok: false, reason: "attempt_mismatch" } };
  }
  if (
    attempt.sessionId !== session.sessionId || attempt.role !== session.role ||
    resolve(attempt.worktree) !== worktree
  ) {
    return { exitCode: 1, output: { ok: false, reason: "session_binding_mismatch" } };
  }
  for (const receipt of [session, attempt] as const) {
    if (
      receipt.status !== "completed" || receipt.cliExitCode !== 0 ||
      receipt.errorCode !== null || receipt.errorMessage !== null ||
      receipt.finishedAt === null || !Number.isFinite(receipt.finishedAt)
    ) {
      return { exitCode: 2, output: { ok: false, reason: "not_completed", status: receipt.status } };
    }
  }
  const changed = await collectChangedPaths(worktree);
  if (request.role === "code-review" && changed.length > 0) {
    return { exitCode: 1, output: { ok: false, reason: "review_must_not_modify_code", changed } };
  }
  const outside = changed.filter((path) => !inScope(path, request.allowedPaths));
  if (request.role === "implementation" && outside.length > 0) {
    return { exitCode: 1, output: { ok: false, reason: "outside_scope", changed, outside } };
  }
  const diffStat = await git(worktree, ["diff", "HEAD", "--stat", "--"]);
  const diffDigest = await collectChangeDigest(worktree);
  const accepted = await acceptResult(storeFor(options.stateDir), {
    repositoryId: request.repositoryId, pullRequestNumber: request.pullRequestNumber, ownerToken: token,
    sessionId: session.sessionId, startHead: request.head, scopeDigest, liveHead: await headOf(worktree), liveChangeDigest: diffDigest,
  }, async (owner) => (await probePrWorkerSession(serviceConfig(options.serviceConfig), { expectedService: request.expectedService, sessionId: owner.sessionId })).state);
  if (!accepted.ok) return { exitCode: heldExit(accepted.reason), output: { ok: false, reason: accepted.reason } };
  return { exitCode: 0, output: { ok: true, verificationRequired: true, changed, diffStat, diffDigest, ...(request.startingWorktreeDigest === undefined ? {} : { startingWorktreeDigest: request.startingWorktreeDigest.toLowerCase() }), note: "Local execution result only; not a GitHub approval or authorization." } };
}
export async function runRelease(request: CoordinatorRequest, options: RunOptions): Promise<CliOutcome> {
  const token = ownerTokenOf(options);
  const store = storeFor(options.stateDir);
  const record = await readWork(store, { repositoryId: request.repositoryId, pullRequestNumber: request.pullRequestNumber });
  if (record?.owner !== null && record?.owner !== undefined && record.owner.scopeDigest !== computeScopeDigest(request)) {
    return { exitCode: 1, output: { ok: false, reason: "scope_mismatch" } };
  }
  // Undispatched predicate for the sessionless fast path, bound to THIS
  // reservation's attempt: the wrapper writes session.json with
  // attempt = previous.attempt + 1 (1 for a fresh dir) at the start of every
  // run. A receipt with attempt below this reservation's attempt and a
  // terminal status is the previous attempt's leftover, not a launch of this
  // reservation. Anything else present means this reservation may be live,
  // so probing-free release must not clear it; the operator path is `attach`
  // (then the normal stop/release flow).
  const undispatched = async (owner: { workerStateDir: string | null }): Promise<boolean> => {
    if (owner.workerStateDir === null) return true;
    let raw: string;
    try {
      raw = await readFile(join(owner.workerStateDir, "session.json"), "utf8");
    } catch (error) {
      // Only a confirmed absence allows release; any other read error fails closed.
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    let receipt: WrapperReceipt;
    try {
      receipt = parseWrapperReceipt(asRecord(JSON.parse(raw) as unknown), "wrapper session.json");
    } catch {
      return false;
    }
    return (
      receipt.attempt < request.expectedAttempt &&
      (receipt.status === "completed" || receipt.status === "blocked" || receipt.status === "timed_out" || receipt.status === "interrupted")
    );
  };
  const released = await releaseWork(store,
    { repositoryId: request.repositoryId, pullRequestNumber: request.pullRequestNumber, ownerToken: token },
    async (owner) => (await probePrWorkerSession(serviceConfig(options.serviceConfig), { expectedService: request.expectedService, sessionId: owner.sessionId })).state,
    undispatched);
  if (!released.ok) return { exitCode: heldExit(released.reason), output: { ok: false, reason: released.reason } };
  return { exitCode: 0, output: { ok: true, released: released.released } };
}
export async function runStop(request: CoordinatorRequest, options: RunOptions): Promise<CliOutcome> {
  const token = ownerTokenOf(options);
  const record = await readWork(storeFor(options.stateDir), { repositoryId: request.repositoryId, pullRequestNumber: request.pullRequestNumber });
  const sessionId = record?.owner?.sessionId ?? null;
  if (record?.owner === null || record?.owner === undefined || sessionId === null) {
    return { exitCode: 2, output: { ok: false, reason: "session_unknown", outcome: "unknown" } };
  }
  if (record.owner.scopeDigest !== computeScopeDigest(request)) return { exitCode: 1, output: { ok: false, reason: "scope_mismatch" } };
  if (record.owner.token !== token) return { exitCode: 1, output: { ok: false, reason: "token_mismatch" } };
  const stopped = await requestPrWorkerSessionStop(serviceConfig(options.serviceConfig), { expectedService: request.expectedService, sessionId });
  if (stopped.outcome !== "stopped") {
    return { exitCode: 2, output: { ok: false, reason: stopped.reason ?? "still_running", outcome: stopped.outcome } };
  }
  return { exitCode: 0, output: { ok: true, outcome: "stopped", awaiting_release: true } };
}
export async function runFinding(request: CoordinatorRequest, options: RunOptions): Promise<CliOutcome> {
  const token = ownerTokenOf(options);
  if (request.finding === undefined) fail("request.finding must carry key/status/evidence.");
  const bound = await readWork(storeFor(options.stateDir), { repositoryId: request.repositoryId, pullRequestNumber: request.pullRequestNumber });
  if (bound?.owner !== null && bound?.owner !== undefined) {
    if (bound.owner.scopeDigest !== computeScopeDigest(request)) return { exitCode: 1, output: { ok: false, reason: "scope_mismatch" } };
    if (bound.owner.token !== token) return { exitCode: 1, output: { ok: false, reason: "token_mismatch" } };
  }
  const recorded = await recordFinding(storeFor(options.stateDir), {
    repositoryId: request.repositoryId, pullRequestNumber: request.pullRequestNumber, ownerToken: token,
    key: request.finding.key, status: request.finding.status, evidence: request.finding.evidence, repairDirective: request.finding.repairDirective ?? null,
  });
  if (!recorded.ok) return { exitCode: heldExit(recorded.reason), output: { ok: false, reason: recorded.reason } };
  return { exitCode: 0, output: { ok: true, repeated: recorded.repeated, escalate: recorded.repeated } };
}
export function parseCliArgs(argv: string[]): { command: string; requestFile: string | null; stateDir: string | null; ownerToken: string | undefined } {
  const [command, ...rest] = argv;
  if (command === undefined) fail("usage: pr:work <command> --request FILE --state-dir ABS [--owner-token TOKEN]");
  let requestFile: string | null = null;
  let stateDir: string | null = null;
  let ownerToken: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--request") requestFile = rest[(index += 1)] ?? "";
    else if (flag === "--state-dir") stateDir = rest[(index += 1)] ?? "";
    else if (flag === "--owner-token") ownerToken = rest[(index += 1)] ?? "";
    else fail(`unknown flag ${flag ?? ""}.`);
  }
  return { command, requestFile, stateDir, ownerToken };
}
export async function runCli(argv: string[], serviceOverrides?: ServiceOverrides): Promise<CliOutcome> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    return { exitCode: 1, output: { ok: false, reason: "invalid_args", detail: (error as Error).message } };
  }
  if (parsed.command === "capture") {
    if (parsed.stateDir === null) return { exitCode: 1, output: { ok: false, reason: "invalid_args", detail: "capture needs --state-dir." } };
    return runCapture(serviceOverrides);
  }
  try {
    if (parsed.requestFile === null || parsed.requestFile.length === 0) fail("missing --request FILE.");
    if (parsed.stateDir === null || parsed.stateDir.length === 0) fail("missing --state-dir ABS.");
    const request = parseCoordinatorRequest(JSON.parse(await readFile(parsed.requestFile, "utf8")) as unknown);
    const options: RunOptions = { stateDir: parsed.stateDir };
    if (parsed.ownerToken !== undefined) options.ownerToken = parsed.ownerToken;
    if (serviceOverrides !== undefined) options.serviceConfig = serviceOverrides;
    switch (parsed.command) {
      case "reserve": return await runReserve(request, options);
      case "attach": return await runAttach(request, options);
      case "status": return await runStatus(request, options);
      case "accept": return await runAccept(request, options);
      case "release": return await runRelease(request, options);
      case "stop": return await runStop(request, options);
      case "finding": return await runFinding(request, options);
      default: fail(`unknown command ${parsed.command}.`);
    }
  } catch (error) {
    return { exitCode: 1, output: { ok: false, reason: "invalid", detail: (error as Error).message } };
  }
}
const invokedAsCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsCli) {
  runCli(process.argv.slice(2)).then((result) => {
    console.log(JSON.stringify(result.output));
    process.exitCode = result.exitCode;
  }).catch((error: unknown) => {
    console.log(JSON.stringify({ ok: false, reason: "invalid", detail: (error as Error).message }));
    process.exitCode = 1;
  });
}
