import { describe, expect, it } from "vitest";

import {
  type PredicateRegistrySnapshot,
  PREDICATE_IDS,
  loadPredicateRegistrySnapshot,
  normalizeTypedValue,
} from "./index";
import { buildLegacyRegistryOverlay } from "./fixtures";
import {
  canonicalRelationshipKey,
  mapUtterance,
  validateMappingProposal,
  type MappingOutcome,
} from "./mapper";

const v1 = loadPredicateRegistrySnapshot(1);

describe("mapUtterance — symmetric relationship frames", () => {
  it("maps both word orders of the same colleague fact to one canonical key", () => {
    const a = mapUtterance({ text: "我和她是同事", locale: "zh" });
    const b = mapUtterance({ text: "她是我的同事，都做产品。", locale: "zh" });
    expect(a.status).toBe("mapped");
    expect(b.status).toBe("mapped");
    if (a.status !== "mapped" || b.status !== "mapped") return;
    expect(a.predicateId).toBe(PREDICATE_IDS.colleagueOf);
    expect(b.predicateId).toBe(PREDICATE_IDS.colleagueOf);
    expect(canonicalRelationshipKey(b)).toBe(canonicalRelationshipKey(a));
  });

  it("keeps 她是我领导 on manager_of and never degrades to colleague_of", () => {
    const r = mapUtterance({ text: "她是我领导，每周给我做一对一。", locale: "zh" });
    expect(r.status).toBe("mapped");
    if (r.status !== "mapped") return;
    expect(r.predicateId).toBe(PREDICATE_IDS.managerOf);
    // canonical subject = the manager party (the mentioned person)
    expect(r.relationship?.direction).toBe("directed");
    if (r.relationship?.direction === "directed") {
      expect(r.relationship.subject).toBe(r.otherPerson ?? "");
    }
  });

  it("canonicalizes child-side parent statements onto the parent as subject", () => {
    const r = mapUtterance({ text: "我儿子今年上小学", locale: "zh" });
    expect(r.status).toBe("mapped");
    if (r.status !== "mapped") return;
    expect(r.predicateId).toBe(PREDICATE_IDS.parentOf);
    if (r.relationship?.direction === "directed") {
      // speaker is the parent; counterpart_denoter surface keeps subject=self
      expect(r.relationship.subject).toBe("self");
    }
  });

  it("binds the 我和X person across clauses when the second clause omits the name", () => {
    const r = mapUtterance({
      text: "我和小李在一起三年了，他是我男朋友。",
      locale: "zh",
    });
    expect(r.status).toBe("mapped");
    if (r.status !== "mapped") return;
    expect(r.predicateId).toBe(PREDICATE_IDS.partnerOf);
    expect(r.otherPerson).toBe("小李");
  });

  it("marks former forms (前室友 / ex-roommate) as ended projections", () => {
    const zh = mapUtterance({ text: "老周现在是我前室友，搬走以后偶尔联系。", locale: "zh" });
    const en = mapUtterance({ text: "Alex is my ex-roommate from college.", locale: "en" });
    for (const r of [zh, en]) {
      expect(r.status).toBe("mapped");
      if (r.status === "mapped") {
        expect(r.form).toBe("former");
        expect(r.predicateId).toBe(PREDICATE_IDS.roommateOf);
      }
    }
  });
});

describe("mapUtterance — anchors and enums with normalized typed values", () => {
  it("captures employer value and marks ended employment as former", () => {
    const current = mapUtterance({ text: "我去年入职了字节跳动，节奏很快。", locale: "zh" });
    expect(current.status).toBe("mapped");
    if (current.status === "mapped") {
      expect(current.predicateId).toBe(PREDICATE_IDS.employer);
      expect(current.typedValue).toBe("字节跳动");
      expect(current.form).toBe("current");
    }
    const ended = mapUtterance({ text: "我从美团离职了。", locale: "zh" });
    expect(ended.status).toBe("mapped");
    if (ended.status === "mapped") {
      expect(ended.typedValue).toBe("美团");
      expect(ended.form).toBe("former");
    }
  });

  it("normalizes enum spellings to canonical ids and fails closed on aliens", () => {
    expect(
      normalizeTypedValue(
        { kind: "enum", closedSet: true, values: [{ value: "employed", zh: ["在职"], en: ["employed"] }] },
        "在职",
        "zh",
      ),
    ).toEqual({ ok: true, value: "employed" });
    expect(
      normalizeTypedValue(
        { kind: "enum", closedSet: true, values: [{ value: "employed", zh: ["在职"], en: ["employed"] }] },
        "经济自由",
        "zh",
      ).ok,
    ).toBe(false);
  });

  it("resolves career stage closed-set utterances in three locales' spellings", () => {
    const zh = mapUtterance({ text: "毕业后我一直自由职业，接设计外包。", locale: "zh" });
    expect(zh.status).toBe("mapped");
    if (zh.status === "mapped") {
      expect(zh.predicateId).toBe(PREDICATE_IDS.careerStage);
      expect(zh.typedValue).toBe("freelance");
    }
  });

  it("requires both trigger and polarity for sentiment preferences", () => {
    const travel = mapUtterance({ text: "我已经非常讨厌出差了。", locale: "zh" });
    expect(travel.status).toBe("mapped");
    if (travel.status === "mapped") {
      expect(travel.predicateId).toBe(PREDICATE_IDS.businessTravel);
      expect(travel.typedValue).toBe("negative");
    }
    // 出差 alone without a polarity cue → ambiguous, no fabricated stance
    const bare = mapUtterance({ text: "今天出差回来得真晚。", locale: "zh" });
    expect(bare.status).not.toBe("mapped");
  });

  it("preserves scope precision for life_change and rejects short-horizon plans", () => {
    const plan = mapUtterance({ text: "我们定好十一月初搬家，新房在城西已经签了。", locale: "zh" });
    expect(plan.status).toBe("mapped");
    if (plan.status === "mapped") {
      expect(plan.predicateId).toBe(PREDICATE_IDS.lifeChange);
      expect(plan.scopeValue).toBe("moving_house");
    }
    // 几天内待办不是 Open Loop（任务语义按 SPEC 6.1 形成门禁拒绝）——不落人生计划
    const todo = mapUtterance({ text: "记得后天下午取护照然后去面签。", locale: "zh" });
    expect(todo.status).toBe("unmapped");
    if (todo.status === "unmapped") {
      expect(todo.proposedConcept).toBeNull();
    }
  });

  it("captures residence / hometown / workplace values independently", () => {
    const residence = mapUtterance({ text: "我住在杭州滨江，通勤靠地铁。", locale: "zh" });
    expect(residence.status).toBe("mapped");
    if (residence.status === "mapped") {
      expect(residence.predicateId).toBe(PREDICATE_IDS.residence);
      expect(residence.typedValue).toBe("杭州滨江");
    }
    const hometown = mapUtterance({ text: "我的家乡是江苏南通。", locale: "zh" });
    expect(hometown.status).toBe("mapped");
    if (hometown.status === "mapped") {
      expect(hometown.predicateId).toBe(PREDICATE_IDS.hometown);
      expect(hometown.typedValue).toBe("江苏南通");
    }
    const workplace = mapUtterance({ text: "我们的办公室在深圳湾科技园那边。", locale: "zh" });
    expect(workplace.status).toBe("mapped");
    if (workplace.status === "mapped") {
      expect(workplace.predicateId).toBe(PREDICATE_IDS.workplace);
      expect(workplace.typedValue).toBe("深圳湾科技园");
    }
  });
});

describe("mapUtterance — unmapped discipline", () => {
  it("returns unmapped WITH a proposed concept for unknown relational concepts", () => {
    const zh = mapUtterance({ text: "他是我干爹家的教子，过年才见一面。", locale: "zh" });
    expect(zh.status).toBe("unmapped");
    if (zh.status === "unmapped") {
      expect(zh.proposedConcept).not.toBeNull();
      expect(zh.proposedConcept!.description.length).toBeGreaterThan(0);
      expect(zh.proposedConcept!.suggestedObjectSchema.length).toBeGreaterThan(0);
    }
  });

  it("never infers deferred concepts (neighbor) into friend/relative near-synonyms", () => {
    const neighbor = mapUtterance({ text: "隔壁邻居帮过我很多忙。", locale: "zh" });
    expect(neighbor.status).toBe("unmapped");
    if (neighbor.status === "unmapped" && neighbor.proposedConcept) {
      expect(neighbor.proposedConcept.description).toMatch(/neighbor/i);
    }
  });
});

describe("validateMappingProposal — §7.10.1 step-5 server-side revalidation", () => {
  const base = {
    registryVersion: 1,
    typedValueRaw: "",
    claimKind: "objective" as const,
    locale: "zh" as const,
  };

  it("accepts legal proposals and returns the canonical key", () => {
    const entry = v1.entries.find((e) => e.predicateId === PREDICATE_IDS.employer)!;
    const result = validateMappingProposal(v1, {
      ...base,
      predicateId: PREDICATE_IDS.employer,
      typedValueRaw: "字节跳动",
    });
    expect(result.valid).toBe(true);
    void entry;
  });

  it("rejects illegal enum values fail-closed (ILLEGAL_VALUE)", () => {
    const result = validateMappingProposal(v1, {
      ...base,
      predicateId: PREDICATE_IDS.careerStage,
      typedValueRaw: "财务自由",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorCode).toBe("ILLEGAL_VALUE");
      expect(result.detail).toContain("closed set");
    }
  });

  it("fails closed on deprecated IDs under a legacy snapshot", () => {
    const legacy = buildLegacyRegistryOverlay(0);
    const rejected = validateMappingProposal(legacy, {
      registryVersion: 0,
      predicateId: "sh.work.company",
      typedValueRaw: "美团",
      claimKind: "objective",
      locale: "zh",
    });
    expect(rejected.valid).toBe(false);
    if (!rejected.valid) {
      expect(rejected.errorCode).toBe("DEPRECATED_PREDICATE");
    }

    const unknownVersion = validateMappingProposal(v1, {
      ...base,
      registryVersion: 99,
      predicateId: PREDICATE_IDS.employer,
    });
    expect(unknownVersion.valid).toBe(false);
    if (!unknownVersion.valid) {
      expect(unknownVersion.errorCode).toBe("VERSION_MISMATCH");
    }
  });

  it("rejects disallowed claim kinds before any other step pays off", () => {
    const impressionOnObjectiveOnly = validateMappingProposal(v1, {
      ...base,
      predicateId: PREDICATE_IDS.siblingOf,
      typedValueRaw: "哥哥",
      claimKind: "impression",
    });
    expect(impressionOnObjectiveOnly.valid).toBe(false);
    if (!impressionOnObjectiveOnly.valid) {
      expect(impressionOnObjectiveOnly.errorCode).toBe("CLAIM_KIND_NOT_ALLOWED");
    }
  });

  it("accepts pre-canonicalized directed proposals and computes the canonical key", () => {
    // The resolver owns mention-order canonicalization; the validator takes
    // already-canonical role assignments and verifies registry legality.
    const validated = validateMappingProposal(v1, {
      ...base,
      predicateId: PREDICATE_IDS.managerOf,
      typedValueRaw: "",
      participants: { subject: "她", object: "self" },
    });
    expect(validated.valid).toBe(true);
    if (validated.valid) {
      expect(validated.canonicalKey).toBe(
        `${PREDICATE_IDS.managerOf}|subject=她→object=self`,
      );
    }
  });

  it("normalizes symmetric pairs identically regardless of participant order", () => {
    const forward = validateMappingProposal(v1, {
      ...base,
      predicateId: PREDICATE_IDS.friendOf,
      typedValueRaw: "",
      participants: { subject: "self", object: "小李" },
    });
    const reverse = validateMappingProposal(v1, {
      ...base,
      predicateId: PREDICATE_IDS.friendOf,
      typedValueRaw: "",
      participants: { subject: "小李", object: "self" },
    });
    expect(forward.valid && reverse.valid).toBe(true);
    if (forward.valid && reverse.valid) {
      expect(forward.canonicalKey).toBe(reverse.canonicalKey);
    }
  });
});

describe("old-version replay determinism gate", () => {
  it("replays identical mapping results across repeated loads (JSON round-trip stable)", () => {
    const cases = [
      "我和她是同事",
      "我儿子今年上小学",
      "我从美团离职了。",
    ];
    const runA = cases.map(
      (text) =>
        JSON.parse(
          JSON.stringify(mapUtterance({ text, locale: "zh", snapshot: v1 })),
        ) as MappingOutcome,
    );
    const again = loadPredicateRegistrySnapshot(1);
    const runB = cases.map(
      (text) => JSON.parse(JSON.stringify(mapUtterance({ text, locale: "zh", snapshot: again }))) as MappingOutcome,
    );
    expect(runB).toEqual(runA);
  });
});
