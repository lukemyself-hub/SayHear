import { describe, expect, it } from "vitest";

import { renderMessageTimeStamps } from "./message-presentation";

const user = (expressedAt: string | null, timezone: string | null = "Europe/London") => ({
  actor: "user" as const,
  expressedAt,
  timezone,
});

describe("when a conversation message was written, on the message itself", () => {
  it("gives the weekday, the date, how long ago and the local clock for the user's messages only", () => {
    expect(
      renderMessageTimeStamps({
        anchorTimezone: "Europe/London",
        messages: [
          user("2026-10-12T18:30:00.000Z"),
          { actor: "assistant", expressedAt: "2026-10-12T18:30:05.000Z", timezone: "Europe/London" },
          user("2026-10-15T08:05:00.000Z"),
          user("2026-10-16T15:00:00.000Z"),
        ],
        now: "2026-10-16T15:00:25.000Z",
      }),
    ).toEqual([
      "[written Monday 12 October 2026, 4 days ago, 19:30]",
      null,
      "[written Thursday 15 October 2026, yesterday, 09:05]",
      "[written Friday 16 October 2026, today, 16:00]",
    ]);
  });

  it("carries the GMT offset on a day the clocks changed, so the repeated hour stays in order", () => {
    expect(
      renderMessageTimeStamps({
        anchorTimezone: "Europe/London",
        messages: [
          user("2026-10-24T22:45:00.000Z"),
          user("2026-10-25T00:50:00.000Z"),
          user("2026-10-25T01:15:00.000Z"),
        ],
        now: "2026-10-26T12:00:00.000Z",
      }),
    ).toEqual([
      "[written Saturday 24 October 2026, 2 days ago, 23:45]",
      "[written Sunday 25 October 2026, yesterday, 01:50 GMT+1]",
      "[written Sunday 25 October 2026, yesterday, 01:15 GMT+0]",
    ]);
  });

  it("names a zone other than the request's, an assumed zone and a time that was not recorded", () => {
    expect(
      renderMessageTimeStamps({
        anchorTimezone: "Europe/London",
        messages: [
          user("2026-10-20T16:20:00.000Z", "Asia/Singapore"),
          { ...user("2026-10-21T09:00:00.000Z"), timezoneRecorded: false },
          user(null),
        ],
        now: "2026-10-21T10:00:00.000Z",
      }),
    ).toEqual([
      "[written Wednesday 21 October 2026, today, 00:20 (Asia/Singapore)]",
      "[written Wednesday 21 October 2026, today, 10:00 (time zone assumed)]",
      "[written at an unrecorded time]",
    ]);
  });

  it("says UTC when neither the message nor the request has a zone, and never fails on an unusable one", () => {
    expect(
      renderMessageTimeStamps({
        anchorTimezone: null,
        messages: [user("2026-10-21T09:00:00.000Z", null), user("2026-10-21T09:00:00.000Z", "Not/AZone")],
        now: null,
      }),
    ).toEqual([
      "[written Wednesday 21 October 2026, 09:00 UTC]",
      "[written at an unrecorded time]",
    ]);
  });
});
