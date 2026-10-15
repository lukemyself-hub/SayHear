import { describe, expect, it } from "vitest";

import {
  asCompiledContextId,
  asConversationEventId,
  asConversationEventRevisionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asUserId,
} from "@sayhear/domain";

import {
  EMPTY_CONVERSATION_ACTION_CATALOG,
  INITIAL_CONVERSATION_HARNESS_POLICY,
} from "./conversation-action-catalog";
import {
  createConversationAgentHarness,
  type ConversationAgentHarnessRepository,
  type ConversationHarnessEvent,
} from "./conversation-agent-harness";
import type {
  ProviderDispatchErrorCategory,
  ProviderEgressPort,
} from "./conversation-model";
import { createRequestDeadline, type RequestDeadline } from "./request-deadline";

/**
 * The first-token freshness probe runs before the first visible token (issue
 * #319). The Provider's first token is already recorded when it runs, so a
 * probe that cannot be answered is asked once more and then closes the
 * attempt as an interruption: nothing displayed, nothing committed, no
 * technical retry, an explicit Retry for the person.
 */

const command = {
  catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
  catalogVersion: EMPTY_CONVERSATION_ACTION_CATALOG.version,
  compiledContextId: asCompiledContextId("01984477-1f9a-7d25-9d97-e588769566c3"),
  generationCommandId: asGenerationCommandId("01984477-1f9a-7d25-9d97-e588769566c2"),
  harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
  interactionTurnId: asInteractionTurnId("01984477-1f9a-7d25-9d97-e588769566c1"),
  modelRunAttemptId: asModelRunAttemptId("01984477-1f9a-7d25-9d97-e588769566c4"),
  userId: asUserId("01984477-1f9a-7d25-9d97-e588769566c0"),
};

type Freshness = "current" | "deadline_exceeded" | "superseded";

function build(
  probes: ReadonlyArray<() => Promise<Freshness>>,
  options: { probeTimeoutMs?: number } = {},
) {
  const state = {
    claims: 0,
    commits: 0,
    probes: 0,
    settled: [] as Array<{
      category: ProviderDispatchErrorCategory;
      interrupted: boolean;
      noRetry: boolean;
    }>,
    unexpected: [] as unknown[],
  };
  const egressPort: ProviderEgressPort = {
    async *stream() {
      yield { delta: "a reply", type: "delta" };
      yield {
        costMicros: 0,
        finishReason: "completed",
        inputTokens: 1,
        modelSnapshot: "m",
        outputTokens: 1,
        providerRequestId: null,
        type: "completed",
      };
    },
  };
  const repository: ConversationAgentHarnessRepository = {
    async checkResponseFreshness() {
      const probe = probes[Math.min(state.probes, probes.length - 1)]!;
      state.probes += 1;
      return probe();
    },
    async claimResponseExecution() {
      return "owner";
    },
    async claimStaleResponseExecution() {
      state.claims += 1;
      throw new Error("no technical retry expected");
    },
    async commitCompleteResponse() {
      state.commits += 1;
      return {
        createdAt: "2026-09-15T02:10:00.000Z",
        eventId: asConversationEventId("01984477-1f9a-7d25-9d97-e588769566c5"),
        outcome: "committed",
        revisionId: asConversationEventRevisionId("01984477-1f9a-7d25-9d97-e588769566c6"),
      };
    },
    async loadResponse() {
      throw new Error("no replay");
    },
    async settleResponseFailure(input) {
      state.settled.push({
        category: input.category,
        interrupted: input.interrupted,
        noRetry: input.noRetry === true,
      });
      return {
        category: input.category,
        outcome: "settled",
        status: input.interrupted ? "interrupted" : "failed",
      };
    },
  };
  const harness = createConversationAgentHarness({
    clock: () => new Date("2026-09-15T02:10:00.000Z"),
    delay: async () => undefined,
    egressPort,
    ...(options.probeTimeoutMs ? { freshnessProbeTimeoutMs: options.probeTimeoutMs } : {}),
    jitter: () => 0,
    onUnexpectedFailure: (failure) => state.unexpected.push(failure),
    repository,
  });
  const run = async (deadline?: RequestDeadline) => {
    const events: ConversationHarnessEvent[] = [];
    for await (const event of harness.runDecision({
      ...command,
      ...(deadline ? { deadline } : {}),
    })) {
      events.push(event);
    }
    return events;
  };
  return { run, state };
}

const current = async (): Promise<Freshness> => "current";
const failing = async (): Promise<Freshness> => {
  throw Object.assign(new Error("connection lost"), { code: "57P01" });
};

describe("Harness first-token freshness probe", () => {
  it("shows and commits the reply when the probe says the request is still current", async () => {
    const t = build([current]);
    const events = await t.run();
    expect(events.map((event) => event.type)).toEqual(["decision_delta", "decision_committed"]);
    expect(t.state.probes).toBe(1);
  });

  it("asks again after one failed probe and then shows and commits normally", async () => {
    const t = build([failing, current]);
    const events = await t.run();
    expect(events.map((event) => event.type)).toEqual(["decision_delta", "decision_committed"]);
    expect(t.state.probes).toBe(2);
    expect(t.state.commits).toBe(1);
    expect(t.state.settled).toEqual([]);
  });

  it("shows and commits nothing when the probe fails twice, and ends as an interruption without a technical retry", async () => {
    const t = build([failing, failing]);
    const events = await t.run();
    // The stream says what the database will say: interrupted, not a retryable failure.
    expect(events).toEqual([
      { category: "unknown", interrupted: true, type: "decision_failed" },
    ]);
    expect(t.state.probes).toBe(2);
    expect(t.state.commits).toBe(0);
    expect(t.state.settled).toEqual([
      { category: "unknown", interrupted: true, noRetry: false },
    ]);
    expect(t.state.claims).toBe(0);
    // Content-free diagnostics still get the SQLSTATE.
    expect(t.state.unexpected).toEqual([
      expect.objectContaining({ databaseErrorCode: "57P01" }),
    ]);
  });

  it("counts a probe that takes too long as a failed probe", async () => {
    const hang = () => new Promise<Freshness>(() => undefined);
    const t = build([hang, hang], { probeTimeoutMs: 20 });
    const events = await t.run();
    expect(events).toEqual([
      { category: "unknown", interrupted: true, type: "decision_failed" },
    ]);
    expect(t.state.probes).toBe(2);
    expect(t.state.commits).toBe(0);
  });

  it("stops waiting for a hung probe at the request deadline", async () => {
    const deadline = createRequestDeadline({
      clock: () => new Date(),
      deadlineAt: new Date(Date.now() + 40),
    });
    try {
      const t = build([() => new Promise<Freshness>(() => undefined)]);
      const events = await t.run(deadline);
      expect(events).toEqual([
        { category: "timeout", interrupted: false, type: "decision_failed" },
      ]);
      // One probe only: an ended request is never probed again.
      expect(t.state.probes).toBe(1);
      expect(t.state.commits).toBe(0);
      expect(t.state.settled).toEqual([
        { category: "timeout", interrupted: false, noRetry: true },
      ]);
    } finally {
      deadline.release();
    }
  }, 3_000);

  it("ends a superseded request the same way it always did", async () => {
    const t = build([async () => "superseded"]);
    const events = await t.run();
    expect(events).toEqual([{ category: "aborted", interrupted: false, type: "decision_failed" }]);
    expect(t.state.commits).toBe(0);
  });
});
