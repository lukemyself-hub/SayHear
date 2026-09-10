import { describe, expect, it } from "vitest";
import { asUserId } from "@sayhear/domain";

import {
  compareNarrativeManifests,
  evaluateNarrativeValidation,
  normalizeNarrativePropositionText,
  validateNarrativeRequest,
} from "./engine";
import {
  MAX_NARRATIVE_FINDINGS_PER_RESULT,
  NARRATIVE_FINDINGS_SCHEMA_VERSION,
  NARRATIVE_VALIDATION_POLICY_VERSION,
  NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO,
  type NarrativeGeneratorStatement,
  type NarrativeSourceEntry,
  type NarrativeValidationRequest,
} from "./types";

const userId = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");

function sourceEntry(overrides: Partial<NarrativeSourceEntry> = {}): NarrativeSourceEntry {
  return {
    sourceKey: "claim:1",
    sourceKind: "memory_claim_version",
    text: "The fictional user repairs radios.",
    epistemicKind: "objective_memory",
    ...overrides,
  };
}

function generatorStatement(
  overrides: Partial<NarrativeGeneratorStatement> = {},
): NarrativeGeneratorStatement {
  return {
    statementKey: "statement:1",
    text: "The user repairs radios.",
    propositionStatements: [
      {
        propositionKey: "proposition:1",
        normalizedProposition: "The user repairs radios.",
        propositionKind: "fact",
        epistemicRendering: "confirmed",
        supportKeys: ["claim:1"],
      },
    ],
    ...overrides,
  };
}

function validationRequest(
  overrides: Partial<NarrativeValidationRequest> = {},
): NarrativeValidationRequest {
  return {
    userId,
    artifactKind: "bio",
    draftRef: "bio-version:01984477-1f9a-7b25-a5cc-000000000001",
    draftLocale: "en-US",
    draftText: "The user repairs radios.",
    generatorManifest: [generatorStatement()],
    sourceEntries: [sourceEntry()],
    plannedCoverageKeys: ["claim:1"],
    validationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
    promptVersion: NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO,
    schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
    ...overrides,
  };
}

describe("narrative validation engine", () => {
  describe("normalizeNarrativePropositionText", () => {
    it("collapses whitespace, trims and lowercases", () => {
      expect(
        normalizeNarrativePropositionText("  The  user\n repairs  radios.  "),
      ).toBe("the user repairs radios.");
    });

    it("matches identical propositions across casing and spacing", () => {
      expect(
        normalizeNarrativePropositionText("The  user repairs radios.") ===
          normalizeNarrativePropositionText("the user repairs radios."),
      ).toBe(true);
    });
  });

  describe("validateNarrativeRequest", () => {
    it("accepts a well-formed request", () => {
      expect(validateNarrativeRequest(validationRequest())).toBeNull();
    });

    it("rejects an empty draft ref", () => {
      expect(
        validateNarrativeRequest(validationRequest({ draftRef: " " })),
      ).toMatchObject({ code: "draft_ref_invalid" });
    });

    it("rejects an empty draft text", () => {
      expect(
        validateNarrativeRequest(validationRequest({ draftText: "" })),
      ).toMatchObject({ code: "draft_text_invalid" });
    });

    it("rejects an unknown validation policy version", () => {
      expect(
        validateNarrativeRequest(
          validationRequest({ validationPolicyVersion: "narrative-validation:v9" }),
        ),
      ).toMatchObject({ code: "policy_version_invalid" });
    });

    it("rejects support keys outside the frozen source manifest", () => {
      expect(
        validateNarrativeRequest(
          validationRequest({
            generatorManifest: [
              generatorStatement({
                propositionStatements: [
                  {
                    propositionKey: "proposition:1",
                    normalizedProposition: "x",
                    propositionKind: "fact",
                    epistemicRendering: "confirmed",
                    supportKeys: ["claim:missing"],
                  },
                ],
              }),
            ],
          }),
        ),
      ).toMatchObject({ code: "support_key_invalid" });
    });

    it("rejects duplicate source keys", () => {
      expect(
        validateNarrativeRequest(
          validationRequest({
            sourceEntries: [sourceEntry(), sourceEntry()],
          }),
        ),
      ).toMatchObject({ code: "source_manifest_invalid" });
    });

    it("rejects a planned coverage key outside the source manifest", () => {
      expect(
        validateNarrativeRequest(
          validationRequest({ plannedCoverageKeys: ["claim:ghost"] }),
        ),
      ).toMatchObject({ code: "source_manifest_invalid" });
    });

    it("rejects a proposition that declares no support", () => {
      expect(
        validateNarrativeRequest(
          validationRequest({
            generatorManifest: [
              generatorStatement({
                propositionStatements: [
                  {
                    propositionKey: "proposition:1",
                    normalizedProposition: "x",
                    propositionKind: "fact",
                    epistemicRendering: "confirmed",
                    supportKeys: [],
                  },
                ],
              }),
            ],
          }),
        ),
      ).toMatchObject({ code: "support_key_invalid" });
    });

    it("rejects an unknown proposition kind", () => {
      expect(
        validateNarrativeRequest(
          validationRequest({
            generatorManifest: [
              generatorStatement({
                propositionStatements: [
                  {
                    propositionKey: "proposition:1",
                    normalizedProposition: "x",
                    propositionKind: "vibes" as never,
                    epistemicRendering: "confirmed",
                    supportKeys: ["claim:1"],
                  },
                ],
              }),
            ],
          }),
        ),
      ).toMatchObject({ code: "generator_manifest_invalid" });
    });
  });

  describe("compareNarrativeManifests", () => {
    it("finds no mismatch when both sides agree", () => {
      const comparison = compareNarrativeManifests({
        generatorManifest: [generatorStatement()],
        sourceEntries: [sourceEntry()],
        plannedCoverageKeys: ["claim:1"],
        independentPropositions: [
          {
            propositionKey: "independent:1",
            text: "The user repairs radios.",
            propositionKind: "fact",
            epistemicRendering: "confirmed",
            supportKeys: ["claim:1"],
            unsupported: false,
            contradicted: false,
            ambiguous: false,
          },
        ],
        coverageKeys: ["claim:1"],
      });
      expect(comparison.manifestMismatches).toEqual([]);
      expect(comparison.coverage).toEqual({
        coveredKeys: ["claim:1"],
        uncoveredPlannedKeys: [],
      });
    });

    it("detects a generator under-report (漏报命题)", () => {
      const comparison = compareNarrativeManifests({
        generatorManifest: [generatorStatement()],
        sourceEntries: [sourceEntry()],
        plannedCoverageKeys: [],
        independentPropositions: [
          {
            propositionKey: "independent:1",
            text: "The user repairs radios.",
            propositionKind: "fact",
            epistemicRendering: "confirmed",
            supportKeys: ["claim:1"],
            unsupported: false,
            contradicted: false,
            ambiguous: false,
          },
          {
            propositionKey: "independent:2",
            text: "The user also owns a private observatory.",
            propositionKind: "fact",
            epistemicRendering: "confirmed",
            supportKeys: [],
            unsupported: true,
            contradicted: false,
            ambiguous: false,
          },
        ],
        coverageKeys: [],
      });
      expect(comparison.manifestMismatches).toEqual([
        {
          code: "generator_under_report",
          generatedPropositionKey: null,
          independentPropositionKey: "independent:2",
          detailCode: "independent_proposition_absent_from_manifest",
          supportKey: null,
        },
      ]);
    });

    it("detects a generator over-claim that the text does not carry", () => {
      const comparison = compareNarrativeManifests({
        generatorManifest: [
          generatorStatement({
            propositionStatements: [
              {
                propositionKey: "proposition:1",
                normalizedProposition: "The user repairs radios.",
                propositionKind: "fact",
                epistemicRendering: "confirmed",
                supportKeys: ["claim:1"],
              },
              {
                propositionKey: "proposition:2",
                normalizedProposition: "The user owns a private observatory.",
                propositionKind: "fact",
                epistemicRendering: "confirmed",
                supportKeys: ["claim:1"],
              },
            ],
          }),
        ],
        sourceEntries: [sourceEntry()],
        plannedCoverageKeys: [],
        independentPropositions: [
          {
            propositionKey: "independent:1",
            text: "The user repairs radios.",
            propositionKind: "fact",
            epistemicRendering: "confirmed",
            supportKeys: ["claim:1"],
            unsupported: false,
            contradicted: false,
            ambiguous: false,
          },
        ],
        coverageKeys: ["claim:1"],
      });
      expect(comparison.manifestMismatches).toEqual([
        {
          code: "generator_over_claim",
          generatedPropositionKey: "proposition:2",
          independentPropositionKey: null,
          detailCode: "declared_proposition_not_in_text",
          supportKey: null,
        },
      ]);
    });

    it("flags declared support links that the independent decomposition rejects", () => {
      const comparison = compareNarrativeManifests({
        generatorManifest: [
          generatorStatement({
            propositionStatements: [
              {
                propositionKey: "proposition:1",
                normalizedProposition: "The user repairs radios.",
                propositionKind: "fact",
                epistemicRendering: "confirmed",
                supportKeys: ["claim:1", "claim:padding"],
              },
            ],
          }),
        ],
        sourceEntries: [sourceEntry(), sourceEntry({ sourceKey: "claim:padding", text: "Padding text." })],
        plannedCoverageKeys: [],
        independentPropositions: [
          {
            propositionKey: "independent:1",
            text: "The user repairs radios.",
            propositionKind: "fact",
            epistemicRendering: "confirmed",
            supportKeys: ["claim:1"],
            unsupported: false,
            contradicted: false,
            ambiguous: false,
          },
        ],
        coverageKeys: ["claim:1"],
      });
      expect(comparison.manifestMismatches).toEqual([
        {
          code: "generator_support_mismatch",
          generatedPropositionKey: "proposition:1",
          independentPropositionKey: "independent:1",
          detailCode: "declared_link_not_in_independent_support",
          supportKey: "claim:padding",
        },
      ]);
    });

    it("detects a kind escalation between the declared and independent kind", () => {
      const comparison = compareNarrativeManifests({
        generatorManifest: [
          generatorStatement({
            propositionStatements: [
              {
                propositionKey: "proposition:1",
                normalizedProposition: "The user seems patient.",
                propositionKind: "impression",
                epistemicRendering: "inferred",
                supportKeys: ["claim:1"],
              },
            ],
          }),
        ],
        sourceEntries: [sourceEntry()],
        plannedCoverageKeys: [],
        independentPropositions: [
          {
            propositionKey: "independent:1",
            text: "The user seems patient.",
            propositionKind: "fact",
            epistemicRendering: "confirmed",
            supportKeys: ["claim:1"],
            unsupported: false,
            contradicted: false,
            ambiguous: false,
          },
        ],
        coverageKeys: ["claim:1"],
      });
      expect(comparison.manifestMismatches).toEqual([
        {
          code: "generator_kind_mismatch",
          generatedPropositionKey: "proposition:1",
          independentPropositionKey: "independent:1",
          detailCode: "declared_kind_escalates_independent_kind",
          supportKey: null,
        },
      ]);
    });

    it("reports planned coverage keys the draft never expressed", () => {
      const comparison = compareNarrativeManifests({
        generatorManifest: [],
        sourceEntries: [sourceEntry()],
        plannedCoverageKeys: ["claim:1"],
        independentPropositions: [],
        coverageKeys: [],
      });
      expect(comparison.coverage).toEqual({
        coveredKeys: [],
        uncoveredPlannedKeys: ["claim:1"],
      });
    });

    it("matches propositions across whitespace and case differences", () => {
      const comparison = compareNarrativeManifests({
        generatorManifest: [
          generatorStatement({
            propositionStatements: [
              {
                propositionKey: "proposition:1",
                normalizedProposition: "  the   user\nrepairs radios.  ",
                propositionKind: "fact",
                epistemicRendering: "confirmed",
                supportKeys: ["claim:1"],
              },
            ],
          }),
        ],
        sourceEntries: [sourceEntry()],
        plannedCoverageKeys: [],
        independentPropositions: [
          {
            propositionKey: "independent:1",
            text: "The user repairs radios.",
            propositionKind: "fact",
            epistemicRendering: "confirmed",
            supportKeys: ["claim:1"],
            unsupported: false,
            contradicted: false,
            ambiguous: false,
          },
        ],
        coverageKeys: [],
      });
      expect(comparison.manifestMismatches).toEqual([]);
    });
  });

  describe("evaluateNarrativeValidation + determineNarrativeVerdict", () => {
    it("blocks a Bio on every known class and keeps Reflection advisory", () => {
      const independent = [
        {
          propositionKey: "independent:1",
          text: "The user never repairs radios.",
          propositionKind: "fact" as const,
          epistemicRendering: "confirmed" as const,
          supportKeys: [],
          unsupported: true,
          contradicted: true,
          ambiguous: true,
        },
      ];
      const comparison = compareNarrativeManifests({
        generatorManifest: [],
        sourceEntries: [sourceEntry()],
        plannedCoverageKeys: ["claim:1"],
        independentPropositions: independent,
        coverageKeys: [],
      });
      const bio = evaluateNarrativeValidation({
        artifactKind: "bio",
        validationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
        schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
        promptVersion: NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO,
        comparison,
        independentPropositions: independent,
        sourceEntries: [sourceEntry()],
      });
      expect(bio.outcome).toBe("blocked");
      expect(bio.blockingFindings.map((finding) => finding.findingCode)).toEqual(
        expect.arrayContaining([
          "unsupported",
          "contradiction",
          "ambiguous",
          "manifest_mismatch",
          "material_absence",
        ]),
      );
      expect(bio.advisoryFindings).toEqual([]);

      const reflection = evaluateNarrativeValidation({
        artifactKind: "reflection",
        validationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
        schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
        promptVersion: "narrative-validate-reflection:v1",
        comparison,
        independentPropositions: independent,
        sourceEntries: [sourceEntry()],
      });
      expect(reflection.outcome).toBe("accepted");
      expect(reflection.blockingFindings).toEqual([]);
      expect(reflection.advisoryFindings.map((finding) => finding.findingCode)).toEqual(
        expect.arrayContaining([
          "unsupported",
          "contradiction",
          "ambiguous",
          "manifest_mismatch",
          "material_absence",
        ]),
      );
    });

    it("rejects an unknown policy version instead of guessing", () => {
      expect(() =>
        evaluateNarrativeValidation({
          artifactKind: "bio",
          validationPolicyVersion: "narrative-validation:v0",
          schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
          promptVersion: NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO,
          comparison: compareNarrativeManifests({
            generatorManifest: [],
            sourceEntries: [sourceEntry()],
            plannedCoverageKeys: [],
            independentPropositions: [],
            coverageKeys: [],
          }),
          independentPropositions: [],
          sourceEntries: [sourceEntry()],
        }),
      ).toThrow("Unknown narrative validation policy");
    });

    it("flags a confirmed fact carried by impression-only memory sources", () => {
      const impressionSource = sourceEntry({
        sourceKey: "claim:impression",
        epistemicKind: "ai_impression",
      });
      const independent = [
        {
          propositionKey: "independent:1",
          text: "The user is the most patient person in every room.",
          propositionKind: "fact" as const,
          epistemicRendering: "confirmed" as const,
          supportKeys: ["claim:impression"],
          unsupported: false,
          contradicted: false,
          ambiguous: false,
        },
      ];
      const result = evaluateNarrativeValidation({
        artifactKind: "bio",
        validationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
        schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
        promptVersion: NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO,
        comparison: compareNarrativeManifests({
          generatorManifest: [],
          sourceEntries: [impressionSource],
          plannedCoverageKeys: [],
          independentPropositions: independent,
          coverageKeys: ["claim:impression"],
        }),
        independentPropositions: independent,
        sourceEntries: [impressionSource],
      });
      expect(result.blockingFindings.map((f) => f.findingCode)).toContain(
        "kind_upgrade",
      );
    });

    it("exempts EvidenceItem sources from the epistemic source-kind check", () => {
      const evidenceSource = sourceEntry({
        sourceKey: "evidence:1",
        sourceKind: "evidence_item",
        epistemicKind: null,
      });
      const independent = [
        {
          propositionKey: "independent:1",
          text: "The user repairs radios.",
          propositionKind: "fact" as const,
          epistemicRendering: "confirmed" as const,
          supportKeys: ["evidence:1"],
          unsupported: false,
          contradicted: false,
          ambiguous: false,
        },
      ];
      const result = evaluateNarrativeValidation({
        artifactKind: "reflection",
        validationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
        schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
        promptVersion: "narrative-validate-reflection:v1",
        comparison: compareNarrativeManifests({
          generatorManifest: [],
          sourceEntries: [evidenceSource],
          plannedCoverageKeys: [],
          independentPropositions: independent,
          coverageKeys: ["evidence:1"],
        }),
        independentPropositions: independent,
        sourceEntries: [evidenceSource],
      });
      expect(
        result.advisoryFindings.map((f) => f.findingCode),
      ).not.toContain("kind_upgrade");
    });

    it("caps findings at the frozen budget", () => {
      const many = Array.from({ length: 40 }, (_, index) => ({
        propositionKey: `independent:${index}`,
        text: `Proposition ${index}.`,
        propositionKind: "fact" as const,
        epistemicRendering: "confirmed" as const,
        supportKeys: [],
        unsupported: true,
        contradicted: false,
        ambiguous: false,
      }));
      const comparison = compareNarrativeManifests({
        generatorManifest: [],
        sourceEntries: [sourceEntry()],
        plannedCoverageKeys: [],
        independentPropositions: many,
        coverageKeys: [],
      });
      const result = evaluateNarrativeValidation({
        artifactKind: "bio",
        validationPolicyVersion: NARRATIVE_VALIDATION_POLICY_VERSION,
        schemaVersion: NARRATIVE_FINDINGS_SCHEMA_VERSION,
        promptVersion: NARRATIVE_VALIDATOR_PROMPT_VERSION_BIO,
        comparison,
        independentPropositions: many,
        sourceEntries: [sourceEntry()],
      });
      // 40 unsupported findings + 40 under-report mismatches exceed the
      // frozen cap, so the cap binds exactly.
      expect(
        result.blockingFindings.length + result.advisoryFindings.length,
      ).toBe(MAX_NARRATIVE_FINDINGS_PER_RESULT);
    });
  });
});
