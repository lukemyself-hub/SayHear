import { describe, expect, it } from "vitest";

import {
  ONE_A_3B_G1_ENABLED_ROLES,
  ONE_A_3B_G2_ENABLED_ROLES,
  ONE_A_3B_ROLE_POLICIES,
  asEvidenceItemId,
  asUserId,
  type ModelRoleConfigurationSnapshot,
  type OneA3bModelRole,
} from "@sayhear/application";

import { createRuntimeOneA3bRoleProviders } from "./one-a-3b-role-providers";

function configuration(role: OneA3bModelRole): ModelRoleConfigurationSnapshot {
  const policy = ONE_A_3B_ROLE_POLICIES[role];
  return {
    role,
    configVersion: `${role}:config:v1`,
    provider: "deepseek",
    model: "synthetic-model",
    modelSnapshot: "synthetic-model@2026-09-15",
    promptVersion: `${role}-prompt:v1`,
    schemaVersion: `${role}-schema:v1`,
    rolePolicyVersion: "1a3b-model-role-policy:v1",
    providerPolicyVersion: `${role}-egress:v1`,
    rolloutPin: `${role}-rollout:v1`,
    freshnessPolicy: policy.freshnessPolicy,
    fallbackMode: "disabled",
    maxTechnicalRetries: policy.maxTechnicalRetries,
    maxSemanticRepairs: policy.maxSemanticRepairs,
    parameterSnapshot: { temperature: 0 },
  };
}

function streamEvents(deltas: readonly string[], model: string): string {
  return [
    ...deltas.map(
      (delta) =>
        `event: response.output_text.delta\r\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta })}\r\n\r\n`,
    ),
    `event: response.completed\r\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_synthetic", model, usage: { input_tokens: 12, output_tokens: 4 } } })}\r\n\r\n`,
  ].join("");
}

function fakeFetch(output: string, model: string) {
  return async () =>
    new Response(streamEvents([output], model), {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    });
}

const extractRequest = {
  userId: asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68"),
  eventRevisionId: "01984477-2f9a-7b25-a5cc-83c3b21fbc68",
  locale: "en-US",
  timeZone: "America/Los_Angeles",
  userText: "My flight to Berlin is next Friday.",
  evidenceCommittedAt: "2026-09-15T10:00:00.000Z",
  evidence: [
    {
      evidenceItemId: asEvidenceItemId("01984477-5f9a-7b25-a5cc-83c3b21fbc68"),
      revisionId: "revision-1",
      locatorType: "whole_revision",
      locatorKey: "revision:revision-1",
      committedAt: "2026-09-15T10:00:00.000Z",
    },
  ],
  openLoops: [],
};

describe("G2 open_loop.extract runtime provider", () => {
  it("returns typed transient proposals and closure assertions for the frozen input", async () => {
    const configurations = ONE_A_3B_G2_ENABLED_ROLES.map(configuration);
    let requestBody: Record<string, unknown> | undefined;
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [
        {
          apiKey: "synthetic-server-key",
          baseUrl: "https://api.deepseek.com",
          provider: "deepseek",
          timeoutMs: 1000,
          fetchImplementation: (async (_url: unknown, init?: {
            body?: unknown;
          }) => {
            requestBody = JSON.parse(String(init?.body)) as Record<
              string,
              unknown
            >;
            return fakeFetch(
              JSON.stringify({
                proposals: [
                  {
                    kind: "upcoming_event",
                    evidenceItemId: "evidence-1",
                    evidenceRevisionId: "revision-1",
                    hasRealAnchor: true,
                    isTaskLike: false,
                    userTimeExpression: "next Friday",
                    expectedWindow: null,
                    proposalIndex: 0,
                  },
                ],
                closures: [],
              }),
              "synthetic-model@2026-09-15",
            )();
          }) as typeof fetch,
        },
      ],
      configurations,
    });

    const output = await providers.openLoopExtractProvider?.extractProposals(
      extractRequest,
    );
    expect(output?.proposals).toHaveLength(1);
    expect(output?.proposals[0]).toMatchObject({
      kind: "upcoming_event",
      evidenceItemId: "evidence-1",
      proposalIndex: 0,
    });
    expect(output?.closures).toEqual([]);
    expect(requestBody?.model).toBe("synthetic-model");
    expect(String(requestBody?.instructions)).toContain(
      "open_loop.extract-prompt:v1",
    );
  });

  it("rejects a proposal outside the frozen extract schema", async () => {
    const configurations = ONE_A_3B_G2_ENABLED_ROLES.map(configuration);
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [
        {
          apiKey: "synthetic-server-key",
          baseUrl: "https://api.deepseek.com",
          provider: "deepseek",
          timeoutMs: 1000,
          fetchImplementation: fakeFetch(
            JSON.stringify({
              proposals: [
                {
                  kind: "reminder",
                  evidenceItemId: "evidence-1",
                  evidenceRevisionId: "revision-1",
                  hasRealAnchor: true,
                  isTaskLike: false,
                  proposalIndex: 0,
                },
              ],
              closures: [],
            }),
            "synthetic-model@2026-09-15",
          ) as typeof fetch,
        },
      ],
      configurations,
    });

    await expect(
      providers.openLoopExtractProvider?.extractProposals(extractRequest),
    ).rejects.toThrow("invalid output schema");
  });

  it("rejects a model snapshot that does not match the pinned configuration", async () => {
    const configurations = ONE_A_3B_G2_ENABLED_ROLES.map(configuration);
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [
        {
          apiKey: "synthetic-server-key",
          baseUrl: "https://api.deepseek.com",
          provider: "deepseek",
          timeoutMs: 1000,
          fetchImplementation: fakeFetch(
            JSON.stringify({ proposals: [], closures: [] }),
            "synthetic-model@2026-09-16",
          ) as typeof fetch,
        },
      ],
      configurations,
    });

    await expect(
      providers.openLoopExtractProvider?.extractProposals(extractRequest),
    ).rejects.toThrow("expected synthetic-model@2026-09-15");
  });

  it("leaves the extract lane closed when the G2 bundle has no evaluated config", () => {
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [
        {
          apiKey: "synthetic-server-key",
          baseUrl: "https://api.deepseek.com",
          provider: "deepseek",
          timeoutMs: 1000,
        },
      ],
      configurations: ONE_A_3B_G1_ENABLED_ROLES.map(configuration),
    });

    expect(providers.openLoopExtractProvider).toBeUndefined();
    expect(providers.episodeBuildProvider.role).toBe("episode.build");
  });
});

const segmentRequest = {
  userId: asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68"),
  locale: "en-US",
  mainText: "That sounds like a full week already.",
  targetKind: "open_loop" as const,
  targetId: "loop-1",
  targetVersionId: "loop-version-1",
  targetRef: {
    targetKind: "open_loop" as const,
    targetId: "loop-1",
    targetVersionId: "loop-version-1",
  },
  targetSummary: "Flight to Berlin next Friday",
  targetSensitive: false,
  opportunity: "natural_gap" as const,
};

const dispositionRequest = {
  userId: asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68"),
  locale: "en-US",
  userText: "Yeah, still on for Friday.",
  segmentText: "How did the Berlin flight go?",
  use: {
    useId: "use-1",
    assistantEventRevisionId: "assistant-revision-1",
    targetKind: "open_loop" as const,
    targetId: "loop-1",
    targetVersionId: "loop-version-1",
  },
  finalTextLocator: {
    kind: "assistant_event_revision" as const,
    assistantEventRevisionId: "assistant-revision-1",
    segment: "proactive_followup" as const,
    ordinal: 0 as const,
  },
};

function proactiveProviders(output: string) {
  return createRuntimeOneA3bRoleProviders({
    adapters: [
      {
        apiKey: "synthetic-server-key",
        baseUrl: "https://api.deepseek.com",
        provider: "deepseek",
        timeoutMs: 1000,
        fetchImplementation: fakeFetch(
          output,
          "synthetic-model@2026-09-15",
        ) as typeof fetch,
      },
    ],
    configurations: ONE_A_3B_G2_ENABLED_ROLES.map(configuration),
  });
}

describe("G2 proactive.followup runtime provider", () => {
  it("renders a typed segment that echoes the pinned target", async () => {
    const providers = proactiveProviders(
      JSON.stringify({
        content: "How did the Berlin flight go?",
        expressionKind: "question",
        targetRef: {
          targetId: "loop-1",
          targetKind: "open_loop",
          targetVersionId: "loop-version-1",
        },
      }),
    );

    const output =
      await providers.proactiveFollowupProvider?.generateSegment(
        segmentRequest,
      );
    expect(output?.expressionKind).toBe("question");
    expect(output?.targetRef).toMatchObject({
      targetId: "loop-1",
      targetVersionId: "loop-version-1",
    });
  });

  it("classifies the next-event disposition with the committed use locator", async () => {
    const providers = proactiveProviders(
      JSON.stringify({
        signal: "short_response",
        finalTextLocator: {
          kind: "assistant_event_revision",
          assistantEventRevisionId: "assistant-revision-1",
          segment: "proactive_followup",
          ordinal: 0,
        },
      }),
    );

    const output =
      await providers.proactiveFollowupProvider?.classifyDisposition(
        dispositionRequest,
      );
    expect(output?.signal).toBe("short_response");
  });

  it("rejects a system-only ambiguous_closure signal from the model", async () => {
    const providers = proactiveProviders(
      JSON.stringify({
        signal: "ambiguous_closure",
        finalTextLocator: {
          kind: "assistant_event_revision",
          assistantEventRevisionId: "assistant-revision-1",
          segment: "proactive_followup",
          ordinal: 0,
        },
      }),
    );

    await expect(
      providers.proactiveFollowupProvider?.classifyDisposition(
        dispositionRequest,
      ),
    ).rejects.toThrow("invalid output schema");
  });

  it("rejects a segment that fails the frozen expression schema", async () => {
    const providers = proactiveProviders(
      JSON.stringify({ content: "", expressionKind: "nudge" }),
    );

    await expect(
      providers.proactiveFollowupProvider?.generateSegment(segmentRequest),
    ).rejects.toThrow("invalid output schema");
  });

  it("leaves the proactive lane closed when the G2 bundle has no evaluated config", () => {
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [
        {
          apiKey: "synthetic-server-key",
          baseUrl: "https://api.deepseek.com",
          provider: "deepseek",
          timeoutMs: 1000,
        },
      ],
      configurations: ONE_A_3B_G1_ENABLED_ROLES.map(configuration),
    });

    expect(providers.proactiveFollowupProvider).toBeUndefined();
  });
});
