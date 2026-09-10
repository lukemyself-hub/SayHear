import { describe, expect, it } from "vitest";

import {
  validateProposalEntryDraft,
  type RemapOutcome,
} from "./review";
import type {
  ProposalEntryDraft,
  ReviewerProposalDraft,
} from "./types";
import type { MemoryCandidateRecord } from "../memory-claim/types";

/**
 * SPEC #193 §8.3 / ADR-0122 / ADR-0053: the governance Proposal schema
 * structurally has no private fields, and the write path must reject a
 * reviewer draft that smuggles private content into free text, copies the
 * model's proposed concept, skips the attestation, or violates the length
 * limits. The check is deterministic — LLM-assisted drafting stays allowed,
 * but the human owns the final generic material.
 */

function draft(overrides: Partial<ReviewerProposalDraft> = {}): ReviewerProposalDraft {
  return {
    proposedPredicateIdentity: "sh.hobby.swimming",
    label: "regular swimming",
    definition:
      "A person swims regularly as a recurring activity, independent of venue.",
    valueSchemaDraft: { kind: "text" },
    syntheticExamples: {
      positive: ["swims twice a week"],
      negative: ["watched a swimming race once"],
    },
    rationale: "Recurring health routine has clear product value for care framing.",
    attestation: true,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<
    Pick<MemoryCandidateRecord, "proposedConcept" | "proposedObjectValue" | "proposedScopeKey">
  > = {},
): Pick<MemoryCandidateRecord, "proposedConcept" | "proposedObjectValue" | "proposedScopeKey"> {
  return {
    proposedConcept: "每周游泳两次",
    proposedObjectValue: "",
    proposedScopeKey: "",
    ...overrides,
  };
}

describe("governance proposal draft validation", () => {
  it("accepts a fully rewritten, attested, user-content-free draft", () => {
    const result = validateProposalEntryDraft({
      draft: draft(),
      candidate: candidate(),
      entityLabels: { "entity-1": "王小明" },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing reviewer attestation", () => {
    const result = validateProposalEntryDraft({
      draft: draft({ attestation: false }),
      candidate: candidate(),
      entityLabels: {},
    });
    expect(result).toEqual({
      ok: false,
      code: "proposal_draft_rejected",
      detail: expect.stringContaining("attestation"),
    });
  });

  it("rejects a label copied verbatim from the model's proposed concept", () => {
    const result = validateProposalEntryDraft({
      draft: draft({ label: "每周游泳两次" }),
      candidate: candidate(),
      entityLabels: {},
    });
    expect(result).toEqual({
      ok: false,
      code: "proposal_draft_rejected",
      detail: expect.stringContaining("rewritten"),
    });
  });

  it("rejects private content smuggled into free-text fields", () => {
    const smuggling = [
      { field: "definition", value: "Someone who 每周游泳两次 at a pool." },
      { field: "rationale", value: "Worth keeping; entity label 王小明 said so." },
      { field: "examples", value: "cue like 每周游泳两次" },
    ] as const;
    for (const item of smuggling) {
      const next =
        item.field === "definition"
          ? draft({ definition: item.value })
          : item.field === "rationale"
            ? draft({ rationale: item.value })
            : draft({
                syntheticExamples: {
                  positive: [item.value],
                  negative: [],
                },
              });
      const result = validateProposalEntryDraft({
        draft: next,
        candidate: candidate(),
        entityLabels: { "entity-1": "王小明" },
      });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a typed user value smuggled into the rationale", () => {
    const result = validateProposalEntryDraft({
      draft: draft({ rationale: "User typed 简洁 daily; keep it." }),
      candidate: candidate({ proposedObjectValue: "简洁" }),
      entityLabels: {},
    });
    expect(result).toEqual({
      ok: false,
      code: "proposal_draft_rejected",
      detail: expect.stringContaining("candidate or Entity"),
    });

  });

  it("rejects length violations and malformed predicate identity", () => {
    const tooLong = "x".repeat(201);
    const labelTooLong = validateProposalEntryDraft({
      draft: draft({ label: "y".repeat(121) }),
      candidate: candidate(),
      entityLabels: {},
    });
    expect(labelTooLong.ok).toBe(false);
    const badIdentity = validateProposalEntryDraft({
      draft: draft({ proposedPredicateIdentity: "hobby-swimming" }),
      candidate: candidate(),
      entityLabels: {},
    });
    expect(badIdentity.ok).toBe(false);
    const badSchema = validateProposalEntryDraft({
      draft: draft({ valueSchemaDraft: "text" as unknown as object }),
      candidate: candidate(),
      entityLabels: {},
    });
    expect(badSchema.ok).toBe(false);
    const longExample = validateProposalEntryDraft({
      draft: draft({
        syntheticExamples: { positive: [tooLong], negative: [] },
      }),
      candidate: candidate(),
      entityLabels: {},
    });
    expect(longExample.ok).toBe(false);
  });
});

describe("remap outcome vocabulary", () => {
  it("is a closed four-outcome union", () => {
    const outcomes: readonly RemapOutcome[] = [
      "converged",
      "no_longer_eligible",
      "governance_blocked",
      "still_unmapped",
    ];
    expect(outcomes).toHaveLength(4);
  });
});

/** The repository-level draft keeps the review baseline the service stamps. */
describe("proposal entry draft shape", () => {
  it("carries the base Registry version on the stored version", () => {
    const stored: ProposalEntryDraft = {
      ...draft(),
      baseRegistryVersion: 1,
    };
    expect(stored.baseRegistryVersion).toBe(1);
  });
});
