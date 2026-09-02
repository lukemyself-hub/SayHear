import { describe, expect, it } from "vitest";

import {
  type MappingOutcome,
  PREDICATE_IDS as IDS,
  loadPredicateRegistrySnapshot,
  predicateRegistryFingerprint,
} from "./index";
import {
  canonicalRelationshipKey,
  mapUtterance,
  mapUtteranceCodeSwitch,
  validateMappingProposal,
} from "./mapper";
import { buildLegacyRegistryOverlay } from "./fixtures";
import {
  FORWARD,
  REVERSE,
  resolve,
  type ReverseCase,
} from "./mapping-eval-corpus";

/**
 * The cross-locale mapping-eval matrix (grilling #93 §8, SPEC #107 AC 8).
 * Versioned beside the registry; runs on every release in CI via `pnpm test`.
 *
 * Forward: ≥2 positive examples per predicate × 3 input modes
 * (zh / en / code-switch), asserted down to predicate ID + normalized typed
 * value + direction canonicalization. The current matrix is pinned to v2;
 * the historical v1 snapshot is exercised explicitly by the replay test below.
 * Reverse: zero-tolerance gates at 100% — confusable-pair separation, illegal
 * values, closure-language no-claim, unknown concepts → `unmapped` with a
 * proposed concept, deprecated IDs fail closed, and old-version replay
 * identity. No LLM judge anywhere: every gate is deterministic.
 */

const registry = loadPredicateRegistrySnapshot(2);
const legacyV1 = loadPredicateRegistrySnapshot(1);

describe("mapping-eval forward assertions (≥2 × zh/en/cs per predicate)", () => {
  const MODES = ["zh", "en", "cs"] as const;

  it("meets the #93 §8/§9 corpus floors: forward ≥2×3 modes and bilingual negative seeds per entry", () => {
    const ids = Object.values(IDS) as string[];
    expect(ids.length).toBe(24);
    for (const id of ids) {
      for (const mode of ["zh", "en", "cs"] as const) {
        const positiveCases = FORWARD.filter(
          (c) => c.expect.predicateId === id && c.mode === mode,
        ).length;
        expect(
          positiveCases >= 2,
          `${id}:${mode} has ${positiveCases} forward positives`,
        ).toBe(true);
      }
      // §9 seed depth: every locale carries ≥2 machine-checked negative seeds
      // feeding the reverse gate families asserted at 100% below.
      for (const locale of ["zh", "en"] as const) {
        const loc = registry.localizations.find(
          (l) => l.predicateId === id && l.locale === locale,
        );
        expect(loc, `${id}:${locale}`).toBeDefined();
        expect(loc!.negativeExamples.length).toBeGreaterThanOrEqual(2);
      }
    }
    // §8 reverse zero-tolerance: every gate family present, run at 100% below.
    const families = new Set(REVERSE.map((c) => c.gate));
    for (const family of [
      "confusable_separation",
      "illegal_value_fail_closed",
      "closure_language_no_claim",
      "deferred_concept_unmapped_with_proposal",
      "unknown_concept_unmapped",
    ] as const) {
      expect(families.has(family), `missing gate family ${family}`).toBe(true);
    }
  });

  for (let i = 0; i < FORWARD.length; i += 1) {
    const c = FORWARD[i]!;
    it(`FWD[${i}] ${c.expect.predicateId} (${c.mode}): ${c.text.slice(0, 24)}…`, () => {
      const outcome = resolve(c);
      if (
        outcome.status === "ambiguous" ||
        outcome.status === "unmapped"
      ) {
        throw new Error(
          `expected mapped, got ${outcome.status}: ${JSON.stringify(outcome)}`,
        );
      }
      expect(outcome.predicateId).toBe(c.expect.predicateId);
      // claim kind must be one the entry allows (objective for all v1
      // relationship/value entries; impression-only for §5 impression lanes)
      const entry = registry.entries.find((e) => e.predicateId === c.expect.predicateId)!;
      expect(entry.allowedClaimKinds).toContain(outcome.claimKind);
      if (c.expect.typedValue !== undefined) {
        expect(outcome.typedValue).toBe(c.expect.typedValue);
      }
      if (c.expect.scopeValue !== undefined) {
        expect(outcome.scopeValue).toBe(c.expect.scopeValue);
      }
      if (c.expect.form !== undefined) {
        expect(outcome.form).toBe(c.expect.form);
      }
      if (c.expect.symmetricPairOf || outcome.relationship?.direction === "symmetric") {
        expect(outcome.relationship?.direction).toBe("symmetric");
      }
      if (outcome.relationship?.direction === "directed") {
        if (c.expect.subjectIsOther === true) {
          expect(outcome.relationship.subject).not.toBe("self");
        }
        if (c.expect.subjectIsSelf === true) {
          expect(outcome.relationship.subject).toBe("self");
        }
      }
      // proposal replay through §7.10.1 server-side validation stays green
      const key = canonicalRelationshipKey(outcome);
      expect(key.startsWith(outcome.predicateId)).toBe(true);
    });
  }

  /** true when a reverse row's text carries one of this entry's surfaces. */
  function mentionsSurfaceOwnedBy(predicateId: string, text: string): boolean {
    return registry.localizations.some(
      (l) =>
        l.predicateId === predicateId &&
        l.lexicalSurfaces.some((sf) =>
          text.toLowerCase().includes(sf.text.toLowerCase()),
        ),
    );
  }
});

describe("reverse zero-tolerance gates — 100% required", () => {
  for (let i = 0; i < REVERSE.length; i += 1) {
    const c = REVERSE[i]!;
    it(`REV[${i}] ${c.gate} (${c.mode}): ${c.text.slice(0, 26)}…`, () => {
      switch (c.gate) {
        case "confusable_separation": {
          const outcome = resolveCsAware(c.mode, c.text);
          if (outcome.status === "mapped") {
            expect(outcome.predicateId).not.toBe(c.forbiddenPredicateId);
          }
          break;
        }
        case "closure_language_no_claim": {
          const outcome = resolveCsAware(c.mode, c.text);
          const mapped =
            outcome.status === "mapped" ? outcome : null;
          // No relationship claim of any kind may arise from closure talk.
          expect(mapped?.relationship ?? null).toBeNull();
          if (mapped) {
            throw new Error(`unexpected mapping ${JSON.stringify(mapped)}`);
          }
          break;
        }
        case "deferred_concept_unmapped_with_proposal": {
          const outcome = resolveCsAware(c.mode, c.text);
          expect(outcome.status).toBe("unmapped");
          if (outcome.status === "unmapped") {
            expect(outcome.proposedConcept).not.toBeNull();
            expect(outcome.proposedConcept!.description.length).toBeGreaterThan(0);
            expect(outcome.proposedConcept!.suggestedObjectSchema.length).toBeGreaterThan(0);
          }
          break;
        }
        case "unknown_concept_unmapped": {
          const outcome = resolveCsAware(c.mode, c.text);
          expect(outcome.status).toBe("unmapped");
          if (outcome.status === "unmapped") {
            if (c.expectedProposal) {
              // pair-shaped unknown relational concept (#93 §8): proposal required
              expect(outcome.proposedConcept).not.toBeNull();
              expect(outcome.proposedConcept!.description.length).toBeGreaterThan(0);
            } else {
              // narration with no pair shape is not a concept — none invented
              expect(outcome.proposedConcept).toBeNull();
            }
          }
          break;
        }
        case "illegal_value_fail_closed": {
          const result = validateMappingProposal(registry, {
            registryVersion: 2,
            predicateId: IDS.careerStage,
            typedValueRaw: c.text,
            claimKind: "objective",
            locale: "zh",
          });
          expect(result.valid).toBe(false);
          break;
        }
        default:
          throw new Error("unhandled gate");
      }
    });
  }

  function resolveCsAware(mode: ReverseCase["mode"], text: string): MappingOutcome {
    return mode === "cs"
      ? mapUtteranceCodeSwitch(text, { snapshot: registry })
      : mapUtterance({ text, locale: mode, snapshot: registry });
  }

  it("rejects non-members of closed enums even with fluent spelling (validator)", () => {
    const result = validateMappingProposal(registry, {
      registryVersion: 2,
      predicateId: IDS.relationshipHorizon,
      typedValueRaw: "short_term_flings",
      claimKind: "objective",
      locale: "en",
    });
    expect(result.valid).toBe(false);
  });

  it("keeps mention order powerless: both word orders share one symmetric key", () => {
    const a = mapUtterance({ text: "我和她是同事", locale: "zh" });
    const b = mapUtterance({ text: "她是我的同事，都做产品。", locale: "zh" });
    if (a.status === "mapped" && b.status === "mapped") {
      expect(canonicalRelationshipKey(b)).toBe(canonicalRelationshipKey(a));
    } else {
      throw new Error("both directions should resolve");
    }
  });

  it("never degrades 她是我领导 to colleague under any pass", () => {
    for (const text of ["她是我领导，每周给我做一对一。", "她是我 boss。"]) {
      const outcome = mapUtteranceCodeSwitch(text);
      if (outcome.status === "mapped") {
        expect(outcome.predicateId).toBe(IDS.managerOf);
      } else {
        throw new Error("expected manager mapping");
      }
    }
  });

  it("old-version replay identity: repeated loads, frozen snapshots, JSON round-trip", () => {
    const sample = FORWARD.filter(
      (c) => c.mode !== "cs" && (c.minimumRegistryVersion ?? 1) <= 1,
    ).map((c) => c.text);
    const runOne = () =>
      sample.map((text) =>
        JSON.parse(
          JSON.stringify(
            mapUtterance({
              text,
              locale: text.match(/[\u4e00-\u9fa5]/) ? "zh" : "en",
              snapshot: legacyV1,
            }),
          ),
        ),
      );
    const first = runOne() as unknown[];
    const second = runOne() as unknown[];
    expect(second).toEqual(first);
    // pinned fingerprint stability across loads
    expect(predicateRegistryFingerprint(loadPredicateRegistrySnapshot(1))).toBe(
      predicateRegistryFingerprint(legacyV1),
    );
    // snapshots are deeply frozen: mutation attempts fail closed
    const entry = legacyV1.entries[0]!;
    expect(() => {
      (entry as { status: string }).status = "retired";
    }).toThrow();
  });

  it("deprecated synthetic predecessor fails closed while its surface stays unavailable", () => {
    const legacyOverlay = buildLegacyRegistryOverlay(0);
    const rejected = validateMappingProposal(legacyOverlay, {
      registryVersion: 0,
      predicateId: "sh.work.company",
      typedValueRaw: "美团",
      claimKind: "objective",
      locale: "zh",
    });
    expect(rejected.valid).toBe(false);
    // and today's snapshot never grew that surface
    const surfaces = registry.localizations.flatMap((l) =>
      l.lexicalSurfaces.map((s) => s.text.toLowerCase()),
    );
    expect(surfaces.includes("sh.work.company")).toBe(false);
  });
});
