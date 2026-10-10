/**
 * F3 role-provider call capture for the 1A.3b G1 gate.
 *
 * Provider support is limited to the pinned `deepseek` / `opencode-go`
 * adapters; any other pinned provider fails closed. Adapters come from
 * `resolveF3RoleAdapter`, which pins the capture timeout
 * (`F3_ROLE_TIMEOUT_MS`, wider than the runtime default) and reads the
 * deepseek baseUrl only from `SAYHEAR_DEEPSEEK_BASE_URL`.
 */
import { randomUUID, randomUUIDv7 } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntimeOneA3bRoleProviders } from "@sayhear/ai";
import { createModelRoleRegistry, createModelRoleCommandService, createModelRoleProviderEgress, EPISODE_KIND_CATALOG_V1, ProviderDispatchError, type RecoveryGate, type ModelRoleCallUsage } from "@sayhear/application";
import { asDailySessionId, asEvidenceItemId } from "@sayhear/domain";
import { runMigrations, PostgresModelRoleCommandRepository } from "@sayhear/data";
import { createIsolatedPostgresSchema, fixedInternalOwnerPrincipal } from "@sayhear/test-support";
import { snapshotFor, type PinsFile } from "../eval/continuation-acceptance-1a3b/run-validator-capture";
import { resolveF3RoleAdapter } from "../eval/continuation-acceptance-1a3b/role-provider-provisioning";
import { verifyManifest, type AcceptanceManifest } from "../eval/continuation-acceptance-1a3b/manifest";
import { sha256 } from "../eval/continuation-acceptance-1a3b/protocol";
import { buildValidatorRequestBundle } from "../eval/continuation-acceptance-1a3b/validator-inputs";
import type { FixtureCatalog } from "../eval/continuation-acceptance-1a3b/protocol";
async function main() {
  const args = process.argv.slice(2),
    values = new Map<string, string>();
  const allowed = new Set(["--pins", "--manifest", "--catalog", "--out", "--allow-dirty-preflight"]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (!key || !allowed.has(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("Invalid Provider capture arguments.");
    values.set(key, value);
  }
  const root = resolve(import.meta.dirname, "..");
  const checkoutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  const gitDirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8"
  }).split("\n").filter(Boolean).some(entry => !entry.slice(3).startsWith("eval/continuation-acceptance-1a3b/run/") && ![".agent-context", ".agent-parent-branch"].includes(entry.slice(3)));
  const preflight = values.get("--allow-dirty-preflight") === "true";
  if (values.has("--allow-dirty-preflight") && !preflight) throw new Error("Preflight must be explicitly true.");
  if (gitDirty && !preflight) throw new Error("Release Provider capture requires a clean frozen checkout.");
  const path = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`${key} is required.`);
    const p = resolve(root, value);
    if (relative(root, p).startsWith("..")) throw new Error("Capture paths must stay inside the repository.");
    return p;
  };
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("An isolated test database is required.");
  if (process.env.DATABASE_URL) {
    const identity = (value: string) => {
      const u = new URL(value);
      return u.hostname.replace(/-pooler(?=\.)/, "") + u.pathname;
    };
    if (identity(connectionString) === identity(process.env.DATABASE_URL)) throw new Error("Capture cannot use the production database.");
  }
  const pins = JSON.parse(await readFile(path("--pins"), "utf8")) as PinsFile;
  const manifest = JSON.parse(await readFile(path("--manifest"), "utf8")) as AcceptanceManifest;
  const catalog = JSON.parse(await readFile(path("--catalog"), "utf8")) as FixtureCatalog;
  if (!verifyManifest(manifest).passed || sha256(catalog) !== manifest.catalog.sha256 || sha256(pins) !== manifest.pins.sha256) throw new Error("Provider capture inputs must match the frozen F3 manifest.");
  if (manifest.gitCommit !== checkoutCommit) throw new Error("Provider capture commit does not match the checkout.");
  const roles = ["episode.build", "reflection.daily", "reflection.weekly", "narrative.validate"] as const;
  const configurations = roles.map(role => snapshotFor(role, pins));
  const providersPresent = new Set(configurations.map(configuration => configuration.provider));
  const adapters = [...providersPresent].map(provider => resolveF3RoleAdapter(provider));
  console.log("[g1-provider-capture] frozen inputs verified");
  const usage = new Map<string, ModelRoleCallUsage>();
  const providers = createRuntimeOneA3bRoleProviders({
    adapters,
    configurations,
    onUsage: (role, value) => usage.set(role, value)
  });
  const database = await createIsolatedPostgresSchema(connectionString);
  console.log("[g1-provider-capture] isolated schema created");
  const userId = fixedInternalOwnerPrincipal.userId,
    now = new Date();
  const runId = `g1-provider-${randomUUID()}`;
  const calls: Record<string, unknown>[] = [];
  try {
    await runMigrations(database.pool);
    console.log("[g1-provider-capture] migrations applied");
    await database.pool.query("INSERT INTO app_users (user_id,status,data_epoch,created_at,updated_at) VALUES ($1,'active',1,$2,$2)", [userId, now]);
    for (const configuration of configurations) {
      await database.pool.query(`INSERT INTO model_role_configurations (role,config_version,provider,model,model_snapshot,prompt_version,schema_version,role_policy_version,provider_policy_version,freshness_policy,fallback_mode,max_technical_retries,max_semantic_repairs,parameter_snapshot,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`, [configuration.role, configuration.configVersion, configuration.provider, configuration.model, configuration.modelSnapshot, configuration.promptVersion, configuration.schemaVersion, configuration.rolePolicyVersion, configuration.providerPolicyVersion, configuration.freshnessPolicy, configuration.fallbackMode, configuration.maxTechnicalRetries, configuration.maxSemanticRepairs, JSON.stringify(configuration.parameterSnapshot), now]);
      await database.pool.query("UPDATE model_role_definitions SET enabled=TRUE WHERE role=$1", [configuration.role]);
      await database.pool.query("INSERT INTO model_role_rollout_pins (role,rollout_pin,config_version,provider_policy_version,status,activated_at) VALUES ($1,$2,$3,$4,'active',$5)", [configuration.role, configuration.rolloutPin, configuration.configVersion, configuration.providerPolicyVersion, now]);
    }
    const service = createModelRoleCommandService({
      registry: createModelRoleRegistry(configurations),
      repository: new PostgresModelRoleCommandRepository(database.pool)
    });
    console.log("[g1-provider-capture] role registry initialized");
    // This local synthetic schema has no deployable release. As in the existing
    // validator capture, enforce database attempt/epoch fences without asserting
    // a production manifest. Hosted startup verification remains mandatory.
    const openGate = async () => ({
      status: "open" as const,
      markerDataEpoch: null,
      markerPurgedAt: null,
      markerWrittenAt: null,
      receiptDestinations: []
    });
    const recoveryGate: RecoveryGate = {
      evaluate: openGate,
      requireOpen: openGate
    };
    const egress = createModelRoleProviderEgress({
      commandService: {
        claimProviderDispatch: input => service.claimProviderDispatch(input),
        discardAttempt: input => service.discardAttempt(input)
      },
      recoveryGate
    });
    const evidenceItemId = asEvidenceItemId(randomUUIDv7()),
      dailySessionId = asDailySessionId(randomUUIDv7());
    const sourceText = "This is synthetic acceptance data. The fictional owner moved to a new home on September 15, 2026 and spent the next day unpacking boxes.";
    for (const role of roles) {
      const configuration = service.configuration(role)!;
      const admitted = await service.admit({
        userId,
        role,
        intentKey: `${runId}:${role}`,
        subjectType: "app_user",
        subjectId: userId,
        sourceRevision: 1,
        sourceSnapshot: `${runId}:${role}`,
        inputManifest: [],
        expectedDataEpoch: 1,
        now
      });
      try {
        await egress.dispatch({
          userId,
          generationCommandId: admitted.generationCommandId,
          modelRunAttemptId: admitted.modelRunAttemptId,
          role,
          attemptNo: admitted.attemptNo,
          attemptKind: admitted.attemptKind,
          rolloutPin: configuration.rolloutPin,
          currentSourceRevision: 1,
          expectedDataEpoch: 1,
          now,
          execute: async () => {
            if (role === "episode.build") return providers.episodeBuildProvider.buildProposals({
              userId,
              dailySessionId,
              sourceRevision: 1,
              kindCatalog: EPISODE_KIND_CATALOG_V1,
              evidence: [{
                evidenceItemId,
                locatorType: "text_span",
                locatorKey: "0:100",
                sourceText,
                locale: "en-US"
              }],
              activeEpisodes: []
            });
            if (role === "narrative.validate") {
              const bundle = buildValidatorRequestBundle(catalog, {
                generatorManifests: {}
              })[0];
              if (!bundle) throw new Error("Catalog has no validator request.");
              return providers.narrativeValidationProvider.validateNarrative({
                ...bundle.request,
                userId
              });
            }
            return providers.reflectionProvider.generate({
              userId,
              role,
              scopeType: role === "reflection.daily" ? "daily_session" : "date_range",
              weekIdentifier: role === "reflection.weekly" ? "2026-W38" : null,
              locale: "en-US",
              evidence: [{
                evidenceItemId,
                dailySessionId,
                logicalDate: "2026-09-15",
                locatorType: "text_span",
                locatorKey: "0:100",
                sourceText,
                locale: "en-US",
                revisionId: randomUUIDv7()
              }],
              episodes: [],
              summaries: [],
              baseline: [],
              sessionCount: 1,
              maxStatements: 4,
              maxPropositionsPerStatement: 4,
              maxCandidateProposals: 4
            });
          }
        });
        const settlement = await service.recordAttemptResult({
          userId,
          generationCommandId: admitted.generationCommandId,
          modelRunAttemptId: admitted.modelRunAttemptId,
          role,
          attemptNo: admitted.attemptNo,
          technicalRetriesUsed: 0,
          semanticRepairsUsed: 0,
          outcome: "succeeded",
          currentSourceRevision: 1,
          expectedDataEpoch: 1,
          now: new Date()
        });
        if (settlement.outcome !== "succeeded") throw new Error("Provider capture result did not pass its database settlement fence.");
        calls.push({
          role,
          provider: configuration.provider,
          model: configuration.model,
          modelSnapshot: configuration.modelSnapshot,
          parameters: pins.roles[role]!.parameters,
          promptVersion: configuration.promptVersion,
          schemaVersion: configuration.schemaVersion,
          configVersion: configuration.configVersion,
          providerPolicyVersion: configuration.providerPolicyVersion,
          rolloutPin: configuration.rolloutPin,
          rolePolicyVersion: configuration.rolePolicyVersion,
          completedAt: new Date().toISOString(),
          generationCommandId: admitted.generationCommandId,
          modelRunAttemptId: admitted.modelRunAttemptId,
          outcome: "completed",
          usage: usage.get(role) ?? null
        });
      } catch (error) {
        const category = typeof error === "object" && error !== null && "category" in error ? String(error.category) : "capture_failed";
        const responseFailure = error instanceof ProviderDispatchError ? error.failure ?? null : null;
        calls.push({
          errorCode: category,
          responseFailure,
          role,
          generationCommandId: admitted.generationCommandId,
          modelRunAttemptId: admitted.modelRunAttemptId,
          outcome: "failed",
          usage: usage.get(role) ?? (responseFailure ? {
            inputTokens: responseFailure.inputTokens,
            outputTokens: responseFailure.outputTokens,
            reasoningTokens: responseFailure.reasoningTokens
          } : null)
        });
      }
      console.log(`[g1-provider-capture] ${role}: ${calls.at(-1)?.outcome}`);
    }
    await mkdir(resolve(path("--out"), ".."), {
      recursive: true
    });
    await writeFile(path("--out"), `${JSON.stringify({
      version: "g1-provider-capture:v1",
      synthetic: true,
      preflight,
      gitDirty,
      runId,
      manifestFingerprint: manifest.fingerprint,
      gitCommit: checkoutCommit,
      capturedAt: new Date().toISOString(),
      providerCalls: calls
    }, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
    if (calls.some(call => call.outcome !== "completed")) process.exitCode = 1;
  } finally {
    await database.dispose();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "capture_failed";
    const name = error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : "Error";
    const reason = typeof error === "object" && error !== null && "reason" in error && ["owner", "epoch", "rollout", "retired_role"].includes(String(error.reason)) ? error.reason : undefined;
    console.error("G1 Provider capture failed:", name, code, reason ?? "");
    process.exitCode = 1;
  });
}
