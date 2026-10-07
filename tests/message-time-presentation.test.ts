import { describe, expect, it } from "vitest";

import {
  MESSAGE_TIME_DRAG_THRESHOLD_PX,
  MESSAGE_TIME_LONG_PRESS_MS,
  eventMessageCreatedAt,
  formatMessageTimestamp,
  hasRenderableMessageTime,
  shouldToggleMessageTime,
} from "../apps/web/app/internal/message-time-presentation";

describe("formatMessageTimestamp", () => {
  it("renders the persisted instant in the reader's display timezone", () => {
    expect(
      formatMessageTimestamp({
        createdAt: "2026-10-06T16:30:00.000Z",
        now: new Date("2026-10-06T18:00:00.000Z"),
        timezone: "Asia/Shanghai",
      }),
    ).toBe("00:30");
    expect(
      formatMessageTimestamp({
        createdAt: "2026-10-06T16:30:00.000Z",
        now: new Date("2026-10-06T18:00:00.000Z"),
        timezone: "America/Los_Angeles",
      }),
    ).toBe("09:30");
  });

  it("prepends the actual date only when the message is read across midnight", () => {
    // 2026-10-06T16:30Z is 09:30 on 10-06 in Los Angeles; 2026-10-07T08:00Z is
    // 01:00 on 10-07, so the day is no longer the reader's current local day.
    expect(
      formatMessageTimestamp({
        createdAt: "2026-10-06T16:30:00.000Z",
        now: new Date("2026-10-07T08:00:00.000Z"),
        timezone: "America/Los_Angeles",
      }),
    ).toBe("10月6日 09:30");
    expect(
      formatMessageTimestamp({
        createdAt: "2026-10-06T16:30:00.000Z",
        now: new Date("2026-10-06T20:00:00.000Z"),
        timezone: "America/Los_Angeles",
      }),
    ).toBe("09:30");
  });

  it("includes the year when the message crosses a year boundary", () => {
    expect(
      formatMessageTimestamp({
        createdAt: "2025-12-31T20:00:00.000Z",
        now: new Date("2026-01-01T01:00:00.000Z"),
        timezone: "UTC",
      }),
    ).toBe("2025年12月31日 20:00");
  });

  it("renders nothing for a missing or invalid instant, never a fabricated time", () => {
    const now = new Date("2026-10-06T18:00:00.000Z");
    expect(formatMessageTimestamp({ createdAt: null, now, timezone: "UTC" })).toBeNull();
    expect(
      formatMessageTimestamp({ createdAt: undefined, now, timezone: "UTC" }),
    ).toBeNull();
    expect(formatMessageTimestamp({ createdAt: "", now, timezone: "UTC" })).toBeNull();
    expect(
      formatMessageTimestamp({ createdAt: "not-a-time", now, timezone: "UTC" }),
    ).toBeNull();
    expect(
      formatMessageTimestamp({
        createdAt: "2026-10-06T16:30:00.000Z",
        now,
        timezone: "Not/AZone",
      }),
    ).toBeNull();
  });
});

describe("hasRenderableMessageTime", () => {
  it("accepts only a parseable persisted instant", () => {
    expect(hasRenderableMessageTime("2026-10-06T16:30:00.000Z")).toBe(true);
    expect(hasRenderableMessageTime(null)).toBe(false);
    expect(hasRenderableMessageTime(undefined)).toBe(false);
    expect(hasRenderableMessageTime("")).toBe(false);
    expect(hasRenderableMessageTime("nope")).toBe(false);
  });
});

describe("eventMessageCreatedAt", () => {
  it("accepts only the parseable server commit instant carried by the event", () => {
    expect(eventMessageCreatedAt("2026-10-06T16:00:00.000Z")).toBe(
      "2026-10-06T16:00:00.000Z",
    );
  });

  it("uses no client-side fallback when the instant is absent or unparseable", () => {
    const before = Date.now();
    for (const absent of [undefined, null, "", "not-a-time", 42, {}]) {
      const result = eventMessageCreatedAt(absent);
      expect(result).toBeUndefined();
    }
    // A fabricated receive/render time would be a fresh `Date.now()`; nothing
    // in the accepted value range can be produced without a real instant.
    expect(eventMessageCreatedAt(undefined)).not.toBe(
      new Date(before).toISOString(),
    );
  });
});

describe("shouldToggleMessageTime", () => {
  const base = {
    coarsePointer: false,
    durationMs: 40,
    hasSelection: false,
    hasTime: true,
    movedPx: 2,
    pointerType: "mouse",
    targetKind: "other" as const,
  };

  it("toggles on a short touch tap on the message body", () => {
    expect(
      shouldToggleMessageTime({ ...base, coarsePointer: true, pointerType: "touch" }),
    ).toBe(true);
  });

  it("does not toggle on a hover-capable mouse", () => {
    expect(shouldToggleMessageTime(base)).toBe(false);
  });

  it("ignores links and buttons", () => {
    expect(
      shouldToggleMessageTime({
        ...base,
        coarsePointer: true,
        pointerType: "touch",
        targetKind: "interactive",
      }),
    ).toBe(false);
  });

  it("ignores an active text selection, long-press and drag", () => {
    const touch = { ...base, coarsePointer: true, pointerType: "touch" };
    expect(shouldToggleMessageTime({ ...touch, hasSelection: true })).toBe(false);
    expect(
      shouldToggleMessageTime({ ...touch, durationMs: MESSAGE_TIME_LONG_PRESS_MS }),
    ).toBe(false);
    expect(
      shouldToggleMessageTime({
        ...touch,
        movedPx: MESSAGE_TIME_DRAG_THRESHOLD_PX + 1,
      }),
    ).toBe(false);
  });

  it("never toggles without a real persisted time", () => {
    expect(
      shouldToggleMessageTime({
        ...base,
        coarsePointer: true,
        hasTime: false,
        pointerType: "touch",
      }),
    ).toBe(false);
  });
});
