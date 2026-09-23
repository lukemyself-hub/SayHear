import { describe, expect, it } from "vitest";

import {
  fingerprintReviewPayload,
  unblindV4,
  V4_REVIEW_PACKAGE,
  V4_REVIEW_PROTOCOL,
  V4_SCORE_VERSION,
  type V4ReviewInput,
} from "../eval/continuation-acceptance-1a3b/unblind-v4";
import {
  v4TargetWasMentioned,
  type V4TargetRef,
  type V4Turn,
} from "../eval/continuation-acceptance-1a3b/protocol-v4";

const categories = ["refusal", "short_answer", "topic_change", "direct_task"];
const omissionReasons = ["no_genuine_opportunity", "duplicates_main_response", "insufficient_grounding", "timing_not_natural"];

function mentionTurn(
  sequenceInScenario: number,
  mentionedTargets: readonly V4TargetRef[] = [],
): V4Turn {
  return {
    sequenceInScenario,
    userInput: {
      locale: "en-US",
      text: "A synthetic turn.",
      timezone: "America/Los_Angeles",
    },
    focusRequired: false,
    opportunity: "natural_gap",
    mentionedTargets,
    expect: { selection: "none" },
  };
}

function reviewFixture(): V4ReviewInput {
  const pairwiseCases = Array.from({ length: 15 }, (_, index) => {
    const candidateIsA = index % 2 === 0;
    return {
      caseId: `case-${String(index + 1).padStart(2, "0")}`,
      languageVariant: index < 8 ? "en" as const : index < 13 ? "zh" as const : "code_switch" as const,
      context: [],
      turns: [{
        sequence: 1,
        userText: "A synthetic turn.",
        date: { currentDate: "2026-09-23", elapsedDays: 0 },
        sharedResponse: "A frozen main response.",
        responseA: candidateIsA ? "Candidate addition." : null,
        responseB: candidateIsA ? null : "Candidate addition.",
      }],
    };
  });
  const omissionCases = Array.from({ length: 8 }, (_, index) => ({
    caseId: `omit-${String(index + 1).padStart(2, "0")}`,
    languageVariant: index % 3 === 0 ? "en" as const : index % 3 === 1 ? "zh" as const : "code_switch" as const,
    context: [],
    targetGrounding: "A synthetic target.",
    turns: [],
  }));
  const payload = {
    protocolVersion: V4_REVIEW_PROTOCOL,
    packageVersion: V4_REVIEW_PACKAGE,
    capturedDate: "2026-09-23",
    pairwiseCases,
    omissionCases,
  };
  const packageFingerprint = fingerprintReviewPayload(payload);
  const reviewPackage = {
    packageFingerprint,
    fingerprintKind: "rawSha256 of payload bytes" as const,
    payload,
  };
  const mappings = [
    ...pairwiseCases.map((item, index) => ({
      caseId: item.caseId,
      fixtureId: `synthetic-fixture-${index}`,
      family: index < 4 ? "positive_open_loop" : index < 8 ? "positive_memory" : index < 11 ? "stateful_suppression" : "competing_pool",
      topic: `topic-${Math.floor(index / 3)}`,
      targetKind: index < 4 ? "open_loop" as const : "memory_claim" as const,
      protectedCategories: [categories[index % categories.length]!],
      languageVariant: item.languageVariant,
      offIsA: index % 2 !== 0,
      candidateIsA: index % 2 === 0,
    })),
    ...omissionCases.map((item, index) => ({
      caseId: item.caseId,
      fixtureId: `synthetic-omission-${index}`,
      family: "omission_contract",
      targetKind: index % 2 === 0 ? "open_loop" as const : "memory_claim" as const,
      expectedOmissionReason: omissionReasons[index % omissionReasons.length]!,
      protectedCategories: [],
      languageVariant: item.languageVariant,
    })),
  ];
  const scores = {
    scoreVersion: V4_SCORE_VERSION,
    protocolVersion: V4_REVIEW_PROTOCOL,
    packageVersion: V4_REVIEW_PACKAGE,
    packageFingerprint,
    scorer: "tester",
    scoredAt: "2026-09-23T12:00:00.000Z",
    pairwiseDecisions: pairwiseCases.map((item, index) => ({
      caseId: item.caseId,
      turnDecisions: [{ sequence: 1, choice: index % 2 === 0 ? "A" as const : "B" as const }],
      sceneDecision: index % 2 === 0 ? "A" as const : "B" as const,
    })),
    omissionDecisions: omissionCases.map((item) => ({ caseId: item.caseId, choice: "silence_appropriate" as const })),
  };
  return { reviewPackage, scores, sealed: { packageFingerprint, mappings } };
}

describe("G2 v4 review and unblinding", () => {
  it("marks a target mentioned earlier in the current exchange", () => {
    const target = { kind: "memory_claim", memoryId: "memory-1" } as const;
    expect(v4TargetWasMentioned([mentionTurn(1, [target]), mentionTurn(2)], 2, target)).toBe(true);
    expect(v4TargetWasMentioned([mentionTurn(1, [target]), mentionTurn(2)], 1, {
      kind: "memory_claim",
      memoryId: "memory-2",
    })).toBe(false);
    expect(v4TargetWasMentioned([mentionTurn(1), mentionTurn(2, [target])], 1, target)).toBe(false);
  });

  it("counts candidate preference at scene level and keeps turn scores diagnostic", () => {
    const result = unblindV4(reviewFixture());
    expect(result.passed).toBe(true);
    expect(result.metrics.overallNet).toBe(15);
    expect(result.metrics.turnCandidateWins).toBe(15);
    expect(result.metrics.omissionSilenceAppropriate).toBe(8);
    expect(result.gates.noLanguageNetRegression).toBe(true);
    expect(result.gates.noProtectedCategoryNetRegression).toBe(true);
  });

  it("rejects package bytes or score files with a drifted fingerprint", () => {
    const fixture = reviewFixture();
    expect(() => unblindV4({
      ...fixture,
      scores: { ...fixture.scores, packageFingerprint: "sha256:stale" },
    })).toThrow(/fingerprint/);
  });

  it("fails the omission gate when a reviewer says a follow-up was due", () => {
    const fixture = reviewFixture();
    const omissionDecisions = [...fixture.scores.omissionDecisions];
    omissionDecisions[0] = { ...omissionDecisions[0]!, choice: "should_follow_up" };
    const result = unblindV4({ ...fixture, scores: { ...fixture.scores, omissionDecisions } });
    expect(result.gates.noOmissionShouldFollowUp).toBe(false);
    expect(result.passed).toBe(false);
  });
});
