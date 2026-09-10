import type { MemoryCandidateProposal } from "../memory-claim/types";
import { dedupeFingerprint, candidateSemanticTarget } from "../memory-claim/admission";
import {
  MEMORY_ADMISSION_POLICY_VERSION,
  DEDUPE_FINGERPRINT_KEY_VERSION,
} from "../memory-claim/types";
import type {
  ReflectionBaselineEntry,
  ReflectionCandidateOutcome,
  ReflectionFrozenInput,
  ReflectionModelCandidateProposal,
  ReflectionModelStatement,
  ReflectionTier1RejectionCode,
  ReflectionVersionPlan,
} from "./types";
import {
  MAX_CANDIDATE_PROPOSALS_PER_VERSION,
  MAX_PROPOSITIONS_PER_STATEMENT,
  MAX_STATEMENTS_PER_VERSION,
} from "./types";

/**
 * Deterministic Tier-1 gate and Candidate planning for Reflection output
 * (issue #199, SPEC 5.2). All-or-nothing: one structural violation fails the
 * whole version to draft/failed and no Candidate is created. The gate never
 * consults model confidence and never rewrites the generator output
 * (Reflection v1 has no bounded semantic repair).
 */

const STATEMENT_KINDS: ReadonlySet<string> = new Set([
  "day_observation",
  "cross_day_theme",
  "change_observation",
]);
const PROPOSITION_KINDS: ReadonlySet<string> = new Set([
  "fact",
  "impression",
  "synthesis",
]);
const EPISTEMIC_RENDERINGS: ReadonlySet<string> = new Set([
  "confirmed",
  "inferred",
]);
const TEMPORAL_STATUSES: ReadonlySet<string> = new Set([
  "current",
  "ended",
  "unknown",
]);
const BOUNDARY_PRECISIONS: ReadonlySet<string> = new Set([
  "exact",
  "month",
  "year",
  "approximate",
  "unknown",
]);
const CANDIDATE_KINDS: ReadonlySet<string> = new Set([
  "objective",
  "impression",
]);
const CANDIDATE_BASES: ReadonlySet<string> = new Set([
  "directly_stated",
  "inferred",
]);

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * The Tier-1 gate over the raw model output against the frozen input.
 * Returns the persisted statement list on success, or the typed rejection.
 */
export function planReflectionVersion(input: Readonly<{
  frozen: ReflectionFrozenInput;
  output: {
    statements: readonly ReflectionModelStatement[];
    candidateProposals: readonly ReflectionModelCandidateProposal[];
  };
}>): ReflectionVersionPlan {
  const { frozen, output } = input;
  if (!output || !Array.isArray(output.statements) || !Array.isArray(output.candidateProposals)) {
    return {
      action: "fail_version",
      rejectionCode: "schema_invalid",
      detail: "statements and candidateProposals must be arrays.",
    };
  }
  if (output.statements.length > MAX_STATEMENTS_PER_VERSION) {
    return {
      action: "fail_version",
      rejectionCode: "statement_limit_exceeded",
      detail: `at most ${MAX_STATEMENTS_PER_VERSION} statements per version.`,
    };
  }
  const evidenceSessions = new Map<string, string>();
  for (const item of frozen.evidence) {
    evidenceSessions.set(item.evidenceItemId, item.dailySessionId);
  }
  const baselineClaimIds = new Set(frozen.baseline.map((entry) => entry.claimId));
  const statementKeys = new Set<string>();

  for (const statement of output.statements) {
    if (
      !statement ||
      typeof statement !== "object" ||
      !nonEmptyText(statement.statementKey) ||
      statementKeys.has(statement.statementKey) ||
      !nonEmptyText(statement.text) ||
      !STATEMENT_KINDS.has(String(statement.statementKind)) ||
      !Array.isArray(statement.propositions)
    ) {
      return {
        action: "fail_version",
        rejectionCode: "schema_invalid",
        detail: "statement envelope is invalid or duplicates a statement key.",
      };
    }
    statementKeys.add(statement.statementKey);
    const kind = statement.statementKind;
    if (frozen.scopeType === "daily_session" && kind !== "day_observation") {
      return {
        action: "fail_version",
        rejectionCode: "daily_scope_kind_invalid",
        detail: `daily scope allows only day_observation, got ${kind}.`,
      };
    }
    if (statement.propositions.length > MAX_PROPOSITIONS_PER_STATEMENT) {
      return {
        action: "fail_version",
        rejectionCode: "proposition_limit_exceeded",
        detail: `at most ${MAX_PROPOSITIONS_PER_STATEMENT} propositions per statement.`,
      };
    }
    const propositionKeys = new Set<string>();
    const supportSessions = new Set<string>();
    for (const proposition of statement.propositions) {
      if (
        !proposition ||
        typeof proposition !== "object" ||
        !nonEmptyText(proposition.propositionKey) ||
        propositionKeys.has(proposition.propositionKey) ||
        !nonEmptyText(proposition.normalizedProposition) ||
        !PROPOSITION_KINDS.has(String(proposition.propositionKind)) ||
        !EPISTEMIC_RENDERINGS.has(String(proposition.epistemicRendering))
      ) {
        return {
          action: "fail_version",
          rejectionCode: "schema_invalid",
          detail: "proposition envelope is invalid or duplicates a key.",
        };
      }
      propositionKeys.add(proposition.propositionKey);
      if (!stringArray(proposition.supportEvidenceItemIds)) {
        return {
          action: "fail_version",
          rejectionCode: "support_evidence_invalid",
          detail: "supportEvidenceItemIds must be a string array.",
        };
      }
      if (proposition.supportEvidenceItemIds.length === 0) {
        return {
          action: "fail_version",
          rejectionCode: "support_evidence_invalid",
          detail: "every proposition requires Evidence-only support.",
        };
      }
      for (const evidenceId of proposition.supportEvidenceItemIds) {
        const session = evidenceSessions.get(evidenceId);
        if (session === undefined) {
          return {
            action: "fail_version",
            rejectionCode: "support_evidence_invalid",
            detail: `support ${evidenceId} is outside the frozen Evidence manifest.`,
          };
        }
        supportSessions.add(session);
      }
      if (!stringArray(proposition.baselineClaimIds)) {
        return {
          action: "fail_version",
          rejectionCode: "baseline_claim_out_of_bounds",
          detail: "baselineClaimIds must be a string array.",
        };
      }
      for (const claimId of proposition.baselineClaimIds) {
        if (!baselineClaimIds.has(claimId)) {
          return {
            action: "fail_version",
            rejectionCode: "baseline_claim_out_of_bounds",
            detail: `baseline claim ${claimId} is outside the frozen baseline.`,
          };
        }
      }
      if (kind === "change_observation" && proposition.baselineClaimIds.length === 0) {
        return {
          action: "fail_version",
          rejectionCode: "baseline_claim_out_of_bounds",
          detail: "change_observation propositions list a baseline subset.",
        };
      }
    }
    if (
      (kind === "cross_day_theme" || kind === "change_observation") &&
      supportSessions.size < 2
    ) {
      return {
        action: "fail_version",
        rejectionCode: "cross_day_session_count",
        detail: `${kind} requires support from at least two distinct Daily Sessions.`,
      };
    }
  }

  if (output.candidateProposals.length > MAX_CANDIDATE_PROPOSALS_PER_VERSION) {
    return {
      action: "fail_version",
      rejectionCode: "candidate_limit_exceeded",
      detail: `at most ${MAX_CANDIDATE_PROPOSALS_PER_VERSION} candidates per version.`,
    };
  }

  return { action: "persist_draft", statements: [...output.statements] };
}

// ---- Candidate handoff planning ----------------------------------------------

export type PlannedReflectionCandidate = Readonly<{
  proposal: MemoryCandidateProposal;
  dedupeFingerprint: string;
}>;

export type PlannedCandidateOutcome =
  | Readonly<{
      outcome: "planned";
      candidate: PlannedReflectionCandidate;
    }>
  | Readonly<{ outcome: "skipped"; reasonCode: string }>;

/**
 * Plans one `propose_new` Candidate from the frozen input: registry gate,
 * self-Entity subject binding, Evidence-only basis, and the keyed dedupe
 * fingerprint inherited from the Memory admission pipeline. Terminal
 * candidates are fenced again at commit time.
 */
export function planReflectionCandidate(input: Readonly<{
  frozen: ReflectionFrozenInput;
  reflectionVersionId: string;
  proposalFromModel: ReflectionModelCandidateProposal;
  registry: {
    entryFor(predicateId: string): { predicateId: string } | null;
    registryVersion(): number;
  };
  selfEntityId: string;
  userId: string;
  generationCommandId: string | null;
  modelRunAttemptId: string | null;
  modelVersion: string | null;
  promptVersion: string | null;
  dedupeFingerprintSecret: string;
  now: Date;
}>): PlannedCandidateOutcome {
  const { proposalFromModel, registry } = input;
  if (
    !proposalFromModel ||
    typeof proposalFromModel !== "object" ||
    !CANDIDATE_KINDS.has(String(proposalFromModel.candidateKind)) ||
    !CANDIDATE_BASES.has(String(proposalFromModel.basis)) ||
    !TEMPORAL_STATUSES.has(String(proposalFromModel.temporal?.temporalStatus)) ||
    !BOUNDARY_PRECISIONS.has(
      String(proposalFromModel.temporal?.validFromPrecision),
    ) ||
    !BOUNDARY_PRECISIONS.has(String(proposalFromModel.temporal?.validToPrecision))
  ) {
    return { outcome: "skipped", reasonCode: "candidate_schema_invalid" };
  }
  const temporal = proposalFromModel.temporal;
  const evidenceIds = stringArray(proposalFromModel.evidenceItemIds)
    ? proposalFromModel.evidenceItemIds
    : [];
  if (evidenceIds.length === 0) {
    return { outcome: "skipped", reasonCode: "candidate_evidence_missing" };
  }
  const evidenceItemIds = new Set(
    input.frozen.evidence.map((item) => item.evidenceItemId),
  );
  if (
    evidenceIds.some(
      (id) => !evidenceItemIds.has(id as (typeof input.frozen.evidence)[number]["evidenceItemId"]),
    )
  ) {
    return { outcome: "skipped", reasonCode: "candidate_evidence_outside_window" };
  }
  const mapped =
    proposalFromModel.predicateId !== null &&
    registry.entryFor(proposalFromModel.predicateId) !== null;
  if (proposalFromModel.predicateId !== null && !mapped) {
    return { outcome: "skipped", reasonCode: "predicate_not_in_registry" };
  }
  if (
    proposalFromModel.predicateId === null &&
    !(proposalFromModel.proposedConcept ?? "").trim()
  ) {
    return { outcome: "skipped", reasonCode: "invalid_proposed_concept" };
  }

  const proposal: MemoryCandidateProposal = {
    userId: input.userId as MemoryCandidateProposal["userId"],
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
      temporalStatus: temporal.temporalStatus,
      validFrom: temporal.validFrom !== null ? new Date(temporal.validFrom) : null,
      validFromPrecision: temporal.validFromPrecision,
      validTo: temporal.validTo !== null ? new Date(temporal.validTo) : null,
      validToPrecision: temporal.validToPrecision,
    },
    evidenceItemIds: evidenceIds,
    qualifiers: [],
    lineage: {
      extractionPolicyVersion: MEMORY_ADMISSION_POLICY_VERSION,
      generationCommandId: input.generationCommandId,
      authoritativeModelAttemptId: input.modelRunAttemptId,
      modelVersion: input.modelVersion,
      promptVersion: input.promptVersion,
      sourceReflectionVersionId: input.reflectionVersionId,
    },
  };
  const fingerprint = dedupeFingerprint({
    secret: input.dedupeFingerprintSecret,
    userId: input.userId as Parameters<typeof dedupeFingerprint>[0]["userId"],
    semanticTarget: candidateSemanticTarget({
      resolutionStatus: proposal.resolution.status,
      predicateId:
        proposal.resolution.status === "mapped"
          ? proposal.resolution.predicateId
          : null,
      proposedConcept:
        proposal.resolution.status === "mapped"
          ? null
          : proposal.resolution.proposedConcept,
      proposedObjectValue:
        proposal.resolution.status === "mapped"
          ? proposal.resolution.typedValue
          : "",
      proposedScopeKey: proposal.scopeKey,
      subjectEntityId: proposal.subjectEntityId,
      objectEntityId: proposal.objectEntityId,
    }),
    evidenceRevisionIds: input.frozen.evidence
      .filter((item) => evidenceItemIds.has(item.evidenceItemId))
      .map((item) => item.revisionId),
    policyVersion: MEMORY_ADMISSION_POLICY_VERSION,
  });
  return {
    outcome: "planned",
    candidate: { proposal, dedupeFingerprint: fingerprint },
  };
}

export { DEDUPE_FINGERPRINT_KEY_VERSION };

export type { ReflectionCandidateOutcome };
