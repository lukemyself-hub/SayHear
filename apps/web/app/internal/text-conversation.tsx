"use client";

import { useRef, useState, type FormEvent } from "react";

type VisibleUserMessage = Readonly<{
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
      const response = await fetch("/api/internal/conversation/turns", {
        body: JSON.stringify(submission),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`The message could not be recorded (${response.status}).`);
      }
      const result = (await response.json()) as {
        message: VisibleUserMessage & { id: string };
      };
      const message = {
        eventId: result.message.id,
        locale: result.message.locale,
        revisionId: result.message.revisionId,
        sequence: result.message.sequence,
        text: result.message.text,
      };
      setMessages((current) =>
        current.some((item) => item.eventId === message.eventId)
          ? current
          : [...current, message],
      );
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
            <article className="userMessage" key={message.eventId}>
              <span>You</span>
              <p>{message.text}</p>
            </article>
          ))
        )}
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
