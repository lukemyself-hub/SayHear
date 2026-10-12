import { describe, expect, it } from "vitest";

import {
  FIXED_PR_CI_BASELINE,
  RELEASE_CHECKS,
  type ReleaseImpactKind,
} from "../scripts/daily-release-validation.ts";
import {
  PR_REVIEW_GATE_POLICY_VERSION,
  PR_REVIEW_REPORT_VERSION,
  PR_VALIDATE_WORKFLOW_PATH,
  SAYHEAR_REPOSITORY_ID,
  SAYHEAR_REPOSITORY_NAME,
  evaluatePrReviewGate,
  parsePrReviewGateInput,
  requirementDigest,
  type PrReviewGateInput,
  type TrustedPrReviewPolicy,
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

function makeEvidence(
  checkId: string,
  overrides: Partial<PrReviewGateInput["evidence"][number]> = {},
): PrReviewGateInput["evidence"][number] {
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

type InputOverrides = Omit<
  Partial<PrReviewGateInput>,
  "repository" | "pullRequest" | "issue" | "review" | "branchProtection" | "runtime"
> & {
  repository?: Partial<PrReviewGateInput["repository"]>;
  pullRequest?: Partial<PrReviewGateInput["pullRequest"]>;
  issue?: Omit<Partial<PrReviewGateInput["issue"]>, "pause"> & {
    pause?: Partial<PrReviewGateInput["issue"]["pause"]>;
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
      changedFiles: [
        { path: "packages/application/src/server/fix.ts", status: "modified" },
      ],
    },
    issue,
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
    issue: {
      ...base.issue,
      ...overrides.issue,
      pause: { ...base.issue.pause, ...overrides.issue?.pause },
    },
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

  it("does not accept a same-named check from an untrusted app", () => {
    const evidence = input().evidence.map((entry, index) =>
      index === 0
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
        index === 0 ? { ...entry, result } : entry,
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

  it("requires old-schema compatibility evidence for migrations", () => {
    const report = evaluatePrReviewGate(
      input({
        pullRequest: {
          changedFiles: [
            {
              path: "packages/data/migrations/0099_add_column.sql",
              status: "added",
            },
          ],
        },
      }),
      policy,
    );

    expect(report.outcome).toBe("awaiting_verification");
    expect(report.reasons[0]?.code).toBe(
      "migration_compatibility_evidence_required",
    );
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

    expect(parsed.issue.title).toBe(suspiciousTitle);
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
