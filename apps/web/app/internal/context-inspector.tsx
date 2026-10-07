"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  DIALOGUE_STATE_FIELDS,
  humanizeDiagnosticCode,
  injectedMemoryItemCount,
  memorySectionItemsFromSections,
  retrievalRejectionSummary,
  retrievalSummary,
  safetyPostureLabel,
  sectionVersionLabel,
  type ContextInspectorContext,
  type ContextInspectorDialogueField,
  type ContextInspectorPayload,
  type ContextInspectorRetrievalSummary,
} from "./context-inspector-data";

const dialogueFieldLabels: Readonly<
  Record<(typeof DIALOGUE_STATE_FIELDS)[number], string>
> = {
  advice_explicitly_requested: "Advice explicitly requested",
  close_intent: "Close intent",
  current_request_requires_focus: "Request requires focus",
  current_topic: "Current topic",
  emotional_intensity: "Emotional intensity",
  user_willing_to_elaborate: "Willing to elaborate",
};

const CONTEXT_INSPECTOR_PATH = "/internal/context-inspector";

class InspectionRequestError extends Error {
  public constructor(public readonly status: number) {
    super(`inspection_request_failed_${status}`);
    this.name = "InspectionRequestError";
  }
}

function describeInspectionError(error: unknown): string {
  if (error instanceof InspectionRequestError) {
    switch (error.status) {
      case 400:
        return "The request was rejected. Enter a valid GenerationCommand UUID and try again.";
      case 401:
        return "Your session is not signed in for this Internal Owner. Sign in again, then retry.";
      case 403:
        return "This account is not permitted to read this inspection (403).";
      case 404:
        return "That GenerationCommand was not found for this Internal Owner.";
      case 503:
        return "Reads are paused while the Recovery Gate is closed (503). Try again once it reopens.";
      default:
        return `The inspection could not be loaded (${error.status}).`;
    }
  }
  return error instanceof Error
    ? error.message
    : "The inspection could not be loaded.";
}

export function ContextInspector(props: {
  initialGenerationCommandId: string;
}) {
  const [generationCommandId, setGenerationCommandId] = useState(
    props.initialGenerationCommandId,
  );
  const [inspection, setInspection] =
    useState<ContextInspectorPayload | null>(null);
  const [loading, setLoading] = useState(
    props.initialGenerationCommandId.trim().length > 0,
  );
  const [error, setError] = useState<string | null>(null);
  // The last id the component is showing (or tried to show). It keeps the
  // server-prop effect and the popstate listener from double-fetching the same
  // query while the URL stays the single source of truth.
  const requestedRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);

  const inspect = useCallback(
    async (requestedId: string, historyMode: "none" | "push" = "none") => {
      const normalizedId = requestedId.trim();
      if (!normalizedId) {
        requestedRef.current = "";
        requestSeqRef.current += 1;
        setLoading(false);
        setInspection(null);
        setError("Enter a GenerationCommand ID to inspect.");
        if (historyMode === "push" && typeof window !== "undefined") {
          window.history.pushState(null, "", CONTEXT_INSPECTOR_PATH);
        }
        return;
      }

      requestedRef.current = normalizedId;
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;
      setLoading(true);
      setError(null);
      setInspection(null);
      if (historyMode === "push" && typeof window !== "undefined") {
        window.history.pushState(
          null,
          "",
          `${CONTEXT_INSPECTOR_PATH}?generation_command_id=${encodeURIComponent(normalizedId)}`,
        );
      }

      try {
        const response = await fetch(
          `/api/internal/inspection/generation?generation_command_id=${encodeURIComponent(normalizedId)}`,
          { cache: "no-store", method: "GET" },
        );
        if (requestSeqRef.current !== requestSeq) return;
        if (!response.ok) {
          throw new InspectionRequestError(response.status);
        }
        setInspection((await response.json()) as ContextInspectorPayload);
      } catch (inspectionError) {
        if (requestSeqRef.current !== requestSeq) return;
        setInspection(null);
        setError(describeInspectionError(inspectionError));
      } finally {
        if (requestSeqRef.current === requestSeq) {
          setLoading(false);
        }
      }
    },
    [],
  );

  // The server-provided query param is authoritative on first render and after
  // a router navigation (for example browser back into this route).
  useEffect(() => {
    const id = props.initialGenerationCommandId;
    setGenerationCommandId(id);
    if (id) {
      if (requestedRef.current !== id) {
        void inspect(id);
      }
      return;
    }
    if (requestedRef.current) {
      requestedRef.current = null;
      requestSeqRef.current += 1;
      setInspection(null);
      setError(null);
      setLoading(false);
    }
  }, [props.initialGenerationCommandId, inspect]);

  // Native history entries created by the query form are not router
  // navigations, so back/forward is served from the URL directly.
  useEffect(() => {
    function onPopState() {
      const id =
        new URLSearchParams(window.location.search).get(
          "generation_command_id",
        ) ?? "";
      setGenerationCommandId(id);
      if (!id) {
        requestedRef.current = null;
        requestSeqRef.current += 1;
        setInspection(null);
        setError(null);
        setLoading(false);
        return;
      }
      if (requestedRef.current !== id) {
        void inspect(id);
      }
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [inspect]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void inspect(generationCommandId, "push");
  }

  const hasQuery =
    generationCommandId.trim().length > 0 ||
    props.initialGenerationCommandId.trim().length > 0;

  return (
    <div className="contextInspector">
      <div className="inspectorPage">
        <header className="contextInspectorHeader">
          <div>
            <p className="eyebrow">Internal tools</p>
            <h1>Context Inspector</h1>
            <p className="lede">
              Read-only evidence for one compiled Context. This page performs
              only a GET against the existing inspection endpoint; it cannot
              change a GenerationCommand or conversation data.
            </p>
          </div>
          <Link className="contextBackLink" href="/internal">
            ← 返回聊天
          </Link>
        </header>

        <form className="inspectorLookup" onSubmit={submit}>
          <label htmlFor="generation-command-id">GenerationCommand ID</label>
          <div className="inspectorLookupRow">
            <input
              autoComplete="off"
              id="generation-command-id"
              onChange={(event) => setGenerationCommandId(event.target.value)}
              placeholder="Paste a GenerationCommand UUID"
              spellCheck={false}
              value={generationCommandId}
            />
            <button disabled={loading} type="submit">
              {loading ? "Inspecting…" : "Inspect"}
            </button>
          </div>
        </form>

        {error ? (
          <p className="inspectorError" role="alert">
            {error}
          </p>
        ) : null}
        {loading ? (
          <p className="inspectorMuted" role="status">
            Inspecting the recorded Context…
          </p>
        ) : null}
        {!loading && !error && !inspection ? (
          <p className="inspectorEmpty">
            {hasQuery
              ? "No inspection is loaded for that ID. Check the UUID and inspect again."
              : "Enter a GenerationCommand ID, or open the Context icon on a reply, to load a compiled Context."}
          </p>
        ) : null}

        {inspection ? (
          <InspectionReport
            inspection={inspection}
            key={inspection.generationCommandId}
          />
        ) : null}
      </div>
    </div>
  );
}

function InspectionReport(props: { inspection: ContextInspectorPayload }) {
  const { compiledContext } = props.inspection;
  const retrieval = retrievalSummary(props.inspection);
  const injectedCount = injectedMemoryItemCount(compiledContext.sections);
  const exclusions = retrievalRejectionSummary(
    props.inspection.retrievalCandidates,
  );

  return (
    <div className="inspectorReport">
      <InspectionSummary
        injectedCount={injectedCount}
        inspection={props.inspection}
        retrieval={retrieval}
      />

      <Degradations
        inspection={props.inspection}
        retrieval={retrieval}
      />

      {exclusions.entries.length > 0 || exclusions.uncodedCount > 0 ? (
        <section
          aria-label="Candidate exclusions"
          className="inspectorCard contextExclusions"
        >
          <h2>Why candidates were not injected</h2>
          <ul className="contextExclusionList">
            {exclusions.entries.map((entry) => (
              <li key={entry.code}>
                <span>{humanizeDiagnosticCode(entry.code)}</span>
                <span className="contextExclusionCount">
                  ×{entry.count}
                </span>
                <code>{entry.code}</code>
              </li>
            ))}
            {exclusions.uncodedCount > 0 ? (
              <li>
                <span>
                  Excluded without a recorded reason code (shown in full detail
                  below).
                </span>
                <span className="contextExclusionCount">
                  ×{exclusions.uncodedCount}
                </span>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <ContextDisclosure
        status={`${compiledContext.totalTokens.toLocaleString()} selected tokens`}
        subtitle={`Compiler ${compiledContext.compilerVersion}, locale ${compiledContext.locale}`}
        title="Compiled Context"
      >
        <CompiledContextBody inspection={props.inspection} />
      </ContextDisclosure>

      <ContextDisclosure
        subtitle="The exact pinned versions this Context compiled against."
        title="Pinned policy versions"
      >
        <div className="inspectorVersionGrid">
          {policyVersionRows(compiledContext.policyVersions).map(
            ([label, version]) => (
              <InspectorFact key={label} label={label}>
                <code>{version}</code>
              </InspectorFact>
            ),
          )}
        </div>
      </ContextDisclosure>

      <ContextDisclosure
        subtitle="Non-authoritative v2 projection used, if present, by this Context."
        title="DialogueState evidence"
        status={
          compiledContext.dialogueState
            ? compiledContext.dialogueState.status
            : "Not included"
        }
      >
        <DialogueStateBody inspection={props.inspection} />
      </ContextDisclosure>

      <ContextDisclosure
        status={safetyPostureLabel(compiledContext.safetyPosture.state)}
        subtitle="Deterministic Daily-Session status and turn evidence."
        title="Safety Posture"
      >
        <SafetyPostureBody inspection={props.inspection} />
      </ContextDisclosure>

      <ContextDisclosure
        status={
          retrieval.state === "none"
            ? "No retrieval run"
            : retrieval.state === "degraded"
              ? "Degraded"
              : "Completed"
        }
        subtitle="The injected memory items and the full retrieval run of this turn. Read-only: it renders the recorded CompiledContext and run ledger; it never recomputes or changes a selection."
        title="Memory retrieval"
      >
        <RetrievalBody inspection={props.inspection} />
      </ContextDisclosure>

      <ContextDisclosure
        subtitle="The exact JSON returned by the read-only inspection endpoint, including ids, versions and timing metadata."
        title="Raw inspection JSON"
      >
        <RawJson inspection={props.inspection} />
      </ContextDisclosure>
    </div>
  );
}

function InspectionSummary(props: {
  injectedCount: number;
  inspection: ContextInspectorPayload;
  retrieval: ContextInspectorRetrievalSummary;
}) {
  const { compiledContext } = props.inspection;
  const manifest = compiledContext.retrievalManifest;
  const selectedCandidates = props.inspection.retrievalCandidates.filter(
    (candidate) => candidate.selectedSection !== null,
  ).length;

  return (
    <section aria-label="Generation summary" className="inspectorSummary">
      <InspectorFact label="Command">
        <CommandId id={props.inspection.generationCommandId} />
      </InspectorFact>
      <InspectorFact label="Command status">
        {props.inspection.commandStatus}
      </InspectorFact>
      <InspectorFact label="Attempt status">
        {props.inspection.attemptStatus}
      </InspectorFact>
      <InspectorFact label="Provider">
        {props.inspection.provider} / {props.inspection.model}
      </InspectorFact>
      <InspectorFact label="Safety posture">
        <span
          className="contextPosture"
          data-posture-state={compiledContext.safetyPosture.state}
        >
          {safetyPostureLabel(compiledContext.safetyPosture.state)}
        </span>
      </InspectorFact>
      <InspectorFact label="Selected tokens">
        {compiledContext.totalTokens.toLocaleString()}
      </InspectorFact>
      <InspectorFact label="Compiled sections">
        {compiledContext.sections.length}
      </InspectorFact>
      <InspectorFact label="Injected memory items">
        {props.injectedCount}
      </InspectorFact>
      <InspectorFact label="Retrieval">
        {props.retrieval.state === "none"
          ? "No retrieval run linked"
          : props.retrieval.state === "degraded"
            ? `Degraded (${props.retrieval.degradedReasonCodes.length})`
            : "Completed"}
      </InspectorFact>
      <InspectorFact label="Candidates">
        {manifest
          ? `${manifest.candidate_count} found · ${manifest.qualified_count} qualified · ${manifest.fenced_out_count} fenced out`
          : "—"}
      </InspectorFact>
      <InspectorFact label="Selected candidates">
        {manifest ? selectedCandidates : "—"}
      </InspectorFact>
      <InspectorFact label="Checked at">
        {props.inspection.checkedAt}
      </InspectorFact>
    </section>
  );
}

function Degradations(props: {
  inspection: ContextInspectorPayload;
  retrieval: ContextInspectorRetrievalSummary;
}) {
  const degradedReason = props.inspection.compiledContext.degradedReason;
  const codes = [
    ...(degradedReason ? [degradedReason] : []),
    ...props.retrieval.degradedReasonCodes,
    ...props.retrieval.portraitDegradedReasonCodes,
  ];
  if (codes.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Degradations"
      className="inspectorCard contextWarnings"
      role="status"
    >
      <h2>Degradations</h2>
      {codes.map((code) => (
        <p className="contextWarningLine" key={code}>
          {humanizeDiagnosticCode(code)} <code>{code}</code>
        </p>
      ))}
    </section>
  );
}

function CompiledContextBody(props: { inspection: ContextInspectorPayload }) {
  const { compiledContext } = props.inspection;
  return (
    <>
      <dl className="inspectorFacts">
        <InspectorFact label="Source revision">
          {compiledContext.sourceRevision}
        </InspectorFact>
        <InspectorFact label="Dialogue revision">
          {compiledContext.dialogueRevision}
        </InspectorFact>
        <InspectorFact label="Raw-event budget">
          {compiledContext.sectionBudgets.committedRawEvents.toLocaleString()}
        </InspectorFact>
        <InspectorFact label="Degradation">
          {compiledContext.degradedReason ?? "None recorded"}
        </InspectorFact>
      </dl>
      <div
        className={`inspectorDegradation ${compiledContext.degradedReason ? "isDegraded" : "isClean"}`}
        role="status"
      >
        {compiledContext.degradedReason
          ? `Degraded: ${compiledContext.degradedReason}`
          : "No degradation reason recorded for this Context."}
      </div>
      <div className="inspectorTableWrap">
        <table className="inspectorTable">
          <caption>
            Compiled sections: version/evidence and token selection
          </caption>
          <thead>
            <tr>
              <th scope="col">Ordinal</th>
              <th scope="col">Section</th>
              <th scope="col">Version / evidence</th>
              <th scope="col">Budget</th>
              <th scope="col">Selected</th>
              <th scope="col">Truncatable</th>
            </tr>
          </thead>
          <tbody>
            {compiledContext.sections.map((section) => (
              <tr key={`${section.ordinal}-${section.key}`}>
                <th scope="row">{section.ordinal}</th>
                <td>
                  <code>{section.key}</code>
                </td>
                <td>
                  <code>{sectionVersionLabel(section, compiledContext)}</code>
                </td>
                <td>{formatTokens(section.budgetTokens)}</td>
                <td>{formatTokens(section.selectedTokens)}</td>
                <td>{section.truncatable ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DialogueStateBody(props: { inspection: ContextInspectorPayload }) {
  const dialogueState = props.inspection.compiledContext.dialogueState;
  if (!dialogueState) {
    return (
      <p className="inspectorMuted">
        DialogueState was not included in this compiled Context.
      </p>
    );
  }
  return (
    <>
      <dl className="inspectorFacts">
        <InspectorFact label="Policy">
          <code>{dialogueState.policyVersion}</code>
        </InspectorFact>
        <InspectorFact label="Dialogue revision">
          {dialogueState.dialogueRevision}
        </InspectorFact>
        <InspectorFact label="Source revision">
          {dialogueState.sourceRevision}
        </InspectorFact>
      </dl>
      <div className="inspectorTableWrap">
        <table className="inspectorTable">
          <caption>
            DialogueState v2 field confidence and source revisions
          </caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Value</th>
              <th scope="col">Confidence</th>
              <th scope="col">Source revisions</th>
            </tr>
          </thead>
          <tbody>
            {DIALOGUE_STATE_FIELDS.map((field) => (
              <DialogueFieldRow
                field={field}
                key={field}
                value={dialogueState.content[field]}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SafetyPostureBody(props: { inspection: ContextInspectorPayload }) {
  const posture = props.inspection.compiledContext.safetyPosture.posture;
  if (!posture) {
    return (
      <p className="inspectorMuted">
        No Safety Posture projection was active or recorded for this Context.
      </p>
    );
  }
  return (
    <dl className="inspectorFacts">
      <InspectorFact label="Policy">
        <code>{posture.policyVersion}</code>
      </InspectorFact>
      <InspectorFact label="Kind">{posture.content.kind}</InspectorFact>
      <InspectorFact label="Clean turns">
        {posture.content.cleanTurnCount}
      </InspectorFact>
      <InspectorFact label="Version">{posture.versionNo}</InspectorFact>
      <InspectorFact label="Activated user revision">
        <code>{posture.content.evidence.activatedUserEventRevisionId}</code>
      </InspectorFact>
      <InspectorFact label="Last-turn user revision">
        <code>{posture.content.evidence.lastTurnUserEventRevisionId}</code>
      </InspectorFact>
      <InspectorFact label="Released by">
        {posture.content.releasedBy ? (
          <code>{posture.content.releasedBy.userEventRevisionId}</code>
        ) : (
          "—"
        )}
      </InspectorFact>
    </dl>
  );
}

function RetrievalBody(props: { inspection: ContextInspectorPayload }) {
  const { compiledContext, retrievalCandidates } = props.inspection;
  const manifest = compiledContext.retrievalManifest;
  const memorySections = memorySectionItemsFromSections(
    compiledContext.sections,
  );
  if (manifest === null) {
    return (
      <p className="inspectorMuted">
        No retrieval run is linked to this compiled Context.
      </p>
    );
  }

  const runDegraded = manifest.degraded_reason_codes.length > 0;
  const portraitDegraded = manifest.portrait_degraded_reason_codes.length > 0;
  const referenceOf = (sectionKey: string) =>
    compiledContext.sections.find((section) => section.key === sectionKey)
      ?.reference;

  return (
    <div className="contextRetrieval">
      <h3>Injected memory items</h3>
      {memorySections.length === 0 ? (
        <p className="inspectorMuted">
          No memory was injected this turn — the sections the model received
          contain no memory item.
        </p>
      ) : (
        memorySections.map((section) => (
          <div className="inspectorTableWrap" key={section.sectionKey}>
            <table className="inspectorTable">
              <caption>
                Injected items — <code>{section.sectionKey}</code>
              </caption>
              <thead>
                <tr>
                  <th scope="col">Ref</th>
                  <th scope="col">Rendered text</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Epistemic</th>
                  <th scope="col">Claim / version</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">Temporal</th>
                </tr>
              </thead>
              <tbody>
                {section.items.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      Item lines could not be parsed from this section; the
                      exact content the model received is shown verbatim:
                      <pre className="contextVerbatim">
                        {referenceOf(section.sectionKey)}
                      </pre>
                    </td>
                  </tr>
                ) : (
                  section.items.map((item) => (
                    <tr key={item.contextMemoryRef}>
                      <th scope="row">
                        <code>{item.contextMemoryRef}</code>
                      </th>
                      <td>{item.renderedText}</td>
                      <td>{item.kind}</td>
                      <td>{item.epistemicStatus}</td>
                      <td>
                        <code className="inspectorId">{item.claimId}</code>
                        <br />
                        <code className="inspectorId">
                          {item.claimVersionId}
                        </code>
                      </td>
                      <td>
                        {item.evidenceIds.length > 0
                          ? `${item.evidenceIds.length} item(s)`
                          : "none"}
                      </td>
                      <td>
                        {item.temporalStatus}
                        {item.validFrom ? ` from ${item.validFrom}` : ""}
                        {item.validTo ? ` to ${item.validTo}` : ""}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ))
      )}

      <h3>Retrieval run</h3>
      <dl className="inspectorFacts">
        <InspectorFact label="Run">
          <code>{manifest.retrieval_run_id}</code>
        </InspectorFact>
        <InspectorFact label="Deadline">
          {manifest.duration_ms.toLocaleString()} ms of{" "}
          {manifest.deadline_ms.toLocaleString()} ms
          {manifest.deadline_exceeded_stage
            ? ` (exceeded at ${manifest.deadline_exceeded_stage})`
            : ""}
        </InspectorFact>
        <InspectorFact label="Phase timings">
          {Object.entries(manifest.timings)
            .map(([phase, ms]) => `${phase} ${ms} ms`)
            .join(" · ") || "—"}
        </InspectorFact>
        <InspectorFact label="Funnel counts">
          {manifest.candidate_count} candidates · {manifest.qualified_count}{" "}
          qualified · {manifest.fenced_out_count} fenced out
        </InspectorFact>
        <InspectorFact label="Query signal">
          {manifest.zero_signal
            ? "zero signal recorded (no matchable query signal)"
            : "signals present"}
        </InspectorFact>
        <InspectorFact label="Portrait selection">
          pool {manifest.portrait_selection.pool_count} · selected{" "}
          {manifest.portrait_selection.selected_claim_version_ids.length}
        </InspectorFact>
        <InspectorFact label="Degradations">
          {runDegraded ? manifest.degraded_reason_codes.join(", ") : "None"}
          {portraitDegraded
            ? `${runDegraded ? " · " : ""}portrait-only: ${manifest.portrait_degraded_reason_codes.join(", ")}`
            : ""}
        </InspectorFact>
      </dl>
      <div
        className={`inspectorDegradation ${runDegraded || portraitDegraded ? "isDegraded" : "isClean"}`}
        role="status"
      >
        {runDegraded
          ? `Memory degraded: ${manifest.degraded_reason_codes.join(", ")}`
          : portraitDegraded
            ? `Person Portrait omitted this turn: ${manifest.portrait_degraded_reason_codes.join(", ")}`
            : "The retrieval round completed without degradation."}
      </div>

      <h3>Candidate funnel</h3>
      <div className="inspectorTableWrap">
        <table className="inspectorTable">
          <caption>
            Every candidate of the run with its selection / rejection reasons
          </caption>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Lane</th>
              <th scope="col">Claim version</th>
              <th scope="col">Matched</th>
              <th scope="col">Rank fields</th>
              <th scope="col">Fences</th>
              <th scope="col">Outcome</th>
              <th scope="col">Reasons</th>
            </tr>
          </thead>
          <tbody>
            {retrievalCandidates.length === 0 ? (
              <tr>
                <td colSpan={8}>No candidates were recorded for this run.</td>
              </tr>
            ) : (
              retrievalCandidates.map((candidate) => {
                const failedFences = candidate.trustFenceResults.filter(
                  (fence) => !fence.passed,
                );
                const outcomeReasons = [
                  ...candidate.selectionReasonCodes,
                  ...candidate.rejectionReasonCodes,
                ];
                return (
                  <tr key={candidate.retrievalProjectionId}>
                    <th scope="row">{candidate.finalRank ?? "fenced"}</th>
                    <td>
                      <code>{candidate.lane}</code>
                    </td>
                    <td>
                      <code className="inspectorId">
                        {candidate.claimVersionId}
                      </code>
                    </td>
                    <td>
                      {candidate.matchedFields.join(", ") || "—"}
                      {candidate.matchedTerms.length > 0
                        ? ` (${candidate.matchedTerms.join(", ")})`
                        : ""}
                    </td>
                    <td>
                      {`entity ${candidate.rankComponents.entity_match} · predicate ${candidate.rankComponents.predicate_match} · temporal ${candidate.rankComponents.temporal_fit} · lexical ${candidate.rankComponents.lexical_coverage}`}
                      {candidate.rankComponents.fts_rank !== null
                        ? ` · fts ${candidate.rankComponents.fts_rank.toFixed(3)}`
                        : ""}
                    </td>
                    <td>
                      {failedFences.length === 0
                        ? "all passed"
                        : failedFences.map((fence) => fence.fence).join(", ")}
                    </td>
                    <td>{candidate.selectedSection ?? "not selected"}</td>
                    <td>{outcomeReasons.join(", ") || "—"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RawJson(props: { inspection: ContextInspectorPayload }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const text = JSON.stringify(props.inspection, null, 2);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <div className="contextRaw">
      <div className="contextRawActions">
        <p className="inspectorMuted">
          Exact payload. Long values scroll inside this block; the page never
          scrolls sideways.
        </p>
        <button
          className="inspectorSmallButton"
          onClick={() => void copy()}
          type="button"
        >
          {copied ? "Copied" : "Copy JSON"}
        </button>
      </div>
      {copyError ? (
        <p className="submissionError">
          Copy is unavailable in this browser.
        </p>
      ) : null}
      <pre
        aria-label="Raw inspection JSON"
        className="contextJson"
        role="region"
        tabIndex={0}
      >
        {text}
      </pre>
    </div>
  );
}

function CommandId(props: { id: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.id);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <span className="contextCommandId">
      <code>{props.id}</code>
      <button
        aria-label="复制 GenerationCommand ID"
        className="inspectorSmallButton"
        onClick={() => void copy()}
        title="复制 GenerationCommand ID"
        type="button"
      >
        {copied ? "Copied" : "Copy ID"}
      </button>
      {copyError ? (
        <span className="submissionError">Copy unavailable</span>
      ) : null}
    </span>
  );
}

function ContextDisclosure(props: {
  children: ReactNode;
  status?: ReactNode;
  subtitle?: string;
  title: string;
}) {
  return (
    <details className="inspectorCard contextDisclosure">
      <summary className="contextDisclosureSummary">
        <span className="contextDisclosureTitle">{props.title}</span>
        {props.subtitle ? (
          <span className="contextDisclosureSubtitle">{props.subtitle}</span>
        ) : null}
        {props.status !== undefined ? (
          <span className="contextDisclosureStatus">{props.status}</span>
        ) : null}
        <span aria-hidden="true" className="contextDisclosureChevron">
          ▾
        </span>
      </summary>
      <div className="contextDisclosureBody">{props.children}</div>
    </details>
  );
}

function DialogueFieldRow(props: {
  field: (typeof DIALOGUE_STATE_FIELDS)[number];
  value: ContextInspectorDialogueField;
}) {
  return (
    <tr>
      <th scope="row">{dialogueFieldLabels[props.field]}</th>
      <td>{formatValue(props.value.value)}</td>
      <td>{props.value.confidence.toFixed(2)}</td>
      <td>
        {props.value.sourceRevisionIds.length > 0
          ? props.value.sourceRevisionIds.map((revisionId) => (
              <code className="inspectorId" key={revisionId}>
                {revisionId}
              </code>
            ))
          : "—"}
      </td>
    </tr>
  );
}

function InspectorFact(props: { children: ReactNode; label: string }) {
  return (
    <div className="inspectorFact">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

function formatTokens(tokens: number | null): string {
  return tokens === null ? "unbounded" : tokens.toLocaleString();
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function policyVersionRows(
  versions: ContextInspectorContext["policyVersions"],
): readonly (readonly [string, string])[] {
  return [
    ["Product policy", versions.productPolicyVersion],
    ["Safety policy", versions.safetyPolicyVersion],
    ["Relationship boundary", versions.relationshipPolicyVersion],
    ["Persona contract", versions.personaContractInvariantVersion],
    ["Canonical Persona", versions.canonicalPersonaVersion],
    ["Behavior anchors", versions.personaBehaviorAnchorsVersion],
    ["Task instruction", versions.taskInstructionVersion],
    ["Output format", versions.outputFormatVersion],
    ["Locale pack", versions.localePolicyVersion],
  ];
}
