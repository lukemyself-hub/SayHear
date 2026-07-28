"use client";

import { useRef, useState, type FormEvent } from "react";

type VisibleUserMessage = Readonly<{
  actor: "user" | "assistant";
  eventId: string;
  locale: string;
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
        retryStatus: "available" | "retried" | "retrying";
        text: string;
        turnId: string;
      };
    }>;

export function TextConversation(props: {
  initialMessages: readonly VisibleUserMessage[];
}) {
  const [timeline, setTimeline] = useState<readonly TimelineItem[]>(() =>
    props.initialMessages.map((message) => ({ kind: "message", message })),
  );
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<{
    text: string;
    turnId: string;
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

    try {
      const response = await fetch("/api/internal/conversation/responses", {
        body: JSON.stringify(submission),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`The message could not be recorded (${response.status}).`);
      }
      let streamedAssistantText = "";
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
              turnId: currentTurnId,
            });
          }
        } else if (result.type === "assistant_committed") {
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
      pending.current = null;
      setText("");
    } catch (submissionError) {
      if (userCommitted) {
        pending.current = null;
        setText("");
      }
      setError(
        submissionError instanceof Error
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
              turnId: retryTurnId,
            });
          }
        } else if (result.type === "assistant_committed") {
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
    } catch (retryError) {
      updateRetryStatus(
        originalTurnId,
        retryTurnId && streamedAssistantText.length > 0
          ? "retried"
          : "available",
        setTimeline,
      );
      setError(
        retryError instanceof Error
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
          timeline.map((item) =>
            item.kind === "message" ? (
              <article
                className={
                  item.message.actor === "user"
                    ? "userMessage"
                    : "assistantMessage"
                }
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
            response: { retryStatus: "available", text, turnId },
          },
        ],
  );
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

function nextVisibleSequence(timeline: readonly TimelineItem[]): number {
  return (
    timeline.reduce(
      (maximum, item) =>
        item.kind === "message"
          ? Math.max(maximum, item.message.sequence)
          : maximum,
      0,
    ) + 1
  );
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
