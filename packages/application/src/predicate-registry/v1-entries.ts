import type {
  EnumValueSpec,
  PredicateRegistryEntry,
} from "./types";
import { PREDICATE_IDS } from "./v1";

/**
 * The 24 Registry v1 entries (#93 §1–§5). Machine identity only — bilingual
 * labels, definitions, seed examples, and projection templates live in
 * v1-localizations. Global policies per #93 §0:
 *  - objective admits on one direct explicit user statement (ADR-0038);
 *  - impression keeps the global floor of 2 Evidence / 2 Daily Sessions
 *    (ADR-0039) with no per-entry tightening;
 *  - uniform 30-day review cycle to dormant (ADR-0041);
 *  - sensitivity_class=sensitive count is zero in v1 (#93 §6).
 */

export const EVIDENCE_POLICY_GLOBAL_V1 = "evidence-policy.global-v1";
export const REVIEW_POLICY_IMPRESSION_GLOBAL_V1 =
  "review-policy.impression-global-v1";

const enumValues = (...specs: EnumValueSpec[]) => specs;

const CAREER_STAGE_VALUES = enumValues(
  {
    value: "enrolled_student",
    zh: ["在读", "上学", "在读中", "读书"],
    en: ["studying", "enrolled", "in_school", "a student"],
  },
  {
    value: "employed",
    zh: ["在职", "上班", "在工作", "有工作"],
    en: ["employed", "working", "have a job"],
  },
  {
    value: "job_seeking",
    zh: ["求职中", "在看机会", "找工作", "待业"],
    en: ["job_hunting", "looking_for_work", "between_jobs", "job hunting", "looking for work", "between jobs"],
  },
  {
    value: "freelance",
    zh: ["自由职业", "自由职业者", "接活"],
    en: ["freelancing", "freelance", "self_employed"],
  },
  {
    value: "retired",
    zh: ["退休", "退休了", "已退休"],
    en: ["retired", "retirement"],
  },
);

const FAMILY_STAGE_VALUES = enumValues(
  { value: "single", zh: ["单身"], en: ["single"] },
  {
    value: "in_relationship",
    zh: ["恋爱中", "在恋爱", "谈恋爱"],
    en: ["in_a_relationship", "dating", "seeing_someone", "in a relationship"],
  },
  { value: "married", zh: ["已婚", "结婚了"], en: ["married"] },
  {
    value: "new_parent",
    zh: ["新手父母", "刚当爸妈", "有娃了", "新手妈妈", "新手爸爸"],
    en: ["new_parent", "new_mom", "new_dad"],
  },
  {
    value: "school_age_parent",
    zh: ["学龄父母", "孩子上学了"],
    en: ["school_age_parent", "kids_in_school", "school age parent"],
  },
  {
    value: "caregiving",
    zh: ["照护中", "照顾老人", "照护家人"],
    en: ["caregiving", "caring_for_family"],
  },
);

const LIFE_CHANGE_SCOPES = enumValues(
  { value: "moving_house", zh: ["搬家"], en: ["moving_house", "moving"] },
  { value: "job_change", zh: ["换工作", "跳槽"], en: ["job_change"] },
  {
    value: "further_study_prep",
    zh: ["深造备考", "备考", "考研", "考学"],
    en: ["further_study_prep", "exam_prep"],
  },
  { value: "wedding_prep", zh: ["备婚", "筹备婚礼"], en: ["wedding_prep", "wedding prep"] },
  {
    value: "starting_business",
    zh: ["创业"],
    en: ["starting_business", "starting_a_company"],
  },
  {
    value: "international_relocation",
    zh: ["跨国迁移", "出国定居", "移居国外"],
    en: ["international_relocation", "relocating_abroad"],
  },
);

const RELATIONSHIP_HINT_PROJECTIONS = Object.freeze({
  current: true,
  former: true,
});

function relationshipTemporal(): PredicateRegistryEntry["temporalSemantics"] {
  return Object.freeze({
    temporalStatuses: ["current_ended" as const],
    boundaryPrecision: "preserved" as const,
    resolverHintProjections: RELATIONSHIP_HINT_PROJECTIONS,
  });
}

const CURRENT_ENDED = Object.freeze({
  temporalStatuses: ["current_ended" as const],
  boundaryPrecision: "preserved" as const,
});
const LONG_TERM_STABLE = Object.freeze({
  temporalStatuses: ["stable" as const],
  boundaryPrecision: "preserved" as const,
});

/**
 * A helper for relationship entries: claims are `kind=objective` only
 * (#93 hard boundary — AI-observed closeness stays in Evidence/Journal), both
 * parties must bind to person Entities, and mention order never overrides the
 * canonical roles below.
 */
function relationshipEntry(input: {
  id: string;
  direction: "directed" | "symmetric";
  canonicalSubjectRole?: string;
  canonicalObjectRole?: string;
  views: readonly ("forward" | "inverse" | "symmetric")[];
  qualifierAxes?: PredicateRegistryEntry["relationshipSemantics"] extends null
    ? never
    : NonNullable<
          PredicateRegistryEntry["relationshipSemantics"]
        >["qualifierAxes"];
}): PredicateRegistryEntry {
  const entry: PredicateRegistryEntry = {
    predicateId: input.id,
    registryVersion: 1,
    definitionVersion: 1,
    status: "active",
    allowedClaimKinds: ["objective"],
    sensitivityClass: "standard",
    allowedSubjectKindIds: ["sh.entity.person"],
    objectValueSchema: { kind: "text", normalization: "nfc_trim_collapsed" },
    scopeSchema: { kind: "none" },
    valueCardinality: "single",
    temporalSemantics: relationshipTemporal(),
    relationshipSemantics: Object.freeze({
      direction: input.direction,
      ...(input.canonicalSubjectRole
        ? { canonicalSubjectRole: input.canonicalSubjectRole }
        : {}),
      ...(input.canonicalObjectRole
        ? { canonicalObjectRole: input.canonicalObjectRole }
        : {}),
      ...(input.direction === "symmetric"
        ? { pairNormalization: "unordered_entity_pair" as const }
        : {}),
      views: input.views,
      qualifierAxes: input.qualifierAxes ?? [],
    }),
    evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
    reviewPolicyId: null,
    replacedByPredicateId: null,
  };
  return Object.freeze(entry);
}

const KINSHIP_TERM_AXIS = Object.freeze({
  axisId: "kinship_term",
  appliesToRole: "either" as const,
  valueSchema: Object.freeze({
    kind: "text" as const,
    normalization: "nfc_trim_collapsed" as const,
  }),
  cardinality: "single" as const,
  evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
  neutralFallbackZh: "亲戚",
  neutralFallbackEn: "relative",
});

const FRIEND_ORIGIN_AXIS = Object.freeze({
  axisId: "relation_origin",
  appliesToRole: "either" as const,
  valueSchema: Object.freeze({
    kind: "text" as const,
    normalization: "nfc_trim_collapsed" as const,
  }),
  cardinality: "multiple" as const,
  evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
  neutralFallbackZh: "朋友",
  neutralFallbackEn: "friend",
});

const FRIEND_CLOSENESS_AXIS = Object.freeze({
  axisId: "stated_closeness",
  appliesToRole: "either" as const,
  valueSchema: Object.freeze({
    kind: "enum" as const,
    closedSet: true as const,
    values: enumValues(
      { value: "best", zh: ["闺蜜", "死党", "挚友"], en: ["bestie", "best_friend", "bff"] },
      { value: "close", zh: ["好朋友", "好友", "很熟"], en: ["good_friend", "close_friend"] },
      { value: "casual", zh: ["普通朋友", "泛泛之交"], en: ["casual_friend", "acquaintance_friend"] },
    ),
  }),
  cardinality: "single" as const,
  evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
  neutralFallbackZh: "",
  neutralFallbackEn: "",
});

const TEXT_VALUE = Object.freeze({
  kind: "text" as const,
  normalization: "nfc_trim_collapsed" as const,
});

export function buildRegistryV1Entries(): readonly PredicateRegistryEntry[] {
  const entries: PredicateRegistryEntry[] = [
    // ── §1 人物关系（10 条）───────────────────────────────────────────────
    relationshipEntry({
      id: PREDICATE_IDS.partnerOf,
      direction: "symmetric",
      views: ["symmetric"],
    }),
    relationshipEntry({
      id: PREDICATE_IDS.parentOf,
      direction: "directed",
      canonicalSubjectRole: "parent",
      canonicalObjectRole: "child",
      views: ["forward", "inverse"],
    }),
    relationshipEntry({
      id: PREDICATE_IDS.siblingOf,
      direction: "symmetric",
      views: ["symmetric"],
    }),
    relationshipEntry({
      id: PREDICATE_IDS.friendOf,
      direction: "symmetric",
      views: ["symmetric"],
      qualifierAxes: [FRIEND_ORIGIN_AXIS, FRIEND_CLOSENESS_AXIS],
    }),
    relationshipEntry({
      id: PREDICATE_IDS.colleagueOf,
      direction: "symmetric",
      views: ["symmetric"],
    }),
    relationshipEntry({
      id: PREDICATE_IDS.managerOf,
      direction: "directed",
      canonicalSubjectRole: "manager",
      canonicalObjectRole: "subordinate",
      views: ["forward", "inverse"],
    }),
    relationshipEntry({
      id: PREDICATE_IDS.relativeOf,
      direction: "symmetric",
      views: ["symmetric"],
      qualifierAxes: [KINSHIP_TERM_AXIS],
    }),
    relationshipEntry({
      id: PREDICATE_IDS.inLawOf,
      direction: "directed",
      canonicalSubjectRole: "elder_generation",
      canonicalObjectRole: "junior_generation",
      views: ["forward", "inverse"],
    }),
    relationshipEntry({
      id: PREDICATE_IDS.teacherOf,
      direction: "directed",
      canonicalSubjectRole: "teacher",
      canonicalObjectRole: "student",
      views: ["forward", "inverse"],
    }),
    relationshipEntry({
      id: PREDICATE_IDS.roommateOf,
      direction: "symmetric",
      views: ["symmetric"],
    }),

    // ── §2 工作 / 项目 / 地点锚点（6 条）─────────────────────────────────
    {
      predicateId: PREDICATE_IDS.employer,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["objective"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: TEXT_VALUE,
      scopeSchema: { kind: "none" },
      valueCardinality: "single",
      temporalSemantics: CURRENT_ENDED,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: null,
      replacedByPredicateId: null,
    },
    {
      predicateId: PREDICATE_IDS.roleTitle,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["objective"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: TEXT_VALUE,
      scopeSchema: { kind: "none" },
      valueCardinality: "single",
      temporalSemantics: CURRENT_ENDED,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: null,
      replacedByPredicateId: null,
    },
    {
      predicateId: PREDICATE_IDS.projectParticipation,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["objective"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: TEXT_VALUE,
      scopeSchema: { kind: "none" },
      valueCardinality: "multiple",
      temporalSemantics: CURRENT_ENDED,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: null,
      replacedByPredicateId: null,
    },
    {
      predicateId: PREDICATE_IDS.residence,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["objective"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: TEXT_VALUE,
      scopeSchema: { kind: "none" },
      valueCardinality: "single",
      temporalSemantics: CURRENT_ENDED,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: null,
      replacedByPredicateId: null,
    },
    {
      predicateId: PREDICATE_IDS.hometown,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["objective"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: TEXT_VALUE,
      scopeSchema: { kind: "none" },
      valueCardinality: "single",
      temporalSemantics: LONG_TERM_STABLE,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: null,
      replacedByPredicateId: null,
    },
    {
      predicateId: PREDICATE_IDS.workplace,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["objective"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: TEXT_VALUE,
      scopeSchema: { kind: "none" },
      valueCardinality: "multiple",
      temporalSemantics: CURRENT_ENDED,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: null,
      replacedByPredicateId: null,
    },

    // ── §3 计划与人生阶段（3 条）──────────────────────────────────────
    {
      // 只承接周以上跨度主动计划；几天内待办不是 Open Loop（任务语义按
      // Open Loop 形成门禁拒绝，SPEC 6.1/Issue #204）、旅行归 Episode；
      // 明确排除在 Person Portrait 之外（ADR-0111 口径，#93 §3/§17）。
      predicateId: PREDICATE_IDS.lifeChange,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["objective"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: TEXT_VALUE,
      scopeSchema: { kind: "enum", values: LIFE_CHANGE_SCOPES },
      valueCardinality: "single",
      temporalSemantics: CURRENT_ENDED,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: null,
      replacedByPredicateId: null,
    },
    {
      predicateId: PREDICATE_IDS.careerStage,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["objective"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: { kind: "enum", closedSet: true, values: CAREER_STAGE_VALUES },
      scopeSchema: { kind: "none" },
      valueCardinality: "single",
      temporalSemantics: CURRENT_ENDED,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: null,
      replacedByPredicateId: null,
    },
    {
      predicateId: PREDICATE_IDS.familyStage,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["objective"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: { kind: "enum", closedSet: true, values: FAMILY_STAGE_VALUES },
      scopeSchema: { kind: "none" },
      valueCardinality: "single",
      temporalSemantics: CURRENT_ENDED,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: null,
      replacedByPredicateId: null,
    },

    // ── §4 偏好（2 条）──────────────────────────────────────────────
    {
      predicateId: PREDICATE_IDS.relationshipHorizon,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["objective"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: {
        kind: "enum",
        closedSet: true,
        values: enumValues({
          value: "long_term",
          zh: ["长期", "长期稳定的关系", "长期认真"],
          en: ["long_term", "long term", "long-term", "serious long term"],
        }),
      },
      scopeSchema: { kind: "none" },
      valueCardinality: "single",
      temporalSemantics: CURRENT_ENDED,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: null,
      replacedByPredicateId: null,
    },
    {
      predicateId: PREDICATE_IDS.businessTravel,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["objective"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: {
        kind: "sentiment",
        polarities: ["positive", "negative"],
      },
      scopeSchema: { kind: "none" },
      valueCardinality: "single",
      temporalSemantics: CURRENT_ENDED,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: null,
      replacedByPredicateId: null,
    },

    // ── §5 印象类（3 条，Portrait 弹药）──────────────────────────────────
    {
      // 双开：用户直接陈述（“我喜欢直接一点”）→ confirmed objective；AI 观察
      // 推断 → inferred impression，走全局印象门槛与复核周期。
      predicateId: PREDICATE_IDS.statedStyle,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["objective", "impression"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: TEXT_VALUE,
      scopeSchema: { kind: "none" },
      valueCardinality: "single",
      temporalSemantics: CURRENT_ENDED,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: REVIEW_POLICY_IMPRESSION_GLOBAL_V1,
      replacedByPredicateId: null,
    },
    {
      predicateId: PREDICATE_IDS.corePriorities,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["impression"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: TEXT_VALUE,
      scopeSchema: { kind: "none" },
      valueCardinality: "multiple",
      temporalSemantics: LONG_TERM_STABLE,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: REVIEW_POLICY_IMPRESSION_GLOBAL_V1,
      replacedByPredicateId: null,
    },
    {
      predicateId: PREDICATE_IDS.considerationStyle,
      registryVersion: 1,
      definitionVersion: 1,
      status: "active",
      allowedClaimKinds: ["impression"],
      sensitivityClass: "standard",
      allowedSubjectKindIds: ["sh.entity.person"],
      objectValueSchema: TEXT_VALUE,
      scopeSchema: { kind: "none" },
      valueCardinality: "single",
      temporalSemantics: LONG_TERM_STABLE,
      relationshipSemantics: null,
      evidencePolicyId: EVIDENCE_POLICY_GLOBAL_V1,
      reviewPolicyId: REVIEW_POLICY_IMPRESSION_GLOBAL_V1,
      replacedByPredicateId: null,
    },
  ];
  return Object.freeze(entries);
}
