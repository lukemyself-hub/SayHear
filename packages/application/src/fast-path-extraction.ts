import { asUserId, asWorkflowCommandId } from "@sayhear/domain";

import type {
  EntityLabelIndexEntry,
  EntityMentionProposal,
  EntityService,
} from "./entity";
import {
  ENTITY_RESOLVER_POLICY_VERSION,
  normalizeEntityLabel,
} from "./entity";
import { assertWorkflowSafe } from "./journal-eligibility";
import {
  candidateSemanticTarget,
  dedupeFingerprint,
  predicateReviewDeadline,
} from "./memory-claim/admission";
import {
  MEMORY_ADMISSION_POLICY_VERSION,
  type MemoryCandidateProposal,
  type RegistryEntryLookup,
} from "./memory-claim/types";
import {
  loadPredicateRegistrySnapshot,
  PREDICATE_REGISTRY_RUNTIME_VERSION,
} from "./predicate-registry";

/**
 * The released predicate ids the provider may choose from — the same
 * snapshot the admission path pins. Providers cannot know the registry, and
 * invented predicate ids can only ever land in `needs_predicate_review`,
 * so the extraction request carries the real selection space (issue #126
 * evidence runs exposed this: every real responses-api proposal invented
 * ids like `sh.predicate.employment` and never reached a recallable Claim).
 */
const PREDICATE_REGISTRY_SNAPSHOT = loadPredicateRegistrySnapshot(
  PREDICATE_REGISTRY_RUNTIME_VERSION,
);
const RELEASED_PREDICATE_IDS: readonly string[] =
  PREDICATE_REGISTRY_SNAPSHOT.entries.map((entry) => entry.predicateId);
/**
 * The relationship subset: relationship identity is the canonical Entity
 * pair, so providers must not attach typed values to these predicates
 * (proposal validation enforces it; the egress normalizer strips stray
 * values before that check).
 */
const RELEASED_RELATIONSHIP_PREDICATE_IDS: readonly string[] =
  PREDICATE_REGISTRY_SNAPSHOT.entries
    .filter((entry) => entry.relationshipSemantics !== null)
    .map((entry) => entry.predicateId);
/**
 * Per-predicate bilingual label + definition (issue #126 evidence runs): a
 * bare id list left the provider guessing semantics from id spellings, so
 * natural phrasing without a published lexical surface (「在一起了」…) never
 * reached partner_of and mis-mapped to unrelated predicates — relationship
 * claims then stayed unadmitted. The definitions are the registry's own
 * admission semantics; the provider still only proposes.
 */
export type ReleasedPredicateMaterial = Readonly<{
  predicateId: string;
  labelZh: string;
  labelEn: string;
  definitionZh: string;
  definitionEn: string;
}>;

const RELEASED_PREDICATE_MATERIAL: readonly ReleasedPredicateMaterial[] =
  PREDICATE_REGISTRY_SNAPSHOT.entries.map((entry) => {
    const localization = (locale: "zh" | "en") =>
      PREDICATE_REGISTRY_SNAPSHOT.localizations.find(
        (candidate) =>
          candidate.predicateId === entry.predicateId &&
          candidate.locale === locale,
      );
    return {
      predicateId: entry.predicateId,
      labelZh: localization("zh")?.label ?? "",
      labelEn: localization("en")?.label ?? "",
      definitionZh: localization("zh")?.definition ?? "",
      definitionEn: localization("en")?.definition ?? "",
    };
  });

/**
 * Fast-path extraction workflow (SPEC #107 "Two-speed pipeline", issue #113,
 * ADR-0115 / ADR-0087 / ADR-0088 / ADR-0077 / ADR-0060). Every committed
 * final / corrected User Event carries one idempotent outbox command; the
 * worker batches a session's pending revisions for Provider economy while
 * Evidence, results, idempotency, and invalidation remain per revision.
 *
 * The pipeline is strictly propose-then-commit: one `memory.extract` call
 * proposes Evidence locators, EntityMentions, and Memory Candidates;
 * deterministic user-scoped resolution runs first; `entity.resolve` is called
 * only on remaining bounded ambiguity and commits only on
 * unique candidate ∧ verdict = match ∧ confidence ≥ t_auto. Fast-path output
 * serves same-day session-local context only — never Claim admission (the
 * slow path, #114), Recall, Portrait, Profile, or embedding eligibility.
 */

export const FAST_PATH_EXTRACTION_POLICY_VERSION = "fast-path-extraction:v1";

/** P95 visibility target after Event commit (versioned parameter). */
export const FAST_PATH_VISIBILITY_TARGET_MS = 30_000;

/** Provider-economy batch bound; per-revision semantics are unaffected. */
export const FAST_PATH_MAX_BATCH_REVISIONS = 8;

/** Known-label context cap: bounds the memory.extract prompt size. */
export const FAST_PATH_MAX_KNOWN_LABELS = 200;

/** The single fixture-calibrated `entity.resolve` commit threshold (#97). */
export const ENTITY_RESOLVE_GATE_POLICY_VERSION = "entity-resolve-gate:v1";
export const ENTITY_RESOLVE_T_AUTO = 0.9;
export const ENTITY_RESOLVE_MAX_CANDIDATES = 3;

export const FAST_PATH_ITEM_CLASSES = Object.freeze([
  "person",
  "event",
  "preference",
  "emotion",
  "open",
] as const);

export type FastPathItemClass = (typeof FAST_PATH_ITEM_CLASSES)[number];

export type FastPathRunStatus =
  | "extracted"
  | "retryable_failed"
  | "stale_source"
  | "retired";

// ── Provider ports (in-process; scripted per revision in tests) ─────────────

export type MemoryExtractEvidenceSpanProposal = Readonly<{
  locatorKey: string;
  role: "factual_support" | "subjective_report";
}>;

export type MemoryExtractMentionProposal = Readonly<{
  surfaceForm: string;
  startOffset: number | null;
  endOffset: number | null;
  mentionKind: "first_person" | "named" | "pronoun";
  newIntroduction: boolean;
  entityKindId: string;
  evidenceLocatorKey: string | null;
}>;

export type MemoryExtractTemporalProposal = Readonly<{
  temporalStatus: "current" | "ended" | "unknown";
  validFrom: string | null;
  validFromPrecision: "exact" | "month" | "year" | "approximate" | "unknown";
  validTo: string | null;
  validToPrecision: "exact" | "month" | "year" | "approximate" | "unknown";
}>;

const MEMORY_EXTRACT_BOUNDARY_PRECISIONS = new Set<
  MemoryExtractTemporalProposal["validFromPrecision"]
>(["exact", "month", "year", "approximate", "unknown"]);

/**
 * Provider output is untrusted at the persistence boundary. Keep an invalid
 * temporal precision attached to its candidate, but coerce it to the only
 * value that preserves the memory-candidate CHECK constraint.
 */
export function normalizeMemoryExtractBoundaryPrecision(
  value: unknown,
): MemoryExtractTemporalProposal["validFromPrecision"] {
  return typeof value === "string" &&
    MEMORY_EXTRACT_BOUNDARY_PRECISIONS.has(
      value as MemoryExtractTemporalProposal["validFromPrecision"],
    )
    ? (value as MemoryExtractTemporalProposal["validFromPrecision"])
    : "unknown";
}

/**
 * One Relationship Qualifier assertion inside a candidate proposal (#115,
 * ADR-0033). `roleSide` is candidate-relative — deterministic admission
 * resolves it onto the canonical Claim side. The qualifier carries its own
 * evidence locators; a qualifier without evidence never admits.
 */
export type MemoryExtractQualifierProposal = Readonly<{
  axisId: string;
  roleSide: "subject" | "object";
  typedValue: string;
  evidenceLocatorKeys: readonly string[];
}>;

export type MemoryExtractCandidateProposal = Readonly<{
  basis: "directly_stated" | "inferred";
  candidateKind: "objective" | "impression";
  predicateId: string | null;
  proposedConcept: string | null;
  /** Relationship candidates carry "" — identity is the Entity pair; roles are qualifiers. */
  typedValue: string;
  scopeKey: string;
  subjectMentionIndex: number | null;
  objectMentionIndex: number | null;
  evidenceLocatorKeys: readonly string[];
  qualifiers: readonly MemoryExtractQualifierProposal[];
  temporal: MemoryExtractTemporalProposal;
  itemClass: string | null;
  itemSummary: string | null;
}>;

export type MemoryExtractClarificationProposal = Readonly<{
  mentionIndex: number;
  semanticImpact: "relationship_attribution" | "person_identity";
  questionText: string;
}>;

export type MemoryExtractRevisionResult = Readonly<{
  revisionId: string;
  evidence: readonly MemoryExtractEvidenceSpanProposal[];
  mentions: readonly MemoryExtractMentionProposal[];
  candidates: readonly MemoryExtractCandidateProposal[];
  clarifications: readonly MemoryExtractClarificationProposal[];
}>;

function normalizeMemoryExtractRevisionResult(
  result: MemoryExtractRevisionResult,
): MemoryExtractRevisionResult {
  return {
    ...result,
    candidates: result.candidates.map((candidate) => ({
      ...candidate,
      temporal: {
        ...candidate.temporal,
        validFromPrecision: normalizeMemoryExtractBoundaryPrecision(
          candidate.temporal.validFromPrecision,
        ),
        validToPrecision: normalizeMemoryExtractBoundaryPrecision(
          candidate.temporal.validToPrecision,
        ),
      },
    })),
  };
}

/** The configuration a Provider call dispatches under (champion or fallback). */
export type MemoryRoleInvocationConfiguration = Readonly<{
  configVersion: string;
  modelVersion: string;
  promptVersion: string;
}>;

export type MemoryExtractProvider = Readonly<{
  role: "memory.extract";
  extract(
    input: {
      /** The released predicate ids the provider may choose from (or null). */
      predicateIds?: readonly string[];
      /** The relationship subset — identity is the Entity pair, never a typed value. */
      relationshipPredicateIds?: readonly string[];
      /**
       * Per-predicate bilingual label + definition (issue #126 evidence
       * runs): the admission semantics the provider chooses predicateId
       * against — a bare id list left natural phrasing without a published
       * surface mis-mapped.
       */
      predicates?: readonly ReleasedPredicateMaterial[];
      /**
       * Normalized labels of the user's current entities (issue #126
       * evidence runs): the context the newIntroduction flag is decided
       * against, so a re-mention of a known name is not proposed as a
       * fresh introduction.
       */
      knownLabels?: readonly string[];
      revisions: readonly Readonly<{
        revisionId: string;
        sequenceNo: number;
        locale: string;
        text: string;
      }>[];
    },
    configuration: MemoryRoleInvocationConfiguration,
  ): Promise<readonly MemoryExtractRevisionResult[]>;
}>;

export type EntityResolveGateResponse = Readonly<{
  verdict: "match" | "no_match" | "unclear";
  entityId: string | null;
  confidence: number;
}>;

export type EntityResolveGateProvider = Readonly<{
  role: "entity.resolve";
  resolve(
    input: {
      surfaceForm: string;
      contextText: string;
      candidates: readonly Readonly<{
        entityId: string;
        matchedLabel: string;
        candidateKind: string;
      }>[];
    },
    configuration: MemoryRoleInvocationConfiguration,
  ): Promise<EntityResolveGateResponse>;
}>;

// ── Versioned role configuration (ADR-0060 fallback discipline) ─────────────

export type MemoryRoleConfiguration = Readonly<{
  role: "memory.extract" | "entity.resolve" | "memory.consolidate";
  configVersion: string;
  modelVersion: string;
  promptVersion: string;
  /**
   * Per-role explicit fallback. `single_attempt` allows at most one serial
   * `role_fallback` Provider attempt after the primary configuration fails;
   * there is never an implicit cross-role fallback, and a failed role fails
   * loudly instead of degrading into another model's behavior.
   */
  fallback:
    | Readonly<{ mode: "disabled" }>
    | Readonly<{
        mode: "single_attempt";
        configVersion: string;
        modelVersion: string;
        promptVersion: string;
      }>;
}>;

// ── Command / source snapshots ──────────────────────────────────────────────

export type FastPathBatchRevision = Readonly<{
  revisionId: string;
  conversationEventId: string;
  sequenceNo: number;
  locale: string;
  text: string;
  committedAt: Date;
  transcriptStatus: "final" | "corrected";
  isCorrection: boolean;
  supersedesRevisionId: string | null;
}>;

export type PriorCommittedClarification = Readonly<{
  proposalId: string;
  topicKey: string;
  status: "committed" | "resolved" | "dropped";
}>;

export type FastPathCommandContext = Readonly<{
  workflowCommandId: string;
  userId: string;
  dailySessionId: string;
  eventRevisionId: string;
  revisionOrdinal: number;
  extractionPolicyVersion: string;
  expectedDataEpoch: number;
  revision: FastPathBatchRevision;
  batch: readonly FastPathBatchRevision[];
  priorCommittedClarifications: readonly PriorCommittedClarification[];
}>;

// ── Gate planning (pure) ─────────────────────────────────────────────────────

export type GateNotCommittedReason =
  | "verdict_not_match"
  | "confidence_below_t_auto"
  | "selection_not_a_candidate"
  | "invalid_response";

export type GateCommitPlan = Readonly<{
  committed: boolean;
  boundEntityId: string | null;
  notCommittedReason: GateNotCommittedReason | null;
}>;

/**
 * The single `entity.resolve` commit rule (#97): commit only on
 * unique candidate ∧ verdict = match ∧ confidence ≥ t_auto. Any other
 * outcome fails closed — the mention stays unbound / ambiguous.
 */
export function planGateCommit(input: {
  tAuto: number;
  candidates: readonly Readonly<{ entityId: string }>[];
  response: EntityResolveGateResponse;
}): GateCommitPlan {
  const { response } = input;
  if (
    !["match", "no_match", "unclear"].includes(response.verdict) ||
    typeof response.confidence !== "number" ||
    !Number.isFinite(response.confidence) ||
    response.confidence < 0 ||
    response.confidence > 1 ||
    (response.entityId !== null && typeof response.entityId !== "string")
  ) {
    return {
      committed: false,
      boundEntityId: null,
      notCommittedReason: "invalid_response",
    };
  }
  if (response.verdict !== "match" || response.entityId === null) {
    return {
      committed: false,
      boundEntityId: null,
      notCommittedReason: "verdict_not_match",
    };
  }
  const candidateIds = new Set(input.candidates.map((candidate) => candidate.entityId));
  if (!candidateIds.has(response.entityId)) {
    return {
      committed: false,
      boundEntityId: null,
      notCommittedReason: "selection_not_a_candidate",
    };
  }
  if (response.confidence < input.tAuto) {
    return {
      committed: false,
      boundEntityId: null,
      notCommittedReason: "confidence_below_t_auto",
    };
  }
  return {
    committed: true,
    boundEntityId: response.entityId,
    notCommittedReason: null,
  };
}

/**
 * Select the mentions the gate may be called for: only bounded ambiguity that
 * survived the deterministic lanes (multi-exact or near-form candidates),
 * within the versioned candidate bound. Everything else never reaches the
 * Provider.
 */
export function selectGateMentions(
  resolutions: readonly Readonly<{
    resolutionStatus: string;
    candidates: readonly Readonly<{ entityId: string }>[];
  }>[],
  maxCandidates: number,
): readonly number[] {
  const selected: number[] = [];
  for (let index = 0; index < resolutions.length; index += 1) {
    const resolution = resolutions[index]!;
    if (
      resolution.resolutionStatus !== "ambiguous" &&
      resolution.resolutionStatus !== "unresolved"
    ) {
      continue;
    }
    if (resolution.candidates.length < 1) continue;
    if (resolution.candidates.length > maxCandidates) continue;
    selected.push(index);
  }
  return selected;
}

// ── Item class marking and light dedupe (pure) ──────────────────────────────

export function validateItemClass(proposed: string | null): FastPathItemClass {
  return FAST_PATH_ITEM_CLASSES.includes(proposed as FastPathItemClass)
    ? (proposed as FastPathItemClass)
    : "open";
}

export function itemDedupeKey(input: {
  itemClass: FastPathItemClass;
  semanticKey: string;
}): string {
  return `${input.itemClass}|${input.semanticKey
    .trim()
    .toLocaleLowerCase("en-US")
    .normalize("NFKC")}`;
}

// ── Clarification deterministic gate (ADR-0024, pure) ───────────────────────

export type ClarificationCommitEvaluation = Readonly<{
  commit: boolean;
  reasonCode:
    | "committed"
    | "mention_not_ambiguous"
    | "not_person_kind"
    | "invalid_proposal";
}>;

/**
 * The model may propose a clarification; deterministic code decides whether it
 * commits. v1 triggers only on semantic impact: an ambiguous person mention
 * (identity misattribution corrupts relationships and future Memory, ADR-0024).
 * One committed proposal per (session, topic); the topic key is the mention's
 * normalized surface form, so later disengagement evaluation stays
 * deterministic.
 */
export function planClarificationCommit(input: {
  proposal: MemoryExtractClarificationProposal;
  mentionKindIsPerson: boolean;
  mentionIsAmbiguous: boolean;
}): ClarificationCommitEvaluation {
  const { proposal } = input;
  if (
    !Number.isInteger(proposal.mentionIndex) ||
    proposal.mentionIndex < 0 ||
    !["relationship_attribution", "person_identity"].includes(
      proposal.semanticImpact,
    ) ||
    typeof proposal.questionText !== "string" ||
    proposal.questionText.trim().length === 0 ||
    proposal.questionText.length > 500
  ) {
    return { commit: false, reasonCode: "invalid_proposal" };
  }
  if (!input.mentionIsAmbiguous) {
    return { commit: false, reasonCode: "mention_not_ambiguous" };
  }
  if (!input.mentionKindIsPerson) {
    return { commit: false, reasonCode: "not_person_kind" };
  }
  return { commit: true, reasonCode: "committed" };
}

export type PriorClarificationDisposition = "keep" | "resolved" | "dropped";

/**
 * Topic-scoped stop signal for a prior committed clarification, evaluated
 * deterministically against the next extracted revision: a same-surface bind
 * resolves it; re-mentioning the surface keeps it available; anything else is
 * disengagement and drops it for the rest of the topic. It never escalates to
 * the conversation-level question-stop — this projection is separate state.
 */
export function evaluatePriorClarification(input: {
  topicKey: string;
  currentRevisionText: string;
  currentRevisionBoundSurfaces: readonly string[];
}): PriorClarificationDisposition {
  if (
    input.currentRevisionBoundSurfaces.some(
      (surface) => normalizeEntityLabel(surface) === input.topicKey,
    )
  ) {
    return "resolved";
  }
  return normalizeEntityLabel(input.currentRevisionText).includes(input.topicKey)
    ? "keep"
    : "dropped";
}

// ── memory.extract proposal validation (pure) ───────────────────────────────

export class InvalidMemoryExtractProposalError extends Error {
  public constructor(detail: string) {
    super(`memory.extract returned an invalid proposal: ${detail}`);
    this.name = "InvalidMemoryExtractProposalError";
  }
}

function parseLocatorKey(
  locatorKey: string,
  text: string,
): { start: number; end: number } {
  const match = /^(\d+):(\d+)$/.exec(locatorKey);
  if (!match) {
    throw new InvalidMemoryExtractProposalError(
      `evidence locator key ${locatorKey} is not start:end.`,
    );
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start >= end || end > text.length || !text.slice(start, end).trim()) {
    throw new InvalidMemoryExtractProposalError(
      `evidence locator key ${locatorKey} is out of range.`,
    );
  }
  return { start, end };
}

/**
 * Validate one revision's proposal against its real source text. Throws
 * `InvalidMemoryExtractProposalError` on structural violations; unknown
 * predicates are not errors — they route to `needs_predicate_review`.
 * Relationship candidates (#115) must carry an empty typed value — identity is
 * the canonical Entity pair and roles ride as qualifiers — and unmapped
 * proposals (#147) may carry an empty typed value when they provide a
 * proposed concept; non-empty values are required elsewhere.
 * `isRelationshipPredicate` decides which relationship rule applies.
 */
export function validateMemoryExtractResult(
  result: MemoryExtractRevisionResult,
  source: Readonly<{ revisionId: string; text: string }>,
  options: Readonly<{
    isRelationshipPredicate?: (predicateId: string) => boolean;
  }> = {},
): void {
  if (result.revisionId !== source.revisionId) {
    throw new InvalidMemoryExtractProposalError(
      "result revisionId does not match the batch revision.",
    );
  }
  const evidenceKeys = new Set<string>();
  for (const span of result.evidence) {
    if (!["factual_support", "subjective_report"].includes(span.role)) {
      throw new InvalidMemoryExtractProposalError("invalid evidence role.");
    }
    parseLocatorKey(span.locatorKey, source.text);
    evidenceKeys.add(span.locatorKey);
  }
  if (result.evidence.length === 0 && result.candidates.length > 0) {
    throw new InvalidMemoryExtractProposalError(
      "candidates require at least one evidence span.",
    );
  }
  for (const mention of result.mentions) {
    if (!mention.surfaceForm.trim() || mention.surfaceForm.length > 500) {
      throw new InvalidMemoryExtractProposalError("invalid mention surface.");
    }
    if (!["first_person", "named", "pronoun"].includes(mention.mentionKind)) {
      throw new InvalidMemoryExtractProposalError("invalid mention kind.");
    }
    if (
      mention.startOffset !== null &&
      mention.endOffset !== null &&
      (mention.startOffset < 0 ||
        mention.endOffset < mention.startOffset ||
        mention.endOffset > source.text.length)
    ) {
      throw new InvalidMemoryExtractProposalError(
        "mention offsets out of range.",
      );
    }
    if (
      (mention.startOffset === null) !== (mention.endOffset === null)
    ) {
      throw new InvalidMemoryExtractProposalError(
        "mention offsets must be both present or both null.",
      );
    }
    if (mention.newIntroduction && mention.mentionKind !== "named") {
      throw new InvalidMemoryExtractProposalError(
        "newIntroduction is only valid for named mentions.",
      );
    }
    if (
      mention.evidenceLocatorKey !== null &&
      !evidenceKeys.has(mention.evidenceLocatorKey)
    ) {
      throw new InvalidMemoryExtractProposalError(
        "mention cites an unknown evidence locator.",
      );
    }
  }
  for (const candidate of result.candidates) {
    if (!["directly_stated", "inferred"].includes(candidate.basis)) {
      throw new InvalidMemoryExtractProposalError("invalid candidate basis.");
    }
    if (!["objective", "impression"].includes(candidate.candidateKind)) {
      throw new InvalidMemoryExtractProposalError("invalid candidate kind.");
    }
    if (candidate.evidenceLocatorKeys.length === 0) {
      throw new InvalidMemoryExtractProposalError(
        "candidate requires at least one evidence locator.",
      );
    }
    for (const key of candidate.evidenceLocatorKeys) {
      if (!evidenceKeys.has(key)) {
        throw new InvalidMemoryExtractProposalError(
          "candidate cites an unknown evidence locator.",
        );
      }
    }
    if (
      candidate.subjectMentionIndex !== null &&
      (candidate.subjectMentionIndex < 0 ||
        candidate.subjectMentionIndex >= result.mentions.length)
    ) {
      throw new InvalidMemoryExtractProposalError(
        "candidate subjectMentionIndex out of range.",
      );
    }
    if (
      candidate.objectMentionIndex !== null &&
      (candidate.objectMentionIndex < 0 ||
        candidate.objectMentionIndex >= result.mentions.length)
    ) {
      throw new InvalidMemoryExtractProposalError(
        "candidate objectMentionIndex out of range.",
      );
    }
    const isRelationship =
      candidate.predicateId !== null &&
      (options.isRelationshipPredicate?.(candidate.predicateId) ?? false);
    const hasUnmappedProposal =
      candidate.predicateId === null &&
      typeof candidate.proposedConcept === "string" &&
      candidate.proposedConcept.trim() !== "";
    const trimmedTypedValue =
      typeof candidate.typedValue === "string" ? candidate.typedValue.trim() : "";
    if (isRelationship && trimmedTypedValue !== "") {
      // Relationship identity is the Entity pair; roles ride as qualifiers.
      throw new InvalidMemoryExtractProposalError(
        "relationship candidates carry roles as qualifiers, not typed values.",
      );
    }
    if (!isRelationship && !hasUnmappedProposal && trimmedTypedValue === "") {
      throw new InvalidMemoryExtractProposalError("candidate typedValue empty.");
    }
    if (candidate.typedValue.length > 2_000) {
      throw new InvalidMemoryExtractProposalError(
        "candidate typedValue too long.",
      );
    }
    if (candidate.scopeKey.length > 200) {
      throw new InvalidMemoryExtractProposalError("candidate scopeKey too long.");
    }
    const qualifierAxisSides = new Set<string>();
    for (const qualifier of candidate.qualifiers) {
      if (typeof qualifier.axisId !== "string" || !qualifier.axisId.trim()) {
        throw new InvalidMemoryExtractProposalError("qualifier axisId empty.");
      }
      if (qualifier.axisId.length > 200) {
        throw new InvalidMemoryExtractProposalError("qualifier axisId too long.");
      }
      if (!["subject", "object"].includes(qualifier.roleSide)) {
        throw new InvalidMemoryExtractProposalError("invalid qualifier roleSide.");
      }
      if (
        typeof qualifier.typedValue !== "string" ||
        !qualifier.typedValue.trim() ||
        qualifier.typedValue.length > 2_000
      ) {
        throw new InvalidMemoryExtractProposalError(
          "invalid qualifier typedValue.",
        );
      }
      if (qualifier.evidenceLocatorKeys.length === 0) {
        throw new InvalidMemoryExtractProposalError(
          "qualifier requires at least one evidence locator.",
        );
      }
      for (const key of qualifier.evidenceLocatorKeys) {
        if (!evidenceKeys.has(key)) {
          throw new InvalidMemoryExtractProposalError(
            "qualifier cites an unknown evidence locator.",
          );
        }
      }
      const sideKey = `${qualifier.axisId}\u0000${qualifier.roleSide}`;
      if (qualifierAxisSides.has(sideKey)) {
        throw new InvalidMemoryExtractProposalError(
          "duplicate qualifier axis and side in one candidate.",
        );
      }
      qualifierAxisSides.add(sideKey);
    }
  }
  for (const clarification of result.clarifications) {
    if (
      !Number.isInteger(clarification.mentionIndex) ||
      clarification.mentionIndex < 0 ||
      clarification.mentionIndex >= result.mentions.length
    ) {
      throw new InvalidMemoryExtractProposalError(
        "clarification mentionIndex out of range.",
      );
    }
    if (
      !["relationship_attribution", "person_identity"].includes(
        clarification.semanticImpact,
      )
    ) {
      throw new InvalidMemoryExtractProposalError(
        "invalid clarification semantic impact.",
      );
    }
    if (
      typeof clarification.questionText !== "string" ||
      !clarification.questionText.trim() ||
      clarification.questionText.length > 500
    ) {
      throw new InvalidMemoryExtractProposalError(
        "invalid clarification question.",
      );
    }
  }
}

// ── Repository port ─────────────────────────────────────────────────────────

export type CommittedCandidateWrite = Readonly<{
  proposal: MemoryCandidateProposal;
  status: "proposed" | "needs_predicate_review";
  reviewDueAt: Date | null;
  itemClass: FastPathItemClass;
  itemSummary: string;
  dedupeKey: string;
  /** Keyed ADR-0046 terminal fence over (user, semantic target, evidence). */
  dedupeFingerprint: string;
  semanticKey: string;
}>;

export type CommittedItemWrite = Readonly<{
  itemClass: FastPathItemClass;
  summary: string;
  dedupeKey: string;
  candidateIndex: number | null;
  mentionProposalIndex: number | null;
  evidenceLocatorKeys: readonly string[];
}>;

export type CommittedClarificationWrite = Readonly<{
  mentionProposalIndex: number;
  topicKey: string;
  semanticImpact: "relationship_attribution" | "person_identity";
  questionText: string;
}>;

export type PriorClarificationDispositionWrite = Readonly<{
  proposalId: string;
  disposition: PriorClarificationDisposition;
}>;

export type FastPathSessionLocalContext = Readonly<{
  items: readonly Readonly<{
    itemClass: FastPathItemClass;
    summary: string;
    evidenceItemIds: readonly string[];
  }>[];
  /** Committed, not-yet-asked Entity Clarifications (ADR-0024 seam). */
  openClarifications: readonly Readonly<{
    questionText: string;
    topicKey: string;
    semanticImpact: "relationship_attribution" | "person_identity";
  }>[];
  pendingRevisionCount: number;
}>;

export type FastPathExtractionRepository = Readonly<{
  /**
   * Read the frozen command: the subject revision (validity-fenced), the
   * session's bounded pending batch, and prior committed clarifications.
   * Returns the existing run status for idempotent replay short-circuits.
   */
  readCommand(input: {
    workflowCommandId: string;
    policyVersion: string;
    maxBatchRevisions: number;
  }): Promise<
    | Readonly<{ outcome: "not_found" }>
    | Readonly<{ outcome: "stale_source" }>
    | Readonly<{
        outcome: "ready";
        command: FastPathCommandContext;
        existingRunStatus: FastPathRunStatus | null;
      }>
  >;
  /**
   * Create / reuse the per-revision EvidenceItems for the proposed locators.
   * Idempotent on (revision, locator, policy); returns the evidence item id
   * per locator key for mention and candidate references.
   */
  ensureRevisionEvidence(input: {
    userId: string;
    dailySessionId: string;
    revision: FastPathBatchRevision;
    evidence: readonly MemoryExtractEvidenceSpanProposal[];
    extractionPolicyVersion: string;
    expectedDataEpoch: number;
    lineage: Readonly<{
      commandId: string;
      attemptId: string;
      championConfigVersion: string;
      championProvider: string;
      championModel: string;
      championSnapshot: string;
      championProviderPolicyVersion: string;
    }>;
    now: Date;
  }): Promise<ReadonlyMap<string, string>>;
  /**
   * The authoritative per-revision commit: memory candidates (through the
   * shared terminal-fenced writer), session-local items, clarification
   * commits and dispositions, and the run row that anchors idempotency —
   * one transaction behind the epoch / currency fences.
   */
  commitRevisionExtraction(input: {
    command: Readonly<{
      workflowCommandId: string;
      userId: string;
      dailySessionId: string;
      expectedDataEpoch: number;
      extractionPolicyVersion: string;
    }>;
    revision: FastPathBatchRevision;
    visibilityTargetMs: number;
    evidenceItemIdsByLocatorKey: ReadonlyMap<string, string>;
    mentionIdsByProposalIndex: ReadonlyMap<number, string>;
    candidates: readonly CommittedCandidateWrite[];
    items: readonly CommittedItemWrite[];
    clarifications: readonly CommittedClarificationWrite[];
    priorClarificationDispositions: readonly PriorClarificationDispositionWrite[];
    selfEntityId: string;
    lineage: Readonly<{
      modelAttemptId: string;
      memoryExtractConfigVersion: string;
      memoryExtractModelVersion: string;
      memoryExtractPromptVersion: string;
      entityResolveConfigVersion: string | null;
      roleFallbackUsed: boolean;
    }>;
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "committed"; candidateIds: readonly string[] }>
    | Readonly<{ outcome: "already_extracted" }>
    | Readonly<{ outcome: "stale_source" }>
  >;
  recordRunFailure(input: {
    command: Readonly<{
      workflowCommandId: string;
      userId: string;
      dailySessionId: string;
      eventRevisionId: string;
      expectedDataEpoch: number;
      extractionPolicyVersion: string;
      eventCommittedAt: Date;
    }>;
    lineage: Readonly<{
      modelAttemptId: string;
      memoryExtractConfigVersion: string;
      memoryExtractModelVersion: string;
      memoryExtractPromptVersion: string;
      entityResolveConfigVersion: string | null;
      roleFallbackUsed: boolean;
    }>;
    errorCode: string;
    now: Date;
  }): Promise<void>;
  /**
   * Same-day session-local read: items whose event revision is still the
   * event's current revision and not retired, plus the pending count that
   * drives the `fast_path_pending` degraded reason against the versioned
   * visibility target.
   */
  readSessionLocalContext(input: {
    dailySessionId: string;
  }): Promise<FastPathSessionLocalContext>;
}>;


// ── Entrypoint ──────────────────────────────────────────────────────────────

export type FastPathExtractionEntrypointResult = Readonly<{
  outcome: "extracted" | "already_extracted" | "stale_source" | "retryable_failed";
  workflowReceiptId: string;
}>;

export type FastPathExtractionEntrypointDependencies = Readonly<{
  clock: () => Date;
  repository: FastPathExtractionRepository;
  entityService: EntityService;
  entityRepository: Readonly<{
    /** Known-label context for the extract request (see MemoryExtractProvider). */
    loadCurrentLabelIndex(
      userId: string,
    ): Promise<readonly EntityLabelIndexEntry[]>;
    applyEntityResolveGateOutcome(input: {
      userId: string;
      mentionId: string;
      selectedEntityId: string | null;
      verdict: "match" | "no_match" | "unclear";
      confidence: number;
      tAuto: number;
      candidateEntityIds: readonly string[];
      gatePolicyVersion: string;
      resolverPolicyVersion: string;
      expectedDataEpoch: number;
      now: Date;
    }): Promise<Readonly<{ applied: boolean; boundEntityId: string | null }>>;
  }>;
  memoryExtract: MemoryExtractProvider;
  entityResolve: EntityResolveGateProvider;
  registry: RegistryEntryLookup;
  policy: Readonly<{
    version: string;
    visibilityTargetMs: number;
    maxBatchRevisions: number;
    tAuto: number;
    maxCandidates: number;
  }>;
  memoryExtractConfiguration: MemoryRoleConfiguration;
  entityResolveConfiguration: MemoryRoleConfiguration;
  evidenceChampion: Readonly<{
    provider: string;
    model: string;
    configVersion: string;
    snapshot: string;
    providerPolicyVersion: string;
  }>;
  dedupeFingerprintSecret: string;
  workflowReceiptId: string;
}>;

function sanitizeFastPathErrorCode(error: unknown): string {
  if (error instanceof InvalidMemoryExtractProposalError) {
    return "memory_extract_invalid_proposal";
  }
  return classifyMemoryRoleError(error);
}

/**
 * Shared transport-level classifier for memory-role failures (fast path and
 * consolidation): one allowlisted error-code vocabulary for run rows.
 */
export function classifyMemoryRoleError(error: unknown): string {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);
  if (message.includes("timeout") || message.includes("timed out")) {
    return "provider_timeout";
  }
  if (message.includes("429") || message.includes("rate")) {
    return "provider_rate_limited";
  }
  if (/\b5\d\d\b/.test(message)) return "provider_server_error";
  if (message.includes("network") || message.includes("econn")) {
    return "network_error";
  }
  return "unknown_error";
}

/**
 * Run one fast-path extraction command through the real pipeline: read the
 * frozen source, batch the session's pending revisions, make one
 * `memory.extract` call, resolve deterministically then gate, and commit per
 * revision. Directly callable (system tests) and wrapped by the durable
 * workflow directive step. Idempotent: an extracted revision never re-writes.
 */
export async function runFastPathExtraction(input: {
  dependencies: FastPathExtractionEntrypointDependencies;
  command: Readonly<{
    workflowCommandId: string;
    policyVersion: string;
  }>;
}): Promise<FastPathExtractionEntrypointResult> {
  const { dependencies } = input;
  asWorkflowCommandId(input.command.workflowCommandId);
  assertWorkflowSafe(
    {
      workflowCommandId: input.command.workflowCommandId,
      subjectType: "conversation_event_revision",
      policyVersion: input.command.policyVersion,
    },
    "command",
  );
  if (input.command.policyVersion !== dependencies.policy.version) {
    throw new Error(
      "Fast path extraction command policy does not match runtime policy.",
    );
  }

  const read = await dependencies.repository.readCommand({
    workflowCommandId: input.command.workflowCommandId,
    policyVersion: dependencies.policy.version,
    maxBatchRevisions: dependencies.policy.maxBatchRevisions,
  });
  if (read.outcome === "not_found") {
    throw new Error("Fast path extraction command could not be found.");
  }
  if (read.outcome === "stale_source") {
    // The revision is superseded, purged, or no longer current: the command
    // deterministically converges without writing anything.
    return {
      outcome: "stale_source",
      workflowReceiptId: dependencies.workflowReceiptId,
    };
  }
  if (read.existingRunStatus === "extracted") {
    return {
      outcome: "already_extracted",
      workflowReceiptId: dependencies.workflowReceiptId,
    };
  }
  if (read.existingRunStatus === "stale_source") {
    return {
      outcome: "stale_source",
      workflowReceiptId: dependencies.workflowReceiptId,
    };
  }
  const command = read.command;

  const lineage = {
    modelAttemptId: `${command.workflowCommandId}:memory-extract`,
    memoryExtractConfigVersion: dependencies.memoryExtractConfiguration.configVersion,
    memoryExtractModelVersion: dependencies.memoryExtractConfiguration.modelVersion,
    memoryExtractPromptVersion: dependencies.memoryExtractConfiguration.promptVersion,
    entityResolveConfigVersion: dependencies.entityResolveConfiguration.configVersion,
    roleFallbackUsed: false,
  };

  // One memory.extract call over the session's pending revisions (Provider
  // economy); everything below validates and commits per revision.
  const batch = command.batch;
  // Known-label context (issue #126 evidence runs): the provider sees each
  // revision in isolation, so without the label set it proposed every named
  // mention as a fresh introduction and the deterministic exact-match
  // binding lane never fired — re-mentions forked duplicate entities and
  // relationship claims stayed unadmitted. Capped to bound prompt size.
  const labelIndex = await dependencies.entityRepository.loadCurrentLabelIndex(
    command.userId,
  );
  const knownLabels = [
    ...new Set(
      labelIndex.flatMap((entry) => [entry.normalizedLabel, entry.label]),
    ),
  ]
    .filter((label) => label.trim() !== "")
    .sort((a, b) => a.localeCompare(b, "en"))
    .slice(0, FAST_PATH_MAX_KNOWN_LABELS);
  let extractResults: readonly MemoryExtractRevisionResult[];
  let roleFallbackUsed = false;
  try {
    const attempted = await callWithRoleFallback(
      (invocation) =>
        dependencies.memoryExtract.extract(
          {
            predicateIds: RELEASED_PREDICATE_IDS,
            relationshipPredicateIds: RELEASED_RELATIONSHIP_PREDICATE_IDS,
            predicates: RELEASED_PREDICATE_MATERIAL,
            knownLabels,
            revisions: batch.map((revision) => ({
              revisionId: revision.revisionId,
              sequenceNo: revision.sequenceNo,
              locale: revision.locale,
              text: revision.text,
            })),
          },
          invocation,
        ),
      dependencies.memoryExtractConfiguration,
    );
    // Provider output is normalized again at the application boundary before
    // validation and candidate writes. This protects scripted/custom ports as
    // well as the AI registry from values that violate the database enum CHECK.
    extractResults = attempted.result.map(normalizeMemoryExtractRevisionResult);
    roleFallbackUsed = attempted.roleFallbackUsed;
  } catch (error) {
    await recordFailure(dependencies, command, lineage, error);
    return {
      outcome: "retryable_failed",
      workflowReceiptId: dependencies.workflowReceiptId,
    };
  }
  const resultsByRevision = new Map(
    extractResults.map((result) => [result.revisionId, result]),
  );
  lineage.roleFallbackUsed = roleFallbackUsed;

  for (const revision of batch) {
    const result = resultsByRevision.get(revision.revisionId);
    if (!result) {
      // A revision the model skipped fails the whole command — a partial
      // batch must not silently drop committed Events.
      await recordFailure(
        dependencies,
        command,
        lineage,
        new Error("memory extract missing revision"),
      );
      return {
        outcome: "retryable_failed",
        workflowReceiptId: dependencies.workflowReceiptId,
      };
    }
    const outcome = await extractOneRevision({
      dependencies,
      command,
      revision,
      result,
      lineage: { ...lineage },
    });
    if (outcome === "retryable_failed") {
      return {
        outcome: "retryable_failed",
        workflowReceiptId: dependencies.workflowReceiptId,
      };
    }
  }

  const result: FastPathExtractionEntrypointResult = {
    outcome: "extracted",
    workflowReceiptId: dependencies.workflowReceiptId,
  };
  assertWorkflowSafe(
    {
      outcome: result.outcome,
      status: result.outcome,
      workflowReceiptId: result.workflowReceiptId,
    },
    "result",
  );
  return result;
}

async function recordFailure(
  dependencies: FastPathExtractionEntrypointDependencies,
  command: FastPathCommandContext,
  lineage: CommitLineage,
  error: unknown,
): Promise<void> {
  await dependencies.repository.recordRunFailure({
    command: {
      workflowCommandId: command.workflowCommandId,
      userId: command.userId,
      dailySessionId: command.dailySessionId,
      eventRevisionId: command.revision.revisionId,
      expectedDataEpoch: command.expectedDataEpoch,
      extractionPolicyVersion: command.extractionPolicyVersion,
      eventCommittedAt: command.revision.committedAt,
    },
    lineage,
    errorCode: sanitizeFastPathErrorCode(error),
    now: dependencies.clock(),
  });
}

type CommitLineage = Parameters<
  FastPathExtractionRepository["commitRevisionExtraction"]
>[0]["lineage"];
export type { CommitLineage };

/**
 * ADR-0060 per-role fallback: at most one serial `role_fallback` attempt,
 * dispatched under the role's explicitly configured fallback configuration;
 * a disabled fallback rethrows the primary error so the role fails loudly.
 * There is never an implicit cross-role fallback.
 */
export async function callWithRoleFallback<T>(
  call: (invocation: MemoryRoleInvocationConfiguration) => Promise<T>,
  configuration: MemoryRoleConfiguration,
): Promise<Readonly<{ result: T; roleFallbackUsed: boolean }>> {
  const primary = {
    configVersion: configuration.configVersion,
    modelVersion: configuration.modelVersion,
    promptVersion: configuration.promptVersion,
  };
  try {
    return { result: await call(primary), roleFallbackUsed: false };
  } catch (primaryError) {
    if (configuration.fallback.mode === "disabled") {
      throw primaryError;
    }
    const result = await call({
      configVersion: configuration.fallback.configVersion,
      modelVersion: configuration.fallback.modelVersion,
      promptVersion: configuration.fallback.promptVersion,
    });
    return { result, roleFallbackUsed: true };
  }
}

async function extractOneRevision(input: {
  dependencies: FastPathExtractionEntrypointDependencies;
  command: FastPathCommandContext;
  revision: FastPathBatchRevision;
  result: MemoryExtractRevisionResult;
  lineage: CommitLineage;
}): Promise<
  "committed" | "already_extracted" | "stale_source" | "retryable_failed"
> {
  const { dependencies, command, revision, result } = input;
  const { repository, entityService, entityRepository, registry } = dependencies;
  // A mutable copy: gate fallback usage is folded into the committed lineage.
  const lineage: {
    modelAttemptId: string;
    memoryExtractConfigVersion: string;
    memoryExtractModelVersion: string;
    memoryExtractPromptVersion: string;
    entityResolveConfigVersion: string | null;
    roleFallbackUsed: boolean;
  } = { ...input.lineage };
  try {
    validateMemoryExtractResult(
      result,
      {
        revisionId: revision.revisionId,
        text: revision.text,
      },
      {
        isRelationshipPredicate: (predicateId) =>
          dependencies.registry.entryFor(predicateId)?.relationshipSemantics != null,
      },
    );
  } catch (error) {
    await recordFailure(dependencies, command, lineage, error);
    return "retryable_failed";
  }

  // Evidence first so mentions and candidates can cite real items.
  const evidenceItemIdsByLocatorKey = await repository.ensureRevisionEvidence({
    userId: command.userId,
    dailySessionId: command.dailySessionId,
    revision,
    evidence: result.evidence,
    extractionPolicyVersion: command.extractionPolicyVersion,
    expectedDataEpoch: command.expectedDataEpoch,
    lineage: {
      commandId: command.workflowCommandId,
      attemptId: lineage.modelAttemptId,
      championConfigVersion: dependencies.evidenceChampion.configVersion,
      championProvider: dependencies.evidenceChampion.provider,
      championModel: dependencies.evidenceChampion.model,
      championSnapshot: dependencies.evidenceChampion.snapshot,
      championProviderPolicyVersion:
        dependencies.evidenceChampion.providerPolicyVersion,
    },
    now: dependencies.clock(),
  });

  // Phase A — deterministic user-scoped resolution (the #110 seam): Self
  // Entity, batch introductions, exact matches; near-forms become candidates
  // only. Mentions are written idempotently by the existing path.
  const mentionProposals: EntityMentionProposal[] = result.mentions.map(
    (mention) => ({
      surfaceForm: mention.surfaceForm,
      locatorType:
        mention.startOffset !== null && mention.endOffset !== null
          ? ("text_span" as const)
          : ("whole_revision" as const),
      startOffset: mention.startOffset,
      endOffset: mention.endOffset,
      mentionKind: mention.mentionKind,
      newIntroduction: mention.newIntroduction,
      entityKindId: mention.entityKindId as EntityMentionProposal["entityKindId"],
      evidenceId:
        mention.evidenceLocatorKey !== null
          ? evidenceItemIdsByLocatorKey.get(mention.evidenceLocatorKey) ?? null
          : null,
    }),
  );
  let resolutions: Awaited<ReturnType<EntityService["resolveMentions"]>>;
  try {
    resolutions = await entityService.resolveMentions({
      userId: command.userId,
      eventRevisionId: revision.revisionId,
      proposals: mentionProposals,
    });
  } catch (error) {
    await recordFailure(dependencies, command, lineage, error);
    return "retryable_failed";
  }

  // Phase B — the single entity.resolve gate, only on remaining bounded
  // ambiguity. Deterministic code commits (planGateCommit + repository).
  const gateBoundEntityIds = new Map<number, string>();
  const gateIndices = selectGateMentions(
    resolutions,
    dependencies.policy.maxCandidates,
  );
  for (const mentionIndex of gateIndices) {
    const resolution = resolutions[mentionIndex]!;
    let response;
    try {
      const attempted = await callWithRoleFallback(
        (invocation) =>
          dependencies.entityResolve.resolve(
            {
              surfaceForm: resolution.surfaceForm,
              contextText: revision.text.slice(0, 2_000),
              candidates: resolution.candidates.map((candidate) => ({
                entityId: candidate.entityId,
                matchedLabel: candidate.matchedLabel,
                candidateKind: candidate.candidateKind,
              })),
            },
            invocation,
          ),
        dependencies.entityResolveConfiguration,
      );
      response = attempted.result;
      lineage.roleFallbackUsed =
        lineage.roleFallbackUsed || attempted.roleFallbackUsed;
    } catch (error) {
      await recordFailure(dependencies, command, lineage, error);
      return "retryable_failed";
    }
    const plan = planGateCommit({
      tAuto: dependencies.policy.tAuto,
      candidates: resolution.candidates,
      response,
    });
    // The repository re-validates the RAW selection in-transaction
    // (deterministic code commits); passing the provider's own answer —
    // not the plan's sanitized binding — keeps the audit reason exact.
    const applied = await entityRepository.applyEntityResolveGateOutcome({
      userId: command.userId,
      mentionId: resolution.mentionId,
      selectedEntityId: response.entityId,
      verdict: response.verdict,
      confidence: response.confidence,
      tAuto: dependencies.policy.tAuto,
      candidateEntityIds: resolution.candidates.map(
        (candidate) => candidate.entityId,
      ),
      gatePolicyVersion: ENTITY_RESOLVE_GATE_POLICY_VERSION,
      resolverPolicyVersion: ENTITY_RESOLVER_POLICY_VERSION,
      expectedDataEpoch: command.expectedDataEpoch,
      now: dependencies.clock(),
    });
    if (plan.committed && applied.boundEntityId) {
      gateBoundEntityIds.set(mentionIndex, applied.boundEntityId);
    }
  }

  // Build the per-revision commit inputs from the post-resolution state.
  const mentionIdsByProposalIndex = new Map<number, string>();
  const boundEntityByMentionIndex = new Map<number, string>();
  resolutions.forEach((resolution, index) => {
    mentionIdsByProposalIndex.set(index, resolution.mentionId);
    if (resolution.entityId) {
      boundEntityByMentionIndex.set(index, resolution.entityId);
    }
  });
  for (const [mentionIndex, entityId] of gateBoundEntityIds) {
    boundEntityByMentionIndex.set(mentionIndex, entityId);
  }

  const self = await entityService.ensureSelfEntity({ userId: command.userId });
  const candidates: CommittedCandidateWrite[] = result.candidates.map(
    (candidate) => {
      const subjectEntityId =
        candidate.subjectMentionIndex !== null
          ? boundEntityByMentionIndex.get(candidate.subjectMentionIndex) ?? null
          : self.entityId;
      const objectEntityId =
        candidate.objectMentionIndex !== null
          ? boundEntityByMentionIndex.get(candidate.objectMentionIndex) ?? null
          : null;
      const entry =
        candidate.predicateId !== null
          ? registry.entryFor(candidate.predicateId)
          : null;
      const mapped = entry !== null && entry.status === "active";
      const itemClass = validateItemClass(candidate.itemClass);
      const semanticKey = mapped
        ? `${candidate.predicateId}|${candidate.typedValue}|${candidate.scopeKey}`
        : `concept|${candidate.proposedConcept ?? candidate.predicateId ?? candidate.typedValue}`;
      // Identical fingerprint semantics to MemoryClaimService.recordCandidate
      // (ADR-0046): one per-revision extraction cites exactly one Event
      // revision, so the evidence list is the revision itself.
      const fingerprint = dedupeFingerprint({
        secret: dependencies.dedupeFingerprintSecret,
        userId: asUserId(command.userId),
        semanticTarget: candidateSemanticTarget({
          resolutionStatus: mapped ? "mapped" : "unmapped",
          predicateId: mapped ? candidate.predicateId! : null,
          proposedConcept: mapped ? null : candidate.proposedConcept ?? candidate.predicateId ?? candidate.typedValue,
          proposedObjectValue: mapped ? candidate.typedValue : "",
          proposedScopeKey: candidate.scopeKey,
          subjectEntityId,
          objectEntityId,
        }),
        evidenceRevisionIds: [revision.revisionId],
        policyVersion: MEMORY_ADMISSION_POLICY_VERSION,
      });
      return {
        proposal: {
          userId: asUserId(command.userId),
          candidateKind: candidate.candidateKind,
          basis: candidate.basis,
          resolution: mapped
            ? {
                status: "mapped" as const,
                predicateId: candidate.predicateId!,
                registryVersion: registry.registryVersion(),
                typedValue: candidate.typedValue,
                mappingConfidence: null,
              }
            : {
                status: "unmapped" as const,
                proposedConcept:
                  candidate.proposedConcept ?? candidate.predicateId ?? candidate.typedValue,
              },
          subjectEntityId,
          subjectEntityMentionId:
            candidate.subjectMentionIndex !== null
              ? mentionIdsByProposalIndex.get(candidate.subjectMentionIndex) ?? null
              : null,
          objectEntityId,
          objectEntityMentionId:
            candidate.objectMentionIndex !== null
              ? mentionIdsByProposalIndex.get(candidate.objectMentionIndex) ?? null
              : null,
          scopeKey: candidate.scopeKey,
          temporal: {
            temporalStatus: candidate.temporal.temporalStatus,
            validFrom:
              candidate.temporal.validFrom !== null
                ? new Date(candidate.temporal.validFrom)
                : null,
            validFromPrecision: candidate.temporal.validFromPrecision,
            validTo:
              candidate.temporal.validTo !== null
                ? new Date(candidate.temporal.validTo)
                : null,
            validToPrecision: candidate.temporal.validToPrecision,
          },
          qualifiers: candidate.qualifiers.map((qualifier) => ({
            axisId: qualifier.axisId,
            roleSide: qualifier.roleSide,
            typedValue: qualifier.typedValue,
            evidenceItemIds: qualifier.evidenceLocatorKeys
              .map((key) => evidenceItemIdsByLocatorKey.get(key))
              .filter((value): value is string => value !== undefined),
          })),
          evidenceItemIds: candidate.evidenceLocatorKeys
            .map((key) => evidenceItemIdsByLocatorKey.get(key))
            .filter((value): value is string => value !== undefined),
          lineage: {
            extractionPolicyVersion: command.extractionPolicyVersion,
            generationCommandId: command.workflowCommandId,
            authoritativeModelAttemptId: lineage.modelAttemptId,
            modelVersion: lineage.memoryExtractModelVersion,
            promptVersion: lineage.memoryExtractPromptVersion,
            sourceReflectionVersionId: null,
          },
        },
        status: mapped ? ("proposed" as const) : ("needs_predicate_review" as const),
        reviewDueAt: mapped ? null : predicateReviewDeadline(dependencies.clock()),
        itemClass,
        itemSummary: (candidate.itemSummary ?? `${candidate.predicateId ?? "concept"}: ${candidate.typedValue}`)
          .slice(0, 200),
        dedupeKey: itemDedupeKey({ itemClass, semanticKey }),
        dedupeFingerprint: fingerprint,
        semanticKey,
      };
    },
  );

  const items: CommittedItemWrite[] = [
    ...candidates.map(
      (candidate, index): CommittedItemWrite => ({
        itemClass: candidate.itemClass,
        summary: candidate.itemSummary,
        dedupeKey: candidate.dedupeKey,
        candidateIndex: index,
        mentionProposalIndex: null,
        evidenceLocatorKeys: result.candidates[index]!.evidenceLocatorKeys,
      }),
    ),
    ...result.mentions
      .map((mention, index): CommittedItemWrite | null => {
        if (mention.mentionKind !== "named") return null;
        const bound = boundEntityByMentionIndex.has(index);
        const hasCandidate = result.candidates.some(
          (candidate) =>
            candidate.subjectMentionIndex === index ||
            candidate.objectMentionIndex === index,
        );
        if (bound || hasCandidate) return null;
        return {
          itemClass: "person",
          summary: `unresolved person mention: ${mention.surfaceForm}`.slice(0, 200),
          dedupeKey: itemDedupeKey({
            itemClass: "person",
            semanticKey: `mention|${normalizeEntityLabel(mention.surfaceForm)}`,
          }),
          candidateIndex: null,
          mentionProposalIndex: index,
          evidenceLocatorKeys:
            mention.evidenceLocatorKey !== null ? [mention.evidenceLocatorKey] : [],
        };
      })
      .filter((item): item is CommittedItemWrite => item !== null),
  ];

  // Clarifications: the model proposes; deterministic code commits, once per
  // (session, topic). Prior committed proposals are resolved / kept / dropped
  // by the deterministic topic-scoped stop evaluation against this revision.
  const existingTopicKeys = new Set(
    command.priorCommittedClarifications.map((prior) => prior.topicKey),
  );
  const clarifications: CommittedClarificationWrite[] = [];
  for (const proposal of result.clarifications) {
    const mention = result.mentions[proposal.mentionIndex];
    if (!mention) continue;
    // Semantic impact gate: only bounded person ambiguity (exactly the set the
    // entity.resolve gate saw) may trigger one clarification.
    const evaluation = planClarificationCommit({
      proposal,
      mentionKindIsPerson: mention.entityKindId === "sh.entity.person",
      mentionIsAmbiguous: gateIndices.includes(proposal.mentionIndex),
    });
    if (!evaluation.commit) continue;
    const topicKey = normalizeEntityLabel(mention.surfaceForm);
    if (existingTopicKeys.has(topicKey)) continue;
    existingTopicKeys.add(topicKey);
    clarifications.push({
      mentionProposalIndex: proposal.mentionIndex,
      topicKey,
      semanticImpact: proposal.semanticImpact,
      questionText: proposal.questionText.trim(),
    });
  }
  const priorClarificationDispositions: PriorClarificationDispositionWrite[] =
    command.priorCommittedClarifications
      .filter((prior) => prior.status === "committed")
      .map((prior) => ({
        proposalId: prior.proposalId,
        disposition: evaluatePriorClarification({
          topicKey: prior.topicKey,
          currentRevisionText: revision.text,
          currentRevisionBoundSurfaces: result.mentions
            .filter((_, index) => boundEntityByMentionIndex.has(index))
            .map((mention) => mention.surfaceForm),
        }),
      }))
      .filter((write) => write.disposition !== "keep");

  const commit = await repository.commitRevisionExtraction({
    command: {
      workflowCommandId: command.workflowCommandId,
      userId: command.userId,
      dailySessionId: command.dailySessionId,
      expectedDataEpoch: command.expectedDataEpoch,
      extractionPolicyVersion: command.extractionPolicyVersion,
    },
    revision,
    visibilityTargetMs: dependencies.policy.visibilityTargetMs,
    evidenceItemIdsByLocatorKey,
    mentionIdsByProposalIndex,
    candidates,
    items,
    clarifications,
    priorClarificationDispositions,
    selfEntityId: self.entityId,
    lineage: lineage,
    now: dependencies.clock(),
  });
  return commit.outcome;
}
