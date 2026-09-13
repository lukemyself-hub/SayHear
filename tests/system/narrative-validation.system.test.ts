import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  NARRATIVE_FINDINGS_SCHEMA_VERSION,
  NARRATIVE_VALIDATION_POLICY_VERSION,
  NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO,
  NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION,
  createModelRoleCommandService,
  createModelRoleProviderEgress,
  createModelRoleRegistry,
  runNarrativeValidation,
  runNarrativeValidationAttempt,
  runNarrativeValidationMaintenance,
  readNarrativeValidationOutcome,
  type ModelRoleCommandService,
  type ModelRoleConfigurationSnapshot,
  type NarrativeValidationEntrypointDependencies,
  type NarrativeValidationModelProvider,
  type NarrativeValidationRequest,
  type NarrativeValidatorModelOutput,
  type NarrativeValidatorModelRequest,
  type RecoveryGate,
} from "@sayhear/application";
import {
  PostgresModelRoleCommandRepository,
  PostgresNarrativeValidationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
  type IsolatedPostgresSchema,
} from "@sayhear/test-support";
import {
  buildValidatorRequestBundle,
  loadValidatorCatalog,
} from "../../eval/continuation-acceptance-1a3b/validator-inputs";
import type { FixtureCatalog } from "../../eval/continuation-acceptance-1a3b/protocol";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const systemDescribe = testDatabaseUrl ? describe : describe.skip;

const userId = fixedInternalOwnerPrincipal.userId;
const baseTime = new Date("2026-09-09T08:00:00.000Z");

const configuration: ModelRoleConfigurationSnapshot = {
  role: "narrative.validate",
  configVersion: "system-narrative-validate:v1",
  provider: "system-test",
  model: "synthetic-model",
  modelSnapshot: "synthetic-model@fixture",
  promptVersion: "narrative-validate:system-test:v1",
  schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
  rolePolicyVersion: "1a3b-model-role-policy:v1",
  providerPolicyVersion: "system-narrative-validate-egress:v1",
  rolloutPin: "system-narrative-validate-pin:v1",
  freshnessPolicy: "exact_head:v1",
  fallbackMode: "disabled",
  maxTechnicalRetries: 1,
  maxSemanticRepairs: 0,
  parameterSnapshot: {
    budgetPolicyVersion: "system-test-budget:v1",
    providerCallBudget: 2,
  },
};

async function seedConfigQueries(
  database: IsolatedPostgresSchema,
): Promise<void> {
  await database.pool.query(
    `INSERT INTO provider_egress_policy_versions (
       policy_version, provider, role, model_config_version, status, created_at
     ) VALUES ($1, $2, $3, $4, 'active', $5)`,
    [
      configuration.providerPolicyVersion,
      configuration.provider,
      configuration.role,
      configuration.configVersion,
      baseTime,
    ],
  );
  await database.pool.query(
    `INSERT INTO model_role_configurations (
       role, config_version, provider, model, model_snapshot, prompt_version,
       schema_version, role_policy_version, provider_policy_version,
       freshness_policy, fallback_mode, max_technical_retries,
       max_semantic_repairs, parameter_snapshot, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
    [
      configuration.role,
      configuration.configVersion,
      configuration.provider,
      configuration.model,
      configuration.modelSnapshot,
      configuration.promptVersion,
      configuration.schemaVersion,
      configuration.rolePolicyVersion,
      configuration.providerPolicyVersion,
      configuration.freshnessPolicy,
      configuration.fallbackMode,
      configuration.maxTechnicalRetries,
      configuration.maxSemanticRepairs,
      JSON.stringify(configuration.parameterSnapshot),
      baseTime,
    ],
  );
  await database.pool.query(
    "UPDATE model_role_definitions SET enabled = TRUE WHERE role = $1",
    [configuration.role],
  );
  await database.pool.query(
    `INSERT INTO model_role_rollout_pins (
       role, rollout_pin, config_version, provider_policy_version,
       status, activated_at
     ) VALUES ($1, $2, $3, $4, 'active', $5)`,
    [
      configuration.role,
      configuration.rolloutPin,
      configuration.configVersion,
      configuration.providerPolicyVersion,
      baseTime,
    ],
  );
}

/** Maps the F3 fixture error-class label onto the domain finding code. */
function findingClassForFixture(
  validatorErrorClass: string,
): string {
  switch (validatorErrorClass) {
    case "unsupported":
      return "unsupported";
    case "contradiction":
      return "contradiction";
    case "epistemic_upgrade":
      return "kind_upgrade";
    case "material_absence":
      return "material_absence";
    case "manifest_mismatch":
      return "manifest_mismatch";
    case "ambiguity":
      return "ambiguous";
    default:
      throw new Error(`Unknown validator error class ${validatorErrorClass}.`);
  }
}

/**
 * Fixture-keyed deterministic stand-in for pipeline conformance only: it
 * emits the blocking class each calibration fixture is defined to exercise.
 * Dangerous-error DETECTION qualification is the separate real-provider run
 * judged by Luke's adjudication ledger (ADR-0137, AC-X03) — this stand-in
 * never substitutes for that judgment.
 */
function standInOutputForFixture(
  fixtureId: string,
  request: NarrativeValidatorModelRequest,
): NarrativeValidatorModelOutput {
  const errorClass = fixtureId.split("-").slice(2, -1).join("-");
  const base = {
    propositionKey: `${fixtureId}:independent:1`,
    text: request.draftText,
    propositionKind: "fact" as const,
    epistemicRendering: "confirmed" as const,
    supportKeys: request.sourceEntries.map((entry) => entry.sourceKey),
    unsupported: false,
    contradicted: false,
    ambiguous: false,
  };
  switch (errorClass) {
    case "unsupported":
      return { propositions: [{ ...base, unsupported: true }], coverageKeys: [] };
    case "contradiction":
      return { propositions: [{ ...base, contradicted: true }], coverageKeys: [] };
    case "upgrade":
      return {
        propositions: [{ ...base }],
        coverageKeys: request.sourceEntries.map((entry) => entry.sourceKey),
      };
    case "absence":
      return { propositions: [{ ...base }], coverageKeys: [] };
    case "manifest":
      return {
        propositions: [{ ...base }],
        coverageKeys: request.sourceEntries.map((entry) => entry.sourceKey),
      };
    case "ambiguity":
      return { propositions: [{ ...base, ambiguous: true }], coverageKeys: [] };
    default:
      throw new Error(`Fixture ${fixtureId} has no scripted stand-in class.`);
  }
}

function providerFor(
  script: (
    request: NarrativeValidatorModelRequest,
  ) => NarrativeValidatorModelOutput,
): NarrativeValidationModelProvider {
  return {
    role: "narrative.validate",
    async validateNarrative(request) {
      return script(request);
    },
  };
}

function cleanRequest(
  draftRef: string,
  overrides: Partial<NarrativeValidationRequest> = {},
): NarrativeValidationRequest {
  return {
    userId,
    artifactKind: "bio",
    draftRef,
    draftLocale: "en-US",
    draftText: "The user repairs radios.",
    generatorManifest: [],
    sourceEntries: [
      {
        sourceKey: "claim:1",
        sourceKind: "memory_claim_version",
        text: "The fictional user repairs radios.",
        epistemicKind: "objective_memory",
      },
    ],
    plannedCoverageKeys: [],
    validationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
    promptVersion: NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO,
    schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
    ...overrides,
  };
}

function acceptedOutput(): NarrativeValidatorModelOutput {
  return {
    propositions: [
      {
        propositionKey: "independent:1",
        text: "The user repairs radios.",
        propositionKind: "fact",
        epistemicRendering: "confirmed",
        supportKeys: ["claim:1"],
        unsupported: false,
        contradicted: false,
        ambiguous: false,
      },
    ],
    coverageKeys: ["claim:1"],
  };
}

systemDescribe("Shared narrative.validate validator — 1A.3b A2 (issue #198)", () => {
  let database: IsolatedPostgresSchema | undefined;
  let commandService: ModelRoleCommandService | undefined;

  function dependencies(
    provider: NarrativeValidationModelProvider,
  ): NarrativeValidationEntrypointDependencies {
    // Production wires the shared egress port into the validator entrypoint
    // (server-composition); the port owns the prepared → running claim, so
    // the system seam must exercise the same boundary. The G1 release
    // verifier is intentionally unwired: there is no active release
    // manifest in tests.
    const gate: RecoveryGate = {
      evaluate: async () => ({
        status: "open" as const,
        markerDataEpoch: null,
        markerPurgedAt: null,
        markerWrittenAt: null,
        receiptDestinations: [],
      }),
      requireOpen: async () => ({
        status: "open" as const,
        markerDataEpoch: null,
        markerPurgedAt: null,
        markerWrittenAt: null,
        receiptDestinations: [],
      }),
    };
    return {
      clock: () => baseTime,
      repository: new PostgresNarrativeValidationRepository(database!.pool),
      modelRoleCommandService: commandService!,
      narrativeValidationProvider: provider,
      providerEgress: createModelRoleProviderEgress({
        commandService: {
          claimProviderDispatch: (input) =>
            commandService!.claimProviderDispatch(input),
          discardAttempt: (input) => commandService!.discardAttempt(input),
        },
        recoveryGate: gate,
      }),
    };
  }

  beforeAll(async () => {
    const seededDatabase = await createIsolatedPostgresSchema(testDatabaseUrl!);
    database = seededDatabase;
    await runMigrations(seededDatabase.pool);
    await seededDatabase.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [userId, baseTime],
    );
    await seedConfigQueries(seededDatabase);
    commandService = createModelRoleCommandService({
      registry: createModelRoleRegistry([configuration]),
      repository: new PostgresModelRoleCommandRepository(seededDatabase.pool),
    });
  });

  afterAll(async () => {
    await database?.dispose();
  });

  it("runs all 18 calibration fixtures through the production validation entry", async () => {
    const bundles = buildValidatorRequestBundle(loadValidatorCatalog(
      resolve(process.cwd(), "eval/continuation-acceptance-1a3b/fixtures.json"),
    ), { generatorManifests: {} });
    expect(bundles.length).toBe(18);

    for (const bundle of bundles) {
      // An epistemic-upgrade fixture means the writer declared the weaker
      // kind while the final text asserts the stronger one; freeze that
      // writer premise as the generator manifest.
      const generatorManifest =
        bundle.validatorErrorClass === "epistemic_upgrade"
          ? [
              {
                statementKey: `${bundle.fixtureId}:statement:1`,
                text: bundle.request.draftText,
                propositionStatements: [
                  {
                    propositionKey: `${bundle.fixtureId}:proposition:1`,
                    normalizedProposition: bundle.request.draftText,
                    propositionKind: "impression" as const,
                    epistemicRendering: "inferred" as const,
                    supportKeys: [...bundle.request.sourceEntries.map((e) => e.sourceKey)],
                  },
                ],
              },
            ]
          : [];
      const request = { ...bundle.request, generatorManifest };
      const deps = dependencies(
        providerFor((incoming) => standInOutputForFixture(bundle.fixtureId, incoming)),
      );
      const result = await runNarrativeValidation({
        dependencies: deps,
        command: { request, expectedDataEpoch: 1 },
      });
      expect(result.outcome, bundle.fixtureId).toBe("completed");
      // Bio blocks on every class; Reflection v1 records the same classes
      // as advisory until calibrated blocking policy promotes them.
      expect(result.verdict, bundle.fixtureId).toBe(
        bundle.artifactKind === "bio" ? "blocked" : "accepted",
      );
      expect(result.generationCommandId, bundle.fixtureId).toBeTruthy();
      expect(result.modelRunAttemptId, bundle.fixtureId).toBeTruthy();

      const read = await readNarrativeValidationOutcome({
        repository: deps.repository,
        userId: bundle.request.userId,
        artifactKind: bundle.request.artifactKind,
        draftRef: bundle.request.draftRef,
        now: baseTime,
      });
      if (read.outcome !== "ok") {
        throw new Error(`Fixture ${bundle.fixtureId} has no committed result`);
      }
      const expectedClass = findingClassForFixture(bundle.validatorErrorClass);
      const findingCodes = [
        ...read.result.result.blockingFindings,
        ...read.result.result.advisoryFindings,
      ].map((finding) => finding.findingCode);
      expect(findingCodes, bundle.fixtureId).toContain(expectedClass);
      expect(read.result.result.outcome, bundle.fixtureId).toBe(
        bundle.artifactKind === "bio" ? "blocked" : "accepted",
      );
      expect(read.result.result.validationPolicyVersion).toBe(
        NARRATIVE_VALIDATION_POLICY_VERSION,
      );
    }
  });

  it("detects generator under-report and support padding through the entry", async () => {
    const request = cleanRequest(
      "bio-version:01984477-1f9a-7b25-a5cc-000000000002",
      {
        draftText:
          "The user repairs radios. The user also owns a private observatory.",
        generatorManifest: [
          {
            statementKey: "statement:1",
            text: "The user repairs radios and owns a private observatory.",
            propositionStatements: [
              {
                propositionKey: "proposition:1",
                normalizedProposition: "The user repairs radios.",
                propositionKind: "fact",
                epistemicRendering: "confirmed",
                supportKeys: ["claim:1", "claim:padding"],
              },
            ],
          },
        ],
        sourceEntries: [
          {
            sourceKey: "claim:1",
            sourceKind: "memory_claim_version",
            text: "The fictional user repairs radios.",
            epistemicKind: "objective_memory",
          },
          {
            sourceKey: "claim:padding",
            sourceKind: "memory_claim_version",
            text: "Padding text for the padding link gate.",
            epistemicKind: "objective_memory",
          },
        ],
      },
    );
    const deps = dependencies(
      providerFor(() => ({
        propositions: [
          {
            propositionKey: "independent:1",
            text: "The user repairs radios.",
            propositionKind: "fact",
            epistemicRendering: "confirmed",
            supportKeys: ["claim:1"],
            unsupported: false,
            contradicted: false,
            ambiguous: false,
          },
          {
            // The independent decomposition recovered a proposition the
            // generator never declared: generator under-report (漏报命题).
            propositionKey: "independent:2",
            text: "The user also owns a private observatory.",
            propositionKind: "fact",
            epistemicRendering: "confirmed",
            supportKeys: [],
            unsupported: true,
            contradicted: false,
            ambiguous: false,
          },
        ],
        coverageKeys: ["claim:1"],
      })),
    );
    const result = await runNarrativeValidation({
      dependencies: deps,
      command: { request, expectedDataEpoch: 1 },
    });
    expect(result.outcome).toBe("completed");
    expect(result.verdict).toBe("blocked");
    const read = await readNarrativeValidationOutcome({
      repository: deps.repository,
      userId,
      artifactKind: "bio",
      draftRef: request.draftRef,
      now: baseTime,
    });
    if (read.outcome !== "ok") return expect.unreachable();
    const codes = read.result.result.blockingFindings.map((f) => f.findingCode);
    expect(codes).toContain("manifest_mismatch");
    // The undeclared proposition is unsupported on its own as well.
    expect(codes).toContain("unsupported");
  });

  it("upgrades kind between the writer manifest and the independent kind", async () => {
    const request = cleanRequest(
      "bio-version:01984477-1f9a-7b25-a5cc-000000000003",
      {
        draftText:
          "The user is objectively the most patient person in every room.",
        generatorManifest: [
          {
            statementKey: "statement:1",
            text: "The user is objectively the most patient person in every room.",
            propositionStatements: [
              {
                propositionKey: "proposition:1",
                normalizedProposition:
                  "The user is objectively the most patient person in every room.",
                propositionKind: "impression",
                epistemicRendering: "inferred",
                supportKeys: ["claim:1"],
              },
            ],
          },
        ],
        sourceEntries: [
          {
            sourceKey: "claim:1",
            sourceKind: "memory_claim_version",
            text: "The fictional user repairs radios.",
            epistemicKind: "ai_impression",
          },
        ],
      },
    );
    const deps = dependencies(
      providerFor(() => ({
        propositions: [
          {
            propositionKey: "independent:1",
            text: "The user is objectively the most patient person in every room.",
            propositionKind: "fact",
            epistemicRendering: "confirmed",
            supportKeys: ["claim:1"],
            unsupported: false,
            contradicted: false,
            ambiguous: false,
          },
        ],
        coverageKeys: ["claim:1"],
      })),
    );
    const result = await runNarrativeValidation({
      dependencies: deps,
      command: { request, expectedDataEpoch: 1 },
    });
    expect(result.outcome).toBe("completed");
    expect(result.verdict).toBe("blocked");
    const read = await readNarrativeValidationOutcome({
      repository: deps.repository,
      userId,
      artifactKind: "bio",
      draftRef: request.draftRef,
      now: baseTime,
    });
    if (read.outcome !== "ok") return expect.unreachable();
    expect(
      read.result.result.blockingFindings.map((f) => f.findingCode),
    ).toContain("kind_upgrade");
  });

  it("keeps reflection semantic findings advisory in the frozen v1 policy", async () => {
    const request = cleanRequest(
      "reflection-version:01984477-1f9a-7b25-a5cc-000000000004",
      {
        artifactKind: "reflection",
        draftLocale: "zh-CN",
        draftText: "用户可能是一个挺重要的人。",
        generatorManifest: [
          {
            statementKey: "statement:1",
            text: "用户可能是一个挺重要的人。",
            propositionStatements: [
              {
                propositionKey: "proposition:1",
                normalizedProposition: "用户可能是一个挺重要的人。",
                propositionKind: "impression",
                epistemicRendering: "inferred",
                supportKeys: ["evidence:1"],
              },
            ],
          },
        ],
        sourceEntries: [
          {
            sourceKey: "evidence:1",
            sourceKind: "evidence_item",
            text: "用户提到自己修理收音机。",
            epistemicKind: null,
          },
        ],
        promptVersion: NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION,
      },
    );
    const deps = dependencies(
      providerFor(() => ({
        propositions: [
          {
            propositionKey: "independent:1",
            text: "用户可能是一个挺重要的人。",
            propositionKind: "impression",
            epistemicRendering: "inferred",
            supportKeys: [],
            unsupported: true,
            contradicted: false,
            ambiguous: true,
          },
        ],
        coverageKeys: [],
      })),
    );
    const result = await runNarrativeValidation({
      dependencies: deps,
      command: { request, expectedDataEpoch: 1 },
    });
    expect(result.outcome).toBe("completed");
    expect(result.verdict).toBe("accepted");
    const read = await readNarrativeValidationOutcome({
      repository: deps.repository,
      userId,
      artifactKind: "reflection",
      draftRef: request.draftRef,
      now: baseTime,
    });
    if (read.outcome !== "ok") return expect.unreachable();
    expect(read.result.result.outcome).toBe("accepted");
    expect(read.result.result.blockingFindings).toEqual([]);
    const advisoryCodes = read.result.result.advisoryFindings.map(
      (f) => f.findingCode,
    );
    expect(advisoryCodes).toContain("unsupported");
    expect(advisoryCodes).toContain("ambiguous");
    // Advisory never becomes an excuse to skip the validator: the result
    // only exists because a validator command completed (ADR-0132).
    expect(read.result.generationCommandId).toBeTruthy();
    expect(read.result.modelRunAttemptId).toBeTruthy();
  });

  it("retries one technical timeout on the same frozen configuration", async () => {
    const request = cleanRequest(
      "bio-version:01984477-1f9a-7b25-a5cc-000000000005",
      {
        generatorManifest: [
          {
            statementKey: "statement:1",
            text: "The user repairs radios.",
            propositionStatements: [
              {
                propositionKey: "proposition:1",
                normalizedProposition: "The user repairs radios.",
                propositionKind: "fact",
                epistemicRendering: "confirmed",
                supportKeys: ["claim:1"],
              },
            ],
          },
        ],
        plannedCoverageKeys: [],
      },
    );
    let calls = 0;
    const deps = dependencies(
      providerFor(() => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("timeout"), { category: "timeout" });
        }
        return acceptedOutput();
      }),
    );
    const first = await runNarrativeValidation({
      dependencies: deps,
      command: { request, expectedDataEpoch: 1 },
    });
    expect(first.outcome).toBe("retryable_failed");
    expect(first.errorCode).toBe("timeout");

    // The shared ledger scheduled attempt 2; re-enter through the retry
    // entrypoint (the generic model-role dispatch is the merge-lead seam).
    const attempts = await database!.pool.query<{
      attempt_no: number;
      model_run_attempt_id: string;
      generation_command_id: string;
    }>(
      `SELECT attempt_no, model_run_attempt_id::text, generation_command_id::text
       FROM model_run_attempts WHERE user_id = $1 ORDER BY attempt_no`,
      [userId],
    );
    const latest = attempts.rows.at(-1)!;
    expect(latest.attempt_no).toBe(2);

    const retry = await runNarrativeValidationAttempt({
      dependencies: deps,
      command: {
        generationCommandId: latest.generation_command_id,
        modelRunAttemptId: latest.model_run_attempt_id,
        attemptNo: 2,
      },
    });
    expect(retry.outcome).toBe("completed");
    expect(retry.verdict).toBe("accepted");
    expect(
      await readNarrativeValidationOutcome({
        repository: deps.repository,
        userId,
        artifactKind: "bio",
        draftRef: request.draftRef,
        now: baseTime,
      }),
    ).toMatchObject({ outcome: "ok" });
  });

  it("fails closed without a completed validator and never publishes", async () => {
    const request = cleanRequest(
      "bio-version:01984477-1f9a-7b25-a5cc-000000000006",
    );
    const deps = dependencies(
      providerFor(() => {
        throw Object.assign(new Error("auth"), { category: "authentication" });
      }),
    );
    const result = await runNarrativeValidation({
      dependencies: deps,
      command: { request, expectedDataEpoch: 1 },
    });
    // Authentication failures never retry (ADR-0132).
    expect(result.outcome).toBe("failed");
    expect(result.errorCode).toBe("authentication");

    const read = await readNarrativeValidationOutcome({
      repository: deps.repository,
      userId,
      artifactKind: "bio",
      draftRef: request.draftRef,
      now: baseTime,
    });
    // Validator not complete: no publish and no Candidate may be derived.
    expect(read.outcome).toBe("incomplete");
  });

  it("fences validation behind the owner epoch fence", async () => {
    const request = cleanRequest(
      "bio-version:01984477-1f9a-7b25-a5cc-000000000007",
    );
    const deps = dependencies(providerFor(() => acceptedOutput()));
    // A stale epoch is a deterministic business fence: the validator never
    // runs and no request row is created (ADR-0132).
    const result = await runNarrativeValidation({
      dependencies: deps,
      command: { request, expectedDataEpoch: 5 },
    });
    expect(result.outcome).toBe("fenced");
    expect(result.errorCode).toBe("data_epoch");
    expect(
      await readNarrativeValidationOutcome({
        repository: deps.repository,
        userId,
        artifactKind: "bio",
        draftRef: request.draftRef,
        now: baseTime,
      }),
    ).toMatchObject({ outcome: "not_found" });
  });

  it("enforces the 7-day content expiry on the read path", async () => {
    const request = cleanRequest(
      "bio-version:01984477-1f9a-7b25-a5cc-000000000008",
    );
    const deps = dependencies(providerFor(() => acceptedOutput()));
    const result = await runNarrativeValidation({
      dependencies: deps,
      command: { request, expectedDataEpoch: 1 },
    });
    expect(result.outcome).toBe("completed");

    expect(
      await readNarrativeValidationOutcome({
        repository: deps.repository,
        userId,
        artifactKind: "bio",
        draftRef: request.draftRef,
        now: baseTime,
      }),
    ).toMatchObject({ outcome: "ok" });

    const afterExpiry = new Date(baseTime.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(
      await readNarrativeValidationOutcome({
        repository: deps.repository,
        userId,
        artifactKind: "bio",
        draftRef: request.draftRef,
        now: afterExpiry,
      }),
    ).toMatchObject({ outcome: "content_expired" });

    const maintenance = await runNarrativeValidationMaintenance({
      repository: deps.repository,
      now: afterExpiry,
    });
    expect(maintenance.purged).toBeGreaterThanOrEqual(1);
    expect(
      await readNarrativeValidationOutcome({
        repository: deps.repository,
        userId,
        artifactKind: "bio",
        draftRef: request.draftRef,
        now: afterExpiry,
      }),
    ).toMatchObject({ outcome: "content_expired" });
  });

  it("rejects an invalid request as a terminal business fence", async () => {
    const request = cleanRequest(
      "bio-version:01984477-1f9a-7b25-a5cc-000000000009",
      {
        generatorManifest: [
          {
            statementKey: "statement:1",
            text: "The user repairs radios.",
            propositionStatements: [
              {
                propositionKey: "proposition:1",
                normalizedProposition: "The user repairs radios.",
                propositionKind: "fact",
                epistemicRendering: "confirmed",
                supportKeys: ["claim:ghost"],
              },
            ],
          },
        ],
      },
    );
    const deps = dependencies(providerFor(() => acceptedOutput()));
    const result = await runNarrativeValidation({
      dependencies: deps,
      command: { request, expectedDataEpoch: 1 },
    });
    expect(result.outcome).toBe("rejected");
    expect(result.rejectionCode).toBe("support_key_invalid");
    expect(
      await readNarrativeValidationOutcome({
        repository: deps.repository,
        userId,
        artifactKind: "bio",
        draftRef: request.draftRef,
        now: baseTime,
      }),
    ).toMatchObject({ outcome: "not_found" });
  });

  it("rejects a conflicting frozen intent on the same draft locator", async () => {
    const draftRef = "bio-version:01984477-1f9a-7b25-a5cc-00000000000a";
    const original = cleanRequest(draftRef);
    const originalDeps = dependencies(providerFor(() => acceptedOutput()));
    const first = await runNarrativeValidation({
      dependencies: originalDeps,
      command: { request: original, expectedDataEpoch: 1 },
    });
    expect(first.outcome).toBe("completed");

    // The same draft locator frozen with different content is a terminal
    // intent conflict, never a retryable fence (AC-4); the settled result
    // of the first intent stays the one producers read.
    const conflicting = cleanRequest(draftRef, {
      draftText: "The user also paints watercolors.",
    });
    const second = await runNarrativeValidation({
      dependencies: originalDeps,
      command: { request: conflicting, expectedDataEpoch: 1 },
    });
    expect(second.outcome).toBe("rejected");
    expect(second.rejectionCode).toBe("draft_intent_conflict");
    expect(
      await readNarrativeValidationOutcome({
        repository: originalDeps.repository,
        userId,
        artifactKind: "bio",
        draftRef,
        now: baseTime,
      }),
    ).toMatchObject({ outcome: "ok" });
  });
});
