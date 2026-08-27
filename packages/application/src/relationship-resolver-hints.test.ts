import { describe, expect, it } from "vitest";

import { asMemoryClaimId, asMemoryClaimVersionId } from "@sayhear/domain";

import { PREDICATE_IDS, loadPredicateRegistrySnapshot } from "./predicate-registry";
import { planRelationshipResolverHints } from "./relationship-resolver-hints";

const registry = loadPredicateRegistrySnapshot(1);

const SELF = "01984477-31e1-7595-92c6-0688a0a00001";
const LILY = "01984477-31e1-7595-92c6-0688a0a00003";
const CLAIM_ID = asMemoryClaimId("01984477-31e1-7595-92c6-0688a0e00001");
const VERSION_ID = asMemoryClaimVersionId("01984477-31e1-7595-92c6-0688a0e00002");

const LABELS = Object.freeze({
  [SELF]: { zh: "我", en: "I" },
  [LILY]: { zh: "莉莉", en: "Lily" },
});

function plan(input: {
  predicateId: string;
  temporalStatus: "current" | "ended" | "unknown";
  qualifiers?: readonly {
    axisId: string;
    roleSide: "canonical_subject" | "counterpart";
    typedValue: string | readonly string[];
  }[];
  labels?: Readonly<Record<string, { zh: string | null; en: string | null }>>;
  resolverHintProjections?: { current: boolean; former: boolean };
}) {
  const entry = registry.entries.find((e) => e.predicateId === input.predicateId)!;
  const effectiveEntry = input.resolverHintProjections
    ? {
        ...entry,
        temporalSemantics: {
          ...entry.temporalSemantics,
          resolverHintProjections: input.resolverHintProjections,
        },
      }
    : entry;
  return planRelationshipResolverHints({
    projections: registry.relationshipProjections,
    localizations: registry.localizations,
    entry: effectiveEntry,
    claim: {
      memoryClaimId: CLAIM_ID,
      predicateId: input.predicateId,
      subjectEntityId: SELF,
      objectEntityId: LILY,
    },
    currentVersion: {
      memoryClaimVersionId: VERSION_ID,
      temporal: {
        temporalStatus: input.temporalStatus,
        validFrom: null,
        validFromPrecision: "unknown",
        validTo: null,
        validToPrecision: "unknown",
      },
    },
    qualifiers:
      input.qualifiers?.map((qualifier) => ({
        memoryClaimVersionQualifierId: VERSION_ID,
        memoryClaimVersionId: VERSION_ID,
        axisId: qualifier.axisId,
        roleSide: qualifier.roleSide,
        typedValue: qualifier.typedValue,
        evidenceItemIds: [],
        createdAt: new Date(0),
      })) ?? [],
    labels: input.labels ?? LABELS,
  });
}

describe("relationship resolver hint planner (#115: ADR-0027 / 0030 / 0031 / 0033)", () => {
  it("projects qualifier terms with neutral fallback for the other side, per locale", () => {
    const rows = plan({
      predicateId: PREDICATE_IDS.relativeOf,
      temporalStatus: "current",
      qualifiers: [
        { axisId: "kinship_term", roleSide: "counterpart", typedValue: "姑姑" },
      ],
    });
    // symmetric claim: both parties × both locales × one axis
    expect(rows).toHaveLength(4);
    const lilyZh = rows.find(
      (row) => row.locale === "zh" && row.resolvedEntityId === LILY,
    )!;
    expect(lilyZh).toMatchObject({
      memoryClaimId: CLAIM_ID,
      memoryClaimVersionId: VERSION_ID,
      contextEntityId: SELF,
      viewDirection: "symmetric",
      temporalForm: "current",
      roleSide: "counterpart",
      roleAxisId: "kinship_term",
      roleTerm: "姑姑",
      roleSource: "qualifier",
      phrase: "我是莉莉的亲戚",
    });
    const selfZh = rows.find(
      (row) => row.locale === "zh" && row.resolvedEntityId === SELF,
    )!;
    expect(selfZh).toMatchObject({
      roleAxisId: "kinship_term",
      roleTerm: "亲戚",
      roleSource: "neutral_fallback",
    });
    const lilyEn = rows.find(
      (row) => row.locale === "en" && row.resolvedEntityId === LILY,
    )!;
    expect(lilyEn).toMatchObject({
      roleTerm: "姑姑",
      roleSource: "qualifier",
      phrase: "I is Lily's relative",
    });
    const selfEn = rows.find(
      (row) => row.locale === "en" && row.resolvedEntityId === SELF,
    )!;
    expect(selfEn).toMatchObject({
      roleTerm: "relative",
      roleSource: "neutral_fallback",
    });
  });

  it("falls back to the axis neutral term on both sides when no qualifier exists", () => {
    const rows = plan({
      predicateId: PREDICATE_IDS.relativeOf,
      temporalStatus: "current",
    });
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.roleSource).toBe("neutral_fallback");
      expect(row.roleTerm).toBe(row.locale === "zh" ? "亲戚" : "relative");
    }
  });

  it("renders no hint at all while the temporal state is unknown (ADR-0030)", () => {
    expect(
      plan({ predicateId: PREDICATE_IDS.relativeOf, temporalStatus: "unknown" }),
    ).toEqual([]);
  });

  it("switches to the registry former projection when the relationship ended", () => {
    const rows = plan({
      predicateId: PREDICATE_IDS.partnerOf,
      temporalStatus: "ended",
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.temporalForm).toBe("former");
      expect(row.phrase).toContain(row.locale === "zh" ? "曾是" : "used to be");
    }
  });

  it("uses the registry label as the role term for axis-less relationship entries", () => {
    const rows = plan({
      predicateId: PREDICATE_IDS.partnerOf,
      temporalStatus: "current",
    });
    expect(rows).toHaveLength(4);
    const lilyZh = rows.find(
      (row) => row.locale === "zh" && row.resolvedEntityId === LILY,
    )!;
    expect(lilyZh).toMatchObject({
      roleAxisId: null,
      roleTerm: "伴侣关系",
      roleSource: "predicate_label",
      phrase: "我是莉莉的伴侣",
    });
  });

  it("resolves enum qualifier values to their locale surface", () => {
    const rows = plan({
      predicateId: PREDICATE_IDS.friendOf,
      temporalStatus: "current",
      qualifiers: [
        { axisId: "stated_closeness", roleSide: "counterpart", typedValue: "best" },
      ],
    });
    const lilyClosenessZh = rows.find(
      (row) =>
        row.locale === "zh" &&
        row.resolvedEntityId === LILY &&
        row.roleAxisId === "stated_closeness",
    );
    expect(lilyClosenessZh).toMatchObject({
      roleTerm: "闺蜜",
      roleSource: "qualifier",
    });
    const lilyClosenessEn = rows.find(
      (row) =>
        row.locale === "en" &&
        row.resolvedEntityId === LILY &&
        row.roleAxisId === "stated_closeness",
    );
    expect(lilyClosenessEn).toMatchObject({
      roleTerm: "bestie",
      roleSource: "qualifier",
    });
    // the origin axis still carries its neutral fallback rows
    const lilyOriginZh = rows.find(
      (row) =>
        row.locale === "zh" &&
        row.resolvedEntityId === LILY &&
        row.roleAxisId === "relation_origin",
    );
    expect(lilyOriginZh).toMatchObject({
      roleTerm: "朋友",
      roleSource: "neutral_fallback",
    });
  });

  it("keeps structured rows but drops the phrase when a locale label is missing", () => {
    const rows = plan({
      predicateId: PREDICATE_IDS.relativeOf,
      temporalStatus: "current",
      labels: { [SELF]: { zh: null, en: null }, [LILY]: { zh: "莉莉", en: null } },
    });
    for (const row of rows) {
      expect(row.phrase).toBeNull();
    }
    expect(rows).toHaveLength(4);
  });

  it("respects the entry's resolverHintProjections gate", () => {
    expect(
      plan({
        predicateId: PREDICATE_IDS.relativeOf,
        temporalStatus: "current",
        resolverHintProjections: { current: false, former: true },
      }),
    ).toEqual([]);
  });

  it("projects nothing for non-relationship entries", () => {
    expect(
      plan({ predicateId: PREDICATE_IDS.residence, temporalStatus: "current" }),
    ).toEqual([]);
  });

  it("renders directed entries through forward and inverse views per side", () => {
    const rows = plan({
      predicateId: PREDICATE_IDS.parentOf,
      temporalStatus: "current",
    });
    // axis-less: both parties × both locales
    expect(rows).toHaveLength(4);
    const subjectEn = rows.find(
      (row) => row.locale === "en" && row.resolvedEntityId === SELF,
    )!;
    expect(subjectEn.viewDirection).toBe("forward");
    expect(subjectEn.phrase).toBe("I is Lily's parent");
    const counterpartEn = rows.find(
      (row) => row.locale === "en" && row.resolvedEntityId === LILY,
    )!;
    expect(counterpartEn.viewDirection).toBe("inverse");
    expect(counterpartEn.phrase).toBe("Lily is I's child");
  });
});
