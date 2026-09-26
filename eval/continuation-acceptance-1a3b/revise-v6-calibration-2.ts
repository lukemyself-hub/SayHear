/**
 * Independent second v6 calibration after round 1 showed two input defects:
 * no Open Loop proposal from "asked about" history, and main responses that
 * already covered the selected target. The original, uncalled round-2 draft
 * remains byte-for-byte intact as part of round-1's frozen disjointness proof.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { V6CatalogManifest, V6Scene, V6SceneFile } from "./protocol-v6";

const ROOT = "eval/continuation-acceptance-1a3b";
const SOURCE = `${ROOT}/fixtures-v6-calibration-2.json`;
const DIRECTORY = `${ROOT}/fixtures-v6-calibration-2-revised`;
const CATALOG = `${ROOT}/fixtures-v6-calibration-2-revised.json`;

const OBSERVATIONS = {
  en: [
    "Hello again. I just put the kettle away and have a little time to chat.",
    "Hi. I came back from a short walk and can talk for a few minutes.",
    "Morning. The light at my desk is nice today, and I have time to talk.",
    "Hey. I finished tidying the table and have a little room to chat.",
  ],
  zh: [
    "你好，我刚把水壶收好，现在能聊一会儿。",
    "嗨，我刚散步回来，有几分钟能聊。",
    "早上好，今天桌边的光挺好，我有空聊一会儿。",
    "又见面了，我刚收好桌子，能聊几句。",
  ],
  code_switch: [
    "Hello again，我刚把 kettle 收好，现在能聊一会儿。",
    "Hi，我刚走完 short walk，有几分钟能聊。",
    "Morning，桌边的 light 很好，我有空聊一会儿。",
    "Hey，我刚 tidy 好桌子，能 chat 几句。",
  ],
} as const;

const TASKS = {
  en: ["Please calculate 58 plus 27. Just give the number.", "Please convert 3.6 meters to centimeters. Only the result.", "Please calculate 14 percent of 60. Just the amount.", "Please divide 156 by 13. Only the answer."],
  zh: ["请算 58 加 27，只给数字。", "请把 3.6 米换成厘米，只给结果。", "请算 60 的 14%，只给数值。", "请算 156 除以 13，只给答案。"],
  code_switch: ["Calculate 58 plus 27，只给 number。", "Convert 3.6 meters to centimeters，只给 result。", "Calculate 14 percent of 60，只给 amount。", "Divide 156 by 13，只给 answer。"],
} as const;

function language(scene: V6Scene): keyof typeof TASKS {
  return scene.languageVariant === "zh" ? "zh" : scene.languageVariant === "code_switch" ? "code_switch" : "en";
}

function sourceEvent(scene: V6Scene): string {
  const source = scene.historicalEvents[0]?.text ?? "";
  if (scene.languageVariant === "zh") {
    const topic = source.match(/铃溪中心的([^，；。]+)/u)?.[1];
    if (!topic) throw new Error(`${scene.id}: cannot identify Chinese Open Loop subject`);
    return `我向铃溪中心提交了关于${topic}的请求。工作人员说会在 2026 年 9 月 29 日前给出决定，我还不知道结果。`;
  }
  const rawTopic = scene.languageVariant === "code_switch"
    ? source.match(/Bellwater 中心的 ([^；]+)/u)?.[1]
    : source.match(/Bellwater center's ([^;；]+)/u)?.[1];
  if (!rawTopic) throw new Error(`${scene.id}: cannot identify Open Loop subject`);
  const topic = rawTopic.replace(/ request$/u, "");
  if (scene.languageVariant === "code_switch") {
    return `I submitted a request to Bellwater center about its ${topic}；coordinator Mira said the decision would arrive by September 29, 2026. 我还不知道结果。`;
  }
  return `I submitted a request to Bellwater center about its ${topic}. Coordinator Mira said the decision would arrive by September 29, 2026. I still do not know the result.`;
}

function revise(scene: V6Scene, index: number): V6Scene {
  const copy = JSON.parse(JSON.stringify(scene).replaceAll("g2-v6-cal2-", "g2-v6-cal2r-")
    .replaceAll("Morrowfield", "Bellwater").replaceAll("晨野", "铃溪")) as V6Scene;
  const lang = language(copy);
  const hasLoop = copy.historicalEvents.length > 0;
  const turns = copy.turns.map((turn) => ({ ...turn, userInput: { ...turn.userInput } }));
  const first = turns[0]!;
  first.userInput.text = `${TASKS[lang][index % 4]} ${lang === "zh" ? `（第 ${index + 1} 张纸）` : `(sheet ${index + 1})`}`;
  if (copy.family !== "omission_contract") {
    const anchor = turns[1]!;
    anchor.userInput.text = OBSERVATIONS[lang][index % 4]!;
    anchor.opportunity = copy.family === "competing_pool"
      ? "natural_gap"
      : (["greeting", "open_start", "natural_gap"] as const)[index % 3]!;
    if (copy.family === "stateful_suppression") {
      turns[3]!.userInput.text = OBSERVATIONS[lang][(index + 1) % 4]!;
    }
  } else {
    const probe = turns[1]!;
    switch (copy.expectedOmissionReason) {
      case "no_genuine_opportunity":
        return {
          ...copy,
          topic: `${copy.topic}-revised`,
          memory: [{ ...copy.memory[0]!, text: lang === "zh" ? "你在铃溪中心挑过一支灰色铅笔。" : lang === "en" ? "You once chose a plain gray pencil at Bellwater center." : "You在 Bellwater center 挑过一支 gray pencil。" }],
          historicalEvents: [],
          turns: turns.map((item, position) => position === 1 ? { ...item, userInput: { ...item.userInput, text: OBSERVATIONS[lang][index % 4] } } : item),
        } as V6Scene;
      case "duplicates_main_response":
        probe.userInput.text = lang === "zh" ? "你好，之前在铃溪做的那个小项目，我一下想不起是什么了。" : lang === "en" ? "Hi, I can't quite place that little Bellwater project I told you about." : "Hi，我一下想不起之前在 Bellwater 做的 little project 了。";
        break;
      case "insufficient_grounding":
        probe.userInput.text = OBSERVATIONS[lang][index % 4]!;
        break;
      case "timing_not_natural":
        probe.userInput.text = lang === "zh" ? "嗨，我正要进电梯，先得找好楼层。" : lang === "en" ? "Hi, I'm stepping into an elevator and need to find my floor first." : "Hi，我要进 elevator，先找 floor。";
        break;
    }
  }
  return {
    ...copy,
    topic: `${copy.topic}-revised`,
    historicalEvents: hasLoop ? [{ ...copy.historicalEvents[0]!, text: sourceEvent(copy) }] : [],
    turns,
  };
}

async function main(): Promise<void> {
  const catalog = JSON.parse(await readFile(resolve(SOURCE), "utf8")) as V6CatalogManifest;
  if (catalog.purpose !== "calibration" || catalog.calibrationRound !== 2) {
    throw new Error("Only the uncalled round-2 draft can be revised.");
  }
  await mkdir(resolve(DIRECTORY), { recursive: true });
  const sceneFiles: Array<{ path: string; sha256: string }> = [];
  for (const entry of catalog.sceneFiles) {
    const file = JSON.parse(await readFile(resolve(entry.path), "utf8")) as V6SceneFile;
    const scenes = file.scenes.map((scene, index) => revise(scene, index));
    const path = `${DIRECTORY}/${file.family}.json`;
    const raw = `${JSON.stringify({ ...file, scenes }, null, 2)}\n`;
    await writeFile(resolve(path), raw, "utf8");
    sceneFiles.push({ path, sha256: createHash("sha256").update(raw).digest("hex") });
  }
  await writeFile(resolve(CATALOG), `${JSON.stringify({ ...catalog, sceneFiles }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ catalog: CATALOG, source: SOURCE, sceneCount: 44 }));
}

if (process.argv[1]?.endsWith("revise-v6-calibration-2.ts")) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
