import { describe, expect, it } from "vitest";

import {
  parseProviderBehaviorReview,
  parseProviderReviewContext,
  resolveProviderBehavior,
  type ProviderBehaviorReview,
  type ProviderReviewContext,
} from "../scripts/provider-behavior-review.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const DIGEST = "c".repeat(64);
const HEAD2 = "d".repeat(40);

function context(overrides: Partial<ProviderReviewContext> = {}): ProviderReviewContext {
  return {
    headSha: HEAD,
    baseSha: BASE,
    diffDigest: DIGEST,
    diffComplete: true,
    ...overrides,
  };
}

function assessment(overrides: Partial<ProviderBehaviorReview> = {}): ProviderBehaviorReview {
  return {
    headSha: HEAD,
    baseSha: BASE,
    diffDigest: DIGEST,
    verdict: "unaffected",
    rationale: "Only comment text changed; no provider call, routing or effective config touched.",
    evidence: [
      { file: "packages/ai/src/router.ts", line: 12, before: "// comment", after: "// comment updated" },
    ],
    missingEvidence: [],
    ...overrides,
  };
}

describe("parseProviderReviewContext", () => {
  it("parses a valid context and normalizes SHAs to lowercase", () => {
    const parsed = parseProviderReviewContext({
      headSha: HEAD.toUpperCase(),
      baseSha: BASE.toUpperCase(),
      diffDigest: DIGEST.toUpperCase(),
      diffComplete: true,
    });
    expect(parsed).toEqual({ headSha: HEAD, baseSha: BASE, diffDigest: DIGEST, diffComplete: true });
  });

  it("rejects malformed identity strings including appended line breaks", () => {
    for (const suffix of ["\n", "\r", " ", " "]) {
      expect(() =>
        parseProviderReviewContext({ headSha: `${HEAD}${suffix}`, baseSha: BASE, diffDigest: DIGEST, diffComplete: true }),
      ).toThrow(/headSha/);
      expect(() =>
        parseProviderReviewContext({ headSha: HEAD, baseSha: `${BASE}${suffix}`, diffDigest: DIGEST, diffComplete: true }),
      ).toThrow(/baseSha/);
      expect(() =>
        parseProviderReviewContext({ headSha: HEAD, baseSha: BASE, diffDigest: `${DIGEST}${suffix}`, diffComplete: true }),
      ).toThrow(/diffDigest/);
    }
  });

  it("rejects malformed SHAs and digest", () => {
    expect(() =>
      parseProviderReviewContext({ headSha: "short", baseSha: BASE, diffDigest: DIGEST, diffComplete: true }),
    ).toThrow(/headSha/);
    expect(() =>
      parseProviderReviewContext({ headSha: HEAD, baseSha: "zz".concat("0".repeat(38)), diffDigest: DIGEST, diffComplete: true }),
    ).toThrow(/baseSha/);
    expect(() =>
      parseProviderReviewContext({ headSha: HEAD, baseSha: BASE, diffDigest: "short", diffComplete: true }),
    ).toThrow(/diffDigest/);
    expect(() =>
      parseProviderReviewContext({ headSha: HEAD, baseSha: BASE, diffDigest: DIGEST, diffComplete: "yes" }),
    ).toThrow(/diffComplete/);
    expect(() => parseProviderReviewContext(null)).toThrow(/object/);
  });
});

describe("parseProviderBehaviorReview", () => {
  it("parses valid affected, unaffected and unknown reviews", () => {
    const affected = parseProviderBehaviorReview(
      assessment({ verdict: "affected", rationale: "Routing now calls a different provider model." }),
    );
    expect(affected.verdict).toBe("affected");

    const unaffected = parseProviderBehaviorReview(assessment());
    expect(unaffected.verdict).toBe("unaffected");

    const unknown = parseProviderBehaviorReview(
      assessment({ verdict: "unknown", evidence: [], missingEvidence: ["complete-diff"] }),
    );
    expect(unknown.verdict).toBe("unknown");
    expect(unknown.missingEvidence).toEqual(["complete-diff"]);
  });

  it("allows a deletion observation with a null side", () => {
    const parsed = parseProviderBehaviorReview(
      assessment({
        verdict: "affected",
        evidence: [{ file: "packages/ai/src/caller.ts", line: 3, before: "callProvider()", after: null }],
      }),
    );
    expect(parsed.evidence).toHaveLength(1);
  });

  it("rejects non-text control bytes in rationale but preserves legitimate multiline text", () => {
    expect(() =>
      parseProviderBehaviorReview(assessment({ rationale: "bad\0rationale" })),
    ).toThrow(/rationale/);
    expect(() =>
      parseProviderBehaviorReview(assessment({ rationale: "bad\u001brationale" })),
    ).toThrow(/rationale/);
    const multiline = parseProviderBehaviorReview(
      assessment({ rationale: "first line\nsecond line" }),
    );
    expect(multiline.rationale).toBe("first line\nsecond line");
  });

  it("requires concrete single-line missingEvidence entries", () => {
    expect(() =>
      parseProviderBehaviorReview(
        assessment({ verdict: "unknown", evidence: [], missingEvidence: ["\0"] }),
      ),
    ).toThrow(/missingEvidence/);
    expect(() =>
      parseProviderBehaviorReview(
        assessment({ verdict: "unknown", evidence: [], missingEvidence: ["line one\nline two"] }),
      ),
    ).toThrow(/missingEvidence/);
    expect(() =>
      parseProviderBehaviorReview(
        assessment({ verdict: "unknown", evidence: [], missingEvidence: ["   "] }),
      ),
    ).toThrow(/missingEvidence/);
  });

  it("rejects whitespace-only observation files", () => {
    expect(() =>
      parseProviderBehaviorReview(assessment({ evidence: [{ file: "   ", line: 1, before: "x", after: "y" }] })),
    ).toThrow(/file/);
  });

  it("rejects malformed shapes, lengths and SHAs", () => {
    expect(() => parseProviderBehaviorReview(null)).toThrow();
    expect(() => parseProviderBehaviorReview(assessment({ headSha: "bad" }))).toThrow(/headSha/);
    expect(() => parseProviderBehaviorReview(assessment({ rationale: "" }))).toThrow(/rationale/);
    expect(() => parseProviderBehaviorReview(assessment({ rationale: "x".repeat(2001) }))).toThrow(/rationale/);
    expect(() => parseProviderBehaviorReview(assessment({ verdict: "nope" as unknown as ProviderBehaviorReview["verdict"] }))).toThrow(/verdict/);
    expect(() =>
      parseProviderBehaviorReview(assessment({ evidence: Array.from({ length: 33 }, () => ({ file: "a.ts", line: 1, before: "x", after: "y" })) })),
    ).toThrow(/evidence/);
    expect(() =>
      parseProviderBehaviorReview(assessment({ missingEvidence: Array.from({ length: 33 }, () => "m") })),
    ).toThrow(/missingEvidence/);
  });

  it("rejects bad observation files, lines and empty sides", () => {
    expect(() =>
      parseProviderBehaviorReview(assessment({ evidence: [{ file: "/abs/path.ts", line: 1, before: "x", after: "y" }] })),
    ).toThrow(/absolute/);
    expect(() =>
      parseProviderBehaviorReview(assessment({ evidence: [{ file: "../escape.ts", line: 1, before: "x", after: "y" }] })),
    ).toThrow(/traversal/);
    expect(() =>
      parseProviderBehaviorReview(assessment({ evidence: [{ file: "a\u0000.ts", line: 1, before: "x", after: "y" }] })),
    ).toThrow(/control/);
    expect(() =>
      parseProviderBehaviorReview(assessment({ evidence: [{ file: "a.ts", line: 0, before: "x", after: "y" }] })),
    ).toThrow(/line/);
    expect(() =>
      parseProviderBehaviorReview(assessment({ evidence: [{ file: "a.ts", line: 1, before: null, after: null }] })),
    ).toThrow(/before or after/);
    expect(() =>
      parseProviderBehaviorReview(assessment({ evidence: [{ file: "a.ts", line: 1, before: "", after: "" }] })),
    ).toThrow(/before or after/);
  });

  it("enforces verdict binding rules", () => {
    expect(() => parseProviderBehaviorReview(assessment({ verdict: "affected", evidence: [] }))).toThrow(/observation/);
    expect(() => parseProviderBehaviorReview(assessment({ verdict: "unaffected", missingEvidence: ["x"] }))).toThrow(/missing evidence/);
    expect(() => parseProviderBehaviorReview(assessment({ verdict: "unknown", evidence: [], missingEvidence: [] }))).toThrow(/missing evidence/);
  });

  it("round-trips through JSON serialization", () => {
    const original = assessment({ verdict: "affected" });
    const roundTripped = parseProviderBehaviorReview(JSON.parse(JSON.stringify(original)) as unknown);
    expect(roundTripped).toEqual(original);
    const ctx = context();
    expect(parseProviderReviewContext(JSON.parse(JSON.stringify(ctx)) as unknown)).toEqual(ctx);
  });
});

describe("resolveProviderBehavior", () => {
  it("returns unknown when context or assessment is missing", () => {
    expect(resolveProviderBehavior(undefined).verdict).toBe("unknown");
    expect(resolveProviderBehavior({}).verdict).toBe("unknown");
    expect(resolveProviderBehavior({ context: context() }).verdict).toBe("unknown");
    expect(resolveProviderBehavior({ context: context() }).missingEvidence).toContain("provider-behavior-assessment");
    expect(resolveProviderBehavior({ assessment: assessment() }).verdict).toBe("unknown");
  });

  it("returns unknown with complete-diff when the diff is incomplete", () => {
    const resolved = resolveProviderBehavior({
      context: context({ diffComplete: false }),
      assessment: assessment({ verdict: "unaffected" }),
    });
    expect(resolved.verdict).toBe("unknown");
    expect(resolved.missingEvidence).toContain("complete-diff");
  });

  it("returns unknown with stale identity names when head, base or digest mismatch", () => {
    const staleHead = resolveProviderBehavior({
      context: context(),
      assessment: assessment({ headSha: HEAD2 }),
    });
    expect(staleHead.verdict).toBe("unknown");
    expect(staleHead.missingEvidence).toContain("matching-head-sha");

    const staleBase = resolveProviderBehavior({
      context: context(),
      assessment: assessment({ baseSha: HEAD2 }),
    });
    expect(staleBase.missingEvidence).toContain("matching-base-sha");

    const staleDigest = resolveProviderBehavior({
      context: context(),
      assessment: assessment({ diffDigest: "d".repeat(64) }),
    });
    expect(staleDigest.missingEvidence).toContain("matching-diff-digest");
  });

  it("preserves the unknown explanation and missing evidence", () => {
    const resolved = resolveProviderBehavior({
      context: context(),
      assessment: assessment({ verdict: "unknown", evidence: [], missingEvidence: ["full-file-list"] }),
    });
    expect(resolved.verdict).toBe("unknown");
    expect(resolved.reason).toContain("Only comment");
    expect(resolved.missingEvidence).toEqual(["full-file-list"]);
  });

  it("resolves bound affected and unaffected assessments", () => {
    const affected = resolveProviderBehavior({
      context: context(),
      assessment: assessment({ verdict: "affected", rationale: "Caller now routes to provider." }),
    });
    expect(affected).toEqual({ verdict: "affected", reason: "Caller now routes to provider.", missingEvidence: [] });

    const unaffected = resolveProviderBehavior({
      context: context(),
      assessment: assessment(),
    });
    expect(unaffected.verdict).toBe("unaffected");
    expect(unaffected.missingEvidence).toEqual([]);
  });
});
