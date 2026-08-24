import { describe, expect, it } from "vitest";

import {
  detectMinimumHighRiskSignal,
} from "./conversation-behavior";
import { isWhitelistedSafetyResourceNumber } from "./safety-resources";

import {
  applySafetyPostureTurn,
  minimumHighRiskSafetyPostureDetector,
  nextSafetyPostureStatus,
  renderSafetyPosture,
  renderSafetyPostureResponseAnchor,
  SAFETY_POSTURE_ACTIVE_MARKER,
  SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE,
  SAFETY_POSTURE_POLICY_VERSION,
  validateSafetyPostureContent,
  type SafetyPostureContent,
} from "./safety-posture";
import { asConversationEventRevisionId } from "@sayhear/domain";

const USER_REVISION_A = asConversationEventRevisionId(
  "018f16a0-0000-7000-8000-00000000000a",
);
const USER_REVISION_B = asConversationEventRevisionId(
  "018f16a0-0000-7000-8000-00000000000b",
);
const USER_REVISION_C = asConversationEventRevisionId(
  "018f16a0-0000-7000-8000-00000000000c",
);
const USER_REVISION_D = asConversationEventRevisionId(
  "018f16a0-0000-7000-8000-00000000000d",
);

describe("safety posture policy constants", () => {
  it("pins the versioned lifecycle identity and the K parameter", () => {
    expect(SAFETY_POSTURE_POLICY_VERSION).toBe("safety-posture:v2");
    expect(SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE).toBe(2);
  });

  it("anchors the default detector on the versioned minimum-high-risk detection", () => {
    expect(
      minimumHighRiskSafetyPostureDetector({
        locale: "en-US",
        text: "I want to kill myself tonight.",
      }),
    ).toBe("self_harm");
    expect(
      minimumHighRiskSafetyPostureDetector({
        locale: "en-US",
        text: "Work has been crushing me this month.",
      }),
    ).toBeNull();
    expect(
      detectMinimumHighRiskSignal({
        locale: "en-US",
        text: "I want to kill myself tonight.",
      }).policyVersion,
    ).toBe("minimum-high-risk-response:v1");
  });
});

describe("nextSafetyPostureStatus", () => {
  it("stays default on a clean turn with no posture", () => {
    expect(
      nextSafetyPostureStatus({
        detected: null,
        status: { cleanTurnCount: 0, state: "default" },
      }),
    ).toEqual({ cleanTurnCount: 0, state: "default" });
  });

  it("activates on a detected signal and resets the count on renewal", () => {
    expect(
      nextSafetyPostureStatus({
        detected: "self_harm",
        status: { cleanTurnCount: 0, state: "default" },
      }),
    ).toEqual({ cleanTurnCount: 0, state: "active" });
    expect(
      nextSafetyPostureStatus({
        detected: "imminent_danger",
        status: { cleanTurnCount: 1, state: "active" },
      }),
    ).toEqual({ cleanTurnCount: 0, state: "active" });
    expect(
      nextSafetyPostureStatus({
        detected: "harm_to_others",
        status: { cleanTurnCount: 2, state: "released" },
      }),
    ).toEqual({ cleanTurnCount: 0, state: "active" });
  });

  it("counts clean turns and releases exactly at K", () => {
    const afterActivation = nextSafetyPostureStatus({
      detected: "self_harm",
      status: { cleanTurnCount: 0, state: "default" },
    });
    const firstClean = nextSafetyPostureStatus({
      detected: null,
      status: afterActivation,
    });
    expect(firstClean).toEqual({ cleanTurnCount: 1, state: "active" });
    const secondClean = nextSafetyPostureStatus({
      detected: null,
      status: firstClean,
    });
    expect(secondClean).toEqual({
      cleanTurnCount: 2,
      state: "released",
    });
    expect(
      nextSafetyPostureStatus({ detected: null, status: secondClean }),
    ).toEqual(secondClean);
  });

  it("treats the K threshold as an input, not a scattered literal", () => {
    const status = nextSafetyPostureStatus({
      cleanTurnsToRelease: 3,
      detected: "self_harm",
      status: { cleanTurnCount: 0, state: "default" },
    });
    expect(
      nextSafetyPostureStatus({
        cleanTurnsToRelease: 3,
        detected: null,
        status,
      }).state,
    ).toBe("active");
    expect(
      nextSafetyPostureStatus({
        cleanTurnsToRelease: 3,
        detected: null,
        status: { cleanTurnCount: 1, state: "active" },
      }).state,
    ).toBe("active");
    expect(
      nextSafetyPostureStatus({
        cleanTurnsToRelease: 3,
        detected: null,
        status: { cleanTurnCount: 3, state: "active" },
      }).state,
    ).toBe("released");
  });
});

describe("applySafetyPostureTurn", () => {
  it("attaches revision-reference evidence on activation", () => {
    const applied = applySafetyPostureTurn({
      content: null,
      currentUserEventRevisionId: USER_REVISION_A,
      detected: "self_harm",
    });
    expect(applied).toEqual({
      cleanTurnCount: 0,
      evidence: {
        activatedUserEventRevisionId: USER_REVISION_A,
        lastTurnUserEventRevisionId: USER_REVISION_A,
      },
      kind: "self_harm",
      releasedBy: null,
      state: "active",
    });
  });

  it("counts a clean turn, carrying only revision evidence forward", () => {
    const activated = applySafetyPostureTurn({
      content: null,
      currentUserEventRevisionId: USER_REVISION_A,
      detected: "self_harm",
    })!;
    const firstClean = applySafetyPostureTurn({
      content: activated,
      currentUserEventRevisionId: USER_REVISION_B,
      detected: null,
    })!;
    expect(firstClean.state).toBe("active");
    expect(firstClean.cleanTurnCount).toBe(1);
    expect(firstClean.evidence.activatedUserEventRevisionId).toBe(
      USER_REVISION_A,
    );
    expect(firstClean.evidence.lastTurnUserEventRevisionId).toBe(
      USER_REVISION_B,
    );
  });

  it("releases on the second consecutive clean turn with release evidence", () => {
    const activated = applySafetyPostureTurn({
      content: null,
      currentUserEventRevisionId: USER_REVISION_A,
      detected: "self_harm",
    })!;
    const firstClean = applySafetyPostureTurn({
      content: activated,
      currentUserEventRevisionId: USER_REVISION_B,
      detected: null,
    })!;
    const released = applySafetyPostureTurn({
      content: firstClean,
      currentUserEventRevisionId: USER_REVISION_C,
      detected: null,
    })!;
    expect(released.state).toBe("released");
    expect(released.releasedBy).toEqual({
      userEventRevisionId: USER_REVISION_C,
    });
  });

  it("resets the count when a renewed signal arrives mid-posture", () => {
    const activated = applySafetyPostureTurn({
      content: null,
      currentUserEventRevisionId: USER_REVISION_A,
      detected: "self_harm",
    })!;
    const firstClean = applySafetyPostureTurn({
      content: activated,
      currentUserEventRevisionId: USER_REVISION_B,
      detected: null,
    })!;
    const renewed = applySafetyPostureTurn({
      content: firstClean,
      currentUserEventRevisionId: USER_REVISION_C,
      detected: "harm_to_others",
    })!;
    expect(renewed.state).toBe("active");
    expect(renewed.cleanTurnCount).toBe(0);
    expect(renewed.kind).toBe("harm_to_others");
    expect(renewed.evidence.activatedUserEventRevisionId).toBe(USER_REVISION_C);
  });

  it("returns null when the turn changes nothing worth persisting", () => {
    expect(
      applySafetyPostureTurn({
        content: null,
        currentUserEventRevisionId: USER_REVISION_A,
        detected: null,
      }),
    ).toBeNull();
    const released = applySafetyPostureTurn({
      content: applySafetyPostureTurn({
        content: applySafetyPostureTurn({
          content: applySafetyPostureTurn({
            content: null,
            currentUserEventRevisionId: USER_REVISION_A,
            detected: "self_harm",
          }),
          currentUserEventRevisionId: USER_REVISION_B,
          detected: null,
        }),
        currentUserEventRevisionId: USER_REVISION_C,
        detected: null,
      }),
      currentUserEventRevisionId: USER_REVISION_D,
      detected: null,
    });
    expect(released).toBeNull();
  });

  it("counts an explicit statement of safety as exactly one clean turn", () => {
    // The statement carries no high-risk signal, so it is an ordinary clean
    // turn — it must not short-circuit the release (ADR-0112).
    const safetyStatement = "I am safe now, I really am.";
    expect(
      minimumHighRiskSafetyPostureDetector({
        locale: "en-US",
        text: safetyStatement,
      }),
    ).toBeNull();
    const activated = applySafetyPostureTurn({
      content: null,
      currentUserEventRevisionId: USER_REVISION_A,
      detected: "self_harm",
    })!;
    const afterStatement = applySafetyPostureTurn({
      content: activated,
      currentUserEventRevisionId: USER_REVISION_B,
      detected: minimumHighRiskSafetyPostureDetector({
        locale: "en-US",
        text: safetyStatement,
      }),
    })!;
    expect(afterStatement.state).toBe("active");
    expect(afterStatement.cleanTurnCount).toBe(1);
  });
});

describe("validateSafetyPostureContent", () => {
  const validActive: SafetyPostureContent = {
    cleanTurnCount: 1,
    evidence: {
      activatedUserEventRevisionId: USER_REVISION_A,
      lastTurnUserEventRevisionId: USER_REVISION_B,
    },
    kind: "self_harm",
    releasedBy: null,
    state: "active",
  };

  it("accepts the canonical shapes", () => {
    expect(() => validateSafetyPostureContent(validActive)).not.toThrow();
    expect(() =>
      validateSafetyPostureContent({
        ...validActive,
        cleanTurnCount: 2,
        releasedBy: { userEventRevisionId: USER_REVISION_C },
        state: "released",
      }),
    ).not.toThrow();
  });

  it("rejects unknown states, kinds, and counts", () => {
    expect(() =>
      validateSafetyPostureContent({
        ...validActive,
        state: "default" as SafetyPostureContent["state"],
      }),
    ).toThrow();
    expect(() =>
      validateSafetyPostureContent({
        ...validActive,
        kind: "explosion" as SafetyPostureContent["kind"],
      }),
    ).toThrow();
    expect(() =>
      validateSafetyPostureContent({ ...validActive, cleanTurnCount: -1 }),
    ).toThrow();
    expect(() =>
      validateSafetyPostureContent({
        ...validActive,
        cleanTurnCount: 1.5,
      }),
    ).toThrow();
    expect(() =>
      validateSafetyPostureContent({
        ...validActive,
        cleanTurnCount: 1_001,
      }),
    ).toThrow();
  });

  it("rejects inconsistent release markers and missing evidence", () => {
    expect(() =>
      validateSafetyPostureContent({
        ...validActive,
        releasedBy: { userEventRevisionId: USER_REVISION_C },
      }),
    ).toThrow();
    expect(() =>
      validateSafetyPostureContent({
        ...validActive,
        cleanTurnCount: 2,
        state: "released",
      }),
    ).toThrow();
    expect(() =>
      validateSafetyPostureContent({
        ...validActive,
        evidence: {
          activatedUserEventRevisionId: USER_REVISION_A,
          lastTurnUserEventRevisionId: null as unknown as SafetyPostureContent["evidence"]["lastTurnUserEventRevisionId"],
        },
      }),
    ).toThrow();
  });
});

describe("safety posture rendering", () => {
  const activated = applySafetyPostureTurn({
    content: null,
    currentUserEventRevisionId: USER_REVISION_A,
    detected: "self_harm",
  })!;

  it("renders the active posture with the marker, policy version, and the whitelisted anchor", () => {
    const rendered = renderSafetyPosture({
      content: activated,
      locale: "en-US",
      policyVersion: SAFETY_POSTURE_POLICY_VERSION,
    });
    expect(rendered).toContain(SAFETY_POSTURE_ACTIVE_MARKER);
    expect(rendered).toContain(SAFETY_POSTURE_POLICY_VERSION);
    expect(rendered).toContain("988");
    expect(rendered).toContain("Playful Warmth");
    expect(rendered).toContain("directness");
  });

  it("renders the zh anchor from the same whitelist", () => {
    const rendered = renderSafetyPosture({
      content: activated,
      locale: "zh-Hans-CN",
      policyVersion: SAFETY_POSTURE_POLICY_VERSION,
    });
    expect(rendered).toContain(SAFETY_POSTURE_ACTIVE_MARKER);
    expect(rendered).toContain("12356");
    expect(rendered).toContain("400-161-9995");
  });

  it("renders a response anchor whose every number-like run is whitelisted", () => {
    for (const locale of ["en-US", "zh-Hans-CN"]) {
      const anchor = renderSafetyPostureResponseAnchor({ locale });
      expect(anchor.length).toBeGreaterThan(0);
      expect(anchor).not.toMatch(/[?？]/);
      const runs = anchor.match(/\d(?:[ -]?\d){2,}/g) ?? [];
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(
          isWhitelistedSafetyResourceNumber(run.replace(/[^0-9]/g, "")),
        ).toBe(true);
      }
    }
  });
});
