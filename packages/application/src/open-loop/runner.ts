import {
  asGenerationCommandId,
  asModelRunAttemptId,
  asWorkflowCommandId,
  type UserId,
} from "@sayhear/domain";

import { assertWorkflowSafe } from "../journal-eligibility";
import { ProviderDispatchError } from "../conversation-model";
import {
  RecoveryGateClosedError,
  type RecoveryGate,
} from "../recovery-gate";
import {
  isModelRoleAttemptKind,
  type ModelRoleAttemptKind,
  type ModelRoleCommandService,
  type ModelRoleFailureCode,
  type ModelRoleProviderEgress,
} from "../model-role-runtime";
import {
  planOpenLoopClosure,
  planOpenLoopFormation,
  selectFormationCandidates,
  type OpenLoopIdentityCandidate,
} from "./admission";
import {
  MAX_NEW_LOOPS_PER_EVENT,
  type OpenLoopClosureProposal,
  type OpenLoopExtractEvidenceInput,
  type OpenLoopExtractModelProvider,
  type OpenLoopFormationPlan,
  type OpenLoopProposal,
} from "./types";

/**
 * Per-Event Open Loop extraction runner (issue #207 layer 2b, SPEC ch.6).
 * One admitted `open_loop.extract` attempt reads the frozen Event snapshot,
 * asks the model for transient proposals plus closure assertions, and
 * commits the deterministic formation/closure effects atomically. The model
 * output is never persisted; invalid proposals fail closed per proposal.
 */

// ---- Repository port (implemented by PostgresOpenLoopRepository) -----------

export type OpenLoopExtractionCandidate = Readonly<{
  eventRevisionId: string;
  userId: UserId;
  sourceRevision: number;
  expectedDataEpoch: number;
}>;

export type OpenLoopExtractionSnapshot = Readonly<{
  userId: UserId;
  eventRevisionId: string;
  sourceRevision: number;
  expectedDataEpoch: number;
  locale: string;
  timeZone: string;
  userText: string;
  evidenceCommittedAt: string;
  evidence: readonly OpenLoopExtractEvidenceInput[];
  identityCandidates: readonly OpenLoopIdentityCandidate[];
  currentOpenCount: number;
}>;

export type OpenLoopExtractionEffects = Readonly<{
  formations: readonly Readonly<{
    kind: "upcoming_event" | "awaited_outcome";
    sourceEvidenceItemId: string;
    sourceEventRevisionId: string;
    sourceClaimVersionId: string | null;
    sourceEpisodeVersionId: string | null;
    canonicalClaimKey: string | null;
    localizedSummary: string | null;
    expectedStartAt: string | null;
    expectedEndAt: string | null;
    timePrecision: string;
    timezone: string | null;
    followupEligibleFromAt: string;
    expiresAt: string;
    expirySource: string;
    reuseOpenLoopId: string | null;
  }>[];
  closures: readonly Readonly<{
    targetOpenLoopId: string;
    terminalStatus:
      | "occurred"
      | "resolved"
      | "canceled"
      | "expired"
      | "retracted";
    closureEventRevisionId: string;
    closureCommittedAt: string;
  }>[];
  ambiguousSuppressedTargetIds: readonly string[];
}>;

export type OpenLoopExtractionRepository = Readonly<{
  listEventsNeedingExtraction(input: Readonly<{
    policyVersion: string;
    limit: number;
  }>): Promise<readonly OpenLoopExtractionCandidate[]>;
  readExtractionSnapshot(input: Readonly<{
    eventRevisionId: string;
  }>): Promise<
    | Readonly<{ outcome: "ready"; snapshot: OpenLoopExtractionSnapshot }>
    | Readonly<{ outcome: "stale" }>
  >;
  /**
   * Resolve the per-Event subject of an admitted extract attempt. The
   * model-role outbox carries the owner as its subject, so the durable
   * Workflow resolves the Event revision from the generation command row
   * (mirroring the narrative-validation attempt context read).
   */
  readAttemptEventRevision(input: Readonly<{
    userId: UserId;
    generationCommandId: string;
  }>): Promise<
    | Readonly<{ outcome: "ready"; eventRevisionId: string }>
    | Readonly<{ outcome: "not_found" }>
  >;
  commitEventEffects(input: Readonly<{
    userId: UserId;
    sourceEventRevisionId: string;
    expectedDataEpoch: number;
    generationCommandId: string;
    modelRunAttemptId: string;
    policyVersion: string;
    formations: OpenLoopExtractionEffects["formations"];
    closures: OpenLoopExtractionEffects["closures"];
    ambiguousSuppressedTargetIds: readonly string[];
    now: Date;
  }>): Promise<
    | Readonly<{
        outcome: "settled" | "already_settled";
        formed: number;
        closed: number;
        suppressed: number;
      }>
    | Readonly<{ outcome: "fenced"; reason: string }>
  >;
}>;

// ---- Scan service (per-Event trigger, mirrors the Episode builder scan) ----

export type OpenLoopExtractionScanOutcome = Readonly<{
  extractionsQueued: number;
}>;

export type OpenLoopExtractionScanService = Readonly<{
  scanPending(): Promise<OpenLoopExtractionScanOutcome>;
}>;

export function createOpenLoopExtractionScanService(input: Readonly<{
  clock: () => Date;
  policyVersion: string;
  repository: Pick<
    OpenLoopExtractionRepository,
    "listEventsNeedingExtraction"
  >;
  modelRoleCommandService: Pick<ModelRoleCommandService, "admit">;
  scanLimit?: number;
  /** Production stays closed until the G2 bundle switches open the lane. */
  enabled: boolean;
}>): OpenLoopExtractionScanService {
  const scanLimit = input.scanLimit ?? 50;
  return {
    async scanPending() {
      if (!input.enabled) {
        return { extractionsQueued: 0 };
      }
      const candidates = await input.repository.listEventsNeedingExtraction({
        policyVersion: input.policyVersion,
        limit: scanLimit,
      });
      let extractionsQueued = 0;
      for (const candidate of candidates) {
        const admitted = await input.modelRoleCommandService.admit({
          userId: candidate.userId,
          role: "open_loop.extract",
          intentKey: `open-loop-extract:${candidate.eventRevisionId}`,
          subjectType: "conversation_event_revision",
          subjectId: candidate.eventRevisionId,
          sourceRevision: candidate.sourceRevision,
          sourceSnapshot: `open-loop-extract:${candidate.eventRevisionId}`,
          inputManifest: [
            {
              key: `event:${candidate.eventRevisionId}`,
              revision: candidate.sourceRevision,
              fingerprint: `event-revision:${candidate.eventRevisionId}`,
            },
          ],
          expectedDataEpoch: candidate.expectedDataEpoch,
          now: input.clock(),
        });
        if (admitted.outcome === "created") {
          extractionsQueued += 1;
        }
      }
      return { extractionsQueued };
    },
  };
}

// ---- Provider failure classification ----------------------------------------

/**
 * Transport categories map onto the 1A.3b typed failure codes, mirroring
 * the Episode builder. Only timeout / rate_limited / server_error /
 * result_unknown are technical-retry eligible (ADR-0132: at most one retry
 * on the same frozen model configuration, never a cross-model fallback).
 */
export function classifyOpenLoopProviderError(
  error: unknown,
): ModelRoleFailureCode {
  const category =
    typeof error === "object" && error !== null && "category" in error
      ? String((error as { category?: unknown }).category)
      : "";
  switch (category) {
    case "timeout":
      return "timeout";
    case "rate_limited":
      return "rate_limited";
    case "unavailable":
      return "server_error";
    case "authentication":
      return "authentication";
    case "configuration":
      return "configuration";
    case "policy_blocked":
      return "business_fence";
    case "invalid_response":
      return "schema_incompatible";
    default:
      return "result_unknown";
  }
}

// ---- The durable Workflow attempt entrypoint --------------------------------

export type OpenLoopExtractAttemptCommand = Readonly<{
  workflowCommandId: string;
  eventRevisionId: string;
  sourceRevision: number;
  generationCommandId: string;
  modelRunAttemptId: string;
  attemptNo: number;
  attemptKind: ModelRoleAttemptKind;
  rolloutPin: string;
  policyVersion: string;
  expectedDataEpoch: number;
}>;

export type OpenLoopExtractEntrypointResult = Readonly<{
  eventRevisionId: string;
  outcome:
    | "extracted"
    | "duplicate"
    | "stale_superseded"
    | "fenced"
    | "retryable_failed"
    | "failed";
  formedCount: number;
  closedCount: number;
  suppressedCount: number;
  skippedCount: number;
  errorCode: string | null;
}>;

function emptyResult(
  eventRevisionId: string,
  outcome: OpenLoopExtractEntrypointResult["outcome"],
  errorCode: string | null = null,
): OpenLoopExtractEntrypointResult {
  return {
    eventRevisionId,
    outcome,
    formedCount: 0,
    closedCount: 0,
    suppressedCount: 0,
    skippedCount: 0,
    errorCode,
  };
}

export async function runOpenLoopExtractAttempt(input: Readonly<{
  clock: () => Date;
  repository: OpenLoopExtractionRepository;
  modelRoleCommandService: ModelRoleCommandService;
  openLoopExtractProvider: OpenLoopExtractModelProvider;
  command: OpenLoopExtractAttemptCommand;
  providerEgress?: ModelRoleProviderEgress | undefined;
  recoveryGate?: RecoveryGate;
  recoveryOwnerId?: UserId;
}>): Promise<OpenLoopExtractEntrypointResult> {
  asWorkflowCommandId(input.command.workflowCommandId);
  assertWorkflowSafe(
    {
      workflowCommandId: input.command.workflowCommandId,
      subjectType: "conversation_event_revision",
      subjectId: input.command.eventRevisionId,
      sourceRevision: input.command.sourceRevision,
      policyVersion: input.command.policyVersion,
      expectedDataEpoch: input.command.expectedDataEpoch,
    },
    "command",
  );
  if (input.recoveryGate) {
    if (!input.recoveryOwnerId) {
      throw new Error(
        "Open Loop extraction recovery requires a content-free owner identity.",
      );
    }
    await input.recoveryGate.requireOpen(input.recoveryOwnerId);
  }
  if (!isModelRoleAttemptKind(input.command.attemptKind)) {
    throw new Error(
      `Unknown model role attempt kind: ${input.command.attemptKind}.`,
    );
  }

  const frozen = await input.repository.readExtractionSnapshot({
    eventRevisionId: input.command.eventRevisionId,
  });
  if (frozen.outcome !== "ready") {
    // Benign: the Event was corrected, purged, or fenced after admission.
    // A fresh admission at the new head re-runs extraction; a stale attempt
    // must not burn the durable workflow's retry budget.
    return emptyResult(input.command.eventRevisionId, "stale_superseded");
  }
  const snapshot = frozen.snapshot;
  if (input.recoveryGate) {
    await input.recoveryGate.requireOpen(snapshot.userId);
  }

  let proposals: readonly OpenLoopProposal[];
  let closures: readonly OpenLoopClosureProposal[];
  try {
    const request = {
      userId: snapshot.userId,
      eventRevisionId: snapshot.eventRevisionId,
      locale: snapshot.locale,
      timeZone: snapshot.timeZone,
      userText: snapshot.userText,
      evidenceCommittedAt: snapshot.evidenceCommittedAt,
      evidence: snapshot.evidence,
      openLoops: snapshot.identityCandidates.map((candidate) => ({
        openLoopId: candidate.openLoopId,
        kind: candidate.kind,
        localizedSummary: null,
        expectedStartAt: candidate.expectedStartAt,
      })),
    };
    const output = input.providerEgress
      ? await input.providerEgress.dispatch({
          userId: snapshot.userId,
          generationCommandId: asGenerationCommandId(
            input.command.generationCommandId,
          ),
          modelRunAttemptId: asModelRunAttemptId(
            input.command.modelRunAttemptId,
          ),
          role: "open_loop.extract",
          attemptNo: input.command.attemptNo,
          attemptKind: input.command.attemptKind,
          rolloutPin: input.command.rolloutPin,
          currentSourceRevision: snapshot.sourceRevision,
          expectedDataEpoch: input.command.expectedDataEpoch,
          now: input.clock(),
          sourceIsCurrent: async () => {
            const current = await input.repository.readExtractionSnapshot({
              eventRevisionId: input.command.eventRevisionId,
            });
            return (
              current.outcome === "ready" &&
              current.snapshot.expectedDataEpoch ===
                input.command.expectedDataEpoch
            );
          },
          execute: () =>
            input.openLoopExtractProvider.extractProposals(request),
        })
      : await input.openLoopExtractProvider.extractProposals(request);
    proposals = output.proposals;
    closures = output.closures;
  } catch (error) {
    if (
      error instanceof RecoveryGateClosedError &&
      error.result.status === "unavailable"
    ) {
      throw error;
    }
    if (error instanceof ProviderDispatchError && !error.settlesAttempt) {
      return emptyResult(
        input.command.eventRevisionId,
        "fenced",
        "provider_egress_blocked",
      );
    }
    const failureCode = classifyOpenLoopProviderError(error);
    const recorded = await input.modelRoleCommandService.recordAttemptResult({
      userId: snapshot.userId,
      generationCommandId: asGenerationCommandId(
        input.command.generationCommandId,
      ),
      modelRunAttemptId: asModelRunAttemptId(input.command.modelRunAttemptId),
      role: "open_loop.extract",
      attemptNo: input.command.attemptNo,
      technicalRetriesUsed: input.command.attemptNo - 1,
      semanticRepairsUsed: 0,
      outcome: "failed",
      failureCode,
      currentSourceRevision: snapshot.sourceRevision,
      expectedDataEpoch: input.command.expectedDataEpoch,
      now: input.clock(),
    });
    const outcome: OpenLoopExtractEntrypointResult["outcome"] =
      recorded.outcome === "discarded"
        ? "fenced"
        : recorded.outcome === "retry_scheduled"
          ? "retryable_failed"
          : "failed";
    return emptyResult(
      input.command.eventRevisionId,
      outcome,
      outcome === "fenced" ? (recorded.reason ?? failureCode) : failureCode,
    );
  }

  // Deterministic planning: evidence membership first, then the frozen
  // formation/closure cores. Invalid single proposals only raise the skip
  // count; they never block the qualified effects.
  const evidenceIds = new Set(
    snapshot.evidence.map((entry) => String(entry.evidenceItemId)),
  );
  let skippedCount = 0;
  const formationCandidates: Array<{
    proposalIndex: number;
    followupEligibleFromAt: string;
    expiresAt: string;
    evidenceLocator: string;
    plan: Extract<
      OpenLoopFormationPlan,
      { action: "create_loop" | "reuse_loop" }
    >;
    proposal: OpenLoopProposal;
  }> = [];
  // Provider contracts promise unique proposal indices; a rogue provider
  // must not corrupt the capacity join below, so duplicates fail closed.
  const seenIndices = new Set<number>();
  for (const proposal of proposals) {
    if (seenIndices.has(proposal.proposalIndex)) {
      skippedCount += 1;
      continue;
    }
    seenIndices.add(proposal.proposalIndex);
    if (!evidenceIds.has(String(proposal.evidenceItemId))) {
      skippedCount += 1;
      continue;
    }
    const plan = planOpenLoopFormation({
      proposal,
      evidenceCommittedAt: snapshot.evidenceCommittedAt,
      evidenceTimeZone: snapshot.timeZone,
      sourceUserText: snapshot.userText,
      identityCandidates: snapshot.identityCandidates,
    });
    if (plan.action === "skip") {
      skippedCount += 1;
      continue;
    }
    formationCandidates.push({
      proposalIndex: proposal.proposalIndex,
      followupEligibleFromAt: plan.followupEligibleFromAt,
      expiresAt: plan.expiresAt,
      evidenceLocator: String(proposal.evidenceItemId),
      plan,
      proposal,
    });
  }

  const closurePlan = planOpenLoopClosure({
    proposals: closures,
    openLoopSnapshot: snapshot.identityCandidates.map((candidate) => ({
      openLoopId: candidate.openLoopId,
      kind: candidate.kind,
      status: "open" as const,
    })),
  });
  const closureEffects: Array<
    OpenLoopExtractionEffects["closures"][number]
  > = [];
  let ambiguousSuppressedTargetIds: readonly string[] = [];
  if (closurePlan.action === "close") {
    closureEffects.push({
      targetOpenLoopId: String(closurePlan.targetOpenLoopId),
      terminalStatus: closurePlan.terminalStatus,
      closureEventRevisionId: snapshot.eventRevisionId,
      // Authoritative Event time, never the model assertion.
      closureCommittedAt: snapshot.evidenceCommittedAt,
    });
  } else if (closurePlan.action === "ambiguous_suppress") {
    ambiguousSuppressedTargetIds = closurePlan.targetOpenLoopIds.map((id) =>
      String(id),
    );
  }

  // The capacity core returns capacity-only entries, so rejoin the full
  // deterministic plan by proposal index (unique per the guard above).
  const candidateByIndex = new Map(
    formationCandidates.map((candidate) => [candidate.proposalIndex, candidate]),
  );
  const selected = selectFormationCandidates({
    candidates: formationCandidates.map(
      ({ proposalIndex, followupEligibleFromAt, expiresAt, evidenceLocator }) => ({
        proposalIndex,
        followupEligibleFromAt,
        expiresAt,
        evidenceLocator,
      }),
    ),
    currentOpenCount: snapshot.currentOpenCount,
    freedByClosureCount: closureEffects.length,
  });
  skippedCount += selected.skipped.length;
  const formations: Array<
    OpenLoopExtractionEffects["formations"][number]
  > = [];
  for (const entry of selected.selected.slice(0, MAX_NEW_LOOPS_PER_EVENT)) {
    const candidate = candidateByIndex.get(entry.proposalIndex);
    if (!candidate) {
      skippedCount += 1;
      continue;
    }
    formations.push({
      kind: candidate.plan.kind,
      sourceEvidenceItemId: String(candidate.proposal.evidenceItemId),
      sourceEventRevisionId: snapshot.eventRevisionId,
      sourceClaimVersionId: candidate.proposal.sourceClaimVersionId ?? null,
      sourceEpisodeVersionId: candidate.proposal.sourceEpisodeVersionId ?? null,
      canonicalClaimKey: candidate.proposal.canonicalClaimKey ?? null,
      // Render-only summaries are rebuilt later; formation stores none.
      localizedSummary: null,
      expectedStartAt: candidate.plan.expectedStartAt,
      expectedEndAt: candidate.plan.expectedEndAt,
      timePrecision: candidate.plan.precision,
      timezone: candidate.plan.timezone,
      followupEligibleFromAt: candidate.plan.followupEligibleFromAt,
      expiresAt: candidate.plan.expiresAt,
      expirySource: candidate.plan.expirySource,
      reuseOpenLoopId:
        candidate.plan.action === "reuse_loop"
          ? String(candidate.plan.openLoopId)
          : null,
    });
  }

  // Commit the authoritative domain result before settling the attempt. If a
  // worker dies in the gap, recovery replays this idempotent commit and then
  // settles the attempt without losing the Open Loop result.
  const committed = await input.repository.commitEventEffects({
    userId: snapshot.userId,
    sourceEventRevisionId: snapshot.eventRevisionId,
    expectedDataEpoch: input.command.expectedDataEpoch,
    generationCommandId: input.command.generationCommandId,
    modelRunAttemptId: input.command.modelRunAttemptId,
    policyVersion: input.command.policyVersion,
    formations,
    closures: closureEffects,
    ambiguousSuppressedTargetIds,
    now: input.clock(),
  });
  if (committed.outcome === "already_settled") {
    return {
      eventRevisionId: input.command.eventRevisionId,
      outcome: "duplicate",
      formedCount: committed.formed,
      closedCount: committed.closed,
      suppressedCount: committed.suppressed,
      skippedCount,
      errorCode: null,
    };
  }
  if (committed.outcome === "fenced") {
    await input.modelRoleCommandService.recordAttemptResult({
      userId: snapshot.userId,
      generationCommandId: asGenerationCommandId(
        input.command.generationCommandId,
      ),
      modelRunAttemptId: asModelRunAttemptId(input.command.modelRunAttemptId),
      role: "open_loop.extract",
      attemptNo: input.command.attemptNo,
      technicalRetriesUsed: input.command.attemptNo - 1,
      semanticRepairsUsed: 0,
      outcome: "failed",
      failureCode: "business_fence",
      currentSourceRevision: snapshot.sourceRevision,
      expectedDataEpoch: input.command.expectedDataEpoch,
      now: input.clock(),
    });
    return {
      eventRevisionId: input.command.eventRevisionId,
      outcome: "fenced",
      formedCount: 0,
      closedCount: 0,
      suppressedCount: 0,
      skippedCount,
      errorCode: committed.reason,
    };
  }
  const recorded = await input.modelRoleCommandService.recordAttemptResult({
    userId: snapshot.userId,
    generationCommandId: asGenerationCommandId(
      input.command.generationCommandId,
    ),
    modelRunAttemptId: asModelRunAttemptId(input.command.modelRunAttemptId),
    role: "open_loop.extract",
    attemptNo: input.command.attemptNo,
    technicalRetriesUsed: input.command.attemptNo - 1,
    semanticRepairsUsed: 0,
    outcome: "succeeded",
    currentSourceRevision: snapshot.sourceRevision,
    expectedDataEpoch: input.command.expectedDataEpoch,
    now: input.clock(),
  });
  if (recorded.outcome === "discarded") {
    return {
      eventRevisionId: input.command.eventRevisionId,
      outcome: "fenced",
      formedCount: 0,
      closedCount: 0,
      suppressedCount: 0,
      skippedCount,
      errorCode: recorded.reason ?? "already_settled",
    };
  }
  return {
    eventRevisionId: input.command.eventRevisionId,
    outcome: "extracted",
    formedCount: committed.formed,
    closedCount: committed.closed,
    suppressedCount: committed.suppressed,
    skippedCount,
    errorCode: null,
  };
}
