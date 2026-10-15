"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  mergeJournalDateEntries,
  type JournalDateEntry,
} from "./journal-date-list-state";
import { formatShortLogicalDate } from "./portal-date-format";

const STATE_LABEL: Readonly<Record<JournalDateEntry["state"], string>> = {
  current: "已发布",
  outdated: "过期",
  updating: "更新中",
  generation_failed: "生成失败",
  no_journal: "交流内容较少，无日记",
};

const JOURNAL_DATE_STATES = [
  "current",
  "outdated",
  "updating",
  "no_journal",
  "generation_failed",
] as const;

type Payload = Readonly<{
  entries?: unknown;
  nextCursor?: unknown;
}>;

function readEntries(payload: Payload): JournalDateEntry[] {
  if (!Array.isArray(payload.entries)) return [];
  return payload.entries.filter(
    (entry): entry is JournalDateEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as JournalDateEntry).dailySessionId === "string" &&
      typeof (entry as JournalDateEntry).logicalDate === "string" &&
      JOURNAL_DATE_STATES.includes(
        (entry as JournalDateEntry).state,
      ),
  );
}

/**
 * Journal date list shown in the module's secondary navigation column. It reads
 * the owner-scoped BFF in fixed-size pages; the cursor is opaque and never
 * interpreted on the client. Days with no exchange are simply absent.
 */
export function JournalDateList({ onNavigate }: { onNavigate: () => void }) {
  const searchParams = useSearchParams();
  const selectedDate = searchParams?.get("date") ?? null;
  const [entries, setEntries] = useState<readonly JournalDateEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const referenceYear = new Date().getFullYear();

  const loadFirstPage = useCallback(async () => {
    setStatus("loading");
    try {
      const response = await fetch("/api/internal/journals", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("journal_dates_unavailable");
      const payload = (await response.json()) as Payload;
      setEntries(readEntries(payload));
      setNextCursor(
        typeof payload.nextCursor === "string" ? payload.nextCursor : null,
      );
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  async function loadEarlier(): Promise<void> {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(
        `/api/internal/journals?cursor=${encodeURIComponent(nextCursor)}`,
        { cache: "no-store", headers: { accept: "application/json" } },
      );
      if (!response.ok) throw new Error("journal_dates_unavailable");
      const payload = (await response.json()) as Payload;
      setEntries((current) =>
        mergeJournalDateEntries(current, readEntries(payload)),
      );
      setNextCursor(
        typeof payload.nextCursor === "string" ? payload.nextCursor : null,
      );
    } catch {
      setStatus("error");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="moduleList">
      <p className="moduleListHeading">日记</p>
      {status === "loading" ? (
        <p className="moduleListNote">正在读取日记日期…</p>
      ) : null}
      {status === "error" ? (
        <p className="moduleListNote">
          日记列表暂时无法读取。
          <button
            className="moduleListRetry"
            onClick={() => void loadFirstPage()}
            type="button"
          >
            重试
          </button>
        </p>
      ) : null}
      {status === "ready" && entries.length === 0 ? (
        <p className="moduleListNote">还没有可读的日记。</p>
      ) : null}
      <ul>
        {entries.map((entry, index) => {
          const isSelected = selectedDate
            ? selectedDate === entry.logicalDate
            : index === 0;
          return (
            <li key={entry.dailySessionId}>
              <Link
                aria-current={isSelected ? "page" : undefined}
                className={`moduleListEntry journalDateEntry${
                  entry.state === "no_journal" ? " is-no-journal" : ""
                }`}
                href={`/internal/journals?date=${entry.logicalDate}`}
                onClick={onNavigate}
              >
                <span className="journalDateLabel">
                  {formatShortLogicalDate(entry.logicalDate, referenceYear)}
                </span>
                {entry.state === "no_journal" ? (
                  <span className="journalDateNote">
                    {STATE_LABEL[entry.state]}
                  </span>
                ) : entry.state === "current" ? null : (
                  <>
                    <span
                      aria-hidden="true"
                      className={`journalStateDot journalStateDot-${entry.state}`}
                    />
                    <span className="journalDateState">
                      {STATE_LABEL[entry.state]}
                    </span>
                  </>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
      {nextCursor ? (
        <button
          aria-label="加载更早日期"
          className="moduleListMore"
          disabled={loadingMore}
          onClick={() => void loadEarlier()}
          type="button"
        >
          {loadingMore ? "正在加载…" : "更早记录"}
        </button>
      ) : null}
    </div>
  );
}
