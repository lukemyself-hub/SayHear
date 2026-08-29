import { createHmac } from "node:crypto";

import type { MemoryClaimVersionId } from "@sayhear/domain";

import type { PredicateRegistryEntry } from "../predicate-registry/types";

import {
  DEDUPE_FINGERPRINT_KEY_VERSION,
  IMPRESSION_MIN_DAILY_SESSIONS,
  IMPRESSION_MIN_EVIDENCE_ITEMS,
  IMPRESSION_REVIEW_CYCLE_DAYS,
  MEMORY_ADMISSION_POLICY_VERSION,
  NEEDS_PREDICATE_REVIEW_DEADLINE_DAYS,
  REGISTRY_RELEASE_WAIT_DAYS,
  TERMINAL_CONTENT_EXPIRY_DAYS,
  type AdmissionRejectionCode,
  type AdmissibleEvidence,
  type AdmittedQualifier,
  type CandidateDispositionPlan,
  type CandidateRelativeRoleSide,
  type ClaimAdmissionPlan,
  type ClaimTypedValue,
  type ClaimVersionQualifierRecord,
  type ImpressionDormancyPlan,
  type MaterialChangeEvaluation,
  type MaterialChangeReasonCode,
  type MemoryCandidateRecord,
  type MemoryClaimVersionRecord,
  type MemoryCandidateProposal,
  type QualifierRoleSide,
  type ReproposalPolicy,
  type TemporalBounds,
} from "./types";

/**
 * Deterministic admission core (ADR-0038 / ADR-0039 / ADR-0040 / ADR-0041 /
 * ADR-0046 / ADR-0051 / ADR-0052). Everything here is pure: no I/O, no clock
 * reads — `now` is always injected. The repository executes the produced plans
 * inside one transaction; recency and model confidence never appear in any
 * decision input.
 */

export type ClaimAdmissionInput = Readonly<{
  proposal: MemoryCandidateProposal;
  registryEntry: PredicateRegistryEntry | null;
  registryVersion: number;
  selfEntityId: string;
  /** Current active-or-fenced EntityVersion per Entity ID (null when absent). */
  entityVersions: Readonly<
    Record<string, Readonly<{ entityVersionId: string; status: string; entityKindId: string }> | null>
  >;
  existingClaim: Readonly<{ memoryClaimId: string; canonicalKey: string }> | null;
  currentVersion: MemoryClaimVersionRecord | null;
  /**
   * The current version's stored Relationship Qualifiers (ADR-0033); the
   * baseline a directly-stated qualifier refinement merges against.
   */
  currentVersionQualifiers?: readonly ClaimVersionQualifierRecord[];
  evidence: readonly AdmissibleEvidence[];
  /** Evidence currently inside an applied whole-Claim Forget exclusion. */
  excludedEvidenceIds: readonly string[];
  /** Relationship role keys currently behind an active Qualifier Forget fence. */
  excludedQualifierKeys?: readonly Readonly<{
    axisId: string;
    roleSide: "canonical_subject" | "counterpart";
  }>[];
  /** Qualifier-scoped Evidence that remains excluded after an explicit Reversal. */
  excludedQualifierEvidence?: readonly Readonly<{
    axisId: string;
    roleSide: "canonical_subject" | "counterpart";
    evidenceItemIds: readonly string[];
  }>[];
}>;

/**
 * Structured, language-independent Claim identity (§7.10): canonicalized
 * subject / object Entity pair + predicate + business scope. Mention order,
 * observation direction, locale, and typed values never enter the key —
 * values change through new ClaimVersions of the same logical Claim.
 * Symmetric relationship predicates normalize the pair by stable Entity ID
 * order; directed predicates keep the registry's canonical direction.
 */
export function claimCanonicalKey(input: {
  predicateId: string;
  subjectEntityId: string;
  objectEntityId: string | null;
  scopeKey: string;
  relationshipDirection: "directed" | "symmetric" | null;
}): string {
  const pair =
    input.relationshipDirection === "symmetric" && input.objectEntityId
      ? [input.subjectEntityId, input.objectEntityId].sort().join("+")
      : `${input.subjectEntityId}>${input.objectEntityId ?? ""}`;
  return `v1|${input.predicateId}|${pair}|${input.scopeKey}`;
}

/**
 * Canonical multi-value form: sorted, deduplicated, non-empty. Multiple-
 * cardinality entries store the coexisting value set on the ClaimVersion.
 */
export function canonicalValueSet(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.normalize("NFC").trim()))]
    .filter((value) => value.length > 0)
    .sort((a, b) => a.localeCompare(b, "en"));
}

export function valuesEqual(
  entry: PredicateRegistryEntry,
  a: ClaimTypedValue,
  b: ClaimTypedValue,
): boolean {
  if (entry.valueCardinality === "multiple") {
    const setA = canonicalValueSet(asValueArray(a));
    const setB = canonicalValueSet(asValueArray(b));
    return (
      setA.length === setB.length && setA.every((value, index) => value === setB[index])
    );
  }
  return asSingleValue(a) === asSingleValue(b);
}

function asSingleValue(value: ClaimTypedValue): string {
  const single = typeof value === "string" ? value : value[0];
  return (single ?? "").normalize("NFC").trim();
}

function asValueArray(value: ClaimTypedValue): readonly string[] {
  return typeof value === "string" ? [value] : value;
}

function validateTypedValue(
  entry: PredicateRegistryEntry,
  value: ClaimTypedValue,
): boolean {
  // Relationship identity is the canonical Entity pair; roles are Qualifiers
  // with their own evidence (#115), so the version's typed value stays empty.
  if (entry.relationshipSemantics !== null) {
    return typeof value === "string" && value.trim() === "";
  }
  if (entry.valueCardinality === "multiple") {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === "string" && item.trim().length > 0)
    );
  }
  return typeof value === "string" && value.trim().length > 0;
}

// ── Relationship Qualifiers (ADR-0033, #115) ─────────────────────────────────

const QUALIFIER_TEXT_MAX_LENGTH = 2_000;

/**
 * Canonical side of a candidate-relative qualifier side (ADR-0032): directed
 * predicates always face the registry's canonical direction; symmetric
 * predicates resolve through the same sorted Entity-pair order that builds the
 * canonical key, so mention order never changes where a role lands.
 */
export function resolveQualifierRoleSide(input: {
  direction: "directed" | "symmetric";
  subjectEntityId: string;
  objectEntityId: string;
  roleSide: CandidateRelativeRoleSide;
}): QualifierRoleSide {
  if (input.direction === "directed") {
    return input.roleSide === "subject" ? "canonical_subject" : "counterpart";
  }
  const subjectIsCanonicalSubject =
    [input.subjectEntityId, input.objectEntityId].sort()[0] ===
    input.subjectEntityId;
  if (input.roleSide === "subject") {
    return subjectIsCanonicalSubject ? "canonical_subject" : "counterpart";
  }
  return subjectIsCanonicalSubject ? "counterpart" : "canonical_subject";
}

/**
 * Normalize one qualifier value against its axis schema. Text axes fold NFC +
 * trim; enum axes are closed sets — surface spellings resolve to the canonical
 * value id and unknown spellings fail closed (never coerced). Returns null for
 * any invalid input.
 */
function canonicalQualifierValue(
  axis: { valueSchema: PredicateRegistryEntry["objectValueSchema"]; cardinality: "single" | "multiple" },
  value: ClaimTypedValue,
): ClaimTypedValue | null {
  const schema = axis.valueSchema;
  if (schema.kind === "text") {
    if (typeof value !== "string") return null;
    const normalized = value.normalize("NFC").trim();
    if (!normalized || normalized.length > QUALIFIER_TEXT_MAX_LENGTH) return null;
    return normalized;
  }
  if (schema.kind === "enum") {
    const normalizeOne = (raw: string): string | null => {
      const needle = raw.normalize("NFC").trim();
      const lowered = needle.toLowerCase();
      for (const spec of schema.values) {
        if (spec.value === needle) return spec.value;
        if (
          spec.zh.some((surface) => surface.normalize("NFC").trim() === needle)
        ) {
          return spec.value;
        }
        if (
          spec.en.some(
            (surface) => surface.normalize("NFC").trim().toLowerCase() === lowered,
          )
        ) {
          return spec.value;
        }
      }
      return null;
    };
    if (axis.cardinality === "single") {
      return typeof value === "string" ? normalizeOne(value) : null;
    }
    if (!Array.isArray(value) || value.length === 0) return null;
    const resolved: string[] = [];
    for (const raw of value) {
      const one = normalizeOne(raw);
      if (one === null) return null;
      resolved.push(one);
    }
    return canonicalValueSet(resolved);
  }
  // Sentiment axes carry no relationship qualifier in v1; fail closed.
  return null;
}

/**
 * Deterministic qualifier validation (ADR-0033 / AC 14): every qualifier must
 * name a published axis, land on a side the axis allows, carry a schema-valid
 * value, and cite at least one of the candidate's own Evidence items. Returns
 * null instead of throwing — the caller rejects with `qualifier_invalid`.
 */
export function resolveQualifierProposals(input: {
  entry: PredicateRegistryEntry;
  proposal: MemoryCandidateProposal;
}): readonly AdmittedQualifier[] | null {
  const semantics = input.entry.relationshipSemantics;
  if (!semantics) return null;
  const { proposal } = input;
  if (proposal.qualifiers.length === 0) return [];
  if (!proposal.subjectEntityId || !proposal.objectEntityId) return null;
  const candidateEvidence = new Set(proposal.evidenceItemIds);
  const seen = new Set<string>();
  const resolved: AdmittedQualifier[] = [];
  for (const qualifier of proposal.qualifiers) {
    const axis = semantics.qualifierAxes.find(
      (candidate) => candidate.axisId === qualifier.axisId,
    );
    if (!axis) return null;
    const roleSide = resolveQualifierRoleSide({
      direction: semantics.direction,
      subjectEntityId: proposal.subjectEntityId,
      objectEntityId: proposal.objectEntityId,
      roleSide: qualifier.roleSide,
    });
    if (axis.appliesToRole !== "either" && axis.appliesToRole !== roleSide) {
      return null;
    }
    const typedValue = canonicalQualifierValue(axis, qualifier.typedValue);
    if (typedValue === null) return null;
    const evidenceItemIds = [...new Set(qualifier.evidenceItemIds)];
    if (
      evidenceItemIds.length === 0 ||
      evidenceItemIds.some((id) => !candidateEvidence.has(id))
    ) {
      return null;
    }
    const key = `${axis.axisId}\u0000${roleSide}`;
    if (seen.has(key)) return null;
    seen.add(key);
    resolved.push({ axisId: axis.axisId, roleSide, typedValue, evidenceItemIds });
  }
  return resolved;
}

function qualifierValuesEqual(a: ClaimTypedValue, b: ClaimTypedValue): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a.normalize("NFC").trim() === b.normalize("NFC").trim();
  }
  const setA = canonicalValueSet(asValueArray(a));
  const setB = canonicalValueSet(asValueArray(b));
  return setA.length === setB.length && setA.every((value, index) => value === setB[index]);
}

/**
 * Merge a directly-stated qualifier refinement onto the current version's
 * qualifiers (ADR-0033): carried qualifiers keep their original Evidence,
 * single-cardinality axes replace, multiple-cardinality axes coexist, and new
 * (axis, side) pairs append. Absence of a proposal never retracts a carried
 * qualifier — retraction is a user control, not extraction silence.
 */
export function mergeRelationshipQualifiers(
  entry: PredicateRegistryEntry,
  current: readonly ClaimVersionQualifierRecord[],
  proposed: readonly AdmittedQualifier[],
): readonly AdmittedQualifier[] {
  const semantics = entry.relationshipSemantics;
  if (!semantics) return [];
  const merged: AdmittedQualifier[] = current.map((record) => {
    const replacement = proposed.find(
      (candidate) =>
        candidate.axisId === record.axisId && candidate.roleSide === record.roleSide,
    );
    if (!replacement) {
      return {
        axisId: record.axisId,
        roleSide: record.roleSide,
        typedValue: record.typedValue,
        evidenceItemIds: [...record.evidenceItemIds],
      };
    }
    const axis = semantics.qualifierAxes.find(
      (candidate) => candidate.axisId === record.axisId,
    );
    if (axis?.cardinality === "multiple") {
      return {
        axisId: record.axisId,
        roleSide: record.roleSide,
        typedValue: canonicalValueSet([
          ...asValueArray(record.typedValue),
          ...asValueArray(replacement.typedValue),
        ]),
        evidenceItemIds: [
          ...new Set([...record.evidenceItemIds, ...replacement.evidenceItemIds]),
        ],
      };
    }
    return { ...replacement };
  });
  for (const qualifier of proposed) {
    const carried = current.some(
      (record) =>
        record.axisId === qualifier.axisId && record.roleSide === qualifier.roleSide,
    );
    if (!carried) {
      merged.push(qualifier);
    }
  }
  return merged;
}

function relationshipQualifiersChanged(
  merged: readonly AdmittedQualifier[],
  current: readonly ClaimVersionQualifierRecord[],
): boolean {
  if (merged.length !== current.length) return true;
  return merged.some((qualifier) => {
    const record = current.find(
      (candidate) =>
        candidate.axisId === qualifier.axisId &&
        candidate.roleSide === qualifier.roleSide,
    );
    if (!record) return true;
    return !qualifierValuesEqual(qualifier.typedValue, record.typedValue);
  });
}

function temporalBoundsDiffer(a: TemporalBounds, b: TemporalBounds): boolean {
  return (
    (a.validFrom?.getTime() ?? null) !== (b.validFrom?.getTime() ?? null) ||
    a.validFromPrecision !== b.validFromPrecision ||
    (a.validTo?.getTime() ?? null) !== (b.validTo?.getTime() ?? null) ||
    a.validToPrecision !== b.validToPrecision
  );
}

/**
 * Registry evidence policies may only raise the global cross-session floor
 * (ADR-0039); a policy id this admission version does not know fails closed
 * to the global floor instead of trusting the entry.
 */
export function impressionEvidenceFloor(
  _entry: PredicateRegistryEntry,
): Readonly<{ minEvidenceItems: number; minDailySessions: number }> {
  return Object.freeze({
    minEvidenceItems: IMPRESSION_MIN_EVIDENCE_ITEMS,
    minDailySessions: IMPRESSION_MIN_DAILY_SESSIONS,
  });
}

export function countEvidenceIndependence(evidence: readonly AdmissibleEvidence[]): {
  evidenceItems: number;
  dailySessions: number;
} {
  return {
    evidenceItems: new Set(evidence.map((item) => item.sourceRevisionId)).size,
    dailySessions: new Set(evidence.map((item) => item.dailySessionId)).size,
  };
}

function meetsImpressionFloor(
  evidence: readonly AdmissibleEvidence[],
  floor: Readonly<{ minEvidenceItems: number; minDailySessions: number }>,
): boolean {
  const counts = countEvidenceIndependence(evidence);
  return (
    counts.evidenceItems >= floor.minEvidenceItems &&
    counts.dailySessions >= floor.minDailySessions
  );
}

/**
 * The deterministic admission validator. Order is fixed: registry gates,
 * kind/basis coherence, typed value and temporal shape, evidence fence,
 * entity binding, impression floor, and only then conflict resolution against
 * the current ClaimVersion (ADR-0040 routing: cardinality → temporal/correction
 * supersede → contested as last resort). Recency and confidence are not
 * inputs anywhere.
 */
export function planClaimAdmission(input: ClaimAdmissionInput): ClaimAdmissionPlan {
  const { proposal, registryEntry } = input;

  if (!registryEntry || registryEntry.status !== "active") {
    return { action: "reject", reasonCode: "predicate_not_active" };
  }
  if (proposal.resolution.status !== "mapped" || registryEntry.predicateId !== proposal.resolution.predicateId) {
    return { action: "reject", reasonCode: "predicate_not_active" };
  }
  if (proposal.resolution.registryVersion !== input.registryVersion) {
    return { action: "reject", reasonCode: "registry_version_mismatch" };
  }
  const statedKind: "objective" | "impression" =
    proposal.basis === "directly_stated" ? "objective" : "impression";
  if (proposal.candidateKind !== statedKind) {
    // Model inference must never be admitted as Objective Memory and a direct
    // statement never routes through the impression path (ADR-0038 / ADR-0039).
    return { action: "reject", reasonCode: "kind_basis_mismatch" };
  }
  if (!registryEntry.allowedClaimKinds.includes(statedKind)) {
    return { action: "reject", reasonCode: "claim_kind_not_allowed_by_registry" };
  }

  const typedValue: ClaimTypedValue =
    proposal.resolution.status === "mapped" ? proposal.resolution.typedValue : "";
  if (!validateTypedValue(registryEntry, typedValue)) {
    return { action: "reject", reasonCode: "typed_value_invalid" };
  }
  if (
    proposal.temporal.temporalStatus === "ended" &&
    !registryEntry.temporalSemantics.temporalStatuses.includes("current_ended")
  ) {
    // `ended` needs registry temporal machinery; stable entries never end.
    return { action: "reject", reasonCode: "temporal_status_not_supported" };
  }

  if (input.evidence.length === 0) {
    return { action: "reject", reasonCode: "evidence_missing" };
  }
  if (
    input.evidence.some(
      (item) =>
        item.sourceActor !== "user" ||
        item.status !== "active" ||
        (item.sourceStatus !== "final" && item.sourceStatus !== "corrected"),
    )
  ) {
    return { action: "reject", reasonCode: "evidence_ineligible" };
  }
  const excluded = new Set(input.excludedEvidenceIds);
  if (input.evidence.some((item) => excluded.has(item.evidenceItemId))) {
    return {
      action: "blocked_forget_fence",
      reasonCodes: ["evidence_inside_forget_exclusion"],
    };
  }

  const isRelationship = registryEntry.relationshipSemantics !== null;
  const subjectBinding = input.entityVersions[proposal.subjectEntityId ?? ""] ?? null;
  const objectBinding = input.entityVersions[proposal.objectEntityId ?? ""] ?? null;

  if (!isRelationship) {
    if (proposal.subjectEntityId !== input.selfEntityId) {
      return { action: "reject", reasonCode: "subject_not_self_entity" };
    }
    if (!subjectBinding || subjectBinding.status !== "active") {
      return { action: "needs_entity_resolution", reasonCodes: ["subject_entity_unbound"] };
    }
    if (!registryEntry.allowedSubjectKindIds.includes(subjectBinding.entityKindId)) {
      return { action: "reject", reasonCode: "subject_kind_not_allowed" };
    }
  } else {
    if (!proposal.subjectEntityId) {
      return { action: "needs_entity_resolution", reasonCodes: ["subject_entity_unresolved"] };
    }
    if (!proposal.objectEntityId) {
      if (proposal.objectEntityMentionId) {
        return { action: "needs_entity_resolution", reasonCodes: ["object_entity_unresolved"] };
      }
      return { action: "reject", reasonCode: "relationship_object_missing" };
    }
    if (
      !subjectBinding ||
      !objectBinding ||
      subjectBinding.status !== "active" ||
      objectBinding.status !== "active"
    ) {
      return { action: "needs_entity_resolution", reasonCodes: ["relationship_party_unbound"] };
    }
    if (
      !registryEntry.allowedSubjectKindIds.includes(subjectBinding.entityKindId) ||
      !registryEntry.allowedSubjectKindIds.includes(objectBinding.entityKindId)
    ) {
      return { action: "reject", reasonCode: "subject_kind_not_allowed" };
    }
    if (proposal.subjectEntityId === proposal.objectEntityId) {
      return { action: "reject", reasonCode: "relationship_parties_identical" };
    }
  }

  // Qualifier validation runs after entity binding so the canonical side can
  // resolve; an unbound party still parks before this point (needs_entity_resolution).
  let admittedQualifiers: readonly AdmittedQualifier[] = [];
  if (registryEntry.relationshipSemantics !== null) {
    if (proposal.qualifiers.length > 0) {
      const resolved = resolveQualifierProposals({ entry: registryEntry, proposal });
      if (!resolved) {
        return { action: "reject", reasonCode: "qualifier_invalid" };
      }
      admittedQualifiers = resolved;
    }
  } else if (proposal.qualifiers.length > 0) {
    // Qualifiers exist only on relationship claims (ADR-0033); anywhere else
    // they are a malformed proposal.
    return { action: "reject", reasonCode: "qualifier_invalid" };
  }

  const excludedQualifierKeys = new Set(
    (input.excludedQualifierKeys ?? []).map(
      (key) => `${key.axisId}\u0000${key.roleSide}`,
    ),
  );
  if (
    admittedQualifiers.some((qualifier) =>
      excludedQualifierKeys.has(`${qualifier.axisId}\u0000${qualifier.roleSide}`),
    )
  ) {
    return {
      action: "blocked_forget_fence",
      reasonCodes: ["qualifier_inside_forget_exclusion"],
    };
  }
  const excludedQualifierEvidence = new Map(
    (input.excludedQualifierEvidence ?? []).map((entry) => [
      `${entry.axisId}\u0000${entry.roleSide}`,
      new Set(entry.evidenceItemIds),
    ]),
  );
  const excludedQualifierEvidenceIds = new Set(
    [...excludedQualifierEvidence.values()].flatMap((ids) => [...ids]),
  );
  if (
    input.evidence.some((item) =>
      excludedQualifierEvidenceIds.has(item.evidenceItemId),
    )
  ) {
    return {
      action: "blocked_forget_fence",
      reasonCodes: ["qualifier_evidence_inside_forget_exclusion"],
    };
  }
  if (
    admittedQualifiers.some((qualifier) => {
      const excluded = excludedQualifierEvidence.get(
        `${qualifier.axisId}\u0000${qualifier.roleSide}`,
      );
      return excluded !== undefined && qualifier.evidenceItemIds.some((id) =>
        excluded.has(id),
      );
    })
  ) {
    return {
      action: "blocked_forget_fence",
      reasonCodes: ["qualifier_evidence_inside_forget_exclusion"],
    };
  }

  if (statedKind === "impression") {
    const floor = impressionEvidenceFloor(registryEntry);
    if (!meetsImpressionFloor(input.evidence, floor)) {
      const counts = countEvidenceIndependence(input.evidence);
      return {
        action: "below_impression_floor",
        reasonCodes: ["cross_session_floor_not_met"],
        floor,
        actual: counts,
      };
    }
  }

  return routeAgainstCurrentVersion(
    input,
    registryEntry,
    statedKind,
    typedValue,
    admittedQualifiers,
  );
}

function routeAgainstCurrentVersion(
  input: ClaimAdmissionInput,
  registryEntry: PredicateRegistryEntry,
  statedKind: "objective" | "impression",
  typedValue: ClaimTypedValue,
  admittedQualifiers: readonly AdmittedQualifier[],
): ClaimAdmissionPlan {
  const { proposal, currentVersion } = input;
  const relationshipDirection =
    registryEntry.relationshipSemantics?.direction ?? null;
  const canonicalKey = claimCanonicalKey({
    predicateId: registryEntry.predicateId,
    subjectEntityId: proposal.subjectEntityId!,
    objectEntityId: proposal.objectEntityId,
    scopeKey: proposal.scopeKey,
    relationshipDirection,
  });
  const subjectEntityVersionId = input.entityVersions[proposal.subjectEntityId!]!
    .entityVersionId;
  const objectEntityVersionId = proposal.objectEntityId
    ? input.entityVersions[proposal.objectEntityId]!.entityVersionId
    : null;
  const temporal: TemporalBounds = proposal.temporal;

  if (!currentVersion) {
    return {
      action: "promote",
      conflictResolution: "initial_admission",
      claimAction: input.existingClaim ? "new_version" : "create_claim",
      canonicalKey,
      kind: statedKind,
      epistemicStatus: statedKind === "objective" ? "confirmed" : "inferred",
      versionStatus: "active",
      subjectEntityId: proposal.subjectEntityId!,
      subjectEntityVersionId,
      objectEntityId: proposal.objectEntityId,
      objectEntityVersionId,
      predicateId: registryEntry.predicateId,
      scopeKey: proposal.scopeKey,
      typedValue,
      temporal,
      qualifiers: admittedQualifiers,
      supersedesVersionId: null,
      reasonCodes: [],
    };
  }

  if (currentVersion.status === "retracted") {
    return {
      action: "blocked_forget_fence",
      reasonCodes: ["claim_inside_forget_fence"],
    };
  }

  // The user's direct statement resolves any live contest, whichever side it
  // states (ADR-0040: any later resolution creates another immutable
  // ClaimVersion).
  if (currentVersion.status === "review_due" && proposal.basis === "directly_stated") {
    return promotePlan(input, registryEntry, statedKind, typedValue, canonicalKey, {
      conflictResolution: "contested_resolved",
      supersedesVersionId: currentVersion.memoryClaimVersionId,
      reasonCodes: ["direct_statement_resolves_contest"],
    });
  }

  // Relationship state machine (ADR-0027 / 0029 / 0030 / 0033 / 0036): the
  // typed value of a relationship is always empty, so a directly-stated
  // temporal state change, validity refinement, or qualifier refinement is
  // the version-advance signal — each appends an immutable ClaimVersion on the
  // SAME logical Claim (canonical identity is Entity pair + Predicate only).
  if (
    registryEntry.relationshipSemantics !== null &&
    statedKind === "objective" &&
    proposal.basis === "directly_stated" &&
    currentVersion.kind === "objective"
  ) {
    const currentQualifiers = input.currentVersionQualifiers ?? [];
    const mergedQualifiers = mergeRelationshipQualifiers(
      registryEntry,
      currentQualifiers,
      admittedQualifiers,
    );
    const statusChanged =
      proposal.temporal.temporalStatus !== currentVersion.temporal.temporalStatus;
    const boundsChanged = temporalBoundsDiffer(proposal.temporal, currentVersion.temporal);
    const qualifiersChanged = relationshipQualifiersChanged(
      mergedQualifiers,
      currentQualifiers,
    );
    if (statusChanged || boundsChanged || qualifiersChanged) {
      const restarted =
        currentVersion.temporal.temporalStatus === "ended" &&
        proposal.temporal.temporalStatus === "current";
      return promotePlan(input, registryEntry, statedKind, typedValue, canonicalKey, {
        conflictResolution: restarted
          ? "claim_reuse_new_interval"
          : "temporal_or_correction_supersede",
        supersedesVersionId: currentVersion.memoryClaimVersionId,
        reasonCodes: [
          ...(statusChanged
            ? [
                restarted
                  ? "relationship_restart_reuses_claim"
                  : "relationship_state_change_advances_version",
              ]
            : []),
          ...(boundsChanged ? ["relationship_validity_refined_by_direct_statement"] : []),
          ...(qualifiersChanged ? ["qualifier_refined_by_direct_statement"] : []),
        ],
        qualifiers: mergedQualifiers,
      });
    }
  }

  const equal = valuesEqual(registryEntry, typedValue, currentVersion.typedValue);

  if (equal) {
    if (currentVersion.status === "active" || currentVersion.status === "superseded") {
      return {
        action: "reinforce_current",
        conflictResolution: null,
        attachToVersionId: currentVersion.memoryClaimVersionId,
        linkRole: "support",
        reasonCodes: ["same_value_reinforces_current"],
      };
    }
    if (currentVersion.status === "review_due") {
      return {
        action: "reinforce_current",
        conflictResolution: null,
        attachToVersionId: currentVersion.memoryClaimVersionId,
        linkRole: "support",
        reasonCodes: ["evidence_attached_to_contested_version"],
      };
    }
    if (currentVersion.status === "dormant") {
      if (statedKind === "objective") {
        return promotePlan(input, registryEntry, statedKind, typedValue, canonicalKey, {
          conflictResolution: "direct_statement_reactivates",
          supersedesVersionId: currentVersion.memoryClaimVersionId,
          reasonCodes: ["direct_statement_reactivates"],
        });
      }
      // Dormant AI Impressions recover only through fresh Evidence that again
      // satisfies the cross-Session floor on its own (ADR-0041).
      const floor = impressionEvidenceFloor(registryEntry);
      if (meetsImpressionFloor(input.evidence, floor)) {
        return promotePlan(input, registryEntry, statedKind, typedValue, canonicalKey, {
          conflictResolution: "dormancy_requalified",
          supersedesVersionId: currentVersion.memoryClaimVersionId,
          reasonCodes: ["fresh_evidence_requalifies"],
        });
      }
      const counts = countEvidenceIndependence(input.evidence);
      return {
        action: "below_impression_floor",
        reasonCodes: ["requalification_floor_not_met"],
        floor,
        actual: counts,
      };
    }
  }

  if (proposal.basis === "directly_stated") {
    // An explicit user statement of a different value is a state change or a
    // correction: new confirmed ClaimVersion, history preserved (ADR-0040).
    return promotePlan(input, registryEntry, statedKind, typedValue, canonicalKey, {
      conflictResolution: "temporal_or_correction_supersede",
      supersedesVersionId: currentVersion.memoryClaimVersionId,
      reasonCodes: ["direct_statement_supersedes"],
    });
  }

  if (registryEntry.valueCardinality === "multiple") {
    // Registry-permitted coexistence means there is no mutual exclusion to
    // contest. A qualifying inferred candidate may grow the value set of an
    // impression claim (the floor was met by its own evidence); merging into
    // a confirmed objective set waits for the user's direct statement.
    if (currentVersion.kind === "impression") {
      return promotePlan(input, registryEntry, statedKind, typedValue, canonicalKey, {
        conflictResolution: "value_coexist",
        supersedesVersionId: currentVersion.memoryClaimVersionId,
        reasonCodes: ["coexisting_value_added"],
      });
    }
    return {
      action: "pending_conflict",
      reasonCodes: ["coexist_value_awaits_direct_statement"],
    };
  }

  if (
    currentVersion.status === "review_due" ||
    (currentVersion.status === "dormant" && currentVersion.kind === "impression")
  ) {
    return {
      action: "reinforce_current",
      conflictResolution: null,
      attachToVersionId: currentVersion.memoryClaimVersionId,
      linkRole: "counter",
      reasonCodes: ["counter_evidence_attached"],
    };
  }

  if (currentVersion.kind === "impression") {
    // Two inferred values that mutually exclude with unresolvable intent:
    // the only contested entry point (ADR-0040 last resort).
    return {
      action: "contested",
      conflictResolution: "contested_conflict",
      claimAction: "new_version",
      canonicalKey,
      kind: statedKind,
      epistemicStatus: "contested",
      versionStatus: "review_due",
      subjectEntityVersionId,
      objectEntityVersionId,
      typedValue,
      temporal,
      qualifiers: [],
      supersedesVersionId: currentVersion.memoryClaimVersionId,
      reasonCodes: ["mutually_exclusive_inferred_values"],
    };
  }

  // A model inference never auto-contests (or overrides) a confirmed user
  // statement; the candidate waits for the user's own word (ADR-0040).
  return {
    action: "pending_conflict",
    reasonCodes: ["inference_conflicts_with_confirmed_statement"],
  };
}

function promotePlan(
  input: ClaimAdmissionInput,
  registryEntry: PredicateRegistryEntry,
  statedKind: "objective" | "impression",
  typedValue: ClaimTypedValue,
  canonicalKey: string,
  overrides: {
    conflictResolution:
      | "contested_resolved"
      | "dormancy_requalified"
      | "temporal_or_correction_supersede"
      | "value_coexist"
      | "direct_statement_reactivates"
      | "claim_reuse_new_interval";
    supersedesVersionId: MemoryClaimVersionId | null;
    reasonCodes: readonly string[];
    qualifiers?: readonly AdmittedQualifier[];
  },
): ClaimAdmissionPlan {
  const { proposal } = input;
  return {
    action: "promote",
    conflictResolution: overrides.conflictResolution,
    claimAction: input.existingClaim ? "new_version" : "create_claim",
    canonicalKey,
    kind: statedKind,
    epistemicStatus: statedKind === "objective" ? "confirmed" : "inferred",
    versionStatus: "active",
    subjectEntityId: proposal.subjectEntityId!,
    subjectEntityVersionId: input.entityVersions[proposal.subjectEntityId!]!.entityVersionId,
    objectEntityId: proposal.objectEntityId,
    objectEntityVersionId: proposal.objectEntityId
      ? input.entityVersions[proposal.objectEntityId]!.entityVersionId
      : null,
    predicateId: registryEntry.predicateId,
    scopeKey: proposal.scopeKey,
    typedValue:
      overrides.conflictResolution === "temporal_or_correction_supersede" ||
      overrides.conflictResolution === "value_coexist"
        ? registryEntry.valueCardinality === "multiple"
          ? canonicalValueSet([
              ...asValueArray(typedValue),
              ...asValueArray(input.currentVersion!.typedValue),
            ])
          : typedValue
        : typedValue,
    temporal: proposal.temporal,
    qualifiers: overrides.qualifiers ?? [],
    supersedesVersionId: overrides.supersedesVersionId,
    reasonCodes: overrides.reasonCodes,
  };
}

/**
 * Uniform 30-day review cycle for active AI Impressions only (ADR-0041).
 * Objective Memory never decays with silence: `not_applicable` is the answer
 * for every non-impression or non-active version, and no code path lowers
 * confidence or epistemic status over time.
 */
export function planImpressionDormancy(input: {
  currentVersion: MemoryClaimVersionRecord | null;
  latestQualifyingEvidenceAt: Date | null;
  now: Date;
}): ImpressionDormancyPlan {
  const { currentVersion, latestQualifyingEvidenceAt, now } = input;
  if (
    !currentVersion ||
    currentVersion.kind !== "impression" ||
    currentVersion.status !== "active"
  ) {
    return {
      outcome: "not_applicable",
      reviewDeadline: null,
      latestQualifyingEvidenceAt,
    };
  }
  const base = latestQualifyingEvidenceAt ?? currentVersion.lastObservedAt;
  const reviewDeadline = addDays(base, IMPRESSION_REVIEW_CYCLE_DAYS);
  return {
    outcome: now.getTime() >= reviewDeadline.getTime() ? "go_dormant" : "remain_active",
    reviewDeadline,
    latestQualifyingEvidenceAt: base,
  };
}

/**
 * Deterministic write-side material-change evaluator (ADR-0052). It compares
 * structured admission conditions only — never free-text similarity, never
 * model confidence. Sensitive-classification proposals can only re-enter via
 * `inferred_to_directly_stated`, which routes them as fresh Objective
 * candidates, exactly as ADR-0052 requires.
 */
export function evaluateMaterialChange(input: {
  predecessor: Readonly<{
    status: MemoryCandidateRecord["status"];
    basis: MemoryCandidateRecord["basis"];
    resolutionStatus: MemoryCandidateRecord["resolutionStatus"];
    subjectEntityId: string | null;
    objectEntityId: string | null;
    proposedObjectValue: MemoryCandidateRecord["proposedObjectValue"];
    metImpressionFloor: boolean;
    evidenceRevisionIds: readonly string[];
  }>;
  proposal: MemoryCandidateProposal;
  evidence: readonly AdmissibleEvidence[];
}): MaterialChangeEvaluation {
  const reasonCodes: MaterialChangeReasonCode[] = [];
  const nonMaterialReasonCodes: string[] = [];
  const predecessorRevisions = new Set(input.predecessor.evidenceRevisionIds);
  const newRevisionIds = input.evidence
    .map((item) => item.sourceRevisionId)
    .filter((revisionId) => !predecessorRevisions.has(revisionId));
  const hasNewEvidence = newRevisionIds.length > 0;
  if (!hasNewEvidence) {
    nonMaterialReasonCodes.push("no_new_evidence_revisions");
  }

  if (input.predecessor.basis === "inferred" && input.proposal.basis === "directly_stated") {
    reasonCodes.push("inferred_to_directly_stated");
  }
  const floor = {
    minEvidenceItems: IMPRESSION_MIN_EVIDENCE_ITEMS,
    minDailySessions: IMPRESSION_MIN_DAILY_SESSIONS,
  };
  if (!input.predecessor.metImpressionFloor && meetsImpressionFloor(input.evidence, floor)) {
    reasonCodes.push("cross_session_floor_newly_met");
  }
  const entityUniquelyResolved =
    (input.predecessor.subjectEntityId === null &&
      input.proposal.subjectEntityId !== null) ||
    (input.predecessor.objectEntityId === null &&
      input.proposal.objectEntityId !== null);
  if (entityUniquelyResolved && hasNewEvidence) {
    reasonCodes.push("entity_resolution_uniquely_resolved");
  }
  if (input.predecessor.resolutionStatus !== "mapped" && input.proposal.resolution.status === "mapped") {
    reasonCodes.push("predicate_resolution_uniquely_resolved");
  }
  if (
    hasNewEvidence &&
    input.proposal.resolution.status === "mapped" &&
    JSON.stringify(canonicalCandidateValue(input.proposal)) !==
      JSON.stringify(canonicalRecordValue(input.predecessor.proposedObjectValue))
  ) {
    reasonCodes.push("target_refined_by_new_evidence");
  }

  if (reasonCodes.length === 0 && nonMaterialReasonCodes.length === 0) {
    nonMaterialReasonCodes.push("insufficient_change_per_adr_0052");
  }
  return { material: reasonCodes.length > 0, reasonCodes, nonMaterialReasonCodes };
}

function canonicalCandidateValue(proposal: MemoryCandidateProposal): ClaimTypedValue {
  if (proposal.resolution.status !== "mapped") return "";
  const value = proposal.resolution.typedValue;
  return typeof value === "string"
    ? value.normalize("NFC").trim()
    : canonicalValueSet(value);
}

function canonicalRecordValue(value: ClaimTypedValue): ClaimTypedValue {
  return typeof value === "string"
    ? value.normalize("NFC").trim()
    : canonicalValueSet(value);
}

/**
 * Keyed exact-match terminal fence fingerprint (ADR-0051): binds owner +
 * canonical semantic target + sorted evidence revision IDs + policy version.
 * It may only block identical re-proposals; it is never retrieval, clustering,
 * analytics, or reconstruction material.
 */
export function dedupeFingerprint(input: {
  secret: string;
  userId: string;
  semanticTarget: string;
  evidenceRevisionIds: readonly string[];
  policyVersion: string;
}): string {
  if (!input.secret) {
    throw new Error("dedupeFingerprint secret must be non-empty.");
  }
  if (!input.userId) {
    throw new Error("dedupeFingerprint requires the owner binding.");
  }
  const revisions = [...new Set(input.evidenceRevisionIds)].sort();
  return createHmac("sha256", input.secret)
    .update(
      [
        DEDUPE_FINGERPRINT_KEY_VERSION,
        input.userId,
        input.semanticTarget,
        revisions.join(","),
        input.policyVersion,
      ].join("\n"),
    )
    .digest("hex");
}

/** Canonical semantic target of a candidate: predicate-or-concept + pair + scope + value. */
export function candidateSemanticTarget(
  candidate: Pick<
    MemoryCandidateRecord,
    | "resolutionStatus"
    | "predicateId"
    | "proposedConcept"
    | "proposedObjectValue"
    | "proposedScopeKey"
  > & { subjectEntityId: string | null; objectEntityId: string | null },
): string {
  const predicate =
    candidate.resolutionStatus === "mapped"
      ? (candidate.predicateId ?? "")
      : `concept:${candidate.proposedConcept ?? ""}`;
  const value =
    typeof candidate.proposedObjectValue === "string"
      ? candidate.proposedObjectValue.normalize("NFC").trim()
      : canonicalValueSet(candidate.proposedObjectValue).join("\u0001");
  return [
    predicate,
    candidate.subjectEntityId ?? "",
    candidate.objectEntityId ?? "",
    candidate.proposedScopeKey,
    value,
  ].join("|");
}

/**
 * Terminal rejection plan. Registry-governance boundaries re-open only via
 * explicit versioned reconsideration; ordinary extraction-shape failures allow
 * materially-new-evidence successors (ADR-0046 / ADR-0052).
 */
export function planRejectionDisposition(input: {
  userId: string;
  reasonCode: AdmissionRejectionCode;
  now: Date;
  semanticTarget: string;
  evidenceRevisionIds: readonly string[];
  secret: string;
}): CandidateDispositionPlan {
  const reproposalPolicy: ReproposalPolicy = REGISTRY_GOVERNANCE_REJECTIONS.has(
    input.reasonCode,
  )
    ? "explicit_reconsideration_only"
    : "material_change_allowed";
  return {
    status: "rejected",
    dispositionReasonCode: input.reasonCode,
    dispositionPolicyVersion: MEMORY_ADMISSION_POLICY_VERSION,
    reproposalPolicy,
    terminalEffectiveAt: input.now,
    terminalContentExpiresAt: addDays(input.now, TERMINAL_CONTENT_EXPIRY_DAYS),
    dedupeFingerprint: dedupeFingerprint({
      secret: input.secret,
      userId: input.userId,
      semanticTarget: input.semanticTarget,
      evidenceRevisionIds: input.evidenceRevisionIds,
      policyVersion: MEMORY_ADMISSION_POLICY_VERSION,
    }),
  };
}

/**
 * Stale disposition (ADR-0048 / ADR-0050): the content window runs from the
 * ORIGINAL policy deadline — a delayed sweeper never extends it (ADR-0051).
 */
export function planStaleDisposition(input: {
  userId: string;
  staleReason: "predicate_review_expired" | "registry_release_expired";
  originalDeadline: Date;
  semanticTarget: string;
  evidenceRevisionIds: readonly string[];
  secret: string;
}): CandidateDispositionPlan {
  return {
    status: "stale",
    dispositionReasonCode: input.staleReason,
    dispositionPolicyVersion: MEMORY_ADMISSION_POLICY_VERSION,
    reproposalPolicy: "material_change_allowed",
    terminalEffectiveAt: input.originalDeadline,
    terminalContentExpiresAt: addDays(input.originalDeadline, TERMINAL_CONTENT_EXPIRY_DAYS),
    dedupeFingerprint: dedupeFingerprint({
      secret: input.secret,
      userId: input.userId,
      semanticTarget: input.semanticTarget,
      evidenceRevisionIds: input.evidenceRevisionIds,
      policyVersion: MEMORY_ADMISSION_POLICY_VERSION,
    }),
  };
}

const REGISTRY_GOVERNANCE_REJECTIONS: ReadonlySet<AdmissionRejectionCode> = new Set([
  "predicate_not_active",
  "registry_version_mismatch",
  "claim_kind_not_allowed_by_registry",
  "subject_kind_not_allowed",
]);

export function predicateReviewDeadline(reviewEligibleAt: Date): Date {
  return addDays(reviewEligibleAt, NEEDS_PREDICATE_REVIEW_DEADLINE_DAYS);
}

export function registryReleaseDeadline(waitStartedAt: Date): Date {
  return addDays(waitStartedAt, REGISTRY_RELEASE_WAIT_DAYS);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
