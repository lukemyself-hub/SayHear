/**
 * PROTOTYPE — shared protocol types and helpers for the issue #94
 * recall-presentation comparison. Import-side-effect-free (the #62 lesson
 * from this branch: generate.ts runs model calls at import time, so every
 * shared symbol lives here instead).
 *
 * Protocol: the same memory-fixture scenarios run through four
 * recall-presentation arms; blind letters W/X/Y/Z are shuffled per scenario
 * by a seeded PRNG (#62 derivation); the rater annotates per turn, scores
 * each arm per dimension 1–5 (positive poles, never summed — ADR-0110), and
 * picks a scenario best before any unblinding. Mechanical candidate flags
 * surface at reveal only (alarm ≠ conviction).
 */

export const PROTOCOL_VERSION = "recall-presentation-blind:v1";
export const BLIND_SEED = 94;

/** Deterministic PRNG with the #62 derivation: scenario ordinal i uses seed + i * 7. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ArmKey = "portrait_only" | "portrait_retrieved" | "proactive" | "no_memory";
export const ARM_KEYS: readonly ArmKey[] = [
  "portrait_only",
  "portrait_retrieved",
  "proactive",
  "no_memory",
];
const ARM_LETTERS = ["W", "X", "Y", "Z"] as const;
export type ArmLetter = (typeof ARM_LETTERS)[number];

export function letterAssignmentForScenario(scenarioOrdinal: number): Record<ArmLetter, ArmKey> {
  const pool = [...ARM_KEYS];
  const draw = mulberry32(BLIND_SEED + scenarioOrdinal * 7);
  const assignment: Partial<Record<ArmLetter, ArmKey>> = {};
  for (const letter of ARM_LETTERS) {
    const index = Math.floor(draw() * pool.length) % pool.length;
    assignment[letter] = pool.splice(index, 1)[0]!;
  }
  return assignment as Record<ArmLetter, ArmKey>;
}

export function countQuestions(text: string): number {
  return [...text.matchAll(/[?？]/g)].length;
}

const TIME_GROUNDING_FLAGS: Readonly<Record<string, readonly string[]>> = {
  en: ["tonight", "last night", "yesterday evening", "tomorrow"],
  zh: ["今晚", "昨晚", "昨天晚", "昨夜", "明天"],
};

const RECALL_PHRASE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  en: ["i remember", "you mentioned", "you told me", "you said", "i've been thinking", "i know you"],
  zh: ["我记得", "你说过", "你之前说", "你提过", "我一直想", "我想着"],
};

const MEMORY_TOPIC_TOKENS: Readonly<Record<string, readonly string[]>> = {
  en: ["biopsy", "results", "follow-up", "waited", "waiting", "two weeks"],
  zh: ["活检", "结果", "复诊", "等了", "两周", "瞎想"],
};

function flagHits(text: string, tokens: readonly string[]): readonly string[] {
  const lower = text.toLowerCase();
  return tokens.filter((token) => lower.includes(token.toLowerCase()));
}

function languageKey(languageVariant: string): "en" | "zh" {
  return languageVariant === "en" ? "en" : "zh";
}

function combinedTokens(
  table: Readonly<Record<string, readonly string[]>>,
  languageVariant: string,
): readonly string[] {
  return languageVariant === "code_switch"
    ? [...table.en!, ...table.zh!]
    : table[languageKey(languageVariant)]!;
}

export type MechanicalFlags = Readonly<{
  questionCount: number;
  charCount: number;
  forbiddenTokenHits: readonly string[];
  timeGroundingFlags: readonly string[];
  recallPhraseFlags: readonly string[];
  memoryTopicTokens: readonly string[];
}>;

export function mechanicalFlags(input: {
  text: string;
  languageVariant: string;
  forbiddenMentionTokens: readonly string[];
  day2: boolean;
}): MechanicalFlags {
  return {
    charCount: [...input.text].length,
    forbiddenTokenHits: input.day2
      ? flagHits(input.text, input.forbiddenMentionTokens)
      : [],
    memoryTopicTokens: input.day2
      ? flagHits(input.text, combinedTokens(MEMORY_TOPIC_TOKENS, input.languageVariant))
      : [],
    questionCount: countQuestions(input.text),
    recallPhraseFlags: input.day2
      ? flagHits(input.text, combinedTokens(RECALL_PHRASE_FLAGS, input.languageVariant))
      : [],
    timeGroundingFlags: input.day2
      ? flagHits(input.text, combinedTokens(TIME_GROUNDING_FLAGS, input.languageVariant))
      : [],
  };
}

/** Per-dimension 1–5 scales, positive poles, never summed (ADR-0110). */
export const DIMENSIONS: readonly Readonly<{
  key: string;
  label: string;
  high: string;
  low: string;
}>[] = [
  {
    key: "accuracy",
    label: "准确",
    high: "5 = 完全忠于给过的信息,归因清楚(谁说的 vs AI 的理解),无编造、无越界细节",
    low: "1 = 编造未提及的细节、张冠李戴、或把 AI 的推断当成用户说过的事实",
  },
  {
    key: "naturalness",
    label: "自然",
    high: "5 = 像认识你的人顺口带出,记忆织在回应里,语言节奏与场景一致",
    low: "1 = 档案腔、技术仪式(「我记得你…」式播报)、生硬背诵、翻译腔",
  },
  {
    key: "restraint",
    label: "克制",
    high: "5 = 记忆用量有分寸,不查岗、不监督、不给汇报压力,没有监控感",
    low: "1 = 查岗式问进度、硬塞记住的事、制造必须回应的压力",
  },
  {
    key: "continuity",
    label: "连续",
    high: "5 = 该记起的时刻稳稳接住:t3 可自然承接挂念,t4 的好消息带着等待的分量被接住",
    low: "1 = 完全像初次见面,该承接的时刻接不住",
  },
];
