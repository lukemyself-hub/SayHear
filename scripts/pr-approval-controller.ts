import {
  createHash,
  createSign,
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
  chmod,
  realpath,
} from "node:fs/promises";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  evaluatePrReviewGate,
  PR_REVIEW_GATE_CHECK_NAME,
  PR_REVIEW_GATE_POLICY_VERSION,
  PR_REVIEW_REPORT_VERSION,
  PR_VALIDATE_WORKFLOW_PATH,
  parsePrReviewGateInput,
  requirementDigest,
  SAYHEAR_REPOSITORY_ID,
  SAYHEAR_REPOSITORY_NAME,
  type PrReviewGateInput,
  type PrReviewGateReport,
  type TrustedPrReviewPolicy,
} from "./pr-review-gate.ts";
import {
  FIXED_PR_CI_BASELINE,
  planDailyReleaseValidation,
  DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
  RELEASE_CHECKS,
  type ReleaseImpactKind,
} from "./daily-release-validation.ts";

const execFileAsync = promisify(execFile);
const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";
const ACTIONS_APP_ID = 15368;
const CONFIG_DIRECTORY =
  "/Library/Application Support/SayHear/PRApproval";
const CONFIG_PATH = `${CONFIG_DIRECTORY}/config.json`;
const CONTROLLER_PATH = `${CONFIG_DIRECTORY}/controller.mjs`;
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
const MAX_DIFF_BYTES = 800_000;
const MAX_REPORT_BYTES = 20_000;
const MAX_ARTIFACT_ARCHIVE_BYTES = 50_000_000;
const REVIEW_TASK_STALE_AFTER_MS = 6 * 60 * 60 * 1_000;
const LOCK_DIRECTORY = "/private/tmp/sayhear-pr-approval.lock";
const REVIEW_ARTIFACT_DIRECTORY = "artifacts/pr-approval";
const ISSUE_COMMENT_MARKER = "<!-- sayhear-pr-auto-approval:v1";
const PAUSE_MARKER = "<!-- sayhear-pr-auto-approval-pause:v1";
const AUTO_REVIEW_COMMENT_MARKER = "<!-- sayhear-pr-auto-approval-review:v1";

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

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
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
  humanReviewAuthorizations?: readonly HumanReviewAuthorization[];
}>;

export type HumanReviewAuthorization = Readonly<{
  pullRequestNumber: number;
  // Audit provenance; exact diff and requirement matching survive main-only updates.
  approvedHeadSha: string;
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
  issue: PrReviewGateInput["issue"];
  evidence: PrReviewGateInput["evidence"];
  branchProtection: PrReviewGateInput["branchProtection"];
  runtime: PrReviewGateInput["runtime"];
  workflow: Readonly<{
    path: string;
    trustedBlobSha: string | null;
    status: "queued" | "in_progress" | "completed" | "missing" | "unknown";
    conclusion: string | null;
  }>;
  diff: Readonly<{
    complete: boolean;
    changedFiles: number;
    text: string;
    digest: string;
    changeDigest: string;
  }>;
  reviewContext: Readonly<{
    reportVersion: string;
    policyVersion: string;
    requirementDigest: string;
  }>;
  impactHints: readonly ReleaseImpactKind[];
  suggestedEvidenceIds: readonly string[];
}>;

type ControllerConfig = Readonly<{
  api: GitHubApi;
  app: GitHubAppConfig;
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`GitHub response exceeds the ${maxBytes}-byte limit.`);
    }
    return bytes;
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

function digestDiscussion(
  comments: readonly GitHubComment[],
  reviews: readonly GitHubReview[] = [],
): string {
  const entries = [
    ...comments.map((comment) => ({
      id: comment.id,
      actor: comment.user.id,
      body: comment.body ?? "",
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    })),
    ...reviews.map((review) => ({
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
  const pattern = /(?:^|[^A-Za-z0-9_])#([1-9]\d{0,8})\b|\/issues\/([1-9]\d{0,8})\b/g;
  for (const match of `${title}\n${body}`.matchAll(pattern)) {
    const issueNumber = Number(match[1] ?? match[2]);
    if (Number.isSafeInteger(issueNumber)) references.add(issueNumber);
  }
  return [...references];
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
    value.assertionResults.every(
      (assertion) => isRecord(assertion) && assertion.status === "passed",
    )
  );
}

function reportHasNoSkips(value: unknown): value is JsonRecord & {
  success: boolean;
  testResults: readonly JsonRecord[];
} {
  if (!isRecord(value) || value.success !== true || !Array.isArray(value.testResults)) {
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

  let bypassActorIds: number[] = [];
  try {
    const rulesets = await api.pages<JsonRecord>(
      repositoryPath("/rulesets?includes_parents=true"),
    );
    for (const ruleset of rulesets) {
      if (!Array.isArray(ruleset.bypass_actors)) {
        throw new Error("The ruleset bypass actors could not be verified.");
      }
      const actors = ruleset.bypass_actors;
      if (actors.length > 0) {
        bypassActorIds.push(
          ...actors.map((actor) =>
            isRecord(actor) && typeof actor.actor_id === "number"
              ? Math.max(1, actor.actor_id)
              : Number.MAX_SAFE_INTEGER,
          ),
        );
      }
    }
  } catch {
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

  return {
    readable: true,
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
  return createControllerConfig(appConfig, api);
}

export function parsePauseState(
  comments: readonly GitHubComment[],
  ownerActorId: number,
  botActorId: number,
): PrReviewGateInput["issue"]["pause"] {
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

async function resolveLinkedIssue(
  api: GitHubApi,
  pullRequest: GitHubPullRequest,
): Promise<GitHubIssue> {
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
  if (issues.length !== 1) {
    throw new Error(
      "The PR must contain exactly one reference to an Issue in SayHear.",
    );
  }
  return issues[0]!;
}

export async function readCurrentPullRequestMergeSha(
  api: GitHubApi,
  pullRequest: Pick<GitHubPullRequest, "number" | "base" | "head" | "merge_commit_sha">,
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
      baseParent.sha.toLowerCase() !== pullRequest.base.sha.toLowerCase() ||
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

  for (const check of actionsChecks) {
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
): Promise<Readonly<{ digest: string; report: JsonRecord }> | null> {
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
    return { digest, report };
  } catch {
    return null;
  }
}

async function collectEvidence(
  config: ControllerConfig,
  pullNumber: number,
  pullRequest: GitHubPullRequest,
  changedFiles: PrReviewGateInput["pullRequest"]["changedFiles"],
  impacts: readonly ReleaseImpactKind[],
  capability: PrReviewGateInput["review"]["capability"],
  mergeSha: string | null,
  baseSha: string,
  humanAuthorization: HumanReviewAuthorization | null = null,
): Promise<Readonly<{
  evidence: PrReviewGateInput["evidence"];
  trustedWorkflowBlobSha: string | null;
  workflowStatus: "queued" | "in_progress" | "completed" | "missing" | "unknown";
  workflowConclusion: string | null;
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

  // GitHub can omit merge_commit_sha on an open PR; the current-base gate
  // prevents review until the PR's base matches main, so compare its head tree.
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
      detailsUrl.includes(`/actions/runs/${run.id}`)
    );
  });
  const runPull = run.pull_requests.find((entry) => entry.number === pullNumber);
  const workflowSourceValid =
    runPull?.base.sha === baseSha &&
    runPull.head.sha === pullRequest.head.sha &&
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
    isTrustedWorkflowVersion(mainWorkflowSha, mergeWorkflowSha, humanAuthorization?.validateWorkflowBlobSha ?? null);
  const testArtifact = await readVitestReport(
    config.api,
    run.id,
    pullNumber,
  );
  const validReport =
    testArtifact !== null && reportHasNoSkips(testArtifact.report);

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
      (checkId !== "baseline:test" || validReport) &&
      (fixed || targetedPassed);
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
  return {
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
  gateInput: Omit<PrReviewGateInput, "review" | "evidence">;
  evidence: PrReviewGateInput["evidence"];
  trustedWorkflowBlobSha: string | null;
  workflowStatus: "queued" | "in_progress" | "completed" | "missing" | "unknown";
  workflowConclusion: string | null;
  diff: Readonly<{
    complete: boolean;
    changedFiles: number;
    text: string;
    digest: string;
    changeDigest: string;
  }>;
}>;

async function readSnapshot(
  config: ControllerConfig,
  pullNumber: number,
  impacts: readonly ReleaseImpactKind[] = [],
  capability: PrReviewGateInput["review"]["capability"] = {
    newCapabilityEnabled: false,
    majorContractChange: false,
    externalMvpRelease: false,
  },
): Promise<Snapshot> {
  const [repository, pullRequest, protection, refs, openPullRequests] =
    await Promise.all([
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
    ]);
  if (recordNumber(repository, "id") !== SAYHEAR_REPOSITORY_ID) {
    throw new Error("The GitHub App returned a different repository.");
  }
  const defaultBranch = recordString(repository, "default_branch");
  const defaultBranchSha = isRecord(refs.object)
    ? recordString(refs.object, "sha", "main ref SHA").toLowerCase()
    : null;
  if (!defaultBranchSha) throw new Error("The current main SHA is unavailable.");

  const [issue, mergeSha] = await Promise.all([
    resolveLinkedIssue(config.api, pullRequest),
    readCurrentPullRequestMergeSha(config.api, pullRequest),
  ]);
  const [
    changedFileRecords,
    fullDiffBytes,
    commits,
    issueComments,
    prComments,
    reviewComments,
    reviews,
    blockedBy,
    hasHumanReviewThread,
  ] = await Promise.all([
    config.api.pages<JsonRecord>(
      repositoryPath(`/pulls/${pullNumber}/files`),
    ),
    config.api
      .bytes(repositoryPath(`/pulls/${pullNumber}`), {
        accept: "application/vnd.github.diff",
        maxBytes: MAX_DIFF_BYTES,
      })
      .catch(() => null),
    config.api.pages<JsonRecord>(
      repositoryPath(`/pulls/${pullNumber}/commits`),
    ),
    config.api.pages<GitHubComment>(
      repositoryPath(`/issues/${issue.number}/comments`),
    ),
    config.api.pages<GitHubComment>(
      repositoryPath(`/issues/${pullNumber}/comments`),
    ),
    config.api.pages<GitHubComment>(
      repositoryPath(`/pulls/${pullNumber}/comments`),
    ),
    config.api.pages<GitHubReview>(
      repositoryPath(`/pulls/${pullNumber}/reviews`),
    ),
    readIssueDependencies(config.api, issue.number),
    readReviewThreadState(
      config.api,
      pullNumber,
      `${config.app.slug}[bot]`,
    ),
  ]);

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
  const diffText =
    fullDiffBytes === null
      ? ""
      : Buffer.from(fullDiffBytes).toString("utf8");
  const diffHeaderCount = [...diffText.matchAll(/^diff --git /gm)].length;
  const hasBinaryContent = /^Binary files .+ differ$/m.test(diffText);
  const diffBytesRoundTrip =
    fullDiffBytes !== null &&
    Buffer.compare(Buffer.from(diffText, "utf8"), Buffer.from(fullDiffBytes)) ===
      0;
  const diffComplete =
    changedFileRecords.length > 0 &&
    changedFileRecords.length === pullRequest.changed_files &&
    diffHeaderCount === changedFileRecords.length &&
    diffBytesRoundTrip &&
    !hasBinaryContent;
  const diffDigest = createHash("sha256")
    .update(
      fullDiffBytes ??
        JSON.stringify(
          changedFileRecords.map((file) => ({
            path: file.filename,
            previousPath: file.previous_filename ?? null,
            status: file.status,
            patch: typeof file.patch === "string" ? file.patch : null,
          })),
        ),
    )
    .digest("hex");

  const prDiscussionDigest = digestDiscussion(
    [...prComments, ...reviewComments].filter(
      (comment) => comment.user.id !== config.botActorId && !isVercelDeploymentStatus(comment),
    ),
    reviews.filter((review) => review.user.id !== config.botActorId),
  );
  const issueDiscussionDigest = digestDiscussion(
    issueComments.filter((comment) => comment.user.id !== config.botActorId),
  );
  const currentPullRequests = openPullRequests.filter(
    (candidate) =>
      candidate.number !== pullNumber &&
      candidate.base.ref === "main" &&
      isRecord(candidate.auto_merge),
  );
  const linkedNumbers = [issue.number];
  const issuePause = parsePauseState(
    [...issueComments, ...prComments],
    config.ownerActorId,
    config.botActorId,
  );
  const normalizedIssue: PrReviewGateInput["issue"] = {
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body ?? "",
    updatedAt: issue.updated_at,
    discussionDigest: issueDiscussionDigest,
    labels: labelNames(issue),
    blockedBy,
    pause: issuePause,
  };
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
    baseRef: pullRequest.base.ref,
    headRepositoryId:
      pullRequest.head.repo === null ? null : pullRequest.head.repo.id,
    authorId: pullRequest.user.id,
    lastCommitAuthorId,
    linkedIssueNumbers: linkedNumbers,
    changedFiles,
  };
  const normalizedRepository: PrReviewGateInput["repository"] = {
    id: recordNumber(repository, "id"),
    fullName: recordString(repository, "full_name"),
    defaultBranch,
    defaultBranchSha,
    allowAutoMerge: repository.allow_auto_merge === true,
  };
  const collected = await collectEvidence(
    config,
    pullNumber,
    pullRequest,
    changedFiles,
    impacts,
    capability,
    normalizedPullRequest.mergeSha,
    normalizedPullRequest.baseSha,
    matchHumanReviewAuthorization(config.app.humanReviewAuthorizations ?? [], {
      pullRequestNumber: pullNumber,
      diffDigest,
      requirementDigest: requirementDigest(normalizedIssue, normalizedPullRequest),
      diffComplete,
    }),
  );
  return {
    gateInput: {
      repository: normalizedRepository,
      pullRequest: normalizedPullRequest,
      issue: normalizedIssue,
      branchProtection: protection,
      runtime: {
        reviewAppInstalledForRepository: true,
        anotherApprovalInFlight: currentPullRequests.length > 0,
        productionMergeAuthorized: config.app.productionMergeAuthorized,
        ordinaryMergeTriggersProduction:
          config.app.ordinaryMergeTriggersProduction,
      },
    },
    evidence: collected.evidence,
    trustedWorkflowBlobSha: collected.trustedWorkflowBlobSha,
    workflowStatus: collected.workflowStatus,
    workflowConclusion: collected.workflowConclusion,
    diff: {
      complete: diffComplete,
      changedFiles: changedFileRecords.length,
      text: diffComplete ? diffText : "",
      digest: diffDigest,
      changeDigest: diffChangeDigest(diffText, changedFiles),
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
  const humanAuthorization = matchHumanReviewAuthorization(config.app.humanReviewAuthorizations ?? [], {
    pullRequestNumber: snapshot.gateInput.pullRequest.number,
    diffDigest: snapshot.diff.digest,
    requirementDigest: requirementDigest(snapshot.gateInput.issue, snapshot.gateInput.pullRequest),
    diffComplete: snapshot.diff.complete,
  });
  const policy = {
    ...config.policy,
    validateWorkflowBlobSha: snapshot.trustedWorkflowBlobSha,
    humanApprovedPaths: humanAuthorization?.paths ?? [],
    humanApprovedNoRuntimeImpact: humanAuthorization?.noRuntimeImpact === true,
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
    reviewContext: {
      reportVersion:
        reportContext?.reportVersion ?? PR_REVIEW_REPORT_VERSION,
      policyVersion:
        reportContext?.policyVersion ?? PR_REVIEW_GATE_POLICY_VERSION,
      requirementDigest: requirementDigest(
        snapshot.gateInput.issue,
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

async function removeStaleLock(): Promise<boolean> {
  try {
    const ownerPath = `${LOCK_DIRECTORY}/owner.json`;
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as unknown;
    if (!isRecord(owner) || typeof owner.pid !== "number") return false;
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
    await rmdir(LOCK_DIRECTORY);
    return true;
  } catch {
    try {
      const lock = await stat(LOCK_DIRECTORY);
      if (Date.now() - lock.mtimeMs < 60_000) return false;
      await rmdir(LOCK_DIRECTORY);
      return true;
    } catch {
      return false;
    }
  }
}

async function withGlobalLock<T>(operation: () => Promise<T>): Promise<T> {
  try {
    await mkdir(LOCK_DIRECTORY, { mode: 0o700 });
  } catch {
    if (!(await removeStaleLock())) {
      throw new Error("Another PR approval operation holds the repository lock.");
    }
    await mkdir(LOCK_DIRECTORY, { mode: 0o700 });
  }
  const ownerPath = `${LOCK_DIRECTORY}/owner.json`;
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
      await rmdir(LOCK_DIRECTORY);
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
          .map((entry) => ({
            checkId: entry.checkId,
            result: entry.result,
            source: entry.source,
            artifactSha256: entry.artifactSha256,
            coveredCheckIds: entry.coveredCheckIds,
          })),
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
  const evidenceSummary = snapshot.evidence.map(
    (entry) =>
      `- \`${entry.checkId}\`: ${entry.result}; run ${entry.source.runId}/${entry.source.runAttempt}; artifact ${entry.artifactSha256 ?? "none"}`,
  );
  const payload = {
    name: PR_REVIEW_GATE_CHECK_NAME,
    head_sha: report.headSha,
    external_id: externalId,
    status: "completed",
    conclusion:
      gate.outcome === "merge_candidate"
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
    snapshot.gateInput.issue,
    pullRequest,
  );
  const externalId = checkExternalId(
    pullRequest.number,
    pullRequest.headSha,
    pullRequest.baseSha,
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

async function readSavedReviewReport(
  config: ControllerConfig,
  snapshot: Snapshot,
): Promise<Readonly<{
  report: ModelReviewReport;
  evidenceDigest: string;
}> | null> {
  const pullRequest = snapshot.gateInput.pullRequest;
  const requirement = requirementDigest(
    snapshot.gateInput.issue,
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
      entry.external_id === externalId &&
      isRecord(entry.app) &&
      entry.app.id === config.app.appId &&
      entry.status === "completed",
    ),
  );
  if (!check || !isRecord(check.output)) return null;
  const summary = check.output.summary;
  if (typeof summary !== "string") return null;
  const marker = summary.match(
    /<!-- sayhear-pr-auto-approval-state:v1 pr=(\d+) head=([0-9a-f]{40}) base=([0-9a-f]{40}) requirement=([0-9a-f]{64}) diff=([0-9a-f]{64}) change=([0-9a-f]{64}) evidence=([0-9a-f]{64}) outcome=(merge_candidate|request_changes|awaiting_verification|human_decision) report=([A-Za-z0-9_-]+) -->/i,
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
      marker[3]!.toLowerCase() !== pullRequest.baseSha ||
      marker[4]!.toLowerCase() !== requirement ||
      marker[5]!.toLowerCase() !== snapshot.diff.digest ||
      marker[6]!.toLowerCase() !== snapshot.diff.changeDigest ||
      report.pullRequestNumber !== pullRequest.number ||
      report.headSha.toLowerCase() !== pullRequest.headSha ||
      report.baseSha.toLowerCase() !== pullRequest.baseSha ||
      report.requirementDigest !== requirement
    ) {
      return null;
    }
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

export function appReviewOutcomeForIdentity(
  body: string | null,
  identity: AppReviewIdentity,
): "approve" | "request_changes" | null {
  const marker = body?.match(
    /<!-- sayhear-pr-auto-approval-review:v2 pr=(\d+) head=([0-9a-f]{40}) base=([0-9a-f]{40}) requirement=([0-9a-f]{64}) outcome=(approve|request_changes) -->/i,
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
  return marker[5]!.toLowerCase() as "approve" | "request_changes";
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
): Promise<GitHubReview> {
  const existing = await findExistingAppReview(
    config,
    report,
  );
  const desired =
    report.decision === "request_changes" ? "request_changes" : "approve";
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
  config: ControllerConfig,
  issueNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  const comments = await config.api.pages<GitHubComment>(
    repositoryPath(`/issues/${issueNumber}/comments`),
  );
  if (comments.some((comment) => comment.body?.includes(marker))) return;
  try {
    await config.api.request(
      repositoryPath(`/issues/${issueNumber}/comments`),
      { method: "POST", body: { body } },
    );
  } catch (error) {
    const recovered = await config.api
      .pages<GitHubComment>(
        repositoryPath(`/issues/${issueNumber}/comments`),
      )
      .catch(() => []);
    if (recovered.some((comment) => comment.body?.includes(marker))) return;
    throw error;
  }
}

async function deleteLabelIfPresent(
  config: ControllerConfig,
  issueNumber: number,
  label: string,
): Promise<void> {
  try {
    await config.api.request(
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

async function applyIssueHandoff(
  config: ControllerConfig,
  issueNumber: number,
  target: "ready-for-agent" | "ready-for-human",
): Promise<void> {
  const issue = await config.api.request<GitHubIssue>(
    repositoryPath(`/issues/${issueNumber}`),
  );
  if (issue.state !== "open") {
    throw new Error(`Issue #${issueNumber} is closed and cannot be handed off.`);
  }
  const currentLabels = new Set(labelNames(issue));
  const labelsToRemove = [
    "ongoing",
    target === "ready-for-agent" ? "ready-for-human" : "ready-for-agent",
    "needs-triage",
    "needs-info",
    "wontfix",
  ];
  for (const label of labelsToRemove) {
    if (label !== target && currentLabels.has(label)) {
      await deleteLabelIfPresent(config, issueNumber, label);
    }
  }
  if (!currentLabels.has(target)) {
    await config.api.request(
      repositoryPath(`/issues/${issueNumber}/labels`),
      { method: "POST", body: { labels: [target] } },
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
  const issueNumber = snapshot.gateInput.issue.number;
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
  await postIssueCommentOnce(config, issueNumber, marker, body);
  await applyIssueHandoff(config, issueNumber, "ready-for-agent");
}

export async function requestProtectedMerge(
  api: GitHubApi,
  pullRequestNumber: number,
  headSha: string,
  mergeMethod: "MERGE" | "SQUASH" | "REBASE",
): Promise<void> {
  let result: JsonRecord;
  try {
    result = await api.request<JsonRecord>(
      repositoryPath(`/pulls/${pullRequestNumber}/merge`), {
        method: "PUT",
        body: { sha: headSha, merge_method: mergeMethod.toLowerCase() },
      });
  } catch (error) {
    const readback = await api.request<JsonRecord>(
      repositoryPath(`/pulls/${pullRequestNumber}`),
    ).catch(() => null);
    if (readback?.merged === true && readback.state === "closed" &&
        isRecord(readback.head) && readback.head.sha === headSha) return;
    throw error;
  }
  if (result.merged !== true) throw new Error("GitHub did not confirm the protected merge.");
}

async function requestPullRequestAutoMerge(
  config: ControllerConfig,
  report: ModelReviewReport,
  repository: JsonRecord,
  pullRequest: GitHubPullRequest,
): Promise<void> {
  if (isRecord(pullRequest.auto_merge)) return;
  const pullRequestNodeId = recordString(pullRequest, "node_id");
  const mergeMethod = repository.allow_merge_commit === true
    ? "MERGE"
    : repository.allow_squash_merge === true
      ? "SQUASH"
      : repository.allow_rebase_merge === true
        ? "REBASE"
        : null;
  if (mergeMethod === null) {
    throw new Error("No enabled GitHub auto-merge method is available.");
  }
  // GitHub exposes auto-merge only while requirements remain pending. Once
  // clean, use its protected merge endpoint with the reviewed head pinned.
  if (pullRequest.mergeable === true && pullRequest.mergeable_state === "clean") {
    await requestProtectedMerge(config.api, report.pullRequestNumber, report.headSha, mergeMethod);
    return;
  }
  const mutation = `mutation($input:EnablePullRequestAutoMergeInput!){
    enablePullRequestAutoMerge(input:$input){
      pullRequest{number autoMergeRequest{enabledAt mergeMethod}}
    }
  }`;
  try {
    const result = await readGraphql<{
      enablePullRequestAutoMerge?: { pullRequest?: JsonRecord | null } | null;
    }>(config.api, mutation, {
      input: {
        pullRequestId: pullRequestNodeId,
        mergeMethod,
      },
    });
    if (!result.enablePullRequestAutoMerge?.pullRequest) {
      throw new Error("GitHub did not confirm auto-merge activation.");
    }
  } catch (error) {
    const refreshed = await config.api.request<GitHubPullRequest>(
      repositoryPath(`/pulls/${report.pullRequestNumber}`),
    ).catch(() => null);
    if (refreshed && (isRecord(refreshed.auto_merge) ||
        (refreshed.merged === true && refreshed.head.sha === report.headSha))) return;
    throw error;
  }
}

export function isWaitingForWorkflow(
  snapshot: Pick<Snapshot, "workflowStatus">,
  gate: Pick<PrReviewGateReport, "outcome" | "reasons">,
): boolean {
  return (
    gate.outcome === "awaiting_verification" &&
    gate.reasons.some((reason) => reason.code === "required_evidence_missing") &&
    (snapshot.workflowStatus === "queued" ||
      snapshot.workflowStatus === "in_progress" ||
      snapshot.workflowStatus === "missing" ||
      snapshot.workflowStatus === "unknown")
  );
}

async function postNonBlockingOutcome(
  config: ControllerConfig,
  snapshot: Snapshot,
  report: ModelReviewReport,
  gate: PrReviewGateReport,
): Promise<void> {
  const issueNumber = snapshot.gateInput.issue.number;
  const target =
    gate.outcome === "human_decision" ? "ready-for-human" : "ready-for-agent";
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
  await postIssueCommentOnce(config, issueNumber, marker, body);
  await applyIssueHandoff(config, issueNumber, target);
}

async function reportReviewResult(
  config: ControllerConfig,
  input: unknown,
): Promise<Readonly<{ outcome: string; message: string }>> {
  const report = parseModelReviewReport(input);
  if (report.repositoryId !== SAYHEAR_REPOSITORY_ID) {
    throw new Error("The review report names a different repository.");
  }
  const snapshot = await readSnapshot(
    config,
    report.pullRequestNumber,
    report.declaredImpacts,
    report.capability,
  );
  const { gate } = evaluateSnapshot(config, snapshot, report);
  await upsertCheckRun(config, snapshot, report, gate);

  if (gate.outcome === "request_changes") {
    const review = await submitPullRequestReview(config, report);
    await recordReviewHandoff(config, snapshot, report, gate, review);
    return {
      outcome: gate.outcome,
      message: `Posted request changes for PR #${report.pullRequestNumber} at ${report.headSha}.`,
    };
  }

  if (gate.outcome === "awaiting_verification" && isWaitingForWorkflow(snapshot, gate)) {
    return {
      outcome: gate.outcome,
      message: `Waiting for PR Validate evidence for PR #${report.pullRequestNumber}; no Issue dispatch was created.`,
    };
  }

  if (
    gate.outcome === "awaiting_verification" &&
    gate.reasons.some((reason) => reason.code === "repository_merge_busy")
  ) {
    return {
      outcome: gate.outcome,
      message: `Waiting for the other in-flight PR before continuing PR #${report.pullRequestNumber}.`,
    };
  }

  if (gate.outcome === "awaiting_verification" || gate.outcome === "human_decision") {
    await postNonBlockingOutcome(config, snapshot, report, gate);
    return {
      outcome: gate.outcome,
      message: `Recorded ${gate.outcome} for PR #${report.pullRequestNumber} and updated the Issue handoff.`,
    };
  }

  const approval = await submitPullRequestReview(config, report);
  if (
    approval.state !== "APPROVED" ||
    approval.user.id !== config.botActorId ||
    approval.commit_id.toLowerCase() !== report.headSha.toLowerCase()
  ) {
    throw new Error("GitHub did not retain the expected independent App approval.");
  }
  const freshSnapshot = await readSnapshot(
    config,
    report.pullRequestNumber,
    report.declaredImpacts,
    report.capability,
  );
  const { gate: freshGate } = evaluateSnapshot(config, freshSnapshot, report);
  if (freshGate.outcome !== "merge_candidate") {
    await upsertCheckRun(config, freshSnapshot, report, freshGate);
    await postNonBlockingOutcome(config, freshSnapshot, report, {
      ...freshGate,
      outcome: "human_decision",
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
    latestPullRequest.base.sha.toLowerCase() !== report.baseSha.toLowerCase()
  ) {
    const staleGate: PrReviewGateReport = {
      ...freshGate,
      outcome: "awaiting_verification",
      reasons: [
        {
          code: "head_or_base_changed_before_auto_merge",
          message:
            "The PR head or base changed after approval; fresh review and CI evidence are required.",
        },
      ],
    };
    await upsertCheckRun(config, freshSnapshot, report, staleGate);
    return {
      outcome: staleGate.outcome,
      message: `Auto-merge was not enabled for PR #${report.pullRequestNumber} because its head or base changed.`,
    };
  }
  await requestPullRequestAutoMerge(
    config,
    report,
    latestRepository,
    latestPullRequest,
  );
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
    outcome: "merge_candidate",
    message: isRecord(readback.auto_merge)
      ? `GitHub auto-merge is enabled for PR #${report.pullRequestNumber}.`
      : `PR #${report.pullRequestNumber} merged while the controller read back its state.`,
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
    baseSha: pullRequest.baseSha,
    requirementDigest: requirementDigest(
      snapshot.gateInput.issue,
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
      snapshot.gateInput.issue.title,
      snapshot.gateInput.issue.body,
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

async function scanPullRequests(
  config: ControllerConfig,
  onlyPullNumber: number | null,
  prepareOnly = false,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const pullRequests = onlyPullNumber === null
    ? await config.api.pages<GitHubPullRequest>(
        repositoryPath("/pulls?state=open"),
      )
    : [
        await config.api.request<GitHubPullRequest>(
          repositoryPath(`/pulls/${onlyPullNumber}`),
        ),
      ];
  const results: Array<Readonly<Record<string, unknown>>> = [];

  for (const pullRequest of pullRequests) {
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
      snapshot = await readSnapshot(config, pullRequest.number);
    } catch (error) {
      results.push({
        pullRequest: pullRequest.number,
        status: "blocked",
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
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
      const result = await reportReviewResult(config, saved.report);
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
          snapshot.gateInput.issue,
          snapshot.gateInput.pullRequest,
        ),
      },
    );
    if (existingReview) {
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
      snapshot.gateInput.pullRequest.baseSha !==
      snapshot.gateInput.repository.defaultBranchSha
    ) {
      results.push({
        pullRequest: pullRequest.number,
        status: "waiting_for_current_base",
      });
      continue;
    }

    if (
      snapshot.gateInput.issue.state !== "open" ||
      snapshot.gateInput.issue.pause.active ||
      snapshot.gateInput.issue.pause.source === "unknown" ||
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
      const result = await reportReviewResult(config, held);
      results.push({
        pullRequest: pullRequest.number,
        status: "held_for_human",
        outcome: result.outcome,
        message: result.message,
      });
      continue;
    }

    if (!snapshot.diff.complete) {
      if (prepareOnly) {
        results.push({
          pullRequest: pullRequest.number,
          status: "incomplete_diff",
        });
        continue;
      }
      const incomplete = controllerReviewReport(
        snapshot,
        "awaiting_verification",
      );
      const result = await reportReviewResult(config, incomplete);
      results.push({
        pullRequest: pullRequest.number,
        status: "incomplete_diff",
        outcome: result.outcome,
        message: result.message,
      });
      continue;
    }

    const packetPath = await writeReviewPacketFile(snapshot);
    if (prepareOnly) {
      results.push({
        pullRequest: pullRequest.number,
        status: "review_required",
        packetPath,
        headSha: snapshot.gateInput.pullRequest.headSha,
        baseSha: snapshot.gateInput.pullRequest.baseSha,
        requirementDigest: requirementDigest(
          snapshot.gateInput.issue,
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
        snapshot.gateInput.issue,
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
        config.ordinaryMergeTriggersProduction
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
  const [repository, branchProtection] = await Promise.all([
    readRepositoryMergeSettings(config.api),
    readBranchProtection(config.api),
  ]);
  return {
    repository: SAYHEAR_REPOSITORY_NAME,
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
