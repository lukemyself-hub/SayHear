/**
 * The small, dependency-free contract shared by Workflow functions.
 *
 * Workflow history may contain only content-free identifiers, versions,
 * statuses, counters, and other explicitly allowlisted metadata. Keeping this
 * guard in its own leaf prevents workflow bundles from importing the broader
 * application module graph merely to validate an envelope.
 */
const ALLOWLISTED_PAYLOAD_KEYS = new Set([
  "workflowCommandId",
  "subjectType",
  "subjectId",
  "ownerId",
  "sourceRevision",
  "policyVersion",
  "expectedDataEpoch",
  "scope",
  "claimBaselineDigest",
  "weekIdentifier",
  "windowStartDate",
  "windowEndDate",
  "sourceDigest",
  "rejectionCode",
  "statementCount",
  "candidateCount",
  "degradedEpisodeReason",
  "purgeSurfaceRegistryVersion",
  "externalIntegrationManifestVersion",
  "workflowSubjectManifestVersion",
  "eventType",
  "status",
  "errorCode",
  "workflowReceiptId",
  "dailySessionId",
  "actionExecutionId",
  "outcome",
  "counters",
  "diffCount",
  "promotedCount",
  "reinforcedCount",
  "contestedCount",
  "rejectedCount",
  "skippedCount",
  "dormantCount",
  "staledCount",
  "purgedCount",
  "modelRole",
  "generationCommandId",
  "modelRunAttemptId",
  "attemptNo",
  "attemptKind",
  "rolloutPin",
  "acceptedCount",
  "unresolvedCount",
]);

/**
 * Enforce that a value crossing into or out of Workflow history carries only
 * allowlisted fields. This guard is intentionally dependency-free so it can
 * run inside the deterministic Workflow sandbox.
 */
export function assertWorkflowSafe(value: unknown, path = "payload"): void {
  const pending: Array<{ value: unknown; path: string }> = [{ value, path }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.value === null || typeof current.value !== "object") {
      continue;
    }
    const record = current.value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!ALLOWLISTED_PAYLOAD_KEYS.has(key)) {
        throw new Error(
          `Workflow ${current.path} contains a non-allowlisted field: ${key}`,
        );
      }
      const child = record[key];
      if (child !== null && typeof child === "object") {
        pending.push({ value: child, path: `${current.path}.${key}` });
      }
    }
  }
}
