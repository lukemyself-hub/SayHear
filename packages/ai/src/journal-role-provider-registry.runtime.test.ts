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
});
