import type { ClaimKind } from "../predicate-registry/types";
import {
  RETRIEVAL_BROAD_TERM_STOP_LIST,
  type ConstructedRetrievalQuery,
  type RetrievalCandidateClaimState,
  type RetrievalRegistryMaterial,
} from "./types";

/**
 * Memory context compilation (issue #117, SPEC #107 "Context compilation",
 * ADR-0111, #95 §2): three atomic sections (`person_portrait`,
 * `objective_memory`, `ai_impression`) sharing one `MemoryContextItem` shape,
 * compiled per turn with budgets v1 as versioned ceilings (never quotas) and
 * a global claim-version dedupe where the Person Portrait wins dual
 * selection. The Person Portrait selector implements the four-factor
 * lexicographic order — current-topic relevance > understanding value >
 * cross-context stability > Evidence strength — tie-broken by latest valid
 * Evidence then stable ID, with no numeric scoring and no kind-based ranking:
 * Objective Memory and active AI Impressions compete on the same dimensions,
 * kind changes recall framing only.
 */

/** Versioned Person Portrait selection strategy (ADR-0111, #95 §2). */
export const PORTRAIT_SELECTION_POLICY_VERSION = "portrait-selection:v1";

/** Versioned memory-class budgets (ceilings, not quotas; ADR-0111). */
export const MEMORY_BUDGETS_POLICY_VERSION = "memory-budgets:v1";

/** Versioned kind-specific recall framing (ADR-0009 / ADR-0116). */
export const RECALL_FRAMING_POLICY_VERSION = "recall-framing:v1";

export const MEMORY_SECTION_KEYS = [
  "person_portrait",
  "objective_memory",
  "ai_impression",
] as const;

export type MemorySectionKey = (typeof MEMORY_SECTION_KEYS)[number];

export const MEMORY_BUDGETS_V1 = Object.freeze({
  personPortraitMaxItems: 3,
  personPortraitMaxImpressions: 2,
  queryRetrievedMaxItems: 2,
  queryRetrievedMaxImpressions: 1,
  memoryClassTotalMaxItems: 5,
});

// ---------------------------------------------------------------------------
// Portrait eligibility (ADR-0111 lens; #93 §0: no registry flag).
//
// Eligibility follows the ADR-0111 criterion — durable person-describing
// predicates (personality traits, values, communication preferences,
// long-lived roles, important relationships, durable places and life
// stages). Explicitly excluded: `sh.plan.life_change` (short-term
// arrangements lens, #93 §17) and `sh.project.participation` (current
// activity, not a durable self-description) — both stay retrieval-only.
// `understandingTier` is the deterministic ordinal for factor 2 of the
// four-factor lexicographic order, versioned with this strategy so tuning
// from manifest evidence is a version bump, never an in-place edit.
// ---------------------------------------------------------------------------

export type PortraitEligibility = Readonly<{
  predicateId: string;
  understandingTier: 1 | 2 | 3;
}>;

export const PORTRAIT_ELIGIBLE_PREDICATES: readonly PortraitEligibility[] = [
  // tier 3 — traits, values, communication style (ADR-0111's first-listed
  // examples of what deepens understanding of a person)
  { predicateId: "sh.communication.stated_style", understandingTier: 3 },
  { predicateId: "sh.value.core_priorities", understandingTier: 3 },
  { predicateId: "sh.decision.consideration_style", understandingTier: 3 },
  // tier 2 — life stages and personal preferences
  { predicateId: "sh.life.career_stage", understandingTier: 2 },
  { predicateId: "sh.life.family_stage", understandingTier: 2 },
  { predicateId: "sh.preference.relationship_horizon", understandingTier: 2 },
  { predicateId: "sh.preference.business_travel", understandingTier: 2 },
  // tier 1 — long-lived roles, important relationships, durable places
  { predicateId: "sh.relationship.partner_of", understandingTier: 1 },
  { predicateId: "sh.relationship.parent_of", understandingTier: 1 },
  { predicateId: "sh.relationship.sibling_of", understandingTier: 1 },
  { predicateId: "sh.relationship.friend_of", understandingTier: 1 },
  { predicateId: "sh.relationship.colleague_of", understandingTier: 1 },
  { predicateId: "sh.relationship.manager_of", understandingTier: 1 },
  { predicateId: "sh.relationship.relative_of", understandingTier: 1 },
  { predicateId: "sh.relationship.in_law_of", understandingTier: 1 },
  { predicateId: "sh.relationship.teacher_of", understandingTier: 1 },
  { predicateId: "sh.relationship.roommate_of", understandingTier: 1 },
  { predicateId: "sh.work.employer", understandingTier: 1 },
  { predicateId: "sh.work.role_title", understandingTier: 1 },
  { predicateId: "sh.place.residence", understandingTier: 1 },
  { predicateId: "sh.place.hometown", understandingTier: 1 },
  { predicateId: "sh.place.workplace", understandingTier: 1 },
];

const portraitEligibilityByPredicate = new Map(
  PORTRAIT_ELIGIBLE_PREDICATES.map((entry) => [entry.predicateId, entry]),
);

export function portraitUnderstandingTier(predicateId: string): 1 | 2 | 3 | null {
  return portraitEligibilityByPredicate.get(predicateId)?.understandingTier ?? null;
}

export const PORTRAIT_ELIGIBLE_PREDICATE_IDS: readonly string[] =
  PORTRAIT_ELIGIBLE_PREDICATES.map((entry) => entry.predicateId);

// ---------------------------------------------------------------------------
// Hydration shapes shared by the portrait pool and retrieval selection.
// ---------------------------------------------------------------------------

export type MemoryVersionDetail = Readonly<{
  versionId: string;
  claimId: string;
  predicateId: string;
  kind: ClaimKind;
  epistemicStatus: "confirmed" | "inferred" | "contested";
  temporalStatus: "current" | "ended" | "unknown";
  validFrom: string | null;
  validTo: string | null;
  subjectEntityId: string;
  objectEntityId: string | null;
  subjectEntityVersionId: string | null;
  objectEntityVersionId: string | null;
  /** Locale-resolved deterministic projection text (never Event prose). */
  renderedText: string;
  lexicalTerms: readonly string[];
  lastObservedAt: string;
}>;

export type MemoryVersionEvidence = Readonly<{
  versionId: string;
  evidenceIds: readonly string[];
  latestEvidenceAt: string | null;
}>;

/** A fence-passing portrait-pool member with its selection factor inputs. */
export type PortraitPoolCandidate = Readonly<{
  detail: MemoryVersionDetail;
  /** Valid Evidence count from the trust-fence loader. */
  validEvidenceCount: number;
  latestEvidenceAt: string | null;
}>;

export type RetrievalQualifiedCandidate = Readonly<{
  claim: RetrievalCandidateClaimState;
  finalRank: number;
  selectionReasonCodes: readonly string[];
}>;

export type MemorySelectionDecision = Readonly<{
  claimVersionId: string;
  selectedSection: MemorySectionKey | null;
  selectionReasonCodes: readonly string[];
  rejectionReasonCodes: readonly string[];
}>;

/**
 * Key names are snake_case because the object persists verbatim as the
 * retrieval manifest's `section_budget_vs_actual` block (architecture §9.2).
 */
export type MemorySectionBudgetActual = Readonly<{
  person_portrait: Readonly<{
    ceiling_items: number;
    ceiling_impressions: number;
    actual_items: number;
    actual_impressions: number;
  }>;
  query_retrieved: Readonly<{
    ceiling_items: number;
    ceiling_impressions: number;
    actual_items: number;
    actual_impressions: number;
  }>;
  memory_class_total: Readonly<{ ceiling_items: number; actual_items: number }>;
}>;

export type MemorySelectionPlan = Readonly<{
  /** Ordered Portrait selections (≤3 items, ≤2 Impressions). */
  portraitSelected: readonly PortraitPoolCandidate[];
  /** Size of the fence-passing portrait pool before budget ceilings. */
  portraitPoolCount: number;
  /** Ordered query-retrieved selections (≤2 items, ≤1 Impression). */
  retrievalSelected: readonly Readonly<{
    candidate: RetrievalQualifiedCandidate;
    section: "objective_memory" | "ai_impression";
  }>[];
  /** One decision per cutoff-passed retrieval candidate (query-hit rows). */
  decisions: readonly MemorySelectionDecision[];
  budgetVsActual: MemorySectionBudgetActual;
}>;

export type MemoryContextItem = Readonly<{
  /** CompiledContext-scoped opaque reference, deterministic per compile. */
  contextMemoryRef: string;
  renderedText: string;
  claimId: string;
  claimVersionId: string;
  predicateId: string;
  kind: ClaimKind;
  epistemicStatus: "confirmed" | "inferred";
  temporalStatus: "current" | "ended" | "unknown";
  validFrom: string | null;
  validTo: string | null;
  entityVersionIds: readonly string[];
  evidenceIds: readonly string[];
  recallFramingPolicyVersion: string;
  selectionSource: "person_portrait" | "query_retrieval";
}>;

const broadTerms = new Set(RETRIEVAL_BROAD_TERM_STOP_LIST);

/**
 * Factor 1 — current-topic relevance, tiered from the same committed query
 * signals the retrieval lanes use: a predicate or resolved-Entity match is a
 * structured hit (2), a non-broad lexical overlap is a nudge (1), anything
 * else is unrelated (0). Deterministic; no LLM.
 */
function topicRelevanceTier(
  candidate: PortraitPoolCandidate,
  query: ConstructedRetrievalQuery,
): 0 | 1 | 2 {
  if (
    query.predicateCandidates.some(
      (predicate) => predicate.predicateId === candidate.detail.predicateId,
    )
  ) {
    return 2;
  }
  const resolvedIds = new Set(
    query.resolvedEntities.map((entity) => entity.entityId),
  );
  if (
    resolvedIds.has(candidate.detail.subjectEntityId) ||
    (candidate.detail.objectEntityId !== null &&
      resolvedIds.has(candidate.detail.objectEntityId))
  ) {
    return 2;
  }
  const queryTerms = new Set(
    query.lexicalTerms.filter((term) => !broadTerms.has(term)),
  );
  if (candidate.detail.lexicalTerms.some((term) => queryTerms.has(term))) {
    return 1;
  }
  return 0;
}

/**
 * Factor 3 — cross-context stability: predicates the registry scopes as
 * long-term stable rank highest; among current/ended predicates a current
 * version outranks an ended one (an ended version is history, not who the
 * user is now).
 */
function stabilityTier(
  candidate: PortraitPoolCandidate,
  registry: RetrievalRegistryMaterial,
): 0 | 1 | 2 {
  const entry = registry.entryFor(candidate.detail.predicateId);
  if (
    entry !== null &&
    entry.temporalSemantics.temporalStatuses.length === 1 &&
    entry.temporalSemantics.temporalStatuses[0] === "stable"
  ) {
    return 2;
  }
  return candidate.detail.temporalStatus === "ended" ? 0 : 1;
}

function comparePortraitCandidates(
  left: PortraitPoolCandidate,
  right: PortraitPoolCandidate,
  query: ConstructedRetrievalQuery,
  registry: RetrievalRegistryMaterial,
): number {
  const topicDelta =
    topicRelevanceTier(right, query) - topicRelevanceTier(left, query);
  if (topicDelta !== 0) return topicDelta;
  const understandingDelta =
    (portraitUnderstandingTier(right.detail.predicateId) ?? 0) -
    (portraitUnderstandingTier(left.detail.predicateId) ?? 0);
  if (understandingDelta !== 0) return understandingDelta;
  const stabilityDelta =
    stabilityTier(right, registry) - stabilityTier(left, registry);
  if (stabilityDelta !== 0) return stabilityDelta;
  if (left.validEvidenceCount !== right.validEvidenceCount) {
    return right.validEvidenceCount - left.validEvidenceCount;
  }
  const recencyDelta = (right.latestEvidenceAt ?? "").localeCompare(
    left.latestEvidenceAt ?? "",
    "en",
  );
  if (recencyDelta !== 0) return recencyDelta;
  return left.detail.versionId.localeCompare(right.detail.versionId, "en");
}

export function selectMemoryForInjection(input: {
  query: ConstructedRetrievalQuery;
  registry: RetrievalRegistryMaterial;
  /** Fence-passing portrait pool (eligibility + fences applied upstream). */
  portraitPool: readonly PortraitPoolCandidate[];
  /** Cutoff-passed retrieval candidates in final-rank order. */
  retrievalQualified: readonly RetrievalQualifiedCandidate[];
}): MemorySelectionPlan {
  // Only ACTIVE AI Impressions compete in the Portrait (ADR-0111 / #95 §2):
  // an impression whose validity ended describes a past phase and never
  // occupies a slot. Ended Objective Memory stays eligible — it is durable
  // personal history, ranked down by the stability factor.
  const eligiblePool = input.portraitPool.filter(
    (candidate) =>
      candidate.detail.kind === "objective" ||
      candidate.detail.temporalStatus !== "ended",
  );
  // --- Person Portrait: four-factor lexicographic order, budgets as
  // ceilings over the ordered walk (never lowered, never filled).
  const orderedPool = [...eligiblePool].sort((left, right) =>
    comparePortraitCandidates(left, right, input.query, input.registry),
  );
  const portraitSelected: PortraitPoolCandidate[] = [];
  let portraitImpressions = 0;
  for (const candidate of orderedPool) {
    if (portraitSelected.length >= MEMORY_BUDGETS_V1.personPortraitMaxItems) {
      break;
    }
    if (
      candidate.detail.kind === "impression" &&
      portraitImpressions >= MEMORY_BUDGETS_V1.personPortraitMaxImpressions
    ) {
      continue;
    }
    portraitSelected.push(candidate);
    if (candidate.detail.kind === "impression") portraitImpressions += 1;
  }
  const portraitVersionIds = new Set(
    portraitSelected.map((candidate) => candidate.detail.versionId),
  );

  // --- Query-retrieved sections: ranked walk under the shared retrieval
  // ceiling (≤2 items, ≤1 Impression). A Claim the Portrait already selected
  // stays only in `person_portrait`; the query hit is still recorded on the
  // candidate row and the slot stays free for the next ranked candidate.
  const retrievalSelected: {
    candidate: RetrievalQualifiedCandidate;
    section: "objective_memory" | "ai_impression";
  }[] = [];
  const decisions: MemorySelectionDecision[] = [];
  let retrievalImpressions = 0;
  for (const candidate of input.retrievalQualified) {
    const versionId = candidate.claim.versionId;
    if (portraitVersionIds.has(versionId)) {
      decisions.push({
        claimVersionId: versionId,
        selectedSection: "person_portrait",
        selectionReasonCodes: [
          "selected_person_portrait",
          "section_dedupe_portrait_priority",
        ],
        rejectionReasonCodes: [],
      });
      continue;
    }
    if (
      retrievalSelected.length >= MEMORY_BUDGETS_V1.queryRetrievedMaxItems
    ) {
      decisions.push({
        claimVersionId: versionId,
        selectedSection: null,
        selectionReasonCodes: [],
        rejectionReasonCodes: ["budget_retrieval_ceiling"],
      });
      continue;
    }
    if (
      candidate.claim.kind === "impression" &&
      retrievalImpressions >= MEMORY_BUDGETS_V1.queryRetrievedMaxImpressions
    ) {
      decisions.push({
        claimVersionId: versionId,
        selectedSection: null,
        selectionReasonCodes: [],
        rejectionReasonCodes: ["budget_retrieval_impression_ceiling"],
      });
      continue;
    }
    const section: "objective_memory" | "ai_impression" =
      candidate.claim.kind === "impression" ? "ai_impression" : "objective_memory";
    retrievalSelected.push({ candidate, section });
    if (candidate.claim.kind === "impression") retrievalImpressions += 1;
    decisions.push({
      claimVersionId: versionId,
      selectedSection: section,
      selectionReasonCodes: ["selected_query_retrieval"],
      rejectionReasonCodes: [],
    });
  }

  // --- Memory-class total: structurally bounded by 3 + 2; recorded (and
  // asserted) so the ceiling is enforced, not assumed.
  const totalItems = portraitSelected.length + retrievalSelected.length;
  if (totalItems > MEMORY_BUDGETS_V1.memoryClassTotalMaxItems) {
    throw new Error(
      "Memory-class budget violation: the compiled sections exceed budgets v1.",
    );
  }

  return {
    portraitSelected,
    portraitPoolCount: input.portraitPool.length,
    retrievalSelected,
    decisions,
    budgetVsActual: {
      person_portrait: {
        ceiling_items: MEMORY_BUDGETS_V1.personPortraitMaxItems,
        ceiling_impressions: MEMORY_BUDGETS_V1.personPortraitMaxImpressions,
        actual_items: portraitSelected.length,
        actual_impressions: portraitImpressions,
      },
      query_retrieved: {
        ceiling_items: MEMORY_BUDGETS_V1.queryRetrievedMaxItems,
        ceiling_impressions: MEMORY_BUDGETS_V1.queryRetrievedMaxImpressions,
        actual_items: retrievalSelected.length,
        actual_impressions: retrievalImpressions,
      },
      memory_class_total: {
        ceiling_items: MEMORY_BUDGETS_V1.memoryClassTotalMaxItems,
        actual_items: totalItems,
      },
    },
  };
}

export function buildMemoryContextItems(input: {
  plan: MemorySelectionPlan;
  detailByVersion: ReadonlyMap<string, MemoryVersionDetail>;
  evidenceByVersion: ReadonlyMap<string, MemoryVersionEvidence>;
}): Readonly<Record<MemorySectionKey, readonly MemoryContextItem[]>> {
  const sections: Record<MemorySectionKey, MemoryContextItem[]> = {
    person_portrait: [],
    objective_memory: [],
    ai_impression: [],
  };
  let refIndex = 0;
  const nextRef = () => {
    refIndex += 1;
    return `shh-memory-${refIndex}`;
  };
  const toItem = (
    versionId: string,
    selectionSource: MemoryContextItem["selectionSource"],
  ): MemoryContextItem => {
    const source = input.detailByVersion.get(versionId);
    if (!source) {
      throw new Error(
        `Memory item hydration is missing details for ClaimVersion ${versionId}.`,
      );
    }
    if (source.epistemicStatus === "contested") {
      // A contested Claim must fail closed (ADR-0111 per-item fences), never
      // be relabeled into an injectable epistemic status.
      throw new Error(
        `Contested ClaimVersion ${versionId} reached memory compilation.`,
      );
    }
    const evidence = input.evidenceByVersion.get(versionId);
    return {
      contextMemoryRef: nextRef(),
      renderedText: source.renderedText,
      claimId: source.claimId,
      claimVersionId: source.versionId,
      predicateId: source.predicateId,
      kind: source.kind,
      epistemicStatus: source.epistemicStatus,
      temporalStatus: source.temporalStatus,
      validFrom: source.validFrom,
      validTo: source.validTo,
      entityVersionIds: [
        ...(source.subjectEntityVersionId !== null
          ? [source.subjectEntityVersionId]
          : []),
        ...(source.objectEntityVersionId !== null
          ? [source.objectEntityVersionId]
          : []),
      ],
      evidenceIds: evidence?.evidenceIds ?? [],
      recallFramingPolicyVersion: RECALL_FRAMING_POLICY_VERSION,
      selectionSource,
    };
  };
  for (const candidate of input.plan.portraitSelected) {
    sections.person_portrait.push(
      toItem(candidate.detail.versionId, "person_portrait"),
    );
  }
  for (const entry of input.plan.retrievalSelected) {
    sections[entry.section].push(
      toItem(entry.candidate.claim.versionId, "query_retrieval"),
    );
  }
  return sections;
}

export function memoryLocaleOf(locale: string): "zh" | "en" {
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** Degraded / empty-run shapes (one owner beside the shapes they zero out). */
export const EMPTY_MEMORY_SECTIONS: Readonly<
  Record<MemorySectionKey, readonly MemoryContextItem[]>
> = Object.freeze({
  person_portrait: [],
  objective_memory: [],
  ai_impression: [],
});

export function emptyBudgetVsActual(): MemorySectionBudgetActual {
  return {
    person_portrait: {
      ceiling_items: MEMORY_BUDGETS_V1.personPortraitMaxItems,
      ceiling_impressions: MEMORY_BUDGETS_V1.personPortraitMaxImpressions,
      actual_items: 0,
      actual_impressions: 0,
    },
    query_retrieved: {
      ceiling_items: MEMORY_BUDGETS_V1.queryRetrievedMaxItems,
      ceiling_impressions: MEMORY_BUDGETS_V1.queryRetrievedMaxImpressions,
      actual_items: 0,
      actual_impressions: 0,
    },
    memory_class_total: {
      ceiling_items: MEMORY_BUDGETS_V1.memoryClassTotalMaxItems,
      actual_items: 0,
    },
  };
}

const SECTION_TITLES: Readonly<
  Record<MemorySectionKey, Readonly<{ zh: string; en: string }>>
> = {
  person_portrait: {
    zh: "Person Portrait（用户画像，person_portrait，逐轮重选；条目按记忆引用单独寻址）",
    en: "Person Portrait (who the user is, re-selected per turn; address items by memory reference)",
  },
  objective_memory: {
    zh: "Objective Memory（objective_memory，本轮话题检索命中）",
    en: "Objective Memory (objective_memory, retrieved for this turn's topic)",
  },
  ai_impression: {
    zh: "AI Impression（ai_impression，本轮话题检索命中）",
    en: "AI Impression (ai_impression, retrieved for this turn's topic)",
  },
};

const KIND_FRAMING: Readonly<
  Record<ClaimKind, Readonly<{ zh: string; en: string }>>
> = {
  objective: {
    zh: "措辞（objective）：这是用户亲口陈述的事实；可以“你之前说过…”的方式来源归属式引用，不得表述为独立核验过的事实。",
    en: 'Framing (objective): a user-stated fact; you may reference it with source attribution ("you mentioned..."), never as an independently verified fact.',
  },
  impression: {
    zh: "措辞（impression）：这是你基于多次观察形成的理解，可以自然、朋友式地表达；不得升级成用户亲述或已核验事实，不得固化成永久标签或诊断式身份。",
    en: "Framing (impression): your own understanding from repeated observation; voice it naturally and friend-likely, never as user-stated or verified, never frozen into a permanent or diagnostic label.",
  },
};

/**
 * Renders one memory section. The prompt reads exactly this — itemized
 * rendered text + memory reference + kind-specific framing — never Evidence
 * originals. Objective and Impression items never merge into one item or one
 * narrative sentence: every item is its own line.
 */
export function renderMemorySection(input: {
  key: MemorySectionKey;
  items: readonly MemoryContextItem[];
  locale: string;
}): string {
  const localeKey = memoryLocaleOf(input.locale);
  const title = SECTION_TITLES[input.key][localeKey];
  const lines = [
    `${title} [${PORTRAIT_SELECTION_POLICY_VERSION} | ${MEMORY_BUDGETS_POLICY_VERSION} | ${RECALL_FRAMING_POLICY_VERSION}] (section=${input.key}):`,
  ];
  for (const item of input.items) {
    const temporal = [
      `temporal=${item.temporalStatus}`,
      item.validFrom === null ? null : `valid_from=${item.validFrom}`,
      item.validTo === null ? null : `valid_to=${item.validTo}`,
    ]
      .filter((part): part is string => part !== null)
      .join(" ");
    lines.push(
      `- [${item.contextMemoryRef}] ${item.renderedText} — kind=${item.kind} epistemic=${item.epistemicStatus} claim=${item.claimId} version=${item.claimVersionId} evidence=${item.evidenceIds.join(",") || "none"} ${temporal}`,
    );
    lines.push(`  ${KIND_FRAMING[item.kind][localeKey]}`);
  }
  return lines.join("\n");
}
