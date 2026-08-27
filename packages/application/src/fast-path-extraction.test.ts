import { describe, expect, it } from "vitest";

import {
  InvalidMemoryExtractProposalError,
  callWithRoleFallback,
  evaluatePriorClarification,
  itemDedupeKey,
  planClarificationCommit,
  planGateCommit,
  selectGateMentions,
  validateItemClass,
  validateMemoryExtractResult,
  type MemoryExtractRevisionResult,
  type MemoryRoleConfiguration,
} from "./fast-path-extraction";
import { homophoneFoldKey, normalizeEntityLabel } from "./entity";

const CANDIDATES = Object.freeze([
  Object.freeze({ entityId: "entity-a" }),
  Object.freeze({ entityId: "entity-b" }),
]);

describe("entity.resolve gate planning", () => {
  it("commits only on unique candidate ∧ match ∧ confidence ≥ t_auto", () => {
    const plan = planGateCommit({
      tAuto: 0.9,
      candidates: CANDIDATES,
      response: { verdict: "match", entityId: "entity-a", confidence: 0.95 },
    });
    expect(plan).toEqual({
      committed: true,
      boundEntityId: "entity-a",
      notCommittedReason: null,
    });
  });

  it("fails closed below the fixture-calibrated threshold", () => {
    const plan = planGateCommit({
      tAuto: 0.9,
      candidates: CANDIDATES,
      response: { verdict: "match", entityId: "entity-a", confidence: 0.85 },
    });
    expect(plan.committed).toBe(false);
    expect(plan.notCommittedReason).toBe("confidence_below_t_auto");
  });

  it("fails closed on a verdict that is not a match", () => {
    const plan = planGateCommit({
      tAuto: 0.9,
      candidates: CANDIDATES,
      response: { verdict: "unclear", entityId: "entity-a", confidence: 0.99 },
    });
    expect(plan.committed).toBe(false);
    expect(plan.notCommittedReason).toBe("verdict_not_match");
  });

  it("fails closed when the model selects an entity outside the candidate list", () => {
    const plan = planGateCommit({
      tAuto: 0.9,
      candidates: CANDIDATES,
      response: { verdict: "match", entityId: "entity-not-offered", confidence: 0.99 },
    });
    expect(plan.committed).toBe(false);
    expect(plan.notCommittedReason).toBe("selection_not_a_candidate");
  });

  it("fails closed on malformed gate responses", () => {
    const plan = planGateCommit({
      tAuto: 0.9,
      candidates: CANDIDATES,
      response: {
        verdict: "match",
        entityId: "entity-a",
        confidence: Number.NaN,
      },
    });
    expect(plan.committed).toBe(false);
    expect(plan.notCommittedReason).toBe("invalid_response");
  });
});

describe("gate mention selection", () => {
  it("selects only bounded ambiguity that survived the deterministic lanes", () => {
    const selected = selectGateMentions(
      [
        { resolutionStatus: "resolved", candidates: [] },
        { resolutionStatus: "ambiguous", candidates: [{ entityId: "a" }, { entityId: "b" }] },
        { resolutionStatus: "unresolved", candidates: [{ entityId: "a" }] },
        { resolutionStatus: "unresolved", candidates: [] },
        {
          resolutionStatus: "ambiguous",
          candidates: [
            { entityId: "a" },
            { entityId: "b" },
            { entityId: "c" },
            { entityId: "d" },
          ],
        },
      ],
      3,
    );
    expect(selected).toEqual([1, 2]);
  });
});

describe("session item marking and dedupe", () => {
  it("validates the five marking classes and falls back to open", () => {
    expect(validateItemClass("person")).toBe("person");
    expect(validateItemClass("preference")).toBe("preference");
    expect(validateItemClass("garbage")).toBe("open");
    expect(validateItemClass(null)).toBe("open");
  });

  it("dedupes on class plus normalized semantic key", () => {
    expect(
      itemDedupeKey({ itemClass: "person", semanticKey: " A|B " }),
    ).toBe(itemDedupeKey({ itemClass: "person", semanticKey: "a|b" }));
    expect(
      itemDedupeKey({ itemClass: "person", semanticKey: "a|b" }),
    ).not.toBe(itemDedupeKey({ itemClass: "event", semanticKey: "a|b" }));
  });
});

describe("entity clarification deterministic gate", () => {
  const proposal = Object.freeze({
    mentionIndex: 0,
    semanticImpact: "relationship_attribution",
    questionText: "Which Anna do you mean?",
  });

  it("commits only for ambiguous person mentions (semantic impact)", () => {
    expect(
      planClarificationCommit({
        proposal,
        mentionKindIsPerson: true,
        mentionIsAmbiguous: true,
      }).commit,
    ).toBe(true);
    expect(
      planClarificationCommit({
        proposal,
        mentionKindIsPerson: false,
        mentionIsAmbiguous: true,
      }).reasonCode,
    ).toBe("not_person_kind");
    expect(
      planClarificationCommit({
        proposal,
        mentionKindIsPerson: true,
        mentionIsAmbiguous: false,
      }).reasonCode,
    ).toBe("mention_not_ambiguous");
  });

  it("rejects malformed proposals deterministically", () => {
    expect(
      planClarificationCommit({
        proposal: { ...proposal, questionText: "  " },
        mentionKindIsPerson: true,
        mentionIsAmbiguous: true,
      }).reasonCode,
    ).toBe("invalid_proposal");
  });
});

describe("topic-scoped clarification stop", () => {
  it("resolves on a same-surface bind, keeps on re-mention, drops otherwise", () => {
    expect(
      evaluatePriorClarification({
        topicKey: "anna",
        currentRevisionText: "any text",
        currentRevisionBoundSurfaces: ["Anna"],
      }),
    ).toBe("resolved");
    expect(
      evaluatePriorClarification({
        topicKey: "anna",
        currentRevisionText: "about Anna again",
        currentRevisionBoundSurfaces: [],
      }),
    ).toBe("keep");
    expect(
      evaluatePriorClarification({
        topicKey: "anna",
        currentRevisionText: "let us talk about work",
        currentRevisionBoundSurfaces: [],
      }),
    ).toBe("dropped");
  });
});

describe("homophone folding (entity-resolution:v2)", () => {
  it("folds traditional kinship forms onto their simplified key", () => {
    expect(homophoneFoldKey("媽媽")).toBe(homophoneFoldKey("妈妈"));
  });

  it("folds common same-pinyin surname groups without exact-lane equality", () => {
    expect(homophoneFoldKey("张伟")).toBe(homophoneFoldKey("章伟"));
    expect(normalizeEntityLabel("张伟")).not.toBe(normalizeEntityLabel("章伟"));
  });

  it("leaves unrelated forms distinct", () => {
    expect(homophoneFoldKey("张伟")).not.toBe(homophoneFoldKey("李伟"));
  });
});

describe("memory.extract proposal validation", () => {
  const source = Object.freeze({ revisionId: "rev-1", text: "我妈妈住在上海。" });

  function result(overrides: Partial<MemoryExtractRevisionResult> = {}): MemoryExtractRevisionResult {
    return {
      revisionId: source.revisionId,
      evidence: [{ locatorKey: "0:7", role: "factual_support" }],
      mentions: [
        {
          surfaceForm: "我妈妈",
          startOffset: 0,
          endOffset: 3,
          mentionKind: "named",
          newIntroduction: false,
          entityKindId: "sh.entity.person",
          evidenceLocatorKey: "0:7",
        },
      ],
      candidates: [
        {
          basis: "directly_stated",
          candidateKind: "objective",
          predicateId: "sh.relationship.parent_of",
          proposedConcept: null,
          typedValue: "妈妈",
          scopeKey: "",
          subjectMentionIndex: null,
          objectMentionIndex: 0,
          evidenceLocatorKeys: ["0:7"],
          temporal: {
            temporalStatus: "current",
            validFrom: null,
            validFromPrecision: "unknown",
            validTo: null,
            validToPrecision: "unknown",
          },
          itemClass: "person",
          itemSummary: "mother lives in Shanghai",
        },
      ],
      clarifications: [],
      ...overrides,
    };
  }

  it("accepts a well-formed proposal", () => {
    expect(() => validateMemoryExtractResult(result(), source)).not.toThrow();
  });

  it("rejects out-of-range evidence spans", () => {
    expect(() =>
      validateMemoryExtractResult(
        result({
          evidence: [{ locatorKey: "5:999", role: "factual_support" }],
          candidates: [],
        }),
        source,
      ),
    ).toThrow(InvalidMemoryExtractProposalError);
  });

  it("rejects candidates citing unknown evidence locators", () => {
    expect(() =>
      validateMemoryExtractResult(
        result({
          candidates: [
            {
              ...result().candidates[0]!,
              evidenceLocatorKeys: ["9:12"],
            },
          ],
        }),
        source,
      ),
    ).toThrow(InvalidMemoryExtractProposalError);
  });

  it("rejects newIntroduction on non-named mentions", () => {
    expect(() =>
      validateMemoryExtractResult(
        result({
          mentions: [
            {
              ...result().mentions[0]!,
              mentionKind: "pronoun",
              newIntroduction: true,
            },
          ],
          candidates: [],
        }),
        source,
      ),
    ).toThrow(InvalidMemoryExtractProposalError);
  });

  it("rejects a result keyed to another revision", () => {
    expect(() =>
      validateMemoryExtractResult(
        result({ revisionId: "rev-other" }),
        source,
      ),
    ).toThrow(InvalidMemoryExtractProposalError);
  });
});

describe("per-role fallback discipline (ADR-0060)", () => {
  const configuration: MemoryRoleConfiguration = {
    role: "memory.extract",
    configVersion: "memory-extract:v1",
    modelVersion: "model-a",
    promptVersion: "memory-extract:propose:v1",
    fallback: {
      mode: "single_attempt",
      configVersion: "memory-extract:v1-fallback",
      modelVersion: "model-b",
      promptVersion: "memory-extract:propose:v1",
    },
  };

  it("allows at most one serial role_fallback attempt, never more", async () => {
    let calls = 0;
    const outcome = await callWithRoleFallback(async () => {
      calls += 1;
      if (calls === 1) throw new Error("primary failed");
      return "recovered";
    }, configuration);
    expect(outcome).toEqual({ result: "recovered", roleFallbackUsed: true });
    expect(calls).toBe(2);
  });

  it("fails loudly when the fallback also fails", async () => {
    let calls = 0;
    await expect(
      callWithRoleFallback(async () => {
        calls += 1;
        throw new Error("still failing");
      }, configuration),
    ).rejects.toThrow("still failing");
    expect(calls).toBe(2);
  });

  it("rethrows the primary error when fallback is disabled", async () => {
    let calls = 0;
    await expect(
      callWithRoleFallback(async () => {
        calls += 1;
        throw new Error("primary failed");
      }, { ...configuration, fallback: { mode: "disabled" } }),
    ).rejects.toThrow("primary failed");
    expect(calls).toBe(1);
  });
});
