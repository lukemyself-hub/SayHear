import type { MemoryClaimId, MemoryClaimVersionId } from "@sayhear/domain";

import type {
  PredicateRegistryEntry,
  PredicateLocalization,
  RelationshipProjectionLocalization,
} from "./predicate-registry/types";
import type {
  ClaimVersionQualifierRecord,
  QualifierRoleSide,
  TemporalBounds,
} from "./memory-claim/types";

/**
 * Relationship Resolver Hint projection (ADR-0027 / ADR-0030 / ADR-0031 /
 * ADR-0033, SPEC #107 AC 13/14). A hint is a rebuildable, non-authoritative
 * projection of ONE Relationship Memory Claim's current version: per party
 * (whose appellation it resolves) and per locale, it names the role term the
 * current version supports — a qualifier value when one exists, the axis's
 * neutral fallback otherwise, the registry label for axis-less entries — and
 * renders the registry template phrase for the party's view. Temporal
 * semantics follow ADR-0030: `current` projects current templates, `ended`
 * projects former templates, and `unknown` projects nothing assertive at all.
 * Hints never become identity, Evidence, or a second Context Memory.
 */

export const RELATIONSHIP_RESOLVER_HINT_PROJECTION_VERSION =
  "relationship-resolver-hint:v1";

export const RESOLVER_HINT_LOCALES = ["en", "zh"] as const;
export type ResolverHintLocale = (typeof RESOLVER_HINT_LOCALES)[number];

export type ResolverHintTemporalForm = "current" | "former";

/** Stored Resolver Hint row: the planned projection plus its identity. */
export type RelationshipResolverHintRecord = RelationshipResolverHintPlanRow &
  Readonly<{
    relationshipResolverHintId: string;
    rebuiltAt: Date;
  }>;

export type RelationshipResolverHintPlanRow = Readonly<{
  memoryClaimId: MemoryClaimId;
  memoryClaimVersionId: MemoryClaimVersionId;
  /** The party whose appellation this hint resolves. */
  resolvedEntityId: string;
  /** The other party of the canonical pair. */
  contextEntityId: string;
  viewDirection: "forward" | "inverse" | "symmetric";
  locale: ResolverHintLocale;
  temporalForm: ResolverHintTemporalForm;
  roleSide: QualifierRoleSide;
  roleAxisId: string | null;
  roleTerm: string;
  roleSource: "qualifier" | "neutral_fallback" | "predicate_label";
  /** Rendered registry template; null when a current label is missing. */
  phrase: string | null;
}>;

type HintQualifierInput = Pick<
  ClaimVersionQualifierRecord,
  "axisId" | "roleSide" | "typedValue"
>;

function localeSurfaceOf(
  entry: PredicateRegistryEntry,
  axisId: string,
  value: string,
  locale: ResolverHintLocale,
): string | null {
  const axis = entry.relationshipSemantics?.qualifierAxes.find(
    (candidate) => candidate.axisId === axisId,
  );
  if (!axis || axis.valueSchema.kind !== "enum") return null;
  const spec = axis.valueSchema.values.find((candidate) => candidate.value === value);
  if (!spec) return null;
  const surface = locale === "zh" ? spec.zh[0] : spec.en[0];
  return surface ?? spec.value;
}

function renderTemplate(
  template: string,
  subjectLabel: string | null,
  objectLabel: string | null,
): string | null {
  if (subjectLabel === null || objectLabel === null) return null;
  return template
    .replaceAll("{subject}", subjectLabel)
    .replaceAll("{object}", objectLabel);
}

/**
 * Pure hint planner. Deterministic in inputs only — registry snapshot, the
 * claim's current version, its qualifiers, and current Entity labels. Every
 * row derives from exactly one ClaimVersion (the current one); superseded
 * versions never project.
 */
export function planRelationshipResolverHints(input: {
  projections: readonly RelationshipProjectionLocalization[];
  localizations: readonly PredicateLocalization[];
  entry: PredicateRegistryEntry;
  claim: Readonly<{
    memoryClaimId: MemoryClaimId;
    predicateId: string;
    subjectEntityId: string;
    objectEntityId: string;
  }>;
  currentVersion: Readonly<{
    memoryClaimVersionId: MemoryClaimVersionId;
    temporal: TemporalBounds;
  }>;
  qualifiers: readonly HintQualifierInput[];
  labels: Readonly<Record<string, { zh: string | null; en: string | null }>>;
}): readonly RelationshipResolverHintPlanRow[] {
  const { entry, claim, currentVersion, qualifiers, labels } = input;
  const semantics = entry.relationshipSemantics;
  if (!semantics) return [];
  const projections = entry.temporalSemantics.resolverHintProjections;
  if (!projections) return [];

  const temporalForm: ResolverHintTemporalForm | null =
    currentVersion.temporal.temporalStatus === "current"
      ? projections.current
        ? "current"
        : null
      : currentVersion.temporal.temporalStatus === "ended"
        ? projections.former
          ? "former"
          : null
        : // ADR-0030: an unknown state cannot project assertive current or
          // former terms.
          null;
  if (temporalForm === null) return [];

  const templateRows = input.projections.filter(
    (projection) =>
      projection.predicateId === claim.predicateId &&
      projection.roleProjectionVersion > 0,
  );
  if (templateRows.length === 0) return [];

  const localizationByLocale = new Map(
    input.localizations
      .filter((item) => item.predicateId === claim.predicateId)
      .map((item) => [item.locale, item]),
  );

  const rows: RelationshipResolverHintPlanRow[] = [];
  // Canonical sides resolve exactly as admission resolves them (ADR-0032):
  // directed predicates face the stored canonical direction; symmetric
  // predicates follow the sorted Entity-pair order that builds the canonical
  // key — never the stored column order or mention order.
  const canonicalSubjectEntityId =
    semantics.direction === "directed"
      ? claim.subjectEntityId
      : [claim.subjectEntityId, claim.objectEntityId].sort()[0]!;
  for (const locale of RESOLVER_HINT_LOCALES) {
    const subjectLabel = labels[claim.subjectEntityId]?.[locale] ?? null;
    const objectLabel = labels[claim.objectEntityId]?.[locale] ?? null;
    for (const party of [
      { entityId: claim.subjectEntityId, roleSide: "canonical_subject" },
      { entityId: claim.objectEntityId, roleSide: "counterpart" },
    ] as const) {
      const partyRoleSide: QualifierRoleSide =
        party.entityId === canonicalSubjectEntityId
          ? "canonical_subject"
          : "counterpart";
      const viewDirection =
        semantics.direction === "directed"
          ? partyRoleSide === "canonical_subject"
            ? ("forward" as const)
            : ("inverse" as const)
          : ("symmetric" as const);
      if (!semantics.views.includes(viewDirection)) continue;
      const projection = templateRows.find(
        (candidate) =>
          candidate.locale === locale && candidate.viewDirection === viewDirection,
      );
      if (!projection) continue;
      const templates =
        temporalForm === "current" ? projection.templates : projection.formerTemplates;
      const template = templates[0];
      const phrase =
        template !== undefined
          ? renderTemplate(template, subjectLabel, objectLabel)
          : null;

      const axesWithTerm: {
        roleAxisId: string | null;
        roleTerm: string;
        roleSource: RelationshipResolverHintPlanRow["roleSource"];
      }[] = [];
      for (const axis of semantics.qualifierAxes) {
        const qualifier = qualifiers.find(
          (candidate) =>
            candidate.axisId === axis.axisId && candidate.roleSide === partyRoleSide,
        );
        if (qualifier) {
          const value = qualifier.typedValue;
          if (typeof value === "string" && value.trim() !== "") {
            axesWithTerm.push({
              roleAxisId: axis.axisId,
              roleTerm:
                localeSurfaceOf(entry, axis.axisId, value, locale) ?? value,
              roleSource: "qualifier",
            });
            continue;
          }
          if (Array.isArray(value) && value.length > 0) {
            axesWithTerm.push({
              roleAxisId: axis.axisId,
              roleTerm: value
                .map(
                  (item) =>
                    localeSurfaceOf(entry, axis.axisId, item, locale) ?? item,
                )
                .join("、"),
              roleSource: "qualifier",
            });
            continue;
          }
        }
        const neutral =
          locale === "zh" ? axis.neutralFallbackZh : axis.neutralFallbackEn;
        if (neutral.trim() !== "") {
          axesWithTerm.push({
            roleAxisId: axis.axisId,
            roleTerm: neutral,
            roleSource: "neutral_fallback",
          });
        }
      }
      if (axesWithTerm.length === 0) {
        const label = localizationByLocale.get(locale)?.label;
        if (label) {
          axesWithTerm.push({
            roleAxisId: null,
            roleTerm: label,
            roleSource: "predicate_label",
          });
        }
      }
      for (const term of axesWithTerm) {
        rows.push({
          memoryClaimId: claim.memoryClaimId,
          memoryClaimVersionId: currentVersion.memoryClaimVersionId,
          resolvedEntityId: party.entityId,
          contextEntityId:
            party.entityId === claim.subjectEntityId
              ? claim.objectEntityId
              : claim.subjectEntityId,
          viewDirection,
          locale,
          temporalForm,
          roleSide: partyRoleSide,
          roleAxisId: term.roleAxisId,
          roleTerm: term.roleTerm,
          roleSource: term.roleSource,
          phrase,
        });
      }
    }
  }
  return rows.sort((a, b) => {
    if (a.locale !== b.locale) return a.locale.localeCompare(b.locale);
    if (a.resolvedEntityId !== b.resolvedEntityId) {
      return a.resolvedEntityId.localeCompare(b.resolvedEntityId);
    }
    return (a.roleAxisId ?? "\uffff").localeCompare(b.roleAxisId ?? "\uffff");
  });
}
