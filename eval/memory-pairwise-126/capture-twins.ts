/**
 * Memory-on / Memory-off twin capture CLI (issue #126).
 *
 *   pnpm exec tsx eval/memory-pairwise-126/capture-twins.ts \
 *     --arm on --out eval/memory-pairwise-126/run-twins-on \
 *     --scenarios eval/scenario-pack-v3/scenarios.json [--force]
 *
 * Runs the frozen scenario pack through the real production seam with the real
 * champion (responses-api) in the requested arm and records the transcripts,
 * per-turn injection evidence, and the cutover pin manifest as a
 * non-authoritative eval artifact. The Memory-off arm is explicit
 * non-authoritative Replay over the same frozen input (ADR-0071 / ADR-0073) —
 * never production shadowing.
 *
 * Required environment (read from the repo root .env): DATABASE_URL,
 * SAYHEAR_PROVIDER_ADAPTER=deepseek|openai with the matching *_API_KEY, and
 * optionally SAYHEAR_DEEPSEEK_BASE_URL / SAYHEAR_CONVERSATION_TEXT_MODEL /
 * SAYHEAR_PROVIDER_TIMEOUT_MS.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConversationTextChampion } from "@sayhear/application";
import { createRuntimeJournalRoleProviderRegistry } from "@sayhear/ai";
import { runMigrations } from "@sayhear/data";
import { createIsolatedPostgresSchema } from "@sayhear/test-support";

import {
  runTwinCapture,
  type TwinConversationAdapter,
  type TwinRoleRegistry,
  type TwinScenario,
  type TwinScenarioTurn,
} from "./twin-harness";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

type ScenarioFile = Readonly<{ scenarios: readonly TwinScenario[] }>;

function parseArguments(): {
  arm: "on" | "off";
  force: boolean;
  outDir: string;
  scenariosFile: string;
} {
  const arguments_ = process.argv.slice(2);
  let arm: "on" | "off" | null = null;
  let force = false;
  let outDir = "";
  let scenariosFile = path.join(
    repositoryRoot,
    "eval/scenario-pack-v3/scenarios.json",
  );
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === "--arm") {
      const value = arguments_[++index];
      if (value !== "on" && value !== "off") {
        throw new Error("--arm must be on or off.");
      }
      arm = value;
    } else if (argument === "--force") {
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
  if (!arm) throw new Error("--arm on|off is required.");
  if (!outDir) {
    outDir = path.join(
      repositoryRoot,
      `eval/memory-pairwise-126/run-twins-${arm}`,
    );
  }
  return { arm, force, outDir, scenariosFile };
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
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
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

function buildChampion(environment: NodeJS.ProcessEnv): {
  champion: ConversationTextChampion;
  conversationAdapter: TwinConversationAdapter;
} {
  const adapter =
    environment.SAYHEAR_PROVIDER_ADAPTER === "openai" ? "openai" : "deepseek";
  const profile =
    adapter === "deepseek"
      ? {
          apiKey: requiredEnvironment("DEEPSEEK_API_KEY"),
          baseUrl:
            environment.SAYHEAR_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
          defaultModel: "deepseek-v4-flash",
          provider: "deepseek" as const,
          providerPolicyVersion: "deepseek-conversation-text:v1",
        }
      : {
          apiKey: requiredEnvironment("OPENAI_API_KEY"),
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-5.4",
          provider: "openai" as const,
          providerPolicyVersion: "openai-conversation-text:v1",
        };
  const model =
    environment.SAYHEAR_CONVERSATION_TEXT_MODEL ?? profile.defaultModel;
  const champion: ConversationTextChampion = Object.freeze({
    configVersion: "conversation-text-champion:v1",
    consentPolicyVersion: null,
    contextLimit: 1_000_000,
    dataRegion: "provider-configured",
    model,
    provider: profile.provider,
    providerPolicyVersion: profile.providerPolicyVersion,
    retentionMode: "store-disabled",
    snapshot:
      environment.SAYHEAR_CONVERSATION_TEXT_MODEL_SNAPSHOT ?? model,
    streaming: true,
    supportedLocales: Object.freeze(["en", "zh"]),
    trainingPolicy: "api-data-controls",
  });
  return {
    champion,
    conversationAdapter: {
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      timeoutMs: Number(environment.SAYHEAR_PROVIDER_TIMEOUT_MS ?? "60000"),
      type: "responses-api",
    },
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  const { arm, force, outDir, scenariosFile } = parseArguments();
  const manifestPath = path.join(outDir, "manifest.json");
  const transcriptsPath = path.join(outDir, "transcripts.json");
  if (!force && (existsSync(manifestPath) || existsSync(transcriptsPath))) {
    throw new Error(
      `${outDir} already contains a twin run; pass --force to overwrite a non-authoritative artifact.`,
    );
  }
  await mkdir(outDir, { recursive: true });

  const scenarioFileText = await readFile(scenariosFile, "utf8");
  const parsed = JSON.parse(scenarioFileText) as ScenarioFile;
  const scenarios = parsed.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error("Scenario file must contain a non-empty scenarios array.");
  }
  for (const scenario of scenarios) {
    if (!Array.isArray(scenario.turns) || scenario.turns.length === 0) {
      throw new Error(`Scenario ${scenario.id} has no turns.`);
    }
  }
  const scenarioFileSha256 = createHash("sha256")
    .update(scenarioFileText)
    .digest("hex");

  const databaseUrl = requiredEnvironment("DATABASE_URL");
  const { champion, conversationAdapter } = buildChampion(process.env);

  // The same role cluster the production composition resolves: the
  // conversation champion carries the memory roles with their own
  // independently versioned configs (issue #113 / #114).
  const roleRegistry = createRuntimeJournalRoleProviderRegistry({
    adapter: {
      apiKey: conversationAdapter.type === "responses-api"
        ? conversationAdapter.apiKey
        : "",
      baseUrl: conversationAdapter.type === "responses-api"
        ? conversationAdapter.baseUrl
        : "",
      timeoutMs: conversationAdapter.type === "responses-api"
        ? conversationAdapter.timeoutMs
        : 60_000,
      type: "responses-api",
    },
    roles: [
      {
        role: "memory.extract",
        provider: champion.provider,
        model: champion.model,
        configVersion: `${champion.configVersion}:memory-extract`,
        policyVersion: "memory-extraction:v1",
        promptFingerprint: "memory-extract:propose:v1",
      },
      {
        role: "entity.resolve",
        provider: champion.provider,
        model: champion.model,
        configVersion: `${champion.configVersion}:entity-resolve`,
        policyVersion: "entity-resolve-gate:v1",
        promptFingerprint: "entity-resolve:gate:v1",
      },
      {
        role: "memory.consolidate",
        provider: champion.provider,
        model: champion.model,
        configVersion: `${champion.configVersion}:memory-consolidate`,
        policyVersion: "memory-consolidation:v1",
        promptFingerprint: "memory-consolidate:diffs:v1",
      },
      // The registry validates the full role set even though the twin harness
      // only consumes the three memory roles.
      {
        role: "evidence.extract",
        provider: champion.provider,
        model: champion.model,
        configVersion: `${champion.configVersion}:evidence`,
        policyVersion: "evidence-extraction:v2",
        promptFingerprint: "evidence-extract:spans:v2",
      },
      {
        role: "journal.draft",
        provider: champion.provider,
        model: champion.model,
        configVersion: `${champion.configVersion}:journal-draft`,
        policyVersion: "journal-generation:v2",
        promptFingerprint: "journal-draft:evidence-only:v2",
      },
      {
        role: "journal.validate",
        provider: champion.provider,
        model: champion.model,
        configVersion: `${champion.configVersion}:journal-validate`,
        policyVersion: "journal-validator:v3",
        promptFingerprint: "journal-validate:diagnostic:v3",
      },
      {
        role: "dialogue.state",
        provider: champion.provider,
        model: champion.model,
        configVersion: "dialogue-state-model:v1",
        policyVersion: "dialogue-state:v2",
        promptFingerprint: "dialogue-state-prompt:v2",
      },
      {
        role: "summary.compress",
        provider: champion.provider,
        model: champion.model,
        configVersion: `${champion.configVersion}:summary`,
        policyVersion: "rolling-summary:v1",
        promptFingerprint: "rolling-summary:neutral-structured:v1",
      },
    ],
  }) as unknown as TwinRoleRegistry;

  const database = await createIsolatedPostgresSchema(databaseUrl);
  console.log(`[twin-${arm}] isolated schema created`);
  try {
    await runMigrations(database.pool);
    const { manifest, transcripts } = await runTwinCapture({
      arm,
      champion,
      conversationAdapter,
      log: (line) => console.log(line),
      pool: database.pool,
      roleRegistry,
      scenarioFile: {
        path: path.relative(repositoryRoot, scenariosFile),
        scenarioCount: scenarios.length,
        sha256: scenarioFileSha256,
      },
      scenarios: scenarios.map((scenario) => ({
        ...scenario,
        turns: scenario.turns as readonly TwinScenarioTurn[],
      })),
    });
    await writeFile(
      transcriptsPath,
      `${JSON.stringify(transcripts, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, gitCommit: gitCommit() }, null, 2)}\n`,
      "utf8",
    );
    const injectedTurns = transcripts.scenarios.flatMap((scenario) =>
      scenario.turns.filter((turn) => turn.injectedMemories.length > 0),
    ).length;
    console.log(
      `[twin-${arm}] wrote ${path.relative(process.cwd(), transcriptsPath)} ` +
        `(${transcripts.scenarios.length} scenarios, ${injectedTurns} turns with injected memory)`,
    );
  } finally {
    await database.dispose();
    console.log(`[twin-${arm}] isolated schema dropped; no product state written.`);
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(`[twin] capture failed:`, error);
    process.exitCode = 1;
  });
}
