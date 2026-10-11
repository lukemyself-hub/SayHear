import { afterEach, describe, expect, it } from "vitest";

import { HISTORY_REVIEW_FUNCTION_NAME, ProviderDispatchError } from "@sayhear/application";
import { PostgresInternalInspectionRepository } from "@sayhear/data";
import { asGenerationCommandId } from "@sayhear/domain";

import {
  ASK_AT,
  OWNER,
  U_BAG,
  U_BAG_REPLY,
  askVia,
  createHistoryPathHarness,
  seedLife,
  shownText,
  terminal,
  type HarnessOptions,
  type Hooks,
} from "../support/history-path-harness";

/**
 * Issue #320: the history branch has its own versioned, independent switch.
 * Closing it must leave ordinary chat and the seven-day background exactly as
 * they were, must stop a running request by rule, must never revive anything
 * a control already invalidated when it is opened again, and must not rewrite
 * a Context that was already frozen.
 */

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required.");
}

const harness = createHistoryPathHarness(testDatabaseUrl);

afterEach(async () => {
  await harness.teardown();
}, 15_000);

async function start(options: HarnessOptions = {}): Promise<void> {
  await harness.setup(options);
}

const RECENT_TEXT = "这周三在公司楼下买了杯很烫的豆浆。";
const RECENT_AT = "2026-09-12T11:00:00.000Z";
const ORDINARY = "今天午饭吃了什么好呢。";

const outboundText = () =>
  harness.state.requests
    .map((request) => `${request.instructions}\n${request.messages.join("\n")}`)
    .join("\n=====\n");

const assistantEventsFromAsk = async () =>
  (
    await harness.rows(
      "SELECT 1 FROM conversation_events WHERE actor = 'assistant' AND created_at >= $1",
      [new Date(ASK_AT)],
    )
  ).length;

describe("closing the history branch leaves ordinary chat and the seven-day background alone", () => {
  it("offers no function, makes the question an ordinary single-command reply and claims no completed lookup", async () => {
    await start({ recentContext: true });
    await seedLife(harness);
    await harness.say(RECENT_TEXT, RECENT_AT, "烫的豆浆要小心。");
    harness.state.requests = [];
    await harness.disableGovernance();

    const events = await askVia(harness, "date");

    expect(terminal(events)).toBe("assistant_committed");
    expect(harness.state.requests).toHaveLength(1);
    const only = harness.state.requests[0]!;
    expect(only.functionNames).not.toContain(HISTORY_REVIEW_FUNCTION_NAME);
    // The recent background is still carried exactly as before.
    expect(only.messages.join("\n")).toContain(RECENT_TEXT);
    // Nothing pretends the older day was looked up.
    expect(outboundText()).not.toContain("History review result");
    expect(outboundText()).not.toContain(U_BAG);
    expect(await harness.rows("SELECT 1 FROM history_recall_results")).toHaveLength(0);
    expect(
      (await harness.rows<{ generation_stage: string }>(
        "SELECT generation_stage FROM generation_commands WHERE created_at >= $1",
        [new Date(ASK_AT)],
      )).map((row) => row.generation_stage),
    ).toEqual(["decision"]);
  });

  it("sends the same ordinary-turn Context whether the branch is closed, open or not deployed at all", async () => {
    const sent: string[] = [];
    for (const variant of ["not_deployed", "open", "closed"] as const) {
      await harness.teardown().catch(() => undefined);
      await start({ noGateway: variant === "not_deployed", recentContext: true });
      await seedLife(harness);
      await harness.say(RECENT_TEXT, RECENT_AT, "烫的豆浆要小心。");
      harness.state.requests = [];
      if (variant === "closed") await harness.disableGovernance();
      harness.state.review = null;
      await harness.say(ORDINARY, ASK_AT);
      expect(harness.state.requests).toHaveLength(1);
      const request = harness.state.requests[0]!;
      // The function list is the only permitted difference.
      sent.push(
        `${request.instructions}\n${request.messages.join("\n")}`.replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
          "<id>",
        ),
      );
      expect(request.messages.join("\n")).toContain(RECENT_TEXT);
    }
    expect(sent[1]).toBe(sent[0]);
    expect(sent[2]).toBe(sent[0]);
  });
});

describe("a running request stops by rule when the branch is closed", () => {
  const stops: ReadonlyArray<readonly [string, keyof Hooks]> = [
    ["while the Decision is deciding", "duringDecision"],
    ["after the result was read, before it is frozen", "afterRead"],
    ["after the result was frozen", "afterAdmit"],
    ["after the answer was compiled", "afterAnswerCompile"],
    ["before the first visible token", "beforeFirstDelta"],
  ];

  for (const [label, hook] of stops) {
    it(`sends and shows nothing more ${label}`, async () => {
      await start();
      await seedLife(harness);
      harness.state.hooks[hook] = () => harness.disableGovernance();
      const events = await askVia(harness, "date");

      expect(["response_failed", "response_interrupted"]).toContain(terminal(events));
      expect(shownText(events)).toBe("");
      expect(await assistantEventsFromAsk()).toBe(0);
      const answers = harness.state.requests.filter((request) => request.toolsDisabled);
      // Only a request that already left while the branch was open may exist.
      expect(answers.length).toBeLessThanOrEqual(hook === "beforeFirstDelta" ? 1 : 0);
      if (hook === "duringDecision" || hook === "afterRead") {
        expect(await harness.rows("SELECT 1 FROM history_recall_results")).toHaveLength(0);
      }
    });
  }

  it("cannot take back what was already shown, but never accepts it as an Assistant Event", async () => {
    await start();
    await seedLife(harness);
    harness.state.hooks.afterFirstDelta = () => harness.disableGovernance();
    const events = await askVia(harness, "date");
    expect(terminal(events)).toBe("response_interrupted");
    expect(shownText(events).length).toBeGreaterThan(0);
    expect(await assistantEventsFromAsk()).toBe(0);
  });
});

describe("opening the branch again revives nothing", () => {
  it("keeps a result frozen under a closed version unusable, even for the recovery scan", async () => {
    await start();
    await seedLife(harness);
    harness.state.hooks.afterAnswerCompile = () => harness.disableGovernance();
    const failedEvents = await askVia(harness, "date");
    expect(["response_failed", "response_interrupted"]).toContain(terminal(failedEvents));
    const [frozen] = await harness.rows<{ governance_policy_version: string }>(
      "SELECT governance_policy_version FROM history_recall_results",
    );
    const firstVersion = frozen!.governance_policy_version;

    const secondVersion = await harness.enableGovernance();
    expect(secondVersion).not.toBe(firstVersion);
    const before = harness.state.requests.length;
    await harness.built.service.scanPendingHistoryAnswers?.();
    expect(harness.state.requests.length).toBe(before);
    expect(await assistantEventsFromAsk()).toBe(0);
    const statuses = await harness.rows<{ policy_version: string; status: string }>(
      "SELECT policy_version, status FROM history_recall_policies ORDER BY created_at",
    );
    expect(statuses).toEqual([
      { policy_version: firstVersion, status: "revoked" },
      { policy_version: secondVersion, status: "active" },
    ]);
  });

  it("still excludes a source that was forgotten while the branch was closed", async () => {
    await start();
    await seedLife(harness);
    await harness.disableGovernance();
    await harness.seedForget(U_BAG);
    await harness.enableGovernance();
    const events = await askVia(harness, "date");
    expect(terminal(events)).toBe("assistant_committed");
    expect(outboundText()).not.toContain(U_BAG);
    expect(outboundText()).not.toContain(U_BAG_REPLY);
  });

  it("does not rewrite the Context, references or result of an earlier answer when closed and opened", async () => {
    await start();
    await seedLife(harness);
    expect(terminal(await askVia(harness, "date"))).toBe("assistant_committed");
    const snapshot = async () => ({
      contexts: await harness.rows("SELECT * FROM compiled_contexts ORDER BY compiled_context_id"),
      refs: await harness.rows(
        "SELECT * FROM compiled_context_revision_refs ORDER BY compiled_context_id, ordinal",
      ),
      results: await harness.rows("SELECT * FROM history_recall_results ORDER BY created_at"),
    });
    const before = JSON.stringify(await snapshot());

    await harness.disableGovernance();
    await harness.say(ORDINARY, "2026-09-15T03:00:00.000Z");
    await harness.enableGovernance();

    const after = await snapshot();
    // The earlier rows are byte-for-byte what they were; only new rows appear.
    const earlier = JSON.parse(before) as { contexts: unknown[]; refs: unknown[]; results: unknown[] };
    expect(JSON.stringify(after.results)).toBe(JSON.stringify(earlier.results));
    for (const context of earlier.contexts) {
      expect(JSON.stringify(after.contexts)).toContain(JSON.stringify(context));
    }
    for (const ref of earlier.refs) {
      expect(JSON.stringify(after.refs)).toContain(JSON.stringify(ref));
    }
    // The earlier answer stays inspectable after the branch was closed.
    const [row] = await harness.rows<{ answer_command_id: string }>(
      "SELECT answer_command_id::text FROM history_recall_results",
    );
    const metadata = await new PostgresInternalInspectionRepository(
      harness.database.pool,
    ).findGenerationMetadata({
      generationCommandId: asGenerationCommandId(row!.answer_command_id),
      userId: OWNER,
    });
    expect(metadata?.historyRecall?.status).toBe("completed");
  });

  it("answers a history question again after the branch is opened with a new version", async () => {
    await start();
    await seedLife(harness);
    await harness.disableGovernance();
    expect(terminal(await askVia(harness, "date"))).toBe("assistant_committed");
    expect(await harness.rows("SELECT 1 FROM history_recall_results")).toHaveLength(0);
    await harness.enableGovernance();
    harness.state.requests = [];
    expect(terminal(await askVia(harness, "date"))).toBe("assistant_committed");
    expect(harness.state.requests.some((request) => request.toolsDisabled)).toBe(true);
    const [frozen] = await harness.rows<{ governance_policy_version: string }>(
      "SELECT governance_policy_version FROM history_recall_results",
    );
    expect(frozen!.governance_policy_version).toMatch(/^history-recall-governance:/);
  });
});

/**
 * A process that dies after the Decision froze the lookup and created the
 * History Answer command leaves that command pending. Whether the branch was
 * later closed by the operator or taken out of the deployment, the Turn must
 * still reach a final state: no reply is produced, nothing is shown, nothing
 * is committed, and the person can Retry explicitly.
 */
describe("a History Answer left pending by a dead process is settled when the branch is closed", () => {
  async function leaveAnswerPending(): Promise<void> {
    (harness.built.harness as { runHistoryAnswerCommand: unknown }).runHistoryAnswerCommand =
      // eslint-disable-next-line require-yield
      async function* () {
        await new Promise<never>(() => undefined);
      };
    void askVia(harness, "date").catch(() => undefined);
    for (let waited = 0; waited < 200; waited += 1) {
      if (
        (await harness.rows("SELECT 1 FROM generation_commands WHERE generation_stage = 'history_answer'"))
          .length > 0
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("The History Answer command was never created.");
  }

  const pendingState = () =>
    harness.rows<{ attempt_status: string; command_status: string; turn_status: string }>(
      `SELECT command.status AS command_status, attempt.status AS attempt_status, turn.status AS turn_status
       FROM generation_commands command
       INNER JOIN model_run_attempts attempt ON attempt.generation_command_id = command.generation_command_id
       INNER JOIN interaction_turns turn ON turn.interaction_turn_id = command.interaction_turn_id
       WHERE command.generation_stage = 'history_answer'`,
    );

  const LATER = "2026-09-15T02:20:00.000Z";

  it("settles it fail closed when the deployment no longer runs the history branch", async () => {
    await start();
    await seedLife(harness);
    await leaveAnswerPending();
    expect((await pendingState())[0]!.turn_status).toBe("responding");

    harness.rebuild({ noGateway: true });
    const sent = harness.state.requests.length;

    // A live request is not preempted: nothing is due inside the recovery window.
    harness.setNow("2026-09-15T02:11:00.000Z");
    expect(await harness.built.service.scanPendingHistoryAnswers?.()).toBe(0);
    expect((await pendingState())[0]!.turn_status).toBe("responding");

    harness.setNow(LATER);
    expect(await harness.built.service.scanPendingHistoryAnswers?.()).toBe(1);
    expect(await pendingState()).toEqual([
      { attempt_status: "failed", command_status: "failed", turn_status: "failed" },
    ]);
    expect(harness.state.requests.length).toBe(sent);
    expect(await assistantEventsFromAsk()).toBe(0);
    // Settled once: the next scan finds nothing.
    expect(await harness.built.service.scanPendingHistoryAnswers?.()).toBe(0);
  });

  it("still finds and answers a command whose technical retry was in flight when the process died", async () => {
    await start();
    await seedLife(harness);
    // The first answer attempt times out and is retried; the process dies while
    // the second attempt is on the wire.
    harness.state.hooks.beforeFirstDelta = async () => {
      harness.state.hooks.beforeFirstDelta = () => new Promise<never>(() => undefined);
      throw new ProviderDispatchError("timeout");
    };
    void askVia(harness, "date").catch(() => undefined);
    for (let waited = 0; waited < 200; waited += 1) {
      const attempts = await harness.rows(
        `SELECT 1 FROM model_run_attempts attempt
         INNER JOIN generation_commands command ON command.generation_command_id = attempt.generation_command_id
         WHERE command.generation_stage = 'history_answer' AND attempt.attempt_no = 2`,
      );
      if (attempts.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    harness.rebuild();
    harness.setNow("2026-09-15T02:20:00.000Z");
    expect(await harness.built.service.scanPendingHistoryAnswers?.()).toBe(1);
    expect(await assistantEventsFromAsk()).toBe(1);
    expect((await pendingState())[0]).toMatchObject({ command_status: "succeeded", turn_status: "settled" });
  });

  it("settles it fail closed when the operator closed the branch", async () => {
    await start();
    await seedLife(harness);
    await leaveAnswerPending();
    harness.rebuild();
    await harness.disableGovernance();
    const sent = harness.state.requests.length;

    harness.setNow(LATER);
    await harness.built.service.scanPendingHistoryAnswers?.();
    expect(await pendingState()).toEqual([
      { attempt_status: "failed", command_status: "failed", turn_status: "failed" },
    ]);
    expect(harness.state.requests.length).toBe(sent);
    expect(await assistantEventsFromAsk()).toBe(0);
  });
});
