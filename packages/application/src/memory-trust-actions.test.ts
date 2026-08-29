import { describe, expect, it } from "vitest";

import {
  planMemoryCorrection,
  planTrustActionTargetResolution,
  type TrustActionResolutionCandidate,
} from "./memory-trust-actions";
import { RETRIEVAL_BROAD_TERM_STOP_LIST } from "./memory-retrieval/types";

function candidate(
  overrides: Partial<TrustActionResolutionCandidate> & { claimId: string },
): TrustActionResolutionCandidate {
  return {
    claimKind: "objective",
    claimVersionId: `${overrides.claimId}-v1`,
    entitySurfaceBindings: [],
    lexicalTerms: [],
    objectEntityId: null,
    predicateId: "sh.place.residence",
    predicateSurfaces: ["居住", "住在", "lives in"],
    subjectEntityId: "self-entity",
    typedValues: [],
    ...overrides,
  };
}

describe("planTrustActionTargetResolution (issue #119, ADR-0118)", () => {
  it("admits a unique value-exact hit", () => {
    const plan = planTrustActionTargetResolution({
      anchor: "我说了我住在上海",
      broadTerms: RETRIEVAL_BROAD_TERM_STOP_LIST,
      candidates: [
        candidate({
          claimId: "claim-residence",
          lexicalTerms: ["上海", "居住", "住在"],
          typedValues: ["上海"],
        }),
      ],
      labelIndex: [],
    });
    expect(plan.outcome).toBe("unique");
    if (plan.outcome === "unique") {
      expect(plan.target.claimId).toBe("claim-residence");
      expect(plan.signals).toContain("target_signal_value_exact");
    }
  });

  it("admits a unique entity + predicate joint hit", () => {
    const plan = planTrustActionTargetResolution({
      anchor: "我妈不是教师，别再说我妈教書",
      broadTerms: RETRIEVAL_BROAD_TERM_STOP_LIST,
      candidates: [
        candidate({
          claimId: "claim-mom",
          entitySurfaceBindings: [{ entityId: "entity-mom", surface: "我妈" }],
          lexicalTerms: ["我妈", "教师", "教书"],
          predicateId: "sh.work.role_title",
          predicateSurfaces: ["教师", "教书"],
        }),
      ],
      labelIndex: [{ entityId: "entity-mom", surface: "我妈" }],
    });
    expect(plan.outcome).toBe("unique");
    if (plan.outcome === "unique") {
      expect(plan.signals).toContain("target_signal_entity_predicate_joint");
    }
  });

  it("admits a unique two-independent-terms hit without value or entity signals", () => {
    const plan = planTrustActionTargetResolution({
      anchor: "我不在杭州办公",
      broadTerms: RETRIEVAL_BROAD_TERM_STOP_LIST,
      candidates: [
        candidate({
          claimId: "claim-office",
          lexicalTerms: ["杭州", "办公"],
          predicateSurfaces: [],
        }),
      ],
      labelIndex: [],
    });
    expect(plan.outcome).toBe("unique");
    if (plan.outcome === "unique") {
      expect(plan.signals).toContain("target_signal_two_independent_terms");
    }
  });

  it("returns a count-only multi-hit without preselecting", () => {
    const plan = planTrustActionTargetResolution({
      anchor: "关于上海的记忆不对",
      broadTerms: RETRIEVAL_BROAD_TERM_STOP_LIST,
      candidates: [
        candidate({
          claimId: "claim-residence",
          lexicalTerms: ["上海", "居住"],
          typedValues: ["上海"],
        }),
        candidate({
          claimId: "claim-trip",
          lexicalTerms: ["上海", "出差"],
          predicateId: "sh.plan.life_change",
          typedValues: ["上海"],
        }),
      ],
      labelIndex: [],
    });
    expect(plan).toEqual({ candidateCount: 2, outcome: "multi_hit" });
  });

  it("reports zero hits for a single weak overlap (no false admission)", () => {
    const plan = planTrustActionTargetResolution({
      anchor: "关于工作的事说错了",
      broadTerms: RETRIEVAL_BROAD_TERM_STOP_LIST,
      candidates: [
        candidate({
          claimId: "claim-office",
          lexicalTerms: ["工作", "办公"],
          predicateSurfaces: [],
        }),
      ],
      labelIndex: [],
    });
    expect(plan.outcome).toBe("zero_hit");
  });

  it("reports zero hits for an empty candidate set or empty anchor", () => {
    const empty = planTrustActionTargetResolution({
      anchor: "我说了我住在上海",
      broadTerms: [],
      candidates: [],
      labelIndex: [],
    });
    expect(empty.outcome).toBe("zero_hit");
    const blank = planTrustActionTargetResolution({
      anchor: "   ",
      broadTerms: [],
      candidates: [
        candidate({ claimId: "claim-1", lexicalTerms: ["上海"] }),
      ],
      labelIndex: [],
    });
    expect(blank.outcome).toBe("zero_hit");
  });

  it("treats a surface shared by two entities as ambiguous (no entity joint)", () => {
    const plan = planTrustActionTargetResolution({
      anchor: "大姐说的不对",
      broadTerms: RETRIEVAL_BROAD_TERM_STOP_LIST,
      candidates: [
        candidate({
          claimId: "claim-a",
          entitySurfaceBindings: [{ entityId: "entity-1", surface: "大姐" }],
          lexicalTerms: ["大姐"],
          predicateSurfaces: ["住"],
        }),
      ],
      labelIndex: [
        { entityId: "entity-1", surface: "大姐" },
        { entityId: "entity-2", surface: "大姐" },
      ],
    });
    // The ambiguous entity surface plus a lone predicate surface never admit.
    expect(plan.outcome).toBe("zero_hit");
  });

  it("matches ASCII surfaces on word boundaries only", () => {
    const plan = planTrustActionTargetResolution({
      anchor: "I never said I work at Homestead",
      broadTerms: RETRIEVAL_BROAD_TERM_STOP_LIST,
      candidates: [
        candidate({
          claimId: "claim-employer",
          lexicalTerms: ["home", "employer"],
          typedValues: ["home"],
        }),
      ],
      labelIndex: [],
    });
    // "home" must not fire inside "Homestead"; a single matched term
    // ("employer") stays below the two-independent-terms bar.
    expect(plan.outcome).toBe("zero_hit");
  });
});

describe("planMemoryCorrection (issue #119)", () => {
  it("supersedes an active objective claim and records establishment", () => {
    const plan = planMemoryCorrection({
      correctedFactPresent: true,
      snapshot: {
        claimId: "claim-1",
        currentVersion: {
          createdBy: "memory_admission",
          kind: "objective",
          revision: 3,
          status: "active",
          versionId: "v3",
        },
      },
    });
    expect(plan).toEqual({
      action: "supersede",
      claimKind: "objective",
      correctedFactRecorded: true,
      recordVeto: false,
    });
  });

  it("deactivates an active impression and records the user veto", () => {
    const plan = planMemoryCorrection({
      correctedFactPresent: false,
      snapshot: {
        claimId: "claim-2",
        currentVersion: {
          createdBy: "memory_admission",
          kind: "impression",
          revision: 1,
          status: "active",
          versionId: "v1",
        },
      },
    });
    expect(plan).toEqual({
      action: "supersede",
      claimKind: "impression",
      correctedFactRecorded: false,
      recordVeto: true,
    });
  });

  it("appends a version on the same logical claim for a repeated correction (story 48)", () => {
    const plan = planMemoryCorrection({
      correctedFactPresent: false,
      snapshot: {
        claimId: "claim-1",
        currentVersion: {
          createdBy: "memory_correction",
          kind: "objective",
          revision: 4,
          status: "superseded",
          versionId: "v4",
        },
      },
    });
    expect(plan).toEqual({
      action: "supersede",
      claimKind: "objective",
      correctedFactRecorded: false,
      recordVeto: false,
    });
  });

  it("converges on a non-active current version", () => {
    const plan = planMemoryCorrection({
      correctedFactPresent: false,
      snapshot: {
        claimId: "claim-3",
        currentVersion: {
          createdBy: "forget_request",
          kind: "objective",
          revision: 2,
          status: "retracted",
          versionId: "v2",
        },
      },
    });
    expect(plan).toEqual({
      action: "noop_already_converged",
      reasonCode: "claim_version_retracted",
    });
  });
});
