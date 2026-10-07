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
 * newline, blank content never sends, and a submission already in flight is
 * never restarted.
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
  if (input.submitting) {
    return "ignore";
  }
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
