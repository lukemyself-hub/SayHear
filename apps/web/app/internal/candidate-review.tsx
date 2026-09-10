"use client";

import { useCallback, useEffect, useState } from "react";

import {
  candidateReviewOutcomeCopy,
  candidateReviewStageCopy,
} from "../../src/candidate-review-copy";

type PortalEntry = Readonly<{
  candidateId: string;
  stage: string;
  status: string;
  candidateKind: string;
  basis: string;
  predicateId: string | null;
  proposedConcept: string | null;
  proposedObjectValue: unknown;
  proposedScopeKey: string;
  reviewDueAt: string | null;
  registryReleaseDueAt: string | null;
  terminalContentExpiresAt: string | null;
  deadlineRemainingMs: number | null;
  deadlineKind: string | null;
  predecessorCandidateId: string | null;
  successorTrigger: string | null;
  materialChangeReasonCodes: readonly string[] | null;
  dispositionReasonCode: string | null;
  decidedAt: string | null;
  linkedProposalId: string | null;
  linkedProposalStatus: string | null;
  governanceBlocked: boolean;
}>;

type PortalViews = Readonly<{
  needsReview: readonly PortalEntry[];
  awaitingRelease: readonly PortalEntry[];
  terminalGrace: readonly PortalEntry[];
  successor: readonly PortalEntry[];
  total: number;
  fetchedAt: string;
}>;

type ViewKey = "needsReview" | "awaitingRelease" | "terminalGrace" | "successor";

const VIEW_KEYS: readonly ViewKey[] = [
  "needsReview",
  "awaitingRelease",
  "terminalGrace",
  "successor",
];

const VIEW_STAGE: Readonly<Record<ViewKey, string>> = {
  needsReview: "needs_review",
  awaitingRelease: "awaiting_release",
  terminalGrace: "terminal_grace",
  successor: "successor",
};

function formatRemaining(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 0) return "已过期";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return `${days} 日 ${hours} 小时`;
}

function formatDate(iso: string | null): string {
  return iso ?? "—";
}

export function CandidateReview() {
  const [views, setViews] = useState<PortalViews | null>(null);
  const [activeView, setActiveView] = useState<ViewKey>("needsReview");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<
    Readonly<Record<string, readonly { revisionId: string; text: string }[]>>
  >({});
  const [predicateInput, setPredicateInput] = useState<
    Readonly<Record<string, string>>
  >({});
  const [reasonInput, setReasonInput] = useState<
    Readonly<Record<string, string>>
  >({});
  const [draftInput, setDraftInput] = useState<
    Readonly<
      Record<string, { label: string; definition: string; rationale: string }>
    >
  >({});
  const [proposalInput, setProposalInput] = useState<
    Readonly<Record<string, string>>
  >({});

  function draftFor(candidateId: string): {
    proposedPredicateIdentity: string;
    label: string;
    definition: string;
    valueSchemaDraft: { kind: string };
    syntheticExamples: { positive: string[]; negative: string[] };
    rationale: string;
    attestation: boolean;
  } {
    const draft = draftInput[candidateId] ?? {
      label: "",
      definition: "",
      rationale: "",
    };
    const predicateIdentity = (proposalInput[candidateId] ?? "").trim();
    return {
      proposedPredicateIdentity:
        predicateIdentity || "sh.review.candidate_concept",
      label: draft.label.trim() || "reviewer rewritten concept",
      definition:
        draft.definition.trim() || "Reviewer-authored generic definition.",
      valueSchemaDraft: { kind: "text" },
      syntheticExamples: { positive: ["synthetic positive"], negative: [] },
      rationale: draft.rationale.trim() || "Reviewer governance rationale.",
      attestation: true,
    };
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const response = await fetch("/api/internal/review/queue", {
        cache: "no-store",
        method: "GET",
      });
      const payload = (await response.json()) as {
        outcome?: string;
        message?: string;
        views?: PortalViews;
      };
      if (!response.ok || !payload.views) {
        // Fixed copy only; never render model or raw error text.
        setNotice(
          candidateReviewOutcomeCopy(payload.outcome ?? "unauthorized"),
        );
        setViews(null);
        return;
      }
      setViews(payload.views);
    } catch {
      setNotice(candidateReviewOutcomeCopy("unauthorized"));
      setViews(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function expandEvidence(candidateId: string) {
    setNotice(null);
    try {
      const response = await fetch(
        `/api/internal/review/candidates/${encodeURIComponent(candidateId)}/evidence`,
        { cache: "no-store", method: "GET" },
      );
      const payload = (await response.json()) as {
        outcome?: string;
        message?: string;
        excerpts?: readonly { revisionId: string; text: string }[];
      };
      if (!response.ok || !payload.excerpts) {
        setNotice(candidateReviewOutcomeCopy(payload.outcome ?? "unauthorized"));
        return;
      }
      setEvidence((current) => ({ ...current, [candidateId]: payload.excerpts ?? [] }));
      setNotice(candidateReviewOutcomeCopy("applied"));
    } catch {
      setNotice(candidateReviewOutcomeCopy("unauthorized"));
    }
  }

  async function operateProposal(
    proposalId: string,
    action: "cancel" | "reconsider",
  ) {
    setNotice(null);
    try {
      const response = await fetch(
        `/api/internal/review/proposals/${encodeURIComponent(proposalId)}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            action === "reconsider"
              ? { draft: draftFor(proposalId) }
              : {},
          ),
        },
      );
      const payload = (await response.json()) as { outcome?: string };
      setNotice(candidateReviewOutcomeCopy(payload.outcome ?? "unauthorized"));
      await refresh();
    } catch {
      setNotice(candidateReviewOutcomeCopy("unauthorized"));
    }
  }

  async function operate(
    candidateId: string,
    action: "map" | "reject" | "approve",
  ) {
    setNotice(null);
    try {
      let response: Response;
      if (action === "map") {
        const predicateId = (predicateInput[candidateId] ?? "").trim();
        if (!predicateId) {
          setNotice(candidateReviewOutcomeCopy("predicate_not_active"));
          return;
        }
        response = await fetch(
          `/api/internal/review/candidates/${encodeURIComponent(candidateId)}/map`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ predicateId }),
          },
        );
      } else if (action === "reject") {
        const reasonCode = reasonInput[candidateId] ?? "insufficient_evidence";
        const body =
          reasonCode === "concept_no_product_value"
            ? {
                reasonCode,
                proposal: { action: "create", draft: draftFor(candidateId) },
              }
            : { reasonCode };
        response = await fetch(
          `/api/internal/review/candidates/${encodeURIComponent(candidateId)}/reject`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
      } else {
        response = await fetch(
          `/api/internal/review/candidates/${encodeURIComponent(candidateId)}/approve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: { action: "create", draft: draftFor(candidateId) },
            }),
          },
        );
      }
      const payload = (await response.json()) as {
        outcome?: string;
        candidateAfter?: { status?: string } | null;
      };
      // Redraw strictly by (outcome, after-state); never claim success from
      // prompt text. Concurrency losers, disposed, expired and invalid inputs
      // surface their fixed codes.
      setNotice(candidateReviewOutcomeCopy(payload.outcome ?? "unauthorized"));
      await refresh();
    } catch {
      setNotice(candidateReviewOutcomeCopy("unauthorized"));
    }
  }

  const entries = views ? views[activeView] : [];

  return (
    <section aria-label="Candidate review queue">
      <div role="tablist" aria-label="Review lifecycle views">
        {VIEW_KEYS.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={activeView === key}
            onClick={() => setActiveView(key)}
            type="button"
          >
            {candidateReviewStageCopy(VIEW_STAGE[key])}（
            {views ? views[key].length : 0}）
          </button>
        ))}
        <button onClick={() => void refresh()} type="button" disabled={loading}>
          {loading ? "加载中…" : "刷新队列"}
        </button>
      </div>
      {notice ? (
        <p role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}
      {views ? (
        <p>
          共 {views.total} 项 · 快照 {views.fetchedAt} · 按 deadline
          压力稳定排序（最早到期在前，ID 打破平手）。
        </p>
      ) : (
        <p>队列尚未加载。</p>
      )}
      <ul>
        {entries.map((entry) => (
          <li key={entry.candidateId}>
            <article>
              <h2>{entry.candidateId.slice(0, 8)}…</h2>
              <dl>
                <div>
                  <dt>阶段</dt>
                  <dd>{candidateReviewStageCopy(entry.stage)}</dd>
                </div>
                <div>
                  <dt>状态</dt>
                  <dd>{entry.status}</dd>
                </div>
                <div>
                  <dt>30/90/7 日剩余</dt>
                  <dd>
                    {entry.deadlineKind ?? "—"} ·{" "}
                    {formatRemaining(entry.deadlineRemainingMs)}
                  </dd>
                </div>
                <div>
                  <dt>review 到期</dt>
                  <dd>{formatDate(entry.reviewDueAt)}</dd>
                </div>
                <div>
                  <dt>release 到期</dt>
                  <dd>{formatDate(entry.registryReleaseDueAt)}</dd>
                </div>
                <div>
                  <dt>终态内容到期</dt>
                  <dd>{formatDate(entry.terminalContentExpiresAt)}</dd>
                </div>
                <div>
                  <dt>predecessor</dt>
                  <dd>{entry.predecessorCandidateId ?? "—"}</dd>
                </div>
                <div>
                  <dt>disposition</dt>
                  <dd>{entry.dispositionReasonCode ?? "—"}</dd>
                </div>
                <div>
                  <dt>trigger</dt>
                  <dd>
                    {entry.successorTrigger ?? "—"}
                    {entry.materialChangeReasonCodes
                      ? `（${entry.materialChangeReasonCodes.join(",")}）`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>关联 Proposal</dt>
                  <dd>
                    {entry.linkedProposalId ?? "—"}
                    {entry.linkedProposalStatus
                      ? `（${entry.linkedProposalStatus}）`
                      : ""}
                    {entry.governanceBlocked ? " · 治理阻断中" : ""}
                  </dd>
                </div>
                <div>
                  <dt>概念</dt>
                  <dd>{entry.proposedConcept ?? entry.predicateId ?? "—"}</dd>
                </div>
              </dl>
              <div>
                <button
                  type="button"
                  onClick={() => void expandEvidence(entry.candidateId)}
                >
                  展开 Evidence（需 step-up）
                </button>
                {evidence[entry.candidateId] ? (
                  <ul aria-label="Evidence excerpts">
                    {evidence[entry.candidateId]!.map((excerpt) => (
                      <li key={excerpt.revisionId}>
                        <code>{excerpt.revisionId.slice(0, 8)}…</code>
                        <p>{excerpt.text}</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div>
                <label>
                  映射到 Predicate
                  <input
                    value={predicateInput[entry.candidateId] ?? ""}
                    onChange={(event) =>
                      setPredicateInput((current) => ({
                        ...current,
                        [entry.candidateId]: event.target.value,
                      }))
                    }
                    placeholder="sh.domain.concept"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void operate(entry.candidateId, "map")}
                >
                  map_existing
                </button>
              </div>
              <div>
                <label>
                  拒绝理由
                  <select
                    value={reasonInput[entry.candidateId] ?? "insufficient_evidence"}
                    onChange={(event) =>
                      setReasonInput((current) => ({
                        ...current,
                        [entry.candidateId]: event.target.value,
                      }))
                    }
                  >
                    <option value="insufficient_evidence">insufficient_evidence</option>
                    <option value="entity_scope_unresolved">
                      entity_scope_unresolved
                    </option>
                    <option value="sensitive_inference_violation">
                      sensitive_inference_violation
                    </option>
                    <option value="value_schema_mismatch">
                      value_schema_mismatch
                    </option>
                    <option value="duplicate_concept">duplicate_concept</option>
                    <option value="concept_no_product_value">
                      concept_no_product_value（需治理草案）
                    </option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => void operate(entry.candidateId, "reject")}
                >
                  reject
                </button>
              </div>
              <div>
                <fieldset>
                  <legend>治理草案（approve / 产品价值拒绝 / reconsider 共用）</legend>
                  <label>
                    Predicate 身份
                    <input
                      value={proposalInput[entry.candidateId] ?? ""}
                      onChange={(event) =>
                        setProposalInput((current) => ({
                          ...current,
                          [entry.candidateId]: event.target.value,
                        }))
                      }
                      placeholder="sh.domain.concept"
                    />
                  </label>
                  <label>
                    通用标签（重写，勿复制模型概念）
                    <input
                      value={draftInput[entry.candidateId]?.label ?? ""}
                      onChange={(event) =>
                        setDraftInput((current) => ({
                          ...current,
                          [entry.candidateId]: {
                            label: event.target.value,
                            definition:
                              current[entry.candidateId]?.definition ?? "",
                            rationale:
                              current[entry.candidateId]?.rationale ?? "",
                          },
                        }))
                      }
                    />
                  </label>
                  <label>
                    定义
                    <input
                      value={draftInput[entry.candidateId]?.definition ?? ""}
                      onChange={(event) =>
                        setDraftInput((current) => ({
                          ...current,
                          [entry.candidateId]: {
                            label: current[entry.candidateId]?.label ?? "",
                            definition: event.target.value,
                            rationale:
                              current[entry.candidateId]?.rationale ?? "",
                          },
                        }))
                      }
                    />
                  </label>
                  <label>
                    治理理由
                    <input
                      value={draftInput[entry.candidateId]?.rationale ?? ""}
                      onChange={(event) =>
                        setDraftInput((current) => ({
                          ...current,
                          [entry.candidateId]: {
                            label: current[entry.candidateId]?.label ?? "",
                            definition:
                              current[entry.candidateId]?.definition ?? "",
                            rationale: event.target.value,
                          },
                        }))
                      }
                    />
                  </label>
                </fieldset>
                <button
                  type="button"
                  onClick={() => void operate(entry.candidateId, "approve")}
                >
                  approve_for_registry_change
                </button>
              </div>
              {entry.linkedProposalId ? (
                <div>
                  <button
                    type="button"
                    onClick={() =>
                      void operateProposal(entry.linkedProposalId!, "cancel")
                    }
                  >
                    cancel Proposal
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void operateProposal(entry.linkedProposalId!, "reconsider")
                    }
                  >
                    reconsider Proposal
                  </button>
                </div>
              ) : null}
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
