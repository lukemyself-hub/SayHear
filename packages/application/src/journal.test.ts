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
  it("validates and publishes a third-person Journal from the frozen Evidence snapshot", async () => {
    const publish = vi.fn().mockResolvedValue({ outcome: "published" });
    const service = createJournalService({
      journalPolicyVersion: "journal-generation:v1",
      validatorVersion: "journal-validator:v1",
      evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-generation:v1", promptFingerprint: "test" },
      validationMetadata: { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-validator:v1", promptFingerprint: "test" },
      validationProvider: { role: "journal.validate", validate: async () => ({ valid: true }) },
      model: {
        generate: vi.fn().mockImplementation(async () => ({
          locale: "en-US",
          statements: [{
            id: "statement-1",
            text: "The owner described finishing a difficult task.",
            epistemicStatus: "supported_expression",
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

  it("does not publish drafts that cite missing Evidence or use first-person prose", async () => {
    const publish = vi.fn();
    const service = createJournalService({
      journalPolicyVersion: "journal-generation:v1",
      validatorVersion: "journal-validator:v1",
      evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-generation:v1", promptFingerprint: "test" },
      validationMetadata: { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-validator:v1", promptFingerprint: "test" },
      validationProvider: { role: "journal.validate", validate: async () => ({ valid: true }) },
      model: { generate: vi.fn().mockImplementation(async () => ({
        locale: "en-US",
        statements: [{ id: "s", text: "I had a hard day.", epistemicStatus: "supported_expression", evidenceItemIds: ["missing"] }],
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

  it("rejects Chinese first-person prose and inferred statements without uncertainty", () => {
    expect(validateJournalDraft({
      locale: "zh-CN",
      statements: [{ id: "s1", text: "我今天很累。", epistemicStatus: "supported_expression", evidenceItemIds: [evidence.id] }],
    }, [evidence])).toEqual({ valid: false, reason: "first_person_journal" });
    expect(validateJournalDraft({
      locale: "en-US",
      statements: [{ id: "s2", text: "The owner is overwhelmed.", epistemicStatus: "inferred_observation", evidenceItemIds: [evidence.id] }],
    }, [evidence])).toEqual({ valid: false, reason: "uncertainty_not_preserved" });
  });

  it("settles both attempts when the model validator throws", async () => {
    const recordValidationFailure = vi.fn().mockResolvedValue(undefined);
    const service = createJournalService({
      journalPolicyVersion: "journal-generation:v1", validatorVersion: "journal-validator:v1", evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-generation:v1", promptFingerprint: "test" },
      validationMetadata: { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-validator:v1", promptFingerprint: "test" },
      validationProvider: { role: "journal.validate", validate: async () => { throw new Error("provider unavailable"); } },
      model: { generate: async () => ({ locale: "en-US", statements: [{ id: "s", text: "The owner described a walk.", epistemicStatus: "supported_expression", evidenceItemIds: [evidence.id] }] }) },
      repository: {
        readSource: async () => ({ sourceSnapshotId: "snapshot-1", dailySessionId: sessionId, userId: "user-1", sourceRevision: 4, evidenceItems: [evidence] }),
        startGeneration: async () => ({ accepted: true, generationCommandId: "command-1" }), publish: vi.fn(), recordValidationFailure, readLatestCurrent: vi.fn().mockResolvedValue(null),
      },
    });
    await expect(service.generate({ dailySessionId: sessionId, sourceRevision: 4, generationCommandId: "command-1", modelRunAttemptId: "attempt-1", expectedDataEpoch: 1, policyVersion: "journal-generation:v1" }))
      .resolves.toEqual({ outcome: "validation_failed", reason: "validator_model_failed" });
    expect(recordValidationFailure).toHaveBeenCalledWith(expect.objectContaining({ validationAttemptId: "attempt-1:validate", failureCode: "validator_model_failed" }));
  });

  it("does not dispatch a Journal model or publish when the independent Journal write switch is disabled", async () => {
    const generate = vi.fn();
    const publish = vi.fn();
    const service = createJournalService({
      journalPolicyVersion: "journal-generation:v1", validatorVersion: "journal-validator:v1", evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-generation:v1", promptFingerprint: "test" },
      validationMetadata: { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-validator:v1", promptFingerprint: "test" },
      validationProvider: { role: "journal.validate", validate: async () => ({ valid: true }) },
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
      version: { locale: "en-US", statements: [] },
    });
    const service = createJournalService({
      journalPolicyVersion: "journal-generation:v1", validatorVersion: "journal-validator:v1", evidenceExtractionPolicyVersion: "evidence-extraction:v1",
      generationMetadata: { role: "journal.draft", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-generation:v1", promptFingerprint: "test" },
      validationMetadata: { role: "journal.validate", provider: "deterministic", model: "test", configVersion: "test:v1", rolePolicyVersion: "journal-validator:v1", promptFingerprint: "test" },
      validationProvider: { role: "journal.validate", validate: async () => ({ valid: true }) },
      model: { generate: async () => ({ locale: "en-US", statements: [] }) },
      repository: { readSource: vi.fn(), startGeneration: vi.fn(), publish: vi.fn(), recordValidationFailure: vi.fn(), readLatestCurrent },
    });

    await expect(service.readLatest({ userId: "user-1", expectedDataEpoch: 3 })).resolves.toMatchObject({ logicalDate: "2026-08-12" });
    expect(readLatestCurrent).toHaveBeenCalledWith({ userId: "user-1", expectedDataEpoch: 3 });
  });
});
