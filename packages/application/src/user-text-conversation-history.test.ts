import {
  asConversationEventId,
  asConversationEventRevisionId,
  asDailySessionId,
  asUserId,
} from "@sayhear/domain";
import { describe, expect, it, vi } from "vitest";

import type { RecoveryGate } from "./recovery-gate";
import {
  CONVERSATION_DATE_PAGE_LIMIT,
  ConversationSessionNotFoundError,
  createUserTextConversationService,
  InvalidConversationCursorError,
  OLDER_CONVERSATION_MESSAGE_LIMIT,
  type GenerationPolicy,
  type UserTextConversationRepository,
  type UserTextMessage,
} from "./user-text-conversation";

const userId = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");
const dailySessionId = asDailySessionId("01984477-31e1-7595-92c6-06889cb0fdde");
const otherSessionId = asDailySessionId("01984477-31e1-7595-92c6-06889cb0fddf");
const now = new Date("2026-10-06T18:00:00.000Z");

function message(sequence: number): UserTextMessage {
  return {
    actor: "user",
    createdAt: "2026-10-06T18:00:00.000Z",
    eventId: asConversationEventId(`01984477-31e1-7595-92c6-06889cb0000${sequence}`),
    generationCommandId: null,
    locale: "en-US",
    logicalDate: "2026-10-06",
    revisionId: asConversationEventRevisionId(
      `01984477-31e1-7595-92c6-06889cb1000${sequence}`,
    ),
    sequence,
    text: `message ${sequence}`,
  };
}

function createService() {
  const calls = {
    findConversationSessionByDate: vi.fn(async () => ({
      dailySessionId,
      logicalDate: "2026-10-06",
    })),
    findConversationSessionById: vi.fn(
      async (_input: unknown): Promise<{
        dailySessionId: typeof dailySessionId;
        logicalDate: string;
      } | null> => ({
        dailySessionId,
        logicalDate: "2026-10-06",
      }),
    ),
    listConversationDates: vi.fn(async () => ({
      entries: [
        { dailySessionId, logicalDate: "2026-10-06" },
      ],
      hasMore: true,
    })),
    listOlderUserTextMessages: vi.fn(async () => ({
      hasMore: true,
      messages: [message(1)],
    })),
  };
  const repository = {
    ...calls,
    endContinuousExchangeExplicitly: vi.fn(),
    findCurrentWritableConversation: vi.fn(async () => null),
    listInterruptedResponses: vi.fn(async () => []),
    listInterruptedResponsesForSession: vi.fn(async () => []),
    listRecentUserTextMessages: vi.fn(async () => []),
    listUserTextMessages: vi.fn(async () => []),
    recordConversationRetry: vi.fn(),
    recordUserTextTurn: vi.fn(),
  } as unknown as UserTextConversationRepository;
  const recoveryGate = {
    requireOpen: vi.fn(async () => ({ status: "open" })),
  } as unknown as RecoveryGate;
  const service = createUserTextConversationService({
    clock: () => now,
    expectedBackupPolicyVersion: "neon-production-v1",
    expectedConfigurationFingerprint: "sha256:expected",
    generationPolicy: {} as GenerationPolicy,
    recoveryGate,
    repository,
  });
  return { calls, service };
}

describe("conversation history pagination", () => {
  it("uses the fixed server-side date page cap and returns an opaque cursor", async () => {
    const { calls, service } = createService();
    const page = await service.listConversationDates(userId, { cursor: null });
    expect(calls.listConversationDates).toHaveBeenCalledWith({
      beforeDailySessionId: null,
      beforeLogicalDate: null,
      limit: CONVERSATION_DATE_PAGE_LIMIT,
      userId,
    });
    expect(page.entries).toHaveLength(1);
    expect(typeof page.nextCursor).toBe("string");
  });

  it("seeds older messages from beforeSequence and continues with the returned cursor", async () => {
    const { calls, service } = createService();
    const first = await service.listOlderMessages(userId, {
      beforeSequence: 500,
      cursor: null,
      dailySessionId,
    });
    expect(calls.listOlderUserTextMessages).toHaveBeenCalledWith({
      beforeSequence: 500,
      dailySessionId,
      limit: OLDER_CONVERSATION_MESSAGE_LIMIT,
      userId,
    });
    expect(first.messages).toHaveLength(1);
    expect(typeof first.nextCursor).toBe("string");

    calls.listOlderUserTextMessages.mockClear();
    await service.listOlderMessages(userId, {
      cursor: first.nextCursor,
      dailySessionId,
    });
    expect(calls.listOlderUserTextMessages).toHaveBeenCalledWith({
      beforeSequence: 1,
      dailySessionId,
      limit: OLDER_CONVERSATION_MESSAGE_LIMIT,
      userId,
    });
  });

  it("rejects an empty or malformed position and a cross-session cursor", async () => {
    const { service } = createService();
    await expect(
      service.listOlderMessages(userId, { dailySessionId }),
    ).rejects.toBeInstanceOf(InvalidConversationCursorError);
    await expect(
      service.listOlderMessages(userId, {
        beforeSequence: -1,
        dailySessionId,
      }),
    ).rejects.toBeInstanceOf(InvalidConversationCursorError);
    await expect(
      service.listOlderMessages(userId, {
        cursor: "not-a-cursor",
        dailySessionId,
      }),
    ).rejects.toBeInstanceOf(InvalidConversationCursorError);

    const page = await service.listConversationDates(userId, { cursor: null });
    await expect(
      service.listOlderMessages(userId, {
        cursor: page.nextCursor,
        dailySessionId,
      }),
    ).rejects.toBeInstanceOf(InvalidConversationCursorError);

    const first = await service.listOlderMessages(userId, {
      beforeSequence: 10,
      dailySessionId,
    });
    await expect(
      service.listOlderMessages(userId, {
        cursor: first.nextCursor,
        dailySessionId: otherSessionId,
      }),
    ).rejects.toBeInstanceOf(InvalidConversationCursorError);
  });

  it("fails a foreign or missing session before reading messages", async () => {
    const { calls, service } = createService();
    calls.findConversationSessionById.mockResolvedValueOnce(null);
    await expect(
      service.listOlderMessages(userId, {
        beforeSequence: 10,
        dailySessionId,
      }),
    ).rejects.toBeInstanceOf(ConversationSessionNotFoundError);
    expect(calls.listOlderUserTextMessages).not.toHaveBeenCalled();
  });

  it("fails a malformed date closed to null without querying the repository", async () => {
    const { calls, service } = createService();
    expect(await service.readConversationByDate(userId, "2026-1-1")).toBeNull();
    expect(await service.readConversationByDate(userId, "not-a-date")).toBeNull();
    expect(calls.findConversationSessionByDate).not.toHaveBeenCalled();

    await expect(
      service.readConversationByDate(userId, "2026-10-06"),
    ).resolves.toEqual({ dailySessionId, logicalDate: "2026-10-06" });
  });
});
