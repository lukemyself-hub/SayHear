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
  trustActionFencesMemory,
  type ContextCompilerRepository,
  type ContextPolicyVersions,
  type ContextSourceSnapshot,
} from "./context-compiler";
import {
  PromptArtifactResolutionError,
  RECALL_EXPERIENCE_CONTRACT_VERSION,
} from "./prompt-artifacts";

describe("Context Compiler", () => {
  it("fails the reply round's memory closed for terminal Trust Action outcomes", () => {
    const receipt = {
      actionKind: "memory_forget_reversal",
      admission: "accepted" as const,
      disposition: "reversal_precondition_failed",
      execution: "failed" as const,
      sequence: 2,
    };

    expect(trustActionFencesMemory(receipt)).toBe(true);
    expect(
      trustActionFencesMemory({ ...receipt, execution: "canceled" }),
    ).toBe(true);
    expect(
      trustActionFencesMemory({ ...receipt, execution: "succeeded" }),
    ).toBe(true);
    expect(
      trustActionFencesMemory({ ...receipt, execution: "running" }),
    ).toBe(false);
  });

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
            actionKind: "regenerate_journal",
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
          generationStage: "decision" as const,
          policyVersions: {
            canonicalPersonaVersion: "canonical-persona:v1",
            localePolicyVersion: "locale-pack-en:v1",
            outputFormatVersion: "conversation-output:v1",
            personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
            personaContractInvariantVersion: "persona-contract-invariant:v1",
            productPolicyVersion: "product-policy:v1",
            relationshipPolicyVersion: "relationship-boundary:v1",
            safetyPolicyVersion: "minimum-high-risk-response:v1",
            taskInstructionVersion: "task-instruction-decision:v1",
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
      generationStage: "decision",
      integrity: saved!.integrity,
      locale: saved!.locale,
      policyVersions: saved!.policyVersions,
      referencedEvents: saved!.referencedEvents,
      sections: saved!.sections,
      totalTokens: saved!.totalTokens,
      actionFinalizationReceipt: {
        actionKind: "regenerate_journal",
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
          generationStage: "decision" as const,
          policyVersions: {
            canonicalPersonaVersion: "canonical-persona:v1",
            localePolicyVersion: "locale-pack-en:v1",
            outputFormatVersion: "conversation-output:v1",
            personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
            personaContractInvariantVersion: "persona-contract-invariant:v1",
            productPolicyVersion: "product-policy:v1",
            relationshipPolicyVersion: "relationship-boundary:v1",
            safetyPolicyVersion: "minimum-high-risk-response:v1",
            taskInstructionVersion: "task-instruction-decision:v1",
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
          generationStage: "decision" as const,
          policyVersions: {
            canonicalPersonaVersion: "canonical-persona:v1",
            localePolicyVersion: "locale-pack-en:v1",
            outputFormatVersion: "conversation-output:v1",
            personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
            personaContractInvariantVersion: "persona-contract-invariant:v1",
            productPolicyVersion: "product-policy:v1",
            relationshipPolicyVersion: "relationship-boundary:v1",
            safetyPolicyVersion: "minimum-high-risk-response:v1",
            taskInstructionVersion: "task-instruction-decision:v1",
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
        canonicalPersonaVersion: "canonical-persona:v1",
        localePolicyVersion: "locale-pack-en:v1",
        outputFormatVersion: "conversation-output:v1",
        personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
        personaContractInvariantVersion: "persona-contract-invariant:v1",
        productPolicyVersion: "product-policy:v1",
        relationshipPolicyVersion: "relationship-boundary:v1",
        safetyPolicyVersion: "minimum-high-risk-response:v1",
        taskInstructionVersion: "task-instruction-decision:v1",
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
          key: "persona_contract_invariant",
          reference: "persona-contract-invariant:v1",
          truncatable: false,
        }),
        expect.objectContaining({
          key: "canonical_persona",
          reference: "canonical-persona:v1",
          truncatable: false,
        }),
        expect.objectContaining({
          key: "persona_behavior_anchors",
          reference: "persona-behavior-anchors:v1",
          truncatable: false,
        }),
        expect.objectContaining({
          key: "task_instruction",
          reference: "task-instruction-decision:v1",
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
          generationStage: "decision" as const,
          policyVersions: {
            canonicalPersonaVersion: "canonical-persona:v1",
            localePolicyVersion: "locale-pack-zh:v1",
            outputFormatVersion: "conversation-output:v1",
            personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
            personaContractInvariantVersion: "persona-contract-invariant:v1",
            productPolicyVersion: "product-policy:v1",
            relationshipPolicyVersion: "relationship-boundary:v1",
            safetyPolicyVersion: "minimum-high-risk-response:v1",
            taskInstructionVersion: "task-instruction-decision:v1",
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
    const capturedManifest = manifest
      ? { ...manifest, generationStage: "decision" as const }
      : undefined;
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
      /Listen and understand by default[\s\S]*immediate real-world support[\s\S]*Distinguish user facts[\s\S]*Canonical Persona[\s\S]*code-switching[\s\S]*daily_session=/,
    );
    expect(() =>
      compiler.renderPermittedPayload({
        ...capturedManifest,
        generationStage: "action_finalization",
      }),
    ).toThrow(PromptArtifactResolutionError);
    expect(() =>
      compiler.renderPermittedPayload({
        ...capturedManifest,
        totalTokens: capturedManifest.totalTokens + 1,
      }),
    ).toThrow(CompiledContextIntegrityError);
  });
});

describe("Context Compiler identity-layer fail-closed resolution", () => {
  const inputRevisionId = asConversationEventRevisionId(
    "01984477-59a9-7d20-9d97-e588769566d1",
  );

  function createSnapshot(
    policyVersions: ContextPolicyVersions,
    generationStage: ContextSourceSnapshot["generationStage"] = "decision",
  ): ContextSourceSnapshot {
    return {
      dailySession: {
        activityState: "active",
        closurePolicyVersion: "daily-session-inactivity:v1",
        continuousExchangeNo: 1,
        id: asDailySessionId("01984477-59a9-7d20-9d97-e588769566d2"),
      },
      dialogueRevision: 1,
      events: [
        {
          actor: "user",
          locale: "en-US",
          revisionId: inputRevisionId,
          sequence: 1,
          text: "The persona identity must never ship defaulted.",
        },
      ],
      generationStage,
      inputRevisionId,
      locale: "en-US",
      policyVersions,
      sourceRevision: 1,
    };
  }

  const supportedVersions: ContextPolicyVersions = {
    canonicalPersonaVersion: "canonical-persona:v1",
    localePolicyVersion: "locale-pack-en:v1",
    outputFormatVersion: "conversation-output:v1",
    personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
    personaContractInvariantVersion: "persona-contract-invariant:v1",
    productPolicyVersion: "product-policy:v1",
    relationshipPolicyVersion: "relationship-boundary:v1",
    safetyPolicyVersion: "minimum-high-risk-response:v1",
    taskInstructionVersion: "task-instruction-decision:v1",
  };

  function createCompilerWith(
    snapshot: ContextSourceSnapshot,
  ): Readonly<{
    compile: ReturnType<typeof createContextCompiler>["compile"];
    saved: () => boolean;
  }> {
    let saved = false;
    const compiler = createContextCompiler({
      clock: () => new Date("2026-08-22T12:00:00.000Z"),
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "identity-resolution-secret",
      rawEventTokenBudget: 4_000,
      repository: {
        async loadContextSource() {
          return snapshot;
        },
        async saveCompiledContext() {
          saved = true;
          throw new Error("A failed compile must not save a manifest.");
        },
      } satisfies ContextCompilerRepository,
    });
    return { compile: compiler.compile, saved: () => saved };
  }

  it("fails the compile closed when a persona block version is unresolvable", async () => {
    const { compile, saved } = createCompilerWith(
      createSnapshot({
        ...supportedVersions,
        canonicalPersonaVersion: "canonical-persona:vUnregistered",
      }),
    );
    const userId = asUserId("01984477-59a9-7d20-9d97-e588769566d0");
    await expect(
      compile({
        generationCommandId: asGenerationCommandId(
          "01984477-59a9-7d20-9d97-e588769566d3",
        ),
        interactionTurnId: asInteractionTurnId(
          "01984477-59a9-7d20-9d97-e588769566d4",
        ),
        userId,
      }),
    ).rejects.toThrow(PromptArtifactResolutionError);
    expect(saved()).toBe(false);
  });

  it("fails the compile closed when the locale pack version is unresolvable", async () => {
    const { compile, saved } = createCompilerWith(
      createSnapshot({
        ...supportedVersions,
        localePolicyVersion: "locale-pack-ko:v1",
      }),
    );
    const userId = asUserId("01984477-59a9-7d20-9d97-e588769566d0");
    await expect(
      compile({
        generationCommandId: asGenerationCommandId(
          "01984477-59a9-7d20-9d97-e588769566d3",
        ),
        interactionTurnId: asInteractionTurnId(
          "01984477-59a9-7d20-9d97-e588769566d4",
        ),
        userId,
      }),
    ).rejects.toThrow(PromptArtifactResolutionError);
    expect(saved()).toBe(false);
  });

  it("fails the compile closed when a GenerationCommand stage carries the other stage's task instruction", async () => {
    const { compile, saved } = createCompilerWith(
      createSnapshot(
        {
          ...supportedVersions,
          taskInstructionVersion: "task-instruction-action-finalization:v1",
        },
        "decision",
      ),
    );
    const userId = asUserId("01984477-59a9-7d20-9d97-e588769566d0");
    await expect(
      compile({
        generationCommandId: asGenerationCommandId(
          "01984477-59a9-7d20-9d97-e588769566d3",
        ),
        interactionTurnId: asInteractionTurnId(
          "01984477-59a9-7d20-9d97-e588769566d4",
        ),
        userId,
      }),
    ).rejects.toThrow(PromptArtifactResolutionError);
    expect(saved()).toBe(false);
  });
});

describe("Context Compiler Safety Posture enforcement", () => {
  const userId = asUserId("01984477-59a9-7d20-9d97-e588769566e0");
  const inputRevisionId = asConversationEventRevisionId(
    "01984477-59a9-7d20-9d97-e588769566e1",
  );

  function createSnapshotWithPosture(
    safetyPosture: NonNullable<ContextSourceSnapshot["safetyPosture"]> | null,
    locale = "en-US",
  ): ContextSourceSnapshot {
    return {
      dailySession: {
        activityState: "active",
        closurePolicyVersion: "daily-session-inactivity:v1",
        continuousExchangeNo: 2,
        id: asDailySessionId("01984477-59a9-7d20-9d97-e588769566e2"),
      },
      dialogueRevision: 1,
      events: [
        {
          actor: "user",
          locale,
          revisionId: inputRevisionId,
          sequence: 1,
          text: "I want to kill myself tonight.",
        },
      ],
      generationStage: "decision",
      inputRevisionId,
      locale,
      policyVersions: {
        canonicalPersonaVersion: "canonical-persona:v1",
        localePolicyVersion:
          locale === "zh-CN" ? "locale-pack-zh:v1" : "locale-pack-en:v1",
        outputFormatVersion: "conversation-output:v1",
        personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
        personaContractInvariantVersion: "persona-contract-invariant:v1",
        productPolicyVersion: "product-policy:v1",
        relationshipPolicyVersion: "relationship-boundary:v1",
        safetyPolicyVersion: "minimum-high-risk-response:v1",
        taskInstructionVersion: "task-instruction-decision:v1",
      },
      safetyPosture,
      sourceRevision: 2,
    };
  }

  function activePosture(
    cleanTurnCount = 0,
  ): NonNullable<ContextSourceSnapshot["safetyPosture"]> {
    return {
      content: {
        cleanTurnCount,
        evidence: {
          activatedUserEventRevisionId: asConversationEventRevisionId(
            "01984477-59a9-7d20-9d97-e588769566e3",
          ),
          lastTurnUserEventRevisionId: asConversationEventRevisionId(
            "01984477-59a9-7d20-9d97-e588769566e3",
          ),
        },
        kind: "self_harm",
        releasedBy: null,
        state: "active",
      },
      id: "01984477-59a9-7d20-9d97-e588769566e4",
      policyVersion: "safety-posture:v1",
      sourceRevision: 1,
      versionNo: 1,
    };
  }

  function createCompilerCapturing(
    snapshot: ContextSourceSnapshot,
  ): Readonly<{
    compiler: ReturnType<typeof createContextCompiler>;
    savedInput: () =>
      | Parameters<ContextCompilerRepository["saveCompiledContext"]>[0]
      | undefined;
  }> {
    let savedInput:
      | Parameters<ContextCompilerRepository["saveCompiledContext"]>[0]
      | undefined;
    const compiler = createContextCompiler({
      clock: () => new Date("2026-08-23T12:00:00.000Z"),
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "safety-posture-context-secret",
      rawEventTokenBudget: 4_000,
      repository: {
        async loadContextSource() {
          return snapshot;
        },
        async saveCompiledContext(input) {
          savedInput = input;
          return {
            degradedReason: input.degradedReason,
            dialogueRevision: input.dialogueRevision,
            id: asCompiledContextId("01984477-59a9-7d20-9d97-e588769566e5"),
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
      } satisfies ContextCompilerRepository,
    });
    return { compiler, savedInput: () => savedInput };
  }

  const compileInput = {
    generationCommandId: asGenerationCommandId(
      "01984477-59a9-7d20-9d97-e588769566e6",
    ),
    interactionTurnId: asInteractionTurnId("01984477-59a9-7d20-9d97-e588769566e7"),
    userId,
  };

  it("compiles the reduced persona variant and the anchor section while the posture is active", async () => {
    const { compiler, savedInput } = createCompilerCapturing(
      createSnapshotWithPosture(activePosture()),
    );
    await compiler.compile(compileInput);
    const saved = savedInput()!;
    const anchors = saved.sections.find(
      (section) => section.key === "persona_behavior_anchors",
    );
    expect(anchors?.reference).toBe("safety-posture-reduced-persona:v1");
    const posture = saved.sections.find(
      (section) => section.key === "safety_posture",
    );
    expect(posture?.reference).toContain("safety-posture:active");
    expect(posture?.reference).toContain("988");
    // The posture section sits directly after the reduced anchors.
    expect(posture?.ordinal).toBe((anchors?.ordinal ?? 0) + 1);
  });

  it("keeps ordinary persona and omits the posture section while default or released", async () => {
    for (const safetyPosture of [
      null,
      {
        ...activePosture(2),
        content: {
          ...activePosture(2).content,
          releasedBy: {
            userEventRevisionId: asConversationEventRevisionId(
              "01984477-59a9-7d20-9d97-e588769566e8",
            ),
          },
          state: "released" as const,
        },
      },
    ]) {
      const { compiler, savedInput } = createCompilerCapturing(
        createSnapshotWithPosture(safetyPosture),
      );
      await compiler.compile(compileInput);
      const saved = savedInput()!;
      expect(
        saved.sections.find((section) => section.key === "safety_posture"),
      ).toBeUndefined();
      expect(
        saved.sections.find(
          (section) => section.key === "persona_behavior_anchors",
        )?.reference,
      ).toBe("persona-behavior-anchors:v1");
    }
  });

  it("renders the zh anchor from the same whitelist and replays the frozen posture exactly at egress", async () => {
    const { compiler, savedInput } = createCompilerCapturing(
      createSnapshotWithPosture(activePosture(1), "zh-CN"),
    );
    await compiler.compile(compileInput);
    const saved = savedInput()!;
    const posture = saved.sections.find(
      (section) => section.key === "safety_posture",
    );
    expect(posture?.reference).toContain("12356");
    expect(posture?.reference).toContain("400-161-9995");
    // The Provider Egress re-derivation replays the frozen posture state —
    // including the reduced variant swap — without any re-read of state.
    const payload = compiler.renderPermittedPayload({
      compilerVersion: saved.compilerVersion,
      generationStage: "decision",
      integrity: saved.integrity,
      locale: saved.locale,
      policyVersions: saved.policyVersions,
      referencedEvents: saved.referencedEvents,
      sections: saved.sections,
      totalTokens: saved.totalTokens,
    });
    expect(payload.instructions).toContain("safety-posture:active");
    expect(payload.instructions).toContain("12356");
    expect(payload.instructions).toContain(
      "Persona behavior anchors — reduced variant",
    );
  });
});

describe("Context Compiler — memory sections (#117)", () => {
  const userId = asUserId("01984477-59a9-7d20-9d97-e588769566c0");
  const inputRevisionId = asConversationEventRevisionId(
    "01984477-59a9-7d20-9d97-e588769566c1",
  );

  function snapshot(): ContextSourceSnapshot {
    return {
      dailySession: {
        activityState: "active",
        closurePolicyVersion: "daily-session-inactivity:v1",
        continuousExchangeNo: 1,
        id: asDailySessionId("01984477-59a9-7d20-9d97-e588769566c2"),
      },
      dialogueRevision: 1,
      events: [
        {
          actor: "user",
          locale: "zh-CN",
          revisionId: inputRevisionId,
          sequence: 1,
          text: "我同事小王还好吗",
        },
      ],
      generationStage: "decision",
      inputRevisionId,
      locale: "zh-CN",
      policyVersions: {
        canonicalPersonaVersion: "canonical-persona:v1",
        localePolicyVersion: "locale-pack-zh:v1",
        outputFormatVersion: "conversation-output:v1",
        personaBehaviorAnchorsVersion: "persona-behavior-anchors:v1",
        personaContractInvariantVersion: "persona-contract-invariant:v1",
        productPolicyVersion: "product-policy:v1",
        relationshipPolicyVersion: "relationship-boundary:v1",
        safetyPolicyVersion: "minimum-high-risk-response:v1",
        taskInstructionVersion: "task-instruction-decision:v1",
      },
      sourceRevision: 1,
    };
  }

  function createCompilerWithMemory(
    outcome: import("./memory-retrieval/types").MemoryRetrievalRunOutcome,
  ) {
    let saved:
      | Parameters<ContextCompilerRepository["saveCompiledContext"]>[0]
      | undefined;
    const compiler = createContextCompiler({
      clock: () => new Date("2026-08-27T12:00:00.000Z"),
      compilerVersion: "context-compiler:v1",
      contentHmacSecret: "memory-sections-secret",
      rawEventTokenBudget: 4_000,
      repository: {
        async loadContextSource() {
          return snapshot();
        },
        async saveCompiledContext(input) {
          saved = input;
          return {
            degradedReason: input.degradedReason,
            dialogueRevision: input.dialogueRevision,
            id: asCompiledContextId("01984477-59a9-7d20-9d97-e588769566c3"),
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
      } satisfies ContextCompilerRepository,
      memoryRetrieval: {
        async run() {
          return outcome;
        },
      },
    });
    return {
      compiler,
      saved: () => saved!,
    };
  }

  function completedOutcomeWithItems(): import("./memory-retrieval/types").MemoryRetrievalRunOutcome {
    return {
      retrievalRunId: "retrieval-run-1",
      status: "completed",
      degradedReasonCodes: [],
      manifest: {
        retrieval_run_id: "retrieval-run-1",
        retrieval_policy_version: "memory-retrieval:v1",
        query_construction_policy_version: "memory-retrieval-query:v1",
        projection_policy_version: "claim-retrieval-projection:v1",
        deadline_ms: 200,
        query_source_refs: [],
        normalized_query_terms: {
          lexical_terms: [],
          resolved_entities: [],
          predicate_candidates: [],
          canonical_keys: [],
          time_word_classes: [],
          date_tokens: [],
        },
        lane_plan: [],
        lane_hit_counts: {
          structured_exact: 0,
          lexical_term_overlap: 0,
          english_fts: 0,
        },
        zero_signal: true,
        candidate_count: 0,
        qualified_count: 0,
        fenced_out_count: 0,
        selection_policy_versions: {
          portrait_selection: "portrait-selection:v1",
          memory_budgets: "memory-budgets:v1",
          recall_framing: "recall-framing:v1",
        },
        section_budget_vs_actual: {
          person_portrait: {
            ceiling_items: 3,
            ceiling_impressions: 2,
            actual_items: 2,
            actual_impressions: 1,
          },
          query_retrieved: {
            ceiling_items: 2,
            ceiling_impressions: 1,
            actual_items: 1,
            actual_impressions: 0,
          },
          memory_class_total: { ceiling_items: 5, actual_items: 3 },
        },
        portrait_selection: {
          pool_count: 2,
          selected_claim_version_ids: ["version-p1", "version-p2"],
        },
        portrait_degraded_reason_codes: [],
        timings: {},
        duration_ms: 5,
        deadline_exceeded_stage: null,
        degraded_reason_codes: [],
      },
      memorySections: {
        person_portrait: [
          {
            contextMemoryRef: "shh-memory-1",
            renderedText: "Luke：工作单位：Acme",
            claimId: "claim-p1",
            claimVersionId: "version-p1",
            predicateId: "sh.work.employer",
            kind: "objective",
            epistemicStatus: "confirmed",
            temporalStatus: "current",
            validFrom: null,
            validTo: null,
            entityVersionIds: ["entity-version-self"],
            evidenceIds: ["evidence-a"],
            recallFramingPolicyVersion: "recall-framing:v1",
            selectionSource: "person_portrait",
          },
          {
            contextMemoryRef: "shh-memory-2",
            renderedText: "Luke：核心价值观：家庭",
            claimId: "claim-p2",
            claimVersionId: "version-p2",
            predicateId: "sh.value.core_priorities",
            kind: "impression",
            epistemicStatus: "inferred",
            temporalStatus: "current",
            validFrom: null,
            validTo: null,
            entityVersionIds: ["entity-version-self"],
            evidenceIds: ["evidence-b", "evidence-c"],
            recallFramingPolicyVersion: "recall-framing:v1",
            selectionSource: "person_portrait",
          },
        ],
        objective_memory: [
          {
            contextMemoryRef: "shh-memory-3",
            renderedText: "Luke 与 小王 · 同事",
            claimId: "claim-r1",
            claimVersionId: "version-r1",
            predicateId: "sh.relationship.colleague_of",
            kind: "objective",
            epistemicStatus: "confirmed",
            temporalStatus: "current",
            validFrom: null,
            validTo: null,
            entityVersionIds: ["entity-version-self", "entity-version-wang"],
            evidenceIds: ["evidence-d"],
            recallFramingPolicyVersion: "recall-framing:v1",
            selectionSource: "query_retrieval",
          },
        ],
        ai_impression: [],
      },
    };
  }

  it("compiles the three memory sections and replays them exactly at egress", async () => {
    const { compiler, saved } = createCompilerWithMemory(
      completedOutcomeWithItems(),
    );
    await compiler.compile({
      generationCommandId: asGenerationCommandId(
        "01984477-59a9-7d20-9d97-e588769566c4",
      ),
      interactionTurnId: asInteractionTurnId(
        "01984477-59a9-7d20-9d97-e588769566c5",
      ),
      userId,
    });
    const input = saved();
    const keys = input.sections.map((section) => section.key);
    // Empty ai_impression is omitted; the two populated sections sit between
    // the session-state sections and the raw Events.
    expect(keys).toEqual(
      expect.arrayContaining([
        "person_portrait",
        "objective_memory",
        "committed_raw_events",
      ]),
    );
    expect(keys).not.toContain("ai_impression");
    expect(keys.indexOf("person_portrait")).toBeLessThan(
      keys.indexOf("committed_raw_events"),
    );

    // The egress re-derivation replays the frozen memory content from the
    // section references and the integrity HMAC verifies.
    const payload = compiler.renderPermittedPayload({
      compilerVersion: input.compilerVersion,
      generationStage: "decision",
      integrity: input.integrity,
      locale: input.locale,
      policyVersions: input.policyVersions,
      referencedEvents: input.referencedEvents,
      sections: input.sections,
      totalTokens: input.totalTokens,
    });
    expect(payload.instructions).toContain("person_portrait");
    expect(payload.instructions).toContain("[shh-memory-1]");
    expect(payload.instructions).toContain("Luke：工作单位：Acme");
    expect(payload.instructions).toContain("claim=claim-p1");
    expect(payload.instructions).toContain("version=version-p1");
    expect(payload.instructions).toContain("evidence=evidence-b,evidence-c");
    expect(payload.instructions).toContain("portrait-selection:v1");
    expect(payload.instructions).toContain("memory-budgets:v1");
    expect(payload.instructions).toContain("recall-framing:v1");
    // Kind-specific framing rides every item line (objective vs impression).
    expect(payload.instructions).toContain("措辞（objective）");
    expect(payload.instructions).toContain("措辞（impression）");
    expect(payload.instructions).toContain("objective_memory");
  });

  it("emits the recall experience contract exactly when memory sections are present (#118)", async () => {
    const { compiler, saved } = createCompilerWithMemory(
      completedOutcomeWithItems(),
    );
    await compiler.compile({
      generationCommandId: asGenerationCommandId(
        "01984477-59a9-7d20-9d97-e588769566c4",
      ),
      interactionTurnId: asInteractionTurnId(
        "01984477-59a9-7d20-9d97-e588769566c5",
      ),
      userId,
    });
    const input = saved();
    const keys = input.sections.map((section) => section.key);
    expect(keys).toContain("recall_experience");
    // The contract sits with the memory sections, before the raw Events.
    expect(keys.indexOf("recall_experience")).toBeGreaterThan(
      keys.indexOf("person_portrait"),
    );
    expect(keys.indexOf("recall_experience")).toBeLessThan(
      keys.indexOf("committed_raw_events"),
    );
    const contract = input.sections.find(
      (section) => section.key === "recall_experience",
    );
    // The section reference carries the full rendered content (the frozen
    // replay needs no second persisted copy) with the artifact version in it.
    // The factory's source locale is zh, so the zh contract renders.
    expect(contract?.reference).toContain(RECALL_EXPERIENCE_CONTRACT_VERSION);
    expect(contract?.reference).toContain("开场许可");

    // The egress payload replays the exact frozen contract and its integrity
    // holds.
    const payload = compiler.renderPermittedPayload({
      compilerVersion: input.compilerVersion,
      generationStage: "decision",
      integrity: input.integrity,
      locale: input.locale,
      policyVersions: input.policyVersions,
      referencedEvents: input.referencedEvents,
      sections: input.sections,
      totalTokens: input.totalTokens,
    });
    expect(payload.instructions).toContain(RECALL_EXPERIENCE_CONTRACT_VERSION);
    expect(payload.instructions).toContain("开场许可");
    expect(payload.instructions).toContain("零规则");
  });

  it("emits no recall experience section when the run degraded", async () => {
    const degraded = {
      ...completedOutcomeWithItems(),
      status: "degraded" as const,
      degradedReasonCodes: ["retrieval_lane_failed" as const],
      memorySections: {
        person_portrait: [],
        objective_memory: [],
        ai_impression: [],
      },
    };
    const { compiler, saved } = createCompilerWithMemory(degraded);
    await compiler.compile({
      generationCommandId: asGenerationCommandId(
        "01984477-59a9-7d20-9d97-e588769566c4",
      ),
      interactionTurnId: asInteractionTurnId(
        "01984477-59a9-7d20-9d97-e588769566c5",
      ),
      userId,
    });
    const input = saved();
    expect(input.degradedReason).toBe("memory_retrieval_failed");
    const keys = input.sections.map((section) => section.key);
    expect(keys).not.toContain("person_portrait");
    expect(keys).not.toContain("objective_memory");
    expect(keys).not.toContain("ai_impression");
    // No memory sections means no contract: the fail-closed round speaks as
    // if memory did not participate, and the prompt carries none of it.
    expect(keys).not.toContain("recall_experience");
    const payload = compiler.renderPermittedPayload({
      compilerVersion: input.compilerVersion,
      generationStage: "decision",
      integrity: input.integrity,
      locale: input.locale,
      policyVersions: input.policyVersions,
      referencedEvents: input.referencedEvents,
      sections: input.sections,
      totalTokens: input.totalTokens,
    });
    expect(payload.instructions).not.toContain("shh-memory-1");
    expect(payload.instructions).not.toContain(
      RECALL_EXPERIENCE_CONTRACT_VERSION,
    );
  });

  it("emits no recall experience section when a completed run selected nothing", async () => {
    const empty = {
      ...completedOutcomeWithItems(),
      memorySections: {
        person_portrait: [],
        objective_memory: [],
        ai_impression: [],
      },
    };
    const { compiler, saved } = createCompilerWithMemory(empty);
    await compiler.compile({
      generationCommandId: asGenerationCommandId(
        "01984477-59a9-7d20-9d97-e588769566c4",
      ),
      interactionTurnId: asInteractionTurnId(
        "01984477-59a9-7d20-9d97-e588769566c5",
      ),
      userId,
    });
    const keys = saved()
      .sections.map((section) => section.key);
    expect(keys).not.toContain("person_portrait");
    expect(keys).not.toContain("objective_memory");
    expect(keys).not.toContain("ai_impression");
    expect(keys).not.toContain("recall_experience");
  });
});
