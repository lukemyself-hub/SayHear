/**
 * Memory-on / Memory-off twin capture CLI (issue #126).
 *
 *   pnpm exec tsx eval/memory-pairwise-126/capture-twins.ts \
 *     --arm on --out eval/memory-pairwise-126/run-twins-on \
 *     --scenarios eval/scenario-pack-v3/scenarios.json [--force] \
 *     [--only scenario-a,scenario-b]
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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runMigrations } from "@sayhear/data";
import { createIsolatedPostgresSchema } from "@sayhear/test-support";

import {
  REPOSITORY_ROOT,
  buildChampionAssembly,
  buildMemoryRoleRegistry,
  gitCommit,
  loadDotEnv,
  requiredEnvironment,
} from "./shared";
import {
  runTwinCapture,
  type TwinScenario,
  type TwinScenarioTurn,
} from "./twin-harness";

type ScenarioFile = Readonly<{ scenarios: readonly TwinScenario[] }>;

function parseArguments(): {
  arm: "on" | "off";
  force: boolean;
  only: readonly string[] | null;
  outDir: string;
  scenariosFile: string;
} {
  const arguments_ = process.argv.slice(2);
  let arm: "on" | "off" | null = null;
  let force = false;
  let only: readonly string[] | null = null;
  let outDir = "";
  let scenariosFile = path.join(
    REPOSITORY_ROOT,
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
    } else if (argument === "--only") {
      const value = requiredArgument(arguments_, ++index, "--only");
      const ids = value
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      if (ids.length === 0) {
        throw new Error("--only requires at least one scenario id.");
      }
      only = ids;
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
      REPOSITORY_ROOT,
      `eval/memory-pairwise-126/run-twins-${arm}`,
    );
  }
  return { arm, force, only, outDir, scenariosFile };
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

async function main(): Promise<void> {
  loadDotEnv();
  const { arm, force, only, outDir, scenariosFile } = parseArguments();
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
  const onlySet = only ? new Set(only) : null;
  if (onlySet) {
    const knownIds = new Set(scenarios.map((scenario) => scenario.id));
    const unknown = only.filter((id) => !knownIds.has(id));
    if (unknown.length > 0) {
      throw new Error(`--only references unknown scenario ids: ${unknown.join(", ")}`);
    }
  }
  const selected = onlySet
    ? scenarios.filter((scenario) => onlySet.has(scenario.id))
    : scenarios;
  const scenarioFileSha256 = createHash("sha256")
    .update(scenarioFileText)
    .digest("hex");

  const databaseUrl = requiredEnvironment("DATABASE_URL");
  const { champion, conversationAdapter } = buildChampionAssembly(process.env);
  const roleRegistry = buildMemoryRoleRegistry(conversationAdapter, {
    championConfigVersion: champion.configVersion,
    model: champion.model,
    provider: champion.provider,
  });

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
        path: path.relative(REPOSITORY_ROOT, scenariosFile),
        scenarioCount: selected.length,
        ...(only ? { onlyFilter: only } : {}),
        sha256: scenarioFileSha256,
      },
      scenarios: selected.map((scenario) => ({
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
    const injectedTurns = transcripts.scenarios
      .flatMap((scenario) =>
        scenario.turns.filter((turn) => turn.injectedMemories.length > 0),
      )
      .length;
    console.log(
      `[twin-${arm}] wrote ${path.relative(process.cwd(), transcriptsPath)} ` +
        `(${transcripts.scenarios.length} scenarios, ${injectedTurns} turns with injected memory)`,
    );
  } finally {
    await database.dispose();
    console.log(
      `[twin-${arm}] isolated schema dropped; no product state written.`,
    );
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
