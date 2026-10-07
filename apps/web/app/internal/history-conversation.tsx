"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { MessageSurface } from "./message-time";
import { interruptedHistoryGuidance } from "./portal-integration";

type HistoryMessage = Readonly<{
  actor: "user" | "assistant";
  createdAt?: string | undefined;
  eventId: string;
  generationCommandId: string | null;
  locale: string;
  revisionId: string;
  sequence: number;
  text: string;
}>;

type HistoryInterrupted = Readonly<{
  logicalDate: string;
  retryStatus: "available" | "retried" | "retrying";
  sequence: number;
  turnId: string;
}>;

type TimelineItem =
  | Readonly<{ kind: "message"; message: HistoryMessage }>
  | Readonly<{ kind: "interrupted"; response: HistoryInterrupted }>;

/**
 * In-memory reading positions per Daily Session. They only survive client-side
 * navigation inside one page session; private content is never written to
 * `localStorage` or `sessionStorage`.
 */
const historyReadingPositions = new Map<string, number>();

/**
 * Read-only history for one Daily Session. The initial batch is server-rendered
 * from the authoritative reads; older messages are loaded with the opaque
 * cursor and prepended without moving the reader's viewport.
 */
export function HistoryConversation(props: {
  dailySessionId: string;
  initialHasOlder: boolean;
  initialInterruptedResponses: readonly HistoryInterrupted[];
  initialMessages: readonly HistoryMessage[];
  returnHref: string;
  returnLabel: string;
  statusLine: string;
}) {
  const [messages, setMessages] = useState<readonly HistoryMessage[]>(
    props.initialMessages,
  );
  const [interrupted] = useState<readonly HistoryInterrupted[]>(
    props.initialInterruptedResponses,
  );
  const [beforeSequence, setBeforeSequence] = useState<number | null>(
    props.initialMessages[0]?.sequence ?? null,
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(props.initialHasOlder);
  const [state, setState] = useState<"error" | "idle" | "loading">("idle");
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = listRef.current;
    if (container === null) {
      return;
    }
    const stored = historyReadingPositions.get(props.dailySessionId);
    // Restore a previous reading position, or open the day at its latest
    // persisted message so the reader can page upwards.
    container.scrollTop =
      stored !== undefined ? stored : container.scrollHeight;
  }, [props.dailySessionId]);

  function rememberReadingPosition(): void {
    const container = listRef.current;
    if (container !== null) {
      historyReadingPositions.set(props.dailySessionId, container.scrollTop);
    }
  }

  async function loadOlder(): Promise<void> {
    if (!hasOlder || state === "loading") {
      return;
    }
    const container = listRef.current;
    const previousHeight = container?.scrollHeight ?? 0;
    const previousTop = container?.scrollTop ?? 0;
    setState("loading");
    try {
      const url = new URL(
        "/api/internal/conversation/messages",
        window.location.origin,
      );
      url.searchParams.set("dailySessionId", props.dailySessionId);
      if (nextCursor !== null) {
        url.searchParams.set("cursor", nextCursor);
      } else if (beforeSequence !== null) {
        url.searchParams.set("beforeSequence", String(beforeSequence));
      } else {
        setHasOlder(false);
        setState("idle");
        return;
      }
      const response = await fetch(url, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(
          `The earlier messages could not be loaded (${response.status}).`,
        );
      }
      const payload = (await response.json()) as {
        messages?: unknown;
        nextCursor?: unknown;
      };
      const older = normalizeMessages(payload.messages);
      setMessages((current) => mergeOlderMessages(current, older));
      setBeforeSequence(older[0]?.sequence ?? beforeSequence);
      const next = typeof payload.nextCursor === "string" ? payload.nextCursor : null;
      setNextCursor(next);
      setHasOlder(next !== null);
      setState("idle");
      requestAnimationFrame(() => {
        const node = listRef.current;
        if (node !== null) {
          node.scrollTop = node.scrollHeight - previousHeight + previousTop;
        }
      });
    } catch {
      setState("error");
    }
  }

  const timeline = buildTimeline(messages, interrupted);

  return (
    <section
      aria-label="历史聊天记录"
      className="conversation historyConversation"
    >
      <p className="conversationStatus">{props.statusLine}</p>
      <div
        className="messageList"
        onScroll={rememberReadingPosition}
        ref={listRef}
      >
        {hasOlder ? (
          <div className="historyLoadOlder">
            <button
              className="historyLoadOlderButton"
              disabled={state === "loading"}
              onClick={() => void loadOlder()}
              type="button"
            >
              {state === "loading" ? "加载中…" : "加载更早消息"}
            </button>
            {state === "error" ? (
              <p className="historyLoadError" role="status">
                无法加载更早消息，请重试。
              </p>
            ) : null}
          </div>
        ) : null}
        {timeline.length === 0 ? (
          <p className="emptyConversation">这一天没有可读取的聊天记录。</p>
        ) : (
          timeline.map((item) =>
            item.kind === "message" ? (
              <MessageSurface
                actor={item.message.actor}
                createdAt={item.message.createdAt}
                generationCommandId={item.message.generationCommandId}
                key={item.message.eventId}
              >
                <p>{item.message.text}</p>
              </MessageSurface>
            ) : (
              <article
                className="assistantMessage interruptedMessage"
                key={`interrupted/${item.response.turnId}`}
              >
                <p>Partial response text was not retained.</p>
                <em>
                  {item.response.retryStatus === "retried"
                    ? "已单独重试"
                    : item.response.retryStatus === "retrying"
                      ? "重试中"
                      : "Response interrupted"}
                </em>
                <InterruptedHistoryAction
                  logicalDate={item.response.logicalDate}
                />
              </article>
            ),
          )
        )}
      </div>
      <footer className="historyFooter">
        <Link className="historyReturn" href={props.returnHref}>
          {props.returnLabel}
        </Link>
      </footer>
    </section>
  );
}

/**
 * Explicit, non-automatic entry from a read-only interrupted item into the
 * current writable conversation. It states the source date and never retries on
 * mount: the existing Retry contract appends to the original turn's Daily
 * Session, so this page must not invoke it against a historical session.
 */
function InterruptedHistoryAction(props: { logicalDate: string }) {
  const guidance = interruptedHistoryGuidance(props.logicalDate);
  return (
    <div className="interruptedAction">
      <p className="interruptedSource">{guidance.message}</p>
      <Link className="interruptedProceed" href="/internal">
        {guidance.actionLabel}
      </Link>
    </div>
  );
}

function buildTimeline(
  messages: readonly HistoryMessage[],
  interrupted: readonly HistoryInterrupted[],
): readonly TimelineItem[] {
  return [
    ...messages.map(
      (message): TimelineItem => ({ kind: "message", message }),
    ),
    ...interrupted.map(
      (response): TimelineItem => ({ kind: "interrupted", response }),
    ),
  ].sort((left, right) => {
    const leftSequence =
      left.kind === "message"
        ? left.message.sequence
        : left.response.sequence + 0.5;
    const rightSequence =
      right.kind === "message"
        ? right.message.sequence
        : right.response.sequence + 0.5;
    return leftSequence - rightSequence;
  });
}

function normalizeMessages(value: unknown): HistoryMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const messages: HistoryMessage[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    if (
      (record.actor === "user" || record.actor === "assistant") &&
      typeof record.eventId === "string" &&
      typeof record.revisionId === "string" &&
      typeof record.sequence === "number" &&
      typeof record.text === "string"
    ) {
      messages.push({
        actor: record.actor,
        createdAt:
          typeof record.createdAt === "string" ? record.createdAt : undefined,
        eventId: record.eventId,
        generationCommandId:
          typeof record.generationCommandId === "string"
            ? record.generationCommandId
            : null,
        locale: typeof record.locale === "string" ? record.locale : "en-US",
        revisionId: record.revisionId,
        sequence: record.sequence,
        text: record.text,
      });
    }
  }
  return messages;
}

function mergeOlderMessages(
  current: readonly HistoryMessage[],
  older: readonly HistoryMessage[],
): readonly HistoryMessage[] {
  if (older.length === 0) {
    return current;
  }
  const seen = new Set(current.map((message) => message.eventId));
  const merged = older.filter((message) => !seen.has(message.eventId));
  return [...merged, ...current].sort((left, right) => left.sequence - right.sequence);
}
