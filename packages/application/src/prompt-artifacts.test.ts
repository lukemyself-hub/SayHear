import { describe, expect, it } from "vitest";

import {
  ACTION_FINALIZATION_TASK_INSTRUCTION_VERSION,
  CANONICAL_PERSONA_VERSION,
  CHINESE_LOCALE_PACK_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  ENGLISH_LOCALE_PACK_VERSION,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  PromptArtifactResolutionError,
  resolvePromptArtifacts,
} from "./prompt-artifacts";

const supportedVersions = {
  canonicalPersonaVersion: CANONICAL_PERSONA_VERSION,
  localePolicyVersion: ENGLISH_LOCALE_PACK_VERSION,
  personaBehaviorAnchorsVersion: PERSONA_BEHAVIOR_ANCHORS_VERSION,
  personaContractInvariantVersion: PERSONA_CONTRACT_INVARIANT_VERSION,
  taskInstructionVersion: CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
} as const;

describe("prompt artifact resolution", () => {
  it("resolves every identity layer from its registered version", () => {
    const artifacts = resolvePromptArtifacts({
      locale: "en-US",
      policyVersions: supportedVersions,
    });

    expect(artifacts.personaContractInvariant).toContain("SayHear is an AI");
    expect(artifacts.canonicalPersona).toContain(
      "You are SayHear, a private AI life-journal conversation companion.",
    );
    for (const anchor of [
      "Selective Curiosity",
      "Curiosity Stop Signal",
      "Playful Warmth",
      "Conversational Rhythm",
      "Grounded Persona Perspective",
      "Capability-Honest Directness",
    ]) {
      expect(artifacts.personaBehaviorAnchors).toContain(anchor);
    }
    expect(artifacts.localePack).toContain("en-US");
    expect(artifacts.taskInstruction).toContain(
      "Continue the private journal conversation",
    );
  });

  it("renders each locale pack in its own language under its own version", () => {
    const english = resolvePromptArtifacts({
      locale: "en-US",
      policyVersions: supportedVersions,
    });
    const chinese = resolvePromptArtifacts({
      locale: "zh-CN",
      policyVersions: {
        ...supportedVersions,
        localePolicyVersion: CHINESE_LOCALE_PACK_VERSION,
      },
    });

    expect(english.localePack).not.toBe(chinese.localePack);
    expect(chinese.localePack).toContain("zh-CN");
  });

  it("fails closed when a persona block version cannot be resolved", () => {
    expect(() =>
      resolvePromptArtifacts({
        locale: "en-US",
        policyVersions: {
          ...supportedVersions,
          canonicalPersonaVersion: "canonical-persona:vMissing",
        },
      }),
    ).toThrow(PromptArtifactResolutionError);
    expect(() =>
      resolvePromptArtifacts({
        locale: "en-US",
        policyVersions: {
          ...supportedVersions,
          personaContractInvariantVersion: "",
        },
      }),
    ).toThrow(PromptArtifactResolutionError);
  });

  it("fails closed when the locale pack version cannot be resolved", () => {
    expect(() =>
      resolvePromptArtifacts({
        locale: "en-US",
        policyVersions: {
          ...supportedVersions,
          localePolicyVersion: "locale-pack-jp:v1",
        },
      }),
    ).toThrow(PromptArtifactResolutionError);
  });

  it("fails closed when a locale pack belongs to a different language", () => {
    expect(() =>
      resolvePromptArtifacts({
        locale: "en-US",
        policyVersions: {
          ...supportedVersions,
          localePolicyVersion: CHINESE_LOCALE_PACK_VERSION,
        },
      }),
    ).toThrow(PromptArtifactResolutionError);
    expect(() =>
      resolvePromptArtifacts({
        locale: "zh-CN",
        policyVersions: supportedVersions,
      }),
    ).toThrow(PromptArtifactResolutionError);
  });

  it("fails closed when the task instruction version cannot be resolved", () => {
    expect(() =>
      resolvePromptArtifacts({
        locale: "en-US",
        policyVersions: {
          ...supportedVersions,
          taskInstructionVersion: "conversation-text:v1",
        },
      }),
    ).toThrow(PromptArtifactResolutionError);
  });

  it("pairs each GenerationCommand stage with its own task instruction", () => {
    const decision = resolvePromptArtifacts({
      generationStage: "decision",
      locale: "en-US",
      policyVersions: supportedVersions,
    });
    const finalization = resolvePromptArtifacts({
      generationStage: "action_finalization",
      locale: "en-US",
      policyVersions: {
        ...supportedVersions,
        taskInstructionVersion: ACTION_FINALIZATION_TASK_INSTRUCTION_VERSION,
      },
    });

    expect(decision.taskInstruction).not.toBe(finalization.taskInstruction);
    expect(finalization.taskInstruction).toContain("Action Finalization Receipt");
  });

  it("fails closed when a stage is pinned with the other stage's instruction", () => {
    expect(() =>
      resolvePromptArtifacts({
        generationStage: "decision",
        locale: "en-US",
        policyVersions: {
          ...supportedVersions,
          taskInstructionVersion: ACTION_FINALIZATION_TASK_INSTRUCTION_VERSION,
        },
      }),
    ).toThrow(PromptArtifactResolutionError);
    expect(() =>
      resolvePromptArtifacts({
        generationStage: "action_finalization",
        locale: "en-US",
        policyVersions: supportedVersions,
      }),
    ).toThrow(PromptArtifactResolutionError);
  });
});
