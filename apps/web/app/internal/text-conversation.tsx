"use client";

import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from "react";

import { MessageSurface } from "./message-time";
import { eventMessageCreatedAt } from "./message-time-presentation";
import { usePortalShell } from "./portal-shell";
import {
  decideSend,
  INITIAL_SCROLL_FOLLOW_STATE,
  INITIAL_WAIT_STATE,
  isInFlight,
  isNearBottom,
  reduceScrollFollow,
  reduceWaitState,
  streamingText,
  submissionFailurePlan,
  waitAnnouncement,
  waitingDotsVisible,
  type WaitState,
} from "./text-conversation-state";

type VisibleUserMessage = Readonly<{
  actor: "user" | "assistant";
  createdAt?: string | undefined;
  eventId: string;
  generationCommandId: string | null;
  locale: string;
  logicalDate?: string;
  revisionId: string;
  sequence: number;
  text: string;
}>;

type PendingSubmission = Readonly<{
  clientEventId: string;
  clientTurnId: string;
  locale: string;
  text: string;
  timezone: string;
}>;

type TimelineItem =
  | Readonly<{
      kind: "message";
      message: VisibleUserMessage;
    }>
  | Readonly<{
      kind: "interrupted";
      response: {
        logicalDate?: string;
        retryStatus: "available" | "retried" | "retrying";
        sequence: number;
        text: string;
        turnId: string;
      };
    }>;

const INTERRUPTED_MESSAGE =
  "The response was interrupted. Your message was saved; use Retry below to ask again explicitly.";

const SAVED_BUT_FAILED_MESSAGE =
  "SayHear could not complete the response. Your message was saved; start a new message to continue.";

const RETRY_INTERRUPTED_MESSAGE =
  "The retried response was also interrupted. It remains separate and can be retried explicitly.";

const TEXTAREA_MAX_HEIGHT_PX = 200;
const TEXTAREA_SINGLE_LINE_PX = 50;

export function TextConversation(props: {
  draftKey: string;
  initialInterruptedResponses: readonly {
    logicalDate: string;
    retryStatus: "available" | "retried" | "retrying";
    sequence: number;
    turnId: string;
  }[];
  initialMessages: readonly VisibleUserMessage[];
  statusLine: string | null;
  writeGate: Readonly<{ allowed: boolean; reason: string }>;
}) {
  const shell = usePortalShell();
  const [timeline, setTimeline] = useState<readonly TimelineItem[]>(() =>
    [
      ...props.initialMessages.map(
        (message): TimelineItem => ({ kind: "message", message }),
      ),
      ...props.initialInterruptedResponses.map(
        (response): TimelineItem => ({
          kind: "interrupted",
          response: {
            ...response,
            text: "Partial response text was not retained.",
          },
        }),
      ),
    ].sort(compareTimelineItems),
  );
  const [text, setText] = useState(() => shell?.draftFor(props.draftKey) ?? "");
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState<WaitState>(INITIAL_WAIT_STATE);
  const [multiline, setMultiline] = useState(false);
  const [scrollFollow, setScrollFollow] = useState(INITIAL_SCROLL_FOLLOW_STATE);
  const pending = useRef<PendingSubmission | null>(null);
  const retryRequestIds = useRef(new Map<string, string>());
  const inFlightRef = useRef(false);
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const followRef = useRef(true);

  const inFlight = isInFlight(wait);

  // Open the current conversation at its latest message.
  useEffect(() => {
    const node = listRef.current;
    if (node !== null) {
      node.scrollTop = node.scrollHeight;
    }
  }, []);

  // Auto-size the composer up to a cap, then let it scroll internally.
  useEffect(() => {
    const node = textareaRef.current;
    if (node === null) {
      return;
    }
    node.style.height = "auto";
    const height = Math.min(node.scrollHeight, TEXTAREA_MAX_HEIGHT_PX);
    node.style.height = `${height}px`;
    setMultiline(
      node.scrollHeight > TEXTAREA_SINGLE_LINE_PX + 1 || text.includes("\n"),
    );
  }, [text]);

  // Warn only while a submission or retry is genuinely in flight. In-app
  // navigation is Next.js's concern; this is the browser-level leave guard.
  useEffect(() => {
    if (!inFlight) {
      return;
    }
    function onBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [inFlight]);

  // A terminal failure moves focus to the error notice. Deltas never move focus.
  useEffect(() => {
    if (error !== null) {
      errorRef.current?.focus();
    }
  }, [error]);

  useEffect(() => {
    followRef.current = scrollFollow.following;
  }, [scrollFollow.following]);

  // Follow the bottom only while already pinned; otherwise reveal "回到最新".
  useEffect(() => {
    const node = listRef.current;
    if (node === null) {
      return;
    }
    if (followRef.current) {
      node.scrollTop = node.scrollHeight;
    } else {
      setScrollFollow((current) =>
        reduceScrollFollow(current, { type: "content" }),
      );
    }
  }, [timeline, wait]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    const native = event.nativeEvent;
    const decision = decideSend({
      // The ref covers the "composition ended this tick" edge and Safari's
      // keyCode 229, in addition to the native isComposing flag.
      composing:
        composingRef.current || native.isComposing || native.keyCode === 229,
      key: event.key,
      shiftKey: event.shiftKey,
      submitting: inFlight || inFlightRef.current,
      text,
    });
    if (decision === "send") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function handleScroll(): void {
    const node = listRef.current;
    if (node === null) {
      return;
    }
    const nearBottom = isNearBottom({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
    });
    setScrollFollow((current) =>
      reduceScrollFollow(current, { nearBottom, type: "scroll" }),
    );
  }

  function jumpToLatest(): void {
    const node = listRef.current;
    if (node !== null) {
      node.scrollTop = node.scrollHeight;
    }
    setScrollFollow({ following: true, showJumpToLatest: false });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current) {
      return;
    }
    if (pending.current === null && text.trim().length === 0) {
      return;
    }

    const submission =
      pending.current ??
      ({
        clientEventId: crypto.randomUUID(),
        clientTurnId: crypto.randomUUID(),
        locale: navigator.language,
        text,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      } satisfies PendingSubmission);
    pending.current = submission;
    inFlightRef.current = true;
    setWait((current) => reduceWaitState(current, { type: "submit" }));
    setError(null);
    let userCommitted = false;
    let terminalEvent:
      | "action_admitted"
      | "assistant_committed"
      | "response_failed"
      | "response_interrupted"
      | null = null;
    let currentTurnId: string | null = null;
    let currentGenerationCommandId: string | null = null;
    let responseCommitted = false;
    let streamedAssistantText = "";

    try {
      const response = await fetch("/api/internal/conversation/responses", {
        body: JSON.stringify(submission),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`The message could not be recorded (${response.status}).`);
      }
      for await (const result of readNdjson(response)) {
        if (result.type === "user_committed") {
          userCommitted = true;
          const committed = result as {
            generationCommandId: string;
            message: VisibleUserMessage & { id: string };
            turnId: string;
          };
          currentTurnId = committed.turnId;
          currentGenerationCommandId = committed.generationCommandId;
          const message = {
            actor: "user" as const,
            createdAt: eventMessageCreatedAt(committed.message.createdAt),
            eventId: committed.message.id,
            generationCommandId: null,
            locale: committed.message.locale,
            revisionId: committed.message.revisionId,
            sequence: committed.message.sequence,
            text: committed.message.text,
          };
          setTimeline((current) =>
            current.some(
              (item) =>
                item.kind === "message" &&
                item.message.eventId === message.eventId,
            )
              ? current
              : [...current, { kind: "message", message }],
          );
          setWait((current) =>
            reduceWaitState(current, { type: "user_committed" }),
          );
        } else if (result.type === "assistant_delta") {
          const delta =
            "delta" in result && typeof result.delta === "string"
              ? result.delta
              : "";
          streamedAssistantText += delta;
          setWait((current) =>
            reduceWaitState(current, { type: "assistant_delta", delta }),
          );
        } else if (result.type === "assistant_committed") {
          responseCommitted = true;
          terminalEvent = "assistant_committed";
          const committed = result as {
            createdAt?: unknown;
            eventId: string;
            revisionId: string;
          };
          setTimeline((current) =>
            current.some(
              (item) =>
                item.kind === "message" &&
                item.message.eventId === committed.eventId,
            )
              ? current
              : [
                  ...current,
                  {
                    kind: "message",
                    message: {
                      actor: "assistant",
                      createdAt: eventMessageCreatedAt(committed.createdAt),
                      eventId: committed.eventId,
                      generationCommandId: currentGenerationCommandId,
                      locale: submission.locale,
                      revisionId: committed.revisionId,
                      sequence: nextVisibleSequence(current),
                      text: streamedAssistantText,
                    },
                  },
                ],
          );
          setWait((current) =>
            reduceWaitState(current, { type: "assistant_committed" }),
          );
        } else if (result.type === "action_admitted") {
          responseCommitted = true;
          terminalEvent = "action_admitted";
          appendActionStatus(result, submission.locale, setTimeline);
          setWait((current) =>
            reduceWaitState(current, { type: "action_admitted" }),
          );
        } else if (result.type === "response_interrupted") {
          terminalEvent = "response_interrupted";
          setWait((current) =>
            reduceWaitState(current, { type: "response_interrupted" }),
          );
          throw new Error(INTERRUPTED_MESSAGE);
        } else if (result.type === "response_failed") {
          terminalEvent = "response_failed";
          setWait((current) =>
            reduceWaitState(current, { type: "response_failed" }),
          );
          throw new Error(SAVED_BUT_FAILED_MESSAGE);
        }
      }
      if (!responseCommitted) {
        throw new Error(
          streamedAssistantText.length > 0
            ? "The response stream ended after visible output."
            : "The response stream ended without a final result.",
        );
      }
      pending.current = null;
      setText("");
      shell?.clearDraft(props.draftKey);
    } catch (submissionError) {
      const plan = submissionFailurePlan({
        hasPartialText: streamedAssistantText.length > 0,
        streamEndedWithoutTerminal:
          !responseCommitted && terminalEvent === null,
        userCommitted,
      });
      if (plan.hasPartialText && currentTurnId !== null) {
        appendInterruptedResponse(
          currentTurnId,
          streamedAssistantText,
          setTimeline,
        );
      }
      if (!plan.preserveDraft) {
        setText("");
        shell?.clearDraft(props.draftKey);
      }
      if (!plan.preservesSubmissionIdentity) {
        pending.current = null;
      }
      setWait((current) => reduceWaitState(current, { type: "stream_error" }));
      setError(
        terminalEvent === "response_interrupted" || plan.hasPartialText
          ? INTERRUPTED_MESSAGE
          : plan.preservesSubmissionIdentity
            ? submissionError instanceof Error
              ? submissionError.message
              : "The message could not be recorded."
            : SAVED_BUT_FAILED_MESSAGE,
      );
    } finally {
      inFlightRef.current = false;
      if (responseCommitted) {
        // Keep the next message one keystroke away after a successful reply.
        textareaRef.current?.focus();
      }
    }
  }

  async function retryInterrupted(originalTurnId: string) {
    if (inFlightRef.current) {
      return;
    }
    const retryRequestId =
      retryRequestIds.current.get(originalTurnId) ?? crypto.randomUUID();
    retryRequestIds.current.set(originalTurnId, retryRequestId);
    updateRetryStatus(originalTurnId, "retrying", setTimeline);
    inFlightRef.current = true;
    setWait((current) => reduceWaitState(current, { type: "submit" }));
    setError(null);
    let retryTurnId: string | null = null;
    let retryGenerationCommandId: string | null = null;
    let responseCommitted = false;
    let streamedAssistantText = "";

    try {
      const response = await fetch("/api/internal/conversation/retries", {
        body: JSON.stringify({ originalTurnId, retryRequestId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`The response could not be retried (${response.status}).`);
      }
      for await (const result of readNdjson(response)) {
        if (result.type === "retry_committed") {
          retryTurnId =
            "turnId" in result && typeof result.turnId === "string"
              ? result.turnId
              : null;
          retryGenerationCommandId =
            "generationCommandId" in result &&
            typeof result.generationCommandId === "string"
              ? result.generationCommandId
              : null;
          setWait((current) =>
            reduceWaitState(current, { type: "user_committed" }),
          );
        } else if (result.type === "assistant_delta") {
          const delta =
            "delta" in result && typeof result.delta === "string"
              ? result.delta
              : "";
          streamedAssistantText += delta;
          setWait((current) =>
            reduceWaitState(current, { type: "assistant_delta", delta }),
          );
        } else if (result.type === "assistant_committed") {
          responseCommitted = true;
          const committed = result as {
            createdAt?: unknown;
            eventId: string;
            revisionId: string;
          };
          setTimeline((current) => [
            ...current,
            {
              kind: "message",
              message: {
                actor: "assistant",
                createdAt: eventMessageCreatedAt(committed.createdAt),
                eventId: committed.eventId,
                generationCommandId: retryGenerationCommandId,
                locale: navigator.language,
                revisionId: committed.revisionId,
                sequence: nextVisibleSequence(current),
                text: streamedAssistantText,
              },
            },
          ]);
          setWait((current) =>
            reduceWaitState(current, { type: "assistant_committed" }),
          );
          updateRetryStatus(originalTurnId, "retried", setTimeline);
        } else if (result.type === "action_admitted") {
          responseCommitted = true;
          appendActionStatus(result, navigator.language, setTimeline);
          setWait((current) =>
            reduceWaitState(current, { type: "action_admitted" }),
          );
          updateRetryStatus(originalTurnId, "retried", setTimeline);
        } else if (result.type === "response_interrupted") {
          setWait((current) =>
            reduceWaitState(current, { type: "response_interrupted" }),
          );
          throw new Error(RETRY_INTERRUPTED_MESSAGE);
        } else if (result.type === "response_failed") {
          retryRequestIds.current.delete(originalTurnId);
          updateRetryStatus(originalTurnId, "available", setTimeline);
          setWait((current) =>
            reduceWaitState(current, { type: "response_failed" }),
          );
          throw new Error(
            "SayHear could not complete the Retry. You can try again explicitly.",
          );
        }
      }
      if (!responseCommitted) {
        throw new Error(
          streamedAssistantText.length > 0
            ? "The retried response stream ended after visible output."
            : "The retried response stream ended without a final result.",
        );
      }
    } catch (retryError) {
      const hasPartialText = streamedAssistantText.length > 0;
      const disconnectedTurnId =
        !responseCommitted && retryTurnId !== null && hasPartialText
          ? retryTurnId
          : null;
      if (disconnectedTurnId !== null) {
        appendInterruptedResponse(
          disconnectedTurnId,
          streamedAssistantText,
          setTimeline,
        );
      }
      updateRetryStatus(
        originalTurnId,
        disconnectedTurnId !== null ? "retried" : "available",
        setTimeline,
      );
      setWait((current) => reduceWaitState(current, { type: "stream_error" }));
      setError(
        disconnectedTurnId !== null
          ? RETRY_INTERRUPTED_MESSAGE
          : retryError instanceof Error
            ? retryError.message
            : "The response could not be retried.",
      );
    } finally {
      inFlightRef.current = false;
      if (responseCommitted) {
        textareaRef.current?.focus();
      }
    }
  }

  const streamedText = streamingText(wait);

  return (
    <section className="conversation" aria-label="Text conversation">
      {props.statusLine ? (
        <p className="conversationStatus">{props.statusLine}</p>
      ) : null}
      <div className="conversationStream">
        <div className="messageList" onScroll={handleScroll} ref={listRef}>
          {timeline.length === 0 &&
          !waitingDotsVisible(wait) &&
          streamedText === null ? (
            <p className="emptyConversation">No Text messages recorded yet.</p>
          ) : (
            timeline.map((item, index) =>
              item.kind === "message" ? (
                <MessageSurface
                  actor={item.message.actor}
                  createdAt={item.message.createdAt}
                  generationCommandId={item.message.generationCommandId}
                  id={
                    isFirstItemForDate(
                      timeline,
                      index,
                      item.message.logicalDate,
                    )
                      ? `conversation-${item.message.logicalDate}`
                      : undefined
                  }
                  key={item.message.eventId}
                >
                  <p>{item.message.text}</p>
                </MessageSurface>
              ) : (
                <article
                  className="assistantMessage interruptedMessage"
                  key={`interrupted/${item.response.turnId}`}
                >
                  <p>{item.response.text}</p>
                  <em>Response interrupted</em>
                  <button
                    className="retryResponse"
                    disabled={
                      inFlight || item.response.retryStatus !== "available"
                    }
                    onClick={() => void retryInterrupted(item.response.turnId)}
                    type="button"
                  >
                    {item.response.retryStatus === "retrying"
                      ? "Retrying…"
                      : item.response.retryStatus === "retried"
                        ? "Retried separately"
                        : "Retry response"}
                  </button>
                </article>
              ),
            )
          )}
          {waitingDotsVisible(wait) ? (
            <article
              aria-hidden="true"
              className="assistantMessage waitingMessage"
            >
              <span className="waitingDots">
                <span className="waitingDot" />
                <span className="waitingDot" />
                <span className="waitingDot" />
              </span>
            </article>
          ) : null}
          {streamedText !== null ? (
            <article className="assistantMessage">
              <p>{streamedText}</p>
            </article>
          ) : null}
        </div>
        {scrollFollow.showJumpToLatest ? (
          <button className="jumpToLatest" onClick={jumpToLatest} type="button">
            回到最新
          </button>
        ) : null}
      </div>
      <form className="composer" onSubmit={submit}>
        <p className="visuallyHidden" role="status">
          {waitAnnouncement(wait)}
        </p>
        {!props.writeGate.allowed ? (
          <p className="composerBlocked" role="status">
            当前无法写入真实内容：{props.writeGate.reason}。查看历史与 Journal
            仍遵循各自已有的读取权限。
          </p>
        ) : null}
        <label htmlFor="user-text">Tell SayHear what is on your mind</label>
        <textarea
          className={`composerInput${multiline ? " isMultiline" : ""}`}
          disabled={inFlight || !props.writeGate.allowed}
          id="user-text"
          onChange={(event) => {
            pending.current = null;
            setText(event.target.value);
            shell?.setDraft(props.draftKey, event.target.value);
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onKeyDown={handleKeyDown}
          placeholder="Write naturally…"
          ref={textareaRef}
          rows={1}
          value={text}
        />
        <div className="composerActions">
          {error ? (
            <p
              className="submissionError"
              ref={errorRef}
              role="alert"
              tabIndex={-1}
            >
              {error}
            </p>
          ) : (
            <span />
          )}
          <button
            disabled={
              inFlight || !props.writeGate.allowed || text.trim().length === 0
            }
            type="submit"
          >
            {inFlight
              ? "发送中…"
              : error && pending.current
                ? "Retry request"
                : "Record message"}
          </button>
        </div>
      </form>
    </section>
  );
}

function appendInterruptedResponse(
  turnId: string,
  text: string,
  setTimeline: (
    update: (current: readonly TimelineItem[]) => readonly TimelineItem[],
  ) => void,
) {
  setTimeline((current) =>
    current.some(
      (item) =>
        item.kind === "interrupted" && item.response.turnId === turnId,
    )
      ? current
      : [
          ...current,
          {
            kind: "interrupted",
            response: {
              retryStatus: "available",
              sequence: nextVisibleSequence(current),
              text,
              turnId,
            },
          },
        ],
  );
}

function appendActionStatus(
  result: Record<string, unknown>,
  locale: string,
  setTimeline: Dispatch<SetStateAction<readonly TimelineItem[]>>,
): void {
  const receipt =
    typeof result.receipt === "object" && result.receipt !== null
      ? (result.receipt as Record<string, unknown>)
      : {};
  const admission =
    typeof receipt.admission === "string" ? receipt.admission : "rejected";
  const text =
    admission === "accepted"
      ? locale.toLowerCase().startsWith("zh")
        ? "已接受，Journal 正在重新生成。"
        : "Accepted. The Journal is being regenerated."
      : admission === "clarification_required"
        ? locale.toLowerCase().startsWith("zh")
          ? "这篇 Journal 已有新版本，需要重新确认目标。"
          : "The Journal changed; please choose the current version again."
        : locale.toLowerCase().startsWith("zh")
          ? "这项 Journal 操作没有执行。"
          : "The Journal action was not executed.";
  const actionStatusId = String(
    receipt.actionExecutionId ?? crypto.randomUUID(),
  );
  setTimeline((current) => [
    ...current,
    {
      kind: "message",
      message: {
        actor: "assistant",
        eventId: `action-status:${actionStatusId}`,
        generationCommandId: null,
        locale,
        revisionId: `action-status:${actionStatusId}`,
        sequence: nextVisibleSequence(current),
        text,
      },
    },
  ]);
}

function updateRetryStatus(
  turnId: string,
  retryStatus: "available" | "retried" | "retrying",
  setTimeline: (
    update: (current: readonly TimelineItem[]) => readonly TimelineItem[],
  ) => void,
) {
  setTimeline((current) =>
    current.map((item) =>
      item.kind === "interrupted" && item.response.turnId === turnId
        ? {
            ...item,
            response: { ...item.response, retryStatus },
          }
        : item,
    ),
  );
}

function isFirstItemForDate(
  timeline: readonly TimelineItem[],
  index: number,
  logicalDate: string | undefined,
): boolean {
  if (!logicalDate) return false;
  const previous = timeline[index - 1];
  const previousDate = previous?.kind === "message"
    ? previous.message.logicalDate
    : previous?.response.logicalDate;
  return previousDate !== logicalDate;
}

function nextVisibleSequence(timeline: readonly TimelineItem[]): number {
  return (
    timeline.reduce(
      (maximum, item) =>
        item.kind === "message"
          ? Math.max(maximum, item.message.sequence)
          : Math.max(maximum, item.response.sequence),
      0,
    ) + 1
  );
}

function compareTimelineItems(left: TimelineItem, right: TimelineItem): number {
  const leftDate =
    left.kind === "message"
      ? left.message.logicalDate
      : left.response.logicalDate;
  const rightDate =
    right.kind === "message"
      ? right.message.logicalDate
      : right.response.logicalDate;
  const dateOrder = (leftDate ?? "").localeCompare(rightDate ?? "");
  if (dateOrder !== 0) {
    return dateOrder;
  }
  const leftSequence =
    left.kind === "message"
      ? left.message.sequence
      : left.response.sequence + 0.5;
  const rightSequence =
    right.kind === "message"
      ? right.message.sequence
      : right.response.sequence + 0.5;
  return leftSequence - rightSequence;
}

async function* readNdjson(
  response: Response,
): AsyncIterable<Record<string, unknown>> {
  if (!response.body) {
    throw new Error("The response stream was unavailable.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          yield JSON.parse(line) as Record<string, unknown>;
        }
        newline = buffer.indexOf("\n");
      }
      if (chunk.done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
