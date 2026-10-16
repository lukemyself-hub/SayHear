import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectChangedPaths,
  collectChangeDigest,
  parseCoordinatorRequest,
  runAccept,
  runAttach,
  runCapture,
  runCli,
  runFinding,
  runRelease,
  runReserve,
  runStatus,
  runStop,
  type CoordinatorRequest,
  type ServiceOverrides,
} from "../scripts/pr-worker-coordinator.ts";
import type { PrWorkerServiceFetch, PrWorkerServiceFetchInit, PrWorkerServiceIdentity } from "../scripts/pr-worker-service.ts";

const runExec = promisify(execFile);
const SERVICE: PrWorkerServiceIdentity = { pid: 42421, version: "9.9.9-test" };
const SESSION = "ses_impl_1";
const PASSWORD = "fixture-secret-not-a-credential";
const REPO = 998877;
let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

type Reply = { status?: number; body?: unknown; fail?: Error };
function fakeFetch(routes: Array<{ method: string; path: string; replies: Reply[] }>): { calls: unknown[]; fetchImpl: PrWorkerServiceFetch } {
  const calls: unknown[] = [];
  const used = new Map<string, number>();
  const fetchImpl: PrWorkerServiceFetch = (url, init: PrWorkerServiceFetchInit) => {
    const key = `${init.method} ${new URL(url).pathname}`;
    const route = routes.find((c) => `${c.method} ${c.path}` === key);
    if (!route) return Promise.reject(new Error(`unexpected ${key}`));
    calls.push(key);
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    const reply = route.replies[Math.min(n, route.replies.length - 1)] ?? {};
    if (reply.fail) return Promise.reject(reply.fail);
    return Promise.resolve(new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 }));
  };
  return { calls, fetchImpl };
}
function infoRoutes(active: unknown, identities: PrWorkerServiceIdentity[] = [SERVICE], interrupt = true, session = SESSION): Array<{ method: string; path: string; replies: Reply[] }> {
  const json = (body: unknown): Reply => ({ body });
  const routes: Array<{ method: string; path: string; replies: Reply[] }> = [
    { method: "GET", path: "/api/info", replies: identities.map(json) },
    { method: "GET", path: "/api/session/active", replies: [json(active)] },
    { method: "GET", path: "/api/info", replies: identities.map(json) },
  ];
  if (interrupt) routes.push({ method: "POST", path: `/api/session/${session}/interrupt`, replies: [json({})] });
  return routes;
}
async function setupEnv(opts: { role?: "implementation" | "code-review"; pr?: number; attempt?: number } = {}) {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "prcoord-"));
  roots.push(root);
  const wt = join(root, "wt");
  const wrapper = join(root, "wrapper");
  const stateDir = join(root, "ownership");
  const cred = join(root, "pw");
  await runExec("git", ["init", wt]);
  await runExec("git", ["-C", wt, "config", "user.email", "t@t.t"]);
  await runExec("git", ["-C", wt, "config", "user.name", "t"]);
  await writeFile(join(wt, "base.txt"), "base\n");
  await runExec("git", ["-C", wt, "add", "."]);
  await runExec("git", ["-C", wt, "commit", "-m", "base"]);
  const { stdout } = await runExec("git", ["-C", wt, "rev-parse", "HEAD"]);
  const head = stdout.trim();
  const taskFile = join(root, "task.md");
  await writeFile(taskFile, "# task\n");
  const taskSha256 = createHash("sha256").update(await readFile(taskFile)).digest("hex");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(wrapper, { recursive: true });
  await writeFile(cred, `${PASSWORD}\n`, { mode: 0o600 });
  const pr = opts.pr ?? 41;
  const attempt = opts.attempt ?? 1;
  const request: CoordinatorRequest = {
    repositoryId: REPO, pullRequestNumber: pr, head, changeDigest: "e".repeat(64),
    ledger: { roundsConsumed: 0, paused: false, historyConsistent: true },
    role: opts.role ?? "implementation", worktree: wt, allowedPaths: ["src", "docs/note.md"],
    taskFile, taskSha256, workerStateDir: wrapper, expectedAttempt: attempt, expectedService: { ...SERVICE },
  };
  return { root, wt, wrapper, stateDir, cred, head, taskFile, taskSha256, request };
}
function svc(cred: string, fetchImpl: PrWorkerServiceFetch): ServiceOverrides {
  return { baseUrl: "http://127.0.0.1:4096", credentialFile: cred, timeoutMs: 500, fetch: fetchImpl };
}
async function writeWrapper(
  wrapper: string, wt: string, role: string, attempt: number, status: string,
  errorCode: string | null = null, sessionId: string = SESSION, taskSha256 = "a".repeat(64),
) {
  const finished = status === "running" ? {} : { cli_exit_code: status === "completed" && errorCode === null ? 0 : 1, finished_at: 1792163008.94 };
  const errors = errorCode === null ? {} : { error_code: errorCode, error: "blocked: tool error" };
  const receipt = {
    session_id: sessionId, agent: role, directory: wt, model: "magpie/group/group#high",
    attempt, status, service_version: "2.0.30", task_sha256: taskSha256, ...finished, ...errors,
  };
  await writeFile(join(wrapper, "session.json"), JSON.stringify(receipt));
  await writeFile(join(wrapper, `attempt-${String(attempt).padStart(3, "0")}-status.json`), JSON.stringify(receipt));
}
async function writeReceipts(wrapper: string, session: Record<string, unknown>, attempt: Record<string, unknown>, attemptNo: number) {
  await writeFile(join(wrapper, "session.json"), JSON.stringify(session));
  await writeFile(join(wrapper, `attempt-${String(attemptNo).padStart(3, "0")}-status.json`), JSON.stringify(attempt));
}
function realReceipt(taskSha256: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION, agent: "implementation", directory: "/tmp/wt", model: "magpie/group/group#high",
    attempt: 1, status: "completed", service_version: "2.0.30", task_sha256: taskSha256,
    cli_exit_code: 0, finished_at: 1792163008.94, ...overrides,
  };
}
async function writeRequestFile(root: string, request: CoordinatorRequest): Promise<string> {
  const path = join(root, "request.json");
  await writeFile(path, JSON.stringify(request));
  return path;
}

describe("happy path over the real ownership record", () => {
  it("reserve -> attach -> patch -> stopped accept -> release", async () => {
    const env = await setupEnv();
    const stoppedFetch = fakeFetch(infoRoutes({ data: {} }));
    const runningFetch = fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } }));
    // Capture identity before dispatch (no request needed).
    const cap = await runCapture(svc(env.cred, fakeFetch([
      { method: "GET", path: "/api/info", replies: [{ body: SERVICE }, { body: SERVICE }] },
    ]).fetchImpl));
    expect(cap.exitCode).toBe(0);
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    expect(reserved.exitCode).toBe(0);
    const token = reserved.output.ownerToken as string;
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    const attached = await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: svc(env.cred, runningFetch.fetchImpl) });
    expect(attached.exitCode).toBe(0);
    // Duplicate reserve is denied while the writer is held.
    const dup = await runReserve(env.request, { stateDir: env.stateDir });
    expect(dup.exitCode).toBe(2);
    expect(dup.output.reason).toBe("occupied");
    // Real worker patch inside scope, then a stopped per-attempt status.
    await writeFile(join(env.wt, "src"), "x\n").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(env.wt, "src"), { recursive: true });
      await writeFile(join(env.wt, "src", "a.ts"), "x\n");
    });
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "completed", null, SESSION, env.taskSha256);
    const accepted = await runAccept(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: svc(env.cred, stoppedFetch.fetchImpl) });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.output.verificationRequired).toBe(true);
    expect(String(accepted.output.note ?? "")).toMatch(/not a GitHub approval/i);
    const released = await runRelease(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: svc(env.cred, stoppedFetch.fetchImpl) });
    expect(released.exitCode).toBe(0);
    expect(released.output.released).toBe(true);
  });
});

describe("fail-closed bindings", () => {
  it("rejects a dirty tree and a stale head at reserve", async () => {
    const env = await setupEnv();
    await writeFile(join(env.wt, "dirty.txt"), "dirty\n");
    const dirty = await runReserve(env.request, { stateDir: env.stateDir });
    expect(dirty.output.reason).toBe("worktree_not_clean");
    await rm(join(env.wt, "dirty.txt"));
    const stale = await runReserve({ ...env.request, head: "b".repeat(40) }, { stateDir: env.stateDir });
    expect(stale.output.reason).toBe("stale_head");
  });
  it("fails closed when the request changes after reserve", async () => {
    const env = await setupEnv();
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    const changed = { ...env.request, allowedPaths: ["other"] };
    const attached = await runAttach(changed, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running });
    expect(attached.output.reason).toBe("scope_mismatch");
  });
  it("rejects an expected-attempt mismatch so old results cannot be reused", async () => {
    const env = await setupEnv();
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    await writeWrapper(env.wrapper, env.wt, "implementation", 2, "completed", null, SESSION, env.taskSha256);
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    const attached = await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running });
    expect(attached.output.reason).toBe("attempt_mismatch");
  });
  it("rejects blocked wrapper output even with optimistic result text", async () => {
    const env = await setupEnv();
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    const stopped = svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    expect((await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running })).exitCode).toBe(0);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(env.wt, "src"), { recursive: true });
    await writeFile(join(env.wt, "src", "a.ts"), "x\n");
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "blocked", "BLOCKED_TOOL_ERROR", SESSION, env.taskSha256);
    await writeFile(join(env.wrapper, "result.txt"), "done: completed successfully\n");
    const accepted = await runAccept(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stopped });
    expect(accepted.exitCode).toBe(2);
    expect(accepted.output.reason).toBe("not_completed");
  });
  it("rejects outside-scope and untracked edits; review must not modify code", async () => {
    const env = await setupEnv();
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    const stopped = svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running });
    await writeFile(join(env.wt, "outside.txt"), "nope\n");
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "completed", null, SESSION, env.taskSha256);
    const denied = await runAccept(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stopped });
    expect(denied.output.reason).toBe("outside_scope");
    await rm(join(env.wt, "outside.txt"));
    const reviewEnv = await setupEnv({ role: "code-review", pr: 42 });
    const rReserved = await runReserve(reviewEnv.request, { stateDir: reviewEnv.stateDir });
    const rToken = rReserved.output.ownerToken as string;
    const rStopped = svc(reviewEnv.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
    const rRunning = svc(reviewEnv.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    await writeWrapper(reviewEnv.wrapper, reviewEnv.wt, "code-review", 1, "running", null, SESSION, reviewEnv.taskSha256);
    await runAttach(reviewEnv.request, { stateDir: reviewEnv.stateDir, ownerToken: rToken, serviceConfig: rRunning });
    await writeFile(join(reviewEnv.wt, "review-edit.txt"), "edit\n");
    await writeWrapper(reviewEnv.wrapper, reviewEnv.wt, "code-review", 1, "completed", null, SESSION, reviewEnv.taskSha256);
    const reviewDenied = await runAccept(reviewEnv.request, { stateDir: reviewEnv.stateDir, ownerToken: rToken, serviceConfig: rStopped });
    expect(reviewDenied.output.reason).toBe("review_must_not_modify_code");
  });
  it("refuses paused / exhausted / inconsistent ledgers", async () => {
    for (const ledger of [
      { roundsConsumed: 0, paused: true, historyConsistent: true },
      { roundsConsumed: 3, paused: false, historyConsistent: true },
      { roundsConsumed: 0, paused: false, historyConsistent: false },
    ]) {
      const env = await setupEnv({ pr: 50 + ledger.roundsConsumed + (ledger.paused ? 10 : 0) + (ledger.historyConsistent ? 0 : 20) });
      const out = await runReserve({ ...env.request, ledger }, { stateDir: env.stateDir });
      expect(out.exitCode).toBe(2);
    }
  });
});

describe("liveness-gated release/stop", () => {
  it("unknown probe blocks release and never clears on local absence; null session stays unknown", async () => {
    const env = await setupEnv();
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    const statusOut = await runStatus(env.request, {
      stateDir: env.stateDir,
      serviceConfig: svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl),
    });
    expect(statusOut.exitCode).toBe(2);
    expect(statusOut.output.reason).toBe("session_unknown");
    const failing = svc(env.cred, ((_url: string, _init: PrWorkerServiceFetchInit) => Promise.reject(new Error("down"))) as PrWorkerServiceFetch);
    const denied = await runRelease(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: failing });
    expect(denied.exitCode).toBe(2);
    expect(denied.output.reason).toBe("worker_unknown");
  });
  it("stop ACK with a still-running session leaves ownership; confirmed stop preserves code for explicit release", async () => {
    const env = await setupEnv();
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(env.wt, "src"), { recursive: true });
    await writeFile(join(env.wt, "src", "keep.ts"), "keep\n");
    // ACK path: interrupt succeeds but the follow-up probe still sees running.
    const ackRoutes: Array<{ method: string; path: string; replies: Reply[] }> = [
      { method: "GET", path: "/api/info", replies: [{ body: SERVICE }, { body: SERVICE }, { body: SERVICE }, { body: SERVICE }] },
      { method: "GET", path: "/api/session/active", replies: [{ body: { data: { [SESSION]: { type: "running" } } } }, { body: { data: { [SESSION]: { type: "running" } } } }] },
      { method: "POST", path: `/api/session/${SESSION}/interrupt`, replies: [{ body: {} }] },
    ];
    const acked = await runStop(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: svc(env.cred, fakeFetch(ackRoutes).fetchImpl) });
    expect(acked.exitCode).toBe(2);
    expect(acked.output.outcome).toBe("running");
    const stillHeld = await runReserve(env.request, { stateDir: env.stateDir });
    expect(stillHeld.output.reason).toBe("occupied");
    const stopDone = await runStop(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl) });
    expect(stopDone.exitCode).toBe(0);
    const released = await runRelease(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl) });
    expect(released.output.released).toBe(true);
    expect(await readFile(join(env.wt, "src", "keep.ts"), "utf8")).toBe("keep\n");
  });
});

describe("resume, review freshness, and findings", () => {
  it("implementation may resume its session; review sessions stay fresh", async () => {
    const env = await setupEnv();
    const stopped = svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    const first = await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running });
    expect(first.output.resumed).toBe(false);
    const resume = await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running });
    expect(resume.output.resumed).toBe(true);
    await runRelease(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stopped });
    // Fresh review reservation on the same record gets a fresh session.
    const reviewReq: CoordinatorRequest = { ...env.request, role: "code-review", allowedPaths: [] };
    const rReserved = await runReserve(reviewReq, { stateDir: env.stateDir });
    expect(rReserved.exitCode).toBe(0);
    const rToken = rReserved.output.ownerToken as string;
    const REVIEW = "ses_review_1";
    const rRunning = svc(env.cred, fakeFetch(infoRoutes({ data: { [REVIEW]: { type: "running" } } }, [SERVICE], true, REVIEW)).fetchImpl);
    await writeWrapper(env.wrapper, env.wt, "code-review", 1, "running", null, REVIEW, env.taskSha256);
    const rAttach = await runAttach(reviewReq, { stateDir: env.stateDir, ownerToken: rToken, serviceConfig: rRunning });
    expect(rAttach.exitCode).toBe(0);
  });
  it("records findings and escalates only on confirmed repeats", async () => {
    const env = await setupEnv();
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    const base = { ...env.request, finding: { key: "k1", status: "confirmed" as const, evidence: "ev" } };
    const first = await runFinding(base, { stateDir: env.stateDir, ownerToken: token });
    expect(first.output.repeated).toBe(false);
    // Accept arms fixedAccepted; a confirmed reappearance then reports repeated.
    const stopped = svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(env.wt, "src"), { recursive: true });
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running });
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "completed", null, SESSION, env.taskSha256);
    expect((await runAccept(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stopped })).exitCode).toBe(0);
    const repeat = await runFinding(base, { stateDir: env.stateDir, ownerToken: token });
    expect(repeat.output).toMatchObject({ repeated: true, escalate: true });
    const disputed = await runFinding(
      { ...env.request, finding: { key: "k1", status: "disputed", evidence: "ev2" } },
      { stateDir: env.stateDir, ownerToken: token },
    );
    expect(disputed.output.repeated).toBe(false);
  });
});

describe("real wrapper receipt bindings", () => {
  it("rejects a stale running current receipt even when the per-attempt receipt completed", async () => {
    const env = await setupEnv();
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    const stopped = svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    const current = realReceipt(env.taskSha256, { agent: "implementation", directory: env.wt, status: "running" });
    delete current.cli_exit_code;
    delete current.finished_at;
    const perAttempt = realReceipt(env.taskSha256, { agent: "implementation", directory: env.wt, status: "completed" });
    await writeReceipts(env.wrapper, current, perAttempt, 1);
    expect((await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running })).exitCode).toBe(0);
    const accepted = await runAccept(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stopped });
    expect(accepted.exitCode).toBe(2);
    expect(accepted.output.reason).toBe("not_completed");
  });
  it("rejects per-attempt session/role/attempt disagreement", async () => {
    for (const [label, mutate] of [
      ["session", (r: Record<string, unknown>) => ({ ...r, session_id: "ses_other" })],
      ["role", (r: Record<string, unknown>) => ({ ...r, agent: "code-review" })],
      ["directory", (r: Record<string, unknown>) => ({ ...r, directory: "/tmp/other-wt" })],
    ] as const) {
      const env = await setupEnv({ pr: 60 + label.length });
      const reserved = await runReserve(env.request, { stateDir: env.stateDir });
      const token = reserved.output.ownerToken as string;
      const stopped = svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
      const session = realReceipt(env.taskSha256, { agent: "implementation", directory: env.wt });
      await writeReceipts(env.wrapper, session, mutate(realReceipt(env.taskSha256, { agent: "implementation", directory: env.wt })), 1);
      const out = await runAccept(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stopped });
      expect(out.output.reason, label).toBe("session_binding_mismatch");
    }
    const env = await setupEnv({ pr: 77 });
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    const stopped = svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
    await writeReceipts(env.wrapper, realReceipt(env.taskSha256, { agent: "implementation", directory: env.wt }), realReceipt(env.taskSha256, { agent: "implementation", directory: env.wt, attempt: 2 }), 1);
    const out = await runAccept(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stopped });
    expect(out.output.reason).toBe("attempt_mismatch");
  });
});

describe("CLI JSON and exit codes", () => {
  it("capture returns identity; invalid args exit 1; held work exits 2", async () => {
    const env = await setupEnv();
    const fetchImpl = fakeFetch([
      { method: "GET", path: "/api/info", replies: [{ body: SERVICE }, { body: SERVICE }] },
    ]).fetchImpl;
    const cap = await runCli(["capture", "--state-dir", env.stateDir], svc(env.cred, fetchImpl));
    expect(cap.exitCode).toBe(0);
    expect(cap.output.ok).toBe(true);
    const bad = await runCli(["reserve", "--state-dir", env.stateDir]);
    expect(bad.exitCode).toBe(1);
    const reqFile = await writeRequestFile(env.root, env.request);
    const first = await runCli(["reserve", "--request", reqFile, "--state-dir", env.stateDir]);
    expect(first.exitCode).toBe(0);
    const second = await runCli(["reserve", "--request", reqFile, "--state-dir", resolve(env.stateDir)]);
    expect(second.exitCode).toBe(2);
    expect(JSON.parse(JSON.stringify(second.output)).reason).toBe("occupied");
  });
});

describe("immutable request and task binding", () => {
  it("binds every immutable request field: post-reserve edits fail the scope binding", async () => {
    const variants: Array<[string, Partial<CoordinatorRequest>]> = [
      ["head", { head: "c".repeat(40) }],
      ["changeDigest", { changeDigest: "d".repeat(64) }],
      ["ledger", { ledger: { roundsConsumed: 1, paused: false, historyConsistent: true } }],
      ["taskSha256", { taskSha256: "f".repeat(64) }],
      ["role", { role: "code-review", allowedPaths: [] }],
      ["expectedAttempt", { expectedAttempt: 2 }],
      ["expectedService", { expectedService: { pid: 999, version: "other" } }],
      ["worktree", { worktree: "/tmp" }],
      ["taskFile", { taskFile: "/tmp/other-task.md" }],
      ["workerStateDir", { workerStateDir: "/tmp" }],
      ["repositoryId", { repositoryId: 1 }],
      ["pullRequest", { pullRequestNumber: 999 }],
      ["allowedPaths", { allowedPaths: ["other"] }],
    ];
    for (const [label, override] of variants) {
      const env = await setupEnv({ pr: 300 + label.length });
      const reserved = await runReserve(env.request, { stateDir: env.stateDir });
      expect(reserved.exitCode, label).toBe(0);
      const token = reserved.output.ownerToken as string;
      await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
      const changed: CoordinatorRequest = { ...env.request, ...override };
      // A non-canonical or absent path is refused structurally (throws), a
      // changed field is refused by the binding check; both must fail closed.
      let attach: { exitCode: number; output: Record<string, unknown> };
      try {
        attach = await runAttach(changed, {
          stateDir: env.stateDir, ownerToken: token,
          serviceConfig: svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl),
        });
      } catch (error) {
        attach = { exitCode: 1, output: { reason: "invalid", detail: (error as Error).message } };
      }
      const expectedReason: Record<string, string> = {
        head: "head_mismatch", changeDigest: "scope_mismatch", ledger: "scope_mismatch",
        taskSha256: "stale_task", allowedPaths: "scope_mismatch",
      };
      if (expectedReason[label] !== undefined) expect(attach.output.reason, label).toBe(expectedReason[label]);
      else expect(attach.exitCode, label).not.toBe(0);
      const finding = await runFinding(
        { ...changed, finding: { key: "k", status: "confirmed", evidence: "ev" } },
        { stateDir: env.stateDir, ownerToken: token },
      );
      expect(finding.exitCode, label).toBe(1);
      const stillHeld = await runReserve(env.request, { stateDir: env.stateDir });
      expect(stillHeld.output.reason, label).toBe("occupied");
    }
  });
  it("rejects replaced task bytes at reserve, attach, and accept", async () => {
    const env = await setupEnv({ pr: 400 });
    await writeFile(env.taskFile, "# tampered\n");
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    expect(reserved.output.reason).toBe("stale_task");
    await writeFile(env.taskFile, "# task\n");
    const ok = await runReserve(env.request, { stateDir: env.stateDir });
    expect(ok.exitCode).toBe(0);
    const token = ok.output.ownerToken as string;
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    const stopped = svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    await writeFile(env.taskFile, "# tampered\n");
    expect((await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running })).output.reason).toBe("stale_task");
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "completed", null, SESSION, env.taskSha256);
    expect((await runAccept(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stopped })).output.reason).toBe("stale_task");
  });
  it("requires both wrapper receipts to carry the reserved task hash", async () => {
    const env = await setupEnv({ pr: 401 });
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    const stopped = svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    expect((await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running })).exitCode).toBe(0);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(env.wt, "src"), { recursive: true });
    await writeFile(join(env.wt, "src", "a.ts"), "x\n");
    await writeReceipts(
      env.wrapper,
      realReceipt(env.taskSha256, { agent: "implementation", directory: env.wt }),
      realReceipt("9".repeat(64), { agent: "implementation", directory: env.wt }),
      1,
    );
    const denied = await runAccept(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stopped });
    expect(denied.output.reason).toBe("stale_task");
  });
  it("refuses stop for a foreign token without requesting an interrupt", async () => {
    const env = await setupEnv({ pr: 402 });
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running });
    const watcher = fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } }));
    const denied = await runStop(env.request, { stateDir: env.stateDir, ownerToken: "0".repeat(32), serviceConfig: svc(env.cred, watcher.fetchImpl) });
    expect(denied.output.reason).toBe("token_mismatch");
    expect(watcher.calls.some((call) => String(call).includes("interrupt"))).toBe(false);
    const held = await runReserve(env.request, { stateDir: env.stateDir });
    expect(held.output.reason).toBe("occupied");
  });
  it("refuses attach on any unknown probe and keeps the reservation bound", async () => {
    const env = await setupEnv({ pr: 403 });
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    const failing = svc(env.cred, ((_url: string, _init: PrWorkerServiceFetchInit) => Promise.reject(new Error("down"))) as PrWorkerServiceFetch);
    const denied = await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: failing });
    expect(denied.exitCode).toBe(2);
    expect(denied.output.reason).toBe("transport_failed");
    const status = await runStatus(env.request, { stateDir: env.stateDir, serviceConfig: svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl) });
    expect(status.output.reason).toBe("session_unknown");
    const held = await runReserve(env.request, { stateDir: env.stateDir });
    expect(held.output.reason).toBe("occupied");
  });
  it("keeps stopped probes allowed so a completed worker still attaches and accepts", async () => {
    const env = await setupEnv({ pr: 404 });
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    const stopped = svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "completed", null, SESSION, env.taskSha256);
    const attached = await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stopped });
    expect(attached.exitCode).toBe(0);
    expect(attached.output.probe).toBe("stopped");
  });
});

describe("diff-collector edges", () => {
  it("round-trips newline and quoted filenames as exact paths", async () => {
    const env = await setupEnv({ pr: 501 });
    await mkdir(join(env.wt, "src"), { recursive: true });
    const quoted = 'src/a"b c.txt';
    const withNewline = "src/line\nbreak.txt";
    await writeFile(join(env.wt, quoted), "quoted\n");
    await writeFile(join(env.wt, withNewline), "newline\n");
    const changed = await collectChangedPaths(env.wt);
    expect(changed).toContain(quoted);
    expect(changed).toContain(withNewline);
    const digest = await collectChangeDigest(env.wt);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a staged rename when the source is outside allowedPaths", async () => {
    const env = await setupEnv({ pr: 502 });
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    expect(reserved.exitCode).toBe(0);
    const token = reserved.output.ownerToken as string;
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    const stopped = svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    expect((await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running })).exitCode).toBe(0);
    await mkdir(join(env.wt, "src"), { recursive: true });
    await runExec("git", ["-C", env.wt, "mv", "base.txt", "src/moved.txt"]);
    const changed = await collectChangedPaths(env.wt);
    expect(changed).toContain("base.txt");
    expect(changed).toContain("src/moved.txt");
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "completed", null, SESSION, env.taskSha256);
    const denied = await runAccept(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stopped });
    expect(denied.output.reason).toBe("outside_scope");
    expect(denied.output.outside as string[]).toContain("base.txt");
  });

  it("accepts nested untracked files inside allowed scope", async () => {
    const env = await setupEnv({ pr: 503 });
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    expect(reserved.exitCode).toBe(0);
    const token = reserved.output.ownerToken as string;
    const running = svc(env.cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);
    const stopped = svc(env.cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    expect((await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: running })).exitCode).toBe(0);
    await mkdir(join(env.wt, "src", "nested", "deep"), { recursive: true });
    await writeFile(join(env.wt, "src", "nested", "deep", "a.ts"), "nested\n");
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "completed", null, SESSION, env.taskSha256);
    const accepted = await runAccept(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stopped });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.output.changed as string[]).toContain("src/nested/deep/a.ts");
    expect(accepted.output.diffDigest).toBe(await collectChangeDigest(env.wt));
  });

  it("updates the digest for untracked-only content changes", async () => {
    const env = await setupEnv({ pr: 504 });
    const clean = await collectChangeDigest(env.wt);
    await mkdir(join(env.wt, "src"), { recursive: true });
    await writeFile(join(env.wt, "src", "only.txt"), "one\n");
    const first = await collectChangeDigest(env.wt);
    expect(first).not.toBe(clean);
    await writeFile(join(env.wt, "src", "only.txt"), "two\n");
    const second = await collectChangeDigest(env.wt);
    expect(second).not.toBe(first);
    expect(second).not.toBe(clean);
  });

  it("reflects binary tracked changes in the digest", async () => {
    const env = await setupEnv({ pr: 505 });
    const clean = await collectChangeDigest(env.wt);
    await writeFile(join(env.wt, "base.txt"), Buffer.from([0, 1, 2, 255, 254, 0, 65, 66, 67]));
    const changed = await collectChangedPaths(env.wt);
    expect(changed).toContain("base.txt");
    const dirty = await collectChangeDigest(env.wt);
    expect(dirty).not.toBe(clean);
    expect(dirty).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records symlink target text without reading the external file", async () => {
    const env = await setupEnv({ pr: 506 });
    await mkdir(join(env.wt, "src"), { recursive: true });
    const external = join(env.root, "external-secret.txt");
    await writeFile(external, "secret-one\n");
    const link = join(env.wt, "src", "link");
    await symlink(external, link);
    const changed = await collectChangedPaths(env.wt);
    expect(changed).toContain("src/link");
    const first = await collectChangeDigest(env.wt);
    await writeFile(external, "secret-two-different-bytes\n");
    const second = await collectChangeDigest(env.wt);
    expect(second).toBe(first);
    await rm(link);
    await symlink(join(env.root, "other-target.txt"), link);
    const third = await collectChangeDigest(env.wt);
    expect(third).not.toBe(first);
  });
});

describe("dirty-resume recovery contract", () => {
  const stoppedSvc = (cred: string): ServiceOverrides => svc(cred, fakeFetch(infoRoutes({ data: {} })).fetchImpl);
  const runningSvc = (cred: string): ServiceOverrides => svc(cred, fakeFetch(infoRoutes({ data: { [SESSION]: { type: "running" } } })).fetchImpl);

  /** Full attempt-1 lifecycle: reserve -> attach -> partial edit -> terminal -> stop -> release. */
  async function attemptOnce(env: Awaited<ReturnType<typeof setupEnv>>, terminal = "blocked", errorCode: string | null = "BLOCKED_TOOL_ERROR") {
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    expect(reserved.exitCode).toBe(0);
    const token = reserved.output.ownerToken as string;
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    expect((await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: runningSvc(env.cred) })).exitCode).toBe(0);
    await mkdir(join(env.wt, "src"), { recursive: true });
    await writeFile(join(env.wt, "src", "partial.ts"), "partial work\n");
    const baseline = await collectChangeDigest(env.wt);
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, terminal, errorCode, SESSION, env.taskSha256);
    expect((await runStop(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stoppedSvc(env.cred) })).exitCode).toBe(0);
    expect((await runRelease(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stoppedSvc(env.cred) })).output.released).toBe(true);
    return { token, baseline };
  }
  const resumable = (
    env: Awaited<ReturnType<typeof setupEnv>>,
    baseline: string,
    over: Partial<CoordinatorRequest> = {},
  ): CoordinatorRequest => ({
    ...env.request, expectedAttempt: 2, resumeSessionId: SESSION, startingWorktreeDigest: baseline, ...over,
  });
  const partial = (wt: string): string => join(wt, "src", "partial.ts");

  it("resumes preserved partial work with a new token and echoes the baseline at accept", async () => {
    const env = await setupEnv({ pr: 700 });
    const { token: token1, baseline } = await attemptOnce(env);
    const resumeReq = resumable(env, baseline);
    const reserved = await runReserve(resumeReq, { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(reserved.exitCode).toBe(0);
    const token2 = reserved.output.ownerToken as string;
    // A brand-new null-session reservation/token, never the released one.
    expect(token2).toMatch(/^[0-9a-f]{32}$/);
    expect(token2).not.toBe(token1);
    await writeWrapper(env.wrapper, env.wt, "implementation", 2, "running", null, SESSION, env.taskSha256);
    const attached = await runAttach(resumeReq, { stateDir: env.stateDir, ownerToken: token2, serviceConfig: runningSvc(env.cred) });
    expect(attached.exitCode).toBe(0);
    expect(attached.output.sessionId).toBe(SESSION);
    await writeWrapper(env.wrapper, env.wt, "implementation", 2, "completed", null, SESSION, env.taskSha256);
    const accepted = await runAccept(resumeReq, { stateDir: env.stateDir, ownerToken: token2, serviceConfig: stoppedSvc(env.cred) });
    expect(accepted.exitCode).toBe(0);
    // Baseline is visible in the accept output; the diff covers the real tree.
    expect(accepted.output.startingWorktreeDigest).toBe(baseline);
    expect(accepted.output.changed as string[]).toContain("src/partial.ts");
    expect(accepted.output.diffDigest).toBe(await collectChangeDigest(env.wt));
    expect(await readFile(partial(env.wt), "utf8")).toBe("partial work\n");
  });

  it("refuses a resume request while the old owner is still held; files preserved", async () => {
    const env = await setupEnv({ pr: 701 });
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    const token = reserved.output.ownerToken as string;
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "running", null, SESSION, env.taskSha256);
    await runAttach(env.request, { stateDir: env.stateDir, ownerToken: token, serviceConfig: runningSvc(env.cred) });
    await mkdir(join(env.wt, "src"), { recursive: true });
    await writeFile(partial(env.wt), "partial work\n");
    const baseline = await collectChangeDigest(env.wt);
    const dup = await runReserve(resumable(env, baseline), { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(dup.exitCode).toBe(2);
    expect(dup.output.reason).toBe("occupied");
    expect(await readFile(partial(env.wt), "utf8")).toBe("partial work\n");
  });

  it("keeps a null-session crash gap occupied; no recovery bypass and files preserved", async () => {
    const env = await setupEnv({ pr: 702 });
    const reserved = await runReserve(env.request, { stateDir: env.stateDir });
    expect(reserved.exitCode).toBe(0);
    // Worker crashed after writing partial work but before attaching a session.
    await mkdir(join(env.wt, "src"), { recursive: true });
    await writeFile(partial(env.wt), "partial work\n");
    const baseline = await collectChangeDigest(env.wt);
    const status = await runStatus(env.request, { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(status.output.reason).toBe("session_unknown");
    const out = await runReserve(resumable(env, baseline), { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(out.exitCode).toBe(2);
    expect(out.output.reason).toBe("occupied");
    expect(await readFile(partial(env.wt), "utf8")).toBe("partial work\n");
  });

  it("still requires a clean tree for a fresh attempt without recovery fields", async () => {
    const env = await setupEnv({ pr: 703 });
    await attemptOnce(env);
    const fresh = await runReserve({ ...env.request, expectedAttempt: 2 }, { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(fresh.exitCode).toBe(1);
    expect(fresh.output.reason).toBe("worktree_not_clean");
    expect(await readFile(partial(env.wt), "utf8")).toBe("partial work\n");
  });

  it("refuses a changed baseline digest and preserves the tree", async () => {
    const env = await setupEnv({ pr: 704 });
    const { baseline } = await attemptOnce(env);
    await writeFile(join(env.wt, "src", "extra.ts"), "more\n");
    const out = await runReserve(resumable(env, baseline), { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(out.exitCode).toBe(1);
    expect(out.output.reason).toBe("resume_baseline_mismatch");
    expect(await readFile(partial(env.wt), "utf8")).toBe("partial work\n");
    expect(await readFile(join(env.wt, "src", "extra.ts"), "utf8")).toBe("more\n");
  });

  it("refuses an unknown prior session and a mismatched prior receipt", async () => {
    const unknown = await setupEnv({ pr: 705 });
    const { baseline: uBaseline } = await attemptOnce(unknown);
    const notSeen = resumable(unknown, uBaseline, { resumeSessionId: "ses_never_seen" });
    const unknownOut = await runReserve(notSeen, { stateDir: unknown.stateDir, serviceConfig: stoppedSvc(unknown.cred) });
    expect(unknownOut.exitCode).toBe(1);
    expect(unknownOut.output.reason).toBe("resume_unknown_session");

    const env = await setupEnv({ pr: 706 });
    const { baseline } = await attemptOnce(env);
    // The seen session id is requested, but the real current receipt says otherwise.
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "blocked", "BLOCKED_TOOL_ERROR", "ses_other", env.taskSha256);
    const out = await runReserve(resumable(env, baseline), { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(out.exitCode).toBe(1);
    expect(out.output.reason).toBe("resume_receipt_mismatch");
    expect(await readFile(partial(env.wt), "utf8")).toBe("partial work\n");
  });

  it("refuses when the prior receipt attempt is not expectedAttempt-1; files preserved", async () => {
    const env = await setupEnv({ pr: 707 });
    const { baseline } = await attemptOnce(env);
    await writeWrapper(env.wrapper, env.wt, "implementation", 2, "completed", null, SESSION, env.taskSha256);
    const out = await runReserve(resumable(env, baseline), { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(out.exitCode).toBe(1);
    expect(out.output.reason).toBe("resume_attempt_mismatch");
    expect(await readFile(partial(env.wt), "utf8")).toBe("partial work\n");
  });

  it("refuses when the service probe is unknown; never infers stopped locally", async () => {
    const env = await setupEnv({ pr: 708 });
    const { baseline } = await attemptOnce(env);
    const failing = svc(env.cred, ((_url: string, _init: PrWorkerServiceFetchInit) => Promise.reject(new Error("down"))) as PrWorkerServiceFetch);
    const transport = await runReserve(resumable(env, baseline), { stateDir: env.stateDir, serviceConfig: failing });
    expect(transport.exitCode).toBe(2);
    expect(transport.output.probe).toBe("unknown");
    // A restarted service (different identity) also cannot resume.
    const restarted = resumable(env, baseline, { expectedService: { pid: 999, version: "restarted" } });
    const changed = await runReserve(restarted, { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(changed.exitCode).toBe(2);
    expect(changed.output.reason).toBe("service_identity_changed");
    expect(await readFile(partial(env.wt), "utf8")).toBe("partial work\n");
  });

  it("refuses a preserved path outside allowedPaths; files preserved", async () => {
    const env = await setupEnv({ pr: 709 });
    const { baseline } = await attemptOnce(env);
    await writeFile(join(env.wt, "outside.txt"), "nope\n");
    const inScopeBaseline = await collectChangeDigest(env.wt);
    const out = await runReserve(resumable(env, inScopeBaseline), { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(out.exitCode).toBe(1);
    expect(out.output.reason).toBe("outside_scope");
    expect(out.output.outside as string[]).toContain("outside.txt");
    expect(await readFile(partial(env.wt), "utf8")).toBe("partial work\n");
    expect(await readFile(join(env.wt, "outside.txt"), "utf8")).toBe("nope\n");
  });

  it("refuses recovery fields for a review role", async () => {
    const env = await setupEnv({ pr: 710 });
    const req = resumable(env, "a".repeat(64), { role: "code-review", allowedPaths: [] });
    const out = await runReserve(req, { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(out.exitCode).toBe(1);
    expect(out.output.reason).toBe("resume_requires_implementation");
  });

  it("does not let an old completed receipt accept a new attempt; files preserved", async () => {
    const env = await setupEnv({ pr: 711 });
    const { baseline } = await attemptOnce(env, "completed", null);
    const resumeReq = resumable(env, baseline);
    const reserved = await runReserve(resumeReq, { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(reserved.exitCode).toBe(0);
    const token = reserved.output.ownerToken as string;
    // The wrapper still carries the old attempt-1 completed receipt.
    await writeWrapper(env.wrapper, env.wt, "implementation", 1, "completed", null, SESSION, env.taskSha256);
    const out = await runAccept(resumeReq, { stateDir: env.stateDir, ownerToken: token, serviceConfig: stoppedSvc(env.cred) });
    expect(out.output.reason).toBe("session_binding_mismatch");
    expect(await readFile(partial(env.wt), "utf8")).toBe("partial work\n");
  });

  it("refuses unpaired recovery fields on the immutable request and at reserve", async () => {
    const env = await setupEnv({ pr: 712 });
    const base = resumable(env, "a".repeat(64));
    // parseCoordinatorRequest refuses a session id without its baseline.
    expect(() => parseCoordinatorRequest({ ...base, startingWorktreeDigest: undefined })).toThrow(/paired/);
    expect(() => parseCoordinatorRequest({ ...base, resumeSessionId: undefined })).toThrow(/paired/);
    // runReserve refuses the same unpaired shape even when constructed directly.
    const unpaired: CoordinatorRequest = { ...env.request, expectedAttempt: 2, resumeSessionId: SESSION };
    const out = await runReserve(unpaired, { stateDir: env.stateDir, serviceConfig: stoppedSvc(env.cred) });
    expect(out.exitCode).toBe(1);
    expect(out.output.reason).toBe("resume_requires_paired_fields");
  });
});
