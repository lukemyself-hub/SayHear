import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createModelRoleCommandService,
  createModelRoleProviderEgress,
  createModelRoleRegistry,
  ONE_A_3B_ROLE_POLICIES,
  ONE_A_3B_ROLE_POLICY_VERSION,
  ONE_A_3B_G1_ROLE_CONFIG_VERSIONS,
  ONE_A_3B_G1_ROLLOUT_PIN_VERSION,
  readNarrativeValidationOutcome,
  runNarrativeValidation,
  NARRATIVE_FINDINGS_SCHEMA_VERSION,
  NARRATIVE_VALIDATION_POLICY_VERSION,
  NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION,
  type ModelRoleCallUsage,
  type ModelRoleConfigurationSnapshot,
  type NarrativeValidationEntrypointDependencies,
  type NarrativeValidationRequest,
  type ProviderResponseFailure,
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
} from "@sayhear/test-support";
import { createRuntimeOneA3bRoleProviders } from "@sayhear/ai";

import {
  buildValidatorRequestBundle,
  loadValidatorCatalog,
} from "./validator-inputs";
import { verifyManifest, type AcceptanceManifest } from "./manifest";
import { sha256, type FixtureCatalog } from "./protocol";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const apiKey = process.env.DEEPSEEK_API_KEY;
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

const userId = fixedInternalOwnerPrincipal.userId;
const baseTime = new Date("2026-09-09T08:00:00.000Z");

const G1_CAPTURE_ROLES = [
  "episode.build",
  "reflection.daily",
  "reflection.weekly",
  "narrative.validate",
] as const;

function required(arguments_: readonly string[], index: number, name: string): string {
  const value = arguments_[index];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

function parseArguments(): { allowDirty: boolean; catalog: string; continueOnError: boolean; manifest: string; only: string; out: string; pins: string; precision: boolean; resume: boolean } {
  const arguments_ = process.argv.slice(2);
  const values = {
    allowDirty: false,
    catalog: "eval/continuation-acceptance-1a3b/fixtures.json",
    continueOnError: false,
    manifest: "eval/continuation-acceptance-1a3b/run/manifest.json",
    only: "",
    out: "",
    pins: "eval/continuation-acceptance-1a3b/pins.json",
    precision: false,
    resume: false,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--allow-dirty") values.allowDirty = true;
    else if (argument === "--catalog") values.catalog = required(arguments_, ++index, argument);
    else if (argument === "--continue-on-error") values.continueOnError = true;
    else if (argument === "--manifest") values.manifest = required(arguments_, ++index, argument);
    else if (argument === "--only") values.only = required(arguments_, ++index, argument);
    else if (argument === "--out") values.out = required(arguments_, ++index, argument);
    else if (argument === "--pins") values.pins = required(arguments_, ++index, argument);
    else if (argument === "--precision") values.precision = true;
    else if (argument === "--resume") values.resume = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!values.out) {
    values.out = values.precision
      ? "eval/continuation-acceptance-1a3b/run/validator-precision-report.json"
      : "eval/continuation-acceptance-1a3b/run/validator-machine-verdicts.json";
  }
  return values;
}

/**
 * Clean-draft precision probe: fully source-faithful Reflection drafts (no planted
 * error) with a correct writer manifest. A clean draft must complete with
 * zero blocking findings; any blocking finding is a false positive.
 *
 * These are bound to the spent catalog's claim IDs. A holdout that was never
 * used for tuning must supply its own via `precisionDrafts` in its catalog, or
 * its precision half would silently reuse spent drafts.
 */
const BUILT_IN_PRECISION_DRAFTS = [
  { id: "precision-clean-en-1", locale: "en-US", inputRef: "validator-en", claimId: "syn-claim-validator-en", draftText: "The user repairs radios." },
  { id: "precision-clean-en-2", locale: "en-US", inputRef: "validator-en", claimId: "syn-claim-validator-en", draftText: "Repairing radios is what the user does." },
  { id: "precision-clean-zh-1", locale: "zh-CN", inputRef: "validator-zh", claimId: "syn-claim-validator-zh", draftText: "该用户会修理收音机。" },
  { id: "precision-clean-zh-2", locale: "zh-CN", inputRef: "validator-zh", claimId: "syn-claim-validator-zh", draftText: "修理收音机是该用户会做的事情。" },
  { id: "precision-clean-mix-1", locale: "zh-CN", inputRef: "validator-mix", claimId: "syn-claim-validator-mix", draftText: "Repair radios 是虚构用户会做的事情。" },
  { id: "precision-clean-mix-2", locale: "zh-CN", inputRef: "validator-mix", claimId: "syn-claim-validator-mix", draftText: "虚构用户会 repair radios。" },
] as const;

export type PinsFile = {
  roles: Record<
    string,
    {
      fallback: string;
      maxTechnicalRetries: number;
      model: string;
      parameters: { maxOutputTokens: number; temperature: number };
      policyVersion: string;
      promptVersion: string;
      provider: string;
      schemaVersion: string;
      snapshot: string;
    }
  >;
};

export function snapshotFor(role: (typeof G1_CAPTURE_ROLES)[number], pins: PinsFile): ModelRoleConfigurationSnapshot {
  const pin = pins.roles[role];
  if (!pin) throw new Error(`Pins file has no ${role} role.`);
  if (pin.provider !== "deepseek") {
    throw new Error(`Capture supports the pinned deepseek provider, found ${pin.provider} for ${role}.`);
  }
  if (pin.fallback !== "none") {
    throw new Error(`Capture requires fallback none, found ${pin.fallback} for ${role}.`);
  }
  if (pin.maxTechnicalRetries !== 0 && pin.maxTechnicalRetries !== 1) {
    throw new Error(`Capture supports maxTechnicalRetries 0|1 for ${role}.`);
  }
  // Lifecycle fields come from the frozen role policy, never from the pins:
  // the registry rejects anything else. A pins/policy disagreement fails
  // loudly here instead of silently running an unevaluated configuration.
  const policy = ONE_A_3B_ROLE_POLICIES[role];
  const iteration = ONE_A_3B_G1_ROLE_CONFIG_VERSIONS[role];
  if (pin.maxTechnicalRetries !== policy.maxTechnicalRetries) {
    throw new Error(
      `Pins disagree with the frozen role policy for ${role}: pins maxTechnicalRetries ${pin.maxTechnicalRetries}, policy ${policy.maxTechnicalRetries}.`,
    );
  }
  return {
    role,
    configVersion: `${role}:g1-release:${iteration}`,
    provider: pin.provider,
    model: pin.model,
    modelSnapshot: pin.snapshot,
    promptVersion: pin.promptVersion,
    schemaVersion: pin.schemaVersion,
    rolePolicyVersion: ONE_A_3B_ROLE_POLICY_VERSION,
    providerPolicyVersion: `deepseek-${role}-egress:g1-release:${iteration}`,
    rolloutPin: `${role}-g1-release-pin:${ONE_A_3B_G1_ROLLOUT_PIN_VERSION}`,
    freshnessPolicy: policy.freshnessPolicy,
    fallbackMode: "disabled",
    maxTechnicalRetries: policy.maxTechnicalRetries,
    maxSemanticRepairs: policy.maxSemanticRepairs,
    parameterSnapshot: {
      temperature: pin.parameters.temperature,
      maxOutputTokens: pin.parameters.maxOutputTokens,
    },
  };
}

type CaptureIdentity = Readonly<{
  catalogSha256: string;
  gitCommit: string;
  gitDirty: boolean;
  pinsFingerprint: string;
}>;

const repositoryRoot = resolve(import.meta.dirname, "../..");

/** The exact checkout a formal capture must execute, not merely claim. */
function gitIdentity(): { gitCommit: string; gitDirty: boolean } {
  const gitCommit = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const gitDirty =
    execFileSync("git", ["-C", repositoryRoot, "status", "--porcelain"], {
      encoding: "utf8",
    }).trim().length > 0;
  if (!/^[0-9a-f]{40}$/.test(gitCommit)) {
    throw new Error("Capture did not resolve a full 40-character git commit.");
  }
  return { gitCommit, gitDirty };
}

/**
 * A resumed report may only reuse completed cases that were produced by the
 * same code and the same frozen pins. The report header is the case's
 * provenance: if any identity field differs, the old cases must not be
 * carried forward under a rewritten header. This refuses rather than
 * relabeling, so a cheaper pin set cannot be re-attributed to the release pin.
 */
export function assertResumeIdentity(
  previous: Record<string, unknown>,
  current: CaptureIdentity &
    Readonly<{
      configuration: ModelRoleConfigurationSnapshot;
      parameters: unknown;
    }>,
): void {
  const expected: Record<string, unknown> = {
    catalogSha256: current.catalogSha256,
    configVersion: current.configuration.configVersion,
    gitCommit: current.gitCommit,
    gitDirty: false,
    maxOutputTokens: current.configuration.parameterSnapshot.maxOutputTokens ?? null,
    model: current.configuration.model,
    modelSnapshot: current.configuration.modelSnapshot,
    pinsFingerprint: current.pinsFingerprint,
    promptVersion: current.configuration.promptVersion,
    provider: current.configuration.provider,
    providerCallBudget: current.configuration.maxTechnicalRetries + 1,
    schemaVersion: current.configuration.schemaVersion,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (previous[key] !== value) {
      throw new Error(
        `Resume report ${key} does not match the current capture identity; refusing to relabel completed cases.`,
      );
    }
  }
  if (sha256(previous.parameters) !== sha256(current.parameters)) {
    throw new Error(
      "Resume report parameters do not match the current capture pin; refusing to relabel completed cases.",
    );
  }
}

async function main(): Promise<void> {
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required (isolated capture schema).");
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required (pinned provider is deepseek).");
  const arguments_ = parseArguments();
  const catalog = loadValidatorCatalog(resolve(arguments_.catalog));
  const manifest = JSON.parse(await readFile(resolve(arguments_.manifest), "utf8")) as AcceptanceManifest;
  const manifestVerification = verifyManifest(manifest);
  if (!manifestVerification.passed) {
    throw new Error(`Manifest verification failed: ${manifestVerification.mismatches.join("; ")}`);
  }
  if (sha256(catalog as unknown as Record<string, unknown>) !== manifest.catalog.sha256) {
    throw new Error("Validator catalog does not match the supplied manifest.");
  }
  const pins = JSON.parse(await readFile(resolve(arguments_.pins), "utf8")) as PinsFile;
  const configurations = G1_CAPTURE_ROLES.map((role) => snapshotFor(role, pins));
  const narrativeConfiguration = configurations.find(
    (configuration) => configuration.role === "narrative.validate",
  )!;
  const pinsFingerprint = sha256(pins as unknown as Record<string, unknown>);
  const catalogSha256 = sha256(catalog as unknown as Record<string, unknown>);
  const identity = gitIdentity();
  if (identity.gitDirty && !arguments_.allowDirty) {
    throw new Error(
      "Formal validator capture requires a clean checkout at the frozen commit; use --allow-dirty only for non-evidence diagnostics.",
    );
  }
  const captureIdentity = {
    catalogSha256,
    gitCommit: identity.gitCommit,
    gitDirty: identity.gitDirty,
    parameters: pins.roles["narrative.validate"]!.parameters,
    pinsFingerprint,
  };
  const providers = createRuntimeOneA3bRoleProviders({
    adapters: [{ provider: "deepseek", baseUrl, apiKey, timeoutMs: 120_000 }],
    configurations,
  });

  const database = await createIsolatedPostgresSchema(testDatabaseUrl);
  try {
    await runMigrations(database.pool);
    await database.pool.query(
      `INSERT INTO app_users (user_id, status, data_epoch, created_at, updated_at)
       VALUES ($1, 'active', 1, $2, $2)`,
      [userId, baseTime],
    );
    // Migrations register the exact release egress policies before capture.
    await database.pool.query(
      `INSERT INTO model_role_configurations (
         role, config_version, provider, model, model_snapshot, prompt_version,
         schema_version, role_policy_version, provider_policy_version,
         freshness_policy, fallback_mode, max_technical_retries,
         max_semantic_repairs, parameter_snapshot, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
      [
        narrativeConfiguration.role,
        narrativeConfiguration.configVersion,
        narrativeConfiguration.provider,
        narrativeConfiguration.model,
        narrativeConfiguration.modelSnapshot,
        narrativeConfiguration.promptVersion,
        narrativeConfiguration.schemaVersion,
        narrativeConfiguration.rolePolicyVersion,
        narrativeConfiguration.providerPolicyVersion,
        narrativeConfiguration.freshnessPolicy,
        narrativeConfiguration.fallbackMode,
        narrativeConfiguration.maxTechnicalRetries,
        narrativeConfiguration.maxSemanticRepairs,
        JSON.stringify(narrativeConfiguration.parameterSnapshot),
        baseTime,
      ],
    );
    await database.pool.query(
      "UPDATE model_role_definitions SET enabled = TRUE WHERE role = $1",
      [narrativeConfiguration.role],
    );
    await database.pool.query(
      `INSERT INTO model_role_rollout_pins (
         role, rollout_pin, config_version, provider_policy_version,
         status, activated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5)`,
      [
        narrativeConfiguration.role,
        narrativeConfiguration.rolloutPin,
        narrativeConfiguration.configVersion,
        narrativeConfiguration.providerPolicyVersion,
        baseTime,
      ],
    );
    const commandService = createModelRoleCommandService({
      registry: createModelRoleRegistry(configurations),
      repository: new PostgresModelRoleCommandRepository(database.pool),
    });
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
    const dependencies: NarrativeValidationEntrypointDependencies = {
      clock: () => baseTime,
      repository: new PostgresNarrativeValidationRepository(database.pool),
      modelRoleCommandService: commandService,
      narrativeValidationProvider: providers.narrativeValidationProvider,
      providerEgress: createModelRoleProviderEgress({
        commandService: {
          claimProviderDispatch: (input) => commandService.claimProviderDispatch(input),
          discardAttempt: (input) => commandService.discardAttempt(input),
        },
        recoveryGate: gate,
      }),
    };
    const bundles = buildValidatorRequestBundle(catalog as FixtureCatalog, {
      generatorManifests: {},
    });
    // Precision mode replaces the 18 calibration fixtures with the clean
    // drafts (same request shape, correct writer manifest each).
    const precisionManifests = new Map<string, NarrativeValidationRequest["generatorManifest"]>();
    let cases: readonly { fixtureId: string; validatorErrorClass: string; request: NarrativeValidationRequest }[] = bundles;
    if (arguments_.precision) {
      const typedCatalog = catalog as FixtureCatalog;
      const precisionDrafts =
        typedCatalog.precisionDrafts ?? BUILT_IN_PRECISION_DRAFTS;
      cases = precisionDrafts.map((draft) => {
        const sharedInput = typedCatalog.sharedInputs[draft.inputRef];
        const claim = sharedInput?.memory.find((candidate) => candidate.id === draft.claimId);
        if (!claim) throw new Error(`Precision draft ${draft.id} cites unknown claim ${draft.claimId}.`);
        const event = sharedInput?.events.find((entry) => claim.evidenceIds.includes(entry.id));
        if (!event) throw new Error(`Precision draft ${draft.id} has no direct Evidence source.`);
        const manifest = [
          {
            statementKey: `${draft.id}:statement:1`,
            text: draft.draftText,
            propositionStatements: [
              {
                propositionKey: `${draft.id}:proposition:1`,
                normalizedProposition: draft.draftText,
                propositionKind: "fact" as const,
                epistemicRendering: "confirmed" as const,
                supportKeys: [event.id],
              },
            ],
          },
        ];
        precisionManifests.set(draft.id, manifest);
        return {
          fixtureId: draft.id,
          validatorErrorClass: "clean",
          request: {
            userId: bundles[0]!.request.userId,
            artifactKind: "reflection" as const,
            draftRef: `validator-precision:${draft.id}`,
            draftLocale: draft.locale,
            draftText: draft.draftText,
            generatorManifest: [],
            sourceEntries: [
              {
                sourceKey: event.id,
                sourceKind: "evidence_item" as const,
                text: event.text,
                epistemicKind:
                  claim.kind === "objective_memory" ? ("objective_memory" as const) : null,
              },
            ],
            plannedCoverageKeys: [event.id],
            validationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
            promptVersion: NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION,
            schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
          },
        };
      });
    }
    const results: {
      advisoryFindingCodes: readonly string[];
      blockingFindingCodes: readonly string[];
      errorCode: string | null;
      fixtureId: string;
      generationCommandId: string | null;
      modelRunAttemptId: string | null;
      model: string;
      outcome: string;
      provider: string;
      responseFailure: ProviderResponseFailure | null;
      usage: ModelRoleCallUsage | null;
      verdict: string | null;
    }[] = [];
    // --resume keeps already-recorded completed fixtures (same manifest
    // fingerprint) so transient reasoning-budget blowouts don't re-burn
    // tokens. Failed entries are always retried.
    if (arguments_.resume) {
      try {
        const previous = JSON.parse(
          await readFile(resolve(arguments_.out), "utf8"),
        ) as Record<string, unknown> & {
          cases: typeof results;
          manifestFingerprint: string;
        };
        if (previous.manifestFingerprint !== manifest.fingerprint) {
          throw new Error("Previous verdicts do not belong to the supplied manifest.");
        }
        // The manifest fingerprint is not enough: a previous run with the same
        // manifest but a different pins/code identity must not be reused under
        // the current header.
        assertResumeIdentity(previous, { ...captureIdentity, configuration: narrativeConfiguration });
        for (const entry of previous.cases) {
          // A report resumed from before #252 has no recorded cause; keep the
          // per-case shape uniform so the frozen artifact stays comparable.
          if (entry.outcome === "completed") {
            results.push({
              ...entry,
              responseFailure: entry.responseFailure ?? null,
              usage: entry.usage ?? null,
            });
          }
        }
        if (results.length > 0) {
          console.log(
            `[f3-validator-capture] resume: kept ${results.length} completed verdict(s).`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const done = new Set(results.map((entry) => entry.fixtureId));
    for (const bundle of cases) {
      if (arguments_.only && bundle.fixtureId !== arguments_.only) continue;
      if (done.has(bundle.fixtureId)) {
        console.log(`[f3-validator-capture] ${bundle.fixtureId}: skipped (already recorded)`);
        continue;
      }
      const precisionManifest = precisionManifests.get(bundle.fixtureId);
      let generatorManifest: NarrativeValidationRequest["generatorManifest"];
      if (precisionManifest) {
        generatorManifest = precisionManifest;
      } else if (bundle.validatorErrorClass === "epistemic_upgrade") {
        generatorManifest = [
            {
              statementKey: `${bundle.fixtureId}:statement:1`,
              text: bundle.request.draftText,
              propositionStatements: [
                {
                  propositionKey: `${bundle.fixtureId}:proposition:1`,
                  normalizedProposition: bundle.request.draftText,
                  propositionKind: "impression" as const,
                  epistemicRendering: "inferred" as const,
                  supportKeys: [...bundle.request.sourceEntries.map((entry) => entry.sourceKey)],
                },
              ],
            },
          ];
      } else {
        generatorManifest = [];
      }
      const request = { ...bundle.request, generatorManifest };
      const result = await runNarrativeValidation({
        dependencies,
        command: { request, expectedDataEpoch: 1 },
      });
      let blockingFindingCodes: readonly string[] = [];
      let advisoryFindingCodes: readonly string[] = [];
      if (result.outcome === "completed") {
        const read = await readNarrativeValidationOutcome({
          repository: dependencies.repository,
          userId: bundle.request.userId,
          artifactKind: bundle.request.artifactKind,
          draftRef: bundle.request.draftRef,
          now: baseTime,
        });
        if (read.outcome !== "ok") {
          throw new Error(`Fixture ${bundle.fixtureId} has no committed result.`);
        }
        blockingFindingCodes = read.result.result.blockingFindings.map(
          (finding) => finding.findingCode,
        );
        advisoryFindingCodes = read.result.result.advisoryFindings.map(
          (finding) => finding.findingCode,
        );
      }
      results.push({
        advisoryFindingCodes,
        blockingFindingCodes,
        errorCode: result.outcome === "completed" ? null : (result.errorCode ?? null),
        fixtureId: bundle.fixtureId,
        generationCommandId: result.generationCommandId,
        modelRunAttemptId: result.modelRunAttemptId,
        model: narrativeConfiguration.model,
        outcome: result.outcome,
        provider: narrativeConfiguration.provider,
        // Issue #252: a frozen `schema_incompatible` no longer hides whether
        // the pinned output budget, an empty final answer, the JSON parse, or
        // the frozen schema was at fault. Content-free by construction, so it
        // is safe to keep in release evidence.
        responseFailure: result.responseFailure,
        // Recorded for completed calls too. Only the calls that fit in the
        // budget prove the budget has headroom, so leaving them blank would
        // make "8000 is enough" indistinguishable from "8000 barely held".
        usage: result.usage,
        verdict: result.outcome === "completed" ? result.verdict : null,
        ...(arguments_.precision
          ? {
              draftText: bundle.request.draftText,
              generatorManifest,
              sourceEntries: bundle.request.sourceEntries,
            }
          : {}),
      });
      console.log(
        `[f3-validator-capture] ${bundle.fixtureId}: ${result.outcome} ${result.outcome === "completed" ? result.verdict : ""}`.trim(),
      );
      // A non-completed case is always systematic (frozen prompt, pinned
      // model, temperature 0) — stop before burning tokens on the rest.
      // Pass --continue-on-error to force a full pass anyway.
      if (result.outcome !== "completed" && !arguments_.continueOnError) {
        console.log(
          `[f3-validator-capture] fail-fast: ${bundle.fixtureId} ended ${result.outcome} (errorCode=${result.errorCode ?? "null"}); wrote ${results.length} partial verdict(s).`,
        );
        break;
      }
    }
    await writeFile(
      resolve(arguments_.out),
      `${JSON.stringify(
        {
          version: arguments_.precision
            ? "1a3b-f3-validator-precision-report:v1"
            : "1a3b-f3-validator-machine-verdicts:v1",
          manifestFingerprint: manifest.fingerprint,
          // The capture binds the code and frozen inputs it actually ran on, so
          // a completion builder can refuse a capture whose provenance is not
          // the frozen manifest's commit/catalog/pins identity.
          gitCommit: captureIdentity.gitCommit,
          gitDirty: captureIdentity.gitDirty,
          catalogSha256,
          pinsFingerprint,
          capturedAt: new Date().toISOString(),
          provider: narrativeConfiguration.provider,
          model: narrativeConfiguration.model,
          modelSnapshot: narrativeConfiguration.modelSnapshot,
          configVersion: narrativeConfiguration.configVersion,
          promptVersion: narrativeConfiguration.promptVersion,
          schemaVersion: narrativeConfiguration.schemaVersion,
          parameters: pins.roles["narrative.validate"]!.parameters,
          // The frozen budget is recorded beside the causes so the next
          // versioned configuration is chosen against measured spend, not
          // against a guess (issue #252).
          maxOutputTokens:
            narrativeConfiguration.parameterSnapshot.maxOutputTokens ?? null,
          providerCallBudget:
            narrativeConfiguration.maxTechnicalRetries + 1,
          cases: results,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`[f3-validator-capture] wrote ${results.length} verdicts to ${arguments_.out}`);
    if (results.length !== cases.length) {
      console.error(
        `[f3-validator-capture] incomplete: ${results.length}/${cases.length} cases recorded; rerun after fixing the failure.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await database.dispose();
  }
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error("[f3-validator-capture] failed:", error);
    process.exitCode = 1;
  });
}
