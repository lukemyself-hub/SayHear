import { describe, expect, it } from "vitest";

import {
  type PredicateLocalization,
  type PredicateRegistryEntry,
  type PredicateRegistrySnapshot,
  PREDICATE_IDS,
  loadPredicateRegistrySnapshot,
  predicateRegistryFingerprint,
} from "./index";

/**
 * Registry integrity contract for Predicate Registry v1 (grilling #93, SPEC
 * #107 AC 6–8, architecture §7.10.1 "发布、演进与验证"). These gates run on
 * every release beside the registry itself.
 */

const V1_ENTRY_IDS = [
  // 10 relationship predicates (#93 §1)
  "sh.relationship.partner_of",
  "sh.relationship.parent_of",
  "sh.relationship.sibling_of",
  "sh.relationship.friend_of",
  "sh.relationship.colleague_of",
  "sh.relationship.manager_of",
  "sh.relationship.relative_of",
  "sh.relationship.in_law_of",
  "sh.relationship.teacher_of",
  "sh.relationship.roommate_of",
  // 6 work / project / place anchors (#93 §2)
  "sh.work.employer",
  "sh.work.role_title",
  "sh.project.participation",
  "sh.place.residence",
  "sh.place.hometown",
  "sh.place.workplace",
  // 3 plan / life-stage (#93 §3)
  "sh.plan.life_change",
  "sh.life.career_stage",
  "sh.life.family_stage",
  // 2 preferences (#93 §4)
  "sh.preference.relationship_horizon",
  "sh.preference.business_travel",
  // 3 impressions (#93 §5)
  "sh.communication.stated_style",
  "sh.value.core_priorities",
  "sh.decision.consideration_style",
] as const;

const RELATIONSHIP_IDS = new Set<string>(
  V1_ENTRY_IDS.filter((id) => id.startsWith("sh.relationship.")),
);

/** Deferred relationship concepts (#93 §7): never infer to near-synonyms. */
const DEFERRED_CONCEPT_TERMS_ZH = [
  "邻居",
  "业务伙伴",
  "合作伙伴",
  "客户",
  "房东",
  "租客",
  "暧昧",
  "干亲",
  "干爹",
  "干妈",
  "教子",
] as const;
const DEFERRED_CONCEPT_TERMS_EN = [
  "neighbor",
  "business partner",
  "partner at work",
  "client",
  "customer",
  "landlord",
  "tenant",
  "godfather",
  "godmother",
] as const;

const CORE_THREE_KINSHIP_IDS = [
  PREDICATE_IDS.partnerOf,
  PREDICATE_IDS.parentOf,
  PREDICATE_IDS.siblingOf,
] as const;

function localizationsFor(
  snapshot: PredicateRegistrySnapshot,
  predicateId: string,
): PredicateLocalization[] {
  return snapshot.localizations.filter((l) => l.predicateId === predicateId);
}

describe("Predicate Registry v1 integrity", () => {
  const v1 = loadPredicateRegistrySnapshot(1);

  it("ships exactly the 24 decided entries at registry_version 1", () => {
    expect(v1.registryVersion).toBe(1);
    expect(v1.entries.map((entry) => entry.predicateId).sort()).toEqual(
      [...V1_ENTRY_IDS].sort(),
    );
  });

  it("marks zero sensitive predicates (SPEC AC 8)", () => {
    const sensitive = v1.entries.filter(
      (entry) => entry.sensitivityClass === "sensitive",
    );
    expect(sensitive).toEqual([]);
  });

  it("has no deprecated or retired entries and no replaced-by pointers in v1", () => {
    for (const entry of v1.entries) {
      expect(entry.status).toBe("active");
      expect(entry.replacedByPredicateId).toBeNull();
    }
  });

  it("scopes subjects to Self person kind outside relationships", () => {
    for (const entry of v1.entries) {
      if (!RELATIONSHIP_IDS.has(entry.predicateId)) {
        expect(entry.allowedSubjectKindIds).toEqual(["sh.entity.person"]);
      } else {
        // Relationships require both parties bound to person Entities.
        expect(entry.allowedSubjectKindIds).toEqual(["sh.entity.person"]);
        expect(entry.relationshipSemantics).not.toBeNull();
      }
    }
  });

  it("restricts relationship claims to kind=objective (hard boundary)", () => {
    for (const entry of v1.entries) {
      if (RELATIONSHIP_IDS.has(entry.predicateId)) {
        expect(entry.allowedClaimKinds).toEqual(["objective"]);
      }
    }
  });

  it("carries the global v1 evidence policies with the ADR-0039 impression floor", () => {
    for (const entry of v1.entries) {
      const allowsImpression = entry.allowedClaimKinds.includes("impression");
      expect(entry.evidencePolicyId).toBe(
        "evidence-policy.global-v1",
      );
      if (allowsImpression) {
        // ADR-0039 global floor + uniform 30-day dormant cycle (ADR-0041),
        // with no per-entry tightening anywhere in v1 (#93 §0).
        expect(entry.reviewPolicyId).toBe("review-policy.impression-global-v1");
      } else {
        expect(entry.reviewPolicyId).toBeNull();
      }
    }
    const impressionEntries = v1.entries.filter((entry) =>
      entry.allowedClaimKinds.includes("impression"),
    );
    expect(new Set(impressionEntries.map((entry) => entry.predicateId))).toEqual(
      new Set([
        PREDICATE_IDS.statedStyle,
        PREDICATE_IDS.corePriorities,
        PREDICATE_IDS.considerationStyle,
      ]),
    );
    const statedStyle = v1.entries.find(
      (entry) => entry.predicateId === PREDICATE_IDS.statedStyle,
    );
    expect(statedStyle?.allowedClaimKinds).toEqual(["objective", "impression"]);
  });

  it("declares relationship semantics: directions, roles, pair normalization, no inverse-parent fold", () => {
    const semantics = new Map(
      v1.entries
        .filter((entry) => entry.relationshipSemantics)
        .map(
          (entry) =>
            [entry.predicateId, entry.relationshipSemantics!] as const,
        ),
    );
    expect(semantics.size).toBe(10);
    expect(semantics.get(PREDICATE_IDS.partnerOf)?.direction).toBe("symmetric");
    expect(semantics.get(PREDICATE_IDS.siblingOf)?.direction).toBe("symmetric");
    expect(semantics.get(PREDICATE_IDS.friendOf)?.direction).toBe("symmetric");
    expect(semantics.get(PREDICATE_IDS.colleagueOf)?.direction).toBe(
      "symmetric",
    );
    expect(semantics.get(PREDICATE_IDS.roommateOf)?.direction).toBe("symmetric");
    expect(semantics.get(PREDICATE_IDS.relativeOf)?.direction).toBe("symmetric");

    // Directed canonical roles per #93 §1 (mention order never overrides).
    expect(semantics.get(PREDICATE_IDS.parentOf)?.canonicalSubjectRole).toBe(
      "parent",
    );
    expect(semantics.get(PREDICATE_IDS.managerOf)?.canonicalSubjectRole).toBe(
      "manager",
    );
    expect(semantics.get(PREDICATE_IDS.inLawOf)?.canonicalSubjectRole).toBe(
      "elder_generation",
    );
    expect(semantics.get(PREDICATE_IDS.teacherOf)?.canonicalSubjectRole).toBe(
      "teacher",
    );

    // The reverse projection parent→child (child_of) does not exist anywhere.
    expect(v1.entries.some((entry) => entry.predicateId.endsWith("child_of"))).toBe(
      false,
    );

    // Symmetric pair normalization declared wherever direction is symmetric.
    for (const [predicateId, rel] of semantics) {
      if (rel.direction === "symmetric") {
        expect(rel.pairNormalization, predicateId).toBe(
          "unordered_entity_pair",
        );
        expect(rel.views, predicateId).toEqual(["symmetric"]);
      } else {
        expect([...rel.views].sort(), predicateId).toEqual(["forward", "inverse"]);
      }
    }

    // Core three kinship bands declare qualifier-free subject/object side axes
    // so they can never fold into relative_of.
    expect(
      semantics.get(PREDICATE_IDS.relativeOf)?.qualifierAxes.map((a) => a.axisId),
    ).toEqual(["kinship_term"]);
  });

  it("keeps portrait-ineligible plan stage out of Portrait弹药 (#93 §0)", () => {
    const lifeChange = v1.entries.find(
      (entry) => entry.predicateId === PREDICATE_IDS.lifeChange,
    );
    expect(lifeChange).toBeDefined();
    // Excluded from Person Portrait eligibility per ADR-0111 scoping note.
    expect(lifeChange!.temporalSemantics.resolverHintProjections).toBeUndefined();
  });

  it("publishes bilingual seeds per entry per locale with the ≥2/+2 example floor", () => {
    for (const entry of v1.entries) {
      const locales = localizationsFor(v1, entry.predicateId).map(
        (l) => l.locale,
      );
      expect(locales.sort(), entry.predicateId).toEqual(["en", "zh"]);
      for (const loc of localizationsFor(v1, entry.predicateId)) {
        expect(loc.label.trim().length, `${entry.predicateId}:${loc.locale}:label`).toBeGreaterThan(0);
        expect(loc.definition.trim().length).toBeGreaterThan(0);
        expect(loc.positiveExamples.length).toBeGreaterThanOrEqual(2);
        expect(loc.negativeExamples.length).toBeGreaterThanOrEqual(2);
        // Positive seed examples ground on the entry's own published surface
        // material so mapping-eval cases stay inside the governed vocabulary.
        const surfaces = loc.lexicalSurfaces
          .filter((s) => s.form === "current")
          .map((s) => s.text.toLowerCase());
        expect(surfaces.length, `${entry.predicateId}:${loc.locale}:surfaces`).toBeGreaterThanOrEqual(1);
        const grounded = loc.positiveExamples.some((example) =>
          surfaces.some(
            (surface) =>
              surface.length > 0 &&
              example.toLowerCase().includes(surface),
          ),
        );
        expect(
          grounded,
          `${entry.predicateId}:${loc.locale} positives must use a published surface`,
        ).toBe(true);
      }
    }
  });

  it("requires relationship projection templates incl. former forms and neutral fallbacks per locale", () => {
    for (const entryId of RELATIONSHIP_IDS) {
      for (const locale of ["zh", "en"] as const) {
        const entry = v1.entries.find((e) => e.predicateId === entryId)!;
        const views = entry.relationshipSemantics!.views;
        for (const view of views) {
          const projection =
            v1.relationshipProjections.find(
              (p) =>
                p.predicateId === entryId &&
                p.locale === locale &&
                p.viewDirection === view,
            ) ?? null;
          expect(projection, `${entryId}:${locale}:${view}`).not.toBeNull();
          expect(projection!.templates.length).toBeGreaterThanOrEqual(1);
          expect(projection!.formerTemplates.length).toBeGreaterThanOrEqual(1);
        }
        // Neutral fallback surface present for both sides of speech.
        const surfaces = localizationsFor(v1, entryId)
          .find((l) => l.locale === locale)!
          .lexicalSurfaces.map((s) => s.text.toLowerCase());
        const axes = entry.relationshipSemantics!.qualifierAxes;
        for (const axis of axes) {
          const fallback =
            locale === "zh" ? axis.neutralFallbackZh : axis.neutralFallbackEn;
          if (fallback.trim().length > 0) {
            expect(
              surfaces.some((surface) => surface.includes(fallback.toLowerCase())),
              `${entryId}:${locale} neutral fallback "${fallback}"`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("never publishes deferred relationship concepts as mapping surfaces", () => {
    const allSurfaces = v1.localizations.flatMap((l) =>
      l.lexicalSurfaces.map((s) => ({
        text: s.text.toLowerCase(),
        predicateId: l.predicateId,
      })),
    );
    for (const term of DEFERRED_CONCEPT_TERMS_ZH) {
      const hits = allSurfaces.filter(
        (s) => s.text.includes(term) || term.includes(s.text),
      );
      expect(hits, `deferred zh surface "${term}"`).toEqual([]);
    }
    for (const term of DEFERRED_CONCEPT_TERMS_EN) {
      const hits = allSurfaces.filter((s) => s.text === term);
      expect(hits, `deferred en surface "${term}"`).toEqual([]);
    }
  });

  it("keeps the core three kinship bands out of relative_of surfaces", () => {
    const relativeOfSurfaces = new Set(
      localizationsFor(v1, PREDICATE_IDS.relativeOf).flatMap((l) =>
        l.lexicalSurfaces.map((s) => s.text.toLowerCase()),
      ),
    );
    for (const bandId of CORE_THREE_KINSHIP_IDS) {
      for (const loc of localizationsFor(v1, bandId)) {
        for (const surface of loc.lexicalSurfaces) {
          expect(
            relativeOfSurfaces.has(surface.text.toLowerCase()),
            `${surface.text} must stay owned by ${bandId}`,
          ).toBe(false);
        }
      }
    }
  });

  it("declares confusable relations for high-confusion pairs", () => {
    const confusables = new Set(
      v1.relations
        .filter((r) => r.relationType === "confusable_with")
        .flatMap((r) => [`${r.predicateId}|${r.relatedPredicateId}`]),
    );
    const declaredPairs: readonly (readonly [string, string])[] = [
      [PREDICATE_IDS.managerOf, PREDICATE_IDS.colleagueOf],
      [PREDICATE_IDS.parentOf, PREDICATE_IDS.relativeOf],
      [PREDICATE_IDS.partnerOf, PREDICATE_IDS.siblingOf],
      [PREDICATE_IDS.friendOf, PREDICATE_IDS.colleagueOf],
      [PREDICATE_IDS.employer, PREDICATE_IDS.workplace],
      [PREDICATE_IDS.careerStage, PREDICATE_IDS.employer],
    ];
    for (const [a, b] of declaredPairs) {
      expect(confusables.has(`${a}|${b}`) || confusables.has(`${b}|${a}`)).toBe(true);
    }
  });

  it("exposes immutable version-addressed snapshots and fails closed on unknown versions", () => {
    expect(Object.isFrozen(v1)).toBe(true);
    expect(Object.isFrozen(v1.entries[0])).toBe(true);
    expect(predicateRegistryFingerprint(v1)).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic fingerprints: repeated loads replay identically.
    expect(predicateRegistryFingerprint(loadPredicateRegistrySnapshot(1))).toBe(
      predicateRegistryFingerprint(v1),
    );
    expect(() => loadPredicateRegistrySnapshot(2)).toThrow(/registry_version/i);
  });
});

describe("PREDICATE_IDS registry id hygiene", () => {
  const v1 = loadPredicateRegistrySnapshot(1);

  it("uses sh.<semantic_domain>.<concept> snake_case with no locale or value encoding", () => {
    for (const entry of v1.entries as readonly PredicateRegistryEntry[]) {
      expect(entry.predicateId).toMatch(/^sh\.[a-z_]+\.[a-z_]+$/);
    }
  });

  it("matches shipped entry ids", () => {
    const constants = Object.values(PREDICATE_IDS) as readonly string[];
    expect(new Set(constants)).toEqual(new Set(V1_ENTRY_IDS));
  });

  it("normalizes typed values for text entries deterministically", () => {
    // sanity via direct import to keep normalization co-located with schema
    const employer = v1.entries.find(
      (e) => e.predicateId === PREDICATE_IDS.employer,
    )!;
    expect(employer.objectValueSchema.kind).toBe("text");
    const horizon = v1.entries.find(
      (e) => e.predicateId === PREDICATE_IDS.relationshipHorizon,
    )!;
    expect(horizon.objectValueSchema.kind).toBe("enum");
    if (horizon.objectValueSchema.kind === "enum") {
      expect(horizon.objectValueSchema.closedSet).toBe(true);
      expect(
        horizon.objectValueSchema.values.some((v) => v.value === "long_term"),
      ).toBe(true);
    }
    const travel = v1.entries.find(
      (e) => e.predicateId === PREDICATE_IDS.businessTravel,
    )!;
    expect(travel.objectValueSchema.kind).toBe("sentiment");
  });

  it("localization types round-trip through JSON without loss (sync payload fidelity)", () => {
    for (const loc of localizationsFor(v1, PREDICATE_IDS.inLawOf)) {
      const revived = JSON.parse(JSON.stringify(loc)) as PredicateLocalization;
      expect(revived).toEqual(loc);
    }
  });
});
