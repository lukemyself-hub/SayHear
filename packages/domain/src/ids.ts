declare const userIdBrand: unique symbol;
declare const dailySessionIdBrand: unique symbol;
declare const interactionTurnIdBrand: unique symbol;
declare const conversationEventIdBrand: unique symbol;
declare const conversationEventRevisionIdBrand: unique symbol;
declare const generationCommandIdBrand: unique symbol;
declare const modelRunAttemptIdBrand: unique symbol;
declare const compiledContextIdBrand: unique symbol;
declare const inactivityEvaluationIdBrand: unique symbol;
declare const workflowCommandIdBrand: unique symbol;
declare const outboxEventIdBrand: unique symbol;
declare const evidenceItemIdBrand: unique symbol;
declare const entityIdBrand: unique symbol;
declare const bioIdBrand: unique symbol;
declare const bioVersionIdBrand: unique symbol;
declare const bioStatementIdBrand: unique symbol;
declare const bioAtomicPropositionIdBrand: unique symbol;
declare const bioCoverageUnitIdBrand: unique symbol;
declare const predicateChangeProposalIdBrand: unique symbol;
declare const predicateChangeProposalVersionIdBrand: unique symbol;
declare const predicateChangeProposalCandidateLinkIdBrand: unique symbol;
declare const candidateReviewAuditIdBrand: unique symbol;

export type UserId = string & { readonly [userIdBrand]: "UserId" };
export type DailySessionId = string & {
  readonly [dailySessionIdBrand]: "DailySessionId";
};
export type InteractionTurnId = string & {
  readonly [interactionTurnIdBrand]: "InteractionTurnId";
};
export type ConversationEventId = string & {
  readonly [conversationEventIdBrand]: "ConversationEventId";
};
export type ConversationEventRevisionId = string & {
  readonly [conversationEventRevisionIdBrand]: "ConversationEventRevisionId";
};
export type GenerationCommandId = string & {
  readonly [generationCommandIdBrand]: "GenerationCommandId";
};
export type ModelRunAttemptId = string & {
  readonly [modelRunAttemptIdBrand]: "ModelRunAttemptId";
};
export type CompiledContextId = string & {
  readonly [compiledContextIdBrand]: "CompiledContextId";
};
export type InactivityEvaluationId = string & {
  readonly [inactivityEvaluationIdBrand]: "InactivityEvaluationId";
};
export type WorkflowCommandId = string & {
  readonly [workflowCommandIdBrand]: "WorkflowCommandId";
};
export type OutboxEventId = string & {
  readonly [outboxEventIdBrand]: "OutboxEventId";
};
export type EvidenceItemId = string & {
  readonly [evidenceItemIdBrand]: "EvidenceItemId";
};
export type EntityId = string & {
  readonly [entityIdBrand]: "EntityId";
};
export type BioId = string & { readonly [bioIdBrand]: "BioId" };
export type BioVersionId = string & {
  readonly [bioVersionIdBrand]: "BioVersionId";
};
export type BioStatementId = string & {
  readonly [bioStatementIdBrand]: "BioStatementId";
};
export type BioAtomicPropositionId = string & {
  readonly [bioAtomicPropositionIdBrand]: "BioAtomicPropositionId";
};
export type BioCoverageUnitId = string & {
  readonly [bioCoverageUnitIdBrand]: "BioCoverageUnitId";
};
export type PredicateChangeProposalId = string & {
  readonly [predicateChangeProposalIdBrand]: "PredicateChangeProposalId";
};
export type PredicateChangeProposalVersionId = string & {
  readonly [predicateChangeProposalVersionIdBrand]: "PredicateChangeProposalVersionId";
};
export type PredicateChangeProposalCandidateLinkId = string & {
  readonly [predicateChangeProposalCandidateLinkIdBrand]: "PredicateChangeProposalCandidateLinkId";
};
export type CandidateReviewAuditId = string & {
  readonly [candidateReviewAuditIdBrand]: "CandidateReviewAuditId";
};
export type MemoryClaimId = string & {
  readonly [memoryClaimIdBrand]: "MemoryClaimId";
};
export type MemoryClaimVersionId = string & {
  readonly [memoryClaimVersionIdBrand]: "MemoryClaimVersionId";
};
export type ClaimEvidenceLinkId = string & {
  readonly [claimEvidenceLinkIdBrand]: "ClaimEvidenceLinkId";
};
export type MemoryCandidateId = string & {
  readonly [memoryCandidateIdBrand]: "MemoryCandidateId";
};
export type MemoryCandidateEvidenceLinkId = string & {
  readonly [memoryCandidateEvidenceLinkIdBrand]: "MemoryCandidateEvidenceLinkId";
};
export type MemoryForgetRequestId = string & {
  readonly [memoryForgetRequestIdBrand]: "MemoryForgetRequestId";
};
export type MemoryForgetEvidenceExclusionId = string & {
  readonly [memoryForgetEvidenceExclusionIdBrand]: "MemoryForgetEvidenceExclusionId";
};
export type MemoryForgetReversalId = string & {
  readonly [memoryForgetReversalIdBrand]: "MemoryForgetReversalId";
};
export type MemoryClaimVersionQualifierId = string & {
  readonly [memoryClaimVersionQualifierIdBrand]: "MemoryClaimVersionQualifierId";
};
export type RelationshipResolverHintId = string & {
  readonly [relationshipResolverHintIdBrand]: "RelationshipResolverHintId";
};
export type EpisodeId = string & {
  readonly [episodeIdBrand]: "EpisodeId";
};
export type EpisodeVersionId = string & {
  readonly [episodeVersionIdBrand]: "EpisodeVersionId";
};
export type EpisodeCandidateId = string & {
  readonly [episodeCandidateIdBrand]: "EpisodeCandidateId";
};
declare const narrativeValidatorRequestIdBrand: unique symbol;
declare const narrativeValidatorResultIdBrand: unique symbol;

export type NarrativeValidatorRequestId = string & {
  readonly [narrativeValidatorRequestIdBrand]: "NarrativeValidatorRequestId";
};
export type NarrativeValidatorResultId = string & {
  readonly [narrativeValidatorResultIdBrand]: "NarrativeValidatorResultId";
};
declare const episodeIdBrand: unique symbol;
declare const episodeVersionIdBrand: unique symbol;
declare const episodeCandidateIdBrand: unique symbol;
declare const reflectionIdBrand: unique symbol;
declare const reflectionVersionIdBrand: unique symbol;
declare const reflectionStatementIdBrand: unique symbol;
declare const reflectionAtomicPropositionIdBrand: unique symbol;

export type ReflectionId = string & {
  readonly [reflectionIdBrand]: "ReflectionId";
};
export type ReflectionVersionId = string & {
  readonly [reflectionVersionIdBrand]: "ReflectionVersionId";
};
export type ReflectionStatementId = string & {
  readonly [reflectionStatementIdBrand]: "ReflectionStatementId";
};
export type ReflectionAtomicPropositionId = string & {
  readonly [reflectionAtomicPropositionIdBrand]: "ReflectionAtomicPropositionId";
};
declare const memoryClaimIdBrand: unique symbol;
declare const memoryClaimVersionIdBrand: unique symbol;
declare const claimEvidenceLinkIdBrand: unique symbol;
declare const memoryCandidateIdBrand: unique symbol;
declare const memoryCandidateEvidenceLinkIdBrand: unique symbol;
declare const memoryForgetRequestIdBrand: unique symbol;
declare const memoryForgetEvidenceExclusionIdBrand: unique symbol;
declare const memoryForgetReversalIdBrand: unique symbol;
declare const memoryClaimVersionQualifierIdBrand: unique symbol;
declare const relationshipResolverHintIdBrand: unique symbol;

const uuidV7Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function asUserId(value: string): UserId {
  return asOpaqueUuidV7(value, "UserId") as UserId;
}

export function asDailySessionId(value: string): DailySessionId {
  return asOpaqueUuidV7(value, "DailySessionId") as DailySessionId;
}

export function asInteractionTurnId(value: string): InteractionTurnId {
  return asOpaqueUuidV7(value, "InteractionTurnId") as InteractionTurnId;
}

export function asConversationEventId(value: string): ConversationEventId {
  return asOpaqueUuidV7(value, "ConversationEventId") as ConversationEventId;
}

export function asConversationEventRevisionId(
  value: string,
): ConversationEventRevisionId {
  return asOpaqueUuidV7(
    value,
    "ConversationEventRevisionId",
  ) as ConversationEventRevisionId;
}

export function asGenerationCommandId(value: string): GenerationCommandId {
  return asOpaqueUuidV7(value, "GenerationCommandId") as GenerationCommandId;
}

export function asModelRunAttemptId(value: string): ModelRunAttemptId {
  return asOpaqueUuidV7(value, "ModelRunAttemptId") as ModelRunAttemptId;
}

export function asCompiledContextId(value: string): CompiledContextId {
  return asOpaqueUuidV7(value, "CompiledContextId") as CompiledContextId;
}

export function asInactivityEvaluationId(
  value: string,
): InactivityEvaluationId {
  return asOpaqueUuidV7(
    value,
    "InactivityEvaluationId",
  ) as InactivityEvaluationId;
}

export function asWorkflowCommandId(value: string): WorkflowCommandId {
  return asOpaqueUuidV7(value, "WorkflowCommandId") as WorkflowCommandId;
}

export function asOutboxEventId(value: string): OutboxEventId {
  return asOpaqueUuidV7(value, "OutboxEventId") as OutboxEventId;
}

export function asEvidenceItemId(value: string): EvidenceItemId {
  return asOpaqueUuidV7(value, "EvidenceItemId") as EvidenceItemId;
}

export function asEntityId(value: string): EntityId {
  return asOpaqueUuidV7(value, "EntityId") as EntityId;
}

export function asBioId(value: string): BioId {
  return asOpaqueUuidV7(value, "BioId") as BioId;
}

export function asBioVersionId(value: string): BioVersionId {
  return asOpaqueUuidV7(value, "BioVersionId") as BioVersionId;
}

export function asBioStatementId(value: string): BioStatementId {
  return asOpaqueUuidV7(value, "BioStatementId") as BioStatementId;
}

export function asBioAtomicPropositionId(value: string): BioAtomicPropositionId {
  return asOpaqueUuidV7(
    value,
    "BioAtomicPropositionId",
  ) as BioAtomicPropositionId;
}

export function asBioCoverageUnitId(value: string): BioCoverageUnitId {
  return asOpaqueUuidV7(value, "BioCoverageUnitId") as BioCoverageUnitId;
}

export function asMemoryClaimId(value: string): MemoryClaimId {
  return asOpaqueUuidV7(value, "MemoryClaimId") as MemoryClaimId;
}

export function asMemoryClaimVersionId(value: string): MemoryClaimVersionId {
  return asOpaqueUuidV7(value, "MemoryClaimVersionId") as MemoryClaimVersionId;
}

export function asClaimEvidenceLinkId(value: string): ClaimEvidenceLinkId {
  return asOpaqueUuidV7(value, "ClaimEvidenceLinkId") as ClaimEvidenceLinkId;
}

export function asMemoryCandidateId(value: string): MemoryCandidateId {
  return asOpaqueUuidV7(value, "MemoryCandidateId") as MemoryCandidateId;
}

export function asMemoryCandidateEvidenceLinkId(
  value: string,
): MemoryCandidateEvidenceLinkId {
  return asOpaqueUuidV7(
    value,
    "MemoryCandidateEvidenceLinkId",
  ) as MemoryCandidateEvidenceLinkId;
}

export function asMemoryForgetRequestId(value: string): MemoryForgetRequestId {
  return asOpaqueUuidV7(value, "MemoryForgetRequestId") as MemoryForgetRequestId;
}

export function asMemoryClaimVersionQualifierId(
  value: string,
): MemoryClaimVersionQualifierId {
  return asOpaqueUuidV7(
    value,
    "MemoryClaimVersionQualifierId",
  ) as MemoryClaimVersionQualifierId;
}

export function asRelationshipResolverHintId(
  value: string,
): RelationshipResolverHintId {
  return asOpaqueUuidV7(
    value,
    "RelationshipResolverHintId",
  ) as RelationshipResolverHintId;
}

export function asMemoryForgetEvidenceExclusionId(
  value: string,
): MemoryForgetEvidenceExclusionId {
  return asOpaqueUuidV7(
    value,
    "MemoryForgetEvidenceExclusionId",
  ) as MemoryForgetEvidenceExclusionId;
}

export function asMemoryForgetReversalId(
  value: string,
): MemoryForgetReversalId {
  return asOpaqueUuidV7(
    value,
    "MemoryForgetReversalId",
  ) as MemoryForgetReversalId;
}

export function asEpisodeId(value: string): EpisodeId {
  return asOpaqueUuidV7(value, "EpisodeId") as EpisodeId;
}

export function asEpisodeVersionId(value: string): EpisodeVersionId {
  return asOpaqueUuidV7(
    value,
    "EpisodeVersionId",
  ) as EpisodeVersionId;
}

export function asEpisodeCandidateId(value: string): EpisodeCandidateId {
  return asOpaqueUuidV7(
    value,
    "EpisodeCandidateId",
  ) as EpisodeCandidateId;
}

export function asReflectionId(value: string): ReflectionId {
  return asOpaqueUuidV7(value, "ReflectionId") as ReflectionId;
}

export function asReflectionVersionId(value: string): ReflectionVersionId {
  return asOpaqueUuidV7(
    value,
    "ReflectionVersionId",
  ) as ReflectionVersionId;
}

export function asReflectionStatementId(value: string): ReflectionStatementId {
  return asOpaqueUuidV7(
    value,
    "ReflectionStatementId",
  ) as ReflectionStatementId;
}

export function asReflectionAtomicPropositionId(
  value: string,
): ReflectionAtomicPropositionId {
  return asOpaqueUuidV7(
    value,
    "ReflectionAtomicPropositionId",
  ) as ReflectionAtomicPropositionId;
}

export function asPredicateChangeProposalId(
  value: string,
): PredicateChangeProposalId {
  return asOpaqueUuidV7(
    value,
    "PredicateChangeProposalId",
  ) as PredicateChangeProposalId;
}

export function asPredicateChangeProposalVersionId(
  value: string,
): PredicateChangeProposalVersionId {
  return asOpaqueUuidV7(
    value,
    "PredicateChangeProposalVersionId",
  ) as PredicateChangeProposalVersionId;
}

export function asPredicateChangeProposalCandidateLinkId(
  value: string,
): PredicateChangeProposalCandidateLinkId {
  return asOpaqueUuidV7(
    value,
    "PredicateChangeProposalCandidateLinkId",
  ) as PredicateChangeProposalCandidateLinkId;
}

export function asCandidateReviewAuditId(
  value: string,
): CandidateReviewAuditId {
  return asOpaqueUuidV7(
    value,
    "CandidateReviewAuditId",
  ) as CandidateReviewAuditId;
}

export function asNarrativeValidatorRequestId(
  value: string,
): NarrativeValidatorRequestId {
  return asOpaqueUuidV7(
    value,
    "NarrativeValidatorRequestId",
  ) as NarrativeValidatorRequestId;
}

export function asNarrativeValidatorResultId(
  value: string,
): NarrativeValidatorResultId {
  return asOpaqueUuidV7(
    value,
    "NarrativeValidatorResultId",
  ) as NarrativeValidatorResultId;
}

function asOpaqueUuidV7(value: string, typeName: string): string {
  if (!uuidV7Pattern.test(value)) {
    throw new Error(`${typeName} must be an opaque UUIDv7.`);
  }
  return value;
}
