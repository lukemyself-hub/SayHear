import { describe, expect, it } from "vitest";

import {
  InvalidMemoryConsolidateProposalError,
  addDaysToDateString,
  dateOrdinal,
  evidenceCutoff,
  validateConsolidateResult,
  weekStartDate,
  type ConsolidationCandidateView,
  type ConsolidationClaimView,
  type MemoryConsolidateDiff,
  type MemoryConsolidateModelInput,
  type MemoryConsolidateResult,
} from "./memory-consolidation";

/**
 * Slow-path consolidation pure-function coverage (issue #114): shape
 * validation of memory.consolidate diffs (model output is advisory and
 * structurally bounded) and the anchor-date helpers that drive day
 * boundaries, weekly due-ness, and the sweeper anchor deterministically.
 */

const candidate: ConsolidationCandidateView = Object.freeze({
  candidateId: "11111111-1111-7111-8111-111111111111",
  candidateKind: "objective",
  basis: "directly_stated",
  predicateId: "sh.place.residence",
  proposedConcept: null,
  typedValue: "上海",
  scopeKey: "",
  temporalStatus: "current",
  status: "proposed",
  evidence: [
    {
      evidenceItemId: "22222222-2222-7222-8222-222222222222",
      dailySessionId: "33333333-3333-7333-8333-333333333333",
      logicalDate: "2026-08-01",
    },
  ],
});

const claim: ConsolidationClaimView = Object.freeze({
  claimId: "44444444-4444-7444-8444-444444444444",
  predicateId: "sh.place.residence",
  kind: "objective",
  status: "active",
  typedValue: "上海",
  scopeKey: "",
});

const modelInput: MemoryConsolidateModelInput = Object.freeze({
  mode: "daily",
  anchorDate: "2026-08-02",
  registryVersion: 1,
  candidates: [candidate],
  claims: [claim],
});

function result(diffs: readonly MemoryConsolidateDiff[]): MemoryConsolidateResult {
  return { diffs };
}

describe("validateConsolidateResult", () => {
  it("accepts a well-formed candidate-bound diff set", () => {
    expect(() =>
      validateConsolidateResult(
        result([
          {
            kind: "propose_new",
            candidateId: candidate.candidateId,
            proposal: null,
            evidenceItemIds: [candidate.evidence[0]!.evidenceItemId],
          },
          { kind: "no_change", candidateId: candidate.candidateId },
        ]),
        modelInput,
      ),
    ).not.toThrow();
  });

  it("accepts an aggregate propose_new with a full proposal", () => {
    expect(() =>
      validateConsolidateResult(
        result([
          {
            kind: "propose_new",
            candidateId: null,
            proposal: {
              basis: "inferred",
              candidateKind: "impression",
              predicateId: "sh.communication.stated_style",
              proposedConcept: null,
              typedValue: "direct",
              scopeKey: "",
              temporal: {
                temporalStatus: "current",
                validFrom: null,
                validFromPrecision: "unknown",
                validTo: null,
                validToPrecision: "unknown",
              },
              evidenceItemIds: [candidate.evidence[0]!.evidenceItemId],
            },
            evidenceItemIds: [],
          },
        ]),
        modelInput,
      ),
    ).not.toThrow();
  });

  it("rejects non-array diffs loudly", () => {
    expect(() =>
      validateConsolidateResult({ diffs: "nope" } as unknown as MemoryConsolidateResult, modelInput),
    ).toThrow(InvalidMemoryConsolidateProposalError);
  });

  it("rejects an unknown diff kind", () => {
    expect(() =>
      validateConsolidateResult(
        result([{ kind: "delete_everything" } as unknown as MemoryConsolidateDiff]),
        modelInput,
      ),
    ).toThrow(InvalidMemoryConsolidateProposalError);
  });

  it("rejects a candidate reference outside the frozen input", () => {
    expect(() =>
      validateConsolidateResult(
        result([
          {
            kind: "reinforce_existing",
            candidateId: "99999999-9999-7999-8999-999999999999",
            evidenceItemIds: [],
          },
        ]),
        modelInput,
      ),
    ).toThrow(/outside the frozen input/);
  });

  it("rejects evidence outside the frozen input", () => {
    expect(() =>
      validateConsolidateResult(
        result([
          {
            kind: "reinforce_existing",
            candidateId: candidate.candidateId,
            evidenceItemIds: ["88888888-8888-7888-8888-888888888888"],
          },
        ]),
        modelInput,
      ),
    ).toThrow(/outside the frozen input/);
  });

  it("rejects mark_review_due against an unknown claim", () => {
    expect(() =>
      validateConsolidateResult(
        result([
          {
            kind: "mark_review_due",
            claimId: "77777777-7777-7777-8777-777777777777",
            candidateId: candidate.candidateId,
            evidenceItemIds: [],
          },
        ]),
        modelInput,
      ),
    ).toThrow(/outside the frozen input/);
  });

  it("rejects aggregate propose_new without a proposal", () => {
    expect(() =>
      validateConsolidateResult(
        result([
          { kind: "propose_new", candidateId: null, proposal: null, evidenceItemIds: [] },
        ]),
        modelInput,
      ),
    ).toThrow(/requires a full proposal/);
  });

  it("rejects a proposal with both predicate and concept set", () => {
    expect(() =>
      validateConsolidateResult(
        result([
          {
            kind: "propose_new",
            candidateId: null,
            proposal: {
              basis: "inferred",
              candidateKind: "impression",
              predicateId: "sh.value.core_priorities",
              proposedConcept: "core priorities",
              typedValue: "family",
              scopeKey: "",
              temporal: {
                temporalStatus: "current",
                validFrom: null,
                validFromPrecision: "unknown",
                validTo: null,
                validToPrecision: "unknown",
              },
              evidenceItemIds: [candidate.evidence[0]!.evidenceItemId],
            },
            evidenceItemIds: [],
          },
        ]),
        modelInput,
      ),
    ).toThrow(/exactly one/);
  });

  it("rejects an invalid basis / kind pair", () => {
    expect(() =>
      validateConsolidateResult(
        result([
          {
            kind: "propose_new",
            candidateId: null,
            proposal: {
              basis: "guessed",
              candidateKind: "impression",
              predicateId: null,
              proposedConcept: "something",
              typedValue: "x",
              scopeKey: "",
              temporal: {
                temporalStatus: "current",
                validFrom: null,
                validFromPrecision: "unknown",
                validTo: null,
                validToPrecision: "unknown",
              },
              evidenceItemIds: [candidate.evidence[0]!.evidenceItemId],
            },
            evidenceItemIds: [],
          },
        ]),
        modelInput,
      ),
    ).toThrow(/basis or kind/);
  });

  it("rejects invalid temporal bounds", () => {
    expect(() =>
      validateConsolidateResult(
        result([
          {
            kind: "propose_new",
            candidateId: null,
            proposal: {
              basis: "inferred",
              candidateKind: "impression",
              predicateId: null,
              proposedConcept: "something",
              typedValue: "x",
              scopeKey: "",
              temporal: {
                temporalStatus: "sometimes",
                validFrom: null,
                validFromPrecision: "unknown",
                validTo: null,
                validToPrecision: "unknown",
              },
              evidenceItemIds: [candidate.evidence[0]!.evidenceItemId],
            },
            evidenceItemIds: [],
          },
        ]),
        modelInput,
      ),
    ).toThrow(/temporal/);
  });
});

describe("anchor-date helpers", () => {
  it("encodes and offsets anchor dates without timezone drift", () => {
    expect(dateOrdinal("2026-08-27")).toBe(20_260_827);
    expect(addDaysToDateString("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysToDateString("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("computes the ISO week start (Monday)", () => {
    // 2026-08-27 is a Thursday; its Monday is 2026-08-24.
    expect(weekStartDate("2026-08-27")).toBe("2026-08-24");
    // A Sunday belongs to the previous Monday.
    expect(weekStartDate("2026-08-30")).toBe("2026-08-24");
    // A Monday is its own week start.
    expect(weekStartDate("2026-08-24")).toBe("2026-08-24");
  });

  it("scopes evidence cutoffs: daily = anchor, weekly = full ISO week", () => {
    expect(evidenceCutoff("daily", "2026-08-27")).toBe("2026-08-27");
    expect(evidenceCutoff("weekly", "2026-08-24")).toBe("2026-08-30");
    expect(evidenceCutoff("sweeper", "2026-08-27")).toBe("2026-08-27");
  });

});
