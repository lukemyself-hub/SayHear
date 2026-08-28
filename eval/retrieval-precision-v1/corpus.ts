import { PREDICATE_IDS } from "@sayhear/application";

/**
 * Retrieval-precision accounting corpus (issue #125, SPEC #107 AC 38).
 *
 * A fully synthetic multi-day conversation corpus — 10 natural days × 2
 * sessions × 12 turns — with planted Memory Claims (objective statements,
 * people, relationships + temporal change, impressions), at least as many
 * planted distractor claims, fixed seed, en / zh / mix allocation, and
 * cross-day queries. The corpus is pure data: the harness plants it through
 * production write paths and then exercises the same production retrieval
 * functions with the planted-claim ground truth (SPEC "Testing Decisions":
 * one new eval-side harness following the pack-runner pattern).
 *
 * All content is invented (no real private conversation content anywhere).
 * Query texts are authored against the Predicate Registry v1 published
 * lexical surfaces so they exercise the deterministic query construction
 * honestly; `tests/retrieval-precision-corpus.test.ts` proves every probe
 * query against the real `buildRetrievalQuery` before any database is hit.
 */

export const RETRIEVAL_PRECISION_CORPUS_VERSION = "retrieval-precision-corpus:v1";

/** Fixed seed — the corpus must be byte-identical on every rebuild. */
export const RETRIEVAL_PRECISION_CORPUS_SEED = 20260828;

export const CORPUS_DAYS = 10;
export const CORPUS_SESSIONS_PER_DAY = 2;
export const CORPUS_TURNS_PER_SESSION = 12;

/** Account timezone; mornings 09:00, evenings 20:30 local (China Standard Time). */
export const CORPUS_TIMEZONE = "Asia/Shanghai";

/** First corpus morning as UTC (09:00 China Standard Time). */
export const CORPUS_BASE_TIME_UTC = "2026-09-01T01:00:00.000Z";

export const SYNTHETIC_NOTICE =
  "Fully synthetic corpus: every person, employer, city and utterance below is invented for evaluation. No real private conversation content.";

export type CorpusLocale = "zh" | "en" | "mix";

export type PersonRole = "probe" | "distractor";

export type PlantedPerson = Readonly<{
  personId: string;
  /** Current primary label (zh for Chinese-named persons, en otherwise). */
  primaryLabel: string;
  primaryLocale: "zh" | "en";
  /** Optional verified alias in the other language (bilingual resolution). */
  alias?: Readonly<{ label: string; locale: "zh" | "en" }>;
  role: PersonRole;
}>;

export type ClaimCategory =
  | "objective_fact"
  | "relationship"
  | "impression"
  | "distractor";

export type PlantedClaimSpec = Readonly<{
  claimId: string;
  category: ClaimCategory;
  kind: "objective" | "impression";
  predicateId: string;
  /** Self-fact typed value (enum value id or free text). */
  typedValue?: string | readonly string[];
  /** Object person for relationship claims. */
  personId?: string;
  /** Relationship temporal state to state (default current). */
  temporalStatus?: "current" | "ended";
  /**
   * The statement turn that carries this claim's evidence (objective claims:
   * exactly one; the turn must precede any probe of the claim).
   */
  statementTurnId?: string;
  /**
   * Impression claims admit only after the cross-session floor (ADR-0039):
   * two evidence turns on two different days. Admission runs after the last
   * evidence turn.
   */
  evidenceTurnIds?: readonly string[];
  /** Fence probe: a later turn forgets the whole claim (ADR-0035). */
  forgottenOnTurnId?: string;
  /** Informational: the statement supersedes this claim's current version. */
  supersedesClaimId?: string;
}>;

export type QueryPhase = "main" | "post_forget" | "post_dormancy";

export type QuerySpec = Readonly<{
  queryId: string;
  text: string;
  locale: CorpusLocale;
  phase: QueryPhase;
  /**
   * Planted claim ids this query deliberately probes (ground truth). Empty
   * for fence probes, where the fenced claim ids below must stay out.
   */
  expectedClaimIds: readonly string[];
  /** Fence probes: these claims are fenced before this query and must not inject. */
  fencedClaimIds?: readonly string[];
}>;

export type TurnRole = "statement" | "query" | "filler" | "forget";

export type CorpusTurnSpec = Readonly<{
  turnId: string;
  day: number;
  session: 0 | 1;
  /** Ordering within the session (0-based); gaps are allowed. */
  slot: number;
  locale: CorpusLocale;
  text: string;
  role: TurnRole;
  query?: QuerySpec;
  /** Claims whose statement/evidence lives on this turn. */
  claimIds?: readonly string[];
  /** Claims this forget turn fences. */
  forgetClaimIds?: readonly string[];
}>;

export type PrecisionCorpus = Readonly<{
  version: string;
  seed: number;
  syntheticNotice: string;
  days: number;
  sessionsPerDay: number;
  turnsPerSession: number;
  timezone: string;
  baseTimeUtc: string;
  people: readonly PlantedPerson[];
  claims: readonly PlantedClaimSpec[];
  /** Ordered by (day, session, slot). */
  turns: readonly CorpusTurnSpec[];
}>;

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic across platforms; only filler
// selection is random, all load-bearing content is authored explicitly.
// ---------------------------------------------------------------------------

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Authored content pools.
// ---------------------------------------------------------------------------

const PEOPLE: readonly PlantedPerson[] = [
  // Probe persons — each is the target of at least one planted relationship.
  { personId: "wang", primaryLabel: "小王", primaryLocale: "zh", alias: { label: "Wang", locale: "en" }, role: "probe" },
  { personId: "lin", primaryLabel: "小林", primaryLocale: "zh", alias: { label: "Lin", locale: "en" }, role: "probe" },
  { personId: "zhe", primaryLabel: "阿哲", primaryLocale: "zh", role: "probe" },
  { personId: "yu", primaryLabel: "小雨", primaryLocale: "zh", alias: { label: "Yu", locale: "en" }, role: "probe" },
  { personId: "mike", primaryLabel: "Mike", primaryLocale: "en", alias: { label: "麦克", locale: "zh" }, role: "probe" },
  { personId: "david", primaryLabel: "David", primaryLocale: "en", role: "probe" },
  { personId: "chen", primaryLabel: "老陈", primaryLocale: "zh", alias: { label: "Chen", locale: "en" }, role: "probe" },
  { personId: "fang", primaryLabel: "小芳", primaryLocale: "zh", role: "probe" },
  { personId: "zhou", primaryLabel: "老周", primaryLocale: "zh", role: "probe" },
  { personId: "nana", primaryLabel: "娜娜", primaryLocale: "zh", role: "probe" },
  { personId: "kai", primaryLabel: "阿凯", primaryLocale: "zh", role: "probe" },
  { personId: "hui", primaryLabel: "小惠", primaryLocale: "zh", role: "probe" },
  { personId: "elena", primaryLabel: "Elena", primaryLocale: "en", role: "probe" },
  { personId: "song", primaryLabel: "老宋", primaryLocale: "zh", role: "probe" },
  { personId: "he", primaryLabel: "小何", primaryLocale: "zh", role: "probe" },
  // Distractor persons — planted claims about them must never be probed.
  { personId: "wang2", primaryLabel: "小汪", primaryLocale: "zh", role: "distractor" },
  { personId: "lin2", primaryLabel: "小琳", primaryLocale: "zh", role: "distractor" },
  { personId: "kang", primaryLabel: "阿康", primaryLocale: "zh", role: "distractor" },
  { personId: "xu", primaryLabel: "小许", primaryLocale: "zh", role: "distractor" },
  { personId: "gao", primaryLabel: "老高", primaryLocale: "zh", role: "distractor" },
  { personId: "jiang", primaryLabel: "小蒋", primaryLocale: "zh", role: "distractor" },
  { personId: "fu", primaryLabel: "阿福", primaryLocale: "zh", role: "distractor" },
  { personId: "qian", primaryLabel: "小倩", primaryLocale: "zh", role: "distractor" },
  { personId: "duan", primaryLabel: "老段", primaryLocale: "zh", role: "distractor" },
  { personId: "mo", primaryLabel: "小莫", primaryLocale: "zh", role: "distractor" },
  { personId: "david2", primaryLabel: "大伟", primaryLocale: "zh", role: "distractor" },
  { personId: "fei", primaryLabel: "老费", primaryLocale: "zh", role: "distractor" },
  { personId: "qin", primaryLabel: "小覃", primaryLocale: "zh", role: "distractor" },
  { personId: "lun", primaryLabel: "阿仑", primaryLocale: "zh", role: "distractor" },
  { personId: "bei", primaryLabel: "阿北", primaryLocale: "zh", role: "distractor" },
  { personId: "zhu", primaryLabel: "小竹", primaryLocale: "zh", role: "distractor" },
  { personId: "gong", primaryLabel: "老龚", primaryLocale: "zh", role: "distractor" },
  { personId: "ruan", primaryLabel: "小阮", primaryLocale: "zh", role: "distractor" },
  { personId: "shao", primaryLabel: "小邵", primaryLocale: "zh", role: "distractor" },
  { personId: "yan", primaryLabel: "老闫", primaryLocale: "zh", role: "distractor" },
  { personId: "cen", primaryLabel: "阿岑", primaryLocale: "zh", role: "distractor" },
  { personId: "liu2", primaryLabel: "小柳", primaryLocale: "zh", role: "distractor" },
  { personId: "guan", primaryLabel: "小关", primaryLocale: "zh", role: "distractor" },
  { personId: "chu", primaryLabel: "老褚", primaryLocale: "zh", role: "distractor" },
  { personId: "xun", primaryLabel: "小荀", primaryLocale: "zh", role: "distractor" },
  { personId: "man", primaryLabel: "阿曼", primaryLocale: "zh", role: "distractor" },
  { personId: "qi", primaryLabel: "小戚", primaryLocale: "zh", role: "distractor" },
];

/**
 * Filler pool — neutral small talk with no registry alias surface, no person
 * label and no time word, so filler turns never add query signals (proven by
 * the unit tests against the real query construction).
 */
const FILLERS_ZH: readonly string[] = [
  "今天地铁上人好多，站了一路。",
  "中午吃了楼下的面，味道还行。",
  "窗外在下雨，听着挺舒服的。",
  "刚给手机充上电，差点关机。",
  "这本书翻了几页，写得还不错。",
  "晚饭打算自己煮个面。",
  "楼上装修有点吵。",
  "今天的云特别好看。",
  "刚泡了杯茶，暖暖的。",
  "电梯里遇到邻居打了招呼。",
  "这天气忽冷忽热的。",
  "新买的键盘手感很好。",
];

const FILLERS_EN: readonly string[] = [
  "The bus was packed this morning.",
  "Lunch was a simple sandwich today.",
  "It rained all afternoon here.",
  "My plant grew a new leaf.",
  "Started a new podcast series.",
  "The sunset was beautiful today.",
  "Coffee shop around the corner reopened.",
  "Finally organized my desk drawers.",
];

// ---------------------------------------------------------------------------
// Authored claims.
// ---------------------------------------------------------------------------

const CLAIMS: readonly PlantedClaimSpec[] = [
  // ── objective self facts ──────────────────────────────────────────────────
  { claimId: "emp-blue", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.employer, typedValue: "蓝湾科技", statementTurnId: "d1s0-t0" },
  { claimId: "role-be", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.roleTitle, typedValue: "后端工程师", statementTurnId: "d1s0-t0" },
  { claimId: "res-hz", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.residence, typedValue: "杭州滨江", statementTurnId: "d1s0-t2" },
  { claimId: "home-mianyang", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.hometown, typedValue: "四川绵阳", statementTurnId: "d2s0-t0" },
  { claimId: "wp-binjiang", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.workplace, typedValue: ["滨江园区"], statementTurnId: "d2s1-t0" },
  { claimId: "family-single", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.familyStage, typedValue: "single", statementTurnId: "d2s1-t2" },
  { claimId: "career-employed", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.careerStage, typedValue: "employed", statementTurnId: "d3s0-t2" },
  { claimId: "proj-nebula", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.projectParticipation, typedValue: ["星云项目"], statementTurnId: "d3s1-t0", forgottenOnTurnId: "d8s1-t6" },
  { claimId: "horizon-long", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.relationshipHorizon, typedValue: "long_term", statementTurnId: "d4s0-t6" },
  { claimId: "travel-neg", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.businessTravel, typedValue: "negative", statementTurnId: "d5s0-t8", forgottenOnTurnId: "d9s0-t8" },
  { claimId: "life-wedding", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.lifeChange, typedValue: "wedding_prep", statementTurnId: "d7s0-t6" },
  // ── relationships ─────────────────────────────────────────────────────────
  { claimId: "rel-colleague-wang", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "wang", statementTurnId: "d1s1-t0" },
  { claimId: "rel-friend-lin", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "lin", statementTurnId: "d2s0-t2" },
  { claimId: "rel-roommate-zhe", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.roommateOf, personId: "zhe", statementTurnId: "d2s1-t4" },
  { claimId: "rel-friend-mike", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "mike", statementTurnId: "d3s1-t2" },
  { claimId: "rel-roommate-mike", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.roommateOf, personId: "mike", statementTurnId: "d4s1-t6" },
  { claimId: "rel-manager-chen", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.managerOf, personId: "chen", statementTurnId: "d4s0-t4" },
  { claimId: "rel-sibling-fang", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.siblingOf, personId: "fang", statementTurnId: "d4s1-t4" },
  { claimId: "rel-colleague-zhou", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "zhou", statementTurnId: "d3s0-t4" },
  { claimId: "rel-friend-nana", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "nana", statementTurnId: "d5s0-t10" },
  { claimId: "rel-colleague-david", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "david", statementTurnId: "d5s1-t6" },
  { claimId: "rel-partner-yu", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.partnerOf, personId: "yu", statementTurnId: "d6s1-t6" },
  { claimId: "rel-friend-kai", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "kai", statementTurnId: "d6s0-t6" },
  { claimId: "rel-friend-elena", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "elena", statementTurnId: "d7s1-t8" },
  { claimId: "rel-colleague-hui", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "hui", statementTurnId: "d7s0-t8" },
  { claimId: "rel-colleague-lin", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "lin", statementTurnId: "d8s0-t8" },
  { claimId: "rel-friend-song", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "song", statementTurnId: "d9s1-t6" },
  { claimId: "rel-colleague-he", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "he", statementTurnId: "d9s0-t9" },
  // ── impressions (cross-session floor: 2 evidence × 2 days, ADR-0039) ────
  { claimId: "imp-style", category: "impression", kind: "impression", predicateId: PREDICATE_IDS.statedStyle, typedValue: "喜欢直接沟通", evidenceTurnIds: ["d4s1-t2", "d7s1-t6"] },
  { claimId: "imp-consider", category: "impression", kind: "impression", predicateId: PREDICATE_IDS.considerationStyle, typedValue: "重大决定先列利弊清单", evidenceTurnIds: ["d5s1-t4", "d8s0-t6"] },
  { claimId: "imp-core", category: "impression", kind: "impression", predicateId: PREDICATE_IDS.corePriorities, typedValue: ["家人健康", "工作稳定"], evidenceTurnIds: ["d6s1-t8", "d9s0-t6"] },
  // ── temporal change (superseding statements on existing canonical keys) ──
  { claimId: "res-suzhou", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.residence, typedValue: "苏州工业园区", statementTurnId: "d6s0-t4", supersedesClaimId: "res-hz" },
  { claimId: "family-couple", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.familyStage, typedValue: "in_relationship", statementTurnId: "d6s1-t10", supersedesClaimId: "family-single" },
  { claimId: "role-senior", category: "objective_fact", kind: "objective", predicateId: PREDICATE_IDS.roleTitle, typedValue: "资深后端工程师", statementTurnId: "d7s1-t8", supersedesClaimId: "role-be" },
  { claimId: "rel-roommate-zhe-ended", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.roommateOf, personId: "zhe", temporalStatus: "ended", statementTurnId: "d8s1-t4", supersedesClaimId: "rel-roommate-zhe" },
  { claimId: "rel-colleague-david-ended", category: "relationship", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "david", temporalStatus: "ended", statementTurnId: "d9s1-t4", supersedesClaimId: "rel-colleague-david" },
  // ── distractors (≥ non-distractor count; never probed) ────────────────────
  { claimId: "dz-colleague-wang2", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "wang2", statementTurnId: "d3s0-t8" },
  { claimId: "dz-friend-lin2", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "lin2", statementTurnId: "d4s1-t7" },
  { claimId: "dz-colleague-kang", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "kang", statementTurnId: "d3s1-t4" },
  { claimId: "dz-colleague-xu", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "xu", statementTurnId: "d5s1-t8" },
  { claimId: "dz-friend-gao", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "gao", statementTurnId: "d6s1-t9" },
  { claimId: "dz-friend-jiang", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "jiang", statementTurnId: "d7s0-t9" },
  { claimId: "dz-roommate-fu", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.roommateOf, personId: "fu", statementTurnId: "d5s1-t9" },
  { claimId: "dz-relative-qian", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.relativeOf, personId: "qian", statementTurnId: "d8s1-t8" },
  { claimId: "dz-colleague-duan", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "duan", statementTurnId: "d8s0-t10" },
  { claimId: "dz-colleague-mo", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "mo", statementTurnId: "d8s1-t9" },
  { claimId: "dz-colleague-david2", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "david2", statementTurnId: "d2s1-t6" },
  { claimId: "dz-friend-fei", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "fei", statementTurnId: "d2s0-t4" },
  { claimId: "dz-colleague-qin", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "qin", statementTurnId: "d1s1-t2" },
  { claimId: "dz-friend-lun", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "lun", statementTurnId: "d7s1-t10" },
  { claimId: "dz-friend-bei", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "bei", statementTurnId: "d9s1-t7" },
  { claimId: "dz-friend-zhu", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "zhu", statementTurnId: "d10s0-t6" },
  { claimId: "dz-colleague-gong", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "gong", statementTurnId: "d9s1-t8" },
  { claimId: "dz-roommate-ruan", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.roommateOf, personId: "ruan", statementTurnId: "d7s0-t10" },
  { claimId: "dz-friend-shao", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "shao", statementTurnId: "d1s1-t4" },
  { claimId: "dz-colleague-yan", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "yan", statementTurnId: "d2s0-t6" },
  { claimId: "dz-friend-cen", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "cen", statementTurnId: "d3s1-t6" },
  { claimId: "dz-colleague-liu2", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "liu2", statementTurnId: "d4s0-t8" },
  { claimId: "dz-friend-guan", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "guan", statementTurnId: "d5s0-t11" },
  { claimId: "dz-colleague-chu", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "chu", statementTurnId: "d6s0-t7" },
  { claimId: "dz-friend-xun", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "xun", statementTurnId: "d7s1-t11" },
  { claimId: "dz-roommate-man", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.roommateOf, personId: "man", statementTurnId: "d9s0-t10" },
  { claimId: "dz-colleague-qi", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "qi", statementTurnId: "d10s0-t7" },
  { claimId: "dz-friend-lin3", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "yan", statementTurnId: "d10s1-t11" },
  { claimId: "dz-colleague-mo2", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "bei", statementTurnId: "d10s0-t9" },
  { claimId: "dz-friend-qian2", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "qian", statementTurnId: "d6s1-t10" },
  { claimId: "dz-colleague-fei2", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "fei", statementTurnId: "d4s1-t8" },
  { claimId: "dz-friend-wang2", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "wang2", statementTurnId: "d1s0-t4" },
  { claimId: "dz-colleague-lin2", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "lin2", statementTurnId: "d2s0-t8" },
  { claimId: "dz-friend-mo", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "mo", statementTurnId: "d3s1-t8" },
  { claimId: "dz-friend-kang", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "kang", statementTurnId: "d4s1-t10" },
  { claimId: "dz-colleague-gao", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.colleagueOf, personId: "gao", statementTurnId: "d6s0-t9" },
  { claimId: "dz-friend-duan2", category: "distractor", kind: "objective", predicateId: PREDICATE_IDS.friendOf, personId: "duan", statementTurnId: "d2s1-t7" },
];

// ---------------------------------------------------------------------------
// Authored statements, queries and forget turns, keyed by turn id
// (day × session × slot). Queries are authored against the registry v1
// published lexical surfaces. Within a session, query turns always sit in
// earlier slots than statement turns, so a probe's prior-exchange sources
// stay probe-only.
// ---------------------------------------------------------------------------

type AuthoredTurn = Readonly<{
  turnId: string;
  day: number;
  session: 0 | 1;
  slot: number;
  locale: CorpusLocale;
  role: TurnRole;
  /** Statement/forget turns carry text; query turns speak their query text. */
  text?: string;
  claimIds?: readonly string[];
  forgetClaimIds?: readonly string[];
  query?: QuerySpec;
}>;

const AUTHORED_TURNS: readonly AuthoredTurn[] = [
  // ── day 1 ────────────────────────────────────────────────────────────────
  {
    turnId: "d1s0-t0", day: 1, session: 0, slot: 0, locale: "zh", role: "statement",
    claimIds: ["emp-blue", "role-be"],
    text: "跟你分享一下，我最近入职了蓝湾科技，岗位是后端工程师。",
  },
  {
    turnId: "d1s0-t2", day: 1, session: 0, slot: 2, locale: "zh", role: "statement",
    claimIds: ["res-hz"],
    text: "对了，我现在住在杭州滨江，这边生活挺方便的。",
  },
  {
    turnId: "d1s0-t4", day: 1, session: 0, slot: 4, locale: "zh", role: "statement",
    claimIds: ["dz-friend-wang2"],
    text: "小汪喊我下班一起吃饭。",
  },
  {
    turnId: "d2s0-t8", day: 2, session: 0, slot: 8, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-lin2"],
    text: "小琳跟我同步了排期。",
  },
  {
    turnId: "d3s1-t8", day: 3, session: 1, slot: 8, locale: "zh", role: "statement",
    claimIds: ["dz-friend-mo"],
    text: "小莫约我周末去看展。",
  },
  {
    turnId: "d4s1-t10", day: 4, session: 1, slot: 10, locale: "zh", role: "statement",
    claimIds: ["dz-friend-kang"],
    text: "阿康借我的充电宝还没还。",
  },
  {
    turnId: "d6s0-t9", day: 6, session: 0, slot: 9, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-gao"],
    text: "老高问我周末值班安排。",
  },
  {
    turnId: "d1s1-t0", day: 1, session: 1, slot: 0, locale: "zh", role: "statement",
    claimIds: ["rel-colleague-wang"],
    text: "今天和同事小王一起改方案改到好晚。",
  },
  {
    turnId: "d1s1-t2", day: 1, session: 1, slot: 2, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-qin"],
    text: "白天还和小覃对了下数据。",
  },
  {
    turnId: "d1s1-t4", day: 1, session: 1, slot: 4, locale: "zh", role: "statement",
    claimIds: ["dz-friend-shao"],
    text: "晚上小邵发消息约周末爬山。",
  },
  // ── day 2 ────────────────────────────────────────────────────────────────
  {
    turnId: "d2s0-t0", day: 2, session: 0, slot: 0, locale: "zh", role: "statement",
    claimIds: ["home-mianyang"],
    text: "说起这个，我老家是四川绵阳的，过年才回去。",
  },
  {
    turnId: "d2s0-t2", day: 2, session: 0, slot: 2, locale: "zh", role: "statement",
    claimIds: ["rel-friend-lin"],
    text: "朋友小林推荐了一部纪录片，准备看看。",
  },
  {
    turnId: "d2s0-t4", day: 2, session: 0, slot: 4, locale: "zh", role: "statement",
    claimIds: ["dz-friend-fei"],
    text: "老费也说他看过，改天聚一下。",
  },
  {
    turnId: "d2s0-t6", day: 2, session: 0, slot: 6, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-yan"],
    text: "老闫中午拼车跟我一路，聊了几句。",
  },
  {
    turnId: "d2s1-t0", day: 2, session: 1, slot: 0, locale: "zh", role: "statement",
    claimIds: ["wp-binjiang"],
    text: "今天加班，我们办公室就在滨江园区，回家倒也方便。",
  },
  {
    turnId: "d2s1-t2", day: 2, session: 1, slot: 2, locale: "zh", role: "statement",
    claimIds: ["family-single"],
    text: "家里又开始催了，不过我现在还是单身，随缘吧。",
  },
  {
    turnId: "d2s1-t4", day: 2, session: 1, slot: 4, locale: "zh", role: "statement",
    claimIds: ["rel-roommate-zhe"],
    text: "室友阿哲煮了火锅，喊我一起吃。",
  },
  {
    turnId: "d2s1-t6", day: 2, session: 1, slot: 6, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-david2"],
    text: "大伟说他下周出差，让我帮忙带东西。",
  },
  {
    turnId: "d2s1-t7", day: 2, session: 1, slot: 7, locale: "zh", role: "statement",
    claimIds: ["dz-friend-duan2"],
    text: "老段约我周末打球。",
  },
  // ── day 3 ────────────────────────────────────────────────────────────────
  {
    turnId: "d3s0-t0", day: 3, session: 0, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-emp-zh", text: "我在哪家公司上班来着？突然想不起来跟家里人怎么说的。", locale: "zh", phase: "main",
      expectedClaimIds: ["emp-blue"],
    },
  },
  {
    turnId: "d3s0-t2", day: 3, session: 0, slot: 2, locale: "zh", role: "statement",
    claimIds: ["career-employed"],
    text: "目前的状态就是安心在职，先把手头的事情做好。",
  },
  {
    turnId: "d3s0-t4", day: 3, session: 0, slot: 4, locale: "zh", role: "statement",
    claimIds: ["rel-colleague-zhou"],
    text: "老周是我同事，上午还帮我review了一段代码。",
  },
  {
    turnId: "d3s0-t8", day: 3, session: 0, slot: 8, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-wang2"],
    text: "小汪也在我们组，刚转正。",
  },
  {
    turnId: "d3s1-t0", day: 3, session: 1, slot: 0, locale: "zh", role: "statement",
    claimIds: ["proj-nebula"],
    text: "最近在参与星云项目，天天开会。",
  },
  {
    turnId: "d3s1-t2", day: 3, session: 1, slot: 2, locale: "en", role: "statement",
    claimIds: ["rel-friend-mike"],
    text: "Mike is one of my good friends from college — we still chat weekly.",
  },
  {
    turnId: "d3s1-t4", day: 3, session: 1, slot: 4, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-kang"],
    text: "阿康中午问我需求排期的事。",
  },
  {
    turnId: "d3s1-t6", day: 3, session: 1, slot: 6, locale: "zh", role: "statement",
    claimIds: ["dz-friend-cen"],
    text: "晚上阿岑发来他乐队的演出视频。",
  },
  // ── day 4 ────────────────────────────────────────────────────────────────
  {
    turnId: "d4s0-t0", day: 4, session: 0, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-role-zh", text: "我的岗位是什么来着？填表要用。", locale: "zh", phase: "main",
      expectedClaimIds: ["role-be"],
    },
  },
  {
    turnId: "d4s0-t2", day: 4, session: 0, slot: 2, locale: "zh", role: "query",
    query: {
      queryId: "q-family-single", text: "我现在还是单身状态吧？", locale: "zh", phase: "main",
      expectedClaimIds: ["family-single"],
    },
  },
  {
    turnId: "d4s0-t4", day: 4, session: 0, slot: 4, locale: "zh", role: "statement",
    claimIds: ["rel-manager-chen"],
    text: "领导老陈今天开了一小时的项目会。",
  },
  {
    turnId: "d4s0-t6", day: 4, session: 0, slot: 6, locale: "zh", role: "statement",
    claimIds: ["horizon-long"],
    text: "说到感情，我谈恋爱是想找长期稳定的关系，不想折腾。",
  },
  {
    turnId: "d4s0-t8", day: 4, session: 0, slot: 8, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-liu2"],
    text: "小柳下午问我要不要拼下午茶。",
  },
  {
    turnId: "d4s1-t0", day: 4, session: 1, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-res-zh", text: "我现在住在哪个城市来着？快递地址要填。", locale: "zh", phase: "main",
      expectedClaimIds: ["res-hz"],
    },
  },
  {
    turnId: "d4s1-t2", day: 4, session: 1, slot: 2, locale: "zh", role: "statement",
    claimIds: ["imp-style"],
    text: "我沟通风格上喜欢直接一点，有话直说最省事。",
  },
  {
    turnId: "d4s1-t4", day: 4, session: 1, slot: 4, locale: "zh", role: "statement",
    claimIds: ["rel-sibling-fang"],
    text: "妹妹小芳期中考试考得不错。",
  },
  {
    turnId: "d4s1-t6", day: 4, session: 1, slot: 6, locale: "en", role: "statement",
    claimIds: ["rel-roommate-mike"],
    text: "Mike moved in last month — he is my roommate now, the flat feels livelier.",
  },
  {
    turnId: "d4s1-t7", day: 4, session: 1, slot: 7, locale: "zh", role: "statement",
    claimIds: ["dz-friend-lin2"],
    text: "小琳推荐了一家新开的滇菜馆。",
  },
  {
    turnId: "d4s1-t8", day: 4, session: 1, slot: 8, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-fei2"],
    text: "老费说下周带他家的猫来公司。",
  },
  // ── day 5 ────────────────────────────────────────────────────────────────
  {
    turnId: "d5s0-t0", day: 5, session: 0, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-home-zh", text: "我老家是四川的哪里来着？同事问我都没答上来。", locale: "zh", phase: "main",
      expectedClaimIds: ["home-mianyang"],
    },
  },
  {
    turnId: "d5s0-t2", day: 5, session: 0, slot: 2, locale: "zh", role: "query",
    query: {
      queryId: "q-zhou-zh", text: "老周是我同事吧？他昨天说我什么来着？", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-colleague-zhou"],
    },
  },
  {
    turnId: "d5s0-t4", day: 5, session: 0, slot: 4, locale: "zh", role: "query",
    query: {
      queryId: "q-zhe-zh", text: "我室友阿哲怎么样了？火锅店那顿还挺香的。", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-roommate-zhe"],
    },
  },
  {
    turnId: "d5s0-t6", day: 5, session: 0, slot: 6, locale: "mix", role: "query",
    query: {
      queryId: "q-emp-mix", text: "我上次说的入职的那家公司叫什么来着？", locale: "mix", phase: "main",
      expectedClaimIds: ["emp-blue"],
    },
  },
  {
    turnId: "d5s0-t8", day: 5, session: 0, slot: 8, locale: "zh", role: "statement",
    claimIds: ["travel-neg"],
    text: "排期又让我出差，其实我现在特别不想频繁出差。",
  },
  {
    turnId: "d5s0-t10", day: 5, session: 0, slot: 10, locale: "zh", role: "statement",
    claimIds: ["rel-friend-nana"],
    text: "娜娜是我好朋友，她换新工作了，请全组喝奶茶。",
  },
  {
    turnId: "d5s0-t11", day: 5, session: 0, slot: 11, locale: "zh", role: "statement",
    claimIds: ["dz-friend-guan"],
    text: "小关借我的书还没看完。",
  },
  {
    turnId: "d5s1-t0", day: 5, session: 1, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-wang-zh", text: "我同事小王最近怎么样？好几天没见了。", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-colleague-wang"],
    },
  },
  {
    turnId: "d5s1-t2", day: 5, session: 1, slot: 2, locale: "zh", role: "query",
    query: {
      queryId: "q-wp-zh", text: "我们办公室是在滨江哪个园区来着？", locale: "zh", phase: "main",
      expectedClaimIds: ["wp-binjiang"],
    },
  },
  {
    turnId: "d5s1-t4", day: 5, session: 1, slot: 4, locale: "zh", role: "statement",
    claimIds: ["imp-consider"],
    text: "买房子这种事我一定先列利弊清单，做决定要冷静。",
  },
  {
    turnId: "d5s1-t6", day: 5, session: 1, slot: 6, locale: "en", role: "statement",
    claimIds: ["rel-colleague-david"],
    text: "David is my colleague on the platform team — very reliable guy.",
  },
  {
    turnId: "d5s1-t8", day: 5, session: 1, slot: 8, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-xu"],
    text: "小许帮我带了一杯咖啡。",
  },
  {
    turnId: "d5s1-t9", day: 5, session: 1, slot: 9, locale: "zh", role: "statement",
    claimIds: ["dz-roommate-fu"],
    text: "阿福把他自行车放我家楼下了。",
  },
  // ── day 6 ────────────────────────────────────────────────────────────────
  {
    turnId: "d6s0-t0", day: 6, session: 0, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-career-zh", text: "我现在的工作状态算在职吧？", locale: "zh", phase: "main",
      expectedClaimIds: ["career-employed"],
    },
  },
  {
    turnId: "d6s0-t2", day: 6, session: 0, slot: 2, locale: "zh", role: "query",
    query: {
      queryId: "q-lin-zh", text: "我朋友小林最近怎么样？他上次推荐的东西还没试。", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-friend-lin"],
    },
  },
  {
    turnId: "d6s0-t4", day: 6, session: 0, slot: 4, locale: "zh", role: "statement",
    claimIds: ["res-suzhou"],
    text: "这个月我们把家搬到了苏州，通勤反而更近了。",
  },
  {
    turnId: "d6s0-t6", day: 6, session: 0, slot: 6, locale: "zh", role: "statement",
    claimIds: ["rel-friend-kai"],
    text: "阿凯是我朋友里最会做计划的，旅游攻略全靠他。",
  },
  {
    turnId: "d6s0-t7", day: 6, session: 0, slot: 7, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-chu"],
    text: "老褚换了新发型，全组都看出来了。",
  },
  {
    turnId: "d6s1-t0", day: 6, session: 1, slot: 0, locale: "en", role: "query",
    query: {
      queryId: "q-mike-en", text: "How is my friend Mike doing these days?", locale: "en", phase: "main",
      expectedClaimIds: ["rel-friend-mike", "rel-roommate-mike"],
    },
  },
  {
    turnId: "d6s1-t2", day: 6, session: 1, slot: 2, locale: "zh", role: "query",
    query: {
      queryId: "q-chen-zh", text: "我领导老陈这周有什么安排来着？", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-manager-chen"],
    },
  },
  {
    turnId: "d6s1-t4", day: 6, session: 1, slot: 4, locale: "zh", role: "query",
    query: {
      queryId: "q-proj-zh", text: "我最近在参与哪个项目来着？周报要写。", locale: "zh", phase: "main",
      expectedClaimIds: ["proj-nebula"],
    },
  },
  {
    turnId: "d6s1-t6", day: 6, session: 1, slot: 6, locale: "zh", role: "statement",
    claimIds: ["rel-partner-yu"],
    text: "跟你说个事，小雨现在是我女朋友了，处了两个多月。",
  },
  {
    turnId: "d6s1-t8", day: 6, session: 1, slot: 8, locale: "zh", role: "statement",
    claimIds: ["imp-core"],
    text: "慢慢觉得，对我最重要的是家人的健康，其次是一份稳定的工作。",
  },
  {
    turnId: "d6s1-t9", day: 6, session: 1, slot: 9, locale: "zh", role: "statement",
    claimIds: ["dz-friend-gao"],
    text: "老高约我下个月去看车展。",
  },
  {
    turnId: "d6s1-t10", day: 6, session: 1, slot: 10, locale: "zh", role: "statement",
    claimIds: ["family-couple", "dz-friend-qian2"],
    text: "所以现在算是恋爱中了，家里终于不催了。小倩摄影展也入围了，挺厉害的。",
  },
  // ── day 7 ────────────────────────────────────────────────────────────────
  {
    turnId: "d7s0-t0", day: 7, session: 0, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-horizon-zh", text: "我想要的是长期的关系来着，对吧？", locale: "zh", phase: "main",
      expectedClaimIds: ["horizon-long"],
    },
  },
  {
    turnId: "d7s0-t2", day: 7, session: 0, slot: 2, locale: "zh", role: "query",
    query: {
      queryId: "q-fang-zh", text: "我妹妹小芳是不是下周放假回家？", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-sibling-fang"],
    },
  },
  {
    turnId: "d7s0-t4", day: 7, session: 0, slot: 4, locale: "zh", role: "query",
    query: {
      queryId: "q-nana-zh", text: "娜娜是我好朋友来着，她新工作怎么样了？", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-friend-nana"],
    },
  },
  {
    turnId: "d7s0-t6", day: 7, session: 0, slot: 6, locale: "zh", role: "statement",
    claimIds: ["life-wedding"],
    text: "家里在张罗着备婚的事，虽然节奏还挺早的。",
  },
  {
    turnId: "d7s0-t8", day: 7, session: 0, slot: 8, locale: "zh", role: "statement",
    claimIds: ["rel-colleague-hui"],
    text: "小惠是我同事，今天帮我顶了个会。",
  },
  {
    turnId: "d7s0-t9", day: 7, session: 0, slot: 9, locale: "zh", role: "statement",
    claimIds: ["dz-friend-jiang"],
    text: "小蒋的猫生病了，他请了半天假。",
  },
  {
    turnId: "d7s0-t10", day: 7, session: 0, slot: 10, locale: "zh", role: "statement",
    claimIds: ["dz-roommate-ruan"],
    text: "小阮问我有没有兴趣一起租年终的联欢场地。",
  },
  {
    turnId: "d7s1-t0", day: 7, session: 1, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-travel-zh", text: "我是不是说过不太想出差来着？", locale: "zh", phase: "main",
      expectedClaimIds: ["travel-neg"],
    },
  },
  {
    turnId: "d7s1-t2", day: 7, session: 1, slot: 2, locale: "en", role: "query",
    query: {
      queryId: "q-david-en", text: "Is my colleague David joining the offsite next month?", locale: "en", phase: "main",
      expectedClaimIds: ["rel-colleague-david"],
    },
  },
  {
    turnId: "d7s1-t4", day: 7, session: 1, slot: 4, locale: "mix", role: "query",
    query: {
      queryId: "q-wang-mix", text: "同事小王还好吗，好久没聊了", locale: "mix", phase: "main",
      expectedClaimIds: ["rel-colleague-wang"],
    },
  },
  {
    turnId: "d7s1-t6", day: 7, session: 1, slot: 6, locale: "zh", role: "statement",
    claimIds: ["imp-style"],
    text: "开会的时候我还是喜欢把话说明白，直说最好。",
  },
  {
    turnId: "d7s1-t8", day: 7, session: 1, slot: 8, locale: "zh", role: "statement",
    claimIds: ["role-senior", "rel-friend-elena"],
    text: "升职啦，现在是资深后端工程师了。对了，Elena 是我老东家就认识的挚友，她下个月来看我。",
  },
  {
    turnId: "d7s1-t10", day: 7, session: 1, slot: 10, locale: "zh", role: "statement",
    claimIds: ["dz-friend-lun"],
    text: "阿仑约了周末骑行。",
  },
  {
    turnId: "d7s1-t11", day: 7, session: 1, slot: 11, locale: "zh", role: "statement",
    claimIds: ["dz-friend-xun"],
    text: "小荀晒了他的马拉松奖牌。",
  },
  // ── day 8 ────────────────────────────────────────────────────────────────
  {
    turnId: "d8s0-t0", day: 8, session: 0, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-res-suzhou", text: "我们现在是不是已经定居苏州了？", locale: "zh", phase: "main",
      expectedClaimIds: ["res-suzhou"],
    },
  },
  {
    turnId: "d8s0-t2", day: 8, session: 0, slot: 2, locale: "zh", role: "query",
    query: {
      queryId: "q-style-zh", text: "我说过我喜欢直接沟通来着，对吧？", locale: "zh", phase: "main",
      expectedClaimIds: ["imp-style"],
    },
  },
  {
    turnId: "d8s0-t4", day: 8, session: 0, slot: 4, locale: "zh", role: "query",
    query: {
      queryId: "q-yu-zh", text: "我女朋友小雨这周末有什么安排来着？", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-partner-yu"],
    },
  },
  {
    turnId: "d8s0-t6", day: 8, session: 0, slot: 6, locale: "zh", role: "statement",
    claimIds: ["imp-consider"],
    text: "换工作的事我还在列利弊清单，做决定不着急。",
  },
  {
    turnId: "d8s0-t8", day: 8, session: 0, slot: 8, locale: "zh", role: "statement",
    claimIds: ["rel-colleague-lin"],
    text: "对了，小林跳槽来我们公司了，现在也是我同事。",
  },
  {
    turnId: "d8s0-t10", day: 8, session: 0, slot: 10, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-duan"],
    text: "老段中午分享了他老家的特产。",
  },
  {
    turnId: "d8s1-t0", day: 8, session: 1, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-family-rel", text: "我现在是不是恋爱中来着？", locale: "zh", phase: "main",
      expectedClaimIds: ["family-couple"],
    },
  },
  {
    turnId: "d8s1-t2", day: 8, session: 1, slot: 2, locale: "zh", role: "query",
    query: {
      queryId: "q-kai-zh", text: "阿凯是我朋友吧？他计划做得怎么样来着？", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-friend-kai"],
    },
  },
  {
    turnId: "d8s1-t4", day: 8, session: 1, slot: 4, locale: "zh", role: "statement",
    claimIds: ["rel-roommate-zhe-ended"],
    text: "阿哲下个月搬去园区那边，我们就不做室友了，不过还是好朋友。",
  },
  {
    turnId: "d8s1-t6", day: 8, session: 1, slot: 6, locale: "zh", role: "forget",
    forgetClaimIds: ["proj-nebula"],
    text: "星云项目的事就到这了，把星云项目的事忘掉吧，以后别再提了。",
  },
  {
    turnId: "d8s1-t8", day: 8, session: 1, slot: 8, locale: "zh", role: "statement",
    claimIds: ["dz-relative-qian"],
    text: "小倩是我远房亲戚家的表妹，老家那边的事都靠她张罗。",
  },
  {
    turnId: "d8s1-t9", day: 8, session: 1, slot: 9, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-mo"],
    text: "小莫的工位搬到我斜对面了。",
  },
  // ── day 9 ────────────────────────────────────────────────────────────────
  {
    turnId: "d9s0-t0", day: 9, session: 0, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-hui-zh", text: "小惠是我同事来着？她今天怎么没来？", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-colleague-hui"],
    },
  },
  {
    turnId: "d9s0-t2", day: 9, session: 0, slot: 2, locale: "zh", role: "query",
    query: {
      queryId: "q-wedding-zh", text: "我们是不是在备婚来着？家里又来电话问了。", locale: "zh", phase: "main",
      expectedClaimIds: ["life-wedding"],
    },
  },
  {
    turnId: "d9s0-t4", day: 9, session: 0, slot: 4, locale: "zh", role: "query",
    query: {
      queryId: "q-role-senior", text: "我现在岗位是什么来着？是不是升过了？", locale: "zh", phase: "main",
      expectedClaimIds: ["role-senior"],
    },
  },
  {
    turnId: "d9s0-t6", day: 9, session: 0, slot: 6, locale: "zh", role: "statement",
    claimIds: ["imp-core"],
    text: "这一阵更确定了：家人的健康最重要，工作稳定排前面。",
  },
  {
    turnId: "d9s0-t8", day: 9, session: 0, slot: 8, locale: "zh", role: "forget",
    forgetClaimIds: ["travel-neg"],
    text: "算了，把我之前抱怨出差的那些事忘掉吧，以后别再提了。",
  },
  {
    turnId: "d9s0-t9", day: 9, session: 0, slot: 9, locale: "zh", role: "statement",
    claimIds: ["rel-colleague-he"],
    text: "小何是我同事，今天入职满一年。",
  },
  {
    turnId: "d9s0-t10", day: 9, session: 0, slot: 10, locale: "zh", role: "statement",
    claimIds: ["dz-roommate-man"],
    text: "阿曼问我公寓的暖气怎么样。",
  },
  {
    turnId: "d9s1-t0", day: 9, session: 1, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-consider-imp", text: "我遇到重大决定是不是习惯先列利弊清单？", locale: "zh", phase: "main",
      expectedClaimIds: ["imp-consider"],
    },
  },
  {
    turnId: "d9s1-t2", day: 9, session: 1, slot: 2, locale: "en", role: "query",
    query: {
      queryId: "q-elena-en", text: "When did my friend Elena say she would visit?", locale: "en", phase: "main",
      expectedClaimIds: ["rel-friend-elena"],
    },
  },
  {
    turnId: "d9s1-t4", day: 9, session: 1, slot: 4, locale: "en", role: "statement",
    claimIds: ["rel-colleague-david-ended"],
    text: "David left the company last week — he is not my colleague anymore, but we stay in touch.",
  },
  {
    turnId: "d9s1-t6", day: 9, session: 1, slot: 6, locale: "zh", role: "statement",
    claimIds: ["rel-friend-song"],
    text: "老宋是我朋友里最靠谱的，昨天还帮我校对材料。",
  },
  {
    turnId: "d9s1-t7", day: 9, session: 1, slot: 7, locale: "zh", role: "statement",
    claimIds: ["dz-friend-bei"],
    text: "阿北开了家小书店，想去看看。",
  },
  {
    turnId: "d9s1-t8", day: 9, session: 1, slot: 8, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-gong"],
    text: "老龚升职了，请大家喝咖啡。",
  },
  // ── day 10 ───────────────────────────────────────────────────────────────
  {
    turnId: "d10s0-t0", day: 10, session: 0, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-travel-postforget", text: "我之前是不是说过不喜欢出差？", locale: "zh", phase: "post_forget",
      expectedClaimIds: [],
      fencedClaimIds: ["travel-neg"],
    },
  },
  {
    turnId: "d10s0-t2", day: 10, session: 0, slot: 2, locale: "zh", role: "query",
    query: {
      queryId: "q-lin-late", text: "小林现在跟我当同事了，他最近怎么样？", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-friend-lin", "rel-colleague-lin"],
    },
  },
  {
    turnId: "d10s0-t4", day: 10, session: 0, slot: 4, locale: "en", role: "query",
    query: {
      queryId: "q-david-post", text: "My colleague David left recently — how is he holding up?", locale: "en", phase: "main",
      expectedClaimIds: ["rel-colleague-david-ended"],
    },
  },
  {
    turnId: "d10s0-t6", day: 10, session: 0, slot: 6, locale: "zh", role: "statement",
    claimIds: ["dz-friend-zhu"],
    text: "小竹寄来了他家乡的茶叶。",
  },
  {
    turnId: "d10s0-t7", day: 10, session: 0, slot: 7, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-qi"],
    text: "小戚分享了年会节目单。",
  },
  {
    turnId: "d10s1-t0", day: 10, session: 1, slot: 0, locale: "zh", role: "query",
    query: {
      queryId: "q-core-imp", text: "你觉得对我来说，是不是家人的健康最重要、工作稳定排前面？", locale: "zh", phase: "main",
      expectedClaimIds: ["imp-core"],
    },
  },
  {
    turnId: "d10s1-t2", day: 10, session: 1, slot: 2, locale: "zh", role: "query",
    query: {
      queryId: "q-zhe-post", text: "阿哲搬走以后，我们已经不是室友了吧？", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-roommate-zhe-ended"],
    },
  },
  {
    turnId: "d10s1-t4", day: 10, session: 1, slot: 4, locale: "zh", role: "query",
    query: {
      queryId: "q-proj-postforget", text: "我最近在忙哪个项目来着？", locale: "zh", phase: "post_forget",
      expectedClaimIds: [],
      fencedClaimIds: ["proj-nebula"],
    },
  },
  {
    turnId: "d10s1-t6", day: 10, session: 1, slot: 6, locale: "en", role: "query",
    query: {
      queryId: "q-emp-en", text: "Which company do I work at again? Someone asked me today.", locale: "en", phase: "main",
      expectedClaimIds: ["emp-blue"],
    },
  },
  {
    turnId: "d10s1-t8", day: 10, session: 1, slot: 8, locale: "zh", role: "query",
    query: {
      queryId: "q-song-zh", text: "老宋是我朋友吧？", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-friend-song"],
    },
  },
  {
    turnId: "d10s1-t11", day: 10, session: 1, slot: 11, locale: "zh", role: "statement",
    claimIds: ["dz-friend-lin3"],
    text: "老闫喊我周末剧本杀。",
  },
  {
    turnId: "d10s1-t10", day: 10, session: 1, slot: 10, locale: "zh", role: "query",
    query: {
      queryId: "q-he-zh", text: "小何是我同事吗？", locale: "zh", phase: "main",
      expectedClaimIds: ["rel-colleague-he"],
    },
  },
  {
    turnId: "d10s0-t9", day: 10, session: 0, slot: 9, locale: "zh", role: "statement",
    claimIds: ["dz-colleague-mo2"],
    text: "阿北说书店周末有读书会。",
  },
];

/**
 * The post-dormancy probe runs after the corpus clock jumps past the
 * impression review deadline (ADR-0041) and the impression claim goes
 * dormant — the fenced impression must not inject (fence probe).
 */
export const POST_DORMANCY_QUERY: QuerySpec = {
  queryId: "q-consider-dormant",
  text: "好久没聊了，我遇到重大决定是不是爱列利弊清单来着？",
  locale: "zh",
  phase: "post_dormancy",
  expectedClaimIds: [],
  fencedClaimIds: ["imp-consider"],
};

/** The impression claim forced dormant after the main corpus (ADR-0041). */
export const DORMANCY_PROBE_CLAIM_ID = "imp-consider";

// ---------------------------------------------------------------------------
// Builder.
// ---------------------------------------------------------------------------

function buildTurns(): CorpusTurnSpec[] {
  const random = createRandom(RETRIEVAL_PRECISION_CORPUS_SEED);
  const authoredBySlot = new Map<string, AuthoredTurn>();
  for (const turn of AUTHORED_TURNS) {
    const key = `${turn.day}:${turn.session}:${turn.slot}`;
    const existing = authoredBySlot.get(key);
    if (existing) {
      throw new Error(`Duplicate authored turn at ${key}: ${existing.turnId} vs ${turn.turnId}`);
    }
    authoredBySlot.set(key, turn);
  }

  const turns: CorpusTurnSpec[] = [];
  for (let day = 1; day <= CORPUS_DAYS; day += 1) {
    for (let session = 0; session < CORPUS_SESSIONS_PER_DAY; session += 1) {
      for (let slot = 0; slot < CORPUS_TURNS_PER_SESSION; slot += 1) {
        const authored = authoredBySlot.get(`${day}:${session}:${slot}`);
        if (authored) {
          turns.push(toCorpusTurn(authored));
          continue;
        }
        const useEnglish = random() < 0.25;
        const pool = useEnglish ? FILLERS_EN : FILLERS_ZH;
        const text = pool[Math.floor(random() * pool.length)]!;
        turns.push({
          turnId: `f-d${day}s${session}-${slot}`,
          day,
          session: session as 0 | 1,
          slot,
          locale: useEnglish ? "en" : "zh",
          text,
          role: "filler",
        });
      }
    }
  }
  return turns;
}

function toCorpusTurn(authored: AuthoredTurn): CorpusTurnSpec {
  return {
    turnId: authored.turnId,
    day: authored.day,
    session: authored.session,
    slot: authored.slot,
    locale: authored.locale,
    // Query turns speak their query text; statement/forget turns carry text.
    text: authored.text ?? authored.query?.text ?? "",
    role: authored.role,
    ...(authored.query ? { query: authored.query } : {}),
    ...(authored.claimIds ? { claimIds: authored.claimIds } : {}),
    ...(authored.forgetClaimIds ? { forgetClaimIds: authored.forgetClaimIds } : {}),
  };
}

/** Build the corpus; throws when the authored content violates its own rules. */
export function buildCorpus(): PrecisionCorpus {
  const corpus: PrecisionCorpus = {
    version: RETRIEVAL_PRECISION_CORPUS_VERSION,
    seed: RETRIEVAL_PRECISION_CORPUS_SEED,
    syntheticNotice: SYNTHETIC_NOTICE,
    days: CORPUS_DAYS,
    sessionsPerDay: CORPUS_SESSIONS_PER_DAY,
    turnsPerSession: CORPUS_TURNS_PER_SESSION,
    timezone: CORPUS_TIMEZONE,
    baseTimeUtc: CORPUS_BASE_TIME_UTC,
    people: PEOPLE,
    claims: CLAIMS,
    turns: buildTurns(),
  };
  const problems = validateCorpus(corpus);
  if (problems.length > 0) {
    throw new Error(
      `Corpus definition is invalid:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  }
  return corpus;
}

// ---------------------------------------------------------------------------
// Pure validation — shared by the builder and the unit tests.
// ---------------------------------------------------------------------------

export function validateCorpus(corpus: PrecisionCorpus): readonly string[] {
  const problems: string[] = [];
  const turnById = new Map(corpus.turns.map((turn) => [turn.turnId, turn]));
  const claimById = new Map(corpus.claims.map((claim) => [claim.claimId, claim]));
  const orderIndex = new Map(
    corpus.turns.map((turn, index) => [turn.turnId, index] as const),
  );

  // Shape
  if (corpus.turns.length !== corpus.days * corpus.sessionsPerDay * corpus.turnsPerSession) {
    problems.push(
      `expected ${corpus.days * corpus.sessionsPerDay * corpus.turnsPerSession} turns, got ${corpus.turns.length}`,
    );
  }
  for (const turn of corpus.turns) {
    if (turn.text.trim() === "") problems.push(`${turn.turnId}: empty text`);
  }

  // Distractor floor: at least as many distractors as planted claims (AC 38).
  const planted = corpus.claims.filter((claim) => claim.category !== "distractor");
  const distractors = corpus.claims.filter((claim) => claim.category === "distractor");
  if (planted.length < 30) {
    problems.push(`AC 38 requires ≥30 planted claims, got ${planted.length}`);
  }
  if (distractors.length < planted.length) {
    problems.push(
      `distractors (${distractors.length}) must be at least as many as planted claims (${planted.length})`,
    );
  }

  // Category coverage (objective statements, people/relationships, temporal
  // change, impressions).
  const categories = new Set(planted.map((claim) => claim.category));
  for (const required of ["objective_fact", "relationship", "impression"] as const) {
    if (!categories.has(required)) problems.push(`missing claim category ${required}`);
  }
  const hasTemporalChange = corpus.claims.some((claim) => claim.supersedesClaimId !== undefined);
  if (!hasTemporalChange) problems.push("missing temporal-change claims (superseding statements)");

  // Claim references resolve; statement/evidence/forget turns exist and order.
  for (const claim of corpus.claims) {
    if (claim.category === "impression") {
      const evidence = claim.evidenceTurnIds ?? [];
      if (evidence.length !== 2) {
        problems.push(`${claim.claimId}: impressions need exactly 2 evidence turns (ADR-0039)`);
        continue;
      }
      const first = turnById.get(evidence[0]!);
      const second = turnById.get(evidence[1]!);
      if (!first || !second) {
        problems.push(`${claim.claimId}: unknown evidence turn`);
        continue;
      }
      if (first.day === second.day) {
        problems.push(`${claim.claimId}: impression evidence must span two days`);
      }
      if (claim.forgottenOnTurnId && (orderIndex.get(claim.forgottenOnTurnId) ?? 0) < (orderIndex.get(second.turnId) ?? Infinity)) {
        problems.push(`${claim.claimId}: forget turn precedes the last evidence turn`);
      }
    } else {
      const statement = claim.statementTurnId ? turnById.get(claim.statementTurnId) : undefined;
      if (!statement) {
        problems.push(`${claim.claimId}: unknown or missing statementTurnId`);
      }
    }
    if (claim.personId !== undefined) {
      const person = corpus.people.find((candidate) => candidate.personId === claim.personId);
      if (!person) problems.push(`${claim.claimId}: unknown personId ${claim.personId}`);
      if (claim.category === "distractor" && person?.role !== "distractor") {
        problems.push(`${claim.claimId}: distractor claim must reference a distractor person`);
      }
      if (claim.category !== "distractor" && person?.role !== "probe") {
        problems.push(`${claim.claimId}: planted claim must reference a probe person`);
      }
    }
    if (claim.kind === "impression" && claim.category !== "impression") {
      problems.push(`${claim.claimId}: impression kind requires impression category`);
    }
  }

  // Temporal-change supersede targets exist and share predicate + object.
  for (const claim of corpus.claims) {
    if (claim.supersedesClaimId === undefined) continue;
    const target = claimById.get(claim.supersedesClaimId);
    if (!target) {
      problems.push(`${claim.claimId}: supersedesClaimId ${claim.supersedesClaimId} not found`);
      continue;
    }
    if (target.predicateId !== claim.predicateId) {
      problems.push(`${claim.claimId}: supersede predicate mismatch`);
    }
    if (target.personId !== claim.personId) {
      problems.push(`${claim.claimId}: supersede person mismatch`);
    }
  }

  // Every claim is planted exactly once on its authored statement turn.
  const claimsByStatementTurn = new Map<string, string[]>();
  for (const claim of corpus.claims) {
    const turnIds = claim.category === "impression"
      ? claim.evidenceTurnIds ?? []
      : claim.statementTurnId
        ? [claim.statementTurnId]
        : [];
    for (const turnId of turnIds) {
      claimsByStatementTurn.set(turnId, [
        ...(claimsByStatementTurn.get(turnId) ?? []),
        claim.claimId,
      ]);
    }
  }
  for (const turn of corpus.turns) {
    if (turn.role === "statement") {
      const referenced = turn.claimIds ?? [];
      const authored = claimsByStatementTurn.get(turn.turnId) ?? [];
      for (const claimId of referenced) {
        if (!authored.includes(claimId)) {
          problems.push(`${turn.turnId}: references ${claimId} but the claim does not point back`);
        }
      }
      for (const claimId of authored) {
        if (!referenced.includes(claimId)) {
          problems.push(`${turn.turnId}: claim ${claimId} points here but the turn does not list it`);
        }
      }
    }
    if (turn.role === "forget") {
      for (const claimId of turn.forgetClaimIds ?? []) {
        const claim = claimById.get(claimId);
        if (!claim) {
          problems.push(`${turn.turnId}: forgets unknown claim ${claimId}`);
        } else if (claim.forgottenOnTurnId !== turn.turnId) {
          problems.push(`${turn.turnId}: claim ${claimId} does not point back to this forget turn`);
        }
      }
    }
  }
  for (const claim of corpus.claims) {
    if (claim.forgottenOnTurnId && claim.category === "impression") {
      const lastEvidence = claim.evidenceTurnIds?.[claim.evidenceTurnIds.length - 1];
      if (lastEvidence && (orderIndex.get(claim.forgottenOnTurnId) ?? 0) < (orderIndex.get(lastEvidence) ?? Infinity)) {
        problems.push(`${claim.claimId}: forget precedes the last evidence turn`);
      }
    }
  }

  // Queries: ground truth resolves, phases and fences order correctly.
  const queryById = new Map<string, QuerySpec>();
  for (const turn of corpus.turns) {
    const query = turn.query;
    if (!query) continue;
    if (turn.role !== "query") problems.push(`${turn.turnId}: non-query turn carries a query spec`);
    if (queryById.has(query.queryId)) problems.push(`duplicate queryId ${query.queryId}`);
    queryById.set(query.queryId, query);
    for (const claimId of query.expectedClaimIds) {
      const claim = claimById.get(claimId);
      if (!claim) {
        problems.push(`${query.queryId}: expected claim ${claimId} not planted`);
        continue;
      }
      if (claim.category === "distractor") {
        problems.push(`${query.queryId}: distractor claim ${claimId} must never be expected`);
      }
      const statementTurn = claim.category === "impression"
        ? claim.evidenceTurnIds?.[claim.evidenceTurnIds.length - 1] ?? ""
        : claim.statementTurnId ?? "";
      if ((orderIndex.get(statementTurn) ?? -1) >= (orderIndex.get(turn.turnId) ?? Infinity)) {
        problems.push(`${query.queryId}: expected claim ${claimId} is planted at/after the query`);
      }
      const forgetTurn = claim.forgottenOnTurnId;
      if (forgetTurn && (orderIndex.get(forgetTurn) ?? Infinity) < (orderIndex.get(turn.turnId) ?? -1)) {
        problems.push(
          `${query.queryId}: expected claim ${claimId} is already forgotten at this query (use a fence probe instead)`,
        );
      }
    }
    for (const claimId of query.fencedClaimIds ?? []) {
      const claim = claimById.get(claimId);
      const forgetTurn = claim?.forgottenOnTurnId;
      if (!forgetTurn) {
        problems.push(`${query.queryId}: fenced claim ${claimId} has no forget turn`);
        continue;
      }
      if ((orderIndex.get(forgetTurn) ?? -1) >= (orderIndex.get(turn.turnId) ?? Infinity)) {
        problems.push(`${query.queryId}: fence probe precedes the forget turn of ${claimId}`);
      }
      if (query.expectedClaimIds.includes(claimId)) {
        problems.push(`${query.queryId}: claim ${claimId} both expected and fenced`);
      }
    }
    if (query.phase === "post_forget" && (query.fencedClaimIds ?? []).length === 0) {
      problems.push(`${query.queryId}: post_forget query must fence at least one claim`);
    }
    if (query.phase !== "main" && query.expectedClaimIds.length > 0) {
      problems.push(`${query.queryId}: fence-phase query must not expect claims`);
    }
    if (query.phase === "main" && query.fencedClaimIds !== undefined) {
      problems.push(`${query.queryId}: main-phase query must not carry fenced claims`);
    }
  }

  // Fence probes exist for every forgotten claim (zero-leakage is measurable).
  const fencedProbes = new Set(
    [...queryById.values()].flatMap((query) => query.fencedClaimIds ?? []),
  );
  for (const claim of corpus.claims) {
    if (claim.forgottenOnTurnId && !fencedProbes.has(claim.claimId)) {
      problems.push(`${claim.claimId}: forgotten but never probed post-forget`);
    }
  }

  // Every planted (non-distractor) claim is probed at least once.
  const probedClaims = new Set(
    [...queryById.values()].flatMap((query) => query.expectedClaimIds),
  );
  for (const claim of planted) {
    if (!probedClaims.has(claim.claimId)) {
      problems.push(`${claim.claimId}: planted claim is never probed by any query`);
    }
  }

  // Language allocation (en / zh / mix) for queries.
  const queryLocales = new Set(
    corpus.turns.filter((turn) => turn.query).map((turn) => turn.locale),
  );
  for (const locale of ["zh", "en", "mix"] as const) {
    if (!queryLocales.has(locale)) problems.push(`no ${locale} query in the corpus`);
  }

  // Session layout rule: within a session, queries precede statements so the
  // probe's prior-exchange sources stay probe-only.
  const bySession = new Map<string, CorpusTurnSpec[]>();
  for (const turn of corpus.turns) {
    const key = `${turn.day}:${turn.session}`;
    bySession.set(key, [...(bySession.get(key) ?? []), turn]);
  }
  for (const [key, turns] of bySession) {
    let sawStatement = false;
    for (const turn of turns) {
      if (turn.role === "statement") sawStatement = true;
      if (turn.role === "query" && sawStatement) {
        problems.push(`${key}:${turn.turnId}: query follows a statement in the same session`);
      }
    }
  }

  return problems;
}

/**
 * Compile locale for a retrieval run of a query: "mix" resolves to zh when
 * the text contains CJK (the deterministic majority script), else en.
 */
export function compileLocaleOf(locale: CorpusLocale, text: string): "zh" | "en" {
  if (locale === "zh" || locale === "en") return locale;
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
}
