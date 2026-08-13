"use client";

import { useState } from "react";

import type { CurrentJournal } from "@sayhear/application";

import { createBoundedJournalExport } from "./journal-export";

export function JournalCard({ currentJournal }: { currentJournal: CurrentJournal | null }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  if (!currentJournal) {
    return <section className="journalCard" aria-label="Current Journal"><h2>Current Journal</h2><p className="emptyConversation">No validated Journal is available yet.</p></section>;
  }
  const journal = currentJournal;
  const text = journal.version.statements.map((statement) => statement.text).join("\n\n");
  const boundedExport = createBoundedJournalExport(journal);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }
  function exportJournal() {
    if (!boundedExport) return;
    const url = URL.createObjectURL(new Blob([boundedExport.content], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = boundedExport.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return <section className="journalCard" aria-label="Current Journal">
    <div className="journalHeading"><div><p className="eyebrow">Current Journal</p><h2>{journal.logicalDate}</h2></div><a href={`#conversation-${journal.logicalDate}`}>View that day’s Conversation</a></div>
    {journal.version.statements.map((statement) => <p className="journalStatement" key={statement.id}>{statement.text}</p>)}
    <div className="journalActions"><button onClick={() => void copy()} type="button">{copied ? "Copied" : "Copy"}</button><button disabled={!boundedExport} onClick={exportJournal} type="button">Export this Journal</button></div>
    {!boundedExport ? <p className="submissionError">This Journal is too large to export safely.</p> : null}
    {copyError ? <p className="submissionError">Copy is unavailable in this browser.</p> : null}
  </section>;
}
