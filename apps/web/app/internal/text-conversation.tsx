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

export function TextConversation(props: {
  initialMessages: readonly VisibleUserMessage[];
}) {
  const [messages, setMessages] = useState(props.initialMessages);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<{
    status: "streaming" | "interrupted";
    text: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef<PendingSubmission | null>(null);

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
          const committed = result as {
            message: VisibleUserMessage & { id: string };
          };
          const message = {
            actor: "user" as const,
            eventId: committed.message.id,
            locale: committed.message.locale,
            revisionId: committed.message.revisionId,
            sequence: committed.message.sequence,
            text: committed.message.text,
          };
          setMessages((current) =>
            current.some((item) => item.eventId === message.eventId)
              ? current
              : [...current, message],
          );
        } else if (result.type === "assistant_delta") {
          const delta =
            "delta" in result && typeof result.delta === "string"
              ? result.delta
              : "";
          streamedAssistantText += delta;
          setPendingAssistant({
            status: "streaming",
            text: streamedAssistantText,
          });
        } else if (result.type === "assistant_committed") {
          const committed = result as {
            eventId: string;
            revisionId: string;
          };
          setMessages((currentMessages) =>
            currentMessages.some(
              (message) => message.eventId === committed.eventId,
            )
              ? currentMessages
              : [
                  ...currentMessages,
                  {
                    actor: "assistant",
                    eventId: committed.eventId,
                    locale: submission.locale,
                    revisionId: committed.revisionId,
                    sequence: (currentMessages.at(-1)?.sequence ?? 0) + 1,
                    text: streamedAssistantText,
                  },
                ],
          );
          setPendingAssistant(null);
        } else if (result.type === "response_interrupted") {
          setPendingAssistant((current) =>
            current ? { ...current, status: "interrupted" } : null,
          );
          throw new Error("The response was interrupted. You can retry.");
        } else if (result.type === "response_failed") {
          throw new Error("SayHear could not complete the response.");
        }
      }
      pending.current = null;
      setText("");
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "The message could not be recorded.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="conversation" aria-label="Text conversation">
      <div className="messageList" aria-live="polite">
        {messages.length === 0 ? (
          <p className="emptyConversation">No Text messages recorded yet.</p>
        ) : (
          messages.map((message) => (
            <article
              className={
                message.actor === "user" ? "userMessage" : "assistantMessage"
              }
              key={message.eventId}
            >
              <span>{message.actor === "user" ? "You" : "SayHear"}</span>
              <p>{message.text}</p>
            </article>
          ))
        )}
        {pendingAssistant ? (
          <article className="assistantMessage">
            <span>SayHear</span>
            <p>{pendingAssistant.text}</p>
            {pendingAssistant.status === "interrupted" ? (
              <em>Response interrupted</em>
            ) : null}
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
            {submitting ? "Recording…" : error ? "Retry" : "Record message"}
          </button>
        </div>
      </form>
    </section>
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
