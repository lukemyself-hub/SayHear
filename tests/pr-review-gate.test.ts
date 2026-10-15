import { describe, expect, it } from "vitest";

import {
  FIXED_PR_CI_BASELINE,
  RELEASE_CHECKS,
  preMergeDeferralFor,
  type ReleaseImpactKind,
} from "../scripts/daily-release-validation.ts";
import {
  PR_REVIEW_GATE_POLICY_VERSION,
  PR_REVIEW_REPORT_VERSION,
  PR_VALIDATE_WORKFLOW_PATH,
  SAYHEAR_REPOSITORY_ID,
  SAYHEAR_REPOSITORY_NAME,
  evaluatePrReviewGate,
  integrationModeOf,
  parsePrReviewGateInput,
  requirementDigest,
  parseIssueClosureExclusions,
  closingKeywordIssueNumbers,
  type PreMergeDeferralRecord,
  type PrReviewGateInput,
  type TrustedPrReviewPolicy,
  type WorkflowEvidenceRecord,
} from "../scripts/pr-review-gate.ts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const MERGE_SHA = "c".repeat(40);
const WORKFLOW_BLOB_SHA = "d".repeat(40);
const ACTIONS_APP_ID = 15368;
const REVIEW_APP_ID = 98765;
const PR_332_OFFLINE_PATHS = [
  "eval/retrieval-precision-v1/README.md",
  "eval/retrieval-precision-v1/harness.ts",
  "tests/system/retrieval-precision-corpus.system.test.ts",
] as const;
const PR_332_APPROVED_TOOLING_PATHS = [
  "scripts/ci/system-suite-execution.ts",
  "tests/ci-system-suite-execution.test.ts",
] as const;

const policy: TrustedPrReviewPolicy = {
  repositoryId: SAYHEAR_REPOSITORY_ID,
  repositoryName: SAYHEAR_REPOSITORY_NAME,
  defaultBranch: "main",
  policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
  reviewAppId: REVIEW_APP_ID,
  actionsAppId: ACTIONS_APP_ID,
  validateWorkflowBlobSha: WORKFLOW_BLOB_SHA,
};

/**
 * The default-branch writer guard `serialized-merge` needs: one active branch
 * ruleset covering main that restricts updates and lets only the approval App
 * bypass it.
 */
const APP_ONLY_MAIN_WRITER_GUARD = {
  readable: true,
  restrictsDefaultBranchUpdates: true,
  bypassActorIds: [REVIEW_APP_ID],
  bypassActorsEnumerated: true,
  appBypassMode: "always",
  rulesetIds: [7],
} as const;

function makeEvidence(
  checkId: string,
  overrides: Partial<WorkflowEvidenceRecord> = {},
): WorkflowEvidenceRecord {
  return {
    checkId,
    result: "passed",
    source: {
      repositoryId: SAYHEAR_REPOSITORY_ID,
      appId: ACTIONS_APP_ID,
      event: "pull_request",
      workflowPath: PR_VALIDATE_WORKFLOW_PATH,
      workflowBlobSha: WORKFLOW_BLOB_SHA,
      runId: 1234,
      runAttempt: 1,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeSha: MERGE_SHA,
    },
    artifactSha256: null,
    coveredCheckIds: [],
    ...overrides,
  };
}

function makeDeferral(checkId: string): PreMergeDeferralRecord {
  const policy = preMergeDeferralFor(checkId);
  if (policy === null) throw new Error(`${checkId} is not a deferrable check`);
  return { kind: "deferred-before-merge", checkId, policy };
}

function rebindEvidence(
  record: WorkflowEvidenceRecord,
  headSha: string,
  mergeSha: string,
): WorkflowEvidenceRecord {
  return makeEvidence(record.checkId, {
    ...record,
    source: { ...record.source, headSha, mergeSha },
  });
}

type InputOverrides = Omit<
  Partial<PrReviewGateInput>,
  "repository" | "pullRequest" | "issue" | "review" | "branchProtection" | "runtime"
> & {
  repository?: Partial<PrReviewGateInput["repository"]>;
  pullRequest?: Partial<PrReviewGateInput["pullRequest"]>;
  issue?: Omit<Partial<PrReviewGateInput["issues"][number]>, "pause"> & {
    pause?: Partial<PrReviewGateInput["issues"][number]["pause"]>;
  };
  review?: Omit<
    Partial<PrReviewGateInput["review"]>,
    "capability" | "riskFlags"
  > & {
    capability?: Partial<PrReviewGateInput["review"]["capability"]>;
    riskFlags?: Partial<PrReviewGateInput["review"]["riskFlags"]>;
  };
  branchProtection?:
    | null
    | Partial<NonNullable<PrReviewGateInput["branchProtection"]>>;
  runtime?: Partial<PrReviewGateInput["runtime"]>;
};

function input(
  overrides: InputOverrides = {},
): PrReviewGateInput {
  const issue = {
    number: 42,
    state: "open" as const,
    title: "Fix the ordinary server path",
    body: "The service must return the existing record after retry.",
    updatedAt: "2026-10-10T12:00:00.000Z",
    discussionDigest: "2".repeat(64),
    labels: ["ongoing"],
    blockedBy: [],
    pause: { active: false, source: "none" as const },
  };
  const declaredImpacts: ReleaseImpactKind[] = ["server-business"];
  const evidence = [
    ...FIXED_PR_CI_BASELINE.map((checkId) => makeEvidence(checkId)),
    makeEvidence("server:deterministic-behavior", {
      artifactSha256: "e".repeat(64),
      coveredCheckIds: ["server:deterministic-behavior"],
    }),
  ];
  const base = {
    repository: {
      id: SAYHEAR_REPOSITORY_ID,
      fullName: SAYHEAR_REPOSITORY_NAME,
      defaultBranch: "main",
      defaultBranchSha: BASE_SHA,
      allowAutoMerge: true,
    },
    pullRequest: {
      number: 321,
      state: "open",
      draft: false,
      title: "Fix the ordinary server path",
      body: "Fixes #42",
      updatedAt: "2026-10-10T12:00:00.000Z",
      discussionDigest: "1".repeat(64),
      externalReviewState: "clear",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      mergeSha: MERGE_SHA,
      baseRef: "main",
      headRepositoryId: SAYHEAR_REPOSITORY_ID,
      authorId: 101,
      lastCommitAuthorId: 102,
      linkedIssueNumbers: [42],
      keepOpenIssueNumbers: [],
      issueClosureAmbiguous: false,
      closingIssueNumbers: [],
      changedFiles: [
        { path: "packages/application/src/server/fix.ts", status: "modified" },
      ],
    },
    issues: [issue],
    review: {
      version: PR_REVIEW_REPORT_VERSION,
      repositoryId: SAYHEAR_REPOSITORY_ID,
      pullRequestNumber: 321,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      policyVersion: PR_REVIEW_GATE_POLICY_VERSION,
      requirementDigest: requirementDigest(issue, {
        number: 321,
        title: "Fix the ordinary server path",
        body: "Fixes #42",
        updatedAt: "2026-10-10T12:00:00.000Z",
        discussionDigest: "1".repeat(64),
      }),
      decision: "approve",
      diffComplete: true,
      reviewerAppId: REVIEW_APP_ID,
      reviewerActorId: 303,
      declaredImpacts,
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
    },
    evidence,
    branchProtection: {
      readable: true,
      protected: true,
      branch: "main",
      requiresUpToDate: true,
      dismissesStaleReviews: true,
      enforcesAdmins: true,
      requiredApprovingReviews: 1,
      requiredChecks: [
        { name: "validate", appId: ACTIONS_APP_ID },
        { name: "pr-review-gate", appId: REVIEW_APP_ID },
      ],
      bypassActorIds: [],
    },
    runtime: {
      reviewAppInstalledForRepository: true,
      anotherApprovalInFlight: false,
      productionMergeAuthorized: null,
      ordinaryMergeTriggersProduction: false,
    },
  } satisfies PrReviewGateInput;
  return {
    ...base,
    ...overrides,
    repository: { ...base.repository, ...overrides.repository },
    pullRequest: { ...base.pullRequest, ...overrides.pullRequest },
    issues: overrides.issues ?? [{
      ...base.issues[0]!,
      ...overrides.issue,
      pause: { ...base.issues[0]!.pause, ...overrides.issue?.pause },
    }],
    review: {
      ...base.review,
      ...overrides.review,
      capability: {
        ...base.review.capability,
        ...overrides.review?.capability,
      },
      riskFlags: {
        ...base.review.riskFlags,
        ...overrides.review?.riskFlags,
      },
    },
    branchProtection:
      overrides.branchProtection === null
        ? null
        : {
            ...base.branchProtection,
            ...overrides.branchProtection,
          },
    runtime: { ...base.runtime, ...overrides.runtime },
    evidence: overrides.evidence ?? base.evidence,
  };
}

describe("PR review gate", () => {
  it("locates the exact offline and approved tooling paths from PR #332", () => {
    const changedFiles = [
      ...PR_332_OFFLINE_PATHS,
      ...PR_332_APPROVED_TOOLING_PATHS,
    ].map((path) => ({ path, status: "modified" as const }));
    const approved = {
      ...policy,
      humanApprovedPaths: [...PR_332_APPROVED_TOOLING_PATHS],
      humanApprovedNoRuntimeImpact: true,
    };
    const result = evaluatePrReviewGate(input({
      pullRequest: { changedFiles },
      review: { declaredImpacts: [] },
      evidence: FIXED_PR_CI_BASELINE.map((id) => makeEvidence(id)),
    }), approved);

    expect(result.outcome).toBe("merge_candidate");
    expect(result.requiredEvidenceIds).toEqual([...FIXED_PR_CI_BASELINE]);
  });

  it("keeps fixed CI and rejects unlisted eval or unauthorized tooling paths", () => {
    const approved = {
      ...policy,
      humanApprovedPaths: [...PR_332_APPROVED_TOOLING_PATHS],
      humanApprovedNoRuntimeImpact: true,
    };
    const allowedPaths = [
      ...PR_332_OFFLINE_PATHS,
      ...PR_332_APPROVED_TOOLING_PATHS,
    ];
    const unknownPaths = [
      "eval/unlisted/new-harness.ts",
      "scripts/ci/unapproved-helper.ts",
    ];
    for (const path of unknownPaths) {
      const changedFiles = [
        ...allowedPaths.map((allowedPath) => ({
          path: allowedPath,
          status: "modified" as const,
        })),
        { path, status: "modified" as const },
      ];
      const result = evaluatePrReviewGate(input({
        pullRequest: { changedFiles },
        review: { declaredImpacts: [] },
        evidence: FIXED_PR_CI_BASELINE.map((id) => makeEvidence(id)),
      }), approved);
      expect(["awaiting_verification", "human_decision"]).toContain(result.outcome);
    }
    expect(evaluatePrReviewGate(input({
      pullRequest: {
        changedFiles: allowedPaths.map((path) => ({
          path,
          status: "modified" as const,
        })),
      },
      review: { declaredImpacts: [] },
      evidence: [],
    }), approved).outcome).toBe("awaiting_verification");
  });

  it("keeps a protected path approval-gated inside an otherwise located diff", () => {
    const protectedPath = "scripts/ci/system-suite-execution.ts";
    const changedFiles = [
      ...PR_332_OFFLINE_PATHS.map((path) => ({
        path,
        status: "modified" as const,
      })),
      { path: protectedPath, status: "modified" as const },
    ];
    const report = evaluatePrReviewGate(input({
      pullRequest: { changedFiles },
      review: { declaredImpacts: [] },
      evidence: FIXED_PR_CI_BASELINE.map((id) => makeEvidence(id)),
    }), {
      ...policy,
      humanApprovedPaths: [],
      humanApprovedNoRuntimeImpact: true,
    });

    expect(report.outcome).toBe("human_decision");
    expect(report.reasons[0]?.code).toBe("human_review_required");
  });

  it("requires normal targeted evidence when a bound no-runtime diff also changes runtime code", () => {
    const changedPaths = [
      ...PR_332_OFFLINE_PATHS,
      ...PR_332_APPROVED_TOOLING_PATHS,
      "packages/application/src/server/ordinary-change.ts",
    ];
    const changedFiles = changedPaths.map((path) => ({
      path,
      status: "modified" as const,
    }));
    const result = evaluatePrReviewGate(input({
      pullRequest: { changedFiles },
      review: { declaredImpacts: ["server-business"] },
      evidence: FIXED_PR_CI_BASELINE.map((id) => makeEvidence(id)),
    }), {
      ...policy,
      humanApprovedPaths: [...PR_332_APPROVED_TOOLING_PATHS],
      humanApprovedNoRuntimeImpact: true,
    });

    expect(result.outcome).toBe("awaiting_verification");
    expect(result.requiredEvidenceIds).toContain("server:deterministic-behavior");
  });

  it("requires a trusted exact no-runtime decision for approval tooling", () => {
    const paths = ["scripts/pr-approval-controller.ts", "package.json"];
    const changedFiles = paths.map((path) => ({ path, status: "modified" as const }));
    const candidate = input({ pullRequest: { changedFiles }, review: { declaredImpacts: [] } });
    const approved = { ...policy, humanApprovedPaths: paths, humanApprovedNoRuntimeImpact: true };
    expect(evaluatePrReviewGate(candidate, { ...approved, humanApprovedNoRuntimeImpact: false }).outcome)
      .toBe("awaiting_verification");
    const result = evaluatePrReviewGate(candidate, approved);
    expect(result.outcome).toBe("merge_candidate");
    expect(result.requiredEvidenceIds).toEqual([...FIXED_PR_CI_BASELINE]);
    expect(evaluatePrReviewGate({ ...candidate, evidence: [] }, approved).outcome)
      .toBe("awaiting_verification");
    expect(evaluatePrReviewGate(input({ pullRequest: { changedFiles }, review: {
      declaredImpacts: [], riskFlags: { privacyBoundaryChanged: true },
    } }), approved).outcome).toBe("human_decision");
    expect(evaluatePrReviewGate(input({ pullRequest: { changedFiles }, review: {
      declaredImpacts: [], decision: "request_changes",
      findings: [{ severity: "P2", file: paths[0]!, line: 1, trigger: "Broken gate", userImpact: "Incorrect approval", evidence: "Review finding" }],
    } }), approved).outcome).toBe("request_changes");
  });

  it.each(["apps/web/custom-helper.ts", "packages/data/src/custom-helper.ts", "eval/new-tool.ts", "unknown-file.txt"])(
    "does not locate runtime or unknown path %s with a no-runtime decision", (path) => {
      const changedFiles = [{ path, status: "modified" as const }];
      expect(evaluatePrReviewGate(input({ pullRequest: { changedFiles }, review: { declaredImpacts: [] } }), {
        ...policy, humanApprovedPaths: [path], humanApprovedNoRuntimeImpact: true,
      }).outcome).toBe("awaiting_verification");
    },
  );

  it("does not locate unapproved tooling paths with another path's no-runtime decision", () => {
    const changedFiles = [{ path: "scripts/new-helper.ts", status: "modified" as const }];
    expect(evaluatePrReviewGate(input({ pullRequest: { changedFiles }, review: { declaredImpacts: [] } }), {
      ...policy, humanApprovedPaths: ["scripts/old-helper.ts"], humanApprovedNoRuntimeImpact: true,
    }).outcome).toBe("awaiting_verification");
  });

  it("keeps targeted evidence required for a bound tooling decision", () => {
    const path = "scripts/prompt-budget-tool.ts";
    const result = evaluatePrReviewGate(input({
      pullRequest: { changedFiles: [{ path, status: "modified" }] },
      review: { declaredImpacts: [] },
      evidence: FIXED_PR_CI_BASELINE.map((id) => makeEvidence(id)),
    }), { ...policy, humanApprovedPaths: [path], humanApprovedNoRuntimeImpact: true });
    expect(result.outcome).toBe("awaiting_verification");
    expect(result.requiredEvidenceIds).toContain("prompt-budget:effective-config-diff");
  });

  it("accepts only exact human-approved paths and keeps other risk gates", () => {
    const path = "docs/adr/0151-platform.md";
    const approved = { ...policy, humanApprovedPaths: [path] };
    const changedFiles = [{ path, status: "modified" as const }];
    expect(evaluatePrReviewGate(input({ pullRequest: { changedFiles } }), approved).outcome)
      .toBe("merge_candidate");
    expect(evaluatePrReviewGate(input({ pullRequest: { changedFiles: [
      ...changedFiles, { path: "docs/adr/another.md", status: "modified" },
    ] } }), approved).outcome).toBe("human_decision");
    expect(evaluatePrReviewGate(input({ pullRequest: { changedFiles },
      review: { riskFlags: { privacyBoundaryChanged: true } } }), approved).outcome)
      .toBe("human_decision");
    expect(evaluatePrReviewGate(input({ pullRequest: { changedFiles }, evidence: [] }), approved).outcome)
      .toBe("awaiting_verification");
  });

  it("requires the existing portal smoke only for Portal UI paths", () => {
    const withPortalUi = evaluatePrReviewGate(
      input({
        pullRequest: {
          changedFiles: [
            { path: "apps/web/app/internal/journal-card.tsx", status: "modified" },
          ],
        },
      }),
      policy,
    );
    expect(withPortalUi.requiredEvidenceIds).toContain("ui:portal-smoke");

    const withServerOnly = evaluatePrReviewGate(
      input({
        pullRequest: {
          changedFiles: [
            { path: "apps/web/app/api/internal/recovery/scan/route.ts", status: "modified" },
            { path: "apps/web/src/recovery-scanner-handler.ts", status: "modified" },
            { path: "apps/web/src/server-composition.ts", status: "modified" },
          ],
        },
      }),
      policy,
    );
    expect(withServerOnly.requiredEvidenceIds).not.toContain("ui:browser-smoke:desktop");
    expect(withServerOnly.requiredEvidenceIds).not.toContain("ui:browser-smoke:mobile");
    expect(withServerOnly.requiredEvidenceIds).not.toContain("ui:portal-smoke");
  });

  it("never requires a check id that the release catalog does not define", () => {
    for (const path of [
      "apps/web/app/internal/journal-card.tsx",
      "apps/web/app/internal/portal-integration.ts",
      "apps/web/app/page.tsx",
      "apps/web/app/styles.css",
      "apps/web/app/api/internal/recovery/scan/route.ts",
      "apps/web/src/server-composition.ts",
      "apps/web/src/candidate-review-copy.ts",
    ]) {
      const report = evaluatePrReviewGate(
        input({ pullRequest: { changedFiles: [{ path, status: "modified" }] } }),
        policy,
      );
      for (const id of report.requiredEvidenceIds) {
        expect(RELEASE_CHECKS.some((check) => check.id === id)).toBe(true);
      }
    }
  });

  it("returns a read-only merge candidate only when the bound evidence is complete", () => {
    const report = evaluatePrReviewGate(input(), policy);

    expect(report.outcome).toBe("merge_candidate");
    expect(report.mode).toBe("read-only");
    expect(report.headSha).toBe(HEAD_SHA);
    expect(report.baseSha).toBe(BASE_SHA);
    expect(report.requiredEvidenceIds).toEqual([
      ...FIXED_PR_CI_BASELINE,
      "server:deterministic-behavior",
    ]);
    expect(report.acceptedEvidenceIds).toEqual(report.requiredEvidenceIds);
  });

  it("rejects a review report from an older head", () => {
    const report = evaluatePrReviewGate(
      input({
        pullRequest: { headSha: "f".repeat(40) },
      }),
      policy,
    );

    expect(report.outcome).toBe("awaiting_verification");
    expect(report.reasons[0]?.code).toBe("stale_review");
  });

  it("rejects a report after the base branch advances", () => {
    const report = evaluatePrReviewGate(
      input({
        repository: { defaultBranchSha: "f".repeat(40) },
      }),
      policy,
    );

    expect(report.outcome).toBe("awaiting_verification");
    expect(report.reasons[0]?.code).toBe("base_or_merge_ref_changed");
  });

  it("approves a merge-queue candidate whose base is behind main", () => {
    const report = evaluatePrReviewGate(
      input({
        repository: { defaultBranchSha: "f".repeat(40) },
        pullRequest: { mergeable: true, mergeableState: "clean" },
        runtime: { integrationMode: "merge-queue", mergeQueueAvailable: true },
      }),
      policy,
    );

    expect(report.outcome).toBe("merge_candidate");
    expect(report.reasons.map((reason) => reason.code)).not.toContain(
      "base_or_merge_ref_changed",
    );
  });

  it("keeps two PRs on the same older main as independent merge candidates", () => {
    const otherHead = "9".repeat(40);
    const otherMerge = "8".repeat(40);
    const staleMain = { defaultBranchSha: "f".repeat(40) };
    const queue = {
      integrationMode: "merge-queue" as const,
      mergeQueueAvailable: true,
    };
    const first = evaluatePrReviewGate(
      input({
        repository: staleMain,
        pullRequest: { mergeable: true, mergeableState: "clean" },
        runtime: queue,
      }),
      policy,
    );
    const second = evaluatePrReviewGate(
      input({
        repository: staleMain,
        pullRequest: {
          number: 322,
          headSha: otherHead,
          mergeSha: otherMerge,
          mergeable: true,
          mergeableState: "clean",
        },
        review: {
          pullRequestNumber: 322,
          headSha: otherHead,
          requirementDigest: requirementDigest(input().issues, {
            number: 322,
            title: "Fix the ordinary server path",
            body: "Fixes #42",
            updatedAt: "2026-10-10T12:00:00.000Z",
            discussionDigest: "1".repeat(64),
          }),
        },
        evidence: (
          [
            ...FIXED_PR_CI_BASELINE.map((checkId) => makeEvidence(checkId)),
            makeEvidence("server:deterministic-behavior", {
              artifactSha256: "e".repeat(64),
              coveredCheckIds: ["server:deterministic-behavior"],
            }),
          ] satisfies WorkflowEvidenceRecord[]
        ).map((record) => rebindEvidence(record, otherHead, otherMerge)),
        runtime: queue,
      }),
      policy,
    );

    // Two different heads, one shared older base, and no serialization between
    // them: neither PR blocks the other while main has already moved on.
    expect(first.outcome).toBe("merge_candidate");
    expect(second.outcome).toBe("merge_candidate");
    expect(first.headSha).not.toBe(second.headSha);
    expect(first.baseSha).toBe(BASE_SHA);
    expect(second.baseSha).toBe(BASE_SHA);
  });

  it("keeps the up-to-date rule unless the runtime opts into the queue", () => {
    const report = evaluatePrReviewGate(
      input({
        repository: { defaultBranchSha: "f".repeat(40) },
        pullRequest: { mergeable: true, mergeableState: "clean" },
        runtime: { integrationMode: "up-to-date-base", mergeQueueAvailable: true },
      }),
      policy,
    );

    expect(report.outcome).toBe("awaiting_verification");
    expect(report.reasons[0]?.code).toBe("base_or_merge_ref_changed");
  });

  it("blocks a merge-queue candidate that conflicts with main", () => {
    const report = evaluatePrReviewGate(
      input({
        pullRequest: { mergeable: false, mergeableState: "dirty" },
        runtime: { integrationMode: "merge-queue", mergeQueueAvailable: true },
      }),
      policy,
    );

    expect(report.outcome).toBe("awaiting_verification");
    expect(report.reasons[0]?.code).toBe("pull_request_conflict");
  });

  it("waits rather than approving while mergeability is unreported", () => {
    const unreported = [
      { mergeable: null as boolean | null },
      {},
    ];
    for (const pullRequest of unreported) {
      const report = evaluatePrReviewGate(
        input({
          pullRequest,
          runtime: { integrationMode: "merge-queue", mergeQueueAvailable: true },
        }),
        policy,
      );

      expect(report.outcome).toBe("awaiting_verification");
      expect(report.reasons[0]?.code).toBe("mergeability_unknown");
    }
  });

  it("refuses merge-queue integration while main serves no merge queue", () => {
    for (const runtime of [
      { integrationMode: "merge-queue" as const },
      { integrationMode: "merge-queue" as const, mergeQueueAvailable: false },
      { integrationMode: "merge-queue" as const, mergeQueueAvailable: null },
    ]) {
      const report = evaluatePrReviewGate(
        input({
          pullRequest: { mergeable: true, mergeableState: "clean" },
          runtime,
        }),
        policy,
      );

      expect(report.outcome).toBe("human_decision");
      expect(report.reasons[0]?.code).toBe("merge_queue_unavailable");
    }
  });

  it("approves a serialized-merge candidate whose base is behind main", () => {
    const report = evaluatePrReviewGate(
      input({
        repository: { defaultBranchSha: "f".repeat(40) },
        pullRequest: { mergeable: true, mergeableState: "behind" },
        branchProtection: { requiresUpToDate: false },
        runtime: {
          integrationMode: "serialized-merge",
          mainWriterGuard: APP_ONLY_MAIN_WRITER_GUARD,
        },
      }),
      policy,
    );

    expect(report.outcome).toBe("merge_candidate");
    expect(report.reasons.map((reason) => reason.code)).not.toContain(
      "base_or_merge_ref_changed",
    );
  });

  it("does not demand a served merge queue for serialized-merge", () => {
    for (const runtime of [
      {
        integrationMode: "serialized-merge" as const,
        mainWriterGuard: APP_ONLY_MAIN_WRITER_GUARD,
      },
      {
        integrationMode: "serialized-merge" as const,
        mergeQueueAvailable: false,
        mainWriterGuard: APP_ONLY_MAIN_WRITER_GUARD,
      },
      {
        integrationMode: "serialized-merge" as const,
        mergeQueueAvailable: null,
        mainWriterGuard: APP_ONLY_MAIN_WRITER_GUARD,
      },
    ]) {
      const report = evaluatePrReviewGate(
        input({
          repository: { defaultBranchSha: "f".repeat(40) },
          pullRequest: { mergeable: true, mergeableState: "behind" },
          branchProtection: { requiresUpToDate: false },
          runtime,
        }),
        policy,
      );

      expect(report.outcome).toBe("merge_candidate");
      expect(report.reasons.map((reason) => reason.code)).not.toContain(
        "merge_queue_unavailable",
      );
    }
  });

  it("refuses serialized-merge while main still requires an up-to-date branch", () => {
    const report = evaluatePrReviewGate(
      input({
        repository: { defaultBranchSha: "f".repeat(40) },
        pullRequest: { mergeable: true, mergeableState: "clean" },
        branchProtection: { requiresUpToDate: true },
        runtime: {
          integrationMode: "serialized-merge",
          mainWriterGuard: APP_ONLY_MAIN_WRITER_GUARD,
        },
      }),
      policy,
    );

    expect(report.outcome).toBe("human_decision");
    expect(report.reasons[0]?.code).toBe("requires_up_to_date_still_enabled");
  });

  it("blocks serialized-merge candidates that conflict or report no mergeability", () => {
    const conflicted = evaluatePrReviewGate(
      input({
        pullRequest: { mergeable: false, mergeableState: "dirty" },
        branchProtection: { requiresUpToDate: false },
        runtime: {
          integrationMode: "serialized-merge",
          mainWriterGuard: APP_ONLY_MAIN_WRITER_GUARD,
        },
      }),
      policy,
    );
    expect(conflicted.outcome).toBe("awaiting_verification");
    expect(conflicted.reasons[0]?.code).toBe("pull_request_conflict");

    for (const pullRequest of [
      { mergeable: null as boolean | null },
      {},
    ]) {
      const report = evaluatePrReviewGate(
        input({
          pullRequest,
          branchProtection: { requiresUpToDate: false },
          runtime: {
            integrationMode: "serialized-merge",
            mainWriterGuard: APP_ONLY_MAIN_WRITER_GUARD,
          },
        }),
        policy,
      );

      expect(report.outcome).toBe("awaiting_verification");
      expect(report.reasons[0]?.code).toBe("mergeability_unknown");
    }
  });

  it("approves a head-bound candidate whose own required check still blocks GitHub", () => {
    // This check run is one of main's required checks, so GitHub reports
    // `blocked` for the whole review window, and `unknown`/`unstable` while it
    // recomputes. Requiring `clean` here would deadlock every PR: the check can
    // only turn green once this branch approves. The clean/behind state is
    // therefore enforced at merge time, where it is actually observable.
    for (const mergeableState of [
      "blocked",
      "unknown",
      "unstable",
      "dirty",
      "behind",
    ]) {
      const report = evaluatePrReviewGate(
        input({
          repository: { defaultBranchSha: "f".repeat(40) },
          pullRequest: { mergeable: true, mergeableState },
          branchProtection: { requiresUpToDate: false },
          runtime: {
            integrationMode: "serialized-merge",
            mainWriterGuard: APP_ONLY_MAIN_WRITER_GUARD,
          },
        }),
        policy,
      );

      expect(report.outcome).toBe("merge_candidate");
    }
  });

  it("refuses serialized-merge until main is updatable only by the approval App", () => {
    const cases: readonly [
      Exclude<PrReviewGateInput["runtime"]["mainWriterGuard"], undefined>,
      string,
    ][] = [
      [null, "main_writer_guard_unreadable"],
      [
        { ...APP_ONLY_MAIN_WRITER_GUARD, readable: false },
        "main_writer_guard_unreadable",
      ],
      [
        { ...APP_ONLY_MAIN_WRITER_GUARD, restrictsDefaultBranchUpdates: false },
        "main_writer_guard_missing",
      ],
      // GitHub hides `bypass_actors` from callers without administration
      // access. An unreadable bypass set is unproven, never "nobody".
      [
        { ...APP_ONLY_MAIN_WRITER_GUARD, bypassActorsEnumerated: false },
        "main_writer_guard_bypass_actors_unreadable",
      ],
      [
        {
          ...APP_ONLY_MAIN_WRITER_GUARD,
          bypassActorIds: [],
          bypassActorsEnumerated: false,
        },
        "main_writer_guard_bypass_actors_unreadable",
      ],
      [
        { ...APP_ONLY_MAIN_WRITER_GUARD, bypassActorIds: [] },
        "main_writer_guard_bypass_actors",
      ],
      [
        { ...APP_ONLY_MAIN_WRITER_GUARD, bypassActorIds: [REVIEW_APP_ID, 42] },
        "main_writer_guard_bypass_actors",
      ],
      [
        { ...APP_ONLY_MAIN_WRITER_GUARD, bypassActorIds: [42] },
        "main_writer_guard_bypass_actors",
      ],
    ];

    for (const [mainWriterGuard, code] of cases) {
      const report = evaluatePrReviewGate(
        input({
          pullRequest: { mergeable: true, mergeableState: "clean" },
          branchProtection: { requiresUpToDate: false },
          runtime: { integrationMode: "serialized-merge", mainWriterGuard },
        }),
        policy,
      );

      expect(report.outcome).toBe("human_decision");
      expect(report.reasons[0]?.code).toBe(code);
    }
  });

  it("fails closed when serialized-merge omits the main writer guard", () => {
    const report = evaluatePrReviewGate(
      input({
        pullRequest: { mergeable: true, mergeableState: "clean" },
        branchProtection: { requiresUpToDate: false },
        runtime: { integrationMode: "serialized-merge" },
      }),
      policy,
    );

    expect(report.outcome).toBe("human_decision");
    expect(report.reasons[0]?.code).toBe("main_writer_guard_unreadable");
  });

  it("rules out branch-protection bypass actors other than the approval App", () => {
    // Any second bypass actor can move main outside this controller, so it is a
    // human decision.
    const bypassed = input({
      branchProtection: {
        requiresUpToDate: true,
        bypassActorIds: [42],
      },
    });
    const report = evaluatePrReviewGate(bypassed, policy);
    expect(report.outcome).toBe("human_decision");
    expect(report.reasons[0]?.code).toBe("branch_protection_incomplete");

    const mixed = input({
      branchProtection: {
        requiresUpToDate: true,
        bypassActorIds: [REVIEW_APP_ID, 42],
      },
    });
    expect(evaluatePrReviewGate(mixed, policy).reasons[0]?.code).toBe(
      "branch_protection_incomplete",
    );
  });

  it("accepts the approval App itself as a branch-protection bypass actor", () => {
    // The App has to merge, so Luke's ruleset legitimately grants it a bypass.
    const report = evaluatePrReviewGate(
      input({
        branchProtection: {
          requiresUpToDate: true,
          bypassActorIds: [REVIEW_APP_ID],
        },
      }),
      policy,
    );

    expect(report.outcome).toBe("merge_candidate");
  });

  it("validates the main writer guard at the input boundary", () => {
    const candidate = input();
    const parsed = parsePrReviewGateInput({
      ...candidate,
      runtime: {
        ...candidate.runtime,
        integrationMode: "serialized-merge",
        mainWriterGuard: APP_ONLY_MAIN_WRITER_GUARD,
      },
    });

    expect(parsed.runtime.mainWriterGuard).toEqual(APP_ONLY_MAIN_WRITER_GUARD);
    expect(
      parsePrReviewGateInput(candidate).runtime.mainWriterGuard,
    ).toBeUndefined();
    expect(() =>
      parsePrReviewGateInput({
        ...candidate,
        runtime: {
          ...candidate.runtime,
          mainWriterGuard: { ...APP_ONLY_MAIN_WRITER_GUARD, readable: "yes" },
        },
      }),
    ).toThrow(/mainWriterGuard/);
    // A snapshot that never says whether the bypass set was enumerable cannot
    // be read as an App-only main.
    expect(() =>
      parsePrReviewGateInput({
        ...candidate,
        runtime: {
          ...candidate.runtime,
          mainWriterGuard: {
            readable: true,
            restrictsDefaultBranchUpdates: true,
            bypassActorIds: [REVIEW_APP_ID],
            rulesetIds: [7],
          },
        },
      }),
    ).toThrow(/bypassActorsEnumerated/);
    expect(() =>
      parsePrReviewGateInput({
        ...candidate,
        runtime: { ...candidate.runtime, mainWriterGuard: 7 },
      }),
    ).toThrow(/mainWriterGuard/);
  });

  it("validates the integration mode at the input boundary", () => {
    const candidate = input();
    expect(() =>
      parsePrReviewGateInput({
        ...candidate,
        runtime: { ...candidate.runtime, integrationMode: "fast-lane" },
      }),
    ).toThrow(/integrationMode/);

    const parsed = parsePrReviewGateInput(candidate);
    expect(parsed.runtime.integrationMode).toBeUndefined();
    expect(parsed.runtime.mergeQueueAvailable).toBeUndefined();
    expect(integrationModeOf(parsed)).toBe("up-to-date-base");
    expect(
      integrationModeOf({
        ...parsed,
        runtime: { ...parsed.runtime, integrationMode: "merge-queue" },
      }),
    ).toBe("merge-queue");
    expect(
      integrationModeOf({
        ...parsed,
        runtime: { ...parsed.runtime, integrationMode: "serialized-merge" },
      }),
    ).toBe("serialized-merge");
  });

  it("does not accept a same-named check from an untrusted app", () => {
    const evidence = input().evidence.map((entry, index) =>
      index === 0 && entry.kind !== "deferred-before-merge"
        ? { ...entry, source: { ...entry.source, appId: 77 } }
        : entry,
    );
    const report = evaluatePrReviewGate(input({ evidence }), policy);

    expect(report.outcome).toBe("awaiting_verification");
    expect(report.reasons[0]?.code).toBe("required_evidence_missing");
  });

  it.each(["skipped", "cancelled", "neutral", "planned", "out-of-scope"] as const)(
    "does not treat %s evidence as a pass",
    (result) => {
      const evidence = input().evidence.map((entry, index) =>
        index === 0 && entry.kind !== "deferred-before-merge"
          ? { ...entry, result }
          : entry,
      );
      const report = evaluatePrReviewGate(input({ evidence }), policy);

      expect(report.outcome).toBe("awaiting_verification");
      expect(report.reasons[0]?.code).toBe("required_evidence_missing");
    },
  );

  it("keeps Draft PRs out of approval", () => {
    const report = evaluatePrReviewGate(
      input({ pullRequest: { draft: true } }),
      policy,
    );

    expect(report.outcome).toBe("awaiting_verification");
    expect(report.reasons[0]?.code).toBe("pr_not_ready");
  });

  it.each([
    "scripts/pr-approval-launcher.c",
    "scripts/build-pr-approval-controller.mjs",
    "tests/pr-approval-controller.test.ts",
    "scripts/capture-g1-role-provider-calls.ts",
    ".github/workflows/pr-validate.yml",
    "scripts/ci/verify-test-databases.ts",
    "scripts/pr-review-gate.ts",
    "package.json",
    "docs/product/19-privacy-and-trust.md",
    "docs/adr/0151-example.md",
  ])("routes changes to protected policy file %s to a human", (path) => {
    const report = evaluatePrReviewGate(
      input({
        pullRequest: {
          changedFiles: [{ path, status: "modified" }],
        },
      }),
      policy,
    );

    expect(report.outcome).toBe("human_decision");
    expect(report.reasons[0]?.code).toBe("human_review_required");
  });

  it("routes a removed test file to a human", () => {
    const report = evaluatePrReviewGate(
      input({
        pullRequest: {
          changedFiles: [
            { path: "tests/system/example.system.test.ts", status: "removed" },
          ],
        },
      }),
      policy,
    );

    expect(report.outcome).toBe("human_decision");
  });

  function multiIssueInput(): PrReviewGateInput {
    const original = input();
    const issues = [original.issues[0]!, { ...original.issues[0]!, number: 43, title: "Second requirement", body: "Preserve the second contract." }];
    const pullRequest = { ...original.pullRequest, linkedIssueNumbers: [42, 43], body: "Fixes #42 and #43" };
    return { ...original, issues, pullRequest,
      review: { ...original.review, requirementDigest: requirementDigest(issues, pullRequest) } };
  }

  it("approves a complete multi-Issue PR and supports dependencies delivered together", () => {
    const candidate = multiIssueInput();
    const issues = [candidate.issues[0]!, { ...candidate.issues[1]!, blockedBy: [42] }];
    expect(evaluatePrReviewGate({ ...candidate, issues }, policy).outcome).toBe("merge_candidate");
    expect(parsePrReviewGateInput(candidate).issues.map((issue) => issue.number)).toEqual([42, 43]);
    expect(requirementDigest([...issues].reverse(), candidate.pullRequest)).toBe(candidate.review.requirementDigest);
  });

  it.each(["body", "discussionDigest", "title"] as const)("invalidates a review after a second Issue %s changes", (field) => {
    const candidate = multiIssueInput();
    const issues = [candidate.issues[0]!, { ...candidate.issues[1]!, [field]: "Changed requirement" }];
    expect(evaluatePrReviewGate({ ...candidate, issues }, policy).reasons[0]?.code).toBe("requirements_changed");
  });

  it("blocks a paused second Issue, outside dependencies and unclaimed work", () => {
    const candidate = multiIssueInput();
    for (const patch of [{ pause: { active: true, source: "maintainer" as const } }, { blockedBy: [19] }]) {
      expect(evaluatePrReviewGate({ ...candidate, issues: [candidate.issues[0]!, { ...candidate.issues[1]!, ...patch }] }, policy).outcome).toBe("human_decision");
    }
    expect(evaluatePrReviewGate({ ...candidate, issues: [candidate.issues[0]!, { ...candidate.issues[1]!, labels: [] }] }, policy).reasons[0]?.code).toBe("issue_not_claimed");
    expect(evaluatePrReviewGate({ ...candidate, issues: [candidate.issues[0]!, { ...candidate.issues[1]!, blockedBy: null }] }, policy).reasons[0]?.code).toBe("github_context_unavailable");
  });

  it("keeps closed Issues as requirements without requiring their execution labels", () => {
    const candidate = multiIssueInput();
    const issues = [candidate.issues[0]!, { ...candidate.issues[1]!, state: "closed" as const, labels: [], blockedBy: null }];
    expect(evaluatePrReviewGate({ ...candidate, issues }, policy).outcome).toBe("merge_candidate");
    expect(evaluatePrReviewGate({ ...candidate, issues: issues.map((issue) => ({ ...issue, state: "closed" })) }, policy).outcome).toBe("human_decision");
  });

  it("rejects duplicate or incomplete Issue sets rather than silently omitting requirements", () => {
    const candidate = multiIssueInput();
    for (const issues of [[], [candidate.issues[0]!], [candidate.issues[0]!, candidate.issues[0]!]]) {
      const changed = { ...candidate, issues, review: { ...candidate.review, requirementDigest: requirementDigest(issues, candidate.pullRequest) } };
      expect(evaluatePrReviewGate(changed, policy).outcome).toBe("human_decision");
    }
    expect(() => parsePrReviewGateInput({ ...candidate, issues: [candidate.issues[0]!, { ...candidate.issues[1]!, pause: null }] })).toThrow("issues[1].pause");
  });

  it("keeps explicit reference-only Issues open without claiming or handing them off", () => {
    const candidate = multiIssueInput();
    const pullRequest = { ...candidate.pullRequest, body: "Deliver #42. 本 PR 不关闭也不修改 #43。", keepOpenIssueNumbers: [43] };
    const issues = [candidate.issues[0]!, { ...candidate.issues[1]!, labels: [], blockedBy: null }];
    const review = { ...candidate.review, requirementDigest: requirementDigest(issues, pullRequest) };
    expect(evaluatePrReviewGate({ ...candidate, pullRequest, issues, review }, policy).outcome).toBe("merge_candidate");
    expect(evaluatePrReviewGate({ ...candidate, pullRequest, issues: [{ ...issues[0]!, blockedBy: [43] }, issues[1]!], review }, policy).outcome).toBe("human_decision");
  });

  it.each([
    ["本 PR 不关闭也不修改 #301。生产发布在 #322。", [301]],
    ["Do not close: #301, #308. Closes #313.", [301, 308]],
    ["Keep #301 and #308 open. Closes #313.", [301, 308]],
    ["#301 remains open. #308 stays open.", [301, 308]],
    ["#301、#308 保持开放。关闭 #313。", [301, 308]],
    ["Do not close https://github.com/lukemyself-hub/SayHear/issues/301", [301]],
  ])("parses keep-open clauses without consuming later closure references: %s", (body, numbers) => {
    expect(parseIssueClosureExclusions("", body)).toEqual({ keepOpenIssueNumbers: numbers, ambiguous: false });
  });

  it("stops for a keep-open declaration without explicit Issue numbers", () => {
    expect(parseIssueClosureExclusions("", "不关闭父 Issue，详见说明。").ambiguous).toBe(true);
    const candidate = multiIssueInput();
    const pullRequest = { ...candidate.pullRequest, body: "Don't close the parent Issue", issueClosureAmbiguous: true };
    expect(evaluatePrReviewGate({ ...candidate, pullRequest, review: { ...candidate.review, requirementDigest: requirementDigest(candidate.issues, pullRequest) } }, policy).outcome).toBe("human_decision");
  });

  it("requires an unambiguous open Issue and blocks unresolved dependencies", () => {
    const ambiguous = evaluatePrReviewGate(
      input({
        pullRequest: { linkedIssueNumbers: [42, 43] },
      }),
      policy,
    );
    const blocked = evaluatePrReviewGate(
      input({ issue: { blockedBy: [19] } }),
      policy,
    );

    expect(ambiguous.outcome).toBe("human_decision");
    expect(blocked.outcome).toBe("human_decision");
  });

  it("invalidates the review when the Issue requirements change", () => {
    const report = evaluatePrReviewGate(
      input({
        issue: { body: "The acceptance criteria changed." },
      }),
      policy,
    );

    expect(report.outcome).toBe("human_decision");
    expect(report.reasons[0]?.code).toBe("requirements_changed");
  });

  it("does not approve when the Issue is paused or its ownership label conflicts", () => {
    const paused = evaluatePrReviewGate(
      input({
        issue: { pause: { active: true, source: "maintainer" } },
      }),
      policy,
    );
    const labelConflict = evaluatePrReviewGate(
      input({ issue: { labels: ["ongoing", "ready-for-agent"] } }),
      policy,
    );

    expect(paused.outcome).toBe("human_decision");
    expect(labelConflict.outcome).toBe("awaiting_verification");
  });

  it("waits for the dedicated App and trusted workflow identity", () => {
    const noApp = evaluatePrReviewGate(
      input(),
      { ...policy, reviewAppId: null },
    );
    const wrongReviewer = evaluatePrReviewGate(
      input({
        review: { reviewerAppId: 55 },
      }),
      policy,
    );

    expect(noApp.outcome).toBe("awaiting_verification");
    expect(noApp.reasons[0]?.code).toBe("trusted_identity_unconfigured");
    expect(wrongReviewer.outcome).toBe("human_decision");
    expect(wrongReviewer.reasons[0]?.code).toBe("review_identity_invalid");
  });

  it("rejects an approval identity that authored the PR or its latest commit", () => {
    const report = evaluatePrReviewGate(
      input({
        review: { reviewerActorId: 102 },
      }),
      policy,
    );

    expect(report.outcome).toBe("human_decision");
    expect(report.reasons[0]?.code).toBe("review_identity_invalid");
  });

  it("requires readable, current-base branch protection and the exact trusted checks", () => {
    const unreadable = evaluatePrReviewGate(
      input({ branchProtection: null }),
      policy,
    );
    const missingGate = evaluatePrReviewGate(
      input({
        branchProtection: {
          requiredChecks: [{ name: "validate", appId: ACTIONS_APP_ID }],
        },
      }),
      policy,
    );

    expect(unreadable.outcome).toBe("awaiting_verification");
    expect(unreadable.reasons[0]?.code).toBe("branch_protection_unreadable");
    expect(missingGate.outcome).toBe("human_decision");
    expect(missingGate.reasons[0]?.code).toBe("branch_protection_incomplete");
  });

  it("stops when another PR is already being reviewed or merged", () => {
    const report = evaluatePrReviewGate(
      input({ runtime: { anotherApprovalInFlight: true } }),
      policy,
    );

    expect(report.outcome).toBe("awaiting_verification");
    expect(report.reasons[0]?.code).toBe("repository_merge_busy");
  });

  it("does not infer authorization for automatic production deployment", () => {
    const unknown = evaluatePrReviewGate(
      input({
        runtime: { ordinaryMergeTriggersProduction: null },
      }),
      policy,
    );
    const unauthorized = evaluatePrReviewGate(
      input({
        runtime: {
          ordinaryMergeTriggersProduction: true,
          productionMergeAuthorized: false,
        },
      }),
      policy,
    );

    expect(unknown.outcome).toBe("awaiting_verification");
    expect(unauthorized.outcome).toBe("human_decision");
  });

  it("requires portal smoke evidence for UI changes", () => {
    const report = evaluatePrReviewGate(
      input({
        review: { declaredImpacts: ["ui"] },
        pullRequest: {
          changedFiles: [{ path: "apps/web/app/page.tsx", status: "modified" }],
        },
      }),
      policy,
    );

    expect(report.outcome).toBe("awaiting_verification");
    expect(report.requiredEvidenceIds).toContain("ui:portal-smoke");
  });

  const migrationCheckId = "migration:upgrade-compatibility";

  function migrationInput(): PrReviewGateInput {
    return input({
      review: { declaredImpacts: [] },
      pullRequest: {
        changedFiles: [{
          path: "packages/data/migrations/0099_add_column.sql",
          status: "added",
        }],
      },
      evidence: [
        ...FIXED_PR_CI_BASELINE.map((id) => makeEvidence(id)),
        ...["purge:full-restore-drill", migrationCheckId].map((checkId) =>
          makeEvidence(checkId, {
            artifactSha256: "e".repeat(64),
            coveredCheckIds: [checkId],
          }),
        ),
      ],
    });
  }

  it.each(["migrations", "migrations-purge-marker"])(
    "requires trusted old-schema compatibility evidence for %s",
    (directory) => {
      const candidate = migrationInput();
      const report = evaluatePrReviewGate({
        ...candidate,
        pullRequest: {
          ...candidate.pullRequest,
          changedFiles: [{
            path: `packages/data/${directory}/0099_add_column.sql`,
            status: "added",
          }],
        },
        evidence: candidate.evidence.filter(
          (entry) => entry.checkId !== migrationCheckId,
        ),
      }, policy);

      expect(report.outcome).toBe("awaiting_verification");
      expect(report.reasons[0]?.code).toBe("required_evidence_missing");
      expect(report.reasons[0]?.message).toContain(migrationCheckId);
      expect(report.requiredEvidenceIds).toContain(migrationCheckId);
      expect(report.requiredEvidenceIds).toContain("purge:full-restore-drill");
    },
  );

  it("accepts a trusted migration drill on the same workflow run and artifact", () => {
    const report = evaluatePrReviewGate(migrationInput(), policy);

    expect(report.outcome).toBe("merge_candidate");
    expect(report.acceptedEvidenceIds).toEqual(report.requiredEvidenceIds);
    expect(report.acceptedEvidenceIds).toContain(migrationCheckId);
  });

  it.each(["failed", "skipped", "planned", "cancelled", "neutral", "out-of-scope"] as const)(
    "keeps a %s migration drill blocked",
    (result) => {
      const candidate = migrationInput();
      const report = evaluatePrReviewGate({
        ...candidate,
        evidence: candidate.evidence.map((entry) =>
          entry.checkId === migrationCheckId ? { ...entry, result } : entry,
        ),
      }, policy);

      expect(report.outcome).toBe("awaiting_verification");
      expect(report.reasons[0]?.message).toContain(migrationCheckId);
    },
  );

  it.each([
    { artifactSha256: null },
    { coveredCheckIds: [] },
    { source: { ...makeEvidence(migrationCheckId).source, headSha: "9".repeat(40) } },
    { source: { ...makeEvidence(migrationCheckId).source, baseSha: "9".repeat(40) } },
    { source: { ...makeEvidence(migrationCheckId).source, mergeSha: "9".repeat(40) } },
    { source: { ...makeEvidence(migrationCheckId).source, workflowBlobSha: "9".repeat(40) } },
    { source: { ...makeEvidence(migrationCheckId).source, appId: 1 } },
    { source: { ...makeEvidence(migrationCheckId).source, repositoryId: 1 } },
    { source: { ...makeEvidence(migrationCheckId).source, runId: 4321 } },
    { source: { ...makeEvidence(migrationCheckId).source, runAttempt: 2 } },
  ] satisfies readonly Partial<PrReviewGateInput["evidence"][number]>[])(
    "rejects migration evidence with incomplete coverage or mismatched identity %j",
    (override) => {
      const candidate = migrationInput();
      const report = evaluatePrReviewGate({
        ...candidate,
        evidence: candidate.evidence.map((entry) =>
          entry.checkId === migrationCheckId ? { ...entry, ...override } : entry,
        ),
      }, policy);

      expect(report.outcome).toBe("awaiting_verification");
      expect(report.reasons[0]?.message).toContain(migrationCheckId);
    },
  );

  it("keeps Purge evidence required after an upgrade drill passes", () => {
    const candidate = migrationInput();
    const report = evaluatePrReviewGate(
      {
        ...candidate,
        evidence: candidate.evidence.filter(
          (entry) => entry.checkId !== "purge:full-restore-drill",
        ),
      },
      policy,
    );

    expect(report.outcome).toBe("awaiting_verification");
    expect(report.reasons[0]?.message).toContain("purge:full-restore-drill");
  });

  it("rejects duplicate migration records even if both report a pass", () => {
    const candidate = migrationInput();
    const report = evaluatePrReviewGate({
      ...candidate,
      evidence: [...candidate.evidence, makeEvidence(migrationCheckId, {
        artifactSha256: "e".repeat(64),
        coveredCheckIds: [migrationCheckId],
      })],
    }, policy);

    expect(report.outcome).toBe("awaiting_verification");
    expect(report.reasons[0]?.message).toContain("duplicate");
    expect(report.acceptedEvidenceIds).toEqual([]);
  });

  it.each(["v4", "v5", "v6", "v7", "v8"])("invalidates %s policy reviews while keeping the report schema unchanged", (version) => {
    const report = evaluatePrReviewGate(input({
      review: { policyVersion: `sayhear-pr-review-gate:${version}` },
    }), policy);

    expect(PR_REVIEW_GATE_POLICY_VERSION).toBe("sayhear-pr-review-gate:v9");
    expect(PR_REVIEW_REPORT_VERSION).toBe("sayhear-pr-review-report:v4");
    expect(report.reasons[0]?.code).toBe("policy_version_mismatch");
  });
  const DEFERRABLE_CHECK_IDS = [
    "prompt-budget:effective-config-diff",
    "provider:effective-config-diff",
    "provider:affected-role-calls",
  ] as const;

  function deferralEvidence(): PrReviewGateInput["evidence"] {
    return [
      ...FIXED_PR_CI_BASELINE.map((id) => makeEvidence(id)),
      makeEvidence("prompt-budget:synthetic-samples", {
        artifactSha256: "a".repeat(64),
        coveredCheckIds: ["prompt-budget:synthetic-samples"],
      }),
      makeEvidence("provider:privacy-checks", {
        artifactSha256: "b".repeat(64),
        coveredCheckIds: ["provider:privacy-checks"],
      }),
      ...DEFERRABLE_CHECK_IDS.map((id) => makeDeferral(id)),
    ];
  }

  function deferralInput(
    mutate: (
      evidence: PrReviewGateInput["evidence"],
    ) => PrReviewGateInput["evidence"] = (evidence) => evidence,
    pullRequestPatch: Partial<PrReviewGateInput["pullRequest"]> = {},
  ): PrReviewGateInput {
    const candidate = input({
      review: { declaredImpacts: ["prompt-budget", "provider-migration"] },
      pullRequest: {
        body: "Delivers #42.",
        changedFiles: [
          { path: "packages/ai/src/provider.ts", status: "modified" },
        ],
        ...pullRequestPatch,
      },
      evidence: mutate(deferralEvidence()),
    });
    return {
      ...candidate,
      review: {
        ...candidate.review,
        requirementDigest: requirementDigest(candidate.issues, candidate.pullRequest),
      },
    };
  }

  it("returns merge_candidate_with_deferrals for exactly the registry deferrals", () => {
    const report = evaluatePrReviewGate(deferralInput(), policy);

    expect(report.outcome).toBe("merge_candidate_with_deferrals");
    expect(report.reasons[0]?.code).toBe("pre_merge_checks_deferred");
    expect(
      report.deferredEvidence.map((entry) => entry.checkId).sort(),
    ).toEqual([...DEFERRABLE_CHECK_IDS].sort());
    for (const id of DEFERRABLE_CHECK_IDS) {
      expect(report.acceptedEvidenceIds).not.toContain(id);
    }
    for (const entry of report.deferredEvidence) {
      expect(entry.followUp.stage).toBe("acceptance");
      expect(entry.followUp.command.length).toBeGreaterThan(0);
    }
  });

  it("requires a human decision for browser approval with deferred checks", () => {
    const report = evaluatePrReviewGate(deferralInput(), {
      ...policy,
      humanApprovalChannel: "browser",
    });

    expect(report.outcome).toBe("human_decision");
    expect(report.reasons[0]?.code).toBe("browser_deferred_merge_requires_human");
    expect(report.deferredEvidence).toEqual([]);
  });

  it.each([
    ["a closing keyword in the PR body", { body: "Delivers #42.\n\nCloses #42" }],
    ["a closing keyword in the PR title", { title: "Fix #42 provider path" }],
    ["a Development-sidebar link", { closingIssueNumbers: [42] }],
    ["a closing keyword in a commit message", { closingIssueNumbers: [301] }],
    ["an unreadable closing-reference set", { closingIssueNumbers: null }],
  ] as const)(
    "refuses a deferred merge when GitHub would close Issues natively (%s)",
    (_label, pullRequestPatch) => {
      const report = evaluatePrReviewGate(
        deferralInput(undefined, pullRequestPatch),
        policy,
      );

      expect(report.outcome).toBe("human_decision");
      expect(report.reasons[0]?.code).toBe("deferred_merge_would_close_issues");
      expect(report.deferredEvidence).toEqual([]);
    },
  );

  it("keeps closing keywords allowed for a clean merge_candidate", () => {
    const report = evaluatePrReviewGate(
      input({ pullRequest: { closingIssueNumbers: [42] } }),
      policy,
    );

    expect(input().pullRequest.body).toBe("Fixes #42");
    expect(report.outcome).toBe("merge_candidate");
  });

  it("parses a missing closing-reference set as unknown", () => {
    const { closingIssueNumbers: _omitted, ...pullRequest } = input().pullRequest;
    const parsed = parsePrReviewGateInput({ ...input(), pullRequest });

    expect(parsed.pullRequest.closingIssueNumbers).toBeNull();
  });

  it("finds every GitHub closing keyword form, including negated text", () => {
    expect(
      closingKeywordIssueNumbers(
        [
          "closes #1", "Fixed: #2", "RESOLVES lukemyself-hub/SayHear#3",
          "fix https://github.com/lukemyself-hub/SayHear/issues/4",
          "Do not close #5", "Delivers #6", "关闭 #7", "closer #8",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the plain merge_candidate outcome when nothing is deferred", () => {
    const report = evaluatePrReviewGate(input(), policy);

    expect(report.outcome).toBe("merge_candidate");
    expect(report.deferredEvidence).toEqual([]);
  });

  it("accepts verified evidence for a deferrable check instead of deferring it", () => {
    const report = evaluatePrReviewGate(
      deferralInput((evidence) =>
        evidence.map((entry) =>
          entry.kind === "deferred-before-merge" &&
          entry.checkId === "provider:effective-config-diff"
            ? makeEvidence("provider:effective-config-diff", {
                artifactSha256: "c".repeat(64),
                coveredCheckIds: ["provider:effective-config-diff"],
              })
            : entry,
        ),
      ),
      policy,
    );

    expect(report.outcome).toBe("merge_candidate_with_deferrals");
    expect(report.acceptedEvidenceIds).toContain(
      "provider:effective-config-diff",
    );
    expect(report.deferredEvidence.map((entry) => entry.checkId).sort()).toEqual(
      ["prompt-budget:effective-config-diff", "provider:affected-role-calls"],
    );
  });

  it("blocks a forged or non-deferrable deferral instead of failing open", () => {
    const mismatched = evaluatePrReviewGate(
      deferralInput((evidence) =>
        evidence.map((entry) =>
          entry.kind === "deferred-before-merge" &&
          entry.checkId === "provider:effective-config-diff"
            ? {
                ...entry,
                policy: {
                  ...entry.policy,
                  followUp: {
                    ...entry.policy.followUp,
                    command: "pnpm some-other-command",
                  },
                },
              }
            : entry,
        ),
      ),
      policy,
    );
    expect(mismatched.outcome).toBe("awaiting_verification");
    expect(mismatched.reasons[0]?.message).toContain(
      "provider:effective-config-diff",
    );
    expect(mismatched.deferredEvidence).toEqual([]);

    const nonDeferrable = evaluatePrReviewGate(
      deferralInput((evidence) => [
        ...evidence.filter(
          (entry) =>
            entry.kind === "deferred-before-merge" ||
            entry.checkId !== "provider:privacy-checks",
        ),
        {
          kind: "deferred-before-merge",
          checkId: "provider:privacy-checks",
          policy: {
            reason: "requires-deployed-effective-configuration",
            followUp: {
              stage: "acceptance",
              command: "pnpm release:config:compare",
            },
          },
        },
      ]),
      policy,
    );
    expect(nonDeferrable.outcome).toBe("awaiting_verification");
    expect(nonDeferrable.reasons[0]?.message).toContain(
      "provider:privacy-checks",
    );

    const outOfScope = evaluatePrReviewGate(
      deferralInput((evidence) =>
        evidence.map((entry) =>
          entry.kind !== "deferred-before-merge" &&
          entry.checkId === "provider:privacy-checks"
            ? {
                ...entry,
                result: "out-of-scope",
                artifactSha256: null,
                coveredCheckIds: [],
              }
            : entry,
        ),
      ),
      policy,
    );
    expect(outOfScope.outcome).toBe("awaiting_verification");
    expect(outOfScope.reasons[0]?.message).toContain(
      "provider:privacy-checks",
    );
  });

  it("does not let authorized deferrals bridge a cross-run evidence set", () => {
    const report = evaluatePrReviewGate(
      deferralInput((evidence) =>
        evidence.map((entry) =>
          entry.kind !== "deferred-before-merge" &&
          entry.checkId === "provider:privacy-checks"
            ? {
                ...entry,
                source: {
                  ...entry.source,
                  runId: entry.source.runId + 1,
                  runAttempt: entry.source.runAttempt + 1,
                },
              }
            : entry,
        ),
      ),
      policy,
    );

    expect(report.outcome).toBe("awaiting_verification");
    expect(report.reasons[0]?.message).toContain(
      "different workflow run or attempt",
    );
    expect(report.deferredEvidence).toEqual([]);
  });

  it.each([
    ["sayhear-pr-review-report:v3", "sayhear-pr-review-gate:v4"],
    ["sayhear-pr-review-report:v3", "sayhear-pr-review-gate:v5"],
    ["sayhear-pr-review-report:v4", "sayhear-pr-review-gate:v4"],
    ["sayhear-pr-review-report:v4", "sayhear-pr-review-gate:v5"],
    ["sayhear-pr-review-report:v3", "sayhear-pr-review-gate:v6"],
    ["sayhear-pr-review-report:v4", "sayhear-pr-review-gate:v6"],
    ["sayhear-pr-review-report:v3", "sayhear-pr-review-gate:v7"],
    ["sayhear-pr-review-report:v4", "sayhear-pr-review-gate:v7"],
    ["sayhear-pr-review-report:v3", "sayhear-pr-review-gate:v8"],
    ["sayhear-pr-review-report:v4", "sayhear-pr-review-gate:v8"],
  ])("rejects a new report with incompatible identity %s / %s", (version, policyVersion) => {
    const report = evaluatePrReviewGate(
      input({
        review: { version, policyVersion },
      }),
      policy,
    );

    expect(PR_REVIEW_GATE_POLICY_VERSION).toBe("sayhear-pr-review-gate:v9");
    expect(PR_REVIEW_REPORT_VERSION).toBe("sayhear-pr-review-report:v4");
    expect(report.outcome).toBe("awaiting_verification");
    expect(report.reasons[0]?.code).toBe("policy_version_mismatch");
  });

  it("routes capability acceptance and contradictory findings away from auto approval", () => {
    const capability = evaluatePrReviewGate(
      input({
        review: {
          capability: { newCapabilityEnabled: true },
        },
      }),
      policy,
    );
    const contradictory = evaluatePrReviewGate(
      input({
        review: {
          findings: [
            {
              severity: "P2",
              file: "packages/application/src/server/fix.ts",
              line: 12,
              trigger: "retry with an expired record",
              userImpact: "the request returns stale data",
              evidence: "the retry path skips the version check",
            },
          ],
        },
      }),
      policy,
    );

    expect(capability.outcome).toBe("human_decision");
    expect(contradictory.outcome).toBe("awaiting_verification");
    expect(contradictory.reasons[0]?.code).toBe("review_result_conflict");
  });

  it("parses prompt-injection text as inert data", () => {
    const suspiciousTitle = "$(touch /tmp/pr-review-gate-injection)";
    const candidate = input({
      issue: { title: suspiciousTitle },
      review: {
        requirementDigest: requirementDigest({
          number: 42,
          title: suspiciousTitle,
          body: "The service must return the existing record after retry.",
          updatedAt: "2026-10-10T12:00:00.000Z",
          discussionDigest: "2".repeat(64),
        }, {
          number: 321,
          title: "Fix the ordinary server path",
          body: "Fixes #42",
          updatedAt: "2026-10-10T12:00:00.000Z",
          discussionDigest: "1".repeat(64),
        }),
      },
    });
    const parsed = parsePrReviewGateInput(candidate);

    expect(parsed.issues[0]?.title).toBe(suspiciousTitle);
    expect(evaluatePrReviewGate(parsed, policy).outcome).toBe("merge_candidate");
  });

  it("rejects malformed model output instead of treating it as approval", () => {
    const candidate = input();
    const malformed = {
      ...candidate,
      review: { ...candidate.review, decision: "looks-good" },
    };

    expect(() => parsePrReviewGateInput(malformed)).toThrow(
      "review.decision is invalid",
    );
  });
});
