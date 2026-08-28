/**
 * Build scenario-pack:v3 for issue #118 (SPEC #107 recall experience
 * contract; grilling #95 / #99, ADR-0116 / ADR-0117, #94 evidence).
 *
 * Extends the committed scenario-pack:v2.1 (#61 pack + #63 additions + #77
 * fixtures) with:
 * - the activated v3 memory-fixture tiering on the three existing
 *   memory_continuity scenarios: expectedRecall leaves its 1A.3a deferral and
 *   becomes the two-tier expectedRecall of #99 (token-level required words =
 *   hard gate; semantic expectations = advisory judge pre-screen), plus the
 *   day-boundary `forbiddenMentionFromTurn` so the correct-zero opener turns
 *   are provable; and
 * - 9 new multi-day scenarios (three kinds x en / zh / code_switch) forcing
 *   coverage of Objective Memory recall language, Person Portrait / AI
 *   Impression natural surfacing, relationship temporal change, and
 *   post-Correction / post-Forget non-reuse. Each new scenario pairs a
 *   zero-signal day-2 greeting (correct zero: zero injection, no displayed
 *   continuity — evaluated as correct, ADR-0117) with a substantive turn
 *   whose recall is expected.
 *
 * Every scenario, name, and event added here is fully fictional synthetic
 * material. Run from the repo root:
 *
 *   pnpm exec tsx eval/scenario-pack-v3/build-v3.ts
 */
import { readFile, writeFile } from "node:fs/promises";

import {
  scenarioMemoryChecks,
  type ExpectedRecall,
  type FencedMention,
  type MemoryFixture,
  type ScenarioPack,
  type ScenarioPackEntry,
} from "./tiered-checks";

const sourcePath = "eval/scenario-pack-v2/scenarios.json";
const outPath = "eval/scenario-pack-v3/scenarios.json";

type Turn = { text: string; gapMs?: number };

type NewScenario = {
  id: string;
  category: "memory_objective" | "memory_impression" | "memory_temporal";
  languageVariant: "en" | "zh" | "code_switch";
  description: string;
  turns: Turn[];
  memoryFixture: MemoryFixture;
};

// ---------------------------------------------------------------------------
// v3 upgrades for the #77 memory_continuity fixtures: the two-tier
// expectedRecall (turn 3 is the zero-signal opener — correct zero; turn 4
// carries the token-level required words), the day-2 boundary turn for the
// forbidden-mention gate, and the v3 injected-memory kinds (1A.3a has no
// Open Loops — both items are Objective Memory of what the user stated).
// ---------------------------------------------------------------------------

const continuityFixtureUpgrades: Record<string, MemoryFixture> = {
  "memory-continuity-en": {
    note: "v3 (#118): activated two-tier expectedRecall; hypothetical 1A.3a projection of the day-1 exchange; synthetic.",
    injectedMemories: [
      {
        kind: "objective_memory",
        text: "Biopsy results were due at a follow-up appointment the day after the day-1 exchange; the user had waited two weeks.",
        evidence: "day-1 turn 1",
      },
      {
        kind: "objective_memory",
        text: "The user was trying not to spiral while waiting; talking that night helped them feel steadier.",
        evidence: "day-1 turn 2",
      },
    ],
    expectedRecalls: [
      {
        atTurn: 3,
        semantic:
          "Correct zero (ADR-0117): the day-2 opener carries no matchable signal for the injected memory, so zero injection and no displayed continuity is the correct outcome — evaluated as correct, never as a miss.",
      },
      {
        atTurn: 4,
        semantic:
          "The user announces the clean results; the response must receive the relief instead of re-litigating the wait, and may naturally recall the two-week wait it actually holds.",
        requiredTokens: ["two weeks"],
      },
    ],
    forbiddenMentions: [
      "biopsy site or body part (never stated)",
      "hospital, clinic, or doctor names",
      "any companion, friend, or family member (none mentioned)",
    ],
    forbiddenMentionTokens: [
      "st. mary's",
      "dr. patel",
      "left breast",
      "your sister",
      "your mom",
      "your family",
    ],
    forbiddenMentionFromTurn: 3,
    timeGrounding:
      "Turns after the gap are a new calendar day and a new Daily Session; they must not reference day-1 time-of-day such as 'tonight' or 'tomorrow'.",
    checks: scenarioMemoryChecks(),
  },
  "memory-continuity-zh": {
    note: "v3（#118）：两级 expectedRecall 翻活；对第一天交流的假设性 1A.3a 投影；合成材料。",
    injectedMemories: [
      {
        kind: "objective_memory",
        text: "次日上午复诊出活检结果，用户已等待两周。",
        evidence: "第一天第 1 轮",
      },
      {
        kind: "objective_memory",
        text: "用户在尽量不瞎想，当晚说完感觉踏实多了。",
        evidence: "第一天第 2 轮",
      },
    ],
    expectedRecalls: [
      {
        atTurn: 3,
        semantic:
          "正确零（ADR-0117）：第二天开场对注入记忆没有可匹配信号，零注入、不表现连续性是正确行为——判对，不判漏。",
      },
      {
        atTurn: 4,
        semantic:
          "用户宣布结果没事；回应须承接如释重负，而不是重新复盘等待过程，并可以自然召回它真实持有的「等了两周」。",
        requiredTokens: ["两周"],
      },
    ],
    forbiddenMentions: [
      "检查部位或身体部位（从未提及）",
      "医院、诊所或医生姓名",
      "任何未出现过的亲友",
    ],
    forbiddenMentionTokens: [
      "人民医院",
      "王医生",
      "左乳",
      "你姐姐",
      "你妹妹",
      "你妈",
      "你家人",
    ],
    forbiddenMentionFromTurn: 3,
    timeGrounding:
      "跨 gap 的轮次属于新的本地日期和新的 Daily Session，不得引用第一天的当天时间（如「今晚」「明天」）。",
    checks: scenarioMemoryChecks(),
  },
  "memory-continuity-mix": {
    note: "v3（#118）：两级 expectedRecall 翻活；对第一天交流的假设性 1A.3a 投影；合成材料。",
    injectedMemories: [
      {
        kind: "objective_memory",
        text: "第二天 follow-up 出 biopsy 结果，用户已等两周。",
        evidence: "第一天第 1 轮",
      },
      {
        kind: "objective_memory",
        text: "用户在尽量不 spiral，说完感觉好一点了。",
        evidence: "第一天第 2 轮",
      },
    ],
    expectedRecalls: [
      {
        atTurn: 3,
        semantic:
          "正确零（ADR-0117）：第二天开场没有可匹配信号，零注入、不表现连续性是正确行为——判对，不判漏。",
      },
      {
        atTurn: 4,
        semantic:
          "用户宣布 all clear；回应须承接如释重负，并可自然召回它真实持有的「等了两周」。",
        requiredTokens: ["两周"],
      },
    ],
    forbiddenMentions: [
      "检查部位或身体部位（从未提及）",
      "医院、诊所或医生姓名",
      "任何未出现过的亲友",
    ],
    forbiddenMentionTokens: [
      "city hospital",
      "dr. wang",
      "肿块",
      "你姐",
      "你妈",
      "你家人",
    ],
    forbiddenMentionFromTurn: 3,
    timeGrounding:
      "跨 gap 的轮次属于新的本地日期和新的 Daily Session，不得引用第一天的当天时间（如「今晚」「明天」）。",
    checks: scenarioMemoryChecks(),
  },
};

// ---------------------------------------------------------------------------
// The 9 new multi-day scenarios (#118 forced coverage). All fictional.
// ---------------------------------------------------------------------------

const newScenarios: NewScenario[] = [
  // --- memory_objective: Objective Memory recall language (ADR-0009).
  {
    id: "memory-objective-en",
    category: "memory_objective",
    languageVariant: "en",
    description:
      "Multi-day Objective Memory: a concrete stated fact on day one, a zero-signal day-2 greeting (correct zero), then a substantive day-2 turn; tests source-attributing recall language without implying independent verification.",
    turns: [
      {
        text: "I signed the offer today — I'm joining Brightline Health as a data engineer, starting October 5th.",
      },
      {
        text: "Honestly I'm mostly nervous about telling my current manager. She's been good to me.",
      },
      {
        text: "Morning. Rough night — the neighbor's dog barked till three.",
        gapMs: 93600000,
      },
      {
        text: "So, about the new job — when should I tell my manager? I keep putting it off.",
      },
    ],
    memoryFixture: {
      note: "Hypothetical 1A.3a projection injected on day-2 turns; synthetic.",
      injectedMemories: [
        {
          kind: "objective_memory",
          text: "The user signed an offer to join Brightline Health as a data engineer, starting October 5th.",
          evidence: "day-1 turn 1",
        },
        {
          kind: "objective_memory",
          text: "The user is nervous about telling their current manager, who has been good to them.",
          evidence: "day-1 turn 2",
        },
      ],
      expectedRecalls: [
        {
          atTurn: 3,
          semantic:
            "Correct zero (ADR-0117): the greeting carries no matchable signal, so zero injection and no displayed continuity is correct — evaluated as correct, not a miss.",
        },
        {
          atTurn: 4,
          semantic:
            "The response may naturally use the injected Objective Memory, with source attribution (\"you mentioned...\") allowed but never implying independent verification (ADR-0009).",
          requiredTokens: ["Brightline"],
        },
      ],
      forbiddenMentions: [
        "signing bonus or compensation details (never stated)",
        "any recruiter or hiring process detail",
        "any non-compete or contract clause",
      ],
      forbiddenMentionTokens: ["signing bonus", "recruiter", "non-compete"],
      forbiddenMentionFromTurn: 3,
      timeGrounding:
        "Turns after the gap are a new calendar day and a new Daily Session; day-1 time-of-day must not be referenced.",
      checks: scenarioMemoryChecks(),
    },
  },
  {
    id: "memory-objective-zh",
    category: "memory_objective",
    languageVariant: "zh",
    description:
      "多日 Objective Memory：第一天陈述具体事实，第二天零信号开场（正确零）加实质话题轮；检验「你之前说过…」式来源归属、不暗示独立核验（ADR-0009）。",
    turns: [
      { text: "我今天把 offer 签了，下个月入职启明医疗，做数据工程师。" },
      { text: "就是有点不知道怎么跟现在的主管开口，她平时对我挺好的。" },
      {
        text: "早。昨晚没睡好，楼下装修吵到后半夜。",
        gapMs: 93600000,
      },
      { text: "新工作的事，我到底什么时候跟主管说合适啊？" },
    ],
    memoryFixture: {
      note: "第二天轮次的假设性 1A.3a 注入投影；合成材料。",
      injectedMemories: [
        {
          kind: "objective_memory",
          text: "用户签了启明医疗的数据工程师 offer，下个月入职。",
          evidence: "第一天第 1 轮",
        },
        {
          kind: "objective_memory",
          text: "用户在为怎么跟现任主管开口而纠结；主管平时对他不错。",
          evidence: "第一天第 2 轮",
        },
      ],
      expectedRecalls: [
        {
          atTurn: 3,
          semantic:
            "正确零（ADR-0117）：开场对注入记忆没有可匹配信号，零注入、不表现连续性是正确行为——判对，不判漏。",
        },
        {
          atTurn: 4,
          semantic:
            "回应可自然使用注入的 Objective Memory，可以用「你之前说过…」来源归属，但不得表述为独立核验过的事实（ADR-0009）。",
          requiredTokens: ["启明"],
        },
      ],
      forbiddenMentions: [
        "签字费或薪资细节（从未提及）",
        "任何猎头或招聘流程细节",
        "任何竞业或合同条款",
      ],
      forbiddenMentionTokens: ["签字费", "猎头", "竞业协议"],
      forbiddenMentionFromTurn: 3,
      timeGrounding:
        "跨 gap 的轮次属于新的本地日期和新的 Daily Session，不得引用第一天的当天时间。",
      checks: scenarioMemoryChecks(),
    },
  },
  {
    id: "memory-objective-mix",
    category: "memory_objective",
    languageVariant: "code_switch",
    description:
      "code-switch 多日 Objective Memory：检验中英夹杂下的来源归属召回语言与正确零开场（ADR-0009 / ADR-0117）。",
    turns: [
      { text: "我把 offer 签了！下个月入职 Brightline，做 data engineer。" },
      { text: "就是不知道怎么跟现在的老板开口，她对我一直挺好的。" },
      {
        text: "早。昨晚楼上的 party 吵到两点。",
        gapMs: 93600000,
      },
      { text: "说回新 work，我什么时候跟老板说比较好？" },
    ],
    memoryFixture: {
      note: "第二天轮次的假设性 1A.3a 注入投影；合成材料。",
      injectedMemories: [
        {
          kind: "objective_memory",
          text: "用户签了 Brightline 的 data engineer offer，下个月入职。",
          evidence: "第一天第 1 轮",
        },
        {
          kind: "objective_memory",
          text: "用户在纠结怎么跟现任老板开口；老板对他一直不错。",
          evidence: "第一天第 2 轮",
        },
      ],
      expectedRecalls: [
        {
          atTurn: 3,
          semantic:
            "正确零（ADR-0117）：开场没有可匹配信号，零注入、不表现连续性是正确行为。",
        },
        {
          atTurn: 4,
          semantic:
            "回应可自然召回并来源归属（\"你之前说过…\" / \"you mentioned…\"），不得表述为独立核验过的事实；code-switch 跟随用户的夹杂方式。",
          requiredTokens: ["Brightline"],
        },
      ],
      forbiddenMentions: [
        "签字费或薪资细节（从未提及）",
        "任何猎头或 background check 细节",
        "任何未出现过的同事",
      ],
      forbiddenMentionTokens: ["signing bonus", "猎头", "background check"],
      forbiddenMentionFromTurn: 3,
      timeGrounding:
        "跨 gap 的轮次属于新的本地日期和新的 Daily Session，不得引用第一天的当天时间。",
      checks: scenarioMemoryChecks(),
    },
  },

  // --- memory_impression: Person Portrait / AI Impression natural
  //     surfacing (ADR-0116); the epistemic bans stay semantic-tier.
  {
    id: "memory-impression-en",
    category: "memory_impression",
    languageVariant: "en",
    description:
      "Multi-day AI Impression: cross-session evidence for an honest-over-comfort impression, a zero-signal day-3 greeting, then a turn that invites the impression; tests natural friend-like surfacing with no provenance ritual and no epistemic upgrade.",
    turns: [
      {
        text: "I told my roommate the truth about the broken lamp today. Figured an honest conversation now beats a bigger lie later.",
      },
      {
        text: "Same thing last week with the client issue — I'd rather own the blame early than spin it.",
      },
      {
        text: "Hey. Coffee in hand, thinking about stuff.",
        gapMs: 172800000,
      },
      {
        text: "My sister asked why I'm always so blunt about mistakes. I don't know, it's just how I am?",
      },
    ],
    memoryFixture: {
      note: "Hypothetical 1A.3a projection injected on day-3 turns; synthetic.",
      injectedMemories: [
        {
          kind: "ai_impression",
          text: "Across sessions the user consistently weighs honesty over comfort — they surface uncomfortable truths early and take the blame rather than spin it.",
          evidence: "day-1 turns 1–2; an earlier session on the client issue",
        },
        {
          kind: "person_portrait",
          text: "The user tends to own mistakes early instead of covering them up.",
          evidence: "day-1 turn 2",
        },
      ],
      expectedRecalls: [
        {
          atTurn: 3,
          semantic:
            "Correct zero (ADR-0117): the greeting carries no matchable signal, so zero injection and no displayed continuity is correct — evaluated as correct, not a miss.",
        },
        {
          atTurn: 4,
          semantic:
            "The response may voice the injected impression naturally and confidently in friend-like language (ADR-0116), with no provenance ritual; it must not upgrade the impression into a user-stated or verified fact, invent a global trait beyond the evidence, freeze a temporary state into identity, or apply a diagnostic / sensitive identity label (ADR-0009). Wording varies legitimately, so this expectation stays on the advisory semantic tier.",
        },
      ],
      forbiddenMentions: [
        "any therapy or counseling history (never stated)",
        "any astrology / personality-typing framing",
        "any cited study or book shaping the trait",
      ],
      forbiddenMentionTokens: ["your therapist", "astrology", "read a study"],
      forbiddenMentionFromTurn: 3,
      timeGrounding:
        "Turns after the gap are a new calendar day and a new Daily Session; day-1 time-of-day must not be referenced.",
      checks: scenarioMemoryChecks(),
    },
  },
  {
    id: "memory-impression-zh",
    category: "memory_impression",
    languageVariant: "zh",
    description:
      "多日 AI Impression：跨 Session 证据支撑「诚实优先于舒服」的印象，第三天零信号开场加触发轮；检验朋友式自然表达、无仪式化铺垫、无认识状态升级（ADR-0116 / ADR-0009）。",
    turns: [
      { text: "今天跟室友坦白了打碎台灯的事。长痛不如短痛，早说早了。" },
      { text: "上周客户那个锅我也是直接兜的，与其绕圈子不如早点认。" },
      {
        text: "在呢，抱着杯咖啡发呆。",
        gapMs: 172800000,
      },
      {
        text: "我姐问我为什么犯错的事上总是那么直接，我也说不上来，就是这么个人吧。",
      },
    ],
    memoryFixture: {
      note: "第三天轮次的假设性 1A.3a 注入投影；合成材料。",
      injectedMemories: [
        {
          kind: "ai_impression",
          text: "跨 Session 观察：用户在诚实和舒服之间稳定地选诚实——难受的真话也早说，锅也先兜住。",
          evidence: "第一天第 1–2 轮；更早的客户事件",
        },
        {
          kind: "person_portrait",
          text: "用户倾向先认错、不遮掩。",
          evidence: "第一天第 2 轮",
        },
      ],
      expectedRecalls: [
        {
          atTurn: 3,
          semantic:
            "正确零（ADR-0117）：开场对注入记忆没有可匹配信号，零注入、不表现连续性是正确行为——判对，不判漏。",
        },
        {
          atTurn: 4,
          semantic:
            "回应可以自然、自信地以朋友式语言表达注入的印象（ADR-0116），不需要来源铺垫；不得升级成用户亲述或已核实事实，不得凭证据之外的瞬间发明全局标签，不得把暂时的状态固化成身份，也不得贴诊断式或敏感身份标签（ADR-0009）。措辞合理变化，此期望留在 advisory 语义层。",
        },
      ],
      forbiddenMentions: [
        "任何心理咨询或治疗史（从未提及）",
        "任何星座 / 人格类型学框架",
        "任何被引用的研究或书",
      ],
      forbiddenMentionTokens: ["心理咨询师", "星座", "看过一本书"],
      forbiddenMentionFromTurn: 3,
      timeGrounding:
        "跨 gap 的轮次属于新的本地日期和新的 Daily Session，不得引用第一天的当天时间。",
      checks: scenarioMemoryChecks(),
    },
  },
  {
    id: "memory-impression-mix",
    category: "memory_impression",
    languageVariant: "code_switch",
    description:
      "code-switch 多日 AI Impression：检验中英夹杂下印象的朋友式自然表达与认识状态边界（ADR-0116 / ADR-0009）。",
    turns: [
      { text: "今天跟 roommate 坦白了打碎台灯的事，早说早了。" },
      { text: "上周 client 那个锅我也直接 take 了，懒得绕圈子。" },
      {
        text: "在呢，抱着咖啡发呆。",
        gapMs: 172800000,
      },
      {
        text: "我姐问我为什么犯错的事上总那么 direct，我也说不上来，就感觉这样比较 honest 吧。",
      },
    ],
    memoryFixture: {
      note: "第三天轮次的假设性 1A.3a 注入投影；合成材料。",
      injectedMemories: [
        {
          kind: "ai_impression",
          text: "跨 Session 观察：用户稳定地把 honest 排在舒服前面——真话早说，锅先兜住。",
          evidence: "第一天第 1–2 轮；更早的 client 事件",
        },
        {
          kind: "person_portrait",
          text: "用户倾向先认错、不 cover。",
          evidence: "第一天第 2 轮",
        },
      ],
      expectedRecalls: [
        {
          atTurn: 3,
          semantic:
            "正确零（ADR-0117）：开场没有可匹配信号，零注入、不表现连续性是正确行为。",
        },
        {
          atTurn: 4,
          semantic:
            "回应可自然、朋友式地表达注入的印象（ADR-0116），不得升级成用户亲述或已核实事实、不得发明全局标签、不得固化暂时状态、不得贴诊断式标签；code-switch 跟随用户。措辞合理变化，此期望留在 advisory 语义层。",
        },
      ],
      forbiddenMentions: [
        "任何心理咨询或治疗史（从未提及）",
        "任何星座 / 人格类型学框架",
        "任何未出现过的书或研究",
      ],
      forbiddenMentionTokens: ["你的 therapist", "星座", "mindset 书"],
      forbiddenMentionFromTurn: 3,
      timeGrounding:
        "跨 gap 的轮次属于新的本地日期和新的 Daily Session，不得引用第一天的当天时间。",
      checks: scenarioMemoryChecks(),
    },
  },

  // --- memory_temporal: relationship temporal change with post-Correction
  //     non-reuse (en / zh) and post-Forget non-reuse (code_switch).
  {
    id: "memory-temporal-en",
    category: "memory_temporal",
    languageVariant: "en",
    description:
      "Multi-day relationship temporal change: day-1 dating statement, day-20 user correction to friendship, day-21 housewarming question; tests post-Correction non-reuse of the corrected-away state.",
    turns: [
      { text: "Alex and I finally made it official — we're dating." },
      { text: "It's new, about three weeks in, but it feels easy." },
      {
        text: "Quick correction on us — I jumped the gun before. Alex and I talked it through: we're not dating, we decided to stay friends. Saying it was official was my mistake.",
        gapMs: 1555200000,
      },
      {
        text: "Alex invited me to their housewarming tonight. Not sure whether I should go.",
        gapMs: 86400000,
      },
    ],
    memoryFixture: {
      note: "Hypothetical 1A.3a projection after the day-20 correction; synthetic.",
      injectedMemories: [
        {
          kind: "objective_memory",
          text: "The user and Alex decided to stay friends; the day-1 \"officially dating\" statement was corrected by the user on day-20.",
          evidence: "day-20 turn 3 (correction); original day-1 turn 1",
        },
      ],
      expectedRecalls: [
        {
          atTurn: 3,
          semantic:
            "The response must accept the correction and drop the romance framing; post-Correction non-reuse begins and the corrected-away state is fenced from turn 4 onward.",
        },
        {
          atTurn: 4,
          semantic:
            "The response grounds in the corrected state — they decided to stay friends — and never resurrects the dating frame.",
          requiredTokens: ["friend"],
        },
      ],
      forbiddenMentions: [
        "any cousin or family member of Alex (never stated)",
        "any engagement or wedding framing",
        "any prior dating history detail",
      ],
      forbiddenMentionTokens: ["your cousin", "engagement", "how long they dated"],
      forbiddenMentionFromTurn: 3,
      fencedMentions: [
        {
          fromTurn: 4,
          reason: "post_correction",
          tokens: ["made it official", "boyfriend", "girlfriend", "your partner"],
        },
      ],
      timeGrounding:
        "Turns after each gap open new calendar days and Daily Sessions; the day-1 exchange must not be referenced as recent.",
      checks: scenarioMemoryChecks(),
    },
  },
  {
    id: "memory-temporal-zh",
    category: "memory_temporal",
    languageVariant: "zh",
    description:
      "多日关系时间变化：第一天确定关系，第 20 天用户更正为朋友，第 21 天暖居邀请；检验更正后旧状态不复用。",
    turns: [
      { text: "我跟小林终于把关系定下来了，在一起了。" },
      { text: "才三周，不过相处起来挺自然的。" },
      {
        text: "跟你更正一下之前的话——我说快了。我和小林认真聊了一次，决定只做朋友，之前那不算是确定关系。",
        gapMs: 1555200000,
      },
      {
        text: "小林今晚喊我去他们暖居趴，你说我去不去合适？",
        gapMs: 86400000,
      },
    ],
    memoryFixture: {
      note: "第 20 天更正后的假设性 1A.3a 投影；合成材料。",
      injectedMemories: [
        {
          kind: "objective_memory",
          text: "用户与小林决定只做朋友；第一天「在一起了」的说法已被用户在第 20 天更正。",
          evidence: "第 20 天第 3 轮（更正）；原第一天第 1 轮",
        },
      ],
      expectedRecalls: [
        {
          atTurn: 3,
          semantic:
            "回应须承接更正、放下恋爱框架；更正后旧状态不复用，从第 4 轮起旧状态被围栏。",
        },
        {
          atTurn: 4,
          semantic:
            "回应以更正后的状态为落点——两人决定做朋友——绝不复活恋爱框架。",
          requiredTokens: ["朋友"],
        },
      ],
      forbiddenMentions: [
        "小林的任何亲属（从未提及）",
        "任何订婚或婚礼框架",
        "任何之前的交往史细节",
      ],
      forbiddenMentionTokens: ["你表妹", "订婚", "当时怎么在一起的"],
      forbiddenMentionFromTurn: 3,
      fencedMentions: [
        {
          fromTurn: 4,
          reason: "post_correction",
          tokens: ["在一起了", "确定关系", "男朋友", "女朋友", "你对象"],
        },
      ],
      timeGrounding:
        "每次 gap 之后都是新的本地日期和 Daily Session；第一天的交流不得被当作近期引用。",
      checks: scenarioMemoryChecks(),
    },
  },
  {
    id: "memory-temporal-mix",
    category: "memory_temporal",
    languageVariant: "code_switch",
    description:
      "code-switch 多日 post-Forget non-reuse：用户第 10 天要求忘掉跳槽话题，第 11 天攀岩话题开场；检验被围栏方向在问句与陈述两种形式下都不复活。",
    turns: [
      { text: "我最近在准备跳槽，偷偷面了几家，先别跟我爸妈提。" },
      { text: "手上已经有两个 offer 了，一家 startup 一家大厂，纠结中。" },
      {
        text: "跟你说个事，跳槽这个话题先忘掉吧，家里知道了不好看，细节你也都别再提了。",
        gapMs: 864000000,
      },
      {
        text: "周末去攀岩了，第一次爬 5.9，手都在抖。",
        gapMs: 86400000,
      },
    ],
    memoryFixture: {
      note: "第 10 天 Forget 之后的假设性 1A.3a 投影：跳槽相关 Claim 全部在围栏内，注入为零；合成材料。",
      injectedMemories: [],
      expectedRecalls: [
        {
          atTurn: 3,
          semantic:
            "The response confirms the forget naturally (no 删除-style wording — the journal stays, active recall stops); the job direction is closed from turn 4 onward in both question and statement forms.",
        },
        {
          atTurn: 4,
          semantic:
            "Post-Forget non-reuse: the response engages the climbing content only and shows no continuity with the fenced job direction — no mention and no progress question (deterministic fence via the fenced-mention tokens).",
        },
      ],
      forbiddenMentions: [
        "任何猎头或内推细节（从未提及）",
        "任何未出现过的公司或地址",
      ],
      forbiddenMentionTokens: ["猎头", "内推", "新公司地址"],
      forbiddenMentionFromTurn: 3,
      fencedMentions: [
        {
          fromTurn: 4,
          reason: "post_forget",
          tokens: ["offer", "跳槽", "startup", "大厂"],
        },
      ],
      timeGrounding:
        "每次 gap 之后都是新的本地日期和 Daily Session；被围栏话题的旧时间指向不得复活。",
      checks: scenarioMemoryChecks(),
    },
  },
];

async function main(): Promise<void> {
  const source = JSON.parse(await readFile(sourcePath, "utf8")) as ScenarioPack;

  const carried = source.scenarios.map((entry): ScenarioPackEntry => {
    const upgrade = continuityFixtureUpgrades[entry.id];
    return upgrade ? { ...entry, memoryFixture: upgrade } : entry;
  });

  const scenarios = [
    ...carried,
    ...newScenarios.map(
      (entry): ScenarioPackEntry => ({
        id: entry.id,
        category: entry.category,
        languageVariant: entry.languageVariant,
        locale:
          entry.languageVariant === "en"
            ? "en-US"
            : "zh-CN",
        timezone:
          entry.languageVariant === "en"
            ? "America/Los_Angeles"
            : "Asia/Shanghai",
        description: entry.description,
        turns: entry.turns,
        memoryFixture: entry.memoryFixture,
      }),
    ),
  ];

  const pack = {
    version: "scenario-pack:v3",
    generatedFrom:
      "scenario-pack:v2.1 (#61 pack + #63 additions + #77 fixtures) with #118 v3 memory fixtures and 9 new multi-day recall scenarios",
    syntheticNotice:
      "Every persona, name, event, and utterance in this file is fully fictional synthetic material authored for evaluation (issues #61, #63, #77, #118). No real private conversation is used or reproduced.",
    defaults: source.defaults,
    scenarios,
  };

  await writeFile(outPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");

  const byCategory = new Map<string, number>();
  for (const entry of pack.scenarios) {
    byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1);
  }
  console.log(`wrote ${outPath}: ${pack.scenarios.length} scenarios`);
  for (const [category, count] of [...byCategory].sort()) {
    console.log(`  ${category}: ${count}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
