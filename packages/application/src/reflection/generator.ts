import {
  asDailySessionId,
  asGenerationCommandId,
  asModelRunAttemptId,
  asUserId,
  asWorkflowCommandId,
  type UserId,
} from "@sayhear/domain";

import type {
  ModelRoleAttemptKind,
  ModelRoleCommandService,
  ModelRoleFailureCode,
  RecordedModelRoleAttempt,
} from "../model-role-runtime";
import { isModelRoleAttemptKind } from "../model-role-runtime";
import {
  RecoveryGateClosedError,
  type RecoveryGate,
} from "../recovery-gate";
import {
  NARRATIVE_FINDINGS_SCHEMA_VERSION,
  NARRATIVE_VALIDATION_POLICY_VERSION,
  NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION,
  runNarrativeValidation,
  readNarrativeValidationOutcome,
  type NarrativeGeneratorProposition,
  type NarrativeGeneratorStatement,
  type NarrativeSourceEntry,
} from "../narrative-validation";
import type {
  ReflectionBuildEntrypointInput,
  ReflectionBuildEntrypointResult,
  ReflectionEntrypointDependencies,
  ReflectionFrozenInput,
  ReflectionGenerationModelOutput,
  ReflectionMaintenanceResult,
  ReflectionModelStatement,
  ReflectionRepository,
  ReflectionRunStatus,
} from "./types";
import {
  MAX_PROPOSITIONS_PER_STATEMENT,
  MAX_STATEMENTS_PER_VERSION,
  MAX_CANDIDATE_PROPOSALS_PER_VERSION,
  REFLECTION_ADMISSION_POLICY_VERSION,
  REFLECTION_OUTPUT_SCHEMA_VERSION,
  REFLECTION_DAILY_PROMPT_VERSION,
  REFLECTION_READINESS_POLICY_VERSION,
  REFLECTION_WEEKLY_PROMPT_VERSION,
} from "./types";
import { assertWorkflowSafe } from "../journal-eligibility";
import { ProviderDispatchError } from "../conversation-model";
import { planReflectionVersion } from "./engine";
import { dateOrdinal } from "./readiness";

/**
 * Durable orchestration for Daily / Weekly Reflection (issue #199, SPEC 5.3).
 * One frozen snapshot → one `reflection.daily` / `reflection.weekly`
 * GenerationCommand (at most one same-model technical retry through the
 * shared 1A.3b ledger) → deterministic Tier-1 gate → draft persist →
 * `narrative.validate` (shared role, frozen reflection Prompt) → fenced
 * current-pointer CAS commit + `propose_new` Candidate handoff. A validator
 * that has not completed forbids the current commit and every Candidate
 * (ADR-0132); Reflection v1 records semantic classes as advisory.
 */

function entrypointResult(
  input: Readonly<{
    subjectId: string;
    scope: "daily" | "weekly";
    outcome: ReflectionBuildEntrypointResult["outcome"];
    rejectionCode?: string | null;
    statementCount?: number;
    candidateCount?: number;
    degradedEpisodeReason?: string | null;
    errorCode?: string | null;
  }>,
): ReflectionBuildEntrypointResult {
  const result: ReflectionBuildEntrypointResult = {
    subjectId: input.subjectId,
    scope: input.scope,
    outcome: input.outcome,
    rejectionCode: input.rejectionCode ?? null,
    statementCount: input.statementCount ?? 0,
    candidateCount: input.candidateCount ?? 0,
    degradedEpisodeReason: input.degradedEpisodeReason ?? null,
    errorCode: input.errorCode ?? null,
  };
  assertWorkflowSafe(result, "reflection-result");
  return result;
}

function classifyReflectionProviderError(error: unknown): ModelRoleFailureCode {
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

function roleForScope(scope: "daily" | "weekly") {
  return scope === "daily"
    ? {
        role: "reflection.daily" as const,
        promptVersion: REFLECTION_DAILY_PROMPT_VERSION,
      }
    : {
        role: "reflection.weekly" as const,
        promptVersion: REFLECTION_WEEKLY_PROMPT_VERSION,
      };
}

/** Serialized draft text the validator independently re-decomposes. */
function draftTextFor(statements: readonly ReflectionModelStatement[]): string {
  return statements.map((statement) => statement.text).join("\n");
}

function generatorManifestFor(
  statements: readonly ReflectionModelStatement[],
): NarrativeGeneratorStatement[] {
  return statements.map((statement) => ({
    statementKey: statement.statementKey,
    text: statement.text,
    propositionStatements: statement.propositions.map(
      (proposition): NarrativeGeneratorProposition => ({
        propositionKey: proposition.propositionKey,
        normalizedProposition: proposition.normalizedProposition,
        propositionKind: proposition.propositionKind,
        epistemicRendering: proposition.epistemicRendering,
        supportKeys: [...proposition.supportEvidenceItemIds],
      }),
    ),
  }));
}

function sourceEntriesFor(frozen: ReflectionFrozenInput): NarrativeSourceEntry[] {
  return frozen.evidence.map((item) => ({
    sourceKey: item.evidenceItemId,
    sourceKind: "evidence_item" as const,
    text: item.sourceText,
    epistemicKind: null,
  }));
}

async function recordReflectionRunOutcome(input: Readonly<{
  repository: ReflectionRepository;
  userId: UserId;
  frozen: ReflectionFrozenInput;
  sourceRevision: number;
  expectedDataEpoch: number;
  generationCommandId: import("@sayhear/domain").GenerationCommandId | null;
  modelRunAttemptId: import("@sayhear/domain").ModelRunAttemptId | null;
  status: ReflectionRunStatus;
  outcomeDetail: string | null;
  statementCount: number | null;
  candidateCount: number | null;
  degradedEpisodeReason: string | null;
  errorCode: string | null;
}>): Promise<void> {
  await input.repository.recordRunOutcome({
    userId: input.userId,
    scopeType: input.frozen.scopeType,
    dailySessionId: input.frozen.dailySessionId,
    weekIdentifier: input.frozen.weekIdentifier,
    windowStartDate: input.frozen.windowStartDate,
    windowEndDate: input.frozen.windowEndDate,
    sourceRevision: input.sourceRevision,
    sourceDigest: input.frozen.sourceDigest,
    claimBaselineDigest: input.frozen.claimBaselineDigest,
    policyVersion: REFLECTION_ADMISSION_POLICY_VERSION,
    expectedDataEpoch: input.expectedDataEpoch,
    generationCommandId: input.generationCommandId,
    modelRunAttemptId: input.modelRunAttemptId,
    status: input.status,
    outcomeDetail: input.outcomeDetail,
    statementCount: input.statementCount,
    candidateCount: input.candidateCount,
    degradedEpisodeReason: input.degradedEpisodeReason,
    errorCode: input.errorCode,
  });
}

function manifestForFrozen(frozen: ReflectionFrozenInput) {
  return [
    ...frozen.evidence.map((item) => ({
      key: `evidence:${item.evidenceItemId}`,
      revision: 0,
      fingerprint: `evidence:${item.evidenceItemId}:${item.revisionId}`,
    })),
    ...frozen.episodes.map((item) => ({
      key: `episode:${item.episodeVersionId}`,
      revision: 0,
      fingerprint: `episode:${item.episodeVersionId}`,
    })),
    ...frozen.summaries.map((item) => ({
      key: `summary:${item.rollingSummaryVersionId}`,
      revision: 0,
      fingerprint: `summary:${item.rollingSummaryVersionId}`,
    })),
    {
      key: "claim-baseline",
      revision: 0,
      fingerprint: `baseline:${frozen.claimBaselineDigest}`,
    },
  ];
}

// ---- Daily build entrypoint ---------------------------------------------------

export async function runReflectionDailyBuild(input: Readonly<{
  dependencies: ReflectionEntrypointDependencies;
  command: ReflectionBuildEntrypointInput;
  recoveryGate?: RecoveryGate;
  recoveryOwnerId?: UserId;
}>): Promise<ReflectionBuildEntrypointResult> {
  asWorkflowCommandId(input.command.workflowCommandId);
  assertWorkflowSafe(input.command, "reflection-command");
  const dailySessionId = asDailySessionId(input.command.subjectId);
  if (input.command.scope !== "daily") {
    return entrypointResult({
      subjectId: input.command.subjectId,
      scope: input.command.scope,
      outcome: "rejected",
      rejectionCode: "scope_mismatch",
    });
  }

  if (input.recoveryGate) {
    if (!input.recoveryOwnerId) {
      throw new Error("Daily reflection recovery requires a content-free owner identity.");
    }
    await input.recoveryGate.requireOpen(input.recoveryOwnerId);
  }

  const evaluated = await input.dependencies.repository.readDailySnapshot({
    dailySessionId,
    sourceRevision: input.command.sourceRevision,
    claimBaselineDigest: input.command.claimBaselineDigest,
    policyVersion: input.command.policyVersion,
  });
  if (evaluated.outcome !== "evaluated") {
    // Benign: the head moved, the day is not ready anymore, or the baseline
    // moved between queue time and run time. The scheduler re-freezes a
    // fresh command at the new identity; no durable retry is burned.
    return entrypointResult({
      subjectId: input.command.subjectId,
      scope: "daily",
      outcome: "stale_superseded",
      errorCode: evaluated.outcome,
    });
  }
  if (input.recoveryGate) {
    await input.recoveryGate.requireOpen(evaluated.snapshot.userId);
  }

  let admitted: Awaited<
    ReturnType<ModelRoleCommandService["admit"]>
  >;
  try {
    admitted = await input.dependencies.modelRoleCommandService.admit({
      userId: evaluated.snapshot.userId,
      role: "reflection.daily",
      intentKey: `reflection-daily:${dailySessionId}:${input.command.sourceRevision}:${input.command.claimBaselineDigest}`,
      subjectType: "daily_session",
      subjectId: dailySessionId,
      sourceRevision: input.command.sourceRevision,
      sourceSnapshot: `daily-session:${input.command.sourceRevision}`,
      inputManifest: manifestForFrozen(evaluated.frozen),
      expectedDataEpoch: input.command.expectedDataEpoch,
      now: input.dependencies.clock(),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.message.includes("epoch")
        ? "data_epoch"
        : "admission";
    return entrypointResult({
      subjectId: input.command.subjectId,
      scope: "daily",
      outcome: "fenced",
      errorCode: reason,
    });
  }

  return executeReflectionAttempt({
    dependencies: input.dependencies,
    userId: evaluated.snapshot.userId,
    scope: "daily",
    frozen: evaluated.frozen,
    degradedEpisodeReason: evaluated.degradedEpisodeReason ?? null,
    expectedDataEpoch: input.command.expectedDataEpoch,
    generationCommandId: admitted.generationCommandId,
    modelRunAttemptId: admitted.modelRunAttemptId,
    attemptNo: admitted.attemptNo,
    attemptKind: admitted.attemptKind,
    rolloutPin:
      input.dependencies.modelRoleCommandService.configuration("reflection.daily")
        ?.rolloutPin ?? "",
    technicalRetriesUsed: admitted.attemptNo - 1,
    sourcePolicyVersion: input.command.policyVersion,
    policyVersion: REFLECTION_ADMISSION_POLICY_VERSION,
  });
}

// ---- Weekly build entrypoint --------------------------------------------------

export async function runReflectionWeeklyBuild(input: Readonly<{
  dependencies: ReflectionEntrypointDependencies;
  command: ReflectionBuildEntrypointInput;
  recoveryGate?: RecoveryGate;
  recoveryOwnerId?: UserId;
}>): Promise<ReflectionBuildEntrypointResult> {
  asWorkflowCommandId(input.command.workflowCommandId);
  assertWorkflowSafe(input.command, "reflection-command");
  const userId = asUserId(input.command.subjectId);
  if (input.command.scope !== "weekly") {
    return entrypointResult({
      subjectId: input.command.subjectId,
      scope: input.command.scope,
      outcome: "rejected",
      rejectionCode: "scope_mismatch",
    });
  }
  const weekIdentifier = input.command.weekIdentifier ?? "";
  if (!weekIdentifier) {
    return entrypointResult({
      subjectId: input.command.subjectId,
      scope: "weekly",
      outcome: "rejected",
      rejectionCode: "week_identifier_missing",
    });
  }

  if (input.recoveryGate) {
    if (!input.recoveryOwnerId) {
      throw new Error("Weekly reflection recovery requires a content-free owner identity.");
    }
    await input.recoveryGate.requireOpen(input.recoveryOwnerId);
  }

  const evaluated = await input.dependencies.repository.readWeeklySnapshot({
    userId,
    weekIdentifier,
    windowStartDate: input.command.windowStartDate ?? "",
    windowEndDate: input.command.windowEndDate ?? "",
    sourceDigest: input.command.sourceDigest ?? "",
    policyVersion: input.command.policyVersion,
  });
  if (evaluated.outcome !== "evaluated") {
    return entrypointResult({
      subjectId: input.command.subjectId,
      scope: "weekly",
      outcome: "stale_superseded",
      errorCode: evaluated.outcome,
    });
  }
  if (input.recoveryGate) {
    await input.recoveryGate.requireOpen(evaluated.snapshot.userId);
  }

  let admitted: Awaited<
    ReturnType<ModelRoleCommandService["admit"]>
  >;
  try {
    admitted = await input.dependencies.modelRoleCommandService.admit({
      userId: evaluated.snapshot.userId,
      role: "reflection.weekly",
      intentKey: `reflection-weekly:${userId}:${weekIdentifier}:${evaluated.frozen.sourceDigest ?? ""}`,
      subjectType: "app_user",
      subjectId: userId,
      sourceRevision: dateOrdinal(evaluated.frozen.windowStartDate ?? ""),
      sourceSnapshot: `week:${weekIdentifier}:${(evaluated.frozen.sourceDigest ?? "").slice(0, 16)}`,
      inputManifest: manifestForFrozen(evaluated.frozen),
      expectedDataEpoch: input.command.expectedDataEpoch,
      now: input.dependencies.clock(),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.message.includes("epoch")
        ? "data_epoch"
        : "admission";
    return entrypointResult({
      subjectId: input.command.subjectId,
      scope: "weekly",
      outcome: "fenced",
      errorCode: reason,
    });
  }

  return executeReflectionAttempt({
    dependencies: input.dependencies,
    userId: evaluated.snapshot.userId,
    scope: "weekly",
    frozen: evaluated.frozen,
    degradedEpisodeReason: null,
    expectedDataEpoch: input.command.expectedDataEpoch,
    generationCommandId: admitted.generationCommandId,
    modelRunAttemptId: admitted.modelRunAttemptId,
    attemptNo: admitted.attemptNo,
    attemptKind: admitted.attemptKind,
    rolloutPin:
      input.dependencies.modelRoleCommandService.configuration("reflection.weekly")
        ?.rolloutPin ?? "",
    technicalRetriesUsed: admitted.attemptNo - 1,
    sourcePolicyVersion: input.command.policyVersion,
    policyVersion: REFLECTION_ADMISSION_POLICY_VERSION,
  });
}

// ---- Retry re-entry -------------------------------------------------------------

export async function runReflectionAttempt(input: Readonly<{
  dependencies: ReflectionEntrypointDependencies;
  command: {
    generationCommandId: string;
    modelRunAttemptId: string;
    attemptNo: number;
    attemptKind: ModelRoleAttemptKind;
    rolloutPin: string;
  };
  recoveryGate?: RecoveryGate;
  recoveryOwnerId?: UserId;
}>): Promise<ReflectionBuildEntrypointResult> {
  if (input.recoveryGate) {
    if (!input.recoveryOwnerId) {
      throw new Error("Reflection retry recovery requires a content-free owner identity.");
    }
    await input.recoveryGate.requireOpen(input.recoveryOwnerId);
  }
  const context = await input.dependencies.repository.readAttemptContext({
    generationCommandId: asGenerationCommandId(input.command.generationCommandId),
    modelRunAttemptId: asModelRunAttemptId(input.command.modelRunAttemptId),
  });
  if (context.outcome !== "evaluated") {
    return entrypointResult({
      subjectId: "",
      scope: "daily",
      outcome: "stale_superseded",
      errorCode: "attempt_settled_or_unknown",
    });
  }
  if (!isModelRoleAttemptKind(input.command.attemptKind)) {
    throw new Error(`Unknown model role attempt kind: ${input.command.attemptKind}.`);
  }
  const scope = context.dailySessionId !== null ? "daily" : "weekly";
  if (scope === "daily") {
    const evaluated = await input.dependencies.repository.readDailySnapshot({
      dailySessionId: asDailySessionId(context.dailySessionId!),
      sourceRevision: context.sourceRevision,
      claimBaselineDigest: context.claimBaselineDigest,
      policyVersion: context.policyVersion,
    });
    if (evaluated.outcome !== "evaluated") {
      return entrypointResult({
        subjectId: context.dailySessionId ?? "",
        scope,
        outcome: "stale_superseded",
        errorCode: evaluated.outcome,
      });
    }
    await input.recoveryGate?.requireOpen(evaluated.snapshot.userId);
    return executeReflectionAttempt({
      dependencies: input.dependencies,
      userId: evaluated.snapshot.userId,
      scope,
      frozen: evaluated.frozen,
      degradedEpisodeReason: evaluated.degradedEpisodeReason ?? null,
      expectedDataEpoch: context.expectedDataEpoch,
      generationCommandId: input.command.generationCommandId,
      modelRunAttemptId: input.command.modelRunAttemptId,
      attemptNo: input.command.attemptNo,
      attemptKind: input.command.attemptKind,
      rolloutPin: input.command.rolloutPin,
      technicalRetriesUsed: input.command.attemptNo - 1,
      sourcePolicyVersion: context.policyVersion,
      policyVersion: context.policyVersion,
    });
  }
  await input.recoveryGate?.requireOpen(context.userId);
  return executeReflectionAttempt({
    dependencies: input.dependencies,
    userId: context.userId,
    scope,
    frozen: context.frozen,
    degradedEpisodeReason: null,
    expectedDataEpoch: context.expectedDataEpoch,
    generationCommandId: input.command.generationCommandId,
    modelRunAttemptId: input.command.modelRunAttemptId,
    attemptNo: input.command.attemptNo,
    attemptKind: input.command.attemptKind,
    rolloutPin: input.command.rolloutPin,
    technicalRetriesUsed: input.command.attemptNo - 1,
    sourcePolicyVersion: context.policyVersion,
    policyVersion: context.policyVersion,
  });
}

// ---- Shared attempt execution ---------------------------------------------------

async function executeReflectionAttempt(input: Readonly<{
  dependencies: ReflectionEntrypointDependencies;
  userId: UserId;
  scope: "daily" | "weekly";
  frozen: ReflectionFrozenInput;
  degradedEpisodeReason: string | null;
  expectedDataEpoch: number;
  generationCommandId: string;
  modelRunAttemptId: string;
  attemptNo: number;
  attemptKind: ModelRoleAttemptKind;
  rolloutPin: string;
  technicalRetriesUsed: number;
  sourcePolicyVersion: string;
  policyVersion: string;
}>): Promise<ReflectionBuildEntrypointResult> {
  const { repository } = input.dependencies;
  const { role, promptVersion } = roleForScope(input.scope);
  const generationCommandId = asGenerationCommandId(input.generationCommandId);
  const modelRunAttemptId = asModelRunAttemptId(input.modelRunAttemptId);
  const sourceRevision =
    input.frozen.scopeType === "daily_session"
      ? (input.frozen.days[0]?.sourceRevision ?? 0)
      : dateOrdinal(input.frozen.windowStartDate ?? "");
  const subjectId = input.frozen.dailySessionId ?? input.userId;
  const locale = input.frozen.dominantLocale ?? "en";
  const settleAttempt = (
    outcome: "succeeded" | "failed",
    failureCode?: ModelRoleFailureCode,
  ) =>
    input.dependencies.modelRoleCommandService.recordAttemptResult({
      userId: input.userId,
      generationCommandId,
      modelRunAttemptId,
      role,
      attemptNo: input.attemptNo,
      technicalRetriesUsed: input.technicalRetriesUsed,
      semanticRepairsUsed: 0,
      outcome,
      ...(failureCode ? { failureCode } : {}),
      currentSourceRevision: sourceRevision,
      expectedDataEpoch: input.expectedDataEpoch,
      now: input.dependencies.clock(),
    });

  type PreparedGeneration =
    | { outcome: "generated"; output: ReflectionGenerationModelOutput }
    | { outcome: "fenced"; errorCode: string | null }
    | { outcome: "already_built"; recorded: RecordedModelRoleAttempt };

  const request = {
    userId: input.userId,
    role,
    scopeType: input.frozen.scopeType,
    weekIdentifier: input.frozen.weekIdentifier,
    locale,
    evidence: input.frozen.evidence,
    episodes: input.frozen.episodes,
    summaries: input.frozen.summaries,
    baseline: input.frozen.baseline,
    sessionCount: input.frozen.days.length,
    maxStatements: MAX_STATEMENTS_PER_VERSION,
    maxPropositionsPerStatement: MAX_PROPOSITIONS_PER_STATEMENT,
    maxCandidateProposals: MAX_CANDIDATE_PROPOSALS_PER_VERSION,
  };

  // The run ledger is prepared inside the Provider-dispatch boundary so the
  // prepared → running claim (owned by the egress port) happens before the
  // first fenced domain write. Admit alone leaves the attempt prepared,
  // which the domain fence must keep rejecting.
  const runGeneration = async (): Promise<PreparedGeneration> => {
    const prepared = await repository.prepareAttempt?.({
      userId: input.userId,
      scopeType: input.frozen.scopeType,
      dailySessionId: input.frozen.dailySessionId,
      weekIdentifier: input.frozen.weekIdentifier,
      windowStartDate: input.frozen.windowStartDate,
      windowEndDate: input.frozen.windowEndDate,
      sourceRevision,
      sourceDigest: input.frozen.sourceDigest,
      claimBaselineDigest: input.frozen.claimBaselineDigest,
      policyVersion: input.policyVersion,
      expectedDataEpoch: input.expectedDataEpoch,
      generationCommandId,
      modelRunAttemptId,
      now: input.dependencies.clock(),
    });
    if (prepared?.outcome === "fenced") {
      await input.dependencies.modelRoleCommandService.discardAttempt({
        userId: input.userId,
        generationCommandId,
        modelRunAttemptId,
        reason:
          prepared.reason === "data_epoch" ? "data_epoch" : "source_changed",
        now: input.dependencies.clock(),
      });
      return { outcome: "fenced", errorCode: prepared.reason ?? null };
    }
    if (prepared?.outcome === "already_built") {
      const recorded =
        await input.dependencies.modelRoleCommandService.recordAttemptResult({
          userId: input.userId,
          generationCommandId,
          modelRunAttemptId,
          role,
          attemptNo: input.attemptNo,
          technicalRetriesUsed: input.technicalRetriesUsed,
          semanticRepairsUsed: 0,
          outcome: "succeeded",
          currentSourceRevision: sourceRevision,
          expectedDataEpoch: input.expectedDataEpoch,
          now: input.dependencies.clock(),
        });
      return { outcome: "already_built", recorded };
    }
    return {
      outcome: "generated",
      output: await input.dependencies.reflectionProvider.generate(request),
    };
  };

  let generated: PreparedGeneration;
  try {
    generated = input.dependencies.providerEgress
      ? await input.dependencies.providerEgress.dispatch({
          userId: input.userId,
          generationCommandId,
          modelRunAttemptId,
          role,
          attemptNo: input.attemptNo,
          attemptKind: input.attemptKind,
          rolloutPin: input.rolloutPin,
          currentSourceRevision: sourceRevision,
          expectedDataEpoch: input.expectedDataEpoch,
          now: input.dependencies.clock(),
          sourceIsCurrent: async () => {
            if (input.scope === "daily") {
              const current = await repository.readDailySnapshot({
                dailySessionId: input.frozen.dailySessionId!,
                sourceRevision,
                claimBaselineDigest: input.frozen.claimBaselineDigest,
                policyVersion: input.sourcePolicyVersion,
              });
              return (
                current.outcome === "evaluated" &&
                current.snapshot.userId === input.userId &&
                current.snapshot.ownerEpoch === input.expectedDataEpoch
              );
            }
            const current = await repository.readWeeklySnapshot({
              userId: input.userId,
              weekIdentifier: input.frozen.weekIdentifier ?? "",
              windowStartDate: input.frozen.windowStartDate ?? "",
              windowEndDate: input.frozen.windowEndDate ?? "",
              sourceDigest: input.frozen.sourceDigest ?? "",
              policyVersion: input.sourcePolicyVersion,
            });
            return (
              current.outcome === "evaluated" &&
              current.snapshot.ownerEpoch === input.expectedDataEpoch
            );
          },
          execute: runGeneration,
        })
      : await runGeneration();
  } catch (error) {
    if (
      error instanceof RecoveryGateClosedError &&
      error.result.status === "unavailable"
    ) {
      throw error;
    }
    if (error instanceof ProviderDispatchError && !error.settlesAttempt) {
      return entrypointResult({
        subjectId: String(subjectId),
        scope: input.scope,
        outcome: "fenced",
        errorCode: "provider_egress_blocked",
      });
    }
    const failureCode = classifyReflectionProviderError(error);
    const recorded = await input.dependencies.modelRoleCommandService.recordAttemptResult({
      userId: input.userId,
      generationCommandId,
      modelRunAttemptId,
      role,
      attemptNo: input.attemptNo,
      technicalRetriesUsed: input.technicalRetriesUsed,
      semanticRepairsUsed: 0,
      outcome: "failed",
      failureCode,
      currentSourceRevision: sourceRevision,
      expectedDataEpoch: input.expectedDataEpoch,
      now: input.dependencies.clock(),
    });
    const outcome =
      recorded.outcome === "discarded"
        ? "fenced"
        : recorded.outcome === "retry_scheduled"
          ? "retryable_failed"
          : "failed";
    return entrypointResult({
      subjectId: String(subjectId),
      scope: input.scope,
      outcome,
      errorCode: outcome === "fenced" ? (recorded.reason ?? failureCode) : failureCode,
    });
  }
  if (generated.outcome === "fenced") {
    return entrypointResult({
      subjectId: String(subjectId),
      scope: input.scope,
      outcome: "fenced",
      errorCode: generated.errorCode,
    });
  }
  if (generated.outcome === "already_built") {
    const recorded = generated.recorded;
    return entrypointResult({
      subjectId: String(subjectId),
      scope: input.scope,
      outcome: recorded.outcome === "discarded" ? "fenced" : "built",
      errorCode:
        recorded.outcome === "discarded"
          ? (recorded.reason ?? null)
          : "already_built",
    });
  }
  const output = generated.output;

  // Tier-1 deterministic gate (all-or-nothing, before any draft is kept).
  const plan = planReflectionVersion({
    frozen: input.frozen,
    output: {
      statements: output.statements,
      candidateProposals: output.candidateProposals,
    },
  });
  if (plan.action === "fail_version") {
    await recordReflectionRunOutcome({
      repository,
      userId: input.userId,
      frozen: input.frozen,
      sourceRevision,
      expectedDataEpoch: input.expectedDataEpoch,
      generationCommandId,
      modelRunAttemptId,
      status: "failed",
      outcomeDetail: plan.rejectionCode,
      statementCount: 0,
      candidateCount: 0,
      degradedEpisodeReason: input.degradedEpisodeReason,
      errorCode: `tier1:${plan.rejectionCode}`,
    });
    const recorded = await settleAttempt("succeeded");
    if (recorded.outcome === "discarded") {
      return entrypointResult({
        subjectId: String(subjectId),
        scope: input.scope,
        outcome: "fenced",
        errorCode: recorded.reason ?? "already_settled",
      });
    }
    return entrypointResult({
      subjectId: String(subjectId),
      scope: input.scope,
      outcome: "rejected",
      rejectionCode: plan.rejectionCode,
      errorCode: `tier1:${plan.rejectionCode}`,
    });
  }

  const persisted = await repository.persistDraftVersion({
    userId: input.userId,
    scopeType: input.frozen.scopeType,
    dailySessionId: input.frozen.dailySessionId,
    weekIdentifier: input.frozen.weekIdentifier,
    windowStartDate: input.frozen.windowStartDate,
    windowEndDate: input.frozen.windowEndDate,
    sourceRevision,
    sourceDigest: input.frozen.sourceDigest,
    claimBaselineDigest: input.frozen.claimBaselineDigest,
    policyVersion: REFLECTION_ADMISSION_POLICY_VERSION,
    schedulePolicyVersion: REFLECTION_READINESS_POLICY_VERSION,
    promptVersion,
    schemaVersion: REFLECTION_OUTPUT_SCHEMA_VERSION,
    locale,
    expectedDataEpoch: input.expectedDataEpoch,
    generationCommandId,
    modelRunAttemptId,
    degradedEpisodeReason: input.degradedEpisodeReason,
    statements: plan.statements,
    now: input.dependencies.clock(),
  });
  if (persisted.outcome === "fenced") {
    await recordReflectionRunOutcome({
      repository,
      userId: input.userId,
      frozen: input.frozen,
      sourceRevision,
      expectedDataEpoch: input.expectedDataEpoch,
      generationCommandId,
      modelRunAttemptId,
      status: "fenced",
      outcomeDetail: persisted.reason,
      statementCount: null,
      candidateCount: null,
      degradedEpisodeReason: input.degradedEpisodeReason,
      errorCode: persisted.reason,
    });
    await settleAttempt("failed", "business_fence");
    return entrypointResult({
      subjectId: String(subjectId),
      scope: input.scope,
      outcome: "fenced",
      errorCode: persisted.reason,
    });
  }
  const reflectionVersionId = persisted.reflectionVersionId;

  // Shared validator (ADR-0132): the build may not commit current or derive
  // a Candidate until a completed `narrative.validate` command exists.
  const validated = await runNarrativeValidation({
    dependencies: input.dependencies.narrativeValidation,
    command: {
      request: {
        userId: input.userId,
        artifactKind: "reflection",
        draftRef: `reflection-version:${reflectionVersionId}`,
        draftLocale: locale,
        draftText: draftTextFor(plan.statements),
        generatorManifest: generatorManifestFor(plan.statements),
        sourceEntries: sourceEntriesFor(input.frozen),
        plannedCoverageKeys: [],
        validationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
        promptVersion: NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION,
        schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
      },
      expectedDataEpoch: input.expectedDataEpoch,
    },
  });
  if (validated.outcome !== "completed" || !validated.verdict) {
    const validatorError = `validator_${validated.outcome}`;
    await recordReflectionRunOutcome({
      repository,
      userId: input.userId,
      frozen: input.frozen,
      sourceRevision,
      expectedDataEpoch: input.expectedDataEpoch,
      generationCommandId,
      modelRunAttemptId,
      status: "failed",
      outcomeDetail: validatorError,
      statementCount: null,
      candidateCount: null,
      degradedEpisodeReason: input.degradedEpisodeReason,
      errorCode: validatorError,
    });
    await settleAttempt("failed", "semantic_rejection");
    return entrypointResult({
      subjectId: String(subjectId),
      scope: input.scope,
      outcome:
        validated.outcome === "retryable_failed" ? "retryable_failed" : "failed",
      errorCode: validatorError,
    });
  }

  const outcome = await readNarrativeValidationOutcome({
    repository: input.dependencies.narrativeValidation.repository,
    userId: input.userId,
    artifactKind: "reflection",
    draftRef: `reflection-version:${reflectionVersionId}`,
    now: input.dependencies.clock(),
  });
  if (outcome.outcome !== "ok" || outcome.result.result.outcome !== "accepted") {
    // `incomplete` (validator not finished), `content_expired`, and a blocked
    // verdict all forbid the current commit and every Candidate (ADR-0132;
    // a raised-to-blocking policy must never publish a Reflection).
    const validatorError =
      outcome.outcome === "ok"
        ? "validator_blocked"
        : `validator_${outcome.outcome}`;
    await recordReflectionRunOutcome({
      repository,
      userId: input.userId,
      frozen: input.frozen,
      sourceRevision,
      expectedDataEpoch: input.expectedDataEpoch,
      generationCommandId,
      modelRunAttemptId,
      status: "failed",
      outcomeDetail: validatorError,
      statementCount: null,
      candidateCount: null,
      degradedEpisodeReason: input.degradedEpisodeReason,
      errorCode: validatorError,
    });
    await settleAttempt("failed", "semantic_rejection");
    return entrypointResult({
      subjectId: String(subjectId),
      scope: input.scope,
      outcome: "failed",
      errorCode: validatorError,
    });
  }

  const committed = await repository.commitReflection({
    userId: input.userId,
    reflectionVersionId,
    frozen: input.frozen,
    sourceRevision,
    sourceDigest: input.frozen.sourceDigest,
    claimBaselineDigest: input.frozen.claimBaselineDigest,
    policyVersion: REFLECTION_ADMISSION_POLICY_VERSION,
    expectedDataEpoch: input.expectedDataEpoch,
    generationCommandId,
    modelRunAttemptId,
    validatorRequestId: outcome.result.narrativeValidatorRequestId,
    validatorResultId: outcome.result.narrativeValidatorResultId,
    promptVersion,
    locale,
    statements: plan.statements,
    candidateProposals: output.candidateProposals,
    dedupeFingerprintSecret: input.dependencies.dedupeFingerprintSecret,
  });
  if (committed.outcome === "fenced") {
    await recordReflectionRunOutcome({
      repository,
      userId: input.userId,
      frozen: input.frozen,
      sourceRevision,
      expectedDataEpoch: input.expectedDataEpoch,
      generationCommandId,
      modelRunAttemptId,
      status: "fenced",
      outcomeDetail: committed.reason,
      statementCount: null,
      candidateCount: null,
      degradedEpisodeReason: input.degradedEpisodeReason,
      errorCode: committed.reason,
    });
    await settleAttempt("failed", "business_fence");
    return entrypointResult({
      subjectId: String(subjectId),
      scope: input.scope,
      outcome: "fenced",
      errorCode: committed.reason,
    });
  }
  if (committed.outcome === "already_committed") {
    const recorded = await settleAttempt("succeeded");
    return entrypointResult({
      subjectId: String(subjectId),
      scope: input.scope,
      outcome: recorded.outcome === "discarded" ? "fenced" : "built",
      errorCode:
        recorded.outcome === "discarded"
          ? recorded.reason ?? null
          : "already_committed",
    });
  }
  await recordReflectionRunOutcome({
    repository,
    userId: input.userId,
    frozen: input.frozen,
    sourceRevision,
    expectedDataEpoch: input.expectedDataEpoch,
    generationCommandId,
    modelRunAttemptId,
    status: "built",
    outcomeDetail: null,
    statementCount: committed.statementCount,
    candidateCount: committed.candidateCount,
    degradedEpisodeReason: input.degradedEpisodeReason,
    errorCode: null,
  });
  const recorded = await settleAttempt("succeeded");
  if (recorded.outcome === "discarded") {
    return entrypointResult({
      subjectId: String(subjectId),
      scope: input.scope,
      outcome: "fenced",
      errorCode: recorded.reason ?? "already_settled",
    });
  }
  return entrypointResult({
    subjectId: String(subjectId),
    scope: input.scope,
    outcome: "built",
    statementCount: committed.statementCount,
    candidateCount: committed.candidateCount,
    degradedEpisodeReason: input.degradedEpisodeReason,
  });
}

// ---- Scheduler scan service ------------------------------------------------------

export type ReflectionSchedulerScanOutcome = Readonly<{
  dailyQueued: number;
  weeklyQueued: number;
  maintenanceQueued: number;
}>;

export type ReflectionSchedulerScanService = Readonly<{
  scanPending(): Promise<ReflectionSchedulerScanOutcome>;
}>;

export function createReflectionSchedulerScanService(input: Readonly<{
  clock: () => Date;
  policyVersion: string;
  repository: ReflectionRepository;
  scanLimit?: number;
  /** Production stays closed until a release manifest opens the stage. */
  enabled: boolean;
}>): ReflectionSchedulerScanService {
  const scanLimit = input.scanLimit ?? 50;
  return {
    async scanPending() {
      if (!input.enabled) {
        return { dailyQueued: 0, weeklyQueued: 0, maintenanceQueued: 0 };
      }
      const dailySessions = await input.repository.listDueDailySessions({
        now: input.clock(),
        policyVersion: input.policyVersion,
        limit: scanLimit,
      });
      let dailyQueued = 0;
      for (const session of dailySessions) {
        const digest = await input.repository.readDailyBaselineDigest({
          dailySessionId: session.dailySessionId,
          sourceRevision: session.sourceRevision,
        });
        if (!digest) {
          continue;
        }
        const queued = await input.repository.queueDailyReflection({
          dailySessionId: session.dailySessionId,
          sourceRevision: session.sourceRevision,
          claimBaselineDigest: digest,
          policyVersion: input.policyVersion,
        });
        if (queued.outcome === "queued") {
          dailyQueued += 1;
        }
      }
      const weeks = await input.repository.listDueWeekWindows({
        now: input.clock(),
        policyVersion: input.policyVersion,
        limit: scanLimit,
      });
      let weeklyQueued = 0;
      for (const week of weeks) {
        const queued = await input.repository.queueWeeklyReflection({
          userId: week.userId,
          weekIdentifier: week.weekIdentifier,
          windowStartDate: week.windowStartDate,
          windowEndDate: week.windowEndDate,
          sourceDigest: week.sourceDigest,
          policyVersion: input.policyVersion,
        });
        if (queued.outcome === "queued") {
          weeklyQueued += 1;
        }
      }
      const users = await input.repository.listUsersNeedingMaintenance({
        now: input.clock(),
        policyVersion: input.policyVersion,
        limit: scanLimit,
      });
      let maintenanceQueued = 0;
      for (const userId of users) {
        const queued = await input.repository.queueReflectionMaintenance({
          userId,
          policyVersion: input.policyVersion,
        });
        if (queued.outcome === "queued") {
          maintenanceQueued += 1;
        }
      }
      return { dailyQueued, weeklyQueued, maintenanceQueued };
    },
  };
}

// ---- Maintenance ------------------------------------------------------------------

export async function runReflectionMaintenance(input: Readonly<{
  clock: () => Date;
  repository: ReflectionRepository;
  userId: UserId;
  policyVersion: string;
}>): Promise<ReflectionMaintenanceResult> {
  const staledVersions = await input.repository.markStaleByInvalidatedEvidence({
    userId: input.userId,
    policyVersion: input.policyVersion,
    limit: 500,
  });
  const expiredContent = await input.repository.purgeExpiredContent({
    now: input.clock(),
    limit: 500,
  });
  return { staledVersions, expiredContent };
}
