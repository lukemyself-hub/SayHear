"use client";

import { useEffect, useState, type FormEvent } from "react";

import {
  DIALOGUE_STATE_FIELDS,
  memorySectionItemsFromSections,
  sectionVersionLabel,
  type ContextInspectorContext,
  type ContextInspectorDialogueField,
  type ContextInspectorPayload,
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

export function ContextInspector(props: {
  initialGenerationCommandId: string;
}) {
  const [generationCommandId, setGenerationCommandId] = useState(
    props.initialGenerationCommandId,
  );
  const [inspection, setInspection] =
    useState<ContextInspectorPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function inspect(requestedId: string) {
    const normalizedId = requestedId.trim();
    if (!normalizedId) {
      setError("Enter a GenerationCommand ID to inspect.");
      setInspection(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/internal/inspection/generation?generation_command_id=${encodeURIComponent(normalizedId)}`,
        { cache: "no-store", method: "GET" },
      );
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "That GenerationCommand was not found for this Internal Owner."
            : `The inspection could not be loaded (${response.status}).`,
        );
      }
      setInspection((await response.json()) as ContextInspectorPayload);
    } catch (inspectionError) {
      setInspection(null);
      setError(
        inspectionError instanceof Error
          ? inspectionError.message
          : "The inspection could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (props.initialGenerationCommandId) {
      void inspect(props.initialGenerationCommandId);
    }
  }, [props.initialGenerationCommandId]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void inspect(generationCommandId);
  }

  return (
    <main className="shell inspectorShell">
      <nav className="internalNav" aria-label="Internal tools">
        <a href="/internal">← Back to Internal Core</a>
      </nav>
      <section className="eyebrow">SayHear Internal Core</section>
      <h1>Context Inspector</h1>
      <p className="lede">
        Read-only evidence for one compiled Context. This page performs only a
        GET against the existing inspection endpoint; it cannot change a
        GenerationCommand or conversation data.
      </p>
      <form className="inspectorLookup" onSubmit={submit}>
        <label htmlFor="generation-command-id">GenerationCommand ID</label>
        <div className="inspectorLookupRow">
          <input
            id="generation-command-id"
            onChange={(event) => setGenerationCommandId(event.target.value)}
            placeholder="Paste a GenerationCommand UUID"
            spellCheck={false}
            value={generationCommandId}
          />
          <button disabled={loading} type="submit">
            {loading ? "Loading…" : "Inspect"}
          </button>
        </div>
      </form>
      {error ? <p className="inspectorError" role="alert">{error}</p> : null}
      {inspection ? <InspectionReport inspection={inspection} /> : null}
    </main>
  );
}

function InspectionReport(props: { inspection: ContextInspectorPayload }) {
  const { compiledContext } = props.inspection;
  const postureLabel =
    compiledContext.safetyPosture.state === "released"
      ? "Cleared"
      : compiledContext.safetyPosture.state === "active"
        ? "Active"
        : "Default";

  return (
    <div className="inspectorReport">
      <section className="inspectorSummary" aria-label="Generation summary">
        <InspectorFact label="Command">
          <code>{props.inspection.generationCommandId}</code>
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
      </section>

      <section className="inspectorCard">
        <div className="inspectorHeading">
          <div>
            <h2>Compiled Context</h2>
            <p>Compiler {compiledContext.compilerVersion}, locale {compiledContext.locale}</p>
          </div>
          <strong>{compiledContext.totalTokens.toLocaleString()} selected tokens</strong>
        </div>
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
            <caption>Compiled sections: version/evidence and token selection</caption>
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
                  <td><code>{section.key}</code></td>
                  <td><code>{sectionVersionLabel(section, compiledContext)}</code></td>
                  <td>{formatTokens(section.budgetTokens)}</td>
                  <td>{formatTokens(section.selectedTokens)}</td>
                  <td>{section.truncatable ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="inspectorCard">
        <h2>Pinned policy versions</h2>
        <div className="inspectorVersionGrid">
          {policyVersionRows(compiledContext.policyVersions).map(([label, version]) => (
            <InspectorFact key={label} label={label}>
              <code>{version}</code>
            </InspectorFact>
          ))}
        </div>
      </section>

      <section className="inspectorCard">
        <div className="inspectorHeading">
          <div>
            <h2>DialogueState evidence</h2>
            <p>Non-authoritative v2 projection used, if present, by this Context.</p>
          </div>
          {compiledContext.dialogueState ? (
            <strong>{compiledContext.dialogueState.status}</strong>
          ) : null}
        </div>
        {compiledContext.dialogueState ? (
          <>
            <dl className="inspectorFacts">
              <InspectorFact label="Policy">
                <code>{compiledContext.dialogueState.policyVersion}</code>
              </InspectorFact>
              <InspectorFact label="Dialogue revision">
                {compiledContext.dialogueState.dialogueRevision}
              </InspectorFact>
              <InspectorFact label="Source revision">
                {compiledContext.dialogueState.sourceRevision}
              </InspectorFact>
            </dl>
            <div className="inspectorTableWrap">
              <table className="inspectorTable">
                <caption>DialogueState v2 field confidence and source revisions</caption>
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
                      value={compiledContext.dialogueState!.content[field]}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="inspectorMuted">DialogueState was not included in this compiled Context.</p>
        )}
      </section>

      <section className="inspectorCard">
        <div className="inspectorHeading">
          <div>
            <h2>Safety Posture</h2>
            <p>Deterministic Daily-Session status and turn evidence.</p>
          </div>
          <strong data-posture-state={compiledContext.safetyPosture.state}>
            {postureLabel}
          </strong>
        </div>
        {compiledContext.safetyPosture.posture ? (
          <dl className="inspectorFacts">
            <InspectorFact label="Policy">
              <code>{compiledContext.safetyPosture.posture.policyVersion}</code>
            </InspectorFact>
            <InspectorFact label="Kind">
              {compiledContext.safetyPosture.posture.content.kind}
            </InspectorFact>
            <InspectorFact label="Clean turns">
              {compiledContext.safetyPosture.posture.content.cleanTurnCount}
            </InspectorFact>
            <InspectorFact label="Version">
              {compiledContext.safetyPosture.posture.versionNo}
            </InspectorFact>
            <InspectorFact label="Activated user revision">
              <code>{compiledContext.safetyPosture.posture.content.evidence.activatedUserEventRevisionId}</code>
            </InspectorFact>
            <InspectorFact label="Last-turn user revision">
              <code>{compiledContext.safetyPosture.posture.content.evidence.lastTurnUserEventRevisionId}</code>
            </InspectorFact>
            <InspectorFact label="Released by">
              {compiledContext.safetyPosture.posture.content.releasedBy ? (
                <code>{compiledContext.safetyPosture.posture.content.releasedBy.userEventRevisionId}</code>
              ) : (
                "—"
              )}
            </InspectorFact>
          </dl>
        ) : (
          <p className="inspectorMuted">No Safety Posture projection was active or recorded for this Context.</p>
        )}
      </section>

      <RetrievalPanel inspection={props.inspection} />
    </div>
  );
}

function RetrievalPanel(props: { inspection: ContextInspectorPayload }) {
  const { compiledContext, retrievalCandidates } = props.inspection;
  const manifest = compiledContext.retrievalManifest;
  const memorySections = memorySectionItemsFromSections(
    compiledContext.sections,
  );
  if (manifest === null) {
    return (
      <section className="inspectorCard">
        <div className="inspectorHeading">
          <div>
            <h2>Memory retrieval</h2>
            <p>
              The injected memory items and the full retrieval run of this
              turn. Read-only: the panel renders the recorded CompiledContext
              and run ledger; it never recomputes or changes a selection.
            </p>
          </div>
        </div>
        <p className="inspectorMuted">
          No retrieval run is linked to this compiled Context.
        </p>
      </section>
    );
  }

  const runDegraded = manifest.degraded_reason_codes.length > 0;
  const portraitDegraded =
    manifest.portrait_degraded_reason_codes.length > 0;
  const referenceOf = (sectionKey: string) =>
    compiledContext.sections.find(
      (section) => section.key === sectionKey,
    )?.reference;

  return (
    <section className="inspectorCard">
      <div className="inspectorHeading">
        <div>
          <h2>Memory retrieval</h2>
          <p>
            The injected memory items and the full retrieval run of this turn.
            Read-only: the panel renders the recorded CompiledContext and run
            ledger; it never recomputes or changes a selection.
          </p>
        </div>
        <strong data-retrieval-state={runDegraded ? "degraded" : "completed"}>
          {runDegraded ? "Degraded" : "Completed"}
        </strong>
      </div>
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
                      <pre>{referenceOf(section.sectionKey)}</pre>
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
          {manifest.candidate_count} candidates ·{" "}
          {manifest.qualified_count} qualified ·{" "}
          {manifest.fenced_out_count} fenced out
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
                        : failedFences
                            .map((fence) => fence.fence)
                            .join(", ")}
                    </td>
                    <td>
                      {candidate.selectedSection ?? "not selected"}
                    </td>
                    <td>{outcomeReasons.join(", ") || "—"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
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
              <code className="inspectorId" key={revisionId}>{revisionId}</code>
            ))
          : "—"}
      </td>
    </tr>
  );
}

function InspectorFact(props: { children: React.ReactNode; label: string }) {
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
