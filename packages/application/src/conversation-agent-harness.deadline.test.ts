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
import type { CompleteResponseMetadata } from "./conversation-response";
import { createRequestDeadline } from "./request-deadline";

const userId = asUserId("01984477-1f9a-7d25-9d97-e588769566c0");
const command = {
  catalog: EMPTY_CONVERSATION_ACTION_CATALOG,
  catalogVersion: EMPTY_CONVERSATION_ACTION_CATALOG.version,
  compiledContextId: asCompiledContextId("01984477-1f9a-7d25-9d97-e588769566c3"),
  generationCommandId: asGenerationCommandId("01984477-1f9a-7d25-9d97-e588769566c2"),
  harnessPolicy: INITIAL_CONVERSATION_HARNESS_POLICY,
  interactionTurnId: asInteractionTurnId("01984477-1f9a-7d25-9d97-e588769566c1"),
  modelRunAttemptId: asModelRunAttemptId("01984477-1f9a-7d25-9d97-e588769566c4"),
  userId,
};
const completed: CompleteResponseMetadata & { type: "completed" } = {
  costMicros: null,
  finishReason: "completed",
  inputTokens: 4,
  modelSnapshot: "m",
  outputTokens: 3,
  providerRequestId: null,
  type: "completed",
};

/** A manual monotonic clock plus a timer wheel the test advances by hand. */
function fakeTime(startMs = Date.parse("2026-09-12T16:00:00.000Z")) {
  let now = startMs;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  return {
    clock: () => new Date(now),
    /** Move the clock without servicing timers (a stalled event loop). */
    skip(ms: number) {
      now += ms;
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers) {
        if (timer.live && timer.at <= now) {
          timer.live = false;
          timer.fn();
        }
      }
    },
    setTimer(fn: () => void, ms: number) {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  };
}

type Harnessed = {
  commits: number;
  settled: Array<{ category: ProviderDispatchErrorCategory; interrupted: boolean }>;
};

function build(
  time: ReturnType<typeof fakeTime>,
  egressPort: ProviderEgressPort,
): { harness: ReturnType<typeof createConversationAgentHarness>; state: Harnessed } {
  const state: Harnessed = { commits: 0, settled: [] };
  const repository: ConversationAgentHarnessRepository = {
    async claimResponseExecution() {
      return "owner";
    },
    async loadResponse() {
      throw new Error("unexpected loadResponse");
    },
    async claimStaleResponseExecution() {
      throw new Error("unexpected retry");
    },
    async commitCompleteResponse() {
      state.commits += 1;
      return {
        createdAt: time.clock().toISOString(),
        eventId: asConversationEventId("01984477-1f9a-7d25-9d97-e588769566c5"),
        outcome: "committed",
        revisionId: asConversationEventRevisionId("01984477-1f9a-7d25-9d97-e588769566c6"),
      };
    },
    async settleResponseFailure(input) {
      state.settled.push({ category: input.category, interrupted: input.interrupted });
      return {
        category: input.category,
        outcome: "settled",
        status: input.interrupted ? "interrupted" : "failed",
      };
    },
  };
  return {
    harness: createConversationAgentHarness({
      clock: time.clock,
      egressPort,
      jitter: () => 0.5,
      repository,
    }),
    state,
  };
}

async function collect(iterable: AsyncIterable<ConversationHarnessEvent>) {
  const events: ConversationHarnessEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const never = () => new Promise<never>(() => undefined);

describe("Conversation Agent Harness — 30 second request deadline (issue #319)", () => {
  it("stops a Provider call that ignores cancellation at the deadline and commits nothing", async () => {
    const time = fakeTime();
    const deadline = createRequestDeadline({
      clock: time.clock,
      deadlineAt: new Date(time.clock().getTime() + 30_000),
      setTimer: time.setTimer,
    });
    const { harness, state } = build(time, {
      // A stuck call that neither yields nor honours the abort signal.
      async *stream() {
        await never();
        yield completed;
      },
    });
    const pending = collect(harness.runDecision({ ...command, deadline }));
    time.advance(30_000);
    expect(await pending).toEqual([
      { category: "timeout", interrupted: false, type: "decision_failed" },
    ]);
    expect(state.commits).toBe(0);
    expect(state.settled).toEqual([{ category: "timeout", interrupted: false }]);
  });

  it("marks the reply interrupted and drops late tokens when the deadline passes after visible output", async () => {
    const time = fakeTime();
    const deadline = createRequestDeadline({
      clock: time.clock,
      deadlineAt: new Date(time.clock().getTime() + 30_000),
      setTimer: time.setTimer,
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { harness, state } = build(time, {
      async *stream() {
        yield { delta: "first ", type: "delta" } as const;
        await gate;
        yield { delta: "late", type: "delta" } as const;
        yield completed;
      },
    });
    const events: ConversationHarnessEvent[] = [];
    const pending = (async () => {
      for await (const event of harness.runDecision({ ...command, deadline })) events.push(event);
    })();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    time.advance(30_000);
    await pending;
    release();
    expect(events).toEqual([
      { delta: "first ", type: "decision_delta" },
      { category: "timeout", interrupted: true, type: "decision_failed" },
    ]);
    expect(state.commits).toBe(0);
  });

  it("does not dispatch anything when the deadline has already passed", async () => {
    const time = fakeTime();
    const deadline = createRequestDeadline({
      clock: time.clock,
      deadlineAt: new Date(time.clock().getTime() - 1),
      setTimer: time.setTimer,
    });
    let dispatched = 0;
    const { harness, state } = build(time, {
      async *stream() {
        dispatched += 1;
        yield completed;
      },
    });
    const events = await collect(harness.runDecision({ ...command, deadline }));
    expect(dispatched).toBe(0);
    expect(events).toEqual([{ category: "timeout", interrupted: false, type: "decision_failed" }]);
    expect(state.commits).toBe(0);
  });

  it("refuses to commit a result that finished after the deadline", async () => {
    const time = fakeTime();
    const deadline = createRequestDeadline({
      clock: time.clock,
      deadlineAt: new Date(time.clock().getTime() + 30_000),
      setTimer: time.setTimer,
    });
    const { harness, state } = build(time, {
      async *stream() {
        yield { delta: "done", type: "delta" } as const;
        // The clock passes the deadline without the timer having been serviced.
        time.skip(31_000);
        yield completed;
      },
    });
    const events = await collect(harness.runDecision({ ...command, deadline }));
    expect(state.commits).toBe(0);
    expect(events.at(-1)).toEqual({ category: "timeout", interrupted: true, type: "decision_failed" });
  });

  it("settles as aborted, not timeout, when the consumer cancels a stuck call", async () => {
    const time = fakeTime();
    const controller = new AbortController();
    const { harness, state } = build(time, {
      async *stream() {
        await never();
        yield completed;
      },
    });
    const pending = collect(harness.runDecision(command, controller.signal));
    controller.abort();
    expect(await pending).toEqual([
      { category: "aborted", interrupted: false, type: "decision_failed" },
    ]);
    expect(state.settled).toEqual([{ category: "aborted", interrupted: false }]);
  });
});
