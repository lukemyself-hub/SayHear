import { asDailySessionId, asUserId } from "@sayhear/domain";
import { describe, expect, it, vi } from "vitest";

import type { RecoveryGate } from "./recovery-gate";
import {
  createUserTextConversationService,
  InvalidUserTextTurnError,
  RECENT_CONVERSATION_MESSAGE_LIMIT,
  type GenerationPolicy,
  type UserTextConversationRepository,
} from "./user-text-conversation";

const userId = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");
const dailySessionId = asDailySessionId("01984477-31e1-7595-92c6-06889cb0fdde");
const now = new Date("2026-10-06T18:00:00.000Z");

type RepositoryCalls = {
  findCurrentWritableConversation: ReturnType<typeof vi.fn>;
  listInterruptedResponsesForSession: ReturnType<typeof vi.fn>;
  listRecentUserTextMessages: ReturnType<typeof vi.fn>;
};

function createService(options: {
  closed?: boolean;
  repository?: Partial<UserTextConversationRepository>;
}) {
  const calls: RepositoryCalls = {
    findCurrentWritableConversation: vi.fn(async () => ({
      activityState: "active" as const,
      dailySessionId,
      logicalDate: "2026-10-06",
      startedAt: now,
      timezoneAtStart: "Asia/Shanghai",
    })),
    listInterruptedResponsesForSession: vi.fn(async () => []),
    listRecentUserTextMessages: vi.fn(async () => []),
  };
  const requireOpen = vi.fn(async () => {
    if (options.closed) {
      throw new Error("recovery_gate_closed");
    }
    return { status: "open" } as never;
  });
  const repository = {
    endContinuousExchangeExplicitly: vi.fn(),
    findCurrentWritableConversation: calls.findCurrentWritableConversation,
    listInterruptedResponses: vi.fn(async () => []),
    listInterruptedResponsesForSession:
      calls.listInterruptedResponsesForSession,
    listRecentUserTextMessages: calls.listRecentUserTextMessages,
    listUserTextMessages: vi.fn(async () => []),
    recordConversationRetry: vi.fn(),
    recordUserTextTurn: vi.fn(),
    ...options.repository,
  } as unknown as UserTextConversationRepository;
  const recoveryGate = { requireOpen } as unknown as RecoveryGate;
  const service = createUserTextConversationService({
    clock: () => now,
    expectedBackupPolicyVersion: "neon-production-v1",
    expectedConfigurationFingerprint: "sha256:expected",
    generationPolicy: {} as GenerationPolicy,
    recoveryGate,
    repository,
  });
  return { calls, requireOpen, service };
}

describe("current conversation reads", () => {
  it("delegates the authoritative current conversation identity", async () => {
    const { calls, service } = createService({});
    await expect(service.readCurrentConversation(userId)).resolves.toEqual({
      activityState: "active",
      dailySessionId,
      logicalDate: "2026-10-06",
      startedAt: now,
      timezoneAtStart: "Asia/Shanghai",
    });
    expect(calls.findCurrentWritableConversation).toHaveBeenCalledWith(userId);
  });

  it("reads the recent batch with the server-side fixed cap", async () => {
    const { calls, service } = createService({});
    await service.listRecentMessages(userId, {
      dailySessionId: dailySessionId as string,
    });
    expect(calls.listRecentUserTextMessages).toHaveBeenCalledWith({
      dailySessionId,
      limit: RECENT_CONVERSATION_MESSAGE_LIMIT,
      userId,
    });
    expect(RECENT_CONVERSATION_MESSAGE_LIMIT).toBe(50);
  });

  it("scopes interrupted responses to the requested session", async () => {
    const { calls, service } = createService({});
    await service.listInterruptedResponsesForSession(
      userId,
      dailySessionId as string,
    );
    expect(calls.listInterruptedResponsesForSession).toHaveBeenCalledWith({
      dailySessionId,
      userId,
    });
  });

  it("rejects an unparseable Daily Session id", async () => {
    const { service } = createService({});
    await expect(
      service.listRecentMessages(userId, { dailySessionId: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(InvalidUserTextTurnError);
  });

  it("fails every new read closed when the recovery gate is closed", async () => {
    const { calls, service } = createService({ closed: true });
    await expect(service.readCurrentConversation(userId)).rejects.toThrow(
      "recovery_gate_closed",
    );
    await expect(
      service.listRecentMessages(userId, { dailySessionId }),
    ).rejects.toThrow("recovery_gate_closed");
    await expect(
      service.listInterruptedResponsesForSession(userId, dailySessionId),
    ).rejects.toThrow("recovery_gate_closed");
    expect(calls.findCurrentWritableConversation).not.toHaveBeenCalled();
    expect(calls.listRecentUserTextMessages).not.toHaveBeenCalled();
  });
});
