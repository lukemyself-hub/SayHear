import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRuntimeJournalRoleProviderRegistry,
  defaultJournalProviderSessionId,
  type JournalModelRole,
  type JournalRoleConfiguration,
} from "./journal-role-provider-registry";

/**
 * Representative frozen payloads for the Journal roles whose session scope is
 * derived from stable ids inside the model payload. `evidence.extract` is not
 * here: its owner + Daily Session travel in a separate transport field (see
 * the registry test below), never in the model-visible payload.
 */
const PAYLOADS: Readonly<Record<Exclude<JournalModelRole, "evidence.extract">, unknown>> = {
  "journal.draft": {
    evidenceItems: [{ id: "01984477-59a9-7d20-9d97-e588769566b1" }],
    locale: "en-US",
    sourceTextByEvidenceId: { "01984477-59a9-7d20-9d97-e588769566b1": "text" },
  },
  "journal.validate": {
    draft: { locale: "en-US", statements: [] },
    evidenceItems: [{ id: "01984477-59a9-7d20-9d97-e588769566b1" }],
    sourceTextByEvidenceId: {},
  },
  "dialogue.state": {
    sources: [
      { actor: "user", revisionId: "01984477-59a9-7d20-9d97-e588769566c1", text: "hi" },
    ],
  },
  "summary.compress": {
    sources: [
      { revisionId: "01984477-59a9-7d20-9d97-e588769566c1", text: "hi" },
    ],
  },
  "memory.extract": {
    revisions: [
      {
        locale: "en-US",
        revisionId: "01984477-59a9-7d20-9d97-e588769566d1",
        sequenceNo: 1,
        text: "hi",
      },
    ],
  },
  "entity.resolve": {
    candidates: [
      { candidateKind: "person", entityId: "01984477-59a9-7d20-9d97-e588769566e1", matchedLabel: "Al" },
    ],
    contextText: "",
    surfaceForm: "Al",
  },
  "memory.consolidate": {
    candidates: [{ id: "01984477-59a9-7d20-9d97-e588769566f1" }],
    claims: [{ claimId: "01984477-59a9-7d20-9d97-e58876956701" }],
  },
};

describe("defaultJournalProviderSessionId", () => {
  it("derives a stable opaque scope for every payload-derived Journal role", () => {
    for (const [role, payload] of Object.entries(PAYLOADS) as [
      Exclude<JournalModelRole, "evidence.extract">,
      unknown,
    ][]) {
      const first = defaultJournalProviderSessionId(role, payload);
      const second = defaultJournalProviderSessionId(role, payload);
      expect(first, role).toBe(second);
      expect(first, role).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("separates different roles even with identical id shapes", () => {
    const draft = defaultJournalProviderSessionId("journal.draft", {
      evidenceItems: [{ id: "same-id" }],
    });
    const validate = defaultJournalProviderSessionId("journal.validate", {
      evidenceItems: [{ id: "same-id" }],
    });
    expect(draft).not.toBe(validate);
  });

  it("fails closed when a payload carries no trusted id", () => {
    expect(() =>
      defaultJournalProviderSessionId("journal.draft", {
        locale: "en-US",
        sourceText: "free text is not an identity",
      }),
    ).toThrow(/no trusted logical scope/);
  });

  it("fails closed for a bare evidence.extract model payload", () => {
    // The owner + Daily Session are transport metadata, not model payload; a
    // payload with only locale/text cannot invent a session identity.
    expect(() =>
      defaultJournalProviderSessionId("evidence.extract", {
        locale: "en-US",
        sourceText: "the user repaired a radio.",
      }),
    ).toThrow(/no trusted logical scope/);
  });
});

const GO_ROLES: readonly JournalRoleConfiguration[] = (
  [
    "evidence.extract",
    "journal.draft",
    "journal.validate",
    "dialogue.state",
    "summary.compress",
    "memory.extract",
    "entity.resolve",
    "memory.consolidate",
  ] as const
).map((role) => ({
  configVersion: "test",
  model: "deepseek-v4.1-flash",
  policyVersion: "test",
  promptFingerprint: "test",
  provider: "opencode-go" as const,
  role,
}));

const GO_DAY = "01984477-59a9-7d20-9d97-e588769566a1";
const GO_OWNER = "01984477-59a9-7d20-9d97-e588769566a0";

function goSse(content: string): string {
  const model = "deepseek-v4.1-flash";
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null, index: 0 }], model })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], model })}\n\n` +
    `data: [DONE]\n\n`
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Evidence OpenCode Go transport scope", () => {
  it("keeps owner and Daily Session out of the model payload and stable in the session header", async () => {
    const calls: { body: string; session: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        calls.push({
          body: String(init?.body),
          session: headers["x-opencode-session"]!,
        });
        return new Response(
          goSse(
            '[{"locatorType":"text_span","locatorKey":"0:3","role":"factual_support"}]',
          ),
          {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          },
        );
      }),
    );
    const registry = createRuntimeJournalRoleProviderRegistry({
      adapter: { apiKey: "go-key", timeoutMs: 1000, type: "opencode-go" },
      roles: GO_ROLES,
    });
    const transport = { dailySessionId: GO_DAY, userId: GO_OWNER };
    const instruction = {
      locale: "en-US",
      sourceText: "Walked home and called a friend.",
      transport,
    };
    await registry.evidenceExtractor.extract(instruction);
    await registry.evidenceExtractor.extract(instruction);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.body).not.toContain(GO_DAY);
      expect(call.body).not.toContain(GO_OWNER);
    }
    // Same owner + Daily Session, same Provider session across turns.
    expect(calls[0]!.session).toBe(calls[1]!.session);

    await registry.evidenceExtractor.extract({
      ...instruction,
      transport: { ...transport, dailySessionId: "01984477-59a9-7d20-9d97-e588769566ff" },
    });
    expect(calls[2]!.session).not.toBe(calls[0]!.session);
  });

  it("denies an evidence.extract Go call with no trusted transport scope before any fetch", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const registry = createRuntimeJournalRoleProviderRegistry({
      adapter: { apiKey: "go-key", timeoutMs: 1000, type: "opencode-go" },
      roles: GO_ROLES,
    });
    await expect(
      registry.evidenceExtractor.extract({
        locale: "en-US",
        sourceText: "Walked home and called a friend.",
      }),
    ).rejects.toMatchObject({ category: "configuration" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
