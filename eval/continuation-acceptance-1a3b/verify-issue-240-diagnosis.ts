import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const diagnosisPath = "eval/continuation-acceptance-1a3b/issue-240-g2-v5-diagnosis.json";
const contractPath = "eval/continuation-acceptance-1a3b/issue-240-g2-v6-opportunity-contract.json";
const roundDirectories: Record<string, string> = {
  v4: "eval/continuation-acceptance-1a3b/run-v4",
  "v5-r1": "eval/continuation-acceptance-1a3b/run-v5-calibration-1",
  "v5-r2": "eval/continuation-acceptance-1a3b/run-v5-calibration-2",
};
const runArtifactFiles: Record<string, string> = {
  verification: "verification.json",
  main: "continuation-main.json",
  off: "continuation-off.json",
  on: "continuation-on.json",
  ledger: "treatment-ledger.json",
};
const allowedAttributions = new Set([
  "sample_mislabel",
  "main_response_occupied",
  "selector_or_timing_subject_error",
  "expression_generator_misjudgment",
  "no_valid_expression",
  "typed_reason_error",
  "stateful_anchor_not_committed",
]);
const allowedPragmaticCategories = new Set([
  "greeting",
  "open_start",
  "natural_gap",
  "quiet",
  "closure",
  "leave",
  "current_topic",
  "direct_task",
  "urgent_or_high_risk",
]);
const allowedOutcomes = new Set(["emit", "omit"]);
const allowedNaturalOpportunities = new Set(["valid", "conditional", "invalid"]);
const allowedExpressionOutcomes = new Set(["valid", "conditional", "none"]);
const allowedProbeAssessments = new Set(["supported", "partial", "not_supported", "not_applicable"]);
const allowedHumanAdmission = new Set(["valid", "conditional", "invalid"]);

type RecordValue = { [key: string]: unknown };
type LaterTurn = {
  sequenceInScenario: number;
  selectionOutcome: string;
  selectedTargetRef: string | null;
  segmentOutcome: string;
  segmentOmitReason: string | null;
  typedUseOutcome: string | null;
  dispositionOutcome: string | null;
  releaseOutcome: string | null;
};
type CompetingCandidate = {
  targetRef: string;
  lane: string;
  rankTuple: readonly (string | number | null)[] | null;
  mechanicallyEligible: boolean;
  humanAdmission: string;
  expressionKind: "question" | "acknowledgment";
  exclusionReason: string | null;
};
type DiagnosisRow = {
  fixtureId: string;
  family: string;
  kind: "positive" | "stateful" | "omission_audit";
  turnSequence: number;
  source: {
    scenePath: string | null;
    targetText: string;
    targetKeywords: string[];
    pragmaticCategory: string;
    currentUserText: string;
    targetRef: string;
    targetEvidence: string;
    targetSubject: string;
  };
  mainResponse: {
    currentText: string;
    controlledMainResponseFingerprint: string;
    previousMentionsTarget: boolean;
    currentCoversTarget: boolean;
  };
  provider: {
    selectedTargetRef: string | null;
    selectionOutcome: string;
    providerCallCount: number;
    segmentOutcome: string;
    segmentOmitReason: string | null;
    segmentText: string | null;
  };
  adjudication: {
    mechanicalExecutable: boolean;
    pragmaticCategory: string;
    naturalOpportunity: string;
    expressionPossible: string;
    scenarioAdmission: string;
    expectedOutcome: string;
    providerOutcome: string;
    providerReason: string | null;
    providerOutcomeCorrect: boolean;
    providerReasonCorrect: boolean | null;
    probeLabel: string | null;
    probeLabelAssessment: string;
    primaryAttribution: string;
    secondaryAttributions: string[];
    validSegment: string | null;
    independentReviewConclusion: string;
    sourceEvidenceQuality: string;
    subjectStatus: string;
    localWindowStatus: string;
  };
  competingPool: null | {
    expectedWinnerTargetRef: string;
    observedWinnerTargetRef: string | null;
    candidates: CompetingCandidate[];
    allCandidatesHumanAdmissible: boolean;
  };
  trajectory: null | {
    anchorSequence: number;
    anchorCommitted: boolean;
    fullTrajectoryEligible: boolean;
    laterTurns: LaterTurn[];
  };
};
type Diagnosis = {
  version: string;
  scope: {
    mechanicalOpportunityDenominator: number;
    mechanicalOpportunityFamilyCounts: Record<string, number>;
    omissionProbeCount: number;
    excludedFromMechanicalDenominator: { fixtureId: string; reason: string }[];
  };
  observedProviderSummary: {
    committedOpportunityTurnIds: string[];
    committedOpportunityCount: number;
    anyActualEmitScenarioIds: string[];
    anyActualEmitCount: number;
  };
  independentReview: {
    artifactPath: string;
    artifactSha256: string;
    ordering: string;
    disagreementsResolved: { fixtureId: string; final: string; note: string }[];
  };
  rows: DiagnosisRow[];
  evidence: {
    rounds: Record<string, {
      evaluatorCommit: string;
      inputFingerprints: { path: string; rawSha256: string; tracked: boolean }[];
      rawRunHashes: Record<string, string>;
      calibrationReport: string | null;
    }>;
  };
};
type Contract = {
  version: string;
  attributionLabels: string[];
  rowFields: string[];
  scope: {
    pragmaticCategoryValues: string[];
    naturalOpportunityVerdicts: string[];
    expressionPossibleValues: string[];
  };
  omitReasonPrecedence: string[];
  v6AdmissionRules: string[];
  prohibitedChanges: string[];
};

type Verification = {
  passed: boolean;
  errors: string[];
  counts: {
    rows: number;
    mechanicalOpportunities: number;
    omissionProbes: number;
    statefulAnchors: number;
    statefulCommittedAnchors: number;
  };
};

function readJson<T>(root: string, path: string): Promise<T> {
  return readFile(resolve(root, path), "utf8").then((value) => JSON.parse(value) as T);
}

function rawSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function addError(errors: string[], condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

function asRecord(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function targetRefValue(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.kind === "memory_claim" && typeof record.memoryId === "string") return `memory_claim:${record.memoryId}`;
  if (record.kind === "open_loop" && typeof record.sourceTurn === "number" && typeof record.ordinal === "number") return `open_loop:${record.sourceTurn}:${record.ordinal}`;
  return null;
}

function containsKeyword(text: string | null, keywords: readonly string[]): boolean {
  return text !== null && keywords.some((keyword) => text.toLowerCase().includes(keyword.toLowerCase()));
}

function isTracked(root: string, path: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasForbiddenBlindField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasForbiddenBlindField(entry));
  const record = asRecord(value);
  if (!record) return false;
  for (const [key, entry] of Object.entries(record)) {
    if ([
      "provider",
      "providerOutcome",
      "providerReason",
      "providerCallCount",
      "segmentOutcome",
      "segmentOmitReason",
      "segmentText",
      "segmentProviderCallCount",
      "segmentFingerprint",
      "finalResponseFingerprint",
      "selectionOutcome",
      "selectionReason",
      "typedUseOutcome",
      "ledger",
    ].includes(key)) return true;
    if (hasForbiddenBlindField(entry)) return true;
  }
  return false;
}

function ledgerOn(value: unknown): RecordValue | null {
  const turn = asRecord(value);
  return turn ? asRecord(turn.on) : null;
}

function candidateComparable(value: unknown): RecordValue | null {
  const candidate = asRecord(value);
  if (!candidate) return null;
  return {
    targetRef: candidate.targetRef,
    lane: candidate.lane,
    rankTuple: candidate.rankTuple,
    mechanicallyEligible: candidate.current === true && candidate.eligible === true && candidate.trustFence === "valid" && candidate.mentionedInExchange === false && candidate.formedInCurrentTurn === false && candidate.exclusionReason === null,
    expressionKind: typeof candidate.targetRef === "string" && candidate.targetRef.startsWith("memory_claim:") ? "acknowledgment" : "question",
    exclusionReason: candidate.exclusionReason,
  };
}

function laterTurnComparable(value: unknown): RecordValue | null {
  const turn = asRecord(value);
  if (!turn) return null;
  const on = asRecord(turn.on) ?? turn;
  return {
    sequenceInScenario: turn.sequenceInScenario,
    selectionOutcome: on.selectionOutcome,
    selectedTargetRef: on.selectedTargetRef,
    segmentOutcome: on.segmentOutcome,
    segmentOmitReason: on.segmentOmitReason,
    typedUseOutcome: on.typedUseOutcome,
    dispositionOutcome: on.dispositionOutcome,
    releaseOutcome: on.releaseOutcome,
  };
}

export function verifyIssue240Diagnosis(
  diagnosis: Diagnosis,
  contract: Contract,
): Verification {
  const errors: string[] = [];
  addError(errors, diagnosis.version === "sayhear-issue-240-diagnosis:v1", "unexpected diagnosis version");
  addError(errors, contract.version === "sayhear-g2-v6-opportunity-contract:v1", "unexpected contract version");
  addError(errors, diagnosis.rows.length === 43, "diagnosis must contain 43 rows");
  addError(errors, diagnosis.scope.mechanicalOpportunityDenominator === 31, "mechanical denominator must remain 31");
  addError(errors, diagnosis.scope.omissionProbeCount === 12, "omission probe count must remain 12");
  addError(errors, diagnosis.observedProviderSummary.committedOpportunityCount === 1, "anchor emit count must remain 1");
  addError(errors, diagnosis.observedProviderSummary.committedOpportunityTurnIds.length === 1, "exactly one committed opportunity turn is required");
  addError(errors, diagnosis.observedProviderSummary.anyActualEmitCount === 3, "actual emit scenario count must remain 3");
  addError(errors, diagnosis.observedProviderSummary.anyActualEmitScenarioIds.includes("g2-v5-cal2-state-005"), "state-005 later emit must be recorded separately");
  addError(errors, contract.attributionLabels.every((label) => allowedAttributions.has(label)), "contract attribution labels are incomplete");
  addError(errors, contract.scope.pragmaticCategoryValues.every((value) => allowedPragmaticCategories.has(value)), "contract pragmatic categories are incomplete");
  addError(errors, contract.scope.naturalOpportunityVerdicts.length === 3, "contract must define three natural opportunity verdicts");
  addError(errors, contract.scope.naturalOpportunityVerdicts.every((value) => allowedNaturalOpportunities.has(value)), "contract natural opportunity verdicts are invalid");
  addError(errors, contract.scope.expressionPossibleValues.length === 3 && contract.scope.expressionPossibleValues.every((value) => allowedExpressionOutcomes.has(value)), "contract expression possibility values are invalid");
  addError(errors, contract.rowFields.includes("independentReviewConclusion"), "contract must record independentReviewConclusion");
  addError(errors, contract.rowFields.includes("competingPool"), "contract must record competingPool");
  addError(errors, contract.omitReasonPrecedence.length === 4, "contract must define four ordered omit reasons");
  addError(errors, contract.v6AdmissionRules.some((rule) => rule.includes("committed anchor")), "contract must require a committed stateful anchor");
  addError(errors, contract.v6AdmissionRules.some((rule) => rule.includes("main 不覆盖")), "contract must require main non-coverage");
  addError(errors, contract.prohibitedChanges.some((rule) => rule.includes("31")), "contract must protect the 31-case denominator");
  addError(errors, diagnosis.independentReview.artifactPath.length > 0, "blind review artifact path is missing");
  addError(errors, diagnosis.independentReview.artifactSha256.length === 64, "blind review artifact hash is missing");
  addError(errors, diagnosis.independentReview.ordering.includes("Provider reason and ledger"), "blind review ordering statement is incomplete");
  const expectedRounds = Object.keys(roundDirectories).sort();
  addError(errors, JSON.stringify(Object.keys(diagnosis.evidence.rounds).sort()) === JSON.stringify(expectedRounds), "diagnosis must retain v4, v5-r1, and v5-r2 evidence rounds");
  for (const [roundId, round] of Object.entries(diagnosis.evidence.rounds)) {
    for (const artifact of Object.keys(runArtifactFiles)) addError(errors, Object.hasOwn(round.rawRunHashes ?? {}, artifact), `${roundId}: missing raw hash for ${artifact}`);
  }
  const ids = new Set<string>();
  const familyCounts: Record<string, number> = {};
  let omissionProbes = 0;
  let mechanicalOpportunities = 0;
  let statefulAnchors = 0;
  let statefulCommittedAnchors = 0;
  for (const row of diagnosis.rows) {
    addError(errors, !ids.has(row.fixtureId), `duplicate fixture ${row.fixtureId}`);
    ids.add(row.fixtureId);
    addError(errors, row.turnSequence === 2, `${row.fixtureId}: target turn must be t2`);
    addError(errors, row.adjudication.mechanicalExecutable, `${row.fixtureId}: mechanical executable flag must be true`);
    addError(errors, allowedPragmaticCategories.has(row.source.pragmaticCategory), `${row.fixtureId}: invalid pragmatic category`);
    addError(errors, row.adjudication.pragmaticCategory === row.source.pragmaticCategory, `${row.fixtureId}: category fields disagree`);
    addError(errors, row.source.targetKeywords.length > 0, `${row.fixtureId}: target keywords are missing`);
    addError(errors, Boolean(row.source.scenePath), `${row.fixtureId}: missing source scene path`);
    addError(errors, Boolean(row.source.targetText), `${row.fixtureId}: missing target evidence`);
    addError(errors, Boolean(row.source.currentUserText), `${row.fixtureId}: missing current user text`);
    addError(errors, Boolean(row.mainResponse.currentText), `${row.fixtureId}: missing frozen main response`);
    addError(errors, row.mainResponse.currentCoversTarget === containsKeyword(row.mainResponse.currentText, row.source.targetKeywords), `${row.fixtureId}: current coverage flag is not evidence-backed`);
    addError(errors, typeof row.mainResponse.previousMentionsTarget === "boolean", `${row.fixtureId}: previous mention flag must be boolean`);
    addError(errors, allowedOutcomes.has(row.adjudication.expectedOutcome), `${row.fixtureId}: invalid expected outcome`);
    addError(errors, allowedOutcomes.has(row.adjudication.providerOutcome), `${row.fixtureId}: invalid provider outcome`);
    addError(errors, allowedNaturalOpportunities.has(row.adjudication.naturalOpportunity), `${row.fixtureId}: invalid natural opportunity verdict`);
    addError(errors, allowedExpressionOutcomes.has(row.adjudication.expressionPossible), `${row.fixtureId}: invalid expression possibility verdict`);
    addError(errors, row.adjudication.providerOutcome === (row.provider.segmentOutcome === "committed" ? "emit" : "omit"), `${row.fixtureId}: provider outcome alias disagrees`);
    addError(errors, row.adjudication.providerReason === row.provider.segmentOmitReason, `${row.fixtureId}: provider reason alias disagrees`);
    addError(errors, allowedAttributions.has(row.adjudication.primaryAttribution), `${row.fixtureId}: invalid primary attribution`);
    addError(errors, row.adjudication.secondaryAttributions.every((item) => allowedAttributions.has(item)), `${row.fixtureId}: invalid secondary attribution`);
    addError(errors, allowedProbeAssessments.has(row.adjudication.probeLabelAssessment), `${row.fixtureId}: invalid probe assessment`);
    addError(errors, row.adjudication.independentReviewConclusion.length > 0, `${row.fixtureId}: independent review conclusion is missing`);
    addError(errors, row.provider.providerCallCount === 1, `${row.fixtureId}: expected one Provider call`);
    addError(errors, row.provider.segmentOutcome === "committed" || row.provider.segmentOutcome === "omitted", `${row.fixtureId}: invalid segment outcome`);
    addError(errors, row.provider.segmentOutcome === "omitted" ? row.provider.segmentOmitReason !== null : row.provider.segmentOmitReason === null, `${row.fixtureId}: omit reason does not match segment outcome`);
    if (row.kind === "omission_audit") {
      omissionProbes += 1;
      addError(errors, row.adjudication.probeLabel !== null, `${row.fixtureId}: omission probe label is missing`);
    } else {
      mechanicalOpportunities += 1;
      addError(errors, row.adjudication.probeLabel === null, `${row.fixtureId}: non-probe has a probe label`);
    }
    familyCounts[row.family] = (familyCounts[row.family] ?? 0) + 1;
    if (row.family === "competing_pool") {
      addError(errors, row.competingPool !== null, `${row.fixtureId}: competing pool is missing`);
      if (row.competingPool) {
        addError(errors, row.competingPool.candidates.length >= 2, `${row.fixtureId}: competing pool needs at least two candidates`);
        addError(errors, row.competingPool.expectedWinnerTargetRef === row.source.targetRef, `${row.fixtureId}: expected competing winner is wrong`);
        addError(errors, row.competingPool.observedWinnerTargetRef === row.provider.selectedTargetRef, `${row.fixtureId}: observed competing winner is wrong`);
        addError(errors, row.competingPool.candidates.every((candidate) => Array.isArray(candidate.rankTuple) && allowedHumanAdmission.has(candidate.humanAdmission)), `${row.fixtureId}: competing candidate rank/admission is incomplete`);
        addError(errors, row.competingPool.allCandidatesHumanAdmissible === row.competingPool.candidates.every((candidate) => candidate.humanAdmission === "valid"), `${row.fixtureId}: competing pool admission summary is inconsistent`);
        addError(errors, row.competingPool.candidates.some((candidate) => candidate.humanAdmission !== "valid"), `${row.fixtureId}: invalid v5 competing pool was not marked non-clean`);
      }
    } else {
      addError(errors, row.competingPool === null, `${row.fixtureId}: non-competing row has a competing pool`);
    }
    if (row.kind === "stateful") {
      statefulAnchors += 1;
      if (row.trajectory?.anchorCommitted) statefulCommittedAnchors += 1;
      addError(errors, row.trajectory?.anchorSequence === 2, `${row.fixtureId}: stateful anchor sequence must be t2`);
      addError(errors, row.trajectory?.laterTurns.length === 2, `${row.fixtureId}: stateful later turns are incomplete`);
      addError(errors, row.trajectory?.fullTrajectoryEligible === false, `${row.fixtureId}: v5 stateful trajectory must not be marked eligible`);
    }
  }
  for (const [family, count] of Object.entries(diagnosis.scope.mechanicalOpportunityFamilyCounts)) {
    addError(errors, familyCounts[family] === count, `${family}: family count mismatch`);
  }
  addError(errors, mechanicalOpportunities === 31, "mechanical opportunity rows must total 31");
  addError(errors, omissionProbes === 12, "omission rows must total 12");
  addError(errors, statefulAnchors === 8, "stateful rows must total 8");
  addError(errors, statefulCommittedAnchors === 0, "v5 stateful anchors must remain uncommitted");
  const disagreements = new Map<string, { final: string; note: string }>();
  for (const disagreement of diagnosis.independentReview.disagreementsResolved ?? []) {
    if (disagreements.has(disagreement.fixtureId)) errors.push(`duplicate resolved disagreement ${disagreement.fixtureId}`);
    disagreements.set(disagreement.fixtureId, disagreement);
  }
  for (const row of diagnosis.rows) {
    if (row.adjudication.independentReviewConclusion !== row.adjudication.primaryAttribution) {
      const disagreement = disagreements.get(row.fixtureId);
      addError(errors, Boolean(disagreement), `${row.fixtureId}: independent review disagreement is not recorded`);
      if (disagreement) {
        addError(errors, disagreement.final === row.adjudication.primaryAttribution, `${row.fixtureId}: resolved disagreement has the wrong final attribution`);
        addError(errors, disagreement.note.trim().length > 0, `${row.fixtureId}: resolved disagreement has no ruling note`);
      }
    }
  }
  return {
    passed: errors.length === 0,
    errors,
    counts: {
      rows: diagnosis.rows.length,
      mechanicalOpportunities,
      omissionProbes,
      statefulAnchors,
      statefulCommittedAnchors,
    },
  };
}

async function verifyIssue240EvidenceInternal(
  root: string,
  diagnosis: Diagnosis,
): Promise<Verification> {
  const errors: string[] = [];
  let rows = 0;
  let mechanicalOpportunities = 0;
  let omissionProbes = 0;
  let statefulAnchors = 0;
  let statefulCommittedAnchors = 0;
  const blindPath = diagnosis.independentReview.artifactPath;
  let blind: RecordValue | null = null;
  try {
    const blindRaw = await readFile(resolve(root, blindPath), "utf8");
    if (rawSha256(blindRaw) !== diagnosis.independentReview.artifactSha256) errors.push("blind review artifact hash mismatch");
    blind = JSON.parse(blindRaw) as RecordValue;
    if (blind.protocol !== "blind-before-provider") errors.push("blind review protocol is not frozen before provider review");
    if (blind.providerReasonExcluded !== true || blind.providerLedgerExcluded !== true) errors.push("blind review artifact does not exclude provider fields");
    if (!Array.isArray(blind.rows) || blind.rows.length !== 43) errors.push("blind review row count is not 43");
    if (Object.hasOwn(blind, "disagreements")) errors.push("blind review artifact must not contain post-review disagreement outcomes");
    if (hasForbiddenBlindField(blind)) errors.push("blind review artifact contains Provider or ledger fields");
    const sourceFingerprints = asRecord(blind.sourceFingerprints);
    const round2 = diagnosis.evidence.rounds["v5-r2"];
    const expectedFingerprints = {
      catalog: round2?.inputFingerprints.find((fingerprint) => fingerprint.path.endsWith("fixtures-v5-calibration-2.json"))?.rawSha256,
      main: round2?.rawRunHashes.main,
    };
    for (const [name, expectedHash] of Object.entries(expectedFingerprints)) {
      const fingerprint = sourceFingerprints ? asRecord(sourceFingerprints[name]) : null;
      if (!fingerprint || !expectedHash || fingerprint.rawSha256 !== expectedHash) {
        errors.push(`blind review source fingerprint mismatch for ${name}`);
        continue;
      }
      try {
        const raw = await readFile(resolve(root, stringValue(fingerprint.path) ?? ""), "utf8");
        if (rawSha256(raw) !== expectedHash) errors.push(`blind review source hash mismatch for ${name}`);
      } catch {
        errors.push(`blind review source missing for ${name}`);
      }
    }
  } catch {
    errors.push(`evidence_missing: blind review artifact ${blindPath}`);
  }
  const round2Catalog = await readJson<RecordValue>(root, "eval/continuation-acceptance-1a3b/fixtures-v5-calibration-2.json");
  const sceneFiles = round2Catalog.sceneFiles;
  if (!Array.isArray(sceneFiles)) {
    return { passed: false, errors: [...errors, "round 2 catalog has no scene files"], counts: { rows: 0, mechanicalOpportunities: 0, omissionProbes: 0, statefulAnchors: 0, statefulCommittedAnchors: 0 } };
  }
  const scenes = new Map<string, RecordValue>();
  for (const entry of sceneFiles) {
    const entryRecord = asRecord(entry);
    const path = entryRecord ? stringValue(entryRecord.path) : null;
    if (!path) continue;
    try {
      const file = await readJson<RecordValue>(root, path);
      if (Array.isArray(file.scenes)) {
        for (const scene of file.scenes) {
          const sceneRecord = asRecord(scene);
          const id = sceneRecord ? stringValue(sceneRecord.id) : null;
          if (sceneRecord && id) scenes.set(id, sceneRecord);
        }
      }
    } catch {
      errors.push(`missing or invalid scene file ${path}`);
    }
  }
  const main = await readJson<RecordValue>(root, "eval/continuation-acceptance-1a3b/run-v5-calibration-2/continuation-main.json");
  const ledger = await readJson<RecordValue>(root, "eval/continuation-acceptance-1a3b/run-v5-calibration-2/treatment-ledger.json");
  const round2Verification = await readJson<RecordValue>(root, "eval/continuation-acceptance-1a3b/run-v5-calibration-2/verification.json");
  const predeclaredTurnIds = Array.isArray(round2Verification.predeclaredOpportunityTurnIds)
    ? round2Verification.predeclaredOpportunityTurnIds.filter((value): value is string => typeof value === "string")
    : [];
  const diagnosisMechanicalTurnIds = diagnosis.rows
    .filter((row) => row.kind !== "omission_audit")
    .map((row) => `${row.fixtureId}:t${row.turnSequence}`)
    .sort();
  const expectedMechanicalTurnIds = predeclaredTurnIds
    .filter((id) => !id.startsWith("g2-v5-cal2-mem-002:"))
    .sort();
  if (predeclaredTurnIds.length !== 31) errors.push("frozen v5 predeclared opportunity count is not 31");
  if (predeclaredTurnIds.some((id) => id.startsWith("g2-v5-cal2-mem-002:"))) errors.push("mem-002 must remain excluded from frozen predeclared mechanical turns");
  if (JSON.stringify(diagnosisMechanicalTurnIds) !== JSON.stringify(expectedMechanicalTurnIds)) errors.push("mechanical rows differ from frozen predeclared opportunity turns");
  if (!diagnosis.scope.excludedFromMechanicalDenominator.some((entry) => entry.fixtureId === "g2-v5-cal2-mem-002" && entry.reason.length > 0)) errors.push("mem-002 exclusion is not recorded");
  if (diagnosis.rows.some((row) => row.fixtureId === "g2-v5-cal2-mem-002" && row.kind !== "omission_audit")) errors.push("mem-002 must not be a mechanical row");
  if (round2Verification.recall && asRecord(round2Verification.recall)?.denominator !== 31) errors.push("v5 verification denominator is not 31");
  const mainResponses = Array.isArray(main.responses) ? main.responses : [];
  const ledgerScenarios = Array.isArray(ledger.scenarios) ? ledger.scenarios : [];
  const ledgerById = new Map<string, RecordValue>();
  for (const scenario of ledgerScenarios) {
    const scenarioRecord = asRecord(scenario);
    const id = scenarioRecord ? stringValue(scenarioRecord.fixtureId) : null;
    if (scenarioRecord && id) ledgerById.set(id, scenarioRecord);
  }
  const blindRows = new Map<string, RecordValue>();
  if (blind && Array.isArray(blind.rows)) {
    for (const value of blind.rows) {
      const record = asRecord(value);
      const id = record ? stringValue(record.fixtureId) : null;
      if (record && id) {
        if (blindRows.has(id)) errors.push(`duplicate blind fixture ${id}`);
        blindRows.set(id, record);
      }
    }
  }
  for (const row of diagnosis.rows) {
    if (!blindRows.has(row.fixtureId)) errors.push(`blind review row missing ${row.fixtureId}`);
  }
  for (const row of diagnosis.rows) {
    rows += 1;
    const scene = scenes.get(row.fixtureId);
    if (!scene) {
      errors.push(`${row.fixtureId}: scene missing`);
      continue;
    }
    const turns = Array.isArray(scene.turns) ? scene.turns : [];
    const turn = turns.find((entry) => {
      const record = asRecord(entry);
      return record?.sequenceInScenario === row.turnSequence;
    });
    if (!turn) {
      errors.push(`${row.fixtureId}: source turn missing`);
      continue;
    }
    const turnRecord = asRecord(turn);
    const userInput = turnRecord ? asRecord(turnRecord.userInput) : null;
    if (!userInput || userInput.text !== row.source.currentUserText) errors.push(`${row.fixtureId}: current user text differs from frozen source`);
    const declaredTarget = turnRecord ? asRecord(turnRecord.expect)?.target : null;
    const expectedTargetRef = targetRefValue(declaredTarget);
    if (expectedTargetRef !== row.source.targetRef) errors.push(`${row.fixtureId}: target ref differs from frozen source`);
    let expectedTextValue: string | null = null;
    if (expectedTargetRef?.startsWith("memory_claim:")) {
      const memoryId = expectedTargetRef.slice("memory_claim:".length);
      const memory = Array.isArray(scene.memory)
        ? scene.memory.find((value) => asRecord(value)?.id === memoryId)
        : null;
      const memoryRecord = asRecord(memory);
      expectedTextValue = memoryRecord ? stringValue(memoryRecord.text) : null;
    } else if (Array.isArray(scene.historicalEvents)) {
      const historical = asRecord(scene.historicalEvents[0]);
      expectedTextValue = historical ? stringValue(historical.text) : null;
    }
    if (expectedTextValue !== row.source.targetText) errors.push(`${row.fixtureId}: target Evidence differs from frozen source`);
    const currentMain = mainResponses.find((entry) => {
      const record = asRecord(entry);
      return record?.fixtureId === row.fixtureId && record.sequenceInScenario === row.turnSequence;
    });
    const currentMainRecord = asRecord(currentMain);
    if (!currentMainRecord || currentMainRecord.text !== row.mainResponse.currentText) errors.push(`${row.fixtureId}: main response differs from frozen source`);
    const previousMain = mainResponses.find((entry) => {
      const record = asRecord(entry);
      return record?.fixtureId === row.fixtureId && record.sequenceInScenario === 1;
    });
    const previousMainRecord = asRecord(previousMain);
    const previousText = previousMainRecord ? stringValue(previousMainRecord.text) : null;
    if (row.mainResponse.currentCoversTarget !== containsKeyword(stringValue(currentMainRecord?.text), row.source.targetKeywords)) errors.push(`${row.fixtureId}: current coverage is not supported by main text`);
    if (row.mainResponse.previousMentionsTarget !== containsKeyword(previousText, row.source.targetKeywords)) errors.push(`${row.fixtureId}: previous mention is not supported by prior main text`);
    const blindRow = blindRows.get(row.fixtureId);
    if (!blindRow) {
      errors.push(`${row.fixtureId}: blind review row differs from ledger`);
    } else {
      const expectedBlindFields: RecordValue = {
        family: row.family,
        kind: row.kind,
        targetEvidence: row.source.targetText,
        currentUserText: row.source.currentUserText,
        pragmaticCategory: row.source.pragmaticCategory,
        naturalOpportunity: row.adjudication.naturalOpportunity,
        expressionPossible: row.adjudication.expressionPossible,
        currentMainCoversTarget: row.mainResponse.currentCoversTarget,
        previousAssistantMentionedTarget: row.mainResponse.previousMentionsTarget,
        sourceEvidenceQuality: row.adjudication.sourceEvidenceQuality,
        subjectStatus: row.adjudication.subjectStatus,
        localWindowStatus: row.adjudication.localWindowStatus,
        validSegment: row.adjudication.validSegment,
      };
      for (const [key, expected] of Object.entries(expectedBlindFields)) {
        if (JSON.stringify(blindRow[key]) !== JSON.stringify(expected)) errors.push(`${row.fixtureId}: blind review field ${key} differs from ledger`);
      }
    }
    const ledgerScenario = ledgerById.get(row.fixtureId);
    const ledgerTurns = ledgerScenario && Array.isArray(ledgerScenario.turns) ? ledgerScenario.turns : [];
    const ledgerTurn = ledgerTurns.find((entry) => asRecord(entry)?.sequenceInScenario === row.turnSequence);
    const on = ledgerOn(ledgerTurn);
    if (!on || on.segmentOutcome !== row.provider.segmentOutcome || (on.segmentOmitReason ?? null) !== row.provider.segmentOmitReason || (on.segmentText ?? null) !== row.provider.segmentText || (on.selectedTargetRef ?? null) !== row.provider.selectedTargetRef || on.segmentProviderCallCount !== row.provider.providerCallCount) errors.push(`${row.fixtureId}: Provider outcome differs from frozen ledger`);
    if (on && on.controlledMainResponseFingerprint && row.mainResponse.controlledMainResponseFingerprint !== on.controlledMainResponseFingerprint) errors.push(`${row.fixtureId}: main fingerprint differs from frozen ledger`);
    if (row.kind === "omission_audit") omissionProbes += 1;
    else mechanicalOpportunities += 1;
    if (row.kind === "stateful") {
      statefulAnchors += 1;
      const anchorCommitted = on?.selectionOutcome === "selected" && on?.segmentOutcome === "committed" && on?.typedUseOutcome === "committed";
      if (row.trajectory?.anchorCommitted !== anchorCommitted) errors.push(`${row.fixtureId}: anchor commitment differs from frozen ledger`);
      if (row.trajectory?.anchorCommitted) statefulCommittedAnchors += 1;
      const laterLedgerTurns = ledgerTurns.filter((entry) => (numberValue(asRecord(entry)?.sequenceInScenario) ?? 0) >= 3);
      const expectedLater = laterLedgerTurns.map((entry) => laterTurnComparable(entry));
      if (JSON.stringify(expectedLater) !== JSON.stringify(row.trajectory?.laterTurns)) errors.push(`${row.fixtureId}: stateful later turns differ from frozen ledger`);
    }
    if (row.family === "competing_pool" && row.competingPool) {
      const rawCandidates = Array.isArray(on?.candidates) ? on.candidates.map(candidateComparable) : [];
      const expectedCandidates = rawCandidates.map((candidate) => candidate ? {
        targetRef: candidate.targetRef,
        lane: candidate.lane,
        rankTuple: candidate.rankTuple,
        mechanicallyEligible: candidate.mechanicallyEligible,
        expressionKind: candidate.expressionKind,
        exclusionReason: candidate.exclusionReason,
      } : candidate);
      const actualCandidates = row.competingPool.candidates.map((candidate) => ({
        targetRef: candidate.targetRef,
        lane: candidate.lane,
        rankTuple: candidate.rankTuple,
        mechanicallyEligible: candidate.mechanicallyEligible,
        expressionKind: candidate.expressionKind,
        exclusionReason: candidate.exclusionReason,
      }));
      if (JSON.stringify(expectedCandidates) !== JSON.stringify(actualCandidates)) errors.push(`${row.fixtureId}: competing candidate evidence differs from frozen ledger`);
      if (row.competingPool.observedWinnerTargetRef !== row.provider.selectedTargetRef) errors.push(`${row.fixtureId}: competing observed winner differs from provider selection`);
    }
  }
  for (const [roundId, round] of Object.entries(diagnosis.evidence.rounds)) {
    const roundDirectory = roundDirectories[roundId];
    if (!roundDirectory) {
      errors.push(`unknown evidence round: ${roundId}`);
      continue;
    }
    for (const fingerprint of round.inputFingerprints) {
      try {
        const raw = await readFile(resolve(root, fingerprint.path), "utf8");
        if (rawSha256(raw) !== fingerprint.rawSha256) errors.push(`${roundId}: hash mismatch for ${fingerprint.path}`);
        const actualTracked = isTracked(root, fingerprint.path);
        if (fingerprint.tracked !== actualTracked) errors.push(`${roundId}: tracking status mismatch for ${fingerprint.path}`);
      } catch {
        errors.push(`${roundId}: evidence missing ${fingerprint.path}`);
      }
    }
    for (const [name, expected] of Object.entries(round.rawRunHashes)) {
      const file = runArtifactFiles[name];
      if (!file) {
        errors.push(`${roundId}: unknown run artifact ${name}`);
        continue;
      }
      const path = `${roundDirectory}/${file}`;
      try {
        const raw = await readFile(resolve(root, path), "utf8");
        if (rawSha256(raw) !== expected) errors.push(`${roundId}: hash mismatch for ${path}`);
      } catch {
        errors.push(`${roundId}: evidence missing ${path}`);
      }
    }
    if (round.calibrationReport) {
      const path = `${roundDirectory}/calibration-report.json`;
      try {
        const raw = await readFile(resolve(root, path), "utf8");
        if (rawSha256(raw) !== round.calibrationReport) errors.push(`${roundId}: hash mismatch for ${path}`);
      } catch {
        errors.push(`${roundId}: evidence missing ${path}`);
      }
    }
    try {
      const mainRound = await readJson<RecordValue>(root, `${roundDirectory}/continuation-main.json`);
      const ledgerRound = await readJson<RecordValue>(root, `${roundDirectory}/treatment-ledger.json`);
      const mainCommit = stringValue(mainRound.evaluatorCommit);
      const ledgerCommit = stringValue(ledgerRound.evaluatorCommit);
      if (mainCommit !== round.evaluatorCommit || ledgerCommit !== round.evaluatorCommit) errors.push(`${roundId}: evaluator commit provenance mismatch`);
    } catch {
      errors.push(`${roundId}: commit provenance evidence missing`);
    }
  }
  addError(errors, mechanicalOpportunities === 31, "source-backed mechanical opportunity count must be 31");
  addError(errors, omissionProbes === 12, "source-backed omission count must be 12");
  addError(errors, statefulAnchors === 8, "source-backed stateful count must be 8");
  addError(errors, statefulCommittedAnchors === 0, "source-backed stateful committed count must be 0");
  return {
    passed: errors.length === 0,
    errors,
    counts: { rows, mechanicalOpportunities, omissionProbes, statefulAnchors, statefulCommittedAnchors },
  };
}

export async function verifyIssue240Evidence(
  root: string,
  diagnosis: Diagnosis,
): Promise<Verification> {
  try {
    return await verifyIssue240EvidenceInternal(root, diagnosis);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      errors: [`evidence_missing: ${message}`],
      counts: { rows: 0, mechanicalOpportunities: 0, omissionProbes: 0, statefulAnchors: 0, statefulCommittedAnchors: 0 },
    };
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const diagnosis = await readJson<Diagnosis>(root, diagnosisPath);
  const contract = await readJson<Contract>(root, contractPath);
  const internal = verifyIssue240Diagnosis(diagnosis, contract);
  const args = process.argv.slice(2);
  const evidence = args.includes("--check-evidence") ? await verifyIssue240Evidence(root, diagnosis) : null;
  const result = evidence ? { internal, evidence } : { internal };
  console.log(JSON.stringify(result, null, 2));
  if (!internal.passed || (evidence && !evidence.passed)) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("verify-issue-240-diagnosis.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
