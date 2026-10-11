import { describe, expect, it } from "vitest";

import {
  decideSend,
  INITIAL_SCROLL_FOLLOW_STATE,
  INITIAL_WAIT_STATE,
  isInFlight,
  isNearBottom,
  reduceScrollFollow,
  requestEndedPlan,
  CLIENT_REQUEST_DEADLINE_MS,
  reduceWaitState,
  SCROLL_FOLLOW_THRESHOLD_PX,
  streamingText,
  submissionFailurePlan,
  waitAnnouncement,
  waitingDotsVisible,
  type ScrollFollowState,
  type WaitEvent,
  type WaitState,
} from "../apps/web/app/internal/text-conversation-state";

function apply(events: readonly WaitEvent[]): WaitState {
  return events.reduce(reduceWaitState, INITIAL_WAIT_STATE);
}

describe("composer send decision", () => {
  it("sends on a plain Enter with non-blank content", () => {
    expect(
      decideSend({
        composing: false,
        key: "Enter",
        shiftKey: false,
        submitting: false,
        text: "hello",
      }),
    ).toBe("send");
  });

  it("inserts a newline on Shift+Enter", () => {
    expect(
      decideSend({
        composing: false,
        key: "Enter",
        shiftKey: true,
        submitting: false,
        text: "hello",
      }),
    ).toBe("newline");
  });

  it("ignores Enter during IME composition", () => {
    expect(
      decideSend({
        composing: true,
        key: "Enter",
        shiftKey: false,
        submitting: false,
        text: "你好",
      }),
    ).toBe("ignore");
  });

  it("never sends blank or whitespace-only content", () => {
    expect(
      decideSend({
        composing: false,
        key: "Enter",
        shiftKey: false,
        submitting: false,
        text: "",
      }),
    ).toBe("ignore");
    expect(
      decideSend({
        composing: false,
        key: "Enter",
        shiftKey: false,
        submitting: false,
        text: "   \n  ",
      }),
    ).toBe("ignore");
  });

  it("lets a new message through while a reply is still being prepared (issue #319)", () => {
    // The person may add to the question or change the subject; the older
    // answer is retired by the newer message, so sending is never blocked.
    expect(
      decideSend({
        composing: false,
        key: "Enter",
        shiftKey: false,
        submitting: true,
        text: "hello",
      }),
    ).toBe("send");
    // A blank message still never sends, in flight or not.
    expect(
      decideSend({
        composing: false,
        key: "Enter",
        shiftKey: false,
        submitting: true,
        text: "   ",
      }),
    ).toBe("ignore");
  });

  it("ignores every other key", () => {
    expect(
      decideSend({
        composing: false,
        key: "a",
        shiftKey: false,
        submitting: false,
        text: "hello",
      }),
    ).toBe("ignore");
  });
});

describe("wait lifecycle", () => {
  it("starts idle with no dots, no streamed text and no announcement", () => {
    expect(INITIAL_WAIT_STATE.phase).toBe("idle");
    expect(waitingDotsVisible(INITIAL_WAIT_STATE)).toBe(false);
    expect(streamingText(INITIAL_WAIT_STATE)).toBeNull();
    expect(waitAnnouncement(INITIAL_WAIT_STATE)).toBe("");
    expect(isInFlight(INITIAL_WAIT_STATE)).toBe(false);
  });

  it("shows no dots before user_committed", () => {
    const state = apply([{ type: "submit" }]);
    expect(state.phase).toBe("submitting");
    expect(waitingDotsVisible(state)).toBe(false);
    expect(streamingText(state)).toBeNull();
    expect(waitAnnouncement(state)).toBe("正在发送");
    expect(isInFlight(state)).toBe(true);
  });

  it("shows exactly the dot phase between user_committed and first delta", () => {
    const state = apply([{ type: "submit" }, { type: "user_committed" }]);
    expect(state.phase).toBe("awaiting");
    expect(waitingDotsVisible(state)).toBe(true);
    expect(streamingText(state)).toBeNull();
    expect(waitAnnouncement(state)).toBe("正在生成回复");
  });

  it("replaces the dots with accumulated streamed text on deltas", () => {
    const state = apply([
      { type: "submit" },
      { type: "user_committed" },
      { type: "assistant_delta", delta: "Hel" },
      { type: "assistant_delta", delta: "lo" },
    ]);
    expect(state.phase).toBe("streaming");
    expect(waitingDotsVisible(state)).toBe(false);
    expect(streamingText(state)).toBe("Hello");
    // The announcement stays constant across deltas (no per-token reading).
    expect(waitAnnouncement(state)).toBe("正在生成回复");
  });

  it.each([
    ["assistant_committed" as const],
    ["action_admitted" as const],
  ])("settles on %s", (terminal) => {
    const state = apply([
      { type: "submit" },
      { type: "user_committed" },
      { type: "assistant_delta", delta: "Hi" },
      { type: terminal },
    ]);
    expect(state.phase).toBe("settled");
    expect(waitingDotsVisible(state)).toBe(false);
    expect(streamingText(state)).toBeNull();
    expect(waitAnnouncement(state)).toBe("回复完成");
    expect(isInFlight(state)).toBe(false);
  });

  it.each([
    ["response_interrupted" as const],
    ["response_failed" as const],
    ["stream_error" as const],
  ])("stops waiting on %s", (terminal) => {
    const state = apply([
      { type: "submit" },
      { type: "user_committed" },
      { type: "assistant_delta", delta: "partial" },
      { type: terminal },
    ]);
    expect(state.phase).toBe("failed");
    expect(waitingDotsVisible(state)).toBe(false);
    expect(streamingText(state)).toBeNull();
    expect(waitAnnouncement(state)).toBe("回复失败");
    expect(isInFlight(state)).toBe(false);
  });

  it("resets back to idle", () => {
    const state = apply([
      { type: "submit" },
      { type: "user_committed" },
      { type: "reset" },
    ]);
    expect(state).toEqual(INITIAL_WAIT_STATE);
  });
});

describe("scroll-follow decision", () => {
  it("uses a 48px bottom threshold", () => {
    expect(SCROLL_FOLLOW_THRESHOLD_PX).toBe(48);
    expect(
      isNearBottom({
        clientHeight: 400,
        scrollHeight: 1000,
        scrollTop: 600,
      }),
    ).toBe(true);
    expect(
      isNearBottom({
        clientHeight: 400,
        scrollHeight: 1000,
        scrollTop: 551,
      }),
    ).toBe(false);
  });

  it("stays pinned while content arrives at the bottom", () => {
    const state = reduceScrollFollow(INITIAL_SCROLL_FOLLOW_STATE, {
      type: "scroll",
      nearBottom: true,
    });
    expect(state).toBe(INITIAL_SCROLL_FOLLOW_STATE);
    expect(reduceScrollFollow(state, { type: "content" })).toEqual({
      following: true,
      showJumpToLatest: false,
    });
  });

  it("un-pins when the reader scrolls up and does not reveal the button yet", () => {
    const state = reduceScrollFollow(INITIAL_SCROLL_FOLLOW_STATE, {
      type: "scroll",
      nearBottom: false,
    });
    expect(state).toEqual({ following: false, showJumpToLatest: false });
  });

  it("reveals 回到最新 only when un-pinned content arrives", () => {
    const unPinned = reduceScrollFollow(INITIAL_SCROLL_FOLLOW_STATE, {
      type: "scroll",
      nearBottom: false,
    });
    const showing = reduceScrollFollow(unPinned, { type: "content" });
    expect(showing).toEqual({ following: false, showJumpToLatest: true });
    // Idempotent: more content while already showing keeps the same state.
    expect(reduceScrollFollow(showing, { type: "content" })).toBe(showing);
  });

  it("re-pins and hides 回到最新 after scrolling back to the bottom", () => {
    const showing: ScrollFollowState = {
      following: false,
      showJumpToLatest: true,
    };
    const repinned = reduceScrollFollow(showing, {
      type: "scroll",
      nearBottom: true,
    });
    expect(repinned).toEqual({ following: true, showJumpToLatest: false });
  });
});

describe("submission failure recovery matrix", () => {
  it("preserves the draft and submission identity before commit", () => {
    const plan = submissionFailurePlan({
      hasPartialText: false,
      streamEndedWithoutTerminal: false,
      userCommitted: false,
    });
    expect(plan).toEqual({
      focus: "error",
      hasPartialText: false,
      kind: "before_commit",
      preserveDraft: true,
      preservesSubmissionIdentity: true,
    });
  });

  it("keeps a safe retry identity for an unknown pre-commit result", () => {
    const plan = submissionFailurePlan({
      hasPartialText: false,
      streamEndedWithoutTerminal: true,
      userCommitted: false,
    });
    expect(plan.kind).toBe("unknown");
    expect(plan.preserveDraft).toBe(true);
    expect(plan.preservesSubmissionIdentity).toBe(true);
  });

  it("treats partial text after commit as an interrupted, read-only partial", () => {
    const plan = submissionFailurePlan({
      hasPartialText: true,
      streamEndedWithoutTerminal: false,
      userCommitted: true,
    });
    expect(plan).toEqual({
      focus: "error",
      hasPartialText: true,
      kind: "interrupted",
      preserveDraft: false,
      preservesSubmissionIdentity: false,
    });
  });

  it("never resends after commit and clears the draft", () => {
    const plan = submissionFailurePlan({
      hasPartialText: false,
      streamEndedWithoutTerminal: false,
      userCommitted: true,
    });
    expect(plan.kind).toBe("after_commit");
    expect(plan.preserveDraft).toBe(false);
    expect(plan.preservesSubmissionIdentity).toBe(false);
  });

  it("maps an unknown post-commit result onto the saved message without a resend", () => {
    const plan = submissionFailurePlan({
      hasPartialText: false,
      streamEndedWithoutTerminal: true,
      userCommitted: true,
    });
    expect(plan.kind).toBe("unknown");
    expect(plan.preserveDraft).toBe(false);
    expect(plan.preservesSubmissionIdentity).toBe(false);
    expect(plan.focus).toBe("error");
  });
});

describe("stopping and superseding a reply (issue #319)", () => {
  it("stops waiting when the person presses stop, without calling it a failure", () => {
    const state = apply([
      { type: "submit" },
      { type: "user_committed" },
      { type: "assistant_delta", delta: "partial" },
      { type: "stop" },
    ]);
    expect(state.phase).toBe("stopped");
    expect(isInFlight(state)).toBe(false);
    expect(streamingText(state)).toBeNull();
    expect(waitingDotsVisible(state)).toBe(false);
    expect(waitAnnouncement(state)).toBe("已停止");
  });

  it("keeps a stopped reply's visible words as a read-only interrupted partial with no error banner", () => {
    expect(
      requestEndedPlan({ endedBy: "stop", hasPartialText: true, userCommitted: true }),
    ).toEqual({
      hasPartialText: true,
      kind: "stopped",
      preserveDraft: false,
      preservesSubmissionIdentity: false,
      showError: false,
    });
  });

  it("lets a stop before the message was confirmed be sent again with the same identity", () => {
    expect(
      requestEndedPlan({ endedBy: "stop", hasPartialText: false, userCommitted: false }),
    ).toMatchObject({ preserveDraft: true, preservesSubmissionIdentity: true, showError: false });
  });

  it("does not put the older text back when a newer message replaced it", () => {
    expect(
      requestEndedPlan({ endedBy: "superseded", hasPartialText: true, userCommitted: true }),
    ).toEqual({
      hasPartialText: true,
      kind: "superseded",
      preserveDraft: false,
      preservesSubmissionIdentity: false,
      showError: false,
    });
    expect(
      requestEndedPlan({ endedBy: "superseded", hasPartialText: false, userCommitted: false }),
    ).toMatchObject({ preserveDraft: false, showError: false });
  });

  it("tells the person plainly when the 30 second stop condition ended the request", () => {
    expect(CLIENT_REQUEST_DEADLINE_MS).toBe(32_000);
    expect(
      requestEndedPlan({ endedBy: "timeout", hasPartialText: false, userCommitted: true }),
    ).toMatchObject({ kind: "timeout", showError: true, preserveDraft: false });
    expect(
      requestEndedPlan({ endedBy: "timeout", hasPartialText: false, userCommitted: false }),
    ).toMatchObject({ preserveDraft: true, preservesSubmissionIdentity: true, showError: true });
  });
});
