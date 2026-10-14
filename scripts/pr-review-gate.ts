import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
  FIXED_PR_CI_BASELINE,
  planDailyReleaseValidation,
  type ReleaseImpactKind,
} from "./daily-release-validation.ts";

export const PR_REVIEW_GATE_POLICY_VERSION = "sayhear-pr-review-gate:v4";
export const PR_REVIEW_REPORT_VERSION = "sayhear-pr-review-report:v3";
export const SAYHEAR_REPOSITORY_ID = 1312399710;
export const SAYHEAR_REPOSITORY_NAME = "lukemyself-hub/SayHear";
export const PR_VALIDATE_WORKFLOW_PATH = ".github/workflows/pr-validate.yml";
export const PR_REVIEW_GATE_CHECK_NAME = "pr-review-gate";

const FIXED_BASELINE_IDS = new Set<string>(FIXED_PR_CI_BASELINE);
const ENUMERATED_OFFLINE_EVALUATION_PATHS = new Set([
  "eval/retrieval-precision-v1/README.md",
  "eval/retrieval-precision-v1/harness.ts",
  "tests/system/retrieval-precision-corpus.system.test.ts",
]);
const IMPACT_KINDS: readonly ReleaseImpactKind[] = [
  "ui",
  "server-business",
  "reflection-journal",
  "prompt-budget",
  "owner-permission",
  "purge-coverage",
  "provider-migration",
];

const HUMAN_REVIEW_PATHS = [
  ".github/workflows/",
  "scripts/ci/",
  "scripts/pr-approval/",
  "scripts/pr-approval-controller.ts",
  "scripts/pr-approval-launcher.c",
  "scripts/build-pr-approval-controller.mjs",
  "tests/pr-approval-controller.test.ts",
  "tests/pr-approval-diff.test.ts",
  "scripts/capture-g1-role-provider-calls.ts",
  "scripts/pr-review-gate.ts",
  "scripts/daily-release-validation.ts",
  "tests/ci/",
  "tests/pr-review-gate.test.ts",
  "tests/daily-release-validation.test.ts",
  "AGENTS.md",
  "CODEOWNERS",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  "docs/agents/issue-tracker.md",
  "docs/agents/pr-auto-approval.md",
  "docs/agents/triage-labels.md",
  "docs/research/pr-auto-approval-design-2026-10-10.md",
  "docs/product/",
  "docs/adr/",
  "package.json",
  "pnpm-lock.yaml",
  "vitest.config.",
  "vitest.workspace.",
  "tsconfig",
] as const;

const REQUIRED_REVIEW_FLAGS = [
  "productDefinitionChanged",
  "authorizationBoundaryChanged",
  "privacyBoundaryChanged",
  "destructiveMigration",
  "productionFeatureEnablement",
] as const;

export type GateOutcome =
  | "merge_candidate"
  | "request_changes"
  | "awaiting_verification"
  | "human_decision";

export type GateReason = Readonly<{ code: string; message: string }>;

export type PrReviewIssue = Readonly<{
  number: number;
  state: "open" | "closed";
  title: string;
  body: string;
  updatedAt: string;
  discussionDigest: string;
  labels: readonly string[];
  blockedBy: readonly number[] | null;
  pause: Readonly<{
    active: boolean;
    source: "none" | "maintainer" | "review-app" | "unknown";
  }>;
}>;

export type PrReviewGateInput = Readonly<{
  repository: Readonly<{
    id: number;
    fullName: string;
    defaultBranch: string;
    defaultBranchSha: string;
    allowAutoMerge: boolean;
  }>;
  pullRequest: Readonly<{
    number: number;
    state: "open" | "closed";
    draft: boolean;
    title: string;
    body: string;
    updatedAt: string;
    discussionDigest: string;
    externalReviewState: "clear" | "needs-human" | "unavailable";
    headSha: string;
    baseSha: string;
    mergeSha: string | null;
    baseRef: string;
    headRepositoryId: number | null;
    authorId: number;
    lastCommitAuthorId: number | null;
    linkedIssueNumbers: readonly number[];
    keepOpenIssueNumbers: readonly number[];
    issueClosureAmbiguous: boolean;
    changedFiles: readonly Readonly<{
      path: string;
      status: "added" | "modified" | "removed" | "renamed" | "copied";
    }>[];
  }>;
  issues: readonly PrReviewIssue[];
  review: Readonly<{
    version: string;
    repositoryId: number;
    pullRequestNumber: number;
    headSha: string;
    baseSha: string;
    policyVersion: string;
    requirementDigest: string;
    decision:
      | "approve"
      | "request_changes"
      | "awaiting_verification"
      | "human_decision";
    diffComplete: boolean;
    reviewerAppId: number;
    reviewerActorId: number;
    declaredImpacts: readonly ReleaseImpactKind[];
    capability: Readonly<{
      newCapabilityEnabled: boolean;
      majorContractChange: boolean;
      externalMvpRelease: boolean;
    }>;
    riskFlags: Readonly<Record<(typeof REQUIRED_REVIEW_FLAGS)[number], boolean>>;
    findings: readonly Readonly<{
      severity: "P0" | "P1" | "P2" | "P3";
      file: string;
      line: number;
      trigger: string;
      userImpact: string;
      evidence: string;
    }>[];
  }>;
  evidence: readonly Readonly<{
    checkId: string;
    result:
      | "passed"
      | "failed"
      | "skipped"
      | "cancelled"
      | "neutral"
      | "planned"
      | "out-of-scope";
    source: Readonly<{
      repositoryId: number;
      appId: number;
      event: string;
      workflowPath: string;
      workflowBlobSha: string;
      runId: number;
      runAttempt: number;
      headSha: string;
      baseSha: string;
      mergeSha: string;
    }>;
    artifactSha256: string | null;
    coveredCheckIds: readonly string[];
  }>[];
  branchProtection: Readonly<{
    readable: boolean;
    protected: boolean;
    branch: string;
    requiresUpToDate: boolean;
    dismissesStaleReviews: boolean;
    enforcesAdmins: boolean;
    requiredApprovingReviews: number;
    requiredChecks: readonly Readonly<{ name: string; appId: number | null }>[];
    bypassActorIds: readonly number[];
  }> | null;
  runtime: Readonly<{
    reviewAppInstalledForRepository: boolean | null;
    anotherApprovalInFlight: boolean;
    productionMergeAuthorized: boolean | null;
    ordinaryMergeTriggersProduction: boolean | null;
  }>;
}>;

export type TrustedPrReviewPolicy = Readonly<{
  repositoryId: number;
  repositoryName: string;
  defaultBranch: string;
  policyVersion: string;
  reviewAppId: number | null;
  actionsAppId: number | null;
  validateWorkflowBlobSha: string | null;
  humanApprovedPaths?: readonly string[];
  humanApprovedNoRuntimeImpact?: boolean;
}>;

export type PrReviewGateReport = Readonly<{
  version: string;
  mode: "read-only";
  policyVersion: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  baseSha: string;
  mergeSha: string | null;
  requirementDigest: string;
  outcome: GateOutcome;
  reasons: readonly GateReason[];
  requiredEvidenceIds: readonly string[];
  acceptedEvidenceIds: readonly string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return Number(value);
}

function requiredSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a 40-character Git SHA.`);
  }
  return value.toLowerCase();
}

function requiredTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
      timestamp,
    ) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new Error(`${label} must be an RFC 3339 timestamp.`);
  }
  return timestamp;
}

function parseStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((entry, index) =>
    requiredString(entry, `${label}[${index}]`),
  );
}

function parseNumberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((entry, index) =>
    requiredPositiveInteger(entry, `${label}[${index}]`),
  );
}

function parseStringArrayOrEmpty(value: unknown, label: string): string[] {
  return value === undefined ? [] : parseStringArray(value, label);
}

function parseNumberArrayOrEmpty(value: unknown, label: string): number[] {
  return value === undefined ? [] : parseNumberArray(value, label);
}

function parseFinding(
  value: unknown,
  index: number,
): PrReviewGateInput["review"]["findings"][number] {
  if (!isRecord(value)) throw new Error(`review.findings[${index}] must be an object.`);
  const severity = value.severity;
  if (severity !== "P0" && severity !== "P1" && severity !== "P2" && severity !== "P3") {
    throw new Error(`review.findings[${index}].severity is invalid.`);
  }
  return {
    severity,
    file: requiredString(value.file, `review.findings[${index}].file`),
    line: requiredPositiveInteger(value.line, `review.findings[${index}].line`),
    trigger: requiredString(value.trigger, `review.findings[${index}].trigger`),
    userImpact: requiredString(
      value.userImpact,
      `review.findings[${index}].userImpact`,
    ),
    evidence: requiredString(value.evidence, `review.findings[${index}].evidence`),
  };
}

function parseEvidence(
  value: unknown,
  index: number,
): PrReviewGateInput["evidence"][number] {
  if (!isRecord(value)) throw new Error(`evidence[${index}] must be an object.`);
  const result = value.result;
  const allowedResults = [
    "passed",
    "failed",
    "skipped",
    "cancelled",
    "neutral",
    "planned",
    "out-of-scope",
  ] as const;
  if (
    typeof result !== "string" ||
    !(allowedResults as readonly string[]).includes(result)
  ) {
    throw new Error(`evidence[${index}].result is invalid.`);
  }
  const source = value.source;
  if (!isRecord(source)) throw new Error(`evidence[${index}].source must be an object.`);
  const artifactSha256 =
    value.artifactSha256 === null
      ? null
      : requiredString(value.artifactSha256, `evidence[${index}].artifactSha256`);
  if (
    artifactSha256 !== null &&
    !/^[0-9a-f]{64}$/i.test(artifactSha256)
  ) {
    throw new Error(`evidence[${index}].artifactSha256 must be a SHA-256 digest.`);
  }
  return {
    checkId: requiredString(value.checkId, `evidence[${index}].checkId`),
    result: result as PrReviewGateInput["evidence"][number]["result"],
    source: {
      repositoryId: requiredPositiveInteger(
        source.repositoryId,
        `evidence[${index}].source.repositoryId`,
      ),
      appId: requiredPositiveInteger(
        source.appId,
        `evidence[${index}].source.appId`,
      ),
      event: requiredString(source.event, `evidence[${index}].source.event`),
      workflowPath: requiredString(
        source.workflowPath,
        `evidence[${index}].source.workflowPath`,
      ),
      workflowBlobSha: requiredSha(
        source.workflowBlobSha,
        `evidence[${index}].source.workflowBlobSha`,
      ),
      runId: requiredPositiveInteger(source.runId, `evidence[${index}].source.runId`),
      runAttempt: requiredPositiveInteger(
        source.runAttempt,
        `evidence[${index}].source.runAttempt`,
      ),
      headSha: requiredSha(source.headSha, `evidence[${index}].source.headSha`),
      baseSha: requiredSha(source.baseSha, `evidence[${index}].source.baseSha`),
      mergeSha: requiredSha(source.mergeSha, `evidence[${index}].source.mergeSha`),
    },
    artifactSha256,
    coveredCheckIds: parseStringArrayOrEmpty(
      value.coveredCheckIds,
      `evidence[${index}].coveredCheckIds`,
    ),
  };
}

export function parseIssueClosureExclusions(title: string, body: string): Readonly<{
  keepOpenIssueNumbers: readonly number[];
  ambiguous: boolean;
}> {
  const keepOpen = new Set<number>();
  let ambiguous = false;
  const text = `${title}\n${body}`.replace(/https?:\/\/[^\s<>\)]+/g, (url) => {
    const local = url.match(/^https:\/\/github\.com\/lukemyself-hub\/SayHear\/issues\/([1-9]\d{0,8})(?:[?#].*)?$/i);
    return local ? `#${local[1]}` : " ";
  });
  // A negative close statement is a lifecycle instruction, not a merge hold.
  // Restrict number lists to the clause itself so later positive close lists
  // cannot accidentally become exclusions.
  const directive = /(?:不(?:会)?(?:自动)?关闭(?:也不修改)?|不要(?:自动)?关闭|不得(?:自动)?关闭|不予关闭|不应关闭|do not (?:automatically )?close|don't (?:auto[- ]|automatically )?close|does not close|doesn't close|will not close|not closing|keep open(?: issues?)?)[ :：*`]*(?:issues?\s*)?((?:#[1-9]\d{0,8})(?:(?:\s*[,，、和及&]\s*|\s+and\s+)#[1-9]\d{0,8})*)/gi;
  const negative = /不(?:会)?(?:自动)?关闭|不要(?:自动)?关闭|不得(?:自动)?关闭|不予关闭|不应关闭|do not (?:automatically )?close|don't (?:auto[- ]|automatically )?close|does not close|doesn't close|will not close|not closing|keep open|保持开放|remains? open|stays? open|(?:keep|leave)\s+.*\s+open/gi;
  for (const clause of text.split(/[。；;!！?？\n]|\.(?:\s|$)/)) {
    let remaining = clause.replace(directive, (_match, list: string) => {
      for (const number of list.matchAll(/#([1-9]\d{0,8})/g)) keepOpen.add(Number(number[1]));
      return " ";
    });
    remaining = remaining.replace(/((?:#[1-9]\d{0,8})(?:(?:\s*[,，、和及&]\s*|\s+and\s+)#[1-9]\d{0,8})*)[ :：*`]*(?:保持开放|(?:will )?remains? open|(?:should )?stays? open)/gi, (_match, list: string) => {
      for (const number of list.matchAll(/#([1-9]\d{0,8})/g)) keepOpen.add(Number(number[1]));
      return " ";
    });
    remaining = remaining.replace(/(?:keep|leave)\s+((?:#[1-9]\d{0,8})(?:(?:\s*[,，、和及&]\s*|\s+and\s+)#[1-9]\d{0,8})*)\s+open/gi, (_match, list: string) => {
      for (const number of list.matchAll(/#([1-9]\d{0,8})/g)) keepOpen.add(Number(number[1]));
      return " ";
    });
    if (negative.test(remaining)) ambiguous = true;
    negative.lastIndex = 0;
  }
  return { keepOpenIssueNumbers: [...keepOpen].sort((left, right) => left - right), ambiguous };
}

function parsePrReviewIssue(value: unknown, index: number): PrReviewIssue {
  const path = `issues[${index}]`;
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  if (value.state !== "open" && value.state !== "closed") {
    throw new Error(`${path}.state must be open or closed.`);
  }
  const pause = value.pause;
  if (!isRecord(pause)) throw new Error(`${path}.pause must be an object.`);
  const source = pause.source;
  if (source !== "none" && source !== "maintainer" && source !== "review-app" && source !== "unknown") {
    throw new Error(`${path}.pause.source is invalid.`);
  }
  return {
    number: requiredPositiveInteger(value.number, `${path}.number`),
    state: value.state,
    title: requiredString(value.title, `${path}.title`),
    body: typeof value.body === "string" ? value.body : "",
    updatedAt: requiredTimestamp(value.updatedAt, `${path}.updatedAt`),
    discussionDigest: requiredString(value.discussionDigest, `${path}.discussionDigest`),
    labels: parseStringArrayOrEmpty(value.labels, `${path}.labels`),
    blockedBy: value.blockedBy === null ? null : parseNumberArrayOrEmpty(value.blockedBy, `${path}.blockedBy`),
    pause: { active: requiredBoolean(pause.active, `${path}.pause.active`), source },
  };
}

/**
 * Parse the model report and GitHub snapshot as data only. PR text and report
 * fields never become shell commands or executable code.
 */
export function parsePrReviewGateInput(value: unknown): PrReviewGateInput {
  if (!isRecord(value)) throw new Error("PR review gate input must be a JSON object.");
  const repository = value.repository;
  const pullRequest = value.pullRequest;
  const issues = value.issues;
  const review = value.review;
  const runtime = value.runtime;
  if (!isRecord(repository) || !isRecord(pullRequest) || !Array.isArray(issues)) {
    throw new Error("PR review gate input is missing repository, pullRequest, or issues.");
  }
  if (!isRecord(review) || !isRecord(runtime)) {
    throw new Error("PR review gate input is missing review or runtime.");
  }

  const pullState = pullRequest.state;
  if (pullState !== "open" && pullState !== "closed") {
    throw new Error("pullRequest.state must be open or closed.");
  }
  if (!Array.isArray(pullRequest.changedFiles)) {
    throw new Error("pullRequest.changedFiles must be an array.");
  }
  const externalReviewState = pullRequest.externalReviewState;
  if (
    externalReviewState !== "clear" &&
    externalReviewState !== "needs-human" &&
    externalReviewState !== "unavailable"
  ) {
    throw new Error("pullRequest.externalReviewState is invalid.");
  }
  const changedFiles = pullRequest.changedFiles.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`pullRequest.changedFiles[${index}] must be an object.`);
    }
    const status = entry.status;
    if (
      status !== "added" &&
      status !== "modified" &&
      status !== "removed" &&
      status !== "renamed" &&
      status !== "copied"
    ) {
      throw new Error(`pullRequest.changedFiles[${index}].status is invalid.`);
    }
    return {
      path: requiredString(entry.path, `pullRequest.changedFiles[${index}].path`),
        status: status as PrReviewGateInput["pullRequest"]["changedFiles"][number]["status"],
    };
  });

  const impactKinds = review.declaredImpacts;
  if (!Array.isArray(impactKinds)) {
    throw new Error("review.declaredImpacts must be an array.");
  }
  const parsedImpacts = impactKinds.map((impact, index) => {
    if (
      typeof impact !== "string" ||
      !(IMPACT_KINDS as readonly string[]).includes(impact)
    ) {
      throw new Error(`review.declaredImpacts[${index}] is invalid.`);
    }
    return impact as ReleaseImpactKind;
  });
  const capability = review.capability;
  const riskFlags = review.riskFlags;
  if (!isRecord(capability) || !isRecord(riskFlags)) {
    throw new Error("review.capability and review.riskFlags must be objects.");
  }
  const parsedRiskFlags = Object.fromEntries(
    REQUIRED_REVIEW_FLAGS.map((flag) => [
      flag,
      requiredBoolean(riskFlags[flag], `review.riskFlags.${flag}`),
    ]),
  ) as PrReviewGateInput["review"]["riskFlags"];
  const decision = review.decision;
  if (
    decision !== "approve" &&
    decision !== "request_changes" &&
    decision !== "awaiting_verification" &&
    decision !== "human_decision"
  ) {
    throw new Error("review.decision is invalid.");
  }
  if (!Array.isArray(review.findings)) {
    throw new Error("review.findings must be an array.");
  }

  let branchProtection: PrReviewGateInput["branchProtection"] = null;
  if (value.branchProtection !== null) {
    const protection = value.branchProtection;
    if (!isRecord(protection) || !Array.isArray(protection.requiredChecks)) {
      throw new Error("branchProtection must be null or a valid object.");
    }
    branchProtection = {
      readable: requiredBoolean(protection.readable, "branchProtection.readable"),
      protected: requiredBoolean(protection.protected, "branchProtection.protected"),
      branch: requiredString(protection.branch, "branchProtection.branch"),
      requiresUpToDate: requiredBoolean(
        protection.requiresUpToDate,
        "branchProtection.requiresUpToDate",
      ),
      dismissesStaleReviews: requiredBoolean(
        protection.dismissesStaleReviews,
        "branchProtection.dismissesStaleReviews",
      ),
      enforcesAdmins: requiredBoolean(
        protection.enforcesAdmins,
        "branchProtection.enforcesAdmins",
      ),
      requiredApprovingReviews: requiredNonNegativeInteger(
        protection.requiredApprovingReviews,
        "branchProtection.requiredApprovingReviews",
      ),
      requiredChecks: protection.requiredChecks.map((entry, index) => {
        if (!isRecord(entry)) {
          throw new Error(`branchProtection.requiredChecks[${index}] must be an object.`);
        }
        const appId =
          entry.appId === null
            ? null
            : requiredPositiveInteger(
                entry.appId,
                `branchProtection.requiredChecks[${index}].appId`,
              );
        return {
          name: requiredString(
            entry.name,
            `branchProtection.requiredChecks[${index}].name`,
          ),
          appId,
        };
      }),
      bypassActorIds: parseNumberArray(
        protection.bypassActorIds,
        "branchProtection.bypassActorIds",
      ),
    };
  }

  const evidence = value.evidence;
  if (!Array.isArray(evidence)) throw new Error("evidence must be an array.");
  const mergeSha =
    pullRequest.mergeSha === null
      ? null
      : requiredSha(pullRequest.mergeSha, "pullRequest.mergeSha");

  const installed = runtime.reviewAppInstalledForRepository;
  if (installed !== null && typeof installed !== "boolean") {
    throw new Error("runtime.reviewAppInstalledForRepository must be boolean or null.");
  }
  const productionAuthorized = runtime.productionMergeAuthorized;
  if (
    productionAuthorized !== null &&
    typeof productionAuthorized !== "boolean"
  ) {
    throw new Error("runtime.productionMergeAuthorized must be boolean or null.");
  }
  const productionMerge = runtime.ordinaryMergeTriggersProduction;
  if (productionMerge !== null && typeof productionMerge !== "boolean") {
    throw new Error("runtime.ordinaryMergeTriggersProduction must be boolean or null.");
  }

  return {
    repository: {
      id: requiredPositiveInteger(repository.id, "repository.id"),
      fullName: requiredString(repository.fullName, "repository.fullName"),
      defaultBranch: requiredString(
        repository.defaultBranch,
        "repository.defaultBranch",
      ),
      defaultBranchSha: requiredSha(
        repository.defaultBranchSha,
        "repository.defaultBranchSha",
      ),
      allowAutoMerge: requiredBoolean(
        repository.allowAutoMerge,
        "repository.allowAutoMerge",
      ),
    },
    pullRequest: {
      number: requiredPositiveInteger(pullRequest.number, "pullRequest.number"),
      state: pullState,
      draft: requiredBoolean(pullRequest.draft, "pullRequest.draft"),
      title: requiredString(pullRequest.title, "pullRequest.title"),
      body: typeof pullRequest.body === "string" ? pullRequest.body : "",
      updatedAt: requiredTimestamp(
        pullRequest.updatedAt,
        "pullRequest.updatedAt",
      ),
      discussionDigest: requiredString(
        pullRequest.discussionDigest,
        "pullRequest.discussionDigest",
      ),
      externalReviewState,
      headSha: requiredSha(pullRequest.headSha, "pullRequest.headSha"),
      baseSha: requiredSha(pullRequest.baseSha, "pullRequest.baseSha"),
      mergeSha,
      baseRef: requiredString(pullRequest.baseRef, "pullRequest.baseRef"),
      headRepositoryId:
        pullRequest.headRepositoryId === null
          ? null
          : requiredPositiveInteger(
              pullRequest.headRepositoryId,
              "pullRequest.headRepositoryId",
            ),
      authorId: requiredPositiveInteger(pullRequest.authorId, "pullRequest.authorId"),
      lastCommitAuthorId:
        pullRequest.lastCommitAuthorId === null
          ? null
          : requiredPositiveInteger(
              pullRequest.lastCommitAuthorId,
              "pullRequest.lastCommitAuthorId",
            ),
      linkedIssueNumbers: parseNumberArray(
        pullRequest.linkedIssueNumbers,
        "pullRequest.linkedIssueNumbers",
      ),
      keepOpenIssueNumbers: parseNumberArrayOrEmpty(pullRequest.keepOpenIssueNumbers, "pullRequest.keepOpenIssueNumbers"),
      issueClosureAmbiguous: requiredBoolean(pullRequest.issueClosureAmbiguous, "pullRequest.issueClosureAmbiguous"),
      changedFiles,
    },
    issues: issues.map(parsePrReviewIssue),
    review: {
      version: requiredString(review.version, "review.version"),
      repositoryId: requiredPositiveInteger(
        review.repositoryId,
        "review.repositoryId",
      ),
      pullRequestNumber: requiredPositiveInteger(
        review.pullRequestNumber,
        "review.pullRequestNumber",
      ),
      headSha: requiredSha(review.headSha, "review.headSha"),
      baseSha: requiredSha(review.baseSha, "review.baseSha"),
      policyVersion: requiredString(review.policyVersion, "review.policyVersion"),
      requirementDigest: requiredString(
        review.requirementDigest,
        "review.requirementDigest",
      ),
      decision,
      diffComplete: requiredBoolean(review.diffComplete, "review.diffComplete"),
      reviewerAppId: requiredPositiveInteger(
        review.reviewerAppId,
        "review.reviewerAppId",
      ),
      reviewerActorId: requiredPositiveInteger(
        review.reviewerActorId,
        "review.reviewerActorId",
      ),
      declaredImpacts: parsedImpacts,
      capability: {
        newCapabilityEnabled: requiredBoolean(
          capability.newCapabilityEnabled,
          "review.capability.newCapabilityEnabled",
        ),
        majorContractChange: requiredBoolean(
          capability.majorContractChange,
          "review.capability.majorContractChange",
        ),
        externalMvpRelease: requiredBoolean(
          capability.externalMvpRelease,
          "review.capability.externalMvpRelease",
        ),
      },
      riskFlags: parsedRiskFlags,
      findings: review.findings.map(parseFinding),
    },
    evidence: evidence.map(parseEvidence),
    branchProtection,
    runtime: {
      reviewAppInstalledForRepository: installed,
      anotherApprovalInFlight: requiredBoolean(
        runtime.anotherApprovalInFlight,
        "runtime.anotherApprovalInFlight",
      ),
      productionMergeAuthorized: productionAuthorized,
      ordinaryMergeTriggersProduction: productionMerge,
    },
  };
}

export function requirementDigest(
  requirement: Pick<PrReviewIssue, "number" | "title" | "body" | "updatedAt" | "discussionDigest"> | readonly Pick<PrReviewIssue, "number" | "title" | "body" | "updatedAt" | "discussionDigest">[],
  pullRequest: {
    number: number;
    title: string;
    body: string;
    updatedAt: string;
    discussionDigest: string;
  },
): string {
  const issues: readonly Pick<PrReviewIssue, "number" | "title" | "body" | "updatedAt" | "discussionDigest">[] =
    "number" in requirement ? [requirement] : requirement;
  const sorted = [...issues].sort((left, right) => left.number - right.number);
  return createHash("sha256").update(JSON.stringify({
    issues: sorted.map((issue) => ({
      number: issue.number, title: issue.title, body: issue.body,
      discussionDigest: issue.discussionDigest,
    })),
    pullRequest: {
      number: pullRequest.number, title: pullRequest.title, body: pullRequest.body,
      discussionDigest: pullRequest.discussionDigest,
    },
  }), "utf8").digest("hex");
}

function outcome(
  input: PrReviewGateInput,
  result: GateOutcome,
  reason: GateReason,
  requiredEvidenceIds: readonly string[] = [],
  acceptedEvidenceIds: readonly string[] = [],
): PrReviewGateReport {
  return {
    version: PR_REVIEW_REPORT_VERSION,
    mode: "read-only",
    policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
    repository: input.repository.fullName,
    pullRequestNumber: input.pullRequest.number,
    headSha: input.pullRequest.headSha,
    baseSha: input.pullRequest.baseSha,
    mergeSha: input.pullRequest.mergeSha,
    requirementDigest: requirementDigest(input.issues, input.pullRequest),
    outcome: result,
    reasons: [reason],
    requiredEvidenceIds,
    acceptedEvidenceIds,
  };
}

function hasExactRequiredChecks(
  protection: NonNullable<PrReviewGateInput["branchProtection"]>,
  actionsAppId: number,
  reviewAppId: number,
): boolean {
  const expected = [
    { name: "validate", appId: actionsAppId },
    { name: PR_REVIEW_GATE_CHECK_NAME, appId: reviewAppId },
  ];
  return (
    protection.requiredChecks.length === expected.length &&
    expected.every(
      ({ name, appId }) =>
        protection.requiredChecks.filter(
          (check) => check.name === name && check.appId === appId,
        ).length === 1,
    )
  );
}

function isTestPath(path: string): boolean {
  return (
    path.startsWith("tests/") &&
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)
  );
}

function requiresHumanReview(input: PrReviewGateInput, policy: TrustedPrReviewPolicy): string | null {
  if (input.pullRequest.externalReviewState === "needs-human") {
    return "A human review or review thread needs attention.";
  }
  if (
    /\b(?:do not merge|do not auto[- ]merge|not for merge|not to be merged)\b|不要(?:自动)?合入|暂停自动审批/i.test(
      [input.pullRequest.title, input.pullRequest.body, ...input.issues.map((issue) => issue.body)].join("\n"),
    )
  ) {
    return "The PR or Issue explicitly pauses automatic merging.";
  }
  for (const { path, status } of input.pullRequest.changedFiles) {
    const normalized = path.replaceAll("\\", "/");
    if (
      !policy.humanApprovedPaths?.includes(normalized) && HUMAN_REVIEW_PATHS.some(
        (prefix) =>
          normalized === prefix ||
          normalized.startsWith(prefix) ||
          normalized.startsWith(prefix.replace(/\/$/, "")),
      )
    ) {
      return `The change touches protected review or product policy path ${normalized}.`;
    }
    if (status === "removed" && isTestPath(normalized)) {
      return `The change removes test file ${normalized}.`;
    }
  }
  if (REQUIRED_REVIEW_FLAGS.some((flag) => input.review.riskFlags[flag])) {
    return "The review identified a product, authorization, privacy, migration, or feature-enable decision.";
  }
  if (
    input.review.capability.newCapabilityEnabled ||
    input.review.capability.majorContractChange ||
    input.review.capability.externalMvpRelease
  ) {
    return "This change triggers full capability acceptance or a product release decision.";
  }
  const numbers = input.issues.map((issue) => issue.number);
  const linked = input.pullRequest.linkedIssueNumbers;
  if (numbers.length === 0 || new Set(numbers).size !== numbers.length ||
    new Set(linked).size !== linked.length || numbers.length !== linked.length ||
    linked.some((number) => !numbers.includes(number))) {
    return "The PR must supply every referenced Issue exactly once.";
  }
  if (input.pullRequest.state !== "open") return "The PR is closed.";
  const exclusions = parseIssueClosureExclusions(input.pullRequest.title, input.pullRequest.body);
  if (input.pullRequest.issueClosureAmbiguous || exclusions.ambiguous ||
    exclusions.keepOpenIssueNumbers.join() !== [...input.pullRequest.keepOpenIssueNumbers].sort((a, b) => a - b).join() ||
    input.pullRequest.keepOpenIssueNumbers.some((number) => !numbers.includes(number))) {
    return "The PR's keep-open Issue declarations are ambiguous or inconsistent.";
  }
  const deliveryIssues = input.issues.filter((issue) => !input.pullRequest.keepOpenIssueNumbers.includes(issue.number));
  if (!deliveryIssues.some((issue) => issue.state === "open")) {
    return "All referenced Issues are already closed.";
  }
  for (const issue of input.issues) {
    if (issue.body.trim().length === 0) return `Issue #${issue.number} has no review requirement.`;
    if (input.pullRequest.keepOpenIssueNumbers.includes(issue.number)) continue;
    if (issue.pause.active || issue.pause.source === "unknown") {
      return `Issue #${issue.number} is paused or its pause state cannot be trusted.`;
    }
    if (issue.state === "closed") continue;
    if (issue.blockedBy === null || issue.blockedBy.some((number) => !deliveryIssues.some((target) => target.number === number))) {
      return `Issue #${issue.number} still has blocking dependencies outside this PR.`;
    }
    if (issue.labels.some((label) =>
      ["ready-for-human", "needs-info", "needs-triage", "wontfix"].includes(label.toLowerCase()))) {
      return `Issue #${issue.number} has a triage label that requires a human decision.`;
    }
  }
  return null;
}

function verifyEvidence(
  input: PrReviewGateInput,
  policy: TrustedPrReviewPolicy,
  requiredIds: readonly string[],
): { accepted: string[]; blocker: string | null } {
  const entriesById = new Map<string, PrReviewGateInput["evidence"][number]>();
  const duplicateIds = new Set<string>();
  let evidenceRun: { runId: number; runAttempt: number } | null = null;
  for (const entry of input.evidence) {
    if (entriesById.has(entry.checkId)) duplicateIds.add(entry.checkId);
    else entriesById.set(entry.checkId, entry);
  }
  if (duplicateIds.size > 0) {
    return {
      accepted: [],
      blocker: `Evidence contains duplicate check records: ${[...duplicateIds].join(", ")}.`,
    };
  }

  const accepted: string[] = [];
  for (const checkId of requiredIds) {
    const evidence = entriesById.get(checkId);
    if (!evidence) return { accepted, blocker: `Required evidence ${checkId} is missing.` };
    if (evidence.result !== "passed") {
      return {
        accepted,
        blocker: `Required evidence ${checkId} is ${evidence.result}, not passed.`,
      };
    }
    const source = evidence.source;
    if (
      source.repositoryId !== policy.repositoryId ||
      source.appId !== policy.actionsAppId ||
      source.event !== "pull_request" ||
      source.workflowPath !== PR_VALIDATE_WORKFLOW_PATH ||
      source.workflowBlobSha !== policy.validateWorkflowBlobSha ||
      source.headSha !== input.pullRequest.headSha ||
      source.baseSha !== input.pullRequest.baseSha ||
      source.mergeSha !== input.pullRequest.mergeSha
    ) {
      return {
        accepted,
        blocker: `Required evidence ${checkId} does not match the trusted workflow and current PR snapshot.`,
      };
    }
    if (
      evidenceRun !== null &&
      (source.runId !== evidenceRun.runId ||
        source.runAttempt !== evidenceRun.runAttempt)
    ) {
      return {
        accepted,
        blocker: `Required evidence ${checkId} comes from a different workflow run or attempt.`,
      };
    }
    evidenceRun = { runId: source.runId, runAttempt: source.runAttempt };
    if (
      !FIXED_BASELINE_IDS.has(checkId) &&
      (!evidence.artifactSha256 || !evidence.coveredCheckIds.includes(checkId))
    ) {
      return {
        accepted,
        blocker: `Targeted evidence ${checkId} is missing its verified test artifact entry.`,
      };
    }
    accepted.push(checkId);
  }
  return { accepted, blocker: null };
}

export function evaluatePrReviewGate(
  input: PrReviewGateInput,
  policy: TrustedPrReviewPolicy,
): PrReviewGateReport {
  if (
    input.repository.id !== policy.repositoryId ||
    input.repository.fullName !== policy.repositoryName ||
    input.repository.defaultBranch !== policy.defaultBranch
  ) {
    return outcome(input, "human_decision", {
      code: "repository_mismatch",
      message: "The snapshot is not for the configured SayHear repository.",
    });
  }
  if (
    input.review.version !== PR_REVIEW_REPORT_VERSION ||
    input.review.policyVersion !== policy.policyVersion ||
    policy.policyVersion !== PR_REVIEW_GATE_POLICY_VERSION
  ) {
    return outcome(input, "awaiting_verification", {
      code: "policy_version_mismatch",
      message: "The review report was produced for a different gate policy version.",
    });
  }
  if (
    input.review.repositoryId !== input.repository.id ||
    input.review.pullRequestNumber !== input.pullRequest.number ||
    input.review.headSha !== input.pullRequest.headSha ||
    input.review.baseSha !== input.pullRequest.baseSha
  ) {
    return outcome(input, "awaiting_verification", {
      code: "stale_review",
      message: "The review report does not match the current repository, PR, head, and base.",
    });
  }
  if (
    input.review.requirementDigest !==
    requirementDigest(input.issues, input.pullRequest)
  ) {
    return outcome(input, "human_decision", {
      code: "requirements_changed",
      message: "The linked Issue changed after the review report was produced.",
    });
  }

  if (
    input.pullRequest.externalReviewState === "unavailable" ||
    input.issues.some((issue) => issue.state === "open" && !input.pullRequest.keepOpenIssueNumbers.includes(issue.number) && issue.blockedBy === null)
  ) {
    return outcome(input, "awaiting_verification", {
      code: "github_context_unavailable",
      message:
        "The current PR reviews, Issue discussion, or dependency state could not be read.",
    });
  }

  const humanReason = requiresHumanReview(input, policy);
  if (humanReason) {
    return outcome(input, "human_decision", {
      code: "human_review_required",
      message: humanReason,
    });
  }
  if (
    input.pullRequest.draft ||
    input.pullRequest.baseRef !== policy.defaultBranch ||
    input.pullRequest.headRepositoryId !== input.repository.id
  ) {
    return outcome(input, "awaiting_verification", {
      code: "pr_not_ready",
      message: "The PR is Draft, targets a different branch, or comes from another repository.",
    });
  }
  if (
    input.pullRequest.baseSha !== input.repository.defaultBranchSha ||
    input.pullRequest.mergeSha === null
  ) {
    return outcome(input, "awaiting_verification", {
      code: "base_or_merge_ref_changed",
      message: "The PR is not tested against the current main base and merge ref.",
    });
  }
  if (!input.review.diffComplete) {
    return outcome(input, "awaiting_verification", {
      code: "incomplete_diff",
      message: "The complete PR diff was not available to the reviewer.",
    });
  }
  if (
    input.review.decision === "request_changes" ||
    input.review.decision === "awaiting_verification" ||
    input.review.decision === "human_decision"
  ) {
    if (
      input.review.decision === "request_changes" &&
      !input.review.findings.some(
        (finding) =>
          finding.severity === "P0" ||
          finding.severity === "P1" ||
          finding.severity === "P2",
      )
    ) {
      return outcome(input, "awaiting_verification", {
        code: "request_changes_without_blocker",
        message:
          "A request for changes requires at least one concrete P0, P1, or P2 finding.",
      });
    }
    return outcome(input, input.review.decision, {
      code: `review_${input.review.decision}`,
      message: `The review result is ${input.review.decision}.`,
    });
  }
  if (
    input.review.findings.some(
      (finding) =>
        finding.severity === "P0" ||
        finding.severity === "P1" ||
        finding.severity === "P2",
    )
  ) {
    return outcome(input, "awaiting_verification", {
      code: "review_result_conflict",
      message: "The review says approve but contains a P0, P1, or P2 finding.",
    });
  }
  if (input.issues.some((issue) => issue.state === "open" && !input.pullRequest.keepOpenIssueNumbers.includes(issue.number) && !issue.labels.some((label) => label.toLowerCase() === "ongoing"))) {
    return outcome(input, "awaiting_verification", {
      code: "issue_not_claimed",
      message: "The linked Issue does not have the ongoing execution label.",
    });
  }
  if (
    input.issues.some((issue) => issue.state === "open" && !input.pullRequest.keepOpenIssueNumbers.includes(issue.number) && issue.labels.some(
      (label) => label.toLowerCase() === "ready-for-agent",
    ))
  ) {
    return outcome(input, "awaiting_verification", {
      code: "issue_label_conflict",
      message: "The linked Issue has both ongoing and ready-for-agent state.",
    });
  }
  if (
    policy.reviewAppId === null ||
    policy.actionsAppId === null ||
    policy.validateWorkflowBlobSha === null ||
    input.runtime.reviewAppInstalledForRepository === null
  ) {
    return outcome(input, "awaiting_verification", {
      code: "trusted_identity_unconfigured",
      message: "The dedicated review App, trusted CI identity, or installation is not verified.",
    });
  }
  if (
    input.runtime.reviewAppInstalledForRepository !== true ||
    input.review.reviewerAppId !== policy.reviewAppId ||
    input.review.reviewerActorId === input.pullRequest.authorId ||
    (input.pullRequest.lastCommitAuthorId !== null &&
      input.review.reviewerActorId === input.pullRequest.lastCommitAuthorId)
  ) {
    return outcome(input, "human_decision", {
      code: "review_identity_invalid",
      message: "The review identity is not the configured independent GitHub App.",
    });
  }
  if (input.pullRequest.lastCommitAuthorId === null) {
    return outcome(input, "awaiting_verification", {
      code: "review_author_unavailable",
      message: "The latest commit author could not be verified.",
    });
  }
  if (input.runtime.anotherApprovalInFlight) {
    return outcome(input, "awaiting_verification", {
      code: "repository_merge_busy",
      message: "Another PR approval or merge is already in flight.",
    });
  }
  if (input.repository.allowAutoMerge !== true) {
    return outcome(input, "human_decision", {
      code: "github_auto_merge_disabled",
      message: "GitHub auto-merge is not enabled for this repository.",
    });
  }

  const protection = input.branchProtection;
  if (!protection || !protection.readable) {
    return outcome(input, "awaiting_verification", {
      code: "branch_protection_unreadable",
      message: "The current main branch protection could not be read.",
    });
  }
  if (
    !protection.protected ||
    protection.branch !== policy.defaultBranch ||
    !protection.requiresUpToDate ||
    !protection.dismissesStaleReviews ||
    !protection.enforcesAdmins ||
    protection.requiredApprovingReviews !== 1 ||
    protection.bypassActorIds.length > 0 ||
    !hasExactRequiredChecks(
      protection,
      policy.actionsAppId,
      policy.reviewAppId,
    )
  ) {
    return outcome(input, "human_decision", {
      code: "branch_protection_incomplete",
      message: "main does not enforce the required checks, latest-base review, or independent approval.",
    });
  }
  if (input.runtime.ordinaryMergeTriggersProduction === null) {
    return outcome(input, "awaiting_verification", {
      code: "production_deploy_behavior_unknown",
      message: "The production effect of merging to main has not been verified.",
    });
  }
  if (
    input.runtime.ordinaryMergeTriggersProduction &&
    input.runtime.productionMergeAuthorized !== true
  ) {
    return outcome(input, "human_decision", {
      code: "production_merge_not_authorized",
      message: "Ordinary merges trigger production deployment, but that effect is not authorized.",
    });
  }
  if (
    input.pullRequest.changedFiles.some(({ path }) =>
      /^packages\/data\/migrations(?:-purge-marker)?\//i.test(path),
    )
  ) {
    return outcome(input, "awaiting_verification", {
      code: "migration_compatibility_evidence_required",
      message: "A migration needs verified old-schema upgrade and compatibility evidence.",
    });
  }

  const plan = planDailyReleaseValidation({
    version: DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
    change: {
      summary: `PR #${input.pullRequest.number} reviewed against Issues ${input.issues.map((issue) => `#${issue.number}`).join(", ")}.`,
      declaredImpacts: input.review.declaredImpacts,
      changedPaths: input.pullRequest.changedFiles.map(({ path }) => path),
    },
    capability: input.review.capability,
  });
  if (plan.fullAcceptance.required) {
    return outcome(input, "human_decision", {
      code: "full_acceptance_required",
      message: "This change requires full capability acceptance and a human release decision.",
    });
  }
  // A diff-bound no-runtime decision may also name these exact offline eval files.
  // It cannot classify arbitrary eval, runtime, or unknown paths.
  const approvedPaths = new Set(policy.humanApprovedPaths ?? []);
  const ownerLocatedTooling = policy.humanApprovedNoRuntimeImpact === true &&
    input.pullRequest.changedFiles.length > 0 &&
    input.pullRequest.changedFiles.every(({ path }) =>
      ENUMERATED_OFFLINE_EVALUATION_PATHS.has(path) ||
      (approvedPaths.has(path) &&
        (/^(?:scripts|tests|docs)\//.test(path) ||
          [".gitignore", "AGENTS.md", "CODEOWNERS", "package.json", "pnpm-lock.yaml"].includes(path) ||
          /^tsconfig[^/]*\.json$/.test(path))),
    );
  if (plan.requiresImpactLocation && !ownerLocatedTooling) {
    return outcome(input, "awaiting_verification", {
      code: "impact_not_located",
      message: "The change impact is unknown and must be classified before approval.",
    });
  }

  const requiredEvidenceIds = [
    ...plan.fixedBaseline,
    ...plan.targeted,
    ...plan.reused,
  ].map(({ check }) => check.id);
  const uniqueRequiredIds = [...new Set(requiredEvidenceIds)];
  const verification = verifyEvidence(input, policy, uniqueRequiredIds);
  if (verification.blocker) {
    return outcome(
      input,
      "awaiting_verification",
      { code: "required_evidence_missing", message: verification.blocker },
      uniqueRequiredIds,
      verification.accepted,
    );
  }

  return {
    version: PR_REVIEW_REPORT_VERSION,
    mode: "read-only",
    policyVersion: policy.policyVersion,
    repository: input.repository.fullName,
    pullRequestNumber: input.pullRequest.number,
    headSha: input.pullRequest.headSha,
    baseSha: input.pullRequest.baseSha,
    mergeSha: input.pullRequest.mergeSha,
    requirementDigest: requirementDigest(input.issues, input.pullRequest),
    outcome: "merge_candidate",
    reasons: [
      {
        code: "all_required_evidence_verified",
        message: "The snapshot satisfies the configured read-only merge candidate policy.",
      },
    ],
    requiredEvidenceIds: uniqueRequiredIds,
    acceptedEvidenceIds: verification.accepted,
  };
}

function optionalPositiveInteger(value: string | undefined): number | null {
  if (value === undefined || value.length === 0) return null;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function gitBlobSha(value: string | undefined): string | null {
  return value && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

export function trustedPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv,
): TrustedPrReviewPolicy {
  return {
    repositoryId: SAYHEAR_REPOSITORY_ID,
    repositoryName: SAYHEAR_REPOSITORY_NAME,
    defaultBranch: "main",
    policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
    reviewAppId: optionalPositiveInteger(environment.SAYHEAR_PR_REVIEW_APP_ID),
    actionsAppId: optionalPositiveInteger(environment.SAYHEAR_PR_ACTIONS_APP_ID),
    validateWorkflowBlobSha: gitBlobSha(
      environment.SAYHEAR_PR_VALIDATE_WORKFLOW_BLOB_SHA,
    ),
  };
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Argument ${token} requires a value.`);
    }
    args.set(token, value);
    index += 1;
  }
  return args;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: {
    stdout: (line: string) => void;
    environment?: NodeJS.ProcessEnv;
  } = { stdout: (line) => process.stdout.write(`${line}\n`) },
): Promise<number> {
  const args = parseArgs(argv);
  const inputPath = args.get("--input");
  if (!inputPath) {
    throw new Error("Usage: pr-review-gate.ts --input <snapshot.json>");
  }
  const parsedInput = parsePrReviewGateInput(
    JSON.parse(await readFile(inputPath, "utf8")) as unknown,
  );
  const report = evaluatePrReviewGate(
    parsedInput,
    trustedPolicyFromEnvironment(io.environment ?? process.env),
  );
  io.stdout(JSON.stringify(report, null, 2));
  return 0;
}

const entryPoint = process.argv[1]?.replace(/\\/g, "/");
const isDirectRun =
  entryPoint === "scripts/pr-review-gate.ts" ||
  entryPoint?.endsWith("/scripts/pr-review-gate.ts") === true;

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
