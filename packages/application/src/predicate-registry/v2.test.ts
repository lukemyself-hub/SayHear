import { describe, expect, it } from "vitest";

import {
  mapUtterance,
  PREDICATE_IDS,
  loadPredicateRegistrySnapshot,
  predicateRegistryFingerprint,
  validateMappingProposal,
} from "./index";
import { buildLegacyRegistryOverlay } from "./fixtures";

const v1 = loadPredicateRegistrySnapshot(1);
const v2 = loadPredicateRegistrySnapshot(2);
const V1_FINGERPRINT =
  "12cd39aab5a954b525c41c598ad2a18561e166a5cc0d50d2f4d7f38bf015d931";
const V2_FINGERPRINT =
  "6186cc1b27c421c143f8a56903e4fd5a0b794d0c61daa730615f62e56bd0f930";

function localization(
  version: typeof v1 | typeof v2,
  locale: "zh" | "en",
) {
  return version.localizations.find(
    (candidate) =>
      candidate.predicateId === PREDICATE_IDS.friendOf &&
      candidate.locale === locale,
  )!;
}

describe("Predicate Registry v2 Friendship release", () => {
  it("publishes the same machine vocabulary with Friendship state material", () => {
    expect(v2.registryVersion).toBe(2);
    expect(v2.entries).toHaveLength(v1.entries.length);
    expect(v2.entries.every((entry) => entry.registryVersion === 2)).toBe(true);

    expect(localization(v1, "en").label).toBe("Friend");
    expect(localization(v2, "en")).toMatchObject({
      label: "Friendship",
      localizationVersion: 2,
    });
    expect(
      localization(v2, "en").lexicalSurfaces.map((surface) => surface.text),
    ).toEqual(expect.arrayContaining(["friend", "friends", "friendship"]));
    expect(
      v2.entries
        .find((entry) => entry.predicateId === PREDICATE_IDS.friendOf)
        ?.relationshipSemantics?.qualifierAxes.find(
          (axis) => axis.axisId === "relation_origin",
        )?.neutralFallbackEn,
    ).toBe("friendship");
    expect(
      v2.relationshipProjections.find(
        (projection) =>
          projection.predicateId === PREDICATE_IDS.friendOf &&
          projection.locale === "en",
      ),
    ).toMatchObject({
      templates: expect.arrayContaining(["{subject} and {object} are friends"]),
      roleProjectionVersion: 2,
    });

    expect(predicateRegistryFingerprint(v1)).toBe(V1_FINGERPRINT);
    expect(predicateRegistryFingerprint(v2)).toBe(V2_FINGERPRINT);
  });

  it("maps English Friendship state phrasing through the v2 snapshot", () => {
    for (const text of [
      "Alex and I are friends from college.",
      "Our friendship goes back years.",
    ]) {
      const outcome = mapUtterance({ text, locale: "en", snapshot: v2 });
      expect(outcome.status, text).toBe("mapped");
      if (outcome.status === "mapped") {
        expect(outcome.predicateId).toBe(PREDICATE_IDS.friendOf);
      }
    }
  });

  it("keeps v1 replay material stable and rejects deprecated predecessor writes", () => {
    expect(localization(v1, "en").label).toBe("Friend");
    expect(
      localization(v1, "en").lexicalSurfaces.some(
        (surface) => surface.text === "friendship",
      ),
    ).toBe(false);

    const legacy = buildLegacyRegistryOverlay(0);
    const result = validateMappingProposal(legacy, {
      registryVersion: 0,
      predicateId: "sh.work.company",
      typedValueRaw: "Acme",
      claimKind: "objective",
      locale: "en",
    });
    expect(result).toMatchObject({ valid: false, errorCode: "DEPRECATED_PREDICATE" });

    const validV2 = validateMappingProposal(v2, {
      registryVersion: 2,
      predicateId: PREDICATE_IDS.friendOf,
      typedValueRaw: "",
      claimKind: "objective",
      locale: "en",
      participants: { subject: "self", object: "Alex" },
    });
    expect(validV2.valid).toBe(true);
  });
});
