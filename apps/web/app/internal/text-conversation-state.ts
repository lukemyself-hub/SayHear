/**
 * Pure presentation and decision helpers for the current text conversation
 * composer, waiting feedback, scroll-follow and failure recovery.
 *
 * All functions here are side-effect free and DOM-free so the keyboard,
 * wait-lifecycle, scroll and failure decisions stay unit-testable. The client
 * component owns the actual refs, fetch/NDJSON stream and React state.
 *
 * Product safety notes:
 * - `user_committed` is the only signal that the user message is saved; the
 *   waiting dots only appear after it. Nothing here fabricates progress.
 * - Failure plans never resend silently: a failure before `user_committed`
 *   preserves the idempotent submission identity, and a failure after it keeps
 *   the message saved exactly once.
 */

export type SendDecision = "ignore" | "newline" | "send";

/**
 * Decides what an Enter keypress on the composer should do. IME composition
 * Enter here only confirms the candidate (`"ignore"`), Shift+Enter inserts a
 * newline, and blank content never sends. A message may be sent while an
 * earlier reply is still being prepared; it supersedes that reply.
 */
export function decideSend(input: {
  composing: boolean;
  key: string;
  shiftKey: boolean;
  submitting: boolean;
  text: string;
}): SendDecision {
  if (input.key !== "Enter") {
    return "ignore";
  }
  if (input.composing) {
    return "ignore";
  }
  if (input.shiftKey) {
    return "newline";
  }
  // `submitting` no longer blocks a send (issue #319): a message sent while a
  // reply is still being prepared adds to the question or changes the subject,
  // and the newer message retires the older answer.
  if (input.text.trim().length === 0) {
    return "ignore";
  }
  return "send";
}

export type WaitPhase =
  | "idle"
  | "submitting"
  | "awaiting"
  | "streaming"
  | "settled"
  | "stopped"
  | "failed";

export type WaitState = Readonly<{ phase: WaitPhase; text: string }>;

export type WaitEvent =
  | Readonly<{ type: "submit" }>
  | Readonly<{ type: "user_committed" }>
  | Readonly<{ type: "assistant_delta"; delta: string }>
  | Readonly<{ type: "assistant_committed" }>
  | Readonly<{ type: "action_admitted" }>
  | Readonly<{ type: "response_interrupted" }>
  | Readonly<{ type: "response_failed" }>
  | Readonly<{ type: "stream_error" }>
  | Readonly<{ type: "stop" }>
  | Readonly<{ type: "reset" }>;

export const INITIAL_WAIT_STATE: WaitState = Object.freeze({
  phase: "idle",
  text: "",
});

/**
 * Waiting lifecycle: idle -> submitting (request in flight, before the user
 * message is confirmed) -> awaiting (user message saved, first-assistant text
 * still pending: exactly three dots) -> streaming (first delta arrived) ->
 * settled / failed (terminal). Deltas accumulate; every terminal event stops
 * the waiting state.
 */
export function reduceWaitState(
  state: WaitState,
  event: WaitEvent,
): WaitState {
  switch (event.type) {
    case "submit":
      return { phase: "submitting", text: "" };
    case "user_committed":
      return state.phase === "streaming"
        ? state
        : { phase: "awaiting", text: "" };
    case "assistant_delta":
      return { phase: "streaming", text: state.text + event.delta };
    case "assistant_committed":
    case "action_admitted":
      return { phase: "settled", text: "" };
    case "response_interrupted":
    case "response_failed":
    case "stream_error":
      return { phase: "failed", text: "" };
    case "stop":
      return { phase: "stopped", text: "" };
    case "reset":
      return INITIAL_WAIT_STATE;
  }
  return state;
}

/** The three sequential dots are shown only between commit and first delta. */
export function waitingDotsVisible(state: WaitState): boolean {
  return state.phase === "awaiting";
}

/** The streamed assistant text, or null while no delta has arrived. */
export function streamingText(state: WaitState): string | null {
  return state.phase === "streaming" ? state.text : null;
}

/** Whether a submission or retry is genuinely in flight. */
export function isInFlight(state: WaitState): boolean {
  return (
    state.phase === "submitting" ||
    state.phase === "awaiting" ||
    state.phase === "streaming"
  );
}

/**
 * The single polite announcement channel. It stays constant across deltas so
 * streamed text is never read out token by token.
 */
export function waitAnnouncement(state: WaitState): string {
  switch (state.phase) {
    case "submitting":
      return "正在发送";
    case "awaiting":
    case "streaming":
      return "正在生成回复";
    case "settled":
      return "回复完成";
    case "stopped":
      return "已停止";
    case "failed":
      return "回复失败";
    case "idle":
      return "";
  }
  return "";
}

export type SubmissionFailureKind =
  | "after_commit"
  | "before_commit"
  | "interrupted"
  | "unknown";

export type SubmissionFailurePlan = Readonly<{
  focus: "error";
  hasPartialText: boolean;
  kind: SubmissionFailureKind;
  preserveDraft: boolean;
  preservesSubmissionIdentity: boolean;
}>;

/**
 * Maps the observed submission outcome onto the documented recovery matrix:
 * - before_commit: nothing saved; keep the draft and reuse the same idempotent
 *   submission identity on an explicit retry.
 * - after_commit: the user message is saved exactly once; clear the draft and
 *   never resend.
 * - interrupted: partial assistant text stays read-only with the explicit
 *   retry; it is not official history or later Context.
 * - unknown (stream ended without a terminal event): keep the safe retry
 *   identity and never duplicate the user message.
 * Every terminal failure moves focus to the error notice.
 */
export function submissionFailurePlan(input: {
  hasPartialText: boolean;
  streamEndedWithoutTerminal: boolean;
  userCommitted: boolean;
}): SubmissionFailurePlan {
  if (!input.userCommitted) {
    return {
      focus: "error",
      hasPartialText: false,
      kind: input.streamEndedWithoutTerminal ? "unknown" : "before_commit",
      preserveDraft: true,
      preservesSubmissionIdentity: true,
    };
  }
  if (input.hasPartialText) {
    return {
      focus: "error",
      hasPartialText: true,
      kind: "interrupted",
      preserveDraft: false,
      preservesSubmissionIdentity: false,
    };
  }
  if (input.streamEndedWithoutTerminal) {
    return {
      focus: "error",
      hasPartialText: false,
      kind: "unknown",
      preserveDraft: false,
      preservesSubmissionIdentity: false,
    };
  }
  return {
    focus: "error",
    hasPartialText: false,
    kind: "after_commit",
    preserveDraft: false,
    preservesSubmissionIdentity: false,
  };
}

export const SCROLL_FOLLOW_THRESHOLD_PX = 48;

export type ScrollFollowState = Readonly<{
  following: boolean;
  showJumpToLatest: boolean;
}>;

export const INITIAL_SCROLL_FOLLOW_STATE: ScrollFollowState = Object.freeze({
  following: true,
  showJumpToLatest: false,
});

/** Whether the viewport is pinned close enough to the bottom to keep following. */
export function isNearBottom(input: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  threshold?: number;
}): boolean {
  const threshold = input.threshold ?? SCROLL_FOLLOW_THRESHOLD_PX;
  const distance =
    input.scrollHeight - input.scrollTop - input.clientHeight;
  return distance <= threshold;
}

export type ScrollFollowEvent =
  | Readonly<{ type: "scroll"; nearBottom: boolean }>
  | Readonly<{ type: "content" }>;

/**
 * Scroll-follow decision. Scrolling back to the bottom re-pins; scrolling up
 * un-pins without yanking the viewport. New content only reveals "回到最新"
 * while the reader is un-pinned, and clicking it re-pins.
 */
export function reduceScrollFollow(
  state: ScrollFollowState,
  event: ScrollFollowEvent,
): ScrollFollowState {
  if (event.type === "scroll") {
    if (event.nearBottom) {
      return state.following && !state.showJumpToLatest
        ? state
        : { following: true, showJumpToLatest: false };
    }
    return state.following
      ? { following: false, showJumpToLatest: state.showJumpToLatest }
      : state;
  }
  if (state.following || state.showJumpToLatest) {
    return state;
  }
  return { following: false, showJumpToLatest: true };
}

/**
 * Client-side stop condition (issue #319, ADR-0151). The server ends a request
 * at 30 seconds; the client waits two seconds longer so it normally hears the
 * server's own terminal event, and gives up on its own after that even if the
 * connection is silent.
 */
export const CLIENT_REQUEST_DEADLINE_MS = 32_000;

export type RequestEndedBy = "stop" | "superseded" | "timeout";

export type RequestEndedPlan = Readonly<{
  hasPartialText: boolean;
  kind: "stopped" | "superseded" | "timeout";
  preserveDraft: boolean;
  preservesSubmissionIdentity: boolean;
  /** Whether the person should see an error notice for this ending. */
  showError: boolean;
}>;

/**
 * What the composer does when the person ends a request (stop, or a newer
 * message replacing it) or the client deadline passes. Words already shown
 * stay as a read-only interrupted partial with the explicit Retry; a stop is
 * not an error; a request that ended before the message was confirmed keeps
 * its idempotent identity so sending again cannot create a second message.
 */
export function requestEndedPlan(input: {
  endedBy: RequestEndedBy;
  hasPartialText: boolean;
  userCommitted: boolean;
}): RequestEndedPlan {
  const restorable = !input.userCommitted && input.endedBy !== "superseded";
  return {
    hasPartialText: input.userCommitted && input.hasPartialText,
    kind:
      input.endedBy === "stop"
        ? "stopped"
        : input.endedBy === "superseded"
          ? "superseded"
          : "timeout",
    preserveDraft: restorable,
    preservesSubmissionIdentity: restorable,
    showError: input.endedBy === "timeout",
  };
}
