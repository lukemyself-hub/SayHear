/**
 * In-place notes on outbound conversation messages (SPEC #301 presentation
 * fix). A note is one bracketed first line on the message it describes, so the
 * model never has to match a message against a table kept elsewhere in the
 * instructions.
 *
 * Two things are noted, both deterministically and without reading meaning:
 *
 * - A message quoted by a History Answer is marked as an earlier message with
 *   the local time it was said. Before this, quoted messages were ordinary
 *   user / assistant turns and the model spent thousands of reasoning tokens
 *   deciding which turns "the quoted messages" were.
 * - A message whose wording is the person's own correction says so, with when
 *   the correction was made; and a user message whose wording was written
 *   before that moment says it was written before the correction. A corrected
 *   message keeps its original place and time, so without the second note a
 *   restatement of the old value that sits after it reads as a later change of
 *   mind.
 *
 * Notes carry times only: never message text, never the wording that was
 * corrected away. Nothing is excluded or reordered (ADR-0149 control semantics
 * are unchanged), and no message is compared with another by content.
 */

export type PresentedMessage = Readonly<{
  actor: "user" | "assistant";
  /** Instant the person made the correction that produced this wording. */
  correctedAt?: string | null;
  expressedAt: string | null;
  timezone: string | null;
}>;

/** "2026-09-14 18:30" in the given IANA zone. */
export function formatLocalMinute(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

export const EARLIER_MESSAGE_MARK = "[Earlier message.";
/** Opens a note on a message that is not a History Answer quote. */
export const MESSAGE_NOTE_MARK = "[Note.";

/**
 * One note per outbound message, `null` where the message is sent as it is.
 * `messages` are in provider order; the first `quotedCount` are the earlier
 * messages a History Answer quotes.
 */
export function renderMessageNotes(input: {
  anchorTimezone: string | null;
  messages: readonly PresentedMessage[];
  quotedCount: number;
}): readonly (string | null)[] {
  const local = (instant: string | null, timezone: string | null) => {
    if (instant === null) return "an unrecorded time";
    const zone = timezone ?? input.anchorTimezone ?? "UTC";
    const text = formatLocalMinute(instant, zone);
    return zone === (input.anchorTimezone ?? zone) ? text : `${text} (${zone})`;
  };
  const instant = (value: string | null | undefined) =>
    value === null || value === undefined ? null : Date.parse(value);
  const corrected = input.messages.filter(
    (message) => message.actor === "user" && instant(message.correctedAt) !== null,
  );
  return input.messages.map((message, index) => {
    const quoted = index < input.quotedCount;
    const said = local(message.expressedAt, message.timezone);
    const ownCorrection =
      message.actor === "user" && instant(message.correctedAt) !== null
        ? local(message.correctedAt!, message.timezone)
        : null;
    // When this wording was written: the correction that produced it, else
    // the moment the message was said.
    const writtenAt = instant(message.correctedAt ?? message.expressedAt);
    const laterCorrections =
      message.actor !== "user" || writtenAt === null
        ? []
        : corrected
            .filter(
              (other) => other !== message && writtenAt < instant(other.correctedAt)!,
            )
            .toSorted(
              (left, right) =>
                instant(right.correctedAt)! - instant(left.correctedAt)!,
            );
    const latest = laterCorrections[0];
    const before =
      latest === undefined
        ? null
        : laterCorrections.length === 1
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
    const stands =
      "the wording below is their corrected one and is what they stand by";
    if (quoted) {
      if (message.actor === "assistant") {
        return `${EARLIER_MESSAGE_MARK} You replied this on ${said}.]`;
      }
      if (ownCorrection !== null) {
        return `${EARLIER_MESSAGE_MARK} They said this on ${said}, then corrected it on ${ownCorrection}: ${stands}.${
          before === null ? "" : ` They wrote this wording ${before.clause}. ${before.reading}`
        }]`;
      }
      return before === null
        ? `${EARLIER_MESSAGE_MARK} They said this on ${said}.]`
        : `${EARLIER_MESSAGE_MARK} They said this on ${said}, ${before.clause}. ${before.reading}]`;
    }
    if (ownCorrection !== null) {
      return `${MESSAGE_NOTE_MARK} They corrected this message on ${ownCorrection}: ${stands}.${
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
