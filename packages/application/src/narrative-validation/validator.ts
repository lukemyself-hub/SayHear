import { createHash } from "node:crypto";

import {
  asGenerationCommandId,
  asModelRunAttemptId,
  type NarrativeValidatorRequestId,
  type UserId,
} from "@sayhear/domain";

import {
  RecoveryGateClosedError,
  type RecoveryGate,
} from "../recovery-gate";
import {
  ProviderDispatchError,
  normalizeModelRoleCallUsage,
  type ModelRoleCallUsage,
  type ProviderResponseFailure,
} from "../conversation-model";
import type {
  ModelRoleAttemptKind,
  ModelRoleCommandService,
  ModelRoleFailureCode,
} from "../model-role-runtime";
import type {
  NarrativeValidationAttemptInput,
  NarrativeValidationEntrypointDependencies,
  NarrativeValidationEntrypointInput,
  NarrativeValidationEntrypointResult,
  NarrativeValidationRecord,
  NarrativeValidationRepository,
  NarrativeValidationResult,
  NarrativeValidationResultRecord,
  NarrativeValidatorModelOutput,
} from "./types";
import { NARRATIVE_VALIDATION_CONTENT_EXPIRY_DAYS } from "./types";
import {
  compareNarrativeManifests,
  evaluateNarrativeValidation,
  validateNarrativeRequest,
} from "./engine";

/**
 * Durable orchestration for the shared `narrative.validate` role (issue #198,
 * ADR-0121/0132/0133). One publishable draft gets exactly one frozen
 * validator GenerationCommand admitted through the shared 1A.3b ledger with
 * at most one same-model technical retry; stale sources, owner epochs and
 * rollout pins fail closed. The validator returns typed findings only — it
 * never owns a Reflection / Bio publish pointer or a Candidate pointer.
 */

export function narrativeValidationRequestFingerprint(
  request: NarrativeValidationRecord["frozenRequest"],
): string {
  const canonical = JSON.stringify({
    draftLocale: request.draftLocale,
    draftRef: request.draftRef,
    draftText: request.draftText,
    promptVersion: request.promptVersion,
    schemaVersion: request.schemaVersion,
    userId: request.userId,
    validationPolicyVersion: request.validationPolicyVersion,
  });
  return sha256(canonical);
}

/**
 * Transport categories map onto the 1A.3b typed failure codes (ADR-0132).
 * The category map mirrors `classifyEpisodeProviderError`; only
 * timeout / rate_limited / server_error / result_unknown are
 * technical-retry eligible on the same frozen model configuration.
 */
export function classifyNarrativeProviderError(
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

function entrypointResult(
  draftRef: string,
  outcome: NarrativeValidationEntrypointResult["outcome"],
  errorCode: string | null,
  rejectionCode: string | null,
  verdict: NarrativeValidationEntrypointResult["verdict"],
  ledger: {
    generationCommandId: string | null;
    modelRunAttemptId: string | null;
  } = { generationCommandId: null, modelRunAttemptId: null },
  responseFailure: NarrativeValidationEntrypointResult["responseFailure"] = null,
  usage: NarrativeValidationEntrypointResult["usage"] = null,
): NarrativeValidationEntrypointResult {
  return {
    draftRef,
    outcome,
    errorCode,
    rejectionCode,
    verdict,
    ...ledger,
    responseFailure,
    usage,
  };
}

/**
 * Issue #252: the content-free response cause, when the transport or the role
 * provider proved one. It is evidence for the next versioned configuration
 * only — it never changes `errorCode`, the ledger write, or the retry plan.
 */
function responseFailureOf(error: unknown): ProviderResponseFailure | null {
  return error instanceof ProviderDispatchError ? (error.failure ?? null) : null;
}

/**
 * Production validation entry (issue AC-1). A producer calls this from its
 * own durable workflow after persisting a draft: the frozen request is
 * submitted once (idempotent per draft), one `narrative.validate`
 * GenerationCommand is admitted through the shared ledger with the frozen
 * request row as its subject, and the typed result is committed behind the
 * owner epoch + active rollout pin fence.
 */
export async function runNarrativeValidation(input: Readonly<{
  dependencies: NarrativeValidationEntrypointDependencies;
  command: NarrativeValidationEntrypointInput;
  recoveryGate?: RecoveryGate;
}>): Promise<NarrativeValidationEntrypointResult> {
  const request = input.command.request;
  const rejection = validateNarrativeRequest(request);
  if (rejection) {
    return entrypointResult(request.draftRef, "rejected", null, rejection.code, null);
  }

  if (input.recoveryGate) {
    await input.recoveryGate.requireOpen(request.userId);
  }

  const requestFingerprint = narrativeValidationRequestFingerprint(request);

  const submitted = await input.dependencies.repository.submitRequest({
    userId: request.userId,
    request,
    requestFingerprint,
    expectedDataEpoch: input.command.expectedDataEpoch,
    now: input.dependencies.clock(),
  });
  if (submitted.outcome === "owner_missing") {
    return entrypointResult(request.draftRef, "fenced", "owner_missing", null, null);
  }
  if (submitted.outcome === "data_epoch") {
    return entrypointResult(request.draftRef, "fenced", "data_epoch", null, null);
  }
  if (submitted.outcome === "intent_conflict") {
    // The draft locator is already owned by a different frozen intent:
    // terminal business fence, never retried (AC-4). Revalidation requires
    // a new draft revision from the producer.
    return entrypointResult(request.draftRef, "rejected", null, "draft_intent_conflict", null);
  }
  const requestRecord = submitted.request;

  const admitted = await input.dependencies.modelRoleCommandService.admit({
    userId: request.userId,
    role: "narrative.validate",
    intentKey: `narrative-validate:${request.artifactKind}:${request.draftRef}`,
    subjectType: request.artifactKind === "bio" ? "bio_version" : "reflection",
    // The frozen request row is the command subject: opaque, owner-scoped
    // and replayable without carrying draft text into workflow payloads.
    subjectId: requestRecord.narrativeValidatorRequestId,
    sourceRevision: 0,
    sourceSnapshot: `narrative-draft:${request.artifactKind}:${requestFingerprint.slice(0, 24)}`,
    inputManifest: [
      {
        key: `draft:${request.artifactKind}:${request.draftRef}`,
        revision: 0,
        fingerprint: `draft:${requestFingerprint}`,
      },
      ...request.sourceEntries.map((entry) => ({
        key: `source:${entry.sourceKey}`,
        revision: 0,
        fingerprint: `source:${sha256Prefix(entry.text)}`,
      })),
    ],
    expectedDataEpoch: input.command.expectedDataEpoch,
    now: input.dependencies.clock(),
  });

  return executeNarrativeAttempt({
    dependencies: input.dependencies,
    frozenRequest: requestRecord.frozenRequest,
    narrativeValidatorRequestId: requestRecord.narrativeValidatorRequestId,
    userId: request.userId,
    expectedDataEpoch: input.command.expectedDataEpoch,
    generationCommandId: admitted.generationCommandId,
    modelRunAttemptId: admitted.modelRunAttemptId,
    attemptNo: admitted.attemptNo,
    attemptKind: admitted.attemptKind,
    rolloutPin:
      input.dependencies.modelRoleCommandService.configuration("narrative.validate")
        ?.rolloutPin ?? "",
    technicalRetriesUsed: admitted.attemptNo - 1,
  });
}

/**
 * Retry re-entry for an admitted `narrative.validate` command. The shared
 * ledger schedules the retry attempt; this entrypoint replays the frozen
 * request so the per-command budget stays initial + one technical retry.
 */
export async function runNarrativeValidationAttempt(input: Readonly<{
  dependencies: NarrativeValidationEntrypointDependencies;
  command: NarrativeValidationAttemptInput;
  recoveryGate?: RecoveryGate;
  recoveryOwnerId?: UserId;
}>): Promise<NarrativeValidationEntrypointResult> {
  if (input.recoveryGate) {
    if (!input.recoveryOwnerId) {
      throw new Error("Narrative retry recovery requires a content-free owner identity.");
    }
    await input.recoveryGate.requireOpen(input.recoveryOwnerId);
  }
  const context = await input.dependencies.repository.readAttemptContext({
    generationCommandId: asGenerationCommandId(input.command.generationCommandId),
    modelRunAttemptId: asModelRunAttemptId(input.command.modelRunAttemptId),
  });
  if (context.outcome !== "evaluated") {
    return entrypointResult("", "incomplete", "attempt_settled_or_unknown", null, null);
  }
  await input.recoveryGate?.requireOpen(context.request.userId);
  const attemptKind = input.command.attemptKind ?? "technical_retry";
  const rolloutPin =
    input.command.rolloutPin ??
    input.dependencies.modelRoleCommandService.configuration("narrative.validate")
      ?.rolloutPin ??
    "";
  return executeNarrativeAttempt({
    dependencies: input.dependencies,
    frozenRequest: context.request,
    narrativeValidatorRequestId: context.narrativeValidatorRequestId,
    userId: context.request.userId,
    expectedDataEpoch: context.expectedDataEpoch,
    generationCommandId: input.command.generationCommandId,
    modelRunAttemptId: input.command.modelRunAttemptId,
    attemptNo: input.command.attemptNo,
    attemptKind,
    rolloutPin,
    technicalRetriesUsed: input.command.attemptNo - 1,
  });
}

/**
 * One provider attempt, the attempt-result ledger, and the fenced result
 * commit. `narrative.validate` has zero semantic repairs: a semantic
 * rejection is the typed domain outcome recorded on the result, never a
 * relabeled technical failure (ADR-0132).
 */
async function executeNarrativeAttempt(input: Readonly<{
  dependencies: NarrativeValidationEntrypointDependencies;
  frozenRequest: NarrativeValidationRecord["frozenRequest"];
  narrativeValidatorRequestId: NarrativeValidatorRequestId;
  userId: string;
  expectedDataEpoch: number;
  generationCommandId: string;
  modelRunAttemptId: string;
  attemptNo: number;
  attemptKind: ModelRoleAttemptKind;
  rolloutPin: string;
  technicalRetriesUsed: number;
}>): Promise<NarrativeValidationEntrypointResult> {
  const request = input.frozenRequest;
  const generationCommandId = asGenerationCommandId(input.generationCommandId);
  const modelRunAttemptId = asModelRunAttemptId(input.modelRunAttemptId);
  const ledger = {
    generationCommandId: input.generationCommandId,
    modelRunAttemptId: input.modelRunAttemptId,
  };

  let modelOutput: NarrativeValidatorModelOutput;
  // Request-scoped so concurrent commands cannot interleave usage records.
  let callUsage: ModelRoleCallUsage | null = null;
  const onUsage = (usage: ModelRoleCallUsage) => {
    callUsage = usage;
  };
  try {
    const providerRequest = {
      userId: request.userId,
      artifactKind: request.artifactKind,
      draftRef: request.draftRef,
      draftLocale: request.draftLocale,
      draftText: request.draftText,
      sourceEntries: request.sourceEntries,
    };
    modelOutput = input.dependencies.providerEgress
      ? await input.dependencies.providerEgress.dispatch({
          userId: request.userId,
          generationCommandId,
          modelRunAttemptId,
          role: "narrative.validate",
          attemptNo: input.attemptNo,
          attemptKind: input.attemptKind,
          rolloutPin: input.rolloutPin,
          currentSourceRevision: 0,
          expectedDataEpoch: input.expectedDataEpoch,
          now: input.dependencies.clock(),
          sourceIsCurrent: async () => {
            const current = await input.dependencies.repository.readRequest({
              userId: request.userId,
              artifactKind: request.artifactKind,
              draftRef: request.draftRef,
            });
            return current.outcome === "ok";
          },
          execute: () =>
            input.dependencies.narrativeValidationProvider.validateNarrative(
              providerRequest,
              onUsage,
            ),
        })
      : await input.dependencies.narrativeValidationProvider.validateNarrative(
          providerRequest,
          onUsage,
        );
  } catch (error) {
    if (
      error instanceof RecoveryGateClosedError &&
      error.result.status === "unavailable"
    ) {
      throw error;
    }
    if (error instanceof ProviderDispatchError && !error.settlesAttempt) {
      return entrypointResult(
        request.draftRef,
        "fenced",
        "provider_egress_blocked",
        null,
        null,
        ledger,
        null,
        callUsage,
      );
    }
    const failureCode = classifyNarrativeProviderError(error);
    const recorded = await input.dependencies.modelRoleCommandService.recordAttemptResult({
      userId: request.userId,
      generationCommandId,
      modelRunAttemptId,
      role: "narrative.validate",
      attemptNo: input.attemptNo,
      technicalRetriesUsed: input.technicalRetriesUsed,
      semanticRepairsUsed: 0,
      outcome: "failed",
      failureCode,
      currentSourceRevision: 0,
      expectedDataEpoch: input.expectedDataEpoch,
      now: input.dependencies.clock(),
      // A proven response failure is authoritative for this same call; the
      // request callback is the fallback when no failure carries usage.
      usage: normalizeModelRoleCallUsage(responseFailureOf(error) ?? callUsage),
    });
    const outcome: NarrativeValidationEntrypointResult["outcome"] =
      recorded.outcome === "discarded"
        ? "fenced"
        : recorded.outcome === "retry_scheduled"
          ? "retryable_failed"
          : "failed";
    return entrypointResult(
      request.draftRef,
      outcome,
      outcome === "fenced" ? (recorded.reason ?? failureCode) : failureCode,
      null,
      null,
      ledger,
      responseFailureOf(error),
      callUsage,
    );
  }

  // Guard the whole post-Provider path up to the attempt settlement (issue
  // #257): a throw while decomposing/evaluating or committing must still
  // settle the attempt and record the usage the already-successful Provider
  // call consumed, instead of leaving it `running`. The repository rolls back
  // its own transaction before rethrowing, so no partial validator result can
  // survive. The failure code stays an existing terminal one (`unknown`): it
  // is not a Provider transport failure, so `planModelRoleRecovery` schedules
  // no technical retry, and the issue decision adds no new code.
  let result: NarrativeValidationResult;
  let committed: Awaited<
    ReturnType<NarrativeValidationRepository["commitResult"]>
  >;
  try {
    const comparison = compareNarrativeManifests({
      generatorManifest: request.generatorManifest,
      sourceEntries: request.sourceEntries,
      plannedCoverageKeys: request.plannedCoverageKeys,
      independentPropositions: modelOutput.propositions,
      coverageKeys: modelOutput.coverageKeys,
    });
    result = evaluateNarrativeValidation({
      artifactKind: request.artifactKind,
      validationPolicyVersion: request.validationPolicyVersion,
      schemaVersion: request.schemaVersion,
      promptVersion: request.promptVersion,
      comparison,
      independentPropositions: modelOutput.propositions,
      sourceEntries: request.sourceEntries,
    });
    committed = await input.dependencies.repository.commitResult({
      narrativeValidatorRequestId: input.narrativeValidatorRequestId,
      userId: request.userId,
      generationCommandId,
      modelRunAttemptId,
      result,
    });
  } catch (error) {
    if (
      error instanceof RecoveryGateClosedError &&
      error.result.status === "unavailable"
    ) {
      throw error;
    }
    const failureCode: ModelRoleFailureCode = "unknown";
    const recorded = await input.dependencies.modelRoleCommandService.recordAttemptResult({
      userId: request.userId,
      generationCommandId,
      modelRunAttemptId,
      role: "narrative.validate",
      attemptNo: input.attemptNo,
      technicalRetriesUsed: input.technicalRetriesUsed,
      semanticRepairsUsed: 0,
      outcome: "failed",
      failureCode,
      currentSourceRevision: 0,
      expectedDataEpoch: input.expectedDataEpoch,
      now: input.dependencies.clock(),
      usage: normalizeModelRoleCallUsage(callUsage),
    });
    const outcome: NarrativeValidationEntrypointResult["outcome"] =
      recorded.outcome === "discarded"
        ? "fenced"
        : recorded.outcome === "retry_scheduled"
          ? "retryable_failed"
          : "failed";
    return entrypointResult(
      request.draftRef,
      outcome,
      outcome === "fenced" ? (recorded.reason ?? failureCode) : failureCode,
      null,
      null,
      ledger,
      null,
      callUsage,
    );
  }
  if (committed.outcome === "fenced") {
    await input.dependencies.modelRoleCommandService.recordAttemptResult({
      userId: request.userId,
      generationCommandId,
      modelRunAttemptId,
      role: "narrative.validate",
      attemptNo: input.attemptNo,
      technicalRetriesUsed: input.technicalRetriesUsed,
      semanticRepairsUsed: 0,
      outcome: "failed",
      failureCode: "business_fence",
      currentSourceRevision: 0,
      expectedDataEpoch: input.expectedDataEpoch,
      now: input.dependencies.clock(),
      usage: normalizeModelRoleCallUsage(callUsage),
    });
    return entrypointResult(
      request.draftRef,
      "fenced",
      committed.reason,
      null,
      null,
      ledger,
      null,
      callUsage,
    );
  }
  const recorded = await input.dependencies.modelRoleCommandService.recordAttemptResult({
    userId: request.userId,
    generationCommandId,
    modelRunAttemptId,
    role: "narrative.validate",
    attemptNo: input.attemptNo,
    technicalRetriesUsed: input.technicalRetriesUsed,
    semanticRepairsUsed: 0,
    outcome: "succeeded",
    currentSourceRevision: 0,
    expectedDataEpoch: input.expectedDataEpoch,
    now: input.dependencies.clock(),
    usage: normalizeModelRoleCallUsage(callUsage),
  });
  if (recorded.outcome === "discarded") {
    return entrypointResult(
      request.draftRef,
      "fenced",
      recorded.reason ?? "already_settled",
      null,
      null,
      ledger,
      null,
      callUsage,
    );
  }
  return entrypointResult(
    request.draftRef,
    "completed",
    null,
    null,
    result.outcome,
    ledger,
    null,
    callUsage,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Prefix(value: string): string {
  return sha256(value).slice(0, 32);
}
// ---- Producer-facing read + maintenance -------------------------------------

/**
 * Producer read contract (issue AC-3). A producer may only publish (Bio) or
 * create a Memory Candidate (Reflection) after this returns `ok`;
 * `incomplete` is the typed "validator not finished" outcome that forbids
 * both. Advisory findings never excuse skipping the validator: without a
 * completed command the read stays `incomplete`.
 */
export async function readNarrativeValidationOutcome(input: Readonly<{
  repository: NarrativeValidationRepository;
  userId: NarrativeValidationRecord["userId"];
  artifactKind: NarrativeValidationRecord["artifactKind"];
  draftRef: string;
  now: Date;
}>): Promise<
  | Readonly<{ outcome: "ok"; result: NarrativeValidationResultRecord }>
  | Readonly<{ outcome: "incomplete" }>
  | Readonly<{ outcome: "content_expired" }>
  | Readonly<{ outcome: "not_found" }>
> {
  return input.repository.readResult({
    userId: input.userId,
    artifactKind: input.artifactKind,
    draftRef: input.draftRef,
    now: input.now,
  });
}

/**
 * Bounded maintenance pass: validation content for uncommitted drafts
 * expires after the frozen 7-day window (ADR-0130); the read path already
 * refuses expired content. Producers fold this into their maintenance
 * cadence.
 */
export async function runNarrativeValidationMaintenance(input: Readonly<{
  repository: NarrativeValidationRepository;
  now: Date;
  limit?: number;
}>): Promise<{ purged: number }> {
  const purged = await input.repository.purgeExpiredContent({
    now: input.now,
    limit: input.limit ?? 500,
  });
  return { purged };
}
