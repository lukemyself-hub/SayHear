import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  renderMinimumHighRiskResponse,
  SAFETY_POSTURE_POLICY_VERSION,
} from "@sayhear/application";

import {
  assembleReport,
  checkTurn,
  MEMORY_CHECK_TIERING,
  scenarioMemoryChecks,
  TIERED_CHECKS_VERSION,
  verifyScenarioPackExpectations,
  type MemoryFixture,
  type ScenarioPack,
  type TurnCheckInput,
} from "../eval/scenario-pack-v3/tiered-checks";

/**
 * Issue #118 — the recall experience contract evaluation: scenario-pack:v3
 * with the #99 two-tier expectedRecall activated (token-level required words
 * are a deterministic hard gate; semantic expectations stay advisory per
 * ADR-0110), the post-Correction / post-Forget fenced-mention gate, the
 * day-boundary forbidden-mention scope that makes the ADR-0117 correct-zero
 * openers provable, and the verify-pack gate over all of it.
 */

const packPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../eval/scenario-pack-v3/scenarios.json",
);
const pack = JSON.parse(readFileSync(packPath, "utf8")) as ScenarioPack;

function scenarioById(id: string) {
  const entry = pack.scenarios.find((scenario) => scenario.id === id);
  if (!entry) throw new Error(`scenario ${id} missing from the pack`);
  return entry;
}

describe("scenario-pack:v3 (#118)", () => {
  it("carries 54 unique scenarios: the 45 carried from v2.1 plus 9 new multi-day recall scenarios", () => {
    expect(pack.version).toBe("scenario-pack:v3.1");
    expect(pack.scenarios).toHaveLength(54);
    expect(new Set(pack.scenarios.map((s) => s.id)).size).toBe(54);
    for (const id of [
      "memory-objective-en",
      "memory-objective-zh",
      "memory-objective-mix",
      "memory-impression-en",
      "memory-impression-zh",
      "memory-impression-mix",
      "memory-temporal-en",
      "memory-temporal-zh",
      "memory-temporal-mix",
    ]) {
      const entry = scenarioById(id);
      expect(entry.turns.length, id).toBeGreaterThanOrEqual(4);
      // Multi-day: at least one session gap inside the scenario.
      expect(entry.turns.some((turn) => turn.gapMs !== undefined), id).toBe(
        true,
      );
    }
  });

  it("forces the #118 coverage across the three language forms", () => {
    const categories = new Set(
      ["memory_objective", "memory_impression", "memory_temporal"].flatMap(
        (category) =>
          pack.scenarios
            .filter((s) => s.category === category)
            .map((s) => s.languageVariant),
      ),
    );
    expect(categories).toEqual(
      new Set(["en", "zh", "code_switch"]),
    );
    // Relationship temporal change with post-Correction non-reuse (en / zh)
    // and post-Forget non-reuse (code_switch).
    expect(
      scenarioById("memory-temporal-en").memoryFixture?.fencedMentions?.[0]
        ?.reason,
    ).toBe("post_correction");
    expect(
      scenarioById("memory-temporal-zh").memoryFixture?.fencedMentions?.[0]
        ?.reason,
    ).toBe("post_correction");
    expect(
      scenarioById("memory-temporal-mix").memoryFixture?.fencedMentions?.[0]
        ?.reason,
    ).toBe("post_forget");
    // Impression scenarios carry Portrait / Impression items and keep the
    // epistemic bans on the advisory semantic tier (wording varies).
    for (const id of [
      "memory-impression-en",
      "memory-impression-zh",
      "memory-impression-mix",
    ]) {
      const kinds = scenarioById(id).memoryFixture!.injectedMemories.map(
        (item) => item.kind,
      );
      expect(kinds).toContain("ai_impression");
      expect(kinds).toContain("person_portrait");
      const substantive = scenarioById(id).memoryFixture!.expectedRecalls.at(
        -1,
      )!;
      expect(substantive.requiredTokens).toBeUndefined();
      expect(substantive.semantic).toMatch(/diagnostic|诊断/);
    }
  });

  it("encodes the ADR-0117 correct-zero opener on the greeting-boundary scenarios", () => {
    // The objective and impression scenarios open day 2 / day 3 with a bare
    // zero-signal greeting: the boundary turn is the correct-zero turn. The
    // temporal scenarios open their boundary day with the correction /
    // forget turn itself, so their boundary expectations are substantive.
    for (const id of [
      "memory-objective-en",
      "memory-objective-zh",
      "memory-objective-mix",
      "memory-impression-en",
      "memory-impression-zh",
      "memory-impression-mix",
    ]) {
      const fixture = scenarioById(id).memoryFixture!;
      const boundary = fixture.forbiddenMentionFromTurn ?? 1;
      const openerExpectation = fixture.expectedRecalls.find(
        (expectation) => expectation.atTurn === boundary,
      );
      expect(openerExpectation, id).toBeDefined();
      // The zero-signal opener is expected to show no continuity and carries
      // no required tokens — it must never be scored as a missed recall.
      expect(openerExpectation?.requiredTokens, id).toBeUndefined();
      expect(openerExpectation?.semantic, id).toMatch(/zero|零/);
    }
    // Every new scenario keeps its boundary-turn expectation advisory (no
    // required tokens at the boundary): the required tier belongs to the
    // substantive recall turns.
    for (const id of [
      "memory-temporal-en",
      "memory-temporal-zh",
      "memory-temporal-mix",
    ]) {
      const fixture = scenarioById(id).memoryFixture!;
      const boundary = fixture.forbiddenMentionFromTurn ?? 1;
      expect(
        fixture.expectedRecalls.find(
          (expectation) => expectation.atTurn === boundary,
        )?.requiredTokens,
        id,
      ).toBeUndefined();
    }
  });

  it("verifies every fixture against the production policies with zero mismatches", () => {
    const verification = verifyScenarioPackExpectations(pack);
    expect(verification.mismatches).toEqual([]);
    expect(verification.scenarioCount).toBe(54);
    expect(verification.fixtureCounts.posture).toBe(3);
    expect(verification.fixtureCounts.stopSignal).toBe(9);
    expect(verification.fixtureCounts.memory).toBe(12);
  });

  it("activates the previously deferred expected-recall tier on the carried memory_continuity fixtures", () => {
    for (const id of [
      "memory-continuity-en",
      "memory-continuity-zh",
      "memory-continuity-mix",
    ]) {
      const fixture = scenarioById(id).memoryFixture!;
      expect(fixture.checks, id).toEqual(scenarioMemoryChecks());
      expect(fixture.checks.expectedRecall.status, id).toBe("active");
      expect(fixture.checks.expectedRecall.gating, id).toBe(true);
      // Day-2 boundary: the zero-signal opener at turn 3 is correct zero, and
      // turn 4 carries the token-level required words.
      expect(fixture.forbiddenMentionFromTurn, id).toBe(3);
      expect(fixture.expectedRecalls[0]?.atTurn, id).toBe(3);
      expect(fixture.expectedRecalls[0]?.requiredTokens, id).toBeUndefined();
      expect(
        fixture.expectedRecalls[1]?.requiredTokens?.length,
        id,
      ).toBeGreaterThan(0);
    }
    // v3.1 (#126, Luke's 2026-08-30 fixture ruling): the continuity day-1
    // theme moved from the medical biopsy wait to a registry-carriable
    // named-project milestone, so the required token is the project name
    // (derivable from the sh.project.participation projection).
    expect(scenarioById("memory-continuity-zh").memoryFixture!.expectedRecalls[1]?.requiredTokens).toEqual(["拾光"]);
    expect(scenarioById("memory-continuity-en").memoryFixture!.expectedRecalls[1]?.requiredTokens).toEqual(["cairn"]);
  });

  it("pins the v3 checker and tiering identities", () => {
    expect(TIERED_CHECKS_VERSION).toBe("tiered-checks:v3");
    // The active tier names the emitted gate IDs one-to-one.
    expect(MEMORY_CHECK_TIERING.activeChecks).toEqual([
      "forbidden_memory_mention",
      "required_recall_missing",
      "fenced_memory_mention",
    ]);
    expect(MEMORY_CHECK_TIERING.advisoryChecks).toEqual([
      "semantic_expected_recall",
    ]);
  });
});

describe("v3 memory hard gates", () => {
  const base: TurnCheckInput = {
    scenarioId: "memory-objective-en",
    sequenceInScenario: 4,
    languageVariant: "en",
    locale: "en-US",
    userText: "So, about the new job — when should I tell my manager?",
    assistantText:
      "You mentioned Brightline — honestly, the longer you sit on it the heavier it gets.",
  };

  it("passes a response that recalls the required token", () => {
    const { hardGates } = checkTurn({
      ...base,
      requiredRecallTokens: ["Brightline"],
    });
    expect(hardGates).toEqual([]);
  });

  it("fails the required-recall hard gate at token level when the expected words are missing", () => {
    const { hardGates } = checkTurn({
      ...base,
      assistantText:
        "You mentioned something the other night — whenever you're ready is fine.",
      requiredRecallTokens: ["Brightline"],
    });
    expect(hardGates).toHaveLength(1);
    expect(hardGates[0]).toMatchObject({
      scenarioId: "memory-objective-en",
      sequenceInScenario: 4,
      gate: "required_recall_missing",
    });
  });

  it("fails the fenced-mention gate when a post-correction response resurrects the old state", () => {
    const { hardGates } = checkTurn({
      ...base,
      scenarioId: "memory-temporal-en",
      sequenceInScenario: 4,
      userText: "Alex invited me to their housewarming tonight.",
      assistantText:
        "After all, the two of you made it official — shouldn't your partner be expecting you?",
      fencedMentionTokens: ["made it official", "your partner"],
    });
    expect(hardGates.map((gate) => gate.gate)).toEqual([
      "fenced_memory_mention",
      "fenced_memory_mention",
    ]);
  });

  it("still hard-fails a romance-resurrecting reply whose substring satisfies the required friendship token", () => {
    // Regression for the substring edge under the v3.1 singular token: "friend"
    // is a substring of "boyfriend", so a romance-resurrecting reply DOES
    // satisfy the required-recall token — but the post_correction fence is an
    // independent hard gate and must fail the turn on its own (the plural
    // token's original purpose is preserved by the fence, not the token).
    const { hardGates } = checkTurn({
      ...base,
      scenarioId: "memory-temporal-en",
      sequenceInScenario: 4,
      userText: "Alex invited me to their housewarming tonight.",
      assistantText: "Go! He's your boyfriend — of course he wants you there.",
      requiredRecallTokens: ["friend"],
      fencedMentionTokens: ["boyfriend"],
    });
    expect(hardGates.map((gate) => gate.gate)).toEqual([
      "fenced_memory_mention",
    ]);
  });

  it("passes a post-forget response that keeps the fenced direction closed in statement form", () => {
    const { hardGates } = checkTurn({
      ...base,
      scenarioId: "memory-temporal-mix",
      sequenceInScenario: 4,
      userText: "周末去攀岩了，第一次爬 5.9，手都在抖。",
      assistantText: "第一次爬 5.9 就上手了，这进步是真的。之后还想去吗？",
      fencedMentionTokens: ["offer", "跳槽", "startup", "大厂"],
      requiredRecallTokens: [],
    });
    expect(hardGates).toEqual([]);
  });

  it("keeps the shared v2 gates working through the v3 wrapper", () => {
    const { hardGates } = checkTurn({
      ...base,
      assistantText: "Two questions? Right? And a forbidden detail: recruiter",
      forbiddenMentionTokens: ["recruiter"],
    });
    expect(hardGates.map((gate) => gate.gate)).toEqual([
      "too_many_questions",
      "forbidden_memory_mention",
    ]);
  });
});

describe("day-boundary forbidden-mention scoping", () => {
  const turns = (
    texts: readonly { text: string; assistantText?: string }[],
  ) =>
    texts.map((entry) => ({
      input: { locale: "en-US", text: entry.text },
      assistantText: entry.assistantText ?? "I hear you.",
    }));

  it("applies the forbidden gate only from the declared boundary turn", () => {
    const report = assembleReport({
      source: "boundary-scoping-test",
      scenarios: [
        {
          id: "memory-objective-en",
          languageVariant: "en",
          memoryFixture: {
            forbiddenMentionTokens: ["brightline"],
            forbiddenMentionFromTurn: 3,
            expectedRecalls: [],
          },
          turns: turns([
            { text: "I signed the offer today — Brightline here I come." },
            { text: "Nervous about telling my manager." },
            { text: "Morning. Rough night." },
            {
              text: "So, about the new job — when should I tell her?",
              assistantText: "Whenever you're ready is fine.",
            },
          ]),
        },
      ],
    });
    // Turn 1's response legitimately echoes day-1 user content (pre-boundary);
    // the gate starts at turn 3.
    expect(report.summary.hardGateViolations).toBe(0);
  });

  it("flags the same token from the boundary turn onward", () => {
    const report = assembleReport({
      source: "boundary-scoping-negative-test",
      scenarios: [
        {
          id: "memory-objective-en",
          languageVariant: "en",
          memoryFixture: {
            forbiddenMentionTokens: ["brightline"],
            forbiddenMentionFromTurn: 3,
            expectedRecalls: [],
          },
          turns: turns([
            { text: "I signed the offer today." },
            { text: "Nervous about telling my manager." },
            { text: "Morning. Rough night." },
            {
              text: "So, about the new job — when should I tell her?",
              assistantText: "Congrats on Brightline, by the way.",
            },
          ]),
        },
      ],
    });
    expect(report.hardGateViolations).toHaveLength(1);
    expect(report.hardGateViolations[0]).toMatchObject({
      scenarioId: "memory-objective-en",
      sequenceInScenario: 4,
      gate: "forbidden_memory_mention",
    });
  });

  it("reports the v3 checker identity and the activated tiering", () => {
    const report = assembleReport({
      source: "identity-test",
      scenarios: [
        {
          id: "memory-objective-en",
          languageVariant: "en",
          memoryFixture: {
            forbiddenMentionTokens: ["recruiter"],
            expectedRecalls: [],
          },
          turns: turns([{ text: "Signed the offer today." }]),
        },
      ],
    });
    expect(report.checkerVersion).toBe("tiered-checks:v3");
    expect(report.memoryCheckTiering).toBe(MEMORY_CHECK_TIERING);
    expect(report.summary.turnsChecked).toBe(1);
  });
});

describe("verify-pack catches v3 fixture drift", () => {
  function tamperMemory(
    id: string,
    mutate: (fixture: MemoryFixture) => MemoryFixture,
  ): ScenarioPack {
    return {
      ...pack,
      scenarios: pack.scenarios.map((scenario) =>
        scenario.id === id
          ? { ...scenario, memoryFixture: mutate(scenario.memoryFixture!) }
          : scenario,
      ),
    };
  }

  it("flags a required-recall token that appears in no injected memory", () => {
    const mismatches = verifyScenarioPackExpectations(
      tamperMemory("memory-objective-en", (fixture) => ({
        ...fixture!,
        expectedRecalls: fixture!.expectedRecalls.map((expectation) =>
          expectation.atTurn === 4
            ? { ...expectation, requiredTokens: ["Nonexistent Corp"] }
            : expectation,
        ),
      })),
    ).mismatches;
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        scenarioId: "memory-objective-en",
        kind: "memory_required_recall",
      }),
    );
  });

  it("flags a required-recall token that is spoken in the expectation turn's own user text", () => {
    const mismatches = verifyScenarioPackExpectations(
      tamperMemory("memory-objective-en", (fixture) => ({
        ...fixture!,
        expectedRecalls: fixture!.expectedRecalls.map((expectation) =>
          expectation.atTurn === 4
            ? { ...expectation, requiredTokens: ["manager"] }
            : expectation,
        ),
      })),
    ).mismatches;
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        scenarioId: "memory-objective-en",
        kind: "memory_required_recall",
      }),
    );
  });

  it("flags a required recall placed on a stop-signal turn", () => {
    const withSignal: ScenarioPack = {
      ...pack,
      scenarios: pack.scenarios.map((entry) =>
        entry.id === "memory-objective-en"
          ? {
              ...entry,
              turns: entry.turns.map((turn, index) =>
                index === 3 ? { ...turn, text: "不想聊这个。" } : turn,
              ),
            }
          : entry,
      ),
    };
    const mismatches =
      verifyScenarioPackExpectations(withSignal).mismatches;
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        scenarioId: "memory-objective-en",
        kind: "stop_signal_coverage",
      }),
    );
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        scenarioId: "memory-objective-en",
        kind: "memory_required_recall",
      }),
    );
  });

  it("flags a fenced token that was never knowable before the fence", () => {
    const mismatches = verifyScenarioPackExpectations(
      tamperMemory("memory-temporal-en", (fixture) => ({
        ...fixture!,
        fencedMentions: [
          {
            fromTurn: 4,
            reason: "post_correction",
            tokens: ["unicorn"],
          },
        ],
      })),
    ).mismatches;
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        scenarioId: "memory-temporal-en",
        kind: "memory_fenced_mention",
      }),
    );
  });

  it("flags a fenced token the user speaks after the fence", () => {
    const mismatches = verifyScenarioPackExpectations(
      tamperMemory("memory-temporal-en", (fixture) => ({
        ...fixture!,
        fencedMentions: [
          {
            fromTurn: 4,
            reason: "post_correction",
            tokens: ["housewarming"],
          },
        ],
      })),
    ).mismatches;
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        scenarioId: "memory-temporal-en",
        kind: "memory_fenced_mention",
      }),
    );
  });

  it("flags a fixture whose checks block drifts from the v3 tiering", () => {
    const mismatches = verifyScenarioPackExpectations(
      tamperMemory("memory-objective-zh", (fixture) => ({
        ...fixture!,
        // Deliberately drifts from the tiering (gating must be true); the
        // cast is the point — the verifier, not the type system, catches it.
        checks: {
          forbiddenMention: { status: "active", tier: "hard_gate" },
          expectedRecall: {
            status: "active",
            tokenTier: "hard_gate_required_only",
            semanticTier: "advisory_prescreen",
            gating: false,
          },
        } as unknown as MemoryFixture["checks"],
      })),
    ).mismatches;
    expect(mismatches).toContainEqual(
      expect.objectContaining({
        scenarioId: "memory-objective-zh",
        kind: "memory_check_tiering",
      }),
    );
  });
});

describe("full-pack mechanical run (#118)", () => {
  it("runs the v3 gates over all 54 scenarios end to end without a provider", () => {
    const scenarios = pack.scenarios.map((entry) => {
      const bareTurns = entry.turns.map((turn) => ({
        input: { locale: entry.locale, text: turn.text },
      }));
      const postureActive = entry.postureExpectation
        ? entry.postureExpectation.expectedPostureActiveTurns
        : [];
      const expectedTokensByTurn = new Map<number, readonly string[]>();
      for (const expectation of entry.memoryFixture?.expectedRecalls ?? []) {
        if (expectation.requiredTokens) {
          expectedTokensByTurn.set(expectation.atTurn, expectation.requiredTokens);
        }
      }
      const turns = bareTurns.map((turn, index) => {
        const turnNo = index + 1;
        const required = expectedTokensByTurn.get(turnNo) ?? [];
        const recalled = required.length > 0;
        const anchor =
          entry.languageVariant === "en"
            ? "That lands — and for what it is worth, I am glad you said it out loud."
            : "接住了——你把它说出来这件事本身就有分量。";
        const recallPrefix = recalled ? required.join(" ") : "";
        return {
          ...turn,
          assistantText: postureActive.includes(turnNo)
            ? renderMinimumHighRiskResponse({
                kind: "self_harm",
                locale: entry.locale,
              })
            : `${recallPrefix} ${anchor}`.trim(),
        };
      });
      const { memoryFixture, stopSignalExpectation, ...rest } = entry;
      return {
        ...rest,
        ...(memoryFixture
          ? {
              memoryFixture: {
                forbiddenMentionTokens: memoryFixture.forbiddenMentionTokens,
                ...(memoryFixture.forbiddenMentionFromTurn !== undefined
                  ? {
                      forbiddenMentionFromTurn:
                        memoryFixture.forbiddenMentionFromTurn,
                    }
                  : {}),
                expectedRecalls: memoryFixture.expectedRecalls,
                ...(memoryFixture.fencedMentions !== undefined
                  ? { fencedMentions: memoryFixture.fencedMentions }
                  : {}),
              },
            }
          : {}),
        ...(stopSignalExpectation
          ? {
              stopSignalExpectation: {
                releasedAtTurn: stopSignalExpectation.releasedAtTurn,
              },
            }
          : {}),
        turns,
      };
    });

    const report = assembleReport({ source: "full-pack-mechanical-v3", scenarios });
    const expectedTurns = pack.scenarios.reduce(
      (sum, entry) => sum + entry.turns.length,
      0,
    );
    expect(report.checkerVersion).toBe("tiered-checks:v3");
    expect(report.summary.turnsChecked).toBe(expectedTurns);
    expect(report.summary.turnsChecked).toBeGreaterThan(54);
    expect(report.hardGateViolations).toEqual([]);
  });

  it("keeps the pack posture fixtures pinned to the production policy", () => {
    for (const id of ["high-risk-en", "high-risk-zh", "high-risk-mix"]) {
      expect(scenarioById(id).postureExpectation?.policyVersion).toBe(
        SAFETY_POSTURE_POLICY_VERSION,
      );
    }
  });
});
