import { describe, expect, it } from "vitest";

import { createRuntimeJournalRoleProviderRegistry } from "./journal-role-provider-registry";
import { validateJournalDraft } from "@sayhear/application";

const evidence = [
  { id: "one", sourceEventId: "event-one", sourceRevisionId: "revision-one", sourceActor: "user" as const, sourceStatus: "final" as const, locatorType: "text_span" as const, locatorKey: "0:3", role: "factual_support" as const },
  { id: "two", sourceEventId: "event-two", sourceRevisionId: "revision-two", sourceActor: "user" as const, sourceStatus: "corrected" as const, locatorType: "text_span" as const, locatorKey: "4:7", role: "factual_support" as const },
];

describe("Journal role safeguards", () => {
  const roles = [
    { role: "evidence.extract" as const, provider: "deterministic" as const, model: "test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
    { role: "journal.draft" as const, provider: "deterministic" as const, model: "test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
    { role: "journal.validate" as const, provider: "deterministic" as const, model: "test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
    { role: "dialogue.state" as const, provider: "deterministic" as const, model: "test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
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

  it.each([
    ["en-US", "I finished a difficult task today."],
    ["zh-CN", "我今天完成了一项很难的任务。"],
    ["en-US", "I finished the task, 但是我还是有点担心明天。"],
  ])("produces an acceptable third-person Journal for %s source text", async (locale, sourceText) => {
    const fixtureEvidence = [{
      id: "one",
      sourceEventId: "event-one",
      sourceRevisionId: "revision-one",
      sourceActor: "user" as const,
      sourceStatus: "final" as const,
      locatorType: "text_span" as const,
      locatorKey: `0:${sourceText.length}`,
      role: "factual_support" as const,
    }];
    const draft = await registry.draft.generate({
      locale,
      evidenceItems: fixtureEvidence,
      sourceTextByEvidenceId: { one: sourceText },
    });
    expect(validateJournalDraft(draft, fixtureEvidence, locale)).toEqual({ valid: true });
    if (sourceText.includes("但是")) {
      expect(draft.statements[0]?.text).toBe(
        "The owner described: they finished the task, 但是还是有点担心明天。",
      );
    }
  });

  it("projects transient DialogueState with source-bound fields", async () => {
    const result = await registry.dialogueStateProjector.project({
      modelConfigVersion: "test",
      policyVersion: "test",
      promptVersion: "test",
      sources: [{
        actor: "user",
        revisionId: "01984477-59a9-7d20-9d97-e588769566a2" as never,
        sequence: 1,
        text: "The meeting was difficult.",
      }],
    });
    expect(result.currentTopic.value).toBe("The meeting was difficult.");
    expect(result.currentTopic.sourceRevisionIds).toHaveLength(1);
    expect(result.userIntent.value).toBe("sharing");
  });
});
