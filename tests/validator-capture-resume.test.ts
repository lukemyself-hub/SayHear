import { afterEach, describe, expect, it, vi } from "vitest";

import {
  asUserId,
  type ModelRoleConfigurationSnapshot,
  type NarrativeValidatorModelRequest,
} from "@sayhear/application";
import { createRuntimeOneA3bRoleProviders } from "@sayhear/ai";

import g1ActivationPins from "../eval/continuation-acceptance-1a3b/g1-activation-pins.json";
import {
  assertResumeIdentity,
  snapshotFor,
  type PinsFile,
} from "../eval/continuation-acceptance-1a3b/run-validator-capture";

const configuration: ModelRoleConfigurationSnapshot = {
  role: "narrative.validate",
  configVersion: "narrative.validate:g1-release:1",
  provider: "deepseek",
  model: "deepseek-chat",
  modelSnapshot: "snapshot",
  promptVersion: "prompt",
  schemaVersion: "schema",
  rolePolicyVersion: "policy",
  providerPolicyVersion: "provider-policy",
  rolloutPin: "pin",
  freshnessPolicy: "exact_head:v1",
  fallbackMode: "disabled",
  maxTechnicalRetries: 0,
  maxSemanticRepairs: 0,
  parameterSnapshot: { maxOutputTokens: 8000, temperature: 0 },
};

const parameters = { maxOutputTokens: 8000, temperature: 0 };

const previousHeader = {
  catalogSha256: "sha256:catalog",
  configVersion: configuration.configVersion,
  gitCommit: "a".repeat(40),
  gitDirty: false,
  maxOutputTokens: 8000,
  model: configuration.model,
  modelSnapshot: configuration.modelSnapshot,
  parameters,
  pinsFingerprint: "sha256:pins",
  promptVersion: configuration.promptVersion,
  provider: configuration.provider,
  providerCallBudget: 1,
  schemaVersion: configuration.schemaVersion,
};

const current = {
  catalogSha256: "sha256:catalog",
  configuration,
  gitCommit: "a".repeat(40),
  gitDirty: false,
  parameters,
  pinsFingerprint: "sha256:pins",
};

describe("validator capture resume identity", () => {
  it("keeps completed cases only when code, catalog and pins all match", () => {
    expect(() => assertResumeIdentity(previousHeader, current)).not.toThrow();
  });

  it("refuses to relabel cases completed under a different pin set", () => {
    expect(() =>
      assertResumeIdentity(
        { ...previousHeader, pinsFingerprint: "sha256:other" },
        current,
      ),
    ).toThrow("pinsFingerprint");
    expect(() =>
      assertResumeIdentity({ ...previousHeader, parameters: { maxOutputTokens: 4000 } }, current),
    ).toThrow("parameters");
  });

  it("refuses to relabel cases completed under a different commit or catalog", () => {
    expect(() =>
      assertResumeIdentity({ ...previousHeader, gitCommit: "b".repeat(40) }, current),
    ).toThrow("gitCommit");
    expect(() =>
      assertResumeIdentity({ ...previousHeader, catalogSha256: "sha256:other" }, current),
    ).toThrow("catalogSha256");
  });

  it("refuses a previous report that does not record a clean execution", () => {
    expect(() =>
      assertResumeIdentity({ ...previousHeader, gitDirty: true }, current),
    ).toThrow("gitDirty");
    expect(() =>
      assertResumeIdentity({ ...previousHeader, gitCommit: undefined }, current),
    ).toThrow("gitCommit");
  });
});

const REAL_G1_PINS = g1ActivationPins as unknown as PinsFile;

const CAPTURE_ROLES = [
  "episode.build",
  "reflection.daily",
  "reflection.weekly",
  "narrative.validate",
] as const;

describe("snapshotFor carries the complete frozen pin parameters", () => {
  it("deep-equals the narrative.validate pin, keeping reasoning.effort low", () => {
    const snapshot = snapshotFor("narrative.validate", REAL_G1_PINS);

    expect(snapshot.parameterSnapshot).toEqual(
      REAL_G1_PINS.roles["narrative.validate"]!.parameters,
    );
    expect(snapshot.parameterSnapshot).toEqual({
      temperature: 0,
      maxOutputTokens: 48000,
      reasoning: { effort: "low" },
    });
  });

  it("preserves the complete low-reasoning generation pins", () => {
    // Episode now runs at its raised 32000-token cap with low reasoning effort.
    const episode = snapshotFor("episode.build", REAL_G1_PINS);
    expect(episode.parameterSnapshot).toEqual(
      REAL_G1_PINS.roles["episode.build"]!.parameters,
    );
    expect(episode.parameterSnapshot).toEqual({
      temperature: 0.2,
      maxOutputTokens: 32000,
      reasoning: { effort: "low" },
    });

    // The 2026-10-04 output-budget release raises Daily to 32000 and leaves
    // its prompt and low reasoning effort frozen.
    const daily = snapshotFor("reflection.daily", REAL_G1_PINS);
    expect(daily.parameterSnapshot).toEqual(
      REAL_G1_PINS.roles["reflection.daily"]!.parameters,
    );
    expect(daily.parameterSnapshot).toEqual({
      temperature: 0.2,
      maxOutputTokens: 32000,
      reasoning: { effort: "low" },
    });

    // The 2026-10-04 output-budget release raises Weekly to 48000 and leaves
    // its prompt and low reasoning effort frozen.
    const weekly = snapshotFor("reflection.weekly", REAL_G1_PINS);
    expect(weekly.parameterSnapshot).toEqual(
      REAL_G1_PINS.roles["reflection.weekly"]!.parameters,
    );
    expect(weekly.parameterSnapshot).toEqual({
      temperature: 0.2,
      maxOutputTokens: 48000,
      reasoning: { effort: "low" },
    });
  });
});

const VALIDATOR_WIRE_REQUEST: NarrativeValidatorModelRequest = {
  userId: asUserId("01984477-59a9-7d20-9d97-e588769566a0"),
  artifactKind: "reflection",
  draftRef: "reflection-daily:01984477-59a9-7d20-9d97-e588769566a1",
  draftLocale: "en-US",
  draftText: "the user repaired a radio.",
  sourceEntries: [
    {
      sourceKey: "syn-claim-1",
      sourceKind: "memory_claim_version",
      text: "the user repairs radios.",
      epistemicKind: "objective_memory",
    },
  ],
};

const VALIDATOR_WIRE_OUTPUT = {
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
};

function validatorSse(): string {
  // OpenCode Go Chat Completions stream. The visible content is the JSON
  // output; usage arrives on the terminal chunk before `[DONE]`.
  return (
    `data: ${JSON.stringify({
      choices: [
        {
          delta: { content: JSON.stringify(VALIDATOR_WIRE_OUTPUT) },
          finish_reason: null,
          index: 0,
        },
      ],
      id: "chatcmpl_synthetic",
      model: "deepseek-v4.1-flash",
    })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      id: "chatcmpl_synthetic",
      model: "deepseek-v4.1-flash",
      usage: {
        completion_tokens: 120,
        prompt_tokens: 900,
        total_tokens: 1020,
      },
    })}\n\n` +
    `data: [DONE]\n\n`
  );
}

describe("snapshotFor parameters reach the real OpenCode Go request body", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the pinned reasoning_effort and max_tokens from the real g1 pins", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(validatorSse(), {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const configurations = CAPTURE_ROLES.map((role) => snapshotFor(role, REAL_G1_PINS));
    const providers = createRuntimeOneA3bRoleProviders({
      adapters: [
        {
          apiKey: "synthetic-go-key",
          provider: "opencode-go",
          timeoutMs: 5_000,
        },
      ],
      configurations,
    });

    await providers.narrativeValidationProvider.validateNarrative(
      VALIDATOR_WIRE_REQUEST,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody).toMatchObject({
      model: "deepseek-v4.1-flash",
      max_tokens: 48000,
      reasoning_effort: "low",
      temperature: 0,
      thinking: { type: "enabled" },
    });
    // The wire uses the snake_case alias, never the camelCase ledger key, and
    // never the Responses-only max_output_tokens field.
    expect(capturedBody).not.toHaveProperty("maxOutputTokens");
    expect(capturedBody).not.toHaveProperty("max_output_tokens");
  });
});
