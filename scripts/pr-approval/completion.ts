import { createSign, createVerify, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type CompletionIdentity = Readonly<{
  repositoryId: number;
  pullRequestNumber: number;
  pullRequestNodeId: string;
  headSha: string;
  approvedBaseSha: string;
  requirementDigest: string;
  baseRepositoryId: number;
  baseRef: string;
  botActorId: number;
  reviewId: number;
  appId: number;
  policyVersion: string;
  issueNumbers: readonly number[];
}>;
export type CompletionPhase = "merge_unconfirmed" | "issues_pending" | "complete" | "needs_attention";
export type CompletionRecord = Readonly<{
  version: 1;
  identity: CompletionIdentity;
  phase: CompletionPhase;
  attempts: number;
  nextRetryAt: number;
  reason: string | null;
  mergeSha: string | null;
}>;
export class CompletionMismatch extends Error {}
export class CompletionUnavailable extends Error {
  constructor(readonly reason: string, readonly retryAfterMs = 0) {
    super(reason);
  }
}
export const COMPLETION_RETRY_POLICY = Object.freeze({ reads: 5, cycles: 10, windowMs: 60_000, baseDelayMs: 1_000 });
export type CompletionClock = Readonly<{
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}>;
const realClock: CompletionClock = { now: Date.now, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), random: Math.random };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("completion_schema_invalid");
  return value;
}
function positive(value: unknown): number {
  const result = integer(value);
  if (result === 0) throw new Error("completion_schema_invalid");
  return result;
}
function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) throw new Error("completion_schema_invalid");
  return value;
}
function digest(value: unknown, length: number): string {
  const result = string(value);
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(result)) throw new Error("completion_schema_invalid");
  return result;
}
export function parseCompletionRecord(value: unknown): CompletionRecord {
  if (!record(value) || value.version !== 1 || !record(value.identity)) throw new Error("completion_schema_invalid");
  const identity = value.identity;
  if (!Array.isArray(identity.issueNumbers) || identity.issueNumbers.length === 0 || identity.issueNumbers.length > 100) throw new Error("completion_schema_invalid");
  const phase = value.phase;
  if (phase !== "merge_unconfirmed" && phase !== "issues_pending" && phase !== "complete" && phase !== "needs_attention") throw new Error("completion_schema_invalid");
  const result: CompletionRecord = {
    version: 1,
    identity: {
      repositoryId: positive(identity.repositoryId), pullRequestNumber: positive(identity.pullRequestNumber),
      pullRequestNodeId: string(identity.pullRequestNodeId), headSha: digest(identity.headSha, 40),
      approvedBaseSha: digest(identity.approvedBaseSha, 40), requirementDigest: digest(identity.requirementDigest, 64),
      baseRepositoryId: positive(identity.baseRepositoryId), baseRef: string(identity.baseRef),
      botActorId: positive(identity.botActorId), reviewId: positive(identity.reviewId), appId: positive(identity.appId),
      policyVersion: string(identity.policyVersion),
      issueNumbers: identity.issueNumbers.map(positive),
    },
    phase, attempts: integer(value.attempts), nextRetryAt: integer(value.nextRetryAt),
    reason: value.reason === null ? null : string(value.reason), mergeSha: value.mergeSha === null ? null : digest(value.mergeSha, 40),
  };
  if ((phase === "issues_pending" || phase === "complete") && result.mergeSha === null) throw new Error("completion_schema_invalid");
  return result;
}

export interface CompletionStore {
  list(): Promise<CompletionRecord[]>;
  read(number: number): Promise<CompletionRecord | null>;
  save(value: CompletionRecord): Promise<void>;
}

// Signatures give the user-owned directory integrity without granting the
// controller root privileges. Recovery still independently checks GitHub.
export class SignedCompletionStore implements CompletionStore {
  constructor(private readonly directory: string, private readonly privateKey: string, private readonly publicKey: string) {}
  private path(number: number): string { return resolve(this.directory, `pr-${positive(number)}.json`); }
  private async assertDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("completion_directory_untrusted");
    let parent = dirname(this.directory);
    while (parent !== dirname(parent)) {
      const parentInfo = await lstat(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || ((parentInfo.mode & 0o022) !== 0 && (parentInfo.mode & 0o1000) === 0) ||
        (parentInfo.uid !== 0 && parentInfo.uid !== process.getuid?.())) throw new Error("completion_directory_untrusted");
      parent = dirname(parent);
    }
  }
  async read(number: number): Promise<CompletionRecord | null> {
    await this.assertDirectory();
    let handle;
    try { handle = await open(this.path(number), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (record(error) && error.code === "ENOENT") return null; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 32_000) throw new Error("completion_file_untrusted");
      const bytes = Buffer.alloc(32_001);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 32_000) throw new Error("completion_file_untrusted");
      const envelope: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      if (!record(envelope) || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error("completion_signature_invalid");
      const verifier = createVerify("RSA-SHA256").update(envelope.payload).end();
      if (!verifier.verify(this.publicKey, envelope.signature, "base64")) throw new Error("completion_signature_invalid");
      const value = parseCompletionRecord(JSON.parse(envelope.payload));
      if (value.identity.pullRequestNumber !== number) throw new Error("completion_path_mismatch");
      return value;
    } finally { await handle.close(); }
  }
  async save(value: CompletionRecord): Promise<void> {
    await this.assertDirectory();
    const payload = JSON.stringify(parseCompletionRecord(value));
    const signature = createSign("RSA-SHA256").update(payload).end().sign(this.privateKey, "base64");
    const temporary = `${this.path(value.identity.pullRequestNumber)}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ payload, signature }));
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await rename(temporary, this.path(value.identity.pullRequestNumber));
      const directoryHandle = await open(this.directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  async list(): Promise<CompletionRecord[]> {
    await this.assertDirectory();
    const names = await readdir(this.directory);
    const results: CompletionRecord[] = [];
    for (const name of names) {
      const match = /^pr-([1-9]\d*)\.json$/.exec(name);
      if (!match) continue;
      if (results.length >= 1_000) throw new Error("completion_record_limit");
      const value = await this.read(Number(match[1]));
      if (value) results.push(value);
    }
    return results;
  }
}

export async function recoverCompletion(
  store: CompletionStore,
  initial: CompletionRecord,
  actions: Readonly<{
    confirmMerge: (identity: CompletionIdentity) => Promise<string | null>;
    completeIssues: (identity: CompletionIdentity) => Promise<void>;
  }>,
  clock: CompletionClock = realClock,
): Promise<CompletionRecord> {
  if (initial.phase === "complete" || initial.phase === "needs_attention" || initial.nextRetryAt > clock.now()) return initial;
  if (initial.attempts >= COMPLETION_RETRY_POLICY.cycles) {
    const exhausted: CompletionRecord = { ...initial, phase: "needs_attention", reason: initial.mergeSha ? "merged_completion_exhausted" : "merge_confirmation_exhausted" };
    await store.save(exhausted);
    return exhausted;
  }
  let current: CompletionRecord = { ...initial, attempts: initial.attempts + 1 };
  await store.save(current);
  const deadline = clock.now() + COMPLETION_RETRY_POLICY.windowMs;
  for (let read = 0; read < COMPLETION_RETRY_POLICY.reads; read += 1) {
    try {
      const mergeSha = await actions.confirmMerge(current.identity);
      if (mergeSha === null) throw new CompletionUnavailable("merge_not_yet_confirmed");
      if (current.mergeSha !== null && current.mergeSha !== mergeSha) throw new CompletionMismatch("merge_sha_mismatch");
      current = { ...current, phase: "issues_pending", mergeSha, reason: null, nextRetryAt: 0 };
      await store.save(current);
      await actions.completeIssues(current.identity);
      current = { ...current, phase: "complete", reason: null, nextRetryAt: 0 };
      await store.save(current);
      return current;
    } catch (error) {
      if (error instanceof CompletionMismatch) {
        current = { ...current, phase: "needs_attention", reason: error.message };
        await store.save(current);
        return current;
      }
      const reason = error instanceof CompletionUnavailable ? error.reason : "completion_api_unavailable";
      const retryAfterMs = error instanceof CompletionUnavailable ? error.retryAfterMs : record(error) && typeof error.retryAfterMs === "number" ? error.retryAfterMs : 0;
      const delay = Math.max(retryAfterMs, COMPLETION_RETRY_POLICY.baseDelayMs * 2 ** read + Math.floor(clock.random() * 250));
      current = { ...current, reason, nextRetryAt: clock.now() + delay };
      if (current.attempts >= COMPLETION_RETRY_POLICY.cycles && read === COMPLETION_RETRY_POLICY.reads - 1) {
        current = { ...current, phase: "needs_attention", reason: current.mergeSha ? "merged_completion_exhausted" : "merge_confirmation_exhausted" };
      }
      await store.save(current);
      if (read === COMPLETION_RETRY_POLICY.reads - 1 || clock.now() + delay > deadline) return current;
      await clock.sleep(delay);
    }
  }
  return current;
}
