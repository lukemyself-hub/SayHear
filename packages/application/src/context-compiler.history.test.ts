import {
  asCompiledContextId,
  asConversationEventRevisionId,
  asDailySessionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asUserId,
} from "@sayhear/domain";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CompiledContextIntegrityError,
  HISTORY_RECALL_TIME_COMPILER_VERSION,
  TIME_AWARE_CONTEXT_COMPILER_VERSION,
  createContextCompiler,
  type ContextCompilerRepository,
  type ContextPolicyVersions,
  type ContextSourceHistoryRecall,
  type ContextSourceSnapshot,
} from "./context-compiler";
import { HISTORY_ANSWER_TASK_INSTRUCTION_VERSION } from "./prompt-artifacts";

const userId = asUserId("01984477-59a9-7d20-9d97-e588769566e0");
const inputRevisionId = asConversationEventRevisionId("01984477-59a9-7d20-9d97-e588769566e1");
const oldSession = asDailySessionId("01984477-59a9-7d20-9d97-e588769566e2");
const oldUser = asConversationEventRevisionId("01984477-59a9-7d20-9d97-e588769566e3");
const oldAssistant = asConversationEventRevisionId("01984477-59a9-7d20-9d97-e588769566e4");

const policyVersions = (taskInstructionVersion: string): ContextPolicyVersions => ({
  canonicalPersonaVersion: "canonical-persona:v1",
  localePolicyVersion: "locale-pack-zh:v1",
  outputFormatVersion: "conversation-output:v2",
  personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
  personaContractInvariantVersion: "persona-contract-invariant:v1",
  productPolicyVersion: "product-policy:v1",
  relationshipPolicyVersion: "relationship-boundary:v1",
  safetyPolicyVersion: "minimum-high-risk-response:v1",
  taskInstructionVersion,
});

const historyRecall: ContextSourceHistoryRecall = {
  droppedAtCompile: 0,
  events: [
    {
      actor: "user",
      dailySessionId: oldSession,
      expressedAt: "2026-08-20T10:30:00.000Z",
      expressionTimezone: "Asia/Shanghai",
      expressionTimezoneSource: "request",
      locale: "zh-CN",
      revisionId: oldUser,
      sequence: 1,
      text: "老师傅教我缝帆布包。",
    },
    {
      actor: "assistant",
      dailySessionId: oldSession,
      expressedAt: "2026-08-20T10:30:09.000Z",
      expressionTimezone: "Asia/Shanghai",
      expressionTimezoneSource: "request",
      locale: "zh-CN",
      revisionId: oldAssistant,
      sequence: 2,
      text: "被夸手稳挺开心的。",
    },
  ],
  policyVersion: "history-recall:v1",
  result: {
    coverage: {
      blocks: 1,
      blocksCovered: 1,
      currentConversationRows: 0,
      limits: [],
      readThrough: null,
      timeBasis: "expressed_date",
      enumeratedRows: 2,
      enumerationComplete: true,
      omitted: {},
      pages: 1,
      perDate: [{ enumeratedRows: 2, localDate: "2026-08-20", selectedRows: 2, state: "complete" }],
      readLatencyMs: 4,
      selectedRows: 2,
      selectedTokens: 12,
    },
    failureCode: null,
    plan: {
      cutoff: "2026-09-15T02:10:00.000Z",
      dateCount: 1,
      readEndDate: "2026-08-20",
      readStartDate: "2026-08-20",
      endDate: "2026-08-20",
      localDates: ["2026-08-20"],
      startDate: "2026-08-20",
      timeBasis: "expressed_date",
      timezone: "Asia/Shanghai",
    },
    proposal: {
      endDate: "2026-08-20",
      kind: "review_dates",
      sourceScope: "conversation_text",
      startDate: "2026-08-20",
      timeBasis: "expressed_date",
    },
    status: "completed",
  },
  resultId: "01984477-59a9-7d20-9d97-e588769566e9",
};

function build(stage: "decision" | "history_answer", recall?: ContextSourceHistoryRecall) {
  let saved: Parameters<ContextCompilerRepository["saveCompiledContext"]>[0] | undefined;
  const snapshot: ContextSourceSnapshot = {
    commandCreatedAt: new Date("2026-09-15T02:10:00.000Z"),
    dailySession: {
      activityState: "active",
      closurePolicyVersion: "daily-session-inactivity:v1",
      continuousExchangeNo: 1,
      id: asDailySessionId("01984477-59a9-7d20-9d97-e588769566e5"),
    },
    dialogueRevision: 1,
    events: [
      {
        actor: "user",
        expressedAt: "2026-09-15T02:10:00.000Z",
        expressionTimezone: "Asia/Shanghai",
        expressionTimezoneSource: "request",
        locale: "zh-CN",
        revisionId: inputRevisionId,
        sequence: 1,
        text: "八月二十号我说了什么？",
      },
    ],
    generationStage: stage,
    ...(recall ? { historyRecall: recall } : {}),
    inputRevisionId,
    locale: "zh-CN",
    policyVersions: policyVersions(
      stage === "history_answer"
        ? HISTORY_ANSWER_TASK_INSTRUCTION_VERSION
        : "task-instruction-decision:v1",
    ),
    requestTimezone: "Asia/Shanghai",
    sourceRevision: 1,
  };
  const compiler = createContextCompiler({
    clock: () => new Date("2026-09-15T02:10:05.000Z"),
    compilerVersion: TIME_AWARE_CONTEXT_COMPILER_VERSION,
    contentHmacSecret: "history-answer-secret",
    rawEventTokenBudget: 4_000,
    repository: {
      async loadContextSource() {
        return snapshot;
      },
      async saveCompiledContext(input) {
        saved = input;
        return {
          degradedReason: input.degradedReason,
          dialogueRevision: input.dialogueRevision,
          id: asCompiledContextId("01984477-59a9-7d20-9d97-e588769566e6"),
          locale: input.locale,
          referencedRevisionIds: input.referencedEvents.map((event) => event.revisionId),
          sourceRevision: input.sourceRevision,
          statistics: {
            rawEventBudgetTokens: input.sectionBudgets.committedRawEvents,
            selectedEventCount: input.referencedEvents.length,
            totalTokens: input.totalTokens,
          },
        };
      },
    } satisfies ContextCompilerRepository,
  });
  const compile = () =>
    compiler.compile({
      generationCommandId: asGenerationCommandId("01984477-59a9-7d20-9d97-e588769566e7"),
      interactionTurnId: asInteractionTurnId("01984477-59a9-7d20-9d97-e588769566e8"),
      userId,
    });
  return { compile, compiler, saved: () => saved! };
}

describe("Context Compiler History Answer (issue #314)", () => {
  it("quotes the frozen review before the live conversation, with roles and times", async () => {
    const { compile, compiler, saved } = build("history_answer", historyRecall);
    await compile();
    const manifest = saved();
    expect(manifest.compilerVersion).toBe(HISTORY_RECALL_TIME_COMPILER_VERSION);
    expect(manifest.referencedEvents.map((event) => [event.section, event.revisionId])).toEqual([
      ["history_recall_context", oldUser],
      ["history_recall_context", oldAssistant],
      ["current_user_input", inputRevisionId],
    ]);
    const payload = compiler.renderPermittedPayload({ ...manifest, generationStage: "history_answer" });
    expect(payload.messages.map((message) => [message.role, message.text.split("\n").at(-1)])).toEqual([
      ["user", "老师傅教我缝帆布包。"],
      ["assistant", "被夸手稳挺开心的。"],
      ["user", "八月二十号我说了什么？"],
    ]);
    expect(payload.instructions).toContain("History review result");
    expect(payload.instructions).toContain("2026-08-20");
    // Times of the quoted messages are in the signed time context, in message order.
    expect(payload.instructions).toMatch(/1=2026-08-20 18:30/);
    expect(payload.instructions).not.toContain("老师傅教我缝帆布包");
  });

  it("marks nothing when no quoted message was corrected", async () => {
    const { compile, compiler, saved } = build("history_answer", historyRecall);
    await compile();
    const payload = compiler.renderPermittedPayload({ ...saved(), generationStage: "history_answer" });
    expect(payload.instructions).not.toMatch(/is the person's own correction of what they first wrote/);
    expect(payload.instructions).toContain("History reading rules (history-reading:v3)");
  });

  it("renders an empty or failed review honestly and still compiles", async () => {
    const empty: ContextSourceHistoryRecall = {
      ...historyRecall,
      events: [],
      result: {
        ...historyRecall.result,
        coverage: {
          ...historyRecall.result.coverage,
          enumeratedRows: 0,
          perDate: [{ enumeratedRows: 0, localDate: "2026-08-20", selectedRows: 0, state: "empty" }],
          selectedRows: 0,
        },
      },
    };
    const { compile, compiler, saved } = build("history_answer", empty);
    await compile();
    const payload = compiler.renderPermittedPayload({ ...saved(), generationStage: "history_answer" });
    expect(payload.instructions).toContain("empty; 0 message(s) found");
    expect(payload.messages).toHaveLength(1);
  });

  it("requires the frozen result for a History Answer and refuses it elsewhere", async () => {
    await expect(build("history_answer").compile()).rejects.toThrow(/frozen history recall/);
    await expect(build("decision", historyRecall).compile()).rejects.toThrow(/Only a History Answer/);
  });

  it("fails replay closed when the history sections are grafted onto an older format or stage", async () => {
    const { compile, compiler, saved } = build("history_answer", historyRecall);
    await compile();
    const manifest = saved();
    for (const grafted of [
      { ...manifest, compilerVersion: TIME_AWARE_CONTEXT_COMPILER_VERSION, generationStage: "history_answer" as const },
      { ...manifest, generationStage: "decision" as const },
    ]) {
      expect(() => compiler.renderPermittedPayload(grafted)).toThrow(CompiledContextIntegrityError);
    }
  });

  it("fails replay closed on a tampered reference or receipt", async () => {
    const { compile, compiler, saved } = build("history_answer", historyRecall);
    await compile();
    const manifest = saved();
    const withIntegrity = (override: Record<string, unknown>) => ({
      ...manifest,
      generationStage: "history_answer" as const,
      ...override,
    });
    const tamperedReceipt = manifest.sections.map((section) =>
      section.key === "history_recall_receipt"
        ? { ...section, reference: section.reference.replace('"completed"', '"failed"') }
        : section,
    );
    expect(() => compiler.renderPermittedPayload(withIntegrity({ sections: tamperedReceipt }))).toThrow(
      CompiledContextIntegrityError,
    );
    const droppedEvent = manifest.referencedEvents.filter((event) => event.revisionId !== oldAssistant);
    expect(() => compiler.renderPermittedPayload(withIntegrity({ referencedEvents: droppedEvent }))).toThrow(
      CompiledContextIntegrityError,
    );
  });
});

const restated = asConversationEventRevisionId("01984477-59a9-7d20-9d97-e588769566ea");
const afterwards = asConversationEventRevisionId("01984477-59a9-7d20-9d97-e588769566eb");

/**
 * The first message was corrected two days after it was said; a restatement of
 * the old wording sits right after it, and one more message came after the
 * correction was made.
 */
const correctedRecall: ContextSourceHistoryRecall = {
  ...historyRecall,
  events: [
    { ...historyRecall.events[0]!, correctedAt: "2026-08-22T03:15:00.000Z", text: "老师傅教我缝皮包。" },
    historyRecall.events[1]!,
    {
      ...historyRecall.events[0]!,
      expressedAt: "2026-08-20T10:34:00.000Z",
      revisionId: restated,
      sequence: 3,
      text: "对，帆布包，缝了一下午。",
    },
    {
      ...historyRecall.events[0]!,
      expressedAt: "2026-08-23T01:00:00.000Z",
      revisionId: afterwards,
      sequence: 4,
      text: "今天又去了一趟。",
    },
  ],
};

describe("earlier messages are marked where they stand (history-reading:v3)", () => {
  it("puts a recognisable mark with the local time it was said on every quoted earlier message, and none on the current one", async () => {
    const { compile, compiler, saved } = build("history_answer", historyRecall);
    await compile();
    const payload = compiler.renderPermittedPayload({ ...saved(), generationStage: "history_answer" });
    expect(payload.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "[Earlier message. They said this on 2026-08-20 18:30.]\n老师傅教我缝帆布包。"],
      ["assistant", "[Earlier message. You replied this on 2026-08-20 18:30.]\n被夸手稳挺开心的。"],
      ["user", "八月二十号我说了什么？"],
    ]);
    // The mark and the Times row of the same message state the same local minute.
    expect(payload.instructions).toMatch(/1=2026-08-20 18:30/);
    expect(JSON.stringify(payload.messages)).not.toMatch(/corrected it on|before they made/);
  });

  it("says on the corrected message itself that it is the corrected wording and when it was corrected", async () => {
    const { compile, compiler, saved } = build("history_answer", correctedRecall);
    await compile();
    const payload = compiler.renderPermittedPayload({ ...saved(), generationStage: "history_answer" });
    expect(payload.messages[0]!.text).toBe(
      "[Earlier message. They said this on 2026-08-20 18:30, then corrected it on 2026-08-22 11:15: the wording below is their corrected one and is what they stand by.]\n老师傅教我缝皮包。",
    );
    // The mark lives on the message; the instructions no longer point at it by number.
    expect(payload.instructions).not.toMatch(/Message \d+ is the person's own correction/);
    expect(payload.instructions).toContain("History reading rules (history-reading:v3)");
  });

  it("says on a message written before the correction was made that it came before it, and not on one written after", async () => {
    const { compile, compiler, saved } = build("history_answer", correctedRecall);
    await compile();
    const payload = compiler.renderPermittedPayload({ ...saved(), generationStage: "history_answer" });
    expect(payload.messages.map((message) => message.text).slice(1)).toEqual([
      "[Earlier message. You replied this on 2026-08-20 18:30.]\n被夸手稳挺开心的。",
      "[Earlier message. They said this on 2026-08-20 18:34, before they made the 2026-08-22 11:15 correction to their 2026-08-20 18:30 message. It is not a later change of mind: where it differs from that corrected message on the same point, the corrected message is how it stands.]\n对，帆布包，缝了一下午。",
      "[Earlier message. They said this on 2026-08-23 09:00.]\n今天又去了一趟。",
      "八月二十号我说了什么？",
    ]);
  });

  it("freezes when each wording was corrected without any message text, and replays the same payload", async () => {
    const { compile, compiler, saved } = build("history_answer", correctedRecall);
    await compile();
    const manifest = saved();
    const receipt = manifest.sections.find((section) => section.key === "history_recall_receipt")!;
    expect(JSON.parse(receipt.reference)).toMatchObject({
      corrections: [{ correctedAt: "2026-08-22T03:15:00.000Z", messageIndex: 1, timezone: "Asia/Shanghai" }],
      readingRulesVersion: "history-reading:v3",
    });
    for (const section of manifest.sections) {
      expect(section.reference).not.toMatch(/帆布包|皮包/);
    }
    const first = compiler.renderPermittedPayload({ ...manifest, generationStage: "history_answer" });
    const second = compiler.renderPermittedPayload({ ...manifest, generationStage: "history_answer" });
    expect(second).toEqual(first);
  });

  it("replays a result frozen with history-reading:v2 byte for byte: unmarked messages, the numbered correction line and the v2 rules", async () => {
    const { compiler } = build("history_answer", historyRecall);
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/history-answer-context-reading-v2-f179b3d.json", import.meta.url),
        "utf8",
      ),
    ) as { manifest: Parameters<typeof compiler.renderPermittedPayload>[0]; payload: unknown };
    expect(compiler.renderPermittedPayload(fixture.manifest)).toEqual(fixture.payload);
    expect(JSON.stringify(fixture.payload)).toContain("History reading rules (history-reading:v2)");
    expect(JSON.stringify(fixture.payload)).not.toContain("[Earlier message.");
  });
});
