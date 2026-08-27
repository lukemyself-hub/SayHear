import { describe, expect, it } from "vitest";

import {
  ENTITY_KINDS,
  levenshteinEntityLabelDistance,
  normalizeEntityLabel,
  planEntityMentionResolution,
  validateMentionProposals,
  type EntityLabelIndexEntry,
  type EntityMentionProposal,
} from "./entity";

const SELF = "11111111-1111-7111-8111-111111111111";
const E_WANG = "22222222-2222-7222-8222-222222222222";
const E_MARLA = "33333333-3333-7333-8333-333333333333";
const E_ALIAS_TARGET = "44444444-4444-7444-8444-444444444444";

function label(
  entityId: string,
  normalizedLabel: string,
  labelKind: "primary" | "alias" = "primary",
): EntityLabelIndexEntry {
  return {
    entityId,
    label: normalizedLabel,
    normalizedLabel,
    labelKind,
    locale: "zh-CN",
  };
}

function proposal(
  overrides: Partial<EntityMentionProposal> = {},
): EntityMentionProposal {
  return {
    surfaceForm: "王小龙",
    locatorType: "text_span",
    startOffset: 0,
    endOffset: 3,
    mentionKind: "named",
    newIntroduction: false,
    entityKindId: ENTITY_KINDS.person,
    evidenceId: null,
    ...overrides,
  };
}

describe("normalizeEntityLabel", () => {
  it("folds case, width, and whitespace deterministically", () => {
    expect(normalizeEntityLabel("  Xiaolong   WANG ")).toBe("xiaolong wang");
    expect(normalizeEntityLabel("ＸＩＡＯＬＯＮＧ Ｗａｎｇ")).toBe(
      "xiaolong wang",
    );
    expect(normalizeEntityLabel("王小龙")).toBe("王小龙");
  });
});

describe("levenshteinEntityLabelDistance", () => {
  it("computes classic distances", () => {
    expect(levenshteinEntityLabelDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinEntityLabelDistance("marie", "marla")).toBe(2);
    expect(levenshteinEntityLabelDistance("jon", "john")).toBe(1);
    expect(levenshteinEntityLabelDistance("same", "same")).toBe(0);
  });
});

describe("validateMentionProposals", () => {
  it("rejects offset/locator mismatches", () => {
    expect(() =>
      validateMentionProposals([
        proposal({ locatorType: "whole_revision", startOffset: 0 }),
      ]),
    ).toThrow(/whole_revision/);
    expect(() =>
      validateMentionProposals([
        proposal({ startOffset: 5, endOffset: 2 }),
      ]),
    ).toThrow(/offsets/i);
  });

  it("rejects newIntroduction outside named mentions and unknown kinds", () => {
    expect(() =>
      validateMentionProposals([
        proposal({ mentionKind: "pronoun", newIntroduction: true }),
      ]),
    ).toThrow(/newIntroduction/);
    expect(() =>
      validateMentionProposals([
        proposal({ entityKindId: "sh.entity.pet" as never }),
      ]),
    ).toThrow(/entityKindId/);
  });
});

describe("planEntityMentionResolution", () => {
  const index = [
    label(E_WANG, "王小龙"),
    label(E_MARLA, "marla"),
    label(E_ALIAS_TARGET, "xiaolong wang", "alias"),
  ];

  it("binds first-person references to the Self Entity deterministically", () => {
    const [plan] = planEntityMentionResolution(
      { selfEntityId: SELF, locale: "zh-CN", labels: index },
      [
        proposal({
          surfaceForm: "我",
          mentionKind: "first_person",
          startOffset: 0,
          endOffset: 1,
        }),
      ],
    );
    expect(plan).toMatchObject({
      outcome: "bound_self",
      entityId: SELF,
      resolutionStatus: "resolved",
    });
  });

  it("creates an unresolved Entity for a named new introduction, even same-name", () => {
    const plans = planEntityMentionResolution(
      { selfEntityId: SELF, locale: "zh-CN", labels: index },
      [proposal({ surfaceForm: "王小龙", newIntroduction: true })],
    );
    expect(plans[0]).toMatchObject({
      outcome: "created_unresolved",
      createEntity: true,
      entityId: null,
      entityKindId: ENTITY_KINDS.person,
      resolutionStatus: "resolved",
    });
    expect(plans[0]!.primaryLabel).toMatchObject({
      label: "王小龙",
      normalizedLabel: "王小龙",
    });
  });

  it("deduplicates repeated same-form introductions inside one batch", () => {
    const plans = planEntityMentionResolution(
      { selfEntityId: SELF, locale: "zh-CN", labels: index },
      [
        proposal({ surfaceForm: "王小龙", newIntroduction: true, startOffset: 0, endOffset: 3 }),
        proposal({ surfaceForm: "王小龙", newIntroduction: true, startOffset: 10, endOffset: 13 }),
      ],
    );
    expect(plans[1]).toMatchObject({
      outcome: "created_unresolved",
      createEntity: false,
      bindToBatchIndex: 0,
    });
  });

  it("binds a later same-form reference to the Entity introduced in the same batch", () => {
    const plans = planEntityMentionResolution(
      { selfEntityId: SELF, locale: "zh-CN", labels: index },
      [
        proposal({ surfaceForm: "王小龙", newIntroduction: true, startOffset: 0, endOffset: 3 }),
        proposal({ surfaceForm: "王小龙", newIntroduction: false, startOffset: 10, endOffset: 13 }),
      ],
    );
    expect(plans[1]).toMatchObject({
      outcome: "created_unresolved",
      createEntity: false,
      bindToBatchIndex: 0,
      resolutionStatus: "resolved",
    });
  });

  it("binds unique exact matches, including verified aliases across scripts", () => {
    const [plan] = planEntityMentionResolution(
      { selfEntityId: SELF, locale: "en-US", labels: index },
      [proposal({ surfaceForm: "Xiaolong WANG", startOffset: 0, endOffset: 12 })],
    );
    expect(plan).toMatchObject({
      outcome: "bound",
      entityId: E_ALIAS_TARGET,
      resolutionStatus: "resolved",
    });
  });

  it("stays ambiguous on multiple exact matches with multi_exact candidates", () => {
    const [plan] = planEntityMentionResolution(
      {
        selfEntityId: SELF,
        locale: "zh-CN",
        labels: [label(E_WANG, "王小龙"), label(E_MARLA, "王小龙")],
      },
      [proposal({ surfaceForm: "王小龙" })],
    );
    expect(plan).toMatchObject({
      outcome: "ambiguous",
      entityId: null,
      resolutionStatus: "ambiguous",
    });
    expect(plan!.candidates.map((c) => c.candidateKind)).toEqual([
      "multi_exact",
      "multi_exact",
    ]);
  });

  it("never binds fuzzy near-forms — candidates only", () => {
    const [plan] = planEntityMentionResolution(
      { selfEntityId: SELF, locale: "en-US", labels: index },
      [proposal({ surfaceForm: "Marie", startOffset: 0, endOffset: 5 })],
    );
    expect(plan).toMatchObject({
      outcome: "unbound",
      entityId: null,
      resolutionStatus: "unresolved",
    });
    expect(plan!.candidates).toEqual([
      {
        entityId: E_MARLA,
        matchedLabel: "marla",
        candidateKind: "near_form",
        editDistance: 2,
      },
    ]);
  });

  it("detects containment near-forms for partial names", () => {
    const [plan] = planEntityMentionResolution(
      { selfEntityId: SELF, locale: "zh-CN", labels: index },
      [proposal({ surfaceForm: "小龙", startOffset: 0, endOffset: 2 })],
    );
    expect(plan!.outcome).toBe("unbound");
    expect(plan!.candidates).toContainEqual({
      entityId: E_WANG,
      matchedLabel: "王小龙",
      candidateKind: "near_form",
      editDistance: null,
    });
  });

  it("keeps pronouns unbound with no candidates", () => {
    const [plan] = planEntityMentionResolution(
      { selfEntityId: SELF, locale: "zh-CN", labels: index },
      [
        proposal({
          surfaceForm: "她",
          mentionKind: "pronoun",
          startOffset: 0,
          endOffset: 1,
        }),
      ],
    );
    expect(plan).toMatchObject({
      outcome: "unbound",
      entityId: null,
      resolutionStatus: "unresolved",
      candidates: [],
    });
  });

  it("keeps unmatched names unbound with no candidates", () => {
    const [plan] = planEntityMentionResolution(
      { selfEntityId: SELF, locale: "zh-CN", labels: index },
      [proposal({ surfaceForm: "完全不相关的名字" })],
    );
    expect(plan!.outcome).toBe("unbound");
    expect(plan!.candidates).toEqual([]);
  });

  it("deduplicates near-form candidates per entity, best distance first", () => {
    const [plan] = planEntityMentionResolution(
      {
        selfEntityId: SELF,
        locale: "en-US",
        labels: [
          label(E_WANG, "maria"),
          label(E_WANG, "mariah"),
          label(E_MARLA, "marla"),
        ],
      },
      [proposal({ surfaceForm: "Marie", startOffset: 0, endOffset: 5 })],
    );
    const entityIds = plan!.candidates.map((c) => c.entityId);
    expect(new Set(entityIds).size).toBe(entityIds.length);
    expect(entityIds[0]).toBe(E_WANG);
    expect(entityIds).toContain(E_MARLA);
  });
});
