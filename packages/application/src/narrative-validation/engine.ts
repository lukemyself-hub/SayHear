import type {
  NarrativeArtifactKind,
  NarrativeFinding,
  NarrativeFindingCode,
  NarrativeGeneratorProposition,
  NarrativeGeneratorStatement,
  NarrativeIndependentProposition,
  NarrativeSourceEntry,
  NarrativeValidationCoverage,
  NarrativeValidationRequest,
  NarrativeValidationRejection,
  NarrativeValidationResult,
  NarrativeVerdict,
} from "./types";
import {
  MAX_NARRATIVE_FINDINGS_PER_RESULT,
  NARRATIVE_VALIDATION_POLICY_VERSION,
} from "./types";

/**
 * Deterministic narrative-validation engine (issue #198, ADR-0124). The model
 * supplies an independent decomposition of the final text; every comparison
 * against the generator manifest, every verdict split, and the per-artifact
 * blocking policy stay in this pure, replayable code. No similarity scores:
 * propositions match on normalized text identity, and any material mismatch
 * is itself a finding.
 */

export function normalizeNarrativePropositionText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

type ManifestMismatch = Readonly<{
  code:
    | "generator_over_claim"
    | "generator_under_report"
    | "generator_support_mismatch"
    | "generator_kind_mismatch";
  generatedPropositionKey: string | null;
  independentPropositionKey: string | null;
  detailCode: string;
  supportKey: string | null;
}>;

export type NarrativeComparison = Readonly<{
  manifestMismatches: readonly ManifestMismatch[];
  coverage: NarrativeValidationCoverage;
}>;

const PROPOSITION_KINDS: readonly string[] = [
  "fact",
  "impression",
  "synthesis",
];
const EPISTEMIC_RENDERINGS: readonly string[] = ["confirmed", "inferred"];

function isPropositionKind(value: string): boolean {
  return PROPOSITION_KINDS.includes(value);
}

function isEpistemicRendering(value: string): boolean {
  return EPISTEMIC_RENDERINGS.includes(value);
}

/**
 * An impression rendered as confirmed, or an impression-level proposition
 * declared as a fact, escalates the epistemic kind (ADR-0124 kind_upgrade).
 * A synthesis claimed as fact is also an escalation; a confirmed rendering
 * claimed as inferred is a de-escalation and stays a manifest mismatch.
 */
function epistemicEscalates(
  generated: NarrativeGeneratorProposition,
  independent: NarrativeIndependentProposition,
): boolean {
  if (
    generated.epistemicRendering === "inferred" &&
    independent.epistemicRendering === "confirmed"
  ) {
    return true;
  }
  if (
    generated.propositionKind !== "fact" &&
    independent.propositionKind === "fact"
  ) {
    return true;
  }
  return false;
}

export function compareNarrativeManifests(input: Readonly<{
  generatorManifest: readonly NarrativeGeneratorStatement[];
  sourceEntries: readonly NarrativeSourceEntry[];
  plannedCoverageKeys: readonly string[];
  independentPropositions: readonly NarrativeIndependentProposition[];
  coverageKeys: readonly string[];
}>): NarrativeComparison {
  const sourceKeys = new Set(input.sourceEntries.map((entry) => entry.sourceKey));
  const generated: NarrativeGeneratorProposition[] = [];
  for (const statement of input.generatorManifest) {
    generated.push(...statement.propositionStatements);
  }
  const independentByText = new Map<string, NarrativeIndependentProposition>();
  for (const proposition of input.independentPropositions) {
    const normalized = normalizeNarrativePropositionText(proposition.text);
    if (normalized.length > 0 && !independentByText.has(normalized)) {
      independentByText.set(normalized, proposition);
    }
  }
  const coverageKeys = new Set(input.coverageKeys);

  const mismatches: ManifestMismatch[] = [];
  const matchedIndependent = new Set<string>();

  for (const generatedProposition of generated) {
    const normalized = normalizeNarrativePropositionText(
      generatedPropositionNormalizedText(generatedProposition),
    );
    const independent = independentByText.get(normalized);
    if (!independent) {
      // The generator declared a proposition the independent decomposition
      // could not recover from the final text.
      mismatches.push({
        code: "generator_over_claim",
        generatedPropositionKey: generatedProposition.propositionKey,
        independentPropositionKey: null,
        detailCode: "declared_proposition_not_in_text",
        supportKey: null,
      });
      continue;
    }
    matchedIndependent.add(independent.propositionKey);
    for (const supportKey of generatedProposition.supportKeys) {
      if (!sourceKeys.has(supportKey)) {
        mismatches.push({
          code: "generator_support_mismatch",
          generatedPropositionKey: generatedProposition.propositionKey,
          independentPropositionKey: independent.propositionKey,
          detailCode: "support_key_outside_frozen_source",
          supportKey,
        });
        continue;
      }
      if (!independent.supportKeys.includes(supportKey)) {
        // Every declared link must materially contribute to the
        // independently recovered support set (ADR-0124 padding ban).
        mismatches.push({
          code: "generator_support_mismatch",
          generatedPropositionKey: generatedProposition.propositionKey,
          independentPropositionKey: independent.propositionKey,
          detailCode: "declared_link_not_in_independent_support",
          supportKey,
        });
      }
    }
    if (epistemicEscalates(generatedProposition, independent)) {
      mismatches.push({
        code: "generator_kind_mismatch",
        generatedPropositionKey: generatedProposition.propositionKey,
        independentPropositionKey: independent.propositionKey,
        detailCode: "declared_kind_escalates_independent_kind",
        supportKey: null,
      });
    }
  }

  for (const independent of input.independentPropositions) {
    if (matchedIndependent.has(independent.propositionKey)) {
      continue;
    }
    // The independent decomposition recovered a proposition the generator
    // never declared: generator under-report (漏报命题).
    mismatches.push({
      code: "generator_under_report",
      generatedPropositionKey: null,
      independentPropositionKey: independent.propositionKey,
      detailCode: "independent_proposition_absent_from_manifest",
      supportKey: null,
    });
  }

  const uncoveredPlannedKeys = input.plannedCoverageKeys.filter(
    (plannedKey) => !coverageKeys.has(plannedKey),
  );

  return {
    manifestMismatches: mismatches,
    coverage: {
      coveredKeys: [...coverageKeys].sort(),
      uncoveredPlannedKeys: [...uncoveredPlannedKeys].sort(),
    },
  };
}

function generatedPropositionNormalizedText(
  proposition: NarrativeGeneratorProposition,
): string {
  return normalizeNarrativePropositionText(proposition.normalizedProposition);
}

/**
 * The frozen v1 verdict policy. Bio blocks on every known class; Reflection
 * records all semantic findings as advisory until a new policy version
 * carries accepted per-class calibration evidence (ADR-0121 / ADR-0137).
 * An unknown policy version fails closed.
 */
const V1_BLOCKING_CLASSES: Readonly<
  Record<NarrativeArtifactKind, readonly NarrativeFindingCode[]>
> = Object.freeze({
  bio: [
    "unsupported",
    "contradiction",
    "kind_upgrade",
    "material_absence",
    "manifest_mismatch",
    "ambiguous",
  ],
  reflection: [],
});

/**
 * Validates the frozen request shape. Any rejection is deterministic and
 * terminal: producers must fix the request, never retry it.
 */
export function validateNarrativeRequest(
  request: NarrativeValidationRequest,
): NarrativeValidationRejection | null {
  if (request.draftRef.trim() === "" || request.draftRef.length > 512) {
    return {
      code: "draft_ref_invalid",
      detail: "draftRef must be a non-empty opaque locator of at most 512 chars.",
    };
  }
  if (request.draftText.trim() === "" || request.draftText.length > 32_000) {
    return {
      code: "draft_text_invalid",
      detail: "draftText must be non-empty and within the frozen text budget.",
    };
  }
  if (
    request.validationPolicyVersion !== NARRATIVE_VALIDATION_POLICY_VERSION ||
    request.schemaVersion.trim() === "" ||
    request.promptVersion.trim() === ""
  ) {
    return {
      code: "policy_version_invalid",
      detail:
        "validationPolicyVersion must be the frozen v1 policy and schema/prompt versions must be non-empty.",
    };
  }
  const sourceKeys = new Set<string>();
  for (const entry of request.sourceEntries) {
    if (entry.sourceKey.trim() === "" || entry.text.trim() === "") {
      return {
        code: "source_manifest_invalid",
        detail: "Every source entry needs a non-empty key and text.",
      };
    }
    if (sourceKeys.has(entry.sourceKey)) {
      return {
        code: "source_manifest_invalid",
        detail: `Duplicate source key ${entry.sourceKey}.`,
      };
    }
    sourceKeys.add(entry.sourceKey);
  }
  const statements: readonly NarrativeGeneratorStatement[] = request.generatorManifest;
  for (const statement of statements) {
    if (statement.statementKey.trim() === "" || statement.text.trim() === "") {
      return {
        code: "generator_manifest_invalid",
        detail: "Every generator statement needs a non-empty key and text.",
      };
    }
    for (const proposition of statement.propositionStatements) {
      if (proposition.propositionKey.trim() === "") {
        return {
          code: "generator_manifest_invalid",
          detail: "Every generator proposition needs a key.",
        };
      }
      if (!isPropositionKind(proposition.propositionKind)) {
        return {
          code: "generator_manifest_invalid",
          detail: `Unknown proposition kind ${proposition.propositionKind}.`,
        };
      }
      if (!isEpistemicRendering(proposition.epistemicRendering)) {
        return {
          code: "generator_manifest_invalid",
          detail: `Unknown epistemic rendering ${proposition.epistemicRendering}.`,
        };
      }
      if (proposition.supportKeys.length === 0) {
        return {
          code: "support_key_invalid",
          detail: `Proposition ${proposition.propositionKey} declares no support.`,
        };
      }
      for (const supportKey of proposition.supportKeys) {
        if (!sourceKeys.has(supportKey)) {
          return {
            code: "support_key_invalid",
            detail: `Proposition ${proposition.propositionKey} cites ${supportKey} outside the frozen source manifest.`,
          };
        }
      }
    }
  }
  for (const plannedKey of request.plannedCoverageKeys) {
    if (!sourceKeys.has(plannedKey)) {
      return {
        code: "source_manifest_invalid",
        detail: `Planned coverage key ${plannedKey} is outside the frozen source manifest.`,
      };
    }
  }
  return null;
}

/**
 * Combines the model's semantic verdicts with the deterministic comparison
 * into the typed finding set (severity error = blocking candidate, warning =
 * advisory), applies the per-artifact policy, and returns the full result.
 */
export function evaluateNarrativeValidation(input: Readonly<{
  artifactKind: NarrativeArtifactKind;
  validationPolicyVersion: string;
  schemaVersion: string;
  promptVersion: string;
  comparison: NarrativeComparison;
  independentPropositions: readonly NarrativeIndependentProposition[];
  sourceEntries: readonly NarrativeSourceEntry[];
}>): NarrativeValidationResult {
  if (input.validationPolicyVersion !== NARRATIVE_VALIDATION_POLICY_VERSION) {
    throw new Error(
      `Unknown narrative validation policy ${input.validationPolicyVersion}.`,
    );
  }
  const findings: NarrativeFinding[] = [];
  const epistemicKindBySourceKey = new Map(
    input.sourceEntries.map((entry) => [entry.sourceKey, entry.epistemicKind]),
  );
  for (const mismatch of input.comparison.manifestMismatches) {
    const findingCode: NarrativeFindingCode =
      mismatch.code === "generator_kind_mismatch"
        ? "kind_upgrade"
        : "manifest_mismatch";
    findings.push({
      findingCode,
      severity: "error",
      propositionKey: mismatch.generatedPropositionKey,
      supportKey: mismatch.supportKey,
      detailCode: mismatch.detailCode,
      detailText: null,
    });
  }
  for (const proposition of input.independentPropositions) {
    if (proposition.unsupported) {
      findings.push({
        findingCode: "unsupported",
        severity: "error",
        propositionKey: proposition.propositionKey,
        supportKey: null,
        detailCode: "independent_proposition_unsupported",
        detailText: null,
      });
    }
    if (proposition.contradicted) {
      findings.push({
        findingCode: "contradiction",
        severity: "error",
        propositionKey: proposition.propositionKey,
        supportKey: null,
        detailCode: "independent_proposition_contradicts_source",
        detailText: null,
      });
    }
    if (proposition.ambiguous) {
      findings.push({
        findingCode: "ambiguous",
        severity: "error",
        propositionKey: proposition.propositionKey,
        supportKey: null,
        detailCode: "independent_proposition_ambiguous",
        detailText: null,
      });
    }
    // Source-epistemic escalation (SPEC 9.3 / ADR-0124): a confirmed fact
    // needs active Objective Memory support; a proposition rendered as a
    // confirmed fact over impression-only memory sources upgrades the
    // epistemic kind. EvidenceItem sources are exempt — Evidence is the
    // Reflection epistemic support (SPEC 5.1).
    if (
      (proposition.propositionKind === "fact" ||
        proposition.epistemicRendering === "confirmed") &&
      proposition.supportKeys.length > 0
    ) {
      const supportKinds = proposition.supportKeys
        .map((key) => epistemicKindBySourceKey.get(key))
        .filter((kind): kind is "objective_memory" | "ai_impression" => kind !== null);
      if (
        supportKinds.length > 0 &&
        !supportKinds.includes("objective_memory") &&
        supportKinds.includes("ai_impression")
      ) {
        findings.push({
          findingCode: "kind_upgrade",
          severity: "error",
          propositionKey: proposition.propositionKey,
          supportKey: null,
          detailCode: "impression_source_escalated_to_confirmed_fact",
          detailText: null,
        });
      }
    }
  }
  for (const plannedKey of input.comparison.coverage.uncoveredPlannedKeys) {
    findings.push({
      findingCode: "material_absence",
      severity: "error",
      propositionKey: null,
      supportKey: null,
      detailCode: `planned_coverage_unexpressed:${plannedKey}`,
      detailText: null,
    });
  }

  const capped = findings.slice(0, MAX_NARRATIVE_FINDINGS_PER_RESULT);
  const blockingClasses = V1_BLOCKING_CLASSES[input.artifactKind];
  const blockingFindings = capped.filter(
    (finding) =>
      finding.severity === "error" &&
      blockingClasses.includes(finding.findingCode),
  );
  const advisoryFindings = capped.filter(
    (finding) =>
      finding.severity === "warning" ||
      !blockingClasses.includes(finding.findingCode),
  );
  const outcome: NarrativeVerdict =
    blockingFindings.length > 0 ? "blocked" : "accepted";

  return {
    outcome,
    artifactKind: input.artifactKind,
    blockingFindings,
    advisoryFindings,
    coverage: input.comparison.coverage,
    validationPolicyVersion: input.validationPolicyVersion,
    schemaVersion: input.schemaVersion,
    promptVersion: input.promptVersion,
  };
}
