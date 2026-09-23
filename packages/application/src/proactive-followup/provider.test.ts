import { describe, expect, it } from "vitest";

import { asUserId } from "@sayhear/domain";

import {
  classifyProactiveFollowupProviderError,
  validateProactiveFollowupDispositionModelOutput,
  validateProactiveFollowupSegmentModelOutput,
  type ProactiveFollowupDispositionModelRequest,
  type ProactiveFollowupSegmentModelRequest,
} from "./provider";
import type { ProactiveFollowupSegmentOutput } from "./segment";

const TEST_USER = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");

function segmentRequest(): ProactiveFollowupSegmentModelRequest {
  return {
    userId: TEST_USER,
    locale: "en-US",
    mainText: "That sounds like a full week already.",
    currentUserText: "It was a quiet evening.",
    currentTime: "2026-09-20T10:00:00.000Z",
    sessionTimeZone: "Europe/Berlin",
    targetKind: "open_loop",
    targetId: "loop-1",
    targetVersionId: "loop-version-1",
    targetRef: {
      targetKind: "open_loop",
      targetId: "loop-1",
      targetVersionId: "loop-version-1",
    },
    targetSummary: "Flight to Berlin next Friday",
    sourceUserText: "I am waiting to hear how the Berlin flight went.",
    targetContext: {
      source: "open_loop",
      evidenceAt: "2026-09-10T10:00:00.000Z",
      expectedStartAt: "2026-09-20T10:00:00.000Z",
      expectedEndAt: "2026-09-21T10:00:00.000Z",
      expectedTimePrecision: "date",
      expectedTimeZone: "Europe/Berlin",
      expiresAt: "2026-09-27T10:00:00.000Z",
      openLoopKind: "upcoming_event",
      subjectRole: "unknown",
    },
    targetSensitive: false,
    opportunity: "natural_gap",
  };
}

function dispositionRequest(): ProactiveFollowupDispositionModelRequest {
  return {
    userId: TEST_USER,
    locale: "en-US",
    userText: "Yeah, still on for Friday.",
    segmentText: "How did the Berlin flight go?",
    use: {
      useId: "use-1",
      assistantEventRevisionId: "assistant-revision-1",
      targetKind: "open_loop",
      targetId: "loop-1",
      targetVersionId: "loop-version-1",
    },
    finalTextLocator: {
      kind: "assistant_event_revision",
      assistantEventRevisionId: "assistant-revision-1",
      segment: "proactive_followup",
      ordinal: 0,
    },
  };
}

describe("proactive.followup provider contract (issue #207 layer 2c)", () => {
  it("accepts a well-formed segment output that echoes the requested target", () => {
    const request = segmentRequest();
    expect(
      validateProactiveFollowupSegmentModelOutput({
        request,
        output: {
          decision: "emit",
          content: "How did the Berlin flight go?",
          expressionKind: "question",
          targetRef: {
            targetId: "loop-1",
            targetKind: "open_loop",
            targetVersionId: "loop-version-1",
          },
        },
      }),
    ).toEqual({ outcome: "valid" });
  });

  it("rejects an empty segment", () => {
    expect(
      validateProactiveFollowupSegmentModelOutput({
        request: segmentRequest(),
        output: {
          decision: "emit",
          content: "   ",
          expressionKind: "acknowledgment",
          targetRef: {
            targetId: "loop-1",
            targetKind: "open_loop",
            targetVersionId: "loop-version-1",
          },
        },
      }),
    ).toEqual({ outcome: "invalid", reason: "empty" });
  });

  it("rejects a segment that does not echo the requested target", () => {
    expect(
      validateProactiveFollowupSegmentModelOutput({
        request: segmentRequest(),
        output: {
          decision: "emit",
          content: "Thinking of you.",
          expressionKind: "acknowledgment",
          targetRef: {
            targetId: "other-loop",
            targetKind: "open_loop",
            targetVersionId: "loop-version-9",
          },
        },
      }),
    ).toEqual({ outcome: "invalid", reason: "target_ref" });
  });

  it("rejects a segment with an unknown expression kind", () => {
    expect(
      validateProactiveFollowupSegmentModelOutput({
        request: segmentRequest(),
        output: {
          decision: "emit",
          content: "Thinking of you.",
          expressionKind: "nudge",
          targetRef: {
            targetId: "loop-1",
            targetKind: "open_loop",
            targetVersionId: "loop-version-1",
          },
        } as unknown as ProactiveFollowupSegmentOutput,
      }),
    ).toEqual({ outcome: "invalid", reason: "expression_kind" });
  });

  it("accepts a grounded omit that echoes the requested target", () => {
    expect(
      validateProactiveFollowupSegmentModelOutput({
        request: segmentRequest(),
        output: {
          decision: "omit",
          reason: "duplicates_main_response",
          targetRef: segmentRequest().targetRef,
        },
      }),
    ).toEqual({ outcome: "valid" });
  });

  it.each([
    "no_stop_signal",
    "short_response",
    "evaded",
    "refused",
    "topic_changed",
  ] as const)("accepts the model-proposable disposition signal %s", (signal) => {
    expect(
      validateProactiveFollowupDispositionModelOutput({
        request: dispositionRequest(),
        output: {
          signal,
          finalTextLocator: {
            kind: "assistant_event_revision",
            assistantEventRevisionId: "assistant-revision-1",
            segment: "proactive_followup",
            ordinal: 0,
          },
        },
      }),
    ).toEqual({ outcome: "valid" });
  });

  it("rejects ambiguous_closure from the model; only deterministic code records it", () => {
    expect(
      validateProactiveFollowupDispositionModelOutput({
        request: dispositionRequest(),
        output: {
          signal: "ambiguous_closure",
          finalTextLocator: {
            kind: "assistant_event_revision",
            assistantEventRevisionId: "assistant-revision-1",
            segment: "proactive_followup",
            ordinal: 0,
          },
        },
      }),
    ).toEqual({ outcome: "invalid", reason: "signal" });
  });

  it("rejects an unknown disposition signal", () => {
    expect(
      validateProactiveFollowupDispositionModelOutput({
        request: dispositionRequest(),
        output: {
          signal: "maybe_later",
          finalTextLocator: {
            kind: "assistant_event_revision",
            assistantEventRevisionId: "assistant-revision-1",
            segment: "proactive_followup",
            ordinal: 0,
          },
        },
      }),
    ).toEqual({ outcome: "invalid", reason: "signal" });
  });

  it("rejects a disposition whose locator does not match the committed use", () => {
    expect(
      validateProactiveFollowupDispositionModelOutput({
        request: dispositionRequest(),
        output: {
          signal: "short_response",
          finalTextLocator: {
            kind: "assistant_event_revision",
            assistantEventRevisionId: "other-revision",
            segment: "proactive_followup",
            ordinal: 0,
          },
        },
      }),
    ).toEqual({ outcome: "invalid", reason: "locator" });
  });

  it("rejects a locator that matches the use but not the requested echo", () => {
    const request = {
      ...dispositionRequest(),
      finalTextLocator: {
        kind: "assistant_event_revision" as const,
        assistantEventRevisionId: "assistant-revision-2",
        segment: "proactive_followup" as const,
        ordinal: 0 as const,
      },
    };
    expect(
      validateProactiveFollowupDispositionModelOutput({
        request,
        output: {
          signal: "short_response",
          finalTextLocator: {
            kind: "assistant_event_revision",
            assistantEventRevisionId: "assistant-revision-1",
            segment: "proactive_followup",
            ordinal: 0,
          },
        },
      }),
    ).toEqual({ outcome: "invalid", reason: "locator" });
  });

  it("maps transport categories onto terminal 1A.3b failure codes", () => {
    expect(
      classifyProactiveFollowupProviderError({ category: "timeout" }),
    ).toBe("timeout");
    expect(
      classifyProactiveFollowupProviderError({ category: "rate_limited" }),
    ).toBe("rate_limited");
    expect(
      classifyProactiveFollowupProviderError({ category: "unavailable" }),
    ).toBe("server_error");
    expect(
      classifyProactiveFollowupProviderError({ category: "authentication" }),
    ).toBe("authentication");
    expect(
      classifyProactiveFollowupProviderError({ category: "configuration" }),
    ).toBe("configuration");
    expect(
      classifyProactiveFollowupProviderError({ category: "policy_blocked" }),
    ).toBe("business_fence");
    expect(
      classifyProactiveFollowupProviderError({ category: "invalid_response" }),
    ).toBe("schema_incompatible");
    expect(classifyProactiveFollowupProviderError({})).toBe("result_unknown");
    expect(classifyProactiveFollowupProviderError(null)).toBe("result_unknown");
  });
});
