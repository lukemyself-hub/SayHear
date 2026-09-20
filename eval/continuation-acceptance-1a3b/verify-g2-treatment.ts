/**
 * Issue #207 G2 v2 treatment verifier.
 *
 * Fail-closed verification of the causal claim: the OFF arm replays the frozen
 * clean-incumbent main responses verbatim, and the ON arm only adds the
 * declared treatment. Any mismatch blocks the review package.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256 } from "./protocol";
import {
  F3_V2_ARM_RUN_VERSION,
  F3_V2_LEDGER_VERSION,
  F3_V2_MAIN_RUN_VERSION,
  F3_V2_VERIFICATION_VERSION,
  matchesV2TargetRef,
  type V2ArmRun,
  type V2CatalogManifest,
  type V2Family,
  type V2LedgerScenario,
  type V2LedgerTurn,
  type V2MainRun,
  type V2Scene,
  type V2SceneFile,
  type V2TargetRef,
  type V2TreatmentLedger,
  type V2TreatmentVerification,
} from "./protocol-v2";

const OMIT_REASONS = new Set([
  "no_genuine_opportunity",
  "duplicates_main_response",
  "insufficient_grounding",
  "timing_not_natural",
]);
import { verifyV2Catalog } from "./verify-fixtures-v2";

export class V2TreatmentVerificationError extends Error {}

function familyOf(
  scenes: readonly V2Scene[],
  fixtureId: string,
): V2Family | null {
  return scenes.find((scene) => scene.id === fixtureId)?.family ?? null;
}

function refKey(ref: V2TargetRef): string {
  return ref.kind === "memory_claim"
    ? `memory_claim:${ref.memoryId}`
    : `open_loop:${ref.sourceTurn}:${ref.ordinal}`;
}

function matchedRefsEqual(left: V2TargetRef, right: V2TargetRef): boolean {
  return matchesV2TargetRef(left, right);
}

export type V2TreatmentVerificationReport = Readonly<{
  verification: V2TreatmentVerification;
  eligibleScenarioIds: readonly string[];
}>;

/**
 * Verify the arm runs and ledger against the fixture expectations. Returns a
 * report whose `verification.passed` is false on any failure; callers must not
 * treat a failed report as a package gate pass.
 */
export function verifyG2Treatment(input: Readonly<{
  catalog: V2CatalogManifest;
  catalogSha256: string;
  ledger: V2TreatmentLedger;
  ledgerSha256: string;
  main: V2MainRun;
  off: V2ArmRun;
  on: V2ArmRun;
  scenes: readonly V2Scene[];
}>): V2TreatmentVerificationReport {
  const failures: string[] = [];
  const { ledger, main, off, on, scenes } = input;

  if (main.version !== F3_V2_MAIN_RUN_VERSION) {
    failures.push(`main run version ${main.version} is not v2`);
  }
  if (off.version !== F3_V2_ARM_RUN_VERSION || on.version !== F3_V2_ARM_RUN_VERSION) {
    failures.push("arm run version is not v2");
  }
  if (ledger.version !== F3_V2_LEDGER_VERSION) {
    failures.push(`ledger version ${ledger.version} is not v2`);
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

  const mainResponses = new Map<string, Map<number, string>>();
  for (const response of main.responses) {
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
  }

  const eligibleScenarioIds = scenes
    .filter((scene) => !failures.some((failure) => failure.startsWith(`${scene.id}:`)))
    .map((scene) => scene.id);

  const verification: V2TreatmentVerification = {
    catalogSha256: input.catalogSha256,
    checkedScenarioCount: scenes.length,
    eligibleScenarioIds,
    failureCount: failures.length,
    failures,
    format: F3_V2_VERIFICATION_VERSION,
    ledgerSha256: input.ledgerSha256,
    offRunSha256: sha256(off),
    onRunSha256: sha256(on),
    passed: failures.length === 0,
    synthetic: true,
    version: F3_V2_VERIFICATION_VERSION,
  };
  return { eligibleScenarioIds, verification };
}

function verifyScene(input: {
  failures: string[];
  ledgerScenario: V2LedgerScenario;
  mainTurns: ReadonlyMap<number, string>;
  offScenario: V2ArmRun["scenarios"][number];
  onScenario: V2ArmRun["scenarios"][number];
  scene: V2Scene;
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
    if (offTurn.preCompositionMainText !== offTurn.assistantText) {
      fail(`t${sceneTurn.sequenceInScenario}: OFF composed beyond the main text`);
    }
    if (ledgerTurn.off.g2CodePathEntered !== false) {
      fail(`t${sceneTurn.sequenceInScenario}: OFF entered the G2 code path`);
    }
    if (ledgerTurn.on.segmentOutcome === "committed" && onTurn.assistantText === offTurn.assistantText) {
      fail(`t${sceneTurn.sequenceInScenario}: committed segment never reached the transcript`);
    }
    const expectation = sceneTurn.expect;
    if (expectation.selection === "none" && ledgerTurn.on.segmentOutcome === "committed") {
      fail(`t${sceneTurn.sequenceInScenario}: unexpected segment committed`);
    }
    if (expectation.selection === "segment") {
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
    if (expectation.excludedTarget && !stageRan) {
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
    if (expectation.selection === "segment") {
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
  const declaresLoop = scene.turns.some((sceneTurn) => {
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
  scenes: readonly V2Scene[];
  eligibleScenarioIds: readonly string[];
}>): readonly string[] {
  const failures: string[] = [];
  if (!input.catalogVerified) failures.push("fixture catalog did not verify");
  const eligibleIds = new Set(input.eligibleScenarioIds);
  const eligibleScenes = input.scenes.filter((scene) =>
    eligibleIds.has(scene.id),
  );
  if (eligibleScenes.length < 24) {
    failures.push(
      `only ${eligibleScenes.length} eligible scenes (plan requires at least 24)`,
    );
  }
  const families = new Map<V2Family, number>();
  for (const scene of eligibleScenes) {
    families.set(scene.family, (families.get(scene.family) ?? 0) + 1);
  }
  for (const [family, minimum] of [
    ["positive_open_loop", 5],
    ["positive_memory", 5],
    ["stateful_suppression", 6],
    ["correct_zero", 6],
    ["competing_pool", 4],
  ] as const) {
    if ((families.get(family) ?? 0) < minimum) {
      failures.push(
        `eligible family ${family} has fewer than ${minimum} scenes`,
      );
    }
  }
  for (const language of ["en", "zh", "code_switch"] as const) {
    const minimum = language === "en" ? 8 : language === "zh" ? 5 : 2;
    const count = eligibleScenes.filter(
      (scene) => scene.languageVariant === language,
    ).length;
    if (count < minimum) {
      failures.push(`eligible language ${language} has ${count} scenes`);
    }
  }
  const segmentScenes = eligibleScenes.filter((scene) =>
    scene.turns.some((turn) => turn.expect.selection === "segment"),
  );
  if (segmentScenes.length < 6) {
    failures.push(
      `only ${segmentScenes.length} eligible scenes commit a segment (need at least 6)`,
    );
  }
  const segmentKinds = new Map<string, number>();
  for (const scene of segmentScenes) {
    for (const turn of scene.turns) {
      if (turn.expect.selection !== "segment") continue;
      const kind = turn.expect.target?.kind ?? "unknown";
      segmentKinds.set(kind, (segmentKinds.get(kind) ?? 0) + 1);
    }
  }
  for (const [kind, minimum] of [
    ["memory_claim", 2],
    ["open_loop", 2],
  ] as const) {
    if ((segmentKinds.get(kind) ?? 0) < minimum) {
      failures.push(
        `eligible segment targets of kind ${kind} is ${segmentKinds.get(kind) ?? 0} (need at least ${minimum})`,
      );
    }
  }
  const suppressionScenes = eligibleScenes.filter((scene) =>
    scene.turns.some(
      (turn) =>
        turn.expect.excludedReason === "suppressed" ||
        turn.expect.release !== undefined,
    ),
  );
  if (suppressionScenes.length < 3) {
    failures.push(
      `only ${suppressionScenes.length} eligible scenes exercise suppression (need at least 3)`,
    );
  }
  return failures;
}

function parseCliPaths(argv: readonly string[]): Readonly<{
  catalog: string;
  ledger: string;
  mainRun: string;
  offRun: string;
  onRun: string;
}> {
  const values = {
    catalog: "eval/continuation-acceptance-1a3b/fixtures-v2.json",
    ledger: "eval/continuation-acceptance-1a3b/run-v2/treatment-ledger.json",
    mainRun: "eval/continuation-acceptance-1a3b/run-v2/continuation-main.json",
    offRun: "eval/continuation-acceptance-1a3b/run-v2/continuation-off.json",
    onRun: "eval/continuation-acceptance-1a3b/run-v2/continuation-on.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[++index] ?? "";
    if (argument === "--catalog") values.catalog = next;
    else if (argument === "--ledger") values.ledger = next;
    else if (argument === "--main-run") values.mainRun = next;
    else if (argument === "--off-run") values.offRun = next;
    else if (argument === "--on-run") values.onRun = next;
  }
  return values;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const paths = parseCliPaths(process.argv.slice(2));
  const read = async <T>(path: string): Promise<T> =>
    JSON.parse(await readFile(resolve(root, path), "utf8")) as T;
  const catalog = await read<V2CatalogManifest>(paths.catalog);
  const catalogVerification = await verifyV2Catalog({ manifest: catalog, root });
  if (!catalogVerification.passed) {
    throw new V2TreatmentVerificationError(
      `fixture catalog failed: ${catalogVerification.mismatches.join("; ")}`,
    );
  }
  const sceneFiles = await Promise.all(
    catalog.sceneFiles.map((entry) => read<V2SceneFile>(entry.path)),
  );
  const scenes = sceneFiles.flatMap((file) => file.scenes);
  const raw = await Promise.all([
    readFile(resolve(root, paths.catalog), "utf8"),
    readFile(resolve(root, paths.ledger), "utf8"),
  ]);
  const mainRun = await read<V2MainRun>(paths.mainRun);
  const offRun = await read<V2ArmRun>(paths.offRun);
  const onRun = await read<V2ArmRun>(paths.onRun);
  const ledger = JSON.parse(raw[1]!) as V2TreatmentLedger;
  const report = verifyG2Treatment({
    catalog,
    catalogSha256: sha256(raw[0]!),
    ledger,
    ledgerSha256: sha256(raw[1]!),
    main: mainRun,
    off: offRun,
    on: onRun,
    scenes,
  });
  const poolFailures = verifyG2PoolCoverage({
    catalogVerified: catalogVerification.passed,
    scenes,
    eligibleScenarioIds: report.eligibleScenarioIds,
  });
  const failures = [...poolFailures, ...report.verification.failures];
  const output: V2TreatmentVerification = {
    ...report.verification,
    failureCount: failures.length,
    failures,
    passed: failures.length === 0,
  };
  console.log(JSON.stringify({ eligible: report.eligibleScenarioIds, verification: output }, null, 2));
  if (!output.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("verify-g2-treatment.ts")) {
  main().catch((error: unknown) => {
    console.error("[g2-treatment-verify] failed:", error);
    process.exitCode = 1;
  });
}
