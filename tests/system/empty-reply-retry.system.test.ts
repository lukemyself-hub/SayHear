import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  U_BAG,
  askVia,
  createHistoryPathHarness,
  seedLife,
  shownText,
  terminal,
} from "../support/history-path-harness";

/**
 * A reply call sometimes comes back with reasoning only and no visible text
 * (seen on the real model after a history review: the answer was fully worked
 * out in the reasoning and nothing was emitted). That used to fail the turn
 * closed at once. It is now tried once more inside the same request deadline,
 * as a technical retry of the same Command through the ordinary dispatch path,
 * so every source and governance check runs again for the second call.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const harness = createHistoryPathHarness(testDatabaseUrl);

beforeEach(async () => {
  await harness.setup();
}, 30_000);

afterEach(async () => {
  await harness.teardown();
}, 15_000);

const commands = () =>
  harness.rows<{ attempts: string; stage: string; status: string }>(
    `SELECT command.generation_stage AS stage, command.status,
            count(attempt.model_run_attempt_id)::text AS attempts
     FROM generation_commands command
     LEFT JOIN model_run_attempts attempt
       ON attempt.generation_command_id = command.generation_command_id
     GROUP BY command.generation_command_id, command.generation_stage, command.status, command.created_at
     ORDER BY command.created_at, command.generation_command_id`,
  );
const assistantTexts = async () =>
  (
    await harness.rows<{ text: string }>(
      `SELECT revision.canonical_text AS text
       FROM conversation_events event
       INNER JOIN conversation_event_revisions revision
         ON revision.conversation_event_revision_id = event.current_revision_id
       WHERE event.actor = 'assistant'`,
    )
  ).map((row) => row.text);

describe("a reply that comes back empty is tried once more", () => {
  it("answers a history question on the second call after an empty first one, and records both calls", async () => {
    await seedLife(harness);
    const before = (await commands()).length;
    harness.state.emptyReplies = 1;
    harness.state.replyChunks = ["那天你说", "缝了帆布包。"];

    const events = await askVia(harness, "date");

    expect(terminal(events)).toBe("assistant_committed");
    expect(shownText(events)).toBe("那天你说缝了帆布包。");
    // One Decision call, then the answer call twice: the empty one and the retry.
    const answerCalls = harness.state.requests.filter((request) => request.toolsDisabled);
    expect(answerCalls).toHaveLength(2);
    expect(answerCalls[1]!.messages).toEqual(answerCalls[0]!.messages);
    const added = (await commands()).slice(before);
    expect(
      added.map((command) => `${command.stage} ${command.status} ${command.attempts}`).toSorted(),
    ).toEqual(["decision succeeded 1", "history_answer succeeded 2"]);
    expect(await assistantTexts()).toContain("那天你说缝了帆布包。");
  });

  it("fails closed after a second empty reply: one retry only, nothing shown, nothing committed", async () => {
    await seedLife(harness);
    const committedBefore = await assistantTexts();
    harness.state.emptyReplies = 2;

    const events = await askVia(harness, "date");

    expect(events.at(-1)).toMatchObject({ category: "invalid_response", type: "response_failed" });
    expect(shownText(events)).toBe("");
    expect(harness.state.requests.filter((request) => request.toolsDisabled)).toHaveLength(2);
    expect((await assistantTexts()).toSorted()).toEqual(committedBefore.toSorted());
    const answer = (await commands()).filter((command) => command.stage === "history_answer").at(-1)!;
    expect([answer.status, answer.attempts]).toEqual(["failed", "2"]);
  });

  it("retries an ordinary reply the same way", async () => {
    harness.state.emptyReplies = 1;
    const events = await harness.say("今天有点累。", "2026-09-15T02:10:00.000Z", "辛苦了。");

    expect(terminal(events)).toBe("assistant_committed");
    expect(shownText(events)).toBe("辛苦了。");
    expect(harness.state.requests).toHaveLength(2);
    const [command] = await commands();
    expect([command!.stage, command!.status, command!.attempts]).toEqual(["decision", "succeeded", "2"]);
  });

  it("does not send a source again once the person asked to forget it between the two calls", async () => {
    await seedLife(harness);
    harness.state.emptyReplies = 1;
    harness.state.hooks.duringEmptyReply = async () => {
      await harness.seedForget(U_BAG);
    };

    const events = await askVia(harness, "date");

    const answerCalls = harness.state.requests.filter((request) => request.toolsDisabled);
    // The first call left before the control landed and carried the source.
    expect(answerCalls[0]!.messages.join("\n")).toContain(U_BAG);
    // Whatever happens next, the forgotten source is neither sent nor shown again.
    for (const later of answerCalls.slice(1)) {
      expect(later.messages.join("\n") + later.instructions).not.toContain(U_BAG);
    }
    expect(shownText(events)).not.toContain("帆布包");
  });
});
