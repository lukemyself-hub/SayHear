import { describe, expect, it } from "vitest";

import { validateProactiveFollowupSegmentOutput } from "./segment";
import type { ProactiveFollowupSegmentPlan } from "./segment";

const plan = {
  targetKind: "memory_claim",
  targetId: "claim-1",
  targetVersionId: "version-1",
} as ProactiveFollowupSegmentPlan;

const targetRef = {
  targetKind: "memory_claim" as const,
  targetId: "claim-1",
  targetVersionId: "version-1",
};

describe("proactive segment shared question budget", () => {
  it.each([
    ["你最近怎么样。", "你之前说的半马，准备得怎么样。"],
    ["How are you doing?", "半马准备得怎么样。"],
    ["你最近怎么样。", "How is the half marathon going?"],
  ])("rejects a second question without relying on Chinese punctuation", (mainText, content) => {
    expect(validateProactiveFollowupSegmentOutput({
      mainText,
      plan,
      output: { decision: "emit", content, expressionKind: "question", targetRef },
    })).toEqual({ outcome: "invalid", reason: "question_budget" });
  });

  it("accepts one unpunctuated Chinese question after a statement", () => {
    expect(validateProactiveFollowupSegmentOutput({
      mainText: "听起来这周不太容易。",
      plan,
      output: {
        decision: "emit",
        content: "你之前说的半马，准备得怎么样。",
        expressionKind: "question",
        targetRef,
      },
    })).toEqual({ outcome: "valid" });
  });

  it("rejects an unpunctuated question labelled as acknowledgment", () => {
    expect(validateProactiveFollowupSegmentOutput({
      mainText: "听起来这周不太容易。",
      plan,
      output: {
        decision: "emit",
        content: "半马准备得怎么样。",
        expressionKind: "acknowledgment",
        targetRef,
      },
    })).toEqual({ outcome: "invalid", reason: "expression_kind" });
  });

  it.each([
    "你想聊聊吗，我可以听。",
    "你最近怎么样，工作如何。",
  ])("does not let a Chinese question before a comma bypass the budget", (mainText) => {
    expect(validateProactiveFollowupSegmentOutput({
      mainText,
      plan,
      output: {
        decision: "emit",
        content: "半马准备得怎么样。",
        expressionKind: "question",
        targetRef,
      },
    })).toEqual({ outcome: "invalid", reason: "question_budget" });
  });
});
