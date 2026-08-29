import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTION_SELECTION_DATASET_VERSION,
  CATALOG_VERSION,
  EXPECTED_SELECTION_QUOTAS,
  HARNESS_POLICY_VERSION,
  PROMPT_VERSION,
  TRUST_ACTION_KINDS,
  verifySelectionDataset,
  verifySelectionResults,
  type ActionSelectionDataset,
  type ActionSelectionResultFile,
} from "../eval/action-selection/memory-trust-actions:v1/selection-checks";

const datasetPath = resolve(
  process.cwd(),
  "eval/action-selection/memory-trust-actions:v1/scenarios.json",
);
const dataset = JSON.parse(
  readFileSync(datasetPath, "utf8"),
) as ActionSelectionDataset;

const miniDataset = {
  version: ACTION_SELECTION_DATASET_VERSION,
  catalogVersion: CATALOG_VERSION,
  harnessPolicyVersion: HARNESS_POLICY_VERSION,
  promptVersion: PROMPT_VERSION,
  maxFixtures: 80,
  headroom: 76,
  syntheticNotice: "This small verifier fixture is synthetic.",
  scenarios: [
    {
      id: "mini-correction",
      category: "correction",
      scenarioClass: "positive",
      languageVariant: "en",
      locale: "en-US",
      timezone: "America/Los_Angeles",
      description: "A synthetic correction with a unique claim target.",
      synthetic: true,
      turns: [{ text: "That memory is wrong; I moved to Cedar City." }],
      expected: {
        outcome: "action",
        actionKind: "memory_correction",
        target: {
          kind: "memory_claim",
          reference: "synthetic:memory-claim:mini-correction",
        },
        qualifier: null,
        entityOperation: null,
        clarificationReason: null,
        compoundPriority: null,
        unsupportedReason: null,
      },
    },
    {
      id: "mini-forget-qualifier",
      category: "forget",
      scenarioClass: "positive",
      languageVariant: "zh",
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      description: "A synthetic relationship qualifier forget request.",
      synthetic: true,
      turns: [{ text: "请忘记我和 Cedar 的同事关系。" }],
      expected: {
        outcome: "action",
        actionKind: "memory_forget_request",
        target: {
          kind: "relationship_qualifier",
          reference: "synthetic:relationship-qualifier:mini-forget",
        },
        qualifier: {
          axis: "relationship",
          roleSide: "canonical_subject",
          value: "colleague",
        },
        entityOperation: null,
        clarificationReason: null,
        compoundPriority: null,
        unsupportedReason: null,
      },
    },
    {
      id: "mini-ambiguous",
      category: "explain",
      scenarioClass: "ambiguity_clarification",
      languageVariant: "code_switch",
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      description: "A synthetic source request with two matching claims.",
      synthetic: true,
      turns: [{ text: "这个记忆的 source 是哪一个？" }],
      expected: {
        outcome: "clarification_required",
        actionKind: null,
        target: null,
        qualifier: null,
        entityOperation: null,
        clarificationReason: "target_ambiguous_multi_hit",
        compoundPriority: null,
        unsupportedReason: null,
      },
    },
    {
      id: "mini-unsupported",
      category: "shared_hard_negative",
      scenarioClass: "hard_negative",
      languageVariant: "en",
      locale: "en-US",
      timezone: "America/Los_Angeles",
      description: "A synthetic account deletion request outside this catalog.",
      synthetic: true,
      hardNegativeKind: "account_deletion",
      turns: [{ text: "Delete my account permanently." }],
      expected: {
        outcome: "unsupported",
        actionKind: null,
        target: null,
        qualifier: null,
        entityOperation: null,
        clarificationReason: null,
        compoundPriority: null,
        unsupportedReason: "account_deletion_not_in_catalog",
      },
    },
  ],
} satisfies ActionSelectionDataset;

const miniResultFile = {
  version: "action-selection-results:v1",
  datasetVersion: ACTION_SELECTION_DATASET_VERSION,
  catalogVersion: CATALOG_VERSION,
  harnessPolicyVersion: HARNESS_POLICY_VERSION,
  promptVersion: PROMPT_VERSION,
  results: [
    {
      fixtureId: "mini-correction",
      outcome: "action",
      actionKind: "memory_correction",
      target: {
        kind: "memory_claim",
        reference: "synthetic:memory-claim:mini-correction",
      },
      qualifier: null,
      entityOperation: null,
      clarificationReason: null,
      compoundPriority: null,
      unsupportedReason: null,
    },
    {
      fixtureId: "mini-forget-qualifier",
      outcome: "action",
      actionKind: "memory_forget_request",
      target: {
        kind: "relationship_qualifier",
        reference: "synthetic:relationship-qualifier:mini-forget",
      },
      qualifier: {
        axis: "relationship",
        roleSide: "canonical_subject",
        value: "colleague",
      },
      entityOperation: null,
      clarificationReason: null,
      compoundPriority: null,
      unsupportedReason: null,
    },
    {
      fixtureId: "mini-ambiguous",
      outcome: "clarification_required",
      actionKind: null,
      target: null,
      qualifier: null,
      entityOperation: null,
      clarificationReason: "target_ambiguous_multi_hit",
      compoundPriority: null,
      unsupportedReason: null,
    },
    {
      fixtureId: "mini-unsupported",
      outcome: "unsupported",
      actionKind: null,
      target: null,
      qualifier: null,
      entityOperation: null,
      clarificationReason: null,
      compoundPriority: null,
      unsupportedReason: "account_deletion_not_in_catalog",
    },
  ],
} satisfies ActionSelectionResultFile;

describe("memory trust-action selection dataset v1", () => {
  it("ships the exact 76-fixture pack and reserves four headroom slots", () => {
    const verification = verifySelectionDataset(dataset);

    expect(verification.mismatches).toEqual([]);
    expect(verification.passed).toBe(true);
    expect(verification.fixtureCount).toBe(76);
    expect(verification.headroom).toBe(4);
    expect(dataset.version).toBe(ACTION_SELECTION_DATASET_VERSION);
    expect(dataset.catalogVersion).toBe(CATALOG_VERSION);
    expect(dataset.harnessPolicyVersion).toBe(HARNESS_POLICY_VERSION);
    expect(dataset.promptVersion).toBe(PROMPT_VERSION);
    expect(verification.counts).toEqual(EXPECTED_SELECTION_QUOTAS);
  });

  it("covers every Trust Action, entity operation, compound priority, and shared hard negative", () => {
    expect(
      new Set(
        dataset.scenarios
          .filter((scenario) => scenario.expected.outcome === "action")
          .map((scenario) => scenario.expected.actionKind),
      ),
    ).toEqual(new Set(TRUST_ACTION_KINDS));
    expect(
      new Set(
        dataset.scenarios
          .map((scenario) => scenario.expected.entityOperation)
          .filter((operation): operation is "merge" | "split" | "promote" => operation !== null),
      ),
    ).toEqual(new Set(["merge", "split", "promote"]));
    expect(
      dataset.scenarios
        .filter((scenario) => scenario.scenarioClass === "compound_priority")
        .every((scenario) => scenario.expected.compoundPriority === "trust_control"),
    ).toBe(true);
    expect(
      new Set(
        dataset.scenarios
          .map((scenario) => scenario.hardNegativeKind)
          .filter((kind): kind is "account_deletion" | "bulk_clearing" | "invented_tool" => kind !== undefined),
      ),
    ).toEqual(new Set(["account_deletion", "bulk_clearing", "invented_tool"]));
    expect(
      dataset.scenarios.some(
        (scenario) => scenario.expected.unsupportedReason === "person_wide_unsupported",
      ),
    ).toBe(true);
  });

  it("rejects a fixture that loses its synthetic marker", () => {
    const invalidDataset = {
      ...dataset,
      scenarios: dataset.scenarios.map((scenario, index) =>
        index === 0 ? { ...scenario, synthetic: false } : scenario,
      ),
    };

    const verification = verifySelectionDataset(invalidDataset);

    expect(verification.passed).toBe(false);
    expect(verification.mismatches).toContainEqual(
      expect.objectContaining({
        code: "synthetic",
        fixtureId: "correction-positive-en-01",
      }),
    );
  });

  it("requires the person-wide Forget boundary in every pack language", () => {
    const invalidDataset = {
      ...dataset,
      scenarios: dataset.scenarios.map((scenario) =>
        scenario.id === "forget-near-en-01"
          ? {
              ...scenario,
              expected: {
                ...scenario.expected,
                unsupportedReason: "conversation_deletion_not_supported",
              },
            }
          : scenario,
      ),
    };

    const verification = verifySelectionDataset(invalidDataset);

    expect(verification.passed).toBe(false);
    expect(verification.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "person_wide_forget" }),
        expect.objectContaining({ code: "person_wide_forget_language" }),
      ]),
    );
  });

  it("verifies a normalized result file without provider payloads", () => {
    const verification = verifySelectionResults({
      dataset: miniDataset,
      resultFile: miniResultFile,
    });

    expect(verification).toMatchObject({
      passed: true,
      fixtureCount: 4,
      resultCount: 4,
      conformance: 1,
      wrongTarget: 0,
      falseSuccess: 0,
    });
    expect(verification.mismatches).toEqual([]);

    const reorderedResultFile = {
      ...miniResultFile,
      results: miniResultFile.results.map((result) =>
        result.fixtureId === "mini-correction"
          ? {
              ...result,
              target: {
                reference: "synthetic:memory-claim:mini-correction",
                kind: "memory_claim" as const,
              },
            }
          : result,
      ),
    };
    expect(
      verifySelectionResults({
        dataset: miniDataset,
        resultFile: reorderedResultFile,
      }).passed,
    ).toBe(true);
  });

  it("gates wrong targets, false success, extra payloads, duplicates, and omissions", () => {
    const mutatedResultFile = {
      ...miniResultFile,
      results: miniResultFile.results.map((result) =>
        result.fixtureId === "mini-forget-qualifier"
          ? {
              ...result,
              target: {
                kind: "relationship_qualifier" as const,
                reference: "synthetic:relationship-qualifier:wrong-target",
              },
            }
          : result.fixtureId === "mini-unsupported"
            ? {
                ...result,
                outcome: "action" as const,
                actionKind: "memory_correction" as const,
                target: {
                  kind: "memory_claim" as const,
                  reference: "synthetic:memory-claim:false-success",
                },
                unsupportedReason: null,
                userText: "private payload must not be accepted",
              }
            : result,
      ),
      userText: "top-level private payload must not be accepted",
    };
    const mutatedVerification = verifySelectionResults({
      dataset: miniDataset,
      resultFile: mutatedResultFile,
    });

    expect(mutatedVerification.passed).toBe(false);
    expect(mutatedVerification.wrongTarget).toBe(1);
    expect(mutatedVerification.falseSuccess).toBe(1);
    expect(mutatedVerification.mismatches).toContainEqual(
      expect.objectContaining({ code: "result_payload", fixtureId: "mini-unsupported" }),
    );

    const incompleteResultFile = {
      ...miniResultFile,
      results: [
        miniResultFile.results[0],
        miniResultFile.results[0],
        miniResultFile.results[1],
      ],
    };
    const incompleteVerification = verifySelectionResults({
      dataset: miniDataset,
      resultFile: incompleteResultFile,
    });

    expect(incompleteVerification.passed).toBe(false);
    expect(incompleteVerification.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_result_id", fixtureId: "mini-correction" }),
        expect.objectContaining({ code: "missing_result_id", fixtureId: "mini-ambiguous" }),
        expect.objectContaining({ code: "missing_result_id", fixtureId: "mini-unsupported" }),
      ]),
    );
  });
});
