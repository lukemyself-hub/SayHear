"use client";

import { signIn } from "next-auth/react";
import { useEffect, useState, type FormEvent } from "react";

type ReflectionItem = Readonly<{
  createdAt: string;
  current: VersionItem | null;
  currentOutcome: string | null;
  currentVersionId: string | null;
  dailySessionId: string | null;
  logicalDate: string | null;
  reflectionId: string;
  scopeType: string;
  weekIdentifier: string | null;
  windowEndDate: string | null;
  windowStartDate: string | null;
}>;

type VersionItem = Readonly<{
  contentState: string;
  current: boolean;
  degradedEpisodeReason: string | null;
  locale: string;
  metadata: Readonly<{
    authoritativeModelAttemptId: string | null;
    attemptKind: string | null;
    attemptStatus: string | null;
    generationCommandId: string | null;
    model: string | null;
    modelConfigVersion: string | null;
    modelSnapshot: string | null;
    modelRole: string | null;
    policyVersion: string | null;
    provider: string | null;
    providerPolicyVersion: string | null;
    rolloutPin: string | null;
    schedulePolicyVersion: string | null;
    validationPolicyVersion: string | null;
    validationPromptVersion: string | null;
    validationSchemaVersion: string | null;
    validationBlockingFindingCodes: readonly string[];
    validationAdvisoryFindingCodes: readonly string[];
    validationCoveredKeys: readonly string[];
    validationUncoveredPlannedKeys: readonly string[];
    validationVerdict: string | null;
    validatorRequestId: string | null;
    validatorResultId: string | null;
  }>;
  promptVersion: string;
  revision: number;
  schemaVersion: string;
  sourceDigest: string | null;
  sourceRevision: number;
  status: string;
  versionId: string;
}>;

type StatementItem = Readonly<{
  contentState: string;
  statementId: string;
  statementIndex: number;
  statementKind: string;
  statementText: string | null;
}>;

type PropositionItem = Readonly<{
  baselineClaimIds: readonly string[];
  contentState: string;
  epistemicRendering: string;
  propositionId: string;
  propositionIndex: number;
  propositionKind: string;
  propositionText: string | null;
}>;

type EvidenceItem = Readonly<{
  evidenceItemId: string;
  evidenceLinkId: string;
  locatorKey: string;
  locatorType: string;
  locale: string | null;
  logicalDate: string | null;
  sourceOutcome: string;
  sourceRevision: number;
  sourceRevisionId: string;
  sourceStatus: string | null;
}>;

type CandidateItem = Readonly<{
  candidateId: string | null;
  candidateEvidenceItemIds: readonly string[];
  candidateStatus: string | null;
  contentState: string;
  createdAt: string;
  decidedAt: string | null;
  dispositionPolicyVersion: string | null;
  dispositionReasonCode: string | null;
  materialChangeReasonCodes: readonly string[];
  outcome: string;
  predecessorCandidateId: string | null;
  proposalId: string;
  registryReleaseDueAt: string | null;
  reviewDueAt: string | null;
  successorTrigger: string | null;
  terminalContentExpiresAt: string | null;
  terminalEffectiveAt: string | null;
}>;

type CandidateLineageItem = Readonly<{
  candidateId: string;
  contentPurged: boolean;
  createdAt: string;
  decidedAt: string | null;
  dispositionPolicyVersion: string | null;
  dispositionReasonCode: string | null;
  materialChangeReasonCodes: readonly string[];
  predecessorCandidateId: string | null;
  registryReleaseDueAt: string | null;
  reviewDueAt: string | null;
  status: string | null;
  successorTrigger: string | null;
  terminalContentExpiresAt: string | null;
  terminalEffectiveAt: string | null;
}>;

type ClaimItem = Readonly<{
  claimId: string | null;
  claimVersionId: string | null;
  diffId: string;
  diffKind: string;
  eligibility: string;
  isCurrentVersion: boolean;
  outcome: string;
  revision: number | null;
  status: string | null;
}>;

type BioItem = Readonly<{
  bioCoverageUnitId: string | null;
  bioId: string;
  bioVersionId: string;
  coverageDisposition: string | null;
  coveragePolicyVersion: string | null;
  current: boolean;
  expectedDataEpoch: number;
  linkRole: string;
  revision: number;
  sourceRevision: number;
  status: string;
  supportStatus: string;
  unitKey: string | null;
}>;

type Page<T> = Readonly<{
  outcome: "ok";
  items: readonly T[];
  nextCursor: string | null;
  snapshot: string;
}>;

type ReflectionReadOutcome = Readonly<{
  outcome: string;
  reflectionId?: string;
  reflectionVersionId?: string;
}>;

const API = "/api/internal/inspection/reflection";
const STEP_UP_API = "/api/internal/inspection/evidence-step-up";
const STEP_UP_CALLBACK_URL = "/internal/reflection-inspector";

type StepUpStatus = "idle" | "requesting" | "not-permitted" | "unavailable";

async function getJson<T>(params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(params);
  const response = await fetch(`${API}?${query.toString()}`, {
    cache: "no-store",
    method: "GET",
  });
  const body = (await response.json()) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(
      body.error === "reflection_capability_required"
        ? "This session does not have reflection_inspection:read."
        : body.error === "recent_step_up_required"
          ? "Opening the original words needs a recent verification. Use the verification button above, then try again."
          : `The inspection could not be loaded (${response.status}).`,
    );
  }
  return body;
}

function isPage<T>(value: unknown): value is Page<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { outcome?: unknown }).outcome === "ok" &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

function outcomeOf(value: unknown): string | null {
  return typeof value === "object" && value !== null &&
    typeof (value as { outcome?: unknown }).outcome === "string"
    ? (value as { outcome: string }).outcome
    : null;
}

function isReflectionItem(value: unknown): value is ReflectionItem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { reflectionId?: unknown }).reflectionId === "string" &&
    typeof (value as { scopeType?: unknown }).scopeType === "string"
  );
}

export function ReflectionInspector(props: { initialReflectionId: string }) {
  const [reflectionId, setReflectionId] = useState(props.initialReflectionId);
  const [reflections, setReflections] = useState<ReflectionItem[]>([]);
  const [reflectionCursor, setReflectionCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReflectionItem | null>(null);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [versionCursor, setVersionCursor] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<VersionItem | null>(null);
  const [statements, setStatements] = useState<StatementItem[]>([]);
  const [statementCursor, setStatementCursor] = useState<string | null>(null);
  const [propositions, setPropositions] = useState<Record<string, PropositionItem[]>>({});
  const [propositionCursors, setPropositionCursors] = useState<Record<string, string | null>>({});
  const [evidence, setEvidence] = useState<Record<string, EvidenceItem[]>>({});
  const [evidenceCursors, setEvidenceCursors] = useState<Record<string, string | null>>({});
  const [candidates, setCandidates] = useState<CandidateItem[]>([]);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [claims, setClaims] = useState<Record<string, ClaimItem[]>>({});
  const [claimCursors, setClaimCursors] = useState<Record<string, string | null>>({});
  const [bioImpacts, setBioImpacts] = useState<Record<string, BioItem[]>>({});
  const [bioImpactCursors, setBioImpactCursors] = useState<Record<string, string | null>>({});
  const [predecessors, setPredecessors] = useState<Record<string, CandidateLineageItem[]>>({});
  const [predecessorCursors, setPredecessorCursors] = useState<Record<string, string | null>>({});
  const [successors, setSuccessors] = useState<Record<string, CandidateLineageItem[]>>({});
  const [successorCursors, setSuccessorCursors] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stepUpStatus, setStepUpStatus] = useState<StepUpStatus>("idle");

  async function loadReflections(cursor: string | null = null, append = false) {
    setLoading(true);
    setError(null);
    try {
      const result = await getJson<Page<ReflectionItem>>({
        ...(cursor ? { cursor } : {}),
        layer: "reflections",
      });
      setReflections((current) => append ? [...current, ...result.items] : [...result.items]);
      setReflectionCursor(result.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The reflections could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  async function loadReflection(requestedId: string) {
    const normalizedId = requestedId.trim();
    if (!normalizedId) {
      setError("Enter a Reflection ID or select a row.");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const result = await getJson<ReflectionItem | ReflectionReadOutcome>({
        layer: "reflections",
        reflection_id: normalizedId,
      });
      const reflection: ReflectionItem | null = isReflectionItem(result)
        ? result
        : typeof result.reflectionId === "string"
          ? {
              createdAt: "",
              current: null,
              currentOutcome: result.outcome,
              currentVersionId: result.reflectionVersionId ?? null,
              dailySessionId: null,
              logicalDate: null,
              reflectionId: result.reflectionId,
              scopeType: "unknown",
              weekIdentifier: null,
              windowEndDate: null,
              windowStartDate: null,
            }
          : null;
      if (!reflection) {
        setSelected(null);
        setVersions([]);
        setSelectedVersion(null);
        setNotice(`Reflection returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
        return;
      }
      setSelected(reflection);
      const versionResult = await getJson<Page<VersionItem> | { outcome: string }>({
        ...(reflection.currentVersionId ? { expected_current_version_id: reflection.currentVersionId } : {}),
        layer: "versions",
        reflection_id: reflection.reflectionId,
      });
      if (!isPage<VersionItem>(versionResult)) {
        setVersions([]);
        setSelectedVersion(null);
        setNotice(`Version history returned typed outcome: ${outcomeOf(versionResult) ?? "unknown"}.`);
        return;
      }
      setVersions([...versionResult.items]);
      setVersionCursor(versionResult.nextCursor);
      const current = versionResult.items.find((version) => version.current) ?? null;
      if (current) await loadVersion(reflection, current);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The reflection could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  async function loadVersion(reflection: ReflectionItem, version: VersionItem) {
    setSelected(reflection);
    setSelectedVersion(version);
    setPropositions({});
    setPropositionCursors({});
    setEvidence({});
    setEvidenceCursors({});
    setClaims({});
    setClaimCursors({});
    setBioImpacts({});
    setBioImpactCursors({});
    setPredecessors({});
    setPredecessorCursors({});
    setSuccessors({});
    setSuccessorCursors({});
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const [statementResult, candidateResult] = await Promise.all([
        getJson<Page<StatementItem> | { outcome: string }>({
          layer: "statements",
          reflection_version_id: version.versionId,
          ...(reflection.currentVersionId ? { expected_current_version_id: reflection.currentVersionId } : {}),
        }),
        getJson<Page<CandidateItem> | { outcome: string }>({
          layer: "candidates",
          reflection_version_id: version.versionId,
          ...(reflection.currentVersionId ? { expected_current_version_id: reflection.currentVersionId } : {}),
        }),
      ]);
      if (isPage<StatementItem>(statementResult)) {
        setStatements([...statementResult.items]);
        setStatementCursor(statementResult.nextCursor);
      } else {
        setStatements([]);
        setStatementCursor(null);
      }
      if (isPage<CandidateItem>(candidateResult)) {
        setCandidates([...candidateResult.items]);
        setCandidateCursor(candidateResult.nextCursor);
      } else {
        setCandidates([]);
        setCandidateCursor(null);
      }
      if (!isPage<StatementItem>(statementResult) || !isPage<CandidateItem>(candidateResult)) {
        setNotice(`Trace returned typed outcome: ${outcomeOf(statementResult) ?? outcomeOf(candidateResult) ?? "unknown"}.`);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The reflection trace could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  async function loadMoreStatements(reflection: ReflectionItem, version: VersionItem, cursor: string) {
    try {
      const result = await getJson<Page<StatementItem> | { outcome: string }>({
        cursor,
        layer: "statements",
        reflection_version_id: version.versionId,
        ...(reflection.currentVersionId ? { expected_current_version_id: reflection.currentVersionId } : {}),
      });
      if (!isPage<StatementItem>(result)) {
        setStatementCursor(null);
        setNotice(`Statements returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
        return;
      }
      setStatements((current) => [...current, ...result.items]);
      setStatementCursor(result.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The next statement page could not be loaded.");
    }
  }

  async function loadMoreCandidates(reflection: ReflectionItem, version: VersionItem, cursor: string) {
    try {
      const result = await getJson<Page<CandidateItem> | { outcome: string }>({
        cursor,
        layer: "candidates",
        reflection_version_id: version.versionId,
        ...(reflection.currentVersionId ? { expected_current_version_id: reflection.currentVersionId } : {}),
      });
      if (!isPage<CandidateItem>(result)) {
        setCandidateCursor(null);
        setNotice(`Candidates returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
        return;
      }
      setCandidates((current) => [...current, ...result.items]);
      setCandidateCursor(result.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The next candidate page could not be loaded.");
    }
  }

  async function loadPropositions(
    statement: StatementItem,
    cursor: string | null = null,
    append = false,
  ) {
    setError(null);
    try {
      const result = await getJson<Page<PropositionItem> | { outcome: string }>({
        ...(cursor ? { cursor } : {}),
        layer: "propositions",
        statement_id: statement.statementId,
        ...(selected?.currentVersionId ? { expected_current_version_id: selected.currentVersionId } : {}),
      });
      setPropositions((current) => ({
        ...current,
        [statement.statementId]: isPage<PropositionItem>(result)
          ? append
            ? [...(current[statement.statementId] ?? []), ...result.items]
            : [...result.items]
          : append
            ? current[statement.statementId] ?? []
            : [],
      }));
      setPropositionCursors((current) => ({
        ...current,
        [statement.statementId]: isPage<PropositionItem>(result) ? result.nextCursor : null,
      }));
      if (!isPage<PropositionItem>(result)) setNotice(`Propositions returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The propositions could not be loaded.");
    }
  }

  async function loadEvidence(
    proposition: PropositionItem,
    cursor: string | null = null,
    append = false,
  ) {
    setError(null);
    try {
      const result = await getJson<Page<EvidenceItem> | { outcome: string }>({
        ...(cursor ? { cursor } : {}),
        layer: "evidence",
        proposition_id: proposition.propositionId,
        ...(selected?.currentVersionId ? { expected_current_version_id: selected.currentVersionId } : {}),
      });
      setEvidence((current) => ({
        ...current,
        [proposition.propositionId]: isPage<EvidenceItem>(result)
          ? append
            ? [...(current[proposition.propositionId] ?? []), ...result.items]
            : [...result.items]
          : append
            ? current[proposition.propositionId] ?? []
            : [],
      }));
      setEvidenceCursors((current) => ({
        ...current,
        [proposition.propositionId]: isPage<EvidenceItem>(result) ? result.nextCursor : null,
      }));
      if (!isPage<EvidenceItem>(result)) setNotice(`Evidence links returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The Evidence links could not be loaded.");
    }
  }

  async function expandEvidence(item: EvidenceItem) {
    setError(null);
    try {
      const result = await getJson<{ outcome: string; text?: string }>({
        evidence_item_id: item.evidenceItemId,
        layer: "evidence_content",
      });
      setNotice(result.text ? `Evidence ${item.evidenceItemId}: ${result.text}` : `Evidence returned typed outcome: ${result.outcome}.`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The Evidence could not be expanded.");
    }
  }

  async function requestEvidenceStepUp() {
    setStepUpStatus("requesting");
    setError(null);
    try {
      const response = await fetch(STEP_UP_API, {
        cache: "no-store",
        method: "POST",
      });
      if (!response.ok) {
        setStepUpStatus(
          response.status === 403 ? "not-permitted" : "unavailable",
        );
        return;
      }
      await signIn(
        "github",
        { callbackUrl: STEP_UP_CALLBACK_URL },
        { prompt: "select_account" },
      );
      setStepUpStatus("unavailable");
    } catch {
      setStepUpStatus("unavailable");
    }
  }

  async function loadClaims(
    candidate: CandidateItem,
    cursor: string | null = null,
    append = false,
  ) {
    if (!candidate.candidateId) {
      setNotice("This proposal has no persisted MemoryCandidate lineage.");
      return;
    }
    setError(null);
    try {
      const result = await getJson<Page<ClaimItem> | { outcome: string }>({
        ...(cursor ? { cursor } : {}),
        candidate_id: candidate.candidateId,
        layer: "claims",
      });
      setClaims((current) => ({
        ...current,
        [candidate.candidateId!]: isPage<ClaimItem>(result)
          ? append
            ? [...(current[candidate.candidateId!] ?? []), ...result.items]
            : [...result.items]
          : append
            ? current[candidate.candidateId!] ?? []
            : [],
      }));
      setClaimCursors((current) => ({
        ...current,
        [candidate.candidateId!]: isPage<ClaimItem>(result) ? result.nextCursor : null,
      }));
      if (!isPage<ClaimItem>(result)) setNotice(`Claim trace returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The Claim trace could not be loaded.");
    }
  }

  async function loadCandidateLineage(
    candidate: CandidateItem,
    direction: "predecessors" | "successors",
    cursor: string | null = null,
    append = false,
  ) {
    if (!candidate.candidateId) {
      setNotice("This proposal has no persisted MemoryCandidate lineage.");
      return;
    }
    setError(null);
    try {
      const result = await getJson<Page<CandidateLineageItem> | { outcome: string }>({
        ...(cursor ? { cursor } : {}),
        candidate_id: candidate.candidateId,
        layer: direction,
      });
      if (direction === "predecessors") {
        setPredecessors((current) => ({
          ...current,
          [candidate.candidateId!]: isPage<CandidateLineageItem>(result)
            ? append
              ? [...(current[candidate.candidateId!] ?? []), ...result.items]
              : [...result.items]
            : append
              ? current[candidate.candidateId!] ?? []
              : [],
        }));
        setPredecessorCursors((current) => ({
          ...current,
          [candidate.candidateId!]: isPage<CandidateLineageItem>(result) ? result.nextCursor : null,
        }));
      } else {
        setSuccessors((current) => ({
          ...current,
          [candidate.candidateId!]: isPage<CandidateLineageItem>(result)
            ? append
              ? [...(current[candidate.candidateId!] ?? []), ...result.items]
              : [...result.items]
            : append
              ? current[candidate.candidateId!] ?? []
              : [],
        }));
        setSuccessorCursors((current) => ({
          ...current,
          [candidate.candidateId!]: isPage<CandidateLineageItem>(result) ? result.nextCursor : null,
        }));
      }
      if (!isPage<CandidateLineageItem>(result)) {
        setNotice(`${direction} returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : `The candidate ${direction} could not be loaded.`);
    }
  }

  async function loadBioImpact(
    claim: ClaimItem,
    cursor: string | null = null,
    append = false,
  ) {
    if (!claim.claimVersionId) {
      setNotice("No explicit ClaimVersion link was recorded.");
      return;
    }
    setError(null);
    try {
      const result = await getJson<Page<BioItem> | { outcome: string }>({
        ...(cursor ? { cursor } : {}),
        layer: "bio_impact",
        memory_claim_version_id: claim.claimVersionId,
      });
      setBioImpacts((current) => ({
        ...current,
        [claim.claimVersionId!]: isPage<BioItem>(result)
          ? append
            ? [...(current[claim.claimVersionId!] ?? []), ...result.items]
            : [...result.items]
          : append
            ? current[claim.claimVersionId!] ?? []
            : [],
      }));
      setBioImpactCursors((current) => ({
        ...current,
        [claim.claimVersionId!]: isPage<BioItem>(result) ? result.nextCursor : null,
      }));
      if (!isPage<BioItem>(result)) setNotice(`Bio impact returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The Bio impact could not be loaded.");
    }
  }

  useEffect(() => {
    void loadReflections();
    if (props.initialReflectionId) void loadReflection(props.initialReflectionId);
  }, [props.initialReflectionId]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadReflection(reflectionId);
  }

  return (
    <div className="inspectorPage">
      <h1>Reflection Inspector</h1>
      <p className="lede">
        Read-only trace from the current Daily or Weekly Reflection through its
        propositions, exact Evidence links, Candidate disposition, Claim
        eligibility, and Bio impact. Each expansion is a separate typed query.
      </p>
      <section className="inspectorCard">
        <div className="inspectorHeading">
          <div>
            <h2>Exact Evidence access</h2>
            <p>
              Opening the user&apos;s original words needs a recent
              verification, separate from Reflection prose.
            </p>
          </div>
          <button
            className="inspectorSmallButton"
            disabled={stepUpStatus === "requesting"}
            onClick={() => void requestEvidenceStepUp()}
            type="button"
          >
            {stepUpStatus === "requesting"
              ? "Opening GitHub…"
              : "Verify again to view original Evidence"}
          </button>
        </div>
        {stepUpStatus === "not-permitted" ? (
          <p className="inspectorError" role="alert">
            This session cannot start Evidence verification.
          </p>
        ) : null}
        {stepUpStatus === "unavailable" ? (
          <p className="inspectorError" role="alert">
            Verification is unavailable right now. Please try again later.
          </p>
        ) : null}
      </section>
      <form className="inspectorLookup" onSubmit={submit}>
        <label htmlFor="reflection-id">Reflection ID (optional)</label>
        <div className="inspectorLookupRow">
          <input
            id="reflection-id"
            onChange={(event) => setReflectionId(event.target.value)}
            placeholder="Paste a Reflection UUID or select a row below"
            spellCheck={false}
            value={reflectionId}
          />
          <button disabled={loading} type="submit">{loading ? "Loading…" : "Inspect"}</button>
        </div>
      </form>
      {error ? <p className="inspectorError" role="alert">{error}</p> : null}
      {notice ? <p className="inspectorNotice" role="status">{notice}</p> : null}

      <section className="reflectionInspectorGrid">
        <div className="inspectorCard">
          <div className="inspectorHeading">
            <div>
              <h2>Logical Reflections</h2>
              <p>Default list shows one row per logical Reflection and its current pointer.</p>
            </div>
            {reflectionCursor ? <button className="inspectorSmallButton" onClick={() => void loadReflections(reflectionCursor, true)} type="button">Next page</button> : null}
          </div>
          <div className="inspectorTableWrap">
            <table className="inspectorTable">
              <caption>Current Reflection list</caption>
              <thead><tr><th>Scope</th><th>Window</th><th>Current</th><th>Action</th></tr></thead>
              <tbody>
                {reflections.map((item) => (
                  <tr key={item.reflectionId}>
                    <td><code>{item.scopeType}</code></td>
                    <td>{item.logicalDate ?? `${item.windowStartDate ?? "?"} → ${item.windowEndDate ?? "?"}`}</td>
                    <td><code>{item.current?.status ?? item.currentOutcome ?? "none"}</code></td>
                    <td><button className="inspectorSmallButton" onClick={() => { setReflectionId(item.reflectionId); void loadReflection(item.reflectionId); }} type="button">Trace</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {reflections.length === 0 ? <p className="inspectorMuted">No current logical Reflection rows.</p> : null}
        </div>

        {selected ? (
          <div className="inspectorCard">
            <div className="inspectorHeading">
              <div><h2>Reflection trace</h2><p><code>{selected.reflectionId}</code></p></div>
              <code>{selected.currentOutcome ?? "current-readable"}</code>
            </div>
            <dl className="inspectorFacts">
              <InspectorFact label="Scope">{selected.scopeType}</InspectorFact>
              <InspectorFact label="Window">{selected.logicalDate ?? `${selected.windowStartDate ?? "?"} → ${selected.windowEndDate ?? "?"}`}</InspectorFact>
              <InspectorFact label="Current version"><code>{selected.currentVersionId ?? "none"}</code></InspectorFact>
              <InspectorFact label="Weekly identity"><code>{selected.weekIdentifier ?? "—"}</code></InspectorFact>
            </dl>
            <div className="inspectorTableWrap">
              <table className="inspectorTable">
                <caption>Version history is folded until explicitly selected</caption>
                <thead><tr><th>Revision</th><th>Status</th><th>Content</th><th>Source</th><th>Action</th></tr></thead>
                <tbody>
                  {versions.map((version) => (
                    <tr key={version.versionId}>
                      <td>{version.revision}{version.current ? " (current)" : ""}</td>
                      <td><code>{version.status}</code></td>
                      <td><code>{version.contentState}</code></td>
                      <td>{version.sourceRevision} · <code>{version.locale}</code></td>
                      <td><button className="inspectorSmallButton" onClick={() => void loadVersion(selected, version)} type="button">Expand</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {versionCursor ? <button className="inspectorSmallButton" onClick={() => void loadMoreVersions(selected, versionCursor)} type="button">Next version page</button> : null}
            {selectedVersion ? <TraceDetails
              bioImpacts={bioImpacts}
              bioImpactCursors={bioImpactCursors}
              candidates={candidates}
              candidateCursor={candidateCursor}
              claims={claims}
              claimCursors={claimCursors}
              evidence={evidence}
              evidenceCursors={evidenceCursors}
              predecessors={predecessors}
              predecessorCursors={predecessorCursors}
              propositions={propositions}
              propositionCursors={propositionCursors}
              successors={successors}
              successorCursors={successorCursors}
              statementCursor={statementCursor}
              loadMoreCandidates={(cursor) => loadMoreCandidates(selected, selectedVersion, cursor)}
              loadMoreStatements={(cursor) => loadMoreStatements(selected, selectedVersion, cursor)}
              loadBioImpact={loadBioImpact}
              loadCandidateLineage={loadCandidateLineage}
              loadClaims={loadClaims}
              loadEvidence={loadEvidence}
              loadPropositions={loadPropositions}
              expandEvidence={expandEvidence}
              selectedVersion={selectedVersion}
              statements={statements}
            /> : null}
          </div>
        ) : null}
      </section>
    </div>
  );

  async function loadMoreVersions(reflection: ReflectionItem, cursor: string) {
    try {
      const result = await getJson<Page<VersionItem>>({
        cursor,
        ...(reflection.currentVersionId ? { expected_current_version_id: reflection.currentVersionId } : {}),
        layer: "versions",
        reflection_id: reflection.reflectionId,
      });
      setVersions((current) => [...current, ...result.items]);
      setVersionCursor(result.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The next version page could not be loaded.");
    }
  }
}

function TraceDetails(props: {
  bioImpacts: Record<string, BioItem[]>;
  bioImpactCursors: Record<string, string | null>;
  candidates: CandidateItem[];
  candidateCursor: string | null;
  claims: Record<string, ClaimItem[]>;
  claimCursors: Record<string, string | null>;
  evidence: Record<string, EvidenceItem[]>;
  evidenceCursors: Record<string, string | null>;
  expandEvidence(item: EvidenceItem): Promise<void>;
  loadBioImpact(claim: ClaimItem, cursor?: string | null, append?: boolean): Promise<void>;
  loadCandidateLineage(candidate: CandidateItem, direction: "predecessors" | "successors", cursor?: string | null, append?: boolean): Promise<void>;
  loadClaims(candidate: CandidateItem, cursor?: string | null, append?: boolean): Promise<void>;
  loadEvidence(proposition: PropositionItem, cursor?: string | null, append?: boolean): Promise<void>;
  loadMoreCandidates(cursor: string): Promise<void>;
  loadMoreStatements(cursor: string): Promise<void>;
  loadPropositions(statement: StatementItem, cursor?: string | null, append?: boolean): Promise<void>;
  predecessors: Record<string, CandidateLineageItem[]>;
  predecessorCursors: Record<string, string | null>;
  propositions: Record<string, PropositionItem[]>;
  propositionCursors: Record<string, string | null>;
  selectedVersion: VersionItem;
  statements: StatementItem[];
  statementCursor: string | null;
  successors: Record<string, CandidateLineageItem[]>;
  successorCursors: Record<string, string | null>;
}) {
  return (
    <div className="reflectionTrace">
      <div className="inspectorHeading"><div><h3>Version {props.selectedVersion.revision} trace</h3><p><code>{props.selectedVersion.versionId}</code> · {props.selectedVersion.status} · {props.selectedVersion.contentState}</p><p className="inspectorMuted">{props.selectedVersion.metadata.modelRole ?? "model role unavailable"} · {props.selectedVersion.metadata.modelConfigVersion ?? "model config unavailable"} · validation {props.selectedVersion.metadata.validationVerdict ?? "unavailable"} · policy {props.selectedVersion.metadata.validationPolicyVersion ?? "unavailable"} · findings {props.selectedVersion.metadata.validationBlockingFindingCodes.length}/{props.selectedVersion.metadata.validationAdvisoryFindingCodes.length} · coverage {props.selectedVersion.metadata.validationCoveredKeys.length}/{props.selectedVersion.metadata.validationUncoveredPlannedKeys.length}</p></div><code>{props.selectedVersion.promptVersion}</code></div>
      <div className="inspectorTableWrap">
        <table className="inspectorTable">
          <caption>Reflection statements and atomic propositions</caption>
          <thead><tr><th>Statement</th><th>Prose</th><th>Propositions</th></tr></thead>
          <tbody>
            {props.statements.map((statement) => (
              <tr key={statement.statementId}>
                <th scope="row"><code>{statement.statementKind}</code><br />#{statement.statementIndex}</th>
                <td>{statement.statementText ?? <span className="inspectorMuted">{statement.contentState}</span>}</td>
                <td>
                  <button className="inspectorSmallButton" onClick={() => void props.loadPropositions(statement)} type="button">Expand propositions</button>
                  {(props.propositions[statement.statementId] ?? []).map((proposition) => (
                    <div className="reflectionTraceItem" key={proposition.propositionId}>
                      <div><code>{proposition.propositionKind}</code> · {proposition.propositionText ?? proposition.contentState} · {proposition.epistemicRendering}</div>
                      <button className="inspectorSmallButton" onClick={() => void props.loadEvidence(proposition)} type="button">Evidence links</button>
                      {(props.evidence[proposition.propositionId] ?? []).map((item) => (
                        <div className="reflectionTraceItem" key={item.evidenceLinkId}>
                          <code>{item.sourceOutcome}</code> · {item.logicalDate ?? "—"} · {item.locale ?? "—"} · {item.locatorType}:{item.locatorKey}
                          <button className="inspectorSmallButton" disabled={item.sourceOutcome !== "available"} onClick={() => void props.expandEvidence(item)} type="button">Exact text</button>
                        </div>
                      ))}
                      {props.evidenceCursors[proposition.propositionId] ? <button className="inspectorSmallButton" onClick={() => void props.loadEvidence(proposition, props.evidenceCursors[proposition.propositionId], true)} type="button">Next Evidence page</button> : null}
                    </div>
                  ))}
                  {props.propositionCursors[statement.statementId] ? <button className="inspectorSmallButton" onClick={() => void props.loadPropositions(statement, props.propositionCursors[statement.statementId], true)} type="button">Next proposition page</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.statementCursor ? <button className="inspectorSmallButton" onClick={() => void props.loadMoreStatements(props.statementCursor!)} type="button">Next statement page</button> : null}
      <div className="inspectorTableWrap">
        <table className="inspectorTable">
          <caption>Candidate proposal lineage and deterministic disposition</caption>
          <thead><tr><th>Proposal</th><th>Candidate</th><th>Disposition</th><th>Trace</th></tr></thead>
          <tbody>
            {props.candidates.map((candidate) => (
              <tr key={candidate.proposalId}>
                <td><code>{candidate.proposalId}</code><br />{candidate.outcome}</td>
                <td>{candidate.candidateId ? <code>{candidate.candidateId}</code> : "Memory Candidate Proposal only"}</td>
                <td><code>{candidate.candidateStatus ?? candidate.contentState}</code>{candidate.dispositionReasonCode ? ` · ${candidate.dispositionReasonCode}` : ""}<br /><span className="inspectorMuted">created {candidate.createdAt} · Evidence {candidate.candidateEvidenceItemIds.length}</span>{candidate.reviewDueAt || candidate.registryReleaseDueAt || candidate.terminalContentExpiresAt ? <><br /><span className="inspectorMuted">deadline {candidate.reviewDueAt ?? candidate.registryReleaseDueAt ?? candidate.terminalContentExpiresAt}</span></> : null}</td>
                <td>{candidate.candidateId ? <>
                  <button className="inspectorSmallButton" onClick={() => void props.loadCandidateLineage(candidate, "predecessors")} type="button">Predecessor</button>
                  <button className="inspectorSmallButton" onClick={() => void props.loadCandidateLineage(candidate, "successors")} type="button">Successors</button>
                  {(props.predecessors[candidate.candidateId] ?? []).map((lineage) => <div className="reflectionTraceItem" key={`predecessor-${lineage.candidateId}`}><code>predecessor</code> · {lineage.candidateId} · {lineage.status ?? "unknown"}{lineage.contentPurged ? " · content_purged" : ""}{lineage.dispositionReasonCode ? ` · ${lineage.dispositionReasonCode}` : ""}</div>)}
                  {(props.successors[candidate.candidateId] ?? []).map((lineage) => <div className="reflectionTraceItem" key={`successor-${lineage.candidateId}`}><code>successor</code> · {lineage.candidateId} · {lineage.status ?? "unknown"}{lineage.contentPurged ? " · content_purged" : ""}{lineage.successorTrigger ? ` · ${lineage.successorTrigger}` : ""}</div>)}
                  {props.predecessorCursors[candidate.candidateId!] ? <button className="inspectorSmallButton" onClick={() => void props.loadCandidateLineage(candidate, "predecessors", props.predecessorCursors[candidate.candidateId!], true)} type="button">Next predecessor page</button> : null}
                  {props.successorCursors[candidate.candidateId!] ? <button className="inspectorSmallButton" onClick={() => void props.loadCandidateLineage(candidate, "successors", props.successorCursors[candidate.candidateId!], true)} type="button">Next successor page</button> : null}
                  <button className="inspectorSmallButton" onClick={() => void props.loadClaims(candidate)} type="button">Claim trace</button>
                  {(candidate.candidateId ? props.claims[candidate.candidateId] ?? [] : []).map((claim) => (
                    <div className="reflectionTraceItem" key={claim.diffId}>
                      <code>{claim.eligibility}</code> · {claim.outcome} · {claim.status ?? "no current Claim"}
                      {claim.claimVersionId ? <button className="inspectorSmallButton" onClick={() => void props.loadBioImpact(claim)} type="button">Bio impact</button> : null}
                      {(claim.claimVersionId ? props.bioImpacts[claim.claimVersionId] ?? [] : []).map((bio) => (
                          <div className="reflectionTraceItem" key={bio.bioVersionId}>
                            <code>{bio.status}</code> · {bio.current ? "current" : "history"} · {bio.linkRole}/{bio.supportStatus} · {bio.coverageDisposition ?? "no coverage unit"}
                          </div>
                        ))}
                      {claim.claimVersionId && props.bioImpactCursors[claim.claimVersionId] ? <button className="inspectorSmallButton" onClick={() => void props.loadBioImpact(claim, props.bioImpactCursors[claim.claimVersionId!], true)} type="button">Next Bio page</button> : null}
                    </div>
                  ))}
                  {props.claimCursors[candidate.candidateId!] ? <button className="inspectorSmallButton" onClick={() => void props.loadClaims(candidate, props.claimCursors[candidate.candidateId!], true)} type="button">Next Claim page</button> : null}
                </> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {props.candidateCursor ? <button className="inspectorSmallButton" onClick={() => void props.loadMoreCandidates(props.candidateCursor!)} type="button">Next candidate page</button> : null}
    </div>
  );
}

function InspectorFact(props: { children: React.ReactNode; label: string }) {
  return <div className="inspectorFact"><dt>{props.label}</dt><dd>{props.children}</dd></div>;
}
