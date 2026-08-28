import { claimCanonicalKey } from "../memory-claim/admission";
import type { LexicalSurface } from "../predicate-registry/types";
import {
  normalizeRetrievalTerm,
  RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
  RETRIEVAL_TIME_WORDS,
  type ConstructedRetrievalQuery,
  type QueryPredicateCandidate,
  type RetrievalLanePlanEntry,
  type RetrievalQueryConstructionSources,
  type RetrievalQuerySourceRef,
  type RetrievalRegistryMaterial,
  type RetrievalTimeWordClass,
  type ResolvedQueryEntity,
} from "./types";

/**
 * Deterministic query construction (SPEC story 44, architecture §10.2): the
 * query is built only from committed, verifiable inputs — the current User
 * Event text, the last two final / corrected User Events of the Continuous
 * Exchange, uniquely resolvable entities (current label / verified alias /
 * validated Resolver Hint), the latest source-valid `current_topic`,
 * explicitly expressed dates and time words, and published registry lexical
 * aliases. Assistant Events are never query sources. No pre-retrieval LLM
 * invents synonyms: term vocabulary is exactly the published material.
 */
export function buildRetrievalQuery(input: {
  sources: RetrievalQueryConstructionSources;
  registry: RetrievalRegistryMaterial;
}): ConstructedRetrievalQuery {
  const { sources, registry } = input;
  // Combined normalized text of the user-side sources only.
  const userTexts = [
    sources.currentInput.text,
    ...sources.priorUserEvents.map((event) => event.text),
  ];
  const combined = normalizeRetrievalTerm(userTexts.join(" "));

  const sourceRefs: RetrievalQuerySourceRef[] = [
    { kind: "current_user_event", revisionId: sources.currentInput.revisionId },
    ...sources.priorUserEvents.map((event, index) => ({
      kind: "exchange_user_event" as const,
      revisionId: event.revisionId,
      ordinal: index + 1,
    })),
  ];
  const usedTopic =
    sources.currentTopic !== null && sources.currentTopic.trim() !== ""
      ? normalizeRetrievalTerm(sources.currentTopic)
      : null;
  if (usedTopic !== null) {
    sourceRefs.push({
      kind: "current_topic",
      dialogueRevision: sources.dialogueRevision,
      field: "current_topic",
    });
  }

  // --- entity resolution: a surface resolves only when it maps to exactly
  // one entity across current labels, verified aliases, and validated hints.
  const surfaces = new Map<
    string,
    { entityId: string; basis: ResolvedQueryEntity["basis"] }
  >();
  for (const entry of sources.labelIndex) {
    const surface = normalizeRetrievalTerm(entry.label);
    if (surface === "") continue;
    recordSurface(surfaces, surface, {
      entityId: entry.entityId,
      basis: entry.labelKind === "alias" ? "verified_alias" : "label",
    });
  }
  for (const hint of sources.resolverHints) {
    const surface = normalizeRetrievalTerm(hint.phrase);
    if (surface === "") continue;
    recordSurface(surfaces, surface, {
      entityId: hint.entityId,
      basis: "resolver_hint",
    });
  }
  const resolvedEntities: ResolvedQueryEntity[] = [];
  for (const [surface, binding] of [...surfaces.entries()].sort(([a], [b]) =>
    a.localeCompare(b, "en"),
  )) {
    if (binding !== null && combined.includes(surface)) {
      resolvedEntities.push({
        entityId: binding.entityId,
        basis: binding.basis,
        surface,
      });
    }
  }

  // --- registry lexical aliases found in the user-side text.
  const predicateCandidates: QueryPredicateCandidate[] = [];
  const aliasSurfaces: readonly LexicalSurface[] =
    registry.localizations.flatMap((localization) =>
      localization.lexicalSurfaces.map((surface) => surface),
    );
  const seenPredicates = new Set<string>();
  for (const surface of aliasSurfaces) {
    const normalized = normalizeRetrievalTerm(surface.text);
    if (normalized === "" || !combined.includes(normalized)) continue;
    const key = `${surface.text}\u0000${normalized}`;
    if (seenPredicates.has(key)) continue;
    seenPredicates.add(key);
    // The surface belongs to one localization row; alias text is unique
    // enough that any localization carrying the same text is the same word.
    const localization = registry.localizations.find((candidate) =>
      candidate.lexicalSurfaces.some(
        (candidateSurface) =>
          normalizeRetrievalTerm(candidateSurface.text) === normalized,
      ),
    );
    if (!localization) continue;
    predicateCandidates.push({
      predicateId: localization.predicateId,
      surface: normalized,
    });
  }
  predicateCandidates.sort((a, b) =>
    a.predicateId.localeCompare(b.predicateId, "en"),
  );
  if (predicateCandidates.length > 0) {
    sourceRefs.push({
      kind: "registry_lexical_alias",
      registryVersion: registry.registryVersion,
    });
  }

  // --- canonical keys: self-subject claims whose predicate and (for
  // relationships) object entity both resolved (scope-none registry entries).
  const canonicalKeys: string[] = [];
  if (sources.selfEntityId !== null) {
    for (const candidate of predicateCandidates) {
      const entry = registry.entryFor(candidate.predicateId);
      if (!entry || entry.scopeSchema.kind !== "none") continue;
      const isRelationship = entry.relationshipSemantics !== null;
      const objectEntityId = resolvedEntities.find(
        (entity) => entity.entityId !== sources.selfEntityId,
      );
      if (isRelationship && !objectEntityId) continue;
      canonicalKeys.push(
        claimCanonicalKey({
          predicateId: candidate.predicateId,
          subjectEntityId: sources.selfEntityId,
          objectEntityId: isRelationship ? objectEntityId!.entityId : null,
          scopeKey: "",
          relationshipDirection: entry.relationshipSemantics?.direction ?? null,
        }),
      );
    }
    canonicalKeys.sort((a, b) => a.localeCompare(b, "en"));
  }

  // --- time words and explicit date tokens.
  const timeWordClasses = (Object.keys(RETRIEVAL_TIME_WORDS) as readonly RetrievalTimeWordClass[])
    .filter((clazz) =>
      RETRIEVAL_TIME_WORDS[clazz].some((word) =>
        combined.includes(normalizeRetrievalTerm(word)),
      ),
    )
    .sort();
  const dateTokens = [
    ...new Set(combined.match(/\d{4}(-\d{2}){0,2}/g) ?? []),
  ].sort();

  // --- lexical term set: matched entity surfaces, matched alias surfaces,
  // and the source-valid topic (the topic is a committed projection input).
  const lexicalTerms = [
    ...new Set([
      ...resolvedEntities.map((entity) => entity.surface),
      ...predicateCandidates.map((candidate) => candidate.surface),
      ...(usedTopic !== null ? [usedTopic] : []),
    ]),
  ].sort((a, b) => a.localeCompare(b, "en"));

  const englishQueryText = userTexts.join(" ").trim();
  const hasStructuredSignal =
    resolvedEntities.length > 0 ||
    predicateCandidates.length > 0 ||
    timeWordClasses.length > 0 ||
    dateTokens.length > 0;
  const hasAsciiWord = /[a-z]{2,}/.test(normalizeRetrievalTerm(englishQueryText));

  const lanePlan: readonly RetrievalLanePlanEntry[] = [
    {
      lane: "structured_exact",
      enabled: hasStructuredSignal,
      notEnabledReason: hasStructuredSignal
        ? null
        : "no_structured_signal",
    },
    {
      lane: "lexical_term_overlap",
      enabled: lexicalTerms.length > 0,
      notEnabledReason: lexicalTerms.length > 0 ? null : "no_lexical_terms",
    },
    {
      lane: "english_fts",
      enabled: hasAsciiWord,
      notEnabledReason: hasAsciiWord ? null : "no_english_word_content",
    },
  ];
  const zeroSignal = lanePlan.every((lane) => !lane.enabled);

  return {
    policyVersion: RETRIEVAL_QUERY_CONSTRUCTION_POLICY_VERSION,
    sourceRefs,
    userTexts,
    englishQueryText,
    lexicalTerms,
    resolvedEntities,
    predicateCandidates,
    canonicalKeys,
    timeWordClasses,
    dateTokens,
    lanePlan,
    zeroSignal,
  };
}

/** A surface shared by two entities is ambiguous and resolves to nothing. */
function recordSurface(
  surfaces: Map<string, { entityId: string; basis: ResolvedQueryEntity["basis"] } | null>,
  surface: string,
  binding: { entityId: string; basis: ResolvedQueryEntity["basis"] },
): void {
  const existing = surfaces.get(surface);
  if (existing === undefined) {
    surfaces.set(surface, binding);
    return;
  }
  if (existing === null || existing.entityId !== binding.entityId) {
    surfaces.set(surface, null);
  }
}
