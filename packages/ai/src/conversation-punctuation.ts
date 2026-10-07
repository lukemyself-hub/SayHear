/**
 * Versioned Conversation Output stream transform (`conversation-output:v2`).
 *
 * The deterministic AC-X04 hard gate rejects an ASCII comma (`U+002C`) that is
 * adjacent to a CJK Unified Ideograph (`U+4E00`–`U+9FFF`): the real synthetic
 * capture produced `我是 AI,不是人。这个我接不住,也不能` instead of the
 * fullwidth comma (`U+FF0C`). This module normalizes that stream without
 * touching anything else.
 *
 * It is a character-carry transform. An ASCII comma is held until exactly one
 * following character is known, because the decision depends on both neighbors
 * (`[CJK],` or `,[CJK]`). Only the pending comma is carried; every other
 * character is emitted as it arrives, so splitting the stream at any offset
 * produces the same output.
 *
 * Code spans (fenced or inline backticks) and URL tokens are emitted verbatim.
 * A protected span may still fail the strict hard gate; that gate is not
 * relaxed here and this transform does not attempt a general Markdown parse.
 */

const CJK_CHARACTER = /[\u4e00-\u9fff]/;
const WHITESPACE_CHARACTER = /\s/;
const URL_SCHEME_MARKER = "://";
const URL_PREFIX = /^(?:www\.|mailto:)/i;
const MAX_URL_PREFIX_LENGTH = 12;

export type ConversationPunctuationNormalizer = Readonly<{
  /** Returns the text that can be consumed once `chunk` has been processed. */
  push(chunk: string): string;
  /** Returns the held comma, if any, at the successful end of the stream. */
  flush(): string;
}>;

export function createConversationPunctuationNormalizer(): ConversationPunctuationNormalizer {
  let backtickRun = 0;
  let fenceDelimiterLength = 0;
  let lineIndent = 0;
  let backtickRunAtLineStart = false;
  let inlineDelimiterLength = 0;
  let lastCharacter = "";
  let beforePendingComma = "";
  let pendingComma = false;
  let wordIsUrl = false;
  let wordPrefix = "";
  let schemeTail = "";

  function protectedHere(): boolean {
    return fenceDelimiterLength > 0 || inlineDelimiterLength > 0 || wordIsUrl;
  }

  function resetWord(): void {
    wordIsUrl = false;
    wordPrefix = "";
    schemeTail = "";
  }

  function trackWord(character: string): void {
    if (wordIsUrl) return;
    wordPrefix = (wordPrefix + character).slice(0, MAX_URL_PREFIX_LENGTH);
    schemeTail = (schemeTail + character).slice(-URL_SCHEME_MARKER.length);
    if (
      schemeTail === URL_SCHEME_MARKER ||
      URL_PREFIX.test(wordPrefix)
    ) {
      wordIsUrl = true;
    }
  }

  function resolveBacktickRun(): void {
    if (backtickRun === 0) return;
    if (fenceDelimiterLength > 0) {
      if (backtickRunAtLineStart && backtickRun >= fenceDelimiterLength) fenceDelimiterLength = 0;
    } else if (inlineDelimiterLength > 0) {
      if (backtickRun === inlineDelimiterLength) inlineDelimiterLength = 0;
    } else if (backtickRunAtLineStart && backtickRun >= 3) {
      fenceDelimiterLength = backtickRun;
    } else {
      inlineDelimiterLength = backtickRun;
    }
    backtickRun = 0;
  }

  function trackLinePosition(character: string): void {
    if (character === "\n" || character === "\r") lineIndent = 0;
    else if (character === " " && lineIndent >= 0) lineIndent += 1;
    else lineIndent = -1;
  }

  function commaText(nextCharacter: string): string {
    if (protectedHere()) return ",";
    return CJK_CHARACTER.test(beforePendingComma) ||
      CJK_CHARACTER.test(nextCharacter)
      ? "，"
      : ",";
  }

  return {
    push(chunk) {
      let output = "";
      for (const character of chunk) {
        if (character === "`") {
          if (backtickRun === 0) backtickRunAtLineStart = lineIndent >= 0 && lineIndent <= 3;
          trackLinePosition(character);
          if (pendingComma) {
            output += commaText(character);
            pendingComma = false;
          }
          output += character;
          lastCharacter = character;
          backtickRun += 1;
          resetWord();
          continue;
        }
        if (backtickRun > 0) resolveBacktickRun();
        trackLinePosition(character);
        if (WHITESPACE_CHARACTER.test(character)) {
          resetWord();
        } else {
          trackWord(character);
        }
        if (pendingComma) {
          output += commaText(character);
          pendingComma = false;
        }
        if (character === ",") {
          if (protectedHere()) {
            output += character;
            lastCharacter = character;
          } else {
            pendingComma = true;
            beforePendingComma = lastCharacter;
            lastCharacter = character;
          }
          continue;
        }
        output += character;
        lastCharacter = character;
      }
      return output;
    },
    flush() {
      if (backtickRun > 0) resolveBacktickRun();
      if (!pendingComma) return "";
      pendingComma = false;
      return commaText("");
    },
  };
}

export function normalizeConversationPunctuation(text: string): string {
  const normalizer = createConversationPunctuationNormalizer();
  return normalizer.push(text) + normalizer.flush();
}
