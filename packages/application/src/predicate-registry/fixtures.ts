import { PREDICATE_IDS } from "./v1";
import type { PredicateRegistrySnapshot } from "./types";

/**
 * Synthetic older-release overlay used by tests and the frozen-model replay:
 * a deprecated predecessor of sh.work.employer at a different registry_version,
 * proving version-addressed loading, fail-closed status checks, and DB version
 * isolation without touching published v1 content. Dev/test-only by intent.
 */
export function buildLegacyRegistryOverlay(
  registryVersion: number,
): PredicateRegistrySnapshot {
  return {
    registryVersion,
    entries: [
      {
        predicateId: "sh.work.company",
        registryVersion,
        definitionVersion: 1,
        status: "deprecated",
        allowedClaimKinds: ["objective"],
        sensitivityClass: "standard",
        allowedSubjectKindIds: ["sh.entity.person"],
        objectValueSchema: { kind: "text", normalization: "nfc_trim_collapsed" },
        scopeSchema: { kind: "none" },
        valueCardinality: "single",
        temporalSemantics: {
          temporalStatuses: ["current_ended"],
          boundaryPrecision: "preserved",
        },
        relationshipSemantics: null,
        evidencePolicyId: "evidence-policy.global-v1",
        reviewPolicyId: null,
        replacedByPredicateId: PREDICATE_IDS.employer,
      },
    ],
    localizations: [
      {
        predicateId: "sh.work.company",
        locale: "zh",
        label: "任职公司（旧版）",
        definition: "旧版本条目，仅用于版本隔离与 fail-closed 验证。",
        positiveExamples: ["我在X公司上班。"],
        negativeExamples: ["我不在Y公司上班。"],
        localizationVersion: 1,
        lexicalSurfaces: [],
      },
    ],
    relationshipProjections: [],
    relations: [],
  };
}
