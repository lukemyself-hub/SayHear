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
  resolveRecallExperienceContract,
  resolveSafetyPostureReducedPersona,
  RECALL_EXPERIENCE_CONTRACT_VERSION,
  SAFETY_POSTURE_REDUCED_PERSONA_VERSION,
  resolveTrustActionExpressionContract,
  TRUST_ACTION_EXPRESSION_CONTRACT_VERSION,
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

describe("recall experience contract (issue #118, ADR-0116 / ADR-0117)", () => {
  it("carries the version identity in its own rendered content", () => {
    const en = resolveRecallExperienceContract({
      locale: "en-US",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(en).toContain(RECALL_EXPERIENCE_CONTRACT_VERSION);
    const zh = resolveRecallExperienceContract({
      locale: "zh-CN",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(zh).toContain(RECALL_EXPERIENCE_CONTRACT_VERSION);
    expect(en).not.toBe(zh);
  });

  it("grants the narrow opener permission with no ritual hedge (ADR-0117 / ADR-0116)", () => {
    const en = resolveRecallExperienceContract({
      locale: "en-US",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(en).toContain("opening");
    expect(en.toLowerCase()).toContain("based on our past conversations");
    expect(en.toLowerCase()).toContain("i have an impression");
    const zh = resolveRecallExperienceContract({
      locale: "zh-CN",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(zh).toContain("开场");
    expect(zh).toContain("根据我们以前的对话");
    expect(zh).toContain("我有一个印象");
  });

  it("demands explicitly recognizable recall, not vague hints", () => {
    const en = resolveRecallExperienceContract({
      locale: "en-US",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(en.toLowerCase()).toContain("recognizable");
    expect(en.toLowerCase()).toContain("vague");
    const zh = resolveRecallExperienceContract({
      locale: "zh-CN",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(zh).toContain("含糊");
  });

  it("keeps the two-kind recall language distinct (ADR-0009)", () => {
    const en = resolveRecallExperienceContract({
      locale: "en-US",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    // Objective: source attribution allowed, verification never implied.
    expect(en.toLowerCase()).toContain("you mentioned");
    expect(en.toLowerCase()).toContain("independently verified");
    // Impression: natural and confident, never upgraded, never a global
    // trait, never a frozen temporary state, never a diagnostic label.
    expect(en.toLowerCase()).toContain("never upgrade");
    expect(en.toLowerCase()).toContain("global trait");
    expect(en.toLowerCase()).toContain("temporary state");
    expect(en.toLowerCase()).toContain("diagnostic");
    const zh = resolveRecallExperienceContract({
      locale: "zh-CN",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(zh).toContain("你之前说过");
    expect(zh).toContain("独立核验");
    expect(zh).toContain("升级");
    expect(zh).toContain("永久标签");
    expect(zh).toContain("暂时的状态");
    expect(zh).toContain("诊断式");
  });

  it("holds the grounding guard: only the injected sections may be referenced", () => {
    const en = resolveRecallExperienceContract({
      locale: "en-US",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(en).toContain("no memory section");
    expect(en.toLowerCase()).toContain("fabricat");
    const zh = resolveRecallExperienceContract({
      locale: "zh-CN",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(zh).toContain("没有任何记忆 section");
    expect(zh).toContain("编造");
  });

  it("keeps the fail-closed double prohibition and the ADR-0008 challenge rule", () => {
    const en = resolveRecallExperienceContract({
      locale: "en-US",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(en.toLowerCase()).toContain("internal fault");
    expect(en.toLowerCase()).toContain("cannot verify");
    const zh = resolveRecallExperienceContract({
      locale: "zh-CN",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(zh).toContain("内部故障");
    expect(zh).toContain("无法核实");
  });

  it("puts a memory follow-up question inside the one-question slot and suppresses stopped directions", () => {
    const en = resolveRecallExperienceContract({
      locale: "en-US",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(en.toLowerCase()).toContain("one question");
    expect(en.toLowerCase()).toContain("statement");
    expect(en.toLowerCase()).toContain("reopen");
    const zh = resolveRecallExperienceContract({
      locale: "zh-CN",
      version: RECALL_EXPERIENCE_CONTRACT_VERSION,
    });
    expect(zh).toContain("唯一的问题");
    expect(zh).toContain("陈述式");
    expect(zh).toContain("重开");
  });

  it("fails closed when the contract version cannot be resolved", () => {
    expect(() =>
      resolveRecallExperienceContract({
        locale: "en-US",
        version: "recall-experience-contract:vMissing",
      }),
    ).toThrow(PromptArtifactResolutionError);
  });
});

describe("trust-action expression contract (issue #119, P1-P6)", () => {
  it("resolves the P1-P6 principles per locale and carries every principle", () => {
    const en = resolveTrustActionExpressionContract({
      locale: "en-US",
      version: TRUST_ACTION_EXPRESSION_CONTRACT_VERSION,
    });
    expect(en).toContain("P1 Confirmation");
    expect(en.toLowerCase()).toContain("won't bring this up");
    expect(en.toLowerCase()).toContain("in progress");
    expect(en.toLowerCase()).toContain("never list");
    expect(en.toLowerCase()).toContain("can't verify");
    expect(en.toLowerCase()).toContain("friend-like tone");

    const zh = resolveTrustActionExpressionContract({
      locale: "zh-CN",
      version: TRUST_ACTION_EXPRESSION_CONTRACT_VERSION,
    });
    expect(zh).toContain("P1 确认");
    expect(zh).toContain("停止，不是删除");
    expect(zh).toContain("「以后不提了」".replace("「", "").replace("」", ""));
    expect(zh).toContain("处理中");
    expect(zh).toContain("绝不列出");
    expect(zh).toContain("无法核实");
  });

  it("fails closed when the expression contract version cannot be resolved", () => {
    expect(() =>
      resolveTrustActionExpressionContract({
        locale: "en-US",
        version: "trust-action-expression-contract:vMissing",
      }),
    ).toThrow(PromptArtifactResolutionError);
  });
});
