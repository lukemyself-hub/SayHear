import { describe, expect, it } from "vitest";

import {
  DIALOGUE_STATE_FIELDS,
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
