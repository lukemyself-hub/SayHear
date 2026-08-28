import { describe, expect, it } from "vitest";

import { loadPredicateRegistrySnapshot } from "../predicate-registry/index";
import {
  MEMORY_BUDGETS_POLICY_VERSION,
  MEMORY_BUDGETS_V1,
  MEMORY_SECTION_KEYS,
  PORTRAIT_ELIGIBLE_PREDICATES,
  PORTRAIT_SELECTION_POLICY_VERSION,
  RECALL_FRAMING_POLICY_VERSION,
  buildMemoryContextItems,
  memoryLocaleOf,
  portraitUnderstandingTier,
  renderMemorySection,
  selectMemoryForInjection,
  type MemoryVersionDetail,
  type MemoryVersionEvidence,
  type PortraitPoolCandidate,
  type RetrievalQualifiedCandidate,
} from "./memory-compilation";
import type { ConstructedRetrievalQuery } from "./types";

/**
 * Issue #117 (SPEC #107 "Context compilation", ADR-0111, #95 §2): the three
 * atomic memory sections, budgets v1 as ceilings, and the Person Portrait
 * four-factor lexicographic selection — all deterministic, all versioned.
 */

const registrySnapshot = loadPredicateRegistrySnapshot(1);
const registry = {
  registryVersion: registrySnapshot.registryVersion,
  entryFor(predicateId: string) {
    return (
      registrySnapshot.entries.find((entry) => entry.predicateId === predicateId) ??
      null
    );
  },
  localizations: registrySnapshot.localizations,
};

const STATED_STYLE = "sh.communication.stated_style";
const CORE_PRIORITIES = "sh.value.core_priorities";
const EMPLOYER = "sh.work.employer";
const HOMETOWN = "sh.place.hometown";
const COLLEAGUE_OF = "sh.relationship.colleague_of";
const LIFE_CHANGE = "sh.plan.life_change";
const PROJECT = "sh.project.participation";

function detail(overrides: Partial<MemoryVersionDetail> = {}): MemoryVersionDetail {
  return {
    versionId: "version-1",
    claimId: "claim-1",
    predicateId: EMPLOYER,
    kind: "objective",
    epistemicStatus: "confirmed",
    temporalStatus: "current",
    validFrom: null,
    validTo: null,
    subjectEntityId: "entity-self",
    objectEntityId: null,
    subjectEntityVersionId: "entity-version-self",
    objectEntityVersionId: null,
    renderedText: "Luke：工作单位：Acme",
    lexicalTerms: ["acme", "工作单位"],
    lastObservedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function evidence(
  overrides: Partial<MemoryVersionEvidence> = {},
): MemoryVersionEvidence {
  return {
    versionId: "version-1",
    evidenceIds: ["evidence-1"],
    latestEvidenceAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function pool(
  overrides: Partial<PortraitPoolCandidate> = {},
): PortraitPoolCandidate {
  return {
    detail: detail(),
    validEvidenceCount: 1,
    latestEvidenceAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function qualified(
  overrides: Partial<RetrievalQualifiedCandidate> = {},
): RetrievalQualifiedCandidate {
  return {
    claim: {
      claimId: "claim-r1",
      versionId: "version-r1",
      projectionId: "projection-r1",
      canonicalKey: "canonical-r1",
      subjectEntityId: "entity-self",
      objectEntityId: null,
      predicateId: EMPLOYER,
      kind: "objective",
      temporalStatus: "current",
      validFrom: null,
      validTo: null,
      lastObservedAt: "2026-08-20T00:00:00.000Z",
    },
    finalRank: 1,
    selectionReasonCodes: ["relevance_cutoff_canonical_key_exact"],
    ...overrides,
  };
}

function query(overrides: Partial<ConstructedRetrievalQuery> = {}): ConstructedRetrievalQuery {
  return {
    policyVersion: "memory-retrieval-query:v1",
    sourceRefs: [],
    userTexts: ["我同事小王还好吗"],
    englishQueryText: "",
    lexicalTerms: [],
    resolvedEntities: [],
    predicateCandidates: [],
    canonicalKeys: [],
    timeWordClasses: [],
    dateTokens: [],
    lanePlan: [],
    zeroSignal: false,
    ...overrides,
  };
}

describe("portrait eligibility (ADR-0111 lens, #93: no registry flag)", () => {
  it("derives eligibility from a versioned predicate table", () => {
    expect(portraitUnderstandingTier(STATED_STYLE)).not.toBeNull();
    expect(portraitUnderstandingTier(HOMETOWN)).not.toBeNull();
    // sh.plan.life_change is explicitly excluded (ADR-0111 / #93 §17).
    expect(portraitUnderstandingTier(LIFE_CHANGE)).toBeNull();
    // Project participation is a current activity, not a durable
    // person-describing predicate — retrieval-only in v1.
    expect(portraitUnderstandingTier(PROJECT)).toBeNull();
  });

  it("keeps every eligible predicate inside registry v1 with a 1..3 tier", () => {
    expect(PORTRAIT_ELIGIBLE_PREDICATES).toHaveLength(22);
    for (const entry of PORTRAIT_ELIGIBLE_PREDICATES) {
      expect(registry.entryFor(entry.predicateId)).not.toBeNull();
      expect(entry.understandingTier).toBeGreaterThanOrEqual(1);
      expect(entry.understandingTier).toBeLessThanOrEqual(3);
    }
  });
});

describe("selectMemoryForInjection — four-factor lexicographic order (AC 22)", () => {
  it("ranks current-topic relevance above understanding value", () => {
    const plan = selectMemoryForInjection({
      query: query({ predicateCandidates: [{ predicateId: EMPLOYER, surface: "工作单位" }] }),
      registry,
      portraitPool: [
        pool({
          detail: detail({ versionId: "version-topic", predicateId: EMPLOYER }),
        }),
        pool({
          detail: detail({
            versionId: "version-value",
            predicateId: CORE_PRIORITIES,
            kind: "impression",
          }),
        }),
      ],
      retrievalQualified: [],
    });
    expect(plan.portraitSelected.map((entry) => entry.detail.versionId)).toEqual([
      "version-topic",
      "version-value",
    ]);
  });

  it("ranks understanding value above cross-context stability when topics tie", () => {
    const plan = selectMemoryForInjection({
      query: query(),
      registry,
      portraitPool: [
        // stability 2 (stable-only predicate) but tier-1 understanding
        pool({ detail: detail({ versionId: "version-hometown", predicateId: HOMETOWN }) }),
        // stability 1 (current) but tier-3 understanding
        pool({
          detail: detail({ versionId: "version-style", predicateId: STATED_STYLE }),
        }),
      ],
      retrievalQualified: [],
    });
    expect(plan.portraitSelected.map((entry) => entry.detail.versionId)).toEqual([
      "version-style",
      "version-hometown",
    ]);
  });

  it("ranks cross-context stability above Evidence strength when understanding ties", () => {
    const plan = selectMemoryForInjection({
      query: query(),
      registry,
      portraitPool: [
        // ended relationship → stability 0, five evidence items
        pool({
          detail: detail({ versionId: "version-ended", predicateId: COLLEAGUE_OF, temporalStatus: "ended" }),
          validEvidenceCount: 5,
        }),
        // current relationship → stability 1, one evidence item
        pool({ detail: detail({ versionId: "version-current", predicateId: COLLEAGUE_OF }), validEvidenceCount: 1 }),
      ],
      retrievalQualified: [],
    });
    expect(plan.portraitSelected.map((entry) => entry.detail.versionId)).toEqual([
      "version-current",
      "version-ended",
    ]);
  });

  it("breaks full ties by latest valid Evidence then stable ID — never by kind", () => {
    const plan = selectMemoryForInjection({
      query: query(),
      registry,
      portraitPool: [
        pool({
          detail: detail({ versionId: "version-b", predicateId: STATED_STYLE, kind: "impression" }),
          latestEvidenceAt: "2026-08-21T00:00:00.000Z",
        }),
        pool({
          detail: detail({ versionId: "version-a", predicateId: STATED_STYLE, kind: "objective" }),
          latestEvidenceAt: "2026-08-21T00:00:00.000Z",
        }),
        pool({
          detail: detail({ versionId: "version-c", predicateId: STATED_STYLE }),
          latestEvidenceAt: "2026-08-19T00:00:00.000Z",
        }),
      ],
      retrievalQualified: [],
    });
    // version-a / version-b share the latest evidence; the stable ID breaks
    // the tie. kind (objective vs impression) never participates.
    expect(plan.portraitSelected.map((entry) => entry.detail.versionId)).toEqual([
      "version-a",
      "version-b",
      "version-c",
    ]);
  });

  it("scores topic relevance in tiers: structured match > lexical overlap > none", () => {
    const plan = selectMemoryForInjection({
      query: query({
        resolvedEntities: [{ entityId: "entity-self", basis: "label", surface: "luke" }],
        predicateCandidates: [{ predicateId: HOMETOWN, surface: "家乡" }],
        lexicalTerms: ["acme", "事情"],
      }),
      registry,
      portraitPool: [
        // lexical-only overlap through a non-broad term ("acme")
        pool({ detail: detail({ versionId: "version-lexical", predicateId: EMPLOYER }) }),
        // structured: predicate candidate matches hometown
        pool({ detail: detail({ versionId: "version-hometown", predicateId: HOMETOWN }) }),
        // no signal at all
        pool({ detail: detail({ versionId: "version-none", predicateId: COLLEAGUE_OF, lexicalTerms: ["小王"] }) }),
      ],
      retrievalQualified: [],
    });
    expect(plan.portraitSelected.map((entry) => entry.detail.versionId)).toEqual([
      "version-hometown",
      "version-lexical",
      "version-none",
    ]);
  });
});

describe("selectMemoryForInjection — budgets v1 as ceilings (AC 20)", () => {
  it("caps the Portrait at 3 items with at most 2 Impressions, without filling below rank", () => {
    const plan = selectMemoryForInjection({
      query: query(),
      registry,
      portraitPool: [
        // Both stable-semantics impressions tie on every factor; stable IDs
        // order them. impression-3 (current/ended semantics) ranks below on
        // cross-context stability and exceeds the ≤2 impression ceiling.
        pool({
          detail: detail({
            versionId: "impression-1",
            predicateId: "sh.decision.consideration_style",
            kind: "impression",
          }),
        }),
        pool({
          detail: detail({
            versionId: "impression-2",
            predicateId: CORE_PRIORITIES,
            kind: "impression",
          }),
        }),
        pool({ detail: detail({ versionId: "impression-3", predicateId: STATED_STYLE, kind: "impression" }) }),
        pool({ detail: detail({ versionId: "objective-4", predicateId: EMPLOYER }) }),
      ],
      retrievalQualified: [],
    });
    expect(plan.portraitSelected.map((entry) => entry.detail.versionId)).toEqual([
      "impression-1",
      "impression-2",
      // impression-3 exceeds the ≤2 impression ceiling; objective-4 fills the
      // remaining item slot because ceilings cap counts, they do not stop the walk.
      "objective-4",
    ]);
    expect(plan.budgetVsActual.person_portrait).toEqual({
      ceiling_items: 3,
      ceiling_impressions: 2,
      actual_items: 3,
      actual_impressions: 2,
    });
  });

  it("excludes ended AI Impressions from the Portrait pool (active impressions only)", () => {
    const plan = selectMemoryForInjection({
      query: query(),
      registry,
      portraitPool: [
        pool({
          detail: detail({
            versionId: "version-ended-impression",
            predicateId: STATED_STYLE,
            kind: "impression",
            temporalStatus: "ended",
          }),
        }),
        pool({
          detail: detail({ versionId: "version-active-impression", predicateId: CORE_PRIORITIES, kind: "impression" }),
        }),
      ],
      retrievalQualified: [],
    });
    expect(plan.portraitSelected.map((entry) => entry.detail.versionId)).toEqual(
      ["version-active-impression"],
    );
    // The fenced pool itself still counts the ended impression (manifest
    // visibility); only selection eligibility excludes it.
    expect(plan.portraitPoolCount).toBe(2);
  });

  it("returns an empty Portrait for an empty pool and never fabricates", () => {
    const plan = selectMemoryForInjection({
      query: query(),
      registry,
      portraitPool: [],
      retrievalQualified: [],
    });
    expect(plan.portraitSelected).toEqual([]);
    expect(plan.budgetVsActual.person_portrait.actual_items).toBe(0);
    expect(plan.budgetVsActual.memory_class_total.actual_items).toBe(0);
  });

  it("caps query-retrieved memory at 2 items and 1 Impression with reason codes", () => {
    const plan = selectMemoryForInjection({
      query: query(),
      registry,
      portraitPool: [],
      retrievalQualified: [
        qualified({ finalRank: 1 }),
        qualified({
          finalRank: 2,
          claim: { ...qualified().claim, versionId: "version-r2" },
        }),
        qualified({
          finalRank: 3,
          claim: { ...qualified().claim, versionId: "version-r3" },
        }),
      ],
    });
    expect(plan.retrievalSelected.map((entry) => entry.candidate.claim.versionId)).toEqual([
      "version-r1",
      "version-r2",
    ]);
    const rejected = plan.decisions.find(
      (decision) => decision.claimVersionId === "version-r3",
    );
    expect(rejected?.selectedSection).toBeNull();
    expect(rejected?.rejectionReasonCodes).toContain("budget_retrieval_ceiling");
  });

  it("rejects a second Impression against the retrieval impression ceiling", () => {
    const plan = selectMemoryForInjection({
      query: query(),
      registry,
      portraitPool: [],
      retrievalQualified: [
        qualified({
          claim: {
            ...qualified().claim,
            versionId: "version-imp-1",
            predicateId: STATED_STYLE,
            kind: "impression",
          },
          finalRank: 1,
        }),
        qualified({
          claim: {
            ...qualified().claim,
            versionId: "version-imp-2",
            predicateId: CORE_PRIORITIES,
            kind: "impression",
          },
          finalRank: 2,
        }),
      ],
    });
    const second = plan.decisions.find(
      (decision) => decision.claimVersionId === "version-imp-2",
    );
    expect(second?.selectedSection).toBeNull();
    expect(second?.rejectionReasonCodes).toContain(
      "budget_retrieval_impression_ceiling",
    );
  });

  it("injects zero memory when zero candidates qualify (ceiling, not quota)", () => {
    const plan = selectMemoryForInjection({
      query: query(),
      registry,
      portraitPool: [],
      retrievalQualified: [],
    });
    expect(plan.retrievalSelected).toEqual([]);
    expect(MEMORY_SECTION_KEYS).toEqual([
      "person_portrait",
      "objective_memory",
      "ai_impression",
    ]);
  });
});

describe("selectMemoryForInjection — global claim-version dedupe (AC 21)", () => {
  it("keeps a dual-selected Claim only in person_portrait while recording the query hit", () => {
    const sharedVersionId = "version-shared";
    const plan = selectMemoryForInjection({
      query: query(),
      registry,
      portraitPool: [
        pool({ detail: detail({ versionId: sharedVersionId, predicateId: EMPLOYER }) }),
      ],
      retrievalQualified: [
        qualified({
          claim: { ...qualified().claim, versionId: sharedVersionId, claimId: "claim-shared" },
          finalRank: 1,
        }),
        qualified({
          claim: { ...qualified().claim, versionId: "version-next" },
          finalRank: 2,
        }),
      ],
    });
    expect(plan.portraitSelected.map((entry) => entry.detail.versionId)).toEqual([
      sharedVersionId,
    ]);
    // The deduped retrieval hit does not consume a retrieval slot: the next
    // ranked candidate is still selected.
    expect(plan.retrievalSelected.map((entry) => entry.candidate.claim.versionId)).toEqual([
      "version-next",
    ]);
    const deduped = plan.decisions.find(
      (decision) => decision.claimVersionId === sharedVersionId,
    );
    expect(deduped?.selectedSection).toBe("person_portrait");
    expect(deduped?.selectionReasonCodes).toContain("selected_person_portrait");
    // One distinct claim version against the memory-class total.
    expect(plan.budgetVsActual.memory_class_total.actual_items).toBe(2);
  });
});

describe("buildMemoryContextItems", () => {
  const plan = selectMemoryForInjection({
    query: query({
      predicateCandidates: [{ predicateId: EMPLOYER, surface: "工作单位" }],
    }),
    registry,
    portraitPool: [
      pool({ detail: detail({ versionId: "version-p1", predicateId: EMPLOYER }) }),
      pool({
        detail: detail({ versionId: "version-p2", predicateId: STATED_STYLE, kind: "impression" }),
      }),
    ],
    retrievalQualified: [
      qualified({
        claim: { ...qualified().claim, versionId: "version-r1", predicateId: COLLEAGUE_OF, kind: "objective" },
        finalRank: 1,
      }),
    ],
  });

  it("builds the shared MemoryContextItem shape across all three sections", () => {
    const detailByVersion = new Map<string, MemoryVersionDetail>([
      ["version-p1", detail({ versionId: "version-p1", claimId: "claim-p1" })],
      ["version-p2", detail({ versionId: "version-p2", claimId: "claim-p2", predicateId: STATED_STYLE, kind: "impression", epistemicStatus: "inferred" })],
      ["version-r1", detail({ versionId: "version-r1", claimId: "claim-r1", predicateId: COLLEAGUE_OF, objectEntityId: "entity-wang", objectEntityVersionId: "entity-version-wang" })],
    ]);
    const evidenceByVersion = new Map<string, MemoryVersionEvidence>([
      ["version-p1", evidence({ versionId: "version-p1", evidenceIds: ["evidence-a", "evidence-b"] })],
      ["version-p2", evidence({ versionId: "version-p2", evidenceIds: ["evidence-c"] })],
      ["version-r1", evidence({ versionId: "version-r1", evidenceIds: ["evidence-d"] })],
    ]);
    const sections = buildMemoryContextItems({ plan, detailByVersion, evidenceByVersion });

    expect(sections.person_portrait).toHaveLength(2);
    expect(sections.objective_memory).toHaveLength(1);
    expect(sections.ai_impression).toHaveLength(0);

    const portraitObjective = sections.person_portrait[0]!;
    expect(portraitObjective).toMatchObject({
      claimId: "claim-p1",
      claimVersionId: "version-p1",
      kind: "objective",
      epistemicStatus: "confirmed",
      temporalStatus: "current",
      validFrom: null,
      validTo: null,
      entityVersionIds: ["entity-version-self"],
      evidenceIds: ["evidence-a", "evidence-b"],
      recallFramingPolicyVersion: RECALL_FRAMING_POLICY_VERSION,
      selectionSource: "person_portrait",
    });
    expect(portraitObjective.renderedText).toBe("Luke：工作单位：Acme");

    const portraitImpression = sections.person_portrait[1]!;
    expect(portraitImpression.kind).toBe("impression");
    expect(portraitImpression.epistemicStatus).toBe("inferred");

    const retrieved = sections.objective_memory[0]!;
    expect(retrieved.selectionSource).toBe("query_retrieval");
    expect(retrieved.entityVersionIds).toEqual([
      "entity-version-self",
      "entity-version-wang",
    ]);

    // Deterministic CompileContext-scoped references across sections.
    const refs = [
      ...sections.person_portrait,
      ...sections.objective_memory,
      ...sections.ai_impression,
    ].map((item) => item.contextMemoryRef);
    expect(refs).toEqual(["shh-memory-1", "shh-memory-2", "shh-memory-3"]);
  });
});

describe("renderMemorySection", () => {
  const items = buildMemoryContextItems({
    plan: selectMemoryForInjection({
      query: query(),
      registry,
      portraitPool: [
        pool({
          detail: detail({ versionId: "version-p1", claimId: "claim-p1" }),
        }),
        pool({
          detail: detail({
            versionId: "version-p2",
            claimId: "claim-p2",
            predicateId: STATED_STYLE,
            kind: "impression",
            epistemicStatus: "inferred",
          }),
        }),
      ],
      retrievalQualified: [],
    }),
    detailByVersion: new Map<string, MemoryVersionDetail>([
      ["version-p1", detail({ versionId: "version-p1", claimId: "claim-p1" })],
      ["version-p2", detail({ versionId: "version-p2", claimId: "claim-p2", predicateId: STATED_STYLE, kind: "impression", epistemicStatus: "inferred" })],
    ]),
    evidenceByVersion: new Map<string, MemoryVersionEvidence>([
      ["version-p1", evidence({ versionId: "version-p1", evidenceIds: ["evidence-a"] })],
      ["version-p2", evidence({ versionId: "version-p2", evidenceIds: ["evidence-b", "evidence-c"] })],
    ]),
  });

  it("renders itemized lines with reference, rendered text, ids, and pinned versions", () => {
    const content = renderMemorySection({
      key: "person_portrait",
      items: items.person_portrait,
      locale: "zh-CN",
    });
    expect(content).toContain(PORTRAIT_SELECTION_POLICY_VERSION);
    expect(content).toContain(MEMORY_BUDGETS_POLICY_VERSION);
    expect(content).toContain(RECALL_FRAMING_POLICY_VERSION);
    expect(content).toContain("[shh-memory-1]");
    expect(content).toContain("Luke：工作单位：Acme");
    expect(content).toContain("claim=claim-p1");
    expect(content).toContain("version=version-p1");
    expect(content).toContain("evidence=evidence-a");
    expect(content).toContain("kind=objective");
    expect(content).toContain("kind=impression");
  });

  it("attaches kind-specific recall framing per item and never fuses kinds into one line", () => {
    const content = renderMemorySection({
      key: "person_portrait",
      items: items.person_portrait,
      locale: "zh-CN",
    });
    const lines = content.split("\n");
    const itemLines = lines.filter((line) => line.includes("kind="));
    expect(itemLines).toHaveLength(2);
    for (const itemLine of itemLines) {
      expect(itemLine).toMatch(/kind=(objective|impression) epistemic=(confirmed|inferred)/);
    }
    // Objective framing names the user-statement basis; impression framing
    // forbids upgrading inference into a user-stated or verified fact.
    expect(content).toContain("措辞（objective）");
    expect(content).toContain("措辞（impression）");
    expect(content).toContain("不得");
  });

  it("renders locale-matched framing", () => {
    const en = renderMemorySection({
      key: "objective_memory",
      items: buildMemoryContextItems({
        plan: selectMemoryForInjection({
          query: query(),
          registry,
          portraitPool: [],
          retrievalQualified: [
            qualified({ claim: { ...qualified().claim, versionId: "version-r1" }, finalRank: 1 }),
          ],
        }),
        detailByVersion: new Map([
          ["version-r1", detail({ versionId: "version-r1" })],
        ]),
        evidenceByVersion: new Map([
          ["version-r1", evidence({ versionId: "version-r1" })],
        ]),
      }).objective_memory,
      locale: "en-US",
    });
    expect(en).toContain("Framing (objective)");
    expect(memoryLocaleOf("zh-CN")).toBe("zh");
    expect(memoryLocaleOf("en-US")).toBe("en");
  });

  it("renders a header that identifies the retrieval selection source", () => {
    const zh = renderMemorySection({
      key: "ai_impression",
      items: [],
      locale: "zh-CN",
    });
    expect(zh).toContain("ai_impression");
  });
});
