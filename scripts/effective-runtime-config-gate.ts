/**
 * The shared gate for effective runtime configuration comparison.
 *
 * SPEC #275 decision 5 makes this the one new release-tool seam: a
 * lightweight, independently runnable collector/comparison entry that reads
 * effective values from the deployed side or a trusted platform rather than
 * from local environment declarations. It lives beside the G1 tooling rather
 * than in `@sayhear/application` so the release scripts and their tests
 * resolve one exact copy, the same reason `hosted-workflow-canary-gate.ts`
 * sits here.
 *
 * Two concerns are deliberately separated:
 *
 * 1. {@link compareEffectiveRuntimeConfiguration} answers "do these two
 *    deployments run the same configuration, and which differences are
 *    expected isolation rather than a real incompatibility".
 * 2. {@link evaluateAcceptanceDeadlineBudget} answers "can this environment's
 *    layered deadlines actually hold the behavior under test", which is the
 *    #274 lesson: one ~120 s window cannot judge a ~204-226 s Weekly, and
 *    raising every timeout is not a fix.
 *
 * Repeatable commands (no real deployment or model call):
 *
 *   pnpm exec tsx scripts/effective-runtime-config-gate.ts \
 *     --baseline acceptance.json --candidate production.json --report report.json
 *   pnpm exec tsx scripts/effective-runtime-config-gate.ts --deadline budget.json
 *
 * The JSON files come from the deployed inspection endpoint
 * (`/api/internal/inspection/effective-runtime-config`) fetched with the Cron
 * bearer or an authenticated Owner. This process never reads local
 * environment declarations as the authority for a deployment.
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { sha256Hex } from "@sayhear/application";

import { containsForbiddenContent } from "./content-free";

export const EFFECTIVE_RUNTIME_CONFIG_VERSION =
  "1a3b-g1-effective-runtime-config:v1";
export const EFFECTIVE_RUNTIME_CONFIG_REPORT_VERSION =
  "1a3b-g1-effective-runtime-config-report:v1";

/**
 * The configuration surface SPEC #275 decision 6 requires the report to
 * cover. `deadline-budgets` and `credentials` sit outside the release manifest
 * fingerprint on purpose: they are the key items a manifest comparison would
 * otherwise miss.
 */
export const EFFECTIVE_RUNTIME_CONFIG_CATEGORIES = [
  "provider",
  "prompt-schema-policy",
  "parameters-budget",
  "roles-switches",
  "runtime",
  "migrations-registry",
  "schedule-targets",
  "owner-auth",
  "database-identity",
  "backup-retention",
  "credentials",
  "deadline-budgets",
] as const;

export type EffectiveRuntimeConfigCategory =
  (typeof EFFECTIVE_RUNTIME_CONFIG_CATEGORIES)[number];

export type EffectiveConfigItemValue = string | number | boolean | null;

/**
 * Where an effective value came from. `unverified` is not a default: it means
 * the value could not be read from the deployed side or the trusted platform,
 * and the comparison must never treat it as equal to anything.
 */
export type EffectiveConfigItemSource =
  | "default"
  | "override"
  | "platform"
  | "unverified";

export type EffectiveConfigurationItem = Readonly<{
  category: EffectiveRuntimeConfigCategory;
  /**
   * Whether a blocking difference in this key is allowed to block the
   * acceptance under way. SPEC #275 decision 7 blocks only key
   * incompatibilities and key unknowns; platform inventory keys that this
   * ticket cannot read yet are reported but stay non-blocking.
   */
  critical: boolean;
  /** A deployment-readable default, when the resolver documents one. */
  defaultValue?: EffectiveConfigItemValue;
  inManifestFingerprint: boolean;
  key: string;
  /** A known platform limit, when the platform documents one. */
  platformLimit?: EffectiveConfigItemValue;
  source: EffectiveConfigItemSource;
  value: EffectiveConfigItemValue;
}>;

export type EffectiveConfigurationSnapshot = Readonly<{
  collectedAt: string;
  commit: string;
  deploymentId: string;
  items: readonly EffectiveConfigurationItem[];
  version: string;
}>;

/**
 * An isolation difference ADR-0144 requires between the acceptance environment
 * and production. These are expected and must still be proven separated rather
 * than assumed safe.
 */
export type ExpectedIsolation =
  | "isolated-project"
  | "synthetic-owner"
  | "two-database-target"
  | "credentials";

/**
 * Which isolation a key belongs to. A key in this map is compared for
 * separation, not for equality; anything else is compared for equality.
 */
export const EXPECTED_ISOLATION_BY_KEY: Readonly<Record<string, ExpectedIsolation>> = {
  "credentials.cron_secret": "credentials",
  "credentials.github_client_secret": "credentials",
  "credentials.nextauth_secret": "credentials",
  "credentials.provider_key": "credentials",
  "database.business_target": "two-database-target",
  "database.purge_marker_target": "two-database-target",
  "hosted.project_id": "isolated-project",
  "hosted.team_id": "isolated-project",
  "owner.subject": "synthetic-owner",
  "owner.user_id": "synthetic-owner",
};

export type EffectiveConfigItemStatus =
  | "match"
  | "expected-isolated-difference"
  | "incompatible"
  | "unknown";

export type EffectiveConfigComparisonItem = Readonly<{
  baseline: EffectiveConfigItemValue;
  candidate: EffectiveConfigItemValue;
  category: EffectiveRuntimeConfigCategory;
  critical: boolean;
  inManifestFingerprint: boolean;
  isolation: ExpectedIsolation | null;
  key: string;
  status: EffectiveConfigItemStatus;
}>;

/**
 * Per-change reason, impact, verification and rollback values. SPEC #275
 * decision 7 requires each changed item to carry them, and also requires
 * rollback to name concrete recovery of environment variables and
 * redeployment rather than "revert commit".
 */
export type EffectiveConfigChange = Readonly<{
  baseline: EffectiveConfigItemValue;
  candidate: EffectiveConfigItemValue;
  category: EffectiveRuntimeConfigCategory;
  impact: string;
  key: string;
  reason: string;
  rollback: string;
  status: EffectiveConfigItemStatus;
  verification: string;
}>;

/**
 * A key incompatibility or key unknown, and the single operation it blocks.
 * SPEC #275 decision 7: only an incompatibility or unknown that actually
 * prevents the acceptance under way is allowed to block, and it blocks its own
 * operation rather than opening an unrelated full re-verification.
 */
export type EffectiveConfigBlocker = Readonly<{
  impact: string;
  key: string;
  operation: string;
  reason: string;
  status: "incompatible" | "unknown";
}>;

export type EffectiveRuntimeConfigurationComparison = Readonly<{
  baseline: Readonly<{
    collectedAt: string;
    configDigest: string;
    deploymentId: string;
  }>;
  blocking: readonly EffectiveConfigBlocker[];
  candidate: Readonly<{
    collectedAt: string;
    configDigest: string;
    deploymentId: string;
  }>;
  changes: readonly EffectiveConfigChange[];
  collectedAt: string;
  commit: string;
  compatible: boolean;
  isolations: readonly Readonly<{
    baseline: EffectiveConfigItemValue;
    candidate: EffectiveConfigItemValue;
    isolation: ExpectedIsolation;
    key: string;
  }>[];
  items: readonly EffectiveConfigComparisonItem[];
  version: string;
}>;

/** The acceptance operation a category governs when it is a critical blocker. */
const OPERATION_BY_CATEGORY: Readonly<
  Record<EffectiveRuntimeConfigCategory, string>
> = {
  "backup-retention": "backup-restore-drill",
  credentials: "provider-call",
  "database-identity": "purge-restore-drill",
  "deadline-budgets": "acceptance",
  "migrations-registry": "purge-restore-drill",
  "owner-auth": "owner-access",
  "parameters-budget": "acceptance",
  "prompt-schema-policy": "acceptance",
  provider: "acceptance",
  "roles-switches": "acceptance",
  runtime: "acceptance",
  "schedule-targets": "scheduled-scan",
};

function operationForCategory(
  category: EffectiveRuntimeConfigCategory,
): string {
  return OPERATION_BY_CATEGORY[category] ?? "acceptance";
}

/**
 * Compute the stable digest of one snapshot's items. The identity of a
 * snapshot has to be reproducible from its bytes so a report bound to a config
 * digest can be re-derived by whoever reads it later.
 */
export function effectiveRuntimeConfigDigest(
  items: readonly EffectiveConfigurationItem[],
): string {
  return sha256Hex(
    [...items]
      .map((item) => ({
        category: item.category,
        critical: item.critical,
        defaultValue: item.defaultValue ?? null,
        inManifestFingerprint: item.inManifestFingerprint,
        key: item.key,
        platformLimit: item.platformLimit ?? null,
        source: item.source,
        value: item.value,
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  );
}

function isUnverified(item: EffectiveConfigurationItem | undefined): boolean {
  return item === undefined || item.source === "unverified";
}

function valuesEqual(
  left: EffectiveConfigItemValue,
  right: EffectiveConfigItemValue,
): boolean {
  return left === right;
}

function isolationStatusFor(
  isolation: ExpectedIsolation,
  equal: boolean,
): EffectiveConfigItemStatus {
  if (isolation === "credentials") {
    // Only existence is reported for a credential, so equal existence is not a
    // proven separation — it is precisely the expected-isolated-difference
    // that still has to be verified. Missing in one environment is a real
    // difference, not isolation.
    return equal ? "expected-isolated-difference" : "incompatible";
  }
  // Project, owner and database targets MUST differ between the isolated
  // acceptance environment and production; equality means separation was not
  // proven.
  return equal ? "incompatible" : "expected-isolated-difference";
}

function rollbackActionFor(item: EffectiveConfigComparisonItem): string {
  if (item.isolation === "two-database-target") {
    return `Restore ${item.key} to the recorded acceptance target identity in that environment's own variables, redeploy, and re-read the effective configuration from the deployment; the business and purge-marker targets must still differ.`;
  }
  if (item.category === "credentials") {
    return `Rotate and restore ${item.key} in the affected environment's variables, redeploy, and confirm the deployment reports the credential as present without exposing it.`;
  }
  return `Restore ${item.key} to ${JSON.stringify(item.baseline)} in the affected environment's variables, redeploy that deployment, and re-read the effective configuration to confirm the restored value.`;
}

function changeFor(item: EffectiveConfigComparisonItem): EffectiveConfigChange {
  if (item.status === "expected-isolated-difference") {
    return {
      baseline: item.baseline,
      candidate: item.candidate,
      category: item.category,
      impact: `Does not block acceptance: ADR-0144 expects ${item.key} to differ between the isolated acceptance environment and production.`,
      key: item.key,
      reason: `${item.key} is an expected ${item.isolation} difference.`,
      rollback:
        item.isolation === "two-database-target"
          ? rollbackActionFor(item)
          : `No rollback required for an expected ${item.isolation} difference; verify only that the two targets remain separate.`,
      status: item.status,
      verification:
        item.isolation === "two-database-target"
          ? "Confirm both reported database target identities are present, differ from each other, and differ from the other environment's targets."
          : `Confirm the ${item.key} separation still holds in the trusted platform configuration.`,
    };
  }
  const blocking = item.status === "incompatible" || item.status === "unknown";
  return {
    baseline: item.baseline,
    candidate: item.candidate,
    category: item.category,
    impact: blocking && item.critical
      ? `Blocks the ${operationForCategory(item.category)} operation only; unrelated checks stay valid.`
      : `Recorded for the promotion report; does not block the current acceptance because ${item.key} is non-critical inventory.`,
    key: item.key,
    reason:
      item.status === "unknown"
        ? `${item.key} could not be read from the deployed side or trusted platform, so it cannot be reported as equal.`
        : `${item.key} differs from the baseline and is not an expected isolation difference.`,
    rollback: rollbackActionFor(item),
    status: item.status,
    verification:
      item.status === "unknown"
        ? "Read this key from the deployed inspection endpoint or the trusted platform configuration; an unreadable key stays unverified rather than assumed equal."
        : "Re-read this key from the deployed inspection endpoint after the change is applied.",
  };
}

/**
 * Compare an isolated acceptance snapshot with the current production snapshot.
 *
 * Expected isolation differences are reported with their separation rather than
 * as incompatibilities. An unreadable key item is `unknown`, never `match`.
 * Only a critical incompatible or critical unknown item becomes a blocker, and
 * it names the operation it blocks.
 */
export function compareEffectiveRuntimeConfiguration(input: Readonly<{
  baseline: EffectiveConfigurationSnapshot;
  candidate: EffectiveConfigurationSnapshot;
  /**
   * `enforce` (default) treats the isolated project, synthetic owner, two
   * database targets and credentials as expected separations, which is the
   * acceptance-environment contract. `ignore` compares every key for plain
   * equality, which is what a promotion comparison between current production
   * and a candidate production deployment needs: those two deployments share
   * the production identity, and equality there is correct rather than a
   * separation failure.
   */
  isolation?: "enforce" | "ignore";
}>): EffectiveRuntimeConfigurationComparison {
  const { baseline, candidate } = input;
  const enforceIsolation = input.isolation !== "ignore";
  const baselineByKey = new Map(baseline.items.map((item) => [item.key, item]));
  const candidateByKey = new Map(candidate.items.map((item) => [item.key, item]));
  const keys = [
    ...new Set([...baselineByKey.keys(), ...candidateByKey.keys()]),
  ].sort((left, right) => left.localeCompare(right));

  const items: EffectiveConfigComparisonItem[] = keys.map((key) => {
    const fromBaseline = baselineByKey.get(key);
    const fromCandidate = candidateByKey.get(key);
    const reference = fromBaseline ?? fromCandidate;
    if (!reference) throw new Error(`Unknown key ${key}`);
    const baselineValue = fromBaseline?.value ?? null;
    const candidateValue = fromCandidate?.value ?? null;
    const isolation = enforceIsolation
      ? EXPECTED_ISOLATION_BY_KEY[key] ?? null
      : null;
    const unverified = isUnverified(fromBaseline) || isUnverified(fromCandidate);

    const status: EffectiveConfigItemStatus = unverified
      ? "unknown"
      : isolation !== null
        ? isolationStatusFor(isolation, valuesEqual(baselineValue, candidateValue))
        : valuesEqual(baselineValue, candidateValue)
          ? "match"
          : "incompatible";

    return {
      baseline: baselineValue,
      candidate: candidateValue,
      category: reference.category,
      critical: reference.critical,
      inManifestFingerprint: reference.inManifestFingerprint,
      isolation,
      key,
      status,
    };
  });

  const isolations = items
    .filter((item) => item.status === "expected-isolated-difference")
    .map((item) => ({
      baseline: item.baseline,
      candidate: item.candidate,
      isolation: item.isolation as ExpectedIsolation,
      key: item.key,
    }));

  const changes = items
    .filter((item) => item.status !== "match")
    .map((item) => changeFor(item));

  const blocking = items
    .filter(
      (item) =>
        item.critical &&
        (item.status === "incompatible" || item.status === "unknown"),
    )
    .map((item) => ({
      impact: `Blocks the ${operationForCategory(item.category)} operation only.`,
      key: item.key,
      operation: operationForCategory(item.category),
      reason:
        item.status === "unknown"
          ? `${item.key} is unreadable and must not be treated as equal.`
          : `${item.key} is incompatible with the baseline.`,
      status: item.status as "incompatible" | "unknown",
    }));

  return {
    baseline: {
      collectedAt: baseline.collectedAt,
      configDigest: effectiveRuntimeConfigDigest(baseline.items),
      deploymentId: baseline.deploymentId,
    },
    blocking,
    candidate: {
      collectedAt: candidate.collectedAt,
      configDigest: effectiveRuntimeConfigDigest(candidate.items),
      deploymentId: candidate.deploymentId,
    },
    changes,
    collectedAt: candidate.collectedAt,
    commit: candidate.commit,
    compatible: blocking.length === 0,
    isolations,
    items,
    version: EFFECTIVE_RUNTIME_CONFIG_REPORT_VERSION,
  };
}

/**
 * One compact success summary. Detail lives in the written report for whoever
 * needs it, which keeps the agent from re-parsing the same artifact.
 */
export function formatEffectiveRuntimeConfigurationComparison(
  comparison: EffectiveRuntimeConfigurationComparison,
): string {
  const summary = [
    `Effective configuration report ${comparison.version}`,
    `commit=${comparison.commit}`,
    `acceptance_deployment=${comparison.baseline.deploymentId}`,
    `production_deployment=${comparison.candidate.deploymentId}`,
    `config_digest=${comparison.candidate.configDigest}`,
    `categories_covered=${
      new Set(comparison.items.map((item) => item.category)).size
    }`,
    `expected_isolations=${comparison.isolations.length}`,
    `changed_items=${comparison.changes.length}`,
    `blocking_items=${comparison.blocking.length}`,
    `compatible=${comparison.compatible}`,
  ];
  for (const change of comparison.changes) {
    summary.push(`change ${change.key} (${change.status})`);
  }
  for (const blocker of comparison.blocking) {
    summary.push(`block ${blocker.operation} ${blocker.key} (${blocker.status})`);
  }
  return summary.join("\n");
}

function isScalar(value: unknown): value is EffectiveConfigItemValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function assertContentFree(label: string, value: unknown): void {
  if (typeof value !== "string") return;
  if (value.length > 4096) {
    throw new Error(`${label} is too long to be a content-free configuration value.`);
  }
  if (containsForbiddenContent(value)) {
    throw new Error(
      `${label} is not content-free; secret values and connection strings are never recorded.`,
    );
  }
}

function categoryOf(value: unknown, label: string): EffectiveRuntimeConfigCategory {
  if (
    typeof value === "string" &&
    (EFFECTIVE_RUNTIME_CONFIG_CATEGORIES as readonly string[]).includes(value)
  ) {
    return value as EffectiveRuntimeConfigCategory;
  }
  throw new Error(`${label} is not a known effective configuration category.`);
}

function sourceOf(value: unknown, label: string): EffectiveConfigItemSource {
  if (
    value === "default" ||
    value === "override" ||
    value === "platform" ||
    value === "unverified"
  ) {
    return value;
  }
  throw new Error(`${label} is not a known effective configuration source.`);
}

/**
 * Parse and validate the JSON the deployed inspection endpoint returns. This is
 * the trust boundary: the consumer never assumes a remote payload is
 * well-formed, content-free or actually about a deployment.
 */
export function parseEffectiveConfigurationSnapshot(
  value: unknown,
): EffectiveConfigurationSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Effective configuration snapshot must be a JSON object.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== EFFECTIVE_RUNTIME_CONFIG_VERSION) {
    throw new Error(
      `Effective configuration snapshot version must be ${EFFECTIVE_RUNTIME_CONFIG_VERSION}.`,
    );
  }
  if (typeof raw.commit !== "string" || !/^[0-9a-f]{40}$/.test(raw.commit)) {
    throw new Error("Effective configuration snapshot requires a 40-character commit.");
  }
  if (typeof raw.deploymentId !== "string" || raw.deploymentId.length === 0) {
    throw new Error("Effective configuration snapshot requires a deployment id.");
  }
  if (
    typeof raw.collectedAt !== "string" ||
    Number.isNaN(Date.parse(raw.collectedAt))
  ) {
    throw new Error("Effective configuration snapshot requires an ISO collection time.");
  }
  if (!Array.isArray(raw.items)) {
    throw new Error("Effective configuration snapshot requires an item array.");
  }
  const seen = new Set<string>();
  const items = raw.items.map((entry, index) => {
    const label = `Effective configuration item ${index}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} must be a JSON object.`);
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.key !== "string" || item.key.length === 0) {
      throw new Error(`${label} requires a non-empty key.`);
    }
    if (seen.has(item.key)) {
      throw new Error(`Effective configuration item ${item.key} is a duplicate key.`);
    }
    seen.add(item.key);
    if (typeof item.inManifestFingerprint !== "boolean") {
      throw new Error(`${label} requires inManifestFingerprint.`);
    }
    if (typeof item.critical !== "boolean") {
      throw new Error(`${label} requires critical.`);
    }
    if (!isScalar(item.value)) {
      throw new Error(`${label} value must be a scalar or null.`);
    }
    assertContentFree(`${item.key} value`, item.value);
    if (item.defaultValue !== undefined) {
      if (!isScalar(item.defaultValue)) {
        throw new Error(`${label} defaultValue must be a scalar or null.`);
      }
      assertContentFree(`${item.key} defaultValue`, item.defaultValue);
    }
    if (item.platformLimit !== undefined) {
      if (!isScalar(item.platformLimit)) {
        throw new Error(`${label} platformLimit must be a scalar or null.`);
      }
      assertContentFree(`${item.key} platformLimit`, item.platformLimit);
    }
    return {
      category: categoryOf(item.category, `${label} category`),
      critical: item.critical,
      ...(item.defaultValue === undefined ? {} : { defaultValue: item.defaultValue }),
      inManifestFingerprint: item.inManifestFingerprint,
      key: item.key,
      ...(item.platformLimit === undefined ? {} : { platformLimit: item.platformLimit }),
      source: sourceOf(item.source, `${label} source`),
      value: item.value,
    } satisfies EffectiveConfigurationItem;
  });

  return {
    collectedAt: raw.collectedAt,
    commit: raw.commit,
    deploymentId: raw.deploymentId,
    items,
    version: EFFECTIVE_RUNTIME_CONFIG_VERSION,
  };
}

/**
 * Read the effective configuration from the deployed inspection endpoint. The
 * authority is the deployment's own process environment as it is actually
 * running, reached with the Cron operator bearer; local environment variables
 * of this process are never a fallback.
 */
export async function readEffectiveRuntimeConfiguration(input: {
  url: string;
  token: string;
  deploymentId?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<EffectiveConfigurationSnapshot> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.url, {
    headers: {
      authorization: `Bearer ${input.token}`,
      "cache-control": "no-store",
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `Effective runtime configuration is unavailable from the deployment (status ${response.status}).`,
    );
  }
  const parsed = parseEffectiveConfigurationSnapshot(await response.json());
  return input.deploymentId
    ? { ...parsed, deploymentId: input.deploymentId }
    : parsed;
}

export type AcceptanceDeadlineBudgetFindingCode =
  | "unbounded_or_invalid_budget"
  | "workflow_step_budget_below_provider_deadline"
  | "layers_cannot_cover_observed_behavior"
  | "acceptance_wait_window_below_required_budget"
  | "acceptance_wait_window_below_observed_behavior"
  | "scan_dispatch_coupled_to_terminal_wait";

export type AcceptanceDeadlineBudgetFinding = Readonly<{
  code: AcceptanceDeadlineBudgetFindingCode;
  detail: string;
  layer: string;
  operation: string;
  rollback: string;
}>;

export type AcceptanceDeadlineBudgetResult = Readonly<{
  compatible: boolean;
  findings: readonly AcceptanceDeadlineBudgetFinding[];
  requiredWaitWindowMs: number;
}>;

/**
 * The layered deadline budget of one acceptance environment.
 *
 * These are separate layers on purpose (SPEC #275 decision 8). The Provider
 * deadline bounds one model call. The Workflow step budget bounds the step that
 * hosts it. The scan HTTP dispatch bound applies to the async dispatch only and
 * never to the model's terminal state. The acceptance wait window is the outer
 * bound covering the allowed attempts, their intervals, persistence and
 * scheduling. A ~120 s environment cannot judge ~204-226 s Weekly behavior, and
 * raising every timeout would only hide that.
 */
export type AcceptanceDeadlineBudget = Readonly<{
  acceptanceWaitWindowMs: number;
  interAttemptIntervalMs: number;
  persistenceAllowanceMs: number;
  providerDeadlineMs: number;
  /** The behavior the acceptance must be able to hold, from observation. */
  requiredBehaviorMs: number;
  scanDispatchAsyncOnly: boolean;
  scanHttpDispatchBudgetMs: number;
  schedulingAllowanceMs: number;
  /** Allowed attempts, i.e. one initial call plus its technical retries. */
  technicalRetryBudget: number;
  workflowStepBudgetMs: number;
}>;

function isPositiveFiniteInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Validate one environment's layered deadline budget against the behavior the
 * acceptance has to hold.
 *
 * The required wait window is derived rather than assumed: every allowed
 * attempt's step budget plus its persistence allowance, plus the intervals
 * between attempts, plus scheduling. A budget that cannot cover the observed
 * behavior or the derived window is reported as incompatible at the specific
 * layer that is short, so the fix is a real budget decision rather than a
 * blanket timeout increase.
 */
export function evaluateAcceptanceDeadlineBudget(
  budget: AcceptanceDeadlineBudget,
): AcceptanceDeadlineBudgetResult {
  const findings: AcceptanceDeadlineBudgetFinding[] = [];
  const numericLayers: readonly (readonly [string, number])[] = [
    ["provider_deadline", budget.providerDeadlineMs],
    ["workflow_step_budget", budget.workflowStepBudgetMs],
    ["scan_http_dispatch", budget.scanHttpDispatchBudgetMs],
    ["acceptance_wait_window", budget.acceptanceWaitWindowMs],
    ["technical_retry_budget", budget.technicalRetryBudget],
    ["inter_attempt_interval", budget.interAttemptIntervalMs],
    ["persistence_allowance", budget.persistenceAllowanceMs],
    ["scheduling_allowance", budget.schedulingAllowanceMs],
    ["required_behavior", budget.requiredBehaviorMs],
  ];

  for (const [layer, value] of numericLayers) {
    if (!isPositiveFiniteInteger(value)) {
      findings.push({
        code: "unbounded_or_invalid_budget",
        detail: `${layer} is ${String(value)}; every deadline layer must be a positive finite integer, and no wait may be unbounded.`,
        layer,
        operation: "acceptance",
        rollback:
          "Restore the previous finite value for this layer in that environment's variables; an unbounded or non-positive deadline is never an acceptable fallback.",
      });
    }
  }

  if (findings.length > 0) {
    return {
      compatible: false,
      findings,
      requiredWaitWindowMs: Number.NaN,
    };
  }

  if (!budget.scanDispatchAsyncOnly) {
    findings.push({
      code: "scan_dispatch_coupled_to_terminal_wait",
      detail:
        "The scan HTTP dispatch is treated as the terminal wait. When the dispatch only hands work to the workflow, HTTP 200 proves a dispatch, not a terminal Weekly state; verify the terminal state separately.",
      layer: "scan_http_dispatch",
      operation: "acceptance",
      rollback:
        "Restore the asynchronous dispatch contract and verify the terminal state through its own terminal-state check instead of the dispatch response.",
    });
  }

  // Equality leaves no room for the step's own overhead, so the step budget
  // has to exceed the Provider deadline it hosts rather than merely match it.
  if (budget.workflowStepBudgetMs <= budget.providerDeadlineMs) {
    findings.push({
      code: "workflow_step_budget_below_provider_deadline",
      detail: `The Workflow step budget ${budget.workflowStepBudgetMs} ms does not exceed the Provider deadline ${budget.providerDeadlineMs} ms, so the step has no room beyond the call it hosts.`,
      layer: "workflow_step_budget",
      operation: "acceptance",
      rollback:
        "Restore the previous Workflow step budget for this deployment; the step budget must exceed the Provider deadline rather than being widened without reason.",
    });
  }

  const requiredWaitWindowMs =
    budget.technicalRetryBudget *
      (budget.workflowStepBudgetMs + budget.persistenceAllowanceMs) +
    (budget.technicalRetryBudget - 1) * budget.interAttemptIntervalMs +
    budget.schedulingAllowanceMs;

  if (requiredWaitWindowMs < budget.requiredBehaviorMs) {
    findings.push({
      code: "layers_cannot_cover_observed_behavior",
      detail: `The allowed attempts and step budgets can cover only ${requiredWaitWindowMs} ms, below the ${budget.requiredBehaviorMs} ms observed behavior, so the acceptance cannot reach the Weekly terminal state at any wait window.`,
      layer: "acceptance_wait_window",
      operation: "acceptance",
      rollback:
        "Restore the previous per-attempt budget or allowed attempts; the observed duration is an observation, not a performance SLA, and the layer that is short must be measured before it changes.",
    });
  }

  if (budget.acceptanceWaitWindowMs < requiredWaitWindowMs) {
    findings.push({
      code: "acceptance_wait_window_below_required_budget",
      detail: `The acceptance wait window ${budget.acceptanceWaitWindowMs} ms cannot cover ${budget.technicalRetryBudget} attempts of ${budget.workflowStepBudgetMs} ms plus intervals, persistence and scheduling (${requiredWaitWindowMs} ms).`,
      layer: "acceptance_wait_window",
      operation: "acceptance",
      rollback:
        "Restore the previous wait window, or raise only the layer the measurement shows is short; do not raise every timeout to mask the fault.",
    });
  }

  if (budget.acceptanceWaitWindowMs < budget.requiredBehaviorMs) {
    findings.push({
      code: "acceptance_wait_window_below_observed_behavior",
      detail: `The acceptance wait window ${budget.acceptanceWaitWindowMs} ms is below the ${budget.requiredBehaviorMs} ms observed behavior; a window shorter than the observed duration cannot judge the Weekly terminal state.`,
      layer: "acceptance_wait_window",
      operation: "acceptance",
      rollback:
        "Restore the previous wait window or raise only the layer the measurement shows is short; never widen the Provider deadline merely because the outer window is short.",
    });
  }

  return {
    compatible: findings.length === 0,
    findings,
    requiredWaitWindowMs,
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

function readJson(path: string): Promise<unknown> {
  return readFile(path, "utf8").then((text) => JSON.parse(text) as unknown);
}

/**
 * Independent entry point. It never contacts a deployment itself: the two
 * snapshots and the deadline budget are files produced by the authenticated
 * deployed inspection endpoint or the trusted platform, so a local
 * environment declaration can never masquerade as a deployment's effective
 * value.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  io: { stdout: (line: string) => void } = {
    stdout: (line) => process.stdout.write(`${line}\n`),
  },
): Promise<number> {
  const args = parseArgs(argv);
  let failed = false;

  const deadlinePath = args.get("--deadline");
  if (deadlinePath) {
    const budget = (await readJson(deadlinePath)) as AcceptanceDeadlineBudget;
    const result = evaluateAcceptanceDeadlineBudget(budget);
    io.stdout(
      `acceptance deadline budget compatible=${result.compatible} required_wait_window_ms=${result.requiredWaitWindowMs}`,
    );
    for (const finding of result.findings) {
      io.stdout(`finding ${finding.code} layer=${finding.layer} (${finding.detail})`);
    }
    failed = failed || !result.compatible;
  }

  const baselinePath = args.get("--baseline");
  const candidatePath = args.get("--candidate");
  if (baselinePath && candidatePath) {
    const baseline = parseEffectiveConfigurationSnapshot(await readJson(baselinePath));
    const candidate = parseEffectiveConfigurationSnapshot(await readJson(candidatePath));
    const comparison = compareEffectiveRuntimeConfiguration({ baseline, candidate });
    io.stdout(formatEffectiveRuntimeConfigurationComparison(comparison));
    const reportPath = args.get("--report");
    if (reportPath) {
      await writeFile(reportPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
      io.stdout(`report written to ${reportPath}`);
    }
    failed = failed || !comparison.compatible;
  }

  if (!deadlinePath && !(baselinePath && candidatePath)) {
    throw new Error(
      "Usage: effective-runtime-config-gate.ts --baseline <file> --candidate <file> [--report <file>] | --deadline <file>",
    );
  }
  return failed ? 1 : 0;
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
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
