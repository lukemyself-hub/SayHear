import {
  asConversationEventRevisionId,
  asDailySessionId,
  asUserId,
} from "@sayhear/domain";
import { describe, expect, it } from "vitest";

import {
  createDialogueStateService,
  validateDialogueStateContent,
  type DialogueStateContent,
  type DialogueStateRepository,
} from "./dialogue-state";

const userId = asUserId("01984477-59a9-7d20-9d97-e588769566a0");
const dailySessionId = asDailySessionId(
  "01984477-59a9-7d20-9d97-e588769566a1",
);
const sourceRevisionId = asConversationEventRevisionId(
  "01984477-59a9-7d20-9d97-e588769566a2",
);

function content(): DialogueStateContent {
  return {
    current_topic: {
      confidence: 0.8,
      sourceRevisionIds: [sourceRevisionId],
      value: "a difficult meeting",
    },
    emotional_intensity: {
      confidence: 0.6,
      sourceRevisionIds: [sourceRevisionId],
      value: "moderate",
    },
    advice_explicitly_requested: {
      confidence: 0.9,
      sourceRevisionIds: [sourceRevisionId],
      value: false,
    },
    current_request_requires_focus: {
      confidence: 0.7,
      sourceRevisionIds: [sourceRevisionId],
      value: false,
    },
    proactive_followup_opportunity: {
      confidence: 0.9,
      sourceRevisionIds: [sourceRevisionId],
      value: "natural_gap",
    },
    close_intent: {
      confidence: 0,
      sourceRevisionIds: [],
      value: null,
    },
    user_willing_to_elaborate: {
      confidence: 0.75,
      sourceRevisionIds: [sourceRevisionId],
      value: true,
    },
  };
}

describe("DialogueState", () => {
  it("accepts the seven semantic fields only when each source and confidence is explicit", () => {
    expect(() =>
      validateDialogueStateContent(content(), [sourceRevisionId]),
    ).not.toThrow();

    expect(() =>
      validateDialogueStateContent(
        {
          ...content(),
          current_topic: {
            confidence: 0.8,
            sourceRevisionIds: [
              asConversationEventRevisionId(
                "01984477-59a9-7d20-9d97-e588769566af",
              ),
            ],
            value: "a difficult meeting",
          },
        },
        [sourceRevisionId],
      ),
    ).toThrow("source revision");
  });

  it("requires proactive opportunity values to be current, typed, and evidence-bound", () => {
    expect(() =>
      validateDialogueStateContent(
        {
          ...content(),
          proactive_followup_opportunity: {
            confidence: 0,
            sourceRevisionIds: [],
            value: null,
          },
        },
        [sourceRevisionId],
      ),
    ).not.toThrow();

    expect(() =>
      validateDialogueStateContent(
        {
          ...content(),
          proactive_followup_opportunity: {
            confidence: 0.9,
            sourceRevisionIds: [sourceRevisionId],
            value: "not_an_opportunity" as never,
          },
        },
        [sourceRevisionId],
      ),
    ).toThrow("outside the bounded policy");
  });

  it("rejects pre-0111 content that still carries the old four fields", () => {
    expect(() =>
      validateDialogueStateContent(
        {
          currentTopic: {
            confidence: 0.8,
            sourceRevisionIds: [sourceRevisionId],
            value: "a difficult meeting",
          },
          emotionalTone: {
            confidence: 0.6,
            sourceRevisionIds: [sourceRevisionId],
            value: "mixed",
          },
          pendingQuestion: { confidence: 0, sourceRevisionIds: [], value: null },
          userIntent: {
            confidence: 0.9,
            sourceRevisionIds: [sourceRevisionId],
            value: "sharing",
          },
        } as never,
        [sourceRevisionId],
      ),
    ).toThrow("missing");
  });

  it("rejects non-boolean values in the judgment fields", () => {
    expect(() =>
      validateDialogueStateContent(
        {
          ...content(),
          advice_explicitly_requested: {
            confidence: 0.9,
            sourceRevisionIds: [sourceRevisionId],
            value: "yes" as never,
          },
        },
        [sourceRevisionId],
      ),
    ).toThrow("advice_explicitly_requested value must be a boolean or null");
  });

  it("rejects emotional intensity outside the bounded policy", () => {
    expect(() =>
      validateDialogueStateContent(
        {
          ...content(),
          emotional_intensity: {
            confidence: 0.6,
            sourceRevisionIds: [sourceRevisionId],
            value: "intense" as never,
          },
        },
        [sourceRevisionId],
      ),
    ).toThrow("emotional_intensity is outside the bounded policy");
  });

  it("publishes one valid projection through the application entrypoint", async () => {
    let published: DialogueStateContent | undefined;
    const repository: DialogueStateRepository = {
      async fail() {},
      async loadCommand() {
        return {
          command: {
            claimId: "01984477-59a9-7d20-9d97-e588769566a9",
            dialogueRevision: 2,
            expectedDataEpoch: 1,
            id: "01984477-59a9-7d20-9d97-e588769566a3",
            dailySessionId,
            coverageThroughSequence: 1,
            modelConfigVersion: "dialogue-state-model:v1",
            policyVersion: "dialogue-state:v2",
            promptVersion: "dialogue-state-prompt:v2",
            sourceRevision: 2,
            userId,
          },
          sources: [
            {
              actor: "user" as const,
              revisionId: sourceRevisionId,
              sequence: 1,
              text: "The meeting was difficult.",
            },
          ],
        };
      },
      async publish(input) {
        published = input.content;
        return "published";
      },
      async reconcile() {},
      async queueEligible() {
        return 0;
      },
      async stale() {},
    };
    const service = createDialogueStateService({
      clock: () => new Date("2026-08-13T12:00:00.000Z"),
      model: { project: async () => content() },
      policy: {
        modelConfigVersion: "dialogue-state-model:v1",
        policyVersion: "dialogue-state:v2",
        promptVersion: "dialogue-state-prompt:v2",
      },
      repository,
    });

    await expect(
      service.run("01984477-59a9-7d20-9d97-e588769566a3"),
    ).resolves.toEqual({ outcome: "published" });
    expect(published).toEqual(content());
  });

  it("fails closed when a model returns invalid state and never publishes it", async () => {
    let published = false;
    const repository: DialogueStateRepository = {
      async fail(_input) {},
      async loadCommand() {
        return {
          command: {
            claimId: "01984477-59a9-7d20-9d97-e588769566a9",
            dialogueRevision: 1,
            expectedDataEpoch: 1,
            id: "01984477-59a9-7d20-9d97-e588769566a3",
            dailySessionId,
            coverageThroughSequence: 1,
            modelConfigVersion: "dialogue-state-model:v1",
            policyVersion: "dialogue-state:v2",
            promptVersion: "dialogue-state-prompt:v2",
            sourceRevision: 1,
            userId,
          },
          sources: [
            {
              actor: "assistant" as const,
              revisionId: sourceRevisionId,
              sequence: 1,
              text: "A complete response.",
            },
          ],
        };
      },
      async publish() {
        published = true;
        return "published";
      },
      async reconcile() {},
      async queueEligible() {
        return 0;
      },
      async stale() {},
    };
    const service = createDialogueStateService({
      clock: () => new Date("2026-08-13T12:00:00.000Z"),
      model: {
        project: async () => ({
          ...content(),
          current_topic: {
            confidence: 1.2,
            sourceRevisionIds: [sourceRevisionId],
            value: "invalid confidence",
          },
        }),
      },
      policy: {
        modelConfigVersion: "dialogue-state-model:v1",
        policyVersion: "dialogue-state:v2",
        promptVersion: "dialogue-state-prompt:v2",
      },
      repository,
    });

    await expect(
      service.run("01984477-59a9-7d20-9d97-e588769566a3"),
    ).resolves.toEqual({ outcome: "failed" });
    expect(published).toBe(false);
  });

  it("rejects safety, action, and exchange-closure decisions in transient state", () => {
    expect(() =>
      validateDialogueStateContent(
        {
          ...content(),
          current_topic: {
            confidence: 0.8,
            sourceRevisionIds: [sourceRevisionId],
            value: "authorize an action now",
          },
        },
        [sourceRevisionId],
      ),
    ).toThrow("forbidden boundary decision");
  });

  it("rejects non-string free-text fields from untrusted JSON", () => {
    expect(() =>
      validateDialogueStateContent(
        {
          ...content(),
          current_topic: {
            confidence: 0.8,
            sourceRevisionIds: [sourceRevisionId],
            value: { unsafe: true } as never,
          },
        },
        [sourceRevisionId],
      ),
    ).toThrow("must be a string or null");
  });
});
