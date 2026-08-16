"use client";

import {
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";

type VisibleUserMessage = Readonly<{
  actor: "user" | "assistant";
  eventId: string;
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

export function TextConversation(props: {
  initialInterruptedResponses: readonly {
    logicalDate: string;
    retryStatus: "available" | "retried" | "retrying";
    sequence: number;
    turnId: string;
  }[];
  initialMessages: readonly VisibleUserMessage[];
}) {
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
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<{
    text: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef<PendingSubmission | null>(null);
  const retryRequestIds = useRef(new Map<string, string>());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || (pending.current === null && text.trim().length === 0)) {
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
    setSubmitting(true);
    setError(null);
    let userCommitted = false;
    let currentTurnId: string | null = null;
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
            message: VisibleUserMessage & { id: string };
            turnId: string;
          };
          currentTurnId = committed.turnId;
          const message = {
            actor: "user" as const,
            eventId: committed.message.id,
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
        } else if (result.type === "assistant_delta") {
          const delta =
            "delta" in result && typeof result.delta === "string"
              ? result.delta
              : "";
          streamedAssistantText += delta;
          if (currentTurnId) {
            setPendingAssistant({
              text: streamedAssistantText,
            });
          }
        } else if (result.type === "assistant_committed") {
          responseCommitted = true;
          const committed = result as {
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
                      eventId: committed.eventId,
                      locale: submission.locale,
                      revisionId: committed.revisionId,
                      sequence: nextVisibleSequence(current),
                      text: streamedAssistantText,
                    },
                  },
                ],
          );
          setPendingAssistant(null);
        } else if (result.type === "action_admitted") {
          responseCommitted = true;
          appendActionStatus(result, submission.locale, setTimeline);
          setPendingAssistant(null);
        } else if (result.type === "response_interrupted") {
          if (currentTurnId && streamedAssistantText.length > 0) {
            appendInterruptedResponse(
              currentTurnId,
              streamedAssistantText,
              setTimeline,
            );
            setPendingAssistant(null);
          }
          throw new Error(
            "The response was interrupted. Your message was saved; use Retry below to ask again explicitly.",
          );
        } else if (result.type === "response_failed") {
          throw new Error(
            "SayHear could not complete the response. Your message was saved; start a new message to continue.",
          );
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
    } catch (submissionError) {
      const disconnectedTurnId =
        !responseCommitted &&
        currentTurnId !== null &&
        streamedAssistantText.length > 0
          ? currentTurnId
          : null;
      if (disconnectedTurnId) {
        appendInterruptedResponse(
          disconnectedTurnId,
          streamedAssistantText,
          setTimeline,
        );
        setPendingAssistant(null);
      }
      if (userCommitted) {
        pending.current = null;
        setText("");
      }
      setError(
        disconnectedTurnId
          ? "The response was interrupted. Your message was saved; use Retry below to ask again explicitly."
          : submissionError instanceof Error
          ? submissionError.message
          : "The message could not be recorded.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function retryInterrupted(originalTurnId: string) {
    if (submitting) {
      return;
    }
    const retryRequestId =
      retryRequestIds.current.get(originalTurnId) ?? crypto.randomUUID();
    retryRequestIds.current.set(originalTurnId, retryRequestId);
    updateRetryStatus(originalTurnId, "retrying", setTimeline);
    setSubmitting(true);
    setError(null);
    let retryTurnId: string | null = null;
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
        } else if (result.type === "assistant_delta") {
          const delta =
            "delta" in result && typeof result.delta === "string"
              ? result.delta
              : "";
          streamedAssistantText += delta;
          if (retryTurnId) {
            setPendingAssistant({
              text: streamedAssistantText,
            });
          }
        } else if (result.type === "assistant_committed") {
          responseCommitted = true;
          const committed = result as {
            eventId: string;
            revisionId: string;
          };
          setTimeline((current) => [
            ...current,
            {
              kind: "message",
              message: {
                actor: "assistant",
                eventId: committed.eventId,
                locale: navigator.language,
                revisionId: committed.revisionId,
                sequence: nextVisibleSequence(current),
                text: streamedAssistantText,
              },
            },
          ]);
          setPendingAssistant(null);
          updateRetryStatus(originalTurnId, "retried", setTimeline);
        } else if (result.type === "action_admitted") {
          responseCommitted = true;
          appendActionStatus(result, navigator.language, setTimeline);
          setPendingAssistant(null);
          updateRetryStatus(originalTurnId, "retried", setTimeline);
        } else if (result.type === "response_interrupted") {
          if (retryTurnId && streamedAssistantText.length > 0) {
            appendInterruptedResponse(
              retryTurnId,
              streamedAssistantText,
              setTimeline,
            );
            setPendingAssistant(null);
            updateRetryStatus(originalTurnId, "retried", setTimeline);
          }
          throw new Error(
            "The retried response was also interrupted. It remains separate and can be retried explicitly.",
          );
        } else if (result.type === "response_failed") {
          retryRequestIds.current.delete(originalTurnId);
          updateRetryStatus(originalTurnId, "available", setTimeline);
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
      const disconnectedTurnId =
        !responseCommitted &&
        retryTurnId !== null &&
        streamedAssistantText.length > 0
          ? retryTurnId
          : null;
      if (disconnectedTurnId) {
        appendInterruptedResponse(
          disconnectedTurnId,
          streamedAssistantText,
          setTimeline,
        );
        setPendingAssistant(null);
      }
      updateRetryStatus(
        originalTurnId,
        disconnectedTurnId ? "retried" : "available",
        setTimeline,
      );
      setError(
        disconnectedTurnId
          ? "The retried response was interrupted. It remains separate and can be retried explicitly."
          : retryError instanceof Error
          ? retryError.message
          : "The response could not be retried.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="conversation" aria-label="Text conversation">
      <div className="messageList" aria-live="polite">
        {timeline.length === 0 && pendingAssistant === null ? (
          <p className="emptyConversation">No Text messages recorded yet.</p>
        ) : (
          timeline.map((item, index) =>
            item.kind === "message" ? (
              <article
                className={
                  item.message.actor === "user"
                    ? "userMessage"
                    : "assistantMessage"
                }
                id={isFirstItemForDate(timeline, index, item.message.logicalDate) ? `conversation-${item.message.logicalDate}` : undefined}
                key={item.message.eventId}
              >
                <span>
                  {item.message.actor === "user" ? "You" : "SayHear"}
                </span>
                <p>{item.message.text}</p>
              </article>
            ) : (
              <article
                className="assistantMessage interruptedMessage"
                key={`interrupted/${item.response.turnId}`}
              >
                <span>SayHear</span>
                <p>{item.response.text}</p>
                <em>Response interrupted</em>
                <button
                  className="retryResponse"
                  disabled={
                    submitting || item.response.retryStatus !== "available"
                  }
                  onClick={() =>
                    void retryInterrupted(item.response.turnId)
                  }
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
        {pendingAssistant ? (
          <article className="assistantMessage">
            <span>SayHear</span>
            <p>{pendingAssistant.text}</p>
          </article>
        ) : null}
      </div>
      <form className="composer" onSubmit={submit}>
        <label htmlFor="user-text">Tell SayHear what is on your mind</label>
        <textarea
          disabled={submitting}
          id="user-text"
          onChange={(event) => {
            pending.current = null;
            setText(event.target.value);
          }}
          placeholder="Write naturally…"
          rows={4}
          value={text}
        />
        <div className="composerActions">
          {error ? <p className="submissionError">{error}</p> : <span />}
          <button disabled={submitting || text.trim().length === 0} type="submit">
            {submitting
              ? "Recording…"
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
  setTimeline((current) => [
    ...current,
    {
      kind: "message",
      message: {
        actor: "assistant",
        eventId: `action-status:${String(receipt.actionExecutionId ?? crypto.randomUUID())}`,
        locale,
        revisionId: `action-status:${String(receipt.actionExecutionId ?? crypto.randomUUID())}`,
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
