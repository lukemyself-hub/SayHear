import { asDailySessionId, type UserId } from "@sayhear/domain";

import type { RecoveryGate } from "./recovery-gate";

export type JournalEpistemicStatus = "supported_expression" | "inferred_observation";
export type JournalGenerationKind = "automatic" | "regeneration";
export type JournalEvidenceReference = Readonly<{
  id: string;
  sourceEventId: string;
  sourceRevisionId: string;
  sourceActor: "user";
  sourceStatus: "final" | "corrected";
  locatorType: "whole_revision" | "segment" | "text_span" | "time_range";
  locatorKey: string;
  role: "factual_support" | "subjective_report";
}>;
export type JournalSourceText = Readonly<Record<string, string>>;
export type JournalStatementDraft = Readonly<{
  id: string;
  text: string;
  epistemicStatus: JournalEpistemicStatus;
  evidenceItemIds: readonly string[];
}>;
export type JournalDraft = Readonly<{
  journalVersionId?: string;
  sourceSnapshotId?: string;
  extractionPolicyVersion?: string;
  evidenceChampion?: Readonly<{ configVersion: string; provider: string; model: string; snapshot: string; providerPolicyVersion: string }>;
  sourceRevision?: number;
  generationCommandId?: string;
  modelRunAttemptId?: string;
  validationStatus?: "validated" | "validation_failed" | "needs_review";
  validationFailureCode?: string | null;
  providerRole?: string;
  provider?: string;
  model?: string;
  configVersion?: string;
  rolePolicyVersion?: string;
  promptFingerprint?: string;
  providerCompletedAt?: string | null;
  resultMetadata?: Record<string, unknown>;
  evidenceItems?: readonly JournalEvidenceReference[];
  locale: string;
  statements: readonly JournalStatementDraft[];
}>;
export type JournalSourceSnapshot = Readonly<{
  sourceSnapshotId: string;
  dailySessionId: string;
  userId: string;
  sourceRevision: number;
  evidenceItems: readonly JournalEvidenceReference[];
  sourceTextByEvidenceId?: JournalSourceText;
  locale?: string;
  dataEpoch?: number;
  extractionPolicyVersion?: string;
}>;
export type CurrentJournalVersion = Readonly<{
  locale: string;
  statements: readonly JournalStatementDraft[];
}>;
export type CurrentJournal = Readonly<{
  dailySessionId: string;
  logicalDate: string;
  state: "current" | "outdated" | "updating";
  version: CurrentJournalVersion;
}>;

export type JournalRepository = Readonly<{
  readSource(input: { dailySessionId: string; sourceRevision: number; expectedDataEpoch: number; extractionPolicyVersion: string }): Promise<JournalSourceSnapshot | null>;
  startGeneration(input: {
    dailySessionId: string;
    userId: string | null;
    sourceRevision: number;
    generationCommandId: string;
    modelRunAttemptId: string;
    generationPolicyVersion: string;
    expectedDataEpoch: number;
    role: "journal.draft";
    provider: string;
    model: string;
    configVersion: string;
    rolePolicyVersion: string;
    promptFingerprint: string;
    generationKind?: JournalGenerationKind;
    actionExecutionId?: string;
  }): Promise<{ accepted: boolean; generationCommandId: string }>;
  publish(input: {
    dailySessionId: string;
    userId: string;
    sourceRevision: number;
    generationCommandId: string;
    modelRunAttemptId: string;
    generationPolicyVersion: string;
    validatorVersion: string;
    validationAttemptId: string;
    validatorRole: "journal.validate";
    validatorProvider: string;
    validatorModel: string;
    validatorConfigVersion: string;
    validatorPolicyVersion: string;
    validatorPromptFingerprint: string;
    expectedDataEpoch: number;
    sourceSnapshotId: string;
    locale: string;
    statements: readonly JournalStatementDraft[];
    modelValid: boolean;
    generationKind?: JournalGenerationKind;
    actionExecutionId?: string;
    targetVersionId?: string;
  }): Promise<{ outcome: "published" | "stale" | "fenced" }>;
  recordWorkflowOutcome?(input: {
    dailySessionId: string;
    userId: string | null;
    sourceRevision: number;
    expectedDataEpoch: number;
    workflowCommandId: string;
    outcome: "retryable_failed" | "needs_review" | "published";
    reason: string | null;
  }): Promise<void>;
  recordValidationFailure(input: {
    dailySessionId: string;
    sourceRevision: number;
    generationCommandId: string;
    modelRunAttemptId: string;
    validatorVersion: string;
    failureCode: string;
    expectedDataEpoch: number;
    generationPolicyVersion: string;
    validationAttemptId?: string;
    validatorRole?: "journal.validate";
    validatorProvider?: string;
    validatorModel?: string;
    validatorConfigVersion?: string;
    validatorPolicyVersion?: string;
    validatorPromptFingerprint?: string;
    generationKind?: JournalGenerationKind;
    actionExecutionId?: string;
  }): Promise<void>;
  readCurrent?(input: { dailySessionId: string; userId: string }): Promise<JournalDraft | null>;
  readLatestCurrent(input: { userId: string }): Promise<CurrentJournal | null>;
}>;

export type JournalModel = Readonly<{
  generate(input: {
    locale: string;
    evidenceItems: readonly JournalEvidenceReference[];
    sourceTextByEvidenceId: JournalSourceText;
    guidance?: string | null;
  }): Promise<JournalDraft>;
}>;
export type JournalProviderEgress = JournalModel;
export type JournalValidationProvider = Readonly<{
  role: "journal.validate";
  validate(input: { draft: JournalDraft; evidenceItems: readonly JournalEvidenceReference[]; sourceTextByEvidenceId: JournalSourceText }): Promise<{ valid: true } | { valid: false; reason: string }>;
}>;

export type JournalService = Readonly<{
  generate(input: {
    dailySessionId: string;
    sourceRevision: number;
    generationCommandId: string;
    modelRunAttemptId: string;
    expectedDataEpoch: number;
    policyVersion: string;
    generationKind?: JournalGenerationKind;
    actionExecutionId?: string;
    targetVersionId?: string;
    guidance?: string | null;
  }): Promise<{
    outcome: "published" | "stale" | "fenced" | "not_found" | "validation_failed" | "writes_disabled";
    reason?: string;
  }>;
  inspect(input: { dailySessionId: string; userId: string }): Promise<JournalDraft | null>;
  readLatest(input: { userId: string }): Promise<CurrentJournal | null>;
}>;

export type AutomaticJournalCommand = Readonly<{
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}>;

export function createJournalService(dependencies: {
  journalPolicyVersion: string;
  validatorVersion: string;
  evidenceExtractionPolicyVersion: string;
  validationProvider: JournalValidationProvider;
  generationMetadata: Readonly<{ role: "journal.draft"; provider: string; model: string; configVersion: string; rolePolicyVersion: string; promptFingerprint: string }>;
  validationMetadata: Readonly<{ role: "journal.validate"; provider: string; model: string; configVersion: string; rolePolicyVersion: string; promptFingerprint: string }>;
  model: JournalModel;
  recoveryGate?: RecoveryGate;
  repository: JournalRepository;
  publishingEnabled?: boolean;
}): JournalService {
  if (!dependencies.journalPolicyVersion || !dependencies.validatorVersion) {
    throw new Error("Journal policy and validator versions must be non-empty.");
  }

  return {
    async generate(input) {
      if (dependencies.publishingEnabled === false) {
        return { outcome: "writes_disabled" };
      }
      let dailySessionId: string;
      try { dailySessionId = asDailySessionId(input.dailySessionId); } catch { return { outcome: "not_found" }; }
      if (input.policyVersion !== dependencies.journalPolicyVersion) return { outcome: "fenced" };
      const source = await dependencies.repository.readSource({ dailySessionId, sourceRevision: input.sourceRevision, expectedDataEpoch: input.expectedDataEpoch, extractionPolicyVersion: dependencies.evidenceExtractionPolicyVersion });
      if (!source || source.sourceRevision !== input.sourceRevision) return { outcome: "stale" };
      if (source.extractionPolicyVersion !== undefined && source.extractionPolicyVersion !== dependencies.evidenceExtractionPolicyVersion) return { outcome: "fenced" };
      if (source.dataEpoch !== undefined && source.dataEpoch !== input.expectedDataEpoch) return { outcome: "fenced" };
      await dependencies.recoveryGate?.requireOpen(source.userId as UserId);
      const generation = await dependencies.repository.startGeneration({
        dailySessionId,
        userId: source.userId,
        sourceRevision: source.sourceRevision,
        generationCommandId: input.generationCommandId,
        modelRunAttemptId: input.modelRunAttemptId,
        generationPolicyVersion: dependencies.journalPolicyVersion,
        expectedDataEpoch: input.expectedDataEpoch,
        ...dependencies.generationMetadata,
        generationKind: input.generationKind ?? "automatic",
        ...(input.actionExecutionId === undefined
          ? {}
          : { actionExecutionId: input.actionExecutionId }),
      });
      if (!generation.accepted) return { outcome: "fenced" };
      const generationCommandId = generation.generationCommandId;
      let draft: JournalDraft;
      try {
        draft = await dependencies.model.generate({
          locale: source.locale ?? "en-US",
          evidenceItems: source.evidenceItems,
          sourceTextByEvidenceId: source.sourceTextByEvidenceId ?? {},
          ...(input.guidance === undefined ? {} : { guidance: input.guidance }),
        });
      } catch {
        await dependencies.repository.recordValidationFailure?.({
          dailySessionId, sourceRevision: source.sourceRevision, generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId, validatorVersion: dependencies.validatorVersion,
          failureCode: "model_run_failed", expectedDataEpoch: input.expectedDataEpoch,
          generationPolicyVersion: dependencies.journalPolicyVersion,
          generationKind: input.generationKind ?? "automatic",
          ...(input.actionExecutionId === undefined ? {} : { actionExecutionId: input.actionExecutionId }),
        });
        return { outcome: "validation_failed", reason: "model_run_failed" };
      }
      const validation = validateJournalDraft(draft, source.evidenceItems, source.locale);
      if (!validation.valid) {
        await dependencies.repository.recordValidationFailure?.({
          dailySessionId,
          sourceRevision: source.sourceRevision,
          generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
          validatorVersion: dependencies.validatorVersion,
          failureCode: validation.reason,
          expectedDataEpoch: input.expectedDataEpoch,
          generationPolicyVersion: dependencies.journalPolicyVersion,
          generationKind: input.generationKind ?? "automatic",
          ...(input.actionExecutionId === undefined ? {} : { actionExecutionId: input.actionExecutionId }),
        });
        return { outcome: "validation_failed", reason: validation.reason };
      }
      let narrativeValidation: Awaited<ReturnType<JournalValidationProvider["validate"]>>;
      try {
        narrativeValidation = await dependencies.validationProvider.validate({ draft, evidenceItems: source.evidenceItems, sourceTextByEvidenceId: source.sourceTextByEvidenceId ?? {} });
      } catch {
        await dependencies.repository.recordValidationFailure?.({
          dailySessionId, sourceRevision: source.sourceRevision, generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId, validatorVersion: dependencies.validatorVersion,
          failureCode: "validator_model_failed", expectedDataEpoch: input.expectedDataEpoch,
          generationPolicyVersion: dependencies.journalPolicyVersion,
          generationKind: input.generationKind ?? "automatic",
          ...(input.actionExecutionId === undefined ? {} : { actionExecutionId: input.actionExecutionId }),
          validationAttemptId: `${input.modelRunAttemptId}:validate`,
          validatorRole: dependencies.validationMetadata.role,
          validatorProvider: dependencies.validationMetadata.provider,
          validatorModel: dependencies.validationMetadata.model,
          validatorConfigVersion: dependencies.validationMetadata.configVersion,
          validatorPolicyVersion: dependencies.validationMetadata.rolePolicyVersion,
          validatorPromptFingerprint: dependencies.validationMetadata.promptFingerprint,
        });
        return { outcome: "validation_failed", reason: "validator_model_failed" };
      }
      if (!narrativeValidation.valid) {
        await dependencies.repository.recordValidationFailure?.({
          dailySessionId,
          sourceRevision: source.sourceRevision,
          generationCommandId,
          modelRunAttemptId: input.modelRunAttemptId,
          validatorVersion: dependencies.validatorVersion,
          failureCode: narrativeValidation.reason,
          expectedDataEpoch: input.expectedDataEpoch,
          generationPolicyVersion: dependencies.journalPolicyVersion,
          generationKind: input.generationKind ?? "automatic",
          ...(input.actionExecutionId === undefined ? {} : { actionExecutionId: input.actionExecutionId }),
          validationAttemptId: `${input.modelRunAttemptId}:validate`,
          validatorRole: dependencies.validationMetadata.role,
          validatorProvider: dependencies.validationMetadata.provider,
          validatorModel: dependencies.validationMetadata.model,
          validatorConfigVersion: dependencies.validationMetadata.configVersion,
          validatorPolicyVersion: dependencies.validationMetadata.rolePolicyVersion,
          validatorPromptFingerprint: dependencies.validationMetadata.promptFingerprint,
        });
        return { outcome: "validation_failed", reason: narrativeValidation.reason };
      }
      return dependencies.repository.publish({
        dailySessionId,
        userId: source.userId,
        sourceRevision: source.sourceRevision,
        generationCommandId,
        modelRunAttemptId: input.modelRunAttemptId,
        generationPolicyVersion: dependencies.journalPolicyVersion,
        validatorVersion: dependencies.validatorVersion,
        validationAttemptId: `${input.modelRunAttemptId}:validate`,
        validatorRole: dependencies.validationMetadata.role,
        validatorProvider: dependencies.validationMetadata.provider,
        validatorModel: dependencies.validationMetadata.model,
        validatorConfigVersion: dependencies.validationMetadata.configVersion,
        validatorPolicyVersion: dependencies.validationMetadata.rolePolicyVersion,
        validatorPromptFingerprint: dependencies.validationMetadata.promptFingerprint,
        expectedDataEpoch: input.expectedDataEpoch,
        sourceSnapshotId: source.sourceSnapshotId,
        locale: draft.locale,
        statements: draft.statements,
        modelValid: narrativeValidation.valid,
        generationKind: input.generationKind ?? "automatic",
        ...(input.actionExecutionId === undefined
          ? {}
          : { actionExecutionId: input.actionExecutionId }),
        ...(input.targetVersionId === undefined
          ? {}
          : { targetVersionId: input.targetVersionId }),
      });
    },
    async inspect(input) {
      await dependencies.recoveryGate?.requireOpen(input.userId as UserId);
      let dailySessionId: string;
      try { dailySessionId = asDailySessionId(input.dailySessionId); } catch { return null; }
      return dependencies.repository.readCurrent?.({ dailySessionId, userId: input.userId }) ?? null;
    },
    async readLatest(input) {
      await dependencies.recoveryGate?.requireOpen(input.userId as UserId);
      return dependencies.repository.readLatestCurrent({ userId: input.userId });
    },
  };
}

/**
 * Workflow-facing entrypoint. The durable payload is deliberately limited to
 * opaque IDs, a source revision, and a versioned policy; source text is loaded
 * only inside the application/data boundary after the owner and exact-head
 * fences are checked.
 */
export async function runAutomaticJournal(input: {
  service: JournalService;
  command: AutomaticJournalCommand;
  generationCommandId: string;
  modelRunAttemptId: string;
}): ReturnType<JournalService["generate"]> {
  asDailySessionId(input.command.subjectId);
  if (!input.command.workflowCommandId || !input.command.policyVersion) {
    throw new Error("Journal Workflow command is incomplete.");
  }
  return input.service.generate({
    dailySessionId: input.command.subjectId,
    sourceRevision: input.command.sourceRevision,
    generationCommandId: input.generationCommandId,
    modelRunAttemptId: input.modelRunAttemptId,
    expectedDataEpoch: input.command.expectedDataEpoch,
    policyVersion: input.command.policyVersion,
  });
}

export async function runJournalRegeneration(input: {
  service: JournalService;
  command: AutomaticJournalCommand & Readonly<{
    actionExecutionId: string;
    guidance: string | null;
    targetVersionId: string;
  }>;
  generationCommandId: string;
  modelRunAttemptId: string;
}): ReturnType<JournalService["generate"]> {
  asDailySessionId(input.command.subjectId);
  if (!input.command.workflowCommandId || !input.command.policyVersion || !input.command.actionExecutionId) {
    throw new Error("Journal regeneration command is incomplete.");
  }
  return input.service.generate({
    dailySessionId: input.command.subjectId,
    sourceRevision: input.command.sourceRevision,
    generationCommandId: input.generationCommandId,
    modelRunAttemptId: input.modelRunAttemptId,
    expectedDataEpoch: input.command.expectedDataEpoch,
    policyVersion: input.command.policyVersion,
    generationKind: "regeneration",
    actionExecutionId: input.command.actionExecutionId,
    guidance: input.command.guidance,
    targetVersionId: input.command.targetVersionId,
  });
}

export function validateJournalDraft(
  draft: JournalDraft,
  evidenceItems: readonly JournalEvidenceReference[],
  sourceLocale?: string,
): { valid: true } | { valid: false; reason: string } {
  if (!draft || typeof draft !== "object" || typeof draft.locale !== "string" || !Array.isArray(draft.statements)) {
    return { valid: false, reason: "invalid_schema" };
  }
  if (!draft.locale || !/^(en|zh)(-[A-Z]{2})?$/.test(draft.locale)) return { valid: false, reason: "invalid_locale" };
  if (sourceLocale && draft.locale !== sourceLocale) return { valid: false, reason: "locale_mismatch" };
  if (draft.statements.length === 0) return { valid: false, reason: "empty_journal" };
  const ids = new Set<string>();
  const evidenceById = new Map(evidenceItems.map((item) => [item.id, item]));
  const texts = new Set<string>();
  for (const statement of draft.statements) {
    if (!statement || typeof statement !== "object" || typeof statement.id !== "string" ||
      typeof statement.text !== "string" || !Array.isArray(statement.evidenceItemIds) ||
      !["supported_expression", "inferred_observation"].includes(statement.epistemicStatus)) {
      return { valid: false, reason: "invalid_schema" };
    }
    if (!statement.id || /\s/.test(statement.id) || ids.has(statement.id)) return { valid: false, reason: "duplicate_statement_id" };
    ids.add(statement.id);
    const normalizedText = statement.text.trim();
    if (!normalizedText || texts.has(normalizedText)) return { valid: false, reason: "empty_or_duplicate_statement" };
    texts.add(normalizedText);
    if (/(?:\bI\b|\bme\b|\bmy\b|我|我的|我们)/i.test(normalizedText)) return { valid: false, reason: "first_person_journal" };
    if (statement.epistemicStatus === "inferred_observation" && !/(?:may|might|seems?|appears?|可能|似乎|看起来)/i.test(normalizedText)) {
      return { valid: false, reason: "uncertainty_not_preserved" };
    }
    if (statement.evidenceItemIds.length === 0) return { valid: false, reason: "missing_evidence" };
    for (const evidenceId of statement.evidenceItemIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence || evidence.sourceActor !== "user" || !["final", "corrected"].includes(evidence.sourceStatus)) {
        return { valid: false, reason: "invalid_evidence" };
      }
    }
  }
  return { valid: true };
}

export function validateJournalNarrative(
  draft: JournalDraft,
): { valid: true } | { valid: false; reason: string } {
  for (const statement of draft.statements) {
    if (/(?:\b(?:diagnos(?:e|is|ed|ing)|therap(?:y|ist)|should|must|you need)\b|诊断|治疗|应该|必须)/i.test(statement.text)) {
      return { valid: false, reason: "unsafe_narrative" };
    }
  }
  return { valid: true };
}
