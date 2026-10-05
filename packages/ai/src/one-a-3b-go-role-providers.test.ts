import {
  asDailySessionId,
  asUserId,
  ONE_A_3B_ROLE_POLICIES,
  ONE_A_3B_ROLE_POLICY_VERSION,
  ProviderDispatchError,
  type ModelRoleCallUsage,
  type ModelRoleConfigurationSnapshot,
  type NarrativeValidatorModelRequest,
  type ReflectionGenerationModelRequest,
  type EpisodeBuildModelRequest,
} from "@sayhear/application";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeOneA3bRoleProviders } from "./one-a-3b-role-providers";

const GO_MODEL = "deepseek-v4.1-flash";

function configuration(
  role: ModelRoleConfigurationSnapshot["role"],
): ModelRoleConfigurationSnapshot {
  const policy = ONE_A_3B_ROLE_POLICIES[role];
  return {
    role,
    configVersion: `${role}:g1-release:v-test`,
    provider: "opencode-go",
    model: GO_MODEL,
    modelSnapshot: GO_MODEL,
    promptVersion: `${role}:eval:v1`,
    schemaVersion: `${role}:schema:v1`,
    rolePolicyVersion: ONE_A_3B_ROLE_POLICY_VERSION,
    providerPolicyVersion: `opencode-go-${role}-egress:g1-release:v-test`,
    rolloutPin: `${role}-g1-release-pin:v15`,
    freshnessPolicy: policy.freshnessPolicy,
    fallbackMode: "disabled",
    maxTechnicalRetries: policy.maxTechnicalRetries,
    maxSemanticRepairs: policy.maxSemanticRepairs,
    parameterSnapshot: {
      maxOutputTokens: 10000,
      reasoning: { effort: "low" },
      temperature: 0.2,
    },
  };
}

const CONFIGURATIONS = [
  configuration("episode.build"),
  configuration("reflection.daily"),
  configuration("reflection.weekly"),
  configuration("narrative.validate"),
];

const EPISODE_REQUEST: EpisodeBuildModelRequest = {
  activeEpisodes: [],
  dailySessionId: asDailySessionId("01984477-59a9-7d20-9d97-e588769566a1"),
  evidence: [],
  kindCatalog: [],
  sourceRevision: 0,
  userId: asUserId("01984477-59a9-7d20-9d97-e588769566a0"),
};

const REFLECTION_REQUEST: ReflectionGenerationModelRequest = {
  baseline: [],
  episodes: [],
  evidence: [
    {
      dailySessionId: asDailySessionId("01984477-59a9-7d20-9d97-e588769566a1"),
      evidenceItemId: "01984477-59a9-7d20-9d97-e588769566b1" as never,
      locale: "en-US",
      locatorKey: "0:4",
      locatorType: "text_span",
      logicalDate: "2026-10-01",
      revisionId: "01984477-59a9-7d20-9d97-e588769566c1",
      sourceText: "text",
    },
  ],
  locale: "en-US",
  maxCandidateProposals: 0,
  maxPropositionsPerStatement: 1,
  maxStatements: 1,
  role: "reflection.daily",
  scopeType: "daily_session",
  sessionCount: 1,
  summaries: [],
  userId: asUserId("01984477-59a9-7d20-9d97-e588769566a0"),
  weekIdentifier: null,
};

const NARRATIVE_REQUEST: NarrativeValidatorModelRequest = {
  artifactKind: "reflection",
  draftLocale: "en-US",
  draftRef: "reflection-daily:01984477-59a9-7d20-9d97-e588769566a1",
  draftText: "the user repaired a radio.",
  sourceEntries: [
    {
      epistemicKind: "objective_memory",
      sourceKey: "syn-claim-1",
      sourceKind: "memory_claim_version",
      text: "the user repairs radios.",
    },
  ],
  userId: asUserId("01984477-59a9-7d20-9d97-e588769566a0"),
};

function goChatSse(content: string): string {
  return (
    `data: ${JSON.stringify({
      choices: [{ delta: { content }, finish_reason: null, index: 0 }],
      id: "chatcmpl_x",
      model: GO_MODEL,
    })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      id: "chatcmpl_x",
      model: GO_MODEL,
      usage: { completion_tokens: 5, prompt_tokens: 7, total_tokens: 12 },
    })}\n\n` +
    `data: [DONE]\n\n`
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenCode Go role providers", () => {
  it("sends the Chat Completions shape for all four G1 roles", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("upstream boom", { status: 500 });
      }),
    );
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [{ apiKey: "go-key", provider: "opencode-go", timeoutMs: 5000 }],
      configurations: CONFIGURATIONS,
    });

    await expect(
      providers.episodeBuildProvider.buildProposals(EPISODE_REQUEST),
    ).rejects.toBeInstanceOf(ProviderDispatchError);
    await expect(
      providers.reflectionProvider.generate(REFLECTION_REQUEST),
    ).rejects.toBeInstanceOf(ProviderDispatchError);
    await expect(
      providers.narrativeValidationProvider.validateNarrative(
        NARRATIVE_REQUEST,
      ),
    ).rejects.toBeInstanceOf(ProviderDispatchError);

    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body.model).toBe(GO_MODEL);
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body.max_tokens).toBe(10000);
      expect(body.reasoning_effort).toBe("low");
      expect(body.thinking).toEqual({ type: "enabled" });
      // Responses-only fields never reach the Chat Completions wire.
      expect(body).not.toHaveProperty("max_output_tokens");
      expect(body).not.toHaveProperty("maxOutputTokens");
      expect(body).not.toHaveProperty("input");
      expect(Array.isArray(body.messages)).toBe(true);
    }
  });

  it("reports usage exactly once on a terminal failure after usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "{}" }, finish_reason: null, index: 0 }],
            id: "chatcmpl_x",
            model: GO_MODEL,
            usage: {
              completion_tokens: 5,
              prompt_tokens: 7,
              total_tokens: 12,
            },
          })}\n\n` +
            `data: ${JSON.stringify({ error: { message: "boom" } })}\n\n`,
          { headers: { "content-type": "text/event-stream" }, status: 200 },
        ),
      ),
    );
    const usages: ModelRoleCallUsage[] = [];
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [{ apiKey: "go-key", provider: "opencode-go", timeoutMs: 5000 }],
      configurations: CONFIGURATIONS,
    });

    await expect(
      providers.narrativeValidationProvider.validateNarrative(
        NARRATIVE_REQUEST,
        (usage) => usages.push(usage),
      ),
    ).rejects.toBeInstanceOf(ProviderDispatchError);

    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ inputTokens: 7, outputTokens: 5 });
  });

  it("accepts a valid Go reply for narrative.validate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          goChatSse(
            JSON.stringify({
              coverageKeys: ["syn-claim-1"],
              propositions: [
                {
                  ambiguous: false,
                  contradicted: false,
                  epistemicRendering: "confirmed",
                  propositionKey: "p1",
                  propositionKind: "fact",
                  supportKeys: ["syn-claim-1"],
                  text: "the user repaired a radio.",
                  unsupported: false,
                },
              ],
            }),
          ),
          { headers: { "content-type": "text/event-stream" }, status: 200 },
        ),
      ),
    );
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [{ apiKey: "go-key", provider: "opencode-go", timeoutMs: 5000 }],
      configurations: CONFIGURATIONS,
    });
    await expect(
      providers.narrativeValidationProvider.validateNarrative(
        NARRATIVE_REQUEST,
      ),
    ).resolves.toMatchObject({ coverageKeys: ["syn-claim-1"] });
  });

  it("refuses a mismatched returned snapshot without renaming it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          goChatSse("{}").replaceAll(GO_MODEL, "some-other-model"),
          { headers: { "content-type": "text/event-stream" }, status: 200 },
        ),
      ),
    );
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [{ apiKey: "go-key", provider: "opencode-go", timeoutMs: 5000 }],
      configurations: CONFIGURATIONS,
    });
    await expect(
      providers.narrativeValidationProvider.validateNarrative(
        NARRATIVE_REQUEST,
      ),
    ).rejects.toBeInstanceOf(ProviderDispatchError);
  });
});

describe("OpenCode Go strict role scopes", () => {
  it("rejects a Go weekly reflection without a week identifier before any fetch", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [{ apiKey: "go-key", provider: "opencode-go", timeoutMs: 5000 }],
      configurations: CONFIGURATIONS,
    });
    for (const weekIdentifier of [null, "", "   "]) {
      await expect(
        providers.reflectionProvider.generate({
          ...REFLECTION_REQUEST,
          role: "reflection.weekly",
          weekIdentifier,
        }),
      ).rejects.toMatchObject({ category: "configuration" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a Go daily reflection with no evidence Daily Session before any fetch", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [{ apiKey: "go-key", provider: "opencode-go", timeoutMs: 5000 }],
      configurations: CONFIGURATIONS,
    });
    // A weekly identifier is present, but the Go daily scope must never borrow
    // it: the daily role needs its own evidence Daily Session.
    await expect(
      providers.reflectionProvider.generate({
        ...REFLECTION_REQUEST,
        evidence: [],
        weekIdentifier: "2026-W40",
      }),
    ).rejects.toMatchObject({ category: "configuration" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a Go narrative.validate with a blank draft reference before any fetch", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [{ apiKey: "go-key", provider: "opencode-go", timeoutMs: 5000 }],
      configurations: CONFIGURATIONS,
    });
    for (const draftRef of ["", "   "]) {
      await expect(
        providers.narrativeValidationProvider.validateNarrative({
          ...NARRATIVE_REQUEST,
          draftRef,
        }),
      ).rejects.toMatchObject({ category: "configuration" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the weekly and daily Go scopes stable across requests", async () => {
    const sessions: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sessions.push(
          (init?.headers as Record<string, string>)["x-opencode-session"]!,
        );
        return new Response("upstream boom", { status: 500 });
      }),
    );
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [{ apiKey: "go-key", provider: "opencode-go", timeoutMs: 5000 }],
      configurations: CONFIGURATIONS,
    });
    const weekly = {
      ...REFLECTION_REQUEST,
      role: "reflection.weekly" as const,
      weekIdentifier: "2026-W40",
    };
    for (const request of [
      weekly,
      weekly,
      { ...weekly, weekIdentifier: "2026-W41" },
      REFLECTION_REQUEST,
      REFLECTION_REQUEST,
    ]) {
      await expect(
        providers.reflectionProvider.generate(request),
      ).rejects.toBeInstanceOf(ProviderDispatchError);
    }
    expect(sessions).toHaveLength(5);
    for (const session of sessions) {
      expect(session).toMatch(/^[a-f0-9]{64}$/);
    }
    // Same week (and same day) reuse one session; a different week differs.
    expect(sessions[0]).toBe(sessions[1]);
    expect(sessions[2]).not.toBe(sessions[0]);
    expect(sessions[3]).toBe(sessions[4]);
    expect(sessions[3]).not.toBe(sessions[0]);
  });
});
