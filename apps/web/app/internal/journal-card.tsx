"use client";

import Link from "next/link";
import { useState } from "react";

import type {
  CurrentJournal,
  JournalGenerationNotice,
} from "@sayhear/application";

import { createBoundedJournalExport } from "./journal-export";
import {
  describeJournalFinding,
  describeJournalGenerationNotice,
} from "./journal-diagnostics";

const STATE_LABEL: Readonly<Record<CurrentJournal["state"], string>> = {
  current: "最新",
  outdated: "过期",
  updating: "更新中",
};

/**
 * Guards copy/export against a navigation that changed the selected date while
 * the previously loaded Journal is still on screen. A read-only history link
 * carries the date in `?date=`; without it the latest Journal is selected.
 */
function selectedDateMatches(logicalDate: string): boolean {
  if (typeof window === "undefined") return true;
  const requested = new URLSearchParams(window.location.search).get("date");
  return requested === null || requested === logicalDate;
}

/**
 * Date-driven Journal body. Copy and bounded export act strictly on the
 * currently loaded current published version; state and important notices are
 * never hidden behind a disclosure.
 */
export function JournalView({
  currentJournal,
  latestNotice,
}: {
  currentJournal: CurrentJournal | null;
  latestNotice: JournalGenerationNotice | null;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [staleGuard, setStaleGuard] = useState(false);

  if (!currentJournal) {
    return (
      <section aria-label="日记" className="journalView">
        <h1 className="journalViewTitle">日记</h1>
        {latestNotice ? (
          <p className="diagnosticNotice">
            {describeJournalGenerationNotice(latestNotice)}
          </p>
        ) : (
          <p className="emptyConversation">
            还没有可读的日记。交流结束后会自动生成，无需手动创建。
          </p>
        )}
      </section>
    );
  }

  const journal = currentJournal;
  const text = journal.version.statements
    .map((statement) => statement.text)
    .join("\n\n");
  const boundedExport = createBoundedJournalExport(journal);
  const rawFindings = journal.version.statements.flatMap((statement) =>
    (statement.diagnosticFindings ?? []).map((finding) => ({
      finding,
      statementText: statement.text,
    })),
  );

  async function copy(): Promise<void> {
    if (!selectedDateMatches(journal.logicalDate)) {
      setStaleGuard(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError(false);
      setStaleGuard(false);
    } catch {
      setCopyError(true);
    }
  }

  function exportJournal(): void {
    if (!boundedExport) return;
    if (!selectedDateMatches(journal.logicalDate)) {
      setStaleGuard(true);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([boundedExport.content], {
        type: "text/plain;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = boundedExport.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section aria-label="日记" className="journalView">
      <div className="journalHeading">
        <div>
          <p className="eyebrow">Journal</p>
          <h1 className="journalViewTitle">{journal.logicalDate}</h1>
        </div>
        <div className="journalHeadingMeta">
          <span
            className={`journalState journalState-${journal.state}`}
            data-state={journal.state}
          >
            {STATE_LABEL[journal.state]}
          </span>
          <Link
            className="journalChatLink"
            href={`/internal?date=${journal.logicalDate}`}
          >
            查看当天聊天
          </Link>
        </div>
      </div>
      {latestNotice ? (
        <p className="diagnosticNotice">
          {describeJournalGenerationNotice(latestNotice)}
        </p>
      ) : null}
      {journal.version.diagnosticStatus === "unavailable" ? (
        <p className="diagnosticNotice">
          这篇日记已发布，但语义诊断暂时不可用。
        </p>
      ) : null}
      {journal.state === "outdated" ? (
        <p className="note">
          这篇日记已经过期，会在当前交流结束后重新生成。
        </p>
      ) : null}
      {journal.state === "updating" ? (
        <p className="note">正在根据最新交流更新这篇日记。</p>
      ) : null}
      <div className="journalStatements">
        {journal.version.statements.map((statement) => (
          <div className="journalStatementBlock" key={statement.id}>
            <p className="journalStatement">{statement.text}</p>
            {statement.diagnosticFindings?.map((finding) => (
              <p
                className="journalFinding"
                key={`${finding.code}:${finding.detailCode}`}
              >
                {describeJournalFinding(finding)}
              </p>
            ))}
          </div>
        ))}
      </div>
      {rawFindings.length > 0 ? (
        <details className="journalRawDiagnostics">
          <summary>原始诊断信息</summary>
          <ul>
            {rawFindings.map(({ finding, statementText }, index) => (
              <li key={`${statementText}:${finding.code}:${finding.detailCode}:${index}`}>
                <span className="journalRawStatement">{statementText}</span>
                <code>{`${finding.code}:${finding.detailCode}`}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="journalActions">
        <button onClick={() => void copy()} type="button">
          {copied ? "已复制" : "复制"}
        </button>
        <button
          disabled={!boundedExport}
          onClick={exportJournal}
          type="button"
        >
          导出这篇日记
        </button>
      </div>
      {!boundedExport ? (
        <p className="submissionError">这篇日记过大，无法安全导出。</p>
      ) : null}
      {copyError ? (
        <p className="submissionError">当前浏览器无法使用复制功能。</p>
      ) : null}
      {staleGuard ? (
        <p className="submissionError">
          正在切换到其他日期，已阻止对旧版本的操作。请重新选择日期。
        </p>
      ) : null}
    </section>
  );
}
