import { describe, expect, it } from "vitest";

import {
  hasExplicitEntityIdentityCorrection,
  planEntityIdentityCorrection,
  type EntityIdentityCorrectionTarget,
} from "./entity-identity-correction";

const baseTarget: EntityIdentityCorrectionTarget = {
  operation: "merge",
  sourceEntityId: "entity-source",
  sourceEntityVersionId: "entity-source-v2",
  sourceEntityVersionStatus: "active",
  targetEntityId: "entity-target",
  targetEntityVersionId: "entity-target-v3",
  targetEntityVersionStatus: "active",
  newEntityLabel: null,
  promotionEvidence: null,
  expectedDataEpoch: 1,
  explicitUserCorrection: true,
};

describe("planEntityIdentityCorrection (issue #121)", () => {
  it("plans a merge only between two distinct ordinary Entities", () => {
    expect(planEntityIdentityCorrection(baseTarget)).toEqual({
      action: "merge",
      sourceEntityId: "entity-source",
      sourceEntityVersionId: "entity-source-v2",
      targetEntityId: "entity-target",
      targetEntityVersionId: "entity-target-v3",
    });
  });

  it("rejects a Self Entity from every identity surgery operation", () => {
    expect(
      planEntityIdentityCorrection({
        ...baseTarget,
        sourceIsSelf: true,
      }),
    ).toEqual({
      action: "rejected",
      reasonCode: "self_entity_protected",
    });
  });

  it("requires an explicit statement or two independent dates for promotion", () => {
    expect(
      planEntityIdentityCorrection({
        ...baseTarget,
        operation: "promote",
        targetEntityId: null,
        targetEntityVersionId: null,
        targetEntityVersionStatus: null,
        sourceEntityVersionStatus: "unresolved",
        promotionEvidence: {
          explicitStatement: false,
          independentRevisionCount: 1,
        },
      }),
    ).toEqual({
      action: "rejected",
      reasonCode: "promotion_evidence_insufficient",
    });

    expect(
      planEntityIdentityCorrection({
        ...baseTarget,
        operation: "promote",
        targetEntityId: null,
        targetEntityVersionId: null,
        targetEntityVersionStatus: null,
        sourceEntityVersionStatus: "unresolved",
        promotionEvidence: {
          explicitStatement: false,
          independentRevisionCount: 2,
        },
        explicitUserCorrection: false,
      }),
    ).toEqual({
      action: "promote",
      sourceEntityId: "entity-source",
      sourceEntityVersionId: "entity-source-v2",
    });
  });

  it("requires explicit operation language for merge and split", () => {
    expect(
      hasExplicitEntityIdentityCorrection(
        "Actually, Alex joined the meeting today.",
        "merge",
      ),
    ).toBe(false);
    expect(
      hasExplicitEntityIdentityCorrection(
        "Alex and Alexis are the same person.",
        "merge",
      ),
    ).toBe(true);
    expect(
      hasExplicitEntityIdentityCorrection(
        "Alex and Jamie are different people.",
        "split",
      ),
    ).toBe(true);
  });

  it("does not treat unrelated merge or split language as identity correction", () => {
    expect(
      hasExplicitEntityIdentityCorrection(
        "The two projects merge next quarter.",
        "merge",
      ),
    ).toBe(false);
    expect(
      hasExplicitEntityIdentityCorrection(
        "I need to split the bill with Jamie.",
        "split",
      ),
    ).toBe(false);
  });

  it("requires a new bounded label for split", () => {
    expect(
      planEntityIdentityCorrection({
        ...baseTarget,
        operation: "split",
        targetEntityId: null,
        targetEntityVersionId: null,
        targetEntityVersionStatus: null,
        newEntityLabel: "   ",
      }),
    ).toEqual({
      action: "rejected",
      reasonCode: "split_new_label_required",
    });
  });

  it("does not silently treat a repeated correction as a no-op", () => {
    expect(
      planEntityIdentityCorrection({
        ...baseTarget,
        sourceEntityVersionStatus: "merged",
      }),
    ).toEqual({
      action: "rejected",
      reasonCode: "source_entity_not_correctable",
    });
  });
});
