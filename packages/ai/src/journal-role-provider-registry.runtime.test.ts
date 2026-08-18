import { describe, expect, it, vi } from "vitest";

import { asConversationEventRevisionId } from "@sayhear/application";

const { capturedMessages } = vi.hoisted<{ capturedMessages: unknown[] }>(() => ({
  capturedMessages: [],
}));

// The runtime (responses-api) adapter path is exercised here so the opaque
// placeholder revision used to build provider messages is checked against the
// same UUIDv7 id fence that guards real committed revisions. The regression
// this guards against: askJson() built every provider message with a UUIDv4
// placeholder ("00000000-0000-4000-..."), so the fence threw
// "ConversationEventRevisionId must be an opaque UUIDv7." on every
// evidence.extract / journal.draft / journal.validate call (incident 2026-08-17).
vi.mock("./responses-api-conversation-text-model", () => ({
  createResponsesApiConversationTextModel: () => ({
    async *stream(request: { messages: unknown[] }) {
      capturedMessages.push(request.messages);
      yield {
        type: "delta",
        delta: '[{"locatorType":"text_span","locatorKey":"0:3","role":"factual_support"}]',
      };
    },
  }),
}));

import { createRuntimeJournalRoleProviderRegistry } from "./journal-role-provider-registry";

const roles = [
  { role: "evidence.extract" as const, provider: "openai" as const, model: "gpt-test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
  { role: "journal.draft" as const, provider: "openai" as const, model: "gpt-test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
  { role: "journal.validate" as const, provider: "openai" as const, model: "gpt-test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
  { role: "dialogue.state" as const, provider: "openai" as const, model: "gpt-test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
  { role: "summary.compress" as const, provider: "openai" as const, model: "gpt-test", configVersion: "test", policyVersion: "test", promptFingerprint: "test" },
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
});
