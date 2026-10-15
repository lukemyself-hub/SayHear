import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile, symlink, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { SignedCompletionStore, recoverCompletion, parseCompletionRecord, CompletionMismatch, CompletionUnavailable, type CompletionRecord, type CompletionStore, type CompletionClock } from "../scripts/pr-approval/completion.ts";
import { confirmCompletionMerge, githubRetryAfterMs, requestProtectedMerge, controllerBuildIdentity, completeLinkedIssuesAfterMerge, GitHubApiError, type GitHubApi } from "../scripts/pr-approval-controller.ts";
import { PR_REVIEW_GATE_POLICY_VERSION, SAYHEAR_REPOSITORY_ID } from "../scripts/pr-review-gate.ts";

const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "d".repeat(40);
const requirement = "c".repeat(64);
const initial: CompletionRecord = {
  version: 1, phase: "merge_unconfirmed", attempts: 0, nextRetryAt: 0, reason: null, mergeSha: null,
  identity: { repositoryId: SAYHEAR_REPOSITORY_ID, pullRequestNumber: 339, pullRequestNodeId: "PR_339", headSha: head,
    approvedBaseSha: base, requirementDigest: requirement, baseRepositoryId: SAYHEAR_REPOSITORY_ID, baseRef: "main",
    botActorId: 999, reviewId: 9, appId: 123, policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
    issueNumbers: [337], humanChannel: "app", humanReviewId: 9, epoch: null,
    integrationMode: "up-to-date-base" },
};
class MemoryStore implements CompletionStore {
  value: CompletionRecord = initial;
  async list() { return [this.value]; }
  async read() { return this.value; }
  async save(value: CompletionRecord) { this.value = structuredClone(value); }
}
function virtualClock() {
  let now = 1_000;
  const waits: number[] = [];
  const clock: CompletionClock = { now: () => now, random: () => 0, sleep: async (ms) => { waits.push(ms); now += ms; } };
  return { clock, waits, advance: (ms: number) => { now += ms; } };
}
const keys = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { format: "pem", type: "pkcs8" }, publicKeyEncoding: { format: "pem", type: "spki" } });
async function signedStore() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "sayhear-completion-test-"));
  return { directory, store: new SignedCompletionStore(directory, keys.privateKey, keys.publicKey) };
}
function apiFor(pull: unknown, reviews: unknown[]): GitHubApi {
  return {
    request: async <T>() => structuredClone(pull) as T,
    pages: async <T>() => structuredClone(reviews) as T[],
    bytes: async () => new Uint8Array(),
  };
}
const mergedPull = { number: 339, node_id: "PR_339", state: "closed", merged: true, merge_commit_sha: merge,
  head: { sha: head, repo: { id: SAYHEAR_REPOSITORY_ID } }, base: { ref: "main", sha: "f".repeat(40), repo: { id: SAYHEAR_REPOSITORY_ID } } };
const approval = { id: 9, user: { id: 999 }, commit_id: head, state: "APPROVED",
  body: `<!-- sayhear-pr-auto-approval-review:v2 pr=339 head=${head} base=${base} requirement=${requirement} outcome=approve -->` };

describe("durable PR completion", () => {
  it("runs bundled fixtures against the artifact when requested", () => {
    if (process.env.SAYHEAR_COMPLETION_BUNDLE_TEST === "1") expect(controllerBuildIdentity().sourceCommit).not.toBe("unbundled");
    expect(controllerBuildIdentity().completionVersion).toBe("sayhear-pr-completion:v1");
  });
  it("recovers delayed merge readback without another merge operation", async () => {
    const store = new MemoryStore();
    const { clock, waits } = virtualClock();
    let reads = 0;
    let closes = 0;
    let mergeCalls = 0;
    const api: GitHubApi = {
      request: async <T>(_path: string, options?: Readonly<{ method?: string }>) => {
        if (options?.method === "PUT") { mergeCalls++; return { merged: true } as T; }
        reads++;
        if (reads < 3) return { merged: true } as T;
        return mergedPull as T;
      },
      pages: async <T>() => [approval] as T[], bytes: async () => new Uint8Array(),
    };
    await store.save(initial);
    await requestProtectedMerge(api, 339, head, "MERGE");
    const result = await recoverCompletion(store, initial, {
      confirmMerge: async () => confirmCompletionMerge(api, initial.identity),
      completeIssues: async () => { closes += 1; },
    }, clock);
    expect(result).toMatchObject({ phase: "complete", attempts: 1, mergeSha: merge });
    expect({ reads, closes, mergeCalls, waits }).toEqual({ reads: 3, closes: 1, mergeCalls: 1, waits: [1_000, 2_000] });
  });
  it("recovers a merge when the pinned API response omits merge_commit_sha", async () => {
    const store = new MemoryStore();
    const { clock } = virtualClock();
    const pinnedPull: Record<string, unknown> = { ...mergedPull };
    delete pinnedPull.merge_commit_sha;
    const mergedEvent = { event: "merged", commit_id: merge, created_at: "2026-10-14T02:15:55Z" };
    const api: GitHubApi = {
      request: async <T>() => structuredClone(pinnedPull) as T,
      pages: async <T>(path: string) => (path.includes("/timeline") ? [mergedEvent] : [approval]) as unknown as T[],
      bytes: async () => new Uint8Array(),
    };
    let closes = 0;
    await store.save(initial);
    const result = await recoverCompletion(store, initial, {
      confirmMerge: async () => confirmCompletionMerge(api, initial.identity),
      completeIssues: async () => { closes += 1; },
    }, clock);
    expect(result).toMatchObject({ phase: "complete", attempts: 1, mergeSha: merge });
    expect(closes).toBe(1);
  });
  it("survives lost merge reply and process death before saving merge confirmation", async () => {
    const { store } = await signedStore();
    await store.save(initial);
    const restarted = await store.read(339);
    expect(restarted).toEqual(initial);
    if (!restarted) throw new Error("Receipt missing");
    let closes = 0;
    const result = await recoverCompletion(store, restarted, { confirmMerge: async () => merge, completeIssues: async () => { closes += 1; } }, virtualClock().clock);
    expect(result.phase).toBe("complete");
    expect(closes).toBe(1);
    expect(await store.read(339)).toEqual(result);
  });
  it("resumes partially completed Issue writes and retains the merge SHA", async () => {
    const store = new MemoryStore();
    const time = virtualClock();
    let issueOpen = true;
    let category = "bug";
    let pendingLabel = true;
    let failures = 5;
    const actions = { confirmMerge: async () => merge, completeIssues: async () => {
      issueOpen = false;
      if (failures-- > 0) throw new Error("Lost label response");
      pendingLabel = false;
    } };
    const pending = await recoverCompletion(store, initial, actions, time.clock);
    expect(pending).toMatchObject({ phase: "issues_pending", mergeSha: merge, attempts: 1 });
    time.advance(60_000);
    const result = await recoverCompletion(store, pending, actions, time.clock);
    expect(result.phase).toBe("complete");
    expect({ issueOpen, pendingLabel, category }).toEqual({ issueOpen: false, pendingLabel: false, category: "bug" });
  });
  it("persists a Retry-After beyond the command window without sleeping or closing", async () => {
    const store = new MemoryStore();
    const { clock, waits } = virtualClock();
    let closes = 0;
    const result = await recoverCompletion(store, initial, { confirmMerge: async () => { throw new CompletionUnavailable("completion_http_retry", 120_000); }, completeIssues: async () => { closes++; } }, clock);
    expect(result).toMatchObject({ phase: "merge_unconfirmed", nextRetryAt: 121_000, reason: "completion_http_retry" });
    expect(waits).toEqual([]);
    expect(closes).toBe(0);
  });
  it.each([
    { retryDelays: [120_000], nextRetryAt: 121_000 },
    { retryDelays: [120_000, 180_000], nextRetryAt: 181_000 },
  ])("defers composed Issue completion until the largest Retry-After $nextRetryAt", async ({ retryDelays, nextRetryAt }) => {
    const store = new MemoryStore();
    const { clock, waits } = virtualClock();
    const writes: number[] = [];
    const reads: number[] = [];
    const api: GitHubApi = {
      request: async <T>(path: string, options?: Readonly<{ method?: string }>) => {
        const issueNumber = Number(path.split("/issues/")[1]?.split("/")[0]);
        const delay = retryDelays[issueNumber - 337];
        if (options?.method === "DELETE") {
          writes.push(issueNumber);
          throw new GitHubApiError(429, "DELETE", path, delay);
        }
        reads.push(issueNumber);
        return { number: issueNumber, state: "closed", labels: delay ? ["bug", "ongoing"] : ["bug"] } as T;
      },
      pages: async () => [], bytes: async () => new Uint8Array(),
    };
    const issueNumbers = retryDelays.map((_, index) => 337 + index).concat(339);
    const record = { ...initial, identity: { ...initial.identity, issueNumbers } };
    const result = await recoverCompletion(store, record, {
      confirmMerge: async () => merge,
      completeIssues: async (identity) => completeLinkedIssuesAfterMerge(api, identity.issueNumbers, { autoMergeEnabled: false, merged: true }),
    }, clock);
    expect(writes).toEqual(retryDelays.map((_, index) => 337 + index));
    expect(reads).toContain(339);
    expect(waits).toEqual([]);
    expect(result).toMatchObject({ phase: "issues_pending", nextRetryAt, reason: "completion_issue_updates_incomplete", mergeSha: merge });
    expect(store.value).toEqual(result);
  });

  it("limits reads, honors nextRetryAt, and stops after ten execution cycles", async () => {
    const store = new MemoryStore();
    const time = virtualClock();
    let reads = 0;
    let current = initial;
    const actions = { confirmMerge: async () => { reads++; return null; }, completeIssues: async () => { throw new Error("Cannot close"); } };
    for (let cycle = 0; cycle < 10; cycle++) {
      current = await recoverCompletion(store, current, actions, time.clock);
      expect(reads).toBe((cycle + 1) * 5);
      if (cycle < 9) {
        expect(await recoverCompletion(store, current, actions, time.clock)).toEqual(current);
        time.advance(60_000);
      }
    }
    expect(current).toMatchObject({ phase: "needs_attention", reason: "merge_confirmation_exhausted", attempts: 10 });
    await recoverCompletion(store, current, actions, time.clock);
    expect(reads).toBe(50);
    expect(time.waits.every((wait) => wait <= 60_000)).toBe(true);
  });
  it.each(["repository_mismatch", "head_mismatch", "base_mismatch", "reviewer_mismatch"])("fails closed for %s without Issue writes", async (reason) => {
    const store = new MemoryStore(); let closes = 0;
    const result = await recoverCompletion(store, initial, { confirmMerge: async () => { throw new CompletionMismatch(reason); }, completeIssues: async () => { closes++; } }, virtualClock().clock);
    expect(result).toMatchObject({ phase: "needs_attention", reason });
    expect(closes).toBe(0);
  });
  it("rejects altered receipts, stale signing keys, symlinks and unsafe permissions", async () => {
    const { directory, store } = await signedStore();
    await store.save(initial);
    const path = resolve(directory, "pr-339.json");
    const envelope = JSON.parse(await readFile(path, "utf8"));
    envelope.payload = envelope.payload.replace(head, "f".repeat(40));
    await writeFile(path, JSON.stringify(envelope));
    await expect(store.read(339)).rejects.toThrow("signature_invalid");
    await store.save(initial);
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { format: "pem", type: "spki" } });
    await expect(new SignedCompletionStore(directory, keys.privateKey, rotated.publicKey).read(339)).rejects.toThrow("signature_invalid");
    await symlink(path, resolve(directory, "pr-340.json"));
    await expect(store.read(340)).rejects.toThrow();
    await chmod(path, 0o644);
    await expect(store.read(339)).rejects.toThrow("file_untrusted");
  });
  it("rejects oversized and signed malformed receipts", async () => {
    const { directory, store } = await signedStore();
    await store.save(initial);
    await writeFile(resolve(directory, "pr-339.json"), " ".repeat(32_001));
    await expect(store.read(339)).rejects.toThrow("file_untrusted");
    await expect(store.save({ ...initial, phase: "complete" })).rejects.toThrow("schema_invalid");
  });
  it("keeps the head-bound integration mode across a signed roundtrip", async () => {
    const { store } = await signedStore();
    await store.save({ ...initial, identity: { ...initial.identity, integrationMode: "serialized-merge" } });
    await expect(store.read(339)).resolves.toMatchObject({ identity: { integrationMode: "serialized-merge" } });
  });

  it("retains immutable review identity and merge delivery state through signed recovery", async () => {
    const { store } = await signedStore();
    const reviewIdentity = {
      diffDigest: "1".repeat(64), changeDigest: "2".repeat(64), workflowBlobSha: "3".repeat(40),
    };
    const receipt: CompletionRecord = {
      ...initial, mergeWriteState: "uncertain",
      identity: { ...initial.identity, integrationMode: "serialized-merge", mergeAction: "merge-now", reviewIdentity },
    };
    await store.save(receipt);
    await expect(store.read(339)).resolves.toMatchObject({
      mergeWriteState: "uncertain", identity: { reviewIdentity, mergeAction: "merge-now" },
    });
    expect(() => parseCompletionRecord({ ...receipt, mergeWriteState: "assume-success" })).toThrow("completion_schema_invalid");
    expect(() => parseCompletionRecord({ ...receipt, identity: { ...receipt.identity, mergeAction: "arm-auto-merge" } })).toThrow("completion_schema_invalid");
    expect(() => parseCompletionRecord({ ...receipt, identity: { ...receipt.identity, reviewIdentity: { ...reviewIdentity, diffDigest: "" } } })).toThrow("completion_schema_invalid");
    expect(parseCompletionRecord(initial).identity.reviewIdentity).toBeUndefined();
  });
});

describe("trusted completion readback", () => {
  it("verifies merged identity while allowing main SHA to advance", async () => {
    await expect(confirmCompletionMerge(apiFor(mergedPull, [approval]), initial.identity)).resolves.toBe(merge);
  });
  it.each([
    [{ ...mergedPull, head: { sha: "f".repeat(40), repo: { id: SAYHEAR_REPOSITORY_ID } } }, "head_mismatch"],
    [{ ...mergedPull, base: { ...mergedPull.base, repo: { id: 123 } } }, "repository_mismatch"],
    [{ ...mergedPull, base: { ...mergedPull.base, ref: "other" } }, "base_mismatch"],
    [{ ...mergedPull, node_id: "PR_OTHER" }, "pr_identity_mismatch"],
  ])("rejects complete mismatched GitHub identity", async (pull, reason) => {
    await expect(confirmCompletionMerge(apiFor(pull, [approval]), initial.identity)).rejects.toThrow(reason);
  });
  it("rejects a real reviewer mismatch and later request changes", async () => {
    await expect(confirmCompletionMerge(apiFor(mergedPull, [{ ...approval, user: { id: 123 } }]), initial.identity)).rejects.toThrow("reviewer_mismatch");
    await expect(confirmCompletionMerge(apiFor(mergedPull, [approval, { ...approval, id: 10, state: "CHANGES_REQUESTED" }]), initial.identity)).rejects.toThrow("reviewer_mismatch");
  });
  it("refuses Issue completion for an approval that deferred pre-merge checks", async () => {
    const deferred = { ...approval, body: approval.body.replace("outcome=approve -->", "outcome=approve_deferred -->") };
    await expect(confirmCompletionMerge(apiFor(mergedPull, [deferred]), initial.identity)).rejects.toThrow("reviewer_mismatch");
  });
  it.each([{ state: "closed" }, { merged: true }, { ...mergedPull, merge_commit_sha: null }, { ...mergedPull, state: "open" }])("incomplete or contradictory response remains retryable", async (pull) => {
    await expect(confirmCompletionMerge(apiFor(pull, [approval]), initial.identity)).rejects.toBeInstanceOf(CompletionUnavailable);
  });
  it("parses GitHub Retry-After and rate limit reset", () => {
    expect(githubRetryAfterMs(new Headers({ "retry-after": "120" }), 1_000)).toBe(120_000);
    expect(githubRetryAfterMs(new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "123" }), 1_000)).toBe(122_000);
  });
});

describe("completion serialization", () => {
  it("refuses a competing controller while preserving the live owner's lock", async () => {
    const { withGlobalLock } = await import("../scripts/pr-approval-controller.ts");
    const parent = await mkdtemp(join(await realpath(tmpdir()), "sayhear-completion-lock-"));
    const path = resolve(parent, "lock");
    let release = () => {};
    const hold = new Promise<void>((done) => { release = done; });
    let entered = () => {};
    const running = new Promise<void>((done) => { entered = done; });
    const first = withGlobalLock(async () => { entered(); await hold; }, path);
    await running;
    await expect(withGlobalLock(async () => { throw new Error("Must not enter"); }, path)).rejects.toThrow("holds the repository lock");
    release();
    await first;
    await expect(withGlobalLock(async () => "recovered", path)).resolves.toBe("recovered");
  });
  it("fails closed when the repository lock directory is a symlink", async () => {
    const { withGlobalLock } = await import("../scripts/pr-approval-controller.ts");
    const parent = await mkdtemp(join(await realpath(tmpdir()), "sayhear-completion-lock-"));
    const target = resolve(parent, "target");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(target, { mode: 0o700 });
    const path = resolve(parent, "lock");
    await symlink(target, path);
    await expect(withGlobalLock(async () => "unsafe", path)).rejects.toThrow("holds the repository lock");
  });
});
