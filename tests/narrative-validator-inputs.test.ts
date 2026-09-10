import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildValidatorRequestBundle,
  type ValidatorRequestBundle,
} from "../eval/continuation-acceptance-1a3b/validator-inputs";
import {
  VALIDATOR_ERROR_CLASSES,
  type FixtureCatalog,
} from "../eval/continuation-acceptance-1a3b/protocol";
import {
  NARRATIVE_FINDINGS_SCHEMA_VERSION,
  NARRATIVE_VALIDATION_POLICY_VERSION,
  NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO,
  NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION,
} from "@sayhear/application";

const catalogPath = resolve(
  process.cwd(),
  "eval/continuation-acceptance-1a3b/fixtures.json",
);

function loadCatalog(): FixtureCatalog {
  return JSON.parse(readFileSync(catalogPath, "utf8")) as FixtureCatalog;
}

function buildBundles(): readonly ValidatorRequestBundle[] {
  return buildValidatorRequestBundle(loadCatalog(), { generatorManifests: {} });
}

describe("18-case narrative validator calibration inputs", () => {
  it("transforms exactly the frozen 18 dangerous-error cases", () => {
    const bundles = buildBundles();
    expect(bundles.length).toBe(18);
    const byClass = new Map<string, number>();
    const byKind = new Map<string, { bio: number; reflection: number }>();
    for (const bundle of bundles) {
      byClass.set(
        bundle.validatorErrorClass,
        (byClass.get(bundle.validatorErrorClass) ?? 0) + 1,
      );
      const languageVariant = bundle.fixtureId.endsWith("-en")
        ? "en"
        : bundle.fixtureId.endsWith("-zh")
          ? "zh"
          : "mix";
      const counts = byKind.get(languageVariant) ?? { bio: 0, reflection: 0 };
      if (bundle.artifactKind === "bio") counts.bio += 1;
      else counts.reflection += 1;
      byKind.set(languageVariant, counts);
    }
    expect([...byClass.keys()].sort()).toEqual([...VALIDATOR_ERROR_CLASSES].sort());
    for (const errorClass of VALIDATOR_ERROR_CLASSES) {
      expect(byClass.get(errorClass)).toBe(3);
    }
    for (const [languageVariant, counts] of byKind) {
      expect(counts, languageVariant).toEqual({ bio: 4, reflection: 2 });
    }
  });

  it("freezes the production validation input per fixture", () => {
    const bundles = buildBundles();
    const unsupported = bundles.find(
      (bundle) => bundle.fixtureId === "validator-bio-unsupported-en",
    );
    expect(unsupported).toBeDefined();
    expect(unsupported!.request.draftText).toBe(
      "The user repairs radios and owns a private observatory.",
    );
    expect(unsupported!.request.artifactKind).toBe("bio");
    expect(unsupported!.request.draftLocale).toBe("en-US");
    expect(unsupported!.request.sourceEntries).toEqual([
      {
        sourceKey: "syn-claim-validator-en",
        sourceKind: "memory_claim_version",
        text: "The fictional user repairs radios.",
        epistemicKind: "objective_memory",
      },
    ]);
    expect(unsupported!.request.validationPolicyVersion).toBe(
      NARRATIVE_VALIDATION_POLICY_VERSION,
    );
    expect(unsupported!.request.promptVersion).toBe(
      NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO,
    );
    expect(unsupported!.request.schemaVersion).toBe(
      NARRATIVE_FINDINGS_SCHEMA_VERSION,
    );
    expect(unsupported!.draftRef).toBe("validator-fixture:validator-bio-unsupported-en");

    const reflection = bundles.find(
      (bundle) => bundle.fixtureId === "validator-reflection-ambiguity-zh",
    );
    expect(reflection?.request.artifactKind).toBe("reflection");
    expect(reflection?.request.promptVersion).toBe(
      NARRATIVE_VALIDATOR_PROMPT_VERSION_REFLECTION,
    );
    expect(reflection?.request.sourceEntries[0]?.epistemicKind).toBe(
      "objective_memory",
    );
  });

  it("carries the supplied writer manifests without inventing verdicts", () => {
    const manifest = [
      {
        statementKey: "statement:1",
        text: "The user repairs radios.",
        propositionStatements: [
          {
            propositionKey: "proposition:1",
            normalizedProposition: "The user repairs radios.",
            propositionKind: "fact" as const,
            epistemicRendering: "confirmed" as const,
            supportKeys: ["syn-claim-validator-en"],
          },
        ],
      },
    ];
    const bundles = buildValidatorRequestBundle(loadCatalog(), {
      generatorManifests: { "validator-bio-unsupported-en": manifest },
    });
    const supported = bundles.find(
      (bundle) => bundle.fixtureId === "validator-bio-unsupported-en",
    );
    expect(supported?.generatorManifest).toEqual(manifest);
    const others = bundles.filter(
      (bundle) => bundle.fixtureId !== "validator-bio-unsupported-en",
    );
    expect(others.every((bundle) => bundle.generatorManifest.length === 0)).toBe(
      true,
    );
  });

  it("fails closed on an unknown shared input or source claim", () => {
    const catalog = loadCatalog();
    const broken = {
      ...catalog,
      scenarios: catalog.scenarios.map((fixture) =>
        fixture.group === "validator" && fixture.id === "validator-bio-unsupported-en"
          ? { ...fixture, sourceClaimIds: ["syn-claim-ghost"] }
          : fixture,
      ),
    };
    expect(() => buildValidatorRequestBundle(broken, { generatorManifests: {} }))
      .toThrow(/unknown source claim syn-claim-ghost/);
  });
});
