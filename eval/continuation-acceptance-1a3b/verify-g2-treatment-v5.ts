/**
 * Issue #207 G2 v5 treatment verifier.
 *
 * Fail-closed verification of the causal claim: the OFF arm replays the frozen
 * clean-incumbent main responses verbatim, and the ON arm only adds the
 * declared treatment. Any mismatch blocks the review package.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalJson, sha256 } from "./protocol";
import { composeProactiveFollowupResponse } from "@sayhear/application";
import {
  F3_V5_ARM_RUN_VERSION,
  F3_V5_LEDGER_VERSION,
  F3_V5_MAIN_RUN_VERSION,
  F3_V5_VERIFICATION_VERSION,
  matchesV5TargetRef,
  v5ConfigurationFingerprint,
  v5RecordsMatchExactSet,
  type V5ArmRun,
  type V5BatchMergeManifest,
  type V5CatalogManifest,
  type V5Family,
  type V5LedgerScenario,
  type V5LedgerTurn,
  type V5MainRun,
  type V5Pins,
  type V5Scene,
  type V5SceneFile,
  type V5TargetRef,
  type V5TreatmentLedger,
  type V5TreatmentVerification,
  type V5ExpressionSelectionManifest,
} from "./protocol-v5";

const OMIT_REASONS = new Set([
  "no_genuine_opportunity",
  "duplicates_main_response",
  "insufficient_grounding",
  "timing_not_natural",
]);
import { verifyV5Catalog } from "./verify-fixtures-v5";
import {
  selectV5PairwiseSample,
  V5_LANGUAGE_QUOTAS,
  V5_PAIRWISE_SIZE,
  V5_SAMPLE_SEED,
} from "./sampling-v5";

export class V5TreatmentVerificationError extends Error {}

function rawSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inputFingerprint(path: string, raw: string) {
  let canonicalJsonSha256 = "invalid-json";
  try {
    canonicalJsonSha256 = sha256(JSON.parse(raw) as unknown);
  } catch {
    // JSON validation is reported by the corresponding parser/catalog gate.
  }
  return { path, rawSha256: rawSha256(raw), canonicalJsonSha256 };
}

function familyOf(
  scenes: readonly V5Scene[],
  fixtureId: string,
): V5Family | null {
  return scenes.find((scene) => scene.id === fixtureId)?.family ?? null;
}

function refKey(ref: V5TargetRef): string {
  return ref.kind === "memory_claim"
    ? `memory_claim:${ref.memoryId}`
    : `open_loop:${ref.sourceTurn}:${ref.ordinal}`;
}

function matchedRefsEqual(left: V5TargetRef, right: V5TargetRef): boolean {
  return matchesV5TargetRef(left, right);
}

export function selectedExpectedEligibleTarget(
  scene: V5Scene,
  ledgerScenario: V5LedgerScenario,
  turn: V5LedgerTurn,
): boolean {
  const declared = scene.turns.find((entry) => entry.sequenceInScenario === turn.sequenceInScenario)?.expect.target;
  const selected = turn.on.selectedTargetRef;
  if (!declared || !selected) return false;
  const matches = declared.kind === "memory_claim"
    ? selected === `memory_claim:${declared.memoryId}`
    : selected.startsWith("open_loop:") && ledgerScenario.formedTargetRefs.some((entry) =>
        selected === `open_loop:${entry.targetId}` && matchedRefsEqual(entry.ref, declared));
  if (!matches) return false;
  const candidate = turn.on.candidates.find((entry) => entry.targetRef === selected);
  return !!candidate && candidate.current && candidate.eligible && candidate.trustFence === "valid" &&
    !candidate.mentionedInExchange && !candidate.formedInCurrentTurn && candidate.exclusionReason === null &&
    candidate.rankTuple !== null;
}

/**
 * A stateful tail is only an acceptance trajectory after the declared anchor
 * created a committed use. A skipped or omitted anchor has nothing for a later
 * user response to suppress.
 */
export function hasCommittedStatefulAnchorUse(
  scene: V5Scene,
  ledgerScenario: V5LedgerScenario,
): boolean {
  if (scene.family !== "stateful_suppression") return false;
  const anchor = scene.turns.find((turn) => turn.expect.selection === "segment");
  if (!anchor) return false;
  const captured = ledgerScenario.turns.find(
    (turn) => turn.sequenceInScenario === anchor.sequenceInScenario,
  );
  return captured?.on.segmentOutcome === "committed" &&
    captured.on.typedUseOutcome === "committed";
}

export function isActualV5TypedOmission(
  turn: V5LedgerTurn,
  expectedReason?: string,
): boolean {
  return turn.on.selectionOutcome === "selected" &&
    turn.on.segmentProviderCallCount === 1 &&
    turn.on.segmentCommandId !== null &&
    turn.on.segmentOutcome === "omitted" &&
    OMIT_REASONS.has(turn.on.segmentOmitReason ?? "") &&
    (expectedReason === undefined || turn.on.segmentOmitReason === expectedReason) &&
    turn.on.segmentText === null &&
    turn.on.reservationOutcome === "released" &&
    turn.on.typedUseOutcome === null &&
    turn.on.dispositionOutcome === null;
}

export type V5TreatmentVerificationReport = Readonly<{
  verification: V5TreatmentVerification;
  eligibleScenarioIds: readonly string[];
  actualEmitScenarioIds: readonly string[];
  actualOmissionAuditScenarioIds: readonly string[];
  predeclaredOpportunityTurnIds: readonly string[];
  committedOpportunityTurnIds: readonly string[];
  recallFunnel: V5TreatmentVerification["recallFunnel"];
  sampleReady: boolean;
  pendingSampleQuotas: readonly string[];
}>;

/**
 * Verify the arm runs and ledger against the fixture expectations. Returns a
 * report whose `verification.passed` is false on any failure; callers must not
 * treat a failed report as a package gate pass.
 */
export function verifyG2Treatment(input: Readonly<{
  catalog: V5CatalogManifest;
  catalogSha256: string;
  expressionSelection: V5ExpressionSelectionManifest;
  ledger: V5TreatmentLedger;
  ledgerSha256: string;
  main: V5MainRun;
  off: V5ArmRun;
  on: V5ArmRun;
  pins: V5Pins;
  scenes: readonly V5Scene[];
  enforceRecallFloor?: boolean;
}>): V5TreatmentVerificationReport {
  const failures: string[] = [];
  const { ledger, main, off, on, scenes } = input;

  if (
    main.evaluatorCommit !== off.evaluatorCommit ||
    main.evaluatorCommit !== on.evaluatorCommit ||
    main.evaluatorCommit !== ledger.evaluatorCommit
  ) {
    failures.push("main, OFF, ON, and ledger evaluator commits do not match");
  }
  if (
    canonicalJson(main.executedBatchIds) !== canonicalJson(off.executedBatchIds) ||
    canonicalJson(main.executedBatchIds) !== canonicalJson(on.executedBatchIds) ||
    canonicalJson(main.executedBatchIds) !== canonicalJson(ledger.executedBatchIds)
  ) {
    failures.push("main, OFF, ON, and ledger executed-batch lists do not match");
  }

  if (main.version !== F3_V5_MAIN_RUN_VERSION) {
    failures.push(`main run version ${main.version} is not v5`);
  }
  if (off.version !== F3_V5_ARM_RUN_VERSION || on.version !== F3_V5_ARM_RUN_VERSION) {
    failures.push("arm run version is not v5");
  }
  if (ledger.version !== F3_V5_LEDGER_VERSION) {
    failures.push(`ledger version ${ledger.version} is not v5`);
  }
  if (off.arm !== "off" || on.arm !== "on") {
    failures.push("arm labels are not off/on");
  }
  if (off.configId === on.configId) {
    failures.push("off and on arms share one configuration");
  }
  if (on.configurationFingerprint === off.configurationFingerprint) {
    failures.push("off and on arms share one configuration fingerprint");
  }
  if (input.pins.version !== "1a3b-g2-pins:v5" || !input.pins.syntheticOnly) {
    failures.push("pins are not a synthetic v5 pin set");
  }
  const expectedOff = input.pins.continuation.arms.off.id;
  const expectedOn = input.pins.continuation.arms.on.id;
  if (off.configId !== expectedOff || on.configId !== expectedOn) {
    failures.push("arm configuration IDs do not match v5 pins");
  }
  try {
    if (off.configurationFingerprint !== v5ConfigurationFingerprint(input.pins, expectedOff)) {
      failures.push("OFF configuration fingerprint differs from v5 pins");
    }
    if (on.configurationFingerprint !== v5ConfigurationFingerprint(input.pins, expectedOn)) {
      failures.push("ON configuration fingerprint differs from v5 pins");
    }
  } catch {
    failures.push("v5 pin configuration fingerprint could not be reconstructed");
  }
  if (ledger.configId !== expectedOn || ledger.configurationFingerprint !== on.configurationFingerprint) {
    failures.push("ledger configuration differs from ON run or v5 pins");
  }
  const selection = input.expressionSelection;
  const winner = input.pins.expression.configurations.find(
    (configuration) => configuration.id === selection.winnerConfigId,
  );
  if (
    selection.version !== "1a3b-g2-expression-decision:v5" ||
    input.pins.expression.selectedConfigId !== selection.winnerConfigId ||
    !winner ||
    selection.winnerRolePinSha256 !== sha256(winner.pin)
  ) {
    failures.push("expression selection does not match the pinned v5 role configuration");
  }
  if (selection.waiver !== undefined) {
    if (
      selection.waiver.approvedBy !== "luke" ||
      selection.waiver.approvedAt !== "2026-09-23" ||
      selection.decision === undefined ||
      selection.authorizationSha256 !==
        sha256({ decision: selection.decision, waiver: selection.waiver })
    ) {
      failures.push("expression waiver authorization is invalid or has drifted");
    }
  } else if (typeof selection.expressionRunSha256 !== "string") {
    failures.push("expression selection has no comparison-run evidence or authorized waiver");
  }

  const mainResponses = new Map<string, Map<number, string>>();
  const mainResponseKeys = new Set<string>();
  for (const response of main.responses) {
    const key = `${response.fixtureId}:${response.sequenceInScenario}`;
    if (mainResponseKeys.has(key)) failures.push(`${key}: duplicate main response`);
    mainResponseKeys.add(key);
    const turns =
      mainResponses.get(response.fixtureId) ?? new Map<number, string>();
    turns.set(response.sequenceInScenario, response.text);
    mainResponses.set(response.fixtureId, turns);
  }

  const offByScene = new Map(off.scenarios.map((s) => [s.fixtureId, s]));
  const onByScene = new Map(on.scenarios.map((s) => [s.fixtureId, s]));
  const ledgerByScene = new Map(
    ledger.scenarios.map((scenario) => [scenario.fixtureId, scenario]),
  );
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const expectedTurns = scenes.reduce((sum, scene) => sum + scene.turns.length, 0);
  if (main.responses.length !== expectedTurns) {
    failures.push(`main response count ${main.responses.length} does not match fixture turn count ${expectedTurns}`);
  }
  for (const [label, records] of [
    ["OFF", off.scenarios],
    ["ON", on.scenarios],
    ["ledger", ledger.scenarios],
  ] as const) {
    const ids = records.map((entry) => label === "ledger" ? (entry as V5LedgerScenario).fixtureId : (entry as V5ArmRun["scenarios"][number]).fixtureId);
    if (new Set(ids).size !== ids.length) failures.push(`${label} contains duplicate scenario records`);
    if (ids.length !== scenes.length || ids.some((id) => !sceneById.has(id))) {
      failures.push(`${label} scenario set has missing or extra records`);
    }
  }

  for (const scene of scenes) {
    const offScenario = offByScene.get(scene.id);
    const onScenario = onByScene.get(scene.id);
    const ledgerScenario = ledgerByScene.get(scene.id);
    if (!offScenario || !onScenario || !ledgerScenario) {
      failures.push(`${scene.id}: missing arm run or ledger scenario`);
      continue;
    }
    verifyScene({
      failures,
      ledgerScenario,
      mainTurns: mainResponses.get(scene.id) ?? new Map(),
      offScenario,
      onScenario,
      scene,
    });
    for (const [label, armScenario] of [["OFF", offScenario], ["ON", onScenario]] as const) {
      if (armScenario.turns.length !== scene.turns.length) {
        failures.push(`${scene.id}: ${label} turn count differs from fixture`);
      }
      for (const fixtureTurn of scene.turns) {
        const captured = armScenario.turns.find(
          (turn) => turn.sequenceInScenario === fixtureTurn.sequenceInScenario,
        );
        if (
          !captured ||
          canonicalJson(captured.userInput) !== canonicalJson(fixtureTurn.userInput)
        ) {
          failures.push(`${scene.id} t${fixtureTurn.sequenceInScenario}: ${label} user input differs from fixture`);
        }
      }
    }
  }

  const eligibleScenarioIds = scenes
    .filter((scene) => !failures.some((failure) => failure.startsWith(`${scene.id}:`)))
    .map((scene) => scene.id);
  const actualEmitScenarioIds = scenes
    .filter((scene) =>
      ledgerByScene.get(scene.id)?.turns.some(
        (turn) => turn.on.segmentOutcome === "committed",
      ),
    )
    .map((scene) => scene.id);
  const actualOmissionAuditScenarioIds = scenes
    .filter(
      (scene) =>
        scene.reviewIntent === "omission_audit" &&
        ledgerByScene.get(scene.id)?.turns.some(
          (turn) => isActualV5TypedOmission(turn, scene.expectedOmissionReason ?? undefined),
        ),
    )
    .map((scene) => scene.id);
  const opportunityTurns = scenes.flatMap((scene) => {
    const ledgerScenario = ledgerByScene.get(scene.id);
    if (scene.reviewIntent !== "pairwise_candidate" || !ledgerScenario) return [];
    return scene.turns.flatMap((sceneTurn) => {
      if (sceneTurn.expect.selection !== "segment") return [];
      const ledgerTurn = ledgerScenario.turns.find(
        (turn) => turn.sequenceInScenario === sceneTurn.sequenceInScenario,
      );
      if (!ledgerTurn || ledgerTurn.on.ordinaryQuestionCount !== 0) return [];
      const completeLane = (lane: V5LedgerTurn["on"]["openLoopLane"]): boolean =>
        lane.status === "complete" &&
        lane.integrity === "valid" &&
        lane.watermark !== null &&
        lane.watermark.coveredThroughSequence >= sceneTurn.sequenceInScenario;
      if (!completeLane(ledgerTurn.on.openLoopLane) || !completeLane(ledgerTurn.on.memoryLane)) return [];
      return [`${scene.id}:t${sceneTurn.sequenceInScenario}`];
    });
  });
  const committedOpportunityTurnIds = opportunityTurns.filter((turnId) => {
    const [sceneId, sequence] = turnId.split(":t");
    const scene = scenes.find((entry) => entry.id === sceneId);
    const ledgerScenario = ledgerByScene.get(sceneId!);
    const turn = ledgerScenario?.turns.find((entry) => entry.sequenceInScenario === Number(sequence));
    return !!scene && !!ledgerScenario && !!turn && turn.on.segmentOutcome === "committed" &&
      selectedExpectedEligibleTarget(scene, ledgerScenario, turn);
  });
  const positiveTurnRows = scenes.flatMap((scene) => {
    if (scene.reviewIntent !== "pairwise_candidate") return [];
    const ledgerScenario = ledgerByScene.get(scene.id);
    return scene.turns.filter((sceneTurn) => sceneTurn.expect.selection === "segment").flatMap((sceneTurn) => {
      const turn = ledgerScenario?.turns.find((entry) => entry.sequenceInScenario === sceneTurn.sequenceInScenario);
      return turn ? [{ scene, sceneTurn, turn, ledgerScenario: ledgerScenario! }] : [];
    });
  });
  const mainOrdinaryQuestionSkips = positiveTurnRows.filter((row) => (row.turn.on.ordinaryQuestionCount ?? 0) > 0 && row.turn.on.selectionOutcome === "not_reached").length;
  const nonQuestionStageSkips = positiveTurnRows.filter((row) => (row.turn.on.ordinaryQuestionCount ?? 0) === 0 && row.turn.on.selectionOutcome === "not_reached").length;
  const incompleteOpportunityViews = positiveTurnRows.filter((row) => {
    if ((row.turn.on.ordinaryQuestionCount ?? 0) !== 0) return false;
    const isComplete = (lane: V5LedgerTurn["on"]["openLoopLane"]): boolean => lane.status === "complete" && lane.integrity === "valid" && lane.watermark !== null && lane.watermark.coveredThroughSequence >= row.sceneTurn.sequenceInScenario;
    return !isComplete(row.turn.on.openLoopLane) || !isComplete(row.turn.on.memoryLane);
  }).length;
  const expectedEligibleSelections = opportunityTurns.filter((turnId) => {
    const [sceneId, sequence] = turnId.split(":t");
    const scene = scenes.find((entry) => entry.id === sceneId);
    const ledgerScenario = ledgerByScene.get(sceneId!);
    const turn = ledgerScenario?.turns.find((entry) => entry.sequenceInScenario === Number(sequence));
    return !!scene && !!ledgerScenario && !!turn && selectedExpectedEligibleTarget(scene, ledgerScenario, turn);
  }).length;
  const recallFunnel = {
    predeclaredPositiveTurns: positiveTurnRows.length,
    mainOrdinaryQuestionSkips,
    nonQuestionStageSkips,
    incompleteOpportunityViews,
    executableOpportunities: opportunityTurns.length,
    expectedEligibleSelections,
    providerCalls: positiveTurnRows.reduce((sum, row) => sum + row.turn.on.segmentProviderCallCount, 0),
    committedEmits: positiveTurnRows.filter((row) => row.turn.on.segmentOutcome === "committed").length,
    typedOmits: positiveTurnRows.filter((row) => row.turn.on.segmentOutcome === "omitted").length,
    failures: positiveTurnRows.filter((row) => row.turn.on.segmentOutcome === "failed").length,
    notReached: positiveTurnRows.filter((row) => row.turn.on.segmentOutcome === "not_reached").length,
  };
  const recallRatio = opportunityTurns.length === 0
    ? 0
    : committedOpportunityTurnIds.length / opportunityTurns.length;
  const emittedCandidates = scenes.filter((scene) => scene.reviewIntent === "pairwise_candidate" &&
    ledgerByScene.get(scene.id)?.turns.some((turn) => turn.on.segmentOutcome === "committed"));
  const completeStatefulIds = new Set(emittedCandidates.filter((scene) => {
    if (scene.family !== "stateful_suppression") return false;
    const turns = ledgerByScene.get(scene.id)?.turns ?? [];
    const emit = turns.find((turn) => turn.on.segmentOutcome === "committed");
    return !!emit && turns.some((turn) => turn.sequenceInScenario > emit.sequenceInScenario &&
      turn.on.dispositionOutcome?.startsWith("recorded:") &&
      turn.on.suppressionStateAfterTurn.some((state) => state.eligibilityStatus === "suppressed"));
  }).map((scene) => scene.id));
  const sampleReady = input.catalog.purpose !== "formal" ||
    selectV5PairwiseSample({ candidates: emittedCandidates, completeStatefulSceneIds: completeStatefulIds }) !== null;
  const pendingSampleQuotas = sampleReady ? [] : ["10-case language, family, protected-category, or stateful sample quota"];
  if (input.catalog.purpose === "formal" && input.enforceRecallFloor !== false && recallRatio < 0.3) {
    failures.push(`complete emit recall ${(recallRatio * 100).toFixed(1)}% is below 30% (${committedOpportunityTurnIds.length}/${opportunityTurns.length})`);
  }

  const verification: V5TreatmentVerification = {
    catalogSha256: input.catalogSha256,
    checkedScenarioCount: scenes.length,
    eligibleScenarioIds,
    actualEmitScenarioIds,
    actualOmissionAuditScenarioIds,
    predeclaredOpportunityTurnIds: opportunityTurns,
    committedOpportunityTurnIds,
    recall: {
      numerator: committedOpportunityTurnIds.length,
      denominator: opportunityTurns.length,
      ratio: recallRatio,
    },
    recallFunnel,
    executedBatchIds: main.executedBatchIds,
    pendingSampleQuotas,
    inputFingerprints: [],
    failureCount: failures.length,
    failures,
    format: F3_V5_VERIFICATION_VERSION,
    ledgerSha256: input.ledgerSha256,
    offRunSha256: sha256(off),
    onRunSha256: sha256(on),
    passed: failures.length === 0,
    reviewReady: input.catalog.purpose !== "formal" || (sampleReady && recallRatio >= 0.3),
    sampleReady,
    synthetic: true,
    version: F3_V5_VERIFICATION_VERSION,
  };
  return {
    actualEmitScenarioIds,
    actualOmissionAuditScenarioIds,
    eligibleScenarioIds,
    predeclaredOpportunityTurnIds: opportunityTurns,
    committedOpportunityTurnIds,
    recallFunnel,
    sampleReady,
    pendingSampleQuotas,
    verification,
  };
}

function verifyScene(input: {
  failures: string[];
  ledgerScenario: V5LedgerScenario;
  mainTurns: ReadonlyMap<number, string>;
  offScenario: V5ArmRun["scenarios"][number];
  onScenario: V5ArmRun["scenarios"][number];
  scene: V5Scene;
}): void {
  const { failures, ledgerScenario, mainTurns, offScenario, onScenario, scene } =
    input;
  const fail = (message: string): void => {
    failures.push(`${scene.id}: ${message}`);
  };
  if (ledgerScenario.family !== scene.family) {
    fail(`ledger family ${ledgerScenario.family} does not match ${scene.family}`);
  }
  const classifiedSkip = (label: string): boolean =>
    label === "extract_skipped_empty" ||
    label === "extract_skipped_task_like" ||
    label === "extract_skipped_no_real_anchor" ||
    label === "extract_skipped_evidence_mismatch" ||
    label === "extract_skipped_admission_rule" ||
    label.startsWith("extract_failed:");
  const unclassified = ledgerScenario.openLoopSkipped.filter(
    (label) => !classifiedSkip(label),
  );
  if (unclassified.length > 0) {
    fail(`unclassified extraction skips: ${unclassified.join(",")}`);
  }
  const loopRefIndex = new Map(
    ledgerScenario.formedTargetRefs.map((entry) => [entry.targetId, entry.ref]),
  );
  const refToTargetKey = new Map(
    ledgerScenario.formedTargetRefs.map((entry) => [
      refKey(entry.ref),
      `open_loop:${entry.targetId}`,
    ]),
  );
  const ledgerTurns = new Map(
    ledgerScenario.turns.map((turn) => [turn.sequenceInScenario, turn]),
  );
  const statefulAnchorSequence =
    scene.family === "stateful_suppression"
      ? scene.turns.find((turn) => turn.expect.selection === "segment")
          ?.sequenceInScenario
      : undefined;
  const statefulAnchorHasCommittedUse = hasCommittedStatefulAnchorUse(
    scene,
    ledgerScenario,
  );
  const expectedDispositions: Array<{ signal: string; targetKey: string }> = [];
  for (const sceneTurn of scene.turns) {
    const offTurn = offScenario.turns.find(
      (turn) => turn.sequenceInScenario === sceneTurn.sequenceInScenario,
    );
    const onTurn = onScenario.turns.find(
      (turn) => turn.sequenceInScenario === sceneTurn.sequenceInScenario,
    );
    const ledgerTurn = ledgerTurns.get(sceneTurn.sequenceInScenario);
    const mainText = mainTurns.get(sceneTurn.sequenceInScenario);
    if (!offTurn || !onTurn || !ledgerTurn) {
      fail(`t${sceneTurn.sequenceInScenario}: missing turn evidence`);
      continue;
    }
    if (mainText === undefined) {
      fail(`t${sceneTurn.sequenceInScenario}: main capture is missing this turn`);
    } else if (offTurn.preCompositionMainText !== mainText) {
      fail(`t${sceneTurn.sequenceInScenario}: OFF did not replay the frozen main text`);
    }
    if (mainText !== undefined && onTurn.preCompositionMainText !== mainText) {
      fail(`t${sceneTurn.sequenceInScenario}: ON pre-composition response differs from frozen main`);
    }
    if (offTurn.preCompositionMainText !== offTurn.assistantText) {
      fail(`t${sceneTurn.sequenceInScenario}: OFF composed beyond the main text`);
    }
    if (ledgerTurn.off.g2CodePathEntered !== false) {
      fail(`t${sceneTurn.sequenceInScenario}: OFF entered the G2 code path`);
    }
    if (ledgerTurn.on.segmentOutcome === "committed" && onTurn.assistantText === offTurn.assistantText) {
      fail(`t${sceneTurn.sequenceInScenario}: committed segment never reached the transcript`);
    }
    if (ledgerTurn.on.segmentOutcome === "committed" && ledgerTurn.on.segmentProviderCallCount !== 1) {
      fail(`t${sceneTurn.sequenceInScenario}: committed emit did not come from exactly one Provider call`);
    }
    if (ledgerTurn.on.segmentOutcome === "committed" && mainText !== undefined) {
      if (
        ledgerTurn.on.segmentProviderCallCount !== 1 ||
        ledgerTurn.on.segmentCommandId === null ||
        ledgerTurn.on.segmentText === null ||
        ledgerTurn.on.segmentFingerprint !== sha256(ledgerTurn.on.segmentText) ||
        onTurn.assistantText !==
          composeProactiveFollowupResponse({
            mainText,
            segmentText: ledgerTurn.on.segmentText,
          })
      ) {
        fail(`t${sceneTurn.sequenceInScenario}: emitted response is not frozen main plus the recorded segment`);
      }
    }
    if (
      ledgerTurn.on.segmentOutcome === "omitted" &&
      ledgerTurn.on.segmentText !== null
    ) {
      fail(`t${sceneTurn.sequenceInScenario}: omitted segment carries unexpected text`);
    }
    const expectation = sceneTurn.expect;
    const skippedForOrdinaryQuestion =
      ledgerTurn.on.selectionOutcome === "not_reached" &&
      (ledgerTurn.on.ordinaryQuestionCount ?? 0) > 0;
    if (
      statefulAnchorSequence !== undefined &&
      sceneTurn.sequenceInScenario > statefulAnchorSequence &&
      !statefulAnchorHasCommittedUse
    ) {
      if (ledgerTurn.on.componentVersions.selection === undefined) {
        fail(`t${sceneTurn.sequenceInScenario}: component versions are missing`);
      }
      continue;
    }
    if (expectation.selection === "none" && ledgerTurn.on.segmentOutcome === "committed") {
      fail(`t${sceneTurn.sequenceInScenario}: unexpected segment committed`);
    }
    if (expectation.selection === "segment" && !skippedForOrdinaryQuestion) {
      if (ledgerTurn.on.selectionOutcome !== "selected") {
        fail(
          `t${sceneTurn.sequenceInScenario}: expected selection, got ${ledgerTurn.on.selectionOutcome} (${ledgerTurn.on.selectionReason ?? "no reason"})`,
        );
      }
      if (
        ledgerTurn.on.segmentOutcome !== "committed" &&
        ledgerTurn.on.segmentOutcome !== "omitted"
      ) {
        fail(
          `t${sceneTurn.sequenceInScenario}: expected emit or typed omit, got ${ledgerTurn.on.segmentOutcome}`,
        );
      }
      if (
        ledgerTurn.on.segmentOutcome === "committed" &&
        ledgerTurn.on.typedUseOutcome !== "committed"
      ) {
        fail(`t${sceneTurn.sequenceInScenario}: typed use is not committed`);
      }
      if (
        ledgerTurn.on.segmentOutcome === "omitted" &&
        !OMIT_REASONS.has(ledgerTurn.on.segmentOmitReason ?? "")
      ) {
        fail(`t${sceneTurn.sequenceInScenario}: typed omit reason is invalid`);
      }
      if (ledgerTurn.on.segmentOutcome === "omitted") {
        if (ledgerTurn.on.segmentProviderCallCount !== 1) {
          fail(`t${sceneTurn.sequenceInScenario}: typed omit did not come from exactly one Provider call`);
        }
        if (ledgerTurn.on.reservationOutcome !== "released") {
          fail(`t${sceneTurn.sequenceInScenario}: omitted reservation was not released`);
        }
        if (ledgerTurn.on.typedUseOutcome !== null) {
          fail(`t${sceneTurn.sequenceInScenario}: omitted segment committed a typed use`);
        }
        if (mainText !== undefined && onTurn.assistantText !== mainText) {
          fail(`t${sceneTurn.sequenceInScenario}: omitted segment changed the main response`);
        }
      }
      if (expectation.target && ledgerTurn.on.selectedTargetRef === null) {
        fail(`t${sceneTurn.sequenceInScenario}: selected target reference is missing`);
      }
      if (expectation.target && ledgerTurn.on.selectedTargetRef !== null) {
        const declared = refKey(expectation.target);
        const selected = ledgerTurn.on.selectedTargetRef;
        const selectedMatches =
          selected === declared ||
          (() => {
            const loopId = selected.replace(/^open_loop:/, "");
            const ref = loopRefIndex.get(loopId);
            return ref !== undefined && matchedRefsEqual(ref, expectation.target!);
          })();
        if (!selectedMatches) {
          fail(
            `t${sceneTurn.sequenceInScenario}: selected ${selected}, declared ${declared}`,
          );
        }
        if (ledgerTurn.on.selectionOutcome === "selected" &&
          !selectedExpectedEligibleTarget(scene, ledgerScenario, ledgerTurn)) {
          fail(`t${sceneTurn.sequenceInScenario}: expected target was not eligible in the complete candidate pool`);
        }
      }
    }
    if (
      scene.family === "competing_pool" &&
      expectation.selection === "segment" &&
      !skippedForOrdinaryQuestion
    ) {
      const selectedTarget = expectation.target;
      const competitors = scene.competitors ?? [];
      if (!selectedTarget || competitors.length === 0) {
        fail(`t${sceneTurn.sequenceInScenario}: competing selection lacks a declared winner or competitor`);
      } else {
        const declaredPool = [selectedTarget, ...competitors];
        const uniquePoolKeys = new Set(declaredPool.map(refKey));
        if (uniquePoolKeys.size !== declaredPool.length) {
          fail(`t${sceneTurn.sequenceInScenario}: competing target is duplicated`);
        }
        for (const target of declaredPool) {
          const candidate = ledgerTurn.on.candidates.find((entry) => {
            if (target.kind === "memory_claim") {
              return entry.targetRef === `memory_claim:${target.memoryId}`;
            }
            if (!entry.targetRef.startsWith("open_loop:")) return false;
            const loopId = entry.targetRef.slice("open_loop:".length);
            const ref = loopRefIndex.get(loopId);
            return ref !== undefined && matchedRefsEqual(ref, target);
          });
          if (!candidate) {
            fail(`t${sceneTurn.sequenceInScenario}: declared competing target ${refKey(target)} is missing from the candidate pool`);
            continue;
          }
          if (
            candidate.current !== true ||
            candidate.eligible !== true ||
            candidate.trustFence !== "valid" ||
            candidate.mentionedInExchange ||
            candidate.formedInCurrentTurn ||
            candidate.exclusionReason !== null ||
            candidate.rankTuple === null
          ) {
            fail(`t${sceneTurn.sequenceInScenario}: declared competing target ${refKey(target)} was not eligible to win`);
          }
          if (
            refKey(target) !== refKey(selectedTarget) &&
            candidate.targetRef === ledgerTurn.on.selectedTargetRef
          ) {
            fail(`t${sceneTurn.sequenceInScenario}: losing competitor was selected`);
          }
        }
      }
    }
    const stageRan = ledgerTurn.on.selectionOutcome !== "not_reached";
    if (expectation.zeroReason && ledgerTurn.on.selectionOutcome === "none") {
      if (ledgerTurn.on.selectionReason !== expectation.zeroReason) {
        fail(
          `t${sceneTurn.sequenceInScenario}: zero reason ${ledgerTurn.on.selectionReason ?? "null"} does not match ${expectation.zeroReason}`,
        );
      }
    }
    if (expectation.zeroReason && ledgerTurn.on.selectionOutcome === "not_reached") {
      if (ledgerTurn.on.ordinaryQuestionCount === 0) {
        fail(
          `t${sceneTurn.sequenceInScenario}: proactive stage was skipped without an ordinary question`,
        );
      }
    }
    if (expectation.excludedTarget && !stageRan && !skippedForOrdinaryQuestion) {
      if (ledgerTurn.on.ordinaryQuestionCount === 0) {
        fail(
          `t${sceneTurn.sequenceInScenario}: stage was skipped without an ordinary question`,
        );
      }
    }
    if (expectation.excludedTarget && stageRan) {
      const declared = refKey(expectation.excludedTarget);
      const found = ledgerTurn.on.candidates.some((candidate) => {
        if (candidate.targetRef === declared) return true;
        const ref = loopRefIndex.get(candidate.targetRef.replace(/^open_loop:/, ""));
        return (
          ref !== undefined &&
          matchedRefsEqual(ref, expectation.excludedTarget!)
        );
      });
      if (!found) {
        fail(
          `t${sceneTurn.sequenceInScenario}: excluded target ${declared} is missing from the candidate pool`,
        );
      }
      const matchesExcluded = (candidate: (typeof ledgerTurn.on.candidates)[number]): boolean => {
        if (candidate.targetRef === declared) return true;
        const ref = loopRefIndex.get(
          candidate.targetRef.replace(/^open_loop:/, ""),
        );
        return (
          ref !== undefined &&
          matchedRefsEqual(ref, expectation.excludedTarget!)
        );
      };
      if (
        expectation.excludedReason &&
        !ledgerTurn.on.candidates.some((candidate) => {
          if (!matchesExcluded(candidate)) return false;
          if (candidate.exclusionReason === expectation.excludedReason) {
            return true;
          }
          // Production checks candidate eligibility before the
          // current-turn rule, so a loop formed this turn that is not yet
          // eligible (a future dated window) is excluded as
          // candidate_not_eligible. The declared proof stays "formed in
          // this turn and not selected".
          return (
            expectation.excludedReason === "formed_in_current_turn" &&
            candidate.formedInCurrentTurn === true &&
            candidate.current === true &&
            candidate.exclusionReason === "candidate_not_eligible"
          );
        })
      ) {
        fail(
          `t${sceneTurn.sequenceInScenario}: exclusion reason ${expectation.excludedReason} not visible for ${declared}`,
        );
      }
    }
    if (expectation.disposition) {
      expectedDispositions.push({
        signal: expectation.disposition.signal,
        targetKey: refKey(expectation.disposition.target),
      });
    }
    for (const disposition of expectedDispositions) {
      if (
        ledgerTurn.on.dispositionOutcome !== `recorded:${disposition.signal}`
      ) {
        continue;
      }
      const dispositionTargetKey =
        refToTargetKey.get(disposition.targetKey) ?? disposition.targetKey;
      const state = ledgerTurn.on.suppressionStateAfterTurn.find(
        (entry) =>
          `${entry.targetKind}:${entry.targetId}` === dispositionTargetKey,
      );
      if (disposition.signal === "refused") {
        if (state && state.suppressedUntilAt !== null) {
          fail(`t${sceneTurn.sequenceInScenario}: refused cooldown is not indefinite`);
        }
        if (state && state.suppressionReason !== "refused") {
          fail(`t${sceneTurn.sequenceInScenario}: refusal state reason is ${state.suppressionReason}`);
        }
      }
    }
    if (expectation.release) {
      if (ledgerTurn.on.releaseOutcome !== "released:cooldown_elapsed") {
        fail(
          `t${sceneTurn.sequenceInScenario}: expected cooldown release, got ${ledgerTurn.on.releaseOutcome ?? "null"}`,
        );
      }
    }
    if (
      expectation.selection === "none" &&
      expectation.excludedReason === "suppressed" &&
      stageRan
    ) {
      const declared = expectation.suppressedAfter
        ? (refToTargetKey.get(refKey(expectation.suppressedAfter)) ??
          refKey(expectation.suppressedAfter))
        : null;
      const stateMatched = ledgerTurn.on.suppressionStateAfterTurn.some(
        (entry) => (declared === null ? true : `${entry.targetKind}:${entry.targetId}` === declared),
      );
      if (!stateMatched) {
        fail(
          `t${sceneTurn.sequenceInScenario}: suppression checkpoint has no matching state`,
        );
      }
    }
    if (ledgerTurn.on.componentVersions.selection === undefined) {
      fail(`t${sceneTurn.sequenceInScenario}: component versions are missing`);
    }
    if (expectation.selection === "segment" && !skippedForOrdinaryQuestion) {
      const family = scene.family;
      if (
        family === "positive_memory" ||
        family === "competing_pool"
      ) {
        const memoryChosen =
          ledgerTurn.on.selectedTargetRef !== null &&
          ledgerTurn.on.selectedTargetRef.startsWith("memory_claim:");
        if (family === "positive_memory" && !memoryChosen) {
          fail(`t${sceneTurn.sequenceInScenario}: memory scene did not select a Memory Claim`);
        }
      }
    }
  }
  if (ledgerScenario.family === "correct_zero" && ledgerScenario.turns.some((turn) => turn.on.segmentOutcome === "committed")) {
    fail("correct_zero scene committed a segment");
  }
  const declaresLoop =
    (scene.competitors ?? []).some((ref) => ref.kind === "open_loop") ||
    scene.turns.some((sceneTurn) => {
      const refs = [
        sceneTurn.expect.target,
        sceneTurn.expect.excludedTarget,
        sceneTurn.expect.disposition?.target,
        sceneTurn.expect.release?.target,
        sceneTurn.expect.suppressedAfter,
      ];
      return refs.some((ref) => ref?.kind === "open_loop");
    });
  if (!declaresLoop && (ledgerScenario.formedLoopSchedules?.length ?? 0) > 0) {
    fail("scene formed a loop although no open_loop target is declared");
  }
}

/**
 * Coverage checks for the whole pool. Fail-closed: every minimum is enforced.
 */
export function verifyG2PoolCoverage(input: Readonly<{
  catalogVerified: boolean;
  catalog: V5CatalogManifest;
  scenes: readonly V5Scene[];
  eligibleScenarioIds: readonly string[];
  ledger: V5TreatmentLedger;
  recall: V5TreatmentVerification["recall"];
  deferSampleGate?: boolean;
}>): Readonly<{
  failures: readonly string[];
  sampleReady: boolean;
  pendingSampleQuotas: readonly string[];
}> {
  const failures: string[] = [];
  if (!input.catalogVerified) failures.push("fixture catalog did not verify");
  const ledgerById = new Map(input.ledger.scenarios.map((scene) => [scene.fixtureId, scene]));
  const emitScenes = input.scenes.filter((scene) => scene.reviewIntent === "pairwise_candidate" &&
    ledgerById.get(scene.id)?.turns.some((turn) => turn.on.segmentOutcome === "committed"));
  let sampleReady = input.catalog.purpose !== "formal";
  if (input.catalog.purpose === "formal") {
    const completeStatefulIds = new Set(emitScenes.filter((scene) => {
      if (scene.family !== "stateful_suppression") return false;
      const turns = ledgerById.get(scene.id)?.turns ?? [];
      const emit = turns.find((turn) => turn.on.segmentOutcome === "committed");
      return !!emit && turns.some((turn) =>
        turn.sequenceInScenario > emit.sequenceInScenario &&
        turn.on.dispositionOutcome?.startsWith("recorded:") &&
        turn.on.suppressionStateAfterTurn.some((state) => state.eligibilityStatus === "suppressed"));
    }).map((scene) => scene.id));
    sampleReady = selectV5PairwiseSample({ candidates: emitScenes, completeStatefulSceneIds: completeStatefulIds }) !== null;
    if (!sampleReady && input.deferSampleGate !== true) {
      failures.push("actual emit scenes cannot satisfy the frozen 10-scene language, family, protected, and stateful quotas");
    }
    if ((sampleReady || input.deferSampleGate !== true) && (input.recall.denominator === 0 || input.recall.ratio < 0.3)) {
      failures.push(`complete emit recall ${input.recall.numerator}/${input.recall.denominator} does not meet the 30% gate`);
    }
  }
  const selectedKind = (scene: V5Scene): "open_loop" | "memory_claim" | null => {
    const ref = ledgerById
      .get(scene.id)
      ?.turns.find((turn) => turn.on.segmentOutcome === "committed")
      ?.on.selectedTargetRef;
    if (ref?.startsWith("open_loop:")) return "open_loop";
    if (ref?.startsWith("memory_claim:")) return "memory_claim";
    return null;
  };
  for (const [kind, minimum] of [["open_loop", 1], ["memory_claim", 1]] as const) {
    const count = emitScenes.filter((scene) => selectedKind(scene) === kind).length;
    if (input.catalog.purpose === "formal" && count < minimum && input.deferSampleGate !== true) failures.push(`actual ${kind} emits: ${count}; no review-eligible examples`);
  }
  const statefulTrajectories = emitScenes.filter((scene) => {
    if (scene.family !== "stateful_suppression") return false;
    const ledger = ledgerById.get(scene.id);
    const emit = ledger?.turns.find((turn) => turn.on.segmentOutcome === "committed");
    if (!ledger || !emit) return false;
    return ledger.turns.some(
      (turn) =>
        turn.sequenceInScenario > emit.sequenceInScenario &&
        turn.on.dispositionOutcome?.startsWith("recorded:") &&
        turn.on.suppressionStateAfterTurn.some(
          (state) => state.eligibilityStatus === "suppressed",
        ),
    );
  });
  if (input.catalog.purpose === "formal" && statefulTrajectories.length < 2 && input.deferSampleGate !== true) failures.push(`complete emitted stateful trajectories: ${statefulTrajectories.length}; need 2`);
  const competingEmits = emitScenes.filter((scene) => scene.family === "competing_pool");
  if (input.catalog.purpose === "formal" && competingEmits.length < 1 && input.deferSampleGate !== true) failures.push("no competing-pool emit is available for the review sample");

  if (input.catalog.purpose === "formal") for (const protectedCategory of [
    "refusal",
    "short_answer",
    "topic_change",
    "direct_task",
  ] as const) {
    if (
      !emitScenes.some((scene) => scene.protectedCategories.includes(protectedCategory))
      && input.deferSampleGate !== true) {
      failures.push(`protected category ${protectedCategory} is absent from actual emit scenes`);
    }
  }

  const omissionScenes = input.scenes.filter((scene) => scene.reviewIntent === "omission_audit");
  const omissionExpected = input.catalog.purpose === "calibration" ? 12 : 8;
  if (omissionScenes.length !== omissionExpected) failures.push(`typed omission audit declares ${omissionScenes.length} cases; needs ${omissionExpected}`);
  const actualOmissionReasons = new Map<string, number>();
  for (const scene of omissionScenes) {
    const ledger = ledgerById.get(scene.id);
    const declaredTurn = scene.turns.find((turn) => turn.expect.selection === "segment");
    const actual = ledger?.turns.find(
      (turn) => turn.sequenceInScenario === declaredTurn?.sequenceInScenario,
    );
    if (
      !declaredTurn ||
      !actual ||
      !isActualV5TypedOmission(actual, scene.expectedOmissionReason)
    ) {
      failures.push(`${scene.id}: declared omission audit case is not a matching typed omit`);
      continue;
    }
    const actualReason = actual.on.segmentOmitReason;
    if (actualReason) actualOmissionReasons.set(actualReason, (actualOmissionReasons.get(actualReason) ?? 0) + 1);
  }
  for (const reason of [
    "no_genuine_opportunity",
    "duplicates_main_response",
    "insufficient_grounding",
    "timing_not_natural",
  ]) {
    const required = input.catalog.purpose === "calibration" ? 3 : 2;
    if ((actualOmissionReasons.get(reason) ?? 0) !== required) failures.push(`typed omission audit has ${actualOmissionReasons.get(reason) ?? 0} ${reason}; needs ${required}`);
  }

  for (const scene of input.scenes.filter((entry) => entry.family === "correct_zero")) {
    const ledger = ledgerById.get(scene.id);
    if (
      ledger?.turns.some(
        (turn) =>
          turn.on.segmentProviderCallCount !== 0 ||
          turn.on.segmentOutcome === "committed" ||
          turn.on.segmentOutcome === "failed" ||
          turn.on.selectedTargetRef !== null ||
          turn.on.reservationOutcome !== null ||
          turn.on.segmentCommandId !== null ||
          turn.on.typedUseOutcome !== null ||
          turn.on.dispositionProviderCallCount !== 0 ||
          turn.on.dispositionOutcome !== null ||
          turn.on.releaseOutcome !== null ||
          turn.on.suppressionStateAfterTurn.length !== 0 ||
          (turn.on.segmentOutcome === "omitted" &&
            turn.on.segmentOmitReason !== null),
      )
    ) {
      failures.push(`${scene.id}: correct_zero entered expression generation`);
    }
  }
  return {
    failures,
    sampleReady,
    pendingSampleQuotas: sampleReady ? [] : ["10-case language, family, protected-category, or stateful sample quota"],
  };
}

function parseCliPaths(argv: readonly string[]): Readonly<{
  batchManifest: string;
  catalog: string;
  expressionSelection: string;
  ledger: string;
  mainRun: string;
  offRun: string;
  onRun: string;
  pins: string;
  preregistration: string;
  sampleSeed: string;
  verification: string;
}> {
  const values = {
    batchManifest: "eval/continuation-acceptance-1a3b/run-v5/batch-merge-manifest.json",
    catalog: "eval/continuation-acceptance-1a3b/fixtures-v5.json",
    expressionSelection: "eval/continuation-acceptance-1a3b/run-v5/operator/expression-selection.json",
    ledger: "eval/continuation-acceptance-1a3b/run-v5/treatment-ledger.json",
    mainRun: "eval/continuation-acceptance-1a3b/run-v5/continuation-main.json",
    offRun: "eval/continuation-acceptance-1a3b/run-v5/continuation-off.json",
    onRun: "eval/continuation-acceptance-1a3b/run-v5/continuation-on.json",
    pins: "eval/continuation-acceptance-1a3b/pins-v5.json",
    preregistration: "eval/continuation-acceptance-1a3b/preregistration-v5.json",
    sampleSeed: "eval/continuation-acceptance-1a3b/review-seed-v5.json",
    verification: "eval/continuation-acceptance-1a3b/run-v5/verification.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[++index] ?? "";
    if (argument === "--batch-manifest") values.batchManifest = next;
    else if (argument === "--catalog") values.catalog = next;
    else if (argument === "--expression-selection") values.expressionSelection = next;
    else if (argument === "--ledger") values.ledger = next;
    else if (argument === "--main-run") values.mainRun = next;
    else if (argument === "--off-run") values.offRun = next;
    else if (argument === "--on-run") values.onRun = next;
    else if (argument === "--pins") values.pins = next;
    else if (argument === "--preregistration") values.preregistration = next;
    else if (argument === "--sample-seed") values.sampleSeed = next;
    else if (argument === "--verification") values.verification = next;
  }
  return values;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const paths = parseCliPaths(process.argv.slice(2));
  const read = async <T>(path: string): Promise<T> =>
    JSON.parse(await readFile(resolve(root, path), "utf8")) as T;
  const readRaw = async (path: string): Promise<string> =>
    readFile(resolve(root, path), "utf8");
  const catalog = await read<V5CatalogManifest>(paths.catalog);
  const catalogVerification = await verifyV5Catalog({ manifest: catalog, root });
  if (!catalogVerification.passed) {
    throw new V5TreatmentVerificationError(
      `fixture catalog failed: ${catalogVerification.mismatches.join("; ")}`,
    );
  }
  const sceneFiles = await Promise.all(
    catalog.sceneFiles.map((entry) => read<V5SceneFile>(entry.path)),
  );
  const scenes = sceneFiles.flatMap((file) => file.scenes);
  const raw = await Promise.all([
    readRaw(paths.catalog),
    readRaw(paths.ledger),
    readRaw(paths.pins),
    readRaw(paths.expressionSelection),
    readRaw(paths.mainRun),
    readRaw(paths.offRun),
    readRaw(paths.onRun),
    readRaw(paths.sampleSeed),
    ...(catalog.purpose === "formal"
      ? [readRaw(paths.preregistration), readRaw("eval/continuation-acceptance-1a3b/formal-positive-counts-v5.json"), readRaw(paths.batchManifest)]
      : []),
    ...catalog.sceneFiles.map((entry) => readRaw(entry.path)),
  ]);
  const mainRun = await read<V5MainRun>(paths.mainRun);
  const offRun = await read<V5ArmRun>(paths.offRun);
  const onRun = await read<V5ArmRun>(paths.onRun);
  const pins = JSON.parse(raw[2]!) as V5Pins;
  const expressionSelection = JSON.parse(raw[3]!) as V5ExpressionSelectionManifest;
  const ledger = JSON.parse(raw[1]!) as V5TreatmentLedger;
  let scenesToVerify = scenes;
  let batchManifest: V5BatchMergeManifest | null = null;
  const batchInputFingerprints: V5TreatmentVerification["inputFingerprints"][number][] = [];
  let hasRemainingBatches = false;
  const sampleSeed = JSON.parse(raw[7]!) as {
    version?: string;
    sampleSeed?: number;
    pairwiseSize?: number;
    languageQuotas?: Readonly<Record<string, number>>;
    armAssignmentSeedOffset?: number;
    armPositions?: Readonly<Record<string, number>>;
  };
  if (
    sampleSeed.version !== "1a3b-g2-review-seed:v5" ||
    sampleSeed.sampleSeed !== V5_SAMPLE_SEED ||
    sampleSeed.pairwiseSize !== V5_PAIRWISE_SIZE ||
    sampleSeed.armAssignmentSeedOffset !== 73 ||
    sampleSeed.armPositions?.A !== 5 ||
    sampleSeed.armPositions?.B !== 5 ||
    sampleSeed.languageQuotas?.en !== V5_LANGUAGE_QUOTAS.en ||
    sampleSeed.languageQuotas?.zh !== V5_LANGUAGE_QUOTAS.zh ||
    sampleSeed.languageQuotas?.code_switch !== V5_LANGUAGE_QUOTAS.code_switch
  ) {
    throw new V5TreatmentVerificationError("Frozen v5 sampling seed or quotas do not match the committed sample algorithm.");
  }
  if (catalog.purpose === "formal") {
    const preregistration = JSON.parse(raw[8]!) as {
      version: string;
      preregistrationSha256: string;
      inputs: readonly Readonly<{ path: string; rawSha256: string; canonicalJsonSha256: string }>[];
    };
    const { preregistrationSha256, ...preregistrationBody } = preregistration;
    const expectedPaths = [paths.catalog, ...catalog.sceneFiles.map((entry) => entry.path),
      "eval/continuation-acceptance-1a3b/formal-positive-counts-v5.json", paths.pins,
      paths.sampleSeed, paths.expressionSelection];
    if (preregistration.version !== "1a3b-g2-preregistration:v5" ||
        sha256(preregistrationBody) !== preregistrationSha256 ||
        expectedPaths.length !== preregistration.inputs.length ||
        expectedPaths.some((path) => !preregistration.inputs.some((entry) => entry.path === path))) {
      throw new V5TreatmentVerificationError("Formal pre-registration is missing, changed, or does not cover the captured inputs.");
    }
    for (const entry of preregistration.inputs) {
      const pinned = inputFingerprint(entry.path, await readRaw(entry.path));
      if (pinned.rawSha256 !== entry.rawSha256 || pinned.canonicalJsonSha256 !== entry.canonicalJsonSha256) {
        throw new V5TreatmentVerificationError(`Formal pre-registered input drifted: ${entry.path}`);
      }
    }
    batchManifest = JSON.parse(raw[10]!) as V5BatchMergeManifest;
    const { manifestSha256, ...batchManifestBody } = batchManifest;
    const declaredBatches = catalog.batches ?? [];
    if (batchManifest.version !== "1a3b-g2-batch-merge:v5" ||
        sha256(batchManifestBody) !== manifestSha256 ||
        batchManifest.executedBatchIds.length < 1 ||
        batchManifest.executedBatchIds.some((id, index) => declaredBatches[index]?.id !== id) ||
        canonicalJson(mainRun.executedBatchIds) !== canonicalJson(batchManifest.executedBatchIds)) {
      throw new V5TreatmentVerificationError("Formal capture batch manifest is invalid or does not match the preregistered prefix.");
    }
    for (const runIds of [offRun.executedBatchIds, onRun.executedBatchIds, ledger.executedBatchIds]) {
      if (canonicalJson(runIds) !== canonicalJson(batchManifest.executedBatchIds)) {
        throw new V5TreatmentVerificationError("Formal main, OFF, ON, and ledger batch lists differ.");
      }
    }
    if (batchManifest.batches.length !== batchManifest.executedBatchIds.length) {
      throw new V5TreatmentVerificationError("Formal batch source evidence is incomplete.");
    }
    for (const [index, id] of batchManifest.executedBatchIds.entries()) {
      const source = batchManifest.batches[index];
      if (!source || source.id !== id) throw new V5TreatmentVerificationError(`Formal batch source order mismatch at ${id}.`);
      const expectedPaths = {
        main: `eval/continuation-acceptance-1a3b/run-v5/batches/${id}/continuation-main.json`,
        off: `eval/continuation-acceptance-1a3b/run-v5/batches/${id}/continuation-off.json`,
        on: `eval/continuation-acceptance-1a3b/run-v5/batches/${id}/continuation-on.json`,
        ledger: `eval/continuation-acceptance-1a3b/run-v5/batches/${id}/treatment-ledger.json`,
      };
      for (const key of ["main", "off", "on", "ledger"] as const) {
        const entry = source[key];
        if (entry.path !== expectedPaths[key]) throw new V5TreatmentVerificationError(`${id}: unexpected ${key} capture path.`);
        const rawSource = await readRaw(entry.path);
        const actual = inputFingerprint(entry.path, rawSource);
        if (actual.rawSha256 !== entry.rawSha256 || actual.canonicalJsonSha256 !== entry.canonicalJsonSha256) {
          throw new V5TreatmentVerificationError(`${id}: ${key} capture changed after merge.`);
        }
        batchInputFingerprints.push(actual);
      }
    }
    const executedIds = new Set(batchManifest.executedBatchIds.flatMap((id) =>
      declaredBatches.find((batch) => batch.id === id)?.sceneIds ?? []));
    scenesToVerify = scenes.filter((scene) => executedIds.has(scene.id));
    const expectedIds = [...executedIds];
    for (const [label, ids] of [
      ["OFF", offRun.scenarios.map((scene) => scene.fixtureId)],
      ["ON", onRun.scenarios.map((scene) => scene.fixtureId)],
      ["ledger", ledger.scenarios.map((scene) => scene.fixtureId)],
    ] as const) {
      if (!v5RecordsMatchExactSet(ids, expectedIds)) {
        throw new V5TreatmentVerificationError(`${label} scenarios do not exactly cover the executed preregistered batches.`);
      }
    }
    const expectedTurnIds = scenesToVerify.flatMap((scene) => scene.turns.map((turn) => `${scene.id}:t${turn.sequenceInScenario}`));
    const actualTurnIds = mainRun.responses.map((turn) => `${turn.fixtureId}:t${turn.sequenceInScenario}`);
    if (!v5RecordsMatchExactSet(actualTurnIds, expectedTurnIds)) {
      throw new V5TreatmentVerificationError("Main responses do not exactly cover the executed scene and turn set.");
    }
    hasRemainingBatches = batchManifest.executedBatchIds.length < declaredBatches.length;
  } else if (mainRun.executedBatchIds.length !== 0 || offRun.executedBatchIds.length !== 0 ||
      onRun.executedBatchIds.length !== 0 || ledger.executedBatchIds.length !== 0) {
    throw new V5TreatmentVerificationError("Calibration captures cannot carry formal batch IDs.");
  }
  const report = verifyG2Treatment({
    catalog,
    catalogSha256: rawSha256(raw[0]!),
    expressionSelection,
    ledger,
    ledgerSha256: rawSha256(raw[1]!),
    main: mainRun,
    off: offRun,
    on: onRun,
    pins,
    scenes: scenesToVerify,
    enforceRecallFloor: false,
  });
  const poolFailures = verifyG2PoolCoverage({
    catalogVerified: catalogVerification.passed,
    catalog,
    scenes: scenesToVerify,
    eligibleScenarioIds: report.eligibleScenarioIds,
    ledger,
    recall: report.verification.recall,
    deferSampleGate: hasRemainingBatches && !report.sampleReady,
  });
  const failures = [...poolFailures.failures, ...report.verification.failures];
  const sampleReady = poolFailures.sampleReady;
  const pendingSampleQuotas = poolFailures.pendingSampleQuotas;
  const recallPassed = report.verification.recall.denominator > 0 && report.verification.recall.ratio >= 0.3;
  const reviewReady = catalog.purpose === "formal" && sampleReady && recallPassed && failures.length === 0;
  const output: V5TreatmentVerification = {
    ...report.verification,
    executedBatchIds: mainRun.executedBatchIds,
    pendingSampleQuotas,
    reviewReady,
    sampleReady,
    inputFingerprints: [
      inputFingerprint(paths.catalog, raw[0]!),
      inputFingerprint(paths.sampleSeed, raw[7]!),
      ...(catalog.purpose === "formal" ? [inputFingerprint(paths.preregistration, raw[8]!), inputFingerprint("eval/continuation-acceptance-1a3b/formal-positive-counts-v5.json", raw[9]!)] : []),
      ...(catalog.purpose === "formal" ? [inputFingerprint(paths.batchManifest, raw[10]!), ...batchInputFingerprints] : []),
      ...catalog.sceneFiles.map((entry, index) => inputFingerprint(entry.path, raw[index + (catalog.purpose === "formal" ? 11 : 8)]!)),
      inputFingerprint(paths.pins, raw[2]!),
      inputFingerprint(paths.expressionSelection, raw[3]!),
      inputFingerprint(paths.mainRun, raw[4]!),
      inputFingerprint(paths.offRun, raw[5]!),
      inputFingerprint(paths.onRun, raw[6]!),
      inputFingerprint(paths.ledger, raw[1]!),
    ],
    failureCount: failures.length,
    failures,
    passed: failures.length === 0,
  };
  if (process.env.G2_V5_AUDIT_ONLY !== "1") {
    await mkdir(resolve(root, paths.verification, ".."), { recursive: true });
    await writeFile(resolve(root, paths.verification), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({ eligible: report.eligibleScenarioIds, verification: output }, null, 2));
  if (!output.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("verify-g2-treatment-v5.ts")) {
  main().catch((error: unknown) => {
    console.error("[g2-treatment-verify] failed:", error);
    process.exitCode = 1;
  });
}
