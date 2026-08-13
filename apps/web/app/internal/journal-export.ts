import type { CurrentJournal } from "@sayhear/application";

export const MAX_JOURNAL_EXPORT_CHARACTERS = 20_000;

export function createBoundedJournalExport(
  journal: CurrentJournal,
): { content: string; fileName: string } | null {
  const content = `${journal.logicalDate}\n\n${journal.version.statements.map((statement) => statement.text).join("\n\n")}\n`;
  if (content.length > MAX_JOURNAL_EXPORT_CHARACTERS) return null;
  return {
    content,
    fileName: `sayhear-journal-${journal.logicalDate}.txt`,
  };
}
