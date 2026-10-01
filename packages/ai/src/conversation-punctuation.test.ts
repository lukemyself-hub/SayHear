import { describe, expect, it } from "vitest";

import {
  createConversationPunctuationNormalizer,
  normalizeConversationPunctuation,
} from "./conversation-punctuation";

/** The real offending synthetic capture prose from the failed G1 run. */
const OFFENDING_PROSE = "我是 AI,不是人。这个我接不住,也不能";
const NORMALIZED_PROSE = "我是 AI，不是人。这个我接不住，也不能";

function normalizeAcrossSplits(text: string): string[] {
  const outputs: string[] = [];
  for (let split = 0; split <= text.length; split += 1) {
    const normalizer = createConversationPunctuationNormalizer();
    outputs.push(
      normalizer.push(text.slice(0, split)) +
        normalizer.push(text.slice(split)) +
        normalizer.flush(),
    );
  }
  const singleCharacter = createConversationPunctuationNormalizer();
  let singleCharacterOutput = "";
  for (const character of text) {
    singleCharacterOutput += singleCharacter.push(character);
  }
  singleCharacterOutput += singleCharacter.flush();
  outputs.push(singleCharacterOutput);
  return outputs;
}

describe("Conversation Punctuation normalizer", () => {
  it("rewrites an ASCII comma adjacent to CJK as a fullwidth comma", () => {
    expect(normalizeConversationPunctuation(OFFENDING_PROSE)).toBe(
      NORMALIZED_PROSE,
    );
    expect(normalizeConversationPunctuation("我,你")).toBe("我，你");
    expect(normalizeConversationPunctuation(",我")).toBe("，我");
    expect(normalizeConversationPunctuation("我,")).toBe("我，");
  });

  it("produces the same output for every partition of the offending prose", () => {
    for (const output of normalizeAcrossSplits(OFFENDING_PROSE)) {
      expect(output).toBe(NORMALIZED_PROSE);
    }
  });

  it("keeps English commas and numeric commas unchanged", () => {
    expect(normalizeConversationPunctuation("Hello, world.")).toBe(
      "Hello, world.",
    );
    expect(normalizeConversationPunctuation("1,000 people, 2,000 days")).toBe(
      "1,000 people, 2,000 days",
    );
    expect(normalizeConversationPunctuation(", ")).toBe(", ");
  });

  it("preserves a trailing comma and converts it when preceded by CJK", () => {
    expect(normalizeConversationPunctuation("我,不能")).toBe("我，不能");
    // The comma is held to the very end and still emitted (never dropped).
    expect(normalizeConversationPunctuation("我,")).toBe("我，");
    expect(normalizeConversationPunctuation("a,")).toBe("a,");
  });

  it("leaves code spans untouched even when split across chunks", () => {
    const inline = "前面 `我,你` 后面";
    expect(normalizeConversationPunctuation(inline)).toBe(inline);
    const fenced = "```\nconst value = \"我,你\";\n```";
    expect(normalizeConversationPunctuation(fenced)).toBe(fenced);
    for (const protectedText of [
      '````\n```\nconst value = "我,你";\n````',
      '```\nconst ticks = "```"; const value = "我,你";\n```',
      '前面 ````我,你```我,你```` 后面',
    ]) {
      for (const output of normalizeAcrossSplits(protectedText)) expect(output).toBe(protectedText);
    }
    for (const output of normalizeAcrossSplits(`${inline} ${fenced}`)) {
      expect(output).toBe(`${inline} ${fenced}`);
    }
  });

  it("leaves URL tokens untouched even when split across chunks", () => {
    const urlProse = "见 https://example.com/我,你 完";
    expect(normalizeConversationPunctuation(urlProse)).toBe(urlProse);
    for (const output of normalizeAcrossSplits(urlProse)) {
      expect(output).toBe(urlProse);
    }
    const longScheme = "见 custom-long-scheme://example.com/我,你 完";
    for (const output of normalizeAcrossSplits(longScheme)) {
      expect(output).toBe(longScheme);
    }
    const wwwProse = "见 www.example.com/我,你 完";
    expect(normalizeConversationPunctuation(wwwProse)).toBe(wwwProse);
  });

  it("resolves consecutive commas against their own neighbours", () => {
    expect(normalizeConversationPunctuation("我,,a")).toBe("我，,a");
    expect(normalizeConversationPunctuation("a,,我")).toBe("a,，我");
  });
});
