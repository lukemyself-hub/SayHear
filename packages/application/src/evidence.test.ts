import { describe, expect, it, vi } from "vitest";

import { createEvidenceService } from "./evidence";

const sessionId = "01984477-31e1-7595-92c6-06889cb0fdde";

describe("Evidence service", () => {
  it("passes only the frozen source boundary and versioned Champion to the repository", async () => {
    const freezeUserEvidence = vi.fn().mockResolvedValue({ outcome: "not_eligible" });
    const service = createEvidenceService({
      clock: () => new Date("2026-08-12T16:00:00.000Z"),
      expectedDataEpoch: 3,
      extractionPolicyVersion: "evidence-extraction:v1",
      champion: {
        configVersion: "evidence-champion:v1",
        model: "gpt-5.4",
        provider: "openai",
        providerPolicyVersion: "evidence-provider-egress:v1",
        snapshot: "gpt-5.4",
      },
      repository: { freezeUserEvidence, findEvidenceSnapshot: vi.fn().mockResolvedValue(null) },
    });

    await service.freeze({
      dailySessionId: sessionId,
      sourceRevision: 8,
      commandId: "journal-command-8",
      attemptId: "workflow-attempt-8",
    });

    expect(freezeUserEvidence).toHaveBeenCalledWith(expect.objectContaining({
      dailySessionId: sessionId,
      sourceRevision: 8,
      expectedDataEpoch: 3,
      extractionPolicyVersion: "evidence-extraction:v1",
      champion: expect.objectContaining({ configVersion: "evidence-champion:v1" }),
    }));
    expect(JSON.stringify(freezeUserEvidence.mock.calls[0]?.[0])).not.toContain("canonical_text");
  });

  it("fails closed for an invalid session id", async () => {
    const freezeUserEvidence = vi.fn();
    const service = createEvidenceService({
      clock: () => new Date(), expectedDataEpoch: 1,
      extractionPolicyVersion: "evidence-extraction:v1",
      champion: { configVersion: "c", model: "m", provider: "openai", providerPolicyVersion: "p", snapshot: "s" },
      repository: { freezeUserEvidence, findEvidenceSnapshot: vi.fn().mockResolvedValue(null) },
    });
    await expect(service.freeze({ dailySessionId: "not-a-uuid", sourceRevision: 1, commandId: "c", attemptId: "a" })).resolves.toEqual({ outcome: "not_found" });
    expect(freezeUserEvidence).not.toHaveBeenCalled();
  });

  it("does not create Evidence when the independent Evidence write switch is disabled", async () => {
    const freezeUserEvidence = vi.fn();
    const service = createEvidenceService({
      clock: () => new Date(), expectedDataEpoch: 1,
      extractionPolicyVersion: "evidence-extraction:v1",
      champion: { configVersion: "c", model: "m", provider: "openai", providerPolicyVersion: "p", snapshot: "s" },
      repository: { freezeUserEvidence, findEvidenceSnapshot: vi.fn().mockResolvedValue(null) },
      writesEnabled: false,
    });

    await expect(service.freeze({ dailySessionId: sessionId, sourceRevision: 1, commandId: "c", attemptId: "a" }))
      .resolves.toEqual({ outcome: "writes_disabled" });
    expect(freezeUserEvidence).not.toHaveBeenCalled();
  });
});
