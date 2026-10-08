"use client";

import {
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  MESSAGE_TIME_DRAG_THRESHOLD_PX,
  MESSAGE_TIME_LONG_PRESS_MS,
  formatMessageTimestamp,
  hasRenderableMessageTime,
  shouldToggleMessageTime,
  type MessageTimeTargetKind,
} from "./message-time-presentation";

type PointerStart = Readonly<{
  clientX: number;
  clientY: number;
  pointerType: string;
  startedAt: number;
}>;

/**
 * The persisted send/commit time of one message. The server-rendered HTML
 * carries an empty `<time>` so the secondary row is already reserved; the
 * display timezone is the reader's browser timezone and the instant is filled
 * in after mount, so server and client markup agree and refresh stays stable.
 * A missing or invalid instant renders nothing.
 */
export function MessageTimestamp(
  props: Readonly<{ createdAt: string | null | undefined }>,
) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!hasRenderableMessageTime(props.createdAt) || props.createdAt == null) {
      setText(null);
      return;
    }
    let timezone = "UTC";
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      timezone = "UTC";
    }
    setText(
      formatMessageTimestamp({
        createdAt: props.createdAt,
        now: new Date(),
        timezone,
      }),
    );
  }, [props.createdAt]);

  if (!hasRenderableMessageTime(props.createdAt) || props.createdAt == null) {
    return null;
  }
  return (
    <time className="messageTime" dateTime={props.createdAt}>
      {text ?? ""}
    </time>
  );
}

/**
 * One conversation message: the body stays free of overlays so links, text
 * selection, long-press copy and touch scrolling keep working. The secondary
 * meta row holds the reader's time (and, for an assistant reply, the
 * lightweight Context inspection icon immediately to its left). The time is
 * hidden until hover (desktop), keyboard focus, or an explicit tap (touch),
 * and revealing it never moves the message or the scroll position because the
 * row is always laid out.
 */
export function MessageSurface(props: {
  actor: "user" | "assistant";
  children: ReactNode;
  className?: string | undefined;
  createdAt: string | null | undefined;
  generationCommandId: string | null | undefined;
  id?: string | undefined;
}) {
  const [revealed, setRevealed] = useState(false);
  const pointerStart = useRef<PointerStart | null>(null);

  const hasTime = hasRenderableMessageTime(props.createdAt);
  const showsContextIcon =
    props.actor === "assistant" &&
    typeof props.generationCommandId === "string" &&
    props.generationCommandId.length > 0;
  const showsMeta = hasTime || showsContextIcon;
  const className = [
    props.actor === "user" ? "userMessage" : "assistantMessage",
    revealed ? "timeRevealed" : null,
    props.className ?? null,
  ]
    .filter((value): value is string => value !== null)
    .join(" ");

  function handlePointerDown(event: ReactPointerEvent<HTMLElement>): void {
    pointerStart.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: event.pointerType,
      startedAt: Date.now(),
    };
  }

  function handleClick(event: ReactMouseEvent<HTMLElement>): void {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!hasTime) {
      return;
    }
    const target = event.target;
    const element =
      target instanceof Element ? target : null;
    const targetKind: MessageTimeTargetKind = element?.closest("a,button")
      ? "interactive"
      : "other";
    let hasSelection = false;
    try {
      const selection = window.getSelection();
      hasSelection = selection !== null && !selection.isCollapsed;
    } catch {
      hasSelection = false;
    }
    let coarsePointer = false;
    try {
      coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    } catch {
      coarsePointer = false;
    }
    const durationMs = start ? Date.now() - start.startedAt : 0;
    const movedPx = start
      ? Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY)
      : 0;
    if (
      !shouldToggleMessageTime({
        coarsePointer,
        durationMs,
        hasSelection,
        hasTime,
        movedPx,
        pointerType: start?.pointerType ?? "mouse",
        targetKind,
      })
    ) {
      return;
    }
    setRevealed((current) => !current);
  }

  function handleFocus(event: ReactFocusEvent<HTMLElement>): void {
    if (!hasTime) {
      return;
    }
    let focusVisible = false;
    try {
      focusVisible = event.currentTarget.matches(":focus-visible");
    } catch {
      focusVisible = false;
    }
    if (focusVisible) {
      setRevealed(true);
    }
  }

  function handleBlur(): void {
    setRevealed(false);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    // Only the message itself, never a nested link/button, owns these keys.
    if (!hasTime || event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "Escape") {
      setRevealed(false);
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setRevealed((current) => !current);
    }
  }

  return (
    <article
      className={className}
      id={props.id}
      onBlur={handleBlur}
      onClick={handleClick}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      tabIndex={hasTime ? 0 : undefined}
    >
      {props.actor === "user" ? (
        <div className="messageBody">{props.children}</div>
      ) : (
        props.children
      )}
      {showsMeta ? (
        <div className="messageMeta">
          {showsContextIcon ? (
            <a
              aria-label="查看生成这段回复的 Context"
              className="contextInspectIcon"
              data-tooltip="查看生成这段回复的 Context"
              href={`/internal/context-inspector?generation_command_id=${encodeURIComponent(props.generationCommandId ?? "")}`}
            >
              <svg
                aria-hidden="true"
                fill="none"
                height="16"
                stroke="currentColor"
                strokeLinejoin="round"
                strokeWidth="1.3"
                viewBox="0 0 16 16"
                width="16"
              >
                <path d="M4.3 2.6h4.9l2.5 2.5v8.3H4.3z" />
                <path d="M9.2 2.6v2.5h2.5M6.4 8h3.2M6.4 10.4h3.2" />
              </svg>
            </a>
          ) : null}
          <MessageTimestamp createdAt={props.createdAt} />
        </div>
      ) : null}
    </article>
  );
}
