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
import { formatLogicalDate } from "./portal-date-format";

const STATE_LABEL: Readonly<Record<CurrentJournal["state"], string>> = {
  current: "已发布",
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
 * Date-driven Journal body. The heading carries the Chinese logical date, the
 * publication state, and the copy/export actions; the reading column below
 * holds the Statements, the link back to that day's chat, and the collapsed
 * diagnostics. Notices and state notes are never hidden behind a disclosure.
 */
export function JournalView({
  currentJournal,
  generationNotice,
  logicalDate,
}: {
  currentJournal: CurrentJournal | null;
  generationNotice: JournalGenerationNotice | null;
  logicalDate: string | null;
}) {
  const [retryStatus, setRetryStatus] = useState<"idle" | "queued" | "error">("idle");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [staleGuard, setStaleGuard] = useState(false);

  if (!currentJournal) {
    return (
      <section aria-label="日记" className="journalView">
        <div className="journalHeading">
          <div className="journalHeadingTitle">
            <h1 className="journalViewTitle">
              {logicalDate ? formatLogicalDate(logicalDate) : "日记"}
            </h1>
          </div>
        </div>
        <div className="journalBody">
          <div className="journalNotices">
            {generationNotice ? (
              <p className="diagnosticNotice">
                {describeJournalGenerationNotice(generationNotice)}
              </p>
            ) : (
              <p className="emptyConversation">
                {logicalDate
                  ? "这一天的交流内容较少，没有可以发布的日记。"
                  : "还没有可读的日记。交流结束后会自动生成，无需手动创建。"}
              </p>
            )}
            {generationNotice?.failureCode === "retry_budget_exhausted" ? (
              <button type="button" disabled={retryStatus === "queued"} onClick={async () => {
                try {
                  const response = await fetch("/api/internal/journals/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ logicalDate: generationNotice.logicalDate }) });
                  setRetryStatus(response.ok ? "queued" : "error");
                } catch { setRetryStatus("error"); }
              }}>{retryStatus === "queued" ? "已安排重新生成" : "重新尝试"}</button>
            ) : null}
            {retryStatus === "error" ? <p role="alert">暂时无法重新尝试，请稍后再试。</p> : null}
          </div>
        </div>
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
  const notices: { tone: "diagnostic" | "note"; text: string }[] = [];
  if (generationNotice) {
    notices.push({
      tone: "diagnostic",
      text: describeJournalGenerationNotice(generationNotice),
    });
  }
  if (journal.version.diagnosticStatus === "unavailable") {
    notices.push({
      tone: "diagnostic",
      text: "这篇日记已发布，但语义诊断暂时不可用。",
    });
  }
  if (journal.state === "outdated") {
    notices.push({
      tone: "note",
      text: "这篇日记已经过期，会在当前交流结束后重新生成。",
    });
  }
  if (journal.state === "updating") {
    notices.push({
      tone: "note",
      text: "正在根据最新交流更新这篇日记。",
    });
  }

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
        <div className="journalHeadingTitle">
          <h1 className="journalViewTitle">
            {formatLogicalDate(journal.logicalDate)}
          </h1>
          <span
            className={`journalState journalState-${journal.state}`}
            data-state={journal.state}
          >
            {STATE_LABEL[journal.state]}
          </span>
        </div>
        <div className="journalActions">
          <button onClick={() => void copy()} type="button">
            <CopyIcon />
            {copied ? "已复制" : "复制"}
          </button>
          <button disabled={!boundedExport} onClick={exportJournal} type="button">
            <ExportIcon />
            导出
          </button>
        </div>
      </div>
      <div className="journalBody">
        {notices.length > 0 ? (
          <div className="journalNotices">
            {notices.map((notice) => (
              <p
                className={
                  notice.tone === "diagnostic" ? "diagnosticNotice" : "note"
                }
                key={notice.text}
              >
                {notice.text}
              </p>
            ))}
          </div>
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
        <Link
          className="journalChatLink"
          href={`/internal?date=${journal.logicalDate}`}
        >
          查看当天聊天
          <span aria-hidden="true">→</span>
        </Link>
        {rawFindings.length > 0 ? (
          <details className="journalRawDiagnostics">
            <summary>诊断详情</summary>
            <ul>
              {rawFindings.map(({ finding, statementText }, index) => (
                <li
                  key={`${statementText}:${finding.code}:${finding.detailCode}:${index}`}
                >
                  <span className="journalRawStatement">{statementText}</span>
                  <code>{`${finding.code}:${finding.detailCode}`}</code>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
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

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      width="16"
    >
      <path d="M5.6 3.1h5.8a1.5 1.5 0 0 1 1.5 1.5v5.8" />
      <path d="M3.1 5.6h5.8a1.5 1.5 0 0 1 1.5 1.5v5.8H4.6a1.5 1.5 0 0 1-1.5-1.5z" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
      width="16"
    >
      <path d="M8 2.6v7.2M5.2 7.2 8 10l2.8-2.8" />
      <path d="M3.1 11.1v1.3a1.5 1.5 0 0 0 1.5 1.5h6.8a1.5 1.5 0 0 0 1.5-1.5v-1.3" />
    </svg>
  );
}
