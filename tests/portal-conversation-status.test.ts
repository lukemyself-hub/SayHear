import { describe, expect, it } from "vitest";

import {
  conversationStatusLine,
  formatLogicalDate,
  isCurrentLocalDate,
} from "../apps/web/app/internal/portal-conversation";

describe("portal conversation status line", () => {
  it("formats a logical date without a timezone shift", () => {
    expect(formatLogicalDate("2026-10-06")).toBe("2026年10月6日");
    expect(formatLogicalDate("2026-01-09")).toBe("2026年1月9日");
  });

  it("falls back to the raw value when the logical date is malformed", () => {
    expect(formatLogicalDate("not-a-date")).toBe("not-a-date");
  });

  it("labels the owner's current local date as 今天", () => {
    expect(
      conversationStatusLine({
        logicalDate: "2026-10-06",
        now: new Date("2026-10-06T02:00:00.000Z"),
        timezone: "Asia/Shanghai",
      }),
    ).toBe("2026年10月6日 · 今天");
  });

  it("keeps the actual ownership date with 继续交流 across midnight", () => {
    // 2026-10-07T16:00Z is 2026-10-07 in Los Angeles, so a session that still
    // owns 2026-10-06 keeps its actual date and gets the 继续交流 note.
    expect(
      conversationStatusLine({
        logicalDate: "2026-10-06",
        now: new Date("2026-10-07T16:00:00.000Z"),
        timezone: "America/Los_Angeles",
      }),
    ).toBe("2026年10月6日 · 继续交流");
  });

  it("fails closed to the actual date for an invalid timezone", () => {
    expect(
      isCurrentLocalDate({
        logicalDate: "2026-10-06",
        now: new Date("2026-10-06T18:00:00.000Z"),
        timezone: "Not/AZone",
      }),
    ).toBe(false);
  });
});
