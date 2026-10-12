import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHistoryPathHarness, terminal } from "../support/history-path-harness";

/**
 * SPEC #301 presentation fix. A message the person corrected keeps its
 * original place and time wherever it is sent: in a History Answer, in the
 * seven-day background and inside the same Daily Session. A restatement of the
 * old value written before the correction then reads as a later change of
 * mind. The synthetic owner goes through the real write path, the real
 * correction, the PostgreSQL sources, compile and Egress; the assertions are
 * on what reaches the Provider boundary.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const harness = createHistoryPathHarness(testDatabaseUrl);

beforeEach(async () => {
  await harness.setup({ recentContext: true });
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 15_000);

const OFFER_OLD = "猎头透了底，那家 startup 给的 base 是 45k，外加 sign-on bonus。";
const OFFER_OLD_REPLY = "Base 45k 还有 sign-on，听起来让你有点心动。";
const ECHO = "对，就是 45k，比我现在高了差不多三成。";
const ECHO_REPLY = "高三成，又不好跟身边人说。";
const OFFER_NEW = "猎头透了底，那家 startup 给的 base 是 38k，外加 sign-on bonus。";

const STANDS = "the wording below is their corrected one and is what they stand by.]";
const NOT_A_CHANGE_OF_MIND =
  "It is not a later change of mind: where it differs from that corrected message on the same point, the corrected message is how it stands.]";
const NOTE_RULE = 'A message that opens with a bracketed line starting "[Note."';

describe("a correction is noted on the messages of an ordinary turn", () => {
  it("in the seven-day background: the corrected message says so, and the restatement written before it says it came first", async () => {
    await harness.say(OFFER_OLD, "2026-09-09T12:00:00.000Z", OFFER_OLD_REPLY);
    await harness.say(ECHO, "2026-09-09T12:04:00.000Z", ECHO_REPLY);
    await harness.closeSession("2026-09-09T14:00:00.000Z");
    harness.setNow("2026-09-12T11:40:00.000Z");
    await harness.correctMessage(OFFER_OLD, OFFER_NEW);
    harness.state.requests = [];
    harness.state.review = null;

    const events = await harness.say("今天有点累。", "2026-09-12T12:00:00.000Z", "辛苦了。");
    expect(terminal(events)).toBe("assistant_committed");
    const request = harness.state.requests[0]!;

    expect(request.messages).toContain(
      `user:[Note. They corrected this message on 2026-09-12 19:40: ${STANDS}\n${OFFER_NEW}`,
    );
    expect(request.messages).toContain(
      `user:[Note. They wrote this before they made the 2026-09-12 19:40 correction to their 2026-09-09 20:00 message. ${NOT_A_CHANGE_OF_MIND}\n${ECHO}`,
    );
    // Assistant lines and the current message carry no note.
    expect(request.messages).toContain(`assistant:${ECHO_REPLY}`);
    expect(request.messages.at(-1)).toBe("user:今天有点累。");
    expect(request.instructions).toContain(NOTE_RULE);
    // Nothing about the superseded wording leaves.
    expect(JSON.stringify(request)).not.toContain("45k，外加");
    expect(JSON.stringify(request)).not.toContain(OFFER_OLD_REPLY);
  });

  it("inside the same Daily Session", async () => {
    await harness.say(OFFER_OLD, "2026-09-09T12:00:00.000Z", OFFER_OLD_REPLY);
    await harness.say(ECHO, "2026-09-09T12:04:00.000Z", ECHO_REPLY);
    harness.setNow("2026-09-09T12:10:00.000Z");
    await harness.correctMessage(OFFER_OLD, OFFER_NEW);
    harness.state.requests = [];
    harness.state.review = null;

    const events = await harness.say("先这样。", "2026-09-09T12:20:00.000Z", "好。");
    expect(terminal(events)).toBe("assistant_committed");
    const request = harness.state.requests[0]!;

    expect(request.messages).toContain(
      `user:[Note. They corrected this message on 2026-09-09 20:10: ${STANDS}\n${OFFER_NEW}`,
    );
    expect(request.messages).toContain(
      `user:[Note. They wrote this before they made the 2026-09-09 20:10 correction to their 2026-09-09 20:00 message. ${NOT_A_CHANGE_OF_MIND}\n${ECHO}`,
    );
    expect(request.messages.at(-1)).toBe("user:先这样。");
    expect(request.instructions).toContain(NOTE_RULE);
  });

  it("sends an ordinary turn with no correction exactly as written", async () => {
    await harness.say(OFFER_OLD, "2026-09-09T12:00:00.000Z", OFFER_OLD_REPLY);
    await harness.closeSession("2026-09-09T14:00:00.000Z");
    harness.state.requests = [];
    harness.state.review = null;

    await harness.say("今天有点累。", "2026-09-12T12:00:00.000Z", "辛苦了。");
    const request = harness.state.requests[0]!;
    expect(request.messages).toEqual([
      `user:${OFFER_OLD}`,
      `assistant:${OFFER_OLD_REPLY}`,
      "user:今天有点累。",
    ]);
    expect(request.instructions).not.toContain("[Note.");
  });
});
