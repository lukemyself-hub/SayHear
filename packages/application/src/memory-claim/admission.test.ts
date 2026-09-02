import { describe, expect, it } from "vitest";

import {
  asMemoryCandidateId,
  asMemoryClaimId,
  asMemoryClaimVersionId,
  asMemoryClaimVersionQualifierId,
  asUserId,
} from "@sayhear/domain";

import {
  PREDICATE_IDS,
  loadPredicateRegistrySnapshot,
} from "../predicate-registry";
import {
  addDays,
  admittedClaimIdentityFor,
  canonicalValueSet,
  claimCanonicalKey,
  dedupeFingerprint,
  evaluateMaterialChange,
  candidateSemanticTarget,
  parseClaimCanonicalKey,
  planClaimAdmission,
  planImpressionDormancy,
  planRejectionDisposition,
  planStaleDisposition,
  predicateReviewDeadline,
  registryReleaseDeadline,
} from "./admission";
import {
  IMPRESSION_REVIEW_CYCLE_DAYS,
  NEEDS_PREDICATE_REVIEW_DEADLINE_DAYS,
  REGISTRY_RELEASE_WAIT_DAYS,
  TERMINAL_CONTENT_EXPIRY_DAYS,
  type AdmissibleEvidence,
  type ClaimAdmissionPlan,
  type ClaimVersionQualifierRecord,
  type MemoryCandidateRecord,
  type MemoryClaimVersionRecord,
  type RegistryEntryLookup,
} from "./types";

const registry = loadPredicateRegistrySnapshot(1);

const entryLookup: RegistryEntryLookup = {
  entryFor(predicateId: string) {
    return registry.entries.find((entry) => entry.predicateId === predicateId) ?? null;
  },
  registryVersion: () => registry.registryVersion,
};

const RESIDENCE = PREDICATE_IDS.residence;
const PARTNER = PREDICATE_IDS.partnerOf;
const EMPLOYER = PREDICATE_IDS.employer;
const CORE_PRIORITIES = PREDICATE_IDS.corePriorities;

const NOW = new Date("2026-08-27T08:00:00.000Z");
const USER = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");
const CURRENT_VERSION_ID = asMemoryClaimVersionId("01984477-31e1-7595-92c6-0688a0d00001");
const CURRENT_CLAIM_ID = asMemoryClaimId("01984477-31e1-7595-92c6-0688a0d00002");
const SELF = "01984477-31e1-7595-92c6-0688a0a00001";
const MOM = "01984477-31e1-7595-92c6-0688a0a00002";
const SELF_VERSION = "01984477-31e1-7595-92c6-0688a0b00001";
const MOM_VERSION = "01984477-31e1-7595-92c6-0688a0b00002";
const SESSION_1 = "01984477-31e1-7595-92c6-0688a0c00001";
const SESSION_2 = "01984477-31e1-7595-92c6-0688a0c00002";

const SELF_BINDING = Object.freeze({
  [SELF]: { entityVersionId: SELF_VERSION, status: "active", entityKindId: "sh.entity.person" },
});

function residenceProposal(overrides: Partial<Parameters<typeof baseProposal>[0]> = {}) {
  return baseProposal({
    predicateId: RESIDENCE,
    typedValue: "上海",
    ...overrides,
  });
}

function baseProposal(input: {
  predicateId: string;
  typedValue: string | readonly string[];
  candidateKind?: "objective" | "impression";
  basis?: "directly_stated" | "inferred";
  subjectEntityId?: string | null;
  objectEntityId?: string | null;
  objectEntityMentionId?: string | null;
  scopeKey?: string;
  evidenceItemIds?: readonly string[];
  qualifiers?: Parameters<typeof planClaimAdmission>[0]["proposal"]["qualifiers"];
  temporal?: Parameters<typeof planClaimAdmission>[0]["proposal"]["temporal"];
}): Parameters<typeof planClaimAdmission>[0]["proposal"] {
  return {
    userId: USER,
    candidateKind: input.candidateKind ?? "objective",
    basis: input.basis ?? "directly_stated",
    resolution: {
      status: "mapped",
      predicateId: input.predicateId,
      registryVersion: 1,
      typedValue: input.typedValue,
      mappingConfidence: 0.95,
    },
    subjectEntityId: input.subjectEntityId ?? SELF,
    subjectEntityMentionId: null,
    objectEntityId: input.objectEntityId ?? null,
    objectEntityMentionId: input.objectEntityMentionId ?? null,
    scopeKey: input.scopeKey ?? "",
    temporal: input.temporal ?? {
      temporalStatus: "current",
      validFrom: null,
      validFromPrecision: "unknown",
      validTo: null,
      validToPrecision: "unknown",
    },
    evidenceItemIds: input.evidenceItemIds ?? ["e1", "e2"],
    qualifiers: input.qualifiers ?? [],
    lineage: {
      extractionPolicyVersion: "extraction-test",
      generationCommandId: null,
      authoritativeModelAttemptId: null,
      modelVersion: null,
      promptVersion: null,
      sourceReflectionVersionId: null,
    },
  };
}

function evidence(input: {
  id: string;
  session: string;
  revision: string;
}): AdmissibleEvidence {
  return {
    evidenceItemId: input.id,
    dailySessionId: input.session as AdmissibleEvidence["dailySessionId"],
    sourceRevisionId: input.revision,
    sourceActor: "user",
    sourceStatus: "final",
    status: "active",
  };
}

const CROSS_SESSION_EVIDENCE = [
  evidence({ id: "e1", session: SESSION_1, revision: "rev-1" }),
  evidence({ id: "e2", session: SESSION_2, revision: "rev-2" }),
];

function currentVersion(overrides: Partial<MemoryClaimVersionRecord> = {}): MemoryClaimVersionRecord {
  return {
    memoryClaimVersionId: CURRENT_VERSION_ID,
    memoryClaimId: CURRENT_CLAIM_ID,
    revision: 1,
    kind: "objective",
    epistemicStatus: "confirmed",
    status: "active",
    subjectEntityVersionId: SELF_VERSION,
    objectEntityVersionId: null,
    typedValue: "北京",
    confidence: null,
    temporal: {
      temporalStatus: "current",
      validFrom: null,
      validFromPrecision: "unknown",
      validTo: null,
      validToPrecision: "unknown",
    },
    lastObservedAt: NOW,
    supersedesVersionId: null,
    createdBy: "consolidation",
    modelVersion: null,
    promptVersion: null,
    predicateRegistryVersion: 1,
    createdAt: NOW,
    ...overrides,
  };
}

function expectPromote(
  plan: ClaimAdmissionPlan,
): Extract<ClaimAdmissionPlan, { action: "promote" }> {
  if (plan.action !== "promote") {
    throw new Error(`expected promote, got ${plan.action}`);
  }
  return plan;
}

describe("claimCanonicalKey", () => {
  it("builds a language-independent identity from pair + predicate + scope", () => {
    const key = claimCanonicalKey({
      predicateId: RESIDENCE,
      subjectEntityId: SELF,
      objectEntityId: null,
      scopeKey: "",
      relationshipDirection: null,
    });
    expect(key).toBe(`v1|${RESIDENCE}|${SELF}>|`);
  });

  it("normalizes symmetric relationship pairs by stable Entity ID order", () => {
    const a = claimCanonicalKey({
      predicateId: PREDICATE_IDS.roommateOf,
      subjectEntityId: SELF,
      objectEntityId: MOM,
      scopeKey: "",
      relationshipDirection: "symmetric",
    });
    const b = claimCanonicalKey({
      predicateId: PREDICATE_IDS.roommateOf,
      subjectEntityId: MOM,
      objectEntityId: SELF,
      scopeKey: "",
      relationshipDirection: "symmetric",
    });
    expect(a).toBe(b);
  });

  it("keeps directed relationships canonical regardless of mention direction", () => {
    const motherToChild = claimCanonicalKey({
      predicateId: PARTNER,
      subjectEntityId: SELF,
      objectEntityId: MOM,
      scopeKey: "",
      relationshipDirection: "directed",
    });
    const childToMother = claimCanonicalKey({
      predicateId: PARTNER,
      subjectEntityId: MOM,
      objectEntityId: SELF,
      scopeKey: "",
      relationshipDirection: "directed",
    });
    expect(motherToChild).not.toBe(childToMother);
  });
});

describe("parseClaimCanonicalKey", () => {
  it("inverts the producer for a directed non-relationship key", () => {
    const key = claimCanonicalKey({
      predicateId: RESIDENCE,
      subjectEntityId: SELF,
      objectEntityId: null,
      scopeKey: "",
      relationshipDirection: null,
    });
    expect(parseClaimCanonicalKey(key)).toEqual({
      version: "v1",
      predicateId: RESIDENCE,
      relationshipDirection: "directed",
      subjectEntityId: SELF,
      objectEntityId: null,
      scopeKey: "",
    });
  });

  it("inverts the producer for a directed key with a bound object and scope", () => {
    const key = claimCanonicalKey({
      predicateId: EMPLOYER,
      subjectEntityId: SELF,
      objectEntityId: MOM,
      scopeKey: "career",
      relationshipDirection: null,
    });
    expect(parseClaimCanonicalKey(key)).toEqual({
      version: "v1",
      predicateId: EMPLOYER,
      relationshipDirection: "directed",
      subjectEntityId: SELF,
      objectEntityId: MOM,
      scopeKey: "career",
    });
  });

  it("inverts the producer for a symmetric normalized pair", () => {
    const key = claimCanonicalKey({
      predicateId: PREDICATE_IDS.roommateOf,
      subjectEntityId: SELF,
      objectEntityId: MOM,
      scopeKey: "",
      relationshipDirection: "symmetric",
    });
    const [first, second] = [SELF, MOM].sort();
    expect(parseClaimCanonicalKey(key)).toEqual({
      version: "v1",
      predicateId: PREDICATE_IDS.roommateOf,
      relationshipDirection: "symmetric",
      subjectEntityId: first,
      objectEntityId: second,
      scopeKey: "",
    });
  });

  it("fails closed on a non-v1 key version", () => {
    expect(parseClaimCanonicalKey(`v2|${RESIDENCE}|${SELF}>|`)).toBeNull();
  });

  it("fails closed on malformed keys", () => {
    expect(parseClaimCanonicalKey("v1|only|three")).toBeNull();
    expect(parseClaimCanonicalKey(`v1|${RESIDENCE}|five|parts|`)).toBeNull();
    expect(parseClaimCanonicalKey(`v1|${RESIDENCE}|no-separator|`)).toBeNull();
    // A symmetric pair not in the producer's sorted order is not a v1 key.
    const [first, second] = [SELF, MOM].sort();
    expect(
      parseClaimCanonicalKey(
        `v1|${PREDICATE_IDS.roommateOf}|${second}+${first}|`,
      ),
    ).toBeNull();
  });
});

describe("objective admission (ADR-0038)", () => {
  it("admits one direct explicit statement as objective + confirmed with zero repetition", () => {
    const plan = planClaimAdmission({
      proposal: residenceProposal({ typedValue: "上海" }),
      registryEntry: entryLookup.entryFor(RESIDENCE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: null,
      currentVersion: null,
      evidence: [evidence({ id: "e1", session: SESSION_1, revision: "rev-1" })],
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote).toMatchObject({
      epistemicStatus: "confirmed",
      kind: "objective",
      versionStatus: "active",
      claimAction: "create_claim",
      conflictResolution: "initial_admission",
      typedValue: "上海",
    });
  });

  it("reinforces an active same-value claim without demoting or duplicating it", () => {
    const plan = planClaimAdmission({
      proposal: residenceProposal({ typedValue: "北京" }),
      registryEntry: entryLookup.entryFor(RESIDENCE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: currentVersion({ typedValue: "北京" }),
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({
      action: "reinforce_current",
      linkRole: "support",
    });
  });

  it("rejects model inference routed as objective (no inference ever becomes Objective Memory)", () => {
    const plan = planClaimAdmission({
      proposal: residenceProposal({ basis: "inferred", candidateKind: "objective" }),
      registryEntry: entryLookup.entryFor(RESIDENCE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: null,
      currentVersion: null,
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    expect(plan).toEqual({ action: "reject", reasonCode: "kind_basis_mismatch" });
  });

  it("rejects a subject that is not the Self Entity for self-scoped predicates", () => {
    const plan = planClaimAdmission({
      proposal: residenceProposal({ subjectEntityId: MOM }),
      registryEntry: entryLookup.entryFor(RESIDENCE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: null,
      currentVersion: null,
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    expect(plan).toEqual({ action: "reject", reasonCode: "subject_not_self_entity" });
  });

  it("rejects evidence-less and registry-violating proposals", () => {
    const noEvidence = planClaimAdmission({
      proposal: residenceProposal({ evidenceItemIds: [] }),
      registryEntry: entryLookup.entryFor(RESIDENCE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: null,
      currentVersion: null,
      evidence: [],
      excludedEvidenceIds: [],
    });
    expect(noEvidence).toEqual({ action: "reject", reasonCode: "evidence_missing" });

    const wrongKind = planClaimAdmission({
      proposal: baseProposal({
        predicateId: PREDICATE_IDS.considerationStyle,
        typedValue: "direct",
        candidateKind: "objective",
        basis: "directly_stated",
      }),
      registryEntry: entryLookup.entryFor(PREDICATE_IDS.considerationStyle),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: null,
      currentVersion: null,
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    expect(wrongKind).toEqual({
      action: "reject",
      reasonCode: "claim_kind_not_allowed_by_registry",
    });
  });

  it("rejects Assistant-System-shaped evidence and inactive evidence (AC 5 defense in depth)", () => {
    const ineligible: AdmissibleEvidence = {
      ...evidence({ id: "e1", session: SESSION_1, revision: "rev-1" }),
      sourceActor: "assistant" as never,
    };
    const plan = planClaimAdmission({
      proposal: residenceProposal(),
      registryEntry: entryLookup.entryFor(RESIDENCE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: null,
      currentVersion: null,
      evidence: [ineligible],
      excludedEvidenceIds: [],
    });
    expect(plan).toEqual({ action: "reject", reasonCode: "evidence_ineligible" });
  });
});

describe("impression admission (ADR-0039)", () => {
  const styleProposal = () =>
    baseProposal({
      predicateId: PREDICATE_IDS.statedStyle,
      typedValue: "positive",
      candidateKind: "impression",
      basis: "inferred",
    });
  const STYLE = PREDICATE_IDS.statedStyle;

  it("promotes only when ≥2 independent evidence items span ≥2 Daily Sessions", () => {
    const plan = planClaimAdmission({
      proposal: styleProposal(),
      registryEntry: entryLookup.entryFor(STYLE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: null,
      currentVersion: null,
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote).toMatchObject({
      kind: "impression",
      epistemicStatus: "inferred",
      conflictResolution: "initial_admission",
    });
  });

  it("keeps single-Session proposals below the floor no matter how many items", () => {
    const plan = planClaimAdmission({
      proposal: styleProposal(),
      registryEntry: entryLookup.entryFor(STYLE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: null,
      currentVersion: null,
      evidence: [
        evidence({ id: "e1", session: SESSION_1, revision: "rev-1" }),
        evidence({ id: "e2", session: SESSION_1, revision: "rev-2" }),
        evidence({ id: "e3", session: SESSION_1, revision: "rev-3" }),
      ],
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({
      action: "below_impression_floor",
      floor: { minEvidenceItems: 2, minDailySessions: 2 },
      actual: { evidenceItems: 3, dailySessions: 1 },
    });
  });

  it("does not let multiple locators of one revision count as independent evidence", () => {
    const plan = planClaimAdmission({
      proposal: styleProposal(),
      registryEntry: entryLookup.entryFor(STYLE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: null,
      currentVersion: null,
      evidence: [
        evidence({ id: "e1", session: SESSION_1, revision: "rev-1" }),
        evidence({ id: "e2", session: SESSION_2, revision: "rev-1" }),
      ],
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({
      action: "below_impression_floor",
      actual: { evidenceItems: 1, dailySessions: 2 },
    });
  });
});

describe("conflict routing (ADR-0040)", () => {
  it("supersedes with a new confirmed version when the user directly states a new value", () => {
    const plan = planClaimAdmission({
      proposal: residenceProposal({ typedValue: "上海" }),
      registryEntry: entryLookup.entryFor(RESIDENCE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: currentVersion({ typedValue: "北京" }),
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote).toMatchObject({
      conflictResolution: "temporal_or_correction_supersede",
      claimAction: "new_version",
      epistemicStatus: "confirmed",
      supersedesVersionId: CURRENT_VERSION_ID,
    });
  });

  it("routes unresolved inferred mutual exclusion to contested + review_due", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: PREDICATE_IDS.considerationStyle,
        typedValue: "positive",
        candidateKind: "impression",
        basis: "inferred",
      }),
      registryEntry: entryLookup.entryFor(PREDICATE_IDS.considerationStyle),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: currentVersion({
        kind: "impression",
        epistemicStatus: "inferred",
        typedValue: "negative",
      }),
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({
      action: "contested",
      epistemicStatus: "contested",
      versionStatus: "review_due",
      supersedesVersionId: CURRENT_VERSION_ID,
    });
  });

  it("never lets inference auto-contest a confirmed user statement (pending instead)", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: PREDICATE_IDS.considerationStyle,
        typedValue: "negative",
        candidateKind: "impression",
        basis: "inferred",
      }),
      registryEntry: entryLookup.entryFor(PREDICATE_IDS.considerationStyle),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: currentVersion({ typedValue: "positive" }),
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({
      action: "pending_conflict",
      reasonCodes: ["inference_conflicts_with_confirmed_statement"],
    });
  });

  it("resolves a contested claim when the user directly states a value", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: PREDICATE_IDS.statedStyle,
        typedValue: "positive",
        candidateKind: "objective",
        basis: "directly_stated",
      }),
      registryEntry: entryLookup.entryFor(PREDICATE_IDS.statedStyle),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: currentVersion({
        kind: "impression",
        epistemicStatus: "contested",
        status: "review_due",
        typedValue: "negative",
      }),
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote).toMatchObject({
      conflictResolution: "contested_resolved",
      epistemicStatus: "confirmed",
      versionStatus: "active",
    });
  });

  it("keeps registry-permitted coexisting values out of contested: merging into a confirmed objective set waits for the user", () => {
    // Simulates a future dual-kind multiple-cardinality entry (no v1 entry
    // admits both kinds with multiple values); the routing must still refuse
    // to mix inferred values into a confirmed set.
    const dualKindMultipleEntry = {
      ...entryLookup.entryFor(CORE_PRIORITIES)!,
      allowedClaimKinds: ["objective", "impression"] as const,
    };
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: CORE_PRIORITIES,
        typedValue: ["家庭"],
        candidateKind: "impression",
        basis: "inferred",
      }),
      registryEntry: dualKindMultipleEntry,
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: currentVersion({
        kind: "objective",
        epistemicStatus: "confirmed",
        typedValue: ["事业"],
      }),
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({
      action: "pending_conflict",
      reasonCodes: ["coexist_value_awaits_direct_statement"],
    });
  });

  it("grows an impression claim's coexisting value set when a floor-meeting inferred candidate arrives", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: CORE_PRIORITIES,
        typedValue: ["家庭"],
        candidateKind: "impression",
        basis: "inferred",
      }),
      registryEntry: entryLookup.entryFor(CORE_PRIORITIES),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: currentVersion({
        kind: "impression",
        epistemicStatus: "inferred",
        typedValue: ["事业"],
      }),
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote).toMatchObject({
      conflictResolution: "value_coexist",
      epistemicStatus: "inferred",
      versionStatus: "active",
    });
    expect(canonicalValueSet(promote.typedValue as readonly string[])).toEqual([
      "事业",
      "家庭",
    ]);
  });

  it("merges coexisting values when the user directly states an additional one", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: PREDICATE_IDS.workplace,
        typedValue: ["公司B", "公司C"],
        candidateKind: "objective",
        basis: "directly_stated",
      }),
      registryEntry: entryLookup.entryFor(PREDICATE_IDS.workplace),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: currentVersion({
        kind: "objective",
        epistemicStatus: "confirmed",
        typedValue: ["公司A"],
      }),
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote.conflictResolution).toBe("temporal_or_correction_supersede");
    expect(canonicalValueSet(promote.typedValue as readonly string[])).toEqual([
      "公司A",
      "公司B",
      "公司C",
    ]);
  });

  it("admits a provider-scalar value as a singleton set on multiple-cardinality entries (#126 defect 16)", () => {
    // Both provider protocols carry one scalar value per candidate ("one
    // project, one independently valid value"); without the admission-side
    // wrap every such candidate died at the array check as
    // typed_value_invalid, so multiple-cardinality claims were structurally
    // unadmittable (evidence run: sh.project.participation / 拾光 rejected).
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: PREDICATE_IDS.projectParticipation,
        typedValue: "拾光",
      }),
      registryEntry: entryLookup.entryFor(PREDICATE_IDS.projectParticipation),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: null,
      currentVersion: null,
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote.conflictResolution).toBe("initial_admission");
    expect(promote.typedValue).toEqual(["拾光"]);
  });

  it("merges a provider-scalar direct statement into an existing objective value set", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: PREDICATE_IDS.workplace,
        typedValue: "公司B",
      }),
      registryEntry: entryLookup.entryFor(PREDICATE_IDS.workplace),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: currentVersion({
        kind: "objective",
        epistemicStatus: "confirmed",
        typedValue: ["公司A"],
      }),
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote.conflictResolution).toBe("temporal_or_correction_supersede");
    expect(canonicalValueSet(promote.typedValue as readonly string[])).toEqual([
      "公司A",
      "公司B",
    ]);
  });
});

describe("forget fence and relationships in admission", () => {
  it("blocks promotion while the claim sits inside the Forget fence", () => {
    const plan = planClaimAdmission({
      proposal: residenceProposal({ typedValue: "上海" }),
      registryEntry: entryLookup.entryFor(RESIDENCE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: currentVersion({ status: "retracted" }),
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({
      action: "blocked_forget_fence",
      reasonCodes: ["claim_inside_forget_fence"],
    });
  });

  it("blocks promotion when the evidence is inside an active Forget exclusion", () => {
    const plan = planClaimAdmission({
      proposal: residenceProposal({ typedValue: "上海" }),
      registryEntry: entryLookup.entryFor(RESIDENCE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: currentVersion({ typedValue: "上海" }),
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: ["e1"],
    });
    expect(plan).toMatchObject({
      action: "blocked_forget_fence",
      reasonCodes: ["evidence_inside_forget_exclusion"],
    });
  });

  it("does not let Qualifier-scoped Evidence re-support a neutral relationship", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: RELATIVE_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: MOM,
        evidenceItemIds: ["e1"],
      }),
      registryEntry: entryLookup.entryFor(RELATIVE_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: {
        ...SELF_BINDING,
        [MOM]: {
          entityVersionId: MOM_VERSION,
          status: "active",
          entityKindId: "sh.entity.person",
        },
      },
      existingClaim: { memoryClaimId: CURRENT_CLAIM_ID, canonicalKey: "k" },
      currentVersion: relationshipVersion(),
      currentVersionQualifiers: [],
      evidence: [evidence({ id: "e1", session: SESSION_1, revision: "rev-1" })],
      excludedEvidenceIds: [],
      excludedQualifierEvidence: [
        {
          axisId: "kinship_term",
          roleSide: "counterpart",
          evidenceItemIds: ["e1"],
        },
      ],
    });
    expect(plan).toEqual({
      action: "blocked_forget_fence",
      reasonCodes: ["qualifier_evidence_inside_forget_exclusion"],
    });
  });

  it("parks relationship candidates with an unresolved object Entity", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: PARTNER,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: null,
        objectEntityMentionId: "mention-1",
      }),
      registryEntry: entryLookup.entryFor(PARTNER),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: null,
      currentVersion: null,
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({
      action: "needs_entity_resolution",
      reasonCodes: ["object_entity_unresolved"],
    });
  });

  it("admits a fully bound direct relationship statement as an objective claim", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: PARTNER,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: MOM,
      }),
      registryEntry: entryLookup.entryFor(PARTNER),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: {
        ...SELF_BINDING,
        [MOM]: {
          entityVersionId: MOM_VERSION,
          status: "active",
          entityKindId: "sh.entity.person",
        },
      },
      existingClaim: null,
      currentVersion: null,
      evidence: [evidence({ id: "e1", session: SESSION_1, revision: "rev-1" })],
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote).toMatchObject({
      kind: "objective",
      epistemicStatus: "confirmed",
      objectEntityVersionId: MOM_VERSION,
    });
  });

  it("requires relationship claims to hold both parties before admission", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: PARTNER,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: MOM,
      }),
      registryEntry: entryLookup.entryFor(PARTNER),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: {
        ...SELF_BINDING,
        [MOM]: null,
      },
      existingClaim: null,
      currentVersion: null,
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({
      action: "needs_entity_resolution",
      reasonCodes: ["relationship_party_unbound"],
    });
  });
});

describe("dormancy (ADR-0041)", () => {
  const dormantBase = () =>
    currentVersion({
      kind: "impression",
      epistemicStatus: "inferred",
      typedValue: "positive",
      lastObservedAt: NOW,
    });

  it("never applies dormancy to objective memory, whatever the silence", () => {
    const plan = planImpressionDormancy({
      currentVersion: currentVersion({ lastObservedAt: new Date("2020-01-01T00:00:00.000Z") }),
      latestQualifyingEvidenceAt: null,
      now: NOW,
    });
    expect(plan.outcome).toBe("not_applicable");
  });

  it("keeps an active impression inside the 30-day review cycle", () => {
    const plan = planImpressionDormancy({
      currentVersion: dormantBase(),
      latestQualifyingEvidenceAt: NOW,
      now: addDays(NOW, IMPRESSION_REVIEW_CYCLE_DAYS - 1),
    });
    expect(plan.outcome).toBe("remain_active");
    expect(plan.reviewDeadline).toEqual(addDays(NOW, IMPRESSION_REVIEW_CYCLE_DAYS));
  });

  it("goes dormant at the review deadline and recovers only through full re-qualification", () => {
    const due = planImpressionDormancy({
      currentVersion: dormantBase(),
      latestQualifyingEvidenceAt: NOW,
      now: addDays(NOW, IMPRESSION_REVIEW_CYCLE_DAYS),
    });
    expect(due.outcome).toBe("go_dormant");

    const requalification = planClaimAdmission({
      proposal: baseProposal({
        predicateId: PREDICATE_IDS.statedStyle,
        typedValue: "positive",
        candidateKind: "impression",
        basis: "inferred",
      }),
      registryEntry: entryLookup.entryFor(PREDICATE_IDS.statedStyle),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: { ...dormantBase(), status: "dormant" },
      evidence: CROSS_SESSION_EVIDENCE,
      excludedEvidenceIds: [],
    });
    expect(requalification).toMatchObject({
      action: "promote",
      conflictResolution: "dormancy_requalified",
    });

    const singleSession = planClaimAdmission({
      proposal: baseProposal({
        predicateId: PREDICATE_IDS.statedStyle,
        typedValue: "positive",
        candidateKind: "impression",
        basis: "inferred",
      }),
      registryEntry: entryLookup.entryFor(PREDICATE_IDS.statedStyle),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: { memoryClaimId: "claim-1", canonicalKey: "k" },
      currentVersion: { ...dormantBase(), status: "dormant" },
      evidence: [evidence({ id: "e9", session: SESSION_1, revision: "rev-9" })],
      excludedEvidenceIds: [],
    });
    expect(singleSession).toMatchObject({
      action: "below_impression_floor",
      reasonCodes: ["cross_session_floor_not_met"],
    });
  });
});

describe("candidate terminal semantics (ADR-0046 / ADR-0051 / ADR-0052)", () => {
  it("computes the 7-day content expiry from the terminal effective time", () => {
    const plan = planRejectionDisposition({
      userId: USER,
      reasonCode: "evidence_missing",
      now: NOW,
      semanticTarget: "target",
      evidenceRevisionIds: ["rev-1"],
      secret: "test-secret",
    });
    expect(plan.terminalEffectiveAt).toEqual(NOW);
    expect(plan.terminalContentExpiresAt).toEqual(addDays(NOW, TERMINAL_CONTENT_EXPIRY_DAYS));
    expect(plan.reproposalPolicy).toBe("material_change_allowed");
  });

  it("sends registry-governance rejections to explicit reconsideration only", () => {
    const plan = planRejectionDisposition({
      userId: USER,
      reasonCode: "claim_kind_not_allowed_by_registry",
      now: NOW,
      semanticTarget: "target",
      evidenceRevisionIds: ["rev-1"],
      secret: "test-secret",
    });
    expect(plan.reproposalPolicy).toBe("explicit_reconsideration_only");
  });

  it("runs the stale content window from the original policy deadline, not sweeper time", () => {
    const originalDeadline = new Date("2026-08-01T00:00:00.000Z");
    const plan = planStaleDisposition({
      userId: USER,
      staleReason: "predicate_review_expired",
      originalDeadline,
      semanticTarget: "target",
      evidenceRevisionIds: ["rev-1"],
      secret: "test-secret",
    });
    expect(plan.terminalEffectiveAt).toEqual(originalDeadline);
    expect(plan.terminalContentExpiresAt).toEqual(addDays(originalDeadline, TERMINAL_CONTENT_EXPIRY_DAYS));
  });

  it("keys the terminal fingerprint to owner + semantic target + sorted revisions + policy", () => {
    const base = {
      userId: USER,
      semanticTarget: candidateSemanticTarget({
        resolutionStatus: "mapped",
        predicateId: RESIDENCE,
        proposedConcept: null,
        proposedObjectValue: "上海",
        proposedScopeKey: "",
        subjectEntityId: SELF,
        objectEntityId: null,
      }),
      policyVersion: "memory-admission:v1",
      secret: "test-secret",
    };
    const a = dedupeFingerprint({ ...base, evidenceRevisionIds: ["rev-2", "rev-1"] });
    const b = dedupeFingerprint({ ...base, evidenceRevisionIds: ["rev-1", "rev-2"] });
    expect(a).toBe(b);
    const differentTarget = dedupeFingerprint({
      ...base,
      semanticTarget: base.semanticTarget + "|x",
      evidenceRevisionIds: ["rev-1"],
    });
    expect(differentTarget).not.toBe(a);
    expect(() => dedupeFingerprint({ ...base, userId: "", evidenceRevisionIds: [] })).toThrow();
  });

  it("accepts only materially new evidence as successor grounds (ADR-0052)", () => {
    const predecessor = {
      status: "rejected",
      basis: "inferred",
      resolutionStatus: "mapped",
      subjectEntityId: SELF,
      objectEntityId: null,
      proposedObjectValue: "positive",
      metImpressionFloor: false,
      evidenceRevisionIds: ["rev-1"],
    } as const;

    const mereRepetition = evaluateMaterialChange({
      predecessor,
      proposal: baseProposal({
        predicateId: PREDICATE_IDS.statedStyle,
        typedValue: "positive",
        candidateKind: "impression",
        basis: "inferred",
        evidenceItemIds: ["e1"],
      }),
      evidence: [evidence({ id: "e1", session: SESSION_1, revision: "rev-1" })],
    });
    expect(mereRepetition.material).toBe(false);
    expect(mereRepetition.nonMaterialReasonCodes).toContain("no_new_evidence_revisions");

    const inferenceBecameStatement = evaluateMaterialChange({
      predecessor,
      proposal: baseProposal({
        predicateId: PREDICATE_IDS.statedStyle,
        typedValue: "positive",
        candidateKind: "objective",
        basis: "directly_stated",
        evidenceItemIds: ["e2"],
      }),
      evidence: [evidence({ id: "e2", session: SESSION_2, revision: "rev-2" })],
    });
    expect(inferenceBecameStatement.material).toBe(true);
    expect(inferenceBecameStatement.reasonCodes).toContain("inferred_to_directly_stated");

    const floorNewlyMet = evaluateMaterialChange({
      predecessor,
      proposal: baseProposal({
        predicateId: PREDICATE_IDS.statedStyle,
        typedValue: "positive",
        candidateKind: "impression",
        basis: "inferred",
        evidenceItemIds: ["e2", "e3"],
      }),
      evidence: [
        evidence({ id: "e2", session: SESSION_1, revision: "rev-2" }),
        evidence({ id: "e3", session: SESSION_2, revision: "rev-3" }),
      ],
    });
    expect(floorNewlyMet.material).toBe(true);
    expect(floorNewlyMet.reasonCodes).toContain("cross_session_floor_newly_met");
  });
});

describe("review deadlines", () => {
  it("applies the 30-day predicate review deadline and the 90-day registry wait", () => {
    expect(predicateReviewDeadline(NOW)).toEqual(addDays(NOW, NEEDS_PREDICATE_REVIEW_DEADLINE_DAYS));
    expect(registryReleaseDeadline(NOW)).toEqual(addDays(NOW, REGISTRY_RELEASE_WAIT_DAYS));
  });
});

// ── #115: Relationship Memory Claims — canonical identity, Qualifiers, time ──

const RELATIVE_OF = PREDICATE_IDS.relativeOf;
const FRIEND_OF = PREDICATE_IDS.friendOf;
const PARENT_OF = PREDICATE_IDS.parentOf;
const LILY = "01984477-31e1-7595-92c6-0688a0a00003";
const LILY_VERSION = "01984477-31e1-7595-92c6-0688a0b00003";

const BOTH_PARTIES = Object.freeze({
  ...SELF_BINDING,
  [LILY]: { entityVersionId: LILY_VERSION, status: "active", entityKindId: "sh.entity.person" },
});

function relationshipVersion(
  overrides: Partial<MemoryClaimVersionRecord> = {},
): MemoryClaimVersionRecord {
  return currentVersion({
    typedValue: "",
    subjectEntityVersionId: SELF_VERSION,
    objectEntityVersionId: LILY_VERSION,
    ...overrides,
  });
}

function qualifierRecord(input: {
  axisId: string;
  roleSide: "canonical_subject" | "counterpart";
  typedValue: string | readonly string[];
  evidenceItemIds: readonly string[];
}): ClaimVersionQualifierRecord {
  return {
    memoryClaimVersionQualifierId: asMemoryClaimVersionQualifierId(
      "01984477-31e1-7595-92c6-0688a0d00001",
    ),
    memoryClaimVersionId: CURRENT_VERSION_ID,
    axisId: input.axisId,
    roleSide: input.roleSide,
    typedValue: input.typedValue,
    evidenceItemIds: input.evidenceItemIds,
    createdAt: NOW,
  };
}

describe("relationship admission (#115: ADR-0027 / 0029 / 0030 / 0033 / 0036)", () => {
  it("admits the first statement with a qualifier whose side resolves canonically", () => {
    // SELF sorts before LILY, so the symmetric pair's canonical subject is SELF
    // and the candidate's object side (LILY, 姑姑) resolves to `counterpart`.
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: RELATIVE_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e1"],
        qualifiers: [
          { axisId: "kinship_term", roleSide: "object", typedValue: "姑姑", evidenceItemIds: ["e1"] },
        ],
      }),
      registryEntry: entryLookup.entryFor(RELATIVE_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: null,
      currentVersion: null,
      evidence: [evidence({ id: "e1", session: SESSION_1, revision: "rev-1" })],
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote.qualifiers).toEqual([
      { axisId: "kinship_term", roleSide: "counterpart", typedValue: "姑姑", evidenceItemIds: ["e1"] },
    ]);
  });

  it("reinforces an unchanged relationship re-statement without a new version", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: RELATIVE_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e9"],
      }),
      registryEntry: entryLookup.entryFor(RELATIVE_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: { memoryClaimId: CURRENT_CLAIM_ID, canonicalKey: "k" },
      currentVersion: relationshipVersion(),
      currentVersionQualifiers: [
        qualifierRecord({ axisId: "kinship_term", roleSide: "counterpart", typedValue: "姑姑", evidenceItemIds: ["e1"] }),
      ],
      evidence: [evidence({ id: "e9", session: SESSION_1, revision: "rev-9" })],
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({
      action: "reinforce_current",
      attachToVersionId: CURRENT_VERSION_ID,
      reasonCodes: ["same_value_reinforces_current"],
    });
  });

  it("advances a new version when a direct statement ends the relationship", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: RELATIVE_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e9"],
        temporal: {
          temporalStatus: "ended",
          validFrom: null,
          validFromPrecision: "unknown",
          validTo: null,
          validToPrecision: "unknown",
        },
      }),
      registryEntry: entryLookup.entryFor(RELATIVE_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: { memoryClaimId: CURRENT_CLAIM_ID, canonicalKey: "k" },
      currentVersion: relationshipVersion(),
      evidence: [evidence({ id: "e9", session: SESSION_1, revision: "rev-9" })],
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote).toMatchObject({
      claimAction: "new_version",
      conflictResolution: "temporal_or_correction_supersede",
      supersedesVersionId: CURRENT_VERSION_ID,
    });
    expect(promote.reasonCodes).toContain("relationship_state_change_advances_version");
    expect(promote.temporal.temporalStatus).toBe("ended");
  });

  it("reuses the logical Claim when an ended relationship restarts (ADR-0036)", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: RELATIVE_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e9"],
      }),
      registryEntry: entryLookup.entryFor(RELATIVE_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: { memoryClaimId: CURRENT_CLAIM_ID, canonicalKey: "k" },
      currentVersion: relationshipVersion({
        temporal: {
          temporalStatus: "ended",
          validFrom: new Date("2024-01-01T00:00:00.000Z"),
          validFromPrecision: "year",
          validTo: new Date("2025-06-01T00:00:00.000Z"),
          validToPrecision: "month",
        },
      }),
      evidence: [evidence({ id: "e9", session: SESSION_1, revision: "rev-9" })],
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote).toMatchObject({
      claimAction: "new_version",
      conflictResolution: "claim_reuse_new_interval",
      supersedesVersionId: CURRENT_VERSION_ID,
    });
    expect(promote.reasonCodes).toContain("relationship_restart_reuses_claim");
    expect(promote.temporal.temporalStatus).toBe("current");
  });

  it("advances a version when a direct statement refines temporal precision, preserving it verbatim", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: RELATIVE_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e9"],
        temporal: {
          temporalStatus: "current",
          validFrom: new Date("2024-06-01T00:00:00.000Z"),
          validFromPrecision: "month",
          validTo: null,
          validToPrecision: "unknown",
        },
      }),
      registryEntry: entryLookup.entryFor(RELATIVE_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: { memoryClaimId: CURRENT_CLAIM_ID, canonicalKey: "k" },
      currentVersion: relationshipVersion(),
      evidence: [evidence({ id: "e9", session: SESSION_1, revision: "rev-9" })],
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote.reasonCodes).toContain("relationship_validity_refined_by_direct_statement");
    expect(promote.temporal).toEqual({
      temporalStatus: "current",
      validFrom: new Date("2024-06-01T00:00:00.000Z"),
      validFromPrecision: "month",
      validTo: null,
      validToPrecision: "unknown",
    });
  });

  it("merges qualifier refinements: new side joins, carried qualifiers keep their evidence", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: RELATIVE_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e9"],
        qualifiers: [
          { axisId: "kinship_term", roleSide: "subject", typedValue: "侄子", evidenceItemIds: ["e9"] },
        ],
      }),
      registryEntry: entryLookup.entryFor(RELATIVE_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: { memoryClaimId: CURRENT_CLAIM_ID, canonicalKey: "k" },
      currentVersion: relationshipVersion(),
      currentVersionQualifiers: [
        qualifierRecord({ axisId: "kinship_term", roleSide: "counterpart", typedValue: "姑姑", evidenceItemIds: ["e1"] }),
      ],
      evidence: [evidence({ id: "e9", session: SESSION_1, revision: "rev-9" })],
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote.reasonCodes).toContain("qualifier_refined_by_direct_statement");
    expect(promote.qualifiers).toEqual([
      // carried qualifier keeps its original evidence
      { axisId: "kinship_term", roleSide: "counterpart", typedValue: "姑姑", evidenceItemIds: ["e1"] },
      // new qualifier cites the new statement's evidence
      { axisId: "kinship_term", roleSide: "canonical_subject", typedValue: "侄子", evidenceItemIds: ["e9"] },
    ]);
  });

  it("does not advance a version when the proposed qualifier equals the current one", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: RELATIVE_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e9"],
        qualifiers: [
          { axisId: "kinship_term", roleSide: "object", typedValue: "姑姑", evidenceItemIds: ["e9"] },
        ],
      }),
      registryEntry: entryLookup.entryFor(RELATIVE_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: { memoryClaimId: CURRENT_CLAIM_ID, canonicalKey: "k" },
      currentVersion: relationshipVersion(),
      currentVersionQualifiers: [
        qualifierRecord({ axisId: "kinship_term", roleSide: "counterpart", typedValue: "姑姑", evidenceItemIds: ["e1"] }),
      ],
      evidence: [evidence({ id: "e9", session: SESSION_1, revision: "rev-9" })],
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({ action: "reinforce_current" });
  });

  it("normalizes enum qualifier spellings onto the closed-set value", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: FRIEND_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e1"],
        qualifiers: [
          { axisId: "stated_closeness", roleSide: "subject", typedValue: "闺蜜", evidenceItemIds: ["e1"] },
        ],
      }),
      registryEntry: entryLookup.entryFor(FRIEND_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: null,
      currentVersion: null,
      evidence: [evidence({ id: "e1", session: SESSION_1, revision: "rev-1" })],
      excludedEvidenceIds: [],
    });
    const promote = expectPromote(plan);
    expect(promote.qualifiers).toEqual([
      { axisId: "stated_closeness", roleSide: "canonical_subject", typedValue: "best", evidenceItemIds: ["e1"] },
    ]);
  });

  it("rejects qualifiers that cite an axis the entry does not publish", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: FRIEND_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e1"],
        qualifiers: [
          { axisId: "kinship_term", roleSide: "subject", typedValue: "姑姑", evidenceItemIds: ["e1"] },
        ],
      }),
      registryEntry: entryLookup.entryFor(FRIEND_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: null,
      currentVersion: null,
      evidence: [evidence({ id: "e1", session: SESSION_1, revision: "rev-1" })],
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({ action: "reject", reasonCode: "qualifier_invalid" });
  });

  it("rejects enum qualifier spellings outside the closed set", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: FRIEND_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e1"],
        qualifiers: [
          { axisId: "stated_closeness", roleSide: "subject", typedValue: "网友", evidenceItemIds: ["e1"] },
        ],
      }),
      registryEntry: entryLookup.entryFor(FRIEND_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: null,
      currentVersion: null,
      evidence: [evidence({ id: "e1", session: SESSION_1, revision: "rev-1" })],
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({ action: "reject", reasonCode: "qualifier_invalid" });
  });

  it("rejects qualifiers whose evidence is empty or outside the candidate's evidence", () => {
    const emptyEvidence = planClaimAdmission({
      proposal: baseProposal({
        predicateId: RELATIVE_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e1"],
        qualifiers: [
          { axisId: "kinship_term", roleSide: "subject", typedValue: "亲戚", evidenceItemIds: [] },
        ],
      }),
      registryEntry: entryLookup.entryFor(RELATIVE_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: null,
      currentVersion: null,
      evidence: [evidence({ id: "e1", session: SESSION_1, revision: "rev-1" })],
      excludedEvidenceIds: [],
    });
    expect(emptyEvidence).toMatchObject({ action: "reject", reasonCode: "qualifier_invalid" });

    const foreignEvidence = planClaimAdmission({
      proposal: baseProposal({
        predicateId: RELATIVE_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e1"],
        qualifiers: [
          { axisId: "kinship_term", roleSide: "subject", typedValue: "亲戚", evidenceItemIds: ["e404"] },
        ],
      }),
      registryEntry: entryLookup.entryFor(RELATIVE_OF),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: null,
      currentVersion: null,
      evidence: [evidence({ id: "e1", session: SESSION_1, revision: "rev-1" })],
      excludedEvidenceIds: [],
    });
    expect(foreignEvidence).toMatchObject({ action: "reject", reasonCode: "qualifier_invalid" });
  });

  it("rejects qualifiers whose side the axis does not allow", () => {
    const pinnedEntry = {
      ...entryLookup.entryFor(RELATIVE_OF)!,
      relationshipSemantics: {
        ...entryLookup.entryFor(RELATIVE_OF)!.relationshipSemantics!,
        qualifierAxes: [
          {
            axisId: "kinship_term",
            appliesToRole: "canonical_subject" as const,
            valueSchema: { kind: "text" as const, normalization: "nfc_trim_collapsed" as const },
            cardinality: "single" as const,
            evidencePolicyId: "evidence-policy.global-v1",
            neutralFallbackZh: "亲戚",
            neutralFallbackEn: "relative",
          },
        ],
      },
    };
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: RELATIVE_OF,
        typedValue: "",
        subjectEntityId: SELF,
        objectEntityId: LILY,
        evidenceItemIds: ["e1"],
        qualifiers: [
          { axisId: "kinship_term", roleSide: "object", typedValue: "姑姑", evidenceItemIds: ["e1"] },
        ],
      }),
      registryEntry: pinnedEntry,
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: BOTH_PARTIES,
      existingClaim: null,
      currentVersion: null,
      evidence: [evidence({ id: "e1", session: SESSION_1, revision: "rev-1" })],
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({ action: "reject", reasonCode: "qualifier_invalid" });
  });

  it("rejects qualifiers attached to a non-relationship candidate", () => {
    const plan = planClaimAdmission({
      proposal: baseProposal({
        predicateId: RESIDENCE,
        typedValue: "上海",
        evidenceItemIds: ["e1"],
        qualifiers: [
          { axisId: "kinship_term", roleSide: "subject", typedValue: "家", evidenceItemIds: ["e1"] },
        ],
      }),
      registryEntry: entryLookup.entryFor(RESIDENCE),
      registryVersion: 1,
      selfEntityId: SELF,
      entityVersions: SELF_BINDING,
      existingClaim: null,
      currentVersion: null,
      evidence: [evidence({ id: "e1", session: SESSION_1, revision: "rev-1" })],
      excludedEvidenceIds: [],
    });
    expect(plan).toMatchObject({ action: "reject", reasonCode: "qualifier_invalid" });
  });

  it("keeps directed canonical orientation in the identity: swapped roles are a different fact", () => {
    // parent_of is directed: SELF as parent vs SELF as child are different
    // canonical Claims. The registry's canonical roles (not mention order)
    // decide which fact a phrasing denotes; the mapper owns that assignment.
    const parentClaim = claimCanonicalKey({
      predicateId: PARENT_OF,
      subjectEntityId: SELF,
      objectEntityId: LILY,
      scopeKey: "",
      relationshipDirection: "directed",
    });
    const childClaim = claimCanonicalKey({
      predicateId: PARENT_OF,
      subjectEntityId: LILY,
      objectEntityId: SELF,
      scopeKey: "",
      relationshipDirection: "directed",
    });
    expect(parentClaim).not.toBe(childClaim);
  });
});

describe("admittedClaimIdentityFor", () => {
  function candidateRecord(
    overrides: Partial<MemoryCandidateRecord> = {},
  ): MemoryCandidateRecord {
    return {
      memoryCandidateId: asMemoryCandidateId("01984477-31e1-7595-92c6-0688a0d00003"),
      userId: USER,
      candidateKind: "objective",
      basis: "directly_stated",
      subjectEntityId: SELF,
      objectEntityId: null,
      resolutionStatus: "mapped",
      predicateId: RESIDENCE,
      predicateRegistryVersion: 1,
      proposedConcept: null,
      mappingConfidence: 0.95,
      proposedObjectValue: "上海",
      proposedScopeKey: "",
      temporal: {
        temporalStatus: "current",
        validFrom: null,
        validFromPrecision: "unknown",
        validTo: null,
        validToPrecision: "unknown",
      },
      proposedQualifiers: [],
      extractionPolicyVersion: "extraction-test",
      generationCommandId: null,
      authoritativeModelAttemptId: null,
      modelVersion: null,
      promptVersion: null,
      sourceReflectionVersionId: null,
      status: "proposed",
      reviewDueAt: null,
      registryReleaseDueAt: null,
      dispositionReasonCode: null,
      dispositionPolicyVersion: null,
      decidedAt: null,
      terminalEffectiveAt: null,
      terminalContentExpiresAt: null,
      reproposalPolicy: null,
      predecessorCandidateId: null,
      successorTrigger: null,
      materialChangeReasonCodes: null,
      createdAt: NOW,
      ...overrides,
    };
  }

  it("forces the empty scope for scope-none entries regardless of the proposed scope", () => {
    const { proposal, canonicalKey } = admittedClaimIdentityFor(
      candidateRecord({ proposedScopeKey: "new_job" }),
      { scopeSchema: { kind: "none" }, relationshipSemantics: null },
      ["e1", "e2"],
    );
    expect(proposal.scopeKey).toBe("");
    expect(canonicalKey).toBe(
      claimCanonicalKey({
        predicateId: RESIDENCE,
        subjectEntityId: SELF,
        objectEntityId: null,
        scopeKey: "",
        relationshipDirection: null,
      }),
    );
  });

  it("keeps the proposed scope for scope-carrying entries", () => {
    const { proposal, canonicalKey } = admittedClaimIdentityFor(
      candidateRecord({
        predicateId: PREDICATE_IDS.lifeChange,
        proposedScopeKey: "career",
      }),
      {
        scopeSchema: { kind: "enum", values: [] },
        relationshipSemantics: null,
      },
      ["e1", "e2"],
    );
    expect(proposal.scopeKey).toBe("career");
    expect(canonicalKey).toBe(
      claimCanonicalKey({
        predicateId: PREDICATE_IDS.lifeChange,
        subjectEntityId: SELF,
        objectEntityId: null,
        scopeKey: "career",
        relationshipDirection: null,
      }),
    );
  });

  it("uses the registry relationship direction for the canonical pair", () => {
    const { canonicalKey } = admittedClaimIdentityFor(
      candidateRecord({
        predicateId: PARTNER,
        subjectEntityId: SELF,
        objectEntityId: MOM,
      }),
      {
        scopeSchema: { kind: "none" },
        relationshipSemantics: {
          direction: "symmetric",
          views: ["symmetric"],
          qualifierAxes: [],
        },
      },
      ["e1", "e2"],
    );
    expect(canonicalKey).toBe(
      claimCanonicalKey({
        predicateId: PARTNER,
        subjectEntityId: SELF,
        objectEntityId: MOM,
        scopeKey: "",
        relationshipDirection: "symmetric",
      }),
    );
  });

  it("projects the candidate record onto the admission proposal with the admitted scope", () => {
    const candidate = candidateRecord({
      proposedObjectValue: "上海",
      proposedScopeKey: "new_job",
      temporal: {
        temporalStatus: "current",
        validFrom: NOW,
        validFromPrecision: "exact",
        validTo: null,
        validToPrecision: "unknown",
      },
    });
    const { proposal } = admittedClaimIdentityFor(
      candidate,
      { scopeSchema: { kind: "none" }, relationshipSemantics: null },
      ["e1", "e2"],
    );
    expect(proposal).toMatchObject({
      userId: USER,
      candidateKind: "objective",
      basis: "directly_stated",
      resolution: {
        status: "mapped",
        predicateId: RESIDENCE,
        registryVersion: 1,
        typedValue: "上海",
        mappingConfidence: 0.95,
      },
      subjectEntityId: SELF,
      objectEntityId: null,
      scopeKey: "",
      temporal: candidate.temporal,
      evidenceItemIds: ["e1", "e2"],
      qualifiers: [],
      lineage: {
        extractionPolicyVersion: "extraction-test",
        generationCommandId: null,
        authoritativeModelAttemptId: null,
        modelVersion: null,
        promptVersion: null,
        sourceReflectionVersionId: null,
      },
    });
  });
});
