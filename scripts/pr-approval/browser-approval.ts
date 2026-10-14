import { createHash, randomUUID } from "node:crypto";
import { SignedJsonStore } from "./signed-store.ts";

export const BROWSER_APPROVAL_VERSION = "sayhear-pr-browser-approval:v1";
export const AGENT_IDENTITY = Object.freeze({ id: 342173548, login: "luke-agents", type: "User" });
export const LUKE_IDENTITY = Object.freeze({ id: 236989142, login: "lukemyself-hub", type: "User" });
type Actor = Readonly<{ id: number; login: string; type: string }>;
export type BrowserContext = Readonly<{
  repositoryId: number; repositoryNodeId: string; pullRequestNumber: number; pullRequestNodeId: string;
  author: Actor; reviewer: Actor; headSha: string; baseSha: string;
  diffDigest: string; requirementDigest: string; protectedPaths: readonly string[];
  validateWorkflowBlobSha: string;
}>;
type Watermark = Readonly<{ id: number; submittedAt: number }>;
export type BrowserChallenge = Readonly<{ epoch: string; context: BrowserContext; frozenAt: number; watermark: Watermark }>;
export type BrowserReceipt = Readonly<{ challenge: BrowserChallenge; reviewId: number; submittedAt: number }>;
export type BrowserState = Readonly<{
  version: 1; pullRequestNumber: number; epoch: string;
  challenge: BrowserChallenge | null; receipt: BrowserReceipt | null;
}>;
export interface BrowserApprovalStore {
  read(number: number): Promise<BrowserState | null>;
  save(value: BrowserState): Promise<void>;
}
export type HumanAuthorization =
  | Readonly<{ channel: "browser"; receipt: BrowserReceipt | null; challenge: BrowserChallenge | null }>
  | Readonly<{ channel: "legacy-root" }>
  | Readonly<{ channel: "unknown" }>;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1000) throw new Error("browser_schema_invalid");
  return value;
}
function integer(value: unknown, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error("browser_schema_invalid");
  return value;
}
function hex(value: unknown, length: number): string {
  const result = text(value);
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(result)) throw new Error("browser_schema_invalid");
  return result;
}
export function matchesActor(value: unknown, expected: Actor): boolean {
  return record(value) && value.id === expected.id && value.login === expected.login && value.type === expected.type;
}
export function authorizationChannel(author: unknown): HumanAuthorization["channel"] {
  return matchesActor(author, AGENT_IDENTITY) ? "browser" : matchesActor(author, LUKE_IDENTITY) ? "legacy-root" : "unknown";
}
export function parseBrowserContext(value: unknown): BrowserContext {
  if (!record(value) || !matchesActor(value.author, AGENT_IDENTITY) || !matchesActor(value.reviewer, LUKE_IDENTITY) ||
      !Array.isArray(value.protectedPaths) || value.protectedPaths.length > 3000) throw new Error("browser_context_invalid");
  const paths = value.protectedPaths.map(text);
  if (paths.some((path) => path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => ["", ".", ".."].includes(part)))) {
    throw new Error("browser_paths_invalid");
  }
  return {
    repositoryId: integer(value.repositoryId), repositoryNodeId: text(value.repositoryNodeId),
    pullRequestNumber: integer(value.pullRequestNumber), pullRequestNodeId: text(value.pullRequestNodeId),
    author: AGENT_IDENTITY, reviewer: LUKE_IDENTITY, headSha: hex(value.headSha, 40), baseSha: hex(value.baseSha, 40),
    diffDigest: hex(value.diffDigest, 64), requirementDigest: hex(value.requirementDigest, 64),
    protectedPaths: [...new Set(paths)].sort(), validateWorkflowBlobSha: hex(value.validateWorkflowBlobSha, 40),
  };
}
export function browserContextDigest(context: BrowserContext): string {
  return createHash("sha256").update(JSON.stringify(parseBrowserContext(context))).digest("hex");
}
function parseChallenge(value: unknown): BrowserChallenge {
  if (!record(value) || !record(value.watermark)) throw new Error("browser_challenge_invalid");
  return { epoch: text(value.epoch), context: parseBrowserContext(value.context), frozenAt: integer(value.frozenAt),
    watermark: { id: integer(value.watermark.id, 0), submittedAt: integer(value.watermark.submittedAt, 0) } };
}
export function parseBrowserReceipt(value: unknown): BrowserReceipt {
  if (!record(value)) throw new Error("browser_receipt_invalid");
  const result = { challenge: parseChallenge(value.challenge), reviewId: integer(value.reviewId), submittedAt: integer(value.submittedAt) };
  if (result.reviewId <= result.challenge.watermark.id || result.submittedAt <= Math.max(result.challenge.frozenAt, result.challenge.watermark.submittedAt)) throw new Error("browser_receipt_predates_challenge");
  return result;
}
export function parseBrowserState(value: unknown): BrowserState {
  if (!record(value) || value.version !== 1) throw new Error("browser_state_invalid");
  const result: BrowserState = { version: 1, pullRequestNumber: integer(value.pullRequestNumber), epoch: text(value.epoch),
    challenge: value.challenge === null ? null : parseChallenge(value.challenge), receipt: value.receipt === null ? null : parseBrowserReceipt(value.receipt) };
  if (result.challenge && (result.challenge.epoch !== result.epoch || result.challenge.context.pullRequestNumber !== result.pullRequestNumber)) throw new Error("browser_epoch_mismatch");
  if (result.receipt && JSON.stringify(result.receipt.challenge) !== JSON.stringify(result.challenge)) throw new Error("browser_receipt_mismatch");
  return result;
}
export class SignedBrowserApprovalStore extends SignedJsonStore<BrowserState> implements BrowserApprovalStore {
  constructor(directory: string, privateKey: string, publicKey: string) {
    super(directory, privateKey, publicKey, parseBrowserState, (value) => value.pullRequestNumber, "browser_approval");
  }
}
export type SubmittedLukeReview = Readonly<{ id: number; submittedAt: number; state: string; headSha: string }>;
export function latestLukeReview(reviews: readonly unknown[]): SubmittedLukeReview | null {
  const relevant: SubmittedLukeReview[] = [];
  for (const raw of reviews) {
    if (!record(raw) || !record(raw.user)) throw new Error("browser_review_identity_invalid");
    if (raw.user.id !== LUKE_IDENTITY.id && raw.user.login !== LUKE_IDENTITY.login) continue;
    if (!matchesActor(raw.user, LUKE_IDENTITY)) throw new Error("browser_review_identity_invalid");
    if (raw.state === "PENDING") continue;
    const timestamp = text(raw.submitted_at);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)) throw new Error("browser_review_time_invalid");
    const submittedAt = Date.parse(timestamp);
    if (!Number.isSafeInteger(submittedAt) || new Date(submittedAt).toISOString().replace(".000Z", "Z") !== timestamp.replace(".000Z", "Z")) throw new Error("browser_review_time_invalid");
    const state = text(raw.state);
    if (!["APPROVED", "COMMENTED", "CHANGES_REQUESTED", "DISMISSED"].includes(state)) throw new Error("browser_review_state_invalid");
    relevant.push({ id: integer(raw.id), submittedAt, state, headSha: hex(raw.commit_id, 40) });
  }
  relevant.sort((a, b) => a.id - b.id);
  for (let i = 1; i < relevant.length; i++) {
    if (relevant[i]!.id === relevant[i - 1]!.id || relevant[i]!.submittedAt <= relevant[i - 1]!.submittedAt) throw new Error("browser_review_order_invalid");
  }
  return relevant.at(-1) ?? null;
}

// Every read re-derives the current context and invalidates observed drift.
// Only the prepare path freezes a new epoch; scan and submit reuse it.
export async function readBrowserAuthorization(
  store: BrowserApprovalStore,
  number: number,
  context: BrowserContext | null,
  reviews: readonly unknown[],
  prepare = false,
  now = Date.now(),
): Promise<Extract<HumanAuthorization, { channel: "browser" }>> {
  let current = await store.read(number);
  let latest: SubmittedLukeReview | null;
  try { latest = latestLukeReview(reviews); }
  catch (error) {
    await store.save({ version: 1, pullRequestNumber: number, epoch: randomUUID(), challenge: null, receipt: null });
    throw error;
  }
  const drift = current?.challenge && (!context || browserContextDigest(current.challenge.context) !== browserContextDigest(context));
  const revoked = current?.receipt && (!latest || latest.id < current.receipt.reviewId || latest.state !== "APPROVED" || latest.headSha !== context?.headSha);
  if (drift || revoked) {
    current = { version: 1, pullRequestNumber: number, epoch: randomUUID(), challenge: null, receipt: null };
    await store.save(current);
  }
  if (!current?.challenge && prepare && context) {
    const epoch = randomUUID();
    current = { version: 1, pullRequestNumber: number, epoch, receipt: null,
      challenge: { epoch, context: parseBrowserContext(context), frozenAt: Math.max(now, latest?.submittedAt ?? 0),
        watermark: { id: latest?.id ?? 0, submittedAt: latest?.submittedAt ?? 0 } } };
    await store.save(current);
  }
  const challenge = current?.challenge ?? null;
  if (!challenge || !latest || latest.state !== "APPROVED" || latest.headSha !== context?.headSha ||
      latest.id <= challenge.watermark.id || latest.submittedAt <= Math.max(challenge.frozenAt, challenge.watermark.submittedAt)) {
    return { channel: "browser", challenge, receipt: null };
  }
  const receipt: BrowserReceipt = { challenge, reviewId: latest.id, submittedAt: latest.submittedAt };
  if (JSON.stringify(current?.receipt) !== JSON.stringify(receipt)) await store.save({ version: 1, pullRequestNumber: number, epoch: challenge.epoch, challenge, receipt });
  return { channel: "browser", challenge, receipt };
}
