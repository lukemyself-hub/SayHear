"use client";

import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

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

type ScopeFilter = "all" | "daily_session" | "date_range";

type SectionKey = "candidates" | "claimBio" | "statements" | "versions";

const API = "/api/internal/inspection/reflection";
const STEP_UP_API = "/api/internal/inspection/evidence-step-up";
const STEP_UP_CALLBACK_URL = "/internal/reflection-inspector";
const ROUTE = "/internal/reflection-inspector";

const SCOPE_FILTERS: readonly Readonly<{ label: string; value: ScopeFilter }>[] = [
  { label: "全部", value: "all" },
  { label: "Daily", value: "daily_session" },
  { label: "Weekly", value: "date_range" },
];

type StepUpStatus =
  | "idle"
  | "requesting"
  | "required"
  | "not-permitted"
  | "unavailable";

/**
 * A read against the reflection inspection endpoint failed. The status and the
 * typed `error` code are retained so the panel can distinguish a normal
 * not-found from the sensitive Evidence boundaries (capability, recent
 * step-up, access audit, recovery gate) that must fail closed.
 */
class InspectionRequestError extends Error {
  readonly code: string | null;
  readonly status: number;

  constructor(status: number, code: string | null) {
    super(inspectionErrorMessage(status, code));
    this.code = code;
    this.status = status;
  }
}

function inspectionErrorMessage(status: number, code: string | null): string {
  switch (code) {
    case "reflection_capability_required":
      return "This session does not have reflection_inspection:read.";
    case "recent_step_up_required":
      return "Opening the original words needs a recent verification. Verify again, then try once more.";
    case "evidence_access_audit_failed":
      return "The access audit could not be recorded, so the original words were withheld (503).";
    case "recovery_gate_closed":
      return "The recovery gate is closed, so this read is unavailable right now.";
    case "invalid_cursor":
      return "That page cursor is no longer valid. Reload the section to continue.";
    case "invalid_limit":
      return "The requested page size is not allowed.";
    case "unauthorized":
      return "Your session is no longer signed in.";
    default:
      return `The inspection could not be loaded (${status}).`;
  }
}

/**
 * Boundary failures that must drop any protected Evidence text already on
 * screen: authentication, capability/step-up, access-audit and recovery-gate
 * errors all mean the displayed original words are no longer trustworthy.
 */
function isVerificationBoundary(error: unknown): boolean {
  return (
    error instanceof InspectionRequestError &&
    (error.status === 401 || error.status === 403 || error.status === 503)
  );
}

async function getJson<T>(params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(params);
  const response = await fetch(`${API}?${query.toString()}`, {
    cache: "no-store",
    method: "GET",
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const code =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : null;
    throw new InspectionRequestError(response.status, code);
  }
  return body as T;
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

function normalizeId(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function scopeTypeLabel(scopeType: string): string {
  if (scopeType === "daily_session") {
    return "Daily";
  }
  if (scopeType === "date_range") {
    return "Weekly";
  }
  return scopeType;
}

function reflectionWindowLabel(
  item: Pick<
    ReflectionItem,
    "logicalDate" | "windowStartDate" | "windowEndDate"
  >,
): string {
  if (item.logicalDate) {
    return item.logicalDate;
  }
  if (item.windowStartDate || item.windowEndDate) {
    return `${item.windowStartDate ?? "?"} → ${item.windowEndDate ?? "?"}`;
  }
  return "—";
}

function reflectionHref(reflectionId: string): string {
  const id = normalizeId(reflectionId);
  return id
    ? `${ROUTE}?reflection_id=${encodeURIComponent(id)}`
    : ROUTE;
}

export function ReflectionInspector(props: { initialReflectionId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedId = normalizeId(searchParams.get("reflection_id"));

  const [reflectionIdInput, setReflectionIdInput] = useState(
    props.initialReflectionId,
  );
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
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
  const [evidenceText, setEvidenceText] = useState<Record<string, string>>({});
  const [candidates, setCandidates] = useState<CandidateItem[]>([]);
  const [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [candidatesLoadedForVersionId, setCandidatesLoadedForVersionId] = useState<string | null>(null);
  const [claims, setClaims] = useState<Record<string, ClaimItem[]>>({});
  const [claimCursors, setClaimCursors] = useState<Record<string, string | null>>({});
  const [bioImpacts, setBioImpacts] = useState<Record<string, BioItem[]>>({});
  const [bioImpactCursors, setBioImpactCursors] = useState<Record<string, string | null>>({});
  const [predecessors, setPredecessors] = useState<Record<string, CandidateLineageItem[]>>({});
  const [predecessorCursors, setPredecessorCursors] = useState<Record<string, string | null>>({});
  const [successors, setSuccessors] = useState<Record<string, CandidateLineageItem[]>>({});
  const [successorCursors, setSuccessorCursors] = useState<Record<string, string | null>>({});
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    candidates: false,
    claimBio: false,
    statements: true,
    versions: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sensitiveError, setSensitiveError] = useState<string | null>(null);
  const [stepUpStatus, setStepUpStatus] = useState<StepUpStatus>("idle");
  // Monotonic tokens let a newer URL selection or scope change discard an
  // in-flight response instead of letting it overwrite the current view.
  const detailTokenRef = useRef(0);
  const listTokenRef = useRef(0);
  const activeReflectionIdRef = useRef("");
  const activeVersionIdRef = useRef("");

  function clearProtectedEvidence(): void {
    setEvidenceText((current) =>
      Object.keys(current).length === 0 ? current : {},
    );
  }

  function reportLoadError(loadError: unknown, fallback: string): void {
    if (isVerificationBoundary(loadError)) {
      clearProtectedEvidence();
      if (
        loadError instanceof InspectionRequestError &&
        loadError.code === "recent_step_up_required"
      ) {
        setStepUpStatus("required");
      }
    }
    setError(
      loadError instanceof Error ? loadError.message : fallback,
    );
  }

  function resetTrace(): void {
    activeVersionIdRef.current = "";
    setCandidates([]);
    setCandidateCursor(null);
    setCandidatesLoadedForVersionId(null);
    setClaims({});
    setClaimCursors({});
    setBioImpacts({});
    setBioImpactCursors({});
    setPredecessors({});
    setPredecessorCursors({});
    setSuccessors({});
    setSuccessorCursors({});
    setPropositions({});
    setPropositionCursors({});
    setEvidence({});
    setEvidenceCursors({});
    clearProtectedEvidence();
  }

  function resetSelection(): void {
    activeReflectionIdRef.current = "";
    activeVersionIdRef.current = "";
    setSelected(null);
    setVersions([]);
    setVersionCursor(null);
    setSelectedVersion(null);
    setStatements([]);
    setStatementCursor(null);
    resetTrace();
  }

  async function loadReflections(
    filter: ScopeFilter = scopeFilter,
    cursor: string | null = null,
    append = false,
  ) {
    const token = ++listTokenRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await getJson<Page<ReflectionItem>>({
        ...(cursor ? { cursor } : {}),
        layer: "reflections",
        ...(filter === "all" ? {} : { scope_type: filter }),
      });
      if (token !== listTokenRef.current) {
        return;
      }
      setReflections((current) =>
        append ? [...current, ...result.items] : [...result.items],
      );
      setReflectionCursor(result.nextCursor);
    } catch (loadError) {
      if (token === listTokenRef.current) {
        reportLoadError(loadError, "The reflections could not be loaded.");
      }
    } finally {
      if (token === listTokenRef.current) {
        setLoading(false);
      }
    }
  }

  async function loadReflection(requestedReflectionId: string) {
    const normalizedId = normalizeId(requestedReflectionId);
    if (!normalizedId) {
      setError("Enter a Reflection ID or select a row.");
      return;
    }
    const token = ++detailTokenRef.current;
    setLoading(true);
    setError(null);
    setNotice(null);
    setSensitiveError(null);
    setReflectionIdInput(normalizedId);
    try {
      const result = await getJson<ReflectionItem | ReflectionReadOutcome>({
        layer: "reflections",
        reflection_id: normalizedId,
      });
      if (token !== detailTokenRef.current) {
        return;
      }
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
        resetSelection();
        setNotice(`Reflection returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
        return;
      }
      setSelected(reflection);
      const versionResult = await getJson<Page<VersionItem> | { outcome: string }>({
        ...(reflection.currentVersionId
          ? { expected_current_version_id: reflection.currentVersionId }
          : {}),
        layer: "versions",
        reflection_id: reflection.reflectionId,
      });
      if (token !== detailTokenRef.current) {
        return;
      }
      if (!isPage<VersionItem>(versionResult)) {
        resetTrace();
        setVersions([]);
        setVersionCursor(null);
        setSelectedVersion(null);
        setNotice(`Version history returned typed outcome: ${outcomeOf(versionResult) ?? "unknown"}.`);
        return;
      }
      setVersions([...versionResult.items]);
      setVersionCursor(versionResult.nextCursor);
      const current =
        versionResult.items.find((version) => version.current) ?? null;
      if (current) {
        await applyVersion(reflection, current, token);
      } else {
        resetTrace();
        setSelectedVersion(null);
        setStatements([]);
        setStatementCursor(null);
        setNotice("This Reflection has no current readable version.");
      }
    } catch (loadError) {
      if (token === detailTokenRef.current) {
        reportLoadError(loadError, "The reflection could not be loaded.");
      }
    } finally {
      if (token === detailTokenRef.current) {
        setLoading(false);
      }
    }
  }

  /**
   * Selects one ReflectionVersion and loads only its primary statement prose.
   * Candidate disposition and Claim/Bio lineage stay unloaded until the user
   * explicitly opens those sections, so a collapsed panel never prefetches
   * low-frequency or sensitive data.
   */
  async function applyVersion(
    reflection: ReflectionItem,
    version: VersionItem,
    token?: number,
  ) {
    activeReflectionIdRef.current = reflection.reflectionId;
    activeVersionIdRef.current = version.versionId;
    setSelected(reflection);
    setSelectedVersion(version);
    setCandidates([]);
    setCandidateCursor(null);
    setCandidatesLoadedForVersionId(null);
    setClaims({});
    setClaimCursors({});
    setBioImpacts({});
    setBioImpactCursors({});
    setPredecessors({});
    setPredecessorCursors({});
    setSuccessors({});
    setSuccessorCursors({});
    setPropositions({});
    setPropositionCursors({});
    setEvidence({});
    setEvidenceCursors({});
    clearProtectedEvidence();
    setOpenSections((current) => ({
      ...current,
      candidates: false,
      claimBio: false,
    }));
    setStatements([]);
    setStatementCursor(null);
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const statementResult = await getJson<Page<StatementItem> | { outcome: string }>({
        layer: "statements",
        reflection_version_id: version.versionId,
        ...(reflection.currentVersionId
          ? { expected_current_version_id: reflection.currentVersionId }
          : {}),
      });
      if (
        (token !== undefined && token !== detailTokenRef.current) ||
        activeVersionIdRef.current !== version.versionId
      ) {
        return;
      }
      if (isPage<StatementItem>(statementResult)) {
        setStatements([...statementResult.items]);
        setStatementCursor(statementResult.nextCursor);
      } else {
        setStatements([]);
        setStatementCursor(null);
        setNotice(`Statements returned typed outcome: ${outcomeOf(statementResult) ?? "unknown"}.`);
      }
    } catch (loadError) {
      reportLoadError(loadError, "The reflection statements could not be loaded.");
    } finally {
      if (token === undefined || token === detailTokenRef.current) {
        setLoading(false);
      }
    }
  }

  async function loadCandidates(reflection: ReflectionItem, version: VersionItem) {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const candidateResult = await getJson<Page<CandidateItem> | { outcome: string }>({
        layer: "candidates",
        reflection_version_id: version.versionId,
        ...(reflection.currentVersionId
          ? { expected_current_version_id: reflection.currentVersionId }
          : {}),
      });
      if (activeVersionIdRef.current !== version.versionId) {
        return;
      }
      if (isPage<CandidateItem>(candidateResult)) {
        setCandidates([...candidateResult.items]);
        setCandidateCursor(candidateResult.nextCursor);
        setCandidatesLoadedForVersionId(version.versionId);
      } else {
        setCandidates([]);
        setCandidateCursor(null);
        setNotice(`Candidate disposition returned typed outcome: ${outcomeOf(candidateResult) ?? "unknown"}.`);
      }
    } catch (loadError) {
      reportLoadError(loadError, "The candidate disposition could not be loaded.");
    } finally {
      if (activeVersionIdRef.current === version.versionId) {
        setLoading(false);
      }
    }
  }

  async function loadMoreStatements(
    reflection: ReflectionItem,
    version: VersionItem,
    cursor: string,
  ) {
    try {
      const result = await getJson<Page<StatementItem> | { outcome: string }>({
        cursor,
        layer: "statements",
        reflection_version_id: version.versionId,
        ...(reflection.currentVersionId
          ? { expected_current_version_id: reflection.currentVersionId }
          : {}),
      });
      if (activeVersionIdRef.current !== version.versionId) {
        return;
      }
      if (!isPage<StatementItem>(result)) {
        setStatementCursor(null);
        setNotice(`Statements returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
        return;
      }
      setStatements((current) => [...current, ...result.items]);
      setStatementCursor(result.nextCursor);
    } catch (loadError) {
      reportLoadError(loadError, "The next statement page could not be loaded.");
    }
  }

  async function loadMoreCandidates(
    reflection: ReflectionItem,
    version: VersionItem,
    cursor: string,
  ) {
    try {
      const result = await getJson<Page<CandidateItem> | { outcome: string }>({
        cursor,
        layer: "candidates",
        reflection_version_id: version.versionId,
        ...(reflection.currentVersionId
          ? { expected_current_version_id: reflection.currentVersionId }
          : {}),
      });
      if (activeVersionIdRef.current !== version.versionId) {
        return;
      }
      if (!isPage<CandidateItem>(result)) {
        setCandidateCursor(null);
        setNotice(`Candidates returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
        return;
      }
      setCandidates((current) => [...current, ...result.items]);
      setCandidateCursor(result.nextCursor);
    } catch (loadError) {
      reportLoadError(loadError, "The next candidate page could not be loaded.");
    }
  }

  async function loadMoreVersions(reflection: ReflectionItem, cursor: string) {
    try {
      const result = await getJson<Page<VersionItem>>({
        cursor,
        ...(reflection.currentVersionId
          ? { expected_current_version_id: reflection.currentVersionId }
          : {}),
        layer: "versions",
        reflection_id: reflection.reflectionId,
      });
      if (activeReflectionIdRef.current !== reflection.reflectionId) {
        return;
      }
      setVersions((current) => [...current, ...result.items]);
      setVersionCursor(result.nextCursor);
    } catch (loadError) {
      reportLoadError(loadError, "The next version page could not be loaded.");
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
        ...(selected?.currentVersionId
          ? { expected_current_version_id: selected.currentVersionId }
          : {}),
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
        [statement.statementId]: isPage<PropositionItem>(result)
          ? result.nextCursor
          : null,
      }));
      if (!isPage<PropositionItem>(result)) {
        setNotice(`Propositions returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
      }
    } catch (loadError) {
      reportLoadError(loadError, "The propositions could not be loaded.");
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
        ...(selected?.currentVersionId
          ? { expected_current_version_id: selected.currentVersionId }
          : {}),
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
        [proposition.propositionId]: isPage<EvidenceItem>(result)
          ? result.nextCursor
          : null,
      }));
      if (!isPage<EvidenceItem>(result)) {
        setNotice(`Evidence links returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
      }
    } catch (loadError) {
      reportLoadError(loadError, "The Evidence links could not be loaded.");
    }
  }

  /**
   * Explicit user action only. Opening the exact user words is the sensitive
   * boundary: it needs the `conversation_content:read` capability, a recent
   * step-up and a committed access audit. A failure clears any protected text
   * already displayed so an expired grant cannot leave stale content visible.
   */
  async function expandEvidence(item: EvidenceItem) {
    setError(null);
    setNotice(null);
    setSensitiveError(null);
    try {
      const result = await getJson<{
        outcome: string;
        reason?: string;
        text?: string;
      }>({
        evidence_item_id: item.evidenceItemId,
        layer: "evidence_content",
      });
      if (result.outcome === "allowed" && typeof result.text === "string") {
        setStepUpStatus("idle");
        setEvidenceText((current) => ({
          ...current,
          [item.evidenceLinkId]: result.text as string,
        }));
        return;
      }
      clearProtectedEvidence();
      if (result.outcome === "denied") {
        if (result.reason === "recent_step_up_required") {
          setStepUpStatus("required");
          setSensitiveError(
            "Verification expired. The original words were cleared; verify again to reopen them.",
          );
        } else {
          setSensitiveError(
            "This session is not allowed to open the original words.",
          );
        }
        return;
      }
      setSensitiveError(
        `The original words are no longer available (${result.outcome}).`,
      );
    } catch (loadError) {
      clearProtectedEvidence();
      if (
        loadError instanceof InspectionRequestError &&
        loadError.code === "recent_step_up_required"
      ) {
        setStepUpStatus("required");
      }
      setSensitiveError(
        loadError instanceof Error
          ? loadError.message
          : "The Evidence could not be expanded.",
      );
    }
  }

  function hideEvidence(evidenceLinkId: string): void {
    setEvidenceText((current) => {
      if (!(evidenceLinkId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[evidenceLinkId];
      return next;
    });
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
        setStepUpStatus(response.status === 403 ? "not-permitted" : "unavailable");
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
    candidateId: string,
    cursor: string | null = null,
    append = false,
  ) {
    if (!candidateId) {
      setNotice("This proposal has no persisted MemoryCandidate lineage.");
      return;
    }
    setError(null);
    try {
      const result = await getJson<Page<ClaimItem> | { outcome: string }>({
        ...(cursor ? { cursor } : {}),
        candidate_id: candidateId,
        layer: "claims",
      });
      setClaims((current) => ({
        ...current,
        [candidateId]: isPage<ClaimItem>(result)
          ? append
            ? [...(current[candidateId] ?? []), ...result.items]
            : [...result.items]
          : append
            ? current[candidateId] ?? []
            : [],
      }));
      setClaimCursors((current) => ({
        ...current,
        [candidateId]: isPage<ClaimItem>(result) ? result.nextCursor : null,
      }));
      if (!isPage<ClaimItem>(result)) {
        setNotice(`Claim trace returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
      }
    } catch (loadError) {
      reportLoadError(loadError, "The Claim trace could not be loaded.");
    }
  }

  async function loadCandidateLineage(
    candidate: CandidateItem,
    direction: "predecessors" | "successors",
    cursor: string | null = null,
    append = false,
  ) {
    const candidateId = candidate.candidateId;
    if (!candidateId) {
      setNotice("This proposal has no persisted MemoryCandidate lineage.");
      return;
    }
    setError(null);
    try {
      const result = await getJson<Page<CandidateLineageItem> | { outcome: string }>({
        ...(cursor ? { cursor } : {}),
        candidate_id: candidateId,
        layer: direction,
      });
      if (direction === "predecessors") {
        setPredecessors((current) => ({
          ...current,
          [candidateId]: isPage<CandidateLineageItem>(result)
            ? append
              ? [...(current[candidateId] ?? []), ...result.items]
              : [...result.items]
            : append
              ? current[candidateId] ?? []
              : [],
        }));
        setPredecessorCursors((current) => ({
          ...current,
          [candidateId]: isPage<CandidateLineageItem>(result)
            ? result.nextCursor
            : null,
        }));
      } else {
        setSuccessors((current) => ({
          ...current,
          [candidateId]: isPage<CandidateLineageItem>(result)
            ? append
              ? [...(current[candidateId] ?? []), ...result.items]
              : [...result.items]
            : append
              ? current[candidateId] ?? []
              : [],
        }));
        setSuccessorCursors((current) => ({
          ...current,
          [candidateId]: isPage<CandidateLineageItem>(result)
            ? result.nextCursor
            : null,
        }));
      }
      if (!isPage<CandidateLineageItem>(result)) {
        setNotice(`${direction} returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
      }
    } catch (loadError) {
      reportLoadError(
        loadError,
        `The candidate ${direction} could not be loaded.`,
      );
    }
  }

  async function loadBioImpact(
    claim: ClaimItem,
    cursor: string | null = null,
    append = false,
  ) {
    const claimVersionId = claim.claimVersionId;
    if (!claimVersionId) {
      setNotice("No explicit ClaimVersion link was recorded.");
      return;
    }
    setError(null);
    try {
      const result = await getJson<Page<BioItem> | { outcome: string }>({
        ...(cursor ? { cursor } : {}),
        layer: "bio_impact",
        memory_claim_version_id: claimVersionId,
      });
      setBioImpacts((current) => ({
        ...current,
        [claimVersionId]: isPage<BioItem>(result)
          ? append
            ? [...(current[claimVersionId] ?? []), ...result.items]
            : [...result.items]
          : append
            ? current[claimVersionId] ?? []
            : [],
      }));
      setBioImpactCursors((current) => ({
        ...current,
        [claimVersionId]: isPage<BioItem>(result) ? result.nextCursor : null,
      }));
      if (!isPage<BioItem>(result)) {
        setNotice(`Bio impact returned typed outcome: ${outcomeOf(result) ?? "unknown"}.`);
      }
    } catch (loadError) {
      reportLoadError(loadError, "The Bio impact could not be loaded.");
    }
  }

  useEffect(() => {
    void loadReflections("all");
    // The list loads once on mount; scope changes reload it explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!requestedId) {
      resetSelection();
      return;
    }
    setReflectionIdInput(requestedId);
    void loadReflection(requestedId);
    // Selection is driven by the URL; every history entry reloads its target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedId]);

  function navigateToReflection(reflectionId: string): void {
    const id = normalizeId(reflectionId);
    if (!id) {
      return;
    }
    setReflectionIdInput(id);
    router.push(reflectionHref(id));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = normalizeId(reflectionIdInput);
    if (!id) {
      setError("Enter a Reflection ID or select a row.");
      return;
    }
    if (id === requestedId) {
      void loadReflection(id);
      return;
    }
    navigateToReflection(id);
  }

  function changeScope(filter: ScopeFilter): void {
    if (filter === scopeFilter) {
      return;
    }
    setScopeFilter(filter);
    setReflections([]);
    setReflectionCursor(null);
    void loadReflections(filter);
  }

  function toggleSection(key: SectionKey, onOpen?: () => void): void {
    const next = !openSections[key];
    setOpenSections((current) => ({ ...current, [key]: next }));
    if (next) {
      onOpen?.();
    }
  }

  function toggleCandidates(): void {
    toggleSection("candidates", () => {
      if (
        selected &&
        selectedVersion &&
        candidatesLoadedForVersionId !== selectedVersion.versionId
      ) {
        void loadCandidates(selected, selectedVersion);
      }
    });
  }

  return (
    <div className="inspectorPage">
      <h1>Reflection Inspector</h1>
      <p className="lede">
        Read-only trace from the current Daily or Weekly Reflection through its
        statements, exact Evidence links, Candidate disposition, Claim
        eligibility, and Bio impact. Reflection prose needs the owner-scoped
        reflection capability; opening the user&apos;s original words is a
        separate sensitive read that needs a recent verification.
      </p>

      <section className="inspectorCard reflectionSensitiveCard">
        <div className="inspectorHeading">
          <div>
            <h2>Exact Evidence access</h2>
            <p>
              Opening the user&apos;s original words needs a recent
              verification, separate from Reflection prose. Collapsed panels
              never prefetch it; it is fetched only when you ask for one
              excerpt.
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
        {stepUpStatus === "required" ? (
          <p className="inspectorError" role="alert">
            Your verification expired. Verify again, then reopen the excerpt.
          </p>
        ) : null}
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
            onChange={(event) => setReflectionIdInput(event.target.value)}
            placeholder="Paste a Reflection UUID or select a row below"
            spellCheck={false}
            value={reflectionIdInput}
          />
          <button disabled={loading} type="submit">
            {loading ? "Loading…" : "Inspect"}
          </button>
        </div>
      </form>
      {error ? <p className="inspectorError" role="alert">{error}</p> : null}
      {notice ? <p className="inspectorNotice" role="status">{notice}</p> : null}

      <div className="reflectionInspectorGrid">
        <section className="inspectorCard" aria-labelledby="reflection-list-heading">
          <div className="inspectorHeading">
            <div>
              <h2 id="reflection-list-heading">Daily / Weekly Reflections</h2>
              <p>
                One row per logical Reflection and its current pointer. Choose a
                scope, then open a row to trace it.
              </p>
            </div>
            {reflectionCursor ? (
              <button
                className="inspectorSmallButton"
                onClick={() => void loadReflections(scopeFilter, reflectionCursor, true)}
                type="button"
              >
                加载更多日期
              </button>
            ) : null}
          </div>
          <div
            aria-label="Reflection 范围"
            className="reflectionScopeSwitch"
            role="group"
          >
            {SCOPE_FILTERS.map((filter) => (
              <button
                aria-pressed={scopeFilter === filter.value}
                key={filter.value}
                onClick={() => changeScope(filter.value)}
                type="button"
              >
                {filter.label}
              </button>
            ))}
          </div>
          <div className="inspectorTableWrap">
            <table className="inspectorTable">
              <caption>Current Reflection list</caption>
              <thead>
                <tr>
                  <th scope="col">Scope</th>
                  <th scope="col">Window</th>
                  <th scope="col">Current</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {reflections.map((item) => (
                  <tr key={item.reflectionId}>
                    <td>
                      <code>{scopeTypeLabel(item.scopeType)}</code>
                      <br />
                      <span className="inspectorMuted">{item.scopeType}</span>
                    </td>
                    <td>{reflectionWindowLabel(item)}</td>
                    <td>
                      <code>{item.current?.status ?? item.currentOutcome ?? "none"}</code>
                    </td>
                    <td>
                      <button
                        className="inspectorSmallButton"
                        onClick={() => navigateToReflection(item.reflectionId)}
                        type="button"
                      >
                        Trace
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {reflections.length === 0 ? (
            <p className="inspectorMuted">No current logical Reflection rows.</p>
          ) : null}
        </section>

        {selected ? (
          <section className="inspectorCard" aria-labelledby="reflection-trace-heading">
            <div className="inspectorHeading">
              <div>
                <h2 id="reflection-trace-heading">Reflection trace</h2>
                <p>
                  <code>{selected.reflectionId}</code>
                </p>
              </div>
              <code>{selected.currentOutcome ?? "current-readable"}</code>
            </div>
            <dl className="inspectorFacts">
              <InspectorFact label="Scope">
                {scopeTypeLabel(selected.scopeType)}
              </InspectorFact>
              <InspectorFact label="Window">
                {reflectionWindowLabel(selected)}
              </InspectorFact>
              <InspectorFact label="Current version">
                <code>{selected.currentVersionId ?? "none"}</code>
              </InspectorFact>
              <InspectorFact label="Weekly identity">
                <code>{selected.weekIdentifier ?? "—"}</code>
              </InspectorFact>
            </dl>
            {selected.dailySessionId ? (
              <p className="inspectorMuted">
                Daily Session <code>{selected.dailySessionId}</code>
              </p>
            ) : null}

            <InspectorDisclosure
              bodyId="reflection-section-versions"
              onToggle={() => toggleSection("versions")}
              open={openSections.versions}
              summary={`${versions.length} version${versions.length === 1 ? "" : "s"}`}
              title="版本历史与元信息"
            >
              <div className="inspectorTableWrap">
                <table className="inspectorTable">
                  <caption>Version history</caption>
                  <thead>
                    <tr>
                      <th scope="col">Revision</th>
                      <th scope="col">Status</th>
                      <th scope="col">Content</th>
                      <th scope="col">Source</th>
                      <th scope="col">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((version) => (
                      <tr key={version.versionId}>
                        <td>
                          {version.revision}
                          {version.current ? " (current)" : ""}
                        </td>
                        <td>
                          <code>{version.status}</code>
                        </td>
                        <td>
                          <code>{version.contentState}</code>
                        </td>
                        <td>
                          {version.sourceRevision} · <code>{version.locale}</code>
                        </td>
                        <td>
                          <button
                            className="inspectorSmallButton"
                            onClick={() => {
                              if (selected) {
                                void applyVersion(selected, version);
                              }
                            }}
                            type="button"
                          >
                            {selectedVersion?.versionId === version.versionId
                              ? "Selected"
                              : "查看此版本"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {versionCursor && selected ? (
                <button
                  className="inspectorSmallButton"
                  onClick={() => void loadMoreVersions(selected, versionCursor)}
                  type="button"
                >
                  加载更多版本
                </button>
              ) : null}
              {selectedVersion ? (
                <VersionMetadata version={selectedVersion} />
              ) : null}
            </InspectorDisclosure>

            <InspectorDisclosure
              bodyId="reflection-section-statements"
              onToggle={() => toggleSection("statements")}
              open={openSections.statements}
              summary={
                selectedVersion
                  ? `v${selectedVersion.revision} · ${selectedVersion.status}`
                  : "no version"
              }
              title="Statement 与 Evidence lineage"
            >
              {selectedVersion ? (
                <>
                  {sensitiveError ? (
                    <p className="inspectorError" role="alert">
                      {sensitiveError}
                    </p>
                  ) : null}
                  {statements.length === 0 ? (
                    <p className="inspectorMuted">
                      This version has no readable statements.
                    </p>
                  ) : null}
                  {statements.map((statement) => (
                    <div className="reflectionStatement" key={statement.statementId}>
                      <p className="reflectionStatementMeta">
                        <code>{statement.statementKind}</code> · #
                        {statement.statementIndex} ·{" "}
                        <code>{statement.contentState}</code>
                      </p>
                      {statement.statementText ? (
                        <p className="reflectionStatementText">
                          {statement.statementText}
                        </p>
                      ) : (
                        <p className="inspectorMuted">
                          Statement content {statement.contentState}.
                        </p>
                      )}
                      <button
                        className="inspectorSmallButton"
                        onClick={() => void loadPropositions(statement)}
                        type="button"
                      >
                        展开 propositions
                      </button>
                      {(propositions[statement.statementId] ?? []).map((proposition) => (
                        <div className="reflectionTraceItem" key={proposition.propositionId}>
                          <div>
                            <code>{proposition.propositionKind}</code> ·{" "}
                            {proposition.propositionText ?? proposition.contentState} ·{" "}
                            {proposition.epistemicRendering}
                          </div>
                          <button
                            className="inspectorSmallButton"
                            onClick={() => void loadEvidence(proposition)}
                            type="button"
                          >
                            Evidence 链接
                          </button>
                          {(evidence[proposition.propositionId] ?? []).map((item) => (
                            <div className="reflectionTraceItem" key={item.evidenceLinkId}>
                              <div>
                                <code>{item.sourceOutcome}</code> ·{" "}
                                {item.logicalDate ?? "—"} · {item.locale ?? "—"} ·{" "}
                                {item.locatorType}:{item.locatorKey}
                              </div>
                              {evidenceText[item.evidenceLinkId] ? (
                                <>
                                  <p className="reflectionEvidenceText" role="status">
                                    {evidenceText[item.evidenceLinkId]}
                                  </p>
                                  <button
                                    className="inspectorSmallButton"
                                    onClick={() => hideEvidence(item.evidenceLinkId)}
                                    type="button"
                                  >
                                    收起原话
                                  </button>
                                </>
                              ) : (
                                <button
                                  className="inspectorSmallButton"
                                  disabled={item.sourceOutcome !== "available"}
                                  onClick={() => void expandEvidence(item)}
                                  type="button"
                                >
                                  查看原话（需验证）
                                </button>
                              )}
                            </div>
                          ))}
                          {evidenceCursors[proposition.propositionId] ? (
                            <button
                              className="inspectorSmallButton"
                              onClick={() =>
                                void loadEvidence(
                                  proposition,
                                  evidenceCursors[proposition.propositionId] ?? null,
                                  true,
                                )
                              }
                              type="button"
                            >
                              加载更多 Evidence
                            </button>
                          ) : null}
                        </div>
                      ))}
                      {propositionCursors[statement.statementId] ? (
                        <button
                          className="inspectorSmallButton"
                          onClick={() =>
                            void loadPropositions(
                              statement,
                              propositionCursors[statement.statementId] ?? null,
                              true,
                            )
                          }
                          type="button"
                        >
                          加载更多 propositions
                        </button>
                      ) : null}
                    </div>
                  ))}
                  {statementCursor ? (
                    <button
                      className="inspectorSmallButton"
                      onClick={() => {
                        if (selected && selectedVersion) {
                          void loadMoreStatements(
                            selected,
                            selectedVersion,
                            statementCursor,
                          );
                        }
                      }}
                      type="button"
                    >
                      加载更多 Statements
                    </button>
                  ) : null}
                </>
              ) : (
                <p className="inspectorMuted">
                  No current version is selected, so there is no statement prose
                  to show.
                </p>
              )}
            </InspectorDisclosure>

            <InspectorDisclosure
              bodyId="reflection-section-candidates"
              onToggle={toggleCandidates}
              open={openSections.candidates}
              summary={
                candidatesLoadedForVersionId
                  ? `${candidates.length} proposal${candidates.length === 1 ? "" : "s"}`
                  : "按需加载"
              }
              title="Candidate disposition"
            >
              {selectedVersion ? (
                <>
                  <div className="inspectorTableWrap">
                    <table className="inspectorTable">
                      <caption>
                        Candidate proposal lineage and deterministic disposition
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Proposal</th>
                          <th scope="col">Candidate</th>
                          <th scope="col">Disposition</th>
                          <th scope="col">Lineage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {candidates.map((candidate) => (
                          <tr key={candidate.proposalId}>
                            <td>
                              <code>{candidate.proposalId}</code>
                              <br />
                              {candidate.outcome}
                            </td>
                            <td>
                              {candidate.candidateId ? (
                                <code>{candidate.candidateId}</code>
                              ) : (
                                "Memory Candidate Proposal only"
                              )}
                            </td>
                            <td>
                              <code>
                                {candidate.candidateStatus ?? candidate.contentState}
                              </code>
                              {candidate.dispositionReasonCode
                                ? ` · ${candidate.dispositionReasonCode}`
                                : ""}
                              <br />
                              <span className="inspectorMuted">
                                created {candidate.createdAt} · Evidence{" "}
                                {candidate.candidateEvidenceItemIds.length}
                              </span>
                              {candidate.reviewDueAt ||
                              candidate.registryReleaseDueAt ||
                              candidate.terminalContentExpiresAt ? (
                                <>
                                  <br />
                                  <span className="inspectorMuted">
                                    deadline{" "}
                                    {candidate.reviewDueAt ??
                                      candidate.registryReleaseDueAt ??
                                      candidate.terminalContentExpiresAt}
                                  </span>
                                </>
                              ) : null}
                            </td>
                            <td>
                              {candidate.candidateId ? (
                                <>
                                  <button
                                    className="inspectorSmallButton"
                                    onClick={() =>
                                      void loadCandidateLineage(
                                        candidate,
                                        "predecessors",
                                      )
                                    }
                                    type="button"
                                  >
                                    展开 Predecessors
                                  </button>
                                  <button
                                    className="inspectorSmallButton"
                                    onClick={() =>
                                      void loadCandidateLineage(
                                        candidate,
                                        "successors",
                                      )
                                    }
                                    type="button"
                                  >
                                    展开 Successors
                                  </button>
                                  {(predecessors[candidate.candidateId] ?? []).map(
                                    (lineage) => (
                                      <div
                                        className="reflectionTraceItem"
                                        key={`predecessor-${lineage.candidateId}`}
                                      >
                                        <code>predecessor</code> ·{" "}
                                        {lineage.candidateId} ·{" "}
                                        {lineage.status ?? "unknown"}
                                        {lineage.contentPurged ? " · content_purged" : ""}
                                        {lineage.dispositionReasonCode
                                          ? ` · ${lineage.dispositionReasonCode}`
                                          : ""}
                                      </div>
                                    ),
                                  )}
                                  {(successors[candidate.candidateId] ?? []).map(
                                    (lineage) => (
                                      <div
                                        className="reflectionTraceItem"
                                        key={`successor-${lineage.candidateId}`}
                                      >
                                        <code>successor</code> · {lineage.candidateId} ·{" "}
                                        {lineage.status ?? "unknown"}
                                        {lineage.contentPurged ? " · content_purged" : ""}
                                        {lineage.successorTrigger
                                          ? ` · ${lineage.successorTrigger}`
                                          : ""}
                                      </div>
                                    ),
                                  )}
                                  {predecessorCursors[candidate.candidateId] ? (
                                    <button
                                      className="inspectorSmallButton"
                                      onClick={() =>
                                        void loadCandidateLineage(
                                          candidate,
                                          "predecessors",
                                          predecessorCursors[candidate.candidateId as string] ??
                                            null,
                                          true,
                                        )
                                      }
                                      type="button"
                                    >
                                      加载更多 Predecessors
                                    </button>
                                  ) : null}
                                  {successorCursors[candidate.candidateId] ? (
                                    <button
                                      className="inspectorSmallButton"
                                      onClick={() =>
                                        void loadCandidateLineage(
                                          candidate,
                                          "successors",
                                          successorCursors[candidate.candidateId as string] ??
                                            null,
                                          true,
                                        )
                                      }
                                      type="button"
                                    >
                                      加载更多 Successors
                                    </button>
                                  ) : null}
                                  <button
                                    className="inspectorSmallButton"
                                    onClick={() =>
                                      void loadClaims(candidate.candidateId as string)
                                    }
                                    type="button"
                                  >
                                    Claim / Bio trace
                                  </button>
                                </>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {candidateCursor && selected && selectedVersion ? (
                    <button
                      className="inspectorSmallButton"
                      onClick={() =>
                        void loadMoreCandidates(
                          selected,
                          selectedVersion,
                          candidateCursor,
                        )
                      }
                      type="button"
                    >
                      加载更多 Candidates
                    </button>
                  ) : null}
                </>
              ) : (
                <p className="inspectorMuted">Select a version first.</p>
              )}
            </InspectorDisclosure>

            <InspectorDisclosure
              bodyId="reflection-section-claim-bio"
              onToggle={() => toggleSection("claimBio")}
              open={openSections.claimBio}
              summary={
                Object.keys(claims).length > 0
                  ? `${Object.keys(claims).length} candidate trace(s)`
                  : "按需加载"
              }
              title="Claim / Bio impact"
            >
              {Object.keys(claims).length === 0 ? (
                <p className="inspectorMuted">
                  Expand a Candidate disposition row and choose “Claim / Bio
                  trace” to load its Claim eligibility and Bio impact.
                </p>
              ) : null}
              {Object.entries(claims).map(([candidateId, claimItems]) => (
                <div className="reflectionClaimGroup" key={candidateId}>
                  <p className="inspectorMuted">
                    Candidate <code>{candidateId}</code>
                  </p>
                  {claimItems.map((claim) => (
                    <div className="reflectionTraceItem" key={claim.diffId}>
                      <code>{claim.eligibility}</code> · {claim.outcome} ·{" "}
                      {claim.status ?? "no current Claim"}
                      {claim.claimVersionId ? (
                        <button
                          className="inspectorSmallButton"
                          onClick={() => void loadBioImpact(claim)}
                          type="button"
                        >
                          展开 Bio impact
                        </button>
                      ) : null}
                      {(claim.claimVersionId
                        ? bioImpacts[claim.claimVersionId] ?? []
                        : []
                      ).map((bio) => (
                        <div className="reflectionTraceItem" key={bio.bioVersionId}>
                          <code>{bio.status}</code> ·{" "}
                          {bio.current ? "current" : "history"} ·{" "}
                          {bio.linkRole}/{bio.supportStatus} ·{" "}
                          {bio.coverageDisposition ?? "no coverage unit"}
                        </div>
                      ))}
                      {claim.claimVersionId &&
                      bioImpactCursors[claim.claimVersionId] ? (
                        <button
                          className="inspectorSmallButton"
                          onClick={() =>
                            void loadBioImpact(
                              claim,
                              bioImpactCursors[claim.claimVersionId as string] ?? null,
                              true,
                            )
                          }
                          type="button"
                        >
                          加载更多 Bio
                        </button>
                      ) : null}
                    </div>
                  ))}
                  {claimCursors[candidateId] ? (
                    <button
                      className="inspectorSmallButton"
                      onClick={() =>
                        void loadClaims(
                          candidateId,
                          claimCursors[candidateId] ?? null,
                          true,
                        )
                      }
                      type="button"
                    >
                      加载更多 Claims
                    </button>
                  ) : null}
                </div>
              ))}
            </InspectorDisclosure>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function InspectorDisclosure(props: {
  bodyId: string;
  children: ReactNode;
  onToggle: () => void;
  open: boolean;
  summary?: string;
  title: string;
}) {
  return (
    <section className="reflectionSection">
      <h3 className="reflectionSectionHeading">
        <button
          aria-controls={props.bodyId}
          aria-expanded={props.open}
          className="reflectionSectionToggle"
          onClick={props.onToggle}
          type="button"
        >
          <span className="reflectionSectionTitle">{props.title}</span>
          {props.summary ? (
            <span className="reflectionSectionSummary">{props.summary}</span>
          ) : null}
          <span aria-hidden="true" className="reflectionSectionChevron">
            {props.open ? "−" : "+"}
          </span>
        </button>
      </h3>
      {props.open ? (
        <div className="reflectionSectionBody" id={props.bodyId}>
          {props.children}
        </div>
      ) : null}
    </section>
  );
}

function VersionMetadata(props: { version: VersionItem }) {
  const { metadata } = props.version;
  return (
    <dl className="inspectorFacts reflectionVersionMeta">
      <InspectorFact label="Version">
        <code>{props.version.versionId}</code>
      </InspectorFact>
      <InspectorFact label="Status">
        {props.version.status} · {props.version.contentState}
      </InspectorFact>
      <InspectorFact label="Source revision">
        {props.version.sourceRevision}
      </InspectorFact>
      <InspectorFact label="Locale / schema">
        <code>{props.version.locale}</code> · <code>{props.version.schemaVersion}</code>
      </InspectorFact>
      <InspectorFact label="Prompt / policy">
        <code>{props.version.promptVersion}</code> ·{" "}
        <code>{metadata.policyVersion ?? "—"}</code>
      </InspectorFact>
      <InspectorFact label="Source digest">
        <code>{props.version.sourceDigest ?? "—"}</code>
      </InspectorFact>
      <InspectorFact label="Model">
        {metadata.provider ?? "—"} / {metadata.model ?? "—"} ·{" "}
        <code>{metadata.modelRole ?? "—"}</code>
      </InspectorFact>
      <InspectorFact label="Model snapshot / config">
        <code>{metadata.modelSnapshot ?? "—"}</code> ·{" "}
        <code>{metadata.modelConfigVersion ?? "—"}</code>
      </InspectorFact>
      <InspectorFact label="Rollout pin">
        <code>{metadata.rolloutPin ?? "—"}</code>
      </InspectorFact>
      <InspectorFact label="Attempt">
        {metadata.attemptKind ?? "—"} · {metadata.attemptStatus ?? "—"}
      </InspectorFact>
      <InspectorFact label="Generation command">
        <code>{metadata.generationCommandId ?? "—"}</code>
      </InspectorFact>
      <InspectorFact label="Authoritative attempt">
        <code>{metadata.authoritativeModelAttemptId ?? "—"}</code>
      </InspectorFact>
      <InspectorFact label="Validation verdict">
        {metadata.validationVerdict ?? "unavailable"}
      </InspectorFact>
      <InspectorFact label="Validation policy">
        <code>{metadata.validationPolicyVersion ?? "—"}</code>
      </InspectorFact>
      <InspectorFact label="Validation prompt / schema">
        <code>{metadata.validationPromptVersion ?? "—"}</code> ·{" "}
        <code>{metadata.validationSchemaVersion ?? "—"}</code>
      </InspectorFact>
      <InspectorFact label="Validator ids">
        <code>{metadata.validatorRequestId ?? "—"}</code> ·{" "}
        <code>{metadata.validatorResultId ?? "—"}</code>
      </InspectorFact>
      <InspectorFact label="Findings (blocking / advisory)">
        {metadata.validationBlockingFindingCodes.length} /{" "}
        {metadata.validationAdvisoryFindingCodes.length}
      </InspectorFact>
      <InspectorFact label="Coverage (covered / uncovered)">
        {metadata.validationCoveredKeys.length} /{" "}
        {metadata.validationUncoveredPlannedKeys.length}
      </InspectorFact>
      <InspectorFact label="Schedule policy">
        <code>{metadata.schedulePolicyVersion ?? "—"}</code>
      </InspectorFact>
      <InspectorFact label="Degraded episode">
        {props.version.degradedEpisodeReason ?? "none"}
      </InspectorFact>
    </dl>
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
