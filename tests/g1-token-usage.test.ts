import { describe, expect, it } from "vitest";

import {
  parseG1TokenUsageArgs,
  summarizeG1TokenUsage,
  type G1UsageRow,
} from "../scripts/g1-token-usage";

function row(overrides: Partial<G1UsageRow> = {}): G1UsageRow {
  return {
    role: "episode.build",
    commandStatus: "succeeded",
    attemptStatus: "succeeded",
    maxOutputTokens: null,
    usage: {
      cachedTokens: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    },
    ...overrides,
  };
}

describe("G1 token usage aggregation", () => {
  it("sums each counter independently and never double counts reasoning into output", () => {
    const report = summarizeG1TokenUsage([
      row({
        usage: {
          cachedTokens: 2304,
          inputTokens: 1000,
          outputTokens: 100,
          reasoningTokens: 40,
          totalTokens: 146917,
        },
      }),
      row({
        usage: {
          cachedTokens: 0,
          inputTokens: 500,
          outputTokens: 200,
          reasoningTokens: 90,
          totalTokens: 700,
        },
      }),
    ]);

    expect(report.total.known).toEqual({
      cachedTokens: 2304,
      inputTokens: 1500,
      outputTokens: 300,
      reasoningTokens: 130,
      totalTokens: 147617,
    });
    // Reasoning is a separate axis, not part of the output total.
    expect(report.total.known.outputTokens).toBe(300);
  });

  it("counts unknown separately from a reported zero", () => {
    const report = summarizeG1TokenUsage([
      row({ usage: { ...row().usage, inputTokens: 0, outputTokens: null } }),
      row({ usage: { ...row().usage, inputTokens: null, outputTokens: 0 } }),
    ]);

    expect(report.total.known.inputTokens).toBe(0);
    expect(report.total.unknownCounts.inputTokens).toBe(1);
    expect(report.total.known.outputTokens).toBe(0);
    expect(report.total.unknownCounts.outputTokens).toBe(1);
  });

  it("includes failed, discarded, result-unknown, and retried attempts", () => {
    const report = summarizeG1TokenUsage([
      row({
        attemptStatus: "failed",
        commandStatus: "retry_pending",
        usage: { ...row().usage, outputTokens: 10 },
      }),
      row({
        attemptStatus: "discarded",
        commandStatus: "failed",
        usage: { ...row().usage, outputTokens: 20 },
      }),
      row({
        attemptStatus: "result_unknown",
        commandStatus: "failed",
        usage: { ...row().usage, outputTokens: null },
      }),
    ]);

    expect(report.attempts).toBe(3);
    expect(report.byAttemptStatus.failed?.attemptCount).toBe(1);
    expect(report.byAttemptStatus.discarded?.attemptCount).toBe(1);
    expect(report.byAttemptStatus.result_unknown?.attemptCount).toBe(1);
    expect(report.byCommandStatus.retry_pending?.attemptCount).toBe(1);
    expect(report.total.known.outputTokens).toBe(30);
  });

  it("flags the 80% and 95% cap boundaries without dividing by a missing cap", () => {
    const report = summarizeG1TokenUsage([
      row({ maxOutputTokens: 100, usage: { ...row().usage, outputTokens: 80 } }),
      row({ maxOutputTokens: 100, usage: { ...row().usage, outputTokens: 79 } }),
      row({ maxOutputTokens: 100, usage: { ...row().usage, outputTokens: 95 } }),
      row({ maxOutputTokens: null, usage: { ...row().usage, outputTokens: 1000 } }),
      row({ maxOutputTokens: 0, usage: { ...row().usage, outputTokens: 1000 } }),
    ]);

    expect(report.total.soft80Count).toBe(2); // 80 and 95
    expect(report.total.soft95Count).toBe(1); // 95 only
  });

  it("buckets by role, command status, and attempt status", () => {
    const report = summarizeG1TokenUsage([
      row({ role: "reflection.daily" }),
      row({ role: "narrative.validate", attemptStatus: "failed" }),
    ]);

    expect(Object.keys(report.byRole).sort()).toEqual([
      "narrative.validate",
      "reflection.daily",
    ]);
    expect(report.byRole["narrative.validate"]?.attemptCount).toBe(1);
    expect(report.byAttemptStatus.succeeded?.attemptCount).toBe(1);
  });

  it("defaults to the four active G1 roles and rejects retired roles", () => {
    expect(parseG1TokenUsageArgs(["--owner", "owner-1"]).roles).toEqual([
      "episode.build", "reflection.daily", "reflection.weekly", "narrative.validate",
    ]);
    for (const role of ["bio.write", "open_loop.extract", "proactive.followup"]) {
      expect(() => parseG1TokenUsageArgs(["--owner", "owner-1", "--role", role])).toThrow("model role");
    }
  });

  it("requires an explicit owner and rejects an unknown role", () => {
    expect(() => parseG1TokenUsageArgs([])).toThrow("--owner");
    expect(() =>
      parseG1TokenUsageArgs(["--owner", "owner-1", "--role", "not.a.role"]),
    ).toThrow("model role");
    expect(
      parseG1TokenUsageArgs([
        "--owner",
        "owner-1",
        "--role",
        "episode.build",
        "--summary",
      ]),
    ).toMatchObject({ owner: "owner-1", roles: ["episode.build"], summaryOnly: true });
  });
});
