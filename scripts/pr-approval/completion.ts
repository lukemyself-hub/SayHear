import { SignedJsonStore } from "./signed-store.ts";
import type { IntegrationMode } from "../pr-review-gate.ts";
import { parseIntegrationMode } from "../pr-review-gate.ts";
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
  // Absent on v4 receipts, which always used the App review channel.
  humanChannel?: "app" | "browser";
  humanReviewId?: number;
  epoch?: string | null;
  integrationMode?: IntegrationMode;
  reviewIdentity?: Readonly<{
    diffDigest: string;
    changeDigest: string;
    workflowBlobSha: string;
  }>;
  mergeAction?: "merge-now";
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
  // Absence means an older operation whose delivery must be reconciled.
  mergeWriteState?: "not-sent" | "uncertain" | "rejected" | "accepted";
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
  const reviewIdentity = identity.reviewIdentity;
  if (reviewIdentity !== undefined && !record(reviewIdentity)) throw new Error("completion_schema_invalid");
  if (identity.mergeAction !== undefined && identity.mergeAction !== "merge-now") throw new Error("completion_schema_invalid");
  if (value.mergeWriteState !== undefined &&
      !["not-sent", "uncertain", "rejected", "accepted"].includes(string(value.mergeWriteState))) throw new Error("completion_schema_invalid");
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
      humanChannel: identity.humanChannel === "browser" ? "browser" : "app",
      humanReviewId: identity.humanReviewId === undefined ? positive(identity.reviewId) : positive(identity.humanReviewId),
      epoch: identity.epoch === undefined || identity.epoch === null ? null : string(identity.epoch),
      integrationMode: completionIntegrationMode(identity.integrationMode),
      ...(record(reviewIdentity) ? { reviewIdentity: {
        diffDigest: digest(reviewIdentity.diffDigest, 64),
        changeDigest: digest(reviewIdentity.changeDigest, 64),
        workflowBlobSha: digest(reviewIdentity.workflowBlobSha, 40),
      } } : {}),
      ...(identity.mergeAction === "merge-now" ? { mergeAction: "merge-now" as const } : {}),
    },
    phase, attempts: integer(value.attempts), nextRetryAt: integer(value.nextRetryAt),
    reason: value.reason === null ? null : string(value.reason), mergeSha: value.mergeSha === null ? null : digest(value.mergeSha, 40),
    ...(value.mergeWriteState === "not-sent" || value.mergeWriteState === "uncertain" ||
      value.mergeWriteState === "rejected" || value.mergeWriteState === "accepted"
      ? { mergeWriteState: value.mergeWriteState } : {}),
  };
  if ((phase === "issues_pending" || phase === "complete") && result.mergeSha === null) throw new Error("completion_schema_invalid");
  return result;
}

function completionIntegrationMode(value: unknown): IntegrationMode {
  try {
    return parseIntegrationMode(value);
  } catch {
    throw new Error("completion_schema_invalid");
  }
}

export interface CompletionStore {
  list(): Promise<CompletionRecord[]>;
  read(number: number): Promise<CompletionRecord | null>;
  save(value: CompletionRecord): Promise<void>;
}

export class SignedCompletionStore extends SignedJsonStore<CompletionRecord> implements CompletionStore {
  constructor(directory: string, privateKey: string, publicKey: string) {
    super(directory, privateKey, publicKey, parseCompletionRecord, (value) => value.identity.pullRequestNumber, "completion");
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
