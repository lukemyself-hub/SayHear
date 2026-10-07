"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * The chat module's date list. The first page is server-rendered and passed in
 * as `initial`; "load earlier dates" continues it through the read-only dates
 * endpoint with the opaque cursor the server returned. It never reads or
 * stores private content in browser storage.
 */

export type ChatNavEntry = Readonly<{
  dailySessionId: string;
  logicalDate: string;
}>;

export type ChatNav = Readonly<{
  current: Readonly<{ label: string }> | null;
  entries: readonly ChatNavEntry[];
  nextCursor: string | null;
}>;

export function ChatModuleList({
  activeDate,
  initial,
  onNavigate,
}: {
  activeDate: string | null;
  initial: ChatNav | null;
  onNavigate: () => void;
}) {
  const [entries, setEntries] = useState<readonly ChatNavEntry[]>(
    initial?.entries ?? [],
  );
  const [nextCursor, setNextCursor] = useState<string | null>(
    initial?.nextCursor ?? null,
  );
  const [state, setState] = useState<"error" | "idle" | "loading">("idle");

  async function loadEarlier(): Promise<void> {
    if (nextCursor === null || state === "loading") {
      return;
    }
    setState("loading");
    try {
      const url = new URL(
        "/api/internal/conversation/dates",
        window.location.origin,
      );
      url.searchParams.set("cursor", nextCursor);
      const response = await fetch(url, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`The earlier dates could not be loaded (${response.status}).`);
      }
      const payload = (await response.json()) as {
        entries?: unknown;
        nextCursor?: unknown;
      };
      const older = normalizeEntries(payload.entries);
      setEntries((current) => mergeEntries(current, older));
      setNextCursor(
        typeof payload.nextCursor === "string" ? payload.nextCursor : null,
      );
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="moduleList">
      <p className="moduleListHeading">聊天</p>
      <ul>
        <li>
          <Link
            aria-current={activeDate === null ? "page" : undefined}
            className="moduleListEntry"
            href="/internal"
            onClick={onNavigate}
          >
            {initial?.current?.label ?? "今天"}
          </Link>
        </li>
        {entries.map((entry) => (
          <li key={entry.dailySessionId}>
            <Link
              aria-current={activeDate === entry.logicalDate ? "page" : undefined}
              className="moduleListEntry"
              href={`/internal?date=${entry.logicalDate}`}
              onClick={onNavigate}
            >
              {formatLogicalDate(entry.logicalDate)}
            </Link>
          </li>
        ))}
      </ul>
      {nextCursor !== null ? (
        <button
          className="moduleListMore"
          disabled={state === "loading"}
          onClick={() => void loadEarlier()}
          type="button"
        >
          {state === "loading" ? "加载中…" : "加载更早日期"}
        </button>
      ) : null}
      {state === "error" ? (
        <p className="moduleListError">无法加载更早日期</p>
      ) : null}
    </div>
  );
}

function normalizeEntries(value: unknown): ChatNavEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: ChatNavEntry[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const record = candidate as { dailySessionId?: unknown; logicalDate?: unknown };
    if (
      typeof record.dailySessionId === "string" &&
      typeof record.logicalDate === "string"
    ) {
      entries.push({
        dailySessionId: record.dailySessionId,
        logicalDate: record.logicalDate,
      });
    }
  }
  return entries;
}

function mergeEntries(
  current: readonly ChatNavEntry[],
  older: readonly ChatNavEntry[],
): readonly ChatNavEntry[] {
  const seen = new Set(current.map((entry) => entry.dailySessionId));
  const merged = [...current];
  for (const entry of older) {
    if (!seen.has(entry.dailySessionId)) {
      seen.add(entry.dailySessionId);
      merged.push(entry);
    }
  }
  return merged;
}

/** Formats `YYYY-MM-DD` as `2026年10月6日`; unknown shapes pass through. */
function formatLogicalDate(logicalDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(logicalDate);
  if (!match) {
    return logicalDate;
  }
  return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
}
