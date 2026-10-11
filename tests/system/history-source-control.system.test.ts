import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { asGenerationCommandId } from "@sayhear/domain";
import { PostgresInternalInspectionRepository } from "@sayhear/data";

import {
  ASK_AT,
  ENTRANCES,
  OWNER,
  U_BAG,
  U_BAG_REPLY,
  U_REPAIR,
  askVia,
  createHistoryPathHarness,
  seedLife,
  shownText,
  terminal,
  type EntranceName,
  type Hooks,
} from "../support/history-path-harness";

/**
 * Issue #320: the user controls (Correction, Forget, Data Epoch / Purge) win
 * every race against every history entrance. The same synthetic owner goes
 * through the real write path, the three read entrances (date review, older
 * experience search, natural continuation), compile, Egress, the stream and
 * the complete commit. A control lands at each point of the request and the
 * suite asserts, at the Provider boundary and the Assistant Event table, that
 * nothing forbidden is sent afterwards, shown anew or accepted.
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

type Control = "correct" | "epoch" | "forget";
type Point =
  | "after_compile"
  | "after_first_token"
  | "after_freeze"
  | "after_read"
  | "before_first_token"
  | "before_read";

const NEW_WORDING = "路过修鞋摊，其实没学成缝纫。";

async function applyControl(control: Control): Promise<void> {
  if (control === "forget") await harness.seedForget(U_BAG);
  else if (control === "correct") await harness.correctMessage(U_BAG, NEW_WORDING);
  else await harness.bumpEpoch();
}

const HOOK_FOR_POINT: Record<Exclude<Point, "before_read">, keyof Hooks> = {
  after_compile: "afterAnswerCompile",
  after_first_token: "afterFirstDelta",
  after_freeze: "afterAdmit",
  after_read: "afterRead",
  before_first_token: "beforeFirstDelta",
};

const outboundText = () =>
  harness.state.requests
    .map((request) => `${request.instructions}\n${request.messages.join("\n")}`)
    .join("\n=====\n");

async function assistantEventsFromAsk(): Promise<number> {
  return (
    await harness.rows(
      "SELECT 1 FROM conversation_events WHERE actor = 'assistant' AND created_at >= $1",
      [new Date(ASK_AT)],
    )
  ).length;
}

const failed = (events: readonly { type: string }[]) =>
  ["response_failed", "response_interrupted"].includes(events.at(-1)?.type ?? "");

describe("a control that lands at any point of a history request is honoured by every entrance", () => {
  const entrances: EntranceName[] = ["date", "search", "continuation"];
  const cases: ReadonlyArray<readonly [Control, Point]> = [
    ["forget", "before_read"],
    ["forget", "after_read"],
    ["forget", "after_freeze"],
    ["forget", "after_compile"],
    ["forget", "before_first_token"],
    ["forget", "after_first_token"],
    ["correct", "before_read"],
    ["correct", "after_read"],
    ["correct", "after_freeze"],
    ["correct", "after_compile"],
    ["correct", "before_first_token"],
    ["correct", "after_first_token"],
    ["epoch", "after_read"],
    ["epoch", "after_compile"],
    ["epoch", "after_first_token"],
  ];

  for (const entrance of entrances) {
    for (const [control, point] of cases) {
      it(`${entrance}: ${control} ${point.replaceAll("_", " ")}`, async () => {
        await seedLife(harness);
        if (point === "before_read") {
          await applyControl(control);
        } else {
          harness.state.hooks[HOOK_FOR_POINT[point]] = () => applyControl(control);
        }
        const events = await askVia(harness, entrance);
        const outbound = outboundText();
        const answerRequests = harness.state.requests.filter((request) => request.toolsDisabled);

        // The forbidden source, and the reply that was generated for it, are
        // never sent in any request the control could still have prevented.
        const sentBeforeControl = point === "before_first_token" || point === "after_first_token";
        if (!sentBeforeControl) {
          expect(outbound).not.toContain(U_BAG);
          expect(outbound).not.toContain(U_BAG_REPLY);
        }

        if (control === "epoch" && point === "after_read") {
          // The Data Epoch moved while reading: the frozen result is refused.
          expect(failed(events)).toBe(true);
          expect(answerRequests).toHaveLength(0);
          expect(await assistantEventsFromAsk()).toBe(0);
        } else if (point === "after_compile" || (control === "epoch" && point === "after_freeze")) {
          // Compiled but not yet sent: dispatch is refused, zero answer outbound.
          expect(failed(events)).toBe(true);
          expect(answerRequests).toHaveLength(0);
          expect(shownText(events)).toBe("");
          expect(await assistantEventsFromAsk()).toBe(0);
        } else if (point === "before_first_token") {
          // Sent while still permitted; nothing may be shown or accepted after.
          expect(answerRequests).toHaveLength(1);
          expect(failed(events)).toBe(true);
          expect(shownText(events)).toBe("");
          expect(await assistantEventsFromAsk()).toBe(0);
        } else if (point === "after_first_token") {
          // The part already shown cannot be taken back; it is never committed.
          expect(answerRequests).toHaveLength(1);
          expect(shownText(events).length).toBeGreaterThan(0);
          expect(terminal(events)).toBe("response_interrupted");
          expect(await assistantEventsFromAsk()).toBe(0);
        } else {
          // before read / after read / after freeze with Forget or Correction:
          // the answer is still produced, without the excluded source.
          expect(terminal(events)).toBe("assistant_committed");
          expect(answerRequests).toHaveLength(1);
          expect(await assistantEventsFromAsk()).toBe(1);
          if (control === "correct" && point === "before_read" && entrance === "date") {
            // The person's corrected wording is the live source and is used.
            // (When the correction lands after the read, the frozen result
            // names only the old revision, so the new wording is simply not
            // part of this answer; it is never silently swapped in.)
            expect(answerRequests[0]!.messages.join("\n")).toContain(NEW_WORDING);
          }
          if (entrance === "date") {
            // An independent permitted experience is not suppressed.
            expect(answerRequests[0]!.messages.join("\n")).toContain(U_REPAIR);
          }
        }
      });
    }
  }
});

describe("cached and recovered references do not bring back a forbidden source", () => {
  it("does not resend a blocked answer when the recovery scan finds it after a Forget", async () => {
    await seedLife(harness);
    harness.state.hooks.afterAnswerCompile = () => harness.seedForget(U_BAG);
    const events = await askVia(harness, "date");
    expect(failed(events)).toBe(true);
    const before = harness.state.requests.length;
    await harness.built.service.scanPendingHistoryAnswers?.();
    expect(harness.state.requests.length).toBe(before);
    expect(outboundTextAll()).not.toContain(U_BAG);
    expect(await assistantEventsFromAsk()).toBe(0);
  });

  it("asks again after a Forget and excludes the source although the earlier frozen result still names it", async () => {
    await seedLife(harness);
    await askVia(harness, "date");
    expect(outboundTextAll()).toContain(U_BAG);
    harness.state.requests.length = 0;
    await harness.seedForget(U_BAG);
    const events = await askVia(harness, "date");
    expect(terminal(events)).toBe("assistant_committed");
    expect(outboundTextAll()).not.toContain(U_BAG);
    expect(outboundTextAll()).not.toContain(U_BAG_REPLY);
  });

  it("keeps an excluded revision out of the experience search match as well as its neighbour context", async () => {
    await seedLife(harness);
    await harness.seedForget(U_BAG);
    const events = await askVia(harness, "search");
    expect(terminal(events)).toBe("assistant_committed");
    // The only message with the clue is excluded: nothing is quoted and the
    // reply does not point at what was removed.
    expect(outboundTextAll()).not.toContain(U_BAG);
    expect(outboundTextAll()).not.toContain(U_BAG_REPLY);
    expect(outboundTextAll()).not.toContain(U_REPAIR);
  });

  function outboundTextAll(): string {
    return outboundText();
  }
});

describe("the controlled Inspector does not hand back what a Forget removed or what was asked", () => {
  it("shows no query clue, no message text and no forgotten source in the answer command's inspection", async () => {
    await seedLife(harness);
    const events = await askVia(harness, "search");
    expect(terminal(events)).toBe("assistant_committed");
    const answer = (
      await harness.rows<{ answer_command_id: string }>(
        "SELECT answer_command_id::text FROM history_recall_results",
      )
    )[0]!;
    const metadata = await new PostgresInternalInspectionRepository(
      harness.database.pool,
    ).findGenerationMetadata({
      generationCommandId: asGenerationCommandId(answer.answer_command_id),
      userId: OWNER,
    });
    const serialized = JSON.stringify(metadata);
    // The search clue is private text: it reaches the model, never the panel.
    expect(serialized).not.toContain("帆布包");
    expect(serialized).not.toContain(U_BAG);
    expect(serialized).not.toContain(U_REPAIR);
    expect(metadata?.historyRecall?.role).toBe("answer");
  });
});

void ENTRANCES;
