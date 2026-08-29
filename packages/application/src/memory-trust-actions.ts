import type {
  ConversationActionDefinition,
  ConversationActionProposal,
} from "./conversation-action-catalog";
import type {
  ConversationActionHandler,
  ConversationActionTransactionExecutor,
  ResolvedTrustActionTarget,
} from "./conversation-action-gateway";

/**
 * Trust-Control Action domain module (issue #119, SPEC #107 "Trust actions",
 * ADR-0001 / ADR-0008 / ADR-0035 / ADR-0039 / ADR-0118).
 *
 * The Gateway resolves the anchor to a real Claim (deterministic, bounded,
 * owner-scoped — the data-side source and the pure planner below); the typed
 * handler plans the domain change from the locked claim snapshot and hands
 * the plan to the {@link MemoryTrustActionCommitPort}, whose data-layer
 * implementation executes it through the admission transaction executor.
 * Everything a correction writes joins the single admission transaction
 * (ADR-0099): a failure rolls the whole admission back, so no partial effect
 * can survive while a reply claims success.
 *
 * User control is recorded as user control commands (ADR-0035 pattern), never
 * as counter-Evidence: corrections supersede the deactivated version and, for
 * AI Impressions, record the user veto so same-topic impressions re-accumulate
 * fresh cross-Session Evidence from zero (ADR-0039) — the old evidence chain
 * is not reactivated.
 */

export const MEMORY_CORRECTION_POLICY_VERSION = "memory-correction:v1";
export const TRUST_ACTION_TARGET_RESOLUTION_POLICY_VERSION =
  "trust-action-target-resolution:v1";

export const MEMORY_FORGET_UNSUPPORTED_SCOPE_REASON =
  "person_wide_unsupported";

/** Bounded anchor length mirrors the catalog inputSchema ceiling. */
export const TRUST_ACTION_ANCHOR_MAX_LENGTH = 300;

// ---------------------------------------------------------------------------
// Admission-time target resolution (ADR-0118).
// ---------------------------------------------------------------------------

/**
 * One active Claim as the resolution planner sees it. All surfaces are
 * normalized with the shared retrieval term policy; the data-side source
 * merges the claim's zh / en projection rows and its entity label surfaces.
 */
export type TrustActionResolutionCandidate = Readonly<{
  claimId: string;
  claimKind: "objective" | "impression";
  claimVersionId: string;
  /** Defaults to memory_claim for the original #119 candidates. */
  targetKind?: "memory_claim" | "relationship_qualifier";
  /** Compiler-minted qualifier identity; never a Predicate ID. */
  qualifierId?: string;
  qualifierAxisId?: string;
  qualifierRoleSide?: "canonical_subject" | "counterpart";
  qualifierTypedValue?: string | readonly string[];
  /**
   * The claim's current entity label surfaces with the entity each belongs
   * to (normalized; current primary + verified aliases only).
   */
  entitySurfaceBindings: readonly Readonly<{
    entityId: string;
    surface: string;
  }>[];
  /** Merged projection lexical terms, normalized and deduplicated. */
  lexicalTerms: readonly string[];
  predicateId: string;
  /**
   * Registry lexical surfaces of this claim's predicate, normalized.
   * Optional: the composed resolver fills them from the released registry
   * snapshot; a bare source yields no predicate surfaces.
   */
  predicateSurfaces?: readonly string[];
  subjectEntityId: string;
  objectEntityId: string | null;
  /** Normalized typed value items of the current version. */
  typedValues: readonly string[];
}>;

/**
 * The owner's full current entity label index — the same resolvability
 * substrate query construction uses: a surface resolves only when it maps to
 * exactly one entity across current labels and verified aliases.
 */
export type TrustActionLabelIndexEntry = Readonly<{
  entityId: string;
  surface: string;
}>;

export type TrustActionTargetResolutionPlan =
  | Readonly<{
      outcome: "unique";
      signals: readonly string[];
      target: Readonly<{
        claimId: string;
        claimKind: "objective" | "impression";
        claimVersionId: string;
        predicateId: string;
        targetKind: "memory_claim" | "relationship_qualifier";
        qualifierId?: string;
        qualifierAxisId?: string;
        qualifierRoleSide?: "canonical_subject" | "counterpart";
        qualifierTypedValue?: string | readonly string[];
      }>;
    }>
  | Readonly<{ outcome: "scope_ambiguous" }>
  | Readonly<{ candidateCount: number; outcome: "multi_hit" }>
  | Readonly<{ outcome: "zero_hit" }>;

/**
 * Deterministic anchor→claim resolution over the Action's bounded search
 * space (ADR-0118). Surface matching reuses the retrieval query policy
 * exactly: CJK surfaces match as substrings, ASCII surfaces match on word
 * boundaries, and the vocabulary is the published projection material — the
 * anchor is a resolution clue, never a free-text selector (ADR-0096).
 *
 * A candidate is high-confidence when any of the §10.3-mirroring signals
 * holds: the anchor names its typed value (value-exact), the anchor resolves
 * uniquely to one of its bound entities AND names the predicate (entity +
 * predicate joint), or ≥2 independent non-broad lexical surfaces match.
 * Weak single-surface overlaps never admit — an honest zero-hit is safer
 * than a plausible wrong target (wrong-target and false-success gate at
 * zero; SPEC AC 30 / 32).
 */
export function planTrustActionTargetResolution(input: {
  anchor: string;
  broadTerms: readonly string[];
  candidates: readonly TrustActionResolutionCandidate[];
  labelIndex: readonly TrustActionLabelIndexEntry[];
}): TrustActionTargetResolutionPlan {
  const anchor = input.anchor.normalize("NFKC").toLowerCase().trim();
  if (anchor === "") return { outcome: "zero_hit" };
  const broad = new Set(input.broadTerms);

  // A surface shared by several entities is ambiguous and resolves to
  // nothing — computed over the owner's full current label index, the same
  // resolvability rule query construction applies (a surface shared by two
  // entities that never matched a claim here is still ambiguous).
  const surfaceOwners = new Map<string, Set<string>>();
  for (const entry of input.labelIndex) {
    const owners = surfaceOwners.get(entry.surface) ?? new Set<string>();
    owners.add(entry.entityId);
    surfaceOwners.set(entry.surface, owners);
  }

  const highConfidence: {
    candidate: TrustActionResolutionCandidate;
    signals: string[];
  }[] = [];
  for (const candidate of input.candidates) {
    const matchedTerms = candidate.lexicalTerms.filter((term) =>
      surfaceOccursIn(term, anchor),
    );
    const valueExact = candidate.typedValues.some(
      (value) => value !== "" && surfaceOccursIn(value, anchor),
    );
    const uniqueEntityNamed = candidate.entitySurfaceBindings.some(
      (binding) =>
        surfaceOwners.get(binding.surface)?.size === 1 &&
        surfaceOccursIn(binding.surface, anchor),
    );
    const predicateNamed = (candidate.predicateSurfaces ?? []).some(
      (surface) => surfaceOccursIn(surface, anchor),
    );
    const entityJoint = uniqueEntityNamed && predicateNamed;
    const distinctNonBroad = [
      ...new Set(matchedTerms.filter((term) => !broad.has(term))),
    ];
    const twoIndependentTerms = distinctNonBroad.length >= 2;

    const signals: string[] = [];
    if (valueExact) signals.push("target_signal_value_exact");
    if (entityJoint) signals.push("target_signal_entity_predicate_joint");
    if (twoIndependentTerms) signals.push("target_signal_two_independent_terms");
    if (signals.length > 0) {
      highConfidence.push({ candidate, signals });
    }
  }

  if (highConfidence.length === 0) return { outcome: "zero_hit" };
  if (highConfidence.length > 1) {
    const claimIds = new Set(highConfidence.map(({ candidate }) => candidate.claimId));
    const targetKinds = new Set(
      highConfidence.map(
        ({ candidate }) => candidate.targetKind ?? "memory_claim",
      ),
    );
    // Whole Claim and Qualifier are two different scopes over the same
    // logical Claim. When both are plausible, selecting one would silently
    // turn an ambiguous user request into a destructive choice.
    if (claimIds.size === 1 && targetKinds.size > 1) {
      return { outcome: "scope_ambiguous" };
    }
    return { candidateCount: highConfidence.length, outcome: "multi_hit" };
  }
  const hit = highConfidence[0]!;
  const targetKind = hit.candidate.targetKind ?? "memory_claim";
  return {
    outcome: "unique",
    signals: hit.signals,
    target: {
      claimId: hit.candidate.claimId,
      claimKind: hit.candidate.claimKind,
      claimVersionId: hit.candidate.claimVersionId,
      predicateId: hit.candidate.predicateId,
      targetKind,
      ...(targetKind === "relationship_qualifier" && hit.candidate.qualifierId
        ? { qualifierId: hit.candidate.qualifierId }
        : {}),
      ...(targetKind === "relationship_qualifier" && hit.candidate.qualifierAxisId
        ? { qualifierAxisId: hit.candidate.qualifierAxisId }
        : {}),
      ...(targetKind === "relationship_qualifier" && hit.candidate.qualifierRoleSide
        ? { qualifierRoleSide: hit.candidate.qualifierRoleSide }
        : {}),
      ...(targetKind === "relationship_qualifier" && hit.candidate.qualifierTypedValue !== undefined
        ? { qualifierTypedValue: hit.candidate.qualifierTypedValue }
        : {}),
    },
  };
}

/** CJK containment / ASCII word-boundary matching, shared with query construction. */
function surfaceOccursIn(surface: string, normalizedText: string): boolean {
  if (/[a-z0-9]/.test(surface)) {
    return new RegExp(
      `(?:^|[^a-z0-9])${surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`,
    ).test(normalizedText);
  }
  return normalizedText.includes(surface);
}

// ---------------------------------------------------------------------------
// Memory Correction planning (ADR-0001 / ADR-0035 / ADR-0039).
// ---------------------------------------------------------------------------

export type TrustActionClaimSnapshot = Readonly<{
  claimId: string;
  currentVersion: Readonly<{
    createdBy: string;
    kind: "objective" | "impression";
    /** Ordinal of the current version within its logical claim. */
    revision: number;
    status: "active" | "review_due" | "dormant" | "superseded" | "retracted";
    versionId: string;
  }> | null;
}>;

export type MemoryCorrectionPlan =
  | Readonly<{
      action: "supersede";
      claimKind: "objective" | "impression";
      correctedFactRecorded: boolean;
      recordVeto: boolean;
    }>
  | Readonly<{ action: "noop_already_converged"; reasonCode: string }>;

/**
 * Deterministic correction plan against the locked claim state. A repeated
 * correction converges by logical Claim reuse WITH version append as normal
 * history (SPEC story 48): correcting a claim whose current version a prior
 * correction already superseded appends the new superseding version on the
 * same logical claim — no duplicate claim, no digest-dedup machinery, and a
 * later correction carrying new words is never silently swallowed. Only a
 * claim that left recall through another fence (Forget, dormancy) converges
 * as an honest `succeeded_noop`.
 */
export function planMemoryCorrection(input: {
  correctedFactPresent: boolean;
  snapshot: TrustActionClaimSnapshot;
}): MemoryCorrectionPlan {
  const { snapshot } = input;
  const current = snapshot.currentVersion;
  if (current === null) {
    return { action: "noop_already_converged", reasonCode: "claim_has_no_current_version" };
  }
  if (current.status !== "active" && current.status !== "superseded") {
    return {
      action: "noop_already_converged",
      reasonCode: `claim_version_${current.status}`,
    };
  }
  return {
    action: "supersede",
    claimKind: current.kind,
    correctedFactRecorded: input.correctedFactPresent,
    // Impression correction deactivates the current Impression version and
    // records the user veto; re-accumulation starts from zero (ADR-0039).
    recordVeto: current.kind === "impression",
  };
}

export type MemoryForgetRequestPlan =
  | Readonly<{ action: "apply" }>
  | Readonly<{ action: "noop_already_fenced"; reasonCode: string }>;

/**
 * Forget is a user control operation, not an extraction side effect. The
 * target type selects the real granularity: a whole Claim or one Qualifier.
 * This planner intentionally knows only the locked state; SQL owns the
 * append-only version and exclusion writes.
 */
export function planMemoryForgetRequest(input: {
  targetKind: "memory_claim" | "relationship_qualifier";
  currentVersionStatus:
    | "active"
    | "review_due"
    | "dormant"
    | "superseded"
    | "retracted";
  targetQualifierPresent?: boolean;
}): MemoryForgetRequestPlan {
  if (
    input.targetKind === "memory_claim" &&
    input.currentVersionStatus === "retracted"
  ) {
    return { action: "noop_already_fenced", reasonCode: "claim_already_fenced" };
  }
  if (
    input.targetKind === "relationship_qualifier" &&
    input.targetQualifierPresent === false
  ) {
    return {
      action: "noop_already_fenced",
      reasonCode: "qualifier_already_fenced",
    };
  }
  return { action: "apply" };
}

export type MemoryForgetReversalPlan =
  | Readonly<{ action: "restore" }>
  | Readonly<{ action: "precondition_failed"; reasonCode: string }>;

export function planMemoryForgetReversal(input: {
  fencePresent: boolean;
}): MemoryForgetReversalPlan {
  return input.fencePresent
    ? { action: "restore" }
    : { action: "precondition_failed", reasonCode: "target_not_fenced" };
}

/**
 * Person-wide Forget/Reversal is deliberately outside this Function's scope.
 * The check only recognizes explicit broad wording; a normal target anchor
 * such as "my home in Shanghai" remains eligible for admission-time lookup.
 */
export function isPersonWideMemoryForgetAnchor(anchor: string): boolean {
  const normalized = anchor.normalize("NFKC").toLowerCase().trim();
  if (normalized === "") return false;
  return (
    new Set(["everything", "all", "所有", "全部", "一切"]).has(normalized) ||
    /\b(?:everything|all|every)\b.{0,80}\b(?:about|of|my\s+memories?|memory|things?)\b/.test(
      normalized,
    ) ||
    /\b(?:all|every)\s+(?:of\s+)?(?:my\s+)?(?:memories?|things?)\b/.test(
      normalized,
    ) ||
    /关于.{0,80}(?:所有|全部|一切).{0,40}(?:记忆|信息|事情)?/.test(normalized) ||
    /(?:所有|全部|一切).{0,40}(?:记忆|信息)/.test(normalized)
  );
}

// ---------------------------------------------------------------------------
// Source explanation evidence verdict (ADR-0008).
// ---------------------------------------------------------------------------

export type ExplainMemorySourceVerdict =
  | Readonly<{
      claimKind: "objective" | "impression";
      items: readonly Readonly<{
        /** ISO calendar date of the source User Event revision. */
        occurredOn: string;
        /** The user's actual words, bounded excerpt. */
        quote: string;
      }>[];
      verdict: "verified";
    }>
  | Readonly<{ verdict: "unverifiable" }>;

/** Bounded quote length per evidence item (the reply needs the words, not the transcript). */
export const EXPLAIN_SOURCE_QUOTE_MAX_LENGTH = 400;

// ---------------------------------------------------------------------------
// The transaction-scoped commit port (data-layer implemented).
// ---------------------------------------------------------------------------

/**
 * The write/read surface a synchronous trust handler uses inside the single
 * admission transaction. Implementations issue SQL through the executor; the
 * decisions stay in the pure planners above (plan / execute split mirrors the
 * MemoryClaimRepository discipline).
 */
export type MemoryTrustActionCommitPort = Readonly<{
  /**
   * Load and lock (`FOR UPDATE`) the resolved claim with its current version
   * state, re-verifying owner scope inside the admission transaction.
   */
  loadTrustActionClaim(
    executor: ConversationActionTransactionExecutor,
    input: { claimId: string; userId: string },
  ): Promise<TrustActionClaimSnapshot | null>;
  executeMemoryCorrectionPlan(
    executor: ConversationActionTransactionExecutor,
    input: {
      actionExecutionId: string;
      plan: MemoryCorrectionPlan;
      requestEventRevisionId: string;
      snapshot: TrustActionClaimSnapshot;
      userId: string;
    },
  ): Promise<void>;
  executeMemoryForgetRequestPlan(
    executor: ConversationActionTransactionExecutor,
    input: {
      actionExecutionId: string;
      requestEventRevisionId: string;
      target: ResolvedTrustActionTarget;
      userId: string;
    },
  ): Promise<string>;
  executeMemoryForgetReversalPlan(
    executor: ConversationActionTransactionExecutor,
    input: {
      actionExecutionId: string;
      requestEventRevisionId: string;
      target: ResolvedTrustActionTarget;
      userId: string;
    },
  ): Promise<string>;
  /**
   * Read-only evidence verification for `explain_memory_source`: expand the
   * claim's valid Evidence to final / corrected User Event Revisions (active
   * support / subjective-report links minus Forget exclusions) and return the
   * bounded snapshot, or the `unverifiable` verdict (ADR-0008).
   */
  loadExplainEvidenceVerdict(
    executor: ConversationActionTransactionExecutor,
    input: { claimId: string; userId: string },
  ): Promise<ExplainMemorySourceVerdict>;
}>;

// ---------------------------------------------------------------------------
// Typed handlers (ADR-0098 deep modules).
// ---------------------------------------------------------------------------

function boundedStringArgument(
  proposal: ConversationActionProposal,
  definition: ConversationActionDefinition,
  key: string,
): string | null {
  const value = proposal.arguments[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.length > TRUST_ACTION_ANCHOR_MAX_LENGTH
  ) {
    return null;
  }
  return trimmed;
}

export function createMemoryCorrectionActionHandler(input: {
  commitPort: MemoryTrustActionCommitPort;
}): ConversationActionHandler {
  return {
    actionKind: "memory_correction",
    prepare({ definition, proposal, resolvedTarget }) {
      if (!resolvedTarget) {
        throw new Error(
          "Memory correction requires the admission-time resolved target.",
        );
      }
      const correctedFact = boundedStringArgument(
        proposal,
        definition,
        "correctedFact",
      );
      return {
        actionKind: definition.actionKind,
        mode: "in_transaction_anchor",
        resolvedClaimId: resolvedTarget.claimId,
        resolvedClaimVersionId: resolvedTarget.claimVersionId,
        resolvedTargetKind: resolvedTarget.targetKind,
        commit: async ({ actionExecutionId, executor, userId }) => {
          const snapshot = await input.commitPort.loadTrustActionClaim(executor, {
            claimId: resolvedTarget.claimId,
            userId,
          });
          if (snapshot === null) {
            // The resolved target vanished under the admission lock — fail
            // closed: the whole admission rolls back and no success ships.
            throw new Error(
              `The resolved memory claim ${resolvedTarget.claimId} no longer exists for this owner.`,
            );
          }
          const plan = planMemoryCorrection({
            correctedFactPresent: correctedFact !== null,
            snapshot,
          });
          if (plan.action === "supersede") {
            await input.commitPort.executeMemoryCorrectionPlan(executor, {
              actionExecutionId,
              plan,
              requestEventRevisionId: proposal.requestEventRevisionId,
              snapshot,
              userId,
            });
            return "committed_in_transaction";
          }
          // Cross-event duplicate convergence: the claim already sits behind
          // this correction (or left the active state) — honest noop, no new
          // version, no duplicate claim (SPEC story 48).
          return "succeeded_noop";
        },
      };
    },
  };
}

export function createExplainMemorySourceActionHandler(input: {
  commitPort: MemoryTrustActionCommitPort;
}): ConversationActionHandler {
  return {
    actionKind: "explain_memory_source",
    prepare({ definition, resolvedTarget }) {
      if (!resolvedTarget) {
        throw new Error(
          "Source explanation requires the admission-time resolved target.",
        );
      }
      return {
        actionKind: definition.actionKind,
        mode: "in_transaction_anchor",
        resolvedClaimId: resolvedTarget.claimId,
        resolvedClaimVersionId: resolvedTarget.claimVersionId,
        resolvedTargetKind: resolvedTarget.targetKind,
        commit: async ({ executor, userId }) => {
          const snapshot = await input.commitPort.loadTrustActionClaim(executor, {
            claimId: resolvedTarget.claimId,
            userId,
          });
          if (snapshot === null) {
            throw new Error(
              `The resolved memory claim ${resolvedTarget.claimId} no longer exists for this owner.`,
            );
          }
          // Read-only: verify the resolved Claim's Evidence down to valid
          // User Event Revisions and freeze only the verdict in the Receipt
          // (ADR-0008). Dates and the user's actual words are re-derived for
          // the finalization reply from the typed reference; the fixed
          // "cannot verify" phrasing covers every unverifiable case.
          const verdict = await input.commitPort.loadExplainEvidenceVerdict(
            executor,
            { claimId: resolvedTarget.claimId, userId },
          );
          return verdict.verdict === "verified"
            ? "source_evidence_verified"
            : "source_unverifiable";
        },
      };
    },
  };
}

export function createMemoryForgetRequestActionHandler(input: {
  commitPort: MemoryTrustActionCommitPort;
}): ConversationActionHandler {
  return {
    actionKind: "memory_forget_request",
    prepare({ definition, proposal, resolvedTarget }) {
      if (!resolvedTarget) {
        throw new Error(
          "Memory Forget requires the admission-time resolved target.",
        );
      }
      return {
        actionKind: definition.actionKind,
        mode: "in_transaction_anchor",
        resolvedClaimId: resolvedTarget.claimId,
        resolvedClaimVersionId: resolvedTarget.claimVersionId,
        resolvedTargetKind: resolvedTarget.targetKind,
        ...(resolvedTarget.targetKind === "relationship_qualifier"
          ? { resolvedQualifierId: resolvedTarget.qualifierId }
          : {}),
        commit: async ({ actionExecutionId, executor, userId }) =>
          input.commitPort.executeMemoryForgetRequestPlan(executor, {
            actionExecutionId,
            requestEventRevisionId: proposal.requestEventRevisionId,
            target: resolvedTarget,
            userId,
          }),
      };
    },
  };
}

export function createMemoryForgetReversalActionHandler(input: {
  commitPort: MemoryTrustActionCommitPort;
}): ConversationActionHandler {
  return {
    actionKind: "memory_forget_reversal",
    prepare({ definition, proposal, resolvedTarget }) {
      if (!resolvedTarget) {
        throw new Error(
          "Memory Forget Reversal requires the admission-time resolved target.",
        );
      }
      return {
        actionKind: definition.actionKind,
        mode: "in_transaction_anchor",
        resolvedClaimId: resolvedTarget.claimId,
        resolvedClaimVersionId: resolvedTarget.claimVersionId,
        resolvedTargetKind: resolvedTarget.targetKind,
        ...(resolvedTarget.targetKind === "relationship_qualifier"
          ? { resolvedQualifierId: resolvedTarget.qualifierId }
          : {}),
        commit: async ({ actionExecutionId, executor, userId }) =>
          input.commitPort.executeMemoryForgetReversalPlan(executor, {
            actionExecutionId,
            requestEventRevisionId: proposal.requestEventRevisionId,
            target: resolvedTarget,
            userId,
          }),
      };
    },
  };
}
