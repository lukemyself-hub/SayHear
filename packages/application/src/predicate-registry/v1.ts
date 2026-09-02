import { createHash } from "node:crypto";

import type {
  LexicalSurface,
  ObjectValueSchema,
  PredicateRegistrySnapshot,
} from "./types";
import { buildRegistryV1Entries } from "./v1-entries";
import {
  buildLocalizationsV1,
  buildProjectionsV1,
  buildRelationsV1List,
} from "./v1-localizations";

/** Machine identities of the 24 v1 entries (#93). */
export const PREDICATE_IDS = Object.freeze({
  partnerOf: "sh.relationship.partner_of",
  parentOf: "sh.relationship.parent_of",
  siblingOf: "sh.relationship.sibling_of",
  friendOf: "sh.relationship.friend_of",
  colleagueOf: "sh.relationship.colleague_of",
  managerOf: "sh.relationship.manager_of",
  relativeOf: "sh.relationship.relative_of",
  inLawOf: "sh.relationship.in_law_of",
  teacherOf: "sh.relationship.teacher_of",
  roommateOf: "sh.relationship.roommate_of",
  employer: "sh.work.employer",
  roleTitle: "sh.work.role_title",
  projectParticipation: "sh.project.participation",
  residence: "sh.place.residence",
  hometown: "sh.place.hometown",
  workplace: "sh.place.workplace",
  lifeChange: "sh.plan.life_change",
  careerStage: "sh.life.career_stage",
  familyStage: "sh.life.family_stage",
  relationshipHorizon: "sh.preference.relationship_horizon",
  businessTravel: "sh.preference.business_travel",
  statedStyle: "sh.communication.stated_style",
  corePriorities: "sh.value.core_priorities",
  considerationStyle: "sh.decision.consideration_style",
} as const);

export const PREDICATE_REGISTRY_VERSIONS = Object.freeze({
  1: true,
  2: true,
} as const);

/**
 * Runtime callers stay pinned to v1 until an explicit production cutover.
 * Published v2 is addressed by its snapshot so governance replay cannot
 * change the version used by an already deployed extraction path.
 */
export const PREDICATE_REGISTRY_RUNTIME_VERSION = 1 as const;

const snapshots = new Map<number, PredicateRegistrySnapshot>();

export function loadPredicateRegistrySnapshot(
  registryVersion: number,
): PredicateRegistrySnapshot {
  const cached = snapshots.get(registryVersion);
  if (cached) {
    return cached;
  }
  if (registryVersion !== 1 && registryVersion !== 2) {
    throw new Error(
      `Unknown predicate registry_version ${registryVersion}: only published versions ${Object.keys(PREDICATE_REGISTRY_VERSIONS).join(", ")} can be loaded. Mapping against an unknown version must fail closed.`,
    );
  }
  const snapshot = deepFreeze(
    registryVersion === 1
      ? {
          registryVersion,
          entries: buildRegistryV1Entries(),
          localizations: buildLocalizationsV1(),
          relationshipProjections: buildProjectionsV1(),
          relations: buildRelationsV1List(),
        }
      : buildRegistryV2Snapshot(),
  ) satisfies PredicateRegistrySnapshot;
  snapshots.set(registryVersion, snapshot);
  return snapshot;
}

/**
 * Registry v2 is a copy-on-write release. The machine vocabulary and all v1
 * material remain available under their original version; only the English
 * Friendship material and its state-oriented projections change here. Keeping
 * the release derived from the frozen v1 snapshot makes accidental historical
 * drift visible in the v2 fingerprint and keeps old replay inputs addressable.
 */
function buildRegistryV2Snapshot(): PredicateRegistrySnapshot {
  const v1 = loadPredicateRegistrySnapshot(1);

  const entries = v1.entries.map((entry) => {
    if (entry.predicateId !== PREDICATE_IDS.friendOf) {
      return { ...entry, registryVersion: 2 };
    }
    const relationshipSemantics = entry.relationshipSemantics;
    return {
      ...entry,
      registryVersion: 2,
      relationshipSemantics: relationshipSemantics
        ? {
            ...relationshipSemantics,
            qualifierAxes: relationshipSemantics.qualifierAxes.map((axis) =>
              axis.axisId === "relation_origin"
                ? { ...axis, neutralFallbackEn: "friendship" }
                : axis,
            ),
          }
        : null,
    };
  });

  const localizations = v1.localizations.map((localization) => {
    if (
      localization.predicateId !== PREDICATE_IDS.friendOf ||
      localization.locale !== "en"
    ) {
      return localization;
    }
    const friendshipSurfaces: readonly LexicalSurface[] = [
      {
        text: "friendship",
        locale: "en",
        roleSide: "peer",
        form: "current",
      },
      {
        text: "friends",
        locale: "en",
        roleSide: "peer",
        form: "current",
      },
      ...localization.lexicalSurfaces,
    ];
    return {
      ...localization,
      label: "Friendship",
      definition:
        "Symmetric Friendship between the user and another person. State phrasing such as friends and friendship maps here; stated closeness (bestie/best friend, good/close friend, casual friend) remains a qualifier. An origin mention alone (for example, neighbor) never states Friendship.",
      positiveExamples: [
        "Alex and I are friends from college; our friendship has lasted for years.",
        "Jamie is my friend, and our friendship is steady and easy.",
      ],
      lexicalSurfaces: friendshipSurfaces,
      localizationVersion: 2,
    };
  });

  const relationshipProjections = v1.relationshipProjections.map((projection) => {
    if (
      projection.predicateId !== PREDICATE_IDS.friendOf ||
      projection.locale !== "en"
    ) {
      return projection;
    }
    return {
      ...projection,
      templates: [
        "{subject} and {object} share a friendship",
        "{subject} and {object} are friends",
      ],
      formerTemplates: ["{subject} and {object} used to be friends"],
      roleProjectionVersion: 2,
    };
  });

  return {
    registryVersion: 2,
    entries,
    localizations,
    relationshipProjections,
    relations: v1.relations,
  };
}

/**
 * Canonical deterministic fingerprint of a released snapshot: the replay
 * script and the old-version replay gate pin releases by this hash.
 */
export function predicateRegistryFingerprint(
  snapshot: PredicateRegistrySnapshot,
): string {
  return createHash("sha256")
    .update(canonicalJson(snapshot))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Normalized typed value for an entry's object value schema (§7.10.1 runtime
 * mapping steps 4–5). Text values NFC-fold + trim + collapse whitespace; enum /
 * sentiment spellings normalize onto their canonical id and fail closed on
 * anything outside the closed set.
 */
export function normalizeTypedValue(
  schema: ObjectValueSchema,
  raw: string,
  locale: "zh" | "en",
): { ok: true; value: string } | { ok: false; reason: string } {
  if (schema.kind === "text") {
    return {
      ok: true,
      value: raw.normalize("NFC").trim().replace(/\s+/g, " "),
    };
  }
  const needle = raw.normalize("NFC").trim().toLowerCase();
  if (schema.kind === "sentiment") {
    // exact-spelling lookup over the shared ordered table
    const table = SENTIMENT_POLARITY_TABLES[locale];
    const hit = table.find((row) => row.spelling.toLowerCase() === needle);
    const value = hit?.polarity;
    return value
      ? { ok: true, value }
      : {
          ok: false,
          reason: `Sentiment spelling "${raw}" is outside the closed polarity set for this entry.`,
        };
  }
  const spec = schema.values.find((candidate) =>
    [...candidate.zh, ...candidate.en].some(
      (spelling) => spelling.toLowerCase() === needle,
    ),
  );
  return spec
    ? { ok: true, value: spec.value }
    : {
        ok: false,
        reason: `Enum spelling "${raw}" is not part of the closed set for this predicate (locale ${locale}).`,
      };
}

export type SentimentPolarityEntry = {
  spelling: string;
  polarity: "positive" | "negative";
};

/**
 * Single source of truth for sentiment-polarity spellings (#93 §4/§20-21).
 * Ordered negatives-first so substring containment (不喜欢 inside 不太喜欢
 * semantics) resolves to the negated reading; both `normalizeTypedValue` and
 * the mapper's contextual polarity scan consume this one table.
 */
const SENTIMENT_POLARITY_TABLES_UNFROZEN: Record<
  "zh" | "en",
  readonly SentimentPolarityEntry[]
> = {
  zh: [
    { spelling: "讨厌", polarity: "negative" },
    { spelling: "不想", polarity: "negative" },
    { spelling: "不愿意", polarity: "negative" },
    { spelling: "不喜欢", polarity: "negative" },
    { spelling: "不太喜欢", polarity: "negative" },
    { spelling: "排斥", polarity: "negative" },
    { spelling: "喜欢", polarity: "positive" },
    { spelling: "享受", polarity: "positive" },
    { spelling: "可以接受", polarity: "positive" },
    { spelling: "愿意", polarity: "positive" },
  ],
  en: [
    { spelling: "hates", polarity: "negative" },
    { spelling: "dislikes", polarity: "negative" },
    { spelling: "avoids", polarity: "negative" },
    { spelling: "hate", polarity: "negative" },
    { spelling: "dislike", polarity: "negative" },
    { spelling: "avoid", polarity: "negative" },
    { spelling: "enjoys", polarity: "positive" },
    { spelling: "enjoy", polarity: "positive" },
    { spelling: "likes", polarity: "positive" },
    { spelling: "fine with", polarity: "positive" },
    { spelling: "open to", polarity: "positive" },
    { spelling: "love", polarity: "positive" },
  ],
};

export const SENTIMENT_POLARITY_TABLES = Object.freeze(
  SENTIMENT_POLARITY_TABLES_UNFROZEN,
);
