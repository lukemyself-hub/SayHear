import { describe, expect, it, vi } from "vitest";

import {
  ConversationSessionNotFoundError,
  InvalidConversationCursorError,
  InvalidUserTextTurnError,
  RecoveryGateClosedError,
  type UserTextConversationService,
} from "@sayhear/application";

import {
  createConversationDatesHandler,
  createConversationMessagesHandler,
} from "../apps/web/src/conversation-history-handler";

const userId = "01984477-1f9a-7b25-a5cc-83c3b21fbc68";
const principal = { userId } as never;

function datesHandler(service: Partial<UserTextConversationService>, authenticated = true) {
  return createConversationDatesHandler({
    authenticate: async () => (authenticated ? principal : null),
    service: service as unknown as UserTextConversationService,
  });
}

function messagesHandler(
  service: Partial<UserTextConversationService>,
  authenticated = true,
) {
  return createConversationMessagesHandler({
    authenticate: async () => (authenticated ? principal : null),
    service: service as unknown as UserTextConversationService,
  });
}

describe("conversation history BFF handlers", () => {
  it("rejects unauthenticated and client-supplied owner identifiers", async () => {
    const handler = datesHandler({}, false);
    expect((await handler(new Request("http://localhost/api/internal/conversation/dates"))).status).toBe(401);

    const clientOwned = datesHandler({});
    expect(
      (
        await clientOwned(
          new Request("http://localhost/api/internal/conversation/dates?user_id=x"),
        )
      ).status,
    ).toBe(400);
  });

  it("maps an invalid dates cursor to 400 and returns the page otherwise", async () => {
    const listConversationDates = vi
      .fn()
      .mockRejectedValueOnce(new InvalidConversationCursorError())
      .mockResolvedValueOnce({ entries: [], nextCursor: null });
    const handler = datesHandler({ listConversationDates });
    const invalid = await handler(
      new Request("http://localhost/api/internal/conversation/dates?cursor=bad"),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_cursor" });

    const ok = await handler(
      new Request("http://localhost/api/internal/conversation/dates"),
    );
    expect(ok.status).toBe(200);
    expect(listConversationDates).toHaveBeenLastCalledWith(userId, {
      cursor: null,
    });
  });

  it("maps messages errors and validates beforeSequence", async () => {
    const listOlderMessages = vi
      .fn()
      .mockRejectedValueOnce(new InvalidUserTextTurnError("bad id"))
      .mockRejectedValueOnce(new ConversationSessionNotFoundError())
      .mockRejectedValueOnce(
        new RecoveryGateClosedError({ status: "needs_attention" } as never),
      )
      .mockResolvedValueOnce({ messages: [], nextCursor: null });
    const handler = messagesHandler({ listOlderMessages });

    const invalidSequence = await handler(
      new Request(
        "http://localhost/api/internal/conversation/messages?dailySessionId=x&beforeSequence=0",
      ),
    );
    expect(invalidSequence.status).toBe(400);
    expect(await invalidSequence.json()).toEqual({
      error: "invalid_before_sequence",
    });

    const invalidId = await handler(
      new Request(
        "http://localhost/api/internal/conversation/messages?dailySessionId=not-a-uuid&beforeSequence=1",
      ),
    );
    expect(invalidId.status).toBe(400);
    expect(await invalidId.json()).toEqual({
      error: "invalid_daily_session_id",
    });

    const missing = await handler(
      new Request(
        "http://localhost/api/internal/conversation/messages?dailySessionId=abc&beforeSequence=1",
      ),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    const closed = await handler(
      new Request(
        "http://localhost/api/internal/conversation/messages?dailySessionId=abc&beforeSequence=1",
      ),
    );
    expect(closed.status).toBe(503);
    expect(await closed.json()).toEqual({
      error: "recovery_gate_closed",
      status: "needs_attention",
    });

    const ok = await handler(
      new Request(
        "http://localhost/api/internal/conversation/messages?dailySessionId=abc&beforeSequence=7",
      ),
    );
    expect(ok.status).toBe(200);
    expect(listOlderMessages).toHaveBeenLastCalledWith(userId, {
      beforeSequence: 7,
      cursor: null,
      dailySessionId: "abc",
    });
  });
});
