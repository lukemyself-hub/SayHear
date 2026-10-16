import { describe, expect, it } from "vitest";

import {
  parseBehaviorScopeReview,
  resolveBehaviorScope,
  type ScopeChangedFile,
} from "../scripts/pr-approval/behavior-scope.ts";
import type {
  ProviderReviewContext,
} from "../scripts/provider-behavior-review.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const DIGEST = "c".repeat(64);
const OTHER_HEAD = "d".repeat(40);
const OTHER_BASE = "e".repeat(40);
const OTHER_DIGEST = "f".repeat(64);

function validContext(overrides: Partial<ProviderReviewContext> = {}): ProviderReviewContext {
  return {
    headSha: HEAD,
    baseSha: BASE,
    diffDigest: DIGEST,
    diffComplete: true,
    ...overrides,
  };
}

function validObservation(overrides: Record<string, unknown> = {}) {
  return {
    file: "src/policy.ts",
    line: 12,
    before: "old snippet",
    after: "new snippet",
    ...overrides,
  };
}

// Typed assessment represents independently reviewed semantics (Codex verified
// before submit); the module never classifies snippet text by regex.
function validReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    headSha: HEAD,
    baseSha: BASE,
    diffDigest: DIGEST,
    verdict: "in-scope",
    runtimeImpact: "none",
    rationale: "Existing contract repair keeps user-visible behavior unchanged.",
    evidence: [validObservation()],
    contractRefs: ["docs/contracts/policy.md"],
    missingEvidence: [],
    ...overrides,
  };
}

function validChangedFiles(): ScopeChangedFile[] {
  return [{ path: "src/policy.ts", status: "modified" }];
}

describe("parseBehaviorScopeReview accepts independently reviewed semantics", () => {
  it("accepts a permission repair typed as in-scope by the reviewer without classifying snippet text", () => {
    const review = parseBehaviorScopeReview(
      validReview({
        rationale: "Repair restores the existing permission contract; reviewer confirms no behavior change.",
        evidence: [validObservation({ before: "allow: false", after: "allow: false // restored" })],
        contractRefs: ["docs/contracts/permissions.md"],
      }),
    );
    expect(review.verdict).toBe("in-scope");
    expect(review.runtimeImpact).toBe("none");
    expect(review.evidence).toHaveLength(1);
  });

  it("accepts a permission expansion typed as needs-human by the reviewer even with the same snippet shape (no snippet regex)", () => {
    const review = parseBehaviorScopeReview(
      validReview({
        verdict: "needs-human",
        runtimeImpact: "changed",
        rationale: "Reviewer finds a policy expansion beyond the existing contract; human judgment required.",
        evidence: [validObservation({ before: "allow: false", after: "allow: true // expanded" })],
        contractRefs: ["docs/contracts/permissions.md"],
      }),
    );
    expect(review.verdict).toBe("needs-human");
    expect(review.runtimeImpact).toBe("changed");
  });

  it("accepts unknown scope (insufficient-info) with concrete missing evidence and partial observations", () => {
    const review = parseBehaviorScopeReview(
      validReview({
        verdict: "insufficient-info",
        runtimeImpact: "unknown",
        rationale: "Diff is truncated; reviewer cannot confirm behavior.",
        evidence: [],
        contractRefs: [],
        missingEvidence: ["complete-diff-text"],
      }),
    );
    expect(review.verdict).toBe("insufficient-info");
    expect(review.missingEvidence).toEqual(["complete-diff-text"]);
  });

  it("normalizes uppercase SHA40 and digest64 hex to lowercase", () => {
    const review = parseBehaviorScopeReview(
      validReview({
        headSha: HEAD.toUpperCase(),
        baseSha: BASE.toUpperCase(),
        diffDigest: DIGEST.toUpperCase(),
      }),
    );
    expect(review.headSha).toBe(HEAD);
    expect(review.baseSha).toBe(BASE);
    expect(review.diffDigest).toBe(DIGEST);
  });

  it("allows real multiline rationale text with newline, carriage return and tab", () => {
    const review = parseBehaviorScopeReview(
      validReview({ rationale: "Line one.\nLine two.\r\nLine three with\ttab." }),
    );
    expect(review.rationale).toContain("Line two.");
  });

  it("allows contract references pointing outside changed files because contracts are often unchanged", () => {
    const review = parseBehaviorScopeReview(
      validReview({ contractRefs: ["docs/contracts/stable-policy.md"] }),
    );
    expect(review.contractRefs).toEqual(["docs/contracts/stable-policy.md"]);
  });

  it("accepts insufficient-info with partial observations and contracts plus runtime unknown", () => {
    const review = parseBehaviorScopeReview(
      validReview({
        verdict: "insufficient-info",
        runtimeImpact: "unknown",
        evidence: [validObservation()],
        contractRefs: ["docs/contracts/policy.md"],
        missingEvidence: ["remaining-hunks"],
      }),
    );
    expect(review.evidence).toHaveLength(1);
    expect(review.contractRefs).toHaveLength(1);
  });
});

describe("parseBehaviorScopeReview rejects malformed boundary input", () => {
  it("rejects an invalid verdict enum value", () => {
    expect(() => parseBehaviorScopeReview(validReview({ verdict: "out-of-scope" }))).toThrow();
  });

  it("rejects an invalid runtimeImpact enum value", () => {
    expect(() => parseBehaviorScopeReview(validReview({ runtimeImpact: "maybe" }))).toThrow();
  });

  it("rejects invalid SHA40 and digest64 identities", () => {
    expect(() => parseBehaviorScopeReview(validReview({ headSha: "short" }))).toThrow();
    expect(() => parseBehaviorScopeReview(validReview({ baseSha: "z".repeat(40) }))).toThrow();
    expect(() => parseBehaviorScopeReview(validReview({ diffDigest: "short" }))).toThrow();
    expect(() => parseBehaviorScopeReview(validReview({ diffDigest: "z".repeat(64) }))).toThrow();
  });

  it("rejects whitespace-only and overlong rationale", () => {
    expect(() => parseBehaviorScopeReview(validReview({ rationale: "   \n\t  " }))).toThrow();
    expect(() => parseBehaviorScopeReview(validReview({ rationale: "" }))).toThrow();
    expect(() => parseBehaviorScopeReview(validReview({ rationale: "x".repeat(2001) }))).toThrow();
  });

  it("rejects nontext controls in rationale but keeps real multiline text", () => {
    expect(() => parseBehaviorScopeReview(validReview({ rationale: "ok\u0000bad" }))).toThrow();
    expect(() => parseBehaviorScopeReview(validReview({ rationale: "ok\u001Fbad" }))).toThrow();
    expect(() => parseBehaviorScopeReview(validReview({ rationale: "ok\u007Fbad" }))).toThrow();
  });

  it("rejects in-scope with runtime unknown because resolved scope needs a known runtime", () => {
    expect(() =>
      parseBehaviorScopeReview(validReview({ verdict: "in-scope", runtimeImpact: "unknown" })),
    ).toThrow();
  });

  it("rejects resolved scopes without evidence or contracts and with missing evidence present", () => {
    expect(() => parseBehaviorScopeReview(validReview({ evidence: [] }))).toThrow();
    expect(() => parseBehaviorScopeReview(validReview({ contractRefs: [] }))).toThrow();
    expect(() =>
      parseBehaviorScopeReview(validReview({ missingEvidence: ["extra"] })),
    ).toThrow();
    expect(() =>
      parseBehaviorScopeReview(
        validReview({ verdict: "needs-human", runtimeImpact: "changed", evidence: [] }),
      ),
    ).toThrow();
    expect(() =>
      parseBehaviorScopeReview(
        validReview({ verdict: "needs-human", runtimeImpact: "changed", contractRefs: [] }),
      ),
    ).toThrow();
    expect(() =>
      parseBehaviorScopeReview(
        validReview({
          verdict: "needs-human",
          runtimeImpact: "changed",
          missingEvidence: ["unexpected"],
        }),
      ),
    ).toThrow();
  });

  it("rejects insufficient-info without concrete missing evidence", () => {
    expect(() =>
      parseBehaviorScopeReview(
        validReview({ verdict: "insufficient-info", runtimeImpact: "unknown", missingEvidence: [] }),
      ),
    ).toThrow();
  });

  it("rejects too many evidence, contractRefs and missingEvidence entries and overlong entries", () => {
    const manyEvidence = Array.from({ length: 65 }, () => validObservation());
    expect(() => parseBehaviorScopeReview(validReview({ evidence: manyEvidence }))).toThrow();
    const manyContracts = Array.from({ length: 33 }, (_, i) => `contract-${i}.md`);
    expect(() => parseBehaviorScopeReview(validReview({ contractRefs: manyContracts }))).toThrow();
    const manyMissing = Array.from({ length: 33 }, (_, i) => `missing-${i}`);
    expect(() =>
      parseBehaviorScopeReview(
        validReview({
          verdict: "insufficient-info",
          runtimeImpact: "unknown",
          evidence: [],
          contractRefs: [],
          missingEvidence: manyMissing,
        }),
      ),
    ).toThrow();
    expect(() => parseBehaviorScopeReview(validReview({ contractRefs: ["   "] }))).toThrow();
    expect(() => parseBehaviorScopeReview(validReview({ contractRefs: ["x".repeat(513)] }))).toThrow();
    expect(() => parseBehaviorScopeReview(validReview({ contractRefs: ["line\nbreak"] }))).toThrow();
  });

  it("rejects Unicode line and paragraph separators in single-line contractRefs and missingEvidence", () => {
    const separators = [String.fromCodePoint(0x2028), String.fromCodePoint(0x2029)];
    for (const separator of separators) {
      expect(() =>
        parseBehaviorScopeReview(validReview({ contractRefs: [`ref${separator}split`] })),
      ).toThrow();
      expect(() =>
        parseBehaviorScopeReview(
          validReview({
            verdict: "insufficient-info",
            runtimeImpact: "unknown",
            evidence: [],
            contractRefs: [],
            missingEvidence: [`missing${separator}piece`],
          }),
        ),
      ).toThrow();
    }
    // Multiline rationale keeps accepting real line breaks, including separators.
    const rationale = parseBehaviorScopeReview(
      validReview({ rationale: `Line one.${String.fromCodePoint(0x2028)}Line two.` }),
    );
    expect(rationale.rationale).toContain("Line two.");
  });

  it("rejects observation files that are absolute, traversal, control, blank or overlong", () => {
    for (const file of ["/abs/path.ts", "../escape.ts", "a/../b.ts", "bad\u0000.ts", "   ", "", "x".repeat(513)]) {
      expect(() => parseBehaviorScopeReview(validReview({ evidence: [validObservation({ file })] }))).toThrow();
    }
  });

  it("rejects observations with non-positive lines and with both sides blank", () => {
    expect(() =>
      parseBehaviorScopeReview(validReview({ evidence: [validObservation({ line: 0 })] })),
    ).toThrow();
    expect(() =>
      parseBehaviorScopeReview(validReview({ evidence: [validObservation({ line: -3 })] })),
    ).toThrow();
    expect(() =>
      parseBehaviorScopeReview(validReview({ evidence: [validObservation({ line: 1.5 })] })),
    ).toThrow();
    expect(() =>
      parseBehaviorScopeReview(validReview({ evidence: [validObservation({ before: null, after: null })] })),
    ).toThrow();
    expect(() =>
      parseBehaviorScopeReview(validReview({ evidence: [validObservation({ before: "", after: "  " })] })),
    ).toThrow();
    expect(() =>
      parseBehaviorScopeReview(
        validReview({ evidence: [validObservation({ before: "x".repeat(2001), after: "ok" })] }),
      ),
    ).toThrow();
  });
});

describe("resolveBehaviorScope binds the typed assessment to the live context without inferring Provider verdicts", () => {
  it("returns insufficient-info with named missing evidence when context is missing (no Provider inference)", () => {
    const review = parseBehaviorScopeReview(validReview());
    const resolution = resolveBehaviorScope(review, undefined, validChangedFiles());
    expect(resolution.verdict).toBe("insufficient-info");
    expect(resolution.noRuntimeImpact).toBe(false);
    expect(resolution.coveredPaths).toEqual([]);
    expect(resolution.missingEvidence.length).toBeGreaterThan(0);
  });

  it("returns insufficient-info with named missing evidence when assessment is missing", () => {
    const resolution = resolveBehaviorScope(undefined, validContext(), validChangedFiles());
    expect(resolution.verdict).toBe("insufficient-info");
    expect(resolution.noRuntimeImpact).toBe(false);
    expect(resolution.coveredPaths).toEqual([]);
    expect(resolution.missingEvidence.length).toBeGreaterThan(0);
  });

  it("returns insufficient-info when the diff is incomplete", () => {
    const review = parseBehaviorScopeReview(validReview());
    const resolution = resolveBehaviorScope(
      review,
      validContext({ diffComplete: false }),
      validChangedFiles(),
    );
    expect(resolution.verdict).toBe("insufficient-info");
    expect(resolution.noRuntimeImpact).toBe(false);
    expect(resolution.coveredPaths).toEqual([]);
    expect(resolution.missingEvidence).toContain("complete-diff");
  });

  it.each([
    ["head", { headSha: OTHER_HEAD }, "matching-head-sha"],
    ["base", { baseSha: OTHER_BASE }, "matching-base-sha"],
    ["digest", { diffDigest: OTHER_DIGEST }, "matching-diff-digest"],
  ])(
    "returns insufficient-info with stale %s binding and no coverage authorization",
    (_label, contextOverride, expectedMissing) => {
      const review = parseBehaviorScopeReview(validReview());
      const resolution = resolveBehaviorScope(
        review,
        validContext(contextOverride),
        validChangedFiles(),
      );
      expect(resolution.verdict).toBe("insufficient-info");
      expect(resolution.noRuntimeImpact).toBe(false);
      expect(resolution.coveredPaths).toEqual([]);
      expect(resolution.missingEvidence).toContain(expectedMissing);
    },
  );

  it("preserves a needs-human expansion assessment as needs-human without granting no-runtime", () => {
    const review = parseBehaviorScopeReview(
      validReview({
        verdict: "needs-human",
        runtimeImpact: "changed",
        rationale: "Reviewer confirms a permission expansion needs a human.",
      }),
    );
    const resolution = resolveBehaviorScope(review, validContext(), validChangedFiles());
    expect(resolution.verdict).toBe("needs-human");
    expect(resolution.noRuntimeImpact).toBe(false);
    expect(resolution.missingEvidence).toEqual([]);
  });

  it("preserves an insufficient-info assessment with its concrete missing evidence", () => {
    const review = parseBehaviorScopeReview(
      validReview({
        verdict: "insufficient-info",
        runtimeImpact: "unknown",
        evidence: [],
        contractRefs: [],
        missingEvidence: ["remaining-hunks"],
      }),
    );
    const resolution = resolveBehaviorScope(review, validContext(), validChangedFiles());
    expect(resolution.verdict).toBe("insufficient-info");
    expect(resolution.noRuntimeImpact).toBe(false);
    expect(resolution.coveredPaths).toEqual([]);
    expect(resolution.missingEvidence).toEqual(["remaining-hunks"]);
  });

  it("grants no-runtime only for fresh in-scope with runtime none and full modified coverage", () => {
    const review = parseBehaviorScopeReview(validReview());
    const resolution = resolveBehaviorScope(review, validContext(), validChangedFiles());
    expect(resolution.verdict).toBe("in-scope");
    expect(resolution.coveredPaths).toEqual(["src/policy.ts"]);
    expect(resolution.noRuntimeImpact).toBe(true);
    expect(resolution.missingEvidence).toEqual([]);
  });

  it("keeps in-scope verdict but withholds no-runtime on partial coverage so callers still require every protected path", () => {
    const review = parseBehaviorScopeReview(validReview());
    const changed: ScopeChangedFile[] = [
      { path: "src/policy.ts", status: "modified" },
      { path: "src/other.ts", status: "modified" },
    ];
    const resolution = resolveBehaviorScope(review, validContext(), changed);
    expect(resolution.verdict).toBe("in-scope");
    expect(resolution.coveredPaths).toEqual(["src/policy.ts"]);
    expect(resolution.noRuntimeImpact).toBe(false);
  });

  it("withholds no-runtime when runtimeImpact is changed even with full coverage", () => {
    const changedRuntime = parseBehaviorScopeReview(validReview({ runtimeImpact: "changed" }));
    expect(changedRuntime.runtimeImpact).toBe("changed");
    const resolution = resolveBehaviorScope(changedRuntime, validContext(), validChangedFiles());
    expect(resolution.verdict).toBe("in-scope");
    // Coverage proof is still derived from evidence; only the no-runtime grant is withheld.
    expect(resolution.coveredPaths).toEqual(["src/policy.ts"]);
    expect(resolution.noRuntimeImpact).toBe(false);
  });

  it("never infers no-runtime from a Provider unaffected verdict (module takes no Provider input)", () => {
    const review = parseBehaviorScopeReview(validReview());
    const resolution = resolveBehaviorScope(review, validContext(), []);
    expect(resolution.noRuntimeImpact).toBe(false);
    expect(resolution.coveredPaths).toEqual([]);
    // An empty changed set cannot grant no-runtime even for fresh in-scope none.
    expect(resolution.verdict).toBe("in-scope");
  });

  it("covers an added file only with an after snippet", () => {
    const beforeOnly = parseBehaviorScopeReview(
      validReview({ evidence: [validObservation({ file: "src/new.ts", before: "old", after: null })] }),
    );
    const added: ScopeChangedFile[] = [{ path: "src/new.ts", status: "added" }];
    expect(resolveBehaviorScope(beforeOnly, validContext(), added).coveredPaths).toEqual([]);
    expect(resolveBehaviorScope(beforeOnly, validContext(), added).noRuntimeImpact).toBe(false);

    const afterOnly = parseBehaviorScopeReview(
      validReview({ evidence: [validObservation({ file: "src/new.ts", before: null, after: "created" })] }),
    );
    const covered = resolveBehaviorScope(afterOnly, validContext(), added);
    expect(covered.coveredPaths).toEqual(["src/new.ts"]);
    expect(covered.noRuntimeImpact).toBe(true);
  });

  it("covers a removed file only with a before snippet", () => {
    const afterOnly = parseBehaviorScopeReview(
      validReview({ evidence: [validObservation({ file: "src/gone.ts", before: null, after: "leftover" })] }),
    );
    const removed: ScopeChangedFile[] = [{ path: "src/gone.ts", status: "removed" }];
    expect(resolveBehaviorScope(afterOnly, validContext(), removed).coveredPaths).toEqual([]);

    const beforeOnly = parseBehaviorScopeReview(
      validReview({ evidence: [validObservation({ file: "src/gone.ts", before: "deleted", after: null })] }),
    );
    const covered = resolveBehaviorScope(beforeOnly, validContext(), removed);
    expect(covered.coveredPaths).toEqual(["src/gone.ts"]);
    expect(covered.noRuntimeImpact).toBe(true);
  });

  it("covers renamed and copied files only with both sides or equivalent entries", () => {
    const renamed: ScopeChangedFile[] = [{ path: "src/renamed.ts", status: "renamed" }];
    const beforeOnly = parseBehaviorScopeReview(
      validReview({ evidence: [validObservation({ file: "src/renamed.ts", before: "old", after: null })] }),
    );
    expect(resolveBehaviorScope(beforeOnly, validContext(), renamed).coveredPaths).toEqual([]);
    const afterOnly = parseBehaviorScopeReview(
      validReview({ evidence: [validObservation({ file: "src/renamed.ts", before: null, after: "new" })] }),
    );
    expect(resolveBehaviorScope(afterOnly, validContext(), renamed).coveredPaths).toEqual([]);

    const bothSides = parseBehaviorScopeReview(
      validReview({ evidence: [validObservation({ file: "src/renamed.ts", before: "old", after: "new" })] }),
    );
    expect(resolveBehaviorScope(bothSides, validContext(), renamed).coveredPaths).toEqual([
      "src/renamed.ts",
    ]);

    const equivalentEntries = parseBehaviorScopeReview(
      validReview({
        evidence: [
          validObservation({ file: "src/renamed.ts", before: "old", after: null }),
          validObservation({ file: "src/renamed.ts", line: 13, before: null, after: "new" }),
        ],
      }),
    );
    expect(resolveBehaviorScope(equivalentEntries, validContext(), renamed).coveredPaths).toEqual([
      "src/renamed.ts",
    ]);

    const copied: ScopeChangedFile[] = [{ path: "src/copied.ts", status: "copied" }];
    expect(resolveBehaviorScope(bothSides, validContext(), copied).coveredPaths).toEqual([]);
    const copiedBoth = parseBehaviorScopeReview(
      validReview({ evidence: [validObservation({ file: "src/copied.ts", before: "old", after: "new" })] }),
    );
    expect(resolveBehaviorScope(copiedBoth, validContext(), copied).coveredPaths).toEqual([
      "src/copied.ts",
    ]);
  });

  it("treats external observation paths as citable but not covering an unrelated changed file", () => {
    const review = parseBehaviorScopeReview(
      validReview({
        evidence: [validObservation({ file: "docs/notes.md", before: "note", after: "note update" })],
        contractRefs: ["docs/contracts/external.md"],
      }),
    );
    const resolution = resolveBehaviorScope(review, validContext(), validChangedFiles());
    expect(resolution.verdict).toBe("in-scope");
    expect(resolution.coveredPaths).toEqual([]);
    expect(resolution.noRuntimeImpact).toBe(false);
  });

  it("keeps contract references outside changed files while still granting full coverage from evidence", () => {
    const review = parseBehaviorScopeReview(
      validReview({
        evidence: [validObservation({ file: "src/policy.ts", before: "old", after: "new" })],
        contractRefs: ["docs/contracts/stable.md"],
      }),
    );
    const resolution = resolveBehaviorScope(review, validContext(), validChangedFiles());
    expect(resolution.verdict).toBe("in-scope");
    expect(resolution.coveredPaths).toEqual(["src/policy.ts"]);
    expect(resolution.noRuntimeImpact).toBe(true);
  });
});
