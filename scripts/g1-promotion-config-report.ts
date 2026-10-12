/**
 * Promotion effective-configuration difference and rollback report.
 *
 * SPEC #275 decisions 5 and 7 require the daily release tool to compare the
 * deployed effective configuration before acceptance (isolated environment vs
 * current production) and before promotion (candidate deployment vs current
 * production), reusing one collection/comparison implementation. This module
 * is that one promotion seam, and it imports the #278 gate rather than forking
 * its comparison logic.
 *
 * The report binds the actual candidate commit, deployment id, collection time
 * and config digest. Each difference carries its expected/unexpected label,
 * reason, behavior impact, verification, rollback value and rollback action.
 * Only a critical incompatibility, a critical unknown that blocks this
 * acceptance, or a lost scheduled trigger becomes a blocker, and it names the
 * single operation it blocks (SPEC #275 decision 7). Unreadable sensitive
 * configuration is reported `unverified`, never assumed equal, and no secret,
 * low-entropy secret hash or private content is ever recorded.
 *
 * The rollback plan is consistent with the single-role authorization contract
 * from ticket #280 / ADR-0148: it restores the affected environment variables,
 * redeploys, revokes/reauthorizes only the roles whose immutable configuration
 * changed, verifies the effective configuration again, and keeps historical
 * acceptance evidence at its original commit and content identity.
 *
 * Repeatable commands (no real deployment or model call):
 *
 *   pnpm exec tsx scripts/g1-promotion-config-report.ts \
 *     --isolated isolated.json --production production.json \
 *     --candidate candidate.json --report report.json
 *
 * The JSON files come from the deployed inspection endpoint
 * (`/api/internal/inspection/effective-runtime-config`) fetched with the Cron
 * bearer or an authenticated Owner. Local environment declarations are never
 * the authority for a deployment.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { ONE_A_3B_G1_ENABLED_ROLES } from "@sayhear/application";

import {
  compareEffectiveRuntimeConfiguration,
  effectiveRuntimeConfigDigest,
  parseEffectiveConfigurationSnapshot,
  readEffectiveRuntimeConfiguration,
  type EffectiveConfigItemSource,
  type EffectiveConfigItemValue,
  type EffectiveConfigurationItem,
  type EffectiveConfigurationSnapshot,
  type EffectiveConfigItemStatus,
  type EffectiveRuntimeConfigCategory,
  type EffectiveRuntimeConfigurationComparison,
} from "./effective-runtime-config-gate";

const execFileAsync = promisify(execFile);

export type PromotionCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type PromotionCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<PromotionCommandResult>;

const defaultRunner: PromotionCommandRunner = async (command, args) => {
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

export const G1_PROMOTION_CONFIG_REPORT_VERSION =
  "1a3b-g1-promotion-config-report:v1";

export const PROMOTION_ENVIRONMENT_ROLES = [
  "isolated-acceptance",
  "current-production",
  "candidate-deployment",
] as const;

export type PromotionEnvironmentRole =
  (typeof PROMOTION_ENVIRONMENT_ROLES)[number];

export type PromotionComparisonStage = "acceptance" | "promotion";

/**
 * The scheduled triggers SPEC #275 decisions 6 and 7 require the promotion
 * comparison to cover. Their real value is owned by the repository workflow at
 * the compared commit, not by the deployed web process, so
 * {@link resolveScheduleTargetItems} reads them from git at that ref. A ref or
 * file that cannot be read stays `unverified` (never equal) and is reported as
 * a platform read blocker.
 */
export const SCHEDULE_TARGET_WORKFLOWS: Readonly<
  Record<
    string,
    Readonly<{ kind: "recovery" | "backup"; path: string }>
  >
> = {
  "schedule.recovery_scan_target": {
    kind: "recovery",
    path: ".github/workflows/internal-recovery-scan.yml",
  },
  "schedule.backup_renewal_target": {
    kind: "backup",
    path: ".github/workflows/backup-evidence-renewal.yml",
  },
};

/**
 * The content-free schedule value derived from one workflow file: the cron
 * expression plus the target/destination the schedule selects. A missing cron
 * or a missing target is `null`, so the comparison sees a real lost trigger
 * rather than an assumption of equality.
 */
export function scheduleTargetValue(
  workflow: string,
  kind: "recovery" | "backup",
): EffectiveConfigItemValue {
  const crons = [
    ...workflow.matchAll(/-\s*cron:\s*["']?([^"'\n]+?)["']?\s*$/gm),
  ]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  if (crons.length === 0) return null;
  const target =
    kind === "recovery"
      ? /api\/internal\/recovery\/scan/.test(workflow) &&
        /RECOVERY_SCAN_URL/.test(workflow)
        ? "vars.RECOVERY_SCAN_URL -> /api/internal/recovery/scan"
        : null
      : /db:record-backup/.test(workflow)
        ? "db:record-backup (+30 days after the Neon PITR window verifies)"
        : null;
  if (!target) return null;
  return `${crons.join(",")} -> ${target}`;
}

/** Read a workflow file at a commit; `null` means the ref/file was unreadable. */
export type ScheduleTargetReader = (
  path: string,
  commit: string,
) => Promise<string | null>;

/** The default reader: `git show <commit>:<path>`, never the working tree. */
export function gitScheduleTargetReader(
  runner: PromotionCommandRunner = defaultRunner,
): ScheduleTargetReader {
  return async (path, commit) => {
    const result = await runner("git", ["show", `${commit}:${path}`]);
    return result.exitCode === 0 ? result.stdout : null;
  };
}

export type ScheduleTargetResolution = Readonly<{
  items: readonly EffectiveConfigurationItem[];
  /** Keys whose ref/file was unreadable and therefore stay `unverified`. */
  unreadable: readonly string[];
}>;

export async function resolveScheduleTargetItems(
  commit: string,
  readWorkflowAtRef: ScheduleTargetReader,
): Promise<ScheduleTargetResolution> {
  const items: EffectiveConfigurationItem[] = [];
  const unreadable: string[] = [];
  for (const [key, { kind, path }] of Object.entries(SCHEDULE_TARGET_WORKFLOWS)) {
    const workflow = await readWorkflowAtRef(path, commit);
    if (workflow === null) {
      unreadable.push(key);
      continue;
    }
    items.push({
      category: "schedule-targets",
      critical: false,
      inManifestFingerprint: false,
      key,
      source: "platform",
      value: scheduleTargetValue(workflow, kind),
    });
  }
  return { items, unreadable };
}

function scheduleItemsMissingOrUnverified(
  snapshot: EffectiveConfigurationSnapshot,
): boolean {
  const byKey = new Map(snapshot.items.map((item) => [item.key, item]));
  return Object.keys(SCHEDULE_TARGET_WORKFLOWS).some((key) => {
    const entry = byKey.get(key);
    return entry === undefined || entry.source === "unverified";
  });
}

function withScheduleTargets(
  snapshot: EffectiveConfigurationSnapshot,
  extra: readonly EffectiveConfigurationItem[] | undefined,
): EffectiveConfigurationSnapshot {
  if (!extra || extra.length === 0) return snapshot;
  const byKey = new Map(snapshot.items.map((item) => [item.key, item]));
  for (const item of extra) byKey.set(item.key, item);
  return { ...snapshot, items: [...byKey.values()] };
}

export type PromotionEnvironmentEvidence = Readonly<{
  collectedAt: string;
  commit: string;
  configDigest: string;
  deploymentId: string;
  role: PromotionEnvironmentRole;
  values: readonly Readonly<{
    category: EffectiveRuntimeConfigCategory;
    defaultValue: EffectiveConfigItemValue | null;
    inManifestFingerprint: boolean;
    key: string;
    platformLimit: EffectiveConfigItemValue | null;
    source: EffectiveConfigItemSource;
    value: EffectiveConfigItemValue;
  }>[];
}>;

export type PromotionDifference = Readonly<{
  baseline: EffectiveConfigItemValue;
  behaviorImpact: string;
  candidate: EffectiveConfigItemValue;
  category: EffectiveRuntimeConfigCategory;
  expected: boolean;
  key: string;
  reason: string;
  rollbackAction: string;
  rollbackValue: EffectiveConfigItemValue;
  stage: PromotionComparisonStage;
  status: EffectiveConfigItemStatus;
  verification: string;
}>;

export type PromotionBlocker = Readonly<{
  key: string;
  operation: string;
  reason: string;
  stage: PromotionComparisonStage;
  status: "incompatible" | "unknown";
}>;

export type PromotionRollbackStep = Readonly<{
  action: string;
  order: number;
}>;

export type PromotionRollbackPlan = Readonly<{
  authorization: Readonly<{
    contract: string;
    reauthorizedRoles: readonly string[];
    reusedRoles: readonly string[];
  }>;
  historicalEvidence: Readonly<{
    acceptanceCommit: string;
    acceptanceDeploymentId: string;
    contentIdentityPreserved: true;
    note: string;
  }>;
  steps: readonly PromotionRollbackStep[];
}>;

export type PromotionPlatformReadBlocker = Readonly<{
  reason: string;
  role: PromotionEnvironmentRole;
}>;

export type G1PromotionConfigReport = Readonly<{
  acceptanceComparison: EffectiveRuntimeConfigurationComparison;
  blockers: readonly PromotionBlocker[];
  collectedAt: string;
  commit: string;
  configDigest: string;
  deploymentId: string;
  differences: readonly PromotionDifference[];
  environments: readonly PromotionEnvironmentEvidence[];
  platformReadBlockers: readonly PromotionPlatformReadBlocker[];
  promotionAllowed: boolean;
  promotionComparison: EffectiveRuntimeConfigurationComparison;
  rollback: PromotionRollbackPlan;
  version: string;
}>;

export type PromotionConfigReportInput = Readonly<{
  authorization?: Readonly<{
    reauthorizedRoles?: readonly string[];
    reusedRoles?: readonly string[];
  }>;
  candidateDeployment: EffectiveConfigurationSnapshot;
  currentProduction: EffectiveConfigurationSnapshot;
  isolatedAcceptance: EffectiveConfigurationSnapshot;
  platformReadBlockers?: readonly PromotionPlatformReadBlocker[];
  /**
   * Repo-level schedule targets resolved at each compared ref (see
   * {@link resolveScheduleTargetItems}). They override the deployment's
   * `unverified` schedule items so a real lost trigger can be detected.
   */
  scheduleTargets?: Readonly<{
    candidateDeployment?: readonly EffectiveConfigurationItem[];
    currentProduction?: readonly EffectiveConfigurationItem[];
    isolatedAcceptance?: readonly EffectiveConfigurationItem[];
  }>;
}>;

function environmentEvidence(
  role: PromotionEnvironmentRole,
  snapshot: EffectiveConfigurationSnapshot,
): PromotionEnvironmentEvidence {
  return {
    collectedAt: snapshot.collectedAt,
    commit: snapshot.commit,
    configDigest: effectiveDigestOf(snapshot),
    deploymentId: snapshot.deploymentId,
    role,
    values: snapshot.items.map((entry) => ({
      category: entry.category,
      defaultValue: entry.defaultValue ?? null,
      inManifestFingerprint: entry.inManifestFingerprint,
      key: entry.key,
      platformLimit: entry.platformLimit ?? null,
      source: entry.source,
      value: entry.value,
    })),
  };
}

/** The gate owns the digest; reuse it rather than hashing here. */
function effectiveDigestOf(snapshot: EffectiveConfigurationSnapshot): string {
  return effectiveRuntimeConfigDigest(snapshot.items);
}

function differencesFor(
  stage: PromotionComparisonStage,
  comparison: EffectiveRuntimeConfigurationComparison,
): PromotionDifference[] {
  return comparison.changes.map((change) => ({
    baseline: change.baseline,
    behaviorImpact: change.impact,
    candidate: change.candidate,
    category: change.category,
    expected: change.status === "expected-isolated-difference",
    key: change.key,
    reason: change.reason,
    rollbackAction: change.rollback,
    rollbackValue: change.baseline,
    stage,
    status: change.status,
    verification: change.verification,
  }));
}

function blockersFor(
  stage: PromotionComparisonStage,
  comparison: EffectiveRuntimeConfigurationComparison,
): PromotionBlocker[] {
  return comparison.blocking.map((blocker) => ({
    key: blocker.key,
    operation: blocker.operation,
    reason: blocker.reason,
    stage,
    status: blocker.status,
  }));
}

/**
 * SPEC #275 decision 7 also separates a lost scheduled trigger from ordinary
 * non-critical inventory: a target that was readable and is now missing or
 * unreadable blocks the scheduled scan operation, even though schedule
 * inventory items are non-critical for the acceptance itself.
 */
function lostTriggerBlockers(
  comparison: EffectiveRuntimeConfigurationComparison,
): PromotionBlocker[] {
  return comparison.items
    .filter(
      (entry) =>
        entry.key.startsWith("schedule.") &&
        (entry.status === "unknown" || entry.status === "incompatible") &&
        entry.baseline !== null &&
        entry.candidate === null,
    )
    .map((entry) => ({
      key: entry.key,
      operation: "scheduled-scan",
      reason:
        "The scheduled trigger was readable in current production and is now missing or unreadable in the candidate deployment; the scheduled derivation would stop.",
      stage: "promotion" as const,
      status: entry.status as "incompatible" | "unknown",
    }));
}

const PARAMETER_ROLE_KEY = /^parameters\.([a-z.]+)\./;

function changedRoles(
  comparison: EffectiveRuntimeConfigurationComparison,
): string[] {
  const roles = new Set<string>();
  for (const entry of comparison.items) {
    if (entry.status === "match") continue;
    const match = PARAMETER_ROLE_KEY.exec(entry.key);
    if (match?.[1]) roles.add(match[1]);
  }
  return [...roles].sort();
}

function buildRollbackPlan(
  input: PromotionConfigReportInput,
  promotionComparison: EffectiveRuntimeConfigurationComparison,
): PromotionRollbackPlan {
  const g1Roles = [...ONE_A_3B_G1_ENABLED_ROLES];
  const derived = changedRoles(promotionComparison);
  const reauthorizedRoles = [
    ...(input.authorization?.reauthorizedRoles ?? derived),
  ].sort();
  const reusedRoles = [
    ...(input.authorization?.reusedRoles ??
      g1Roles.filter((role) => !reauthorizedRoles.includes(role))),
  ].sort();

  // Only a known incompatibility is a change to restore. An `unknown` key is
  // unreadable, not proven changed, so it is resolved by re-reading it from the
  // deployment rather than by writing a guessed value back.
  const restoreKeys = promotionComparison.changes
    .filter((change) => change.status === "incompatible")
    .map((change) => change.key);
  const restoreClause =
    restoreKeys.length > 0
      ? `Restore ${restoreKeys.join(", ")} in the affected environment's variables to the recorded rollback values.`
      : "Restore any candidate-only environment variable change to the recorded current-production values.";

  const steps: PromotionRollbackStep[] = [
    {
      order: 1,
      action: `${restoreClause} This restores the pre-promotion effective values rather than merely reverting a commit.`,
    },
    {
      order: 2,
      action:
        "Redeploy the candidate environment (or redeploy current production) so the restored variables are actually loaded; the blocked deployment is not reused.",
    },
    {
      order: 3,
      action:
        reauthorizedRoles.length > 0
          ? `Revoke the superseded active rollout pins for ${reauthorizedRoles.join(", ")} through the single-role transition/revoke contract (transitionActiveG1Configurations), then activate the prior immutable configuration; admission stops for those roles and any in-flight result frozen under the superseded pin is discarded by rollout_pin_changed, so it never becomes current.`
          : "No role configuration changed, so no pin needs re-pointing; verify the complete four-role active pin set is still present.",
    },
    {
      order: 4,
      action:
        "Re-read the effective configuration from the redeployed environment with the inspection endpoint and confirm the restored values, database target separation and four-role authorization match the recorded baseline.",
    },
    {
      order: 5,
      action: `Keep the acceptance manifest, evidence and pins at their original content identity (acceptance commit ${input.isolatedAcceptance.commit}, deployment ${input.isolatedAcceptance.deploymentId}); never relabel historical evidence as the new commit.`,
    },
  ];

  return {
    authorization: {
      contract:
        "Only roles whose (role, config_version, provider_policy_version, rollout_pin) identity changed receive a new immutable configuration and pin; unchanged roles keep their original pins, activation time and historical acceptance fingerprint (ADR-0148).",
      reauthorizedRoles,
      reusedRoles,
    },
    historicalEvidence: {
      acceptanceCommit: input.isolatedAcceptance.commit,
      acceptanceDeploymentId: input.isolatedAcceptance.deploymentId,
      contentIdentityPreserved: true,
      note: "Historical acceptance evidence keeps its original commit and content identity; promotion never rewrites it as the candidate commit.",
    },
    steps,
  };
}

/**
 * Build the promotion report from the three deployed snapshots. The candidate
 * SHA, deployment id, collection time and config digest are bound from the
 * candidate snapshot; current production is the reference for both the
 * acceptance alignment and the promotion comparison.
 */
export function buildG1PromotionConfigReport(
  input: PromotionConfigReportInput,
): G1PromotionConfigReport {
  const isolatedAcceptance = withScheduleTargets(
    input.isolatedAcceptance,
    input.scheduleTargets?.isolatedAcceptance,
  );
  const currentProduction = withScheduleTargets(
    input.currentProduction,
    input.scheduleTargets?.currentProduction,
  );
  const candidateDeployment = withScheduleTargets(
    input.candidateDeployment,
    input.scheduleTargets?.candidateDeployment,
  );

  const acceptanceComparison = compareEffectiveRuntimeConfiguration({
    baseline: isolatedAcceptance,
    candidate: currentProduction,
  });
  const promotionComparison = compareEffectiveRuntimeConfiguration({
    baseline: currentProduction,
    candidate: candidateDeployment,
    // Production and its candidate share the production identity; only the
    // isolated acceptance comparison enforces expected separation.
    isolation: "ignore",
  });

  const platformReadBlockers = [...(input.platformReadBlockers ?? [])];
  const blockers: PromotionBlocker[] = [
    ...blockersFor("acceptance", acceptanceComparison),
    ...blockersFor("promotion", promotionComparison),
    ...lostTriggerBlockers(promotionComparison),
  ];

  const differences: PromotionDifference[] = [
    ...differencesFor("acceptance", acceptanceComparison),
    ...differencesFor("promotion", promotionComparison),
  ];

  const promotionAllowed =
    blockers.length === 0 && platformReadBlockers.length === 0;

  return {
    acceptanceComparison,
    blockers,
    collectedAt: candidateDeployment.collectedAt,
    commit: candidateDeployment.commit,
    configDigest: promotionComparison.candidate.configDigest,
    deploymentId: candidateDeployment.deploymentId,
    differences,
    environments: [
      environmentEvidence("isolated-acceptance", isolatedAcceptance),
      environmentEvidence("current-production", currentProduction),
      environmentEvidence("candidate-deployment", candidateDeployment),
    ],
    platformReadBlockers,
    promotionAllowed,
    promotionComparison,
    rollback: buildRollbackPlan(input, promotionComparison),
    version: G1_PROMOTION_CONFIG_REPORT_VERSION,
  };
}

export type PromotionSnapshotTarget = Readonly<{
  deploymentId?: string;
  role: PromotionEnvironmentRole;
  token: string;
  url: string;
}>;

export type PromotionSnapshotCollection =
  | Readonly<{
      snapshots: Readonly<{
        candidateDeployment: EffectiveConfigurationSnapshot;
        currentProduction: EffectiveConfigurationSnapshot;
        isolatedAcceptance: EffectiveConfigurationSnapshot;
      }>;
      status: "collected";
    }>
  | Readonly<{
      blockers: readonly PromotionPlatformReadBlocker[];
      status: "blocked";
    }>;

/**
 * Collect the three deployed snapshots through the one #278 reader. A failed or
 * unauthorized read is recorded as a blocker; this never falls back to local
 * environment variables and never claims a comparison it could not perform.
 */
export async function collectG1PromotionSnapshots(input: {
  fetchImpl?: typeof fetch;
  targets: readonly PromotionSnapshotTarget[];
}): Promise<PromotionSnapshotCollection> {
  const collected = new Map<PromotionEnvironmentRole, EffectiveConfigurationSnapshot>();
  const blockers: PromotionPlatformReadBlocker[] = [];
  for (const target of input.targets) {
    try {
      const snapshot = await readEffectiveRuntimeConfiguration({
        url: target.url,
        token: target.token,
        ...(target.deploymentId ? { deploymentId: target.deploymentId } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      collected.set(target.role, snapshot);
    } catch (error) {
      blockers.push({
        reason: error instanceof Error ? error.message : "unreadable",
        role: target.role,
      });
    }
  }
  const attempted = new Set(input.targets.map((target) => target.role));
  for (const role of PROMOTION_ENVIRONMENT_ROLES) {
    if (!attempted.has(role)) {
      blockers.push({ role, reason: "No deployed snapshot target was provided." });
    }
  }
  if (blockers.length > 0) {
    return { blockers, status: "blocked" };
  }
  return {
    snapshots: {
      candidateDeployment: collected.get("candidate-deployment")!,
      currentProduction: collected.get("current-production")!,
      isolatedAcceptance: collected.get("isolated-acceptance")!,
    },
    status: "collected",
  };
}

/**
 * One compact summary. Detail stays in the written report so the agent does not
 * re-parse the same artifact.
 */
export function formatG1PromotionConfigReport(
  report: G1PromotionConfigReport,
): string {
  const lines = [
    `promotion config report ${report.version}`,
    `commit=${report.commit}`,
    `deployment=${report.deploymentId}`,
    `collected_at=${report.collectedAt}`,
    `config_digest=${report.configDigest}`,
    `promotion_allowed=${report.promotionAllowed}`,
    `differences=${report.differences.length}`,
    `blockers=${report.blockers.length}`,
    `reused_roles=${report.rollback.authorization.reusedRoles.join(",") || "none"}`,
    `reauthorized_roles=${
      report.rollback.authorization.reauthorizedRoles.join(",") || "none"
    }`,
  ];
  for (const difference of report.differences) {
    lines.push(
      `difference ${difference.stage} ${difference.key} status=${difference.status} expected=${difference.expected}`,
    );
  }
  for (const blocker of report.blockers) {
    lines.push(
      `blocker ${blocker.stage} ${blocker.operation} ${blocker.key} status=${blocker.status}`,
    );
  }
  for (const blocker of report.platformReadBlockers) {
    lines.push(`platform_read_blocker ${blocker.role}`);
  }
  return lines.join("\n");
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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

/**
 * Independent entry point. It compares three already-collected deployment
 * snapshots; it never contacts a deployment or a Provider itself, and a local
 * environment declaration can never masquerade as a deployment's value.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: {
    stdout: (line: string) => void;
    runner?: PromotionCommandRunner;
  } = {
    stdout: (line) => process.stdout.write(`${line}\n`),
  },
): Promise<number> {
  const args = parseArgs(argv);
  const isolatedPath = args.get("--isolated");
  const productionPath = args.get("--production");
  const candidatePath = args.get("--candidate");
  if (!isolatedPath || !productionPath || !candidatePath) {
    throw new Error(
      "Usage: g1-promotion-config-report.ts --isolated <acceptance.json> --production <current.json> --candidate <candidate.json> [--report <report.json>]",
    );
  }
  const isolatedAcceptance = parseEffectiveConfigurationSnapshot(
    await readJson(isolatedPath),
  );
  const currentProduction = parseEffectiveConfigurationSnapshot(
    await readJson(productionPath),
  );
  const candidateDeployment = parseEffectiveConfigurationSnapshot(
    await readJson(candidatePath),
  );

  // The deployment cannot read the repository's schedule, so fill the schedule
  // targets from the workflow at each compared ref via git. An unreadable ref
  // keeps the deployment's `unverified` item and is reported as a platform
  // read blocker; it is never assumed equal.
  const reader = gitScheduleTargetReader(io.runner);
  const platformReadBlockers: PromotionPlatformReadBlocker[] = [];
  async function resolveFor(
    role: PromotionEnvironmentRole,
    snapshot: EffectiveConfigurationSnapshot,
  ): Promise<readonly EffectiveConfigurationItem[]> {
    if (!scheduleItemsMissingOrUnverified(snapshot)) return [];
    const resolved = await resolveScheduleTargetItems(snapshot.commit, reader);
    for (const key of resolved.unreadable) {
      platformReadBlockers.push({
        role,
        reason: `The ${key} workflow could not be read at ${snapshot.commit}; the schedule item stays unverified and is never treated as equal.`,
      });
    }
    return resolved.items;
  }

  const report = buildG1PromotionConfigReport({
    isolatedAcceptance,
    currentProduction,
    candidateDeployment,
    scheduleTargets: {
      isolatedAcceptance: await resolveFor(
        "isolated-acceptance",
        isolatedAcceptance,
      ),
      currentProduction: await resolveFor(
        "current-production",
        currentProduction,
      ),
      candidateDeployment: await resolveFor(
        "candidate-deployment",
        candidateDeployment,
      ),
    },
    platformReadBlockers,
  });
  io.stdout(formatG1PromotionConfigReport(report));
  const reportPath = args.get("--report");
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    io.stdout(`report written to ${reportPath}`);
  }
  return report.promotionAllowed ? 0 : 1;
}

const entryPoint = process.argv[1]?.replace(/\\/g, "/");
const isDirectRun =
  entryPoint === "scripts/g1-promotion-config-report.ts" ||
  entryPoint?.endsWith("/scripts/g1-promotion-config-report.ts") === true;

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
