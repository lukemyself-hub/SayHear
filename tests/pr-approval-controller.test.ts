import { createHash, generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  appReviewOutcomeForIdentity,
  combineRemediationHistory,
  completionBlockingScope,
  definitiveMergeRejection,
  guardImmediateMerge,
  readHumanBinding,
  readSavedReviewReport,
  reportReviewResult,
  refreshStaleIntegration,
  scanPullRequests,
  readSnapshot,
  recoverControllerCompletion,
  applyMergeAction,
  collectEvidence,
  readClosingIssueReferences,
  requestDeferredMerge,
  AGENT_IDENTITY,
  LUKE_IDENTITY,
  anotherApprovalInFlightFor,
  completeIssueAfterApproval,
  completeLinkedIssuesAfterMerge,
  forEachLinkedIssue,
  handoffStalePullRequestBase,
  reconcileIssueCompletion,
  resolveLinkedIssues,
  createGitHubAppJwt,
  GitHubApiError,
  GitHubRestClient,
  fingerprintRuleset,
  MAX_REMEDIATION_ROUNDS,
  nextRequestChangeRound,
  parseHumanReviewAuthorizations,
  matchHumanReviewAuthorization,
  isTrustedWorkflowVersion,
  isVercelDeploymentStatus,
  digestDiscussion,
  isReviewStillPending,
  parseModelReviewReport,
  parsePauseState,
  parseRequestChangeHistory,
  publishIssueHandoff,
  readBranchProtection,
  readCurrentPullRequestMergeSha,
  readIssueDependencies,
  readMainWriterGuard,
  readMergeQueueAvailability,
  readRepositoryMergeSettings,
  remediationFromHistory,
  parseIntegrationMode,
  requestProtectedMerge,
  type GitHubApi,
  type GitHubComment,
  type ModelReviewReport,
} from "../scripts/pr-approval-controller.ts";
import {
  MAIN_WRITER_ATTESTATION_VERSION,
  PR_VALIDATE_WORKFLOW_PATH,
  PR_REVIEW_GATE_POLICY_VERSION,
  PR_REVIEW_GATE_V11_POLICY_VERSION,
  PR_REVIEW_REPORT_VERSION,
  SAYHEAR_REPOSITORY_ID,
  requirementDigest,
  type MainWriterAttestation,
  type PrReviewGateInput,
} from "../scripts/pr-review-gate.ts";
import type { IntegrationRefreshRecord } from "../scripts/pr-approval/integration-refresh.ts";
import type { MergeRefRebuildRecord } from "../scripts/pr-approval/merge-ref-rebuild.ts";
import type { CompletionRecord } from "../scripts/pr-approval/completion.ts";
import { parseCompletionRecord } from "../scripts/pr-approval/completion.ts";
import type { BrowserApprovalStore, BrowserState } from "../scripts/pr-approval/browser-approval.ts";
import { preMergeDeferralFor } from "../scripts/daily-release-validation.ts";

const ACTIONS_APP_ID = 15368;
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_SHA = "e".repeat(40);
const REQUIREMENT_DIGEST = "c".repeat(64);
const CHANGE_DIGEST = "d".repeat(64);
const REVIEW_BOT_ACTOR_ID = 999;
type StubRequestOptions = Readonly<{
  method?: string;
  body?: unknown;
  accept?: string;
}>;

function requestBody<T>(options: StubRequestOptions | undefined): T {
  if (options?.body === undefined) {
    throw new Error("Expected a request body in this test.");
  }
  return options.body as T;
}

function makeIssueComment(
  body: string,
  authorId = REVIEW_BOT_ACTOR_ID,
): GitHubComment {
  return {
    id: 1,
    body,
    created_at: "2026-10-12T00:00:00Z",
    updated_at: "2026-10-12T00:00:00Z",
    user: {
      id: authorId,
      login: authorId === REVIEW_BOT_ACTOR_ID
        ? "sayhear-pr-review-gate[bot]"
        : "test-user",
    },
  };
}

const modelReport = {
  version: PR_REVIEW_REPORT_VERSION,
  policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
  repositoryId: SAYHEAR_REPOSITORY_ID,
  pullRequestNumber: 321,
  headSha: HEAD_SHA,
  baseSha: BASE_SHA,
  requirementDigest: REQUIREMENT_DIGEST,
  decision: "approve",
  diffComplete: true,
  declaredImpacts: ["server-business"],
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
} satisfies ModelReviewReport;

class StubApi implements GitHubApi {
  constructor(
    private readonly respond: (
      path: string,
      options?: StubRequestOptions,
    ) => unknown = () => ({}),
    private readonly pageValues: (path: string) => unknown[] | Promise<unknown[]> = () => [],
    private readonly archiveBytes: () => Uint8Array = () => new Uint8Array(),
  ) {}

  async request<T>(
    path: string,
    options?: StubRequestOptions,
  ): Promise<T> {
    return (await this.respond(path, options)) as T;
  }

  async pages<T>(path: string): Promise<T[]> {
    return (await this.pageValues(path)) as T[];
  }

  async bytes(_path: string): Promise<Uint8Array> {
    return this.archiveBytes();
  }
}

function storedZipArchive(
  entries: readonly Readonly<{ name: string; content: Uint8Array }>[],
): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const size = entry.content.byteLength;
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    localParts.push(local, Buffer.from(entry.content));

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    nameBytes.copy(central, 46);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central);
    localOffset += local.length + size;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return new Uint8Array(Buffer.concat([...localParts, central, end]));
}


describe("migration evidence collection", () => {
  const migrationCheckId = "migration:upgrade-compatibility";
  const migrationTestPath = "tests/ci/migration-upgrade-compatibility.test.ts";
  const runId = 555;
  const workflowBlobSha = "f".repeat(40);
  const capability = {
    newCapabilityEnabled: false,
    majorContractChange: false,
    externalMvpRelease: false,
  };
  const changedFiles = [{
    path: "packages/data/migrations/0099_add_column.sql",
    status: "added",
  }] satisfies PrReviewGateInput["pullRequest"]["changedFiles"];
  const pullRequest = {
    number: 321,
    state: "open",
    draft: false,
    title: "Deliver #42",
    body: "Fixes #42",
    updated_at: "2026-10-14T00:00:00Z",
    head: { sha: HEAD_SHA, repo: { id: SAYHEAR_REPOSITORY_ID } },
    base: { ref: "main", sha: BASE_SHA },
    user: { id: 101 },
    merge_commit_sha: MERGE_SHA,
    changed_files: 1,
  } satisfies Parameters<typeof collectEvidence>[2];


  function collector(options: {
    migrationResult?: Readonly<{
      name: string;
      status: string;
      assertionResults?: readonly Readonly<{ status: string }>[];
    }> | null;
    missingRun?: boolean;
    missingArtifact?: boolean;
    expiredArtifact?: boolean;
    emptyReport?: boolean;
    badDigest?: boolean;
    runBaseSha?: string;
    mergeWorkflowBlobSha?: string;
    integrationMode?: "serialized-merge";
    checkout?: Readonly<Record<string, unknown>>;
    workflowStatus?: string;
    checkStatus?: string;
  } = {}) {
    const migrationResult = options.migrationResult === undefined
      ? {
          name: `/workspace/SayHear/${migrationTestPath}`,
          status: "passed",
          assertionResults: [{ status: "passed" }],
        }
      : options.migrationResult;
    const reportBytes = Buffer.from(JSON.stringify({
      success: true,
      testResults: options.emptyReport ? [] : [
        ...[
          "tests/system/g1-purge-restore-drill.system.test.ts",
          "tests/system/owner-full-purge.system.test.ts",
        ].map((path) => ({
          name: `/workspace/SayHear/${path}`,
          status: "passed",
          assertionResults: [{ status: "passed" }],
        })),
        ...(migrationResult ? [migrationResult] : []),
      ],
    }));
    // The collector binds the run to the checkout it actually validated, so
    // every artifact carries both the report and the validated ref identity.
    const checkoutBytes = Buffer.from(JSON.stringify({
      event: "pull_request",
      pullRequestNumber: 321,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      checkoutSha: MERGE_SHA,
      parentShas: [BASE_SHA, HEAD_SHA], runId, runAttempt: 1,
      ...options.checkout,
    }), "utf8");
    const archive = storedZipArchive([
      { name: "vitest-report.json", content: new Uint8Array(reportBytes) },
      { name: "pr-validate-source.json", content: new Uint8Array(checkoutBytes) },
    ]);
    const validateCheck = {
      id: 9001,
      name: "validate",
      app: { id: ACTIONS_APP_ID },
      head_sha: HEAD_SHA,
      details_url: `https://github.com/lukemyself-hub/SayHear/actions/runs/${runId}`,
      status: options.checkStatus ?? "completed",
      conclusion: "success",
    };
    const api = new StubApi((path) => {
      if (path.includes("/check-runs")) {
        return { check_runs: options.missingRun ? [] : [validateCheck] };
      }
      if (path.endsWith(`/actions/runs/${runId}`)) {
        return {
          id: runId,
          event: "pull_request",
          head_sha: HEAD_SHA,
          path: PR_VALIDATE_WORKFLOW_PATH,
          pull_requests: [{
            number: 321,
            head: { sha: HEAD_SHA },
            base: { sha: options.runBaseSha ?? BASE_SHA },
          }],
          status: options.workflowStatus ?? "completed",
          conclusion: "success",
          run_attempt: 1,
        };
      }
      if (path.includes("/git/commits/")) {
        return { sha: options.checkout?.checkoutSha ?? MERGE_SHA,
          parents: [{ sha: BASE_SHA }, { sha: HEAD_SHA }] };
      }
      if (path.includes("/contents/")) {
        return {
          sha: path.endsWith(`ref=${MERGE_SHA}`)
            ? options.mergeWorkflowBlobSha ?? workflowBlobSha
            : workflowBlobSha,
        };
      }
      if (path.includes("/artifacts")) {
        return {
          artifacts: options.missingArtifact ? [] : [{
            id: 77,
            name: "vitest-report-321",
            expired: options.expiredArtifact ?? false,
            digest: `sha256:${options.badDigest
              ? "0".repeat(64)
              : createHash("sha256").update(archive).digest("hex")}`,
          }],
        };
      }
      throw new Error(`Unexpected collector request ${path}`);
    }, () => [], () => archive);
    const config = {
      api,
      app: {
        appId: 98765,
        installationId: 1,
        slug: "sayhear-pr-review-gate",
        productionMergeAuthorized: false,
        ordinaryMergeTriggersProduction: false,
        ...(options.integrationMode ? { integrationMode: options.integrationMode } : {}),
      },
      policy: {
        repositoryId: SAYHEAR_REPOSITORY_ID,
        repositoryName: "lukemyself-hub/SayHear",
        defaultBranch: "main",
        policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
        reviewAppId: 98765,
        actionsAppId: ACTIONS_APP_ID,
        validateWorkflowBlobSha: workflowBlobSha,
      },
      botActorId: REVIEW_BOT_ACTOR_ID,
      ownerActorId: 101,
    } satisfies Parameters<typeof collectEvidence>[0];
    return {
      reportDigest: createHash("sha256").update(reportBytes).digest("hex"),
      collect: () => collectEvidence(
        config, 321, pullRequest, changedFiles, [], capability, MERGE_SHA, options.integrationMode ? "9".repeat(40) : BASE_SHA,
      ),
    };
  }

  it("uses authenticated current-main parents rather than stale event base metadata in serialized mode", async () => {
    const currentMain = "9".repeat(40);
    const result = await collector({ integrationMode: "serialized-merge", runBaseSha: BASE_SHA,
      checkout: { parentShas: [currentMain, HEAD_SHA] } }).collect();
    expect(result.staleIntegrationRunId).toBeNull();
    expect(result.evidence.find((entry) => entry.checkId === "baseline:test")).toMatchObject({ result: "passed", source: { baseSha: currentMain, mergeSha: MERGE_SHA } });
  });

  it.each([
    { runId: 999 }, { runAttempt: 2 }, { parentShas: [BASE_SHA, "8".repeat(40)] }, { parentShas: null },
  ])("rejects mismatched integration checkout provenance %#", async (checkout) => {
    const result = await collector({ integrationMode: "serialized-merge", checkout }).collect();
    expect(result.staleIntegrationRunId).toBeNull();
    expect(result.evidence.find((entry) => entry.checkId === "baseline:test")).toMatchObject({ result: "failed" });
  });

  it("identifies only a terminal stale run whose checkout commit and workflow can be verified", async () => {
    const result = await collector({ integrationMode: "serialized-merge", checkout: { checkoutSha: "7".repeat(40) } }).collect();
    expect(result.staleIntegrationRunId).toBe(runId);
    expect(result.evidence.find((entry) => entry.checkId === "baseline:test")).toMatchObject({ result: "failed" });
  });

  it.each([
    { workflowStatus: "queued" }, { workflowStatus: "in_progress" }, { workflowStatus: "unknown" },
    { missingArtifact: true }, { badDigest: true }, { missingRun: true },
  ])("never requests refresh from transient or incomplete evidence %#", async (options) => {
    const result = await collector({ integrationMode: "serialized-merge", checkout: { checkoutSha: "7".repeat(40) }, ...options }).collect();
    expect(result.staleIntegrationRunId).toBeNull();
  });

  it("collects digest-bound migration evidence from passed assertions in a trusted report", async () => {
    const fixture = collector();
    const collected = await fixture.collect();

    expect(collected.evidence.find((entry) => entry.checkId === migrationCheckId))
      .toEqual({
        checkId: migrationCheckId,
        result: "passed",
        source: expect.objectContaining({
          runId, runAttempt: 1, headSha: HEAD_SHA, baseSha: BASE_SHA, mergeSha: MERGE_SHA,
          workflowBlobSha,
        }),
        artifactSha256: fixture.reportDigest,
        coveredCheckIds: [migrationCheckId],
      });
    expect(collected.evidence.every(
      (entry) => entry.kind !== "deferred-before-merge" && entry.result === "passed",
    )).toBe(true);
  });

  it.each([
    ["missing test", null],
    ["wrong test path", { name: "tests/other.test.ts", status: "passed", assertionResults: [{ status: "passed" }] }],
    ["failed suite", { name: migrationTestPath, status: "failed", assertionResults: [{ status: "failed" }] }],
    ["skipped assertion", { name: migrationTestPath, status: "passed", assertionResults: [{ status: "pending" }] }],
    ["empty assertions", { name: migrationTestPath, status: "passed", assertionResults: [] }],
    ["omitted assertions", { name: migrationTestPath, status: "passed" }],
  ] satisfies readonly (readonly [string, NonNullable<Parameters<typeof collector>[0]>["migrationResult"]])[])(
    "keeps %s migration evidence blocked",
    async (_case, migrationResult) => {
      const collected = await collector({ migrationResult }).collect();

      expect(collected.evidence.find((entry) => entry.checkId === migrationCheckId))
        .toMatchObject({ result: "failed", artifactSha256: null, coveredCheckIds: [] });
    },
  );

  it.each([
    { missingArtifact: true },
    { expiredArtifact: true },
    { badDigest: true },
    { runBaseSha: "9".repeat(40) },
    { mergeWorkflowBlobSha: "9".repeat(40) },
  ])("rejects unavailable or untrusted migration evidence %j", async (options) => {
    const collected = await collector(options).collect();

    expect(collected.evidence.find((entry) => entry.checkId === migrationCheckId))
      .toMatchObject({ result: "failed" });
  });

  it("keeps the migration requirement present when no current workflow run exists", async () => {
    const collected = await collector({ missingRun: true }).collect();

    expect(collected.evidence.find((entry) => entry.checkId === migrationCheckId))
      .toMatchObject({ result: "skipped", artifactSha256: null, coveredCheckIds: [] });
  });

  it("rejects an empty test report for both baseline and migration evidence", async () => {
    const collected = await collector({ emptyReport: true }).collect();

    expect(collected.evidence.find((entry) => entry.checkId === "baseline:test"))
      .toMatchObject({ result: "failed" });
    expect(collected.evidence.find((entry) => entry.checkId === migrationCheckId))
      .toMatchObject({ result: "failed", artifactSha256: null, coveredCheckIds: [] });
  });
});

describe("PR approval controller", () => {
  it.each(["queued", "in_progress", "missing", "unknown"] as const)(
    "keeps the Issue occupied while Validate is %s",
    (workflowStatus) => {
      expect(isReviewStillPending({ workflowStatus }, {
        outcome: "awaiting_verification",
        reasons: [{ code: "required_evidence_missing", message: "Missing CI" }],
      })).toBe(true);
    },
  );

  it("waits while another PR approval or merge is in flight", () => {
    expect(isReviewStillPending({ workflowStatus: "in_progress" }, {
      outcome: "awaiting_verification",
      reasons: [{ code: "repository_merge_busy", message: "Another PR is merging" }],
    })).toBe(true);
  });

  it.each([
    "policy_version_mismatch",
    "stale_review",
    "github_context_unavailable",
    "incomplete_diff",
    "mergeability_unknown",
  ])("keeps the Issue occupied while review context is unavailable: %s", (code) => {
    expect(isReviewStillPending({ workflowStatus: "completed" }, {
      outcome: "awaiting_verification",
      reasons: [{ code, message: "The review cannot finish without fresh context" }],
    })).toBe(true);
  });

  it.each([
    "pr_not_ready",
    "trusted_identity_unconfigured",
    "review_author_unavailable",
    "branch_protection_unreadable",
    "production_deploy_behavior_unknown",
  ])("hands terminal verification blockers back instead of keeping ongoing: %s", (code) => {
    expect(isReviewStillPending({ workflowStatus: "completed" }, {
      outcome: "awaiting_verification",
      reasons: [{ code, message: "This blocker needs a terminal handoff" }],
    })).toBe(false);
  });

  it("does not wait on completed validation or human decisions", () => {
    expect(isReviewStillPending({ workflowStatus: "completed" }, {
      outcome: "awaiting_verification",
      reasons: [{ code: "required_evidence_missing", message: "CI failed" }],
    })).toBe(false);
    expect(isReviewStillPending({ workflowStatus: "in_progress" }, {
      outcome: "human_decision",
      reasons: [{ code: "human_review_required", message: "Protected policy" }],
    })).toBe(false);
  });

  it("persists a terminal review comment before moving the Issue back to ready-for-agent", async () => {
    const events: string[] = [];
    const comments: GitHubComment[] = [];
    let issue = {
      number: 42,
      state: "open" as "open" | "closed",
      title: "Fix the server path",
      body: "Keep retries idempotent.",
      updated_at: "2026-10-12T00:00:00Z",
      labels: ["bug", "ongoing", "ready-for-human", "needs-info"],
    };
    const api = new StubApi((path, options) => {
      const method = options?.method ?? "GET";
      if (path.endsWith("/issues/42") && method === "GET") return issue;
      if (path.endsWith("/issues/42/comments") && method === "POST") {
        events.push("comment:write");
        comments.push(makeIssueComment(requestBody<{ body: string }>(options).body));
        return {};
      }
      if (path.endsWith("/issues/42/labels") && method === "POST") {
        events.push("label:add");
        issue = {
          ...issue,
          labels: [...issue.labels, ...requestBody<{ labels: string[] }>(options).labels],
        };
        return issue.labels;
      }
      if (path.includes("/issues/42/labels/") && method === "DELETE") {
        const label = decodeURIComponent(path.split("/").at(-1)!);
        events.push(`label:remove:${label}`);
        issue = { ...issue, labels: issue.labels.filter((name) => name !== label) };
        return issue.labels;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }, (path) => {
      if (!path.endsWith("/issues/42/comments")) return [];
      if (comments.length > 0) events.push("comment:readback");
      return comments;
    });

    await publishIssueHandoff(
      api,
      42,
      "<!-- terminal-review -->",
      "PR review requires follow-up. <!-- terminal-review -->",
      REVIEW_BOT_ACTOR_ID,
    );

    expect(events.indexOf("comment:readback")).toBeLessThan(
      events.indexOf("label:add"),
    );
    expect(events.indexOf("label:add")).toBeLessThan(
      events.indexOf("label:remove:ongoing"),
    );
    expect(issue.labels).toContain("bug");
    expect(issue.labels).toContain("ready-for-agent");
    expect(issue.labels).not.toContain("ongoing");
    expect(issue.labels).not.toContain("ready-for-human");
    expect(issue.labels).not.toContain("needs-info");
  });

  it("cleans status labels and refuses dispatch when the Issue closes during handoff", async () => {
    const comments: GitHubComment[] = [];
    const events: string[] = [];
    let issue = {
      number: 42,
      state: "open" as "open" | "closed",
      title: "Fix the server path",
      body: "Keep retries idempotent.",
      updated_at: "2026-10-12T00:00:00Z",
      labels: ["bug", "ongoing"],
    };
    const api = new StubApi((path, options) => {
      const method = options?.method ?? "GET";
      if (path.endsWith("/issues/42") && method === "GET") return issue;
      if (path.endsWith("/issues/42/comments") && method === "POST") {
        comments.push(makeIssueComment(requestBody<{ body: string }>(options).body));
        events.push("comment:write");
        return {};
      }
      if (path.endsWith("/issues/42/labels") && method === "POST") {
        events.push("label:add-ready-for-agent");
        issue = {
          ...issue,
          labels: [...issue.labels, ...requestBody<{ labels: string[] }>(options).labels],
        };
        return issue.labels;
      }
      if (path.includes("/issues/42/labels/") && method === "DELETE") {
        const label = decodeURIComponent(path.split("/").at(-1)!);
        events.push(`label:remove:${label}`);
        issue = {
          ...issue,
          state: label === "ongoing" ? "closed" : issue.state,
          labels: issue.labels.filter((name) => name !== label),
        };
        return issue.labels;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }, (path) => comments);

    await expect(publishIssueHandoff(
      api,
      42,
      "<!-- terminal-review -->",
      "PR review requires follow-up. <!-- terminal-review -->",
      REVIEW_BOT_ACTOR_ID,
    )).rejects.toThrow("closed during the review handoff");

    expect(events.indexOf("comment:write")).toBeLessThan(
      events.indexOf("label:add-ready-for-agent"),
    );
    expect(events.indexOf("label:add-ready-for-agent")).toBeLessThan(
      events.indexOf("label:remove:ongoing"),
    );
    expect(issue.state).toBe("closed");
    expect(issue.labels).toEqual(["bug"]);
  });

  it("does not change labels when the Issue comment cannot be confirmed", async () => {
    const initialLabels = ["bug", "ongoing"];
    const issue = {
      number: 42,
      state: "open" as const,
      title: "Fix the server path",
      body: "Keep retries idempotent.",
      updated_at: "2026-10-12T00:00:00Z",
      labels: initialLabels,
    };
    const events: string[] = [];
    const api = new StubApi((path, options) => {
      const method = options?.method ?? "GET";
      if (path.endsWith("/issues/42") && method === "GET") return issue;
      if (path.endsWith("/issues/42/comments") && method === "POST") {
        events.push("comment:write");
        return {};
      }
      if (path.endsWith("/issues/42/labels") && method === "POST") {
        events.push("label:add");
        return [];
      }
      if (path.includes("/issues/42/labels/") && method === "DELETE") {
        events.push("label:remove");
        return [];
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    await expect(publishIssueHandoff(
      api,
      42,
      "<!-- terminal-review -->",
      "PR review requires follow-up. <!-- terminal-review -->",
      REVIEW_BOT_ACTOR_ID,
    )).rejects.toThrow("did not retain the review comment");

    expect(events).toEqual(["comment:write"]);
    expect(issue.labels).toEqual(initialLabels);
  });

  it("cleans a closed Issue but does not report a dispatch handoff", async () => {
    const comments: GitHubComment[] = [];
    let issue = {
      number: 42,
      state: "closed" as const,
      title: "Fix the server path",
      body: "Keep retries idempotent.",
      updated_at: "2026-10-12T00:00:00Z",
      labels: ["bug", "ongoing", "ready-for-human"],
    };
    const api = new StubApi((path, options) => {
      const method = options?.method ?? "GET";
      if (path.endsWith("/issues/42") && method === "GET") return issue;
      if (path.endsWith("/issues/42/comments") && method === "POST") {
        comments.push(makeIssueComment(requestBody<{ body: string }>(options).body));
        return {};
      }
      if (path.includes("/issues/42/labels/") && method === "DELETE") {
        const label = decodeURIComponent(path.split("/").at(-1)!);
        issue = { ...issue, labels: issue.labels.filter((name) => name !== label) };
        return issue.labels;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }, (path) => path.endsWith("/issues/42/comments") ? comments : []);

    await expect(publishIssueHandoff(
      api,
      42,
      "<!-- terminal-review -->",
      "PR review requires follow-up. <!-- terminal-review -->",
      REVIEW_BOT_ACTOR_ID,
    )).rejects.toThrow("is closed and cannot be handed off");

    expect(issue.state).toBe("closed");
    expect(issue.labels).toEqual(["bug"]);
    expect(comments).toHaveLength(1);
  });

  it("does not accept a user-authored marker as the persisted review comment", async () => {
    const marker = "<!-- terminal-review -->";
    const comments: GitHubComment[] = [
      makeIssueComment(`Spoofed outcome ${marker}`, 123),
    ];
    let issue = {
      number: 42,
      state: "open" as "open" | "closed",
      title: "Fix the server path",
      body: "Keep retries idempotent.",
      updated_at: "2026-10-12T00:00:00Z",
      labels: ["bug", "ongoing"],
    };
    const api = new StubApi((path, options) => {
      const method = options?.method ?? "GET";
      if (path.endsWith("/issues/42") && method === "GET") return issue;
      if (path.endsWith("/issues/42/comments") && method === "POST") {
        comments.push(makeIssueComment(requestBody<{ body: string }>(options).body));
        return {};
      }
      if (path.endsWith("/issues/42/labels") && method === "POST") {
        issue = {
          ...issue,
          labels: [...issue.labels, ...requestBody<{ labels: string[] }>(options).labels],
        };
        return issue.labels;
      }
      if (path.includes("/issues/42/labels/") && method === "DELETE") {
        const label = decodeURIComponent(path.split("/").at(-1)!);
        issue = { ...issue, labels: issue.labels.filter((name) => name !== label) };
        return issue.labels;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }, (path) => path.endsWith("/issues/42/comments") ? comments : []);

    await publishIssueHandoff(
      api,
      42,
      marker,
      `Review result ${marker}`,
      REVIEW_BOT_ACTOR_ID,
    );

    expect(comments).toHaveLength(2);
    expect(issue.labels).toContain("ready-for-agent");
    expect(issue.labels).not.toContain("ongoing");
  });

  it("closes a merged Issue and removes all execution and triage-state labels", async () => {
    const events: string[] = [];
    let issue = {
      number: 42,
      state: "open" as "open" | "closed",
      title: "Fix the server path",
      body: "Keep retries idempotent.",
      updated_at: "2026-10-12T00:00:00Z",
      labels: [
        "bug",
        "ongoing",
        "ready-for-agent",
        "ready-for-human",
        "needs-triage",
        "needs-info",
        "wontfix",
      ],
    };
    const api = new StubApi((path, options) => {
      const method = options?.method ?? "GET";
      if (path.endsWith("/issues/42") && method === "GET") return issue;
      if (path.endsWith("/issues/42") && method === "PATCH") {
        events.push("issue:close");
        issue = { ...issue, state: "closed" };
        return issue;
      }
      if (path.includes("/issues/42/labels/") && method === "DELETE") {
        const label = decodeURIComponent(path.split("/").at(-1)!);
        events.push(`label:remove:${label}`);
        issue = { ...issue, labels: issue.labels.filter((name) => name !== label) };
        return issue.labels;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    await completeIssueAfterApproval(api, 42, {
      autoMergeEnabled: false,
      merged: true,
    });

    expect(events.indexOf("label:remove:ongoing")).toBeLessThan(
      events.indexOf("issue:close"),
    );
    expect(issue.state).toBe("closed");
    expect(issue.labels).toEqual(["bug"]);
  });

  it("uses the same closed-Issue cleanup when the PR is already merged", async () => {
    let issue = {
      number: 42,
      state: "closed" as "open" | "closed",
      title: "Fix the server path",
      body: "Keep retries idempotent.",
      updated_at: "2026-10-12T00:00:00Z",
      labels: ["bug", "ongoing"],
    };
    const api = new StubApi((path, options) => {
      const method = options?.method ?? "GET";
      if (path.endsWith("/issues/42") && method === "GET") return issue;
      if (path.includes("/issues/42/labels/") && method === "DELETE") {
        const label = decodeURIComponent(path.split("/").at(-1)!);
        issue = { ...issue, labels: issue.labels.filter((name) => name !== label) };
        return issue.labels;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    await completeIssueAfterApproval(api, 42, {
      autoMergeEnabled: false,
      merged: true,
    });

    expect(issue.state).toBe("closed");
    expect(issue.labels).toEqual(["bug"]);
  });

  it("refuses successful-review cleanup without auto-merge or a confirmed merge", async () => {
    const api = new StubApi();
    await expect(completeIssueAfterApproval(api, 42, {
      autoMergeEnabled: false,
      merged: false,
    })).rejects.toThrow("cannot close before GitHub confirms");
  });

  it("resolves multiple local Issue references once and excludes PRs and foreign links", async () => {
    const requested: string[] = [];
    const api = new StubApi((path) => {
      requested.push(path);
      if (path.endsWith("/42")) return { number: 42, state: "open" };
      if (path.endsWith("/43")) return { number: 43, state: "closed" };
      if (path.endsWith("/44")) return { number: 44, pull_request: {} };
      throw new Error(`Unexpected lookup: ${path}`);
    });
    const references = await resolveLinkedIssues(api, {
      title: "Fix #42", body: "#42, #43 and #44. https://github.com/lukemyself-hub/SayHear/issues/43 https://github.com/other/repo/issues/999 other/repo#998",
    } as Parameters<typeof resolveLinkedIssues>[1]);
    expect(references.map((issue) => issue.number)).toEqual([42, 43]);
    expect(requested).toHaveLength(3);
    await expect(resolveLinkedIssues(new StubApi(() => ({ number: 44, pull_request: {} })), {
      title: "PR #44", body: "",
    } as Parameters<typeof resolveLinkedIssues>[1])).resolves.toEqual([]);
  });

  it("resolves no references to an empty collection without an Issue lookup", async () => {
    const api = new StubApi(() => { throw new Error("No Issue lookup is allowed without references"); });
    await expect(resolveLinkedIssues(api, {
      title: "Controller safety repair", body: "No links here.",
    } as Parameters<typeof resolveLinkedIssues>[1])).resolves.toEqual([]);
  });

  it("propagates API failures for referenced Issues instead of returning empty", async () => {
    const api = new StubApi((path) => {
      if (path.endsWith("/issues/42")) throw new GitHubApiError(404, "GET", path);
      throw new Error(`Unexpected lookup: ${path}`);
    });
    await expect(resolveLinkedIssues(api, {
      title: "Fix #42", body: "",
    } as Parameters<typeof resolveLinkedIssues>[1])).rejects.toMatchObject({ status: 404 });
  });

  it("parses only well-formed coordinator scope reconciliation", () => {
    const scope = { epoch: "epoch-1", approvedRequirementDigest: "a".repeat(64), verdict: "unchanged" };
    expect(parseModelReviewReport({ ...modelReport, scopeReconciliation: scope }).scopeReconciliation).toEqual(scope);
    expect(parseModelReviewReport(modelReport).scopeReconciliation).toBeUndefined();
    for (const invalid of [null, { ...scope, verdict: "probably" }, { ...scope, approvedRequirementDigest: "A".repeat(64) }, { ...scope, epoch: "" }]) {
      expect(() => parseModelReviewReport({ ...modelReport, scopeReconciliation: invalid })).toThrow("scope reconciliation is invalid");
    }
  });

  it("stores new submit intents as version 2 completion records", async () => {
    const f = await serializedControllerFixture("legacy-root");
    const snapshot = await readSnapshot(f.config, 321);
    const saved = await readSavedReviewReport(f.config, snapshot);
    if (!saved) throw new Error("Expected a saved review report for PR 321");
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "PATCH" && path.endsWith("/check-runs/9002")) return {} as T;
      if (options?.method === "POST" && path.endsWith("/check-runs")) return { id: 9004 } as T;
      return request<T>(path, options);
    };
    const results = await scanPullRequests(f.config, 321);
    expect(results).toEqual([
      expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" }),
    ]);
    const stored = f.stored();
    if (!stored) throw new Error("Expected submit to store a completion intent");
    expect(parseCompletionRecord(stored).version).toBe(2);
  });

  it("waits for merge without closing any Issue when auto-merge is only enabled", async () => {
    const api = new StubApi(() => { throw new Error("No Issue mutation or lookup is allowed yet"); });
    await completeLinkedIssuesAfterMerge(api, [42, 43], { autoMergeEnabled: true, merged: false });
    await expect(completeIssueAfterApproval(api, 42, { autoMergeEnabled: true, merged: false })).rejects.toThrow("confirms merge");
  });

  it("attempts every Issue even when one handoff fails and reports the incomplete work", async () => {
    const attempted: number[] = [];
    await expect(forEachLinkedIssue([43, 42, 43, 44], async (number) => {
      attempted.push(number);
      if (number === 43) throw new Error("Label update failed");
    })).rejects.toThrow("Issue #43: Label update failed");
    expect(attempted).toEqual([42, 43, 44]);
  });

  it("recovers multi-Issue closure after a partial failure using live merge and App approval", async () => {
    const issueMap = new Map([42, 43, 44, 45].map((number) => [number, {
      number, state: number === 44 ? "closed" : "open", title: `Requirement ${number}`, body: "Existing behavior",
      updated_at: "2026-10-12T00:00:00Z", labels: ["bug", "ongoing"],
    }]));
    const pull = { number: 321, node_id: "PR_321", state: "closed", merged: true, merge_commit_sha: MERGE_SHA,
      title: "Deliver #42, #43, #44", body: "Fixes #42, #43 and #44. 本 PR 不关闭也不修改 #45。", updated_at: "2026-10-12T00:00:00Z",
      head: { sha: HEAD_SHA, repo: { id: SAYHEAR_REPOSITORY_ID } }, base: { ref: "main", sha: BASE_SHA, repo: { id: SAYHEAR_REPOSITORY_ID } }, user: { id: 101 } };
    const emptyDiscussion = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
    const report: ModelReviewReport = { ...modelReport, requirementDigest: requirementDigest([...issueMap.values()].map((issue) => ({
      ...issue, updatedAt: issue.updated_at, discussionDigest: emptyDiscussion,
    })), { ...pull, updatedAt: pull.updated_at, discussionDigest: emptyDiscussion }) };
    const approval = { id: 10, user: { id: REVIEW_BOT_ACTOR_ID }, commit_id: HEAD_SHA, state: "APPROVED",
      body: `<!-- sayhear-pr-auto-approval-review:v2 pr=321 head=${HEAD_SHA} base=${BASE_SHA} requirement=${report.requirementDigest} outcome=approve -->` };
    const completionIdentity = {
      repositoryId: SAYHEAR_REPOSITORY_ID, pullRequestNumber: 321, pullRequestNodeId: "PR_321", headSha: HEAD_SHA,
      approvedBaseSha: BASE_SHA, requirementDigest: report.requirementDigest, baseRepositoryId: SAYHEAR_REPOSITORY_ID, baseRef: "main",
      botActorId: REVIEW_BOT_ACTOR_ID, reviewId: 10, appId: 123, policyVersion: PR_REVIEW_GATE_POLICY_VERSION, issueNumbers: [42, 43, 44],

    };
    let fail43 = true;
    const closed: number[] = [];
    const api = new StubApi((path, options) => {
      if (path.endsWith("/pulls/321")) return pull;
      const number = Number(path.match(/\/issues\/(\d+)/)?.[1]);
      const issue = issueMap.get(number);
      if (!issue) throw new Error(`Unexpected request ${path}`);
      if (options?.method === "PATCH") {
        if (number === 43 && fail43) throw new Error("Temporary GitHub failure");
        issue.state = "closed";
        issue.updated_at = "2026-10-13T01:00:00Z";
        pull.updated_at = "2026-10-13T01:00:00Z";
        closed.push(number);
      }
      if (options?.method === "DELETE") issue.labels = issue.labels.filter((label) => label !== decodeURIComponent(path.split("/").at(-1)!));
      return issue;
    }, (path) => path.endsWith("/pulls/321/reviews") ? [approval] : []);
    await expect(reconcileIssueCompletion(api, completionIdentity)).rejects.toThrow("Issue #43");
    expect(issueMap.get(42)?.state).toBe("closed");
    expect(issueMap.get(44)?.labels).toEqual(["bug"]);
    expect(requirementDigest([...issueMap.values()].map((issue) => ({ ...issue, updatedAt: issue.updated_at, discussionDigest: emptyDiscussion })),
      { ...pull, updatedAt: pull.updated_at, discussionDigest: emptyDiscussion })).toBe(report.requirementDigest);
    fail43 = false;
    await expect(reconcileIssueCompletion(api, completionIdentity)).resolves.toBe("issues_completed");
    expect(closed).toEqual([42, 43]);
    expect([...issueMap.values()].filter((issue) => issue.number !== 45).every((issue) => issue.state === "closed" && issue.labels.join() === "bug")).toBe(true);
    expect(issueMap.get(45)).toMatchObject({ state: "open", labels: ["bug", "ongoing"] });
    await expect(reconcileIssueCompletion(api, completionIdentity)).resolves.toBe("issues_completed");
    expect(closed).toEqual([42, 43]);
    pull.merged = false;
    pull.state = "open";
    await expect(reconcileIssueCompletion(api, completionIdentity)).resolves.toBe("waiting_for_merge");
    pull.state = "closed";
    await expect(reconcileIssueCompletion(api, completionIdentity)).rejects.toThrow("closed_without_merge");
    pull.merged = true;
    await expect(reconcileIssueCompletion(api, { ...completionIdentity, requirementDigest: "f".repeat(64) })).rejects.toThrow("reviewer_mismatch");
    issueMap.get(43)!.body = "A newly changed requirement";
    await expect(reconcileIssueCompletion(api, completionIdentity)).rejects.toThrow("requirement_content_mismatch");
  });

  it("excludes only authenticated Vercel deployment status from PR requirements", () => {
    const comment: GitHubComment = { id: 1, body: "[vc]: #status", created_at: "now",
      updated_at: "now", user: { id: 35613825, login: "vercel[bot]", type: "Bot" },
      performed_via_github_app: { id: 8329 } };
    expect(isVercelDeploymentStatus(comment)).toBe(true);
    expect(isVercelDeploymentStatus({ ...comment, user: { ...comment.user, login: "another[bot]" } })).toBe(false);
    expect(isVercelDeploymentStatus({ ...comment, user: { ...comment.user, type: "User" } })).toBe(false);
    expect(isVercelDeploymentStatus({ ...comment, user: { ...comment.user, id: 123 } })).toBe(false);
    expect(isVercelDeploymentStatus({ ...comment, performed_via_github_app: { id: 123 } })).toBe(false);
    expect(isVercelDeploymentStatus({ ...comment, body: "Change the product requirement" })).toBe(false);
    expect(isVercelDeploymentStatus({ ...comment, performed_via_github_app: null })).toBe(false);
  });
  it("keeps the requirement digest stable across non-requirement comment bytes", () => {
    const human: GitHubComment = { id: 1, body: "Requirement detail", created_at: "t1",
      updated_at: "t1", user: { id: 777, login: "someone", type: "User" } };
    const base = digestDiscussion([human], [], "review-exclusive-v5");
    expect(digestDiscussion([{ ...human, created_at: "t2", updated_at: "t3" }], [], "review-exclusive-v5")).toBe(base);
    const agent: GitHubComment = { id: 2, body: "handling record", created_at: "t1", updated_at: "t1", user: { ...AGENT_IDENTITY } };
    const bot: GitHubComment = { id: 3, body: "bot output", created_at: "t1", updated_at: "t1",
      user: { id: 999, login: "some-app[bot]", type: "Bot" } };
    expect(digestDiscussion([human, agent, bot], [], "review-exclusive-v5")).toBe(base);
    expect(digestDiscussion([human, { ...agent, body: "edited" }, { ...bot, body: "edited" }], [], "review-exclusive-v5")).toBe(base);
    expect(digestDiscussion([{ ...human, body: "Changed requirement" }], [], "review-exclusive-v5")).not.toBe(base);
    const luke: GitHubComment = { id: 4, body: "LGTM", created_at: "t1", updated_at: "t1", user: { ...LUKE_IDENTITY } };
    expect(digestDiscussion([human, luke], [], "review-exclusive-v5")).not.toBe(base);
    // The gate's requirement digest is a pure function of the discussion digest, so the controller and gate agree.
    const gateDigest = (discussionDigest: string) => requirementDigest([], { number: 1, title: "t", body: "b", updatedAt: "t1", discussionDigest });
    expect(gateDigest(digestDiscussion([human, agent, bot], [], "review-exclusive-v5"))).toBe(gateDigest(base));
  });
  it("binds protected human authorization to a complete exact diff and requirement", () => {
    const raw = { pullRequestNumber: 311, approvedHeadSha: HEAD_SHA,
      diffDigest: CHANGE_DIGEST, requirementDigest: REQUIREMENT_DIGEST,
      paths: ["docs/adr/0151-platform.md"], validateWorkflowBlobSha: null,
      approvedAt: "2026-10-11T08:00:00Z" };
    const records = parseHumanReviewAuthorizations([raw]);
    expect(parseHumanReviewAuthorizations([{ ...raw, noRuntimeImpact: true }])[0])
      .toEqual({ ...raw, noRuntimeImpact: true });
    expect(() => parseHumanReviewAuthorizations([{ ...raw, noRuntimeImpact: "true" }])).toThrow();
    const identity = { pullRequestNumber: 311, diffDigest: CHANGE_DIGEST,
      requirementDigest: REQUIREMENT_DIGEST, diffComplete: true };
    expect(matchHumanReviewAuthorization(records, identity)).toEqual(raw);
    for (const mismatch of [{ pullRequestNumber: 310 }, { diffDigest: "f".repeat(64) },
      { requirementDigest: "f".repeat(64) }, { diffComplete: false }]) {
      expect(matchHumanReviewAuthorization(records, { ...identity, ...mismatch })).toBeNull();
    }
    expect(matchHumanReviewAuthorization([...records, ...records], identity)).toBeNull();
    for (const invalid of [{ paths: ["../config.json"] }, { paths: ["/etc/config"] },
      { diffDigest: "short" }, { approvedHeadSha: "short" }, { approvedAt: "invalid" }]) {
      expect(() => parseHumanReviewAuthorizations([{ ...raw, ...invalid }])).toThrow();
    }
    expect(parseHumanReviewAuthorizations(undefined)).toEqual([]);
  });

  it("trusts only the base workflow or the exact approved workflow blob", () => {
    expect(isTrustedWorkflowVersion(BASE_SHA, BASE_SHA, null)).toBe(true);
    expect(isTrustedWorkflowVersion(BASE_SHA, HEAD_SHA, HEAD_SHA)).toBe(true);
    expect(isTrustedWorkflowVersion(BASE_SHA, MERGE_SHA, HEAD_SHA)).toBe(false);
    expect(isTrustedWorkflowVersion(null, HEAD_SHA, HEAD_SHA)).toBe(false);
    expect(isTrustedWorkflowVersion(BASE_SHA, null, HEAD_SHA)).toBe(false);
  });
  it("pins protected merge to the reviewed head and fails closed on refusal or SHA conflicts", async () => {
    const api = new StubApi((path, options) => {
      expect(path).toBe("/repos/lukemyself-hub/SayHear/pulls/325/merge");
      expect(options).toEqual({ method: "PUT", body: { sha: HEAD_SHA, merge_method: "merge" } });
      return { merged: true, sha: MERGE_SHA };
    });
    await expect(requestProtectedMerge(api, 325, HEAD_SHA, "MERGE")).resolves.toBeUndefined();
    await expect(requestProtectedMerge(new StubApi(() => ({ merged: false })), 325, HEAD_SHA, "MERGE"))
      .rejects.toThrow("did not confirm");
    const conflict = new StubApi((path) => { throw new GitHubApiError(409, "PUT", path); });
    await expect(requestProtectedMerge(conflict, 325, HEAD_SHA, "MERGE")).rejects.toThrow();
  });

  it("creates a short-lived, signed GitHub App JWT", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const now = 1_800_000_000;
    const token = createGitHubAppJwt(
      123456,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      now,
    );
    const [headerPart, payloadPart, signaturePart] = token.split(".");
    const signatureValid = verify(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      publicKey,
      Buffer.from(signaturePart!, "base64url"),
    );

    expect(JSON.parse(Buffer.from(headerPart!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(
      JSON.parse(Buffer.from(payloadPart!, "base64url").toString()),
    ).toEqual({ iat: now - 60, exp: now + 8 * 60, iss: 123456 });
    expect(signatureValid).toBe(true);
  });

  it("keeps installation tokens in request headers and rejects absolute API paths", async () => {
    let receivedAuthorization: string | null = null;
    let receivedAccept: string | null = null;
    const client = new GitHubRestClient(
      "installation-token",
      async (_input, init) => {
        const headers = new Headers(init?.headers);
        receivedAuthorization = headers.get("authorization");
        receivedAccept = headers.get("accept");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    await expect(client.request("/repos/lukemyself-hub/SayHear")).resolves.toEqual({
      ok: true,
    });
    await expect(client.request("//example.com")).rejects.toThrow(
      "paths must be relative",
    );
    expect(receivedAuthorization).toBe("Bearer installation-token");
    expect(receivedAccept).toBe("application/vnd.github+json");
  });

  it("recovers a lost merge response only after verifying the reviewed head was actually merged", async () => {
    const api = new StubApi((path) => {
      if (path.endsWith("/merge")) throw new Error("Response lost");
      return { merged: true, state: "closed", head: { sha: HEAD_SHA } };
    });
    await expect(requestProtectedMerge(api, 325, HEAD_SHA, "MERGE")).resolves.toBeUndefined();
    for (const readback of [
      { merged: false, state: "closed", head: { sha: HEAD_SHA } },
      { merged: true, state: "closed", head: { sha: BASE_SHA } },
    ]) {
      const ambiguous = new StubApi((path) => {
        if (path.endsWith("/merge")) throw new Error("Response lost");
        return readback;
      });
      await expect(requestProtectedMerge(ambiguous, 325, HEAD_SHA, "MERGE")).rejects.toThrow("Response lost");
    }
  });

  it("reads explicit merge settings when installation-token REST omits them", async () => {
    const settings = {
      autoMergeAllowed: true, mergeCommitAllowed: true,
      squashMergeAllowed: false, rebaseMergeAllowed: false,
    };
    const api = new StubApi((path) => path === "/graphql"
      ? { data: { repository: settings } }
      : { id: SAYHEAR_REPOSITORY_ID });
    await expect(readRepositoryMergeSettings(api)).resolves.toMatchObject({
      allow_auto_merge: true, allow_merge_commit: true,
      allow_squash_merge: false, allow_rebase_merge: false,
    });
    const missing = new StubApi((path) => path === "/graphql"
      ? { data: { repository: {} } } : {});
    await expect(readRepositoryMergeSettings(missing)).rejects.toThrow("incomplete");
    const denied = new StubApi((path) => path === "/graphql"
      ? { errors: [{ message: "denied" }] } : {});
    await expect(readRepositoryMergeSettings(denied)).rejects.toThrow("complete snapshot");
  });

  it("resolves the current PR merge ref only when its parents match the base and head", async () => {
    const pullRequest = {
      number: 321,
      base: { ref: "main", sha: BASE_SHA },
      head: { sha: HEAD_SHA, repo: { id: SAYHEAR_REPOSITORY_ID } },
      merge_commit_sha: null,
    };
    const api = new StubApi((path) => {
      if (path.endsWith("/git/ref/pull/321/merge")) {
        return {
          ref: "refs/pull/321/merge",
          object: { type: "commit", sha: MERGE_SHA },
        };
      }
      if (path.endsWith(`/git/commits/${MERGE_SHA}`)) {
        return { parents: [{ sha: BASE_SHA }, { sha: HEAD_SHA }] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await expect(readCurrentPullRequestMergeSha(api, pullRequest)).resolves.toBe(
      MERGE_SHA,
    );
  });

  it("accepts a PR merge ref built against the latest main while the PR base is stale", async () => {
    const currentMainSha = "f".repeat(40);
    const pullRequest = {
      number: 321,
      base: { ref: "main", sha: BASE_SHA },
      head: { sha: HEAD_SHA, repo: { id: SAYHEAR_REPOSITORY_ID } },
      merge_commit_sha: null,
    };
    const api = new StubApi((path) => {
      if (path.endsWith("/git/ref/pull/321/merge")) {
        return {
          ref: "refs/pull/321/merge",
          object: { type: "commit", sha: MERGE_SHA },
        };
      }
      if (path.endsWith(`/git/commits/${MERGE_SHA}`)) {
        return { parents: [{ sha: currentMainSha }, { sha: HEAD_SHA }] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await expect(
      readCurrentPullRequestMergeSha(api, pullRequest, currentMainSha),
    ).resolves.toBe(MERGE_SHA);
  });

  it("fails closed when the PR merge ref is absent or has stale parents", async () => {
    const pullRequest = {
      number: 321,
      base: { ref: "main", sha: BASE_SHA },
      head: { sha: HEAD_SHA, repo: { id: SAYHEAR_REPOSITORY_ID } },
      merge_commit_sha: null,
    };
    const missingRef = new StubApi((path) => {
      throw new GitHubApiError(404, "GET", path);
    });
    const staleParents = new StubApi((path) => {
      if (path.endsWith("/git/ref/pull/321/merge")) {
        return {
          ref: "refs/pull/321/merge",
          object: { type: "commit", sha: MERGE_SHA },
        };
      }
      if (path.endsWith(`/git/commits/${MERGE_SHA}`)) {
        return { parents: [{ sha: BASE_SHA }, { sha: "f".repeat(40) }] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await expect(
      readCurrentPullRequestMergeSha(missingRef, pullRequest),
    ).resolves.toBeNull();
    await expect(
      readCurrentPullRequestMergeSha(staleParents, pullRequest),
    ).resolves.toBeNull();
  });

  it("rejects oversized downloaded evidence before parsing it", async () => {
    const client = new GitHubRestClient(
      "installation-token",
      async () =>
        new Response("large", {
          status: 200,
          headers: { "content-length": "5" },
        }),
    );

    await expect(
      client.bytes("/repos/lukemyself-hub/SayHear/pull/1.diff", {
        accept: "application/vnd.github.diff",
        maxBytes: 4,
      }),
    ).rejects.toThrow("exceeds the 4-byte limit");
  });

  it("bounds streamed evidence without a Content-Length and cancels an oversized body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
      },
      cancel() { cancelled = true; },
    });
    const client = new GitHubRestClient("installation-token", async () => new Response(body));
    await expect(client.bytes("/repos/lukemyself-hub/SayHear/git/blobs/example", { maxBytes: 4 }))
      .rejects.toThrow("exceeds the 4-byte limit");
    expect(cancelled).toBe(true);
  });

  it("accepts a valid structured review and rejects request changes without a blocker", () => {
    expect(parseModelReviewReport(modelReport)).toMatchObject({
      decision: "approve",
      pullRequestNumber: 321,
    });
    expect(() =>
      parseModelReviewReport({
        ...modelReport,
        decision: "request_changes",
      }),
    ).toThrow("requires at least one concrete P0, P1, or P2 finding");
  });

  it("uses open Issue dependencies and fails closed when the graph is incomplete", async () => {
    const complete = new StubApi(() => ({
      data: {
        repository: {
          issue: {
            blockedBy: {
              nodes: [
                { number: 11, state: "OPEN" },
                { number: 12, state: "CLOSED" },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    }));
    const incomplete = new StubApi(() => ({
      data: {
        repository: {
          issue: {
            blockedBy: {
              nodes: [{ number: 11, state: "OPEN" }],
              pageInfo: { hasNextPage: true },
            },
          },
        },
      },
    }));

    await expect(readIssueDependencies(complete, 42)).resolves.toEqual([11]);
    await expect(readIssueDependencies(incomplete, 42)).resolves.toBeNull();
  });

  it("reads every required branch rule and fails closed when the rulesets cannot be read", async () => {
    const protection = {
      required_status_checks: {
        strict: true,
        checks: [
          { context: "validate", app_id: ACTIONS_APP_ID },
          { context: "pr-review-gate", app_id: 98765 },
        ],
      },
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        required_approving_review_count: 1,
      },
      enforce_admins: { enabled: true },
    };
    const readable = new StubApi((path) =>
      path.endsWith("/branches/main/protection") ? protection : {},
    );
    const appOnlyBypass = new StubApi(
      (path) =>
        path.endsWith("/branches/main/protection")
          ? protection
          : path.includes("/rulesets/9?")
            ? {
                id: 9,
                bypass_actors: [
                  { actor_id: 98765, actor_type: "Integration", bypass_mode: "always" },
                ],
              }
            : {},
      (path) => (path.includes("/rulesets") ? [{ id: 9 }] : []),
    );
    const hiddenBypass = new StubApi(
      (path) =>
        path.endsWith("/branches/main/protection")
          ? protection
          : path.includes("/rulesets/9?")
            ? { id: 9, current_user_can_bypass: "never" }
            : {},
      (path) => (path.includes("/rulesets") ? [{ id: 9 }] : []),
    );
    const unreadableRulesets = new StubApi(
      (path) =>
        path.endsWith("/branches/main/protection") ? protection : {},
      () => {
        throw new Error("permission denied");
      },
    );

    await expect(readBranchProtection(readable)).resolves.toMatchObject({
      readable: true,
      protected: true,
      requiresUpToDate: true,
      dismissesStaleReviews: true,
      enforcesAdmins: true,
      requiredApprovingReviews: 1,
      requiredChecks: [
        { name: "validate", appId: ACTIONS_APP_ID },
        { name: "pr-review-gate", appId: 98765 },
      ],
      bypassActorIds: [],
    });
    // GitHub returns `bypass_actors` only to a caller with administration
    // access. The rule that matters here is only "a second actor can move
    // main", so an extra bypass actor is reported and the gate decides.
    await expect(readBranchProtection(appOnlyBypass)).resolves.toMatchObject({
      readable: true,
      bypassActorIds: [98765],
    });
    // A hidden bypass set no longer poisons readability: the rules themselves
    // parsed, and bypass membership is the main writer guard's question now.
    await expect(readBranchProtection(hiddenBypass)).resolves.toMatchObject({
      readable: true,
      bypassActorIds: [],
    });
    await expect(readBranchProtection(unreadableRulesets)).resolves.toMatchObject({
      readable: false,
      protected: true,
    });
  });

  it("keeps the strict up-to-date rule unless the config opts into the queue", () => {
    expect(parseIntegrationMode(undefined)).toBe("up-to-date-base");
    expect(parseIntegrationMode(null)).toBe("up-to-date-base");
    expect(parseIntegrationMode("up-to-date-base")).toBe("up-to-date-base");
    expect(parseIntegrationMode("merge-queue")).toBe("merge-queue");
    expect(parseIntegrationMode("serialized-merge")).toBe("serialized-merge");
    expect(() => parseIntegrationMode("fast-lane")).toThrow(/integrationMode/);
  });

  it("lets parallel approvals overlap only under the merge queue", () => {
    // The pinned path rebases and merges a single PR at a time, so any other
    // open PR still blocks it.
    expect(anotherApprovalInFlightFor("up-to-date-base", 0)).toBe(false);
    expect(anotherApprovalInFlightFor("up-to-date-base", 1)).toBe(true);
    expect(anotherApprovalInFlightFor("up-to-date-base", 5)).toBe(true);
    // The queue serializes the merges themselves, so reviews may overlap and
    // two PRs on the same older main both stay eligible.
    expect(anotherApprovalInFlightFor("merge-queue", 0)).toBe(false);
    expect(anotherApprovalInFlightFor("merge-queue", 1)).toBe(false);
    expect(anotherApprovalInFlightFor("merge-queue", 5)).toBe(false);
    // Serialized merge pins one merge at a time against the current main but
    // never rebases, so reviews overlap here too.
    expect(anotherApprovalInFlightFor("serialized-merge", 0)).toBe(false);
    expect(anotherApprovalInFlightFor("serialized-merge", 1)).toBe(true);
    expect(anotherApprovalInFlightFor("serialized-merge", 5)).toBe(true);
  });

  it("reads main's merge queue and treats an unreadable result as unknown", async () => {
    const queued = new StubApi((path) => path === "/graphql"
      ? { data: { repository: { mergeQueue: { id: "MQ_main" } } } }
      : {});
    const plain = new StubApi((path) => path === "/graphql"
      ? { data: { repository: { mergeQueue: null } } }
      : {});
    const incomplete = new StubApi((path) => path === "/graphql"
      ? { data: { repository: {} } }
      : {});
    const denied = new StubApi(
      (path) => {
        if (path !== "/graphql") return {};
        throw new GitHubApiError(403, "POST", "/graphql");
      },
    );

    await expect(readMergeQueueAvailability(queued)).resolves.toBe(true);
    await expect(readMergeQueueAvailability(plain)).resolves.toBe(false);
    await expect(readMergeQueueAvailability(incomplete)).resolves.toBeNull();
    await expect(readMergeQueueAvailability(denied)).resolves.toBeNull();
  });

  it("reads who can update main and fails closed on anything unreadable", async () => {
    const ruleset = (overrides: Record<string, unknown> = {}) => ({
      id: 7,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "update" }],
      updated_at: "2026-10-14T21:00:00.000Z",
      bypass_actors: [{ actor_id: 98765, actor_type: "Integration" }],
      current_user_can_bypass: "always",
      ...overrides,
    });
    // GitHub's list endpoint answers with summaries only -- no conditions, no
    // rules, and no bypass actors -- so the guard has to fetch each detail.
    // These stubs reproduce that split: the list feeds `rulesets`, the details
    // map feeds `GET /rulesets/{id}`, and a list-only stub can never pass.
    const api = (
      rulesets: readonly unknown[],
      details: ReadonlyMap<number, unknown> = new Map(),
    ) =>
      new StubApi(
        (path) => {
          const match = /\/rulesets\/(\d+)\?/.exec(path);
          return match ? details.get(Number(match[1])) ?? {} : {};
        },
        (path) => (path.includes("/rulesets") ? [...rulesets] : []),
      );
    const guard = (
      overrides: Record<string, unknown> = {},
      summary: Record<string, unknown> = {},
    ) => api([{ id: 7, ...summary }], new Map([[7, ruleset(overrides)]]));
    const denied = new StubApi(
      () => ({}),
      (path) => {
        throw new GitHubApiError(403, "GET", path);
      },
    );

    // The guard the gate wants: main's updates are restricted to one App.
    await expect(
      readMainWriterGuard(guard(), "main"),
    ).resolves.toEqual({
      readable: true,
      restrictsDefaultBranchUpdates: true,
      bypassActorIds: [98765],
      bypassActorsEnumerated: true,
      appBypassMode: "always",
      rulesetIds: [7],
      rulesetFingerprints: [{ id: 7, fingerprint: fingerprintRuleset(ruleset()) }],
    });
    // Extra bypass actors are reported truthfully; the gate is what refuses them.
    await expect(
      readMainWriterGuard(
        guard({
          bypass_actors: [
            { actor_id: 98765, actor_type: "Integration", bypass_mode: "always" },
            { actor_id: 42, actor_type: "User" },
          ],
        }),
        "main",
      ),
    ).resolves.toMatchObject({ bypassActorIds: [42, 98765] });
    // A tag ruleset, another branch, an excluded branch, an inactive ruleset, or
    // a ruleset without an update rule never restricts updates to main.
    for (const unrelated of [
      ruleset({ target: "tag" }),
      ruleset({ enforcement: "disabled" }),
      ruleset({ conditions: { ref_name: { include: ["refs/heads/release/*"] } } }),
      ruleset({ conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: ["~DEFAULT_BRANCH"] } } }),
      ruleset({ rules: [{ type: "deletion" }] }),
    ]) {
      await expect(
        readMainWriterGuard(api([{ id: 7 }], new Map([[7, unrelated]])), "main"),
      ).resolves.toMatchObject({
        readable: true,
        restrictsDefaultBranchUpdates: false,
        bypassActorIds: [],
      });
    }
    // An explicit `refs/heads/main` is the same branch and does count.
    await expect(
      readMainWriterGuard(
        guard({ conditions: { ref_name: { include: ["refs/heads/main"] } } }),
        "main",
      ),
    ).resolves.toMatchObject({
      restrictsDefaultBranchUpdates: true,
      bypassActorIds: [98765],
    });
    // An unreadable ruleset list is never treated as App-only.
    await expect(readMainWriterGuard(denied, "main")).resolves.toEqual({
      readable: false,
      restrictsDefaultBranchUpdates: false,
      bypassActorIds: [],
      bypassActorsEnumerated: false,
      appBypassMode: null,
      rulesetIds: [],
    });
    // A list-only shape never passes: the summaries carry none of the fields the
    // guard reads, so every ruleset needs its detail, and a missing or foreign
    // detail is a read failure rather than a silent skip.
    await expect(
      readMainWriterGuard(api([{ id: 7 }]), "main"),
    ).resolves.toMatchObject({ readable: false });
    await expect(
      readMainWriterGuard(api([{ id: 7 }], new Map([[8, ruleset()]])), "main"),
    ).resolves.toMatchObject({ readable: false });
    // A hidden bypass set is reported as unproven rather than as unreadable: the
    // restrictions themselves were read, so the gate can name the missing proof.
    await expect(
      readMainWriterGuard(guard({ bypass_actors: undefined }), "main"),
    ).resolves.toMatchObject({
      readable: true,
      restrictsDefaultBranchUpdates: true,
      bypassActorIds: [],
      bypassActorsEnumerated: false,
      appBypassMode: "always",
      rulesetIds: [7],
    });
    await expect(
      readMainWriterGuard(guard({ rules: undefined }), "main"),
    ).resolves.toMatchObject({ readable: false });
    await expect(
      readMainWriterGuard(guard({ conditions: undefined }), "main"),
    ).resolves.toMatchObject({ readable: false });
  });

  it("fingerprints rulesets so any touch is visible without reading bypass actors", () => {
    const detail = {
      id: 25136844,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "update" }, { type: "non_fast_forward" }],
      updated_at: "2026-10-14T21:00:00.000Z",
    };
    const same = fingerprintRuleset(detail);
    // Deterministic and key-order insensitive.
    expect(fingerprintRuleset({ ...detail })).toBe(same);
    expect(
      fingerprintRuleset({
        updated_at: detail.updated_at,
        rules: detail.rules,
        conditions: detail.conditions,
        target: detail.target,
        enforcement: detail.enforcement,
        id: detail.id,
      }),
    ).toBe(same);
    // Any touch changes the fingerprint: bypass edits, rule edits,
    // enforcement flips, retargeting, and clock bumps alike.
    for (const touched of [
      { ...detail, updated_at: "2026-10-14T21:00:01.000Z" },
      { ...detail, enforcement: "disabled" },
      { ...detail, target: "tag" },
      { ...detail, rules: [{ type: "update" }] },
      {
        ...detail,
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      },
    ]) {
      expect(fingerprintRuleset(touched)).not.toBe(same);
    }
    // Bypass actors never enter the fingerprint: the field GitHub hides
    // cannot be part of the comparison either way.
    expect(
      fingerprintRuleset({
        ...detail,
        bypass_actors: [{ actor_id: 5270295, actor_type: "Integration" }],
      }),
    ).toBe(same);
    // Without updated_at there is no touch detection, so it fails closed.
    expect(() => fingerprintRuleset({ ...detail, updated_at: undefined })).toThrow();
  });

  it("hashes the updated_at instant, not its per-caller string form", () => {
    // GitHub renders the same instant as UTC `Z` for the App token and with
    // a local offset for a user token. The attestation (gh-shaped) and the
    // controller (App-shaped) must converge on one fingerprint or they can
    // never match.
    const utc = {
      id: 25142474,
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "update" }],
      updated_at: "2026-10-15T06:41:11.603Z",
    };
    const offset = { ...utc, updated_at: "2026-10-14T23:41:11.603-07:00" };
    expect(fingerprintRuleset(offset)).toBe(fingerprintRuleset(utc));
    expect(() => fingerprintRuleset({ ...utc, updated_at: "not-a-time" })).toThrow();
  });

  it("honors only the maintainer's latest pause command", () => {
    const comments = [
      {
        id: 1,
        body: "/pause-pr-auto-approval",
        created_at: "2026-10-10T12:00:00.000Z",
        updated_at: "2026-10-10T12:00:00.000Z",
        user: { id: 10, login: "maintainer" },
      },
      {
        id: 2,
        body: "/resume-pr-auto-approval",
        created_at: "2026-10-10T13:00:00.000Z",
        updated_at: "2026-10-10T13:00:00.000Z",
        user: { id: 11, login: "other-user" },
      },
      {
        id: 3,
        body: "/resume-pr-auto-approval",
        created_at: "2026-10-10T14:00:00.000Z",
        updated_at: "2026-10-10T14:00:00.000Z",
        user: { id: 10, login: "maintainer" },
      },
    ] satisfies GitHubComment[];

    expect(parsePauseState(comments, 10, 99)).toEqual({
      active: false,
      source: "maintainer",
    });
  });

  it("takes the MAX across divergent histories and exposes consistency diagnostics", () => {
    const review = (id: number, round: number, digest: string, at: string): GitHubComment => ({
      id,
      body: `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=${id} head=${HEAD_SHA} base=${BASE_SHA} round=${round} diff=${digest} outcome=request_changes -->`,
      created_at: at,
      updated_at: at,
      user: { id: 99, login: "review-app[bot]" },
    });
    const history = parseRequestChangeHistory(
      [
        review(11, 1, CHANGE_DIGEST, "2026-10-10T12:00:00.000Z"),
        // A newer entry with a lower count must not lower the budget: MAX wins.
        review(12, 0, CHANGE_DIGEST, "2026-10-10T13:00:00.000Z"),
        // Same review id reused with a conflicting identity: MAX still wins,
        // but the conflict fails closed.
        review(11, 3, "e".repeat(64), "2026-10-10T14:00:00.000Z"),
      ],
      321,
      99,
    );
    expect(history).toMatchObject({
      count: 3,
      latestDiffDigest: "e".repeat(64),
      historyConsistent: false,
    });
    expect(history.diagnostics.join(" ")).toContain("conflicting history");

    const divergent = combineRemediationHistory(
      [
        review(21, 1, CHANGE_DIGEST, "2026-10-10T12:00:00.000Z"),
        review(22, 3, "e".repeat(64), "2026-10-10T13:00:00.000Z"),
      ],
      321,
      99,
    );
    expect(divergent.count).toBe(3);
    expect(divergent.latestDiffDigest).toBe("e".repeat(64));
  });

  it("counts approve markers, ignores foreign/untrusted copies, and fails closed on malformed history", () => {
    const approve = (id: number, at: string): GitHubComment => ({
      id,
      body: `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=${id} head=${HEAD_SHA} base=${BASE_SHA} round=2 diff=${CHANGE_DIGEST} outcome=approve -->`,
      created_at: at,
      updated_at: at,
      user: { id: 99, login: "review-app[bot]" },
    });
    const foreign: GitHubComment = {
      id: 3,
      body: `<!-- sayhear-pr-auto-approval-review:v1 pr=999 review=31 head=${HEAD_SHA} base=${BASE_SHA} round=9 diff=${CHANGE_DIGEST} outcome=request_changes -->`,
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
      user: { id: 99, login: "review-app[bot]" },
    };
    const untrusted: GitHubComment = {
      id: 4,
      body: `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=32 head=${HEAD_SHA} base=${BASE_SHA} round=9 diff=${CHANGE_DIGEST} outcome=request_changes -->`,
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
      user: { id: 100, login: "mallory" },
    };
    const malformed: GitHubComment = {
      id: 5,
      // Missing diff/outcome fields: trusted App output this marker, but it is not safe.
      body: "<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=33 -->",
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
      user: { id: 99, login: "review-app[bot]" },
    };
    // An approve marker carries the running count without erasing or pausing the budget.
    expect(parseRequestChangeHistory([approve(11, "2026-10-10T12:00:00.000Z")], 321, 99)).toMatchObject({
      count: 2,
      historyConsistent: true,
    });
    // Foreign PR ledgers and untrusted actors are ignored entirely.
    expect(parseRequestChangeHistory([foreign, untrusted], 321, 99)).toMatchObject({
      count: 0,
      historyConsistent: true,
    });
    const bad = parseRequestChangeHistory([approve(11, "2026-10-10T12:00:00.000Z"), malformed], 321, 99);
    expect(bad.count).toBe(2);
    expect(bad.historyConsistent).toBe(false);
    expect(bad.diagnostics.join(" ")).toContain("malformed trusted marker");
    // No history at all is consistent zero, never unknown or a reset.
    expect(combineRemediationHistory([], 321, 99)).toMatchObject({
      count: 0,
      historyConsistent: true,
    });
    expect(remediationFromHistory({ count: 0, historyConsistent: true, latestHeadSha: null }, { active: false, source: "none" })).toMatchObject({
      roundsConsumed: 0,
      paused: false,
      historyConsistent: true,
      latestReviewedHead: null,
    });
  });

  it("keeps the PR-level budget when the third round pauses even with zero Issues", () => {
    const history = parseRequestChangeHistory(
      [{
        id: 1,
        body: `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=17 head=${HEAD_SHA} base=${BASE_SHA} round=2 diff=${CHANGE_DIGEST} outcome=request_changes -->`,
        created_at: "2026-10-10T12:00:00.000Z",
        updated_at: "2026-10-10T12:00:00.000Z",
        user: { id: 99, login: "review-app[bot]" },
      }],
      321,
      99,
    );
    expect(history.historyConsistent).toBe(true);
    expect(nextRequestChangeRound(history, "e".repeat(64))).toBe(MAX_REMEDIATION_ROUNDS);
    // The second post-fix review on the same changed diff replays the same round.
    expect(nextRequestChangeRound({ ...history, count: MAX_REMEDIATION_ROUNDS }, "e".repeat(64))).toBe(MAX_REMEDIATION_ROUNDS);
    expect(remediationFromHistory({ count: MAX_REMEDIATION_ROUNDS, historyConsistent: true, latestHeadSha: history.latestHeadSha }, { active: false, source: "none" })).toMatchObject({
      roundsConsumed: MAX_REMEDIATION_ROUNDS,
      paused: true,
      pauseSource: "review-app",
      latestReviewedHead: history.latestHeadSha,
    });
    expect(history.latestHeadSha).toBe(HEAD_SHA.toLowerCase());
  });

  it("regression: same review id with round 0 then 3 keeps MAX and fails closed", () => {
    const first: GitHubComment = {
      id: 101,
      body: `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=40 head=${HEAD_SHA} base=${BASE_SHA} round=0 diff=${CHANGE_DIGEST} outcome=request_changes -->`,
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
      user: { id: 99, login: "review-app[bot]" },
    };
    const second: GitHubComment = {
      id: 102,
      body: `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=40 head=${HEAD_SHA} base=${BASE_SHA} round=3 diff=${"e".repeat(64)} outcome=request_changes -->`,
      created_at: "2026-10-10T13:00:00.000Z",
      updated_at: "2026-10-10T13:00:00.000Z",
      user: { id: 99, login: "review-app[bot]" },
    };
    const history = parseRequestChangeHistory([first, second], 321, 99);
    expect(history.count).toBe(3);
    expect(history.latestDiffDigest).toBe("e".repeat(64));
    expect(history.historyConsistent).toBe(false);
    expect(history.diagnostics.join(" ")).toContain("conflicting history");
  });

  it("regression: valid plus broken current-PR marker in the same comment fails closed", () => {
    const comment: GitHubComment = {
      id: 103,
      body: [
        `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=41 head=${HEAD_SHA} base=${BASE_SHA} round=1 diff=${CHANGE_DIGEST} outcome=request_changes -->`,
        `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=42 head=${HEAD_SHA} base=${BASE_SHA} round=2`,
      ].join("\n"),
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
      user: { id: 99, login: "review-app[bot]" },
    };
    const history = parseRequestChangeHistory([comment], 321, 99);
    expect(history.count).toBe(1);
    expect(history.historyConsistent).toBe(false);
    expect(history.diagnostics.join(" ")).toContain("malformed trusted marker");
  });

  it("regression: pr=3620 is ignored when the current PR is 362", () => {
    const comment: GitHubComment = {
      id: 104,
      body: `<!-- sayhear-pr-auto-approval-review:v1 pr=3620 review=43 head=${HEAD_SHA} base=${BASE_SHA} round=9 diff=${CHANGE_DIGEST} outcome=request_changes -->`,
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
      user: { id: 99, login: "review-app[bot]" },
    };
    expect(parseRequestChangeHistory([comment], 362, 99)).toMatchObject({
      count: 0,
      historyConsistent: true,
    });
  });

  it("regression: unsafe review id fails closed", () => {
    const comment: GitHubComment = {
      id: 105,
      body: `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=9007199254740993 head=${HEAD_SHA} base=${BASE_SHA} round=1 diff=${CHANGE_DIGEST} outcome=request_changes -->`,
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
      user: { id: 99, login: "review-app[bot]" },
    };
    const history = parseRequestChangeHistory([comment], 321, 99);
    expect(history.count).toBe(0);
    expect(history.historyConsistent).toBe(false);
    expect(history.diagnostics.join(" ")).toContain("unsafe review id");
  });

  it("regression: identical duplicate markers stay consistent", () => {
    const body = `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=44 head=${HEAD_SHA} base=${BASE_SHA} round=2 diff=${CHANGE_DIGEST} outcome=request_changes -->`;
    const comments: GitHubComment[] = [106, 107].map((id, index) => ({
      id,
      body,
      created_at: `2026-10-10T1${index}:00:00.000Z`,
      updated_at: `2026-10-10T1${index}:00:00.000Z`,
      user: { id: 99, login: "review-app[bot]" },
    }));
    const history = parseRequestChangeHistory(comments, 321, 99);
    expect(history).toMatchObject({
      count: 2,
      latestDiffDigest: CHANGE_DIGEST,
      historyConsistent: true,
    });
    expect(history.diagnostics).toEqual([]);
  });

  it("reuses an App review only for the exact head, base, and requirement version", () => {
    const identity = {
      pullRequestNumber: 321,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      requirementDigest: REQUIREMENT_DIGEST,
    };
    const marker =
      `<!-- sayhear-pr-auto-approval-review:v2 pr=321 head=${HEAD_SHA} base=${BASE_SHA} requirement=${REQUIREMENT_DIGEST} outcome=approve -->`;

    expect(appReviewOutcomeForIdentity(marker, identity)).toBe("approve");
    expect(
      appReviewOutcomeForIdentity(
        marker.replace("outcome=approve -->", "outcome=approve_deferred -->"),
        identity,
      ),
    ).toBe("approve_deferred");
    expect(
      appReviewOutcomeForIdentity(marker, {
        ...identity,
        baseSha: "f".repeat(40),
      }),
    ).toBeNull();
    expect(
      appReviewOutcomeForIdentity(marker, {
        ...identity,
        requirementDigest: "e".repeat(64),
      }),
    ).toBeNull();
    expect(
      appReviewOutcomeForIdentity(
        `<!-- sayhear-pr-auto-approval-review:v1 outcome=approve -->`,
        identity,
      ),
    ).toBeNull();
  });
});


describe("stale main Issue handoff", () => {
  function fixture() {
    const pull = {
      number: 333, state: "open", draft: false, title: "Deliver #42 #43 #44 #45",
      body: "Closes #42. Closes #43. Closes #45. 本 PR 不关闭也不修改 #44。", base: { ref: "main", sha: BASE_SHA },
      head: { sha: HEAD_SHA, repo: { id: SAYHEAR_REPOSITORY_ID } }, auto_merge: null, mergeable: false,
    };
    let main = "f".repeat(40);
    const issues = new Map([42, 43, 44, 45].map((number) => [number, {
      number, state: number === 45 ? "closed" : "open", title: `Issue ${number}`, body: "Implement existing contract",
      labels: [{ name: "ongoing" }, { name: "bug" }],
    }]));
    const comments = new Map<number, GitHubComment[]>([333, 42, 43, 44, 45].map((n) => [n, []]));
    const writes: string[] = [];
    let commentActor = REVIEW_BOT_ACTOR_ID;
    let afterComment: (() => void) | undefined;
    let failLabel: number | undefined;
    let failCompletion = false;
    let beforeRead: (() => void) | undefined;
    const api = new StubApi((path, options) => {
      if (!options?.method || options.method === "GET") {
        if (path.endsWith("/pulls/333")) return structuredClone(pull);
        if (path.endsWith("/git/ref/heads/main")) return { object: { sha: main } };
        const number = Number(path.split("/").at(-1));
        if (issues.has(number)) { beforeRead?.(); return structuredClone(issues.get(number)); }
        throw new Error(`Unexpected read ${path}`);
      }
      const match = /\/issues\/(\d+)\/(comments|labels)(?:\/(.*))?$/.exec(path);
      if (!match) throw new Error(`Unexpected write ${path}`);
      const number = Number(match[1]);
      writes.push(`${options.method}:${number}:${match[2]}:${match[3] ?? ""}`);
      if (match[2] === "comments") {
        if (failCompletion && requestBody<{ body: string }>(options).body.includes("completed=true")) throw new Error("completion publication failed");
        comments.get(number)!.push(makeIssueComment(requestBody<{ body: string }>(options).body, commentActor));
        afterComment?.();
        return {};
      }
      if (failLabel === number) throw new Error("label write failed");
      // Labels may change only after the App comment was read back.
      expect(comments.get(number)!.some((c) => c.user.id === REVIEW_BOT_ACTOR_ID &&
        (c.body?.includes("sayhear-pr-base-sync:v1") === true ||
          c.body?.includes("sayhear-pr-conflict-handoff:v1") === true))).toBe(true);
      const issue = issues.get(number)!;
      if (options.method === "POST") {
        issue.labels.push(...requestBody<{ labels: string[] }>(options).labels.map((name) => ({ name })));
      } else {
        issue.labels = issue.labels.filter((label) => label.name !== decodeURIComponent(match[3]!));
      }
      return {};
    }, (path) => comments.get(Number(/\/issues\/(\d+)\/comments/.exec(path)?.[1])) ?? []);
    const expected = {
      number: pull.number, state: "open", draft: false, title: pull.title, body: pull.body,
      updatedAt: "2026-10-13T00:00:00Z", discussionDigest: "", externalReviewState: "clear",
      headSha: HEAD_SHA, baseSha: BASE_SHA, mergeSha: MERGE_SHA, baseRef: "main",
      mergeable: false,
      headRepositoryId: SAYHEAR_REPOSITORY_ID, authorId: 101, lastCommitAuthorId: 101,
      linkedIssueNumbers: [42, 43, 44, 45], keepOpenIssueNumbers: [44], issueClosureAmbiguous: false, closingIssueNumbers: [],
      pause: { active: false, source: "none" },
      changedFiles: [],
    } satisfies PrReviewGateInput["pullRequest"];
    return { api, expected, pull, issues, comments, writes,
      setMain: (sha: string) => { main = sha; },
      setCommentActor: (actor: number) => { commentActor = actor; },
      setAfterComment: (action: () => void) => { afterComment = action; },
      setFailLabel: (number: number) => { failLabel = number; },
      setFailCompletion: () => { failCompletion = true; },
      setBeforeRead: (action: () => void) => { beforeRead = action; },
    };
  }
  const actors = { botActorId: REVIEW_BOT_ACTOR_ID, ownerActorId: 101 };

  it("hands every open delivery Issue back after App comment readback, preserving exclusions and closed Issues", async () => {
    const f = fixture();
    expect(await handoffStalePullRequestBase(f.api, f.expected, actors)).toMatchObject({ status: "handed_off", issueNumbers: [42, 43] });
    for (const n of [42, 43]) {
      expect(f.issues.get(n)!.labels.map((l) => l.name).sort()).toEqual(["bug", "ready-for-agent"]);
      const body = f.comments.get(n)![0]!.body;
      expect(body).toContain(HEAD_SHA);
      expect(body).toContain(BASE_SHA);
      expect(body).toContain("f".repeat(40));
      expect(body).toContain("原 PR 和原分支");
      expect(parseRequestChangeHistory(f.comments.get(n)!, 333, REVIEW_BOT_ACTOR_ID).count).toBe(0);
    }
    expect(f.writes.some((w) => /:(44|45):/.test(w))).toBe(false);
  });

  it("hands a confirmed merge conflict to the original Issue owners without touching exclusions", async () => {
    const f = fixture();
    const result = await handoffStalePullRequestBase(f.api, f.expected, actors, {
      kind: "merge-conflict",
    });

    expect(result).toMatchObject({ status: "handed_off", issueNumbers: [42, 43] });
    expect(f.comments.get(42)![0]!.body).toContain("真实合并冲突");
    expect(f.comments.get(42)![0]!.body).toContain("sayhear-pr-conflict-handoff:v1");
    expect(f.comments.get(42)![0]!.body).not.toContain("尚未基于当前 main");
    expect(f.issues.get(42)!.labels.map((label) => label.name).sort()).toEqual([
      "bug",
      "ready-for-agent",
    ]);
    expect(f.writes.some((write) => /:(44|45):/.test(write))).toBe(false);
  });

  it("deduplicates repeated scans, but publishes a new instruction when main advances", async () => {
    const f = fixture();
    await handoffStalePullRequestBase(f.api, f.expected, actors);
    await handoffStalePullRequestBase(f.api, f.expected, actors);
    expect(f.comments.get(42)).toHaveLength(2);
    f.setMain("d".repeat(40));
    await handoffStalePullRequestBase(f.api, f.expected, actors);
    expect(f.comments.get(42)).toHaveLength(4);
  });

  it("preserves an Agent's new occupancy after a completed same-identity handoff", async () => {
    const f = fixture();
    await handoffStalePullRequestBase(f.api, f.expected, actors);
    f.issues.get(42)!.labels = [{ name: "bug" }, { name: "ongoing" }];
    const writesBefore = f.writes.length;
    await handoffStalePullRequestBase(f.api, f.expected, actors);
    expect(f.writes).toHaveLength(writesBefore);
    expect(f.issues.get(42)!.labels.map((l) => l.name)).toEqual(["bug", "ongoing"]);
    f.setMain("d".repeat(40));
    await handoffStalePullRequestBase(f.api, f.expected, actors);
    expect(f.issues.get(42)!.labels.map((l) => l.name)).toEqual(["bug", "ongoing"]);
    expect(f.writes.slice(writesBefore).some((w) => w.includes(":42:labels:"))).toBe(false);
  });

  it.each(["ready-for-human", "needs-info", "needs-triage", "wontfix"])("publishes the sync instruction but preserves %s", async (label) => {
    const f = fixture();
    f.issues.get(42)!.labels = [{ name: label }, { name: "bug" }];
    expect(await handoffStalePullRequestBase(f.api, f.expected, actors)).toMatchObject({ status: "held_for_human", heldIssueNumbers: [42], issueNumbers: [43] });
    expect(f.comments.get(42)).toHaveLength(1);
    expect(f.issues.get(42)!.labels.map((l) => l.name)).toEqual([label, "bug"]);
    expect(f.writes.some((w) => w.includes(":42:labels:"))).toBe(false);
  });

  it("preserves occupancy after completion publication fails and an Agent claims the Issue", async () => {
    const f = fixture(); f.setFailCompletion();
    await expect(handoffStalePullRequestBase(f.api, f.expected, actors)).rejects.toThrow("completion publication failed");
    f.issues.get(42)!.labels = [{ name: "ongoing" }, { name: "bug" }];
    await expect(handoffStalePullRequestBase(f.api, f.expected, actors)).rejects.toThrow("ongoing may be a new Agent claim");
    expect(f.issues.get(42)!.labels.map((l) => l.name)).toEqual(["ongoing", "bug"]);
  });

  it("does not delete a human label added at the label mutator's fresh read", async () => {
    const f = fixture(); let readsAfterComment = 0;
    f.setBeforeRead(() => {
      if (f.comments.get(42)!.length > 0 && ++readsAfterComment === 2) {
        f.issues.get(42)!.labels.push({ name: "ready-for-human" });
      }
    });
    await expect(handoffStalePullRequestBase(f.api, f.expected, actors)).rejects.toThrow("human triage state");
    expect(f.issues.get(42)!.labels.some((l) => l.name === "ready-for-human")).toBe(true);
    expect(f.writes.some((w) => w.includes(":42:labels:"))).toBe(false);
  });

  it("respects an authenticated maintainer pause before any write", async () => {
    const f = fixture();
    f.comments.get(42)!.push(makeIssueComment("/pause-pr-auto-approval", 101));
    expect((await handoffStalePullRequestBase(f.api, f.expected, actors)).status).toBe("held_for_human");
    expect(f.writes).toHaveLength(0);
  });

  it.each(["current", "changed", "hold", "ambiguous"])("does not write for %s context", async (kind) => {
    const f = fixture();
    if (kind === "current") f.setMain(BASE_SHA);
    if (kind === "changed") f.pull.head.sha = "d".repeat(40);
    if (kind === "hold") f.issues.get(42)!.body = "不要合入";
    if (kind === "ambiguous") { f.pull.body = "Do not close issues."; f.expected.body = f.pull.body; }
    expect((await handoffStalePullRequestBase(f.api, f.expected, actors)).status).toBe(
      kind === "current" ? "current_base" : kind === "changed" ? "state_changed" : "held_for_human",
    );
    expect(f.writes).toHaveLength(0);
  });

  it("does not release occupancy if the App comment cannot be confirmed", async () => {
    const f = fixture(); f.setCommentActor(101);
    await expect(handoffStalePullRequestBase(f.api, f.expected, actors)).rejects.toThrow("Issue updates incomplete");
    expect(f.writes.every((w) => w.includes(":comments:"))).toBe(true);
    expect(f.issues.get(42)!.labels.some((l) => l.name === "ongoing")).toBe(true);
  });

  it("stops labels when head or an Issue hold changes after comment publication", async () => {
    for (const changeHead of [true, false]) {
      const f = fixture();
      f.setAfterComment(() => {
        if (changeHead) f.pull.head.sha = "d".repeat(40);
        else f.issues.get(42)!.body = "暂停自动审批";
      });
      await expect(handoffStalePullRequestBase(f.api, f.expected, actors)).rejects.toThrow("Issue #42");
      expect(f.writes.some((w) => w.includes(":42:labels:"))).toBe(false);
      expect(f.issues.get(42)!.labels.some((l) => l.name === "ongoing")).toBe(true);
    }
  });

  it("continues other Issue handoffs and reports a partial label failure", async () => {
    const f = fixture(); f.setFailLabel(42);
    await expect(handoffStalePullRequestBase(f.api, f.expected, actors)).rejects.toThrow("Issue #42: label write failed");
    expect(f.issues.get(43)!.labels.map((l) => l.name).sort()).toEqual(["bug", "ready-for-agent"]);
    expect(f.issues.get(42)!.labels.some((l) => l.name === "ongoing")).toBe(true);
  });
});

describe("pre-merge deferral evidence collection", () => {
  const DEFERRABLE_CHECK_IDS = [
    "prompt-budget:effective-config-diff",
    "provider:effective-config-diff",
    "provider:affected-role-calls",
  ] as const;
  const MIGRATION_UPGRADE_CHECK = "migration:upgrade-compatibility";
  const COLLECTOR_RUN_ID = 555;
  const COLLECTOR_REVIEW_APP_ID = 98765;
  const WORKFLOW_BLOB_SHA = "f".repeat(40);
  const capability = {
    newCapabilityEnabled: false,
    majorContractChange: false,
    externalMvpRelease: false,
  };
  // A `provider-migration` declaration is advisory on its own: the provider
  // checks are planned only when an assessment bound to this exact diff says the
  // change actually affects provider behavior.
  const AFFECTED_PROVIDER = {
    context: {
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      diffDigest: CHANGE_DIGEST,
      diffComplete: true,
    },
    assessment: {
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      diffDigest: CHANGE_DIGEST,
      verdict: "affected" as const,
      rationale: "The diff rewrites the provider client construction path.",
      evidence: [{ file: "packages/ai/src/provider.ts", line: 1, before: "-old", after: "+new" }],
      missingEvidence: [] as string[],
    },
  };

  function storedZipArchiveWithZeroCrc(
    entries: readonly Readonly<{ name: string; content: Uint8Array }>[],
  ): Uint8Array {
    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let localOffset = 0;
    for (const entry of entries) {
      const nameBytes = Buffer.from(entry.name, "utf8");
      const size = entry.content.byteLength;
      const local = Buffer.alloc(30 + nameBytes.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt32LE(size, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      nameBytes.copy(local, 30);
      localParts.push(local, Buffer.from(entry.content));

      const central = Buffer.alloc(46 + nameBytes.length);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt32LE(size, 20);
      central.writeUInt32LE(size, 24);
      central.writeUInt16LE(nameBytes.length, 28);
      nameBytes.copy(central, 46);
      central.writeUInt32LE(localOffset, 42);
      centralParts.push(central);
      localOffset += local.length + size;
    }
    const central = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(localOffset, 16);
    return new Uint8Array(Buffer.concat([...localParts, central, end]));
  }

  function collector(options: {
    readonly reportPaths: readonly string[];
    readonly trustedRun?: boolean;
    readonly skippedPath?: string;
    readonly report?: unknown;
    readonly checkoutSha?: string;
    readonly integrationMode?: "up-to-date-base" | "merge-queue" | "serialized-merge";
    readonly checkoutReceipt?: boolean;
  }) {
    const reportBytes = Buffer.from(
      JSON.stringify(
        options.report ?? {
          success: true,
          testResults: options.reportPaths.map((path) => ({
            name: `/workspace/SayHear/${path}`,
            status: "passed",
            assertionResults: [{ status: path === options.skippedPath ? "pending" : "passed" }],
          })),
        },
      ),
      "utf8",
    );
    const checkoutBytes = Buffer.from(JSON.stringify({
      event: "pull_request",
      pullRequestNumber: 321,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      checkoutSha: options.checkoutSha ?? MERGE_SHA,
      parentShas: [BASE_SHA, HEAD_SHA],
      runId: COLLECTOR_RUN_ID,
      runAttempt: 1,
    }), "utf8");
    const archive = storedZipArchiveWithZeroCrc([
      { name: "vitest-report.json", content: new Uint8Array(reportBytes) },
      ...(options.checkoutReceipt === false
        ? []
        : [{ name: "pr-validate-source.json", content: new Uint8Array(checkoutBytes) }]),
    ]);
    const validateCheck = {
      id: 9001,
      name: "validate",
      app: { id: ACTIONS_APP_ID },
      head_sha: HEAD_SHA,
      details_url: `https://github.com/lukemyself-hub/SayHear/actions/runs/${COLLECTOR_RUN_ID}`,
      status: "completed",
      conclusion: "success",
    };
    const api = new StubApi(
      (path) => {
        if (path.includes("/check-runs")) {
          return { check_runs: options.trustedRun === false ? [] : [validateCheck] };
        }
        if (path.endsWith(`/actions/runs/${COLLECTOR_RUN_ID}`)) {
          return {
            id: COLLECTOR_RUN_ID,
            event: "pull_request",
            head_sha: HEAD_SHA,
            path: PR_VALIDATE_WORKFLOW_PATH,
            pull_requests: [
              { number: 321, head: { sha: HEAD_SHA }, base: { sha: BASE_SHA } },
            ],
            status: "completed",
            conclusion: "success",
            run_attempt: 1,
          };
        }
        if (path.includes("/contents/")) return { sha: WORKFLOW_BLOB_SHA };
        if (path.includes("/artifacts")) {
          return {
            artifacts: [
              {
                id: 77,
                name: "vitest-report-321",
                expired: false,
                digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
              },
            ],
          };
        }
        throw new Error(`Unexpected collector request ${path}`);
      },
      () => [],
      () => archive,
    );
    return {
      reportDigest: createHash("sha256").update(reportBytes).digest("hex"),
      config: {
        api,
        app: {
          appId: COLLECTOR_REVIEW_APP_ID,
          installationId: 1,
          slug: "sayhear-pr-review-gate",
          productionMergeAuthorized: false,
          ordinaryMergeTriggersProduction: false,
          ...(options.integrationMode === undefined
            ? {}
            : { integrationMode: options.integrationMode }),
        },
        policy: {
          repositoryId: SAYHEAR_REPOSITORY_ID,
          repositoryName: "lukemyself-hub/SayHear",
          defaultBranch: "main",
          policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
          reviewAppId: COLLECTOR_REVIEW_APP_ID,
          actionsAppId: ACTIONS_APP_ID,
          validateWorkflowBlobSha: WORKFLOW_BLOB_SHA,
        },
        botActorId: REVIEW_BOT_ACTOR_ID,
        ownerActorId: 101,
      },
    };
  }

  const pullRequest = {
    number: 321,
    state: "open",
    draft: false,
    title: "Deliver #42",
    body: "Fixes #42",
    updated_at: "2026-10-14T00:00:00Z",
    head: { sha: HEAD_SHA, repo: { id: SAYHEAR_REPOSITORY_ID } },
    base: { ref: "main", sha: BASE_SHA },
    user: { id: 101 },
    merge_commit_sha: MERGE_SHA,
    changed_files: 1,
  } as Parameters<typeof collectEvidence>[2];

  it("emits explicit deferrals for the registry checks that cannot run before merge", async () => {
    const { config } = collector({
      reportPaths: [
        "tests/runtime-config.test.ts",
        "tests/system/narrative-validation.system.test.ts",
        "tests/system/portal-acceptance.system.test.ts",
      ],
    });

    const collected = await collectEvidence(
      config,
      321,
      pullRequest,
      [{ path: "packages/ai/src/provider.ts", status: "modified" }],
      ["prompt-budget", "provider-migration"],
      capability,
      MERGE_SHA,
      BASE_SHA,
      undefined,
      AFFECTED_PROVIDER,
    );

    const byId = new Map(
      collected.evidence.map((entry) => [entry.checkId, entry]),
    );
    for (const checkId of DEFERRABLE_CHECK_IDS) {
      expect(byId.get(checkId)).toEqual({
        kind: "deferred-before-merge",
        checkId,
        policy: preMergeDeferralFor(checkId),
      });
    }
    expect(
      collected.evidence
        .filter((entry) => entry.kind === "deferred-before-merge")
        .map((entry) => entry.checkId)
        .sort(),
    ).toEqual([...DEFERRABLE_CHECK_IDS].sort());
    expect(byId.get("provider:privacy-checks")).toMatchObject({
      result: "passed",
    });
  });

  it.each([
    { checkoutSha: MERGE_SHA, result: "passed" },
    { checkoutSha: "f".repeat(40), result: "failed" },
  ])("binds otherwise valid head-bound CI to the tested checkout $checkoutSha", async ({ checkoutSha, result }) => {
    const { config } = collector({
      reportPaths: ["tests/runtime-config.test.ts"],
      checkoutSha,
      integrationMode: "serialized-merge",
    });
    const collected = await collectEvidence(
      config,
      321,
      pullRequest,
      [{ path: "packages/web/src/page.tsx", status: "modified" }],
      [],
      capability,
      MERGE_SHA,
      BASE_SHA,
    );

    expect(
      collected.evidence.find((entry) => entry.checkId === "baseline:test"),
    ).toMatchObject({ result });
    expect(
      collected.evidence.find((entry) => entry.checkId === "baseline:typecheck"),
    ).toMatchObject({ result });
  });

  it("keeps the pre-existing tolerance while base must still equal main", async () => {
    // A deployment that never opted into a head-bound mode must not start
    // demanding the merge-ref receipt: the accepted run metadata already pins
    // head and base, and the gate refuses a PR whose base is not main.
    const { config } = collector({
      reportPaths: ["tests/runtime-config.test.ts"],
      checkoutReceipt: false,
    });
    const collected = await collectEvidence(
      config,
      321,
      pullRequest,
      [{ path: "packages/web/src/page.tsx", status: "modified" }],
      [],
      capability,
      MERGE_SHA,
      BASE_SHA,
    );

    expect(
      collected.evidence.find((entry) => entry.checkId === "baseline:test"),
    ).toMatchObject({ result: "passed" });
    expect(
      collected.evidence.find((entry) => entry.checkId === "baseline:typecheck"),
    ).toMatchObject({ result: "passed" });
  });

  it("rejects green CI that carries no merge-ref receipt in a head-bound mode", async () => {
    const { config } = collector({
      reportPaths: ["tests/runtime-config.test.ts"],
      checkoutReceipt: false,
      integrationMode: "serialized-merge",
    });
    const collected = await collectEvidence(
      config,
      321,
      pullRequest,
      [{ path: "packages/web/src/page.tsx", status: "modified" }],
      [],
      capability,
      MERGE_SHA,
      BASE_SHA,
    );

    expect(
      collected.evidence.find((entry) => entry.checkId === "baseline:test"),
    ).toMatchObject({ result: "failed" });
    expect(
      collected.evidence.find((entry) => entry.checkId === "baseline:typecheck"),
    ).toMatchObject({ result: "failed" });
  });

  it("records the migration upgrade drill as digest-bound targeted evidence when the report covers its path", async () => {
    const { config, reportDigest } = collector({
      reportPaths: [
        "tests/ci/migration-upgrade-compatibility.test.ts",
        "tests/system/g1-purge-restore-drill.system.test.ts",
        "tests/system/owner-full-purge.system.test.ts",
      ],
    });

    const collected = await collectEvidence(
      config,
      321,
      pullRequest,
      [{ path: "packages/data/migrations/0099_add_column.sql", status: "added" }],
      [],
      capability,
      MERGE_SHA,
      BASE_SHA,
    );

    expect(
      collected.evidence.find(
        (entry) => entry.checkId === MIGRATION_UPGRADE_CHECK,
      ),
    ).toEqual({
      checkId: MIGRATION_UPGRADE_CHECK,
      result: "passed",
      source: expect.objectContaining({ runId: COLLECTOR_RUN_ID }),
      artifactSha256: reportDigest,
      coveredCheckIds: [MIGRATION_UPGRADE_CHECK],
    });
    expect(
      collected.evidence.some((entry) => entry.kind === "deferred-before-merge"),
    ).toBe(false);
  });

  it("keeps the migration upgrade drill blocking when the report does not cover its path", async () => {
    const { config } = collector({ reportPaths: ["tests/runtime-config.test.ts"] });

    const collected = await collectEvidence(
      config,
      321,
      pullRequest,
      [{ path: "packages/data/migrations/0099_add_column.sql", status: "added" }],
      [],
      capability,
      MERGE_SHA,
      BASE_SHA,
    );

    expect(
      collected.evidence.find(
        (entry) => entry.checkId === MIGRATION_UPGRADE_CHECK,
      ),
    ).toMatchObject({
      result: "failed",
      artifactSha256: null,
      coveredCheckIds: [],
    });
    expect(
      collected.evidence.some((entry) => entry.kind === "deferred-before-merge"),
    ).toBe(false);
  });

  it("refuses migration evidence when its Vitest assertion was skipped", async () => {
    const migrationPath = "tests/ci/migration-upgrade-compatibility.test.ts";
    const { config } = collector({
      reportPaths: [migrationPath],
      skippedPath: migrationPath,
    });
    const collected = await collectEvidence(
      config, 321, pullRequest,
      [{ path: "packages/data/migrations/0099_add_column.sql", status: "added" }],
      [], capability, MERGE_SHA, BASE_SHA,
    );
    expect(collected.evidence.find((entry) => entry.checkId === MIGRATION_UPGRADE_CHECK)).toMatchObject({
      result: "failed",
      artifactSha256: null,
      coveredCheckIds: [],
    });
  });

  it("refuses a Vitest report with no test results instead of passing vacuously", async () => {
    const { config } = collector({
      reportPaths: [],
      report: { success: true, testResults: [] },
    });
    const collected = await collectEvidence(
      config, 321, pullRequest, [], [], capability, MERGE_SHA, BASE_SHA,
    );
    expect(
      collected.evidence.find((entry) => entry.checkId === "baseline:test"),
    ).toMatchObject({ result: "failed" });
  });

  it("refuses a Vitest test result with no assertions instead of passing vacuously", async () => {
    const { config } = collector({
      reportPaths: [],
      report: {
        success: true,
        testResults: [
          {
            name: "/workspace/SayHear/tests/runtime-config.test.ts",
            status: "passed",
            assertionResults: [],
          },
        ],
      },
    });
    const collected = await collectEvidence(
      config, 321, pullRequest, [], [], capability, MERGE_SHA, BASE_SHA,
    );
    expect(
      collected.evidence.find((entry) => entry.checkId === "baseline:test"),
    ).toMatchObject({ result: "failed" });
  });

  it("never defers without a trusted workflow run on the same head", async () => {
    const { config } = collector({ reportPaths: [], trustedRun: false });

    const collected = await collectEvidence(
      config,
      321,
      pullRequest,
      [{ path: "packages/ai/src/provider.ts", status: "modified" }],
      ["prompt-budget", "provider-migration"],
      capability,
      MERGE_SHA,
      BASE_SHA,
      undefined,
      AFFECTED_PROVIDER,
    );

    expect(collected.evidence.map((entry) => entry.checkId)).toEqual(
      expect.arrayContaining([...DEFERRABLE_CHECK_IDS]),
    );
    expect(
      collected.evidence.every(
        (entry) =>
          entry.kind !== "deferred-before-merge" && entry.result === "skipped",
      ),
    ).toBe(true);
  });

  it("reads the Issues GitHub would close on merge and fails closed when it cannot", async () => {
    const localRepo = "lukemyself-hub/SayHear";
    const local = (number: number, nameWithOwner: unknown = localRepo) =>
      ({ number, repository: { nameWithOwner } });
    const graph = (closing: unknown) =>
      new StubApi((path) => {
        if (path !== "/graphql") throw new Error(`Unexpected request ${path}`);
        return { data: { repository: { pullRequest: { closingIssuesReferences: closing } } } };
      });

    await expect(readClosingIssueReferences(
      graph({ nodes: [local(301), local(322)], pageInfo: { hasNextPage: false } }), 333,
    )).resolves.toEqual([301, 322]);
    await expect(readClosingIssueReferences(
      graph({ nodes: [], pageInfo: { hasNextPage: false } }), 333,
    )).resolves.toEqual([]);
    await expect(readClosingIssueReferences(
      graph({ nodes: [local(301)], pageInfo: { hasNextPage: true } }), 333,
    )).resolves.toBeNull();
    await expect(readClosingIssueReferences(graph({ nodes: [{}] }), 333)).resolves.toBeNull();
    await expect(readClosingIssueReferences(graph(undefined), 333)).resolves.toBeNull();
    await expect(readClosingIssueReferences(
      new StubApi(() => ({ errors: [{ message: "denied" }] })), 333,
    )).resolves.toBeNull();
  });

  it("keeps only same-repository native closing references", async () => {
    const localRepo = "lukemyself-hub/SayHear";
    const local = (number: number, nameWithOwner: unknown = localRepo) =>
      ({ number, repository: { nameWithOwner } });
    const foreign = (number: number) =>
      ({ number, repository: { nameWithOwner: "other/repo" } });
    const graph = (closing: unknown) =>
      new StubApi((path) => {
        if (path !== "/graphql") throw new Error(`Unexpected request ${path}`);
        return { data: { repository: { pullRequest: { closingIssuesReferences: closing } } } };
      });

    // A foreign node with the same number must not leak into the local set.
    await expect(readClosingIssueReferences(
      graph({ nodes: [local(42), foreign(42), foreign(99)], pageInfo: { hasNextPage: false } }), 333,
    )).resolves.toEqual([42]);
    // All foreign means an empty local set, not unknown.
    await expect(readClosingIssueReferences(
      graph({ nodes: [foreign(42)], pageInfo: { hasNextPage: false } }), 333,
    )).resolves.toEqual([]);
    // Repository matching is case-insensitive.
    await expect(readClosingIssueReferences(
      graph({ nodes: [local(301, "LUKEMyself-HUB/sayhear")], pageInfo: { hasNextPage: false } }), 333,
    )).resolves.toEqual([301]);
    // Missing or malformed repository metadata is unknown, never trusted.
    for (const node of [{ number: 301 }, { number: 301, repository: null },
      { number: 301, repository: {} }, { number: 301, repository: { nameWithOwner: null } },
      { number: 301, repository: { nameWithOwner: "" } },
      { number: 301, repository: { nameWithOwner: "   " } },
      { number: 301, repository: { nameWithOwner: "SayHear" } },
      { number: 301, repository: { nameWithOwner: "lukemyself-hub/SayHear/extra" } },
      { number: 301, repository: { nameWithOwner: "luke myself/SayHear" } },
      { number: 301, repository: { nameWithOwner: 42 } }]) {
      await expect(readClosingIssueReferences(
        graph({ nodes: [node], pageInfo: { hasNextPage: false } }), 333,
      )).resolves.toBeNull();
    }
    // A same-repository invalid number is still unknown.
    for (const node of [local(0), local(-3), { number: "301", repository: { nameWithOwner: localRepo } }]) {
      await expect(readClosingIssueReferences(
        graph({ nodes: [node], pageInfo: { hasNextPage: false } }), 333,
      )).resolves.toBeNull();
    }
  });

  it.each([AGENT_IDENTITY, { id: 1, login: "unknown", type: "User" }])(
    "blocks deferred merge when the latest author is outside the legacy root channel",
    async (user) => {
      const { config } = collector({ reportPaths: [] });
      const calls: string[] = [];
      const api = new StubApi((path) => {
        calls.push(path);
        throw new Error("A non-root author cannot request deferred merge.");
      });
      const result = await requestDeferredMerge(
        { ...config, api },
        modelReport,
        { outcome: "merge_candidate_with_deferrals", deferredEvidence: [] },
        { allow_merge_commit: true },
        { ...pullRequest, user },
      );
      expect(result.outcome).toBe("human_decision");
      expect(calls).toEqual([]);
    },
  );

  it.each([true, false])(
    "merges a legacy root deferral without completion or Issue writes when mergeable=%s",
    async (mergeable) => {
      const { config } = collector({ reportPaths: [] });
      const mutations: string[] = [];
      const api = new StubApi((path, options) => {
        if (path === "/graphql" && options?.method === "POST") {
          mutations.push(path);
          return { data: { enablePullRequestAutoMerge: { pullRequest: { number: 321 } } } };
        }
        if (path.endsWith("/pulls/321/merge") && options?.method === "PUT") {
          mutations.push(path);
          return { merged: true };
        }
        if (path.endsWith("/pulls/321") && options?.method === undefined) {
          return { ...pullRequest, auto_merge: { enabled: true } };
        }
        throw new Error(`Unexpected deferred merge write ${path}`);
      });
      const completionStore = {
        list: async () => { throw new Error("Deferred merge must not list completion records."); },
        read: async () => { throw new Error("Deferred merge must not read a completion record."); },
        save: async () => { throw new Error("Deferred merge must not save a completion record."); },
      };
      const result = await requestDeferredMerge(
        { ...config, api, completionStore },
        modelReport,
        {
          outcome: "merge_candidate_with_deferrals",
          deferredEvidence: [{
            checkId: "provider:effective-config-diff",
            reason: "requires-deployed-effective-configuration",
            followUp: { stage: "acceptance", command: "pnpm release:config:compare" },
          }],
        },
        { allow_merge_commit: true },
        { ...pullRequest, user: LUKE_IDENTITY, node_id: "PR_321", mergeable, mergeable_state: "clean" },
      );
      expect(result.outcome).toBe("merge_candidate_with_deferrals");
      expect(mutations).toEqual([mergeable ? "/repos/lukemyself-hub/SayHear/pulls/321/merge" : "/graphql"]);
    },
  );
});

/**
 * Provider-behavior and behavior-scope assessments bound to the exact diff the
 * fixture produced.
 *
 * The shared parsers and resolvers still decide whether each one holds: these
 * carry the live head, base, and diff digest, so a fixture that drifts from the
 * snapshot fails closed instead of being waved through.
 */
function boundModelJudgments(
  diffDigest: string,
  changedFiles: readonly Readonly<{ path: string; status: "added" | "modified" | "removed" | "renamed" | "copied" }>[],
  identity: Readonly<{ headSha: string; baseSha: string }> = { headSha: HEAD_SHA, baseSha: BASE_SHA },
) {
  const observations = changedFiles.map((file) => ({
    file: file.path,
    line: 1,
    before: "-old",
    after: "+new",
  }));
  return {
    providerBehavior: {
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      diffDigest,
      verdict: "unaffected" as const,
      rationale:
        "The changed approval controller code touches no model provider call, prompt, role mapping, or model configuration.",
      evidence: observations,
      missingEvidence: [] as string[],
    },
    behaviorScope: {
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      diffDigest,
      verdict: "in-scope" as const,
      runtimeImpact: "none" as const,
      rationale:
        "The diff stays inside the PR approval apparatus and changes no product runtime behavior.",
      evidence: observations,
      contractRefs: ["docs/agents/pr-auto-approval.md"],
      missingEvidence: [] as string[],
    },
  };
}

class ControllerBrowserStore implements BrowserApprovalStore {
  value: BrowserState | null = null;
  async read() { return this.value; }
  async save(value: BrowserState) { this.value = structuredClone(value); }
}

async function serializedControllerFixture(channel: "browser" | "legacy-root", options: Readonly<{ linkedIssue?: boolean; bodySuffix?: string; issueTitle?: string; backgroundOnly?: boolean; secondIssue?: boolean }> = {}) {
  const linkedIssue = options.linkedIssue !== false;
  // backgroundOnly references #42 without delivering it (no closing keyword or
  // Development link). secondIssue additionally delivers #43.
  const backgroundOnly = options.backgroundOnly === true;
  const deliversSecondIssue = options.secondIssue === true;
  const workflow = "f".repeat(40);
  const path = "scripts/pr-approval-controller.ts";
  const diff = `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
  const changedFile = { filename: path, sha: "2".repeat(40), status: "modified", additions: 1, deletions: 1 };
  const pull = {
    number: 321, node_id: "PR_321", state: "open" as "open" | "closed", merged: false, draft: false,
    title: "Controller safety repair", body: `${backgroundOnly ? "See #42 for context." : linkedIssue ? (deliversSecondIssue ? "Fixes #42. Fixes #43." : "Fixes #42") : "Tidy controller wording."}${options.bodySuffix ?? ""}`, updated_at: "2026-10-14T00:00:00Z",
    head: { sha: HEAD_SHA, repo: { id: SAYHEAR_REPOSITORY_ID } },
    base: { sha: BASE_SHA, ref: "main", repo: { id: SAYHEAR_REPOSITORY_ID } },
    user: channel === "browser" ? AGENT_IDENTITY : LUKE_IDENTITY,
    merge_commit_sha: MERGE_SHA, changed_files: 1, mergeable: true, mergeable_state: "clean", auto_merge: null,
  };
  const issue = { number: 42, state: "open", title: options.issueTitle ?? "Controller safety repair", body: "Deliver safe serialized integration and durable recovery.",
    updated_at: "2026-10-14T00:00:00Z", labels: ["ongoing"] };
  const issue43 = { number: 43, state: "open", title: "Second delivered requirement", body: "Preserve the second contract.",
    updated_at: "2026-10-14T00:00:00Z", labels: ["ongoing"] };
  const browserApprovalStore = new ControllerBrowserStore();
  const comments = new Map<number, GitHubComment[]>([42, 43, 321].map((number) => [number, []]));
  const reviews: Array<Record<string, unknown>> = [];
  const reviewChecks: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  const prLabels: string[] = [];
  const repositoryLabels = new Set<string>();
  let refreshRecord: IntegrationRefreshRecord | null = null;
  let newerQueued = false;
  let main = BASE_SHA;
  let validatedMain = BASE_SHA;
  let validatedMerge = MERGE_SHA;
  let validationConclusion = "success";
  let mergeError: unknown;
  let mergedCommitSha: string | null = null;
  const trees = new Map<string, string>();
  let finalMainDrift = false;
  let mainReads = 0;
  let beforeFinalMainRead: (() => void) | undefined;
  const reviewRules: Record<string, unknown> = { dismiss_stale_reviews: true, required_approving_review_count: 1 };
  const additionalRulesets: Record<string, unknown>[] = [];
  const writerRuleset = { id: 9, target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "update" }, { type: "non_fast_forward" }], updated_at: "2026-10-14T21:00:00.000Z",
    bypass_actors: [{ actor_id: 98765, actor_type: "Integration", bypass_mode: "always" }], current_user_can_bypass: "always" };
  let bypassVisible = true;
  const validationArchive = () => storedZipArchive([
    { name: "vitest-report.json", content: Buffer.from(JSON.stringify({ success: true, testResults: [
      { name: "/workspace/tests/pr-approval-controller.test.ts", status: "passed", assertionResults: [{ status: "passed" }] },
    ] })) },
    { name: "pr-validate-source.json", content: Buffer.from(JSON.stringify({ event: "pull_request", pullRequestNumber: 321,
      headSha: HEAD_SHA, baseSha: BASE_SHA, checkoutSha: validatedMerge, parentShas: [validatedMain, HEAD_SHA], runId: 555, runAttempt: 1 })) },
  ]);
  const repository = { id: SAYHEAR_REPOSITORY_ID, node_id: "R_SayHear", full_name: "lukemyself-hub/SayHear", default_branch: "main" };
  const api = new StubApi((url, options) => {
    if (options?.method && options.method !== "GET" &&
        (url !== "/graphql" || /^\s*mutation\b/.test(requestBody<{ query: string }>(options).query))) {
      writes.push(`${options.method} ${url}`);
    }
    if (url === "/graphql") return { data: { repository: {
      autoMergeAllowed: true, mergeCommitAllowed: true, squashMergeAllowed: false, rebaseMergeAllowed: false,
      pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } }, closingIssuesReferences: { nodes: linkedIssue && !backgroundOnly ? [{ number: 42, repository: { nameWithOwner: "lukemyself-hub/SayHear" } }, ...(deliversSecondIssue ? [{ number: 43, repository: { nameWithOwner: "lukemyself-hub/SayHear" } }] : [])] : [], pageInfo: { hasNextPage: false } } },
      issue: { blockedBy: { nodes: [], pageInfo: { hasNextPage: false } } },
    } } };
    if (url === "/repos/lukemyself-hub/SayHear") return structuredClone(repository);
    if (url.endsWith("/branches/main/protection")) return { required_status_checks: { strict: false, checks: [
      { context: "validate", app_id: ACTIONS_APP_ID }, { context: "pr-review-gate", app_id: 98765 },
    ] }, required_pull_request_reviews: structuredClone(reviewRules), enforce_admins: { enabled: true } };
    if (url.includes("/rulesets/9?")) {
      if (bypassVisible) return structuredClone(writerRuleset);
      const { bypass_actors: _bypass, ...hidden } = writerRuleset;
      return structuredClone(hidden);
    }
    const extraRuleset = additionalRulesets.find((ruleset) => url.includes(`/rulesets/${ruleset.id}?`));
    if (extraRuleset) return structuredClone(extraRuleset);
    if (url.endsWith("/git/ref/heads/main")) {
      mainReads++;
      if (mainReads === 3) beforeFinalMainRead?.();
      return { object: { sha: finalMainDrift && mainReads > 2 ? "8".repeat(40) : main } };
    }
    // The merge ref exists even when the PR payload omits merge_commit_sha.
    if (url.endsWith("/git/ref/pull/321/merge")) return { ref: "refs/pull/321/merge", object: { type: "commit", sha: pull.merge_commit_sha ?? MERGE_SHA } };
    if (url.includes("/git/commits/")) {
      const sha = url.split("/").at(-1) ?? "";
      return { sha, tree: { sha: trees.get(sha) ?? "e".repeat(40) },
        parents: [{ sha: url.endsWith(validatedMerge) ? validatedMain : main }, { sha: HEAD_SHA }] };
    }
    if (url.includes("/contents/")) return { sha: workflow };
    if (url.includes("/check-runs?")) return { check_runs: [
      { id: 9001, name: "validate", app: { id: ACTIONS_APP_ID }, head_sha: HEAD_SHA,
        details_url: "https://github.com/lukemyself-hub/SayHear/actions/runs/555", status: "completed", conclusion: validationConclusion }, ...reviewChecks,
    ] };
    if (url.endsWith("/actions/runs/556") && newerQueued) return { id: 556, run_attempt: 1, event: "pull_request", status: "queued", conclusion: null,
      head_sha: HEAD_SHA, path: PR_VALIDATE_WORKFLOW_PATH, pull_requests: [{ number: 321, head: { sha: HEAD_SHA }, base: { sha: BASE_SHA } }] };
    if (url.endsWith("/actions/runs/555")) return { id: 555, run_attempt: 1, event: "pull_request", status: "completed", conclusion: validationConclusion,
      head_sha: HEAD_SHA, path: PR_VALIDATE_WORKFLOW_PATH, pull_requests: [{ number: 321, head: { sha: HEAD_SHA }, base: { sha: BASE_SHA } }] };
    if (url.includes("/artifacts?")) return { artifacts: [{ id: 77, name: "vitest-report-321", expired: false,
      digest: `sha256:${createHash("sha256").update(validationArchive()).digest("hex")}` }] };
    if (url.includes("/labels/ci-int%3A")) {
      const label = decodeURIComponent(url.split("/").at(-1) ?? "");
      if (!repositoryLabels.has(label)) throw new GitHubApiError(404, "GET", url);
      return { name: label };
    }
    if (url.endsWith("/SayHear/labels") && options?.method === "POST") {
      const body = requestBody<{ name: string }>(options); repositoryLabels.add(body.name); return { name: body.name };
    }
    if (url.endsWith("/issues/321/labels") && options?.method === "POST") {
      prLabels.push(...requestBody<{ labels: string[] }>(options).labels); return prLabels.map((name) => ({ name }));
    }
    if (url.endsWith("/pulls/321/merge")) {
      if (mergeError) throw mergeError;
      expect(options?.body).toEqual({ sha: HEAD_SHA, merge_method: "merge" });
      pull.state = "closed"; pull.merged = true;
      if (mergedCommitSha) pull.merge_commit_sha = mergedCommitSha;
      return { merged: true };
    }
    if (url.endsWith("/pulls/321")) return structuredClone(pull);
    // Issue conversation comments (PR conversation included) so the durable
    // review markers persist and read back exactly as GitHub would keep them.
    const commentWrite = /\/issues\/(\d+)\/comments$/.exec(url);
    if (commentWrite && options?.method === "POST") {
      const number = Number(commentWrite[1]);
      comments.get(number)!.push(makeIssueComment(requestBody<{ body: string }>(options).body));
      return {};
    }
    if (url.endsWith("/issues/42/labels/ongoing") && options?.method === "DELETE") {
      issue.labels = issue.labels.filter((label) => label !== "ongoing");
      return [];
    }
    if (url.endsWith("/issues/42/labels") && options?.method === "POST") {
      issue.labels.push(...requestBody<{ labels: string[] }>(options).labels);
      return issue.labels.map((name) => ({ name }));
    }
    if (url.endsWith("/issues/42")) {
      if (options?.method === "PATCH") issue.state = "closed";
      return structuredClone(issue);
    }
    // The PR conversation is also an issue endpoint on GitHub: the review
    // handoff publishes the durable marker there and flips its labels.
    if (url.endsWith("/issues/321")) {
      if (!options?.method || options?.method === "GET") {
        return { number: 321, state: "open", labels: prLabels.map((name) => ({ name })) };
      }
    }
    if (url.includes("/issues/321/labels/") && options?.method === "DELETE") {
      const name = decodeURIComponent(url.split("/").at(-1) ?? "");
      const index = prLabels.indexOf(name);
      if (index >= 0) prLabels.splice(index, 1);
      return [];
    }
    if (deliversSecondIssue && url.endsWith("/issues/43/labels/ongoing") && options?.method === "DELETE") { issue43.labels = []; return []; }
    if (deliversSecondIssue && url.endsWith("/issues/43")) {
      if (options?.method === "PATCH") issue43.state = "closed";
      return structuredClone(issue43);
    }
    throw new Error(`Unexpected controller request ${url}`);
  }, (url) => {
    if (url.includes("/rulesets?")) return [{ id: 9 }, ...additionalRulesets.map(({ id }) => ({ id }))];
    if (url.endsWith("/pulls?state=open")) return [structuredClone(pull)];
    if (url.endsWith("/pulls/321/files")) return [changedFile];
    if (url.endsWith("/pulls/321/commits")) return [{ author: { id: 101 }, committer: { id: 101 }, commit: { message: "Implement safety" } }];
    if (url.endsWith("/issues/321/labels")) return prLabels.map((name) => ({ name }));
    if (url.endsWith("/pulls/321/reviews")) return reviews;
    const commentPage = /\/issues\/(\d+)\/comments$/.exec(url);
    if (commentPage) return structuredClone(comments.get(Number(commentPage[1]))!);
    if (url.endsWith("/comments")) return [];
    throw new Error(`Unexpected controller page ${url}`);
  });
  api.bytes = async (url) => url.includes("/compare/") ? Buffer.from(diff) : validationArchive();
  const app: Parameters<typeof readHumanBinding>[0]["app"] = {
    appId: 98765, installationId: 1, slug: "sayhear-pr-review-gate", productionMergeAuthorized: true,
    ordinaryMergeTriggersProduction: true, integrationMode: "serialized-merge", humanReviewAuthorizations: [],
  };
  let stored: CompletionRecord | null = null;
  const config: Parameters<typeof readSnapshot>[0] = { api, app, browserApprovalStore,
    integrationRefreshStore: { read: async () => refreshRecord, save: async (value) => { refreshRecord = value; } },
    completionStore: { read: async () => stored, list: async () => stored ? [stored] : [], save: async (value) => { stored = structuredClone(value); } },
    policy: { repositoryId: SAYHEAR_REPOSITORY_ID, repositoryName: "lukemyself-hub/SayHear", defaultBranch: "main",
      policyVersion: PR_REVIEW_GATE_POLICY_VERSION, reviewAppId: 98765, actionsAppId: ACTIONS_APP_ID, validateWorkflowBlobSha: null },
    botActorId: REVIEW_BOT_ACTOR_ID, ownerActorId: LUKE_IDENTITY.id,
  };
  const frozen = await readSnapshot(config, 321, [], undefined, { freezeBrowserChallenge: true });
  const digest = requirementDigest(frozen.gateInput.issues, frozen.gateInput.pullRequest);
  if (channel === "browser") {
    const challenge = browserApprovalStore.value?.challenge;
    if (!challenge) throw new Error("Expected frozen browser challenge");
    reviews.push({ id: 10, state: "APPROVED", body: "Approved", commit_id: HEAD_SHA, user: LUKE_IDENTITY,
      submitted_at: new Date(challenge.frozenAt + 1_000).toISOString() });
  }
  const rootAuthorization = { pullRequestNumber: 321, approvedHeadSha: HEAD_SHA, approvedBaseSha: BASE_SHA,
    diffDigest: frozen.diff.digest, requirementDigest: digest, paths: [path], noRuntimeImpact: true,
    validateWorkflowBlobSha: workflow, approvedAt: "2026-10-14T00:00:00Z" };
  const activeConfig = channel === "legacy-root" ? { ...config, app: { ...app, humanReviewAuthorizations: [rootAuthorization] } } : config;
  const report: ModelReviewReport = { ...modelReport, baseSha: BASE_SHA, requirementDigest: digest, declaredImpacts: [],
    ...boundModelJudgments(frozen.diff.digest, [{ path, status: "modified" }]) };
  const externalId = `sayhear-pr-review:321:${HEAD_SHA}:${BASE_SHA}:${digest}`;
  reviewChecks.push({ id: 9002, name: "pr-review-gate", app: { id: 98765 }, status: "completed", external_id: externalId,
    output: { summary: `<!-- sayhear-pr-auto-approval-state:v1 pr=321 head=${HEAD_SHA} base=${BASE_SHA} requirement=${digest} diff=${frozen.diff.digest} change=${frozen.diff.changeDigest} evidence=${"0".repeat(64)} outcome=merge_candidate report=${Buffer.from(JSON.stringify(report)).toString("base64url")} -->` } });
  reviews.push({ id: 20, state: "APPROVED", commit_id: HEAD_SHA, user: { id: REVIEW_BOT_ACTOR_ID, login: "sayhear-pr-review-gate[bot]" },
    body: `<!-- sayhear-pr-auto-approval-review:v2 pr=321 head=${HEAD_SHA} base=${BASE_SHA} requirement=${digest} outcome=approve -->` });
  // Materializing the receipt uses the same live browser binding as submission.
  const bound = await readSnapshot(activeConfig, 321);
  const delivered = linkedIssue && !backgroundOnly ? [42, ...(deliversSecondIssue ? [43] : [])] : [];
  const receipt: CompletionRecord = { version: delivered.length > 0 ? 1 : 2, phase: "merge_unconfirmed", attempts: 0, nextRetryAt: 0, reason: null, mergeSha: null, mergeWriteState: "not-sent",
    identity: { repositoryId: SAYHEAR_REPOSITORY_ID, pullRequestNumber: 321, pullRequestNodeId: "PR_321", headSha: HEAD_SHA,
      approvedBaseSha: BASE_SHA, requirementDigest: digest, baseRepositoryId: SAYHEAR_REPOSITORY_ID, baseRef: "main", botActorId: REVIEW_BOT_ACTOR_ID,
      reviewId: 20, appId: 98765, policyVersion: PR_REVIEW_GATE_POLICY_VERSION, issueNumbers: delivered, integrationMode: "serialized-merge",
      humanChannel: channel === "browser" ? "browser" : "app", humanReviewId: channel === "browser" ? 10 : 20,
      ...(bound.humanBinding.receipt?.challenge.context.liveness ? { humanLiveness: bound.humanBinding.receipt.challenge.context.liveness } : {}),
      epoch: bound.humanBinding.receipt?.challenge.epoch ?? null, mergeAction: "merge-now",
      reviewIdentity: { diffDigest: frozen.diff.digest, changeDigest: frozen.diff.changeDigest, workflowBlobSha: workflow } } };
  const clock = { now: () => 1_000_000, sleep: async () => {}, random: () => 0 };
  return { config: activeConfig, receipt, api, pull, issue, secondIssue: deliversSecondIssue ? issue43 : null, reviews, reviewChecks, comments, browserApprovalStore, rootAuthorization, clock, writes, writerRuleset, additionalRulesets, reviewRules,
    hideBypass: (): MainWriterAttestation => {
      bypassVisible = false;
      return { version: MAIN_WRITER_ATTESTATION_VERSION, rulesetId: writerRuleset.id,
        rulesetFingerprint: fingerprintRuleset(writerRuleset), assertedBypassAppIds: [98765],
        attestedAt: "2026-10-15T00:00:00.000Z", attestedBy: "test" };
    },
    stored: () => stored,
    advanceMain: (freshCi = true, nextMain = "9".repeat(40)) => { main = nextMain; pull.merge_commit_sha = "7".repeat(40);
      if (freshCi) { validatedMain = main; validatedMerge = pull.merge_commit_sha; } },
    failValidation: () => { validationConclusion = "failure"; },
    queueNewerValidation: () => { newerQueued = true; reviewChecks.push({ id: 9003, name: "validate", app: { id: ACTIONS_APP_ID }, head_sha: HEAD_SHA,
      details_url: "https://github.com/lukemyself-hub/SayHear/actions/runs/556", status: "queued", conclusion: null }); },
    driftFinalMain: () => { mainReads = 0; finalMainDrift = true; },
    beforeFinalRead: (change: () => void) => { mainReads = 0; beforeFinalMainRead = change; },
    failMerge: (error: unknown) => { mergeError = error; },
    trees,
    mergeAs: (sha: string) => { mergedCommitSha = sha; },
  };
}

describe("guarded serialized controller completion", () => {
  it.each(["writer", "second"] as const)("rejects blocked merge with required signatures in the %s ruleset", async (location) => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = "blocked";
    if (location === "writer") f.writerRuleset.rules.push({ type: "required_signatures" });
    else f.additionalRulesets.push({ ...structuredClone(f.writerRuleset), id: 10, rules: [{ type: "required_signatures" }] });
    const pending = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(pending).toMatchObject({ phase: "merge_unconfirmed", mergeWriteState: "not-sent" });
    expect(f.writes).toEqual([]);
  });

  it("rejects an extra writer rule even with a current matching attestation", async () => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = "blocked";
    f.writerRuleset.rules.push({ type: "required_signatures" });
    const config = { ...f.config, mainWriterAttestation: f.hideBypass() };
    await expect(guardImmediateMerge(config, f.receipt.identity)).rejects.toThrow("blocked_merge_protections_unproven");
    expect(f.writes).toEqual([]);
  });

  it.each(["required_deployments", "pull_request", "required_status_checks", "code_scanning", "future_rule"])(
    "rejects blocked merge with an additional %s rule", async (type) => {
      const f = await serializedControllerFixture("legacy-root");
      f.pull.mergeable_state = "blocked";
      f.additionalRulesets.push({ ...structuredClone(f.writerRuleset), id: 10, rules: [{ type }] });
      const pending = await recoverControllerCompletion(f.config, f.receipt, f.clock);
      expect(pending).toMatchObject({ phase: "merge_unconfirmed", mergeWriteState: "not-sent", reason: "blocked_merge_protections_unproven" });
      expect(f.writes).toEqual([]);
    },
  );

  describe.each(["update", "non_fast_forward"])("%s rule parameters", (type) => {
    it.each([{ unknown: true }, { update_allows_fetch_and_merge: true }, null, [], "invalid", 1, false])(
      "rejects unsupported or malformed parameters %j", async (parameters) => {
        const f = await serializedControllerFixture("browser");
        f.pull.mergeable_state = "blocked";
        f.additionalRulesets.push({ ...structuredClone(f.writerRuleset), id: 10, rules: [{ type, parameters }] });
        await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("blocked_merge_protections_unproven");
        expect(f.writes).toEqual([]);
      },
    );

    it("accepts empty parameters", async () => {
      const f = await serializedControllerFixture("browser");
      f.pull.mergeable_state = "blocked";
      Object.assign(f.writerRuleset.rules.find((rule) => rule.type === type)!, { parameters: {} });
      await expect(guardImmediateMerge(f.config, f.receipt.identity)).resolves.toMatchObject({ pullRequest: { mergeable_state: "blocked" } });
      expect(f.writes).toEqual([]);
    });
  });

  it("accepts the documented update parameter only when fetch and merge is disallowed", async () => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = "blocked";
    Object.assign(f.writerRuleset.rules.find((rule) => rule.type === "update")!, { parameters: { update_allows_fetch_and_merge: false } });
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).resolves.toMatchObject({ pullRequest: { mergeable_state: "blocked" } });
    expect(f.writes).toEqual([]);
  });

  it.each([
    ["update", { update_allows_fetch_and_merge: "false" }],
    ["update", { update_allows_fetch_and_merge: 0 }],
    ["update", { update_allows_fetch_and_merge: null }],
    ["update", { update_allows_fetch_and_merge: false, unknown: true }],
    ["non_fast_forward", { update_allows_fetch_and_merge: false }],
  ] as const)("rejects %s rule parameters %j", async (type, parameters) => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = "blocked";
    f.additionalRulesets.push({ ...structuredClone(f.writerRuleset), id: 10, rules: [{ type, parameters }] });
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("blocked_merge_protections_unproven");
    expect(f.writes).toEqual([]);
  });

  it.each([
    ["unknown condition", { conditions: { ref_name: { include: ["refs/heads/release"], exclude: [] }, unknown: {} } }],
    ["missing include", { conditions: { ref_name: { exclude: [] } } }],
    ["empty include", { conditions: { ref_name: { include: [], exclude: [] } } }],
    ["malformed include", { conditions: { ref_name: { include: "refs/heads/release", exclude: [] } } }],
    ["malformed pattern", { conditions: { ref_name: { include: ["refs/heads/release", null], exclude: [] } } }],
    ["missing exclude", { conditions: { ref_name: { include: ["refs/heads/release"] } } }],
    ["malformed exclude", { conditions: { ref_name: { include: ["~ALL"], exclude: "main" } } }],
    ["recursive glob", { conditions: { ref_name: { include: ["refs/heads/**"], exclude: [] } } }],
    ["question glob", { conditions: { ref_name: { include: ["refs/heads/mai?"], exclude: [] } } }],
    ["bracket glob", { conditions: { ref_name: { include: ["refs/heads/[m]ain"], exclude: [] } } }],
    ["unknown ref condition", { conditions: { ref_name: { include: ["~ALL"], exclude: [], unknown: true } } }],
    ["unreadable conditions", { conditions: null }],
    ["unknown target", { target: "push" }],
    ["unreadable enforcement", { enforcement: null }],
    ["unknown enforcement", { enforcement: "future" }],
    ["missing rules", { rules: undefined }],
    ["malformed rules", { rules: {} }],
    ["malformed rule", { rules: [null] }],
    ["missing rule type", { rules: [{}] }],
  ] as const)("fails closed on %s in a freshly applicable ruleset", async (_label, overrides) => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = "blocked";
    f.beforeFinalRead(() => {
      f.additionalRulesets.push({ ...structuredClone(f.writerRuleset), id: 10, ...overrides });
    });
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("blocked_merge_protections_unproven");
    expect(f.writes).toEqual([]);
  });

  it.each([
    { enforcement: "disabled" },
    { enforcement: "evaluate" },
    { target: "tag" },
    { conditions: { ref_name: { include: ["refs/heads/release/*"], exclude: [] } } },
    { conditions: { ref_name: { include: ["~ALL"], exclude: ["~DEFAULT_BRANCH"] } } },
  ])("ignores a proven irrelevant ruleset %j for a blocked merge", async (overrides) => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = "blocked";
    f.additionalRulesets.push({ ...structuredClone(f.writerRuleset), id: 10, rules: [{ type: "required_signatures" }], ...overrides });
    const completed = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(completed).toMatchObject({ phase: "complete", mergeWriteState: "accepted" });
    expect(f.writes.filter((write) => write.includes("/pulls/321/merge"))).toHaveLength(1);
  });

  it.each(["enumerated", "attested"] as const)("rejects a fresh writer fingerprint change with %s proof", async (proof) => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = "blocked";
    const config = proof === "attested" ? { ...f.config, mainWriterAttestation: f.hideBypass() } : f.config;
    f.beforeFinalRead(() => { f.writerRuleset.updated_at = "2026-10-15T01:00:00.000Z"; });
    await expect(guardImmediateMerge(config, f.receipt.identity)).rejects.toThrow("blocked_merge_protections_unproven");
    expect(f.writes).toEqual([]);
  });

  it.each(["extra-rule", "second-ruleset", "removed-writer", "changed-bypass", "hidden-bypass"] as const)(
    "rejects a final %s change after a passing snapshot", async (change) => {
      const f = await serializedControllerFixture("browser");
      f.pull.mergeable_state = "blocked";
      f.beforeFinalRead(() => {
        if (change === "extra-rule") f.writerRuleset.rules.push({ type: "required_signatures" });
        if (change === "second-ruleset") f.additionalRulesets.push({ ...structuredClone(f.writerRuleset), id: 10, rules: [{ type: "required_signatures" }] });
        if (change === "removed-writer") f.writerRuleset.rules = [{ type: "non_fast_forward" }];
        if (change === "changed-bypass") f.writerRuleset.bypass_actors[0]!.actor_id = 12345;
        if (change === "hidden-bypass") f.hideBypass();
      });
      await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("blocked_merge_protections_unproven");
      expect(f.writes).toEqual([]);
    },
  );

  it.each(["list", "detail", "classic"] as const)("rejects an unreadable final %s protection read", async (kind) => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = "blocked";
    f.beforeFinalRead(() => {
      const request = f.api.request.bind(f.api);
      f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
        if ((kind === "detail" && path.includes("/rulesets/9?")) ||
            (kind === "classic" && path.endsWith("/branches/main/protection"))) throw new GitHubApiError(403, "GET", path);
        return request<T>(path, options);
      };
      if (kind === "list") f.api.pages = async () => { throw new Error("unreadable rulesets"); };
    });
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("blocked_merge_protections_unproven");
    expect(f.writes).toEqual([]);
  });

  it.each([
    { users: [{ id: 101 }], teams: [], apps: [] },
    { users: [], teams: [{ id: 102 }], apps: [] },
    { users: [], teams: [], apps: [{ id: 98765 }] },
    { users: [], teams: [], apps: null },
    { users: [], teams: [] },
    { users: [], teams: [], apps: [], unknown: [] },
    null,
    [],
  ])("rejects classic review bypass allowances %j for a blocked merge", async (allowances) => {
    const f = await serializedControllerFixture("legacy-root");
    f.pull.mergeable_state = "blocked";
    f.beforeFinalRead(() => { f.reviewRules.bypass_pull_request_allowances = allowances; });
    const pending = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(pending).toMatchObject({ mergeWriteState: "not-sent", reason: "blocked_merge_protections_unproven" });
    expect(f.writes).toEqual([]);
  });

  it("accepts empty classic review bypass allowances for a blocked merge", async () => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = "blocked";
    f.reviewRules.bypass_pull_request_allowances = { users: [], teams: [], apps: [] };
    const completed = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(completed).toMatchObject({ phase: "complete", mergeWriteState: "accepted" });
  });

  it.each(["clean", "behind"] as const)("preserves serialized %s merge behavior with extra rules", async (state) => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = state;
    f.writerRuleset.rules.push({ type: "required_signatures" });
    const completed = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(completed).toMatchObject({ phase: "complete", mergeWriteState: "accepted" });
  });

  it.each([
    ["browser", "enumerated"],
    ["browser", "attested"],
    ["legacy-root", "enumerated"],
    ["legacy-root", "attested"],
  ] as const)("merges blocked %s approval once with a fresh %s writer guard", async (channel, proof) => {
    const f = await serializedControllerFixture(channel);
    f.pull.mergeable_state = "blocked";
    const config = proof === "attested" ? { ...f.config, mainWriterAttestation: f.hideBypass() } : f.config;
    const completed = await recoverControllerCompletion(config, f.receipt, f.clock);
    expect(completed).toMatchObject({ phase: "complete", mergeSha: MERGE_SHA, mergeWriteState: "accepted" });
    expect(f.writes).toEqual([
      "PUT /repos/lukemyself-hub/SayHear/pulls/321/merge",
      "DELETE /repos/lukemyself-hub/SayHear/issues/42/labels/ongoing",
      "PATCH /repos/lukemyself-hub/SayHear/issues/42",
    ]);
    expect(f.issue).toMatchObject({ state: "closed", labels: [] });
    expect(f.stored()).toMatchObject({ phase: "complete", mergeWriteState: "accepted" });
    await expect(recoverControllerCompletion(config, completed, f.clock)).resolves.toEqual(completed);
    expect(f.writes.filter((write) => write.includes("/pulls/321/merge"))).toHaveLength(1);
  });

  it.each(["missing", "stale", "wrong-assertion", "wrong-ruleset", "wrong-live-bypass", "extra-live-bypass"] as const)(
    "rejects blocked recovery with %s main writer proof without writes", async (failure) => {
      const f = await serializedControllerFixture("browser");
      f.pull.mergeable_state = "blocked";
      let config: typeof f.config = f.config;
      if (failure === "wrong-live-bypass" || failure === "extra-live-bypass") {
        f.writerRuleset.bypass_actors = failure === "wrong-live-bypass"
          ? [{ actor_id: 12345, actor_type: "Integration", bypass_mode: "always" }]
          : [...f.writerRuleset.bypass_actors, { actor_id: 12345, actor_type: "Integration", bypass_mode: "always" }];
      } else {
        const attestation = f.hideBypass();
        if (failure !== "missing") config = { ...config, mainWriterAttestation: attestation };
        if (failure === "stale") f.writerRuleset.updated_at = "2026-10-15T01:00:00.000Z";
        if (failure === "wrong-assertion") config = { ...config, mainWriterAttestation: { ...attestation, assertedBypassAppIds: [12345] } };
        if (failure === "wrong-ruleset") config = { ...config, mainWriterAttestation: { ...attestation, rulesetId: 10 } };
      }
      const pending = await recoverControllerCompletion(config, f.receipt, f.clock);
      expect(pending).toMatchObject({ phase: "merge_unconfirmed", mergeWriteState: "not-sent", reason: "fresh_merge_gate_blocked" });
      expect(f.writes).toEqual([]);
    },
  );

  it.each(["preparation", "rejected", "uncertain"] as const)("continues scanning other PRs after %s refresh failure", async (failure) => {
    const f = await serializedControllerFixture("browser");
    f.advanceMain(false);
    let failOnce = true;
    let deliveries = 0;
    const api = new StubApi((path, options) => {
      if (path.endsWith("/issues/321/labels") && options?.method === "POST") deliveries++;
      if (failOnce && options?.method === "POST" &&
          path.endsWith(failure === "preparation" ? "/SayHear/labels" : "/issues/321/labels")) {
        failOnce = false;
        if (failure === "uncertain") throw new Error("label response lost");
        throw new GitHubApiError(failure === "preparation" ? 503 : 422, "POST", path);
      }
      return f.api.request(path, options);
    }, (path) => path.endsWith("/pulls?state=open")
      ? [structuredClone(f.pull), { ...structuredClone(f.pull), number: 322, draft: true }]
      : f.api.pages(path));
    api.bytes = f.api.bytes.bind(f.api);
    const config = { ...f.config, api };
    const first = await scanPullRequests(config, null);
    expect(first).toEqual([
      expect.objectContaining({ pullRequest: 321, status: "integration_refresh_blocked",
        reason: expect.stringContaining(failure === "uncertain" ? "label response lost" : `HTTP ${failure === "preparation" ? 503 : 422}`) }),
      expect.objectContaining({ pullRequest: 322, status: "skipped" }),
    ]);
    const snapshot = await readSnapshot(config, 321);
    const record = await config.integrationRefreshStore?.read(321);
    expect(record?.phase).toBe(failure === "uncertain" ? "dispatching" : "intent");
    expect(await refreshStaleIntegration(config, snapshot)).toBe(true);
    expect(deliveries).toBe(failure === "rejected" ? 2 : 1);
    expect((await config.integrationRefreshStore?.read(321))?.phase).toBe(failure === "uncertain" ? "dispatching" : "requested");
    expect(f.issue).toMatchObject({ state: "open", labels: ["ongoing"] });
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  it.each(["browser", "legacy-root"] as const)("merges and completes Issues through the full current guard for %s", async (channel) => {
    const f = await serializedControllerFixture(channel);
    const completed = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(completed).toMatchObject({ phase: "complete", mergeSha: MERGE_SHA, mergeWriteState: "accepted" });
    expect(f.pull.merged).toBe(true);
    expect(f.issue).toMatchObject({ state: "closed", labels: [] });
    expect(f.writes.filter((write) => write.includes("/pulls/321/merge"))).toHaveLength(1);
    expect(f.stored()).toMatchObject({ phase: "complete", mergeWriteState: "accepted" });
    const restarted = await recoverControllerCompletion(f.config, completed, f.clock);
    expect(restarted).toEqual(completed);
    expect(f.writes.filter((write) => write.includes("/pulls/321/merge"))).toHaveLength(1);
  });

  it.each(["browser", "legacy-root"] as const)("reuses the immutable report across independent main movement for %s", async (channel) => {
    const f = await serializedControllerFixture(channel);
    f.advanceMain();
    const guarded = await guardImmediateMerge(f.config, f.receipt.identity);
    expect(guarded.report.baseSha).toBe(BASE_SHA);
    expect(guarded.pullRequest.base.sha).toBe(BASE_SHA);
    expect(guarded.pullRequest.merge_commit_sha).toBe("7".repeat(40));
    const completed = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(completed.phase).toBe("complete");
    expect(f.writes.filter((write) => write.includes("/pulls/321/merge"))).toHaveLength(1);
  });

  it("merges when the open PR omits merge_commit_sha", async () => {
    const f = await serializedControllerFixture("browser");
    // The pinned API version can omit the field on an open PR; the guard must
    // use the verified merge ref instead.
    (f.pull as { merge_commit_sha: string | null }).merge_commit_sha = null;
    const guarded = await guardImmediateMerge(f.config, f.receipt.identity);
    expect(guarded.mergeSha).toBe(MERGE_SHA);
    f.mergeAs("8".repeat(40));
    const completed = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(completed).toMatchObject({ phase: "complete", mergeSha: "8".repeat(40), testedTreeSha: "e".repeat(40) });
    expect(f.writes.filter((write) => write.includes("/pulls/321/merge"))).toHaveLength(1);
  });

  it("integrates two PRs from the same original base in sequence while preserving their reviewed bases", async () => {
    const first = await serializedControllerFixture("browser");
    const firstResult = await recoverControllerCompletion(first.config, first.receipt, first.clock);
    expect(firstResult.mergeSha).toBe(MERGE_SHA);
    const second = await serializedControllerFixture("legacy-root");
    second.advanceMain(true, MERGE_SHA);
    const guarded = await guardImmediateMerge(second.config, second.receipt.identity);
    expect(guarded.report.baseSha).toBe(BASE_SHA);
    const secondResult = await recoverControllerCompletion(second.config, second.receipt, second.clock);
    expect(secondResult).toMatchObject({ phase: "complete", mergeSha: "7".repeat(40) });
    expect(second.receipt.identity.approvedBaseSha).toBe(BASE_SHA);
  });

  it("does not merge when main advanced without a matching integration proof", async () => {
    const f = await serializedControllerFixture("browser");
    f.advanceMain(false);
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("waiting_for_integration_validation");
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("waiting_for_integration_validation");
    expect(f.writes.filter((write) => write.endsWith("/issues/321/labels"))).toHaveLength(1);
    expect(f.issue.labels).toEqual(["ongoing"]);
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  async function staleMergeRefFixture(initial: MergeRefRebuildRecord | null = null) {
    const f = await serializedControllerFixture("browser");
    f.advanceMain(false);
    // GitHub keeps the head's merge ref on the reviewed main after main advances.
    f.pull.merge_commit_sha = MERGE_SHA;
    const state = { record: initial, transitions: [] as string[], patchError: null as unknown };
    const mergeRefRebuildStore = { read: async () => state.record, list: async () => state.record ? [state.record] : [],
      save: async (value: MergeRefRebuildRecord) => { state.record = structuredClone(value); } };
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (path.endsWith("/pulls/321") && options?.method === "PATCH") {
        if (state.patchError) throw state.patchError;
        const next = requestBody<{ state: "open" | "closed" }>(options).state;
        state.transitions.push(next);
        f.pull.state = next;
      }
      return request<T>(path, options);
    };
    return { f, state, config: { ...f.config, mergeRefRebuildStore } };
  }

  it("rebuilds a merge ref GitHub left on the old main by reopening the PR once", async () => {
    const { f, state, config } = await staleMergeRefFixture();
    const snapshot = await readSnapshot(config, 321);
    expect(snapshot.gateInput.pullRequest.mergeSha).toBeNull();
    expect(snapshot.staleMergeRefSha).toBe(MERGE_SHA);
    expect(snapshot.workflowStatus).toBe("unknown");

    expect(await scanPullRequests(config, null)).toEqual([
      expect.objectContaining({ pullRequest: 321, status: "waiting_for_validation" }),
    ]);
    expect(state.transitions).toEqual(["closed", "open"]);
    expect(state.record).toMatchObject({ phase: "reopened", target: { headSha: HEAD_SHA, mainSha: "9".repeat(40), staleMergeSha: MERGE_SHA } });
    expect(f.pull.state).toBe("open");

    // GitHub has not rebuilt the ref yet: wait instead of cycling the PR.
    await scanPullRequests(config, null);
    expect(state.transitions).toEqual(["closed", "open"]);
    expect(f.writes.some((write) => write.endsWith("/issues/321/labels") || write.includes("/pulls/321/merge"))).toBe(false);
    expect(f.issue).toMatchObject({ state: "open", labels: ["ongoing"] });
  });

  it("only waits on a stale merge ref inside the merge guard", async () => {
    const { f, state, config } = await staleMergeRefFixture();
    await expect(guardImmediateMerge(config, f.receipt.identity)).rejects.toThrow("waiting_for_integration_validation");
    expect(state.transitions).toEqual([]);
    expect(state.record).toBeNull();
  });

  it("does not close a PR that has a pending completion receipt", async () => {
    const { f, state, config } = await staleMergeRefFixture();
    await config.completionStore?.save(f.receipt);
    expect(await refreshStaleIntegration(config, await readSnapshot(config, 321), { rebuildMergeRef: true })).toBe(true);
    expect(state.transitions).toEqual([]);
  });

  it("lets an ineligible stale PR on the automatic route continue to its normal review path without closing it", async () => {
    const { f, state, config } = await staleMergeRefFixture();
    f.issue.labels = ["ready-for-agent"];
    // A stored pre-final-decision approval keeps the automatic route.
    const current = f.browserApprovalStore.value;
    if (!current?.challenge || !current.receipt) throw new Error("Expected a bound browser approval");
    const { liveness: _liveness, ...context } = current.challenge.context;
    const challenge = { ...current.challenge, context };
    f.browserApprovalStore.value = { ...current, challenge, receipt: { ...current.receipt, challenge } };
    expect(await refreshStaleIntegration(config, await readSnapshot(config, 321), { rebuildMergeRef: true })).toBe(false);
    expect(state.transitions).toEqual([]);
  });

  it("refreshes the combination for Luke's final decision despite old Issue triage labels", async () => {
    const { f, state, config } = await staleMergeRefFixture();
    f.issue.labels = ["ready-for-agent", "needs-info"];
    expect(await refreshStaleIntegration(config, await readSnapshot(config, 321), { rebuildMergeRef: true })).toBe(true);
    expect(state.transitions).toEqual(["closed", "open"]);
  });

  it("withholds the human route when the final decision does not cover the live scope", async () => {
    const { f, state, config } = await staleMergeRefFixture();
    f.issue.labels = ["ready-for-agent", "needs-info"];
    const snapshot = await readSnapshot(config, 321);
    // A requirement change after the Approve without a new reconciliation
    // leaves the receipt on a stale digest, so triage labels still stop here.
    const unreconciled = { ...snapshot,
      humanBinding: { ...snapshot.humanBinding, coveredRequirementDigest: "0".repeat(64) } };
    expect(await refreshStaleIntegration(config, unreconciled, { rebuildMergeRef: true })).toBe(false);
    expect(state.transitions).toEqual([]);
  });

  it("never refreshes through an explicit Issue pause on the human route", async () => {
    const { f, state, config } = await staleMergeRefFixture();
    f.issue.labels = ["ready-for-agent"];
    const snapshot = await readSnapshot(config, 321);
    const paused = { ...snapshot, gateInput: { ...snapshot.gateInput, issues: snapshot.gateInput.issues.map((issue) =>
      ({ ...issue, pause: { active: true, source: "maintainer" as const } })) } };
    expect(await refreshStaleIntegration(config, paused, { rebuildMergeRef: true })).toBe(false);
    expect(state.transitions).toEqual([]);
  });

  it("does not close the PR when main moved again under the lock", async () => {
    const { f, state, config } = await staleMergeRefFixture();
    const snapshot = await readSnapshot(config, 321);
    f.advanceMain(false, "6".repeat(40));
    f.pull.merge_commit_sha = MERGE_SHA;
    expect(await refreshStaleIntegration(config, snapshot, { rebuildMergeRef: true })).toBe(true);
    expect(state.transitions).toEqual([]);
    expect(state.record).toBeNull();
  });

  it("reopens a PR left closed by an interrupted rebuild before scanning, without a second cycle", async () => {
    const { f, state, config } = await staleMergeRefFixture({ version: 1, pullRequestNumber: 321, phase: "closing",
      target: { headSha: HEAD_SHA, mainSha: "9".repeat(40), staleMergeSha: MERGE_SHA } });
    f.pull.state = "closed";
    await scanPullRequests(config, null, false);
    expect(state.transitions).toEqual(["open"]);
    expect(state.record).toMatchObject({ phase: "reopened" });
  });

  it("reports a refused recovery reopen per PR and settles it", async () => {
    const { f, state, config } = await staleMergeRefFixture({ version: 1, pullRequestNumber: 321, phase: "closing",
      target: { headSha: HEAD_SHA, mainSha: BASE_SHA, staleMergeSha: MERGE_SHA } });
    f.pull.state = "closed";
    state.patchError = new GitHubApiError(422, "PATCH", "/repos/lukemyself-hub/SayHear/pulls/321");
    const results = await scanPullRequests(config, null, false);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, status: "merge_ref_rebuild_recovery_blocked", reason: expect.stringMatching(/^reopen_refused: .*HTTP 422/) })]);
    expect(state.record).toMatchObject({ phase: "reopen_refused" });
    expect(f.pull.state).toBe("closed");
  });

  it("hands a rebuilt merge ref to the ci-int refresh when the reopened run tested the old merge", async () => {
    const { f, state, config } = await staleMergeRefFixture();
    await scanPullRequests(config, null);
    expect(state.transitions).toEqual(["closed", "open"]);
    // GitHub rebuilt the ref, but the latest Validate run still checked out the old merge commit.
    f.pull.merge_commit_sha = "7".repeat(40);
    expect(await scanPullRequests(config, null)).toEqual([
      expect.objectContaining({ pullRequest: 321, status: "waiting_for_validation" }),
    ]);
    expect(state.transitions).toEqual(["closed", "open"]);
    expect(f.writes.filter((write) => write.endsWith("/issues/321/labels"))).toHaveLength(1);
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  // The fixture API has no /compare/ route: main movement is never inspected
  // for path overlap or config-like files. Only combined Validate decides.
  it.each(["browser", "legacy-root"] as const)("keeps the review and human binding when main moves without a sync commit for %s", async (channel) => {
    const f = await serializedControllerFixture(channel);
    f.advanceMain(true);
    const snapshot = await readSnapshot(f.config, 321);
    await expect(readSavedReviewReport(f.config, snapshot)).resolves.not.toBeNull();
    expect(snapshot.humanBinding.paths).not.toEqual([]);
    if (channel === "browser") expect(f.browserApprovalStore.value?.receipt).not.toBeNull();
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).resolves.toMatchObject({ report: { baseSha: BASE_SHA } });
  });

  it("stops on failed combined Validate after main moves without re-requesting human review", async () => {
    const f = await serializedControllerFixture("browser");
    f.advanceMain(true);
    f.failValidation();
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("fresh_merge_gate_blocked");
    expect(f.browserApprovalStore.value?.receipt).not.toBeNull();
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  it("rejects final main drift after successful CI and snapshot validation", async () => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = "blocked";
    f.driftFinalMain();
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("integration_changed_before_merge");
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  it("rejects current-target failed CI without dispatching or merging", async () => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = "blocked";
    f.failValidation();
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("fresh_merge_gate_blocked");
    expect(f.writes.some((write) => write.includes("/pulls/321/merge") || write.includes("/labels"))).toBe(false);
  });

  it("carries a startup-loaded attestation into the snapshot via config", async () => {
    // The attestation lives in config (loaded once in the privileged launcher
    // context). Snapshot and status paths must never hit the protected
    // filesystem mid-flow, or unit runs outside macOS break: realpath
    // '/Library' does not exist on Linux CI.
    const attestation: MainWriterAttestation = {
      version: MAIN_WRITER_ATTESTATION_VERSION,
      rulesetId: 9,
      rulesetFingerprint: "a".repeat(64),
      assertedBypassAppIds: [98765],
      attestedAt: "2026-10-15T00:00:00.000Z",
      attestedBy: "test",
    };
    const f = await serializedControllerFixture("browser");
    const snapshot = await readSnapshot({ ...f.config, mainWriterAttestation: attestation }, 321);
    expect(snapshot.gateInput.runtime.mainWriterAttestation).toEqual(attestation);
    const unattested = await readSnapshot(f.config, 321);
    expect(unattested.gateInput.runtime.mainWriterAttestation).toBeUndefined();
  });

  it("never falls back to an older green Validate while a newer trusted run is queued", async () => {
    const f = await serializedControllerFixture("browser");
    f.queueNewerValidation();
    const snapshot = await readSnapshot(f.config, 321);
    expect(snapshot.workflowStatus).toBe("queued");
    expect(snapshot.staleIntegrationRunId).toBeNull();
    expect(snapshot.evidence.find((entry) => entry.checkId === "baseline:test")).toMatchObject({ result: "planned", source: { runId: 556 } });
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("fresh_merge_gate_blocked");
    expect(f.writes.some((write) => write.includes("/pulls/321/merge") || write.includes("/labels"))).toBe(false);
  });

  function withSavedReport(f: Awaited<ReturnType<typeof serializedControllerFixture>>, change: (report: ModelReviewReport) => ModelReviewReport) {
    const check = f.reviewChecks.find((entry) => entry.id === 9002) as { output: { summary: string } };
    check.output.summary = check.output.summary.replace(/report=([A-Za-z0-9_-]+)/, (_, encoded: string) =>
      `report=${Buffer.from(JSON.stringify(change(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))))).toString("base64url")}`);
  }

  function asLegacyBrowserApproval(f: Awaited<ReturnType<typeof serializedControllerFixture>>) {
    const state = f.browserApprovalStore.value;
    if (!state?.challenge || !state.receipt) throw new Error("Expected a bound browser approval");
    const { liveness: _liveness, ...context } = state.challenge.context;
    const challenge = { ...state.challenge, context };
    f.browserApprovalStore.value = { ...state, challenge, receipt: { ...state.receipt, challenge } };
    const { humanLiveness: _humanLiveness, ...identity } = f.receipt.identity;
    return identity;
  }

  it("binds Luke's later Approve through a new final-decision challenge", async () => {
    const f = await serializedControllerFixture("browser");
    expect(f.browserApprovalStore.value?.challenge?.context.liveness).toBe("final-decision-v1");
    expect(f.receipt.identity.humanLiveness).toBe("final-decision-v1");
    const after = Date.parse(String(f.reviews.find((review) => review.id === 10)?.submitted_at)) + 1_000;
    f.reviews.push({ id: 30, state: "COMMENTED", body: "Note", commit_id: HEAD_SHA, user: LUKE_IDENTITY, submitted_at: new Date(after).toISOString() });
    const snapshot = await readSnapshot(f.config, 321);
    expect(snapshot.humanBinding.receipt?.reviewId).toBe(10);
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).resolves.toBeDefined();
  });

  it("lets a live final decision route past automatic human-review reasons", async () => {
    const f = await serializedControllerFixture("browser");
    withSavedReport(f, (report) => ({ ...report, riskFlags: { ...report.riskFlags, productDefinitionChanged: true } }));
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).resolves.toBeDefined();
  });

  it("keeps the automatic gate for a stored legacy browser approval", async () => {
    const f = await serializedControllerFixture("browser");
    const identity = asLegacyBrowserApproval(f);
    const epoch = f.browserApprovalStore.value?.epoch;
    const snapshot = await readSnapshot(f.config, 321);
    // The upgrade alone neither drifts nor re-interprets the stored challenge.
    expect(snapshot.humanBinding.receipt?.challenge.context.liveness).toBeUndefined();
    expect(f.browserApprovalStore.value?.epoch).toBe(epoch);
    withSavedReport(f, (report) => ({ ...report, riskFlags: { ...report.riskFlags, productDefinitionChanged: true } }));
    await expect(guardImmediateMerge(f.config, identity)).rejects.toThrow("fresh_merge_gate_blocked");
  });

  it("keeps last-review revocation for a stored legacy browser approval", async () => {
    const f = await serializedControllerFixture("browser");
    asLegacyBrowserApproval(f);
    const after = Date.parse(String(f.reviews.find((review) => review.id === 10)?.submitted_at)) + 1_000;
    f.reviews.push({ id: 30, state: "COMMENTED", body: "Note", commit_id: HEAD_SHA, user: LUKE_IDENTITY, submitted_at: new Date(after).toISOString() });
    const snapshot = await readSnapshot(f.config, 321);
    expect(snapshot.humanBinding.receipt).toBeNull();
    expect(f.browserApprovalStore.value?.challenge).toBeNull();
  });

  it("rejects a completion identity whose liveness differs from the live receipt", async () => {
    const f = await serializedControllerFixture("browser");
    const { humanLiveness: _humanLiveness, ...identity } = f.receipt.identity;
    await expect(guardImmediateMerge(f.config, identity)).rejects.toThrow("human_review_binding_changed");
  });

  it("never routes a revoked final decision past the gate", async () => {
    const f = await serializedControllerFixture("browser");
    withSavedReport(f, (report) => ({ ...report, riskFlags: { ...report.riskFlags, productDefinitionChanged: true } }));
    const after = Date.parse(String(f.reviews.find((review) => review.id === 10)?.submitted_at)) + 1_000;
    f.reviews.push({ id: 30, state: "CHANGES_REQUESTED", body: "Stop", commit_id: HEAD_SHA, user: LUKE_IDENTITY, submitted_at: new Date(after).toISOString() });
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("fresh_merge_gate_blocked");
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  async function commentAfterFinalDecision(verdict: "unchanged" | "material" | "unknown") {
    const f = await serializedControllerFixture("browser");
    const before = await readSnapshot(f.config, 321);
    const approved = before.humanBinding.receipt?.challenge.context.requirementDigest;
    const epoch = before.humanBinding.receipt?.challenge.epoch;
    if (!approved || !epoch) throw new Error("Expected a bound final decision");
    const pages = f.api.pages.bind(f.api);
    f.api.pages = async <T>(path: string): Promise<T[]> => path.endsWith("/issues/321/comments")
      ? [{ id: 77, body: "Small wording note.", user: { id: 5, login: "someone", type: "User" },
        created_at: "2026-10-14T01:00:00Z", updated_at: "2026-10-14T01:00:00Z" },
      ...(structuredClone(f.comments.get(321)!) as Array<unknown>)] as T[]
      : pages<T>(path);
    const after = await readSnapshot(f.config, 321);
    const live = requirementDigest(after.gateInput.issues, after.gateInput.pullRequest);
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "PATCH" && path.endsWith("/check-runs/9002")) return {} as T;
      if (options?.method === "POST" && path.endsWith("/check-runs")) return { id: 9004 } as T;
      return request<T>(path, options);
    };
    // As if submit stored the coordinator's report for the live requirement.
    const report: ModelReviewReport = { ...modelReport, baseSha: BASE_SHA, requirementDigest: live, declaredImpacts: [],
      riskFlags: { ...modelReport.riskFlags, productDefinitionChanged: true },
      ...boundModelJudgments(after.diff.digest, [{ path: "scripts/pr-approval-controller.ts", status: "modified" }]),
      scopeReconciliation: { epoch, approvedRequirementDigest: approved, verdict } };
    const check = f.reviewChecks.find((entry) => entry.id === 9002) as { external_id: string; output: { summary: string } };
    check.external_id = check.external_id.replace(approved, live);
    check.output.summary = check.output.summary.replace(`requirement=${approved}`, `requirement=${live}`)
      .replace(/report=[A-Za-z0-9_-]+/, `report=${Buffer.from(JSON.stringify(report)).toString("base64url")}`);
    const appReview = f.reviews.find((review) => review.id === 20) as { body: string };
    appReview.body = appReview.body.replace(approved, live);
    return { f, approved, live, withheld: after };
  }

  it("keeps Luke's final decision through an ordinary comment but withholds it until reconciled", async () => {
    const { approved, live, withheld } = await commentAfterFinalDecision("unknown");
    expect(live).not.toBe(approved);
    expect(withheld.humanBinding.receipt?.reviewId).toBe(10);
    expect(withheld.humanBinding.coveredRequirementDigest).toBe(approved);
  });

  it("merges after the coordinator reconciles a comment as unchanged scope", async () => {
    const { f, live } = await commentAfterFinalDecision("unchanged");
    const results = await scanPullRequests(f.config, 321);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    expect(f.browserApprovalStore.value?.scopeRequirementDigest).toBe(live);
    expect(f.stored()?.identity.requirementDigest).toBe(live);
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(true);
  });

  it("waits for a human when the coordinator cannot classify the scope change", async () => {
    const { f } = await commentAfterFinalDecision("unknown");
    const results = await scanPullRequests(f.config, 321);
    expect(results[0]?.outcome).not.toBe("merge_candidate");
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
    expect(f.stored()).toBeNull();
    expect(f.browserApprovalStore.value?.receipt?.reviewId).toBe(10);
  });

  it("requires a new Approve after a material scope change", async () => {
    const { f } = await commentAfterFinalDecision("material");
    const results = await scanPullRequests(f.config, 321);
    expect(results[0]?.outcome).not.toBe("merge_candidate");
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
    expect(f.stored()).toBeNull();
    expect(f.browserApprovalStore.value?.receipt ?? null).toBeNull();
  });

  function acceptCheckRunWrites(f: Awaited<ReturnType<typeof serializedControllerFixture>>) {
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "PATCH" && path.endsWith("/check-runs/9002")) return {} as T;
      if (options?.method === "POST" && path.endsWith("/check-runs")) return { id: 9004 } as T;
      return request<T>(path, options);
    };
  }

  it("merges a zero-Issue PR through Luke's final decision and completes without Issue writes", async () => {
    const f = await serializedControllerFixture("browser", { linkedIssue: false });
    acceptCheckRunWrites(f);
    const results = await scanPullRequests(f.config, 321);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    expect(f.stored()).toMatchObject({ version: 2, phase: "complete", identity: { issueNumbers: [] } });
    expect(f.pull.merged).toBe(true);
    expect(f.writes.some((write) => write.includes("/issues/42"))).toBe(false);
  });

  /**
   * Drops Luke's approval from a browser fixture so the PR is agent-authored
   * with no human approval at all: no decisive review of his own remains, and the
   * signed receipt is cleared with it.
   */
  function withoutLukeApproval(f: Awaited<ReturnType<typeof serializedControllerFixture>>) {
    const review = f.reviews.findIndex((entry) => entry.id === 10);
    if (review < 0) throw new Error("Expected Luke's approval");
    f.reviews.splice(review, 1);
    const state = f.browserApprovalStore.value;
    if (!state) throw new Error("Expected a browser challenge");
    const { scopeRequirementDigest: _scope, ...rest } = state;
    f.browserApprovalStore.value = { ...rest, receipt: null };
  }

  /** Every check-run body this scan published, so a summary can be asserted. */
  function captureCheckRunWrites(f: Awaited<ReturnType<typeof serializedControllerFixture>>) {
    const summaries: string[] = [];
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "PATCH" && path.endsWith("/check-runs/9002")) {
        summaries.push(JSON.stringify(options.body));
        return {} as T;
      }
      if (options?.method === "POST" && path.endsWith("/check-runs")) {
        summaries.push(JSON.stringify(options.body));
        return { id: 9004 } as T;
      }
      return request<T>(path, options);
    };
    return summaries;
  }

  it("merges a protected controller repair the current scope covers, with no approval of its own", async () => {
    const f = await serializedControllerFixture("browser", { linkedIssue: false });
    withoutLukeApproval(f);
    acceptCheckRunWrites(f);
    // The only excuse for the protected path is the current bound scope. The
    // controller and the gate must agree on it: the gate merges, so the
    // controller cannot then stop and call the same PR unauthorized.
    const results = await scanPullRequests(f.config, 321);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    expect(f.stored()).toMatchObject({ phase: "complete", identity: { humanChannel: "app" } });
    expect(f.pull.merged).toBe(true);
  });

  it("publishes no App approval and no merge candidate while waiting for a protected-path approval", async () => {
    const f = await serializedControllerFixture("browser", { linkedIssue: false });
    withoutLukeApproval(f);
    // Same diff, but the current scope cites no observation for any changed
    // path, so it covers nothing and must not excuse the protected path.
    withSavedReport(f, (report) => ({
      ...report,
      behaviorScope: {
        ...report.behaviorScope!,
        evidence: report.behaviorScope!.evidence.map((observation) => ({ ...observation, file: "docs/agents/pr-auto-approval.md" })),
      },
    }));
    const summaries = captureCheckRunWrites(f);
    const results = await scanPullRequests(f.config, 321);
    // This is the gate's own protected-path wait (`browser_human_approval_required`),
    // not the controller's pre-publication guard: the gate stops first, so what
    // this pins is the published surface while waiting, never an approval or a
    // merge_candidate check run for a PR the controller will not merge.
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "awaiting_verification" })]);
    expect(f.writes.some((write) => write.includes("/pulls/321/reviews"))).toBe(false);
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
    expect(summaries.join("\n")).toContain("outcome=human_decision");
    expect(summaries.join("\n")).not.toContain("outcome=merge_candidate");
    expect(f.stored()).toBeNull();
  });

  it("merges a zero-Issue PR on the automatic route without Issue writes", async () => {
    const f = await serializedControllerFixture("browser", { linkedIssue: false });
    asLegacyBrowserApproval(f);
    acceptCheckRunWrites(f);
    const results = await scanPullRequests(f.config, 321);
    // SPEC #362 #367: a PR with no Issues is not refused for lacking an open
    // delivery Issue. The automatic route merges and completes with no writes.
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    expect(f.stored()).toMatchObject({ version: 2, phase: "complete", identity: { issueNumbers: [] } });
    expect(f.pull.merged).toBe(true);
    expect(f.writes.some((write) => write.includes("/issues/42"))).toBe(false);
  });

  it("holds a zero-Issue PR on PR pause and requires fresh review after resume", async () => {
    const f = await serializedControllerFixture("browser", { linkedIssue: false });
    asLegacyBrowserApproval(f);
    acceptCheckRunWrites(f);
    const approvedReviewCount = f.reviews.filter((review) => review.state === "APPROVED").length;
    let prComments: GitHubComment[] = [{
      ...makeIssueComment("/pause-pr-auto-approval", LUKE_IDENTITY.id),
      created_at: "2026-10-14T01:00:00Z",
      updated_at: "2026-10-14T01:00:00Z",
    }];
    const pages = f.api.pages.bind(f.api);
    f.api.pages = async <T>(path: string): Promise<T[]> => path.endsWith("/issues/321/comments")
      ? prComments as T[]
      : pages<T>(path);
    const held = await scanPullRequests(f.config, 321);
    expect(held[0]?.outcome).not.toBe("merge_candidate");
    expect(f.pull.merged).toBe(false);
    expect(f.stored()).toBeNull();
    prComments = [...prComments, {
      ...makeIssueComment("/resume-pr-auto-approval", LUKE_IDENTITY.id),
      created_at: "2026-10-14T02:00:00Z",
      updated_at: "2026-10-14T02:00:00Z",
    }];
    // Resume clears the pause but does not revive the saved review: the
    // pause/resume comments changed the requirement digest, so the stored
    // report is stale and the controller surfaces a fresh review packet
    // instead of merging.
    const resumed = await scanPullRequests(f.config, 321);
    expect(resumed).toEqual([expect.objectContaining({ pullRequest: 321, status: "review_required" })]);
    const resumedResult = resumed[0] as { packetPath?: unknown; requirementDigest?: unknown };
    expect(typeof resumedResult.packetPath).toBe("string");
    expect(resumedResult.requirementDigest).toBeTruthy();
    expect(f.pull.merged).toBe(false);
    expect(f.stored()).toBeNull();
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
    expect(f.writes.some((write) => write.includes("/issues/42"))).toBe(false);
    // No App approval was emitted on the stale saved review.
    expect(f.reviews.filter((review) => review.state === "APPROVED")).toHaveLength(approvedReviewCount);
  });

  it("merges a background-only PR without touching the referenced Issue", async () => {
    const f = await serializedControllerFixture("browser", { backgroundOnly: true });
    acceptCheckRunWrites(f);
    const results = await scanPullRequests(f.config, 321);
    // #42 is referenced but not delivered, so the merge completes with no
    // lifecycle writes and the Issue stays open.
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    expect(f.stored()).toMatchObject({ version: 2, phase: "complete", identity: { issueNumbers: [] } });
    expect(f.pull.merged).toBe(true);
    expect(f.issue.state).toBe("open");
    expect(f.writes.some((write) => write.includes("/issues/42"))).toBe(false);
  });

  it("leaves local #42 untouched when only a foreign repository natively closes #42", async () => {
    const f = await serializedControllerFixture("browser", { backgroundOnly: true });
    acceptCheckRunWrites(f);
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (path === "/graphql" && options?.method === "POST" &&
        requestBody<{ query: string }>(options).query.includes("closingIssuesReferences")) {
        return { data: { repository: { pullRequest: { closingIssuesReferences: {
          nodes: [{ number: 42, repository: { nameWithOwner: "other/repo" } }],
          pageInfo: { hasNextPage: false } } } } } } as T;
      }
      return request<T>(path, options);
    };
    const results = await scanPullRequests(f.config, 321);
    // The foreign native #42 must not deliver the local background-only #42,
    // so the merge completes with no lifecycle writes and the Issue stays open.
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    expect(f.stored()).toMatchObject({ version: 2, phase: "complete", identity: { issueNumbers: [] } });
    expect(f.pull.merged).toBe(true);
    expect(f.issue.state).toBe("open");
    expect(f.writes.some((write) => write.includes("/issues/42"))).toBe(false);
  });

  it("recovers a partial multi-Issue close without a second merge", async () => {
    const f = await serializedControllerFixture("browser", { secondIssue: true });
    if (!f.secondIssue) throw new Error("Second delivery Issue missing");
    let close43Blocked = true;
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (close43Blocked && options?.method === "PATCH" && path.endsWith("/issues/43")) {
        throw new GitHubApiError(500, "PATCH", path);
      }
      return request<T>(path, options);
    };
    f.mergeAs(MERGE_SHA);
    const pending = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    // The merge is confirmed and kept; only the Issue close is pending.
    expect(pending).toMatchObject({ phase: "issues_pending", reason: "completion_issue_updates_incomplete", mergeSha: MERGE_SHA });
    expect(f.issue.state).toBe("closed");
    expect(f.secondIssue.state).toBe("open");
    close43Blocked = false;
    const completed = await recoverControllerCompletion(f.config, { ...pending, nextRetryAt: 0 }, f.clock);
    expect(completed).toMatchObject({ phase: "complete", mergeSha: MERGE_SHA });
    expect(f.issue.state).toBe("closed");
    expect(f.secondIssue.state).toBe("closed");
    // One merge write total across the failure and the recovery.
    expect(f.writes.filter((write) => write.includes("/pulls/321/merge"))).toHaveLength(1);
  });

  it("never lets a final decision override an explicit merge pause", async () => {
    const f = await serializedControllerFixture("browser", { bodySuffix: "\n\n暂停自动审批" });
    acceptCheckRunWrites(f);
    expect(f.browserApprovalStore.value?.receipt?.challenge.context.liveness).toBe("final-decision-v1");
    const results = await scanPullRequests(f.config, 321);
    expect(results[0]?.outcome).not.toBe("merge_candidate");
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
    expect(f.stored()).toBeNull();
  });

  it("approves through the App when Luke's final decision overrides an agent request_changes", async () => {
    const f = await serializedControllerFixture("browser");
    acceptCheckRunWrites(f);
    withSavedReport(f, (report) => ({ ...report, decision: "request_changes", findings: [{ severity: "P2",
      file: "scripts/pr-approval-controller.ts", line: 1, trigger: "retry", userImpact: "stale", evidence: "skip" }] }));
    // No App review exists yet, so submission has to choose the event.
    f.reviews.splice(f.reviews.findIndex((review) => review.id === 20), 1);
    const posted: string[] = [];
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "POST" && path.endsWith("/pulls/321/reviews")) {
        const body = requestBody<{ event: string; body: string; commit_id: string }>(options);
        posted.push(body.event);
        const review = { id: 21, state: body.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED", commit_id: body.commit_id,
          body: body.body, user: { id: REVIEW_BOT_ACTOR_ID, login: "sayhear-pr-review-gate[bot]" } };
        f.reviews.push(review);
        return structuredClone(review) as T;
      }
      return request<T>(path, options);
    };
    const results = await scanPullRequests(f.config, 321);
    expect(posted).toEqual(["APPROVE"]);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    expect(f.pull.merged).toBe(true);
  });

  it("supersedes the App's own request_changes with an approval on the same head", async () => {
    const f = await serializedControllerFixture("browser");
    acceptCheckRunWrites(f);
    withSavedReport(f, (report) => ({ ...report, decision: "request_changes", findings: [{ severity: "P2",
      file: "scripts/pr-approval-controller.ts", line: 1, trigger: "retry", userImpact: "stale", evidence: "skip" }] }));
    // The App posted CHANGES_REQUESTED for this exact identity before Luke's
    // final decision flipped the gate to merge_candidate; the digest is
    // unchanged because the v5 projection excludes reviews.
    const prior = f.reviews.find((review) => review.id === 20);
    if (!prior) throw new Error("App review missing");
    prior.state = "CHANGES_REQUESTED";
    prior.body = `<!-- sayhear-pr-auto-approval-review:v2 pr=321 head=${HEAD_SHA} base=${BASE_SHA} requirement=${f.receipt.identity.requirementDigest} outcome=request_changes -->`;
    const posted: string[] = [];
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "POST" && path.endsWith("/pulls/321/reviews")) {
        const body = requestBody<{ event: string; body: string; commit_id: string }>(options);
        posted.push(body.event);
        const review = { id: 21, state: body.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED", commit_id: body.commit_id,
          body: body.body, user: { id: REVIEW_BOT_ACTOR_ID, login: "sayhear-pr-review-gate[bot]" } };
        f.reviews.push(review);
        return structuredClone(review) as T;
      }
      return request<T>(path, options);
    };
    const results = await scanPullRequests(f.config, 321);
    expect(posted).toEqual(["APPROVE"]);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    expect(f.pull.merged).toBe(true);
  });

  it("migrates the App's own approve_deferred to approve under Luke's valid final decision", async () => {
    const f = await serializedControllerFixture("browser");
    acceptCheckRunWrites(f);
    // The App posted approve_deferred for this exact identity before Luke's
    // valid final-decision approval made the gate a plain merge_candidate.
    const prior = f.reviews.find((review) => review.id === 20);
    if (!prior) throw new Error("App review missing");
    prior.body = `<!-- sayhear-pr-auto-approval-review:v2 pr=321 head=${HEAD_SHA} base=${BASE_SHA} requirement=${f.receipt.identity.requirementDigest} outcome=approve_deferred -->`;
    const posted: string[] = [];
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "POST" && path.endsWith("/pulls/321/reviews")) {
        const body = requestBody<{ event: string; body: string; commit_id: string }>(options);
        posted.push(body.event);
        const review = { id: 21, state: body.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED", commit_id: body.commit_id,
          body: body.body, user: { id: REVIEW_BOT_ACTOR_ID, login: "sayhear-pr-review-gate[bot]" } };
        f.reviews.push(review);
        return structuredClone(review) as T;
      }
      return request<T>(path, options);
    };
    const results = await scanPullRequests(f.config, 321);
    expect(posted).toEqual(["APPROVE"]);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    expect(f.pull.merged).toBe(true);
    expect(f.issue).toMatchObject({ state: "closed", labels: [] });
    expect(f.writes.filter((write) => write.includes("/pulls/321/merge"))).toHaveLength(1);
  });

  it("does not migrate approve_deferred to approve without Luke's valid final decision", async () => {
    const f = await serializedControllerFixture("legacy-root");
    acceptCheckRunWrites(f);
    const prior = f.reviews.find((review) => review.id === 20);
    if (!prior) throw new Error("App review missing");
    prior.body = `<!-- sayhear-pr-auto-approval-review:v2 pr=321 head=${HEAD_SHA} base=${BASE_SHA} requirement=${f.receipt.identity.requirementDigest} outcome=approve_deferred -->`;
    const posted: string[] = [];
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "POST" && path.endsWith("/pulls/321/reviews")) {
        posted.push(path);
      }
      return request<T>(path, options);
    };
    const results = await scanPullRequests(f.config, 321);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "blocked" })]);
    expect(posted).toEqual([]);
    expect(f.pull.merged).toBe(false);
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  it("never lets a final decision override a pause in a linked Issue title", async () => {
    const f = await serializedControllerFixture("browser", { issueTitle: "暂停自动审批: controller safety repair" });
    acceptCheckRunWrites(f);
    expect(f.browserApprovalStore.value?.receipt?.challenge.context.liveness).toBe("final-decision-v1");
    const results = await scanPullRequests(f.config, 321);
    expect(results[0]?.outcome).not.toBe("merge_candidate");
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
    expect(f.stored()).toBeNull();
  });

  it("ignores a scope verdict carried by a submitted report for another gate version", async () => {
    const { f, live, approved } = await commentAfterFinalDecision("material");
    const epoch = f.browserApprovalStore.value?.epoch ?? "";
    await reportReviewResult(f.config, { ...modelReport, baseSha: BASE_SHA, requirementDigest: live, declaredImpacts: [],
      policyVersion: PR_REVIEW_GATE_V11_POLICY_VERSION, scopeReconciliation: { epoch, approvedRequirementDigest: approved, verdict: "material" } });
    expect(f.browserApprovalStore.value?.receipt?.reviewId).toBe(10);
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  it("rejects a dismissed human review during guarded recovery", async () => {
    const f = await serializedControllerFixture("browser");
    f.pull.mergeable_state = "blocked";
    const human = f.reviews.find((review) => review.id === 10);
    if (!human) throw new Error("human review missing");
    human.state = "DISMISSED";
    // A dismissal is a decisive Luke call that the current approval does not
    // answer, so the gate itself refuses the PR. The saved report's behavior
    // scope covers the protected path, and that fresh positive evidence must not
    // carry a PR Luke has already taken back.
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("fresh_merge_gate_blocked");
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  it("blocks a dismissed review on the scan route even with a covering scope", async () => {
    const f = await serializedControllerFixture("browser");
    const dismissed = f.reviews.find((review) => review.id === 10);
    if (!dismissed) throw new Error("human review missing");
    dismissed.state = "DISMISSED";
    acceptCheckRunWrites(f);
    const results = await scanPullRequests(f.config, 321);
    expect(results[0]?.outcome).not.toBe("merge_candidate");
    expect(f.writes.some((write) => write.includes("/pulls/321/reviews"))).toBe(false);
    expect(f.browserApprovalStore.value?.receipt).toBeNull();
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
    expect(f.stored()).toBeNull();
  });

  /**
   * Replaces Luke's approval with an older decisive call of his own, then a
   * current-head approval that becomes the bound receipt. The older call is not a
   * takeover any more, because the newer approval answers it.
   */
  function withEarlierLukeDecisionThenApproval(
    f: Awaited<ReturnType<typeof serializedControllerFixture>>,
    earlier: Readonly<{ state: "CHANGES_REQUESTED" | "DISMISSED" }>,
  ) {
    const state = f.browserApprovalStore.value;
    const frozenAt = state?.challenge?.frozenAt;
    if (!state?.challenge || frozenAt === undefined) throw new Error("Expected a frozen browser challenge");
    const index = f.reviews.findIndex((review) => review.id === 10);
    if (index < 0) throw new Error("Expected Luke's approval");
    f.reviews.splice(index, 1);
    f.reviews.push({ id: 8, state: earlier.state, body: "Earlier call", commit_id: "7".repeat(40),
      user: LUKE_IDENTITY, submitted_at: new Date(frozenAt + 2_000).toISOString() });
    f.reviews.push({ id: 11, state: "APPROVED", body: "Approved", commit_id: HEAD_SHA, user: LUKE_IDENTITY,
      submitted_at: new Date(frozenAt + 3_000).toISOString() });
    const { receipt: _receipt, ...rest } = state;
    f.browserApprovalStore.value = { ...rest, receipt: null };
  }

  it.each(["CHANGES_REQUESTED", "DISMISSED"] as const)(
    "merges after a current approval answers an older %s",
    async (earlier) => {
      const f = await serializedControllerFixture("browser", { linkedIssue: false });
      withEarlierLukeDecisionThenApproval(f, { state: earlier });
      acceptCheckRunWrites(f);
      const results = await scanPullRequests(f.config, 321);
      expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
      expect(f.browserApprovalStore.value?.receipt?.reviewId).toBe(11);
      expect(f.stored()).toMatchObject({ phase: "complete", identity: { humanChannel: "browser", humanReviewId: 11 } });
      expect(f.pull.merged).toBe(true);
    },
  );

  it("tells Luke to approve again when his takeover has no current approval", async () => {
    const f = await serializedControllerFixture("browser");
    const dismissed = f.reviews.find((review) => review.id === 10);
    if (!dismissed) throw new Error("human review missing");
    dismissed.state = "DISMISSED";
    acceptCheckRunWrites(f);
    const summaries = captureCheckRunWrites(f);
    await scanPullRequests(f.config, 321);
    // The published reason has to name the action, because Luke cannot approve
    // yet: nothing is left to approve and no current decision exists.
    const published = summaries.join("\n");
    expect(published).toContain("human_decision_required");
    expect(published).toContain("Approve again on the current head");
    expect(published).toContain("challenge");
  });

  it("treats a comment-only Luke trail as no takeover", async () => {
    const f = await serializedControllerFixture("browser", { linkedIssue: false });
    withoutLukeApproval(f);
    f.reviews.push({ id: 11, state: "COMMENTED", body: "Note", commit_id: HEAD_SHA, user: LUKE_IDENTITY,
      submitted_at: "2026-10-14T00:00:05Z" });
    // Luke commented but never decided, so the automatic route stays open.
    const snapshot = await readSnapshot(f.config, 321);
    expect(snapshot.humanBinding.receipt).toBeNull();
    expect(snapshot.humanBinding.humanDecisionRequired).toBeUndefined();
  });

  it("treats an approval on an older head as a takeover the current approval does not answer", async () => {
    const f = await serializedControllerFixture("browser");
    const approval = f.reviews.find((review) => review.id === 10);
    if (!approval) throw new Error("human review missing");
    approval.commit_id = "7".repeat(40);
    const snapshot = await readSnapshot(f.config, 321);
    expect(snapshot.humanBinding.receipt).toBeNull();
    expect(snapshot.humanBinding.humanDecisionRequired).toBe(true);
  });

  it("records definitive rejection and permits unrelated PRs after confirmed unmerged readback", async () => {
    const f = await serializedControllerFixture("legacy-root");
    f.pull.mergeable_state = "blocked";
    f.failMerge(new GitHubApiError(409, "PUT", "/pulls/321/merge"));
    const failed = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(failed.mergeWriteState).toBe("rejected");
    expect(f.stored()).toMatchObject({ phase: "merge_unconfirmed", mergeWriteState: "rejected" });
    await expect(completionBlockingScope(f.api, failed)).resolves.toBe("this-pr");
    expect(f.pull.merged).toBe(false);
    expect(f.issue.state).toBe("open");
  });

  it("keeps a lost merge response globally blocking and does not blindly send again", async () => {
    const f = await serializedControllerFixture("browser");
    f.failMerge(new Error("socket lost"));
    const pending = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(pending.mergeWriteState).toBe("uncertain");
    await expect(completionBlockingScope(f.api, pending)).resolves.toBe("repository");
    expect(f.writes.filter((write) => write.includes("/pulls/321/merge"))).toHaveLength(1);
  });

  it("records the tested merge tree and completes when the merge commit carries it", async () => {
    const f = await serializedControllerFixture("browser");
    f.mergeAs("8".repeat(40));
    const completed = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(completed).toMatchObject({ phase: "complete", mergeSha: "8".repeat(40), testedTreeSha: "e".repeat(40) });
    expect(f.stored()).toMatchObject({ phase: "complete", testedTreeSha: "e".repeat(40) });
  });

  it("stops without reporting success when the merge tree differs from the tested combination", async () => {
    const f = await serializedControllerFixture("browser");
    f.mergeAs("8".repeat(40));
    f.trees.set("8".repeat(40), "d".repeat(40));
    const stopped = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(stopped).toMatchObject({ phase: "needs_attention", reason: "merged_tree_mismatch", mergeSha: null });
    expect(f.issue.state).toBe("open");
    await expect(completionBlockingScope(f.api, stopped)).resolves.toBe("repository");
    // A restart keeps the recorded fact instead of retrying into success.
    await expect(recoverControllerCompletion(f.config, stopped, f.clock)).resolves.toEqual(stopped);
  });

  it("proves the tree after a lost merge response without a second merge write", async () => {
    const f = await serializedControllerFixture("browser");
    f.mergeAs("8".repeat(40));
    const request = f.api.request.bind(f.api);
    let lose = true;
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      const result = await request<T>(path, options);
      if (lose && path.endsWith("/pulls/321/merge")) { lose = false; throw new Error("socket lost after merge"); }
      return result;
    };
    const pending = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(pending).toMatchObject({ mergeWriteState: "uncertain", testedTreeSha: "e".repeat(40) });
    const recovered = await recoverControllerCompletion(f.config, { ...pending, nextRetryAt: 0 }, f.clock);
    expect(recovered).toMatchObject({ phase: "complete", mergeSha: "8".repeat(40) });
    expect(f.writes.filter((write) => write.includes("/pulls/321/merge"))).toHaveLength(1);
  });

  it("recovers an already-merged intent signed under the previous policy with its original semantics", async () => {
    const f = await serializedControllerFixture("browser");
    f.pull.state = "closed"; f.pull.merged = true;
    const old: CompletionRecord = { ...f.receipt, mergeWriteState: "accepted",
      identity: { ...f.receipt.identity, policyVersion: PR_REVIEW_GATE_V11_POLICY_VERSION } };
    const recovered = await recoverControllerCompletion(f.config, old, f.clock);
    expect(recovered).toMatchObject({ phase: "complete", mergeSha: MERGE_SHA });
    expect(recovered.testedTreeSha).toBeUndefined();
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  it("cannot prove a merge this controller never sent", async () => {
    const f = await serializedControllerFixture("browser");
    f.pull.state = "closed"; f.pull.merged = true;
    const stopped = await recoverControllerCompletion(f.config, f.receipt, f.clock);
    expect(stopped).toMatchObject({ phase: "needs_attention", reason: "merged_tree_unproven" });
    expect(f.issue.state).toBe("open");
  });

  it("lets unrelated work proceed after a confirmed merge with incomplete Issue cleanup", async () => {
    const f = await serializedControllerFixture("browser");
    await expect(completionBlockingScope(f.api, { ...f.receipt, phase: "issues_pending", mergeSha: MERGE_SHA })).resolves.toBe("this-pr");
    await expect(completionBlockingScope(f.api, { ...f.receipt, phase: "complete", mergeSha: MERGE_SHA })).resolves.toBe("none");
  });

  it("never promotes old open completion receipts into head-bound authority", async () => {
    const f = await serializedControllerFixture("legacy-root");
    const { reviewIdentity: _reviewIdentity, ...legacyIdentity } = f.receipt.identity;
    await expect(guardImmediateMerge(f.config, { ...legacyIdentity, policyVersion: "sayhear-pr-review-gate:v9" })).rejects.toThrow("fresh_merge_authorization_required");
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  it("requires legacy-root authorizations to bind both head and reviewed base before serialized use", async () => {
    const f = await serializedControllerFixture("legacy-root");
    const request: Parameters<typeof readHumanBinding>[1] = { pullRequest: f.pull, number: 321, repositoryNodeId: "R_SayHear", reviews: [],
      diffDigest: f.rootAuthorization.diffDigest, diffComplete: true, changedFiles: [{ path: "scripts/pr-approval-controller.ts", status: "modified" }],
      requirement: f.rootAuthorization.requirementDigest, headSha: HEAD_SHA, currentMainSha: BASE_SHA, freeze: false };
    const { approvedBaseSha: _approvedBaseSha, ...legacyAuthorization } = f.rootAuthorization;
    for (const authorization of [ legacyAuthorization, { ...f.rootAuthorization, approvedHeadSha: "8".repeat(40) } ]) {
      const binding = await readHumanBinding({ ...f.config, app: { ...f.config.app, humanReviewAuthorizations: [authorization] } }, request);
      expect(binding.paths).toEqual([]);
    }
    const defaultBinding = await readHumanBinding({ ...f.config, app: { ...f.config.app, integrationMode: "up-to-date-base", humanReviewAuthorizations: [legacyAuthorization] } }, request);
    expect(defaultBinding.paths).toEqual(["scripts/pr-approval-controller.ts"]);
  });

  it("rejects both serialized deferred entry points without auto-merge writes", async () => {
    const f = await serializedControllerFixture("legacy-root");
    f.writes.length = 0;
    const outcome = await requestDeferredMerge(f.config, modelReport, { outcome: "merge_candidate_with_deferrals", deferredEvidence: [] }, {}, f.pull);
    expect(outcome.outcome).toBe("human_decision");
    await expect(applyMergeAction(f.config, modelReport, {}, f.pull, "arm-auto-merge")).rejects.toThrow("serialized_merge_requires_immediate_merge");
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
    expect(f.writes.filter((write) => write === "POST /graphql")).toHaveLength(0);
  });

  it("classifies only explicit merge rejection responses as safely unmerged", () => {
    expect(definitiveMergeRejection(new GitHubApiError(409, "PUT", "/merge"))).toBe(true);
    expect(definitiveMergeRejection(new GitHubApiError(500, "PUT", "/merge"))).toBe(false);
    expect(definitiveMergeRejection(new Error("network timeout"))).toBe(false);
  });
});

describe("remediation history consistency and budget dispatch", () => {
  function malformedHistoryComment(): GitHubComment {
    return {
      id: 77,
      body: "<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=33 -->",
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
      user: { id: REVIEW_BOT_ACTOR_ID, login: "sayhear-pr-review-gate[bot]" },
    };
  }

  function roundThreeComment(): GitHubComment {
    return {
      id: 78,
      body: `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=99 head=${HEAD_SHA} base=${BASE_SHA} round=3 diff=${CHANGE_DIGEST} outcome=request_changes -->`,
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
      user: { id: REVIEW_BOT_ACTOR_ID, login: "sayhear-pr-review-gate[bot]" },
    };
  }

  function roundTwoComment(): GitHubComment {
    return {
      id: 79,
      body: `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=98 head=${HEAD_SHA} base=${BASE_SHA} round=2 diff=${CHANGE_DIGEST} outcome=request_changes -->`,
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
      user: { id: REVIEW_BOT_ACTOR_ID, login: "sayhear-pr-review-gate[bot]" },
    };
  }

  function withPrHistory(f: Awaited<ReturnType<typeof serializedControllerFixture>>, comments: readonly GitHubComment[]) {
    const pages = f.api.pages.bind(f.api);
    f.api.pages = async <T>(path: string): Promise<T[]> => {
      // Seeded history plus anything this run persisted, so a durable marker
      // written during the scan is still visible on readback.
      if (path.endsWith("/issues/321/comments")) {
        return [...structuredClone(comments), ...structuredClone(f.comments.get(321)!)] as T[];
      }
      return pages<T>(path);
    };
  }

  function allowCheckRunWrites(f: Awaited<ReturnType<typeof serializedControllerFixture>>) {
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "PATCH" && path.endsWith("/check-runs/9002")) return {} as T;
      if (options?.method === "POST" && path.endsWith("/check-runs")) return { id: 9004 } as T;
      return request<T>(path, options);
    };
  }

  it("holds malformed trusted history before saved replay or dispatch with no App or merge writes", async () => {
    const f = await serializedControllerFixture("legacy-root");
    withPrHistory(f, [malformedHistoryComment()]);
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method && options.method !== "GET" && path.includes("/check-runs")) {
        throw new Error("No check-run writes for inconsistent history");
      }
      if (options?.method === "POST" && path.endsWith("/pulls/321/reviews")) {
        throw new Error("App approval must not publish for inconsistent history");
      }
      if (path.endsWith("/pulls/321/merge")) throw new Error("Merge must not publish for inconsistent history");
      return request<T>(path, options);
    };
    const results = await scanPullRequests(f.config, 321);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, status: "remediation_history_inconsistent" })]);
    expect(String(results[0]?.reason)).toContain("remediation_history_inconsistent");
    expect(f.writes.some((write) => write.includes("/pulls/321/reviews"))).toBe(false);
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
    // Prepare may write its local packet but must not advertise review_required.
    const prepared = await scanPullRequests(f.config, 321, true);
    expect(prepared).toEqual([expect.objectContaining({ pullRequest: 321, status: "remediation_history_inconsistent" })]);
    expect(prepared[0]).not.toMatchObject({ status: "review_required" });
    expect(f.writes.some((write) => write.includes("/pulls/321/reviews"))).toBe(false);
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  it("holds a direct valid automatic approve report on inconsistent history", async () => {
    const f = await serializedControllerFixture("legacy-root", { linkedIssue: false });
    withPrHistory(f, [malformedHistoryComment()]);
    const snapshot = await readSnapshot(f.config, 321);
    expect(snapshot.remediation.historyConsistent).toBe(false);
    const saved = await readSavedReviewReport(f.config, snapshot);
    if (!saved) throw new Error("Expected a saved review report for PR 321");
    const summaries: string[] = [];
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "PATCH" && path.endsWith("/check-runs/9002")) {
        summaries.push(JSON.stringify(options.body));
        return {} as T;
      }
      if (options?.method === "POST" && path.endsWith("/check-runs")) {
        summaries.push(JSON.stringify(options.body));
        return { id: 9004 } as T;
      }
      if (options?.method === "POST" && path.endsWith("/pulls/321/reviews")) {
        throw new Error("App approval must not publish for inconsistent history");
      }
      if (path.endsWith("/pulls/321/merge")) throw new Error("Merge must not publish for inconsistent history");
      return request<T>(path, options);
    };
    const result = await reportReviewResult(f.config, saved.report);
    expect(result.outcome).toBe("awaiting_verification");
    expect(result.remediation?.historyConsistent).toBe(false);
    expect(summaries.join("\n")).toContain("remediation_history_inconsistent");
    expect(f.writes.some((write) => write.includes("/pulls/321/reviews"))).toBe(false);
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
    expect(f.stored()).toBeNull();
  });

  it("holds a direct submit on inconsistent history without flipping the linked Issue handoff", async () => {
    const f = await serializedControllerFixture("legacy-root");
    withPrHistory(f, [malformedHistoryComment()]);
    const snapshot = await readSnapshot(f.config, 321);
    expect(snapshot.remediation.historyConsistent).toBe(false);
    const saved = await readSavedReviewReport(f.config, snapshot);
    if (!saved) throw new Error("Expected a saved review report for PR 321");
    const summaries: string[] = [];
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "PATCH" && path.endsWith("/check-runs/9002")) {
        summaries.push(JSON.stringify(options.body));
        return {} as T;
      }
      if (options?.method === "POST" && path.endsWith("/check-runs")) {
        summaries.push(JSON.stringify(options.body));
        return { id: 9004 } as T;
      }
      if (options?.method === "POST" && path.endsWith("/pulls/321/reviews")) {
        throw new Error("App approval must not publish for inconsistent history");
      }
      if (path.endsWith("/pulls/321/merge")) throw new Error("Merge must not publish for inconsistent history");
      return request<T>(path, options);
    };
    const result = await reportReviewResult(f.config, saved.report);
    expect(result.outcome).toBe("awaiting_verification");
    expect(result.remediation?.historyConsistent).toBe(false);
    expect(summaries.join("\n")).toContain("remediation_history_inconsistent");
    expect(f.writes.some((write) => write.includes("/issues/42/labels"))).toBe(false);
    expect(f.issue.labels).toEqual(["ongoing"]);
    expect(f.writes.some((write) => write.includes("/pulls/321/reviews"))).toBe(false);
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
    expect(f.stored()).toBeNull();
  });

  it("guards the fresh snapshot when history corrupts after approval", async () => {
    const f = await serializedControllerFixture("legacy-root");
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).resolves.toBeDefined();
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
    withPrHistory(f, [malformedHistoryComment()]);
    await expect(guardImmediateMerge(f.config, f.receipt.identity)).rejects.toThrow("fresh_merge_gate_blocked");
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  it("holds the consistent count-3 budget before prepare and dispatch with no check-run POST", async () => {
    const f = await serializedControllerFixture("legacy-root");
    // Force the NEW-dispatch path: no saved report and no prior App review.
    f.reviewChecks.length = 0;
    const appIndex = f.reviews.findIndex((review) => review.id === 20);
    if (appIndex < 0) throw new Error("App review missing");
    f.reviews.splice(appIndex, 1);
    withPrHistory(f, [roundThreeComment()]);
    const snapshot = await readSnapshot(f.config, 321);
    expect(snapshot.remediation).toMatchObject({ roundsConsumed: MAX_REMEDIATION_ROUNDS, paused: true, historyConsistent: true });
    const posts: string[] = [];
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "POST" && path.endsWith("/check-runs")) posts.push(path);
      return request<T>(path, options);
    };
    const prepared = await scanPullRequests(f.config, 321, true);
    expect(prepared).toEqual([expect.objectContaining({ pullRequest: 321, status: "remediation_paused" })]);
    expect(posts).toHaveLength(0);
    const results = await scanPullRequests(f.config, 321);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, status: "remediation_paused" })]);
    expect(results[0]).not.toMatchObject({ status: "review_in_progress" });
    expect(posts).toHaveLength(0);
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(false);
  });

  it("keeps the valid human route on inconsistent history but still enforces hard CI checks", async () => {
    const f = await serializedControllerFixture("browser");
    withPrHistory(f, [malformedHistoryComment()]);
    allowCheckRunWrites(f);
    const results = await scanPullRequests(f.config, 321);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    expect(f.pull.merged).toBe(true);

    const g = await serializedControllerFixture("browser");
    withPrHistory(g, [malformedHistoryComment()]);
    g.failValidation();
    allowCheckRunWrites(g);
    const blocked = await scanPullRequests(g.config, 321);
    expect(blocked[0]?.outcome).not.toBe("merge_candidate");
    expect(g.pull.merged).toBe(false);
    expect(g.stored()).toBeNull();
  });
});

describe("approval marker persistence", () => {
  function historyComment(change: string, round: number, outcome: "approve" | "request_changes"): GitHubComment {
    return {
      id: 90 + round,
      body: `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=${90 + round} head=${HEAD_SHA} base=${BASE_SHA} round=${round} diff=${change} outcome=${outcome} -->`,
      created_at: "2026-10-10T12:00:00.000Z",
      updated_at: "2026-10-10T12:00:00.000Z",
      user: { id: REVIEW_BOT_ACTOR_ID, login: "sayhear-pr-review-gate[bot]" },
    };
  }

  /**
   * Drives one real App approval through the retained-approval path and returns
   * the PR conversation comments. `channel: "legacy-root"` keeps the App's own
   * review the authorization channel, so the gate reaches merge_candidate
   * without a browser receipt.
   */
  async function approveFixture(
    options: Readonly<{ linkedIssue?: boolean; history?: (change: string) => readonly GitHubComment[] }> = {},
  ) {
    const f = await serializedControllerFixture("legacy-root", { linkedIssue: options.linkedIssue !== false });
    // History markers bind to the live change digest, so the round is read
    // from the seeded value rather than advancing on an unrelated digest.
    const seed = await readSnapshot(f.config, 321);
    const history = options.history?.(seed.diff.changeDigest) ?? [];
    const pages = f.api.pages.bind(f.api);
    f.api.pages = async <T>(path: string): Promise<T[]> =>
      path.endsWith("/issues/321/comments")
        ? [...structuredClone(history), ...structuredClone(f.comments.get(321)!)] as T[]
        : pages<T>(path);
    allowCheckRunWrites(f);
    return { ...f, seededChange: seed.diff.changeDigest };
  }

  function allowCheckRunWrites(f: Awaited<ReturnType<typeof serializedControllerFixture>>) {
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "PATCH" && path.endsWith("/check-runs/9002")) return {} as T;
      if (options?.method === "POST" && path.endsWith("/check-runs")) return { id: 9004 } as T;
      return request<T>(path, options);
    };
  }

  function prBodies(f: Awaited<ReturnType<typeof serializedControllerFixture>>): string[] {
    return f.comments.get(321)!.map((comment) => comment.body ?? "");
  }

  it("publishes the approval marker with outcome=approve and the preserved round", async () => {
    const f = await approveFixture({ history: (change) => [historyComment(change, 2, "request_changes")] });
    const snapshot = await readSnapshot(f.config, 321);
    expect(snapshot.remediationHistory.count).toBe(2);
    const results = await scanPullRequests(f.config, 321);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    const marker = prBodies(f).find((body) => body.includes("sayhear-pr-auto-approval-review:v1"));
    if (!marker) throw new Error("Expected a durable approval marker");
    // The round is carried forward, not consumed: the diff is unchanged, so
    // this approve neither advances nor exhausts the remediation budget.
    expect(marker).toContain(
      `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=20 head=${HEAD_SHA} base=${BASE_SHA} round=2 diff=${snapshot.diff.changeDigest} outcome=approve -->`,
    );
    expect(nextRequestChangeRound(snapshot.remediationHistory, snapshot.diff.changeDigest)).toBe(2);
    // A marker-only record: no pause, and no ready-for-agent flip by the
    // marker publish. Post-merge completion still closes the delivery Issue
    // and clears its status labels as its normal lifecycle.
    expect(marker).not.toContain("sayhear-pr-auto-approval-pause:v1");
    expect(f.issue.labels).not.toContain("ready-for-agent");
    expect(f.writes.some((write) => write.endsWith("/issues/42/labels"))).toBe(false);
    expect(f.issue.state).toBe("closed");
  });

  it("replaying the same review id posts no duplicate approval comment", async () => {
    const f = await approveFixture({ history: (change) => [historyComment(change, 2, "request_changes")] });
    const before = await readSnapshot(f.config, 321);
    expect(before.remediationHistory.count).toBe(2);
    await scanPullRequests(f.config, 321);
    const afterFirst = prBodies(f);
    expect(afterFirst).toHaveLength(1);
    expect(f.comments.get(42)).toHaveLength(1);
    // The round is carried forward, not consumed: MAX over {request_changes
    // round=2, approve round=2} stays 2 on the unchanged diff, and the same
    // retained review id resolves to the same marker key, so the ledger is
    // not written twice.
    const snapshot = await readSnapshot(f.config, 321);
    expect(snapshot.remediationHistory.count).toBe(2);
    const saved = await readSavedReviewReport(f.config, snapshot);
    if (!saved) throw new Error("Expected a saved review report");
    const replay = await reportReviewResult(f.config, saved.report);
    expect(replay.outcome).toBe("awaiting_verification");
    expect(replay.message).toContain("durable merge intent");
    expect(prBodies(f)).toEqual(afterFirst);
    // Exactly one comment POST: the approve marker from the first scan. The
    // replay early-returns on the durable merge intent before any publish.
    expect(f.writes.filter((write) => write.endsWith("/issues/321/comments") && write.startsWith("POST"))).toHaveLength(1);
  });

  it("keeps approve at round 3 free of any pause marker", async () => {
    const f = await approveFixture({ history: (change) => [historyComment(change, 3, "request_changes")] });
    const snapshot = await readSnapshot(f.config, 321);
    expect(snapshot.remediation).toMatchObject({ roundsConsumed: MAX_REMEDIATION_ROUNDS, historyConsistent: true });
    const results = await scanPullRequests(f.config, 321);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    const bodies = [...prBodies(f), ...f.comments.get(42)!.map((comment) => comment.body ?? "")];
    expect(bodies.some((body) => body.includes("sayhear-pr-auto-approval-pause:v1"))).toBe(false);
    // The saved-report path stays available at the budget ceiling and the
    // approval still records the MAX round it was reviewed at.
    expect(bodies.some((body) => body.includes(`round=${MAX_REMEDIATION_ROUNDS} diff=`) && body.includes("outcome=approve"))).toBe(true);
    expect(f.writes.some((write) => write.includes("/pulls/321/merge"))).toBe(true);
  });

  it("still emits the pause marker for a third blocking request_changes", async () => {
    const f = await serializedControllerFixture("legacy-root");
    // Keep the seeded pr-review-gate check run: readSavedReviewReport needs
    // the saved report it carries. Only the prior App review is removed so
    // the blocking request_changes posts a fresh review.
    f.reviews.splice(f.reviews.findIndex((review) => review.id === 20), 1);
    const baseline = await readSnapshot(f.config, 321);
    f.comments.set(321, [historyComment(baseline.diff.changeDigest, 3, "request_changes")]);
    const pages = f.api.pages.bind(f.api);
    f.api.pages = async <T>(path: string): Promise<T[]> =>
      path.endsWith("/issues/321/comments")
        ? [...structuredClone(f.comments.get(321)!)] as T[]
        : pages<T>(path);
    allowCheckRunWrites(f);
    const snapshot = await readSnapshot(f.config, 321);
    expect(snapshot.remediation).toMatchObject({ roundsConsumed: MAX_REMEDIATION_ROUNDS, historyConsistent: true });
    const saved = await readSavedReviewReport(f.config, snapshot);
    if (!saved) throw new Error("Expected a saved review report");
    const blocking = {
      ...saved.report,
      decision: "request_changes" as const,
      findings: [{ severity: "P2" as const, file: "scripts/pr-approval-controller.ts", line: 1,
        trigger: "marker", userImpact: "budget", evidence: "stub" }],
    };
    const request = f.api.request.bind(f.api);
    f.api.request = async <T>(path: string, options?: StubRequestOptions): Promise<T> => {
      if (options?.method === "POST" && path.endsWith("/pulls/321/reviews")) {
        const body = requestBody<{ event: string; body: string; commit_id: string }>(options);
        const review = { id: 20, state: "CHANGES_REQUESTED", commit_id: body.commit_id, body: body.body,
          user: { id: REVIEW_BOT_ACTOR_ID, login: "sayhear-pr-review-gate[bot]" } };
        f.reviews.push(review);
        return structuredClone(review) as T;
      }
      return request<T>(path, options);
    };
    const result = await reportReviewResult(f.config, blocking);
    expect(result.outcome).toBe("request_changes");
    const body = f.comments.get(321)!.at(-1)?.body ?? "";
    expect(body).toContain(`<!-- sayhear-pr-auto-approval-pause:v1 pr=321 active=true round=${MAX_REMEDIATION_ROUNDS} -->`);
    expect(f.issue.labels).toContain("ready-for-agent");
  });

  it("writes the PR comment only for a zero-Issue approve", async () => {
    const f = await approveFixture({ linkedIssue: false });
    const results = await scanPullRequests(f.config, 321);
    expect(results).toEqual([expect.objectContaining({ pullRequest: 321, outcome: "merge_candidate" })]);
    expect(f.stored()).toMatchObject({ phase: "complete", identity: { issueNumbers: [] } });
    expect(prBodies(f)).toHaveLength(1);
    expect(prBodies(f)[0]).toContain("outcome=approve");
    expect(f.comments.get(42)!).toHaveLength(0);
    expect(f.writes.some((write) => write.includes("/issues/42"))).toBe(false);
  });
});
