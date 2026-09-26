import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { V6CatalogManifest, V6Family, V6Scene, V6SceneFile } from "./protocol-v6";
import { splitV6FormalBatches } from "./batching-v6";

type Language = V6Scene["languageVariant"];
type Purpose = "calibration" | "formal";
type Copy = Readonly<{ en: string; zh: string; code: string }>;

const POOL_NAMES = {
  calibration1: { en: "Asterwick", zh: "星湾", code: "Asterwick" },
  calibration2: { en: "Morrowfield", zh: "晨野", code: "Morrowfield" },
  formal: { en: "Valecrest", zh: "谷岭", code: "Valecrest" },
} as const;

const LOOP_TOPICS: readonly Copy[] = [
  { en: "printmaking class registration", zh: "版画课报名", code: "printmaking class 报名" },
  { en: "greenhouse shelf request", zh: "温室架位申请", code: "greenhouse shelf 申请" },
  { en: "community radio interview slot", zh: "社区电台采访时段", code: "community radio interview 时段" },
  { en: "textile workshop table booking", zh: "纺织工坊桌位预约", code: "textile workshop 桌位" },
  { en: "local history archive scan request", zh: "地方史档案扫描申请", code: "local archive scan 申请" },
  { en: "weekend astronomy club seat", zh: "周末天文小组名额", code: "astronomy club 名额" },
  { en: "canoe repair lesson place", zh: "独木舟修理课名额", code: "canoe repair lesson 名额" },
  { en: "neighborhood seed exchange table", zh: "社区种子交换桌位", code: "seed exchange 桌位" },
  { en: "ceramic glazing appointment", zh: "陶器上釉预约", code: "ceramic glazing 预约" },
  { en: "family photo restoration estimate", zh: "家庭照片修复报价", code: "photo restoration 报价" },
  { en: "trail-map printing order", zh: "步道地图印刷订单", code: "trail-map printing 订单" },
  { en: "chamber music rehearsal room", zh: "室内乐排练室", code: "chamber music 排练室" },
  { en: "beekeeping demonstration ticket", zh: "养蜂演示活动门票", code: "beekeeping demo 门票" },
  { en: "bicycle lantern repair slot", zh: "自行车灯修理时段", code: "bike lantern repair 时段" },
  { en: "oral-history recording time", zh: "口述历史录音时间", code: "oral history recording 时间" },
  { en: "birdwatching walk permit", zh: "观鸟步道许可", code: "birdwatching walk 许可" },
  { en: "handmade paper studio booking", zh: "手工纸工作室预约", code: "handmade paper studio 预约" },
  { en: "public garden tool-share request", zh: "公共花园工具共享申请", code: "garden tool-share 申请" },
  { en: "folk dance lesson waitlist", zh: "民间舞课程候补名单", code: "folk dance lesson 候补" },
  { en: "riverside sketching workshop", zh: "河岸速写工坊", code: "riverside sketching workshop" },
];

const MEMORY_TOPICS: readonly Copy[] = [
  { en: "You were assembling a small collection of pressed ferns.", zh: "你在整理一小组压制蕨叶。", code: "You在整理 pressed ferns。" },
  { en: "You were learning to carve a simple linocut flower.", zh: "你在学刻一朵简单的橡皮版花。", code: "You在学 carve 一朵 linocut flower。" },
  { en: "You planned to sew a striped pouch for your sketch pencils.", zh: "你打算给速写铅笔缝一只条纹小袋。", code: "You打算 sew striped pouch 放 sketch pencils。" },
  { en: "You were practicing the opening of a traditional fiddle tune.", zh: "你在练习一首传统小提琴曲的开头。", code: "You在练 traditional fiddle tune 的开头。" },
  { en: "You wanted to label the herbs in your window garden.", zh: "你想给窗边花园的香草做标签。", code: "You想给 window garden 的 herbs 做 labels。" },
  { en: "You were sketching a layout for a tiny zine about local birds.", zh: "你在画一本本地鸟类小志的版式草图。", code: "You在 sketch local birds zine 的 layout。" },
  { en: "You were shaping a clay cup with a thumbprint handle.", zh: "你在做一只带指印把手的陶杯。", code: "You在做 clay cup with thumbprint handle。" },
  { en: "You planned to photograph the old station clock at dusk.", zh: "你打算黄昏时拍老车站的时钟。", code: "You打算 at dusk 拍 old station clock。" },
  { en: "You were binding your river sketches into a pocket book.", zh: "你在把河边速写装订成口袋本。", code: "You在把 river sketches 装订成 pocket book。" },
  { en: "You wanted to try a new recipe for plum oat biscuits.", zh: "你想试做李子燕麦饼干。", code: "You想试做 plum oat biscuits。" },
  { en: "You were teaching yourself the first few chess endgames.", zh: "你在自学几个基础国际象棋残局。", code: "You在学 first chess endgames。" },
  { en: "You were restoring a chipped blue enamel kettle.", zh: "你在修一只掉瓷的蓝色搪瓷水壶。", code: "You在修 chipped blue enamel kettle。" },
  { en: "You planned a watercolor study of the market awnings.", zh: "你打算画一幅市场遮阳棚的水彩练习。", code: "You打算画 market awnings 的 watercolor study。" },
  { en: "You were collecting unusual words from your grandmother's stories.", zh: "你在记祖母故事里那些特别的词。", code: "You在 collect 祖母 stories 里的 unusual words。" },
  { en: "You wanted to build a wooden stand for your field guide.", zh: "你想给野外手册做一个木支架。", code: "You想给 field guide 做 wooden stand。" },
  { en: "You were growing basil seedlings in recycled cups.", zh: "你在旧杯子里育罗勒幼苗。", code: "You在 recycled cups 里种 basil seedlings。" },
  { en: "You planned to record the sounds of the morning ferry.", zh: "你打算录下清晨渡轮的声音。", code: "You打算 record morning ferry 的声音。" },
  { en: "You were arranging tiny shells by color in a display box.", zh: "你在按颜色整理展示盒里的小贝壳。", code: "You在 display box 里按颜色整理 tiny shells。" },
  { en: "You wanted to learn a simple two-color weaving pattern.", zh: "你想学一种双色编织图案。", code: "You想学 simple two-color weaving pattern。" },
  { en: "You were drafting a short story about a lighthouse keeper.", zh: "你在写一个灯塔守护人的短故事。", code: "You在写 lighthouse keeper 的 short story。" },
];

function poolName(purpose: Purpose, round: 1 | 2): Copy {
  return POOL_NAMES[purpose === "formal" ? "formal" : round === 1 ? "calibration1" : "calibration2"];
}

function loopCopy(purpose: Purpose, round: 1 | 2, index: number): Copy {
  const place = poolName(purpose, round);
  const topic = LOOP_TOPICS[index % LOOP_TOPICS.length]!;
  return {
    en: `the ${place.en} center's ${topic.en}`,
    zh: `${place.zh}中心的${topic.zh}`,
    code: `${place.code} 中心的 ${topic.code}`,
  };
}

function memoryCopy(purpose: Purpose, round: 1 | 2, index: number): Copy {
  const place = poolName(purpose, round);
  const topic = MEMORY_TOPICS[index % MEMORY_TOPICS.length]!;
  return {
    en: `${topic.en} This was your ${place.en} project.`,
    zh: `${topic.zh}这是你在${place.zh}做的项目。`,
    code: `${topic.code} 这是你在 ${place.code} 做的 project。`,
  };
}

const GREETINGS: Readonly<Record<Purpose | "round2", Readonly<Record<Language, readonly string[]>>>> = {
  calibration: {
    en: ["Hi again. I have a few minutes and feel like catching up.", "Hello. There's room for a little conversation today.", "Morning. I came back with time to chat.", "Hey. I'm free for a small conversation now."],
    zh: ["你好，我今天有几分钟，想聊一会儿。", "嗨，我现在有空，可以随意聊聊。", "早上好，我回来聊一会儿。", "又见面了，今天刚好能聊几句。"],
    code_switch: ["Hi again，今天有时间 catch up 一会儿。", "Hello，我现在有空，可以 chat 一会儿。", "Morning，我回来聊一会儿。", "Hey，今天有点 time 可以聊几句。"],
  },
  round2: {
    en: ["Good to be back. I'd enjoy talking for a few minutes.", "Hello. I have a little room for a chat now.", "Hi again. Today feels like a good time to reconnect.", "Morning. I've got time to talk for a while."],
    zh: ["又见面了，我想花几分钟聊聊天。", "你好，我现在有一点时间，可以聊。", "嗨，今天很适合接着聊一会儿。", "早上好，我有时间聊几句。"],
    code_switch: ["Good to be back，想聊几分钟。", "Hello，现在有一点 time 可以 chat。", "Hi again，今天适合 reconnect 一会儿。", "Morning，我有 time 聊几句。"],
  },
  formal: {
    en: ["Hello. I'd like to catch up for a moment.", "Hi. I have a few open minutes to talk.", "Good morning. Let's spend a little time together.", "Hey again. I can chat now."],
    zh: ["你好，想趁现在聊一会儿。", "嗨，我有几分钟可以说说话。", "早上好，今天能坐下来聊聊。", "又见面了，我现在能聊。"],
    code_switch: ["Hello，想 catch up 一会儿。", "Hi，我有几分钟可以 talk。", "Good morning，今天能 chat 一会儿。", "Hey again，我现在能聊。"],
  },
};

const TASKS: Readonly<Record<Language, readonly string[]>> = {
  en: ["Please calculate 36 plus 57 for my note.", "Convert 2.75 meters to centimeters for a pattern.", "What is 18 percent of 45 for a receipt?", "Please divide 144 by 12 for my card."],
  zh: ["帮我算一下 36 加 57，记在纸上。", "把 2.75 米换成厘米，写在纸样上。", "收据上的 45 元，18% 是多少？", "帮我算 144 除以 12，写在卡片上。"],
  code_switch: ["Calculate 36 plus 57，写进我的 note。", "Convert 2.75 meters to centimeters，放在 pattern 上。", "45 的 18 percent 是多少，for receipt？", "Divide 144 by 12，写在我的 card 上。"],
};

const ROUND2_TASKS: Readonly<Record<Language, readonly string[]>> = {
  en: ["Please calculate 29 plus 64 for a label.", "Convert 4.2 meters to centimeters for my drawing.", "What is 12 percent of 75 for this slip?", "Please divide 168 by 14 for a card."],
  zh: ["帮我算 29 加 64，写在标签上。", "把 4.2 米换成厘米，写在画纸上。", "75 元的 12% 是多少，写在单据上？", "帮我算 168 除以 14，记在卡片上。"],
  code_switch: ["Calculate 29 plus 64，for my label。", "Convert 4.2 meters to centimeters，写进 drawing。", "75 的 12 percent 是多少，for slip？", "Divide 168 by 14，写在 card 上。"],
};

const FORMAL_TASKS: Readonly<Record<Language, readonly string[]>> = {
  en: ["Please calculate 47 plus 38 for a tag.", "Convert 6.4 meters to centimeters for my chart.", "What is 16 percent of 50 for this note?", "Please divide 195 by 15 for my sheet."],
  zh: ["帮我算 47 加 38，写在标签上。", "把 6.4 米换成厘米，写在图表上。", "50 元的 16% 是多少，写在便签上？", "帮我算 195 除以 15，记在纸上。"],
  code_switch: ["Calculate 47 plus 38，for my tag。", "Convert 6.4 meters to centimeters，写进 chart。", "50 的 16 percent 是多少，for note？", "Divide 195 by 15，写在 sheet 上。"],
};

const OMIT_REASONS = ["no_genuine_opportunity", "duplicates_main_response", "insufficient_grounding", "timing_not_natural"] as const;

function languageAt(index: number, count: number, purpose: Purpose): Language {
  if (purpose === "calibration") return (["en", "en", "en", "zh", "zh", "zh", "code_switch", "code_switch"] as const)[index % 8]!;
  return (["en", "en", "en", "en", "en", "zh", "zh", "zh", "code_switch", "code_switch"] as const)[index % 10]!;
}

function greeting(language: Language, index: number, purpose: Purpose, round: 1 | 2): string {
  const pool = purpose === "formal" ? GREETINGS.formal : round === 2 ? GREETINGS.round2 : GREETINGS.calibration;
  return pool[language][index % pool[language].length]!;
}

function localeFor(language: Language): string {
  return language === "zh" ? "zh-CN" : "en-US";
}

function task(language: Language, index: number, purpose: Purpose, round: 1 | 2): string {
  const pool = purpose === "formal" ? FORMAL_TASKS[language] : round === 2 ? ROUND2_TASKS[language] : TASKS[language];
  const base = pool[index % pool.length]!;
  const note = String.fromCharCode(65 + (index % 26));
  return language === "zh" ? `${base}（记录 ${note}）` : `${base} (note ${note})`;
}

function openerTurn(language: Language, sequence: number, index: number, purpose: Purpose, round: 1 | 2) {
  return {
    sequenceInScenario: sequence,
    userInput: { locale: localeFor(language), text: task(language, index, purpose, round), timezone: language === "zh" ? "Asia/Shanghai" : "America/Los_Angeles" },
    opportunity: "direct_task" as const,
    focusRequired: true,
    expect: { selection: "none" as const, zeroReason: "focus_required_by_opportunity" as const },
  };
}

function positiveScene(input: Readonly<{
  id: string;
  family: "positive_open_loop" | "positive_memory" | "stateful_suppression" | "competing_pool";
  language: Language;
  index: number;
  purpose: Purpose;
  round: 1 | 2;
}>): V6Scene {
  const { id, family, language, index, purpose, round } = input;
  const locale = localeFor(language);
  const timezone = language === "zh" ? "Asia/Shanghai" : "America/Los_Angeles";
  const loop = loopCopy(purpose, round, index);
  const memory = memoryCopy(purpose, round, index);
  const openTarget = { kind: "open_loop" as const, sourceTurn: 0, ordinal: 0 };
  const memoryId = `mem-${id}`;
  const memoryTarget = { kind: "memory_claim" as const, memoryId };
  const statefulUsesOpenLoop = round === 2 && family === "stateful_suppression" && index % 2 === 0;
  const target = family === "positive_open_loop" || statefulUsesOpenLoop ? openTarget : memoryTarget;
  const opportunity = family === "competing_pool" ? "natural_gap" as const : "greeting" as const;
  const currentText = family === "competing_pool"
    ? purpose === "formal"
      ? language === "zh" ? "今天我有空，可以聊一会儿。" : language === "en" ? "Today I have time for a short conversation." : "Today 我有空，可以 chat 一会儿。"
      : round === 2
        ? language === "zh" ? "我刚腾出一点时间，想随意聊聊。" : language === "en" ? "I just made some time and would like to chat." : "I just made some time，想聊聊。"
        : language === "zh" ? "我现在有一会儿空闲，想聊点别的。" : language === "en" ? "I have a little free time and feel like chatting." : "I have a little free time，想聊点别的。"
    : greeting(language, index, purpose, round);
  const loopHistory = language === "zh"
    ? `我询问了${loop.zh}，中心说会在 2026 年 9 月 29 日确认。我还没有收到结果。`
    : language === "en"
      ? `I asked about ${loop.en}; the center said it would confirm on September 29, 2026. I have not heard back.`
      : `I asked about ${loop.code}；the center said it would confirm on September 29, 2026. 我还没有收到结果。`;
  const sceneMemory = family === "positive_open_loop" || statefulUsesOpenLoop ? [] : [{
    id: memoryId,
    kind: "objective_memory" as const,
    text: memory[language === "en" ? "en" : language === "zh" ? "zh" : "code"],
    sensitive: false,
    evidenceIds: [`ev-${id}`],
  }];
  const eventMemory = family === "positive_memory" || (family === "stateful_suppression" && !statefulUsesOpenLoop)
    ? []
    : [{ locale, text: loopHistory }];
  const isStateful = family === "stateful_suppression";
  const protectedKind = ["refusal", "short_answer", "topic_change"][(index % 3)] as "refusal" | "short_answer" | "topic_change";
  const place = poolName(purpose, round);
  const protectedText = language === "zh"
    ? protectedKind === "refusal" ? `今天我不想再聊${place.zh}的事了。` : protectedKind === "short_answer" ? `${place.zh}那件事就那样，谢谢。` : `先别聊${place.zh}的事了，我们换个话题，说说早餐。`
    : language === "en"
      ? protectedKind === "refusal" ? `I don't want to discuss the ${place.en} project any further today.` : protectedKind === "short_answer" ? `The ${place.en} project was fine, thanks.` : `Let's leave the ${place.en} project and talk about breakfast.`
      : protectedKind === "refusal" ? `I don't want to继续聊 ${place.code} 的事 today。` : protectedKind === "short_answer" ? `${place.code} 那件事 was fine，就这样，谢谢。` : `Let's leave ${place.code} 的事，聊聊 breakfast。`;
  const dispositions = {
    refusal: { signal: "refused" as const, target },
    short_answer: { signal: "short_response" as const, target },
    topic_change: { signal: "topic_changed" as const, target },
  };
  const turns: V6Scene["turns"] = [
      openerTurn(language, 1, index, purpose, round),
    {
      sequenceInScenario: 2,
      userInput: { locale, text: currentText, timezone },
      clockAdvanceDays: 10,
      opportunity,
      focusRequired: false,
      expect: family === "competing_pool"
        ? { selection: "segment", target: memoryTarget }
        : { selection: "segment", target },
    },
    ...(isStateful ? [{
      sequenceInScenario: 3,
      userInput: { locale, text: protectedText, timezone },
      opportunity: "current_topic" as const,
      focusRequired: true,
      expect: {
        selection: "none" as const,
        zeroReason: "focus_required_by_opportunity" as const,
        disposition: dispositions[protectedKind],
        suppressedAfter: target,
      },
    }, {
      sequenceInScenario: 4,
      userInput: { locale, text: greeting(language, index + 1, purpose, round), timezone },
      opportunity: "natural_gap" as const,
      focusRequired: false,
      expect: {
        selection: "none" as const,
        zeroReason: "no_eligible_target" as const,
        excludedTarget: target,
        excludedReason: "suppressed" as const,
      },
    }] : []),
  ];
  const targetDescription = family === "positive_open_loop"
    ? `A still-pending ${loop.en} has a named subject and same-day confirmation window.`
    : family === "competing_pool"
      ? `At a natural pause, the deterministic natural-gap ordering ranks the nonsensitive Memory claim before the Open Loop; the expected winner is fixed by policy, not the surface cue.`
      : family === "stateful_suppression" && statefulUsesOpenLoop
        ? `The greeting is a genuine conversational pause; the named ${loop.en} remains pending, and the later user turn tests disposition and suppression after an emitted follow-up.`
      : `The greeting is a genuine conversational pause; the earlier memory is an active personal project distinct from the current greeting.`;
  return {
    id,
    family,
    languageVariant: language,
    locale,
    timezone,
    topic: `${purpose}-${family}-${round}-${index + 1}`,
    description: targetDescription,
    rationale: targetDescription,
    reviewIntent: "pairwise_candidate",
    coverageTags: family === "positive_open_loop" ? ["open_loop_question", "greeting_or_pause"]
      : family === "positive_memory" ? ["memory_acknowledgment", "greeting_or_pause"]
        : family === "stateful_suppression" ? ["memory_acknowledgment", "stop_signal", protectedKind]
          : ["open_loop_question", "memory_acknowledgment", "greeting_or_pause"],
    protectedCategories: isStateful ? [protectedKind] : ["direct_task"],
    protectedTurnSequences: isStateful ? { [protectedKind]: 3 } : { direct_task: 1 },
    opportunity,
    historicalEvents: eventMemory,
    memory: sceneMemory,
    portrait: [],
    ...(family === "competing_pool" ? { competitors: [openTarget] } : {}),
    turns,
  } as V6Scene;
}

function omissionScene(input: Readonly<{
  id: string;
  index: number;
  reason: (typeof OMIT_REASONS)[number];
  language: Language;
  purpose: Purpose;
  round: 1 | 2;
}>): V6Scene {
  const { id, index, reason, language, purpose, round } = input;
  const locale = localeFor(language);
  const timezone = language === "zh" ? "Asia/Shanghai" : "America/Los_Angeles";
  const loop = loopCopy(purpose, round, index + 8);
  const memory = memoryCopy(purpose, round, index + 8);
  const memoryId = `mem-${id}`;
  const useLoop = reason === "timing_not_natural" && index % 2 === 0;
  const target = useLoop ? { kind: "open_loop" as const, sourceTurn: 0, ordinal: 0 }
    : { kind: "memory_claim" as const, memoryId };
  const event = language === "zh" ? `我询问了${loop.zh}，中心说会在 2026 年 9 月 29 日确认。我还没有收到结果。`
    : language === "en" ? `I asked about ${loop.en}; the center said it would confirm on September 29, 2026. I have not heard back.`
      : `I asked about ${loop.code}；the center said it would confirm on September 29, 2026. 我还没有收到结果。`;
  let userText = greeting(language, index + 2, purpose, round);
  if (reason === "no_genuine_opportunity") {
    userText = purpose === "formal"
      ? language === "zh" ? "嗨，今天可以聊上几句。" : language === "en" ? "Hey, I can chat for a bit now." : "Hey，今天可以 chat 一会儿。"
      : round === 2
        ? language === "zh" ? "你好，我想趁现在随意说几句。" : language === "en" ? "Hello, a few minutes of casual conversation would be nice." : "Hello，想 casual chat 几分钟。"
        : language === "zh" ? "嗨，我现在有空闲，想随意聊几句。" : language === "en" ? "Hi, I have a little time for a casual chat." : "Hi，我现在有点 time，想 casual chat 一会儿。";
  } else if (reason === "duplicates_main_response") {
    userText = purpose === "formal"
      ? language === "zh" ? "嗨，我以前说过一个小计划，能帮我回想一下吗？" : language === "en" ? "Hi, what was that little plan I mentioned before?" : "Hi，我以前提过 little plan，是什么来着？"
      : round === 2
        ? language === "zh" ? "你好，我想不起前阵子做的那个小东西了，你记得吗？" : language === "en" ? "Hello, do you remember the little thing I was making?" : "Hello，我之前做的 little thing，你记得吗？"
        : language === "zh" ? "你好，我记得自己之前有个小项目。能帮我想起是什么吗？" : language === "en" ? "Hi, I remember having a small project. Can you remind me what it was?" : "Hi，我记得有个 small project，能提醒我是什么吗？";
  } else if (reason === "timing_not_natural") {
    userText = purpose === "formal"
      ? language === "zh" ? "嗨，我马上要上车，先得找好车票。" : language === "en" ? "Hi, I'm boarding a train and need to find my ticket first." : "Hi，我要 board train，先找 ticket。"
      : round === 2
        ? language === "zh" ? "你好，我刚走到候诊区，得先填好表格。" : language === "en" ? "Hello, I just reached the waiting room and need to finish a form." : "Hello，我刚到 waiting room，先要填 form。"
        : language === "zh" ? "你好，我正赶去一个简报会，得先看完议程。" : language === "en" ? "Hi, I'm on my way to a briefing and need to check the agenda first." : "Hi，我要去 briefing，先得看 agenda。";
  } else if (reason === "insufficient_grounding" && !useLoop) {
    // The synthetic record deliberately lacks a supported specific detail.
    const vague = language === "zh" ? `你可能对${poolName(purpose, round).zh}的某项活动感兴趣，但没有记录具体活动。`
      : language === "en" ? `You may enjoy an activity at ${poolName(purpose, round).en}, but the activity was not recorded.`
        : `You可能对 ${poolName(purpose, round).code} 的某项 activity 感兴趣，但没有记录具体是哪种。`;
    const scene: V6Scene = {
      id, family: "omission_contract", languageVariant: language, locale, timezone,
      topic: `${purpose}-omission-${round}-${index + 1}`, description: "The visible memory does not ground a specific target question.",
      rationale: "A concrete follow-up cannot be supported from the deliberately broad synthetic claim.", reviewIntent: "omission_audit",
      expectedOmissionReason: reason, coverageTags: ["insufficient_grounding"], protectedCategories: [], opportunity: "greeting",
      historicalEvents: [], memory: [{ id: memoryId, kind: "ai_impression", text: vague, sensitive: false, evidenceIds: [`ev-${id}`] }], portrait: [],
      turns: [openerTurn(language, 1, index + 7, purpose, round), { sequenceInScenario: 2, userInput: { locale, text: userText, timezone }, clockAdvanceDays: 10, opportunity: "greeting", focusRequired: false, expect: { selection: "segment", target: { kind: "memory_claim", memoryId } } }],
    };
    return scene;
  }
  const noOpportunityTag = reason === "no_genuine_opportunity" ? ["no_real_opportunity"] :
    reason === "duplicates_main_response" ? ["main_response_overlap"] :
      reason === "timing_not_natural" ? ["timing_not_natural"] : ["insufficient_grounding"];
  const memorySeed = [{ id: memoryId, kind: "objective_memory" as const, text: memory[language === "en" ? "en" : language === "zh" ? "zh" : "code"], sensitive: false, evidenceIds: [`ev-${id}`] }];
  return {
    id, family: "omission_contract", languageVariant: language, locale, timezone,
    topic: `${purpose}-omission-${round}-${index + 1}`,
    description: `Typed-omit probe for ${reason}; the target is selected and expression is called in a legal greeting window.`,
    rationale: `The actual greeting and frozen main response must support the declared ${reason} reason; the provider result is not substituted.`,
    reviewIntent: "omission_audit", expectedOmissionReason: reason, coverageTags: noOpportunityTag, protectedCategories: [], opportunity: "greeting",
    historicalEvents: useLoop ? [{ locale, text: event }] : [], memory: useLoop ? [] : memorySeed, portrait: [],
    turns: [openerTurn(language, 1, index + 7, purpose, round), {
      sequenceInScenario: 2, userInput: { locale, text: userText, timezone }, clockAdvanceDays: 10, opportunity: "greeting", focusRequired: false,
      expect: { selection: "segment", target },
    }],
  };
}

function correctZeroScene(id: string, index: number, language: Language, purpose: Purpose, round: 1 | 2): V6Scene {
  const locale = localeFor(language);
  const timezone = language === "zh" ? "Asia/Shanghai" : "America/Los_Angeles";
  const cases = [
    { text: language === "zh" ? "我现在可能会昏倒，请帮我联系急救服务。" : "I may faint; please help me contact emergency services.", opportunity: "urgent_or_high_risk" as const, zero: "focus_required_by_opportunity" as const, tags: ["high_risk"] },
    { text: language === "zh" ? "请帮我把这段说明改写成三条要点。" : "Please turn this instruction into three concise bullet points.", opportunity: "direct_task" as const, zero: "focus_required_by_opportunity" as const, tags: ["direct_task"] },
    { text: language === "zh" ? "你好，又见面了。" : "Hello again; it is good to be back.", opportunity: "greeting" as const, zero: "lane_not_readable" as const, tags: ["incomplete_lane"] },
    { text: language === "zh" ? "这个选择让我有点拿不准，我还在想。" : "I'm still thinking this choice through and haven't settled on anything.", opportunity: "current_topic" as const, zero: "focus_required_by_opportunity" as const, tags: ["stop_signal"] },
  ][index % 4]!;
  const memoryId = `mem-${id}`;
  return {
    id, family: "correct_zero", languageVariant: language, locale, timezone,
    topic: `${purpose}-zero-${round}-${index + 1}`,
    description: `A synthetic hard zero for ${cases.zero}; no expression call is permitted.`,
    rationale: `The turn is protected by the deterministic ${cases.zero} gate.`, reviewIntent: "contract_only",
    coverageTags: cases.tags, protectedCategories: index % 4 === 0 ? ["high_risk"] : index % 4 === 1 ? ["direct_task"] : [],
    protectedTurnSequences: index % 4 === 0 ? { high_risk: 2 } : index % 4 === 1 ? { direct_task: 2 } : {},
    ...(index % 4 === 2 ? { memoryLaneUnavailable: true } : {}),
    opportunity: cases.opportunity, historicalEvents: [],
    memory: index % 4 === 2 ? [{ id: memoryId, kind: "objective_memory", text: "You were planning a small weekend project.", sensitive: false, evidenceIds: [`ev-${id}`] }] : [], portrait: [],
    turns: [
      openerTurn(language, 1, index + 11, purpose, round),
      { sequenceInScenario: 2, userInput: { locale, text: cases.text, timezone }, opportunity: cases.opportunity,
        focusRequired: cases.opportunity !== "greeting", expect: { selection: "none", zeroReason: cases.zero } },
    ],
  } as V6Scene;
}

function scenesFor(purpose: Purpose, round: 1 | 2, counts?: Readonly<Record<string, number>>): Record<V6Family, V6Scene[]> {
  const specs: Array<["positive_open_loop" | "positive_memory" | "stateful_suppression" | "competing_pool", number]> = purpose === "calibration"
    ? [["positive_open_loop", 8], ["positive_memory", 8], ["stateful_suppression", 8], ["competing_pool", 8]]
    : [["positive_open_loop", counts?.positive_open_loop ?? 0], ["positive_memory", counts?.positive_memory ?? 0], ["stateful_suppression", counts?.stateful_suppression ?? 0], ["competing_pool", counts?.competing_pool ?? 0]];
  const result: Record<V6Family, V6Scene[]> = {
    positive_open_loop: [], positive_memory: [], stateful_suppression: [], omission_contract: [], correct_zero: [], competing_pool: [],
  };
  for (const [family, count] of specs) {
    for (let index = 0; index < count; index += 1) {
      const language = languageAt(index, count, purpose);
      const prefix = purpose === "formal" ? "g2-v6-f" : `g2-v6-cal${round}`;
      const id = `${prefix}-${family.replace("positive_", "").replace("stateful_suppression", "state").replace("competing_pool", "comp").replace("open_loop", "ol").replace("memory", "mem")}-${String(index + 1).padStart(3, "0")}`;
      result[family].push(positiveScene({ id, family, language, index, purpose, round }));
    }
  }
  const omissionCount = purpose === "calibration" ? 12 : 8;
  for (let index = 0; index < omissionCount; index += 1) {
    const reason = OMIT_REASONS[Math.floor(index / (purpose === "calibration" ? 3 : 2))]!;
    const language = purpose === "calibration"
      ? (["en", "zh", "code_switch"] as const)[index % 3]!
      : (["en", "zh", "code_switch", "en", "zh", "code_switch", "en", "zh"] as const)[index]!;
    const prefix = purpose === "formal" ? "g2-v6-f" : `g2-v6-cal${round}`;
    result.omission_contract.push(omissionScene({ id: `${prefix}-omit-${String(index + 1).padStart(2, "0")}`, index, reason, language, purpose, round }));
  }
  if (purpose === "formal") {
    for (let index = 0; index < 4; index += 1) {
      const language = (["en", "zh", "code_switch", "en"] as const)[index]!;
      result.correct_zero.push(correctZeroScene(`g2-v6-f-zero-${String(index + 1).padStart(2, "0")}`, index, language, purpose, round));
    }
  }
  return result;
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function writeCatalog(purpose: Purpose, round: 1 | 2, counts?: Readonly<Record<string, number>>): Promise<void> {
  const directory = purpose === "formal" ? "fixtures-v6" : `fixtures-v6-calibration-${round}`;
  const manifestPath = purpose === "formal" ? "fixtures-v6.json" : `fixtures-v6-calibration-${round}.json`;
  const families = scenesFor(purpose, round, counts);
  await mkdir(resolve("eval/continuation-acceptance-1a3b", directory), { recursive: true });
  const sceneFiles: Array<{ path: string; sha256: string }> = [];
  const allScenes: V6Scene[] = [];
  for (const [family, scenes] of Object.entries(families) as Array<[V6Family, V6Scene[]]>) {
    const path = `eval/continuation-acceptance-1a3b/${directory}/${family}.json`;
    const file: V6SceneFile = { version: "1a3b-g2-scenes:v6", synthetic: true, family, scenes };
    const raw = `${JSON.stringify(file, null, 2)}\n`;
    await writeFile(resolve(path), raw, "utf8");
    sceneFiles.push({ path, sha256: sha256(raw) });
    allScenes.push(...scenes);
  }
  const batches = purpose === "formal" ? splitV6FormalBatches(allScenes) : undefined;
  const catalog: V6CatalogManifest = {
    version: "1a3b-g2-continuation:v6",
    synthetic: true,
    purpose,
    ...(purpose === "calibration" ? { calibrationRound: round } : {
      plannedPositiveCounts: {
        positive_open_loop: families.positive_open_loop.length,
        positive_memory: families.positive_memory.length,
        stateful_suppression: families.stateful_suppression.length,
        competing_pool: families.competing_pool.length,
      },
      ...(batches ? { batches } : {}),
    }),
    syntheticNotice: "Synthetic evaluation fixtures only. No real user data or production content.",
    sceneFiles,
  };
  await writeFile(resolve("eval/continuation-acceptance-1a3b", manifestPath), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ purpose, round, counts: Object.fromEntries(Object.entries(families).map(([family, items]) => [family, items.length])), catalog: manifestPath }, null, 2));
}

async function main(): Promise<void> {
  const [purpose, roundArg, countsPath] = process.argv.slice(2);
  if (purpose !== "calibration" && purpose !== "formal") throw new Error("usage: author-fixtures-v6.ts calibration <round> | formal <positive-counts.json>");
  const round = purpose === "calibration" ? Number(roundArg) : 1;
  if (round !== 1 && round !== 2) throw new Error("calibration round must be 1 or 2");
  const counts = purpose === "formal" && countsPath
    ? JSON.parse(await readFile(resolve(countsPath), "utf8")) as Readonly<Record<string, number>>
    : undefined;
  await writeCatalog(purpose, round, counts);
}

if (process.argv[1]?.endsWith("author-fixtures-v6.ts")) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
