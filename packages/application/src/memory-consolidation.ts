import { asUserId, asWorkflowCommandId } from "@sayhear/domain";

import { assertWorkflowSafe } from "./journal-eligibility";
import {
  callWithRoleFallback,
  classifyMemoryRoleError,
  type MemoryRoleConfiguration,
  type MemoryRoleInvocationConfiguration,
} from "./fast-path-extraction";
import {
  MEMORY_ADMISSION_POLICY_VERSION,
  predicateReviewDeadline,
  type AdmissibleEvidence,
  type MemoryCandidateProposal,
  type RegistryEntryLookup,
} from "./memory-claim";
import type { UserId } from "@sayhear/domain";
import type { RecoveryGate } from "./recovery-gate";

/**
 * Slow-path consolidation (SPEC #107 "Two-speed pipeline", issue #114,
 * ADR-0115): daily and weekly consolidation read Evidence / EntityMention /
 * Candidate / current ClaimVersion / current registry directly (Reflection is
 * not a precondition) and route one `memory.consolidate` call per run. The
 * model proposes structured diffs only; the deterministic admission validator
 * (memory-claim/admission.ts planners) commits inside one fenced transaction —
 * model proposals never auto-become state. The candidate sweeper enforces the
 * deterministic deadlines (ADR-0048 30-day stale, ADR-0050 90-day stale,
 * ADR-0051 7-day terminal content purge) with no model call at all.
 */

export const MEMORY_CONSOLIDATION_POLICY_VERSION = "memory-consolidation:v1";

export type MemoryConsolidationKind = "daily" | "weekly" | "sweeper";

export type MemoryConsolidationRunStatus =
  | "consolidated"
  | "swept"
  | "retryable_failed"
  | "stale_source";

/** Diff vocabulary per architecture 12.3 — model output is advisory only. */
export type MemoryConsolidateDiffKind =
  | "propose_new"
  | "reinforce_existing"
  | "supersede_existing"
  | "contest_existing"
  | "mark_review_due"
  | "no_change";

export type MemoryConsolidateTemporalProposal = Readonly<{
  temporalStatus: "current" | "ended" | "unknown";
  validFrom: string | null;
  validFromPrecision: "exact" | "month" | "year" | "approximate" | "unknown";
  validTo: string | null;
  validToPrecision: "exact" | "month" | "year" | "approximate" | "unknown";
}>;

/**
 * A `propose_new` diff without a candidate id carries the full aggregate
 * proposal (cross-session impression aggregation, ADR-0039). With a candidate
 * id the proposal fields are ignored — the existing candidate is the proposal.
 */
export type MemoryConsolidateDiffProposal = Readonly<{
  basis: "directly_stated" | "inferred";
  candidateKind: "objective" | "impression";
  predicateId: string | null;
  proposedConcept: string | null;
  typedValue: string;
  scopeKey: string;
  temporal: MemoryConsolidateTemporalProposal;
  evidenceItemIds: readonly string[];
}>;

export type MemoryConsolidateDiff =
  | Readonly<{
      kind: "propose_new";
      candidateId: string | null;
      proposal: MemoryConsolidateDiffProposal | null;
      evidenceItemIds: readonly string[];
    }>
  | Readonly<{
      kind: "reinforce_existing" | "supersede_existing" | "contest_existing";
      candidateId: string;
      evidenceItemIds: readonly string[];
    }>
  | Readonly<{
      kind: "mark_review_due";
      claimId: string;
      candidateId: string | null;
      evidenceItemIds: readonly string[];
    }>
  | Readonly<{ kind: "no_change"; candidateId: string }>;

export type MemoryConsolidateResult = Readonly<{
  diffs: readonly MemoryConsolidateDiff[];
}>;

// ── Frozen model input (IDs and semantic fields only — no conversation text) ─

export type ConsolidationCandidateEvidenceView = Readonly<{
  evidenceItemId: string;
  dailySessionId: string;
  logicalDate: string;
}>;

export type ConsolidationCandidateView = Readonly<{
  candidateId: string;
  candidateKind: "objective" | "impression";
  basis: "directly_stated" | "inferred";
  predicateId: string | null;
  proposedConcept: string | null;
  typedValue: string;
  scopeKey: string;
  temporalStatus: "current" | "ended" | "unknown";
  status: string;
  evidence: readonly ConsolidationCandidateEvidenceView[];
}>;

export type ConsolidationClaimView = Readonly<{
  claimId: string;
  predicateId: string;
  kind: "objective" | "impression";
  status: string;
  typedValue: string;
  scopeKey: string;
}>;

export type MemoryConsolidateModelInput = Readonly<{
  mode: "daily" | "weekly";
  anchorDate: string;
  registryVersion: number;
  candidates: readonly ConsolidationCandidateView[];
  claims: readonly ConsolidationClaimView[];
}>;

export type MemoryConsolidateProvider = Readonly<{
  role: "memory.consolidate";
  consolidate(
    input: MemoryConsolidateModelInput,
    configuration: MemoryRoleInvocationConfiguration,
  ): Promise<MemoryConsolidateResult>;
}>;

// ── Command context ─────────────────────────────────────────────────────────

export type MemoryConsolidationCommandContext = Readonly<{
  workflowCommandId: string;
  userId: string;
  kind: MemoryConsolidationKind;
  anchorDate: string;
  policyVersion: string;
  expectedDataEpoch: number;
  /** Null for the sweeper — it never calls the model. */
  modelInput: MemoryConsolidateModelInput | null;
}>;

// ── Shape validation (pure; throws on structural violations) ────────────────

export class InvalidMemoryConsolidateProposalError extends Error {
  public constructor(detail: string) {
    super(`memory.consolidate returned an invalid proposal: ${detail}`);
    this.name = "InvalidMemoryConsolidateProposalError";
  }
}

const TEMPORAL_STATUSES = new Set(["current", "ended", "unknown"]);
const BOUNDARY_PRECISIONS = new Set([
  "exact",
  "month",
  "year",
  "approximate",
  "unknown",
]);

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function validateTemporalProposal(
  temporal: unknown,
): asserts temporal is MemoryConsolidateTemporalProposal {
  if (typeof temporal !== "object" || temporal === null) {
    throw new InvalidMemoryConsolidateProposalError("temporal must be an object.");
  }
  const record = temporal as Record<string, unknown>;
  if (
    !TEMPORAL_STATUSES.has(String(record.temporalStatus)) ||
    (record.validFrom !== null && typeof record.validFrom !== "string") ||
    (record.validTo !== null && typeof record.validTo !== "string") ||
    !BOUNDARY_PRECISIONS.has(String(record.validFromPrecision)) ||
    !BOUNDARY_PRECISIONS.has(String(record.validToPrecision))
  ) {
    throw new InvalidMemoryConsolidateProposalError("invalid temporal bounds.");
  }
}

/**
 * Structural validation of one consolidation result against the frozen input.
 * Semantic eligibility (candidate ownership, evidence session dates) is NOT
 * decided here — the transactional commit re-validates every reference before
 * anything writes, so a proposal the model fabricated simply lands as a
 * skipped diff with a recorded reason.
 */
export function validateConsolidateResult(
  result: MemoryConsolidateResult,
  input: MemoryConsolidateModelInput,
): void {
  if (typeof result !== "object" || result === null || !Array.isArray(result.diffs)) {
    throw new InvalidMemoryConsolidateProposalError("result.diffs must be an array.");
  }
  if (result.diffs.length > 500) {
    throw new InvalidMemoryConsolidateProposalError("too many diffs.");
  }
  const knownCandidates = new Set(
    input.candidates.map((candidate) => candidate.candidateId),
  );
  const knownClaims = new Set(input.claims.map((claim) => claim.claimId));
  const knownEvidence = new Set(
    input.candidates.flatMap((candidate) =>
      candidate.evidence.map((item) => item.evidenceItemId),
    ),
  );
  for (const diff of result.diffs) {
    if (typeof diff !== "object" || diff === null) {
      throw new InvalidMemoryConsolidateProposalError("diff must be an object.");
    }
    if (
      ![
        "propose_new",
        "reinforce_existing",
        "supersede_existing",
        "contest_existing",
        "mark_review_due",
        "no_change",
      ].includes(diff.kind as string)
    ) {
      throw new InvalidMemoryConsolidateProposalError(`unknown diff kind ${String(diff.kind)}.`);
    }
    const requiresCandidateId =
      diff.kind === "reinforce_existing" ||
      diff.kind === "supersede_existing" ||
      diff.kind === "contest_existing" ||
      diff.kind === "no_change";
    if (requiresCandidateId && typeof diff.candidateId !== "string") {
      throw new InvalidMemoryConsolidateProposalError(
        `${String(diff.kind)} requires a candidateId.`,
      );
    }
    if (
      !requiresCandidateId &&
      diff.kind !== "mark_review_due" &&
      typeof diff.candidateId !== "string" &&
      diff.candidateId !== null
    ) {
      throw new InvalidMemoryConsolidateProposalError("candidateId must be a string or null.");
    }
    if (
      diff.candidateId !== null &&
      diff.candidateId !== undefined &&
      !knownCandidates.has(diff.candidateId)
    ) {
      throw new InvalidMemoryConsolidateProposalError(
        "diff references a candidate outside the frozen input.",
      );
    }
    if (diff.kind === "mark_review_due") {
      if (typeof diff.claimId !== "string" || !knownClaims.has(diff.claimId)) {
        throw new InvalidMemoryConsolidateProposalError(
          "mark_review_due references a claim outside the frozen input.",
        );
      }
    }
    if (diff.kind === "no_change") {
      continue;
    }
    let evidenceIds: readonly string[];
    // Providers omit an inapplicable `proposal` instead of writing null
    // (observed with DeepSeek); `!== null` alone misreads the omission as a
    // present proposal and crashes on the property read below.
    if (
      diff.kind === "propose_new" &&
      diff.proposal !== null &&
      diff.proposal !== undefined
    ) {
      evidenceIds = diff.proposal.evidenceItemIds;
    } else {
      evidenceIds = diff.evidenceItemIds;
    }
    if (!isStringArray(evidenceIds) || evidenceIds.length > 200) {
      throw new InvalidMemoryConsolidateProposalError("invalid evidence id list.");
    }
    for (const evidenceId of evidenceIds) {
      if (!knownEvidence.has(evidenceId)) {
        throw new InvalidMemoryConsolidateProposalError(
          "diff cites evidence outside the frozen input.",
        );
      }
    }
    if (
      diff.kind === "propose_new" &&
      (diff.candidateId === null || diff.candidateId === undefined)
    ) {
      const proposal = diff.proposal;
      if (proposal === null || proposal === undefined) {
        throw new InvalidMemoryConsolidateProposalError(
          "propose_new without a candidate requires a full proposal.",
        );
      }
      if (
        !["directly_stated", "inferred"].includes(proposal.basis) ||
        !["objective", "impression"].includes(proposal.candidateKind)
      ) {
        throw new InvalidMemoryConsolidateProposalError("invalid proposal basis or kind.");
      }
      if (proposal.predicateId !== null && typeof proposal.predicateId !== "string") {
        throw new InvalidMemoryConsolidateProposalError("invalid predicateId.");
      }
      if (proposal.proposedConcept !== null && typeof proposal.proposedConcept !== "string") {
        throw new InvalidMemoryConsolidateProposalError("invalid proposedConcept.");
      }
      if (
        (proposal.predicateId === null) === (proposal.proposedConcept === null)
      ) {
        throw new InvalidMemoryConsolidateProposalError(
          "exactly one of predicateId / proposedConcept is required.",
        );
      }
      if (
        typeof proposal.typedValue !== "string" ||
        !proposal.typedValue.trim() ||
        proposal.typedValue.length > 2_000
      ) {
        throw new InvalidMemoryConsolidateProposalError("invalid typedValue.");
      }
      if (typeof proposal.scopeKey !== "string" || proposal.scopeKey.length > 200) {
        throw new InvalidMemoryConsolidateProposalError("invalid scopeKey.");
      }
      validateTemporalProposal(proposal.temporal);
    }
  }
}

// ── Anchor-date helpers (pure; UTC date math on YYYY-MM-DD strings) ────────

/** workflow_commands.source_revision encoding of an anchor date (YYYYMMDD). */
export function dateOrdinal(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid anchor date ${date}.`);
  }
  return Number(date.replaceAll("-", ""));
}

export function addDaysToDateString(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** ISO week start (Monday) of an anchor date. */
export function weekStartDate(date: string): string {
  const base = new Date(`${date}T00:00:00.000Z`);
  const offsetToMonday = (base.getUTCDay() + 6) % 7;
  return addDaysToDateString(date, -offsetToMonday);
}

/** The last date whose evidence a run of this kind may consider. */
export function evidenceCutoff(kind: MemoryConsolidationKind, anchorDate: string): string {
  // Weekly runs anchor on the week's Monday and cover the full ISO week.
  return kind === "weekly" ? addDaysToDateString(anchorDate, 6) : anchorDate;
}


// ── Aggregate proposal planning (pure) ──────────────────────────────────────

export type AggregateProposalPlan =
  | Readonly<{
      outcome: "planned";
      proposal: MemoryCandidateProposal;
      status: "proposed" | "needs_predicate_review";
      reviewDueAt: Date | null;
    }>
  | Readonly<{ outcome: "skip"; reasonCode: string }>;

/**
 * Deterministic planner for a model `propose_new` aggregate (architecture
 * 12.1 slow path): the model names the concept and the evidence; this layer
 * owns the subject binding (Self Entity for non-relationship aggregates),
 * the registry gate, the unmapped routing, and the review deadline. A
 * predicate id the registry does not publish, an empty proposed concept, or
 * a relationship target fails closed to a recorded skip — never to a
 * near-contentless review candidate.
 */
export function planAggregateProposal(input: {
  proposalFromModel: MemoryConsolidateDiffProposal;
  registry: RegistryEntryLookup;
  selfEntityId: string;
  eligibleEvidence: readonly AdmissibleEvidence[];
  lineage: Readonly<{
    modelAttemptId: string | null;
    modelVersion: string | null;
    promptVersion: string | null;
  }>;
  userId: UserId;
  now: Date;
}): AggregateProposalPlan {
  const { proposalFromModel, registry } = input;
  const entry =
    proposalFromModel.predicateId !== null
      ? registry.entryFor(proposalFromModel.predicateId)
      : null;
  if (proposalFromModel.predicateId !== null && !entry) {
    return { outcome: "skip", reasonCode: "predicate_not_in_registry" };
  }
  if (
    proposalFromModel.predicateId === null &&
    !(proposalFromModel.proposedConcept ?? "").trim()
  ) {
    return { outcome: "skip", reasonCode: "invalid_proposed_concept" };
  }
  if (entry && entry.relationshipSemantics !== null) {
    return {
      outcome: "skip",
      reasonCode: "relationship_aggregate_requires_candidate",
    };
  }
  if (input.eligibleEvidence.length === 0) {
    return { outcome: "skip", reasonCode: "evidence_outside_anchor_or_ineligible" };
  }
  const mapped = proposalFromModel.predicateId !== null && entry !== null;
  return {
    outcome: "planned",
    proposal: {
      userId: input.userId,
      candidateKind: proposalFromModel.candidateKind,
      basis: proposalFromModel.basis,
      resolution: mapped
        ? {
            status: "mapped",
            predicateId: proposalFromModel.predicateId!,
            registryVersion: registry.registryVersion(),
            typedValue: proposalFromModel.typedValue,
            mappingConfidence: null,
          }
        : {
            status: "unmapped",
            proposedConcept: proposalFromModel.proposedConcept ?? "",
          },
      subjectEntityId: input.selfEntityId,
      subjectEntityMentionId: null,
      objectEntityId: null,
      objectEntityMentionId: null,
      scopeKey: proposalFromModel.scopeKey,
      temporal: {
        temporalStatus: proposalFromModel.temporal.temporalStatus,
        validFrom:
          proposalFromModel.temporal.validFrom !== null
            ? new Date(proposalFromModel.temporal.validFrom)
            : null,
        validFromPrecision: proposalFromModel.temporal.validFromPrecision,
        validTo:
          proposalFromModel.temporal.validTo !== null
            ? new Date(proposalFromModel.temporal.validTo)
            : null,
        validToPrecision: proposalFromModel.temporal.validToPrecision,
      },
      evidenceItemIds: input.eligibleEvidence.map((item) => item.evidenceItemId),
      qualifiers: [],
      lineage: {
        extractionPolicyVersion: MEMORY_ADMISSION_POLICY_VERSION,
        generationCommandId: input.lineage.modelAttemptId,
        authoritativeModelAttemptId: input.lineage.modelAttemptId,
        modelVersion: input.lineage.modelVersion,
        promptVersion: input.lineage.promptVersion,
        sourceReflectionVersionId: null,
      },
    },
    status: mapped ? "proposed" : "needs_predicate_review",
    reviewDueAt: mapped ? null : predicateReviewDeadline(input.now),
  };
}

// ── Repository port ─────────────────────────────────────────────────────────

export type ConsolidationDiffOutcomeRecord = Readonly<{
  diffIndex: number;
  diffKind: string;
  outcome: string;
  reasonCode: string;
  memoryCandidateId: string | null;
  memoryClaimId: string | null;
}>;

export type ConsolidationRunCounters = Readonly<{
  diffCount: number;
  promotedCount: number;
  reinforcedCount: number;
  contestedCount: number;
  rejectedCount: number;
  skippedCount: number;
  dormantCount: number;
  staledCount: number;
  purgedCount: number;
}>;

export type CommitConsolidationRunResult =
  | Readonly<{
      outcome: "consolidated" | "swept";
      counters: ConsolidationRunCounters;
      diffOutcomes: readonly ConsolidationDiffOutcomeRecord[];
    }>
  | Readonly<{ outcome: "already_consolidated" }>
  | Readonly<{ outcome: "stale_source" }>;

export type QueueDueConsolidationResult = Readonly<{
  daily: number;
  weekly: number;
  sweeper: number;
  reArmed: number;
}>;

export type MemoryConsolidationRepository = Readonly<{
  loadPolicy(policyVersion: string): Promise<{ version: string } | null>;
  /**
   * The cron-driven scheduler surface: create the idempotent due commands
   * (daily for elapsed session dates, weekly for fully elapsed weeks with
   * memory state, sweeper when deadline-bound rows exist) plus fresh outbox
   * events, and re-arm retryable_failed runs. Cron only triggers the scan;
   * due-ness itself is computed in the domain layer from the clock and the
   * user's timezone (architecture 11.1).
   */
  queueDueCommands(input: {
    now: Date;
    policyVersion: string;
  }): Promise<QueueDueConsolidationResult>;
  readCommand(input: {
    workflowCommandId: string;
    policyVersion: string;
  }): Promise<
    | Readonly<{ outcome: "not_found" }>
    | Readonly<{ outcome: "stale_source" }>
    | Readonly<{
        outcome: "ready";
        command: MemoryConsolidationCommandContext;
        existingRunStatus: MemoryConsolidationRunStatus | null;
      }>
  >;
  /**
   * The authoritative per-run commit: one transaction behind the owner epoch
   * fence that re-validates every diff reference, executes the deterministic
   * admission plans, runs the weekly dormancy pass and the sweeper passes,
   * and writes the run row that anchors idempotency. A completed run short-
   * circuits before any write.
   */
  commitConsolidationRun(input: {
    command: Readonly<{
      workflowCommandId: string;
      userId: string;
      kind: MemoryConsolidationKind;
      anchorDate: string;
      policyVersion: string;
      expectedDataEpoch: number;
    }>;
    diffs: readonly MemoryConsolidateDiff[];
    registry: RegistryEntryLookup;
    dedupeFingerprintSecret: string;
    lineage: Readonly<{
      modelAttemptId: string | null;
      consolidateConfigVersion: string | null;
      consolidateModelVersion: string | null;
      consolidatePromptVersion: string | null;
      roleFallbackUsed: boolean;
    }>;
    now: Date;
  }): Promise<CommitConsolidationRunResult>;
  recordRunFailure(input: {
    command: Readonly<{
      workflowCommandId: string;
      userId: string;
      kind: MemoryConsolidationKind;
      anchorDate: string;
      policyVersion: string;
      expectedDataEpoch: number;
    }>;
    lineage: Readonly<{
      modelAttemptId: string;
      consolidateConfigVersion: string;
      consolidateModelVersion: string;
      consolidatePromptVersion: string;
      roleFallbackUsed: boolean;
    }>;
    errorCode: string;
    now: Date;
  }): Promise<void>;
}>;

// ── Entrypoint ──────────────────────────────────────────────────────────────

export type MemoryConsolidationEntrypointResult = Readonly<{
  outcome:
    | "consolidated"
    | "swept"
    | "already_consolidated"
    | "stale_source"
    | "retryable_failed";
  workflowReceiptId: string;
  counters: ConsolidationRunCounters | null;
}>;

export type MemoryConsolidationEntrypointDependencies = Readonly<{
  clock: () => Date;
  repository: MemoryConsolidationRepository;
  memoryConsolidate: MemoryConsolidateProvider;
  memoryConsolidateConfiguration: MemoryRoleConfiguration;
  registry: RegistryEntryLookup;
  policy: Readonly<{ version: string }>;
  dedupeFingerprintSecret: string;
  recoveryGate?: RecoveryGate;
  workflowReceiptId: string;
}>;

function sanitizeConsolidationErrorCode(error: unknown): string {
  if (error instanceof InvalidMemoryConsolidateProposalError) {
    return "memory_consolidate_invalid_proposal";
  }
  return classifyMemoryRoleError(error);
}

/**
 * Run one consolidation command (daily / weekly / sweeper) through the real
 * pipeline: read the frozen command and model input, make at most one
 * `memory.consolidate` call per daily / weekly run (never for the sweeper),
 * shape-validate the diffs, and hand everything to the deterministic
 * transactional commit. Idempotent: a completed run never re-executes.
 */
export async function runMemoryConsolidation(input: {
  dependencies: MemoryConsolidationEntrypointDependencies;
  command: Readonly<{ workflowCommandId: string; policyVersion: string }>;
}): Promise<MemoryConsolidationEntrypointResult> {
  const { dependencies } = input;
  asWorkflowCommandId(input.command.workflowCommandId);
  assertWorkflowSafe(
    {
      workflowCommandId: input.command.workflowCommandId,
      subjectType: "app_user",
      policyVersion: input.command.policyVersion,
    },
    "command",
  );
  if (input.command.policyVersion !== dependencies.policy.version) {
    throw new Error(
      "Memory consolidation command policy does not match runtime policy.",
    );
  }

  const read = await dependencies.repository.readCommand({
    workflowCommandId: input.command.workflowCommandId,
    policyVersion: dependencies.policy.version,
  });
  if (read.outcome === "not_found") {
    throw new Error("Memory consolidation command could not be found.");
  }
  if (read.outcome === "stale_source") {
    return {
      outcome: "stale_source",
      workflowReceiptId: dependencies.workflowReceiptId,
      counters: null,
    };
  }
  if (
    read.existingRunStatus === "consolidated" ||
    read.existingRunStatus === "swept" ||
    read.existingRunStatus === "stale_source"
  ) {
    return {
      outcome: "already_consolidated",
      workflowReceiptId: dependencies.workflowReceiptId,
      counters: null,
    };
  }
  const command = read.command;
  await dependencies.recoveryGate?.requireOpen(asUserId(command.userId));

  const lineage = {
    modelAttemptId: `${command.workflowCommandId}:memory-consolidate`,
    consolidateConfigVersion:
      dependencies.memoryConsolidateConfiguration.configVersion,
    consolidateModelVersion: dependencies.memoryConsolidateConfiguration.modelVersion,
    consolidatePromptVersion: dependencies.memoryConsolidateConfiguration.promptVersion,
    roleFallbackUsed: false,
  };

  let diffs: readonly MemoryConsolidateDiff[] = [];
  if (
    (command.kind === "daily" || command.kind === "weekly") &&
    command.modelInput !== null
  ) {
    const hasModelWork =
      command.modelInput.candidates.length > 0 ||
      command.modelInput.claims.some(
        (claim) => claim.kind === "impression" && claim.status === "active",
      );
    if (hasModelWork) {
      const modelInput = command.modelInput;
      try {
        const attempted = await callWithRoleFallback(
          (invocation) =>
            dependencies.memoryConsolidate.consolidate(modelInput, invocation),
          dependencies.memoryConsolidateConfiguration,
          async () => {
            await dependencies.recoveryGate?.requireOpen(asUserId(command.userId));
          },
        );
        validateConsolidateResult(attempted.result, modelInput);
        diffs = attempted.result.diffs;
        lineage.roleFallbackUsed = attempted.roleFallbackUsed;
      } catch (error) {
        await dependencies.repository.recordRunFailure({
          command: {
            workflowCommandId: command.workflowCommandId,
            userId: command.userId,
            kind: command.kind,
            anchorDate: command.anchorDate,
            policyVersion: command.policyVersion,
            expectedDataEpoch: command.expectedDataEpoch,
          },
          lineage,
          errorCode: sanitizeConsolidationErrorCode(error),
          now: dependencies.clock(),
        });
        return {
          outcome: "retryable_failed",
          workflowReceiptId: dependencies.workflowReceiptId,
          counters: null,
        };
      }
    }
  }

  const commit = await dependencies.repository.commitConsolidationRun({
    command: {
      workflowCommandId: command.workflowCommandId,
      userId: command.userId,
      kind: command.kind,
      anchorDate: command.anchorDate,
      policyVersion: command.policyVersion,
      expectedDataEpoch: command.expectedDataEpoch,
    },
    diffs,
    registry: dependencies.registry,
    dedupeFingerprintSecret: dependencies.dedupeFingerprintSecret,
    lineage,
    now: dependencies.clock(),
  });
  const result: MemoryConsolidationEntrypointResult = commit.outcome ===
    "already_consolidated" || commit.outcome === "stale_source"
    ? {
        outcome: commit.outcome,
        workflowReceiptId: dependencies.workflowReceiptId,
        counters: null,
      }
    : {
        outcome: commit.outcome,
        workflowReceiptId: dependencies.workflowReceiptId,
        counters: commit.counters,
      };
  assertWorkflowSafe(
    {
      outcome: result.outcome,
      status: result.outcome,
      workflowReceiptId: result.workflowReceiptId,
    },
    "result",
  );
  return result;
}

// ── Scan service (cron surface) ─────────────────────────────────────────────

export type MemoryConsolidationScanService = Readonly<{
  scanPending(): Promise<QueueDueConsolidationResult>;
  resolvePolicyForStep(): Promise<Readonly<{ policyVersion: string }>>;
}>;

export function createMemoryConsolidationScanService(dependencies: {
  clock: () => Date;
  policyVersion: string;
  repository: MemoryConsolidationRepository;
  /** Runtime write switch: a disabled scan enqueues nothing. */
  enabled?: boolean;
}): MemoryConsolidationScanService {
  const enabled = dependencies.enabled ?? true;
  return {
    async scanPending() {
      if (!enabled) {
        return { daily: 0, weekly: 0, sweeper: 0, reArmed: 0 };
      }
      return dependencies.repository.queueDueCommands({
        now: dependencies.clock(),
        policyVersion: dependencies.policyVersion,
      });
    },
    async resolvePolicyForStep() {
      const policy = await dependencies.repository.loadPolicy(
        dependencies.policyVersion,
      );
      if (!policy) {
        throw new Error(
          "Memory consolidation policy is unavailable or has drifted.",
        );
      }
      return { policyVersion: policy.version };
    },
  };
}
