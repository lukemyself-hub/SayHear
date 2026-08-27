/**
 * Predicate Registry types (architecture §7.10.1, grilling #93 decisions,
 * SPEC #107 "Predicate Registry v1"). The Registry is SayHear's own versioned
 * controlled semantic vocabulary: the model maps natural language INTO the
 * Registry and may never create or modify a Predicate ID. Everything here is
 * code-owned immutable data — there is no CRUD surface.
 *
 * Natural-language material is separated from machine identity exactly as
 * §7.10.1 requires: `PredicateRegistryEntry` carries only schema / policy /
 * semantics; per-locale labels, definitions, seed examples, projection
 * templates, and lexical surfaces live in localizations keyed by predicate ID.
 */

export const PREDICATE_REGISTRY_SUBJECT_KIND_SELF = "sh.entity.person";

export type PredicateStatus = "active" | "deprecated" | "retired";

export type SensitivityClass = "standard" | "sensitive";

export type ClaimKind = "objective" | "impression";

export type ValueCardinality = "single" | "multiple";

export type TemporalStatusSupport =
  /** Long-term stable: no current/ended transition machinery. */
  | "stable"
  /** Supports current and ended with unknown or approximate boundaries kept. */
  | "current_ended";

export type TemporalSemantics = Readonly<{
  temporalStatuses: readonly TemporalStatusSupport[];
  /**
   * Missing or approximate boundaries keep their precision; the Registry never
   * forces exact dates (ADR-0030 discipline).
   */
  boundaryPrecision: "preserved";
  /** For relationships: which Resolver Hint projections are allowed. */
  resolverHintProjections?: Readonly<{
    current: boolean;
    former: boolean;
  }>;
}>;

export type RelationshipDirection = "directed" | "symmetric";

export type RelationshipProjectionView = "forward" | "inverse" | "symmetric";

/**
 * Qualifier axis for relationship entries (ADR-0033 evidence-backed
 * qualifiers): each axis is a canonical side + typed value + cardinality with
 * its own evidence policy; neutral fallback wording is part of the axis so
 * projections can always degrade gracefully without inventing roles.
 */
export type QualifierAxisSchema = Readonly<{
  axisId: string;
  appliesToRole:
    | "canonical_subject"
    | "counterpart"
    | "either";
  valueSchema: ObjectValueSchema;
  cardinality: ValueCardinality;
  evidencePolicyId: string;
  neutralFallbackZh: string;
  neutralFallbackEn: string;
}>;

export type RelationshipSemantics = Readonly<{
  direction: RelationshipDirection;
  /**
   * directed only: canonical subject role convention. Mention order, surface
   * grammar, and observer perspective never override this.
   */
  canonicalSubjectRole?: string;
  canonicalObjectRole?: string;
  /** symmetric only: stable unordered Entity pair normalization. */
  pairNormalization?: "unordered_entity_pair";
  /** Which localized projection views this entry publishes. */
  views: readonly RelationshipProjectionView[];
  qualifierAxes: readonly QualifierAxisSchema[];
}>;

export type EnumValueSpec = Readonly<{
  /** Canonical typed value id stored on Claims. */
  value: string;
  /** zh surface spellings normalized onto `value`. */
  zh: readonly string[];
  /** en surface spellings normalized onto `value` (case-insensitive). */
  en: readonly string[];
}>;

export type TextValueNormalization = Readonly<{
  kind: "text";
  /** NFC fold, trim, collapse internal whitespace; case otherwise preserved. */
  normalization: "nfc_trim_collapsed";
}>;

export type EnumValueNormalization = Readonly<{
  kind: "enum";
  values: readonly EnumValueSpec[];
  /** Closed set: unknown spellings fail closed instead of being coerced. */
  closedSet: true;
}>;

export type SentimentValueNormalization = Readonly<{
  kind: "sentiment";
  polarities: readonly ("positive" | "negative")[];
}>;

export type ObjectValueSchema =
  | TextValueNormalization
  | EnumValueNormalization
  | SentimentValueNormalization;

export type ScopeSchema =
  | Readonly<{ kind: "none" }>
  /** A closed category enum carried as scope, e.g. sh.plan.life_change. */
  | Readonly<{ kind: "enum"; values: readonly EnumValueSpec[] }>
  /** Free short text as scope, e.g. teacher 学段/科目, project name. */
  | Readonly<{ kind: "short_text"; label: string }>;

/** Typed surface of one published lexical alias used by deterministic mapping. */
export type LexicalSurface = Readonly<{
  text: string;
  locale: "zh" | "en";
  /**
   * Which claim node the surface names when anchored to Self: surfaces that
   * denote the canonical subject holder (`妈妈`, `婆婆`, `领导`, `老师`) versus
   * surfaces denoting the counterpart side (`儿子`, `儿媳`, `学生`, `下属`).
   * Symmetric predicates use `peer`.
   */
  roleSide: "canonical_subject_denoter" | "counterpart_denoter" | "peer";
  form: "current" | "former";
}>;

/**
 * Bilingual natural-language material for one Predicate (§7.10.1
 * `predicate_localizations`). Positive/negative examples are also the seeded
 * corpus floor consumed by the mapping-eval matrix: ≥2 positive + ≥2 negative
 * per locale (grilling #93 §8–§9).
 */
export type PredicateLocalization = Readonly<{
  predicateId: string;
  locale: "zh" | "en";
  label: string;
  definition: string;
  positiveExamples: readonly string[];
  negativeExamples: readonly string[];
  localizationVersion: number;
  /** Published alias surface feeding mapping lane and retrieval lane material. */
  lexicalSurfaces: readonly LexicalSurface[];
}>;

/**
 * Localized projection templates for one view direction of a relationship
 * entry (§7.10.1 `relationship_projection_localizations`). Former forms and
 * all neutral fallbacks are explicit so projection never fabricates roles.
 */
export type RelationshipProjectionLocalization = Readonly<{
  predicateId: string;
  locale: "zh" | "en";
  viewDirection: RelationshipProjectionView;
  /** Template phrases; {subject}/{object} placeholders are replaced verbatim. */
  templates: readonly string[];
  /** Former-form templates, e.g. 前女友 / ex-girlfriend / 前室友. */
  formerTemplates: readonly string[];
  roleProjectionVersion: number;
}>;

export type PredicateRelationType =
  | "confusable_with"
  | "broader"
  | "narrower"
  | "replaced_by";

export type PredicateRelation = Readonly<{
  predicateId: string;
  relatedPredicateId: string;
  relationType: PredicateRelationType;
}>;

/**
 * One Registry Entry per §7.10.1. Machine identity only — all human-readable
 * material lives in `PredicateLocalization`.
 */
export type PredicateRegistryEntry = Readonly<{
  predicateId: string;
  registryVersion: number;
  definitionVersion: number;
  status: PredicateStatus;
  allowedClaimKinds: readonly ClaimKind[];
  sensitivityClass: SensitivityClass;
  /** sh.entity.person (Self) everywhere in v1; relationships still require both parties bound. */
  allowedSubjectKindIds: readonly string[];
  objectValueSchema: ObjectValueSchema;
  scopeSchema: ScopeSchema;
  valueCardinality: ValueCardinality;
  temporalSemantics: TemporalSemantics;
  relationshipSemantics: RelationshipSemantics | null;
  evidencePolicyId: string;
  /** Required whenever allowed_claim_kinds includes impression. */
  reviewPolicyId: string | null;
  replacedByPredicateId: string | null;
}>;

/** Version-addressed immutable snapshot of a released Registry. */
export type PredicateRegistrySnapshot = Readonly<{
  registryVersion: number;
  entries: readonly PredicateRegistryEntry[];
  localizations: readonly PredicateLocalization[];
  relationshipProjections: readonly RelationshipProjectionLocalization[];
  relations: readonly PredicateRelation[];
}>;
