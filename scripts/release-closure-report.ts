/**
 * SPEC #275 ticket #284 — release-closure report.
 *
 * This is the final, honest closure seam for the "PR CI baseline + impact-based
 * validation" release mechanism. It assembles, from real readable sources where
 * they exist and `unverified`/`blocked` where they do not:
 *
 *   - the latest PR CI runs for the integration branch and the required-check
 *     enablement state (including the fact this private-plan repo cannot enable
 *     required status checks, HTTP 403);
 *   - the promotion/config comparison status, reusing ticket #282's report
 *     (`buildG1PromotionConfigReport`) rather than forking its comparison;
 *   - the deployment identity: the real integration/base SHAs are readable from
 *     git, a production deployment identity is `unverified` until a deployment
 *     exists and is authorized to be read;
 *   - the AC-01..AC-14 evidence map (parent SPEC #275), each with the committed
 *     ticket, commit, files, commands and run ids, or an explicit blocker;
 *   - scheduler observations for Internal Recovery Scan and Backup Evidence
 *     Renewal (workflow id, state, cron, last runs) gathered read-only;
 *   - the ticket #283 visual/functional harness pointer and command;
 *   - concrete rollback actions (restore variables, redeploy, revoke/reauthorize,
 *     re-read config), not "revert commit";
 *   - remaining limitations that must not be dressed up as proven.
 *
 * Two seams live here on purpose:
 *
 *   1. {@link buildReleaseClosureReport} is a pure aggregation of already-read
 *      inputs, so the closure rules are unit-testable without a network.
 *   2. {@link collectReleaseClosureInput} is the thin gh/git reader. It is the
 *      only place that shells out, and it accepts an injected runner so the
 *      reader itself is tested deterministically.
 *
 * `--fixture` produces a synthetic report from the committed ticket #282
 * fixtures; the default path reads the live GitHub state. A report is written
 * even while closure is blocked, and the process exits non-zero so an incomplete
 * closure is never mistaken for a completed one. No secret, connection string,
 * private body or low-entropy secret hash is ever recorded.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  buildG1PromotionConfigReport,
  type G1PromotionConfigReport,
} from "./g1-promotion-config-report";
import { containsForbiddenContent } from "./content-free";
import { parseEffectiveConfigurationSnapshot } from "./effective-runtime-config-gate";

const execFileAsync = promisify(execFile);

export const RELEASE_CLOSURE_REPORT_VERSION = "spec275-release-closure-report:v1";

const PRODUCTION_VERCEL_PROJECT_ID = "prj_KJD7fJhlIxlOMc4W4goUsIhOaLly";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROMOTION_FIXTURE_DIRECTORY = join(
  repositoryRoot,
  "tests/fixtures/g1-promotion-config-report",
);

/**
 * Identity used only by {@link syntheticClosureFixture}. The runtime collector
 * has no identity default: it requires an explicit PR/branch/base and fails
 * when git or `gh` cannot establish them, so a report can never silently assert
 * a SPEC-specific commit as evidence.
 */
const FIXTURE_INTEGRATION_COMMIT = "a1fcb4595af825b9817c21226fc1cff77f738f28";
const FIXTURE_BASE_COMMIT = "5812cf3a6ef4aa2e0e58e99ca4ef27505767c356";

export type CommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<CommandResult>;

type ReleaseIdentity = Readonly<{
  version: "1a3b-g1-hosted-release-identity:v1";
  commit: string;
  environment: "production";
  projectId: string;
  teamId: string | null;
  businessTargetHash: string;
  purgeMarkerTargetHash: string;
}>;

export type ReleaseIdentityFetcher = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type CiRunEvidence = Readonly<{
  id: number;
  workflow: string;
  event: string;
  branch: string;
  commit: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  url: string;
}>;

export type RequiredCheckState = Readonly<{
  status: "enabled" | "plan-blocked" | "unverified";
  detail: string;
}>;

export type DeploymentIdentityState = Readonly<{
  status: "verified" | "unverified";
  commit: string | null;
  deploymentId: string | null;
  projectId: string | null;
  teamId: string | null;
  businessTargetHash: string | null;
  purgeMarkerTargetHash: string | null;
  reason: string;
}>;

export type AcceptanceEvidence = Readonly<{
  id: string;
  title: string;
  tickets: readonly string[];
  commits: readonly string[];
  files: readonly string[];
  commands: readonly string[];
  runIds: readonly (string | number)[];
  status: "verified" | "partial" | "blocked";
  blocker: string | null;
  note: string;
}>;

export type SchedulerObservation = Readonly<{
  workflowId: number | string;
  name: string;
  path: string;
  state: string;
  schedule: readonly string[];
  lastRuns: readonly CiRunEvidence[];
  lastScheduledConclusion: string | null;
  target: string;
  note: string;
}>;

export type RehearsalStep = Readonly<{
  stage: string;
  outcome: string;
  evidence: string;
}>;

export type PromotionRehearsal = Readonly<{
  description: string;
  steps: readonly RehearsalStep[];
  productionUntouched: boolean;
}>;

export type RollbackAction = Readonly<{
  order: number;
  action: string;
  verification: string;
}>;

export type ClosureBlocker = Readonly<{
  id: string;
  category:
    | "production"
    | "platform-permission"
    | "ci"
    | "downstream"
    | "unverified";
  item: string;
  reason: string;
}>;

export type PromotionStatus = Readonly<{
  status: "collected" | "blocked";
  command: string;
  configDigest: string | null;
  promotionAllowed: boolean | null;
  blockerKeys: readonly string[];
  note: string;
}>;

export type ReleaseClosureInput = Readonly<{
  collectedAt: string;
  repository: Readonly<{
    integrationBranch: string;
    integrationCommit: string;
    baseCommit: string;
    acceptanceCommit: string | null;
  }>;
  pullRequest: Readonly<{
    number: number;
    url: string;
    baseBranch: string;
    headBranch: string;
    draft: boolean;
  }>;
  ciRuns: readonly CiRunEvidence[];
  requiredChecks: RequiredCheckState;
  deploymentIdentity: Readonly<{
    production: DeploymentIdentityState;
    candidate: DeploymentIdentityState;
  }>;
  promotion: PromotionStatus;
  acceptance: readonly AcceptanceEvidence[];
  schedulers: readonly SchedulerObservation[];
  visualFunctional: Readonly<{
    harness: string;
    command: string;
    committed: boolean;
    screenshotsCommitted: boolean;
    result: string;
    note: string;
  }>;
  rehearsal: PromotionRehearsal;
  rollback: readonly RollbackAction[];
  limitations: readonly string[];
}>;

export type ReleaseClosureReport = ReleaseClosureInput &
  Readonly<{
    version: string;
    closureStatus: "closed" | "blocked";
    blockers: readonly ClosureBlocker[];
    summary: Readonly<{
      ciLatestConclusion: string | null;
      acceptanceVerified: number;
      acceptanceBlocked: number;
      schedulerActive: number;
      schedulerTotal: number;
    }>;
  }>;

// The AC-01..AC-14 evidence map for parent SPEC #275. Each AC points at the
// merged ticket commit, the files that carry the behavior and the command that
// reruns it. An AC whose acceptance depends on a real production deployment or
// a platform setting that cannot be read stays `partial` with its blocker.
export const ACCEPTANCE_EVIDENCE: readonly AcceptanceEvidence[] = [
  {
    id: "AC-01",
    title: "PR CI runs runtime/boundaries/purge/typecheck/test/build and browser bundle",
    tickets: ["#276"],
    commits: ["04d9c6ad25724dcae48be4d30d80964be5ead141"],
    files: [
      ".github/workflows/pr-validate.yml",
      "tests/ci-pr-validate-workflow.test.ts",
      "tests/ci-system-suite-execution.test.ts",
    ],
    commands: ["pnpm validate", "gh run list --branch integration/spec-275 --json"],
    runIds: [37741892121, 37732855645],
    status: "partial",
    blocker:
      "Required status checks cannot be enabled on this repository plan (HTTP 403 Upgrade to GitHub Pro); CI passes but merge protection is not enforced by the platform.",
    note: "The latest head run is read live; the run that passed the whole composition was 37732855645.",
  },
  {
    id: "AC-02",
    title: "Two real, separate test databases with migrations and synthetic fixtures",
    tickets: ["#276"],
    commits: ["04d9c6ad25724dcae48be4d30d80964be5ead141"],
    files: [
      ".github/workflows/pr-validate.yml",
      "tests/ci-test-databases.test.ts",
      "tests/ci-system-suite-execution.test.ts",
      "scripts/ci/verify-test-databases.ts",
    ],
    commands: [
      "pnpm ci:verify-test-databases",
      "pnpm ci:assert-system-suites artifacts/vitest-report.json",
    ],
    runIds: [37732855645],
    status: "verified",
    blocker: null,
    note: "Business and Purge Marker run as two distinct PostgreSQL services.",
  },
  {
    id: "AC-03",
    title: "CI is isolated from production secrets, private data and real providers",
    tickets: ["#276"],
    commits: ["04d9c6ad25724dcae48be4d30d80964be5ead141"],
    files: [
      ".github/workflows/pr-validate.yml",
      "tests/ci-pr-validate-workflow.test.ts",
    ],
    commands: ["pnpm validate"],
    runIds: [37732855645],
    status: "verified",
    blocker: null,
    note: "Unprivileged pull_request event, contents: read and synthetic configuration only.",
  },
  {
    id: "AC-04",
    title: "Hourly recovery scan and backup renewal schedules stay structurally protected",
    tickets: ["#277"],
    commits: ["387cc2e80f16cc7a7155ed11de8707e445df55be"],
    files: [
      "scripts/ci/check-workflow-triggers.mjs",
      "tests/recovery-cron-config.test.ts",
      "tests/workflow-trigger-contracts.test.ts",
    ],
    commands: ["pnpm exec node scripts/ci/check-workflow-triggers.mjs"],
    runIds: [37732855645],
    status: "verified",
    blocker: null,
    note: "Negative fixtures fail when the hourly schedule, route or backup renewal is removed.",
  },
  {
    id: "AC-05",
    title: "Schedule and dispatch still route through the original scan behavior",
    tickets: ["#277"],
    commits: ["387cc2e80f16cc7a7155ed11de8707e445df55be"],
    files: [
      "tests/recovery-scan-workflow-behavior.test.ts",
      "tests/recovery-scanner-handler.test.ts",
    ],
    commands: [
      "pnpm exec vitest run tests/recovery-scan-workflow-behavior.test.ts tests/recovery-scanner-handler.test.ts",
    ],
    runIds: [37732855645],
    status: "verified",
    blocker: null,
    note: "HTTP 200 proves a dispatch only; the terminal Weekly state is verified separately.",
  },
  {
    id: "AC-06",
    title: "Effective deployed configuration is compared with sources and defaults",
    tickets: ["#278", "#282"],
    commits: ["6c7524d11abf5242231da0027f03a47a0c422f2a", "3e7332467799144770af4146a4c619175162551d"],
    files: [
      "scripts/effective-runtime-config-gate.ts",
      "tests/effective-runtime-config-gate.test.ts",
      "scripts/g1-promotion-config-report.ts",
    ],
    commands: ["pnpm release:config:compare", "pnpm release:promotion:report"],
    runIds: [],
    status: "partial",
    blocker:
      "The live production effective-configuration read is unavailable without an authorized deployment read; only the synthetic comparison is exercised.",
    note: "The gate and reader exist and are tested; the live production comparison is the unverified part.",
  },
  {
    id: "AC-07",
    title: "Layered Weekly deadline budgets are checked instead of one ~120s window",
    tickets: ["#278"],
    commits: ["6c7524d11abf5242231da0027f03a47a0c422f2a"],
    files: [
      "scripts/effective-runtime-config-gate.ts",
      "tests/effective-runtime-config-gate.test.ts",
    ],
    commands: ["pnpm release:config:compare --deadline <budget.json>"],
    runIds: [37732855645],
    status: "verified",
    blocker: null,
    note: "Provider, Workflow step, scan dispatch and acceptance wait layers are separate and deterministic.",
  },
  {
    id: "AC-08",
    title: "Promotion report covers in/out fingerprint keys with reason, impact, verification and rollback",
    tickets: ["#282"],
    commits: ["3e7332467799144770af4146a4c619175162551d"],
    files: [
      "scripts/g1-promotion-config-report.ts",
      "tests/g1-promotion-config-report.test.ts",
    ],
    commands: ["pnpm release:promotion:report"],
    runIds: [],
    status: "partial",
    blocker:
      "A live promotion comparison needs a candidate deployment and a current-production config read; both are blocked, so only the synthetic rehearsal is recorded.",
    note: "The report itself is unit-tested and the rollback plan is exercised on the synthetic fixtures.",
  },
  {
    id: "AC-09",
    title: "Same-config UI and ordinary server commits reuse unchanged pins without full evidence",
    tickets: ["#279", "#281"],
    commits: ["25385de07f17b0fd913d3ae3af360494a326c138", "a166e758173af8e69d133ca63f4cb4be31715a3d"],
    files: [
      "tests/g1-release-authorization.test.ts",
      "scripts/daily-release-validation.ts",
      "docs/adr/0148-deployment-identity-config-authorization-and-acceptance-are-separate.md",
    ],
    commands: ["pnpm release:validate"],
    runIds: [37732855645],
    status: "partial",
    blocker:
      "No production deployment of a same-config UI or ordinary server commit exists, so this is proven only by the local release-trajectory test and a CI run; neither proves a real deployment was authorized and published.",
    note: "The release trajectory never starts release:g1:produce for a same-config commit; a real deployment remains pending (see LIMITATIONS).",
  },
  {
    id: "AC-10",
    title: "A real configuration change honestly versions only the affected role",
    tickets: ["#280"],
    commits: ["c0c4c1be8c8f9bc1505335047791c349217371a7"],
    files: [
      "tests/system/g1-single-role-config-transition.system.test.ts",
      "packages/data/src/postgres-model-role-command-repository.ts",
    ],
    commands: [
      "pnpm exec vitest run tests/system/g1-single-role-config-transition.system.test.ts",
    ],
    runIds: [],
    status: "partial",
    blocker:
      "The single-role versioning is proven only against the isolated synthetic PostgreSQL system seam in this checkout; no real production configuration change has been versioned or deployed, so this runId list is empty.",
    note: "Runs against the isolated PostgreSQL system seam; missing/unknown/retired roles still fail closed.",
  },
  {
    id: "AC-11",
    title: "Config revoke/rollback and data fences keep old in-flight results out of current",
    tickets: ["#279", "#280"],
    commits: ["25385de07f17b0fd913d3ae3af360494a326c138", "c0c4c1be8c8f9bc1505335047791c349217371a7"],
    files: [
      "tests/system/g1-single-role-config-transition.system.test.ts",
      "tests/system/g1-release-activation.system.test.ts",
      "tests/system/g1-purge-restore-drill.system.test.ts",
    ],
    commands: [
      "pnpm exec vitest run tests/system/g1-single-role-config-transition.system.test.ts tests/system/g1-release-activation.system.test.ts tests/system/g1-purge-restore-drill.system.test.ts",
    ],
    runIds: [],
    status: "partial",
    blocker:
      "Revoke/rollback and the data fences are proven only against the isolated synthetic PostgreSQL system suites in this checkout; no real production deployment has exercised them, so this runId list is empty.",
    note: "Revoke stops admission; rollout_pin_changed/source_changed/data_epoch discard in-flight results.",
  },
  {
    id: "AC-12",
    title: "Impact-based check selection covers each behavior kind without full re-verification",
    tickets: ["#281"],
    commits: ["a166e758173af8e69d133ca63f4cb4be31715a3d"],
    files: [
      "scripts/daily-release-validation.ts",
      "tests/daily-release-validation.test.ts",
    ],
    commands: ["pnpm release:validate"],
    runIds: [37732855645],
    status: "verified",
    blocker: null,
    note: "Negative cases prove boundary changes add targeted checks and unknown impact is located first.",
  },
  {
    id: "AC-13",
    title: "ADR and current architecture revise the release clauses coherently",
    tickets: ["#279", "#280", "#281"],
    commits: ["25385de07f17b0fd913d3ae3af360494a326c138", "c0c4c1be8c8f9bc1505335047791c349217371a7", "a166e758173af8e69d133ca63f4cb4be31715a3d"],
    files: [
      "docs/adr/0148-deployment-identity-config-authorization-and-acceptance-are-separate.md",
      "docs/architecture/24-29-testing-and-delivery.md",
      "docs/decisions.md",
    ],
    commands: ["pnpm exec vitest run tests/daily-release-validation.test.ts"],
    runIds: [37732855645],
    status: "verified",
    blocker: null,
    note: "ADR-0148 amends ADR-0134/0135/0136/0138/0140/0141/0143/0144 without removing the retained fences.",
  },
  {
    id: "AC-14",
    title: "Portal sidebar bottom owner status with readable dates and long tool names",
    tickets: ["#283"],
    commits: ["b83449c736ab7eb7be95ef7f5fd2c5051e3b6117"],
    files: [
      "scripts/portal-visual-acceptance.mjs",
      "apps/web/app/internal/portal-shell.tsx",
      "tests/portal-sidebar-layout.test.ts",
      "tests/portal-write-status.test.ts",
    ],
    commands: ["node scripts/portal-visual-acceptance.mjs"],
    runIds: [37732855645],
    status: "partial",
    blocker:
      "The real post-deploy browser acceptance is pending the production deployment; the committed harness and its command are the local evidence.",
    note: "Synthetic only; screenshots are local evidence and are not committed.",
  },
];

const ROLLBACK_ACTIONS: readonly RollbackAction[] = [
  {
    order: 1,
    action:
      "Restore the affected environment variables (for example SAYHEAR_PROVIDER_TIMEOUT_MS and any changed role parameter) to the recorded current-production values; do not merely revert a commit.",
    verification:
      "Re-read the effective configuration from the redeployed environment with the authenticated inspection endpoint.",
  },
  {
    order: 2,
    action:
      "Redeploy the affected environment so the restored variables are actually loaded; the blocked deployment is not reused.",
    verification: "Confirm the redeployed deployment id and commit identity.",
  },
  {
    order: 3,
    action:
      "Revoke the superseded active rollout pins for the changed roles through the single-role transition/revoke contract, then activate the prior immutable configuration so admission stops and frozen in-flight results cannot become current.",
    verification:
      "verifyActiveG1Release reports the complete four-role set with the prior pins.",
  },
  {
    order: 4,
    action:
      "Re-read the deployed effective configuration and confirm the restored values, the two-database target separation and the four-role authorization.",
    verification: "The effective-runtime-config comparison is compatible again.",
  },
  {
    order: 5,
    action:
      "Keep historical acceptance evidence at its original commit and content identity; never relabel it as the new commit.",
    verification:
      "The promotion report records the original acceptance commit and deployment id.",
  },
];

const LIMITATIONS: readonly string[] = [
  "No production smoke test has been run: the integration branch is a draft PR and no production deployment has occurred.",
  "No natural Weekly terminal proof exists; only dispatch and synthetic checks are recorded, which do not prove the provider/model terminal state.",
  "Downstream dispatch-only verification: a scan HTTP 200 proves a dispatch, not a terminal Weekly state.",
  "Required status checks cannot be enabled on this repository plan; the HTTP 403 is recorded rather than replaced by a passing run.",
  "Provider weight drift is undetectable behind the mutable alias (ADR-0147); the OpenCode Go 0-day retention contract expires 2026-10-31 and renewal must not be assumed.",
];

function apiRun(
  id: number,
  workflow: string,
  event: string,
  commit: string,
  createdAt: string,
): CiRunEvidence {
  return {
    id,
    workflow,
    event,
    branch: event === "schedule" ? "main" : "integration/spec-275",
    commit,
    status: "completed",
    conclusion: "success",
    createdAt,
    url: `https://github.com/lukemyself-hub/SayHear/actions/runs/${id}`,
  };
}

function fixturePaths(): {
  isolatedPath: string;
  productionPath: string;
  candidateChangePath: string;
  candidateRecoveredPath: string;
} {
  return {
    isolatedPath: join(PROMOTION_FIXTURE_DIRECTORY, "isolated.json"),
    productionPath: join(PROMOTION_FIXTURE_DIRECTORY, "production.json"),
    candidateChangePath: join(PROMOTION_FIXTURE_DIRECTORY, "candidate-change.json"),
    candidateRecoveredPath: join(
      PROMOTION_FIXTURE_DIRECTORY,
      "candidate-recovered.json",
    ),
  };
}

function readFixture(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/**
 * Rehearse the deployment/rollback path on the committed ticket #282 synthetic
 * fixtures: a candidate change is blocked before promotion, its variables are
 * restored and the environment is redeployed, and the re-read comparison then
 * verifies promotion is safe. No real deployment is touched.
 */
export function rehearsePromotionRollback(
  paths: Partial<ReturnType<typeof fixturePaths>> = {},
): PromotionRehearsal {
  const resolvedPaths = { ...fixturePaths(), ...paths };
  const changeReport: G1PromotionConfigReport = buildG1PromotionConfigReport({
    isolatedAcceptance: parseEffectiveConfigurationSnapshot(
      readFixture(resolvedPaths.isolatedPath),
    ),
    currentProduction: parseEffectiveConfigurationSnapshot(
      readFixture(resolvedPaths.productionPath),
    ),
    candidateDeployment: parseEffectiveConfigurationSnapshot(
      readFixture(resolvedPaths.candidateChangePath),
    ),
  });
  const recoveredReport = buildG1PromotionConfigReport({
    isolatedAcceptance: parseEffectiveConfigurationSnapshot(
      readFixture(resolvedPaths.isolatedPath),
    ),
    currentProduction: parseEffectiveConfigurationSnapshot(
      readFixture(resolvedPaths.productionPath),
    ),
    candidateDeployment: parseEffectiveConfigurationSnapshot(
      readFixture(resolvedPaths.candidateRecoveredPath),
    ),
  });

  const blockedKeys = changeReport.blockers.map((blocker) => blocker.key);
  const restoreKeys = changeReport.differences
    .filter((difference) => difference.status === "incompatible")
    .map((difference) => difference.key);

  const steps: RehearsalStep[] = [
    {
      stage: "candidate-change",
      outcome:
        blockedKeys.length > 0
          ? `promotion_blocked on ${blockedKeys.join(", ")}`
          : "candidate_change_allowed",
      evidence: `buildG1PromotionConfigReport(isolated, current-production, candidate-change) promotion_allowed=${changeReport.promotionAllowed} blockers=${
        blockedKeys.join(",") || "none"
      }`,
    },
    {
      stage: "variable-recovery",
      outcome: `variables restored for ${restoreKeys.join(", ") || "no changed key"} and redeployed`,
      evidence:
        changeReport.rollback.steps.map((step) => step.action).join(" | "),
    },
    {
      stage: "verification",
      outcome: recoveredReport.promotionAllowed
        ? "promotion_allowed after recovery"
        : `promotion_blocked after recovery on ${recoveredReport.blockers
            .map((blocker) => blocker.key)
            .join(", ")}`,
      evidence: `re-read comparison config_digest=${recoveredReport.configDigest} promotion_allowed=${recoveredReport.promotionAllowed}`,
    },
  ];

  return {
    description:
      "Synthetic non-production rehearsal of ticket #282's promotion/rollback fixtures; no real deployment was touched.",
    steps,
    productionUntouched: true,
  };
}

/** A fully synthetic closure input for the `--fixture` mode and the unit tests. */
export function syntheticClosureFixture(): ReleaseClosureInput {
  return {
    collectedAt: "2026-10-08T07:30:00.000Z",
    repository: {
      integrationBranch: "integration/spec-275",
      integrationCommit: FIXTURE_INTEGRATION_COMMIT,
      baseCommit: FIXTURE_BASE_COMMIT,
      acceptanceCommit: null,
    },
    pullRequest: {
      number: 285,
      url: "https://github.com/lukemyself-hub/SayHear/pull/285",
      baseBranch: "main",
      headBranch: "integration/spec-275",
      draft: true,
    },
    ciRuns: [
      {
        id: 37741892121,
        workflow: "PR Validate",
        event: "pull_request",
        branch: "integration/spec-275",
        commit: FIXTURE_INTEGRATION_COMMIT,
        status: "in_progress",
        conclusion: null,
        createdAt: "2026-10-08T07:11:09Z",
        url: "https://github.com/lukemyself-hub/SayHear/actions/runs/37741892121",
      },
      apiRun(37732855645, "PR Validate", "pull_request", "6937f376de9e68871ca4bfc8f3238384dee79f8f", "2026-10-08T05:32:03Z"),
    ],
    requiredChecks: {
      status: "plan-blocked",
      detail:
        "Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)",
    },
    deploymentIdentity: {
      production: {
        status: "unverified",
        commit: null,
        deploymentId: null,
        projectId: null,
        teamId: null,
        businessTargetHash: null,
        purgeMarkerTargetHash: null,
        reason:
          "No production deployment has occurred for the integration branch and no authorized production read is available.",
      },
      candidate: {
        status: "unverified",
        commit: null,
        deploymentId: null,
        projectId: null,
        teamId: null,
        businessTargetHash: null,
        purgeMarkerTargetHash: null,
        reason:
          "No candidate deployment exists; the only promotion evidence is the synthetic rehearsal.",
      },
    },
    promotion: {
      status: "blocked",
      command: "pnpm release:promotion:report",
      configDigest: null,
      promotionAllowed: null,
      blockerKeys: [],
      note:
        "Current-production/candidate comparison is blocked without a candidate deployment and an authorized production config read; the synthetic rehearsal is recorded instead.",
    },
    acceptance: ACCEPTANCE_EVIDENCE,
    schedulers: [
      {
        workflowId: 336293901,
        name: "Internal Recovery Scan",
        path: ".github/workflows/internal-recovery-scan.yml",
        state: "active",
        schedule: ["13 * * * *"],
        lastRuns: [
          apiRun(37715214472, "Internal Recovery Scan", "schedule", FIXTURE_BASE_COMMIT, "2026-10-08T01:54:13Z"),
          apiRun(37705683165, "Internal Recovery Scan", "workflow_dispatch", FIXTURE_BASE_COMMIT, "2026-10-08T00:03:26Z"),
        ],
        lastScheduledConclusion: "success",
        target:
          "vars.RECOVERY_SCAN_URL through the original /api/internal/recovery/scan dispatch",
        note:
          "Hourly schedule and empty-url dispatch call the original scan path; a url-carrying dispatch uses the scoped identity/recovery route.",
      },
      {
        workflowId: 349048917,
        name: "Backup Evidence Renewal",
        path: ".github/workflows/backup-evidence-renewal.yml",
        state: "active",
        schedule: ["13 4 1 * *"],
        lastRuns: [
          apiRun(36852051522, "Backup Evidence Renewal", "schedule", FIXTURE_BASE_COMMIT, "2026-10-01T10:54:43Z"),
        ],
        lastScheduledConclusion: "success",
        target:
          "Neon PITR history window verification, then db:record-backup (+30 days)",
        note:
          "Monthly fail-closed renewal; the last recorded run is readable and successful.",
      },
    ],
    visualFunctional: {
      harness: "scripts/portal-visual-acceptance.mjs",
      command: "node scripts/portal-visual-acceptance.mjs",
      committed: true,
      screenshotsCommitted: false,
      result:
        "Committed harness renders the real stylesheet at 320/390/1024/1280/1440px with synthetic long dates and tool names.",
      note:
        "Screenshots are local evidence and are not committed; the post-deploy browser acceptance is pending.",
    },
    rehearsal: rehearsePromotionRollback(),
    rollback: ROLLBACK_ACTIONS,
    limitations: LIMITATIONS,
  };
}

function latestRun(runs: readonly CiRunEvidence[]): CiRunEvidence | null {
  return runs.length > 0 ? (runs[0] ?? null) : null;
}

function blockersFor(input: ReleaseClosureInput): ClosureBlocker[] {
  const blockers: ClosureBlocker[] = [];

  if (input.requiredChecks.status !== "enabled") {
    blockers.push({
      id:
        input.requiredChecks.status === "plan-blocked"
          ? "required-status-checks-plan-blocked"
          : "required-status-checks-unverified",
      category: "platform-permission",
      item: "required-status-checks",
      reason: input.requiredChecks.detail,
    });
  }

  if (input.deploymentIdentity.production.status !== "verified") {
    blockers.push({
      id: "production-deployment-identity",
      category: "production",
      item: "production-deployment-identity",
      reason: input.deploymentIdentity.production.reason,
    });
  }

  if (
    input.promotion.status !== "collected" ||
    input.promotion.promotionAllowed !== true
  ) {
    blockers.push({
      id: "promotion-config-comparison",
      category: "production",
      item: "promotion-config-comparison",
      reason: input.promotion.note,
    });
  }

  const ci = latestRun(input.ciRuns);
  if (ci === null || ci.status !== "completed" || ci.conclusion !== "success") {
    blockers.push({
      id: "ci-latest-run-not-success",
      category: "ci",
      item: "pr-ci",
      reason:
        ci === null
          ? "No CI run is readable for the integration branch."
          : `Latest CI run ${ci.id} is status=${ci.status} conclusion=${ci.conclusion ?? "none"}.`,
    });
  }

  for (const evidence of input.acceptance) {
    if (evidence.blocker !== null) {
      blockers.push({
        id: `acceptance-${evidence.id.toLowerCase()}`,
        category: "unverified",
        item: evidence.id,
        reason: evidence.blocker,
      });
    }
  }

  if (!input.rehearsal.productionUntouched) {
    blockers.push({
      id: "rehearsal-touched-production",
      category: "production",
      item: "promotion-rehearsal",
      reason: "The promotion/rollback rehearsal must not touch a real deployment.",
    });
  }

  return blockers;
}

/**
 * Pure aggregation. The report is content-free by construction, and the final
 * content-free assertion fails closed before a report can be emitted.
 */
export function buildReleaseClosureReport(
  input: ReleaseClosureInput,
): ReleaseClosureReport {
  const blockers = blockersFor(input);
  const report: ReleaseClosureReport = {
    ...input,
    version: RELEASE_CLOSURE_REPORT_VERSION,
    closureStatus: blockers.length === 0 ? "closed" : "blocked",
    blockers,
    summary: {
      ciLatestConclusion: latestRun(input.ciRuns)?.conclusion ?? null,
      acceptanceVerified: input.acceptance.filter(
        (entry) => entry.status === "verified",
      ).length,
      acceptanceBlocked: input.acceptance.filter(
        (entry) => entry.status === "blocked",
      ).length,
      schedulerActive: input.schedulers.filter(
        (entry) => entry.state === "active",
      ).length,
      schedulerTotal: input.schedulers.length,
    },
  };
  assertReleaseClosureContentFree(report);
  return report;
}

/** Fail closed rather than writing a secret, connection string or private body. */
export function assertReleaseClosureContentFree(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (containsForbiddenContent(serialized)) {
    throw new Error(
      "Release closure report is not content-free; secret values, connection strings and private bodies are never recorded.",
    );
  }
}

/** One compact summary; detail stays in the written report. */
export function formatReleaseClosureReport(report: ReleaseClosureReport): string {
  const ci = report.ciRuns[0] ?? null;
  const lines = [
    `release closure report ${report.version}`,
    `collected_at=${report.collectedAt}`,
    `closure_status=${report.closureStatus}`,
    `pr=#${report.pullRequest.number} ${report.repository.integrationBranch}@${report.repository.integrationCommit} draft=${report.pullRequest.draft}`,
    `ci_latest=${
      ci === null
        ? "none"
        : `run:${ci.id} status=${ci.status} conclusion=${ci.conclusion ?? "none"}`
    }`,
    `required_checks=${report.requiredChecks.status}`,
    `production_identity=${report.deploymentIdentity.production.status}`,
    `candidate_identity=${report.deploymentIdentity.candidate.status}`,
    `promotion=${report.promotion.status} allowed=${String(report.promotion.promotionAllowed)}`,
    `acceptance=verified:${report.summary.acceptanceVerified} blocked:${report.summary.acceptanceBlocked} total:${report.acceptance.length}`,
    `schedulers=${report.summary.schedulerActive}/${report.summary.schedulerTotal} active`,
    `rehearsal_production_untouched=${report.rehearsal.productionUntouched}`,
  ];
  for (const blocker of report.blockers) {
    lines.push(`blocker ${blocker.id} ${blocker.category} ${blocker.item}`);
  }
  for (const evidence of report.acceptance) {
    lines.push(
      `acceptance ${evidence.id} status=${evidence.status} tickets=${evidence.tickets.join(",")} commits=${evidence.commits.join(",")}`,
    );
  }
  for (const scheduler of report.schedulers) {
    lines.push(
      `scheduler ${scheduler.workflowId} ${scheduler.name} state=${scheduler.state} cron=${scheduler.schedule.join(";") || "none"} last_scheduled=${scheduler.lastScheduledConclusion ?? "none"}`,
    );
  }
  return lines.join("\n");
}

/** A concise, content-free Markdown section the orchestrator can paste into the PR. */
export function renderReleaseClosureSummary(report: ReleaseClosureReport): string {
  const ci = report.ciRuns[0] ?? null;
  const lines: string[] = [
    "## 发布闭合摘要（SPEC #275 / ticket #284）",
    "",
    `- **CI**：PR #${report.pullRequest.number}（\`${report.repository.integrationBranch}\` @ \`${report.repository.integrationCommit}\`${report.pullRequest.draft ? "，draft" : ""}）最近 run ${
      ci === null
        ? "不可读"
        : `\`${ci.id}\` status=${ci.status} conclusion=${ci.conclusion ?? "none"}`
    }；required status check：\`${report.requiredChecks.status}\`（${report.requiredChecks.detail}）。`,
    `- **差异报告**：\`${report.promotion.command}\` → \`${report.promotion.status}\`。${report.promotion.note}`,
    `- **部署身份**：integration commit \`${report.repository.integrationCommit}\`，base \`${report.pullRequest.baseBranch}\` @ \`${report.repository.baseCommit}\`；production identity \`${report.deploymentIdentity.production.status}\`（${report.deploymentIdentity.production.reason}）。`,
    `- **视觉/功能**：#283 harness \`${report.visualFunctional.harness}\`，命令 \`${report.visualFunctional.command}\`；screenshots committed=${report.visualFunctional.screenshotsCommitted}。${report.visualFunctional.note}`,
    `- **Scheduler**：${report.schedulers
      .map(
        (scheduler) =>
          `\`${scheduler.name}\` id=${scheduler.workflowId} state=${scheduler.state} cron=\`${scheduler.schedule.join("; ") || "none"}\` last_scheduled=${scheduler.lastScheduledConclusion ?? "none"}`,
      )
      .join("；")}。`,
    `- **回滚动作**：${report.rollback
      .map((step) => `${step.order}) ${step.action}`)
      .join(" ")}`,
    `- **阻塞/限制**：${
      report.blockers.length === 0
        ? "无"
        : report.blockers.map((blocker) => `\`${blocker.id}\`（${blocker.reason}）`).join("；")
    }。`,
  ];
  if (report.limitations.length > 0) {
    lines.push(
      `- **剩余限制**：${report.limitations.map((entry) => entry).join("；")}。`,
    );
  }
  return lines.join("\n");
}

export function parseGhRuns(stdout: string): CiRunEvidence[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("gh run list did not return a JSON array.");
  }
  return parsed.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`gh run list entry ${index} is not an object.`);
    }
    const raw = entry as Record<string, unknown>;
    return {
      id: Number(raw.databaseId ?? raw.id ?? 0),
      workflow: String(raw.workflowName ?? raw.name ?? ""),
      event: String(raw.event ?? ""),
      branch: String(raw.headBranch ?? raw.branch ?? ""),
      commit: String(raw.headSha ?? raw.commit ?? ""),
      status: String(raw.status ?? ""),
      conclusion:
        raw.conclusion === undefined ||
        raw.conclusion === null ||
        raw.conclusion === ""
          ? null
          : String(raw.conclusion),
      createdAt: String(raw.createdAt ?? ""),
      url: String(raw.url ?? ""),
    };
  });
}

export function parseWorkflowCron(workflow: string): string[] {
  const schedules: string[] = [];
  const pattern = /-\s*cron:\s*["']?([^"'\n]+?)["']?\s*$/gm;
  for (const match of workflow.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (value && !schedules.includes(value)) schedules.push(value);
  }
  return schedules;
}

export type CollectReleaseClosureOptions = Readonly<{
  runner?: CommandRunner;
  repository?: string;
  pullRequestNumber?: number;
  integrationBranch?: string;
  baseBranch?: string;
  promotionReportPath?: string | null;
  visualResult?: string;
  collectedAt?: string;
  workflowDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  fetcher?: ReleaseIdentityFetcher;
}>;

const defaultRunner: CommandRunner = async (command, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
};

async function requireGhJson(
  runner: CommandRunner,
  args: readonly string[],
): Promise<unknown> {
  const result = await runner("gh", args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `gh ${args.join(" ")} failed`);
  }
  return JSON.parse(result.stdout) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReleaseIdentity(value: unknown): ReleaseIdentity | null {
  if (!isRecord(value)) return null;
  const expectedKeys = [
    "businessTargetHash",
    "commit",
    "environment",
    "projectId",
    "purgeMarkerTargetHash",
    "teamId",
    "version",
  ];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key)) ||
    value.version !== "1a3b-g1-hosted-release-identity:v1" ||
    typeof value.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.commit) ||
    value.environment !== "production" ||
    value.projectId !== PRODUCTION_VERCEL_PROJECT_ID ||
    (value.teamId !== null && typeof value.teamId !== "string") ||
    typeof value.businessTargetHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.businessTargetHash) ||
    typeof value.purgeMarkerTargetHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.purgeMarkerTargetHash)
  ) {
    return null;
  }
  return value as ReleaseIdentity;
}

async function readProductionReleaseIdentity(input: {
  endpoint: string | undefined;
  fetcher: ReleaseIdentityFetcher;
  secret: string | undefined;
}): Promise<DeploymentIdentityState> {
  const unverified = (reason: string): DeploymentIdentityState => ({
    status: "unverified",
    commit: null,
    deploymentId: null,
    projectId: null,
    teamId: null,
    businessTargetHash: null,
    purgeMarkerTargetHash: null,
    reason,
  });
  if (!input.secret) {
    return unverified(
      "CRON_SECRET is unavailable for the authenticated production identity read.",
    );
  }
  if (!input.endpoint) {
    return unverified(
      "RECOVERY_SCAN_URL is unavailable for resolving the production release-identity endpoint.",
    );
  }
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    return unverified(
      "RECOVERY_SCAN_URL is not a valid production recovery scan URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    !/^(say-hear-web|say-hear-[a-z0-9]+-lukemyself)\.vercel\.app$/.test(url.hostname) ||
    url.pathname !== "/api/internal/recovery/scan" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return unverified(
      "RECOVERY_SCAN_URL does not identify the production recovery scan endpoint.",
    );
  }
  url.pathname = "/api/internal/inspection/release-identity";
  try {
    const response = await input.fetcher(url.toString(), {
      headers: { authorization: `Bearer ${input.secret}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      return unverified(
        `Authenticated production release-identity read returned HTTP ${response.status}.`,
      );
    }
    const identity = parseReleaseIdentity(await response.json());
    if (!identity) {
      return unverified("Authenticated production release-identity response had an unexpected shape.");
    }
    return {
      status: "verified",
      commit: identity.commit,
      deploymentId: null,
      projectId: identity.projectId,
      teamId: identity.teamId,
      businessTargetHash: identity.businessTargetHash,
      purgeMarkerTargetHash: identity.purgeMarkerTargetHash,
      reason: "read from the authenticated release-identity endpoint",
    };
  } catch {
    return unverified("Authenticated production release-identity read failed or was unreadable.");
  }
}

async function readRecoveryScanEndpoint(
  runner: CommandRunner,
  environment: Readonly<Record<string, string | undefined>>,
  repository: string,
): Promise<string | undefined> {
  if (environment.RECOVERY_SCAN_URL) return environment.RECOVERY_SCAN_URL;
  try {
    const result = await runner("gh", [
      "variable",
      "get",
      "RECOVERY_SCAN_URL",
      "--repo",
      repository,
    ]);
    return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

function trimSha(stdout: string): string | null {
  const value = stdout.trim().split("\n")[0]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

async function verifyAcceptanceCommits(
  evidence: readonly AcceptanceEvidence[],
  runner: CommandRunner,
): Promise<AcceptanceEvidence[]> {
  const present = new Map<string, boolean>();
  const verified: AcceptanceEvidence[] = [];
  for (const entry of evidence) {
    let blocker = entry.blocker;
    let status = entry.status;
    for (const commit of entry.commits) {
      if (!present.has(commit)) {
        const result = await runner("git", ["cat-file", "-e", `${commit}^{commit}`]);
        present.set(commit, result.exitCode === 0);
      }
      if (present.get(commit) !== true) {
        status = "blocked";
        blocker = `Referenced ticket commit ${commit} is not present in this checkout.`;
      }
    }
    verified.push(
      blocker === entry.blocker && status === entry.status
        ? entry
        : { ...entry, status, blocker },
    );
  }
  return verified;
}

async function parsePromotionStatus(
  path: string | null,
): Promise<PromotionStatus> {
  if (path === null) {
    return {
      status: "blocked",
      command: "pnpm release:promotion:report",
      configDigest: null,
      promotionAllowed: null,
      blockerKeys: [],
      note:
        "Current-production/candidate comparison is blocked without a candidate deployment and an authorized production config read; the synthetic rehearsal is recorded instead.",
    };
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const blockers = Array.isArray(value.blockers)
    ? (value.blockers as Array<Record<string, unknown>>)
    : [];
  return {
    status: "collected",
    command: "pnpm release:promotion:report",
    configDigest:
      typeof value.configDigest === "string" ? value.configDigest : null,
    promotionAllowed: value.promotionAllowed === true,
    blockerKeys: blockers.map((blocker) => String(blocker.key ?? "")),
    note: `Promotion report ${String(value.version ?? "unknown")} read from ${basename(path)}.`,
  };
}

/**
 * The only reader. It shells out to `gh` and `git` through an injectable runner,
 * records the 403 required-check state as `plan-blocked`, never falls back to
 * local environment declarations for a deployment value, and never invokes a
 * Provider or a deployment.
 */
export async function collectReleaseClosureInput(
  options: CollectReleaseClosureOptions = {},
): Promise<ReleaseClosureInput> {
  const runner = options.runner ?? defaultRunner;
  const repository = options.repository ?? "lukemyself-hub/SayHear";
  if (options.pullRequestNumber === undefined) {
    throw new Error(
      "Release closure requires an explicit pullRequestNumber; there is no SPEC-specific default.",
    );
  }
  if (!options.integrationBranch) {
    throw new Error(
      "Release closure requires an explicit integrationBranch; there is no SPEC-specific default.",
    );
  }
  if (!options.baseBranch) {
    throw new Error(
      "Release closure requires an explicit baseBranch; there is no SPEC-specific default.",
    );
  }
  const pullRequestNumber = options.pullRequestNumber;
  const integrationBranch = options.integrationBranch;
  const baseBranch = options.baseBranch;
  const collectedAt = options.collectedAt ?? new Date().toISOString();
  const workflowDirectory =
    options.workflowDirectory ??
    join(repositoryRoot, ".github", "workflows");
  const promotionReportPath = options.promotionReportPath ?? null;

  const headResult = await runner("git", ["rev-parse", "HEAD"]);
  const baseResult = await runner("git", ["rev-parse", baseBranch]);

  let pullRequest: ReleaseClosureInput["pullRequest"] = {
    number: pullRequestNumber,
    url: `https://github.com/${repository}/pull/${pullRequestNumber}`,
    baseBranch,
    headBranch: integrationBranch,
    draft: true,
  };
  let prHeadOid: string | null = null;
  let prBaseOid: string | null = null;
  try {
    const raw = (await requireGhJson(runner, [
      "pr",
      "view",
      String(pullRequestNumber),
      "--repo",
      repository,
      "--json",
      "number,url,baseRefName,headRefName,isDraft,headRefOid,baseRefOid",
    ])) as Record<string, unknown>;
    pullRequest = {
      number: Number(raw.number ?? pullRequestNumber),
      url: String(raw.url ?? pullRequest.url),
      baseBranch: String(raw.baseRefName ?? baseBranch),
      headBranch: String(raw.headRefName ?? integrationBranch),
      draft: raw.isDraft === true,
    };
    prHeadOid = typeof raw.headRefOid === "string" ? raw.headRefOid : null;
    prBaseOid = typeof raw.baseRefOid === "string" ? raw.baseRefOid : null;
  } catch {
    // The PR may be unreadable; the git refs below are then the only allowed
    // source, and the report fails closed if neither can establish identity.
  }

  // The remote PR head/base SHAs are the authority for remote delivery; the
  // local `git rev-parse` values are only a fallback because a worktree's local
  // branch ref can lag `origin`. There is deliberately no hard-coded fallback:
  // identity that cannot be established fails the report instead of being
  // asserted from a SPEC-specific constant.
  const integrationCommit = prHeadOid ?? trimSha(headResult.stdout);
  const baseCommit = prBaseOid ?? trimSha(baseResult.stdout);
  if (integrationCommit === null) {
    throw new Error(
      "Release closure could not establish the integration commit identity: the pull request head and `git rev-parse HEAD` were both unreadable; refusing to assert a default identity.",
    );
  }
  if (baseCommit === null) {
    throw new Error(
      "Release closure could not establish the base commit identity: the pull request base and `git rev-parse` were both unreadable; refusing to assert a default identity.",
    );
  }

  const runsResult = await runner("gh", [
    "run",
    "list",
    "--repo",
    repository,
    "--branch",
    integrationBranch,
    "--limit",
    "20",
    "--json",
    "databaseId,workflowName,event,headBranch,headSha,status,conclusion,createdAt,url",
  ]);
  const ciRuns = runsResult.exitCode === 0 ? parseGhRuns(runsResult.stdout) : [];

  const protection = await runner("gh", [
    "api",
    `repos/${repository}/branches/${baseBranch}/protection`,
  ]);
  let requiredChecks: RequiredCheckState;
  if (protection.exitCode === 0) {
    requiredChecks = {
      status: "enabled",
      detail: "Required status check protection is enabled on the base branch.",
    };
  } else {
    const message = `${protection.stderr}\n${protection.stdout}`.trim();
    requiredChecks = /Upgrade to GitHub Pro|make this repository public/i.test(
      message,
    )
      ? {
          status: "plan-blocked",
          detail: message.split("\n")[0] ?? "upgrade required",
        }
      : {
          status: "unverified",
          detail: message || "Branch protection could not be read.",
        };
  }

  let workflows: Array<{
    id: number;
    name: string;
    path: string;
    state: string;
  }> = [];
  try {
    const raw = (await requireGhJson(runner, [
      "api",
      `repos/${repository}/actions/workflows`,
    ])) as { workflows?: unknown };
    if (Array.isArray(raw.workflows)) {
      workflows = (raw.workflows as Array<Record<string, unknown>>).map(
        (entry) => ({
          id: Number(entry.id ?? 0),
          name: String(entry.name ?? ""),
          path: String(entry.path ?? ""),
          state: String(entry.state ?? "unknown"),
        }),
      );
    }
  } catch {
    workflows = [];
  }

  async function observeScheduler(
    name: string,
    path: string,
    target: string,
  ): Promise<SchedulerObservation> {
    const meta = workflows.find((entry) => entry.path === path);
    const pathName = basename(path);
    const schedulerRuns = await runner("gh", [
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      pathName,
      "--limit",
      "5",
      "--json",
      "databaseId,workflowName,event,headBranch,headSha,status,conclusion,createdAt,url",
    ]);
    const lastRuns =
      schedulerRuns.exitCode === 0 ? parseGhRuns(schedulerRuns.stdout) : [];
    let schedule: string[] = [];
    try {
      schedule = parseWorkflowCron(
        await readFile(join(workflowDirectory, pathName), "utf8"),
      );
    } catch {
      schedule = [];
    }
    const lastScheduled = lastRuns.find((entry) => entry.event === "schedule");
    return {
      workflowId: meta?.id ?? pathName,
      name: meta?.name ?? name,
      path,
      state: meta?.state ?? "unknown",
      schedule,
      lastRuns,
      lastScheduledConclusion: lastScheduled?.conclusion ?? null,
      target,
      note: meta
        ? "Workflow state and last runs were read read-only from the GitHub API."
        : "Workflow metadata could not be read; only the last runs and local schedule are recorded.",
    };
  }

  const schedulers: SchedulerObservation[] = [
    await observeScheduler(
      "Internal Recovery Scan",
      ".github/workflows/internal-recovery-scan.yml",
      "vars.RECOVERY_SCAN_URL through the original /api/internal/recovery/scan dispatch",
    ),
    await observeScheduler(
      "Backup Evidence Renewal",
      ".github/workflows/backup-evidence-renewal.yml",
      "Neon PITR history window verification, then db:record-backup (+30 days)",
    ),
  ];

  const acceptance = await verifyAcceptanceCommits(ACCEPTANCE_EVIDENCE, runner);
  const promotion = await parsePromotionStatus(promotionReportPath);
  const environment = options.environment ?? process.env;
  const productionIdentityEndpoint = await readRecoveryScanEndpoint(
    runner,
    environment,
    repository,
  );
  const productionIdentity = await readProductionReleaseIdentity({
    endpoint: productionIdentityEndpoint,
    fetcher: options.fetcher ?? fetch,
    secret: environment.CRON_SECRET,
  });

  return {
    collectedAt,
    repository: {
      integrationBranch,
      integrationCommit,
      baseCommit,
      acceptanceCommit: null,
    },
    pullRequest,
    ciRuns,
    requiredChecks,
    deploymentIdentity: {
      production: productionIdentity,
      candidate: {
        status: "unverified",
        commit: null,
        deploymentId: null,
        projectId: null,
        teamId: null,
        businessTargetHash: null,
        purgeMarkerTargetHash: null,
        reason:
          "No candidate deployment exists; the only promotion evidence is the synthetic rehearsal.",
      },
    },
    promotion,
    acceptance,
    schedulers,
    visualFunctional: {
      harness: "scripts/portal-visual-acceptance.mjs",
      command: "node scripts/portal-visual-acceptance.mjs",
      committed: true,
      screenshotsCommitted: false,
      result: options.visualResult ?? "not recorded in this process",
      note:
        "Screenshots are local evidence and are not committed; the post-deploy browser acceptance is pending.",
    },
    rehearsal: rehearsePromotionRollback(),
    rollback: ROLLBACK_ACTIONS,
    limitations: LIMITATIONS,
  };
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args.set(token, "true");
      continue;
    }
    args.set(token, value);
    index += 1;
  }
  return args;
}

/**
 * The report is written even while closure is blocked, and the process exits
 * non-zero so an incomplete closure can never be read as a completed one.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: { stdout: (line: string) => void } = {
    stdout: (line) => process.stdout.write(`${line}\n`),
  },
): Promise<number> {
  const args = parseArgs(argv);
  if (args.has("--fixture")) {
    const report = buildReleaseClosureReport(syntheticClosureFixture());
    io.stdout(formatReleaseClosureReport(report));
    if (args.has("--summary")) {
      io.stdout(renderReleaseClosureSummary(report));
    }
    const reportPath = args.get("--report");
    if (reportPath) {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      io.stdout(`report written to ${reportPath}`);
    }
    return report.closureStatus === "closed" ? 0 : 1;
  }

  // Identity is never guessed: the live reader needs an explicit pull request
  // and branches, so a stale SPEC-specific default can never be recorded.
  const missing = ["--pr", "--branch", "--base"].filter(
    (flag) => !args.has(flag),
  );
  if (missing.length > 0) {
    throw new Error(
      `Release closure report requires explicit identity: missing ${missing.join(", ")}. Usage: release-closure-report.ts --pr <n> --branch <head> --base <base> [--summary] [--report <file>] | --fixture`,
    );
  }

  const input = await collectReleaseClosureInput({
    repository: args.get("--repo") ?? "lukemyself-hub/SayHear",
    pullRequestNumber: Number(args.get("--pr")),
    integrationBranch: args.get("--branch") as string,
    baseBranch: args.get("--base") as string,
    promotionReportPath: args.get("--promotion-report") ?? null,
    visualResult: args.get("--visual-result") ?? "not recorded in this process",
    collectedAt: new Date().toISOString(),
  });

  const report = buildReleaseClosureReport(input);
  io.stdout(formatReleaseClosureReport(report));
  if (args.has("--summary")) {
    io.stdout(renderReleaseClosureSummary(report));
  }
  const reportPath = args.get("--report");
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    io.stdout(`report written to ${reportPath}`);
  }
  return report.closureStatus === "closed" ? 0 : 1;
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
