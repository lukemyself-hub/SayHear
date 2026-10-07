import {
  asDailySessionId,
  asGenerationCommandId,
  asModelRunAttemptId,
  asUserId,
  asWorkflowCommandId,
  type DailySessionId,
  type UserId,
} from "@sayhear/domain";

import type {
  EpisodeBuildAttemptInput,
  EpisodeBuildEntrypointInput,
  EpisodeBuildEntrypointResult,
  EpisodeBuildModelProvider,
  EpisodeBuilderRepository,
  EpisodeFrozenBuildInput,
  EpisodeMaintenanceResult,
} from "./types";
import {
  EPISODE_KIND_CATALOG_V1,
  MAX_EPISODE_SWEEPER_ROWS_PER_PASS,
  MAX_PROPOSALS_PER_BUILD,
} from "./types";
import { assertWorkflowSafe } from "../journal-eligibility";
import {
  ProviderDispatchError,
  normalizeModelRoleCallUsage,
  type ModelRoleCallUsage,
} from "../conversation-model";
import {
  RecoveryGateClosedError,
  type RecoveryGate,
} from "../recovery-gate";
import {
  isModelRoleAttemptKind,
  type ModelRoleAttemptKind,
  type ModelRoleCommandService,
  type ModelRoleProviderEgress,
} from "../model-role-runtime";
import {
  episodeDedupeFingerprint,
  episodeSemanticTarget,
  planEpisodeAdmission,
} from "./admission";

/**
 * Daily Episode Builder (issue #197, SPEC 4.3): Journal-style daily
 * eligibility over a frozen Evidence snapshot under `source_valid`. The
 * `episode.build` model role only proposes typed proposals; deterministic
 * code validates the real-world anchor, decides new / matched / unresolved,
 * and commits Episode versions. Missing or failed Episodes never block
 * Conversation, Journal, or basic Memory, and nothing here notifies users.
 */

// ---- Daily build scan service (cron convergence) ----------------------------

export type EpisodeBuildScanOutcome = Readonly<{
  buildsQueued: number;
  maintenanceQueued: number;
}>;

export type EpisodeBuilderScanService = Readonly<{
  scanPending(): Promise<EpisodeBuildScanOutcome>;
}>;

export function createEpisodeBuilderScanService(input: Readonly<{
  clock: () => Date;
  policyVersion: string;
  repository: EpisodeBuilderRepository;
  scanLimit?: number;
  /** Production stays closed until a release manifest opens the stage. */
  enabled: boolean;
}>): EpisodeBuilderScanService {
  const scanLimit = input.scanLimit ?? 50;
  return {
    async scanPending() {
      if (!input.enabled) {
        return { buildsQueued: 0, maintenanceQueued: 0 };
      }
      const now = input.clock();
      const sessions = await input.repository.listQuiescentSessionsNeedingBuild({
        now,
        policyVersion: input.policyVersion,
        limit: scanLimit,
      });
      let buildsQueued = 0;
      for (const session of sessions) {
        const queued = await input.repository.queueEpisodeBuild({
          dailySessionId: session.dailySessionId,
          sourceRevision: session.sourceRevision,
          policyVersion: input.policyVersion,
        });
        if (queued.outcome === "queued") {
          buildsQueued += 1;
        }
      }
      const users = await input.repository.listUsersNeedingMaintenance({
        now,
        policyVersion: input.policyVersion,
        limit: scanLimit,
      });
      let maintenanceQueued = 0;
      for (const userId of users) {
        const queued = await input.repository.queueEpisodeMaintenance({
          userId,
          policyVersion: input.policyVersion,
        });
        if (queued.outcome === "queued") {
          maintenanceQueued += 1;
        }
      }
      return { buildsQueued, maintenanceQueued };
    },
  };
}

// ---- Provider failure classification ----------------------------------------

/**
 * Transport categories map onto the 1A.3b typed failure codes. Only
 * timeout / rate_limited / server_error / result_unknown are
 * technical-retry eligible (ADR-0132: at most one retry on the same frozen
 * model configuration, never a cross-model fallback).
 */
export function classifyEpisodeProviderError(
  error: unknown,
): import("../model-role-runtime").ModelRoleFailureCode {
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

/**
 * The content-free usage for one attempt. A Provider failure that proves a
 * specific response cause is authoritative for the same call; the request
 * callback is the fallback for transport paths that report usage separately.
 * Never reads any other call's record.
 */
function attemptUsage(
  error: unknown,
  callUsage: ModelRoleCallUsage | null,
): ModelRoleCallUsage | null {
  const failure =
    error instanceof ProviderDispatchError ? (error.failure ?? null) : null;
  return normalizeModelRoleCallUsage(failure ?? callUsage);
}

// ---- The durable Workflow entrypoints ---------------------------------------

export async function runEpisodeBuild(input: Readonly<{
  clock: () => Date;
  repository: EpisodeBuilderRepository;
  modelRoleCommandService: ModelRoleCommandService;
  episodeBuildProvider: EpisodeBuildModelProvider;
  dedupeFingerprintSecret: string;
  workflowReceiptId: string;
  command: EpisodeBuildEntrypointInput;
  providerEgress?: ModelRoleProviderEgress | undefined;
  recoveryGate?: RecoveryGate;
  recoveryOwnerId?: UserId;
}>): Promise<EpisodeBuildEntrypointResult> {
  asWorkflowCommandId(input.command.workflowCommandId);
  const dailySessionId = asDailySessionId(input.command.subjectId);
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

  if (input.recoveryGate) {
    if (!input.recoveryOwnerId) {
      throw new Error("Episode build recovery requires a content-free owner identity.");
    }
    await input.recoveryGate.requireOpen(input.recoveryOwnerId);
  }

  const evaluated = await input.repository.readSessionSnapshot({
    dailySessionId,
    sourceRevision: input.command.sourceRevision,
    policyVersion: input.command.policyVersion,
  });
  if (evaluated.outcome !== "evaluated") {
    // Benign: the head moved on, the session vanished, or activity resumed.
    // The recovery scan re-admits a fresh command at the new head; a stale
    // build must not burn the durable workflow's retry budget (2026-08-17).
    return {
      dailySessionId,
      outcome: "stale_superseded",
      candidateCount: 0,
      acceptedCount: 0,
      unresolvedCount: 0,
      rejectedCount: 0,
      errorCode: null,
    };
  }

  if (input.recoveryGate) {
    await input.recoveryGate.requireOpen(evaluated.snapshot.userId);
  }

  const admitted = await input.modelRoleCommandService.admit({
    userId: evaluated.snapshot.userId,
    role: "episode.build",
    intentKey: `episode-build:${dailySessionId}:${input.command.sourceRevision}`,
    subjectType: "daily_session",
    subjectId: dailySessionId,
    sourceRevision: input.command.sourceRevision,
    sourceSnapshot: `daily-session:${input.command.sourceRevision}`,
    inputManifest: evaluated.frozen.evidence.map((item) => ({
      key: `evidence:${item.evidenceItemId}`,
      revision: input.command.sourceRevision,
      fingerprint: `evidence:${item.evidenceItemId}:${item.revisionId}`,
    })),
    expectedDataEpoch: input.command.expectedDataEpoch,
    now: input.clock(),
  });

  return executeEpisodeAttempt({
    clock: input.clock,
    repository: input.repository,
    episodeBuildProvider: input.episodeBuildProvider,
    modelRoleCommandService: input.modelRoleCommandService,
    providerEgress: input.providerEgress,
    dedupeFingerprintSecret: input.dedupeFingerprintSecret,
    userId: evaluated.snapshot.userId,
    dailySessionId,
    sourceRevision: input.command.sourceRevision,
    policyVersion: input.command.policyVersion,
    expectedDataEpoch: input.command.expectedDataEpoch,
    frozen: evaluated.frozen,
    admitted: {
      generationCommandId: admitted.generationCommandId,
      modelRunAttemptId: admitted.modelRunAttemptId,
      attemptNo: admitted.attemptNo,
    },
    attemptKind: admitted.attemptKind,
    rolloutPin:
      input.modelRoleCommandService.configuration("episode.build")?.rolloutPin ??
      "",
    technicalRetriesUsed: admitted.attemptNo - 1,
  });
}

export async function runEpisodeBuildAttempt(input: Readonly<{
  clock: () => Date;
  repository: EpisodeBuilderRepository;
  modelRoleCommandService: ModelRoleCommandService;
  episodeBuildProvider: EpisodeBuildModelProvider;
  dedupeFingerprintSecret: string;
  command: EpisodeBuildAttemptInput;
  providerEgress?: ModelRoleProviderEgress | undefined;
  recoveryGate?: RecoveryGate;
  recoveryOwnerId?: UserId;
}>): Promise<EpisodeBuildEntrypointResult> {
  if (input.recoveryGate) {
    if (!input.recoveryOwnerId) {
      throw new Error("Episode retry recovery requires a content-free owner identity.");
    }
    await input.recoveryGate.requireOpen(input.recoveryOwnerId);
  }
  const context = await input.repository.readAttemptContext({
    generationCommandId: asGenerationCommandId(input.command.generationCommandId),
    modelRunAttemptId: asModelRunAttemptId(input.command.modelRunAttemptId),
  });
  if (context.outcome !== "evaluated") {
    return {
      dailySessionId: "",
      outcome: "stale_superseded",
      candidateCount: 0,
      acceptedCount: 0,
      unresolvedCount: 0,
      rejectedCount: 0,
      errorCode: null,
    };
  }
  await input.recoveryGate?.requireOpen(context.userId);
  if (!isModelRoleAttemptKind(input.command.attemptKind)) {
    throw new Error(`Unknown model role attempt kind: ${input.command.attemptKind}.`);
  }
  return executeEpisodeAttempt({
    clock: input.clock,
    repository: input.repository,
    episodeBuildProvider: input.episodeBuildProvider,
    modelRoleCommandService: input.modelRoleCommandService,
    providerEgress: input.providerEgress,
    dedupeFingerprintSecret: input.dedupeFingerprintSecret,
    userId: context.userId,
    dailySessionId: context.dailySessionId,
    sourceRevision: context.sourceRevision,
    policyVersion: context.policyVersion,
    expectedDataEpoch: context.expectedDataEpoch,
    frozen: context.frozen,
    admitted: {
      generationCommandId: input.command.generationCommandId,
      modelRunAttemptId: input.command.modelRunAttemptId,
      attemptNo: input.command.attemptNo,
    },
    attemptKind: input.command.attemptKind,
    rolloutPin: input.command.rolloutPin,
    technicalRetriesUsed: input.command.attemptNo - 1,
  });
}

/**
 * One provider attempt, the attempt-result ledger, and the fenced domain
 * commit. Provider transport failures map onto the 1A.3b typed failure
 * codes; only timeout / rate_limited / server_error / result_unknown are
 * technical-retry eligible (ADR-0132: at most one retry on the same frozen
 * model configuration, never a cross-model fallback).
 */
async function executeEpisodeAttempt(input: Readonly<{
  clock: () => Date;
  repository: EpisodeBuilderRepository;
  episodeBuildProvider: EpisodeBuildModelProvider;
  modelRoleCommandService: ModelRoleCommandService;
  providerEgress: ModelRoleProviderEgress | undefined;
  dedupeFingerprintSecret: string;
  userId: UserId;
  dailySessionId: DailySessionId;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
  frozen: EpisodeFrozenBuildInput;
  admitted: Readonly<{
    generationCommandId: string;
    modelRunAttemptId: string;
    attemptNo: number;
  }>;
  attemptKind: ModelRoleAttemptKind;
  rolloutPin: string;
  technicalRetriesUsed: number;
}>): Promise<EpisodeBuildEntrypointResult> {
  let proposals: Awaited<
    ReturnType<EpisodeBuildModelProvider["buildProposals"]>
  >;
  // Request-scoped so concurrent attempts cannot interleave usage records.
  let callUsage: ModelRoleCallUsage | null = null;
  const onUsage = (usage: ModelRoleCallUsage) => {
    callUsage = normalizeModelRoleCallUsage(usage);
  };
  try {
    const request = {
      userId: input.userId,
      dailySessionId: input.dailySessionId,
      sourceRevision: input.sourceRevision,
      kindCatalog: EPISODE_KIND_CATALOG_V1,
      evidence: input.frozen.evidence,
      activeEpisodes: input.frozen.activeEpisodes,
    };
    proposals = input.providerEgress
      ? await input.providerEgress.dispatch({
          userId: input.userId,
          generationCommandId: asGenerationCommandId(input.admitted.generationCommandId),
          modelRunAttemptId: asModelRunAttemptId(input.admitted.modelRunAttemptId),
          role: "episode.build",
          attemptNo: input.admitted.attemptNo,
          attemptKind: input.attemptKind,
          rolloutPin: input.rolloutPin,
          currentSourceRevision: input.sourceRevision,
          expectedDataEpoch: input.expectedDataEpoch,
          now: input.clock(),
          sourceIsCurrent: async () => {
            const current = await input.repository.readSessionSnapshot({
              dailySessionId: input.dailySessionId,
              sourceRevision: input.sourceRevision,
              policyVersion: input.policyVersion,
            });
            return (
              current.outcome === "evaluated" &&
              current.snapshot.userId === input.userId &&
              current.snapshot.ownerEpoch === input.expectedDataEpoch
            );
          },
          execute: () =>
            input.episodeBuildProvider.buildProposals(request, onUsage),
        })
      : await input.episodeBuildProvider.buildProposals(request, onUsage);
  } catch (error) {
    if (
      error instanceof RecoveryGateClosedError &&
      error.result.status === "unavailable"
    ) {
      throw error;
    }
    if (error instanceof ProviderDispatchError && !error.settlesAttempt) {
      return {
        dailySessionId: input.dailySessionId,
        outcome: "fenced",
        candidateCount: 0,
        acceptedCount: 0,
        unresolvedCount: 0,
        rejectedCount: 0,
        errorCode: "provider_egress_blocked",
      };
    }
    const failureCode = classifyEpisodeProviderError(error);
    const recorded = await input.modelRoleCommandService.recordAttemptResult({
      userId: input.userId,
      generationCommandId: asGenerationCommandId(input.admitted.generationCommandId),
      modelRunAttemptId: asModelRunAttemptId(input.admitted.modelRunAttemptId),
      role: "episode.build",
      attemptNo: input.admitted.attemptNo,
      technicalRetriesUsed: input.technicalRetriesUsed,
      semanticRepairsUsed: 0,
      outcome: "failed",
      failureCode,
      currentSourceRevision: input.sourceRevision,
      expectedDataEpoch: input.expectedDataEpoch,
      now: input.clock(),
      usage: attemptUsage(error, callUsage),
    });
    const outcome: EpisodeBuildEntrypointResult["outcome"] =
      recorded.outcome === "discarded"
        ? "fenced"
        : recorded.outcome === "retry_scheduled"
          ? "retryable_failed"
          : "failed";
    if (outcome !== "fenced") {
      await input.repository.recordBuildRunOutcome({
        userId: input.userId,
        dailySessionId: input.dailySessionId,
        sourceRevision: input.sourceRevision,
        policyVersion: input.policyVersion,
        expectedDataEpoch: input.expectedDataEpoch,
        generationCommandId: asGenerationCommandId(input.admitted.generationCommandId),
        modelRunAttemptId: asModelRunAttemptId(input.admitted.modelRunAttemptId),
        status: outcome,
        outcomeDetail: failureCode,
        candidateCount: 0,
        acceptedCount: 0,
        unresolvedCount: 0,
        rejectedCount: 0,
        errorCode: failureCode,
      });
    }
    return {
      dailySessionId: input.dailySessionId,
      outcome,
      candidateCount: 0,
      acceptedCount: 0,
      unresolvedCount: 0,
      rejectedCount: 0,
      errorCode: outcome === "fenced" ? (recorded.reason ?? failureCode) : failureCode,
    };
  }

  // Commit the authoritative domain result before settling the attempt. If a
  // worker dies in the gap, recovery replays this idempotent commit and then
  // settles the attempt without losing the Episode result.
  const committed = await input.repository.commitEpisodeAdmission({
    userId: input.userId,
    dailySessionId: input.dailySessionId,
    sourceRevision: input.sourceRevision,
    policyVersion: input.policyVersion,
    expectedDataEpoch: input.expectedDataEpoch,
    generationCommandId: asGenerationCommandId(input.admitted.generationCommandId),
    modelRunAttemptId: asModelRunAttemptId(input.admitted.modelRunAttemptId),
    proposals: proposals.slice(0, MAX_PROPOSALS_PER_BUILD),
    dedupeFingerprintSecret: input.dedupeFingerprintSecret,
  });
  if (committed.outcome === "fenced") {
    await input.modelRoleCommandService.recordAttemptResult({
      userId: input.userId,
      generationCommandId: asGenerationCommandId(input.admitted.generationCommandId),
      modelRunAttemptId: asModelRunAttemptId(input.admitted.modelRunAttemptId),
      role: "episode.build",
      attemptNo: input.admitted.attemptNo,
      technicalRetriesUsed: input.technicalRetriesUsed,
      semanticRepairsUsed: 0,
      outcome: "failed",
      failureCode: "business_fence",
      currentSourceRevision: input.sourceRevision,
      expectedDataEpoch: input.expectedDataEpoch,
      now: input.clock(),
      usage: normalizeModelRoleCallUsage(callUsage),
    });
    return {
      dailySessionId: input.dailySessionId,
      outcome: "fenced",
      candidateCount: 0,
      acceptedCount: 0,
      unresolvedCount: 0,
      rejectedCount: 0,
      errorCode: committed.reason,
    };
  }
  const recorded = await input.modelRoleCommandService.recordAttemptResult({
    userId: input.userId,
    generationCommandId: asGenerationCommandId(input.admitted.generationCommandId),
    modelRunAttemptId: asModelRunAttemptId(input.admitted.modelRunAttemptId),
    role: "episode.build",
    attemptNo: input.admitted.attemptNo,
    technicalRetriesUsed: input.technicalRetriesUsed,
    semanticRepairsUsed: 0,
    outcome: "succeeded",
    currentSourceRevision: input.sourceRevision,
    expectedDataEpoch: input.expectedDataEpoch,
    now: input.clock(),
    usage: normalizeModelRoleCallUsage(callUsage),
  });
  if (recorded.outcome === "discarded") {
    return {
      dailySessionId: input.dailySessionId,
      outcome: "fenced",
      candidateCount: 0,
      acceptedCount: 0,
      unresolvedCount: 0,
      rejectedCount: 0,
      errorCode: recorded.reason ?? "already_settled",
    };
  }
  return {
    dailySessionId: input.dailySessionId,
    outcome: "built",
    candidateCount: committed.candidateCount,
    acceptedCount: committed.acceptedCount,
    unresolvedCount: committed.unresolvedCount,
    rejectedCount: committed.rejectedCount,
    errorCode: null,
  };
}

// ---- Episode maintenance (sweep + impact review) ----------------------------

export async function runEpisodeMaintenance(input: Readonly<{
  clock: () => Date;
  repository: EpisodeBuilderRepository;
  userId: UserId;
  policyVersion: string;
  dedupeFingerprintSecret: string;
}>): Promise<EpisodeMaintenanceResult> {
  const sweep = await input.repository.staleUnresolvedCandidates({
    userId: input.userId,
    now: input.clock(),
    policyVersion: input.policyVersion,
    dedupeFingerprintSecret: input.dedupeFingerprintSecret,
    limit: MAX_EPISODE_SWEEPER_ROWS_PER_PASS,
  });
  const purged = await input.repository.purgeExpiredTerminalCandidates({
    userId: input.userId,
    now: input.clock(),
    limit: MAX_EPISODE_SWEEPER_ROWS_PER_PASS,
  });
  const paused = await input.repository.detectAndPauseInvalidatedVersions({
    userId: input.userId,
    policyVersion: input.policyVersion,
    limit: MAX_EPISODE_SWEEPER_ROWS_PER_PASS,
  });
  const revalidated = await input.repository.revalidatePausedVersions({
    userId: input.userId,
    policyVersion: input.policyVersion,
    limit: MAX_EPISODE_SWEEPER_ROWS_PER_PASS,
  });
  return {
    staledCandidates: sweep.staledCandidates,
    alreadyTerminalCandidates: sweep.alreadyTerminalCandidates,
    purgedTerminalCandidates: purged,
    pausedVersions: paused.length,
    revalidatedVersions: revalidated.revalidated,
    supersededVersions: revalidated.superseded,
  };
}
