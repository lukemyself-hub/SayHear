import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { V5CatalogManifest, V5Family, V5Scene, V5SceneFile } from "./protocol-v5";
import { splitV5FormalBatches } from "./batching-v5";

type Language = V5Scene["languageVariant"];
type Purpose = "calibration" | "formal";
type Copy = Readonly<{ en: string; zh: string; code: string }>;

const LOOPS: readonly Copy[] = [
  { en: "the North Pier print studio's risograph booking", zh: "北岸印刷工作室的孔版印刷预约", code: "North Pier 印刷工作室的 risograph 预约" },
  { en: "the Marigold community choir's room request", zh: "金盏花社区合唱团的排练室申请", code: "Marigold 社区合唱团的 room request" },
  { en: "the Alder Street repair café's parts order", zh: "桤木街维修咖啡馆的零件订单", code: "Alder Street repair cafe 的 parts order" },
  { en: "the Harborview pottery studio's kiln slot", zh: "港景陶艺工作室的窑炉时段", code: "Harborview 陶艺工作室的 kiln slot" },
  { en: "the Juniper neighborhood library's meeting room", zh: "杜松社区图书馆的会议室", code: "Juniper 社区图书馆的 meeting room" },
  { en: "the Willow Lane bike co-op's wheel estimate", zh: "柳巷自行车合作社的车轮报价", code: "Willow Lane 自行车合作社的 wheel estimate" },
  { en: "the Lantern House theater's volunteer schedule", zh: "灯屋剧场的志愿者排班", code: "Lantern House 剧场的 volunteer schedule" },
  { en: "the Seabird makerspace's laser-cutter orientation", zh: "海鸟创客空间的激光切割培训", code: "Seabird 创客空间的 laser-cutter 培训" },
  { en: "the Fern Hollow garden's shared-tool request", zh: "蕨谷社区花园的共享工具申请", code: "Fern Hollow 社区花园的 shared-tool request" },
  { en: "the Blue Finch dance school's recital slot", zh: "蓝雀舞蹈学校的汇演时段", code: "Blue Finch 舞蹈学校的 recital slot" },
  { en: "the Redwood sewing circle's borrowed-machine return", zh: "红杉缝纫小组的借用机器归还", code: "Redwood 缝纫小组的 borrowed-machine return" },
  { en: "the Crescent food pantry's Saturday shift", zh: "新月食品站的周六班次", code: "Crescent 食品站的 Saturday shift" },
  { en: "the Stonebridge language exchange's table booking", zh: "石桥语言交流会的桌位预约", code: "Stonebridge 语言交流会的 table booking" },
  { en: "the Meadowline kayak club's launch notice", zh: "草线皮划艇俱乐部的下水通知", code: "Meadowline 皮划艇俱乐部的 launch notice" },
  { en: "the Copper Kettle cooking school's class list", zh: "铜壶烹饪学校的课程名单", code: "Copper Kettle 烹饪学校的 class list" },
  { en: "the Eastgate transit office's lost-card case", zh: "东门交通服务处的遗失卡处理", code: "Eastgate 交通服务处的 lost-card case" },
  { en: "the Paper Moon bookshop's author-event seats", zh: "纸月书店的作者活动座位", code: "Paper Moon 书店的 author-event seats" },
  { en: "the Ridgeview climbing gym's beginner-session time", zh: "岭景攀岩馆的初学者课程时间", code: "Ridgeview 攀岩馆的 beginner-session time" },
  { en: "the Orchard Street repair shop's lamp assessment", zh: "果园街修理店的台灯评估", code: "Orchard Street 修理店的 lamp assessment" },
  { en: "the Quiet Current rowing group's launch roster", zh: "静流赛艇小组的出发名单", code: "Quiet Current 赛艇小组的 launch roster" },
];

const MEMORIES: readonly Copy[] = [
  { en: "You were practicing a short jazz phrase before the next piano meetup.", zh: "你之前在练一段爵士钢琴短句，准备下次聚会时弹。", code: "You were练一段爵士钢琴短句 before the next piano meetup." },
  { en: "You wanted to finish the blue-and-white patchwork cushion you started.", zh: "你想完成那只已经开工的蓝白拼布靠垫。", code: "You想完成那只 blue-and-white 拼布靠垫。" },
  { en: "You were learning three basic knots for the next sailing lesson.", zh: "你在为下次帆船课学习三种基础绳结。", code: "You在学三个 basic knots for the next sailing lesson." },
  { en: "You hoped to sketch the old water tower from the hill path.", zh: "你想从山坡小路上画一画那座老水塔。", code: "You想从 hill path 画那座 old water tower。" },
  { en: "You were testing a small batch of orange-cardamom biscuits.", zh: "你之前在试做一小批橙香豆蔻饼干。", code: "You在试做一小批 orange-cardamom biscuits。" },
  { en: "You planned to mend the canvas tote with the green thread.", zh: "你打算用绿色线补好那只帆布袋。", code: "You打算用 green thread 补好 canvas tote。" },
  { en: "You were collecting neighborhood bird sounds for a tiny audio collage.", zh: "你在收集社区鸟鸣，想做一个小小的声音拼贴。", code: "You在收集 neighborhood bird sounds 做 audio collage。" },
  { en: "You wanted to try the beginner's watercolor exercise with loose leaves.", zh: "你想试试那张用散叶练习的水彩入门画。", code: "You想试 beginner watercolor exercise with loose leaves。" },
  { en: "You were sorting the family recipe cards into a handwritten booklet.", zh: "你在把家里的食谱卡整理成手写小册子。", code: "You在把 family recipe cards 整理成 handwritten booklet。" },
  { en: "You hoped to learn the opening bars of a folk tune on the ukulele.", zh: "你想学会用尤克里里弹一首民谣的开头几小节。", code: "You想用 ukulele 学会 folk tune 的 opening bars。" },
  { en: "You had saved a few balcony herbs to repot when the weather cooled.", zh: "天气凉下来时，你想给阳台上的几盆香草换盆。", code: "You想在天气转凉时 repot balcony herbs。" },
  { en: "You were making a paper model of the lighthouse for your desk.", zh: "你在给书桌做一座纸质灯塔模型。", code: "You在给 desk 做 paper lighthouse model。" },
  { en: "You wanted to practice the opening page of a new short story.", zh: "你想练习新短篇小说的第一页。", code: "You想练习 new short story 的 opening page。" },
  { en: "You were planning a simple stargazing chart for the autumn evenings.", zh: "你在为秋夜做一张简单的观星图。", code: "You在为 autumn evenings 做 simple stargazing chart。" },
  { en: "You hoped to finish the small clay bowl before glazing day.", zh: "你想在上釉日之前完成那只小陶碗。", code: "You想在 glazing day 前完成 small clay bowl。" },
  { en: "You were learning a few phrases for the neighborhood's Italian table.", zh: "你在为社区意大利语餐桌活动学几句常用语。", code: "You在为 neighborhood Italian table 学几个 phrases。" },
  { en: "You planned to bind the travel sketches into a pocket notebook.", zh: "你打算把旅行速写装订成一本口袋笔记。", code: "You打算把 travel sketches 装订成 pocket notebook。" },
  { en: "You were trying to identify the tree with the red seed pods.", zh: "你想认出那种结红色荚果的树。", code: "You想认出那棵结 red seed pods 的树。" },
  { en: "You wanted to make a simple wooden stand for the reading lamp.", zh: "你想给阅读灯做一个简单的木支架。", code: "You想给 reading lamp 做 simple wooden stand。" },
  { en: "You were learning the first verse of a song for the community picnic.", zh: "你在学社区野餐会上要唱的那首歌的第一段。", code: "You在学 community picnic 那首歌的 first verse。" },
];

const GREETINGS: Readonly<Record<Purpose | "round2", Readonly<Record<Language, readonly string[]>>>> = {
  calibration: {
    en: ["Hello again; I'm glad to have a quiet minute.", "Hi, good to see you. I have a little pause now.", "Morning; I have a calm moment before the day gets busy.", "Hey again. It's nice to be back for a minute."],
    zh: ["你好，又见面了。我现在刚好有一会儿空闲。", "嗨，很高兴再聊一会儿。", "早上好，我现在有片刻空闲。", "又见面啦，我刚好能安静一会儿。"],
    code_switch: ["Hi again, 我现在刚好有一会儿空闲。", "Hey, good to see you. 我能安静一会儿。", "Morning! 现在有片刻空闲。", "Hello again, 很高兴再聊一会儿。"],
  },
  formal: {
    en: ["Good to see you again; I have a few calm minutes.", "Hi there, I'm back for a short pause.", "Hello, it's nice to have a little breathing room.", "Hey, glad we're talking again for a moment."],
    zh: ["又见面了，我现在有几分钟空闲。", "嗨，我回来稍微歇一会儿。", "你好，现在终于能喘口气了。", "嗨，很高兴又能聊一小会儿。"],
    code_switch: ["Good to see you again, 我现在有几分钟空闲。", "Hi there, 我回来稍微歇一会儿。", "Hello, 现在终于能喘口气了。", "Hey, glad we're talking. 我能聊一小会儿。"],
  },
  round2: {
    en: ["Hello; I'm back and have a small pause.", "Hey, it is good to have a quiet minute again.", "Hi there; I can catch my breath for a moment.", "Morning again, I have a little space now."],
    zh: ["你好，我回来了，现在能歇一小会儿。", "嗨，又有片刻安静时间了。", "我现在能喘口气，再聊一下。", "又是早上好，我现在有一点空档。"],
    code_switch: ["Hello, 我回来了，现在能歇一小会儿。", "Hey, 又有片刻安静时间了。", "Hi, 我现在能 catch my breath。", "Morning again, 我现在有一点空档。"],
  },
};

const TASKS: Readonly<Record<Language, readonly string[]>> = {
  en: ["Please convert 18 Celsius to Fahrenheit for my notes.", "Can you turn 3.5 miles into kilometers for a route card?", "Please calculate a 15 percent tip on 28 dollars.", "Convert 2.4 liters to cups for this recipe, please."],
  zh: ["请把 18 摄氏度换算成华氏度，我要记下来。", "帮我把 3.5 英里换算成公里，写在路线卡上。", "请算一下 28 美元的 15% 小费。", "请把 2.4 升换算成杯数，用在食谱里。"],
  code_switch: ["Please convert 18°C to Fahrenheit，写在我的 notes 里。", "Can you turn 3.5 miles into kilometers，放到 route card 上？", "帮我算一下 28 dollars 的 15 percent tip。", "Convert 2.4 liters to cups，做 recipe 用。"],
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

function task(language: Language, index: number): string {
  const pool = TASKS[language];
  const base = pool[index % pool.length]!;
  const note = String.fromCharCode(65 + (index % 26));
  return language === "zh" ? `${base}（记录 ${note}）` : `${base} (note ${note})`;
}

function openerTurn(language: Language, sequence: number, index: number) {
  return {
    sequenceInScenario: sequence,
    userInput: { locale: localeFor(language), text: task(language, index), timezone: language === "zh" ? "Asia/Shanghai" : "America/Los_Angeles" },
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
}>): V5Scene {
  const { id, family, language, index, purpose, round } = input;
  const locale = localeFor(language);
  const timezone = language === "zh" ? "Asia/Shanghai" : "America/Los_Angeles";
  const loop = LOOPS[(index + (round === 2 ? 7 : purpose === "formal" ? 3 : 0)) % LOOPS.length]!;
  const memory = MEMORIES[(index * 3 + (round === 2 ? 5 : purpose === "formal" ? 9 : 0)) % MEMORIES.length]!;
  const openTarget = { kind: "open_loop" as const, sourceTurn: 0, ordinal: 0 };
  const memoryId = `mem-${id}`;
  const memoryTarget = { kind: "memory_claim" as const, memoryId };
  const target = family === "positive_open_loop" ? openTarget : memoryTarget;
  const opportunity = family === "competing_pool" ? "natural_gap" as const : "greeting" as const;
  const currentText = family === "competing_pool"
    ? language === "zh" ? "我现在有一会儿安静时间。" : language === "en" ? "I have a quiet stretch to myself for a moment." : "I have a quiet moment，刚好能歇一下。"
    : greeting(language, index, purpose, round);
  const loopHistory = language === "zh"
    ? `你联系了${loop.zh}，对方说会在 2026 年 9 月 23 日前确认。`
    : language === "en"
      ? `You contacted ${loop.en}; they said they would confirm by September 23, 2026.`
      : `You contacted ${loop.code}；they said they would confirm by September 23, 2026.`;
  const sceneMemory = family === "positive_open_loop" ? [] : [{
    id: memoryId,
    kind: "objective_memory" as const,
    text: memory[language === "en" ? "en" : language === "zh" ? "zh" : "code"],
    sensitive: false,
    evidenceIds: [`ev-${id}`],
  }];
  const eventMemory = family === "positive_memory" || family === "stateful_suppression"
    ? []
    : [{ locale, text: loopHistory }];
  const isStateful = family === "stateful_suppression";
  const protectedKind = ["refusal", "short_answer", "topic_change"][(index % 3)] as "refusal" | "short_answer" | "topic_change";
  const protectedText = language === "zh"
    ? protectedKind === "refusal" ? "今天我不想再聊这件事了。" : protectedKind === "short_answer" ? "就那样，谢谢。" : "我们换个话题吧，我想说说早餐。"
    : language === "en"
      ? protectedKind === "refusal" ? "I don't want to talk about this any further today." : protectedKind === "short_answer" ? "It was fine, thanks." : "Let's switch topics; I want to talk about breakfast."
      : protectedKind === "refusal" ? "I don't want to继续聊这件事 today." : protectedKind === "short_answer" ? "It was fine，就这样，谢谢。" : "Let's switch topics，聊聊早餐吧。";
  const dispositions = {
    refusal: { signal: "refused" as const, target },
    short_answer: { signal: "short_response" as const, target },
    topic_change: { signal: "topic_changed" as const, target },
  };
  const turns: V5Scene["turns"] = [
    openerTurn(language, 1, index),
    {
      sequenceInScenario: 2,
      userInput: { locale, text: currentText, timezone },
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
  } as V5Scene;
}

function omissionScene(input: Readonly<{
  id: string;
  index: number;
  reason: (typeof OMIT_REASONS)[number];
  language: Language;
  purpose: Purpose;
  round: 1 | 2;
}>): V5Scene {
  const { id, index, reason, language, purpose, round } = input;
  const locale = localeFor(language);
  const timezone = language === "zh" ? "Asia/Shanghai" : "America/Los_Angeles";
  const loop = LOOPS[(index * 5 + (round === 2 ? 11 : purpose === "formal" ? 13 : 2)) % LOOPS.length]!;
  const memory = MEMORIES[(index * 7 + (round === 2 ? 3 : purpose === "formal" ? 6 : 1)) % MEMORIES.length]!;
  const memoryId = `mem-${id}`;
  const useLoop = reason === "duplicates_main_response" ||
    (reason !== "insufficient_grounding" && index % 2 === 0);
  const target = useLoop ? { kind: "open_loop" as const, sourceTurn: 0, ordinal: 0 }
    : { kind: "memory_claim" as const, memoryId };
  const event = language === "zh" ? `你联系了${loop.zh}，对方说会在 2026 年 9 月 23 日前确认。`
    : language === "en" ? `You contacted ${loop.en}; they promised to confirm by September 23, 2026.`
      : `You contacted ${loop.code}；they promised to confirm by September 23, 2026.`;
  let userText = greeting(language, index + 2, purpose, round);
  if (reason === "duplicates_main_response") {
    userText = language === "zh"
      ? `嗨，${loop.zh}已经确认好了，事情解决了，我现在可以放心了。`
      : language === "en"
        ? `Hi, I got the confirmation about ${loop.en}; it is settled now, and I'm relieved.`
        : `Hi, ${loop.code} 已经确认好了，it's settled now，我放心了。`;
  } else if (reason === "timing_not_natural") {
    userText = language === "zh"
      ? "你好，我现在正在接孩子放学，手上有点忙，晚些时候再安静下来。"
      : language === "en"
        ? "Hi, I'm in the school pickup line and need to keep my attention here for a bit."
        : "Hi, 我现在在 school pickup line，得先专心处理眼前的事。";
  } else if (reason === "insufficient_grounding" && !useLoop) {
    // The synthetic record deliberately lacks a supported specific detail.
    const vague = language === "zh" ? "你可能对某种创意活动感兴趣，但具体是什么没有记录。"
      : language === "en" ? "You may enjoy some kind of creative activity, but no specific one was recorded."
        : "You可能喜欢某种 creative activity，但没有记录具体是哪种。";
    const scene: V5Scene = {
      id, family: "omission_contract", languageVariant: language, locale, timezone,
      topic: `${purpose}-omission-${round}-${index + 1}`, description: "The visible memory does not ground a specific target question.",
      rationale: "A concrete follow-up cannot be supported from the deliberately broad synthetic claim.", reviewIntent: "omission_audit",
      expectedOmissionReason: reason, coverageTags: ["insufficient_grounding"], protectedCategories: [], opportunity: "greeting",
      historicalEvents: [], memory: [{ id: memoryId, kind: "ai_impression", text: vague, sensitive: false, evidenceIds: [`ev-${id}`] }], portrait: [],
      turns: [openerTurn(language, 1, index + 7), { sequenceInScenario: 2, userInput: { locale, text: userText, timezone }, opportunity: "greeting", focusRequired: false, expect: { selection: "segment", target: { kind: "memory_claim", memoryId } } }],
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
    turns: [openerTurn(language, 1, index + 7), {
      sequenceInScenario: 2, userInput: { locale, text: userText, timezone }, opportunity: "greeting", focusRequired: false,
      expect: { selection: "segment", target },
    }],
  };
}

function correctZeroScene(id: string, index: number, language: Language, purpose: Purpose, round: 1 | 2): V5Scene {
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
      openerTurn(language, 1, index + 11),
      { sequenceInScenario: 2, userInput: { locale, text: cases.text, timezone }, opportunity: cases.opportunity,
        focusRequired: cases.opportunity !== "greeting", expect: { selection: "none", zeroReason: cases.zero } },
    ],
  } as V5Scene;
}

function scenesFor(purpose: Purpose, round: 1 | 2, counts?: Readonly<Record<string, number>>): Record<V5Family, V5Scene[]> {
  const specs: Array<["positive_open_loop" | "positive_memory" | "stateful_suppression" | "competing_pool", number]> = purpose === "calibration"
    ? [["positive_open_loop", 8], ["positive_memory", 8], ["stateful_suppression", 8], ["competing_pool", 8]]
    : [["positive_open_loop", counts?.positive_open_loop ?? 0], ["positive_memory", counts?.positive_memory ?? 0], ["stateful_suppression", counts?.stateful_suppression ?? 0], ["competing_pool", counts?.competing_pool ?? 0]];
  const result: Record<V5Family, V5Scene[]> = {
    positive_open_loop: [], positive_memory: [], stateful_suppression: [], omission_contract: [], correct_zero: [], competing_pool: [],
  };
  for (const [family, count] of specs) {
    for (let index = 0; index < count; index += 1) {
      const language = languageAt(index, count, purpose);
      const prefix = purpose === "formal" ? "g2-v5-f" : `g2-v5-cal${round}`;
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
    const prefix = purpose === "formal" ? "g2-v5-f" : `g2-v5-cal${round}`;
    result.omission_contract.push(omissionScene({ id: `${prefix}-omit-${String(index + 1).padStart(2, "0")}`, index, reason, language, purpose, round }));
  }
  if (purpose === "formal") {
    for (let index = 0; index < 4; index += 1) {
      const language = (["en", "zh", "code_switch", "en"] as const)[index]!;
      result.correct_zero.push(correctZeroScene(`g2-v5-f-zero-${String(index + 1).padStart(2, "0")}`, index, language, purpose, round));
    }
  }
  return result;
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function writeCatalog(purpose: Purpose, round: 1 | 2, counts?: Readonly<Record<string, number>>): Promise<void> {
  const directory = purpose === "formal" ? "fixtures-v5" : `fixtures-v5-calibration-${round}`;
  const manifestPath = purpose === "formal" ? "fixtures-v5.json" : `fixtures-v5-calibration-${round}.json`;
  const families = scenesFor(purpose, round, counts);
  await mkdir(resolve("eval/continuation-acceptance-1a3b", directory), { recursive: true });
  const sceneFiles: Array<{ path: string; sha256: string }> = [];
  const allScenes: V5Scene[] = [];
  for (const [family, scenes] of Object.entries(families) as Array<[V5Family, V5Scene[]]>) {
    const path = `eval/continuation-acceptance-1a3b/${directory}/${family}.json`;
    const file: V5SceneFile = { version: "1a3b-g2-scenes:v5", synthetic: true, family, scenes };
    const raw = `${JSON.stringify(file, null, 2)}\n`;
    await writeFile(resolve(path), raw, "utf8");
    sceneFiles.push({ path, sha256: sha256(raw) });
    allScenes.push(...scenes);
  }
  const batches = purpose === "formal" ? splitV5FormalBatches(allScenes) : undefined;
  const catalog: V5CatalogManifest = {
    version: "1a3b-g2-continuation:v5",
    synthetic: true,
    purpose,
    ...(purpose === "calibration" ? { calibrationRound: round } : {
      plannedPositiveCounts: {
        positive_open_loop: families.positive_open_loop.length,
        positive_memory: families.positive_memory.length,
        stateful_suppression: families.stateful_suppression.length,
        competing_pool: families.competing_pool.length,
      },
      batches,
    }),
    syntheticNotice: "Synthetic evaluation fixtures only. No real user data or production content.",
    sceneFiles,
  };
  await writeFile(resolve("eval/continuation-acceptance-1a3b", manifestPath), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ purpose, round, counts: Object.fromEntries(Object.entries(families).map(([family, items]) => [family, items.length])), catalog: manifestPath }, null, 2));
}

async function main(): Promise<void> {
  const [purpose, roundArg, countsPath] = process.argv.slice(2);
  if (purpose !== "calibration" && purpose !== "formal") throw new Error("usage: author-fixtures-v5.ts calibration <round> | formal <positive-counts.json>");
  const round = purpose === "calibration" ? Number(roundArg) : 1;
  if (round !== 1 && round !== 2) throw new Error("calibration round must be 1 or 2");
  const counts = purpose === "formal" && countsPath
    ? JSON.parse(await readFile(resolve(countsPath), "utf8")) as Readonly<Record<string, number>>
    : undefined;
  await writeCatalog(purpose, round, counts);
}

if (process.argv[1]?.endsWith("author-fixtures-v5.ts")) {
  main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
