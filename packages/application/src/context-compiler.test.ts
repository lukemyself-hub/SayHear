import {
  asCompiledContextId,
  asConversationEventRevisionId,
  asDailySessionId,
  asGenerationCommandId,
  asInteractionTurnId,
  asUserId,
} from "@sayhear/domain";
import { describe, expect, it } from "vitest";

import {
  CompiledContextIntegrityError,
  createContextCompiler,
  type ContextCompilerRepository,
} from "./context-compiler";

describe("Context Compiler", () => {
  it("uses a valid lagging DialogueState and only sends raw Events after its coverage", async () => {
    const userId = asUserId("01984477-59a9-7d20-9d97-e588769566c0");
    const dailySessionId = asDailySessionId(
      "01984477-59a9-7d20-9d97-e588769566a1",
    );
    const generationCommandId = asGenerationCommandId(
      "01984477-59a9-7d20-9d97-e588769566a2",
    );
    const interactionTurnId = asInteractionTurnId(
      "01984477-59a9-7d20-9d97-e588769566a3",
    );
    const coveredRevisionId = asConversationEventRevisionId(
      "01984477-59a9-7d20-9d97-e588769566a4",
    );
    const afterProjectionRevisionId = asConversationEventRevisionId(
      "01984477-59a9-7d20-9d97-e588769566a5",
    );
    const inputRevisionId = asConversationEventRevisionId(
      "01984477-59a9-7d20-9d97-e588769566a6",
    );
    let saved:
      | Parameters<ContextCompilerRepository["saveCompiledContext"]>[0]
      | undefined;
    const repository: ContextCompilerRepository = {
      async loadContextSource() {
        return {
          actionFinalizationReceipt: {
            admission: "accepted",
            disposition: null,
            execution: "pending",
            sequence: 1,
          },
          dailySession: {
            activityState: "active" as const,
            closurePolicyVersion: "daily-session-inactivity:v1",
            continuousExchangeNo: 1,
            id: dailySessionId,
          },
          dialogueRevision: 3,
          dialogueState: {
            content: {
              current_topic: {
                confidence: 0.8,
                sourceRevisionIds: [coveredRevisionId],
                value: "the meeting",
              },
              emotional_intensity: {
                confidence: 0.6,
                sourceRevisionIds: [coveredRevisionId],
                value: "moderate" as const,
              },
              advice_explicitly_requested: {
                confidence: 0.9,
                sourceRevisionIds: [coveredRevisionId],
                value: false,
              },
              current_request_requires_focus: {
                confidence: 0.7,
                sourceRevisionIds: [coveredRevisionId],
                value: false,
              },
              close_intent: {
                confidence: 0,
                sourceRevisionIds: [],
                value: null,
              },
              user_willing_to_elaborate: {
                confidence: 0.75,
                sourceRevisionIds: [coveredRevisionId],
                value: true,
              },
            },
            coveredThroughSequence: 1,
            dialogueRevision: 1,
            id: "01984477-59a9-7d20-9d97-e588769566a7",
            modelConfigVersion: "dialogue-state-model:v1",
            policyVersion: "dialogue-state:v1",
            promptVersion: "dialogue-state-prompt:v1",
            sourceRevision: 1,
            sourceRevisionIds: [coveredRevisionId],
            status: "lagging" as const,
            updatedAt: new Date("2026-08-13T11:59:00.000Z"),
            version: 1,
          },
          events: [
            {
              actor: "user" as const,
              locale: "en-US",
              revisionId: coveredRevisionId,
              sequence: 1,
              text: "The meeting was difficult.",
            },
            {
              actor: "assistant" as const,
              locale: "en-US",
              revisionId: afterProjectionRevisionId,
              sequence: 2,
              text: "I hear that it was difficult.",
            },
            {
              actor: "user" as const,
              locale: "en-US",
              revisionId: inputRevisionId,
              sequence: 3,
              text: "I want to keep talking about it.",
            },
          ],
          inputRevisionId,
          locale: "en-US",
          policyVersions: {
            localePolicyVersion: "locale-pack-en:v1",
            outputFormatVersion: "conversation-output:v1",
            personaVersion: "sayhear-persona:v1",
            productPolicyVersion: "product-policy:v1",
            relationshipPolicyVersion: "relationship-boundary:v1",
            safetyPolicyVersion: "minimum-high-risk-response:v1",
            taskInstructionVersion: "conversation-text:v1",
          },
          sourceRevision: 3,
        };
      },
      async saveCompiledContext(input) {
        saved = input;
        return {
          degradedReason: input.degradedReason,
          dialogueRevision: input.dialogueRevision,
          id: asCompiledContextId(
            "01984477-59a9-7d20-9d97-e588769566a8",
          ),
          locale: input.locale,
          referencedRevisionIds: input.referencedEvents.map(
            (event) => event.revisionId,
          ),
          sourceRevision: input.sourceRevision,
          statistics: {
            rawEventBudgetTokens: input.sectionBudgets.committedRawEvents,
            selectedEventCount: input.referencedEvents.length,
            totalTokens: input.totalTokens,
          },
        };
      },
    };
    const compiler = createContextCompiler({
      clock: () => new Date("2026-08-13T12:00:00.000Z"),
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "dialogue-state-context-secret",
      rawEventTokenBudget: 4_000,
      repository,
    });

    await compiler.compile({ generationCommandId, interactionTurnId, userId });

    expect(saved).toMatchObject({
      degradedReason: "dialogue_state_lagging",
      referencedEvents: [
        { revisionId: afterProjectionRevisionId, sequence: 2 },
        { revisionId: inputRevisionId, sequence: 3 },
      ],
      sections: expect.arrayContaining([
        expect.objectContaining({ key: "dialogue_state" }),
      ]),
    });
    const payload = compiler.renderPermittedPayload({
      compilerVersion: saved!.compilerVersion,
      integrity: saved!.integrity,
      locale: saved!.locale,
      policyVersions: saved!.policyVersions,
      referencedEvents: saved!.referencedEvents,
      sections: saved!.sections,
      totalTokens: saved!.totalTokens,
      actionFinalizationReceipt: {
        admission: "accepted",
        disposition: null,
        execution: "pending",
        sequence: 1,
      },
    });
    expect(payload.messages.map((message) => message.revisionId)).toEqual([
      afterProjectionRevisionId,
      inputRevisionId,
    ]);
    expect(payload.instructions).toContain("status=lagging");
    expect(payload.instructions).toContain("Do not use DialogueState confidence");
    expect(payload.instructions).toContain("Advice explicitly requested: false");
    expect(payload.instructions).toContain("listen and understand rather than advise");
    expect(payload.instructions).toContain("execution: pending");
    expect(payload.instructions).toContain("do not claim that a new Journal Version was generated");
  });

  it("permits advice only when the projection records an explicit request", async () => {
    const userId = asUserId("01984477-59a9-7d20-9d97-e588769566d0");
    const dailySessionId = asDailySessionId(
      "01984477-59a9-7d20-9d97-e588769566a1",
    );
    const generationCommandId = asGenerationCommandId(
      "01984477-59a9-7d20-9d97-e588769566a2",
    );
    const interactionTurnId = asInteractionTurnId(
      "01984477-59a9-7d20-9d97-e588769566a3",
    );
    const inputRevisionId = asConversationEventRevisionId(
      "01984477-59a9-7d20-9d97-e588769566a6",
    );
    let saved:
      | Parameters<ContextCompilerRepository["saveCompiledContext"]>[0]
      | undefined;
    const repository: ContextCompilerRepository = {
      async loadContextSource() {
        return {
          dailySession: {
            activityState: "active" as const,
            closurePolicyVersion: "daily-session-inactivity:v1",
            continuousExchangeNo: 1,
            id: dailySessionId,
          },
          dialogueRevision: 1,
          dialogueState: {
            content: {
              current_topic: {
                confidence: 0.8,
                sourceRevisionIds: [inputRevisionId],
                value: "the meeting",
              },
              emotional_intensity: {
                confidence: 0.6,
                sourceRevisionIds: [inputRevisionId],
                value: "moderate" as const,
              },
              advice_explicitly_requested: {
                confidence: 0.9,
                sourceRevisionIds: [inputRevisionId],
                value: true,
              },
              current_request_requires_focus: {
                confidence: 0,
                sourceRevisionIds: [],
                value: null,
              },
              close_intent: {
                confidence: 0,
                sourceRevisionIds: [],
                value: null,
              },
              user_willing_to_elaborate: {
                confidence: 0,
                sourceRevisionIds: [],
                value: null,
              },
            },
            coveredThroughSequence: 1,
            dialogueRevision: 1,
            id: "01984477-59a9-7d20-9d97-e588769566a7",
            modelConfigVersion: "dialogue-state-model:v1",
            policyVersion: "dialogue-state:v2",
            promptVersion: "dialogue-state-prompt:v2",
            sourceRevision: 1,
            sourceRevisionIds: [inputRevisionId],
            status: "current" as const,
            updatedAt: new Date("2026-08-13T11:59:00.000Z"),
            version: 1,
          },
          events: [
            {
              actor: "user" as const,
              locale: "en-US",
              revisionId: inputRevisionId,
              sequence: 1,
              text: "What should I do about the meeting?",
            },
          ],
          inputRevisionId,
          locale: "en-US",
          policyVersions: {
            localePolicyVersion: "locale-pack-en:v1",
            outputFormatVersion: "conversation-output:v1",
            personaVersion: "sayhear-persona:v1",
            productPolicyVersion: "product-policy:v1",
            relationshipPolicyVersion: "relationship-boundary:v1",
            safetyPolicyVersion: "minimum-high-risk-response:v1",
            taskInstructionVersion: "conversation-text:v1",
          },
          sourceRevision: 1,
        };
      },
      async saveCompiledContext(input) {
        saved = input;
        return {
          degradedReason: input.degradedReason,
          dialogueRevision: input.dialogueRevision,
          id: asCompiledContextId(
            "01984477-59a9-7d20-9d97-e588769566a8",
          ),
          locale: input.locale,
          referencedRevisionIds: input.referencedEvents.map(
            (event) => event.revisionId,
          ),
          sourceRevision: input.sourceRevision,
          statistics: {
            rawEventBudgetTokens: input.sectionBudgets.committedRawEvents,
            selectedEventCount: input.referencedEvents.length,
            totalTokens: input.totalTokens,
          },
        };
      },
    };
    const compiler = createContextCompiler({
      clock: () => new Date("2026-08-13T12:00:00.000Z"),
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "dialogue-state-context-secret",
      rawEventTokenBudget: 4_000,
      repository,
    });

    await compiler.compile({ generationCommandId, interactionTurnId, userId });

    expect(saved?.degradedReason).toBeNull();
    const dialogueStateSection = saved?.sections.find(
      (section) => section.key === "dialogue_state",
    );
    expect(dialogueStateSection?.reference).toContain("Advice explicitly requested: true");
    expect(dialogueStateSection?.reference).toContain("advice serving that request is permitted");
  });

  it("keeps the current User input and the newest contiguous history within budget", async () => {
    const userId = asUserId("01984477-59a9-7d20-9d97-e588769566a0");
    const dailySessionId = asDailySessionId(
      "01984477-59a9-7d20-9d97-e588769566a1",
    );
    const generationCommandId = asGenerationCommandId(
      "01984477-59a9-7d20-9d97-e588769566a2",
    );
    const interactionTurnId = asInteractionTurnId(
      "01984477-59a9-7d20-9d97-e588769566a3",
    );
    const oldestRevisionId = asConversationEventRevisionId(
      "01984477-59a9-7d20-9d97-e588769566a4",
    );
    const newestHistoryRevisionId = asConversationEventRevisionId(
      "01984477-59a9-7d20-9d97-e588769566a5",
    );
    const inputRevisionId = asConversationEventRevisionId(
      "01984477-59a9-7d20-9d97-e588769566a6",
    );
    let savedManifest: unknown;
    const repository: ContextCompilerRepository = {
      async loadContextSource() {
        return {
          dailySession: {
            activityState: "active" as const,
            closurePolicyVersion: "daily-session-inactivity:v1",
            continuousExchangeNo: 2,
            id: dailySessionId,
          },
          dialogueRevision: 7,
          events: [
            {
              actor: "user" as const,
              locale: "en-US",
              revisionId: oldestRevisionId,
              sequence: 4,
              text: "12345678901234567890",
            },
            {
              actor: "assistant" as const,
              locale: "en-US",
              revisionId: newestHistoryRevisionId,
              sequence: 5,
              text: "12345678",
            },
            {
              actor: "user" as const,
              locale: "en-US",
              revisionId: inputRevisionId,
              sequence: 6,
              text: "The current input remains even when it exceeds history budget.",
            },
          ],
          inputRevisionId,
          locale: "en-US",
          policyVersions: {
            localePolicyVersion: "locale-pack-en:v1",
            outputFormatVersion: "conversation-output:v1",
            personaVersion: "sayhear-persona:v1",
            productPolicyVersion: "product-policy:v1",
            relationshipPolicyVersion: "relationship-boundary:v1",
            safetyPolicyVersion: "minimum-high-risk-response:v1",
            taskInstructionVersion: "conversation-text:v1",
          },
          sourceRevision: 7,
        };
      },
      async saveCompiledContext(input) {
        savedManifest = input;
        return {
          degradedReason: "raw_event_budget_exceeded",
          dialogueRevision: 7,
          id: asCompiledContextId(
            "01984477-59a9-7d20-9d97-e588769566a7",
          ),
          locale: "en-US",
          referencedRevisionIds: [
            newestHistoryRevisionId,
            inputRevisionId,
          ],
          sourceRevision: 7,
          statistics: {
            rawEventBudgetTokens: 4,
            selectedEventCount: 2,
            totalTokens: 125,
          },
        };
      },
    };
    const compiler = createContextCompiler({
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "synthetic-context-integrity-secret",
      rawEventTokenBudget: 4,
      repository,
    });

    await compiler.compile({
      generationCommandId,
      interactionTurnId,
      userId,
    });

    expect(savedManifest).toMatchObject({
      degradedReason: "raw_event_budget_exceeded",
      dialogueRevision: 7,
      integrity: {
        algorithm: "hmac-sha256",
        contentHmac: expect.stringMatching(/^[a-f0-9]{64}$/),
        keyVersion: "context-integrity:v1",
      },
      policyVersions: {
        localePolicyVersion: "locale-pack-en:v1",
        outputFormatVersion: "conversation-output:v1",
        personaVersion: "sayhear-persona:v1",
        productPolicyVersion: "product-policy:v1",
        relationshipPolicyVersion: "relationship-boundary:v1",
        safetyPolicyVersion: "minimum-high-risk-response:v1",
        taskInstructionVersion: "conversation-text:v1",
      },
      referencedEvents: [
        {
          actor: "assistant",
          revisionId: newestHistoryRevisionId,
          section: "committed_raw_events",
          selectionOrder: 0,
          sequence: 5,
        },
        {
          actor: "user",
          revisionId: inputRevisionId,
          section: "current_user_input",
          selectionOrder: null,
          sequence: 6,
        },
      ],
      sectionBudgets: {
        committedRawEvents: 4,
      },
      sections: expect.arrayContaining([
        expect.objectContaining({
          key: "product_policy",
          reference: "product-policy:v1",
          truncatable: false,
        }),
        expect.objectContaining({
          key: "safety_policy",
          reference: "minimum-high-risk-response:v1",
          truncatable: false,
        }),
        expect.objectContaining({
          key: "relationship_boundary",
          reference: "relationship-boundary:v1",
          truncatable: false,
        }),
        expect.objectContaining({
          key: "persona",
          reference: "sayhear-persona:v1",
          truncatable: false,
        }),
        expect.objectContaining({
          key: "task_instruction",
          reference: "conversation-text:v1",
          truncatable: false,
        }),
        expect.objectContaining({
          key: "output_format",
          reference: "conversation-output:v1",
          truncatable: false,
        }),
        expect.objectContaining({
          key: "daily_session",
          reference:
            `${dailySessionId}:activity:active` +
            ":closure:daily-session-inactivity:v1:dialogue:7:exchange:2",
          truncatable: false,
        }),
        expect.objectContaining({
          budgetTokens: 4,
          key: "committed_raw_events",
          truncatable: true,
        }),
        expect.objectContaining({
          key: "current_user_input",
          reference: inputRevisionId,
          truncatable: false,
        }),
      ]),
      sourceRevision: 7,
    });
  });

  it("renders the permitted Provider payload from the frozen manifest", async () => {
    const userId = asUserId("01984477-59a9-7d20-9d97-e588769566b0");
    const inputRevisionId = asConversationEventRevisionId(
      "01984477-59a9-7d20-9d97-e588769566b1",
    );
    let manifest:
      | Parameters<
          ContextCompilerRepository["saveCompiledContext"]
        >[0]
      | undefined;
    const repository: ContextCompilerRepository = {
      async loadContextSource() {
        return {
          dailySession: {
            activityState: "active",
            closurePolicyVersion: "daily-session-inactivity:v1",
            continuousExchangeNo: 1,
            id: asDailySessionId(
              "01984477-59a9-7d20-9d97-e588769566b2",
            ),
          },
          dialogueRevision: 1,
          events: [
            {
              actor: "user",
              locale: "zh-CN",
              revisionId: inputRevisionId,
              sequence: 1,
              text: "今天有点难，但 I want to keep talking.",
            },
          ],
          inputRevisionId,
          locale: "zh-CN",
          policyVersions: {
            localePolicyVersion: "locale-pack-zh:v1",
            outputFormatVersion: "conversation-output:v1",
            personaVersion: "sayhear-persona:v1",
            productPolicyVersion: "product-policy:v1",
            relationshipPolicyVersion: "relationship-boundary:v1",
            safetyPolicyVersion: "minimum-high-risk-response:v1",
            taskInstructionVersion: "conversation-text:v1",
          },
          sourceRevision: 1,
        };
      },
      async saveCompiledContext(input) {
        manifest = input;
        return {
          degradedReason: null,
          dialogueRevision: 1,
          id: asCompiledContextId(
            "01984477-59a9-7d20-9d97-e588769566b3",
          ),
          locale: "zh-CN",
          referencedRevisionIds: [inputRevisionId],
          sourceRevision: 1,
          statistics: {
            rawEventBudgetTokens: 0,
            selectedEventCount: 1,
            totalTokens: input.totalTokens,
          },
        };
      },
    };
    const compiler = createContextCompiler({
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "synthetic-context-integrity-secret",
      rawEventTokenBudget: 0,
      repository,
    });
    await compiler.compile({
      generationCommandId: asGenerationCommandId(
        "01984477-59a9-7d20-9d97-e588769566b4",
      ),
      interactionTurnId: asInteractionTurnId(
        "01984477-59a9-7d20-9d97-e588769566b5",
      ),
      userId,
    });
    const capturedManifest = manifest;
    if (!capturedManifest) {
      throw new Error("The test manifest was not captured.");
    }

    const payload = compiler.renderPermittedPayload(capturedManifest);

    expect(payload.messages).toEqual([
      {
        revisionId: inputRevisionId,
        role: "user",
        text: "今天有点难，但 I want to keep talking.",
      },
    ]);
    expect(payload.instructions).toMatch(
      /Listen and understand by default[\s\S]*immediate real-world support[\s\S]*Distinguish user facts[\s\S]*locale \(zh-CN\)[\s\S]*daily_session=/,
    );
    expect(() =>
      compiler.renderPermittedPayload({
        ...capturedManifest,
        totalTokens: capturedManifest.totalTokens + 1,
      }),
    ).toThrow(CompiledContextIntegrityError);
  });
});
