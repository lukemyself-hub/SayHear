import { describe, expect, it } from "vitest";

import {
  DIALOGUE_STATE_FIELDS,
  memorySectionItemsFromSections,
  parseMemorySectionItems,
  sectionVersionLabel,
  type ContextInspectorContext,
  type ContextInspectorSection,
} from "../apps/web/app/internal/context-inspector-data";

const context: ContextInspectorContext = {
  dialogueState: {
    content: {
      advice_explicitly_requested: {
        confidence: 0.9,
        sourceRevisionIds: ["revision-1"],
        value: false,
      },
      close_intent: {
        confidence: 0.9,
        sourceRevisionIds: ["revision-1"],
        value: false,
      },
      current_request_requires_focus: {
        confidence: 0.9,
        sourceRevisionIds: ["revision-1"],
        value: true,
      },
      current_topic: {
        confidence: 0.9,
        sourceRevisionIds: ["revision-1"],
        value: "work",
      },
      emotional_intensity: {
        confidence: 0.9,
        sourceRevisionIds: ["revision-1"],
        value: "medium",
      },
      user_willing_to_elaborate: {
        confidence: 0.9,
        sourceRevisionIds: ["revision-1"],
        value: true,
      },
    },
    dialogueRevision: 2,
    policyVersion: "dialogue-state:v2",
    sourceRevision: 2,
    status: "lagging",
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
  safetyPosture: {
    posture: {
      content: {
        cleanTurnCount: 0,
        evidence: {
          activatedUserEventRevisionId: "revision-1",
          lastTurnUserEventRevisionId: "revision-1",
        },
        kind: "self_harm",
        releasedBy: null,
        state: "active",
      },
      policyVersion: "safety-posture:v1",
      sourceRevision: 1,
      versionNo: 1,
    },
    state: "active",
  },
};

function section(
  key: ContextInspectorSection["key"],
  reference: string,
): ContextInspectorSection {
  return {
    budgetTokens: null,
    key,
    ordinal: 0,
    reference,
    selectedTokens: 1,
    truncatable: false,
  };
}

describe("Context Inspector data labels", () => {
  it("keeps the six DialogueState v2 fields explicit", () => {
    expect(DIALOGUE_STATE_FIELDS).toEqual([
      "current_topic",
      "emotional_intensity",
      "advice_explicitly_requested",
      "current_request_requires_focus",
      "close_intent",
      "user_willing_to_elaborate",
    ]);
  });

  it("uses pinned policy versions for static sections", () => {
    expect(
      sectionVersionLabel(section("product_policy", "ignored"), context),
    ).toBe("product-policy:v1");
  });

  it("does not expose rendered state content as a section version", () => {
    const renderedDialogueState =
      "DialogueState (current topic: private user content; policy dialogue-state:v2)";
    const renderedSafetyPosture =
      "Safety Posture (policy safety-posture:v1): ACTIVE — support anchor";

    expect(
      sectionVersionLabel(
        section("dialogue_state", renderedDialogueState),
        context,
      ),
    ).toBe("dialogue-state:v2");
    expect(
      sectionVersionLabel(
        section("safety_posture", renderedSafetyPosture),
        context,
      ),
    ).toBe("safety-posture:v1");
    expect(sectionVersionLabel(section("current_user_input", "user text"), context)).toBe(
      "event-revision",
    );
  });
});

describe("Context Inspector memory item parsing (#122)", () => {
  const renderedPortrait = [
    "Person Portrait（用户画像，person_portrait，逐轮重选；条目按记忆引用单独寻址）" +
      " [portrait-selection:v1 | memory-budgets:v1 | recall-framing:v1]" +
      " (section=person_portrait):",
    "- [shh-memory-1] 老家在西安 — kind=objective epistemic=confirmed" +
      " claim=claim-1 version=version-1 evidence=ev-1,ev-2 temporal=current" +
      " valid_from=2026-01-01",
    "  措辞（objective）：这是用户亲口陈述的事实；可以“你之前说过…”的方式来源归属式引用。",
    "- [shh-memory-2] 重视家庭 — kind=impression epistemic=inferred" +
      " claim=claim-2 version=version-2 evidence=none temporal=ended" +
      " valid_from=2026-01-02 valid_to=2026-06-30",
    "  措辞（impression）：这是你基于多次观察形成的理解，可以自然、朋友式地表达。",
  ].join("\n");

  it("parses every injected item with the exact structured fields the model received", () => {
    const items = parseMemorySectionItems(renderedPortrait);

    expect(items).toEqual([
      {
        claimId: "claim-1",
        claimVersionId: "version-1",
        contextMemoryRef: "shh-memory-1",
        epistemicStatus: "confirmed",
        evidenceIds: ["ev-1", "ev-2"],
        kind: "objective",
        renderedText: "老家在西安",
        temporalStatus: "current",
        validFrom: "2026-01-01",
        validTo: null,
      },
      {
        claimId: "claim-2",
        claimVersionId: "version-2",
        contextMemoryRef: "shh-memory-2",
        epistemicStatus: "inferred",
        evidenceIds: [],
        kind: "impression",
        renderedText: "重视家庭",
        temporalStatus: "ended",
        validFrom: "2026-01-02",
        validTo: "2026-06-30",
      },
    ]);
  });

  it("keeps rendered text that itself contains an em dash intact", () => {
    const items = parseMemorySectionItems(
      [
        "Objective Memory（objective_memory，本轮话题检索命中）" +
          " [portrait-selection:v1 | memory-budgets:v1 | recall-framing:v1]" +
          " (section=objective_memory):",
        "- [shh-memory-1] 喜欢徒步 — 每月一次山里 — kind=objective" +
          " epistemic=confirmed claim=c version=v evidence=none temporal=current",
      ].join("\n"),
    );

    expect(items[0]?.renderedText).toBe("喜欢徒步 — 每月一次山里");
  });

  it("returns no items for a non-memory section reference", () => {
    expect(parseMemorySectionItems("product-policy:v1")).toEqual([]);
    expect(
      parseMemorySectionItems(
        "DialogueState (current topic: private; policy dialogue-state:v2)",
      ),
    ).toEqual([]);
  });

  it("collects injected items per memory section key in compile order", () => {
    const items = memorySectionItemsFromSections([
      section("objective_memory", "product-policy:v1"),
      section("person_portrait", renderedPortrait),
    ]);

    // Every present memory section is listed; a reference without item lines
    // contributes zero items rather than a fabricated injection.
    expect(items.map((entry) => entry.sectionKey)).toEqual([
      "person_portrait",
      "objective_memory",
    ]);
    expect(items[0]?.items).toHaveLength(2);
    expect(items[1]?.items).toEqual([]);
  });
});
