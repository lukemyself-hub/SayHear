import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  DAILY_RELEASE_VALIDATION_REQUEST_VERSION,
  FIXED_PR_CI_BASELINE,
  RELEASE_STAGES,
  planDailyReleaseValidation,
  preMergeDeferralFor,
  type PreMergeDeferralPolicy,
  type PreMergeImpossibleReason,
  type ReleaseImpactKind,
} from "./daily-release-validation.ts";

// Historical installed policies remain readable for signed completion receipts.
// They do not acquire the head-bound review semantics introduced by v10.
export const PR_REVIEW_GATE_POLICY_VERSION = "sayhear-pr-review-gate:v11";
export const PR_REVIEW_GATE_V10_POLICY_VERSION = "sayhear-pr-review-gate:v10";
export const PR_REVIEW_GATE_V9_POLICY_VERSION = "sayhear-pr-review-gate:v9";
export const PR_REVIEW_GATE_LEGACY_POLICY_VERSION = "sayhear-pr-review-gate:v4";
export const PR_REVIEW_GATE_PREVIOUS_POLICY_VERSION = "sayhear-pr-review-gate:v5";
export const PR_REVIEW_GATE_INSTALLED_POLICY_VERSION = "sayhear-pr-review-gate:v8";
export const PR_REVIEW_GATE_OLDER_INSTALLED_POLICY_VERSION = "sayhear-pr-review-gate:v6";
export const PR_REVIEW_REPORT_VERSION = "sayhear-pr-review-report:v4";
export const SAYHEAR_REPOSITORY_ID = 1312399710;
export const SAYHEAR_REPOSITORY_NAME = "lukemyself-hub/SayHear";
export const PR_VALIDATE_WORKFLOW_PATH = ".github/workflows/pr-validate.yml";
export const PR_REVIEW_GATE_CHECK_NAME = "pr-review-gate";

/**
 * How a PR proves it integrates with the current main before it merges.
 *
 * `up-to-date-base` requires the PR base to equal main.
 *
 * `merge-queue` is reserved for historical configuration parsing. Activation
 * is refused until every required check has a trusted merge-group producer.
 *
 * `serialized-merge` separates reusable head review from current-main evidence.
 * The controller issues the merge under an App-only main writer guard.
 */
export type IntegrationMode =
  | "up-to-date-base"
  | "merge-queue"
  | "serialized-merge";

/**
 * Who is allowed to update the default branch.
 *
 * `serialized-merge` merges a stale-base PR against whatever main is at the
 * moment of the merge request. GitHub recomputes that merge then, so the merge
 * itself cannot miss intervening commits, but nothing stops another writer from
 * advancing main in the window between the controller's last read and its merge
 * request. The repository therefore has to prove that the only actor able to
 * update main is the approval App.
 *
 * Only rulesets that restrict updates to the default branch count. A ruleset
 * that happens to name the App but governs tags, another branch, or a different
 * rule cannot satisfy this, and anything unreadable fails closed.
 */
export type MainWriterGuard = Readonly<{
  /** False when the rulesets could not be read; the guard then never passes. */
  readable: boolean;
  /** At least one active ruleset restricts updates to the default branch. */
  restrictsDefaultBranchUpdates: boolean;
  /** Actor ids that may bypass such a restriction, deduplicated and sorted. */
  bypassActorIds: readonly number[];
  /**
   * False when GitHub withheld the bypass set from this App.
   *
   * The list endpoint behind `/rulesets` answers with summaries only, and the
   * detail endpoint returns `bypass_actors` only to a caller holding
   * administration access. A missing set is therefore unproven, never empty:
   * the guard refuses to read "I could not see the bypass actors" as "there are
   * none".
   */
  bypassActorsEnumerated: boolean;
  /**
   * GitHub's own `current_user_can_bypass` for the approval App on the
   * restricting ruleset, kept for the audit trail. Null when GitHub omits it.
   */
  appBypassMode: string | null;
  /** Ids of the rulesets that contributed, for the audit trail. */
  rulesetIds: readonly number[];
  /**
   * Content fingerprints of the covering update rulesets, one per ruleset.
   *
   * Optional so snapshots built before fingerprints existed still parse. The
   * attested path below requires it: without a live fingerprint there is
   * nothing to compare the attestation against.
   */
  rulesetFingerprints?: readonly RulesetFingerprint[];
}>;

export type RulesetFingerprint = Readonly<{
  /** The GitHub ruleset id this fingerprint was taken from. */
  id: number;
  /** Lowercase hex SHA-256 over the canonical ruleset detail. */
  fingerprint: string;
}>;

/** Schema version of the root-owned main writer attestation record. */
export const MAIN_WRITER_ATTESTATION_VERSION = 1;

/**
 * A root-owned operator attestation that a ruleset nobody can enumerate
 * still restricts the default branch to the approval App alone.
 *
 * GitHub withholds `bypass_actors` from the approval App token, so live
 * enumeration can stay impossible forever with the settings exactly right.
 * The attestation records what the operator saw in the repository settings UI
 * at a moment when the ruleset fingerprint below was current. Later runs
 * re-read the live fingerprint: equality means nobody touched the ruleset
 * since, so the asserted bypass list still holds. Any touch fails closed.
 *
 * There is deliberately no expiry field. Re-attestation is driven by change,
 * not by time: editing the ruleset is rare and intentional, and the live
 * fingerprint catches it on the next run. A calendar deadline would only buy
 * recurring maintenance while adding no detection the fingerprint does not
 * already provide.
 */
export type MainWriterAttestation = Readonly<{
  /** Schema version of this attestation record. */
  version: typeof MAIN_WRITER_ATTESTATION_VERSION;
  /** The GitHub ruleset id the operator attested. */
  rulesetId: number;
  /** The live ruleset fingerprint at attestation time. */
  rulesetFingerprint: string;
  /** The bypass actor ids the operator saw in the settings UI. */
  assertedBypassAppIds: readonly number[];
  /** ISO-8601 timestamp of the attestation ceremony. */
  attestedAt: string;
  /** Who performed the attestation. Free text for the audit trail. */
  attestedBy: string;
}>;

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
  | "merge_candidate_with_deferrals"
  | "request_changes"
  | "awaiting_verification"
  | "human_decision";

export type GateReason = Readonly<{ code: string; message: string }>;

export type TrustedWorkflowSource = Readonly<{
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

export type WorkflowEvidenceRecord = Readonly<{
  kind?: "workflow-evidence";
  checkId: string;
  result:
    | "passed"
    | "failed"
    | "skipped"
    | "cancelled"
    | "neutral"
    | "planned"
    | "out-of-scope";
  source: TrustedWorkflowSource;
  artifactSha256: string | null;
  coveredCheckIds: readonly string[];
}>;

/**
 * A required check that structurally cannot produce evidence before merge. It
 * carries the release-registry policy verbatim and no workflow identity: the
 * gate re-reads the policy from the registry, so PR text cannot widen the set.
 */
export type PreMergeDeferralRecord = Readonly<{
  kind: "deferred-before-merge";
  checkId: string;
  policy: PreMergeDeferralPolicy;
}>;

export type DeferredEvidence = Readonly<{
  checkId: string;
  reason: PreMergeImpossibleReason;
  followUp: PreMergeDeferralPolicy["followUp"];
}>;

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
    /**
     * GitHub's mergeability for this PR against the current base tip.
     */
    mergeable?: boolean | null;
    mergeableState?: string | null;
    baseRef: string;
    headRepositoryId: number | null;
    authorId: number;
    lastCommitAuthorId: number | null;
    linkedIssueNumbers: readonly number[];
    keepOpenIssueNumbers: readonly number[];
    issueClosureAmbiguous: boolean;
    /**
     * Issues GitHub itself would close when this PR merges (Development links,
     * closing keywords in the body, or closing keywords in commit messages).
     * `null` means the controller could not establish the set.
     */
    closingIssueNumbers: readonly number[] | null;
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
    // Derived by the controller from authenticated base changes, never a model
    // assertion. Omission cannot authorize reuse across main advancement.
    baseReviewSafe?: boolean;
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
  evidence: readonly (WorkflowEvidenceRecord | PreMergeDeferralRecord)[];
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
    /**
     * How integration against the current main is proven before a merge.
     * `up-to-date-base` is the historical rule: the PR base must equal main.
     * The mode comes from the trusted controller config, never from PR text.
     * An absent value keeps `up-to-date-base`, so a runtime that predates this
     * field can never relax a check by omission.
     */
    integrationMode?: IntegrationMode;
    /**
     * Whether the repository actually serves a merge queue for the default
     * branch. `null` and an absent value both mean it could not be read.
     * Merge-queue mode fails closed unless this is exactly `true`, so a
     * deployment that turns the mode on without enabling the queue never
     * reaches a merge.
     */
    mergeQueueAvailable?: boolean | null;
    /**
     * Who can update the default branch. `serialized-merge` issues the merge
     * itself against whatever main is at that moment, so it needs this guard to
     * prove that no other writer can advance main first. An absent or `null`
     * value means the guard was not verified, and `serialized-merge` fails
     * closed rather than assuming the default branch is App-only.
     */
    mainWriterGuard?: MainWriterGuard | null;
    /**
     * Root-owned operator attestation backing the guard when GitHub hides
     * the bypass set. Absent or `null` means no attestation was presented;
     * `serialized-merge` then needs live enumeration to pass.
     */
    mainWriterAttestation?: MainWriterAttestation | null;
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
  humanApprovalChannel?: "browser" | "legacy-root" | "unknown";
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
  deferredEvidence: readonly DeferredEvidence[];
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

function parsePreMergeDeferralPolicy(
  value: unknown,
  label: string,
): PreMergeDeferralPolicy {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const reason = value.reason;
  if (
    reason !== "requires-deployed-effective-configuration" &&
    reason !== "requires-paid-live-provider-calls"
  ) {
    throw new Error(`${label}.reason is invalid.`);
  }
  const followUp = value.followUp;
  if (!isRecord(followUp)) {
    throw new Error(`${label}.followUp must be an object.`);
  }
  const stage = RELEASE_STAGES.find((candidate) => candidate === followUp.stage);
  if (stage === undefined) {
    throw new Error(`${label}.followUp.stage is invalid.`);
  }
  return {
    reason,
    followUp: {
      stage,
      command: requiredString(followUp.command, `${label}.followUp.command`),
    },
  };
}

function parseEvidence(
  value: unknown,
  index: number,
): PrReviewGateInput["evidence"][number] {
  if (!isRecord(value)) throw new Error(`evidence[${index}] must be an object.`);
  if (value.kind === "deferred-before-merge") {
    return {
      kind: "deferred-before-merge",
      checkId: requiredString(value.checkId, `evidence[${index}].checkId`),
      policy: parsePreMergeDeferralPolicy(
        value.policy,
        `evidence[${index}].policy`,
      ),
    };
  }
  if (value.kind !== undefined && value.kind !== "workflow-evidence") {
    throw new Error(`evidence[${index}].kind is invalid.`);
  }
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
    result: result as WorkflowEvidenceRecord["result"],
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

/**
 * Issue numbers a GitHub closing keyword names in `text`. GitHub matches the
 * keyword anywhere, including inside "do not close #44", so this is
 * deliberately broad: a false positive only routes a deferred merge to a human.
 */
export function closingKeywordIssueNumbers(text: string): number[] {
  const numbers = new Set<number>();
  const pattern =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s*(?:#|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#|https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/)([1-9]\d{0,8})\b/gi;
  for (const match of text.matchAll(pattern)) numbers.add(Number(match[1]));
  return [...numbers].sort((left, right) => left - right);
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

  const mergeable = pullRequest.mergeable === null || pullRequest.mergeable === undefined
    ? null
    : requiredBoolean(pullRequest.mergeable, "pullRequest.mergeable");
  const mergeableState = pullRequest.mergeableState === null || pullRequest.mergeableState === undefined
    ? null
    : requiredString(pullRequest.mergeableState, "pullRequest.mergeableState");
  const integrationMode = optionalIntegrationMode(runtime.integrationMode);
  const mergeQueueAvailable =
    runtime.mergeQueueAvailable === undefined || runtime.mergeQueueAvailable === null
      ? undefined
      : requiredBoolean(runtime.mergeQueueAvailable, "runtime.mergeQueueAvailable");
  const mainWriterGuard = optionalMainWriterGuard(runtime.mainWriterGuard);
  const mainWriterAttestation = optionalMainWriterAttestation(
    runtime.mainWriterAttestation,
  );

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
      mergeable,
      mergeableState,
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
      closingIssueNumbers:
        pullRequest.closingIssueNumbers === undefined ||
        pullRequest.closingIssueNumbers === null
          ? null
          : parseNumberArray(
              pullRequest.closingIssueNumbers,
              "pullRequest.closingIssueNumbers",
            ),
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
      ...(review.baseReviewSafe === undefined ? {} : {
        baseReviewSafe: requiredBoolean(review.baseReviewSafe, "review.baseReviewSafe"),
      }),
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
      ...(integrationMode === undefined ? {} : { integrationMode }),
      ...(mergeQueueAvailable === undefined ? {} : { mergeQueueAvailable }),
      ...(mainWriterGuard === undefined ? {} : { mainWriterGuard }),
      ...(mainWriterAttestation === undefined ? {} : { mainWriterAttestation }),
    },
  };
}

function optionalMainWriterGuard(
  value: unknown,
): PrReviewGateInput["runtime"]["mainWriterGuard"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new Error("runtime.mainWriterGuard must be an object.");
  const bypassActorIds = parseNumberArrayOrEmpty(
    value.bypassActorIds,
    "runtime.mainWriterGuard.bypassActorIds",
  );
  const rulesetIds = parseNumberArrayOrEmpty(
    value.rulesetIds,
    "runtime.mainWriterGuard.rulesetIds",
  );
  return {
    readable: requiredBoolean(value.readable, "runtime.mainWriterGuard.readable"),
    restrictsDefaultBranchUpdates: requiredBoolean(
      value.restrictsDefaultBranchUpdates,
      "runtime.mainWriterGuard.restrictsDefaultBranchUpdates",
    ),
    bypassActorIds,
    // Required, so a snapshot that forgets to prove the bypass set fails the
    // parse instead of silently looking like an App-only main.
    bypassActorsEnumerated: requiredBoolean(
      value.bypassActorsEnumerated,
      "runtime.mainWriterGuard.bypassActorsEnumerated",
    ),
    appBypassMode: optionalStringOrNull(
      value.appBypassMode,
      "runtime.mainWriterGuard.appBypassMode",
    ),
    rulesetIds,
    ...(value.rulesetFingerprints === undefined
      ? {}
      : { rulesetFingerprints: parseRulesetFingerprints(value.rulesetFingerprints) }),
  };
}

function parseRulesetFingerprints(value: unknown): readonly RulesetFingerprint[] {
  if (!Array.isArray(value)) {
    throw new Error("runtime.mainWriterGuard.rulesetFingerprints must be an array.");
  }
  return value.map((entry, index) => {
    const label = `runtime.mainWriterGuard.rulesetFingerprints[${index}]`;
    if (!isRecord(entry)) throw new Error(`${label} must be an object.`);
    const fingerprint = entry.fingerprint;
    if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error(`${label}.fingerprint must be lowercase hex SHA-256.`);
    }
    return {
      id: requiredPositiveInteger(entry.id, `${label}.id`),
      fingerprint,
    };
  });
}

function optionalMainWriterAttestation(
  value: unknown,
): MainWriterAttestation | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error("runtime.mainWriterAttestation must be an object.");
  }
  if (value.version !== MAIN_WRITER_ATTESTATION_VERSION) {
    throw new Error(
      `runtime.mainWriterAttestation.version must be ${MAIN_WRITER_ATTESTATION_VERSION}.`,
    );
  }
  const asserted = value.assertedBypassAppIds;
  if (
    !Array.isArray(asserted) ||
    asserted.length === 0 ||
    asserted.some(
      (actorId) =>
        typeof actorId !== "number" ||
        !Number.isSafeInteger(actorId) ||
        actorId <= 0,
    )
  ) {
    throw new Error(
      "runtime.mainWriterAttestation.assertedBypassAppIds must be a non-empty array of positive integers.",
    );
  }
  const fingerprint = value.rulesetFingerprint;
  if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error(
      "runtime.mainWriterAttestation.rulesetFingerprint must be lowercase hex SHA-256.",
    );
  }
  return {
    version: MAIN_WRITER_ATTESTATION_VERSION,
    rulesetId: requiredPositiveInteger(value.rulesetId, "runtime.mainWriterAttestation.rulesetId"),
    rulesetFingerprint: fingerprint,
    assertedBypassAppIds: [...asserted as readonly number[]].sort((left, right) => left - right),
    attestedAt: requiredString(value.attestedAt, "runtime.mainWriterAttestation.attestedAt"),
    attestedBy: requiredString(value.attestedBy, "runtime.mainWriterAttestation.attestedBy"),
  };
}

function optionalStringOrNull(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function optionalIntegrationMode(
  value: unknown,
): PrReviewGateInput["runtime"]["integrationMode"] {
  if (value === undefined || value === null) return undefined;
  return parseIntegrationMode(value);
}

/**
 * The one place an integration mode is accepted. The mode comes from the
 * root-owned controller config, never from PR text or a comment, and an absent
 * value keeps the historical `up-to-date-base` rule so nothing relaxes by
 * omission.
 */
export function parseIntegrationMode(value: unknown): IntegrationMode {
  if (value === undefined || value === null || value === "up-to-date-base") {
    return "up-to-date-base";
  }
  if (value === "merge-queue") return "merge-queue";
  if (value === "serialized-merge") return "serialized-merge";
  throw new Error(
    `integrationMode must be "up-to-date-base", "merge-queue", or "serialized-merge".`,
  );
}

/**
 * The trusted integration mode for this snapshot. An absent value keeps the
 * historical `up-to-date-base` rule, so nothing relaxes by omission.
 */
export function integrationModeOf(
  input: Pick<PrReviewGateInput, "runtime">,
): IntegrationMode {
  return input.runtime.integrationMode ?? "up-to-date-base";
}

function headBoundApproval(input: Pick<PrReviewGateInput, "runtime">): boolean {
  return integrationModeOf(input) !== "up-to-date-base";
}

/**
 * Why the default-branch writer guard does not hold, or `null` when it does.
 *
 * The guard only passes when the repository restricts updates to the default
 * branch and the single actor allowed to bypass that restriction is this
 * repository's approval App. Every other outcome -- unreadable rulesets, no
 * update restriction at all, an extra human or team, or a different App -- is a
 * reason to stop, because each of them leaves a writer that could move main
 * between the snapshot and the merge.
 *
 * The bypass set has to be enumerated, not merely empty. GitHub hides
 * `bypass_actors` from callers without administration access, and an empty
 * unreadable set would otherwise be indistinguishable from a ruleset that
 * genuinely grants nobody a bypass.
 *
 * GitHub also withholds `bypass_actors` from the approval App token itself,
 * so live enumeration can stay impossible with the settings exactly right.
 * For that case the guard accepts a root-owned operator attestation instead:
 * the operator records the bypass list seen in the repository settings UI
 * together with the live ruleset fingerprint, and later runs re-read the
 * live fingerprint. Equality means nobody touched the ruleset since, so the
 * asserted list still holds; any touch fails closed. Attestation never
 * overrides a readable live set: when GitHub does enumerate, the live list
 * alone decides.
 */
function mainWriterGuardReason(
  input: Pick<PrReviewGateInput, "runtime">,
  policy: TrustedPrReviewPolicy,
): string | null {
  const guard = input.runtime.mainWriterGuard ?? null;
  if (guard === null || !guard.readable) return "main_writer_guard_unreadable";
  if (!guard.restrictsDefaultBranchUpdates) return "main_writer_guard_missing";
  const approvalAppId = policy.reviewAppId;
  if (approvalAppId === null) return "main_writer_guard_missing";
  if (guard.bypassActorsEnumerated) {
    const bypass = guard.bypassActorIds;
    if (bypass.length !== 1 || bypass[0] !== approvalAppId) {
      return "main_writer_guard_bypass_actors";
    }
    return null;
  }
  return attestedGuardReason(input, approvalAppId);
}

/**
 * Why an attested guard does not hold, or `null` when it does.
 *
 * The live restriction, target, and update rule are re-verified above, so
 * only the hidden bypass membership rides on the attestation. Three checks
 * bind it: the attestation must name exactly the live covering set, every
 * live fingerprint must equal the attested one, and the asserted bypass must
 * be exactly the approval App. A ruleset touch of any kind, including a
 * bypass list edit, changes the live fingerprint and fails closed here.
 * Attestation covers exactly one ruleset by schema design; a second covering
 * ruleset fails closed until the operator merges the overlap away.
 */
function attestedGuardReason(
  input: Pick<PrReviewGateInput, "runtime">,
  approvalAppId: number,
): string | null {
  const guard = input.runtime.mainWriterGuard;
  const attestation = input.runtime.mainWriterAttestation ?? null;
  if (attestation === null || attestation === undefined) {
    return "main_writer_guard_bypass_actors_unreadable";
  }
  const live = new Map(
    (guard?.rulesetFingerprints ?? []).map((entry) => [entry.id, entry.fingerprint]),
  );
  if (
    guard === null ||
    guard === undefined ||
    live.size !== 1 ||
    !live.has(attestation.rulesetId)
  ) {
    return "main_writer_attestation_ruleset_changed";
  }
  if (live.get(attestation.rulesetId) !== attestation.rulesetFingerprint) {
    return "main_writer_attestation_fingerprint_mismatch";
  }
  const asserted = attestation.assertedBypassAppIds;
  if (asserted.length !== 1 || asserted[0] !== approvalAppId) {
    return "main_writer_attestation_assertion_mismatch";
  }
  return null;
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
    deferredEvidence: [],
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

// One definition of the protected review surface. Both the gate's own decision
// and the browser challenge frozen by the controller call this function, so the
// paths Luke approves and the paths the gate demands cannot drift apart.
export function protectedReviewPaths(
  changedFiles: PrReviewGateInput["pullRequest"]["changedFiles"],
  approvedPaths: readonly string[] = [],
): readonly string[] {
  const approved = new Set(approvedPaths);
  return changedFiles.flatMap(({ path }) => {
    const normalized = path.replaceAll("\\", "/");
    if (approved.has(normalized)) return [];
    return HUMAN_REVIEW_PATHS.some((prefix) =>
      normalized === prefix || normalized.startsWith(prefix) || normalized.startsWith(prefix.replace(/\/$/, "")),
    ) ? [normalized] : [];
  });
}

function requiresHumanReview(input: PrReviewGateInput, policy: TrustedPrReviewPolicy): Readonly<{ code: string; message: string }> | null {
  if (input.pullRequest.externalReviewState === "needs-human") {
    return { code: "human_review_required", message: "A human review or review thread needs attention." };
  }
  if (
    /\b(?:do not merge|do not auto[- ]merge|not for merge|not to be merged)\b|不要(?:自动)?合入|暂停自动审批/i.test(
      [input.pullRequest.title, input.pullRequest.body, ...input.issues.map((issue) => issue.body)].join("\n"),
    )
  ) {
    return { code: "human_review_required", message: "The PR or Issue explicitly pauses automatic merging." };
  }
  const unreviewedProtectedPaths = new Set(
    protectedReviewPaths(input.pullRequest.changedFiles, policy.humanApprovedPaths ?? []),
  );
  // The protected-path reason is reported last, never first. It is the only human
  // reason the browser channel treats as "wait for Luke", so letting it mask a
  // pause, a triage label, or a dependency would turn a real blocker into a wait
  // and hide that blocker from the check run.
  let protectedReason: Readonly<{ code: string; message: string }> | null = null;
  for (const { path, status } of input.pullRequest.changedFiles) {
    const normalized = path.replaceAll("\\", "/");
    if (protectedReason === null && unreviewedProtectedPaths.has(normalized)) {
      protectedReason = {
        code: policy.humanApprovalChannel === "browser" ? "browser_human_approval_required" : "human_review_required",
        message: `The change touches protected review or product policy path ${normalized}.`,
      };
    }
    if (status === "removed" && isTestPath(normalized)) {
      return { code: "human_review_required", message: `The change removes test file ${normalized}.` };
    }
  }
  if (REQUIRED_REVIEW_FLAGS.some((flag) => input.review.riskFlags[flag])) {
    return { code: "human_review_required", message: "The review identified a product, authorization, privacy, migration, or feature-enable decision." };
  }
  if (
    input.review.capability.newCapabilityEnabled ||
    input.review.capability.majorContractChange ||
    input.review.capability.externalMvpRelease
  ) {
    return { code: "human_review_required", message: "This change triggers full capability acceptance or a product release decision." };
  }
  const numbers = input.issues.map((issue) => issue.number);
  const linked = input.pullRequest.linkedIssueNumbers;
  if (numbers.length === 0 || new Set(numbers).size !== numbers.length ||
    new Set(linked).size !== linked.length || numbers.length !== linked.length ||
    linked.some((number) => !numbers.includes(number))) {
    return { code: "human_review_required", message: "The PR must supply every referenced Issue exactly once." };
  }
  if (input.pullRequest.state !== "open") return { code: "human_review_required", message: "The PR is closed." };
  const exclusions = parseIssueClosureExclusions(input.pullRequest.title, input.pullRequest.body);
  if (input.pullRequest.issueClosureAmbiguous || exclusions.ambiguous ||
    exclusions.keepOpenIssueNumbers.join() !== [...input.pullRequest.keepOpenIssueNumbers].sort((a, b) => a - b).join() ||
    input.pullRequest.keepOpenIssueNumbers.some((number) => !numbers.includes(number))) {
    return { code: "human_review_required", message: "The PR's keep-open Issue declarations are ambiguous or inconsistent." };
  }
  const deliveryIssues = input.issues.filter((issue) => !input.pullRequest.keepOpenIssueNumbers.includes(issue.number));
  if (!deliveryIssues.some((issue) => issue.state === "open")) {
    return { code: "human_review_required", message: "All referenced Issues are already closed." };
  }
  for (const issue of input.issues) {
    if (issue.body.trim().length === 0) return { code: "human_review_required", message: `Issue #${issue.number} has no review requirement.` };
    if (input.pullRequest.keepOpenIssueNumbers.includes(issue.number)) continue;
    if (issue.pause.active || issue.pause.source === "unknown") {
      return { code: "human_review_required", message: `Issue #${issue.number} is paused or its pause state cannot be trusted.` };
    }
    if (issue.state === "closed") continue;
    if (issue.blockedBy === null || issue.blockedBy.some((number) => !deliveryIssues.some((target) => target.number === number))) {
      return { code: "human_review_required", message: `Issue #${issue.number} still has blocking dependencies outside this PR.` };
    }
    if (issue.labels.some((label) =>
      ["ready-for-human", "needs-info", "needs-triage", "wontfix"].includes(label.toLowerCase()))) {
      return { code: "human_review_required", message: `Issue #${issue.number} has a triage label that requires a human decision.` };
    }
  }
  return protectedReason;
}

function deferralPolicyEquals(
  candidate: PreMergeDeferralPolicy,
  registry: PreMergeDeferralPolicy,
): boolean {
  return (
    candidate.reason === registry.reason &&
    candidate.followUp.stage === registry.followUp.stage &&
    candidate.followUp.command === registry.followUp.command
  );
}

function verifyEvidence(
  input: PrReviewGateInput,
  policy: TrustedPrReviewPolicy,
  requiredIds: readonly string[],
): {
  accepted: string[];
  deferred: DeferredEvidence[];
  blocker: string | null;
} {
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
      deferred: [],
      blocker: `Evidence contains duplicate check records: ${[...duplicateIds].join(", ")}.`,
    };
  }

  const accepted: string[] = [];
  const deferred: DeferredEvidence[] = [];
  for (const checkId of requiredIds) {
    const evidence = entriesById.get(checkId);
    if (!evidence) {
      return { accepted, deferred, blocker: `Required evidence ${checkId} is missing.` };
    }
    if (evidence.kind === "deferred-before-merge") {
      const registryPolicy = preMergeDeferralFor(checkId);
      if (registryPolicy === null) {
        return {
          accepted,
          deferred,
          blocker: `Required evidence ${checkId} is not a deferrable check and cannot be deferred before merge.`,
        };
      }
      if (!deferralPolicyEquals(evidence.policy, registryPolicy)) {
        return {
          accepted,
          deferred,
          blocker: `Required evidence ${checkId} has a deferral whose policy does not match the release registry.`,
        };
      }
      deferred.push({
        checkId,
        reason: registryPolicy.reason,
        followUp: registryPolicy.followUp,
      });
      continue;
    }
    if (evidence.result !== "passed") {
      return {
        accepted,
        deferred,
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
      source.baseSha !== (integrationModeOf(input) === "serialized-merge"
        ? input.repository.defaultBranchSha : input.pullRequest.baseSha) ||
      source.mergeSha !== input.pullRequest.mergeSha
    ) {
      return {
        accepted,
        deferred,
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
        deferred,
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
        deferred,
        blocker: `Targeted evidence ${checkId} is missing its verified test artifact entry.`,
      };
    }
    accepted.push(checkId);
  }
  return { accepted, deferred, blocker: null };
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
    (integrationModeOf(input) !== "serialized-merge" &&
      input.review.baseSha !== input.pullRequest.baseSha)
  ) {
    return outcome(input, "awaiting_verification", {
      code: "stale_review",
      message: "The review report does not match the current repository, PR, head, and base.",
    });
  }
  if (integrationModeOf(input) === "serialized-merge" &&
      input.review.baseSha !== input.repository.defaultBranchSha &&
      input.review.baseReviewSafe !== true) {
    return outcome(input, "awaiting_verification", {
      code: "stale_base_review_risk",
      message: "Main changed after this review and its effect on the reviewed code has not been cleared.",
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
      code: humanReason.code,
      message: humanReason.message,
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
  if (headBoundApproval(input)) {
    // The exact clean/behind state is enforced by mergeActionFor because
    // this check run is itself a required check: it stays `failure` until the
    // merge candidate is reached, which keeps GitHub reporting `blocked` for
    // a healthy PR even after the App review lands.
    if (input.pullRequest.mergeable === false) {
      return outcome(input, "awaiting_verification", {
        code: "pull_request_conflict",
        message: "The PR conflicts with the current main and requires a fix.",
      });
    }
    if (input.pullRequest.mergeable !== true) {
      return outcome(input, "awaiting_verification", {
        code: "mergeability_unknown",
        message:
          "GitHub has not reported whether the PR can merge into the current main.",
      });
    }
    if (input.pullRequest.mergeSha === null) {
      return outcome(input, "awaiting_verification", {
        code: "base_or_merge_ref_changed",
        message: "The PR merge ref for the current main is not available.",
      });
    }
  } else if (
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
  // Merge-queue integration replaces the up-to-date-base rule with a queue that
  // builds and tests the merged result, so the queue itself has to exist. A
  // deployment that turns the mode on before the repository serves a queue for
  // main stops here instead of merging against a base nobody validated.
  if (
    integrationModeOf(input) === "merge-queue" &&
    input.runtime.mergeQueueAvailable !== true
  ) {
    return outcome(input, "human_decision", {
      code: "merge_queue_unavailable",
      message:
        "Merge-queue integration is configured, but main does not enforce a merge queue.",
    });
  }
  if (integrationModeOf(input) === "merge-queue") {
    return outcome(input, "human_decision", {
      code: "merge_queue_not_supported",
      message: "Native queue integration lacks a trusted gate producer for merge-group commits and cannot be activated.",
    });
  }
  // Serialized-merge lets the controller merge a PR whose head is behind main,
  // so GitHub must stop requiring an up-to-date branch. Leaving it on would
  // stall every stale-base merge with no visible reason.
  if (
    integrationModeOf(input) === "serialized-merge" &&
    protection.requiresUpToDate
  ) {
    return outcome(input, "human_decision", {
      code: "requires_up_to_date_still_enabled",
      message:
        "Serialized-merge integration is configured, but main still requires branches to be up to date before merging.",
    });
  }
  // Whenever a ruleset restricts who can update main, the guard must prove
  // the restriction is App-only, in every integration mode. Protection
  // readability only means the rules parsed; a hidden bypass actor could
  // otherwise advance main outside this controller while every rule below
  // still looks green. Serialized-merge always needs the proof because it
  // merges behind-main heads against a moving target; other modes need it
  // only once such a ruleset exists. Repositories without one keep the exact
  // historical behavior.
  if (
    integrationModeOf(input) === "serialized-merge" ||
    input.runtime.mainWriterGuard?.restrictsDefaultBranchUpdates === true
  ) {
    const guard = mainWriterGuardReason(input, policy);
    if (guard !== null) {
      return outcome(input, "human_decision", {
        code: guard,
        message:
          "Main can only be updated through a restriction that is not exclusively held by the approval App, or that could not be verified.",
      });
    }
  }
  if (
    !protection.protected ||
    protection.branch !== policy.defaultBranch ||
    (integrationModeOf(input) === "up-to-date-base" && !protection.requiresUpToDate) ||
    !protection.dismissesStaleReviews ||
    !protection.enforcesAdmins ||
    protection.requiredApprovingReviews !== 1 ||
    // The approval App has to be able to merge, so it may legitimately appear as
    // a ruleset bypass actor. Any *other* bypass actor is a human or a second
    // App that could move main outside this controller.
    (integrationModeOf(input) !== "serialized-merge" &&
      protection.bypassActorIds.some(
        (actorId) => actorId !== policy.reviewAppId,
      )) ||
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

  const deferred = verification.deferred;
  if (deferred.length > 0) {
    if (integrationModeOf(input) === "serialized-merge") {
      return outcome(input, "human_decision", {
        code: "serialized_deferred_merge_not_supported",
        message: "Serialized integration requires all pre-merge checks to pass before an immediate guarded merge.",
      }, uniqueRequiredIds, verification.accepted);
    }
    if (policy.humanApprovalChannel === "browser") {
      return outcome(
        input,
        "human_decision",
        {
          code: "browser_deferred_merge_requires_human",
          message:
            "Browser approval permits only an immediate merge of the reviewed head. Deferred pre-merge checks require a maintainer decision.",
        },
        uniqueRequiredIds,
        verification.accepted,
      );
    }
    const closing = new Set([
      ...closingKeywordIssueNumbers(
        `${input.pullRequest.title}\n${input.pullRequest.body}`,
      ),
      ...(input.pullRequest.closingIssueNumbers ?? []),
    ]);
    if (input.pullRequest.closingIssueNumbers === null || closing.size > 0) {
      return outcome(
        input,
        "human_decision",
        {
          code: "deferred_merge_would_close_issues",
          message:
            input.pullRequest.closingIssueNumbers === null
              ? "Pre-merge checks are deferred, and the Issues GitHub would close on merge could not be read."
              : `Pre-merge checks are deferred, but GitHub would close ${[...closing]
                  .sort((left, right) => left - right)
                  .map((number) => `#${number}`)
                  .join(", ")} on merge. Remove the closing keywords and Development links so the Issues stay open.`,
        },
        uniqueRequiredIds,
        verification.accepted,
      );
    }
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
    outcome:
      deferred.length > 0 ? "merge_candidate_with_deferrals" : "merge_candidate",
    reasons: [
      deferred.length > 0
        ? {
            code: "pre_merge_checks_deferred",
            message: deferred
              .map(
                (entry) =>
                  `${entry.checkId} was not run before merge; runs at ${entry.followUp.stage}: ${entry.followUp.command}`,
              )
              .join("; "),
          }
        : {
            code: "all_required_evidence_verified",
            message: "The snapshot satisfies the configured read-only merge candidate policy.",
          },
    ],
    requiredEvidenceIds: uniqueRequiredIds,
    acceptedEvidenceIds: verification.accepted,
    deferredEvidence: deferred,
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
