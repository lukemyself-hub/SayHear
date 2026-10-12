/**
 * PROTOTYPE ONLY (SPEC #301 response-structure comparison). Throwaway code on
 * the branch `prototype/spec-301-response-structure`; never merge.
 *
 * Everything here is inert unless `SAYHEAR_PROTOTYPE_STRUCTURE` is 2 or 3:
 *   2 = retrieval front-loaded: code picks the lookup, one model call.
 *   3 = small loop: the model may call the history lookup up to 3 times and
 *       sees each result as a tool result in the same model conversation.
 * See eval/continuity-acceptance-301/prototype-response-structure/README.md.
 */
import { appendFileSync } from "node:fs";

import type { HistoryContinuationBasis } from "./history-recall";
import {
  HISTORY_READING_RULES_VERSION,
  HISTORY_RECALL_DEFAULT_POLICY,
  normalizeHistoryReviewCall,
  renderHistoryRecallReceipt,
  resolveHistoryQueryPlan,
  selectHistoryRecall,
  type HistoryQueryProposal,
  type HistoryRecallDecisionFacts,
  type HistoryRecallItemRef,
  type HistoryRecallRepository,
  type HistoryRecallResult,
  type HistoryRecallSourcePort,
  type HistoryRecallSourceSnapshot,
} from "./history-recall";
import {
  runExperienceSearch,
  type ExperienceSearchSourcePort,
} from "./history-experience-search";
import { localDateOf, shiftLocalDate } from "./recent-context";

export type PrototypeStructure = 0 | 1 | 2 | 3;

export function prototypeStructure(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PrototypeStructure {
  const raw = environment["SAYHEAR_PROTOTYPE_STRUCTURE"];
  return raw === "1" ? 1 : raw === "2" ? 2 : raw === "3" ? 3 : 0;
}

export const PROTOTYPE_MAX_TOOL_STEPS = 3;

export type PrototypeLookupContext = Readonly<{
  generationCommandId: string;
  requestEventRevisionId: string;
  userId: string;
}>;

export type PrototypeItemRow = Readonly<{
  actor: "user" | "assistant";
  correctedAt: string | null;
  expressedAt: string;
  expressionTimezone: string | null;
  group: number | null;
  role: string | null;
  text: string;
}>;

export type PrototypeHistoryTools = Readonly<{
  /** Group 2: the text block to add to the single model call, or null. */
  frontload(context: PrototypeLookupContext): Promise<string | null>;
  /** Group 3: run one model-proposed lookup and return the tool result text. */
  runToolCall(context: PrototypeLookupContext, rawArguments: string): Promise<string>;
}>;

const REGISTRY_KEY = "__sayhearPrototypeHistoryTools";

export function registerPrototypeHistoryTools(tools: PrototypeHistoryTools): void {
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = tools;
}

export function prototypeHistoryTools(): PrototypeHistoryTools | null {
  return ((globalThis as Record<string, unknown>)[REGISTRY_KEY] as PrototypeHistoryTools | undefined) ?? null;
}

function log(record: Record<string, unknown>): void {
  const file = process.env["SAYHEAR_PROTOTYPE_LOG"];
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  } catch {
    // A log line never changes the turn.
  }
}

function formatLocalMinute(iso: string, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
    }).formatToParts(new Date(iso));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("weekday")} ${get("hour")}:${get("minute")}`;
  } catch {
    return iso;
  }
}

// --- Group 2: deterministic date and clue-word selection -------------------

const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function toNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  if (raw in words) return words[raw]!;
  const chars = [...raw];
  if (chars.length === 1) return raw === "十" ? 10 : (CN_DIGITS[raw] ?? null);
  const tenAt = chars.indexOf("十");
  if (tenAt === -1) return null;
  const tens = tenAt === 0 ? 1 : (CN_DIGITS[chars[0]!] ?? null);
  const ones = tenAt === chars.length - 1 ? 0 : (CN_DIGITS[chars[tenAt + 1]!] ?? null);
  return tens === null || ones === null ? null : tens * 10 + ones;
}

const NUM = "(\\d{1,2}|[一二三四五六七八九十]{1,3})";
const WEEKDAY_ZH: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };
const WEEKDAY_EN = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTH_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function mondayIndex(localDate: string): number {
  return (new Date(`${localDate}T00:00:00Z`).getUTCDay() + 6) % 7;
}

function ymd(year: number, month: number, day: number): string | null {
  const text = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.getUTCDate() !== day || date.getUTCMonth() + 1 !== month ? null : text;
}

/** The past local date(s) the text names, or null. Deterministic, zh + en. */
export function prototypeParseDates(
  text: string,
  today: string,
): { endDate: string; experienced: boolean; startDate: string } | null {
  const lower = text.normalize("NFKC").toLowerCase();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const thisMonday = shiftLocalDate(today, -mondayIndex(today));
  const single = (date: string | null) => (date === null ? null : { end: date, start: date });
  const mostRecentWeekday = (index: number) => {
    let back = (mondayIndex(today) - index + 7) % 7;
    if (back === 0) back = 7;
    return shiftLocalDate(today, -back);
  };
  let found: { end: string; start: string } | null = null;
  let match: RegExpExecArray | null;
  if ((match = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(lower))) {
    found = single(ymd(Number(match[1]), Number(match[2]), Number(match[3])));
  } else if ((match = new RegExp(`${NUM}月${NUM}[日号]?`).exec(lower))) {
    const m = toNumber(match[1]!);
    const d = toNumber(match[2]!);
    if (m !== null && d !== null) {
      const thisYear = ymd(year, m, d);
      found = single(thisYear !== null && thisYear > today ? ymd(year - 1, m, d) : thisYear);
    }
  } else if ((match = new RegExp(`(?:^|[^月\\d一二三四五六七八九十])${NUM}[号日](?!子)`).exec(lower))) {
    const d = toNumber(match[1]!);
    if (d !== null) {
      const thisMonth = ymd(year, month, d);
      found = single(
        thisMonth !== null && thisMonth > today
          ? month === 1 ? ymd(year - 1, 12, d) : ymd(year, month - 1, d)
          : thisMonth,
      );
    }
  } else if (/大前天/.test(lower)) found = single(shiftLocalDate(today, -3));
  else if (/前天|day before yesterday/.test(lower)) found = single(shiftLocalDate(today, -2));
  else if (/昨天|昨晚|昨日|yesterday|last night/.test(lower)) found = single(shiftLocalDate(today, -1));
  else if ((match = /(\d+|[一二两三四五六七八九十]+)\s*天(?:之|以)?前/.exec(lower)) || (match = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten) days? ago/.exec(lower))) {
    const n = toNumber(match[1]!);
    if (n !== null && n > 0 && n < 400) found = single(shiftLocalDate(today, -n));
  } else if ((match = /上(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(lower))) {
    found = single(shiftLocalDate(thisMonday, -7 + WEEKDAY_ZH[match[1]!]!));
  } else if (/上(?:个)?(?:周|星期|礼拜)|last week/.test(lower)) {
    found = { end: shiftLocalDate(thisMonday, -1), start: shiftLocalDate(thisMonday, -7) };
  } else if ((match = /这(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(lower))) {
    found = single(shiftLocalDate(thisMonday, WEEKDAY_ZH[match[1]!]!));
  } else if ((match = new RegExp(`(?:last|this past) (${WEEKDAY_EN.join("|")})`).exec(lower))) {
    found = single(mostRecentWeekday(WEEKDAY_EN.indexOf(match[1]!)));
  } else if ((match = new RegExp(`(${MONTH_EN.join("|")}) (\\d{1,2})(?:st|nd|rd|th)?`).exec(lower)) || (match = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)? (?:of )?(${MONTH_EN.join("|")})`).exec(lower))) {
    const monthFirst = Number.isNaN(Number(match[1]));
    const m = MONTH_EN.indexOf(monthFirst ? match[1]! : match[2]!) + 1;
    const d = Number(monthFirst ? match[2] : match[1]);
    const thisYear = ymd(year, m, d);
    found = single(thisYear !== null && thisYear > today ? ymd(year - 1, m, d) : thisYear);
  } else if ((match = /the (\d{1,2})(?:st|nd|rd|th)/.exec(lower))) {
    const thisMonth = ymd(year, month, Number(match[1]));
    found = single(
      thisMonth !== null && thisMonth > today
        ? month === 1 ? ymd(year - 1, 12, Number(match[1])) : ymd(year, month - 1, Number(match[1]))
        : thisMonth,
    );
  }
  if (found === null || found.end >= today || found.start > found.end) return null;
  return {
    endDate: found.end,
    experienced: /发生|做了什么|干了什么|干嘛|happen|what did i do/.test(lower),
    startDate: found.start,
  };
}

const EN_STOP = new Set(
  "the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what about after again could every first found great other right their there these thing think those under where which while would write wrote written back finally really still going got get went been being into then also even ever never always maybe today tonight tomorrow yesterday week weeks days month year last next guess feel feels felt told tell said says saying something anything nothing everything someone anyone thought because though through should doing done does didn don isn wasn aren won can't don't didn't it's i'm i've i'll that's there's what's let's again okay yeah yes hello thanks thank little bit kind sort actually pretty quite lot lots keep kept made makes need needs sure mean means remember mention mentioned talked talk talking earlier before ago ever own kept spent home there got".split(/\s+/),
);

const ZH_STOP_WORDS = [
  "我们", "你们", "他们", "她们", "它们", "这个", "那个", "什么", "怎么", "为什么", "因为", "所以", "但是", "可是", "还是", "就是", "不是", "没有", "已经", "终于", "刚刚", "刚才", "现在", "今天", "昨天", "明天", "前天", "时候", "觉得", "知道", "可以", "一下", "一个", "一些", "这样", "那样", "真的", "有点", "一直", "然后", "还有", "或者", "如果", "虽然", "不过", "其实", "可能", "应该", "需要", "想要", "自己", "事情", "东西", "的话", "起来", "出来", "一起", "说过", "提过", "聊过", "讲过", "告诉", "记得", "是不是", "有没有", "上次", "之前", "以前", "后来", "最近", "这次", "那次", "一次", "第一次", "怎么样", "这么", "那么", "多少", "哪里", "一点", "有些", "非常", "特别", "突然", "感觉", "好像", "今晚", "早上", "晚上", "下午", "上午", "中午",
];
const ZH_STOP_CHARS = /[的了吗呢吧啊呀哦嗯呗嘛我你他她它们是在和也都就很这那]/g;

/** Candidate clue words of one text: ASCII words and CJK 2-4 character pieces. */
export function prototypeCandidateTerms(text: string): string[] {
  const norm = text.normalize("NFKC").toLowerCase();
  const out = new Set<string>();
  for (const word of norm.match(/[a-z][a-z0-9'+#-]{2,}/g) ?? []) {
    if (!EN_STOP.has(word) && word.length <= 32) out.add(word);
  }
  for (const run of norm.match(/[一-鿿]+/g) ?? []) {
    let cleaned = run;
    for (const stop of ZH_STOP_WORDS) cleaned = cleaned.split(stop).join(" ");
    cleaned = cleaned.replace(ZH_STOP_CHARS, " ");
    for (const segment of cleaned.split(/\s+/)) {
      const chars = [...segment];
      if (chars.length >= 2 && chars.length <= 4) out.add(segment);
      for (const size of [2, 3]) {
        for (let index = 0; index + size <= chars.length; index += 1) {
          out.add(chars.slice(index, index + size).join(""));
        }
      }
    }
  }
  return [...out];
}

const MAX_FRONTLOAD_TERMS = 6;

/** Rarest-first clue words that occur at least once in the older messages. */
function chooseTerms(candidates: readonly string[], frequency: { df: Record<string, number>; total: number }): string[] {
  const ceiling = Math.max(5, Math.ceil(frequency.total * 0.3));
  const usable = candidates
    .map((term) => ({ df: frequency.df[term] ?? 0, term }))
    .filter((entry) => entry.df >= 1 && entry.df <= ceiling)
    .sort((a, b) => a.df - b.df || [...b.term].length - [...a.term].length || a.term.localeCompare(b.term));
  const chosen: string[] = [];
  for (const entry of usable) {
    if (chosen.some((kept) => kept.includes(entry.term) || entry.term.includes(kept))) continue;
    chosen.push(entry.term);
    if (chosen.length === MAX_FRONTLOAD_TERMS) break;
  }
  return chosen;
}

// --- Group 3: tolerant reading of a model-proposed lookup -------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function tolerantProposal(rawArguments: string):
  | { notes: string[]; proposal: HistoryQueryProposal }
  | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return { error: "the arguments were not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "the arguments were not an object" };
  }
  const raw = parsed as Record<string, unknown>;
  const notes: string[] = [];
  const cleaned: Record<string, unknown> = {};
  const strings = (value: unknown, max: number, name: string): string[] | undefined => {
    if (value === undefined) return undefined;
    const list = (Array.isArray(value) ? value : [value])
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => [...entry].length >= 2 && [...entry].length <= 32);
    if (!Array.isArray(value) || list.length !== value.length) notes.push(`some ${name} entries were unusable and were left out`);
    if (list.length > max) notes.push(`only the first ${max} ${name} were used`);
    return list.slice(0, max);
  };
  for (const key of Object.keys(raw)) {
    if (!["continuation_basis", "end_date", "people", "search_terms", "source_scope", "start_date", "time_basis"].includes(key)) {
      notes.push(`unknown field ${key.slice(0, 24)} was ignored`);
    }
  }
  const start = typeof raw["start_date"] === "string" && DATE.test(raw["start_date"]) ? raw["start_date"] : undefined;
  const end = typeof raw["end_date"] === "string" && DATE.test(raw["end_date"]) ? raw["end_date"] : undefined;
  if (raw["start_date"] !== undefined && start === undefined) notes.push("start_date was not YYYY-MM-DD and was ignored");
  if (raw["end_date"] !== undefined && (end === undefined || start === undefined)) notes.push("end_date was ignored");
  if (start !== undefined) {
    cleaned["start_date"] = start;
    if (end !== undefined) cleaned["end_date"] = end;
  }
  const terms = strings(raw["search_terms"], 6, "search_terms");
  if (terms !== undefined && terms.length > 0) {
    cleaned["search_terms"] = terms;
    const people = strings(raw["people"], 3, "people");
    if (people !== undefined && people.length > 0) cleaned["people"] = people;
    if (Array.isArray(raw["continuation_basis"])) {
      const basis = raw["continuation_basis"].filter((entry) => ["current_input", "adjacent_user", "dialogue_state"].includes(entry as string));
      if (basis.length > 0) cleaned["continuation_basis"] = basis;
    }
  } else {
    if (terms !== undefined) notes.push("no usable search_terms (each needs at least 2 characters)");
    if (raw["time_basis"] === "experienced_date") cleaned["time_basis"] = "experienced_date";
  }
  const normalized = normalizeHistoryReviewCall({ rawArguments: JSON.stringify(cleaned) });
  if ("invalid" in normalized) {
    return {
      error: `${notes.join("; ") || "the arguments could not be used"}. Give either start_date (YYYY-MM-DD, optionally end_date) or 2 to 5 search_terms of at least 2 characters each`,
    };
  }
  return { notes, proposal: normalized.proposal };
}

export function createPrototypeHistoryTools(dependencies: {
  experienceSource: ExperienceSearchSourcePort;
  loadItems(userId: string, itemRefs: readonly HistoryRecallItemRef[]): Promise<readonly PrototypeItemRow[]>;
  repository: Pick<HistoryRecallRepository, "loadDecisionFacts">;
  source: HistoryRecallSourcePort;
  termFrequencies(input: { before: Date; terms: readonly string[]; userId: string }): Promise<{ df: Record<string, number>; total: number }>;
}): PrototypeHistoryTools {
  const policy = HISTORY_RECALL_DEFAULT_POLICY;

  async function facts(context: PrototypeLookupContext): Promise<HistoryRecallDecisionFacts | null> {
    return dependencies.repository.loadDecisionFacts({
      decisionCommandId: context.generationCommandId as never,
      userId: context.userId as never,
    });
  }

  async function lookup(
    context: PrototypeLookupContext,
    decision: HistoryRecallDecisionFacts,
    proposal: HistoryQueryProposal,
  ): Promise<{ result: HistoryRecallResult; rows: readonly PrototypeItemRow[] }> {
    const timezone = decision.requestTimezone ?? decision.sessionTimezone;
    let result: HistoryRecallResult;
    if (proposal.kind === "search_experience") {
      result = await runExperienceSearch({
        currentDailySessionId: decision.dailySessionId,
        cutoff: decision.cutoff,
        expectedDataEpoch: decision.expectedDataEpoch,
        policy,
        proposal,
        requestRevisionId: context.requestEventRevisionId as never,
        signals: decision.signals,
        source: dependencies.experienceSource,
        timezone,
        userId: context.userId as never,
      });
    } else {
      const resolved = resolveHistoryQueryPlan({ cutoff: decision.cutoff, policy, proposal, timezone });
      if (!resolved.ok) {
        return {
          result: { coverage: {} as never, failureCode: resolved.code, itemRefs: [], plan: null, proposal, status: "failed" },
          rows: [],
        };
      }
      let snapshot: HistoryRecallSourceSnapshot;
      try {
        snapshot = await dependencies.source.readHistoryRange({
          budgets: { maxPages: policy.maxPages, maxSourceRows: policy.maxSourceRows, pageSize: policy.pageSize, readTimeoutMs: policy.readTimeoutMs },
          expectedDataEpoch: decision.expectedDataEpoch,
          plan: resolved.plan,
          requestRevisionId: context.requestEventRevisionId as never,
          userId: context.userId as never,
        });
      } catch {
        snapshot = { currentConversationRows: 0, enumerationComplete: false, failure: { code: "source_read_threw" }, items: [], pages: 0, readLatencyMs: 0 };
      }
      result = selectHistoryRecall({ plan: resolved.plan, policy, proposal, snapshot });
    }
    const rows = result.itemRefs.length > 0 ? await dependencies.loadItems(context.userId, result.itemRefs) : [];
    return { result, rows };
  }

  function render(result: HistoryRecallResult, rows: readonly PrototypeItemRow[], fallbackTimezone: string | null): string {
    if (result.plan === null && result.proposal.kind === "review_dates") {
      return `The lookup could not be planned (${result.failureCode ?? "unknown"}). No messages were read. Say you could not look it up right now, or call it again with a valid past date.`;
    }
    const receipt = renderHistoryRecallReceipt({
      corrections: rows.flatMap((row, index) =>
        row.correctedAt ? [{ correctedAt: row.correctedAt, messageIndex: index + 1, timezone: row.expressionTimezone }] : [],
      ) as never,
      droppedAtCompile: 0,
      injectedRows: rows.length,
      policyVersion: policy.version,
      readingRulesVersion: HISTORY_READING_RULES_VERSION,
      result,
      version: 1,
    })
      .split("that appear in the conversation before the user's current message (each has its own time in the Times list)")
      .join("quoted below under 'Quoted earlier messages' (each line starts with when it was said)");
    const quoted = rows.map(
      (row, index) =>
        `${index + 1}. [${formatLocalMinute(row.expressedAt, row.expressionTimezone ?? fallbackTimezone ?? "UTC")} ${row.expressionTimezone ?? fallbackTimezone ?? "UTC"}]${row.group === null ? "" : ` (occasion ${row.group})`} ${row.actor === "user" ? "user" : "assistant (your earlier reply)"}: ${row.text}`,
    );
    return [
      receipt,
      rows.length > 0 ? "Quoted earlier messages (oldest first):" : "No earlier messages are quoted.",
      ...quoted,
    ].join("\n");
  }

  return {
    async runToolCall(context, rawArguments) {
      const decision = await facts(context);
      if (decision === null) {
        log({ group: 3, kind: "tool", outcome: "no_decision_facts" });
        return "The lookup is not available for this turn. Reply without it and do not guess what was said earlier.";
      }
      const tolerant = tolerantProposal(rawArguments);
      if ("error" in tolerant) {
        log({ error: tolerant.error, group: 3, kind: "tool", outcome: "argument_error", rawArguments });
        return `The lookup did not run: ${tolerant.error}. You may call it again with corrected arguments, or reply without it (then do not guess what was said earlier).`;
      }
      const { result, rows } = await lookup(context, decision, tolerant.proposal);
      log({
        failureCode: result.failureCode,
        group: 3,
        kind: "tool",
        notes: tolerant.notes,
        outcome: result.status,
        proposal: tolerant.proposal,
        rawArguments,
        rows: rows.length,
      });
      return [
        ...(tolerant.notes.length > 0 ? [`Note on the arguments: ${tolerant.notes.join("; ")}.`] : []),
        render(result, rows, decision.requestTimezone ?? decision.sessionTimezone),
      ].join("\n");
    },

    async frontload(context) {
      const decision = await facts(context);
      if (decision === null) {
        log({ group: 2, kind: "frontload", outcome: "no_decision_facts" });
        return null;
      }
      const timezone = decision.requestTimezone ?? decision.sessionTimezone;
      if (timezone === null) {
        log({ group: 2, kind: "frontload", outcome: "no_timezone" });
        return null;
      }
      const today = localDateOf(decision.cutoff, timezone);
      const signals = decision.signals;
      const dates = prototypeParseDates(signals.currentInputText, today);
      let proposal: HistoryQueryProposal;
      let how: string;
      if (dates !== null) {
        proposal = {
          endDate: dates.endDate,
          kind: "review_dates",
          sourceScope: "conversation_text",
          startDate: dates.startDate,
          timeBasis: dates.experienced ? "experienced_date" : "expressed_date",
        };
        how = "date";
      } else {
        const before = new Date(decision.cutoff.getTime() - 7 * 24 * 60 * 60 * 1000);
        const tiers: { basis: HistoryContinuationBasis[]; candidates: string[]; name: string }[] = [
          { basis: ["current_input"], candidates: prototypeCandidateTerms(signals.currentInputText), name: "current_input" },
          {
            basis: ["adjacent_user", ...(signals.dialogueState?.topic ? (["dialogue_state"] as const) : [])],
            candidates: prototypeCandidateTerms(
              [...signals.adjacentUserTexts.slice(0, 3), signals.dialogueState?.topic ?? ""].join("\n"),
            ),
            name: "recent_user_and_dialogue_state",
          },
        ];
        let terms: string[] = [];
        let tier: (typeof tiers)[number] | null = null;
        for (const candidate of tiers) {
          if (candidate.candidates.length === 0) continue;
          const frequency = await dependencies.termFrequencies({ before, terms: candidate.candidates, userId: context.userId });
          terms = chooseTerms(candidate.candidates, frequency);
          if (terms.length > 0) {
            tier = candidate;
            break;
          }
        }
        if (tier === null) {
          log({ group: 2, input: signals.currentInputText, kind: "frontload", outcome: "no_clue_words" });
          return null;
        }
        const endDate = shiftLocalDate(today, -7);
        proposal = {
          continuation: { basis: tier.basis },
          endDate,
          kind: "search_experience",
          people: [],
          sourceScope: "conversation_text",
          startDate: shiftLocalDate(endDate, -(policy.search.maxSpanDays - 1)),
          terms,
          timeBasis: "expressed_date",
        };
        how = `words:${tier.name}`;
      }
      const { result, rows } = await lookup(context, decision, proposal);
      log({ failureCode: result.failureCode, group: 2, how, input: signals.currentInputText, kind: "frontload", outcome: result.status, proposal, rows: rows.length });
      if (proposal.kind === "search_experience" && rows.length === 0) return null;
      return [
        "## Earlier messages brought in for this turn",
        proposal.kind === "review_dates"
          ? "Before this reply, the person's own saved messages for the past date(s) their current message names were read. They did not see this happen."
          : "Before this reply, the person's own saved messages from more than seven days ago were looked through using words from the current talk. They did not ask for this and did not see it happen; it may or may not bear on what they just said. If it does not, reply as you normally would and do not mention it.",
        render(result, rows, timezone),
      ].join("\n");
    },
  };
}
