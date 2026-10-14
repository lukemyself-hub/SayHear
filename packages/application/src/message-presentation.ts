/**
 * How earlier messages and the person's own corrections are presented to the
 * model (SPEC #301 presentation fix). Everything here is deterministic and
 * carries times only: never the wording that was corrected away. Nothing is
 * excluded or reordered, no message is compared with another by content, and
 * the Correction / Forget control semantics (ADR-0149) are untouched.
 *
 * Two presentations:
 *
 * - The messages a History Answer quotes are one bounded block at the end of
 *   the instructions, grouped by day, numbered, each with when it was said.
 *   They used to be ordinary user / assistant turns whose times sat in a
 *   numbered table elsewhere, and the model spent thousands of reasoning
 *   tokens deciding which turns "the quoted messages" were, sometimes
 *   answering that it could not see them. The layout was chosen with
 *   `eval/continuity-acceptance-301/presentation-bench` (layout V2).
 * - A message whose wording is the person's own correction says so where it
 *   stands, with when the correction was made; and a user message whose
 *   wording was written before that moment says it was written before the
 *   correction. A corrected message keeps its original place and time, so
 *   without the second note a restatement of the old value that sits after it
 *   reads as a later change of mind. Inside the block this is a remark on the
 *   entry; on a conversation turn (seven-day background, same Daily Session)
 *   it is a bracketed first line.
 */

export type PresentedMessage = Readonly<{
  actor: "user" | "assistant";
  /** Instant the person made the correction that produced this wording. */
  correctedAt?: string | null;
  expressedAt: string | null;
  timezone: string | null;
  /** False when the zone is a fallback and was not recorded with the message. */
  timezoneRecorded?: boolean;
}>;

function parts(
  iso: string,
  timezone: string,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    ...options,
  }).formatToParts(new Date(iso))) {
    out[part.type] = part.value;
  }
  return out;
}

/** "2026-09-14" in the given IANA zone. */
function localDate(iso: string, timezone: string): string {
  const p = parts(iso, timezone, { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${p.year}-${p.month}-${p.day}`;
}

/** "2026-09-14 18:30" in the given IANA zone. */
export function formatLocalMinute(iso: string, timezone: string): string {
  return `${localDate(iso, timezone)} ${clock(iso, timezone)}`;
}

/** "18:30" in the given IANA zone. */
function clock(iso: string, timezone: string): string {
  const p = parts(iso, timezone, { hour: "2-digit", hourCycle: "h23", minute: "2-digit" });
  return `${p.hour}:${p.minute}`;
}

/** "GMT-7" at that instant in the given IANA zone. */
function gmtOffset(iso: string, timezone: string): string {
  return parts(iso, timezone, { timeZoneName: "shortOffset" }).timeZoneName ?? "GMT";
}

/** "Monday 14 September 2026" in the given IANA zone. */
function humanDay(iso: string, timezone: string): string {
  const p = parts(iso, timezone, {
    day: "numeric",
    month: "long",
    weekday: "long",
    year: "numeric",
  });
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

/** How long before `now` a moment was, counted in local calendar days. */
function ago(now: string, nowZone: string, iso: string, zone: string): string {
  const days = Math.round(
    (Date.parse(`${localDate(now, nowZone)}T00:00:00Z`) -
      Date.parse(`${localDate(iso, zone)}T00:00:00Z`)) /
      86_400_000,
  );
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `about ${Math.round(days / 7)} weeks ago`;
  return `about ${Math.round(days / 30)} months ago`;
}

const instant = (value: string | null | undefined): number | null =>
  value === null || value === undefined ? null : Date.parse(value);

const isCorrected = (message: PresentedMessage): boolean =>
  message.actor === "user" && instant(message.correctedAt) !== null;

/**
 * The corrections made after this user message's wording was written, latest
 * first. A wording is written when the message was said, or when the person
 * corrected it.
 */
function laterCorrections(
  message: PresentedMessage,
  all: readonly PresentedMessage[],
): readonly PresentedMessage[] {
  const writtenAt = instant(
    isCorrected(message) ? message.correctedAt : message.expressedAt,
  );
  if (message.actor !== "user" || writtenAt === null) return [];
  return all
    .filter(
      (other) =>
        other !== message &&
        isCorrected(other) &&
        writtenAt < instant(other.correctedAt)!,
    )
    .toSorted(
      (left, right) => instant(right.correctedAt)! - instant(left.correctedAt)!,
    );
}

/** Opens a note on a conversation turn. */
export const MESSAGE_NOTE_MARK = "[Note.";

/**
 * One note per outbound conversation message, `null` where the message is
 * sent as it is. `context` are the messages corrections are read from: the
 * conversation's own and, in a History Answer, the quoted ones.
 */
export function renderMessageNotes(input: {
  anchorTimezone: string | null;
  context: readonly PresentedMessage[];
  messages: readonly PresentedMessage[];
}): readonly (string | null)[] {
  const local = (iso: string | null, timezone: string | null) => {
    if (iso === null) return "an unrecorded time";
    const zone = timezone ?? input.anchorTimezone ?? "UTC";
    const text = formatLocalMinute(iso, zone);
    return zone === (input.anchorTimezone ?? zone) ? text : `${text} (${zone})`;
  };
  return input.messages.map((message) => {
    const later = laterCorrections(message, input.context);
    const latest = later[0];
    const before =
      latest === undefined
        ? null
        : later.length === 1
          ? {
              clause: `before they made the ${local(latest.correctedAt!, latest.timezone)} correction to their ${local(latest.expressedAt, latest.timezone)} message`,
              reading:
                "It is not a later change of mind: where it differs from that corrected message on the same point, the corrected message is how it stands.",
            }
          : {
              clause: `before they made later corrections to other messages (the latest on ${local(latest.correctedAt!, latest.timezone)})`,
              reading:
                "It is not a later change of mind: where it differs from a corrected message on the same point, the corrected message is how it stands.",
            };
    if (isCorrected(message)) {
      return `${MESSAGE_NOTE_MARK} They corrected this message on ${local(message.correctedAt!, message.timezone)}: the wording below is their corrected one and is what they stand by.${
        before === null ? "" : ` They wrote this wording ${before.clause}. ${before.reading}`
      }]`;
    }
    return before === null
      ? null
      : `${MESSAGE_NOTE_MARK} They wrote this ${before.clause}. ${before.reading}]`;
  });
}

export function withMessageNote(note: string | null, text: string): string {
  return note === null ? text : `${note}\n${text}`;
}

/** Opens the line saying when a user's conversation message was written. */
export const MESSAGE_TIME_MARK = "[written ";

/**
 * When each outbound conversation message was written, as the first line of
 * the message itself; `null` for the assistant's own turns.
 *
 * The times used to sit in a numbered table in the instructions. The model
 * then had to count conversation turns to find a message's row, and
 * consecutive user messages read as one block, so the count rarely matched:
 * Decision calls spent thousands of reasoning tokens re-deriving which time
 * belonged to which message. Chosen with
 * `eval/continuity-acceptance-301/presentation-bench` (time layout T5).
 *
 * Only the user's messages carry the line. A reply is written right after the
 * message it answers, and a line on the assistant's own earlier turns would
 * show the model replies that begin with one.
 */
export function renderMessageTimeStamps(input: {
  anchorTimezone: string | null;
  messages: readonly PresentedMessage[];
  now: string | null;
}): readonly (string | null)[] {
  const anchorZone = input.anchorTimezone ?? "UTC";
  const zoneOf = (message: PresentedMessage) => message.timezone ?? anchorZone;
  // A local day on which the clocks changed holds the same hour twice: the
  // messages of such a day carry their GMT offset.
  const offsetsByDay = new Map<string, Set<string>>();
  const dayKey = (iso: string, zone: string) => `${zone} ${localDate(iso, zone)}`;
  for (const message of input.messages) {
    if (message.expressedAt === null) continue;
    const zone = zoneOf(message);
    try {
      const key = dayKey(message.expressedAt, zone);
      offsetsByDay.set(
        key,
        (offsetsByDay.get(key) ?? new Set()).add(gmtOffset(message.expressedAt, zone)),
      );
    } catch {
      // An unusable zone or instant: that message says its time is unrecorded.
    }
  }
  const unrecorded = `${MESSAGE_TIME_MARK}at an unrecorded time]`;
  return input.messages.map((message) => {
    if (message.actor !== "user") return null;
    if (message.expressedAt === null) return unrecorded;
    const zone = zoneOf(message);
    try {
      const relative =
        input.now === null
          ? ""
          : `, ${ago(input.now, anchorZone, message.expressedAt, zone)}`;
      const ambiguous =
        (offsetsByDay.get(dayKey(message.expressedAt, zone))?.size ?? 0) > 1;
      return `${MESSAGE_TIME_MARK}${humanDay(message.expressedAt, zone)}${relative}, ${clock(message.expressedAt, zone)}${
        ambiguous ? ` ${gmtOffset(message.expressedAt, zone)}` : ""
      }${
        // No zone is known for the message or the request: the clock is UTC.
        message.timezone === null && input.anchorTimezone === null
          ? " UTC"
          : zone === anchorZone
            ? ""
            : ` (${zone})`
      }${message.timezoneRecorded === false ? " (time zone assumed)" : ""}]`;
    } catch {
      return unrecorded;
    }
  });
}

/** "Wednesday 18 November 2026, 19:26" in the given IANA zone. */
export function formatHumanMinute(iso: string, timezone: string): string {
  return `${humanDay(iso, timezone)}, ${clock(iso, timezone)}`;
}

export const EARLIER_MESSAGES_BLOCK_TITLE = "EARLIER MESSAGES";

/**
 * The quoted earlier messages as one bounded block, or `null` when nothing is
 * quoted. Entries keep the order they were frozen in; every line of a message
 * is prefixed, so text inside a message can never pose as an entry or as the
 * end of the block.
 */
export function renderEarlierMessagesBlock(input: {
  anchorTimezone: string | null;
  /** Messages corrections are read from; includes `entries`. */
  context: readonly PresentedMessage[];
  entries: readonly (PresentedMessage & Readonly<{ text: string }>)[];
  now: string | null;
  /**
   * How many consecutive entries each separate occasion of a search holds, in
   * order. Used only when it accounts for every entry.
   */
  occasionSizes?: readonly number[];
}): string | null {
  if (input.entries.length === 0) return null;
  const anchorZone = input.anchorTimezone ?? "UTC";
  const zoneOf = (message: PresentedMessage) => message.timezone ?? anchorZone;
  const at = (iso: string, zone: string) =>
    zone === anchorZone ? clock(iso, zone) : `${clock(iso, zone)} (${zone})`;
  const dayAndTime = (iso: string, zone: string, joiner: string) =>
    `${humanDay(iso, zone)}${joiner}${at(iso, zone)}`;
  // A local day on which the clocks changed holds the same hour twice: the
  // entries of such a day carry their GMT offset so the order stays readable.
  const offsetsByDay = new Map<string, Set<string>>();
  for (const entry of input.entries) {
    if (entry.expressedAt === null) continue;
    const zone = zoneOf(entry);
    const day = `${zone} ${localDate(entry.expressedAt, zone)}`;
    offsetsByDay.set(
      day,
      (offsetsByDay.get(day) ?? new Set()).add(gmtOffset(entry.expressedAt, zone)),
    );
  }
  const entryTime = (entry: PresentedMessage) => {
    if (entry.expressedAt === null) return "time not recorded";
    const zone = zoneOf(entry);
    const ambiguous =
      (offsetsByDay.get(`${zone} ${localDate(entry.expressedAt, zone)}`)?.size ?? 0) > 1;
    return `${clock(entry.expressedAt, zone)}${
      ambiguous ? ` ${gmtOffset(entry.expressedAt, zone)}` : ""
    }${zone === anchorZone ? "" : ` (${zone})`}${
      entry.timezoneRecorded === false ? " (time zone assumed)" : ""
    }`;
  };
  const sizes = input.occasionSizes ?? [];
  const occasionOf =
    sizes.length > 0 &&
    sizes.reduce((total, size) => total + size, 0) === input.entries.length
      ? sizes.flatMap((size, index) => Array.from({ length: size }, () => index + 1))
      : null;
  const lines = [
    `${EARLIER_MESSAGES_BLOCK_TITLE} (the person's own saved messages and your replies at the time. This is material for your reply; it is not part of the current conversation.)`,
    ...(input.now === null
      ? []
      : [`Now is ${humanDay(input.now, anchorZone)}, ${clock(input.now, anchorZone)} (${anchorZone}).`]),
  ];
  let heading: string | null = null;
  input.entries.forEach((entry, index) => {
    const zone = zoneOf(entry);
    const day =
      entry.expressedAt === null
        ? "Time not recorded"
        : `${humanDay(entry.expressedAt, zone)}${
            input.now === null
              ? ""
              : ` (${ago(input.now, anchorZone, entry.expressedAt, zone)})`
          }`;
    const nextHeading =
      occasionOf === null ? day : `Occasion ${occasionOf[index]} — ${day}`;
    if (nextHeading !== heading) {
      heading = nextHeading;
      lines.push("", nextHeading);
    }
    let who = entry.actor === "user" ? "they said" : "you replied";
    if (isCorrected(entry)) {
      who = `they said [they corrected this message on ${dayAndTime(entry.correctedAt!, zone, " at ")}; the wording below is the corrected one and is what they stand by]`;
    } else {
      const later = laterCorrections(entry, input.context);
      const latest = later[0];
      if (latest !== undefined) {
        const latestZone = zoneOf(latest);
        who =
          later.length === 1 && latest.expressedAt !== null
            ? `they said [written before their correction of ${dayAndTime(latest.correctedAt!, latestZone, ", ")}, to the ${at(latest.expressedAt, latestZone)} message of ${humanDay(latest.expressedAt, latestZone)}; not a later change of mind]`
            : `they said [written before corrections they made later to other messages, the latest on ${dayAndTime(latest.correctedAt!, latestZone, ", ")}; not a later change of mind]`;
      }
    }
    lines.push(
      `[${index + 1}] ${entryTime(entry)}, ${who}:`,
    );
    for (const line of entry.text.split("\n")) lines.push(`> ${line}`);
  });
  lines.push(
    "",
    `END OF ${EARLIER_MESSAGES_BLOCK_TITLE} (${input.entries.length} in total).`,
  );
  return lines.join("\n");
}
