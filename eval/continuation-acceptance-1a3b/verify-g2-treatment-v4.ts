/**
 * Issue #207 G2 v4 treatment verifier.
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
  F3_V4_ARM_RUN_VERSION,
  F3_V4_LEDGER_VERSION,
  F3_V4_MAIN_RUN_VERSION,
  F3_V4_VERIFICATION_VERSION,
  matchesV4TargetRef,
  v4ConfigurationFingerprint,
  type V4ArmRun,
  type V4CatalogManifest,
  type V4Family,
  type V4LedgerScenario,
  type V4LedgerTurn,
  type V4MainRun,
  type V4Pins,
  type V4Scene,
  type V4SceneFile,
  type V4TargetRef,
  type V4TreatmentLedger,
  type V4TreatmentVerification,
  type V4ExpressionSelectionManifest,
} from "./protocol-v4";

const OMIT_REASONS = new Set([
  "no_genuine_opportunity",
  "duplicates_main_response",
  "insufficient_grounding",
  "timing_not_natural",
]);
import { verifyV4Catalog } from "./verify-fixtures-v4";

export class V4TreatmentVerificationError extends Error {}

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
  scenes: readonly V4Scene[],
  fixtureId: string,
): V4Family | null {
  return scenes.find((scene) => scene.id === fixtureId)?.family ?? null;
}

function refKey(ref: V4TargetRef): string {
  return ref.kind === "memory_claim"
    ? `memory_claim:${ref.memoryId}`
    : `open_loop:${ref.sourceTurn}:${ref.ordinal}`;
}

function matchedRefsEqual(left: V4TargetRef, right: V4TargetRef): boolean {
  return matchesV4TargetRef(left, right);
}

export type V4TreatmentVerificationReport = Readonly<{
  verification: V4TreatmentVerification;
  eligibleScenarioIds: readonly string[];
  actualEmitScenarioIds: readonly string[];
  actualOmissionAuditScenarioIds: readonly string[];
}>;

/**
 * Verify the arm runs and ledger against the fixture expectations. Returns a
 * report whose `verification.passed` is false on any failure; callers must not
 * treat a failed report as a package gate pass.
 */
export function verifyG2Treatment(input: Readonly<{
  catalog: V4CatalogManifest;
  catalogSha256: string;
  expressionSelection: V4ExpressionSelectionManifest;
  ledger: V4TreatmentLedger;
  ledgerSha256: string;
  main: V4MainRun;
  off: V4ArmRun;
  on: V4ArmRun;
  pins: V4Pins;
  scenes: readonly V4Scene[];
}>): V4TreatmentVerificationReport {
  const failures: string[] = [];
  const { ledger, main, off, on, scenes } = input;

  if (
    main.evaluatorCommit !== off.evaluatorCommit ||
    main.evaluatorCommit !== on.evaluatorCommit ||
    main.evaluatorCommit !== ledger.evaluatorCommit
  ) {
    failures.push("main, OFF, ON, and ledger evaluator commits do not match");
  }

  if (main.version !== F3_V4_MAIN_RUN_VERSION) {
    failures.push(`main run version ${main.version} is not v4`);
  }
  if (off.version !== F3_V4_ARM_RUN_VERSION || on.version !== F3_V4_ARM_RUN_VERSION) {
    failures.push("arm run version is not v4");
  }
  if (ledger.version !== F3_V4_LEDGER_VERSION) {
    failures.push(`ledger version ${ledger.version} is not v4`);
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
  if (input.pins.version !== "1a3b-g2-pins:v4" || !input.pins.syntheticOnly) {
    failures.push("pins are not a synthetic v4 pin set");
  }
  const expectedOff = input.pins.continuation.arms.off.id;
  const expectedOn = input.pins.continuation.arms.on.id;
  if (off.configId !== expectedOff || on.configId !== expectedOn) {
    failures.push("arm configuration IDs do not match v4 pins");
  }
  try {
    if (off.configurationFingerprint !== v4ConfigurationFingerprint(input.pins, expectedOff)) {
      failures.push("OFF configuration fingerprint differs from v4 pins");
    }
    if (on.configurationFingerprint !== v4ConfigurationFingerprint(input.pins, expectedOn)) {
      failures.push("ON configuration fingerprint differs from v4 pins");
    }
  } catch {
    failures.push("v4 pin configuration fingerprint could not be reconstructed");
  }
  if (ledger.configId !== expectedOn || ledger.configurationFingerprint !== on.configurationFingerprint) {
    failures.push("ledger configuration differs from ON run or v4 pins");
  }
  const selection = input.expressionSelection;
  const winner = input.pins.expression.configurations.find(
    (configuration) => configuration.id === selection.winnerConfigId,
  );
  if (
    selection.version !== "1a3b-g2-expression-decision:v4" ||
    input.pins.expression.selectedConfigId !== selection.winnerConfigId ||
    !winner ||
    selection.winnerRolePinSha256 !== sha256(winner.pin)
  ) {
    failures.push("expression selection does not match the pinned v4 role configuration");
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
    const ids = records.map((entry) => label === "ledger" ? (entry as V4LedgerScenario).fixtureId : (entry as V4ArmRun["scenarios"][number]).fixtureId);
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
          (turn) =>
            turn.on.selectionOutcome === "selected" &&
            turn.on.segmentProviderCallCount === 1 &&
            turn.on.segmentOutcome === "omitted" &&
            OMIT_REASONS.has(turn.on.segmentOmitReason ?? "") &&
            turn.on.reservationOutcome === "released",
        ),
    )
    .map((scene) => scene.id);

  const verification: V4TreatmentVerification = {
    catalogSha256: input.catalogSha256,
    checkedScenarioCount: scenes.length,
    eligibleScenarioIds,
    actualEmitScenarioIds,
    actualOmissionAuditScenarioIds,
    inputFingerprints: [],
    failureCount: failures.length,
    failures,
    format: F3_V4_VERIFICATION_VERSION,
    ledgerSha256: input.ledgerSha256,
    offRunSha256: sha256(off),
    onRunSha256: sha256(on),
    passed: failures.length === 0,
    synthetic: true,
    version: F3_V4_VERIFICATION_VERSION,
  };
  return {
    actualEmitScenarioIds,
    actualOmissionAuditScenarioIds,
    eligibleScenarioIds,
    verification,
  };
}

function verifyScene(input: {
  failures: string[];
  ledgerScenario: V4LedgerScenario;
  mainTurns: ReadonlyMap<number, string>;
  offScenario: V4ArmRun["scenarios"][number];
  onScenario: V4ArmRun["scenarios"][number];
  scene: V4Scene;
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
  let statefulAnchorOmitted = false;
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
    if (ledgerTurn.on.segmentOutcome === "committed" && mainText !== undefined) {
      if (
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
    if (expectation.selection === "none" && ledgerTurn.on.segmentOutcome === "committed") {
      fail(`t${sceneTurn.sequenceInScenario}: unexpected segment committed`);
    }
    if (
      statefulAnchorOmitted &&
      statefulAnchorSequence !== undefined &&
      sceneTurn.sequenceInScenario > statefulAnchorSequence
    ) {
      if (ledgerTurn.on.componentVersions.selection === undefined) {
        fail(`t${sceneTurn.sequenceInScenario}: component versions are missing`);
      }
      continue;
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
        if (ledgerTurn.on.reservationOutcome !== "released") {
          fail(`t${sceneTurn.sequenceInScenario}: omitted reservation was not released`);
        }
        if (ledgerTurn.on.typedUseOutcome !== null) {
          fail(`t${sceneTurn.sequenceInScenario}: omitted segment committed a typed use`);
        }
        if (mainText !== undefined && onTurn.assistantText !== mainText) {
          fail(`t${sceneTurn.sequenceInScenario}: omitted segment changed the main response`);
        }
        if (sceneTurn.sequenceInScenario === statefulAnchorSequence) {
          statefulAnchorOmitted = true;
        }
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
  scenes: readonly V4Scene[];
  eligibleScenarioIds: readonly string[];
  ledger: V4TreatmentLedger;
}>): readonly string[] {
  const failures: string[] = [];
  if (!input.catalogVerified) failures.push("fixture catalog did not verify");
  const ledgerById = new Map(input.ledger.scenarios.map((scene) => [scene.fixtureId, scene]));
  const emitScenes = input.scenes.filter((scene) =>
    ledgerById.get(scene.id)?.turns.some(
      (turn) => turn.on.segmentOutcome === "committed",
    ),
  );
  if (emitScenes.length < 15) {
    failures.push(`only ${emitScenes.length} actual emit scenes; 15 are required`);
  }
  const selectedKind = (scene: V4Scene): "open_loop" | "memory_claim" | null => {
    const ref = ledgerById
      .get(scene.id)
      ?.turns.find((turn) => turn.on.segmentOutcome === "committed")
      ?.on.selectedTargetRef;
    if (ref?.startsWith("open_loop:")) return "open_loop";
    if (ref?.startsWith("memory_claim:")) return "memory_claim";
    return null;
  };
  for (const [kind, minimum] of [["open_loop", 4], ["memory_claim", 4]] as const) {
    const count = emitScenes.filter((scene) => selectedKind(scene) === kind).length;
    if (count < minimum) failures.push(`actual ${kind} emits: ${count}; need ${minimum}`);
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
  if (statefulTrajectories.length < 3) {
    failures.push(`complete emitted stateful trajectories: ${statefulTrajectories.length}; need 3`);
  }
  const competingEmits = emitScenes.filter((scene) => scene.family === "competing_pool");
  if (competingEmits.length < 2) failures.push(`competing-pool emits: ${competingEmits.length}; need 2`);

  for (const protectedCategory of [
    "refusal",
    "short_answer",
    "topic_change",
    "direct_task",
  ] as const) {
    if (
      !emitScenes.some((scene) => scene.protectedCategories.includes(protectedCategory))
    ) {
      failures.push(`protected category ${protectedCategory} is absent from actual emit scenes`);
    }
  }

  const omissionScenes = input.scenes.filter((scene) => scene.reviewIntent === "omission_audit");
  if (omissionScenes.length !== 8) failures.push(`typed omission audit declares ${omissionScenes.length} cases; needs 8`);
  const actualOmissionReasons = new Set<string>();
  for (const scene of omissionScenes) {
    const ledger = ledgerById.get(scene.id);
    const declaredTurn = scene.turns.find((turn) => turn.expect.selection === "segment");
    const actual = ledger?.turns.find(
      (turn) => turn.sequenceInScenario === declaredTurn?.sequenceInScenario,
    );
    if (
      !declaredTurn ||
      !actual ||
      actual.on.segmentOutcome !== "omitted" ||
      actual.on.segmentOmitReason !== scene.expectedOmissionReason ||
      actual.on.reservationOutcome !== "released" ||
      actual.on.typedUseOutcome !== null ||
      actual.on.dispositionOutcome !== null
    ) {
      failures.push(`${scene.id}: declared omission audit case is not a matching typed omit`);
      continue;
    }
    actualOmissionReasons.add(actual.on.segmentOmitReason);
  }
  for (const reason of [
    "no_genuine_opportunity",
    "duplicates_main_response",
    "insufficient_grounding",
    "timing_not_natural",
  ]) {
    if (!actualOmissionReasons.has(reason)) failures.push(`typed omission audit lacks ${reason}`);
  }

  for (const scene of input.scenes.filter((entry) => entry.family === "correct_zero")) {
    const ledger = ledgerById.get(scene.id);
    if (
      ledger?.turns.some(
        (turn) =>
          turn.on.segmentProviderCallCount !== 0 ||
          turn.on.segmentOutcome === "committed" ||
          turn.on.selectedTargetRef !== null ||
          turn.on.reservationOutcome !== null ||
          turn.on.segmentCommandId !== null ||
          (turn.on.segmentOutcome === "omitted" &&
            turn.on.segmentOmitReason !== null),
      )
    ) {
      failures.push(`${scene.id}: correct_zero entered expression generation`);
    }
  }
  return failures;
}

function parseCliPaths(argv: readonly string[]): Readonly<{
  catalog: string;
  expressionSelection: string;
  ledger: string;
  mainRun: string;
  offRun: string;
  onRun: string;
  pins: string;
  verification: string;
}> {
  const values = {
    catalog: "eval/continuation-acceptance-1a3b/fixtures-v4.json",
    expressionSelection: "eval/continuation-acceptance-1a3b/run-v4/operator/expression-selection.json",
    ledger: "eval/continuation-acceptance-1a3b/run-v4/treatment-ledger.json",
    mainRun: "eval/continuation-acceptance-1a3b/run-v4/continuation-main.json",
    offRun: "eval/continuation-acceptance-1a3b/run-v4/continuation-off.json",
    onRun: "eval/continuation-acceptance-1a3b/run-v4/continuation-on.json",
    pins: "eval/continuation-acceptance-1a3b/pins-v4.json",
    verification: "eval/continuation-acceptance-1a3b/run-v4/verification.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[++index] ?? "";
    if (argument === "--catalog") values.catalog = next;
    else if (argument === "--expression-selection") values.expressionSelection = next;
    else if (argument === "--ledger") values.ledger = next;
    else if (argument === "--main-run") values.mainRun = next;
    else if (argument === "--off-run") values.offRun = next;
    else if (argument === "--on-run") values.onRun = next;
    else if (argument === "--pins") values.pins = next;
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
  const catalog = await read<V4CatalogManifest>(paths.catalog);
  const catalogVerification = await verifyV4Catalog({ manifest: catalog, root });
  if (!catalogVerification.passed) {
    throw new V4TreatmentVerificationError(
      `fixture catalog failed: ${catalogVerification.mismatches.join("; ")}`,
    );
  }
  const sceneFiles = await Promise.all(
    catalog.sceneFiles.map((entry) => read<V4SceneFile>(entry.path)),
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
    ...catalog.sceneFiles.map((entry) => readRaw(entry.path)),
  ]);
  const mainRun = await read<V4MainRun>(paths.mainRun);
  const offRun = await read<V4ArmRun>(paths.offRun);
  const onRun = await read<V4ArmRun>(paths.onRun);
  const pins = JSON.parse(raw[2]!) as V4Pins;
  const expressionSelection = JSON.parse(raw[3]!) as V4ExpressionSelectionManifest;
  const ledger = JSON.parse(raw[1]!) as V4TreatmentLedger;
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
    scenes,
  });
  const poolFailures = verifyG2PoolCoverage({
    catalogVerified: catalogVerification.passed,
    scenes,
    eligibleScenarioIds: report.eligibleScenarioIds,
    ledger,
  });
  const failures = [...poolFailures, ...report.verification.failures];
  const output: V4TreatmentVerification = {
    ...report.verification,
    inputFingerprints: [
      inputFingerprint(paths.catalog, raw[0]!),
      ...catalog.sceneFiles.map((entry, index) => inputFingerprint(entry.path, raw[index + 7]!)),
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
  if (process.env.G2_V4_AUDIT_ONLY !== "1") {
    await mkdir(resolve(root, paths.verification, ".."), { recursive: true });
    await writeFile(resolve(root, paths.verification), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({ eligible: report.eligibleScenarioIds, verification: output }, null, 2));
  if (!output.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("verify-g2-treatment-v4.ts")) {
  main().catch((error: unknown) => {
    console.error("[g2-treatment-verify] failed:", error);
    process.exitCode = 1;
  });
}
