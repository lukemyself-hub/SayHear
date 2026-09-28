import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTINUATION_FORCED_COVERAGE,
  CONTINUATION_SAMPLE_QUOTAS,
  F3_PAIRWISE_PROTOCOL,
  VALIDATOR_ERROR_CLASSES,
  configurationFingerprint,
  sha256,
  type BioInspectionLedger,
  type PairwiseScores,
} from "../eval/continuation-acceptance-1a3b/protocol";
import {
  buildManifest,
  verifyFixtureCatalog,
} from "../eval/continuation-acceptance-1a3b/manifest";
import {
  buildReviewPackage,
  toPublicReviewPackage,
  unblindReviewPackage,
  validateValidatorLedger,
  verifySyntheticRunHardGates,
  type SyntheticRun,
} from "../eval/continuation-acceptance-1a3b/review-package";
import {
  selectContinuationSample,
} from "../eval/continuation-acceptance-1a3b/sampling";

const root = resolve(process.cwd());
const catalog = JSON.parse(
  readFileSync(
    resolve(root, "eval/continuation-acceptance-1a3b/fixtures.json"),
    "utf8",
  ),
) as Parameters<typeof verifyFixtureCatalog>[0];
const pins = JSON.parse(
  readFileSync(
    resolve(root, "eval/continuation-acceptance-1a3b/pins.json"),
    "utf8",
  ),
) as Parameters<typeof buildManifest>[0]["pins"];
const baseline = JSON.parse(
  readFileSync(
    resolve(root, "eval/continuation-acceptance-1a3b/baseline-reference.json"),
    "utf8",
  ),
) as Parameters<typeof buildManifest>[0]["baseline"];

function cleanBaseline() {
  return {
    ...baseline,
    currentIncumbent: {
      status: "clean" as const,
      commit: "0123456789abcdef0123456789abcdef01234567",
      confirmedHardGateFailures: 0,
      manifestPath: "eval/continuation-acceptance-1a3b/run/clean-incumbent.json",
    },
  };
}

function manifest() {
  return buildManifest({
    baseline: cleanBaseline(),
    catalog,
    commands: ["pnpm exec tsx eval/continuation-acceptance-1a3b/build-review-package.ts"],
    fixtureSeed: 196,
    gitCommit: "0123456789abcdef0123456789abcdef01234567",
    pins,
    sampleSeed: 1960,
  });
}

function syntheticAssistantText(
  fixture: (typeof catalog.scenarios)[number],
): string {
  if (fixture.group !== "continuation") return "This is a short synthetic Bio draft.";
  return [
    "I hear the specific thing you shared.",
    ...fixture.hardGate.requiredTokens,
  ].join(" ");
}

function syntheticRun(
  arm: "incumbent" | "candidate",
  group: "continuation" | "bio_naturalness",
): SyntheticRun {
  const scenarios = catalog.scenarios.filter((fixture) => fixture.group === group);
  const configId =
    group === "continuation"
      ? arm === "incumbent"
        ? pins.continuation.arms.incumbent.id
        : pins.continuation.arms.candidate.id
      : arm === "incumbent"
        ? pins.bio.configurations[0]!.id
        : pins.bio.configurations[1]!.id;
  return {
    arm,
    catalogVersion: catalog.version,
    configurationFingerprint: configurationFingerprint(pins, group, configId),
    configId,
    format: "1a3b-f3-synthetic-run:v1",
    group,
    scenarios: scenarios.map((fixture) => ({
      fixtureId: fixture.id,
      promptFingerprint:
        fixture.group === "bio_naturalness" ? sha256(fixture.prompt) : null,
      sharedInputFingerprint: sha256(catalog.sharedInputs[fixture.inputRef]!),
      turns:
        "turns" in fixture
          ? fixture.turns.map((turn) => ({
              assistantText:
                syntheticAssistantText(fixture),
              sequenceInScenario: turn.sequenceInScenario,
              userInput: turn.userInput,
            }))
          : [],
    })),
    sourceKind: "synthetic-eval",
    synthetic: true,
    version: "1a3b-f3-synthetic-run:v1",
  };
}

describe("Issue #196 F3 synthetic acceptance tools", () => {
  it("ships the three independent fixture groups and validator quotas", () => {
    const verification = verifyFixtureCatalog(catalog);

    expect(verification.passed).toBe(true);
    expect(verification.counts).toEqual({
      continuation: 18,
      bio_naturalness: 15,
      validator: 18,
    });
    expect(verification.validatorByLanguage).toEqual({
      en: { bio: 4, reflection: 2 },
      zh: { bio: 4, reflection: 2 },
      code_switch: { bio: 4, reflection: 2 },
    });
    expect(
      new Set(
        catalog.scenarios
          .filter((fixture) => fixture.group === "validator")
          .map((fixture) => fixture.validatorErrorClass),
      ),
    ).toEqual(new Set(VALIDATOR_ERROR_CLASSES));
  });

  it("verifies the #252 acceptance holdout and its own precision drafts", () => {
    const holdout = JSON.parse(
      readFileSync(
        resolve(root, "eval/continuation-acceptance-1a3b/holdout/fixtures.json"),
        "utf8",
      ),
    ) as Parameters<typeof verifyFixtureCatalog>[0];

    const verification = verifyFixtureCatalog(holdout);

    expect(verification.mismatches).toEqual([]);
    expect(verification.passed).toBe(true);
    // Validator-scoped: the holdout has no Continuation or Bio pool to run.
    expect(verification.counts).toEqual({
      continuation: 0,
      bio_naturalness: 0,
      validator: 18,
    });
    expect(verification.validatorByLanguage).toEqual({
      en: { bio: 4, reflection: 2 },
      zh: { bio: 4, reflection: 2 },
      code_switch: { bio: 4, reflection: 2 },
    });
    // The precision half must travel with the catalog, not with the capture
    // script's built-in set, which cites the spent catalog's claim IDs.
    expect(holdout.precisionDrafts).toHaveLength(6);
    const spentClaimIds = new Set(
      Object.values(catalog.sharedInputs).flatMap((shared) =>
        shared.memory.map((memory) => memory.id),
      ),
    );
    for (const draft of holdout.precisionDrafts ?? []) {
      expect(spentClaimIds.has(draft.claimId)).toBe(false);
    }
  });

  it("rejects a holdout whose precision drafts cite unknown claims", () => {
    const holdout = JSON.parse(
      readFileSync(
        resolve(root, "eval/continuation-acceptance-1a3b/holdout/fixtures.json"),
        "utf8",
      ),
    ) as Parameters<typeof verifyFixtureCatalog>[0];
    const kept = holdout.precisionDrafts ?? [];
    const badDraft = { ...kept[0]!, claimId: "syn-claim-that-does-not-exist" };
    const broken = {
      ...holdout,
      precisionDrafts: [...kept.slice(1), badDraft],
    };

    const verification = verifyFixtureCatalog(broken);

    expect(verification.passed).toBe(false);
    expect(verification.mismatches).toContain(
      `${badDraft.id} cites unknown claim ${badDraft.claimId}`,
    );
  });

  it("selects the same continuation sample for the same seed", () => {
    const candidates = catalog.scenarios
      .filter((fixture) => fixture.group === "continuation")
      .map((fixture) => ({
        category: fixture.category,
        coverageTags: fixture.coverageTags,
        id: fixture.id,
        languageVariant: fixture.languageVariant,
      }));

    const first = selectContinuationSample({ candidates, sampleSeed: 1960 });
    const second = selectContinuationSample({ candidates, sampleSeed: 1960 });

    expect(first).toEqual(second);
    expect(first.selectedCounts).toEqual(CONTINUATION_SAMPLE_QUOTAS);
    expect(first.scenarioIds).toHaveLength(15);
    for (const tag of CONTINUATION_FORCED_COVERAGE) {
      expect(first.forcedCoverage[tag]).toBeTypeOf("string");
    }
    expect(first.protectedCoverage).toEqual({
      direct_task: expect.any(String),
      high_risk: expect.any(String),
      refusal: expect.any(String),
      short_answers: expect.any(String),
      topic_change: expect.any(String),
    });
  });

  it("blocks comparison when the historical incumbent has no clean rebaseline", () => {
    const blockedBaseline = {
      ...baseline,
      currentIncumbent: {
        status: "requires-clean-rebaseline" as const,
        commit: null,
        confirmedHardGateFailures: null,
        manifestPath: null,
      },
    };
    const blocked = buildManifest({
      baseline: blockedBaseline,
      catalog,
      commands: ["pnpm exec tsx eval/continuation-acceptance-1a3b/build-manifest.ts"],
      fixtureSeed: 196,
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      pins,
      sampleSeed: 1960,
    });

    expect(blocked.status).toBe("blocked_requires_clean_incumbent");
    expect(blocked.comparisonAllowed).toBe(false);
    expect(blocked.baseline.historicalFindingIssues).toEqual([166, 186]);
  });

  it("requires a full commit identity for a claimed clean incumbent", () => {
    expect(() =>
      buildManifest({
        baseline: {
          ...cleanBaseline(),
          currentIncumbent: {
            ...cleanBaseline().currentIncumbent,
            commit: "not-a-commit",
          },
        },
        catalog,
        commands: ["verify-fixtures"],
        fixtureSeed: 196,
        gitCommit: "0123456789abcdef0123456789abcdef01234567",
        pins,
        sampleSeed: 1960,
      }),
    ).toThrow(/clean incumbent/i);
  });

  it("keeps both continuation arms on one frozen input and one declared bundle diff", () => {
    const package_ = buildReviewPackage({
      baselineRun: syntheticRun("incumbent", "continuation"),
      candidateRun: syntheticRun("candidate", "continuation"),
      catalog,
      group: "continuation",
      manifest: manifest(),
    });

    expect(package_.pairs.protocol).toBe(F3_PAIRWISE_PROTOCOL);
    expect(package_.pairs.scenarios).toHaveLength(15);
    expect(package_.inputSummary.entries).toHaveLength(15);
    expect(
      package_.inputSummary.entries.every(
        (entry) =>
          entry.intentionalDifference.keys.join(",") ===
          "open_loop_bundle,proactive_bundle",
      ),
    ).toBe(true);
    expect(
      package_.inputSummary.entries.every(
        (entry) => {
          const fixture = catalog.scenarios.find(
            (candidate) => candidate.id === entry.fixtureId,
          )!;
          return (
            entry.sharedInput.fingerprint ===
            sha256(catalog.sharedInputs[fixture.inputRef]!)
          );
        },
      ),
    ).toBe(true);
  });

  it("keeps sealed arm identities out of the public review package", () => {
    const package_ = buildReviewPackage({
      baselineRun: syntheticRun("incumbent", "continuation"),
      candidateRun: syntheticRun("candidate", "continuation"),
      catalog,
      group: "continuation",
      manifest: manifest(),
    });

    const publicPackage = toPublicReviewPackage(package_);
    expect(Object.prototype.hasOwnProperty.call(publicPackage, "sealed")).toBe(false);
    expect(JSON.stringify(publicPackage)).not.toContain("continuation-incumbent-1a3a");
    expect(JSON.stringify(publicPackage)).not.toContain("continuation-bundle-1a3b-v1");
  });

  it("keeps Bio as an independent 15-case human comparison with no automatic winner", () => {
    const package_ = buildReviewPackage({
      baselineRun: syntheticRun("incumbent", "bio_naturalness"),
      candidateRun: syntheticRun("candidate", "bio_naturalness"),
      catalog,
      group: "bio_naturalness",
      manifest: manifest(),
    });
    const scores: PairwiseScores = {
      protocol: F3_PAIRWISE_PROTOCOL,
      scorer: "Luke",
      scoredAt: "2026-09-08T00:00:00.000Z",
      scenarios: package_.pairs.scenarios.map((scenario) => ({
        scenarioId: scenario.scenarioId,
        overallChoice: "tie",
        turns: scenario.turns.map((turn) => ({
          choice: "tie",
          sequenceInScenario: turn.sequenceInScenario,
        })),
      })),
    };
    expect(package_.pairs.scenarios).toHaveLength(15);
    expect(package_.pairs.sampling.selectedCounts).toEqual({
      code_switch: 5,
      en: 5,
      zh: 5,
    });
    const pending = unblindReviewPackage({ package: package_, scores });
    expect(pending.gate).toMatchObject({
      automaticWinner: null,
      humanFixedSampleInspectionRequired: true,
      humanFixedSampleInspection: {
        completed: false,
        passed: false,
      },
    });

    const inspection: BioInspectionLedger = {
      adjudicator: "Luke",
      configurationId: pins.bio.configurations[0]!.id,
      decidedAt: "2026-09-08T00:00:00.000Z",
      entries: package_.pairs.scenarios.map((scenario) => ({
        fixtureId: scenario.scenarioId,
        verdict: "acceptable" as const,
      })),
      group: "bio_naturalness",
      manifestFingerprint: package_.manifestFingerprint,
      reviewPackageFingerprint: package_.packageFingerprint,
      version: "1a3b-f3-bio-inspection:v1",
    };
    const result = unblindReviewPackage({
      bioInspection: inspection,
      package: package_,
      scores,
    });
    expect(result.gate).toEqual({
      automaticWinner: null,
      humanFixedSampleInspection: {
        completed: true,
        configurationId: pins.bio.configurations[0]!.id,
        inspectedFixtureCount: 15,
        passed: true,
        unacceptableFixtureIds: [],
      },
      humanFixedSampleInspectionRequired: true,
    });
  });

  it("keeps the manifest fingerprint stable when only creation time changes", () => {
    const first = buildManifest({
      ...{
        baseline: cleanBaseline(),
        catalog,
        commands: ["verify-fixtures"],
        fixtureSeed: 196,
        gitCommit: "0123456789abcdef0123456789abcdef01234567",
        pins,
        sampleSeed: 1960,
      },
      createdAt: "2026-09-08T00:00:00.000Z",
    });
    const second = buildManifest({
      ...{
        baseline: cleanBaseline(),
        catalog,
        commands: ["verify-fixtures"],
        fixtureSeed: 196,
        gitCommit: "0123456789abcdef0123456789abcdef01234567",
        pins,
        sampleSeed: 1960,
      },
      createdAt: "2026-09-08T01:00:00.000Z",
    });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.createdAt).not.toBe(second.createdAt);
  });

  it("refuses a pair when a run changes the frozen user input", () => {
    const candidate = syntheticRun("candidate", "continuation");
    const firstScenario = candidate.scenarios[0]!;
    const firstTurn = firstScenario.turns[0]!;
    const drifted: SyntheticRun = {
      ...candidate,
      scenarios: [
        {
          ...firstScenario,
          turns: [
            { ...firstTurn, userInput: { ...firstTurn.userInput, text: "drift" } },
            ...firstScenario.turns.slice(1),
          ],
        },
        ...candidate.scenarios.slice(1),
      ],
    };

    expect(() =>
      buildReviewPackage({
        baselineRun: syntheticRun("incumbent", "continuation"),
        candidateRun: drifted,
        catalog,
        group: "continuation",
        manifest: manifest(),
      }),
    ).toThrow(/user input differs/i);
  });

  it("refuses a pair when either arm changes the frozen shared input", () => {
    const candidate = syntheticRun("candidate", "continuation");
    const firstScenario = candidate.scenarios[0]!;
    const drifted: SyntheticRun = {
      ...candidate,
      scenarios: [
        {
          ...firstScenario,
          sharedInputFingerprint: "sha256:drifted-shared-input",
        },
        ...candidate.scenarios.slice(1),
      ],
    };

    expect(() =>
      buildReviewPackage({
        baselineRun: syntheticRun("incumbent", "continuation"),
        candidateRun: drifted,
        catalog,
        group: "continuation",
        manifest: manifest(),
      }),
    ).toThrow(/shared input fingerprint differs/i);
  });

  it("refuses a run whose configuration fingerprint is not pinned", () => {
    const candidate = syntheticRun("candidate", "continuation");
    expect(() =>
      buildReviewPackage({
        baselineRun: syntheticRun("incumbent", "continuation"),
        candidateRun: {
          ...candidate,
          configurationFingerprint: "sha256:drifted-configuration",
        },
        catalog,
        group: "continuation",
        manifest: manifest(),
      }),
    ).toThrow(/configuration fingerprint/i);
  });

  it("fails the hard gates loudly instead of passing when nothing was checked", () => {
    // A validator-only catalog, like the #252 holdout. It has no Continuation
    // pool, so the hard gates must refuse rather than report a pass having
    // checked nothing.
    const holdout = JSON.parse(
      readFileSync(
        resolve(root, "eval/continuation-acceptance-1a3b/holdout/fixtures.json"),
        "utf8",
      ),
    ) as Parameters<typeof verifySyntheticRunHardGates>[0];

    const emptyPool = verifySyntheticRunHardGates(
      holdout,
      syntheticRun("incumbent", "continuation"),
    );

    expect(emptyPool.applicable).toBe(true);
    expect(emptyPool.passed).toBe(false);
    expect(emptyPool.checkedFixtureCount).toBe(0);
    expect(emptyPool.failures.join(" ")).toMatch(/Continuation pool/i);

    // A run that is not a Continuation run is not applicable, and must not be
    // readable as a pass.
    const wrongGroup = verifySyntheticRunHardGates(
      catalog,
      syntheticRun("incumbent", "bio_naturalness"),
    );

    expect(wrongGroup.applicable).toBe(false);
    expect(wrongGroup.passed).toBe(false);
    expect(wrongGroup.checkedFixtureCount).toBe(0);

    // The incumbent path is unchanged: a real Continuation run over the full
    // pool still checks every fixture.
    const real = verifySyntheticRunHardGates(
      catalog,
      syntheticRun("incumbent", "continuation"),
    );
    expect(real.applicable).toBe(true);
    expect(real.checkedFixtureCount).toBe(18);
  });

  it("checks deterministic hard gates across the complete pool before sampling", () => {
    const candidate = syntheticRun("candidate", "continuation");
    const firstScenario = candidate.scenarios[0]!;
    const firstTurn = firstScenario.turns[0]!;
    const hardGateFailure: SyntheticRun = {
      ...candidate,
      scenarios: [
        {
          ...firstScenario,
          turns: [
            {
              ...firstTurn,
              assistantText: "First question? Second question?",
            },
          ],
        },
        ...candidate.scenarios.slice(1),
      ],
    };

    expect(() =>
      buildReviewPackage({
        baselineRun: syntheticRun("incumbent", "continuation"),
        candidateRun: hardGateFailure,
        catalog,
        group: "continuation",
        manifest: manifest(),
      }),
    ).toThrow(/more than one question/i);
  });

  it("keeps advisory token findings out of the hard-gate pass only when explicitly requested", () => {
    const fixture = catalog.scenarios.find(
      (entry) =>
        entry.group === "continuation" &&
        entry.category === "direct_task" &&
        entry.hardGate.requiredTokens.length > 0,
    );
    expect(fixture).toBeDefined();

    const candidate = syntheticRun("candidate", "continuation");
    const responseWithoutRequiredToken = {
      ...candidate,
      scenarios: candidate.scenarios.map((entry) =>
        entry.fixtureId === fixture!.id
          ? {
              ...entry,
              turns: entry.turns.map((turn) =>
                turn.sequenceInScenario === 1
                  ? { ...turn, assistantText: "I hear the specific thing you shared." }
                  : turn,
              ),
            }
          : entry,
      ),
    };

    const advisory = verifySyntheticRunHardGates(catalog, responseWithoutRequiredToken, {
      tokenGates: "advisory",
    });
    expect(advisory.passed).toBe(true);
    expect(advisory.advisories.some((entry) => entry.includes("required_recall_missing"))).toBe(true);

    const hard = verifySyntheticRunHardGates(catalog, responseWithoutRequiredToken);
    expect(hard.passed).toBe(false);
    expect(hard.failures.some((entry) => entry.includes("required_recall_missing"))).toBe(true);
  });

  it("does not reveal identities until every blinded score is present", () => {
    const package_ = buildReviewPackage({
      baselineRun: syntheticRun("incumbent", "continuation"),
      candidateRun: syntheticRun("candidate", "continuation"),
      catalog,
      group: "continuation",
      manifest: manifest(),
    });
    const incomplete: PairwiseScores = {
      protocol: F3_PAIRWISE_PROTOCOL,
      scorer: "Luke",
      scoredAt: "2026-09-08T00:00:00.000Z",
      scenarios: [],
    };

    expect(() => unblindReviewPackage({ package: package_, scores: incomplete })).toThrow(
      /partially scored|unscored/i,
    );
    expect(() =>
      unblindReviewPackage({
        package: package_,
        scores: { ...incomplete, scorer: "another-reviewer" },
      }),
    ).toThrow(/Luke/i);

    const scores: PairwiseScores = {
      ...incomplete,
      scenarios: package_.pairs.scenarios.map((scenario) => ({
        scenarioId: scenario.scenarioId,
        overallChoice: "tie",
        turns: scenario.turns.map((turn) => ({
          choice: "tie",
          sequenceInScenario: turn.sequenceInScenario,
        })),
      })),
    };
    const result = unblindReviewPackage({ package: package_, scores });
    expect(result.revealed).toBe(true);
    expect(result.pairwise.overall.scenarios.tie).toBe(15);
  });

  it("requires all eighteen independent validator adjudications", () => {
    const fixtures = catalog.scenarios.filter((fixture) => fixture.group === "validator");
    const ledger = {
      adjudicator: "Luke",
      decidedAt: "2026-09-08T00:00:00.000Z",
      entries: fixtures.map((fixture) => ({
        fixtureId: fixture.id,
        verdict: "accepted" as const,
      })),
      group: "validator" as const,
      manifestFingerprint: manifest().fingerprint,
      version: "1a3b-f3-adjudication:v1" as const,
    };

    expect(validateValidatorLedger({ catalog, ledger })).toEqual({
      accepted: 18,
      maxRejects: 0,
      rejected: 0,
      total: 18,
    });
    expect(() =>
      validateValidatorLedger({ catalog, ledger: { ...ledger, entries: ledger.entries.slice(1) } }),
    ).toThrow(/missing/i);
  });

  it("caps the validator ledger error budget at ten percent", () => {
    const fixtures = catalog.scenarios.filter((fixture) => fixture.group === "validator");
    const base = {
      adjudicator: "Luke",
      decidedAt: "2026-09-08T00:00:00.000Z",
      group: "validator" as const,
      manifestFingerprint: manifest().fingerprint,
      version: "1a3b-f3-adjudication:v1" as const,
    };
    const oneReject = fixtures.map((fixture, index) => ({
      fixtureId: fixture.id,
      verdict: (index === 0 ? "rejected" : "accepted") as "accepted" | "rejected",
    }));
    expect(
      validateValidatorLedger({ catalog, ledger: { ...base, entries: oneReject, maxRejects: 1 } }),
    ).toEqual({ accepted: 17, maxRejects: 1, rejected: 1, total: 18 });
    expect(() =>
      validateValidatorLedger({ catalog, ledger: { ...base, entries: oneReject, maxRejects: 2 } }),
    ).toThrow(/10%/);
  });
});
