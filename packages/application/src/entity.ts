import { asEntityId, asEvidenceItemId, asUserId } from "@sayhear/domain";

/**
 * Entity domain foundation (SPEC #107 "Entity resolution (#97)", ADR-0088,
 * ADR-0028). This module owns the deterministic half of entity resolution: the
 * exact-match lane, the fuzzy-candidate lane that only produces diagnostics,
 * unresolved-Entity creation for named new introductions, and the single
 * idempotent Self Entity provisioning path shared by lazy-in-write and the
 * owner backoff. The `entity.resolve` LLM gate and Entity Clarification land
 * with the fast path (#113); merge / split / promotion land with #121.
 */

export const ENTITY_RESOLVER_POLICY_VERSION = "entity-resolution:v1";

export const ENTITY_KINDS = Object.freeze({
  person: "sh.entity.person",
  place: "sh.entity.place",
  project: "sh.entity.project",
} as const);

export const ENTITY_KIND_IDS: readonly string[] = Object.values(ENTITY_KINDS);

export type EntityKindId = (typeof ENTITY_KINDS)[keyof typeof ENTITY_KINDS];

export type EntityVersionStatus =
  | "active"
  | "merged"
  | "split"
  | "unresolved"
  | "deleted";

export type EntityLabelKind = "primary" | "alias";

export type EntityMentionKind = "first_person" | "named" | "pronoun";

export type EntityResolutionStatus = "resolved" | "unresolved" | "ambiguous";

export type EntityMentionOutcome =
  | "bound_self"
  | "bound"
  | "created_unresolved"
  | "unbound"
  | "ambiguous";

export type EntityMentionLocatorType = "whole_revision" | "text_span";

export type EntityMentionProposal = Readonly<{
  surfaceForm: string;
  locatorType: EntityMentionLocatorType;
  startOffset: number | null;
  endOffset: number | null;
  mentionKind: EntityMentionKind;
  newIntroduction: boolean;
  entityKindId: EntityKindId;
  evidenceId: string | null;
}>;

export type EntityMentionCandidateDiagnostic = Readonly<{
  entityId: string;
  matchedLabel: string;
  candidateKind: "near_form" | "multi_exact";
  editDistance: number | null;
}>;

export type EntityMentionResolution = Readonly<{
  mentionId: string;
  surfaceForm: string;
  outcome: EntityMentionOutcome;
  entityId: string | null;
  resolutionStatus: EntityResolutionStatus;
  alreadyRecorded: boolean;
  candidates: readonly EntityMentionCandidateDiagnostic[];
}>;

export type EntityLabelIndexEntry = Readonly<{
  entityId: string;
  label: string;
  normalizedLabel: string;
  labelKind: EntityLabelKind;
  locale: string;
}>;

export type EntityVersionRecord = Readonly<{
  id: string;
  revision: number;
  entityKindId: string;
  status: EntityVersionStatus;
  mergedIntoEntityId: string | null;
  supersedesVersionId: string | null;
  createdAt: Date;
}>;

export type EntityLabelRecord = Readonly<{
  id: string;
  locale: string;
  label: string;
  normalizedLabel: string;
  labelKind: EntityLabelKind;
  isCurrent: boolean;
  sourceEvidenceId: string | null;
  createdAt: Date;
}>;

export type EntityRecord = Readonly<{
  entityId: string;
  userId: string;
  createdAt: Date;
  deletedAt: Date | null;
  isSelf: boolean;
  versions: readonly EntityVersionRecord[];
  labels: readonly EntityLabelRecord[];
}>;

export class EntityNotFoundError extends Error {
  public constructor(userId: string, entityId: string) {
    super(`Entity ${entityId} does not exist for user ${userId}.`);
  }
}

export class EntityRevisionNotFoundError extends Error {
  public constructor(eventRevisionId: string) {
    super(
      `Conversation event revision ${eventRevisionId} does not exist for this user.`,
    );
  }
}

export class EntityEvidenceNotFoundError extends Error {
  public constructor(userId: string, evidenceId: string) {
    super(`Evidence item ${evidenceId} does not exist for user ${userId}.`);
  }
}

/** Architecture §7.7: a mention's evidence must cite the mentioned revision. */
export class EntityEvidenceRevisionMismatchError extends Error {
  public constructor(evidenceId: string, eventRevisionId: string) {
    super(
      `Evidence item ${evidenceId} does not reference revision ${eventRevisionId}; EntityMention evidence must bind to the mentioned revision.`,
    );
  }
}

/** Fail-closed outcome of Self Entity provisioning on an inconsistent binding. */
export class SelfEntityIntegrityError extends Error {
  public constructor(userId: string, detail: string) {
    super(
      `Self Entity binding for user ${userId} is inconsistent: ${detail}`,
    );
  }
}

export type SelfEntityBinding = Readonly<{
  entityId: string;
  entityVersionId: string;
  created: boolean;
}>;

export type EntityRepository = Readonly<{
  ensureSelfEntity(input: {
    userId: string;
    now: Date;
  }): Promise<SelfEntityBinding>;
  findSelfEntity(
    userId: string,
  ): Promise<Readonly<{ entityId: string; entityVersionId: string }> | null>;
  loadCurrentLabelIndex(userId: string): Promise<readonly EntityLabelIndexEntry[]>;
  resolveMentions(input: {
    userId: string;
    eventRevisionId: string;
    proposals: readonly EntityMentionProposal[];
    resolverPolicyVersion: string;
    now: Date;
  }): Promise<readonly EntityMentionResolution[]>;
  addVerifiedAlias(input: {
    userId: string;
    entityId: string;
    locale: string;
    label: string;
    normalizedLabel: string;
    evidenceId: string;
    now: Date;
  }): Promise<Readonly<{ labelId: string; created: boolean }>>;
  renamePrimaryLabel(input: {
    userId: string;
    entityId: string;
    locale: string;
    label: string;
    normalizedLabel: string;
    evidenceId: string | null;
    now: Date;
  }): Promise<Readonly<{ labelId: string; created: boolean }>>;
  inspectEntity(userId: string, entityId: string): Promise<EntityRecord | null>;
}>;

export type EntityService = Readonly<{
  /** The owner-backoff entry into the one shared provisioning path. */
  ensureSelfEntity(input: {
    userId: string;
  }): Promise<SelfEntityBinding>;
  findSelfEntity(
    userId: string,
  ): Promise<Readonly<{ entityId: string; entityVersionId: string }> | null>;
  resolveMentions(input: {
    userId: string;
    eventRevisionId: string;
    proposals: readonly EntityMentionProposal[];
  }): Promise<readonly EntityMentionResolution[]>;
  addVerifiedAlias(input: {
    userId: string;
    entityId: string;
    locale: string;
    label: string;
    evidenceId: string;
  }): Promise<Readonly<{ labelId: string; created: boolean }>>;
  renamePrimaryLabel(input: {
    userId: string;
    entityId: string;
    locale: string;
    label: string;
    evidenceId?: string | null;
  }): Promise<Readonly<{ labelId: string; created: boolean }>>;
  inspectEntity(
    userId: string,
    entityId: string,
  ): Promise<EntityRecord | null>;
}>;

export function createEntityService(dependencies: {
  repository: EntityRepository;
  clock: () => Date;
}): EntityService {
  const resolverPolicyVersion = ENTITY_RESOLVER_POLICY_VERSION;
  return {
    async ensureSelfEntity(input) {
      const userId = asUserId(input.userId);
      return dependencies.repository.ensureSelfEntity({
        userId,
        now: dependencies.clock(),
      });
    },
    findSelfEntity(userId) {
      return dependencies.repository.findSelfEntity(asUserId(userId));
    },
    async resolveMentions(input) {
      const userId = asUserId(input.userId);
      const eventRevisionId = input.eventRevisionId;
      if (!eventRevisionId) {
        throw new Error("eventRevisionId must be non-empty.");
      }
      validateMentionProposals(input.proposals);
      return dependencies.repository.resolveMentions({
        userId,
        eventRevisionId,
        proposals: input.proposals,
        resolverPolicyVersion,
        now: dependencies.clock(),
      });
    },
    async addVerifiedAlias(input) {
      const userId = asUserId(input.userId);
      const entityId = asEntityId(input.entityId);
      const locale = requireNonEmpty(input.locale, "locale");
      const label = requireNonEmpty(input.label, "label");
      const evidenceId = asEvidenceItemId(input.evidenceId);
      return dependencies.repository.addVerifiedAlias({
        userId,
        entityId,
        locale,
        label,
        normalizedLabel: normalizeEntityLabel(label),
        evidenceId,
        now: dependencies.clock(),
      });
    },
    async renamePrimaryLabel(input) {
      const userId = asUserId(input.userId);
      const entityId = asEntityId(input.entityId);
      const locale = requireNonEmpty(input.locale, "locale");
      const label = requireNonEmpty(input.label, "label");
      const evidenceId =
        input.evidenceId == null ? null : asEvidenceItemId(input.evidenceId);
      return dependencies.repository.renamePrimaryLabel({
        userId,
        entityId,
        locale,
        label,
        normalizedLabel: normalizeEntityLabel(label),
        evidenceId,
        now: dependencies.clock(),
      });
    },
    inspectEntity(userId, entityId) {
      return dependencies.repository.inspectEntity(
        asUserId(userId),
        asEntityId(entityId),
      );
    },
  };
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must be non-empty.`);
  }
  return trimmed;
}

export function validateMentionProposals(
  proposals: readonly EntityMentionProposal[],
): void {
  for (const proposal of proposals) {
    if (!proposal.surfaceForm.trim()) {
      throw new Error("surfaceForm must be non-empty.");
    }
    if (proposal.surfaceForm.length > 500) {
      throw new Error("surfaceForm must be at most 500 characters.");
    }
    if (proposal.locatorType === "whole_revision") {
      if (proposal.startOffset !== null || proposal.endOffset !== null) {
        throw new Error(
          "whole_revision mentions must not carry text offsets.",
        );
      }
    } else {
      if (
        proposal.startOffset === null ||
        proposal.endOffset === null ||
        !Number.isInteger(proposal.startOffset) ||
        !Number.isInteger(proposal.endOffset) ||
        proposal.startOffset < 0 ||
        proposal.endOffset < proposal.startOffset
      ) {
        throw new Error(
          "text_span mentions require integer offsets with 0 <= start <= end.",
        );
      }
    }
    if (!ENTITY_KIND_IDS.includes(proposal.entityKindId)) {
      throw new Error(
        `entityKindId must be one of ${ENTITY_KIND_IDS.join(", ")}.`,
      );
    }
    if (proposal.newIntroduction && proposal.mentionKind !== "named") {
      throw new Error(
        "newIntroduction is only valid for named mentions.",
      );
    }
    if (proposal.evidenceId != null) {
      asEvidenceItemId(proposal.evidenceId);
    }
  }
}

/**
 * Deterministic label normalization for the exact-match lane: NFKC folding
 * (full/half-width unification), whitespace collapsing, and en-US casing, so
 * "ＸＩＡＯＬＯＮＧ WANG", "Xiaolong wang", and "Xiaolong Wang" are one form.
 * Versioned with ENTITY_RESOLVER_POLICY_VERSION.
 */
export function normalizeEntityLabel(label: string): string {
  return label
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

/**
 * The deterministic resolution planner. Lane order is strict and fixed:
 * first-person → Self Entity; a named mention of a form introduced earlier in
 * the same batch → that new Entity; flagged new introduction → new unresolved
 * Entity (never reusing a same-named one); exact normalized match against
 * current primary labels and verified aliases → bind (unique) or ambiguous
 * (multi); fuzzy near-forms → candidates only, never a bind; pronouns and
 * unmatched names → unbound. Pure and side-effect free; the repository
 * executes the plan inside one transaction.
 */
export type MentionPlan = Readonly<{
  outcome: EntityMentionOutcome;
  entityId: string | null;
  createEntity: boolean;
  bindToBatchIndex: number | null;
  primaryLabel: Readonly<{
    locale: string;
    label: string;
    normalizedLabel: string;
  }> | null;
  entityKindId: EntityKindId | null;
  resolutionStatus: EntityResolutionStatus;
  candidates: readonly EntityMentionCandidateDiagnostic[];
}>;

export function planEntityMentionResolution(
  input: Readonly<{
    selfEntityId: string;
    locale: string;
    labels: readonly EntityLabelIndexEntry[];
  }>,
  proposals: readonly EntityMentionProposal[],
): readonly MentionPlan[] {
  const plans: MentionPlan[] = [];
  // Normalized form → batch index of the introduction that created (in this
  // batch) an Entity for that form; later same-form mentions bind to it.
  const introducedInBatch = new Map<string, number>();

  proposals.forEach((proposal, index) => {
    const normalizedForm = normalizeEntityLabel(proposal.surfaceForm);

    if (proposal.mentionKind === "first_person") {
      plans.push({
        outcome: "bound_self",
        entityId: input.selfEntityId,
        createEntity: false,
        bindToBatchIndex: null,
        primaryLabel: null,
        entityKindId: null,
        resolutionStatus: "resolved",
        candidates: [],
      });
      return;
    }

    if (proposal.mentionKind === "pronoun") {
      plans.push({
        outcome: "unbound",
        entityId: null,
        createEntity: false,
        bindToBatchIndex: null,
        primaryLabel: null,
        entityKindId: null,
        resolutionStatus: "unresolved",
        candidates: [],
      });
      return;
    }

    // A named mention of a form introduced earlier in this same batch binds
    // to that fresh Entity — batch-local context is the newest identity
    // signal, and it keeps re-mentions inside one revision deterministic.
    const batchIntroductionIndex = introducedInBatch.get(normalizedForm);
    if (batchIntroductionIndex !== undefined) {
      plans.push({
        outcome: "created_unresolved",
        entityId: null,
        createEntity: false,
        bindToBatchIndex: batchIntroductionIndex,
        primaryLabel: null,
        entityKindId: null,
        resolutionStatus: "resolved",
        candidates: [],
      });
      return;
    }

    if (proposal.newIntroduction) {
      introducedInBatch.set(normalizedForm, index);
      plans.push({
        outcome: "created_unresolved",
        entityId: null,
        createEntity: true,
        bindToBatchIndex: null,
        primaryLabel: {
          locale: input.locale,
          label: proposal.surfaceForm.trim(),
          normalizedLabel: normalizedForm,
        },
        entityKindId: proposal.entityKindId,
        resolutionStatus: "resolved",
        candidates: [],
      });
      return;
    }

    const exactMatches = input.labels.filter(
      (label) => label.normalizedLabel === normalizedForm,
    );
    if (exactMatches.length === 1) {
      plans.push({
        outcome: "bound",
        entityId: exactMatches[0]!.entityId,
        createEntity: false,
        bindToBatchIndex: null,
        primaryLabel: null,
        entityKindId: null,
        resolutionStatus: "resolved",
        candidates: [],
      });
      return;
    }
    if (exactMatches.length > 1) {
      plans.push({
        outcome: "ambiguous",
        entityId: null,
        createEntity: false,
        bindToBatchIndex: null,
        primaryLabel: null,
        entityKindId: null,
        resolutionStatus: "ambiguous",
        candidates: exactMatches.map(
          (label): EntityMentionCandidateDiagnostic => ({
            entityId: label.entityId,
            matchedLabel: label.label,
            candidateKind: "multi_exact",
            editDistance: null,
          }),
        ),
      });
      return;
    }

    plans.push({
      outcome: "unbound",
      entityId: null,
      createEntity: false,
      bindToBatchIndex: null,
      primaryLabel: null,
      entityKindId: null,
      resolutionStatus: "unresolved",
      candidates: nearFormCandidates(normalizedForm, input.labels),
    });
  });

  return plans;
}

/**
 * Fuzzy-candidate lane: near-forms become diagnostics only — never a bind,
 * never an Entity. v1 covers code-point edit distance and containment;
 * homophone folding (pinyin / traditional–simplified) joins with the fixture
 * calibration of the `entity.resolve` gate in #113, raising the policy
 * version when it lands. Thresholds: distance <= 2 when the shorter form has
 * at least 4 characters, else <= 1; containment requires a shorter side of at
 * least 2 characters. Exact equality never reaches here (the exact lane
 * owns it).
 */
function nearFormCandidates(
  normalizedForm: string,
  labels: readonly EntityLabelIndexEntry[],
): readonly EntityMentionCandidateDiagnostic[] {
  const byEntity = new Map<
    string,
    { matchedLabel: string; editDistance: number | null }
  >();
  for (const label of labels) {
    const diagnostic = nearFormDiagnostic(normalizedForm, label);
    if (!diagnostic) continue;
    const existing = byEntity.get(label.entityId);
    if (
      !existing ||
      diagnostic.editDistance === null ||
      (existing.editDistance !== null &&
        diagnostic.editDistance < existing.editDistance)
    ) {
      byEntity.set(label.entityId, diagnostic);
    }
  }
  return [...byEntity.entries()]
    .map(
      ([entityId, diagnostic]): EntityMentionCandidateDiagnostic => ({
        entityId,
        matchedLabel: diagnostic.matchedLabel,
        candidateKind: "near_form",
        editDistance: diagnostic.editDistance,
      }),
    )
    .sort(
      (a, b) =>
        (a.editDistance ?? -1) - (b.editDistance ?? -1) ||
        a.matchedLabel.localeCompare(b.matchedLabel) ||
        a.entityId.localeCompare(b.entityId),
    );
}

function nearFormDiagnostic(
  normalizedForm: string,
  label: EntityLabelIndexEntry,
): { matchedLabel: string; editDistance: number | null } | null {
  const [shorter, longer] =
    normalizedForm.length <= label.normalizedLabel.length
      ? [normalizedForm, label.normalizedLabel]
      : [label.normalizedLabel, normalizedForm];
  if (shorter.length >= 2 && longer.includes(shorter) && shorter !== longer) {
    return { matchedLabel: label.label, editDistance: null };
  }
  const threshold = shorter.length >= 4 ? 2 : 1;
  const distance = levenshteinEntityLabelDistance(
    normalizedForm,
    label.normalizedLabel,
  );
  if (distance > 0 && distance <= threshold) {
    return { matchedLabel: label.label, editDistance: distance };
  }
  return null;
}

export function levenshteinEntityLabelDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}
