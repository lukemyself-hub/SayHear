import {
  createHash,
  createSign,
  createPublicKey,
} from "node:crypto";
import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import {
  readFile,
  writeFile,
  mkdir,
  rmdir,
  unlink,
  stat,
  lstat,
  chmod,
  realpath,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  AGENT_IDENTITY,
  BROWSER_APPROVAL_VERSION,
  LUKE_IDENTITY,
  authorizationChannel,
  latestLukeReview,
  readBrowserAuthorization,
  SignedBrowserApprovalStore,
  type BrowserApprovalStore,
  type BrowserChallenge,
  type BrowserReceipt,
} from "./pr-approval/browser-approval.ts";
import { SignedCompletionStore, recoverCompletion, CompletionMismatch, CompletionUnavailable, type CompletionStore, type CompletionRecord, type CompletionIdentity, type CompletionClock } from "./pr-approval/completion.ts";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  evaluatePrReviewGate,
  integrationModeOf,
  PR_REVIEW_GATE_CHECK_NAME,
  PR_REVIEW_GATE_LEGACY_POLICY_VERSION as V4_POLICY_VERSION,
  PR_REVIEW_GATE_PREVIOUS_POLICY_VERSION as V5_POLICY_VERSION,
  PR_REVIEW_GATE_INSTALLED_POLICY_VERSION as V8_POLICY_VERSION,
  PR_REVIEW_GATE_OLDER_INSTALLED_POLICY_VERSION as V6_POLICY_VERSION,
  PR_REVIEW_GATE_V9_POLICY_VERSION,
  PR_REVIEW_GATE_V10_POLICY_VERSION,
  PR_REVIEW_GATE_POLICY_VERSION,
  PR_REVIEW_REPORT_VERSION,
  PR_VALIDATE_WORKFLOW_PATH,
  parsePrReviewGateInput,
  parseIntegrationMode,
  requirementDigest,
  parseIssueClosureExclusions,
  closingKeywordIssueNumbers,
  protectedReviewPaths,
  SAYHEAR_REPOSITORY_ID,
  SAYHEAR_REPOSITORY_NAME,
  type IntegrationMode,
  MAIN_WRITER_ATTESTATION_VERSION,
  type MainWriterAttestation,
  type PrReviewGateInput,
  type PrReviewGateReport,
  type RulesetFingerprint,
  type TrustedPrReviewPolicy,
} from "./pr-review-gate.ts";
import { SignedIntegrationRefreshStore, requestIntegrationRefresh, type IntegrationRefreshStore } from "./pr-approval/integration-refresh.ts";
import { collectPullRequestDiff, readPullRequestFileManifest, type CollectedPrDiff } from "./pr-approval/diff.ts";
import {
  FIXED_PR_CI_BASELINE,
  planDailyReleaseValidation,
  preMergeDeferralFor,
  DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
  RELEASE_CHECKS,
  type ReleaseImpactKind,
} from "./daily-release-validation.ts";

export { SignedCompletionStore, recoverCompletion, parseCompletionRecord, CompletionMismatch, CompletionUnavailable, COMPLETION_RETRY_POLICY } from "./pr-approval/completion.ts";
export { collectPullRequestDiff, readPullRequestFileManifest, gitBlobSha } from "./pr-approval/diff.ts";
export { PR_REVIEW_GATE_POLICY_VERSION, PR_REVIEW_GATE_LEGACY_POLICY_VERSION, PR_REVIEW_GATE_PREVIOUS_POLICY_VERSION, PR_REVIEW_GATE_INSTALLED_POLICY_VERSION, PR_REVIEW_GATE_OLDER_INSTALLED_POLICY_VERSION, PR_REVIEW_REPORT_VERSION, PR_VALIDATE_WORKFLOW_PATH,
  SAYHEAR_REPOSITORY_ID, SAYHEAR_REPOSITORY_NAME, evaluatePrReviewGate, parsePrReviewGateInput, integrationModeOf, parseIntegrationMode, type IntegrationMode,
  requirementDigest, parseIssueClosureExclusions, closingKeywordIssueNumbers, protectedReviewPaths } from "./pr-review-gate.ts";
export { FIXED_PR_CI_BASELINE, RELEASE_CHECKS, preMergeDeferralFor } from "./daily-release-validation.ts";
export {
  BROWSER_APPROVAL_VERSION, AGENT_IDENTITY, LUKE_IDENTITY, authorizationChannel, browserContextDigest,
  latestLukeReview, matchesActor, parseBrowserContext, parseBrowserReceipt, parseBrowserState,
  readBrowserAuthorization, SignedBrowserApprovalStore,
  type BrowserApprovalStore, type BrowserChallenge, type BrowserContext, type BrowserReceipt, type BrowserState,
} from "./pr-approval/browser-approval.ts";

declare const __PR_APPROVAL_BUILD_INFO__: Readonly<{ sourceCommit: string; sourceDiffSha256: string; nodeVersion: string; esbuildVersion: string }>;
export function controllerBuildIdentity(): Readonly<Record<string, unknown>> {
  return {
    ...(typeof __PR_APPROVAL_BUILD_INFO__ === "undefined"
      ? { sourceCommit: "unbundled", sourceDiffSha256: null }
      : __PR_APPROVAL_BUILD_INFO__),
    completionVersion: "sayhear-pr-completion:v1", policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
    diffCollectionVersion: "sayhear-pr-diff:v2", baseSyncHandoffVersion: "sayhear-pr-base-sync:v1",
    browserApprovalVersion: BROWSER_APPROVAL_VERSION,
  };
}

const execFileAsync = promisify(execFile);
const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const ACTIONS_APP_ID = 15368;
const CONFIG_DIRECTORY =
  "/Library/Application Support/SayHear/PRApproval";
const CONFIG_PATH = `${CONFIG_DIRECTORY}/config.json`;
const CONTROLLER_PATH = `${CONFIG_DIRECTORY}/controller.mjs`;
const ATTESTATION_PATH = `${CONFIG_DIRECTORY}/main-writer-attestation.json`;
const LAUNCHER_PATHS = [
  `${CONFIG_DIRECTORY}/pr-approval-status`,
  `${CONFIG_DIRECTORY}/pr-approval-prepare`,
  `${CONFIG_DIRECTORY}/pr-approval-scan`,
  `${CONFIG_DIRECTORY}/pr-approval-submit`,
  `${CONFIG_DIRECTORY}/pr-approval-configure`,
] as const;
const RUNTIME_NODE_PATH = `${CONFIG_DIRECTORY}/node`;
const TRUSTED_CONFIG_DIRECTORIES = [
  "/Library",
  "/Library/Application Support",
  "/Library/Application Support/SayHear",
  CONFIG_DIRECTORY,
] as const;
const KEYCHAIN_SERVICE = "SayHear PR Approval GitHub App";
const KEYCHAIN_ACCOUNT = SAYHEAR_REPOSITORY_NAME;
const MAX_REPORT_BYTES = 20_000;
const MAX_ARTIFACT_ARCHIVE_BYTES = 50_000_000;
const REVIEW_TASK_STALE_AFTER_MS = 6 * 60 * 60 * 1_000;
const LOCK_DIRECTORY = "/private/tmp/sayhear-pr-approval.lock";
const REVIEW_ARTIFACT_DIRECTORY = "artifacts/pr-approval";
const ISSUE_COMMENT_MARKER = "<!-- sayhear-pr-auto-approval:v1";
const PAUSE_MARKER = "<!-- sayhear-pr-auto-approval-pause:v1";
const AUTO_REVIEW_COMMENT_MARKER = "<!-- sayhear-pr-auto-approval-review:v1";
const ISSUE_STATUS_LABELS = [
  "ongoing",
  "ready-for-agent",
  "ready-for-human",
  "needs-triage",
  "needs-info",
  "wontfix",
] as const;
const ISSUE_STATUS_LABEL_SET: ReadonlySet<string> = new Set(ISSUE_STATUS_LABELS);
const REVIEW_RETRYABLE_WAIT_REASONS = new Set([
  "policy_version_mismatch",
  "stale_review",
  "github_context_unavailable",
  "incomplete_diff",
  // GitHub computes mergeability asynchronously, so a freshly created or
  // rebased merge ref reports nothing at all for the first read or two.
  "mergeability_unknown",
]);

type JsonRecord = Record<string, unknown>;

type ApiOptions = Readonly<{
  method?: string;
  body?: unknown;
  accept?: string;
}>;

export interface GitHubApi {
  request<T>(path: string, options?: ApiOptions): Promise<T>;
  pages<T>(path: string): Promise<T[]>;
  bytes(
    path: string,
    options?: Readonly<{ accept?: string; maxBytes?: number }>,
  ): Promise<Uint8Array>;
}

export function githubRetryAfterMs(headers: Headers, now = Date.now()): number {
  const retry = headers.get("retry-after");
  if (retry !== null) {
    const seconds = Number(retry);
    const until = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1_000 : Date.parse(retry);
    if (Number.isFinite(until)) return Math.max(0, until - now);
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset)) return Math.max(0, reset * 1_000 - now);
  }
  return 0;
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    readonly retryAfterMs = 0,
  ) {
    super(`GitHub API ${method} ${path} failed with HTTP ${status}.`);
    this.name = "GitHubApiError";
  }
}

export type GitHubAppConfig = Readonly<{
  appId: number;
  installationId: number;
  slug: string;
  productionMergeAuthorized: boolean;
  ordinaryMergeTriggersProduction: boolean;
  /**
   * How the controller proves a PR integrates with the current main before it
   * merges. `up-to-date-base` keeps the historical rule (the PR base must equal
   * main). `merge-queue` binds the approval to the head commit and hands the
   * merged result to GitHub's merge queue. `serialized-merge` also binds the
   * approval to the head commit but pins its own merge against the current main
   * instead of enqueueing. Absent means `up-to-date-base`.
   */
  integrationMode?: IntegrationMode;
  humanReviewAuthorizations?: readonly HumanReviewAuthorization[];
}>;

// Only armed auto-merge operations count here. Reviewed PRs waiting for their
// turn do not block parallel review, but an armed writer can race an immediate merge.
export function anotherApprovalInFlightFor(
  integrationMode: IntegrationMode,
  openPullRequestCount: number,
): boolean {
  return integrationMode !== "merge-queue" && openPullRequestCount > 0;
}

export type HumanReviewAuthorization = Readonly<{
  pullRequestNumber: number;
  // Audit provenance; exact diff and requirement matching survive main-only updates.
  approvedHeadSha: string;
  approvedBaseSha?: string;
  diffDigest: string;
  requirementDigest: string;
  paths: readonly string[];
  noRuntimeImpact?: boolean;
  validateWorkflowBlobSha: string | null;
  approvedAt: string;
}>;

export function parseHumanReviewAuthorizations(value: unknown): readonly HumanReviewAuthorization[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error("Human review authorizations must be a bounded array.");
  }
  const hex = (raw: unknown, length: number): string => {
    if (typeof raw !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(raw)) {
      throw new Error("Human review authorization digest is invalid.");
    }
    return raw;
  };
  return value.map((raw) => {
    if (!isRecord(raw) || !Array.isArray(raw.paths) || raw.paths.length === 0 || raw.paths.length > 100 ||
      raw.paths.some((path) => typeof path !== "string" || !/^[A-Za-z0-9_.\/-]+$/.test(path) ||
        path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "." || part === ""))) {
      throw new Error("Human review authorization paths are invalid.");
    }
    const approvedAt = requiredString(raw.approvedAt, "approvedAt");
    if (!Number.isFinite(Date.parse(approvedAt))) throw new Error("Human approval time is invalid.");
    if (raw.noRuntimeImpact !== undefined && typeof raw.noRuntimeImpact !== "boolean") {
      throw new Error("Human no-runtime decision must be a boolean.");
    }
    return {
      pullRequestNumber: requiredPositiveInteger(raw.pullRequestNumber, "pullRequestNumber"),
      approvedHeadSha: hex(raw.approvedHeadSha, 40),
      ...(raw.approvedBaseSha === undefined ? {} : { approvedBaseSha: hex(raw.approvedBaseSha, 40) }),
      diffDigest: hex(raw.diffDigest, 64),
      requirementDigest: hex(raw.requirementDigest, 64),
      paths: raw.paths as string[],
      ...(raw.noRuntimeImpact === undefined ? {} : { noRuntimeImpact: raw.noRuntimeImpact }),
      validateWorkflowBlobSha: raw.validateWorkflowBlobSha === null ? null : hex(raw.validateWorkflowBlobSha, 40),
      approvedAt,
    };
  });
}

export function matchHumanReviewAuthorization(
  records: readonly HumanReviewAuthorization[],
  identity: Readonly<{ pullRequestNumber: number; diffDigest: string; requirementDigest: string; diffComplete: boolean }>,
): HumanReviewAuthorization | null {
  // The root-owned record binds the full diff and requirement, so a main-only
  // synchronization can retain authorization without admitting new PR code.
  if (!identity.diffComplete) return null;
  const matches = records.filter((record) => record.pullRequestNumber === identity.pullRequestNumber &&
    record.diffDigest === identity.diffDigest && record.requirementDigest === identity.requirementDigest);
  return matches.length === 1 ? matches[0]! : null;
}

export function isTrustedWorkflowVersion(base: string | null, merge: string | null, approved: string | null): boolean {
  return base !== null && merge !== null && (merge === base || merge === approved);
}

export type ModelReviewReport = Readonly<{
  version: string;
  policyVersion: string;
  repositoryId: number;
  pullRequestNumber: number;
  headSha: string;
  baseSha: string;
  requirementDigest: string;
  decision: PrReviewGateInput["review"]["decision"];
  diffComplete: boolean;
  declaredImpacts: readonly ReleaseImpactKind[];
  capability: PrReviewGateInput["review"]["capability"];
  riskFlags: PrReviewGateInput["review"]["riskFlags"];
  findings: PrReviewGateInput["review"]["findings"];
}>;

type ReviewPacket = Readonly<{
  repository: PrReviewGateInput["repository"];
  pullRequest: PrReviewGateInput["pullRequest"];
  issues: PrReviewGateInput["issues"];
  evidence: PrReviewGateInput["evidence"];
  branchProtection: PrReviewGateInput["branchProtection"];
  runtime: PrReviewGateInput["runtime"];
  workflow: Readonly<{
    path: string;
    trustedBlobSha: string | null;
    status: "queued" | "in_progress" | "completed" | "missing" | "unknown";
    conclusion: string | null;
  }>;
  diff: CollectedPrDiff & Readonly<{ changeDigest: string }>;
  reviewContext: Readonly<{
    reportVersion: string;
    policyVersion: string;
    baseSha: string;
    requirementDigest: string;
  }>;
  impactHints: readonly ReleaseImpactKind[];
  suggestedEvidenceIds: readonly string[];
  browserApproval: Readonly<{
    version: string;
    channel: HumanReviewBinding["channel"];
    frozenAt: number | null;
    epoch: string | null;
    reviewId: number | null;
  }>;
}>;

// The three authorization channels are mutually exclusive. An agent-authored PR
// can only be authorized by Luke's browser review; a root record never applies.
export type HumanReviewBinding = Readonly<{
  channel: "browser" | "legacy-root" | "unknown";
  paths: readonly string[];
  noRuntimeImpact: boolean;
  validateWorkflowBlobSha: string | null;
  receipt: BrowserReceipt | null;
  challenge: BrowserChallenge | null;
}>;
const NO_HUMAN_BINDING: HumanReviewBinding = Object.freeze({
  channel: "unknown", paths: [], noRuntimeImpact: false, validateWorkflowBlobSha: null, receipt: null, challenge: null,
});

// v4 requirement digests digested top-level review bodies and states. v5 excludes
// every review record so that approval text, dismissal, and review state cannot
// change the requirement the approval is bound to. Inline comments stay included.
//
// Only identities that ran against the durable store belong here: a signed
// completion receipt is read back with the projection its own policy produced.
// v7 was reviewed on main but never installed, so it never wrote one. v6 and v8
// were both installed and both wrote receipts, so both stay listed.
export type RequirementProjection = "review-inclusive-v4" | "review-exclusive-v5";
export const RECEIPT_POLICY_VERSIONS: readonly string[] = [
  PR_REVIEW_GATE_POLICY_VERSION,
  PR_REVIEW_GATE_V10_POLICY_VERSION,
  PR_REVIEW_GATE_V9_POLICY_VERSION,
  V8_POLICY_VERSION,
  V6_POLICY_VERSION,
  V5_POLICY_VERSION,
  V4_POLICY_VERSION,
];
export function requirementProjectionFor(policyVersion: string): RequirementProjection {
  // Never guess a projection for an unknown policy: guessing the review-inclusive
  // one would silently accept a digest the policy never produced.
  if (!RECEIPT_POLICY_VERSIONS.includes(policyVersion)) throw new Error(`Unknown PR review policy version: ${policyVersion}`);
  return policyVersion === V4_POLICY_VERSION ? "review-inclusive-v4" : "review-exclusive-v5";
}

type ControllerConfig = Readonly<{
  api: GitHubApi;
  completionStore?: CompletionStore;
  integrationRefreshStore?: IntegrationRefreshStore;
  browserApprovalStore?: BrowserApprovalStore;
  app: GitHubAppConfig;
  /**
   * Operator attestation loaded once at startup next to the App config, so
   * snapshot and status paths never touch the protected filesystem mid-flow.
   * Absent means no attestation was presented; unit-test configs omit it.
   */
  mainWriterAttestation?: MainWriterAttestation | null;
  policy: TrustedPrReviewPolicy;
  botActorId: number;
  ownerActorId: number;
}>;

type GitHubPullRequest = JsonRecord & {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  title: string;
  body: string | null;
  updated_at: string;
  head: JsonRecord & { sha: string; repo: (JsonRecord & { id: number }) | null };
  base: JsonRecord & { ref: string; sha: string };
  user: JsonRecord & { id: number };
  merge_commit_sha: string | null;
  // GitHub computes mergeability asynchronously; `null` means "not ready yet".
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  changed_files: number;
};

type GitHubIssue = JsonRecord & {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string | null;
  updated_at: string;
  labels: readonly (string | Readonly<{ name: string }>)[];
};

export type GitHubComment = JsonRecord & {
  id: number;
  body: string | null;
  created_at: string;
  updated_at: string;
  user: JsonRecord & { id: number; login: string };
};

type GitHubReview = JsonRecord & {
  id: number;
  state: string;
  body: string | null;
  commit_id: string;
  user: JsonRecord & { id: number; login: string };
};

type GitHubWorkflowRun = JsonRecord & {
  id: number;
  run_attempt: number;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  path: string;
  workflow_id: number;
  pull_requests: readonly Readonly<{
    number: number;
    base: Readonly<{ sha: string }>;
    head: Readonly<{ sha: string }>;
  }>[];
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function createGitHubAppJwt(
  appId: number,
  privateKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 8 * 60,
      iss: appId,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
}

export class GitHubRestClient implements GitHubApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request<T>(path: string, options: ApiOptions = {}): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error("GitHub API paths must be relative to api.github.com.");
    }
    const response = await this.fetchImpl(`${API_ROOT}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: options.accept ?? "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "sayhear-pr-auto-approval",
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        options.method ?? "GET",
        path,
        githubRetryAfterMs(response.headers),
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async pages<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    let page = 1;
    while (page <= 100) {
      const separator = path.includes("?") ? "&" : "?";
      const chunk = await this.request<T[]>(
        `${path}${separator}per_page=100&page=${page}`,
      );
      if (!Array.isArray(chunk)) {
        throw new Error(`GitHub API returned a non-array for ${path}.`);
      }
      values.push(...chunk);
      if (chunk.length < 100) return values;
      page += 1;
    }
    throw new Error(`GitHub API pagination exceeded its limit for ${path}.`);
  }

  async bytes(
    path: string,
    options: Readonly<{ accept?: string; maxBytes?: number }> = {},
  ): Promise<Uint8Array> {
    const response = await this.fetchImpl(`${API_ROOT}${path}`, {
      headers: {
        Accept: options.accept ?? "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "sayhear-pr-auto-approval",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub artifact download failed with HTTP ${response.status}.`);
    }
    const maxBytes = options.maxBytes ?? MAX_ARTIFACT_ARCHIVE_BYTES;
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`GitHub response exceeds the ${maxBytes}-byte limit.`);
    }
    if (!response.body) throw new Error("GitHub response has no body.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error(`GitHub response exceeds the ${maxBytes}-byte limit.`);
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size);
  }
}

async function readAppPrivateKey(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("The PR approval controller requires macOS Keychain.");
  }
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        KEYCHAIN_ACCOUNT,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ],
      { encoding: "utf8", maxBuffer: 32_768 },
    );
    const keychainValue = stdout.trim();
    let privateKey = keychainValue;
    if (/^(?:[0-9a-f]{2})+$/i.test(keychainValue)) {
      const keyBytes = Buffer.from(keychainValue, "hex");
      privateKey = keyBytes.toString("utf8");
      if (!Buffer.from(privateKey, "utf8").equals(keyBytes)) {
        throw new Error("The Keychain value is not valid UTF-8 PEM data.");
      }
    }
    if (
      !privateKey.includes("-----BEGIN") ||
      !privateKey.includes("PRIVATE KEY-----")
    ) {
      throw new Error("The Keychain item is not a PEM private key.");
    }
    return privateKey;
  } catch {
    throw new Error(
      `GitHub App key is missing from Keychain service "${KEYCHAIN_SERVICE}".`,
    );
  }
}

async function assertTrustedDirectories(): Promise<void> {
  for (const directory of TRUSTED_CONFIG_DIRECTORIES) {
    const [resolvedPath, directoryInfo] = await Promise.all([
      realpath(directory),
      stat(directory),
    ]);
    if (
      resolvedPath !== directory ||
      !directoryInfo.isDirectory() ||
      directoryInfo.uid !== 0 ||
      (directoryInfo.mode & 0o022) !== 0
    ) {
      throw new Error(
        `Trusted config directory ${directory} must be root-owned and non-writable by group or others.`,
      );
    }
  }
}

async function assertTrustedControllerInstall(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("The PR approval controller requires its protected macOS install.");
  }
  if (!process.argv[1]) {
    throw new Error("The protected controller path could not be verified.");
  }
  await assertTrustedDirectories();
  const [controllerPath, controllerInfo, launchers, nodePath, nodeInfo, runtimePath] =
    await Promise.all([
      realpath(process.argv[1]),
      stat(process.argv[1]),
      Promise.all(
        LAUNCHER_PATHS.map(async (path) => ({
          path,
          resolvedPath: await realpath(path),
          info: await stat(path),
        })),
      ),
      realpath(RUNTIME_NODE_PATH),
      stat(RUNTIME_NODE_PATH),
      realpath(process.execPath),
    ]);
  const protectedFile = (
    filePath: string,
    resolvedPath: string,
    fileInfo: Stats,
  ) =>
    resolvedPath === filePath &&
    fileInfo.isFile() &&
    fileInfo.uid === 0 &&
    (fileInfo.mode & 0o022) === 0;
  if (
    !protectedFile(CONTROLLER_PATH, controllerPath, controllerInfo) ||
    launchers.some(
      ({ path, resolvedPath, info }) =>
        !protectedFile(path, resolvedPath, info),
    ) ||
    !protectedFile(RUNTIME_NODE_PATH, nodePath, nodeInfo) ||
    runtimePath !== RUNTIME_NODE_PATH
  ) {
    throw new Error(
      "The controller, launcher, and Node runtime must be root-owned files in the protected install directory.",
    );
  }
  for (const name of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_EXTRA_CA_CERTS",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NODE_USE_ENV_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    if (process.env[name] !== undefined) {
      throw new Error(`The protected controller must not inherit ${name}.`);
    }
  }
}

async function assertTrustedConfigLocation(): Promise<void> {
  await assertTrustedDirectories();
  const [resolvedPath, configInfo] = await Promise.all([
    realpath(CONFIG_PATH),
    stat(CONFIG_PATH),
  ]);
  if (
    resolvedPath !== CONFIG_PATH ||
    !configInfo.isFile() ||
    configInfo.uid !== 0 ||
    (configInfo.mode & 0o022) !== 0
  ) {
    throw new Error(
      "GitHub App config must be a root-owned, non-writable regular file.",
    );
  }
}

async function readLocalAppConfig(): Promise<GitHubAppConfig> {
  let rawConfig: string;
  try {
    await assertTrustedConfigLocation();
    rawConfig = await readFile(CONFIG_PATH, "utf8");
  } catch {
    throw new Error(
      `GitHub App config is missing, invalid, or outside the trusted location ${CONFIG_PATH}.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(rawConfig) as unknown;
  } catch {
    throw new Error(`GitHub App config is not valid JSON at ${CONFIG_PATH}.`);
  }
  if (!isRecord(value)) throw new Error("GitHub App config must be an object.");
  return {
    appId: requiredPositiveInteger(value.appId, "appId"),
    installationId: requiredPositiveInteger(
      value.installationId,
      "installationId",
    ),
    slug: requiredString(value.slug, "slug"),
    productionMergeAuthorized: requiredBoolean(
      value.productionMergeAuthorized,
      "productionMergeAuthorized",
    ),
    ordinaryMergeTriggersProduction: requiredBoolean(
      value.ordinaryMergeTriggersProduction,
      "ordinaryMergeTriggersProduction",
    ),
    integrationMode: parseIntegrationMode(value.integrationMode),
    humanReviewAuthorizations: parseHumanReviewAuthorizations(value.humanReviewAuthorizations),
  };
}

async function createApiClient(
  config: GitHubAppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubRestClient> {
  const privateKey = await readAppPrivateKey();
  const jwt = createGitHubAppJwt(config.appId, privateKey);
  const appClient = new GitHubRestClient(jwt, fetchImpl);
  const appIdentity = await appClient.request<JsonRecord>("/app");
  if (
    recordNumber(appIdentity, "id") !== config.appId ||
    recordString(appIdentity, "slug") !== config.slug
  ) {
    throw new Error("The configured App ID or slug does not match the key.");
  }
  const installationState = await appClient.request<JsonRecord>(
    `/app/installations/${config.installationId}`,
  );
  if (
    !isRecord(installationState.account) ||
    installationState.account.login !== "lukemyself-hub" ||
    installationState.repository_selection !== "selected"
  ) {
    throw new Error(
      "The GitHub App installation must target only the lukemyself-hub account's selected repositories.",
    );
  }
  const installation = await appClient.request<JsonRecord>(
    `/app/installations/${config.installationId}/access_tokens`,
    { method: "POST", body: {} },
  );
  const granted = isRecord(installation.permissions)
    ? installation.permissions
    : null;
  const expectedPermissions: Readonly<Record<string, string>> = {
    actions: "read",
    administration: "read",
    checks: "write",
    contents: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write",
  };
  if (
    !granted ||
    Object.keys(granted).some(
      (permission) =>
        !(permission in expectedPermissions) ||
        granted[permission] !== expectedPermissions[permission],
    ) ||
    Object.entries(expectedPermissions).some(
      ([permission, access]) => granted[permission] !== access,
    )
  ) {
    throw new Error(
      "The GitHub App installation permissions do not match the approved least-privilege set.",
    );
  }
  const token = requiredString(installation.token, "installation token");
  return new GitHubRestClient(token, fetchImpl);
}

function repositoryPath(suffix: string): string {
  return `/repos/${SAYHEAR_REPOSITORY_NAME}${suffix}`;
}

function recordString(value: JsonRecord, key: string, label = key): string {
  return requiredString(value[key], label);
}

function recordNumber(value: JsonRecord, key: string, label = key): number {
  return requiredPositiveInteger(value[key], label);
}

export function isVercelDeploymentStatus(comment: GitHubComment): boolean {
  return comment.user.id === 35613825 && comment.user.login === "vercel[bot]" &&
    comment.user.type === "Bot" && isRecord(comment.performed_via_github_app) &&
    comment.performed_via_github_app.id === 8329 &&
    (comment.body ?? "").startsWith("[vc]: #");
}

export function digestDiscussion(
  comments: readonly GitHubComment[],
  reviews: readonly GitHubReview[],
  projection: RequirementProjection,
): string {
  const includedReviews = projection === "review-exclusive-v5" ? [] : reviews;
  const entries = [
    ...comments.map((comment) => ({
      id: comment.id,
      actor: comment.user.id,
      body: comment.body ?? "",
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    })),
    ...includedReviews.map((review) => ({
      id: review.id,
      actor: review.user.id,
      body: review.body ?? "",
      state: review.state,
      commit: review.commit_id,
    })),
  ].sort((left, right) => left.id - right.id);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function extractIssueReferences(title: string, body: string): number[] {
  const references = new Set<number>();
  const text = `${title}\n${body}`.replace(/https?:\/\/[^\s<>\)]+/g, (url) => {
    const match = url.match(/^https:\/\/github\.com\/lukemyself-hub\/SayHear\/issues\/([1-9]\d{0,8})(?:[?#].*)?$/i);
    if (match) references.add(Number(match[1]));
    return " ";
  }).replace(/(?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+#[1-9]\d{0,8}\b/g, (reference) => {
    const local = reference.match(/^lukemyself-hub\/SayHear#([1-9]\d{0,8})$/i);
    if (local) references.add(Number(local[1]));
    return " ";
  });
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9_])#([1-9]\d{0,8})\b/g)) {
    references.add(Number(match[1]));
  }
  return [...references].sort((left, right) => left - right);
}

function labelNames(issue: GitHubIssue): string[] {
  return issue.labels.map((label) =>
    typeof label === "string" ? label : recordString(label, "name"),
  );
}

function isTestResultPassed(value: unknown): boolean {
  if (!isRecord(value) || value.status !== "passed") return false;
  return (
    Array.isArray(value.assertionResults) &&
    value.assertionResults.length > 0 &&
    value.assertionResults.every(
      (assertion) => isRecord(assertion) && assertion.status === "passed",
    )
  );
}

function reportHasNoSkips(value: unknown): value is JsonRecord & {
  success: boolean;
  testResults: readonly JsonRecord[];
} {
  if (!isRecord(value) || value.success !== true ||
    !Array.isArray(value.testResults) || value.testResults.length === 0) {
    return false;
  }
  return value.testResults.every(isTestResultPassed);
}

function extractTestPaths(command: string): string[] {
  return [...command.matchAll(/(?:^|\s)(tests\/[^\s]+)/g)].map((match) =>
    match[1]!.replaceAll("\\", "/"),
  );
}

function reportCoversPaths(
  report: JsonRecord & { testResults: readonly JsonRecord[] },
  testPaths: readonly string[],
): boolean {
  if (testPaths.length === 0) return false;
  const resultsByPath = new Map<string, JsonRecord>();
  for (const result of report.testResults) {
    if (typeof result.name !== "string") continue;
    const markerIndex = result.name.lastIndexOf("tests/");
    if (markerIndex >= 0) {
      resultsByPath.set(result.name.slice(markerIndex), result);
    }
  }
  return testPaths.every((path) => {
    const result = resultsByPath.get(path);
    return result !== undefined && isTestResultPassed(result);
  });
}

function diffChangeDigest(
  diffText: string,
  files: readonly Readonly<{ path: string; status: string }>[],
): string {
  const changedLines = diffText
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("diff --git ") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        ((line.startsWith("+") || line.startsWith("-")) &&
          !line.startsWith("+++") &&
          !line.startsWith("---")),
    );
  return createHash("sha256")
    .update(JSON.stringify({ files, changedLines }))
    .digest("hex");
}

function extractZipEntry(
  archive: Uint8Array,
  expectedBasename: string,
): Uint8Array | null {
  const bytes = Buffer.from(archive);
  if (bytes.byteLength > MAX_ARTIFACT_ARCHIVE_BYTES) return null;
  const minOffset = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let index = bytes.length - 22; index >= minOffset; index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) {
      endOffset = index;
      break;
    }
  }
  if (endOffset < 0) return null;

  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  let cursor = centralOffset;
  let found: Buffer | null = null;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) return null;
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    if (name.split("/").at(-1) === expectedBasename) {
      if (found !== null) return null;
      if (uncompressedSize > 20_000_000) return null;
      if (bytes.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(
        dataOffset,
        dataOffset + compressedSize,
      );
      if (method === 0) found = Buffer.from(compressed);
      else if (method === 8) found = inflateRawSync(compressed);
      else return null;
      if (found.byteLength !== uncompressedSize) return null;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return found === null ? null : new Uint8Array(found);
}

async function readGraphql<T>(
  api: GitHubApi,
  query: string,
  variables: JsonRecord,
): Promise<T> {
  const response = await api.request<JsonRecord>("/graphql", {
    method: "POST",
    body: { query, variables },
  });
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    const messages = response.errors.map((error) =>
      isRecord(error) && typeof error.message === "string"
        ? cleanUserText(error.message).slice(0, 300) : "Unknown GraphQL error");
    throw new Error(`GitHub GraphQL did not return a complete snapshot: ${messages.join("; ")}`);
  }
  if (!isRecord(response.data)) {
    throw new Error("GitHub GraphQL returned no data.");
  }
  return response.data as T;
}

export async function readRepositoryMergeSettings(api: GitHubApi): Promise<JsonRecord> {
  const repository = await api.request<JsonRecord>(repositoryPath(""));
  const data = await readGraphql<{ repository?: JsonRecord }>(api,
    `query { repository(owner: "lukemyself-hub", name: "SayHear") {
      autoMergeAllowed mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    } }`, {});
  if (!isRecord(data.repository)) throw new Error("GitHub returned no repository merge settings.");
  const fields = {
    allow_auto_merge: "autoMergeAllowed",
    allow_merge_commit: "mergeCommitAllowed",
    allow_squash_merge: "squashMergeAllowed",
    allow_rebase_merge: "rebaseMergeAllowed",
  };
  // Installation-token REST responses can omit administrator-only settings.
  // GraphQL returns explicit booleans; missing settings must never be assumed.
  for (const [restField, graphqlField] of Object.entries(fields)) {
    const value = data.repository[graphqlField];
    if (typeof value !== "boolean") throw new Error("GitHub merge settings are incomplete.");
    repository[restField] = value;
  }
  return repository;
}

export async function readIssueDependencies(
  api: GitHubApi,
  issueNumber: number,
): Promise<number[] | null> {
  try {
    const data = await readGraphql<{
      repository?: {
        issue?: {
          blockedBy?: {
            nodes?: readonly { number?: number; state?: string }[];
            pageInfo?: { hasNextPage?: boolean };
          };
        } | null;
      } | null;
    }>(
      api,
      `query($owner:String!,$name:String!,$number:Int!){
        repository(owner:$owner,name:$name){
          issue(number:$number){
            blockedBy(first:100){nodes{number state} pageInfo{hasNextPage}}
          }
        }
      }`,
      {
        owner: "lukemyself-hub",
        name: "SayHear",
        number: issueNumber,
      },
    );
    const blockedBy = data.repository?.issue?.blockedBy;
    if (
      !Array.isArray(blockedBy?.nodes) ||
      blockedBy.pageInfo?.hasNextPage === true
    ) {
      return null;
    }
    return blockedBy.nodes.flatMap((node) => {
      if (node.state === "CLOSED") return [];
      return [requiredPositiveInteger(node.number, "blocked issue number")];
    });
  } catch {
    return null;
  }
}

/**
 * Issues GitHub would close natively when the PR merges: Development-sidebar
 * links and body keywords. Returns `null` when the set cannot be read whole.
 */
export async function readClosingIssueReferences(
  api: GitHubApi,
  pullNumber: number,
): Promise<number[] | null> {
  try {
    const data = await readGraphql<{
      repository?: {
        pullRequest?: {
          closingIssuesReferences?: {
            nodes?: readonly { number?: number }[];
            pageInfo?: { hasNextPage?: boolean };
          };
        } | null;
      } | null;
    }>(
      api,
      `query($owner:String!,$name:String!,$number:Int!){
        repository(owner:$owner,name:$name){
          pullRequest(number:$number){
            closingIssuesReferences(first:100){nodes{number} pageInfo{hasNextPage}}
          }
        }
      }`,
      { owner: "lukemyself-hub", name: "SayHear", number: pullNumber },
    );
    const references = data.repository?.pullRequest?.closingIssuesReferences;
    if (!references?.nodes || references.pageInfo?.hasNextPage !== false) return null;
    const numbers: number[] = [];
    for (const node of references.nodes) {
      if (typeof node.number !== "number" || !Number.isSafeInteger(node.number) || node.number <= 0) return null;
      numbers.push(node.number);
    }
    return numbers;
  } catch {
    return null;
  }
}

async function readReviewThreadState(
  api: GitHubApi,
  pullNumber: number,
  botLogin: string,
): Promise<boolean | null> {
  try {
    const data = await readGraphql<{
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: readonly {
              isResolved?: boolean;
              comments?: {
                nodes?: readonly { author?: { login?: string } | null }[];
                pageInfo?: { hasNextPage?: boolean };
              };
            }[];
            pageInfo?: { hasNextPage?: boolean };
          };
        } | null;
      } | null;
    }>(
      api,
      `query($owner:String!,$name:String!,$number:Int!){
        repository(owner:$owner,name:$name){
          pullRequest(number:$number){
            reviewThreads(first:100){
              nodes{
                isResolved
                comments(first:100){nodes{author{login}} pageInfo{hasNextPage}}
              }
              pageInfo{hasNextPage}
            }
          }
        }
      }`,
      { owner: "lukemyself-hub", name: "SayHear", number: pullNumber },
    );
    const threads = data.repository?.pullRequest?.reviewThreads;
    if (!threads?.nodes || threads.pageInfo?.hasNextPage) return null;
    for (const thread of threads.nodes) {
      if (thread.isResolved === true) continue;
      const comments = thread.comments;
      if (!comments?.nodes || comments.pageInfo?.hasNextPage) return null;
      if (comments.nodes.some((comment) => comment.author?.login !== botLogin)) {
        return true;
      }
    }
    return false;
  } catch {
    return null;
  }
}

/**
 * Whether GitHub exposes a merge queue for main. Querying the branch-specific
 * GraphQL field avoids treating the ruleset list summary as if it contained
 * each ruleset's rule details.
 */
export async function readMergeQueueAvailability(
  api: GitHubApi,
): Promise<boolean | null> {
  try {
    const data = await readGraphql<{
      repository?: { mergeQueue?: { id?: unknown } | null } | null;
    }>(
      api,
      `query { repository(owner: "lukemyself-hub", name: "SayHear") {
        mergeQueue(branch: "main") { id }
      } }`,
      {},
    );
    if (!isRecord(data.repository)) return null;
    const queue = data.repository.mergeQueue;
    if (queue === null) return false;
    return isRecord(queue) && typeof queue.id === "string" && queue.id.length > 0
      ? true
      : null;
  } catch {
    return null;
  }
}

export async function readBranchProtection(
  api: GitHubApi,
): Promise<PrReviewGateInput["branchProtection"]> {
  let protection: JsonRecord;
  try {
    protection = await api.request<JsonRecord>(
      repositoryPath("/branches/main/protection"),
    );
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return {
        readable: true,
        protected: false,
        branch: "main",
        requiresUpToDate: false,
        dismissesStaleReviews: false,
        enforcesAdmins: false,
        requiredApprovingReviews: 0,
        requiredChecks: [],
        bypassActorIds: [],
      };
    }
    return {
      readable: false,
      protected: false,
      branch: "main",
      requiresUpToDate: false,
      dismissesStaleReviews: false,
      enforcesAdmins: false,
      requiredApprovingReviews: 0,
      requiredChecks: [],
      bypassActorIds: [],
    };
  }

  const checks = isRecord(protection.required_status_checks)
    ? protection.required_status_checks
    : null;
  const reviewRules = isRecord(protection.required_pull_request_reviews)
    ? protection.required_pull_request_reviews
    : null;
  const contexts = Array.isArray(checks?.checks) ? checks.checks : [];
  const requiredChecks = contexts.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.context !== "string") return [];
    const configuredAppId =
      typeof entry.app_id === "number" && Number.isSafeInteger(entry.app_id)
        ? entry.app_id
        : null;
    return [{ name: entry.context, appId: configuredAppId }];
  });
  const enforceAdmins = isRecord(protection.enforce_admins)
    ? protection.enforce_admins.enabled === true
    : false;

  const rulesets = await readRulesetDetails(api);
  if (rulesets === null) {
    return {
      readable: false,
      protected: true,
      branch: "main",
      requiresUpToDate: checks?.strict === true,
      dismissesStaleReviews: reviewRules?.dismiss_stale_reviews === true,
      enforcesAdmins: enforceAdmins,
      requiredApprovingReviews:
        typeof reviewRules?.required_approving_review_count === "number"
          ? reviewRules.required_approving_review_count
          : 0,
      requiredChecks,
      bypassActorIds: [],
    };
  }
  const bypassActors = new Set<number>();
  let bypassReadable = true;
  for (const ruleset of rulesets) {
    if (!Array.isArray(ruleset.bypass_actors)) { bypassReadable = false; break; }
    for (const actor of ruleset.bypass_actors) {
      if (!isRecord(actor) || typeof actor.actor_id !== "number" || !Number.isSafeInteger(actor.actor_id) || actor.actor_id <= 0 ||
          typeof actor.actor_type !== "string" || !["Integration", "Team", "RepositoryRole", "OrganizationAdmin", "DeployKey"].includes(actor.actor_type) ||
          !["always", "pull_request", "exempt"].includes(String(actor.bypass_mode))) {
        bypassReadable = false;
        break;
      }
      bypassActors.add(actor.actor_id);
    }
  }
  const bypassActorIds = [...bypassActors].sort((left, right) => left - right);

  return {
    readable: bypassReadable,
    protected: true,
    branch: "main",
    requiresUpToDate: checks?.strict === true,
    dismissesStaleReviews: reviewRules?.dismiss_stale_reviews === true,
      enforcesAdmins: enforceAdmins,
    requiredApprovingReviews:
      typeof reviewRules?.required_approving_review_count === "number"
        ? reviewRules.required_approving_review_count
        : 0,
    requiredChecks,
    bypassActorIds,
  };
}

/**
 * Every repository ruleset that applies to SayHear, as detail records.
 *
 * `/repos/{owner}/{repo}/rulesets` answers with summaries only: it omits
 * `conditions`, `rules`, and `bypass_actors`, which are exactly the fields the
 * default-branch writer guard has to read. Each ruleset therefore needs its own
 * detail read, and a detail that cannot be read makes the whole result
 * unusable, because a ruleset that might cover main must never be skipped.
 *
 * Returns null when anything could not be read.
 */
async function readRulesetDetails(
  api: GitHubApi,
): Promise<JsonRecord[] | null> {
  let summaries: readonly JsonRecord[];
  try {
    summaries = await api.pages<JsonRecord>(
      repositoryPath("/rulesets?includes_parents=true"),
    );
  } catch {
    return null;
  }
  const details: JsonRecord[] = [];
  for (const summary of summaries) {
    if (!isRecord(summary)) return null;
    const id = summary.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      return null;
    }
    let detail: JsonRecord;
    try {
      detail = await api.request<JsonRecord>(
        repositoryPath(`/rulesets/${id}?includes_parents=true`),
      );
    } catch {
      return null;
    }
    if (!isRecord(detail) || detail.id !== id) return null;
    details.push(detail);
  }
  return details;
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  const text = JSON.stringify(value);
  if (typeof text !== "string") throw new Error("Ruleset detail is not JSON-serializable.");
  return text;
}

/**
 * Content fingerprint of one ruleset detail record.
 *
 * Only fields the App token can actually read enter the fingerprint: id,
 * enforcement, target, conditions, rules, and `updated_at`. GitHub bumps
 * `updated_at` on any ruleset mutation, including bypass list edits, so a
 * fingerprint taken at attestation time stops matching after any touch.
 * Array order is significant on purpose: a reordering the API actually
 * reports is treated as a change and fails closed.
 */
export function fingerprintRuleset(detail: JsonRecord): string {
  const id = detail.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Ruleset detail has no usable id.");
  }
  for (const key of ["enforcement", "target", "updated_at"] as const) {
    if (typeof detail[key] !== "string") {
      throw new Error(`Ruleset detail has no usable ${key}.`);
    }
  }
  if (!isRecord(detail.conditions) || !Array.isArray(detail.rules)) {
    throw new Error("Ruleset detail has no usable conditions or rules.");
  }
  return createHash("sha256")
    .update(
      stableStringify({
        id: detail.id,
        enforcement: detail.enforcement,
        target: detail.target,
        conditions: detail.conditions,
        rules: detail.rules,
        updatedAt: detail.updated_at,
      }),
    )
    .digest("hex");
}

function parseMainWriterAttestation(value: unknown): MainWriterAttestation {
  if (!isRecord(value)) throw new Error("Main writer attestation must be an object.");
  if (value.version !== MAIN_WRITER_ATTESTATION_VERSION) {
    throw new Error(
      `Main writer attestation version must be ${MAIN_WRITER_ATTESTATION_VERSION}.`,
    );
  }
  const fingerprint = value.rulesetFingerprint;
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error("Main writer attestation has no usable ruleset fingerprint.");
  }
  const asserted = value.assertedBypassAppIds;
  if (
    !Array.isArray(asserted) ||
    asserted.length === 0 ||
    asserted.some(
      (actorId) =>
        typeof actorId !== "number" || !Number.isSafeInteger(actorId) || actorId <= 0,
    )
  ) {
    throw new Error("Main writer attestation has no usable asserted bypass list.");
  }
  return {
    version: MAIN_WRITER_ATTESTATION_VERSION,
    rulesetId: requiredPositiveInteger(value.rulesetId, "rulesetId"),
    rulesetFingerprint: fingerprint,
    assertedBypassAppIds: [...asserted as readonly number[]].sort((left, right) => left - right),
    attestedAt: requiredString(value.attestedAt, "attestedAt"),
    attestedBy: requiredString(value.attestedBy, "attestedBy"),
  };
}

/**
 * The operator attestation backing the main writer guard, or null when the
 * operator never attested. A missing file is ordinary: without it the guard
 * simply needs live bypass enumeration to pass. A present but unreadable or
 * malformed file throws, the same fail-closed posture as the App config.
 */
async function readMainWriterAttestation(): Promise<MainWriterAttestation | null> {
  await assertTrustedDirectories();
  let raw: string;
  try {
    const [resolvedPath, fileInfo] = await Promise.all([
      realpath(ATTESTATION_PATH),
      stat(ATTESTATION_PATH),
    ]);
    if (
      resolvedPath !== ATTESTATION_PATH ||
      !fileInfo.isFile() ||
      fileInfo.uid !== 0 ||
      (fileInfo.mode & 0o022) !== 0
    ) {
      throw new Error(
        "Main writer attestation must be a root-owned, non-writable regular file.",
      );
    }
    raw = await readFile(ATTESTATION_PATH, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Main writer attestation is not valid JSON at ${ATTESTATION_PATH}.`);
  }
  return parseMainWriterAttestation(value);
}

/**
 * Who is allowed to update the default branch.
 *
 * `serialized-merge` merges a stale-base PR against whatever main is at the
 * moment of the merge request. GitHub recomputes that merge then, so the merge
 * itself cannot miss intervening commits, but nothing stops another writer from
 * advancing main between the controller's last read and its merge request. The
 * repository therefore has to prove that the approval App is the only actor
 * able to update main, and the rulesets are the only machine-readable statement
 * of that.
 *
 * Only an active branch ruleset that covers the default branch and carries an
 * `update` rule counts. Anything unreadable fails closed: the guard blocks
 * rather than assuming main is App-only.
 *
 * GitHub returns `bypass_actors` only to a caller with administration access, so
 * a ruleset that hides the bypass set is reported as unproven rather than as an
 * App-only main: an unreadable set never counts as an empty one.
 */
export async function readMainWriterGuard(
  api: GitHubApi,
  defaultBranch: string,
): Promise<NonNullable<PrReviewGateInput["runtime"]["mainWriterGuard"]>> {
  const unreadable = {
    readable: false,
    restrictsDefaultBranchUpdates: false,
    bypassActorIds: [],
    bypassActorsEnumerated: false,
    appBypassMode: null,
    rulesetIds: [],
  } as const;
  const rulesets = await readRulesetDetails(api);
  if (rulesets === null) return unreadable;
  const bypassActorIds = new Set<number>();
  const bypassModes = new Set<string>();
  const rulesetIds: number[] = [];
  const rulesetFingerprints: RulesetFingerprint[] = [];
  let restrictsDefaultBranchUpdates = false;
  let bypassActorsEnumerated = true;
  for (const ruleset of rulesets) {
    // Only an active branch ruleset that covers the default branch can restrict
    // who updates main; a tag ruleset or another branch is noise for this guard.
    if (ruleset.target !== "branch" || ruleset.enforcement !== "active") {
      continue;
    }
    // A branch ruleset whose conditions cannot be read might or might not cover
    // main, so it is never allowed to pass unnoticed.
    if (!isRecord(ruleset.conditions)) return unreadable;
    if (!rulesetCoversBranch(ruleset.conditions, defaultBranch)) {
      continue;
    }
    if (!Array.isArray(ruleset.rules)) return unreadable;
    if (!ruleset.rules.some((rule) => isRecord(rule) && rule.type === "update")) {
      continue;
    }
    const id = ruleset.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      return unreadable;
    }
    rulesetIds.push(id);
    restrictsDefaultBranchUpdates = true;
    try {
      rulesetFingerprints.push({ id, fingerprint: fingerprintRuleset(ruleset) });
    } catch {
      return unreadable;
    }
    // GitHub reports this even when it hides `bypass_actors`, so the guard can
    // still show whether the App itself is allowed through the restriction.
    if (typeof ruleset.current_user_can_bypass === "string") {
      bypassModes.add(ruleset.current_user_can_bypass);
    }
    if (!Array.isArray(ruleset.bypass_actors)) {
      bypassActorsEnumerated = false;
      continue;
    }
    for (const actor of ruleset.bypass_actors) {
      const actorId = isRecord(actor) ? actor.actor_id : null;
      if (typeof actorId !== "number" || !Number.isSafeInteger(actorId)) {
        return unreadable;
      }
      bypassActorIds.add(actorId);
    }
  }
  return {
    readable: true,
    restrictsDefaultBranchUpdates,
    bypassActorIds: [...bypassActorIds].sort((left, right) => left - right),
    bypassActorsEnumerated,
    appBypassMode: bypassModes.size === 1 ? [...bypassModes][0]! : null,
    rulesetIds,
    rulesetFingerprints,
  };
}

/**
 * Whether a ruleset's ref conditions cover the default branch.
 *
 * GitHub writes `~DEFAULT_BRANCH` for the default branch, but a ruleset may
 * also name `refs/heads/main` or a glob. A missing or empty include list never
 * counts, so an unreadable condition cannot pass as full coverage.
 */
function rulesetCoversBranch(
  conditions: JsonRecord,
  defaultBranch: string,
): boolean {
  const refName = conditions.ref_name;
  if (!isRecord(refName)) return false;
  const ref = `refs/heads/${defaultBranch}`;
  const include = Array.isArray(refName.include) ? refName.include : [];
  if (
    !include.some(
      (pattern) =>
        typeof pattern === "string" &&
        refConditionMatches(pattern, ref, defaultBranch),
    )
  ) {
    return false;
  }
  const exclude = Array.isArray(refName.exclude) ? refName.exclude : [];
  return !exclude.some(
    (pattern) =>
      typeof pattern === "string" &&
      refConditionMatches(pattern, ref, defaultBranch),
  );
}

function refConditionMatches(
  pattern: string,
  ref: string,
  defaultBranch: string,
): boolean {
  if (pattern === "~ALL") return true;
  if (pattern === "~DEFAULT_BRANCH") return ref === `refs/heads/${defaultBranch}`;
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  const matcher = new RegExp(`^${expression}$`);
  return matcher.test(ref) || matcher.test(ref.slice("refs/heads/".length));
}

async function createControllerConfig(
  config: GitHubAppConfig,
  api: GitHubRestClient,
): Promise<ControllerConfig> {
  const installation = await api.request<JsonRecord>(
    `/installation/repositories?per_page=100`,
  );
  if (!Array.isArray(installation.repositories)) {
    throw new Error("The GitHub App installation repositories could not be read.");
  }
  const installedRepos = installation.repositories as JsonRecord[];
  if (
    installedRepos.length !== 1 ||
    recordNumber(installedRepos[0]!, "id") !== SAYHEAR_REPOSITORY_ID
  ) {
    throw new Error(
      "The review App must be installed on SayHear alone.",
    );
  }

  const bot = await api.request<JsonRecord>(
    `/users/${encodeURIComponent(`${config.slug}[bot]`)}`,
  );
  const owner = await api.request<JsonRecord>("/users/lukemyself-hub");
  return {
    api,
    app: config,
    mainWriterAttestation: await readMainWriterAttestation(),
    policy: {
      repositoryId: SAYHEAR_REPOSITORY_ID,
      repositoryName: SAYHEAR_REPOSITORY_NAME,
      defaultBranch: "main",
      policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
      reviewAppId: config.appId,
      actionsAppId: ACTIONS_APP_ID,
      validateWorkflowBlobSha: null,
    },
    botActorId: recordNumber(bot, "id"),
    ownerActorId: recordNumber(owner, "id"),
  };
}

async function createRuntimeControllerConfig(): Promise<ControllerConfig> {
  const appConfig = await readLocalAppConfig();
  const api = await createApiClient(appConfig);
  const config = await createControllerConfig(appConfig, api);
  const privateKey = await readAppPrivateKey();
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  const storeDirectory = resolve(homedir(), "Library/Application Support/SayHear/PRApproval");
  return {
    ...config,
    integrationRefreshStore: new SignedIntegrationRefreshStore(resolve(storeDirectory, "integration-refresh"), privateKey, publicKey),
    completionStore: new SignedCompletionStore(resolve(storeDirectory, "completions"), privateKey, publicKey),
    browserApprovalStore: new SignedBrowserApprovalStore(resolve(storeDirectory, "browser-approvals"), privateKey, publicKey),
  };
}

export function parsePauseState(
  comments: readonly GitHubComment[],
  ownerActorId: number,
  botActorId: number,
): PrReviewGateInput["issues"][number]["pause"] {
  const events: Array<Readonly<{
    at: string;
    active: boolean;
    source: "maintainer" | "review-app";
  }>> = [];
  for (const comment of comments) {
    const body = comment.body ?? "";
    if (
      comment.user.id === ownerActorId &&
      /(?:^|\s)\/pause-pr-auto-approval(?:\s|$)/m.test(body)
    ) {
      events.push({
        at: comment.created_at,
        active: true,
        source: "maintainer",
      });
      continue;
    }
    if (
      comment.user.id === ownerActorId &&
      /(?:^|\s)\/resume-pr-auto-approval(?:\s|$)/m.test(body)
    ) {
      events.push({
        at: comment.created_at,
        active: false,
        source: "maintainer",
      });
      continue;
    }
    if (comment.user.id === botActorId && body.includes(PAUSE_MARKER)) {
      const active = /\bactive=(true|false)\b/.exec(body)?.[1] === "true";
      events.push({
        at: comment.created_at,
        active,
        source: "review-app",
      });
    }
  }
  events.sort((left, right) => left.at.localeCompare(right.at));
  const latest = events.at(-1);
  return latest
    ? { active: latest.active, source: latest.source }
    : { active: false, source: "none" };
}

export function parseRequestChangeHistory(
  comments: readonly GitHubComment[],
  pullNumber: number,
  botActorId: number,
): Readonly<{
  count: number;
  latestHeadSha: string | null;
  latestBaseSha: string | null;
  latestDiffDigest: string | null;
}> {
  const entries = comments.flatMap((comment) => {
    if (comment.user.id !== botActorId) return [];
    const marker = comment.body?.match(
      /<!-- sayhear-pr-auto-approval-review:v1 pr=(\d+) review=(\d+) head=([0-9a-f]{40}) base=([0-9a-f]{40}) round=(\d+) diff=([0-9a-f]{64}) outcome=request_changes -->/i,
    );
    if (!marker || Number(marker[1]) !== pullNumber) return [];
    return [
      {
        reviewId: Number(marker[2]),
        headSha: marker[3]!.toLowerCase(),
        baseSha: marker[4]!.toLowerCase(),
        round: Number(marker[5]),
        diffDigest: marker[6]!.toLowerCase(),
        createdAt: comment.created_at,
      },
    ];
  });
  entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const latest = entries.at(-1);
  return {
    count: latest?.round ?? 0,
    latestHeadSha: latest?.headSha ?? null,
    latestBaseSha: latest?.baseSha ?? null,
    latestDiffDigest: latest?.diffDigest ?? null,
  };
}

export function nextRequestChangeRound(
  history: ReturnType<typeof parseRequestChangeHistory>,
  diffDigest: string,
): number {
  if (
    history.latestDiffDigest === null ||
    history.latestDiffDigest === diffDigest.toLowerCase()
  ) {
    return history.count;
  }
  return history.count + 1;
}

function currentCheckSummary(
  gate: PrReviewGateReport,
  report: ModelReviewReport,
): Readonly<{ title: string; summary: string }> {
  const titleByOutcome: Record<PrReviewGateReport["outcome"], string> = {
    merge_candidate: "Review and evidence passed",
    merge_candidate_with_deferrals:
      "Review and evidence passed; some checks deferred",
    request_changes: "Changes required",
    awaiting_verification: "Evidence or state is incomplete",
    human_decision: "Human decision required",
  };
  const reasons = gate.reasons
    .map((reason) => `- **${reason.code}**: ${reason.message}`)
    .join("\n");
  const findings = report.findings
    .map(
      (finding) =>
        `- **${finding.severity}** \`${finding.file}:${finding.line}\`: ${finding.trigger}. ${finding.userImpact}.`,
    )
    .join("\n");
  return {
    title: titleByOutcome[gate.outcome],
    summary: [
      `PR #${report.pullRequestNumber} at \`${report.headSha}\`, base \`${report.baseSha}\`.`,
      "",
      reasons,
      ...(findings ? ["", "Review findings:", findings] : []),
    ].join("\n"),
  };
}

export async function resolveLinkedIssues(
  api: GitHubApi,
  pullRequest: GitHubPullRequest,
): Promise<GitHubIssue[]> {
  const references = extractIssueReferences(
    pullRequest.title,
    pullRequest.body ?? "",
  );
  const issues: GitHubIssue[] = [];
  for (const number of references) {
    const item = await api.request<JsonRecord>(
      repositoryPath(`/issues/${number}`),
    );
    if (!("pull_request" in item)) issues.push(item as GitHubIssue);
  }
  if (issues.length === 0) {
    throw new Error(
      "The PR must reference at least one Issue in SayHear.",
    );
  }
  return issues.sort((left, right) => left.number - right.number);
}

export async function readCurrentPullRequestMergeSha(
  api: GitHubApi,
  pullRequest: Pick<GitHubPullRequest, "number" | "base" | "head" | "merge_commit_sha">,
  currentMainSha = pullRequest.base.sha,
): Promise<string | null> {
  const expectedRef = `refs/pull/${pullRequest.number}/merge`;
  try {
    const reference = await api.request<JsonRecord>(
      repositoryPath(`/git/ref/pull/${pullRequest.number}/merge`),
    );
    const object = isRecord(reference.object) ? reference.object : null;
    if (
      reference.ref !== expectedRef ||
      !object ||
      object.type !== "commit"
    ) {
      return null;
    }
    const mergeSha = recordString(object, "sha", "PR merge ref SHA").toLowerCase();
    if (
      pullRequest.merge_commit_sha &&
      pullRequest.merge_commit_sha.toLowerCase() !== mergeSha
    ) {
      return null;
    }

    const commit = await api.request<JsonRecord>(
      repositoryPath(`/git/commits/${mergeSha}`),
    );
    if (!Array.isArray(commit.parents) || commit.parents.length !== 2) {
      return null;
    }
    const baseParent = commit.parents[0];
    const headParent = commit.parents[1];
    if (
      !isRecord(baseParent) ||
      !isRecord(headParent) ||
      typeof baseParent.sha !== "string" ||
      typeof headParent.sha !== "string" ||
      baseParent.sha.toLowerCase() !== currentMainSha.toLowerCase() ||
      headParent.sha.toLowerCase() !== pullRequest.head.sha.toLowerCase()
    ) {
      return null;
    }
    return mergeSha;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

async function readLatestWorkflowRun(
  api: GitHubApi,
  pullNumber: number,
  headSha: string,
): Promise<GitHubWorkflowRun | null> {
  // Resolve the run from GitHub Actions' check on this exact PR head. The
  // workflow-run list endpoint did not return the current PR run reliably.
  const checkRuns = await readCheckRunsForCommit(api, headSha);
  const actionsChecks = checkRuns
    .filter((check) => {
      const app = isRecord(check.app) ? check.app : null;
      return (
        check.name === "validate" &&
        app?.id === ACTIONS_APP_ID &&
        typeof check.head_sha === "string" &&
        check.head_sha.toLowerCase() === headSha.toLowerCase()
      );
    })
    .sort((left, right) => Number(right.id ?? 0) - Number(left.id ?? 0));
  if (actionsChecks.length === 0 && checkRuns.length > 0) {
    const visibleChecks = checkRuns
      .slice(0, 10)
      .map((check) => {
        const appId = isRecord(check.app) ? check.app.id : "unknown";
        return `${String(check.name ?? "unnamed")}@${String(appId)}`;
      })
      .join(", ");
    throw new Error(
      `The PR head has checks but no trusted Actions validate check (${visibleChecks}).`,
    );
  }
  let lastMismatch: string | null = null;

  for (const check of actionsChecks.slice(0, 1)) {
    const detailsUrl =
      typeof check.details_url === "string" ? check.details_url : null;
    if (!detailsUrl) continue;

    let runId: string | null = null;
    try {
      const url = new URL(detailsUrl);
      const repositoryPathname = `/${SAYHEAR_REPOSITORY_NAME}/actions/runs/`;
      if (
        url.origin === "https://github.com" &&
        url.pathname.startsWith(repositoryPathname)
      ) {
        const candidate = url.pathname
          .slice(repositoryPathname.length)
          .split("/")[0];
        runId = candidate && /^[1-9]\d*$/.test(candidate) ? candidate : null;
      }
    } catch {
      continue;
    }
    if (!runId) {
      lastMismatch = "The Actions validate check has no same-repository run URL.";
      continue;
    }

    const run = await api.request<GitHubWorkflowRun>(
      repositoryPath(`/actions/runs/${runId}`),
    );
    const runPull = run.pull_requests.find(
      (entry) => entry.number === pullNumber,
    );
    if (
      run.id === Number(runId) &&
      run.event === "pull_request" &&
      run.head_sha.toLowerCase() === headSha.toLowerCase() &&
      (run.path === PR_VALIDATE_WORKFLOW_PATH ||
        run.path.startsWith(`${PR_VALIDATE_WORKFLOW_PATH}@`)) &&
      runPull?.head.sha.toLowerCase() === headSha.toLowerCase()
    ) {
      return run;
    }
    lastMismatch = [
      "The Actions validate check links to run metadata that does not match this PR:",
      `runId=${run.id === Number(runId)}`,
      `event=${run.event}`,
      `workflow=${run.path}`,
      `headSha=${run.head_sha.toLowerCase() === headSha.toLowerCase()}`,
      `pullRequest=${runPull !== undefined}`,
      `pullRequestHead=${runPull?.head.sha.toLowerCase() === headSha.toLowerCase()}`,
    ].join(" ");
  }
  if (actionsChecks.length > 0) {
    throw new Error(
      lastMismatch ??
        "The Actions validate check exists but its run metadata could not be read safely.",
    );
  }
  return null;
}

async function readVitestReport(
  api: GitHubApi,
  runId: number,
  pullNumber: number,
): Promise<Readonly<{
  digest: string;
  report: JsonRecord;
  checkout: ValidatedCheckout | null;
}> | null> {
  try {
    const response = await api.request<JsonRecord>(
      repositoryPath(`/actions/runs/${runId}/artifacts?per_page=100`),
    );
    if (!Array.isArray(response.artifacts)) return null;
    const artifacts = response.artifacts as JsonRecord[];
    const artifact = artifacts.find(
      (entry) =>
        entry.name === `vitest-report-${pullNumber}` &&
        entry.expired !== true,
    );
    if (!artifact) return null;
    const artifactId = recordNumber(artifact, "id", "artifact id");
    const archive = await api.bytes(
      repositoryPath(`/actions/artifacts/${artifactId}/zip`),
    );
    const metadataDigest =
      typeof artifact.digest === "string"
        ? artifact.digest.replace(/^sha256:/, "").toLowerCase()
        : null;
    const archiveDigest = createHash("sha256").update(archive).digest("hex");
    if (!metadataDigest || metadataDigest !== archiveDigest) return null;
    const reportBytes = extractZipEntry(archive, "vitest-report.json");
    if (!reportBytes || reportBytes.byteLength > 20_000_000) return null;
    const digest = createHash("sha256").update(reportBytes).digest("hex");
    const report = JSON.parse(Buffer.from(reportBytes).toString("utf8")) as unknown;
    if (!isRecord(report)) return null;
    return {
      digest,
      report,
      checkout: parseValidatedCheckout(extractZipEntry(archive, "pr-validate-source.json")),
    };
  } catch {
    return null;
  }
}

type ValidatedCheckout = Readonly<{
  event: string;
  pullRequestNumber: number | null;
  headSha: string;
  baseSha: string;
  checkoutSha: string;
  parentShas: readonly string[] | null;
  runId: number | null;
  runAttempt: number | null;
}>;

// The receipt the Validate workflow writes to prove which merge ref it checked
// out. A missing or malformed receipt is not an error in itself: `up-to-date-base`
// never needed one, and the gate already requires base == main there. Only a
// head-bound mode consumes it, and it fails closed on `null` itself.
function parseValidatedCheckout(bytes: Uint8Array | null): ValidatedCheckout | null {
  if (!bytes || bytes.byteLength > 20_000) return null;
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    if (!isRecord(value)) return null;
    if (
      typeof value.event !== "string" ||
      (value.pullRequestNumber !== null &&
        (typeof value.pullRequestNumber !== "number" ||
          !Number.isSafeInteger(value.pullRequestNumber))) ||
      typeof value.headSha !== "string" ||
      typeof value.baseSha !== "string" ||
      typeof value.checkoutSha !== "string" ||
      !/^[0-9a-f]{40}$/i.test(value.headSha) ||
      !/^[0-9a-f]{40}$/i.test(value.baseSha) ||
      !/^[0-9a-f]{40}$/i.test(value.checkoutSha)
    ) return null;
    return {
      event: value.event,
      pullRequestNumber: value.pullRequestNumber,
      headSha: value.headSha.toLowerCase(),
      baseSha: value.baseSha.toLowerCase(),
      checkoutSha: value.checkoutSha.toLowerCase(),
      parentShas: Array.isArray(value.parentShas) && value.parentShas.length === 2 && value.parentShas.every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)) ? value.parentShas : null,
      runId: typeof value.runId === "number" && Number.isSafeInteger(value.runId) && value.runId > 0 ? value.runId : null,
      runAttempt: typeof value.runAttempt === "number" && Number.isSafeInteger(value.runAttempt) && value.runAttempt > 0 ? value.runAttempt : null,
    };
  } catch {
    return null;
  }
}

export async function collectEvidence(
  config: ControllerConfig,
  pullNumber: number,
  pullRequest: GitHubPullRequest,
  changedFiles: PrReviewGateInput["pullRequest"]["changedFiles"],
  impacts: readonly ReleaseImpactKind[],
  capability: PrReviewGateInput["review"]["capability"],
  mergeSha: string | null,
  baseSha: string,
  humanBinding: HumanReviewBinding = NO_HUMAN_BINDING,
): Promise<Readonly<{
  evidence: PrReviewGateInput["evidence"];
  trustedWorkflowBlobSha: string | null;
  workflowStatus: "queued" | "in_progress" | "completed" | "missing" | "unknown";
  workflowConclusion: string | null;
  staleIntegrationRunId: number | null;
}>> {
  const plan = planDailyReleaseValidation({
    version: DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
    change: {
      summary: `PR #${pullNumber} review`,
      declaredImpacts: impacts,
      changedPaths: changedFiles.map(({ path }) => path),
    },
    capability,
  });
  const requiredIds = [
    ...plan.fixedBaseline,
    ...plan.targeted,
    ...plan.reused,
  ].map(({ check }) => check.id);
  // The plan already carries ui:portal-smoke for Portal UI paths, so the gate
  // and the evidence collector read the same path rule from one place.

  // GitHub can omit merge_commit_sha on an open PR. Without a verified merge
  // ref, the workflow evidence below cannot prove an integrated checkout.
  const fallbackMergeSha = mergeSha ?? pullRequest.head.sha;
  const source = {
    repositoryId: SAYHEAR_REPOSITORY_ID,
    appId: ACTIONS_APP_ID,
    event: "pull_request",
    workflowPath: PR_VALIDATE_WORKFLOW_PATH,
    workflowBlobSha:
      config.policy.validateWorkflowBlobSha ?? "0".repeat(40),
    runId: 1,
    runAttempt: 1,
    headSha: pullRequest.head.sha,
    baseSha,
    mergeSha: fallbackMergeSha,
  };

  if (!mergeSha) {
    return {
      evidence: [...new Set(requiredIds)].map((checkId) => ({
        checkId,
        result: "skipped",
        source,
        artifactSha256: null,
        coveredCheckIds: [],
      })),
      trustedWorkflowBlobSha: null,
      workflowStatus: "unknown",
      workflowConclusion: null,
      staleIntegrationRunId: null,
    };
  }

  const run = await readLatestWorkflowRun(
    config.api,
    pullNumber,
    pullRequest.head.sha,
  );
  if (!run) {
    return {
      evidence: [...new Set(requiredIds)].map((checkId) => ({
        checkId,
        result: "skipped",
        source,
        artifactSha256: null,
        coveredCheckIds: [],
      })),
      trustedWorkflowBlobSha: null,
      workflowStatus: "missing",
      workflowConclusion: null,
      staleIntegrationRunId: null,
    };
  }

  // pull_request checks are attached to the PR head while default checkout tests the merge ref.
  const checkRuns = await readCheckRunsForCommit(
    config.api,
    pullRequest.head.sha,
  );
  const actionsCheck = checkRuns.find((check) => {
    const app = isRecord(check.app) ? check.app : null;
    const detailsUrl =
      typeof check.details_url === "string" ? check.details_url : "";
    return (
      check.name === "validate" &&
      app?.id === ACTIONS_APP_ID &&
      new RegExp(`^https://github\\.com/${SAYHEAR_REPOSITORY_NAME}/actions/runs/${run.id}(?:/|$)`).test(detailsUrl)
    );
  });
  const runPull = run.pull_requests.find((entry) => entry.number === pullNumber);
  const serialized = parseIntegrationMode(config.app.integrationMode) === "serialized-merge";
  const workflowSourceValid =
    (serialized ? runPull !== undefined : runPull?.base.sha === baseSha) &&
    runPull?.head.sha === pullRequest.head.sha &&
    run.head_sha === pullRequest.head.sha &&
    (run.path === PR_VALIDATE_WORKFLOW_PATH ||
      run.path.startsWith(`${PR_VALIDATE_WORKFLOW_PATH}@`)) &&
    actionsCheck !== undefined &&
    actionsCheck.head_sha === pullRequest.head.sha &&
    actionsCheck.status === "completed" &&
    actionsCheck.conclusion === "success";

  let mainWorkflowSha: string | null = null;
  let mergeWorkflowSha: string | null = null;
  try {
    const [mainFile, mergeFile] = await Promise.all([
      config.api.request<JsonRecord>(
        repositoryPath(
          `/contents/${PR_VALIDATE_WORKFLOW_PATH}?ref=${encodeURIComponent(baseSha)}`,
        ),
      ),
      config.api.request<JsonRecord>(
        repositoryPath(
          `/contents/${PR_VALIDATE_WORKFLOW_PATH}?ref=${encodeURIComponent(fallbackMergeSha)}`,
        ),
      ),
    ]);
    mainWorkflowSha =
      typeof mainFile.sha === "string" ? mainFile.sha.toLowerCase() : null;
    mergeWorkflowSha =
      typeof mergeFile.sha === "string" ? mergeFile.sha.toLowerCase() : null;
  } catch {
    mainWorkflowSha = null;
    mergeWorkflowSha = null;
  }
  const trustedWorkflow =
    workflowSourceValid &&
    isTrustedWorkflowVersion(mainWorkflowSha, mergeWorkflowSha, humanBinding.validateWorkflowBlobSha);
  const testArtifact = await readVitestReport(
    config.api,
    run.id,
    pullNumber,
  );
  // A head-bound mode may merge a base that moved after the review, so only
  // there must the accepted artifact prove it ran on the current merge ref. In
  // `up-to-date-base` the gate already requires base == main, and demanding a
  // receipt would fail every PR until the recording workflow lands on main.
  const headBoundIntegration =
    parseIntegrationMode(config.app.integrationMode) !== "up-to-date-base";
  const checkout = testArtifact?.checkout ?? null;
  const checkoutMatchesMergeRef =
    checkout !== null &&
    checkout.event === "pull_request" &&
    checkout.pullRequestNumber === pullNumber &&
    checkout.headSha === pullRequest.head.sha.toLowerCase() &&
    (serialized
      ? checkout.parentShas?.[0] === baseSha.toLowerCase() && checkout.parentShas[1] === pullRequest.head.sha.toLowerCase() &&
        checkout.runId === run.id && checkout.runAttempt === run.run_attempt
      : checkout.baseSha === baseSha.toLowerCase()) &&
    checkout.checkoutSha === mergeSha?.toLowerCase();
  const validReport =
    testArtifact !== null &&
    reportHasNoSkips(testArtifact.report) &&
    (!headBoundIntegration || checkoutMatchesMergeRef);

  const evidenceSource = {
    ...source,
    workflowBlobSha: mergeWorkflowSha ?? source.workflowBlobSha,
    runId: run.id,
    runAttempt: run.run_attempt,
  };
  const uniqueIds = [...new Set(requiredIds)];
  const evidence = uniqueIds.map((checkId) => {
    const fixed = (FIXED_PR_CI_BASELINE as readonly string[]).includes(checkId);
    const check = RELEASE_CHECKS.find((item) => item.id === checkId);
    const testPaths = check ? extractTestPaths(check.command) : [];
    const targetedPassed =
      validReport &&
      testArtifact !== null &&
      reportCoversPaths(testArtifact.report, testPaths);
    const passed =
      trustedWorkflow &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      (headBoundIntegration
        ? validReport
        : checkId !== "baseline:test" || validReport) &&
      (fixed || targetedPassed);
    const policy = preMergeDeferralFor(checkId);
    if (!passed && policy !== null) {
      return { kind: "deferred-before-merge" as const, checkId, policy };
    }
    return {
      checkId,
      result: passed
        ? ("passed" as const)
        : run.status === "in_progress" || run.status === "queued"
          ? ("planned" as const)
          : ("failed" as const),
      source: evidenceSource,
      artifactSha256:
        !fixed && targetedPassed && testArtifact ? testArtifact.digest : null,
      coveredCheckIds:
        !fixed && targetedPassed ? [checkId] : [],
    };
  });
  let staleIntegrationRunId: number | null = null;
  if (serialized && checkout && run.status === "completed" &&
      ["success", "failure", "cancelled", "timed_out", "action_required"].includes(run.conclusion ?? "") &&
      actionsCheck?.status === "completed" && checkout.event === "pull_request" && checkout.pullRequestNumber === pullNumber &&
      checkout.headSha === pullRequest.head.sha.toLowerCase() && checkout.runId === run.id && checkout.runAttempt === run.run_attempt &&
      checkout.parentShas?.[1] === pullRequest.head.sha.toLowerCase() && checkout.parentShas[0] !== baseSha.toLowerCase() &&
      checkout.checkoutSha !== mergeSha.toLowerCase() && runPull?.head.sha === pullRequest.head.sha) {
    try {
      const oldCommit = await config.api.request<JsonRecord>(repositoryPath(`/git/commits/${checkout.checkoutSha}`));
      const oldWorkflow = await config.api.request<JsonRecord>(repositoryPath(`/contents/${PR_VALIDATE_WORKFLOW_PATH}?ref=${checkout.checkoutSha}`));
      const oldBaseWorkflow = await config.api.request<JsonRecord>(repositoryPath(`/contents/${PR_VALIDATE_WORKFLOW_PATH}?ref=${checkout.parentShas[0]}`));
      if (oldCommit.sha === checkout.checkoutSha && Array.isArray(oldCommit.parents) && oldCommit.parents.length === 2 &&
          oldCommit.parents.every((parent, index) => isRecord(parent) && parent.sha === checkout.parentShas?.[index]) &&
          isTrustedWorkflowVersion(typeof oldBaseWorkflow.sha === "string" ? oldBaseWorkflow.sha : null,
            typeof oldWorkflow.sha === "string" ? oldWorkflow.sha : null, humanBinding.validateWorkflowBlobSha)) staleIntegrationRunId = run.id;
    } catch { /* Incomplete old provenance remains a wait, never a dispatch. */ }
  }
  return {
    staleIntegrationRunId,
    evidence,
    trustedWorkflowBlobSha: trustedWorkflow ? mergeWorkflowSha : null,
    workflowStatus:
      run.status === "queued" || run.status === "in_progress"
        ? run.status
        : run.status === "completed"
          ? "completed"
          : "unknown",
    workflowConclusion: run.conclusion,
  };
}

type Snapshot = Readonly<{
  baseReviewSafe?: boolean;
  staleIntegrationRunId: number | null;
  changedPaths: readonly string[];
  humanBinding: HumanReviewBinding;
  browserChallenge: BrowserChallenge | null;
  gateInput: Omit<PrReviewGateInput, "review" | "evidence">;
  evidence: PrReviewGateInput["evidence"];
  trustedWorkflowBlobSha: string | null;
  workflowStatus: "queued" | "in_progress" | "completed" | "missing" | "unknown";
  workflowConclusion: string | null;
  diff: CollectedPrDiff & Readonly<{ changeDigest: string }>;
}>;

export async function baseReviewRiskSafe(
  api: GitHubApi,
  reviewedBase: string,
  currentMain: string,
  changedPaths: readonly string[],
): Promise<boolean> {
  if (![reviewedBase, currentMain].every((sha) => /^[a-f0-9]{40}$/.test(sha))) return false;
  if (reviewedBase === currentMain) return true;
  try {
    const comparison = await api.request<JsonRecord>(repositoryPath(`/compare/${reviewedBase}...${currentMain}`));
    const lastCommit = Array.isArray(comparison.commits) ? comparison.commits.at(-1) : null;
    if (!isRecord(comparison.base_commit) || comparison.base_commit.sha !== reviewedBase ||
        !isRecord(comparison.merge_base_commit) || comparison.merge_base_commit.sha !== reviewedBase ||
        comparison.status !== "ahead" || !Array.isArray(comparison.commits) ||
        comparison.commits.length === 0 || comparison.commits.length >= 250 ||
        comparison.total_commits !== comparison.commits.length ||
        !isRecord(lastCommit) || lastCommit.sha !== currentMain ||
        !Array.isArray(comparison.files) || comparison.files.length >= 300) return false;
    const proposed = new Set(changedPaths);
    const highRisk = /(?:^|\/)(?:\.github|migrations?|schema|schemas|shared|contracts?|types|providers?|auth|authentication|authorization|security|permissions?|capabilities|feature-flags|polic(?:y|ies)|pr-approval)(?:\/|[.-])|(?:^|\/)(?:package\.json|[^/]*lock[^/]*|tsconfig[^/]*|[^/]*config\.[^/]+|AGENTS\.md|CLAUDE\.md)|^scripts\/pr-review-gate\.ts$|^docs\/(?:adr|architecture|product|agents)\//i;
    return comparison.files.every((file) => {
      if (!isRecord(file) || typeof file.filename !== "string" ||
          !["added", "modified", "removed", "renamed", "copied"].includes(String(file.status)) ||
          ((file.status === "renamed" || file.status === "copied") && typeof file.previous_filename !== "string")) return false;
      const paths = [file.filename, ...(typeof file.previous_filename === "string" ? [file.previous_filename] : [])];
      return paths.every((path) => path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..") &&
        !proposed.has(path) && !highRisk.test(path));
    });
  } catch {
    return false;
  }
}

async function withReviewSafety(config: ControllerConfig, snapshot: Snapshot, report: ModelReviewReport): Promise<Snapshot> {
  if (integrationModeOf(snapshot.gateInput) !== "serialized-merge") return snapshot;
  return { ...snapshot, baseReviewSafe: await baseReviewRiskSafe(config.api, report.baseSha,
    snapshot.gateInput.repository.defaultBranchSha, snapshot.changedPaths) };
}

async function readHeadWorkflowBlob(api: GitHubApi, headSha: string): Promise<string> {
  const file = await api.request<JsonRecord>(
    repositoryPath(`/contents/${PR_VALIDATE_WORKFLOW_PATH}?ref=${encodeURIComponent(headSha)}`),
  );
  if (typeof file.sha !== "string" || !/^[a-f0-9]{40}$/i.test(file.sha)) {
    throw new Error("The head candidate Validate workflow blob is unavailable.");
  }
  return file.sha.toLowerCase();
}

export async function readHumanBinding(
  config: ControllerConfig,
  input: Readonly<{
    pullRequest: GitHubPullRequest;
    number: number;
    repositoryNodeId: string | null;
    reviews: readonly GitHubReview[];
    diffDigest: string;
    diffComplete: boolean;
    changedFiles: PrReviewGateInput["pullRequest"]["changedFiles"];
    requirement: string;
    headSha: string;
    freeze: boolean;
    now?: number;
    currentMainSha?: string;
    changedPaths?: readonly string[];
  }>,
): Promise<HumanReviewBinding> {
  const channel = authorizationChannel(input.pullRequest.user);
  if (channel === "legacy-root") {
    const record = matchHumanReviewAuthorization(config.app.humanReviewAuthorizations ?? [], {
      pullRequestNumber: input.number, diffDigest: input.diffDigest, requirementDigest: input.requirement, diffComplete: input.diffComplete,
    });
    const serialized = parseIntegrationMode(config.app.integrationMode) === "serialized-merge";
    const eligible = record !== null && (!serialized || (record.approvedHeadSha === input.headSha && record.approvedBaseSha !== undefined &&
      await baseReviewRiskSafe(config.api, record.approvedBaseSha, input.currentMainSha ?? input.pullRequest.base.sha,
        input.changedPaths ?? input.changedFiles.map((file) => file.path))));
    return record === null || !eligible
      ? { ...NO_HUMAN_BINDING, channel: "legacy-root" }
      : { channel: "legacy-root", paths: record.paths, noRuntimeImpact: record.noRuntimeImpact === true, validateWorkflowBlobSha: record.validateWorkflowBlobSha, receipt: null, challenge: null };
  }
  if (channel === "unknown") return NO_HUMAN_BINDING;
  if (!config.browserApprovalStore) throw new Error("browser_approval_store_unavailable");
  if (input.repositoryNodeId === null) throw new Error("browser_repository_identity_unavailable");
  const serialized = parseIntegrationMode(config.app.integrationMode) === "serialized-merge";
  const currentMain = input.currentMainSha ?? input.pullRequest.base.sha.toLowerCase();
  const previous = await config.browserApprovalStore.read(input.number);
  if (serialized && previous?.challenge && !await baseReviewRiskSafe(config.api,
      previous.challenge.context.baseSha, currentMain, input.changedPaths ?? input.changedFiles.map((file) => file.path))) {
    await readBrowserAuthorization(config.browserApprovalStore, input.number, null, input.reviews, false, input.now);
  }
  const context = {
    ...(serialized ? { reviewBinding: "head-v2" as const } : {}),
    repositoryId: SAYHEAR_REPOSITORY_ID, repositoryNodeId: input.repositoryNodeId,
    pullRequestNumber: input.number, pullRequestNodeId: recordString(input.pullRequest, "node_id"),
    author: AGENT_IDENTITY,
    reviewer: LUKE_IDENTITY,
    headSha: input.headSha, baseSha: serialized ? currentMain : input.pullRequest.base.sha.toLowerCase(),
    diffDigest: input.diffDigest, requirementDigest: input.requirement,
    protectedPaths: [...protectedReviewPaths(input.changedFiles)],
    validateWorkflowBlobSha: await readHeadWorkflowBlob(config.api, input.headSha),
  };
  const authorization = await readBrowserAuthorization(
    config.browserApprovalStore, input.number, context, input.reviews, input.freeze, input.now ?? Date.now(),
  );
  if (!authorization.receipt) return { channel: "browser", paths: [], noRuntimeImpact: false, validateWorkflowBlobSha: null, receipt: null, challenge: authorization.challenge };
  // Browser channel keeps noRuntimeImpact false. The approval binds exact paths
  // and the reviewed workflow blob only; it never classifies product risk.
  return {
    channel: "browser",
    paths: authorization.receipt.challenge.context.protectedPaths,
    noRuntimeImpact: false,
    validateWorkflowBlobSha: authorization.receipt.challenge.context.validateWorkflowBlobSha,
    receipt: authorization.receipt,
    challenge: authorization.receipt.challenge,
  };
}

export async function readSnapshot(
  config: ControllerConfig,
  pullNumber: number,
  impacts: readonly ReleaseImpactKind[] = [],
  capability: PrReviewGateInput["review"]["capability"] = {
    newCapabilityEnabled: false,
    majorContractChange: false,
    externalMvpRelease: false,
  },
  options: Readonly<{ freezeBrowserChallenge?: boolean }> = {},
): Promise<Snapshot> {
  const integrationMode = parseIntegrationMode(config.app.integrationMode);
  const [
    repository,
    pullRequest,
    protection,
    refs,
    openPullRequests,
    mergeQueueAvailable,
    mainWriterGuard,
  ] = await Promise.all([
      readRepositoryMergeSettings(config.api),
      config.api.request<GitHubPullRequest>(
        repositoryPath(`/pulls/${pullNumber}`),
      ),
      readBranchProtection(config.api),
      config.api.request<JsonRecord>(
        repositoryPath("/git/ref/heads/main"),
      ),
      config.api.pages<GitHubPullRequest>(
        repositoryPath("/pulls?state=open"),
      ),
      integrationMode === "merge-queue"
        ? readMergeQueueAvailability(config.api)
        : Promise.resolve(null),
      integrationMode === "serialized-merge"
        ? readMainWriterGuard(config.api, "main")
        : Promise.resolve(null),
    ]);
  const mainWriterAttestation = config.mainWriterAttestation ?? null;
  if (recordNumber(repository, "id") !== SAYHEAR_REPOSITORY_ID) {
    throw new Error("The GitHub App returned a different repository.");
  }
  const defaultBranch = recordString(repository, "default_branch");
  const defaultBranchSha = isRecord(refs.object)
    ? recordString(refs.object, "sha", "main ref SHA").toLowerCase()
    : null;
  if (!defaultBranchSha) throw new Error("The current main SHA is unavailable.");

  const [issues, mergeSha] = await Promise.all([
    resolveLinkedIssues(config.api, pullRequest),
    readCurrentPullRequestMergeSha(config.api, pullRequest, defaultBranchSha),
  ]);
  const [
    fileManifest,
    commits,
    issueContexts,
    prComments,
    reviewComments,
    reviews,
    hasHumanReviewThread,
    graphClosingIssueNumbers,
  ] = await Promise.all([
    readPullRequestFileManifest(config.api, pullNumber),
    config.api.pages<JsonRecord>(
      repositoryPath(`/pulls/${pullNumber}/commits`),
    ),
    Promise.all(issues.map(async (issue) => {
      const [comments, blockedBy] = await Promise.all([
        config.api.pages<GitHubComment>(repositoryPath(`/issues/${issue.number}/comments`)),
        readIssueDependencies(config.api, issue.number),
      ]);
      return { issue, comments, blockedBy };
    })),
    config.api.pages<GitHubComment>(
      repositoryPath(`/issues/${pullNumber}/comments`),
    ),
    config.api.pages<GitHubComment>(
      repositoryPath(`/pulls/${pullNumber}/comments`),
    ),
    config.api.pages<GitHubReview>(
      repositoryPath(`/pulls/${pullNumber}/reviews`),
    ),
    readReviewThreadState(
      config.api,
      pullNumber,
      `${config.app.slug}[bot]`,
    ),
    readClosingIssueReferences(config.api, pullNumber),
  ]);

  const changedFileRecords = fileManifest.files;
  const latestCommit = commits.at(-1);
  const latestCommitAuthor =
    latestCommit && isRecord(latestCommit.author) ? latestCommit.author : null;
  const latestCommitCommitter =
    latestCommit && isRecord(latestCommit.committer)
      ? latestCommit.committer
      : null;
  const lastCommitAuthorId =
    (latestCommitAuthor &&
    typeof latestCommitAuthor.id === "number" &&
    latestCommitAuthor.id > 0
      ? latestCommitAuthor.id
      : null) ??
    (latestCommitCommitter &&
    typeof latestCommitCommitter.id === "number" &&
    latestCommitCommitter.id > 0
      ? latestCommitCommitter.id
      : null);

  const relevantExternalChangesRequest = reviews.some(
    (review) =>
      review.user.id !== config.botActorId &&
      review.state === "CHANGES_REQUESTED" &&
      review.commit_id.toLowerCase() === pullRequest.head.sha.toLowerCase(),
  );
  const externalReviewState =
    hasHumanReviewThread === null
      ? "unavailable"
      : relevantExternalChangesRequest || hasHumanReviewThread
        ? "needs-human"
        : "clear";

  const changedFiles = changedFileRecords.flatMap((file) => {
    if (
      typeof file.filename !== "string" ||
      (file.status !== "added" &&
        file.status !== "modified" &&
        file.status !== "removed" &&
        file.status !== "renamed" &&
        file.status !== "copied")
    ) {
      return [];
    }
    return [
      {
        path: file.filename,
        status: file.status as PrReviewGateInput["pullRequest"]["changedFiles"][number]["status"],
      },
    ];
  });
  const diffResult = await collectPullRequestDiff(config.api, {
    number: pullNumber,
    headSha: pullRequest.head.sha.toLowerCase(),
    baseSha: pullRequest.base.sha.toLowerCase(),
    changedFiles: pullRequest.changed_files,
  }, changedFileRecords, resolve(REVIEW_ARTIFACT_DIRECTORY, "git-blobs"));
  const collectedDiff = fileManifest.error === null ? diffResult : { ...diffResult, reason: `GitHub file manifest unavailable: ${fileManifest.error}` };
  const diffComplete = collectedDiff.complete;
  const diffDigest = collectedDiff.digest;

  const requirementProjection = requirementProjectionFor(PR_REVIEW_GATE_POLICY_VERSION);
  const prDiscussionDigest = digestDiscussion(
    [...prComments, ...reviewComments].filter(
      (comment) => comment.user.id !== config.botActorId && !isVercelDeploymentStatus(comment),
    ),
    reviews.filter((review) => review.user.id !== config.botActorId),
    requirementProjection,
  );
  const currentPullRequests = openPullRequests.filter(
    (candidate) =>
      candidate.number !== pullNumber &&
      candidate.base.ref === "main" &&
      (integrationMode === "serialized-merge" ? candidate.auto_merge !== null : isRecord(candidate.auto_merge)),
  );
  const linkedNumbers = issues.map((issue) => issue.number);
  const normalizedIssues: PrReviewGateInput["issues"] = issueContexts.map(({ issue, comments, blockedBy }) => ({
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body ?? "",
    updatedAt: issue.updated_at,
    discussionDigest: digestDiscussion(comments.filter((comment) => comment.user.id !== config.botActorId), [], requirementProjection),
    labels: labelNames(issue),
    blockedBy,
    pause: parsePauseState([...comments, ...prComments], config.ownerActorId, config.botActorId),
  }));
  const issueClosure = parseIssueClosureExclusions(pullRequest.title, pullRequest.body ?? "");
  // Commit messages close Issues too once they land on main. The commits
  // endpoint stops at 250 entries, so a full page means the set is unknown.
  const closingIssueNumbers =
    graphClosingIssueNumbers === null || commits.length >= 250 ||
    commits.some((commit) => !isRecord(commit.commit) || typeof commit.commit.message !== "string")
      ? null
      : [...new Set([
          ...graphClosingIssueNumbers,
          ...commits.flatMap((commit) =>
            isRecord(commit.commit) && typeof commit.commit.message === "string"
              ? closingKeywordIssueNumbers(commit.commit.message)
              : []),
        ])].sort((left, right) => left - right);
  const normalizedPullRequest: PrReviewGateInput["pullRequest"] = {
    number: pullRequest.number,
    state: pullRequest.state,
    draft: pullRequest.draft,
    title: pullRequest.title,
    body: pullRequest.body ?? "",
    updatedAt: pullRequest.updated_at,
    discussionDigest: prDiscussionDigest,
    externalReviewState,
    headSha: pullRequest.head.sha.toLowerCase(),
    baseSha: pullRequest.base.sha.toLowerCase(),
    mergeSha,
    mergeable: pullRequest.mergeable ?? null,
    mergeableState: pullRequest.mergeable_state ?? null,
    baseRef: pullRequest.base.ref,
    headRepositoryId:
      pullRequest.head.repo === null ? null : pullRequest.head.repo.id,
    authorId: pullRequest.user.id,
    lastCommitAuthorId,
    linkedIssueNumbers: linkedNumbers,
    keepOpenIssueNumbers: issueClosure.keepOpenIssueNumbers,
    issueClosureAmbiguous: issueClosure.ambiguous,
    closingIssueNumbers,
    changedFiles,
  };
  const normalizedRepository: PrReviewGateInput["repository"] = {
    id: recordNumber(repository, "id"),
    fullName: recordString(repository, "full_name"),
    defaultBranch,
    defaultBranchSha,
    allowAutoMerge: repository.allow_auto_merge === true,
  };
  const humanBinding = await readHumanBinding(config, {
    pullRequest,
    number: pullNumber,
    repositoryNodeId: typeof repository.node_id === "string" ? repository.node_id : null,
    reviews,
    diffDigest,
    diffComplete,
    changedFiles,
    requirement: requirementDigest(normalizedIssues, normalizedPullRequest),
    headSha: normalizedPullRequest.headSha,
    currentMainSha: defaultBranchSha,
    changedPaths: changedFileRecords.flatMap((file) => typeof file.filename === "string" ? [file.filename, ...(typeof file.previous_filename === "string" ? [file.previous_filename] : [])] : []),
    freeze: options.freezeBrowserChallenge === true,
  });
  const collected = await collectEvidence(
    config,
    pullNumber,
    pullRequest,
    changedFiles,
    impacts,
    capability,
    normalizedPullRequest.mergeSha,
    integrationMode === "serialized-merge" ? defaultBranchSha : normalizedPullRequest.baseSha,
    humanBinding,
  );
  return {
    staleIntegrationRunId: collected.staleIntegrationRunId,
    changedPaths: changedFileRecords.flatMap((file) => typeof file.filename === "string" ? [file.filename, ...(typeof file.previous_filename === "string" ? [file.previous_filename] : [])] : []),
    humanBinding,
    browserChallenge: humanBinding.challenge,
    gateInput: {
      repository: normalizedRepository,
      pullRequest: normalizedPullRequest,
      issues: normalizedIssues,
      branchProtection: protection,
      runtime: {
        reviewAppInstalledForRepository: true,
        // The merge queue serializes the merges themselves, so a PR waiting
        // behind another one is not a conflict: approvals may overlap. Only the
        // pinned-merge path has to keep one PR in flight at a time.
        anotherApprovalInFlight: anotherApprovalInFlightFor(
          integrationMode,
          currentPullRequests.length,
        ),
        productionMergeAuthorized: config.app.productionMergeAuthorized,
        ordinaryMergeTriggersProduction:
          config.app.ordinaryMergeTriggersProduction,
        integrationMode,
        mergeQueueAvailable,
        mainWriterGuard,
        ...(mainWriterAttestation === null ? {} : { mainWriterAttestation }),
      },
    },
    evidence: collected.evidence,
    trustedWorkflowBlobSha: collected.trustedWorkflowBlobSha,
    workflowStatus: collected.workflowStatus,
    workflowConclusion: collected.workflowConclusion,
    diff: {
      ...collectedDiff,
      changeDigest: collectedDiff.source === "github-blobs"
        ? collectedDiff.digest : diffChangeDigest(collectedDiff.text, changedFiles),
    },
  };
}

function createModelReviewInput(
  config: ControllerConfig,
  snapshot: Snapshot,
  report: ModelReviewReport,
): PrReviewGateInput {
  return {
    ...snapshot.gateInput,
    evidence: snapshot.evidence,
    review: {
      version: report.version,
      repositoryId: report.repositoryId,
      pullRequestNumber: report.pullRequestNumber,
      headSha: report.headSha,
      baseSha: report.baseSha,
      baseReviewSafe: report.baseSha === snapshot.gateInput.repository.defaultBranchSha || snapshot.baseReviewSafe === true,
      policyVersion: report.policyVersion,
      requirementDigest: report.requirementDigest,
      decision: report.decision,
      diffComplete: report.diffComplete && snapshot.diff.complete,
      reviewerAppId: config.app.appId,
      reviewerActorId: config.botActorId,
      declaredImpacts: report.declaredImpacts,
      capability: report.capability,
      riskFlags: report.riskFlags,
      findings: report.findings,
    },
  };
}

function evaluateSnapshot(
  config: ControllerConfig,
  snapshot: Snapshot,
  report: ModelReviewReport,
): Readonly<{ input: PrReviewGateInput; gate: PrReviewGateReport }> {
  const input = parsePrReviewGateInput(
    createModelReviewInput(config, snapshot, report),
  );
  const policy = {
    ...config.policy,
    validateWorkflowBlobSha: snapshot.trustedWorkflowBlobSha,
    humanApprovedPaths: snapshot.humanBinding.paths,
    humanApprovedNoRuntimeImpact: snapshot.humanBinding.noRuntimeImpact,
    humanApprovalChannel: snapshot.humanBinding.channel,
  };
  return { input, gate: evaluatePrReviewGate(input, policy) };
}

function reviewPacket(
  snapshot: Snapshot,
  reportContext?: Readonly<{ reportVersion: string; policyVersion: string }>,
): ReviewPacket {
  const request = planDailyReleaseValidation({
    version: DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
    change: {
      summary: `PR #${snapshot.gateInput.pullRequest.number} review`,
      declaredImpacts: [],
      changedPaths: snapshot.gateInput.pullRequest.changedFiles.map(
        ({ path }) => path,
      ),
    },
    capability: {
      newCapabilityEnabled: false,
      majorContractChange: false,
      externalMvpRelease: false,
    },
  });
  return {
    ...snapshot.gateInput,
    evidence: snapshot.evidence,
    workflow: {
      path: PR_VALIDATE_WORKFLOW_PATH,
      trustedBlobSha: snapshot.trustedWorkflowBlobSha,
      status: snapshot.workflowStatus,
      conclusion: snapshot.workflowConclusion,
    },
    diff: snapshot.diff,
    browserApproval: {
      version: BROWSER_APPROVAL_VERSION,
      channel: snapshot.humanBinding.channel,
      frozenAt: snapshot.browserChallenge?.frozenAt ?? null,
      epoch: snapshot.browserChallenge?.epoch ?? null,
      reviewId: snapshot.humanBinding.receipt?.reviewId ?? null,
    },
    reviewContext: {
      baseSha: integrationModeOf(snapshot.gateInput) === "serialized-merge" ? snapshot.gateInput.repository.defaultBranchSha : snapshot.gateInput.pullRequest.baseSha,
      reportVersion:
        reportContext?.reportVersion ?? PR_REVIEW_REPORT_VERSION,
      policyVersion:
        reportContext?.policyVersion ?? PR_REVIEW_GATE_POLICY_VERSION,
      requirementDigest: requirementDigest(
        snapshot.gateInput.issues,
        snapshot.gateInput.pullRequest,
      ),
    },
    impactHints: request.impact.effective,
    suggestedEvidenceIds: [
      ...request.fixedBaseline,
      ...request.targeted,
      ...request.reused,
    ].map(({ check }) => check.id),
  };
}

function cleanUserText(value: string): string {
  return value
    .replaceAll("<!--", "&lt;!--")
    .replaceAll("-->", "--&gt;")
    .replaceAll("\u0000", "")
    .trim();
}

export function parseModelReviewReport(value: unknown): ModelReviewReport {
  if (!isRecord(value)) throw new Error("The review report must be a JSON object.");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_REPORT_BYTES) {
    throw new Error("The review report exceeds the 20 KB persistence limit.");
  }
  const decision = value.decision;
  if (
    decision !== "approve" &&
    decision !== "request_changes" &&
    decision !== "awaiting_verification" &&
    decision !== "human_decision"
  ) {
    throw new Error("The review report decision is invalid.");
  }
  if (!Array.isArray(value.declaredImpacts) || !Array.isArray(value.findings)) {
    throw new Error("The review report impacts and findings must be arrays.");
  }
  const allowedImpacts: readonly string[] = [
    "ui",
    "server-business",
    "reflection-journal",
    "prompt-budget",
    "owner-permission",
    "purge-coverage",
    "provider-migration",
  ];
  const declaredImpacts = value.declaredImpacts.map((impact, index) => {
    if (
      typeof impact !== "string" ||
      !allowedImpacts.includes(impact)
    ) {
      throw new Error(`The review report impact at index ${index} is invalid.`);
    }
    return impact as ReleaseImpactKind;
  });
  const capability = value.capability;
  const riskFlags = value.riskFlags;
  if (!isRecord(capability) || !isRecord(riskFlags)) {
    throw new Error("The review report risk flags are missing.");
  }
  const booleanField = (record: JsonRecord, key: string): boolean => {
    if (typeof record[key] !== "boolean") {
      throw new Error(`The review report field ${key} must be boolean.`);
    }
    return record[key] as boolean;
  };
  const findings: ModelReviewReport["findings"][number][] = value.findings.map(
    (finding, index) => {
    if (!isRecord(finding)) {
      throw new Error(`The review finding at index ${index} is invalid.`);
    }
    const severity = finding.severity;
    if (
      severity !== "P0" &&
      severity !== "P1" &&
      severity !== "P2" &&
      severity !== "P3"
    ) {
      throw new Error(`The review finding severity at index ${index} is invalid.`);
    }
      return {
        severity,
        file: requiredString(finding.file, `findings[${index}].file`),
        line: requiredPositiveInteger(finding.line, `findings[${index}].line`),
        trigger: requiredString(finding.trigger, `findings[${index}].trigger`),
        userImpact: requiredString(
          finding.userImpact,
          `findings[${index}].userImpact`,
        ),
        evidence: requiredString(
          finding.evidence,
          `findings[${index}].evidence`,
        ),
      };
    },
  );
  if (
    decision === "request_changes" &&
    !findings.some(
      (finding) =>
        finding.severity === "P0" ||
        finding.severity === "P1" ||
        finding.severity === "P2",
    )
  ) {
    throw new Error(
      "request_changes requires at least one concrete P0, P1, or P2 finding.",
    );
  }
  const requirement = requiredString(
    value.requirementDigest,
    "requirementDigest",
  );
  if (!/^[0-9a-f]{64}$/i.test(requirement)) {
    throw new Error("requirementDigest must be a SHA-256 digest.");
  }
  return {
    version: requiredString(value.version, "version"),
    policyVersion: requiredString(value.policyVersion, "policyVersion"),
    repositoryId: requiredPositiveInteger(value.repositoryId, "repositoryId"),
    pullRequestNumber: requiredPositiveInteger(
      value.pullRequestNumber,
      "pullRequestNumber",
    ),
    headSha: requiredString(value.headSha, "headSha"),
    baseSha: requiredString(value.baseSha, "baseSha"),
    requirementDigest: requirement.toLowerCase(),
    decision,
    diffComplete: value.diffComplete === true,
    declaredImpacts,
    capability: {
      newCapabilityEnabled: booleanField(
        capability,
        "newCapabilityEnabled",
      ),
      majorContractChange: booleanField(capability, "majorContractChange"),
      externalMvpRelease: booleanField(capability, "externalMvpRelease"),
    },
    riskFlags: {
      productDefinitionChanged: booleanField(
        riskFlags,
        "productDefinitionChanged",
      ),
      authorizationBoundaryChanged: booleanField(
        riskFlags,
        "authorizationBoundaryChanged",
      ),
      privacyBoundaryChanged: booleanField(
        riskFlags,
        "privacyBoundaryChanged",
      ),
      destructiveMigration: booleanField(riskFlags, "destructiveMigration"),
      productionFeatureEnablement: booleanField(
        riskFlags,
        "productionFeatureEnablement",
      ),
    },
    findings,
  };
}

async function removeStaleLock(directory: string): Promise<boolean> {
  const lockInfo = await lstat(directory).catch(() => null);
  if (!lockInfo || !lockInfo.isDirectory() || lockInfo.isSymbolicLink() || lockInfo.uid !== process.getuid?.() || (lockInfo.mode & 0o077) !== 0) return false;
  try {
    const ownerPath = `${directory}/owner.json`;
    const ownerInfo = await lstat(ownerPath);
    if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.uid !== process.getuid?.() || (ownerInfo.mode & 0o077) !== 0 || ownerInfo.size > 1_000) return false;
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as unknown;
    if (!isRecord(owner) || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ESRCH"
      ) {
        return false;
      }
    }
    await unlink(ownerPath);
    await rmdir(directory);
    return true;
  } catch {
    try {
      const lock = await stat(directory);
      if (Date.now() - lock.mtimeMs < 60_000) return false;
      await rmdir(directory);
      return true;
    } catch {
      return false;
    }
  }
}

export async function withGlobalLock<T>(operation: () => Promise<T>, directory = LOCK_DIRECTORY): Promise<T> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch {
    if (!(await removeStaleLock(directory))) {
      throw new Error("Another PR approval operation holds the repository lock.");
    }
    await mkdir(directory, { mode: 0o700 });
  }
  const ownerPath = `${directory}/owner.json`;
  try {
    await writeFile(
      ownerPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { mode: 0o600, flag: "wx" },
    );
    return await operation();
  } finally {
    try {
      await unlink(ownerPath);
    } catch {
      // The lock directory may have been removed while recovering a stale lock.
    }
    try {
      await rmdir(directory);
    } catch {
      // Another operation owns the lock now.
    }
  }
}

function checkExternalId(
  pullNumber: number,
  headSha: string,
  baseSha: string,
  requirement: string,
): string {
  return [
    "sayhear-pr-review",
    pullNumber,
    headSha,
    baseSha,
    requirement,
  ].join(":");
}

async function readCheckRunsForCommit(
  api: GitHubApi,
  commitSha: string,
): Promise<JsonRecord[]> {
  const checkRuns: JsonRecord[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await api.request<JsonRecord>(
      repositoryPath(
        `/commits/${commitSha}/check-runs?filter=all&per_page=100&page=${page}`,
      ),
    );
    if (!Array.isArray(response.check_runs)) {
      throw new Error("GitHub check runs could not be read.");
    }
    checkRuns.push(...(response.check_runs as JsonRecord[]));
    if (response.check_runs.length < 100) return checkRuns;
  }
  throw new Error("GitHub check-run pagination exceeded its limit.");
}

function newestCheckRun(checkRuns: readonly JsonRecord[]): JsonRecord | null {
  return (
    [...checkRuns].sort(
      (left, right) =>
        Number(right.id ?? 0) - Number(left.id ?? 0),
    )[0] ?? null
  );
}

function snapshotEvidenceDigest(snapshot: Snapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...snapshot.evidence]
          .sort((left, right) => left.checkId.localeCompare(right.checkId))
          .map((entry) =>
            entry.kind === "deferred-before-merge"
              ? {
                  checkId: entry.checkId,
                  kind: entry.kind,
                  policy: entry.policy,
                }
              : {
                  checkId: entry.checkId,
                  result: entry.result,
                  source: entry.source,
                  artifactSha256: entry.artifactSha256,
                  coveredCheckIds: entry.coveredCheckIds,
                },
          ),
      ),
    )
    .digest("hex");
}

async function upsertCheckRun(
  config: ControllerConfig,
  snapshot: Snapshot,
  report: ModelReviewReport,
  gate: PrReviewGateReport,
  persistReview = true,
): Promise<void> {
  const externalId = checkExternalId(
    report.pullRequestNumber,
    report.headSha,
    report.baseSha,
    report.requirementDigest,
  );
  const existingChecks = (await readCheckRunsForCommit(
    config.api,
    report.headSha,
  )).filter(
    (check) =>
      check.name === PR_REVIEW_GATE_CHECK_NAME &&
      isRecord(check.app) &&
      check.app.id === config.app.appId,
  );
  const existing =
    existingChecks.find((check) => check.external_id === externalId) ??
    newestCheckRun(existingChecks);
  const summary = currentCheckSummary(gate, report);
  const reportBase64 = persistReview
    ? Buffer.from(JSON.stringify(report), "utf8").toString("base64url")
    : null;
  if (reportBase64 !== null && reportBase64.length > 32_000) {
    throw new Error("The review report cannot be persisted safely in the check run.");
  }
  const evidenceDigest = snapshotEvidenceDigest(snapshot);
  const stateMarker = reportBase64
    ? [
        `<!-- sayhear-pr-auto-approval-state:v1`,
        `pr=${report.pullRequestNumber}`,
        `head=${report.headSha}`,
        `base=${report.baseSha}`,
        `requirement=${report.requirementDigest}`,
        `diff=${snapshot.diff.digest}`,
        `change=${snapshot.diff.changeDigest}`,
        `evidence=${evidenceDigest}`,
        `outcome=${gate.outcome}`,
        `report=${reportBase64} -->`,
      ].join(" ")
    : "";
  const evidenceSummary = snapshot.evidence.map((entry) =>
    entry.kind === "deferred-before-merge"
      ? `- \`${entry.checkId}\`: deferred before merge (${entry.policy.reason}); follow-up at ${entry.policy.followUp.stage}: ${entry.policy.followUp.command}`
      : `- \`${entry.checkId}\`: ${entry.result}; run ${entry.source.runId}/${entry.source.runAttempt}; artifact ${entry.artifactSha256 ?? "none"}`,
  );
  const payload = {
    name: PR_REVIEW_GATE_CHECK_NAME,
    head_sha: report.headSha,
    external_id: externalId,
    status: "completed",
    conclusion:
      gate.outcome === "merge_candidate" ||
      gate.outcome === "merge_candidate_with_deferrals"
        ? "success"
        : gate.outcome === "human_decision"
          ? "action_required"
          : "failure",
    completed_at: new Date().toISOString(),
    output: {
      title: summary.title,
      summary: [
        cleanUserText(summary.summary).slice(0, 28_000),
        ...(evidenceSummary.length > 0
          ? ["", "Evidence records:", ...evidenceSummary]
          : []),
        ...(stateMarker ? ["", stateMarker] : []),
      ].join("\n"),
    },
  };
  if (
    existing?.status === "completed" &&
    existing.conclusion === payload.conclusion &&
    isRecord(existing.output) &&
    existing.output.summary === payload.output.summary
  ) {
    return;
  }
  if (existing) {
    await config.api.request(
      repositoryPath(`/check-runs/${recordNumber(existing, "id")}`),
      { method: "PATCH", body: payload },
    );
  } else {
    await config.api.request(repositoryPath("/check-runs"), {
      method: "POST",
      body: payload,
    });
  }
}

async function findReviewCheckRun(
  config: ControllerConfig,
  headSha: string,
  externalId: string,
): Promise<JsonRecord | null> {
  return (
    newestCheckRun(
      (await readCheckRunsForCommit(config.api, headSha)).filter(
      (check) =>
        check.name === PR_REVIEW_GATE_CHECK_NAME &&
        check.external_id === externalId &&
        isRecord(check.app) &&
        check.app.id === config.app.appId,
      ),
    ) ?? null
  );
}

async function startReviewCheckRun(
  config: ControllerConfig,
  snapshot: Snapshot,
  packetPath: string,
): Promise<"started" | "already_running" | "blocked"> {
  const pullRequest = snapshot.gateInput.pullRequest;
  const requirement = requirementDigest(
    snapshot.gateInput.issues,
    pullRequest,
  );
  const externalId = checkExternalId(
    pullRequest.number,
    pullRequest.headSha,
    integrationModeOf(snapshot.gateInput) === "serialized-merge" ? snapshot.gateInput.repository.defaultBranchSha : pullRequest.baseSha,
    requirement,
  );
  const existing = await findReviewCheckRun(
    config,
    pullRequest.headSha,
    externalId,
  );
  if (existing?.status === "completed") return "blocked";
  if (existing && existing.status !== "completed") {
    const startedAt =
      typeof existing.started_at === "string"
        ? Date.parse(existing.started_at)
        : NaN;
    if (
      !Number.isFinite(startedAt) ||
      Date.now() - startedAt < REVIEW_TASK_STALE_AFTER_MS
    ) {
      return "already_running";
    }
    await config.api.request(
      repositoryPath(`/check-runs/${recordNumber(existing, "id")}`),
      {
        method: "PATCH",
        body: {
          status: "completed",
          conclusion: "cancelled",
          completed_at: new Date().toISOString(),
          output: {
            title: "Review task expired",
            summary:
              "The prior local review task did not submit a report within six hours. A fresh task is starting.",
          },
        },
      },
    );
  }

  const payload = {
    name: PR_REVIEW_GATE_CHECK_NAME,
    head_sha: pullRequest.headSha,
    external_id: externalId,
    status: "in_progress",
    started_at: new Date().toISOString(),
    output: {
      title: "Review in progress",
      summary: [
        `PR #${pullRequest.number} at \`${pullRequest.headSha}\`.`,
        `Packet: \`${packetPath}\`.`,
        `Requirement digest: \`${requirement}\`.`,
      ].join("\n"),
    },
  };
  try {
    await config.api.request(repositoryPath("/check-runs"), {
      method: "POST",
      body: payload,
    });
  } catch (error) {
    const recovered = await findReviewCheckRun(
      config,
      pullRequest.headSha,
      externalId,
    ).catch(() => null);
    if (recovered?.status !== "in_progress") throw error;
  }
  return "started";
}

export async function readSavedReviewReport(
  config: ControllerConfig,
  snapshot: Snapshot,
): Promise<Readonly<{
  report: ModelReviewReport;
  evidenceDigest: string;
}> | null> {
  const pullRequest = snapshot.gateInput.pullRequest;
  const requirement = requirementDigest(
    snapshot.gateInput.issues,
    pullRequest,
  );
  const externalId = checkExternalId(
    pullRequest.number,
    pullRequest.headSha,
    pullRequest.baseSha,
    requirement,
  );
  const check = newestCheckRun(
    (await readCheckRunsForCommit(config.api, pullRequest.headSha)).filter(
    (entry) =>
      entry.name === PR_REVIEW_GATE_CHECK_NAME &&
      (entry.external_id === externalId || (integrationModeOf(snapshot.gateInput) === "serialized-merge" &&
        typeof entry.external_id === "string" && entry.external_id.startsWith(`sayhear-pr-review:${pullRequest.number}:${pullRequest.headSha}:`) &&
        entry.external_id.endsWith(`:${requirement}`))) &&
      isRecord(entry.app) &&
      entry.app.id === config.app.appId &&
      entry.status === "completed",
    ),
  );
  if (!check || !isRecord(check.output)) return null;
  const summary = check.output.summary;
  if (typeof summary !== "string") return null;
  const marker = summary.match(
    /<!-- sayhear-pr-auto-approval-state:v1 pr=(\d+) head=([0-9a-f]{40}) base=([0-9a-f]{40}) requirement=([0-9a-f]{64}) diff=([0-9a-f]{64}) change=([0-9a-f]{64}) evidence=([0-9a-f]{64}) outcome=(merge_candidate_with_deferrals|merge_candidate|request_changes|awaiting_verification|human_decision) report=([A-Za-z0-9_-]+) -->/i,
  );
  if (!marker) return null;
  try {
    const reportValue = JSON.parse(
      Buffer.from(marker[9]!, "base64url").toString("utf8"),
    ) as unknown;
    const report = parseModelReviewReport(reportValue);
    if (
      Number(marker[1]) !== pullRequest.number ||
      marker[2]!.toLowerCase() !== pullRequest.headSha ||
      marker[3]!.toLowerCase() !== report.baseSha.toLowerCase() ||
      marker[4]!.toLowerCase() !== requirement ||
      marker[5]!.toLowerCase() !== snapshot.diff.digest ||
      marker[6]!.toLowerCase() !== snapshot.diff.changeDigest ||
      report.pullRequestNumber !== pullRequest.number ||
      report.headSha.toLowerCase() !== pullRequest.headSha ||
      (integrationModeOf(snapshot.gateInput) !== "serialized-merge" && report.baseSha.toLowerCase() !== pullRequest.baseSha) ||
      report.policyVersion !== PR_REVIEW_GATE_POLICY_VERSION ||
      check.external_id !== checkExternalId(report.pullRequestNumber, report.headSha, report.baseSha, report.requirementDigest) ||
      report.requirementDigest !== requirement
    ) {
      return null;
    }
    if (integrationModeOf(snapshot.gateInput) === "serialized-merge" &&
        (!snapshot.diff.complete || !await baseReviewRiskSafe(config.api, report.baseSha,
          snapshot.gateInput.repository.defaultBranchSha, snapshot.changedPaths))) return null;
    return {
      report,
      evidenceDigest: marker[7]!.toLowerCase(),
    };
  } catch {
    return null;
  }
}

type AppReviewIdentity = Readonly<{
  pullRequestNumber: number;
  headSha: string;
  baseSha: string;
  requirementDigest: string;
}>;

const APP_REVIEW_MARKER = "<!-- sayhear-pr-auto-approval-review:v2";

/**
 * `approve_deferred` marks an approval whose gate deferred pre-merge checks.
 * It is still a GitHub APPROVE, but Issue completion accepts only `approve`,
 * so a deferred merge can never close its Issues through the controller.
 */
export type AppReviewOutcome = "approve" | "approve_deferred" | "request_changes";

export function appReviewOutcomeForIdentity(
  body: string | null,
  identity: AppReviewIdentity,
): AppReviewOutcome | null {
  const marker = body?.match(
    /<!-- sayhear-pr-auto-approval-review:v2 pr=(\d+) head=([0-9a-f]{40}) base=([0-9a-f]{40}) requirement=([0-9a-f]{64}) outcome=(approve_deferred|approve|request_changes) -->/i,
  );
  if (
    !marker ||
    Number(marker[1]) !== identity.pullRequestNumber ||
    marker[2]!.toLowerCase() !== identity.headSha.toLowerCase() ||
    marker[3]!.toLowerCase() !== identity.baseSha.toLowerCase() ||
    marker[4]!.toLowerCase() !== identity.requirementDigest.toLowerCase()
  ) {
    return null;
  }
  return marker[5]!.toLowerCase() as AppReviewOutcome;
}

async function findExistingAppReview(
  config: ControllerConfig,
  identity: AppReviewIdentity,
): Promise<GitHubReview | null> {
  const reviews = await config.api.pages<GitHubReview>(
    repositoryPath(`/pulls/${identity.pullRequestNumber}/reviews`),
  );
  const matching = reviews
    .filter(
      (review) =>
        review.user.id === config.botActorId &&
        review.commit_id.toLowerCase() === identity.headSha.toLowerCase() &&
        (review.state === "APPROVED" ||
          review.state === "CHANGES_REQUESTED") &&
        appReviewOutcomeForIdentity(review.body, identity) !== null,
    )
    .sort((left, right) => left.id - right.id);
  return matching.at(-1) ?? null;
}

async function submitPullRequestReview(
  config: ControllerConfig,
  report: ModelReviewReport,
  deferred: PrReviewGateReport["deferredEvidence"],
): Promise<GitHubReview> {
  const existing = await findExistingAppReview(
    config,
    report,
  );
  const desired: AppReviewOutcome =
    report.decision === "request_changes"
      ? "request_changes"
      : deferred.length > 0
        ? "approve_deferred"
        : "approve";
  if (existing) {
    if (appReviewOutcomeForIdentity(existing.body, report) !== desired) {
      throw new Error(
        "This head already has a different review from the App; a maintainer must resolve it.",
      );
    }
    return existing;
  }

  const reviewMarker =
    `${APP_REVIEW_MARKER} pr=${report.pullRequestNumber} head=${report.headSha} base=${report.baseSha} requirement=${report.requirementDigest} outcome=${desired} -->`;
  const bodyLines = [
    `Automated review of PR #${report.pullRequestNumber} at \`${report.headSha}\`.`,
    `Requirement digest: \`${report.requirementDigest}\`.`,
    ...(report.findings.length
      ? [
          "",
          "Findings:",
          ...report.findings.map(
            (finding) =>
              `- **${finding.severity}** \`${cleanUserText(finding.file)}:${finding.line}\`: ${cleanUserText(finding.trigger)}. Impact: ${cleanUserText(finding.userImpact)}. Evidence: ${cleanUserText(finding.evidence)}`,
          ),
        ]
      : ["", "No blocking findings."]),
    ...(deferred.length > 0
      ? [
          "",
          "Not run before merge:",
          ...deferred.map(
            (entry) =>
              `- \`${entry.checkId}\`: ${entry.reason}; follow-up at ${entry.followUp.stage}: \`${entry.followUp.command}\``,
          ),
          "",
          "The linked Issues stay open until these checks run.",
        ]
      : []),
    "",
    reviewMarker,
  ].join("\n");
  const payload = {
    commit_id: report.headSha,
    event: desired === "request_changes" ? "REQUEST_CHANGES" : "APPROVE",
    body: bodyLines,
  };
  try {
    return await config.api.request<GitHubReview>(
      repositoryPath(`/pulls/${report.pullRequestNumber}/reviews`),
      { method: "POST", body: payload },
    );
  } catch (error) {
    const recovered = await findExistingAppReview(
      config,
      report,
    ).catch(() => null);
    if (
      recovered &&
      appReviewOutcomeForIdentity(recovered.body, report) === desired
    ) {
      return recovered;
    }
    throw error;
  }
}

async function postIssueCommentOnce(
  api: GitHubApi,
  issueNumber: number,
  marker: string,
  body: string,
  expectedAuthorId: number,
): Promise<void> {
  const commentsPath = repositoryPath(`/issues/${issueNumber}/comments`);
  const comments = await api.pages<GitHubComment>(
    commentsPath,
  );
  const isPersistedReviewComment = (comment: GitHubComment): boolean =>
    comment.user?.id === expectedAuthorId && comment.body?.includes(marker) === true;
  if (comments.some(isPersistedReviewComment)) return;
  try {
    await api.request(
      commentsPath,
      { method: "POST", body: { body } },
    );
  } catch (error) {
    const recovered = await api.pages<GitHubComment>(commentsPath).catch(() => []);
    if (recovered.some(isPersistedReviewComment)) return;
    throw error;
  }
  const persisted = await api.pages<GitHubComment>(commentsPath);
  if (!persisted.some(isPersistedReviewComment)) {
    throw new Error(`GitHub did not retain the review comment on Issue #${issueNumber}.`);
  }
}

async function deleteLabelIfPresent(
  api: GitHubApi,
  issueNumber: number,
  label: string,
): Promise<void> {
  try {
    await api.request(
      repositoryPath(
        `/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      ),
      { method: "DELETE" },
    );
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return;
    throw error;
  }
}

async function clearIssueStatusLabels(
  api: GitHubApi,
  issueNumber: number,
): Promise<GitHubIssue> {
  const issuePath = repositoryPath(`/issues/${issueNumber}`);
  const issue = await api.request<GitHubIssue>(issuePath);
  const labels = new Map(
    labelNames(issue).map((label) => [label.toLowerCase(), label]),
  );
  for (const statusLabel of ISSUE_STATUS_LABELS) {
    const actualLabel = labels.get(statusLabel);
    if (actualLabel) {
      await deleteLabelIfPresent(api, issueNumber, actualLabel);
    }
  }
  const readback = await api.request<GitHubIssue>(issuePath);
  const remaining = labelNames(readback).filter((label) =>
    ISSUE_STATUS_LABEL_SET.has(label.toLowerCase()),
  );
  if (remaining.length > 0) {
    throw new Error(
      `Issue #${issueNumber} retained status labels after cleanup: ${remaining.join(", ")}.`,
    );
  }
  return readback;
}

async function applyIssueHandoff(
  api: GitHubApi,
  issueNumber: number,
  target: "ready-for-agent",
  preserveHumanState = false,
): Promise<void> {
  const issuePath = repositoryPath(`/issues/${issueNumber}`);
  const assertNoHumanState = (candidate: GitHubIssue) => {
    if (preserveHumanState && labelNames(candidate).some((label) =>
      ["ready-for-human", "needs-info", "needs-triage", "wontfix"].includes(label.toLowerCase()))) {
      throw new Error("The Issue acquired a human triage state during base synchronization.");
    }
  };
  const issue = await api.request<GitHubIssue>(issuePath);
  assertNoHumanState(issue);
  let currentLabels = new Set(
    labelNames(issue).map((label) => label.toLowerCase()),
  );
  if (issue.state === "closed") {
    await clearIssueStatusLabels(api, issueNumber);
    throw new Error(`Issue #${issueNumber} is closed and cannot be handed off.`);
  }

  if (!currentLabels.has(target)) {
    await api.request(
      repositoryPath(`/issues/${issueNumber}/labels`),
      { method: "POST", body: { labels: [target] } },
    );
  }

  for (const label of ISSUE_STATUS_LABELS) {
    if (label !== target && currentLabels.has(label)) {
      const latest = await api.request<GitHubIssue>(issuePath);
      assertNoHumanState(latest);
      if (latest.state !== "open") {
        await clearIssueStatusLabels(api, issueNumber);
        throw new Error(`Issue #${issueNumber} closed during the review handoff.`);
      }
      currentLabels = new Set(
        labelNames(latest).map((candidate) => candidate.toLowerCase()),
      );
      const actualLabel = labelNames(latest).find(
        (candidate) => candidate.toLowerCase() === label,
      );
      if (actualLabel) {
        await deleteLabelIfPresent(api, issueNumber, actualLabel);
        currentLabels.delete(label);
      }
    }
  }

  const readback = await api.request<GitHubIssue>(issuePath);
  assertNoHumanState(readback);
  if (readback.state !== "open") {
    await clearIssueStatusLabels(api, issueNumber);
    throw new Error(`Issue #${issueNumber} closed during the review handoff.`);
  }
  const finalLabels = new Set(labelNames(readback).map((label) => label.toLowerCase()));
  const finalConflicts = ISSUE_STATUS_LABELS.filter(
    (label) => label !== target && finalLabels.has(label),
  );
  if (finalConflicts.length > 0) {
    const actualTarget = labelNames(readback).find(
      (label) => label.toLowerCase() === target,
    );
    if (actualTarget) await deleteLabelIfPresent(api, issueNumber, actualTarget);
    throw new Error(
      `Issue #${issueNumber} changed during the review handoff; conflicting labels: ${finalConflicts.join(", ")}.`,
    );
  }
  if (!finalLabels.has(target)) {
    throw new Error(`Issue #${issueNumber} did not retain the ready-for-agent handoff.`);
  }
}

export async function publishIssueHandoff(
  api: GitHubApi,
  issueNumber: number,
  marker: string,
  body: string,
  expectedAuthorId: number,
): Promise<void> {
  await postIssueCommentOnce(api, issueNumber, marker, body, expectedAuthorId);
  await applyIssueHandoff(api, issueNumber, "ready-for-agent");
}

export async function forEachLinkedIssue(
  issueNumbers: readonly number[],
  action: (number: number) => Promise<void>,
): Promise<void> {
  const failures: string[] = [];
  let retryAfterMs = 0;
  for (const number of [...new Set(issueNumbers)].sort((left, right) => left - right)) {
    try { await action(number); }
    catch (error) {
      failures.push(`Issue #${number}: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof GitHubApiError || error instanceof CompletionUnavailable) {
        retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs);
      }
    }
  }
  if (failures.length > 0) {
    const error = new CompletionUnavailable("completion_issue_updates_incomplete", retryAfterMs);
    error.message = `Issue updates incomplete: ${failures.join("; ")}`;
    throw error;
  }
}

export async function completeLinkedIssuesAfterMerge(
  api: GitHubApi,
  issueNumbers: readonly number[],
  proof: Readonly<{ autoMergeEnabled: boolean; merged: boolean }>,
): Promise<void> {
  // An enabled auto-merge can still be cancelled or blocked. Keep Issues occupied
  // until GitHub confirms the merge; scan retries the completion after that.
  if (!proof.merged) return;
  await forEachLinkedIssue(issueNumbers, (number) => completeIssueAfterApproval(api, number, proof));
}

export async function completeIssueAfterApproval(
  api: GitHubApi,
  issueNumber: number,
  proof: Readonly<{
    autoMergeEnabled: boolean;
    merged: boolean;
  }>,
): Promise<void> {
  if (!proof.merged) {
    throw new Error("The Issue cannot close before GitHub confirms merge.");
  }
  const issuePath = repositoryPath(`/issues/${issueNumber}`);
  let issue = await api.request<GitHubIssue>(issuePath);
  if (issue.state !== "closed") {
    issue = await clearIssueStatusLabels(api, issueNumber);
  }
  if (issue.state !== "closed") {
    try {
      await api.request(issuePath, {
        method: "PATCH",
        body: { state: "closed", state_reason: "completed" },
      });
    } catch (error) {
      const recovered = await api.request<GitHubIssue>(issuePath).catch(() => null);
      if (recovered?.state !== "closed") throw error;
    }
  }

  const readback = await clearIssueStatusLabels(api, issueNumber);
  if (readback.state !== "closed") {
    throw new Error(
      `Issue #${issueNumber} was not fully closed and cleared after PR approval.`,
    );
  }
}

async function recordReviewHandoff(
  config: ControllerConfig,
  snapshot: Snapshot,
  report: ModelReviewReport,
  gate: PrReviewGateReport,
  review: GitHubReview,
): Promise<void> {
  await forEachLinkedIssue(snapshot.gateInput.issues.filter((issue) => issue.state === "open" && !snapshot.gateInput.pullRequest.keepOpenIssueNumbers.includes(issue.number)).map((issue) => issue.number), async (issueNumber) => {
    const history = parseRequestChangeHistory(
      await config.api.pages<GitHubComment>(
        repositoryPath(`/issues/${issueNumber}/comments`),
      ),
      report.pullRequestNumber,
      config.botActorId,
    );
    const round = nextRequestChangeRound(
      history,
      snapshot.diff.changeDigest,
    );
    const diffDigest = snapshot.diff.changeDigest;
    const outcome =
      report.decision === "request_changes" ? "request_changes" : "approve";
    const marker = `${AUTO_REVIEW_COMMENT_MARKER} pr=${report.pullRequestNumber} review=${review.id} head=${report.headSha} base=${report.baseSha}`;
    const finalMarker =
      `${AUTO_REVIEW_COMMENT_MARKER} pr=${report.pullRequestNumber} review=${review.id} head=${report.headSha} base=${report.baseSha} round=${round} diff=${diffDigest} outcome=${outcome} -->`;
    const body = [
      `PR [#${report.pullRequestNumber}](https://github.com/${SAYHEAR_REPOSITORY_NAME}/pull/${report.pullRequestNumber}), review [${review.id}](https://github.com/${SAYHEAR_REPOSITORY_NAME}/pull/${report.pullRequestNumber}#pullrequestreview-${review.id}).`,
      `Reviewed head: \`${report.headSha}\`.`,
      `Gate: \`${gate.outcome}\`.`,
      ...gate.reasons.map((reason) => `- ${cleanUserText(reason.message)}`),
      ...report.findings
        .filter((finding) => finding.severity !== "P3")
        .map(
          (finding) =>
            `- **${finding.severity}** \`${cleanUserText(finding.file)}:${finding.line}\`: ${cleanUserText(finding.trigger)}. Impact: ${cleanUserText(finding.userImpact)}. Evidence: ${cleanUserText(finding.evidence)}`,
        ),
      ...(round >= 3
        ? [
            "",
            "Automatic follow-up is paused after three post-fix reviews with blocking findings. Luke must resume it explicitly.",
            `@lukemyself-hub`,
            `${PAUSE_MARKER} pr=${report.pullRequestNumber} active=true round=${round} -->`,
          ]
        : []),
      "",
      finalMarker,
    ].join("\n");
    await publishIssueHandoff(config.api, issueNumber, marker, body, config.botActorId);
  });
}

class ProtectedMergeRejected extends Error {}

export function definitiveMergeRejection(error: unknown): boolean {
  return error instanceof ProtectedMergeRejected ||
    (error instanceof GitHubApiError && [400, 401, 403, 404, 405, 409, 422].includes(error.status));
}

export async function requestProtectedMerge(
  api: GitHubApi,
  pullRequestNumber: number,
  headSha: string,
  mergeMethod: "MERGE" | "SQUASH" | "REBASE",
  recoverLostResponse = true,
): Promise<void> {
  let result: JsonRecord;
  try {
    result = await api.request<JsonRecord>(
      repositoryPath(`/pulls/${pullRequestNumber}/merge`), {
        method: "PUT",
        body: { sha: headSha, merge_method: mergeMethod.toLowerCase() },
      });
  } catch (error) {
    if (!recoverLostResponse) throw error;
    const readback = await api.request<JsonRecord>(
      repositoryPath(`/pulls/${pullRequestNumber}`),
    ).catch(() => null);
    if (readback?.merged === true && readback.state === "closed" &&
        isRecord(readback.head) && readback.head.sha === headSha) return;
    throw error;
  }
  if (result.merged !== true) throw new ProtectedMergeRejected("GitHub did not confirm the protected merge.");
}

function mergeMethodFor(repository: JsonRecord): "MERGE" | "SQUASH" | "REBASE" {
  return repository.allow_merge_commit === true ? "MERGE"
    : repository.allow_squash_merge === true ? "SQUASH"
      : repository.allow_rebase_merge === true ? "REBASE" : "MERGE";
}

// The browser channel is the authorization channel for every agent-authored PR,
// but only a PR that touches a protected path actually needs Luke's approval. An
// ordinary agent PR merges on the pinned head with no human binding at all.
export function browserAuthorizationRequired(
  binding: HumanReviewBinding,
  changedFiles: PrReviewGateInput["pullRequest"]["changedFiles"],
): boolean {
  return binding.channel === "browser" && protectedReviewPaths(changedFiles).length > 0;
}

// Which merge mechanism the bound human channel allows. The browser channel never
// arms GitHub's deferred auto-merge: once the App approval is published, a later
// dismissal of Luke's review leaves the App review alone in the branch-protection
// slot, so the browser channel either issues one pinned merge now or waits.
// With a merge queue the same rule holds with one substitution: the browser
// channel issues one queue entry now, and the queue performs the merge.
// With serialized merge the controller issues one pinned merge now against the
// current main, and never arms a deferred intent, so a stale base is fine.
export type MergeAction = "enqueue" | "arm-auto-merge" | "merge-now" | "wait";

export function mergeActionFor(
  binding: HumanReviewBinding,
  pullRequest: JsonRecord,
  integrationMode: IntegrationMode = "up-to-date-base",
): MergeAction {
  if (integrationMode !== "up-to-date-base") {
    // Both head-bound modes merge the reviewed head against the live main
    // without moving it, so an out-of-date base is expected and must not block.
    // Only a confirmed clean/behind state proceeds; every other state waits
    // instead of arming a deferred intent that could land without fresh
    // verification. The queue performs the merge itself; serialized merge pins
    // it here. The gate deliberately leaves this state check to this step,
    // because its own check run keeps GitHub reporting `blocked` until the
    // candidate is reached.
    const state = pullRequest.mergeable_state;
    if (pullRequest.mergeable !== true || (state !== "clean" && state !== "behind")) {
      return "wait";
    }
    return integrationMode === "merge-queue" ? "enqueue" : "merge-now";
  }
  if (binding.channel !== "browser") return "arm-auto-merge";
  const clean =
    pullRequest.mergeable === true && pullRequest.mergeable_state === "clean";
  return clean ? "merge-now" : "wait";
}

// The endpoint that performs an approved merge. The two channels are not
// interchangeable even when both would merge immediately: only `arm-auto-merge`
// may leave a deferred intent behind, and the browser channel must never do so.
export async function applyMergeAction(
  config: ControllerConfig,
  report: Readonly<{ pullRequestNumber: number; headSha: string }>,
  repository: JsonRecord,
  pullRequest: GitHubPullRequest,
  action: "enqueue" | "arm-auto-merge" | "merge-now",
): Promise<void> {
  if (parseIntegrationMode(config.app.integrationMode) === "serialized-merge" && action !== "merge-now") {
    throw new Error("serialized_merge_requires_immediate_merge");
  }
  if (action === "enqueue") {
    await requestMergeQueueEnqueue(config, report, pullRequest);
    return;
  }
  if (action === "arm-auto-merge") {
    await requestPullRequestAutoMerge(config, report, repository, pullRequest);
    return;
  }
  await requestProtectedMerge(config.api, report.pullRequestNumber, report.headSha, mergeMethodFor(repository), false);
}

/**
 * One explicit merge-queue entry. `expectedHeadOid` pins the entry to the head
 * the human approval bound, so GitHub refuses an entry whose head moved after
 * the review. An existing entry is left alone, which makes the call idempotent
 * across scans and after a lost response.
 */
export async function requestMergeQueueEnqueue(
  config: ControllerConfig,
  report: Readonly<{ pullRequestNumber: number; headSha: string }>,
  pullRequest: GitHubPullRequest,
): Promise<void> {
  const data = await readGraphql<{
    repository?: {
      pullRequest?: { mergeQueueEntry?: { id?: string } | null } | null;
    } | null;
  }>(
    config.api,
    `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$number){ mergeQueueEntry { id } }
      }
    }`,
    {
      owner: "lukemyself-hub",
      name: "SayHear",
      number: report.pullRequestNumber,
    },
  );
  const entry = data.repository?.pullRequest?.mergeQueueEntry;
  if (isRecord(entry) && typeof entry.id === "string") return;
  const result = await readGraphql<{
    enqueuePullRequest?: { mergeQueueEntry?: JsonRecord | null } | null;
  }>(
    config.api,
    `mutation($input:EnqueuePullRequestInput!){enqueuePullRequest(input:$input){mergeQueueEntry{id state}}}`,
    {
      input: {
        pullRequestId: recordString(pullRequest, "node_id"),
        expectedHeadOid: report.headSha,
      },
    },
  );
  if (!isRecord(result.enqueuePullRequest?.mergeQueueEntry)) {
    throw new Error("GitHub did not confirm the merge-queue entry.");
  }
}

async function requestPullRequestAutoMerge(
  config: ControllerConfig,
  report: Readonly<{ pullRequestNumber: number; headSha: string }>,
  repository: JsonRecord,
  pullRequest: GitHubPullRequest,
): Promise<void> {
  if (isRecord(pullRequest.auto_merge)) return;
  const pullRequestNodeId = recordString(pullRequest, "node_id");
  const mergeMethod = repository.allow_merge_commit === true || repository.allow_squash_merge === true || repository.allow_rebase_merge === true
    ? mergeMethodFor(repository) : null;
  if (mergeMethod === null) {
    throw new Error("No enabled GitHub auto-merge method is available.");
  }
  // GitHub exposes auto-merge only while requirements remain pending. Once
  // clean, use its protected merge endpoint with the reviewed head pinned.
  if (pullRequest.mergeable === true && pullRequest.mergeable_state === "clean") {
    await requestProtectedMerge(config.api, report.pullRequestNumber, report.headSha, mergeMethod, false);
    return;
  }
  const mutation = `mutation($input:EnablePullRequestAutoMergeInput!){
    enablePullRequestAutoMerge(input:$input){
      pullRequest{number autoMergeRequest{enabledAt mergeMethod}}
    }
  }`;
  const result = await readGraphql<{
    enablePullRequestAutoMerge?: { pullRequest?: JsonRecord | null } | null;
  }>(config.api, mutation, { input: { pullRequestId: pullRequestNodeId, mergeMethod } });
  if (!result.enablePullRequestAutoMerge?.pullRequest) throw new Error("GitHub did not confirm auto-merge activation.");
}

export function isReviewStillPending(
  snapshot: Pick<Snapshot, "workflowStatus">,
  gate: Pick<PrReviewGateReport, "outcome" | "reasons">,
): boolean {
  if (gate.outcome !== "awaiting_verification") return false;
  if (
    gate.reasons.some((reason) =>
      reason.code === "repository_merge_busy" ||
      REVIEW_RETRYABLE_WAIT_REASONS.has(reason.code),
    )
  ) {
    return true;
  }
  if (!gate.reasons.some((reason) => reason.code === "required_evidence_missing")) {
    return false;
  }
  return (
    snapshot.workflowStatus === "queued" ||
    snapshot.workflowStatus === "in_progress" ||
    snapshot.workflowStatus === "missing" ||
    snapshot.workflowStatus === "unknown"
  );
}

async function postNonBlockingOutcome(
  config: ControllerConfig,
  snapshot: Snapshot,
  report: ModelReviewReport,
  gate: PrReviewGateReport,
): Promise<void> {
  const marker = `<!-- sayhear-pr-auto-approval-outcome:v1 pr=${report.pullRequestNumber} head=${report.headSha} requirement=${report.requirementDigest} outcome=${gate.outcome} -->`;
  const body = [
    `Automated review of PR #${report.pullRequestNumber} stopped at \`${gate.outcome}\`.`,
    `Head: \`${report.headSha}\`.`,
    ...gate.reasons.map((reason) => `- **${reason.code}**: ${cleanUserText(reason.message)}`),
    ...(gate.requiredEvidenceIds.length > 0
      ? [
          "",
          `Required evidence: ${gate.requiredEvidenceIds.join(", ")}.`,
          `Accepted evidence: ${gate.acceptedEvidenceIds.join(", ") || "none"}.`,
        ]
      : []),
    ...(gate.outcome === "human_decision"
      ? ["", "@lukemyself-hub, this PR needs a maintainer decision."]
      : []),
    "",
    marker,
  ].join("\n");
  await forEachLinkedIssue(snapshot.gateInput.issues.filter((issue) => issue.state === "open" && !snapshot.gateInput.pullRequest.keepOpenIssueNumbers.includes(issue.number)).map((issue) => issue.number),
    (issueNumber) => publishIssueHandoff(config.api, issueNumber, marker, body, config.botActorId));
}

export async function handoffStalePullRequestBase(
  api: GitHubApi,
  expected: PrReviewGateInput["pullRequest"],
  actors: Readonly<{ botActorId: number; ownerActorId: number }>,
  options: Readonly<{ kind?: "base-sync" | "merge-conflict" }> = {},
): Promise<Readonly<{
  status: "handed_off" | "current_base" | "state_changed" | "held_for_human" | "no_open_issue";
  currentMainSha: string;
  issueNumbers: readonly number[];
  heldIssueNumbers: readonly number[];
}>> {
  const kind = options.kind ?? "base-sync";
  const [pull, refs] = await Promise.all([
    api.request<GitHubPullRequest>(repositoryPath(`/pulls/${expected.number}`)),
    api.request<JsonRecord>(repositoryPath("/git/ref/heads/main")),
  ]);
  const currentMainSha = isRecord(refs.object) ? recordString(refs.object, "sha").toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(currentMainSha)) throw new Error("The current main SHA is unavailable for Issue handoff.");
  const heldIssueNumbers: number[] = [];
  const result = (status: "handed_off" | "current_base" | "state_changed" | "held_for_human" | "no_open_issue", issueNumbers: readonly number[] = []) =>
    ({ status, currentMainSha, issueNumbers, heldIssueNumbers });
  const matches = (candidate: GitHubPullRequest) => candidate.state === "open" && !candidate.draft &&
    candidate.base.ref === "main" && candidate.head.repo?.id === SAYHEAR_REPOSITORY_ID &&
    candidate.head.sha.toLowerCase() === expected.headSha && candidate.base.sha.toLowerCase() === expected.baseSha &&
    candidate.title === expected.title && (candidate.body ?? "") === expected.body && !isRecord(candidate.auto_merge);
  if (!matches(pull) || (kind === "merge-conflict" && pull.mergeable !== false)) {
    return result("state_changed");
  }
  if (kind === "base-sync" && pull.base.sha.toLowerCase() === currentMainSha) {
    return result("current_base");
  }

  const exclusions = parseIssueClosureExclusions(pull.title, pull.body ?? "");
  if (exclusions.ambiguous) return result("held_for_human");
  const issues = await resolveLinkedIssues(api, pull);
  const numbers = issues.map((issue) => issue.number);
  if ([...expected.linkedIssueNumbers].sort((a, b) => a - b).join() !== numbers.join() ||
    [...expected.keepOpenIssueNumbers].sort((a, b) => a - b).join() !== exclusions.keepOpenIssueNumbers.join()) {
    return result("state_changed");
  }
  const targets = issues.filter((issue) => issue.state === "open" && !exclusions.keepOpenIssueNumbers.includes(issue.number));
  if (targets.length === 0) return result("no_open_issue");
  const prComments = await api.pages<GitHubComment>(repositoryPath(`/issues/${pull.number}/comments`));
  const contexts = await Promise.all(targets.map(async (issue) => ({
    issue,
    pause: parsePauseState([
      ...await api.pages<GitHubComment>(repositoryPath(`/issues/${issue.number}/comments`)), ...prComments,
    ], actors.ownerActorId, actors.botActorId),
  })));
  const held = /\b(?:do not merge|do not auto[- ]merge|not for merge|not to be merged)\b|不要(?:自动)?合入|暂停自动审批/i.test(
    [pull.title, pull.body ?? "", ...issues.flatMap((issue) => [issue.title, issue.body ?? ""])].join("\n"),
  );
  if (held || contexts.some(({ pause }) => pause.active || pause.source === "unknown")) return result("held_for_human");

  const markerName = kind === "base-sync"
    ? "sayhear-pr-base-sync:v1"
    : "sayhear-pr-conflict-handoff:v1";
  const marker = `<!-- ${markerName} pr=${pull.number} head=${expected.headSha} base=${expected.baseSha} main=${currentMainSha} -->`;
  const body = kind === "base-sync"
    ? [
        `PR [#${pull.number}](https://github.com/${SAYHEAR_REPOSITORY_NAME}/pull/${pull.number}) 尚未基于当前 main，交回实现 Agent 接续。`,
        `被核验 head: \`${expected.headSha}\`；PR base: \`${expected.baseSha}\`；当前 main: \`${currentMainSha}\`。`,
        "",
        "请接续原 PR 和原分支，执行前重新读取最新 main、Issue 评论、依赖与暂停状态。同步最新 main，处理冲突，并在更新后的 head/base 上重新运行可信 PR Validate 与受影响专项，完成后继续提交原 PR 审核；不要创建重复 PR。",
        "旧 head/base 的绿色 CI、审核报告或人工绑定不能代替当前版本的验证；同步后 controller 会重新核验差异、需求摘要与授权。",
        "如 Issue 带 ready-for-human、needs-info、needs-triage 或 wontfix，本提醒保留原人工状态，等待维护者决定，不自动交给实现 Agent。",
        "这只是基线同步交接，不是代码缺陷 request changes，不增加三轮修改失败计数，也不解除暂停、人工决定、迁移或生产验收门禁。",
        "",
        marker,
      ].join("\n")
    : [
        `PR [#${pull.number}](https://github.com/${SAYHEAR_REPOSITORY_NAME}/pull/${pull.number}) 与当前 main 存在真实合并冲突，交回实现 Agent 修复。`,
        `被核验 head: \`${expected.headSha}\`；PR base: \`${expected.baseSha}\`；当前 main: \`${currentMainSha}\`。`,
        "",
        "请接续原 PR 和原分支，执行前重新读取最新 main、Issue 评论、依赖与暂停状态，解决冲突后在新 head 上运行可信 PR Validate 与受影响专项，再提交原 PR 重新审核；不要创建重复 PR。",
        "旧 head 的绿色 CI、审核报告或人工绑定不能代替修复后版本的验证；controller 会重新核验差异、需求摘要与授权。",
        "如 Issue 带 ready-for-human、needs-info、needs-triage 或 wontfix，本提醒保留原人工状态，等待维护者决定，不自动交给实现 Agent。",
        "这只是冲突修复交接，不增加三轮代码审查失败计数，也不解除暂停、人工决定、迁移或生产验收门禁。",
        "",
        marker,
      ].join("\n");
  const assertUnchanged = async () => {
    const current = await api.request<GitHubPullRequest>(repositoryPath(`/pulls/${pull.number}`));
    if (!matches(current) || (kind === "merge-conflict" && current.mergeable !== false)) {
      throw new Error("The PR changed during the Issue handoff; fresh context is required.");
    }
  };
  const completionMarker = marker.replace(" -->", " completed=true -->");
  const handedOff: number[] = [];
  await forEachLinkedIssue(targets.map((issue) => issue.number), async (number) => {
    await assertUnchanged();
    const issue = await api.request<GitHubIssue>(repositoryPath(`/issues/${number}`));
    if (issue.state !== "open") return;
    const assertIssueUnpaused = async () => {
      const latestIssue = await api.request<GitHubIssue>(repositoryPath(`/issues/${number}`));
      if (latestIssue.state !== "open") throw new Error("The Issue closed during the base-sync handoff.");
      if (/\b(?:do not merge|do not auto[- ]merge|not for merge|not to be merged)\b|不要(?:自动)?合入|暂停自动审批/i.test(`${latestIssue.title}\n${latestIssue.body ?? ""}`)) {
        throw new Error("The Issue requires a maintainer before base synchronization.");
      }
      const latestPause = parsePauseState([
        ...await api.pages<GitHubComment>(repositoryPath(`/issues/${number}/comments`)),
        ...await api.pages<GitHubComment>(repositoryPath(`/issues/${pull.number}/comments`)),
      ], actors.ownerActorId, actors.botActorId);
      if (latestPause.active || latestPause.source === "unknown") throw new Error("The Issue paused during the base-sync handoff.");
      return latestIssue;
    };
    const initialIssue = await assertIssueUnpaused();
    const existingComments = await api.pages<GitHubComment>(repositoryPath(`/issues/${number}/comments`));
    if (existingComments.some((comment) => comment.user.id === actors.botActorId && comment.body?.includes(completionMarker) === true)) {
      handedOff.push(number);
      return;
    }
    const priorCompletedHandoff = existingComments.some((comment) => comment.user.id === actors.botActorId &&
      comment.body?.includes(`<!-- ${markerName} pr=${pull.number} head=${expected.headSha} base=${expected.baseSha} main=`) === true &&
      comment.body.includes(" completed=true -->"));
    if (priorCompletedHandoff && labelNames(initialIssue).includes("ongoing") && !labelNames(initialIssue).includes("ready-for-agent")) {
      await postIssueCommentOnce(api, number, marker, body, actors.botActorId);
      handedOff.push(number);
      return;
    }
    if (existingComments.some((comment) => comment.user.id === actors.botActorId && comment.body?.includes(marker) === true) &&
      labelNames(initialIssue).includes("ongoing") && !labelNames(initialIssue).includes("ready-for-agent")) {
      throw new Error("An earlier handoff is unconfirmed and ongoing may be a new Agent claim; preserve occupancy and resolve the handoff manually.");
    }
    await postIssueCommentOnce(api, number, marker, body, actors.botActorId);
    await assertUnchanged();
    const latestIssue = await assertIssueUnpaused();
    if (labelNames(latestIssue).some((label) => ["ready-for-human", "needs-info", "needs-triage", "wontfix"].includes(label.toLowerCase()))) {
      heldIssueNumbers.push(number);
      return;
    }
    await applyIssueHandoff(api, number, "ready-for-agent", true);
    await postIssueCommentOnce(api, number, completionMarker,
      `PR #${pull.number} 的本轮 Issue 交接已完成，评论与 ready-for-agent 标签均已回读。后续认领保留 ongoing，不重复释放。\n\n${completionMarker}`, actors.botActorId);
    handedOff.push(number);
  });
  return result(heldIssueNumbers.length > 0 ? "held_for_human" : "handed_off", handedOff);
}

export async function reconcileIssueCompletion(
  api: GitHubApi,
  identity: CompletionIdentity,
): Promise<"waiting_for_merge" | "issues_completed"> {
  if (await confirmCompletionMerge(api, identity) === null) return "waiting_for_merge";
  await verifyCompletionRequirements(api, identity);
  await completeLinkedIssuesAfterMerge(api, identity.issueNumbers, { autoMergeEnabled: false, merged: true });
  return "issues_completed";
}

function completionMergeSha(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : null;
}

// The pinned API version omits merge_commit_sha and GitHub removes the pull request
// merge ref once merged, so the merged timeline event is the remaining commit evidence.
async function readMergedEventCommitSha(api: GitHubApi, pullRequestNumber: number): Promise<string | null> {
  const events = await api.pages<JsonRecord>(repositoryPath(`/issues/${pullRequestNumber}/timeline`));
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.event !== "merged") continue;
    const mergeSha = completionMergeSha(event.commit_id);
    if (mergeSha !== null) return mergeSha;
  }
  return null;
}

// Luke's review can be dismissed after the merge or between scans. Both the
// post-merge Issue completion and any repeated merge request re-read the live
// human approval so a revocation is never carried into a later action.
function assertLiveBrowserApproval(reviews: readonly GitHubReview[], identity: CompletionIdentity): void {
  let latest;
  try { latest = latestLukeReview(reviews); }
  catch { throw new CompletionMismatch("human_review_metadata_invalid"); }
  if (!latest || latest.id !== identity.humanReviewId || latest.state !== "APPROVED" || latest.headSha !== identity.headSha) {
    throw new CompletionMismatch("human_review_revoked");
  }
}

export async function guardImmediateMerge(config: ControllerConfig, identity: CompletionIdentity): Promise<Readonly<{
  report: ModelReviewReport; repository: JsonRecord; pullRequest: GitHubPullRequest;
}>> {
  if (identity.policyVersion !== PR_REVIEW_GATE_POLICY_VERSION || !identity.reviewIdentity || identity.mergeAction !== "merge-now" ||
      parseIntegrationMode(config.app.integrationMode) !== (identity.integrationMode ?? "up-to-date-base")) {
    throw new CompletionMismatch("fresh_merge_authorization_required");
  }
  const initial = await readSnapshot(config, identity.pullRequestNumber);
  const saved = await readSavedReviewReport(config, initial);
  if (!saved || saved.report.baseSha !== identity.approvedBaseSha || saved.report.headSha !== identity.headSha ||
      saved.report.requirementDigest !== identity.requirementDigest || saved.report.policyVersion !== identity.policyVersion) {
    throw new CompletionMismatch("saved_review_identity_mismatch");
  }
  const report = saved.report;
  const snapshot = await withReviewSafety(config, await readSnapshot(config, identity.pullRequestNumber, report.declaredImpacts, report.capability), report);
  if (snapshot.diff.digest !== identity.reviewIdentity.diffDigest || snapshot.diff.changeDigest !== identity.reviewIdentity.changeDigest ||
      await readHeadWorkflowBlob(config.api, identity.headSha) !== identity.reviewIdentity.workflowBlobSha) throw new CompletionMismatch("review_content_mismatch");
  if (await refreshStaleIntegration(config, snapshot)) throw new CompletionUnavailable("waiting_for_integration_validation");
  const { gate } = evaluateSnapshot(config, snapshot, report);
  if (gate.outcome !== "merge_candidate") throw new CompletionUnavailable(gate.reasons.some((reason) => reason.code === "stale_base_review_risk") ? "stale_base_review_risk" : "fresh_merge_gate_blocked");
  if (browserAuthorizationRequired(snapshot.humanBinding, snapshot.gateInput.pullRequest.changedFiles)) {
    const human = snapshot.humanBinding.receipt;
    if (identity.humanChannel !== "browser" || !human || human.reviewId !== identity.humanReviewId || human.challenge.epoch !== identity.epoch ||
        (identity.integrationMode === "serialized-merge" && human.challenge.context.reviewBinding !== "head-v2")) throw new CompletionMismatch("human_review_binding_changed");
  } else if (identity.humanChannel === "browser") {
    const human = snapshot.humanBinding.receipt;
    if (!human || human.reviewId !== identity.humanReviewId || human.challenge.epoch !== identity.epoch) throw new CompletionMismatch("human_review_binding_changed");
  }
  const approval = await findExistingAppReview(config, report);
  if (!approval || approval.id !== identity.reviewId || approval.state !== "APPROVED" || appReviewOutcomeForIdentity(approval.body, report) !== "approve") throw new CompletionMismatch("reviewer_mismatch");
  await verifyCompletionRequirements(config.api, identity);
  const [repository, pullRequest, main] = await Promise.all([
    readRepositoryMergeSettings(config.api),
    config.api.request<GitHubPullRequest>(repositoryPath(`/pulls/${identity.pullRequestNumber}`)),
    config.api.request<JsonRecord>(repositoryPath("/git/ref/heads/main")),
  ]);
  if (pullRequest.state !== "open" || pullRequest.draft || pullRequest.auto_merge !== null ||
      pullRequest.head.sha !== identity.headSha || pullRequest.head.repo?.id !== SAYHEAR_REPOSITORY_ID ||
      pullRequest.base.ref !== "main" || !isRecord(pullRequest.base.repo) || pullRequest.base.repo.id !== SAYHEAR_REPOSITORY_ID ||
      !isRecord(main.object) || main.object.sha !== snapshot.gateInput.repository.defaultBranchSha ||
      await readCurrentPullRequestMergeSha(config.api, pullRequest, snapshot.gateInput.repository.defaultBranchSha) !== snapshot.gateInput.pullRequest.mergeSha ||
      mergeActionFor(snapshot.humanBinding, pullRequest, integrationModeOf(snapshot.gateInput)) !== "merge-now") {
    throw new CompletionUnavailable("integration_changed_before_merge");
  }
  return { report, repository, pullRequest };
}

export async function confirmCompletionMerge(api: GitHubApi, identity: CompletionIdentity): Promise<string | null> {
  let raw: unknown;
  try { raw = await api.request<unknown>(repositoryPath(`/pulls/${identity.pullRequestNumber}`)); }
  catch (error) {
    if (error instanceof GitHubApiError) {
      if (error.status !== 429 && error.status !== 403 && error.status < 500) throw new CompletionMismatch(`completion_http_${error.status}`);
      throw new CompletionUnavailable("completion_http_retry", error.retryAfterMs);
    }
    throw new CompletionUnavailable("completion_network_unavailable");
  }
  if (!isRecord(raw) || !isRecord(raw.head) || !isRecord(raw.base) || !isRecord(raw.head.repo) || !isRecord(raw.base.repo) ||
    typeof raw.number !== "number" || typeof raw.node_id !== "string" || typeof raw.head.sha !== "string" ||
    typeof raw.head.repo.id !== "number" || typeof raw.base.repo.id !== "number" || typeof raw.base.ref !== "string" ||
    typeof raw.merged !== "boolean" || (raw.state !== "open" && raw.state !== "closed")) {
    throw new CompletionUnavailable("completion_fields_missing");
  }
  const mismatches = [
    [raw.number === identity.pullRequestNumber && raw.node_id === identity.pullRequestNodeId, "pr_identity_mismatch"],
    [raw.head.repo.id === identity.repositoryId && raw.base.repo.id === identity.baseRepositoryId, "repository_mismatch"],
    [raw.head.sha.toLowerCase() === identity.headSha, "head_mismatch"],
    [raw.base.ref === identity.baseRef, "base_mismatch"],
  ] as const;
  for (const [matches, reason] of mismatches) if (!matches) throw new CompletionMismatch(reason);
  if (raw.merged && raw.state !== "closed") throw new CompletionUnavailable("completion_state_contradictory");
  if (!raw.merged) {
    if (raw.state === "closed") throw new CompletionMismatch("closed_without_merge");
    return null;
  }
  const mergeSha = completionMergeSha(raw.merge_commit_sha) ?? await readMergedEventCommitSha(api, identity.pullRequestNumber);
  if (mergeSha === null) throw new CompletionUnavailable("merge_sha_missing");
  const reviews = await api.pages<GitHubReview>(repositoryPath(`/pulls/${identity.pullRequestNumber}/reviews`));
  const review = reviews.find((value) => value.id === identity.reviewId);
  if (!review) throw new CompletionUnavailable("approval_readback_missing");
  if (!isRecord(review.user) || typeof review.user.id !== "number" || typeof review.commit_id !== "string" || typeof review.state !== "string") throw new CompletionUnavailable("approval_fields_missing");
  const reportIdentity = { pullRequestNumber: identity.pullRequestNumber, headSha: identity.headSha, baseSha: identity.approvedBaseSha, requirementDigest: identity.requirementDigest };
  if (review.user.id !== identity.botActorId || review.commit_id.toLowerCase() !== identity.headSha || review.state !== "APPROVED" ||
    appReviewOutcomeForIdentity(review.body, reportIdentity) !== "approve" ||
    reviews.some((candidate) => candidate.id > identity.reviewId && candidate.user.id === identity.botActorId && candidate.commit_id.toLowerCase() === identity.headSha && candidate.state === "CHANGES_REQUESTED")) {
    throw new CompletionMismatch("reviewer_mismatch");
  }
  if (identity.humanChannel === "browser") assertLiveBrowserApproval(reviews, identity);
  return mergeSha;
}

export async function verifyCompletionRequirements(
  api: GitHubApi,
  identity: CompletionIdentity,
  projection: RequirementProjection = requirementProjectionFor(identity.policyVersion),
): Promise<void> {
  const pull = await api.request<GitHubPullRequest>(repositoryPath(`/pulls/${identity.pullRequestNumber}`));
  const issues = await resolveLinkedIssues(api, pull);
  const [comments, reviewComments, reviews] = await Promise.all([
    api.pages<GitHubComment>(repositoryPath(`/issues/${pull.number}/comments`)),
    api.pages<GitHubComment>(repositoryPath(`/pulls/${pull.number}/comments`)),
    api.pages<GitHubReview>(repositoryPath(`/pulls/${pull.number}/reviews`)),
  ]);
  const requirements = await Promise.all(issues.map(async (issue) => ({
    number: issue.number, title: issue.title, body: issue.body ?? "", updatedAt: issue.updated_at,
    discussionDigest: digestDiscussion((await api.pages<GitHubComment>(repositoryPath(`/issues/${issue.number}/comments`))).filter((comment) => comment.user.id !== identity.botActorId), [], projection),
  })));
  const content = requirementDigest(requirements, { number: pull.number, title: pull.title, body: pull.body ?? "", updatedAt: pull.updated_at, discussionDigest: digestDiscussion(
    [...comments, ...reviewComments].filter((comment) => comment.user.id !== identity.botActorId && !isVercelDeploymentStatus(comment)),
    reviews.filter((review) => review.user.id !== identity.botActorId),
    projection,
  ) });
  if (content !== identity.requirementDigest) throw new CompletionMismatch("requirement_content_mismatch");
}

export async function recoverControllerCompletion(config: ControllerConfig, receipt: CompletionRecord, clock?: CompletionClock): Promise<CompletionRecord> {
  if (!config.completionStore) throw new Error("Trusted completion store unavailable.");
  let latest = receipt;
  const store = config.completionStore;
  const trackedStore: CompletionStore = {
    read: (number) => store.read(number), list: () => store.list(),
    save: async (value) => {
      latest = { ...value, ...(latest.mergeWriteState ? { mergeWriteState: latest.mergeWriteState } : {}) };
      await store.save(latest);
    },
  };
  const recovered = await recoverCompletion(trackedStore, receipt, {
    confirmMerge: async (identity) => {
      if (identity.repositoryId !== SAYHEAR_REPOSITORY_ID || identity.baseRepositoryId !== SAYHEAR_REPOSITORY_ID || identity.baseRef !== "main" ||
        identity.botActorId !== config.botActorId || identity.appId !== config.app.appId ||
        !RECEIPT_POLICY_VERSIONS.includes(identity.policyVersion)) throw new CompletionMismatch("trusted_identity_mismatch");
      const confirmed = await confirmCompletionMerge(config.api, identity);
      if (confirmed !== null) return confirmed;
      // An uncertain request may still be executing on GitHub. Only a proven
      // rejection or an intent never sent is eligible for a new guarded write.
      if (latest.mergeWriteState !== "not-sent" && latest.mergeWriteState !== "rejected") return null;
      const guarded = await guardImmediateMerge(config, identity);
      latest = { ...latest, mergeWriteState: "uncertain" };
      await store.save(latest);
      try {
        await applyMergeAction(config, guarded.report, guarded.repository, guarded.pullRequest, "merge-now");
        latest = { ...latest, mergeWriteState: "accepted" };
        await store.save(latest);
      } catch (error) {
        if (definitiveMergeRejection(error)) {
          latest = { ...latest, mergeWriteState: "rejected" };
          await store.save(latest);
        }
        throw error;
      }
      return confirmCompletionMerge(config.api, identity);
    },
    completeIssues: async (identity) => {
      await verifyCompletionRequirements(config.api, identity);
      await completeLinkedIssuesAfterMerge(config.api, identity.issueNumbers, { autoMergeEnabled: false, merged: true });
    },
  }, clock);
  return { ...recovered, ...(latest.mergeWriteState ? { mergeWriteState: latest.mergeWriteState } : {}) };
}

export async function completionBlockingScope(api: GitHubApi, receipt: CompletionRecord): Promise<"none" | "this-pr" | "repository"> {
  if (receipt.phase === "complete") return "none";
  if (receipt.mergeSha !== null) return "this-pr";
  if ((receipt.mergeWriteState !== "rejected" && receipt.mergeWriteState !== "not-sent") || receipt.identity.mergeAction !== "merge-now" ||
      receipt.identity.policyVersion !== PR_REVIEW_GATE_POLICY_VERSION || !receipt.identity.reviewIdentity || receipt.reason === "trusted_identity_mismatch") return "repository";
  try {
    const pull = await api.request<GitHubPullRequest>(repositoryPath(`/pulls/${receipt.identity.pullRequestNumber}`));
    if (pull.merged === false && pull.auto_merge === null && (pull.state === "open" || pull.state === "closed") && pull.head.sha === receipt.identity.headSha &&
        pull.base.ref === receipt.identity.baseRef && isRecord(pull.base.repo) && pull.base.repo.id === receipt.identity.baseRepositoryId) return "this-pr";
  } catch { /* Unreadable merge state remains repository blocking. */ }
  return "repository";
}

async function retryPendingIssueCompletions(config: ControllerConfig, prepareOnly: boolean): Promise<Array<Readonly<Record<string, unknown>>>> {
  if (!config.completionStore) throw new Error("Trusted completion store unavailable.");
  const results: Array<Readonly<Record<string, unknown>>> = [];
  for (const receipt of await config.completionStore.list()) {
    if (receipt.phase === "complete") continue;
    const recovered = prepareOnly ? receipt : await recoverControllerCompletion(config, receipt);
    results.push({ pullRequest: receipt.identity.pullRequestNumber, status: recovered.phase === "complete" ? "issues_completed" : "issue_completion_pending",
      blocks: await completionBlockingScope(config.api, recovered),
      phase: recovered.phase, attempts: recovered.attempts, nextRetryAt: recovered.nextRetryAt, reason: recovered.reason, mergeSha: recovered.mergeSha });
  }
  return results;
}

export async function requestDeferredMerge(
  config: ControllerConfig,
  report: ModelReviewReport,
  gate: Pick<PrReviewGateReport, "outcome" | "deferredEvidence">,
  repository: JsonRecord,
  pullRequest: GitHubPullRequest,
): Promise<Readonly<{ outcome: string; message: string }>> {
  if (parseIntegrationMode(config.app.integrationMode) === "serialized-merge") {
    return { outcome: "human_decision", message: "Serialized merge cannot arm deferred auto-merge; complete required acceptance first." };
  }
  if (authorizationChannel(pullRequest.user) !== "legacy-root") {
    return {
      outcome: "human_decision",
      message: "Deferred pre-merge checks require the legacy root channel; the current PR author cannot use deferred auto-merge.",
    };
  }
  await requestPullRequestAutoMerge(config, report, repository, pullRequest);
  const readback = await config.api.request<GitHubPullRequest>(
    repositoryPath(`/pulls/${report.pullRequestNumber}`),
  );
  if (
    !isRecord(readback.auto_merge) &&
    (readback.merged !== true || readback.state !== "closed" ||
      readback.head.sha.toLowerCase() !== report.headSha.toLowerCase() ||
      readback.base.ref !== "main")
  ) {
    throw new Error("GitHub did not retain the requested auto-merge state.");
  }
  return {
    outcome: gate.outcome,
    message: [
      isRecord(readback.auto_merge)
        ? `GitHub auto-merge is enabled for PR #${report.pullRequestNumber}.`
        : `PR #${report.pullRequestNumber} merged while the controller read back its state.`,
      `${gate.deferredEvidence.length} pre-merge check(s) are deferred and run at acceptance; the Issues stay open until they do.`,
    ].join(" "),
  };
}

export async function refreshStaleIntegration(config: ControllerConfig, snapshot: Snapshot): Promise<boolean> {
  if (integrationModeOf(snapshot.gateInput) !== "serialized-merge" || snapshot.staleIntegrationRunId === null) return false;
  const pull = snapshot.gateInput.pullRequest;
  if (!pull.mergeSha || pull.mergeable !== true || containsExplicitMergeHold(snapshot) || pull.issueClosureAmbiguous ||
      snapshot.gateInput.issues.some((issue) => !pull.keepOpenIssueNumbers.includes(issue.number) && issue.state === "open" &&
        (!issue.labels.includes("ongoing") || issue.pause.active || issue.pause.source === "unknown" ||
          issue.labels.some((label) => ["ready-for-human", "needs-info", "needs-triage", "wontfix"].includes(label)) ||
          (issue.blockedBy === null || issue.blockedBy.some((dependency) => !snapshot.gateInput.issues.some((target) => target.number === dependency && !pull.keepOpenIssueNumbers.includes(target.number))))))) return true;
  if (!config.integrationRefreshStore) throw new Error("integration_refresh_store_unavailable");
  await requestIntegrationRefresh(config.integrationRefreshStore, pull.number,
    { headSha: pull.headSha, mainSha: snapshot.gateInput.repository.defaultBranchSha, mergeSha: pull.mergeSha },
    snapshot.staleIntegrationRunId, {
      recheck: async () => {
        const [freshPull, main] = await Promise.all([
          config.api.request<GitHubPullRequest>(repositoryPath(`/pulls/${pull.number}`)),
          config.api.request<JsonRecord>(repositoryPath("/git/ref/heads/main")),
        ]);
        return freshPull.state === "open" && !freshPull.draft && freshPull.auto_merge === null &&
          freshPull.base.ref === "main" && freshPull.head.repo?.id === SAYHEAR_REPOSITORY_ID &&
          freshPull.head.sha === pull.headSha && freshPull.mergeable === true &&
          isRecord(main.object) && main.object.sha === snapshot.gateInput.repository.defaultBranchSha &&
          await readCurrentPullRequestMergeSha(config.api, freshPull, snapshot.gateInput.repository.defaultBranchSha) === pull.mergeSha;
      },
      labels: async () => (await config.api.pages<JsonRecord>(repositoryPath(`/issues/${pull.number}/labels`)))
        .map((label) => recordString(label, "name")),
      prepareLabel: async (label) => {
        try { await config.api.request(repositoryPath(`/labels/${encodeURIComponent(label)}`)); }
        catch (error) {
          if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
          await config.api.request(repositoryPath("/labels"), { method: "POST", body: { name: label, color: "ededed", description: "Current-main integration validation request" } });
        }
      },
      addLabel: async (label) => {
        await config.api.request(repositoryPath(`/issues/${pull.number}/labels`), { method: "POST", body: { labels: [label] } });
      },
      definitiveRejection: (error) => error instanceof GitHubApiError &&
        [400, 401, 403, 404, 405, 409, 422].includes(error.status),
    });
  return true;
}

// The browser channel's only outstanding input is Luke's live approval on the
// current head. That is a wait, not a handoff: handing the Issue back to an
// implementation agent would let it push a new head and void the challenge the
// PR is already waiting on. Every other `human_decision` cause still hands off.
export function isBrowserApprovalWait(gate: PrReviewGateReport): boolean {
  return gate.outcome === "human_decision" &&
    gate.reasons.some((reason) => reason.code === "browser_human_approval_required");
}

// `reportReviewResult` re-reads live state and can throw on an untrusted review
// history, an unreadable head workflow blob, or a refused App approval. One PR
// must never abort the rest of the scan: it is reported as blocked instead, and
// the other PRs and their Issue handoffs still run.
async function reportReviewOutcome(
  config: ControllerConfig,
  report: ModelReviewReport,
): Promise<Readonly<{ outcome: string; message: string }>> {
  try {
    return await reportReviewResult(config, report);
  } catch (error) {
    return { outcome: "blocked", message: error instanceof Error ? error.message : String(error) };
  }
}

async function reportReviewResult(
  config: ControllerConfig,
  input: unknown,
): Promise<Readonly<{ outcome: string; message: string }>> {
  const report = parseModelReviewReport(input);
  const pending = await retryPendingIssueCompletions(config, false);
  if (pending.some((result) => result.blocks === "repository")) return { outcome: "awaiting_verification", message: "An uncertain merge operation still blocks repository writes." };
  if (config.completionStore && await config.completionStore.read(report.pullRequestNumber)) return { outcome: "awaiting_verification", message: "This PR already has a durable merge intent; no merge will be repeated." };
  if (report.repositoryId !== SAYHEAR_REPOSITORY_ID) {
    throw new Error("The review report names a different repository.");
  }
  const snapshot = await withReviewSafety(config, await readSnapshot(
    config, report.pullRequestNumber, report.declaredImpacts, report.capability,
  ), report);
  // In merge-queue mode a stale base is the normal state: the queue builds the
  // merged result against the current main, so main moving must not dispatch an
  // implementation agent to rebase an already-reviewed head.
  if (integrationModeOf(snapshot.gateInput) === "up-to-date-base" &&
    snapshot.gateInput.pullRequest.baseSha !== snapshot.gateInput.repository.defaultBranchSha &&
    report.headSha === snapshot.gateInput.pullRequest.headSha && report.baseSha === snapshot.gateInput.pullRequest.baseSha &&
    report.version === PR_REVIEW_REPORT_VERSION && report.policyVersion === PR_REVIEW_GATE_POLICY_VERSION &&
    report.requirementDigest === requirementDigest(snapshot.gateInput.issues, snapshot.gateInput.pullRequest)) {
    const handoff = await handoffStalePullRequestBase(config.api, snapshot.gateInput.pullRequest, config);
    return { outcome: "awaiting_verification", message: handoff.status === "handed_off"
      ? `PR #${report.pullRequestNumber} requires main synchronization; Issues ${handoff.issueNumbers.join(", ")} were handed back.`
      : `PR #${report.pullRequestNumber} base-sync handoff stopped at ${handoff.status}.` };
  }
  if (integrationModeOf(snapshot.gateInput) === "serialized-merge" && snapshot.baseReviewSafe !== true) {
    return { outcome: "awaiting_verification", message: "stale_base_review_risk: current main introduces material or unknown review risk; prepare a fresh review anchored to current main." };
  }
  if (await refreshStaleIntegration(config, snapshot)) {
    return { outcome: "awaiting_verification", message: "Waiting for current-main integration Validate; no Issue handoff was created." };
  }
  const { gate } = evaluateSnapshot(config, snapshot, report);
  await upsertCheckRun(config, snapshot, report, gate);

  if (gate.reasons.some((reason) => reason.code === "pull_request_conflict")) {
    const handoff = await handoffStalePullRequestBase(
      config.api,
      snapshot.gateInput.pullRequest,
      config,
      { kind: "merge-conflict" },
    );
    return {
      outcome: "awaiting_verification",
      message: handoff.status === "handed_off"
        ? `PR #${report.pullRequestNumber} conflicts with current main; Issues ${handoff.issueNumbers.join(", ")} were handed back for conflict repair.`
        : `PR #${report.pullRequestNumber} conflict handoff stopped at ${handoff.status}.`,
    };
  }

  if (gate.outcome === "request_changes") {
    const review = await submitPullRequestReview(config, report, []);
    await recordReviewHandoff(config, snapshot, report, gate, review);
    return {
      outcome: gate.outcome,
      message: `Posted request changes for PR #${report.pullRequestNumber} at ${report.headSha}.`,
    };
  }

  if (gate.outcome === "awaiting_verification" && isReviewStillPending(snapshot, gate)) {
    return {
      outcome: gate.outcome,
      message: `Waiting for PR Validate evidence for PR #${report.pullRequestNumber}; no Issue dispatch was created.`,
    };
  }

  // An agent-authored PR whose only outstanding input is Luke's bound browser
  // approval is a wait, not a handoff. A handoff would clear `ongoing`, set
  // `ready-for-agent`, let an implementation agent claim the Issue and push a new
  // head, which voids the frozen challenge this PR is already waiting on. The gate
  // still reports human_decision so the check run asks Luke to act (action_required).
  if (isBrowserApprovalWait(gate)) {
    return {
      outcome: "awaiting_verification",
      message:
        `PR #${report.pullRequestNumber} is agent-authored and touches a protected path; a live browser approval from @lukemyself-hub on the current head is required before any merge. The Issue handoff was left unchanged.`,
    };
  }

  if (gate.outcome === "awaiting_verification" || gate.outcome === "human_decision") {
    await postNonBlockingOutcome(config, snapshot, report, gate);
    return {
      outcome: gate.outcome,
      message: `Recorded ${gate.outcome} for PR #${report.pullRequestNumber} and updated the Issue handoff.`,
    };
  }

  const approval = await submitPullRequestReview(
    config,
    report,
    gate.deferredEvidence,
  );
  if (
    approval.state !== "APPROVED" ||
    approval.user.id !== config.botActorId ||
    approval.commit_id.toLowerCase() !== report.headSha.toLowerCase()
  ) {
    throw new Error("GitHub did not retain the expected independent App approval.");
  }
  const freshSnapshot = await withReviewSafety(config, await readSnapshot(
    config, report.pullRequestNumber, report.declaredImpacts, report.capability,
  ), report);
  const { gate: freshGate } = evaluateSnapshot(config, freshSnapshot, report);
  if (freshGate.outcome !== gate.outcome) {
    await upsertCheckRun(config, freshSnapshot, report, freshGate);
    await postNonBlockingOutcome(config, freshSnapshot, report, {
      ...freshGate,
      outcome: "human_decision",
      deferredEvidence: [],
      reasons: [
        {
          code: "review_state_changed",
          message:
            "The PR, Issue, CI, or branch protection changed while approval was being published.",
        },
      ],
    });
    return {
      outcome: "human_decision",
      message: `Approval for PR #${report.pullRequestNumber} is held because its state changed.`,
    };
  }

  const latestRepository = await readRepositoryMergeSettings(config.api);
  const latestPullRequest = await config.api.request<GitHubPullRequest>(
    repositoryPath(`/pulls/${report.pullRequestNumber}`),
  );
  if (
    latestPullRequest.head.sha.toLowerCase() !== report.headSha.toLowerCase() ||
    (integrationModeOf(freshSnapshot.gateInput) === "up-to-date-base" && latestPullRequest.base.sha.toLowerCase() !== report.baseSha.toLowerCase())
  ) {
    const staleGate: PrReviewGateReport = {
      ...freshGate,
      outcome: "awaiting_verification",
      deferredEvidence: [],
      reasons: [
        {
          code: "head_or_base_changed_before_auto_merge",
          message:
            "The PR head or base changed after approval; fresh review and CI evidence are required.",
        },
      ],
    };
    await upsertCheckRun(config, freshSnapshot, report, staleGate);
    await postNonBlockingOutcome(config, freshSnapshot, report, staleGate);
    return {
      outcome: staleGate.outcome,
      message: `Auto-merge was not enabled for PR #${report.pullRequestNumber} because its head or base changed.`,
    };
  }
  if (freshGate.outcome === "merge_candidate_with_deferrals") {
    return requestDeferredMerge(config, report, freshGate, latestRepository, latestPullRequest);
  }
  if (!config.completionStore) throw new Error("Trusted completion store unavailable.");
  const baseRepository = latestPullRequest.base.repo;
  if (!isRecord(baseRepository) || baseRepository.id !== SAYHEAR_REPOSITORY_ID) throw new Error("The target base repository is unavailable.");
  const browserReceipt = freshSnapshot.humanBinding.receipt;
  if (browserAuthorizationRequired(freshSnapshot.humanBinding, freshSnapshot.gateInput.pullRequest.changedFiles) &&
      browserReceipt === null) {
    // Fail closed without throwing: an agent-authored PR whose browser approval
    // is missing or no longer live must wait here, never merge and never break
    // the rest of the scan.
    return {
      outcome: "awaiting_verification",
      message: `PR #${report.pullRequestNumber} is agent-authored; a live browser approval on the current head is required before any merge.`,
    };
  }
  const mergeAction = mergeActionFor(
    freshSnapshot.humanBinding,
    latestPullRequest,
    integrationModeOf(freshSnapshot.gateInput),
  );
  if (mergeAction === "wait") {
    // Nothing is armed and no durable intent is written while the PR is not
    // cleanly mergeable. A saved intent would only be confirmed later, which
    // would strand an approved merge; the saved review report lets the next
    // scan retry the pinned merge once the state is clean.
    return {
      outcome: "awaiting_verification",
      message: `PR #${report.pullRequestNumber} is approved but not cleanly mergeable; the merge waits for a clean state.`,
    };
  }
  const receipt: CompletionRecord = {
    version: 1, phase: "merge_unconfirmed", attempts: 0, nextRetryAt: 0, reason: null, mergeSha: null,
    mergeWriteState: mergeAction === "merge-now" ? "not-sent" : "uncertain",
    identity: {
      repositoryId: SAYHEAR_REPOSITORY_ID, pullRequestNumber: report.pullRequestNumber,
      pullRequestNodeId: recordString(latestPullRequest, "node_id"), headSha: report.headSha,
      approvedBaseSha: report.baseSha, requirementDigest: report.requirementDigest,
      baseRepositoryId: SAYHEAR_REPOSITORY_ID, baseRef: "main", botActorId: config.botActorId,
      reviewId: approval.id, appId: config.app.appId, policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
      issueNumbers: freshSnapshot.gateInput.issues.filter((issue) => !freshSnapshot.gateInput.pullRequest.keepOpenIssueNumbers.includes(issue.number)).map((issue) => issue.number),
      humanChannel: browserReceipt === null ? "app" : "browser",
      humanReviewId: browserReceipt?.reviewId ?? approval.id,
      epoch: browserReceipt?.challenge.epoch ?? null,
      integrationMode: integrationModeOf(freshSnapshot.gateInput),
      ...(mergeAction === "merge-now" ? { mergeAction: "merge-now" as const, reviewIdentity: {
        diffDigest: freshSnapshot.diff.digest, changeDigest: freshSnapshot.diff.changeDigest,
        workflowBlobSha: await readHeadWorkflowBlob(config.api, report.headSha),
      } } : {}),
    },
  };
  if (await config.completionStore.read(report.pullRequestNumber)) throw new Error("An existing completion intent must be reconciled before any new merge request.");
  await config.completionStore.save(receipt);
  const sentReceipt = receipt;
  if (mergeAction !== "merge-now") {
    try { await applyMergeAction(config, report, latestRepository, latestPullRequest, mergeAction); }
    catch { /* An armed or uncertain deferred action remains repository blocking. */ }
  }
  const completed = await recoverControllerCompletion(config, sentReceipt);
  const mergeSha = completed.mergeSha === null ? "" : `; merged=${completed.mergeSha}`;
  return {
    outcome: completed.phase === "complete" ? "merge_candidate" : "awaiting_verification",
    message: completed.phase === "complete"
      ? `PR #${report.pullRequestNumber} merged and Issue completion was verified.`
      : `PR #${report.pullRequestNumber} completion remains ${completed.phase}; ${completed.reason ?? "pending confirmation"}${mergeSha}.`,
  };
}

function controllerReviewReport(
  snapshot: Snapshot,
  decision: ModelReviewReport["decision"],
): ModelReviewReport {
  const pullRequest = snapshot.gateInput.pullRequest;
  return {
    version: PR_REVIEW_REPORT_VERSION,
    policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
    repositoryId: SAYHEAR_REPOSITORY_ID,
    pullRequestNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    baseSha: integrationModeOf(snapshot.gateInput) === "serialized-merge" ? snapshot.gateInput.repository.defaultBranchSha : pullRequest.baseSha,
    requirementDigest: requirementDigest(
      snapshot.gateInput.issues,
      pullRequest,
    ),
    decision,
    diffComplete: snapshot.diff.complete,
    declaredImpacts: [],
    capability: {
      newCapabilityEnabled: false,
      majorContractChange: false,
      externalMvpRelease: false,
    },
    riskFlags: {
      productDefinitionChanged: false,
      authorizationBoundaryChanged: false,
      privacyBoundaryChanged: false,
      destructiveMigration: false,
      productionFeatureEnablement: false,
    },
    findings: [],
  };
}

function containsExplicitMergeHold(snapshot: Snapshot): boolean {
  return /\b(?:do not merge|do not auto[- ]merge|not for merge|not to be merged)\b|不要(?:自动)?合入|暂停自动审批/i.test(
    [
      snapshot.gateInput.pullRequest.title,
      snapshot.gateInput.pullRequest.body,
      ...snapshot.gateInput.issues.flatMap((issue) => [issue.title, issue.body]),
    ].join("\n"),
  );
}

async function writeReviewPacketFile(
  snapshot: Snapshot,
): Promise<string> {
  const pullRequest = snapshot.gateInput.pullRequest;
  const directory = resolve(REVIEW_ARTIFACT_DIRECTORY, "packets");
  const filePath = resolve(
    directory,
    `pr-${pullRequest.number}-${pullRequest.headSha.slice(0, 12)}.json`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const packet = reviewPacket(snapshot);
  await writeFile(filePath, `${JSON.stringify(packet, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return filePath;
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`Unexpected argument ${String(flag)}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Argument ${flag} requires a value.`);
    }
    if (args.has(flag)) {
      throw new Error(`Argument ${flag} may be specified only once.`);
    }
    args.set(flag, value);
    index += 1;
  }
  return args;
}

function assertAllowedArgs(
  command: string,
  args: Map<string, string>,
): void {
  const allowed: Readonly<Record<string, readonly string[]>> = {
    configure: [
      "--app-id",
      "--installation-id",
      "--slug",
      "--production-merge-authorized",
      "--ordinary-merge-triggers-production",
      "--integration-mode",
    ],
    status: [],
    prepare: ["--pr"],
    scan: ["--pr"],
    resume: ["--pr"],
    submit: ["--report"],
  };
  const known = allowed[command];
  if (!known) return;
  for (const flag of args.keys()) {
    if (!known.includes(flag)) {
      throw new Error(`${command} does not accept ${flag}.`);
    }
  }
}

function requestedPullNumber(args: Map<string, string>): number | null {
  const value = args.get("--pr");
  if (value === undefined) return null;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("--pr must be a positive GitHub pull request number.");
  }
  return requiredPositiveInteger(Number(value), "--pr");
}

export async function scanPullRequests(
  config: ControllerConfig,
  onlyPullNumber: number | null,
  prepareOnly = false,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const results = await retryPendingIssueCompletions(config, prepareOnly);
  if (results.some((result) => result.blocks === "repository")) return results;
  const pullRequests = onlyPullNumber === null
    ? await config.api.pages<GitHubPullRequest>(
        repositoryPath("/pulls?state=open"),
      )
    : [
        await config.api.request<GitHubPullRequest>(
          repositoryPath(`/pulls/${onlyPullNumber}`),
        ),
      ];

  for (const pullRequest of pullRequests) {
    if (results.some((result) => result.pullRequest === pullRequest.number)) continue;
    if (pullRequest.state !== "open") continue;
    if (
      pullRequest.draft ||
      pullRequest.base.ref !== "main" ||
      pullRequest.head.repo?.id !== SAYHEAR_REPOSITORY_ID
    ) {
      results.push({
        pullRequest: pullRequest.number,
        status: "skipped",
        reason: "PR must be Ready for review and target main in this repository.",
      });
      continue;
    }

    let snapshot: Snapshot;
    try {
      snapshot = await readSnapshot(config, pullRequest.number, [], undefined, { freezeBrowserChallenge: prepareOnly });
    } catch (error) {
      results.push({
        pullRequest: pullRequest.number,
        status: "blocked",
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (
      integrationModeOf(snapshot.gateInput) === "up-to-date-base" &&
      snapshot.gateInput.pullRequest.baseSha !== snapshot.gateInput.repository.defaultBranchSha
    ) {
      const packetPath = await writeReviewPacketFile(snapshot);
      if (prepareOnly) {
        results.push({
          pullRequest: pullRequest.number, status: "waiting_for_current_base", handoffRequired: true,
          headSha: snapshot.gateInput.pullRequest.headSha, baseSha: snapshot.gateInput.pullRequest.baseSha,
          currentMainSha: snapshot.gateInput.repository.defaultBranchSha, packetPath,
        });
      } else {
        try {
          const handoff = await handoffStalePullRequestBase(config.api, snapshot.gateInput.pullRequest, config);
          results.push({ pullRequest: pullRequest.number, status: "waiting_for_current_base", packetPath,
            handedOff: handoff.status === "handed_off", handoffStatus: handoff.status,
            currentMainSha: handoff.currentMainSha, issueNumbers: handoff.issueNumbers, heldIssueNumbers: handoff.heldIssueNumbers });
        } catch (error) {
          results.push({ pullRequest: pullRequest.number, status: "base_sync_handoff_incomplete", packetPath,
            reason: error instanceof Error ? error.message : String(error) });
        }
      }
      continue;
    }

    if (snapshot.gateInput.pullRequest.mergeable === false) {
      if (prepareOnly) {
        results.push({
          pullRequest: pullRequest.number,
          status: "pull_request_conflict",
          handoffRequired: true,
          headSha: snapshot.gateInput.pullRequest.headSha,
          baseSha: snapshot.gateInput.pullRequest.baseSha,
        });
      } else {
        try {
          const handoff = await handoffStalePullRequestBase(
            config.api,
            snapshot.gateInput.pullRequest,
            config,
            { kind: "merge-conflict" },
          );
          results.push({
            pullRequest: pullRequest.number,
            status: "pull_request_conflict",
            handedOff: handoff.status === "handed_off",
            handoffStatus: handoff.status,
            issueNumbers: handoff.issueNumbers,
            heldIssueNumbers: handoff.heldIssueNumbers,
          });
        } catch (error) {
          results.push({
            pullRequest: pullRequest.number,
            status: "conflict_handoff_incomplete",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      continue;
    }

    if (!prepareOnly) {
      try {
        if (await refreshStaleIntegration(config, snapshot)) {
          results.push({ pullRequest: pullRequest.number, status: "waiting_for_validation", reason: "Current-main integration validation requested or awaiting reconciliation." });
          continue;
        }
      } catch (error) {
        results.push({ pullRequest: pullRequest.number, status: "integration_refresh_blocked",
          reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    const saved = await readSavedReviewReport(config, snapshot);
    if (saved) {
      if (prepareOnly) {
        results.push({
          pullRequest: pullRequest.number,
          status: "saved_review_available",
          headSha: snapshot.gateInput.pullRequest.headSha,
          baseSha: snapshot.gateInput.pullRequest.baseSha,
        });
        continue;
      }
      const result = await reportReviewOutcome(config, saved.report);
      results.push({
        pullRequest: pullRequest.number,
        status:
          saved.evidenceDigest === snapshotEvidenceDigest(snapshot)
            ? "rechecked_saved_review"
            : "reused_saved_review_after_evidence_change",
        outcome: result.outcome,
        message: result.message,
      });
      continue;
    }

    if (snapshot.gateInput.runtime.anotherApprovalInFlight) {
      results.push({
        pullRequest: pullRequest.number,
        status: "waiting_for_repository",
        reason: "Another PR has an active GitHub auto-merge request.",
      });
      continue;
    }

    const existingReview = await findExistingAppReview(
      config,
      {
        pullRequestNumber: pullRequest.number,
        headSha: snapshot.gateInput.pullRequest.headSha,
        baseSha: snapshot.gateInput.pullRequest.baseSha,
        requirementDigest: requirementDigest(
          snapshot.gateInput.issues,
          snapshot.gateInput.pullRequest,
        ),
      },
    );
    if (existingReview && integrationModeOf(snapshot.gateInput) !== "serialized-merge") {
      results.push({
        pullRequest: pullRequest.number,
        status: "blocked",
        reason:
          "An App review exists for this head, but its structured report is unavailable; a maintainer must resolve it.",
      });
      continue;
    }

    if (
      snapshot.workflowStatus === "queued" ||
      snapshot.workflowStatus === "in_progress" ||
      snapshot.workflowStatus === "missing" ||
      snapshot.workflowStatus === "unknown"
    ) {
      results.push({
        pullRequest: pullRequest.number,
        status: "waiting_for_validation",
        workflowStatus: snapshot.workflowStatus,
        workflowConclusion: snapshot.workflowConclusion,
      });
      continue;
    }


    if (
      !snapshot.gateInput.issues.some((issue) => issue.state === "open" && !snapshot.gateInput.pullRequest.keepOpenIssueNumbers.includes(issue.number)) ||
      snapshot.gateInput.issues.some((issue) => !snapshot.gateInput.pullRequest.keepOpenIssueNumbers.includes(issue.number) && (issue.pause.active || issue.pause.source === "unknown")) ||
      snapshot.gateInput.pullRequest.issueClosureAmbiguous ||
      containsExplicitMergeHold(snapshot)
    ) {
      if (prepareOnly) {
        results.push({
          pullRequest: pullRequest.number,
          status: "held_for_human",
          reason: "The Issue is closed or paused, or the PR explicitly requests a hold.",
        });
        continue;
      }
      const held = controllerReviewReport(snapshot, "human_decision");
      const result = await reportReviewOutcome(config, held);
      results.push({
        pullRequest: pullRequest.number,
        status: "held_for_human",
        outcome: result.outcome,
        message: result.message,
      });
      continue;
    }

    const packetPath = await writeReviewPacketFile(snapshot);
    if (!snapshot.diff.complete) {
      if (prepareOnly) {
        results.push({
          pullRequest: pullRequest.number,
          status: "incomplete_diff",
          packetPath,
          reason: snapshot.diff.reason,
          changedFiles: snapshot.diff.changedFiles,
          expectedChangedFiles: snapshot.diff.expectedChangedFiles,
        });
        continue;
      }
      const incomplete = controllerReviewReport(
        snapshot,
        "awaiting_verification",
      );
      const result = await reportReviewOutcome(config, incomplete);
      results.push({
        pullRequest: pullRequest.number,
        status: "incomplete_diff",
        outcome: result.outcome,
        message: result.message,
      });
      continue;
    }

    if (prepareOnly) {
      results.push({
        pullRequest: pullRequest.number,
        status: "review_required",
        packetPath,
        headSha: snapshot.gateInput.pullRequest.headSha,
        baseSha: snapshot.gateInput.pullRequest.baseSha,
        requirementDigest: requirementDigest(
          snapshot.gateInput.issues,
          snapshot.gateInput.pullRequest,
        ),
      });
      continue;
    }

    const taskState = await startReviewCheckRun(config, snapshot, packetPath);
    if (taskState === "already_running") {
      results.push({
        pullRequest: pullRequest.number,
        status: "review_in_progress",
        reason: "A review task for this evidence version is still active.",
      });
      continue;
    }
    if (taskState === "blocked") {
      results.push({
        pullRequest: pullRequest.number,
        status: "blocked",
        reason:
          "A completed review check has no recoverable structured report; a maintainer must resolve it.",
      });
      continue;
    }
    results.push({
      pullRequest: pullRequest.number,
      status: "review_required",
      packetPath,
      headSha: snapshot.gateInput.pullRequest.headSha,
      baseSha: snapshot.gateInput.pullRequest.baseSha,
      requirementDigest: requirementDigest(
        snapshot.gateInput.issues,
        snapshot.gateInput.pullRequest,
      ),
    });
  }
  return results;
}

async function configureLocalApp(
  args: Map<string, string>,
): Promise<GitHubAppConfig> {
  if (process.getuid?.() !== 0) {
    throw new Error(
      "configure must run through the protected PR approval controller with root privileges.",
    );
  }
  const invokedPath = process.argv[1];
  if (!invokedPath) {
    throw new Error("The protected controller path could not be verified.");
  }
  const [controllerPath, controllerInfo] = await Promise.all([
    realpath(invokedPath),
    stat(invokedPath),
  ]);
  if (
    controllerPath !== CONTROLLER_PATH ||
    !controllerInfo.isFile() ||
    controllerInfo.uid !== 0 ||
    (controllerInfo.mode & 0o022) !== 0
  ) {
    throw new Error(
      "configure can only run from a root-owned controller installed in the trusted directory.",
    );
  }
  const appId = requiredPositiveInteger(
    Number(args.get("--app-id")),
    "--app-id",
  );
  const installationId = requiredPositiveInteger(
    Number(args.get("--installation-id")),
    "--installation-id",
  );
  const slug = requiredString(args.get("--slug"), "--slug");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new Error("--slug must be the GitHub App slug.");
  }
  const productionMergeAuthorized = args.get("--production-merge-authorized");
  const ordinaryMergeTriggersProduction = args.get(
    "--ordinary-merge-triggers-production",
  );
  if (
    (productionMergeAuthorized !== "true" &&
      productionMergeAuthorized !== "false") ||
    (ordinaryMergeTriggersProduction !== "true" &&
      ordinaryMergeTriggersProduction !== "false")
  ) {
    throw new Error(
      "configure requires --production-merge-authorized and --ordinary-merge-triggers-production, each set to true or false after checking Vercel.",
    );
  }
  const config: GitHubAppConfig = {
    appId,
    installationId,
    slug,
    productionMergeAuthorized: productionMergeAuthorized === "true",
    ordinaryMergeTriggersProduction:
      ordinaryMergeTriggersProduction === "true",
    integrationMode: parseIntegrationMode(args.get("--integration-mode")),
  };
  await assertTrustedConfigLocation().catch((error: unknown) => {
    if (
      isRecord(error) &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  });
  const directoryInfo = await stat(CONFIG_DIRECTORY);
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.uid !== 0 ||
    (directoryInfo.mode & 0o022) !== 0
  ) {
    throw new Error(
      "The PR approval config directory is not root-owned and protected.",
    );
  }
  try {
    await stat(CONFIG_PATH);
    const existing = await readLocalAppConfig();
    if (
      existing.appId === config.appId &&
      existing.installationId === config.installationId &&
      existing.slug === config.slug &&
      existing.productionMergeAuthorized === config.productionMergeAuthorized &&
      existing.ordinaryMergeTriggersProduction ===
        config.ordinaryMergeTriggersProduction &&
      parseIntegrationMode(existing.integrationMode) === config.integrationMode
    ) {
      return existing;
    }
    throw new Error(
      "A different PR approval config already exists; configure will not replace it.",
    );
  } catch (error) {
    if (!isRecord(error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  await chmod(CONFIG_PATH, 0o644);
  return config;
}

async function statusReport(
  config: ControllerConfig,
): Promise<Readonly<Record<string, unknown>>> {
  const integrationMode = parseIntegrationMode(config.app.integrationMode);
  const [repository, branchProtection, mergeQueueAvailable, mainWriterGuard] =
    await Promise.all([
      readRepositoryMergeSettings(config.api),
      readBranchProtection(config.api),
      integrationMode === "merge-queue"
        ? readMergeQueueAvailability(config.api)
        : Promise.resolve(null),
      // Status is the operator's pre-flight check, so the default-branch writer
      // guard is reported whatever the mode is: Luke can see exactly what the
      // controller would enforce before he switches `serialized-merge` on.
      readMainWriterGuard(config.api, "main"),
    ]);
  const mainWriterAttestation = config.mainWriterAttestation ?? null;
  return {
    repository: SAYHEAR_REPOSITORY_NAME,
    integrationMode,
    mergeQueueAvailable,
    mainWriterGuard,
    mainWriterAttestation,
    build: controllerBuildIdentity(),
    controllerSha256: createHash("sha256").update(await readFile(CONTROLLER_PATH)).digest("hex"),
    completionStates: config.completionStore ? (await config.completionStore.list()).map((record) => ({ pullRequest: record.identity.pullRequestNumber, phase: record.phase, attempts: record.attempts, nextRetryAt: record.nextRetryAt, reason: record.reason, mergeSha: record.mergeSha })) : [],
    policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
    reportVersion: PR_REVIEW_REPORT_VERSION,
    diffCollectionVersion: "sayhear-pr-diff:v2",
    baseSyncHandoffVersion: "sayhear-pr-base-sync:v1",
    browserApprovalVersion: BROWSER_APPROVAL_VERSION,
    reviewApp: {
      appId: config.app.appId,
      slug: config.app.slug,
      installationId: config.app.installationId,
    },
    production: {
      mergeAuthorized: config.app.productionMergeAuthorized,
      ordinaryMergeTriggersProduction:
        config.app.ordinaryMergeTriggersProduction,
    },
    installedRepositories: [SAYHEAR_REPOSITORY_NAME],
    allowAutoMerge: repository.allow_auto_merge === true,
    branchProtection,
  };
}

async function readReportFile(path: string | undefined): Promise<unknown> {
  if (!path) throw new Error("submit requires --report <path>.");
  const artifactRoot = resolve(REVIEW_ARTIFACT_DIRECTORY);
  const filePath = resolve(path);
  const pathWithinRoot = relative(artifactRoot, filePath);
  if (
    pathWithinRoot.length === 0 ||
    pathWithinRoot.startsWith("..") ||
    isAbsolute(pathWithinRoot) ||
    !pathWithinRoot.startsWith("reports/")
  ) {
    throw new Error(
      `The report must be saved below ${REVIEW_ARTIFACT_DIRECTORY}/reports/.`,
    );
  }
  const [realArtifactRoot, realFilePath] = await Promise.all([
    realpath(artifactRoot),
    realpath(filePath),
  ]);
  const realRelative = relative(realArtifactRoot, realFilePath);
  if (
    realRelative.length === 0 ||
    realRelative.startsWith("..") ||
    isAbsolute(realRelative) ||
    !realRelative.startsWith("reports/")
  ) {
    throw new Error("The report path resolves outside the approval report directory.");
  }
  const reportStat = await stat(realFilePath);
  if (!reportStat.isFile() || reportStat.size > MAX_REPORT_BYTES) {
    throw new Error("The review report must be a regular file no larger than 20 KB.");
  }
  return JSON.parse(await readFile(realFilePath, "utf8")) as unknown;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: Readonly<{
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  }> = {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  },
): Promise<number> {
  await assertTrustedControllerInstall();
  const commandIndex = argv[0] === "--" ? 1 : 0;
  const command = argv[commandIndex];
  const args = parseArgs(argv.slice(commandIndex + 1));
  if (
    command !== "configure" &&
    command !== "status" &&
    command !== "prepare" &&
    command !== "scan" &&
    command !== "resume" &&
    command !== "submit"
  ) {
    throw new Error(
      "Usage: pnpm pr:approval <configure|status|prepare|scan|resume|submit> [options]",
    );
  }
  assertAllowedArgs(command, args);
  if (command === "configure") {
    io.stdout(JSON.stringify(await configureLocalApp(args), null, 2));
    return 0;
  }
  const config = await createRuntimeControllerConfig();
  if (command === "status") {
    io.stdout(JSON.stringify(await statusReport(config), null, 2));
    return 0;
  }
  if (command === "submit") {
    const report = await readReportFile(args.get("--report"));
    const result = await withGlobalLock(() =>
      reportReviewResult(config, report),
    );
    io.stdout(JSON.stringify(result, null, 2));
    return 0;
  }

  const run = async () =>
    scanPullRequests(
      config,
      requestedPullNumber(args),
      command === "prepare",
    );
  const results = await withGlobalLock(run);
  io.stdout(
    JSON.stringify(
      {
        repository: SAYHEAR_REPOSITORY_NAME,
        scannedAt: new Date().toISOString(),
        results,
      },
      null,
      2,
    ),
  );
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
