import { describe, expect, it } from "vitest";

import {
  candidateDeadlineField,
  candidateLowFrequencyFields,
  candidateReviewAuthFailure,
  candidateReviewOutcomeTone,
  formatCandidateTimestamp,
  formatDeadlineRemaining,
  formatProposedObjectValue,
  isDeadlineOverdue,
  shortCandidateId,
} from "../apps/web/app/internal/candidate-review-presentation";

describe("candidate review presentation helpers", () => {
  it("shortens a candidate id without inventing characters", () => {
    expect(shortCandidateId("01984477-1f9a-7b25-a5cc-83c3b21fbc68")).toBe(
      "01984477…",
    );
    expect(shortCandidateId("short")).toBe("short");
  });

  it("formats deadline pressure in days and hours", () => {
    expect(formatDeadlineRemaining(null)).toBe("—");
    expect(formatDeadlineRemaining(-1)).toBe("已过期");
    expect(formatDeadlineRemaining(0)).toBe("0 日 0 小时");
    expect(formatDeadlineRemaining(2 * 86_400_000 + 3 * 3_600_000)).toBe(
      "2 日 3 小时",
    );
  });

  it("keeps the raw deadline kind in the always-visible label", () => {
    const field = candidateDeadlineField({
      deadlineKind: "review_30d",
      deadlineRemainingMs: 86_400_000,
    });
    expect(field.label).toBe("review_30d · 1 日 0 小时");
    expect(field.overdue).toBe(false);
    expect(field.kind).toBe("review_30d");
    expect(field.remainingMs).toBe(86_400_000);
  });

  it("flags an elapsed deadline for fail-closed treatment", () => {
    expect(isDeadlineOverdue(-5)).toBe(true);
    expect(isDeadlineOverdue(0)).toBe(false);
    expect(isDeadlineOverdue(null)).toBe(false);
    expect(
      candidateDeadlineField({
        deadlineKind: "terminal_7d",
        deadlineRemainingMs: -1,
      }).overdue,
    ).toBe(true);
  });

  it("renders nullable timestamps as a dash", () => {
    expect(formatCandidateTimestamp(null)).toBe("—");
    expect(formatCandidateTimestamp("2026-09-01T08:00:00.000Z")).toBe(
      "2026-09-01T08:00:00.000Z",
    );
  });

  it("serializes proposed object values without fabricating content", () => {
    expect(formatProposedObjectValue(null)).toBe("（无）");
    expect(formatProposedObjectValue(undefined)).toBe("（无）");
    expect(formatProposedObjectValue("plain")).toBe("plain");
    expect(formatProposedObjectValue({ kind: "text", maxLength: 200 })).toBe(
      '{"kind":"text","maxLength":200}',
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatProposedObjectValue(circular)).toBe("（无法序列化）");
  });

  it("collects low-frequency identifiers and JSON for the collapsed section", () => {
    const fields = candidateLowFrequencyFields({
      basis: "directly_stated",
      candidateId: "candidate-1",
      candidateKind: "objective",
      decidedAt: null,
      proposedObjectValue: { kind: "text" },
      proposedScopeKey: "",
    });
    expect(fields).toEqual([
      { label: "Candidate ID", value: "candidate-1" },
      { label: "Candidate 类型", value: "objective" },
      { label: "依据", value: "directly_stated" },
      { label: "Scope key", value: "—" },
      { label: "决定时间", value: "—" },
      { label: "提议对象值 (JSON)", value: '{"kind":"text"}' },
    ]);
  });

  it("only treats applied as a success tone, replays included", () => {
    expect(candidateReviewOutcomeTone("applied")).toBe("success");
    expect(candidateReviewOutcomeTone("already_disposed")).toBe("failure");
    expect(candidateReviewOutcomeTone("already_canceled")).toBe("failure");
    expect(candidateReviewOutcomeTone("review_deadline_passed")).toBe(
      "failure",
    );
    expect(
      candidateReviewOutcomeTone("model_free_text_is_never_a_code"),
    ).toBe("failure");
  });

  it("recognizes the outcomes that must clear the protected display", () => {
    expect(candidateReviewAuthFailure("unauthorized")).toBe(true);
    expect(candidateReviewAuthFailure("step_up_required")).toBe(true);
    expect(candidateReviewAuthFailure("recent_step_up_required")).toBe(true);
    expect(candidateReviewAuthFailure("already_disposed")).toBe(false);
    expect(candidateReviewAuthFailure("applied")).toBe(false);
  });
});
