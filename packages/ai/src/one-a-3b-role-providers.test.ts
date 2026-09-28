import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ONE_A_3B_ROLE_POLICY_VERSION,
  ONE_A_3B_ROLE_POLICIES,
  ProviderDispatchError,
  asUserId,
  type ModelRoleConfigurationSnapshot,
  type NarrativeValidatorModelRequest,
} from "@sayhear/application";

import { createRuntimeOneA3bRoleProviders } from "./one-a-3b-role-providers";

const ROLES = [
  "episode.build",
  "reflection.daily",
  "reflection.weekly",
  "narrative.validate",
] as const;

const MAX_OUTPUT_TOKENS = 4000;

function configurationFor(
  role: (typeof ROLES)[number],
): ModelRoleConfigurationSnapshot {
  const policy = ONE_A_3B_ROLE_POLICIES[role];
  return {
    role,
    configVersion: `${role}:test:v1`,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    modelSnapshot: "deepseek-flash",
    promptVersion: `${role}:test:v1`,
    schemaVersion: "narrative-findings:v1",
    rolePolicyVersion: ONE_A_3B_ROLE_POLICY_VERSION,
    providerPolicyVersion: `deepseek-${role}-egress:test:v1`,
    rolloutPin: `${role}-test-pin:v1`,
    freshnessPolicy: policy.freshnessPolicy,
    fallbackMode: "disabled",
    maxTechnicalRetries: policy.maxTechnicalRetries,
    maxSemanticRepairs: policy.maxSemanticRepairs,
    parameterSnapshot: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0 },
  };
}

const VALIDATOR_REQUEST: NarrativeValidatorModelRequest = {
  userId: asUserId("01984477-59a9-7d20-9d97-e588769566a0"),
  artifactKind: "reflection",
  draftRef: "reflection-daily:01984477-59a9-7d20-9d97-e588769566a1",
  draftLocale: "en-US",
  draftText: "PRIVATE_DRAFT_CANARY the user repaired a radio.",
  sourceEntries: [
    {
      sourceKey: "syn-claim-1",
      sourceKind: "memory_claim_version",
      text: "PRIVATE_SOURCE_CANARY the user repairs radios.",
      epistemicKind: "objective_memory",
    },
  ],
};

function stubResponsesApi(events: readonly string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(events.join(""), {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }),
    ),
  );
}

function completedEvent(options: {
  outputTokens: number;
  text?: string;
}): string {
  const deltas = options.text
    ? `event: response.output_text.delta\r\ndata: ${JSON.stringify({
        delta: options.text,
        type: "response.output_text.delta",
      })}\r\n\r\n`
    : "";
  return `${deltas}event: response.completed\r\ndata: ${JSON.stringify({
    response: {
      id: "resp_synthetic",
      model: "deepseek-flash",
      usage: { input_tokens: 900, output_tokens: options.outputTokens },
    },
    type: "response.completed",
  })}\r\n\r\n`;
}

function providers() {
  return createRuntimeOneA3bRoleProviders({
    adapters: [
      {
        apiKey: "synthetic-server-key",
        baseUrl: "https://api.deepseek.com",
        provider: "deepseek",
        timeoutMs: 5_000,
      },
    ],
    configurations: ROLES.map(configurationFor),
  });
}

async function validateAndCatch(): Promise<ProviderDispatchError> {
  let caught: unknown;
  try {
    await providers().narrativeValidationProvider.validateNarrative(
      VALIDATOR_REQUEST,
    );
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof ProviderDispatchError)) {
    throw new Error(`Expected a ProviderDispatchError, received ${String(caught)}.`);
  }
  return caught;
}

describe("G1 runtime role providers (issue #252 response diagnosis)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns a well-formed validator output without a failure", async () => {
    stubResponsesApi([
      completedEvent({
        outputTokens: 120,
        text: JSON.stringify({
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
      }),
    ]);

    await expect(
      providers().narrativeValidationProvider.validateNarrative(VALIDATOR_REQUEST),
    ).resolves.toMatchObject({ coverageKeys: ["syn-claim-1"] });
  });

  it("classifies a completed-but-empty final answer as empty_output", async () => {
    stubResponsesApi([completedEvent({ outputTokens: 12 })]);

    expect((await validateAndCatch()).failure).toMatchObject({
      kind: "empty_output",
      inputTokens: 900,
      outputLength: 0,
      outputTokens: 12,
      providerReason: null,
    });
  });

  it("reads an empty final answer spent to the frozen budget as output_budget_exhausted", async () => {
    // The observed #252 signature: HTTP 200, full reasoning spend against the
    // pinned cap, zero characters of final JSON. The cap is what separates
    // this from a Provider that simply emitted nothing.
    stubResponsesApi([completedEvent({ outputTokens: MAX_OUTPUT_TOKENS })]);

    expect((await validateAndCatch()).failure).toMatchObject({
      kind: "output_budget_exhausted",
      outputLength: 0,
      outputTokens: MAX_OUTPUT_TOKENS,
    });
  });

  it("classifies unparseable output that stayed under the budget as parse_failed", async () => {
    stubResponsesApi([completedEvent({ outputTokens: 40, text: "not json at all" })]);

    expect((await validateAndCatch()).failure).toMatchObject({
      kind: "parse_failed",
      outputLength: 15,
      outputTokens: 40,
    });
  });

  it("reads a parse failure at the frozen budget as output_budget_exhausted", async () => {
    // A Provider that truncates without reporting max_output_tokens is only
    // inferable: the reported output tokens reached the pinned cap, so the
    // remedy is a versioned budget, not a stricter parse.
    stubResponsesApi([
      completedEvent({ outputTokens: MAX_OUTPUT_TOKENS, text: '{"propositions":' }),
    ]);

    expect((await validateAndCatch()).failure).toMatchObject({
      kind: "output_budget_exhausted",
      outputLength: 16,
      outputTokens: MAX_OUTPUT_TOKENS,
    });
  });

  it("classifies a well-formed body that violates the frozen schema as schema_mismatch", async () => {
    stubResponsesApi([
      completedEvent({ outputTokens: 30, text: JSON.stringify({ propositions: "wrong" }) }),
    ]);

    expect((await validateAndCatch()).failure).toMatchObject({
      kind: "schema_mismatch",
      outputLength: 24,
    });
  });

  it("propagates a transport-proven budget exhaustion unchanged", async () => {
    stubResponsesApi([
      'event: response.incomplete\r\ndata: {"type":"response.incomplete","response":{"id":"resp_truncated","model":"deepseek-v4-flash","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":900,"output_tokens":4000}}}\r\n\r\n',
    ]);

    expect((await validateAndCatch()).failure).toMatchObject({
      kind: "output_budget_exhausted",
      providerReason: "max_output_tokens",
    });
  });

  it("keeps every classified failure free of draft and source text", async () => {
    stubResponsesApi([completedEvent({ outputTokens: 12 })]);

    const error = await validateAndCatch();
    const serialized = `${error.message}|${JSON.stringify(error.failure)}`;
    expect(serialized).not.toMatch(/PRIVATE_DRAFT_CANARY|PRIVATE_SOURCE_CANARY/);
    expect(Object.keys(error.failure ?? {}).sort()).toEqual([
      "inputTokens",
      "kind",
      "outputLength",
      "outputTokens",
      "providerReason",
    ]);
  });
});
