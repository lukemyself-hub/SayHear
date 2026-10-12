/**
 * Reads the "EARLIER MESSAGES" block a History Answer carries at the end of
 * its instructions (history-reading:v3) back into `role:text` lines, in the
 * order the entries are listed.
 *
 * System suites assert which sources reach the Provider, in which order and in
 * which role. Since v3 the quoted sources are entries of that block and no
 * longer conversation turns, so a suite reads `sentMessages`: the block's
 * entries followed by the conversation turns actually sent. The layout itself
 * (headings, times, remarks, the count) is asserted where it is defined, in
 * `packages/application/src/context-compiler.history.test.ts`.
 */

const BLOCK_START = "\nEARLIER MESSAGES (";
const ENTRY = /^\[(\d+)\] [^\n]*?, (they said|you replied)(?: \[[^\]\n]*\])?:$/;

export function earlierMessagesBlock(instructions: string): string | null {
  const start = instructions.lastIndexOf(BLOCK_START);
  return start === -1 ? null : instructions.slice(start + 1);
}

export function quotedEarlierMessages(instructions: string): string[] {
  const block = earlierMessagesBlock(instructions);
  if (block === null) return [];
  const quoted: { role: string; lines: string[] }[] = [];
  for (const line of block.split("\n")) {
    const entry = ENTRY.exec(line);
    if (entry) {
      if (Number(entry[1]) !== quoted.length + 1) {
        throw new Error(`Earlier-messages block is misnumbered at entry ${entry[1]}.`);
      }
      quoted.push({ lines: [], role: entry[2] === "they said" ? "user" : "assistant" });
    } else if (line.startsWith("> ")) {
      quoted.at(-1)?.lines.push(line.slice(2));
    } else if (line === ">") {
      quoted.at(-1)?.lines.push("");
    }
  }
  const total = /END OF EARLIER MESSAGES \((\d+) in total\)\.$/.exec(block);
  if (!total || Number(total[1]) !== quoted.length) {
    throw new Error("Earlier-messages block count does not match its entries.");
  }
  return quoted.map((entry) => `${entry.role}:${entry.lines.join("\n")}`);
}

/** Everything the model is given to read as messages: quoted entries, then the turns sent. */
export function sentMessages(request: {
  instructions: string;
  messages: readonly { role: string; text: string }[];
}): string[] {
  return [
    ...quotedEarlierMessages(request.instructions),
    ...request.messages.map((message) => `${message.role}:${message.text}`),
  ];
}
