/**
 * Candidate presentations of the same History Answer content. Every layout
 * receives the same layout-independent fixture and returns a Chat Completions
 * body shaped like the product's OpenCode Go adapter sends it (system message
 * = instructions; assistant turns carry an empty `reasoning_content`).
 *
 * Only how the earlier messages and corrections are laid out differs. Persona,
 * task instruction, output format and locale pack are the product's own text,
 * taken verbatim from the recorded request.
 *
 * Layouts
 *   V0  the product's request at f179b3d, replayed as recorded (baseline)
 *   V1  quoted messages stay dialogue turns; each opens with an in-place mark
 *       (commit f734290 on this branch)
 *   V2  quoted messages leave the dialogue and become one bounded block at the
 *       end of the system instructions
 *   V3  tool-result shape: the Decision request repeated as the prefix, then
 *       the review call and a tool message carrying the block
 *   V4  the block as its own message right before the current question
 *   V5  (round 2) V2 without the numbered Times table: the instructions give
 *       only "now", every earlier conversation turn opens with its own time,
 *       and one line says how the conversation relates to the block
 *
 * Correction variants (where a fixture has a correction)
 *   a   the corrected message says so where it stands; user messages written
 *       before the correction say they were written before it
 *   b   entries are ordered by when their wording was written, so the
 *       corrected wording appears at the moment of the correction and says
 *       which earlier message it replaces
 *
 * Rules variants
 *   full   the reading rules as the product has them (history-reading:v3 text)
 *   lean   a shorter rule set (round 2 onwards)
 */

export const LAYOUTS = ["V0", "V1", "V2", "V3", "V4", "V5"];

const OLD_POINTER = "(each has its own time in the Times list)";

// ---------- time -----------------------------------------------------------

function parts(iso, timezone, options) {
  const out = {};
  for (const part of new Intl.DateTimeFormat("en-GB", { timeZone: timezone, ...options }).formatToParts(new Date(iso))) {
    out[part.type] = part.value;
  }
  return out;
}
const localDate = (iso, tz) => {
  const p = parts(iso, tz, { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${p.year}-${p.month}-${p.day}`;
};
const localMinute = (iso, tz) => {
  const p = parts(iso, tz, { day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "2-digit", year: "numeric" });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const clock = (iso, tz) => {
  const p = parts(iso, tz, { hour: "2-digit", hourCycle: "h23", minute: "2-digit" });
  return `${p.hour}:${p.minute}`;
};
const humanDay = (iso, tz) => {
  const p = parts(iso, tz, { day: "numeric", month: "long", weekday: "long", year: "numeric" });
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
};
function ago(nowIso, iso, tz) {
  const days = Math.round((Date.parse(`${localDate(nowIso, tz)}T00:00:00Z`) - Date.parse(`${localDate(iso, tz)}T00:00:00Z`)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `about ${Math.round(days / 7)} weeks ago`;
  return `about ${Math.round(days / 30)} months ago`;
}

// ---------- corrections -----------------------------------------------------

const writtenAt = (message) => Date.parse(message.correctedAt ?? message.saidAt);

/** For variant a: the latest correction made after this user message's wording was written. */
function laterCorrection(message, all) {
  if (message.role !== "user") return null;
  const later = all
    .filter((other) => other !== message && other.role === "user" && other.correctedAt && writtenAt(message) < Date.parse(other.correctedAt))
    .sort((left, right) => Date.parse(right.correctedAt) - Date.parse(left.correctedAt));
  return later[0] ?? null;
}

/** Variant b: the same messages ordered by when their current wording was written. */
function byWording(messages) {
  return messages
    .map((message, index) => ({ index, message }))
    .sort((left, right) => writtenAt(left.message) - writtenAt(right.message) || left.index - right.index)
    .map((entry) => entry.message);
}

// ---------- rules -----------------------------------------------------------

const RULES_COMMON_HEAD = [
  "- Time: each quoted message carries when it was said, not necessarily when the thing happened. Do not turn a message's time into an event date; if their words give no date, leave it undated.",
  "- Past and present: when they later said something different about the same matter and no correction of theirs covers it, the latest statement is how it is now and the earlier one is how it was then. Speak of the earlier one in the past tense and never as current.",
];
const RULES_COMMON_TAIL = [
  "- Plans: a plan they later called off did not happen: do not ask how it went. A plan with no later word is still only a plan: do not say how it turned out.",
  "- Their words only: assistant lines are your own earlier replies; they never prove what the person said, felt or meant. Add no reasons, no other people's motives, and no details they did not give, for example why someone left or why someone said something.",
  "- One moment is not a trait: a feeling or remark from one time describes that time. Do not present it as who they are, as a lasting pattern, or as a label such as a diagnosis, orientation, belief or trauma.",
  "- Relevance: use an earlier message only when it helps with what they are saying now. Do not bring up an unrelated earlier thing just because it was found, and do not mention history in every reply. If you connect an earlier statement to how they feel now, offer it as your own tentative reading, not as a fact about them.",
  "- Same you: keep your usual voice and limits. Receive what they said now first; give no advice or verdict unless they ask.",
];
const OWN_WORDS_CORRECTION =
  "Likewise, if they themselves later corrected a date, number or name in their own words, use the corrected one and do not offer the earlier one as a possibility. Their own correction is the only thing that settles it; a new remark that does not correct anything changes nothing else they said.";

function readingRules({ correction, where, rules }) {
  const turns = where === "turns";
  const correctionRule =
    correction === "b"
      ? `- Corrections: the earlier messages are listed in the order their wording was written. An entry that says it was written to correct an earlier message is what they stand by, and everything listed before it was written before it: those say how it was put earlier, never how it is now. ${OWN_WORDS_CORRECTION}`
      : turns
        ? `- Corrections: an earlier message whose first line says it is their corrected wording is what they stand by, and that line says when they corrected it. A message whose first line says it was said before that correction was written first, whatever its place in the order: it is how they put it earlier, not a later change of mind, and where the two differ on the same point the corrected wording is how it is now. ${OWN_WORDS_CORRECTION}`
        : `- Corrections: an entry marked as their corrected wording is what they stand by, and the mark says when they corrected it. An entry marked as written before that correction was written first, whatever its place in the list: it is how they put it earlier, not a later change of mind, and where the two differ on the same point the corrected wording is how it is now. ${OWN_WORDS_CORRECTION}`;
  const notes = turns
    ? "- Notes: the bracketed first line on an earlier message is a note for you about that message, not something anyone said. Never read it out, repeat it or quote it, and never mention that messages carry notes; say when something was said the way a person would."
    : "- Notes: the headings, numbers and bracketed remarks in the earlier-messages block are notes for you, not something anyone said. Never read them out or mention the block or its numbering; say when something was said the way a person would.";
  if (rules === "lean") {
    return [
      "How to read the earlier messages:",
      "- They are the person's own words at the time each was said; your earlier replies there prove nothing about what the person said or felt. Add no reasons, motives or details they did not give.",
      "- A message's time is when it was said, not when the thing happened. Where they later said something different, the later wording is how it is now and the earlier one is the past.",
      correctionRule.replace(` ${OWN_WORDS_CORRECTION}`, ""),
      "- A plan they called off did not happen; a plan with no later word is still only a plan.",
      notes,
    ].join("\n");
  }
  return [
    "History reading rules (history-reading:bench), the same on every reply that uses earlier messages:",
    ...RULES_COMMON_HEAD,
    correctionRule,
    ...RULES_COMMON_TAIL,
    notes,
  ].join("\n");
}

function receiptText(fx, pointer, options) {
  const rulesForReply = fx.receipt.rulesForReply.replace(
    `that appear in the conversation before the user's current message ${OLD_POINTER}`,
    pointer,
  );
  if (rulesForReply === fx.receipt.rulesForReply) throw new Error(`${fx.id}: the reply rule has no pointer to replace`);
  return [
    fx.receipt.header,
    ...fx.receipt.facts,
    rulesForReply,
    ...fx.receipt.guidance,
    readingRules(options),
  ].join("\n");
}

// ---------- the earlier-messages block ---------------------------------------

export const BLOCK_TITLE = "EARLIER MESSAGES";

function block(fx, correction) {
  const tz = fx.timezone;
  const entries = correction === "b" ? byWording(fx.quoted) : fx.quoted;
  const lines = [
    `${BLOCK_TITLE} (the person's own saved messages and your replies at the time. This is material for your reply; it is not part of the current conversation.)`,
    `Now is ${humanDay(fx.now, tz)}, ${clock(fx.now, tz)} (${tz}).`,
  ];
  let heading = null;
  entries.forEach((message, index) => {
    const shownAt = correction === "b" && message.correctedAt ? message.correctedAt : message.saidAt;
    const dayHeading = `${message.occasion ? `${message.occasion} — ` : ""}${humanDay(shownAt, tz)} (${ago(fx.now, shownAt, tz)})`;
    if (dayHeading !== heading) {
      heading = dayHeading;
      lines.push("", dayHeading);
    }
    let who = message.role === "user" ? "they said" : "you replied";
    if (message.role === "user" && message.correctedAt) {
      who =
        correction === "b"
          ? `they wrote this to correct what they had said on ${humanDay(message.saidAt, tz)} at ${clock(message.saidAt, tz)}; it replaces that message and is what they stand by`
          : `they said [they corrected this message on ${humanDay(message.correctedAt, tz)} at ${clock(message.correctedAt, tz)}; the wording below is the corrected one and is what they stand by]`;
    } else if (correction !== "b") {
      const later = laterCorrection(message, fx.quoted);
      if (later) {
        who = `they said [written before their correction of ${humanDay(later.correctedAt, tz)}, ${clock(later.correctedAt, tz)}, to the ${clock(later.saidAt, tz)} message of ${humanDay(later.saidAt, tz)}; not a later change of mind]`;
      }
    }
    lines.push(`[${index + 1}] ${clock(shownAt, tz)}, ${who}:`);
    for (const line of message.text.split("\n")) lines.push(`> ${line}`);
  });
  lines.push("", `END OF ${BLOCK_TITLE} (${entries.length} in total).`);
  return lines.join("\n");
}

// ---------- pieces of the product's instructions -----------------------------

/** The product's time section, with rows only for the given messages (renumbered). */
function timeSection(fx, messages) {
  const out = [];
  let rowsDone = false;
  for (const line of fx.timeLines) {
    if (/^\d+=/.test(line)) {
      if (!rowsDone) {
        rowsDone = true;
        messages.forEach((message, index) => out.push(`${index + 1}=${message.timeRaw};z=0;s=r`));
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

const chat = (system, messages, extra = {}) => ({
  messages: [
    { content: system, role: "system" },
    ...messages.map((message) =>
      message.role === "assistant"
        ? { content: message.text, reasoning_content: "", role: "assistant" }
        : { content: message.text, role: "user" },
    ),
    ...(extra.tail ?? []),
  ],
  model: "deepseek-v4.1-flash",
  stream: true,
  stream_options: { include_usage: true },
  ...(extra.top ?? {}),
});

const HISTORY_ANSWER_TASK_MARK = "Answer the user's question about what they said on earlier dates";

// ---------- layouts -----------------------------------------------------------

function v0(fx) {
  return { body: chat(fx.answer.instructions, fx.answer.messages) };
}

function v1(fx, { correction, rules }) {
  const tz = fx.timezone;
  const quoted = correction === "b" ? byWording(fx.quoted) : fx.quoted;
  const marked = quoted.map((message) => {
    const said = localMinute(message.saidAt, tz);
    let mark;
    if (message.role === "assistant") mark = `[Earlier message. You replied this on ${said}.]`;
    else if (message.correctedAt && correction === "b") {
      mark = `[Earlier message. They wrote this on ${localMinute(message.correctedAt, tz)} to correct what they had said on ${said}; it replaces that message and is what they stand by.]`;
    } else if (message.correctedAt) {
      mark = `[Earlier message. They said this on ${said}, then corrected it on ${localMinute(message.correctedAt, tz)}: the wording below is their corrected one and is what they stand by.]`;
    } else {
      const later = correction === "b" ? null : laterCorrection(message, fx.quoted);
      mark = later
        ? `[Earlier message. They said this on ${said}, before they made the ${localMinute(later.correctedAt, tz)} correction to their ${localMinute(later.saidAt, tz)} message. It is not a later change of mind: where it differs from that corrected message on the same point, the corrected message is how it stands.]`
        : `[Earlier message. They said this on ${said}.]`;
    }
    return {
      ...message,
      text: `${mark}\n${message.text}`,
      timeRaw: correction === "b" && message.correctedRaw ? message.correctedRaw : message.timeRaw,
    };
  });
  const messages = [...marked, ...fx.conversation, fx.question];
  const system = [
    fx.head,
    fx.dailySessionLine,
    timeSection(fx, messages),
    receiptText(
      fx,
      `that appear in the conversation before the user's current message (each of them begins with a bracketed first line starting "[Earlier message." that says when it was said)`,
      { correction, rules, where: "turns" },
    ),
  ].join("\n");
  return { body: chat(system, messages) };
}

function v2(fx, { correction, rules }) {
  const messages = [...fx.conversation, fx.question];
  const system = [
    fx.head,
    fx.dailySessionLine,
    timeSection(fx, messages),
    receiptText(
      fx,
      `in the block titled "${BLOCK_TITLE}" at the end of these instructions (each entry is numbered and says when it was said)`,
      { correction, rules, where: "block" },
    ),
    block(fx, correction),
  ].join("\n");
  return { body: chat(system, messages) };
}

function v3(fx, { correction, rules, tools }) {
  const taskLine = fx.head.split("\n").find((line) => line.startsWith(HISTORY_ANSWER_TASK_MARK));
  if (!taskLine) throw new Error(`${fx.id}: History Answer task instruction not found`);
  const result = [
    "Lookup finished. Write the reply to the user's current message now, as text only; do not call any function.",
    taskLine.replace(
      "the earlier messages quoted before their current message",
      `the earlier messages in the block titled "${BLOCK_TITLE}" below`,
    ),
    receiptText(
      fx,
      `in the block titled "${BLOCK_TITLE}" below (each entry is numbered and says when it was said)`,
      { correction, rules, where: "block" },
    ),
    block(fx, correction),
  ].join("\n");
  const callId = "call_history_review_1";
  const prefix = chat(fx.decision.instructions, fx.decision.messages, {
    top: { tool_choice: "auto", tools },
  });
  const body = {
    ...prefix,
    messages: [
      ...prefix.messages,
      {
        content: null,
        reasoning_content: "",
        role: "assistant",
        tool_calls: [
          {
            function: { arguments: fx.decision.toolCall.arguments, name: fx.decision.toolCall.name },
            id: callId,
            type: "function",
          },
        ],
      },
      { content: result, role: "tool", tool_call_id: callId },
    ],
    tool_choice: "none",
  };
  // The Decision request itself, cut to one token, so the Provider has the
  // shared prefix cached as it would after the product's own Decision call.
  return { body, warmup: { ...prefix, max_tokens: 1 } };
}

function v4(fx, { correction, rules }) {
  const material = {
    role: "user",
    text: `[Reference material prepared for you. The person did not write this message and cannot see it.]\n${block(fx, correction)}`,
    timeRaw: fx.question.timeRaw,
  };
  const messages = [...fx.conversation, material, fx.question];
  const system = [
    fx.head,
    fx.dailySessionLine,
    timeSection(fx, messages),
    receiptText(
      fx,
      `in the block titled "${BLOCK_TITLE}", which is the message right before the user's current message (each entry is numbered and says when it was said)`,
      { correction, rules, where: "block" },
    ),
  ].join("\n");
  return { body: chat(system, messages) };
}

/**
 * Round 2. Round 1's reasoning still stumbled where the numbered Times table
 * had to be matched against the conversation turns left outside the block
 * ("times 1-5 but I only see ..."), and where a turn from the period asked
 * about sat in the conversation while the rule said "only the block".
 */
function v5(fx, { correction, rules }) {
  const tz = fx.timezone;
  const when = (iso) => {
    const distance = ago(fx.now, iso, tz);
    return distance === "today" || distance === "yesterday"
      ? `${distance} at ${clock(iso, tz)}`
      : `on ${humanDay(iso, tz)} at ${clock(iso, tz)} (${distance})`;
  };
  const conversation = fx.conversation.map((message) => ({
    ...message,
    text: `[${message.role === "user" ? "They said this" : "You replied"} ${when(message.saidAt)}.]\n${message.text}`,
  }));
  const system = [
    fx.head,
    fx.dailySessionLine,
    `Now is ${humanDay(fx.now, tz)}, ${clock(fx.now, tz)} (${tz}).`,
    "Every earlier message says when it was said. That is not necessarily when the thing it describes happened: do not take an event's date from when it was mentioned, and resolve a relative day inside a message from that message's own time.",
    receiptText(
      fx,
      `in the block titled "${BLOCK_TITLE}" at the end of these instructions (each entry is numbered and says when it was said)`,
      { correction, rules, where: "block" },
    ),
    ...(conversation.length > 0
      ? [
          "The conversation after these instructions is the current talk, not what the lookup found: each of its earlier turns opens with a bracketed line saying when it was sent, which is a note for you and is never read out. Use it to understand what is being asked. What you report as said earlier comes from the block, and from a conversation turn only when its own bracketed line puts it in the period asked about.",
        ]
      : []),
    block(fx, correction),
  ].join("\n");
  return { body: chat(system, [...conversation, fx.question]) };
}

const BUILDERS = { V0: v0, V1: v1, V2: v2, V3: v3, V4: v4, V5: v5 };

/**
 * @param {string} layout one of LAYOUTS
 * @param {object} fx     a fixture from `fixtures/`
 * @param {{ correction?: "a" | "b", rules?: "full" | "lean", tools?: unknown[], sessionId: string }} options
 */
export function buildRequest(layout, fx, options) {
  const builder = BUILDERS[layout];
  if (!builder) throw new Error(`Unknown layout ${layout}`);
  const built = builder(fx, { correction: options.correction ?? "a", rules: options.rules ?? "full", tools: options.tools });
  // A fresh Daily Session id per repeat: the persona prefix stays shared with
  // every other request, as in the product, and nothing after it is served
  // from a previous repeat's cache.
  const swap = (body) => ({
    ...body,
    messages: body.messages.map((message, index) =>
      index === 0
        ? { ...message, content: message.content.replace(/daily_session=[0-9a-f-]{36}/, `daily_session=${options.sessionId}`) }
        : message,
    ),
  });
  return { body: swap(built.body), ...(built.warmup ? { warmup: swap(built.warmup) } : {}) };
}
