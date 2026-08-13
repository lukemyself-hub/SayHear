import { describe, expect, it } from "vitest";

import { createRuntimeJournalRoleProviderRegistry } from "./journal-role-provider-registry";

const evidence = [
  { id: "one", sourceEventId: "event-one", sourceRevisionId: "revision-one", sourceActor: "user" as const, sourceStatus: "final" as const, locatorType: "text_span" as const, locatorKey: "0:3", role: "factual_support" as const },
  { id: "two", sourceEventId: "event-two", sourceRevisionId: "revision-two", sourceActor: "user" as const, sourceStatus: "corrected" as const, locatorType: "text_span" as const, locatorKey: "4:7", role: "factual_support" as const },
];

describe("Journal role safeguards", () => {
  const roles = [
    { role: "evidence.extract" as const, provider: "deterministic" as const, model: "test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
    { role: "journal.draft" as const, provider: "deterministic" as const, model: "test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
    { role: "journal.validate" as const, provider: "deterministic" as const, model: "test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
  ] as const;
  const registry = createRuntimeJournalRoleProviderRegistry({ adapter: { type: "deterministic" }, roles });

  it("extracts one immutable text span for each substantive sentence", async () => {
    await expect(registry.evidenceExtractor.extract({ locale: "en-US", sourceText: "Walked home. Called a friend." }))
      .resolves.toEqual([
        { locatorType: "text_span", locatorKey: "0:12", role: "factual_support" },
        { locatorType: "text_span", locatorKey: "13:29", role: "factual_support" },
      ]);
  });

  it("rejects a Journal which omits frozen Evidence", async () => {
    const result = await registry.validator.validate({
      draft: { locale: "en-US", statements: [{ id: "s", text: "The owner walked home.", epistemicStatus: "supported_expression", evidenceItemIds: ["one"] }] },
      evidenceItems: evidence,
      sourceTextByEvidenceId: { one: "Walked home.", two: "Called a friend." },
    });
    expect(result).toEqual({ valid: false, reason: "material_evidence_omitted" });
  });
});
