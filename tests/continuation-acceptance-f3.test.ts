import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTINUATION_FORCED_COVERAGE,
  CONTINUATION_PROTECTED_CATEGORIES,
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
const holdout = JSON.parse(
  readFileSync(
    resolve(root, "eval/continuation-acceptance-1a3b/holdout/fixtures.json"),
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

/** The #252 holdout reduced to its validator half: no Continuation pool. */
function validatorOnlyCatalog(): Parameters<typeof verifyFixtureCatalog>[0] {
  return {
    ...holdout,
    scenarios: holdout.scenarios.filter(
      (fixture) => fixture.group !== "continuation",
    ),
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
    required: [
      "AC-X01",
      "AC-X02",
      "AC-X03",
      "AC-X04",
      "AC-M01",
    ],
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
    // Carries a Continuation pool as well as the validator set: AC-X04 is one
    // of the twelve required evidence contracts and its only data source is a
    // Continuation run, so a validator-only holdout could not certify a
    // release even if it verified. Bio is absent, because Bio naturalness
    // certifies bio.write, which the G1-only release does not ship.
    // ADR-0143: Bio left G1 scope because bio.write is a deferred role, so the
    // holdout carries Reflection only. The count comes from the catalog rather
    // than a constant, which is why it is asserted as 6 and not 18.
    expect(verification.counts).toEqual({
      continuation: 18,
      bio_naturalness: 0,
      validator: 6,
    });
    expect(verification.validatorByLanguage).toEqual({
      en: { bio: 0, reflection: 2 },
      zh: { bio: 0, reflection: 2 },
      code_switch: { bio: 0, reflection: 2 },
    });
    // The Continuation half must satisfy the same forced coverage and language
    // quotas as the incumbent, or the seeded sample cannot be reproduced.
    const continuationCandidates = holdout.scenarios
      .filter((fixture) => fixture.group === "continuation")
      .map((fixture) => ({
        category: fixture.category,
        coverageTags: fixture.coverageTags,
        id: fixture.id,
        languageVariant: fixture.languageVariant,
      }));
    const continuationSample = selectContinuationSample({
      candidates: continuationCandidates,
      sampleSeed: 1960,
    });

    expect(continuationSample.selectedCounts).toEqual({
      code_switch: 2,
      en: 8,
      zh: 5,
    });
    expect(Object.keys(continuationSample.forcedCoverage).sort()).toEqual(
      [...CONTINUATION_FORCED_COVERAGE].sort(),
    );
    expect(Object.keys(continuationSample.protectedCoverage).sort()).toEqual(
      [...CONTINUATION_PROTECTED_CATEGORIES].sort(),
    );
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

  it("builds a manifest for a G1-only release that does not ship Bio", () => {
    // The G1-only release ships four roles, none of which is bio.write, so
    // AC-X02 is not a gate it can satisfy. The release declares what it
    // requires rather than inheriting a fixed five-item list.
    const build = (overrides: Partial<Parameters<typeof buildManifest>[0]>) =>
      buildManifest({
        baseline: cleanBaseline(),
        catalog: holdout,
        commands: ["pnpm exec tsx eval/continuation-acceptance-1a3b/build-manifest.ts"],
        fixtureSeed: 196,
        gitCommit: "0123456789abcdef0123456789abcdef01234567",
        pins,
        required: ["AC-X01", "AC-X03", "AC-X04", "AC-M01"],
        sampleSeed: 1960,
        ...overrides,
      });

    const scoped = build({});

    expect(scoped.acceptance.required).toEqual([
      "AC-X01",
      "AC-X03",
      "AC-X04",
      "AC-M01",
    ]);
    // No Bio pool means no Bio sample, and AC-X02 is absent from the group map
    // rather than present-but-unenforced.
    expect(scoped.bio).toBeNull();
    expect(scoped.acceptance.evidenceGroups.bioNaturalness).toBeUndefined();
    expect(scoped.continuation.poolCount).toBe(18);
    expect(scoped.validator.total).toBe(6);
    // The declared list is part of the release identity, so a G1-only release
    // cannot share a fingerprint with a full one.
    expect(scoped.fingerprint).not.toBe(manifest().fingerprint);

    // Requiring a criterion the catalog cannot produce must be refused, not
    // silently downgraded to a pass.
    expect(() => build({ required: ["AC-X01", "AC-X02"] })).toThrow(/AC-X02/);
    expect(() => build({ required: ["AC-X02"] })).toThrow(/AC-X02/);
    // An unrecognised criterion is refused by name, so a typo cannot quietly
    // narrow the gate.
    expect(() => build({ required: ["AC-X0Z" as "AC-X01"] })).toThrow(/AC-X0Z/);
    expect(() => build({ required: [] })).toThrow(/at least one/);
    // AC-X04 is the one criterion a release cannot opt out of: its only data
    // source is a Continuation run, and the evidence producer requires a full
    // 18-fixture report. Letting a release drop it would recreate the gate that
    // passes while checking nothing.
    expect(() =>
      build({ required: ["AC-X01", "AC-X03", "AC-M01"] }),
    ).toThrow(/AC-X04/);
    // Continuation stays mandatory for the same reason.
    expect(() =>
      build({ catalog: validatorOnlyCatalog(), required: ["AC-X03", "AC-X04", "AC-M01"] }),
    ).toThrow(/Continuation pool/);
  });

  it("refuses to build a Bio comparison against a manifest that carries no Bio sample", () => {
    // Reachable by dropping AC-X02 from a catalog that does carry Bio: the
    // release says Bio is not a gate, so the manifest records no Bio sample
    // even though the fixtures exist. Building a Bio comparison from it would
    // produce a comparison that looks real while judging nothing.
    const scoped = buildManifest({
      baseline: cleanBaseline(),
      catalog,
      commands: ["pnpm exec tsx eval/continuation-acceptance-1a3b/build-manifest.ts"],
      fixtureSeed: 196,
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      pins,
      required: ["AC-X01", "AC-X03", "AC-X04", "AC-M01"],
      sampleSeed: 1960,
    });

    expect(scoped.bio).toBeNull();
    expect(() =>
      buildReviewPackage({
        baselineRun: syntheticRun("incumbent", "bio_naturalness"),
        candidateRun: syntheticRun("candidate", "bio_naturalness"),
        catalog,
        group: "bio_naturalness",
        manifest: scoped,
      }),
    ).toThrow(/no Bio naturalness sample/i);

    // The incumbent manifest, which does require AC-X02, still compares Bio.
    expect(() =>
      buildReviewPackage({
        baselineRun: syntheticRun("incumbent", "bio_naturalness"),
        candidateRun: syntheticRun("candidate", "bio_naturalness"),
        catalog,
        group: "bio_naturalness",
        manifest: manifest(),
      }),
    ).not.toThrow();
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
      required: ["AC-X01", "AC-X02", "AC-X03", "AC-X04", "AC-M01"],
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
      required: ["AC-X01", "AC-X02", "AC-X03", "AC-X04", "AC-M01"],
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
      required: ["AC-X01", "AC-X02", "AC-X03", "AC-X04", "AC-M01"],
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
      required: ["AC-X01", "AC-X02", "AC-X03", "AC-X04", "AC-M01"],
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
    // A catalog with no Continuation pool, so the hard gates must refuse
    // rather than report a pass having checked nothing. This is the
    // validator-only shape the #252 holdout started as.
    const holdout = JSON.parse(
      readFileSync(
        resolve(root, "eval/continuation-acceptance-1a3b/holdout/fixtures.json"),
        "utf8",
      ),
    ) as Parameters<typeof verifySyntheticRunHardGates>[0];
    const validatorOnly: Parameters<typeof verifySyntheticRunHardGates>[0] = {
      ...holdout,
      scenarios: holdout.scenarios.filter(
        (fixture) => fixture.group !== "continuation",
      ),
    };

    const emptyPool = verifySyntheticRunHardGates(
      validatorOnly,
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

  it("never fails the hard gates on a missing lexical token, on either arm", () => {
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

    // Whether the response recalled the right thing is a judgement about
    // meaning. Substring matching cannot decide it, and an arm-dependent mode
    // made the incumbent pass on the same response the candidate failed on, so
    // the finding is advisory for both and travels to the blind review.
    const report = verifySyntheticRunHardGates(catalog, responseWithoutRequiredToken);
    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
    expect(
      report.advisories.some((entry) => entry.includes("required_recall_missing")),
    ).toBe(true);
  });

  it("never fails the hard gates on a forbidden token that appears in a disclaimer", () => {
    // A response that says it is not a therapist, or offers no guarantee,
    // states the truth. A forbidden-token check that fails it is punishing the
    // correct answer, so the finding is advisory like the recall findings.
    const fixture = catalog.scenarios.find(
      (entry) =>
        entry.group === "continuation" &&
        entry.category === "high_risk" &&
        entry.hardGate.forbiddenTokens.length > 0,
    );
    expect(fixture).toBeDefined();
    const candidate = syntheticRun("candidate", "continuation");
    const withDisclaimer = {
      ...candidate,
      scenarios: candidate.scenarios.map((entry) =>
        entry.fixtureId === fixture!.id
          ? {
              ...entry,
              turns: entry.turns.map((turn) =>
                turn.sequenceInScenario === 1
                  ? {
                      ...turn,
                      assistantText:
                        "I am not a therapist and I cannot promise that. Please reach out to a doctor you trust.",
                    }
                  : turn,
              ),
            }
          : entry,
      ),
    };

    const report = verifySyntheticRunHardGates(catalog, withDisclaimer);
    expect(report.failures).toEqual([]);
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

  it("records the validator ledger's error budget without enforcing it (ADR-0143)", () => {
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
    // The cap this used to enforce was a semantic judgement with no gold set
    // behind it, and it refused the ledger that reported the finding rather
    // than the finding. A ledger recording rejects is valid input now; what the
    // release does with the number is decided elsewhere, and currently is
    // nothing. What is still refused is a malformed budget.
    expect(
      validateValidatorLedger({ catalog, ledger: { ...base, entries: oneReject, maxRejects: 2 } }),
    ).toEqual({ accepted: 17, maxRejects: 2, rejected: 1, total: 18 });
    expect(() =>
      validateValidatorLedger({ catalog, ledger: { ...base, entries: oneReject, maxRejects: -1 } }),
    ).toThrow(/non-negative integer/);
  });
});
