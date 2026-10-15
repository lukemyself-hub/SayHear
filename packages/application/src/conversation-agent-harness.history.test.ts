import { describe, expect, it } from "vitest";

import {
  asCompiledContextId,
  asConversationEventRevisionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asModelRunAttemptId,
  asUserId,
} from "@sayhear/domain";

import {
  HISTORY_RECALL_CONVERSATION_HARNESS_POLICY,
  MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
} from "./conversation-action-catalog";
import {
  createConversationAgentHarness,
  type ConversationAgentHarnessRepository,
  type ConversationHarnessEvent,
} from "./conversation-agent-harness";
import type {
  ProviderEgressPort,
  ProviderEgressStreamEvent,
} from "./conversation-model";
import type { ConversationActionGateway } from "./conversation-action-gateway";
import {
  HISTORY_REVIEW_FUNCTION_NAME,
  type HistoryQueryProposal,
  type HistoryRecallGateway,
} from "./history-recall";
import { createRequestDeadline, type RequestDeadline } from "./request-deadline";

const userId = asUserId("01984477-1f9a-7d25-9d97-e588769566c0");
const generationCommandId = asGenerationCommandId("01984477-1f9a-7d25-9d97-e588769566c2");
const modelRunAttemptId = asModelRunAttemptId("01984477-1f9a-7d25-9d97-e588769566c4");
const requestEventRevisionId = asConversationEventRevisionId("01984477-1f9a-7d25-9d97-e588769566c7");
const answer = {
  generationCommandId: asGenerationCommandId("01984477-1f9a-7d25-9d97-e588769566d2"),
  modelRunAttemptId: asModelRunAttemptId("01984477-1f9a-7d25-9d97-e588769566d4"),
};
const proposal: HistoryQueryProposal = {
  endDate: "2026-08-20",
  kind: "review_dates",
  sourceScope: "conversation_text",
  startDate: "2026-08-20",
  timeBasis: "expressed_date",
};
const completed = {
  costMicros: 0,
  finishReason: "completed",
  inputTokens: 4,
  modelSnapshot: "m",
  outputTokens: 3,
  providerRequestId: "r",
  type: "completed",
} as const;
const actionProposal = {
  actionKind: "memory_forget_request",
  arguments: { targetAnchor: "那件事" },
  requestEventRevisionId,
  schemaVersion: "v1",
} as never;

function build(
  events: readonly ProviderEgressStreamEvent[],
  options: {
    /** Replaces the gateway's admit (a lookup that hangs or fails). */
    admit?: HistoryRecallGateway["admit"];
    deadline?: RequestDeadline;
    policy?: typeof HISTORY_RECALL_CONVERSATION_HARNESS_POLICY;
    request?: boolean;
  } = {},
) {
  const offered: string[][] = [];
  const settlements: string[] = [];
  const admitted: unknown[] = [];
  const historyAdmits: unknown[] = [];
  const egressPort: ProviderEgressPort = {
    async *stream(input) {
      offered.push((input.functions ?? []).map((definition) => definition.name));
      yield* events;
    },
  };
  const repository: ConversationAgentHarnessRepository = {
    async claimResponseExecution() { return "owner"; },
    async claimStaleResponseExecution() { throw new Error("no retry expected"); },
    async commitActionDecision() { admitted.push("decision-committed"); },
    async commitCompleteResponse() { throw new Error("must not commit a response"); },
    async loadResponse() { throw new Error("no replay"); },
    async settleResponseFailure(input) {
      settlements.push(input.category);
      return { category: input.category, outcome: "settled", status: "failed" };
    },
  };
  const historyRecall: HistoryRecallGateway = {
    async admit(input) {
      historyAdmits.push(input);
      if (options.admit) return options.admit(input);
      return {
        answer,
        coverage: { blocks: 0, blocksCovered: 0, limits: [], readThrough: null, timeBasis: "expressed_date", currentConversationRows: 0, enumeratedRows: 0, enumerationComplete: true, omitted: {}, pages: 1, perDate: [], readLatencyMs: 0, selectedRows: 0, selectedTokens: 0 },
        failureCode: null,
        status: "completed",
      };
    },
    async listPendingAnswers() { return []; },
  };
  const actionGateway = {
    async admit() {
      admitted.push("action-admitted");
      return { actionExecutionId: "a", actionKind: "memory_forget_request", admission: "accepted", catalogVersion: "c", disposition: null, execution: "succeeded", receiptSequence: 1, schemaVersion: "v1" };
    },
  } as unknown as ConversationActionGateway;
  const suppressed: unknown[] = [];
  const harness = createConversationAgentHarness({
    actionGateway,
    clock: () => new Date("2026-09-15T02:10:00.000Z"),
    delay: async () => undefined,
    egressPort,
    historyRecall,
    onHistoryQuerySuppressed: (info) => suppressed.push(info),
    repository,
  });
  const run = async () => {
    const collected: ConversationHarnessEvent[] = [];
    for await (const event of harness.runDecision({
      catalog: MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
      catalogVersion: MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG.version,
      compiledContextId: asCompiledContextId("01984477-1f9a-7d25-9d97-e588769566c3"),
      generationCommandId,
      harnessPolicy: options.policy ?? HISTORY_RECALL_CONVERSATION_HARNESS_POLICY,
      interactionTurnId: asInteractionTurnId("01984477-1f9a-7d25-9d97-e588769566c1"),
      modelRunAttemptId,
      ...(options.deadline ? { deadline: options.deadline } : {}),
      ...(options.request === false ? {} : { requestEventRevisionId }),
      userId,
    })) collected.push(event);
    return collected;
  };
  return { admitted, historyAdmits, offered, run, settlements, suppressed };
}

describe("Harness history review proposal (issue #314)", () => {
  it("offers the review function only under a history-enabled policy with a request revision", async () => {
    const enabled = build([{ delta: "ok", type: "delta" }, completed]);
    await enabled.run().catch(() => undefined);
    expect(enabled.offered[0]).toContain(HISTORY_REVIEW_FUNCTION_NAME);

    const catalogV2 = build([{ delta: "ok", type: "delta" }, completed], {
      policy: { ...HISTORY_RECALL_CONVERSATION_HARNESS_POLICY, maxHistoryQueries: 0 },
    });
    await catalogV2.run().catch(() => undefined);
    expect(catalogV2.offered[0]).not.toContain(HISTORY_REVIEW_FUNCTION_NAME);

    const noRequest = build([{ delta: "ok", type: "delta" }, completed], { request: false });
    await noRequest.run().catch(() => undefined);
    expect(noRequest.offered[0]).not.toContain(HISTORY_REVIEW_FUNCTION_NAME);
  });

  it("admits a lone proposal through the gateway and hands off to the answer stage without a reply", async () => {
    const t = build([{ proposal, type: "history_query_proposal" }, completed]);
    const events = await t.run();
    expect(events).toEqual([
      expect.objectContaining({ receipt: expect.objectContaining({ answer }), type: "history_recall_admitted" }),
    ]);
    expect(t.historyAdmits).toEqual([
      { context: { decisionCommandId: generationCommandId, modelRunAttemptId, requestEventRevisionId, userId }, proposal },
    ]);
    expect(t.admitted).toEqual([]);
  });

  it("hands the request deadline to the lookup and stops waiting for it when the deadline arrives", async () => {
    const deadline = createRequestDeadline({
      clock: () => new Date(),
      deadlineAt: new Date(Date.now() + 40),
    });
    try {
      const t = build([{ proposal, type: "history_query_proposal" }, completed], {
        // A lookup that never comes back (a stalled database).
        admit: () => new Promise(() => undefined),
        deadline,
      });
      const events = await t.run();
      expect(t.historyAdmits).toEqual([expect.objectContaining({ deadline })]);
      expect(events.at(-1)).toMatchObject({
        category: "timeout",
        interrupted: false,
        type: "decision_failed",
      });
      // Settled once as a timeout that is not retried.
      expect(t.settlements).toEqual(["timeout"]);
    } finally {
      deadline.release();
    }
  }, 3_000);

  it("fails closed when reply text precedes the proposal, and never reads", async () => {
    const t = build([{ delta: "let me look", type: "delta" }, { proposal, type: "history_query_proposal" }, completed]);
    const events = await t.run();
    expect(events.at(-1)).toMatchObject({ category: "invalid_response", type: "decision_failed" });
    expect(t.historyAdmits).toEqual([]);
  });

  it("fails closed on text after the proposal and on a second proposal", async () => {
    for (const events of [
      [{ proposal, type: "history_query_proposal" }, { delta: "x", type: "delta" }, completed],
      [{ proposal, type: "history_query_proposal" }, { proposal, type: "history_query_proposal" }, completed],
    ] as const) {
      const t = build(events);
      const out = await t.run();
      expect(out.at(-1)).toMatchObject({ category: "invalid_response", type: "decision_failed" });
      expect(t.historyAdmits).toEqual([]);
    }
  });

  it("gives the Trust-Control Action priority in either order and never reads history", async () => {
    for (const events of [
      [{ proposal: actionProposal, type: "action_proposal" }, { proposal, type: "history_query_proposal" }, completed],
      [{ proposal, type: "history_query_proposal" }, { proposal: actionProposal, type: "action_proposal" }, completed],
    ] as const) {
      const t = build(events);
      const out = await t.run();
      expect(out.map((event) => event.type)).toEqual(["action_admitted"]);
      expect(t.admitted).toEqual(["action-admitted", "decision-committed"]);
      expect(t.historyAdmits).toEqual([]);
      expect(t.suppressed).toEqual([{ generationCommandId, reason: "trust_control_priority" }]);
    }
  });

  it("rejects a proposal when tools are disabled", async () => {
    const t = build([{ proposal, type: "history_query_proposal" }, completed], {
      policy: { ...HISTORY_RECALL_CONVERSATION_HARNESS_POLICY, toolsDisabled: true },
    });
    const out = await t.run();
    expect(out.at(-1)).toMatchObject({ category: "invalid_response", type: "decision_failed" });
    expect(t.historyAdmits).toEqual([]);
  });

  it("fails the Decision closed when the gateway rejects the fence", async () => {
    const t = build([{ proposal, type: "history_query_proposal" }, completed]);
    // Rebuild with a rejecting gateway.
    const harness = createConversationAgentHarness({
      clock: () => new Date(),
      delay: async () => undefined,
      egressPort: { async *stream() { yield { proposal, type: "history_query_proposal" } as const; yield completed; } },
      historyRecall: { async admit() { return { outcome: "fence_rejected" } as const; }, async listPendingAnswers() { return []; } },
      repository: {
        async claimResponseExecution() { return "owner"; },
        async claimStaleResponseExecution() { throw new Error("x"); },
        async commitCompleteResponse() { throw new Error("x"); },
        async loadResponse() { throw new Error("x"); },
        async settleResponseFailure(input) { return { category: input.category, outcome: "settled", status: "failed" }; },
      },
    });
    const out: ConversationHarnessEvent[] = [];
    for await (const event of harness.runDecision({
      catalog: MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG,
      catalogVersion: MEMORY_TRUST_ACTIONS_CONVERSATION_ACTION_CATALOG.version,
      compiledContextId: asCompiledContextId("01984477-1f9a-7d25-9d97-e588769566c3"),
      generationCommandId,
      harnessPolicy: HISTORY_RECALL_CONVERSATION_HARNESS_POLICY,
      interactionTurnId: asInteractionTurnId("01984477-1f9a-7d25-9d97-e588769566c1"),
      modelRunAttemptId,
      requestEventRevisionId,
      userId,
    })) out.push(event);
    expect(out.at(-1)).toMatchObject({ category: "policy_blocked", type: "decision_failed" });
    expect(t.historyAdmits).toEqual([]);
  });
});
