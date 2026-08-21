import { describe, expect, it, vi } from "vitest";

import { createJournalService, validateJournalDraft } from "./journal";

const sessionId = "01984477-31e1-7595-92c6-06889cb0fdde";

const evidence = {
  id: "evidence-1",
  sourceEventId: "event-1",
  sourceRevisionId: "revision-1",
  sourceStatus: "final" as const,
  sourceActor: "user" as const,
  locatorType: "whole_revision" as const,
  locatorKey: "revision:revision-1",
  role: "factual_support" as const,
};

describe("automatic evidence-backed Journal", () => {
  it("runs regeneration through the same validation and publish seam with bounded guidance", async () => {
    const publish = vi.fn().mockResolvedValue({ outcome: "published" });
    const generate = vi.fn().mockResolvedValue({
      locale: "en-US",
      statements: [{
        id: "statement-1",
        text: "The owner described a turning point in the day.",
        evidenceItemIds: [evidence.id],
      }],
    });
    const startGeneration = vi.fn().mockResolvedValue({
      accepted: true,
      generationCommandId: "regeneration-command-1",
    });
    const service = createJournalService({
      journalPolicyVersion: "journal-generation:v1",
      validatorVersion: "journal-validator:v1",
      evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-generation:v1", promptFingerprint: "test" },
      validationMetadata: { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-validator:v1", promptFingerprint: "test" },
      validationProvider: { role: "journal.validate", validate: async () => ({ status: "available", findings: [] }) },
      model: { generate },
      repository: {
        readSource: vi.fn().mockResolvedValue({
          sourceSnapshotId: "snapshot-1",
          dailySessionId: sessionId,
          userId: "user-1",
          sourceRevision: 4,
          evidenceItems: [evidence],
        }),
        startGeneration,
        publish,
        recordValidationFailure: vi.fn(),
        readLatestCurrent: vi.fn().mockResolvedValue(null),
      },
    });

    await expect(service.generate({
      dailySessionId: sessionId,
      sourceRevision: 4,
      generationCommandId: "regeneration-command-1",
      modelRunAttemptId: "attempt-1",
      expectedDataEpoch: 1,
      policyVersion: "journal-generation:v1",
      generationKind: "regeneration",
      actionExecutionId: "action-1",
      targetVersionId: "version-1",
      guidance: "Make the turning point clearer.",
    })).resolves.toEqual({ outcome: "published" });

    expect(startGeneration).toHaveBeenCalledWith(expect.objectContaining({
      generationKind: "regeneration",
      actionExecutionId: "action-1",
    }));
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      guidance: "Make the turning point clearer.",
    }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      generationKind: "regeneration",
      actionExecutionId: "action-1",
      targetVersionId: "version-1",
    }));
  });

  it("validates and publishes a third-person Journal from the frozen Evidence snapshot", async () => {
    const publish = vi.fn().mockResolvedValue({ outcome: "published" });
    const service = createJournalService({
      journalPolicyVersion: "journal-generation:v1",
      validatorVersion: "journal-validator:v1",
      evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-generation:v1", promptFingerprint: "test" },
      validationMetadata: { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-validator:v1", promptFingerprint: "test" },
      validationProvider: { role: "journal.validate", validate: async () => ({ status: "available", findings: [] }) },
      model: {
        generate: vi.fn().mockImplementation(async () => ({
          locale: "en-US",
          statements: [{
            id: "statement-1",
            text: "The owner described finishing a difficult task.",
            evidenceItemIds: [evidence.id],
          }],
        })),
      },
      repository: {
        readSource: vi.fn().mockResolvedValue({
          sourceSnapshotId: "snapshot-1",
          dailySessionId: sessionId,
          userId: "user-1",
          sourceRevision: 4,
          evidenceItems: [evidence],
        }),
        startGeneration: vi.fn().mockResolvedValue({ accepted: true, generationCommandId: "command-1" }),
        publish,
        recordValidationFailure: vi.fn(),
        readLatestCurrent: vi.fn().mockResolvedValue(null),
      },
    });

    await expect(service.generate({
      dailySessionId: sessionId,
      sourceRevision: 4,
      generationCommandId: "command-1",
      modelRunAttemptId: "attempt-1",
      expectedDataEpoch: 1,
      policyVersion: "journal-generation:v1",
    })).resolves.toEqual({ outcome: "published" });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      sourceRevision: 4,
      statements: expect.arrayContaining([
        expect.objectContaining({ evidenceItemIds: [evidence.id] }),
      ]),
    }));
  });

  it("publishes structured non-blocking findings using only cited Evidence", async () => {
    const publish = vi.fn().mockResolvedValue({ outcome: "published" });
    const validate = vi.fn().mockResolvedValue({
      status: "available",
      findings: [{ statementId: "statement-1", code: "third_person_style", detailCode: "first_person_expression" }],
    });
    const secondEvidence = { ...evidence, id: "evidence-2" };
    const service = createJournalService({
      journalPolicyVersion: "journal-generation:v1",
      validatorVersion: "journal-validator:v1",
      evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-generation:v1", promptFingerprint: "test" },
      validationMetadata: { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-validator:v1", promptFingerprint: "test" },
      validationProvider: { role: "journal.validate", validate },
      model: { generate: async () => ({ locale: "en-US", statements: [{ id: "statement-1", text: "I had a hard day.", evidenceItemIds: [evidence.id] }] }) },
      repository: {
        readSource: vi.fn().mockResolvedValue({ sourceSnapshotId: "snapshot-1", dailySessionId: sessionId, userId: "user-1", sourceRevision: 4, evidenceItems: [evidence, secondEvidence], sourceTextByEvidenceId: { [evidence.id]: "A hard day.", [secondEvidence.id]: "Another event." } }),
        startGeneration: vi.fn().mockResolvedValue({ accepted: true, generationCommandId: "command-1" }),
        publish,
        recordValidationFailure: vi.fn(),
        readLatestCurrent: vi.fn().mockResolvedValue(null),
      },
    });

    await expect(service.generate({ dailySessionId: sessionId, sourceRevision: 4, generationCommandId: "command-1", modelRunAttemptId: "attempt-1", expectedDataEpoch: 1, policyVersion: "journal-generation:v1" }))
      .resolves.toEqual({ outcome: "published" });
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({
      evidenceItems: [evidence],
      sourceTextByEvidenceId: { [evidence.id]: "A hard day." },
    }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      diagnosticStatus: "available",
      diagnosticFindings: [{ statementId: "statement-1", code: "third_person_style", detailCode: "first_person_expression" }],
    }));
  });

  it("does not publish drafts that cite missing Evidence", async () => {
    const publish = vi.fn();
    const service = createJournalService({
      journalPolicyVersion: "journal-generation:v1",
      validatorVersion: "journal-validator:v1",
      evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-generation:v1", promptFingerprint: "test" },
      validationMetadata: { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-validator:v1", promptFingerprint: "test" },
      validationProvider: { role: "journal.validate", validate: async () => ({ status: "available", findings: [] }) },
      model: { generate: vi.fn().mockImplementation(async () => ({
        locale: "en-US",
        statements: [{ id: "s", text: "I had a hard day.", evidenceItemIds: ["missing"] }],
      })) },
      repository: {
        readSource: vi.fn().mockResolvedValue({ sourceSnapshotId: "snapshot-1", dailySessionId: sessionId, userId: "user-1", sourceRevision: 4, evidenceItems: [evidence] }),
        startGeneration: vi.fn().mockResolvedValue({ accepted: true, generationCommandId: "c" }),
        publish,
        recordValidationFailure: vi.fn(),
        readLatestCurrent: vi.fn().mockResolvedValue(null),
      },
    });

    await expect(service.generate({ dailySessionId: sessionId, sourceRevision: 4, generationCommandId: "c", modelRunAttemptId: "a", expectedDataEpoch: 1, policyVersion: "journal-generation:v1" }))
      .resolves.toEqual(expect.objectContaining({ outcome: "validation_failed" }));
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not hard-block first-person or inferred wording", () => {
    expect(validateJournalDraft({
      locale: "zh-CN",
      statements: [{ id: "s1", text: "我今天很累。", evidenceItemIds: [evidence.id] }],
    }, [evidence])).toEqual({ valid: true });
    expect(validateJournalDraft({
      locale: "en-US",
      statements: [{ id: "s2", text: "The owner is overwhelmed.", evidenceItemIds: [evidence.id] }],
    }, [evidence])).toEqual({ valid: true });
  });

  it("settles both attempts when the model validator throws", async () => {
    const recordValidationFailure = vi.fn().mockResolvedValue(undefined);
    const service = createJournalService({
      journalPolicyVersion: "journal-generation:v1", validatorVersion: "journal-validator:v1", evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-generation:v1", promptFingerprint: "test" },
      validationMetadata: { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-validator:v1", promptFingerprint: "test" },
      validationProvider: { role: "journal.validate", validate: async () => { throw new Error("provider unavailable"); } },
      model: { generate: async () => ({ locale: "en-US", statements: [{ id: "s", text: "The owner described a walk.", evidenceItemIds: [evidence.id] }] }) },
      repository: {
        readSource: async () => ({ sourceSnapshotId: "snapshot-1", dailySessionId: sessionId, userId: "user-1", sourceRevision: 4, evidenceItems: [evidence] }),
        startGeneration: async () => ({ accepted: true, generationCommandId: "command-1" }), publish: vi.fn().mockResolvedValue({ outcome: "published" }), recordValidationFailure, readLatestCurrent: vi.fn().mockResolvedValue(null),
      },
    });
    await expect(service.generate({ dailySessionId: sessionId, sourceRevision: 4, generationCommandId: "command-1", modelRunAttemptId: "attempt-1", expectedDataEpoch: 1, policyVersion: "journal-generation:v1" }))
      .resolves.toEqual({ outcome: "published" });
    expect(recordValidationFailure).not.toHaveBeenCalled();
  });

  it("does not dispatch a Journal model or publish when the independent Journal write switch is disabled", async () => {
    const generate = vi.fn();
    const publish = vi.fn();
    const service = createJournalService({
      journalPolicyVersion: "journal-generation:v1", validatorVersion: "journal-validator:v1", evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-generation:v1", promptFingerprint: "test" },
      validationMetadata: { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-validator:v1", promptFingerprint: "test" },
      validationProvider: { role: "journal.validate", validate: async () => ({ status: "available", findings: [] }) },
      model: { generate },
      repository: {
        readSource: vi.fn(), startGeneration: vi.fn(), publish, recordValidationFailure: vi.fn(), readLatestCurrent: vi.fn().mockResolvedValue(null),
      },
      publishingEnabled: false,
    });

    await expect(service.generate({ dailySessionId: sessionId, sourceRevision: 4, generationCommandId: "command-1", modelRunAttemptId: "attempt-1", expectedDataEpoch: 1, policyVersion: "journal-generation:v1" }))
      .resolves.toEqual({ outcome: "writes_disabled" });
    expect(generate).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("reads only the owner-scoped latest current Journal for the Internal Web", async () => {
    const readLatestCurrent = vi.fn().mockResolvedValue({
      dailySessionId: sessionId,
      logicalDate: "2026-08-12",
      version: { locale: "en-US", statements: [], diagnosticStatus: "available" },
    });
    const service = createJournalService({
      journalPolicyVersion: "journal-generation:v1", validatorVersion: "journal-validator:v1", evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-generation:v1", promptFingerprint: "test" },
      validationMetadata: { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-validator:v1", promptFingerprint: "test" },
      validationProvider: { role: "journal.validate", validate: async () => ({ status: "available", findings: [] }) },
      model: { generate: async () => ({ locale: "en-US", statements: [] }) },
      repository: { readSource: vi.fn(), startGeneration: vi.fn(), publish: vi.fn(), recordValidationFailure: vi.fn(), readLatestCurrent },
    });

    await expect(service.readLatest({ userId: "user-1" })).resolves.toMatchObject({ logicalDate: "2026-08-12" });
    expect(readLatestCurrent).toHaveBeenCalledWith({ userId: "user-1" });
  });
});
