import { describe, expect, it } from "vitest";

import {
  ACTION_FINALIZATION_TASK_INSTRUCTION_VERSION,
  CANONICAL_PERSONA_VERSION,
  CHINESE_LOCALE_PACK_VERSION,
  CONVERSATION_DECISION_TASK_INSTRUCTION_VERSION,
  ENGLISH_LOCALE_PACK_VERSION,
  PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PERSONA_CONTRACT_INVARIANT_VERSION,
  PREVIOUS_CANONICAL_PERSONA_VERSION,
  PREVIOUS_CHINESE_LOCALE_PACK_VERSION,
  PREVIOUS_ENGLISH_LOCALE_PACK_VERSION,
  PREVIOUS_PERSONA_BEHAVIOR_ANCHORS_VERSION,
  PromptArtifactResolutionError,
  resolvePromptArtifacts,
  resolveSafetyPostureReducedPersona,
  SAFETY_POSTURE_REDUCED_PERSONA_VERSION,
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
      "You are SayHear, a private AI life-journal conversation companion",
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

describe("first-version canonical Persona and locale packs (issue #79)", () => {
  it("carries authored canonical Persona prose under the v2 pin", () => {
    const artifacts = resolvePromptArtifacts({
      locale: "en-US",
      policyVersions: {
        ...supportedVersions,
        personaBehaviorAnchorsVersion: PERSONA_BEHAVIOR_ANCHORS_VERSION,
      },
    });

    // The authored self-concept, not the two-line carry-forward placeholder.
    expect(artifacts.canonicalPersona).toContain("non-human AI being");
    expect(artifacts.canonicalPersona.length).toBeGreaterThan(1200);
    // The register mandate is the #62 dominant-failure fix and must be
    // explicit in the persona voice itself.
    expect(artifacts.canonicalPersona).toMatch(/[Pp]lain, spoken/);
    expect(artifacts.canonicalPersona).toContain("literary");
    // Emotion grounding: never invent a feeling the user did not express.
    expect(artifacts.canonicalPersona).toContain("did not express");
    // Relationship boundary from the #67 contract (ADR-0108).
    expect(artifacts.canonicalPersona).toContain("non-romantic");
  });

  it("carries no memory dependence in the canonical Persona", () => {
    const artifacts = resolvePromptArtifacts({
      locale: "en-US",
      policyVersions: supportedVersions,
    });

    // Policy D's continuity rules landed only as their memory-independent
    // remainder: no remembered-life usage, no cross-session recall claims.
    expect(artifacts.canonicalPersona).not.toContain("what you remember");
    expect(artifacts.canonicalPersona).not.toContain("What you remember");
    expect(artifacts.canonicalPersona).toMatch(/never imply you remember/i);
    expect(artifacts.canonicalPersona).toContain("never invent a hotline");
  });

  it("defaults curiosity to zero questions in the v2 anchors", () => {
    const artifacts = resolvePromptArtifacts({
      locale: "en-US",
      policyVersions: supportedVersions,
    });

    expect(artifacts.personaBehaviorAnchors).toContain("Default to zero");
    expect(artifacts.personaBehaviorAnchors).toContain("not interviewing");
    expect(artifacts.personaBehaviorAnchors).toContain(
      "Never substitute a new question",
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
  });

  it("authors each locale pack per language with real habit guidance", () => {
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

    expect(english.localePack).toContain("contractions");
    expect(english.localePack).toContain("code-switching");
    // The zh pack is written in Chinese about Chinese, not translated.
    expect(chinese.localePack).toMatch(/[\u4e00-\u9fff]/);
    expect(chinese.localePack).toContain("口语");
    expect(chinese.localePack).toContain("code-switching");
    // Length parity is the #61 zh/mix shortness fix.
    expect(chinese.localePack).toContain("完整度");
  });

  it("keeps the zh locale pack itself free of ASCII commas next to CJK", () => {
    const chinese = resolvePromptArtifacts({
      locale: "zh-CN",
      policyVersions: {
        ...supportedVersions,
        localePolicyVersion: CHINESE_LOCALE_PACK_VERSION,
      },
    });

    expect(chinese.localePack).not.toMatch(/[\u4e00-\u9fff],|,[\u4e00-\u9fff]/);
  });

  it("demonstrates rollback by re-pinning the previous versions (ADR-0113)", () => {
    // Cutover pinned v2; rollback is re-pinning the previous versions. The
    // previous artifacts stay registered, so the re-pin resolves exactly the
    // pre-cutover identity layers.
    const rolledBack = resolvePromptArtifacts({
      locale: "en-US",
      policyVersions: {
        ...supportedVersions,
        canonicalPersonaVersion: PREVIOUS_CANONICAL_PERSONA_VERSION,
        personaBehaviorAnchorsVersion: PREVIOUS_PERSONA_BEHAVIOR_ANCHORS_VERSION,
        localePolicyVersion: PREVIOUS_ENGLISH_LOCALE_PACK_VERSION,
      },
    });

    expect(rolledBack.canonicalPersona).toContain(
      "You are SayHear, a private AI life-journal conversation companion.",
    );
    expect(rolledBack.personaBehaviorAnchors).toContain(
      "keep ordinary conversation warm and lively",
    );
    expect(rolledBack.localePack).toContain("Respond naturally");
    expect(PREVIOUS_CANONICAL_PERSONA_VERSION).not.toBe(CANONICAL_PERSONA_VERSION);
    expect(PREVIOUS_ENGLISH_LOCALE_PACK_VERSION).not.toBe(
      ENGLISH_LOCALE_PACK_VERSION,
    );
    expect(PREVIOUS_CHINESE_LOCALE_PACK_VERSION).not.toBe(
      CHINESE_LOCALE_PACK_VERSION,
    );
    expect(PREVIOUS_PERSONA_BEHAVIOR_ANCHORS_VERSION).not.toBe(
      PERSONA_BEHAVIOR_ANCHORS_VERSION,
    );

    const rolledBackChinese = resolvePromptArtifacts({
      locale: "zh-CN",
      policyVersions: {
        ...supportedVersions,
        localePolicyVersion: PREVIOUS_CHINESE_LOCALE_PACK_VERSION,
      },
    });
    expect(rolledBackChinese.localePack).toContain("用自然、口语化的中文");
  });
});

describe("safety posture reduced persona variant", () => {
  it("resolves the reduced variant from its registered version", () => {
    const reduced = resolveSafetyPostureReducedPersona(
      SAFETY_POSTURE_REDUCED_PERSONA_VERSION,
    );
    // Exactly the paused set of ADR-0112.
    for (const paused of [
      "Playful Warmth",
      "Selective Curiosity",
      "emotional self-reference",
      "Non-essential opinions",
    ]) {
      expect(reduced).toContain(paused);
    }
    // And exactly the retained trio.
    for (const retained of ["warmth", "care", "directness"]) {
      expect(reduced.toLowerCase()).toContain(retained);
    }
    // The ordinary anchors the posture pauses are not compiled verbatim.
    expect(reduced).not.toContain("keep ordinary conversation warm and lively");
  });

  it("fails closed when the reduced variant version cannot be resolved", () => {
    expect(() =>
      resolveSafetyPostureReducedPersona("safety-posture-reduced-persona:vMissing"),
    ).toThrow(PromptArtifactResolutionError);
  });
});
