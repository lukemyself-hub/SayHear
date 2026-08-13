import {
  asDailySessionId,
  asWorkflowCommandId,
  type DailySessionId,
  type OutboxEventId,
  type UserId,
  type WorkflowCommandId,
} from "@sayhear/domain";

// ---- Date outcome -----------------------------------------------------------

export type JournalEligibilityDateOutcome =
  | "no_activity"
  | "insufficient_expression"
  | "eligible_queued";

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
    expectedDataEpoch: number;
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

import type { EvidenceService } from "./evidence";

// ---- Outbox dispatcher repository port --------------------------------------

export type LeasedOutboxEvent = Readonly<{
  outboxEventId: OutboxEventId;
  workflowCommandId: WorkflowCommandId;
  aggregateId: DailySessionId;
  aggregateRevision: number;
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
  expectedDataEpoch: number;
  policyVersion: string;
  minimumSubstantiveExpressionLength: number;
  repository: JournalEligibilityRepository;
  scanLimit?: number;
}): JournalEligibilityService {
  const scanLimit = dependencies.scanLimit ?? 100;
  if (!Number.isInteger(scanLimit) || scanLimit <= 0 || scanLimit > 1_000) {
    throw new Error("scanLimit must be an integer from 1 through 1000.");
  }
  if (!Number.isInteger(dependencies.expectedDataEpoch) || dependencies.expectedDataEpoch <= 0) {
    throw new Error("expectedDataEpoch must be a positive integer.");
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
    const result = await dependencies.repository.evaluateEligibility({
      dailySessionId,
      evaluatedAt: dependencies.clock(),
      policyVersion: dependencies.policyVersion,
      expectedDataEpoch: dependencies.expectedDataEpoch,
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
  workflowCommandId: WorkflowCommandId;
  subjectId: DailySessionId;
  sourceRevision: number;
  policyVersion: string;
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
            workflowCommandId: event.workflowCommandId,
            subjectId: event.aggregateId,
            sourceRevision: event.aggregateRevision,
            policyVersion: String(event.payload.policyVersion ?? ""),
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
  "eventType",
  "status",
  "errorCode",
  "workflowReceiptId",
]);

/**
 * Enforce that a value crossing into or out of Workflow history carries only
 * allowlisted fields (IDs, revisions, policy, event kind, status, error code).
 * This guard is mandatory (architecture 13.3) — correctness cannot rely on code
 * review alone — and is exercised by the canary system test.
 */
export function assertWorkflowSafe(value: unknown, path = "payload"): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWLISTED_PAYLOAD_KEYS.has(key)) {
      throw new Error(
        `Workflow ${path} contains a non-allowlisted field: ${key}`,
      );
    }
    assertWorkflowSafe(record[key], `${path}.${key}`);
  }
}

// ---- The Workflow application entrypoint (AC #10) ---------------------------

export type JournalEligibilityEntrypointInput = Readonly<{
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
}>;

export type JournalEligibilityEntrypointResult = Readonly<{
  dailySessionId: string;
  outcome: JournalEligibilityDateOutcome;
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
    },
    "command",
  );

  const snapshot = await input.repository.readEligibilitySnapshot({
    dailySessionId: subjectId,
    policyVersion: input.eligibilityPolicyVersion,
  });
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
        commandId: input.command.workflowCommandId,
        attemptId: input.workflowReceiptId,
    });
    if (evidence.outcome !== "frozen") {
      throw new Error(`Evidence freeze failed closed with outcome: ${evidence.outcome}`);
    }
  }
  if (snapshot !== null) {
    await input.repository.recordDateOutcome({
      dailySessionId: snapshot.dailySessionId,
      userId: snapshot.userId,
      logicalDate: snapshot.logicalDate,
      outcome,
      eligibilityPolicyVersion: input.eligibilityPolicyVersion,
      sourceRevision: snapshot.sourceRevision,
      workflowReceiptId: input.workflowReceiptId,
      computedAt: input.clock(),
    });
  }

  return {
    dailySessionId: subjectId,
    outcome,
    workflowReceiptId: input.workflowReceiptId,
  };
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
