/**
 * The shared hosted acceptance gate for platform canary exports.
 *
 * ADR-0144 requires every consumer of a hosted export to fail closed on
 * unresolved encrypted/expired placeholder data, uncorrelated diagnostics, an
 * incomplete page set, and a deployment mismatch. The exporter, the
 * source-document generator, the standalone verifier and, through it, the
 * evidence producer all call {@link assertHostedWorkflowCanaryEvidence} so no
 * file-reading entry point can skip a check the exporter performs.
 *
 * It lives beside the G1 tooling rather than in `@sayhear/application` so the
 * frozen release scripts and their tests resolve one exact copy.
 */
import {
  assertWorkflowHistoryCanaryClean,
  type WorkflowCanaryArtifacts as BaseWorkflowCanaryArtifacts,
  type WorkflowCanaryValues,
} from "@sayhear/application";

export type WorkflowCanaryPageCompleteness = Readonly<{
  runs: Readonly<
    Record<
      string,
      Readonly<{ events: number; eventsComplete: true; steps: number; stepsComplete: true }>
    >
  >;
  version: "1a3b-hosted-canary-completeness:v1";
  workflowRuns: number;
}>;

export type WorkflowCanaryArtifacts = BaseWorkflowCanaryArtifacts &
  Readonly<{ completeness?: WorkflowCanaryPageCompleteness }>;

export type { WorkflowCanaryValues } from "@sayhear/application";

type RecordValue = Record<string, unknown>;

const artifactSources = [
  "workflowHistory",
  "outboxPayloads",
  "logs",
  "traces",
  "errors",
  "receipts",
] as const;

/**
 * Tokens the locked Workflow tooling writes when it cannot resolve data. The
 * CLI replaces undecryptable values with `"🔒 Encrypted"`, expired values with
 * `"<data expired>"`, and leaves stream references as tagged objects. A record
 * containing any of them proves a field was not fully resolved, which ADR-0144
 * says cannot count as evidence that no private data is present.
 */
const unresolvedDataTokens = [
  "🔒 Encrypted",
  "<data expired>",
  "__workflow_stream_ref__",
] as const;

const unresolvedDataKeys = ["__workflow_stream_ref__"] as const;

function collectUnresolvedDataFindings(
  value: unknown,
  path: string,
  findings: string[],
): void {
  if (typeof value === "string") {
    for (const token of unresolvedDataTokens) {
      if (value.includes(token)) findings.push(`${path}:${token}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectUnresolvedDataFindings(entry, `${path}[${index}]`, findings),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "expiredAt" && nested !== null && nested !== undefined) {
      // The SDK writes a retention deadline on the run envelope. Once that
      // deadline elapses the CLI can still return the fully hydrated record,
      // so wall-clock elapsed time alone does not prove the bytes were
      // dropped. What actually proves the export is complete is the
      // exporter's full resolved data plus the shared gate's page
      // completeness, correlation and probe scans. Accept any parseable root
      // retention timestamp; a malformed root date and every nested
      // expiredAt stub stay unresolved.
      const isRunMetadata = /^workflowHistory\[\d+\]$/.test(path) &&
        typeof (value as RecordValue).runId === "string";
      const expiry = typeof nested === "string" ? Date.parse(nested) : NaN;
      if (!isRunMetadata || !Number.isFinite(expiry)) {
        findings.push(`${path}.${key}`);
      }
    }
    if ((unresolvedDataKeys as readonly string[]).includes(key) && nested !== null && nested !== undefined) {
      findings.push(`${path}.${key}`);
    }
    collectUnresolvedDataFindings(nested, `${path}.${key}`, findings);
  }
}

/**
 * Reject an export that still contains encrypted, expired or otherwise
 * unresolved data references. A field that could not be resolved hides
 * whatever private body it held, so its absence from the probe scan is not
 * evidence of absence and per ADR-0144 must not pass.
 */
export function assertWorkflowHistoryCanaryResolved(
  artifacts: WorkflowCanaryArtifacts,
): void {
  const findings: string[] = [];
  for (const source of artifactSources) {
    // Locked CLI hydration returns placeholder classes whose toJSON() emits
    // the sentinel. Scan their actual exported representation as well.
    collectUnresolvedDataFindings(JSON.parse(JSON.stringify(artifacts[source])), source, findings);
  }
  if (findings.length > 0) {
    throw new Error(
      `Hosted Workflow canary found unresolved encrypted or expired data in ${findings.join(", ")}.`,
    );
  }
}

/**
 * Correlate the platform and database exports with a single execution. Owner
 * IDs cannot establish that an export belongs to this execution, so they are
 * removed from the identifier set. When `runIds` is supplied the exported run
 * set must match it exactly; otherwise the set is whatever the artifact
 * declares, and every declared run must still correlate with the database.
 */
export function assertCanaryExportCorrelation(
  artifacts: WorkflowCanaryArtifacts,
  runIds?: readonly string[],
): void {
  const databaseIds = new Set<string>();
  const collectIds = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectIds);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (/(?:Id|_id)$/.test(key) && typeof nested === "string" && /^[0-9a-f-]{36}$/i.test(nested)) databaseIds.add(nested);else collectIds(nested);
    }
  };
  [...artifacts.outboxPayloads, ...artifacts.receipts].forEach(collectIds);
  // Owner IDs cannot establish that an export belongs to this execution.
  for (const record of [...artifacts.outboxPayloads, ...artifacts.receipts]) {
    if (record && typeof record === "object") {
      for (const key of ["user_id", "userId", "owner_id", "ownerId"]) {
        const value = (record as RecordValue)[key];
        if (typeof value === "string") databaseIds.delete(value);
      }
    }
  }
  if (!databaseIds.size) throw new Error("Canary database exports have no execution identifiers.");
  const workflowIds = new Set<string>();
  for (const record of artifacts.workflowHistory) {
    const run = record as RecordValue;
    if (typeof run.runId !== "string" || workflowIds.has(run.runId) || (runIds !== undefined && !runIds.includes(run.runId)) || ![...databaseIds].some(id => JSON.stringify(run).includes(id))) {
      throw new Error("Canary Workflow cannot be correlated with its database execution.");
    }
    workflowIds.add(run.runId);
  }
  const expectedRunCount = runIds !== undefined ? runIds.length : artifacts.workflowHistory.length;
  if (workflowIds.size !== expectedRunCount) throw new Error("Canary Workflow export is incomplete.");
  const identifiers = [...databaseIds, ...workflowIds];
  for (const source of ["logs", "traces", "errors"] as const) {
    if (!artifacts[source].length || artifacts[source].some(record => !identifiers.some(id => JSON.stringify(record).includes(id)))) {
      throw new Error(`Canary ${source} contains an uncorrelated diagnostic export.`);
    }
  }
}

/**
 * Require the exporter's complete-page provenance. Draining every platform
 * page is what makes the export complete, so a consumer refuses an artifact
 * that does not carry the exporter's per-run page counts or whose declared
 * counts disagree with the records. This is the integrity half of the shared
 * gate: a non-empty array of records is not a complete paginated export.
 */
export function assertPreparedWorkflowPages(
  artifacts: WorkflowCanaryArtifacts,
): void {
  const completeness = artifacts.completeness;
  if (
    !completeness ||
    completeness.version !== "1a3b-hosted-canary-completeness:v1" ||
    !completeness.runs ||
    typeof completeness.runs !== "object"
  ) {
    throw new Error(
      "Hosted Workflow export lacks the locked exporter's complete-page provenance.",
    );
  }
  if (
    completeness.workflowRuns !== artifacts.workflowHistory.length ||
    Object.keys(completeness.runs).length !== artifacts.workflowHistory.length
  ) {
    throw new Error("Hosted Workflow export page provenance does not cover every exported run.");
  }
  for (const record of artifacts.workflowHistory) {
    const run = record as RecordValue;
    const runId = typeof run.runId === "string" ? run.runId : null;
    const declared = runId ? completeness.runs[runId] : undefined;
    if (
      !runId ||
      !declared ||
      declared.stepsComplete !== true ||
      declared.eventsComplete !== true
    ) {
      throw new Error("Hosted Workflow export has an incomplete or unattributed platform page set.");
    }
    const steps = Array.isArray(run.steps) ? run.steps : null;
    const events = Array.isArray(run.events) ? run.events : null;
    if (
      !steps ||
      !events ||
      steps.length === 0 ||
      events.length === 0 ||
      steps.length !== declared.steps ||
      events.length !== declared.events
    ) {
      throw new Error("Hosted Workflow export page counts do not match the exported records.");
    }
  }
}

/**
 * The shared hosted acceptance gate. Every consumer of a hosted export runs
 * this, so no file-reading entry point can bypass a check the exporter
 * performs. It fails closed on unresolved data, privacy probes, uncorrelated
 * diagnostics, a truncated page set, and a deployment mismatch.
 */
export function assertHostedWorkflowCanaryEvidence(
  artifacts: WorkflowCanaryArtifacts,
  values: WorkflowCanaryValues,
  options: Readonly<{ deploymentId?: string; runIds?: readonly string[] }> = {},
): void {
  assertWorkflowHistoryCanaryResolved(artifacts);
  assertWorkflowHistoryCanaryClean(artifacts, values);
  assertCanaryExportCorrelation(artifacts, options.runIds);
  assertPreparedWorkflowPages(artifacts);
  if (options.deploymentId !== undefined) {
    for (const record of artifacts.workflowHistory) {
      const run = record as RecordValue;
      if (run.deploymentId !== options.deploymentId) {
        throw new Error(
          "Hosted Workflow export does not belong to the expected acceptance deployment.",
        );
      }
    }
  }
}
