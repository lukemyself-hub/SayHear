import { generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  appReviewOutcomeForIdentity,
  completeIssueAfterApproval,
  completeLinkedIssuesAfterMerge,
  forEachLinkedIssue,
  handoffStalePullRequestBase,
  reconcileIssueCompletion,
  resolveLinkedIssues,
  createGitHubAppJwt,
  GitHubApiError,
  GitHubRestClient,
  nextRequestChangeRound,
  parseHumanReviewAuthorizations,
  matchHumanReviewAuthorization,
  isTrustedWorkflowVersion,
  isVercelDeploymentStatus,
  isReviewStillPending,
  parseModelReviewReport,
  parsePauseState,
  parseRequestChangeHistory,
  publishIssueHandoff,
  readBranchProtection,
  readCurrentPullRequestMergeSha,
  readIssueDependencies,
  readRepositoryMergeSettings,
  requestProtectedMerge,
  type GitHubApi,
  type GitHubComment,
  type ModelReviewReport,
} from "../scripts/pr-approval-controller.ts";
import {
  PR_REVIEW_GATE_POLICY_VERSION,
  PR_REVIEW_REPORT_VERSION,
  SAYHEAR_REPOSITORY_ID,
  requirementDigest,
  type PrReviewGateInput,
} from "../scripts/pr-review-gate.ts";

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
    private readonly pageValues: (path: string) => unknown[] = () => [],
  ) {}

  async request<T>(
    path: string,
    options?: StubRequestOptions,
  ): Promise<T> {
    return (await this.respond(path, options)) as T;
  }

  async pages<T>(path: string): Promise<T[]> {
    return this.pageValues(path) as T[];
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array();
  }
}

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
    } as Parameters<typeof resolveLinkedIssues>[1])).rejects.toThrow("at least one Issue");
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

  it("reads every required branch rule and fails closed when bypass actors cannot be read", async () => {
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
    await expect(readBranchProtection(unreadableRulesets)).resolves.toMatchObject({
      readable: false,
      protected: true,
    });
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

  it("counts changed PR content across base updates toward the three-round pause", () => {
    const comments = [
      {
        id: 1,
        body: `<!-- sayhear-pr-auto-approval-review:v1 pr=321 review=17 head=${HEAD_SHA} base=${BASE_SHA} round=2 diff=${CHANGE_DIGEST} outcome=request_changes -->`,
        created_at: "2026-10-10T12:00:00.000Z",
        updated_at: "2026-10-10T12:00:00.000Z",
        user: { id: 99, login: "review-app[bot]" },
      },
    ] satisfies GitHubComment[];
    const history = parseRequestChangeHistory(comments, 321, 99);

    expect(nextRequestChangeRound(history, CHANGE_DIGEST)).toBe(2);
    expect(nextRequestChangeRound(history, "e".repeat(64))).toBe(3);
    expect(
      nextRequestChangeRound(
        { ...history, latestBaseSha: "f".repeat(40) },
        "e".repeat(64),
      ),
    ).toBe(3);
    expect(
      nextRequestChangeRound(
        { ...history, latestBaseSha: "f".repeat(40) },
        CHANGE_DIGEST,
      ),
    ).toBe(2);
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
      body: "本 PR 不关闭也不修改 #44。", base: { ref: "main", sha: BASE_SHA },
      head: { sha: HEAD_SHA, repo: { id: SAYHEAR_REPOSITORY_ID } }, auto_merge: null,
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
      expect(comments.get(number)!.some((c) => c.user.id === REVIEW_BOT_ACTOR_ID && c.body?.includes("sayhear-pr-base-sync:v1") === true)).toBe(true);
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
      headRepositoryId: SAYHEAR_REPOSITORY_ID, authorId: 101, lastCommitAuthorId: 101,
      linkedIssueNumbers: [42, 43, 44, 45], keepOpenIssueNumbers: [44], issueClosureAmbiguous: false,
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
