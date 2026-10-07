import { createHmac, timingSafeEqual } from "node:crypto";

import { asDailySessionId, type UserId } from "@sayhear/domain";

import type { RecoveryGate } from "./recovery-gate";

export type JournalGenerationKind = "automatic" | "regeneration";
export type JournalDiagnosticCode =
  | "third_person_style"
  | "evidence_grounding"
  | "narrative_safety"
  | "certainty_or_agreement";
export type JournalDiagnosticDetailCode =
  | "first_person_expression"
  | "evidence_support_unclear"
  | "diagnosis_or_treatment_language"
  | "prescriptive_language"
  | "certainty_language"
  | "agreement_language";
export type JournalDiagnosticFinding = Readonly<{
  statementId: string;
  code: JournalDiagnosticCode;
  detailCode: JournalDiagnosticDetailCode;
}>;
export type JournalDiagnosticStatus = "available" | "unavailable";
export type JournalGenerationNotice = Readonly<{
  logicalDate: string;
  failureCode: string;
}>;
const JOURNAL_DIAGNOSTIC_DETAIL_CODES: Readonly<Record<JournalDiagnosticCode, readonly JournalDiagnosticDetailCode[]>> = {
  third_person_style: ["first_person_expression"],
  evidence_grounding: ["evidence_support_unclear"],
  narrative_safety: ["diagnosis_or_treatment_language", "prescriptive_language"],
  certainty_or_agreement: ["certainty_language", "agreement_language"],
};

export function normalizeJournalDiagnosticFindings(
  value: unknown,
  draft: Pick<JournalDraft, "statements">,
): readonly JournalDiagnosticFinding[] | null {
  if (!Array.isArray(value)) return null;
  const statementIds = new Set(draft.statements.map((statement) => statement.id));
  const seen = new Set<string>();
  const findings: JournalDiagnosticFinding[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const record = candidate as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["statementId", "code", "detailCode"].includes(key))) return null;
    if (typeof record.statementId !== "string" || typeof record.code !== "string" || typeof record.detailCode !== "string") return null;
    if (!statementIds.has(record.statementId)) return null;
    if (!(record.code in JOURNAL_DIAGNOSTIC_DETAIL_CODES)) return null;
    const code = record.code as JournalDiagnosticCode;
    if (!(JOURNAL_DIAGNOSTIC_DETAIL_CODES[code] as readonly string[]).includes(record.detailCode)) return null;
    const key = `${record.statementId}:${record.code}:${record.detailCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      statementId: record.statementId,
      code,
      detailCode: record.detailCode as JournalDiagnosticDetailCode,
    });
    if (findings.length > 32) return null;
  }
  return findings;
}
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
  evidenceItemIds: readonly string[];
  diagnosticFindings?: readonly JournalDiagnosticFinding[];
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
  diagnosticStatus?: JournalDiagnosticStatus;
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
  diagnosticStatus: JournalDiagnosticStatus;
}>;
export type CurrentJournal = Readonly<{
  dailySessionId: string;
  logicalDate: string;
  state: "current" | "outdated" | "updating";
  version: CurrentJournalVersion;
}>;

/** Server-side fixed cap for one Journal date page; clients cannot raise it. */
export const JOURNAL_DATE_PAGE_LIMIT = 30;

export type JournalDateState = "current" | "outdated" | "updating";

export type JournalDateEntry = Readonly<{
  dailySessionId: string;
  logicalDate: string;
  state: JournalDateState;
}>;

export type JournalDatePage = Readonly<{
  entries: readonly JournalDateEntry[];
  nextCursor: string | null;
}>;

export type JournalDateCursor = Readonly<{
  dailySessionId: string;
  logicalDate: string;
}>;

const JOURNAL_DATE_SORT = "logical_date_desc";

type JournalDateCursorPayload = Readonly<{
  after: readonly [string, string];
  owner: string;
  sort: typeof JOURNAL_DATE_SORT;
  version: 1;
}>;

export class JournalDateCursorError extends Error {
  public constructor() {
    super(
      "The Journal date cursor is invalid or no longer matches the query.",
    );
    this.name = "JournalDateCursorError";
  }
}

export class InvalidJournalDateError extends Error {
  public constructor() {
    super("logicalDate must be an existing local date in YYYY-MM-DD form.");
    this.name = "InvalidJournalDateError";
  }
}

export function validateJournalLogicalDate(value: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidJournalDateError();
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new InvalidJournalDateError();
  }
  return value;
}

function journalDateCursorMac(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function encodeJournalDateCursor(
  payload: JournalDateCursorPayload,
  secret: string,
): string {
  if (!secret) throw new Error("Journal date cursor secret is required.");
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encodedPayload}.${journalDateCursorMac(encodedPayload, secret)}`;
}

export function decodeJournalDateCursor(
  token: string,
  secret: string,
): JournalDateCursorPayload | null {
  if (!token || !secret) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const encodedPayload = token.slice(0, separator);
  const suppliedMac = token.slice(separator + 1);
  const expectedMac = journalDateCursorMac(encodedPayload, secret);
  const supplied = Buffer.from(suppliedMac, "base64url");
  const expected = Buffer.from(expectedMac, "base64url");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<JournalDateCursorPayload>;
    if (
      parsed.version !== 1 ||
      typeof parsed.owner !== "string" ||
      parsed.sort !== JOURNAL_DATE_SORT ||
      !Array.isArray(parsed.after) ||
      parsed.after.length !== 2 ||
      !parsed.after.every((value) => typeof value === "string")
    ) {
      return null;
    }
    return {
      after: [parsed.after[0] as string, parsed.after[1] as string],
      owner: parsed.owner,
      sort: JOURNAL_DATE_SORT,
      version: 1,
    };
  } catch {
    return null;
  }
}

export function journalDateCursorAfter(
  cursor: string | null | undefined,
  owner: string,
  secret: string | undefined,
): JournalDateCursor | null {
  if (!cursor) return null;
  const decoded = secret ? decodeJournalDateCursor(cursor, secret) : null;
  if (!decoded || decoded.owner !== owner) {
    throw new JournalDateCursorError();
  }
  return {
    dailySessionId: decoded.after[1],
    logicalDate: decoded.after[0],
  };
}

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
    diagnosticStatus: JournalDiagnosticStatus;
    diagnosticFindings: readonly JournalDiagnosticFinding[];
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
  readCurrentJournalForDate?(input: { userId: string; logicalDate: string }): Promise<CurrentJournal | null>;
  readLatestCurrent(input: { userId: string }): Promise<CurrentJournal | null>;
  readLatestGenerationNotice?(input: { userId: string }): Promise<JournalGenerationNotice | null>;
  listCurrentJournalDates?(input: {
    userId: string;
    limit: number;
    cursor: JournalDateCursor | null;
  }): Promise<readonly JournalDateEntry[]>;
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
  validate(input: { draft: JournalDraft; evidenceItems: readonly JournalEvidenceReference[]; sourceTextByEvidenceId: JournalSourceText }): Promise<{
    status: "available";
    findings: readonly JournalDiagnosticFinding[];
  }>;
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
  listJournalDates(input: {
    userId: string;
    cursor?: string | null;
  }): Promise<JournalDatePage>;
  readByDate(input: {
    userId: string;
    logicalDate: string;
  }): Promise<CurrentJournal | null>;
  readLatest(input: { userId: string }): Promise<CurrentJournal | null>;
  readLatestGenerationNotice(input: { userId: string }): Promise<JournalGenerationNotice | null>;
}>;

export type AutomaticJournalCommand = Readonly<{
  workflowCommandId: string;
  subjectId: string;
  sourceRevision: number;
  policyVersion: string;
  expectedDataEpoch: number;
}>;

export function createJournalService(dependencies: {
  cursorSecret?: string;
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
      const citedEvidenceIds = new Set(draft.statements.flatMap((statement) => statement.evidenceItemIds));
      const diagnosticEvidenceItems = source.evidenceItems.filter((item) => citedEvidenceIds.has(item.id));
      const diagnosticSourceText = Object.fromEntries(
        diagnosticEvidenceItems
          .filter((item) => source.sourceTextByEvidenceId?.[item.id] !== undefined)
          .map((item) => [item.id, source.sourceTextByEvidenceId?.[item.id] as string]),
      );
      let diagnosticStatus: JournalDiagnosticStatus = "available";
      let diagnosticFindings: readonly JournalDiagnosticFinding[] = [];
      try {
        const result = await dependencies.validationProvider.validate({
          draft,
          evidenceItems: diagnosticEvidenceItems,
          sourceTextByEvidenceId: diagnosticSourceText,
        });
        const normalized = result.status === "available"
          ? normalizeJournalDiagnosticFindings(result.findings, draft)
          : null;
        if (!normalized) {
          diagnosticStatus = "unavailable";
        } else {
          diagnosticFindings = normalized;
        }
      } catch {
        diagnosticStatus = "unavailable";
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
        diagnosticStatus,
        diagnosticFindings,
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
    async listJournalDates(input) {
      await dependencies.recoveryGate?.requireOpen(input.userId as UserId);
      if (!dependencies.repository.listCurrentJournalDates) {
        return { entries: [], nextCursor: null };
      }
      const cursor = journalDateCursorAfter(
        input.cursor ?? null,
        input.userId,
        dependencies.cursorSecret,
      );
      const rows = await dependencies.repository.listCurrentJournalDates({
        cursor,
        limit: JOURNAL_DATE_PAGE_LIMIT + 1,
        userId: input.userId,
      });
      const hasMore = rows.length > JOURNAL_DATE_PAGE_LIMIT;
      const entries = hasMore ? rows.slice(0, JOURNAL_DATE_PAGE_LIMIT) : rows;
      const last = entries[entries.length - 1];
      const nextCursor =
        hasMore && last && dependencies.cursorSecret
          ? encodeJournalDateCursor(
              {
                after: [last.logicalDate, last.dailySessionId],
                owner: input.userId,
                sort: JOURNAL_DATE_SORT,
                version: 1,
              },
              dependencies.cursorSecret,
            )
          : null;
      return { entries: [...entries], nextCursor };
    },
    async readByDate(input) {
      await dependencies.recoveryGate?.requireOpen(input.userId as UserId);
      const logicalDate = validateJournalLogicalDate(input.logicalDate);
      return (
        dependencies.repository.readCurrentJournalForDate?.({
          logicalDate,
          userId: input.userId,
        }) ?? null
      );
    },
    async readLatest(input) {
      await dependencies.recoveryGate?.requireOpen(input.userId as UserId);
      return dependencies.repository.readLatestCurrent({ userId: input.userId });
    },
    async readLatestGenerationNotice(input) {
      await dependencies.recoveryGate?.requireOpen(input.userId as UserId);
      return dependencies.repository.readLatestGenerationNotice?.({ userId: input.userId }) ?? null;
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
      typeof statement.text !== "string" || !Array.isArray(statement.evidenceItemIds)) {
      return { valid: false, reason: "invalid_schema" };
    }
    if (!statement.id || /\s/.test(statement.id) || ids.has(statement.id)) return { valid: false, reason: "duplicate_statement_id" };
    ids.add(statement.id);
    const normalizedText = statement.text.trim();
    if (!normalizedText || texts.has(normalizedText)) return { valid: false, reason: "empty_or_duplicate_statement" };
    texts.add(normalizedText);
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
