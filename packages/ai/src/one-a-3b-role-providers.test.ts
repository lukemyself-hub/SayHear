import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EPISODE_KIND_CATALOG_V1,
  ONE_A_3B_ROLE_POLICY_VERSION,
  ONE_A_3B_ROLE_POLICIES,
  ProviderDispatchError,
  asDailySessionId,
  asEvidenceItemId,
  asUserId,
  episodeKindTypedFields,
  planEpisodeAdmission,
  planReflectionVersion,
  type EpisodeBuildModelRequest,
  type ModelRoleConfigurationSnapshot,
  type NarrativeValidatorModelRequest,
  type ReflectionFrozenInput,
  type ReflectionGenerationModelOutput,
  type ReflectionGenerationModelRequest,
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
  cachedTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  text?: string;
  totalTokens?: number;
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
      usage: {
        input_tokens: 900,
        output_tokens: options.outputTokens,
        ...(options.cachedTokens === undefined
          ? {}
          : {
              input_tokens_details: {
                cached_tokens: options.cachedTokens,
              },
            }),
        ...(options.reasoningTokens === undefined
          ? {}
          : {
              output_tokens_details: {
                reasoning_tokens: options.reasoningTokens,
              },
            }),
        ...(options.totalTokens === undefined
          ? {}
          : { total_tokens: options.totalTokens }),
      },
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

const VALIDATOR_OUTPUT = {
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
} as const;

describe("G1 runtime role providers (issue #252 response diagnosis)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns a well-formed validator output without a failure", async () => {
    stubResponsesApi([
      completedEvent({ outputTokens: 120, text: JSON.stringify(VALIDATOR_OUTPUT) }),
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
    // The observed #252 signature: HTTP 200, most of the reasoning budget
    // spent, zero characters of final JSON.
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

  it("reads a parse failure just below the cap as output_budget_exhausted", async () => {
    // Issue #252's own evidence: successful `narrative.validate` calls spent
    // 3931 and 3687 tokens against a 4000 cap. A truncation landing at 92% of
    // the cap must not be recorded as a malformed body, or the release gate
    // points the next versioned configuration at the schema instead of the
    // budget.
    stubResponsesApi([
      completedEvent({ outputTokens: 3687, text: '{"propositions":[{"text":"未' }),
    ]);

    expect((await validateAndCatch()).failure).toMatchObject({
      kind: "output_budget_exhausted",
      outputTokens: 3687,
      // Only the Provider-reported reason proves exhaustion; this is inferred.
      providerReason: null,
    });
  });

  it("keeps a low-spend malformed body as parse_failed", async () => {
    stubResponsesApi([
      completedEvent({ outputTokens: 1500, text: '{"propositions":[{"text":"未' }),
    ]);

    expect((await validateAndCatch()).failure).toMatchObject({
      kind: "parse_failed",
      outputTokens: 1500,
      providerReason: null,
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

  it("reads a schema violation near the exhausted budget as output_budget_exhausted", async () => {
    // The same inference the parse path uses: a body that parsed but does not
    // satisfy the frozen schema after spending most of the cap is far more
    // likely truncated than schema-violating, and must not send the next
    // versioned configuration at the schema.
    stubResponsesApi([
      completedEvent({
        outputTokens: 3900,
        text: JSON.stringify({ propositions: "wrong" }),
      }),
    ]);

    expect((await validateAndCatch()).failure).toMatchObject({
      kind: "output_budget_exhausted",
      outputTokens: 3900,
      providerReason: null,
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

  it("records the reasoning split so a spent budget is not mistaken for a truncated answer", async () => {
    // Issue #252's decisive evidence: all of the pinned output budget went to
    // reasoning and none of it to the answer. `outputTokens` alone cannot show
    // this, so the split is part of the frozen failure record.
    stubResponsesApi([
      completedEvent({
        outputTokens: MAX_OUTPUT_TOKENS,
        reasoningTokens: MAX_OUTPUT_TOKENS,
      }),
    ]);

    expect((await validateAndCatch()).failure).toMatchObject({
      kind: "output_budget_exhausted",
      outputLength: 0,
      outputTokens: MAX_OUTPUT_TOKENS,
      reasoningTokens: MAX_OUTPUT_TOKENS,
    });
  });

  it("keeps an unreported reasoning split as null rather than zero", async () => {
    stubResponsesApi([completedEvent({ outputTokens: MAX_OUTPUT_TOKENS })]);

    const failure = (await validateAndCatch()).failure;
    // "Provider did not report" must never read as "spent no reasoning".
    expect(failure?.reasoningTokens).toBeNull();
  });

  it("reports call usage for a successful response, not only a failure", async () => {
    // Issue #252: usage recorded only on failures cannot prove that a new
    // budget has headroom, because the cases that fit are the ones that leave
    // no record. The headroom question needs the successful spend too.
    stubResponsesApi([
      completedEvent({
        outputTokens: 3931,
        reasoningTokens: 3600,
        text: JSON.stringify(VALIDATOR_OUTPUT),
      }),
    ]);

    const seen: unknown[] = [];
    await providers().narrativeValidationProvider.validateNarrative(
      VALIDATOR_REQUEST,
      (usage) => seen.push(usage),
    );

    expect(seen).toEqual([
      {
        cachedTokens: null,
        inputTokens: 900,
        outputTokens: 3931,
        reasoningTokens: 3600,
        totalTokens: null,
      },
    ]);
  });

  it("reports provider cached input and total tokens without deriving them", async () => {
    // The #252 profile wire reported cache 2304 and total 146917; total already
    // includes reasoning, so it is passed through as-is and never recomputed.
    stubResponsesApi([
      completedEvent({
        cachedTokens: 2304,
        outputTokens: 3931,
        reasoningTokens: 3600,
        text: JSON.stringify(VALIDATOR_OUTPUT),
        totalTokens: 146917,
      }),
    ]);

    const seen: unknown[] = [];
    await providers().narrativeValidationProvider.validateNarrative(
      VALIDATOR_REQUEST,
      (usage) => seen.push(usage),
    );

    expect(seen).toEqual([
      {
        cachedTokens: 2304,
        inputTokens: 900,
        outputTokens: 3931,
        reasoningTokens: 3600,
        totalTokens: 146917,
      },
    ]);
  });

  it("reports episode.build usage to the request-scoped callback", async () => {
    stubResponsesApi([
      completedEvent({ outputTokens: 40, text: "[]" }),
    ]);
    const seen: unknown[] = [];
    await providers().episodeBuildProvider.buildProposals(episodeRequest(), (usage) =>
      seen.push(usage),
    );
    expect(seen).toEqual([
      {
        cachedTokens: null,
        inputTokens: 900,
        outputTokens: 40,
        reasoningTokens: null,
        totalTokens: null,
      },
    ]);
  });

  it("reports reflection.generate usage to the request-scoped callback", async () => {
    stubResponsesApi([
      completedEvent({
        outputTokens: 40,
        text: JSON.stringify({ statements: [], candidateProposals: [] }),
      }),
    ]);
    const seen: unknown[] = [];
    await providers().reflectionProvider.generate(
      reflectionRequest("reflection.daily"),
      (usage) => seen.push(usage),
    );
    expect(seen).toEqual([
      {
        cachedTokens: null,
        inputTokens: 900,
        outputTokens: 40,
        reasoningTokens: null,
        totalTokens: null,
      },
    ]);
  });

  it("reports usage before a schema failure so the failure and the spend agree", async () => {
    stubResponsesApi([
      completedEvent({ outputTokens: 30, reasoningTokens: 10, text: "{}" }),
    ]);

    const seen: unknown[] = [];
    await providers()
      .narrativeValidationProvider.validateNarrative(VALIDATOR_REQUEST, (usage) =>
        seen.push(usage),
      )
      .catch(() => undefined);

    expect(seen).toEqual([
      {
        cachedTokens: null,
        inputTokens: 900,
        outputTokens: 30,
        reasoningTokens: 10,
        totalTokens: null,
      },
    ]);
  });
  it("keeps every classified failure free of draft and source text", async () => {
    stubResponsesApi([completedEvent({ outputTokens: 12 })]);

    const error = await validateAndCatch();
    const serialized = `${error.message}|${JSON.stringify(error.failure)}`;
    expect(serialized).not.toMatch(/PRIVATE_DRAFT_CANARY|PRIVATE_SOURCE_CANARY/);
    expect(Object.keys(error.failure ?? {}).sort()).toEqual([
      "cachedTokens",
      "inputTokens",
      "kind",
      "outputLength",
      "outputTokens",
      "providerReason",
      "reasoningTokens",
      "totalTokens",
    ]);
  });
});

type CapturedRequest = Readonly<{
  body: Record<string, unknown>;
  instructions: string;
}>;

function stubResponsesApiCapturing(
  events: readonly string[],
  captured: CapturedRequest[],
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      captured.push({ body, instructions: String(body.instructions ?? "") });
      return new Response(events.join(""), {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    }),
  );
}

/**
 * The outgoing request the Provider would see: the frozen payload is the user
 * message text, exactly as `createJsonCaller` serializes it. Reading it back
 * lets a test feed the real admission/engine the same scope the model saw.
 */
function outgoingPayload<Payload>(captured: CapturedRequest): Payload {
  const input = captured.body.input;
  if (!Array.isArray(input)) throw new Error("Provider request has no input.");
  const user = input.find(
    (entry): entry is { content: string; role: string } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { role?: unknown }).role === "user",
  );
  if (!user || typeof user.content !== "string") {
    throw new Error("Provider request has no user message.");
  }
  return JSON.parse(user.content) as Payload;
}

function syntheticUuid(suffix: number): string {
  return `01990000-0000-7000-8000-${String(suffix).padStart(12, "0")}`;
}

const SYNTHETIC_USER_ID = asUserId("01984477-59a9-7d20-9d97-e588769566a0");
const EPISODE_EVIDENCE_ID = asEvidenceItemId(syntheticUuid(1));
const REFLECTION_EVIDENCE_ID = asEvidenceItemId(syntheticUuid(2));
const SYNTHETIC_DAILY_SESSION_ID = asDailySessionId(syntheticUuid(3));
const SYNTHETIC_REVISION_ID = syntheticUuid(4);

function episodeRequest(): EpisodeBuildModelRequest {
  return {
    userId: SYNTHETIC_USER_ID,
    dailySessionId: SYNTHETIC_DAILY_SESSION_ID,
    sourceRevision: 1,
    kindCatalog: [...EPISODE_KIND_CATALOG_V1],
    evidence: [
      {
        evidenceItemId: EPISODE_EVIDENCE_ID,
        locatorType: "text_span",
        locatorKey: "0:100",
        sourceText:
          "This is synthetic acceptance data. The fictional owner moved to Osaka on September 15, 2026.",
        locale: "en-US",
      },
    ],
    activeEpisodes: [],
  };
}

function reflectionRequest(
  role: "reflection.daily" | "reflection.weekly",
): ReflectionGenerationModelRequest {
  return {
    userId: SYNTHETIC_USER_ID,
    role,
    scopeType: role === "reflection.daily" ? "daily_session" : "date_range",
    weekIdentifier: role === "reflection.weekly" ? "2026-W38" : null,
    locale: "en-US",
    evidence: [
      {
        evidenceItemId: REFLECTION_EVIDENCE_ID,
        dailySessionId: SYNTHETIC_DAILY_SESSION_ID,
        logicalDate: "2026-09-15",
        locatorType: "text_span",
        locatorKey: "0:100",
        sourceText: "The fictional owner moved to Osaka.",
        locale: "en-US",
        revisionId: SYNTHETIC_REVISION_ID,
      },
    ],
    episodes: [],
    summaries: [],
    baseline: [],
    sessionCount: 1,
    maxStatements: 4,
    maxPropositionsPerStatement: 4,
    maxCandidateProposals: 4,
  };
}

function dailyFrozenInput(): ReflectionFrozenInput {
  return {
    scopeType: "daily_session",
    dailySessionId: SYNTHETIC_DAILY_SESSION_ID,
    weekIdentifier: null,
    windowStartDate: "2026-09-15",
    windowEndDate: "2026-09-15",
    days: [],
    evidence: [
      {
        evidenceItemId: REFLECTION_EVIDENCE_ID,
        dailySessionId: SYNTHETIC_DAILY_SESSION_ID,
        logicalDate: "2026-09-15",
        locatorType: "text_span",
        locatorKey: "0:100",
        sourceText: "The fictional owner moved to Osaka.",
        locale: "en-US",
        revisionId: SYNTHETIC_REVISION_ID,
      },
    ],
    episodes: [],
    summaries: [],
    baseline: [],
    claimBaselineDigest: "synthetic-digest",
    sourceDigest: null,
    dominantLocale: "en-US",
  };
}

describe("G1 typed generation contract instructions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tells episode.build the kindFields allowlist for the supplied catalog and passes the resulting proposal through real admission", async () => {
    const request = episodeRequest();
    const proposal = {
      proposedKind: "sh.episode.trip",
      label: "Synthetic move to Osaka",
      temporalAnchor: { start: { date: "2026-09-15", precision: "exact" } },
      phase: "completed",
      kindFields: { destination: "Osaka" },
      citedEvidenceItemIds: [EPISODE_EVIDENCE_ID],
      realWorldOccurrence: true,
    };
    const captured: CapturedRequest[] = [];
    stubResponsesApiCapturing(
      [completedEvent({ outputTokens: 120, text: JSON.stringify([proposal]) })],
      captured,
    );

    const proposals =
      await providers().episodeBuildProvider.buildProposals(request);

    // The instruction derives its kind-field contract from the one authority
    // admission uses, so a key it accepts is never missing from the prompt.
    const instructions = captured[0]!.instructions;
    for (const kind of request.kindCatalog) {
      const fields = episodeKindTypedFields(kind);
      expect(instructions).toContain(
        fields.length === 0
          ? `${kind} kindFields must be an empty object {}`
          : `${kind} kindFields may contain only ${fields.join(", ")}`,
      );
    }
    // occurrence/other accept no typed fields; the empty-object clause is the
    // exact shape of the terminal typed_field_invalid rejection.
    expect(instructions).toContain(
      "sh.episode.occurrence kindFields must be an empty object {}",
    );
    expect(instructions).toContain(
      "sh.episode.other kindFields must be an empty object {}",
    );
    expect(instructions).toContain("exact requires YYYY-MM-DD");
    expect(instructions).toContain("month requires YYYY-MM");
    expect(instructions).toContain("year requires YYYY");
    expect(instructions).toContain("unknown must omit the date field");
    expect(instructions).toContain(
      "citedEvidenceItemIds must contain at least one supplied Evidence ID",
    );
    expect(instructions).toContain(
      "omit entityAnchorIds when no supplied ID applies",
    );

    // The request the model actually received is the same scope admission
    // sees, and the instructed shape survives the real deterministic gate.
    const outgoing = outgoingPayload<EpisodeBuildModelRequest>(captured[0]!);
    expect(outgoing.kindCatalog).toEqual(request.kindCatalog);
    expect(outgoing.evidence.map((item) => item.evidenceItemId)).toEqual([
      EPISODE_EVIDENCE_ID,
    ]);
    expect(planEpisodeAdmission({ proposal: proposals[0]!, request: outgoing }))
      .toMatchObject({ action: "create_episode", kind: "sh.episode.trip" });
  });

  it("tells episode.build kindFields is always required and keeps an empty-object occurrence/other sample admissible", async () => {
    const request = episodeRequest();
    const proposals = (
      [
        ["sh.episode.occurrence", "Synthetic single occurrence"],
        ["sh.episode.other", "Synthetic catch-all"],
      ] as const
    ).map(([proposedKind, label]) => ({
      proposedKind,
      label,
      temporalAnchor: { start: { date: "2026-09-15", precision: "exact" } },
      phase: "completed",
      kindFields: {},
      citedEvidenceItemIds: [EPISODE_EVIDENCE_ID],
      realWorldOccurrence: true,
    }));
    const captured: CapturedRequest[] = [];
    stubResponsesApiCapturing(
      [completedEvent({ outputTokens: 120, text: JSON.stringify(proposals) })],
      captured,
    );

    const outgoingProposals =
      await providers().episodeBuildProvider.buildProposals(request);

    const instructions = captured[0]!.instructions;
    expect(instructions).toContain("kindFields is required for every proposal");
    // The contradictory sentence that told the model it could omit kindFields
    // must not return: `isStringRecord` makes a missing kindFields a schema
    // failure before admission ever sees it.
    expect(instructions).not.toContain(
      "Omit kindFields only for a kind that allows none",
    );
    for (const proposal of outgoingProposals) {
      const kind = proposal.proposedKind as Parameters<
        typeof episodeKindTypedFields
      >[0];
      expect(episodeKindTypedFields(kind)).toEqual([]);
      expect(instructions).toContain(
        `${kind} kindFields must be an empty object {}`,
      );
    }

    // The instructed `{}` shape must survive the real deterministic gate for
    // the two kinds that admit no typed fields (the hosted typed_field_invalid
    // signature).
    const outgoing = outgoingPayload<EpisodeBuildModelRequest>(captured[0]!);
    for (const proposal of outgoingProposals) {
      expect(
        planEpisodeAdmission({ proposal, request: outgoing }),
      ).toMatchObject({ action: "create_episode" });
    }
  });

  it("instructs Daily Reflection day_observation-only scope and its output survives the real Tier-1 gate", async () => {
    const output: ReflectionGenerationModelOutput = {
      statements: [
        {
          statementKey: "s1",
          text: "The fictional owner moved to Osaka.",
          statementKind: "day_observation",
          propositions: [
            {
              propositionKey: "p1",
              normalizedProposition: "The fictional owner moved to Osaka.",
              propositionKind: "fact",
              epistemicRendering: "confirmed",
              supportEvidenceItemIds: [REFLECTION_EVIDENCE_ID],
              baselineClaimIds: [],
            },
          ],
        },
      ],
      candidateProposals: [],
    };
    const captured: CapturedRequest[] = [];
    stubResponsesApiCapturing(
      [completedEvent({ outputTokens: 120, text: JSON.stringify(output) })],
      captured,
    );

    await providers().reflectionProvider.generate(
      reflectionRequest("reflection.daily"),
    );

    const dailyClause =
      "every statement must use statementKind day_observation";
    const instructions = captured[0]!.instructions;
    expect(instructions).toContain(dailyClause);
    expect(instructions).toContain(
      "cross_day_theme and change_observation are not allowed in Daily scope",
    );

    const outgoing =
      outgoingPayload<ReflectionGenerationModelRequest>(captured[0]!);
    expect(outgoing.role).toBe("reflection.daily");
    expect(outgoing.scopeType).toBe("daily_session");
    expect(
      planReflectionVersion({ frozen: dailyFrozenInput(), output }),
    ).toMatchObject({ action: "persist_draft" });
  });

  it("keeps the Weekly instruction free of the Daily-only clause", async () => {
    const output: ReflectionGenerationModelOutput = {
      statements: [],
      candidateProposals: [],
    };
    const captured: CapturedRequest[] = [];
    stubResponsesApiCapturing(
      [completedEvent({ outputTokens: 20, text: JSON.stringify(output) })],
      captured,
    );

    await providers().reflectionProvider.generate(
      reflectionRequest("reflection.weekly"),
    );

    const instructions = captured[0]!.instructions;
    expect(instructions).toContain(
      "statementKind must be one of day_observation, cross_day_theme, change_observation",
    );
    expect(instructions).not.toContain(
      "not allowed in Daily scope",
    );
    const outgoing =
      outgoingPayload<ReflectionGenerationModelRequest>(captured[0]!);
    expect(outgoing.role).toBe("reflection.weekly");
    expect(outgoing.scopeType).toBe("date_range");
  });

  it("documents the Daily scope gate the instruction exists to prevent", () => {
    const output: ReflectionGenerationModelOutput = {
      statements: [
        {
          statementKey: "s1",
          text: "A cross-day theme.",
          statementKind: "cross_day_theme",
          propositions: [
            {
              propositionKey: "p1",
              normalizedProposition: "A cross-day theme.",
              propositionKind: "synthesis",
              epistemicRendering: "inferred",
              supportEvidenceItemIds: [REFLECTION_EVIDENCE_ID],
              baselineClaimIds: [],
            },
          ],
        },
      ],
      candidateProposals: [],
    };

    expect(
      planReflectionVersion({ frozen: dailyFrozenInput(), output }),
    ).toMatchObject({
      action: "fail_version",
      rejectionCode: "daily_scope_kind_invalid",
    });
  });
});

const BASELINE_CLAIM_ID = "01990000-0000-7000-8000-0000000000aa";
const BASELINE_CLAIM_VERSION_ID = "01990000-0000-7000-8000-0000000000bb";
const BASELINE_EPISODE_ID = "01990000-0000-7000-8000-0000000000cc";

function baselineEntry() {
  return {
    claimId: BASELINE_CLAIM_ID,
    claimVersionId: BASELINE_CLAIM_VERSION_ID,
    kind: "objective" as const,
    predicateId: "sh.memory.hobby",
    scopeKey: "",
    typedValue: '"sailing"',
    temporalStatus: "current" as const,
    validFrom: null,
    validFromPrecision: "unknown" as const,
    validTo: null,
    validToPrecision: "unknown" as const,
    epistemicStatus: "confirmed" as const,
    lastObservedAt: "2026-09-15T00:00:00.000Z",
  };
}

function reflectionRequestWithBaseline(
  role: "reflection.daily" | "reflection.weekly",
): ReflectionGenerationModelRequest {
  return { ...reflectionRequest(role), baseline: [baselineEntry()] };
}

function dailyFrozenWithBaseline(): ReflectionFrozenInput {
  return { ...dailyFrozenInput(), baseline: [baselineEntry()] };
}

function baselineProposition(baselineClaimIds: readonly string[]) {
  return {
    propositionKey: "proposition:1",
    normalizedProposition: "user sails",
    propositionKind: "fact" as const,
    epistemicRendering: "confirmed" as const,
    supportEvidenceItemIds: [REFLECTION_EVIDENCE_ID],
    baselineClaimIds,
  };
}

describe("G1 Reflection baseline reference protocol", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("states the frozen deterministic reference clauses the Tier-1 gate enforces", async () => {
    const captured: CapturedRequest[] = [];
    stubResponsesApiCapturing(
      [
        completedEvent({
          outputTokens: 20,
          text: JSON.stringify({ statements: [], candidateProposals: [] }),
        }),
      ],
      captured,
    );

    await providers().reflectionProvider.generate(
      reflectionRequestWithBaseline("reflection.weekly"),
    );

    const instructions = captured[0]!.instructions;
    expect(instructions).toContain(
      "Every proposition must cite at least one supplied Evidence ID in supportEvidenceItemIds and only supplied Evidence IDs",
    );
    expect(instructions).toContain(
      "baselineClaimIds must copy verbatim only supplied baseline claimId values",
    );
    expect(instructions).toContain("never cite a claimVersionId");
    expect(instructions).toContain(
      "A change_observation proposition must list at least one supplied baseline claimId",
    );
    expect(instructions).toContain(
      "cross_day_theme and change_observation statements must draw support from at least two distinct supplied Daily Session IDs",
    );
  });

  it("drops only the internal claimVersionId from the outgoing payload and leaves the frozen request unchanged", async () => {
    const request = reflectionRequestWithBaseline("reflection.daily");
    const before = JSON.stringify(request);
    const captured: CapturedRequest[] = [];
    stubResponsesApiCapturing(
      [
        completedEvent({
          outputTokens: 20,
          text: JSON.stringify({ statements: [], candidateProposals: [] }),
        }),
      ],
      captured,
    );

    await providers().reflectionProvider.generate(request);

    const outgoing =
      outgoingPayload<ReflectionGenerationModelRequest>(captured[0]!);
    expect(outgoing.baseline).toHaveLength(1);
    expect(outgoing.baseline[0]!.claimId).toBe(BASELINE_CLAIM_ID);
    expect(
      Object.prototype.hasOwnProperty.call(
        outgoing.baseline[0],
        "claimVersionId",
      ),
    ).toBe(false);
    // Every needed Evidence ID and session identity survives the projection.
    expect(outgoing.evidence).toEqual(request.evidence);
    expect(outgoing.summaries).toEqual(request.summaries);
    expect(outgoing.sessionCount).toBe(request.sessionCount);
    // The frozen request object is never mutated: the internal lineage field
    // and every other field stay exactly as the domain froze them.
    expect(JSON.stringify(request)).toBe(before);
    expect(request.baseline[0]!.claimVersionId).toBe(BASELINE_CLAIM_VERSION_ID);
    expect(request.baseline[0]!.claimId).toBe(BASELINE_CLAIM_ID);
  });

  it("persists a draft when a proposition cites a real supplied baseline claim ID", () => {
    const output = {
      statements: [
        {
          statementKey: "statement:1",
          text: "The fictional owner sails.",
          statementKind: "day_observation" as const,
          propositions: [baselineProposition([BASELINE_CLAIM_ID])],
        },
      ],
      candidateProposals: [],
    };

    expect(
      planReflectionVersion({ frozen: dailyFrozenWithBaseline(), output }),
    ).toMatchObject({ action: "persist_draft" });
  });

  it("rejects a claim version, Evidence, Episode, or unknown ID cited as a baseline claim", () => {
    for (const wrongId of [
      BASELINE_CLAIM_VERSION_ID,
      REFLECTION_EVIDENCE_ID,
      BASELINE_EPISODE_ID,
      "invented-baseline-claim",
    ]) {
      const output = {
        statements: [
          {
            statementKey: "statement:1",
            text: "The fictional owner sails.",
            statementKind: "day_observation" as const,
            propositions: [baselineProposition([wrongId])],
          },
        ],
        candidateProposals: [],
      };

      expect(
        planReflectionVersion({ frozen: dailyFrozenWithBaseline(), output }),
      ).toMatchObject({
        action: "fail_version",
        rejectionCode: "baseline_claim_out_of_bounds",
      });
    }
  });
});
