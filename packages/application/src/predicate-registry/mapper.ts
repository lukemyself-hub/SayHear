import {
  normalizeTypedValue,
  PREDICATE_IDS,
  SENTIMENT_POLARITY_TABLES,
} from "./v1";
import { loadPredicateRegistrySnapshot } from "./v1";
import type {
  ClaimKind,
  PredicateRegistrySnapshot,
} from "./types";

/**
 * Deterministic mapping engine for the Predicate Registry (architecture
 * §7.10.1 runtime-mapping discipline, grilling #93 §8). This module owns the
 * mechanical half of natural-language → Registry mapping:
 *
 *  - a bounded surface matcher over the published lexical alias list, with
 *    longest-match ownership so near-form substrings never leak;
 *  - an enumerated frame table (six zh / five en constructions per decision §8)
 *    that assigns participants and canonicalizes direction — mention order,
 *    grammar role, and observer perspective never override registry roles;
 *  - anchor value capture producing normalized typed values;
 *  - the server-side proposal revalidation half: status / claim-kind / value /
 *    scope checks failing closed on anything unknown, deprecated, or illegal.
 *
 * It deliberately does NOT model open-ended language understanding: utterances
 * outside the published surfaces and frames resolve to `ambiguous`/
 * `unmapped` deterministically, and unknown or deferred concepts never fold
 * into a near-synonym predicate. The `memory.extract` LLM gate lands later;
 * when it does, this resolver stays the deterministic validation target whose
 * behavior the frozen-model replay pins before every release (ADR-0061).
 */

export type MappingInput = {
  text: string;
  locale: "zh" | "en";
  /** Pinned extraction version; defaults to the loaded snapshot's version. */
  registryVersion?: number;
  /** Snapshot override (tests inject legacy overlays here). */
  snapshot?: PredicateRegistrySnapshot;
  /**
   * Code-switching mode: match published surfaces from both locales
   * (ADR-0072), while the frame table still follows `locale`.
   */
  codeSwitch?: boolean;
};

export type RelationshipMapping =
  | { direction: "symmetric"; pairNormalization: "unordered_entity_pair" }
  | { direction: "directed"; subject: string; object: string };

export type MappingOutcome =
  | {
      status: "mapped";
      predicateId: string;
      claimKind: ClaimKind;
      /** Normalized typed value; "" for pure relationship mappings. */
      typedValue: string;
      scopeValue: string | null;
      form: "current" | "former";
      /** Surface-extracted person reference for relationship frames. */
      otherPerson?: string;
      relationship?: RelationshipMapping;
    }
  | { status: "ambiguous"; reason: string }
  | {
      status: "unmapped";
      reason?: string;
      proposedConcept: {
        description: string;
        suggestedObjectSchema: string;
      } | null;
    };

export type MappedOutcome = Extract<MappingOutcome, { status: "mapped" }>;

/** Deferred relationship concepts (#93 §7): always unmapped→review. */
const DEFERRED_CONCEPTS: readonly {
  termsZh: readonly string[];
  termsEn: readonly string[];
  description: string;
}[] = [
  {
    termsZh: ["邻居"],
    termsEn: ["neighbor"],
    description:
      "Neighbor relationship (deferred concept #93): non-familial residential adjacency.",
  },
  {
    termsZh: ["业务伙伴", "合作伙伴"],
    termsEn: ["business partner", "partner at work"],
    description:
      "Business partnership between two people (deferred concept #93).",
  },
  {
    termsZh: ["客户", "顾客"],
    termsEn: ["client", "customer"],
    description: "Client/customer relationship (deferred concept #93).",
  },
  {
    termsZh: ["干亲", "干爹", "干妈", "教子", "教女"],
    termsEn: ["godparent", "godfather", "godmother"],
    description:
      "Sworn/ritual kinship (干亲、教子; godparent ties) deferred to governance review.",
  },
  {
    termsZh: ["房东", "租客"],
    termsEn: ["landlord", "tenant"],
    description: "Landlord–tenant relationship (deferred concept #93).",
  },
  {
    termsZh: ["暧昧", "恋人未满"],
    termsEn: ["romantic ambiguity"],
    description:
      "Pre-partner romantic ambiguity (暧昧/恋人未满) left unstructured by decision.",
  },
];

export function mapUtterance(input: MappingInput): MappingOutcome {
  const snapshot = input.snapshot ?? loadPredicateRegistrySnapshot(1);
  const text = input.text.normalize("NFC");
  const locale = input.locale;
  const clauses = splitClauses(text);

  // Deferred concepts are checked first and win unconditionally (#93 §7):
  // encountering them is unmapped→review, never an inference to a published
  // near-synonym whose surface might otherwise substring-match inside the
  // deferred phrase (干弟弟 must not surface 弟弟→sibling_of).
  const deferred = findDeferredConcept(text, locale);
  if (deferred) {
    return {
      status: "unmapped",
      proposedConcept: {
        description: deferred.description,
        suggestedObjectSchema: "person-pair relationship qualifier text",
      },
    };
  }

  const relationship = tryRelationship(
    snapshot,
    clauses,
    locale,
    input.codeSwitch === true,
  );
  if (relationship) {
    return relationship.outcome;
  }

  const value = tryValuePredicates(snapshot, clauses, locale);
  if (value) {
    return value;
  }

  // Unknown RELATIONAL concepts get a governance-bound proposal (#93 §8
  // "unknown concepts return unmapped with proposed concept"); ordinary
  // narration with no pair-shape is simply not a concept, so no proposal.
  if (looksRelational(text)) {
    const trimmed = text.trim().slice(0, 40);
    return {
      status: "unmapped",
      reason: "No published surface or supported frame in this utterance.",
      proposedConcept: {
        description: `Unrecognized relational concept in: ${trimmed}`,
        suggestedObjectSchema: "person-pair relationship qualifier text",
      },
    };
  }
  return {
    status: "unmapped",
    reason: "No published surface or supported frame in this utterance.",
    proposedConcept: null,
  };
}

const RELATIONAL_HINT_ZH = /是我的|和我|跟我|与我|关系|算是|算是我的|属于/;
const RELATIONAL_HINT_EN = /\bmy\s+[a-z][a-z'-]*\b|\brelationship\b/i;

function looksRelational(text: string): boolean {
  return (
    RELATIONAL_HINT_ZH.test(text) || RELATIONAL_HINT_EN.test(text)
  );
}

/**
 * Cross-locale (code-switching) resolution: run the deterministic pipeline
 * under both locales and require agreement. Exactly one mapped pass, or both
 * passes mapping the same predicate to the same canonical key, is accepted;
 * two different predicates is a contradiction and resolves ambiguous.
 */
export function mapUtteranceCodeSwitch(
  text: string,
  options?: Omit<MappingInput, "text" | "locale">,
): MappingOutcome & { locale?: "zh" | "en" } {
  const zh = mapUtterance({
    ...options,
    text,
    locale: "zh",
    codeSwitch: true,
  });
  if (zh.status === "mapped") {
    return { ...zh, locale: "zh" };
  }
  const en = mapUtterance({
    ...options,
    text,
    locale: "en",
    codeSwitch: true,
  });
  if (en.status === "mapped") {
    return { ...en, locale: "en" };
  }
  // A deferred-concept unmapped outcome (with proposed concept) outranks the
  // other pass's frame-ambiguous verdict — the concept DID appear.
  for (const outcome of [zh, en]) {
    if (
      outcome.status === "unmapped" &&
      outcome.proposedConcept !== null
    ) {
      return { ...outcome };
    }
  }
  if (zh.status === "ambiguous") {
    return { status: "ambiguous", reason: zh.reason };
  }
  if (en.status === "ambiguous") {
    return { status: "ambiguous", reason: en.reason };
  }
  return { status: "unmapped", proposedConcept: null };
}

// ── clause handling ────────────────────────────────────────────────────────

const SENTENCE_SPLIT = /[。；！？!?;；\n]+|[,，、]+(?=[\u4e00-\u9fa5])|[—–]+|,\s+(?=[A-Z])/;

function splitClauses(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

type SurfaceHit = {
  predicateId: string;
  text: string;
  form: "current" | "former";
  roleSide: "canonical_subject_denoter" | "counterpart_denoter" | "peer";
  /** Byte offset of the hit inside the clause (for head-noun preference). */
  index: number;
};

function findSurfaceHits(
  snapshot: PredicateRegistrySnapshot,
  clause: string,
  locale: "zh" | "en",
  allowAnyLocale = false,
): SurfaceHit[] {
  const hits: SurfaceHit[] = [];
  const lowerClause = clause.toLowerCase();
  for (const loc of snapshot.localizations) {
    if (!allowAnyLocale && loc.locale !== locale) continue;
    for (const surface of loc.lexicalSurfaces) {
      if (!allowAnyLocale && surface.locale !== locale) continue;
      const needle = surface.text.toLowerCase();
      let position = lowerClause.indexOf(needle);
      while (position >= 0) {
        hits.push({
          predicateId: loc.predicateId,
          text: surface.text,
          form: surface.form,
          roleSide: surface.roleSide,
          index: position,
        });
        break; // one hit per surface per clause keeps ownership deterministic
      }
    }
  }
  return hits;
}

/**
 * Head-noun-wins disambiguation with containment precedence: hits lying
 * INSIDE another longer hit (朋友 inside 男朋友, friend inside girlfriend)
 * always lose to their container; otherwise the asserted relation is the
 * clause-head — the surviving hit closest to the end; ties break on length,
 * then stable ID.
 */
function bestSurface(hits: SurfaceHit[]): SurfaceHit | null {
  if (hits.length === 0) return null;
  const contained = hits.filter((h) =>
    hits.some(
      (o) =>
        o !== h &&
        o.text.length > h.text.length &&
        h.index >= o.index &&
        h.index < o.index + o.text.length,
    ),
  );
  const survivors = hits.filter((h) => !contained.includes(h));
  const pool = survivors.length > 0 ? survivors : hits;
  const sorted = [...pool].sort(
    (a, b) =>
      b.index - a.index ||
      b.text.length - a.text.length ||
      a.predicateId.localeCompare(b.predicateId),
  );
  return sorted[0] ?? null;
}

/** True when the utterance talks about the user themself (Self-scoped). */
/**
 * Third-person subject detection for Self-scoped value lanes (all v1 entries
 * allow only the Self person as subject). Chinese drops subjects constantly,
 * so an explicit third party — 他/她/他们 or English third-person pronouns —
 * is what blocks a claim, never the mere absence of “我”.
 */
const THIRD_PERSON_SUBJECT =
  /(?:^|[，。、,\s])(?:他|她|它|他们|她们)[一-龥A-Za-z ]{0,12}/;

function mentionsThirdPersonSubject(text: string): boolean {
  if (THIRD_PERSON_SUBJECT.test(text)) return true;
  return /\b(?:she|he|they|her|hers|him)\b/i.test(text);
}

function isSelfScoped(text: string): boolean {
  return !mentionsThirdPersonSubject(text);
}

// ── relationship frames ────────────────────────────────────────────────────

/**
 * Frame shapes — the only three grammatical constructions that assign
 * participants, per locale. Whichever party the surface noun denotes holds the
 * role its `roleSide` names; mention order and observer perspective never
 * override registry roles.
 *
 *  possessive : 我(的)S / my S              → other party holds the slot
 *  speaker    : 我是X的S / I am X's S       → SELF holds the slot, X is the pair
 *  copula     : X是我的S / X is my S        → X holds the slot
 */
type FrameShape = "possessive" | "speaker" | "copula";

type PersonAssignment = {
  shape: FrameShape;
  /** The named counterpart extracted from the utterance (never "self"). */
  other: string;
};

const ZH_PRONOUNS = /^(他|她|他们|她们|它|对方|他们俩)$/;
/** Names that actually denote the speaker — never a relationship counterpart. */
const ZH_SELF_NAMES = /^(我|我们|自己|咱|咱们)$/;

function isPartyName(name: string): boolean {
  return (
    name.length > 0 &&
    !ZH_SELF_NAMES.test(name) &&
    // a counterpart mention can never contain speaker/particle characters
    !/[我和自己]/.test(name)
  );
}
const ZH_NAME = "(他|她|他们|她们|它|对方|[\\u4e00-\\u9fa5A-Za-z·]{1,6})";

function tryRelationship(
  snapshot: PredicateRegistrySnapshot,
  clauses: string[],
  locale: "zh" | "en",
  allowAnyLocale = false,
): { outcome: MappingOutcome } | null {
  for (let index = 0; index < clauses.length; index += 1) {
    const clause = clauses[index] ?? "";
    const hit = bestSurface(
      findSurfaceHits(snapshot, clause, locale, allowAnyLocale),
    );
    if (!hit) continue;
    const entry = snapshot.entries.find((e) => e.predicateId === hit.predicateId);
    if (!entry?.relationshipSemantics) continue; // value-class triggers handled below

    const assignment = assignPerson(clause, hit.text, locale, clauses);
    if (!assignment) {
      return {
        outcome: {
          status: "ambiguous",
          reason: `Relationship surface "${hit.text}" appears without a supported frame.`,
        },
      };
    }
    if (ZH_PRONOUNS.test(assignment.other)) {
      const carried = fallbackName(clauses);
      if (carried && !ZH_PRONOUNS.test(carried)) {
        assignment.other = carried;
      }
    }

    const rel = entry.relationshipSemantics;
    let subjectRef: string;
    let objectRef: string;
    if (rel.direction === "symmetric") {
      subjectRef = "self";
      objectRef = assignment.other;
    } else if (hit.roleSide === "canonical_subject_denoter") {
      // surface names whoever holds the canonical subject role
      subjectRef = holderOf(assignment);
      objectRef = counterpartOf(assignment);
    } else {
      // surface names the canonical-object side
      objectRef = holderOf(assignment);
      subjectRef = counterpartOf(assignment);
    }
    if (subjectRef === objectRef) {
      return {
        outcome: {
          status: "ambiguous",
          reason: "Both ends of the relation resolved to the same participant.",
        },
      };
    }

    return {
      outcome: {
        status: "mapped",
        predicateId: hit.predicateId,
        claimKind: "objective",
        typedValue: "",
        scopeValue: null,
        form: hit.form,
        otherPerson: assignment.other,
        relationship:
          rel.direction === "symmetric"
            ? { direction: "symmetric", pairNormalization: "unordered_entity_pair" }
            : { direction: "directed", subject: subjectRef, object: objectRef },
      },
    };
  }
  return null;
}

function participantOf(
  assignment: PersonAssignment,
  which: "holder" | "counterpart",
): string {
  if (which === "holder") {
    return assignment.shape === "speaker" ? "self" : assignment.other;
  }
  return assignment.shape === "speaker" ? assignment.other : "self";
}

function holderOf(assignment: PersonAssignment): string {
  return participantOf(assignment, "holder");
}
function counterpartOf(assignment: PersonAssignment): string {
  return participantOf(assignment, "counterpart");
}

/**
 * Frame table (deterministic subset): possessive-of-self assigns the OTHER
 * party to the slot; 我是X的S makes SELF hold it with X as the pair member;
 * NAME是S names X directly. Cross-clause carryover picks up earlier "我和NAME"
 * / "NAME and I" introductions when a pronoun stands in.
 */
function assignPerson(
  clause: string,
  surface: string,
  locale: "zh" | "en",
  allClauses: string[],
): PersonAssignment | null {
  const esc = escapeRegExp(surface);
  if (locale === "zh") {
    // tolerant interlude before the surface noun: 的 / 我最好的 / 同一组的 /
    // 我们家 / a space around latin loanwords, bounded to 8 filler chars
    const INT = `\\s*[^，。,、!?！？]{0,18}?`;
    const PREFIX = `.{0,16}?(?:我们家|我家|(?:我))的?`;
    // copula: NAME是（了）（一个）[修饰]S —— 她是我领导 / 小周是我最好的闺蜜
    let m = new RegExp(
      `^(?:是)?${ZH_NAME}\\s*(?:都)?(?:是|就是|算是|属于)(?:一个|一位)?${INT}${esc}`,
    ).exec(clause);
    if (m && isPartyName(m[1] ?? "")) {
      return { shape: "copula", other: resolveCarried(m[1] ?? "", allClauses) };
    }
    // 和-frame: 我和NAME……S; lazy name with a particle boundary so
    // 我和小李在一起三年了 captures 小李, not the whole clause
    m = new RegExp(
      `^(?:我|我们)(?:和|跟)([\\u4e00-\\u9fa5A-Za-z·]{1,8}?)(?=[在上是的了都也很一起着]|$)${INT}${esc}`,
    ).exec(clause);
    if (m) {
      return { shape: "copula", other: m[1] ?? "对方" };
    }
    // speaker describes self: 我是NAME的[修饰]S
    m = new RegExp(`^我是(.{1,14}?)的${INT}${esc}`).exec(clause);
    if (m) {
      return { shape: "speaker", other: resolveCarried(m[1] ?? "", allClauses) };
    }
    // possessive headless: 我妈妈 / 我的闺蜜 / 我们家儿媳妇 / 我前室友
    m = new RegExp(`${PREFIX}\\s*${INT}${esc}`).exec(clause);
    if (m) {
      return { shape: "possessive", other: resolveCarried("", allClauses) };
    }
    return null;
  }

  // en — CJK loanword surfaces have no ASCII word boundary, so \b wrappers
  // apply only on their latin-facing edges.
  const L = /^[\u4e00-\u9fa5]/.test(surface) ? "" : "\\b";
  // plural-tolerant tail: “my colleagues / direct reports” stay frame legal
  const R = /[\u4e00-\u9fa5]$/.test(surface) ? "" : "(?:s|es)?\\b";
  const GAP = `(?:[^\\s,.;:!?，。、！？]+\\s+){0,2}`;
  let m = new RegExp(
    `${L}([A-Z][\\w .'-]{0,18}) (?:is|are|was) (?:my|our) ${GAP}${esc}${R}`,
    "i",
  ).exec(clause);
  if (m) {
    return { shape: "copula", other: cleanEnName(m[1] ?? "") };
  }
  m = new RegExp(`${L}(?:my|our) (?:own )?${GAP}?${esc}${R}`, "i").exec(clause);
  if (m) {
    return { shape: "possessive", other: fallbackNameEn(allClauses) };
  }
  m = new RegExp(`${L}i(?:'m| am) (?:a |an |their |his |her )?${GAP}${esc}${R}`, "i").exec(clause);
  if (m) {
    return { shape: "speaker", other: fallbackNameEn(allClauses) };
  }
  m = new RegExp(`${L}i am (.{0,18}?)'s ${esc}${R}`, "i").exec(clause);
  if (m) {
    return { shape: "speaker", other: cleanEnName((m[1] ?? "").trim()) };
  }
  // named-and-i symmetric: "Rae and I are colleagues"
  m = new RegExp(
    `${L}([A-Z][A-Za-z'-]{0,14}) and i (?:are|were|used to be) (?:both )?(?:close )?${esc}${R}`,
    "i",
  ).exec(clause);
  if (m) {
    return { shape: "copula", other: cleanEnName(m[1] ?? "") };
  }
  return null;
}

function resolveCarried(rawName: string, allClauses: string[]): string {
  const name = rawName.trim();
  if (
    name.length > 0 &&
    !ZH_PRONOUNS.test(name) &&
    name !== "the" &&
    name !== "them"
  ) {
    return name;
  }
  const carriedZh = fallbackName(allClauses);
  if (carriedZh && carriedZh !== "对方" && !ZH_PRONOUNS.test(carriedZh)) {
    return carriedZh;
  }
  const carriedEn = fallbackNameEn(allClauses);
  if (carriedEn !== "them") return carriedEn;
  return name || "对方";
}

function fallbackName(clauses: string[]): string {
  for (const clause of clauses) {
    const m =
      /(?:我和|我跟)([\u4e00-\u9fa5A-Za-z·]{1,8}?)(?=[在上是的了都也很一起着]|$)/.exec(
        clause,
      );
    if (m && !/^我自己$/.test(m[1] ?? "")) return m[1] as string;
  }
  return "对方";
}

function fallbackNameEn(clauses: string[]): string {
  for (const clause of clauses) {
    const m = /\b([A-Z][\w'-]{1,15}) and i\b/i.exec(clause);
    if (m?.[1]) return m[1];
    const possessive = /\bwith my ([A-Z][\w'-]{1,15})\b/.exec(clause);
    if (possessive?.[1]) return possessive[1];
  }
  return "them";
}

function cleanEnName(raw: string): string {
  const trimmed = raw.trim().replace(/^(?:she|he|they|it)$/i, "");
  return trimmed.length > 0 ? trimmed : "them";
}

export function canonicalSymmetricKey(a: string, b: string): string {
  const pair = [a, b].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return `pair=[${pair.join(",")}]`;
}

export function canonicalDirectedKey(
  predicateId: string,
  subject: string,
  object: string,
): string {
  return `${predicateId}|subject=${subject}→object=${object}`;
}

/** Canonical stable identity for one mapped relationship fact. */
export function canonicalRelationshipKey(outcome: MappedOutcome): string {
  if (!outcome.relationship) {
    return `${outcome.predicateId}|${outcome.typedValue}`;
  }
  if (outcome.relationship.direction === "symmetric") {
    return `${outcome.predicateId}|${canonicalSymmetricKey(
      "self",
      outcome.otherPerson ?? "对方",
    )}`;
  }
  return canonicalDirectedKey(
    outcome.predicateId,
    outcome.relationship.subject,
    outcome.relationship.object,
  );
}

// ── value predicates (anchors, enums, plans, preferences, style) ───────────

type ValueRule = {
  predicateId: string;
  scopeFromEnumSpelling?: boolean;
  polarity?: boolean;
  requiresCue?: readonly string[];
  patternsZh: readonly RegExp[];
  patternsEn: readonly RegExp[];
  postProcess?: (raw: string) => string;
};

const stripParticles = (raw: string): string =>
  raw
    // drop bounded temporal tails (deterministic, documented in the matrix)
    .replace(
      /\s*\b(last month|last week|last year|this quarter|this week|next week|next month|until age ten|but works elsewhere)\b.*$/i,
      "",
    )
    .replace(/[的了，。、.!！?？\s]+$/u, "")
    .replace(/^(?:在|从|把|跟)/u, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/那边$/u, "")
    .trim();

const VALUE_RULES: readonly ValueRule[] = [
  {
    predicateId: PREDICATE_IDS.employer,
    patternsZh: [
      /(?:我|本人)(?:现在|目前|最近|去年|今年|上个月|刚|之前)?(?:都)?(?:在|去)([^，。,、]+?)上班/,
      /加入(?:了)?([^，。,、]{1,24}?)(?:这个|这家|个)?公司/,
      /我(?:去年|上个月|今年)?入职了([^，。,、]{1,24})/,
      /(?:我们公司|我公司|所在公司)(?:是|叫)([^，。,]+)/,
      /我从([^，。,、]{1,24}?)(?:离职|跳槽)/,
    ],
    patternsEn: [
      /\bi (?:currently )?(?:work|worked) at ([^.,;!?]+)/i,
      /\bi (?:just |have )?joined\b([^.,;!?]+)/i,
      /\bleft ([^.,;!?]+)/i,
    ],
    postProcess: stripParticles,
  },
  {
    predicateId: PREDICATE_IDS.roleTitle,
    patternsZh: [
      /我(?:现在|目前|之前的)?的(?:职位|岗位|头衔)(?:是|为)([^，。,]+)/,
      /title\s*(?:是|为)\s*([^，。,]+)/i,
    ],
    patternsEn: [/\bmy title is ([^.,;!?]+)/i, /\bi work as an? ([^.,;!?]+)/i],
    postProcess: stripParticles,
  },
  {
    predicateId: PREDICATE_IDS.projectParticipation,
    patternsZh: [
      /(?:负责|参与|加入)(?:了|进|着)?\s*([^，。,]{2,18}?)\s*(?:项目|project)/,
      /^(?:我们团队在做|我们在做)([^，。,]{2,18}?)(?:项目|$)/,
    ],
    patternsEn: [
      /\bon the ([\p{L}\p{N}\- ']{2,30}?) project\b/iu,
      /\bworking on the ([\p{L}\p{N}\- ']{2,30}?) project\b/iu,
    ],
    postProcess: stripParticles,
  },
  {
    predicateId: PREDICATE_IDS.residence,
    patternsZh: [
      /我住在([^，。,]+)/,
      /家住在?([^，。,]+)/,
      /(?:我们把)?家搬去了([^，。,]+)/,
      /(?:搬到了|搬到|定居)([^，。,]+)/,
    ],
    patternsEn: [
      /\b(?:i )?live in ([^.,;!?]+)/i,
      /\bwe moved to ([^.,;!?]+)/i,
      /\bbased in ([^.,;!?]+)/i,
    ],
    postProcess: stripParticles,
  },
  {
    predicateId: PREDICATE_IDS.hometown,
    patternsZh: [/老家(?:(?:就)?在|(?:就)?是)([^，。,]+)/, /家乡(?:(?:就)?在|(?:就)?是)([^，。,]+)/],
    patternsEn: [
      /\bhometown is ([^.,;!?]+)/i,
      /\bgrew up in ([^.,;!?]+)/i,
    ],
    postProcess: stripParticles,
  },
  {
    predicateId: PREDICATE_IDS.workplace,
    patternsZh: [
      /办公室(?:就)?(?:在|设于)([^，。,]+)/,
      /工位(?:在)([^，。,]+)/,
      /常驻([^，。,]+)/,
      /一周三天去([^，。,]+?)办公/,
    ],
    patternsEn: [
      /\boffice is in ([^.,;!?]+)/i,
      /\bin the ([\p{L}\p{N}'\- ]{2,40}?) office\b/iu,
      /\bon-site at ([^.,;!?]+)/i,
    ],
    postProcess: stripParticles,
  },
];

function findEntry(
  snapshot: PredicateRegistrySnapshot,
  predicateId: string,
) {
  return snapshot.entries.find((e) => e.predicateId === predicateId);
}

function enumScopeLookup(
  snapshot: PredicateRegistrySnapshot,
  predicateId: string,
  clause: string,
): string | null {
  const entry = findEntry(snapshot, predicateId);
  if (!entry || entry.scopeSchema.kind !== "enum") return null;
  const lowered = clause.toLowerCase();
  for (const spec of entry.scopeSchema.values) {
    const spellings = [...spec.zh, ...spec.en];
    if (spellings.some((spelling) => lowered.includes(spelling.toLowerCase()))) {
      return spec.value;
    }
  }
  return null;
}

function enumValueLookup(
  snapshot: PredicateRegistrySnapshot,
  predicateId: string,
  clause: string,
): { value: string; former: boolean } | null {
  const entry = findEntry(snapshot, predicateId);
  if (!entry || entry.objectValueSchema.kind !== "enum") return null;
  // Cross-language matching by design: enum spellings from BOTH locales are
  // candidates, so “想要 long term” resolves exactly like its monolingual
  // forms (ADR-0072 bilingual / code-switched validation).
  for (const spec of entry.objectValueSchema.values) {
    for (const spelling of [...spec.zh, ...spec.en]) {
      if (containsWord(clause.toLowerCase(), spelling.toLowerCase())) {
        return { value: spec.value, former: false };
      }
    }
  }
  return null;
}

function containsWord(haystack: string, needle: string): boolean {
  if (/^[\u4e00-\u9fa5]+$/.test(needle)) return haystack.includes(needle);
  return new RegExp(`(^|[^\\p{L}])${escapeRegExp(needle)}([^\\p{L}]|$)`, "u").test(
    haystack,
  );
}

const STATED_STYLE_CUES_ZH = [/我喜欢直接/, /直说/, /直接一点/, /沟通方式/];
const STATED_STYLE_CUES_EN = [
  /\bbe direct\b/i,
  /straightforward communication/i,
  /communication style/i,
];
const TRAVEL_CUES_ZH = [/出差/, /\b飞\b/];
const TRAVEL_CUES_EN = [
  /business travel/i,
  /business trips/i,
  /flying for work/i,
];


const HORIZON_CUE_ZH = /想(?:要)?找|想要|希望有|期待有|期待/;
const HORIZON_SURFACE_ZH = /长期/;
const HORIZON_CUE_EN = /\bwant\b|\bhoping for\b|\blooking for\b/i;
const HORIZON_SURFACE_EN = /\blong[- ]term\b|\blong term\b/i;

/**
 * Impression-class cue tables (#93 §5): vocabulary that signals a recurring
 * value/decision pattern. The emission is an impression-kind Candidate —
 * cross-session admission thresholds (ADR-0039) apply downstream, never here.
 */
const IMPRESSION_LANES: readonly {
  predicateId: string;
  cuesZh: readonly RegExp[];
  cuesEn: readonly RegExp[];
}[] = [
  {
    predicateId: PREDICATE_IDS.corePriorities,
    cuesZh: [/最重要/, /排第一/, /第一位/, /优先/],
    cuesEn: [/\bcomes first\b/i, /\bmatters most\b/i, /\bprioriti[sz]e\b/i],
  },
  {
    predicateId: PREDICATE_IDS.considerationStyle,
    cuesZh: [/做.{0,6}?决定/, /重大决定/, /利弊清单/, /权衡/],
    cuesEn: [/\bbig decisions?\b/i, /\bmaking decisions?\b/i, /pros and cons/i, /\bweighs? in\b/i],
  },
];

function tryValuePredicates(
  snapshot: PredicateRegistrySnapshot,
  clauses: string[],
  locale: "zh" | "en",
): MappingOutcome | null {
  // anchored text-value predicates
  for (const rule of VALUE_RULES) {
    const selfScopedOnly =
      rule.predicateId !== PREDICATE_IDS.lifeChange;
    if (selfScopedOnly && !isSelfScoped(clauses.join(""))) {
      continue;
    }
    for (const clause of clauses) {
      const patterns = locale === "zh" ? rule.patternsZh : rule.patternsEn;
      for (const pattern of patterns) {
        const match = pattern.exec(clause);
        if (match?.[1]) {
          const raw = rule.postProcess ? rule.postProcess(match[1]) : match[1].trim();
          const entry = findEntry(snapshot, rule.predicateId)!;
          const normalized = normalizeTypedValue(entry.objectValueSchema, raw, locale);
          if (!normalized.ok) {
            return { status: "ambiguous", reason: normalized.reason };
          }
          const former = detectFormer(clause, locale);
          return {
            status: "mapped",
            predicateId: rule.predicateId,
            claimKind: "objective",
            typedValue: normalized.value,
            scopeValue: null,
            form: former ? "former" : "current",
          };
        }
      }
    }
  }

  // Self-scoped stage / preference / style lanes: every one of these entries
  // has allowed_subject_kind_ids=[Self person], so third-person narration
  // (REV gates) must never emit a Self claim here. life_change participates:
  // plan statements legitimately speak for the household. Direct preference /
  // style requests (“有意见请直说”) are inherently first-person, so their cue
  // match doubles as self-scope evidence.
  const rest = clauses.join("");
  const styleLaneSelfEvidence =
    locale === "zh"
      ? [...STATED_STYLE_CUES_ZH].some((re) => re.test(rest))
      : [...STATED_STYLE_CUES_EN].some((re) => re.test(rest));
  if (!isSelfScoped(rest) && !styleLaneSelfEvidence) {
    return null;
  }
  for (const clause of clauses) {
    const lifeScope = enumScopeLookup(snapshot, PREDICATE_IDS.lifeChange, clause);
    if (lifeScope) {
      const entry = findEntry(snapshot, PREDICATE_IDS.lifeChange)!;
      const normalized = normalizeTypedValue(entry.objectValueSchema, clause, locale);
      if (!normalized.ok) {
        return { status: "ambiguous", reason: normalized.reason };
      }
      return {
        status: "mapped",
        predicateId: PREDICATE_IDS.lifeChange,
        claimKind: "objective",
        typedValue: normalized.value,
        scopeValue: lifeScope,
        form: "current",
      };
    }

    for (const [predicateId] of [
      [PREDICATE_IDS.careerStage],
      [PREDICATE_IDS.familyStage],
      [PREDICATE_IDS.relationshipHorizon],
    ] as const) {
      const stage = enumValueLookup(snapshot, predicateId, clause);
      if (stage) {
        const guard =
          predicateId === PREDICATE_IDS.relationshipHorizon
            ? // code-switching: cue and surface may each arrive in either
              // language (“想找一段 long term…”), so test both, require one of each.
              (HORIZON_CUE_ZH.test(clause) || HORIZON_CUE_EN.test(clause)) &&
              (HORIZON_SURFACE_ZH.test(clause) || HORIZON_SURFACE_EN.test(clause))
            : true;
        if (!guard) continue;
        return {
          status: "mapped",
          predicateId,
          claimKind: "objective",
          typedValue: stage.value,
          scopeValue: null,
          form: "current",
        };
      }
    }

    // business_travel sentiment requires cue + polarity
    const cue = locale === "zh"
      ? TRAVEL_CUES_ZH.some((re) => re.test(clause))
      : TRAVEL_CUES_EN.some((re) => re.test(clause));
    if (cue) {
      // shared ordered table (negatives-first) — same source the proposal
      // validator normalizes against, so mapping and validation cannot drift
      const table = SENTIMENT_POLARITY_TABLES[locale];
      const found = table.find((row) => clause.includes(row.spelling));
      if (found) {
        return {
          status: "mapped",
          predicateId: PREDICATE_IDS.businessTravel,
          claimKind: "objective",
          typedValue: found.polarity,
          scopeValue: null,
          form: "current",
        };
      }
    }

    // stated_style objective path
    const styleCue =
      locale === "zh"
        ? STATED_STYLE_CUES_ZH.some((re) => re.test(clause))
        : STATED_STYLE_CUES_EN.some((re) => re.test(clause));
    if (styleCue) {
      const entry = findEntry(snapshot, PREDICATE_IDS.statedStyle)!;
      const normalized = normalizeTypedValue(entry.objectValueSchema, stripParticles(clause), locale);
      if (!normalized.ok) {
        return { status: "ambiguous", reason: normalized.reason };
      }
      return {
        status: "mapped",
        predicateId: PREDICATE_IDS.statedStyle,
        claimKind: "objective",
        typedValue: normalized.value,
        scopeValue: null,
        form: "current",
      };
    }

    // impression-class lanes (#93 §5): recurring-signal vocabulary produces an
    // impression-kind candidate; admission thresholds stay downstream policy.
    for (const lane of IMPRESSION_LANES) {
      const cue =
        locale === "zh"
          ? lane.cuesZh.some((re) => re.test(clause))
          : lane.cuesEn.some((re) => re.test(clause));
      if (!cue) continue;
      const entry = findEntry(snapshot, lane.predicateId)!;
      const normalized = normalizeTypedValue(entry.objectValueSchema, stripParticles(clause), locale);
      if (!normalized.ok) {
        return { status: "ambiguous", reason: normalized.reason };
      }
      return {
        status: "mapped",
        predicateId: lane.predicateId,
        claimKind: "impression",
        typedValue: normalized.value,
        scopeValue: null,
        form: "current",
      };
    }
  }
  // Nothing fired in the value-class table; let the caller fall through to
  // deferred/unknown-concept handling.
  return null;
}

function detectFormer(clause: string, locale: "zh" | "en"): boolean {
  if (locale === "zh") {
    return /离职|跳槽|之前|以前|曾经|不再|已经离开/.test(clause);
  }
  return /\bleft\b|previously|used to|no longer/i.test(clause);
}

function findDeferredConcept(text: string, locale: "zh" | "en") {
  const lower = text.toLowerCase();
  for (const concept of DEFERRED_CONCEPTS) {
    const terms = locale === "zh" ? concept.termsZh : concept.termsEn;
    const hit = terms.some((term) =>
      locale === "zh"
        ? text.includes(term)
        : new RegExp(`(^|[^\\p{L}])${escapeRegExp(term)}([^\\p{L}]|$)`, "u").test(lower),
    );
    if (hit) {
      return concept;
    }
  }
  return null;
}

// ── server-side proposal revalidation (§7.10.1 runtime mapping step 5 & 8) ─

export type MappingProposalInput = {
  registryVersion: number;
  predicateId: string;
  /** Raw typed value surface; ignored for pure relationship proposals. */
  typedValueRaw: string;
  claimKind: ClaimKind;
  locale: "zh" | "en";
  scopeRaw?: string | null;
  /** Pre-canonicalized directed role assignment ("self" or a named ref). */
  participants?: { subject: string; object: string };
};

export type ProposalValidationResult =
  | { valid: true; canonicalKey: string }
  | {
      valid: false;
      errorCode:
        | "VERSION_MISMATCH"
        | "UNKNOWN_PREDICATE"
        | "DEPRECATED_PREDICATE"
        | "RETIRED_PREDICATE"
        | "CLAIM_KIND_NOT_ALLOWED"
        | "ILLEGAL_VALUE"
        | "SCOPE_ILLEGAL";
      detail: string;
    };

export function validateMappingProposal(
  snapshot: PredicateRegistrySnapshot,
  proposal: MappingProposalInput,
): ProposalValidationResult {
  if (proposal.registryVersion !== snapshot.registryVersion) {
    return {
      valid: false,
      errorCode: "VERSION_MISMATCH",
      detail: `Proposal pinned registry_version ${proposal.registryVersion}; loaded snapshot is ${snapshot.registryVersion}.`,
    };
  }
  const entry = snapshot.entries.find(
    (candidate) => candidate.predicateId === proposal.predicateId,
  );
  if (!entry) {
    return {
      valid: false,
      errorCode: "UNKNOWN_PREDICATE",
      detail: `Predicate ${proposal.predicateId} does not exist in registry_version ${snapshot.registryVersion}. Unknown IDs fail closed.`,
    };
  }
  if (entry.status === "deprecated") {
    return {
      valid: false,
      errorCode: "DEPRECATED_PREDICATE",
      detail: `Predicate ${proposal.predicateId} is deprecated${entry.replacedByPredicateId ? ` in favor of ${entry.replacedByPredicateId}` : ""}; new writes fail closed.`,
    };
  }
  if (entry.status === "retired") {
    return {
      valid: false,
      errorCode: "RETIRED_PREDICATE",
      detail: `Predicate ${proposal.predicateId} is retired; historical references only.`,
    };
  }
  if (!entry.allowedClaimKinds.includes(proposal.claimKind)) {
    return {
      valid: false,
      errorCode: "CLAIM_KIND_NOT_ALLOWED",
      detail: `Predicate ${proposal.predicateId} allows kinds [${entry.allowedClaimKinds.join(", ")}]; got ${proposal.claimKind}.`,
    };
  }
  if (entry.scopeSchema.kind === "enum") {
    const legal = proposal.scopeRaw
      ? entry.scopeSchema.values.some((spec) =>
          [...spec.zh, ...spec.en].some(
            (spelling) => spelling.toLowerCase() === proposal.scopeRaw!.toLowerCase(),
          ) || spec.value === proposal.scopeRaw,
        )
      : false;
    if (!legal) {
      return {
        valid: false,
        errorCode: "SCOPE_ILLEGAL",
        detail: "Scope spelling is not part of the closed set for this predicate.",
      };
    }
  }
  if (!entry.relationshipSemantics && proposal.typedValueRaw !== "") {
    const normalized = normalizeTypedValue(
      entry.objectValueSchema,
      proposal.typedValueRaw,
      proposal.locale,
    );
    if (!normalized.ok) {
      return { valid: false, errorCode: "ILLEGAL_VALUE", detail: normalized.reason };
    }
  }
  let canonicalKey: string;
  if (entry.relationshipSemantics?.direction === "directed" && proposal.participants) {
    canonicalKey = canonicalDirectedKey(
      entry.predicateId,
      proposal.participants.subject,
      proposal.participants.object,
    );
  } else if (entry.relationshipSemantics?.direction === "symmetric" && proposal.participants) {
    canonicalKey = `${entry.predicateId}|${canonicalSymmetricKey(
      proposal.participants.subject,
      proposal.participants.object,
    )}`;
  } else {
    canonicalKey = `${entry.predicateId}|${proposal.typedValueRaw.normalize("NFC").trim()}`;
  }
  return { valid: true, canonicalKey };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
