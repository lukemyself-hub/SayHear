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
    pendingQuestion: {
      confidence: 0,
      sourceRevisionIds: [],
      value: null,
    },
    userIntent: {
      confidence: 0.9,
      sourceRevisionIds: [sourceRevisionId],
      value: "sharing",
    },
  };
}

describe("DialogueState", () => {
  it("accepts bounded field values only when each source and confidence is explicit", () => {
    expect(() =>
      validateDialogueStateContent(content(), [sourceRevisionId]),
    ).not.toThrow();

    expect(() =>
      validateDialogueStateContent(
        {
          ...content(),
          currentTopic: {
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

  it("publishes one valid projection through the application entrypoint", async () => {
    let published: DialogueStateContent | undefined;
    const repository: DialogueStateRepository = {
      async fail() {},
      async loadCommand() {
        return {
          command: {
            dialogueRevision: 2,
            expectedDataEpoch: 1,
            id: "01984477-59a9-7d20-9d97-e588769566a3",
            dailySessionId,
            coverageThroughSequence: 1,
            modelConfigVersion: "dialogue-state-model:v1",
            policyVersion: "dialogue-state:v1",
            promptVersion: "dialogue-state-prompt:v1",
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
      expectedDataEpoch: 1,
      model: { project: async () => content() },
      modelConfigVersion: "dialogue-state-model:v1",
      policyVersion: "dialogue-state:v1",
      promptVersion: "dialogue-state-prompt:v1",
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
            dialogueRevision: 1,
            expectedDataEpoch: 1,
            id: "01984477-59a9-7d20-9d97-e588769566a3",
            dailySessionId,
            coverageThroughSequence: 1,
            modelConfigVersion: "dialogue-state-model:v1",
            policyVersion: "dialogue-state:v1",
            promptVersion: "dialogue-state-prompt:v1",
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
      expectedDataEpoch: 1,
      model: {
        project: async () => ({
          ...content(),
          currentTopic: {
            confidence: 1.2,
            sourceRevisionIds: [sourceRevisionId],
            value: "invalid confidence",
          },
        }),
      },
      modelConfigVersion: "dialogue-state-model:v1",
      policyVersion: "dialogue-state:v1",
      promptVersion: "dialogue-state-prompt:v1",
      repository,
    });

    await expect(
      service.run("01984477-59a9-7d20-9d97-e588769566a3"),
    ).resolves.toEqual({ outcome: "failed" });
    expect(published).toBe(false);
  });
});
