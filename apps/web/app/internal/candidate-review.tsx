"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  candidateReviewOutcomeCopy,
  candidateReviewStageCopy,
} from "../../src/candidate-review-copy";
import {
  candidateDeadlineField,
  candidateLowFrequencyFields,
  candidateReviewAuthFailure,
  candidateReviewOutcomeTone,
  formatCandidateTimestamp,
  shortCandidateId,
} from "./candidate-review-presentation";

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

type EvidenceExcerpt = Readonly<{ revisionId: string; text: string }>;

type DraftValues = Readonly<{
  label: string;
  definition: string;
  rationale: string;
}>;

const EMPTY_DRAFT: DraftValues = { label: "", definition: "", rationale: "" };

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

const REASON_CODES: readonly string[] = [
  "insufficient_evidence",
  "entity_scope_unresolved",
  "sensitive_inference_violation",
  "value_schema_mismatch",
  "duplicate_concept",
  "concept_no_product_value",
];

export function CandidateReview() {
  const [views, setViews] = useState<PortalViews | null>(null);
  const [activeView, setActiveView] = useState<ViewKey>("needsReview");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [outcomeTone, setOutcomeTone] = useState<
    "success" | "failure" | null
  >(null);
  const [evidence, setEvidence] = useState<
    Readonly<Record<string, readonly EvidenceExcerpt[]>>
  >({});
  const [predicateInput, setPredicateInput] = useState<
    Readonly<Record<string, string>>
  >({});
  const [reasonInput, setReasonInput] = useState<
    Readonly<Record<string, string>>
  >({});
  const [draftInput, setDraftInput] = useState<
    Readonly<Record<string, DraftValues>>
  >({});
  const [proposalInput, setProposalInput] = useState<
    Readonly<Record<string, string>>
  >({});
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function draftFor(candidateId: string): {
    proposedPredicateIdentity: string;
    label: string;
    definition: string;
    valueSchemaDraft: { kind: string };
    syntheticExamples: { positive: string[]; negative: string[] };
    rationale: string;
    attestation: boolean;
  } {
    const draft = draftInput[candidateId] ?? EMPTY_DRAFT;
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

  const reportOutcome = useCallback((outcome: string) => {
    setNotice(candidateReviewOutcomeCopy(outcome));
    setOutcomeTone(candidateReviewOutcomeTone(outcome));
    if (candidateReviewAuthFailure(outcome)) {
      // A lost capability or a closed gate clears the protected display.
      setEvidence({});
    }
  }, []);

  const refresh = useCallback(async (options?: { clearNotice?: boolean }) => {
    const clearNotice = options?.clearNotice ?? true;
    setLoading(true);
    if (clearNotice) {
      setNotice(null);
      setOutcomeTone(null);
    }
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
        reportOutcome(payload.outcome ?? "unauthorized");
        setViews(null);
        setEvidence({});
        return;
      }
      setViews(payload.views);
    } catch {
      reportOutcome("unauthorized");
      setViews(null);
      setEvidence({});
    } finally {
      setLoading(false);
    }
  }, [reportOutcome]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function expandEvidence(candidateId: string) {
    setNotice(null);
    setOutcomeTone(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/internal/review/candidates/${encodeURIComponent(candidateId)}/evidence`,
        { cache: "no-store", method: "GET" },
      );
      const payload = (await response.json()) as {
        outcome?: string;
        message?: string;
        excerpts?: readonly EvidenceExcerpt[];
      };
      if (!response.ok || !payload.excerpts) {
        reportOutcome(payload.outcome ?? "unauthorized");
        return;
      }
      setEvidence((current) => ({
        ...current,
        [candidateId]: payload.excerpts ?? [],
      }));
      reportOutcome("applied");
    } catch {
      reportOutcome("unauthorized");
    } finally {
      setBusy(false);
    }
  }

  async function operateProposal(
    proposalId: string,
    action: "cancel" | "reconsider",
  ) {
    setNotice(null);
    setOutcomeTone(null);
    setBusy(true);
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
      reportOutcome(payload.outcome ?? "unauthorized");
      // Preserve the command result across the redraw; a failed refresh sets
      // its own auth/gate notice instead.
      await refresh({ clearNotice: false });
    } catch {
      reportOutcome("unauthorized");
    } finally {
      setBusy(false);
    }
  }

  async function operate(
    candidateId: string,
    action: "map" | "reject" | "approve",
  ) {
    setNotice(null);
    setOutcomeTone(null);
    setBusy(true);
    try {
      let response: Response;
      if (action === "map") {
        const predicateId = (predicateInput[candidateId] ?? "").trim();
        if (!predicateId) {
          reportOutcome("predicate_not_active");
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
      reportOutcome(payload.outcome ?? "unauthorized");
      // Preserve the command result across the redraw; a failed refresh sets
      // its own auth/gate notice instead.
      await refresh({ clearNotice: false });
    } catch {
      reportOutcome("unauthorized");
    } finally {
      setBusy(false);
    }
  }

  function moveTabFocus(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const currentIndex = VIEW_KEYS.indexOf(activeView);
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (currentIndex + 1) % VIEW_KEYS.length;
        break;
      case "ArrowLeft":
        nextIndex = (currentIndex - 1 + VIEW_KEYS.length) % VIEW_KEYS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = VIEW_KEYS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    setActiveView(VIEW_KEYS[nextIndex]!);
    tabRefs.current[nextIndex]?.focus();
  }

  const entries = views ? views[activeView] : [];

  return (
    <section aria-label="Candidate review queue" className="candidateReview">
      <div className="reviewToolbar">
        <div
          aria-label="Review lifecycle views"
          className="reviewTabs"
          onKeyDown={moveTabFocus}
          role="tablist"
        >
          {VIEW_KEYS.map((key, index) => {
            const selected = activeView === key;
            return (
              <button
                aria-controls={`review-panel-${key}`}
                aria-selected={selected}
                className="reviewTab"
                id={`review-tab-${key}`}
                key={key}
                onClick={() => setActiveView(key)}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                role="tab"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                <span className="reviewTabLabel">
                  {candidateReviewStageCopy(VIEW_STAGE[key])}
                </span>
                <span className="reviewTabCount">
                  {views ? views[key].length : 0}
                </span>
              </button>
            );
          })}
        </div>
        <button
          className="reviewRefresh"
          disabled={loading}
          onClick={() => void refresh()}
          type="button"
        >
          {loading ? "加载中…" : "刷新队列"}
        </button>
      </div>

      {notice ? (
        <p
          aria-live="polite"
          className={`reviewNotice is-${outcomeTone ?? "failure"}`}
          role="status"
        >
          {notice}
        </p>
      ) : null}

      {views ? (
        <p className="reviewSummary">
          共 {views.total} 项 · 快照 {views.fetchedAt} · 按 deadline
          压力稳定排序（最早到期在前，ID 打破平手）。
        </p>
      ) : (
        <p className="reviewSummary">队列尚未加载。</p>
      )}

      <div
        aria-labelledby={`review-tab-${activeView}`}
        aria-busy={busy}
        className="reviewPanel"
        id={`review-panel-${activeView}`}
        role="tabpanel"
        tabIndex={0}
      >
        {views && entries.length === 0 ? (
          <p className="reviewEmpty">该视图当前没有条目。</p>
        ) : null}
        <ul className="reviewList">
          {entries.map((entry) => (
            <CandidateCard
              busy={busy}
              draft={draftInput[entry.candidateId] ?? EMPTY_DRAFT}
              entry={entry}
              evidence={evidence[entry.candidateId]}
              key={entry.candidateId}
              onDraftChange={(next) =>
                setDraftInput((current) => ({
                  ...current,
                  [entry.candidateId]: next,
                }))
              }
              onEvidence={() => void expandEvidence(entry.candidateId)}
              onOperate={(action) => void operate(entry.candidateId, action)}
              onPredicateChange={(value) =>
                setPredicateInput((current) => ({
                  ...current,
                  [entry.candidateId]: value,
                }))
              }
              onProposalIdentityChange={(value) =>
                setProposalInput((current) => ({
                  ...current,
                  [entry.candidateId]: value,
                }))
              }
              onProposalOperate={(action) => {
                if (entry.linkedProposalId) {
                  void operateProposal(entry.linkedProposalId, action);
                }
              }}
              onReasonChange={(value) =>
                setReasonInput((current) => ({
                  ...current,
                  [entry.candidateId]: value,
                }))
              }
              predicate={predicateInput[entry.candidateId] ?? ""}
              proposalIdentity={proposalInput[entry.candidateId] ?? ""}
              reason={reasonInput[entry.candidateId] ?? "insufficient_evidence"}
            />
          ))}
        </ul>
      </div>
    </section>
  );
}

type CandidateCardProps = Readonly<{
  busy: boolean;
  draft: DraftValues;
  entry: PortalEntry;
  evidence: readonly EvidenceExcerpt[] | undefined;
  predicate: string;
  proposalIdentity: string;
  reason: string;
  onDraftChange(next: DraftValues): void;
  onEvidence(): void;
  onOperate(action: "approve" | "map" | "reject"): void;
  onPredicateChange(value: string): void;
  onProposalIdentityChange(value: string): void;
  onProposalOperate(action: "cancel" | "reconsider"): void;
  onReasonChange(value: string): void;
}>;

function CandidateCard({
  busy,
  draft,
  entry,
  evidence,
  predicate,
  proposalIdentity,
  reason,
  onDraftChange,
  onEvidence,
  onOperate,
  onPredicateChange,
  onProposalIdentityChange,
  onProposalOperate,
  onReasonChange,
}: CandidateCardProps) {
  const deadline = candidateDeadlineField(entry);
  const lowFrequency = candidateLowFrequencyFields({
    basis: entry.basis,
    candidateId: entry.candidateId,
    candidateKind: entry.candidateKind,
    decidedAt: entry.decidedAt,
    proposedObjectValue: entry.proposedObjectValue,
    proposedScopeKey: entry.proposedScopeKey,
  });

  return (
    <li className="reviewItem">
      <article
        aria-labelledby={`review-card-${entry.candidateId}`}
        className="reviewCard"
      >
        <header className="reviewCardHeader">
          <h2
            className="reviewCardTitle"
            id={`review-card-${entry.candidateId}`}
            title={entry.candidateId}
          >
            {shortCandidateId(entry.candidateId)}
          </h2>
          <span className="reviewCardStage">
            {candidateReviewStageCopy(entry.stage)}
          </span>
          <span className="reviewCardStatus">{entry.status}</span>
        </header>

        <p
          className={`reviewCardDeadline${
            deadline.overdue ? " isOverdue" : ""
          }`}
        >
          <span className="reviewCardDeadlineLabel">期限压力</span>
          <span>{deadline.label}</span>
          {deadline.overdue ? (
            <span className="reviewCardDeadlineFlag">
              已过期 · 命令将 fail closed
            </span>
          ) : null}
        </p>

        <dl className="inspectorFacts reviewFacts">
          <div className="inspectorFact">
            <dt>阶段</dt>
            <dd>{candidateReviewStageCopy(entry.stage)}</dd>
          </div>
          <div className="inspectorFact">
            <dt>状态</dt>
            <dd>{entry.status}</dd>
          </div>
          <div className="inspectorFact">
            <dt>disposition</dt>
            <dd>{entry.dispositionReasonCode ?? "—"}</dd>
          </div>
          <div className="inspectorFact">
            <dt>概念</dt>
            <dd>{entry.proposedConcept ?? entry.predicateId ?? "—"}</dd>
          </div>
          <div className="inspectorFact">
            <dt>review 到期</dt>
            <dd>{formatCandidateTimestamp(entry.reviewDueAt)}</dd>
          </div>
          <div className="inspectorFact">
            <dt>release 到期</dt>
            <dd>{formatCandidateTimestamp(entry.registryReleaseDueAt)}</dd>
          </div>
          <div className="inspectorFact">
            <dt>终态内容到期</dt>
            <dd>{formatCandidateTimestamp(entry.terminalContentExpiresAt)}</dd>
          </div>
        </dl>

        <div className="reviewActions">
          <div className="reviewField">
            <label htmlFor={`map-${entry.candidateId}`}>
              映射到 Predicate
            </label>
            <input
              disabled={busy}
              id={`map-${entry.candidateId}`}
              onChange={(event) => onPredicateChange(event.target.value)}
              placeholder="sh.domain.concept"
              value={predicate}
            />
            <button
              disabled={busy}
              onClick={() => onOperate("map")}
              type="button"
            >
              map_existing
            </button>
          </div>
          <div className="reviewField">
            <label htmlFor={`reject-${entry.candidateId}`}>拒绝理由</label>
            <select
              disabled={busy}
              id={`reject-${entry.candidateId}`}
              onChange={(event) => onReasonChange(event.target.value)}
              value={reason}
            >
              {REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {code === "concept_no_product_value"
                    ? `${code}（需治理草案）`
                    : code}
                </option>
              ))}
            </select>
            <button
              disabled={busy}
              onClick={() => onOperate("reject")}
              type="button"
            >
              reject
            </button>
          </div>
        </div>

        <details className="reviewDetails">
          <summary>来源与后继</summary>
          <dl className="reviewDetailFacts">
            <div className="inspectorFact">
              <dt>predecessor</dt>
              <dd>{entry.predecessorCandidateId ?? "—"}</dd>
            </div>
            <div className="inspectorFact">
              <dt>trigger</dt>
              <dd>
                {entry.successorTrigger ?? "—"}
                {entry.materialChangeReasonCodes
                  ? `（${entry.materialChangeReasonCodes.join(",")}）`
                  : ""}
              </dd>
            </div>
          </dl>
        </details>

        <details className="reviewDetails">
          <summary>Evidence（需 step-up）</summary>
          <div className="reviewEvidence">
            <button
              className="inspectorSmallButton"
              disabled={busy}
              onClick={onEvidence}
              type="button"
            >
              展开 Evidence（需 step-up）
            </button>
            {evidence ? (
              <ul aria-label="Evidence excerpts" className="reviewEvidenceList">
                {evidence.map((excerpt) => (
                  <li key={excerpt.revisionId}>
                    <code>{shortCandidateId(excerpt.revisionId)}</code>
                    <p>{excerpt.text}</p>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </details>

        <details className="reviewDetails">
          <summary>Proposal 与治理</summary>
          <div className="reviewProposal">
            <dl className="reviewDetailFacts">
              <div className="inspectorFact">
                <dt>关联 Proposal</dt>
                <dd>
                  {entry.linkedProposalId ?? "—"}
                  {entry.linkedProposalStatus
                    ? `（${entry.linkedProposalStatus}）`
                    : ""}
                  {entry.governanceBlocked ? " · 治理阻断中" : ""}
                </dd>
              </div>
            </dl>
            <fieldset className="reviewDraft">
              <legend>
                治理草案（approve / 产品价值拒绝 / reconsider 共用）
              </legend>
              <label htmlFor={`proposal-${entry.candidateId}`}>
                Predicate 身份
                <input
                  disabled={busy}
                  id={`proposal-${entry.candidateId}`}
                  onChange={(event) =>
                    onProposalIdentityChange(event.target.value)
                  }
                  placeholder="sh.domain.concept"
                  value={proposalIdentity}
                />
              </label>
              <label htmlFor={`label-${entry.candidateId}`}>
                通用标签（重写，勿复制模型概念）
                <input
                  disabled={busy}
                  id={`label-${entry.candidateId}`}
                  onChange={(event) =>
                    onDraftChange({ ...draft, label: event.target.value })
                  }
                  value={draft.label}
                />
              </label>
              <label htmlFor={`definition-${entry.candidateId}`}>
                定义
                <input
                  disabled={busy}
                  id={`definition-${entry.candidateId}`}
                  onChange={(event) =>
                    onDraftChange({ ...draft, definition: event.target.value })
                  }
                  value={draft.definition}
                />
              </label>
              <label htmlFor={`rationale-${entry.candidateId}`}>
                治理理由
                <input
                  disabled={busy}
                  id={`rationale-${entry.candidateId}`}
                  onChange={(event) =>
                    onDraftChange({ ...draft, rationale: event.target.value })
                  }
                  value={draft.rationale}
                />
              </label>
            </fieldset>
            <div className="reviewProposalActions">
              <button
                disabled={busy}
                onClick={() => onOperate("approve")}
                type="button"
              >
                approve_for_registry_change
              </button>
              {entry.linkedProposalId ? (
                <>
                  <button
                    disabled={busy}
                    onClick={() => onProposalOperate("cancel")}
                    type="button"
                  >
                    cancel Proposal
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => onProposalOperate("reconsider")}
                    type="button"
                  >
                    reconsider Proposal
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </details>

        <details className="reviewDetails">
          <summary>低频标识与原始 JSON</summary>
          <dl className="reviewDetailFacts">
            {lowFrequency.map((field) => (
              <div className="inspectorFact" key={field.label}>
                <dt>{field.label}</dt>
                <dd>
                  <code>{field.value}</code>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      </article>
    </li>
  );
}
