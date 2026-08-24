/**
 * PROTOTYPE — throwaway comparison artifact for issue #94.
 *
 * Question: which recall-presentation policy makes injected memories feel
 * accurate, natural, and restrained rather than surveillance-like — compared
 * blind on the same conversations?
 *
 * Runs the 3 memory_continuity scenarios of eval/scenario-pack-v2
 * (scenario-pack:v2.1 memory fixtures) through 4 recall-presentation arms
 * against the frozen conversation-text champion via direct model calls:
 *   portrait_only      Person Portrait (itemized, epistemic kinds) + reactive weaving
 *   portrait_retrieved portrait + query-retrieved open thread + reactive weaving
 *   proactive          portrait + retrieved + proactive continuity license
 *   no_memory          control — persona v2 alone, no memory section
 * Persona/locale/task layers are the frozen #79 v2 artifacts resolved through
 * the real resolvePromptArtifacts; only the memory injection and its
 * instructions vary between arms. No database, no product state, nothing
 * persisted outside this directory. Outputs run/comparison.json.
 *
 * Run: pnpm exec tsx eval/recall-presentation-94/generate.ts
 * Then: pnpm exec tsx eval/recall-presentation-94/build-review-page.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createResponsesApiConversationTextModel,
} from "../../packages/ai/src/responses-api-conversation-text-model";
import {
  CANONICAL_PERSONA_VERSION,
  CHINESE_LOCALE_PACK_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  ENGLISH_LOCALE_PACK_VERSION,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  resolvePromptArtifacts,
} from "../../packages/application/src/prompt-artifacts";
import {
  type ArmKey,
  BLIND_SEED,
  DIMENSIONS,
  letterAssignmentForScenario,
  mechanicalFlags,
  PROTOCOL_VERSION,
} from "./protocol";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const scenarioPackPath = path.join(repositoryRoot, "eval/scenario-pack-v2/scenarios.json");
const outDir = path.join(import.meta.dirname, "run");

/* ---------------------------------------------------------------------------
 * Environment (mirrors the #62 prototype generator)
 * ------------------------------------------------------------------------- */

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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
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

/* ---------------------------------------------------------------------------
 * Arms — only the memory injection and its instructions vary
 * ------------------------------------------------------------------------- */

type Arm = Readonly<{
  key: ArmKey;
  name: string;
  oneLiner: string;
  /** Which memory material the arm receives on day-2 turns. */
  receives: Readonly<{ portrait: boolean; retrieved: boolean; proactiveRules: boolean }>;
}>;

const ARMS: readonly Arm[] = [
  {
    key: "portrait_only",
    name: "Portrait-only 注入",
    oneLiner:
      "只注入 Person Portrait(逐条、带认识状态与证据;ADR-0111 形态),回应规则为纯被动织入:用户当前话语关联到才用,不主动提起。",
    receives: { portrait: true, retrieved: false, proactiveRules: false },
  },
  {
    key: "portrait_retrieved",
    name: "Portrait + 检索注入",
    oneLiner:
      "Portrait 之上,day-2 每轮按查询匹配注入一条 open-thread 检索记忆(模拟 turn-level 检索命中);回应规则仍为被动织入。",
    receives: { portrait: true, retrieved: true, proactiveRules: false },
  },
  {
    key: "proactive",
    name: "主动 recall 变体",
    oneLiner:
      "与 portrait+检索相同的上下文,但回应规则允许一次温和的主动承接:跨 gap 的开场/疲惫时刻可以接起一条记住的挂念,被回避即停;t4 以等待的分量承接好消息。",
    receives: { portrait: true, retrieved: true, proactiveRules: true },
  },
  {
    key: "no_memory",
    name: "无记忆对照",
    oneLiner:
      "完全不带记忆段:persona v2 独立工作,只依赖当轮对话历史;连续性下界的对照锚点。",
    receives: { portrait: false, retrieved: false, proactiveRules: false },
  },
];

/**
 * Authored per-locale memory material, derived from each scenario's
 * memoryFixture.injectedMemories (synthetic; the README records the split).
 * Portrait items are self-contained person-describing claims — objective
 * (user-stated) plus AI Impression (inferred) — exercising both ADR-0009
 * recall languages. The retrieved item is the fixture's open loop with
 * explicit open-thread framing.
 */
const MEMORY_MATERIAL: Readonly<
  Record<string, Readonly<{ portraitObjective: string; portraitImpression: string; retrievedOpenLoop: string }>>
> = {
  "memory-continuity-en": {
    portraitObjective:
      "They said that talking through a worry that evening helped them feel steadier, and that they were trying not to spiral.",
    portraitImpression:
      "My impression: they carry waiting-anxiety quietly, and putting it into words steadies them.",
    retrievedOpenLoop:
      "Open thread: biopsy results were due at a follow-up appointment the day after our last exchange; they had waited two weeks. The outcome is not yet known.",
  },
  "memory-continuity-zh": {
    portraitObjective: "他们说过,把心里挂着的事说出来会踏实一些,也在尽量不让自己瞎想。",
    portraitImpression: "我的印象:等待里的不安他们压得比较深,说出来会稳一些。",
    retrievedOpenLoop:
      "未闭合的线索:上次交流的次日要复诊出活检结果,已等了两周;结果如何尚不知道。",
  },
  "memory-continuity-mix": {
    portraitObjective: "他们说过,把心里挂着的事说出来会踏实一点,也在尽量不 spiral。",
    portraitImpression: "我的印象:等待里的不安他们压得比较深,说出来会稳一些。",
    retrievedOpenLoop:
      "Open thread:上次交流的次日 follow-up 要出 biopsy 结果,已等两周;结果如何尚不知道。",
  },
};

const RECALL_RULES_SHARED = `How to use what you know of them:
- No memory ceremony: never announce remembering, never show off what you know, never list facts back.
- Attribution: what they told you may be recalled as something they told you. Anything that is your own understanding must stay observational and tentative ("my impression is…", "I may be reading this wrong…") — never delivered as a fact about them.
- Never check progress as if supervising, never imply you thought about them while they were away, never create pressure to report back. If they brush a remembered thread off, drop it.
- Use only what the memory sections above actually contain; never guess specifics that were never stated — no names, places, institutions, body parts, or other people that your context does not contain.`;

const REACTIVE_LINE =
  "- Weave memory in only where it naturally serves what they express now; never raise remembered matters on your own initiative.";

const PROACTIVE_LINES = `- Weave memory in where it naturally serves what they express now. Additionally: when they return after a gap and open with a greeting, a tired line, or an empty moment, you may — once, gently — pick up the one open thread in your context, as care rather than checking. If they brush it off, stop; do not raise it again until they do.
- When they bring news that resolves a remembered thread, receive it with the weight of what you remember of the wait — shared relief, not re-litigating the wait.`;

function memorySection(input: {
  arm: Arm;
  material: Readonly<{ portraitObjective: string; portraitImpression: string; retrievedOpenLoop: string }>;
  day2: boolean;
}): string {
  const { arm, material, day2 } = input;
  if (!arm.receives.portrait && !arm.receives.retrieved) return "";
  const sections: string[] = [];
  if (arm.receives.portrait) {
    sections.push(
      [
        "Person Portrait — what your context carries about this person (each item separate, with its epistemic kind):",
        `- [Objective Memory — what they told you directly; day-1 conversation] ${material.portraitObjective}`,
        `- [AI Impression — your own understanding, not something they stated; day-1 conversation] ${material.portraitImpression}`,
      ].join("\n"),
    );
  }
  if (arm.receives.retrieved && day2) {
    sections.push(
      [
        "Memory retrieved for this turn (query-matched from past conversations):",
        `- [Objective Memory — what they told you directly; day-1 conversation] ${material.retrievedOpenLoop}`,
      ].join("\n"),
    );
  }
  const rules = arm.receives.proactiveRules
    ? [PROACTIVE_LINES, ...RECALL_RULES_SHARED.split("\n").slice(1)].join("\n")
    : [REACTIVE_LINE, ...RECALL_RULES_SHARED.split("\n").slice(1)].join("\n");
  sections.push(rules);
  return sections.join("\n\n");
}

/* ---------------------------------------------------------------------------
 * Session context (identical across arms; gives today/yesterday anchors)
 * ------------------------------------------------------------------------- */

function sessionLine(turnIndex: number, gapBeforeTurn: boolean): string {
  if (!gapBeforeTurn) {
    return turnIndex === 0
      ? "Session context: a new conversation, evening (day one)."
      : "Session context: still the same evening, day one of this conversation.";
  }
  return turnIndex === 2
    ? "Session context: a new day and a new session — the previous exchange in this conversation was yesterday evening, about 26 hours ago. It is now evening of the following day."
    : "Session context: later the same evening, day two of this conversation.";
}

const OUTPUT_FORMAT =
  "Return only the natural-language companion response, without metadata or formatting wrappers.";

/* ---------------------------------------------------------------------------
 * Model plumbing (mirrors the #62 prototype generator)
 * ------------------------------------------------------------------------- */

type Transport = Readonly<{ apiKey: string; baseUrl: string; model: string; timeoutMs: number }>;

function buildTransport(): Transport {
  const adapter = process.env.SAYHEAR_PROVIDER_ADAPTER === "openai" ? "openai" : "deepseek";
  if (adapter === "openai") {
    return {
      apiKey: requiredEnvironment("OPENAI_API_KEY"),
      baseUrl: "https://api.openai.com/v1",
      model: process.env.SAYHEAR_CONVERSATION_TEXT_MODEL ?? "gpt-5.4",
      timeoutMs: Number(process.env.SAYHEAR_PROVIDER_TIMEOUT_MS ?? "60000"),
    };
  }
  return {
    apiKey: requiredEnvironment("DEEPSEEK_API_KEY"),
    baseUrl: process.env.SAYHEAR_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model: process.env.SAYHEAR_CONVERSATION_TEXT_MODEL ?? "deepseek-v4-flash",
    timeoutMs: Number(process.env.SAYHEAR_PROVIDER_TIMEOUT_MS ?? "60000"),
  };
}

type ChatMessage = Readonly<{ revisionId: string; role: "user" | "assistant"; text: string }>;

async function generate(
  model: ReturnType<typeof createResponsesApiConversationTextModel>,
  transport: Transport,
  input: { instructions: string; locale: string; messages: readonly ChatMessage[] },
): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let text = "";
      for await (const event of model.stream({
        instructions: input.instructions,
        locale: input.locale,
        messages: input.messages,
        model: transport.model,
      })) {
        if (event.type === "delta") text += event.delta;
      }
      if (text.trim().length === 0) throw new Error("empty completion");
      return text.trim();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("generation failed");
}

/* ---------------------------------------------------------------------------
 * Run loop
 * ------------------------------------------------------------------------- */

type PackScenario = Readonly<{
  id: string;
  category: string;
  languageVariant: string;
  locale: string;
  description: string;
  turns: readonly Readonly<{ text: string; gapMs?: number }>[];
  memoryFixture: Readonly<{
    injectedMemories: readonly Readonly<{ kind: string; text: string; evidence: string }>[];
    expectedRecall: string;
    forbiddenMentions: readonly string[];
    forbiddenMentionTokens: readonly string[];
    timeGrounding: string;
  }>;
}>;

async function main() {
  await mkdir(outDir, { recursive: true });
  loadDotEnv();
  const transport = buildTransport();
  const model = createResponsesApiConversationTextModel({
    apiKey: transport.apiKey,
    baseUrl: transport.baseUrl,
    timeoutMs: transport.timeoutMs,
  });

  const packRaw = await readFile(scenarioPackPath, "utf8");
  const pack = JSON.parse(packRaw) as { scenarios: PackScenario[] };
  const scenarios = pack.scenarios.filter((scenario) => scenario.category === "memory_continuity");
  if (scenarios.length !== 3) {
    throw new Error(`expected 3 memory_continuity scenarios, found ${scenarios.length}`);
  }

  const scenariosOut: unknown[] = [];
  for (const [ordinal, scenario] of scenarios.entries()) {
    const material = MEMORY_MATERIAL[scenario.id]!;
    const artifacts = resolvePromptArtifacts({
      locale: scenario.locale,
      policyVersions: {
        canonicalPersonaVersion: CANONICAL_PERSONA_VERSION,
        localePolicyVersion: scenario.locale.startsWith("zh")
          ? CHINESE_LOCALE_PACK_VERSION
          : ENGLISH_LOCALE_PACK_VERSION,
        personaBehaviorAnchorsVersion: PERSONA_BEHAVIOR_ANCHORS_VERSION,
        personaContractInvariantVersion: PERSONA_CONTRACT_INVARIANT_VERSION,
        taskInstructionVersion: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
      },
    });

    const buildInstructions = (input: { arm: Arm | null; turnIndex: number; day2: boolean }): string =>
      [
        artifacts.personaContractInvariant,
        artifacts.canonicalPersona,
        artifacts.personaBehaviorAnchors,
        artifacts.localePack,
        artifacts.taskInstruction,
        sessionLine(input.turnIndex, input.day2),
        input.arm ? memorySection({ arm: input.arm, material, day2: input.day2 }) : "",
        OUTPUT_FORMAT,
      ]
        .filter((section) => section.length > 0)
        .join("\n\n");

    // Day-1 (pre-gap turns) is generated once per scenario under the frozen
    // persona stack with no memory section — no memories exist yet, and every
    // arm then continues from this same shared history, so the arms differ
    // only in how day-2 memory is injected and instructed.
    const firstGapIndex = scenario.turns.findIndex((turn) => (turn.gapMs ?? 0) > 0);
    const sharedHistory: ChatMessage[] = [];
    const day1Turns: unknown[] = [];
    for (const [turnIndex, turn] of scenario.turns.entries()) {
      if (turnIndex >= firstGapIndex) break;
      const text = await generate(model, transport, {
        instructions: buildInstructions({ arm: null, turnIndex, day2: false }),
        locale: scenario.locale,
        messages: [...sharedHistory, { revisionId: `t${turnIndex + 1}`, role: "user", text: turn.text }],
      });
      sharedHistory.push(
        { revisionId: `t${turnIndex + 1}`, role: "user", text: turn.text },
        { revisionId: `t${turnIndex + 1}-a`, role: "assistant", text },
      );
      day1Turns.push({
        assistantText: text,
        flags: mechanicalFlags({
          text,
          forbiddenMentionTokens: scenario.memoryFixture.forbiddenMentionTokens,
          languageVariant: scenario.languageVariant,
          day2: false,
        }),
        userText: turn.text,
      });
      process.stdout.write(`  ${scenario.id} day1 t${turnIndex + 1} done (${[...text].length} chars)\n`);
    }

    const histories = new Map<ArmKey, ChatMessage[]>(
      ARMS.map((arm) => [arm.key, [...sharedHistory]] as [ArmKey, ChatMessage[]]),
    );
    const day2Turns: unknown[] = [];
    for (const [turnIndex, turn] of scenario.turns.entries()) {
      if (turnIndex < firstGapIndex) continue;
      const responses: Record<string, unknown> = {};
      await Promise.all(
        ARMS.map(async (arm) => {
          const history = histories.get(arm.key)!;
          try {
            const text = await generate(model, transport, {
              instructions: buildInstructions({ arm, turnIndex, day2: true }),
              locale: scenario.locale,
              messages: [...history, { revisionId: `t${turnIndex + 1}`, role: "user", text: turn.text }],
            });
            responses[arm.key] = {
              flags: mechanicalFlags({
                text,
                forbiddenMentionTokens: scenario.memoryFixture.forbiddenMentionTokens,
                languageVariant: scenario.languageVariant,
                day2: true,
              }),
              text,
            };
            history.push(
              { revisionId: `t${turnIndex + 1}`, role: "user", text: turn.text },
              { revisionId: `t${turnIndex + 1}-a`, role: "assistant", text },
            );
          } catch (error) {
            responses[arm.key] = {
              error: error instanceof Error ? error.message : String(error),
              flags: mechanicalFlags({
                text: "",
                forbiddenMentionTokens: scenario.memoryFixture.forbiddenMentionTokens,
                languageVariant: scenario.languageVariant,
                day2: true,
              }),
              text: "",
            };
            history.push({ revisionId: `t${turnIndex + 1}`, role: "user", text: turn.text });
          }
          const record = responses[arm.key] as { flags: MechanicalFlags };
          process.stdout.write(
            `  ${scenario.id} day2 t${turnIndex + 1} ${arm.key} done (${record.flags.charCount} chars)\n`,
          );
        }),
      );
      day2Turns.push({ gapMs: turn.gapMs ?? null, responses, userText: turn.text });
    }

    scenariosOut.push({
      day1: { turns: day1Turns },
      day2: { turns: day2Turns },
      description: scenario.description,
      fixtureSummary: {
        expectedRecall: scenario.memoryFixture.expectedRecall,
        forbiddenMentions: scenario.memoryFixture.forbiddenMentions,
        forbiddenMentionTokens: scenario.memoryFixture.forbiddenMentionTokens,
        injectedMemories: scenario.memoryFixture.injectedMemories,
        timeGrounding: scenario.memoryFixture.timeGrounding,
      },
      id: scenario.id,
      languageVariant: scenario.languageVariant,
      letterMap: letterAssignmentForScenario(ordinal),
      locale: scenario.locale,
    });
    process.stdout.write(`${scenario.id} complete\n`);
  }

  const comparison = {
    arms: ARMS.map((arm) => ({
      instructionsTemplate: [
        "(frozen persona v2 stack — invariant / canonical-persona:v2 / anchors:v2 / locale pack / task-instruction-decision:v2 / session line)",
        memorySection({ arm, material: MEMORY_MATERIAL["memory-continuity-en"]!, day2: true }) || "(no memory section)",
        OUTPUT_FORMAT,
      ].join("\n\n"),
      key: arm.key,
      name: arm.name,
      oneLiner: arm.oneLiner,
    })),
    dimensions: DIMENSIONS,
    generatedAtIso: new Date().toISOString(),
    issue: "lukemyself-hub/SayHear#94",
    meta: {
      approach:
        "Direct model calls against the frozen #79 persona v2 artifact stack; day-1 is generated once per scenario (no memories exist) and all arms continue from that shared history, so arms differ only in day-2 memory injection and its instructions.",
      blindLetters: "W/X/Y/Z shuffled per scenario by mulberry32(seed + ordinal*7); #62 derivation",
      gitCommit: gitCommit(),
      issueProtocol:
        "#62 protocol: seeded identity shuffle, per-turn annotation, scenario best, reveal then reverse-check against raw data; per-dimension 1–5 scales (ADR-0110), never summed.",
      limitations: [
        "Model outputs are sampled, not bit-reproducible; reproduction means the same frozen inputs and versions, not identical text.",
        "Retrieval is simulated deterministically: the day-2 turns inject the fixture's open-loop memory as the single query-matched item (turn-level retrieval is not built yet).",
        "The Person Portrait items are authored from the fixture's injectedMemories, split into one Objective Memory and one AI Impression to exercise both ADR-0009 recall languages; admission itself is not exercised.",
        "One response sample per (scenario, turn, arm); #62 precedent.",
      ],
      model: transport.model,
      personaVersions: {
        canonicalPersona: CANONICAL_PERSONA_VERSION,
        localePackChinese: CHINESE_LOCALE_PACK_VERSION,
        localePackEnglish: ENGLISH_LOCALE_PACK_VERSION,
        personaBehaviorAnchors: PERSONA_BEHAVIOR_ANCHORS_VERSION,
        personaContractInvariant: PERSONA_CONTRACT_INVARIANT_VERSION,
        taskInstruction: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
      },
      provider: process.env.SAYHEAR_PROVIDER_ADAPTER === "openai" ? "openai" : "deepseek",
      sampling: "provider default (non-deterministic), single sample per turn",
      scenarioSource: {
        category: "memory_continuity",
        count: scenarios.length,
        path: "eval/scenario-pack-v2/scenarios.json",
        sha256: createHash("sha256").update(packRaw).digest("hex"),
      },
    },
    protocol: PROTOCOL_VERSION,
    scenarios: scenariosOut,
    seed: BLIND_SEED,
  };

  await writeFile(path.join(outDir, "comparison.json"), JSON.stringify(comparison, null, 2));
  process.stdout.write(`wrote ${outDir}/comparison.json\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
