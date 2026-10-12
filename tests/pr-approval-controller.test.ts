import { generateKeyPairSync, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  appReviewOutcomeForIdentity,
  completeIssueAfterApproval,
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

  it("closes an approved Issue and removes all execution and triage-state labels", async () => {
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
      autoMergeEnabled: true,
      merged: false,
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
