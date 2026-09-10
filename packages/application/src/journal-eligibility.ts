import {
  asConversationEventRevisionId,
  asDailySessionId,
  asEntityId,
  asMemoryClaimId,
  asUserId,
  asWorkflowCommandId,
  type ConversationEventRevisionId,
  type DailySessionId,
  type EntityId,
  type MemoryClaimId,
  type OutboxEventId,
  type UserId,
  type WorkflowCommandId,
} from "@sayhear/domain";
import type { EvidenceService } from "./evidence";
import type { RecoveryGate } from "./recovery-gate";
import { PURGE_WORKFLOW_SUBJECT_MANIFEST } from "./purge-surface-registry";

// ---- Date outcome -----------------------------------------------------------

export type JournalEligibilityDateOutcome =
  | "no_activity"
  | "insufficient_expression"
  | "eligible_queued"
  | "journal_available";

/**
 * The deterministic v1 expression gate. ADR-0011 forbids any importance or
 * emotional-depth judgement, so the only question is whether the Daily Session
 * carries at least one piece of substantive user expression. The threshold is a
 * versioned policy parameter (journal-eligibility:v1) and may be tightened in
 * later tickets without changing the command idempotency key.
 */
export function classifyExpressionPolicy(input: {
  policyVersion: string;
  minimumSubstantiveExpressionLength: number;
  longestUserExpressionLength: number;
}): Exclude<JournalEligibilityDateOutcome, "no_activity"> {
  if (input.policyVersion.length === 0) {
    throw new Error("policyVersion must be a non-empty version identifier.");
  }
  if (
    !Number.isInteger(input.minimumSubstantiveExpressionLength) ||
    input.minimumSubstantiveExpressionLength <= 0
  ) {
    throw new Error(
      "minimumSubstantiveExpressionLength must be a positive integer.",
    );
  }
  return input.longestUserExpressionLength >=
    input.minimumSubstantiveExpressionLength
    ? "eligible_queued"
    : "insufficient_expression";
}

// ---- Frozen session snapshot passed to the policy ---------------------------

export type JournalEligibilitySessionSnapshot = Readonly<{
  dailySessionId: DailySessionId;
  userId: UserId;
  logicalDate: string;
  sourceRevision: number;
  longestUserExpressionLength: number;
  userConversationEventCount: number;
}>;

// ---- Eligibility repository port (implemented by the data layer) ------------

export type JournalEligibilityEvaluationResult = Readonly<{
  commandCreated: boolean;
  workflowCommandId: WorkflowCommandId;
}>;

export type JournalEligibilityOutcomeRow = Readonly<{
  dailySessionId: DailySessionId;
  logicalDate: string;
  outcome: JournalEligibilityDateOutcome;
  eligibilityPolicyVersion: string;
  sourceRevision: number;
  workflowReceiptId: string | null;
}>;

export type JournalEligibilityRepository = Readonly<{
  /**
   * Atomically evaluate one Daily Session: lock it, gate on the presence of
   * substantive user expression, and create the WorkflowCommand + matching
   * outbox row in the same transaction. The stable idempotency key
   * (command_type, subject, source_revision, policy_version) absorbs duplicate
   * explicit-end and due-scan dispatch (AC #1, #5, #7).
   */
  evaluateEligibility(input: {
    dailySessionId: DailySessionId;
    evaluatedAt: Date;
    policyVersion: string;
  }): Promise<
    | Readonly<{ outcome: "evaluated"; result: JournalEligibilityEvaluationResult }>
    | Readonly<{ outcome: "not_found" }>
    | Readonly<{ outcome: "not_quiescent" }>
  >;
  /**
   * List Daily Sessions that are quiescent but do not yet have a date outcome,
   * for the cron sweep to create commands for.
   */
  listQuiescentSessionsNeedingEligibility(input: {
    limit: number;
  }): Promise<readonly DailySessionId[]>;
  /**
   * Read the frozen session snapshot for the Workflow entrypoint. The snapshot
   * carries only IDs/revision/length — never conversation text.
   */
  readEligibilitySnapshot(input: {
    dailySessionId: DailySessionId;
    policyVersion: string;
  }): Promise<JournalEligibilitySessionSnapshot | null>;
  /**
   * Compare-and-set the date outcome. The UNIQUE(daily_session_id) constraint
   * absorbs duplicate Workflow runs (AC #7).
   */
  recordDateOutcome(input: {
    dailySessionId: DailySessionId;
    userId: UserId;
    expectedDataEpoch: number;
    logicalDate: string;
    outcome: JournalEligibilityDateOutcome;
    eligibilityPolicyVersion: string;
    sourceRevision: number;
    workflowReceiptId: string;
    computedAt: Date;
  }): Promise<{ applied: boolean }>;
  findDateOutcome(input: {
    dailySessionId: DailySessionId;
  }): Promise<JournalEligibilityOutcomeRow | null>;
}>;

// ---- Outbox dispatcher repository port --------------------------------------

export type LeasedOutboxEvent = Readonly<{
  outboxEventId: OutboxEventId;
  workflowCommandId: WorkflowCommandId;
  aggregateId: DailySessionId | UserId | EntityId | MemoryClaimId | ConversationEventRevisionId;
  aggregateRevision: number;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type OutboxDispatcherRepository = Readonly<{
  leasePendingBatch(input: {
    now: Date;
    leaseDurationMs: number;
    leaseOwner: string;
    limit: number;
  }): Promise<readonly LeasedOutboxEvent[]>;
  /**
   * Re-lease rows whose lease has expired so a crash after lease (or after
   * Workflow start but before receipt) does not strand the event. Returns the
   * newly-leased events so the dispatcher can dispatch them in the same pass
   * (AC #6, #7).
   */
  reclaimExpiredLeases(input: {
    now: Date;
    leaseDurationMs: number;
    leaseOwner: string;
    limit: number;
  }): Promise<readonly LeasedOutboxEvent[]>;
  markDispatched(input: {
    outboxEventId: OutboxEventId;
    workflowReceiptId: string;
  }): Promise<void>;
  markFailed(input: {
    outboxEventId: OutboxEventId;
    errorCode: string;
    nextAttemptAt: Date;
  }): Promise<void>;
}>;

// ---- Services ---------------------------------------------------------------

export type JournalEligibilityService = Readonly<{
  /**
   * Used by both the explicit-end best-effort path and the cron sweep, so they
   * converge on the same idempotent command (AC #1).
   */
  evaluate(
    dailySessionId: string,
  ): Promise<
    | Readonly<{ outcome: "evaluated"; commandCreated: boolean }>
    | Readonly<{ outcome: "not_found" }>
    | Readonly<{ outcome: "not_quiescent" }>
  >;
  scanPendingEligibility(): Promise<
    Readonly<{ evaluated: number; commandsCreated: number }>
  >;
  /**
   * The versioned policy the Workflow step needs to run `classifyExpressionPolicy`.
   * Returns only the version + length threshold — no secrets, no conversation text.
   */
  resolvePolicyForStep(): Promise<{
    policyVersion: string;
    minimumSubstantiveExpressionLength: number;
  }>;
}>;

export function createJournalEligibilityService(dependencies: {
  clock: () => Date;
  policyVersion: string;
  minimumSubstantiveExpressionLength: number;
  repository: JournalEligibilityRepository;
  recoveryGate?: RecoveryGate;
  scanLimit?: number;
}): JournalEligibilityService {
  const scanLimit = dependencies.scanLimit ?? 100;
  if (!Number.isInteger(scanLimit) || scanLimit <= 0 || scanLimit > 1_000) {
    throw new Error("scanLimit must be an integer from 1 through 1000.");
  }
  if (
    !Number.isInteger(dependencies.minimumSubstantiveExpressionLength) ||
    dependencies.minimumSubstantiveExpressionLength <= 0
  ) {
    throw new Error(
      "minimumSubstantiveExpressionLength must be a positive integer.",
    );
  }

  async function evaluate(
    rawDailySessionId: string,
  ): ReturnType<JournalEligibilityService["evaluate"]> {
    let dailySessionId: DailySessionId;
    try {
      dailySessionId = asDailySessionId(rawDailySessionId);
    } catch {
      return { outcome: "not_found" };
    }
    const snapshot = await dependencies.repository.readEligibilitySnapshot({
      dailySessionId,
      policyVersion: dependencies.policyVersion,
    });
    if (snapshot !== null) {
      await dependencies.recoveryGate?.requireOpen(snapshot.userId);
    }
    const result = await dependencies.repository.evaluateEligibility({
      dailySessionId,
      evaluatedAt: dependencies.clock(),
      policyVersion: dependencies.policyVersion,
    });
    if (result.outcome !== "evaluated") {
      return result;
    }
    return {
      outcome: "evaluated",
      commandCreated: result.result.commandCreated,
    };
  }

  return {
    evaluate,
    async scanPendingEligibility() {
      const ids =
        await dependencies.repository.listQuiescentSessionsNeedingEligibility({
          limit: scanLimit,
        });
      let evaluated = 0;
      let commandsCreated = 0;
      for (const id of ids) {
        // Reuse the same evaluate() the explicit-end path uses, so both surfaces
        // converge on the same idempotent command (AC #1) with identical fencing.
        const result = await evaluate(id);
        if (result.outcome !== "evaluated") {
          continue;
        }
        evaluated += 1;
        if (result.commandCreated) {
          commandsCreated += 1;
        }
      }
      return { evaluated, commandsCreated };
    },
    async resolvePolicyForStep() {
      return {
        policyVersion: dependencies.policyVersion,
        minimumSubstantiveExpressionLength:
          dependencies.minimumSubstantiveExpressionLength,
      };
    },
  };
}

// ---- Dispatcher service -----------------------------------------------------

export type WorkflowStarter = (input: {
  eventType:
    | "dialogue_state_requested"
    | "journal_eligibility_requested"
    | "rolling_summary_requested"
    | typeof PURGE_WORKFLOW_SUBJECT_MANIFEST.eventType
    | "journal_regeneration_requested"
    | "fast_path_extraction_requested"
    | "daily_consolidation_requested"
    | "weekly_consolidation_requested"
    | "memory_sweeper_requested"
    | "memory_correction_followup_requested"
    | "entity_identity_revalidation_requested"
    | "model_role_requested"
    | "episode_build_requested"
    | "episode_maintenance_requested"
    | "reflection_daily_requested"
    | "reflection_weekly_requested"
    | "reflection_maintenance_requested";
  modelRole?: string;
  generationCommandId?: string;
  modelRunAttemptId?: string;
  attemptNo?: number;
  attemptKind?: string;
  rolloutPin?: string;
  actionExecutionId?: string;
  workflowCommandId: WorkflowCommandId;
  subjectId:
    | DailySessionId
    | UserId
    | EntityId
    | MemoryClaimId
    | ConversationEventRevisionId;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
  /** Reflection command identity fields (Q3). */
  claimBaselineDigest?: string;
  weekIdentifier?: string;
  windowStartDate?: string;
  windowEndDate?: string;
  sourceDigest?: string;
  purgeSurfaceRegistryVersion?: string;
  externalIntegrationManifestVersion?: string;
  workflowSubjectManifestVersion?: string;
}) => Promise<{ workflowReceiptId: string }>;

export type OutboxDispatcherService = Readonly<{
  dispatchPending(): Promise<
    Readonly<{
      dispatched: number;
      failed: number;
      reclaimed: number;
    }>
  >;
}>;

export function createOutboxDispatcherService(dependencies: {
  clock: () => Date;
  repository: OutboxDispatcherRepository;
  startWorkflow: WorkflowStarter;
  leaseDurationMs: number;
  leaseOwner: string;
  scanLimit?: number;
}): OutboxDispatcherService {
  const scanLimit = dependencies.scanLimit ?? 100;
  if (!Number.isInteger(scanLimit) || scanLimit <= 0 || scanLimit > 1_000) {
    throw new Error("scanLimit must be an integer from 1 through 1000.");
  }
  if (
    !Number.isInteger(dependencies.leaseDurationMs) ||
    dependencies.leaseDurationMs <= 0
  ) {
    throw new Error("leaseDurationMs must be a positive integer.");
  }

  return {
    async dispatchPending() {
      const now = dependencies.clock();
      // Expired leases are reclaimed (re-leased) before fresh leasing so a
      // crash after start but before receipt does not strand an event (AC #6).
      const reclaimedEvents = await dependencies.repository.reclaimExpiredLeases(
        {
          now,
          leaseDurationMs: dependencies.leaseDurationMs,
          leaseOwner: dependencies.leaseOwner,
          limit: scanLimit,
        },
      );
      const leasedEvents = await dependencies.repository.leasePendingBatch({
        now,
        leaseDurationMs: dependencies.leaseDurationMs,
        leaseOwner: dependencies.leaseOwner,
        limit: scanLimit,
      });
      const toDispatch = [...reclaimedEvents, ...leasedEvents];
      let dispatched = 0;
      let failed = 0;
      for (const event of toDispatch) {
        try {
          // The Workflow is started OUTSIDE the claiming transaction (AC #6).
          const receipt = await dependencies.startWorkflow({
            eventType: event.eventType as
              | "dialogue_state_requested"
              | "journal_eligibility_requested"
              | "rolling_summary_requested"
              | typeof PURGE_WORKFLOW_SUBJECT_MANIFEST.eventType
              | "journal_regeneration_requested"
              | "fast_path_extraction_requested"
              | "memory_correction_followup_requested"
              | "entity_identity_revalidation_requested"
              | "model_role_requested",
            ...(typeof event.payload.actionExecutionId === "string"
              ? { actionExecutionId: event.payload.actionExecutionId }
              : {}),
            ...(typeof event.payload.modelRole === "string"
              ? { modelRole: event.payload.modelRole }
              : {}),
            ...(typeof event.payload.generationCommandId === "string"
              ? { generationCommandId: event.payload.generationCommandId }
              : {}),
            ...(typeof event.payload.modelRunAttemptId === "string"
              ? { modelRunAttemptId: event.payload.modelRunAttemptId }
              : {}),
            ...(typeof event.payload.attemptNo === "number"
              ? { attemptNo: event.payload.attemptNo }
              : {}),
            ...(typeof event.payload.attemptKind === "string"
              ? { attemptKind: event.payload.attemptKind }
              : {}),
            ...(typeof event.payload.rolloutPin === "string"
              ? { rolloutPin: event.payload.rolloutPin }
              : {}),
            workflowCommandId: event.workflowCommandId,
            subjectId: event.aggregateId,
            sourceRevision: Number(event.aggregateRevision),
            policyVersion: String(event.payload.policyVersion ?? ""),
            expectedDataEpoch: Number(event.payload.expectedDataEpoch ?? 0),
            ...(typeof event.payload.claimBaselineDigest === "string"
              ? { claimBaselineDigest: event.payload.claimBaselineDigest }
              : {}),
            ...(typeof event.payload.weekIdentifier === "string"
              ? { weekIdentifier: event.payload.weekIdentifier }
              : {}),
            ...(typeof event.payload.windowStartDate === "string"
              ? { windowStartDate: event.payload.windowStartDate }
              : {}),
            ...(typeof event.payload.windowEndDate === "string"
              ? { windowEndDate: event.payload.windowEndDate }
              : {}),
            ...(typeof event.payload.sourceDigest === "string"
              ? { sourceDigest: event.payload.sourceDigest }
              : {}),
            ...(typeof event.payload.purgeSurfaceRegistryVersion === "string"
              ? {
                  purgeSurfaceRegistryVersion:
                    event.payload.purgeSurfaceRegistryVersion,
                }
              : {}),
            ...(typeof event.payload.externalIntegrationManifestVersion ===
            "string"
              ? {
                  externalIntegrationManifestVersion:
                    event.payload.externalIntegrationManifestVersion,
                }
              : {}),
            ...(typeof event.payload.workflowSubjectManifestVersion ===
            "string"
              ? {
                  workflowSubjectManifestVersion:
                    event.payload.workflowSubjectManifestVersion,
                }
              : {}),
          });
          await dependencies.repository.markDispatched({
            outboxEventId: event.outboxEventId,
            workflowReceiptId: receipt.workflowReceiptId,
          });
          dispatched += 1;
        } catch (error) {
          const errorCode = sanitizeErrorCode(error);
          const nextAttemptAt = new Date(
            now.getTime() + dependencies.leaseDurationMs,
          );
          await dependencies.repository.markFailed({
            outboxEventId: event.outboxEventId,
            errorCode,
            nextAttemptAt,
          });
          failed += 1;
        }
      }
      return {
        dispatched,
        failed,
        reclaimed: reclaimedEvents.length,
      };
    },
  };
}

/**
 * Reduce any thrown Provider or transport error to an allowlisted error code
 * before it can approach Workflow history (architecture 13.3, item 8). Private
 * conversation text or raw Provider payloads never survive this boundary.
 */
export function sanitizeErrorCode(error: unknown): string {
  if (error instanceof Error && error.message) {
    const message = error.message.toLowerCase();
    if (message.includes("timeout") || message.includes("timed out")) {
      return "provider_timeout";
    }
    if (message.includes("429") || message.includes("rate")) {
      return "provider_rate_limited";
    }
    if (/5\d{2}/.test(message)) {
      return "provider_server_error";
    }
    if (message.includes("network") || message.includes("econn")) {
      return "network_error";
    }
  }
  return "unknown_error";
}

// ---- safeWorkflowStep wrapper (architecture 13.3) ---------------------------

const ALLOWLISTED_PAYLOAD_KEYS = new Set([
  "workflowCommandId",
  "subjectType",
  "subjectId",
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
  "candidateCount",
  "degradedEpisodeReason",
  "acceptedCount",
  "unresolvedCount",
  "rejectedCount",
]);

/**
 * Enforce that a value crossing into or out of Workflow history carries only
 * allowlisted fields (IDs, revisions, policy, event kind, status, error code).
 * This guard is mandatory (architecture 13.3) — correctness cannot rely on code
 * review alone — and is exercised by the canary system test.
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

// ---- The Workflow application entrypoint (AC #10) ---------------------------

export type JournalEligibilityEntrypointInput = Readonly<{
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}>;

export type JournalEligibilityEntrypointResult = Readonly<{
  dailySessionId: string;
  outcome: JournalEligibilityDateOutcome | "stale_superseded";
  workflowReceiptId: string;
}>;

/**
 * The directly-callable application entrypoint. The system test invokes this
 * directly (the "Workflow application entrypoint" of AC #10); the deployed
 * `workflow` SDK directive step calls the same function. It is idempotent: a
 * replay reads the existing date outcome and returns it.
 */
export async function runJournalEligibility(input: {
  clock: () => Date;
  repository: JournalEligibilityRepository;
  eligibilityPolicyVersion: string;
  minimumSubstantiveExpressionLength: number;
  workflowReceiptId: string;
  command: JournalEligibilityEntrypointInput;
  evidenceService?: EvidenceService;
  recoveryGate?: RecoveryGate;
}): Promise<JournalEligibilityEntrypointResult> {
  // Validate the command's opaque IDs before trusting them.
  asWorkflowCommandId(input.command.workflowCommandId);
  const subjectId = asDailySessionId(input.command.subjectId);
  assertWorkflowSafe(
    {
      workflowCommandId: input.command.workflowCommandId,
      subjectType: "daily_session",
      subjectId: input.command.subjectId,
      sourceRevision: input.command.sourceRevision,
      policyVersion: input.command.policyVersion,
      expectedDataEpoch: input.command.expectedDataEpoch,
    },
    "command",
  );

  const snapshot = await input.repository.readEligibilitySnapshot({
    dailySessionId: subjectId,
    policyVersion: input.eligibilityPolicyVersion,
  });
  if (snapshot !== null && snapshot.sourceRevision !== input.command.sourceRevision) {
    // A writer advanced the source head after this command was admitted, so
    // the frozen command is superseded. This is deterministic — retrying the
    // step can never close the gap — and benign: no date outcome is recorded,
    // so the next Recovery Scan re-lists the session and admits a fresh
    // command at the current head (source_revision is part of the admission
    // conflict key). Production incident 2026-08-17: throwing here made the
    // durable workflow burn every retry on the mismatch and die, delaying the
    // Journal by a full scan cycle.
    const superseded: JournalEligibilityEntrypointResult = {
      dailySessionId: subjectId,
      outcome: "stale_superseded",
      workflowReceiptId: input.workflowReceiptId,
    };
    assertWorkflowSafe(superseded, "result");
    return superseded;
  }
  if (snapshot !== null) {
    await input.recoveryGate?.requireOpen(snapshot.userId);
  }
  // A Daily Session with zero user Conversation Events has no activity to
  // evaluate (AC #2). A snapshot that cannot be read is also treated as
  // no_activity rather than failing open.
  const outcome: JournalEligibilityDateOutcome =
    snapshot === null || snapshot.userConversationEventCount === 0
      ? "no_activity"
      : classifyExpressionPolicy({
          policyVersion: input.eligibilityPolicyVersion,
          minimumSubstantiveExpressionLength:
            input.minimumSubstantiveExpressionLength,
          longestUserExpressionLength: snapshot.longestUserExpressionLength,
        });

  if (snapshot !== null && outcome === "eligible_queued" && input.evidenceService) {
    const evidence = await input.evidenceService.freeze({
        dailySessionId: snapshot.dailySessionId,
        sourceRevision: snapshot.sourceRevision,
        expectedDataEpoch: input.command.expectedDataEpoch,
        commandId: input.command.workflowCommandId,
        attemptId: input.workflowReceiptId,
    });
    if (evidence.outcome !== "frozen") {
      throw new Error(`Evidence freeze failed closed with outcome: ${evidence.outcome}`);
    }
  }
  if (snapshot !== null) {
    const recorded = await input.repository.recordDateOutcome({
      dailySessionId: snapshot.dailySessionId,
      userId: snapshot.userId,
      expectedDataEpoch: input.command.expectedDataEpoch,
      logicalDate: snapshot.logicalDate,
      outcome,
      eligibilityPolicyVersion: input.eligibilityPolicyVersion,
      sourceRevision: snapshot.sourceRevision,
      workflowReceiptId: input.workflowReceiptId,
      computedAt: input.clock(),
    });
    if (!recorded.applied) {
      throw new Error("Journal eligibility command was fenced at date outcome commit.");
    }
  }

  const result = {
    dailySessionId: subjectId,
    outcome,
    workflowReceiptId: input.workflowReceiptId,
  };
  assertWorkflowSafe(result, "result");
  return result;
}

// Re-export the branded-id constructors consumers need alongside this module.
export {
  asDailySessionId,
  asOutboxEventId,
  asWorkflowCommandId,
  type DailySessionId,
  type OutboxEventId,
  type WorkflowCommandId,
} from "@sayhear/domain";
