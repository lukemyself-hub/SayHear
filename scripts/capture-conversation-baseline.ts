import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  CANONICAL_PERSONA_VERSION,
  CHINESE_LOCALE_PACK_VERSION,
  countFollowUpQuestions,
  ENGLISH_LOCALE_PACK_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  createConversationActionGateway,
  createConversationAgentHarness,
  createConversationResponseService,
  createContextCompiler,
  createJournalRegenerationActionHandler,
  createUserTextConversationService,
  JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  TIME_AWARE_CONTEXT_COMPILER_VERSION,
  validateMinimumHighRiskResponse,
  validateUnderstandingResponse,
  type ConversationTextChampion,
  type GenerationPolicy,
} from "@sayhear/application";
import { createRuntimeProviderEgressPort } from "@sayhear/ai";
import {
  PostgresConversationResponseRepository,
  PostgresInternalOwnerAccessRepository,
  PostgresJournalRegenerationActionRepository,
  PostgresUserTextConversationRepository,
  runMigrations,
} from "@sayhear/data";
import {
  createIsolatedPostgresSchema,
  fixedInternalOwnerPrincipal,
} from "@sayhear/test-support";

import { createConversationResponseHandler } from "../apps/web/src/conversation-response-handler";

/**
 * Conversation Text Champion baseline capture (issue #61).
 *
 * Runs fully synthetic multi-turn scenarios through the highest authenticated
 * Text system seam — the production BFF NDJSON handler over the real
 * ConversationResponseService, Conversation Agent Harness, Action Gateway,
 * Context Compiler, and the configured Provider Egress adapter — and
 * records outputs, versions, and mechanical behavior checks as a
 * non-authoritative eval artifact (Initial Replay semantics: ADR-0020, ADR-0073;
 * no product state is written — everything lands in a disposable isolated
 * PostgreSQL schema that is dropped when the run finishes).
 *
 * Usage:
 *   tsx scripts/capture-conversation-baseline.ts [--out <dir>] [--scenarios <file>] [--force]
 *
 * Required environment (read from process.env or the repo root .env):
 *   DATABASE_URL, SAYHEAR_PROVIDER_ADAPTER=deepseek|openai|opencode-go, the
 *   matching *_API_KEY, and optionally SAYHEAR_DEEPSEEK_BASE_URL /
 *   SAYHEAR_CONVERSATION_TEXT_MODEL / SAYHEAR_PROVIDER_TIMEOUT_MS.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "..");

type ScenarioTurn = Readonly<{ text: string; gapMs?: number }>;

type Scenario = Readonly<{
  category: string;
  description: string;
  id: string;
  languageVariant: string;
  locale: string;
  timezone: string;
  turns: readonly ScenarioTurn[];
}>;

type ScenarioFile = Readonly<{ scenarios: readonly Scenario[] }>;

const DOMAIN_CLOCK_START_ISO = "2026-08-21T02:00:00.000Z";
const DEFAULT_TURN_GAP_MS = 90_000;
const SYNTHETIC_BACKUP_POLICY_VERSION = "baseline-synthetic:v1";
const SYNTHETIC_BACKUP_FINGERPRINT = "sha256:baseline-synthetic";
const SYNTHETIC_CONTEXT_HMAC_SECRET = "baseline-context-integrity-secret";

function parseArguments(): {
  force: boolean;
  outDir: string;
  scenariosFile: string;
} {
  const arguments_ = process.argv.slice(2);
  let force = false;
  let outDir = path.join(repositoryRoot, "eval/conversation-text-baseline/run");
  let scenariosFile = path.join(
    repositoryRoot,
    "eval/conversation-text-baseline/scenarios.json",
  );
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === "--force") {
      force = true;
    } else if (argument === "--out") {
      outDir = path.resolve(requiredArgument(arguments_, ++index, "--out"));
    } else if (argument === "--scenarios") {
      scenariosFile = path.resolve(
        requiredArgument(arguments_, ++index, "--scenarios"),
      );
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { force, outDir, scenariosFile };
}

function requiredArgument(
  arguments_: readonly string[],
  index: number,
  name: string,
): string {
  const value = arguments_[index];
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

/** Load repo-root .env without overriding already-set process.env values. */
function loadDotEnv(): void {
  const envPath = path.join(repositoryRoot, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function gitCommit(): string {
  try {
    return execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

type ChampionAssembly = Readonly<{
  champion: ConversationTextChampion;
  providerTransport: Readonly<
    | {
        apiKey: string;
        baseUrl: string;
        timeoutMs: number;
        type: "responses-api";
      }
    | {
        apiKey: string;
        timeoutMs: number;
        type: "opencode-go";
      }
  >;
}>;

function buildChampion(environment: NodeJS.ProcessEnv): ChampionAssembly {
  const adapter =
    environment.SAYHEAR_PROVIDER_ADAPTER === "openai"
      ? "openai"
      : environment.SAYHEAR_PROVIDER_ADAPTER === "opencode-go"
        ? "opencode-go"
        : "deepseek";
  const profile =
    adapter === "deepseek"
      ? {
          apiKey: requiredEnvironment("DEEPSEEK_API_KEY"),
          baseUrl: environment.SAYHEAR_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
          defaultModel: "deepseek-v4-flash",
          provider: "deepseek" as const,
          providerPolicyVersion: "deepseek-conversation-text:v1",
          type: "responses-api" as const,
        }
      : adapter === "opencode-go"
        ? {
            apiKey: requiredEnvironment("OPENCODE_GO_API_KEY"),
            defaultModel: "deepseek-v4.1-flash",
            provider: "opencode-go" as const,
            providerPolicyVersion: "opencode-go-conversation-text:v1",
            type: "opencode-go" as const,
          }
        : {
            apiKey: requiredEnvironment("OPENAI_API_KEY"),
            baseUrl: "https://api.openai.com/v1",
            defaultModel: "gpt-5.4",
            provider: "openai" as const,
            providerPolicyVersion: "openai-conversation-text:v1",
            type: "responses-api" as const,
          };
  const model = environment.SAYHEAR_CONVERSATION_TEXT_MODEL ?? profile.defaultModel;
  const champion: ConversationTextChampion = Object.freeze({
    configVersion: "conversation-text-champion:v1",
    consentPolicyVersion: null,
    contextLimit: 1_000_000,
    dataRegion:
      adapter === "opencode-go" ? "provider-managed" : "provider-configured",
    model,
    provider: profile.provider,
    providerPolicyVersion: profile.providerPolicyVersion,
    retentionMode: "store-disabled",
    snapshot: environment.SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT ?? model,
    streaming: true,
    supportedLocales: Object.freeze(["en", "zh"]),
    trainingPolicy: "api-data-controls",
  });
  const timeoutMs = Number(environment.SAYHEAR_PROVIDER_TIMEOUT_MS ?? "60000");
  return {
    champion,
    providerTransport:
      profile.type === "opencode-go"
        ? { apiKey: profile.apiKey, timeoutMs, type: "opencode-go" }
        : { apiKey: profile.apiKey, baseUrl: profile.baseUrl, timeoutMs, type: "responses-api" },
  };
}

async function readNdjson(
  response: Response,
): Promise<readonly Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function joinDeltas(events: readonly Record<string, unknown>[]): string {
  return events
    .filter((event) => event.type === "assistant_delta")
    .map((event) => String(event.delta ?? ""))
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeReceipt(
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of [
    "actionKind",
    "admission",
    "catalogVersion",
    "disposition",
    "execution",
    "finalization",
    "receiptSequence",
  ]) {
    if (receipt[key] !== undefined) {
      summary[key] = receipt[key];
    }
  }
  return summary;
}

type CapturedTurn = Readonly<{
  assistantText: string;
  checks: Readonly<{
    followUpQuestionCount: number;
    minimumHighRiskViolations: readonly string[] | null;
    understandingViolations: readonly string[];
  }>;
  domainClockIso: string;
  finalEventType: string;
  input: Readonly<{ locale: string; text: string; timezone: string }>;
  providerUsage: Readonly<{
    attemptCount: number;
    costMicros: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  }> | null;
  receipt: Readonly<Record<string, unknown>> | null;
  sequenceInScenario: number;
  wallMs: number;
}>;

type CapturedScenario = Readonly<{
  category: string;
  description: string;
  domainClockStartIso: string;
  id: string;
  languageVariant: string;
  turns: readonly CapturedTurn[];
}>;

/**
 * Scenario isolation: every scenario probes one situation from a clean
 * conversation slate, the way a real user's separate conversations would start.
 * Without this reset, later scenarios would see earlier scenarios' raw events
 * inside the Context Compiler budget and cross-contaminate the evidence.
 */
const SCENARIO_RESET_TABLES = `
  TRUNCATE TABLE
    conversation_action_payloads,
    conversation_action_receipts,
    conversation_action_executions,
    conversation_action_handles,
    current_curiosity_stop_signals,
    curiosity_stop_signals,
    current_safety_postures,
    safety_postures,
    safety_posture_alerts,
    current_rolling_summaries,
    rolling_summary_versions,
    rolling_summary_command_source_refs,
    rolling_summary_commands,
    journal_statement_evidence_links,
    journal_diagnostic_findings,
    journal_statements,
    journal_validation_results,
    journal_versions,
    journals,
    journal_model_run_attempts,
    journal_generation_commands,
    journal_workflow_outcomes,
    dialogue_state_command_source_refs,
    dialogue_state_versions,
    current_dialogue_states,
    dialogue_state_commands,
    evidence_lineage,
    evidence_model_run_attempts,
    evidence_items,
    evidence_source_snapshots,
    daily_session_date_outcomes,
    outbox_events,
    workflow_commands,
    sensitive_access_audits,
    internal_diagnostic_access_grants,
    provider_egress_consents,
    provider_egress_dispositions,
    compiled_context_revision_refs,
    compiled_contexts,
    model_run_attempts,
    generation_commands,
    continuous_exchange_inactivity_evaluations,
    conversation_event_revisions,
    conversation_events,
    interaction_turns,
    daily_sessions
`;

async function main(): Promise<void> {
  loadDotEnv();
  const { force, outDir, scenariosFile } = parseArguments();
  const manifestPath = path.join(outDir, "manifest.json");
  const transcriptsPath = path.join(outDir, "transcripts.json");
  if (!force && (existsSync(manifestPath) || existsSync(transcriptsPath))) {
    throw new Error(
      `${outDir} already contains a baseline run; pass --force to overwrite a non-authoritative artifact.`,
    );
  }

  const scenarioFileText = await readFile(scenariosFile, "utf8");
  const scenarios = (JSON.parse(scenarioFileText) as ScenarioFile).scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error("Scenario file must contain a non-empty scenarios array.");
  }
  const scenarioFileSha256 = createHash("sha256").update(scenarioFileText).digest("hex");

  const databaseUrl = requiredEnvironment("DATABASE_URL");
  const { champion, providerTransport } = buildChampion(process.env);
  const domainClockStartIso =
    process.env.SAYHEAR_CAPTURE_CLOCK_START_ISO ?? DOMAIN_CLOCK_START_ISO;
  const parsedDomainClockStart = new Date(domainClockStartIso);
  if (!Number.isFinite(parsedDomainClockStart.getTime())) {
    throw new Error("SAYHEAR_CAPTURE_CLOCK_START_ISO must be a valid ISO date.");
  }

  // The single source of the frozen version cluster: the service assembly and
  // the recorded manifest both read these constants, so the manifest cannot
  // drift from what actually ran.
  const contextCompilerSettings = {
    compilerVersion: TIME_AWARE_CONTEXT_COMPILER_VERSION,
    rawEventTokenBudget: 4_000,
  } as const;
  const generationPolicy: GenerationPolicy = {
    consentPolicyVersion: champion.consentPolicyVersion,
    freshnessPolicy: "source_valid:v1" as const,
    chineseLocalePackVersion: CHINESE_LOCALE_PACK_VERSION,
    englishLocalePackVersion: ENGLISH_LOCALE_PACK_VERSION,
    harnessPolicyVersion: CATALOG_V2_CONVERSATION_HARNESS_POLICY.version,
    conversationActionCatalogVersion:
      JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
    model: champion.model,
    modelConfigVersion: champion.configVersion,
    modelSnapshot: champion.snapshot,
    outputFormatVersion: "conversation-output:v1",
    canonicalPersonaVersion: CANONICAL_PERSONA_VERSION,
    personaBehaviorAnchorsVersion: PERSONA_BEHAVIOR_ANCHORS_VERSION,
    personaContractInvariantVersion: PERSONA_CONTRACT_INVARIANT_VERSION,
    productPolicyVersion: "product-policy:v1",
    taskInstructionVersion: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
    provider: champion.provider,
    providerPolicyVersion: champion.providerPolicyVersion,
    relationshipPolicyVersion: "relationship-boundary:v1",
    safetyPolicyVersion: "minimum-high-risk-response:v1",
  } as const;
  const inactivityPolicy = {
    timeoutMs: 30 * 60 * 1_000,
    version: "continuous-exchange-inactivity:v1",
  } as const;

  let domainNow = new Date(parsedDomainClockStart);
  const clock = () => domainNow;

  const runStartedAt = new Date();
  const database = await createIsolatedPostgresSchema(databaseUrl);
  console.log("[baseline] isolated schema created");
  const capturedScenarios: CapturedScenario[] = [];

  try {
    await runMigrations(database.pool);
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).provisionInternalOwner({
      issuer: "https://github.com",
      subject: "baseline-synthetic-owner",
      userId: fixedInternalOwnerPrincipal.userId,
    });
    await database.pool.query(
      "UPDATE app_users SET status = 'active', data_epoch = 1",
    );
    await database.pool.query(
      "UPDATE provider_egress_policy_versions SET status = 'active'",
    );
    await new PostgresInternalOwnerAccessRepository(
      database.pool,
    ).recordBackupPolicyEvidence({
      backupPolicyId: "01984477-31e1-7595-92c6-06889cb0fdde",
      configurationFingerprint: SYNTHETIC_BACKUP_FINGERPRINT,
      databaseRetentionDays: 30,
      evidenceReference: "synthetic baseline capture (issue #61)",
      policyVersion: SYNTHETIC_BACKUP_POLICY_VERSION,
      pitrRetentionDays: 7,
      snapshotRetentionDays: 30,
      status: "verified",
      validUntil: new Date("2026-09-21T00:00:00.000Z"),
      verifiedAt: new Date("2026-08-20T00:00:00.000Z"),
    });

    const responseRepository = new PostgresConversationResponseRepository(
      database.pool,
    );
    const actionRepository = new PostgresJournalRegenerationActionRepository(
      database.pool,
      SYNTHETIC_CONTEXT_HMAC_SECRET,
    );
    const contextCompiler = createContextCompiler({
      clock,
      compilerVersion: contextCompilerSettings.compilerVersion,
      contentHmacSecret: SYNTHETIC_CONTEXT_HMAC_SECRET,
      rawEventTokenBudget: contextCompilerSettings.rawEventTokenBudget,
      repository: responseRepository,
    });
    const conversationService = createUserTextConversationService({
      clock,
      expectedBackupPolicyVersion: SYNTHETIC_BACKUP_POLICY_VERSION,
      expectedConfigurationFingerprint: SYNTHETIC_BACKUP_FINGERPRINT,
      generationPolicy,
      inactivityPolicy,
      repository: new PostgresUserTextConversationRepository(database.pool),
    });
    const egressPort = createRuntimeProviderEgressPort({
      adapter: providerTransport,
      champion,
      clock,
      contextCompiler,
      repository: responseRepository,
    });
    const actionGateway = createConversationActionGateway({
      handlers: [
        createJournalRegenerationActionHandler({
          generationPolicyVersion: "journal-generation:v2",
        }),
      ],
      repository: actionRepository,
    });
    const harness = createConversationAgentHarness({
      actionGateway,
      clock,
      contextCompiler,
      egressPort,
      repository: responseRepository,
    });
    const service = createConversationResponseService({
      actionGateway,
      catalog: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG,
      clock,
      contextCompiler,
      conversationService,
      harness,
      harnessPolicy: CATALOG_V2_CONVERSATION_HARNESS_POLICY,
      repository: responseRepository,
    });
    const handler = createConversationResponseHandler({
      authenticate: async () => fixedInternalOwnerPrincipal,
      service,
    });

    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      if (scenarioIndex > 0) {
        await database.pool.query(SCENARIO_RESET_TABLES);
      }
      // Every scenario starts from the same frozen domain clock so re-runs are
      // comparable; within-scenario gaps (including cross-day probes) are
      // applied between turns below.
      domainNow = new Date(parsedDomainClockStart);
      const scenarioClockStart = domainNow.toISOString();
      console.log(
        `[baseline] scenario ${scenario.id} (${scenario.turns.length} turns)`,
      );
      const turns: CapturedTurn[] = [];
      for (const [turnIndex, turn] of scenario.turns.entries()) {
        if (turnIndex > 0) {
          domainNow = new Date(
            domainNow.getTime() + (turn.gapMs ?? DEFAULT_TURN_GAP_MS),
          );
        }
        const wallStartedAt = performance.now();
        const response = await handler(
          new Request("http://localhost/api/internal/conversation/responses", {
            body: JSON.stringify({
              clientEventId: `${scenario.id}-t${turnIndex + 1}-event`,
              clientTurnId: `${scenario.id}-t${turnIndex + 1}-turn`,
              locale: scenario.locale,
              text: turn.text,
              timezone: scenario.timezone,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }),
        );
        const events = await readNdjson(response);
        const wallMs = Math.round(performance.now() - wallStartedAt);
        const assistantText = joinDeltas(events);
        const generationCommandId = events.find(
          (event) => typeof event.generationCommandId === "string",
        )?.generationCommandId;
        const usage =
          typeof generationCommandId === "string"
            ? await database.pool.query<{
                attempt_count: string;
                cost_micros: string | null;
                input_tokens: string | null;
                output_tokens: string | null;
              }>(
                `
                  SELECT
                    COUNT(*)::text AS attempt_count,
                    SUM(input_tokens)::text AS input_tokens,
                    SUM(output_tokens)::text AS output_tokens,
                    SUM(cost_micros)::text AS cost_micros
                  FROM model_run_attempts
                  WHERE generation_command_id = $1
                `,
                [generationCommandId],
              )
            : null;
        const usageRow = usage?.rows[0];
        const providerUsage = usageRow
          ? {
              attemptCount: Number(usageRow.attempt_count),
              costMicros:
                usageRow.cost_micros === null
                  ? null
                  : Number(usageRow.cost_micros),
              inputTokens:
                usageRow.input_tokens === null
                  ? null
                  : Number(usageRow.input_tokens),
              outputTokens:
                usageRow.output_tokens === null
                  ? null
                  : Number(usageRow.output_tokens),
            }
          : null;
        const receiptEvent = events.find((event) => event.type === "action_admitted");
        const receipt =
          receiptEvent && isRecord(receiptEvent.receipt)
            ? summarizeReceipt(receiptEvent.receipt)
            : null;
        turns.push({
          assistantText,
          checks: {
            followUpQuestionCount: countFollowUpQuestions(assistantText),
            minimumHighRiskViolations:
              scenario.category === "high_risk" && assistantText.length > 0
                ? [...validateMinimumHighRiskResponse(assistantText).violations]
                : null,
            understandingViolations:
              assistantText.length > 0
                ? [...validateUnderstandingResponse(assistantText).violations]
                : [],
          },
          domainClockIso: domainNow.toISOString(),
          finalEventType: String(events.at(-1)?.type ?? "none"),
          input: {
            locale: scenario.locale,
            text: turn.text,
            timezone: scenario.timezone,
          },
          providerUsage,
          receipt,
          sequenceInScenario: turnIndex + 1,
          wallMs,
        });
        console.log(
          `  turn ${turnIndex + 1}: ${String(events.at(-1)?.type ?? "none")} in ${wallMs}ms (${assistantText.length} chars)`,
        );
      }
      capturedScenarios.push({
        category: scenario.category,
        description: scenario.description,
        domainClockStartIso: scenarioClockStart,
        id: scenario.id,
        languageVariant: scenario.languageVariant,
        turns,
      });
    }
  } finally {
    await database.dispose();
    console.log("[baseline] isolated schema dropped; no product state written.");
  }

  const manifest = {
    artifactClass: "non_authoritative_eval_output",
    capturedAt: runStartedAt.toISOString(),
    completedAt: new Date().toISOString(),
    dataSourceDeclaration:
      "Fully synthetic scenario material (see scenarios.json); no real private conversation is read (ADR-0020 Initial Replay, ADR-0073).",
    databaseIsolation:
      "disposable isolated PostgreSQL schema on the DATABASE_URL server; dropped after the run",
    scenarioIsolation:
      "conversation state is reset between scenarios so each situation is probed from a clean slate; within-scenario multi-turn and cross-day continuity is preserved",
    gitCommit: gitCommit(),
    limitations: [
      "Model outputs are sampled, not bit-reproducible; the adapter sends no temperature override, so the Provider default applies. Reproduction means the same frozen inputs and versions, not identical text.",
      "Journal, Evidence, DialogueState, and RollingSummary projections never run in this harness: no outbox dispatcher is started, so multi-turn context relies only on in-budget committed raw events (the documented lagging behavior before those projections catch up).",
      "No deterministic pre-model high-risk guard is exercised by this synthetic harness; high-risk scenarios measure prompt-level behavior only.",
      "The Action Gateway runs against a fresh isolated schema, so regenerate_journal proposals cannot find an existing Journal; admission dispositions reflect that empty state.",
      "The BFF handler is invoked in-process with a fixed synthetic principal; the HTTP edge and Auth.js session validation are not exercised.",
      "A run always precedes the commit that contains it: gitCommit records the harness code state the run executed from, and the committed artifact gains its own provenance entry only afterwards.",
    ],
    scenarioFile: {
      path: path.relative(repositoryRoot, scenariosFile),
      scenarioCount: scenarios.length,
      sha256: scenarioFileSha256,
    },
    seam: `apps/web conversation-response-handler (BFF NDJSON) -> ConversationResponseService -> Conversation Agent Harness + Action Gateway + Context Compiler -> runtime Provider Egress Port -> ${providerTransport.type} adapter`,
    systemVersions: {
      champion,
      conversationActionCatalog: {
        actionKinds: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.definitions.map(
          (definition) => definition.actionKind,
        ),
        version: JOURNAL_REGENERATION_CONVERSATION_ACTION_CATALOG.version,
      },
      contextCompiler: contextCompilerSettings,
      generationPolicy,
      harnessPolicy: CATALOG_V2_CONVERSATION_HARNESS_POLICY,
      inactivityPolicy,
      providerTransport:
        providerTransport.type === "opencode-go"
          ? {
              endpoint: "https://opencode.ai/zen/go/v1/chat/completions",
              timeoutMs: providerTransport.timeoutMs,
              type: "opencode-go",
            }
          : {
              baseUrl: providerTransport.baseUrl,
              timeoutMs: providerTransport.timeoutMs,
              type: "responses-api",
            },
    },
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(
    transcriptsPath,
    `${JSON.stringify({ capturedAt: runStartedAt.toISOString(), scenarios: capturedScenarios }, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `[baseline] wrote ${path.relative(repositoryRoot, manifestPath)} and ${path.relative(repositoryRoot, transcriptsPath)}`,
  );
}

main().catch((error: unknown) => {
  console.error("[baseline] capture failed:", error);
  process.exitCode = 1;
});
