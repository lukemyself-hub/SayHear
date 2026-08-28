import type {
  ClaimKind,
  PredicateLocalization,
  PredicateRegistryEntry,
} from "../predicate-registry/types";
import type { ClaimTypedValue, TemporalBounds } from "../memory-claim/types";
import {
  CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
  normalizeRetrievalTerm,
} from "./types";

/**
 * Deterministic claim-retrieval projection planner (architecture §7.11 /
 * §10.1, ADR-0115): one row per locale for a ClaimVersion, derived only from
 * the registry snapshot, current entity labels / verified aliases, the typed
 * value, and time expressions — never from User Event prose. `retrieval_text`
 * feeds the generated `pg_catalog.english` tsvector; `lexical_terms` is the
 * same-policy term set the query side reconstructs (no model-invented
 * synonyms). Rows are write-through maintained in the same transaction as
 * the version advance and re-fenced at query time.
 */

export type ClaimRetrievalProjectionPlanRow = Readonly<{
  memoryClaimId: string;
  memoryClaimVersionId: string;
  locale: "zh" | "en";
  viewDirection: "self" | "forward" | "inverse" | "symmetric";
  retrievalText: string;
  lexicalTerms: readonly string[];
  projectionPolicyVersion: string;
  status: "active";
}>;

export type RetrievalProjectionLabelSet = Readonly<{
  zh: string | null;
  en: string | null;
  aliases: readonly string[];
}>;

export function planClaimRetrievalProjections(input: {
  entry: PredicateRegistryEntry;
  localizations: readonly PredicateLocalization[];
  claim: Readonly<{
    memoryClaimId: string;
    predicateId: string;
    subjectEntityId: string;
    objectEntityId: string | null;
  }>;
  version: Readonly<{
    memoryClaimVersionId: string;
    kind: ClaimKind;
    typedValue: ClaimTypedValue;
    temporal: TemporalBounds;
  }>;
  labels: Readonly<Record<string, RetrievalProjectionLabelSet | undefined>>;
}): readonly ClaimRetrievalProjectionPlanRow[] {
  const viewDirection: ClaimRetrievalProjectionPlanRow["viewDirection"] =
    input.entry.relationshipSemantics === null
      ? "self"
      : input.entry.relationshipSemantics.direction === "directed"
        ? "forward"
        : "symmetric";

  const valueTerms = (Array.isArray(input.version.typedValue)
    ? input.version.typedValue
    : [input.version.typedValue]
  )
    .map((value) => normalizeRetrievalTerm(String(value)))
    .filter((value) => value !== "");

  const timeTerms = [
    input.version.temporal.validFrom,
    input.version.temporal.validTo,
  ]
    .filter((bound): bound is Date => bound !== null)
    .map((bound) => String(bound.getUTCFullYear()));

  const subjectLabels = input.labels[input.claim.subjectEntityId];
  const objectLabels =
    input.claim.objectEntityId !== null
      ? (input.labels[input.claim.objectEntityId] ?? undefined)
      : undefined;

  const aliasTerms = [
    ...(subjectLabels?.aliases ?? []),
    ...(objectLabels?.aliases ?? []),
  ]
    .map((alias) => normalizeRetrievalTerm(alias))
    .filter((alias) => alias !== "");

  const registryTerms = input.localizations.flatMap((localization) =>
    localization.lexicalSurfaces.map((surface) =>
      normalizeRetrievalTerm(surface.text),
    ),
  );

  const sharedTerms = [
    ...new Set([
      ...valueTerms,
      ...timeTerms,
      ...aliasTerms,
      ...registryTerms,
      ...(subjectLabels
        ? [subjectLabels.zh, subjectLabels.en].filter(
            (label): label is string => label !== null,
          )
        : []),
      ...(objectLabels
        ? [objectLabels.zh, objectLabels.en].filter(
            (label): label is string => label !== null,
          )
        : []),
    ]),
  ]
    .map((term) => normalizeRetrievalTerm(term))
    .filter((term) => term !== "")
    .sort((a, b) => a.localeCompare(b, "en"));

  const rows: ClaimRetrievalProjectionPlanRow[] = [];
  for (const locale of ["zh", "en"] as const) {
    const localization = input.localizations.find(
      (candidate) => candidate.locale === locale,
    );
    const predicateLabel =
      localization?.label ?? input.localizations[0]?.label ?? input.claim.predicateId;
    const subjectLabel =
      (locale === "zh" ? subjectLabels?.zh : subjectLabels?.en) ??
      subjectLabels?.zh ??
      subjectLabels?.en ??
      input.claim.subjectEntityId;
    const objectLabel =
      input.claim.objectEntityId === null
        ? null
        : ((locale === "zh" ? objectLabels?.zh : objectLabels?.en) ??
          objectLabels?.zh ??
          objectLabels?.en ??
          input.claim.objectEntityId);
    const ended =
      input.version.temporal.temporalStatus === "ended"
        ? locale === "zh"
          ? "（已结束）"
          : " (ended)"
        : "";
    const relationJoiner = locale === "zh" ? "与" : " and ";
    const valueJoiner = locale === "zh" ? "：" : ": ";
    const retrievalText =
      objectLabel === null
        ? `${subjectLabel}${valueJoiner}${predicateLabel}${valueJoiner}${valueTerms.join("、")}${ended}`
        : `${subjectLabel}${relationJoiner}${objectLabel} · ${predicateLabel}${ended}`;
    // The lexical term set never collapses to empty: the subject surface is
    // always matchable material even when labels are missing.
    const lexicalTerms =
      sharedTerms.length > 0 ? sharedTerms : [normalizeRetrievalTerm(subjectLabel)];
    rows.push({
      memoryClaimId: input.claim.memoryClaimId,
      memoryClaimVersionId: input.version.memoryClaimVersionId,
      locale,
      viewDirection,
      retrievalText,
      lexicalTerms,
      projectionPolicyVersion: CLAIM_RETRIEVAL_PROJECTION_POLICY_VERSION,
      status: "active",
    });
  }
  return rows;
}
