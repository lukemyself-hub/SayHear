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
  type ContextPolicyVersions,
  type ContextSourceSnapshot,
} from "./context-compiler";
import { PromptArtifactResolutionError } from "./prompt-artifacts";

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
    safetyPosture: ContextSourceSnapshot["safetyPosture"],
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
