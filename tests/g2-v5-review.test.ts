import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { fingerprintReviewPayload, unblindV5, type V5ReviewInput } from "../eval/continuation-acceptance-1a3b/unblind-v5";
import { selectV5PairwiseSample } from "../eval/continuation-acceptance-1a3b/sampling-v5";
import { v5RecordsMatchExactSet, type V5CatalogManifest, type V5LedgerScenario, type V5LedgerTurn, type V5Scene } from "../eval/continuation-acceptance-1a3b/protocol-v5";
import { sha256 } from "../eval/continuation-acceptance-1a3b/protocol";
import { isActualV5TypedOmission, selectedExpectedEligibleTarget } from "../eval/continuation-acceptance-1a3b/verify-g2-treatment-v5";
import { verifyV5Catalog } from "../eval/continuation-acceptance-1a3b/verify-fixtures-v5";
import { splitV5FormalBatches } from "../eval/continuation-acceptance-1a3b/batching-v5";

const ROOT = "eval/continuation-acceptance-1a3b";

function sampleScenes(): V5Scene[] {
  const families = [
    "positive_open_loop", "positive_open_loop", "positive_open_loop",
    "positive_memory", "positive_memory", "positive_memory", "positive_memory",
    "stateful_suppression", "stateful_suppression", "competing_pool",
  ] as const;
  const languages = ["en", "en", "en", "en", "en", "zh", "zh", "zh", "code_switch", "code_switch"] as const;
  const protectedByIndex = ["direct_task", "refusal", "short_answer", "topic_change"] as const;
  return families.map((family, index) => ({
    id: `scene-${index}`,
    family,
    languageVariant: languages[index]!,
    topic: `topic-${index}`,
    protectedCategories: protectedByIndex[index] ? [protectedByIndex[index]!] : [],
  }) as unknown as V5Scene);
}

function validReviewInput(): V5ReviewInput {
  const pairwiseCases = Array.from({ length: 10 }, (_, index) => ({
    caseId: `case-${index + 1}`,
    languageVariant: (["en", "en", "en", "en", "en", "zh", "zh", "zh", "code_switch", "code_switch"] as const)[index]!,
    turns: [{ sequence: 1, responseA: "Candidate response", responseB: "No added response" }],
  }));
  const omissionCases = Array.from({ length: 8 }, (_, index) => ({
    caseId: `omit-${index + 1}`,
    languageVariant: (["en", "zh", "code_switch", "en", "zh", "code_switch", "en", "zh"] as const)[index]!,
  }));
  const payload = {
    protocolVersion: "blind-pairwise:g2-v5" as const,
    packageVersion: "1a3b-g2-review-package:v5" as const,
    capturedDate: "2026-09-23",
    pairwiseCases,
    omissionCases,
  };
  const fingerprint = fingerprintReviewPayload(payload as never);
  const pairwiseMappings = pairwiseCases.map((item, index) => {
    const family = (["positive_open_loop", "positive_open_loop", "positive_open_loop", "positive_memory", "positive_memory", "positive_memory", "stateful_suppression", "stateful_suppression", "competing_pool", "positive_memory"] as const)[index]!;
    const protectedCategories = index === 0 ? ["direct_task"] : index === 1 ? ["refusal"] : index === 3 ? ["short_answer"] : index === 4 ? ["topic_change"] : [];
    const offIsA = index < 5;
    const candidateIsA = !offIsA;
    const candidateWins = ![2, 7, 9].includes(index);
    const choice = candidateWins ? (candidateIsA ? "A" : "B") : (candidateIsA ? "B" : "A");
    return {
      publicCase: item,
      score: { caseId: item.caseId, turnDecisions: [{ sequence: 1, choice }], sceneDecision: choice },
      mapping: {
        caseId: item.caseId,
        fixtureId: `fixture-${index}`,
        family,
        topic: `topic-${index}`,
        targetKind: index < 3 || index === 6 ? "open_loop" : "memory_claim",
        completeStatefulTrajectory: family === "stateful_suppression",
        protectedCategories,
        protectedEvidenceSequences: Object.fromEntries(protectedCategories.map((category) => [category, 1])),
        languageVariant: item.languageVariant,
        offIsA,
        candidateIsA,
      },
    };
  });
  const reasons = ["no_genuine_opportunity", "no_genuine_opportunity", "duplicates_main_response", "duplicates_main_response", "insufficient_grounding", "insufficient_grounding", "timing_not_natural", "timing_not_natural"];
  const omissionMappings = omissionCases.map((item, index) => ({
    publicCase: item,
    score: { caseId: item.caseId, choice: "silence_appropriate" },
    mapping: {
      caseId: item.caseId,
      fixtureId: `omit-fixture-${index}`,
      family: "omission_contract",
      targetKind: index % 2 === 0 ? "memory_claim" : "open_loop",
      protectedCategories: [],
      expectedOmissionReason: reasons[index],
      languageVariant: item.languageVariant,
    },
  }));
  const reviewPackage = { packageFingerprint: fingerprint, fingerprintKind: "rawSha256 of payload bytes", payload };
  const scores = {
    scoreVersion: "1a3b-g2-scores:v5" as const,
    protocolVersion: "blind-pairwise:g2-v5" as const,
    packageVersion: "1a3b-g2-review-package:v5" as const,
    packageFingerprint: fingerprint,
    scorer: "reviewer",
    scoredAt: "2026-09-23T12:00:00.000Z",
    pairwiseDecisions: pairwiseMappings.map((entry) => entry.score),
    omissionDecisions: omissionMappings.map((entry) => entry.score),
  };
  const sealed = { packageFingerprint: fingerprint, mappings: [...pairwiseMappings, ...omissionMappings].map((entry) => entry.mapping) };
  return { reviewPackage, scores, sealed } as unknown as V5ReviewInput;
}

describe("G2 v5 review gates", () => {
  it("selects the frozen 10-scene sample deterministically with 5/3/2 language and protected coverage", () => {
    const candidates = sampleScenes();
    const completeStateful = new Set(["scene-7", "scene-8"]);
    const first = selectV5PairwiseSample({ candidates, completeStatefulSceneIds: completeStateful });
    const second = selectV5PairwiseSample({ candidates, completeStatefulSceneIds: completeStateful });
    expect(first?.map((scene) => scene.id)).toEqual(second?.map((scene) => scene.id));
    expect(first).toHaveLength(10);
    expect(first?.filter((scene) => scene.languageVariant === "en")).toHaveLength(5);
    expect(first?.filter((scene) => scene.languageVariant === "zh")).toHaveLength(3);
    expect(first?.filter((scene) => scene.languageVariant === "code_switch")).toHaveLength(2);
    expect(first?.filter((scene) => completeStateful.has(scene.id))).toHaveLength(2);
    expect(selectV5PairwiseSample({ candidates: candidates.slice(0, 9), completeStatefulSceneIds: completeStateful })).toBeNull();
  });

  it("pre-registers three balanced batches with all controls in batch 1", () => {
    const positiveFamilies = ["positive_open_loop", "positive_memory", "stateful_suppression", "competing_pool"] as const;
    const languages = ["en", "en", "en", "en", "en", "zh", "zh", "zh", "code_switch", "code_switch"] as const;
    const positive = positiveFamilies.flatMap((family) => languages.map((languageVariant, index) => ({
      id: `${family}-${index}`,
      family,
      languageVariant,
      reviewIntent: "pairwise_candidate",
    }) as unknown as V5Scene));
    const controls = [
      ...Array.from({ length: 8 }, (_, index) => ({ id: `omit-${index}`, family: "omission_contract", reviewIntent: "omission_audit" })),
      ...Array.from({ length: 4 }, (_, index) => ({ id: `zero-${index}`, family: "correct_zero", reviewIntent: "contract_only" })),
    ] as unknown as V5Scene[];
    const batches = splitV5FormalBatches([...positive, ...controls]);
    expect(batches.map((batch) => batch.id)).toEqual(["batch-1", "batch-2", "batch-3"]);
    expect(v5RecordsMatchExactSet(batches.flatMap((batch) => batch.sceneIds), [...positive, ...controls].map((scene) => scene.id))).toBe(true);
    expect(controls.every((scene) => batches[0]!.sceneIds.includes(scene.id))).toBe(true);
    for (const batch of batches) {
      const scenes = [...positive, ...controls].filter((scene) => batch.sceneIds.includes(scene.id) && scene.reviewIntent === "pairwise_candidate");
      expect(positiveFamilies.every((family) => scenes.some((scene) => scene.family === family))).toBe(true);
      expect(["en", "zh", "code_switch"].every((language) => scenes.some((scene) => scene.languageVariant === language))).toBe(true);
    }
  });

  it("accepts only a Provider-backed typed omission with a released reservation", () => {
    const base = {
      sequenceInScenario: 2,
      on: {
        selectionOutcome: "selected",
        segmentProviderCallCount: 1,
        segmentCommandId: "segment-command-1",
        segmentOutcome: "omitted",
        segmentOmitReason: "duplicates_main_response",
        segmentText: null,
        reservationOutcome: "released",
        typedUseOutcome: null,
        dispositionOutcome: null,
      },
    };
    expect(isActualV5TypedOmission(base as unknown as V5LedgerTurn, "duplicates_main_response")).toBe(true);
    expect(isActualV5TypedOmission({ ...base, on: { ...base.on, segmentProviderCallCount: 0, reservationOutcome: "abandoned" } } as unknown as V5LedgerTurn)).toBe(false);
  });

  it("keeps an expected target mismatch out of recall and rejects it mechanically", () => {
    const scene = {
      id: "wrong-target",
      turns: [{ sequenceInScenario: 1, expect: { selection: "segment", target: { kind: "memory_claim", memoryId: "expected" } } }],
    } as unknown as V5Scene;
    const ledgerScenario = { formedTargetRefs: [] } as unknown as V5LedgerScenario;
    const makeTurn = (selectedTargetRef: string) => ({
      sequenceInScenario: 1,
      on: {
        selectedTargetRef,
        candidates: [{ targetRef: selectedTargetRef, current: true, eligible: true, trustFence: "valid", mentionedInExchange: false, formedInCurrentTurn: false, exclusionReason: null, rankTuple: [0] }],
      },
    }) as unknown as V5LedgerTurn;
    expect(selectedExpectedEligibleTarget(scene, ledgerScenario, makeTurn("memory_claim:wrong"))).toBe(false);
    expect(selectedExpectedEligibleTarget(scene, ledgerScenario, makeTurn("memory_claim:expected"))).toBe(true);
  });

  it("rejects missing, duplicate, and extra capture records", () => {
    const expected = ["scene-a:t1", "scene-a:t2", "scene-b:t1"];
    expect(v5RecordsMatchExactSet(expected, expected)).toBe(true);
    expect(v5RecordsMatchExactSet(expected.slice(1), expected)).toBe(false);
    expect(v5RecordsMatchExactSet(["scene-a:t1", "scene-a:t1", "scene-b:t1"], expected)).toBe(false);
    expect(v5RecordsMatchExactSet([...expected, "scene-c:t1"], expected)).toBe(false);
  });

  it("enforces v5 unblinding and package fingerprints", () => {
    const input = validReviewInput();
    expect(unblindV5(input).passed).toBe(true);
    const oldSized = structuredClone(input) as unknown as V5ReviewInput;
    const oldPayload = oldSized.reviewPackage.payload as unknown as { pairwiseCases: unknown[] };
    oldPayload.pairwiseCases.push(oldPayload.pairwiseCases[0]);
    const resizedFingerprint = fingerprintReviewPayload(oldSized.reviewPackage.payload as never);
    (oldSized.reviewPackage as unknown as { packageFingerprint: string }).packageFingerprint = resizedFingerprint;
    (oldSized.scores as unknown as { packageFingerprint: string }).packageFingerprint = resizedFingerprint;
    (oldSized.sealed as unknown as { packageFingerprint: string }).packageFingerprint = resizedFingerprint;
    expect(() => unblindV5(oldSized)).toThrow(/exactly 10 pairwise/);
    const wrongFingerprint = structuredClone(input) as unknown as { reviewPackage: { packageFingerprint: string } } & V5ReviewInput;
    wrongFingerprint.reviewPackage.packageFingerprint = "bad";
    expect(() => unblindV5(wrongFingerprint)).toThrow(/fingerprint/);
    const wrongOmission = structuredClone(input) as unknown as { sealed: { mappings: Array<{ caseId: string; expectedOmissionReason?: string }> } } & V5ReviewInput;
    wrongOmission.sealed.mappings.find((entry) => entry.caseId === "omit-1")!.expectedOmissionReason = "timing_not_natural";
    expect(() => unblindV5(wrongOmission)).toThrow(/coverage contract/);
  });

  it("rejects v4 catalogs and corrupted v5 fixture hashes", async () => {
    const formalRaw = await readFile(`${ROOT}/fixtures-v5-calibration-1.json`, "utf8");
    const formal = JSON.parse(formalRaw) as V5CatalogManifest;
    const valid = await verifyV5Catalog({ manifest: formal, root: process.cwd() });
    expect(valid.passed).toBe(true);
    const badHash = await verifyV5Catalog({
      manifest: { ...formal, sceneFiles: [{ ...formal.sceneFiles[0]!, sha256: "0".repeat(64) }, ...formal.sceneFiles.slice(1)] },
      root: process.cwd(),
    });
    expect(badHash.passed).toBe(false);
    expect(badHash.mismatches.some((entry) => entry.includes("hash drift"))).toBe(true);
    const oldRaw = await readFile(`${ROOT}/fixtures-v4.json`, "utf8");
    const old = await verifyV5Catalog({ manifest: JSON.parse(oldRaw) as V5CatalogManifest, root: process.cwd() });
    expect(old.passed).toBe(false);
    expect(old.mismatches.some((entry) => entry.includes("not 1a3b-g2-continuation:v5"))).toBe(true);
  });
});
