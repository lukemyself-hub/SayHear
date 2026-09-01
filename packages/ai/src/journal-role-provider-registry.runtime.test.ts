import { describe, expect, it, vi } from "vitest";

import {
  asConversationEventRevisionId,
  type ProviderDispatchErrorCategory,
} from "@sayhear/application";

const { capturedMessages, failWithCategory, mockOutput } = vi.hoisted<{
  capturedMessages: unknown[];
  failWithCategory: { current: ProviderDispatchErrorCategory | null };
  mockOutput: { current: string };
}>(() => ({
  capturedMessages: [],
  failWithCategory: { current: null },
  mockOutput: {
    current: '[{"locatorType":"text_span","locatorKey":"0:3","role":"factual_support"}]',
  },
}));

const DEFAULT_DELTA =
  '[{"locatorType":"text_span","locatorKey":"0:3","role":"factual_support"}]';

// The runtime (responses-api) adapter path is exercised here so the opaque
// placeholder revision used to build provider messages is checked against the
// same UUIDv7 id fence that guards real committed revisions. The regression
// this guards against: askJson() built every provider message with a UUIDv4
// placeholder ("00000000-0000-4000-..."), so the fence threw
// "ConversationEventRevisionId must be an opaque UUIDv7." on every
// evidence.extract / journal.draft / journal.validate call (incident 2026-08-17).
vi.mock("./responses-api-conversation-text-model", async () => {
  const { ProviderDispatchError } = await import("@sayhear/application");
  return {
    createResponsesApiConversationTextModel: () => ({
      async *stream(request: { messages: unknown[] }) {
        if (failWithCategory.current) {
          throw new ProviderDispatchError(failWithCategory.current);
        }
        capturedMessages.push(request.messages);
        yield { type: "delta", delta: mockOutput.current };
      },
    }),
  };
});

import { createRuntimeJournalRoleProviderRegistry } from "./journal-role-provider-registry";

const roles = [
  { role: "evidence.extract" as const, provider: "openai" as const, model: "gpt-test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
  { role: "journal.draft" as const, provider: "openai" as const, model: "gpt-test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
  { role: "journal.validate" as const, provider: "openai" as const, model: "gpt-test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
  { role: "dialogue.state" as const, provider: "openai" as const, model: "gpt-test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
  { role: "summary.compress" as const, provider: "openai" as const, model: "gpt-test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
    { role: "memory.extract" as const, provider: "openai" as const, model: "test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
    { role: "entity.resolve" as const, provider: "openai" as const, model: "test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
    { role: "memory.consolidate" as const, provider: "openai" as const, model: "test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
] as const;

describe("Journal runtime role provider messages", () => {
  it("builds provider messages with an opaque UUIDv7 placeholder revision", async () => {
    const registry = createRuntimeJournalRoleProviderRegistry({
      adapter: { type: "responses-api", apiKey: "test", baseUrl: "https://example.test", timeoutMs: 1000 },
      roles,
    });
    await registry.evidenceExtractor.extract({ locale: "en-US", sourceText: "Walked home." });
    expect(capturedMessages).toHaveLength(1);
    const firstCallMessages = capturedMessages[0] as Array<{ revisionId: string }>;
    expect(firstCallMessages).toHaveLength(1);
    const revisionId = firstCallMessages[0]!.revisionId;
    expect(() => asConversationEventRevisionId(revisionId)).not.toThrow();
  });

  it("folds the provider dispatch category into the rethrown error message", async () => {
    failWithCategory.current = "authentication";
    try {
      const registry = createRuntimeJournalRoleProviderRegistry({
        adapter: { type: "responses-api", apiKey: "test", baseUrl: "https://example.test", timeoutMs: 1000 },
        roles,
      });
      // The rethrown error keeps the same category but its message now names
      // the role, model, and category so an incident log line is targetable.
      const error = await registry.evidenceExtractor
        .extract({ locale: "en-US", sourceText: "Walked home." })
        .then(() => null, (caught: unknown) => caught as Error);
      expect(error).not.toBeNull();
      expect(error!.message).toContain("evidence.extract");
      expect(error!.message).toContain("category authentication");
      expect(error!.message).toContain("baseUrl=https://example.test");
      expect(error!.message).toContain("timeoutMs=1000");
    } finally {
      failWithCategory.current = null;
    }
  });

  it("skips out-of-range locators instead of failing the whole extraction", async () => {
    mockOutput.current =
      '[{"locatorType":"text_span","locatorKey":"0:5","role":"factual_support"},{"locatorType":"text_span","locatorKey":"999:1005","role":"factual_support"}]';
    try {
      const registry = createRuntimeJournalRoleProviderRegistry({
        adapter: { type: "responses-api", apiKey: "test", baseUrl: "https://example.test", timeoutMs: 1000 },
        roles,
      });
      // The second span is beyond the 13-char source text; it must be dropped,
      // keeping the extraction viable (incident 2026-08-18, out-of-range
      // locator failing the evidence freeze).
      await expect(
        registry.evidenceExtractor.extract({ locale: "en-US", sourceText: "Walked home." }),
      ).resolves.toEqual([
        { locatorType: "text_span", locatorKey: "0:5", role: "factual_support" },
      ]);
    } finally {
      mockOutput.current = DEFAULT_DELTA;
    }
  });

  it("strips a markdown code fence before parsing provider JSON", async () => {
    mockOutput.current =
      '```json\n[{"locatorType":"text_span","locatorKey":"0:3","role":"factual_support"}]\n```';
    try {
      const registry = createRuntimeJournalRoleProviderRegistry({
        adapter: { type: "responses-api", apiKey: "test", baseUrl: "https://example.test", timeoutMs: 1000 },
        roles,
      });
      await expect(
        registry.evidenceExtractor.extract({ locale: "en-US", sourceText: "Walked home." }),
      ).resolves.toEqual([
        { locatorType: "text_span", locatorKey: "0:3", role: "factual_support" },
      ]);
    } finally {
      mockOutput.current = DEFAULT_DELTA;
    }
  });

  it("normalizes null structural fields in memory.extract proposals", async () => {
    // DeepSeek emits `"scopeKey": null` / `"typedValue": null` on correction
    // texts; before normalization these crashed the deterministic validator
    // with a TypeError that converged as provider unknown_error and lost the
    // revision's extraction entirely (issue #126 evidence runs).
    mockOutput.current = JSON.stringify([
      {
        revisionId: "rev-1",
        evidence: [{ locatorKey: "0:24", role: "factual_support" }],
        mentions: [
          {
            surfaceForm: null,
            startOffset: null,
            endOffset: null,
            mentionKind: "named",
            newIntroduction: true,
            entityKindId: "sh.entity.person",
            evidenceLocatorKey: null,
          },
          {
            surfaceForm: "Alex",
            startOffset: 0,
            endOffset: 4,
            mentionKind: "named",
            newIntroduction: true,
            entityKindId: "sh.entity.person",
            evidenceLocatorKey: null,
          },
        ],
        candidates: [
          {
            basis: "directly_stated",
            candidateKind: "objective",
            predicateId: "sh.relationship.partner_of",
            proposedConcept: null,
            typedValue: "spouse",
            scopeKey: null,
            subjectMentionIndex: null,
            objectMentionIndex: 1,
            evidenceLocatorKeys: ["0:24"],
            qualifiers: [
              {
                axisId: "role",
                roleSide: "subject",
                typedValue: "partner",
                evidenceLocatorKeys: null,
              },
            ],
            temporal: null,
            itemClass: "person",
            itemSummary: null,
          },
          {
            basis: "directly_stated",
            candidateKind: "objective",
            predicateId: "sh.life.family_stage",
            proposedConcept: null,
            typedValue: null,
            scopeKey: null,
            subjectMentionIndex: null,
            objectMentionIndex: null,
            evidenceLocatorKeys: ["0:24"],
            qualifiers: null,
            temporal: null,
            itemClass: "open",
            itemSummary: null,
          },
        ],
        clarifications: null,
      },
    ]);
    try {
      const registry = createRuntimeJournalRoleProviderRegistry({
        adapter: { type: "responses-api", apiKey: "test", baseUrl: "https://example.test", timeoutMs: 1000 },
        roles,
      });
      const results = await registry.memoryExtractor.extract(
        {
          predicateIds: ["sh.relationship.partner_of", "sh.life.family_stage"],
          relationshipPredicateIds: ["sh.relationship.partner_of"],
          revisions: [
            {
              revisionId: "rev-1",
              sequenceNo: 1,
              locale: "en-US",
              text: "Alex is my boyfriend now.",
            },
          ],
        },
        {
          configVersion: "test",
          modelVersion: "test",
          promptVersion: "test",
        },
      );
      expect(results).toHaveLength(1);
      const revision = results[0]!;
      // Null scopeKey is the no-information shape of scope-none.
      const partner = revision.candidates.find(
        (candidate) => candidate.predicateId === "sh.relationship.partner_of",
      )!;
      expect(partner.scopeKey).toBe("");
      // A typed value on a relationship predicate is dropped, not rejected.
      expect(partner.typedValue).toBe("");
      // Qualifier evidence normalizes to the empty array, not a crash.
      expect(partner.qualifiers[0]!.evidenceLocatorKeys).toEqual([]);
      // A null typedValue on a non-relationship candidate drops the candidate.
      expect(
        revision.candidates.some(
          (candidate) => candidate.predicateId === "sh.life.family_stage",
        ),
      ).toBe(false);
      // A null surface form normalizes to "" so validation rejects the
      // mention as invalid instead of crashing on `.trim()`.
      expect(revision.mentions[0]!.surfaceForm).toBe("");
      expect(revision.mentions[1]!.surfaceForm).toBe("Alex");
      expect(revision.clarifications).toEqual([]);
    } finally {
      mockOutput.current = DEFAULT_DELTA;
    }
  });

  it("keeps unmapped proposals with a non-empty concept when typed value is empty (#147)", async () => {
    const sourceText = "My neighbor is kind.";
    mockOutput.current = JSON.stringify([
      {
        revisionId: "rev-1",
        evidence: [
          { locatorKey: `0:${sourceText.length}`, role: "factual_support" },
        ],
        mentions: [],
        candidates: [
          {
            basis: "directly_stated",
            candidateKind: "objective",
            predicateId: null,
            proposedConcept: "neighbor relationship",
            typedValue: "",
            scopeKey: "",
            subjectMentionIndex: null,
            objectMentionIndex: null,
            evidenceLocatorKeys: [`0:${sourceText.length}`],
            qualifiers: [],
            temporal: {
              temporalStatus: "current",
              validFrom: null,
              validFromPrecision: "unknown",
              validTo: null,
              validToPrecision: "unknown",
            },
            itemClass: "open",
            itemSummary: "neighbor relationship",
          },
          {
            predicateId: null,
            proposedConcept: "  ",
            typedValue: "",
          },
        ],
        clarifications: [],
      },
    ]);
    try {
      const registry = createRuntimeJournalRoleProviderRegistry({
        adapter: { type: "responses-api", apiKey: "test", baseUrl: "https://example.test", timeoutMs: 1000 },
        roles,
      });
      const results = await registry.memoryExtractor.extract(
        {
          predicateIds: [],
          relationshipPredicateIds: [],
          revisions: [
            {
              revisionId: "rev-1",
              sequenceNo: 1,
              locale: "en-US",
              text: sourceText,
            },
          ],
        },
        {
          configVersion: "test",
          modelVersion: "test",
          promptVersion: "test",
        },
      );
      expect(results[0]?.candidates).toHaveLength(1);
      expect(results[0]?.candidates[0]).toMatchObject({
        predicateId: null,
        proposedConcept: "neighbor relationship",
        typedValue: "",
      });
    } finally {
      mockOutput.current = DEFAULT_DELTA;
    }
  });
});
