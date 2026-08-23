"use client";

import { useEffect, useState, type FormEvent } from "react";

import {
  DIALOGUE_STATE_FIELDS,
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
    </div>
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
