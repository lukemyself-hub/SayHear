"use client";

import { useState, type ReactNode } from "react";

import type { ContextInspectorPayload } from "./context-inspector-data";
import {
  describeOriginalWordsDenial,
  historyPlanSummary,
  historyReadState,
  TURN_DISPOSITION_LABEL,
} from "./history-review-data";

type OriginalWordsState =
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "denied"; message: string }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "open";
      sources: readonly Readonly<{
        actor: string;
        expressedAt: string | null;
        revisionId: string;
        selectionOrder: number;
        text: string;
      }>[];
    }>;

function Fact(props: { children: ReactNode; label: string }) {
  return (
    <div className="inspectorFact">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

function readable(code: string): string {
  return code.replaceAll("_", " ");
}

/**
 * History review and Turn panel (#320). Read-only: it renders what the
 * controlled Inspector recorded. The original words are fetched only when the
 * person asks, through the existing content endpoint, which keeps its
 * capability and step-up rules; a refusal shows a fixed message that repeats
 * nothing about the query.
 */
export function HistoryReviewBody(props: { inspection: ContextInspectorPayload }) {
  const { historyRecall, turn } = props.inspection;
  const [words, setWords] = useState<OriginalWordsState>({ kind: "closed" });

  async function openWords() {
    setWords({ kind: "loading" });
    try {
      const response = await fetch(
        `/api/internal/inspection/conversation-content?generation_command_id=${encodeURIComponent(props.inspection.generationCommandId)}`,
        { cache: "no-store", method: "GET" },
      );
      if (response.status === 403) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setWords({ kind: "denied", message: describeOriginalWordsDenial(body?.error ?? null) });
        return;
      }
      if (!response.ok) {
        setWords({ kind: "denied", message: describeOriginalWordsDenial(null) });
        return;
      }
      const body = (await response.json()) as {
        historySources?: Array<{
          actor: string;
          expressedAt: string | null;
          revisionId: string;
          selectionOrder: number;
          text: string;
        }>;
      };
      setWords({
        kind: "open",
        sources: Array.isArray(body.historySources) ? body.historySources : [],
      });
    } catch {
      setWords({ kind: "denied", message: describeOriginalWordsDenial(null) });
    }
  }

  if (!historyRecall && !turn) {
    return (
      <p className="inspectorMuted">
        This command is an ordinary reply. It took no history branch
        {props.inspection.generationStage
          ? ` (stage ${props.inspection.generationStage})`
          : ""}
        .
      </p>
    );
  }
  const readState = historyReadState(historyRecall);
  const coverage = historyRecall?.coverage;
  return (
    <div className="contextRetrieval historyReview">
      {historyRecall ? (
        <>
          <dl className="inspectorFacts">
            <Fact label="This command">
              {historyRecall.role === "answer" ? "History Answer" : "Decision"}
            </Fact>
            <Fact label="Read">
              <span className="contextPosture" data-posture-state={readState}>
                {readState}
              </span>
              {historyRecall.failureCode ? (
                <>
                  {" "}
                  <code>{historyRecall.failureCode}</code>
                </>
              ) : null}
            </Fact>
            <Fact label="Policy">
              <code>{historyRecall.policyVersion}</code>
            </Fact>
            <Fact label="Plan">{historyPlanSummary(historyRecall.plan)}</Fact>
            <Fact label="Rows">
              {coverage?.enumeratedRows ?? 0} found · {coverage?.selectedRows ?? 0} kept ·{" "}
              {coverage?.selectedTokens ?? 0} tokens
              {coverage?.enumerationComplete === false ? " · not read to the end" : ""}
            </Fact>
            <Fact label="Read time">
              {coverage?.readLatencyMs == null ? "Not recorded" : `${coverage.readLatencyMs} ms`}
            </Fact>
          </dl>
          {coverage && Object.keys(coverage.omitted).length > 0 ? (
            <div className="inspectorTableWrap">
              <table className="inspectorTable">
                <caption>Why eligible rows were left out</caption>
                <thead>
                  <tr>
                    <th scope="col">Reason</th>
                    <th scope="col">Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(coverage.omitted).map(([reason, count]) => (
                    <tr key={reason}>
                      <td>{readable(reason)}</td>
                      <td>{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="inspectorTableWrap">
            <table className="inspectorTable">
              <caption>Sources kept for the answer (references only)</caption>
              <thead>
                <tr>
                  <th scope="col">Actor</th>
                  <th scope="col">Said</th>
                  <th scope="col">Group</th>
                  <th scope="col">Revision</th>
                </tr>
              </thead>
              <tbody>
                {historyRecall.sources.length === 0 ? (
                  <tr>
                    <td colSpan={4}>No source was kept for this answer.</td>
                  </tr>
                ) : (
                  historyRecall.sources.map((source) => (
                    <tr key={source.revisionId}>
                      <td>{source.actor}</td>
                      <td>{source.expressedAt}</td>
                      <td>
                        {source.group ?? "—"}
                        {source.role ? ` · ${source.role}` : ""}
                      </td>
                      <td>
                        <code className="inspectorId">{source.revisionId}</code>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="inspectorMuted">
          No history review is recorded for this Turn; the Decision answered
          directly.
        </p>
      )}

      {turn ? (
        <>
          <dl className="inspectorFacts">
            <Fact label="Final disposition">
              {TURN_DISPOSITION_LABEL[turn.finalDisposition] ?? turn.finalDisposition}
            </Fact>
            <Fact label="Turn status">{turn.turnStatus}</Fact>
          </dl>
          <div className="inspectorTableWrap">
            <table className="inspectorTable">
              <caption>Commands of this Turn and what the Provider did with them</caption>
              <thead>
                <tr>
                  <th scope="col">Stage</th>
                  <th scope="col">Command</th>
                  <th scope="col">Egress</th>
                  <th scope="col">Error</th>
                  <th scope="col">Provider request</th>
                </tr>
              </thead>
              <tbody>
                {turn.commands.map((command) => (
                  <tr key={command.generationCommandId}>
                    <th scope="row">{command.stage}</th>
                    <td>{command.commandStatus}</td>
                    <td>{command.egressDisposition ?? "—"}</td>
                    <td>{command.errorCategory ?? "—"}</td>
                    <td>
                      <code className="inspectorId">{command.providerRequestId ?? "none sent"}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <div className="historyWords">
        <h3>Original words</h3>
        <p className="inspectorMuted">
          Needs the content-reading capability and a recent step-up. Only
          sources that are still allowed are shown; a source removed by a
          Correction, Forget or Purge is not.
        </p>
        {words.kind === "closed" || words.kind === "denied" ? (
          <button className="inspectorSmallButton" onClick={() => void openWords()} type="button">
            Show original words
          </button>
        ) : null}
        {words.kind === "loading" ? (
          <p className="inspectorMuted" role="status">
            Checking access…
          </p>
        ) : null}
        {words.kind === "denied" ? (
          <p className="inspectorError" role="alert">
            {words.message}
          </p>
        ) : null}
        {words.kind === "open" ? (
          <>
            <button
              className="inspectorSmallButton"
              onClick={() => setWords({ kind: "closed" })}
              type="button"
            >
              Hide original words
            </button>
            <ol className="historyWordsList" aria-label="Original words behind this answer">
              {words.sources.length === 0 ? (
                <li>No allowed source remains for this answer.</li>
              ) : (
                words.sources.map((source) => (
                  <li key={source.revisionId}>
                    <span className="historyWordsMeta">
                      {source.actor} · {source.expressedAt ?? "time unknown"}
                    </span>
                    <span className="historyWordsText">{source.text}</span>
                  </li>
                ))
              )}
            </ol>
          </>
        ) : null}
      </div>
    </div>
  );
}
