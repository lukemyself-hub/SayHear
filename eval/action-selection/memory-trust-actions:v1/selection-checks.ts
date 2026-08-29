import {
  CATALOG_V2_CONVERSATION_HARNESS_POLICY,
  MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
  TRUST_ACTION_EXPRESSION_CONTRACT_VERSION,
} from "@sayhear/application";

export const ACTION_SELECTION_DATASET_VERSION =
  "memory-trust-actions:v1" as const;
export const CATALOG_VERSION =
  MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG.version;
export const HARNESS_POLICY_VERSION =
  CATALOG_V2_CONVERSATION_HARNESS_POLICY.version;
export const PROMPT_VERSION = TRUST_ACTION_EXPRESSION_CONTRACT_VERSION;

export const MAX_FIXTURES = 80 as const;
export const EXPECTED_FIXTURE_COUNT = 76 as const;
export const HEADROOM_FIXTURE_COUNT = 4 as const;
export const PERSON_WIDE_FORGET_UNSUPPORTED_REASON =
  "person_wide_unsupported" as const;
export const EXPECTED_PERSON_WIDE_FORGET_LANGUAGES: Readonly<
  Record<LanguageVariant, number>
> = { en: 1, zh: 1, code_switch: 1 };

export const TRUST_ACTION_KINDS = [
  "memory_correction",
  "memory_forget_request",
  "memory_forget_reversal",
  "explain_memory_source",
  "entity_identity_correction",
] as const;

export type TrustActionKind = (typeof TRUST_ACTION_KINDS)[number];
export type LanguageVariant = "en" | "zh" | "code_switch";
export type ActionSelectionCategory =
  | "correction"
  | "forget"
  | "reversal"
  | "explain"
  | "entity_identity"
  | "shared_hard_negative";
export type ScenarioClass =
  | "positive"
  | "near_miss_unsupported"
  | "ambiguity_clarification"
  | "compound_priority"
  | "hard_negative";
export type SelectionOutcome =
  | "action"
  | "ordinary_reply"
  | "clarification_required"
  | "unsupported";
export type SelectionTargetKind =
  | "memory_claim"
  | "relationship_qualifier"
  | "entity_identity";
export type EntityIdentityCorrectionOperation =
  | "merge"
  | "split"
  | "promote";
export type ClarificationReason =
  | "target_ambiguous_multi_hit"
  | "scope_ambiguous"
  | "target_not_found"
  | "target_not_fenced";
export type CompoundPriority = "trust_control";
export type HardNegativeKind =
  | "account_deletion"
  | "bulk_clearing"
  | "invented_tool";

export type SelectionTarget = Readonly<{
  kind: SelectionTargetKind;
  /** Synthetic comparison key; never a production database identifier. */
  reference: string;
}>;

export type QualifierExpectation = Readonly<{
  axis: string;
  roleSide: "canonical_subject" | "counterpart";
  value: string;
}>;

export type SelectionExpectation = Readonly<{
  outcome: SelectionOutcome;
  actionKind: TrustActionKind | null;
  target: SelectionTarget | null;
  qualifier: QualifierExpectation | null;
  entityOperation: EntityIdentityCorrectionOperation | null;
  clarificationReason: ClarificationReason | null;
  compoundPriority: CompoundPriority | null;
  unsupportedReason: string | null;
}>;

export type CompoundRequest = Readonly<{
  otherRequest: string;
  otherExpectedOutcome: SelectionOutcome;
  onlySelectedAction: TrustActionKind;
}>;

export type ActionSelectionScenario = Readonly<{
  id: string;
  category: ActionSelectionCategory;
  scenarioClass: ScenarioClass;
  languageVariant: LanguageVariant;
  locale: string;
  timezone: string;
  description: string;
  synthetic: true;
  turns: readonly Readonly<{ text: string; gapMs?: number }>[];
  expected: SelectionExpectation;
  hardNegativeKind?: HardNegativeKind;
  compoundRequest?: CompoundRequest;
}>;

export type ActionSelectionDataset = Readonly<{
  version: string;
  catalogVersion: string;
  harnessPolicyVersion: string;
  promptVersion: string;
  maxFixtures: number;
  headroom: number;
  syntheticNotice: string;
  scenarios: readonly ActionSelectionScenario[];
}>;

export type ActionSelectionResult = Readonly<{
  fixtureId: string;
  outcome: SelectionOutcome;
  actionKind: TrustActionKind | null;
  target: SelectionTarget | null;
  qualifier: QualifierExpectation | null;
  entityOperation: EntityIdentityCorrectionOperation | null;
  clarificationReason: ClarificationReason | null;
  compoundPriority: CompoundPriority | null;
  unsupportedReason: string | null;
}>;

export type ActionSelectionResultFile = Readonly<{
  version: "action-selection-results:v1";
  datasetVersion: string;
  catalogVersion: string;
  harnessPolicyVersion: string;
  promptVersion: string;
  results: readonly ActionSelectionResult[];
}>;

type ExpectedQuota = Readonly<{
  total: number;
  languages: Readonly<Record<LanguageVariant, number>>;
  classes: Readonly<Record<string, number>>;
}>;

export const EXPECTED_SELECTION_QUOTAS: Readonly<
  Record<ActionSelectionCategory, ExpectedQuota>
> = {
  correction: {
    total: 22,
    languages: { en: 13, zh: 6, code_switch: 3 },
    classes: {
      positive: 9,
      near_miss_unsupported: 7,
      ambiguity_clarification: 4,
      compound_priority: 2,
    },
  },
  forget: {
    total: 18,
    languages: { en: 10, zh: 5, code_switch: 3 },
    classes: {
      positive: 7,
      near_miss_unsupported: 5,
      ambiguity_clarification: 4,
      compound_priority: 2,
    },
  },
  reversal: {
    total: 10,
    languages: { en: 6, zh: 3, code_switch: 1 },
    classes: {
      positive: 4,
      near_miss_unsupported: 3,
      ambiguity_clarification: 2,
      compound_priority: 1,
    },
  },
  explain: {
    total: 10,
    languages: { en: 6, zh: 3, code_switch: 1 },
    classes: {
      positive: 4,
      near_miss_unsupported: 3,
      ambiguity_clarification: 2,
      compound_priority: 1,
    },
  },
  entity_identity: {
    total: 8,
    languages: { en: 5, zh: 2, code_switch: 1 },
    classes: {
      positive: 3,
      near_miss_unsupported: 2,
      ambiguity_clarification: 2,
      compound_priority: 1,
    },
  },
  shared_hard_negative: {
    total: 8,
    languages: { en: 5, zh: 2, code_switch: 1 },
    classes: { hard_negative: 8 },
  },
};

type SelectionCounts = Readonly<
  Record<
    ActionSelectionCategory,
    {
      total: number;
      languages: Record<LanguageVariant, number>;
      classes: Record<string, number>;
    }
  >
>;

export type SelectionDatasetMismatch = Readonly<{
  code: string;
  fixtureId?: string;
  detail: string;
}>;

export type SelectionDatasetVerification = Readonly<{
  passed: boolean;
  fixtureCount: number;
  headroom: number;
  counts: SelectionCounts;
  mismatches: readonly SelectionDatasetMismatch[];
}>;

export type SelectionResultMismatch = Readonly<{
  code: string;
  fixtureId?: string;
  detail: string;
}>;

export type SelectionResultVerification = Readonly<{
  passed: boolean;
  fixtureCount: number;
  resultCount: number;
  conformance: number;
  wrongTarget: number;
  falseSuccess: number;
  mismatches: readonly SelectionResultMismatch[];
}>;

const CATEGORY_ACTION_KIND: Readonly<
  Record<Exclude<ActionSelectionCategory, "shared_hard_negative">, TrustActionKind>
> = {
  correction: "memory_correction",
  forget: "memory_forget_request",
  reversal: "memory_forget_reversal",
  explain: "explain_memory_source",
  entity_identity: "entity_identity_correction",
};

const CATEGORY_TARGET_KINDS: Readonly<
  Record<Exclude<ActionSelectionCategory, "shared_hard_negative">, readonly SelectionTargetKind[]>
> = {
  correction: ["memory_claim"],
  forget: ["memory_claim", "relationship_qualifier"],
  reversal: ["memory_claim", "relationship_qualifier"],
  explain: ["memory_claim"],
  entity_identity: ["entity_identity"],
};

const ACTION_CATEGORIES = Object.keys(
  EXPECTED_SELECTION_QUOTAS,
) as ActionSelectionCategory[];
const LANGUAGE_VARIANTS: readonly LanguageVariant[] = ["en", "zh", "code_switch"];
const SCENARIO_CLASSES: readonly ScenarioClass[] = [
  "positive",
  "near_miss_unsupported",
  "ambiguity_clarification",
  "compound_priority",
  "hard_negative",
];
const CLARIFICATION_REASONS: readonly ClarificationReason[] = [
  "target_ambiguous_multi_hit",
  "scope_ambiguous",
  "target_not_found",
  "target_not_fenced",
];
const HARD_NEGATIVE_KINDS: readonly HardNegativeKind[] = [
  "account_deletion",
  "bulk_clearing",
  "invented_tool",
];
const TARGET_KINDS: readonly SelectionTargetKind[] = [
  "memory_claim",
  "relationship_qualifier",
  "entity_identity",
];
const ENTITY_OPERATIONS: readonly EntityIdentityCorrectionOperation[] = [
  "merge",
  "split",
  "promote",
];
const OUTCOMES: readonly SelectionOutcome[] = [
  "action",
  "ordinary_reply",
  "clarification_required",
  "unsupported",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return isString(value) && values.includes(value as T);
}

function isValidSyntheticReference(value: unknown): value is string {
  return (
    isString(value) &&
    /^synthetic:[a-z0-9][a-z0-9:/_-]*$/i.test(value) &&
    !/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(
      value,
    )
  );
}

function freshCounts(): {
  -readonly [K in ActionSelectionCategory]: {
    total: number;
    languages: Record<LanguageVariant, number>;
    classes: Record<string, number>;
  };
} {
  return Object.fromEntries(
    ACTION_CATEGORIES.map((category) => [
      category,
      {
        total: 0,
        languages: { en: 0, zh: 0, code_switch: 0 },
        classes: {},
      },
    ]),
  ) as {
    -readonly [K in ActionSelectionCategory]: {
      total: number;
      languages: Record<LanguageVariant, number>;
      classes: Record<string, number>;
    };
  };
}

function mismatch(
  code: string,
  detail: string,
  fixtureId?: string,
): SelectionDatasetMismatch {
  return fixtureId === undefined ? { code, detail } : { code, detail, fixtureId };
}

function resultMismatch(
  code: string,
  detail: string,
  fixtureId?: string,
): SelectionResultMismatch {
  return fixtureId === undefined ? { code, detail } : { code, detail, fixtureId };
}

function pushIfDifferent(
  mismatches: SelectionDatasetMismatch[],
  code: string,
  detail: string,
  fixtureId?: string,
): void {
  mismatches.push(mismatch(code, detail, fixtureId));
}

function validateTarget(
  target: unknown,
  fixtureId: string,
  mismatches: SelectionDatasetMismatch[],
): target is SelectionTarget {
  if (!isRecord(target)) {
    pushIfDifferent(
      mismatches,
      "target_missing",
      "an action expectation must carry one typed synthetic target",
      fixtureId,
    );
    return false;
  }
  if (!isOneOf(target.kind, TARGET_KINDS)) {
    pushIfDifferent(
      mismatches,
      "target_kind",
      `target kind must be one of ${TARGET_KINDS.join(", ")}`,
      fixtureId,
    );
  }
  if (!isValidSyntheticReference(target.reference)) {
    pushIfDifferent(
      mismatches,
      "target_reference",
      "target reference must be a synthetic: comparison key, not a production identifier",
      fixtureId,
    );
  }
  return isOneOf(target.kind, TARGET_KINDS) && isValidSyntheticReference(target.reference);
}

function validateQualifier(
  qualifier: unknown,
  fixtureId: string,
  mismatches: SelectionDatasetMismatch[],
): qualifier is QualifierExpectation {
  if (!isRecord(qualifier)) {
    pushIfDifferent(
      mismatches,
      "qualifier_missing",
      "a relationship_qualifier target must describe its typed qualifier",
      fixtureId,
    );
    return false;
  }
  if (!isString(qualifier.axis) || qualifier.axis.length === 0) {
    pushIfDifferent(mismatches, "qualifier_axis", "qualifier axis must be non-empty", fixtureId);
  }
  if (!isOneOf(qualifier.roleSide, ["canonical_subject", "counterpart"] as const)) {
    pushIfDifferent(
      mismatches,
      "qualifier_role_side",
      "qualifier roleSide must be canonical_subject or counterpart",
      fixtureId,
    );
  }
  if (!isString(qualifier.value) || qualifier.value.length === 0) {
    pushIfDifferent(mismatches, "qualifier_value", "qualifier value must be non-empty", fixtureId);
  }
  return (
    isString(qualifier.axis) &&
    qualifier.axis.length > 0 &&
    isOneOf(qualifier.roleSide, ["canonical_subject", "counterpart"] as const) &&
    isString(qualifier.value) &&
    qualifier.value.length > 0
  );
}

function validateExpectation(
  scenario: Record<string, unknown>,
  category: ActionSelectionCategory | null,
  scenarioClass: ScenarioClass | null,
  fixtureId: string,
  mismatches: SelectionDatasetMismatch[],
): void {
  const expected = scenario.expected;
  if (!isRecord(expected)) {
    pushIfDifferent(mismatches, "expected_missing", "fixture must declare an expected selection", fixtureId);
    return;
  }

  const outcome = expected.outcome;
  if (!isOneOf(outcome, OUTCOMES)) {
    pushIfDifferent(mismatches, "expected_outcome", "expected.outcome is not a supported selection outcome", fixtureId);
    return;
  }

  const expectedActionKind =
    category !== null && category !== "shared_hard_negative"
      ? CATEGORY_ACTION_KIND[category]
      : null;
  const expectedClassOutcome: SelectionOutcome | null =
    scenarioClass === "positive" || scenarioClass === "compound_priority"
      ? "action"
      : scenarioClass === "near_miss_unsupported"
        ? "unsupported"
        : scenarioClass === "ambiguity_clarification"
          ? "clarification_required"
          : scenarioClass === "hard_negative"
            ? null
            : null;
  if (expectedClassOutcome !== null && outcome !== expectedClassOutcome) {
    pushIfDifferent(
      mismatches,
      "class_outcome",
      `scenario class ${scenarioClass} must expect ${expectedClassOutcome}, got ${outcome}`,
      fixtureId,
    );
  }

  if (outcome === "action") {
    if (expectedActionKind === null || expected.actionKind !== expectedActionKind) {
      pushIfDifferent(
        mismatches,
        "action_kind",
        `action expectation must use ${expectedActionKind ?? "no action"}, got ${String(expected.actionKind)}`,
        fixtureId,
      );
    }
    const target = expected.target;
    const targetIsValid = validateTarget(target, fixtureId, mismatches);
    if (
      targetIsValid &&
      category !== null &&
      category !== "shared_hard_negative" &&
      !CATEGORY_TARGET_KINDS[category].includes(target.kind)
    ) {
      pushIfDifferent(
        mismatches,
        "target_kind",
        `${category} may target only ${CATEGORY_TARGET_KINDS[category].join(", ")}`,
        fixtureId,
      );
    }
    if (
      targetIsValid &&
      target.kind === "entity_identity" &&
      expectedActionKind !== "entity_identity_correction"
    ) {
      pushIfDifferent(
        mismatches,
        "target_kind",
        "only entity_identity_correction may target entity_identity",
        fixtureId,
      );
    }
    if (targetIsValid && target.kind !== "entity_identity" && expectedActionKind === "entity_identity_correction") {
      pushIfDifferent(
        mismatches,
        "target_kind",
        "entity_identity_correction must target entity_identity",
        fixtureId,
      );
    }
    if (targetIsValid && target.kind === "relationship_qualifier") {
      validateQualifier(expected.qualifier, fixtureId, mismatches);
    } else if (expected.qualifier !== null) {
      pushIfDifferent(
        mismatches,
        "qualifier_unexpected",
        "only a relationship_qualifier target may carry qualifier metadata",
        fixtureId,
      );
    }
    if (expectedActionKind === "entity_identity_correction") {
      if (!isOneOf(expected.entityOperation, ENTITY_OPERATIONS)) {
        pushIfDifferent(
          mismatches,
          "entity_operation",
          "entity identity actions must declare merge, split, or promote",
          fixtureId,
        );
      }
    } else if (expected.entityOperation !== null) {
      pushIfDifferent(
        mismatches,
        "entity_operation_unexpected",
        "only entity_identity_correction may declare an entity operation",
        fixtureId,
      );
    }
    if (expected.clarificationReason !== null || expected.unsupportedReason !== null) {
      pushIfDifferent(
        mismatches,
        "action_reason_unexpected",
        "accepted action expectations cannot carry clarification or unsupported reasons",
        fixtureId,
      );
    }
  } else {
    if (expected.actionKind !== null || expected.target !== null || expected.qualifier !== null || expected.entityOperation !== null) {
      pushIfDifferent(
        mismatches,
        "non_action_target",
        "non-action expectations must not preselect an Action or target",
        fixtureId,
      );
    }
    if (outcome === "clarification_required") {
      if (!isOneOf(expected.clarificationReason, CLARIFICATION_REASONS)) {
        pushIfDifferent(
          mismatches,
          "clarification_reason",
          "clarification_required must declare a production disposition reason",
          fixtureId,
        );
      }
    } else if (expected.clarificationReason !== null) {
      pushIfDifferent(
        mismatches,
        "clarification_reason_unexpected",
        "only clarification_required may declare a clarification reason",
        fixtureId,
      );
    }
    if (outcome === "unsupported") {
      if (!isString(expected.unsupportedReason) || expected.unsupportedReason.length === 0) {
        pushIfDifferent(
          mismatches,
          "unsupported_reason",
          "unsupported expectations must name the unsupported boundary",
          fixtureId,
        );
      }
    } else if (expected.unsupportedReason !== null) {
      pushIfDifferent(
        mismatches,
        "unsupported_reason_unexpected",
        "only unsupported expectations may carry an unsupported reason",
        fixtureId,
      );
    }
  }

  if (
    scenarioClass === "hard_negative" &&
    !isOneOf(outcome, ["ordinary_reply", "unsupported"] as const)
  ) {
    pushIfDifferent(
      mismatches,
      "hard_negative_outcome",
      "shared hard negatives may only expect ordinary_reply or unsupported",
      fixtureId,
    );
  }

  if (scenarioClass === "compound_priority") {
    if (expected.compoundPriority !== "trust_control") {
      pushIfDifferent(
        mismatches,
        "compound_priority",
        "compound priority fixtures must pin trust_control",
        fixtureId,
      );
    }
    if (!isRecord(scenario.compoundRequest)) {
      pushIfDifferent(
        mismatches,
        "compound_request",
        "compound priority fixtures must record the other request",
        fixtureId,
      );
    } else {
      if (
        !isString(scenario.compoundRequest.otherRequest) ||
        scenario.compoundRequest.otherRequest.length === 0
      ) {
        pushIfDifferent(
          mismatches,
          "compound_request",
          "compound request must describe the other request",
          fixtureId,
        );
      }
      if (!isOneOf(scenario.compoundRequest.otherExpectedOutcome, OUTCOMES)) {
        pushIfDifferent(
          mismatches,
          "compound_request",
          "compound request must record the other request outcome",
          fixtureId,
        );
      }
      if (!isOneOf(scenario.compoundRequest.onlySelectedAction, TRUST_ACTION_KINDS)) {
        pushIfDifferent(
          mismatches,
          "compound_request",
          "compound request must name a catalogued Trust Action",
          fixtureId,
        );
      } else if (scenario.compoundRequest.onlySelectedAction !== expected.actionKind) {
        pushIfDifferent(
          mismatches,
          "compound_request",
          "compound request must name the same selected Trust Action",
          fixtureId,
        );
      }
    }
  } else if (expected.compoundPriority !== null || scenario.compoundRequest !== undefined) {
    pushIfDifferent(
      mismatches,
      "compound_priority_unexpected",
      "only compound priority fixtures may declare compound metadata",
      fixtureId,
    );
  }
}

function validateScenario(
  value: unknown,
  counts: {
    -readonly [K in ActionSelectionCategory]: {
      total: number;
      languages: Record<LanguageVariant, number>;
      classes: Record<string, number>;
    };
  },
  seenIds: Set<string>,
  mismatches: SelectionDatasetMismatch[],
): void {
  if (!isRecord(value)) {
    pushIfDifferent(mismatches, "fixture_shape", "each scenario must be an object");
    return;
  }
  const fixtureId = isString(value.id) ? value.id : "<missing-id>";
  if (!isString(value.id) || value.id.length === 0) {
    pushIfDifferent(mismatches, "fixture_id", "fixture id must be non-empty", fixtureId);
  } else if (seenIds.has(value.id)) {
    pushIfDifferent(mismatches, "duplicate_fixture_id", "fixture id is duplicated", fixtureId);
  } else {
    seenIds.add(value.id);
  }

  const category = isOneOf(value.category, ACTION_CATEGORIES) ? value.category : null;
  if (category === null) {
    pushIfDifferent(mismatches, "category", "fixture category is not in the v1 quota table", fixtureId);
  }
  const languageVariant = isOneOf(value.languageVariant, LANGUAGE_VARIANTS)
    ? value.languageVariant
    : null;
  if (languageVariant === null) {
    pushIfDifferent(mismatches, "language_variant", "fixture languageVariant must be en, zh, or code_switch", fixtureId);
  }
  const scenarioClass = isOneOf(value.scenarioClass, SCENARIO_CLASSES)
    ? value.scenarioClass
    : null;
  if (scenarioClass === null) {
    pushIfDifferent(mismatches, "scenario_class", "fixture scenarioClass is not supported", fixtureId);
  }

  if (category !== null && languageVariant !== null && scenarioClass !== null) {
    counts[category].total += 1;
    counts[category].languages[languageVariant] += 1;
    counts[category].classes[scenarioClass] = (counts[category].classes[scenarioClass] ?? 0) + 1;
  }

  if (value.synthetic !== true) {
    pushIfDifferent(mismatches, "synthetic", "every fixture must set synthetic=true", fixtureId);
  }
  if (!isString(value.description) || value.description.length === 0) {
    pushIfDifferent(mismatches, "description", "fixture description must be non-empty", fixtureId);
  }
  if (
    !isString(value.locale) ||
    value.locale.length === 0
  ) {
    pushIfDifferent(mismatches, "locale", "fixture locale must be non-empty", fixtureId);
  }
  if (
    !isString(value.timezone) ||
    value.timezone.length === 0
  ) {
    pushIfDifferent(mismatches, "timezone", "fixture timezone must be non-empty", fixtureId);
  }
  if (
    !Array.isArray(value.turns) ||
    value.turns.length === 0 ||
    value.turns.some(
      (turn) =>
        !isRecord(turn) ||
        !isString(turn.text) ||
        turn.text.length === 0 ||
        (turn.gapMs !== undefined &&
          (typeof turn.gapMs !== "number" || turn.gapMs < 0)),
    )
  ) {
    pushIfDifferent(mismatches, "turns", "fixture must contain at least one non-empty synthetic user turn", fixtureId);
  }
  if (category === "shared_hard_negative") {
    if (!isOneOf(value.scenarioClass, ["hard_negative"] as const)) {
      pushIfDifferent(mismatches, "hard_negative_class", "shared hard negatives must use scenarioClass=hard_negative", fixtureId);
    }
    if (!isOneOf(value.hardNegativeKind, HARD_NEGATIVE_KINDS)) {
      pushIfDifferent(mismatches, "hard_negative_kind", "shared hard negatives must name account_deletion, bulk_clearing, or invented_tool", fixtureId);
    }
    if (value.compoundRequest !== undefined) {
      pushIfDifferent(mismatches, "hard_negative_compound", "shared hard negatives are not compound priority fixtures", fixtureId);
    }
  } else if (value.hardNegativeKind !== undefined) {
    pushIfDifferent(mismatches, "hard_negative_kind_unexpected", "only shared hard negatives may declare hardNegativeKind", fixtureId);
  }
  validateExpectation(value, category, scenarioClass, fixtureId, mismatches);
}

function compareJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => compareJson(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) => Object.hasOwn(right, key) && compareJson(left[key], right[key]),
    );
  }
  return false;
}

function compareQuotaCounts(
  actual: SelectionCounts[ActionSelectionCategory],
  expected: ExpectedQuota,
): boolean {
  return compareJson(actual, expected);
}

function datasetScenarios(value: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.scenarios)) return [];
  return value.scenarios.filter(isRecord);
}

/**
 * Pure structural and quota verification for the selection pack. It checks
 * only synthetic fixture metadata and the expected normalized outcome. It
 * never calls a model, the Action Gateway, or a database.
 */
export function verifySelectionDataset(
  dataset: unknown,
): SelectionDatasetVerification {
  const mismatches: SelectionDatasetMismatch[] = [];
  const counts = freshCounts();
  const seenIds = new Set<string>();
  const scenarios = datasetScenarios(dataset);

  if (!isRecord(dataset)) {
    mismatches.push(mismatch("dataset_shape", "dataset must be an object"));
  } else {
    const metadata: readonly [string, unknown, unknown][] = [
      ["dataset_version", dataset.version, ACTION_SELECTION_DATASET_VERSION],
      ["catalog_version", dataset.catalogVersion, CATALOG_VERSION],
      ["harness_policy_version", dataset.harnessPolicyVersion, HARNESS_POLICY_VERSION],
      ["prompt_version", dataset.promptVersion, PROMPT_VERSION],
    ];
    for (const [code, actual, expected] of metadata) {
      if (actual !== expected) {
        mismatches.push(mismatch(code, `expected ${expected}, got ${String(actual)}`));
      }
    }
    if (dataset.maxFixtures !== MAX_FIXTURES) {
      mismatches.push(mismatch("max_fixtures", `expected maxFixtures=${MAX_FIXTURES}, got ${String(dataset.maxFixtures)}`));
    }
    if (dataset.headroom !== HEADROOM_FIXTURE_COUNT) {
      mismatches.push(mismatch("headroom", `expected headroom=${HEADROOM_FIXTURE_COUNT}, got ${String(dataset.headroom)}`));
    }
    if (!isString(dataset.syntheticNotice) || !/synthetic/i.test(dataset.syntheticNotice)) {
      mismatches.push(mismatch("synthetic_notice", "dataset syntheticNotice must explicitly identify synthetic material"));
    }
    if (!Array.isArray(dataset.scenarios)) {
      mismatches.push(mismatch("scenarios", "dataset.scenarios must be an array"));
    }
  }

  for (const scenario of scenarios) {
    validateScenario(scenario, counts, seenIds, mismatches);
  }

  const fixtureCount = isRecord(dataset) && Array.isArray(dataset.scenarios)
    ? dataset.scenarios.length
    : scenarios.length;
  const headroom = MAX_FIXTURES - fixtureCount;
  if (fixtureCount !== EXPECTED_FIXTURE_COUNT) {
    mismatches.push(mismatch("fixture_count", `expected ${EXPECTED_FIXTURE_COUNT} fixtures, got ${fixtureCount}`));
  }
  if (fixtureCount > MAX_FIXTURES) {
    mismatches.push(mismatch("fixture_cap", `fixture count ${fixtureCount} exceeds cap ${MAX_FIXTURES}`));
  }
  if (headroom !== HEADROOM_FIXTURE_COUNT) {
    mismatches.push(mismatch("headroom_math", `expected ${HEADROOM_FIXTURE_COUNT} unused capacity slots, got ${headroom}`));
  }

  for (const category of ACTION_CATEGORIES) {
    if (!compareQuotaCounts(counts[category], EXPECTED_SELECTION_QUOTAS[category])) {
      mismatches.push(
        mismatch(
          "quota",
          `${category} quota mismatch: expected ${JSON.stringify(EXPECTED_SELECTION_QUOTAS[category])}, got ${JSON.stringify(counts[category])}`,
        ),
      );
    }
  }
  const hardNegativeKinds = new Set(
    scenarios
      .filter((scenario) => scenario.category === "shared_hard_negative")
      .map((scenario) => scenario.hardNegativeKind)
      .filter((kind): kind is HardNegativeKind => isOneOf(kind, HARD_NEGATIVE_KINDS)),
  );
  for (const kind of HARD_NEGATIVE_KINDS) {
    if (!hardNegativeKinds.has(kind)) {
      mismatches.push(mismatch("hard_negative_coverage", `shared hard negatives must cover ${kind}`));
    }
  }

  const personWideForgetLanguages = {
    en: 0,
    zh: 0,
    code_switch: 0,
  } satisfies Record<LanguageVariant, number>;
  let personWideForgetCount = 0;
  for (const scenario of scenarios) {
    const expected = scenario.expected;
    if (
      scenario.category === "forget" &&
      scenario.scenarioClass === "near_miss_unsupported" &&
      isRecord(expected) &&
      expected.outcome === "unsupported" &&
      expected.unsupportedReason === PERSON_WIDE_FORGET_UNSUPPORTED_REASON
    ) {
      personWideForgetCount += 1;
      if (isOneOf(scenario.languageVariant, LANGUAGE_VARIANTS)) {
        personWideForgetLanguages[scenario.languageVariant] += 1;
      }
    }
  }
  if (personWideForgetCount !== 3) {
    mismatches.push(
      mismatch(
        "person_wide_forget",
        `expected 3 person-wide Forget fixtures with ${PERSON_WIDE_FORGET_UNSUPPORTED_REASON}, got ${personWideForgetCount}`,
      ),
    );
  }
  for (const languageVariant of LANGUAGE_VARIANTS) {
    if (
      personWideForgetLanguages[languageVariant] !==
      EXPECTED_PERSON_WIDE_FORGET_LANGUAGES[languageVariant]
    ) {
      mismatches.push(
        mismatch(
          "person_wide_forget_language",
          `expected one person-wide Forget fixture in ${languageVariant}, got ${personWideForgetLanguages[languageVariant]}`,
        ),
      );
    }
  }

  return {
    passed: mismatches.length === 0,
    fixtureCount,
    headroom,
    counts,
    mismatches,
  };
}

function resultFileResults(value: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.results)) return [];
  return value.results.filter(isRecord);
}

function readResultId(result: Record<string, unknown>): string | null {
  return isString(result.fixtureId) ? result.fixtureId : null;
}

const NORMALIZED_RESULT_FIELDS = new Set([
  "fixtureId",
  "outcome",
  "actionKind",
  "target",
  "qualifier",
  "entityOperation",
  "clarificationReason",
  "compoundPriority",
  "unsupportedReason",
]);
const NORMALIZED_RESULT_FILE_FIELDS = new Set([
  "version",
  "datasetVersion",
  "catalogVersion",
  "harnessPolicyVersion",
  "promptVersion",
  "results",
]);

function expectedResultMatches(
  expected: Record<string, unknown>,
  result: Record<string, unknown>,
  fixtureId: string,
  mismatches: SelectionResultMismatch[],
): { targetMismatch: boolean; falseSuccess: boolean; matches: boolean } {
  const expectedOutcome = expected.outcome;
  const resultOutcome = result.outcome;
  const isExpectedAction = expectedOutcome === "action";
  const isResultAction = resultOutcome === "action";
  const falseSuccess = !isExpectedAction && isResultAction;
  if (falseSuccess) {
    mismatches.push(resultMismatch("false_success", "result selected an Action where the fixture requires a non-action outcome", fixtureId));
  }
  let targetMismatch = false;
  let matches = true;
  const fields: readonly string[] = [
    "outcome",
    "actionKind",
    "target",
    "qualifier",
    "entityOperation",
    "clarificationReason",
    "compoundPriority",
    "unsupportedReason",
  ];
  for (const field of fields) {
    if (!compareJson(result[field], expected[field])) {
      matches = false;
      if (
        isExpectedAction &&
        isResultAction &&
        (field === "target" || field === "qualifier")
      ) {
        targetMismatch = true;
      }
      mismatches.push(
        resultMismatch(
          isExpectedAction &&
            isResultAction &&
            (field === "target" || field === "qualifier")
            ? "wrong_target"
            : "result_mismatch",
          `${field}: expected ${JSON.stringify(expected[field])}, got ${JSON.stringify(result[field])}`,
          fixtureId,
        ),
      );
    }
  }
  return { targetMismatch, falseSuccess, matches };
}

/**
 * Verify a normalized, provider-produced result file against the frozen
 * expectations. The result file contains IDs and typed comparison metadata,
 * never user utterances or raw provider payloads.
 */
export function verifySelectionResults(input: {
  dataset: unknown;
  resultFile: unknown;
}): SelectionResultVerification {
  const mismatches: SelectionResultMismatch[] = [];
  const datasetRecord = isRecord(input.dataset) ? input.dataset : null;
  const scenarios = datasetScenarios(input.dataset);
  const resultFile = input.resultFile;
  const results = resultFileResults(resultFile);

  if (!datasetRecord) {
    mismatches.push(resultMismatch("dataset_shape", "result verification requires an object dataset"));
  }
  if (!isRecord(resultFile)) {
    mismatches.push(resultMismatch("result_file_shape", "result file must be an object"));
  } else {
    for (const field of Object.keys(resultFile)) {
      if (!NORMALIZED_RESULT_FILE_FIELDS.has(field)) {
        mismatches.push(
          resultMismatch(
            "result_payload",
            `normalized result files cannot carry extra top-level field ${field}`,
          ),
        );
      }
    }
    const metadata: readonly [string, unknown, unknown][] = [
      ["result_version", resultFile.version, "action-selection-results:v1"],
      ["dataset_version", resultFile.datasetVersion, datasetRecord?.version ?? ACTION_SELECTION_DATASET_VERSION],
      ["catalog_version", resultFile.catalogVersion, datasetRecord?.catalogVersion ?? CATALOG_VERSION],
      ["harness_policy_version", resultFile.harnessPolicyVersion, datasetRecord?.harnessPolicyVersion ?? HARNESS_POLICY_VERSION],
      ["prompt_version", resultFile.promptVersion, datasetRecord?.promptVersion ?? PROMPT_VERSION],
    ];
    for (const [code, actual, expected] of metadata) {
      if (actual !== expected) {
        mismatches.push(resultMismatch(code, `expected ${expected}, got ${String(actual)}`));
      }
    }
    if (!Array.isArray(resultFile.results)) {
      mismatches.push(resultMismatch("results", "result file results must be an array"));
    } else {
      resultFile.results.forEach((result, index) => {
        if (!isRecord(result)) {
          mismatches.push(
            resultMismatch(
              "result_shape",
              `result at index ${index} must be an object with normalized selection fields`,
            ),
          );
        }
      });
    }
  }

  const expectedById = new Map<string, Record<string, unknown>>();
  for (const scenario of scenarios) {
    if (isString(scenario.id)) expectedById.set(scenario.id, scenario.expected as Record<string, unknown>);
  }
  const seenResultIds = new Set<string>();
  let wrongTarget = 0;
  let falseSuccess = 0;
  let correct = 0;
  for (const result of results) {
    const fixtureId = readResultId(result) ?? "<missing-id>";
    if (!isString(readResultId(result))) {
      mismatches.push(resultMismatch("result_id", "each result must carry fixtureId", fixtureId));
      continue;
    }
    for (const field of Object.keys(result)) {
      if (!NORMALIZED_RESULT_FIELDS.has(field)) {
        mismatches.push(
          resultMismatch(
            "result_payload",
            `normalized results cannot carry extra field ${field}; omit user content and raw provider payloads`,
            fixtureId,
          ),
        );
      }
    }
    if (seenResultIds.has(fixtureId)) {
      mismatches.push(resultMismatch("duplicate_result_id", "result fixtureId is duplicated", fixtureId));
      continue;
    }
    seenResultIds.add(fixtureId);
    const expected = expectedById.get(fixtureId);
    if (!expected) {
      mismatches.push(resultMismatch("unknown_result_id", "result fixtureId is not in the dataset", fixtureId));
      continue;
    }
    const comparison = expectedResultMatches(expected, result, fixtureId, mismatches);
    if (comparison.targetMismatch) wrongTarget += 1;
    if (comparison.falseSuccess) falseSuccess += 1;
    if (comparison.matches) correct += 1;
  }
  for (const fixtureId of expectedById.keys()) {
    if (!seenResultIds.has(fixtureId)) {
      mismatches.push(resultMismatch("missing_result_id", "dataset fixture has no normalized result", fixtureId));
    }
  }

  const fixtureCount = scenarios.length;
  const resultCount =
    isRecord(resultFile) && Array.isArray(resultFile.results)
      ? resultFile.results.length
      : results.length;
  const conformance = fixtureCount === 0 ? 0 : correct / fixtureCount;
  return {
    passed: mismatches.length === 0 && conformance === 1 && wrongTarget === 0 && falseSuccess === 0,
    fixtureCount,
    resultCount,
    conformance,
    wrongTarget,
    falseSuccess,
    mismatches,
  };
}
